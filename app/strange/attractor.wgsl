// Clifford attractor step: x' = sin(a·y) + c·cos(a·x), y' = sin(b·x) + d·cos(b·y).
// Each invocation advances one point two iterations and adds a whisper of
// jitter so degenerate parameter regions bloom instead of collapsing to a dot.

struct Params {
  a: f32,
  b: f32,
  c: f32,
  d: f32,
  jitter: f32, // ~0.004 normally; large for one frame on click-scatter
  seed: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> points: array<vec2f>;

fn hash(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

@compute @workgroup_size(256)
fn cs_main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&points)) { return; }
  var p = points[id.x];
  for (var k = 0; k < 2; k++) {
    p = vec2f(
      sin(params.a * p.y) + params.c * cos(params.a * p.x),
      sin(params.b * p.x) + params.d * cos(params.b * p.y)
    );
  }
  let fi = f32(id.x);
  let j = vec2f(hash(fi + params.seed), hash(fi + params.seed + 57.0)) - 0.5;
  points[id.x] = p + j * params.jitter;
}
