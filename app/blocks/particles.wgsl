// Mempool particles. Each slot holds (spawnTime, weight) for one real pending
// transaction. A particle flies in from the screen edge, orbits the glyph
// while it waits in the mempool, and spirals in when the next block lands
// (every particle spawned before `blockAt` is doomed). Slots recycle.
//
// Six vertices per instance: a billboard stretched along the particle's own
// velocity, so motion reads as comet streaks instead of static dots.

struct Params {
  aspect: vec2f,   // (width / height, 1)
  time: f32,
  blockAt: f32,    // clock time of the last block landing
  pressure: f32,   // mempool fill 0..1; compresses the orbit between blocks
}

@group(0) @binding(0) var<uniform> params: Params;
@group(1) @binding(0) var<storage, read> slots: array<vec2f>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) intensity: f32,
  @location(2) heavy: f32,
}

fn hash(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

const GLYPH_CENTER = vec2f(0.0, 0.10);
const FLY_SECONDS = 2.4;
const EAT_SECONDS = 0.85;

// Position of one particle at evaluation time `tt`.
fn positionAt(tt: f32, spawn: f32, s1: f32, s2: f32, s3: f32, aspect: f32) -> vec2f {
  let age = max(tt - spawn, 0.0);

  let entryAngle = s1 * 6.28318;
  let edge = vec2f(cos(entryAngle), sin(entryAngle));
  let entry = GLYPH_CENTER + edge * (max(aspect, 1.0) * 0.62 + 0.15);
  let orbitRadius = (0.18 + s2 * 0.12) * mix(1.0, 0.72, params.pressure);
  let orbitAngle = entryAngle + (s3 - 0.5) * 1.1 * age;
  let wobble = 0.014 * sin(tt * (1.2 + s2 * 2.0) + s1 * 40.0);
  let orbit = GLYPH_CENTER +
    vec2f(cos(orbitAngle), sin(orbitAngle)) * (orbitRadius + wobble);

  let travel = 1.0 - pow(1.0 - min(age / FLY_SECONDS, 1.0), 2.4);
  var position = mix(entry, orbit, travel);

  if (spawn < params.blockAt) {
    let eatStart = max(params.blockAt, spawn + FLY_SECONDS * 0.7) + s2 * 0.9;
    if (tt > eatStart) {
      let eat = min((tt - eatStart) / EAT_SECONDS, 1.0);
      let pull = eat * eat * (3.0 - 2.0 * eat);
      let offset = position - GLYPH_CENTER;
      let swirl = eat * 2.6;
      let rotated = vec2f(
        offset.x * cos(swirl) - offset.y * sin(swirl),
        offset.x * sin(swirl) + offset.y * cos(swirl)
      );
      position = GLYPH_CENTER + rotated * (1.0 - pull);
    }
  }
  return position;
}

@vertex fn vs_main(
  @builtin(vertex_index) v: u32,
  @builtin(instance_index) i: u32
) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );

  var out: VertexOut;
  out.position = vec4f(2.0, 2.0, 0.0, 1.0); // culled unless overwritten
  out.local = vec2f(0.0);
  out.intensity = 0.0;
  out.heavy = 0.0;

  let slot = slots[i];
  let spawn = slot.x;
  let weight = slot.y;
  if (spawn <= 0.0 || params.time < spawn) { return out; }

  let fi = f32(i);
  let s1 = hash(fi);
  let s2 = hash(fi + 17.3);
  let s3 = hash(fi + 43.7);
  let age = params.time - spawn;

  var fade = smoothstep(0.0, 0.25, age);
  var glow = 1.0;
  if (spawn < params.blockAt) {
    let eatStart = max(params.blockAt, spawn + FLY_SECONDS * 0.7) + s2 * 0.9;
    if (params.time > eatStart) {
      let eat = (params.time - eatStart) / EAT_SECONDS;
      if (eat >= 1.0) { return out; }
      glow = 1.0 + eat * 3.0;
      fade *= 1.0 - eat * eat;
    }
  }

  let position = positionAt(params.time, spawn, s1, s2, s3, params.aspect.x);
  let previous = positionAt(params.time - 0.06, spawn, s1, s2, s3, params.aspect.x);
  let velocity = position - previous;
  let speed = length(velocity);
  var along = vec2f(1.0, 0.0);
  if (speed > 1e-5) { along = velocity / speed; }
  let across = vec2f(-along.y, along.x);

  let size = (0.006 + s2 * 0.005) * mix(1.0, 2.2, saturate(weight - 1.0));
  let halfLength = size * (1.0 + min(speed * 45.0, 5.0));
  let corner = corners[v];
  let scene = position + along * corner.x * halfLength + across * corner.y * size;

  out.position = vec4f(scene.x * 2.0 / params.aspect.x, scene.y * 2.0, 0.0, 1.0);
  out.local = corner;
  out.intensity = fade * glow * min(weight, 1.8);
  out.heavy = saturate(weight - 1.0);
  return out;
}

@fragment fn fs_main(
  @location(0) local: vec2f,
  @location(1) intensity: f32,
  @location(2) heavy: f32
) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - length(local));
  // Comet gradient: bright head (+x), dim tail (-x).
  let head = mix(0.4, 1.0, (local.x + 1.0) * 0.5);
  let alpha = falloff * falloff * intensity * head;
  let cool = mix(vec3f(0.35, 0.48, 1.0), vec3f(0.85, 0.90, 1.0), falloff * 0.6);
  let rich = vec3f(0.55, 1.0, 0.75); // high-value transactions read green
  return vec4f(mix(cool, rich, heavy) * alpha * 0.55, 1.0);
}
