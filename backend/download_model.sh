#!/usr/bin/env bash
set -euo pipefail
MODEL_DIR="${1:-backend/models}"
HF_TOKEN="${HUGGINGFACE_TOKEN:-}${HUGGINGFACE_API_TOKEN:-}"
BASE_URL="https://huggingface.co/rapminerz/Word2Bezbar-large/resolve/main"
FILES=(
  "word2vec.model"
  "word2vec.model.syn1neg.npy"
  "word2vec.model.wv.vectors.npy"
)
mkdir -p "$MODEL_DIR"
for NAME in "${FILES[@]}"; do
  DEST="$MODEL_DIR/$NAME"
  echo "Downloading $NAME..."
  CMD=(curl -L -o "$DEST" "$BASE_URL/$NAME")
  if [[ -n "$HF_TOKEN" ]]; then
    CMD+=("-H" "Authorization: Bearer $HF_TOKEN")
  fi
  "${CMD[@]}"
done
ls -lh "$MODEL_DIR"
