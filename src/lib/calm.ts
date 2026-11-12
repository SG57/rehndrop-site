// The calm map: a small low-resolution mask of where text sits. The scene composite reads it as a
// texture to hold back specular dots, bead highlights and haze lift, and to dim the scene softly
// behind small type, so the type keeps its contrast while the rest of the pane stays lush.
//
// The map has two layers in one texture. The scrolling layer covers CALM.span viewport heights of
// the DOCUMENT around the viewport and remembers the scroll position it was built at; the shader
// slides it by the scroll since then, which is exactly what the page does to non-fixed content, so a
// pool stays locked to its text at any scroll speed with no rebuild. The fixed layer is viewport
// space and never slides: position fixed elements and sticky elements while they are stuck.
//
// Cost: a few hundred texels wide at most (160), at most 4 viewport heights tall, built from a few
// dozen element rectangles with the 2D canvas (no per-pixel loops, no pixel readback). It is rebuilt
// only when the layout changes (checked about 4 times a second) or when the slide nears the edge of
// the covered range. The GL side uploads it as one luminance texture and crossfades a rebuild from the
// previous map; the crossfade never carries the motion.

// text that floats on the scene (the same list scripts/legibility.mjs audits, plus the text blocks)
export const CALM_SELECTORS = [
  '.top-link', '.chip', '.bio', '.spot.is-current .spot-title', '.spot.is-current .spot-answer',
  '.spot.is-current .spot-note', '.stage-contact', '.ix-h', '.ix-pick', '.tv-label', '.ix-item .ix-title',
  '.ix-item .ix-sub', '.poster-title', '.poster-sub', '.lyric', '.contact-links', '.contact-mail',
  '.foot-line', '.track-title', '.track-info .spot-note', '.track-meta', '.scrub-time', '.tv-quote',
  '.tv-lyrics-text', '.sheet-links a',
].join(',');

export const CALM = {
  maxSide: 128, // texels along the longer viewport side (never above 160)
  coreX: 8, // CSS px the firm core reaches past a line of text sideways
  coreY: 5, // ... and up and down
  coreBlur: 84, // CSS px of feather on the core
  skirtX: 40, // the faint skirt
  skirtY: 30,
  skirtBlur: 80,
  skirtAlpha: 0.12,
  idleEvery: 0.25, // seconds between layout checks (while still and while scrolling)
  fade: 0.12, // seconds the previous map takes to give way to a rebuilt one (never applied to motion)
  span: 2.4, // viewport heights of document the scrolling layer covers (rebuild cost grows with it)
  before: 0.7, // of which this many sit above the top of the viewport when it is built
  rebuildAt: 0.65, // viewport heights of slide that trigger a rebuild; the layer is valid to 0.7 either way
  maxRects: 900,
  gap: 2, // black texel rows between the scrolling layer and the fixed layer
};

// how the water composite uses the map (per essence: candle, chrome, dawn; mixed by the swell)
export const CALM_USE = {
  dim: [0.13, 0.13, 0.17] as [number, number, number], // darkening of the scene inside a calm zone
  cap: 0.09, // relative luminance the scene is softly held near inside a calm zone (a harmonic soft clip)
  capAmt: 0.9, // how firmly: the scene is trimmed there, never crushed
  fog: 0.55, // how much of the haze lift and the wet meniscus a calm zone removes
  spec: 0.75, // how much a calm zone caps a drop's specular, caustic and rim light (the drop stays lit)
  drop: 0, // how much a drop's own body brightness is trimmed in a calm zone
};

// global exposure of the scene itself, per essence (candle, chrome, dawn): neutral. The legibility
// work is done locally by the calm grade, never by dimming the whole pane
export const EXPOSURE: [number, number, number] = [1, 1, 1];

export interface CalmGeom {
  w: number; // map width in texels
  rows: number; // all rows: the scrolling layer, a black gap, the fixed layer
  sRows: number; // rows of the scrolling layer (CALM.span viewport heights of the document)
  fRows: number; // rows of the fixed layer (one viewport height)
  vw: number; // CSS px of the viewport the map is laid out for
  vh: number;
}

export interface CalmHandle {
  canvas: HTMLCanvasElement;
  /** increments whenever the map has been redrawn */
  version(): number;
  /** window.scrollY when the map was last drawn: the scrolling layer is anchored to it */
  builtAt(): number;
  /** true when the last map has anything in its fixed layer */
  hasFixed(): boolean;
  /** seconds the previous map should take to give way to the last build (0: switch at once) */
  fade(): number;
  geom(): CalmGeom;
  /** how many rebuilds each cause has made (audit numbers) */
  why(): { shape: number; window: number; sticky: number; layout: number };
  /** rebuild now if anything moved (for a still pane, which has no frame loop to tick) */
  refresh(): boolean;
  /** call from the frame loop: rebuilds when due, returns true if the map changed */
  tick(nowSec: number): boolean;
  stop(): void;
}

type Sticky = { el: Element; top: number; stuck: boolean };

export function startCalm(view?: () => [number, number]): CalmHandle {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  const geo: CalmGeom = { w: 8, rows: 24, sRows: 8, fRows: 8, vw: 1, vh: 1 };
  let ver = 0;
  let built = false;
  let builtSy = 0;
  let builtTop = 0; // document y of the top row of the scrolling layer
  let hasFix = false;
  let lastFade: number = CALM.fade;
  let lastCheck = -1e9;
  let lastSy = Number.NaN;
  let resized = true;
  let sig = -1;
  let checks = 0;
  let dirty = false; // the page's classes, hidden flags or nodes changed since the last full pass
  let timer = 0; // a pending off-frame collect for a new window
  let staged: { sy: number; top: number } | null = null; // a collected window waiting to be drawn
  const why = { shape: 0, window: 0, sticky: 0, layout: 0 };

  // sizes the map to the viewport (the canvas CSS box when given: that is what the shader's uv spans);
  // true when the shape changed. Changing the size clears the canvas
  const layout = (): boolean => {
    const v = view?.();
    const vw = Math.max(1, v?.[0] || innerWidth || 1);
    const vh = Math.max(1, v?.[1] || innerHeight || 1);
    const k = Math.min(CALM.maxSide, 160) / Math.max(vw, vh);
    const w = Math.max(8, Math.min(160, Math.round(vw * k)));
    const sRows = Math.max(8, Math.round(CALM.span * vh * k));
    const fRows = Math.max(8, Math.round(vh * k));
    const rows = sRows + CALM.gap + fRows;
    const same = w === geo.w && rows === geo.rows && sRows === geo.sRows && vw === geo.vw && vh === geo.vh;
    geo.vw = vw;
    geo.vh = vh;
    if (same && cv.width === w) return false;
    geo.w = cv.width = w;
    cv.height = rows;
    geo.rows = rows;
    geo.sRows = sRows;
    geo.fRows = fRows;
    return true;
  };

  // Rectangles in two lists: the scrolling layer in DOCUMENT coordinates (it moves with the page), the
  // fixed layer in viewport coordinates (position: fixed, and sticky elements while they are stuck).
  // One box per rendered line of text (Range rects over the text nodes), not the element boxes: a
  // block is often far wider than its words and would darken a slab of empty glass.
  // Each measured element is kept as an item (its boxes in viewport coordinates at the scroll it was
  // measured at), so a sticky element that sticks or lets go is re-measured alone, not the whole page.
  type Item = { el: Element; owner: number; fixed: boolean; sy: number; r: number[] };
  const sRects: number[] = [];
  const fRects: number[] = [];
  let items: Item[] = [];
  let stickies: Sticky[] = [];
  const root = document.documentElement;
  const range = document.createRange();
  const pos = new Map<Element, string>();

  const posOf = (el: Element) => {
    let p = pos.get(el);
    if (p === undefined) {
      p = getComputedStyle(el).position;
      pos.set(el, p);
    }
    return p;
  };
  const stuckNow = (s: Sticky) => Math.abs(s.el.getBoundingClientRect().top - s.top) < 1.5;
  // index of a sticky element in `stickies` (added on first sight), or -1 when it has no top offset to track
  const stickyIndex = (el: Element) => {
    for (let i = 0; i < stickies.length; i++) if (stickies[i].el === el) return i;
    const top = parseFloat(getComputedStyle(el).top);
    if (!Number.isFinite(top)) return -1;
    const s: Sticky = { el, top, stuck: false };
    s.stuck = stuckNow(s);
    stickies.push(s);
    return stickies.length - 1;
  };

  // lo..hi: the part of the page (viewport coordinates now) worth keeping; null keeps everything
  const measure = (el: Element, sy: number, lo: number, hi: number, cull: boolean): Item | null => {
    const vw = geo.vw;
    const vh = geo.vh;
    const m = CALM.skirtX + CALM.skirtY;
    const eb = el.getBoundingClientRect();
    if (eb.width < 2 || eb.height < 2) return null;
    if (eb.right < -m || eb.left > vw + m) return null;
    if (cull && (eb.bottom < Math.min(lo, -m) || eb.top > Math.max(hi, vh + m))) return null;
    let fixed = false;
    let sticky: Element | null = null;
    for (let a: Element | null = el; a && a !== root; a = a.parentElement) {
      const p = posOf(a);
      if (p === 'fixed') {
        fixed = true;
        break;
      }
      if (p === 'sticky' && !sticky) sticky = a;
    }
    const it: Item = { el, owner: !fixed && sticky ? stickyIndex(sticky) : -1, fixed, sy, r: [] };
    const keep = (l: number, t: number, r: number, b: number) => {
      if (r < -m || l > vw + m) return;
      if (cull && (b < Math.min(lo, -m) || t > Math.max(hi, vh + m))) return;
      it.r.push(l, t, r, b);
    };
    // a short single-line label: its own box is barely wider than its words and is what the
    // legibility audit measures, so the zone covers the box; anything larger goes by the line
    if (eb.width <= 260 && eb.height <= 34) {
      keep(eb.left, eb.top, eb.right, eb.bottom);
    } else {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (!(n.nodeValue ?? '').trim()) continue;
        range.selectNodeContents(n);
        const cl = range.getClientRects();
        for (let k = 0; k < cl.length; k++) {
          const r = cl[k];
          if (r.width < 2 || r.height < 2) continue;
          keep(r.left, r.top, r.right, r.bottom);
        }
      }
    }
    return it.r.length ? it : null;
  };

  // the scrolling range with its margin, in viewport coordinates at scroll `sy`
  const rangeAt = (topDoc: number, sy: number): [number, number] => {
    const m = CALM.skirtX + CALM.skirtY;
    return [topDoc - m - sy, topDoc + CALM.span * geo.vh + m - sy];
  };

  const collect = (topDoc: number, sy: number) => {
    items = [];
    stickies = [];
    const [lo, hi] = rangeAt(topDoc, sy);
    const els = document.querySelectorAll(CALM_SELECTORS);
    let n = 0;
    for (let i = 0; i < els.length && n < CALM.maxRects; i++) {
      const it = measure(els[i], sy, lo, hi, true);
      if (it) {
        items.push(it);
        n += it.r.length / 4;
      }
    }
  };

  // items to the two layers: fixed ones, and sticky ones while stuck, keep viewport coordinates; the
  // rest are converted to document coordinates with the scroll they were measured at
  const sortLists = () => {
    sRects.length = 0;
    fRects.length = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = it.r;
      if (it.fixed || (it.owner >= 0 && stickies[it.owner].stuck)) {
        for (let k = 0; k < r.length; k++) fRects.push(r[k]);
      } else {
        for (let k = 0; k < r.length; k += 4) sRects.push(r[k], r[k + 1] + it.sy, r[k + 2], r[k + 3] + it.sy);
      }
    }
  };

  const itemHash = (it: Item) => {
    const doc = !(it.fixed || (it.owner >= 0 && stickies[it.owner].stuck));
    let h = it.r.length;
    for (let k = 0; k < it.r.length; k++) {
      const v = it.r[k] + (doc && (k & 1) === 1 ? it.sy : 0);
      h = (Math.imul(h, 31) + Math.round(v)) | 0;
    }
    return h;
  };
  // the cheap check between full ones: only the elements around the viewport are measured again and
  // compared with what was drawn (a full pass over the whole range runs every few checks)
  const nearChanged = (sy: number): boolean => {
    const vh = geo.vh;
    const [lo, hi] = rangeAt(builtTop, sy);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.fixed && !(it.owner >= 0 && stickies[it.owner].stuck)) {
        const top = it.r[1] + it.sy;
        if (top < sy - 1.2 * vh || top > sy + 2.2 * vh) continue;
      }
      const fresh = measure(it.el, sy, lo, hi, true);
      if (!fresh || itemHash(fresh) !== itemHash(it)) return true;
    }
    return false;
  };

  // a cheap signature of what the layers hold: a still page re-checks the rectangles a few times a
  // second but redraws and re-uploads only when one of them has moved by a pixel or more
  const signature = () => {
    sortLists();
    let h32 = (geo.w * 31 + geo.rows) | 0;
    for (let i = 0; i < sRects.length; i++) h32 = (Math.imul(h32, 31) + Math.round(sRects[i])) | 0;
    h32 = (Math.imul(h32, 17) + 1) | 0;
    for (let i = 0; i < fRects.length; i++) h32 = (Math.imul(h32, 31) + Math.round(fRects[i])) | 0;
    return h32;
  };

  // each rectangle is drawn far off to the left and its shadow is pulled back onto the map:
  // the canvas feathers it (shadowBlur is a gaussian of about half its value), with no filter
  // support needed. Two layers per line: a firm core that carries the contrast, and a wide faint
  // skirt that lets the dim fall away like depth instead of ending at a box edge
  const OFF = 4096;
  const layer = (
    list: number[], top0: number, base: number, n: number, sx: number, sy: number,
    padX: number, padY: number, blur: number, alpha: number,
  ) => {
    if (!g) return;
    g.shadowColor = `rgba(255,255,255,${alpha})`;
    const bl = Math.max(1, blur * Math.min(sx, sy));
    g.shadowBlur = bl;
    for (let i = 0; i < list.length; i += 4) {
      const x0 = (list[i] - padX) * sx;
      const y0 = (list[i + 1] - padY - top0) * sy + base;
      const x1 = (list[i + 2] + padX) * sx;
      const y1 = (list[i + 3] + padY - top0) * sy + base;
      if (y1 + 2 * bl < base || y0 - 2 * bl > base + n) continue;
      g.fillRect(x0 - OFF, y0, x1 - x0, y1 - y0);
    }
  };
  // a region is clipped to its own rows, so the feather of one layer never leaks into the other
  const region = (list: number[], top0: number, base: number, n: number, sx: number, sy: number) => {
    if (!g || !list.length) return;
    g.save();
    g.beginPath();
    g.rect(0, base, geo.w, n);
    g.clip();
    layer(list, top0, base, n, sx, sy, CALM.skirtX, CALM.skirtY, CALM.skirtBlur, CALM.skirtAlpha);
    layer(list, top0, base, n, sx, sy, CALM.coreX, CALM.coreY, CALM.coreBlur, 1);
    g.restore();
  };

  // paints the current items. A new window (`recentre`) collects the page around `sy` and anchors the
  // scrolling layer there; otherwise the items and the anchor stay as they are
  const draw = (sy: number, fade: number, recentre: boolean): boolean => {
    if (!g) return false;
    pos.clear(); // computed positions are re-read on each new window; the cheap checks between reuse them
    if (recentre) {
      builtSy = sy;
      builtTop = sy - CALM.before * geo.vh;
      collect(builtTop, sy);
    }
    sig = signature();
    hasFix = fRects.length > 0;
    lastFade = fade;
    built = true;
    const sx = geo.w / geo.vw;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.shadowBlur = 0;
    g.shadowColor = 'rgba(0,0,0,0)';
    g.fillStyle = '#000';
    g.fillRect(0, 0, geo.w, geo.rows);
    g.globalCompositeOperation = 'lighten';
    g.shadowOffsetX = OFF;
    g.shadowOffsetY = 0;
    g.fillStyle = '#fff';
    region(sRects, builtTop, 0, geo.sRows, sx, geo.sRows / (CALM.span * geo.vh));
    region(fRects, 0, geo.sRows + CALM.gap, geo.fRows, sx, geo.fRows / geo.vh);
    ver++;
    return true;
  };

  // a sticky element that has stuck or let go since the last build changes layer: that must show on
  // the very frame it happens, so these few elements are read each time the page has moved. Only
  // their own items are measured again
  const flipStickies = (sy: number): boolean => {
    let any = false;
    for (let i = 0; i < stickies.length; i++) {
      const s = stickies[i];
      const now = stuckNow(s);
      if (now === s.stuck) continue;
      s.stuck = now;
      any = true;
      const redo = items.filter((it) => it.owner === i);
      items = items.filter((it) => it.owner !== i);
      for (const old of redo) {
        const it = measure(old.el, sy, 0, 0, false);
        if (it) items.push(it);
      }
    }
    return any;
  };

  const onResize = () => {
    resized = true;
  };
  addEventListener('resize', onResize, { passive: true });
  // elements that start (or stop) matching a selector are found through this, not by polling: it only
  // raises a flag, and the next layout check does the full pass
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          dirty = true;
        })
      : null;
  mo?.observe(document.body ?? root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden'],
  });
  layout();

  // a new window is collected in its own task, not in the frame that found it due: the old map keeps
  // drawing meanwhile (it is valid a little past the trigger), and the next frame only paints it
  const stageWindow = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (!built || resized) return;
      const sy = scrollY;
      const top = sy - CALM.before * geo.vh;
      collect(top, sy);
      staged = { sy, top };
    }, 0);
  };

  const tick = (t: number, force = false): boolean => {
    if (!g) return false;
    const sy = scrollY;
    const moved = sy !== lastSy;
    lastSy = sy;
    if (!built) {
      layout();
      resized = false;
      lastCheck = t;
      staged = null;
      return draw(sy, 0, true);
    }
    if (resized) {
      resized = false;
      lastCheck = t;
      if (layout()) {
        why.shape++;
        staged = null;
        return draw(sy, 0, true); // the old map has another shape: no crossfade
      }
    }
    if (staged) {
      const w = staged;
      staged = null;
      builtSy = w.sy;
      builtTop = w.top;
      lastCheck = t;
      why.window++;
      return draw(sy, 0, false); // collected off-frame; only the paint is left
    }
    if (Math.abs(sy - builtSy) > CALM.rebuildAt * geo.vh) {
      if (!force) {
        stageWindow();
        return false;
      }
      lastCheck = t;
      why.window++;
      return draw(sy, 0, true); // a still pane has no frames to spread the work over
    }
    if (moved && stickies.length && flipStickies(sy)) {
      lastCheck = t;
      why.sticky++;
      if (signature() === sig) return false; // changed layer, same picture: nothing to repaint
      return draw(sy, 0, false);
    }
    if (force || t - lastCheck >= CALM.idleEvery) {
      lastCheck = t;
      if (layout()) {
        why.shape++;
        return draw(sy, 0, true); // the pane changed shape without a resize event
      }
      if (force || dirty || ++checks % 8 === 0) {
        dirty = false;
        collect(builtTop, sy); // a full pass: finds elements that appeared or moved out of the near zone
        if (signature() !== sig) {
          why.layout++;
          return draw(sy, CALM.fade, false);
        }
      } else if (nearChanged(sy)) {
        collect(builtTop, sy);
        why.layout++;
        return draw(sy, CALM.fade, false);
      }
    }
    return false;
  };

  return {
    canvas: cv,
    version: () => ver,
    builtAt: () => builtSy,
    hasFixed: () => hasFix,
    fade: () => lastFade,
    geom: () => geo,
    why: () => why,
    refresh: () => tick(lastCheck + 1e3, true),
    tick,
    stop() {
      removeEventListener('resize', onResize);
      mo?.disconnect();
      if (timer) clearTimeout(timer);
      timer = 0;
      staged = null;
    },
  };
}

// ----------------------------------------------------------------------------- the GL side ----
// Shared by the scene's plain blit and the water composite, so the dim holds whichever of the two is
// on the canvas (the water pass is dropped on a starved machine; the calm map must outlive it).
// Texture units 3 and 4 hold the previous and current map; both passes rebind them every frame.

export const CALM_GLSL = `
uniform sampler2D uK,uL; // previous and current calm map
uniform vec4 uC; // x crossfade, y haze and meniscus removal, z specular removal, w drop body trim
uniform vec4 uD; // x scene dim, y luminance cap, z cap amount
uniform vec4 uM; // x,y slide of the previous and current scrolling layer (viewport heights), z rows per viewport height as a share of the texture, w 1 if a fixed layer is in use
uniform vec4 uN; // x,y top and height of the fixed layer (share of the texture), z,w clamp of the scrolling layer
float calmAt(vec2 p){
  float ys = 1. - p.y; // down from the top of the viewport, in viewport heights
  float tl = ys + ${CALM.before.toFixed(3)};
  float vl = 1. - clamp((tl + uM.y) * uM.z, uN.z, uN.w);
  float r = texture2D(uL, vec2(p.x, vl)).r;
  bool fading = uC.x < .999;
  if (fading) {
    float vk = 1. - clamp((tl + uM.x) * uM.z, uN.z, uN.w);
    r = mix(texture2D(uK, vec2(p.x, vk)).r, r, uC.x);
  }
  if (uM.w > .5) {
    float vf = 1. - (uN.x + ys * uN.y);
    float f = texture2D(uL, vec2(p.x, vf)).r;
    if (fading) f = mix(texture2D(uK, vec2(p.x, vf)).r, f, uC.x);
    r = max(r, f);
  }
  return smoothstep(.04, .5, r);
}
// a soft dim plus a soft luminance cap: the scene goes a little deeper behind small type and its
// brightest specks are held down, without any flat rectangle
vec3 calmGrade(vec3 c, float cm){
  c *= 1. - uD.x * cm;
  float lc = dot(c, vec3(.3, .59, .11));
  c /= 1. + cm * uD.z * lc / uD.y; // harmonic soft clip: dark stays nearly as it was, bright is held near the cap
  return c;
}
`;

export interface CalmLocs {
  k: WebGLUniformLocation | null;
  l: WebGLUniformLocation | null;
  c: WebGLUniformLocation | null;
  d: WebGLUniformLocation | null;
  m: WebGLUniformLocation | null;
  n: WebGLUniformLocation | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class CalmGL {
  private gl: WebGLRenderingContext;
  private map: CalmHandle;
  private prev: WebGLTexture;
  private cur: WebGLTexture;
  private at = -1e9; // seconds when the current map was uploaded
  private prevAt = 0; // window.scrollY each map was built at
  private curAt = 0;
  private prevFix = false;
  private curFix = false;
  private fadeSec: number = CALM.fade;
  private sy = 0; // window.scrollY read this frame: the one number the shader needs to keep pools on their text
  lastMs = 0; // cost of the last map upload (the canvas is drawn in tick, which has its own cost)
  maxMs = 0;
  tickMs = 0;
  buildMax = 0;
  uploads = 0;
  private off = false; // ?calm=0 turns the calm grade off (A/B measurements)

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    try {
      this.off = new URLSearchParams(location.search).get('calm') === '0';
    } catch {
      /* no location: stays on */
    }
    const cv = gl.canvas as HTMLCanvasElement;
    this.map = startCalm(() => [cv.clientWidth, cv.clientHeight]);
    this.prev = this.make();
    this.cur = this.make();
  }

  private make() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    return t;
  }

  /** point a program's sampler uniforms at units 3 and 4 and return its calm uniform locations */
  locate(prog: WebGLProgram): CalmLocs {
    const gl = this.gl;
    const locs: CalmLocs = {
      k: gl.getUniformLocation(prog, 'uK'),
      l: gl.getUniformLocation(prog, 'uL'),
      c: gl.getUniformLocation(prog, 'uC'),
      d: gl.getUniformLocation(prog, 'uD'),
      m: gl.getUniformLocation(prog, 'uM'),
      n: gl.getUniformLocation(prog, 'uN'),
    };
    gl.useProgram(prog);
    gl.uniform1i(locs.k, 3);
    gl.uniform1i(locs.l, 4);
    return locs;
  }

  /**
   * once per frame, before the pass that reads the map: rebuild and upload only when due, bind both
   * textures. A still pane (reduced motion, frozen clock) has no frame loop: the scene redraws it
   * after layout changes and when a scroll settles, and the map is rebuilt on each such draw.
   */
  prepare(nowSec: number, still: boolean) {
    const gl = this.gl;
    this.sy = window.scrollY;
    const tt = performance.now();
    const rebuilt = !this.off && (still ? this.map.refresh() : this.map.tick(nowSec));
    const t0 = performance.now();
    this.tickMs = Math.max(this.tickMs * 0.98, t0 - tt); // decaying peak: the cost of the checks and rebuilds
    if (rebuilt) this.buildMax = Math.max(this.buildMax, t0 - tt);
    if (rebuilt) {
      const t = this.prev;
      this.prev = this.cur;
      this.cur = t;
      this.prevAt = this.curAt;
      this.prevFix = this.curFix;
      this.curAt = this.map.builtAt();
      this.curFix = this.map.hasFixed();
      this.fadeSec = this.map.fade();
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.cur);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // map row 0 is the top of the screen; GL v = 1 is the top
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.map.canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.at = nowSec;
      this.uploads++;
      this.lastMs = performance.now() - t0;
      this.maxMs = Math.max(this.maxMs, this.lastMs);
    }
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.prev);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.cur);
  }

  /** set the uniforms of the program that is in use; swell weights the per-essence dim */
  uniforms(locs: CalmLocs, nowSec: number, still: boolean, swell: ArrayLike<number>, drops: boolean) {
    const gl = this.gl;
    let dsum = 0;
    let wsum = 0;
    for (let k = 0; k < 3; k++) {
      const wk = 1 + (swell[k] ?? 0);
      dsum += CALM_USE.dim[k] * wk;
      wsum += wk;
    }
    const dead = this.off;
    // only a rebuild crossfades: both maps keep sliding with the page while it does
    const x = dead || still || this.fadeSec <= 0 ? 1 : clamp01((nowSec - this.at) / this.fadeSec);
    const geo = this.map.geom();
    gl.uniform4f(locs.c, x, CALM_USE.fog, drops ? CALM_USE.spec : 0, CALM_USE.drop);
    gl.uniform4f(locs.d, dead ? 0 : dsum / wsum, CALM_USE.cap, dead ? 0 : CALM_USE.capAmt, 0);
    gl.uniform4f(
      locs.m,
      (this.sy - this.prevAt) / geo.vh,
      (this.sy - this.curAt) / geo.vh,
      geo.sRows / (CALM.span * geo.rows),
      this.curFix || (x < 1 && this.prevFix) ? 1 : 0,
    );
    gl.uniform4f(
      locs.n,
      (geo.sRows + CALM.gap) / geo.rows,
      geo.fRows / geo.rows,
      0.5 / geo.rows,
      (geo.sRows - 0.5) / geo.rows,
    );
  }

  canvas() {
    return this.map.canvas;
  }

  builds() {
    return this.map.version();
  }

  /** numbers for the audit scripts: where the scrolling layer is anchored and how it is laid out */
  debug() {
    const geo = this.map.geom();
    return {
      builds: this.map.version(),
      why: { ...this.map.why() },
      uploads: this.uploads,
      builtAt: this.curAt,
      usedSy: this.sy,
      slide: this.sy - this.curAt, // CSS px the current map is slid by in the shader
      before: CALM.before * geo.vh,
      rowsPerPx: geo.sRows / (CALM.span * geo.vh),
      rows: geo.rows,
      sRows: geo.sRows,
      fRows: geo.fRows,
      w: geo.w,
      hasFixed: this.curFix,
      lastMs: this.lastMs,
      maxMs: this.maxMs,
      tickMs: this.tickMs,
      buildMax: this.buildMax,
    };
  }

  dispose() {
    this.map.stop();
    this.gl.deleteTexture(this.prev);
    this.gl.deleteTexture(this.cur);
  }
}
