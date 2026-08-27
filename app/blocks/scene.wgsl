// Scene layer: background, the Ethereum glyph as rim-lit line art, the slot
// countdown arc, a pulse ring per block, conveyor cubes (with blob orbs,
// finality, and missed-slot ghosts), and whale orbs. Outputs linear HDR
// radiance; tone mapping, vignette, and grain live in the composite pass.

struct Params {
  aspect: vec2f,   // (width / height, 1)
  parallax: vec2f, // pointer offset in [-1, 1], eased
  time: f32,
  pulse: f32,      // seconds since the last block
  heat: f32,       // gasUsed / gasLimit of the last block
  flow: f32,       // normalized mempool pressure
  surge: f32,      // last block's tx count, normalized
}

// One vec4 per conveyor block: (x, scale, glow, blobs + finalized * 16).
// A negative scale marks a missed-slot ghost.
struct Blocks {
  b0: vec4f, b1: vec4f, b2: vec4f, b3: vec4f, b4: vec4f,
  b5: vec4f, b6: vec4f, b7: vec4f, b8: vec4f, b9: vec4f,
}

// One vec4 per whale transaction: (x, y, intensity, size).
struct Whales {
  w0: vec4f, w1: vec4f, w2: vec4f, w3: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> blocks: Blocks;
@group(0) @binding(2) var<uniform> whales: Whales;

const GLYPH_CENTER = vec2f(0.0, 0.10);
const GLYPH_SCALE = 0.24;
// Blocks exit on the glyph's equator, through the countdown-arc gate.
const CONVEYOR_Y = 0.10;
const SLOT_SECONDS = 12.0;
const LINE_COLOR = vec3f(0.62, 0.71, 1.0);
const CORE_COLOR = vec3f(0.88, 0.92, 1.0);
const VIOLET = vec3f(0.55, 0.50, 0.95);
const WHALE_COLOR = vec3f(0.55, 1.0, 0.75);

fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Line rendering: crisp core plus exponential halo.
fn lineGlow(d: f32, px: f32) -> vec2f {
  let core = smoothstep(px * 1.6, 0.0, d);
  let halo = exp(-d * 34.0);
  return vec2f(core, halo);
}

fn glyphDistance(p: vec2f) -> f32 {
  let q = (p - GLYPH_CENTER) / GLYPH_SCALE;
  // Upper diamond with a center crease, then the lower pyramid.
  var a = array<vec2f, 8>(
    vec2f(0.0, 1.0),
    vec2f(0.0, 1.0),
    vec2f(-0.60, -0.02),
    vec2f(0.60, -0.02),
    vec2f(0.0, 1.0),
    vec2f(-0.60, -0.18),
    vec2f(0.60, -0.18),
    vec2f(0.0, -0.50)
  );
  var b = array<vec2f, 8>(
    vec2f(-0.60, -0.02),
    vec2f(0.60, -0.02),
    vec2f(0.0, -0.42),
    vec2f(0.0, -0.42),
    vec2f(0.0, -0.42),
    vec2f(0.0, -1.0),
    vec2f(0.0, -1.0),
    vec2f(0.0, -1.0)
  );
  var d = 1e5;
  for (var i = 0; i < 8; i++) {
    d = min(d, sdSegment(q, a[i], b[i]));
  }
  return d * GLYPH_SCALE;
}

// Isometric cube outline: pointy-top hexagon plus the three inner "Y" edges.
// Ghosts keep the silhouette but drop the inner edges.
fn cubeDistance(p: vec2f, center: vec2f, size: f32, ghost: bool) -> f32 {
  var v: array<vec2f, 6>;
  for (var k = 0; k < 6; k++) {
    let angle = radians(90.0 + 60.0 * f32(k));
    v[k] = center + size * vec2f(cos(angle), sin(angle));
  }
  var d = 1e5;
  for (var k = 0; k < 6; k++) {
    d = min(d, sdSegment(p, v[k], v[(k + 1) % 6]));
  }
  if (!ghost) {
    d = min(d, sdSegment(p, center, v[1]));
    d = min(d, sdSegment(p, center, v[3]));
    d = min(d, sdSegment(p, center, v[5]));
  }
  return d;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = vec2f((uv.x - 0.5) * params.aspect.x, 0.5 - uv.y);
  // Parallax layers: the far grid drifts more than the near machinery.
  let pGrid = base + params.parallax * 0.030;
  let p = base + params.parallax * 0.012;
  let pBelt = base + params.parallax * 0.020;
  let px = fwidth(base.x);
  var radiance = vec3f(0.0);

  // Faint grid.
  let cell = abs(fract(pGrid * 8.0 + 0.5) - 0.5);
  let grid = smoothstep(0.06, 0.0, min(cell.x, cell.y));
  radiance += vec3f(0.05, 0.07, 0.13) * grid * 0.16;

  // The glyph. Facets get a two-tone tint like the mark itself; mempool
  // pressure (flow) charges it between blocks.
  let gd = glyphDistance(p);
  let glyphLine = lineGlow(gd, px);
  let facet = mix(VIOLET, LINE_COLOR, smoothstep(-0.05, 0.15, p.y - GLYPH_CENTER.y));
  let blockFlash = exp(-params.pulse * 2.6) * (0.4 + params.surge);
  radiance += facet * glyphLine.y *
    (0.45 + params.heat * 0.5 + params.flow * 0.35 + blockFlash);
  radiance += CORE_COLOR * glyphLine.x * (0.85 + blockFlash * 0.8);

  // Slot countdown: an arc around the glyph fills over the 12 s slot,
  // sweeping clockwise from the top.
  let arm = p - GLYPH_CENTER;
  let arcDistance = abs(length(arm) - 0.36);
  let sweep = fract(atan2(arm.x, arm.y) / 6.28318 + 1.0);
  let fillFraction = min(params.pulse / SLOT_SECONDS, 1.0);
  let filled = smoothstep(0.0, 0.012, fillFraction - sweep);
  let arc = exp(-arcDistance * 220.0);
  radiance += LINE_COLOR * arc * (0.03 + filled * 0.28);

  // Pulse ring expanding from the glyph on each new block.
  let ringRadius = 0.10 + params.pulse * 0.55;
  let ring = exp(-abs(length(arm) - ringRadius) * 70.0) * exp(-params.pulse * 2.1);
  radiance += VIOLET * ring * (0.4 + params.surge);

  // Conveyor line from the glyph to the right edge.
  let convStart = vec2f(0.17, CONVEYOR_Y);
  let convEnd = vec2f(params.aspect.x * 0.5 + 0.2, CONVEYOR_Y);
  let cd = sdSegment(pBelt, convStart, convEnd);
  let conv = lineGlow(cd, px);
  radiance += LINE_COLOR * (conv.x * 0.10 + conv.y * 0.05);

  // Blocks on the conveyor.
  var cubes = array<vec4f, 10>(
    blocks.b0, blocks.b1, blocks.b2, blocks.b3, blocks.b4,
    blocks.b5, blocks.b6, blocks.b7, blocks.b8, blocks.b9
  );
  for (var i = 0; i < 10; i++) {
    let cube = cubes[i];
    let ghost = cube.y < 0.0;
    let scale = abs(cube.y);
    if (scale < 0.01) { continue; }
    let center = vec2f(cube.x, CONVEYOR_Y);
    let finalized = cube.w >= 16.0;
    let blobCount = cube.w - select(0.0, 16.0, finalized);
    let d = cubeDistance(pBelt, center, 0.055 * scale, ghost);
    let line = lineGlow(d, px);
    if (ghost) {
      radiance += LINE_COLOR * 0.35 * (line.x * 0.30 + line.y * 0.06);
      continue;
    }
    var tint = mix(LINE_COLOR * 0.5, CORE_COLOR, cube.z);
    var coreGain = 0.25 + cube.z * 0.75;
    var haloGain = cube.z * 0.7;
    if (finalized) {
      // Crystallized: solid bright edges, almost no atmosphere.
      tint = CORE_COLOR;
      coreGain = 1.0;
      haloGain = 0.08;
    }
    radiance += tint * (line.x * coreGain + line.y * haloGain);
    // Blob orbs docked under the cube: the rollup data lane (capped at 8;
    // the header carries the true count).
    for (var k = 0; k < 8; k++) {
      if (f32(k) >= blobCount) { break; }
      let orb = center +
        vec2f((f32(k) - (min(blobCount, 8.0) - 1.0) * 0.5) * 0.022, -0.085 * scale - 0.028);
      let od = length(pBelt - orb);
      radiance += VIOLET * exp(-od * 260.0) * (0.5 + cube.z * 0.6);
    }
  }

  // Whale transactions: rare, heavy, green.
  var pods = array<vec4f, 4>(whales.w0, whales.w1, whales.w2, whales.w3);
  for (var i = 0; i < 4; i++) {
    let whale = pods[i];
    if (whale.z < 0.01) { continue; }
    let wd = length(p - whale.xy);
    let core = exp(-wd * wd / (whale.w * whale.w));
    let halo = exp(-wd * 14.0);
    radiance += WHALE_COLOR * (core * 1.6 + halo * 0.35) * whale.z;
  }

  return vec4f(radiance, 1.0);
}
