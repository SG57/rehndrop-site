// ClientRouter page-load gate: npm run check:page-load
//   node scripts/gates/check-page-load.mjs [--root <src dir>] [--allow <allow.json>]
// With the client router, a bundled <script> in an .astro file runs once, on the first page that
// carries it, and never again after a navigation swaps the page. Code that wires up the page's DOM
// must therefore rebind on `astro:page-load` (or `astro:after-swap`). This gate fails when a bundled
// script is not tied to one of them.
// For every bundled <script> block in every .astro file under the root (inline body, or src="./relative/file.ts") it
// follows RELATIVE imports (./x, ../lib/y, dynamic import() too; .ts .js .mjs .tsx, or /index) and requires an
// addEventListener('astro:page-load' | 'astro:after-swap', ...) call in a module that the script is actually wired to.
// Comments are stripped first, so a mention in prose does not count.
//   - An import that cannot be resolved fails, and so does a bundled <script src> that is not a relative path to a source file
//     (an absolute /path or a URL is not bundled by Astro and cannot be followed): the gate never silently stops following.
//   - Attribution: a handler counts only when it lives in the script itself, or in a module reached through imports whose
//     bindings the importing code USES (a named, default or namespace import referenced somewhere in its body, a re-export,
//     or a dynamic import()). A module that is imported but never used, a type-only import, and a bare side-effect import
//     (`import './x'`) do not attribute their handler to the script: the handler there belongs to that module's own job, so an
//     unrelated module that happens to bind astro:page-load cannot vouch for a script that wires the DOM at top level.
//     Residual limit, left to review: a module the script really uses whose page-load handler serves something else still
//     satisfies the gate (the gate reads imports and identifiers, not data flow).
// Not checked: is:inline scripts (the router re-runs those on every swap), JSON and importmap blocks.
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
const CODE = ['.ts', '.tsx', '.js', '.mjs'];
// a script tag Astro leaves alone or that carries data: nothing to follow
const SKIP_SCRIPT = /is:inline|data-astro-rerun|type\s*=\s*["'](?:application\/(?:ld\+)?json|importmap|speculationrules)["']/i;

// every relative import of a module, with whether the importing code makes use of it
const STATIC_IMPORT = /(?:^|[\s;])import\s+(type\s+)?([^'"`;]*?)\s*from\s*(['"`])(\.[^'"`]+)\3/g;
const SIDE_EFFECT_IMPORT = /(?:^|[\s;])import\s*(['"`])(\.[^'"`]+)\1/g;
const RE_EXPORT = /(?:^|[\s;])export\s[^'"`;]*?\sfrom\s*(['"`])(\.[^'"`]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\(\s*(['"`])(\.[^'"`]+)\1\s*\)/g;

/** Local names a static import clause introduces: `d`, `{ a, b as c, type T }`, `* as ns`, `d, { a }`. */
function clauseLocals(clause) {
  const names = [];
  const braces = clause.match(/\{([^}]*)\}/);
  const rest = clause.replace(/\{[^}]*\}/, ',');
  if (braces) {
    for (const part of braces[1].split(',')) {
      const p = part.trim();
      if (!p || /^type\s/.test(p)) continue;
      names.push(p.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const part of rest.split(',')) {
    const p = part.trim();
    if (!p) continue;
    names.push(p.replace(/^\*\s*as\s+/, '').trim());
  }
  return names.filter((n) => /^[\w$]+$/.test(n));
}

function importsOf(code) {
  const out = [];
  let rest = code;
  for (const m of code.matchAll(STATIC_IMPORT)) {
    out.push({ spec: m[4], clause: m[2], typeOnly: !!m[1], kind: 'import' });
    rest = rest.replace(m[0], ' '.repeat(m[0].length));
  }
  for (const m of code.matchAll(SIDE_EFFECT_IMPORT)) {
    out.push({ spec: m[2], used: false, kind: 'side-effect' });
    rest = rest.replace(m[0], ' '.repeat(m[0].length));
  }
  for (const m of code.matchAll(RE_EXPORT)) out.push({ spec: m[2], used: true, kind: 're-export' });
  for (const m of code.matchAll(DYNAMIC_IMPORT)) out.push({ spec: m[2], used: true, kind: 'dynamic' });
  for (const imp of out) {
    if (imp.kind !== 'import') continue;
    imp.used = !imp.typeOnly && clauseLocals(imp.clause).some((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`).test(rest));
  }
  return out;
}

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

/** Every file the script imports (used or not), and every import that cannot be resolved. */
async function closure(entryFile, body) {
  const files = [];
  const unresolved = [];
  const seen = new Set();
  const visit = async (from, code) => {
    for (const imp of importsOf(code)) {
      const r = resolveImport(from, imp.spec);
      if (r === 'skip') continue;
      if (!r) { unresolved.push(`${imp.spec} (from ${fromRoot(from)})`); continue; }
      if (seen.has(r)) continue;
      seen.add(r);
      files.push(r);
      await visit(r, await read(r));
    }
  };
  await visit(entryFile, body);
  return { files, unresolved };
}

/** The module holding the handler the script is wired to: itself, or one reached through imports that are used. */
async function attribute(entryFile, entryCode) {
  const seen = new Set([entryFile]);
  const visit = async (from, code) => {
    if (HANDLER.test(code)) return from;
    for (const imp of importsOf(code)) {
      if (!imp.used) continue;
      const r = resolveImport(from, imp.spec);
      if (!r || r === 'skip' || seen.has(r)) continue;
      seen.add(r);
      const hit = await visit(r, await read(r));
      if (hit) return hit;
    }
    return null;
  };
  return { hit: await visit(entryFile, entryCode), seen };
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
const srcOf = (attrs) => (attrs.match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || []).slice(1).find((v) => v !== undefined) ?? null;
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
    // a bundled <script src="./x.ts"> is the module x.ts; anything else cannot be followed
    const src = srcOf(m[2]);
    let entryFile = file;
    let body = stripComments(m[3]);
    if (src !== null) {
      const r = /^\./.test(src) ? resolveImport(file, src) : null;
      if (!r || r === 'skip') { failure = `unresolved <script src="${src}">: the gate cannot follow it (only a relative path to a .ts/.js/.mjs source is bundled and checked; an absolute path or a URL runs once, unseen: use is:inline for a script that must re-run, or bundle it)`; break; }
      entryFile = r;
      body = await read(r);
    }
    const { files, unresolved } = await closure(entryFile, body);
    if (unresolved.length) { failure = `unresolved relative import ${unresolved.join(', ')}: the gate cannot follow it`; break; }
    const { hit, seen } = await attribute(entryFile, body);
    if (hit) satisfiedBy = hit === file ? name : fromRoot(hit);
    else {
      const unattributed = [];
      for (const f of files) if (!seen.has(f) && HANDLER.test(await read(f))) unattributed.push(fromRoot(f));
      failure = `bundled <script${src !== null ? ` src="${src}"` : ''}> never binds astro:page-load or astro:after-swap (followed ${files.length} relative import(s): ${files.map(fromRoot).join(', ') || 'none'}). The client router runs it once; use document.addEventListener('astro:page-load', ...)`
        + (unattributed.length ? `. ${unattributed.join(', ')} binds it, but the script never uses anything from there (an unused, type-only or bare side-effect import does not vouch for the script: call an export of that module)` : '');
    }
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
  if (problems.some((p) => p.includes('never binds astro:page-load'))) console.error('  platform-currency: pack guides that show DOMContentLoaded do not apply here (repo rules still win)');
  process.exit(1);
}
console.log(`ok: ${blocks} bundled script block(s) in ${astro.length} .astro file(s), each tied to astro:page-load or reviewed in the allow list`);
