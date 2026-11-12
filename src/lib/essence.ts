// The essence model: single source of truth for the constants, the angular weights, the
// slow swell cycle, the day factor and the semantic tokens. Pure functions, no DOM and no
// clock at import time, so scripts/check_essence.mjs can load it in Node. The shader in
// scene.ts mirrors these formulas; if one changes, both change and the check script fails.

export const ESSENCES = ['candle', 'chrome', 'dawn'] as const;
export type Essence = (typeof ESSENCES)[number];
export type Triple = [number, number, number];

export const PERIOD_S = 300;
export const SOFTNESS = 1.6;
export const SWELL_CYCLE_S = 180;
export const SWELL_GAIN = 3.0;

/** Centre angle of essence i on the wheel (0, 2.0944, 4.18879 rad). */
export const centre = (i: number) => (i * 2 * Math.PI) / 3;

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** w_i = exp(SOFTNESS * (cos(angle - centre_i) - 1)) * (1 + SWELL_GAIN * swell_i), normalised to sum 1. */
export function weights(ang: number, swell: ArrayLike<number> = [0, 0, 0]): Triple {
  const w: Triple = [0, 0, 0];
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    w[i] = Math.exp(SOFTNESS * (Math.cos(ang - centre(i)) - 1)) * (1 + SWELL_GAIN * (swell[i] ?? 0));
    sum += w[i];
  }
  return [w[0] / sum, w[1] / sum, w[2] / sum];
}

/** Wheel angle at a screen point (x,y in px, y down) and time; the wheel turns once per PERIOD_S. */
export const angleAt = (x: number, y: number, vw: number, vh: number, tSec: number) =>
  Math.atan2(1 - y / vh - 0.5, (x / vw - 0.5) * (vw / vh)) + (tSec * 2 * Math.PI) / PERIOD_S;

/** The slow cycle: each essence swells in turn, one bump of sin^2 per SWELL_CYCLE_S. */
export function timeCycleSwell(tSec: number): Triple {
  const c = tSec / SWELL_CYCLE_S;
  const e = (((Math.floor(c) % 3) + 3) % 3) as 0 | 1 | 2;
  const bump = Math.sin(Math.PI * (c - Math.floor(c))) ** 2;
  const out: Triple = [0, 0, 0];
  out[e] = bump;
  return out;
}

/** 0 at night, 1 by day: smoothstep(5,8,h) * (1 - smoothstep(17,20,h)). */
export const dayFactor = (hour: number) => smoothstep(5, 8, hour) * (1 - smoothstep(17, 20, hour));

export interface EssenceToken {
  /** accent */ a: readonly [number, number, number];
  /** glass fill, rgba */ g: readonly [number, number, number, number];
  /** edge */ e: readonly [number, number, number];
  /** corner radius in px */ r: number;
  /** glow strength 0..1 */ glow: number;
}

// Radius language: candle ornate soft square, chrome sharp chamfer, dawn round.
export const ESSENCE_TOKENS: Record<Essence, EssenceToken> = {
  candle: { a: [0xd8, 0x9a, 0x4f], g: [40, 8, 14, 0.58], e: [0xb9, 0x8a, 0x3e], r: 12, glow: 0.5 },
  chrome: { a: [0x8d, 0xb1, 0xdc], g: [6, 10, 16, 0.62], e: [0x8f, 0xa3, 0xb8], r: 3, glow: 0.35 },
  dawn: { a: [0xe7, 0xb7, 0xa6], g: [70, 46, 52, 0.42], e: [0xe9, 0xd6, 0xa8], r: 26, glow: 0.8 },
};

/** Text stays constant on every essence so legibility never depends on the blend. Contrast is measured in scripts/measure_contrast.mjs. */
export const TEXT = { bone: '#e7e9ea', ink2: '#c3c7cb', ink3: '#b0b5ba' } as const;

/** The edge is painted at this alpha, as in the prototype. */
export const EDGE_ALPHA = 0.8;

export interface SkinVars {
  a: string;
  g: string;
  e: string;
  r: string;
  glow: string;
}

const mix = (w: ArrayLike<number>, pick: (t: EssenceToken) => number) =>
  w[0] * pick(ESSENCE_TOKENS.candle) + w[1] * pick(ESSENCE_TOKENS.chrome) + w[2] * pick(ESSENCE_TOKENS.dawn);
const ch = (v: number) => Math.round(v);

/** Blend the three tokens by weights into the CSS values for --a --g --e --r --glow. */
export function skinVars(w: ArrayLike<number>): SkinVars {
  const a = [0, 1, 2].map((i) => ch(mix(w, (t) => t.a[i])));
  const g = [0, 1, 2].map((i) => ch(mix(w, (t) => t.g[i])));
  const e = [0, 1, 2].map((i) => ch(mix(w, (t) => t.e[i])));
  return {
    a: `rgb(${a.join(',')})`,
    g: `rgba(${g.join(',')},${mix(w, (t) => t.g[3]).toFixed(2)})`,
    e: `rgba(${e.join(',')},${EDGE_ALPHA})`,
    r: `${mix(w, (t) => t.r).toFixed(1)}px`,
    glow: mix(w, (t) => t.glow).toFixed(2),
  };
}
