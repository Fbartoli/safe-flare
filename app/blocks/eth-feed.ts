// Live Ethereum mainnet block feed over plain JSON-RPC: WebSocket newHeads
// subscription first, HTTP polling fallback. No client library.

export interface BlockEvent {
  number: number;
  hash: string;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  baseFeeGwei: number;
  timestamp: number;
}

export type FeedStatus = "connecting" | "live" | "polling" | "error";

const HTTP_RPC = "https://ethereum-rpc.publicnode.com";
const WS_RPC = "wss://ethereum-rpc.publicnode.com";
const POLL_MS = 4000;
const WS_GUARD_MS = 8000;

interface RawHeader {
  number: string;
  hash: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas?: string;
  timestamp: string;
  transactions?: string[];
}

const hex = (value: string | undefined): number =>
  value ? Number.parseInt(value, 16) : 0;

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(HTTP_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed: ${response.status}`);
  const payload = (await response.json()) as { result?: T; error?: { message: string } };
  if (payload.error) throw new Error(`RPC ${method} failed: ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`RPC ${method} returned no result.`);
  return payload.result;
}

function toEvent(header: RawHeader, txCount: number): BlockEvent {
  return {
    number: hex(header.number),
    hash: header.hash,
    txCount,
    gasUsed: hex(header.gasUsed),
    gasLimit: hex(header.gasLimit),
    baseFeeGwei: hex(header.baseFeePerGas) / 1e9,
    timestamp: hex(header.timestamp),
  };
}

const SAMPLE_GAP_MS = 1500;
const SYNTH_MIN_RATE = 5; // synthetic arrivals per second floor while polling

export function createBlockFeed(handlers: {
  onBlock(block: BlockEvent): void;
  onStatus(status: FeedStatus): void;
  /** One call per pending transaction; weight in [1, 2.4] scales by ETH value. */
  onPendingTx(weight: number): void;
}): () => void {
  let disposed = false;
  let ws: WebSocket | undefined;
  let wsLive = false;
  let pollTimer: number | undefined;
  let guardTimer: number | undefined;
  let synthTimer: number | undefined;
  let lastNumber = 0;
  let lastTxCount = 150;
  let headsSubId = "";
  let pendingSubId = "";
  let lastSampleAt = 0;

  const emit = (event: BlockEvent) => {
    if (disposed || event.number <= lastNumber) return;
    lastNumber = event.number;
    lastTxCount = Math.max(1, event.txCount);
    handlers.onBlock(event);
  };

  // Most arrivals spawn immediately at weight 1; at most one value lookup is
  // in flight, so heavy mempool traffic never floods the RPC.
  const emitPending = (hash: string) => {
    if (disposed) return;
    const nowMs = Date.now();
    if (nowMs - lastSampleAt < SAMPLE_GAP_MS) {
      handlers.onPendingTx(1);
      return;
    }
    lastSampleAt = nowMs;
    rpc<{ value?: string }>("eth_getTransactionByHash", [hash])
      .then((tx) => {
        const eth = hex(tx?.value) / 1e18;
        handlers.onPendingTx(1 + Math.min(1.4, Math.log10(1 + eth) * 1.2));
      })
      .catch(() => handlers.onPendingTx(1));
  };

  // Polling has no mempool stream, so synthesize arrivals at the pace of the
  // last block. ponytail: fake cadence, real volume; WS is the honest path.
  const startSynth = () => {
    if (disposed || synthTimer !== undefined) return;
    const perSecond = Math.max(SYNTH_MIN_RATE, lastTxCount / 12);
    synthTimer = window.setInterval(
      () => handlers.onPendingTx(1),
      1000 / perSecond
    );
  };

  const stopSynth = () => {
    clearInterval(synthTimer);
    synthTimer = undefined;
  };

  const pollLatest = async () => {
    const header = await rpc<RawHeader>("eth_getBlockByNumber", ["latest", false]);
    emit(toEvent(header, header.transactions?.length ?? 0));
  };

  const startPolling = () => {
    if (disposed || pollTimer !== undefined) return;
    handlers.onStatus("polling");
    const tick = () => {
      pollLatest()
        .then(() => !disposed && handlers.onStatus("polling"))
        .catch(() => !disposed && handlers.onStatus("error"));
    };
    tick();
    pollTimer = window.setInterval(tick, POLL_MS);
    startSynth();
  };

  const startWs = () => {
    try {
      ws = new WebSocket(WS_RPC);
    } catch {
      startPolling();
      return;
    }
    guardTimer = window.setTimeout(() => {
      if (!wsLive) ws?.close();
    }, WS_GUARD_MS);
    ws.onopen = () => {
      const subscribe = (id: number, topic: string) =>
        ws?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "eth_subscribe",
            params: [topic],
          })
        );
      subscribe(1, "newHeads");
      subscribe(2, "newPendingTransactions");
    };
    ws.onmessage = (message: MessageEvent<string>) => {
      const payload = JSON.parse(message.data) as {
        id?: number;
        method?: string;
        result?: string;
        params?: { subscription: string; result: RawHeader | string };
      };
      if (payload.id === 1 && payload.result) {
        headsSubId = payload.result;
        wsLive = true;
        stopSynth();
        if (!disposed) handlers.onStatus("live");
        return;
      }
      if (payload.id === 2 && payload.result) {
        pendingSubId = payload.result;
        return;
      }
      if (payload.method !== "eth_subscription" || !payload.params) return;
      if (payload.params.subscription === pendingSubId) {
        emitPending(payload.params.result as string);
        return;
      }
      if (payload.params.subscription !== headsSubId) return;
      const header = payload.params.result as RawHeader;
      rpc<string>("eth_getBlockTransactionCountByHash", [header.hash])
        .then((count) => emit(toEvent(header, hex(count))))
        .catch(() => emit(toEvent(header, 0)));
    };
    ws.onclose = () => {
      wsLive = false;
      if (!disposed) startPolling();
    };
    ws.onerror = () => ws?.close();
  };

  handlers.onStatus("connecting");
  pollLatest().catch(() => undefined); // seed the UI before the first new head
  startWs();

  return () => {
    disposed = true;
    clearTimeout(guardTimer);
    clearInterval(pollTimer);
    stopSynth();
    ws?.close();
  };
}
