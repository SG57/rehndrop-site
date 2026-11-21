// Pre-push gate run: npm run gates:local [-- --quick] [-- --skip-long]
// Everything CI runs, plus what needs a real browser. Run it before pushing to main: a push to main
// deploys. Steps, stopping at the first failure:
//   1. test:gates        the gates against their good and bad fixtures
//   2. build             npm run build (re-reads Apple and YouTube, falls back to snapshots)
//   3. gates             assets:check, astro check, page-load, focus-visible, html-validate on dist
//   4. qa                10 device viewports and the behaviour checks (scripts/qa.mjs)
//   5. router-spotlight  the spotlight buttons across client-router swaps
//   6. legibility        text contrast over the live background, on a local preview server
// --quick limits qa to two devices and legibility to the laptop run, and skips the 40 s teaser test. The
// full legibility pass (3 devices, every plate) took about 13 minutes on the author's machine.
// --skip-long passes through to qa. --no-build reuses the existing dist/.
// Browser: installed Edge; QA_BROWSER_CHANNEL=chrome (or bundled) picks another (see scripts/qa.mjs).
// The browser is always muted and never on screen; nothing is published.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const skipLong = quick || args.includes('--skip-long');
const noBuild = args.includes('--no-build');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;
const BASE = existsSync(new URL('../../public/CNAME', import.meta.url)) ? '/' : '/rehndrop-site/';
const PORT = 4331;

const results = [];
let preview = null;
const step = (name, cmd, cmdArgs, opts = {}) => {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: site, stdio: 'inherit', shell: cmd === npm, ...opts });
  const ok = r.status === 0;
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name} (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!ok) finish(1);
  return ok;
};
function finish(code) {
  preview?.kill();
  console.log(`\n${results.join('\n')}`);
  console.log(code ? '\nFAIL: do not push' : '\nok: every gate held');
  process.exit(code);
}

step('test:gates', npm, ['run', 'test:gates']);
if (!noBuild) step('build', npm, ['run', 'build']);
step('gates', npm, ['run', 'gates']);
step('qa', node, ['scripts/qa.mjs', ...(quick ? ['--only', 'iphone-15,laptop'] : []), ...(skipLong ? ['--skip-long'] : [])]);

preview = spawn(node, ['node_modules/astro/bin/astro.mjs', 'preview', '--port', String(PORT)], { cwd: site, stdio: 'ignore' });
const origin = `http://localhost:${PORT}${BASE}`;
for (let i = 0; ; i++) {
  try { if ((await fetch(origin)).ok) break; } catch { /* not up yet */ }
  if (i > 60) { console.error('FAIL: astro preview did not come up'); results.push('FAIL preview server'); finish(1); }
  await new Promise((r) => setTimeout(r, 500));
}
step('router-spotlight', node, ['scripts/gates/router-spotlight.mjs', origin]);
step('legibility', node, ['scripts/legibility.mjs', origin, ...(quick ? ['--only', 'laptop'] : [])]);
finish(0);
