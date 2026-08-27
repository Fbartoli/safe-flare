// Trail decay: copy the previous accumulation, slightly dimmed. Runs first in
// the trail pass; the splats then add the fresh generation on top.

struct Params {
  fade: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var trailSampler: sampler;
@group(0) @binding(2) var trailTexture: texture_2d<f32>;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(textureSample(trailTexture, trailSampler, uv).rgb * params.fade, 1.0);
}
