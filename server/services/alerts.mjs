/* Early-warning engine. Every alert is computed from data, with its evidence and an estimated impact:
 *   Weather      live 16-day forecast × the mine's own historical loss on days with that much rain
 *   Equipment    Weibull failure probability (fitted from the log) × throughput exposure
 *   Blasting     last-7-day execution rate and cancellation reasons from the blast log
 *   Production   14-day attainment trend, forecast shortfall probability (Monte-Carlo × ML)
 *   Dewatering   forecast peak inflow vs available pumping
 *   Dispatch     ROM stockpile days of cover
 */
import { all, get } from '../lib/db.mjs';
import { addDays } from '../lib/dates.mjs';
import { MINE_BY_ID, ECONOMICS } from '../config/mines.mjs';
import { planForDay } from '../sim/mine-sim.mjs';
import { fleetHealth } from './equipment.mjs';

const round = (v, d = 0) => +(+v).toFixed(d);
const SEV_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const fmtDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Mean production loss (fraction of plan) on historical days in a rain bucket. */
function rainLossCurve(mineId) {
  const rows = all(`SELECT CASE WHEN rain_mm < 5 THEN 0 WHEN rain_mm < 20 THEN 1 WHEN rain_mm < 40 THEN 2 WHEN rain_mm < 70 THEN 3 ELSE 4 END b,
                    COUNT(*) n, AVG(1 - actual_t / plan_t) loss FROM daily_ops WHERE mine_id = ? GROUP BY b`, mineId);
  const dry = rows.find((r) => r.b === 0)?.loss ?? 0.05;
  return Object.fromEntries(rows.map((r) => [r.b, { n: r.n, excess: Math.max(0, r.loss - dry), loss: r.loss }]));
}
const bucket = (mm) => (mm < 5 ? 0 : mm < 20 ? 1 : mm < 40 ? 2 : mm < 70 ? 3 : 4);

export function mineAlerts(mineId, fc) {
  const mine = MINE_BY_ID[mineId], oc = mine.method === 'OC';
  const last = get('SELECT MAX(date) d FROM daily_ops WHERE mine_id = ?', mineId).d;
  const out = [];
  const push = (a) => out.push({ mine_id: mineId, mine: mine.name, ...a, id: `${mineId}-${a.category}-${out.length + 1}`.toLowerCase().replace(/\s+/g, '-') });

  // --- weather: live forecast --------------------------------------------------------------------
  const curve = rainLossCurve(mineId);
  const liveDays = (fc?.live_weather || []).filter((d) => d.date > last);
  const heavy = liveDays.filter((d) => d.rain_mm >= (oc ? 25 : 45));
  heavy.forEach((d) => {
    const b = curve[bucket(d.rain_mm)] || { excess: 0.1, n: 0 };
    if (!oc && b.excess < 0.03 && d.rain_mm < 100) return;          // this mine's record shows no rain sensitivity
    const planDay = planForDay(mine, d.date);
    const impact = b.excess * planDay * (d.rain_mm >= 60 ? 1.6 : 1.1);       // same-day + next-day recovery
    // severity from the mine's own exposure (share of a day's plan at risk); IMD ≥64.5 mm/day = "heavy rain"
    const share = impact / planDay;
    const sev = share >= 0.5 ? 'Critical' : share >= 0.2 || (oc && d.rain_mm >= 64.5) ? 'High' : 'Medium';
    push({ severity: sev, category: 'Weather', title: `Heavy rain ${round(d.rain_mm, 1)} mm forecast ${fmtDate(d.date)}`,
      detail: `${oc ? 'Pit floor flooding, wet blast-holes and slippery haul roads' : 'Increased mine-water inflow and surface magazine access'} expected. On past days with this much rain the mine lost ${Math.round(b.loss * 100)}% of plan (${b.n} days of record, ${Math.round(b.excess * 100)} pts worse than dry days).${d.rain_prob != null ? ` Rain probability ${d.rain_prob}%.` : ''}`,
      window: d.date, impact_t: round(impact), source: 'Live forecast · Open-Meteo × mine rain-loss history', action_hint: oc ? 'blast_reschedule' : 'pump_boost',
      evidence: { rain_mm: d.rain_mm, rain_prob: d.rain_prob, hist_loss_pct: round(b.loss * 100, 1), hist_days: b.n } });
  });
  const hot = liveDays.filter((d) => d.tmax_c >= 42);
  if (hot.length) push({ severity: hot.some((d) => d.tmax_c >= 45) ? 'High' : 'Medium', category: 'Weather', title: `Heat stress: ${hot.length} day(s) ≥ 42 °C from ${fmtDate(hot[0].date)}`,
    detail: `Max ${Math.max(...hot.map((d) => d.tmax_c))} °C. Engine / hydraulic overheating risk rises ~5 %/°C above 38 °C; schedule HEMM work in cooler hours and enforce heat-stress rest cycles.`,
    window: `${hot[0].date} → ${hot[hot.length - 1].date}`, impact_t: round(hot.length * planForDay(mine, hot[0].date) * 0.04), source: 'Live forecast · Open-Meteo', action_hint: 'pm_blitz', evidence: { days: hot.length } });

  // --- equipment -----------------------------------------------------------------------------------
  const fh = fleetHealth(mineId);
  const planDay = planForDay(mine, addDays(last, 1));
  const shiftH = ECONOMICS.shiftHours[mine.shifts];
  const eqAlerts = [];
  fh.units.forEach((u) => {
    const nGroup = fh.units.filter((x) => x.group === u.group).length;
    const exposure = u.group === 'pumping' ? 0.4 : u.critical ? 1 : 1 / nGroup;
    if (u.status === 'Under repair' && (u.critical || u.down_h_remaining > 24)) {
      eqAlerts.push({ severity: u.critical ? 'Critical' : 'High', category: 'Equipment', title: `${u.id} (${u.label}) under repair — ${round(u.down_h_remaining)} h remaining`,
        detail: `${u.critical ? 'Single-point-of-failure unit: the whole mine is constrained until it returns.' : `${u.group_label} capacity reduced by 1 of ${nGroup} units.`} Last causes: ${u.top_causes.map((c) => c.cause).join(', ') || 'n/a'}.`,
        window: 'Now', impact_t: round(Math.min(u.down_h_remaining, 72) / shiftH * planDay * exposure * 0.8), source: 'Maintenance log', action_hint: u.critical ? 'critical_spares' : 'hire', evidence: { down_h: u.down_h_remaining } });
    } else if (u.risk === 'High') {
      eqAlerts.push({ severity: u.critical ? 'High' : 'Medium', category: 'Equipment', title: `${u.id} ${Math.round(u.p_fail_72h * 100)}% failure risk in the next 72 h`,
        detail: `${u.label}: ${u.hours_since_pm} h since PM (interval ${u.pm_interval_h} h${u.pm_overdue ? ', OVERDUE' : ''}), fitted MTBF ${u.mtbf_fit_h} h, MTTR ${u.mttr_fit_h} h, ${u.breakdowns_12m} breakdowns in 12 months.`,
        window: 'Next 72 h', impact_t: round(u.p_fail_72h * (u.mttr_fit_h / shiftH) * planDay * exposure), source: 'Weibull reliability model (fitted from breakdown log)', action_hint: 'pm_blitz',
        evidence: { p_fail_72h: u.p_fail_72h, hours_since_pm: u.hours_since_pm, mtbf: u.mtbf_fit_h } });
    }
  });

  // keep the three most consequential equipment alerts (alert fatigue is a real failure mode)
  eqAlerts.sort((a, b) => b.impact_t - a.impact_t).slice(0, 3).forEach(push);

  // --- blasting -----------------------------------------------------------------------------------
  const from7 = addDays(last, -6);
  const bl = get('SELECT SUM(planned) p, SUM(executed) e, SUM(delay_h) d FROM blast_log WHERE mine_id = ? AND date >= ?', mineId, from7);
  if (bl.p && bl.e / bl.p < 0.8) {
    const reasons = all("SELECT reason, COUNT(*) n FROM blast_log WHERE mine_id = ? AND date >= ? AND executed = 0 GROUP BY reason ORDER BY n DESC", mineId, from7);
    const stock = get('SELECT broken_stock_t s, plan_t p FROM daily_ops WHERE mine_id = ? AND date = ?', mineId, last);
    const stockDays = stock ? stock.s / stock.p : 0;
    push({ severity: stockDays < 1.5 ? 'High' : 'Medium', category: 'Blasting', title: `Blasting backlog: ${bl.e}/${bl.p} blasts executed in 7 days`,
      detail: `Cancelled: ${reasons.map((r) => `${r.reason} ×${r.n}`).join('; ')}. Blasted-ore inventory ${stockDays.toFixed(1)} days of plan${stockDays < 1.5 ? ' — face will run out of broken ore' : ''}.`,
      window: 'Current week', impact_t: round(Math.max(0, (bl.p - bl.e) * (planDay / (oc ? 1 : 2)) * 1.18 - Math.max(0, stockDays - 1) * planDay) * 0.5),
      source: 'Blast log', action_hint: 'blast_reschedule', evidence: { executed: bl.e, planned: bl.p, stock_days: round(stockDays, 1) } });
  }

  // --- production trend ---------------------------------------------------------------------------
  const p14 = get('SELECT SUM(plan_t) p, SUM(actual_t) a FROM daily_ops WHERE mine_id = ? AND date > ?', mineId, addDays(last, -14));
  const att14 = p14.a / p14.p;
  if (att14 < 0.9) push({ severity: att14 < 0.8 ? 'High' : 'Medium', category: 'Production', title: `14-day attainment ${Math.round(att14 * 100)}% of plan`,
    detail: `${round(p14.p - p14.a)} t behind plan over the last 14 days.`, window: 'Last 14 days', impact_t: round(p14.p - p14.a), source: 'Daily production report', action_hint: 'catchup_shift', evidence: { attainment: round(att14, 3) } });
  if (fc?.next4) {
    const p = fc.next4.p_shortfall_5pct;
    if (p >= 0.5) push({ severity: p >= 0.8 ? 'High' : 'Medium', category: 'Production', title: `${Math.round(p * 100)}% risk of a >5% shortfall in the next 4 weeks`,
      detail: `Forecast P50 ${round(fc.next4.p50)} t vs plan ${round(fc.next4.plan)} t (P10 ${round(fc.next4.p10)} – P90 ${round(fc.next4.p90)}). Largest drag: ${fc.attribution?.groups?.[0] ? `${fc.attribution.groups[0].group} (${fc.attribution.groups[0].tonnes} t)` : 'n/a'}.`,
      window: `${fc.next4.from} → ${fc.next4.to}`, impact_t: round(fc.next4.expected_shortfall), source: 'Monte-Carlo × ML forecast', action_hint: 'plan', evidence: { p_shortfall_5pct: p } });
    // --- dewatering (forecast)
    const peak = fc.weeks.slice(0, 4).reduce((m, w) => Math.max(m, w.drivers?.water_ratio || 0), 0);
    if (peak > 0.85) push({ severity: peak > 1 ? 'High' : 'Medium', category: 'Dewatering', title: `Pumping margin thin: peak inflow ${Math.round(peak * 100)}% of capacity`,
      detail: `Expected peak inflow vs available pump capacity over the next 4 weeks. A single pump failure would ${oc ? 'flood the pit floor' : 'flood the lowest working level'}.`,
      window: 'Next 4 weeks', impact_t: round(Math.max(0, -(fc.attribution?.groups?.find((g) => g.group === 'Dewatering')?.tonnes || 0))), source: 'Water-balance simulation', action_hint: 'pump_boost', evidence: { peak_ratio: round(peak, 2) } });
  }

  // --- dispatch continuity ------------------------------------------------------------------------
  const rom = get('SELECT rom_stock_t s, plan_t p FROM daily_ops WHERE mine_id = ? AND date = ?', mineId, last);
  if (rom && rom.s / (rom.p * 0.93) < 5) push({ severity: rom.s / (rom.p * 0.93) < 2 ? 'High' : 'Medium', category: 'Dispatch', title: `ROM stockpile down to ${(rom.s / (rom.p * 0.93)).toFixed(1)} days of dispatch cover`,
    detail: `${round(rom.s)} t on the ROM pad. Rake / truck dispatch commitments are exposed if production dips further.`, window: 'Now', impact_t: 0, source: 'Stock & dispatch register', action_hint: 'catchup_shift', evidence: { rom_t: round(rom.s) } });

  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.impact_t - a.impact_t);
}
