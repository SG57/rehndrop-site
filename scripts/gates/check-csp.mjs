// Content Security Policy gate over the built site: npm run check:csp (needs a build: npm run build first).
//   node scripts/gates/check-csp.mjs [--dist <dir>] [--before-meta <allow.json>]
// astro.config.mjs turns on security.csp; Astro writes a <meta http-equiv="content-security-policy"> into every
// page with the hashes of the scripts and styles it knows about. This reads the built pages and fails (exit 1) on
// anything that would make that policy wrong or weaker than it claims, without needing a browser:
//   - not exactly ONE policy meta tag per page (browsers intersect two policies, a gate that read only the first would
//     certify a page whose second tag it never looked at)
//   - a policy that is parsed directive by directive against a reviewed allow-list of sources (POLICY below):
//       script-src / script-src-elem   'self' and hashes only
//       script-src-attr                'none' only (inline on* handlers stay blocked)
//       style-src / style-src-elem     'self' and hashes only
//       style-src-attr                 'none' or 'unsafe-inline': the one reviewed gap (inline style="" attributes)
//       img-src                        'self', data: and https://i.ytimg.com (justified at POLICY)
//       default-src, base-uri, form-action 'self'; object-src and frame-src 'none'
//       every other fetch directive    'none' or 'self'
//     so 'unsafe-inline', 'unsafe-eval', 'unsafe-hashes', 'strict-dynamic', a wildcard, a scheme-only source such as
//     https: or blob:, and any host source fail wherever they appear. A directive written twice (the browser keeps the
//     first, a reader may not), an unknown directive (a typo is silent) and frame-ancestors / report-uri / sandbox (ignored in a
//     meta tag, so a false assurance) fail too. A policy still needs script-src, default-src 'self', object-src 'none'
//     and base-uri.
//   - markup that works around the policy or would be a hole if it were weakened: an on*= event-handler attribute on any
//     element, a javascript: URL in any URL attribute (entity-encoded and tab-split forms included)
//   - an inline <script> whose sha256 is not in script-src (script-src-elem when present). Only application/json and
//     application/ld+json are treated as inert data blocks; ANY other type, or none, counts as executable (text/ecmascript
//     runs as JavaScript, an unknown type is one edit away from running), and so does an importmap or speculationrules
//   - an inline <style> whose sha256 is not in style-src (style-src-elem when present)
//   - an inline <script type="module">: the client router injects a data: script to wait for it, which no
//     policy short of 'data:' allows (the crawl in csp-crawl.mjs shows it as a violation)
//   - an external <script src> or stylesheet <link> that is not same-origin
//   - an inline style="" attribute on a page whose policy has no style-src-attr, or a data block holding a raw "<" (a title
//     with "</script>" would end the block and inject markup: write data blocks through src/lib/json-script.mjs)
//   - the scripts and stylesheets that sit BEFORE the policy meta in the document. A meta policy governs only what is
//     parsed after it, so those run with no policy at all. The set must equal the reviewed list in
//     scripts/gates/csp-before-meta.allow.json (the boot script and the client router today) and every entry must still
//     match something; anything else ahead of the meta, or a stale entry, fails
//   - pages whose policies differ: meta policies accumulate across client-router swaps, so a page-specific
//     hash would make the policy of the page you came from block the page you go to
// Lexical limits, left to review: the page is scanned as text by a small tokenizer (comments, script/style/title/textarea
// bodies handled), not by a browser; only http-equiv spelled content-security-policy is read; javascript: is looked for
// in the URL-carrying attributes listed in URL_ATTRS; a script injected at run time is the crawl's job (csp-crawl.mjs).
// This is the static half; scripts/gates/csp-crawl.mjs is the browser half (real violations, real behaviour).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const dist = resolve(argAfter('--dist') ?? fileURLToPath(new URL('../../dist/', import.meta.url)));
const allowFile = resolve(argAfter('--before-meta') ?? fileURLToPath(new URL('./csp-before-meta.allow.json', import.meta.url)));
const rel = (p) => relative(process.cwd(), p).split(sep).join('/');

if (!existsSync(dist)) { console.error(`FAIL: ${dist} does not exist. Run npm run build first.`); process.exit(1); }
const beforeMetaAllow = existsSync(allowFile) ? JSON.parse(await readFile(allowFile, 'utf8')) : [];

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('_') || e.name === '_astro') yield* walk(p); }
    else if (e.name.endsWith('.html')) yield p;
  }
}

// ---- policy: the reviewed source allow-list, per directive --------------------------------------------------------
const SELF = "'self'";
const NONE = "'none'";
const HASH = /^'sha(?:256|384|512)-[A-Za-z0-9+/_-]+={0,2}'$/i;
// A directive maps to the sources it may carry (compared case-insensitively) and whether hashes are allowed.
//  img-src data: the grain and the glyph masks are data: SVGs inside the stylesheets (global.css, structure.css), which
//          the browser fetches under img-src. A data: image cannot execute script.
//  img-src https://i.ytimg.com: the YouTube thumbnails, the one thing the site loads from another origin.
//  style-src-attr 'unsafe-inline': markup carries style="" attributes (per-track accent colours); Astro 6.4 cannot hash
//          attributes. Only the attribute channel is open, never <style> elements or scripts. See README, "Security".
const POLICY = {
  'default-src': { allow: [SELF] },
  'script-src': { allow: [SELF], hashes: true },
  'script-src-elem': { allow: [SELF], hashes: true },
  'script-src-attr': { allow: [NONE] },
  'style-src': { allow: [SELF], hashes: true },
  'style-src-elem': { allow: [SELF], hashes: true },
  'style-src-attr': { allow: [NONE, "'unsafe-inline'"] },
  'img-src': { allow: [SELF, 'data:', 'https://i.ytimg.com'] },
  'object-src': { allow: [NONE] },
  'frame-src': { allow: [NONE] },
  'child-src': { allow: [NONE, SELF] },
  'worker-src': { allow: [NONE, SELF] },
  'connect-src': { allow: [NONE, SELF] },
  'font-src': { allow: [NONE, SELF] },
  'media-src': { allow: [NONE, SELF] },
  'manifest-src': { allow: [NONE, SELF] },
  'prefetch-src': { allow: [NONE, SELF] },
  'base-uri': { allow: [NONE, SELF] },
  'form-action': { allow: [NONE, SELF] },
};
const FLAGS = new Set(['upgrade-insecure-requests', 'block-all-mixed-content']);
const META_IGNORED = new Set(['frame-ancestors', 'report-uri', 'report-to', 'sandbox']);
const WEAK = /^(?:'unsafe-[a-z-]+'|'strict-dynamic'|'wasm-unsafe-eval'|\*|[a-z][a-z0-9+.-]*:|\*\.[^\s]*)$/i;

// ---- a small HTML tokenizer (enough for built output) -----------------------------------------------------------------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
  .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const RAW = new Set(['script', 'style', 'title', 'textarea']);
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Every tag in document order: { name, attrs: [[name, value]], body?, index }. First occurrence of an attribute wins. */
function tokenize(html) {
  const nodes = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; continue; }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) { i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const attrs = [];
    for (const a of m[2].matchAll(ATTR)) if (!attrs.some(([n]) => n === a[1].toLowerCase())) attrs.push([a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? '')]);
    const node = { name, attrs, index: lt };
    i = lt + m[0].length;
    if (RAW.has(name) && !m[0].endsWith('/>')) {
      const close = new RegExp(`</${name}[\\s/>]`, 'ig');
      close.lastIndex = i;
      const c = close.exec(html);
      node.body = html.slice(i, c ? c.index : html.length);
      i = c ? c.index + c[0].length : html.length;
    }
    nodes.push(node);
  }
  return nodes;
}
const get = (node, name) => node.attrs.find(([n]) => n === name)?.[1] ?? null;
const DATA_TYPES = new Set(['application/json', 'application/ld+json']);
const typeOf = (node) => (get(node, 'type') ?? '').split(';')[0].trim().toLowerCase();
const isDataBlock = (node) => DATA_TYPES.has(typeOf(node));
const sha256 = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const hashOnly = (text) => sha256(text).slice(1, -1);
const sameOrigin = (url) => !/^(?:https?:)?\/\//i.test(url.trim()) && !/^(?:data|blob|javascript):/i.test(url.trim());
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster', 'xlink:href', 'ping', 'background', 'cite', 'longdesc', 'codebase', 'manifest', 'srcdoc']);
const isJsUrl = (v) => /^javascript:/i.test(v.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, ''));

const problems = [];
const fail = (file, msg) => problems.push(`${rel(file)}: ${msg}`);
const policies = new Map();
const usedBeforeMeta = new Set();
const unreviewedBefore = new Map(); // label -> { n pages, first page }
const matchesEntry = (e, item) => e.kind === item.kind && (e.sha256 !== undefined ? e.sha256 === item.sha256 : new RegExp(e.match).test(item.value));
let pages = 0;
for await (const file of walk(dist)) {
  pages++;
  const html = await readFile(file, 'utf8');
  const nodes = tokenize(html);
  const metas = nodes.filter((n) => n.name === 'meta' && (get(n, 'http-equiv') ?? '').trim().toLowerCase() === 'content-security-policy');
  if (!metas.length) { fail(file, 'no <meta http-equiv="content-security-policy"> tag'); continue; }
  if (metas.length > 1) fail(file, `${metas.length} <meta http-equiv="content-security-policy"> tags: the browser enforces the intersection, so the gate must see exactly one policy per page`);
  const meta = metas[0];
  const policy = get(meta, 'content') ?? '';
  policies.set(file, policy);

  // ---- the policy, directive by directive
  const dir = new Map();
  for (const raw of policy.split(';')) {
    const text = raw.trim();
    if (!text) continue;
    const [name, ...vals] = text.split(/\s+/);
    const key = name.toLowerCase();
    if (dir.has(key)) { fail(file, `policy writes ${key} twice (the browser keeps the first and ignores the rest, so a reader of either may be misled)`); continue; }
    dir.set(key, vals);
  }
  for (const [name, vals] of dir) {
    if (META_IGNORED.has(name)) { fail(file, `policy carries ${name}, which a meta tag ignores: it protects nothing here (see README, "Security")`); continue; }
    if (FLAGS.has(name)) continue;
    const rule = POLICY[name];
    if (!rule) { fail(file, `policy carries an unknown directive "${name}" (a typo is silent in a browser; add it to POLICY in check-csp.mjs only with a reason)`); continue; }
    if (!vals.length) { fail(file, `policy ${name} has no source list (it would fall back to nothing useful)`); continue; }
    for (const v of vals) {
      if (rule.allow.includes(v.toLowerCase()) || (rule.hashes && HASH.test(v))) continue;
      fail(file, WEAK.test(v)
        ? `${name} carries a weak source: ${v}`
        : `${name} allows ${v}, which is not on the reviewed list (${rule.allow.join(' ')}${rule.hashes ? ' and hashes' : ''})`);
    }
  }
  const val = (name) => dir.get(name);
  if (!dir.has('script-src')) fail(file, 'policy has no script-src');
  if (val('default-src')?.join(' ') !== SELF) fail(file, `policy default-src is "${val('default-src')?.join(' ') ?? 'missing'}", not 'self'`);
  if (val('object-src')?.join(' ') !== NONE) fail(file, `policy object-src is "${val('object-src')?.join(' ') ?? 'missing'}", not 'none'`);
  if (!dir.has('base-uri')) fail(file, 'policy has no base-uri');
  // the directive the browser really consults for an inline script / style element
  const scriptHashes = new Set((val('script-src-elem') ?? val('script-src') ?? []).filter((v) => HASH.test(v)));
  const styleHashes = new Set((val('style-src-elem') ?? val('style-src') ?? []).filter((v) => HASH.test(v)));

  // ---- markup
  const before = [];
  for (const node of nodes) {
    const isBefore = node.index < meta.index;
    for (const [name, value] of node.attrs) {
      if (/^on[a-z]+$/.test(name)) fail(file, `<${node.name}> carries an inline event handler ${name}="${value.slice(0, 40)}" (script-src-attr blocks it today; a policy edit would let it run: use addEventListener in a bundled script)`);
      if (URL_ATTRS.has(name) && isJsUrl(value)) fail(file, `<${node.name} ${name}="${value.slice(0, 40)}"> is a javascript: URL`);
    }
    if (node.name === 'script') {
      const src = get(node, 'src');
      const type = typeOf(node);
      const body = node.body ?? '';
      if (isDataBlock(node)) {
        if (src === null && body.includes('<')) fail(file, `data block <script type="${type}"${get(node, 'id') ? ` id="${get(node, 'id')}"` : ''}> holds a raw "<" (a "</script>" in it would inject markup; use jsonScript from src/lib/json-script.mjs)`);
        continue;
      }
      if (src !== null) {
        if (!sameOrigin(src)) fail(file, `external <script src="${src.slice(0, 60)}"> (not same-origin)`);
        if (isBefore) before.push({ kind: 'script', value: src, label: `<script src="${src.slice(0, 70)}">` });
        continue;
      }
      if (type === 'module') fail(file, 'inline <script type="module">: the client router would inject a data: script for it; keep module scripts external (vite.build.assetsInlineLimit)');
      if (!scriptHashes.has(sha256(body))) fail(file, `inline <script${type ? ` type="${type}"` : ''}> (${body.length} bytes, starts "${body.trim().slice(0, 40).replace(/\s+/g, ' ')}") has no hash in script-src`);
      if (isBefore) before.push({ kind: 'inline-script', sha256: hashOnly(body), label: `inline <script> (${body.length} bytes, starts "${body.trim().slice(0, 40).replace(/\s+/g, ' ')}", ${hashOnly(body)})` });
    } else if (node.name === 'style') {
      const body = node.body ?? '';
      if (!styleHashes.has(sha256(body))) fail(file, `inline <style> (${body.length} bytes, starts "${body.trim().slice(0, 40)}") has no hash in style-src`);
      if (isBefore) before.push({ kind: 'inline-style', sha256: hashOnly(body), label: `inline <style> (${body.length} bytes)` });
    } else if (node.name === 'link' && (get(node, 'rel') ?? '').toLowerCase().split(/\s+/).includes('stylesheet')) {
      const href = get(node, 'href') ?? '';
      if (!sameOrigin(href)) fail(file, `external stylesheet <link href="${href.slice(0, 60)}"> (not same-origin)`);
      if (isBefore) before.push({ kind: 'stylesheet', value: href, label: `<link rel="stylesheet" href="${href.slice(0, 70)}">` });
    }
  }
  if (nodes.some((n) => n.name !== 'script' && n.name !== 'style' && get(n, 'style') !== null) && !dir.has('style-src-attr') && !(val('style-src') ?? []).includes("'unsafe-inline'")) {
    fail(file, 'inline style="" attributes on the page, but the policy has no style-src-attr: the browser blocks every one');
  }

  // ---- what runs before the policy exists
  for (const item of before) {
    const entry = beforeMetaAllow.find((e) => matchesEntry(e, item));
    if (entry) usedBeforeMeta.add(entry);
    else {
      const seen = unreviewedBefore.get(item.label) ?? { n: 0, first: file };
      seen.n++;
      unreviewedBefore.set(item.label, seen);
    }
  }
}

if (!pages) { console.error(`FAIL: no .html files under ${rel(dist)}: a gate that finds nothing must not pass`); process.exit(1); }
for (const [label, { n, first }] of unreviewedBefore) {
  problems.push(`${rel(first)}${n > 1 ? ` (and ${n - 1} more page(s))` : ''}: ${label} sits before the policy meta, so it runs with no policy, and it is not on the reviewed list (${rel(allowFile)}): move it behind the meta, or review it onto the list with a reason`);
}
for (const e of beforeMetaAllow) {
  if (!usedBeforeMeta.has(e)) problems.push(`${rel(allowFile)}: stale entry (${e.kind} ${e.sha256 ?? e.match}): nothing before the policy meta matches it any more, delete it`);
}
const distinct = new Set(policies.values());
if (distinct.size > 1) {
  const [first] = policies.keys();
  const odd = [...policies].find(([, p]) => p !== policies.get(first));
  problems.push(`pages carry ${distinct.size} different policies (e.g. ${rel(first)} and ${rel(odd[0])}): meta policies accumulate across client-router swaps, so every page must carry the same one`);
}

for (const p of problems) console.log(`FAIL ${p}`);
if (problems.some((p) => /inline <script|external <script|external stylesheet/.test(p))) {
  console.log('  platform-currency: some pack guides show inline scripts, inline module scripts or CDN lines; keep the code in a bundled file, never loosen this policy (repo rules still win)');
}
console.log(problems.length
  ? `FAIL: ${problems.length} CSP problem(s) in ${pages} page(s)`
  : `ok: ${pages} page(s), one policy tag and one policy on all of them, every directive on the reviewed source list, every inline script and style hashed, no event-handler attribute or javascript: URL, ${beforeMetaAllow.length} reviewed script/stylesheet(s) ahead of the meta and nothing else`);
process.exit(problems.length ? 1 : 0);
