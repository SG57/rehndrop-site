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
VELVET = BRAND / "05-textures/velvet/velvet-master.png"
# Cord's AI upscale of velvet-master.png; used automatically once it exists
VELVET_HI = BRAND / "05-textures/velvet/velvet-master-4x.png"
# one image serves the CSS first paint and the WebGL texture; 2560 keeps it under every
# mobile GPU's max texture size (4096) and the download reasonable
VELVET_MAX_W = 2560
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

    velvet = Image.open(VELVET_HI if VELVET_HI.exists() else VELVET).convert("RGB")
    if velvet.width > VELVET_MAX_W:
        velvet = velvet.resize((VELVET_MAX_W, round(velvet.height * VELVET_MAX_W / velvet.width)), Image.LANCZOS)
    print(f"velvet source {velvet.width}x{velvet.height}")
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
