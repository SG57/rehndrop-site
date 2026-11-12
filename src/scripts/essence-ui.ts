// Themes the real interface from the essence under each element, and tells the scene which
// essence should swell. Every 250 ms: rects are read only for skins an IntersectionObserver
// says are on screen, weights are quantised so a write happens only on a visible step, and on
// the software tier writes are rare. Element lists are cached and refreshed by a
// MutationObserver. No decorative randomness; time comes from clock.ts so ?t= freezes it.
import { angleAt, skinVars, timeCycleSwell, ESSENCES, type Triple, weights } from '../lib/essence';
import { wallNow } from './clock';

const TICK_MS = 250;
const EASE_S = 0.5; // time constant of the local swell ease (the scene eases separately, about 1 s)
const MARGIN = 50; // px beyond the viewport that still counts as visible
const STEPS = 16; // weights snap to 1/16 so skin vars change only on a visible step
const SOFTWARE_WRITE_MS = 2000; // min gap between write passes on the software tier

interface SceneSnapshot {
  tier?: string;
  angle?: (tSec: number) => number;
  hour?: () => number;
  swell?: ArrayLike<number>;
}
declare global {
  interface Window {
    __rehndrop?: { scene?: SceneSnapshot } & Record<string, unknown>;
  }
}

let running = false;

const roomIndex = (v: string | null | undefined) => {
  const i = ESSENCES.indexOf(v as (typeof ESSENCES)[number]);
  return i < 0 ? -1 : i;
};

export function startEssenceUI(): { stop(): void } {
  if (running || typeof document === 'undefined') return { stop() {} };
  running = true;

  const root = document.documentElement;
  const last = new WeakMap<Element, string>();
  const swell: Triple = [0, 0, 0]; // eased local copy, used when the scene has not published its own
  let sent: Triple | null = null;
  let prevT = 0;
  let painted = false;
  let timer = 0;
  let lastWrite = 0;

  // cached element lists, refreshed only when the DOM says they may have changed
  let skins = new Set<HTMLElement>();
  let sections = new Set<HTMLElement>();
  const visibleSkins = new Set<HTMLElement>(); // within MARGIN of the viewport
  const midSections = new Set<HTMLElement>(); // contain the viewport middle line
  let dirty = true;

  const skinIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) visibleSkins.add(en.target as HTMLElement);
        else visibleSkins.delete(en.target as HTMLElement);
      }
    },
    { rootMargin: `${MARGIN}px` },
  );
  // a zero-height band at the viewport middle: intersecting means the section holds the midpoint
  const midIO = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) midSections.add(en.target as HTMLElement);
        else midSections.delete(en.target as HTMLElement);
      }
    },
    { rootMargin: '-50% 0px -50% 0px' },
  );

  const refresh = () => {
    dirty = false;
    const nextSkins = new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-essence-skin]')).filter((el) => !el.closest('[data-essence-lock]')));
    const nextSections = new Set(document.querySelectorAll<HTMLElement>('[data-essence-section]'));
    for (const el of skins) if (!nextSkins.has(el)) { skinIO.unobserve(el); visibleSkins.delete(el); }
    for (const el of nextSkins) if (!skins.has(el)) skinIO.observe(el);
    for (const el of sections) if (!nextSections.has(el)) { midIO.unobserve(el); midSections.delete(el); }
    for (const el of nextSections) if (!sections.has(el)) midIO.observe(el);
    skins = nextSkins;
    sections = nextSections;
  };

  const mo = new MutationObserver(() => { dirty = true; });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-essence-skin', 'data-essence-section', 'data-essence-lock'],
  });

  const tick = () => {
    const reduced = root.dataset.tier === 'reduced';
    if (reduced && painted) {
      stop();
      return;
    }
    if (document.hidden && painted) return;
    if (dirty) refresh();

    const tSec = wallNow() / 1000;
    const dt = prevT ? Math.min(1, tSec - prevT) : 1;
    prevT = tSec;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const snap = window.__rehndrop?.scene;
    const phase = snap?.angle ? snap.angle(tSec) : (tSec * 2 * Math.PI) / 300;
    const hour = snap?.hour ? snap.hour() : new Date(wallNow()).getHours() + new Date(wallNow()).getMinutes() / 60;
    void hour; // the skin maths no longer takes the hour; kept so a future day grade has one source

    // what should swell: the playing track's essence, else the section under the viewport middle, else the slow cycle
    let target: Triple;
    let source: 'track' | 'section' | 'auto' = 'auto';
    const playing = document.querySelector('[data-play].is-active');
    const room = roomIndex(playing?.closest('[data-room]')?.getAttribute('data-room') ?? playing?.getAttribute('data-room'));

    if (room >= 0) {
      target = [0, 0, 0];
      target[room] = 1;
      source = 'track';
    } else {
      let hit = -1;
      for (const s of midSections) {
        hit = roomIndex(s.dataset.essenceSection);
        if (hit >= 0) break;
      }
      if (hit >= 0) {
        target = [0, 0, 0];
        target[hit] = 1;
        source = 'section';
      } else target = timeCycleSwell(tSec);
    }

    // publish to the scene when it changed enough to matter
    if (!sent || target.some((v, i) => Math.abs(v - sent![i]) > 0.005)) {
      sent = [target[0], target[1], target[2]];
      document.dispatchEvent(new CustomEvent('rehndrop:essence', { detail: { swell: sent, source } }));
    }

    // local ease, or follow the scene's own published swell
    const k = 1 - Math.exp(-dt / EASE_S);
    for (let i = 0; i < 3; i++) {
      const goal = snap?.swell ? (snap.swell[i] ?? 0) : target[i];
      swell[i] += (goal - swell[i]) * k;
    }

    // software tier: writes are rare; a skin never written yet is still painted at once
    const now = performance.now();
    const throttled = root.dataset.tier === 'software' && painted && now - lastWrite < SOFTWARE_WRITE_MS;
    if (!throttled) lastWrite = now;

    // one batched read pass over visible skins only, then one write pass
    const list: HTMLElement[] = [];
    for (const el of visibleSkins) if (!throttled || !last.has(el)) list.push(el);
    const rects = list.map((el) => el.getBoundingClientRect());
    for (let i = 0; i < list.length; i++) {
      const r = rects[i];
      const w = weights(angleAt(r.left + r.width / 2, r.top + r.height / 2, vw, vh, 0) + phase, swell);
      const q = w.map((x) => Math.round(x * STEPS) / STEPS);
      const qs = q[0] + q[1] + q[2];
      const v = skinVars([q[0] / qs, q[1] / qs, q[2] / qs]);
      const sig = `${v.a}|${v.g}|${v.e}|${v.r}|${v.glow}`;
      if (last.get(list[i]) === sig) continue;
      last.set(list[i], sig);
      const st = list[i].style;
      st.setProperty('--a', v.a);
      st.setProperty('--g', v.g);
      st.setProperty('--e', v.e);
      st.setProperty('--r', v.r);
      st.setProperty('--glow', v.glow);
    }
    painted = painted || visibleSkins.size > 0 || skins.size === 0; // observers report asynchronously
  };

  const stop = () => {
    window.clearInterval(timer);
    skinIO.disconnect();
    midIO.disconnect();
    mo.disconnect();
    running = false;
  };

  tick();
  timer = window.setInterval(tick, TICK_MS);
  return { stop };
}
