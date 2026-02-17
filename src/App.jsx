import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Music, Trophy, RefreshCw, AlertCircle, Loader2, Disc, Gamepad2, ChevronLeft, Users, Swords } from 'lucide-react';

const SIMILARITY_API_BASE = (import.meta.env.VITE_SIMILARITY_URL || '').replace(/\/+$/, '');
const GAME_CONFIG_URL = import.meta.env.VITE_GAME_CONFIG_URL || '/game-config.json';
const MAX_LOAD_MS = (() => {
  const value = Number(import.meta.env.VITE_MAX_LOAD_MS);
  return Number.isFinite(value) && value > 0 ? value : 10000;
})();
const STREAM_NUMBER_FORMATTER = new Intl.NumberFormat("fr-FR");

// --- UTILITAIRES DE TEXTE ---

const normalize = (str) => {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
};

const tokenizeArtist = (value) => {
  const norm = normalize(value || "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!norm) return [];
  return norm.split(/\s+/).filter(Boolean);
};

const artistMatches = (primaryArtist, targetArtist) => {
  const primaryTokens = tokenizeArtist(primaryArtist);
  const targetTokens = tokenizeArtist(targetArtist);
  if (primaryTokens.length === 0 || targetTokens.length === 0) return false;
  return targetTokens.every((token) => primaryTokens.includes(token));
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeTitle = (value) => {
  return normalize(value || "")
    .replace(/\b(feat|ft|featuring)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const titleMatches = (resultTitle, targetTitle) => {
  const normResult = normalizeTitle(resultTitle);
  const normTarget = normalizeTitle(targetTitle);
  if (!normResult || !normTarget) return false;
  return normResult.includes(normTarget) || normTarget.includes(normResult);
};

const levenshtein = (a, b) => {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
};

const checkSpellingSimilarity = (target, guess) => {
  const normTarget = normalize(target);
  const normGuess = normalize(guess);

  if (normTarget.length < 3) return false;
  if (normTarget.startsWith(normGuess) && normGuess.length >= 4) return true;
  if (normGuess.startsWith(normTarget) && normTarget.length >= 4) return true;

  const dist = levenshtein(normTarget, normGuess);
  const tolerance = normTarget.length > 5 ? 2 : 1;
  return dist <= tolerance && dist > 0;
};

const getSimilarityBuckets = (similarMap) => {
  const buckets = { strong: 0, mid: 0, low: 0, spelling: 0 };
  Object.values(similarMap || {}).forEach((meta) => {
    if (!meta) return;
    if (typeof meta === "string") {
      buckets.spelling += 1;
      return;
    }
    if (meta.kind === "spelling" || meta.score == null) {
      buckets.spelling += 1;
      return;
    }
    const score = meta.score || 0;
    if (score >= 0.7) buckets.strong += 1;
    else if (score >= 0.6) buckets.mid += 1;
    else buckets.low += 1;
  });
  return buckets;
};

const classifySimilarity = (meta) => {
  if (!meta) return "spelling";
  if (typeof meta === "string") return "spelling";
  if (meta.kind === "spelling" || meta.score == null) return "spelling";
  const score = meta.score || 0;
  if (score >= 0.7) return "strong";
  if (score >= 0.6) return "mid";
  return "low";
};

const similarityClass = (bucket) => {
  switch (bucket) {
    case "strong":
      return "bg-red-900/50 border-red-400/70 text-red-100";
    case "mid":
      return "bg-orange-900/50 border-orange-400/70 text-orange-100";
    case "low":
      return "bg-amber-900/50 border-amber-400/70 text-amber-100";
    default:
      return "bg-sky-900/50 border-sky-400/70 text-sky-100";
  }
};

// NETTOYAGE INTELLIGENT (Avec Contexte Artiste/Titre)
const cleanLyricsText = (text, artist, title) => {
  const safeArtist = escapeRegex(artist);
  const safeTitle = escapeRegex(title);
  let cleaned = text
    // 1. Nettoyage générique des métadonnées
    .replace(/^.*Paroles de la chanson.*$/gim, "")
    .replace(/^.*Paroles de.*$/gim, "")
    .replace(/^.*Produced by.*$/gim, "")
    .replace(/^.*Prod\..*$/gim, "")
    .replace(/Lyrics/gim, "") 
    .replace(/Credits/gim, "")
    
    // 2. Nettoyage CIBLÉ du titre et de l'artiste (lignes exactes uniquement)
    .replace(new RegExp(`^\\s*${safeTitle}\\s*$`, 'gim'), "")
    .replace(new RegExp(`^\\s*${safeArtist}\\s*$`, 'gim'), "")

    // 3. Nettoyage des tags
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .replace(/\[([^\]]+?)\s*[:—–-]\s*[^\]]+?\]/g, "[$1]") // Masque artistes feat
    .replace(/\[(pré|pre)\]/gi, "[Pré-Refrain]")
    .replace(/\[(pré\s*-?\s*refrain|pre\s*-?\s*refrain)\]/gi, "[Pré-Refrain]")
    .replace(/\(.*?\)/g, "")
    .trim();

  // 4. RÈGLE INTELLIGENTE : Coupe avant le premier tag SI le texte est long
  // Cela vire les intros non taggées ou les titres qui trainent
  const firstBracketIndex = cleaned.indexOf('[');
  if (firstBracketIndex !== -1 && firstBracketIndex < 300) { 
      // On coupe seulement si le premier tag n'est pas trop loin (éviter de couper une chanson sans tag)
      cleaned = cleaned.substring(firstBracketIndex);
  }

  cleaned = cleaned
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = MAX_LOAD_MS) => {
  if (timeoutMs <= 0) throw new Error("Timeout");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
};

const fetchWithProxyFallback = async (targetUrl, proxyTemplates = [], deadlineMs = Date.now() + MAX_LOAD_MS) => {
  if (!Array.isArray(proxyTemplates) || proxyTemplates.length === 0) {
    throw new Error("Aucun proxy configuré");
  }

  let lastError = null;
  for (const template of proxyTemplates) {
    try {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw new Error("Timeout");
      const proxyUrl = template.replace("{url}", encodeURIComponent(targetUrl));
      const response = await fetchWithTimeout(proxyUrl, {}, remainingMs);
      if (!response.ok) throw new Error(`Status ${response.status}`);
      return await response.text(); 
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("Proxys échoués");
};

const resolveLyricsPath = (track) => {
  if (!track) return null;
  if (track.lyricsPath) {
    const trimmed = String(track.lyricsPath).replace(/^\/+/, "");
    return `/${trimmed}`;
  }
  if (track.lyricsId) {
    return `/lyrics/${track.lyricsId}.txt`;
  }
  return null;
};

const getTrackTotalStreams = (track) => {
  const value = Number(track?.totalStreams);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

const formatStreamCount = (value) => {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return STREAM_NUMBER_FORMATTER.format(safeValue);
};

const clampNumber = (value, min, max) => Math.min(max, Math.max(min, value));
const TEAM_CLIENT_STORAGE_KEY = "rapgenius_team_client_id";

const createTeamClientId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `client-${Math.random().toString(36).slice(2)}-${Date.now()}`;
};

const getOrCreateTeamClientId = () => {
  if (typeof window === "undefined") return "";
  const existing = window.localStorage.getItem(TEAM_CLIENT_STORAGE_KEY);
  if (existing) return existing;
  const next = createTeamClientId();
  window.localStorage.setItem(TEAM_CLIENT_STORAGE_KEY, next);
  return next;
};

const mergeTeamGuessEvents = (currentEvents = [], nextEvents = []) => {
  const bySeq = new Map();
  [...currentEvents, ...nextEvents].forEach((event) => {
    if (!event || typeof event.seq !== "number") return;
    bySeq.set(event.seq, event);
  });
  const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  if (merged.length !== currentEvents.length) return merged;
  for (let i = 0; i < merged.length; i += 1) {
    const prev = currentEvents[i];
    const next = merged[i];
    if (!prev || !next) return merged;
    if (prev.seq !== next.seq || prev.word !== next.word || prev.client_id !== next.client_id) {
      return merged;
    }
  }
  return currentEvents;
};

const readApiErrorDetail = async (response) => {
  try {
    const data = await response.json();
    if (typeof data?.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // no-op
  }
  return `Status ${response.status}`;
};

const extractLyricsFromEmbedJs = (jsText) => {
  if (!jsText) return null;
  const match = jsText.match(/JSON\.parse\('([\s\S]*?)'\)\)/);
  if (!match) return null;
  try {
    const wrapped = `"${match[1]}"`;
    const html = JSON.parse(wrapped);
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.querySelector('.rg_embed_body');
    if (!body) return null;
    body.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return body.innerText || null;
  } catch (err) {
    console.warn("Embed parse failed:", err);
    return null;
  }
};

export default function App() {
  const [song, setSong] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [titleGuessValue, setTitleGuessValue] = useState("");
  const [history, setHistory] = useState([]);
  const [revealedIndices, setRevealedIndices] = useState(new Set());
  const [similarIndices, setSimilarIndices] = useState({});
  const [loading, setLoading] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [setupStep, setSetupStep] = useState("mode");
  const [activeMode, setActiveMode] = useState(null);
  const [isProcessingGuess, setIsProcessingGuess] = useState(false);
  const [error, setError] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [gameConfig, setGameConfig] = useState(null);
  const [minStreamsThreshold, setMinStreamsThreshold] = useState(0);
  const [soloMinStreams, setSoloMinStreams] = useState(0);
  const [teamMinStreams, setTeamMinStreams] = useState(0);
  const [teamJoinCode, setTeamJoinCode] = useState("");
  const [teamSessionCode, setTeamSessionCode] = useState("");
  const [teamPlayerCount, setTeamPlayerCount] = useState(0);
  const [teamGuesses, setTeamGuesses] = useState([]);
  const [teamYouFoundTitle, setTeamYouFoundTitle] = useState(false);
  const [teamTeammateFoundTitle, setTeamTeammateFoundTitle] = useState(false);
  const [teamTitleRevealed, setTeamTitleRevealed] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState(null);
  const [win, setWin] = useState(false);
  const [showWinOverlay, setShowWinOverlay] = useState(false);
  const [stats, setStats] = useState({ found: 0, total: 0 });
  const [toastMessage, setToastMessage] = useState(null);
  const [youtubeData, setYoutubeData] = useState(null);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  
  const [similarityServiceHealthy, setSimilarityServiceHealthy] = useState(true);
  const scrollRef = useRef(null);
  const guessInputRef = useRef(null);

  const hasTrackPool = Array.isArray(gameConfig?.topTracks) && gameConfig.topTracks.length > 0;
  const minTrackStreams = hasTrackPool
    ? gameConfig.topTracks.reduce((min, track) => Math.min(min, getTrackTotalStreams(track)), Infinity)
    : 0;
  const maxTrackStreams = hasTrackPool
    ? gameConfig.topTracks.reduce((max, track) => Math.max(max, getTrackTotalStreams(track)), 0)
    : 0;
  const sliderMinStreams = Number.isFinite(minTrackStreams) ? minTrackStreams : 0;
  const sliderMaxStreams = maxTrackStreams || Math.max(sliderMinStreams, 1);
  const sliderProgress = sliderMaxStreams > sliderMinStreams
    ? ((soloMinStreams - sliderMinStreams) / (sliderMaxStreams - sliderMinStreams)) * 100
    : 0;
  const soloEligibleTrackCount = hasTrackPool
    ? gameConfig.topTracks.filter((track) => getTrackTotalStreams(track) >= soloMinStreams).length
    : 0;

  const focusGuessInput = useCallback(() => {
    if (win || loading || error || isProcessingGuess) return;
    const active = document.activeElement;
    if (active && active !== guessInputRef.current) {
      const tag = active.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
    }
    guessInputRef.current?.focus();
  }, [win, loading, error, isProcessingGuess]);

  useEffect(() => {
    const loadConfig = async () => {
      setIsConfigLoading(true);
      try {
        const res = await fetch(GAME_CONFIG_URL, { cache: "no-store" });
        if (!res.ok) throw new Error(`Config introuvable (${res.status})`);
        const data = await res.json();
        const hasTracks = Array.isArray(data.topTracks) && data.topTracks.length > 0;
        const hasArtists = Array.isArray(data.topArtists) && data.topArtists.length > 0;
        if (!hasTracks && !hasArtists) {
          throw new Error("Config invalide: topTracks/topArtists manquant");
        }
        if (!Array.isArray(data.proxyTemplates) || data.proxyTemplates.length === 0) {
          throw new Error("Config invalide: proxyTemplates manquant");
        }
        let resolvedProxyTemplates = data.proxyTemplates;
        if (SIMILARITY_API_BASE) {
          const renderProxy = `${SIMILARITY_API_BASE}/proxy?url={url}`;
          resolvedProxyTemplates = data.proxyTemplates.map((template) =>
            template.includes("localhost:8000") ? renderProxy : template
          );
        }
        const resolvedConfig = { ...data, proxyTemplates: resolvedProxyTemplates };
        setGameConfig(resolvedConfig);

        if (hasTracks) {
          const trackMin = resolvedConfig.topTracks.reduce(
            (min, track) => Math.min(min, getTrackTotalStreams(track)),
            Infinity
          );
          const trackMax = resolvedConfig.topTracks.reduce(
            (max, track) => Math.max(max, getTrackTotalStreams(track)),
            0
          );
          const safeTrackMin = Number.isFinite(trackMin) ? trackMin : 0;
          const safeTrackMax = trackMax > 0 ? trackMax : safeTrackMin;
          const defaultThreshold = clampNumber(20_000_000, safeTrackMin, safeTrackMax);
          setSoloMinStreams(defaultThreshold);
          setTeamMinStreams(defaultThreshold);
          setMinStreamsThreshold(defaultThreshold);
        } else {
          setSoloMinStreams(0);
          setTeamMinStreams(0);
          setMinStreamsThreshold(0);
        }

        setError(null);
        setConfigError(null);
      } catch (err) {
        console.error("Config load failed:", err);
        setConfigError("Configuration du jeu introuvable. Vérifiez game-config.json.");
        setError("Configuration du jeu introuvable. Vérifiez game-config.json.");
      } finally {
        setIsConfigLoading(false);
        setLoading(false);
      }
    };
    loadConfig();
  }, []);

  const fetchWord2VecSimilarWords = async (guess) => {
    if (!guess.trim()) return [];
    if (!SIMILARITY_API_BASE) {
      setSimilarityServiceHealthy(false);
      return [];
    }
    try {
      const response = await fetch(`${SIMILARITY_API_BASE}/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: guess, topn: 35 })
      });
      if (!response.ok) throw new Error("Service indisponible");
      const data = await response.json();
      setSimilarityServiceHealthy(true);
      return Array.isArray(data.results)
        ? data.results
            .filter((result) => typeof result.term === "string")
            .map((result) => ({
              term: result.term,
              score: typeof result.score === "number" ? result.score : null,
            }))
        : [];
    } catch (err) {
      console.warn("Word2Bezbar service failed:", err);
      setSimilarityServiceHealthy(false);
      return [];
    }
  };

  const markModelSimilarities = (candidateWords, newRevealed, newSimilar, guess, bucketCounts) => {
    const scoreMap = new Map(
      candidateWords.map((item) => [normalize(item.term), item.score])
    );
    let similarityCount = 0;
    tokens.forEach((token) => {
      if (token.type !== "word" || newRevealed.has(token.id)) return;
      const normToken = normalize(token.value);
      if (scoreMap.has(normToken)) {
        if (!newSimilar[token.id]) {
          newSimilar[token.id] = {
            guess,
            score: scoreMap.get(normToken),
            kind: "model",
          };
          const bucket = classifySimilarity(newSimilar[token.id]);
          if (bucketCounts[bucket] != null) bucketCounts[bucket] += 1;
          similarityCount++;
        }
      }
    });
    return similarityCount;
  };


  // --- LOGIQUE GENIUS (DYNAMIQUE SEULEMENT) ---

  const fetchSongData = async (selectedMinStreams = minStreamsThreshold) => {
    if (!gameConfig) throw new Error("Config manquante");

    let songUrl = null;
    let songId = null;
    let finalArtist = "";
    let finalTitle = "";
    const { topArtists, topTracks, proxyTemplates } = gameConfig;
    const localLyricsOnly = Boolean(gameConfig?.localLyricsOnly);
    const minStreams = Number.isFinite(selectedMinStreams)
      ? Math.max(0, Math.floor(selectedMinStreams))
      : 0;
    const deadlineMs = Date.now() + MAX_LOAD_MS;
    const remainingMs = () => deadlineMs - Date.now();

    const hasTracks = Array.isArray(topTracks) && topTracks.length > 0;
    const filteredTracks = hasTracks
      ? topTracks.filter((track) => getTrackTotalStreams(track) >= minStreams)
      : [];
    if (hasTracks && filteredTracks.length === 0) {
      throw new Error(`Aucun morceau disponible avec au moins ${formatStreamCount(minStreams)} streams`);
    }
    const useTracks = filteredTracks.length > 0;
    const maxAttempts = useTracks ? 5 : 3;
    const localTracks = localLyricsOnly && useTracks
      ? filteredTracks.filter((track) => resolveLyricsPath(track))
      : null;

    if (localLyricsOnly && (!useTracks || !localTracks || localTracks.length === 0)) {
      throw new Error("Paroles locales indisponibles");
    }

    for (let attempt = 0; attempt < maxAttempts && !songUrl && remainingMs() > 0; attempt++) {
      const randomTrack = useTracks
        ? (localTracks || filteredTracks)[Math.floor(Math.random() * (localTracks || filteredTracks).length)]
        : null;
      const randomArtist = useTracks
        ? randomTrack?.artist
        : topArtists[Math.floor(Math.random() * topArtists.length)];
      const randomTitle = useTracks ? randomTrack?.title : "";
      const query = useTracks ? `${randomArtist} ${randomTitle}` : randomArtist;
      console.log(`[Recherche] ${useTracks ? "Titre" : "Artiste"} aléatoire : ${query}`);

      if (useTracks && randomTrack) {
        const localLyricsPath = resolveLyricsPath(randomTrack);
        if (localLyricsPath && remainingMs() > 0) {
          try {
            const response = await fetchWithTimeout(localLyricsPath, {}, remainingMs());
            if (response.ok) {
              const rawLyrics = await response.text();
              if (rawLyrics && rawLyrics.trim()) {
                finalArtist = randomArtist || "";
                finalTitle = randomTitle || "";
                const cleanedLyrics = cleanLyricsText(rawLyrics, finalArtist, finalTitle);
                return { artist: finalArtist, title: finalTitle, lyrics: cleanedLyrics };
              }
            }
          } catch (e) {
            console.warn("Local lyrics fetch failed", e);
          }
        }
        if (localLyricsOnly) {
          continue;
        }
      }

      if (!localLyricsOnly && remainingMs() > 0) {
        try {
          const searchUrl = `https://api.genius.com/search?q=${encodeURIComponent(query)}`;
          const rawJson = await fetchWithProxyFallback(searchUrl, proxyTemplates, deadlineMs);
          const json = JSON.parse(rawJson);
          const hits = Array.isArray(json.response?.hits)
            ? json.response.hits
            : (json.response?.sections?.find(s => s.type === 'song')?.hits || []);
          const artistHits = hits.filter(h =>
            artistMatches(h.result?.primary_artist?.name, randomArtist)
          );
          const titleHits = hits.filter(h =>
            titleMatches(h.result?.title, randomTitle)
          );
          const bothHits = hits.filter(h =>
            artistMatches(h.result?.primary_artist?.name, randomArtist) &&
            titleMatches(h.result?.title, randomTitle)
          );
          const pool =
            bothHits.length > 0
              ? bothHits
              : artistHits.length > 0
                ? artistHits
                : titleHits.length > 0
                  ? titleHits
                  : hits;
          if (pool.length > 0) {
            const randomHit = pool[Math.floor(Math.random() * pool.length)].result;
            songUrl = randomHit.url;
            songId = randomHit.id || null;
            finalArtist = randomHit.primary_artist.name;
            finalTitle = randomHit.title;
            break;
          }
        } catch (e) {
          console.warn("Proxy Error", e);
        }
      }
    }

    if (!songUrl) throw new Error("URL non trouvée");

    let fullLyrics = "";
    if (songId) {
      try {
        const embedUrl = `https://genius.com/songs/${songId}/embed.js`;
        const embedJs = await fetchWithProxyFallback(embedUrl, proxyTemplates, deadlineMs);
        fullLyrics = extractLyricsFromEmbedJs(embedJs) || "";
      } catch (e) {
        console.warn("Embed fetch failed", e);
      }
    }

    if (!fullLyrics) {
      const htmlContent = await fetchWithProxyFallback(songUrl, proxyTemplates, deadlineMs);
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlContent, 'text/html');

      const containers = doc.querySelectorAll('[data-lyrics-container="true"]');
      if (containers.length > 0) {
        containers.forEach(c => {
          const clone = c.cloneNode(true);
          clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
          fullLyrics += clone.innerText + "\n";
        });
      } else {
        fullLyrics = doc.querySelector('.lyrics')?.innerText || "";
      }
    }

    if (!fullLyrics) throw new Error("Pas de paroles trouvées");

    const cleanedLyrics = cleanLyricsText(fullLyrics, finalArtist, finalTitle);
    return { artist: finalArtist, title: finalTitle, lyrics: cleanedLyrics };
  };

  const fetchGeniusData = async (selectedMinStreams = minStreamsThreshold) => {
    try {
      setLoading(true);
      setError(null);
      const songData = await fetchSongData(selectedMinStreams);
      processSong(songData);
      setLoading(false);
    } catch (err) {
      console.error("Erreur cycle:", err);
      const message = err instanceof Error ? err.message : "";
      if (message.includes("Aucun morceau disponible avec au moins")) {
        setError(message);
      } else {
        setError("Erreur de connexion ou délai dépassé. Réessayez.");
      }
      setLoading(false);
    }
  };

  const processSong = (songData) => {
    setSong(songData);
    const rawTokens = songData.lyrics.split(/(\n)|([a-zA-Zà-üÀ-Ü0-9œŒ]+)|([^a-zA-Zà-üÀ-Ü0-9œŒ\n]+)/g).filter(t => t);
    let processedTokens = [];
    let wordCount = 0;
    let insideBrackets = false; 

    rawTokens.forEach((t, i) => {
      if (t === '\n') { processedTokens.push({ type: 'break', value: '\n', id: i }); return; }
      if (t.includes('[')) insideBrackets = true;
      const isWord = /[a-zA-Z0-9à-üÀ-ÜœŒ]/.test(t);
      if (isWord) {
        if (insideBrackets) processedTokens.push({ type: 'header', value: t, id: i });
        else { processedTokens.push({ type: 'word', value: t, id: i, index: wordCount }); wordCount++; }
      } else { processedTokens.push({ type: 'punct', value: t, id: i }); }
      if (t.includes(']')) insideBrackets = false;
    });
    setTokens(processedTokens);
    setStats({ found: 0, total: wordCount });
  };

  const resetRoundState = () => {
    setWin(false);
    setShowWinOverlay(false);
    setHistory([]);
    setRevealedIndices(new Set());
    setSimilarIndices({});
    setInputValue("");
    setTitleGuessValue("");
    setToastMessage(null);
  };

  const loadGame = (selectedMinStreams = minStreamsThreshold) => {
    if (!gameConfig) {
      setError("Configuration du jeu introuvable. Vérifiez game-config.json.");
      setLoading(false);
      return;
    }
    setActiveMode("solo");
    resetRoundState();
    fetchGeniusData(selectedMinStreams);
  };

  const applyTeamSessionState = (data) => {
    if (!data || typeof data !== "object") return;
    setTeamPlayerCount(Number(data.player_count) || 0);
    setTeamGuesses((prev) => mergeTeamGuessEvents(prev, Array.isArray(data.guesses) ? data.guesses : []));

    const titleFound = Boolean(data.title_found);
    const youFound = Boolean(data.you_found_title);
    const teammateFound = Boolean(data.teammate_found_title);
    setTeamYouFoundTitle(youFound);
    setTeamTeammateFoundTitle(teammateFound);

    if (!titleFound) {
      setTeamTitleRevealed(false);
    } else if (youFound) {
      setTeamTitleRevealed(true);
    }
  };

  useEffect(() => {
    focusGuessInput();
  }, [focusGuessInput, song]);

  useEffect(() => {
    if (!song) return;
    if (!SIMILARITY_API_BASE) return;
    let isActive = true;
    setYoutubeLoading(true);
    setYoutubeData(null);
    fetch(`${SIMILARITY_API_BASE}/youtube?q=${encodeURIComponent(`${song.artist} ${song.title}`)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!isActive) return;
        setYoutubeData(data);
      })
      .catch(() => {
        if (!isActive) return;
        setYoutubeData(null);
      })
      .finally(() => {
        if (!isActive) return;
        setYoutubeLoading(false);
      });
    return () => {
      isActive = false;
    };
  }, [song]);

  useEffect(() => {
    if (activeMode !== "team") return;
    if (setupStep !== "playing") return;
    if (!teamSessionCode) return;
    if (!SIMILARITY_API_BASE) return;

    let cancelled = false;
    const clientId = getOrCreateTeamClientId();
    if (!clientId) return;

    const pollState = async () => {
      try {
        const params = new URLSearchParams({ client_id: clientId });
        const response = await fetch(`${SIMILARITY_API_BASE}/team/session/${encodeURIComponent(teamSessionCode)}/state?${params.toString()}`);
        if (!response.ok) throw new Error(await readApiErrorDetail(response));
        const data = await response.json();
        if (cancelled) return;
        applyTeamSessionState(data);
      } catch (err) {
        if (cancelled) return;
        console.warn("Team state polling failed:", err);
      }
    };

    pollState();
    const intervalId = window.setInterval(pollState, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeMode, setupStep, teamSessionCode]);

  useEffect(() => {
    if (activeMode !== "team") return;
    if (setupStep !== "playing") return;
    if (!song) return;

    const orderedEvents = mergeTeamGuessEvents([], teamGuesses);
    const nextRevealed = new Set();
    const nextHistory = [];

    orderedEvents.forEach((event) => {
      const guess = String(event.word || "").trim();
      if (!guess) return;
      const normGuess = normalize(guess);
      const guessVariations = new Set([normGuess, normGuess + "s", normGuess + "x"]);
      if (normGuess.length > 3 && normGuess.endsWith("s")) {
        guessVariations.add(normGuess.slice(0, -1));
      }

      let hitCount = 0;
      tokens.forEach((token) => {
        if (token.type !== "word") return;
        if (guessVariations.has(normalize(token.value))) {
          if (!nextRevealed.has(token.id)) {
            nextRevealed.add(token.id);
            hitCount += 1;
          }
        }
      });

      nextHistory.unshift({
        word: guess,
        hits: hitCount,
        sim: 0,
        buckets: { strong: 0, mid: 0, low: 0, spelling: 0 },
      });
    });

    const totalWords = tokens.reduce((count, token) => (
      token.type === "word" ? count + 1 : count
    ), 0);

    if (teamYouFoundTitle) {
      const allIndices = new Set();
      tokens.forEach((token) => {
        if (token.type === "word") allIndices.add(token.id);
      });
      setRevealedIndices(allIndices);
      setSimilarIndices({});
      setHistory(nextHistory);
      setStats({ found: totalWords, total: totalWords });
      return;
    }

    setRevealedIndices(nextRevealed);
    setSimilarIndices({});
    setHistory(nextHistory);
    setStats({ found: nextRevealed.size, total: totalWords });
  }, [activeMode, setupStep, song, tokens, teamGuesses, teamYouFoundTitle]);

  useEffect(() => {
    if (activeMode !== "team") return;
    if (setupStep !== "playing") return;
    if (!teamYouFoundTitle) return;
    setWin(true);
    setShowWinOverlay(true);
  }, [activeMode, setupStep, teamYouFoundTitle]);

  // --- LOGIQUE DE JEU ---

  const handleGuess = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || win || isProcessingGuess) return;

    const guess = inputValue.trim();

    if (activeMode === "team") {
      if (!SIMILARITY_API_BASE || !teamSessionCode) {
        setToastMessage("Session équipe indisponible.");
        setTimeout(() => setToastMessage(null), 2000);
        return;
      }
      setIsProcessingGuess(true);
      try {
        const response = await fetch(`${SIMILARITY_API_BASE}/team/session/guess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: teamSessionCode,
            client_id: getOrCreateTeamClientId(),
            word: guess,
          }),
        });
        if (!response.ok) throw new Error(await readApiErrorDetail(response));
        const data = await response.json();
        if (data?.event) {
          setTeamGuesses((prev) => mergeTeamGuessEvents(prev, [data.event]));
        }
      } catch (err) {
        console.warn("Team guess submit failed:", err);
        const message = err instanceof Error ? err.message : "Impossible d'envoyer le mot à la session.";
        setToastMessage(message);
        setTimeout(() => setToastMessage(null), 2000);
      } finally {
        setInputValue("");
        setIsProcessingGuess(false);
        setTimeout(focusGuessInput, 0);
      }
      return;
    }

    const normGuess = normalize(guess);
    
    if (history.some(h => normalize(h.word) === normGuess)) {
      setInputValue("");
      return;
    }

    setIsProcessingGuess(true);

    // Pluriels automatiques
    const guessVariations = new Set([normGuess, normGuess + 's', normGuess + 'x']);
    if (normGuess.length > 3 && normGuess.endsWith('s')) {
      guessVariations.add(normGuess.slice(0, -1));
    }

    let hitCount = 0;
    let similarityCount = 0;
    let newRevealed = new Set(revealedIndices);
    let newSimilar = { ...similarIndices };
    const bucketCounts = { strong: 0, mid: 0, low: 0, spelling: 0 };

    tokens.forEach((token) => {
      if (token.type === 'word') {
        const normToken = normalize(token.value);
        
        if (guessVariations.has(normToken)) {
          if (!newRevealed.has(token.id)) {
            newRevealed.add(token.id);
            hitCount++;
            if (newSimilar[token.id]) delete newSimilar[token.id];
          }
        } 
        else if (!newRevealed.has(token.id)) {
          if (checkSpellingSimilarity(token.value, guess)) {
            newSimilar[token.id] = { guess, score: null, kind: "spelling" };
            bucketCounts.spelling += 1;
            similarityCount++;
          }
        }
      }
    });

    if (guess.length >= 2) {
       const modelMatches = await fetchWord2VecSimilarWords(guess);
       if (modelMatches.length > 0) {
           similarityCount += markModelSimilarities(modelMatches, newRevealed, newSimilar, guess, bucketCounts);
       }
    }

    setRevealedIndices(newRevealed);
    setSimilarIndices(newSimilar);
    setHistory([{ word: guess, hits: hitCount, sim: similarityCount, buckets: bucketCounts }, ...history]);
    setStats(prev => ({ ...prev, found: newRevealed.size }));
    setInputValue("");
    setIsProcessingGuess(false);
    setTimeout(focusGuessInput, 0);
  };

  const handleTitleGuess = (e) => {
    e.preventDefault();
    if (!titleGuessValue.trim() || !song) return;

    if (activeMode === "team") {
      if (teamYouFoundTitle || loading || error) return;
      if (!SIMILARITY_API_BASE || !teamSessionCode) {
        setToastMessage("Session équipe indisponible.");
        setTimeout(() => setToastMessage(null), 2000);
        return;
      }

      const guess = titleGuessValue.trim();
      fetch(`${SIMILARITY_API_BASE}/team/session/title_guess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: teamSessionCode,
          client_id: getOrCreateTeamClientId(),
          title: guess,
        }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await readApiErrorDetail(response));
          return response.json();
        })
        .then((data) => {
          applyTeamSessionState(data);
          if (data?.correct) {
            setTeamTitleRevealed(true);
            setWin(true);
            setShowWinOverlay(true);
            const allIndices = new Set();
            tokens.forEach((t) => { if (t.type === "word") allIndices.add(t.id); });
            setRevealedIndices(allIndices);
          } else {
            setToastMessage("Ce n'est pas le bon titre...");
            setTimeout(() => setToastMessage(null), 2000);
          }
        })
        .catch((err) => {
          console.warn("Team title guess failed:", err);
          const message = err instanceof Error ? err.message : "Erreur titre équipe.";
          setToastMessage(message);
          setTimeout(() => setToastMessage(null), 2000);
        });

      setTitleGuessValue("");
      return;
    }

    if (win || !song) return;
    const guess = titleGuessValue.trim();
    if (normalize(guess) === normalize(song.title)) {
        setWin(true);
        setShowWinOverlay(true);
        const allIndices = new Set();
        tokens.forEach(t => { if(t.type === 'word') allIndices.add(t.id) });
        setRevealedIndices(allIndices);
    } else {
        setToastMessage("Ce n'est pas le bon titre...");
        setTimeout(() => setToastMessage(null), 2000);
    }
    setTitleGuessValue("");
  };

  const openModeSelection = () => {
    setSetupStep("mode");
    setActiveMode(null);
    setSong(null);
    setTokens([]);
    setWin(false);
    setShowWinOverlay(false);
    setLoading(false);
    setError(null);
    setStats({ found: 0, total: 0 });
    setYoutubeData(null);
    setYoutubeLoading(false);
    setHistory([]);
    setRevealedIndices(new Set());
    setSimilarIndices({});
    setInputValue("");
    setTitleGuessValue("");
    setToastMessage(null);
    setTeamSessionCode("");
    setTeamJoinCode("");
    setTeamPlayerCount(0);
    setTeamGuesses([]);
    setTeamYouFoundTitle(false);
    setTeamTeammateFoundTitle(false);
    setTeamTitleRevealed(false);
    setTeamError(null);
    setTeamBusy(false);
  };

  const openSoloSetup = () => {
    setSetupStep("solo");
    setError(null);
    setTeamError(null);
  };

  const openTeamSetup = () => {
    setSetupStep("team");
    setError(null);
    setTeamError(null);
  };

  const handleSoloMinStreamsChange = (e) => {
    const parsed = Number(e.target.value);
    if (!Number.isFinite(parsed)) return;
    const safeMin = Number.isFinite(minTrackStreams) ? minTrackStreams : 0;
    const safeMax = maxTrackStreams || Math.max(safeMin, 1);
    setSoloMinStreams(clampNumber(Math.floor(parsed), safeMin, safeMax));
  };

  const handleTeamMinStreamsChange = (e) => {
    const parsed = Number(e.target.value);
    if (!Number.isFinite(parsed)) return;
    const safeMin = Number.isFinite(minTrackStreams) ? minTrackStreams : 0;
    const safeMax = maxTrackStreams || Math.max(safeMin, 1);
    setTeamMinStreams(clampNumber(Math.floor(parsed), safeMin, safeMax));
  };

  const startSoloGame = () => {
    const safeMin = Number.isFinite(minTrackStreams) ? minTrackStreams : 0;
    const safeMax = maxTrackStreams || Math.max(safeMin, 1);
    const appliedThreshold = clampNumber(Math.floor(soloMinStreams), safeMin, safeMax);
    setActiveMode("solo");
    setMinStreamsThreshold(appliedThreshold);
    setSetupStep("playing");
    loadGame(appliedThreshold);
  };

  const createTeamSession = async () => {
    if (!SIMILARITY_API_BASE) {
      setTeamError("Mode équipe indisponible: backend non configuré.");
      return;
    }
    if (!gameConfig) {
      setTeamError("Configuration du jeu introuvable.");
      return;
    }

    try {
      setTeamBusy(true);
      setTeamError(null);
      setLoading(true);
      const safeMin = Number.isFinite(minTrackStreams) ? minTrackStreams : 0;
      const safeMax = maxTrackStreams || Math.max(safeMin, 1);
      const appliedThreshold = clampNumber(Math.floor(teamMinStreams), safeMin, safeMax);
      const songData = await fetchSongData(appliedThreshold);

      const response = await fetch(`${SIMILARITY_API_BASE}/team/session/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: getOrCreateTeamClientId(),
          min_streams: appliedThreshold,
          song: songData,
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorDetail(response));
      const data = await response.json();

      resetRoundState();
      setActiveMode("team");
      setSetupStep("playing");
      setMinStreamsThreshold(Number(data.min_streams) || appliedThreshold);
      setTeamSessionCode(data.code || "");
      setTeamJoinCode(data.code || "");
      setTeamTitleRevealed(false);
      applyTeamSessionState(data);
      setError(null);
      processSong(data.song || songData);
      setLoading(false);
    } catch (err) {
      console.warn("Team create failed:", err);
      setLoading(false);
      const message = err instanceof Error ? err.message : "Impossible de créer la session équipe.";
      setTeamError(message);
    } finally {
      setTeamBusy(false);
    }
  };

  const joinTeamSession = async () => {
    if (!SIMILARITY_API_BASE) {
      setTeamError("Mode équipe indisponible: backend non configuré.");
      return;
    }

    const code = teamJoinCode.trim().toUpperCase();
    if (!code) {
      setTeamError("Entre un code de session.");
      return;
    }

    try {
      setTeamBusy(true);
      setTeamError(null);
      setLoading(true);
      const response = await fetch(`${SIMILARITY_API_BASE}/team/session/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          client_id: getOrCreateTeamClientId(),
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorDetail(response));
      const data = await response.json();
      const sharedSong = data.song;
      if (!sharedSong?.lyrics) throw new Error("Session sans morceau");

      resetRoundState();
      setActiveMode("team");
      setSetupStep("playing");
      setMinStreamsThreshold(Number(data.min_streams) || 0);
      setTeamSessionCode(data.code || code);
      setTeamJoinCode(data.code || code);
      setTeamTitleRevealed(false);
      applyTeamSessionState(data);
      setError(null);
      processSong(sharedSong);
      setLoading(false);
    } catch (err) {
      console.warn("Team join failed:", err);
      setLoading(false);
      const message = err instanceof Error ? err.message : "Impossible de rejoindre la session.";
      setTeamError(message);
    } finally {
      setTeamBusy(false);
    }
  };

  const refreshTeamState = async () => {
    if (!SIMILARITY_API_BASE || !teamSessionCode) return;
    try {
      const params = new URLSearchParams({ client_id: getOrCreateTeamClientId() });
      const response = await fetch(`${SIMILARITY_API_BASE}/team/session/${encodeURIComponent(teamSessionCode)}/state?${params.toString()}`);
      if (!response.ok) throw new Error(await readApiErrorDetail(response));
      const data = await response.json();
      applyTeamSessionState(data);
    } catch (err) {
      console.warn("Team refresh failed:", err);
    }
  };

  const handleRefreshGame = () => {
    if (activeMode === "team") {
      refreshTeamState();
      return;
    }
    loadGame();
  };

  const handleBackToLyrics = () => {
    setShowWinOverlay(false);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (isConfigLoading) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 size={44} className="animate-spin text-yellow-400" />
          <p className="text-sm text-gray-400">Chargement de la configuration...</p>
        </div>
      </div>
    );
  }

  if (configError) {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center border border-red-500/40 bg-red-950/30 rounded-xl p-6">
          <AlertCircle size={40} className="mx-auto text-red-400 mb-3" />
          <p className="text-red-300 mb-4">{configError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg border border-red-400/60 text-red-100 hover:bg-red-900/40"
          >
            Recharger
          </button>
        </div>
      </div>
    );
  }

  if (setupStep !== "playing") {
    return (
      <div className="min-h-screen bg-gray-900 text-gray-100 flex items-center justify-center p-4">
        <div className="w-full max-w-3xl border border-gray-700 rounded-2xl bg-gray-800/70 shadow-xl p-6 sm:p-8">
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="bg-yellow-500 p-2 rounded-lg text-black">
              <Music size={24} />
            </div>
            <h1 className="text-2xl font-bold text-white">
              Rap<span className="text-yellow-400">Genius</span>
            </h1>
          </div>

          {setupStep === "mode" && (
            <>
              <p className="text-center text-gray-300 mb-5">Choisis ton mode de jeu</p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
                <button
                  onClick={openSoloSetup}
                  className="h-full border border-yellow-500/60 bg-yellow-500/10 hover:bg-yellow-500/20 rounded-xl p-5 text-left transition-colors"
                >
                  <div className="flex items-center justify-between min-h-6 mb-2">
                    <div className="flex items-center gap-2 text-yellow-300 font-semibold">
                      <Gamepad2 size={18} />
                      <span>Solo</span>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-transparent select-none">Bientôt</span>
                  </div>
                  <p className="text-sm text-gray-300 min-h-[78px]">Partie classique, morceau aléatoire avec filtre sur les streams.</p>
                </button>

                <button
                  onClick={openTeamSetup}
                  className="h-full border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-xl p-5 text-left transition-colors"
                >
                  <div className="flex items-center justify-between min-h-6 mb-2">
                    <div className="flex items-center gap-2">
                      <Users size={18} className="text-cyan-300" />
                      <span className="text-cyan-200 font-semibold">En équipe</span>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-cyan-300/80">Nouveau</span>
                  </div>
                  <p className="text-sm text-gray-300 min-h-[78px]">Coopérez à 2 sur le même morceau avec un code de session.</p>
                </button>

                <button
                  disabled
                  className="h-full border border-gray-700 bg-gray-900/40 rounded-xl p-5 text-left opacity-70 cursor-not-allowed"
                >
                  <div className="flex items-center justify-between min-h-6 mb-2">
                    <div className="flex items-center gap-2">
                      <Swords size={18} className="text-gray-400" />
                      <span className="text-gray-300 font-semibold">Versus</span>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-gray-500">Bientôt</span>
                  </div>
                  <p className="text-sm text-gray-500 min-h-[78px]">Affrontez un autre joueur en duel sur le même son.</p>
                </button>
              </div>
            </>
          )}

          {setupStep === "solo" && (
            <>
              <button
                onClick={openModeSelection}
                className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 mb-5"
              >
                <ChevronLeft size={16} />
                Retour aux modes
              </button>

              <div className="space-y-5">
                <div>
                  <p className="text-gray-300 text-sm uppercase tracking-wider mb-2">Mode Solo</p>
                  <p className="text-white text-lg font-semibold mb-1">Seuil minimum de streams</p>
                  <p className="text-gray-400 text-sm">Les morceaux proposés auront au moins cette popularité.</p>
                </div>

                {hasTrackPool ? (
                  <>
                    <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-4">
                      <div className="flex justify-between items-center mb-3 text-sm">
                        <span className="text-gray-400">Valeur choisie</span>
                        <span className="text-yellow-300 font-semibold">{formatStreamCount(soloMinStreams)} streams</span>
                      </div>
                      <input
                        type="range"
                        min={sliderMinStreams}
                        max={sliderMaxStreams}
                        step="1000000"
                        value={soloMinStreams}
                        onChange={handleSoloMinStreamsChange}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-yellow-400"
                        style={{
                          background: `linear-gradient(to right, rgb(250 204 21) 0%, rgb(250 204 21) ${sliderProgress}%, rgb(55 65 81) ${sliderProgress}%, rgb(55 65 81) 100%)`,
                        }}
                      />
                      <div className="flex justify-between text-xs text-gray-500 mt-2">
                        <span>{formatStreamCount(sliderMinStreams)}</span>
                        <span>{formatStreamCount(sliderMaxStreams)}</span>
                      </div>
                    </div>

                    <div className="text-sm text-gray-400">
                      {soloEligibleTrackCount} morceau{soloEligibleTrackCount > 1 ? "x" : ""} disponible{soloEligibleTrackCount > 1 ? "s" : ""} avec ce seuil.
                    </div>
                  </>
                ) : (
                  <div className="rounded-xl border border-red-500/40 bg-red-950/20 p-4 text-sm text-red-200">
                    Ce mode Solo nécessite une liste `topTracks` dans la configuration.
                  </div>
                )}

                <button
                  onClick={startSoloGame}
                  disabled={!hasTrackPool || soloEligibleTrackCount === 0}
                  className="w-full py-3 rounded-lg bg-yellow-500 text-gray-900 font-bold hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Lancer la partie
                </button>
              </div>
            </>
          )}

          {setupStep === "team" && (
            <>
              <button
                onClick={openModeSelection}
                className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 mb-5"
              >
                <ChevronLeft size={16} />
                Retour aux modes
              </button>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-cyan-600/40 bg-cyan-900/10 p-4 space-y-4">
                  <div>
                    <p className="text-cyan-300 text-xs uppercase tracking-wider mb-2">Créer une session</p>
                    <p className="text-white font-semibold mb-1">En équipe (2 joueurs)</p>
                    <p className="text-sm text-gray-400">Crée un code puis partage-le à ton coéquipier.</p>
                  </div>

                  {hasTrackPool ? (
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-2">
                        <span>Seuil minimum</span>
                        <span>{formatStreamCount(teamMinStreams)} streams</span>
                      </div>
                      <input
                        type="range"
                        min={sliderMinStreams}
                        max={sliderMaxStreams}
                        step="1000000"
                        value={teamMinStreams}
                        onChange={handleTeamMinStreamsChange}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                      />
                    </div>
                  ) : (
                    <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-3 text-sm text-red-200">
                      `topTracks` requis pour ce mode.
                    </div>
                  )}

                  <button
                    onClick={createTeamSession}
                    disabled={teamBusy || !hasTrackPool}
                    className="w-full py-2.5 rounded-lg bg-cyan-400 text-slate-950 font-semibold hover:bg-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {teamBusy ? "Création..." : "Créer et lancer"}
                  </button>
                </div>

                <div className="rounded-xl border border-gray-700 bg-gray-900/40 p-4 space-y-4">
                  <div>
                    <p className="text-gray-300 text-xs uppercase tracking-wider mb-2">Rejoindre une session</p>
                    <p className="text-white font-semibold mb-1">Entre le code de ton coéquipier</p>
                    <p className="text-sm text-gray-400">Tu rejoins la partie en cours avec les mêmes paroles.</p>
                  </div>

                  <input
                    type="text"
                    value={teamJoinCode}
                    onChange={(e) => setTeamJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
                    placeholder="Code session"
                    className="w-full bg-gray-950 border border-gray-600 text-white px-3 py-2 rounded-lg focus:outline-none focus:border-cyan-400 tracking-widest uppercase"
                  />

                  <button
                    onClick={joinTeamSession}
                    disabled={teamBusy || !teamJoinCode.trim()}
                    className="w-full py-2.5 rounded-lg bg-white text-slate-900 font-semibold hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {teamBusy ? "Connexion..." : "Rejoindre"}
                  </button>
                </div>
              </div>

              {teamError && (
                <div className="mt-4 rounded-lg border border-red-500/40 bg-red-950/20 px-4 py-3 text-sm text-red-200">
                  {teamError}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-sans overflow-hidden relative">
      
      {toastMessage && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-purple-600 text-white px-6 py-3 rounded-full shadow-lg z-50 animate-bounce">
            {toastMessage}
        </div>
      )}

      <header className="bg-gray-800 border-b border-gray-700 p-4 flex items-center justify-between shrink-0 z-10 shadow-md">
        <div className="flex-1"></div>
        <div className="flex items-center gap-3 justify-center">
          <div className="bg-yellow-500 p-2 rounded-lg text-black">
            <Music size={24} />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-white hidden sm:block">
            Rap<span className="text-yellow-400">Genius</span>
          </h1>
        </div>
        
        <div className="flex-1 flex items-center justify-end gap-4 text-sm font-medium">
          <div className="flex flex-col items-end">
            <span className="text-gray-400 text-xs uppercase">Progression</span>
            <span className="text-yellow-400">{stats.found} / {stats.total} mots</span>
            {hasTrackPool && (
              <span className="text-[11px] text-gray-500">Seuil: {formatStreamCount(minStreamsThreshold)} streams</span>
            )}
            {activeMode === "team" && teamSessionCode && (
              <span className="text-[11px] text-cyan-300">Session {teamSessionCode} · {teamPlayerCount}/2</span>
            )}
          </div>
          <button onClick={openModeSelection} className="px-3 py-1.5 text-xs border border-gray-600 hover:bg-gray-700 rounded-lg transition-colors">Modes</button>
          <button onClick={handleRefreshGame} className="p-2 hover:bg-gray-700 rounded-full transition-colors"><RefreshCw size={20} /></button>
        </div>
      </header>

      {/* --- BANDEAU DEBUG (A SUPPRIMER EN PROD) --- 
      {song && (
        <div className="bg-red-500/20 border-b border-red-500/30 p-1 text-center animate-pulse">
            <p className="text-xs font-mono text-red-300">
                🛠️ DEBUG MODE : <span className="font-bold text-white">{song.artist}</span> - <span className="font-bold text-white">{song.title}</span>
            </p>
        </div>
      )}*/}


      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 relative overflow-hidden flex flex-col">
          <div
            ref={scrollRef}
            onClick={focusGuessInput}
            className="flex-1 overflow-y-auto p-4 sm:p-8 space-y-2 text-justify leading-relaxed"
          >
            {loading ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4">
                <Loader2 size={48} className="animate-spin text-yellow-500" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center h-full text-red-400 space-y-4 px-4 text-center">
                <AlertCircle size={48} /><p>{error}</p><button onClick={handleRefreshGame} className="px-4 py-2 bg-red-900/50 border border-red-500 rounded">Réessayer</button>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto font-mono text-base sm:text-lg">
                <div className="mb-8 p-4 border border-gray-700 rounded bg-gray-800/50 text-center">
                    <h2 className="text-gray-400 text-sm uppercase tracking-widest mb-2">Morceau Mystère</h2>
                    <div className="flex justify-center gap-2 flex-wrap">
                        <div className="flex gap-2 items-center"><span className="text-gray-500">Artiste:</span>{win ? <span className="text-yellow-400 font-bold">{song.artist}</span> : <span className="bg-gray-700 text-transparent rounded px-2 select-none">??????</span>}</div>
                        <span className="text-gray-600">|</span>
                        <div className="flex gap-2 items-center"><span className="text-gray-500">Titre:</span>{(win || (activeMode === "team" && teamTitleRevealed)) ? <span className="text-yellow-400 font-bold">{song.title}</span> : <span className="bg-gray-700 text-transparent rounded px-2 select-none">?????????</span>}</div>
                    </div>
                </div>

                <div className="flex flex-wrap gap-x-1 gap-y-2 items-baseline">
                  {tokens.map((token, i) => {
                    if (token.type === 'break') return <div key={i} className="basis-full h-2" />;
                    if (token.type === 'punct') return <span key={i} className="text-gray-500">{token.value}</span>;
                    if (token.type === 'header') return <span key={i} className="text-gray-500 font-bold">{token.value}</span>;

                    const isRevealed = revealedIndices.has(token.id);
                    const similarMeta = similarIndices[token.id];
                    const similarityBucket = classifySimilarity(similarMeta);

                    return (
                      <span key={i} className={`relative px-1 rounded transition-all duration-300 group ${isRevealed ? 'bg-transparent text-white' : 'bg-gray-700 text-transparent select-none cursor-default hover:bg-gray-600'}`}>
                        {token.value}
                        {!isRevealed && similarMeta && (
                          <span
                            className={`absolute inset-0 flex items-center justify-center text-xs font-bold overflow-hidden border rounded z-10 transition-opacity duration-200 group-hover:opacity-0 ${similarityClass(similarityBucket)}`}
                            title={`Similaire à : ${typeof similarMeta === "string" ? similarMeta : similarMeta.guess}`}
                          >
                            {typeof similarMeta === "string" ? similarMeta : similarMeta.guess}
                          </span>
                        )}
                        {!isRevealed && (
                           <span className="absolute inset-0 flex items-center justify-center text-white text-xs font-mono font-bold opacity-0 group-hover:opacity-100 pointer-events-none z-20">
                              {token.value.length}
                           </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="h-32"></div>
          </div>

          <div className="bg-gray-800 border-t border-gray-700 p-4 z-20">
            <div className="max-w-4xl mx-auto w-full flex flex-col md:flex-row gap-4 items-stretch">
              <form onSubmit={handleGuess} className="flex-1 relative flex items-center">
                <input
                  ref={guessInputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Proposez un mot..."
                  disabled={win || loading || error || isProcessingGuess}
                  className="w-full bg-gray-900 border-2 border-gray-600 text-white px-4 py-3 rounded-l-lg focus:outline-none focus:border-yellow-500 transition-colors placeholder-gray-500"
                  autoFocus
                />
                <button
                  type="submit"
                  onMouseDown={(e) => e.preventDefault()}
                  disabled={win || loading || error || isProcessingGuess}
                  className="bg-yellow-600 hover:bg-yellow-700 text-black px-6 py-3 rounded-r-lg font-bold transition-colors disabled:opacity-50 flex items-center justify-center min-w-[60px]"
                >
                  {isProcessingGuess ? <Loader2 size={20} className="animate-spin" /> : <Search size={20} />}
                </button>
              </form>

              <form onSubmit={handleTitleGuess} className="md:w-1/3 relative flex items-center">
                 <input type="text" value={titleGuessValue} onChange={(e) => setTitleGuessValue(e.target.value)} placeholder={activeMode === "team" && teamYouFoundTitle ? "Titre déjà trouvé" : "Titre exact ?"} disabled={win || loading || error || (activeMode === "team" && teamYouFoundTitle)} className="w-full bg-gray-900 border-2 border-purple-900/50 text-white px-4 py-3 rounded-l-lg focus:outline-none focus:border-purple-500 transition-colors placeholder-gray-500" />
                <button type="submit" disabled={win || loading || error || (activeMode === "team" && teamYouFoundTitle)} className="bg-purple-900 hover:bg-purple-700 text-white px-4 py-3 rounded-r-lg font-bold transition-colors disabled:opacity-50"><Disc size={20} /></button>
              </form>
            </div>
            <div className="mt-2 text-center text-xs text-gray-500">
                Source : <span className="text-yellow-400">Genius.com</span> + <span className="text-cyan-400">Word2Bezbar (RapMinerz)</span>
            </div>
            {activeMode === "team" && teamSessionCode && (
              <div className="text-center text-xs text-cyan-300 mt-1">
                Session partagée: {teamSessionCode} ({teamPlayerCount}/2 joueurs)
              </div>
            )}
            {activeMode === "team" && teamTeammateFoundTitle && !teamYouFoundTitle && (
              <div className="mt-2 text-center text-xs text-emerald-300">
                Ton coéquipier a trouvé le titre.
                {!teamTitleRevealed ? (
                  <button
                    onClick={() => setTeamTitleRevealed(true)}
                    className="ml-2 px-2 py-0.5 rounded border border-emerald-400/60 hover:bg-emerald-900/30"
                  >
                    Voir le titre
                  </button>
                ) : (
                  <span className="ml-2 text-emerald-200">Tu peux le saisir, ou continuer à jouer.</span>
                )}
              </div>
            )}
            {!similarityServiceHealthy && (
              <div className="text-center text-xs text-red-500 mt-1">
                Service de similarité RapMinerz injoignable (backend). Vérifie que le serveur Python tourne.
              </div>
            )}
          </div>
        </main>

        <aside className="w-64 bg-gray-800 border-l border-gray-700 hidden lg:flex flex-col">
          <div className="p-4 border-b border-gray-700 font-bold text-gray-300 flex items-center gap-2"><RefreshCw size={16} /> Historique</div>
          <div className="px-4 py-3 border-b border-gray-700">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Proximités</div>
            {(() => {
              const buckets = getSimilarityBuckets(similarIndices);
              return (
                <div className="flex gap-2">
                  <div
                    className="w-9 h-9 rounded-md bg-red-900/60 border border-red-400/60 text-red-100 text-xs font-bold flex items-center justify-center"
                    title="Très proche (>=70%)"
                  >
                    {buckets.strong}
                  </div>
                  <div
                    className="w-9 h-9 rounded-md bg-orange-900/60 border border-orange-400/60 text-orange-100 text-xs font-bold flex items-center justify-center"
                    title="Proche (60-69%)"
                  >
                    {buckets.mid}
                  </div>
                  <div
                    className="w-9 h-9 rounded-md bg-amber-900/60 border border-amber-400/60 text-amber-100 text-xs font-bold flex items-center justify-center"
                    title="Faible (<60%)"
                  >
                    {buckets.low}
                  </div>
                  <div
                    className="w-9 h-9 rounded-md bg-sky-900/60 border border-sky-400/60 text-sky-100 text-xs font-bold flex items-center justify-center"
                    title="Ressemblance orthographique"
                  >
                    {buckets.spelling}
                  </div>
                </div>
              );
            })()}
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {history.map((h, idx) => (
              <div key={idx} className="flex justify-between items-center bg-gray-900/50 p-2 rounded text-sm">
                <span className="text-gray-300 font-medium truncate max-w-[100px]" title={h.word}>{h.word}</span>
                <div className="flex gap-2">
                   {h.sim > 0 && (
                     <div className="flex gap-1">
                       <span className="w-6 h-6 rounded bg-red-900/70 border border-red-400/60 text-red-100 text-[10px] font-bold flex items-center justify-center" title="Très proche">
                         {h.buckets?.strong ?? 0}
                       </span>
                       <span className="w-6 h-6 rounded bg-orange-900/70 border border-orange-400/60 text-orange-100 text-[10px] font-bold flex items-center justify-center" title="Proche">
                         {h.buckets?.mid ?? 0}
                       </span>
                       <span className="w-6 h-6 rounded bg-amber-900/70 border border-amber-400/60 text-amber-100 text-[10px] font-bold flex items-center justify-center" title="Faible">
                         {h.buckets?.low ?? 0}
                       </span>
                       <span className="w-6 h-6 rounded bg-sky-900/70 border border-sky-400/60 text-sky-100 text-[10px] font-bold flex items-center justify-center" title="Orthographe">
                         {h.buckets?.spelling ?? 0}
                       </span>
                     </div>
                   )}
                   <span className={`text-xs px-2 py-0.5 rounded font-bold ${h.hits > 0 ? 'bg-green-900 text-green-400' : 'bg-gray-700 text-gray-500'}`}>{h.hits}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {win && song && showWinOverlay && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4">
          <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-4 sm:p-6 text-center">
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-yellow-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-yellow-500/20">
              <Trophy size={28} className="text-black sm:w-8 sm:h-8" />
            </div>
            <h2 className="text-xl sm:text-2xl font-bold text-white mb-1">Félicitations !</h2>
            <p className="text-sm sm:text-base text-gray-400 mb-5 sm:mb-6">Vous avez trouvé le morceau.</p>
            <div className="bg-gray-900 p-3 sm:p-4 rounded-lg mb-5 sm:mb-6 border border-gray-700">
              <p className="text-xs sm:text-sm text-gray-500 uppercase tracking-wider mb-1">Artiste</p>
              <p className="text-lg sm:text-xl font-bold text-yellow-400 mb-3">{song.artist}</p>
              <p className="text-xs sm:text-sm text-gray-500 uppercase tracking-wider mb-1">Titre</p>
              <p className="text-lg sm:text-xl font-bold text-white">{song.title}</p>
            </div>
            <div className="mb-5">
              <div className="relative w-full max-w-lg mx-auto aspect-video rounded-lg overflow-hidden border border-gray-700 bg-gray-900">
                {youtubeLoading && (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">
                    Recherche de la vidéo...
                  </div>
                )}
                {!youtubeLoading && youtubeData && (
                  <iframe
                    className="absolute inset-0 w-full h-full"
                    src={youtubeData.embed_url}
                    title="YouTube player"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                )}
                {!youtubeLoading && !youtubeData && (
                  <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                    Vidéo introuvable
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleBackToLyrics}
                className="w-full sm:w-auto bg-gray-700 text-gray-100 px-5 py-2 rounded-lg font-semibold hover:bg-gray-600 transition-colors"
              >
                Retour aux paroles
              </button>
              <button
                onClick={activeMode === "team" ? openModeSelection : loadGame}
                className="w-full sm:w-auto bg-white text-gray-900 px-6 py-2 rounded-lg font-bold hover:bg-gray-200 transition-colors"
              >
                {activeMode === "team" ? "Quitter la session" : "Rejouer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
