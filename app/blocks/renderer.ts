import { clock, draw, effect, frameLoop, init, sampler, surface, target } from "vgpu";
import type { Draw, Effect, FrameLoopHandle, Gpu, Surface, Target } from "vgpu";
import { StorageBuffer } from "vgpu/core";

import { BLUE_NOISE_SIZE, blueNoiseBytes } from "../flare/blue-noise-128";
import blurWgsl from "../flare/blur.wgsl";
import compositeWgsl from "./composite.wgsl";
import type { BlockEvent } from "./eth-feed";
import particlesWgsl from "./particles.wgsl";
import sceneWgsl from "./scene.wgsl";

export interface BlockLabel {
  kind: "block" | "ghost";
  number: number;
  txCount: number;
  /** Horizontal position as a fraction of the canvas width. */
  u: number;
  /** Vertical position as a fraction of the canvas height. */
  v: number;
  opacity: number;
}

export interface WhaleLabel {
  id: number;
  text: string;
  u: number;
  v: number;
  opacity: number;
}

export interface LayoutFrame {
  blocks: BlockLabel[];
  whales: WhaleLabel[];
}

export interface MempoolStats {
  /** Pending transactions seen since the last block. */
  sinceBlock: number;
  /** Smoothed arrival rate in transactions per second. */
  perSecond: number;
}

export interface BlocksRenderer {
  ready: Promise<void>;
  pushBlock(block: BlockEvent): void;
  /** One real pending transaction; weight in [1, 2.4] scales the particle. */
  pushPendingTx(weight: number): void;
  /** A sampled whale transaction; becomes a labeled green orb. */
  pushWhale(valueEth: number): void;
  setFinalized(blockNumber: number): void;
  onLayout(callback: (layout: LayoutFrame) => void): void;
  onStats(callback: (stats: MempoolStats) => void): void;
  dispose(): void;
}

interface BlockAnim {
  kind: "block" | "ghost";
  block?: BlockEvent;
  x: number;
  bornAt: number;
  finalized: boolean;
}

interface WhaleAnim {
  id: number;
  valueEth: number;
  bornAt: number;
  eatenAt?: number;
  baseY: number;
}

const MAX_BLOCKS = 10;
const MAX_WHALES = 4;
const GLYPH_CENTER: readonly [number, number] = [0, 0.1];
const CONVEYOR_Y = -0.26;
const SLOT_START = 0.3;
const SLOT_SPACING = 0.17;
const SPAWN_X = 0.05;
const PARTICLE_SLOTS = 1024;
const MIN_SPAWN_GAP = 0.01; // seconds between visible spawns; extras only count
const STATS_INTERVAL = 0.25;
const STAMP_SECONDS = 0.6;
const SLOT_SECONDS = 12;
const GHOST_AFTER = SLOT_SECONDS * 1.4;
const WHALE_HOLD_X = -0.42;
const BLOOM_STRENGTH = 0.8;

// Gaussian taps shared with the flare's separable blur shader.
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
] as const;

// Overshoot-and-settle landing for conveyor cubes.
function easeOutBack(x: number): number {
  const c1 = 1.70158;
  const t = x - 1;
  return 1 + (c1 + 1) * t * t * t + c1 * t * t;
}

function createBlueNoiseTexture(gpu: Gpu): GPUTexture {
  const texture = gpu.gpu.createTexture({
    label: "eth-blocks-blue-noise-128",
    size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
    format: "r8unorm",
    usage: 0x02 | 0x04,
  });
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
    { texture },
    padded,
    { bytesPerRow, rowsPerImage: BLUE_NOISE_SIZE },
    [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]
  );
  return texture;
}

export function createBlocksRenderer({
  canvas,
  ghostAfter = GHOST_AFTER,
}: {
  readonly canvas: HTMLCanvasElement;
  /** Seconds without a head before a missed-slot ghost spawns (test hook). */
  readonly ghostAfter?: number;
}): BlocksRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let loop: FrameLoopHandle | undefined;
  let layoutCallback: ((layout: LayoutFrame) => void) | undefined;
  let statsCallback: ((stats: MempoolStats) => void) | undefined;

  const anims: BlockAnim[] = [];
  const whaleAnims: WhaleAnim[] = [];
  let whaleId = 0;
  let lastBlockAt = -100;
  let ghostCount = 0;
  let finalizedNumber = 0;
  let now = 0;
  let heat = 0.4;
  let targetHeat = 0.4;
  let surge = 0.6;
  let pressure = 0.25;
  let frameIndex = 0;

  const parallax = [0, 0];
  const parallaxTarget = [0, 0];
  const handlePointerMove = (event: PointerEvent) => {
    parallaxTarget[0] = (event.clientX / window.innerWidth) * 2 - 1;
    parallaxTarget[1] = -((event.clientY / window.innerHeight) * 2 - 1);
  };

  const slotData = new Float32Array(PARTICLE_SLOTS * 2);
  let slotsDirty = false;
  let ring = 0;
  let lastSpawnAt = -1;
  let sinceBlock = 0;
  let arrivalGapEma = 0.5;
  let lastArrivalAt = 0;
  let lastStatsAt = 0;

  const pushPendingTx = (weight: number) => {
    if (disposed) return;
    sinceBlock += 1;
    if (lastArrivalAt > 0) {
      const gap = Math.min(5, now - lastArrivalAt);
      arrivalGapEma = arrivalGapEma * 0.9 + gap * 0.1;
    }
    lastArrivalAt = now;
    if (now - lastSpawnAt < MIN_SPAWN_GAP) return; // counted, not drawn
    lastSpawnAt = now;
    slotData[ring * 2] = now;
    slotData[ring * 2 + 1] = weight;
    ring = (ring + 1) % PARTICLE_SLOTS;
    slotsDirty = true;
  };

  const pushBlock = (block: BlockEvent) => {
    if (anims.some((anim) => anim.block?.number === block.number)) return;
    anims.unshift({ kind: "block", block, x: SPAWN_X, bornAt: now, finalized: false });
    if (anims.length > MAX_BLOCKS) anims.pop();
    lastBlockAt = now;
    ghostCount = 0;
    sinceBlock = 0;
    targetHeat = block.gasLimit > 0 ? block.gasUsed / block.gasLimit : 0.4;
    surge = Math.min(1.25, 0.25 + block.txCount / 350);
    for (const whale of whaleAnims) whale.eatenAt ??= now;
  };

  const pushWhale = (valueEth: number) => {
    if (disposed) return;
    whaleAnims.unshift({
      id: whaleId++,
      valueEth,
      bornAt: now,
      baseY: GLYPH_CENTER[1] + (((whaleId * 0.37) % 0.3) - 0.15),
    });
    if (whaleAnims.length > MAX_WHALES) whaleAnims.pop();
  };

  const initialize = async () => {
    gpu = await init({ label: "eth-blocks" });
    if (disposed) {
      gpu.dispose();
      return;
    }
    const output: Surface = surface(gpu, canvas, { dpr: [1, 2] });
    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const blueNoise = createBlueNoiseTexture(gpu);
    const scene: Effect = effect(gpu, sceneWgsl, { label: "eth-blocks-scene" });
    const blurH: Effect = effect(gpu, blurWgsl, { label: "eth-blocks-bloom-h" });
    const blurV: Effect = effect(gpu, blurWgsl, { label: "eth-blocks-bloom-v" });
    const composite: Effect = effect(gpu, compositeWgsl, {
      label: "eth-blocks-composite",
    });
    const particles: Draw = draw(gpu, {
      shader: particlesWgsl,
      instances: PARTICLE_SLOTS,
      vertices: 6,
      blend: "additive",
      label: "eth-blocks-particles",
    });
    const slots = new StorageBuffer(gpu.device, {
      size: slotData.byteLength,
      label: "eth-blocks-mempool-slots",
      visibility: GPUShaderStage.VERTEX,
      bindGroupLayout: particles.layout(1),
    });
    particles.set({ slots });

    let sceneTarget: Target | undefined;
    let bloomA: Target | undefined;
    let bloomB: Target | undefined;
    let targetWidth = 0;
    let targetHeight = 0;
    const ensureTargets = (width: number, height: number) => {
      if (sceneTarget && width === targetWidth && height === targetHeight) return;
      if (!gpu) return;
      sceneTarget?.color.destroy();
      bloomA?.color.destroy();
      bloomB?.color.destroy();
      targetWidth = width;
      targetHeight = height;
      const half: [number, number] = [
        Math.max(1, width >> 1),
        Math.max(1, height >> 1),
      ];
      sceneTarget = target(gpu, { size: [width, height], format: "rgba16float" });
      bloomA = target(gpu, { size: half, format: "rgba16float" });
      bloomB = target(gpu, { size: half, format: "rgba16float" });
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
      });
    };

    window.addEventListener("pointermove", handlePointerMove);

    const time = clock(gpu);
    let lastTime = 0;
    loop = frameLoop(gpu, (frame) => {
      now = time.time;
      const dt = Math.min(0.1, Math.max(0, now - lastTime));
      lastTime = now;
      frameIndex = (frameIndex + 1) & 0xffff;

      const texel = output.texelSize;
      const width = Math.max(1, Math.round(1 / texel[0]));
      const height = Math.max(1, Math.round(1 / texel[1]));
      const aspect = width / height;
      const halfWidth = aspect / 2;
      ensureTargets(width, height);

      heat += (targetHeat - heat) * Math.min(1, dt * 1.5);
      parallax[0] += (parallaxTarget[0] - parallax[0]) * Math.min(1, dt * 3);
      parallax[1] += (parallaxTarget[1] - parallax[1]) * Math.min(1, dt * 3);

      // Missed slot: the countdown completed but no head arrived.
      if (
        lastBlockAt > 0 &&
        now - lastBlockAt > ghostAfter + ghostCount * SLOT_SECONDS
      ) {
        anims.unshift({ kind: "ghost", x: SPAWN_X, bornAt: now, finalized: false });
        if (anims.length > MAX_BLOCKS) anims.pop();
        ghostCount += 1;
      }

      const cubes: number[][] = [];
      const blockLabels: BlockLabel[] = [];
      for (let index = anims.length - 1; index >= 0; index--) {
        if (anims[index].x > halfWidth + 0.15) anims.splice(index, 1);
      }
      anims.forEach((anim, index) => {
        const targetX = SLOT_START + index * SLOT_SPACING;
        const stamp = easeOutBack(Math.min(1, (now - anim.bornAt) / STAMP_SECONDS));
        anim.x += (targetX - anim.x) * Math.min(1, dt * 2.5);
        anim.finalized =
          anim.kind === "block" && (anim.block?.number ?? 0) <= finalizedNumber;
        const glow = Math.exp(-(now - anim.bornAt) * 0.12);
        const edgeFade = Math.min(1, Math.max(0, (halfWidth + 0.05 - anim.x) / 0.12));
        const scale = stamp * edgeFade;
        const packed =
          (anim.block?.blobs ?? 0) + (anim.finalized ? 16 : 0);
        cubes.push([
          anim.x,
          anim.kind === "ghost" ? -scale : scale,
          glow,
          packed,
        ]);
        blockLabels.push({
          kind: anim.kind,
          number: anim.block?.number ?? 0,
          txCount: anim.block?.txCount ?? 0,
          u: 0.5 + anim.x / aspect,
          v: 0.5 - (CONVEYOR_Y + 0.115),
          opacity: Math.min(1, stamp) * edgeFade,
        });
      });
      while (cubes.length < MAX_BLOCKS) cubes.push([0, 0, 0, 0]);

      // Whales drift in from the left, hold near the glyph, and get eaten
      // with everything else when the block lands.
      const whaleUniform: number[][] = [];
      const whaleLabels: WhaleLabel[] = [];
      for (let index = whaleAnims.length - 1; index >= 0; index--) {
        const whale = whaleAnims[index];
        if (whale.eatenAt !== undefined && now - whale.eatenAt > 0.9) {
          whaleAnims.splice(index, 1);
        }
      }
      for (const whale of whaleAnims.slice(0, MAX_WHALES)) {
        const age = now - whale.bornAt;
        const travel = 1 - Math.pow(1 - Math.min(1, age / 6), 2);
        let x = -halfWidth - 0.1 + (WHALE_HOLD_X - (-halfWidth - 0.1)) * travel;
        let y = whale.baseY + 0.02 * Math.sin(now * 0.8 + whale.id);
        let intensity = Math.min(1, age / 1);
        if (whale.eatenAt !== undefined) {
          const eat = Math.min(1, (now - whale.eatenAt) / 0.8);
          const pull = eat * eat * (3 - 2 * eat);
          x += (GLYPH_CENTER[0] - x) * pull;
          y += (GLYPH_CENTER[1] - y) * pull;
          intensity *= 1 - eat;
        }
        const size = 0.018 + Math.min(0.022, whale.valueEth / 4000);
        whaleUniform.push([x, y, intensity, size]);
        whaleLabels.push({
          id: whale.id,
          text:
            whale.valueEth >= 100
              ? `${Math.round(whale.valueEth)} ETH`
              : `${whale.valueEth.toFixed(1)} ETH`,
          u: 0.5 + x / aspect,
          v: 0.5 - (y + size + 0.035),
          opacity: intensity,
        });
      }
      while (whaleUniform.length < MAX_WHALES) whaleUniform.push([0, 0, 0, 0]);

      if (slotsDirty) {
        slots.write(slotData);
        slotsDirty = false;
      }

      const pulse = Math.min(30, now - lastBlockAt);
      pressure += (Math.min(1, sinceBlock / 250) - pressure) * Math.min(1, dt * 1.2);
      scene.set({
        params: {
          aspect: [aspect, 1],
          parallax,
          time: now,
          pulse,
          heat,
          flow: pressure,
          surge,
        },
        blocks: {
          b0: cubes[0], b1: cubes[1], b2: cubes[2], b3: cubes[3], b4: cubes[4],
          b5: cubes[5], b6: cubes[6], b7: cubes[7], b8: cubes[8], b9: cubes[9],
        },
        whales: {
          w0: whaleUniform[0],
          w1: whaleUniform[1],
          w2: whaleUniform[2],
          w3: whaleUniform[3],
        },
      });
      particles.set({
        params: { aspect: [aspect, 1], time: now, blockAt: lastBlockAt, pressure },
      });
      composite.set({
        params: { aspect: [aspect, 1], frameIndex, bloomStrength: BLOOM_STRENGTH },
      });

      frame.pass({ target: sceneTarget!, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(scene);
        pass.draw(particles);
      });
      frame.pass(bloomA!, blurH);
      frame.pass(bloomB!, blurV);
      frame.pass(output, composite);

      layoutCallback?.({ blocks: blockLabels, whales: whaleLabels });
      if (now - lastStatsAt >= STATS_INTERVAL) {
        lastStatsAt = now;
        statsCallback?.({
          sinceBlock,
          perSecond: lastArrivalAt > 0 ? 1 / Math.max(arrivalGapEma, 0.02) : 0,
        });
      }
    });
  };

  const ready = initialize();

  return {
    ready,
    pushBlock,
    pushPendingTx,
    pushWhale,
    setFinalized(blockNumber) {
      finalizedNumber = blockNumber;
    },
    onLayout(callback) {
      layoutCallback = callback;
    },
    onStats(callback) {
      statsCallback = callback;
    },
    dispose() {
      disposed = true;
      window.removeEventListener("pointermove", handlePointerMove);
      loop?.stop();
      gpu?.dispose();
    },
  };
}
