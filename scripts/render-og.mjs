// Renders the /blocks scene headless into public/og.png (1200x630) using the
// same shaders and bloom chain the page runs. Usage: node scripts/render-og.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { init, effect, draw, frame, sampler, target } from "vgpu/node";
import { StorageBuffer } from "vgpu/core";

const W = 1200;
const H = 630;
const ASPECT = W / H;
const TIME = 40;
const BLOCK_AT = 39.55;
const SHADER_STAGE_VERTEX = 1;

const sceneWgsl = readFileSync("app/blocks/scene.wgsl", "utf8");
const particlesWgsl = readFileSync("app/blocks/particles.wgsl", "utf8");
const compositeWgsl = readFileSync("app/blocks/composite.wgsl", "utf8");
const blurWgsl = readFileSync("app/flare/blur.wgsl", "utf8");
const { BLUE_NOISE_SIZE, blueNoiseBytes } = await import(
  "../app/flare/blue-noise-128.ts"
);

const BLUR_CENTER_WEIGHT = 0.0799404796215474;
const BLUR_TAPS = [
  [1.48500449838059, 0.15215191554518462, 0, 0],
  [3.4650570548417856, 0.12482060361420404, 0, 0],
  [5.445220764892785, 0.08739756064091182, 0, 0],
  [7.42555748318834, 0.052228984400379486, 0, 0],
  [9.406126897065857, 0.026638884372877224, 0, 0],
  [11.386985823860664, 0.011595876612829572, 0, 0],
  [13.368187582263898, 0.004307876491458321, 0, 0],
  [15, 0.0008880585113811997, 0, 0],
];

const gpu = await init();
try {
  const sceneTarget = target(gpu, { size: [W, H], format: "rgba16float" });
  const half = [W >> 1, H >> 1];
  const bloomA = target(gpu, { size: half, format: "rgba16float" });
  const bloomB = target(gpu, { size: half, format: "rgba16float" });
  const output = target(gpu, { size: [W, H] });

  const linearSampler = sampler(gpu, {
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const blueNoise = gpu.gpu.createTexture({
    size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
    format: "r8unorm",
    usage: 0x02 | 0x04,
  });
  {
    const bytesPerRow = 256;
    const source = blueNoiseBytes();
    const padded = new Uint8Array(bytesPerRow * BLUE_NOISE_SIZE);
    for (let row = 0; row < BLUE_NOISE_SIZE; row += 1) {
      padded.set(
        source.subarray(row * BLUE_NOISE_SIZE, (row + 1) * BLUE_NOISE_SIZE),
        row * bytesPerRow
      );
    }
    gpu.gpu.queue.writeTexture(
      { texture: blueNoise },
      padded,
      { bytesPerRow, rowsPerImage: BLUE_NOISE_SIZE },
      [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]
    );
  }

  const scene = effect(gpu, sceneWgsl);
  const blurH = effect(gpu, blurWgsl);
  const blurV = effect(gpu, blurWgsl);
  const composite = effect(gpu, compositeWgsl);
  const particles = draw(gpu, {
    shader: particlesWgsl,
    instances: 1024,
    vertices: 6,
    blend: "additive",
  });

  // Synthetic mempool: most spawned before the block (mid-eat streaks), a
  // fresh wave flying in behind them.
  const slotData = new Float32Array(1024 * 2);
  for (let i = 0; i < 700; i += 1) {
    slotData[i * 2] = 30 + (i / 700) * 9.4;
    slotData[i * 2 + 1] = i % 37 === 0 ? 2.1 : 1;
  }
  for (let i = 700; i < 900; i += 1) {
    slotData[i * 2] = BLOCK_AT + ((i - 700) / 200) * 0.45;
    slotData[i * 2 + 1] = 1;
  }
  const slots = new StorageBuffer(gpu.device, {
    size: slotData.byteLength,
    visibility: SHADER_STAGE_VERTEX,
    bindGroupLayout: particles.layout(1),
  });
  slots.write(slotData);
  particles.set({ slots });

  // A synthetic EIP-1559 sawtooth for the sparkline.
  const fees = Array.from({ length: 52 }, (_, i) =>
    0.5 + 0.35 * Math.sin(i * 0.35) * Math.exp(-((51 - i) % 17) * 0.06)
  );
  const feeVecs = [];
  for (let i = 0; i < 13; i++) {
    feeVecs.push([0, 1, 2, 3].map((lane) => fees[i * 4 + lane] ?? 0));
  }
  scene.set({
    params: {
      aspect: [ASPECT, 1],
      parallax: [0.18, 0.08],
      time: TIME,
      pulse: TIME - BLOCK_AT,
      heat: 0.56,
      flow: 0.65,
      surge: 0.95,
      slotPhase: 0.72,
      feeCount: fees.length,
    },
    blocks: {
      data: [
        [0.5, 1, 0.95, 4],
        [0.67, 1, 0.6, 2],
        [0.84, 1, 0.35, 6],
        [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
        [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
      ],
    },
    whales: {
      data: [
        [-0.42, 0.19, 1, 0.026],
        [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0],
      ],
    },
    fees: { data: feeVecs },
  });
  particles.set({
    params: { aspect: [ASPECT, 1], time: TIME, blockAt: BLOCK_AT, pressure: 0.65 },
  });

  const blurTexel = [1 / half[0], 1 / half[1]];
  const blurParams = {
    texelSize: blurTexel,
    taps: BLUR_TAPS,
    centerWeight: BLUR_CENTER_WEIGHT,
    tapCount: BLUR_TAPS.length,
  };
  blurH.set({
    linearSampler,
    sourceTexture: sceneTarget,
    params: { ...blurParams, direction: [blurTexel[0], 0] },
  });
  blurV.set({
    linearSampler,
    sourceTexture: bloomA,
    params: { ...blurParams, direction: [0, blurTexel[1]] },
  });
  composite.set({
    linearSampler,
    sceneTexture: sceneTarget,
    bloomTexture: bloomB,
    blueNoiseTexture: blueNoise,
    params: { aspect: [ASPECT, 1], frameIndex: 7, bloomStrength: 0.8 },
  });

  frame(gpu, (currentFrame) => {
    currentFrame.pass({ target: sceneTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(scene);
      pass.draw(particles);
    });
    currentFrame.pass(bloomA, blurH);
    currentFrame.pass(bloomB, blurV);
    currentFrame.pass(output, composite);
  });

  const pixels = await output.read();
  const png = new PNG({ width: W, height: H });
  png.data.set(pixels);
  writeFileSync("public/og.png", PNG.sync.write(png));
  console.log(`ok: wrote public/og.png (${W}x${H}) on "${gpu.adapter.name}"`);
} finally {
  gpu.dispose();
}
