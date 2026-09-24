/* Data-source registry + live health probes for the "Data & Models" page. */
import { probe } from '../lib/http.mjs';
import { all, get, getMeta } from '../lib/db.mjs';

export const SOURCES = [
  { key: 'era5', name: 'ERA5-Land reanalysis', provider: 'ECMWF Copernicus via Open-Meteo', kind: 'Space / reanalysis', feeds: 'Rainfall, soil moisture, land-surface & air temperature (daily history 2015→)', layer: 'Production drivers · risk', live: true,
    url: 'https://archive-api.open-meteo.com/v1/archive?latitude=21.84&longitude=80.23&start_date=2025-01-01&end_date=2025-01-02&daily=precipitation_sum' },
  { key: 'forecast', name: 'Numerical weather forecast (16 days)', provider: 'ECMWF IFS / GFS / ICON via Open-Meteo', kind: 'Forecast', feeds: 'Rain, rain probability, Tmax, soil moisture forecast', layer: 'Shortfall forecast · alerts', live: true,
    url: 'https://api.open-meteo.com/v1/forecast?latitude=21.84&longitude=80.23&daily=precipitation_sum&forecast_days=1' },
  { key: 'sentinel2', name: 'Sentinel-2 L2A multispectral (10–20 m)', provider: 'ESA Copernicus via Microsoft Planetary Computer', kind: 'Space / optical', feeds: 'Ferric-iron & clay ratios, albedo, NDVI, NDWI per 300 m zone', layer: 'Reserve mapping (surface)', live: true,
    url: 'https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a' },
  { key: 'landsat', name: 'Landsat 8/9 thermal (TIRS)', provider: 'USGS via Microsoft Planetary Computer', kind: 'Space / thermal', feeds: 'Land-surface temperature per zone', layer: 'Reserve mapping (surface)', live: true,
    url: 'https://planetarycomputer.microsoft.com/api/stac/v1/collections/landsat-c2-l2' },
  { key: 'dem', name: 'Copernicus DEM GLO-90 / SRTM', provider: 'ESA / NASA via Open-Meteo & OpenTopoData', kind: 'Space / radar', feeds: 'Elevation, slope, topographic position, 3D terrain', layer: 'Reserve mapping · 3D model', live: true,
    url: 'https://api.open-meteo.com/v1/elevation?latitude=21.84&longitude=80.23' },
  { key: 'gibs', name: 'NASA GIBS (IMERG, SMAP, MODIS)', provider: 'NASA EOSDIS', kind: 'Space / imagery tiles', feeds: 'Regional rainfall rate, soil moisture, LST, NDVI map layers', layer: 'Map context', live: true,
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2025-01-01/GoogleMapsCompatible_Level9/0/0/0.jpg' },
  { key: 'macrostrat', name: 'Macrostrat geologic map', provider: 'Macrostrat (CC-BY 4.0)', kind: 'Geology', feeds: 'Mapped lithology & age', layer: 'Reserve mapping (surface)', live: true,
    url: 'https://macrostrat.org/api/v2/geologic_units/map?lat=21.84&lng=80.23' },
  { key: 'osm', name: 'OpenStreetMap mine workings', provider: 'OSM Overpass', kind: 'Vector', feeds: 'Quarries, pits, shafts, adits', layer: 'Reserve mapping · labels', live: true,
    url: 'https://overpass-api.de/api/status' },
];

let cached = { at: 0, value: null };
export async function sourceHealth() {
  if (cached.value && Date.now() - cached.at < 5 * 60e3) return cached.value;
  const probes = await Promise.all(SOURCES.map(async (s) => ({ ...s, ...(await probe(s.url)) })));
  const count = (t) => get(`SELECT COUNT(*) n FROM ${t}`).n;
  const internal = [
    { key: 'ops', name: 'Daily production & drivers', table: 'daily_ops', rows: count('daily_ops'), range: get('SELECT MIN(date) a, MAX(date) b FROM daily_ops'), provenance: 'SIMULATED operations driven by real ERA5 weather — replace with MOIL ERP / shift reports', kind: 'Operational' },
    { key: 'equipment', name: 'Equipment register', table: 'equipment', rows: count('equipment'), provenance: 'Representative fleet — replace with MOIL asset register (SAP PM)', kind: 'Operational' },
    { key: 'events', name: 'Breakdown & PM log', table: 'equipment_events', rows: count('equipment_events'), provenance: 'SIMULATED — replace with maintenance work orders', kind: 'Operational' },
    { key: 'blasts', name: 'Blast log', table: 'blast_log', rows: count('blast_log'), provenance: 'SIMULATED — replace with blasting register', kind: 'Operational' },
    { key: 'weather', name: 'Weather history (real)', table: 'weather_daily', rows: count('weather_daily'), range: get('SELECT MIN(date) a, MAX(date) b FROM weather_daily'), provenance: 'REAL — ERA5-Land reanalysis + forecast-model analysis', kind: 'Space' },
    { key: 'boreholes', name: 'Drilling database', table: 'boreholes', rows: count('boreholes'), provenance: 'SIMULATED geology on REAL terrain — replace with MOIL / MECL drill logs', kind: 'Geological' },
    { key: 'assays', name: 'Assay intervals', table: 'borehole_intervals', rows: count('borehole_intervals'), provenance: 'SIMULATED — Mn, Fe, SiO₂, P per interval', kind: 'Geological' },
  ];
  const value = { checked_at: new Date().toISOString(), external: probes, internal, last_ingest_at: getMeta('last_ingest_at'), seeded_at: getMeta('seeded_at'),
    imports: all('SELECT * FROM imports ORDER BY id DESC LIMIT 10') };
  cached = { at: Date.now(), value };
  return value;
}
