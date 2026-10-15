#!/usr/bin/env python
"""Independent proof that every preview is what it claims to be.

    python scripts/verify_previews.py

Shares no code with export_catalog.py on purpose. For every track it decodes the finished preview
and, separately, the track's own audio straight from D:/rehndrop/tracks/<slug> (not the exporter's
cache), then proves:
  1. IDENTITY: each teaser in the clip cross-correlates with ITS OWN song at the claimed time
     (high correlation, near-zero lag), and NOT with other songs at the same time (a wrong song
     stitched in, or teasers swapped, fails here).
  2. HITS: every hit in the clip maps back to song time within 0.41 s of the hit Cord gave
     (snapping moves at most 0.4 s), and none were lost.
  3. LENGTH: the clip is as long as its teasers add up to.
  4. ENVELOPE: the loudness envelope the visuals run on was measured from this exact audio.
Exit 1 on any failure.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import yaml

SITE = Path(__file__).resolve().parent.parent
TRACKS = Path("D:/rehndrop/tracks")
SR = 11025
XF = 0.5  # documented crossfade between teasers
WIN = 30.0


def decode(path: Path, start: float | None = None, dur: float | None = None) -> np.ndarray:
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, start):.3f}"]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype="<f4").astype(np.float64)


def source_audio(slug: str) -> Path:
    """The song's own audio, resolved from its track folder independently of the exporter."""
    folder = TRACKS / ("disconnect" if slug == "disconnect-detox" else slug)
    y = yaml.safe_load((folder / "track.yaml").read_text(encoding="utf-8"))
    arts = y.get("artifacts", [])
    # a multi-song release labels each song's files with a part: take exactly this song's part
    parts = {a.get("part") for a in arts if a.get("part")}
    if parts:
        want = "detox" if slug == "disconnect-detox" else slug
        if want not in parts:
            raise RuntimeError(f"{slug}: no audio part named {want!r} among {sorted(parts)}")
        arts = [a for a in arts if a.get("part") == want]
    for role in ("release", "version", "master"):
        for a in arts:
            if a.get("role") == role and str(a["path"]).lower().endswith((".flac", ".wav", ".mp3")):
                if (folder / a["path"]).is_file():
                    return folder / a["path"]
    audio = sorted(p for p in (folder / "audio").rglob("*") if p.suffix.lower() in (".flac", ".wav", ".mp3"))
    return audio[0]


def best_corr(probe: np.ndarray, region: np.ndarray):
    """Max normalised cross-correlation of probe inside region, and its lag in samples."""
    n = len(probe)
    probe = (probe - probe.mean()) / (probe.std() + 1e-12)
    size = 1 << int(np.ceil(np.log2(len(region) + n)))
    c = np.fft.irfft(np.fft.rfft(region, size) * np.conj(np.fft.rfft(probe, size)), size)[: len(region) - n + 1]
    csum = np.concatenate([[0], np.cumsum(region)])
    csq = np.concatenate([[0], np.cumsum(region ** 2)])
    win_sum = csum[n:] - csum[:-n]
    win_sq = csq[n:] - csq[:-n]
    std = np.sqrt(np.maximum(win_sq / n - (win_sum / n) ** 2, 1e-12))
    norm = c / (n * std)
    i = int(np.argmax(norm))
    return float(norm[i]), i


def envelope_matches(clip: np.ndarray, env_path: Path):
    """The visuals' envelope must be measured from THIS audio: re-measure loudness from the
    decoded clip and require it to track the shipped envelope, aligned (stale audio fails)."""
    env = json.loads(env_path.read_text(encoding="utf-8"))
    rate, shipped = env["rate"], np.asarray(env["energy"], dtype=np.float64)
    hop, win = SR // rate, SR // 10
    padded = np.pad(clip, (win // 2, win // 2 + win))
    hann = np.hanning(win)
    db = np.array([20 * np.log10(np.sqrt(np.mean((padded[i * hop: i * hop + win] * hann) ** 2)) + 1e-9)
                   for i in range(len(shipped))])
    # loudness in dB scaled to its own 5th-99th percentile: the shape, not the level
    lo, hi = np.percentile(db, 5), np.percentile(db, 99)
    mine = np.clip((db - lo) / max(hi - lo, 1e-9), 0, 1)

    def corr_at(lag):
        a, b = (mine[lag:], shipped[: len(shipped) - lag]) if lag >= 0 else (mine[:lag], shipped[-lag:])
        return float(np.corrcoef(a, b)[0, 1])

    # calibrated on all 29 previews: own envelope at zero offset 0.79-1.00; the same envelope
    # shifted 0.15-3 s at most 0.80; another track's envelope at most 0.52
    own = max(corr_at(lag) for lag in (-1, 0, 1))
    shifted = max(corr_at(lag) for lag in [*range(-60, -2), *range(3, 61)])
    return own >= 0.7 and own >= shifted + 0.1, f"own {own:.2f}, best shifted {shifted:.2f}"


def segments_of(slug, preview, override):
    """[(song_start, clip_offset, given_hits)] in play order, from the override (or catalog)."""
    if override and override.get("segments"):
        segs = [(float(g["start"]), [float(h) for h in g.get("hits", [])]) for g in override["segments"]]
    elif override:
        hits = override.get("hits") or ([override["hit"]] if override.get("hit") is not None else [])
        segs = [(float(override["start"]), [float(h) for h in hits])]
    else:
        segs = [(float(preview["start"]), [])]
    turns = preview.get("turns") or []
    offsets = [0.0] + [t - XF / 2 for t in turns]
    return [(s, offsets[k], hits) for k, (s, hits) in enumerate(segs)]


def main() -> int:
    cat = json.loads((SITE / "src/data/catalog.json").read_text(encoding="utf-8"))["tracks"]
    overrides = json.loads((SITE / "scripts/preview-overrides.json").read_text(encoding="utf-8"))
    sources = {t["slug"]: source_audio(t["slug"]) for t in cat if t["preview"].get("src")}
    failures = []
    print(f"{'track':<26}{'teaser':<8}{'song@':<9}{'own corr':<10}{'lag ms':<8}{'best other':<14}{'hits ok':<9}length")
    only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None
    for t in cat:
        slug, pv = t["slug"], t["preview"]
        if not pv.get("src") or not pv["src"].startswith("previews/") or (only and slug not in only):
            continue
        clip = decode(SITE / "public" / pv["src"])
        clip_dur = len(clip) / SR
        segs = segments_of(slug, pv, overrides.get(slug))
        if len(segs) != len(pv.get("turns") or []) + 1:
            failures.append(f"{slug}: {len(segs)} teasers specified but {len(pv.get('turns') or []) + 1} in the clip")
        # length: the last teaser is a full window (or the song's end), so the clip ends 30 s after it begins
        song_len = len(decode(sources[slug])) / SR
        last_start, last_off, _ = segs[-1]
        expect = last_off + min(WIN, song_len - last_start)
        length_ok = abs(clip_dur - expect) < 0.12
        if not length_ok:
            failures.append(f"{slug}: clip {clip_dur:.2f}s, teasers add up to {expect:.2f}s")
        env_ok, env_note = envelope_matches(clip, SITE / "public" / pv["env"]) if pv.get("env") else (False, "no env")
        if not env_ok:
            failures.append(f"{slug}: envelope does not belong to this audio ({env_note})")
        clip_hits = list(pv.get("hits") or [])
        for k, (song_start, off, given) in enumerate(segs):
            # a 6 s probe from the middle of this teaser, clear of fades and crossfades
            p0 = off + 2.0
            probe = clip[int(p0 * SR): int((p0 + 6.0) * SR)]
            own = decode(sources[slug], song_start + 2.0 - 1.0, 8.0)
            corr, lag_i = best_corr(probe, own)
            lag_ms = (lag_i / SR - 1.0) * 1000
            others = []
            for other, src in sources.items():
                if other == slug or other == "disconnect-detox" and slug == "disconnect" or other == "disconnect" and slug == "disconnect-detox":
                    continue
                region = decode(src, song_start + 2.0 - 1.0, 8.0)
                if len(region) > len(probe):
                    others.append((best_corr(probe, region)[0], other))
            worst_other = max(others) if others else (0.0, "-")
            # hits: map this teaser's clip hits back to song time and match Cord's
            span_end = (segs[k + 1][1] + XF) if k + 1 < len(segs) else clip_dur
            mine = [song_start + (h - off) for h in clip_hits if off <= h < span_end]
            hits_ok = len(mine) == len(given) and all(abs(m - g) <= 0.41 for m, g in zip(sorted(mine), sorted(given))) if given else True
            ok = corr > 0.8 and abs(lag_ms) < 60 and worst_other[0] < 0.5 and hits_ok
            if not ok:
                failures.append(f"{slug} teaser {k + 1}: corr {corr:.2f} lag {lag_ms:.0f}ms other {worst_other[1]} {worst_other[0]:.2f} "
                                f"hits {['%.2f' % m for m in mine]} vs given {given}")
            mm = f"{int(song_start // 60)}:{song_start % 60:04.1f}"
            print(f"{slug[:25]:<26}{k + 1:<8}{mm:<9}{corr:<10.3f}{lag_ms:<8.0f}{worst_other[1][:9] + ' %.2f' % worst_other[0]:<14}"
                  f"{('yes ' + str(len(mine))) if hits_ok else 'NO':<9}{'ok' if length_ok else 'BAD'} {clip_dur:.2f}s")
    print()
    for f in failures:
        print("FAIL", f)
    print("ALL PREVIEWS PROVEN" if not failures else f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
