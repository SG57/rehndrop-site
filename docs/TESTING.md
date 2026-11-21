# Testing

All checks run from the repo root. None of them publish anything. The browser is always muted.

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

A push to `main` deploys, so the gates below run in `.github/workflows/deploy.yml` before the artifact is uploaded. If one fails the previous deployment stays live. The scheduled 6-hourly rebuild runs them too: `check:html` reads the freshly built pages, which carry live Apple and YouTube data, so a failure there on the cron means a new release waits until it is fixed (GitHub emails the failure).

| Command | Needs | What it fails on |
|---|---|---|
| `npm run check` | nothing | `astro check` errors (type errors in `.astro`, `.ts` and the scripts). The baseline is zero errors; hints do not fail. TypeScript stays on 6 (`^6.0.3`; Dependabot ignores the 7 major). |
| `npm run check:page-load` | nothing | A bundled `<script>` in an `.astro` file whose relative-import closure never binds `astro:page-load` or `astro:after-swap`. The client router runs bundled scripts once. Reviewed exceptions live in `scripts/gates/page-load.allow.json` with a reason each; a stale entry fails. |
| `npm run check:focus` | nothing | `outline: none` (or `0`, or `outline-style: none`) with no replacement that survives forced-colors mode: a transparent outline, a forced-colors outline, or a `:focus-visible` ring. A box-shadow ring is not a replacement (forced colors drops it). Reviewed exceptions live in `scripts/gates/focus-allow.json`. |
| `npm run check:modes` | nothing | A top-level rule in `src/styles/a11y-modes.css` that is not inside `@media (forced-colors: active)` or `@media (prefers-contrast: more)`. That file holds the visitor-preference modes, and the default look must not depend on it. |
| `npm run check:type-units` | nothing | A `font-size` (or a `font` shorthand) in `src/**/*.css` written in px. Type is in rem so the visitor's browser font size applies; the only px allowed is the floor of a rem expression, such as `max(1rem, 16px)` on the search field (iOS zooms into a field under 16px). Layout lengths and media queries stay px and are not read. A stylesheet set with no `font-size` at all also fails, so the gate cannot pass blind. |
| `python scripts/font_metrics.py --check` | Python, fontTools, Windows fonts | A fallback face in `src/styles/fonts.css` whose size-adjust or overrides no longer match the font files, or the rehndrop face drifting from Michroma's metrics. Not in CI (it needs the Windows fallback fonts); `gates:local` runs it on Windows. |
| `npm run check:csp` | `npm run build` | The built pages and their Content Security Policy: a page without the meta tag, pages whose policies differ (policies accumulate across client-router swaps), `unsafe-inline`, `unsafe-eval`, `data:`, `blob:` or a wildcard in `script-src` or `style-src`, an inline script or style whose sha256 is not in the policy, an inline `<script type="module">` (the router injects a `data:` script for it), an external script or stylesheet, a missing `default-src 'self'`, `object-src 'none'` or `base-uri`. `style-src-attr 'unsafe-inline'` is the one reviewed gap. |
| `npm run check:html` | `npm run build` | html-validate hard errors on `dist/**/*.html`: `no-multiple-main`, `valid-id`, `empty-heading`, `hidden-focusable`. Every other finding is a warning with a count per rule. Folders starting with `_` (screenshot output) are skipped. |
| `npm run test:gates` | nothing | The gates themselves: each runs against fixtures that must pass and fixtures that must fail with a named message (`scripts/gates/fixtures/`). A gate gone blind turns this red. |
| `npm run gates` | `npm run build` | All of the above except `test:gates`, plus `assets:check`. The local mirror of the CI checks. |
| `npm run gates:local` | Edge or Chrome | Everything: `test:gates`, build, `gates`, `qa`, a browser check that the spotlight buttons survive client-router swaps, a browser check that the words worth copying select with a real mouse while the stage and the spotlight still do not (`scripts/gates/selection.mjs`), a browser crawl of every route at 375 and 1440 px under the Content Security Policy, failing on any violation and checking the WebGL stage, dialog, audio, search, spotlight and router swaps still work (`scripts/gates/csp-crawl.mjs`), a browser check of the forced-colors and prefers-contrast modes by computed style (`scripts/gates/modes.mjs`: the stage layers are not drawn, text reaches 7:1 on Canvas, the dialog, play disc, selected state and focus ring use system colors, the default mode is unmoved), and `legibility` on a local preview. Run it before pushing to `main`. `--quick` limits `qa` to two devices and `legibility` to the laptop run (the full legibility pass alone took about 13 minutes here), `--skip-long` skips the 40 second teaser test, `--no-build` reuses `dist/`. |

`qa` and `legibility` are not in `deploy.yml`: they drive a real browser, and a flaky browser step must not be able to stop the site from deploying. `.github/workflows/gates.yml` runs the static gates on every pull request, and has a manual `browser` job that runs `gates:local` on the runner's own Edge. That job has not been proven on a runner yet; treat a first run there as an experiment. Both scripts take `QA_BROWSER_CHANNEL` (`msedge` by default, or `chrome`, or `bundled` for Playwright's own chromium) so they run where Edge is not installed.

Adding an exception to either allow list is a review decision, not a way to silence a gate: write why it is safe, and prefer fixing the code.
