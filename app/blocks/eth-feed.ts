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
  /** EIP-4844 blob count carried by this block. */
  blobs: number;
}

export type FeedStatus = "connecting" | "live" | "polling" | "error";

const HTTP_RPC = "https://ethereum-rpc.publicnode.com";
const WS_RPC = "wss://ethereum-rpc.publicnode.com";
const POLL_MS = 4000;
const WS_GUARD_MS = 8000;
const BEACON_API = "https://ethereum-beacon-api.publicnode.com";

/** Beacon chain genesis timestamp; slots tick every 12 s from here. */
export const BEACON_GENESIS = 1606824023;
export const SLOT_SECONDS = 12;
export const SLOTS_PER_EPOCH = 32;

interface RawHeader {
  number: string;
  hash: string;
  gasUsed: string;
  gasLimit: string;
  baseFeePerGas?: string;
  blobGasUsed?: string;
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

const BLOB_GAS_SIZE = 131072; // 2^17 gas per blob

function toEvent(header: RawHeader, txCount: number): BlockEvent {
  return {
    number: hex(header.number),
    hash: header.hash,
    txCount,
    gasUsed: hex(header.gasUsed),
    gasLimit: hex(header.gasLimit),
    baseFeeGwei: hex(header.baseFeePerGas) / 1e9,
    timestamp: hex(header.timestamp),
    blobs: Math.round(hex(header.blobGasUsed) / BLOB_GAS_SIZE),
  };
}

const SAMPLE_GAP_MS = 1500;
const SYNTH_MIN_RATE = 5; // synthetic arrivals per second floor while polling
const FINALITY_POLL_MS = 30000;
const PENDING_SILENCE_MS = 6000;
const DEFAULT_WHALE_ETH = 50;

export function createBlockFeed(
  handlers: {
    onBlock(block: BlockEvent): void;
    onStatus(status: FeedStatus): void;
    /** One call per pending transaction; weight in [1, 2.4] scales by ETH value. */
    onPendingTx(weight: number): void;
    /** A sampled pending transaction moved at least the whale threshold. */
    onWhale?(valueEth: number): void;
    /** Latest finalized block number, polled every 30 s. */
    onFinalized?(blockNumber: number): void;
    /** Proposer validator index, resolved from the beacon chain per block. */
    onProposer?(blockNumber: number, validatorIndex: number): void;
    /** A near-head block was replaced by a competing hash. */
    onReorg?(block: BlockEvent): void;
    /** Base fees (gwei, oldest first) seeding the sparkline at startup. */
    onFeeHistory?(baseFeesGwei: number[]): void;
  },
  opts?: { whaleThreshold?: number }
): () => void {
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
  let lastRealPendingAt = 0;
  const whaleThreshold = opts?.whaleThreshold ?? DEFAULT_WHALE_ETH;
  const hashByNumber = new Map<number, string>();

  // Beacon slot = execution timestamp offset from beacon genesis; the headers
  // endpoint is the light way to the proposer index.
  const fetchProposer = (event: BlockEvent) => {
    if (!handlers.onProposer) return;
    const slot = Math.round((event.timestamp - BEACON_GENESIS) / SLOT_SECONDS);
    void (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 1500);
          await promise;
        }
        try {
          const response = await fetch(`${BEACON_API}/eth/v1/beacon/headers/${slot}`);
          if (!response.ok) continue;
          const payload = (await response.json()) as {
            data?: { header?: { message?: { proposer_index?: string } } };
          };
          const index = Number(payload.data?.header?.message?.proposer_index);
          if (Number.isFinite(index) && !disposed) {
            handlers.onProposer?.(event.number, index);
            return;
          }
        } catch {
          // retry once, then give up quietly
        }
      }
    })();
  };

  const emit = (event: BlockEvent) => {
    if (disposed) return;
    const known = hashByNumber.get(event.number);
    if (event.number <= lastNumber) {
      // Same height, different hash, near the head: a reorg replaced it.
      if (known && known !== event.hash && lastNumber - event.number < 6) {
        hashByNumber.set(event.number, event.hash);
        handlers.onReorg?.(event);
        fetchProposer(event);
      }
      return;
    }
    lastNumber = event.number;
    lastTxCount = Math.max(1, event.txCount);
    hashByNumber.set(event.number, event.hash);
    hashByNumber.delete(event.number - 32);
    handlers.onBlock(event);
    fetchProposer(event);
  };

  // Most arrivals spawn immediately at weight 1; at most one value lookup is
  // in flight, so heavy mempool traffic never floods the RPC.
  const emitPending = (hash: string) => {
    if (disposed) return;
    const nowMs = Date.now();
    lastRealPendingAt = nowMs;
    if (synthTimer !== undefined && wsLive) stopSynth();
    if (nowMs - lastSampleAt < SAMPLE_GAP_MS) {
      handlers.onPendingTx(1);
      return;
    }
    lastSampleAt = nowMs;
    rpc<{ value?: string }>("eth_getTransactionByHash", [hash])
      .then((tx) => {
        const eth = hex(tx?.value) / 1e18;
        if (eth >= whaleThreshold) handlers.onWhale?.(eth);
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
      // The HTTP node can lag the WS head by a moment; a zero count right
      // after newHeads is almost always that race, not an empty block.
      void (async () => {
        let count = 0;
        for (let attempt = 0; attempt < 2 && count === 0; attempt++) {
          if (attempt > 0) {
            const { promise, resolve } = Promise.withResolvers<void>();
            setTimeout(resolve, 1200);
            await promise;
          }
          count = hex(
            await rpc<string>("eth_getBlockTransactionCountByHash", [
              header.hash,
            ]).catch(() => undefined)
          );
        }
        emit(toEvent(header, count));
      })();
    };
    ws.onclose = () => {
      wsLive = false;
      if (!disposed) startPolling();
    };
    ws.onerror = () => ws?.close();
  };

  // Finalized head, and a watchdog for WS endpoints that accept the
  // newPendingTransactions subscription but never deliver.
  const pollFinalized = () => {
    rpc<RawHeader>("eth_getBlockByNumber", ["finalized", false])
      .then((header) => {
        if (!disposed) handlers.onFinalized?.(hex(header.number));
      })
      .catch(() => undefined);
  };
  const finalityTimer = window.setInterval(pollFinalized, FINALITY_POLL_MS);
  const silenceTimer = window.setInterval(() => {
    if (wsLive && Date.now() - lastRealPendingAt > PENDING_SILENCE_MS) {
      startSynth();
    }
  }, PENDING_SILENCE_MS / 2);

  handlers.onStatus("connecting");
  pollLatest().catch(() => undefined); // seed the UI before the first new head
  pollFinalized();
  rpc<{ baseFeePerGas?: string[] }>("eth_feeHistory", ["0x33", "latest", []])
    .then((history) => {
      const fees = (history.baseFeePerGas ?? []).map((fee) => hex(fee) / 1e9);
      if (!disposed && fees.length > 0) handlers.onFeeHistory?.(fees);
    })
    .catch(() => undefined);
  startWs();

  return () => {
    disposed = true;
    clearTimeout(guardTimer);
    clearInterval(pollTimer);
    clearInterval(finalityTimer);
    clearInterval(silenceTimer);
    stopSynth();
    ws?.close();
  };
}
