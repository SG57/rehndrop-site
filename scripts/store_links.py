#!/usr/bin/env python
"""Turn ONCE's per-release store URLs into exact per-track links, and prove every link.

    python scripts/store_links.py

Input:  src/data/store-links.json  "releases" (written from ONCE get_release_status by the
        rehndrop-release skill; ONCE gives Spotify album URLs, Apple album URLs and YouTube
        Music track URLs).
Output: the same file, plus a "tracks" map keyed by track title:
        {"spotify": open.spotify.com/track/..., "apple": ..., "youtubeMusic": ...}

Spotify album -> track ids come from Spotify's public embed page (no API key). Every link is
then checked against the platform's own oEmbed / lookup API and must name the right song;
a link that can't be proven is dropped, and the site falls back to its search link.
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
DATA = SITE / "src" / "data" / "store-links.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"}

# Releases that predate ONCE; each link here was proven with Spotify oEmbed on 2026-10-09.
EXTRA = {
    "don't screw with me": {"spotify": "https://open.spotify.com/track/38ru8iH6h5aZIFTzzjhuZm"},
}


def norm(s: str) -> str:
    s = s.lower().replace("’", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", "", s)).strip()


def get(url: str) -> str:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "replace")


def spotify_album_tracks(album_url: str) -> dict[str, str]:
    """{track title as Spotify shows it: open.spotify.com/track/<id>} for one album."""
    album_id = re.search(r"/album/([A-Za-z0-9]+)", album_url).group(1)
    html = get(f"https://open.spotify.com/embed/album/{album_id}")
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    out: dict[str, str] = {}
    if not m:
        return out

    def walk(o):
        if isinstance(o, dict):
            uri = o.get("uri", "")
            if uri.startswith("spotify:track:") and o.get("title"):
                out[o["title"]] = "https://open.spotify.com/track/" + uri.split(":")[-1]
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(json.loads(m.group(1)))
    return out


def oembed_title(kind: str, url: str) -> str | None:
    endpoint = {
        "spotify": "https://open.spotify.com/oembed?url=",
        "youtube": "https://www.youtube.com/oembed?format=json&url=",
    }[kind]
    try:
        return json.loads(get(endpoint + urllib.parse.quote(url, safe="")))["title"]
    except Exception:
        return None


def apple_title(url: str) -> str | None:
    m = re.search(r"[?&]i=(\d+)", url) or re.search(r"/(\d+)(?:\?|$)", url)
    if not m:
        return None
    try:
        res = json.loads(get(f"https://itunes.apple.com/lookup?id={m.group(1)}"))["results"]
        r = res[0]
        return r.get("trackName") or r.get("collectionName")
    except Exception:
        return None


def matches(title: str, found: str | None) -> bool:
    if not found:
        return False
    a, b = norm(title), norm(found)
    return a == b or b.startswith(a) or a in b


def main() -> int:
    doc = json.loads(DATA.read_text(encoding="utf-8"))
    tracks: dict[str, dict] = {}
    problems: list[str] = []

    for title, rel in doc["releases"].items():
        album = {}
        if rel.get("spotify"):
            try:
                album = spotify_album_tracks(rel["spotify"])
            except Exception as e:
                problems.append(f"{title}: spotify embed failed ({e})")
            time.sleep(0.3)
        by_norm = {norm(k): v for k, v in album.items()}
        tracks[title] = {
            "spotify": by_norm.get(norm(title)) or (rel["spotify"] or "").replace("play.spotify.com", "open.spotify.com") or None,
            "apple": rel.get("apple"),
            "youtubeMusic": rel.get("youtubeMusic"),
        }
        # other songs on the same release (the disconnect single carries two)
        for name, url in album.items():
            if norm(name) != norm(title):
                tracks[name] = {"spotify": url, "apple": None, "youtubeMusic": None}

    for title, extra in EXTRA.items():
        tracks.setdefault(title, {}).update(extra)

    # prove every link names the right song; drop what can't be proven
    for title, entry in tracks.items():
        for field, kind in (("spotify", "spotify"), ("youtubeMusic", "youtube"), ("apple", "apple")):
            url = entry.get(field)
            if not url:
                continue
            found = apple_title(url) if kind == "apple" else oembed_title(kind, url)
            ok = matches(title, found)
            if not ok:
                problems.append(f"{title}: {field} names {found!r}, dropped")
                entry[field] = None
            time.sleep(0.15)

    doc["tracks"] = dict(sorted(tracks.items()))
    doc["verified"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    DATA.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    n = len(tracks)
    for field in ("spotify", "apple", "youtubeMusic"):
        print(f"{field:<13} {sum(1 for e in tracks.values() if e.get(field))}/{n} proven")
    for p in problems:
        print("  !", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
