// ClientRouter page-load gate: npm run check:page-load
//   node scripts/gates/check-page-load.mjs [--root <src dir>] [--allow <allow.json>]
// With the client router, a bundled <script> in an .astro file runs once, on the first page that
// carries it, and never again after a navigation swaps the page. Code that wires up the page's DOM
// must therefore rebind on `astro:page-load` (or `astro:after-swap`). This gate fails when a bundled
// script is not tied to one of them.
// For every bundled <script> block in every .astro file under the root (inline body, or src="./relative/file.ts") it
// follows RELATIVE imports (./x, ../lib/y, dynamic import() too; .ts .js .mjs .mts .tsx, or /index; './h.js' finds h.ts, as
// TypeScript's own resolution does) and requires an addEventListener('astro:page-load' | 'astro:after-swap', ...) call in a
// module that the script is actually wired to. Each module is parsed with the TypeScript compiler (a syntax tree, not a text
// search), so a mention in a comment or a string is not a call, and an imported name counts as used only when an identifier
// in value position resolves to that import: a parameter or a local of the same name shadows it, a type position (`as T`,
// `typeof` in a type) does not use it.
//   - An import that cannot be resolved fails, and so does a bundled <script src> that is not a relative path to a source file
//     (an absolute /path or a URL is not bundled by Astro and cannot be followed): the gate never silently stops following.
//   - Attribution: a handler counts only when it lives in the script itself, or in a module reached through imports whose
//     bindings the importing code USES (a named, default or namespace import referenced somewhere in its body, a re-export,
//     or a dynamic import()). A module that is imported but never used, a type-only import, and a bare side-effect import
//     (`import './x'`) do not attribute their handler to the script: the handler there belongs to that module's own job, so an
//     unrelated module that happens to bind astro:page-load cannot vouch for a script that wires the DOM at top level.
//     Residual limits, left to review (the gate reads imports and identifiers, not data flow): a module the script really uses
//     whose page-load handler serves something else still satisfies the gate; `export * from './x'` and a dynamic import()
//     inside an arrow that is never called count as used; a handler in dead code (an `if (false)` branch, a function nothing
//     calls) counts; only relative specifiers are followed (a bare package or an alias is not); a name used only through
//     `with`, `eval` or a computed lookup is invisible.
// Not checked: is:inline scripts (the router re-runs those on every swap) and define:vars scripts (Astro makes them inline),
// JSON and importmap blocks. The compiler is the repo's own `typescript` (6.x; a TypeScript 7 native build has no such API,
// and Dependabot is told to leave the major alone).
// Allow list (scripts/gates/page-load.allow.json): { "<path from root>.astro": "<why>" } for the rare
// script that is correct without a rebind, because it installs one delegated document-level
// listener once and resolves its elements when the event fires. It is a reviewed list: an entry whose
// file is gone, has no bundled script, or now does handle page-load fails as stale.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

const HANDLER_EVENTS = new Set(['astro:page-load', 'astro:after-swap']);
const CODE = ['.ts', '.tsx', '.mts', '.js', '.mjs'];
// a script tag Astro leaves alone or that carries data: nothing to follow. define:vars makes Astro treat it as is:inline.
const SKIP_SCRIPT = /is:inline|define:vars|data-astro-rerun|type\s*=\s*["'](?:application\/(?:ld\+)?json|importmap|speculationrules)["']/i;

const isString = (n) => n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
/** True when the node sits in a type position (erased at run time), so it is not a use of an import's value. */
function inTypePosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(p.parent.parent)) return false;
    if (ts.isTypeNode(p)) return true;
    if (ts.isStatement(p)) return false;
  }
  return false;
}

/**
 * What a module does: whether it calls addEventListener('astro:page-load' | 'astro:after-swap', ...), and every relative import
 * of it ({ spec, kind, used }) with whether the importing code makes use of the binding.
 */
function analyse(code, tsx = false) {
  const name = tsx ? 'module.tsx' : 'module.ts';
  const sf = ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = [];
  const bindings = new Map(); // the import clause / specifier / namespace node -> its record
  let handler = false;
  const collect = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith('.')) {
      const spec = n.moduleSpecifier.text;
      const clause = n.importClause;
      if (!clause) imports.push({ spec, kind: 'side-effect', used: false });
      else {
        const record = { spec, kind: 'import', used: false, typeOnly: clause.isTypeOnly };
        if (!record.typeOnly) {
          if (clause.name) bindings.set(clause, record);
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) bindings.set(nb, record);
          else if (nb) for (const el of nb.elements) if (!el.isTypeOnly) bindings.set(el, record);
        }
        imports.push(record);
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith('.')) {
      imports.push({ spec: n.moduleSpecifier.text, kind: 're-export', used: !n.isTypeOnly });
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword && isString(n.arguments[0]) && n.arguments[0].text.startsWith('.')) imports.push({ spec: n.arguments[0].text, kind: 'dynamic', used: true });
      const calledName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (calledName === 'addEventListener' && isString(n.arguments[0]) && HANDLER_EVENTS.has(n.arguments[0].text)) handler = true;
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  if (bindings.size) {
    // a one-file program with no libs and no module resolution: just enough for the binder to resolve each identifier to
    // the declaration it really refers to (so a parameter named like an import is not a use of the import)
    const host = {
      getSourceFile: (f) => (f === name ? sf : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile() {},
      getCurrentDirectory: () => '/',
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => f === name,
      readFile: () => undefined,
    };
    const program = ts.createProgram({ rootNames: [name], options: { noResolve: true, noLib: true, types: [], noEmit: true }, host });
    const checker = program.getTypeChecker();
    const mark = (symbol) => { for (const d of symbol?.declarations ?? []) { const rec = bindings.get(d); if (rec) rec.used = true; } };
    const use = (n) => {
      const p = n.parent;
      if (ts.isIdentifier(n) && !ts.isImportClause(p) && !ts.isImportSpecifier(p) && !ts.isNamespaceImport(p) && !inTypePosition(n)) {
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) mark(checker.getShorthandAssignmentValueSymbol(p));
        else if (ts.isExportSpecifier(p) && !p.parent.parent.moduleSpecifier) mark(checker.getExportSpecifierLocalTargetSymbol(p));
        else mark(checker.getSymbolAtLocation(n));
      }
      ts.forEachChild(n, use);
    };
    use(sf);
  }
  return { handler, imports };
}

const JS_EXT = /\.(?:m?js|jsx)$/i;
function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec);
  if (/\.(css|astro|json|svg)$/i.test(spec)) return 'skip';
  // './h.js' is how TypeScript source names the file h.ts
  const swapped = JS_EXT.test(spec) ? ['.ts', '.tsx', '.mts'].map((e) => base.replace(JS_EXT, '') + e) : [];
  for (const c of [base, ...swapped, ...CODE.map((e) => base + e), ...CODE.map((e) => join(base, 'index' + e))]) {
    if (CODE.some((e) => c.endsWith(e)) && existsSync(c)) return c;
  }
  return null;
}

const cache = new Map();
const read = async (f) => cache.get(f) ?? (cache.set(f, analyse(await readFile(f, 'utf8'), f.endsWith('.tsx'))), cache.get(f));

/** Every file the script imports (used or not), and every import that cannot be resolved. */
async function closure(entryFile, entry) {
  const files = [];
  const unresolved = [];
  const seen = new Set();
  const visit = async (from, info) => {
    for (const imp of info.imports) {
      const r = resolveImport(from, imp.spec);
      if (r === 'skip') continue;
      if (!r) { unresolved.push(`${imp.spec} (from ${fromRoot(from)})`); continue; }
      if (seen.has(r)) continue;
      seen.add(r);
      files.push(r);
      await visit(r, await read(r));
    }
  };
  await visit(entryFile, entry);
  return { files, unresolved };
}

/** The module holding the handler the script is wired to: itself, or one reached through imports that are used. */
async function attribute(entryFile, entry) {
  const seen = new Set([entryFile]);
  const visit = async (from, info) => {
    if (info.handler) return from;
    for (const imp of info.imports) {
      if (!imp.used) continue;
      const r = resolveImport(from, imp.spec);
      if (!r || r === 'skip' || seen.has(r)) continue;
      seen.add(r);
      const hit = await visit(r, await read(r));
      if (hit) return hit;
    }
    return null;
  };
  return { hit: await visit(entryFile, entry), seen };
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
    let entry;
    if (src !== null) {
      const r = /^\./.test(src) ? resolveImport(file, src) : null;
      if (!r || r === 'skip') { failure = `unresolved <script src="${src}">: the gate cannot follow it (only a relative path to a .ts/.js/.mjs source is bundled and checked; an absolute path or a URL runs once, unseen: use is:inline for a script that must re-run, or bundle it)`; break; }
      entryFile = r;
      entry = await read(r);
    } else entry = analyse(m[3]);
    const { files, unresolved } = await closure(entryFile, entry);
    if (unresolved.length) { failure = `unresolved relative import ${unresolved.join(', ')}: the gate cannot follow it`; break; }
    const { hit, seen } = await attribute(entryFile, entry);
    if (hit) satisfiedBy = hit === file ? name : fromRoot(hit);
    else {
      const unattributed = [];
      for (const f of files) if (!seen.has(f) && (await read(f)).handler) unattributed.push(fromRoot(f));
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
