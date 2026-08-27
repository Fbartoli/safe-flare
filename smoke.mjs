// Headless vgpu smoke check: render a gradient, assert on the pixels.
import assert from "node:assert/strict";
import { init, effect, target } from "vgpu/node";

const gradientSource = `
  @fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, 0.4, 1.0);
  }
`;

const gpu = await init();
try {
  const colorTarget = target(gpu, { size: [64, 64] });
  effect(gpu, gradientSource).draw(colorTarget);
  const pixels = await colorTarget.read();

  // center pixel: blue is the constant 0.4 (~102 of 255), alpha is 1.0
  const center = (32 * 64 + 32) * 4;
  assert.ok(pixels[center + 2] > 95 && pixels[center + 2] < 110, `blue=${pixels[center + 2]}`);
  assert.equal(pixels[center + 3], 255);
  await gpu.settled();
  console.log(`ok: rendered 64x64 gradient on "${gpu.adapter.name}" (${gpu.adapter.type})`);
} finally {
  gpu.dispose();
}
