#!/usr/bin/env bash
# CPU-only ML deps. XGBoost is installed --no-deps so pip does not pull
# the 300MB+ NVIDIA NCCL package (we never use the GPU).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${ML_PYTHON:-$ROOT/.venv/bin/python3}"
if [ ! -x "$PY" ]; then
  PY=python3
fi
"$PY" -m pip install -U pip
"$PY" -m pip install -r "$ROOT/bot/ml/requirements.txt"
"$PY" -m pip install --no-deps "xgboost>=2.0,<3"
echo "ML Python packages ready ($PY)"
