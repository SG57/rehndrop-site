// The scene: three painted plates (candle, chrome, dawn) blended by ONE fragment shader with
// soft angular weights, turning once per PERIOD_S, graded by the local hour, with small masks
// driving motion (flicker, sway, glints), a drifting prism and a swell that lets one essence
// dominate. Pass 1 renders into a framebuffer at an adaptive scale. Pass 2 is either the wet
// lens (lens.ts reads the framebuffer as its sharp source) or a plain blit.
//
// Cost model (the target machine rasterises WebGL in software). With SOFTNESS 1.6 the smallest
// raw weight is about 4% to 8%, so a plain "skip tiny weights" test never fires; the cost is
// pruned in two continuous steps instead (each fades in over a weight range, so nothing pops):
//   weight < 0.06           the essence is skipped (its share fades to 0 by 0.06, 1 by 0.12)
//   weight < 0.2            plate read plus flicker only: no noise reads, no glint sweep
//   weight >= 0.3           the full path (sway, flame warp, glints)
// In the middle of an essence its two neighbours are mostly pruned, so a pixel pays for about
// one full essence and one cheap one. Everything that does not vary per pixel (hour grade,
// flicker, aspect crop, phase) is a uniform computed once per frame on the CPU.
import { frozen, hash32, seeded, wallNow } from './clock';
import { CALM_GLSL, CalmGL, EXPOSURE, type CalmLocs } from '../lib/calm';
import { createTierProbe, detectTier, getTier, rendererString, setTier, type Tier } from '../lib/tier';
import {
  CROP_X, CROP_XP, DEG, dayFactor, FOG_DIV, FOG_EVERY, LEAN_END, NOISE, PERIOD_S, PORTRAIT_LEAN_END, PORTRAIT_LEAN_START, SCALE, SOFTNESS, SWELL_EASE_S,
  SWELL_GAIN, smoothstep, timeCycleSwell,
} from '../lib/scene-config';
import { pickSet, type SceneSet, type SetKey } from '../lib/scene-assets';

export interface SceneOptions {
  canvas: HTMLCanvasElement;
  // the landscape (l) and portrait (p) sets; each holds 3 plate urls (candle, chrome, dawn) and 3 mask urls
  // (R flame/lamp flicker, G sway, B glints). Only the set that fits the viewport is fetched.
  sets: Record<SetKey, SceneSet>;
  base: string; // prefix for urls that are not absolute
}

export interface SceneHandle {
  texture: () => WebGLTexture | null; // the scene framebuffer (the lens' sharp source)
  fogTexture: () => WebGLTexture | null; // the blurred copy (the lens' fog source)
  calm: CalmGL | null; // the calm map (where small type sits); the passes that draw to the canvas read it
  resize(): void;
  stop(): void;
  gl: WebGLRenderingContext | null;
  // the lens (or the water) registers its draw here; it runs as pass 2, inside the scene's frame.
  // onStarved runs when the scene is slow at its floor scale: the pass sheds some of its own work and
  // returns true (the scene then waits for more starved windows); false means nothing is left to shed
  // and the scene drops the pass for the plain blit. shed:false keeps the pass regardless
  setPass2(fn: ((now: number) => void) | null, opts?: { shed?: boolean; onStarved?: () => boolean }): void;
  drawn(): boolean; // true once the first frame has reached the canvas ('scene:ready' fires then)
  info(): { scale: number; width: number; height: number; renderer: string; tier: Tier; lens: boolean };
}

declare global {
  interface Window {
    __rehndrop?: Record<string, unknown>;
  }
}

const VERT = `attribute vec2 a;varying vec2 u;void main(){u=a*.5+.5;gl_Position=vec4(a,0.,1.);}`;

const PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const P1 = `${PREC}
varying vec2 u;
uniform sampler2D t0,t1,t2,m0,m1,m2,nz;
uniform vec4 uA;   // x time, y aspect, z angle phase, w day factor
uniform vec4 uB;   // xy plate uv crop, z prism on, w softness
uniform vec3 uS;   // swell per essence
uniform vec3 uX;   // plate uv x offset per essence (crop anchor)
uniform vec3 uF;   // flame flicker per essence (uniform across pixels, sampled on the CPU)
// k is the motion factor (0 = plate and flicker only, 1 = full): displacement and glints scale
// with it, so the cheap and full paths meet without a seam
vec3 scene(sampler2D P_, sampler2D Mk, float fl, float kind, vec2 uv, float k){
  vec3 m = texture2D(Mk, uv).rgb;
  float T = uA.x;
  vec2 p = uv;
  if (k > 0.) {
    if (m.g > .004) p += (texture2D(nz, uv * 1.3 + vec2(T * .012, 0.)).rg - .5) * .014 * m.g * k;
    if (m.r > .004) p += (texture2D(nz, uv * 4. + vec2(0., T * .09)).rg - .5) * .008 * m.r * k;
  }
  vec3 c = texture2D(P_, p).rgb;
  c *= 1. + m.r * (fl - 1.) * 1.5;
  if (k > 0. && m.b > .004) {
    float sweep = pow(max(0., sin((uv.x * 2.2 + uv.y * 1.4 - T * .14 + kind) * 6.28318)), 26.);
    c += m.b * sweep * vec3(1., .95, .9) * .45 * k;
  }
  return c;
}
void main(){
  float oy = .5 * (1. - uB.y);
  vec2 uv = vec2(u.x * uB.x, oy + u.y * uB.y);
  vec2 c = (u - .5) * vec2(uA.y, 1.);
  float ang = atan(c.y, c.x) + uA.z;
  vec3 w = exp(uB.w * (vec3(cos(ang), cos(ang - 2.0944), cos(ang - 4.18879)) - 1.)) * (1. + ${SWELL_GAIN.toFixed(1)} * uS);
  w /= w.x + w.y + w.z;
  vec3 k = smoothstep(.2, .3, w);
  vec3 sk = smoothstep(.06, .12, w);
  w *= sk;
  w /= w.x + w.y + w.z;
  float d = uA.w;
  vec3 col = vec3(0.);
  if (sk.x > 0.) {
    vec3 A = scene(t0, m0, uF.x, 0., uv + vec2(uX.x, 0.), k.x);
    float lum = dot(A, vec3(.3, .59, .11));
    vec3 sep = lum * vec3(1.12, .95, .75);
    A = mix(A * vec3(1.08, 1., .9), mix(A, sep, .5) * 1.05, d);
    col += A * w.x * ${EXPOSURE[0].toFixed(3)};
  }
  if (sk.y > 0.) {
    vec3 R = scene(t1, m1, uF.y, 1., uv + vec2(uX.y, 0.), k.y);
    R = mix(R * vec3(.8, .88, 1.05), R * vec3(1.02, 1.04, 1.08), d);
    col += R * w.y * ${EXPOSURE[1].toFixed(3)};
  }
  if (sk.z > 0.) {
    vec3 M = scene(t2, m2, uF.z, 2., uv + vec2(uX.z, 0.), k.z);
    M = mix(M * vec3(.74, .8, 1.08) + vec3(.02, .01, .05), M * vec3(1.1, 1.02, .86), d);
    col += M * w.z * ${EXPOSURE[2].toFixed(3)};
    if (uB.z > .5) {
      float T = uA.x;
      float b = sin((u.x * 1.3 + u.y * .7) * 6. - T * .3);
      vec3 rb = .5 + .5 * cos(6.28318 * (vec3(0., .33, .67) + u.x * .8 + T * .02));
      col += rb * .14 * (1. - .6 * d) * w.z * 1.6 * smoothstep(.2, .9, b * .5 + .5);
    }
  }
  gl_FragColor = vec4(col, 1.);
}`;

// four bilinear taps one source texel off-centre = an exact 4x4 box over the source
const P_FOG = `precision mediump float;
varying vec2 u;uniform sampler2D fb;uniform vec2 px;
void main(){
  vec3 c = texture2D(fb, u + vec2(-px.x, -px.y)).rgb + texture2D(fb, u + vec2(px.x, -px.y)).rgb
         + texture2D(fb, u + vec2(-px.x, px.y)).rgb + texture2D(fb, u + vec2(px.x, px.y)).rgb;
  gl_FragColor = vec4(c * .25, 1.);
}`;

// the plain blit (no pass 2) still grades the calm zones, so small type keeps its contrast even when
// the water pass has been shed on a starved machine
const P_BLIT = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 u;uniform sampler2D fb;
${CALM_GLSL}
void main(){gl_FragColor=vec4(calmGrade(texture2D(fb,u).rgb,calmAt(u)),1.);}`;

export function startScene(opts: SceneOptions): SceneHandle {
  const { canvas } = opts;
  const q = new URLSearchParams(location.search);
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: false, // the target machine IS the software case
  }) as WebGLRenderingContext | null;

  const root = document.documentElement;
  // an alpha:false canvas is opaque black until something is drawn: keep it hidden, so the static
  // CSS velvet stays visible until the first frame (and for good if the scene fails)
  if (gl) canvas.style.visibility = 'hidden';
  let stopped = false;
  let drawn = false;

  const swell: [number, number, number] = [0, 0, 0];
  let tier: Tier;
  if (gl) tier = detectTier(gl);
  else {
    tier = 'software';
    setTier(tier);
  }
  const renderer = rendererString(gl);
  let scale = SCALE[tier];
  let fw = 0;
  let fh = 0;
  let fbT: WebGLTexture | null = null;
  let fogT: WebGLTexture | null = null;
  let pass2: ((now: number) => void) | null = null;
  let pass2Sheds = true;
  let pass2Starved: (() => boolean) | null = null;
  let calmGl: CalmGL | null = null;
  let calmBlit: CalmLocs | null = null;
  // filled in once GL is set up; until then (or without GL) they do nothing
  const ops = { resize: () => {}, stop: () => {}, refit: () => {} };

  // every failure path ends here: back to the static CSS velvet, canvas out of the way
  const fail = (why: string) => {
    console.warn('[scene]', why);
    pass2 = null;
    stopped = true;
    ops.stop();
    root.dataset.scene = 'off';
    delete root.dataset.sceneDrawn; // the static velvet must come back: a lost context leaves nothing drawable
    root.classList.remove('lens-on');
    canvas.style.visibility = 'hidden';
  };

  const handle: SceneHandle = {
    texture: () => fbT,
    fogTexture: () => fogT,
    get calm() {
      return calmGl;
    },
    resize: () => ops.resize(),
    stop: () => ops.stop(),
    gl,
    setPass2: (fn, o) => {
      if (stopped) return; // failed or stopped: the lens must not draw into a dead scene
      pass2 = fn;
      pass2Sheds = o?.shed !== false;
      pass2Starved = o?.onStarved ?? null;
      ops.refit();
    },
    drawn: () => drawn,
    info: () => ({ scale, width: fw, height: fh, renderer, tier, lens: !!pass2 }),
  };

  // read-only snapshot for the interface layer (essence-ui reads it every 250 ms).
  // angle(t) is the rotation of the whole blend at time t (seconds); add it to a point's own
  // atan2 angle around the centre to get the angle the weights are evaluated at.
  const hourNow = () => {
    const raw = q.get('h');
    const h = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(h)) return h;
    const d = new Date(wallNow());
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  };
  const snap = {
    angle: (tSec: number) => ((((tSec % PERIOD_S) + PERIOD_S) % PERIOD_S) / PERIOD_S) * DEG,
    hour: hourNow,
    swell,
  };
  Object.defineProperty(snap, 'tier', { get: () => getTier(), enumerable: true });
  Object.defineProperty(snap, 'scale', { get: () => scale, enumerable: true });
  Object.defineProperty(snap, 'calm', { get: () => calmGl?.debug() ?? null, enumerable: true }); // audit numbers
  (window.__rehndrop ??= {}).scene = snap;

  if (!gl) return handle;

  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[scene]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const link = (fs: string) => {
    const v = sh(gl.VERTEX_SHADER, VERT);
    const f = sh(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.bindAttribLocation(p, 0, 'a');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[scene]', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  };
  const p1 = link(P1);
  const pFog = link(P_FOG);
  const pBlit = link(P_BLIT);
  if (!p1 || !pFog || !pBlit) {
    fail('shader build failed');
    return handle;
  }

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const geo = () => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  };

  const L = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const u1 = { a: L(p1, 'uA'), b: L(p1, 'uB'), s: L(p1, 'uS'), f: L(p1, 'uF'), x: L(p1, 'uX') };
  gl.useProgram(p1);
  ['t0', 't1', 't2', 'm0', 'm1', 'm2', 'nz'].forEach((n, i) => gl.uniform1i(L(p1, n), i));
  gl.useProgram(pFog);
  gl.uniform1i(L(pFog, 'fb'), 0);
  const uFogPx = L(pFog, 'px');
  gl.useProgram(pBlit);
  gl.uniform1i(L(pBlit, 'fb'), 0);
  calmGl = new CalmGL(gl);
  calmBlit = calmGl.locate(pBlit);

  const setupTex = (t: WebGLTexture, wrap: number) => {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  };
  const bind = (unit: number, t: WebGLTexture | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  };

  // ---- noise: one 128x128 repeating texture from a seeded generator, built once ----
  const N = NOISE.size;
  const nzd = new Uint8Array(N * N * 4);
  {
    const rnd = seeded(hash32(NOISE.seed));
    const S = NOISE.cells;
    const grid = () => Array.from({ length: S * S }, rnd);
    const G1 = grid();
    const G2 = grid();
    const sm = (t: number) => t * t * (3 - 2 * t);
    const at = (g: number[], a: number, b: number) => g[((((b % S) + S) % S) * S) + (((a % S) + S) % S)];
    const vn = (g: number[], x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = sm(x - xi);
      const fy = sm(y - yi);
      return at(g, xi, yi) * (1 - fx) * (1 - fy) + at(g, xi + 1, yi) * fx * (1 - fy)
        + at(g, xi, yi + 1) * (1 - fx) * fy + at(g, xi + 1, yi + 1) * fx * fy;
    };
    const cell = N / S;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const o = (y * N + x) * 4;
        nzd[o] = vn(G1, x / cell, y / cell) * 255;
        nzd[o + 1] = vn(G2, x / cell, y / cell) * 255;
        nzd[o + 2] = 128;
        nzd[o + 3] = 255;
      }
    }
  }
  const nzT = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE6);
  setupTex(nzT, gl.REPEAT);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, nzd);

  // red channel of the noise at (u, v), bilinear with wrap: the flame flicker is the same for
  // every pixel, so it is sampled here once per essence instead of once per pixel
  const noiseR = (uu: number, vv: number) => {
    const x = uu * N - 0.5;
    const y = vv * N - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const r = (a: number, b: number) => nzd[(((((b % N) + N) % N) * N) + (((a % N) + N) % N)) * 4] / 255;
    return r(x0, y0) * (1 - fx) * (1 - fy) + r(x0 + 1, y0) * fx * (1 - fy)
      + r(x0, y0 + 1) * (1 - fx) * fy + r(x0 + 1, y0 + 1) * fx * fy;
  };

  // ---- framebuffers: the scene at adaptive scale, and the lens' fog copy ----
  fbT = gl.createTexture();
  fogT = gl.createTexture();
  const fbO = gl.createFramebuffer()!;
  const fogO = gl.createFramebuffer()!;
  let fogW = 0;
  let fogH = 0;
  let fogDue = true;
  let warm = SCALE.warmStart; // probe windows to ignore (load and reallocation hitches)
  const alloc = (t: WebGLTexture, o: WebGLFramebuffer, w: number, h: number) => {
    gl.activeTexture(gl.TEXTURE0);
    setupTex(t, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, o);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  // layout is read only here (resize and ResizeObserver), never per frame
  let cw = 1;
  let ch = 1;
  let asp = 1;
  let cropX = 1;
  let cropY = 1;
  // which plate set is on screen, and its aspect: the uv crop is computed from the plates, not a constant
  let setKey: SetKey = pickSet(innerWidth, innerHeight, q.get('plates'));
  let plateAsp = opts.sets[setKey].aspect;
  const measure = () => {
    cw = canvas.clientWidth || innerWidth;
    ch = canvas.clientHeight || innerHeight;
    asp = cw / ch;
    cropX = asp > plateAsp ? 1 : asp / plateAsp;
    cropY = asp > plateAsp ? plateAsp / asp : 1;
    // narrow screens lean the crop to the art-directed detail. Portrait plates: by the horizontal slack (none at
    // 2:3, full at PORTRAIT_LEAN_END). Landscape plates on a squarish screen: full at 1:1, none from LEAN_END up
    lean = setKey === 'p' ? smoothstep(PORTRAIT_LEAN_START, PORTRAIT_LEAN_END, asp) : smoothstep(LEAN_END, 1, asp);
  };
  let lean = 0;
  const anchor = (i: number) => 0.5 + ((setKey === 'p' ? CROP_XP : CROP_X)[i] - 0.5) * lean;
  measure();
  const makeFB = () => {
    warm = Math.max(warm, SCALE.warmRealloc);
    fw = Math.max(64, Math.round(cw * scale));
    fh = Math.max(64, Math.round(ch * scale));
    alloc(fbT!, fbO, fw, fh);
    fogW = Math.max(16, Math.round(fw / FOG_DIV));
    fogH = Math.max(16, Math.round(fh / FOG_DIV));
    alloc(fogT!, fogO, fogW, fogH);
    fogDue = true;
  };
  // the canvas backing store: with the lens it is 1:1 with the scene (one scale drives both
  // costs), otherwise a cheap blit at the viewport size
  const fit = () => {
    const d = Math.min(devicePixelRatio || 1, 1);
    const w = pass2 ? fw : Math.max(1, Math.round(cw * d));
    const h = pass2 ? fh : Math.max(1, Math.round(ch * d));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  makeFB();
  fit();

  // ---- plates and masks ----
  const abs = (url: string) => (/^([a-z]+:|\/)/i.test(url) ? url : opts.base + url);
  const load = (url: string) =>
    new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.decoding = 'async';
      // decode off the thread now, so the upload later does not stall a frame
      im.onload = () => (im.decode ? im.decode().catch(() => undefined) : Promise.resolve()).then(() => res(im));
      im.onerror = () => rej(new Error(url));
      im.src = abs(url);
    });
  let texs: WebGLTexture[] = [];
  let ready = false;

  // ---- swell: events set the target, otherwise the slow time cycle ----
  let evTarget: [number, number, number] | null = null;
  const onEssence = (e: Event) => {
    const s = (e as CustomEvent<{ swell?: number[] }>).detail?.swell;
    if (s && s.length === 3) {
      evTarget = [0, 1, 2].map((i) => Math.min(1, Math.max(0, Number(s[i]) || 0))) as [number, number, number];
    }
  };
  document.addEventListener('rehndrop:essence', onEssence);

  const still = () => frozen || tier === 'reduced';
  const t0 = performance.now();
  let last = 0;
  let frames = 0;
  let acc = 0;
  let n = 0;
  let okRuns = 0;
  let raf = 0;
  const probe = createTierProbe();

  const render = (now: number, dtMs: number) => {
    const wallSec = wallNow() / 1000;
    const T = frozen ? wallSec % 1024 : (now - t0) / 1000;
    const dt = Math.min(dtMs / 1000, 0.1);

    const tgt = evTarget ?? timeCycleSwell(wallSec);
    if (still()) {
      for (let i = 0; i < 3; i++) swell[i] = tgt[i];
    } else {
      const k = 1 - Math.exp(-dt / SWELL_EASE_S);
      for (let i = 0; i < 3; i++) swell[i] += (tgt[i] - swell[i]) * k;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbO);
    gl.viewport(0, 0, fw, fh);
    gl.useProgram(p1);
    geo();
    for (let i = 0; i < 6; i++) bind(i, texs[i]);
    bind(6, nzT);
    gl.uniform4f(u1.a, T, asp, ((((wallSec % PERIOD_S) + PERIOD_S) % PERIOD_S) / PERIOD_S) * DEG, dayFactor(hourNow()));
    gl.uniform4f(u1.b, cropX, cropY, q.get('prism') === '0' ? 0 : 1, SOFTNESS);
    gl.uniform3f(u1.x, anchor(0) * (1 - cropX), anchor(1) * (1 - cropX), anchor(2) * (1 - cropX));
    gl.uniform3f(u1.s, swell[0], swell[1], swell[2]);
    gl.uniform3f(
      u1.f,
      0.78 + 0.5 * noiseR(T * 0.15, 0),
      0.78 + 0.5 * noiseR(T * 0.15 + 0.31, 0.37),
      0.78 + 0.5 * noiseR(T * 0.15 + 0.62, 0.74),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (pass2) {
      if (fogDue || frames % FOG_EVERY === 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fogO);
        gl.viewport(0, 0, fogW, fogH);
        gl.useProgram(pFog);
        geo();
        bind(0, fbT);
        gl.uniform2f(uFogPx, 1 / fw, 1 / fh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        fogDue = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      pass2(now);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(pBlit);
      geo();
      bind(0, fbT);
      if (calmGl && calmBlit) {
        calmGl.prepare(now / 1000, still());
        calmGl.uniforms(calmBlit, now / 1000, still(), swell, false);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    frames++;
    if (!drawn) {
      drawn = true;
      canvas.style.visibility = '';
      root.dataset.sceneDrawn = '1'; // CSS keeps the scene visible even if the lens pass is shed later
      document.dispatchEvent(new Event('scene:ready'));
    }
  };

  // adaptive scale: step down fast when slow, creep up when comfortably fast.
  // The rAF interval is vsync-locked, so on a 60 Hz display an idle GPU still averages ~16.7 ms
  // and a plain "under 13.5 ms" test could never pass. `best` is the fastest window seen; a
  // window within 5% of it (capped at atCapMs) counts as "at the display's cap, with room".
  let best = Infinity;
  let upNeed: number = SCALE.upRuns;
  let sinceUp = 99; // windows since the last creep-up
  let starved = 0; // consecutive windows too slow with the scale already at the floor
  const adapt = (dtMs: number) => {
    acc += Math.min(dtMs, 100);
    if (++n < SCALE.probeFrames) return;
    const avg = acc / n;
    acc = 0;
    n = 0;
    if (warm > 0) {
      warm--; // load and reallocation hitches are not steady-state cost
      return;
    }
    best = Math.min(best, avg);
    const upBelow = Math.max(SCALE.upBelowMs, Math.min(best, SCALE.atCapMs) * 1.05);
    sinceUp++;
    let next = scale;
    if (avg > SCALE.downAboveMs) {
      if (scale > SCALE.floor) {
        next = Math.max(SCALE.floor, scale * SCALE.downStep);
        if (sinceUp <= 2) upNeed = Math.min(SCALE.upRunsMax, upNeed * 2); // a bounce: be slower to try again
        starved = 0;
      } else if (++starved >= SCALE.shedWindows && pass2 && pass2Starved?.()) {
        starved = 0; // the pass shed part of its own work: give that a few windows to show
      } else if (starved >= SCALE.shedWindows && pass2 && pass2Sheds) {
        // nothing left to shed in the scene: drop the lens pass, the plain blit takes over
        pass2 = null;
        root.dataset.sceneLens = 'off';
        root.classList.remove('lens-on');
        ops.refit();
        starved = 0;
      }
      okRuns = 0;
    } else {
      starved = 0;
      if (avg < upBelow) {
        if (++okRuns >= upNeed && scale < SCALE.ceiling) {
          next = Math.min(SCALE.ceiling, scale * SCALE.upStep);
          okRuns = 0;
          sinceUp = 0;
        }
      } else okRuns = 0;
    }
    if (next !== scale) {
      scale = next;
      makeFB();
      fit();
    }
  };

  const frame = (now: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dtMs = last ? now - last : 16;
    last = now;
    const before = tier;
    if (!frozen && probe.sample(dtMs)) {
      tier = getTier();
      if (before !== tier && scale > SCALE.software) {
        scale = SCALE.software;
        makeFB();
        fit();
      }
    }
    render(now, dtMs);
    if (!frozen) adapt(dtMs);
  };

  // one frame, then (if the tier allows motion) the loop
  const kick = () => {
    if (!ready || stopped) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame((now) => {
      render(now, 16);
      if (!still()) raf = requestAnimationFrame(frame);
    });
  };

  ops.resize = () => {
    measure();
    makeFB();
    fit();
    kick();
    maybeSwap();
  };
  ops.refit = () => {
    fit();
    kick();
  };
  // size changes: re-measure once, reallocate only if the canvas really changed
  const onSize = () => {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    if (w === cw && h === ch) return;
    ops.resize();
  };
  const onVisible = () => {
    last = 0;
    acc = 0;
    n = 0;
    warm = Math.max(warm, SCALE.warmRealloc);
    probe.reset();
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    fail('context lost');
  };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onSize);
  ro?.observe(canvas);
  ops.stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('rehndrop:essence', onEssence);
    document.removeEventListener('visibilitychange', onVisible);
    removeEventListener('resize', onSize);
    canvas.removeEventListener('webglcontextlost', onLost);
    ro?.disconnect();
    stopStill();
    calmGl?.dispose();
    calmGl = null;
  };

  // a still pane has no frame loop: redraw it (which rebuilds the calm map) once a scroll settles and
  // once the fonts and the page have laid the text out
  let stillTimer = 0;
  const onStillScroll = () => {
    if (!still()) return;
    clearTimeout(stillTimer);
    stillTimer = window.setTimeout(kick, 120);
  };
  addEventListener('scroll', onStillScroll, { passive: true });
  if (document.fonts?.ready) document.fonts.ready.then(() => still() && kick());
  addEventListener('load', () => still() && kick(), { once: true });
  const stopStill = () => {
    clearTimeout(stillTimer);
    removeEventListener('scroll', onStillScroll);
  };

  addEventListener('resize', onSize, { passive: true });
  document.addEventListener('visibilitychange', onVisible);
  canvas.addEventListener('webglcontextlost', onLost);

  // upload one image into a fresh texture on unit 7, which nothing else binds. Callers run this outside the
  // frame; the pixel-store flags are put back as they were found.
  const uploadOne = (im: HTMLImageElement, isMask: boolean) => {
    const pf = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const pc = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL);
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE7);
    setupTex(t, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // masks are data, not colour: no colour-space conversion
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, isMask ? gl.NONE : gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, pf);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, pc);
    gl.activeTexture(gl.TEXTURE0);
    return t;
  };
  const loadSet = (k: SetKey) => Promise.all([...opts.sets[k].plates, ...opts.sets[k].masks].map(load));

  // a viewport that crosses the aspect threshold swaps sets. The old textures keep drawing until the
  // new set is fetched, decoded and uploaded; then one assignment swaps them (no black frame, no partial set)
  let loadingKey: SetKey | null = null;
  // a set that failed to load is not retried until the viewport wants the other one, or after a backoff
  let failedKey: SetKey | null = null;
  const RETRY_MS = 10000;
  const maybeSwap = () => {
    if (!ready || stopped || loadingKey) return;
    const want = pickSet(innerWidth, innerHeight, q.get('plates'), setKey);
    if (want === setKey) {
      failedKey = null;
      return;
    }
    if (want === failedKey) return;
    loadingKey = want;
    loadSet(want)
      .then(
        (imgs) =>
          new Promise<void>((done) => {
            // an upload costs a few ms (tens in software): one per frame, off the draw, then commit all six at once
            const fresh: WebGLTexture[] = [];
            const step = () => {
              if (stopped) return done();
              if (fresh.length < imgs.length) {
                fresh.push(uploadOne(imgs[fresh.length], fresh.length >= 3));
                requestAnimationFrame(step);
                return;
              }
              const old = texs;
              texs = fresh;
              setKey = want;
              plateAsp = opts.sets[want].aspect;
              measure();
              old.forEach((t) => gl.deleteTexture(t));
              if (still()) kick();
              done();
            };
            requestAnimationFrame(step);
          }),
      )
      .catch(() => {
        // keep drawing the set that is on screen; one retry after a backoff
        failedKey = want;
        setTimeout(() => {
          if (failedKey === want) failedKey = null;
          maybeSwap();
        }, RETRY_MS);
      })
      .then(() => {
        loadingKey = null;
        maybeSwap(); // the viewport may have flipped again while this set loaded
      });
  };

  loadSet(setKey)
    .then((imgs) => {
      texs = imgs.map((im, i) => uploadOne(im, i >= 3));
      ready = true;
      document.documentElement.dataset.scene = 'on';
      kick();
      maybeSwap(); // the viewport may have rotated while the first set loaded
    })
    .catch((err) => {
      fail(`could not load ${err?.message ?? err}`);
    });

  return handle;
}
