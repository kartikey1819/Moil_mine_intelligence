"""Feature definitions shared by training and the browser runtime.

FEATURES is exported verbatim into js/trained-model.js and js/ml-runtime.js applies the same
transforms to live-provider zones, so the model sees identical inputs in Python and in the browser.

Deliberately NOT features:
  dist_workings_km   - the labels are derived from mapped workings (target leakage)
  elevation_m        - absolute height identifies the mine, not the geology
  rainfall / soil    - ~10 km ERA5 grid: one constant per AOI
  lithology          - Macrostrat is one or two polygons per AOI at this scale
"""
import numpy as np

FEATURES = [
    {"name": "ferric_ratio", "source": "ferric_ratio", "transform": "aoi_anomaly", "label": "Ferric-iron / Mn-oxide ratio (S2 B04/B02)"},
    {"name": "clay_ratio", "source": "clay_ratio", "transform": "aoi_anomaly", "label": "Clay / alteration ratio (S2 B11/B12)"},
    {"name": "albedo", "source": "albedo", "transform": "aoi_anomaly", "label": "Visible albedo (dark Mn-oxide ground)"},
    {"name": "ndvi", "source": "ndvi", "transform": "aoi_anomaly", "label": "Vegetation index (NDVI)"},
    {"name": "ndwi", "source": "ndwi", "transform": "aoi_anomaly", "label": "Water / moisture index (NDWI)"},
    {"name": "lst_c", "source": "lst_c", "transform": "aoi_anomaly", "label": "Land-surface temperature"},
    {"name": "tpi_m", "source": "tpi_m", "transform": "raw", "label": "Topographic position (ridge + / valley -)"},
    {"name": "slope_deg", "source": "slope_deg", "transform": "raw", "label": "Terrain slope"},
]
NAMES = [f["name"] for f in FEATURES]


def median_js(values):
    """Same median as ml-runtime.js (mean of the two middle values, missing ignored)."""
    s = np.sort(values[~np.isnan(values)])
    return np.nan if len(s) == 0 else (s[(len(s) - 1) >> 1] + s[len(s) >> 1]) / 2


def build_matrix(df):
    """df: one AOI-scene (raw live-provider columns) -> float matrix [n_zones, n_features], NaN = missing."""
    cols = []
    for f in FEATURES:
        v = df[f["source"]].to_numpy(dtype=float)
        cols.append(v - median_js(v) if f["transform"] == "aoi_anomaly" else v)
    return np.column_stack(cols)
