// Constants for the water on the glass (src/scripts/water.ts). Sizes are in CSS pixels of the
// viewport unless a name says otherwise; times are in seconds.

export type TierKey = 'software' | 'hardware' | 'reduced';

// simulated drops (the ones that can run), micro beads (static, slowly re-seeded) per tier
export const CAP: Record<TierKey, number> = { software: 24, hardware: 60, reduced: 6 };
export const BEAD_CAP: Record<TierKey, number> = { software: 260, hardware: 520, reduced: 90 };

// the fog mask is a fixed-size render target (independent of the adaptive scene scale, so tracks
// survive a scale change); its width in texels, height follows the viewport aspect
export const FOG_W: Record<TierKey, number> = { software: 640, hardware: 960, reduced: 640 };

export const FOG = {
  regrowEvery: 0.45, // one texel step of fog comes back this often (255 steps: about 115 s to refill a cleared track)
  wipeWidth: 24, // px: a finger-wide wipe under the cursor
  wipeStrength: 0.38,
  maxStamps: 384, // per frame; overflow is dropped, the next frame carries on
  minHalfTexels: 0.85, // a track is never thinner than this, or it vanishes in the filter
};

// the pre-simulation that gives a fresh page some history, and the still frame under ?t=
export const PRESIM = { dt: 1 / 15, seconds: 16 };
export const STILL = { dt: 1 / 30, steps: 420 };

// secondary refraction source: one drop in oneIn (picked by a hash of its serial) of at least minR (times the size unit);
// view is the width in px of each plate in the small source texture
export const REFRACT_ALT = { oneIn: 9, minR: 13, view: 192 };

// optional decoration layers (the alternate refraction, cover glints, the wide-screen edge): off until released
export const SEEDS_ON = false;

// unit-length direction towards the light, in GL space (x right, y up): upper left
export const LIGHT: [number, number] = [-0.55, 0.835];

// per-essence behaviour; mixed by the weights at the drop's position
export interface EssenceWater {
  size: number; // radius multiplier
  density: number; // relative chance that a spawn position is accepted
  beads: number; // relative bead density
  speed: number; // peak slip speed multiplier
  holdLo: number;
  holdHi: number; // seconds a runner holds between slips
  slipLo: number;
  slipHi: number; // slip length, in drop radii
  run: number; // chance that a mid-sized drop becomes a runner
  trail: number; // track width as a fraction of the drop's width
  trailStr: number; // how completely a track clears the fog
  tear: number; // teardrop amount while running
  elong: number; // vertical stretch while running
  fringe: number; // per-channel refraction offset
  spec: number; // specular gain
  specSize: number;
  rim: number; // dark rim strength
  tint: [number, number, number]; // multiplies the image seen inside a drop
  fog: number; // fog density on untouched glass
  fogTint: [number, number, number];
  lum: number; // faint self-light of the drop (dawn is luminous)
}

export const ESSENCE_WATER: [EssenceWater, EssenceWater, EssenceWater] = [
  // candle: slow, heavy, long amber tracks, low density
  {
    size: 1.3, density: 0.55, beads: 0.5, speed: 0.55, holdLo: 1.2, holdHi: 4.2, slipLo: 1.6, slipHi: 5.2, run: 0.55,
    trail: 0.55, trailStr: 0.96, tear: 1, elong: 0.1, fringe: 0, spec: 0.85, specSize: 1.15, rim: 1,
    tint: [1.12, 0.93, 0.74], fog: 0.88, fogTint: [1.13, 0.94, 0.76], lum: 0,
  },
  // chrome: fast, sharp streaks, small bright cold specular, quick stick-slip
  {
    size: 0.85, density: 0.9, beads: 0.8, speed: 1.9, holdLo: 0.12, holdHi: 0.8, slipLo: 3, slipHi: 9, run: 0.7,
    trail: 0.34, trailStr: 0.88, tear: 0.55, elong: 0.38, fringe: 0, spec: 1.5, specSize: 0.7, rim: 1.15,
    tint: [0.9, 0.97, 1.1], fog: 0.8, fogTint: [0.9, 0.98, 1.1], lum: 0,
  },
  // dawn: fine luminous mist, many tiny beads, a slight prismatic fringe
  {
    size: 0.62, density: 1.4, beads: 1.7, speed: 0.95, holdLo: 0.3, holdHi: 1.5, slipLo: 1.4, slipHi: 4, run: 0.4,
    trail: 0.3, trailStr: 0.6, tear: 0.7, elong: 0.2, fringe: 1, spec: 1.1, specSize: 0.9, rim: 0.8,
    tint: [1.06, 0.99, 1.03], fog: 0.92, fogTint: [1.08, 0.98, 1.03], lum: 0.05,
  },
];
