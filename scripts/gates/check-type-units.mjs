// Type-scale gate: npm run check:type-units
//   node scripts/gates/check-type-units.mjs [--root <src dir>]
// Every font-size under the root (.css files) must scale with the visitor's browser font size, so it is written in
// rem (or em, %, or a keyword), never in px alone. A px value is accepted only as the floor of a rem expression,
// e.g. `max(1rem, 16px)`. The font shorthand must not carry a px size either. Exit 1 on any px size.
// Why a gate: the type scale was converted from px to rem once, proven pixel-identical at the default 16px root;
// this keeps the next edit from putting a px size back, which would stop that text following the reader's setting.
// Layout lengths (padding, height, calc() offsets) and media queries stay in px on purpose and are not read here.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';

const args = process.argv.slice(2);
const i = args.indexOf('--root');
const root = resolve(i >= 0 ? args[i + 1] : fileURLToPath(new URL('../../src/', import.meta.url)));
const rel = (p) => relative(process.cwd(), p).split(sep).join('/');
if (!existsSync(root)) { console.error(`FAIL: ${root} does not exist`); process.exit(1); }

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
const css = [];
for await (const f of walk(root)) if (f.endsWith('.css')) css.push(f);
if (!css.length) { console.error(`FAIL: no .css files under ${rel(root)}`); process.exit(1); }

// a value is rejected when it has a px length and no rem/em length beside it (the max(1rem, 16px) floor passes)
const PX_ONLY = '/^(?!.*[0-9](rem|em)(?![a-z])).*[0-9]px(?![a-z])/i';
const message = (_prop, value) => `font size "${value}" is in px: write it in rem (px / 16) so the reader's browser font size applies`;
const config = { rules: {
  'declaration-property-value-disallowed-list': [{ 'font-size': [PX_ONLY], font: [PX_ONLY] }, { message }],
} };

const problems = [];
let declarations = 0;
for (const file of css.sort()) {
  const code = await readFile(file, 'utf8');
  declarations += (code.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|[;{\s])font-size\s*:/g) ?? []).length;
  const out = await stylelint.lint({ code, codeFilename: file, config });
  for (const w of out.results.flatMap((r) => [...r.warnings, ...r.parseErrors])) problems.push(`${rel(file)}:${w.line}:${w.column} ${w.text.replace(/\s*\(declaration-property-value-disallowed-list\)$/, '')}`);
}
if (!declarations) problems.push(`${rel(root)}: no font-size declaration found in ${css.length} stylesheet(s): the gate would pass blind`);

if (problems.length) {
  console.error(`FAIL: ${problems.length} type-scale problem(s) in ${css.length} stylesheet(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`ok: ${declarations} font-size declaration(s) in ${css.length} stylesheet(s), none in px alone`);
