"""Build the training set from REAL public data - the same sources, grid and band maths as
js/live-provider.js, so a zone looks the same to the model here and in the browser.

  features : Sentinel-2 L2A + Landsat 8/9 LST (Microsoft Planetary Computer), Copernicus DEM (Open-Meteo)
  labels   : 1 = zone lies inside a mapped working of a documented MOIL manganese mine (OpenStreetMap)
             0 = every other zone, including two COAL-mine AOIs as hard negatives, so the model has to
                 separate manganese ground from "any excavated ground"
  groups   : one per mine area, three scenes (seasons) each -> leave-one-mine-out validation

Responses are cached under ml/data/cache, so re-runs are offline and reproducible.
Usage: python ml/build_dataset.py
"""
import hashlib, io, json, math, os, time

import numpy as np
import pandas as pd
import requests
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DATA, CACHE = os.path.join(HERE, "data"), os.path.join(HERE, "data", "cache")
os.makedirs(CACHE, exist_ok=True)

PC = "https://planetarycomputer.microsoft.com/api"
N, HALF_KM, SUB, KM = 16, 2.4, 4, 111.32          # keep equal to js/live-provider.js

# AOIs are centred near the mapped workings (the app's bookmarks are only approximate).
AOIS = [
    {"id": "bharveli", "name": "Balaghat (Bharveli)", "lat": 21.848, "lng": 80.232, "kind": "manganese"},
    {"id": "ukwa", "name": "Ukwa", "lat": 21.966, "lng": 80.452, "kind": "manganese"},
    {"id": "tirodi", "name": "Tirodi", "lat": 21.678, "lng": 79.722, "kind": "manganese"},
    {"id": "chikla", "name": "Chikla", "lat": 21.543, "lng": 79.748, "kind": "manganese"},
    {"id": "sitasaongi", "name": "Sitasaongi", "lat": 21.545, "lng": 79.684, "kind": "manganese"},
    {"id": "dongri", "name": "Dongri Buzurg", "lat": 21.632, "lng": 79.838, "kind": "manganese"},
    {"id": "kandri_munsar", "name": "Kandri-Munsar", "lat": 21.410, "lng": 79.275, "kind": "manganese"},
    {"id": "gumgaon", "name": "Gumgaon", "lat": 21.400, "lng": 78.972, "kind": "manganese"},
    {"id": "gondegaon_coal", "name": "Gondegaon (coal, negative control)", "lat": 21.270, "lng": 79.170, "kind": "coal"},
    {"id": "saoner_coal", "name": "Adasa-Saoner (coal, negative control)", "lat": 21.352, "lng": 78.945, "kind": "coal"},
]
# Dry season, pre-monsoon, post-monsoon: the model must not depend on the acquisition date.
WINDOWS = [("2026-01-15", "2026-03-15"), ("2026-04-01", "2026-06-20"), ("2025-10-20", "2025-12-31")]

session = requests.Session()
session.headers["User-Agent"] = "moil-layer1-training/1.0"


def cached(key, fetch, binary=False):
    path = os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest()[:20] + (".bin" if binary else ".json"))
    if os.path.exists(path):
        with open(path, "rb") as fh:
            return fh.read() if binary else json.loads(fh.read())
    for attempt in range(5):
        try:
            r = fetch()
            if r.status_code == 200:
                with open(path, "wb") as fh:
                    fh.write(r.content)
                return r.content if binary else r.json()
            err = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            err = type(e).__name__
        time.sleep(65 if err == "HTTP 429" else 3 * (attempt + 1))      # Open-Meteo: per-minute quota
    raise RuntimeError(f"{key[:80]}: {err}")


def bbox_of(aoi):
    d_lat, d_lng = HALF_KM / KM, HALF_KM / (KM * math.cos(math.radians(aoi["lat"])))
    return [round(v, 6) for v in (aoi["lng"] - d_lng, aoi["lat"] - d_lat, aoi["lng"] + d_lng, aoi["lat"] + d_lat)]


def search(collection, bbox, flt, window):
    p = {"collections": collection, "bbox": ",".join(map(str, bbox)), "limit": 8, "sortby": "-datetime",
         "filter-lang": "cql2-text", "filter": flt, "datetime": f"{window[0]}T00:00:00Z/{window[1]}T23:59:59Z"}
    fc = cached("stac" + json.dumps(p, sort_keys=True), lambda: session.get(f"{PC}/stac/v1/search", params=p, timeout=90))
    return [{"id": f["id"], "datetime": f["properties"]["datetime"], "cloud": f["properties"].get("eo:cloud_cover")} for f in fc["features"]]


def raster_grid(collection, item, assets, expression, lo, hi, bbox):
    """Zone means of one band-math raster, exactly as rasterGrid() in the provider (8-bit rescaled PNG)."""
    size = N * SUB
    params = [("collection", collection), ("item", item), ("expression", expression), ("rescale", f"{lo},{hi}"), ("asset_as_band", "false")] + [("assets", a) for a in assets]
    url = f"{PC}/data/v1/item/bbox/{','.join(map(str, bbox))}/{size}x{size}.png"
    png = cached("png" + url + json.dumps(params), lambda: session.get(url, params=params, timeout=180), binary=True)
    px = np.asarray(Image.open(io.BytesIO(png)).convert("LA"), dtype=float)
    val, alpha = px[..., 0].reshape(N, SUB, N, SUB), px[..., 1].reshape(N, SUB, N, SUB) > 0
    n = alpha.sum(axis=(1, 3))
    mean = np.where(n > 0, (val * alpha).sum(axis=(1, 3)) / np.maximum(n, 1), np.nan)
    return np.where(n >= SUB * SUB / 2, lo + mean / 255 * (hi - lo), np.nan).ravel()


b = lambda n: f"({n}_b1-1000)"
S2 = {
    "ndvi": (["B08", "B04"], f"({b('B08')}-{b('B04')})/({b('B08')}+{b('B04')})", -1, 1),
    "ndwi": (["B03", "B08"], f"({b('B03')}-{b('B08')})/({b('B03')}+{b('B08')})", -1, 1),
    "ferric_ratio": (["B04", "B02"], f"{b('B04')}/{b('B02')}", 0, 4),
    "clay_ratio": (["B11", "B12"], f"{b('B11')}/{b('B12')}", 0.5, 2.5),
    "albedo": (["B02", "B03", "B04"], f"({b('B02')}+{b('B03')}+{b('B04')})/30000", 0, 0.5),
}
valid_frac = lambda g: np.mean(~np.isnan(g))


def sentinel(bbox, window):
    for sc in search("sentinel-2-l2a", bbox, "eo:cloud_cover<15", window):
        ndvi = raster_grid("sentinel-2-l2a", sc["id"], *S2["ndvi"], bbox)
        if valid_frac(ndvi) < 0.9:
            continue
        grids = {k: raster_grid("sentinel-2-l2a", sc["id"], *S2[k], bbox) for k in S2 if k != "ndvi"}
        return sc, {"ndvi": ndvi, **grids}
    return None, None


def landsat(bbox, window):
    for sc in search("landsat-c2-l2", bbox, "eo:cloud_cover<20 AND platform IN ('landsat-8','landsat-9')", window):
        lst = raster_grid("landsat-c2-l2", sc["id"], ["lwir11"], "lwir11_b1*0.00341802-124.15", 0, 70, bbox)
        if valid_frac(lst) >= 0.9:
            return sc, lst
    return None, np.full(N * N, np.nan)          # the browser treats a failed source as missing too


def terrain(cells):
    elev = []
    for i in range(0, len(cells), 100):
        part = cells[i:i + 100]
        q = {"latitude": ",".join(f"{c[0]:.5f}" for c in part), "longitude": ",".join(f"{c[1]:.5f}" for c in part)}
        elev += cached("dem" + json.dumps(q), lambda: session.get("https://api.open-meteo.com/v1/elevation", params=q, timeout=60))["elevation"]
    e = np.array(elev, dtype=float).reshape(N, N)
    at = lambda r, c: e[min(N - 1, max(0, r)), min(N - 1, max(0, c))]
    cell_m = 2 * HALF_KM * 1000 / N
    tpi, slope = [], []
    for r in range(N):
        for c in range(N):
            tpi.append(at(r, c) - np.mean([at(r + dr, c + dc) for dr in range(-2, 3) for dc in range(-2, 3)]))
            dzdx, dzdy = (at(r, c + 1) - at(r, c - 1)) / (2 * cell_m), (at(r + 1, c) - at(r - 1, c)) / (2 * cell_m)
            slope.append(math.degrees(math.atan(math.hypot(dzdx, dzdy))))
    return e.ravel(), np.array(tpi), np.array(slope)


def in_ring(lng, lat, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        (xi, yi), (xj, yj) = ring[i], ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def workings():
    raw = json.load(open(os.path.join(DATA, "osm_workings_raw.json")))["elements"]
    out = []
    for e in raw:
        if e.get("geometry"):
            t = e.get("tags", {})
            out.append({"osm_id": f"{e['type']}/{e['id']}", "name": t.get("name"), "resource": t.get("resource"), "ring": [(p["lon"], p["lat"]) for p in e["geometry"]]})
    return out


def main():
    polys, rows, scenes = workings(), [], []
    for aoi in AOIS:
        bbox = bbox_of(aoi)
        dx, dy = (bbox[2] - bbox[0]) / N, (bbox[3] - bbox[1]) / N
        cells = [(bbox[3] - (r + 0.5) * dy, bbox[0] + (c + 0.5) * dx) for r in range(N) for c in range(N)]   # row 0 = north
        elev, tpi, slope = terrain(cells)

        # fraction of each zone covered by mapped workings (4x4 sub-points)
        sub = [(k + 0.5) / 4 - 0.5 for k in range(4)]
        local = [p for p in polys if any(bbox[0] <= x <= bbox[2] and bbox[1] <= y <= bbox[3] for x, y in p["ring"])]
        frac = np.array([np.mean([any(in_ring(lng + sx * dx, lat + sy * dy, p["ring"]) for p in local) for sx in sub for sy in sub]) for lat, lng in cells])
        print(f"{aoi['id']:15s} workings={len(local)} zones>=50% inside={int((frac >= .5).sum())}")

        for window in WINDOWS:
            sc, grids = sentinel(bbox, window)
            if sc is None:
                print(f"   {window[0]}..{window[1]}: no cloud-free Sentinel-2 scene"); continue
            lsc, lst = landsat(bbox, window)
            print(f"   S2 {sc['datetime'][:10]} ({sc['cloud']:.1f}% cloud) · LST {lsc['datetime'][:10] if lsc else 'missing'}")
            scenes.append({"aoi": aoi["id"], "sentinel2": sc, "landsat": lsc})
            for i, (lat, lng) in enumerate(cells):
                rows.append({
                    "aoi": aoi["id"], "aoi_kind": aoi["kind"], "scene": sc["id"], "scene_date": sc["datetime"][:10],
                    "zone": f"R{i // N + 1:02d}C{i % N + 1:02d}", "lat": round(lat, 6), "lng": round(lng, 6),
                    **{k: round(float(g[i]), 3) for k, g in grids.items()}, "lst_c": round(float(lst[i]), 1),
                    "elevation_m": round(float(elev[i])), "tpi_m": round(float(tpi[i]), 1), "slope_deg": round(float(slope[i]), 1),
                    "workings_frac": round(float(frac[i]), 3),
                    # manganese pit -> 1 · partly covered -> ambiguous (dropped in training) · everything else, incl. coal pits -> 0
                    "label": (1 if frac[i] >= 0.5 else -1 if frac[i] > 0 else 0) if aoi["kind"] == "manganese" else 0,
                })

    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(DATA, "training_zones.csv"), index=False)
    json.dump({"aois": AOIS, "windows": WINDOWS, "scenes": scenes}, open(os.path.join(DATA, "training_scenes.json"), "w"), indent=1)
    print(f"\n{len(df)} rows · positives {(df.label == 1).sum()} · ambiguous {(df.label == -1).sum()} · negatives {(df.label == 0).sum()}"
          f" (of which coal-pit zones {((df.aoi_kind == 'coal') & (df.workings_frac >= .5)).sum()})")


if __name__ == "__main__":
    main()
