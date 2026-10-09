#!/usr/bin/env python
"""Derive the site's brand assets from the rehndrop brand masters (read-only).

    python scripts/build_brand_assets.py

Writes into public/brand/ and public/. The masters under D:/rehndrop/resources/brand
are never modified (BRAND.md: "never edit, always derive").
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

BRAND = Path("D:/rehndrop/resources/brand")
SITE = Path(__file__).resolve().parent.parent
OUT = SITE / "public" / "brand"

LOGO_4K = BRAND / "01-masters/renders/logo-4k.jpg"
# Measured mark-only bounds in logo-4k (BRAND memory): excludes the uppercase wordmark,
# which is unratified and breaks the always-lowercase rule.
MARK_BOX = (802, 710, 2988, 2994)
# Cord's AI upscales of velvet-master.png win when present, highest resolution first
VELVET_SOURCES = [
    BRAND / "05-textures/velvet/velvet-master-16k.jpg",
    BRAND / "05-textures/velvet/velvet-master-4x.png",
    BRAND / "05-textures/velvet/velvet-master.png",
]
# velvet.webp serves the CSS first paint and the WebGL texture everywhere; 2560 stays under
# every mobile GPU's 4096 max texture size. velvet-4k.webp is swapped in only on screens
# with more than ~2600 physical pixels across (retina laptops, 4K desktops).
VELVET_W = 2560
VELVET_4K_W = 3840
Image.MAX_IMAGE_PIXELS = 200_000_000  # the 16k master is 133 MP; keep a bomb limit above it
AVATAR = BRAND / "06-platforms/avatars/avatar-2400-mono.png"


def chrome_mark() -> Image.Image:
    """Cut the chrome R out of its near-black (#020204) ground with a luminance key."""
    rgb = np.asarray(Image.open(LOGO_4K).convert("RGB").crop(MARK_BOX), dtype=np.float32)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    # ground measures <= 4; the darkest chrome sits well above 30
    t = np.clip((lum - 6.0) / 24.0, 0.0, 1.0)
    alpha = t * t * (3.0 - 2.0 * t)
    # un-premultiply against black so anti-aliased edges keep their chrome value
    safe = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip(rgb / safe, 0, 255)
    col = np.where(alpha[..., None] > 0.002, col, 0)
    rgba = np.dstack([col, alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    mark = chrome_mark()
    for w in (1200, 640):
        h = round(mark.height * w / mark.width)
        mark.resize((w, h), Image.LANCZOS).save(OUT / f"r-chrome-{w}.webp", quality=90, method=6)
    # alpha-only mask (white) for CSS mask-image: the specular sweep is clipped to the R
    a = mark.getchannel("A").resize((640, round(mark.height * 640 / mark.width)), Image.LANCZOS)
    m = Image.merge("RGBA", (a.point(lambda _: 255),) * 3 + (a,))
    m.save(OUT / "r-mask-640.png", optimize=True)

    src = next(p for p in VELVET_SOURCES if p.exists())
    master = Image.open(src).convert("RGB")
    print(f"velvet source {src.name} {master.width}x{master.height}")
    if master.width >= VELVET_4K_W:
        hi = master.resize((VELVET_4K_W, round(master.height * VELVET_4K_W / master.width)), Image.LANCZOS)
        hi.save(OUT / "velvet-4k.webp", quality=80, method=6)
    velvet = master.resize((VELVET_W, round(master.height * VELVET_W / master.width)), Image.LANCZOS) if master.width > VELVET_W else master
    del master
    velvet.save(OUT / "velvet.webp", quality=82, method=6)
    blur = velvet.resize((836, round(velvet.height * 836 / velvet.width)), Image.LANCZOS)
    blur = blur.filter(ImageFilter.GaussianBlur(9))
    blur.save(OUT / "velvet-fog.jpg", quality=84, progressive=True, optimize=True)

    # share card: velvet, dimmed, chrome R centred
    og = velvet.resize((1200, round(velvet.height * 1200 / velvet.width)), Image.LANCZOS)
    top = (og.height - 630) // 2
    og = og.crop((0, top, 1200, top + 630))
    og = Image.blend(og, Image.new("RGB", og.size, (2, 2, 4)), 0.35)
    r = mark.resize((round(mark.width * 440 / mark.height), 440), Image.LANCZOS)
    og.paste(r, ((1200 - r.width) // 2, (630 - r.height) // 2), r)
    og.save(SITE / "public" / "og.jpg", quality=88, progressive=True, optimize=True)

    # icons reuse the avatar already used as the profile image on every platform
    av = Image.open(AVATAR).convert("RGB")
    av.resize((180, 180), Image.LANCZOS).save(SITE / "public" / "apple-touch-icon.png", optimize=True)
    av.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)
    av.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png", optimize=True)
    av.save(SITE / "public" / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    for p in sorted(OUT.iterdir()):
        print(f"{p.name:<24} {p.stat().st_size // 1024:>6} KB")


if __name__ == "__main__":
    main()
