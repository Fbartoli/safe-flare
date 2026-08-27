import Link from "next/link";

import { Example } from "./flare";

export default function Page() {
  return (
    <main style={{ position: "relative", height: "100vh" }}>
      <Example />
      <nav
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          display: "flex",
          gap: 16,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
        }}
      >
        <Link href="/blocks" style={{ color: "#8a92b2", textDecoration: "none" }}>
          eth blocks →
        </Link>
        <Link href="/strange" style={{ color: "#8a92b2", textDecoration: "none" }}>
          strange →
        </Link>
      </nav>
    </main>
  );
}
