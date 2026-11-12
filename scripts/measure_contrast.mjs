// Measures WCAG contrast of the constant text colours against the three plates, under each
// essence's glass, with the shader's night/day grade and a "peak" mode (flame flicker at its
// brightest, glint sweep on, prism on dawn). Dev tool, no output files.
// Run: node scripts/measure_contrast.mjs   (needs sharp, already a dependency)
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'scene');
const W = 336;
const H = 224;
const NAMES = ['candle', 'chrome', 'dawn'];
const GLASS = { candle: [40, 8, 14, 0.58], chrome: [6, 10, 16, 0.62], dawn: [70, 46, 52, 0.42] };
const TEXT = { bone: '#e7e9ea', ink2: '#d4d8dc', ink3: '#c9cdd2' };
const FLOOR = [4, 4, 7]; // rgb(4 4 7), the floor in essence.css
const FS = Number(process.env.FLOOR_SHARE ?? 0.55); // share of the floor in the text-glass mix (essence.css color-mix)

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const clamp = (v) => Math.min(1, Math.max(0, v));

async function load(file, ch = 3) {
  const { data } = await sharp(join(root, file)).removeAlpha().resize(W, H, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  return data; // RGB bytes
}

// the grade from the scene shader, d = 0 night, 1 day
function grade(name, c, d) {
  const [r, g, b] = c;
  if (name === 'candle') {
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    const night = [r * 1.08, g * 1.0, b * 0.9];
    const sep = [l * 1.12, l * 0.95, l * 0.75];
    const day = [(r + (sep[0] - r) * 0.5) * 1.05, (g + (sep[1] - g) * 0.5) * 1.05, (b + (sep[2] - b) * 0.5) * 1.05];
    return night.map((v, i) => v + (day[i] - v) * d);
  }
  if (name === 'chrome') {
    const night = [r * 0.8, g * 0.88, b * 1.05];
    const day = [r * 1.02, g * 1.04, b * 1.08];
    return night.map((v, i) => v + (day[i] - v) * d);
  }
  const night = [r * 0.74 + 0.02, g * 0.8 + 0.01, b * 1.08 + 0.05];
  const day = [r * 1.1, g * 1.02, b * 0.86];
  return night.map((v, i) => v + (day[i] - v) * d);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const rows = [];

for (const name of NAMES) {
  const plate = await load(`room-${name}.webp`);
  const mask = await load(`mask-${name}.png`);
  for (const mode of ['night', 'day', 'night+peak', 'day+peak']) {
    const d = mode.startsWith('day') ? 1 : 0;
    const peak = mode.endsWith('peak');
    // background pixels after grade (and peak effects), 0..1
    const px = [];
    for (let i = 0; i < W * H; i++) {
      let c = [plate[i * 3] / 255, plate[i * 3 + 1] / 255, plate[i * 3 + 2] / 255];
      if (peak) {
        const mr = mask[i * 3] / 255;
        const mb = mask[i * 3 + 2] / 255;
        c = c.map((v, k) => v * (1 + mr * 0.28 * 1.5) + mb * 0.45 * [1, 0.95, 0.9][k]);
      }
      c = grade(name, c, d).map(clamp);
      if (peak && name === 'dawn') c = c.map((v) => clamp(v + 0.14 * (1 - 0.6 * d) * 1.6)); // prism at its brightest
      px.push(c);
    }
    const skins = {
      bare: (c) => c,
      ...Object.fromEntries(NAMES.map((n) => [`glass-${n}`, (c) => { const [gr, gg, gb, ga] = GLASS[n]; return [gr / 255 * ga + c[0] * (1 - ga), gg / 255 * ga + c[1] * (1 - ga), gb / 255 * ga + c[2] * (1 - ga)]; }])),
      // text-bearing surfaces (search, row, bar) mix their glass 72/28 with an opaque near-black floor
      ...Object.fromEntries(NAMES.map((n) => [`text-glass-${n}`, (c) => {
        const [gr, gg, gb, ga0] = GLASS[n];
        const ga = ga0 * (1 - FS) + FS;
        const f = (gc, fl) => (gc / 255 * ga0 * (1 - FS) + fl / 255 * FS) / ga;
        return [f(gr, FLOOR[0]) * ga + c[0] * (1 - ga), f(gg, FLOOR[1]) * ga + c[1] * (1 - ga), f(gb, FLOOR[2]) * ga + c[2] * (1 - ga)];
      }])),
    };
    for (const [skin, fn] of Object.entries(skins)) {
      const L = px.map((c) => { const o = fn(c); return lum(o[0], o[1], o[2]); }).sort((a, b) => a - b);
      const hi = { max: L[L.length - 1], p99: pct(L, 0.99), med: pct(L, 0.5) };
      const out = { plate: name, mode, skin };
      for (const [tn, th] of Object.entries(TEXT)) {
        const lt = lum(...hex(th));
        const cr = (lb) => ((Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05)).toFixed(2);
        out[tn] = { worst: cr(hi.max), p99: cr(hi.p99), median: cr(hi.med) };
      }
      rows.push(out);
    }
  }
}

console.log('plate   mode        skin         bone(worst/p99/med)    ink2(worst/p99/med)    ink3(worst/p99/med)');
for (const r of rows) {
  const f = (x) => `${x.worst}/${x.p99}/${x.median}`.padEnd(21);
  console.log(`${r.plate.padEnd(7)} ${r.mode.padEnd(11)} ${r.skin.padEnd(12)} ${f(r.bone)}  ${f(r.ink2)}  ${f(r.ink3)}`);
}
// summary: worst "p99" ratio for ink3 and bone over glass skins (the surfaces text sits on)
for (const tn of ['bone', 'ink3']) {
  const glass = rows.filter((r) => r.skin.startsWith('text-glass'));
  const worst = glass.reduce((m, r) => (+r[tn].p99 < +m[tn].p99 ? r : m));
  console.log(`lowest p99 ${tn} on text glass: ${worst[tn].p99} (${worst.plate}, ${worst.mode}, ${worst.skin})`);
}
