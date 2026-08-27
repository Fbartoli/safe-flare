import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Safe Flare",
  description:
    "Safe logo shader — a rim-lit symbol with volumetric scattering, rendered with vgpu.",
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
