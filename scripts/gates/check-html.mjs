// Structural HTML gate over the built site: npm run check:html (needs a build: npm run build first).
//   node scripts/gates/check-html.mjs [--dist <dir>] [--verbose]
// Runs html-validate (recommended preset, no-inline-style off: the scene styles through custom
// properties on purpose) over every dist/**/*.html. Four rules are hard errors and fail the run (exit 1):
//   no-multiple-main, valid-id, empty-heading, hidden-focusable
// Every other finding is a warning: printed with a count per rule, never failing. Folders whose name
// starts with an underscore (screenshot or scratch output such as _shots) are skipped; _astro holds
// no HTML. A missing or empty dist fails: a gate that finds nothing to check must not pass.
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HtmlValidate } from 'html-validate';
import { platformGuide } from './platform-guide.mjs';

export const HARD = ['no-multiple-main', 'valid-id', 'empty-heading', 'hidden-focusable'];
// the hard rules that a guide of the platform-currency pack covers (landmarks, aria-hidden on focusable content)
const GUIDED = ['no-multiple-main', 'hidden-focusable'];
const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const dist = resolve(argAfter('--dist') ?? fileURLToPath(new URL('../../dist/', import.meta.url)));
const verbose = args.includes('--verbose');

if (!existsSync(dist)) {
  console.error(`FAIL: ${dist} does not exist. Run npm run build first.`);
  process.exit(1);
}

const skipDir = (name) => name.startsWith('_') && name !== '_astro';
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!skipDir(e.name)) yield* walk(p); }
    else if (e.name.endsWith('.html')) yield p;
  }
}

const hv = new HtmlValidate({
  extends: ['html-validate:recommended'],
  rules: { 'no-inline-style': 'off' },
});

const files = [];
for await (const f of walk(dist)) files.push(f);
if (!files.length) {
  console.error(`FAIL: no .html files under ${dist}. Run npm run build first.`);
  process.exit(1);
}
files.sort();

const hard = [];
const hardRules = new Set();
const warn = new Map();
for (const f of files) {
  const report = await hv.validateFile(f);
  for (const r of report.results) {
    for (const m of r.messages) {
      const rel = relative(dist, f).split(sep).join('/');
      if (HARD.includes(m.ruleId)) hardRules.add(m.ruleId), hard.push(`${rel}:${m.line}:${m.column} ${m.ruleId}: ${m.message}`);
      else {
        const w = warn.get(m.ruleId) ?? { n: 0, files: new Set(), sample: `${rel}:${m.line} ${m.message}` };
        w.n++; w.files.add(rel);
        warn.set(m.ruleId, w);
      }
    }
  }
}

console.log(`html-validate: ${files.length} file(s) checked under ${relative(process.cwd(), dist) || '.'}`);
const total = [...warn.values()].reduce((a, w) => a + w.n, 0);
if (warn.size) {
  console.log(`warnings (not failing): ${total} across ${warn.size} rule(s)`);
  for (const [id, w] of [...warn].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  WARN ${id.padEnd(28)} ${String(w.n).padStart(5)} in ${String(w.files.size).padStart(2)} file(s)${verbose ? `  e.g. ${w.sample}` : ''}`);
  }
}
if (hard.length) {
  console.error(`\nFAIL: ${hard.length} hard error(s) (${HARD.join(', ')})`);
  for (const h of hard) console.error('  ' + h);
  if (GUIDED.some((r) => hardRules.has(r))) console.error('  ' + platformGuide('accessibility'));
  process.exit(1);
}
console.log(`ok: no hard errors (${HARD.join(', ')})`);
