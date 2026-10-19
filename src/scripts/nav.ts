// Behaviour that spans pages under the client router. Started once per visit; every listener
// is document- or window-level, so nothing needs attaching again when a page is swapped in.
import type { Player } from './player';
import { reducedMotion } from './drive';
import { TOAST_MS } from '../lib/config';

// The router replaces every attribute on <html> with the next page's. These hold live state
// (the lens is on, a song is playing, its accent, the list view, a pinned clock), so they
// ride across to the incoming document before the swap.
const CARRY_CLASSES = ['js', 'lens-on', 'has-mini', 'is-frozen'];

export function startNav(player: Player) {
  const root = document.documentElement;

  document.addEventListener('astro:before-swap', (e) => {
    const next = (e as unknown as { newDocument: Document }).newDocument.documentElement;
    for (const c of CARRY_CLASSES) if (root.classList.contains(c)) next.classList.add(c);
    const style = root.getAttribute('style');
    if (style) next.setAttribute('style', style);
    if (root.dataset.view) next.dataset.view = root.dataset.view;
  });

  let previousPath = location.pathname;
  let lastPath = location.pathname;
  document.addEventListener('astro:after-swap', () => {
    previousPath = lastPath;
    lastPath = location.pathname;
  });

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target as Element;

    // a poster or any link out: the preview stops before another app takes the sound
    if (t.closest('[data-external]')) {
      document.dispatchEvent(new CustomEvent('rehndrop:pause'));
      return;
    }

    // in-page jumps (skip to tracks, the chips, choose a track): scroll there and move focus
    // with it, so the next Tab starts inside the target; the URL hash follows without a new
    // history entry
    const jump = t.closest<HTMLAnchorElement>('a[href^="#"]');
    const target = jump && document.getElementById(decodeURIComponent(jump.getAttribute('href')!.slice(1)));
    if (jump && target) {
      e.preventDefault();
      // a search or letter that filtered the target away clears first, so the jump lands
      if (target.closest('[hidden]')) {
        const search = document.querySelector<HTMLInputElement>('[data-search]');
        if (search) {
          search.value = '';
          search.dispatchEvent(new Event('input'));
        }
      }
      target.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      history.replaceState(history.state, '', jump.getAttribute('href'));
      return;
    }

    // on the home page the home link does nothing
    const home = t.closest<HTMLAnchorElement>('a[data-home][aria-current="page"]');
    if (home) {
      e.preventDefault();
      return;
    }

    // the back chevron: straight back when the home page is the page we came from, so its
    // scroll position and open sections come back too; otherwise a plain link home
    const back = t.closest<HTMLAnchorElement>('a[data-back]');
    if (back && previousPath === new URL(back.href).pathname && history.length > 1) {
      e.preventDefault();
      history.back();
      return;
    }

    // opening a track starts its preview, but only when nothing else is playing. play()
    // runs here, inside the tap, because iOS only lets audio start in the gesture itself
    const open = t.closest<HTMLElement>('[data-open]');
    if (open && !player.playing() && player.has(open.dataset.open!)) player.play(open.dataset.open!);
  }, true); // capture: ahead of the router's own link handler, which would claim the click first

  // share: the native sheet where there is one, else the link goes on the clipboard
  let toastTimer = 0;
  document.addEventListener('click', async (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-share]');
    if (!b) return;
    const url = b.dataset.shareUrl || location.href;
    const title = b.dataset.shareTitle || document.title;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
      } catch {
        /* dismissed */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      const toast = document.querySelector<HTMLElement>('[data-toast]');
      if (toast) {
        toast.textContent = 'link copied.';
        toast.classList.add('is-on');
        clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          toast.classList.remove('is-on');
          toast.textContent = '';
        }, TOAST_MS);
      }
    } catch {
      /* no clipboard: the address bar still has it */
    }
  });
}

// after a router navigation into a track view, focus its title so a screen reader starts there;
// into an in-page target (`choose a track` from a track view lands on /#index), focus that
export function focusTitle() {
  const title = document.querySelector<HTMLElement>('[data-focus-title]');
  const id = decodeURIComponent(location.hash.slice(1));
  const target = title ?? (id ? document.getElementById(id) : null);
  if (!target) return;
  if (!title && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}
