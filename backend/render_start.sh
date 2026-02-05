#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${WORD2VEC_MODEL_PATH:-/opt/render/project/src/backend/models/word2vec.model}"
MODEL_DIR="$(dirname "$MODEL_PATH")"
MODEL_REPO="${WORD2VEC_MODEL_REPO:-rapminerz/Word2Bezbar-large}"

mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_PATH" ]; then
  if [ -z "${HUGGINGFACE_TOKEN:-}" ]; then
    echo "[render] HUGGINGFACE_TOKEN not set. Model download may fail if repo is gated."
  fi
  echo "[render] Downloading model from ${MODEL_REPO}..."
  curl -L -o "$MODEL_PATH" "https://huggingface.co/${MODEL_REPO}/resolve/main/word2vec.model"
  curl -L -o "${MODEL_PATH}.syn1neg.npy" "https://huggingface.co/${MODEL_REPO}/resolve/main/word2vec.model.syn1neg.npy"
  curl -L -o "${MODEL_PATH}.wv.vectors.npy" "https://huggingface.co/${MODEL_REPO}/resolve/main/word2vec.model.wv.vectors.npy"
fi

echo "[render] Starting uvicorn"
exec uvicorn backend.app:app --host 0.0.0.0 --port "${PORT:-8000}"
