// Focus-ring regression gate: npm run check:focus
//   node scripts/gates/focus-visible.mjs [--root <src dir>] [--allow <allow.json>]
// Runs the local/focus-outline-replacement stylelint rule (focus-outline-plugin.mjs) over every .css
// under the root. Exit 1 on any outline that is removed without a replacement that survives
// forced-colors mode, on a stale allow-list entry (one that no longer matches an outline removal),
// and on a <style> block inside an .astro file (this gate reads .css only, so such a block would
// escape it silently: extend the gate before adding one).
// The allow list is scripts/gates/focus-allow.json: { "<selector>": "<why removing the outline is safe>" }.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import plugin, { ruleName } from './focus-outline-plugin.mjs';
import { platformGuide } from './platform-guide.mjs';

const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const root = resolve(argAfter('--root') ?? fileURLToPath(new URL('../../src/', import.meta.url)));
const allowFile = resolve(argAfter('--allow') ?? fileURLToPath(new URL('./focus-allow.json', import.meta.url)));
const rel = (p) => relative(process.cwd(), p).split(sep).join('/');

if (!existsSync(root)) { console.error(`FAIL: ${root} does not exist`); process.exit(1); }
const allow = existsSync(allowFile) ? JSON.parse(await readFile(allowFile, 'utf8')) : {};

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const css = [];
const problems = [];
for await (const f of walk(root)) {
  if (f.endsWith('.css')) css.push(f);
  else if (f.endsWith('.astro') && /<style[\s>]/i.test(await readFile(f, 'utf8'))) {
    problems.push(`${rel(f)}: contains a <style> block, which this gate does not read (it lints .css files only)`);
  }
}
if (!css.length) { console.error(`FAIL: no .css files under ${rel(root)}`); process.exit(1); }

const used = new Set();
for (const file of css.sort()) {
  const out = await stylelint.lint({
    code: await readFile(file, 'utf8'),
    codeFilename: file,
    config: { plugins: [plugin], rules: { [ruleName]: [true, { allow, onAllowUsed: (s) => used.add(s) }] } },
  });
  for (const w of out.results.flatMap((r) => [...r.warnings, ...r.parseErrors])) {
    problems.push(`${rel(file)}:${w.line}:${w.column} ${w.text}`);
  }
}
for (const sel of Object.keys(allow)) {
  if (!used.has(sel)) problems.push(`${rel(allowFile)}: stale allow entry "${sel}" (no outline removal matches it any more: delete the entry)`);
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} focus-ring problem(s) in ${css.length} stylesheet(s)`);
  for (const p of problems) console.error('  ' + p);
  if (problems.some((p) => p.includes('outline removed on'))) console.error('  ' + platformGuide('accessibility'));
  process.exit(1);
}
console.log(`ok: ${css.length} stylesheet(s), no outline removed without a forced-colors-safe replacement (${used.size} reviewed allow entr${used.size === 1 ? 'y' : 'ies'})`);
