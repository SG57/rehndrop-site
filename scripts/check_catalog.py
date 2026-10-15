#!/usr/bin/env python
"""check_catalog.py -- verifier for export_catalog.py's outputs.

Exits 1 on any CONTRACT VIOLATION (hard failure). A handful of checks the
spec explicitly calls "warnings" (missing Apple ids, an envelope that does
not rise into its drop) are printed loudly but do not fail the run on their
own.

Usage:
    python check_catalog.py
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

SITE_DIR = Path(__file__).resolve().parents[1]
TRACKS_DIR = Path("D:/rehndrop/tracks")
DATA_DIR = SITE_DIR / "src" / "data"
COVERS_DIR = SITE_DIR / "src" / "assets" / "covers"
PUBLIC_DIR = SITE_DIR / "public"
ANALYSIS_CACHE = SITE_DIR / ".cache" / "analysis"

MANIFEST_PATH = TRACKS_DIR / "once-manifest.json"
ERA_2021_SLUGS = ("now-die", "dont-screw-with-me", "marauder", "drugs")
NOT_ON_APPLE = {"drugs"}  # released on SoundCloud and YouTube only
EXCLUDED_SLUGS = {"drugs"}

failures = []
warnings = []


def fail(msg):
    failures.append(msg)
    print(f"FAIL: {msg}")


def warn(msg):
    warnings.append(msg)
    print(f"WARN: {msg}")


def ok(msg):
    print(f"ok:   {msg}")


def ffprobe_duration(path: Path):
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return None
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


def bar_seconds_for(track):
    """Best-effort bar_seconds for the human sanity print: prefer the exact value
    from the cached analysis JSON, else approximate from bpm (240 / bpm)."""
    slug = track["slug"]
    cand = ANALYSIS_CACHE / slug / f"{slug}.analysis.json"
    if cand.exists():
        try:
            data = json.loads(cand.read_text(encoding="utf-8"))
            if "bar_seconds" in data:
                return data["bar_seconds"], "exact (cached analysis)"
        except Exception:
            pass
    bpm = track.get("bpm")
    if bpm:
        return 240.0 / bpm, "approx (240/bpm)"
    return None, None


def main():
    catalog_path = DATA_DIR / "catalog.json"
    if not catalog_path.exists():
        print(f"FAIL: {catalog_path} does not exist")
        return 1

    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    tracks = catalog.get("tracks", [])

    # --- expected count -----------------------------------------------
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    manifest_releases = [r for r in manifest["releases"] if r["dir"] not in EXCLUDED_SLUGS]
    disconnect_release = next((r for r in manifest_releases if "tracks" in r), None)
    base_count = len(manifest_releases) + len(ERA_2021_SLUGS)
    detox_emitted = any(t["slug"] == "disconnect-detox" for t in tracks)
    expected = base_count + (1 if detox_emitted else 0)

    print(f"-- track count -------------------------------------------------")
    print(f"manifest releases: {len(manifest_releases)} (incl. 'disconnect' as one release "
          f"with {len(disconnect_release['tracks']) if disconnect_release else 0} sub-tracks)")
    print(f"2021-era tracks:    {len(ERA_2021_SLUGS)} ({', '.join(ERA_2021_SLUGS)})")
    print(f"disconnect-detox emitted as an extra entry: {detox_emitted}")
    print(f"expected total = {len(manifest_releases)} + {len(ERA_2021_SLUGS)} "
          f"{'+ 1 (disconnect-detox)' if detox_emitted else ''} = {expected}")
    print(f"actual total in catalog.json = {len(tracks)}")
    if len(tracks) != expected:
        fail(f"track count {len(tracks)} != expected {expected}")
    else:
        ok(f"track count matches expected {expected}")
    print()

    # --- unique slugs ----------------------------------------------------
    print("-- unique slugs --------------------------------------------------")
    slugs = [t["slug"] for t in tracks]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    if dupes:
        fail(f"duplicate slugs: {dupes}")
    else:
        ok(f"all {len(slugs)} slugs unique")
    print()

    # --- covers ------------------------------------------------------
    print("-- covers ---------------------------------------------------------")
    for t in tracks:
        slug = t["slug"]
        cover_rel = t.get("cover")
        if not cover_rel:
            fail(f"{slug}: cover is null")
            continue
        p = SITE_DIR / "src" / "assets" / cover_rel
        if not p.exists():
            fail(f"{slug}: cover file missing at {p}")
            continue
        try:
            with Image.open(p) as img:
                img.load()
                if img.size != (1600, 1600):
                    fail(f"{slug}: cover is {img.size}, expected (1600, 1600)")
                elif img.format != "JPEG":
                    fail(f"{slug}: cover format is {img.format}, expected JPEG")
                else:
                    ok(f"{slug}: cover 1600x1600 JPEG")
        except Exception as e:
            fail(f"{slug}: cover unreadable ({e})")
    print()

    # --- previews ------------------------------------------------------
    print("-- previews (ffprobe duration) -------------------------------------")
    for t in tracks:
        slug = t["slug"]
        src = t["preview"].get("src")
        if src is None:
            ok(f"{slug}: preview.src is null (no local audio; site falls back to applePreview)")
            continue
        p = PUBLIC_DIR / src
        if not p.exists():
            fail(f"{slug}: preview file missing at {p}")
            continue
        dur = ffprobe_duration(p)
        if dur is None:
            fail(f"{slug}: ffprobe could not read duration of {p}")
        elif not (29.9 <= dur <= 30.1):
            fail(f"{slug}: preview duration {dur:.3f}s outside 29.9-30.1s")
        else:
            ok(f"{slug}: preview duration {dur:.3f}s")
    print()

    # --- envelopes -------------------------------------------------------
    print("-- envelopes --------------------------------------------------------")
    env_cache = {}
    for t in tracks:
        slug = t["slug"]
        env_rel = t["preview"].get("env")
        if env_rel is None:
            ok(f"{slug}: env is null (no local audio)")
            continue
        p = PUBLIC_DIR / env_rel
        if not p.exists():
            fail(f"{slug}: env file missing at {p}")
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            fail(f"{slug}: env file unreadable ({e})")
            continue
        env_cache[slug] = data
        problems = []
        for key in ("energy", "low"):
            arr = data.get(key)
            if not isinstance(arr, list) or len(arr) != 600:
                problems.append(f"{key} length {len(arr) if isinstance(arr, list) else 'n/a'} != 600")
                continue
            if not all(isinstance(v, int) and 0 <= v <= 255 for v in arr):
                problems.append(f"{key} has values outside int 0-255")
        if problems:
            fail(f"{slug}: env problems: {'; '.join(problems)}")
        else:
            ok(f"{slug}: env energy/low both 600 ints in [0,255]")
    print()

    # --- dropAt bounds + 4-bar lead-in sanity print -----------------------
    print("-- dropAt bounds and 4-bar lead-in --------------------------------")
    print(f"{'slug':<28}{'dropAt':<10}{'4*bar_sec':<12}{'bar_sec source'}")
    for t in tracks:
        slug = t["slug"]
        drop_at = t["preview"].get("dropAt")
        if drop_at is None:
            continue
        if not (0 <= drop_at <= 30):
            fail(f"{slug}: dropAt {drop_at} outside [0,30]")
            continue
        bar_sec, source = bar_seconds_for(t)
        lead = 4 * bar_sec if bar_sec else None
        lead_s = f"{lead:.3f}" if lead is not None else "?"
        print(f"{slug:<28}{drop_at:<10.3f}{lead_s:<12}{source or ''}")
    print()

    # --- apple ids ----------------------------------------------------
    print("-- apple ids --------------------------------------------------------")
    misses = [t["slug"] for t in tracks if not t.get("appleTrackId") and t["slug"] not in NOT_ON_APPLE]
    if misses:
        warn(f"{len(misses)} track(s) with no appleTrackId: {misses}")
    else:
        ok(f"all {len(tracks)} tracks have a non-null appleTrackId")
    print()

    # --- title casing --------------------------------------------------
    print("-- title casing (current era must be lowercase) ---------------------")
    bad_case = [t["slug"] for t in tracks if t["era"] == "current" and t["title"] != t["title"].lower()]
    if bad_case:
        fail(f"current-era titles not lowercase: {bad_case}")
    else:
        ok("all current-era titles are lowercase")
    print()

    # --- envelope rises near dropAt --------------------------------------
    print("-- envelope 'low' rises near dropAt (sync spot-check) ----------------")
    for t in tracks:
        slug = t["slug"]
        drop_at = t["preview"].get("dropAt")
        if drop_at is None or slug not in env_cache:
            continue
        data = env_cache[slug]
        rate = data["rate"]
        low = data["low"]
        idx = int(round(drop_at * rate))
        window = int(round(2 * rate))
        before = low[max(0, idx - window):idx]
        after = low[idx:min(len(low), idx + window)]
        if not before or not after:
            warn(f"{slug}: not enough samples around dropAt to spot-check")
            continue
        mean_before = sum(before) / len(before)
        mean_after = sum(after) / len(after)
        verdict = "OK (rises)" if mean_after > mean_before else "FLAG (does not rise)"
        print(f"{slug:<28}before={mean_before:7.2f}  after={mean_after:7.2f}  {verdict}")
        if mean_after <= mean_before:
            warn(f"{slug}: low-band mean does not rise across dropAt "
                 f"(before={mean_before:.2f}, after={mean_after:.2f})")
    print()

    print("=" * 70)
    print(f"{len(failures)} failure(s), {len(warnings)} warning(s)")
    if failures:
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
