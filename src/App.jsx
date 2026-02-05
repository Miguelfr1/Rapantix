import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Music, Trophy, RefreshCw, AlertCircle, Loader2, Disc } from 'lucide-react';

const SIMILARITY_API_BASE = (import.meta.env.VITE_SIMILARITY_URL || '').replace(/\/+$/, '');
const GAME_CONFIG_URL = import.meta.env.VITE_GAME_CONFIG_URL || '/game-config.json';
const MAX_LOAD_MS = (() => {
  const value = Number(import.meta.env.VITE_MAX_LOAD_MS);
  return Number.isFinite(value) && value > 0 ? value : 10000;
})();

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
  const [loading, setLoading] = useState(true);
  const [isProcessingGuess, setIsProcessingGuess] = useState(false);
  const [error, setError] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [gameConfig, setGameConfig] = useState(null);
  const [win, setWin] = useState(false);
  const [stats, setStats] = useState({ found: 0, total: 0 });
  const [toastMessage, setToastMessage] = useState(null);
  const [youtubeData, setYoutubeData] = useState(null);
  const [youtubeLoading, setYoutubeLoading] = useState(false);
  
  const [similarityServiceHealthy, setSimilarityServiceHealthy] = useState(true);
  const scrollRef = useRef(null);
  const guessInputRef = useRef(null);

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
        setGameConfig({ ...data, proxyTemplates: resolvedProxyTemplates });
        setConfigError(null);
      } catch (err) {
        console.error("Config load failed:", err);
        setConfigError("Configuration du jeu introuvable. Vérifiez game-config.json.");
        setError("Configuration du jeu introuvable. Vérifiez game-config.json.");
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

  const fetchGeniusData = async () => {
    try {
      if (!gameConfig) throw new Error("Config manquante");
      setLoading(true);
      setError(null);
      
      let songUrl = null;
      let songId = null;
      let finalArtist = "";
      let finalTitle = "";
      const { topArtists, topTracks, proxyTemplates } = gameConfig;
      const localLyricsOnly = Boolean(gameConfig?.localLyricsOnly);
      const deadlineMs = Date.now() + MAX_LOAD_MS;
      const remainingMs = () => deadlineMs - Date.now();
      
      const useTracks = Array.isArray(topTracks) && topTracks.length > 0;
      const maxAttempts = useTracks ? 5 : 3;
      const localTracks = localLyricsOnly && useTracks
        ? topTracks.filter((track) => resolveLyricsPath(track))
        : null;

      if (localLyricsOnly && (!useTracks || !localTracks || localTracks.length === 0)) {
        throw new Error("Paroles locales indisponibles");
      }

      // MODE DYNAMIQUE : On essaie de trouver un son aléatoire via l'API
      for (let attempt = 0; attempt < maxAttempts && !songUrl && remainingMs() > 0; attempt++) {
        const randomTrack = useTracks
          ? (localTracks || topTracks)[Math.floor(Math.random() * (localTracks || topTracks).length)]
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
                  processSong({ artist: finalArtist, title: finalTitle, lyrics: cleanedLyrics });
                  setLoading(false);
                  return;
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
        // Recherche via Proxy (sans token)
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
          } catch (e) { console.warn("Proxy Error", e); }
        }
      }

      if (!songUrl) throw new Error("URL non trouvée");

      // SCRAPING / EMBED
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
        
        // Extraction spécifique Genius
        // Selecteur moderne
        const containers = doc.querySelectorAll('[data-lyrics-container="true"]');
        if (containers.length > 0) {
            containers.forEach(c => {
                const clone = c.cloneNode(true);
                clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                fullLyrics += clone.innerText + "\n";
            });
        } else {
            // Selecteur legacy
            fullLyrics = doc.querySelector('.lyrics')?.innerText || "";
        }
      }

      if (!fullLyrics) throw new Error("Pas de paroles trouvées");

      const cleanedLyrics = cleanLyricsText(fullLyrics, finalArtist, finalTitle);
      
      processSong({ artist: finalArtist, title: finalTitle, lyrics: cleanedLyrics });
      setLoading(false);

    } catch (err) {
      console.error("Erreur cycle:", err);
      setError("Erreur de connexion ou délai dépassé. Réessayez.");
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

  const loadGame = () => {
    if (!gameConfig) {
      setError("Configuration du jeu introuvable. Vérifiez game-config.json.");
      setLoading(false);
      return;
    }
    setWin(false);
    setHistory([]);
    setRevealedIndices(new Set());
    setSimilarIndices({});
    setInputValue("");
    setTitleGuessValue("");
    setToastMessage(null);
    fetchGeniusData();
  };

  useEffect(() => {
    if (gameConfig && !configError) {
      loadGame();
    }
  }, [gameConfig, configError]);

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

  // --- LOGIQUE DE JEU ---

  const handleGuess = async (e) => {
    e.preventDefault();
    if (!inputValue.trim() || win || isProcessingGuess) return;

    const guess = inputValue.trim();
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
    if (!titleGuessValue.trim() || win || !song) return;
    const guess = titleGuessValue.trim();
    if (normalize(guess) === normalize(song.title)) {
        setWin(true);
        const allIndices = new Set();
        tokens.forEach(t => { if(t.type === 'word') allIndices.add(t.id) });
        setRevealedIndices(allIndices);
    } else {
        setToastMessage("Ce n'est pas le bon titre...");
        setTimeout(() => setToastMessage(null), 2000);
    }
    setTitleGuessValue("");
  };

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
          </div>
          <button onClick={loadGame} className="p-2 hover:bg-gray-700 rounded-full transition-colors"><RefreshCw size={20} /></button>
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
                <AlertCircle size={48} /><p>{error}</p><button onClick={loadGame} className="px-4 py-2 bg-red-900/50 border border-red-500 rounded">Réessayer</button>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto font-mono text-base sm:text-lg">
                <div className="mb-8 p-4 border border-gray-700 rounded bg-gray-800/50 text-center">
                    <h2 className="text-gray-400 text-sm uppercase tracking-widest mb-2">Morceau Mystère</h2>
                    <div className="flex justify-center gap-2 flex-wrap">
                        <div className="flex gap-2 items-center"><span className="text-gray-500">Artiste:</span>{win ? <span className="text-yellow-400 font-bold">{song.artist}</span> : <span className="bg-gray-700 text-transparent rounded px-2 select-none">??????</span>}</div>
                        <span className="text-gray-600">|</span>
                        <div className="flex gap-2 items-center"><span className="text-gray-500">Titre:</span>{win ? <span className="text-yellow-400 font-bold">{song.title}</span> : <span className="bg-gray-700 text-transparent rounded px-2 select-none">?????????</span>}</div>
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
                 <input type="text" value={titleGuessValue} onChange={(e) => setTitleGuessValue(e.target.value)} placeholder="Titre exact ?" disabled={win || loading || error} className="w-full bg-gray-900 border-2 border-purple-900/50 text-white px-4 py-3 rounded-l-lg focus:outline-none focus:border-purple-500 transition-colors placeholder-gray-500" />
                <button type="submit" disabled={win || loading || error} className="bg-purple-900 hover:bg-purple-700 text-white px-4 py-3 rounded-r-lg font-bold transition-colors disabled:opacity-50"><Disc size={20} /></button>
              </form>
            </div>
            <div className="mt-2 text-center text-xs text-gray-500">
                Source : <span className="text-yellow-400">Genius.com</span> + <span className="text-cyan-400">Word2Bezbar (RapMinerz)</span>
            </div>
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

      {win && song && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-gray-800 border border-gray-600 rounded-xl shadow-2xl max-w-2xl w-full p-6 text-center animate-bounce-in">
            <div className="w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg shadow-yellow-500/20"><Trophy size={32} className="text-black" /></div>
            <h2 className="text-2xl font-bold text-white mb-1">Félicitations !</h2>
            <p className="text-gray-400 mb-6">Vous avez trouvé le morceau.</p>
            <div className="bg-gray-900 p-4 rounded-lg mb-6 border border-gray-700">
              <p className="text-sm text-gray-500 uppercase tracking-wider mb-1">Artiste</p><p className="text-xl font-bold text-yellow-400 mb-3">{song.artist}</p>
              <p className="text-sm text-gray-500 uppercase tracking-wider mb-1">Titre</p><p className="text-xl font-bold text-white">{song.title}</p>
            </div>
            <div className="mb-5">
              <div className="text-xs uppercase tracking-wider text-gray-400 mb-2">Miniature YouTube</div>
              <div className="relative w-full aspect-video rounded-lg overflow-hidden border border-gray-700 bg-gray-900">
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
              <button onClick={loadGame} className="bg-white text-gray-900 px-6 py-2 rounded-lg font-bold hover:bg-gray-200 transition-colors">Rejouer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
