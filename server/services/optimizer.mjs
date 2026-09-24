/* Prescriptive engine: generates corrective actions from each mine's live situation, values every action
 * with the Monte-Carlo × ML forecast (common random numbers), and assembles the best plan.
 *
 * Action families (problem statement: "adjust mine schedules, optimise blasting, re-deploy equipment"):
 *   Equipment redeployment (between MOIL mines, net of the donor's loss) · equipment hire
 *   Maintenance: PM blitz on the highest-risk units, PM-compliance enforcement, critical spares
 *   Mine schedule: catch-up shift campaign
 *   Blasting: reschedule around forecast rain, blast-design optimisation, explosive buffer stock
 *   Dewatering: portable pump capacity ahead of inflow
 */
import { MINES, MINE_BY_ID, ECONOMICS, EQUIPMENT_CLASSES, GROUP_TARGET_AVAIL, GROUP_LABEL } from '../config/mines.mjs';
import { fleetHealth } from './equipment.mjs';
import { forecast, runInPool, dataVersion } from './forecast.mjs';
import { liveForecast } from './weather.mjs';

const round = (v, d = 0) => +(+v).toFixed(d);
const HIRE_COST_LAKH_PER_MONTH = { dumper: 5.5, excavator: 9, lhd: 7.5, loco: 3.2, jumbo: 6.5, dth_drill: 4.5 };
const CLASS_FOR_GROUP = { UG: { loading: 'lhd', haulage: 'loco', drilling: 'jumbo' }, OC: { loading: 'excavator', haulage: 'dumper', drilling: 'dth_drill' } };
const km = (a, b) => { const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180; const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

/** Candidate actions for one mine, from its fleet health, forecast drivers and the live weather outlook. */
function candidates(mine, fh, fc, peers, H) {
  const out = [], days = H * 7;
  const oc = mine.method === 'OC';
  const drivers4 = fc.weeks.slice(0, 4).map((w) => w.drivers);
  const avg = (k) => drivers4.reduce((s, d) => s + d[k], 0) / drivers4.length;
  const liveRain = (fc.live_weather || []).filter((d) => d.date >= fc.start);
  const rain16 = liveRain.reduce((s, d) => s + (d.rain_mm || 0), 0);
  const wetDays = liveRain.filter((d) => d.rain_mm >= (oc ? 20 : 40));
  const groupAvail = Object.fromEntries(fh.groups.map((g) => [g.group, g.availability / 100]));
  const prodGroups = oc ? ['loading', 'haulage', 'drilling'] : ['loading', 'haulage', 'drilling'];
  const weakest = prodGroups.map((g) => ({ g, gap: (GROUP_TARGET_AVAIL[g] - (groupAvail[g] ?? 1)) })).sort((a, b) => b.gap - a.gap)[0];

  // --- Maintenance -------------------------------------------------------------------------------
  const risky = fh.units.filter((u) => u.status === 'Operating' && u.group !== 'pumping').sort((a, b) => b.p_fail_72h - a.p_fail_72h).slice(0, 3);
  if (risky.length && risky[0].p_fail_72h > 0.15) {
    out.push({ id: 'pm_blitz', category: 'Maintenance', title: `Preventive-maintenance blitz: ${risky.map((u) => u.id).join(', ')}`,
      rationale: `Highest 72-hour failure risk in the fleet: ${risky.map((u) => `${u.id} ${Math.round(u.p_fail_72h * 100)}% (${u.hours_since_pm} h since PM${u.pm_overdue ? ', overdue' : ''})`).join('; ')}. A planned 8-h stop now resets wear-out hazard before an unplanned breakdown (fitted MTTR ${risky[0].mttr_fit_h} h).`,
      scenario: { pmNow: risky.map((u) => u.id) }, lead_days: 1, cost_lakh: round(1.2 * risky.length, 1), constraint: 'Stagger the three stops across shifts; confirm spares availability with stores.' });
  }
  const overdue = fh.units.filter((u) => u.pm_overdue).length;
  out.push({ id: 'pm_compliance', category: 'Maintenance', title: 'Enforce PM schedule compliance (deferral rate 28% → 5%)',
    rationale: `${overdue} unit(s) are past their PM interval today and ${Math.round(fh.units.reduce((s, u) => s + u.breakdowns_12m, 0))} breakdowns were logged in 12 months. Deferred PM multiplies the Weibull wear-out hazard; lock PM windows into the shift plan.`,
    scenario: { pmDeferralRate: 0.05, from: { pmDeferralRate: 3 } }, lead_days: 3, cost_lakh: 3, constraint: 'Requires maintenance-planner sign-off and 2 % planned downtime.' });
  const crit = fh.units.filter((u) => u.critical && u.group !== 'pumping');
  if (crit.length) {
    out.push({ id: 'critical_spares', category: 'Maintenance', title: `Stock critical spares for ${crit.map((u) => u.label.split(' ')[0].toLowerCase()).join(' & ')} (MTTR −45 %)`,
      rationale: `Single-point-of-failure units (${crit.map((u) => `${u.id}: MTTR ${u.mttr_fit_h} h, ${u.breakdowns_12m} stops / 12 m`).join('; ')}) stop the whole mine. Insurance spares at site cut repair time.`,
      scenario: { mttrMultCritical: 0.55, from: { mttrMultCritical: 10 } }, lead_days: 10, cost_lakh: 16, constraint: 'Capital spares purchase; 10-day procurement lead time.' });
  }

  // --- Equipment: hire or redeploy into the weakest function ---------------------------------------
  if (weakest && weakest.gap > -0.04) {
    const cls = CLASS_FOR_GROUP[mine.method][weakest.g];
    const n = cls === 'dumper' ? 2 : 1;
    const lead = 10, months = Math.max(1, (days - lead) / 30);
    out.push({ id: `hire_${cls}`, category: 'Equipment hire', title: `Hire ${n} × ${EQUIPMENT_CLASSES[cls].label} on contract`,
      rationale: `${GROUP_LABEL[weakest.g]} is the weakest production function at this mine: ${Math.round((groupAvail[weakest.g] ?? 0) * 100)}% availability over 12 months against a ${Math.round(GROUP_TARGET_AVAIL[weakest.g] * 100)}% target${weakest.gap > 0 ? '' : ' (at target, but with no spare unit to absorb breakdowns)'}. A contract unit adds headroom exactly where the fleet binds.`,
      scenario: { extraUnits: [{ cls, count: n, fromDay: lead, mtbfFactor: 1.15 }] }, lead_days: lead, cost_lakh: round(HIRE_COST_LAKH_PER_MONTH[cls] * n * months, 1), constraint: 'Contractor mobilisation 10 days; operator training / DGMS permission for UG machines.' });
    // redeployment from peer mines with the same class and better outlook
    peers.filter((p) => p.mine.id !== mine.id && p.mine.method === mine.method && (p.mine.fleet[cls] || 0) >= 3 && p.fc.next4.p_shortfall_5pct < fc.next4.p_shortfall_5pct)
      .map((p) => ({ ...p, dist: km(mine, p.mine) })).sort((a, b) => a.fc.next4.p_shortfall_5pct - b.fc.next4.p_shortfall_5pct || a.dist - b.dist).slice(0, 2)
      .forEach((p) => {
        const lead2 = Math.max(2, Math.ceil(1 + p.dist / 120));
        out.push({ id: `redeploy_${p.mine.id}_${cls}`, category: 'Equipment redeployment', title: `Redeploy ${n} × ${EQUIPMENT_CLASSES[cls].label} from ${p.mine.name}`,
          rationale: `${p.mine.name} has a lower shortfall risk (${Math.round(p.fc.next4.p_shortfall_5pct * 100)}% vs ${Math.round(fc.next4.p_shortfall_5pct * 100)}% here) and ${p.mine.fleet[cls]} ${EQUIPMENT_CLASSES[cls].label.toLowerCase()}s. ${Math.round(p.dist)} km by low-bed trailer; impact on the donor is simulated and netted off.`,
          scenario: { extraUnits: [{ cls, count: n, fromDay: lead2 }] }, donor: { mine_id: p.mine.id, name: p.mine.name, scenario: { removeUnits: [{ cls, count: n, fromDay: lead2 }] } },
          lead_days: lead2, cost_lakh: round(1.5 * n + p.dist * 0.01 * n, 1), constraint: `Transfer order between mines; ${lead2}-day transit incl. inspection.` });
      });
  }

  // --- Schedule -----------------------------------------------------------------------------------
  const std = ECONOMICS.shiftHours[mine.shifts], target = mine.shifts === 2 ? 21 : 23, campaign = 28;
  out.push({ id: 'catchup_shift', category: 'Mine schedule', title: mine.shifts === 2 ? '4-week third-shift catch-up campaign' : '4-week extended-hours campaign (23 h/day)',
    rationale: `Scheduled production hours ${std} h/day → ${target} h/day for 28 days to recover the month-to-date backlog (${avg('backlog_days0').toFixed(1)} days of plan) while fleet capacity is available.`,
    scenario: { shiftH: target, until: { shiftH: campaign }, from: { shiftH: 2 } }, lead_days: 2, cost_lakh: round((mine.method === 'OC' ? 0.85 : 1.1) * campaign * (mine.shifts === 2 ? 1 : 0.4), 1),
    constraint: 'Manpower roster + overtime approval; statutory rest periods; ventilation check for UG.' });

  // --- Blasting -----------------------------------------------------------------------------------
  if (wetDays.length || avg('rain_mm') > 15) {
    out.push({ id: 'blast_reschedule', category: 'Blasting', title: wetDays.length ? `Re-schedule blasts ahead of forecast rain (${wetDays.map((d) => d.date.slice(5)).join(', ')})` : 'Rain-aware blast scheduling (monsoon tail)',
      rationale: `Live forecast: ${Math.round(rain16)} mm over 16 days${wetDays.length ? `, ${wetDays.length} day(s) ≥ ${oc ? 20 : 40} mm` : ''}. Drill and charge the next rounds before the wet windows and keep blasted-ore inventory ≥ 3 days, instead of cancelling on the day.`,
      scenario: { rainBlastMitigation: 0.7 }, lead_days: 0, cost_lakh: 0.8, constraint: 'Blasting crew overtime; magazine dispatch on the dry days; statutory blast timing.' });
  }
  out.push({ id: 'blast_design', category: 'Blasting', title: 'Optimise blast design (burden/spacing, electronic delays)',
    rationale: `${Math.round(avg('poor_frag_days') * 10) / 10} poor-fragmentation day(s) per week expected; oversize drives secondary blasting and crusher stoppages. Tighter burden-spacing and electronic initiation cut oversize by ~60 %.`,
    scenario: { fragImprove: 0.6, from: { fragImprove: 7 } }, lead_days: 7, cost_lakh: 6, constraint: '+4–5 % explosive cost; trial blast and vibration monitoring near habitation.' });
  out.push({ id: 'explosive_buffer', category: 'Blasting', title: 'Hold a 10-day explosive buffer at the magazine',
    rationale: 'Explosive supply disruptions (2–6 days, several per year in the blast log) stop blasting completely. A licensed buffer removes that exposure.',
    scenario: { supplyBuffer: true, from: { supplyBuffer: 5 } }, lead_days: 5, cost_lakh: 4, constraint: 'Within licensed magazine capacity (PESO); holding cost.' });

  // --- Dewatering ---------------------------------------------------------------------------------
  const waterRatio = Math.max(...drivers4.map((d) => d.water_ratio));
  if (waterRatio > 0.65 || avg('flood_idx') > 0.01) {
    out.push({ id: 'pump_boost', category: 'Dewatering', title: `Add portable pump (+${mine.water.pumpM3h} m³/h)`,
      rationale: `Forecast peak inflow reaches ${Math.round(waterRatio * 100)}% of available pumping; any pump breakdown floods the ${oc ? 'pit floor' : 'lower levels'}. One standby pump restores N+1 redundancy.`,
      scenario: { pumpBoostM3h: mine.water.pumpM3h, from: { pumpBoostM3h: 4 } }, lead_days: 4, cost_lakh: round(1.6 * H, 1), constraint: 'Rental pump + discharge line; power/diesel supply.' });
  }
  return out;
}

const mergeScenarios = (list) => {
  const s = {};
  for (const x of list) {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'pmNow') s.pmNow = [...new Set([...(s.pmNow || []), ...v])];
      else if (k === 'extraUnits' || k === 'removeUnits') s[k] = [...(s[k] || []), ...v];
      else if (k === 'from' || k === 'until') s[k] = { ...(s[k] || {}), ...v };
      else s[k] = v;
    }
  }
  return s;
};

const planCache = new Map();

export async function actionPlan(mineId, { sims = 150, horizonWeeks = 13 } = {}) {
  const live = await liveForecast();
  const key = `${mineId}|${dataVersion()}|${live?.fetched_at}|${sims}|${horizonWeeks}`;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.value;
  const p = computePlan(mineId, live, sims, horizonWeeks).catch((e) => { planCache.delete(key); throw e; });
  planCache.set(key, { at: Date.now(), value: p });
  if (planCache.size > 64) planCache.delete(planCache.keys().next().value);
  return p;
}

async function computePlan(mineId, live, sims, horizonWeeks) {

  const mine = MINE_BY_ID[mineId];
  const fh = fleetHealth(mineId);
  const peers = await Promise.all(MINES.map(async (m) => ({ mine: m, fc: await forecast(m.id) })));
  const fc = peers.find((p) => p.mine.id === mineId).fc;
  const cands = candidates(mine, fh, fc, peers, horizonWeeks);
  const opts = { sims, horizonWeeks };

  // evaluate: baseline + each candidate (parallel chunks), plus donor-side impact for redeployments
  const scen = [{ key: 'baseline', scenario: {} }, ...cands.map((c) => ({ key: c.id, scenario: c.scenario }))];
  const chunks = [];
  for (let i = 0; i < scen.length; i += 2) chunks.push(scen.slice(i, i + 2));
  const donorJobs = cands.filter((c) => c.donor).map((c) => runInPool({ task: 'scenarios', mineId: c.donor.mine_id, scenarios: [{ key: 'baseline', scenario: {} }, { key: c.id, scenario: c.donor.scenario }], opts }, live));
  const [res, donorRes] = await Promise.all([
    Promise.all(chunks.map((ch) => runInPool({ task: 'scenarios', mineId, scenarios: ch, opts }, live))).then((r) => r.flat()),
    Promise.all(donorJobs),
  ]);
  const byKey = Object.fromEntries(res.map((r) => [r.key, r]));
  const base = byKey.baseline;
  const price = ECONOMICS.orePriceINRperT / 1e5;   // ₹ lakh per tonne

  const actions = cands.map((c) => {
    const r = byKey[c.id];
    let d13 = r.next13.mean - base.next13.mean, d4 = r.next4.mean - base.next4.mean, donorLoss = 0;
    if (c.donor) {
      const dr = donorRes.find((x) => x.some((y) => y.key === c.id));
      const db = dr.find((y) => y.key === 'baseline'), da = dr.find((y) => y.key === c.id);
      donorLoss = Math.max(0, db.next13.mean - da.next13.mean);
      c.donor.loss_t_13w = round(donorLoss);
    }
    const net = d13 - donorLoss;
    const benefit = net * price;
    return {
      ...c, scenario: c.scenario, donor: c.donor ? { mine_id: c.donor.mine_id, name: c.donor.name, loss_t_13w: c.donor.loss_t_13w } : null,
      delta_t_4w: round(d4), delta_t_13w: round(d13), net_t_13w: round(net),
      delta_p_short_4w: round(r.next4.p_shortfall_5pct - base.next4.p_shortfall_5pct, 3),
      benefit_lakh: round(benefit, 1), net_value_lakh: round(benefit - c.cost_lakh, 1), roi: c.cost_lakh > 0 ? round(benefit / c.cost_lakh, 1) : null,
    };
  }).sort((a, b) => b.net_value_lakh - a.net_value_lakh);

  // greedy plan: best net value first, one action per exclusive family, until the gap is covered
  const gap = Math.max(0, base.next13.plan - base.next13.mean);
  const chosen = [], families = new Set();
  let covered = 0;
  for (const a of actions) {
    const fam = a.id.startsWith('hire_') || a.id.startsWith('redeploy_') ? 'fleet' : a.id;
    if (a.net_value_lakh <= 0 || a.net_t_13w <= 25 || families.has(fam)) continue;
    chosen.push(a); families.add(fam); covered += a.net_t_13w;
    if (chosen.length >= 5 || covered >= gap * 1.25) break;
  }
  const combinedScenario = mergeScenarios(chosen.map((a) => a.scenario));
  const [combined] = chosen.length ? await runInPool({ task: 'scenarios', mineId, scenarios: [{ key: 'plan', scenario: combinedScenario }], opts }, live) : [base];
  actions.forEach((a) => { a.selected = chosen.includes(a); });

  const value = {
    mine_id: mineId, mine: mine.name, generated_at: new Date().toISOString(), sims, horizon_weeks: horizonWeeks, as_of: fc.as_of,
    baseline: base, gap_13w: round(gap), plan: {
      actions: chosen.map((a) => a.id), scenario: combinedScenario, forecast: combined,
      recovered_t_13w: round(combined.next13.mean - base.next13.mean), cost_lakh: round(chosen.reduce((s, a) => s + a.cost_lakh, 0), 1),
      benefit_lakh: round((combined.next13.mean - base.next13.mean) * price - chosen.reduce((s, a) => s + (a.donor?.loss_t_13w || 0), 0) * price, 1),
      p_short_4w_before: base.next4.p_shortfall_5pct, p_short_4w_after: combined.next4.p_shortfall_5pct,
    },
    actions,
    method: 'Each action is simulated with the Monte-Carlo × ML forecast using common random numbers; value = Δ expected tonnes (13 weeks) × ₹13,500/t − cost. Redeployments are netted against the simulated loss at the donor mine.',
  };
  return value;
}

/** Custom what-if from the scenario simulator (user-set levers) vs baseline. */
export async function simulateScenario(mineId, scenario, { sims = 150, horizonWeeks = 13 } = {}) {
  const live = await liveForecast();
  const [base, alt] = await runInPool({ task: 'scenarios', mineId, scenarios: [{ key: 'baseline', scenario: {} }, { key: 'scenario', scenario }], opts: { sims, horizonWeeks } }, live);
  return { mine_id: mineId, baseline: base, scenario: alt, delta_t_13w: round(alt.next13.mean - base.next13.mean), delta_t_4w: round(alt.next4.mean - base.next4.mean) };
}
