// Mode-isolation gate: npm run check:modes
//   node scripts/gates/check-modes.mjs [--css <file>] [--root <dir>]
// src/styles/a11y-modes.css carries the forced-colors and increased-contrast rules. Its promise is that
// the DEFAULT look is untouched, so every top-level block in it must be an
// `@media (forced-colors: active)` or `@media (prefers-contrast: more)` block, and nothing else may
// sit at the top level (no bare rule, no other at-rule, no @import, no declaration). Exit 1 otherwise.
// The same promise needs the media queries to live ONLY there: every other .css under the root (default src/, or the
// folder of --css) is scanned for forced-colors, prefers-contrast and inverted-colors queries, and one found there
// fails, except the reviewed files in EXCEPTIONS (a stale entry fails too). A mode rule in global.css would sit in the
// cascade out of sight of the file the rest of the gate and the browser check (modes.mjs) are written around.
// A screenshot diff proves the look once; this keeps it true for the next edit.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const i = args.indexOf('--css');
const file = resolve(i >= 0 ? args[i + 1] : fileURLToPath(new URL('../../src/styles/a11y-modes.css', import.meta.url)));
const rel = relative(process.cwd(), file).split(sep).join('/');
if (!existsSync(file)) { console.error(`FAIL: ${rel} does not exist`); process.exit(1); }
const r = args.indexOf('--root');
const root = resolve(r >= 0 ? args[r + 1] : i >= 0 ? dirname(file) : fileURLToPath(new URL('../../src/', import.meta.url)));
// { "<path from root>.css": "<why a mode query may live there>" }. Empty on purpose: the one case there was (the
// scrub input's forced-colors outline in global.css) moved into a11y-modes.css, with identical computed styles.
const EXCEPTIONS = {};
const MODE_QUERY = /@media[^{;]*(?:forced-colors|prefers-contrast|inverted-colors)/i;
const cssFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? [] : e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []));

const ALLOWED = [/^@media\s*\(\s*forced-colors\s*:\s*active\s*\)$/i, /^@media\s*\(\s*prefers-contrast\s*:\s*more\s*\)$/i];
// comments out, strings kept literally (a "{" in a string must not move the depth)
const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
let depth = 0;
let prelude = '';
let blocks = 0;
const problems = [];
const lineOf = (idx) => src.slice(0, idx).split('\n').length;
let quote = '';
for (let k = 0; k < src.length; k++) {
  const c = src[k];
  if (quote) { if (c === quote && src[k - 1] !== '\\') quote = ''; if (depth === 0) prelude += c; continue; }
  if (c === '"' || c === "'") { quote = c; if (depth === 0) prelude += c; continue; }
  if (c === '{') {
    if (depth === 0) {
      const p = prelude.replace(/\s+/g, ' ').trim();
      blocks++;
      if (!ALLOWED.some((re) => re.test(p))) problems.push(`${rel}:${lineOf(k)}: top-level block "${p.slice(0, 70)}" is not an @media (forced-colors: active) or (prefers-contrast: more) block`);
      prelude = '';
    }
    depth++;
  } else if (c === '}') {
    depth--;
    if (depth < 0) { problems.push(`${rel}:${lineOf(k)}: unbalanced "}"`); depth = 0; }
  } else if (c === ';' && depth === 0) {
    problems.push(`${rel}:${lineOf(k)}: top-level statement "${prelude.replace(/\s+/g, ' ').trim().slice(0, 70)};" (an @import or a stray declaration)`);
    prelude = '';
  } else if (depth === 0) prelude += c;
}
if (depth !== 0) problems.push(`${rel}: unbalanced "{" (depth ${depth} at end of file)`);
if (prelude.trim()) problems.push(`${rel}: trailing text outside any block: "${prelude.trim().slice(0, 70)}"`);
if (!blocks) problems.push(`${rel}: no @media blocks at all (the file is meant to carry the two mode blocks)`);

let scanned = 0;
const usedExceptions = new Set();
for (const other of cssFiles(root)) {
  if (resolve(other) === file) continue;
  scanned++;
  const name = relative(root, other).split(sep).join('/');
  const text = readFileSync(other, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const hit = text.match(MODE_QUERY);
  if (!hit) continue;
  if (Object.hasOwn(EXCEPTIONS, name)) { usedExceptions.add(name); continue; }
  problems.push(`${relative(process.cwd(), other).split(sep).join('/')}:${text.slice(0, hit.index).split('\n').length}: "${hit[0].replace(/\s+/g, ' ').slice(0, 60)}" belongs in ${rel}, the only file allowed to carry forced-colors / prefers-contrast rules`);
}
for (const name of Object.keys(EXCEPTIONS)) if (!usedExceptions.has(name)) problems.push(`EXCEPTIONS entry "${name}" is stale (that file carries no mode query now: delete the entry)`);

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `FAIL: ${problems.length} problem(s): the default look must not depend on ${rel}` : `ok: ${rel} has ${blocks} top-level block(s), every one inside a forced-colors or prefers-contrast media query; no mode query in the other ${scanned} stylesheet(s) (${usedExceptions.size} reviewed exception(s))`);
process.exit(problems.length ? 1 : 0);
