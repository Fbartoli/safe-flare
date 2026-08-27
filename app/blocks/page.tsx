"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { createBlockFeed, type BlockEvent, type FeedStatus } from "./eth-feed";
import {
  createBlocksRenderer,
  type LayoutFrame,
  type MempoolStats,
} from "./renderer";
import { createSoundBoard } from "./sound";

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

export default function BlocksPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [latest, setLatest] = useState<BlockEvent | undefined>();
  const [finalized, setFinalized] = useState<number | undefined>();
  const [soundOn, setSoundOn] = useState(false);
  const soundRef = useRef<ReturnType<typeof createSoundBoard> | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelHost = labelHostRef.current;
    if (!canvas || !labelHost) return;

    // Playground hooks: ?whale=0.5 lowers the whale threshold,
    // ?ghost=5 shortens the missed-slot timer.
    const query = new URLSearchParams(window.location.search);
    const whaleThreshold = Number(query.get("whale")) || undefined;
    const ghostAfter = Number(query.get("ghost")) || undefined;

    const sound = createSoundBoard();
    soundRef.current = sound;
    const renderer = createBlocksRenderer({ canvas, ghostAfter });
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
            anchor.innerHTML =
              `<div style="color:#c7d0f0">#${label.number}</div>` +
              `<div>${label.txCount} txs</div>`;
            node = anchor;
          } else {
            node = document.createElement("div");
            node.style.cssText = LABEL_STYLE + `color:#5a6180;pointer-events:none;`;
            node.innerHTML = `<div>slot missed</div>`;
          }
          labelHost.appendChild(node);
          blockPool.set(key, node);
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

    const stopFeed = createBlockFeed(
      {
        onBlock(block) {
          renderer.pushBlock(block);
          setLatest(block);
          sound.thump(Math.min(1, block.txCount / 400));
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
      },
      { whaleThreshold }
    );

    return () => {
      stopFeed();
      renderer.dispose();
      sound.dispose();
      for (const node of blockPool.values()) node.remove();
    };
  }, []);

  const gasPercent = latest && latest.gasLimit > 0
    ? Math.round((latest.gasUsed / latest.gasLimit) * 100)
    : undefined;

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
          {finalized && latest
            ? `finalized #${finalized} (−${latest.number - finalized})`
            : "finality pending…"}
        </div>
      </header>
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
        <Link href="/" style={{ color: "#8a92b2", textDecoration: "none" }}>
          ← safe flare
        </Link>
      </div>
    </main>
  );
}
