import { clock, draw, effect, frameLoop, init, surface } from "vgpu";
import type { Draw, Effect, FrameLoopHandle, Gpu, Surface } from "vgpu";

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

export interface BlocksRenderer {
  ready: Promise<void>;
  pushBlock(block: BlockEvent): void;
  onLayout(callback: (labels: BlockLabel[]) => void): void;
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
const PARTICLE_COUNT = 900;


export function createBlocksRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}): BlocksRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let loop: FrameLoopHandle | undefined;
  let layoutCallback: ((labels: BlockLabel[]) => void) | undefined;

  const anims: BlockAnim[] = [];
  let lastBlockAt = -100;
  let now = 0;
  let flow = 0.25;
  let targetFlow = 0.25;
  let heat = 0.4;
  let targetHeat = 0.4;

  const pushBlock = (block: BlockEvent) => {
    if (anims.some((anim) => anim.block.number === block.number)) return;
    anims.unshift({ block, x: SPAWN_X, scale: 0, bornAt: now });
    if (anims.length > MAX_BLOCKS) anims.pop();
    lastBlockAt = now;
    targetFlow = Math.min(1, block.txCount / 250) * 0.85 + 0.15;
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
      instances: PARTICLE_COUNT,
      blend: "additive",
      label: "eth-blocks-particles",
    });

    const time = clock(gpu);
    let lastTime = 0;
    loop = frameLoop(gpu, (frame) => {
      now = time.time;
      const dt = Math.min(0.1, Math.max(0, now - lastTime));
      lastTime = now;

      const texel = output.texelSize;
      const aspect = texel[1] / texel[0]; // (1/h) / (1/w) = w/h
      const halfWidth = aspect / 2;

      flow += (targetFlow - flow) * Math.min(1, dt * 1.5);
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

      const pulse = Math.min(10, now - lastBlockAt);
      scene.set({
        params: { aspect: [aspect, 1], time: now, pulse, heat, flow },
        blocks: {
          b0: cubes[0], b1: cubes[1], b2: cubes[2], b3: cubes[3], b4: cubes[4],
          b5: cubes[5], b6: cubes[6], b7: cubes[7], b8: cubes[8], b9: cubes[9],
        },
      });
      particles.set({ params: { aspect: [aspect, 1], time: now, flow, pulse } });

      frame.pass({ target: output, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(scene);
        pass.draw(particles);
      });

      layoutCallback?.(labels);
    });
  };

  const ready = initialize();

  return {
    ready,
    pushBlock,
    onLayout(callback) {
      layoutCallback = callback;
    },
    dispose() {
      disposed = true;
      loop?.stop();
      gpu?.dispose();
    },
  };
}
