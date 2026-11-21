# AGENTS.md - rehndrop-site

Instructions for any AI agent working on this repository. Read before the first non-trivial change.
`CLAUDE.md` is a pointer to this file; Codex, Cursor, Copilot, Amp, Windsurf and Factory read it natively.
This repo is the site only. The parent folder `D:\rehndrop` has its own `CLAUDE.md` and `AGENTS.md` for the music,
tracks and release pipeline; they do not govern this repo.

## What this is

The rehndrop landing page (Astro static site, GitHub Pages): velvet, chrome and rain, a WebGL lens, a client router that
carries one `<audio>` element across pages. Data flow, commands, CSP and the visual system are in [README.md](README.md);
every gate and what it fails on is in [docs/TESTING.md](docs/TESTING.md).

## Done means

- Before claiming UI work done: `npm run build`, then `npm run gates` (it does not build; `check:html` and `check:csp`
  read `dist/`), and `npm run test:gates`. Paste the output; do not summarise it. `npm run gates:local` is the full
  pre-push run (real browser, needs Edge or Chrome): run it before anything reaches `main`, because a push to `main` deploys.
- A new gate or rule is shown failing (exit 1, right message) on a seeded bad input and passing on a good one, through a
  fixture under `scripts/gates/fixtures/` and a row in `scripts/gates/selftest.mjs`.
- What you could not run (real Safari, Firefox, a real Windows contrast theme, the browser job in CI) is reported as UNVERIFIED.
- Never weaken a gate, widen an allow list (`focus-allow.json`, `page-load.allow.json`) or skip a check to get green. An
  allow entry is a reviewed decision with a written reason.

## Visual identity

The WebGL lens, the velvet, the chrome R and the look of the stage stay pixel-identical unless Cord decides otherwise.
A change for accessibility or performance must leave the default look unmoved: show it (screenshots or computed-style
equality at the default settings), as the rem type scale did. A visual change is Cord's call.

## Rules the gates enforce

- Focus: never remove an outline without a replacement that survives forced-colors mode (a transparent outline, a
  forced-colors outline or a `:focus-visible` ring; a box-shadow ring alone vanishes there). `check:focus`.
- Forced colors and increased contrast live only in `src/styles/a11y-modes.css`, every rule inside
  `@media (forced-colors: active)` or `@media (prefers-contrast: more)`, so the default look cannot depend on it; `check:modes`
  also fails when either query appears in any other stylesheet. Page stylesheets (`trackpage.css`) load after it, so a mode
  rule for an element they restyle needs more specificity than theirs; the browser check `modes.mjs` covers a track page per room.
- Type is in rem, so the reader's browser font size applies. No px `font-size`, except as the floor of a rem expression
  such as `max(1rem, 16px)`. `check:type-units`.
- The client router runs a bundled script once. Page-local scripts bind on `astro:page-load` (never `DOMContentLoaded`);
  document-level setup starts once, in `Base.astro`. `check:page-load`.
- One policy on every page, hash-only `script-src` and `style-src`, no inline module script, no external script or
  stylesheet, no `on*=` handler or `javascript:` URL. A meta policy governs only what follows it, so only the reviewed boot and
  router scripts (`scripts/gates/csp-before-meta.allow.json`) may sit ahead of it. A new inline script is a deliberate act
  (`src/lib/boot-script.mjs`). `check:csp`.
- One `<main>`, valid ids, no empty heading, no focusable content under `aria-hidden`. `check:html`.

## Rules reviewed by hand (no gate)

- Native first: the platform element (the contact sheet is a `<dialog>`, playback is one plain `<audio>`) before custom JS.
- Reduced motion removes movement. The lens, the drops and smooth scrolling already read `reducedMotion()` from
  `src/scripts/drive.ts`; new motion follows the same rule.
- Decorative code reads time through `src/scripts/clock.ts` and never calls `Math.random`.

## Platform guidance

Before writing or changing browser HTML, CSS or client JS, invoke `/platform-currency` (if it is not installed, say so in
the hand-off) and end the verification statement with its `Platform guides:` line. It supplies patterns; this file, the
README and the gates always win ("Repo rule X overrides guide Y"). A guide that shows `DOMContentLoaded`, an inline
script or a CDN line does not apply here, and the pack's default of `color-scheme: light dark` does not apply to this
dark site (`Base.astro` and `global.css` declare `dark`). Failing gates print a `platform-currency guide:` line where a
guide covers the rule.

## Rules of the repo

- Surgical changes: touch what the task needs. No drive-by renames, reformatting or tidying.
- No emojis in code, comments or docs. No AI trailers in commits.
- Commits: `[<initials>] <type>(<scope>): <description>`, at most 50 characters, lowercase, imperative, no full stop.
  Branch per unit of work; never push to or merge into `main` without being asked.
