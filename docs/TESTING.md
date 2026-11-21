# Testing

All checks run from the repo root. None of them publish anything. The browser is always muted. Node: `engines.node` in `package.json` is the range the dev dependencies (stylelint, html-validate) require, `.nvmrc` says 22 and CI runs 22.

## Quick list

| Command | What it tells you |
|---|---|
| `npm run build` then `npm run qa` | Every device size, every behaviour (index, search, player, router, contact sheet, keyboard, frozen clock). Fails on overflow, console errors, or a failed check. |
| `npm run qa:software` | The same run with software WebGL forced. Fails if the browser did not really get software rendering. |
| `npm run assets:check` | Images carry no metadata, names are plain, nothing is over budget, no video, no source maps. |
| `npm run legibility:local -- <url>` | Contrast of text over the background. Needs a running page, for example `npm run preview` then `http://localhost:4321/`. |
| `npm run perf:tier` | Names the WebGL renderer this machine gives a browser and says whether it counts as software. |
| `npm run check:no-lab` | Release guard for the throwaway lab pages. Set `RELEASE=1` to enforce it. |

Useful flags for `qa`: `--only iphone-15,laptop` (some devices), `--skip-long` (skips the 40 second teaser test), `--gpu` or `--headed` (real GPU).

## What a software-render run means

Some machines have no GPU driver for the browser and draw WebGL on the CPU (SwiftShader, llvmpipe, Microsoft Basic Render Driver). The site detects this and picks its cheap tier: lower resolution, no blur. `qa:software` and `perf:tier --software` force that situation on any machine so the cheap tier gets tested.

A software run proves the page works and looks right in that tier. It does not prove how fast it is. A headless browser cannot see real frame cost, so any speed claim from it is UNVERIFIED. To judge speed, open the page on the real machine and watch it.

## Scene checks and skips

When the background scene is on the page, `qa` also checks that `html[data-tier]` is set, a scene canvas has a size, nothing overflows sideways, and `?tier=software|hardware|reduced` is obeyed. The scene counts as present when `window.__rehndrop.scene` exists or a `canvas[data-scene]` is on the page.

When the scene is not there yet, those checks print a `SKIP` line and the final summary says how many were skipped. A skip is not a pass. Read the summary, not just the exit code.

`legibility` does the same for text over each plate: with the scene on it re-runs every text style with candle, chrome and dawn swelled in turn and holds them to the existing targets (median 7:1, bright specks 4.5:1).

## Assets

`assets:check` covers `public/scene`: three plates (`room-candle.webp`, `room-chrome.webp`, `room-dawn.webp`) and three masks (`mask-<essence>.png`). Each must have a plain name, no metadata, and be 120 KB or less. A missing file is a `SKIP`. An unexpected file in that folder fails.

## Perf tier

`perf:tier` opens a real browser window off screen so you see the GPU your browser really gets. Exit code 0 means a hardware renderer, 3 means software or no WebGL. Add `--software` to force software, `--json` for machine-readable output.

## Release guard

`RELEASE=1 npm run check:no-lab` exits 1 if any `src/pages/lab-*` exists. Without `RELEASE=1` it prints a `SKIP` and enforces nothing. On Windows PowerShell use `$env:RELEASE=1; npm run check:no-lab`.

## Gates (CI and before a push)

A push to `main` deploys, so the gates below run in `.github/workflows/deploy.yml` before the artifact is uploaded. If one fails the previous deployment stays live. The scheduled 6-hourly rebuild runs them too, with one difference: `check:html` reads the freshly built pages, which carry live Apple and YouTube data, so on `schedule` that single step is allowed to fail (`continue-on-error`) and prints a `::warning` annotation, and the run goes on to deploy. A push, a pull request or a manual dispatch still blocks on it. Every other gate blocks on every trigger, `check:csp` included; `test:gates` runs on fixtures only and never reads feed data. UNVERIFIED: the workflow itself (it parses as YAML, but a scheduled run is the only real test); the first scheduled run after merge should be watched.

| Command | Needs | What it fails on |
|---|---|---|
| `npm run check` | nothing | `astro check` errors (type errors in `.astro`, `.ts` and the scripts). The baseline is zero errors; hints do not fail. TypeScript stays on 6 (`^6.0.3`; Dependabot ignores the 7 major). |
| `npm run check:page-load` | nothing | A bundled `<script>` in an `.astro` file (inline body, or `src="./x.ts"`) that is not wired to a module binding `astro:page-load` or `astro:after-swap`. The client router runs a bundled script once. A handler counts when it is in the script itself or in a module the script reaches through imports it actually uses (a referenced named, default or namespace import, a re-export, a dynamic `import()`); an unused import, a type-only import and a bare side-effect import (`import './x'`) do not vouch for the script. A `<script src>` that is not a relative path to a source file (an absolute path, a URL, a missing file) fails as unresolved instead of being skipped. Limit: a module the script really uses whose page-load handler serves something else still satisfies it (the gate reads imports and identifiers, not data flow). Reviewed exceptions live in `scripts/gates/page-load.allow.json` with a reason each; a stale entry fails. |
| `npm run check:focus` | nothing | An outline removed (`outline: none` or `0`, `outline-style: none`, a zero `outline-width`, `all: unset`), judged by what the rule's declarations leave in effect, with no replacement that survives forced-colors mode: a transparent outline that still has a visible style and width, a ring inside a media query that is exactly `(forced-colors: active)` (a `not`, a query list or an extra condition does not count), or a `:focus-visible` ring. A ring declares its style and width in the same rule (a colour alone is not a ring); a box-shadow ring is not a replacement (forced colors drops it). Replacements are pooled across all stylesheets. Reviewed exceptions live in `scripts/gates/focus-allow.json`. Limits: selectors are compared as text, `var()` in the shorthand is trusted, nested `&` selectors are not resolved. |
| `npm run check:modes` | nothing | A top-level rule in `src/styles/a11y-modes.css` that is not inside `@media (forced-colors: active)` or `@media (prefers-contrast: more)`, and a forced-colors, prefers-contrast or inverted-colors query in any other `src/**/*.css` (the reviewed exception list in the script is empty). That file holds the visitor-preference modes, and the default look must not depend on it. |
| `npm run check:type-units` | nothing | A font size (`font-size`, or the `font` shorthand) that does not follow the reader's browser font size: any px length, `calc()`, `min()`, `max()` and `clamp()` included (`calc(10px + .001rem)` and `min(2rem, 20px)` fail; the one exception is the exact floor `max(1rem, 16px)` on the search field, because iOS zooms into a field under 16px); an absolute unit (`pt cm mm in pc Q`); `font-size: var(--x)` where `--x`, or a custom property it points at, is declared in px or an absolute unit anywhere in `src`; and the same sizes written outside a stylesheet: inline `style=""` attributes and `style={`...`}` in `.astro` files, `el.style.fontSize`, `{ fontSize: ... }`, `setProperty('font-size', ...)` and `cssText` strings in scripts. `vw` inside a `clamp()` stays legal (the fluid-type design, rem bounds). Layout lengths and media queries stay px and are not read. A stylesheet set with no `font-size` at all also fails, so the gate cannot pass blind. Limits: the non-stylesheet scan is lexical (a size assembled across statements or spread from another object is not followed), and a px custom property reaching a font size fails even if a media query redefines it in rem. |
| `python scripts/font_metrics.py --check` | Python, fontTools, Windows fonts | A fallback face in `src/styles/fonts.css` whose size-adjust or overrides no longer match the font files, or the rehndrop face drifting from Michroma's metrics. Not in CI (it needs the Windows fallback fonts); `gates:local` runs it on Windows. |
| `npm run check:csp` | `npm run build` | The built pages and their Content Security Policy, parsed directive by directive against a reviewed source list: not exactly one policy meta per page, pages whose policies differ (policies accumulate across client-router swaps), `unsafe-inline` / `unsafe-eval` / `unsafe-hashes` / `strict-dynamic`, a wildcard, a scheme-only source (`data:`, `https:`, `blob:`) or a host source anywhere it is not on the list (`img-src` may carry `data:` for the stylesheets' SVGs and `https://i.ytimg.com`; `style-src-attr 'unsafe-inline'` is the one reviewed gap), a directive written twice, an unknown one, or one a meta tag ignores (`frame-ancestors`, `report-uri`, `sandbox`), a missing `default-src 'self'`, `object-src 'none'` or `base-uri`. In the markup: any `on*=` handler attribute, a `javascript:` URL (entity-encoded too), an inline script whose sha256 is not in the policy (only `application/json` and `application/ld+json` count as data; any other `type`, `text/ecmascript` and `importmap` included, counts as executable), an inline module script (the router injects a `data:` script for it), an external script or stylesheet, an inline `<style>` without a hash. And the order: a meta policy governs only what comes after it, so the scripts and stylesheets ahead of the meta must be exactly the reviewed pair in `scripts/gates/csp-before-meta.allow.json` (the boot script by hash, the router script by path); anything else ahead of it, or a stale entry, fails. Lexical limits: text scan with a small tokenizer, not a browser; run-time injection is the crawl's job. |
| `npm run check:html` | `npm run build` | html-validate hard errors on `dist/**/*.html`: `no-multiple-main`, `valid-id`, `no-dup-id`, `empty-heading`, `hidden-focusable`; and our own `one-visible-main`: exactly one visible `<main>` or `role="main"` per page (html-validate ignores `role="main"` and says nothing about a page with no main; a `<main hidden>` does not count as visible, so it is allowed beside the real one). Every other finding is a warning with a count per rule. Folders starting with `_` (screenshot output) are skipped. Limits: a main under a hidden ancestor or inside a `<template>` is read as visible. On the scheduled rebuild this step does not block, see below. |
| `npm run test:gates` | nothing | The gates themselves: each runs against fixtures that must pass and fixtures that must fail with a named message (`scripts/gates/fixtures/`). A gate gone blind turns this red. |
| `npm run gates` | `npm run build` | All of the above except `test:gates`, plus `assets:check`. The local mirror of the CI checks. |
| `npm run gates:local` | Edge or Chrome | Everything: `test:gates`, build, `gates`, `qa`, a browser check that the spotlight buttons survive client-router swaps, a browser check that the words worth copying select with a real mouse while the stage and the spotlight still do not (`scripts/gates/selection.mjs`), a browser crawl of every route at 375 and 1440 px under the Content Security Policy, failing on any violation and checking the WebGL stage, dialog, audio, search, spotlight and router swaps still work (`scripts/gates/csp-crawl.mjs`), a browser check of the forced-colors and prefers-contrast modes by computed style (`scripts/gates/modes.mjs`: the stage layers are not drawn, text reaches 7:1 on Canvas, the dialog, play disc, selected state and focus ring use system colors, the default mode is unmoved; and on one track page per room, where `trackpage.css` loads after the modes file: every scrub mark and seam is CanvasText, the scrub input ring is a Highlight outline, the title carries the contrast halo on both tiers), and `legibility` on a local preview. Run it before pushing to `main`. `--quick` limits `qa` to two devices and `legibility` to the laptop run (the full legibility pass alone took about 13 minutes here), `--skip-long` skips the 40 second teaser test, `--no-build` reuses `dist/`. |

Not covered by any gate, UNVERIFIED: touch long-press selection (the `selection.mjs` check drives a mouse; the device procedure is in the README next to the selection notes).

`qa` and `legibility` are not in `deploy.yml`: they drive a real browser, and a flaky browser step must not be able to stop the site from deploying. `.github/workflows/gates.yml` runs the static gates on every pull request, and has a manual `browser` job that runs `gates:local` on the runner's own Edge. That job has not been proven on a runner yet; treat a first run there as an experiment. Both scripts take `QA_BROWSER_CHANNEL` (`msedge` by default, or `chrome`, or `bundled` for Playwright's own chromium) so they run where Edge is not installed.

Adding an exception to either allow list is a review decision, not a way to silence a gate: write why it is safe, and prefer fixing the code.
