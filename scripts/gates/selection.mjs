// Browser check: the words worth copying select, and the stage still does not.
//   node scripts/gates/selection.mjs <origin-with-base>      e.g. http://localhost:4321/
// The page is a stage (global.css sets user-select: none on body); a short list of selectors opts back in.
// This drives a real mouse, not a scripted Range, because user-select: none still lets a script select:
//   - triple-click a track page's title, its line under the title, the credit line, and an index row's
//     line: window.getSelection() holds exactly that text, and Ctrl+C puts it on the clipboard
//   - negative controls: a section heading and the home spotlight's text must NOT select, and a mouse
//     drag across the spotlight must still swipe the slides (no selection, the slide moves)
// Part of `npm run gates:local` (needs a browser). Exit 1 on any failed expectation.
// Browser: installed Edge, or QA_BROWSER_CHANNEL (see scripts/qa.mjs). Muted, never on screen.
import { chromium } from 'playwright-core';

const origin = process.argv[2];
if (!origin) { console.error('usage: node scripts/gates/selection.mjs <origin-with-base>'); process.exit(2); }
const base = origin.endsWith('/') ? origin : origin + '/';
const BROWSER = process.env.QA_BROWSER_CHANNEL || 'msedge';
const browser = await chromium.launch({ ...(BROWSER === 'bundled' ? {} : { channel: BROWSER }), headless: true, args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });

let fails = 0;
const expect = (ok, msg) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) fails++; };
const sel = (p) => p.evaluate(() => getSelection().toString().replace(/\s+/g, ' ').trim());
const text = (loc) => loc.evaluate((e) => e.textContent.replace(/\s+/g, ' ').trim());
const clear = (p) => p.evaluate(() => getSelection().removeAllRanges());
const tripleClick = async (p, loc) => { await loc.scrollIntoViewIfNeeded(); await clear(p); await loc.click({ clickCount: 3, position: { x: 6, y: 6 } }); };

// a ?t= URL stills the clock, which also stops the spotlight's auto-rotation
const track = await ctx.newPage();
await track.goto(base + 't/wobble/?t=1700000000000', { waitUntil: 'networkidle' });

const title = track.locator('.track-title');
await tripleClick(track, title);
const titleText = await text(title);
expect(titleText.length > 0 && (await sel(track)) === titleText, `track title selects (${JSON.stringify(titleText)})`);
await track.keyboard.press('ControlOrMeta+C');
const clip = await track.evaluate(() => navigator.clipboard.readText());
expect(clip.replace(/\s+/g, ' ').trim() === titleText, `Ctrl+C copies the title (clipboard ${JSON.stringify(clip.trim())})`);

for (const [name, selector] of [['line under the title', '.track-page .spot-answer'], ['liner note', '.track-page .spot-note'], ['credit line', '.foot-line']]) {
  const loc = track.locator(selector).first();
  if (!(await loc.count())) { expect(false, `${name}: ${selector} is not on the wobble page`); continue; }
  await tripleClick(track, loc);
  const want = await text(loc);
  expect(want.length > 0 && (await sel(track)) === want, `${name} selects (${JSON.stringify(want.slice(0, 40))})`);
}

const home = await ctx.newPage();
await home.goto(base + '?t=1700000000000', { waitUntil: 'networkidle' });
await home.waitForTimeout(800);

const sub = home.locator('#index .ix-sub').first();
await tripleClick(home, sub);
const subText = await text(sub);
expect(subText.length > 0 && (await sel(home)) === subText, `index line selects (${JSON.stringify(subText.slice(0, 40))})`);

// negative controls: the stage stays a stage
const heading = home.locator('#index .ix-h').first();
await tripleClick(home, heading);
expect((await sel(home)) === '', `a section heading does not select (got ${JSON.stringify(await sel(home))})`);
const answer = home.locator('.spot.is-current .spot-answer');
if (await answer.count()) {
  await tripleClick(home, answer);
  expect((await sel(home)) === '', `the spotlight line does not select (got ${JSON.stringify(await sel(home))})`);

  // a mouse drag across the spotlight is a swipe, not a selection
  await home.evaluate(() => scrollTo(0, 0));
  const idx = () => home.evaluate(() => [...document.querySelectorAll('[data-tick]')].findIndex((t) => t.classList.contains('is-current')));
  const before = await idx();
  const box = await answer.boundingBox();
  await clear(home);
  await home.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
  await home.mouse.down();
  await home.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 12 });
  await home.mouse.up();
  await home.waitForTimeout(400);
  const after = await idx();
  expect(after !== before && (await sel(home)) === '', `a drag across the spotlight swipes (slide ${before} -> ${after}) and selects nothing (got ${JSON.stringify(await sel(home))})`);
} else expect(false, 'the home spotlight line (.spot.is-current .spot-answer) is missing');

await browser.close();
console.log(fails ? `FAIL: ${fails} selection expectation(s) failed` : 'ok: copyable text selects, the stage still does not');
process.exit(fails ? 1 : 0);
