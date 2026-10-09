// Visual + behavioural QA across real device viewports, driving the installed Edge.
//   npm run build && node scripts/qa.mjs [--only name,name] [--full]
// Serves dist/ itself under the configured base path, writes screenshots to .cache/qa/,
// and exits 1 on horizontal overflow, console errors, or a failed playback check.
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('../.cache/qa/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BASE = '/rehndrop-site/';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const full = args.includes('--full');

const DEVICES = [
  { name: 'iphone-se', width: 375, height: 667, dpr: 2, mobile: true },
  { name: 'iphone-15', width: 393, height: 852, dpr: 3, mobile: true },
  { name: 'pixel-7', width: 412, height: 915, dpr: 2.6, mobile: true },
  { name: 'phone-land', width: 852, height: 393, dpr: 3, mobile: true },
  { name: 'ipad', width: 820, height: 1180, dpr: 2, mobile: true },
  { name: 'ipad-land', width: 1180, height: 820, dpr: 2, mobile: true },
  { name: 'laptop', width: 1440, height: 900, dpr: 1, mobile: false },
  { name: 'desktop', width: 1920, height: 1080, dpr: 1, mobile: false },
  { name: 'ultrawide', width: 2560, height: 1080, dpr: 1, mobile: false },
];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.m4a': 'audio/mp4', '.ico': 'image/x-icon', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!p.startsWith(BASE)) { res.writeHead(404).end(); return; }
  p = normalize(join(DIST, p.slice(BASE.length)));
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    const body = await readFile(p);
    const range = req.headers.range;
    const type = TYPES[extname(p)] ?? 'application/octet-stream';
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = Number(a);
      const end = b ? Number(b) : body.length - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes' });
      res.end(body);
    }
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const origin = `http://localhost:${server.address().port}${BASE}`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

const problems = [];
const pages = ['', 't/wild-beauty/'];

for (const d of DEVICES.filter((x) => !only || only.includes(x.name))) {
  const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.dpr, isMobile: d.mobile, hasTouch: d.mobile });
  for (const path of pages) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + path + '?lens', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2600);
    const tag = `${d.name}${path ? '-' + path.split('/')[1] : ''}`;
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (overflow > 1) problems.push(`${tag}: horizontal overflow ${overflow}px`);
    if (errors.length) problems.push(`${tag}: console errors: ${errors.join(' | ')}`);
    await page.screenshot({ path: join(OUT, `${tag}.png`) });
    if (!path) {
      for (const id of ['spotlight', 'newest', 'videos']) {
        const el = await page.$(`#${id}`);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.evaluate((i) => document.getElementById(i).scrollIntoView({ block: 'start' }), id);
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(OUT, `${tag}-${id}.png`) });
      }
      if (full) await page.screenshot({ path: join(OUT, `${tag}-full.png`), fullPage: true });
    }
    await page.close();
  }
  await ctx.close();
}

// playback: a tap starts the preview, the mini player appears, progress advances, the hit lands
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  // smooth scrolling keeps the target moving under Playwright's tap; the test doesn't need it
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}.row-track{scroll-snap-type:none!important}' });
  const slug = 'wobble';
  await page.evaluate((s) => document.querySelector(`[data-play="${s}"]`).scrollIntoView({ block: 'center' }), slug);
  await page.tap(`.card [data-play="${slug}"]`);
  await page.waitForTimeout(1500);
  const a = await page.evaluate((s) => ({
    playing: document.querySelector(`.card [data-play="${s}"]`).classList.contains('is-playing'),
    mini: !document.querySelector('[data-mini]').hidden,
    title: document.querySelector('[data-mini-title]').textContent,
    p: Number(getComputedStyle(document.querySelector('[data-mini]')).getPropertyValue('--p') || 0),
  }), slug);
  await page.waitForTimeout(6500);
  const b = await page.evaluate(() => ({
    p: Number(getComputedStyle(document.querySelector('[data-mini]')).getPropertyValue('--p') || 0),
    kicked: document.documentElement.classList.contains('kick'),
  }));
  await page.screenshot({ path: join(OUT, 'playback-wobble.png') });
  console.log('playback', JSON.stringify({ ...a, p2: b.p, kicked: b.kicked }));
  if (!a.playing || !a.mini || a.title !== slug) problems.push('playback: tap did not start the preview');
  if (!(b.p > a.p)) problems.push('playback: progress did not advance');
  if (!b.kicked) problems.push('playback: the hit never landed (no kick at dropAt)');
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'PASS: no overflow, no console errors, playback ok');
process.exit(problems.length ? 1 : 0);
