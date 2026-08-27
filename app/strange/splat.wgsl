// Additive point splats: one soft ~2 px dot per particle into the HDR trail.
// Hue drifts across the attractor plane; dense overlaps whiten in the tone map.

struct Params {
  aspect: vec2f, // (width / height, 1)
  texel: vec2f,  // one output pixel in NDC units
  zoom: f32,     // attractor plane -> NDC
  energy: f32,   // radiance per splat
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(1) @binding(0) var<storage, read> points: array<vec2f>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec3f,
}

const COOL = vec3f(0.40, 0.48, 1.0);
const SAFE = vec3f(0.30, 1.0, 0.58);

@vertex fn vs_main(
  @builtin(vertex_index) v: u32,
  @builtin(instance_index) i: u32
) -> VertexOut {
  // One oversized triangle covers the unit box around the point.
  var corners = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  let p = points[i];
  let ndc = vec2f(p.x * params.zoom / params.aspect.x, p.y * params.zoom);
  let corner = corners[v];

  var out: VertexOut;
  out.position = vec4f(ndc + corner * params.texel * 1.2, 0.0, 1.0);
  out.local = corner;
  let hue = 0.5 + 0.5 * sin(p.x * 1.7 + p.y * 2.3 + params.time * 0.11);
  out.color = mix(COOL, SAFE, hue) * params.energy;
  return out;
}

@fragment fn fs_main(
  @location(0) local: vec2f,
  @location(1) color: vec3f
) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - length(local));
  return vec4f(color * falloff * falloff, 1.0);
}
