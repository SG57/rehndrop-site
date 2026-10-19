import { reducedMotion } from './drive';
import { frozen } from './clock';

const ROTATE_MS = 9000;

// Page-local: the client router swaps the spotlight out on navigation, so this runs on every
// page load and its timer ends itself once its root has left the document.
export function startSpotlight() {
  const root = document.querySelector<HTMLElement>('[data-spotlight]');
  if (!root) return;
  const slides = [...root.querySelectorAll<HTMLElement>('[data-slide]')];
  const ticks = [...root.querySelectorAll<HTMLButtonElement>('[data-tick]')];
  if (slides.length < 2) return;

  let index = 0;
  let timer = 0;
  let holdUntil = 0;

  const show = (i: number) => {
    index = (i + slides.length) % slides.length;
    slides.forEach((s, k) => {
      const on = k === index;
      s.classList.toggle('is-current', on);
      s.setAttribute('aria-hidden', String(!on));
      s.inert = !on;
    });
    ticks.forEach((t, k) => {
      t.classList.toggle('is-current', k === index);
      t.setAttribute('aria-current', String(k === index));
    });
    root.style.setProperty('--accent-spot', slides[index].dataset.accent ?? '#c9ced6');
  };

  const busy = () =>
    document.hidden ||
    performance.now() < holdUntil ||
    root.matches(':hover, :focus-within') ||
    !!root.querySelector('[data-play].is-playing');

  const schedule = () => {
    clearTimeout(timer);
    if (reducedMotion() || frozen) return;
    timer = window.setTimeout(() => {
      if (!root.isConnected) return;
      if (!busy()) show(index + 1);
      schedule();
    }, ROTATE_MS);
  };

  ticks.forEach((t, k) =>
    t.addEventListener('click', () => {
      holdUntil = performance.now() + 30000;
      show(k);
      schedule();
    }),
  );

  // swipe or drag between slides; pointer events cover touch, pen and mouse alike
  let x0 = 0;
  let y0 = 0;
  let tracking = false;
  let swiped = false;
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true;
    swiped = false;
    x0 = e.clientX;
    y0 = e.clientY;
  });
  root.addEventListener('pointerup', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped = true;
      holdUntil = performance.now() + 30000;
      show(index + (dx < 0 ? 1 : -1));
      schedule();
    }
  });
  root.addEventListener('pointercancel', () => (tracking = false));
  // a swipe that ends on the play button must not also press it
  root.addEventListener('click', (e) => {
    if (swiped) {
      e.preventDefault();
      e.stopPropagation();
      swiped = false;
    }
  }, true);
  root.addEventListener('dragstart', (e) => e.preventDefault());

  show(0);
  schedule();
}

// the chrome R leans toward the cursor on desktop. Started once; it looks the R up each time,
// because the client router replaces it on every visit to the home page
export function startTilt() {
  if (reducedMotion() || frozen || !matchMedia('(pointer: fine)').matches) return;
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  let raf = 0;
  const loop = () => {
    const r = document.querySelector<HTMLElement>('[data-tilt]');
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    r?.style.setProperty('--rx', `${(-cy * 9).toFixed(2)}deg`);
    r?.style.setProperty('--ry', `${(cx * 12).toFixed(2)}deg`);
    if (r && Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001) raf = requestAnimationFrame(loop);
    else raf = 0;
  };
  window.addEventListener('pointermove', (e) => {
    tx = e.clientX / innerWidth - 0.5;
    ty = e.clientY / innerHeight - 0.5;
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
}
