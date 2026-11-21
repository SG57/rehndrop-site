// Type-scale gate: npm run check:type-units
//   node scripts/gates/check-type-units.mjs [--root <src dir>]
// Every font size under the root must scale with the visitor's browser font size, so it is written in rem (or em, %, vw
// inside a clamp, a keyword), never in a fixed length. Exit 1 on any of:
//   - a px length anywhere in a font-size (or font shorthand), calc(), min(), max() and clamp() included: the ONE px allowed
//     is the documented floor `max(1rem, 16px)` (the search field: iOS zooms into a field under 16px). A px term that
//     sits beside a rem term, calc(10px + .001rem) or min(2rem, 20px), is still a px size and fails
//   - an absolute unit (pt cm mm in pc Q): a physical length does not follow the reader's setting either
//   - font-size: var(--x) where --x (or a custom property it points at through var()) is declared with a px or absolute
//     length anywhere in the sources scanned
//   - the same sizes written outside a stylesheet: font-size / font declarations in .astro and script sources (an inline
//     style="" attribute, style={`...`}, a cssText string), el.style.fontSize = ..., el.style['font-size'] = ...,
//     el.style.font = ..., { fontSize: ... }, a quoted key ({ 'font-size': ... }) and setProperty('font-size' | 'font', ...).
//     A value that is built at run time is read as text: a literal px (`12px`, `${n}px`, `n + 'px'`) fails
//   - a custom property that reaches a font size from script or a registration: setProperty('--x', '12px'), style['--x'] = ...,
//     a quoted '--x' key, or @property --x { initial-value: 12px }, with font-size: var(--x) anywhere
// Why a gate: the type scale was converted from px to rem once, proven pixel-identical at the default 16px root; this keeps
// the next edit from putting a fixed size back, which would stop that text following the reader's setting.
// vw inside a clamp() middle stays legal: it is the documented fluid-type design (clamp(1.25rem, 5.6vw, 2.5rem) keeps rem
// bounds). Layout lengths (padding, height, calc() offsets) and media queries stay px on purpose and are not read here.
// Known limits, left to review: only .css, .astro, .html, .ts, .tsx, .js and .mjs under the root are read: a size in any other
// file type (an .svg with font-size="12px" or a style attribute, .md, .mdx, .json fed to a style) is not seen; the non-stylesheet scan is lexical (a size assembled from parts in separate statements, or
// a style object spread in from elsewhere, is not followed); a custom property set only at run time through a variable is
// not seen (a value taken from script variables or from a fetched file is the same); line comments in script sources are
// stripped string-aware, and a regex literal holding a quote can still confuse it; a px custom property is flagged when any use reaches font-size, even if a media query would redefine it in rem;
// a value coming from computed style or a framework prop is invisible. A stylesheet set with no font-size at all also fails,
// so the gate cannot pass blind.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import stylelint from 'stylelint';
import { platformGuide } from './platform-guide.mjs';

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
const other = [];
for await (const f of walk(root)) {
  if (f.endsWith('.css')) css.push(f);
  else if (/\.(astro|ts|tsx|js|mjs|html)$/.test(f) && !f.endsWith('.d.ts')) other.push(f);
}
if (!css.length) { console.error(`FAIL: no .css files under ${rel(root)}`); process.exit(1); }
css.sort(); other.sort();

// ---- the value check ------------------------------------------------------------------------------------------------
const FLOOR = /max\(\s*1rem\s*,\s*16px\s*\)/gi;
const PX = /\d(?:px)(?![a-z0-9-])/i;
const ABS = /\d(pt|cm|mm|in|pc|q)(?![a-z0-9-])/i;
// a value assembled at run time: `${n}px`, 'px' appended to something
const DYNAMIC_PX = /\}\s*px(?![a-z0-9-])|['"`]\s*px(?![a-z0-9-])/i;
const VAR = /var\(\s*(--[\w-]+)/gi;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
// `//` to end of line, but not inside a '...', "..." or `...` string (a URL or a "// x" in a string must not hide the rest
// of the line) and not after a colon (http://). A ' or " string ends at the newline: JS strings do not span lines.
function stripLineComments(s) {
  let out = '';
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === '\\') { out += s[i + 1] ?? ''; i++; } else if (c === q || (c === '\n' && q !== '`')) q = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '/' && s[i + 1] === '/' && s[i - 1] !== ':') { while (i < s.length && s[i] !== '\n') i++; if (i < s.length) out += '\n'; continue; }
    out += c;
  }
  return out;
}

/** Why a font-size value is not allowed, or null. `tainted` maps a custom property to where it is declared in px. */
function problem(value, tainted, dynamic = false) {
  const v = value.replace(/!important/i, '').replace(FLOOR, ' ').trim();
  const abs = v.match(ABS);
  if (abs) return `font size "${value.trim()}" uses an absolute unit (${abs[1].toLowerCase()}): write it in rem (px / 16) so the reader's browser font size applies`;
  if (PX.test(v) || (dynamic && DYNAMIC_PX.test(v))) return `font size "${value.trim()}" is in px: write it in rem (px / 16) so the reader's browser font size applies (a px term inside calc(), min(), max() or clamp() counts; only the floor max(1rem, 16px) is allowed)`;
  for (const m of v.matchAll(VAR)) {
    if (tainted.has(m[1])) return `font size "${value.trim()}" comes from ${m[1]}, which is declared in px (${tainted.get(m[1])}): declare it in rem so the reader's browser font size applies`;
  }
  return null;
}

// ---- custom properties declared in a fixed length (transitively through var()) --------------------------------------
const sources = new Map();
for (const f of [...css, ...other]) {
  let text = stripComments(await readFile(f, 'utf8'));
  if (!f.endsWith('.css') && !f.endsWith('.astro') && !f.endsWith('.html')) text = stripLineComments(text);
  sources.set(f, text);
}
const decls = [];
for (const [f, text] of sources) {
  const at = (index) => `${rel(f)}:${text.slice(0, index).split('\n').length}`;
  for (const m of text.matchAll(/(--[\w-]+)\s*:\s*((?:\$\{[^}]*\}|[^;"'`<>{}])+)/g)) decls.push({ name: m[1], value: m[2], where: at(m.index) });
  // a custom property set from script (style.setProperty('--x', ...), style['--x'] = ...), its value read as text like the sizes below
  for (const m of text.matchAll(/setProperty\(\s*['"`](--[\w-]+)['"`]\s*,\s*([^)\n]+)\)/g)) decls.push({ name: m[1], value: m[2], where: at(m.index), dynamic: true });
  for (const m of text.matchAll(/\[\s*['"`](--[\w-]+)['"`]\s*\]\s*=\s*([^;\n]+)/g)) decls.push({ name: m[1], value: m[2], where: at(m.index), dynamic: true });
  for (const m of text.matchAll(/['"`](--[\w-]+)['"`]\s*:\s*([^,;\n}]+)/g)) decls.push({ name: m[1], value: m[2], where: at(m.index), dynamic: true });
  // @property --x { initial-value: 12px }: the registered default feeds every use of --x that sets nothing itself
  for (const m of text.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
    const initial = m[2].match(/initial-value\s*:\s*([^;}]+)/i);
    if (initial) decls.push({ name: m[1], value: initial[1], where: at(m.index) });
  }
}
const tainted = new Map();
for (let changed = true; changed;) {
  changed = false;
  for (const d of decls) {
    if (tainted.has(d.name)) continue;
    const v = d.value.replace(FLOOR, ' ');
    if (PX.test(v) || ABS.test(v) || (d.dynamic && DYNAMIC_PX.test(v)) || [...v.matchAll(VAR)].some((m) => tainted.has(m[1]))) { tainted.set(d.name, `${d.name}: ${d.value.trim().slice(0, 40)} at ${d.where}`); changed = true; }
  }
}

// ---- stylesheets: a stylelint rule over every font-size and font declaration -----------------------------------------
const ruleName = 'local/font-size-units';
const plugin = stylelint.createPlugin(ruleName, (_primary, opts) => (cssRoot, result) => {
  cssRoot.walkDecls((d) => {
    const prop = d.prop.toLowerCase();
    if (prop !== 'font-size' && prop !== 'font') return;
    const why = problem(d.value, opts.tainted);
    if (why) stylelint.utils.report({ ruleName, result, node: d, message: why });
  });
});
const config = { plugins: [plugin], rules: { [ruleName]: [true, { tainted }] } };

const problems = [];
let declarations = 0;
for (const file of css) {
  const code = await readFile(file, 'utf8');
  declarations += (code.replace(/\/\*[\s\S]*?\*\//g, '').match(/(^|[;{\s])font-size\s*:/g) ?? []).length;
  const out = await stylelint.lint({ code, codeFilename: file, config });
  for (const w of out.results.flatMap((r) => [...r.warnings, ...r.parseErrors])) problems.push(`${rel(file)}:${w.line}:${w.column} ${w.text.replace(new RegExp(`\\s*\\(${ruleName}\\)$`), '')}`);
}
if (!declarations) problems.push(`${rel(root)}: no font-size declaration found in ${css.length} stylesheet(s): the gate would pass blind`);

// ---- everything else: .astro (inline style attributes, <style> text) and script sources ----------------------------
const VALUE = String.raw`((?:\$\{[^}]*\}|[^;"'\x60<>{}])+)`;
const SCANS = [
  [new RegExp(String.raw`(?<![-\w])font-size\s*:\s*${VALUE}`, 'gi'), 1],
  [new RegExp(String.raw`(?<![-\w])font\s*:\s*${VALUE}`, 'gi'), 1],
  [/\bfontSize\s*[:=]\s*([^;\n,}]+)/g, 1],
  [/setProperty\(\s*['"`]font(?:-size)?['"`]\s*,\s*([^)\n]+)\)/gi, 1],
  // el.style['font-size'] = ..., el.style['fontSize'] = ..., el.style['font'] = ...
  [/style\s*\[\s*['"`]font(?:-size|Size)?['"`]\s*\]\s*=\s*([^;\n]+)/gi, 1],
  // { 'font-size': '12px' } and { 'fontSize': ... }: a quoted key in an object style
  [/['"`]font(?:-size|Size)?['"`]\s*:\s*([^,;\n}]+)/gi, 1],
  // el.style.font = '12px serif' (the shorthand)
  [/\.style\.font\s*=\s*([^;\n]+)/g, 1],
];
let scanned = 0;
for (const file of other) {
  const text = sources.get(file);
  scanned++;
  for (const [re, group] of SCANS) {
    for (const m of text.matchAll(re)) {
      declarations++;
      const why = problem(m[group], tainted, true);
      if (why) problems.push(`${rel(file)}:${text.slice(0, m.index).split('\n').length} ${why}`);
    }
  }
}

if (problems.length) {
  console.error(`FAIL: ${problems.length} type-scale problem(s) in ${css.length} stylesheet(s) and ${scanned} other source(s)`);
  for (const p of problems) console.error(`  ${p}`);
  if (problems.some((p) => /is in px|absolute unit|declared in px/.test(p))) console.error(`  ${platformGuide('respect-os-text-scale', 'it asks for no root font-size; its meta opt-in is limited availability, look the support up first')}`);
  process.exit(1);
}
console.log(`ok: ${declarations} font-size declaration(s) in ${css.length} stylesheet(s) and ${scanned} other source(s), none in px alone, an absolute unit or a px custom property (${tainted.size} px custom propert${tainted.size === 1 ? 'y' : 'ies'} seen, none reaches a font size)`);
