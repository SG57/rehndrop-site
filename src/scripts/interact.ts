// The click ripple: a delegated pointer/keyboard hook that marks the pressed control with [data-pop]
// for 450 ms so interact.css can throw one ring from it. No per-frame work, one listener each.
const SEL = [
  '.top-link', '.chip', '.compass-b', '.store', '.play', '.ix-play', '.ix-view', '.ix-more', '.ix-letter',
  '.stage-contact', '.contact-links', '.reel-ring', '.spot-step', '.tick', '.back', '.mini-btn', '.mini-link',
  '.sheet-btn', '.sheet-close', '.tv-share', '.listen a', '.foot-social a', '.pill', '.poster-play',
  '.top-home', '.ix-cover', '.poster-art', '.ix-title', '.spot-title', '.mini-title', '.ix-search',
].join(',');

let started = false;
export function startInteract() {
  if (started || typeof document === 'undefined') return;
  started = true;
  const timers = new WeakMap<Element, number>();
  const pop = (el: Element | null) => {
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const hit = el.closest(SEL);
    if (!hit) return;
    clearTimeout(timers.get(hit));
    hit.removeAttribute('data-pop');
    void (hit as HTMLElement).offsetWidth; // restart the animation on rapid clicks
    hit.setAttribute('data-pop', '');
    timers.set(hit, window.setTimeout(() => hit.removeAttribute('data-pop'), 480));
  };
  document.addEventListener('pointerdown', (e) => pop(e.target as Element), { passive: true, capture: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') pop(e.target as Element);
  }, { passive: true, capture: true });
}
