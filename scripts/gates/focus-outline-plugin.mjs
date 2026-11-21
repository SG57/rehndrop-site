// stylelint plugin: local/focus-outline-replacement
//
// Fails a rule that removes an element's outline (outline: none | 0, outline-style: none) unless the
// focus indication survives somewhere the browser still draws it. Removing the outline is only safe
// when something replaces it, and box-shadow is NOT a replacement: forced-colors mode (Windows
// contrast themes) drops box-shadow, so a ring built from one vanishes for exactly the people who need it.
//
// A selector passes when ANY of these holds:
//   1. the same rule also sets a transparent outline (outline: 2px solid transparent), the standard
//      idiom: invisible normally, drawn in a system colour under forced-colors;
//   2. an @media (forced-colors: active) rule in the same stylesheet sets a real outline on the
//      selector or on its :focus-visible / :focus form;
//   3. the selector ends in :focus and the same stylesheet gives its :focus-visible form a real outline
//      (the pointer focus ring is dropped on purpose, the keyboard one is not);
//   4. it is listed in the plugin option `allow` ({ "<selector>": "<why it is safe>" }), reserved for
//      elements that take programmatic focus only, or whose ring is supplied by another stylesheet.
//
// The `allow` option is a reviewed list, not a mute switch: the runner (focus-visible.mjs) fails when
// an entry no longer matches an outline removal, so the list cannot rot.
//   plugin option: { allow: { [selector]: reason }, onAllowUsed?: (selector) => void }
import stylelint from 'stylelint';

export const ruleName = 'local/focus-outline-replacement';
export const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (sel) =>
    `outline removed on "${sel}" with no transparent outline, no forced-colors outline and no :focus-visible ring (box-shadow is dropped in forced-colors mode)`,
});

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const value = (d) => d.value.replace(/!important/i, '').trim();
const isNone = (d) =>
  (d.prop === 'outline' && /^(none|0)(\s|$)/i.test(value(d))) ||
  (d.prop === 'outline-style' && /^none$/i.test(value(d)));
const isRealOutline = (d) =>
  (d.prop === 'outline' && !isNone(d) && !/transparent/i.test(d.value)) ||
  (d.prop === 'outline-width' && !/^0(px)?$/i.test(value(d))) ||
  (d.prop === 'outline-color' && !/transparent/i.test(d.value));
const inForcedColors = (rule) => {
  for (let p = rule.parent; p; p = p.parent) {
    if (p.type === 'atrule' && /forced-colors\s*:\s*active/i.test(p.params)) return true;
  }
  return false;
};

/** @type {import('stylelint').Rule} */
const rule = (primary, secondary = {}) => (root, result) => {
  if (!primary) return;
  const allow = secondary.allow ?? {};

  // pass 1: what this stylesheet already gives focus-visible, and what it gives forced-colors
  const forced = new Set();
  const visibleRing = new Set();
  root.walkRules((r) => {
    const hasReal = r.some((n) => n.type === 'decl' && isRealOutline(n));
    if (!hasReal) return;
    for (const s of r.selectors.map(norm)) {
      if (inForcedColors(r)) forced.add(s);
      else if (/:focus-visible$/.test(s)) visibleRing.add(s);
    }
  });

  // pass 2: every rule that removes the outline
  root.walkRules((r) => {
    if (inForcedColors(r)) return;
    const removal = r.nodes?.find((n) => n.type === 'decl' && isNone(n));
    if (!removal) return;
    if (r.some((n) => n.type === 'decl' && n.prop.startsWith('outline') && /transparent/i.test(n.value))) return;
    for (const s of r.selectors.map(norm)) {
      if (Object.hasOwn(allow, s)) { secondary.onAllowUsed?.(s); continue; }
      if (forced.has(s) || forced.has(`${s}:focus-visible`) || forced.has(`${s}:focus`)) continue;
      if (/:focus$/.test(s) && visibleRing.has(s.replace(/:focus$/, ':focus-visible'))) continue;
      stylelint.utils.report({ ruleName, result, node: removal, message: messages.rejected(s) });
    }
  });
};
rule.ruleName = ruleName;
rule.messages = messages;

export default stylelint.createPlugin(ruleName, rule);
