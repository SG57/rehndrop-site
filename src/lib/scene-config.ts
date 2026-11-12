// Constants and tiny pure helpers for the scene. The same numbers and formulas live in
// src/lib/essence.ts (design owns it); this file mirrors them so the engine builds alone.
// After the merge, swap the mirrored helpers below for imports from essence.ts.

export const PERIOD_S = 300;
export const SOFTNESS = 1.6;
export const SWELL_CYCLE_S = 180;
export const SWELL_GAIN = 3.0;
export const SWELL_EASE_S = 0.3; // time constant: about 1 s to settle

export const PLATE_ASPECT = 1344 / 896;

// Where each plate is cropped when the screen is narrower than the plate (portrait): 0 = left edge
// of the plate, 0.5 = centre (the old behaviour), 1 = right edge. Candle leans to the tassel (plate x 0.93 to 0.96, so
// the window must end past it), chrome to the band edge and bright seam at x 0.85 to 0.95, dawn to the bloom. Landscape has no horizontal slack, so it is unchanged.
export const CROP = { candle: 0.97, chrome: 0.88, dawn: 0.95 };
export const CROP_X: [number, number, number] = [CROP.candle, CROP.chrome, CROP.dawn];

// adaptive scene resolution (fraction of the viewport)
export const SCALE = {
  hardware: 0.6,
  software: 0.5,
  reduced: 0.75,
  floor: 0.3,
  ceiling: 0.9,
  probeFrames: 45,
  downAboveMs: 19,
  downStep: 0.8,
  upBelowMs: 13.5,
  upStep: 1.12,
  upRuns: 4,
  upRunsMax: 16, // each bounce (a creep-up that is stepped straight back down) doubles upRuns, up to this
  atCapMs: 17.5, // a vsync-locked loop at 60 Hz averages ~16.7 ms even when idle: that counts as "fast"
  warmStart: 3, // probe windows ignored after load (shader compile, image decode and upload)
  warmRealloc: 1, // probe windows ignored after a framebuffer reallocation
  shedWindows: 3, // windows still too slow at the floor before the lens pass is dropped
};

// the fog source for the lens is the scene at 1/FOG_DIV of its resolution, refreshed every FOG_EVERY frames
export const FOG_DIV = 4;
export const FOG_EVERY = 2;

export const NOISE = { size: 128, cells: 16, seed: 'scene-noise' };

export const DEG = Math.PI * 2;

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// mirrors essence.ts
export const dayFactor = (h: number) => smoothstep(5, 8, h) * (1 - smoothstep(17, 20, h));

export function timeCycleSwell(tSec: number): [number, number, number] {
  const cyc = tSec / SWELL_CYCLE_S;
  const e = Math.floor(cyc) % 3;
  const bump = Math.sin(Math.PI * (cyc - Math.floor(cyc))) ** 2;
  const out: [number, number, number] = [0, 0, 0];
  out[e] = bump;
  return out;
}
