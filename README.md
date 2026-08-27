# Safe Flare

The [Safe](https://safefoundation.org/) symbol rendered as a rim-lit WebGPU flare.
This project adapts the [vgpu](https://vgpu.sh/) [`nextjs-flare`](https://vgpu.sh/examples/nextjs-flare) example to the Safe brand.

The renderer draws the Safe symbol as line art and lights it with a multi-pass pipeline:

1. Rasterize the logo SVG into a mask texture.
2. Extract the rim and blur it with a separable Gaussian chain.
3. Composite a 48-step volumetric ray walk, jittered with blue noise.

The light breathes on its own. Move the pointer to take control of it.

## /blocks — Ethereum, live

`/blocks` renders Ethereum as a machine. Real pending transactions
(`newPendingTransactions` over WebSocket) swarm around a line-art ETH glyph as
velocity-streaked particles, compress as mempool pressure builds, and get
eaten when the next block lands. The pointer is a gravity well: the swarm
parts around it. Each real block (`newHeads`) slides out as an isometric cube
on a conveyor: a hash-seeded constellation glows inside it — no two blocks
ever share one — blob orbs underneath show its EIP-4844 blobs, labels link to
Etherscan and expand on hover with gas, base fee, blobs, and the hash.
Finalized blocks crystallize; a missed slot leaves a hollow ghost cube.
Sampled transactions above 50 ETH drift in as labeled whale orbs. The frame
resolves through a real bloom chain with blue-noise grain, and the whole scene
parallaxes with the pointer. Optional sound: a tick per transaction, a thump
per block. Plain JSON-RPC — no client library.

The header carries a wall-clock slot/epoch counter; a wide slow ring marks
each 32-slot epoch boundary. Each cube is stamped with its proposer validator
index from the beacon API. A base-fee sparkline (`eth_feeHistory`) draws the
EIP-1559 sawtooth along the bottom. Near-head reorgs flash the replaced cube
red. The favicon and tab title report every block, even in a background tab.
Click the glyph. `capture 12s` records one slot to WebM. Reduced-motion and
coarse-pointer preferences are respected; tilt drives the parallax on touch.

Query params: `?whale=0.5` lowers the whale threshold, `?ghost=5` shortens
the missed-slot timer, `?embed=1` strips the chrome for iframes, `?hud=1`
shows smoothed per-pass GPU milliseconds from timestamp queries.

`public/og.png` is rendered headless by the same shaders:
`node scripts/render-og.mjs`.

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
