import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  metadataBase: new URL("https://safe-flare.vercel.app"),
  title: "Safe Flare",
  description:
    "Safe logo shader and a live Ethereum block machine, rendered with vgpu.",
  openGraph: {
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, height: "100vh", background: "#000" }}>
        {children}
      </body>
    </html>
  );
}
