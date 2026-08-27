import Link from "next/link";

import { Example } from "./flare";

export default function Page() {
  return (
    <main style={{ position: "relative", height: "100vh" }}>
      <Example />
      <Link
        href="/blocks"
        style={{
          position: "absolute",
          top: 16,
          right: 20,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12,
          color: "#8a92b2",
          textDecoration: "none",
        }}
      >
        eth blocks →
      </Link>
    </main>
  );
}
