/* End-to-end smoke test of the running API (npm test). Checks every endpoint the dashboard uses
 * and a few invariants (probabilities in [0,1], P10 ≤ P50 ≤ P90, reserves consistent, alerts sorted). */
const BASE = process.env.API || 'http://localhost:8710/api';
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) failed++; };
const get = async (p, init) => { const t0 = performance.now(); const r = await fetch(BASE + p, init); const j = await r.json(); return { status: r.status, j, ms: Math.round(performance.now() - t0) }; };

const meta = await get('/meta');
ok(meta.status === 200 && meta.j.mines.length === 8, `/meta — 8 mines, data as of ${meta.j.as_of}`);
const mine = meta.j.mines[0].id;

const ov = await get('/overview');
ok(ov.status === 200 && ov.j.mines.length === 8, `/overview (${ov.ms} ms)`);
const P = ov.j.portfolio.next4;
ok(P.p10 <= P.p50 && P.p50 <= P.p90, `portfolio P10 ${P.p10} ≤ P50 ${P.p50} ≤ P90 ${P.p90}`);
ok(P.p_shortfall_5pct >= 0 && P.p_shortfall_5pct <= 1, `shortfall probability ${P.p_shortfall_5pct} in [0,1]`);
ok(ov.j.kpis.reserves_t > 0, `reserves ${(ov.j.kpis.reserves_t / 1e6).toFixed(1)} Mt`);

const fc = await get(`/mines/${mine}/forecast`);
ok(fc.status === 200 && fc.j.weeks.length >= 13 && fc.j.attribution?.groups?.length > 0, `/mines/${mine}/forecast — ${fc.j.weeks?.length} weeks, TreeSHAP groups`);
ok(fc.j.weeks.every((w) => w.p10 <= w.p50 && w.p50 <= w.p90), 'weekly quantiles ordered');

for (const p of [`/mines/${mine}/production?grain=week`, `/mines/${mine}/equipment`, `/mines/${mine}/blasting`, `/mines/${mine}/alerts`, `/mines/${mine}/weather`, `/mines/${mine}/boreholes`, `/mines/${mine}/geology`, '/risk', '/models', '/weather/live', '/production?grain=month']) {
  const r = await get(p); ok(r.status === 200, `${p} (${r.ms} ms)`);
}
const al = await get('/alerts');
const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
ok(al.j.every((a, i) => i === 0 || rank[al.j[i - 1].severity] <= rank[a.severity]), `/alerts — ${al.j.length} alerts sorted by severity`);

const res = await get(`/mines/${mine}/reserves`);
const S = res.j.summary;
ok(res.status === 200 && S.reserves.tonnes > 0 && S.mine_life_years > 0, `/reserves — ${(S.reserves.tonnes / 1e6).toFixed(2)} Mt reserves, life ${S.mine_life_years} yr`);
ok(Math.abs(S.classes.filter((c) => c.kind === 'Reserve').reduce((s, c) => s + c.tonnes, 0) - S.reserves.tonnes) < 5, 'UNFC reserve classes sum to total');

const act = await get(`/mines/${mine}/actions`);
ok(act.status === 200 && act.j.actions.length > 3, `/actions — ${act.j.actions.length} candidates, plan recovers ${act.j.plan.recovered_t_13w} t (${act.ms} ms)`);
const sim = await get(`/mines/${mine}/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ availUplift: 0.1 }) });
ok(sim.status === 200 && sim.j.delta_t_13w > 0, `/simulate +10% availability → ${sim.j.delta_t_13w} t over 13 weeks (monotone model)`);

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
