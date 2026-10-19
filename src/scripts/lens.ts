// The wet lens: the velvet is seen through glass in a steady drizzle. Beads land and
// evaporate, heavier drops slide with a stick-slip stutter and clear a trail through
// the fog, and the music pushes it all (see player.ts -> drive).
//
// Failure is always graceful: no WebGL, a lost context, a slow device or reduced motion
// all leave the static CSS velvet underneath, which is the same image.
import { drive, reducedMotion } from './drive';
import { frozen, wallNow } from './clock';

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uSharp;
uniform sampler2D uFog;
uniform vec4 uCover;     // xy scale, zw offset: screen uv -> cover-fit texture uv
uniform float uAspect;   // screen w / h
uniform float uTime;     // wall clock (beads)
uniform float uSlide;    // integrated slide clock (drops), so speed changes never jump
uniform float uRain;     // 0..1 density
uniform float uFlash;    // 0..1 light hit
uniform float uScroll;   // 0..1 page scroll, for a little parallax
uniform float uDepth;    // page scroll in viewport heights x 0.35: the beads' parallax layer
uniform vec3 uTint;
uniform vec4 uDye;       // rgb: the playing track's colour, linear light, scaled to luminance 1; a: how far the velvet takes it
uniform vec3 uWipe[6];   // pointer trail: xy uv, z strength
uniform vec2 uSway;      // slow drift + cursor parallax of the scene behind the glass
uniform vec4 uLights;    // two light pools orbiting the velvet: xy, xy in uv
uniform vec2 uLightAmp;  // their breathing brightness

// hash without sine, Dave Hoskins (MIT)
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 h31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

// beads: small drops that land, sit, and evaporate on their own clocks
vec3 beads(vec2 q, float t, float scale, float density) {
  vec2 p = q * scale;
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float seed = id.x * 107.45 + id.y * 3543.654;
  vec3 n = h31(seed);
  float rate = 0.035 + n.z * 0.06;
  float clock = t * rate + n.x;
  float life = fract(clock);
  float on = step(h11(seed + floor(clock) * 13.17), density);
  float a = smoothstep(0.0, 0.025, life) * (1.0 - smoothstep(0.5, 1.0, life)) * on;
  vec2 c = (n.xy - 0.5) * 0.55;
  float r = mix(0.09, 0.25, n.y * n.y);
  vec2 d = f - c;
  float m = smoothstep(r, r * 0.6, length(d)) * a;
  return vec3(d / r * m, m);
}

// sliders: heavier drops running down in tall cells, beads left in their wake
vec4 sliders(vec2 q, float t, float scale, float density) {
  const float TALL = 3.0;
  vec2 p = q * vec2(scale, scale / TALL);
  p.y += t * 0.05;
  vec2 id = floor(p);
  vec2 f = fract(p);
  float seed = id.x * 35.2 + id.y * 2376.1;
  vec3 n = h31(seed);
  float on = step(h11(seed + 7.7), density);

  float x = 0.25 + 0.5 * n.x;
  float cyc = fract(t * (0.12 + 0.12 * n.y) + n.z);
  float slip = cyc - 0.9 * sin(6.2831 * cyc) / 6.2831; // monotone, sticks then slips
  float y = 1.05 - 1.1 * slip;
  float wig = sin(f.y * 9.0 + n.x * 6.2831) * 0.035 + sin(f.y * 23.0 + n.y * 4.0) * 0.012;

  vec2 d = vec2(f.x - x - wig, (f.y - y) * TALL);
  float r = 0.13 + 0.05 * n.y;
  float drop = smoothstep(r, r * 0.55, length(d * vec2(1.0, 0.8))) * on;

  float above = f.y - y;
  float wake = smoothstep(0.0, 0.03, above) * (1.0 - smoothstep(0.0, 0.55, above)) * on;
  vec2 tp = vec2(f.x - x - wig, (fract(f.y * 7.0) - 0.5) * (TALL / 7.0));
  float tr = r * 0.42 * wake * (0.6 + 0.4 * h11(floor(f.y * 7.0) + seed));
  // smoothstep with equal edges is undefined in GLSL; empty cells must not reach it
  float trail = tr > 0.004 ? smoothstep(tr, tr * 0.35, length(tp)) * step(0.0, above) : 0.0;
  float streak = (1.0 - smoothstep(0.0, 0.06, abs(f.x - x - wig))) * wake;

  float m = max(drop, trail);
  vec2 nrm = drop > trail ? d / r * drop : (trail > 0.0 ? tp / tr * trail : vec2(0.0));
  return vec4(nrm, m, max(streak, m));
}

void main() {
  vec2 q = vec2(vUv.x * uAspect, vUv.y);
  // the drop field rides the page at a third of its speed: in front of the velvet, behind the
  // content. y is up in uv, so scrolling down moves the field up
  vec2 qd = vec2(q.x, q.y - uDepth);
  float dens = 0.25 + 0.75 * uRain;

  vec3 b1 = beads(qd, uTime, 20.0, dens * 0.9);
  vec3 b2 = beads(qd + vec2(0.31, 0.17), uTime * 1.3, 38.0, dens * 0.8);
  vec4 s1 = sliders(qd, uSlide, 11.0, dens * 0.55);
  vec4 s2 = sliders(qd * 1.45 + vec2(0.53, 0.29), uSlide * 1.15, 11.0, dens * 0.4);

  float wipe = 0.0;
  for (int i = 0; i < 6; i++) {
    vec2 w = (vUv - uWipe[i].xy) * vec2(uAspect, 1.0);
    wipe = max(wipe, smoothstep(0.11, 0.03, length(w)) * uWipe[i].z);
  }

  float mask = max(max(b1.z, b2.z), max(s1.z, s2.z));
  vec2 nrm = b1.xy + b2.xy + s1.xy + s2.xy;
  float clear = max(s1.w, s2.w);
  mask *= 1.0 - wipe;
  nrm *= 1.0 - wipe;

  vec2 tuv = vUv * uCover.xy + uCover.zw;
  tuv.y += (uScroll - 0.5) * 0.04;
  tuv += uSway * uCover.xy;
  vec3 bg = texture2D(uSharp, tuv).rgb;
  vec3 fog = texture2D(uFog, tuv + nrm * 0.004).rgb;
  vec3 lens = texture2D(uSharp, tuv - nrm * vec2(0.06 / uAspect, 0.06) * uCover.xy).rgb;

  vec3 glass = mix(bg, fog * 0.92, 0.62 * (1.0 - clamp(clear * 0.7 + wipe, 0.0, 1.0)));
  vec3 col = mix(glass, lens * 1.45 + 0.015, mask);

  // the velvet takes the colour of what's playing, mixed in linear light so its luminance,
  // the thing every text contrast is measured against, holds: the shadows stay black and the
  // pile's sheen carries the hue (mixed in gamma space, a saturated red would read 3x brighter)
  vec3 lin = pow(max(col, 0.0), vec3(2.2));
  float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  col = pow(mix(lin, min(lum * uDye.rgb, vec3(1.0)), uDye.a), vec3(1.0 / 2.2));

  float l2 = min(dot(nrm, nrm), 0.98);
  vec3 sn = normalize(vec3(nrm, sqrt(1.0 - l2)));
  float spec = pow(max(dot(sn, normalize(vec3(-0.45, 0.6, 0.66))), 0.0), 28.0) * mask;
  float rim = smoothstep(0.55, 1.0, sqrt(l2)) * mask;
  col *= 1.0 - rim * 0.7;
  // light gathers in the lower lip of each drop, the way it does on real glass
  float lip = smoothstep(0.2, 0.95, -sn.y) * smoothstep(0.35, 0.9, sqrt(l2)) * mask;
  col += lip * (vec3(0.55, 0.6, 0.68) + uTint * 0.3) * (0.35 + uFlash);
  col += spec * (vec3(0.9, 0.94, 1.0) + uTint * 0.35) * (1.25 + uFlash * 1.8);

  // the light never stops moving: two pools rake across the damask, one cold, one in the
  // colour of whatever is playing
  vec2 sp = vec2(vUv.x * uAspect, vUv.y);
  vec2 d1 = sp - vec2(uLights.x * uAspect, uLights.y);
  vec2 d2 = sp - vec2(uLights.z * uAspect, uLights.w);
  vec3 cold = vec3(0.78, 0.82, 0.9);
  vec3 light = cold * exp(-dot(d1, d1) * 3.0) * uLightAmp.x
             + mix(cold, uTint, 0.8) * exp(-dot(d2, d2) * 2.4) * uLightAmp.y;
  light *= 0.7 + 0.35 * uRain + 0.6 * uFlash;
  col += col * light * 0.5 + light * 0.01;

  vec2 g = (vUv - vec2(0.5, -0.08)) * vec2(1.0, 1.5);
  col += uTint * 0.16 * (1.0 - smoothstep(0.0, 1.05, length(g))) * (0.3 + uRain * 1.3);
  col += vec3(0.72, 0.78, 0.9) * uFlash * 0.2 * smoothstep(0.15, 1.0, vUv.y);

  col = col * 1.18 + 0.008;
  float v = length((vUv - 0.5) * vec2(1.15, 1.0));
  col *= mix(0.62, 1.0, 1.0 - smoothstep(0.3, 0.9, v));
  gl_FragColor = vec4(col, 1.0);
}`;

interface Options {
  canvas: HTMLCanvasElement;
  sharp: string;
  fog: string;
  texAspect: number;
}

export function startLens({ canvas, sharp, fog, texAspect }: Options) {
  const force = new URLSearchParams(location.search).has('lens');
  if (reducedMotion() && !force) return;

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: !force, // software GL would melt a phone; keep the static velvet
  }) as WebGLRenderingContext | null;
  if (!gl) return;

  const prog = link(gl);
  if (!prog) return;
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u = {
    sharp: U('uSharp'), fog: U('uFog'), cover: U('uCover'), aspect: U('uAspect'), time: U('uTime'),
    slide: U('uSlide'), rain: U('uRain'), flash: U('uFlash'), scroll: U('uScroll'), depth: U('uDepth'), tint: U('uTint'), dye: U('uDye'),
    wipe: U('uWipe'), sway: U('uSway'), lights: U('uLights'), lightAmp: U('uLightAmp'),
  };
  gl.uniform1i(u.sharp, 0);
  gl.uniform1i(u.fog, 1);

  let quality = matchMedia('(pointer: fine)').matches ? 0.75 : 0.6;
  let aspect = 1;
  let lastW = 0;
  let lastH = 0;

  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // mobile URL bars nudge the height on scroll; only a real change re-allocates
    if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 120 && canvas.width > 0) return;
    lastW = w;
    lastH = h;
    canvas.width = Math.max(1, Math.round(w * dpr * quality));
    canvas.height = Math.max(1, Math.round(h * dpr * quality));
    gl.viewport(0, 0, canvas.width, canvas.height);
    aspect = w / h;
    // cover-fit with 8% slack so the scroll parallax never shows an edge
    const slack = 1.08;
    let sx = 1;
    let sy = 1;
    if (aspect > texAspect) sy = texAspect / aspect;
    else sx = aspect / texAspect;
    sx /= slack;
    sy /= slack;
    gl.uniform4f(u.cover, sx, sy, (1 - sx) / 2, (1 - sy) / 2);
    gl.uniform1f(u.aspect, aspect);
  };

  const wipes = new Float32Array(18);
  let wipeHead = 0;
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  if (matchMedia('(pointer: fine)').matches) {
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || frozen) return; // a pinned frame ignores the cursor
      px = e.clientX / innerWidth - 0.5;
      py = e.clientY / innerHeight - 0.5;
      const i = wipeHead++ % 6;
      wipes[i * 3] = e.clientX / innerWidth;
      wipes[i * 3 + 1] = 1 - e.clientY / innerHeight;
      wipes[i * 3 + 2] = 1;
    }, { passive: true });
  }

  let raf = 0;
  let running = false;
  let lastScroll = 0;
  window.addEventListener('scroll', () => (lastScroll = performance.now()), { passive: true });
  let lost = false;
  let last = performance.now();
  let slide = 0;
  let wall = 0;
  let flash = 0;
  const tint: [number, number, number] = [...drive.tint];
  const dyeCol: [number, number, number] = [1, 1, 1];
  let dye = 0;
  let probeFrames = 0;
  let probeTime = 0;
  let downgrades = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    // idle rain is calm enough for 30 fps; music gets every frame the device offers
    // idle rain is calm enough for 30 fps; music and scrolling get every frame on offer,
    // so the parallax layer never judders against the page
    const playing = drive.pulse > 0 || drive.flash > 0.01 || now - lastScroll < 250;
    if (!playing && now - last < 1000 / 32) return;
    last = now;

    if (!frozen && probeFrames < 90) {
      probeFrames++;
      probeTime += dt;
      if (probeFrames === 90) {
        const avg = probeTime / 90;
        if (avg > 0.045) {
          if (downgrades < 2) {
            downgrades++;
            quality *= 0.7;
            lastW = 0;
            size();
            probeFrames = 0;
            probeTime = 0;
          } else {
            stop(true);
            return;
          }
        }
      }
    }

    if (frozen) {
      // a still frame: every clock in the shader comes from the pinned time
      wall = slide = (wallNow() / 1000) % 2000;
    } else {
      wall = (wall + dt) % 2000;
      slide = (slide + dt * drive.speed) % 2000;
    }
    flash = Math.max(drive.flash, flash - dt * 3);
    for (let k = 0; k < 3; k++) tint[k] += (drive.tint[k] - tint[k]) * Math.min(1, dt * 2.5);
    for (let i = 0; i < 6; i++) wipes[i * 3 + 2] = Math.max(0, wipes[i * 3 + 2] - dt * 0.7);
    // the dye bleeds in and drains slowly, like light soaking into fabric. Its colour only
    // travels while it shows, so a new track never fades in through the last one's colour
    const [r, g, b] = drive.tint.map((c) => c ** 2.2);
    const l = Math.max(0.01, 0.2126 * r + 0.7152 * g + 0.0722 * b);
    const target = [r / l, g / l, b / l];
    for (let k = 0; k < 3; k++) dyeCol[k] = dye < 0.01 ? target[k] : dyeCol[k] + (target[k] - dyeCol[k]) * Math.min(1, dt * 1.2);
    dye += (drive.dye - dye) * Math.min(1, dt * 0.9);

    // wall-clock orbit and sway, computed here in float64 so the GPU never sees a large time
    const t = wallNow() / 1000;
    sx += (px - sx) * Math.min(1, dt * 2);
    sy += (py - sy) * Math.min(1, dt * 2);
    gl.uniform2f(u.sway, 0.006 * Math.sin(t * 0.21) + 0.004 * Math.sin(t * 0.13) - sx * 0.012, 0.005 * Math.cos(t * 0.17) + sy * 0.01);
    gl.uniform4f(u.lights,
      0.5 + 0.42 * Math.cos(t * 0.071), 0.55 + 0.36 * Math.sin(t * 0.053),
      0.5 + 0.4 * Math.cos(t * 0.047 + 2.6), 0.45 + 0.38 * Math.sin(t * 0.061 + 1.1));
    // the light pools breathe on their own and swell with the low end while music plays
    gl.uniform2f(u.lightAmp,
      0.8 + 0.25 * Math.sin(t * 0.55) + drive.pulse * 1.1,
      0.8 + 0.25 * Math.sin(t * 0.41 + 1.3) + drive.pulse * 1.4);

    const scrollMax = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    gl.uniform1f(u.time, wall);
    gl.uniform1f(u.slide, slide);
    gl.uniform1f(u.rain, Math.min(1, Math.max(0, drive.rain)));
    gl.uniform1f(u.flash, flash);
    gl.uniform1f(u.scroll, Math.min(1, scrollY / scrollMax));
    gl.uniform1f(u.depth, (scrollY / innerHeight) * 0.35);
    gl.uniform3f(u.tint, tint[0], tint[1], tint[2]);
    // it breathes a little with the low end
    gl.uniform4f(u.dye, dyeCol[0], dyeCol[1], dyeCol[2], Math.min(1, dye * (0.9 + 0.3 * drive.pulse)));
    gl.uniform3fv(u.wipe, wipes);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (frozen) stop();
  };

  const start = () => {
    if (running || lost) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const stop = (forever = false) => {
    running = false;
    cancelAnimationFrame(raf);
    if (forever) {
      lost = true;
      document.documentElement.classList.remove('lens-on');
    }
  };

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stop(true);
  });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('resize', () => {
    size();
    if (frozen) start(); // a resize clears the canvas; redraw the still frame
  }, { passive: true });

  Promise.all([texture(gl, sharp, 0), texture(gl, fog, 1)])
    .then(() => {
      size();
      document.documentElement.classList.add('lens-on');
      if (!document.hidden) start();
    })
    .catch(() => stop(true));
}

function link(gl: WebGLRenderingContext) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn('[lens]', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, VERT);
  const f = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[lens]', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function texture(gl: WebGLRenderingContext, url: string, unit: number) {
  return new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}
