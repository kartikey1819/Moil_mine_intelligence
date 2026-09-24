# Layer-1 trained prospectivity model

A real, reproducible ML pipeline. No LLM, no API key, no server: the model is trained offline in Python and runs entirely in the browser.

```
python ml/build_dataset.py     # real Sentinel-2 / Landsat / DEM features + labels  -> ml/data/training_zones.csv
python ml/train.py             # leave-one-mine-out validation, export             -> public/js/trained-model.js, ml/metrics.json
node   ml/verify_runtime.js    # browser runtime == XGBoost (probabilities + SHAP)
```
Needs: `pip install numpy pandas scikit-learn xgboost scipy pillow requests`. Downloads are cached in `ml/data/cache`.

## What it is

| | |
|---|---|
| Task | For every 300 m zone: probability that it looks like known Sausar-belt manganese ground |
| Features | Same values `public/js/live-provider.js` measures: ferric ratio, clay ratio, albedo, NDVI, NDWI, LST (as anomalies vs the AOI median, so scene date and season cancel out) + ridge position (TPI) and slope |
| Labels | 1 = zone ≥ 50 % inside an OpenStreetMap-mapped working of a documented MOIL manganese mine (8 mine areas). 0 = everything else, **plus two coal-mine areas as hard negatives** so the model cannot just learn "excavated ground" |
| Data | 10 areas × 3 seasons × 256 zones = 7,680 real zones, 144 positive |
| Model | XGBoost (200 trees, depth 3) + 8-model bootstrap ensemble over mines for uncertainty |
| Explanations | Exact path-dependent TreeSHAP implemented in `public/js/ml-runtime.js`, verified against XGBoost `pred_contribs` to 1e-6 |

## Results (every mine predicted by a model that never saw it)

| Model | ROC-AUC | PR-AUC | Known Mn zones in top-5 % |
|---|---|---|---|
| Hand-weighted spectral index (no training) | 0.42 | 0.018 | 9 % |
| Logistic regression | 0.83 | 0.136 | 44 % |
| Random forest | 0.89 | 0.255 | 54 % |
| **XGBoost (shipped)** | **0.88** | **0.259** | **54 %** |

Random ranking would give PR-AUC ≈ 0.019. Random forest is on par; XGBoost is shipped because its trees export compactly and TreeSHAP is exact.

Ablation (XGBoost, same hold-out):

| Features | PR-AUC | mean p on Mn pits | mean p on coal pits |
|---|---|---|---|
| all | 0.259 | 0.34 | 0.22 |
| without slope | 0.239 | 0.32 | 0.36 |
| spectral + thermal only | 0.057 | 0.19 | 0.45 |

## Limitations — say these before a judge asks

1. **Labels are surface workings, not drill intercepts.** The model ranks ground that resembles known manganese ground. It cannot see blind ore under cover.
2. **Terrain carries most of the skill.** Spectral indices alone cannot separate manganese pits from coal pits. Ridge position is geologically meaningful here (resistant gondite / Mn bands form strike ridges), but some of the signal is the pit's own shape.
3. **Small sample:** 8 manganese areas, 48 distinct positive zones. Per-mine PR-AUC ranges 0.05 – 0.89.
4. Trained only on the Sausar belt.

## Going to production with MOIL data

Replace the label column in `training_zones.csv` with borehole outcomes (`ore_intersected`, or regress `mn_grade_pct`), keep `aoi` as the hold-out group, run `train.py`. Nothing in the browser changes.

## Using it in the dashboard

`public/js/model-trained.js` exposes `window.TrainedProspectivityModel` with the same `scoreAll(features)` / `classify` / `factors` interface as `public/js/model.js`:

```html
<script src="js/trained-model.js"></script><script src="js/ml-runtime.js"></script><script src="js/model-trained.js"></script>
```
```js
const model = window.TrainedProspectivityModel;   // in js/app.js
```
Differences the UI should know: contributions are signed (SHAP) with a `base_rate` first entry so they still sum to the score; `favourability` is null; `result.uncertainty` and `result.base_score` are new; hand-set weights are ignored. `model-lab.html` is a working example.
