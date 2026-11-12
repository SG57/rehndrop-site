// The essence compass (EssenceCompass.astro): which essence leads, shown by the three glyphs;
// a click or Enter on one goes to that essence's index section. Also keeps the mini player's
// essence glyph in step with the track in the bar. No timers and no frame loop: it listens to
// `rehndrop:essence` (essence-ui.ts, about 4 Hz while something changes) and writes the DOM only
// when the leader changes. Time comes from clock.ts through essence.ts, never Math.random.
import { navigate } from 'astro:transitions/client';
import { ESSENCES, timeCycleSwell, type Essence } from '../lib/essence';
import { wallNow } from './clock';
import { reducedMotion } from './drive';

let started = false;
let leader: Essence = 'candle';
let haveLeader = false;
let rooms: Record<string, string> = {};
const watched = new WeakSet<Element>();

const lead = (swell: ArrayLike<number>): Essence | null => {
  let best = -1;
  let at = -1;
  for (let i = 0; i < 3; i++) {
    const v = swell[i] ?? 0;
    if (v > best + 1e-6) {
      best = v;
      at = i;
    }
  }
  return best > 0.02 ? ESSENCES[at] : null;
};

const paint = () => {
  if (!haveLeader) return;
  document.querySelectorAll<HTMLElement>('[data-compass]').forEach((c) => {
    if (c.dataset.on !== leader) c.dataset.on = leader;
  });
};

const setLeader = (e: Essence | null) => {
  if (e && (!haveLeader || e !== leader)) {
    leader = e;
    haveLeader = true;
  }
  paint();
};

// the mini player persists across pages: its glyph follows the title link the player writes
const syncMini = () => {
  const mini = document.querySelector<HTMLElement>('[data-mini]');
  const title = mini?.querySelector<HTMLAnchorElement>('[data-mini-title]');
  if (!mini || !title) return;
  const apply = () => {
    const slug = (title.getAttribute('href') || '').replace(/\/+$/, '').split('/').pop() ?? '';
    const room = rooms[slug];
    if (room) mini.dataset.ess = room;
    else delete mini.dataset.ess;
  };
  apply();
  if (watched.has(title)) return;
  watched.add(title);
  new MutationObserver(apply).observe(title, { attributes: true, attributeFilter: ['href'] });
};

// the header compass steps aside while the large one on the home page is on screen
let homeSeen: IntersectionObserver | null = null;
const watchHome = () => {
  homeSeen?.disconnect();
  delete document.documentElement.dataset.compassHome;
  const big = document.querySelector('.compass--home');
  if (!big || typeof IntersectionObserver === 'undefined') return;
  homeSeen = new IntersectionObserver((es) => {
    const on = es[es.length - 1]?.isIntersecting;
    if (on) document.documentElement.dataset.compassHome = '';
    else delete document.documentElement.dataset.compassHome;
  });
  homeSeen.observe(big);
};

const refresh = () => {
  watchHome();
  try {
    rooms = JSON.parse(document.getElementById('room-map')?.textContent || '{}');
  } catch {
    rooms = {};
  }
  const snap = window.__rehndrop?.scene?.swell;
  setLeader(haveLeader ? null : lead(snap && snap.length ? snap : timeCycleSwell(wallNow() / 1000)));
  syncMini();
};

const go = (essence: string) => {
  const sec = document.querySelector<HTMLElement>(`[data-essence-section="${essence}"]`);
  const base = (window.__rehndrop as { base?: string } | undefined)?.base ?? '/';
  if (!sec) {
    // no such section on this page (a track page, the 404): the home page, at that lane
    const lane = ({ candle: 'detox', chrome: 'heavy', dawn: 'pretty' } as Record<string, string>)[essence];
    void navigate(`${base}#${lane}`);
    return;
  }
  // a search or a letter that folded the section away clears first, as the in-page jumps do
  if (sec.closest('[hidden]')) {
    const search = document.querySelector<HTMLInputElement>('[data-search]');
    if (search) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
  }
  sec.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const head = sec.querySelector<HTMLElement>('.ix-h') ?? sec;
  if (!head.hasAttribute('tabindex')) head.setAttribute('tabindex', '-1');
  head.focus({ preventScroll: true });
  history.replaceState(history.state, '', `#${sec.id}`);
};

export function startCompass() {
  if (started) {
    refresh();
    return;
  }
  started = true;
  document.addEventListener('rehndrop:essence', (e) => {
    const d = (e as CustomEvent<{ swell?: ArrayLike<number> }>).detail;
    if (d?.swell) setLeader(lead(d.swell));
  });
  document.addEventListener('astro:page-load', refresh);
  document.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-compass-go]');
    if (!b) return;
    e.preventDefault();
    go(b.dataset.compassGo!);
  });
  refresh();
}
