/* Operating-history generator (SIMULATED operations driven by REAL daily weather).
 * Produces the rows a MOIL ERP / SCADA / shift-report system would hold: daily production & dispatch,
 * fleet availability by function, breakdown & PM log, blast log, mine-water balance, roster. */
import { EQUIPMENT_CLASSES } from '../config/mines.mjs';
import { Rng, hashSeed } from '../lib/rng.mjs';
import { eachDay } from '../lib/dates.mjs';
import { createState, makeUnit, stepDrivers, productionTruth } from '../sim/mine-sim.mjs';
import { minePrefix } from './drilling.mjs';

const CODE = { winder: 'WND', lhd: 'LHD', jumbo: 'JMB', loco: 'LOC', ug_pump: 'PMP', excavator: 'EXC', dumper: 'DMP', dth_drill: 'DRL', oc_pump: 'PMP', crusher: 'CRS' };
const r = (v, d = 2) => (v == null ? null : +(+v).toFixed(d));

export function buildFleet(mine) {
  const rng = new Rng(hashSeed('fleet', mine.id));
  const rows = [];
  for (const [cls, count] of Object.entries(mine.fleet)) {
    const c = EQUIPMENT_CLASSES[cls];
    for (let i = 1; i <= count; i++) {
      const age = rng.int(1, 16);
      rows.push({
        id: `${minePrefix(mine.id)}-${CODE[cls]}-${String(i).padStart(2, '0')}`, mine_id: mine.id, class: cls, label: c.label, grp: c.group,
        commissioned: 2026 - age,
        // older units fail more often: MTBF degrades ~2.5 % per year of age
        mtbf_h: r(c.mtbf * (1.12 - 0.025 * age) * rng.uniform(0.9, 1.1), 0), mttr_h: r(c.mttr * rng.uniform(0.85, 1.2), 1), beta: c.beta,
        pm_interval_h: c.pm, critical: c.critical ? 1 : 0, hours_since_pm: r(rng.uniform(0, c.pm), 0), down_h_remaining: 0, total_op_h: r(age * 4200, 0), status: 'Operating',
      });
    }
  }
  return rows;
}

export function serializeState(st) {
  return JSON.stringify({
    shiftH: st.shiftH, overtimeDays: st.overtimeDays, reducedDays: st.reducedDays || 0, brokenStock: st.brokenStock, waterStore: st.waterStore, supplyDisruptDays: st.supplyDisruptDays,
    rain30: st.rain30, gradeAR: st.gradeAR, rom: st.rom, mtdPlan: st.mtdPlan, mtdActual: st.mtdActual, month: st.month,
    units: Object.fromEntries(st.units.map((u) => [u.id, { hsp: u.hsp, down: u.down, op: u.op, pmDefer: u.pmDefer }])),
  });
}

export function restoreState(mine, equipmentRows, json) {
  const s = json ? JSON.parse(json) : {};
  const units = equipmentRows.map((row) => { const u = makeUnit(row); Object.assign(u, s.units?.[u.id] || {}); return u; });
  return createState(mine, units, s);
}

/** Simulate [from, to] inclusive, mutating `state`. weather: Map(date -> row). */
export function simulateOperations(mine, state, weather, from, to, { record = true } = {}) {
  const daily = [], events = [], blasts = [];
  for (const day of eachDay(from, to)) {
    const wx = weather.get(day);
    if (!wx) continue;
    const rng = new Rng(hashSeed('ops', mine.id, day));
    const ev = record ? events : null;
    const d = stepDrivers(state, day, wx, rng, {}, ev);
    const p = productionTruth(state, d, rng);
    if (!record) continue;
    const a = d.avail;
    const prodGroups = Object.keys(a).filter((g) => !['pumping', 'drilling', 'crushing'].includes(g));
    daily.push({
      mine_id: mine.id, date: day, plan_t: r(d.planDay, 1), target_t: r(p.target, 1), actual_t: r(p.prod, 1), dispatch_t: r(p.dispatch, 1),
      rom_stock_t: r(state.rom, 0), broken_stock_t: r(state.brokenStock, 0), grade_mn: r(p.grade, 2),
      fleet_avail: r(prodGroups.reduce((s, g) => s + Math.min(1.25, a[g]), 0) / prodGroups.length, 4),
      avail_loading: r(a.loading, 4), avail_haulage: r(a.haulage, 4), avail_hoisting: r(a.hoisting, 4), avail_drilling: r(a.drilling, 4),
      avail_crushing: r(a.crushing, 4), avail_pumping: r(a.pumping, 4),
      crit_down_h: r(d.critDown, 1), unplanned_down_h: r(d.unplannedDown, 1), pm_h: r(d.pmH, 1),
      blasts_planned: d.planned, blasts_done: d.done, blast_delay_h: r(d.delay, 1), poor_frag: d.poorFrag,
      rain_mm: wx.rain_mm, soil_moisture: wx.soil_moisture, tmax_c: wx.tmax_c, soil_temp_c: wx.soil_temp_c,
      inflow_m3h: r(d.inflow, 1), pump_cap_m3h: r(d.pumpCap, 1), water_store_m3: r(d.waterStore, 0), flood_loss: r(d.flood, 4),
      shift_hours: r(d.shiftH, 1), outage_h: r(d.outage, 1), bottleneck: p.bottleneck, source: 'SIMULATED (weather: real)',
    });
    d.blasts.forEach((b) => blasts.push({ mine_id: mine.id, date: day, planned: 1, executed: b.executed, delay_h: b.delay_h, reason: b.reason, fragmentation: b.fragmentation || null }));
  }
  return { daily, events, blasts };
}
