// Glyph path data on a 24-unit grid. Every shape is plain geometry with no presentation
// attributes except `fill="none"` for open strokes: stroke, width, cap, join and fill come from
// src/styles/glyphs.css, so one drawing serves all three essence skins.
// Classes used inside a drawing (all styled in glyphs.css):
//   gl-f     solid fill in the glyph colour, no stroke (dots, small drops)
//   gl-core  stronger wash than the default fill
//   gl-solid near-solid fill
//   gl-hair  hairline stroke at reduced opacity (bevels, facet lines)
//   gl-hi    cold highlight edge (near white, round cap)
//   gl-gilt  gilt fleck: fill from the edge colour --e
//   gl-ray   thin refracted line
//   gl-x     fine detail that fades out at 16 px (data-gs sm)
//   gl-pl    plate stroke, finer than the main stroke (stacked plates must not clog)
//   gl-lite  pale facet wash

const o = 'fill="none"'; // open stroke

export const GLYPHS = {
  // ---- interface set -------------------------------------------------------------------
  play: `<path d="M8.2 5.2 18.8 12 8.2 18.8z"/>`,
  pause: `<path d="M6.6 5h3v14h-3zM14.4 5h3v14h-3z"/>`,
  prev: `<path ${o} d="M6 5.5v13"/><path d="M18.2 6 9.2 12l9 6z"/>`,
  next: `<path ${o} d="M18 5.5v13"/><path d="M5.8 6l9 6-9 6z"/>`,
  search: `<path d="M16.4 10.4a6 6 0 1 1-12 0 6 6 0 0 1 12 0z"/><path ${o} d="M14.9 15 20 20.2"/>`,
  grid: `<path d="M4.5 4.5h5.4v5.4H4.5zM14.1 4.5h5.4v5.4h-5.4zM4.5 14.1h5.4v5.4H4.5zM14.1 14.1h5.4v5.4h-5.4z"/>`,
  list: `<path ${o} d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10"/><circle class="gl-f" cx="4.9" cy="6.5" r="1.2"/><circle class="gl-f" cx="4.9" cy="12" r="1.2"/><circle class="gl-f" cx="4.9" cy="17.5" r="1.2"/>`,
  share: `<path ${o} d="M12 14.8V4M8.2 7.8 12 4l3.8 3.8M5 12v6.2A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V12"/>`,
  copy: `<path ${o} d="M15 9V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.1A1.7 1.7 0 0 0 6.2 15H9"/><path d="M10.7 9h7.1a1.7 1.7 0 0 1 1.7 1.7v7.1a1.7 1.7 0 0 1-1.7 1.7h-7.1A1.7 1.7 0 0 1 9 17.8v-7.1A1.7 1.7 0 0 1 10.7 9z"/>`,
  link: `<g transform="rotate(-45 12 12)"><path ${o} d="M10 9.1H6.6a2.9 2.9 0 0 0 0 5.8H10M14 9.1h3.4a2.9 2.9 0 0 1 0 5.8H14M9.2 12h5.6"/></g>`,
  close: `<path ${o} d="M6 6l12 12M18 6 6 18"/>`,
  back: `<path ${o} d="M19 12H5.5M11 6.2 5.2 12l5.8 5.8"/>`,
  'chevron-down': `<path ${o} d="m6 9.5 6 6 6-6"/>`,
  external: `<path ${o} d="M10.5 5.5H6.7A1.7 1.7 0 0 0 5 7.2v10.1A1.7 1.7 0 0 0 6.7 19h10.1a1.7 1.7 0 0 0 1.7-1.7v-3.8M13.8 4.5h5.7v5.7M19.5 4.5 11.2 12.8"/>`,
  more: `<circle class="gl-f" cx="5.5" cy="12" r="1.7"/><circle class="gl-f" cx="12" cy="12" r="1.7"/><circle class="gl-f" cx="18.5" cy="12" r="1.7"/>`,
  lyrics: `<path ${o} d="M4.5 6.5h15M4.5 11.5h8M4.5 16.5h4.5"/><path ${o} d="M18 18.5V10.8l2.6 1.2"/><path d="M18 18.4a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z"/>`,
  reels: `<path d="M7.7 3.5h8.6A2.7 2.7 0 0 1 19 6.2v11.6a2.7 2.7 0 0 1-2.7 2.7H7.7A2.7 2.7 0 0 1 5 17.8V6.2a2.7 2.7 0 0 1 2.7-2.7z"/><path class="gl-core" d="M10.4 9.4 14.6 12l-4.2 2.6z"/>`,
  contact: `<path d="M5 5.5h14A2 2 0 0 1 21 7.5v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path ${o} d="m3.6 8 8.4 6.2L20.4 8"/>`,
  empty: `<path d="M12 4.2c3.7 4.1 6.2 7 6.2 10.2a6.2 6.2 0 0 1-12.4 0C5.8 11.2 8.3 8.3 12 4.2z" stroke-dasharray="0.01 3.5"/><circle class="gl-f" cx="12" cy="14.4" r="1.2"/>`,

  // ---- section set ---------------------------------------------------------------------
  'sec-picks': `<path class="gl-round" transform="translate(1.63 1.63) scale(.84)" d="M10.2 2.6 12.4 7.9 18.2 8.4 13.8 12.2 15.1 17.8 10.2 14.8 5.3 17.8 6.6 12.2 2.2 8.4 8 7.9z"/><path class="gl-f" d="M19.4 15.6c1.2 1.6 1.9 2.6 1.9 3.6a1.9 1.9 0 0 1-3.8 0c0-1 .7-2 1.9-3.6z"/>`,
  'sec-new': `<path d="M11 3.2c.7 4.6 2.2 6.1 6.8 6.8-4.6.7-6.1 2.2-6.8 6.8-.7-4.6-2.2-6.1-6.8-6.8 4.6-.7 6.1-2.2 6.8-6.8z"/><path class="gl-core" d="M18.6 15.2c.4 2.4 1.1 3.1 3.4 3.4-2.3.4-3 1.1-3.4 3.4-.4-2.3-1.1-3-3.4-3.4 2.3-.3 3-1 3.4-3.4z"/>`,
  'sec-reels': `<path ${o} d="M4 8.2V6a2 2 0 0 1 2-2h2.2M15.8 4H18a2 2 0 0 1 2 2v2.2M20 15.8V18a2 2 0 0 1-2 2h-2.2M8.2 20H6a2 2 0 0 1-2-2v-2.2"/><path class="gl-core" d="M10 8.8 15.4 12 10 15.2z"/>`,
  'sec-old': `<path d="M8 3.5h8c0 4.2-2.7 6.3-4 8.5 1.3 2.2 4 4.3 4 8.5H8c0-4.2 2.7-6.3 4-8.5C10.7 9.8 8 7.7 8 3.5z"/><path ${o} d="M6.2 3.5h11.6M6.2 20.5h11.6"/><path class="gl-f" d="M12 15.4c.9 1.1 1.5 1.8 1.5 2.5a1.5 1.5 0 0 1-3 0c0-.7.6-1.4 1.5-2.5z"/>`,

  // ---- the three essences --------------------------------------------------------------
  // heavy = a dumbbell, detox = a crescent moon, pretty = a faceted gem. Detail classes (gl-x) fade
  // out at 16 px so small sizes keep one bold idea each.
  'essence-chrome': `<path ${o} d="M2.2 12h4.4M9.4 12h5.2M17.4 12h4.4"/><path class="gl-pl gl-x" d="M4 8h.6l.6.6v6.8l-.6.6H4l-.6-.6V8.6zM20 8h-.6l-.6.6v6.8l.6.6h.6l.6-.6V8.6z"/><path class="gl-solid gl-pl" d="M7.4 6h1.2l.8.8v10.4l-.8.8H7.4l-.8-.8V6.8zM16.6 6h-1.2l-.8.8v10.4l.8.8h1.2l.8-.8V6.8z"/><path ${o} class="gl-hi" d="M7.7 16.2V7.8"/>`,
  'essence-candle': `<path d="M12.25 3.62A8.8 8.8 0 1 0 19.89 15.35 7 7 0 0 1 12.25 3.62z"/><path class="gl-core gl-x" stroke="none" d="M8.46 6.15A7 7 0 1 0 16.06 17.8 8.4 8.4 0 0 1 8.46 6.15z"/><path class="gl-gilt" d="M16.6 4.9l.55 1.3 1.3.55-1.3.55-.55 1.3-.55-1.3-1.3-.55 1.3-.55z"/>`,
  'essence-dawn': `<path d="M7 4.5h9.5l5 5L12 21 2.5 9.5z"/><path class="gl-lite gl-x" d="M2.5 9.5 7 4.5l3.8 5z"/><path class="gl-core gl-x" d="M12 21 10.8 9.5h6.4z"/><path ${o} class="gl-hair" d="M2.5 9.5h19"/><path ${o} class="gl-hair gl-x" d="M10.8 9.5 12 21"/><path ${o} class="gl-ray gl-x" d="M9 7.3 14.2 6.4"/>`,
} as const;

export type GlyphName = keyof typeof GLYPHS;

// section names the pages already use, resolved to the essence they belong to
export const GLYPH_ALIASES = {
  heavy: 'essence-chrome',
  pretty: 'essence-dawn',
  detox: 'essence-candle',
  candle: 'essence-candle',
  chrome: 'essence-chrome',
  dawn: 'essence-dawn',
  'sec-heavy': 'essence-chrome',
  'sec-pretty': 'essence-dawn',
  'sec-detox': 'essence-candle',
} as const;

export type GlyphAlias = keyof typeof GLYPH_ALIASES;
export type GlyphRef = GlyphName | GlyphAlias;

export const resolveGlyph = (n: GlyphRef): GlyphName =>
  (n in GLYPH_ALIASES ? GLYPH_ALIASES[n as GlyphAlias] : n) as GlyphName;

export const isGlyph = (n: string): n is GlyphRef => n in GLYPHS || n in GLYPH_ALIASES;

// one pearl-to-rose gradient for the dawn fill; objectBoundingBox so it fits every shape
const DEFS = `<defs><linearGradient id="gl-pearl" x1="0.15" y1="0" x2="0.85" y2="1"><stop offset="0" stop-color="#ffe9ee" stop-opacity=".85"/><stop offset=".55" stop-color="#f8c6d4" stop-opacity=".7"/><stop offset="1" stop-color="#f2a8c0" stop-opacity=".55"/></linearGradient></defs>`;

export const spriteMarkup = (): string =>
  `<svg class="glyph-sprite" width="0" height="0" aria-hidden="true" focusable="false">${DEFS}` +
  Object.entries(GLYPHS).map(([k, v]) => `<symbol id="gl-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('') +
  `</svg>`;
