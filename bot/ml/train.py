#!/usr/bin/env python3
"""Train XGBoost, LightGBM, Random Forest, and Logistic Regression for the
Up/Down veto.

Data:
  * synthetic rounds built from public Binance 1m candles (bulk, no key), and
  * real settled trades from data/trades.jsonl (features recorded at entry).

Validation is time-ordered: the hold-out is the most recent slice across all
symbols, plus expanding walk-forward folds. Probabilities are calibrated so
ML_MIN_PROBA means what it says. Real trades are scored out-of-sample before
they are blended into the final fit.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import joblib
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURE_NAMES, feature_row, snapshot_from_klines, vector

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "data" / "ml"
TRADES_LOG = Path(os.environ.get("TRADES_LOG") or (ROOT / "data" / "trades.jsonl"))
HOSTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
]
SYMBOLS = [s.strip().upper() for s in os.environ.get("ML_SYMBOLS", "BTCUSDT,ETHUSDT,BNBUSDT").split(",") if s.strip()]
DAYS = int(os.environ.get("ML_DAYS", "40"))
MIN_AUC = float(os.environ.get("ML_MIN_AUC", "0.52"))
CALIBRATE = os.environ.get("ML_CALIBRATE", "on").lower() != "off"
WF_FOLDS = int(os.environ.get("ML_WF_FOLDS", "4"))
REAL_WEIGHT = float(os.environ.get("ML_REAL_WEIGHT", "3.0"))
MIN_REAL_EVAL = int(os.environ.get("ML_MIN_REAL_EVAL", "30"))
JOBS = int(os.environ.get("ML_JOBS", str(max(1, (os.cpu_count() or 2) - 2))))
HORIZONS = {5: 3, 15: 8, 60: 20}  # minutes → snapshot minutes-remaining


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Synthetic rounds from Binance candles
# ---------------------------------------------------------------------------

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


def build_synthetic(all_klines: dict[str, list]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    X: list[list[float]] = []
    y: list[int] = []
    ts: list[int] = []
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
                ts.append(int(klines[snap_i][0]))
        log(f"  {symbol}: samples so far {len(y)}")
    order = np.argsort(np.asarray(ts))
    return (
        np.asarray(X, dtype=float)[order],
        np.asarray(y, dtype=int)[order],
        np.asarray(ts, dtype=np.int64)[order],
    )


# ---------------------------------------------------------------------------
# Real settled trades (features recorded at entry by the bot)
# ---------------------------------------------------------------------------

def load_real_trades(path: Path = TRADES_LOG) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    X: list[list[float]] = []
    y: list[int] = []
    ts: list[int] = []
    seen: set[str] = set()
    stats = {"rows": 0, "usable": 0, "sim": 0, "file": str(path)}
    if not path.exists():
        return np.empty((0, len(FEATURE_NAMES))), np.empty(0, dtype=int), np.empty(0, dtype=np.int64), stats
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            t = json.loads(raw)
        except json.JSONDecodeError:
            continue
        stats["rows"] += 1
        entry = t.get("entry") or {}
        feats = entry.get("features")
        won = t.get("won")
        side = t.get("side")
        if not isinstance(feats, dict) or won is None or side not in ("UP", "DOWN"):
            continue
        if t.get("dryRun"):
            stats["sim"] += 1
        key = f"{t.get('marketId')}|{t.get('llmProvider')}|{t.get('enteredAt')}"
        if key in seen:
            continue
        seen.add(key)
        try:
            row = {name: float(feats.get(name, 0.0) or 0.0) for name in FEATURE_NAMES}
        except (TypeError, ValueError):
            continue
        up_won = bool(won) if side == "UP" else (not bool(won))
        when = t.get("enteredAt") or t.get("settledAt") or ""
        try:
            ms = int(datetime.fromisoformat(when.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            ms = 0
        X.append(vector(row))
        y.append(1 if up_won else 0)
        ts.append(ms)
    stats["usable"] = len(y)
    if not y:
        return np.empty((0, len(FEATURE_NAMES))), np.empty(0, dtype=int), np.empty(0, dtype=np.int64), stats
    order = np.argsort(np.asarray(ts))
    return (
        np.asarray(X, dtype=float)[order],
        np.asarray(y, dtype=int)[order],
        np.asarray(ts, dtype=np.int64)[order],
        stats,
    )


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def make_models() -> dict:
    models: dict = {}
    try:
        from xgboost import XGBClassifier

        models["xgboost"] = XGBClassifier(
            n_estimators=120,
            max_depth=4,
            learning_rate=0.06,
            subsample=0.9,
            colsample_bytree=0.8,
            min_child_weight=5,
            eval_metric="logloss",
            n_jobs=JOBS,
            verbosity=0,
        )
    except Exception as err:  # noqa: BLE001
        log(f"  skip XGBoost: {err}")
    try:
        from lightgbm import LGBMClassifier

        models["lightgbm"] = LGBMClassifier(
            n_estimators=120,
            max_depth=4,
            num_leaves=15,
            learning_rate=0.06,
            subsample=0.9,
            subsample_freq=1,
            colsample_bytree=0.8,
            min_child_samples=20,
            n_jobs=JOBS,
            verbose=-1,
        )
    except Exception as err:  # noqa: BLE001
        log(f"  skip LightGBM: {err}")
    models["random_forest"] = RandomForestClassifier(
        n_estimators=160,
        max_depth=6,
        min_samples_leaf=8,
        n_jobs=JOBS,
        random_state=42,
    )
    models["logistic"] = Pipeline(
        [
            ("scaler", StandardScaler()),
            ("clf", LogisticRegression(max_iter=600, C=1.0)),
        ]
    )
    return models


def wrap_calibrated(name: str, model, n_train: int):
    if not CALIBRATE:
        return model
    method = "isotonic" if n_train >= 5000 else "sigmoid"
    return CalibratedClassifierCV(model, cv=3, method=method)


def fit(model, X, y, w=None):
    """Fit with sample weights when the estimator accepts them."""
    if w is None:
        model.fit(X, y)
        return model
    try:
        model.fit(X, y, sample_weight=w)
    except (TypeError, ValueError):
        model.fit(X, y)
    return model


def evaluate(model, X, y) -> dict:
    proba = model.predict_proba(X)[:, 1]
    pred = (proba >= 0.5).astype(int)
    out = {"acc": float(accuracy_score(y, pred)), "n": int(len(y))}
    try:
        out["auc"] = float(roc_auc_score(y, proba))
    except ValueError:
        out["auc"] = 0.5
    out["brier"] = float(brier_score_loss(y, proba))
    return out


def walk_forward(name: str, factory, X, y, folds: int) -> list[dict]:
    """Expanding-window folds over time-ordered rows."""
    n = len(y)
    if folds < 2 or n < 2000:
        return []
    edges = np.linspace(0, n, folds + 2, dtype=int)
    out = []
    for i in range(1, folds + 1):
        tr_end, te_end = edges[i], edges[i + 1]
        if te_end - tr_end < 200 or tr_end < 500:
            continue
        model = factory()
        fit(model, X[:tr_end], y[:tr_end])
        res = evaluate(model, X[tr_end:te_end], y[tr_end:te_end])
        res["fold"] = i
        out.append(res)
        log(f"    wf{i}: acc={res['acc']:.3f} auc={res['auc']:.3f} (n={res['n']})")
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    log(f"Training ML filters · {DAYS}d · {', '.join(SYMBOLS)} · calibrate={'on' if CALIBRATE else 'off'} · jobs={JOBS}")
    klines = {sym: fetch_klines(sym, DAYS) for sym in SYMBOLS}
    X, y, ts = build_synthetic(klines)
    if len(y) < 400:
        log(f"Not enough samples ({len(y)}). Need more days of candles.")
        return 1

    # Time-ordered hold-out: the most recent 20% across every symbol.
    cut = int(len(y) * 0.8)
    X_train, X_test = X[:cut], X[cut:]
    y_train, y_test = y[:cut], y[cut:]
    span = (
        datetime.fromtimestamp(int(ts[0]) / 1000, tz=timezone.utc).date().isoformat(),
        datetime.fromtimestamp(int(ts[cut]) / 1000, tz=timezone.utc).date().isoformat(),
        datetime.fromtimestamp(int(ts[-1]) / 1000, tz=timezone.utc).date().isoformat(),
    )
    log(f"samples {len(y)} (train {len(y_train)} / test {len(y_test)}) · up-rate {y.mean():.3f}")
    log(f"time split: train {span[0]} → {span[1]} · hold-out {span[1]} → {span[2]}")

    X_real, y_real, ts_real, real_stats = load_real_trades()
    log(f"real trades: {real_stats['usable']} usable of {real_stats['rows']} rows ({real_stats['sim']} sim) from {real_stats['file']}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "features": FEATURE_NAMES,
        "days": DAYS,
        "symbols": SYMBOLS,
        "min_auc": MIN_AUC,
        "calibrated": CALIBRATE,
        "split": {"train_from": span[0], "holdout_from": span[1], "to": span[2], "train": int(cut), "test": int(len(y) - cut)},
        "real_trades": {**real_stats, "weight": REAL_WEIGHT},
        "models": {},
    }
    kept = 0
    for name, base in make_models().items():
        log(f"fitting {name}…")
        def factory(base=base, n=len(y_train)):
            return wrap_calibrated(name, clone_estimator(base), n)

        # Hold-out on synthetic only (no real rows leak into the test period).
        model = wrap_calibrated(name, clone_estimator(base), len(y_train))
        fit(model, X_train, y_train)
        hold = evaluate(model, X_test, y_test)
        wf = walk_forward(name, factory, X_train, y_train, WF_FOLDS)
        wf_auc = float(np.mean([f["auc"] for f in wf])) if wf else None

        # How well does the synthetic model transfer to real settled trades?
        real_eval = None
        if len(y_real) >= MIN_REAL_EVAL and len(set(y_real.tolist())) > 1:
            real_eval = evaluate(model, X_real, y_real)
            log(f"    real trades (out-of-sample): acc={real_eval['acc']:.3f} auc={real_eval['auc']:.3f} brier={real_eval['brier']:.3f} (n={real_eval['n']})")

        keep = hold["auc"] >= MIN_AUC and (wf_auc is None or wf_auc >= MIN_AUC)
        info = {
            "acc": round(hold["acc"], 4),
            "auc": round(hold["auc"], 4),
            "brier": round(hold["brier"], 4),
            "walk_forward_auc": None if wf_auc is None else round(wf_auc, 4),
            "walk_forward": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in f.items()} for f in wf],
            "real_trades": None if real_eval is None else {k: (round(v, 4) if isinstance(v, float) else v) for k, v in real_eval.items()},
            "kept": keep,
        }
        meta["models"][name] = info
        log(f"  {name}: acc={hold['acc']:.3f} auc={hold['auc']:.3f} wf_auc={'n/a' if wf_auc is None else f'{wf_auc:.3f}'} brier={hold['brier']:.3f} {'KEEP' if keep else 'DROP (coin-flip)'}")
        if not keep:
            stale = OUT_DIR / f"{name}.joblib"
            if stale.exists():
                stale.unlink()
            continue

        # Final model: all synthetic rows + real trades (weighted) so the
        # deployed veto has seen the newest candles and our own outcomes.
        final = wrap_calibrated(name, clone_estimator(base), len(y))
        if len(y_real):
            X_all = np.vstack([X, X_real])
            y_all = np.concatenate([y, y_real])
            w_all = np.concatenate([np.ones(len(y)), np.full(len(y_real), REAL_WEIGHT)])
            fit(final, X_all, y_all, w_all)
        else:
            fit(final, X, y)
        joblib.dump(final, OUT_DIR / f"{name}.joblib")
        kept += 1

    meta["kept"] = kept
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    log(f"wrote {OUT_DIR} · {kept} model(s) kept")
    if kept == 0:
        log("All models looked like a coin flip on the hold-out set. ML filter stays off.")
    return 0


def clone_estimator(model):
    from sklearn.base import clone

    return clone(model)


if __name__ == "__main__":
    raise SystemExit(main())
