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

  // swipe between spotlight slides on touch
  let x0 = 0;
  let y0 = 0;
  root.addEventListener('touchstart', (e) => {
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  root.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      holdUntil = performance.now() + 30000;
      show(index + (dx < 0 ? 1 : -1));
      schedule();
    }
  }, { passive: true });

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
