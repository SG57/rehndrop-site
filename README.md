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
python scripts/build_brand_assets.py          # chrome R, velvet textures, share card, icons
npm run build                                 # static build into dist/
node scripts/qa.mjs                           # 9 device viewports + a playback test, via the installed Edge
node scripts/legibility.mjs <url>             # contrast of every floating text style vs the live velvet (AAA median, AA specks)
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
the given time stands.

## Moving to the custom domain

Commit `public/CNAME` containing the domain (e.g. `rehndrop.sg57.dev`) after the DNS record exists
(`CNAME rehndrop -> sg57.github.io.`). `astro.config.mjs` switches the site URL and base path from
that one file, and GitHub Pages picks the domain up from the deployed artifact.

## Visual system

- `src/scripts/lens.ts` is the wet-lens WebGL shader. It falls back to the static CSS velvet when
  there's no WebGL, the GPU is software-only, the context is lost, the frame-rate probe fails
  twice, or reduced motion is on. Add `?lens` to the URL to force it on for testing.
- `src/scripts/player.ts` is one plain `<audio>` element. The visuals read precomputed envelopes
  against `audio.currentTime`; no Web Audio, because the iPhone ringer switch mutes it.
- Words follow `D:/rehndrop/resources/brand/VOICE.md`: lowercase, no hype, no asks.
