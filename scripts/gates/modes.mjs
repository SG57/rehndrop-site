// Browser check: the forced-colors and increased-contrast modes do what a11y-modes.css says, and the
// default mode does not move.
//   node scripts/gates/modes.mjs <origin-with-base>      e.g. http://localhost:4321/
// Computed styles, not screenshots, so it can fail precisely. In every case the page also loads without a
// console error or page error (the stage layers are hidden, not removed, so no script loses its canvas).
//   default          the stage is drawn (velvet, lens and grain visible, grain at 7%), the ink is the
//                    default #c9cdd2, the focus ring is 2px: the same page the modes start from
//   forced colors    velvet, lens, grain and water are not drawn (the lens and water canvases keep their
//                    boxes: visibility:hidden, not display:none); text on the page reaches 7:1 against Canvas; the contact dialog is Canvas with a
//                    CanvasText edge; the selected view button is Highlight; the play disc has a ButtonText
//                    edge; the keyboard focus ring is a 2px Highlight outline
//   prefers-contrast the grain is a dark veil (not noise), the inks are #f4f6f7, the focus ring is 3px
// Part of `npm run gates:local` (needs a browser). Exit 1 on any failed expectation.
// Playwright emulates the media features; real Windows contrast themes and a real GPU are not covered.
// Browser: installed Edge, or QA_BROWSER_CHANNEL (see scripts/qa.mjs). Muted, never on screen.
import { chromium } from 'playwright-core';

const origin = process.argv[2];
if (!origin) { console.error('usage: node scripts/gates/modes.mjs <origin-with-base>'); process.exit(2); }
const base = origin.endsWith('/') ? origin : origin + '/';
const BROWSER = process.env.QA_BROWSER_CHANNEL || 'msedge';
const browser = await chromium.launch({ ...(BROWSER === 'bundled' ? {} : { channel: BROWSER }), headless: true, args: ['--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

let fails = 0;
const expect = (ok, msg) => { console.log(ok ? 'ok  ' : 'FAIL', msg); if (!ok) fails++; };

const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

async function session(label, options, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const errors = [];
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base + '?lens&t=1700000000000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await fn(page);
  expect(!errors.length, `${label}: no console or page errors${errors.length ? ` (${errors.slice(0, 2).join(' | ')})` : ''}`);
  await ctx.close();
}

// computed style of a selector, plus system colors resolved by a probe element
const css = (page, selector, props) => page.evaluate(([sel, ps]) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const cs = getComputedStyle(el);
  return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
}, [selector, props]);
const sys = (page, names) => page.evaluate((ns) => {
  const out = {};
  for (const n of ns) {
    const p = document.createElement('i');
    p.style.color = n;
    document.body.appendChild(p);
    out[n] = getComputedStyle(p).color;
    p.remove();
  }
  return out;
}, names);
const box = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; }, selector);
const focusFirst = async (page) => {
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(450); // the ring grows in over 0.25 s
  return css(page, ':focus-visible', ['outline-style', 'outline-width', 'outline-color']);
};

await session('default', {}, async (page) => {
  const stage = await css(page, '.velvet', ['visibility']);
  const lens = await css(page, '.lens', ['visibility']);
  const grain = await css(page, '.grain', ['visibility', 'opacity', 'background-image']);
  const ink = await css(page, '.foot-line', ['color']);
  const ring = await focusFirst(page);
  expect(stage.visibility === 'visible' && lens.visibility === 'visible' && grain.visibility === 'visible', 'default: velvet, lens and grain are drawn');
  expect(grain.opacity === '0.07' && grain['background-image'] !== 'none', `default: the grain is the 7% noise (opacity ${grain.opacity})`);
  expect(rgb(ink.color).join() === '201,205,210', `default: the credit ink is #c9cdd2 (${ink.color})`);
  expect(ring && ring['outline-width'] === '2px', `default: the focus ring is 2px (${ring && ring['outline-width']})`);
});

await session('forced colors', { forcedColors: 'active' }, async (page) => {
  // velvet and grain may already be display:none on the software tier; "not drawn" is all that matters for them
  for (const sel of ['.velvet', '.grain']) {
    const v = await css(page, sel, ['visibility', 'display']);
    expect(v && (v.visibility === 'hidden' || v.display === 'none'), `forced: ${sel} is not drawn (visibility ${v && v.visibility}, display ${v && v.display})`);
  }
  // the canvases keep a size, so no script divides by a zero-size box
  for (const sel of ['.lens', '.drops-layer']) {
    const v = await css(page, sel, ['visibility']);
    const b = await box(page, sel);
    expect(v && v.visibility === 'hidden' && b && b[0] > 0 && b[1] > 0, `forced: ${sel} is hidden but keeps its box (${v && v.visibility}, ${b})`);
  }
  const c = await sys(page, ['Canvas', 'CanvasText', 'Highlight', 'ButtonText']);
  // every piece of text we sample must reach 7:1 against Canvas, the only thing behind it now
  for (const sel of ['.spot.is-current .spot-title', '.spot.is-current .spot-answer', '#index .ix-title', '#index .ix-sub', '.foot-line', '.contact-mail']) {
    const s = await css(page, sel, ['color']);
    const r = s ? ratio(rgb(s.color), rgb(c.Canvas)) : 0;
    expect(r >= 7, `forced: ${sel} is ${s && s.color} on Canvas, ${r.toFixed(1)}:1`);
  }
  const view = await css(page, '.ix-view[aria-pressed="true"]', ['background-color']);
  expect(view && view['background-color'] === c.Highlight, `forced: the selected view button is Highlight (${view && view['background-color']})`);
  const play = await css(page, '.play', ['border-top-width', 'border-top-color', 'border-top-style']);
  expect(play && play['border-top-width'] === '2px' && play['border-top-color'] === c.ButtonText && play['border-top-style'] === 'solid', `forced: the play disc has a ButtonText edge (${play && JSON.stringify(play)})`);
  const ring = await focusFirst(page);
  expect(ring && ring['outline-style'] === 'solid' && ring['outline-width'] === '2px' && ring['outline-color'] === c.Highlight, `forced: the focus ring is a 2px Highlight outline (${ring && JSON.stringify(ring)})`);
  await page.locator('[data-contact-open]').first().scrollIntoViewIfNeeded();
  await page.locator('[data-contact-open]').first().click();
  await page.waitForTimeout(700);
  const sheet = await css(page, 'dialog.sheet[open]', ['background-color', 'border-top-color', 'border-top-width', 'color']);
  expect(sheet && sheet['background-color'] === c.Canvas && sheet['border-top-color'] === c.CanvasText && sheet['border-top-width'] === '1px', `forced: the contact dialog is Canvas with a CanvasText edge (${sheet && JSON.stringify(sheet)})`);
  expect(sheet && ratio(rgb(sheet.color), rgb(sheet['background-color'])) >= 7, 'forced: the dialog text reaches 7:1 on its panel');
});

await session('prefers-contrast', { contrast: 'more' }, async (page) => {
  const grain = await css(page, '.grain', ['visibility', 'opacity', 'background-image', 'background-color', 'display']);
  const ink = await css(page, '.foot-line', ['color']);
  const ring = await focusFirst(page);
  expect(grain.display === 'block' && grain.opacity === '1' && grain['background-image'] === 'none' && /rgba\(2, 2, 4, 0\.4\)/.test(grain['background-color']), `contrast: the grain is a plain dark veil (${JSON.stringify(grain)})`);
  expect(rgb(ink.color).join() === '244,246,247', `contrast: the credit ink is #f4f6f7 (${ink.color})`);
  expect(ring && ring['outline-width'] === '3px', `contrast: the focus ring is 3px (${ring && ring['outline-width']})`);
});

await browser.close();
console.log(fails ? `FAIL: ${fails} mode expectation(s) failed` : 'ok: default, forced-colors and prefers-contrast behave as specified');
process.exit(fails ? 1 : 0);
