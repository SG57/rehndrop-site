// ClientRouter page-load gate: npm run check:page-load
//   node scripts/gates/check-page-load.mjs [--root <src dir>] [--allow <allow.json>]
// With the client router, a bundled <script> in an .astro file runs once, on the first page that
// carries it, and never again after a navigation swaps the page. Code that wires up the page's DOM
// must therefore rebind on `astro:page-load` (or `astro:after-swap`). This gate fails when a bundled
// script is not tied to one of them.
// For every bundled <script> block in every .astro file under the root it follows RELATIVE imports
// (./x, ../lib/y, dynamic import() too; .ts .js .mjs .tsx, or /index) to the full import closure and
// requires an addEventListener('astro:page-load' | 'astro:after-swap', ...) call somewhere in that
// closure. Comments are stripped first, so a mention in prose does not count. An import that cannot
// be resolved fails: the gate never silently stops following a chain.
// Not checked: is:inline scripts (the router re-runs those on every swap), JSON and importmap blocks,
// scripts with src=.
// Allow list (scripts/gates/page-load.allow.json): { "<path from root>.astro": "<why>" } for the rare
// script that is correct without a rebind, because it installs one delegated document-level
// listener once and resolves its elements when the event fires. It is a reviewed list: an entry whose
// file is gone, has no bundled script, or now does handle page-load fails as stale.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const root = resolve(argAfter('--root') ?? fileURLToPath(new URL('../../src/', import.meta.url)));
const allowFile = resolve(argAfter('--allow') ?? fileURLToPath(new URL('./page-load.allow.json', import.meta.url)));
const posix = (p) => p.split(sep).join('/');
const fromRoot = (p) => posix(relative(root, p));

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

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const HANDLER = /addEventListener\(\s*['"`]astro:(?:page-load|after-swap)['"`]/;
const IMPORTS = [
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"`](\.[^'"`]+)['"`]/g,
  /(?:^|[\s;])import\s*['"`](\.[^'"`]+)['"`]/g,
  /\bimport\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g,
];
const CODE = ['.ts', '.tsx', '.js', '.mjs'];
const SKIP_SCRIPT = /is:inline|data-astro-rerun|\bsrc\s*=|type\s*=\s*["'](?:application\/(?:ld\+)?json|importmap|speculationrules)["']/i;

function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec);
  if (/\.(css|astro|json|svg)$/i.test(spec)) return 'skip';
  for (const c of [base, ...CODE.map((e) => base + e), ...CODE.map((e) => join(base, 'index' + e))]) {
    if (CODE.some((e) => c.endsWith(e)) && existsSync(c)) return c;
  }
  return null;
}

const cache = new Map();
const read = async (f) => cache.get(f) ?? (cache.set(f, stripComments(await readFile(f, 'utf8'))), cache.get(f));

/** Import closure of a script body; returns { files, unresolved }. */
async function closure(entryFile, body) {
  const files = [];
  const unresolved = [];
  const seen = new Set();
  const visit = async (from, code) => {
    for (const re of IMPORTS) {
      re.lastIndex = 0;
      for (const m of code.matchAll(re)) {
        const r = resolveImport(from, m[1]);
        if (r === 'skip') continue;
        if (!r) { unresolved.push(`${m[1]} (from ${fromRoot(from)})`); continue; }
        if (seen.has(r)) continue;
        seen.add(r);
        files.push(r);
        await visit(r, await read(r));
      }
    }
  };
  await visit(entryFile, body);
  return { files, unresolved };
}

const astro = [];
let router = false;
for await (const f of walk(root)) {
  if (!f.endsWith('.astro')) continue;
  astro.push(f);
  if (!router && /<(?:ClientRouter|ViewTransitions)\b/.test(await readFile(f, 'utf8'))) router = true;
}
if (!astro.length) { console.error(`FAIL: no .astro files under ${root}`); process.exit(1); }
if (!router) { console.log(`SKIP: no <ClientRouter /> under ${posix(relative(process.cwd(), root))}, nothing to check`); process.exit(0); }

const problems = [];
const report = [];
const seenAllow = new Set();
let blocks = 0;
for (const file of astro.sort()) {
  const name = fromRoot(file);
  const text = (await readFile(file, 'utf8')).replace(/^---[\s\S]*?\r?\n---/, '');
  let satisfiedBy = null;
  let any = false;
  let failure = null;
  // a self-closing <script ... /> (a JSON data block, say) has no body and no </script>; matched as an opening tag
  // it would pair with the NEXT </script> and swallow the bundled script that follows it
  for (const m of text.matchAll(/<script\b([^>]*?)\s*\/>|<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (m[1] !== undefined) continue;
    if (SKIP_SCRIPT.test(m[2])) continue;
    any = true;
    blocks++;
    const body = stripComments(m[3]);
    const { files, unresolved } = await closure(file, body);
    if (unresolved.length) { failure = `unresolved relative import ${unresolved.join(', ')}: the gate cannot follow it`; break; }
    const hit = HANDLER.test(body) ? name : (await Promise.all(files.map(async (f) => (HANDLER.test(await read(f)) ? f : null)))).find(Boolean);
    if (hit) satisfiedBy = typeof hit === 'string' && hit === name ? name : fromRoot(hit);
    else failure = `bundled <script> never binds astro:page-load or astro:after-swap (followed ${files.length} relative import(s): ${files.map(fromRoot).join(', ') || 'none'}). The client router runs it once; use document.addEventListener('astro:page-load', ...)`;
  }
  if (!any) {
    if (Object.hasOwn(allow, name)) problems.push(`${posix(relative(process.cwd(), allowFile))}: stale allow entry "${name}" (no bundled script in that file: delete the entry)`);
    continue;
  }
  if (Object.hasOwn(allow, name)) {
    seenAllow.add(name);
    if (!failure) problems.push(`${posix(relative(process.cwd(), allowFile))}: stale allow entry "${name}" (it now handles astro:page-load via ${satisfiedBy}: delete the entry)`);
    else report.push(`ALLOWED ${name}: ${allow[name]}`);
    continue;
  }
  if (failure) problems.push(`${name}: ${failure}`);
  else report.push(`ok      ${name} (page-load handled in ${satisfiedBy})`);
}
for (const key of Object.keys(allow)) {
  if (!seenAllow.has(key) && !astro.some((f) => fromRoot(f) === key)) {
    problems.push(`${posix(relative(process.cwd(), allowFile))}: stale allow entry "${key}" (file does not exist: delete the entry)`);
  }
}

for (const r of report) console.log(r);
if (problems.length) {
  console.error(`FAIL: ${problems.length} page-load problem(s)`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`ok: ${blocks} bundled script block(s) in ${astro.length} .astro file(s), each tied to astro:page-load or reviewed in the allow list`);
