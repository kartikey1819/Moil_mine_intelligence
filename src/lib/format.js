/* Number / date formatting (Indian conventions: en-IN grouping, lakh / crore). */
const nf = (d) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (v, d = 0) => (v == null || !Number.isFinite(+v) ? '—' : nf(d).format(+v));

/** tonnes → "845 t", "12.4 kt", "1.86 Mt" */
export function t(v, { unit = true, d } = {}) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const a = Math.abs(v), sfx = unit ? ' ' : '';
  if (a >= 1e6) return `${nf(d ?? 2).format(v / 1e6)}${sfx}${unit ? 'Mt' : ''}`;
  if (a >= 1e4) return `${nf(d ?? 1).format(v / 1e3)}${sfx}${unit ? 'kt' : ''}`;
  return `${nf(d ?? 0).format(v)}${sfx}${unit ? 't' : ''}`;
}
export const signedT = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${t(Math.abs(v))}`);
export const pct = (v, d = 0) => (v == null || !Number.isFinite(+v) ? '—' : `${nf(d).format(v * 100)}%`);
export const pp = (v, d = 0) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${nf(d).format(Math.abs(v * 100))} pts`);
/** ₹ lakh → "₹ 29.7 L" / "₹ 3.21 Cr" */
export const inr = (lakh) => (lakh == null ? '—' : Math.abs(lakh) >= 100 ? `₹ ${nf(2).format(lakh / 100)} Cr` : `₹ ${nf(1).format(lakh)} L`);
export const date = (iso, opts = { day: 'numeric', month: 'short' }) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' }) : '—');
export const dateLong = (iso) => date(iso, { day: 'numeric', month: 'short', year: 'numeric' });
export const weekday = (iso) => date(iso, { weekday: 'short' });
export const ago = (isoTs) => {
  if (!isoTs) return '—';
  const s = (Date.now() - Date.parse(isoTs)) / 1000;
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
export const riskClass = (p) => (p >= 0.7 ? 'High' : p >= 0.4 ? 'Medium' : 'Low');
