# Rapantix Redux

Une relecture du concept Rapantix / RapMinerz avec la même logique de découverte de paroles, mais enrichie d'un service Word2Vec entraîné sur les paroles françaises (Word2Bezbar, RapMinerz). Le frontend React/Vite reste proche du flow original, la nouveauté importante est un backend FastAPI qui expose les similarités Word2Vec et remplace la recherche ConceptNet du jeu.

## Architecture
- `frontend`: React + Vite + Tailwind pour l'UI et la récupération des paroles via Genius.
- `backend`: FastAPI + Gensim qui expose un endpoint `/similar` sur un modèle Word2Bezbar (Word2Vec sur des paroles de rap français). Ce service est facultatif mais fournit la détection de mots proches « à l'identique » du jeu original.

## Prérequis
- Node.js **20.19+** (Vite 7 exige 20.19 ou 22.12+, un gestionnaire de versions comme `fnm`, `nvm` ou `volta` facilite la configuration).
- npm ou pnpm livrés avec Node.
- Python 3.10+ (pour le backend FastAPI). `pip` doit pouvoir installer `gensim` et `fastapi`.
- Hugo : Il faut un token Genius personnel pour remplir les paroles dynamiquement. Il est stocké dans un `.env` (voir ci-dessous).

## Frontend
1. Installer les dépendances : `npm install`.
2. Créer un fichier `.env` à la racine avec au minimum :
   ```env
   VITE_SIMILARITY_URL=http://localhost:8000
   VITE_MAX_LOAD_MS=10000
   PROXY_TIMEOUT=8.0
   ```
   La liste d'artistes et les proxys ne sont plus en dur dans le code : ils se trouvent dans `public/game-config.json`.
   Par défaut, le proxy pointe sur `http://localhost:8000/proxy?url={url}` (backend local).
   Tu peux pointer vers un autre fichier via `VITE_GAME_CONFIG_URL`.
   Tu peux éditer librement `public/game-config.json` pour modifier les listes d'artistes, de secours et les proxys.
   Si `topTracks` est présent dans ce fichier, le jeu pioche les sons dans cette liste (sinon il retombe sur `topArtists`).
3. Démarrer le frontend : `npm run dev`.

Le jeu se connecte à Genius pour récupérer les paroles, et ses appels de similarité pointent vers `VITE_SIMILARITY_URL` (par défaut `http://localhost:8000`).

## Backend Word2Vec (Word2Bezbar)
1. Installer les dépendances Python : `pip install -r backend/requirements.txt`.
2. Télécharger le modèle **Word2Bezbar-large** (Word2Vec 300-dim, CBOW, usage académique/research). Tu peux :
   - soit lancer le script d’automatisation :  
     ```bash
     ./backend/download_model.sh
     ```
     Le script écrit dans `backend/models` par défaut, mais tu peux passer un chemin personnalisé en argument ou définir `WORD2VEC_MODEL_PATH`.
   - soit télécharger manuellement les fichiers depuis Hugging Face ([rapminerz/Word2Bezbar-large](https://huggingface.co/rapminerz/Word2Bezbar-large)) :
     ```bash
     mkdir -p backend/models
     curl -L -o backend/models/word2vec.model https://huggingface.co/rapminerz/Word2Bezbar-large/resolve/main/word2vec.model
     curl -L -o backend/models/word2vec.model.syn1neg.npy https://huggingface.co/rapminerz/Word2Bezbar-large/resolve/main/word2vec.model.syn1neg.npy
     curl -L -o backend/models/word2vec.model.wv.vectors.npy https://huggingface.co/rapminerz/Word2Bezbar-large/resolve/main/word2vec.model.wv.vectors.npy
     ```
3. Si tu stockes le modèle ailleurs, définis `WORD2VEC_MODEL_PATH` (dans `.env` ou l’environnement) pour pointer sur `word2vec.model`.  
   Si l’accès Hugging Face est restreint, exporte `HUGGINGFACE_TOKEN` avant de lancer le script (`export HUGGINGFACE_TOKEN=xxxx`).
4. Démarrer le service : `uvicorn backend.app:app --reload --host 0.0.0.0 --port 8000`.

Le backend expose `POST /similar` qui attend un JSON `{"word": "kichta", "topn": 32}` et retourne les mots similaires (Word2Bezbar). Le frontend exploite ce service pour marquer les tokens proches.

Note: Le modèle Word2Bezbar est distribué pour **usage académique/recherche uniquement** et derive de paroles Genius. Respectez la mention « @RapMinerz » dans les projets publics.

## Générer une liste “top tracks” (2017+, rap/hip-hop/R&B)
Pour éviter une simple liste d’artistes en dur, tu peux générer automatiquement une liste de morceaux FR très streamés depuis 2017.
Le script combine :
- **Kworb** (charts Spotify FR, totals) pour les tracks + streams
- **Spotify API** (recommandé) pour filtrer rap/hip-hop/R&B
- **Wikidata** en secours si Spotify ne répond pas
- **Genius** pour récupérer l’année de sortie

Script :
```bash
python3 backend/build_game_config.py \
  --min-year 2017 \
  --min-total 20000000 \
  --target 400 \
  --kworb-limit 1500 \
  --sleep 0.2
```

Notes :
- Le script écrit dans `public/game-config.json` : `topTracks` + `topArtists`.
- Il crée un cache local dans `backend/cache/genius_release_years.json` pour éviter de refaire les requêtes Genius.
- Wikidata peut être lent : relance si besoin.
- Pour de meilleurs résultats (beaucoup plus de titres), définis `SPOTIFY_CLIENT_ID` et `SPOTIFY_CLIENT_SECRET` avant de lancer le script.
- Le script attend un token Genius via `GENIUS_TOKEN` (ou `VITE_GENIUS_TOKEN`) pour récupérer l’année de sortie.
- Pour forcer uniquement des artistes français, ajoute `--require-french` (filtre via Wikidata).
- Si l’API Spotify est indisponible, tu peux forcer le filtre via ta liste d’artistes existante :
  ```bash
  python3 backend/build_game_config.py \
    --filter-mode whitelist \
    --min-year 2017 \
    --min-total 5000000 \
    --target 400 \
    --kworb-limit 1500 \
    --sleep 0.2
  ```

## Lancement complet
1. Assurez-vous que le backend FastAPI est en route (`uvicorn ...`).
2. Lancez `npm run dev` dans la racine.
3. Le bouton de settings (clé) vous permet de changer rapidement le token Genius.

## À améliorer
- Ajouter un loader/événement pour le backend de similarité lorsqu'il est hors ligne.
- Remplacer `fetchWithProxyFallback` par un proxy durable si Genius devient plus strict.
- Envisager de servir le backend Word2Vec via Docker pour déploiement.
