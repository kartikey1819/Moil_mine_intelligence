/* Worker-side scenario evaluation for the prescriptive engine.
 * Every scenario is simulated with the SAME random streams (common random numbers), so the difference
 * between a scenario and the baseline is the effect of the action, not simulation noise. */
import { simulateMine, distSummary } from './forecast.mjs';

export function evaluateScenarioSet(mineId, scenarios, opts = {}) {
  return scenarios.map(({ key, scenario }) => {
    const sim = simulateMine(mineId, { ...scenario, seed: 'opt' }, { sims: opts.sims ?? 150, horizonWeeks: opts.horizonWeeks ?? 13, live: opts.live });
    const d = distSummary({ ...sim, fy: { label: '', plan: 0, fytd_plan: 0, fytd_actual: 0, weeks: 0 } });
    const pick = (w) => ({ plan: w.plan, mean: w.mean, p10: w.p10, p50: w.p50, p90: w.p90, p_shortfall: w.p_shortfall, p_shortfall_5pct: w.p_shortfall_5pct, expected_shortfall: w.expected_shortfall });
    return { key, next4: pick(d.next4), next13: pick(d.next13), weeks: d.weeks.map((w) => ({ start: w.start, plan: w.plan, mean: w.mean, p10: w.p10, p90: w.p90 })) };
  });
}
