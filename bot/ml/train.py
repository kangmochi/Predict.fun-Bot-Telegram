#!/usr/bin/env python3
"""Train XGBoost, LightGBM, Random Forest, and Logistic Regression on
synthetic Up/Down rounds built from public Binance 1m candles. No API key.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES, feature_row, snapshot_from_klines, vector

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "ml"
HOSTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
]
SYMBOLS = [s.strip().upper() for s in os.environ.get("ML_SYMBOLS", "BTCUSDT,ETHUSDT,BNBUSDT").split(",") if s.strip()]
DAYS = int(os.environ.get("ML_DAYS", "40"))
MIN_AUC = float(os.environ.get("ML_MIN_AUC", "0.52"))
HORIZONS = {5: 3, 15: 8, 60: 20}  # minutes → snapshot minutes-remaining


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_klines(symbol: str, days: int) -> list:
    end = int(time.time() * 1000)
    start = end - days * 24 * 60 * 60 * 1000
    rows: list = []
    cursor = start
    while cursor < end:
        last_err = None
        chunk = None
        qs = f"/api/v3/klines?symbol={symbol}&interval=1m&limit=1000&startTime={cursor}&endTime={end}"
        for host in HOSTS:
            try:
                with urllib.request.urlopen(f"{host}{qs}", timeout=30) as res:
                    chunk = json.loads(res.read().decode())
                break
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
                last_err = err
        if chunk is None:
            raise RuntimeError(f"Binance klines failed for {symbol}: {last_err}")
        if not chunk:
            break
        rows.extend(chunk)
        cursor = int(chunk[-1][0]) + 60_000
        if len(chunk) < 1000:
            break
    log(f"  {symbol}: {len(rows)} 1m candles")
    return rows


def build_dataset(all_klines: dict[str, list]) -> tuple[np.ndarray, np.ndarray]:
    X: list[list[float]] = []
    y: list[int] = []
    for symbol, klines in all_klines.items():
        n = len(klines)
        closes = [float(k[4]) for k in klines]
        for t in range(80, n - 60, 5):
            for horizon, remain in HORIZONS.items():
                end = t + horizon
                if end >= n:
                    continue
                snap_i = end - remain
                if snap_i <= t or snap_i >= end:
                    continue
                strike = closes[t]
                if strike <= 0:
                    continue
                window = klines[snap_i - 79 : snap_i + 1]
                if len(window) < 80:
                    continue
                snap = snapshot_from_klines(window)
                row = feature_row(snap, strike, remain)
                X.append(vector(row))
                y.append(1 if closes[end - 1] > strike else 0)
        log(f"  {symbol}: samples so far {len(y)}")
    return np.asarray(X, dtype=float), np.asarray(y, dtype=int)


def make_models() -> dict:
    models: dict = {}
    try:
        from xgboost import XGBClassifier

        models["xgboost"] = XGBClassifier(
            n_estimators=80,
            max_depth=4,
            learning_rate=0.08,
            subsample=0.9,
            colsample_bytree=0.8,
            eval_metric="logloss",
            n_jobs=2,
            verbosity=0,
        )
    except Exception as err:  # noqa: BLE001
        log(f"  skip XGBoost: {err}")
    try:
        from lightgbm import LGBMClassifier

        models["lightgbm"] = LGBMClassifier(
            n_estimators=80,
            max_depth=4,
            learning_rate=0.08,
            subsample=0.9,
            colsample_bytree=0.8,
            n_jobs=2,
            verbose=-1,
        )
    except Exception as err:  # noqa: BLE001
        log(f"  skip LightGBM: {err}")
    models["random_forest"] = RandomForestClassifier(
        n_estimators=120,
        max_depth=6,
        min_samples_leaf=8,
        n_jobs=2,
        random_state=42,
    )
    models["logistic"] = Pipeline(
        [
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(max_iter=400, C=1.0)),
        ]
    )
    return models


def main() -> int:
    log(f"Training ML filters · {DAYS}d · {', '.join(SYMBOLS)}")
    klines = {sym: fetch_klines(sym, DAYS) for sym in SYMBOLS}
    X, y = build_dataset(klines)
    if len(y) < 400:
        log(f"Not enough samples ({len(y)}). Need more days of candles.")
        return 1
    cut = int(len(y) * 0.8)
    X_train, X_test = X[:cut], X[cut:]
    y_train, y_test = y[:cut], y[cut:]
    log(f"samples {len(y)} (train {len(y_train)} / test {len(y_test)}) · up-rate {y.mean():.3f}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"features": FEATURE_NAMES, "days": DAYS, "symbols": SYMBOLS, "models": {}, "min_auc": MIN_AUC}
    kept = 0
    for name, model in make_models().items():
        log(f"fitting {name}…")
        model.fit(X_train, y_train)
        proba = model.predict_proba(X_test)[:, 1]
        pred = (proba >= 0.5).astype(int)
        acc = float(accuracy_score(y_test, pred))
        try:
            auc = float(roc_auc_score(y_test, proba))
        except ValueError:
            auc = 0.5
        keep = auc >= MIN_AUC
        meta["models"][name] = {"auc": round(auc, 4), "acc": round(acc, 4), "kept": keep}
        log(f"  {name}: acc={acc:.3f} auc={auc:.3f} {'KEEP' if keep else 'DROP (coin-flip)'}")
        if keep:
            joblib.dump(model, OUT_DIR / f"{name}.joblib")
            kept += 1
        else:
            stale = OUT_DIR / f"{name}.joblib"
            if stale.exists():
                stale.unlink()
    meta["kept"] = kept
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log(f"wrote {OUT_DIR} · {kept} model(s) kept")
    if kept == 0:
        log("All models looked like a coin flip on the hold-out set. ML filter stays off.")
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
