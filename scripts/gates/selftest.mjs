// Gate self-test: npm run test:gates
//   node scripts/gates/selftest.mjs [--skip-astro-check]
// Every gate is run against fixtures that must PASS and fixtures that must FAIL (non-zero exit AND
// the expected message), so a gate that has gone blind turns this red. Fixtures live in
// scripts/gates/fixtures/<gate>/<case>. A fixture folder with no case below, or a case with no folder,
// fails the run: the fixtures cannot drift from this table unnoticed.
//   page-load  fixtures are `src` trees (+ optional allow.json)
//   focus      fixtures are .css (+ .astro, optional allow.json)
//   html       fixtures are dist-like folders
//   modes      fixtures are folders holding an a11y-modes.css
//   astro-check fixtures are tiny Astro projects; they are type-checked with the repo's own astro check
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = fileURLToPath(new URL('../../', import.meta.url));
const fx = (gate, name) => join(here, 'fixtures', gate, name);
const skipAstro = process.argv.includes('--skip-astro-check');

const run = (script, args) => {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8', cwd: siteRoot });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};
const astroCheck = (root) => {
  const bin = join(siteRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
  const r = spawnSync(process.execPath, [bin, 'check', '--root', root], { encoding: 'utf8', cwd: root });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

const allowArg = (gate, name) => {
  const a = join(fx(gate, name), 'allow.json');
  return ['--allow', existsSync(a) ? a : join(fx(gate, name), 'no-allow-file.json')];
};

// [gate, case, expected exit ('pass' | 'fail'), message that must appear]
const CASES = [
  ['page-load', 'good', 'pass', /ok: 1 bundled script block/],
  ['page-load', 'good-transitive', 'pass', /page-load handled in scripts\/b\.ts/],
  ['page-load', 'good-after-swap', 'pass', /ok: 1 bundled/],
  ['page-load', 'good-allowed', 'pass', /ALLOWED components\/X\.astro/],
  ['page-load', 'bad-no-handler', 'fail', /never binds astro:page-load/],
  ['page-load', 'bad-comment-only', 'fail', /never binds astro:page-load/],
  ['page-load', 'bad-unresolved', 'fail', /unresolved relative import \.\.\/scripts\/missing/],
  ['page-load', 'bad-stale-allow', 'fail', /stale allow entry "components\/X\.astro" \(it now handles/],
  ['page-load', 'bad-stale-missing', 'fail', /stale allow entry "components\/Gone\.astro" \(file does not exist/],
  ['page-load', 'bad-bundled-beside-inline', 'fail', /never binds astro:page-load/],

  ['focus', 'good-transparent', 'pass', /^ok:|\nok:/],
  ['focus', 'good-forced', 'pass', /^ok:|\nok:/],
  ['focus', 'good-focus-pair', 'pass', /^ok:|\nok:/],
  ['focus', 'good-ring', 'pass', /^ok:|\nok:/],
  ['focus', 'good-allowed', 'pass', /1 reviewed allow entry/],
  ['focus', 'bad-none', 'fail', /outline removed on "\.scrub-input"/],
  ['focus', 'bad-zero', 'fail', /outline removed on "\.a:focus-visible"/],
  ['focus', 'bad-style-none', 'fail', /outline removed on "\.a"/],
  ['focus', 'bad-width-zero', 'fail', /outline removed on "\.a:focus-visible"/],
  ['focus', 'bad-important', 'fail', /outline removed on "\.a:focus"/],
  ['focus', 'bad-pair-without-ring', 'fail', /outline removed on "\.h:focus"/],
  ['focus', 'bad-stale-allow', 'fail', /stale allow entry "\.gone"/],
  ['focus', 'bad-astro-style', 'fail', /contains a <style> block/],

  ['html', 'good', 'pass', /ok: no hard errors/],
  ['html', 'good-warnings-only', 'pass', /WARN no-redundant-role[\s\S]*ok: no hard errors/],
  ['html', 'good-skips-underscore', 'pass', /1 file\(s\) checked/],
  ['html', 'bad-multiple-main', 'fail', /no-multiple-main/],
  ['html', 'bad-valid-id', 'fail', /valid-id/],
  ['html', 'bad-empty-heading', 'fail', /empty-heading/],
  ['html', 'bad-hidden-focusable', 'fail', /hidden-focusable/],
  ['html', 'bad-no-html', 'fail', /no \.html files/],

  ['modes', 'good', 'pass', /ok: .* 2 top-level block\(s\)/],
  ['modes', 'bad-bare-rule', 'fail', /top-level block "\.leak" is not an @media/],
  ['modes', 'bad-wrong-media', 'fail', /top-level block "@media \(min-width: 700px\)" is not an @media/],
  ['modes', 'bad-import', 'fail', /top-level statement "@import 'other\.css';"/],
  ['modes', 'bad-trailing-rule', 'fail', /top-level block "\.after" is not an @media/],
];
const ASTRO_CASES = [
  ['astro-check', 'good', 'pass', /0 errors/],
  ['astro-check', 'bad', 'fail', /error ts\(2322\)/],
];

let failures = 0;
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n       ${detail.split('\n').slice(0, 12).join('\n       ')}`}`);
  if (!ok) failures++;
};

// the table and the folders must agree
for (const gate of ['page-load', 'focus', 'html', 'modes', 'astro-check']) {
  const dir = join(here, 'fixtures', gate);
  const have = existsSync(dir) ? readdirSync(dir) : [];
  const want = [...CASES, ...ASTRO_CASES].filter((c) => c[0] === gate).map((c) => c[1]);
  for (const n of have) if (!want.includes(n)) report(false, `fixtures/${gate}/${n}`, 'fixture folder has no case in selftest.mjs');
  for (const n of want) if (!have.includes(n)) report(false, `fixtures/${gate}/${n}`, 'case has no fixture folder');
}

for (const [gate, name, expect, msg] of CASES) {
  const dir = fx(gate, name);
  const r =
    gate === 'page-load' ? run('check-page-load.mjs', ['--root', join(dir, 'src'), ...allowArg(gate, name)])
    : gate === 'focus' ? run('focus-visible.mjs', ['--root', dir, ...allowArg(gate, name)])
    : gate === 'modes' ? run('check-modes.mjs', ['--css', join(dir, 'a11y-modes.css')])
    : run('check-html.mjs', ['--dist', dir]);
  const exitOk = expect === 'pass' ? r.code === 0 : r.code === 1;
  report(exitOk && msg.test(r.out), `${gate}/${name}: expect ${expect}${exitOk ? '' : ` (exit ${r.code})`}${exitOk && !msg.test(r.out) ? ` (message ${msg} missing)` : ''}`, r.out);
}

if (skipAstro) console.log('SKIP astro-check fixtures (--skip-astro-check)');
else {
  for (const [gate, name, expect, msg] of ASTRO_CASES) {
    const r = astroCheck(fx(gate, name));
    const exitOk = expect === 'pass' ? r.code === 0 : r.code !== 0;
    report(exitOk && msg.test(r.out.replace(/\x1b\[[0-9;]*m/g, '')), `${gate}/${name}: expect ${expect}${exitOk ? '' : ` (exit ${r.code})`}`, r.out);
  }
}

const total = CASES.length + (skipAstro ? 0 : ASTRO_CASES.length);
console.log(failures ? `\nFAIL: ${failures} of ${total} gate self-test case(s) wrong` : `\nok: all ${total} gate self-test cases behaved (good fixtures pass, bad fixtures fail with the expected message)`);
process.exit(failures ? 1 : 0);
