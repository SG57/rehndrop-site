// Mode-isolation gate: npm run check:modes
//   node scripts/gates/check-modes.mjs [--css <file>]
// src/styles/a11y-modes.css carries the forced-colors and increased-contrast rules. Its promise is that
// the DEFAULT look is untouched, so every top-level block in it must be an
// `@media (forced-colors: active)` or `@media (prefers-contrast: more)` block, and nothing else may
// sit at the top level (no bare rule, no other at-rule, no @import, no declaration). Exit 1 otherwise.
// A screenshot diff proves the look once; this keeps it true for the next edit.
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const i = args.indexOf('--css');
const file = resolve(i >= 0 ? args[i + 1] : fileURLToPath(new URL('../../src/styles/a11y-modes.css', import.meta.url)));
const rel = relative(process.cwd(), file).split(sep).join('/');
if (!existsSync(file)) { console.error(`FAIL: ${rel} does not exist`); process.exit(1); }

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

for (const p of problems) console.log(`FAIL ${p}`);
console.log(problems.length ? `FAIL: ${problems.length} problem(s): the default look must not depend on ${rel}` : `ok: ${rel} has ${blocks} top-level block(s), every one inside a forced-colors or prefers-contrast media query`);
process.exit(problems.length ? 1 : 0);
