// Browser check: the site's Content Security Policy blocks nothing the site needs.
//   node scripts/gates/csp-crawl.mjs <origin-with-base> [--widths 375,1440] [--dist <dir>]
// astro.config.mjs turns on security.csp, so every page carries a <meta http-equiv> policy. A policy
// that is too tight fails silently: a blocked script or stylesheet just leaves a dead or ugly page.
// This opens EVERY built route (the folders under dist/ that hold an index.html, plus 404.html) at each
// width and fails on any `securitypolicyviolation` event or "Content Security Policy" console message.
// It then drives the behaviours most likely to trip a policy and checks each still works:
//   WebGL stage (the lens canvas draws and html.lens-on is set), the contact <dialog>, a preview playing
//   (audio, same-origin media), search, the spotlight, and a client-router swap
//   home -> track -> back with no hard reload (the router injects markup and view-transition styles).
// It also proves the page really carries a policy, so a build with the meta tag missing cannot pass.
// Part of `npm run gates:local` (needs a browser). Exit 1 on any violation or failed behaviour.
// Browser: installed Edge, or QA_BROWSER_CHANNEL (see scripts/qa.mjs). Muted, never on screen.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const origin = args[0];
if (!origin || origin.startsWith('--')) { console.error('usage: node scripts/gates/csp-crawl.mjs <origin-with-base> [--widths 375,1440] [--dist <dir>]'); process.exit(2); }
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const widths = opt('--widths', '375,1440').split(',').map(Number);
const dist = opt('--dist', fileURLToPath(new URL('../../dist/', import.meta.url)));
const base = origin.endsWith('/') ? origin : origin + '/';

// every built route: <dir>/index.html -> "<dir>/", the root -> "", plus the 404 page
const routes = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_')) continue; // _astro (assets) and screenshot output
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name === 'index.html') routes.push(relative(dist, dir).split(sep).join('/').replace(/^$/, '') + (dir === dist ? '' : '/'));
    else if (name === '404.html' && dir === dist) routes.push('404.html');
  }
})(dist);
if (!existsSync(join(dist, 'index.html')) || routes.length < 3) { console.error(`FAIL: no built site under ${dist} (run npm run build)`); process.exit(2); }
routes.sort();

const BROWSER = process.env.QA_BROWSER_CHANNEL || 'msedge';
const browser = await chromium.launch({
  ...(BROWSER === 'bundled' ? {} : { channel: BROWSER }),
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const CSP_TEXT = /content security policy|violates the following|refused to (load|apply|execute|connect|frame|create)/i;
let fails = 0;
const fail = (msg) => { fails++; console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);

// every violation, from the DOM event (survives router swaps, reported through a binding) and the console
async function open(width, label) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 700 ? 800 : 900 } });
  const violations = [];
  await ctx.exposeBinding('__cspReport', (_src, v) => violations.push(v));
  await ctx.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspReport(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'} ${e.sample ? '[' + e.sample.slice(0, 60) + ']' : ''}`);
    });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (CSP_TEXT.test(m.text())) violations.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => violations.push(`pageerror: ${String(e).slice(0, 200)}`));
  return { ctx, page, violations, label };
}
const report = (s, what) => {
  if (s.violations.length) fail(`${s.label} ${what}: ${s.violations.length} violation(s): ${[...new Set(s.violations)].join(' | ')}`);
  s.violations.length = 0;
};

// 1. every route, every width: loads under the policy, carries the policy, zero violations
for (const width of widths) {
  const s = await open(width, `${width}px`);
  let noPolicy = 0;
  for (const route of routes) {
    await s.page.goto(base + route, { waitUntil: 'networkidle' });
    await s.page.waitForTimeout(700);
    const policy = await s.page.evaluate(() => document.querySelector('meta[http-equiv="content-security-policy"]')?.content ?? '');
    if (!/script-src/.test(policy) || !/default-src/.test(policy)) { noPolicy++; fail(`${s.label} /${route}: page carries no complete CSP meta (${policy.slice(0, 60) || 'none'})`); }
    report(s, `/${route}`);
  }
  if (!noPolicy) ok(`${s.label}: ${routes.length} routes load, each with a CSP meta, zero violations`);
  await s.ctx.close();
}

// 2. behaviours that a too-tight policy would break
for (const width of widths) {
  const s = await open(width, `${width}px behaviours`);
  const { page } = s;
  // the head boot script (the one hashed inline script) ran and read the URL: html.js always, html.is-frozen only with ?t=
  await page.goto(base + '?t=1790000000000', { waitUntil: 'load' });
  const bootFrozen = await page.evaluate(() => [document.documentElement.classList.contains('js'), document.documentElement.classList.contains('is-frozen')]);
  await page.goto(base + '?lens', { waitUntil: 'load' });
  const bootPlain = await page.evaluate(() => [document.documentElement.classList.contains('js'), document.documentElement.classList.contains('is-frozen')]);
  bootFrozen[0] && bootFrozen[1] && bootPlain[0] && !bootPlain[1] ? ok(`${s.label}: the boot script ran (js, and is-frozen only with ?t=)`) : fail(`${s.label}: the boot script did not do its job (?t= gives js/is-frozen ${bootFrozen}, plain gives ${bootPlain})`);
  report(s, 'boot script');

  await page.goto(base + '?lens', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  // smooth scrolling off through the CSSOM (an injected <style> would itself be a violation)
  await page.evaluate(() => document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important'));

  const stage = await page.evaluate(() => {
    const c = document.querySelector('[data-lens]');
    return { lensOn: document.documentElement.classList.contains('lens-on'), tier: document.documentElement.dataset.tier || '', w: c?.width ?? 0, h: c?.height ?? 0 };
  });
  stage.lensOn && stage.w > 0 && stage.h > 0 ? ok(`${s.label}: WebGL stage runs (lens-on, tier ${stage.tier}, canvas ${stage.w}x${stage.h})`) : fail(`${s.label}: WebGL stage did not start ${JSON.stringify(stage)}`);
  report(s, 'stage');

  await page.evaluate(() => { window.__csp_marker = 'no-hard-reload'; });

  // the contact dialog
  await page.locator('[data-contact-open]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-contact-open]').first().click();
  await page.waitForTimeout(500);
  const open1 = await page.evaluate(() => !!document.querySelector('dialog[open]'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const open2 = await page.evaluate(() => !!document.querySelector('dialog[open]'));
  open1 && !open2 ? ok(`${s.label}: contact dialog opens and closes`) : fail(`${s.label}: contact dialog open=${open1} after Escape=${open2}`);
  report(s, 'dialog');

  // search folds the index
  await page.locator('[data-search]').fill('wobble');
  await page.waitForTimeout(300);
  const found = await page.evaluate(() => [...new Set([...document.querySelectorAll('#index [data-title]')].filter((e) => !e.hidden && e.offsetParent).map((e) => e.dataset.title))]);
  found.length === 1 && found[0] === 'wobble' ? ok(`${s.label}: search folds the index`) : fail(`${s.label}: search found ${JSON.stringify(found)}`);
  await page.locator('[data-search]').fill('');
  report(s, 'search');

  // the spotlight steps
  const idx = () => page.evaluate(() => [...document.querySelectorAll('[data-tick]')].findIndex((t) => t.classList.contains('is-current')));
  await page.evaluate(() => scrollTo(0, 0));
  const i0 = await idx();
  await page.locator('[data-spot-step="1"]').first().click({ force: true });
  await page.waitForTimeout(300);
  const i1 = await idx();
  i1 !== i0 ? ok(`${s.label}: spotlight steps (${i0} -> ${i1})`) : fail(`${s.label}: spotlight did not step`);
  report(s, 'spotlight');

  // a preview plays (same-origin media)
  const play = page.locator('#heavy [data-play="wobble"]');
  await play.scrollIntoViewIfNeeded();
  await play.click();
  await page.waitForTimeout(2200);
  const au = await page.evaluate(() => { const a = document.querySelector('[data-audio]'); return { paused: a.paused, t: a.currentTime, err: a.error?.code ?? null }; });
  !au.paused && au.t > 0 && !au.err ? ok(`${s.label}: preview plays (t=${au.t.toFixed(2)})`) : fail(`${s.label}: preview did not play ${JSON.stringify(au)}`);
  report(s, 'audio');

  // router swap: home -> track, back, no hard reload (the scrubber has its own checks in qa.mjs, which runs under the policy)
  await page.locator('#heavy a.ix-title[href$="/t/wobble/"]').click();
  await page.waitForURL(/\/t\/wobble\/$/);
  await page.waitForTimeout(1500);
  const track = await page.evaluate(() => ({ marker: window.__csp_marker, title: document.querySelector('.track-title')?.textContent, audio: !document.querySelector('[data-audio]').paused, vt: !!document.querySelector('.track-page') }));
  track.marker === 'no-hard-reload' && track.title === 'wobble' && track.audio ? ok(`${s.label}: router swap to the track page keeps the page and the audio`) : fail(`${s.label}: router swap broke ${JSON.stringify(track)}`);
  report(s, 'router to track');
  await page.goBack();
  await page.waitForSelector('[data-spotlight]');
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => ({ marker: window.__csp_marker, slides: document.querySelectorAll('[data-slide]').length }));
  back.marker === 'no-hard-reload' && back.slides > 1 ? ok(`${s.label}: router back to home, no hard reload`) : fail(`${s.label}: router back broke ${JSON.stringify(back)}`);
  report(s, 'router back');

  // arriving on a track page first, then routing home (the other policy-accumulation order)
  await page.goto(base + 't/wobble/', { waitUntil: 'networkidle' });
  await page.evaluate(() => { window.__csp_marker = 'no-hard-reload'; });
  await page.locator('a[data-home]').first().click();
  await page.waitForSelector('[data-spotlight]');
  await page.waitForTimeout(800);
  const m2 = await page.evaluate(() => window.__csp_marker);
  m2 === 'no-hard-reload' ? ok(`${s.label}: router from a direct track page to home`) : fail(`${s.label}: track -> home did a hard reload`);
  report(s, 'router track to home');
  await s.ctx.close();
}

await browser.close();
console.log(fails ? `FAIL: ${fails} CSP expectation(s) failed` : `ok: zero CSP violations across ${routes.length} routes at ${widths.join(' and ')} px, and every behaviour holds`);
process.exit(fails ? 1 : 0);
