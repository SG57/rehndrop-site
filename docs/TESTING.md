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
