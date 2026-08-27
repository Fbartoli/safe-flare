import { clock, draw, effect, frameLoop, init, surface } from "vgpu";
import type { Draw, Effect, FrameLoopHandle, Gpu, Surface } from "vgpu";
import { StorageBuffer } from "vgpu/core";

import type { BlockEvent } from "./eth-feed";
import particlesWgsl from "./particles.wgsl";
import sceneWgsl from "./scene.wgsl";

export interface BlockLabel {
  number: number;
  txCount: number;
  /** Horizontal position as a fraction of the canvas width. */
  u: number;
  /** Vertical position as a fraction of the canvas height. */
  v: number;
  opacity: number;
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
  onLayout(callback: (labels: BlockLabel[]) => void): void;
  onStats(callback: (stats: MempoolStats) => void): void;
  dispose(): void;
}

interface BlockAnim {
  block: BlockEvent;
  x: number;
  scale: number;
  bornAt: number;
}

const MAX_BLOCKS = 10;
const CONVEYOR_Y = -0.34;
const SLOT_START = 0.3;
const SLOT_SPACING = 0.17;
const SPAWN_X = 0.05;
const PARTICLE_SLOTS = 1024;
const MIN_SPAWN_GAP = 0.01; // seconds between visible spawns; extras only count
const STATS_INTERVAL = 0.25;

export function createBlocksRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}): BlocksRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let loop: FrameLoopHandle | undefined;
  let layoutCallback: ((labels: BlockLabel[]) => void) | undefined;
  let statsCallback: ((stats: MempoolStats) => void) | undefined;

  const anims: BlockAnim[] = [];
  let lastBlockAt = -100;
  let now = 0;
  let heat = 0.4;
  let targetHeat = 0.4;

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
    if (anims.some((anim) => anim.block.number === block.number)) return;
    anims.unshift({ block, x: SPAWN_X, scale: 0, bornAt: now });
    if (anims.length > MAX_BLOCKS) anims.pop();
    lastBlockAt = now;
    sinceBlock = 0;
    targetHeat = block.gasLimit > 0 ? block.gasUsed / block.gasLimit : 0.4;
  };

  const initialize = async () => {
    gpu = await init({ label: "eth-blocks" });
    if (disposed) {
      gpu.dispose();
      return;
    }
    const output: Surface = surface(gpu, canvas, { dpr: [1, 2] });
    const scene: Effect = effect(gpu, sceneWgsl, { label: "eth-blocks-scene" });
    const particles: Draw = draw(gpu, {
      shader: particlesWgsl,
      instances: PARTICLE_SLOTS,
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

    const time = clock(gpu);
    let lastTime = 0;
    loop = frameLoop(gpu, (frame) => {
      now = time.time;
      const dt = Math.min(0.1, Math.max(0, now - lastTime));
      lastTime = now;

      const texel = output.texelSize;
      const aspect = texel[1] / texel[0]; // (1/h) / (1/w) = w/h
      const halfWidth = aspect / 2;

      heat += (targetHeat - heat) * Math.min(1, dt * 1.5);

      const cubes: number[][] = [];
      const labels: BlockLabel[] = [];
      for (let index = anims.length - 1; index >= 0; index--) {
        if (anims[index].x > halfWidth + 0.15) anims.splice(index, 1);
      }
      anims.forEach((anim, index) => {
        const targetX = SLOT_START + index * SLOT_SPACING;
        anim.scale += (1 - anim.scale) * Math.min(1, dt * 6);
        anim.x += (targetX - anim.x) * Math.min(1, dt * 2.5);
        const glow = Math.exp(-(now - anim.bornAt) * 0.12);
        const edgeFade = Math.min(1, Math.max(0, (halfWidth + 0.05 - anim.x) / 0.12));
        cubes.push([anim.x, anim.scale * edgeFade, glow, 0]);
        labels.push({
          number: anim.block.number,
          txCount: anim.block.txCount,
          u: 0.5 + anim.x / aspect,
          v: 0.5 - (CONVEYOR_Y + 0.115),
          opacity: anim.scale * edgeFade,
        });
      });
      while (cubes.length < MAX_BLOCKS) cubes.push([0, 0, 0, 0]);

      if (slotsDirty) {
        slots.write(slotData);
        slotsDirty = false;
      }

      const pulse = Math.min(10, now - lastBlockAt);
      const flow = Math.min(1, sinceBlock / 250);
      scene.set({
        params: { aspect: [aspect, 1], time: now, pulse, heat, flow },
        blocks: {
          b0: cubes[0], b1: cubes[1], b2: cubes[2], b3: cubes[3], b4: cubes[4],
          b5: cubes[5], b6: cubes[6], b7: cubes[7], b8: cubes[8], b9: cubes[9],
        },
      });
      particles.set({
        params: { aspect: [aspect, 1], time: now, blockAt: lastBlockAt },
      });

      frame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(scene);
        pass.draw(particles);
      });

      layoutCallback?.(labels);
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
    onLayout(callback) {
      layoutCallback = callback;
    },
    onStats(callback) {
      statsCallback = callback;
    },
    dispose() {
      disposed = true;
      loop?.stop();
      gpu?.dispose();
    },
  };
}
