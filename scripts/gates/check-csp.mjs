// Content Security Policy gate over the built site: npm run check:csp (needs a build: npm run build first).
//   node scripts/gates/check-csp.mjs [--dist <dir>]
// astro.config.mjs turns on security.csp; Astro writes a <meta http-equiv="content-security-policy"> into every
// page with the hashes of the scripts and styles it knows about. This reads the built pages and fails (exit 1) on
// anything that would make that policy wrong or weaker than it claims, without needing a browser:
//   - a page with no policy meta tag, or a policy without script-src, default-src 'self', object-src 'none'
//     and base-uri
//   - 'unsafe-inline', 'unsafe-eval', data:, blob:, a scheme source or a wildcard in script-src or
//     style-src (style-src-attr 'unsafe-inline' is the one reviewed gap: inline style="" attributes)
//   - an inline executable <script> (no type, module, text/javascript, importmap, speculationrules) whose
//     sha256 is not in script-src, or an inline <style> whose sha256 is not in style-src
//   - an inline <script type="module">: the client router injects a data: script to wait for it, which no
//     policy short of 'data:' allows (the crawl in csp-crawl.mjs shows it as a violation)
//   - an external <script src> or stylesheet <link> that is not same-origin
//   - an inline style="" attribute on a page whose policy has no style-src-attr (the browser blocks them all), or a
//     data block (application/json, ld+json) holding a raw "<" (a title with "</script>" would end the block and
//     inject markup: write data blocks through src/lib/json-script.mjs)
//   - pages whose policies differ: meta policies accumulate across client-router swaps, so a page-specific
//     hash would make the policy of the page you came from block the page you go to
// Data blocks are not executed, so their content is only checked for a raw "<".
// This is the static half; scripts/gates/csp-crawl.mjs is the browser half (real violations, real behaviour).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const dist = resolve(argAfter('--dist') ?? fileURLToPath(new URL('../../dist/', import.meta.url)));
const rel = (p) => relative(process.cwd(), p).split(sep).join('/');

if (!existsSync(dist)) { console.error(`FAIL: ${dist} does not exist. Run npm run build first.`); process.exit(1); }

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('_') || e.name === '_astro') yield* walk(p); }
    else if (e.name.endsWith('.html')) yield p;
  }
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const attr = (attrs, name) => (attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(2).find((v) => v !== undefined) ?? null;
const EXECUTABLE = new Set(['', 'module', 'text/javascript', 'application/javascript', 'importmap', 'speculationrules']);
const WEAK = /'unsafe-inline'|'unsafe-eval'|(^|\s)data:|(^|\s)blob:|(^|\s)https?:(\s|$)|(^|\s)\*(\s|$)/;
const problems = [];
const fail = (file, msg) => problems.push(`${rel(file)}: ${msg}`);

const policies = new Map();
let pages = 0;
for await (const file of walk(dist)) {
  pages++;
  const html = await readFile(file, 'utf8');
  const meta = html.match(/<meta\s+http-equiv="content-security-policy"\s+content="([^"]*)"/i);
  if (!meta) { fail(file, 'no <meta http-equiv="content-security-policy"> tag'); continue; }
  const policy = meta[1].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  policies.set(file, policy);
  const dir = new Map(policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...vals] = d.split(/\s+/); return [name.toLowerCase(), vals.join(' ')]; }));
  const scriptSrc = dir.get('script-src');
  const styleSrc = dir.get('style-src');
  if (scriptSrc === undefined) fail(file, 'policy has no script-src');
  if (dir.get('default-src') !== "'self'") fail(file, `policy default-src is "${dir.get('default-src') ?? 'missing'}", not 'self'`);
  if (dir.get('object-src') !== "'none'") fail(file, `policy object-src is "${dir.get('object-src') ?? 'missing'}", not 'none'`);
  if (!dir.has('base-uri')) fail(file, 'policy has no base-uri');
  for (const [name, val] of [['script-src', scriptSrc], ['style-src', styleSrc]]) {
    if (val !== undefined && WEAK.test(val)) fail(file, `${name} carries a weak source: ${val.match(WEAK)[0].trim()}`);
  }

  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, body] = m;
    const src = attr(attrs, 'src');
    const type = (attr(attrs, 'type') ?? '').toLowerCase();
    if (src === null && /json/.test(type) && body.includes('<')) fail(file, `data block <script type="${type}"${attr(attrs, 'id') ? ` id="${attr(attrs, 'id')}"` : ''}> holds a raw "<" (a "</script>" in it would inject markup; use jsonScript from src/lib/json-script.mjs)`);
    if (src !== null) {
      if (/^(https?:)?\/\//i.test(src) || /^(data|blob):/i.test(src)) fail(file, `external <script src="${src.slice(0, 60)}"> (not same-origin)`);
      continue;
    }
    if (!EXECUTABLE.has(type)) continue;
    if (type === 'module') fail(file, 'inline <script type="module">: the client router would inject a data: script for it; keep module scripts external (vite.build.assetsInlineLimit)');
    if (scriptSrc !== undefined && !scriptSrc.includes(sha256(body))) fail(file, `inline <script> (${body.length} bytes, starts "${body.trim().slice(0, 40).replace(/\s+/g, ' ')}") has no hash in script-src`);
  }
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '');
  if (/\sstyle\s*=\s*["']/i.test(markup) && !dir.has('style-src-attr') && !/'unsafe-inline'/.test(styleSrc ?? '')) fail(file, 'inline style="" attributes on the page, but the policy has no style-src-attr: the browser blocks every one');
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (styleSrc !== undefined && !styleSrc.includes(sha256(m[1]))) fail(file, `inline <style> (${m[1].length} bytes, starts "${m[1].trim().slice(0, 40)}") has no hash in style-src`);
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (/rel\s*=\s*"?stylesheet/i.test(m[1])) {
      const href = attr(m[1], 'href') ?? '';
      if (/^(https?:)?\/\//i.test(href)) fail(file, `external stylesheet <link href="${href.slice(0, 60)}"> (not same-origin)`);
    }
  }
}

if (!pages) { console.error(`FAIL: no .html files under ${rel(dist)}: a gate that finds nothing must not pass`); process.exit(1); }
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
  : `ok: ${pages} page(s), one policy on all of them, every inline script and style hashed, no unsafe-inline in script-src or style-src, no inline module script`);
process.exit(problems.length ? 1 : 0);
