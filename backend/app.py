import os
import re
import unicodedata
from pathlib import Path
from functools import lru_cache
from typing import List
from urllib.parse import urlparse, quote_plus

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from gensim.models import KeyedVectors, Word2Vec
from pydantic import BaseModel

# Load .env (useful for deployments)
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = os.environ.get("WORD2VEC_MODEL_PATH", str(BASE_DIR / "models" / "word2vec.model"))
MAX_TOPN = 60
PROXY_TIMEOUT = float(os.environ.get("PROXY_TIMEOUT", "8.0"))
GENIUS_TOKEN = os.environ.get("GENIUS_TOKEN", "").strip()
ALLOWED_PROXY_HOSTS = {
    "genius.com",
    "www.genius.com",
    "api.genius.com",
}
YOUTUBE_SEARCH_URL = os.environ.get("YOUTUBE_SEARCH_URL", "https://www.youtube.com/results")
YOUTUBE_FALLBACK_URL = os.environ.get("YOUTUBE_FALLBACK_URL", "").strip()

app = FastAPI(
    title="Rapantix Similarity API",
    description="Expose Word2Bezbar (RapMinerz) word2vec similarities for the Rapantix-style guessing game",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"]
)


class SimilarRequest(BaseModel):
    word: str
    topn: int = 15


class SimilarWord(BaseModel):
    term: str
    score: float


class SimilarResponse(BaseModel):
    origin: str
    normalized: str
    results: List[SimilarWord]


@lru_cache(maxsize=1)
def load_model() -> KeyedVectors:
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"Word2Vec model not found at {MODEL_PATH}")
    # The RapMinerz artifact is a full Word2Vec model. If loading it as KeyedVectors
    # fails, fall back to Word2Vec.load then return the .wv vectors.
    try:
        model = Word2Vec.load(MODEL_PATH)
        return model.wv
    except Exception:
        return KeyedVectors.load(MODEL_PATH, mmap="r")


def normalize_word(value: str) -> str:
    return (
        unicodedata.normalize("NFD", value)
        .casefold()
        .replace("’", "'")
        .replace("`", "'")
        .replace("«", "")
        .replace("»", "")
        .replace("‹", "")
        .replace("›", "")
        .encode("ascii", "ignore")
        .decode("ascii")
        .strip()
    )


def _is_allowed_host(host: str) -> bool:
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in ALLOWED_PROXY_HOSTS)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_path": MODEL_PATH}


@app.get("/proxy")
def proxy(url: str):
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")

    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in {"http", "https"} or not _is_allowed_host(host):
        raise HTTPException(status_code=403, detail="Host not allowed")

    headers = {
        "User-Agent": "Mozilla/5.0 (Rapantix Proxy)",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://genius.com/",
    }
    if GENIUS_TOKEN and (host == "api.genius.com" or parsed.path.startswith("/api/")):
        headers["Authorization"] = f"Bearer {GENIUS_TOKEN}"

    try:
        with httpx.Client(
            timeout=PROXY_TIMEOUT,
            follow_redirects=True,
            headers=headers,
        ) as client:
            resp = client.get(url)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Proxy error: {exc}") from exc

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail="Upstream error")

    content_type = resp.headers.get("content-type", "text/html")
    return Response(content=resp.text, media_type=content_type)


@app.post("/similar", response_model=SimilarResponse)
def get_similar(request: SimilarRequest):
    if not request.word.strip():
        raise HTTPException(status_code=400, detail="Provide a non-empty word")

    normalized = normalize_word(request.word)
    kv = load_model()

    topn = max(1, min(request.topn or 1, MAX_TOPN))
    try:
        raw = kv.most_similar(normalized, topn=topn)
    except KeyError:
        raw = []

    results = [SimilarWord(term=term, score=float(score)) for term, score in raw]
    return SimilarResponse(origin="word2bezbar", normalized=normalized, results=results)


@app.get("/youtube")
def youtube_search(q: str):
    if not q:
        raise HTTPException(status_code=400, detail="Missing query")

    query = quote_plus(q)
    urls = [YOUTUBE_SEARCH_URL]
    if YOUTUBE_FALLBACK_URL:
        urls.append(YOUTUBE_FALLBACK_URL)

    matches = []
    last_error: str | None = None

    for base_url in urls:
        url = f"{base_url}?search_query={query}"
        try:
            with httpx.Client(
                timeout=PROXY_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": "Mozilla/5.0 (Rapantix YouTube Lookup)"},
            ) as client:
                resp = client.get(url)
        except httpx.RequestError as exc:
            last_error = f"YouTube lookup error: {exc}"
            continue

        if resp.status_code >= 400:
            last_error = "YouTube upstream error"
            continue

        matches = re.findall(r'\"videoId\":\"([a-zA-Z0-9_-]{11})\"', resp.text)
        if matches:
            break

    if not matches:
        raise HTTPException(status_code=404, detail=last_error or "No video found")

    seen = set()
    video_id = None
    for candidate in matches:
        if candidate in seen:
            continue
        seen.add(candidate)
        video_id = candidate
        break

    if not video_id:
        raise HTTPException(status_code=404, detail="No video found")

    return {
        "video_id": video_id,
        "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "embed_url": f"https://www.youtube.com/embed/{video_id}",
        "watch_url": f"https://www.youtube.com/watch?v={video_id}",
    }
