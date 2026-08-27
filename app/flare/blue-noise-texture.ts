import type { Gpu } from "vgpu";

import { BLUE_NOISE_SIZE, blueNoiseBytes } from "./blue-noise-128";

/** Uploads the shared 128x128 blue-noise tile as an r8unorm texture. */
export function createBlueNoiseTexture(gpu: Gpu): GPUTexture {
  const texture = gpu.gpu.createTexture({
    label: "blue-noise-128",
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
