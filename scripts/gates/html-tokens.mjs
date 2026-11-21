// A small HTML tokenizer, enough for built output (shared by check-csp.mjs and check-html.mjs).
// Follows the HTML tokenizer where a gate can be fooled: comments (<!-- ... -->, the empty forms <!--> and <!--->, and the
// close --!>), bogus comments (<!x>, <?x>, </ x>, ended by the first >), quoted attribute values (with > inside), raw-text
// bodies of script/style/title/textarea/xmp/iframe/noembed/noframes (a self-closing slash does not close them in HTML, only
// inside svg or math), entity-encoded attribute values, first-occurrence-wins duplicate attributes. It also walks an element
// stack, so every start tag knows its parent: void elements, end tags that pop to the nearest match, and a head that closes at
// the first start tag it cannot hold (a div, an img), as a browser's tree builder does. It is text, not a browser: see the
// lexical limits in the gates that use it (no optional-end-tag modelling beyond that, no foster parenting, no script
// double-escape states, no namespaces beyond "inside svg or math").
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ' };
export const decode = (s) => s
  .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
  .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Math.min(parseInt(d, 10), 0x10ffff)))
  .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const RAW = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const HEAD_OK = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noscript', 'noframes', 'script', 'style', 'template', 'title']);
const FOREIGN = new Set(['svg', 'math']);
const START = /<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/y;
const END = /<\/([a-zA-Z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^'">])*>/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const COMMENT_CLOSE = /--!?>/g;

/**
 * Every start tag in document order: { name, attrs: [[name, value]], body?, index, parent }. parent is the enclosing element's
 * node ({ name, parent }, or null at the top; a head the page leaves implicit is a synthetic node). First occurrence of an
 * attribute wins.
 */
export function tokenize(html) {
  const nodes = [];
  const stack = [];
  let headDone = false;
  let headSeen = false;
  const top = () => stack[stack.length - 1] ?? null;
  const inForeign = () => stack.some((n) => FOREIGN.has(n.name));
  const popTo = (name) => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === name) { stack.length = k; return; }
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const j = lt + 4;
      if (html[j] === '>') i = j + 1; // <!--> is a complete, empty comment
      else if (html.startsWith('->', j)) i = j + 2; // so is <!--->
      else { COMMENT_CLOSE.lastIndex = j; const c = COMMENT_CLOSE.exec(html); i = c ? c.index + c[0].length : html.length; } // --> or --!>
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?' || (next === '/' && !/[a-zA-Z>]/.test(html[lt + 2] ?? ''))) { // bogus comment: ends at the first >
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === '/') {
      END.lastIndex = lt;
      const e = END.exec(html);
      if (!e) { i = lt + 2; continue; }
      const name = e[1].toLowerCase();
      popTo(name);
      if (name === 'head') headDone = true;
      i = lt + e[0].length;
      continue;
    }
    START.lastIndex = lt;
    const m = START.exec(html);
    if (!m) { i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    // the tree builder closes the head at the first start tag it cannot hold, and makes one when the page has none
    if (top()?.name === 'head' && !HEAD_OK.has(name)) { stack.length -= 1; headDone = true; }
    if (!headSeen && !headDone && name !== 'head' && name !== 'html' && (top() === null || top().name === 'html')) {
      if (HEAD_OK.has(name)) { const h = { name: 'head', parent: top(), synthetic: true }; stack.push(h); headSeen = true; }
    }
    if (name === 'body') { popTo('head'); headDone = true; }
    const attrs = [];
    for (const a of m[2].matchAll(ATTR)) if (!attrs.some(([n]) => n === a[1].toLowerCase())) attrs.push([a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? '')]);
    const node = { name, attrs, index: lt, parent: top() };
    const selfClosing = m[0].endsWith('/>') && inForeign(); // in HTML a trailing slash closes nothing
    i = lt + m[0].length;
    if (name === 'head' && (headSeen || headDone)) { nodes.push(node); continue; } // a second <head> is ignored by the parser
    if (RAW.has(name) && !selfClosing) {
      const close = new RegExp(`</${name}[\\s/>]`, 'ig');
      close.lastIndex = i;
      const c = close.exec(html);
      node.body = html.slice(i, c ? c.index : html.length);
      i = c ? c.index + c[0].length : html.length;
    } else if (!VOID.has(name) && !selfClosing) {
      stack.push(node);
      if (name === 'head') headSeen = true;
    }
    nodes.push(node);
  }
  return nodes;
}
export const get = (node, name) => node.attrs.find(([n]) => n === name)?.[1] ?? null;
/** The names of the elements above a node, outermost first. */
export const ancestors = (node) => { const out = []; for (let p = node.parent; p; p = p.parent) out.unshift(p.name); return out; };
/** The line (1-based) of a node in the page it came from. */
export const lineOf = (html, node) => html.slice(0, node.index).split('\n').length;
