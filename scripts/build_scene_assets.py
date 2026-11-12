"""Build the scene plates and packed masks in public/scene from private source images.

    python scripts/build_scene_assets.py --src <dir> [--paint <dir>] [--out public/scene] [--check]

Inputs (paths are arguments; nothing here reads a fixed private location):
  --src    folder with one plate per essence and orientation:
             <essence>.<ext>      landscape (3:2)      e.g. candle.jpg
             <essence>-p.<ext>    portrait  (2:3)      e.g. candle-p.png
           ext may be png, jpg, jpeg or webp. A missing orientation is skipped, not faked.
  --paint  optional folder with painted single-channel masks (white on black), per plate:
             <essence>[-p]-flame.png   candle and lamp flicker  -> R
             <essence>[-p]-sway.png    drapes, petals, ribbons  -> G
             <essence>[-p]-glint.png   specular glints          -> B
           Any channel without a painted file is derived from the plate by image analysis.
  --out    destination (default public/scene).
  --landscape-plates  also re-encode the landscape plates. Off by default: shipped landscape
           plates are kept byte for byte, only their masks are rebuilt.

Outputs: room-<e>.webp (only with --landscape-plates), room-<e>-p.webp (896x1344),
mask-<e>.png (672x448) and mask-<e>-p.png (448x672). RGB mask: R flicker, G sway, B glints.
Plates are re-encoded from pixels (no metadata) under a 120 KB budget, masks under 100 KB.
--check only reports sizes and the metadata state of what already sits in --out.

Needs Python 3 with Pillow, numpy and scipy.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ESSENCES = ("candle", "chrome", "dawn")
EXTS = (".png", ".jpg", ".jpeg", ".webp")
PLATE_BUDGET = 120 * 1024
MASK_BUDGET = 100 * 1024
SIZES = {"l": ((1344, 896), (672, 448)), "p": ((896, 1344), (448, 672))}  # plate, mask (w, h)


def find(folder: Path, stem: str) -> Path | None:
    for ext in EXTS:
        p = folder / f"{stem}{ext}"
        if p.exists():
            return p
    return None


def smooth01(a: np.ndarray, sigma: float) -> np.ndarray:
    return np.clip(ndi.gaussian_filter(a.astype(np.float32), sigma), 0, 1)


def norm(a: np.ndarray, lo_pct: float = 50, hi_pct: float = 99.7) -> np.ndarray:
    lo, hi = np.percentile(a, lo_pct), np.percentile(a, hi_pct)
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)


def features(rgb: np.ndarray):
    """rgb float 0..1 (h, w, 3) at mask resolution."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    return r, g, b, lum, sat


def edge_weight(h: int, w: int) -> np.ndarray:
    """1 near the left, right and top edges, 0 in the calm centre (UI sits there)."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = np.minimum(x, w - 1 - x) / (w * 0.5)
    dy = y / (h * 0.5)
    d = np.minimum(dx * 1.4, dy)
    return np.clip(1.15 - d * 1.6, 0, 1)


def blobs(core: np.ndarray, min_px: int) -> np.ndarray:
    lab, n = ndi.label(core)
    if n == 0:
        return core
    sizes = ndi.sum(core, lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= min_px])
    return keep


def dawn_bloom(lum: np.ndarray, sat: np.ndarray) -> np.ndarray:
    """The hero flower: a large bright body that survives a heavy opening. Thin ribbons do not."""
    body = ndi.binary_opening((lum > 0.5) & (sat > 0.2), structure=np.ones((3, 3)), iterations=7)
    return smooth01(ndi.binary_dilation(body, iterations=6), 4)


def derive_flame(e: str, rgb: np.ndarray) -> np.ndarray:
    r, g, b, lum, sat = features(rgb)
    warm = (r - b) > 0.18
    if e == "candle":
        core = (lum > 0.72) & warm
    elif e == "chrome":  # sodium lamps on wet metal
        core = (lum > 0.42) & (r - b > 0.28) & (r > g)
    else:  # dawn: gold sparks and bead lights, kept faint
        core = (lum > 0.72) & warm & (sat > 0.12)
    if e == "dawn":  # the flower is a rigid focal subject: no flicker on it
        core = core & (dawn_bloom(lum, sat) < 0.05)
    core = blobs(ndi.binary_opening(core, iterations=1), 3)
    halo = smooth01(core, 2.2) * 1.4 + smooth01(core, 6) * 0.5
    out = np.clip(halo, 0, 1)
    return out * (0.5 if e == "dawn" else 1.0)


def derive_sway(e: str, rgb: np.ndarray) -> np.ndarray:
    r, g, b, lum, sat = features(rgb)
    h, w = lum.shape
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    ew = edge_weight(h, w)
    # local fold energy: moving cloth shows structure, flat dark does not
    energy = norm(np.abs(ndi.gaussian_laplace(lum, 2.0)) + ndi.gaussian_gradient_magnitude(lum, 1.5), 40, 99)
    if e == "candle":
        drape = (r > 1.5 * g) & (lum > 0.07) & (lum < 0.6) & (x > w * 0.6)
        lace = (lum > 0.3) & (sat < 0.4) & (y < h * 0.36) & (x < w * 0.36)
        tassel = (r > g) & (g > b * 1.4) & (lum > 0.3) & (x > w * 0.84)
        region = smooth01(drape | lace | tassel, 5)
        out = region * (0.55 + 0.45 * energy)
    elif e == "dawn":
        petal = (sat > 0.25) & (lum > 0.56)  # loose petals and ribbons, not the whole glow
        region = smooth01(ndi.binary_opening(petal, iterations=1), 3.0)
        calm_bloom = 1 - 0.75 * dawn_bloom(lum, sat)  # cap the hero flower near 0.25
        out = region * (0.5 + 0.5 * energy) * np.clip(0.4 + ew, 0, 1) * 0.65 * calm_bloom
    else:  # chrome: the running water seam and the plate edges only, steel itself stays still
        water = (lum > 0.32) & (sat < 0.3) & (b >= r) & (x > w * 0.8) & (y < h * 0.9)
        region = smooth01(ndi.binary_opening(water, iterations=1), 4)
        out = region * (0.5 + 0.5 * energy)
    return np.clip(out * 1.1, 0, 1)


def derive_glint(e: str, rgb: np.ndarray, flame: np.ndarray) -> np.ndarray:
    _, _, _, lum, _ = features(rgb)
    soft = ndi.grey_opening(lum, size=(5, 5))  # top-hat: small bright things only
    hat = lum - soft
    thr = {"candle": 0.24, "chrome": 0.22, "dawn": 0.2}[e]
    spec = np.clip((hat - thr) / 0.25, 0, 1) * (lum > 0.45)
    spec = spec * (1 - np.clip(flame * 1.5, 0, 1))  # flames flicker, they do not glint
    spec = np.maximum(spec, smooth01(spec, 1.2) * 1.6)
    return np.clip(spec, 0, 1)


def painted(folder: Path | None, stem: str, size: tuple[int, int]) -> np.ndarray | None:
    if not folder:
        return None
    p = find(folder, stem)
    if not p:
        return None
    with Image.open(p) as im:
        a = np.asarray(im.convert("L").resize(size, Image.Resampling.LANCZOS), dtype=np.float32) / 255
    return smooth01(a, 1.0)


def build_mask(e: str, plate: Image.Image, key: str, paint: Path | None, tag: str) -> Image.Image:
    msize = SIZES[key][1]
    small = plate.convert("RGB").resize(msize, Image.Resampling.LANCZOS)
    rgb = np.asarray(small, dtype=np.float32) / 255
    flame = painted(paint, f"{tag}-flame", msize)
    if flame is None:
        flame = derive_flame(e, rgb)
    sway = painted(paint, f"{tag}-sway", msize)
    if sway is None:
        sway = derive_sway(e, rgb)
    glint = painted(paint, f"{tag}-glint", msize)
    if glint is None:
        glint = derive_glint(e, rgb, flame)
    out = np.stack([flame, sway, glint], -1)
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def save_mask(img: Image.Image, path: Path) -> int:
    clean = Image.new("RGB", img.size)
    clean.paste(img)
    clean.save(path, format="PNG", optimize=True)
    size = path.stat().st_size
    for keep in (0xFC, 0xF8, 0xF0, 0xE0):  # masks are smooth data: drop low bits until it fits
        if size <= MASK_BUDGET:
            break
        a = (np.asarray(clean) & keep) | ((~keep & 0xFF) >> 1)
        Image.fromarray(a.astype(np.uint8), "RGB").save(path, format="PNG", optimize=True)
        size = path.stat().st_size
    if size > MASK_BUDGET:
        raise SystemExit(f"FAIL {path.name}: {size / 1024:.1f} KB is over the {MASK_BUDGET // 1024} KB mask budget")
    return size


def save_plate(img: Image.Image, size: tuple[int, int], path: Path) -> tuple[int, int]:
    im = img.convert("RGB").resize(size, Image.Resampling.LANCZOS)
    clean = Image.new("RGB", im.size)
    clean.paste(im)
    lo, hi, best = 40, 92, None
    while lo <= hi:  # best quality that fits the budget
        q = (lo + hi) // 2
        clean.save(path, format="WEBP", quality=q, method=6)
        if path.stat().st_size <= PLATE_BUDGET:
            best, lo = q, q + 1
        else:
            hi = q - 1
    q = best or 40
    clean.save(path, format="WEBP", quality=q, method=6)
    size = path.stat().st_size
    if size > PLATE_BUDGET:
        raise SystemExit(f"FAIL {path.name}: {size / 1024:.1f} KB is over the {PLATE_BUDGET // 1024} KB plate budget even at q{q}")
    return size, q


def has_metadata(path: Path) -> bool:
    with Image.open(path) as im:
        return bool(im.info.get("exif") or im.info.get("icc_profile") or im.info.get("xmp") or im.info.get("comment"))


def check(out: Path) -> int:
    bad = 0
    for p in sorted(out.glob("*")):
        budget = PLATE_BUDGET if p.name.startswith("room-") else MASK_BUDGET
        size = p.stat().st_size
        meta = has_metadata(p)
        flag = "FAIL" if size > budget or meta else "ok  "
        bad += flag == "FAIL"
        print(f"{flag} {p.name} {size / 1024:.1f} KB (budget {budget // 1024}){' METADATA' if meta else ''}")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src")
    ap.add_argument("--paint")
    ap.add_argument("--out", default="public/scene")
    ap.add_argument("--landscape-plates", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    out = Path(a.out)
    if a.check:
        return check(out)
    if not a.src:
        ap.error("--src is required")
    src, paint = Path(a.src), (Path(a.paint) if a.paint else None)
    out.mkdir(parents=True, exist_ok=True)
    made = 0
    for e in ESSENCES:
        for key, suffix in (("l", ""), ("p", "-p")):
            tag = f"{e}{suffix}"
            p = find(src, tag)
            if not p:
                print(f"skip {tag}: no source plate in {src}")
                continue
            with Image.open(p) as im:
                im.load()
                plate = im.convert("RGB")
            want = SIZES[key][0]
            if abs(plate.width / plate.height - want[0] / want[1]) > 0.02:
                print(f"FAIL {tag}: source is {plate.size}, expected aspect {want[0]}:{want[1]}")
                return 1
            if key == "p" or a.landscape_plates:
                sz, q = save_plate(plate, want, out / f"room-{tag}.webp")
                print(f"plate room-{tag}.webp {sz / 1024:.1f} KB q{q}")
            msz = save_mask(build_mask(e, plate, key, paint, tag), out / f"mask-{tag}.png")
            print(f"mask  mask-{tag}.png {msz / 1024:.1f} KB")
            made += 1
    if not made:
        print("nothing built")
        return 1
    return check(out)


if __name__ == "__main__":
    sys.exit(main())
