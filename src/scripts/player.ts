// One <audio> element for every preview on the page. Plain media playback on purpose:
// Web Audio is muted by the iPhone ringer switch and has gone silent in WebKit before,
// so the visuals read precomputed envelopes against audio.currentTime instead of
// analysing live sound.
import { drive, IDLE, hexToRgb, reducedMotion } from './drive';

export interface PlayerTrack {
  slug: string;
  title: string;
  src: string | null;
  env: string | null;
  dropAt: number | null;
  bpm: number | null;
  accent: string;
  thumb: string;
  apple: string | null;
  spotify: string;
  youtube: string;
  href: string;
}

interface Envelope {
  rate: number;
  energy: number[];
  low: number[];
}

const NEUTRAL = hexToRgb('#c9ced6');

export function startPlayer(tracks: PlayerTrack[], base: string) {
  const bySlug = new Map(tracks.map((t) => [t.slug, t]));
  const audio = new Audio();
  audio.preload = 'none';

  const bar = document.querySelector<HTMLElement>('[data-mini]');
  const barTitle = bar?.querySelector<HTMLAnchorElement>('[data-mini-title]');
  const barThumb = bar?.querySelector<HTMLImageElement>('[data-mini-thumb]');
  const barToggle = bar?.querySelector<HTMLButtonElement>('[data-mini-toggle]');
  const barApple = bar?.querySelector<HTMLAnchorElement>('[data-mini-apple]');
  const barSpotify = bar?.querySelector<HTMLAnchorElement>('[data-mini-spotify]');
  const barYoutube = bar?.querySelector<HTMLAnchorElement>('[data-mini-youtube]');
  const barClose = bar?.querySelector<HTMLButtonElement>('[data-mini-close]');
  const root = document.documentElement;

  let current: PlayerTrack | null = null;
  let env: Envelope | null = null;
  let raf = 0;
  let prevLo = 0;
  let kicked = false;
  const envCache = new Map<string, Promise<Envelope | null>>();

  const loadEnv = (t: PlayerTrack) => {
    if (!t.env) return Promise.resolve(null);
    if (!envCache.has(t.slug)) {
      envCache.set(
        t.slug,
        fetch(base + t.env)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      );
    }
    return envCache.get(t.slug)!;
  };

  const buttons = (slug: string) => document.querySelectorAll<HTMLElement>(`[data-play="${CSS.escape(slug)}"]`);

  const paint = () => {
    document.querySelectorAll<HTMLElement>('[data-play]').forEach((b) => {
      const on = !!current && b.dataset.play === current.slug;
      b.classList.toggle('is-active', on);
      b.classList.toggle('is-playing', on && !audio.paused);
      b.setAttribute('aria-pressed', String(on && !audio.paused));
      if (!on) b.style.removeProperty('--p');
    });
    if (bar) {
      bar.hidden = !current;
      bar.classList.toggle('is-playing', !!current && !audio.paused);
    }
    if (barToggle) barToggle.setAttribute('aria-label', audio.paused ? 'play' : 'pause');
  };

  const reset = () => {
    cancelAnimationFrame(raf);
    drive.rain = IDLE.rain;
    drive.speed = IDLE.speed;
    drive.flash = 0;
    drive.pulse = 0;
    drive.tint = [...NEUTRAL];
    root.style.setProperty('--pulse', '0');
    kicked = false;
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!current) return;
    const t = audio.currentTime;
    const progress = Math.min(1, t / (audio.duration || 30));
    buttons(current.slug).forEach((b) => b.style.setProperty('--p', progress.toFixed(4)));
    bar?.style.setProperty('--p', progress.toFixed(4));

    let lo = 0.35;
    let en = 0.35;
    if (env) {
      const i = Math.min(env.low.length - 1, Math.max(0, Math.floor(t * env.rate)));
      lo = env.low[i] / 255;
      en = env.energy[i] / 255;
    }

    const barLen = 240 / (current.bpm || 140);
    let surge = 0;
    let pre = 0;
    let hit = 0;
    if (current.dropAt != null) {
      const d = t - current.dropAt;
      if (d < 0 && d > -4 * barLen) pre = 1 - -d / (4 * barLen); // the calm before
      if (d >= 0) {
        surge = d < barLen ? 1 : Math.exp(-(d - barLen) * 0.9);
        hit = Math.exp(-d * 4.5);
        if (!kicked && d < 0.25) {
          kicked = true;
          document.dispatchEvent(new CustomEvent('rehndrop:hit'));
          if (!reducedMotion()) {
            root.classList.remove('kick');
            void root.offsetWidth;
            root.classList.add('kick');
          }
        }
      }
    }
    const beat = lo - prevLo > 0.22 ? 0.3 : 0;
    prevLo = lo;

    drive.rain = IDLE.rain + 0.35 * lo + 0.1 * en + 0.35 * surge - 0.18 * pre;
    drive.speed = IDLE.speed + 2.2 * lo + 2.4 * surge - 0.5 * pre;
    drive.flash = Math.max(hit, beat * (0.4 + 0.6 * surge));
    drive.pulse = Math.max(0.001, lo);
    root.style.setProperty('--pulse', lo.toFixed(3));
  };

  const play = (slug: string) => {
    const t = bySlug.get(slug);
    if (!t || !t.src) return;
    if (current?.slug === slug) {
      if (audio.paused) void audio.play().catch(() => {});
      else audio.pause();
      return;
    }
    current = t;
    env = null;
    kicked = false;
    prevLo = 0;
    audio.src = t.src.startsWith('http') ? t.src : base + t.src;
    // play() inside the tap handler, before any await: iOS only honours it here
    const p = audio.play();
    if (p) p.catch(() => paint());
    loadEnv(t).then((e) => {
      if (current?.slug === t.slug) env = e;
    });
    drive.tint = hexToRgb(t.accent);
    root.style.setProperty('--accent', t.accent);
    if (barTitle) {
      barTitle.textContent = t.title;
      barTitle.href = t.href;
    }
    if (barThumb) barThumb.src = t.thumb;
    if (barApple) {
      barApple.hidden = !t.apple;
      if (t.apple) barApple.href = t.apple;
    }
    if (barSpotify) barSpotify.href = t.spotify;
    if (barYoutube) barYoutube.href = t.youtube;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: 'rehndrop',
        artwork: [{ src: t.thumb, sizes: '192x192', type: 'image/webp' }],
      });
    }
    paint();
  };

  const stop = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    current = null;
    env = null;
    reset();
    root.style.removeProperty('--accent');
    paint();
  };

  audio.addEventListener('playing', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    paint();
  });
  audio.addEventListener('pause', () => {
    cancelAnimationFrame(raf);
    drive.pulse = 0;
    drive.flash = 0;
    drive.rain = IDLE.rain;
    drive.speed = IDLE.speed;
    paint();
  });
  // previews end; nothing auto-advances. the stores are where the rest lives.
  audio.addEventListener('ended', stop);
  audio.addEventListener('error', () => {
    if (current) stop();
  });

  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-play]');
    if (!el) return;
    e.preventDefault();
    play(el.dataset.play!);
  });
  barToggle?.addEventListener('click', () => current && play(current.slug));
  barClose?.addEventListener('click', stop);
  document.addEventListener('rehndrop:pause', () => {
    if (!audio.paused) audio.pause();
  });
}
