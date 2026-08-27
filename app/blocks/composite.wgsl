// Final resolve: HDR scene + bloom, vignette, filmic-ish tone map, and a
// decorrelated blue-noise grain that only touches dim regions.

struct Params {
  aspect: vec2f,
  frameIndex: u32,
  bloomStrength: f32,
}

@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var bloomTexture: texture_2d<f32>;
@group(0) @binding(3) var blueNoiseTexture: texture_2d<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scene = textureSample(sceneTexture, linearSampler, uv).rgb;
  let bloom = textureSample(bloomTexture, linearSampler, uv).rgb;
  let radiance = scene + bloom * params.bloomStrength;

  let p = vec2f((uv.x - 0.5) * params.aspect.x, 0.5 - uv.y);
  let vignette = smoothstep(1.25, 0.35, length(p * vec2f(0.85, 1.35)));
  let color = (vec3f(1.0) - exp(-radiance * 1.4)) * vignette;

  let dimensions = textureDimensions(sceneTexture);
  let pixel = vec2u(clamp(uv * vec2f(dimensions), vec2f(0.0), vec2f(dimensions) - vec2f(1.0)));
  let offset = vec2u(params.frameIndex * 37u + 53u, params.frameIndex * 109u + 17u);
  let noisePixel = (pixel + offset) & vec2u(127u);
  let noise = textureLoad(blueNoiseTexture, vec2i(noisePixel), 0).r;
  let grain = (fract(noise + f32(params.frameIndex) * 0.61803398875) - 0.5) * 2.0;
  let luma = dot(color, vec3f(0.299, 0.587, 0.114));
  let grainMask = 1.0 - smoothstep(0.05, 0.35, luma);
  let grained = clamp(color + vec3f(grain * 0.015 * grainMask), vec3f(0.0), vec3f(1.0));
  return vec4f(grained, 1.0);
}
