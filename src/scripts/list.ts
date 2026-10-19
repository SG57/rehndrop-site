// The index under the stage: search in place, the grid / list view, `more.` and the letter
// strip. Page-local (the client router swaps the index on navigation), so this binds on every
// home page load. Without JS the index is plain HTML: every section open, every track a link.
import { fold } from '../lib/fold';

const VIEW_KEY = 'index-view';

export function startList() {
  const root = document.querySelector<HTMLElement>('[data-index]');
  if (!root) return;
  const input = root.querySelector<HTMLInputElement>('[data-search]');
  const empty = root.querySelector<HTMLElement>('[data-empty]');
  const sections = [...root.querySelectorAll<HTMLElement>('[data-sec]')];
  const letters = [...root.querySelectorAll<HTMLButtonElement>('[data-letter]')];
  const views = [...root.querySelectorAll<HTMLButtonElement>('[data-view-btn]')];
  let letter = '';

  // ---- grid / list, remembered ----
  const setView = (v: string, save: boolean) => {
    const list = v === 'list';
    if (list) document.documentElement.dataset.view = 'list';
    else delete document.documentElement.dataset.view;
    views.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.viewBtn === (list ? 'list' : 'grid'))));
    if (save) {
      try {
        localStorage.setItem(VIEW_KEY, list ? 'list' : 'grid');
      } catch {
        /* storage blocked: the choice lasts for this page */
      }
    }
  };
  setView(document.documentElement.dataset.view === 'list' ? 'list' : 'grid', false);
  views.forEach((b) => b.addEventListener('click', () => setView(b.dataset.viewBtn!, true)));

  // ---- search and letters filter the same way: rows hide, empty sections fold away ----
  const apply = () => {
    const q = fold(input?.value ?? '');
    const active = !!(q || letter);
    let shown = 0;
    for (const sec of sections) {
      let n = 0;
      sec.querySelectorAll<HTMLElement>('[data-title]').forEach((item) => {
        const title = item.dataset.title ?? '';
        const on = !active || (q ? title.includes(q) : title.startsWith(letter) || (letter === '#' && !/^[a-z]/.test(title)));
        item.hidden = !on;
        if (on) n++;
      });
      sec.hidden = active && n === 0;
      sec.classList.toggle('is-filtered', active);
      shown += n;
    }
    if (empty) empty.hidden = !active || shown > 0;
    root.classList.toggle('is-searching', active);
  };

  input?.addEventListener('input', () => {
    if (letter) {
      letter = '';
      letters.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    }
    apply();
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      apply();
    }
  });
  // the form never submits anywhere; Enter just keeps the results where they are
  input?.form?.addEventListener('submit', (e) => {
    e.preventDefault();
    input.blur();
  });

  letters.forEach((b) =>
    b.addEventListener('click', () => {
      letter = letter === b.dataset.letter ? '' : b.dataset.letter!;
      letters.forEach((o) => o.setAttribute('aria-pressed', String(o.dataset.letter === letter)));
      if (input) input.value = '';
      apply();
    }),
  );

  // ---- more. reveals the rest of a section in place, and hands focus to the first new row ----
  root.querySelectorAll<HTMLButtonElement>('[data-more]').forEach((b) =>
    b.addEventListener('click', () => {
      const sec = b.closest<HTMLElement>('[data-sec]');
      if (!sec) return;
      sec.classList.remove('is-capped');
      b.hidden = true;
      sec.querySelector<HTMLElement>('[data-extra] .ix-title, [data-extra] .poster-art')?.focus();
    }),
  );

  // a reload with text still in the box (browser form restore) filters straight away
  if (input?.value) apply();
}
