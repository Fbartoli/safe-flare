"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { createStrangeRenderer, type AttractorParams } from "./renderer";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export default function StrangePage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coeffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    document.title = "strange · clifford attractor";

    const renderer = createStrangeRenderer({ canvas });
    void renderer.ready;
    renderer.onParams((params: AttractorParams) => {
      if (!coeffRef.current) return;
      const f = (value: number) => value.toFixed(2).padStart(5);
      coeffRef.current.textContent =
        `a ${f(params.a)} · b ${f(params.b)} · c ${f(params.c)} · d ${f(params.d)}`;
    });

    const handleClick = () => renderer.scatter();
    canvas.addEventListener("click", handleClick);
    return () => {
      canvas.removeEventListener("click", handleClick);
      renderer.dispose();
    };
  }, []);

  return (
    <main
      style={{
        position: "relative",
        height: "100vh",
        overflow: "hidden",
        background: "#000",
        cursor: "crosshair",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", height: "100%", width: "100%" }}
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
          STRANGE · CLIFFORD ATTRACTOR
        </div>
        <div ref={coeffRef}>settling…</div>
        <div style={{ color: "#5a6180" }}>move to bend the map · click to scatter</div>
      </header>
      <nav
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
        <Link href="/blocks" style={{ color: "#8a92b2", textDecoration: "none" }}>
          eth blocks
        </Link>
        <Link href="/" style={{ color: "#8a92b2", textDecoration: "none" }}>
          ← safe flare
        </Link>
      </nav>
    </main>
  );
}
