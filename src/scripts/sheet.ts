// The contact sheet: a native <dialog> any `[data-contact-open]` control opens. Started once
// per visit with document-level listeners, because the router replaces the dialog per page.
//
// History: opening pushes one entry on the same URL, so Back closes the sheet instead of
// leaving the page. A popstate gate registered in Base.astro's head, ahead of the client
// router's own listener, asks this module first and stops the event whenever the entry was
// the sheet's, so the router never treats closing the sheet as a navigation.
import { TOAST_MS } from '../lib/config';

export function startSheet() {
  const dialog = () => document.querySelector<HTMLDialogElement>('[data-sheet]');
  let opener: HTMLElement | null = null;
  let pushed = false; // our entry is on top of the history stack
  let swallow = false; // the next popstate is our own history.back()
  let toastTimer = 0;

  const open = (from: HTMLElement | null) => {
    const d = dialog();
    if (!d || d.open) return;
    opener = from;
    d.showModal();
    try {
      history.pushState({ ...(history.state ?? {}), sheet: true }, '');
      pushed = true;
    } catch {
      pushed = false;
    }
  };

  const close = () => {
    const d = dialog();
    if (d?.open) d.close(); // the close listener below does the rest
  };

  document.addEventListener('click', (e) => {
    const t = e.target as Element;
    const trigger = t.closest<HTMLElement>('[data-contact-open]');
    if (trigger) {
      e.preventDefault();
      open(trigger);
      return;
    }
    const d = dialog();
    if (!d?.open) return;
    if (t.closest('[data-sheet-close]') || t === d) close();
    else if (t.closest('[data-copy]')) void copy(d);
  });

  // 'close' doesn't bubble; capture on the document catches it from whichever dialog is live
  document.addEventListener('close', (e) => {
    const d = e.target as HTMLElement;
    if (!d.matches?.('[data-sheet]')) return;
    const toast = d.querySelector<HTMLElement>('[data-copied]');
    if (toast) toast.textContent = '';
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    if (pushed) {
      pushed = false;
      swallow = true;
      history.back();
    }
  }, true);

  // Base.astro's head script calls this on every popstate, before the router sees it; true
  // means the entry was the sheet's and the router must not treat it as a navigation
  (window as unknown as { __rehndrop: { popGate?: (e: PopStateEvent) => boolean } }).__rehndrop.popGate = (e) => {
    if (swallow) {
      swallow = false;
      return true;
    }
    const d = dialog();
    if (d?.open) {
      // Back while the sheet is open: the entry we pushed is already gone
      pushed = false;
      d.close();
      return true;
    }
    if ((e.state as { sheet?: boolean } | null)?.sheet && d) {
      // Forward onto the sheet's entry opens it again
      d.showModal();
      pushed = true;
      return true;
    }
    return false;
  };

  const copy = async (d: HTMLDialogElement) => {
    const mail = d.querySelector<HTMLElement>('[data-mail]');
    const toast = d.querySelector<HTMLElement>('[data-copied]');
    const text = mail?.textContent?.trim() ?? '';
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // no clipboard access: select the address so a long-press or ctrl+c finishes the job
      if (mail) {
        const range = document.createRange();
        range.selectNodeContents(mail);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    if (ok && toast) {
      toast.textContent = 'copied.';
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (toast.textContent = ''), TOAST_MS);
    }
  };
}
