// Legibility audit for text that floats on the velvet (no surface behind it).
//   node scripts/legibility.mjs <url> [--json]
// For each text style: scroll it into view with the rain shader running, sample the
// background in a ring just OUTSIDE the text box, and compute the text's contrast against
// the median background (target >= 7:1, WCAG AAA) and against the bright specks, the 90th
// percentile (target >= 4.5:1, AA). Worst instance per style wins.
import { chromium } from 'playwright-core';

const url = process.argv[2];
const SELECTORS = [
  ['bio', '.bio'],
  ['spot title', '.spot.is-current .spot-title'],
  ['spot answer', '.spot.is-current .spot-answer'],
  ['spot line', '.spot.is-current .spot-note'],
  ['shelf title', '.row-title'],
  ['card title', '.card .card-title'],
  ['card caption', '.card .card-sub'],
  ['video caption', '.vcard .card-sub'],
  ['pick line', '.pick-note'],
  ['contact', '.contact-links a'],
  ['email', '.contact-mail'],
  ['footer', '.foot-line'],
  ['track title', '.track-title'],
  ['track line', '.track-info .spot-note'],
  ['track date', '.track-meta'],
];

const b = await chromium.launch({ channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const rows = [];
for (const [dev, w, h, mobile] of [['phone', 393, 852, true], ['laptop', 1440, 900, false]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  for (const path of ['', 't/pop-the-trunk/']) {
    await page.goto(url + path + '?lens', { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
    await page.waitForTimeout(1500);
    for (const [name, sel] of SELECTORS) {
      const els = await page.$$(sel);
      if (!els.length) continue;
      let worst = null;
      for (const el of els.slice(0, 3)) {
        await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(350);
        const box = await el.boundingBox();
        if (!box || box.width < 2 || box.y < 0 || box.y + box.height > h) continue;
        const color = await el.evaluate((e) => getComputedStyle(e).color);
        // sample only what is BEHIND text: hide covers, buttons and every glyph's ink, but keep
        // halos and blooms, which are part of the real backdrop
        const hide = await page.addStyleTag({ content: '.card-art,.vcard-art,.spot-cover,.track-cover,.store,.play,.listen,.r,.mini,.back,.row-btn,.spot-ticks{visibility:hidden!important} *{color:transparent!important}' });
        await page.waitForTimeout(60);
        const png = (await page.screenshot()).toString('base64');
        await hide.evaluate((n) => n.remove());
        const r = await page.evaluate(async ({ png, box, color }) => {
          const img = new Image(); img.src = 'data:image/png;base64,' + png; await img.decode();
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          const L = (r, gg, bb) => 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(bb);
          const pad = 6, ring = 8, xs = [];
          const x0 = Math.max(0, Math.floor(box.x - pad - ring)), y0 = Math.max(0, Math.floor(box.y - pad - ring));
          const x1 = Math.min(c.width, Math.ceil(box.x + box.width + pad + ring)), y1 = Math.min(c.height, Math.ceil(box.y + box.height + pad + ring));
          const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const inside = x >= box.x - pad && x <= box.x + box.width + pad && y >= box.y - pad && y <= box.y + box.height + pad;
            if (inside) continue;
            const i = ((y - y0) * (x1 - x0) + (x - x0)) * 4; xs.push(L(d[i], d[i + 1], d[i + 2]));
          }
          xs.sort((a, b) => a - b);
          const med = xs[Math.floor(xs.length * 0.5)], p90 = xs[Math.floor(xs.length * 0.9)];
          const m = color.match(/[\d.]+/g).map(Number); const a = m.length > 3 ? m[3] : 1;
          const ink = (bg) => L(m[0], m[1], m[2]) * a + bg * (1 - a);
          const cr = (bg) => (ink(bg) + 0.05) / (bg + 0.05);
          return { med: +cr(med).toFixed(1), specks: +cr(p90).toFixed(1) };
        }, { png, box, color });
        if (!worst || r.specks < worst.specks) worst = r;
      }
      if (worst) rows.push({ dev, page: path ? 'track' : 'home', name, ...worst, ok: worst.med >= 7 && worst.specks >= 4.5 });
    }
  }
  await ctx.close();
}
await b.close();
if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
else {
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.dev.padEnd(7)}${r.page.padEnd(6)}${r.name.padEnd(15)} median ${String(r.med).padStart(5)}:1   specks ${String(r.specks).padStart(5)}:1`);
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length ? `${bad.length} below target (median >= 7:1, specks >= 4.5:1)` : 'all text meets target');
}
