// Which WebGL renderer does this machine give a browser, and is it software?
//   node scripts/perf-tier.mjs [--headed] [--software] [--json]
// Prints the renderer string and says whether the site would pick its software tier (the same
// pattern as src/lib/tier.ts: swiftshader, llvmpipe, software, basic render, or no WebGL at all).
// Default is a real, off-screen browser window (headed, parked out of sight) so the owner sees the
// GPU their browser really gets; --headed is accepted for symmetry. --software forces SwiftShader,
// the run that stands in for the Microsoft Basic Render Driver machine. Muted, local, no network.
// Exit code: 0 = hardware renderer, 3 = software or no WebGL (so scripts can branch on it).
// This tells you WHAT renders, never HOW FAST: a headless run cannot see frame cost.
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const software = args.includes('--software');
const asJson = args.includes('--json');
const SOFT_RE = /swiftshader|llvmpipe|software|basic render/i;
const MUTED = ['--mute-audio'];
const launchArgs = software
  ? { headless: true, args: [...MUTED, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
  : { headless: false, args: [...MUTED, '--window-position=-2400,-2400', '--enable-gpu', '--ignore-gpu-blocklist'] };

async function launch() {
  for (const channel of ['msedge', 'chrome', undefined]) {
    try { return { browser: await chromium.launch({ ...launchArgs, ...(channel ? { channel } : {}) }), channel: channel ?? 'bundled chromium' }; }
    catch { /* try the next browser */ }
  }
  throw new Error('no browser found: install Edge or Chrome, or run `npx playwright-core install chromium`');
}

const { browser, channel } = await launch();
const page = await browser.newPage();
const info = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const g = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!g) return { webgl: false };
  const x = g.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl: true,
    renderer: x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
    vendor: x ? g.getParameter(x.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
    version: g.getParameter(g.VERSION),
    maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE),
    unmasked: !!x,
  };
});
await browser.close();

const isSoftware = !info.webgl || SOFT_RE.test(info.renderer);
const out = { browser: channel, mode: software ? 'forced software' : 'headed off screen', ...info, isSoftware, tier: isSoftware ? 'software' : 'hardware (a probe may still demote it)' };
if (asJson) console.log(JSON.stringify(out));
else {
  console.log(`browser   ${out.browser} (${out.mode})`);
  console.log(`webgl     ${info.webgl ? info.version : 'none'}`);
  if (info.webgl) {
    console.log(`renderer  ${info.renderer}${info.unmasked ? '' : '  (browser hides the real name)'}`);
    console.log(`vendor    ${info.vendor}`);
    console.log(`max tex   ${info.maxTexture}`);
  }
  console.log(`software  ${isSoftware ? 'YES' : 'no'}  -> site tier: ${out.tier}`);
  console.log('note      this names the renderer only; frame cost on this machine is UNVERIFIED until you watch it run.');
}
process.exit(isSoftware ? 3 : 0);
