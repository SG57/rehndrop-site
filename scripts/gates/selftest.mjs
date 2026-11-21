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
//   csp        fixtures are dist-like folders whose pages carry a policy meta tag
//   type-units fixtures are folders of .css files
//   astro-check fixtures are tiny Astro projects; they are type-checked with the repo's own astro check
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  ['page-load', 'good-self-closing', 'pass', /ok: 1 bundled/],
  ['page-load', 'bad-self-closing-hides', 'fail', /never binds astro:page-load/],

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

  ['type-units', 'good', 'pass', /ok: 6 font-size declaration\(s\) in 1 stylesheet\(s\), none in px alone/],
  ['type-units', 'bad-px', 'fail', /font size "13px" is in px/],
  ['type-units', 'bad-clamp-px', 'fail', /font size "clamp\(20px, 5\.6vw, 40px\)" is in px/],
  ['type-units', 'bad-decimal-px', 'fail', /font size "13\.5px" is in px/],
  ['type-units', 'bad-shorthand', 'fail', /font size "13px\/1\.4 serif" is in px/],
  ['type-units', 'bad-nested-media', 'fail', /a\.css:2:\d+ font size "14px" is in px/],
  ['type-units', 'bad-blind', 'fail', /no font-size declaration found/],

  ['csp', 'good', 'pass', /ok: 2 page\(s\), one policy/],
  ['csp', 'bad-no-meta', 'fail', /no <meta http-equiv="content-security-policy"> tag/],
  ['csp', 'bad-unhashed-script', 'fail', /inline <script> \(18 bytes, starts "window\.__evil = 1;"\) has no hash in script-src/],
  ['csp', 'bad-unhashed-style', 'fail', /inline <style> \(14 bytes, starts "body\{margin:0\}"\) has no hash in style-src/],
  ['csp', 'bad-unsafe-inline', 'fail', /script-src carries a weak source: 'unsafe-inline'/],
  ['csp', 'bad-style-unsafe-inline', 'fail', /style-src carries a weak source: 'unsafe-inline'/],
  ['csp', 'bad-data-source', 'fail', /script-src carries a weak source: data:/],
  ['csp', 'bad-inline-module', 'fail', /inline <script type="module">: the client router would inject a data: script/],
  ['csp', 'bad-external-script', 'fail', /external <script src="https:\/\/cdn\.example\.com\/a\.js"> \(not same-origin\)/],
  ['csp', 'bad-no-object-src', 'fail', /policy object-src is "missing", not 'none'/],
  ['csp', 'bad-no-base-uri', 'fail', /policy has no base-uri/],
  ['csp', 'bad-default-src-wide', 'fail', /policy default-src is "'self' https:", not 'self'/],
  ['csp', 'bad-policy-differs', 'fail', /pages carry 2 different policies/],
  ['csp', 'bad-style-attr-no-directive', 'fail', /inline style="" attributes on the page, but the policy has no style-src-attr/],
  ['csp', 'bad-json-lt', 'fail', /data block <script type="application\/json" id="player-data"> holds a raw "<"/],
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
for (const gate of ['page-load', 'focus', 'html', 'modes', 'type-units', 'csp', 'astro-check']) {
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
    : gate === 'type-units' ? run('check-type-units.mjs', ['--root', dir])
    : gate === 'csp' ? run('check-csp.mjs', ['--dist', dir])
    : run('check-html.mjs', ['--dist', dir]);
  const exitOk = expect === 'pass' ? r.code === 0 : r.code === 1;
  report(exitOk && msg.test(r.out), `${gate}/${name}: expect ${expect}${exitOk ? '' : ` (exit ${r.code})`}${exitOk && !msg.test(r.out) ? ` (message ${msg} missing)` : ''}`, r.out);
}

// jsonScript (src/lib/json-script.mjs): a title that tries to close the data block is escaped, and parses back unchanged
{
  const { jsonScript } = await import('../../src/lib/json-script.mjs');
  const evil = { title: '</script><img src=x onerror=alert(1)>', n: 1 };
  const out = jsonScript(evil);
  report(!out.includes('<') && JSON.stringify(JSON.parse(out)) === JSON.stringify(evil), 'jsonScript: escapes < and round-trips', out);
}
// Platform-currency pointers: a failing gate may point at a guide of the platform-currency pack, never instead of its
// own message (every CASES row above still asserts that). Each row names a fixture that fails, and whether the pointer
// must be there, so a footer that drifts onto an unrelated failure, or is dropped, turns this red. PACK_GUIDE_IDS was
// read from gen/guides.json of the pack at version 1.0.1 (2026-11-21): it catches a typo or an invented id in a
// message, it does not prove the pack still carries the guide.
const PACK_GUIDE_IDS = new Set(['accessibility', 'respect-os-text-scale']);
const A11Y_POINTER = 'platform-currency guide: accessibility (repo rules still win)';
const POINTERS = [
  ['focus', 'bad-none', A11Y_POINTER, true],
  ['focus', 'bad-stale-allow', A11Y_POINTER, false],
  ['html', 'bad-multiple-main', A11Y_POINTER, true],
  ['html', 'bad-hidden-focusable', A11Y_POINTER, true],
  ['html', 'bad-valid-id', A11Y_POINTER, false],
  ['html', 'bad-empty-heading', A11Y_POINTER, false],
  ['type-units', 'bad-px', 'platform-currency guide: respect-os-text-scale (repo rules still win; it asks for no root font-size', true],
  ['type-units', 'bad-blind', 'platform-currency guide', false],
  ['page-load', 'bad-no-handler', 'platform-currency: pack guides that show DOMContentLoaded do not apply here (repo rules still win)', true],
  ['page-load', 'bad-unresolved', 'platform-currency', false],
  ['csp', 'bad-unhashed-script', 'platform-currency: some pack guides show inline scripts', true],
  ['csp', 'bad-external-script', 'platform-currency: some pack guides show inline scripts', true],
  ['csp', 'bad-no-base-uri', 'platform-currency', false],
];
const runCase = (gate, name) =>
  gate === 'page-load' ? run('check-page-load.mjs', ['--root', join(fx(gate, name), 'src'), ...allowArg(gate, name)])
  : gate === 'focus' ? run('focus-visible.mjs', ['--root', fx(gate, name), ...allowArg(gate, name)])
  : gate === 'type-units' ? run('check-type-units.mjs', ['--root', fx(gate, name)])
  : gate === 'csp' ? run('check-csp.mjs', ['--dist', fx(gate, name)])
  : run('check-html.mjs', ['--dist', fx(gate, name)]);
for (const [gate, name, text, expected] of POINTERS) {
  const r = runCase(gate, name);
  const has = r.out.includes(text);
  report(r.code === 1 && has === expected, `${gate}/${name}: pointer ${expected ? 'present' : 'absent'}${r.code === 1 ? '' : ` (exit ${r.code}, expected 1)`}${has === expected ? '' : ` (pointer ${has ? 'found' : 'missing'})`}`, r.out);
}
{
  const cited = [];
  for (const f of readdirSync(here).filter((n) => /\.mjs$/.test(n) && n !== 'selftest.mjs')) {
    for (const m of readFileSync(join(here, f), 'utf8').matchAll(/platformGuide\(\s*['"]([^'"]+)['"]/g)) cited.push([f, m[1]]);
  }
  const bad = cited.filter(([, id]) => !PACK_GUIDE_IDS.has(id));
  report(cited.length >= 3 && bad.length === 0, `platform guide ids cited by the gates are verified pack ids (${cited.length} cited)`, bad.map(([f, id]) => `${f}: ${id}`).join('\n') || 'no citation found');
}
const POINTER_CHECKS = POINTERS.length + 1;

if (skipAstro) console.log('SKIP astro-check fixtures (--skip-astro-check)');
else {
  for (const [gate, name, expect, msg] of ASTRO_CASES) {
    const r = astroCheck(fx(gate, name));
    const exitOk = expect === 'pass' ? r.code === 0 : r.code !== 0;
    report(exitOk && msg.test(r.out.replace(/\x1b\[[0-9;]*m/g, '')), `${gate}/${name}: expect ${expect}${exitOk ? '' : ` (exit ${r.code})`}`, r.out);
  }
}

const total = CASES.length + POINTER_CHECKS + (skipAstro ? 0 : ASTRO_CASES.length);
console.log(failures ? `\nFAIL: ${failures} of ${total} gate self-test case(s) wrong` : `\nok: all ${total} gate self-test cases behaved (good fixtures pass, bad fixtures fail with the expected message)`);
process.exit(failures ? 1 : 0);
