"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { createBlockFeed, type BlockEvent, type FeedStatus } from "./eth-feed";
import { createBlocksRenderer, type BlockLabel } from "./renderer";

const MONO =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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

export default function BlocksPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<FeedStatus>("connecting");
  const [latest, setLatest] = useState<BlockEvent | undefined>();

  useEffect(() => {
    const canvas = canvasRef.current;
    const labelHost = labelHostRef.current;
    if (!canvas || !labelHost) return;

    const renderer = createBlocksRenderer({ canvas });
    void renderer.ready;

    const labelPool = new Map<number, HTMLDivElement>();
    renderer.onLayout((labels: BlockLabel[]) => {
      const seen = new Set<number>();
      for (const label of labels) {
        seen.add(label.number);
        let node = labelPool.get(label.number);
        if (!node) {
          node = document.createElement("div");
          node.style.cssText =
            `position:absolute;transform:translate(-50%,-100%);text-align:center;` +
            `font-family:${MONO};font-size:11px;line-height:1.5;color:#8a92b2;` +
            `pointer-events:none;white-space:nowrap;`;
          node.innerHTML =
            `<div style="color:#c7d0f0">#${label.number}</div>` +
            `<div>${label.txCount} txs</div>`;
          labelHost.appendChild(node);
          labelPool.set(label.number, node);
        }
        node.style.left = `${label.u * 100}%`;
        node.style.top = `${label.v * 100}%`;
        node.style.opacity = String(label.opacity);
      }
      for (const [number, node] of labelPool) {
        if (!seen.has(number)) {
          node.remove();
          labelPool.delete(number);
        }
      }
    });

    const stopFeed = createBlockFeed({
      onBlock(block) {
        renderer.pushBlock(block);
        setLatest(block);
      },
      onStatus: setStatus,
    });

    return () => {
      stopFeed();
      renderer.dispose();
      for (const node of labelPool.values()) node.remove();
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
      <div ref={labelHostRef} style={{ position: "absolute", inset: 0 }} />
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
            ? `#${latest.number} · ${latest.txCount} txs · gas ${gasPercent}% · base ${latest.baseFeeGwei.toFixed(2)} gwei`
            : "waiting for the chain…"}
        </div>
      </header>
      <Link
        href="/"
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          fontFamily: MONO,
          fontSize: 12,
          color: "#8a92b2",
          textDecoration: "none",
        }}
      >
        ← safe flare
      </Link>
    </main>
  );
}
