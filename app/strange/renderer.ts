import {
  clock,
  compute,
  draw,
  effect,
  frameLoop,
  init,
  pingPong,
  sampler,
  surface,
  target,
} from "vgpu";
import type {
  Compute,
  Draw,
  Effect,
  FrameLoopHandle,
  Gpu,
  PingPongTargets,
  Surface,
  Target,
} from "vgpu";
import { StorageBuffer } from "vgpu/core";

import compositeWgsl from "../blocks/composite.wgsl";
import { createBlueNoiseTexture } from "../flare/blue-noise-texture";
import blurWgsl from "../flare/blur.wgsl";
import attractorWgsl from "./attractor.wgsl";
import fadeWgsl from "./fade.wgsl";
import splatWgsl from "./splat.wgsl";

export interface AttractorParams {
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface StrangeRenderer {
  ready: Promise<void>;
  /** Scatter every point; the cloud re-collapses onto the attractor. */
  scatter(): void;
  onParams(callback: (params: AttractorParams) => void): void;
  dispose(): void;
}

const POINTS = 262144;
const WORKGROUP = 256;
const FADE = 0.965;
const ENERGY = 0.055;
const JITTER = 0.008;
const LEG_SECONDS = 22;
const BLOOM_STRENGTH = 0.7;

// Known-good Clifford coefficient sets, ordered by parameter proximity so
// interpolation legs spend as little time as possible in collapsed regimes.
const PRESETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-1.4, 1.6, 1.0, 0.7],
  [-1.7, 1.3, -0.1, -1.21],
  [-1.7, 1.8, -1.9, -0.4],
  [-1.8, -2.0, -0.5, -0.9],
  [1.5, -1.8, 1.6, 0.9],
  [1.7, 1.7, 0.6, 1.2],
];

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

function seedPoints(): Float32Array<ArrayBuffer> {
  const data = new Float32Array(POINTS * 2);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 4;
  return data;
}

// Double smootherstep: long dwell on each preset, fast transit between them
// (degenerate mid-leg regimes flash by instead of lingering).
function ease(t: number): number {
  const s = t * t * t * (t * (t * 6 - 15) + 10);
  return s * s * s * (s * (s * 6 - 15) + 10);
}

export function createStrangeRenderer({
  canvas,
}: {
  readonly canvas: HTMLCanvasElement;
}): StrangeRenderer {
  let disposed = false;
  let gpu: Gpu | undefined;
  let loop: FrameLoopHandle | undefined;
  let paramsCallback: ((params: AttractorParams) => void) | undefined;
  let scatterPending = false;
  let lastReportAt = 0;

  const reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  const driftSpeed = reducedMotion ? 0.25 : 1;

  // The pointer bends the map itself: offsets on a and b, eased per frame.
  const bend = [0, 0];
  const bendTarget = [0, 0];
  const handlePointerMove = (event: PointerEvent) => {
    bendTarget[0] = ((event.clientX / window.innerWidth) * 2 - 1) * 0.22;
    bendTarget[1] = ((event.clientY / window.innerHeight) * 2 - 1) * 0.22;
  };

  const initialize = async () => {
    gpu = await init({ label: "strange" });
    if (disposed) {
      gpu.dispose();
      return;
    }
    const output: Surface = surface(gpu, canvas, {
      dpr: [1, coarsePointer ? 1.5 : 2],
    });
    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const blueNoise = createBlueNoiseTexture(gpu);

    const sim: Compute = compute(gpu, attractorWgsl, { label: "strange-sim" });
    const fade: Effect = effect(gpu, fadeWgsl, { label: "strange-fade" });
    const blurH: Effect = effect(gpu, blurWgsl, { label: "strange-bloom-h" });
    const blurV: Effect = effect(gpu, blurWgsl, { label: "strange-bloom-v" });
    const composite: Effect = effect(gpu, compositeWgsl, {
      label: "strange-composite",
    });
    const splats: Draw = draw(gpu, {
      shader: splatWgsl,
      instances: POINTS,
      vertices: 3,
      blend: "additive",
      label: "strange-splats",
    });

    const seed = seedPoints();
    const points = new StorageBuffer(gpu.device, {
      size: seed.byteLength,
      label: "strange-points",
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
      bindGroupLayout: splats.layout(1),
    });
    points.write(seed);
    splats.set({ points });
    sim.set({ points });

    let trail: PingPongTargets | undefined;
    let bloomA: Target | undefined;
    let bloomB: Target | undefined;
    let targetWidth = 0;
    let targetHeight = 0;
    const ensureTargets = (width: number, height: number) => {
      if (trail && width === targetWidth && height === targetHeight) return;
      if (!gpu) return;
      trail?.read.color.destroy();
      trail?.write.color.destroy();
      bloomA?.color.destroy();
      bloomB?.color.destroy();
      targetWidth = width;
      targetHeight = height;
      const half: [number, number] = [
        Math.max(1, width >> 1),
        Math.max(1, height >> 1),
      ];
      trail = pingPong(gpu, width, height, { format: "rgba16float" });
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
        params: { ...blurParams, direction: [blurTexel[0], 0] },
      });
      blurV.set({
        linearSampler,
        sourceTexture: bloomA,
        params: { ...blurParams, direction: [0, blurTexel[1]] },
      });
      composite.set({
        linearSampler,
        bloomTexture: bloomB,
        blueNoiseTexture: blueNoise,
      });
    };

    window.addEventListener("pointermove", handlePointerMove);

    const time = clock(gpu);
    let frameIndex = 0;
    loop = frameLoop(gpu, (frame) => {
      const now = time.time;
      frameIndex = (frameIndex + 1) & 0xffff;

      const texel = output.texelSize;
      const width = Math.max(1, Math.round(1 / texel[0]));
      const height = Math.max(1, Math.round(1 / texel[1]));
      const aspect = width / height;
      ensureTargets(width, height);

      // Coefficients: eased walk through the preset loop, a slow breath, and
      // the pointer's bend.
      const leg = (now * driftSpeed) / LEG_SECONDS;
      const from = PRESETS[Math.floor(leg) % PRESETS.length];
      const to = PRESETS[(Math.floor(leg) + 1) % PRESETS.length];
      const mixT = ease(leg - Math.floor(leg));
      bend[0] += (bendTarget[0] - bend[0]) * 0.06;
      bend[1] += (bendTarget[1] - bend[1]) * 0.06;
      const breath = Math.sin(now * 0.31) * 0.015;
      const a = from[0] + (to[0] - from[0]) * mixT + bend[0] + breath;
      const b = from[1] + (to[1] - from[1]) * mixT + bend[1] - breath;
      const c = from[2] + (to[2] - from[2]) * mixT;
      const d = from[3] + (to[3] - from[3]) * mixT;

      sim.set({
        params: {
          a,
          b,
          c,
          d,
          jitter: scatterPending ? 3.5 : JITTER,
          seed: (now % 1000) * 61.7,
        },
      });
      scatterPending = false;
      sim.dispatch(Math.ceil(POINTS / WORKGROUP));

      // Fit the attractor's bounding box (|x| <= 1+|c|, |y| <= 1+|d|).
      const zoom = Math.min(
        (0.92 * aspect) / (1 + Math.abs(c)),
        0.92 / (1 + Math.abs(d))
      );
      splats.set({
        params: {
          aspect: [aspect, 1],
          texel: [2 / width, 2 / height],
          zoom,
          energy: ENERGY,
          time: now,
        },
      });
      fade.set({
        trailSampler: linearSampler,
        trailTexture: trail!.read,
        params: { fade: FADE },
      });
      blurH.set({ sourceTexture: trail!.write });
      composite.set({
        sceneTexture: trail!.write,
        params: { aspect: [aspect, 1], frameIndex, bloomStrength: BLOOM_STRENGTH },
      });

      frame.pass({ target: trail!.write, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(fade);
        pass.draw(splats);
      });
      frame.pass(bloomA!, blurH);
      frame.pass(bloomB!, blurV);
      frame.pass(output, composite);
      trail!.swap();

      if (now - lastReportAt >= 0.25) {
        lastReportAt = now;
        paramsCallback?.({ a, b, c, d });
      }
    });
  };

  const ready = initialize();

  return {
    ready,
    scatter() {
      scatterPending = true;
    },
    onParams(callback) {
      paramsCallback = callback;
    },
    dispose() {
      disposed = true;
      window.removeEventListener("pointermove", handlePointerMove);
      loop?.stop();
      gpu?.dispose();
    },
  };
}
