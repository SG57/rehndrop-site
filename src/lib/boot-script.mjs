// The one inline script the site ships: it must run in the head, before first paint and before the client
// router's module loads, so it cannot be a bundled module. It is a constant so the Content Security Policy can
// name its hash: Base.astro writes this exact text (set:html, no whitespace added), astro.config.mjs hashes
// the same string into script-src. Edit it and both follow; nothing else may be inlined (npm run check:csp).
// String.raw: a plain template literal would eat the backslash in the \d regex below.
export const BOOT_JS = String.raw`(function () {
  var d = document.documentElement;
  d.classList.add('js');
  try { if (localStorage.getItem('index-view') === 'list') d.dataset.view = 'list'; } catch (e) {}
  if (/[?&]t=-?\d/.test(location.search)) d.classList.add('is-frozen');
  // a popstate gate that runs ahead of the client router's own listener (this script runs
  // before the router module loads); the contact sheet uses it so Back only closes the sheet
  var r = (window.__rehndrop = window.__rehndrop || {});
  addEventListener('popstate', function (e) {
    if (r.popGate && r.popGate(e)) e.stopImmediatePropagation();
  });
})();`;
