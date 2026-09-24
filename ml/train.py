"""Train the Layer-1 prospectivity model and export it for the browser.

  validation : leave-one-MINE-out (all zones and all scenes of a mine are held out together), so the
               score is for ground the model has never seen - random K-fold would leak between
               neighbouring zones and look far better than it is
  candidates : expert index (no training) · logistic regression · random forest · XGBoost
  export     : XGBoost trees + bootstrap ensemble (uncertainty) + metrics -> public/js/trained-model.js

Usage: python ml/train.py        (after ml/build_dataset.py)
"""
import datetime, json, os

import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.stats import rankdata
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, precision_recall_curve, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import FEATURES, NAMES, build_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SEED = 42
XGB_PARAMS = dict(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, colsample_bytree=0.8,
                  min_child_weight=2, reg_lambda=1.0, base_score=0.5, tree_method="hist", random_state=SEED, n_jobs=4)


def load():
    df = pd.read_csv(os.path.join(HERE, "data", "training_zones.csv"))
    X = np.full((len(df), len(FEATURES)), np.nan)
    for _, idx in df.groupby(["aoi", "scene"]).indices.items():       # anomalies are per AOI-scene, as in the browser
        X[idx] = build_matrix(df.iloc[idx])
    keep = (df.label >= 0).to_numpy()                                  # drop zones only partly inside a pit
    return df[keep].reset_index(drop=True), X[keep]


def expert_index(df, X):
    """Knowledge-driven baseline: what a geologist would hand-weight. Percentile ranks within each scene."""
    signs = {"ferric_ratio": +1, "clay_ratio": +0.5, "albedo": -1, "ndvi": -1, "lst_c": +1}
    s = np.zeros(len(df))
    for _, idx in df.groupby(["aoi", "scene"]).indices.items():
        for name, w in signs.items():
            v = np.nan_to_num(X[idx, NAMES.index(name)], nan=0.0)
            s[idx] += w * (rankdata(v) / len(v) if w > 0 else 1 - rankdata(v) / len(v)) * abs(w)
    return s / sum(abs(w) for w in signs.values())


def make(kind, pos_weight):
    if kind == "logistic_regression":
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(class_weight="balanced", max_iter=1000))
    if kind == "random_forest":
        return make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=300, min_samples_leaf=3, class_weight="balanced_subsample", random_state=SEED, n_jobs=4))
    return xgb.XGBClassifier(**XGB_PARAMS, scale_pos_weight=pos_weight)


def top_capture(df, y, p, frac=0.05):
    """Exploration metric: share of true manganese zones found in the top 5 % ranked zones of each scene."""
    hit = tot = 0
    for _, idx in df.groupby(["aoi", "scene"]).indices.items():
        if y[idx].sum() == 0:
            continue
        k = max(1, int(round(frac * len(idx))))
        top = idx[np.argsort(-p[idx])[:k]]
        hit += y[top].sum(); tot += min(k, y[idx].sum())
    return hit / tot


def evaluate(df, y, p, probabilistic=True):
    m = {"roc_auc": roc_auc_score(y, p), "pr_auc": average_precision_score(y, p), "top5pct_capture": top_capture(df, y, p)}
    if probabilistic:
        m["brier"] = brier_score_loss(y, p)
    return {k: round(float(v), 4) for k, v in m.items()}


def flatten(tree):
    nodes = {}
    def walk(n):
        nodes[n["nodeid"]] = n
        for ch in n.get("children", []):
            walk(ch)
    walk(tree)
    out = {k: [] for k in "ftlrmvc"}
    for i in range(len(nodes)):
        n, leaf = nodes[i], "leaf" in nodes[i]
        out["f"].append(-1 if leaf else int(n["split"][1:]))
        out["t"].append(0 if leaf else n["split_condition"])
        out["l"].append(0 if leaf else n["yes"]); out["r"].append(0 if leaf else n["no"]); out["m"].append(0 if leaf else n["missing"])
        out["v"].append(n["leaf"] if leaf else 0); out["c"].append(n["cover"])
    return out


def export_booster(model, X):
    bst = model.get_booster()
    bias = float(bst.predict(xgb.DMatrix(X[:1]), pred_contribs=True)[0, -1])
    return {"base_margin": 0.0, "expected_margin": bias, "trees": [flatten(json.loads(t)) for t in bst.get_dump(dump_format="json", with_stats=True)]}


def main():
    df, X = load()
    y, groups = df.label.to_numpy(), df.aoi.to_numpy()
    pos_weight = float(np.sqrt((y == 0).sum() / (y == 1).sum()))      # sqrt: favour recall without wrecking calibration
    print(f"{len(df)} zones · {int(y.sum())} manganese-working zones ({y.mean():.1%}) · {len(set(groups))} mine areas\n")

    kinds = ["logistic_regression", "random_forest", "xgboost"]
    oof = {k: np.zeros(len(df)) for k in kinds}
    for g in sorted(set(groups)):
        tr, te = groups != g, groups == g
        for k in kinds:
            oof[k][te] = make(k, pos_weight).fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]

    results = {"expert_index (no training)": evaluate(df, y, expert_index(df, X), probabilistic=False)}
    results.update({k: evaluate(df, y, oof[k]) for k in kinds})
    print(pd.DataFrame(results).T.to_string(), "\n")

    p = oof["xgboost"]
    per_mine = []
    for g in sorted(set(groups)):
        te = groups == g
        row = {"mine": g, "zones": int(te.sum()), "positives": int(y[te].sum())}
        if y[te].sum():
            row.update(roc_auc=round(float(roc_auc_score(y[te], p[te])), 3), pr_auc=round(float(average_precision_score(y[te], p[te])), 3))
        else:                                                          # coal control: every alarm is a false alarm
            pit = te & (df.workings_frac.to_numpy() >= 0.5)
            row.update(coal_pit_zones=int(pit.sum()), coal_pit_mean_probability=round(float(p[pit].mean()), 3) if pit.any() else None)
        per_mine.append(row)
    print(pd.DataFrame(per_mine).to_string(index=False), "\n")

    # class thresholds from held-out predictions: High = best F1, Moderate = keeps 60 % of known manganese zones
    prec, rec, thr = precision_recall_curve(y, p)
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-9)
    t_high = float(thr[np.argmax(f1[:-1])])
    t_mod = float(min(t_high, np.quantile(p[y == 1], 0.40)))          # 60 % of held-out manganese zones score above this
    mod = p >= t_mod
    hi = p >= t_high
    thresholds = {"high": round(t_high * 100, 1), "moderate": round(t_mod * 100, 1),
                  "high_precision": round(float(y[hi].mean()), 3), "high_recall": round(float(y[hi].sum() / y.sum()), 3),
                  "moderate_precision": round(float(y[mod].mean()), 3), "moderate_recall": round(float(y[mod].sum() / y.sum()), 3)}
    print("thresholds", thresholds)

    # ablation: where does the skill come from? (same hold-out, XGBoost without some feature groups)
    coal_pit = ((df.aoi_kind == "coal") & (df.workings_frac >= 0.5)).to_numpy()
    ablation = []
    for name, drop in [("all features", []), ("without slope", ["slope_deg"]), ("spectral + thermal only (no terrain)", ["slope_deg", "tpi_m"])]:
        cols = [i for i, n in enumerate(NAMES) if n not in drop]
        pa = np.zeros(len(df))
        for g in sorted(set(groups)):
            tr, te = groups != g, groups == g
            pa[te] = make("xgboost", pos_weight).fit(X[tr][:, cols], y[tr]).predict_proba(X[te][:, cols])[:, 1]
        ablation.append({"features": name, **evaluate(df, y, pa), "mean_p_manganese_pits": round(float(pa[y == 1].mean()), 3), "mean_p_coal_pits": round(float(pa[coal_pit].mean()), 3)})
    print(pd.DataFrame(ablation).to_string(index=False), "\n")

    final = make("xgboost", pos_weight).fit(X, y)
    rng = np.random.default_rng(SEED)
    mines, ensemble = sorted(set(groups)), []
    for b in range(8):                                                  # bootstrap over MINES, not zones
        idx = np.concatenate([np.flatnonzero(groups == g) for g in rng.choice(mines, len(mines))])
        if y[idx].sum() == 0:
            continue
        m = xgb.XGBClassifier(**{**XGB_PARAMS, "n_estimators": 80, "random_state": SEED + b}, scale_pos_weight=pos_weight).fit(X[idx], y[idx])
        ensemble.append(m)
    sd = np.std([m.predict_proba(X)[:, 1] for m in ensemble], axis=0) * 100

    contribs = final.get_booster().predict(xgb.DMatrix(X), pred_contribs=True)
    imp = np.abs(contribs[:, :-1]).mean(axis=0)

    model = {
        "name": "MOIL-L1 manganese prospectivity classifier", "version": "2.0.0",
        "type": "XGBoost gradient-boosted trees, exact TreeSHAP explanations, in-browser inference",
        "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "features": FEATURES,
        "weights": {n: round(float(v), 4) for n, v in zip(NAMES, imp / imp.sum())},   # global importance = mean |SHAP|, sums to 1
        "class_thresholds": thresholds,
        "confidence_bands": {"medium": round(float(np.quantile(sd, 0.70)), 1), "low": round(float(np.quantile(sd, 0.90)), 1)},
        "training": {
            "label": "zone >= 50 % inside a mapped working (OpenStreetMap) of a documented MOIL manganese mine",
            "negatives": "all other zones, plus two coal-mine AOIs as hard negatives",
            "sources": "Sentinel-2 L2A + Landsat 8/9 (Microsoft Planetary Computer), Copernicus DEM (Open-Meteo) - same as the live provider",
            "zones": int(len(df)), "positives": int(y.sum()), "mine_areas": mines, "scenes": int(df.scene.nunique()),
            "scene_dates": sorted(df.scene_date.unique().tolist()),
        },
        "validation": {"scheme": "leave-one-mine-out (spatial hold-out of entire mine areas, all seasons)", "models": results, "per_mine": per_mine, "ablation": ablation},
        "limitations": [
            "Labels are surface workings, not drill intercepts: the model learns the surface signature of KNOWN manganese ground and ranks look-alike ground. It cannot see blind ore bodies under cover.",
            "Ablation: most of the skill comes from terrain (ridge position, slope). Spectral indices alone cannot tell manganese pits from coal pits. Ridges are geologically meaningful here (resistant gondite / Mn bands form strike ridges) but part of the signal is the shape of the pit itself.",
            "Only 8 manganese mine areas: metrics have wide error bars. Retrain with MOIL borehole / assay data (ml/README.md).",
            "Trained on the Sausar belt (Madhya Pradesh / Maharashtra). Scores elsewhere are extrapolation.",
        ],
        "booster": export_booster(final, X),
        "ensemble": [export_booster(m, X) for m in ensemble],
    }
    js = "/* GENERATED by ml/train.py - do not edit. Retrain: python ml/build_dataset.py && python ml/train.py */\n" \
         "(function(){var M=" + json.dumps(model, separators=(",", ":")) + ";if(typeof window!=='undefined')window.TrainedModel=M;if(typeof module!=='undefined')module.exports=M;})();\n"
    open(os.path.join(ROOT, "public", "js", "trained-model.js"), "w", encoding="utf-8").write(js)
    json.dump({k: v for k, v in model.items() if k not in ("booster", "ensemble")}, open(os.path.join(HERE, "metrics.json"), "w"), indent=1)

    # reference for ml/verify_runtime.js: one full AOI-scene, raw provider values in, Python answers out
    full = pd.read_csv(os.path.join(HERE, "data", "training_zones.csv"))
    ref = full[(full.aoi == "tirodi") & (full.scene == full[full.aoi == "tirodi"].scene.iloc[0])]
    Xr = build_matrix(ref)
    cr = final.get_booster().predict(xgb.DMatrix(Xr), pred_contribs=True)
    zones = [{"properties": {"zone_id": r.zone, **{f["source"]: (None if pd.isna(getattr(r, f["source"])) else getattr(r, f["source"])) for f in FEATURES}}} for r in ref.itertuples()]
    json.dump({"zones": zones, "probability": final.predict_proba(Xr)[:, 1].tolist(), "shap": cr[:, :-1].tolist(),
               "ensemble_probability": [m.predict_proba(Xr)[:, 1].tolist() for m in ensemble]}, open(os.path.join(HERE, "data", "reference.json"), "w"))
    print(f"\nwrote public/js/trained-model.js ({len(js) / 1024:.0f} KB) · importance:", model["weights"])


if __name__ == "__main__":
    main()
