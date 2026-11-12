// Small structural glue that needs no timers: the spotlight's previous / next buttons step the
// carousel by clicking its own numbered ticks, so ui.ts keeps owning the rotation and the hold.
let started = false;

export function startStructure() {
  if (started) return;
  started = true;
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-spot-step]');
    if (!b) return;
    const ticks = [...(b.closest('[data-spotlight]')?.querySelectorAll<HTMLButtonElement>('[data-tick]') ?? [])];
    if (ticks.length < 2) return;
    const at = Math.max(0, ticks.findIndex((t) => t.classList.contains('is-current')));
    ticks[(at + Number(b.dataset.spotStep) + ticks.length) % ticks.length].click();
  });
}
