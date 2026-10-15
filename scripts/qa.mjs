// Visual + behavioural QA across real device viewports, driving the installed Edge.
//   npm run build && node scripts/qa.mjs [--only name,name] [--full]
// Serves dist/ itself under the configured base path, writes screenshots to .cache/qa/,
// and exits 1 on horizontal overflow, console errors, or a failed playback check.
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = new URL('../.cache/qa/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// mirrors astro.config.mjs: a committed public/CNAME means the site lives at the domain root
const BASE = existsSync(new URL('../public/CNAME', import.meta.url)) ? '/' : '/rehndrop-site/';
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
  { name: 'laptop-720', width: 1280, height: 720, dpr: 1, mobile: false },
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
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  // glows and covers pulse with the bass; at full pulse nothing may widen the page
  if (b.overflow > 1) problems.push(`playback: page overflows by ${b.overflow}px mid-song`);
  await page.screenshot({ path: join(OUT, 'playback-wobble.png') });
  console.log('playback', JSON.stringify({ ...a, p2: b.p, kicked: b.kicked, overflow: b.overflow }));
  if (!a.playing || !a.mini || a.title !== slug) problems.push('playback: tap did not start the preview');
  if (!(b.p > a.p)) problems.push('playback: progress did not advance');
  if (!b.kicked) problems.push('playback: the hit never landed (no kick at dropAt)');
  await ctx.close();
}

// desktop drag: a fling pans the shelf and never presses play; a plain click still does
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  await page.evaluate(() => document.getElementById('heavy').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  const track = page.locator('#heavy [data-row-track]');
  const box = await track.boundingBox();
  const before = await track.evaluate((el) => el.scrollLeft);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * 0.7 - i * 40, box.y + box.height * 0.4);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const after = await track.evaluate((el) => el.scrollLeft);
  const playedOnDrag = await page.evaluate(() => !document.querySelector('[data-mini]').hidden);
  await page.locator('#heavy .card-art[data-play]').nth(1).click();
  await page.waitForTimeout(1200);
  const playedOnClick = await page.evaluate(() => !document.querySelector('[data-mini]').hidden);
  console.log('drag', JSON.stringify({ before, after, playedOnDrag, playedOnClick }));
  if (!(after > before + 200)) problems.push(`drag: shelf did not pan (${before} -> ${after})`);
  if (playedOnDrag) problems.push('drag: a drag started playback');
  if (!playedOnClick) problems.push('drag: a click after dragging did not play');
  await ctx.close();
}

// the water belongs to the page: scrolling moves the drop layer with the content
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  await page.waitForTimeout(800);
  const t0 = await page.evaluate(() => document.querySelector('[data-drops]').getBoundingClientRect().top);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => document.querySelector('[data-drops]').getBoundingClientRect().top);
  const docGrowth = await page.evaluate(() => document.documentElement.scrollHeight - document.querySelector('main').getBoundingClientRect().bottom - scrollY);
  console.log('drops-scroll', JSON.stringify({ t0, t1, moved: t0 - t1, docGrowth }));
  if (Math.abs(t0 - t1 - 300) > 2) problems.push(`drops: layer did not scroll with the page (moved ${t0 - t1}px for 300px)`);
  if (docGrowth > 2) problems.push(`drops: the water layer added ${docGrowth}px of scroll below the page`);
  await ctx.close();
}

// reels open as stories: the shelf plays the newest and steps forward; a card's ring opens
// only that track's reels and never starts the card's preview
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  const story = () => page.evaluate(() => {
    const d = document.querySelector('[data-story]'), v = d.querySelector('video');
    return { open: d.open, title: d.querySelector('[data-story-title]').textContent, ig: d.querySelector('[data-story-ig]').href,
      bars: d.querySelectorAll('.story-bar').length, t: v.currentTime, src: v.getAttribute('src') };
  });
  await page.locator('#reels .rcard-art').first().click();
  await page.waitForTimeout(1500);
  const a = await story();
  await page.locator('[data-story-next]').click();
  await page.waitForTimeout(800);
  const b = await story();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const c = await story();
  await page.locator('.card .reel-ring[data-story-track="wobble"]').first().click();
  await page.waitForTimeout(1200);
  const d = await story();
  const previewStarted = await page.evaluate(() => !document.querySelector('[data-mini]').hidden);
  await page.keyboard.press('Escape');
  // the hero covers carry it too: the picks card, and the track page's own cover
  await page.locator('#picks .reel-ring[data-story-track="whats-my-name"]').click();
  await page.waitForTimeout(1200);
  const e = await story();
  await page.keyboard.press('Escape');
  await page.goto(origin + 't/whats-my-name/?lens', { waitUntil: 'networkidle' });
  await page.locator('.track-cover .reel-ring').click();
  await page.waitForTimeout(1200);
  const f = await story();
  const previewStarted2 = await page.evaluate(() => !document.querySelector('[data-mini]').hidden);
  console.log('story-rings', JSON.stringify({ picks: { title: e.title, bars: e.bars }, trackPage: { title: f.title, bars: f.bars }, previewStarted2 }));
  if (!e.open || e.title !== "what's my name" || e.bars !== 1) problems.push('stories: the picks ring did not open its reels');
  if (!f.open || f.title !== "what's my name" || f.bars !== 1) problems.push("stories: the track page cover's ring did not open its reels");
  if (previewStarted2) problems.push('stories: a hero ring started the preview');
  console.log('stories', JSON.stringify({ first: { title: a.title, t: +a.t.toFixed(2), bars: a.bars, ig: a.ig }, next: b.title, closed: !c.open && !c.src, ring: { title: d.title, bars: d.bars }, previewStarted }));
  if (!a.open || a.t <= 0.2) problems.push('stories: the shelf did not open and play a reel');
  if (!a.ig.startsWith('https://www.instagram.com/reel/')) problems.push('stories: instagram link missing');
  if (b.title === a.title) problems.push('stories: next did not advance');
  if (c.open || c.src) problems.push('stories: escape did not close and unload');
  if (!d.open || d.title !== 'wobble' || d.bars !== 1) problems.push('stories: the card ring did not open only that track');
  if (previewStarted) problems.push('stories: the ring also started the card preview');
  await ctx.close();
}

// only the playing song's cover may bounce: spotlight on one song, play another from picks
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  const liveState = () => page.evaluate(() => {
    const spot = document.querySelector('.spot.is-current .spot-cover');
    return { spotSlug: spot.dataset.cover, spotLive: spot.classList.contains('is-live'), spotScale: getComputedStyle(spot).scale };
  });
  await page.locator('[data-tick]').nth(1).click(); // spotlight -> the second slide
  await page.waitForTimeout(400);
  await page.locator('#picks [data-play="whats-my-name"]').click();
  await page.waitForTimeout(8000); // past the hit, pulse high
  const other = await liveState();
  const pickActive = await page.evaluate(() => document.querySelector('#picks [data-play="whats-my-name"]').classList.contains('is-active'));
  // now play the spotlight's own song from its own button: that cover, and only it, goes live
  await page.locator('.spot.is-current [data-play]').click();
  await page.waitForTimeout(1500);
  const same = await liveState();
  console.log('cover-isolation', JSON.stringify({ other, pickActive, same }));
  if (other.spotSlug === 'whats-my-name') problems.push('isolation: test setup failed, spotlight already on the played song');
  if (other.spotLive || (other.spotScale !== 'none' && other.spotScale !== '1')) problems.push(`isolation: spotlight cover (${other.spotSlug}) bounced to another song`);
  if (!pickActive) problems.push('isolation: the played pick card was not marked active');
  if (!same.spotLive) problems.push('isolation: the spotlight cover did not go live for its own song');
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(origin + 't/wild-beauty/?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  await page.locator('.row [data-play]').first().click();
  await page.waitForTimeout(3000);
  const cover = await page.evaluate(() => {
    const c = document.querySelector('.track-cover');
    return { live: c.classList.contains('is-live'), scale: getComputedStyle(c).scale };
  });
  console.log('track-page-isolation', JSON.stringify(cover));
  if (cover.live || (cover.scale !== 'none' && cover.scale !== '1')) problems.push('isolation: track page cover bounced to a related song');
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'PASS: no overflow, no console errors, playback ok');
process.exit(problems.length ? 1 : 0);
