// Phone check: on every spotlight slide the play button must clear the mini player band (84px) and the page must not overflow sideways.
// usage: node scripts/phone-play.mjs <url>
import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://localhost:4381/';
const b = await chromium.launch({ args: ['--disable-features=MediaSessionService,HardwareMediaKeyHandling,GlobalMediaControls'] });
let bad = 0;
for (const [w, h] of [[393, 852], [375, 667], [360, 640], [320, 568]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto(url);
  await p.waitForTimeout(1200);
  const r = await p.evaluate(() => ({
    bottoms: [...document.querySelectorAll('.spot')].map((s) => Math.round(s.querySelector('.spot-actions .play').getBoundingClientRect().bottom)),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  const ok = r.bottoms.every((y) => y <= h - 84) && r.overflow <= 0;
  if (!ok) bad++;
  console.log(ok ? 'ok  ' : 'FAIL', `${w}x${h}`, 'limit', h - 84, 'bottoms', r.bottoms.join(','), 'overflow', r.overflow);
  if (w === 393 || w === 360) await p.screenshot({ path: `D:/rehndrop/_scratch/phone-${w}.png` });
  await p.close();
}
await b.close();
process.exit(bad ? 1 : 0);
