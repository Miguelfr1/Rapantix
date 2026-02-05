#!/usr/bin/env bash
set -euo pipefail
MODEL_DIR="${1:-backend/models}"
MODEL_REPO="${WORD2VEC_MODEL_REPO:-rapminerz/Word2Bezbar-large}"
HF_TOKEN="${HUGGINGFACE_TOKEN:-}${HUGGINGFACE_API_TOKEN:-}"
BASE_URL="https://huggingface.co/${MODEL_REPO}/resolve/main"
FILES=(
  "word2vec.model"
  "word2vec.model.syn1neg.npy"
  "word2vec.model.wv.vectors.npy"
)
mkdir -p "$MODEL_DIR"
echo "Using model repo: ${MODEL_REPO}"
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
