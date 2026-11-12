// check_rooms.mjs -- every current-era track should have an explicit pick in curation.room.
//   node scripts/check_rooms.mjs               warns about missing or invalid picks, exits 0
//   ROOMS_STRICT=1 node scripts/check_rooms.mjs   the same findings fail (exit 1)
// Reads the committed catalog.json and curation.json. A track that is live on Apple but not yet in
// catalog.json is reported at build time by src/lib/data.ts (roomWarnings) instead.
// The default rule below mirrors defaultRoom() in src/lib/data.ts; the table printed here is what the
// site uses when a pick is missing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(root, 'src', 'data', f), 'utf8'));
const ROOMS = ['candle', 'chrome', 'dawn'];
const strict = process.env.ROOMS_STRICT === '1';

const catalog = read('catalog.json');
const curation = read('curation.json');
const picks = curation.room ?? {};
const detox = new Set(curation.shelves.detox);
const fallback = (t) => (detox.has(t.slug) ? 'candle' : t.lane === 'melodic' || t.lane == null ? 'dawn' : 'chrome');

const problems = [];
const current = catalog.tracks.filter((t) => t.era === 'current');
// live on Apple but not yet in catalog.json: data.ts gives these a page too (same slug rule, release year 2026 or later)
const norm = (s) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const inCatalog = new Set(catalog.tracks.map((t) => norm(t.title)));
const liveOnly = (JSON.parse(readFileSync(join(root, 'src', 'data', 'apple-snapshot.json'), 'utf8')).results ?? [])
  .filter((r) => r.wrapperType === 'track' && r.kind === 'song' && Number(String(r.releaseDate).slice(0, 4)) >= 2026 && !inCatalog.has(norm(r.trackName)))
  .map((r) => ({ slug: norm(r.trackName.toLowerCase()).replace(/ /g, '-'), lane: null }));
const expected = [...current, ...liveOnly];
for (const t of expected) {
  const pick = picks[t.slug];
  if (pick === undefined) problems.push(`${t.slug}: no pick in curation.room (default would be ${fallback(t)})`);
  else if (!ROOMS.includes(pick)) problems.push(`${t.slug}: invalid pick "${pick}" (use ${ROOMS.join(', ')})`);
}
for (const slug of Object.keys(picks)) {
  if (current.some((t) => t.slug === slug) || liveOnly.some((t) => t.slug === slug)) continue;
  // a track that is live but newer than catalog.json and the Apple snapshot cannot be seen here
  // (data.ts warns at build time if the live feed does not have it either), so it is a note, not a failure
  const old = catalog.tracks.find((t) => t.slug === slug);
  if (old) problems.push(`curation.room lists "${slug}", which is a ${old.era} track (those take no room)`);
  else console.log(`note: curation.room lists "${slug}", not in catalog.json or the Apple snapshot (fine if it is live-only)`);
}

for (const p of problems) console.log(`${strict ? 'FAIL' : 'WARN'}: ${p}`);
console.log(`rooms: ${expected.length} current-era tracks, ${Object.keys(picks).length} explicit picks, ${problems.length} problem(s)${strict ? ' (strict)' : ''}`);
process.exit(strict && problems.length ? 1 : 0);
