// Visual + behavioural QA across real device viewports, driving the installed Edge.
//   npm run build && node scripts/qa.mjs [--only name,name] [--full] [--gpu] [--headed] [--skip-long]
// Serves dist/ itself under the configured base path, writes screenshots to .cache/qa/,
// and exits 1 on horizontal overflow, console errors, or any failed behaviour check.
// The browser is always muted. --gpu runs headless on the real GPU; --headed opens an off-screen
// window for when headless only gets SwiftShader (the WebGL renderer string is printed, so a
// SwiftShader run is never mistaken for a hardware one); the default is headless SwiftShader.
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
const gpu = args.includes('--gpu');
const skipLong = args.includes('--skip-long');

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
// Every launch is muted and never on screen: --gpu stays headless on the real GPU (d3d11); only
// --headed opens a window, parked off screen, for a GPU that headless can't reach.
const MUTED = ['--mute-audio', '--autoplay-policy=no-user-gesture-required'];
const headed = args.includes('--headed');
const browser = await chromium.launch(gpu || headed
  ? { channel: 'msedge', headless: !headed, args: [...MUTED, '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', ...(headed ? ['--window-position=-2400,-2400'] : [])] }
  : { channel: 'msedge', headless: true, args: [...MUTED, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

const problems = [];
const check = (ok, msg) => { if (!ok) problems.push(msg); };
const calm = 'html{scroll-behavior:auto!important}';
const desk = () => browser.newContext({ viewport: { width: 1440, height: 900 } });
const phone = () => browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const audioState = (page) => page.evaluate(() => {
  const a = document.querySelector('[data-audio]');
  return { paused: a.paused, t: a.currentTime, src: (a.getAttribute('src') || '').split('/').pop(), mark: a.dataset.qa || null, mini: !document.querySelector('[data-mini]').hidden, title: document.querySelector('[data-mini-title]').textContent, path: location.pathname };
});

{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  const renderer = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl');
    const x = g?.getExtension('WEBGL_debug_renderer_info');
    return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g ? 'webgl, no renderer info' : 'no webgl';
  });
  console.log('renderer', JSON.stringify(renderer), headed ? '(headed off screen, real GPU requested)' : gpu ? '(headless, real GPU requested)' : '(headless SwiftShader)');
  await ctx.close();
}

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
    check(overflow <= 1, `${tag}: horizontal overflow ${overflow}px`);
    check(!errors.length, `${tag}: console errors: ${errors.join(' | ')}`);
    await page.screenshot({ path: join(OUT, `${tag}.png`) });
    if (!path) {
      for (const id of ['spotlight', 'index', 'newest', 'videos']) {
        if (!(await page.$(`#${id}`))) continue;
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

// the index: every section in Cord's order, every track a link, nothing self-hosted to watch
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  const r = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('[data-sec]')].map((s) => s.id),
    headings: [...document.querySelectorAll('.ix-h')].map((h) => h.textContent),
    links: new Set([...document.querySelectorAll('#index a.ix-title')].map((a) => a.getAttribute('href'))).size,
    tracks: JSON.parse(document.getElementById('player-data').textContent).length,
    videos: document.querySelectorAll('video').length,
    mp4: document.documentElement.outerHTML.includes('.mp4'),
    posters: [...document.querySelectorAll('#reels .poster-art')].map((a) => ({ href: a.href, target: a.target })),
    skip: document.querySelector('.skip')?.getAttribute('href'),
    oldSpot: !!document.getElementById('spotlight'),
  }));
  console.log('index', JSON.stringify({ ...r, posters: r.posters.length }));
  check(r.sections.join() === 'picks,newest,reels,heavy,pretty,detox,videos,early', `index: sections out of order: ${r.sections}`);
  check(r.headings.join('|') === 'picks.|the new stuff.|reels.|the heavy stuff.|the pretty stuff.|the detox stuff.|videos.|the old stuff.', `index: headings ${r.headings}`);
  check(r.links === r.tracks, `index: ${r.links} distinct track links for ${r.tracks} tracks`);
  check(r.videos === 0 && !r.mp4, 'index: the page still references video or an .mp4');
  check(r.posters.length > 0 && r.posters.every((p) => p.href.startsWith('https://www.instagram.com/') && p.target === '_blank'), 'index: reel posters must link out to instagram');
  check(r.skip === '#index', 'index: skip link missing');
  check(r.oldSpot, 'index: #spotlight alias missing');
  await ctx.close();
}

// search in place: case, punctuation and diacritics fold away; nothing here. when empty
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  const search = page.locator('[data-search]');
  const state = () => page.evaluate(() => ({
    titles: [...new Set([...document.querySelectorAll('#index [data-title]')].filter((e) => !e.hidden && e.offsetParent).map((e) => e.dataset.title))],
    sections: [...document.querySelectorAll('[data-sec]')].filter((s) => !s.hidden).map((s) => s.id),
    empty: document.querySelector('[data-empty]').textContent === 'nothing here.',
  }));
  await search.fill('WOBBLE!');
  const a = await state();
  await search.fill('whåts  MY');
  const b = await state();
  await search.fill('zzzz');
  const c = await state();
  await search.press('Escape');
  const d = await state();
  await search.fill('now die');
  const e = await state();
  await search.fill('');
  console.log('search', JSON.stringify({ wobble: a, whats: b.titles, none: c, cleared: d.sections.length, old: e }));
  check(a.titles.length === 1 && a.titles[0] === 'wobble' && !a.empty, 'search: "WOBBLE!" did not find only wobble');
  check(!a.sections.includes('pretty'), 'search: a section with no match did not fold away');
  check(b.titles.length === 1 && b.titles[0] === 'whats my name', 'search: diacritics or case not folded');
  check(c.empty && c.titles.length === 0 && c.sections.length === 0, 'search: no "nothing here." for no match');
  check(d.sections.length === 8 && !d.empty, 'search: Escape did not clear');
  check(e.titles.includes('now die') && e.sections.includes('early'), 'search: the old stuff is not searchable');
  await ctx.close();
}

// grid / list, remembered across a reload; more. and the letter strip where the data has them
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.locator('[data-view-btn="list"]').click();
  const a = await page.evaluate(() => ({ view: document.documentElement.dataset.view, pressed: document.querySelector('[data-view-btn="list"]').getAttribute('aria-pressed'), cols: getComputedStyle(document.querySelector('#heavy .ix-item')).gridTemplateColumns }));
  await page.reload({ waitUntil: 'networkidle' });
  const b = await page.evaluate(() => ({ view: document.documentElement.dataset.view, pressed: document.querySelector('[data-view-btn="list"]').getAttribute('aria-pressed') }));
  await page.screenshot({ path: join(OUT, 'list-view.png') });
  await page.locator('[data-view-btn="grid"]').click();
  const caps = await page.evaluate(() => ({
    more: document.querySelectorAll('[data-more]').length,
    capped: [...document.querySelectorAll('.ix-sec.is-capped')].map((s) => s.id),
    letters: document.querySelectorAll('[data-letter]').length,
    tracks: JSON.parse(document.getElementById('player-data').textContent).length,
  }));
  console.log('view', JSON.stringify({ a, b, caps }));
  check(a.view === 'list' && a.pressed === 'true', 'view: list did not switch');
  check(b.view === 'list' && b.pressed === 'true', 'view: list not remembered across a reload');
  check(caps.letters === 0 || caps.tracks > 40, 'view: letter strip shown at 40 tracks or fewer');
  if (caps.more) {
    const id = caps.capped[0];
    const hiddenBefore = await page.evaluate((i) => [...document.querySelectorAll(`#${i} [data-extra]`)].filter((e) => !e.offsetParent).length, id);
    await page.locator(`#${id} [data-more]`).click();
    const hiddenAfter = await page.evaluate((i) => [...document.querySelectorAll(`#${i} [data-extra]`)].filter((e) => !e.offsetParent).length, id);
    check(hiddenBefore > 0 && hiddenAfter === 0, `view: more. did not reveal ${id}`);
  }
  await ctx.close();
}

// playback: a tap starts the preview, the mini player appears, progress advances, the hit lands
{
  const ctx = await phone();
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  const slug = 'wobble';
  const sel = `#heavy [data-play="${slug}"]`;
  await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
  await page.tap(sel);
  await page.waitForTimeout(1500);
  const a = await page.evaluate((s) => ({
    playing: document.querySelector(s).classList.contains('is-playing'),
    mini: !document.querySelector('[data-mini]').hidden,
    title: document.querySelector('[data-mini-title]').textContent,
    p: Number(getComputedStyle(document.querySelector('[data-mini]')).getPropertyValue('--p') || 0),
  }), sel);
  await page.waitForTimeout(6500);
  const b = await page.evaluate(() => ({
    p: Number(getComputedStyle(document.querySelector('[data-mini]')).getPropertyValue('--p') || 0),
    kicked: document.documentElement.classList.contains('kick'),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  check(b.overflow <= 1, `playback: page overflows by ${b.overflow}px mid-song`);
  await page.screenshot({ path: join(OUT, 'playback-wobble.png') });
  console.log('playback', JSON.stringify({ ...a, p2: b.p, kicked: b.kicked, overflow: b.overflow }));
  check(a.playing && a.mini && a.title === slug, 'playback: tap did not start the preview');
  check(b.p > a.p, 'playback: progress did not advance');
  check(b.kicked, 'playback: the hit never landed (no kick)');
  await ctx.close();
}

// the router: one <audio> and one lens canvas survive home -> track -> track -> Back -> Back
for (const make of [desk, phone]) {
  const ctx = await make();
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  await page.evaluate(() => {
    document.querySelector('[data-audio]').dataset.qa = 'a1';
    document.querySelector('[data-lens]').dataset.qa = 'l1';
    document.querySelector('[data-mini]').dataset.qa = 'm1';
  });
  await page.locator('#heavy [data-play="wobble"]').click();
  await page.waitForTimeout(1200);
  const s0 = await audioState(page);
  await page.locator('#heavy a.ix-title[href$="/t/wobble/"]').click();
  await page.waitForURL(/\/t\/wobble\/$/);
  await page.waitForTimeout(1500);
  const s1 = await audioState(page);
  const view1 = await page.evaluate(() => ({
    focus: document.activeElement?.id,
    btn: document.querySelector('.tv-player .play').classList.contains('is-playing'),
    scrub: Number(document.querySelector('[data-scrub]').value),
    lens: document.querySelector('[data-lens]').dataset.qa,
    mini: document.querySelector('[data-mini]').dataset.qa,
    lensOn: document.documentElement.classList.contains('lens-on'),
    accent: document.documentElement.style.getPropertyValue('--accent'),
  }));
  await page.locator('.tv-more a.ix-title').first().click();
  await page.waitForTimeout(1500);
  const s2 = await audioState(page);
  await page.goBack();
  await page.waitForTimeout(1000);
  await page.goBack();
  await page.waitForTimeout(1200);
  const s3 = await audioState(page);
  const lens3 = await page.evaluate(() => document.querySelector('[data-lens]').dataset.qa);
  await page.goForward();
  await page.waitForTimeout(1200);
  const s4 = await audioState(page);
  console.log('router', make === desk ? 'desktop' : 'phone', JSON.stringify({ s0, s1, view1, s2: { path: s2.path, paused: s2.paused, mark: s2.mark }, s3: { path: s3.path, paused: s3.paused, mark: s3.mark, lens: lens3 }, s4: { path: s4.path, paused: s4.paused } }));
  check(!s0.paused, 'router: playback did not start');
  check(s1.mark === 'a1' && !s1.paused && s1.mini && s1.t > s0.t, 'router: the audio did not survive home -> track');
  check(view1.lens === 'l1' && view1.mini === 'm1' && view1.lensOn, 'router: lens canvas, mini player or lens-on did not survive');
  check(view1.focus === 'tv-title', `router: focus not on the track title after opening (${view1.focus})`);
  check(view1.btn && view1.scrub > 0, 'router: the track view does not show the live state');
  check(view1.accent !== '', 'router: the playing accent was dropped by the swap');
  check(s2.mark === 'a1' && !s2.paused && s2.path !== s1.path, 'router: the audio did not survive track -> track');
  check(s3.mark === 'a1' && !s3.paused && s3.path === BASE && lens3 === 'l1', 'router: Back home lost the audio or the lens');
  check(!s4.paused && s4.path.endsWith('/t/wobble/'), 'router: Forward lost the audio');
  await ctx.close();
}

// opening a track while nothing plays starts it; a fresh deep link stays silent until a tap
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  await page.locator('#pretty a.ix-title[href$="/t/pretty-lights/"]').click();
  await page.waitForURL(/pretty-lights/);
  await page.waitForTimeout(1200);
  const a = await audioState(page);
  await page.goto(origin + 't/wobble/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const b = await audioState(page);
  console.log('open', JSON.stringify({ opened: { src: a.src, paused: a.paused }, deep: { paused: b.paused, mini: b.mini } }));
  check(!a.paused && a.src.startsWith('pretty-lights'), 'open: opening a track with nothing playing did not start it');
  check(b.paused && !b.mini, 'open: a deep link made sound without a tap');
  await ctx.close();
}

// the scrubber: a slider; PageDown jumps to the next hit mark, arrows step a second
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin + 't/whats-my-name/', { waitUntil: 'networkidle' });
  const hits = await page.evaluate(() => JSON.parse(document.getElementById('player-data').textContent).find((t) => t.slug === 'whats-my-name').hits);
  const scrub = page.locator('[data-scrub]');
  await scrub.focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(1200);
  const a = await page.evaluate(() => ({ t: document.querySelector('[data-audio]').currentTime, paused: document.querySelector('[data-audio]').paused, text: document.querySelector('[data-scrub]').getAttribute('aria-valuetext'), role: document.querySelector('[data-scrub]').type }));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const b = await page.evaluate(() => document.querySelector('[data-audio]').currentTime);
  const marks = await page.locator('.scrub-mark').count();
  console.log('scrubber', JSON.stringify({ hits, a, back2: +b.toFixed(2), marks }));
  check(marks === hits.length, 'scrubber: hit marks missing');
  check(!a.paused && a.t >= hits[0] - 0.1 && a.t < hits[0] + 1.5, `scrubber: PageDown did not land on the first hit (${a.t})`);
  check(/^\d+:\d\d of \d+:\d\d$/.test(a.text ?? ''), `scrubber: aria-valuetext "${a.text}"`);
  check(b < a.t - 1, 'scrubber: arrows did not step back');
  await ctx.close();
}

// the contact sheet: from anywhere, address selectable, copy, Esc and Back both close it
{
  const ctx = await desk();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  await page.goto(origin + 't/wobble/', { waitUntil: 'networkidle' });
  await page.evaluate(() => (document.querySelector('main').dataset.qa = 'page1'));
  const t0 = Date.now();
  await page.locator('.top [data-contact-open]').click();
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => {
    const d = document.querySelector('[data-sheet]');
    const mail = d.querySelector('[data-mail]');
    return { open: d.open, mail: mail.textContent, select: getComputedStyle(mail).userSelect, links: [...d.querySelectorAll('.sheet-links a')].map((a) => a.textContent + '=' + a.getAttribute('href')), len: history.length };
  });
  const reachMs = Date.now() - t0;
  await page.locator('[data-copy]').click();
  await page.waitForTimeout(300);
  const copied = await page.evaluate(async () => ({ toast: document.querySelector('[data-copied]').textContent, clip: await navigator.clipboard.readText() }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const esc = await page.evaluate(() => ({ open: document.querySelector('[data-sheet]').open, focus: document.activeElement?.matches('.top [data-contact-open]'), path: location.pathname, qa: document.querySelector('main').dataset.qa }));
  await page.locator('.contact [data-contact-open]').click();
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => ({ open: document.querySelector('[data-sheet]').open, path: location.pathname, qa: document.querySelector('main')?.dataset.qa }));
  await page.goBack();
  await page.waitForTimeout(1200);
  const left = await page.evaluate(() => location.pathname);
  console.log('contact', JSON.stringify({ open, reachMs, copied, esc, back, afterSecondBack: left }));
  check(open.open && open.mail === 'rehndrop@sg57.dev' && (open.select === 'all' || open.select === 'text'), 'contact: sheet did not open with a selectable address');
  check(open.links.length === 3 && open.links.every((l) => l.includes('mailto:rehndrop@sg57.dev?subject=')), 'contact: the three mailto links are wrong');
  check(copied.toast === 'copied.' && copied.clip === 'rehndrop@sg57.dev', 'contact: copy did not copy or toast');
  check(!esc.open && esc.focus && esc.qa === 'page1', 'contact: Esc did not close and return focus without reloading');
  check(!back.open && back.path.endsWith('/t/wobble/') && back.qa === 'page1', 'contact: Back did not close the sheet in place');
  check(reachMs < 5000, `contact: ${reachMs} ms to reach the address`);
  await ctx.close();
}

// posters pause the preview before leaving; structural text never selects
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  const sel = await page.evaluate(() => Object.fromEntries(['.ix-h', '.ix-title', '.top-link', '.chip', '.spot-title', '.ix-view', '.contact-mail'].map((s) => [s, getComputedStyle(document.querySelector(s)).userSelect])));
  await page.locator('#heavy [data-play="wobble"]').click();
  await page.waitForTimeout(1000);
  ctx.on('page', (p) => p.close().catch(() => {}));
  await page.locator('#reels .poster-art').first().click();
  await page.waitForTimeout(600);
  const paused = await page.evaluate(() => document.querySelector('[data-audio]').paused);
  console.log('posters+select', JSON.stringify({ paused, sel }));
  check(paused, 'posters: tapping a poster did not pause the preview');
  check(['.ix-h', '.ix-title', '.top-link', '.chip', '.spot-title', '.ix-view'].every((s) => sel[s] === 'none'), 'select: structural text is selectable');
  check(sel['.contact-mail'] === 'text', 'select: the contact address is not selectable');
  await ctx.close();
}

// keyboard only: skip link, header, search, index, a track page, the contact sheet, back
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  const here = () => page.evaluate(() => {
    const e = document.activeElement;
    const name = e?.getAttribute('aria-label') || e?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40) || e?.getAttribute('placeholder') || '';
    const r = e?.getClientRects()[0];
    return `${e?.tagName.toLowerCase()}${e?.className ? '.' + String(e.className).split(' ')[0] : ''} "${name}"${r && (r.width < 1 || r.height < 1) ? ' (invisible)' : ''}`;
  });
  const walk = [];
  const tab = async (n = 1, shift = false) => { for (let i = 0; i < n; i++) await page.keyboard.press(shift ? 'Shift+Tab' : 'Tab'); walk.push(await here()); };
  await tab(); // skip link
  const skip = walk.at(-1);
  await tab(); await tab(); await tab(); // home, choose a track, contact
  await page.keyboard.press('Enter'); // contact sheet
  await page.waitForTimeout(300);
  walk.push('sheet open: ' + (await page.evaluate(() => document.querySelector('[data-sheet]').open)) + ', focus ' + (await here()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  walk.push('sheet closed, focus ' + (await here()));
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  walk.push(await here());
  await page.keyboard.press('Enter'); // skip to tracks
  await page.waitForTimeout(500);
  await tab(); // search
  const search = walk.at(-1);
  await page.keyboard.type('pretty');
  await page.waitForTimeout(200);
  await tab(); await tab(); await tab(); // grid, list, first store / item
  for (let i = 0; i < 12; i++) { await tab(); if ((walk.at(-1) || '').includes('a.ix-title')) break; }
  const onTitle = walk.at(-1);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  walk.push('opened ' + (await page.evaluate(() => location.pathname)) + ', focus ' + (await here()));
  for (let i = 0; i < 4; i++) await tab();
  await page.keyboard.press('Shift+Tab');
  walk.push(await here());
  await page.goBack();
  await page.waitForTimeout(1200);
  walk.push('back at ' + (await page.evaluate(() => location.pathname)));
  console.log('keyboard walk:\n  ' + walk.join('\n  '));
  check(skip.includes('skip to tracks'), 'keyboard: the first Tab is not the skip link');
  check(search.includes('find a track'), 'keyboard: skip to tracks did not lead to the search');
  check(onTitle.includes('a.ix-title'), 'keyboard: never reached a track link');
  check(!walk.some((w) => w.includes('(invisible)')), 'keyboard: focus landed on something invisible');
  await ctx.close();
}

// the water belongs to the page: scrolling moves the drop layer with the content
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  await page.waitForTimeout(800);
  const t0 = await page.evaluate(() => document.querySelector('[data-drops]').getClientRects()[0].top);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(300);
  const t1 = await page.evaluate(() => document.querySelector('[data-drops]').getClientRects()[0].top);
  const docGrowth = await page.evaluate(() => document.documentElement.scrollHeight - document.querySelector('main').getClientRects()[0].bottom - scrollY);
  console.log('drops-scroll', JSON.stringify({ t0, t1, moved: t0 - t1, docGrowth }));
  check(Math.abs(t0 - t1 - 300) <= 2, `drops: layer did not scroll with the page (moved ${t0 - t1}px for 300px)`);
  check(docGrowth <= 2, `drops: the water layer added ${docGrowth}px of scroll below the page`);
  await ctx.close();
}

// a pinned clock (?t=) gives the same decorative frame on every load: the lens and the water
// are compared as their own pixels; the whole page is logged as well
{
  const ctx = await desk();
  const lens = [];
  const water = [];
  const pageShots = [];
  for (let i = 0; i < 3; i++) {
    const page = await ctx.newPage();
    await page.goto(origin + '?t=1790000000000', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.documentElement.classList.contains('lens-on'));
    await page.waitForTimeout(2500);
    lens.push(await page.locator('[data-lens]').screenshot());
    water.push(await page.evaluate(() => document.querySelector('[data-drops]').toDataURL()));
    pageShots.push(await page.screenshot());
    await page.close();
  }
  const same = (xs) => xs.every((x) => (Buffer.isBuffer(x) ? Buffer.compare(x, xs[0]) === 0 : x === xs[0]));
  const r = { lens: same(lens), water: same(water), page: same(pageShots) };
  console.log('frozen-time', JSON.stringify(r));
  check(r.lens && r.water, 'frozen time: the lens or the water differ between loads at the same ?t=');
  await ctx.close();
}

// teasers: what's my name joins two moments; both hits fire on time and the seam is marked
if (!skipLong) {
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin + 't/whats-my-name/?lens', { waitUntil: 'networkidle' });
  const expected = await page.evaluate(() => JSON.parse(document.getElementById('player-data').textContent).find((t) => t.slug === 'whats-my-name'));
  await page.evaluate(() => {
    window.__ev = [];
    const t0 = { v: 0 };
    document.addEventListener('click', () => (t0.v = performance.now()), true);
    for (const k of ['rehndrop:hit', 'rehndrop:turn']) document.addEventListener(k, () => window.__ev.push([k.slice(9), (performance.now() - t0.v) / 1000]));
  });
  await page.locator('.tv-player .play').click();
  await page.waitForTimeout(42000);
  const r = await page.evaluate(() => ({ ev: window.__ev, marks: document.querySelectorAll('[data-mini] .mini-turn').length }));
  console.log('teasers', JSON.stringify({ expected: { hits: expected.hits, turns: expected.turns, duration: expected.duration }, fired: r.ev.map(([k, t]) => [k, +t.toFixed(2)]), marks: r.marks }));
  const hitsFired = r.ev.filter(([k]) => k === 'hit').map(([, t]) => t);
  const turnsFired = r.ev.filter(([k]) => k === 'turn').map(([, t]) => t);
  check(hitsFired.length === expected.hits.length, `teasers: ${hitsFired.length} hits fired, expected ${expected.hits.length}`);
  expected.hits.forEach((h, i) => check(hitsFired[i] !== undefined && Math.abs(hitsFired[i] - h) <= 0.8, `teasers: hit ${i + 1} at ${hitsFired[i]}, expected ~${h}`));
  check(turnsFired.length === expected.turns.length, `teasers: ${turnsFired.length} seams fired, expected ${expected.turns.length}`);
  check(r.marks === expected.turns.length, 'teasers: the seam is not marked on the player bar');
  await ctx.close();
}

// only the playing song's cover may bounce: spotlight on one song, play another from picks
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin + '?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  const liveState = () => page.evaluate(() => {
    const spot = document.querySelector('.spot.is-current .spot-cover');
    return { spotSlug: spot.dataset.cover, spotLive: spot.classList.contains('is-live'), spotScale: getComputedStyle(spot).scale };
  });
  await page.locator('[data-tick]').nth(1).click();
  await page.waitForTimeout(400);
  await page.locator('#picks [data-play="whats-my-name"]').click();
  await page.waitForTimeout(8000);
  const other = await liveState();
  const pickActive = await page.evaluate(() => document.querySelector('#picks [data-play="whats-my-name"]').classList.contains('is-active'));
  await page.locator('.spot.is-current [data-play]').click();
  await page.waitForTimeout(1500);
  const same = await liveState();
  console.log('cover-isolation', JSON.stringify({ other, pickActive, same }));
  check(other.spotSlug !== 'whats-my-name', 'isolation: test setup failed, spotlight already on the played song');
  check(!other.spotLive && (other.spotScale === 'none' || other.spotScale === '1'), `isolation: spotlight cover (${other.spotSlug}) bounced to another song`);
  check(pickActive, 'isolation: the played pick was not marked active');
  check(same.spotLive, 'isolation: the spotlight cover did not go live for its own song');
  await ctx.close();
}
{
  const ctx = await desk();
  const page = await ctx.newPage();
  await page.goto(origin + 't/wild-beauty/?lens', { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: calm });
  await page.locator('.tv-more [data-play]').first().click();
  await page.waitForTimeout(3000);
  const cover = await page.evaluate(() => {
    const c = document.querySelector('.track-cover');
    return { live: c.classList.contains('is-live'), scale: getComputedStyle(c).scale };
  });
  console.log('track-page-isolation', JSON.stringify(cover));
  check(!cover.live && (cover.scale === 'none' || cover.scale === '1'), 'isolation: track page cover bounced to a related song');
  await ctx.close();
}

await browser.close();
server.close();
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'PASS: no overflow, no console errors, every behaviour check held');
process.exit(problems.length ? 1 : 0);
