/* Proves the browser runtime reproduces Python: same probabilities, same SHAP values.
 * Usage: node ml/verify_runtime.js   (after ml/train.py) */
const path = require('path');
const model = require(path.join(__dirname, '..', 'public', 'js', 'trained-model.js'));
const rt = require(path.join(__dirname, '..', 'public', 'js', 'ml-runtime.js'));
const ref = require(path.join(__dirname, 'data', 'reference.json'));

const X = rt.buildMatrix(model, ref.zones);
let dP = 0, dS = 0, dE = 0, dAdd = 0;
X.forEach((x, i) => {
  const m = rt.margin(model.booster, x), phi = rt.shap(model.booster, x);
  dP = Math.max(dP, Math.abs(rt.sigmoid(m) - ref.probability[i]));
  phi.forEach((v, j) => { dS = Math.max(dS, Math.abs(v - ref.shap[i][j])); });
  dAdd = Math.max(dAdd, Math.abs(model.booster.expected_margin + phi.reduce((s, v) => s + v, 0) - m));
  model.ensemble.forEach((b, k) => { dE = Math.max(dE, Math.abs(rt.sigmoid(rt.margin(b, x)) - ref.ensemble_probability[k][i])); });
});
const scored = rt.scoreZones(ref.zones, model);
const dSum = Math.max(...scored.map((z) => Math.abs(z.base_score + z.evidence.reduce((s, e) => s + e.contribution, 0) - z.prospectivity_score)));

const rows = [
  ['probability  JS vs XGBoost', dP, 1e-5], ['SHAP values  JS vs XGBoost pred_contribs', dS, 1e-4],
  ['ensemble probability', dE, 1e-5], ['SHAP additivity (bias + sum = margin)', dAdd, 1e-6], ['evidence points sum to score', dSum, 0.05],
];
rows.forEach(([name, d, tol]) => console.log(`${d <= tol ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} max |diff| = ${d.toExponential(2)}`));
console.log(`${ref.zones.length} zones checked`);
process.exit(rows.every(([, d, tol]) => d <= tol) ? 0 : 1);
