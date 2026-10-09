// Build-time data: the local export (catalog.json) merged with what is live right now.
// Apple and YouTube are fetched on every build (the deploy workflow rebuilds on a
// schedule), so a release that goes live shows up without anyone touching the site.
// Every fetch has a committed snapshot to fall back on; a dead network never breaks a build.
import type { ImageMetadata } from 'astro';
import catalog from '../data/catalog.json';
import appleSnapshot from '../data/apple-snapshot.json';
import curation from '../data/curation.json';

export type Lane = 'heavy' | 'hybrid' | 'melodic' | null;

export interface Video {
  id: string;
  title: string;
  credit: string | null;
  published: string;
  trackSlug: string | null;
}

export interface Track {
  slug: string;
  title: string;
  era: 'current' | '2021';
  lane: Lane;
  bpm: number | null;
  explicit: boolean;
  released: string | null;
  cover: ImageMetadata | string;
  accent: string;
  answer: string | null;
  preview: { src: string | null; dropAt: number | null; env: string | null };
  links: { apple: string | null; spotify: string; youtube: string; soundcloud: string };
  video: Video | null;
}

const APPLE_ARTIST = 1545317806;
const FETCH_MS = 8000;

export const norm = (s: string) =>
  s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const slugify = (s: string) => norm(s).replace(/ /g, '-');

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

interface AppleSong {
  wrapperType: string;
  kind?: string;
  artistId?: number;
  trackId: number;
  trackName: string;
  releaseDate: string;
  trackViewUrl: string;
  previewUrl?: string;
  artworkUrl100: string;
  trackExplicitness?: string;
}

async function appleSongs(): Promise<AppleSong[]> {
  const text = await fetchText(`https://itunes.apple.com/lookup?id=${APPLE_ARTIST}&entity=song&limit=200`);
  let data: { results?: AppleSong[] } = appleSnapshot as { results?: AppleSong[] };
  if (text) {
    try {
      const live = JSON.parse(text);
      if (Array.isArray(live.results) && live.results.length > 1) data = live;
    } catch {
      /* keep snapshot */
    }
  }
  return (data.results ?? []).filter((r) => r.wrapperType === 'track' && r.kind === 'song');
}

interface FeedEntry {
  id: string;
  title: string;
  published: string;
}

async function youtubeFeed(channel: string): Promise<FeedEntry[] | null> {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`);
  if (!xml) return null;
  const out: FeedEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = /<yt:videoId>([^<]+)</.exec(e)?.[1];
    const title = /<title>([^<]+)</.exec(e)?.[1];
    const published = /<published>([^<]+)</.exec(e)?.[1];
    if (id && title) out.push({ id, title: decodeXml(title), published: (published ?? '').slice(0, 10) });
  }
  return out;
}

const decodeXml = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// "rehndrop - now die (Official Music Video)" -> { name: "now die", credit: null }
// "lil aaron - DRUGS (rehndrop remix)"        -> { name: "DRUGS",   credit: "lil aaron · rehndrop remix" }
function parseVideoTitle(raw: string): { name: string; credit: string | null } {
  let t = raw.replace(/\((official )?(music video|video|visuali[sz]er|lyric video|audio)\)/gi, '').trim();
  const dash = t.split(/\s+-\s+/);
  let artist = 'rehndrop';
  if (dash.length > 1) {
    artist = dash[0].trim();
    t = dash.slice(1).join(' - ').trim();
  }
  const remix = /\(([^)]*remix)\)/i.exec(t);
  if (remix) t = t.replace(remix[0], '').trim();
  const credit = artist.toLowerCase() !== 'rehndrop' || remix
    ? [artist.toLowerCase() !== 'rehndrop' ? artist : null, remix ? remix[1] : null].filter(Boolean).join(' · ')
    : null;
  return { name: t, credit };
}

const covers = import.meta.glob<{ default: ImageMetadata }>('../assets/covers/*.jpg', { eager: true });
const coverFor = (path: string) => covers[`../assets/${path}`]?.default;

type CatalogTrack = (typeof catalog.tracks)[number];

async function load() {
  const [songs, mainFeed, ...topicFeeds] = await Promise.all([
    appleSongs(),
    youtubeFeed(curation.youtube.channel),
    ...curation.youtube.topicChannels.map(youtubeFeed),
  ]);

  // per-track YouTube Music audio: snapshot first, live topic feeds on top
  const topic = new Map<string, string>();
  for (const [title, id] of Object.entries(curation.youtube.topicSnapshot)) topic.set(norm(title), id);
  for (const feed of topicFeeds) for (const e of feed ?? []) topic.set(norm(e.title), e.id);

  const answers = new Map(Object.entries(curation.answers).map(([k, v]) => [norm(k), v]));
  const hidden = new Set(curation.youtube.hide);

  const bySlug = new Map<string, Track>();
  const byTitle = new Map<string, Track>();
  const byApple = new Map<number, Track>();

  const linksFor = (title: string, apple: string | null) => ({
    apple,
    spotify: `https://open.spotify.com/search/${encodeURIComponent(`rehndrop ${title}`)}`,
    youtube: topic.has(norm(title))
      ? `https://music.youtube.com/watch?v=${topic.get(norm(title))}`
      : `https://music.youtube.com/search?q=${encodeURIComponent(`rehndrop ${title}`)}`,
    soundcloud: curation.stores.soundcloud,
  });

  for (const c of catalog.tracks as CatalogTrack[]) {
    const t: Track = {
      slug: c.slug,
      title: c.title,
      era: c.era as Track['era'],
      lane: (c.lane ?? null) as Lane,
      bpm: c.bpm ?? null,
      explicit: !!c.explicit,
      released: c.released ?? null,
      cover: coverFor(c.cover) ?? '',
      accent: c.accent || '#c9ced6',
      answer: answers.get(norm(c.title)) ?? null,
      preview: {
        src: c.preview?.src ?? c.applePreview ?? null,
        dropAt: c.preview?.src ? c.preview.dropAt ?? null : null,
        env: c.preview?.src ? c.preview.env ?? null : null,
      },
      links: linksFor(c.title, c.appleUrl ?? null),
      video: null,
    };
    bySlug.set(t.slug, t);
    byTitle.set(norm(t.title), t);
    if (c.appleTrackId) byApple.set(c.appleTrackId, t);
  }

  // anything live on Apple that the local export hasn't seen yet still gets a page
  for (const s of songs) {
    const known = byApple.get(s.trackId) ?? byTitle.get(norm(s.trackName));
    const appleUrl = s.trackViewUrl.replace(/[?&]uo=\d+/, '');
    if (known) {
      known.released = s.releaseDate.slice(0, 10);
      known.links.apple = appleUrl;
      if (!known.preview.src && s.previewUrl) known.preview.src = s.previewUrl;
      continue;
    }
    const year = Number(s.releaseDate.slice(0, 4));
    const title = year >= 2026 ? s.trackName.toLowerCase() : s.trackName;
    let slug = slugify(title);
    while (bySlug.has(slug)) slug += '-x';
    const t: Track = {
      slug,
      title,
      era: year >= 2026 ? 'current' : '2021',
      lane: null,
      bpm: null,
      explicit: s.trackExplicitness === 'explicit',
      released: s.releaseDate.slice(0, 10),
      cover: s.artworkUrl100.replace('100x100bb', '1200x1200bb'),
      accent: '#c9ced6',
      answer: answers.get(norm(title)) ?? null,
      preview: { src: s.previewUrl ?? null, dropAt: null, env: null },
      links: linksFor(title, appleUrl),
      video: null,
    };
    bySlug.set(slug, t);
    byTitle.set(norm(title), t);
  }

  const tracks = [...bySlug.values()].sort(
    (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.title.localeCompare(b.title),
  );

  const feed = mainFeed && mainFeed.length ? mainFeed : curation.youtube.videoSnapshot;
  const videos: Video[] = feed
    .filter((v) => !hidden.has(v.id))
    .map((v) => {
      const { name, credit } = parseVideoTitle(v.title);
      const track = credit ? undefined : byTitle.get(norm(name));
      const video: Video = {
        id: v.id,
        title: track ? track.title : name,
        credit,
        published: v.published,
        trackSlug: track?.slug ?? null,
      };
      if (track && !track.video) track.video = video;
      return video;
    })
    .sort((a, b) => b.published.localeCompare(a.published));

  const spotlight = curation.spotlight.map((s) => bySlug.get(s)).filter((t): t is Track => !!t);

  return { tracks, bySlug, videos, spotlight };
}

export const data = await load();

export const rows = () => {
  const { tracks, videos } = data;
  const current = tracks.filter((t) => t.era === 'current');
  return {
    newest: current.slice(0, 10),
    heavy: current.filter((t) => t.lane === 'heavy' || t.lane === 'hybrid'),
    pretty: current.filter((t) => t.lane === 'melodic'),
    early: tracks.filter((t) => t.era === '2021'),
    videos,
  };
};

export const related = (t: Track, n = 10) =>
  data.tracks
    .filter((o) => o.slug !== t.slug && o.era === t.era && (t.lane === null || sameRoom(o.lane, t.lane)))
    .slice(0, n);

const sameRoom = (a: Lane, b: Lane) => (a === 'melodic') === (b === 'melodic');

export const fmtDate = (iso: string | null) =>
  iso
    ? new Date(`${iso}T12:00:00Z`)
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
        .toLowerCase()
    : null;

export { curation };
