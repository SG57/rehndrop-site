#!/usr/bin/env python
"""Export posted Instagram reels for the site's reel posters (each links out to its post).

    python scripts/export_reels.py            # idempotent; --force re-encodes

Source of truth: D:/rehndrop/tracks/ig-ledger.json "posted" (maintained by ig_stage.py), read
only. For each post it finds the exact video that was published:
  1. <item>-published.mp4 in the track's video/social/ (ig_stage files it there when settling), else
  2. the track's ig-post video that CONTAINS the published cover frame (<item>-cover.jpg),
     measured, so a track with several reel cuts still resolves to the right one.
Writes a 540x960 web cut to public/reels/<item>.mp4, the cover as the poster to
src/assets/reels/<item>.jpg, and src/data/reels.json. Only the newest KEEP reels are hosted;
older posts stay in reels.json as links to Instagram, so the site never grows without limit.
The pages no longer play the web cuts; they show the poster and link to Instagram.
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import yaml
from PIL import Image

TRACKS = Path("D:/rehndrop/tracks")
SITE = Path(__file__).resolve().parent.parent
OUT_VIDEO = SITE / "public" / "reels"
OUT_POSTER = SITE / "src" / "assets" / "reels"
OUT_DATA = SITE / "src" / "data" / "reels.json"
CATALOG = SITE / "src" / "data" / "catalog.json"
KEEP = 12


def norm(s: str) -> str:
    s = s.lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", "", s)).strip()


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {r.stderr[-600:]}")
    return r


def cover_match_error(video: Path, cover: Path) -> float:
    """Lowest mean squared error between the cover and any frame (6 fps, 90x160 grey)."""
    target = np.asarray(Image.open(cover).convert("L").resize((90, 160)), dtype=np.float32)
    with tempfile.TemporaryDirectory() as tmp:
        run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", "fps=6,scale=90:160", f"{tmp}/f%05d.png"])
        return min(float(np.mean((np.asarray(Image.open(f).convert("L"), dtype=np.float32) - target) ** 2))
                   for f in sorted(Path(tmp).glob("*.png")))


def resolve_video(item: str, track_dir: Path):
    social = track_dir / "video" / "social"
    published = social / f"{item}-published.mp4"
    if published.is_file():
        return published, "published copy"
    y = yaml.safe_load((track_dir / "track.yaml").read_text(encoding="utf-8"))
    vids = [track_dir / a["path"] for a in y.get("artifacts", [])
            if a.get("role") == "ig-post" and a["path"].endswith(".mp4") and (track_dir / a["path"]).is_file()]
    cover = social / f"{item}-cover.jpg"
    if len(vids) == 1:
        return vids[0], "only reel video in the track"
    if vids and cover.is_file():
        scored = sorted((cover_match_error(v, cover), v) for v in vids)
        best_err, best = scored[0]
        if best_err > 60:
            raise RuntimeError(f"{item}: no candidate contains the published cover (best mse {best_err:.0f})")
        return best, f"contains the published cover frame (mse {best_err:.1f})"
    raise RuntimeError(f"{item}: cannot tell which video was published ({len(vids)} candidates, cover {'found' if cover.is_file() else 'missing'})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ledger = json.loads((TRACKS / "ig-ledger.json").read_text(encoding="utf-8"))
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))["tracks"]
    by_title = {norm(t["title"]): t["slug"] for t in catalog}
    posts = sorted(ledger.get("posted", {}).items(), key=lambda kv: kv[1].get("posted_at") or "", reverse=True)

    OUT_VIDEO.mkdir(parents=True, exist_ok=True)
    OUT_POSTER.mkdir(parents=True, exist_ok=True)
    reels, problems = [], []
    for i, (item, p) in enumerate(posts):
        slug = by_title.get(norm(p.get("track", "")))
        url = re.sub(r"\?.*$", "", p.get("post_url") or "")
        if not slug or not url:
            problems.append(f"{item}: track '{p.get('track')}' not in the catalog or no post_url; skipped")
            continue
        entry = {"id": item, "track": slug, "title": p["track"], "url": url,
                 "postedAt": (p.get("posted_at") or "")[:10], "angle": p.get("angle"), "video": None, "poster": None}
        track_dir = TRACKS / slug
        cover = track_dir / "video" / "social" / f"{item}-cover.jpg"
        if cover.is_file():
            poster = OUT_POSTER / f"{item}.jpg"
            if args.force or not poster.exists() or poster.stat().st_mtime < cover.stat().st_mtime:
                Image.open(cover).convert("RGB").resize((720, 1280), Image.LANCZOS).save(poster, quality=84, progressive=True, optimize=True, comment=b"")  # no encoder comment carried over from the cover
            entry["poster"] = f"reels/{item}.jpg"
        if i < KEEP:
            try:
                src, why = resolve_video(item, track_dir)
                out = OUT_VIDEO / f"{item}.mp4"
                if args.force or not out.exists() or out.stat().st_mtime < src.stat().st_mtime:
                    run(["ffmpeg", "-v", "error", "-y", "-i", str(src),
                         "-vf", "scale=540:960:flags=lanczos,format=yuv420p",
                         "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-maxrate", "1.8M", "-bufsize", "3.6M",
                         "-c:a", "aac", "-b:a", "112k", "-ar", "44100", "-movflags", "+faststart", str(out)])
                entry["video"] = f"reels/{item}.mp4"
                print(f"{item:<34} {slug:<18} {out.stat().st_size / 1e6:5.1f} MB  <- {src.name} ({why})")
            except RuntimeError as e:
                problems.append(str(e))
        else:
            stale = OUT_VIDEO / f"{item}.mp4"
            if stale.exists():
                stale.unlink()
            print(f"{item:<34} {slug:<18} link only (older than the newest {KEEP})")
        reels.append(entry)

    OUT_DATA.write_text(json.dumps({"_note": "Generated by scripts/export_reels.py from ig-ledger.json. Do not edit.", "reels": reels},
                                   indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for pr in problems:
        print("  !", pr)
    print(f"{len(reels)} reels written to {OUT_DATA.relative_to(SITE)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
