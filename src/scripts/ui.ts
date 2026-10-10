import { reducedMotion } from './drive';

const ROTATE_MS = 9000;

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
    if (reducedMotion()) return;
    timer = window.setTimeout(() => {
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

export function startRows() {
  document.querySelectorAll<HTMLElement>('[data-row]').forEach((row) => {
    const track = row.querySelector<HTMLElement>('[data-row-track]');
    if (!track) return;
    const prev = row.querySelector<HTMLButtonElement>('[data-row-prev]');
    const next = row.querySelector<HTMLButtonElement>('[data-row-next]');
    const update = () => {
      const max = track.scrollWidth - track.clientWidth - 2;
      row.classList.toggle('at-start', track.scrollLeft <= 2);
      row.classList.toggle('at-end', track.scrollLeft >= max);
      row.classList.toggle('no-scroll', max <= 0);
    };
    const step = (dir: number) =>
      track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: reducedMotion() ? 'auto' : 'smooth' });
    prev?.addEventListener('click', () => step(-1));
    next?.addEventListener('click', () => step(1));
    track.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(track);
    update();
  });
}

// Desktop: grab a shelf and fling it. Touch screens already pan natively, so this is
// mouse-only. A drag never counts as a click on the cover underneath it.
export function startDrag() {
  if (!matchMedia('(pointer: fine)').matches) return;
  document.querySelectorAll<HTMLElement>('[data-row-track]').forEach((track) => {
    let down = false;
    let startX = 0;
    let startLeft = 0;
    let lastX = 0;
    let lastT = 0;
    let v = 0;
    let moved = 0;
    let glide = 0;

    const settle = () => {
      track.classList.remove('is-dragging');
    };

    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      cancelAnimationFrame(glide);
      down = true;
      moved = 0;
      v = 0;
      startX = lastX = e.clientX;
      startLeft = track.scrollLeft;
      lastT = performance.now();
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      if (moved > 4) track.classList.add('is-dragging');
      track.scrollLeft = startLeft - dx;
      const now = performance.now();
      const step = now - lastT;
      if (step > 0) v = 0.8 * ((e.clientX - lastX) / step) + 0.2 * v;
      lastX = e.clientX;
      lastT = now;
    });
    window.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      if (moved <= 4) return settle();
      // momentum, then let scroll-snap pick the nearest card
      let vel = -v * 16;
      const tick = () => {
        track.scrollLeft += vel;
        vel *= 0.93;
        if (Math.abs(vel) > 0.6) glide = requestAnimationFrame(tick);
        else settle();
      };
      glide = requestAnimationFrame(tick);
    });
    track.addEventListener('click', (e) => {
      if (moved > 4) {
        e.preventDefault();
        e.stopPropagation();
        moved = 0;
      }
    }, true);
    track.addEventListener('dragstart', (e) => e.preventDefault());
  });
}

export function startVideos() {
  const dialog = document.querySelector<HTMLDialogElement>('[data-video-dialog]');
  if (!dialog) return;
  const frame = dialog.querySelector<HTMLElement>('[data-video-frame]')!;
  const title = dialog.querySelector<HTMLElement>('[data-video-title]');

  const close = () => {
    frame.replaceChildren();
    if (dialog.open) dialog.close();
  };

  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-video]');
    if (!el) return;
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('rehndrop:pause'));
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(el.dataset.video!)}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
    iframe.title = el.dataset.videoTitle ?? 'video';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    frame.replaceChildren(iframe);
    if (title) title.textContent = el.dataset.videoTitle ?? '';
    dialog.showModal();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || (e.target as Element).closest('[data-video-close]')) close();
  });
  dialog.addEventListener('close', () => frame.replaceChildren());
}

// the chrome R leans toward the cursor on desktop
export function startTilt() {
  const r = document.querySelector<HTMLElement>('[data-tilt]');
  if (!r || reducedMotion() || !matchMedia('(pointer: fine)').matches) return;
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  let raf = 0;
  const loop = () => {
    cx += (tx - cx) * 0.08;
    cy += (ty - cy) * 0.08;
    r.style.setProperty('--rx', `${(-cy * 9).toFixed(2)}deg`);
    r.style.setProperty('--ry', `${(cx * 12).toFixed(2)}deg`);
    if (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001) raf = requestAnimationFrame(loop);
    else raf = 0;
  };
  window.addEventListener('pointermove', (e) => {
    tx = e.clientX / innerWidth - 0.5;
    ty = e.clientY / innerHeight - 0.5;
    if (!raf) raf = requestAnimationFrame(loop);
  }, { passive: true });
}
