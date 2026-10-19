// One <audio> element for every preview on the page. Plain media playback on purpose:
// Web Audio is muted by the iPhone ringer switch and has gone silent in WebKit before,
// so the visuals read precomputed envelopes against audio.currentTime instead of
// analysing live sound.
//
// The element is the real <audio data-audio> in Base.astro, marked transition:persist, so the
// client router carries the same element (and whatever it is playing) from page to page. This
// module starts once per visit; each page's player-data slice is folded in by updateTracks.
import { drive, IDLE, dyeLevel, hexToRgb, reducedMotion } from './drive';
import { hash32 } from './clock';

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
// what shoves on a hit; must match the `.kick ...` selector in global.css
const KICKS = '.lens, .r-stage, .spot-cover.is-live, .track-cover.is-live';

// Same force for everything, but each element shoves along its own angle: within 75 degrees
// of straight down so it still lands like a hit, spread by the golden ratio from a start that
// is hashed from the song and the hit, with alternating twist, so nothing ever moves in unison
// and the same hit always lands the same way
const aimKicks = (key: string) => {
  const seed = hash32(key) / 4294967296;
  document.querySelectorAll<HTMLElement>(KICKS).forEach((el, i) => {
    const deg = 90 + (((seed + i * 0.618034) % 1) * 150 - 75);
    const a = (deg * Math.PI) / 180;
    el.style.setProperty('--ux', Math.cos(a).toFixed(3));
    el.style.setProperty('--uy', Math.sin(a).toFixed(3));
    el.style.setProperty('--spin', (i + Math.round(seed * 10)) % 2 ? '-1' : '1');
  });
};

export interface Player {
  play: (slug: string) => void;
  playing: () => boolean;
  has: (slug: string) => boolean;
  updateTracks: (next: PlayerTrack[]) => void;
}

const clockText = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

export function startPlayer(tracks: PlayerTrack[], base: string, velvet = 'little'): Player {
  const dye = dyeLevel(velvet);
  const bySlug = new Map(tracks.map((t) => [t.slug, t]));
  const audio = document.querySelector<HTMLAudioElement>('[data-audio]') ?? new Audio();
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
  const scrubbers = () => document.querySelectorAll<HTMLInputElement>('input[data-scrub]');
  let dragging: HTMLInputElement | null = null;
  let lastSecond = -1;

  // a scrubber is a native range input; its wrapper draws the fill from --p
  const showScrub = (s: HTMLInputElement, t: number, total: number) => {
    if (s !== dragging) s.value = String(t);
    s.setAttribute('aria-valuetext', `${clockText(t)} of ${clockText(total)}`);
    const wrap = s.closest<HTMLElement>('[data-scrub-wrap]');
    wrap?.style.setProperty('--p', (total ? Math.min(1, t / total) : 0).toFixed(4));
    const time = wrap?.querySelector<HTMLElement>('[data-scrub-time]');
    if (time) time.textContent = `${clockText(t)} / ${clockText(total)}`;
  };

  const paintScrubbers = () => {
    scrubbers().forEach((s) => {
      const on = !!current && s.dataset.scrub === current.slug;
      const total = Number(s.max) || 30;
      showScrub(s, on ? audio.currentTime || 0 : 0, total);
    });
  };

  const paint = () => {
    document.querySelectorAll<HTMLElement>('[data-play]').forEach((b) => {
      const on = !!current && b.dataset.play === current.slug;
      b.classList.toggle('is-active', on);
      b.classList.toggle('is-playing', on && !audio.paused);
      b.setAttribute('aria-pressed', String(on && !audio.paused));
      if (!on) b.style.removeProperty('--p');
      else b.style.setProperty('--p', Math.min(1, audio.currentTime / (audio.duration || current!.duration || 30)).toFixed(4));
    });
    // only the covers of the song that is actually playing may bounce or kick
    document.querySelectorAll<HTMLElement>('[data-cover]').forEach((c) => {
      c.classList.toggle('is-live', !!current && !audio.paused && c.dataset.cover === current.slug);
    });
    if (bar) {
      bar.hidden = !current;
      bar.classList.toggle('is-playing', !!current && !audio.paused);
    }
    // the page keeps a band free at the bottom while the bar shows
    root.classList.toggle('has-mini', !!current);
    if (barToggle) barToggle.setAttribute('aria-label', audio.paused ? 'play' : 'pause');
    paintScrubbers();
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
    const second = Math.floor(t);
    scrubbers().forEach((s) => {
      if (s.dataset.scrub !== current!.slug) return;
      if (s !== dragging) s.value = String(t);
      const wrap = s.closest<HTMLElement>('[data-scrub-wrap]');
      wrap?.style.setProperty('--p', Math.min(1, t / (Number(s.max) || 30)).toFixed(4));
      // words only change once a second; screen readers and layout both thank us
      if (second !== lastSecond) showScrub(s, t, Number(s.max) || 30);
    });
    lastSecond = second;

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
          aimKicks(`${current!.slug}:${k}`);
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

  // a seek re-arms every hit and seam after the new position and settles the ones before it,
  // so jumping back replays a hit and jumping past one never fires it late
  audio.addEventListener('seeked', () => {
    if (!current) return;
    const t = audio.currentTime;
    fired.clear();
    turned.clear();
    current.hits.forEach((h, k) => h < t - 0.05 && fired.add(k));
    current.turns.forEach((u, j) => u < t - 0.05 && turned.add(j));
    lastSecond = -1;
    paintScrubbers();
  });

  const seek = (slug: string, to: number) => {
    const t = bySlug.get(slug);
    if (!t || !t.src) return;
    const at = Math.max(0, Math.min(to, (t.duration || 30) - 0.25));
    if (current?.slug !== slug) play(slug); // starts it, inside the same input event
    else if (audio.paused) void audio.play().catch(() => {});
    try {
      audio.currentTime = at;
    } catch {
      /* not seekable yet: the preview starts from the top */
    }
    lastSecond = -1;
  };

  // the scrubber: drag or arrow by a second; PageUp and PageDown step between the hit marks
  document.addEventListener('pointerdown', (e) => {
    const s = (e.target as Element).closest<HTMLInputElement>('input[data-scrub]');
    if (s) dragging = s;
  });
  document.addEventListener('pointerup', () => (dragging = null));
  document.addEventListener('pointercancel', () => (dragging = null));
  document.addEventListener('input', (e) => {
    const s = (e.target as Element).closest<HTMLInputElement>('input[data-scrub]');
    if (s) seek(s.dataset.scrub!, Number(s.value));
  });
  document.addEventListener('keydown', (e) => {
    const s = (e.target as Element).closest?.<HTMLInputElement>('input[data-scrub]');
    if (!s) return;
    const slug = s.dataset.scrub!;
    const t = bySlug.get(slug);
    if (!t) return;
    const now = current?.slug === slug ? audio.currentTime : Number(s.value) || 0;
    let to: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = now + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = now - 1;
    else if (e.key === 'PageDown') to = t.hits.find((h) => h > now + 0.5) ?? (t.duration || 30);
    else if (e.key === 'PageUp') to = [...t.hits].reverse().find((h) => h < now - 0.5) ?? 0;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = (t.duration || 30) - 0.25;
    if (to === null) return;
    e.preventDefault();
    s.value = String(Math.max(0, to));
    seek(slug, to);
    showScrub(s, Math.max(0, to), Number(s.max) || 30);
  });

  return {
    play,
    playing: () => !!current && !audio.paused,
    has: (slug) => !!bySlug.get(slug)?.src,
    // each page ships only its own slice; folding it in keeps a track that started on an
    // earlier page known, then the new page's buttons and scrubbers take the live state
    updateTracks(next) {
      for (const t of next) bySlug.set(t.slug, t);
      lastSecond = -1;
      paint();
    },
  };
}
