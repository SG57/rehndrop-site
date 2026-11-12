// The calm map: a tiny low-resolution mask of where text sits on the screen. The water pass reads
// it as a texture to hold back specular dots, bead highlights and haze lift, and to dim the scene
// softly behind small type, so the type keeps its contrast while the rest of the pane stays lush.
//
// Cost: the mask is at most 160 x 90 texels, built from a few dozen element rectangles with the 2D
// canvas (no per-pixel loops, no pixel readback), rebuilt about 4 times a second and, while the page
// scrolls, at a modest rate plus once when the scroll settles. The GL side uploads it as one small
// luminance texture and crossfades from the previous map, so the dim never pops.

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
  idleEvery: 0.25, // seconds between rebuilds while the page sits still
  scrollEvery: 0.1, // seconds between rebuilds while it scrolls
  settle: 0.05, // seconds after the last scroll event that count as "settled": one final rebuild
  fade: 0.12, // seconds the previous map takes to give way to the new one
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

export interface CalmHandle {
  canvas: HTMLCanvasElement;
  /** increments whenever the map has been redrawn */
  version(): number;
  /** rebuild now if anything moved (for a still pane, which has no frame loop to tick) */
  refresh(): boolean;
  /** call from the frame loop: rebuilds when due, returns true if the map changed */
  tick(nowSec: number): boolean;
  stop(): void;
}

export function startCalm(): CalmHandle {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  let ver = 0;
  let w = 0;
  let h = 0;
  let lastBuild = -1e9;
  let lastScroll = -1e9;
  let settleDue = false;
  let nowSec = 0;

  const size = () => {
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;
    const k = Math.min(CALM.maxSide, 160) / Math.max(vw, vh);
    const nw = Math.max(8, Math.min(160, Math.round(vw * k)));
    const nh = Math.max(8, Math.min(160, Math.round(vh * k)));
    if (nw !== w || nh !== h) {
      w = cv.width = nw;
      h = cv.height = nh;
    }
  };

  // one box per rendered line of text (Range rects over the text nodes), not the element boxes: a
  // block is often far wider than its words and would darken a slab of empty glass
  const rects: number[] = [];
  const range = document.createRange();
  const collect = () => {
    rects.length = 0;
    const els = document.querySelectorAll(CALM_SELECTORS);
    const vh = innerHeight;
    const vw = innerWidth;
    const m = CALM.skirtX + CALM.skirtY;
    for (let i = 0; i < els.length && rects.length < 4 * 400; i++) {
      const el = els[i];
      const eb = el.getBoundingClientRect();
      if (eb.width < 2 || eb.height < 2) continue;
      if (eb.bottom < -m || eb.top > vh + m || eb.right < -m || eb.left > vw + m) continue;
      // a short single-line label: its own box is barely wider than its words and is what the
      // legibility audit measures, so the zone covers the box; anything larger goes by the line
      if (eb.width <= 260 && eb.height <= 34) {
        rects.push(eb.left, eb.top, eb.right, eb.bottom);
        continue;
      }
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n && rects.length < 4 * 400; n = tw.nextNode()) {
        if (!(n.nodeValue ?? '').trim()) continue;
        range.selectNodeContents(n);
        const cl = range.getClientRects();
        for (let k = 0; k < cl.length; k++) {
          const r = cl[k];
          if (r.width < 2 || r.height < 2) continue;
          if (r.bottom < -m || r.top > vh + m || r.right < -m || r.left > vw + m) continue;
          rects.push(r.left, r.top, r.right, r.bottom);
        }
      }
    }
  };

  // each rectangle is drawn far off to the left and its shadow is pulled back onto the map:
  // the canvas feathers it (shadowBlur is a gaussian of about half its value), with no filter
  // support needed. Two layers per line: a firm core that carries the contrast, and a wide faint
  // skirt that lets the dim fall away like depth instead of ending at a box edge
  const OFF = 4096;
  const layer = (padX: number, padY: number, blur: number, alpha: number, sx: number, sy: number) => {
    if (!g) return;
    g.shadowColor = `rgba(255,255,255,${alpha})`;
    g.shadowBlur = Math.max(1, blur * Math.min(sx, sy));
    for (let i = 0; i < rects.length; i += 4) {
      const x0 = (rects[i] - padX) * sx;
      const y0 = (rects[i + 1] - padY) * sy;
      const x1 = (rects[i + 2] + padX) * sx;
      const y1 = (rects[i + 3] + padY) * sy;
      g.fillRect(x0 - OFF, y0, x1 - x0, y1 - y0);
    }
  };

  // a cheap signature of what was last drawn: an idle page re-checks the rectangles a few times a
  // second but redraws and re-uploads only when one of them has moved by a pixel or more
  let sig = -1;
  const build = (): boolean => {
    if (!g) return false;
    size();
    collect();
    let h32 = (w * 31 + h) | 0;
    for (let i = 0; i < rects.length; i++) h32 = (Math.imul(h32, 31) + Math.round(rects[i])) | 0;
    if (h32 === sig) return false;
    sig = h32;
    const sx = w / innerWidth;
    const sy = h / innerHeight;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.shadowBlur = 0;
    g.shadowColor = 'rgba(0,0,0,0)';
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighten';
    g.shadowOffsetX = OFF;
    g.shadowOffsetY = 0;
    g.fillStyle = '#fff';
    layer(CALM.skirtX, CALM.skirtY, CALM.skirtBlur, CALM.skirtAlpha, sx, sy);
    layer(CALM.coreX, CALM.coreY, CALM.coreBlur, 1, sx, sy);
    ver++;
    return true;
  };

  const onScroll = () => {
    lastScroll = nowSec;
    settleDue = true;
  };
  const onResize = () => {
    lastBuild = -1e9;
    sig = -1;
  };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onResize, { passive: true });

  return {
    canvas: cv,
    version: () => ver,
    refresh: () => build(),
    tick(t) {
      nowSec = t;
      const scrolling = t - lastScroll < CALM.settle;
      const every = scrolling ? CALM.scrollEvery : CALM.idleEvery;
      const settled = settleDue && !scrolling;
      if (settled || t - lastBuild >= every) {
        if (settled) settleDue = false;
        lastBuild = t;
        return build();
      }
      return false;
    },
    stop() {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onResize);
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
float calmAt(vec2 p){
  float r = mix(texture2D(uK, p).r, texture2D(uL, p).r, uC.x);
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
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class CalmGL {
  private gl: WebGLRenderingContext;
  private map: CalmHandle;
  private prev: WebGLTexture;
  private cur: WebGLTexture;
  private at = -1e9; // seconds when the current map was uploaded
  lastMs = 0; // cost of the last map upload (the canvas is drawn in tick, which has its own cost)
  maxMs = 0;
  private off = false; // ?calm=0 turns the calm grade off (A/B measurements)

  constructor(gl: WebGLRenderingContext) {
    this.gl = gl;
    try {
      this.off = new URLSearchParams(location.search).get('calm') === '0';
    } catch {
      /* no location: stays on */
    }
    this.map = startCalm();
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
    };
    gl.useProgram(prog);
    gl.uniform1i(locs.k, 3);
    gl.uniform1i(locs.l, 4);
    return locs;
  }

  /**
   * once per frame, before the pass that reads the map: rebuild and upload when due, bind both
   * textures. A still pane (reduced motion, frozen clock) has no frame loop: the scene redraws it
   * after layout changes and when a scroll settles, and the map is rebuilt on each such draw.
   */
  prepare(nowSec: number, still: boolean) {
    const gl = this.gl;
    if (!this.off && (still ? this.map.refresh() : this.map.tick(nowSec))) {
      const t0 = performance.now();
      const t = this.prev;
      this.prev = this.cur;
      this.cur = t;
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.cur);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // map row 0 is the top of the screen; GL v = 1 is the top
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.map.canvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.at = nowSec;
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
    const x = dead || still ? 1 : clamp01((nowSec - this.at) / CALM.fade);
    gl.uniform4f(locs.c, x, CALM_USE.fog, drops ? CALM_USE.spec : 0, CALM_USE.drop);
    gl.uniform4f(locs.d, dead ? 0 : dsum / wsum, CALM_USE.cap, dead ? 0 : CALM_USE.capAmt, 0);
  }

  canvas() {
    return this.map.canvas;
  }

  builds() {
    return this.map.version();
  }

  dispose() {
    this.map.stop();
    this.gl.deleteTexture(this.prev);
    this.gl.deleteTexture(this.cur);
  }
}
