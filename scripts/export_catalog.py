#!/usr/bin/env python
"""export_catalog.py -- rehndrop site asset/catalog exporter.

Reads the READ-ONLY track catalog at D:/rehndrop/tracks (never writes there)
and the Apple lookup API, and produces:

  - src/data/catalog.json
  - src/data/apple-snapshot.json
  - src/assets/covers/<slug>.jpg
  - public/previews/<slug>.m4a
  - public/env/<slug>.json

Idempotent by default: an asset is only rebuilt if its output is missing or
older than the resolved source file. `--force` rebuilds everything that is
in scope. `--only <slug>[,<slug>...]` restricts the run to specific slugs;
everything else keeps whatever is already in catalog.json from a previous
run (a loud warning is printed if there is no previous catalog.json to
inherit from).

Usage:
    python export_catalog.py [--force] [--only slug1,slug2]
"""
from __future__ import annotations

import argparse
import colorsys
import json
import re
import shutil
import subprocess
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen, urlretrieve

import numpy as np
from PIL import Image

try:
    import yaml
    HAVE_YAML = True
except ImportError:
    HAVE_YAML = False

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------

TRACKS_DIR = Path("D:/rehndrop/tracks")
SITE_DIR = Path(__file__).resolve().parents[1]
CACHE_DIR = SITE_DIR / ".cache"
DATA_DIR = SITE_DIR / "src" / "data"
COVERS_DIR = SITE_DIR / "src" / "assets" / "covers"
PREVIEWS_DIR = SITE_DIR / "public" / "previews"
ENV_DIR = SITE_DIR / "public" / "env"
OVERRIDES_PATH = Path(__file__).resolve().parent / "preview-overrides.json"

STAMP_TOOL = Path("D:/rehndrop/resources/brand/tools/stamp-sigil.py")
ANALYZE_TOOL = Path("D:/rehndrop/tools/analyze-song.py")

MANIFEST_PATH = TRACKS_DIR / "once-manifest.json"
IG_PLAN_PATH = TRACKS_DIR / "ig-plan.json"

APPLE_ARTIST_ID = 1545317806
APPLE_LOOKUP_URL = (
    f"https://itunes.apple.com/lookup?id={APPLE_ARTIST_ID}&entity=song&limit=200"
)

ERA_2021_SLUGS = ("now-die", "dont-screw-with-me", "marauder")
EXCLUDED_SLUGS = {"drugs"}  # YouTube-only remix; the site handles it separately

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".m4a", ".aif", ".aiff"}
LOSSLESS_EXTS = {".flac", ".wav"}

PREVIEW_DURATION = 30.0
MIN_ROOM_AFTER_DROP = 24.0  # seconds of song that must follow the chosen drop
MAX_LEAD_IN = 10.5  # seconds; longer 4-bar lead-ins drop to 2 bars
ENV_RATE_HZ = 20
ENV_WIN_SAMPLES = 4410
ENV_HOP_SAMPLES = 2205  # 44100 / 20
ENV_FRAMES = 600  # 30s * 20Hz


# ---------------------------------------------------------------------------
# tiny fallback YAML reader (only used if PyYAML is unavailable)
# ---------------------------------------------------------------------------

def _fallback_load_yaml(text: str):
    raise RuntimeError(
        "PyYAML is not importable in this interpreter and export_catalog.py's "
        "built-in fallback parser does not cover rehndrop.track/1's nested "
        "lists-of-maps reliably enough to trust for a catalog export. "
        "Install/point at a Python with PyYAML, or extend _fallback_load_yaml."
    )


def load_yaml(path: Path):
    text = path.read_text(encoding="utf-8")
    if HAVE_YAML:
        return yaml.safe_load(text)
    return _fallback_load_yaml(text)


# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------

def log(msg: str):
    print(msg, file=sys.stderr)


def _mtime(p) -> float:
    try:
        return Path(p).stat().st_mtime
    except FileNotFoundError:
        return -1.0


def needs_rebuild(outputs, input_path, force: bool) -> bool:
    if force:
        return True
    if input_path is None:
        return not all(Path(o).exists() for o in outputs)
    in_mtime = _mtime(input_path)
    for o in outputs:
        op = Path(o)
        if not op.exists():
            return True
        if _mtime(op) < in_mtime:
            return True
    return False


def normalize_title(s: str) -> str:
    s = s.replace("\u2019", "'").replace("\u2018", "'")
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def artifacts_for(track_yaml: dict, part_key):
    arts = track_yaml.get("artifacts") or []
    if part_key is None:
        return [a for a in arts if not a.get("part")]
    return [a for a in arts if a.get("part") == part_key]


def run_subprocess(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ffmpeg_decode_wav(src_audio: Path, slug: str, force: bool) -> Path:
    wav_dir = CACHE_DIR / "wav"
    wav_dir.mkdir(parents=True, exist_ok=True)
    out = wav_dir / f"{slug}.wav"
    if needs_rebuild([out], src_audio, force):
        cmd = [
            "ffmpeg", "-y", "-i", str(src_audio),
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
            str(out),
        ]
        proc = run_subprocess(cmd)
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError(f"ffmpeg decode failed for {slug}: {proc.stderr[-800:]}")
    return out


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / w.getframerate()


# ---------------------------------------------------------------------------
# Apple lookup
# ---------------------------------------------------------------------------

def fetch_apple_snapshot():
    req = Request(APPLE_LOOKUP_URL, headers={"User-Agent": "rehndrop-export_catalog/1.0"})
    with urlopen(req, timeout=30) as r:
        data = json.load(r)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "apple-snapshot.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
    songs = [r for r in data.get("results", []) if r.get("wrapperType") == "track"]
    return songs


def match_apple(specs, apple_songs):
    by_norm = {}
    for song in apple_songs:
        key = normalize_title(song.get("trackName", ""))
        if key in by_norm:
            log(f"WARNING: two Apple songs normalize to the same title {key!r}: "
                f"{by_norm[key].get('trackName')!r} vs {song.get('trackName')!r}")
        by_norm[key] = song

    matched_keys = set()
    misses = []
    for spec in specs:
        key = normalize_title(spec["source_title"])
        song = by_norm.get(key)
        spec["apple"] = song
        if song is None:
            misses.append(spec["slug"])
        else:
            matched_keys.add(key)

    if misses:
        log("=" * 70)
        log(f"WARNING: {len(misses)} track(s) had NO Apple match: {misses}")
        log("=" * 70)

    unused = set(by_norm) - matched_keys
    if unused:
        log(f"NOTE: {len(unused)} Apple song(s) matched no local track: "
            f"{[by_norm[k]['trackName'] for k in unused]}")
    return specs


def apple_fields(song):
    if song is None:
        return dict(appleTrackId=None, appleTitle=None, released=None,
                     appleUrl=None, applePreview=None, artworkUrl100=None,
                     explicitness=None)
    url = song.get("trackViewUrl")
    if url:
        parts = urlsplit(url)
        q = [(k, v) for k, v in parse_qsl(parts.query) if k != "uo"]
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))
    released = song.get("releaseDate")
    released_date = released[:10] if released else None
    return dict(
        appleTrackId=song.get("trackId"),
        appleTitle=song.get("trackName"),
        released=released_date,
        appleUrl=url,
        applePreview=song.get("previewUrl"),
        artworkUrl100=song.get("artworkUrl100"),
        explicitness=song.get("trackExplicitness"),
    )


# ---------------------------------------------------------------------------
# Track spec enumeration
# ---------------------------------------------------------------------------

def build_track_specs():
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    ig_plan = json.loads(IG_PLAN_PATH.read_text(encoding="utf-8"))
    buckets = ig_plan.get("buckets", {})

    specs = []
    for rel in manifest["releases"]:
        slug = rel["dir"]
        if slug in EXCLUDED_SLUGS:
            continue
        track_dir = TRACKS_DIR / slug
        if "tracks" in rel:
            for sub in rel["tracks"]:
                is_detox = "detox" in sub["title"].lower()
                part = "detox" if is_detox else "disconnect"
                sub_slug = f"{slug}-detox" if is_detox else slug
                specs.append({
                    "slug": sub_slug,
                    "track_dir": track_dir,
                    "part": part,
                    "source_title": sub["title"],
                    "era": "current",
                    "subGenre": rel["sub_genre"],
                    "explicit": sub.get("explicit"),
                })
        else:
            specs.append({
                "slug": slug,
                "track_dir": track_dir,
                "part": None,
                "source_title": rel["title"],
                "era": "current",
                "subGenre": rel["sub_genre"],
                "explicit": rel.get("explicit"),
            })

    for slug in ERA_2021_SLUGS:
        track_dir = TRACKS_DIR / slug
        ty = load_yaml(track_dir / "track.yaml")
        specs.append({
            "slug": slug,
            "track_dir": track_dir,
            "part": None,
            "source_title": ty["title"],
            "era": "2021",
            "subGenre": None,
            "explicit": None,
        })

    return specs, buckets


def lane_for(spec, buckets):
    if spec["era"] == "2021":
        return "heavy"
    title = spec["source_title"]
    for lane_name, titles in buckets.items():
        if title in titles:
            return lane_name
    sg = spec["subGenre"]
    if sg == "Dubstep":
        return "heavy"
    if sg == "Future Bass":
        return "melodic"
    return None


def resolve_display_title(spec):
    if spec["era"] == "2021" or spec.get("part") == "detox":
        if spec.get("apple"):
            return spec["apple"]["trackName"]
        return spec["source_title"]
    return spec["source_title"]


def resolve_explicit(spec, af):
    if spec["explicit"] is not None:
        return bool(spec["explicit"])
    expl = af.get("explicitness")
    if expl is not None:
        return expl == "explicit"
    return False


# ---------------------------------------------------------------------------
# Audio source selection
# ---------------------------------------------------------------------------

def pick_audio_source(track_dir: Path, arts):
    by_role = {}
    for a in arts:
        by_role.setdefault(a["role"], []).append(a)

    def full(a):
        return track_dir / a["path"]

    if "release" in by_role:
        return full(by_role["release"][0]), "release"

    versions = [a for a in by_role.get("version", [])
                if Path(a["path"]).suffix.lower() in LOSSLESS_EXTS]
    if versions:
        versions = sorted(versions, key=lambda a: _mtime(full(a)), reverse=True)
        return full(versions[0]), "version"

    if "master" in by_role:
        return full(by_role["master"][0]), "master"

    audio_dir = track_dir / "audio"
    if audio_dir.exists():
        cands = sorted(p for p in audio_dir.rglob("*")
                        if p.is_file() and p.suffix.lower() in AUDIO_EXTS)
        if cands:
            return cands[0], "any"

    return None, None


# ---------------------------------------------------------------------------
# Cover pipeline
# ---------------------------------------------------------------------------

def square_crop(img: Image.Image) -> Image.Image:
    w, h = img.size
    if w == h:
        return img
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def run_stamp_sigil(copy_target: Path, notes: list):
    proc = run_subprocess([sys.executable, str(STAMP_TOOL), str(copy_target)])
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        return True
    if "REFUSING" in out:
        notes.append("cover: stamp-sigil refused (mark below 96px floor); "
                      "upscaled source to 3000x3000 with LANCZOS and retried")
        img = Image.open(copy_target).convert("RGB")
        img = img.resize((3000, 3000), Image.LANCZOS)
        img.info.clear()
        img.save(copy_target, "JPEG", quality=95, subsampling=0)
        proc2 = run_subprocess([sys.executable, str(STAMP_TOOL), str(copy_target)])
        if proc2.returncode != 0:
            notes.append(f"cover: stamp-sigil FAILED even after upscale: "
                          f"{(proc2.stdout or '') + (proc2.stderr or '')!r}")
            return False
        return True
    notes.append(f"cover: stamp-sigil FAILED: {out!r}")
    return False


def stamp_mark_path() -> Path:
    """The PNG stamp-sigil.py stamps with, read from the tool so the two never disagree."""
    m = re.search(r'MARK = os\.path\.join\(HERE, "\.\.", "02-logos", "sigil", "png", "([^"]+)"\)', STAMP_TOOL.read_text(encoding="utf-8"))
    if not m:
        raise RuntimeError("could not read MARK from stamp-sigil.py")
    return STAMP_TOOL.parent.parent / "02-logos" / "sigil" / "png" / m.group(1)


def resolve_cover_source(slug: str, track_dir: Path, arts, apple_artwork_url, force, notes):
    """Returns (image_path, coverStamped) for the sigil-ready / final-source image,
    doing any downloading/stamping needed along the way."""
    art_dir = track_dir / "art"

    # Every website cover is stamped here with the stamp tool's current mark, even when the
    # released art already carries an older stamp, so the site shows one consistent sigil.
    if slug == "whats-my-name":
        src = art_dir / "cover-4k.jpg"
        if src.exists():
            return src, False
        notes.append("whats-my-name: sanctioned art/cover-4k.jpg missing on disk")

    src_path = None
    for a in arts:
        if a.get("role") == "cover-source":
            cand = track_dir / a["path"]
            if cand.exists():
                src_path = cand
                break

    if src_path is None and art_dir.exists():
        globs = list(art_dir.glob("*4k*cover*.jpg")) + list(art_dir.glob("cover-4k*.jpg"))
        globs = sorted({p for p in globs if "sigil" not in p.name.lower()})
        if globs:
            src_path = globs[0]
        else:
            jpgs = [p for p in art_dir.glob("*.jpg") if "sigil" not in p.name.lower()]
            preferred = [p for p in jpgs if "3000" not in p.name and "release" not in p.name.lower()]
            cand_list = preferred or jpgs
            if cand_list:
                src_path = sorted(cand_list)[0]

    stamp_dir = CACHE_DIR / "stamp" / slug
    if src_path is None:
        if not apple_artwork_url:
            notes.append(f"COVER MISSING for {slug}: no local art and no Apple artwork URL")
            return None, None
        stamp_dir.mkdir(parents=True, exist_ok=True)
        dl_path = stamp_dir / "apple-artwork-3000.jpg"
        if force or not dl_path.exists():
            big_url = apple_artwork_url.replace("100x100bb", "3000x3000bb")
            urlretrieve(big_url, dl_path)
            notes.append(f"{slug}: no local art; downloaded Apple artwork as cover source")
        src_path = dl_path

    stamp_dir.mkdir(parents=True, exist_ok=True)
    copy_target = stamp_dir / "cover-4k.jpg"
    out_sigil = stamp_dir / "cover-4k-sigil.jpg"
    # a new mark must restamp, not just a new cover
    stale_mark = out_sigil.exists() and _mtime(stamp_mark_path()) > _mtime(out_sigil)
    if stale_mark or needs_rebuild([out_sigil], src_path, force):
        shutil.copyfile(src_path, copy_target)
        ok = run_stamp_sigil(copy_target, notes)
        if not ok:
            return None, None
    return out_sigil, True


def rgb_to_hsv_np(arr):
    """Vectorized port of colorsys.rgb_to_hsv for arrays shaped (..., 3) in [0,1]."""
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    maxc = arr.max(axis=-1)
    minc = arr.min(axis=-1)
    v = maxc
    delta = maxc - minc
    s = np.divide(delta, maxc, out=np.zeros_like(maxc), where=maxc != 0)
    safe_delta = np.where(delta == 0, 1.0, delta)
    rc = (maxc - r) / safe_delta
    gc = (maxc - g) / safe_delta
    bc = (maxc - b) / safe_delta
    h = np.zeros_like(r)
    h = np.where(maxc == r, bc - gc, h)
    h = np.where((maxc == g) & (maxc != r), 2.0 + rc - bc, h)
    h = np.where((maxc == b) & (maxc != r) & (maxc != g), 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0
    h = np.where(delta == 0, 0.0, h)
    return h, s, v


def weighted_kmeans(points, weights, k=5, seed=42, iters=50):
    rng = np.random.RandomState(seed)
    n = points.shape[0]
    wsum = weights.sum()
    p = (weights / wsum) if wsum > 0 else None
    init_idx = rng.choice(n, size=k, replace=False, p=p)
    centroids = points[init_idx].copy()
    assign = np.full(n, -1)
    for _ in range(iters):
        dists = ((points[:, None, :] - centroids[None, :, :]) ** 2).sum(axis=2)
        new_assign = dists.argmin(axis=1)
        if np.array_equal(new_assign, assign):
            break
        assign = new_assign
        for c in range(k):
            mask = assign == c
            if not mask.any():
                centroids[c] = points[np.argmax(weights)]
                continue
            w = weights[mask]
            wsum_c = w.sum()
            if wsum_c > 0:
                centroids[c] = (points[mask] * w[:, None]).sum(axis=0) / wsum_c
            else:
                centroids[c] = points[mask].mean(axis=0)
    return centroids, assign


def compute_accent(img_rgb: Image.Image) -> str:
    small = img_rgb.resize((64, 64), Image.LANCZOS)
    arr = np.asarray(small, dtype=np.float64) / 255.0
    flat = arr.reshape(-1, 3)
    _, s, v = rgb_to_hsv_np(arr)
    s_flat = s.reshape(-1)
    v_flat = v.reshape(-1)
    weights = s_flat * v_flat

    centroids, assign = weighted_kmeans(flat, weights, k=5, seed=42)
    n = flat.shape[0]
    best_score, best_c, best_sat = -1.0, None, 0.0
    for c in range(5):
        mask = assign == c
        if not mask.any():
            continue
        mean_s = float(s_flat[mask].mean())
        mean_v = float(v_flat[mask].mean())
        share = float(mask.sum()) / n
        score = mean_s * mean_v * share
        if score > best_score:
            best_score, best_c, best_sat = score, c, mean_s

    if best_c is None or best_sat < 0.18:
        return "#c9ced6"

    rgb = centroids[best_c].clip(0, 1)
    hh, ss, vv = colorsys.rgb_to_hsv(float(rgb[0]), float(rgb[1]), float(rgb[2]))
    vv = max(vv, 0.55)
    r, g, b = colorsys.hsv_to_rgb(hh, ss, vv)
    return "#%02x%02x%02x" % (round(r * 255), round(g * 255), round(b * 255))


def process_cover(slug, track_dir, arts, apple_artwork_url, force, notes):
    final_path = COVERS_DIR / f"{slug}.jpg"
    source_img, stamped = resolve_cover_source(slug, track_dir, arts, apple_artwork_url, force, notes)
    if source_img is None:
        return None, None, None

    if needs_rebuild([final_path], source_img, force):
        img = Image.open(source_img).convert("RGB")
        img = square_crop(img)
        img = img.resize((1600, 1600), Image.LANCZOS)
        img.info.clear()
        COVERS_DIR.mkdir(parents=True, exist_ok=True)
        img.save(final_path, "JPEG", quality=88, progressive=True)
    else:
        img = Image.open(final_path).convert("RGB")

    accent = compute_accent(img)
    return final_path, stamped, accent


# ---------------------------------------------------------------------------
# Analysis / preview / envelope pipeline
# ---------------------------------------------------------------------------

def get_analysis(slug, wav_path, track_dir, arts, force, notes):
    wav_dur = wav_duration(wav_path)

    analysis_arts = [a for a in arts if a.get("role") == "analysis"]
    if analysis_arts:
        cand = track_dir / analysis_arts[0]["path"]
        if cand.exists():
            try:
                data = json.loads(cand.read_text(encoding="utf-8"))
                if abs(data.get("duration", -999.0) - wav_dur) <= 0.5:
                    return data
                notes.append(
                    f"{slug}: cached track.yaml analysis duration "
                    f"{data.get('duration')}s vs release {wav_dur:.2f}s differ "
                    f">0.5s; re-running analyzer on the release WAV"
                )
            except Exception as e:
                notes.append(f"{slug}: failed to read cached analysis ({e}); re-running")

    out_dir = CACHE_DIR / "analysis" / slug
    out_json = out_dir / f"{slug}.analysis.json"
    if not force and out_json.exists():
        try:
            data = json.loads(out_json.read_text(encoding="utf-8"))
            if abs(data.get("duration", -999.0) - wav_dur) <= 0.5:
                return data
        except Exception:
            pass

    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(ANALYZE_TOOL), str(wav_path), "--out-dir", str(out_dir), "--no-md"]
    proc = run_subprocess(cmd)
    if proc.returncode != 0 or not out_json.exists():
        tail = (proc.stderr or proc.stdout or "")[-800:]
        notes.append(f"{slug}: ANALYZER FAILED, falling back to no-drop preview window: {tail!r}")
        return None

    return json.loads(out_json.read_text(encoding="utf-8"))


def compute_preview_window(analysis, wav_dur, override):
    if analysis is not None:
        duration = analysis["duration"]
        bar_seconds = analysis.get("bar_seconds")
    else:
        duration = wav_dur
        bar_seconds = None

    drops = sorted((analysis or {}).get("drops") or [], key=lambda d: d["rank"])
    # The analyzer's rank-1 drop is often the final drop, a few seconds before the outro.
    # A preview there plays the song's ending. Prefer the best drop that leaves room for
    # 20+ s of payoff; fall back to rank 1 only if no drop does.
    roomy = [d for d in drops if duration - d["time"] >= MIN_ROOM_AFTER_DROP]
    chosen = roomy[0] if roomy else (drops[0] if drops else None)

    if chosen:
        T = chosen["time"]
        B = bar_seconds
        # 4 bars of lead-in, or 2 when a half-time grid would make 4 bars drag past ~10 s
        lead = 4 * B if 4 * B <= MAX_LEAD_IN else 2 * B
        start = max(0.0, T - lead)
        if start + PREVIEW_DURATION > duration:
            start = max(0.0, duration - PREVIEW_DURATION)
    else:
        T = None
        start = round(0.30 * duration, 2)

    if override and "start" in override:
        start = float(override["start"])

    # dropAt is computed from the full-precision start (before it is rounded for
    # storage/encoding) so that T - start lands on the exact bar-aligned instant.
    if T is not None and start <= T <= start + PREVIEW_DURATION:
        drop_at = round(T - start, 3)
    else:
        drop_at = None

    start = round(start, 2)
    return start, drop_at, T, bar_seconds, duration


def encode_preview(wav_path: Path, start: float, slug: str, force: bool) -> Path:
    out = PREVIEWS_DIR / f"{slug}.m4a"
    # the window can change without the audio changing (overrides, selection rules), so the
    # start that was encoded is stamped and compared, not just the WAV's mtime
    stamp = CACHE_DIR / "preview-stamps" / f"{slug}.txt"
    want = f"{start:.3f}"
    stale = not stamp.exists() or stamp.read_text(encoding="utf-8").strip() != want
    if stale or needs_rebuild([out], wav_path, force) or _mtime(out) < 0:
        PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}", "-t", f"{PREVIEW_DURATION}", "-i", str(wav_path),
            "-af", "volume=-1dB,afade=t=in:st=0:d=0.25,afade=t=out:st=28:d=2",
            "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2",
            "-movflags", "+faststart",
            str(out),
        ]
        proc = run_subprocess(cmd)
        if proc.returncode != 0 or not out.exists():
            raise RuntimeError(f"ffmpeg encode failed for {slug}: {proc.stderr[-800:]}")
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(want, encoding="utf-8")
    return out


def read_wav_segment_mono(wav_path: Path, start: float, duration: float = PREVIEW_DURATION):
    with wave.open(str(wav_path), "rb") as w:
        sr = w.getframerate()
        n_ch = w.getnchannels()
        n_total = w.getnframes()
        start_frame = max(0, min(int(round(start * sr)), max(0, n_total - 1)))
        n_frames_needed = int(round(duration * sr))
        w.setpos(start_frame)
        raw = w.readframes(n_frames_needed)
    data = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if n_ch > 1:
        usable = (len(data) // n_ch) * n_ch
        data = data[:usable].reshape(-1, n_ch).mean(axis=1)
    target_n = int(round(duration * sr))
    if len(data) < target_n:
        data = np.pad(data, (0, target_n - len(data)))
    else:
        data = data[:target_n]
    return data, sr


def compute_envelope(segment: np.ndarray, sr: int):
    hop = ENV_HOP_SAMPLES
    win = ENV_WIN_SAMPLES
    half = win // 2
    padded = np.pad(segment, (half, half))
    hann = np.hanning(win)
    freqs = np.fft.rfftfreq(win, d=1.0 / sr)
    band = (freqs >= 20) & (freqs <= 150)
    eps = 1e-12

    energy = np.zeros(ENV_FRAMES)
    low = np.zeros(ENV_FRAMES)
    for i in range(ENV_FRAMES):
        center = i * hop + half
        frame = padded[center - half:center + half]
        if len(frame) < win:
            frame = np.pad(frame, (0, win - len(frame)))
        w = frame * hann
        rms = np.sqrt(np.mean(w ** 2) + eps)
        energy[i] = 20 * np.log10(rms + eps)
        spec = np.fft.rfft(w)
        power = np.abs(spec) ** 2
        low[i] = 10 * np.log10(power[band].sum() + eps)
    return energy, low


def normalize_quantize(curve: np.ndarray):
    p5 = np.percentile(curve, 5)
    p99 = np.percentile(curve, 99)
    if p99 - p5 < 1e-9:
        norm = np.zeros_like(curve)
    else:
        norm = (curve - p5) / (p99 - p5)
    norm = np.clip(norm, 0.0, 1.0)
    q = np.clip(np.round(norm * 255), 0, 255).astype(int).tolist()
    if len(q) < ENV_FRAMES:
        q = q + [q[-1] if q else 0] * (ENV_FRAMES - len(q))
    else:
        q = q[:ENV_FRAMES]
    return q


def write_env(slug, drop_at, energy_q, low_q):
    ENV_DIR.mkdir(parents=True, exist_ok=True)
    out = ENV_DIR / f"{slug}.json"
    doc = {"rate": ENV_RATE_HZ, "dropAt": drop_at, "energy": energy_q, "low": low_q}
    out.write_text(json.dumps(doc), encoding="utf-8")
    return out


# ---------------------------------------------------------------------------
# BPM
# ---------------------------------------------------------------------------

def resolve_bpm(track_yaml, analysis):
    bpm = (track_yaml.get("creative") or {}).get("bpm")
    if isinstance(bpm, (int, float)):
        return round(float(bpm), 1)
    if analysis:
        for key in ("grid_bpm", "detected_bpm"):
            v = analysis.get(key)
            if isinstance(v, (int, float)):
                return round(float(v), 1)
    return None


# ---------------------------------------------------------------------------
# Per-track processing
# ---------------------------------------------------------------------------

def process_track(spec, buckets, force, overrides, notes):
    slug = spec["slug"]
    track_dir = spec["track_dir"]
    part = spec["part"]
    ty = load_yaml(track_dir / "track.yaml")
    arts = artifacts_for(ty, part)

    af = apple_fields(spec.get("apple"))
    title = resolve_display_title(spec)
    lane = lane_for(spec, buckets)
    explicit = resolve_explicit(spec, af)

    cover_path, cover_stamped, accent = process_cover(
        slug, track_dir, arts, af.get("artworkUrl100"), force, notes
    )

    audio_src, audio_role = pick_audio_source(track_dir, arts)

    preview = {"src": None, "start": None, "duration": int(PREVIEW_DURATION), "dropAt": None, "env": None}
    bpm = None
    analysis = None

    if audio_src is not None:
        try:
            wav_path = ffmpeg_decode_wav(audio_src, slug, force)
            wav_dur = wav_duration(wav_path)
            analysis = get_analysis(slug, wav_path, track_dir, arts, force, notes)
            override = overrides.get(slug)
            start, drop_at, T, bar_seconds, duration = compute_preview_window(analysis, wav_dur, override)
            encode_preview(wav_path, start, slug, force)
            segment, sr = read_wav_segment_mono(wav_path, start, PREVIEW_DURATION)
            energy_db, low_db = compute_envelope(segment, sr)
            energy_q = normalize_quantize(energy_db)
            low_q = normalize_quantize(low_db)
            write_env(slug, drop_at, energy_q, low_q)
            preview = {
                "src": f"previews/{slug}.m4a",
                "start": start,
                "duration": int(PREVIEW_DURATION),
                "dropAt": drop_at,
                "env": f"env/{slug}.json",
            }
            bpm = resolve_bpm(ty, analysis)
            if not (analysis and analysis.get("drops")):
                notes.append(f"{slug}: no usable drop; preview falls back to 30% of track start")
        except Exception as e:
            notes.append(f"{slug}: AUDIO PIPELINE FAILED ({e}); preview/env left null")
            bpm = resolve_bpm(ty, None)
    else:
        notes.append(f"{slug}: no local audio found; preview.src=null, site falls back to applePreview")
        bpm = resolve_bpm(ty, None)

    entry = {
        "slug": slug,
        "title": title,
        "era": spec["era"],
        "lane": lane,
        "subGenre": spec["subGenre"],
        "bpm": bpm,
        "explicit": explicit,
        "appleTrackId": af["appleTrackId"],
        "appleTitle": af["appleTitle"],
        "released": af["released"],
        "appleUrl": af["appleUrl"],
        "applePreview": af["applePreview"],
        "cover": f"covers/{slug}.jpg" if cover_path else None,
        "coverStamped": cover_stamped,
        "accent": accent,
        "preview": preview,
    }
    if cover_path is None:
        notes.append(f"{slug}: COVER MISSING -- no cover produced")
    return entry


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true", help="redo everything, ignore caches")
    ap.add_argument("--only", default=None, help="comma-separated slug(s) to (re)process")
    args = ap.parse_args(argv)

    only_set = None
    if args.only:
        only_set = {s.strip() for s in args.only.split(",") if s.strip()}

    t0 = datetime.now()
    notes = []

    overrides = {}
    if OVERRIDES_PATH.exists():
        overrides = json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))

    log("Fetching Apple lookup snapshot...")
    apple_songs = fetch_apple_snapshot()
    log(f"  {len(apple_songs)} songs in Apple catalog for artist {APPLE_ARTIST_ID}")

    specs, buckets = build_track_specs()
    match_apple(specs, apple_songs)

    prev_catalog_path = DATA_DIR / "catalog.json"
    prev_by_slug = {}
    if prev_catalog_path.exists():
        try:
            prev = json.loads(prev_catalog_path.read_text(encoding="utf-8"))
            prev_by_slug = {t["slug"]: t for t in prev.get("tracks", [])}
        except Exception as e:
            log(f"WARNING: could not read previous catalog.json ({e})")

    if only_set and not prev_by_slug:
        log("WARNING: --only given but no previous catalog.json exists; "
            "catalog.json will only contain the --only slugs this run")

    scope = [s for s in specs if (only_set is None or s["slug"] in only_set)]
    skipped = [s["slug"] for s in specs if only_set is not None and s["slug"] not in only_set]

    tracks = []
    rows = []
    for spec in scope:
        slug = spec["slug"]
        log(f"-- {slug} " + "-" * max(1, 60 - len(slug)))
        entry = process_track(spec, buckets, args.force, overrides, notes)
        tracks.append(entry)
        rows.append(entry)

    for slug in skipped:
        if slug in prev_by_slug:
            tracks.append(prev_by_slug[slug])
        else:
            notes.append(f"{slug}: skipped by --only and no previous catalog entry; OMITTED this run")

    # Stable two-pass sort: title ascending (secondary), then released descending with
    # nulls last (reverse=True on "" sorts it after every real date, since "" < any date).
    tracks.sort(key=lambda t: t["title"])
    tracks.sort(key=lambda t: t["released"] or "", reverse=True)

    catalog = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "appleArtistId": APPLE_ARTIST_ID,
        "tracks": tracks,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "catalog.json").write_text(json.dumps(catalog, indent=2), encoding="utf-8")

    elapsed = (datetime.now() - t0).total_seconds()

    print()
    print(f"catalog.json written: {len(tracks)} tracks ({len(scope)} processed this run, "
          f"{len(skipped)} inherited from previous run)")
    print(f"runtime: {elapsed:.1f}s")
    print()
    header = f"{'slug':<28}{'era':<9}{'lane':<9}{'bpm':<8}{'expl':<6}{'apple':<7}{'cover':<10}{'preview':<9}{'dropAt':<8}"
    print(header)
    print("-" * len(header))
    for t in sorted(rows, key=lambda t: t["slug"]):
        apple_ok = "yes" if t["appleTrackId"] else "MISS"
        cover_s = "MISSING" if not t["cover"] else ("sigil" if t["coverStamped"] else "plain")
        prev_s = "none" if not t["preview"]["src"] else f"{t['preview']['duration']:.0f}s"
        drop_s = "-" if t["preview"]["dropAt"] is None else f"{t['preview']['dropAt']:.2f}"
        bpm_s = "-" if t["bpm"] is None else f"{t['bpm']:.1f}"
        print(f"{t['slug']:<28}{t['era']:<9}{str(t['lane']):<9}{bpm_s:<8}"
              f"{str(t['explicit']):<6}{apple_ok:<7}{cover_s:<10}{prev_s:<9}{drop_s:<8}")

    if notes:
        print()
        print("NOTES / FALLBACKS:")
        for n in notes:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
