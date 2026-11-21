// stylelint plugin: local/focus-outline-replacement
//
// Fails a rule that removes an element's outline (outline: none | 0, outline-style: none, outline-width: 0, or
// all: unset | initial) unless the focus indication survives somewhere the browser still draws it. Removing the outline is
// only safe when something replaces it, and box-shadow is NOT a replacement: forced-colors mode (Windows contrast
// themes) drops box-shadow, so a ring built from one vanishes for exactly the people who need it.
//
// What a rule does to the outline is evaluated, not pattern-matched: its declarations are applied in order (a shorthand
// resets what it omits, a later declaration beats an earlier one, !important beats a later plain one) to a state of
// { style, width, color }. A rule REMOVES the outline when that state ends with style none or a zero width. A rule is a RING
// only when it ends with a visible style AND a nonzero width, both declared in that same rule (the outline shorthand with
// a visible style does both). A colour alone is not a ring: `outline-color: red` on a :focus-visible rule draws nothing,
// and `outline: none; outline-color: transparent` is still no outline.
//
// A selector passes when ANY of these holds:
//   1. the same rule also ends with a transparent ring (outline: 2px solid transparent), the standard idiom: invisible
//      normally, drawn in a system colour under forced-colors;
//   2. an @media (forced-colors: active) rule in ANY stylesheet of the run sets a ring on the selector or on its
//      :focus-visible / :focus form. "In forced-colors" means the media query is exactly that feature (optionally
//      prefixed `screen and` or `only screen and`): `not (forced-colors: active)`, a query list, or any other
//      condition combined with it is NOT forced-colors and earns no exemption;
//   3. the selector ends in :focus and some stylesheet gives its :focus-visible form a visible, non-transparent ring (the
//      pointer focus ring is dropped on purpose, the keyboard one is not);
//   4. it is listed in the plugin option `allow` ({ "<selector>": "<why it is safe>" }), reserved for
//      elements that take programmatic focus only, or whose ring is supplied by another stylesheet.
//
// The `allow` option is a reviewed list, not a mute switch: the runner (focus-visible.mjs) fails when
// an entry no longer matches an outline removal, so the list cannot rot.
//   plugin options: { allow: { [selector]: reason }, onAllowUsed?: (selector) => void,
//                     shared?: { forced: Set, visibleRing: Set }, collectOnly?: boolean }
//   `shared` lets the runner pool the replacements of every stylesheet (a forced-colors ring in a11y-modes.css covers an
//   outline removed in global.css); with `collectOnly` the rule only fills `shared` and reports nothing.
// Lexical limits, left to review: selectors are compared as text (no specificity, no cascade across rules); a value with
// var() in the outline shorthand is assumed to supply what it does not show; a calc() width is assumed nonzero;
// nested selectors (&) are not resolved; a replacement in a stylesheet that is not loaded on the page is still counted.
import stylelint from 'stylelint';

export const ruleName = 'local/focus-outline-replacement';
export const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (sel) =>
    `outline removed on "${sel}" with no transparent outline (visible style and width), no forced-colors outline and no :focus-visible ring (style and width, not a colour alone; box-shadow is dropped in forced-colors mode)`,
});

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const STYLE = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|auto)$/i;
const WIDTH = /^(?:thin|medium|thick|[+-]?(?:\d*\.)?\d+[a-z%]*|(?:calc|min|max|clamp)\(.*\))$/i;
const ZERO = /^[+-]?(?:0+(?:\.0*)?|\.0+)[a-z%]*$/i;
const isZero = (w) => ZERO.test(String(w).trim());

/** Split a value on whitespace outside parentheses. */
function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of v) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (/\s/.test(c) && depth <= 0) { if (cur) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** The outline shorthand: everything it omits is reset to its initial value (style none, width medium, colour currentcolor). */
function parseShorthand(value) {
  let style; let width; let color;
  let hasVar = false;
  for (const t of splitTop(value)) {
    if (/^var\(/i.test(t)) { hasVar = true; continue; }
    if (STYLE.test(t) && style === undefined) style = t.toLowerCase();
    else if (WIDTH.test(t) && width === undefined) width = t.toLowerCase();
    else color = t;
  }
  return { style: style ?? (hasVar ? 'unknown' : 'none'), width: width ?? (hasVar ? 'unknown' : 'medium'), color: color ?? (hasVar ? 'unknown' : 'currentcolor') };
}

/** What the rule's own declarations leave the outline as. Properties the rule never mentions stay undefined. */
function evaluate(rule) {
  const st = { style: undefined, width: undefined, color: undefined };
  const imp = { style: false, width: false, color: false };
  let touched = false;
  const set = (key, val, important) => {
    if (imp[key] && !important) return;
    st[key] = val;
    if (important) imp[key] = true;
  };
  const setAll = (o, important) => { for (const k of ['style', 'width', 'color']) set(k, o[k], important); };
  for (const n of rule.nodes ?? []) {
    if (n.type !== 'decl') continue;
    const prop = n.prop.toLowerCase();
    const important = n.important || /!important/i.test(n.value);
    const value = n.value.replace(/!important/i, '').trim();
    if (prop === 'outline') {
      touched = true;
      if (/^(initial|unset)$/i.test(value)) setAll({ style: 'none', width: 'medium', color: 'currentcolor' }, important);
      else if (/^(inherit|revert|revert-layer)$/i.test(value)) setAll({ style: 'unknown', width: 'unknown', color: 'unknown' }, important);
      else setAll(parseShorthand(value), important);
    } else if (prop === 'outline-style') { touched = true; set('style', /^var\(/i.test(value) ? 'unknown' : value.toLowerCase(), important); }
    else if (prop === 'outline-width') { touched = true; set('width', /^var\(/i.test(value) ? 'unknown' : value.toLowerCase(), important); }
    else if (prop === 'outline-color') { touched = true; set('color', value, important); }
    else if (prop === 'all' && /^(initial|unset)$/i.test(value)) { touched = true; setAll({ style: 'none', width: 'medium', color: 'currentcolor' }, important); }
  }
  return { ...st, touched };
}
const removes = (st) => st.style === 'none' || (st.width !== undefined && isZero(st.width));
const isRing = (st) => st.style !== undefined && st.style !== 'none' && st.width !== undefined && !isZero(st.width);
const transparent = (st) => /transparent/i.test(st.color ?? '');

// the query must be exactly the forced-colors feature; any `not`, list or extra condition makes it something else
const PLAIN_FORCED = /^(?:(?:only\s+)?(?:screen|all)\s+and\s+)?\(\s*forced-colors\s*:\s*active\s*\)$/i;
const PLAIN_SCREEN = /^(?:only\s+)?(?:screen|all)$/i;
/** 'forced' (inside the plain forced-colors query), 'plain' (unconditional), or null (under a condition this gate does not model). */
function context(rule) {
  let forced = false;
  for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type !== 'atrule') continue;
    const at = p.name.toLowerCase();
    if (at === 'layer') continue;
    if (at !== 'media') return null;
    const q = p.params.trim().replace(/\s+/g, ' ');
    if (PLAIN_FORCED.test(q)) forced = true;
    else if (!PLAIN_SCREEN.test(q)) return null;
  }
  return forced ? 'forced' : 'plain';
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** Split on a separator outside parentheses. */
function splitList(v, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of v) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
/** [ids, classes + attributes + pseudo-classes, types + pseudo-elements] of a selector (Selectors 4, as far as it matters here). */
function specificity(selector) {
  const sum = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const most = (list) => list.reduce((m, x) => (compare(x, m) > 0 ? x : m), [0, 0, 0]);
  let acc = [0, 0, 0];
  let rest = selector;
  // functional pseudos: :is / :not / :has / :matches take their most specific argument, :where none, the others count as a class
  for (let m; (m = /::?([\w-]+)\(/.exec(rest));) {
    let depth = 1;
    let k = m.index + m[0].length;
    for (; k < rest.length && depth; k++) { if (rest[k] === '(') depth++; else if (rest[k] === ')') depth--; }
    const args = rest.slice(m.index + m[0].length, k - 1);
    const name = m[1].toLowerCase();
    if (name === 'where') acc = sum(acc, [0, 0, 0]);
    else if (['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'].includes(name)) acc = sum(acc, most(splitList(args, ',').map(specificity)));
    else if (rest.startsWith('::', m.index)) acc = sum(acc, [0, 0, 1]);
    else acc = sum(acc, [0, 1, 0]);
    rest = rest.slice(0, m.index) + ' ' + rest.slice(k);
  }
  const take = (re, add) => { rest = rest.replace(re, () => { acc = sum(acc, add); return ' '; }); };
  take(/\[[^\]]*\]/g, [0, 1, 0]);
  take(/#[\w-]+/g, [1, 0, 0]);
  take(/\.[\w-]+/g, [0, 1, 0]);
  take(/::[\w-]+|:(?:before|after|first-line|first-letter)(?![\w-])/gi, [0, 0, 1]);
  take(/:[\w-]+/g, [0, 1, 0]);
  take(/(?<![\w-])[a-zA-Z][\w-]*/g, [0, 0, 1]);
  return acc;
}
// "the same element": the selector without a trailing :focus / :focus-visible
const baseOf = (sel) => sel.replace(/:focus(?:-visible)?$/, '');
/** A removal on the same element that wins over the ring: equal or higher specificity, later in its file, or in another file. */
const cancelled = (ring, removals) => removals.some((rm) =>
  baseOf(rm.sel) === baseOf(ring.sel) && compare(rm.spec, ring.spec) >= 0 && (rm.file !== ring.file || rm.offset > ring.offset));

/** @type {import('stylelint').Rule} */
const rule = (primary, secondary = {}) => (root, result) => {
  if (!primary) return;
  const allow = secondary.allow ?? {};
  const shared = secondary.shared ?? { rings: [], removals: [] };
  const file = root.source?.input?.file ?? '';
  const where = (r) => ({ file, offset: r.source?.start?.offset ?? 0 });

  // pass 1: the rings this stylesheet (and, through `shared`, the others) gives focus-visible and forced-colors, and every
  // outline removal (a later removal can cancel a ring)
  // (the runner lints every file twice: the first round only collects, the second only reports, so nothing is pooled twice)
  if (secondary.collectOnly || !secondary.shared) {
    root.walkRules((r) => {
      const st = evaluate(r);
      const selectors = r.selectors.map(norm);
      if (st.touched && removes(st)) {
        for (const sel of selectors) shared.removals.push({ sel, spec: specificity(sel), ...where(r) });
      }
      if (!isRing(st)) return;
      const ctx = context(r);
      if (ctx === null) return;
      for (const sel of selectors) {
        if (ctx === 'forced') shared.rings.push({ kind: 'forced', sel, spec: specificity(sel), ...where(r) });
        else if (/:focus-visible$/.test(sel) && !transparent(st)) shared.rings.push({ kind: 'visible', sel, spec: specificity(sel), ...where(r) });
      }
    });
  }
  if (secondary.collectOnly) return;

  const has = (kind, sels) => shared.rings.some((e) => e.kind === kind && sels.includes(e.sel) && !cancelled(e, shared.removals));

  // pass 2: every rule that removes the outline
  root.walkRules((r) => {
    const st = evaluate(r);
    if (!st.touched || !removes(st)) return;
    const removal = r.nodes.find((n) => n.type === 'decl' && (/^outline/i.test(n.prop) || n.prop.toLowerCase() === 'all')) ?? r;
    for (const s of r.selectors.map(norm)) {
      if (Object.hasOwn(allow, s)) { secondary.onAllowUsed?.(s); continue; }
      if (has('forced', [s, `${s}:focus-visible`, `${s}:focus`])) continue;
      if (/:focus$/.test(s) && has('visible', [s.replace(/:focus$/, ':focus-visible')])) continue;
      stylelint.utils.report({ ruleName, result, node: removal, message: messages.rejected(s) });
    }
  });
};
rule.ruleName = ruleName;
rule.messages = messages;

export default stylelint.createPlugin(ruleName, rule);
