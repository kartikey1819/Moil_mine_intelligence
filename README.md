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

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`) and an internet connection for the live satellite and weather feeds. No database server, no API keys.

```bash
git clone https://github.com/kartikey1819/Moil_mine_intelligence.git
cd Moil_mine_intelligence
npm install
npm run dev        # API on http://localhost:8710 + dashboard on http://localhost:5173
```

The first start builds `data/moil.db`: it loads the cached ERA5 and DEM downloads from `data/raw` (or fetches them), simulates the operating history and trains the model. This takes about 30 s. The server then keeps the data current by itself: it appends each missing day, refreshes live weather every hour, and warms forecasts and action plans in the background.

```bash
npm run build && npm start      # production: one server on http://localhost:8710 serving API + dashboard
npm run seed                    # rebuild the database from scratch
npm run verify:model            # prospectivity model: browser runtime == XGBoost (probabilities + SHAP)
```

## Deploy (Vercel, static snapshot)

`npm run build:snapshot` builds the dashboard in snapshot mode. It then starts the API once, waits for the live ingest and cache warm-up, and saves every response the dashboard reads to `dist/snapshot/` (about 850 JSON files, 13 MB). The result is a static site with no server and no cold starts. `vercel.json` already sets this up, so to deploy:

1. vercel.com → **Add New → Project** → import this repository. Leave all settings at their defaults; the build takes about 3 min.
2. For a daily refresh (new weather, forecasts, alerts and plans), go to **Project → Settings → Git → Deploy Hooks** and create a hook for `main`. Add its URL as the GitHub secret `VERCEL_DEPLOY_HOOK_URL`. The workflow in `.github/workflows/refresh-snapshot.yml` then redeploys every day at 06:00 IST.

The snapshot includes every page and every mine: forecasts, SHAP drivers, risk, alerts, action plans, reserves, the 3D block model and drill logs. Satellite Prospecting still calls the public satellite APIs live from the browser. The parts that need a running server are disabled and labelled: the what-if simulator, re-simulation, retraining and CSV import. Run those with `npm run dev`.

## Deploy (Render, full backend + frontend)

`render.yaml` deploys the whole platform as one Render web service: the Express API, the SQLite database and the dashboard.

1. Render dashboard → **New → Blueprint** → connect this GitHub repository → **Apply**. The build takes about 5 min. The app is then at `https://moil-mine-intelligence.onrender.com` (or whatever name Render assigns).
2. **Keep it awake.** Free instances sleep after 15 min without traffic, and the first visit then takes about 1 min.
   - The server pings its own public URL (`RENDER_EXTERNAL_URL`) every 10 min, so it does not go idle.
   - As a backup, `.github/workflows/keep-alive.yml` pings it every 10 min from GitHub. Add the repository variable `RENDER_URL` (Settings → Secrets and variables → Actions → **Variables**) with the service URL.
   - One always-on service uses about 744 of the 750 free instance hours per month, so don't run other free services in the same Render workspace.
3. **Daily refresh (optional).** Go to Render → Service → Settings → **Deploy Hook**, copy the URL, and add it as the GitHub secret `RENDER_DEPLOY_HOOK_URL`. `.github/workflows/refresh-snapshot.yml` then rebuilds the service every day at 06:00 IST.

How it runs on a small instance: the build machine (2 CPU / 8 GB) seeds the database and precomputes the Monte-Carlo forecasts, risk, alerts, reserves and action plans (`npm run build:render`). With `PRECOMPUTED=1`, the server answers those requests instantly from the results. Everything else runs live on the server:
- the what-if simulator and plan re-simulation
- model retraining and CSV import (an import switches to live computation)
- the live weather feed, source health checks and the model registry

The free plan has 0.1 CPU, so a what-if run takes about 20–40 s. On `plan: starter` it takes a few seconds and the service never sleeps.

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
