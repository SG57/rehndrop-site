# Rooms

Every current track uses one of three painted looks, called rooms: `candle`, `chrome` or `dawn`.
The room sets the track's colours, glass and corner shape wherever the track shows up, and which painting the page swells toward while it plays.

## Set a track's room

Open `src/data/curation.json` and find the `room` map. Each line is `"track-slug": "room"`.
Change the value, save, rebuild. Use the slug exactly as it appears in `catalog.json`.

```json
"room": {
  "wild-beauty": "dawn",
  "pop-the-trunk": "candle",
  "wobble": "chrome"
}
```

Allowed values: `candle`, `chrome`, `dawn`. Anything else is ignored with a warning.

## The default rule

A track with no entry gets a room by this rule, and the build warns about it:

1. It is on the `detox` shelf: `candle`.
2. Its lane is `melodic`, or it has no lane: `dawn`.
3. Anything else: `chrome`.

The `room` map in `curation.json` was filled in from this rule for every current track, so you edit values rather than create them.
A new release that is live but not yet in the map still works: it takes the default and shows up in the warnings.

## 2021 tracks

Tracks with `era: "2021"` have no room (`room` is `null`) and use the plain default look. Do not add them to the map; the check flags it.

## Checking

- `node scripts/check_rooms.mjs` prints a warning for every current track without a valid pick.
- `ROOMS_STRICT=1 node scripts/check_rooms.mjs` fails instead (exit code 1). Use it before a release.
- The build prints the same warnings as `[rooms]` lines and exposes them as `data.roomWarnings` in `src/lib/data.ts`.
- `Track.room` is `'candle' | 'chrome' | 'dawn' | null`.
