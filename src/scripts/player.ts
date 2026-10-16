// One <audio> element for every preview on the page. Plain media playback on purpose:
// Web Audio is muted by the iPhone ringer switch and has gone silent in WebKit before,
// so the visuals read precomputed envelopes against audio.currentTime instead of
// analysing live sound.
import { drive, IDLE, dyeLevel, hexToRgb, reducedMotion } from './drive';

export interface PlayerTrack {
  slug: string;
  title: string;
  src: string | null;
  env: string | null;
  dropAt: number | null;
  hits: number[]; // seconds into the clip; each gets the calm before, the surge and the kick
  turns: number[]; // seams where one teaser hands to the next
  duration: number;
  bpm: number | null;
  accent: string;
  thumb: string;
  apple: string | null;
  spotify: string | null;
  youtube: string;
  href: string;
}

interface Envelope {
  rate: number;
  energy: number[];
  low: number[];
}

const NEUTRAL = hexToRgb('#c9ced6');

export function startPlayer(tracks: PlayerTrack[], base: string, velvet = 'little') {
  const dye = dyeLevel(velvet);
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
  const fired = new Set<number>();
  const turned = new Set<number>();
  let lastBeat = 0;
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
    // only the covers of the song that is actually playing may bounce or kick
    document.querySelectorAll<HTMLElement>('[data-cover]').forEach((c) => {
      c.classList.toggle('is-live', !!current && !audio.paused && c.dataset.cover === current.slug);
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
    drive.dye = 0;
    root.style.setProperty('--pulse', '0');
    root.style.setProperty('--dye', '0');
    fired.clear();
    turned.clear();
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
    current.hits.forEach((h, k) => {
      const d = t - h;
      if (d < 0 && d > -4 * barLen) pre = Math.max(pre, 1 - -d / (4 * barLen)); // the calm before
      if (d < 0) return;
      surge = Math.max(surge, d < barLen ? 1 : Math.exp(-(d - barLen) * 0.9));
      hit = Math.max(hit, Math.exp(-d * 4.5));
      if (!fired.has(k) && d < 0.25) {
        fired.add(k);
        document.dispatchEvent(new CustomEvent('rehndrop:hit'));
        if (!reducedMotion()) {
          root.classList.remove('kick');
          void root.offsetWidth;
          root.classList.add('kick');
        }
      }
    });
    // the seam between teasers: a wipe across the lens, so the cut reads as intent
    current.turns.forEach((u, j) => {
      if (!turned.has(j) && t >= u && t - u < 0.3) {
        turned.add(j);
        document.dispatchEvent(new CustomEvent('rehndrop:turn'));
      }
    });
    // beats move things (splashes, pulses); only the main hit flashes, so nothing strobes
    const now = performance.now();
    const isBeat = lo - prevLo > 0.2 && now - lastBeat > 280;
    if (isBeat) {
      lastBeat = now;
      document.dispatchEvent(new CustomEvent('rehndrop:beat', { detail: { strength: lo } }));
    }
    prevLo = lo;

    drive.rain = IDLE.rain + 0.5 * lo + 0.15 * en + 0.6 * surge - 0.25 * pre;
    drive.speed = IDLE.speed + 3.4 * lo + 4 * surge - 0.6 * pre;
    drive.flash = Math.max(hit, isBeat ? 0.12 : 0);
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
    fired.clear();
    turned.clear();
    if (bar) {
      bar.querySelectorAll('.mini-turn').forEach((m) => m.remove());
      const track = bar.querySelector('.mini-bar');
      for (const u of t.turns) {
        const m = document.createElement('i');
        m.className = 'mini-turn';
        m.style.left = `${((u / (t.duration || 30)) * 100).toFixed(2)}%`;
        track?.append(m);
      }
    }
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
    if (barSpotify) {
      barSpotify.hidden = !t.spotify;
      if (t.spotify) barSpotify.href = t.spotify;
    }
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
    // the velvet takes the track's colour only while it is actually heard
    drive.dye = dye;
    root.style.setProperty('--dye', String(dye));
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
    paint();
  });
  audio.addEventListener('pause', () => {
    cancelAnimationFrame(raf);
    drive.dye = 0;
    root.style.setProperty('--dye', '0');
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
