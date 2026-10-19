// Time and noise for decorative code. Everything decorative reads the wall clock through
// here and draws its variation from seeded hashes, never Math.random, so a frame is a pure
// function of time and input. ?t=<unix ms> freezes the clock for reproducible screenshots.

const pinned = (() => {
  try {
    const v = new URLSearchParams(location.search).get('t');
    const n = v === null || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
})();

export const frozen = pinned !== null;

export const wallNow = () => pinned ?? Date.now();

// FNV-1a, 32 bit
export const hash32 = (key: string | number) => {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// mulberry32: a small, fast, seeded generator in [0, 1)
export const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
