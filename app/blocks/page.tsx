"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  BEACON_GENESIS,
  SLOT_SECONDS,
  SLOTS_PER_EPOCH,
  createBlockFeed,
  type BlockEvent,
  type FeedStatus,
} from "./eth-feed";
import {
  createBlocksRenderer,
  type BlockLabel,
  type LayoutFrame,
  type MempoolStats,
} from "./renderer";
import { createSoundBoard, type SoundBoard } from "./sound";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const EXPLORER = "https://etherscan.io";

const STATUS_TEXT: Record<FeedStatus, string> = {
  connecting: "connecting",
  live: "live · newHeads",
  polling: "live · polling",
  error: "rpc error · retrying",
};

const STATUS_COLOR: Record<FeedStatus, string> = {
  connecting: "#8a92b2",
  live: "#37d67a",
  polling: "#c9b458",
  error: "#e05c5c",
};

const LABEL_STYLE =
  `position:absolute;transform:translate(-50%,-100%);text-align:center;` +
  `font-family:${MONO};font-size:11px;line-height:1.5;white-space:nowrap;`;

interface SlotClock {
  slot: number;
  epoch: number;
  inEpoch: number;
}

function slotClock(): SlotClock {
  const slot = Math.floor((Date.now() / 1000 - BEACON_GENESIS) / SLOT_SECONDS);
  return {
    slot,
    epoch: Math.floor(slot / SLOTS_PER_EPOCH),
    inEpoch: slot % SLOTS_PER_EPOCH,
  };
}

function blockLabelHtml(label: BlockLabel): { compact: string; full: string } {
  const compact =
    `<div style="color:#c7d0f0">#${label.number}</div>` +
    `<div>${label.txCount} txs</div>` +
    (label.proposer !== undefined
      ? `<div style="color:#5a6180">val ${label.proposer}</div>`
      : "");
  const detail =
    (label.gasPercent !== undefined ? `<div>gas ${label.gasPercent}%</div>` : "") +
    (label.baseFeeGwei !== undefined
      ? `<div>base ${label.baseFeeGwei.toFixed(2)} gwei</div>`
      : "") +
    (label.blobs ? `<div>${label.blobs} blobs</div>` : "") +
    (label.hash
      ? `<div style="color:#5a6180">${label.hash.slice(0, 10)}…${label.hash.slice(-4)}</div>`
      : "");
  return { compact, full: compact + detail };
}

// Hovering a block label expands it with the full block detail.
function attachHoverDetail(node: HTMLElement) {
  node.addEventListener("pointerenter", () => {
    node.dataset.hover = "1";
    if (node.dataset.full) node.innerHTML = node.dataset.full;
    node.style.background = "rgba(8,10,20,0.92)";
    node.style.padding = "5px 8px";
    node.style.border = "1px solid #2a3152";
    node.style.borderRadius = "4px";
  });
  node.addEventListener("pointerleave", () => {
    delete node.dataset.hover;
    if (node.dataset.compact) node.innerHTML = node.dataset.compact;
    node.style.background = "none";
    node.style.padding = "0";
    node.style.border = "none";
  });
}

// A 32 px isometric cube in a hash-derived hue; the tab reports each block.
function updateFavicon(hash: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#05060c";
  ctx.fillRect(0, 0, 32, 32);
  ctx.strokeStyle = `hsl(${parseInt(hash.slice(2, 8), 16) % 360} 85% 70%)`;
  ctx.lineWidth = 2;
  const points: Array<[number, number]> = [];
  for (let k = 0; k < 6; k++) {
    const angle = (Math.PI / 180) * (90 + 60 * k);
    points.push([16 + 11 * Math.cos(angle), 16 - 11 * Math.sin(angle)]);
  }
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  for (const k of [1, 3, 5]) {
    ctx.moveTo(16, 16);
    ctx.lineTo(points[k][0], points[k][1]);
  }
  ctx.stroke();
  let icon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!icon) {
    icon = document.createElement("link");
    icon.rel = "icon";
    document.head.appendChild(icon);
  }
  icon.href = canvas.toDataURL("image/png");
}

export default function BlocksPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [latest, setLatest] = useState<BlockEvent | undefined>();
  const [finalized, setFinalized] = useState<number | undefined>();
  const [soundOn, setSoundOn] = useState(false);
  const [slotNow, setSlotNow] = useState<SlotClock | undefined>();
  const [embed, setEmbed] = useState(false);
  const [hudOn, setHudOn] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const perfRef = useRef<HTMLDivElement>(null);
  const soundRef = useRef<SoundBoard | undefined>(undefined);

  useEffect(() => {
    setSlotNow(slotClock());
    const timer = window.setInterval(() => setSlotNow(slotClock()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelHost = labelHostRef.current;
    if (!canvas || !labelHost) return;

    // Playground hooks: ?whale=0.5 lowers the whale threshold, ?ghost=5
    // shortens the missed-slot timer, ?embed=1 strips the chrome for
    // iframes, ?hud=1 shows per-pass GPU milliseconds.
    const query = new URLSearchParams(window.location.search);
    const whaleThreshold = Number(query.get("whale")) || undefined;
    const ghostAfter = Number(query.get("ghost")) || undefined;
    const hudMode = query.get("hud") === "1";
    setEmbed(query.get("embed") === "1");
    setHudOn(hudMode);

    const sound = createSoundBoard();
    soundRef.current = sound;
    const renderer = createBlocksRenderer({ canvas, ghostAfter, hud: hudMode });
    void renderer.ready;

    const blockPool = new Map<string, HTMLElement>();
    renderer.onLayout((layout: LayoutFrame) => {
      const seen = new Set<string>();
      for (const label of layout.blocks) {
        const key = label.kind === "ghost" ? `g${label.number}-${label.u.toFixed(3)}` : `b${label.number}`;
        seen.add(key);
        let node = blockPool.get(key);
        if (!node) {
          if (label.kind === "block") {
            const anchor = document.createElement("a");
            anchor.href = `${EXPLORER}/block/${label.number}`;
            anchor.target = "_blank";
            anchor.rel = "noreferrer";
            anchor.style.cssText =
              LABEL_STYLE + `color:#8a92b2;pointer-events:auto;text-decoration:none;`;
            attachHoverDetail(anchor);
            node = anchor;
          } else {
            node = document.createElement("div");
            node.style.cssText = LABEL_STYLE + `color:#5a6180;pointer-events:none;`;
            node.innerHTML = `<div>slot missed</div>`;
          }
          labelHost.appendChild(node);
          blockPool.set(key, node);
        }
        if (label.kind === "block") {
          // Content arrives in stages (tx count retry, proposer lookup);
          // rewrite only when the signature changes.
          const sig =
            `${label.number}|${label.txCount}|${label.proposer ?? ""}|` +
            `${label.gasPercent ?? ""}`;
          if (node.dataset.sig !== sig) {
            node.dataset.sig = sig;
            const html = blockLabelHtml(label);
            node.dataset.compact = html.compact;
            node.dataset.full = html.full;
            node.innerHTML = node.dataset.hover === "1" ? html.full : html.compact;
          }
        }
        node.style.left = `${label.u * 100}%`;
        node.style.top = `${label.v * 100}%`;
        node.style.opacity = String(label.opacity);
      }
      for (const label of layout.whales) {
        const key = `w${label.id}`;
        seen.add(key);
        let node = blockPool.get(key);
        if (!node) {
          node = document.createElement("div");
          node.style.cssText =
            LABEL_STYLE + `color:#8dffbe;pointer-events:none;font-weight:600;`;
          node.textContent = label.text;
          labelHost.appendChild(node);
          blockPool.set(key, node);
        }
        node.style.left = `${label.u * 100}%`;
        node.style.top = `${label.v * 100}%`;
        node.style.opacity = String(label.opacity);
      }
      for (const [key, node] of blockPool) {
        if (!seen.has(key)) {
          node.remove();
          blockPool.delete(key);
        }
      }
    });

    renderer.onStats((stats: MempoolStats) => {
      if (statsRef.current) {
        statsRef.current.textContent =
          `mempool +${stats.sinceBlock} since block · ~${stats.perSecond.toFixed(1)} tx/s`;
      }
    });

    renderer.onPerf((spans) => {
      if (!perfRef.current) return;
      const parts = Object.entries(spans).map(
        ([name, ms]) => `${name} ${ms.toFixed(2)}`
      );
      perfRef.current.textContent = `gpu ms · ${parts.join(" · ")}`;
    });

    const stopFeed = createBlockFeed(
      {
        onBlock(block) {
          renderer.pushBlock(block);
          setLatest(block);
          sound.thump(Math.min(1, block.txCount / 400));
          document.title = `#${block.number} · eth blocks`;
          updateFavicon(block.hash);
        },
        onStatus: setStatus,
        onPendingTx(weight) {
          renderer.pushPendingTx(weight);
          sound.tick();
        },
        onWhale(valueEth) {
          renderer.pushWhale(valueEth);
        },
        onFinalized(blockNumber) {
          renderer.setFinalized(blockNumber);
          setFinalized(blockNumber);
        },
        onProposer(blockNumber, validatorIndex) {
          renderer.setProposer(blockNumber, validatorIndex);
        },
        onReorg(block) {
          renderer.replaceBlock(block);
        },
        onFeeHistory(baseFeesGwei) {
          renderer.setFeeHistory(baseFeesGwei);
        },
      },
      { whaleThreshold }
    );

    // Easter egg: a click on the glyph summons a swarm.
    const handleCanvasClick = (event: MouseEvent) => {
      const aspect = window.innerWidth / window.innerHeight;
      const dx = (event.clientX / window.innerWidth - 0.5) * aspect;
      const dy = 0.5 - event.clientY / window.innerHeight - 0.1;
      if (dx * dx + dy * dy > 0.07) return;
      renderer.burst();
      sound.thump(1);
    };
    canvas.addEventListener("click", handleCanvasClick);

    return () => {
      canvas.removeEventListener("click", handleCanvasClick);
      stopFeed();
      renderer.dispose();
      sound.dispose();
      for (const node of blockPool.values()) node.remove();
    };
  }, []);

  const gasPercent = latest && latest.gasLimit > 0
    ? Math.round((latest.gasUsed / latest.gasLimit) * 100)
    : undefined;

  const startCapture = () => {
    const canvas = canvasRef.current;
    if (!canvas || capturing) return;
    const stream = canvas.captureStream(60);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 12_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `eth-blocks-${Date.now()}.webm`;
      link.click();
      URL.revokeObjectURL(url);
      for (const track of stream.getTracks()) track.stop();
      setCapturing(false);
    };
    recorder.start();
    setCapturing(true);
    window.setTimeout(() => recorder.stop(), SLOT_SECONDS * 1000);
  };

  return (
    <main
      style={{
        position: "relative",
        height: "100vh",
        overflow: "hidden",
        background: "#000",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", height: "100%", width: "100%" }}
      />
      <div
        ref={labelHostRef}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      />
      {!embed && (
      <header
        style={{
          position: "absolute",
          top: 16,
          left: 20,
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.8,
          color: "#8a92b2",
          pointerEvents: "none",
        }}
      >
        <div style={{ color: "#c7d0f0", letterSpacing: "0.2em" }}>
          ETHEREUM · MAINNET
        </div>
        <div>
          <span style={{ color: STATUS_COLOR[status] }}>●</span>{" "}
          {STATUS_TEXT[status]}
        </div>
        <div>
          {latest
            ? `#${latest.number} · ${latest.txCount} txs · gas ${gasPercent}% · base ${latest.baseFeeGwei.toFixed(2)} gwei` +
              (latest.blobs > 0 ? ` · ${latest.blobs} blobs` : "")
            : "waiting for the chain…"}
        </div>
        <div ref={statsRef}>mempool warming up…</div>
        <div>
          {slotNow
            ? `slot ${slotNow.slot.toLocaleString("en-US")} · epoch ${slotNow.epoch.toLocaleString("en-US")} (${slotNow.inEpoch}/32)`
            : "slot syncing…"}
        </div>
        <div>
          {finalized && latest
            ? `finalized #${finalized} (−${latest.number - finalized})`
            : "finality pending…"}
        </div>
      </header>
      )}
      {!embed && (
      <div
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          display: "flex",
          gap: 16,
          fontFamily: MONO,
          fontSize: 12,
        }}
      >
        <button
          type="button"
          onClick={startCapture}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            fontFamily: MONO,
            fontSize: 12,
            color: capturing ? "#c7d0f0" : "#8a92b2",
            cursor: "pointer",
          }}
        >
          {capturing ? "capturing…" : "capture 12s"}
        </button>
        <button
          type="button"
          onClick={() => setSoundOn(soundRef.current?.toggle() ?? false)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            fontFamily: MONO,
            fontSize: 12,
            color: soundOn ? "#c7d0f0" : "#8a92b2",
            cursor: "pointer",
          }}
        >
          sound: {soundOn ? "on" : "off"}
        </button>
        <Link href="/strange" style={{ color: "#8a92b2", textDecoration: "none" }}>
          strange →
        </Link>
        <Link href="/" style={{ color: "#8a92b2", textDecoration: "none" }}>
          ← safe flare
        </Link>
      </div>
      )}
      {hudOn && (
        <div
          ref={perfRef}
          style={{
            position: "absolute",
            bottom: 12,
            right: 20,
            fontFamily: MONO,
            fontSize: 11,
            color: "#5a6180",
            pointerEvents: "none",
          }}
        />
      )}
    </main>
  );
}
