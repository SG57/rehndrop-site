# rehndrop-site

The rehndrop landing page: velvet, chrome, rain. Astro static site on GitHub Pages.

## How the data flows

| Source | What it gives | When |
|---|---|---|
| Apple (`itunes.apple.com/lookup?id=1545317806`) | what's live, real release dates, per-track Apple links, 30 s fallback previews and artwork | every build |
| YouTube RSS (main channel + both Topic channels) | music videos, per-track YouTube Music links | every build |
| `src/data/catalog.json` + `public/previews`, `public/env`, `src/assets/covers` | sigil-stamped covers, previews cut 4 bars before the measured drop, drop-sync envelopes, lanes | written locally by `scripts/export_catalog.py` |
| `src/data/curation.json` | spotlight order, title answers, store and social links, hidden videos | hand-edited |

The deploy workflow rebuilds on every push **and every 6 hours**, so a release that goes live on
Apple appears on its own (with Apple's artwork and preview). Running the exporter for it adds the
stamped cover and the drop-synced preview.

Every network fetch falls back to a committed snapshot, so a dead API never breaks a build.

## Commands

```bash
python scripts/export_catalog.py              # all tracks (idempotent; --force, --only <slug>)
python scripts/check_catalog.py               # verifies every exported file and the drop sync
python scripts/verify_previews.py             # proves each preview is its own song, at Cord's times (--only a,b)
python scripts/build_brand_assets.py          # chrome R, velvet textures, share card, icons
npm run build                                 # static build into dist/
python scripts/export_lyrics.py               # full lyrics for the slugs in curation.json "lyrics" (part of npm run export)
node scripts/build_web_assets.mjs             # the 1080w phone velvet and the header-sized R (npm run assets:web)
npm run assets:check                          # fails on image metadata, editor SVG data, non-plain names, uncovered backdrops, source maps
node scripts/qa.mjs [--gpu]                   # 10 device viewports + behaviour checks (index, search, router, sheet, scrubber), via the installed Edge
node scripts/legibility.mjs <url> [--gpu]     # contrast of every floating text style vs the live velvet (AAA median, AA specks)
```

The exporter reads `D:/rehndrop/tracks` and `D:/rehndrop/resources` read-only and writes temp
files under `.cache/`.

**Preview windows.** By default each preview is 30 s starting 4 bars before the strongest measured
drop that leaves 24 s of song after it. Cord can override any track in `scripts/preview-overrides.json`:
`{"<slug>": {"start": 105.0}}` (seconds), optionally with `"hit": 111.4` for where the surge should
land. Without `hit`, the strongest measured drop inside the new window is used, so the surge and
camera kick still fire. Then run `export_catalog.py --only <slug>` and `check_catalog.py`.

Several hits in one window: `{"start": 184, "hits": [189, 203]}`. Several moments in one preview
("teasers"): `{"segments": [{"start": 270, "hits": [288.5]}, {"start": 90, "hits": [100]}]}`, played
in that order. Every teaser but the last ends on the measured downbeat nearest 30 s and they meet in
a 0.5 s equal-power crossfade; the seam gets a splash on the lens and a notch on the player bar.
By-ear hits snap to the strongest onset within 0.4 s, and only when it is clearly strong; otherwise
the given time stands. A cut never lands within a second of a hit, and the closing fade waits a
second after the last one.

`verify_previews.py` shares no code with the exporter: it decodes each finished preview and the
song's own audio from its track folder and fails unless every teaser cross-correlates with its own
song at the given start (and with no other song), every hit maps back to Cord's time, the length
adds up, and the envelope the visuals run on was measured from that exact audio.

## Moving to the custom domain

Commit `public/CNAME` containing the domain (e.g. `rehndrop.com`) after the DNS record exists
(`A`/`AAAA` records for GitHub Pages, `CNAME www -> sg57.github.io.`). `astro.config.mjs` switches the site URL and base path from
that one file, and GitHub Pages picks the domain up from the deployed artifact.

## Visual system

- `src/scripts/lens.ts` is the wet-lens WebGL shader. It falls back to the static CSS velvet when
  there's no WebGL, the GPU is software-only, the context is lost, the frame-rate probe fails
  twice, or reduced motion is on. Add `?lens` to the URL to force it on for testing.
- `src/scripts/player.ts` is one plain `<audio>` element. The visuals read precomputed envelopes
  against `audio.currentTime`; no Web Audio, because the iPhone ringer switch mutes it.
- Words follow `D:/rehndrop/resources/brand/VOICE.md`: lowercase, no hype, no asks.
- The client router (`astro:transitions`) carries the `<audio>`, the lens and water canvases, the
  velvet and the mini player across pages (`transition:persist`), so a preview keeps playing from
  the home page into any track page and back. Page-local scripts bind on every `astro:page-load`;
  everything document-level starts once (`Base.astro`).
- Decorative code reads time through `src/scripts/clock.ts` and never calls `Math.random`; add
  `?t=<unix ms>` to any URL for a still, reproducible frame.
- The page is a stage, so text doesn't select by default. The exceptions are the words you would want to copy:
  the contact address and full lyrics (`.selectable`), a track page's title, its line and liner note and its
  quote, the line under a title in the index, and the credit line. This was a taste-versus-function call
  (owner Cord, approved): copying a title is a basic expectation, and none of these has a pointer handler of
  its own. Left unselectable on purpose: the home spotlight (`ui.ts` reads a mouse drag there as a swipe, so
  selectable text would select while swiping) and every title that is a link (a drag on a link starts a link
  drag). The site has no on-page bio; `BIO` is only the meta description. `npm run gates:local` runs
  `scripts/gates/selection.mjs`, which triple-clicks each of these with a real mouse and checks the stage
  controls still do not select.
- Visitor-preference modes live in `src/styles/a11y-modes.css`, loaded last, every rule inside `@media (forced-colors: active)`
  or `@media (prefers-contrast: more)` (`npm run check:modes` fails on anything else, so the default look cannot depend
  on it). Forced colors: the velvet, lens, grain and water are not drawn, so the text sits on Canvas in CanvasText, and
  the dialog, play discs, selected state, scrubber and focus ring use system colors. Increased contrast: the grain
  becomes a plain dark veil, inks go to near-white, hairlines and glass firm up, and the focus ring thickens.
  Verified with Playwright's media emulation, not a real Windows contrast theme.
- Fonts (`src/styles/fonts.css`): Latin subsets only, woff2 only, files hashed by Vite and base-aware (the rehndrop face
  lives in `src/assets/fonts`). The copy is English lowercase and nothing in the checked-in data leaves the Latin range;
  a character outside it (a future live title) falls to the system font. Each web font has a metric-matched fallback
  face (`size-adjust` and the ascent, descent and line-gap overrides, named in the `--font-*` stacks), computed from the
  real font files by `python scripts/font_metrics.py` (`--check` fails if `fonts.css` drifts; needs fontTools and the
  Windows Arial and Times New Roman files). The rehndrop face shares Michroma's fallback: same widths and metrics.
  **No preload**, deliberately. All four faces draw above the fold on both page types, so one preload makes the display
  face arrive ahead of the rest and creates a second swap. Measured with every font response delayed 1200 ms (headless
  Edge, SwiftShader, three runs): desktop home CLS 0.072 to 0.179 before this change, 0.018 with the fallbacks and no
  preload, 0.157 with the fallbacks and the display face preloaded, 0.157 with all four preloaded; phone home 0.106
  before, 0 after. LCP did not improve with a preload (noise of about 200 ms in this setup). The harness is synthetic;
  reopen the preload question with real-network field data (CrUX) if the site ever has it. Dist went from 456 files and
  12 font files (202,352 bytes) to 448 files and 4 font files (94,108 bytes); what a visitor downloads is unchanged (the
  same four woff2 files, as the unicode ranges already kept the other subsets from loading).
