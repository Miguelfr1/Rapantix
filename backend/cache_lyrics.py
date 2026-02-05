#!/usr/bin/env python3
import argparse
import json
import os
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

GENIUS_SEARCH_URL = "https://api.genius.com/search"
GENIUS_EMBED_URL = "https://genius.com/songs/{song_id}/embed.js"
UA = "rapantix-lyrics-cache/1.0"


def normalize(value: str) -> str:
    if not value:
        return ""
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_title(value: str) -> str:
    value = normalize(value)
    value = re.sub(r"\b(feat|ft|featuring)\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def tokenize_artist(value: str) -> list[str]:
    tokens = normalize(value).split()
    return [t for t in tokens if t]


def artist_matches(primary: str, target: str) -> bool:
    primary_tokens = tokenize_artist(primary)
    target_tokens = tokenize_artist(target)
    if not primary_tokens or not target_tokens:
        return False
    return all(token in primary_tokens for token in target_tokens)


def title_matches(result_title: str, target_title: str) -> bool:
    norm_result = normalize_title(result_title)
    norm_target = normalize_title(target_title)
    if not norm_result or not norm_target:
        return False
    return norm_result in norm_target or norm_target in norm_result


class EmbedLyricsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_body = False
        self.depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "div" and attrs_dict.get("class") == "rg_embed_body":
            self.in_body = True
            self.depth = 1
            return
        if self.in_body:
            if tag == "div":
                self.depth += 1
            if tag == "br":
                self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.in_body and tag == "div":
            self.depth -= 1
            if self.depth <= 0:
                self.in_body = False

    def handle_data(self, data):
        if self.in_body:
            self.parts.append(data)

    def get_text(self) -> str:
        text = "".join(self.parts)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


class PageLyricsParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_lyrics = False
        self.depth = 0
        self.parts: list[str] = []
        self.containers: list[str] = []
        self.skip = False

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag in {"script", "style"}:
            self.skip = True
        if tag == "div" and attrs_dict.get("data-lyrics-container") == "true":
            self.in_lyrics = True
            self.depth = 1
            self.parts = []
            return
        if self.in_lyrics:
            if tag == "div":
                self.depth += 1
            if tag == "br":
                self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = False
        if self.in_lyrics and tag == "div":
            self.depth -= 1
            if self.depth <= 0:
                self.in_lyrics = False
                text = "".join(self.parts)
                if text.strip():
                    self.containers.append(text)

    def handle_data(self, data):
        if self.skip:
            return
        if self.in_lyrics:
            self.parts.append(data)

    def get_text(self) -> str:
        if not self.containers:
            return ""
        cleaned = []
        for raw in self.containers:
            text = re.sub(r"[ \t]+\n", "\n", raw)
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            if "[" in text:
                text = text[text.find("["):].strip()
            if text:
                cleaned.append(text)
        if not cleaned:
            return ""
        return "\n\n".join(cleaned)


def fix_mojibake(value: str) -> str:
    if not value:
        return value
    if "Ã" in value or "Â" in value:
        try:
            return value.encode("latin1").decode("utf-8")
        except Exception:
            return value
    return value


def extract_lyrics_from_embed(js_text: str) -> Optional[str]:
    match = re.search(r"JSON\.parse\('([\s\S]*?)'\)\)", js_text)
    if not match:
        return None
    try:
        raw = match.group(1)
        unescaped = bytes(raw, "utf-8").decode("unicode_escape")
        html_fragment = json.loads(unescaped)
    except Exception:
        return None
    parser = EmbedLyricsParser()
    parser.feed(html_fragment)
    lyrics = parser.get_text()
    return fix_mojibake(lyrics) or None


def extract_lyrics_from_page(html_text: str) -> Optional[str]:
    if not html_text:
        return None
    parser = PageLyricsParser()
    parser.feed(html_text)
    lyrics = parser.get_text()
    return fix_mojibake(lyrics) or None


def pick_hit(hits: list[dict], artist: str, title: str) -> Optional[dict]:
    if not hits:
        return None
    both = []
    artist_only = []
    title_only = []
    for hit in hits:
        result = hit.get("result") or {}
        result_artist = result.get("primary_artist", {}).get("name", "")
        result_title = result.get("title", "")
        match_artist = artist_matches(result_artist, artist)
        match_title = title_matches(result_title, title)
        if match_artist and match_title:
            both.append(result)
        elif match_artist:
            artist_only.append(result)
        elif match_title:
            title_only.append(result)
    for pool in (both, artist_only, title_only):
        if pool:
            return pool[0]
    return hits[0].get("result")


def fetch_genius_hit(client: httpx.Client, token: str | None, artist: str, title: str) -> Optional[dict]:
    query = f"{artist} {title}".strip()
    headers = {"User-Agent": UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = client.get(GENIUS_SEARCH_URL, params={"q": query}, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    hits = data.get("response", {}).get("hits", [])
    return pick_hit(hits, artist, title)


def fetch_embed_lyrics(client: httpx.Client, song_id: int) -> Optional[str]:
    url = GENIUS_EMBED_URL.format(song_id=song_id)
    resp = client.get(url, headers={"User-Agent": UA, "Referer": "https://genius.com/"})
    resp.raise_for_status()
    return extract_lyrics_from_embed(resp.text)


def fetch_page_lyrics(client: httpx.Client, url: str) -> Optional[str]:
    resp = client.get(url, headers={"User-Agent": UA, "Referer": "https://genius.com/"})
    resp.raise_for_status()
    return extract_lyrics_from_page(resp.text)


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Cache Genius lyrics locally")
    parser.add_argument("--config", default="public/game-config.json")
    parser.add_argument("--out-dir", default="public/lyrics")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--force", action="store_true", help="re-download even if lyricsPath exists")
    args = parser.parse_args()

    config_path = Path(args.config)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    data = json.loads(config_path.read_text(encoding="utf-8"))
    tracks = data.get("topTracks") or []
    token = os.environ.get("GENIUS_TOKEN", "").strip() or None

    if not token:
        print("[warn] GENIUS_TOKEN missing. Search may fail.")

    updated = 0
    processed = 0
    client = httpx.Client(timeout=20.0, follow_redirects=True)

    try:
        for track in tracks:
            if args.limit and processed >= args.limit:
                break
            processed += 1
            artist = track.get("artist") or ""
            title = track.get("title") or ""
            if not artist or not title:
                continue

            existing_path = track.get("lyricsPath")
            if not args.force and existing_path:
                file_path = Path("public") / existing_path
                if file_path.exists():
                    continue

            try:
                hit = fetch_genius_hit(client, token, artist, title)
                if not hit:
                    print(f"[miss] {artist} - {title}: no hit")
                    continue
                song_id = hit.get("id")
                if not song_id:
                    print(f"[miss] {artist} - {title}: no id")
                    continue

                lyrics = None
                if hit.get("url"):
                    try:
                        lyrics = fetch_page_lyrics(client, hit["url"])
                    except Exception as exc:
                        print(f"[warn] {artist} - {title}: page fetch failed ({exc})")
                if not lyrics:
                    lyrics = fetch_embed_lyrics(client, song_id)
                if not lyrics:
                    print(f"[miss] {artist} - {title}: no lyrics")
                    continue

                rel_path = f"lyrics/{song_id}.txt"
                file_path = Path("public") / rel_path
                file_path.write_text(lyrics, encoding="utf-8")
                track["lyricsId"] = song_id
                track["lyricsPath"] = rel_path
                updated += 1
                print(f"[ok] {artist} - {title} -> {rel_path}")
            except Exception as exc:
                print(f"[error] {artist} - {title}: {exc}")
            time.sleep(args.sleep)
    finally:
        client.close()

    config_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] Updated {updated} tracks, wrote {config_path}")


if __name__ == "__main__":
    main()
