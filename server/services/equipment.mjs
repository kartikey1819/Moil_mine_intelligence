/* Fleet health: reliability fitted from the breakdown / PM log, and forward failure risk per unit.
 *
 *   MTBF_fit  = operating hours / breakdowns over the last 365 days, shrunk towards the class mean
 *               (empirical-Bayes, so a unit with few events is not over-fitted)
 *   MTTR_fit  = mean repair hours
 *   P(fail within 72 h) = 1 − exp(−[((a+h)/η)^β − (a/η)^β])   a = hours since PM, h = expected operating hours
 */
import { all, get } from '../lib/db.mjs';
import { addDays } from '../lib/dates.mjs';
import { EQUIPMENT_CLASSES, GROUP_LABEL, MINE_BY_ID, ECONOMICS } from '../config/mines.mjs';
import { weibullEta } from '../sim/mine-sim.mjs';

const r = (v, d = 1) => +(+v).toFixed(d);

const fhCache = new Map();
export function fleetHealth(mineId, { horizonDays = 3 } = {}) {
  const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mineId).d;
  const key = `${mineId}|${last}|${horizonDays}`;
  if (!fhCache.has(key)) { for (const k of fhCache.keys()) if (k.startsWith(`${mineId}|`)) fhCache.delete(k); fhCache.set(key, computeFleetHealth(mineId, last, horizonDays)); }
  return fhCache.get(key);
}

function computeFleetHealth(mineId, last, horizonDays) {
  const mine = MINE_BY_ID[mineId];
  const from = addDays(last, -364);
  const units = all('SELECT * FROM equipment WHERE mine_id = ? ORDER BY grp, id', mineId);
  const ev = all(`SELECT equipment_id, kind, COUNT(*) n, SUM(hours) h, MAX(date) last FROM equipment_events WHERE mine_id = ? AND date >= ? GROUP BY equipment_id, kind`, mineId, from);
  const evMap = {};
  ev.forEach((e) => { (evMap[e.equipment_id] ||= {})[e.kind] = e; });
  const causes = all(`SELECT equipment_id, cause, COUNT(*) n FROM equipment_events WHERE mine_id = ? AND kind = 'breakdown' AND date >= ? GROUP BY equipment_id, cause ORDER BY n DESC`, mineId, from);
  const ops = get('SELECT AVG(shift_hours) sh FROM daily_ops WHERE mine_id = ? AND date >= ?', mineId, from);
  const schedH = (u) => (u.grp === 'pumping' || u.grp === 'hoisting' ? 20 : ops.sh || ECONOMICS.shiftHours[mine.shifts]);

  // class-level pooled rates (prior)
  const pooled = {};
  units.forEach((u) => {
    const e = evMap[u.id] || {}, down = (e.breakdown?.h || 0) + (e.pm?.h || 0);
    const opH = Math.max(1, 365 * schedH(u) * (1 - Math.min(0.9, down / 8760)));
    const p = (pooled[u.class] ||= { f: 0, op: 0, rep: 0 });
    p.f += e.breakdown?.n || 0; p.op += opH; p.rep += e.breakdown?.h || 0;
    u._opH = opH;
  });

  const rows = units.map((u) => {
    const c = EQUIPMENT_CLASSES[u.class], e = evMap[u.id] || {}, P = pooled[u.class];
    const f = e.breakdown?.n || 0, classRate = P.f / P.op, k = 1500;           // prior worth 1 500 operating hours
    const rate = (f + classRate * k) / (u._opH + k);
    const mtbf = 1 / Math.max(rate, 1e-6);
    const mttr = f ? e.breakdown.h / f : P.f ? P.rep / P.f : u.mttr_h;
    const eta = weibullEta(mtbf, u.beta);
    const h = horizonDays * schedH(u) * 0.85, a = u.hours_since_pm;
    const overdue = a > u.pm_interval_h;
    const stress = overdue ? 1 + 1.5 * (a / u.pm_interval_h - 1) : 1;
    const pFail = 1 - Math.exp(-(((a + h) / eta) ** u.beta - (a / eta) ** u.beta) * stress);
    const downH = (e.breakdown?.h || 0) + (e.pm?.h || 0);
    const availability = Math.max(0, 1 - downH / (365 * 24));
    const risk = u.down_h_remaining > 0 ? 'Down' : pFail >= 0.5 || (u.critical && pFail >= 0.2) ? 'High' : pFail >= 0.3 || (u.critical && pFail >= 0.1) ? 'Medium' : 'Low';
    return {
      id: u.id, class: u.class, label: u.label, group: u.grp, group_label: GROUP_LABEL[u.grp], critical: !!u.critical, commissioned: u.commissioned,
      age_years: new Date().getFullYear() - u.commissioned, status: u.down_h_remaining > 0 ? 'Under repair' : 'Operating', down_h_remaining: r(u.down_h_remaining),
      hours_since_pm: r(u.hours_since_pm, 0), pm_interval_h: u.pm_interval_h, pm_due_in_h: r(u.pm_interval_h - u.hours_since_pm, 0), pm_overdue: overdue,
      breakdowns_12m: f, downtime_h_12m: r(e.breakdown?.h || 0), pm_events_12m: e.pm?.n || 0,
      mtbf_fit_h: r(mtbf, 0), mtbf_nameplate_h: c.mtbf, mttr_fit_h: r(mttr), availability_12m: r(availability * 100, 1),
      p_fail_72h: r(pFail, 3), risk, top_causes: causes.filter((x) => x.equipment_id === u.id).slice(0, 3).map((x) => ({ cause: x.cause, n: x.n })),
      last_breakdown: e.breakdown?.last || null,
    };
  });

  const byGroup = {};
  rows.forEach((u) => { const g = (byGroup[u.group] ||= { group: u.group, label: u.group_label, units: 0, availability: 0, down_now: 0, high_risk: 0 }); g.units++; g.availability += u.availability_12m; if (u.status !== 'Operating') g.down_now++; if (u.risk === 'High') g.high_risk++; });
  Object.values(byGroup).forEach((g) => { g.availability = r(g.availability / g.units, 1); });

  // recent daily availability by function (last 90 days) for charts
  const trend = all(`SELECT date, avail_loading, avail_haulage, avail_hoisting, avail_crushing, avail_drilling, avail_pumping, unplanned_down_h, crit_down_h
                     FROM daily_ops WHERE mine_id = ? AND date > ? ORDER BY date`, mineId, addDays(last, -90));
  return { mine_id: mineId, as_of: last, units: rows, groups: Object.values(byGroup), trend };
}

/** Units in a mine ready for simulation with fitted MTBF / MTTR. */
export function fittedUnitRows(mineId) {
  const fh = fleetHealth(mineId);
  const byId = Object.fromEntries(fh.units.map((u) => [u.id, u]));
  return all('SELECT * FROM equipment WHERE mine_id = ? ORDER BY id', mineId).map((row) => ({ ...row, mtbf_h: byId[row.id].mtbf_fit_h, mttr_h: byId[row.id].mttr_fit_h }));
}
