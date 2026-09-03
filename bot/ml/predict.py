#!/usr/bin/env python3
"""Score one feature row with the trained ensemble. --serve reads JSON lines."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import joblib
import numpy as np

from features import FEATURE_NAMES, vector

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "data" / "ml"
NAMES = ["xgboost", "lightgbm", "random_forest", "logistic"]


def load_models() -> dict:
    models = {}
    for name in NAMES:
        path = MODEL_DIR / f"{name}.joblib"
        if path.exists():
            models[name] = joblib.load(path)
    return models


def score(models: dict, features: dict, min_proba: float = 0.55) -> dict:
    row = {name: float(features.get(name, 0) or 0) for name in FEATURE_NAMES}
    x = np.asarray([vector(row)], dtype=float)
    votes = {}
    bits = []
    for name in NAMES:
        model = models.get(name)
        if model is None:
            votes[name] = {"side": "FLAT", "p": None, "ready": False}
            bits.append(f"{_short(name)} —")
            continue
        p = float(model.predict_proba(x)[0, 1])
        if p >= min_proba:
            side = "UP"
        elif p <= 1 - min_proba:
            side = "DOWN"
        else:
            side = "FLAT"
        votes[name] = {"side": side, "p": round(p, 4), "ready": True}
        bits.append(f"{_short(name)} {side}({p * 100:.0f}%)")
    return {"ok": True, "votes": votes, "line": "ML " + " ".join(bits)}


def _short(name: str) -> str:
    return {"xgboost": "XGB", "lightgbm": "LGB", "random_forest": "RF", "logistic": "LR"}.get(name, name)


def main() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    models = load_models()
    min_proba = float(__import__("os").environ.get("ML_MIN_PROBA", "0.55"))
    if "--serve" in sys.argv:
        if not models:
            print(json.dumps({"ok": False, "error": "no trained models in data/ml", "votes": {}, "line": "ML off"}), flush=True)
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
                features = payload.get("features", payload)
                print(json.dumps(score(models, features, min_proba)), flush=True)
            except Exception as err:  # noqa: BLE001
                print(json.dumps({"ok": False, "error": str(err), "votes": {}, "line": "ML error"}), flush=True)
        return 0
    features = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(score(models, features.get("features", features), min_proba)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
