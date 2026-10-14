// Water on the page, in front of everything: a light drizzle that beads, sits, evaporates
// or runs down, and a splash when the music hits (player.ts dispatches 'rehndrop:hit').
// It refracts nothing; each drop is a pre-rendered sprite of rim shadow, caustic and
// highlight, which is what reads as water on glass at a glance.
//
// The drops belong to the page, not the screen: the canvas is an absolutely positioned
// strip (taller than the viewport) that the browser scrolls with the content on the
// compositor, so drops never lag a fast fling. When the reader travels far enough, the
// strip re-anchors around the viewport while its edges are off screen.
import { reducedMotion } from './drive';

interface Drop {
  x: number;
  y: number;
  r: number;
  a: number;
  age: number;
  sit: number; // seconds before it decides to run or dry
  state: 0 | 1 | 2 | 3; // landing, sitting, running, drying
  vy: number;
  pause: number;
  travelled: number;
}

const MASTER = 0.8;

export function startDrops(canvas: HTMLCanvasElement) {
  if (reducedMotion()) return;
  const ctx = canvas.getContext('2d');
  const layer = canvas.parentElement;
  if (!ctx || !layer) return;

  const small = !matchMedia('(min-width: 700px)').matches;
  const MAX = small ? 48 : 80;
  const sprites = new Map<number, HTMLCanvasElement>();
  let dpr = 1;
  let w = 0;
  let h = 0; // viewport height
  let H = 0; // strip height
  let anchor = 0; // page y of the strip's top
  const view = () => scrollY - anchor; // strip y of the viewport's top

  const size = () => {
    // mobile URL bars nudge innerHeight while scrolling; only a real change re-allocates
    if (Math.abs(innerWidth - w) < 1 && Math.abs(innerHeight - h) < 120 && H > 0) return;
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = innerWidth;
    h = innerHeight;
    H = Math.round(h * 1.8);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = `${H}px`;
    sprites.clear();
    reanchor(true);
  };

  // keep the strip around the viewport, clamped inside the document so it never adds scroll
  const reanchor = (force = false) => {
    const top = scrollY;
    if (!force && top >= anchor + h * 0.05 && top + h <= anchor + H - h * 0.05) return;
    const docH = layer.offsetHeight;
    const next = Math.max(0, Math.min(top - h * 0.4, Math.max(0, docH - H)));
    const shift = anchor - next;
    if (shift) for (const d of drops) d.y += shift;
    anchor = next;
    canvas.style.transform = `translate3d(0, ${anchor}px, 0)`;
    draw(); // same frame as the move, so no drop ever shows at a stale offset
  };

  // one sprite per whole-pixel radius, drawn once
  const sprite = (r: number) => {
    const key = Math.max(2, Math.min(30, Math.round(r)));
    let c = sprites.get(key);
    if (c) return c;
    const R = key * dpr;
    const S = Math.ceil(R * 2.8);
    c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d')!;
    const m = S / 2;

    // contact shadow, a little below the drop
    let gr = g.createRadialGradient(m, m + R * 0.16, R * 0.55, m, m + R * 0.16, R * 1.12);
    gr.addColorStop(0, 'rgba(0,0,0,0.26)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(m, m + R * 0.16, R * 1.12, 0, Math.PI * 2);
    g.fill();

    // body: faint cool lensing, brighter toward the light
    gr = g.createRadialGradient(m - R * 0.25, m - R * 0.3, 0, m, m, R);
    gr.addColorStop(0, 'rgba(235,242,255,0.16)');
    gr.addColorStop(0.65, 'rgba(210,220,235,0.05)');
    gr.addColorStop(0.9, 'rgba(0,0,0,0.22)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(m, m, R, 0, Math.PI * 2);
    g.fill();

    // caustic: light focused into the lower lip
    g.save();
    g.beginPath();
    g.arc(m, m, R * 0.82, Math.PI * 0.12, Math.PI * 0.88);
    g.strokeStyle = 'rgba(225,235,255,0.42)';
    g.lineWidth = Math.max(1, R * 0.13);
    g.lineCap = 'round';
    g.shadowColor = 'rgba(225,235,255,0.5)';
    g.shadowBlur = R * 0.3;
    g.stroke();
    g.restore();

    // specular
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.ellipse(m - R * 0.36, m - R * 0.42, R * 0.17, R * 0.11, -0.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.beginPath();
    g.arc(m + R * 0.28, m - R * 0.5, R * 0.05, 0, Math.PI * 2);
    g.fill();

    sprites.set(key, c);
    return c;
  };

  const drops: Drop[] = [];
  const rand = (a: number, b: number) => a + Math.random() * (b - a);

  const add = (x: number, y: number, r: number, sit = rand(3, 10)) => {
    if (drops.length >= MAX) drops.shift();
    drops.push({ x, y, r, a: 0, age: 0, sit, state: 0, vy: 0, pause: rand(0.1, 0.6), travelled: 0 });
  };

  // a splash comes from one side, like water thrown at the camera
  const splash = (amount = 1) => {
    const side = Math.random();
    const cx = side < 0.5 ? rand(0, w * 0.35) : rand(w * 0.65, w);
    const cy = view() + rand(h * 0.05, h * 0.55);
    const n = Math.round((small ? 12 : 20) * amount);
    for (let i = 0; i < n; i++) {
      const big = Math.random() < 0.14;
      const r = big ? rand(11, small ? 16 : 22) : Math.random() < 0.5 ? rand(2, 5) : rand(5, 10);
      add(cx + rand(-w * 0.3, w * 0.3) * Math.random(), cy + rand(-h * 0.25, h * 0.35) * Math.random(), r, rand(0.4, 3));
    }
    wake();
  };

  let raf = 0;
  let running = false;
  let last = 0;
  let nextDrizzle = 1.5;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    const runningDrops = drops.some((d) => d.state === 2);
    if (!runningDrops && now - last < 1000 / 30) return;
    last = now;
    reanchor();

    nextDrizzle -= dt;
    if (nextDrizzle <= 0) {
      add(rand(0, w), view() + rand(0, h * 0.85), Math.random() < 0.8 ? rand(2, 6) : rand(7, 12));
      nextDrizzle = small ? rand(1.2, 3.2) : rand(0.7, 2.2);
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      if (d.state === 0) {
        d.a = Math.min(1, d.a + dt * 7);
        if (d.a >= 1) d.state = 1;
      } else if (d.state === 1) {
        if (d.age > d.sit) d.state = d.r >= 8 && Math.random() < 0.75 ? 2 : 3;
      } else if (d.state === 2) {
        // stick, then slip; heavier drops slip faster
        if (d.pause > 0) {
          d.pause -= dt;
        } else {
          d.vy = Math.min(220, d.vy + dt * 260 * (d.r / 10));
          const step = d.vy * dt;
          d.y += step;
          d.x += Math.sin(d.y * 0.05 + d.r) * 0.15;
          d.travelled += step;
          if (Math.random() < dt * 1.4) {
            d.vy = 0;
            d.pause = rand(0.05, 0.5);
          }
          if (d.travelled > d.r * 1.4) {
            d.travelled = 0;
            add(d.x + rand(-1, 1), d.y - d.r * 0.9, Math.max(1.6, d.r * 0.28), rand(0.6, 2.5));
            d.r *= 0.985;
          }
        }
        if (d.r < 5 || d.y - d.r > H) d.state = 3;
      } else {
        d.a -= dt * 0.45;
        d.r *= 1 - dt * 0.05;
        if (d.a <= 0) {
          drops.splice(i, 1);
          continue;
        }
      }
    }

    // a running drop swallows whatever it touches
    for (const d of drops) {
      if (d.state !== 2) continue;
      for (let j = drops.length - 1; j >= 0; j--) {
        const o = drops[j];
        if (o === d || o.state === 2) continue;
        const dx = o.x - d.x;
        const dy = o.y - d.y;
        if (dx * dx + dy * dy < (d.r + o.r * 0.6) ** 2) {
          d.r = Math.min(30, Math.hypot(d.r, o.r));
          drops.splice(j, 1);
        }
      }
    }

    draw();
  };

  function draw() {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    for (const d of drops) {
      const s = sprite(d.r);
      const stretch = d.state === 2 && d.pause <= 0 ? 1.14 : 1;
      const sw = (s.width / dpr) * (d.r / Math.max(2, Math.min(30, Math.round(d.r))));
      const sh = sw * stretch;
      ctx!.globalAlpha = d.a * MASTER;
      ctx!.drawImage(s, (d.x - sw / 2) * dpr, (d.y - sh / 2) * dpr, sw * dpr, sh * dpr);
    }
    ctx!.globalAlpha = 1;
  }

  const wake = () => {
    if (running || document.hidden) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const sleep = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  size();
  window.addEventListener('resize', size, { passive: true });
  window.addEventListener('scroll', () => reanchor(), { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? sleep() : wake()));
  document.addEventListener('rehndrop:hit', () => {
    splash(1.8);
    setTimeout(() => splash(0.8), 260); // the wave behind the first one
  });
  // every beat flicks a few drops at the lens
  document.addEventListener('rehndrop:beat', () => {
    if (drops.length > MAX - 6) return;
    const n = small ? 2 : 4;
    for (let i = 0; i < n; i++) add(rand(0, w), view() + rand(0, h * 0.9), Math.random() < 0.7 ? rand(2, 6) : rand(7, 12), rand(0.4, 2));
    wake();
  });
  // now and then, even in silence, a gust
  const gust = () => {
    if (!document.hidden) splash(0.35);
    setTimeout(gust, rand(18000, 34000));
  };
  setTimeout(gust, rand(14000, 22000));
  canvas.classList.add('is-on');
  wake();
  setTimeout(() => splash(0.6), 1200); // a light splash as you arrive
}
