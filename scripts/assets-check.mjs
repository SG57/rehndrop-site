// Asset hygiene gate: npm run assets:check (exit 1 on any finding).
// Fails when
// - an image carries EXIF, XMP, IPTC, C2PA/JUMBF, comments or PNG text chunks;
// - an SVG carries <title>, <desc>, <metadata>, editor namespaces, comments or editor-style ids;
// - a source file name isn't a plain part name (lowercase words, digits, hyphens);
// - an image that sits behind text (public/brand/velvet*, plate*, room*) isn't in the
//   BACKDROPS table of scripts/legibility.mjs, or names a device run that doesn't exist there;
// - a scene plate or mask (public/scene room-*.webp, mask-*.png) is missing metadata-free, has a name that
//   isn't plain, is over its 120 KB budget, or isn't covered by the essence veil audit in scripts/legibility.mjs
//   (a missing plate or mask is an explicit SKIP line, counted at the end, never a silent pass);
// - a built dist/ ships source maps;
// - public/ or dist/ carries a video file (the site hosts none).
// Sources: public/ and src/assets/. dist/ is scanned too when it exists (generated names are
// exempt from the name rule).
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, basename } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg']);
const PLAIN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)+$/;
const problems = [];
const flag = (file, why) => problems.push(`${relative(ROOT, file).replace(/\\/g, '/')}: ${why}`);

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const ascii = (b, from, len) => b.toString('latin1', from, from + len);

function jpeg(b) {
  const found = [];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // image data starts: no more metadata segments
    const len = b.readUInt16BE(i + 2);
    const body = ascii(b, i + 4, Math.min(len - 2, 40));
    if (marker === 0xe1 && body.startsWith('Exif')) found.push('EXIF');
    else if (marker === 0xe1 && body.startsWith('http://ns.adobe.com/xap')) found.push('XMP');
    else if (marker === 0xe1) found.push('APP1 data');
    else if (marker === 0xed) found.push('IPTC (APP13)');
    else if (marker === 0xeb) found.push('JUMBF/C2PA (APP11)');
    else if (marker === 0xfe) found.push('comment');
    i += 2 + len;
  }
  return found;
}

function png(b) {
  const found = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = ascii(b, i + 4, 4);
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) found.push(`${type} chunk`);
    else if (type === 'eXIf') found.push('EXIF');
    else if (type === 'caBX') found.push('C2PA');
    else if (type === 'tIME') found.push('tIME chunk');
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return found;
}

function webp(b) {
  const found = [];
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP') return ['not a RIFF/WEBP file'];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = b.readUInt32LE(i + 4);
    if (type === 'EXIF') found.push('EXIF');
    else if (type === 'XMP ') found.push('XMP');
    i += 8 + len + (len & 1);
  }
  return found;
}

function gif(b) {
  const s = b.toString('latin1');
  const found = [];
  if (s.includes('\x21\xfe')) found.push('comment extension (possible)');
  if (s.includes('XMP DataXMP')) found.push('XMP');
  return found;
}

function generic(b) {
  const s = b.toString('latin1');
  const found = [];
  if (s.includes('Exif\0\0')) found.push('EXIF');
  if (s.includes('<x:xmpmeta')) found.push('XMP');
  if (s.includes('jumb') && s.includes('c2pa')) found.push('C2PA');
  return found;
}

const EDITOR_ID = /^(?:path|g|rect|circle|ellipse|line|polygon|polyline|layer|svg|defs|stop|lineargradient|radialgradient|text|tspan|image|use|mask|clippath|filter|group|shape)[-_]?\d+$/i;
function svg(text) {
  const found = [];
  if (/<title[\s>]/i.test(text)) found.push('<title>');
  if (/<desc[\s>]/i.test(text)) found.push('<desc>');
  if (/<metadata[\s>]/i.test(text)) found.push('<metadata>');
  if (/(sodipodi|inkscape|sketch|xmlns:(dc|cc|rdf|serif|xlink:href=["']data))/i.test(text)) found.push('editor data');
  if (/<!--/.test(text)) found.push('comment');
  if (/data-name=/i.test(text)) found.push('data-name');
  for (const m of text.matchAll(/\bid=["']([^"']+)["']/g)) {
    const id = m[1];
    if (EDITOR_ID.test(id) || /[A-Z_ ]/.test(id)) found.push(`id "${id}"`);
  }
  return found;
}

async function scan(dir, { names }) {
  if (!existsSync(dir)) return;
  for await (const file of walk(dir)) {
    const ext = extname(file).toLowerCase();
    if (names && !PLAIN.test(basename(file)) && IMAGES.has(ext)) flag(file, 'not a plain part name');
    if (!IMAGES.has(ext)) continue;
    const b = await readFile(file);
    let found;
    if (ext === '.jpg' || ext === '.jpeg') found = jpeg(b);
    else if (ext === '.png') found = png(b);
    else if (ext === '.webp') found = webp(b);
    else if (ext === '.gif') found = gif(b);
    else if (ext === '.svg') found = svg(b.toString('utf8'));
    else found = generic(b);
    for (const f of new Set(found)) flag(file, f);
  }
}

await scan(join(ROOT, 'public'), { names: true });
await scan(join(ROOT, 'src', 'assets'), { names: true });
const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  await scan(dist, { names: false });
  for await (const file of walk(dist)) if (file.endsWith('.map')) flag(file, 'source map in the build');
}

// the site hosts no video: reels and videos are posters that link out
for (const d of [join(ROOT, 'public'), dist]) {
  if (!existsSync(d)) continue;
  for await (const file of walk(d)) if (/\.(mp4|m4v|mov|webm)$/i.test(file)) flag(file, 'self-hosted video');
}

// every image behind text is listed in legibility.mjs, against a device run that exists there
const leg = await readFile(join(ROOT, 'scripts', 'legibility.mjs'), 'utf8');
const table = /const BACKDROPS = (\{[^}]*\});/.exec(leg);
const backdrops = table ? JSON.parse(table[1].replace(/'/g, '"').replace(/,\s*}/, '}')) : {};
const devices = new Set([...leg.matchAll(/\[\s*'([a-z0-9-]+)',\s*\d+,\s*\d+/g)].map((m) => m[1]));
const brand = join(ROOT, 'public', 'brand');
for (const name of await readdir(brand)) {
  if (!/^(velvet|plate|room)/.test(name)) continue;
  if (!(name in backdrops)) flag(join(brand, name), 'sits behind text but scripts/legibility.mjs BACKDROPS does not list it');
  else if (!devices.has(backdrops[name])) flag(join(brand, name), `legibility device "${backdrops[name]}" does not exist`);
}
for (const name of Object.keys(backdrops)) if (!existsSync(join(brand, name))) problems.push(`scripts/legibility.mjs BACKDROPS lists a missing file: ${name}`);

// the scene: three plates and three masks, each plain-named, metadata-free (scanned above, with the rest of
// public/), and under budget; the veil audit in legibility.mjs must cover every essence
const SCENE_BUDGET = 120 * 1024;
const ESSENCE_NAMES = ['candle', 'chrome', 'dawn'];
const sceneDir = join(ROOT, 'public', 'scene');
const sceneSkips = [];
let sceneChecked = 0;
for (const [kind, ext] of [['room', 'webp'], ['mask', 'png']]) {
  for (const e of ESSENCE_NAMES) {
    const name = `${kind}-${e}.${ext}`;
    const file = join(sceneDir, name);
    if (!existsSync(file)) { sceneSkips.push(`public/scene/${name} is missing (not checked)`); continue; }
    sceneChecked++;
    const b = await readFile(file);
    if (!PLAIN.test(name)) flag(file, 'not a plain part name');
    if (b.length > SCENE_BUDGET) flag(file, `${(b.length / 1024).toFixed(1)} KB is over the 120 KB budget`);
    const found = ext === 'webp' ? webp(b) : png(b);
    for (const f of new Set(found)) flag(file, f);
  }
}
if (existsSync(sceneDir)) {
  for (const name of await readdir(sceneDir)) {
    if (!/^(room|mask)-(candle|chrome|dawn)\.(webp|png)$/.test(name)) flag(join(sceneDir, name), 'unexpected file in public/scene (plates are room-<essence>.webp, masks mask-<essence>.png)');
  }
}
if (sceneChecked) {
  const veil = /ESSENCES\s*=\s*\[\s*'candle'\s*,\s*'chrome'\s*,\s*'dawn'\s*\]/.test(leg) && leg.includes('rehndrop:essence');
  if (!veil) problems.push('scripts/legibility.mjs does not audit text over each scene plate (ESSENCES swell loop missing)');
}

const checked = (await Promise.all(['public', 'src/assets'].map(async (d) => {
  let n = 0;
  if (existsSync(join(ROOT, d))) for await (const f of walk(join(ROOT, d))) if (IMAGES.has(extname(f).toLowerCase())) n++;
  return n;
}))).reduce((a, b) => a + b, 0);
if (problems.length) {
  console.log(`FAIL: ${problems.length} finding(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
for (const m of sceneSkips) console.log(`SKIP ${m}`);
console.log(`scene: ${sceneChecked}/6 plates and masks checked (metadata, plain names, 120 KB budget)${sceneSkips.length ? `; ${sceneSkips.length} SKIPPED, not passed` : ''}`);
console.log(`assets ok: ${checked} source images${existsSync(dist) ? ' and dist/' : ''} carry no metadata, names are plain, backdrops are covered`);
