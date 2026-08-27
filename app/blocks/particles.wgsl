// Stateless transaction particles: every instance derives its whole life from
// instance_index and time. They stream in from the left and are absorbed by
// the glyph. `flow` gates how many instances are alive.

struct Params {
  aspect: vec2f,   // (width / height, 1)
  time: f32,
  flow: f32,
  pulse: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) intensity: f32,
}

fn hash(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

const GLYPH_CENTER = vec2f(0.0, 0.10);

@vertex fn vs_main(
  @builtin(vertex_index) v: u32,
  @builtin(instance_index) i: u32
) -> VertexOut {
  var corners = array<vec2f, 3>(
    vec2f(-1.732, -1.0),
    vec2f(1.732, -1.0),
    vec2f(0.0, 2.0)
  );
  let fi = f32(i);
  let s1 = hash(fi);
  let s2 = hash(fi + 17.3);
  let s3 = hash(fi + 43.7);

  var out: VertexOut;
  if (s1 > params.flow) {
    out.position = vec4f(2.0, 2.0, 0.0, 1.0); // culled offscreen
    out.local = vec2f(0.0);
    out.intensity = 0.0;
    return out;
  }

  let halfWidth = params.aspect.x * 0.5;
  let duration = mix(5.0, 11.0, s2);
  let phase = fract(params.time / duration + s3);

  // Quadratic bezier from off the left edge into the glyph.
  let start = vec2f(-halfWidth - 0.06, (s1 * 2.0 - 1.0) * 0.42);
  let control = vec2f(-halfWidth * 0.45, start.y * 0.25 + GLYPH_CENTER.y * 0.6);
  let goal = GLYPH_CENTER + vec2f(s2 - 0.5, s3 - 0.5) * 0.06;
  let q = pow(phase, 0.85);
  let position = mix(mix(start, control, q), mix(control, goal, q), q);

  let fadeIn = smoothstep(0.0, 0.08, phase);
  let absorb = smoothstep(0.94, 1.0, phase);
  let size = (0.005 + s2 * 0.005) * (1.0 - 0.6 * absorb);
  let approach = 1.0 + 2.4 * smoothstep(0.6, 1.0, phase);

  let scene = position + corners[v] * size;
  out.position = vec4f(scene.x * 2.0 / params.aspect.x, scene.y * 2.0, 0.0, 1.0);
  out.local = corners[v];
  out.intensity = fadeIn * (1.0 - absorb) * approach;
  return out;
}

@fragment fn fs_main(
  @location(0) local: vec2f,
  @location(1) intensity: f32
) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - length(local));
  let alpha = falloff * falloff * intensity;
  let color = mix(vec3f(0.35, 0.48, 1.0), vec3f(0.85, 0.90, 1.0), falloff * 0.6);
  return vec4f(color * alpha * 0.55, 1.0);
}
