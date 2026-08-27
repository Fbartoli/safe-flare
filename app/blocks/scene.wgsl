// Fullscreen scene: background, the Ethereum glyph as rim-lit line art, a
// pulse ring on each new block, and up to ten isometric block cubes sliding
// out along a conveyor line. All shapes are segment SDFs.

struct Params {
  aspect: vec2f,   // (width / height, 1)
  time: f32,
  pulse: f32,      // seconds since the last block
  heat: f32,       // gasUsed / gasLimit of the last block
  flow: f32,       // normalized tx inflow
}

// One vec4 per conveyor block: (x, scale, glow, unused).
struct Blocks {
  b0: vec4f, b1: vec4f, b2: vec4f, b3: vec4f, b4: vec4f,
  b5: vec4f, b6: vec4f, b7: vec4f, b8: vec4f, b9: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> blocks: Blocks;

const GLYPH_CENTER = vec2f(0.0, 0.10);
const GLYPH_SCALE = 0.24;
const CONVEYOR_Y = -0.34;
const LINE_COLOR = vec3f(0.62, 0.71, 1.0);
const CORE_COLOR = vec3f(0.88, 0.92, 1.0);
const VIOLET = vec3f(0.55, 0.50, 0.95);

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
    vec2f(0.0, 1.0),    // apex -> left
    vec2f(0.0, 1.0),    // apex -> right
    vec2f(-0.60, -0.02), // left -> waist bottom
    vec2f(0.60, -0.02),  // right -> waist bottom
    vec2f(0.0, 1.0),    // apex -> waist bottom (crease)
    vec2f(-0.60, -0.18), // lower left -> bottom apex
    vec2f(0.60, -0.18),  // lower right -> bottom apex
    vec2f(0.0, -0.50)   // lower crease -> bottom apex
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
fn cubeDistance(p: vec2f, center: vec2f, size: f32) -> f32 {
  var v: array<vec2f, 6>;
  for (var k = 0; k < 6; k++) {
    let angle = radians(90.0 + 60.0 * f32(k));
    v[k] = center + size * vec2f(cos(angle), sin(angle));
  }
  var d = 1e5;
  for (var k = 0; k < 6; k++) {
    d = min(d, sdSegment(p, v[k], v[(k + 1) % 6]));
  }
  d = min(d, sdSegment(p, center, v[1]));
  d = min(d, sdSegment(p, center, v[3]));
  d = min(d, sdSegment(p, center, v[5]));
  return d;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = vec2f((uv.x - 0.5) * params.aspect.x, 0.5 - uv.y);
  let px = fwidth(p.x);
  var radiance = vec3f(0.0);

  // Faint grid and vignette.
  let cell = abs(fract(p * 8.0 + 0.5) - 0.5);
  let grid = smoothstep(0.06, 0.0, min(cell.x, cell.y));
  radiance += vec3f(0.05, 0.07, 0.13) * grid * 0.16;

  // The glyph. Facets get a two-tone tint like the mark itself; mempool
  // pressure (flow) charges it between blocks.
  let gd = glyphDistance(p);
  let glyphLine = lineGlow(gd, px);
  let facet = mix(VIOLET, LINE_COLOR, smoothstep(-0.05, 0.15, p.y - GLYPH_CENTER.y));
  let blockFlash = exp(-params.pulse * 2.6);
  radiance += facet * glyphLine.y *
    (0.45 + params.heat * 0.5 + params.flow * 0.35 + blockFlash);
  radiance += CORE_COLOR * glyphLine.x * (0.85 + blockFlash * 0.8);

  // Pulse ring expanding from the glyph on each new block.
  let ringRadius = 0.10 + params.pulse * 0.55;
  let ring = exp(-abs(length(p - GLYPH_CENTER) - ringRadius) * 70.0) * exp(-params.pulse * 2.1);
  radiance += VIOLET * ring * 0.9;

  // Conveyor line from the glyph to the right edge.
  let convStart = vec2f(0.04, CONVEYOR_Y);
  let convEnd = vec2f(params.aspect.x * 0.5 + 0.2, CONVEYOR_Y);
  let cd = sdSegment(p, convStart, convEnd);
  let conv = lineGlow(cd, px);
  radiance += LINE_COLOR * (conv.x * 0.10 + conv.y * 0.05);

  // Blocks on the conveyor.
  var cubes = array<vec4f, 10>(
    blocks.b0, blocks.b1, blocks.b2, blocks.b3, blocks.b4,
    blocks.b5, blocks.b6, blocks.b7, blocks.b8, blocks.b9
  );
  for (var i = 0; i < 10; i++) {
    let cube = cubes[i];
    if (cube.y < 0.01) { continue; }
    let d = cubeDistance(p, vec2f(cube.x, CONVEYOR_Y), 0.055 * cube.y);
    let line = lineGlow(d, px);
    let tint = mix(LINE_COLOR * 0.5, CORE_COLOR, cube.z);
    radiance += tint * (line.x * (0.25 + cube.z * 0.75) + line.y * cube.z * 0.7);
  }

  // Vignette and filmic-ish resolve.
  let vignette = smoothstep(1.25, 0.35, length(p * vec2f(0.85, 1.35)));
  let color = (vec3f(1.0) - exp(-radiance * 1.4)) * vignette;
  return vec4f(color, 1.0);
}
