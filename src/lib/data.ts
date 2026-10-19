// Build-time data: the local export (catalog.json) merged with what is live right now.
// Apple and YouTube are fetched on every build (the deploy workflow rebuilds on a
// schedule), so a release that goes live shows up without anyone touching the site.
// Every fetch has a committed snapshot to fall back on; a dead network never breaks a build.
import type { ImageMetadata } from 'astro';
import catalog from '../data/catalog.json';
import appleSnapshot from '../data/apple-snapshot.json';
import curation from '../data/curation.json';
import storeLinks from '../data/store-links.json';
import reelsData from '../data/reels.json';
import lyricsData from '../data/lyrics.json';
import { ARRIVAL_DAYS } from './config';

export type Lane = 'heavy' | 'hybrid' | 'melodic' | null;

export interface Video {
  id: string;
  title: string;
  credit: string | null;
  published: string;
  trackSlug: string | null;
}

export interface Reel {
  id: string;
  track: string;
  title: string;
  url: string;
  postedAt: string;
  poster: ImageMetadata | null;
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
  // liner notes in Cord's words (curation.json "notes").
  // line: his line under the title; note: the second line; quote: a lyric, one sung line per \n
  notes: { line?: string; note?: string; quote?: string } | null;
  // full lyrics, only for slugs in curation.lyrics (copied verbatim by scripts/export_lyrics.py)
  lyrics: string | null;
  preview: { src: string | null; dropAt: number | null; env: string | null; hits: number[]; turns: number[]; duration: number };
  links: { apple: string | null; spotify: string | null; youtube: string; soundcloud: string };
  video: Video | null;
  reels: Reel[];
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
  // "see the real me — rehndrop": the title first, the artist after a dash
  const trailing = /^(.+?)\s+[—–-]\s+rehndrop$/i.exec(t);
  if (trailing) return { name: trailing[1].trim(), credit: null };
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
  const notes = curation.notes as Record<string, { line?: string; note?: string; quote?: string }>;
  // two gates: Cord lists the slug, and the exporter found its canonical lyric file
  const cleared = new Set((curation as { lyrics?: string[] }).lyrics ?? []);
  const exported = (lyricsData as { tracks?: Record<string, { text?: string }> }).tracks ?? {};
  const lyricsFor = (slug: string) => (cleared.has(slug) && exported[slug]?.text?.trim() ? exported[slug].text!.trim() : null);

  const bySlug = new Map<string, Track>();
  const byTitle = new Map<string, Track>();
  const byApple = new Map<number, Track>();

  // exact links, proven by scripts/store_links.py against each platform; search is the fallback
  // `stores` limits a track to where it actually lives (the lil aaron remix: soundcloud, youtube)
  type StoreTrack = { spotify?: string | null; apple?: string | null; youtubeMusic?: string | null; soundcloud?: string | null; stores?: string[] };
  const exact = new Map<string, StoreTrack>(
    Object.entries((storeLinks as { tracks?: Record<string, StoreTrack> }).tracks ?? {}).map(([k, v]) => [norm(k), v]),
  );
  const linksFor = (title: string, apple: string | null) => {
    const x = exact.get(norm(title));
    const q = encodeURIComponent(`rehndrop ${title}`);
    const on = (store: string) => !x?.stores || x.stores.includes(store);
    return {
      apple: on('apple') ? apple ?? x?.apple ?? null : null,
      spotify: on('spotify') ? x?.spotify ?? `https://open.spotify.com/search/${q}` : null,
      youtube:
        x?.youtubeMusic ??
        (topic.has(norm(title)) ? `https://music.youtube.com/watch?v=${topic.get(norm(title))}` : `https://music.youtube.com/search?q=${q}`),
      soundcloud: x?.soundcloud ?? curation.stores.soundcloud,
    };
  };

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
      // Cord's own line under the title wins over the title answer from VOICE.md
      answer: notes[c.slug]?.line ?? answers.get(norm(c.title)) ?? null,
      notes: notes[c.slug] ?? null,
      lyrics: lyricsFor(c.slug),
      preview: {
        src: c.preview?.src ?? c.applePreview ?? null,
        dropAt: c.preview?.src ? c.preview.dropAt ?? null : null,
        env: c.preview?.src ? c.preview.env ?? null : null,
        hits: c.preview?.src ? ((c.preview as { hits?: number[] }).hits ?? (c.preview.dropAt != null ? [c.preview.dropAt] : [])) : [],
        turns: c.preview?.src ? (c.preview as { turns?: number[] }).turns ?? [] : [],
        duration: c.preview?.src ? Number(c.preview.duration) || 30 : 30,
      },
      links: linksFor(c.title, c.appleUrl ?? null),
      video: null,
      reels: [],
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
      known.links.apple = appleUrl; // the exact track (?i=), sharper than ONCE's album link
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
      answer: notes[slug]?.line ?? answers.get(norm(title)) ?? null,
      notes: notes[slug] ?? null,
      lyrics: lyricsFor(slug),
      preview: { src: s.previewUrl ?? null, dropAt: null, env: null, hits: [], turns: [], duration: 30 },
      links: linksFor(title, appleUrl),
      video: null,
      reels: [],
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
      // a credited video only belongs to a track of the same name (the DRUGS remix does)
      const track = byTitle.get(norm(name));
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

  // posted reels (scripts/export_reels.py, newest first); each is a poster that links out
  const posters = import.meta.glob<{ default: ImageMetadata }>('../assets/reels/*.jpg', { eager: true });
  const reels: Reel[] = (reelsData.reels as Array<Omit<Reel, 'poster'> & { poster: string | null }>).map((r) => ({
    ...r,
    poster: r.poster ? posters[`../assets/${r.poster}`]?.default ?? null : null,
  }));
  for (const r of reels) bySlug.get(r.track)?.reels.push(r);

  const listedSpotlight = curation.spotlight.map((s) => bySlug.get(s)).filter((t): t is Track => !!t);
  const front = arrival(tracks, bySlug, listedSpotlight);
  const spotlight = front ? [front, ...listedSpotlight.filter((t) => t !== front)] : listedSpotlight;
  const picks = curation.picks.map((s) => bySlug.get(s)).filter((t): t is Track => !!t);

  return { tracks, bySlug, videos, spotlight, picks, reels };
}

// which track leads the stage on arrival: Cord's pin, else the newest current release while it
// is ARRIVAL_DAYS old or less, else the first of his spotlight. Computed at build; the deploy
// rebuilds every 6 hours, so the window closes on its own.
function arrival(tracks: Track[], bySlug: Map<string, Track>, spotlight: Track[], now = Date.now()) {
  const pinned = (curation as { arrival?: string | null }).arrival;
  if (pinned && bySlug.has(pinned)) return bySlug.get(pinned)!;
  const newest = tracks.find((t) => t.era === 'current' && t.released);
  if (newest?.released) {
    const age = (now - Date.parse(`${newest.released}T00:00:00Z`)) / 86400000;
    if (age >= 0 && age <= ARRIVAL_DAYS) return newest;
  }
  return spotlight[0] ?? null;
}

export const data = await load();

export const rows = () => {
  const { tracks, videos, bySlug } = data;
  const current = tracks.filter((t) => t.era === 'current');
  const sh = curation.shelves;
  const listed = (slugs: string[]) => slugs.map((s) => bySlug.get(s)).filter((t): t is Track => !!t && t.era === 'current');
  const placed = new Set([...sh.heavy, ...sh.pretty, ...sh.detox]);
  // anything live that no list mentions yet (a fresh release) lands on its lane's shelf
  const unplaced = (pred: (t: Track) => boolean) => current.filter((t) => !placed.has(t.slug) && pred(t));
  return {
    newest: current.slice(0, sh.newCount),
    heavy: [...listed(sh.heavy), ...unplaced((t) => t.lane === 'heavy' || t.lane === 'hybrid')],
    pretty: [...listed(sh.pretty), ...unplaced((t) => t.lane === 'melodic' || t.lane === null)],
    detox: listed(sh.detox),
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
