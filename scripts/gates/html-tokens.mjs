// A small HTML tokenizer, enough for built output (shared by check-csp.mjs and check-html.mjs).
// Handles comments, quoted attribute values (with > inside), raw-text bodies of script/style/title/textarea, entity-encoded attribute
// values, first-occurrence-wins duplicate attributes. It is text, not a browser: see the lexical limits in the gates that use it.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ' };
export const decode = (s) => s
  .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
  .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const RAW = new Set(['script', 'style', 'title', 'textarea']);
const TAG = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Every tag in document order: { name, attrs: [[name, value]], body?, index }. First occurrence of an attribute wins. */
export function tokenize(html) {
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
export const get = (node, name) => node.attrs.find(([n]) => n === name)?.[1] ?? null;
