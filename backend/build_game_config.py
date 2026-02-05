#!/usr/bin/env python3
import argparse
import base64
import json
import os
import re
import time
import html
import unicodedata
from pathlib import Path

import httpx
from dotenv import load_dotenv

KWORB_URL = "https://kworb.net/spotify/country/fr_daily_totals.html"
SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"
UA = "rapantix-config-builder/1.0 (+https://github.com/)"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"

HIP_HOP_QID = "Q11401"  # hip-hop
RNB_QID = "Q45981"      # rhythm and blues
RNB_CONTEMP_QID = "Q850412"  # contemporary R&B
RAPPER_QID = "Q2252262"  # rapper
FR_QID = "Q142"          # France
MUSICAL_GROUP_QID = "Q215380"
HUMAN_QID = "Q5"

GENRE_KEYWORDS = (
    "rap",
    "hip hop",
    "hip-hop",
    "r&b",
    "rnb",
    "rhythm and blues",
    "trap",
    "drill",
)


def normalize(value: str) -> str:
    if not value:
        return ""
    value = value.lower()
    value = unicodedata.normalize("NFD", value)
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Mn")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def fix_mojibake(value: str) -> str:
    if not value:
        return value
    if any(ch in value for ch in ("Ã", "Â", "â")):
        try:
            return value.encode("latin1").decode("utf-8")
        except Exception:
            return value
    return value


def is_rap_genre(genres: list[str]) -> bool:
    for genre in genres or []:
        lowered = genre.lower()
        if any(keyword in lowered for keyword in GENRE_KEYWORDS):
            return True
    return False


def fetch_kworb_entries(client: httpx.Client, limit: int | None) -> list[dict]:
    resp = client.get(KWORB_URL)
    resp.raise_for_status()
    text = resp.text
    rows = re.findall(r"<tr>(.*?)</tr>", text, re.S)
    entries = []
    for row in rows:
        if "artist/" not in row or "track/" not in row:
            continue
        artist_match = re.search(r"artist/[^>]+>([^<]+)</a>", row)
        title_match = re.search(r"track/[^>]+>([^<]+)</a>", row)
        if not artist_match or not title_match:
            continue
        artist = fix_mojibake(html.unescape(artist_match.group(1).strip()))
        title = fix_mojibake(html.unescape(title_match.group(1).strip()))
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        total = None
        if tds:
            last = re.sub(r"<[^>]+>", "", tds[-1])
            last = fix_mojibake(html.unescape(last)).strip()
            if last:
                total = int(last.replace(",", ""))
        if total is None:
            continue
        entries.append({"artist": artist, "title": title, "total": total})
    entries.sort(key=lambda x: x["total"], reverse=True)
    if limit:
        entries = entries[:limit]
    return entries


def fetch_sparql_labels(client: httpx.Client, query: str, retries: int = 3) -> set[str]:
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            resp = client.get(SPARQL_ENDPOINT, params={"format": "json", "query": query})
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", {}).get("bindings", [])
            labels = set()
            for row in results:
                label = row.get("artistLabel", {}).get("value")
                if label:
                    labels.add(label)
            return labels
        except Exception as exc:
            last_err = exc
            time.sleep(1.5 * attempt)
    print(f"[warn] Wikidata query failed: {last_err}")
    return set()


def build_rap_artist_set(client: httpx.Client) -> set[str]:
    rapper_query = f"""
    SELECT ?artistLabel WHERE {{
      ?artist wdt:P106 wd:{RAPPER_QID}.
      ?artist wdt:P27 wd:{FR_QID}.
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"fr,en\". }}
    }}
    """
    genre_query = f"""
    SELECT ?artistLabel WHERE {{
      ?artist wdt:P136/wdt:P279* ?genre.
      VALUES ?genre {{ wd:{HIP_HOP_QID} wd:{RNB_QID} wd:{RNB_CONTEMP_QID} }}
      {{ ?artist wdt:P27 wd:{FR_QID}. }} UNION {{ ?artist wdt:P495 wd:{FR_QID}. }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"fr,en\". }}
    }}
    """
    group_query = f"""
    SELECT ?artistLabel WHERE {{
      ?artist wdt:P31 wd:{MUSICAL_GROUP_QID}.
      ?artist wdt:P136/wdt:P279* ?genre.
      VALUES ?genre {{ wd:{HIP_HOP_QID} wd:{RNB_QID} wd:{RNB_CONTEMP_QID} }}
      ?artist wdt:P495 wd:{FR_QID}.
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language \"fr,en\". }}
    }}
    """
    labels = set()
    for query in (rapper_query, genre_query, group_query):
        labels |= fetch_sparql_labels(client, query)
    normalized = {normalize(label) for label in labels if label}
    return {n for n in normalized if n}


def split_artists(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"\s*(?:&|,|feat\.?|ft\.?|x|\+|/|\\)\s*", value, flags=re.IGNORECASE)
    cleaned = [p.strip() for p in parts if p.strip()]
    return cleaned if cleaned else [value]


def artist_is_rap(artist: str, rap_set: set[str]) -> bool:
    if not rap_set:
        return True
    if normalize(artist) in rap_set:
        return True
    for part in split_artists(artist):
        if normalize(part) in rap_set:
            return True
    return False


def load_whitelist(config_path: Path) -> set[str]:
    if not config_path.exists():
        return set()
    try:
        data = json.loads(config_path.read_text())
    except Exception:
        return set()
    artists = data.get("topArtists") or []
    return {normalize(a) for a in artists if a}


def artist_in_whitelist(artist: str, whitelist: set[str]) -> bool:
    if not whitelist:
        return False
    if normalize(artist) in whitelist:
        return True
    for part in split_artists(artist):
        if normalize(part) in whitelist:
            return True
    return False


def wikidata_search_entity(client: httpx.Client, name: str, language: str) -> str | None:
    try:
        resp = client.get(
            WIKIDATA_API,
            params={
                "action": "wbsearchentities",
                "search": name,
                "language": language,
                "format": "json",
                "limit": 1,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("search", [])
        if results:
            return results[0].get("id")
    except Exception:
        return None
    return None


def wikidata_get_entity(client: httpx.Client, entity_id: str) -> dict | None:
    try:
        resp = client.get(
            WIKIDATA_API,
            params={
                "action": "wbgetentities",
                "ids": entity_id,
                "props": "claims",
                "format": "json",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("entities", {}).get(entity_id)
    except Exception:
        return None


def wikidata_claim_has_qid(claims: dict, prop: str, qid: str) -> bool:
    for claim in claims.get(prop, []) or []:
        datavalue = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
        if isinstance(datavalue, dict) and datavalue.get("id") == qid:
            return True
    return False


def wikidata_is_french_artist(entity: dict | None) -> bool:
    if not entity:
        return False
    claims = entity.get("claims", {})
    is_human = wikidata_claim_has_qid(claims, "P31", HUMAN_QID)
    is_group = wikidata_claim_has_qid(claims, "P31", MUSICAL_GROUP_QID)
    if not (is_human or is_group):
        return False
    is_french_citizen = wikidata_claim_has_qid(claims, "P27", FR_QID)
    is_french_origin = wikidata_claim_has_qid(claims, "P495", FR_QID)
    return is_french_citizen or is_french_origin


def is_french_artist(
    client: httpx.Client,
    name: str,
    cache: dict,
    sleep_s: float,
) -> bool:
    key = normalize(name)
    if key in cache:
        return cache[key].get("is_french", False)
    entity_id = wikidata_search_entity(client, name, "fr") or wikidata_search_entity(client, name, "en")
    is_french = False
    if entity_id:
        entity = wikidata_get_entity(client, entity_id)
        is_french = wikidata_is_french_artist(entity)
    cache[key] = {"is_french": is_french, "entity": entity_id}
    time.sleep(max(sleep_s, 0.1))
    return is_french


def title_matches(result_title: str, target_title: str) -> bool:
    norm_result = normalize(result_title)
    norm_target = normalize(target_title)
    if not norm_result or not norm_target:
        return False
    return norm_target in norm_result or norm_result in norm_target


def artist_matches(primary_artist: str, target_artist: str) -> bool:
    primary_tokens = set(normalize(primary_artist).split())
    target_tokens = normalize(target_artist).split()
    if not primary_tokens or not target_tokens:
        return False
    return all(token in primary_tokens for token in target_tokens)


def load_cache(cache_path: Path) -> dict:
    if cache_path.exists():
        try:
            return json.loads(cache_path.read_text())
        except Exception:
            return {}
    return {}


def save_cache(cache_path: Path, cache: dict) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


class SpotifyClient:
    def __init__(self, client: httpx.Client, client_id: str, client_secret: str) -> None:
        self.client = client
        self.client_id = client_id
        self.client_secret = client_secret
        self._token = None
        self._token_expiry = 0.0

    def _refresh_token(self) -> str | None:
        auth_raw = f"{self.client_id}:{self.client_secret}".encode()
        auth = base64.b64encode(auth_raw).decode()
        resp = self.client.post(
            SPOTIFY_TOKEN_URL,
            data={"grant_type": "client_credentials"},
            headers={"Authorization": f"Basic {auth}"},
        )
        if resp.status_code != 200:
            print(f"[warn] Spotify token request failed: {resp.status_code} {resp.text[:200]}")
            return None
        data = resp.json()
        token = data.get("access_token")
        expires_in = int(data.get("expires_in", 0))
        if token:
            self._token = token
            self._token_expiry = time.time() + max(expires_in, 0)
        return token

    def _get_token(self) -> str | None:
        if self._token and time.time() < self._token_expiry - 60:
            return self._token
        return self._refresh_token()

    def get(self, path: str, params: dict | None = None) -> httpx.Response | None:
        token = self._get_token()
        if not token:
            return None
        for attempt in range(2):
            try:
                resp = self.client.get(
                    f"{SPOTIFY_API_BASE}{path}",
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                )
            except httpx.HTTPError as exc:
                print(f"[warn] Spotify request failed: {exc}")
                time.sleep(0.5 * (attempt + 1))
                continue
            if resp.status_code == 401:
                self._token = None
                token = self._get_token()
                if not token:
                    return None
                continue
            return resp
        return None


def spotify_search_track(spotify: SpotifyClient, artist: str, title: str) -> dict | None:
    queries = [
        f'track:\"{title}\" artist:\"{artist}\"',
        f'{artist} {title}',
    ]
    for query in queries:
        resp = spotify.get(
            "/search",
            params={"q": query, "type": "track", "limit": 1, "market": "FR"},
        )
        if not resp or resp.status_code != 200:
            continue
        items = resp.json().get("tracks", {}).get("items", [])
        if items:
            return items[0]
    return None


def spotify_get_artist_genres(
    spotify: SpotifyClient,
    artist_id: str,
    artist_cache: dict,
    sleep_s: float,
) -> list[str]:
    if artist_id in artist_cache:
        return artist_cache[artist_id]
    resp = spotify.get(f"/artists/{artist_id}")
    if not resp or resp.status_code != 200:
        artist_cache[artist_id] = []
        return []
    genres = resp.json().get("genres", []) or []
    artist_cache[artist_id] = genres
    time.sleep(sleep_s)
    return genres


def spotify_track_info(
    spotify: SpotifyClient,
    artist: str,
    title: str,
    track_cache: dict,
    artist_cache: dict,
    sleep_s: float,
) -> dict | None:
    key = f"{normalize(artist)}|{normalize(title)}"
    if key in track_cache:
        return track_cache[key]
    track = spotify_search_track(spotify, artist, title)
    if not track:
        track_cache[key] = None
        return None
    release_date = track.get("album", {}).get("release_date") or ""
    year = None
    if release_date:
        try:
            year = int(release_date.split("-")[0])
        except Exception:
            year = None
    artist_ids = [a.get("id") for a in track.get("artists", []) if a.get("id")]
    genres = []
    for artist_id in artist_ids:
        genres.extend(spotify_get_artist_genres(spotify, artist_id, artist_cache, sleep_s))
    genres = list(dict.fromkeys(genres))
    info = {"year": year, "genres": genres, "is_rap": is_rap_genre(genres)}
    track_cache[key] = info
    return info


def fetch_release_year(client: httpx.Client, token: str, artist: str, title: str, cache: dict, sleep_s: float) -> int | None:
    key = f"{normalize(artist)}|{normalize(title)}"
    if key in cache:
        return cache[key].get("year")
    headers = {"Authorization": f"Bearer {token}"}
    params = {"q": f"{artist} {title}"}
    try:
        search = client.get("https://api.genius.com/search", headers=headers, params=params)
        if search.status_code != 200:
            cache[key] = {"year": None}
            return None
        data = search.json()
    except Exception:
        cache[key] = {"year": None}
        return None
    hits = data.get("response", {}).get("hits", [])
    song_id = None
    for hit in hits:
        result = hit.get("result") or {}
        if not result:
            continue
        if not artist_matches(result.get("primary_artist", {}).get("name", ""), artist):
            continue
        if not title_matches(result.get("title", ""), title):
            continue
        song_id = result.get("id")
        break
    if not song_id:
        cache[key] = {"year": None}
        return None
    time.sleep(sleep_s)
    try:
        song = client.get(f"https://api.genius.com/songs/{song_id}", headers=headers)
        if song.status_code != 200:
            cache[key] = {"year": None}
            return None
        song_data = song.json().get("response", {}).get("song", {})
        release_date = song_data.get("release_date")
        release_components = song_data.get("release_date_components") or {}
        year = None
        if release_components.get("year"):
            year = int(release_components["year"])
        elif release_date:
            try:
                year = int(release_date.split("-")[0])
            except Exception:
                year = None
        cache[key] = {"year": year}
        return year
    except Exception:
        cache[key] = {"year": None}
        return None


def build_top_tracks(
    token: str | None,
    min_year: int,
    min_total: int,
    target_count: int,
    kworb_limit: int,
    sleep_s: float,
    spotify_client_id: str | None,
    spotify_client_secret: str | None,
    fallback_wikidata: bool,
    progress_every: int,
    filter_mode: str,
    whitelist: set[str],
    require_french: bool,
) -> list[dict]:
    timeout = httpx.Timeout(30.0, read=60.0)
    with httpx.Client(timeout=timeout, headers={"User-Agent": UA}) as client:
        spotify = None
        if spotify_client_id and spotify_client_secret:
            spotify = SpotifyClient(client, spotify_client_id, spotify_client_secret)
            print("[info] Spotify genre filter enabled")
        else:
            print("[warn] Spotify credentials missing, falling back to Wikidata only")
            fallback_wikidata = True

        if spotify and filter_mode in ("auto", "spotify"):
            probe = spotify._get_token()
            if not probe:
                print("[warn] Spotify token unavailable, disabling Spotify filter")
                spotify = None

        if whitelist:
            print(f"[info] Whitelist filter enabled: {len(whitelist)} artists")

        if filter_mode == "wikidata":
            fallback_wikidata = True
            spotify = None
        elif filter_mode == "whitelist":
            spotify = None
            fallback_wikidata = False

        rap_set = build_rap_artist_set(client) if fallback_wikidata else set()
        entries = fetch_kworb_entries(client, kworb_limit)
        cache_path = Path("backend/cache/genius_release_years.json")
        cache = load_cache(cache_path) if token else {}

        spotify_track_cache = load_cache(Path("backend/cache/spotify_track_cache.json")) if spotify else {}
        spotify_artist_cache = load_cache(Path("backend/cache/spotify_artist_cache.json")) if spotify else {}
        french_cache = load_cache(Path("backend/cache/wikidata_artist_cache.json")) if require_french else {}

        top_tracks = []
        for idx, entry in enumerate(entries, start=1):
            if progress_every and idx % progress_every == 0:
                print(f"[progress] scanned {idx}/{len(entries)} | kept {len(top_tracks)}")
            if entry["total"] < min_total:
                continue
            rap_ok = True
            year = None

            if spotify:
                info = spotify_track_info(
                    spotify,
                    entry["artist"],
                    entry["title"],
                    spotify_track_cache,
                    spotify_artist_cache,
                    sleep_s,
                )
                if info is None:
                    rap_ok = False
                else:
                    rap_ok = info.get("is_rap", False)
                    year = info.get("year")

            if not rap_ok and whitelist:
                rap_ok = artist_in_whitelist(entry["artist"], whitelist)

            if not rap_ok and fallback_wikidata:
                rap_ok = artist_is_rap(entry["artist"], rap_set)

            if not rap_ok:
                continue

            if year is None and token:
                year = fetch_release_year(client, token, entry["artist"], entry["title"], cache, sleep_s)

            if year is None or year < min_year:
                continue
            if require_french:
                parts = split_artists(entry["artist"])
                if not parts:
                    continue
                french_ok = any(is_french_artist(client, part, french_cache, sleep_s) for part in parts)
                if not french_ok:
                    continue
            top_tracks.append({
                "artist": entry["artist"],
                "title": entry["title"],
                "year": year,
                "totalStreams": entry["total"],
            })
            if len(top_tracks) >= target_count:
                break
            time.sleep(sleep_s)
        if token:
            save_cache(cache_path, cache)
        if spotify:
            save_cache(Path("backend/cache/spotify_track_cache.json"), spotify_track_cache)
            save_cache(Path("backend/cache/spotify_artist_cache.json"), spotify_artist_cache)
        if require_french:
            save_cache(Path("backend/cache/wikidata_artist_cache.json"), french_cache)
        return top_tracks


def update_game_config(top_tracks: list[dict], config_path: Path) -> None:
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    config["topTracks"] = top_tracks
    if top_tracks:
        seen = set()
        artists = []
        for track in top_tracks:
            name = track["artist"]
            if name in seen:
                continue
            seen.add(name)
            artists.append(name)
        config["topArtists"] = artists
    if "proxyTemplates" not in config:
        config["proxyTemplates"] = ["http://localhost:8000/proxy?url={url}"]
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2))


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Build rap chart config from Kworb + Genius + Spotify/Wikidata")
    parser.add_argument("--min-year", type=int, default=2017)
    parser.add_argument("--min-total", type=int, default=20_000_000)
    parser.add_argument("--target", type=int, default=400)
    parser.add_argument("--kworb-limit", type=int, default=1500)
    parser.add_argument("--sleep", type=float, default=0.2)
    parser.add_argument("--config", type=str, default="public/game-config.json")
    parser.add_argument("--fallback-wikidata", action="store_true", help="Use Wikidata when Spotify lookup fails")
    parser.add_argument("--progress-every", type=int, default=50)
    parser.add_argument(
        "--filter-mode",
        choices=["auto", "spotify", "whitelist", "wikidata"],
        default="auto",
        help="Select genre filter: spotify (needs creds), whitelist (topArtists), wikidata, or auto",
    )
    parser.add_argument("--require-french", action="store_true", help="Keep only French artists via Wikidata")
    args = parser.parse_args()

    token = os.getenv("VITE_GENIUS_TOKEN") or os.getenv("GENIUS_TOKEN")
    spotify_client_id = os.getenv("SPOTIFY_CLIENT_ID")
    spotify_client_secret = os.getenv("SPOTIFY_CLIENT_SECRET")
    if not spotify_client_id or not spotify_client_secret:
        print("[warn] Missing Spotify credentials in environment")
    else:
        print(f"[info] Spotify client id length: {len(spotify_client_id)} | secret length: {len(spotify_client_secret)}")
    if not token and not (spotify_client_id and spotify_client_secret):
        raise SystemExit("Missing VITE_GENIUS_TOKEN (or GENIUS_TOKEN) and SPOTIFY_CLIENT_ID/SECRET")

    config_path = Path(args.config)
    whitelist = load_whitelist(config_path) if args.filter_mode in ("auto", "whitelist") else set()
    if args.filter_mode == "spotify" and not (spotify_client_id and spotify_client_secret):
        raise SystemExit("filter-mode=spotify requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET")

    top_tracks = build_top_tracks(
        token=token,
        min_year=args.min_year,
        min_total=args.min_total,
        target_count=args.target,
        kworb_limit=args.kworb_limit,
        sleep_s=args.sleep,
        spotify_client_id=spotify_client_id,
        spotify_client_secret=spotify_client_secret,
        fallback_wikidata=args.fallback_wikidata,
        progress_every=args.progress_every,
        filter_mode=args.filter_mode,
        whitelist=whitelist,
        require_french=args.require_french,
    )

    update_game_config(top_tracks, config_path)
    print(f"Generated {len(top_tracks)} tracks -> {args.config}")


if __name__ == "__main__":
    main()
