// Browser check: the spotlight's previous / next buttons keep working across client-router swaps.
//   node scripts/gates/router-spotlight.mjs <origin-with-base>      e.g. http://localhost:4321/
// structure.ts binds one delegated document click listener once (guarded by a flag) and finds the
// spotlight at click time. That is correct under the client router; this proves it in a real browser
// for three orders of arrival, and that one click moves exactly one slide (no double binding):
//   C  home loaded directly, then step, wrap
//   B  home -> track (router) -> back to home (router), then step
//   A  track loaded directly (the module script has not run yet), router to home, then step
// Part of `npm run gates:local` (needs a browser). Exit 1 on any failed expectation.
// Browser: installed Edge, or QA_BROWSER_CHANNEL (see scripts/qa.mjs).
import { chromium } from 'playwright-core';

const origin = process.argv[2];
if (!origin) { console.error('usage: node scripts/gates/router-spotlight.mjs <origin-with-base>'); process.exit(2); }
const BROWSER = process.env.QA_BROWSER_CHANNEL || 'msedge';
const browser = await chromium.launch({ ...(BROWSER === 'bundled' ? {} : { channel: BROWSER }), headless: true, args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

const state = (p) => p.evaluate(() => ({
  idx: [...document.querySelectorAll('[data-tick]')].findIndex((t) => t.classList.contains('is-current')),
  slides: document.querySelectorAll('[data-slide]').length,
  marker: window.__routerMarker || null,
}));
const step = async (p, dir) => {
  await p.locator(`[data-spot-step="${dir}"]`).first().click();
  await p.waitForTimeout(250);
  return state(p);
};
let fails = 0;
const expect = (ok, msg) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) fails++; };
const mark = (p) => p.evaluate(() => { window.__routerMarker = 'no-hard-reload'; });

let p = await ctx.newPage();
await p.goto(origin, { waitUntil: 'load' });
await mark(p);
const c0 = await state(p);
const c1 = await step(p, 1);
const c2 = await step(p, -1);
expect(c0.slides > 1 && c0.idx === 0 && c1.idx === 1 && c2.idx === 0, `C home direct: next then prev, ${c0.idx} -> ${c1.idx} -> ${c2.idx} of ${c0.slides}`);
const cw = await step(p, -1);
expect(cw.idx === cw.slides - 1, `C previous from the first slide wraps to the last (${cw.idx})`);

await p.locator('.spot.is-current .spot-title').click();
await p.waitForURL(/\/t\//);
await p.waitForTimeout(500);
const bt = await state(p);
expect(bt.marker === 'no-hard-reload' && bt.slides === 0, `B router to a track page (no hard reload: ${bt.marker}, no spotlight there: ${bt.slides})`);
await p.goBack();
await p.waitForSelector('[data-spotlight]');
await p.waitForTimeout(500);
const bh = await state(p);
expect(bh.marker === 'no-hard-reload' && bh.slides > 1, `B router back to home (no hard reload: ${bh.marker}, slides ${bh.slides})`);
const bn = await step(p, 1);
expect(bn.idx === 1, `B next advances after the swap back (idx ${bn.idx})`);
await p.close();

const probe = await ctx.newPage();
await probe.goto(origin, { waitUntil: 'load' });
const track = new URL(await probe.locator('.spot .spot-title').first().getAttribute('href'), origin).href;
await probe.close();
p = await ctx.newPage();
await p.goto(track, { waitUntil: 'load' });
await mark(p);
await p.locator('a[data-home]').first().click();
await p.waitForSelector('[data-spotlight]');
await p.waitForTimeout(600);
const a0 = await state(p);
expect(a0.marker === 'no-hard-reload' && a0.slides > 1, `A router from a directly loaded track page to home (no hard reload: ${a0.marker}, slides ${a0.slides})`);
const a1 = await step(p, 1);
const a2 = await step(p, 1);
expect(a1.idx === 1 && a2.idx === 2, `A next steps ${a0.idx} -> ${a1.idx} -> ${a2.idx}`);
expect(a2.idx - a1.idx === 1, 'A one click moves exactly one slide (the listener is not bound twice)');

await browser.close();
console.log(fails ? `FAIL: ${fails} spotlight router expectation(s) failed` : 'ok: spotlight steps correctly across router swaps');
process.exit(fails ? 1 : 0);
