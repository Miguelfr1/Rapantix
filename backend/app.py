import os
import re
import time
import random
import string
from threading import Lock
import unicodedata
from pathlib import Path
from functools import lru_cache
from typing import List, Any
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
YOUTUBE_FALLBACK_URL = os.environ.get(
    "YOUTUBE_FALLBACK_URL",
    "https://r.jina.ai/http://www.youtube.com/results",
).strip()
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
TEAM_SESSION_TTL_SECONDS = int(os.environ.get("TEAM_SESSION_TTL_SECONDS", "43200"))
TEAM_MAX_PLAYERS = 2
TEAM_CODE_LENGTH = 6

TEAM_SESSIONS: dict[str, dict[str, Any]] = {}
TEAM_LOCK = Lock()
VERSUS_SESSIONS: dict[str, dict[str, Any]] = {}
VERSUS_LOCK = Lock()

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


class TeamSong(BaseModel):
    artist: str
    title: str
    lyrics: str


class TeamCreateRequest(BaseModel):
    client_id: str
    min_streams: int = 0
    song: TeamSong


class TeamJoinRequest(BaseModel):
    code: str
    client_id: str


class TeamGuessRequest(BaseModel):
    code: str
    client_id: str
    word: str


class TeamTitleGuessRequest(BaseModel):
    code: str
    client_id: str
    title: str


class VersusCreateRequest(BaseModel):
    client_id: str
    min_streams: int = 0
    song: TeamSong


class VersusJoinRequest(BaseModel):
    code: str
    client_id: str


class VersusGuessRequest(BaseModel):
    code: str
    client_id: str
    word: str


class VersusTitleGuessRequest(BaseModel):
    code: str
    client_id: str
    title: str


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


def _cleanup_sessions(session_store: dict[str, dict[str, Any]]) -> None:
    if TEAM_SESSION_TTL_SECONDS <= 0:
        return
    now = time.time()
    expired_codes = [
        code
        for code, session in session_store.items()
        if now - session.get("updated_at", session.get("created_at", now)) > TEAM_SESSION_TTL_SECONDS
    ]
    for code in expired_codes:
        session_store.pop(code, None)


def _cleanup_team_sessions() -> None:
    _cleanup_sessions(TEAM_SESSIONS)


def _cleanup_versus_sessions() -> None:
    _cleanup_sessions(VERSUS_SESSIONS)


def _generate_session_code(session_store: dict[str, dict[str, Any]]) -> str:
    alphabet = string.ascii_uppercase + string.digits
    for _ in range(50):
        code = "".join(random.choice(alphabet) for _ in range(TEAM_CODE_LENGTH))
        if code not in session_store:
            return code
    raise RuntimeError("Unable to generate unique session code")


def _generate_team_code() -> str:
    return _generate_session_code(TEAM_SESSIONS)


def _generate_versus_code() -> str:
    return _generate_session_code(VERSUS_SESSIONS)


def _normalize_guess_value(word: str) -> str:
    normalized = normalize_word(word or "")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _normalize_title_value(value: str) -> str:
    normalized = normalize_word(value or "")
    normalized = re.sub(r"\b(feat|ft|featuring)\b", " ", normalized)
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def _build_team_state(session: dict[str, Any], client_id: str) -> dict[str, Any]:
    players = session.get("players", {})
    title_found_by = session.get("title_found_by", [])
    you_found_title = client_id in title_found_by
    teammate_found_title = any(pid != client_id for pid in title_found_by)
    return {
        "code": session["code"],
        "role": "host" if session.get("host_id") == client_id else "guest",
        "player_count": len(players),
        "is_full": len(players) >= TEAM_MAX_PLAYERS,
        "min_streams": session.get("min_streams", 0),
        "song": session.get("song", {}),
        "guesses": session.get("guesses", []),
        "title_found": len(title_found_by) > 0,
        "title_found_by_count": len(title_found_by),
        "you_found_title": you_found_title,
        "teammate_found_title": teammate_found_title,
    }


def _build_versus_state(session: dict[str, Any], client_id: str) -> dict[str, Any]:
    players = session.get("players", {})
    opponent_id = next((pid for pid in players if pid != client_id), "")
    guesses_by_player = session.get("guesses_by_player", {})
    winner_id = session.get("winner_id") or ""

    return {
        "code": session["code"],
        "role": "host" if session.get("host_id") == client_id else "guest",
        "player_count": len(players),
        "is_full": len(players) >= TEAM_MAX_PLAYERS,
        "min_streams": session.get("min_streams", 0),
        "song": session.get("song", {}),
        "your_guesses": guesses_by_player.get(client_id, []),
        "opponent_guesses": guesses_by_player.get(opponent_id, []),
        "opponent_id": opponent_id,
        "winner_id": winner_id,
        "finished": bool(winner_id),
        "you_won": bool(winner_id) and winner_id == client_id,
        "opponent_won": bool(winner_id) and winner_id != client_id,
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_path": MODEL_PATH}


@app.post("/team/session/create")
def create_team_session(request: TeamCreateRequest):
    client_id = (request.client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not request.song.artist.strip() or not request.song.title.strip() or not request.song.lyrics.strip():
        raise HTTPException(status_code=400, detail="Incomplete song payload")

    with TEAM_LOCK:
        _cleanup_team_sessions()
        code = _generate_team_code()
        now = time.time()
        session = {
            "code": code,
            "host_id": client_id,
            "created_at": now,
            "updated_at": now,
            "min_streams": max(0, int(request.min_streams or 0)),
            "song": request.song.model_dump(),
            "players": {client_id: {"joined_at": now}},
            "guesses": [],
            "guess_index": {},
            "title_found_by": [],
            "next_seq": 1,
        }
        TEAM_SESSIONS[code] = session
        state = _build_team_state(session, client_id)

    return state


@app.post("/team/session/join")
def join_team_session(request: TeamJoinRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")

    with TEAM_LOCK:
        _cleanup_team_sessions()
        session = TEAM_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        players = session.setdefault("players", {})
        if client_id not in players and len(players) >= TEAM_MAX_PLAYERS:
            raise HTTPException(status_code=409, detail="Session is full")

        if client_id not in players:
            players[client_id] = {"joined_at": time.time()}
        session["updated_at"] = time.time()
        state = _build_team_state(session, client_id)

    return state


@app.get("/team/session/{code}/state")
def get_team_session_state(code: str, client_id: str):
    normalized_code = (code or "").strip().upper()
    normalized_client = (client_id or "").strip()
    if not normalized_code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not normalized_client:
        raise HTTPException(status_code=400, detail="Missing client_id")

    with TEAM_LOCK:
        _cleanup_team_sessions()
        session = TEAM_SESSIONS.get(normalized_code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if normalized_client not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")
        session["updated_at"] = time.time()
        state = _build_team_state(session, normalized_client)

    return state


@app.post("/team/session/guess")
def add_team_guess(request: TeamGuessRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    word = (request.word or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not word:
        raise HTTPException(status_code=400, detail="Missing word")

    normalized_word = _normalize_guess_value(word)
    if not normalized_word:
        raise HTTPException(status_code=400, detail="Invalid word")

    with TEAM_LOCK:
        _cleanup_team_sessions()
        session = TEAM_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if client_id not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")

        guess_index = session.setdefault("guess_index", {})
        if normalized_word in guess_index:
            existing_event = guess_index[normalized_word]
            return {"accepted": False, "event": existing_event}

        event = {
            "seq": session["next_seq"],
            "word": word,
            "client_id": client_id,
            "created_at": time.time(),
        }
        session["next_seq"] += 1
        session.setdefault("guesses", []).append(event)
        guess_index[normalized_word] = event
        session["updated_at"] = time.time()
        return {"accepted": True, "event": event}


@app.post("/team/session/title_guess")
def add_team_title_guess(request: TeamTitleGuessRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    title_guess = (request.title or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not title_guess:
        raise HTTPException(status_code=400, detail="Missing title")

    with TEAM_LOCK:
        _cleanup_team_sessions()
        session = TEAM_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if client_id not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")

        target_title = str(session.get("song", {}).get("title", ""))
        if not target_title.strip():
            raise HTTPException(status_code=500, detail="Session song title missing")

        normalized_target = _normalize_title_value(target_title)
        normalized_guess = _normalize_title_value(title_guess)
        if not normalized_target or not normalized_guess:
            raise HTTPException(status_code=400, detail="Invalid title")

        title_found_by = session.setdefault("title_found_by", [])
        correct = normalized_guess == normalized_target
        if correct and client_id not in title_found_by:
            title_found_by.append(client_id)
            session["updated_at"] = time.time()

        state = _build_team_state(session, client_id)
        return {
            "correct": correct,
            "title": target_title if correct else None,
            **state,
        }


@app.post("/versus/session/create")
def create_versus_session(request: VersusCreateRequest):
    client_id = (request.client_id or "").strip()
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not request.song.artist.strip() or not request.song.title.strip() or not request.song.lyrics.strip():
        raise HTTPException(status_code=400, detail="Incomplete song payload")

    with VERSUS_LOCK:
        _cleanup_versus_sessions()
        code = _generate_versus_code()
        now = time.time()
        session = {
            "code": code,
            "host_id": client_id,
            "created_at": now,
            "updated_at": now,
            "min_streams": max(0, int(request.min_streams or 0)),
            "song": request.song.model_dump(),
            "players": {client_id: {"joined_at": now}},
            "guesses_by_player": {client_id: []},
            "guess_index_by_player": {client_id: {}},
            "next_seq": 1,
            "winner_id": "",
        }
        VERSUS_SESSIONS[code] = session
        state = _build_versus_state(session, client_id)

    return state


@app.post("/versus/session/join")
def join_versus_session(request: VersusJoinRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")

    with VERSUS_LOCK:
        _cleanup_versus_sessions()
        session = VERSUS_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        players = session.setdefault("players", {})
        if client_id not in players and len(players) >= TEAM_MAX_PLAYERS:
            raise HTTPException(status_code=409, detail="Session is full")

        if client_id not in players:
            players[client_id] = {"joined_at": time.time()}
            session.setdefault("guesses_by_player", {})[client_id] = []
            session.setdefault("guess_index_by_player", {})[client_id] = {}

        session["updated_at"] = time.time()
        state = _build_versus_state(session, client_id)

    return state


@app.get("/versus/session/{code}/state")
def get_versus_session_state(code: str, client_id: str):
    normalized_code = (code or "").strip().upper()
    normalized_client = (client_id or "").strip()
    if not normalized_code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not normalized_client:
        raise HTTPException(status_code=400, detail="Missing client_id")

    with VERSUS_LOCK:
        _cleanup_versus_sessions()
        session = VERSUS_SESSIONS.get(normalized_code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if normalized_client not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")
        session["updated_at"] = time.time()
        state = _build_versus_state(session, normalized_client)

    return state


@app.post("/versus/session/guess")
def add_versus_guess(request: VersusGuessRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    word = (request.word or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not word:
        raise HTTPException(status_code=400, detail="Missing word")

    normalized_word = _normalize_guess_value(word)
    if not normalized_word:
        raise HTTPException(status_code=400, detail="Invalid word")

    with VERSUS_LOCK:
        _cleanup_versus_sessions()
        session = VERSUS_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if client_id not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")
        if session.get("winner_id"):
            raise HTTPException(status_code=409, detail="Session finished")

        guess_index_by_player = session.setdefault("guess_index_by_player", {})
        player_guess_index = guess_index_by_player.setdefault(client_id, {})
        if normalized_word in player_guess_index:
            existing_event = player_guess_index[normalized_word]
            return {"accepted": False, "event": existing_event}

        event = {
            "seq": session["next_seq"],
            "word": word,
            "client_id": client_id,
            "created_at": time.time(),
        }
        session["next_seq"] += 1
        session.setdefault("guesses_by_player", {}).setdefault(client_id, []).append(event)
        player_guess_index[normalized_word] = event
        session["updated_at"] = time.time()
        return {"accepted": True, "event": event}


@app.post("/versus/session/title_guess")
def add_versus_title_guess(request: VersusTitleGuessRequest):
    code = (request.code or "").strip().upper()
    client_id = (request.client_id or "").strip()
    title_guess = (request.title or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="Missing code")
    if not client_id:
        raise HTTPException(status_code=400, detail="Missing client_id")
    if not title_guess:
        raise HTTPException(status_code=400, detail="Missing title")

    with VERSUS_LOCK:
        _cleanup_versus_sessions()
        session = VERSUS_SESSIONS.get(code)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if client_id not in session.get("players", {}):
            raise HTTPException(status_code=403, detail="Join session first")

        target_title = str(session.get("song", {}).get("title", ""))
        if not target_title.strip():
            raise HTTPException(status_code=500, detail="Session song title missing")

        normalized_target = _normalize_title_value(target_title)
        normalized_guess = _normalize_title_value(title_guess)
        if not normalized_target or not normalized_guess:
            raise HTTPException(status_code=400, detail="Invalid title")

        correct = normalized_guess == normalized_target
        winner_id = str(session.get("winner_id") or "")
        if correct and not winner_id:
            session["winner_id"] = client_id
            session["updated_at"] = time.time()

        state = _build_versus_state(session, client_id)
        return {
            "correct": correct,
            "title": target_title if correct else None,
            **state,
        }


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
    if YOUTUBE_API_KEY:
        api_url = (
            "https://www.googleapis.com/youtube/v3/search"
            f"?part=snippet&type=video&maxResults=1&q={query}&key={YOUTUBE_API_KEY}"
        )
        try:
            with httpx.Client(timeout=PROXY_TIMEOUT, follow_redirects=True) as client:
                resp = client.get(api_url)
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"YouTube API error: {exc}") from exc

        if resp.status_code >= 400:
            raise HTTPException(status_code=resp.status_code, detail="YouTube API upstream error")

        data = resp.json()
        items = data.get("items") or []
        if items:
            video_id = items[0].get("id", {}).get("videoId")
            if video_id:
                return {
                    "video_id": video_id,
                    "thumbnail_url": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
                    "embed_url": f"https://www.youtube.com/embed/{video_id}",
                    "watch_url": f"https://www.youtube.com/watch?v={video_id}",
                }

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
        if not matches:
            matches = re.findall(r'watch\\?v=([a-zA-Z0-9_-]{11})', resp.text)
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
