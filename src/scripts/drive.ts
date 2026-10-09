// Shared state between the audio (writer) and the visuals (readers). Plain numbers,
// read once per frame, so neither side calls into the other.
export const drive = {
  rain: 0.32, // droplet density 0..1
  speed: 1, // how fast drops slide
  flash: 0, // light hit on the glass, 0..1
  tint: [0.79, 0.81, 0.84] as [number, number, number], // accent of whatever is playing
  pulse: 0, // low-end energy 0..1, for DOM glows
};

export const IDLE = { rain: 0.32, speed: 1 };

export const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
