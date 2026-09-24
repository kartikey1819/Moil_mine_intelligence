# MOIL Mine Intelligence

**SIH 2026 · PS 26009 — Using AI/ML and Space Technology to Identify Manganese Reserves and Overcome Production Shortfalls** (Ministry of Steel · MOIL Ltd.)

An end-to-end platform for MOIL's eight Sausar-belt manganese mines. It covers the problem statement's three asks with live space data, a real data layer and validated models:

| Problem statement | What the platform does | Page |
|---|---|---|
| **Identify & map reserves using surface and sub-surface indicators** | Live Sentinel-2 / Landsat / DEM / geology analysis scored by a trained XGBoost model (TreeSHAP explanations). Drill logs go through intercepts, variography and ordinary kriging to a UNFC 111/122/331-333 resource statement, a 3D block model, mine life and proposed infill holes. Surface targets are reconciled with known lodes to find **new** targets. | Satellite Prospecting · Subsurface & Reserves |
| **Predict shortfalls from equipment downtime, weather, blasting delays** | A monotone gradient-boosted model of weekly production attainment, driven by a 240-path Monte-Carlo of equipment reliability (Weibull, fitted from the breakdown log), blasting, pit/mine water, power and roster. Weather is live 16-day forecast plus ERA5 climatology. Outputs: P10/P50/P90, shortfall probability, FY outlook and per-driver TreeSHAP attribution. | Production Forecast · Shortfall Risk & Alerts |
| **Suggest corrective actions** | An optimiser values schedule, blasting, equipment-redeployment (between mines, net of donor loss), maintenance and dewatering actions against the forecast, using common random numbers. It builds a costed plan with ROI, and includes a what-if simulator. | Action Planner |
| **User-friendly dashboard** | Command Center for portfolio status, evidence-backed early warnings, and a Data & Models page with lineage, live source health, model cards, CSV import and retraining. | all |

## Run

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite`) and an internet connection for the live satellite and weather feeds. No database server, no API keys.

```bash
git clone https://github.com/kartikey1819/Moil_mine_intelligence.git
cd Moil_mine_intelligence
npm install
npm run dev        # API on http://localhost:8710 + dashboard on http://localhost:5173
```

The first start builds `data/moil.db`: it loads the cached ERA5 and DEM downloads from `data/raw` (or fetches them), simulates the operating history and trains the model. This takes about 30 s. The server then keeps the data current by itself: it appends each missing day, refreshes live weather every 3 h, and warms forecasts and action plans in the background.

```bash
npm run build && npm start      # production: one server on http://localhost:8710 serving API + dashboard
npm run seed                    # rebuild the database from scratch
npm run verify:model            # prospectivity model: browser runtime == XGBoost (probabilities + SHAP)
```

## Architecture

```
Space & live data            Data layer (SQLite)            Models                                  Dashboard (Vite + ECharts + Leaflet + three.js)
─────────────────            ──────────────────             ──────                                  ─────────────────────────────────────────────
Sentinel-2, Landsat TIRS ─┐                                 Prospectivity XGBoost + TreeSHAP ──────► Satellite Prospecting
Copernicus DEM, Macrostrat├─ live in browser ───────────────(runs client-side)
ERA5-Land, NWP forecast ──┼─► weather_daily ─┐              Ordinary kriging → UNFC ───────────────► Subsurface & Reserves (3D)
NASA GIBS, OSM ───────────┘                  ├─► REST API ─► Production GBM (monotone) + Monte-Carlo ► Production Forecast · Risk
ERP / SCADA (simulated) ────► daily_ops,     │   + worker   Weibull reliability (empirical Bayes)
                              equipment*,    │   pool       Prescriptive optimiser ────────────────► Action Planner
                              blast_log      │              Early-warning engine ──────────────────► Alerts
Drilling DB (simulated) ────► boreholes* ────┘
```

```
server/            Node API — index.mjs (boot, ingest, warm-up), routes.mjs
  config/          mine & fleet configuration, economics
  lib/             SQLite data layer, HTTP client, RNG, dates, worker pool
  sim/             daily mine simulator (drivers + ground truth)
  services/        weather, terrain, forecast, optimizer, reserves, alerts, equipment, sources, ingest
  ml/              gradient-boosted trees (with monotone constraints), production model training / registry
  geology/         ore-body model; seed/ generates drilling and operating history
  workers/         forecast / optimisation / kriging worker
src/               dashboard (ES modules): pages/, lib/, three/, styles/
public/js/         live Earth-observation provider + prospectivity models (shared with model-lab.html)
ml/                Python pipeline that trains the prospectivity model (see ml/README.md)
data/              raw/ (cached ERA5 + DEM, committed), moil.db and models/ (generated)
```

## Data provenance

Real and live data:
- Sentinel-2 L2A and Landsat 8/9 (Planetary Computer)
- ERA5-Land weather history and the 16-day forecast (Open-Meteo)
- Copernicus DEM and SRTM
- Macrostrat geology, OSM workings and NASA GIBS

**Simulated stand-ins** for MOIL's proprietary records:
- daily production and dispatch
- equipment register and breakdown/PM log
- blast log
- drilling and assay database

These are generated by a physically consistent simulator that is driven by the **real** weather and terrain. They are labelled *SIMULATED* throughout the UI. To replace them:
- **Production actuals:** upload a CSV on *Data & Models* (`mine_id, date, actual_t…`) and press *Retrain*.
- **Everything else:** load the corresponding tables (`equipment_events` ← SAP PM, `blast_log` ← blasting register, `boreholes` / `borehole_intervals` ← drilling DB).

The resource figures are an AI-assisted estimate, not a competent-person statement.

## Validation (hold-out)

- **Production model:** last 26 weeks, never used in training. Weekly error (MAE) is about 50% lower than "plan will be met" and about 35% lower than last-4-weeks persistence. Metrics are live on *Data & Models*.
- **Prospectivity model:** leave-one-mine-out ROC-AUC 0.875 vs 0.42 for an expert index (`ml/metrics.json`).
