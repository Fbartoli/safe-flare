# Safe Flare

The [Safe](https://safefoundation.org/) symbol rendered as a rim-lit WebGPU flare.
This project adapts the [vgpu](https://vgpu.sh/) [`nextjs-flare`](https://vgpu.sh/examples/nextjs-flare) example to the Safe brand.

The renderer draws the Safe symbol as line art and lights it with a multi-pass pipeline:

1. Rasterize the logo SVG into a mask texture.
2. Extract the rim and blur it with a separable Gaussian chain.
3. Composite a 48-step volumetric ray walk, jittered with blue noise.

The light breathes on its own. Move the pointer to take control of it.

## /blocks — Ethereum, live

`/blocks` renders Ethereum as a machine. Transaction particles stream into a
line-art ETH glyph, and one isometric cube slides out on a conveyor for every
real mainnet block. The page subscribes to `newHeads` over WebSocket
(publicnode RPC, HTTP polling fallback), so each cube lands at the real block
time. Block number, transaction count, gas use, and base fee come from the
chain; transaction count drives the particle inflow and gas use drives the
glyph glow. Plain JSON-RPC — no client library.

## Stack

- [Next.js 16](https://nextjs.org/) (App Router, Turbopack)
- [vgpu](https://www.npmjs.com/package/vgpu) with the `@vgpu/wgsl` loader for `.wgsl` imports
- WebGPU (a browser with WebGPU support is required)

## Run

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000/.

`pnpm smoke` renders one headless frame with `vgpu/node` and asserts on the pixels.
Run `npx vgpu doctor` if it fails.

## Layout

- `app/flare/` — renderer, pipeline, and WGSL shaders
- `app/flare/logo-raster.ts` — the Safe symbol as stroked SVG line art
- `assets/Safe_Logos_Symbol_White.svg` — original symbol from the Safe Media Kit

## Credits

- Shader pipeline: the `nextjs-flare` example from [vercel-labs/vgpu](https://github.com/vercel-labs/vgpu) (MIT).
- Safe symbol: the [Safe Media Kit](https://safefoundation.notion.site/Safe-Media-Kit-28ba8a34f3b8818fbf9ad291eeda0a4f). The Safe brand belongs to the Safe Foundation.
