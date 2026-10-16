// Shared state between the audio (writer) and the visuals (readers). Plain numbers,
// read once per frame, so neither side calls into the other.
export const drive = {
  rain: 0.4, // droplet density 0..1
  speed: 1.25, // how fast drops slide
  flash: 0, // light hit on the glass, 0..1
  tint: [0.79, 0.81, 0.84] as [number, number, number], // accent of whatever is playing
  pulse: 0, // low-end energy 0..1, for DOM glows
  dye: 0, // how far the velvet takes the colour of what's playing, 0..1; 0 while silent
};

export const IDLE = { rain: 0.4, speed: 1.25 };

// curation.json "velvetTint" sets how hard the velvet takes the playing track's colour.
// ?velvet=off|little|more|alot tries another level on the live site for the rest of the tab;
// ?velvet=default goes back to the curated one
export const DYE_LEVELS: Record<string, number> = { off: 0, little: 0.3, more: 0.6, alot: 1 };

export const dyeLevel = (curated: string): number => {
  const key = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  let level = key(curated);
  try {
    const asked = key(new URLSearchParams(location.search).get('velvet'));
    if (asked in DYE_LEVELS) sessionStorage.setItem('velvet', asked);
    else if (asked === 'default') sessionStorage.removeItem('velvet');
    level = key(sessionStorage.getItem('velvet')) || level;
  } catch {
    /* storage blocked: the curated level stands */
  }
  return DYE_LEVELS[level] ?? DYE_LEVELS.little;
};

export const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
