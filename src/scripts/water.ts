// Water on a glass pane that sits in front of the scene and behind the interface. It is pass 2 of
// the scene's frame (scene.setPass2), so it draws on the scene's own canvas and context and the
// interface above it stays crisp and dry.
//
// What the eye sees
//   fog      condensation: the scene, blurred and tinted by the essence under it, laid over the
//            glass. Running drops clear thin wet tracks through it; it slowly re-forms.
//   drops    each one is a small lens: the scene behind it, inverted and a little magnified, a dark
//            rim on the shadow side, a bright pin-point specular, a caustic crescent, a contact
//            shadow. Dawn fringes the colours a touch; chrome runs fast and sharp; candle is heavy.
//   beads    many tiny drops that sit, evaporate and are re-seeded slowly; running drops leave
//            some behind and swallow the ones they meet.
//
// Cost model (the target machine rasterises WebGL in software)
//   Nothing here loops per pixel. The composite is one full-screen pass with three texture reads
//   (scene, its blurred copy, the fog mask) and no branches. Everything else is a small quad whose
//   fragment cost is the drop's own area: drops and beads are two batched draws, wet tracks are
//   capsule stamps into a small fixed-size fog target, and the fog regrows by one texel step every
//   ~0.45 s (one tiny draw). The simulation is CPU-side with hard caps (config: CAP, BEAD_CAP).
//
// Calm zones: a tiny map of where text sits (src/lib/calm.ts, owned by the scene) is read by both
//   passes. Inside it the haze lift, the wet meniscus, the flash glow and every drop's specular,
//   caustic and rim light are held back and the scene is dimmed softly, so small type keeps its
//   contrast while the rest of the pane stays bright and wet. One extra tap per pixel in the
//   composite; drops read it once at their centre.
//
// Deterministic: every random number comes from a generator seeded with the wall clock (clock.ts),
// and ?t=<ms> pins it: the water is simulated for fixed steps from that seed and drawn as a still.
import { drive } from './drive';
import { frozen, hash32, seeded, wallNow } from './clock';
import { SOFTNESS, SWELL_GAIN, angleAt, centre } from '../lib/essence';
import { getTier } from '../lib/tier';
import {
  BEAD_CAP, CAP, ESSENCE_WATER, FOG, FOG_W, LIGHT, PRESIM, REFRACT_ALT, SEEDS_ON, STILL, type EssenceWater, type TierKey,
} from '../lib/water-config';
import { CALM_GLSL } from '../lib/calm';
import type { SceneHandle } from './scene';

const PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// ---------------------------------------------------------------------------------- shaders ----

// composite: the scene seen through the fog. The mesh is coarse (12 x 8 cells): per-vertex tint and
// fog density come from the essence weights on the CPU, so the pixel shader has no trigonometry.
const VS_COMP = `attribute vec2 a0;attribute vec4 a1;varying vec2 u;varying vec4 vK;
void main(){u=a0*.5+.5;vK=a1;gl_Position=vec4(a0,0.,1.);}`;

const FS_COMP = `${PREC}
varying vec2 u;varying vec4 vK;
uniform sampler2D uS,uB,uF;
uniform vec4 uP; // x flash, y pulse, zw one fog texel towards the light
${CALM_GLSL}
void main(){
  float cm = calmAt(u);
  vec4 fm = texture2D(uF, u); // r: how much of the pane is still fogged, g: how thick the haze sits here
  vec3 s = texture2D(uS, u).rgb;
  vec3 b = texture2D(uB, u).rgb;
  float lb = dot(b, vec3(.3, .59, .11));
  // condensation blurs the world rather than greying it: the blurred copy, tinted by the essence,
  // with a lift that only the bright parts of the haze carry
  vec3 fg = mix(b, vec3(lb), .08) * vK.rgb + vK.rgb * (.012 + .05 * lb) * (1. - uC.y * cm);
  float dens = clamp(fm.r * fm.g * vK.w * 1.12, 0., 1.);
  vec3 c = mix(s, fg, dens);
  // a cleared track is a wet channel: a thin bright meniscus on the side that faces the light, and
  // a fine dark line on the far side, both from the fog mask itself (one more read of a tiny texture)
  float fl = texture2D(uF, u + uP.zw).r;
  float fa = texture2D(uF, u - uP.zw).r;
  float edge = clamp(fl - fm.r, 0., 1.) * clamp(fm.g * vK.w * 1.2, 0., 1.);
  float edgeD = clamp(fm.r - fa, 0., 1.) * clamp(fm.g * vK.w, 0., 1.);
  float ls = dot(s, vec3(.3, .59, .11));
  c += edge * (.05 + .22 * ls + .05 * lb) * vec3(.93, .96, 1.) * (1. - uC.y * cm);
  c *= 1. - edgeD * .22;
  vec2 q = u - .5;
  c *= 1. - .4 * dot(q, q);
  c *= 1. + uP.y * .06;
  c += vec3(.72, .78, .9) * uP.x * .05 * smoothstep(.15, 1., u.y) * (1. - .8 * cm);
  c = calmGrade(c, cm);
  gl_FragColor = vec4(c, 1.);
}`;

// drops and beads: one quad each, drawn with premultiplied alpha
const VS_DROP = `attribute vec4 a0,a1,a2,a3;attribute float a4;uniform vec2 uRes;
varying vec2 vP;varying vec4 vU,vM,vT,vQ;varying float vAlt;
void main(){
  vec2 c = a0.xy * 1.5;
  vec2 px = a0.zw + c * a1.xy;
  gl_Position = vec4(px / uRes * 2. - 1., 0., 1.);
  vP = c;
  vU = vec4(a0.zw / uRes, a1.xy / uRes);
  vM = vec4(a1.z, 1. / min(a1.x, a1.y), a1.w, 0.);
  vT = a2;
  vQ = a3;
  vAlt = a4;
}`;

const FS_DROP = `${PREC}
varying vec2 vP;varying vec4 vU,vM,vT,vQ;varying float vAlt;
uniform sampler2D uS,uB,uA; // uA: secondary refraction source
uniform vec4 uF; // x flash, y pulse, zw direction towards the light
uniform vec2 uInv; // one over the canvas size in pixels
${CALM_GLSL}
void main(){
  float cm = calmAt(gl_FragCoord.xy * uInv); // per pixel: a big drop can straddle the edge of a calm zone
  float rem = 1. - uC.z * cm; // what is left of the drop's own light in a calm zone
  vec2 L = uF.zw;
  float aa = vM.y;
  vec2 p = vP;
  // teardrop: the tail (up, in GL space) is narrower than the head
  p.x /= 1. - .3 * vM.z * smoothstep(-.3, 1., p.y);
  float d = length(p);
  float body = 1. - smoothstep(1. - 1.4 * aa, 1. + .3 * aa, d);
  // contact shadow: a soft disc pushed away from the light, seen only outside the body
  float sh = (1. - smoothstep(.85, 1.45, length(vP + L * .15))) * .34 * (1. - body);
  if (body + sh < .003) discard;

  vec2 dir = p / max(d, .001);
  float d2 = min(d * d, 1.);
  // a drop is a lens: it shows the scene inverted, a little magnified in the middle and wide at the edge
  vec2 off = -p * (.6 + .62 * d2);
  off.y += .1;
  vec2 base = vU.xy;
  vec2 rr = vU.zw;
  vec3 c;
  float fr = vT.w;
  if (fr > .02) {
    float k = .07 * fr;
    c = vec3(texture2D(uS, base + off * (1. - k) * rr).r,
             texture2D(uS, base + off * rr).g,
             texture2D(uS, base + off * (1. + k) * rr).b);
  } else {
    c = texture2D(uS, base + off * rr).rgb;
  }
  if (vAlt > .5) {
    float ix = floor(vAlt - .5);
    float fa = (vAlt - .5 - ix) / .49;
    vec2 pu = vec2(.5 - p.x * .36, .5 + p.y * .24) + vec2(.5 - base.x, base.y - .5) * .12;
    pu = clamp(pu, .02, .98);
    vec3 ca = texture2D(uA, vec2((ix + pu.x) * .33333, pu.y)).rgb * 1.7 + .02;
    c = mix(c, ca, fa);
  }
  float lum = dot(c, vec3(.3, .59, .11));
  c *= vT.rgb;
  // a drop is a bright lens even over a dark room: lift what is seen through it, most where it is dark
  c = c * 1.24 + .045 * (1. - smoothstep(0., .5, lum));
  c *= mix(1.1, .8, smoothstep(.4, 1., d));
  c += vQ.w * vT.rgb * rem;
  // at its rim the drop is wet glass in the haze: it takes a little of the fog's softness
  vec3 hz = texture2D(uB, base + off * rr * .3).rgb * vT.rgb;
  c = mix(c, hz * 1.05, smoothstep(.55, 1., d) * .22);

  float side = dot(dir, -L) * .5 + .5; // 1 on the shadow side
  float rw = clamp(2.4 * aa, .16, .45);
  float rim = smoothstep(1. - 2. * rw, 1. - .25 * rw, d) * (1. - .6 * smoothstep(.35, .9, aa));
  c *= 1. - rim * (.26 + .6 * side) * vQ.z;
  float lit = smoothstep(1. - rw, 1., d) * (1. - side) * (1. - side);
  c += lit * .13 * rem;

  // light focused through the drop lands on its shadow side
  float cr = smoothstep(.45, .8, d) * (1. - smoothstep(.84, .97, d));
  float cs = pow(max(dot(dir, -L), 0.), 1.5);
  c += cr * cs * (.2 + 1.15 * lum) * vec3(1., .96, .9) * (1. + uF.x * 1.5 + uF.y * .5) * rem;

  float sw = clamp(1.5 * aa, .11 * vQ.y, .3);
  vec2 s1 = p - L * .5;
  vec2 s2 = p + L * .45;
  float spec = exp(-dot(s1, s1) / (sw * sw)) + .35 * exp(-dot(s2, s2) / (sw * sw * 2.2));
  c += spec * vQ.x * (1.15 + 2.4 * uF.x) * (1. - .55 * smoothstep(.3, .9, aa)) * vec3(.95, .97, 1.) * rem;
  c *= 1. - uC.w * cm;
  c = calmGrade(c, cm);

  float a = vM.x;
  gl_FragColor = vec4(c * body * a, (body + sh) * a);
}`;

// wet tracks: a capsule (segment with round ends) clears the fog target by multiplying it down
const VS_STAMP = `attribute vec2 a0;attribute vec4 a1,a2;varying vec4 vS,vB;
void main(){vS=a1;vB=a2;gl_Position=vec4(a0,0.,1.);}`;

const FS_STAMP = `precision mediump float;
varying vec4 vS,vB;
void main(){
  vec2 p = gl_FragCoord.xy;
  vec2 a = vS.xy;
  vec2 ab = vS.zw - a;
  float l2 = dot(ab, ab);
  float t = l2 > 1e-4 ? clamp(dot(p - a, ab) / l2, 0., 1.) : 0.;
  float dd = length(p - a - ab * t);
  float al = (1. - smoothstep(vB.x - vB.y, vB.x + vB.y, dd)) * vB.z;
  gl_FragColor = vec4(0., 0., 0., al);
}`;

// regrowth: add one 8-bit step of fog everywhere
const VS_FLAT = `attribute vec2 a0;void main(){gl_Position=vec4(a0,0.,1.);}`;
const FS_FLAT = `precision mediump float;uniform float uC;void main(){gl_FragColor=vec4(uC);}`;

// ------------------------------------------------------------------------------- the model ----

interface Drop {
  alive: boolean;
  dying: boolean;
  x: number;
  y: number;
  r: number;
  a: number;
  fadeIn: number;
  fadeOut: number;
  runner: boolean;
  phase: 0 | 1 | 2; // 0 sitting before the first slip, 1 slipping, 2 holding
  timer: number;
  t: number; // seconds into the current slip
  dur: number;
  dist: number;
  done: number; // distance covered in the current slip
  life: number; // a sitting drop's remaining life
  age: number;
  travel: number;
  ph1: number;
  ph2: number;
  tear: number;
  elong: number;
  sx: number; // where the current slip began
  sy: number;
  px: number; // last stamped point
  py: number;
  tr: number;
  tg: number;
  tb: number;
  fringe: number;
  spec: number;
  specSize: number;
  rim: number;
  lum: number;
  alt: number; // 0, or 1 + the index of the secondary source
}

interface Bead {
  alive: boolean;
  x: number;
  y: number;
  r: number;
  age: number;
  ttl: number;
  fadeIn: number;
  bright: number;
}

type Num = Exclude<{ [K in keyof EssenceWater]: EssenceWater[K] extends number ? K : never }[keyof EssenceWater], never>;
const NUM_KEYS: Num[] = [
  'size', 'density', 'beads', 'speed', 'holdLo', 'holdHi', 'slipLo', 'slipHi', 'run', 'trail', 'trailStr', 'tear',
  'elong', 'fringe', 'spec', 'specSize', 'rim', 'fog', 'lum',
];
type Mixed = Record<Num, number> & { tint: [number, number, number]; fogTint: [number, number, number] };
const newMixed = (): Mixed => {
  const o = { tint: [1, 1, 1], fogTint: [1, 1, 1] } as Mixed;
  for (const k of NUM_KEYS) o[k] = 0;
  return o;
};
const E = ESSENCE_WATER;
const mixInto = (o: Mixed, w: ArrayLike<number>) => {
  for (const k of NUM_KEYS) o[k] = w[0] * E[0][k] + w[1] * E[1][k] + w[2] * E[2][k];
  for (let i = 0; i < 3; i++) {
    o.tint[i] = w[0] * E[0].tint[i] + w[1] * E[1].tint[i] + w[2] * E[2].tint[i];
    o.fogTint[i] = w[0] * E[0].fogTint[i] + w[1] * E[1].fogTint[i] + w[2] * E[2].fogTint[i];
  }
};

const ZERO: ArrayLike<number> = [0, 0, 0];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export interface WaterHandle {
  stop(): void;
  resize(): void;
}

export function startWater({ scene }: { scene: SceneHandle }): WaterHandle {
  const NOOP: WaterHandle = { stop() {}, resize() {} };
  const gl = scene.gl;
  if (!gl) return NOOP;

  // the calm map (src/lib/calm.ts) belongs to the scene, so it also holds under the plain blit; this
  // pass only binds it and sets its uniforms
  const calm = scene.calm;
  if (!calm) return NOOP;
  let nowSec = 0;
  const canvas = gl.canvas as HTMLCanvasElement;
  const root = document.documentElement;

  // ---------- gl setup ----------
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[water]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const link = (vs: string, fs: string, attribs: string[]) => {
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const p = gl.createProgram()!;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    attribs.forEach((n, i) => gl.bindAttribLocation(p, i, n));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.warn('[water]', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  };
  const pComp = link(VS_COMP, FS_COMP, ['a0', 'a1']);
  const pDrop = link(VS_DROP, FS_DROP, ['a0', 'a1', 'a2', 'a3', 'a4']);
  const pStamp = link(VS_STAMP, FS_STAMP, ['a0', 'a1', 'a2']);
  const pFlat = link(VS_FLAT, FS_FLAT, ['a0']);
  if (!pComp || !pDrop || !pStamp || !pFlat) {
    console.warn('[water] shader build failed; the plain scene stays');
    return NOOP;
  }
  const L = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const uComp = {
    s: L(pComp, 'uS'), b: L(pComp, 'uB'), f: L(pComp, 'uF'), p: L(pComp, 'uP'),
  };
  const uDrop = {
    s: L(pDrop, 'uS'), b: L(pDrop, 'uB'), a: L(pDrop, 'uA'), res: L(pDrop, 'uRes'), f: L(pDrop, 'uF'), inv: L(pDrop, 'uInv'),
  };
  const uFlat = L(pFlat, 'uC');
  const cComp = calm.locate(pComp);
  const cDrop = calm.locate(pDrop);
  gl.useProgram(pComp);
  gl.uniform1i(uComp.s, 0);
  gl.uniform1i(uComp.b, 1);
  gl.uniform1i(uComp.f, 2);
  gl.useProgram(pDrop);
  gl.uniform1i(uDrop.s, 0);
  gl.uniform1i(uDrop.b, 1);
  gl.uniform1i(uDrop.a, 5);

  const bufTri = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, bufTri);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  // a small texture of the three plates side by side (unit 5): a second refraction source.
  // altReady flips once it is uploaded (or has failed for good); altSince stamps the moment, for the fade
  const altTex = gl.createTexture()!;
  let altUsable = false;
  let altReady = false;
  let altSince = 0;
  const altDone = (usable: boolean) => {
    altUsable = usable;
    altReady = true;
    altSince = wallNow() / 1000;
    if (still && !dead) scene.resize(); // a still frame only redraws on a resize
    document.dispatchEvent(new Event('water:ready'));
  };
  {
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, altTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.activeTexture(gl.TEXTURE0);
    const urls = ((window.__rehndrop?.scenePlates as string[] | undefined) ?? []).slice(0, 3);
    if (urls.length === 3) {
      const vw = REFRACT_ALT.view;
      const vh = Math.round((vw * 2) / 3);
      const cv = document.createElement('canvas');
      cv.width = vw * 3;
      cv.height = vh;
      const cx = cv.getContext('2d');
      let left = 3;
      let failed = false;
      const settle = () => {
        if (--left !== 0 || dead) return;
        if (!cx || failed) {
          altDone(false);
          return;
        }
        // the scene leaves these pixel-store flags in whatever state its own uploads ended in: set what
        // this upload needs and put the previous values back
        const pf = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
        const pc = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, altTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
        gl.activeTexture(gl.TEXTURE0);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, pf);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, pc);
        altDone(true);
      };
      urls.forEach((url, i) => {
        const im = new Image();
        im.onload = () => {
          cx?.drawImage(im, i * vw, 0, vw, vh);
          settle();
        };
        im.onerror = () => {
          failed = true;
          settle();
        };
        im.src = url;
      });
    } else {
      altReady = true;
    }
  }
  const bufDrop = gl.createBuffer()!;
  const bufBead = gl.createBuffer()!;
  const bufStamp = gl.createBuffer()!;
  const bufMesh = gl.createBuffer()!;
  const bufIdx = gl.createBuffer()!;

  const GX = 12;
  const GY = 8;
  const meshData = new Float32Array((GX + 1) * (GY + 1) * 6);
  {
    const idx = new Uint16Array(GX * GY * 6);
    let k = 0;
    for (let y = 0; y < GY; y++) {
      for (let x = 0; x < GX; x++) {
        const a = y * (GX + 1) + x;
        const b = a + 1;
        const c = a + GX + 1;
        const d = c + 1;
        idx.set([a, b, c, c, b, d], k);
        k += 6;
      }
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }

  // fog mask: RGBA8 render target, 1 = fogged glass. Fixed size, so it survives scene rescaling
  const fogTex = gl.createTexture()!;
  const fogFbo = gl.createFramebuffer()!;
  let fogW = 0;
  let fogH = 0;
  let fogNeedsClear = true;
  const fogSeed = hash32(`water-fog-${Math.floor(wallNow() / 1000)}`);

  // the glass is never evenly misted: the G channel of the fog target holds how thick the haze sits
  // at each point (slow cloudiness at three scales, heavier towards the bottom and the edges,
  // thinner mid-pane, a few wiped patches). Only R is ever drawn into afterwards, so G is static
  const bakeFog = (w: number, h: number) => {
    const rg = seeded(fogSeed);
    const lattice = (nx: number, ny: number) => {
      const a = new Float32Array((nx + 2) * (ny + 2));
      for (let i = 0; i < a.length; i++) a[i] = rg();
      return a;
    };
    const oct = [
      { nx: 4, ny: 3, wt: 0.5, a: lattice(4, 3) },
      { nx: 9, ny: 6, wt: 0.3, a: lattice(9, 6) },
      { nx: 21, ny: 12, wt: 0.2, a: lattice(21, 12) },
    ];
    const patches = Array.from({ length: 4 }, () => ({
      x: 0.12 + rg() * 0.76, y: 0.2 + rg() * 0.6, rx: 0.05 + rg() * 0.09, ry: 0.07 + rg() * 0.12, k: 0.35 + rg() * 0.4,
    }));
    const data = new Uint8Array(w * h * 4);
    const sm = (t: number) => t * t * (3 - 2 * t);
    for (let j = 0; j < h; j++) {
      const ny = j / (h - 1); // 0 bottom
      const prof = (0.6 + 0.4 * (1 - ny) ** 1.4) * (1 - 0.3 * Math.exp(-(((ny - 0.58) / 0.24) ** 2)));
      for (let i = 0; i < w; i++) {
        const nx = i / (w - 1);
        let n = 0;
        for (const o of oct) {
          const fx = nx * o.nx;
          const fy = ny * o.ny;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const tx = sm(fx - ix);
          const ty = sm(fy - iy);
          const r0 = iy * (o.nx + 2) + ix;
          const r1 = r0 + o.nx + 2;
          const top = o.a[r0] + (o.a[r0 + 1] - o.a[r0]) * tx;
          const bot = o.a[r1] + (o.a[r1 + 1] - o.a[r1]) * tx;
          n += o.wt * (top + (bot - top) * ty);
        }
        const patchy = 0.3 + 0.7 * sm(clamp((n - 0.28) / 0.5, 0, 1));
        const e = Math.abs(nx - 0.5) * 2;
        let g = patchy * prof * (1 + 0.3 * e * e * e);
        for (const q of patches) {
          const dx = (nx - q.x) / q.rx;
          const dy = (ny - q.y) / q.ry;
          g *= 1 - q.k * Math.exp(-(dx * dx + dy * dy));
        }
        const o4 = (j * w + i) * 4;
        data[o4] = 255;
        data[o4 + 1] = clamp(Math.round(g * 255), 0, 255);
        data[o4 + 2] = 0;
        data[o4 + 3] = 255;
      }
    }
    return data;
  };
  const allocFog = (w: number, h: number) => {
    fogW = w;
    fogH = h;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fogTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bakeFog(w, h));
    gl.bindFramebuffer(gl.FRAMEBUFFER, fogFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fogTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fogNeedsClear = false; // the bake above is the clear
  };

  // ---------- state ----------
  let cw = canvas.clientWidth || innerWidth;
  let ch = canvas.clientHeight || innerHeight;
  let S = clamp(ch / 950, 0.65, 1.2); // size unit: phones get smaller drops, 4K does not get giant ones
  let tier: TierKey = getTier();
  let cap = CAP[tier];
  let beadCap = BEAD_CAP[tier];
  const maxDrops = CAP.hardware;
  const maxBeads = BEAD_CAP.hardware;
  const drops: Drop[] = Array.from({ length: maxDrops }, () => ({ alive: false } as Drop));
  const beads: Bead[] = Array.from({ length: maxBeads }, () => ({ alive: false, x: 0, y: 0, r: 0, age: 0, ttl: 1, fadeIn: 1, bright: 1 }));
  const rnd = seeded(hash32(`water-${Math.floor(wallNow() / 1000)}`));
  const rand = (a: number, b: number) => a + rnd() * (b - a);
  const altKey = Math.floor(wallNow() / 1000);
  let dropSerial = 0;

  let spawnAcc = 0;
  let beadAcc = 0;
  let meshAcc = 99;
  let regrowAcc = 0;
  let flash = 0;
  let pulse = 0;
  let beadsDirty = true;
  let beadCount = 0;
  let shedLevel = 0; // 0 full, 1 half the drops and beads, 2 no beads either; past that the scene drops the pass
  let skipBeads = false;
  let still = frozen || tier === 'reduced';
  let dead = false;
  const P = newMixed();
  const W: [number, number, number] = [0, 0, 0];
  const swellNow = () => ((window.__rehndrop?.scene as { swell?: ArrayLike<number> } | undefined)?.swell ?? ZERO);

  // the weights of the three essences at a viewport point (css px), without allocating
  const weightsAt = (x: number, y: number, out: number[]) => {
    const sw = swellNow();
    const ang = angleAt(x, y, cw, ch, wallNow() / 1000);
    let sum = 0;
    for (let i = 0; i < 3; i++) {
      out[i] = Math.exp(SOFTNESS * (Math.cos(ang - centre(i)) - 1)) * (1 + SWELL_GAIN * (sw[i] ?? 0));
      sum += out[i];
    }
    out[0] /= sum;
    out[1] /= sum;
    out[2] /= sum;
  };
  const paramsAt = (x: number, y: number) => {
    weightsAt(x, y, W);
    mixInto(P, W);
    return P;
  };

  // ---------- fog stamps ----------
  const stampData = new Float32Array(FOG.maxStamps * 60);
  let stamps = 0;
  const fx = (x: number) => (x / cw) * fogW;
  const fy = (y: number) => (1 - y / ch) * fogH;
  const stamp = (x0: number, y0: number, x1: number, y1: number, halfW: number, strength: number) => {
    if (stamps >= FOG.maxStamps) return;
    const a = fx(x0);
    const b = fy(y0);
    const c = fx(x1);
    const d = fy(y1);
    const hw = Math.max(FOG.minHalfTexels, halfW * (fogW / cw));
    const fe = 1.7; // soft banks: a wet channel has a meniscus, not a cut edge
    const e = hw + fe + 1;
    const lx = ((Math.min(a, c) - e) / fogW) * 2 - 1;
    const rx = ((Math.max(a, c) + e) / fogW) * 2 - 1;
    const by = ((Math.min(b, d) - e) / fogH) * 2 - 1;
    const ty = ((Math.max(b, d) + e) / fogH) * 2 - 1;
    let o = stamps * 60;
    const corners = [lx, by, rx, by, lx, ty, lx, ty, rx, by, rx, ty];
    for (let i = 0; i < 6; i++) {
      stampData[o++] = corners[i * 2];
      stampData[o++] = corners[i * 2 + 1];
      stampData[o++] = a;
      stampData[o++] = b;
      stampData[o++] = c;
      stampData[o++] = d;
      stampData[o++] = hw;
      stampData[o++] = fe;
      stampData[o++] = strength;
      stampData[o++] = 0;
    }
    stamps++;
  };

  // ---------- beads ----------
  const spawnBead = (x: number, y: number, r: number, fast = false) => {
    let b: Bead | null = null;
    let worst = -1;
    for (let i = 0; i < beadCap; i++) {
      const o = beads[i];
      if (!o.alive) {
        b = o;
        break;
      }
      const f = o.age / o.ttl;
      if (f > worst) {
        worst = f;
        b = o;
      }
    }
    if (!b) return null;
    b.alive = true;
    b.x = x;
    b.y = y;
    b.r = r;
    b.age = 0;
    b.ttl = fast ? rand(20, 60) : rand(50, 170);
    b.fadeIn = fast ? 0.15 : rand(0.6, 2.2);
    b.bright = rnd() < 0.18 ? rand(1.3, 1.9) : rand(0.5, 1.1);
    beadsDirty = true;
    return b;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-6, rnd()))) * Math.cos(6.2831853 * rnd());
  // beads gather: denser near the bottom edge and around the drops (they were shed from them), with a
  // thin scatter everywhere else, and sized on a heavy-tailed curve so a few are nearly drops
  const randomBead = (aged: boolean) => {
    for (let t = 0; t < 3; t++) {
      let x: number;
      let y: number;
      const k = rnd();
      if (k < 0.4) {
        let host: Drop | null = null;
        for (let i = 0, n = Math.floor(rnd() * cap); i < cap; i++) {
          const o = drops[(i + n) % cap];
          if (o.alive && !o.dying) {
            host = o;
            break;
          }
        }
        if (host) {
          const rr = host.r * (1.3 + Math.abs(gauss()) * 1.6);
          const th = rnd() * 6.2831853;
          x = host.x + Math.cos(th) * rr;
          y = host.y + Math.sin(th) * rr * 1.4;
        } else {
          x = rand(0, cw);
          y = rand(0, ch);
        }
      } else if (k < 0.7) {
        x = rand(0, cw);
        y = ch * (1 - rnd() ** 1.8);
      } else {
        x = rand(0, cw);
        y = rand(0, ch);
      }
      if (x < 0 || x > cw || y < 0 || y > ch) continue;
      weightsAt(x, y, W);
      mixInto(P, W);
      if (rnd() * 1.7 > P.beads && t < 2) continue;
      const r = Math.min(9, Math.exp(Math.log(3.1) + 0.5 * gauss())) * S * P.size * 1.2;
      const b = spawnBead(x, y, Math.max(1.4 * S, r));
      if (aged && b) b.age = rand(0, b.ttl * 0.92);
      return;
    }
  };
  const countBeads = () => {
    let n = 0;
    for (let i = 0; i < beadCap; i++) if (beads[i].alive) n++;
    return n;
  };

  // ---------- drops ----------
  const aliveDrops = () => {
    let n = 0;
    for (const d of drops) if (d.alive && !d.dying) n++;
    return n;
  };
  const spawnDrop = (x: number, y: number, r: number, o: { run?: boolean; fast?: boolean; sit?: number } = {}) => {
    let d: Drop | null = null;
    for (let i = 0; i < cap; i++) {
      if (!drops[i].alive) {
        d = drops[i];
        break;
      }
    }
    if (!d) return null;
    const p = paramsAt(x, y);
    d.alive = true;
    d.dying = false;
    d.x = x;
    d.y = y;
    d.r = r;
    d.a = 0;
    d.fadeIn = o.fast ? 9 : rand(1.4, 3);
    d.fadeOut = 1.2;
    d.runner = o.run ?? (r > 6.5 * S && rnd() < clamp(p.run * (0.4 + r / (14 * S)), 0, 1));
    d.phase = 0;
    d.timer = o.sit ?? rand(0.5, 7);
    d.t = 0;
    d.dur = 1;
    d.dist = 0;
    d.done = 0;
    d.life = rand(35, 120);
    d.age = 0;
    d.travel = 0;
    d.ph1 = rand(0, 6.28);
    d.ph2 = rand(0, 6.28);
    d.tear = 0;
    d.elong = rand(0, 0.07);
    d.sx = x;
    d.sy = y;
    d.px = x;
    d.py = y;
    d.tr = d.tg = d.tb = 1;
    d.fringe = 0;
    d.spec = 1;
    d.specSize = 1;
    d.rim = 1;
    d.lum = 0;
    d.alt = 0;
    if (SEEDS_ON && r >= REFRACT_ALT.minR * S && hash32(`a-${altKey}-${dropSerial++}`) % REFRACT_ALT.oneIn === 0) {
      weightsAt(x, y, W);
      const top = W[1] > W[0] ? (W[2] > W[1] ? 2 : 1) : W[2] > W[0] ? 2 : 0;
      d.alt = 1 + ((top + 1) % 3);
    }
    return d;
  };
  const speedMul = () => clamp(drive.speed / 1.25, 0.5, 4);
  const startSlip = (d: Drop) => {
    const p = paramsAt(d.x, d.y);
    const sm = speedMul();
    const dist = d.r * rand(p.slipLo, p.slipHi);
    const v0 = 170 * S * p.speed * sm * rand(0.8, 1.2);
    d.dist = dist;
    d.dur = clamp((2 * dist) / v0, 0.12, 1.4);
    d.t = 0;
    d.done = 0;
    d.phase = 1;
    d.sx = d.x;
    d.sy = d.y;
  };
  const trySpawn = (forceBig = false) => {
    const big = forceBig || rnd() < 0.14;
    for (let t = 0; t < 6; t++) {
      const x = rand(0.02 * cw, 0.98 * cw);
      const y = rand(-0.02 * ch, 0.9 * ch);
      const p = paramsAt(x, y);
      if (!forceBig && rnd() * 1.4 > p.density) continue;
      // heavy-tailed: many mid drops, a long tail of big ones that sheet and run
      const r = (big ? rand(16, 27) * Math.max(p.size, 0.85) : clamp(Math.exp(Math.log(8.6) + 0.5 * gauss()), 4.5, 22) * p.size) * S;
      let clear = true;
      for (const o of drops) {
        if (!o.alive) continue;
        const dx = o.x - x;
        const dy = o.y - y;
        if (dx * dx + dy * dy < ((r + o.r) * 0.95) ** 2) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      spawnDrop(x, y, r);
      return;
    }
  };

  const stepDrop = (d: Drop, dt: number) => {
    d.age += dt;
    d.a = Math.min(1, d.a + dt * d.fadeIn);
    if (d.dying) {
      d.a -= dt * (d.fadeOut + d.fadeIn);
      if (d.a <= 0) d.alive = false;
      return;
    }
    const p = paramsAt(d.x, d.y);
    d.tr = p.tint[0];
    d.tg = p.tint[1];
    d.tb = p.tint[2];
    d.fringe = p.fringe;
    d.spec = p.spec;
    d.specSize = p.specSize;
    d.rim = p.rim;
    d.lum = p.lum;
    const slipping = d.phase === 1;
    const tearTo = d.runner ? (slipping ? p.tear : p.tear * 0.3) : 0;
    const elongTo = d.runner ? (slipping ? p.elong : p.elong * 0.3) : 0.04 * (d.r > 10 * S ? 1 : 0);
    const k = Math.min(1, dt * 7);
    d.tear += (tearTo - d.tear) * k;
    d.elong += (elongTo - d.elong) * k;

    if (!d.runner) {
      d.life -= dt;
      if (d.life <= 0) d.dying = true;
      return;
    }
    if (d.phase === 0 || d.phase === 2) {
      d.timer -= dt;
      if (d.timer <= 0) startSlip(d);
      return;
    }
    // slipping: fast at first, then it catches and stops (a stick-slip, not a glide)
    d.t += dt;
    const tt = Math.min(1, d.t / d.dur);
    const done = d.dist * (1 - (1 - tt) * (1 - tt));
    const dy = done - d.done;
    d.done = done;
    d.travel += dy;
    const wob = Math.sin(d.travel * 0.04 + d.ph1) * 0.09 + Math.sin(d.travel * 0.11 + d.ph2) * 0.035;
    d.x += dy * wob;
    d.y += dy;
    d.r = Math.max(0, d.r - dy * 0.0042);
    // the channel narrows as the drop slows and loses water: widest at the start of a slip
    stamp(d.px, d.py, d.x, d.y, d.r * p.trail * (0.62 + 0.38 * (1 - tt) * (1 - tt)), p.trailStr);
    d.px = d.x;
    d.py = d.y;
    if (tt >= 1) {
      d.phase = 2;
      d.timer = rand(p.holdLo, p.holdHi) / Math.sqrt(speedMul());
      // the stuck drop leaves a few micro beads along the channel it just cut
      const nb = 2 + Math.floor(rnd() * (tier === 'software' ? 3 : 4));
      for (let i = 0; i < nb; i++) {
        const f = rnd();
        const side = (rnd() < 0.5 ? -1 : 1) * d.r * p.trail * rand(0.9, 1.9);
        spawnBead(d.sx + (d.x - d.sx) * f + side, d.sy + (d.y - d.sy) * f, Math.max(1.2 * S, d.r * rand(0.1, 0.26)));
      }
    }
    if (d.r < 3 * S) d.dying = true;
    if (d.y - d.r > ch + 12) d.alive = false;
  };

  const mergePass = () => {
    for (const d of drops) {
      if (!d.alive || d.dying || !d.runner || d.a < 0.4) continue;
      for (const o of drops) {
        if (o === d || !o.alive || o.dying || o.a < 0.4) continue;
        const dx = o.x - d.x;
        const dy = o.y - d.y;
        const lim = (d.r + o.r) * 0.74;
        if (dx * dx + dy * dy > lim * lim) continue;
        // the bigger one keeps going; the mass adds up
        const big = o.runner && o.r > d.r ? o : d;
        const small = big === d ? o : d;
        big.r = Math.min(28 * S, Math.sqrt(big.r * big.r + small.r * small.r) * 0.98);
        small.alive = false;
        if (!big.runner) big.runner = true;
        if (big.phase !== 1) {
          big.phase = 2;
          big.timer = 0.05;
        }
        break;
      }
    }
  };

  const beadTick = () => {
    for (let i = 0; i < beadCap; i++) {
      const b = beads[i];
      if (!b.alive) continue;
      b.age += 0.1;
      if (b.age >= b.ttl) b.alive = false;
    }
    // running drops swallow the beads they touch
    for (const d of drops) {
      if (!d.alive || d.dying || !d.runner) continue;
      for (let i = 0; i < beadCap; i++) {
        const b = beads[i];
        if (!b.alive || b.ttl - b.age < 0.3) continue;
        const dx = b.x - d.x;
        const dy = b.y - d.y;
        const lim = d.r * 1.05 + b.r * 0.5;
        if (dx * dx + dy * dy < lim * lim) {
          b.ttl = b.age + 0.25;
          d.r = Math.min(28 * S, Math.sqrt(d.r * d.r + b.r * b.r * 0.3));
        }
      }
    }
    // re-seed: the pane never fills up and never empties
    let live = countBeads();
    for (let i = 0; i < 8 && live < beadCap; i++, live++) randomBead(false);
    beadsDirty = true;
  };

  const step = (dt: number) => {
    const rain = clamp(drive.rain, 0, 1.1);
    const target = Math.round(cap * (0.72 + 0.28 * rain));
    spawnAcc += dt * (0.9 + 1.8 * rain);
    if (spawnAcc >= 1) {
      spawnAcc -= 1;
      const alive = aliveDrops();
      if (alive < target) {
        // a pane with too few drops refills faster; there are always a couple of big ones
        let bigs = 0;
        for (let i = 0; i < cap; i++) if (drops[i].alive && !drops[i].dying && drops[i].r > 15 * S) bigs++;
        trySpawn(bigs < 2);
        if (alive < target * 0.6) trySpawn();
      }
    }
    for (let i = 0; i < maxDrops; i++) if (drops[i].alive) stepDrop(drops[i], dt);
    mergePass();
    beadAcc += dt;
    while (beadAcc >= 0.1) {
      beadAcc -= 0.1;
      beadTick();
    }
    regrowAcc += dt;
  };

  // ---------- music ----------
  const burst = (n: number, nBeads: number, sweep = false) => {
    const cx = sweep ? cw * 0.5 : rnd() < 0.5 ? rand(0.1, 0.35) * cw : rand(0.65, 0.9) * cw;
    const cy = sweep ? ch * 0.3 : rand(0.08, 0.5) * ch;
    const spread = sweep ? 0.5 : 0.2;
    // make room: the oldest sitting drops fade quickly instead of blocking the splash
    let free = 0;
    for (let i = 0; i < cap; i++) if (!drops[i].alive) free++;
    if (free < n) {
      const sitters = drops.slice(0, cap).filter((d) => d.alive && !d.dying && !d.runner).sort((a, b) => b.age - a.age);
      for (let i = 0; i < Math.min(n - free, sitters.length); i++) {
        sitters[i].dying = true;
        sitters[i].fadeOut = 2.5;
      }
    }
    for (let i = 0; i < n; i++) {
      const x = clamp(cx + (rnd() - 0.5) * 2 * spread * cw * rnd(), 0, cw);
      const y = clamp(cy + (rnd() - 0.4) * 2 * spread * ch * rnd(), -10, ch * 0.85);
      const p = paramsAt(x, y);
      const big = rnd() < 0.22;
      const r = (big ? rand(9, 17) : rand(3.4, 8)) * S * p.size;
      spawnDrop(x, y, r, { fast: true, run: big ? true : rnd() < 0.25, sit: rand(0.1, 1.4) });
    }
    for (let i = 0; i < nBeads; i++) {
      const x = clamp(cx + (rnd() - 0.5) * 2 * (spread * 1.4) * cw, 0, cw);
      const y = clamp(cy + (rnd() - 0.4) * 2 * (spread * 1.4) * ch, 0, ch);
      const p = paramsAt(x, y);
      spawnBead(x, y, (1.6 + rnd() * rnd() * 4) * S * p.size * 1.3, true);
    }
  };
  const onHit = () => {
    if (still || document.hidden) return;
    burst(tier === 'software' ? 5 : 9, tier === 'software' ? 18 : 60);
  };
  const onBeat = () => {
    if (still || document.hidden) return;
    for (let i = 0; i < (tier === 'software' ? 2 : 4); i++) {
      const x = rand(0, cw);
      const y = rand(0, ch * 0.9);
      const p = paramsAt(x, y);
      spawnBead(x, y, (1.8 + rnd() * 3) * S * p.size * 1.3, true);
    }
  };
  const onTurn = () => {
    if (still || document.hidden) return;
    burst(tier === 'software' ? 4 : 7, tier === 'software' ? 14 : 40, true);
  };
  document.addEventListener('rehndrop:hit', onHit);
  document.addEventListener('rehndrop:beat', onBeat);
  document.addEventListener('rehndrop:turn', onTurn);

  // a finger across the glass: the mouse wipes a track through the fog
  let lastWx = -1;
  let lastWy = -1;
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || still || dead) return;
    const x = e.clientX;
    const y = e.clientY;
    if (lastWx >= 0) stamp(lastWx, lastWy, x, y, FOG.wipeWidth * 0.5, FOG.wipeStrength);
    lastWx = x;
    lastWy = y;
  };
  const onLeave = () => {
    lastWx = -1;
  };
  addEventListener('pointermove', onPointer, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);

  // ---------- drawing ----------
  const VF = 17; // floats per vertex: four vec4 and one scalar
  const QF = VF * 6;
  const dropData = new Float32Array(maxDrops * QF);
  const beadData = new Float32Array(maxBeads * QF);
  const CORNERS = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1];
  const putQuad = (
    arr: Float32Array, at: number, cx: number, cy: number, rx: number, ry: number, a: number, tear: number,
    tr: number, tg: number, tb: number, fringe: number, spec: number, specSize: number, rim: number, lum: number, alt: number,
  ) => {
    let o = at;
    for (let i = 0; i < 6; i++) {
      arr[o++] = CORNERS[i * 2];
      arr[o++] = CORNERS[i * 2 + 1];
      arr[o++] = cx;
      arr[o++] = cy;
      arr[o++] = rx;
      arr[o++] = ry;
      arr[o++] = a;
      arr[o++] = tear;
      arr[o++] = tr;
      arr[o++] = tg;
      arr[o++] = tb;
      arr[o++] = fringe;
      arr[o++] = spec;
      arr[o++] = specSize;
      arr[o++] = rim;
      arr[o++] = lum;
      arr[o++] = alt;
    }
    return o;
  };
  const MIN_PX = 1.15; // below this a drop is a speckle: keep it a visible bead

  let beadFloats = 0;
  const buildBeads = () => {
    const kx = canvas.height > 0 ? canvas.width / cw : 1;
    const ky = canvas.height / ch;
    const rs = Math.max(kx, ky);
    let o = 0;
    let n = 0;
    for (let i = 0; i < beadCap; i++) {
      const b = beads[i];
      if (!b.alive) continue;
      const left = clamp((b.ttl - b.age) / 4, 0, 1);
      const a = Math.min(1, b.age / b.fadeIn) * left;
      if (a <= 0.01) continue;
      paramsAt(b.x, b.y);
      const rpx = Math.max(MIN_PX, b.r * (0.55 + 0.45 * left) * rs);
      o = putQuad(
        beadData, o, b.x * kx, (ch - b.y) * ky, rpx, rpx, a, 0, P.tint[0], P.tint[1], P.tint[2], P.fringe,
        P.spec * b.bright, P.specSize, P.rim, P.lum, 0,
      );
      n++;
    }
    beadFloats = o;
    beadCount = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufBead);
    gl.bufferData(gl.ARRAY_BUFFER, beadData.subarray(0, o), gl.DYNAMIC_DRAW);
    beadsDirty = false;
  };
  // the vertex flag: 0, or the source index plus a fade (0 to 0.49) that runs in over a second once the texture is up
  const altAt = (alt: number) => {
    if (!alt || !altUsable) return 0;
    const f = still ? 1 : clamp((wallNow() / 1000 - altSince) / 1.2, 0, 1);
    return alt - 0.5 + 0.49 * f;
  };
  const buildDrops = () => {
    const kx = canvas.width / cw;
    const ky = canvas.height / ch;
    const rs = Math.max(kx, ky);
    let o = 0;
    for (let i = 0; i < maxDrops; i++) {
      const d = drops[i];
      if (!d.alive || d.a <= 0.01) continue;
      const rpx = Math.max(MIN_PX, d.r * rs);
      o = putQuad(
        dropData, o, d.x * kx, (ch - d.y) * ky, rpx, rpx * (1 + d.elong), d.a, d.tear, d.tr, d.tg, d.tb, d.fringe,
        d.spec, d.specSize, d.rim, d.lum, altAt(d.alt),
      );
    }
    return o;
  };

  const fillMesh = () => {
    const tSec = wallNow() / 1000;
    const sw = swellNow();
    const w: number[] = [0, 0, 0];
    let o = 0;
    for (let j = 0; j <= GY; j++) {
      for (let i = 0; i <= GX; i++) {
        const sx = i / GX;
        const sy = j / GY; // 0 bottom, 1 top (GL)
        const ang = angleAt(sx * cw, (1 - sy) * ch, cw, ch, tSec);
        let sum = 0;
        for (let k = 0; k < 3; k++) {
          w[k] = Math.exp(SOFTNESS * (Math.cos(ang - centre(k)) - 1)) * (1 + SWELL_GAIN * (sw[k] ?? 0));
          sum += w[k];
        }
        let fog = 0;
        const t = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          const n = w[k] / sum;
          fog += n * E[k].fog;
          for (let c = 0; c < 3; c++) t[c] += n * E[k].fogTint[c];
        }
        meshData[o++] = sx * 2 - 1;
        meshData[o++] = sy * 2 - 1;
        meshData[o++] = t[0];
        meshData[o++] = t[1];
        meshData[o++] = t[2];
        // heavier towards the bottom of the pane, with slow cloudiness so the haze is never a flat sheet
        const cloud = 0.5 + 0.25 * Math.sin(sx * 5.3 + tSec * 0.031 + sy * 1.7) + 0.25 * Math.sin(sy * 4.1 - tSec * 0.023 + sx * 2.9);
        meshData[o++] = fog * (0.88 + 0.24 * (1 - sy)) * (0.78 + 0.4 * cloud);
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bufMesh);
    gl.bufferData(gl.ARRAY_BUFFER, meshData, gl.DYNAMIC_DRAW);
  };

  const flushStamps = () => {
    if (!stamps && !fogNeedsClear && regrowAcc < FOG.regrowEvery) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fogFbo);
    gl.viewport(0, 0, fogW, fogH);
    gl.colorMask(true, false, false, false); // R only: G is the baked haze thickness
    if (fogNeedsClear) {
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      fogNeedsClear = false;
    }
    gl.enable(gl.BLEND);
    if (regrowAcc >= FOG.regrowEvery && !still) {
      regrowAcc = 0;
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(pFlat);
      gl.uniform1f(uFlat, 1 / 255);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufTri);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (stamps) {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(pStamp);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufStamp);
      gl.bufferData(gl.ARRAY_BUFFER, stampData.subarray(0, stamps * 60), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.enableVertexAttribArray(1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 40, 0);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 40, 8);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
      gl.drawArrays(gl.TRIANGLES, 0, stamps * 6);
      gl.disableVertexAttribArray(1);
      gl.disableVertexAttribArray(2);
      stamps = 0;
    }
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  const drawQuads = (buf: WebGLBuffer, floats: number) => {
    if (!floats) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, VF * 4, i * 16);
    }
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, VF * 4, 64);
    gl.drawArrays(gl.TRIANGLES, 0, floats / VF);
  };

  let meshDirty = true;
  const draw = () => {
    const w = canvas.width;
    const h = canvas.height;
    if (meshDirty || meshAcc >= 0.2) {
      fillMesh();
      meshAcc = 0;
      meshDirty = false;
    }
    flushStamps();
    calm.prepare(nowSec, still);

    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene.texture());
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scene.fogTexture());
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fogTex);

    gl.useProgram(pComp);
    calm.uniforms(cComp, nowSec, still, swellNow(), false);
    gl.uniform4f(uComp.p, flash, pulse, (LIGHT[0] * 1.6) / fogW, (LIGHT[1] * 1.6) / fogH);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufMesh);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufIdx);
    gl.drawElements(gl.TRIANGLES, GX * GY * 6, gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.disableVertexAttribArray(1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(pDrop);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, altTex);
    gl.uniform2f(uDrop.res, w, h);
    gl.uniform2f(uDrop.inv, 1 / w, 1 / h);
    gl.uniform4f(uDrop.f, flash, pulse, LIGHT[0], LIGHT[1]);
    calm.uniforms(cDrop, nowSec, still, swellNow(), true);
    gl.activeTexture(gl.TEXTURE0);
    if (!skipBeads) {
      if (beadsDirty) buildBeads();
      drawQuads(bufBead, beadFloats);
    }
    const nf = buildDrops();
    if (nf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, bufDrop);
      gl.bufferData(gl.ARRAY_BUFFER, dropData.subarray(0, nf), gl.DYNAMIC_DRAW);
      drawQuads(bufDrop, nf);
    }
    gl.disable(gl.BLEND);
    // leave attribute state as the scene expects it (only array 0 in use)
    for (let i = 1; i < 5; i++) gl.disableVertexAttribArray(i);
    dropsDrawn = nf / QF;
  };
  let dropsDrawn = 0;

  // ---------- lifecycle ----------
  const reset = () => {
    for (const d of drops) d.alive = false;
    for (const b of beads) b.alive = false;
    stamps = 0;
    spawnAcc = 0;
    beadAcc = 0;
    regrowAcc = 0;
    fogNeedsClear = true;
  };
  const seed = () => {
    // history for a fresh pane: a populated, already-streaked state instead of a blank sheet
    const p0 = clamp(drive.rain, 0, 1.1);
    const want = Math.round(cap * (0.72 + 0.28 * p0));
    for (let i = 0; i < want; i++) trySpawn(i < 2);
    for (let i = 0; i < beadCap; i++) randomBead(true);
    const dt = still && frozen ? STILL.dt : PRESIM.dt;
    const steps = still && frozen ? STILL.steps : Math.round(PRESIM.seconds / dt);
    // the pre-roll is silent: stamps beyond the per-frame cap would be dropped, so flush often
    for (let i = 0; i < steps; i++) {
      step(dt);
      if (stamps > FOG.maxStamps - 40 && fogW) pendingFlush();
    }
    regrowAcc = 0;
  };
  // the pre-roll needs the fog target, which needs a bound GL state: do the draw in place
  const pendingFlush = () => {
    flushStamps();
  };

  const measure = () => {
    const nw = canvas.clientWidth || innerWidth;
    const nh = canvas.clientHeight || innerHeight;
    const kx = nw / cw;
    const ky = nh / ch;
    const aspectChange = Math.abs(nw / nh / (cw / ch) - 1);
    cw = nw;
    ch = nh;
    S = clamp(ch / 950, 0.65, 1.2);
    for (const d of drops) {
      if (!d.alive) continue;
      d.x *= kx;
      d.y *= ky;
      d.px *= kx;
      d.py *= ky;
      d.sx *= kx;
      d.sy *= ky;
    }
    for (const b of beads) {
      if (!b.alive) continue;
      b.x *= kx;
      b.y *= ky;
    }
    const fw = FOG_W[tier];
    const fh = Math.max(32, Math.round((fw * ch) / cw));
    if (!fogW || aspectChange > 0.03 || fh !== fogH) {
      allocFog(fw, fh);
      for (const d of drops) {
        d.px = d.x;
        d.py = d.y;
      }
    }
    meshDirty = true;
    beadsDirty = true;
  };

  // the caps follow the tier and how far the pass has already shed under starvation
  const applyCaps = () => {
    const div = shedLevel >= 1 ? 2 : 1;
    cap = Math.max(4, Math.ceil(CAP[tier] / div));
    beadCap = Math.ceil(BEAD_CAP[tier] / div);
    skipBeads = shedLevel >= 2;
    // surplus drops finish their fade (the oldest sitting ones first); surplus beads just go
    for (let i = cap; i < maxDrops; i++) {
      const d = drops[i];
      if (d.alive && !d.dying) {
        d.dying = true;
        d.fadeOut = 2;
      }
    }
    for (let i = beadCap; i < maxBeads; i++) beads[i].alive = false;
    beadsDirty = true;
  };
  // the scene is slow even at its floor scale: shed our own work first, in two steps, before the
  // scene gives up on the pass altogether
  const onStarved = () => {
    if (shedLevel >= 2) return false;
    shedLevel++;
    applyCaps();
    return true;
  };

  let rebuildStill = false;
  const applyTier = () => {
    const t = getTier();
    if (t === tier) return;
    tier = t;
    applyCaps();
    still = frozen || t === 'reduced';
    if (still) rebuildStill = true;
    const fw = FOG_W[t];
    if (fw !== fogW) {
      allocFog(fw, Math.max(32, Math.round((fw * ch) / cw)));
    }
  };

  let last = 0;
  let frame = 0;
  const fail = (why: unknown) => {
    console.warn('[water]', why);
    api.stop();
  };
  const pass2 = (now: number) => {
    if (dead) return;
    try {
      if ((frame++ & 63) === 0) applyTier();
      if (rebuildStill) {
        rebuildStill = false;
        reset();
        measure();
        seed();
      }
      nowSec = now / 1000;
      const dtRaw = last ? (now - last) / 1000 : 1 / 60;
      last = now;
      if (!still) {
        // a tab that was in the background resumes with one ordinary step, not a leap
        const dt = dtRaw > 0.5 ? 1 / 60 : Math.min(dtRaw, 0.066);
        flash = Math.max(clamp(drive.flash, 0, 1), flash - dt * 3);
        pulse += (clamp(drive.pulse, 0, 1) - pulse) * Math.min(1, dt * 8);
        step(dt);
        meshAcc += dt;
      }
      draw();
    } catch (err) {
      fail(err);
    }
  };

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    const nw = canvas.clientWidth || innerWidth;
    const nh = canvas.clientHeight || innerHeight;
    if (Math.abs(nw - cw) < 1 && Math.abs(nh - ch) < 1) return;
    measure();
  });
  ro?.observe(canvas);

  const api: WaterHandle = {
    stop() {
      if (dead) return;
      dead = true;
      scene.setPass2(null);
      root.classList.remove('lens-on'); // no pass 2 any more: the scene's plain blit is all that shows
      document.removeEventListener('rehndrop:hit', onHit);
      document.removeEventListener('rehndrop:beat', onBeat);
      document.removeEventListener('rehndrop:turn', onTurn);
      removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      ro?.disconnect();
      // the context is shared with the scene: give back everything this module made
      for (const p of [pComp, pDrop, pStamp, pFlat]) gl.deleteProgram(p);
      for (const b of [bufTri, bufDrop, bufBead, bufStamp, bufMesh, bufIdx]) gl.deleteBuffer(b);
      gl.deleteTexture(fogTex);
      gl.deleteTexture(altTex);
      gl.deleteFramebuffer(fogFbo);
    },
    resize() {
      measure();
    },
  };

  // frozen and reduced: simulate once, draw still (the scene redraws only on size changes)
  allocFog(FOG_W[tier], Math.max(32, Math.round((FOG_W[tier] * ch) / cw)));
  gl.activeTexture(gl.TEXTURE2);
  seedAndStart();

  function seedAndStart() {
    // the fog target must exist before the pre-roll flushes into it; the scene's draw state is
    // restored by the flush itself
    seed();
    scene.setPass2(pass2, { onStarved });
    const on = () => {
      if (!dead && scene.info().lens) root.classList.add('lens-on');
    };
    if (scene.drawn()) on();
    else document.addEventListener('scene:ready', on, { once: true });
  }

  // expose a tiny read-only probe for the lab HUD and the perf scripts
  (window.__rehndrop ??= {}).water = {
    get drops() { return dropsDrawn; },
    get beads() { return beadCount; },
    get still() { return still; },
    get ready() { return altReady; },
    get calmBuilds() { return calm.builds(); },
    get calmMaxMs() { return calm.maxMs; },
    get calm() { return calm.canvas(); }, // the calm map, for the lab HUD and the audit scripts
  };
  return api;
}
