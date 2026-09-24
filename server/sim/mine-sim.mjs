/* Daily mine operating-system simulator.
 *
 * One code path is used twice:
 *   1. seed/generate.mjs  — to create the (simulated) operating history, together with productionTruth()
 *   2. services/forecast  — as the stochastic *driver* model in the Monte-Carlo forecast. There the
 *      equipment / blasting / water parameters are the ones fitted from the logs, and production is
 *      predicted by the trained ML model, never by productionTruth().
 *
 * Drivers simulated per day: equipment failures (Weibull hazard, minimal repair, PM renewal),
 * blasting (rain, explosive supply, drill availability, statutory / misfire), pit & mine water
 * balance (inflow vs available pumping), grid power outages, roster (shift hours).
 */
import { EQUIPMENT_CLASSES, GROUP_HEADROOM, GROUP_TARGET_AVAIL, ECONOMICS } from '../config/mines.mjs';
import { monthOf } from '../lib/dates.mjs';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const gammaFn = (z) => { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5; return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * x;
};
export const weibullEta = (mtbf, beta) => mtbf / gammaFn(1 + 1 / beta);

export const PRODUCTION_GROUPS = { UG: ['loading', 'haulage', 'hoisting', 'crushing'], OC: ['loading', 'haulage', 'crushing'] };

/** Monthly plan phasing (monsoon months planned lower, fair-weather months higher; sums to ~12). */
export function planPhase(month) { return { 6: 0.9, 7: 0.85, 8: 0.85, 9: 0.9 }[month] ?? 1.0625; }
export const planForDay = (mine, isoDate) => (mine.annualPlanT / 365) * planPhase(monthOf(isoDate));

export function makeUnit(row) {
  const c = EQUIPMENT_CLASSES[row.class];
  return {
    id: row.id, cls: row.class, grp: c.group, critical: !!c.critical,
    mtbf: row.mtbf_h ?? c.mtbf, mttr: row.mttr_h ?? c.mttr, beta: row.beta ?? c.beta, pm: row.pm_interval_h ?? c.pm,
    eta: weibullEta(row.mtbf_h ?? c.mtbf, row.beta ?? c.beta),
    hsp: row.hours_since_pm ?? 0, down: row.down_h_remaining ?? 0, op: row.total_op_h ?? 0, pmDefer: 1,
  };
}

/** Mutable state of one mine for simulation. */
export function createState(mine, units, init = {}) {
  const std = ECONOMICS.shiftHours[mine.shifts];
  return {
    mine, units: units.map((u) => ({ ...u })), stdShiftH: std, shiftH: init.shiftH ?? std, overtimeDays: init.overtimeDays ?? 0, reducedDays: init.reducedDays ?? 0,
    brokenStock: init.brokenStock ?? 3 * (mine.annualPlanT / 365), waterStore: init.waterStore ?? 0,
    supplyDisruptDays: init.supplyDisruptDays ?? 0, rain30: init.rain30 ?? [], gradeAR: init.gradeAR ?? 0,
    rom: init.rom ?? mine.rom.stockDays * (mine.annualPlanT / 365), mtdPlan: init.mtdPlan ?? 0, mtdActual: init.mtdActual ?? 0,
    month: init.month ?? null,
  };
}

const causeFor = (u, rng) => rng.pick({
  winder: ['Rope / brake inspection fault', 'Drive motor trip', 'Skip loading chute jam'],
  lhd: ['Hydraulic hose burst', 'Transmission fault', 'Tyre damage', 'Engine overheating'],
  jumbo: ['Boom hydraulics', 'Rock drill failure', 'Compressor fault'],
  loco: ['Battery / traction fault', 'Derailment', 'Brake fault'],
  ug_pump: ['Impeller wear', 'Motor winding failure', 'Seal leak'],
  excavator: ['Hydraulic seal leak', 'Swing motor fault', 'Bucket tooth / lip damage', 'Engine overheating'],
  dumper: ['Tyre damage', 'Transmission fault', 'Suspension / strut failure', 'Engine overheating'],
  dth_drill: ['Hammer failure', 'Compressor fault', 'Rod / bit breakage'],
  oc_pump: ['Impeller wear', 'Diesel engine fault', 'Suction line blockage'],
  crusher: ['Jaw liner wear', 'Oversize boulder jam', 'Conveyor belt tear', 'Motor trip'],
}[u.cls] || ['Mechanical fault']);

/**
 * Advance the drivers by one day.
 * mod (optional, forecast scenarios / corrective actions):
 *   shiftH, extraUnits:[{cls,count,fromDay,toDay}], removeUnits:[{cls,count,fromDay}], pumpBoostM3h, rainBlastMitigation,
 *   supplyBuffer, fragImprove, availUplift, dayIndex
 */
export function stepDrivers(state, day, wx, rng, mod = {}, events = null) {
  const { mine } = state;
  const oc = mine.method === 'OC';
  const k = mod.dayIndex ?? 0;
  const planDay = planForDay(mine, day);
  // is an action parameter active today? (actions start after their lead time: mod.from / mod.until by day index)
  const on = (p) => mod[p] != null && mod[p] !== false && k >= (mod.from?.[p] ?? 0) && k < (mod.until?.[p] ?? 1e9);

  // ---- roster ---------------------------------------------------------------------------------
  let shiftH = on('shiftH') ? mod.shiftH : state.shiftH;
  if (!on('shiftH')) {
    // exogenous roster changes: planned dispatch campaigns, festival / labour-shortage weeks
    if (state.overtimeDays <= 0 && !(state.reducedDays > 0)) {
      if (rng.chance(1 / 90)) state.overtimeDays = 7;
      else if (rng.chance(1 / 110)) state.reducedDays = rng.int(3, 5);
    }
    if (state.overtimeDays > 0) { shiftH = Math.min(23, state.stdShiftH + 7); state.overtimeDays--; }
    else if (state.reducedDays > 0) { shiftH = state.stdShiftH * 0.7; state.reducedDays--; }
  }

  // ---- equipment ------------------------------------------------------------------------------
  if (!state.nominal) { state.nominal = {}; for (const u of state.units) state.nominal[u.grp] = (state.nominal[u.grp] || 0) + 1; }
  const extras = mod.extraUnits;
  const grpSum = {}, pumpCapPer = mine.water.pumpM3h;
  let critDown = 0, unplannedDown = 0, pmH = 0, pumpCap = 0;
  const heatMult = wx.tmax_c >= 38 ? 1 + 0.05 * (wx.tmax_c - 38) : 1;
  const wetHaul = oc && wx.soil_moisture > 0.33;
  const nBase = state.units.length;
  let nTotal = nBase;
  if (extras) for (const x of extras) if (k >= x.fromDay && k <= (x.toDay ?? 1e9)) nTotal += x.units.length;
  for (let idx = 0; idx < nTotal; idx++) {
    let u;
    if (idx < nBase) u = state.units[idx];
    else { let j = idx - nBase; for (const x of extras) { if (!(k >= x.fromDay && k <= (x.toDay ?? 1e9))) continue; if (j < x.units.length) { u = x.units[j]; break; } j -= x.units.length; } }
    if (u.removedFrom && k >= u.removedFrom) continue;
    const ur = mod.unitRng ? mod.unitRng(u.id) : rng;       // per-unit stream → common random numbers across scenarios
    const draw = ur.next();                                  // failure draw first, so it is identical in every scenario
    const opH = u.grp === 'pumping' || u.grp === 'hoisting' ? 20 : shiftH;
    let downToday = 0;
    if (u.down > 0) { const d = Math.min(24, u.down); downToday += d; u.down -= d; }
    if (downToday < 24) {
      if (u.hsp >= u.pm * u.pmDefer) {           // planned maintenance
        const h = u.grp === 'pumping' ? 6 : 8;
        downToday = Math.min(24, downToday + h); pmH += h; u.hsp = 0; u.hz = 0;
        u.pmDefer = ur.chance(on('pmDeferralRate') ? mod.pmDeferralRate : 0.28) ? ur.uniform(1.1, 1.6) : 1;
        events?.push({ equipment_id: u.id, mine_id: mine.id, date: day, kind: 'pm', hours: h, cause: 'Scheduled preventive maintenance' });
      }
      const op = opH * (1 - downToday / 24);
      let mult = heatMult;
      if (wetHaul && (u.cls === 'dumper' || u.cls === 'excavator')) mult *= 1.25;
      if (u.hsp > u.pm) mult *= 1 + 1.5 * (u.hsp / u.pm - 1);
      if (u.hz === undefined) u.hz = (u.hsp / u.eta) ** u.beta;       // cumulative Weibull hazard at current age
      const hzNext = ((u.hsp + op) / u.eta) ** u.beta;
      if (draw < 1 - Math.exp(-(hzNext - u.hz) * mult)) {
        const repair = u.mttr * (u.critical && on('mttrMultCritical') ? mod.mttrMultCritical : 1) * ur.lognormal(1, 0.75);
        const lost = Math.min(24 - downToday, repair * ur.uniform(0.3, 0.8));
        downToday += lost; u.down = Math.max(0, repair - lost); unplannedDown += repair;
        if (u.critical && u.grp !== 'pumping') critDown += repair;
        events?.push({ equipment_id: u.id, mine_id: mine.id, date: day, kind: 'breakdown', hours: +repair.toFixed(1), cause: causeFor(u, ur) });
      }
      u.hsp += op; u.op += op; u.hz = hzNext;
    }
    const af = downToday >= 24 ? 0 : 1 - downToday / 24;
    u.lastAvail = af;
    if (u.grp === 'pumping') pumpCap += af * pumpCapPer;
    grpSum[u.grp] = (grpSum[u.grp] || 0) + af;
  }
  const avail = {};
  for (const g in grpSum) avail[g] = grpSum[g] / (state.nominal[g] || 1);   // extra units lift group availability above 1 unit-equivalent
  if (on('availUplift')) for (const g of Object.keys(avail)) if (g !== 'pumping') avail[g] = Math.min(avail[g] * (1 + mod.availUplift), 1.25);
  if (on('pumpBoostM3h')) pumpCap += mod.pumpBoostM3h;

  // ---- water balance --------------------------------------------------------------------------
  state.rain30.push(wx.rain_mm); if (state.rain30.length > 30) state.rain30.shift();
  const rain30 = state.rain30.reduce((s, v) => s + v, 0);
  let inflow;
  if (oc) {
    const runoff = clamp(0.3 + 1.2 * (wx.soil_moisture - 0.2), 0.2, 0.85);
    inflow = mine.water.baseInflowM3h + ((wx.rain_mm / 1000) * mine.water.catchmentHa * 1e4 * runoff) / 24;
  } else {
    inflow = mine.water.baseInflowM3h * (1 + (mine.water.rainFactor * rain30) / 500);
  }
  state.waterStore = clamp(state.waterStore + (inflow - pumpCap) * 24, 0, 1.25 * mine.water.sumpM3);   // excess spills to old workings
  const flood = clamp((state.waterStore / mine.water.sumpM3 - 0.25) / 0.75, 0, 0.9);

  // ---- blasting -------------------------------------------------------------------------------
  const planned = oc ? 1 : 2;
  if (state.supplyDisruptDays > 0) state.supplyDisruptDays--;
  else if (rng.chance(1 / 140)) state.supplyDisruptDays = rng.int(2, 6) - (on('supplyBuffer') ? 99 : 0);
  if (state.supplyDisruptDays < 0) state.supplyDisruptDays = 0;
  let done = 0, delay = 0, poorFrag = 0, blasted = 0;
  const blasts = [];
  const rainMit = on('rainBlastMitigation') ? mod.rainBlastMitigation : 0;
  for (let b = 0; b < planned; b++) {
    let reason = null;
    if (state.supplyDisruptDays > 0) reason = 'Explosive supply disruption';
    else if (oc && wx.rain_mm >= 20 && rng.chance(0.75 * (1 - rainMit))) reason = 'Heavy rain — wet holes / unsafe';
    else if (oc && wx.rain_mm >= 8 && rng.chance(0.25 * (1 - rainMit))) reason = 'Rain — charging suspended';
    else if (!oc && wx.rain_mm >= 40 && rng.chance(0.1 * (1 - rainMit))) reason = 'Heavy rain — surface magazine access';
    else if ((avail.drilling ?? 1) < 0.6 && rng.chance(0.35)) reason = 'Drill rig unavailable — holes not ready';
    else if ((avail.drilling ?? 1) < 0.75 && rng.chance(0.12)) reason = 'Drill rig unavailable — holes not ready';
    else if (flood > 0.25 && rng.chance(0.5)) reason = 'Flooded blast holes / face';
    else if (rng.chance(0.035)) reason = rng.pick(['Statutory clearance pending', 'Misfire — re-blast', 'Vibration limit near habitation']);
    if (reason) { delay += oc ? 24 : 12; blasts.push({ executed: 0, delay_h: oc ? 24 : 12, reason }); continue; }
    done++;
    const partial = oc && wx.rain_mm >= 2 && rng.chance(0.3) ? 3 : 0;
    delay += partial;
    const poor = rng.chance((0.1 + (oc && wx.rain_mm > 5 ? 0.1 : 0)) * (1 - (on('fragImprove') ? mod.fragImprove : 0)));
    if (poor) poorFrag = 1;
    blasted += (planDay / planned) * 1.18 * rng.uniform(0.85, 1.15);
    blasts.push({ executed: 1, delay_h: partial, reason: partial ? 'Rain — delayed charging' : null, fragmentation: poor ? 'Poor (oversize)' : 'Good' });
  }

  // ---- grid power -----------------------------------------------------------------------------
  const monsoon = [6, 7, 8, 9].includes(monthOf(day));
  const outage = rng.chance((monsoon ? 2 : 1) / 160) ? rng.uniform(3, 12) : 0;

  return {
    day, planDay, shiftH, avail, pumpCap, inflow, flood, waterStore: state.waterStore, critDown, unplannedDown, pmH,
    planned, done, delay, poorFrag, blasted, blasts, outage, wx,
  };
}

/** Ground-truth production for the generator only (the forecast uses the ML model instead). */
export function productionTruth(state, d, rng) {
  const { mine } = state, oc = mine.method === 'OC';
  const planDay = d.planDay;
  const month = monthOf(d.day);
  if (state.month !== month) { state.month = month; state.mtdPlan = 0; state.mtdActual = 0; }
  const backlog = Math.max(0, state.mtdPlan - state.mtdActual);
  const target = planDay + Math.min(0.3 * planDay, backlog / 10);

  const caps = {};
  const shiftF = (d.shiftH / state.stdShiftH) ** 0.85;
  for (const g of PRODUCTION_GROUPS[mine.method]) {
    let c = planDay * GROUP_HEADROOM[g] * ((d.avail[g] ?? 1) / GROUP_TARGET_AVAIL[g]) * (g === 'crushing' ? 1 : shiftF);
    if (g === 'crushing' && d.poorFrag) c *= 0.8;
    if (g === 'haulage' && oc) {
      if (d.wx.soil_moisture > 0.33) c *= clamp(1 - 1.4 * (d.wx.soil_moisture - 0.33), 0.55, 1);
      if (d.wx.rain_mm > 15) c *= 0.85;
    }
    caps[g] = c;
  }
  const [bottleneck, cap] = Object.entries(caps).sort((a, b) => a[1] - b[1])[0];
  const availableOre = state.brokenStock + 0.5 * d.blasted;
  const heat = d.wx.tmax_c > 41 ? 1 - (oc ? 0.025 : 0.012) * (d.wx.tmax_c - 41) : 1;
  const limit = Math.min(target, cap, availableOre);
  const limiter = limit === availableOre ? 'blasted-ore' : limit === cap ? bottleneck : 'plan';
  let prod = limit * (1 - d.flood) * heat * (1 - d.outage / 24) * mine.baseEff * rng.lognormal(1, 0.07);
  prod = Math.max(0, prod);

  state.brokenStock = clamp(state.brokenStock + d.blasted - prod, 0, planDay * 8);
  state.mtdPlan += planDay; state.mtdActual += prod;
  state.rom += prod;
  // customer dispatch (rakes / trucks): commitments flex with the ROM stock level
  const demand = planDay * (0.9 + 0.1 * clamp(state.rom / (planDay * 15), 0, 2)) * rng.lognormal(1, 0.25);
  const dispatch = Math.min(state.rom, demand);
  state.rom -= dispatch;
  state.gradeAR = 0.85 * state.gradeAR + rng.normal(0, 0.6);
  const grade = mine.gradeMn + 2 * state.gradeAR - (oc && d.wx.rain_mm > 10 ? 0.6 : 0);

  // management response: schedule overtime when the month is running behind
  const dom = +d.day.slice(8, 10);
  if (dom > 9 && state.overtimeDays === 0 && state.mtdActual < 0.9 * state.mtdPlan && rng.chance(0.06)) state.overtimeDays = 7;

  return { target, prod, dispatch, grade, bottleneck: flood(d) ? 'mine-water' : limiter };
}
const flood = (d) => d.flood > 0.3;

/** Build weekly model features from a week of daily driver records + state at the start of the week. */
export const FEATURES = [
  { name: 'fleet_avail', label: 'Production-fleet availability', group: 'Equipment', mono: 1 },
  { name: 'crit_down_h', label: 'Critical-unit downtime (winder / crusher)', group: 'Equipment', mono: -1 },
  { name: 'blast_exec', label: 'Blasts executed / planned', group: 'Blasting', mono: 1 },
  { name: 'blast_delay_h', label: 'Blasting delay hours', group: 'Blasting', mono: -1 },
  { name: 'poor_frag_days', label: 'Days with poor fragmentation', group: 'Blasting', mono: -1 },
  { name: 'stock_days0', label: 'Blasted-ore inventory at week start (days)', group: 'Blasting', mono: 1 },
  { name: 'rain_mm', label: 'Weekly rainfall', group: 'Weather', mono: -1 },
  { name: 'heavy_rain_days', label: 'Heavy-rain days (≥25 mm)', group: 'Weather', mono: -1 },
  { name: 'soil_moisture', label: 'Soil moisture (haul-road trafficability)', group: 'Weather', mono: -1 },
  { name: 'tmax_c', label: 'Mean daily max temperature', group: 'Weather' },
  { name: 'flood_idx', label: 'Mine-water flooding index', group: 'Dewatering', mono: -1 },
  { name: 'water_ratio', label: 'Peak inflow / pumping capacity', group: 'Dewatering', mono: -1 },
  { name: 'outage_h', label: 'Grid power outage hours', group: 'Power', mono: -1 },
  { name: 'shift_hours', label: 'Scheduled production hours / day', group: 'Schedule', mono: 1 },
  { name: 'backlog_days0', label: 'Month-to-date backlog at week start (days)', group: 'Schedule' },
  { name: 'is_ug', label: 'Underground mine', group: 'Mine' },
];
export const FEATURE_NAMES = FEATURES.map((f) => f.name);

export function weekFeatures(days, { mine, stockDays0, backlogDays0 }) {
  const n = days.length, mean = (f) => days.reduce((s, d) => s + f(d), 0) / n, sum = (f) => days.reduce((s, d) => s + f(d), 0);
  const groups = PRODUCTION_GROUPS[mine.method];
  return {
    fleet_avail: mean((d) => groups.filter((g) => g !== 'crushing').reduce((s, g) => s + Math.min(1.25, d.avail[g] ?? 1), 0) / (groups.length - 1)),
    crit_down_h: sum((d) => d.critDown),
    blast_exec: sum((d) => d.done) / Math.max(1, sum((d) => d.planned)),
    blast_delay_h: sum((d) => d.delay),
    poor_frag_days: sum((d) => d.poorFrag),
    stock_days0: stockDays0,
    rain_mm: sum((d) => d.wx.rain_mm),
    heavy_rain_days: sum((d) => (d.wx.rain_mm >= 25 ? 1 : 0)),
    soil_moisture: mean((d) => d.wx.soil_moisture),
    tmax_c: mean((d) => d.wx.tmax_c),
    flood_idx: mean((d) => d.flood),
    water_ratio: Math.max(...days.map((d) => d.inflow / Math.max(1, d.pumpCap))),
    outage_h: sum((d) => d.outage),
    shift_hours: mean((d) => d.shiftH),
    backlog_days0: backlogDays0,
    is_ug: mine.method === 'UG' ? 1 : 0,
  };
}
