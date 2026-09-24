/* Calendar helpers. All dates are ISO 'YYYY-MM-DD' strings in mine-local time (IST). */

export const DAY_MS = 864e5;
export const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (isoDate, n) => iso(new Date(toDate(isoDate).getTime() + n * DAY_MS));
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY_MS);
export const todayIST = () => iso(new Date(Date.now() + 5.5 * 3600e3));
export const dayOfYear = (isoDate) => { const d = toDate(isoDate); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / DAY_MS); };
export const monthOf = (isoDate) => +isoDate.slice(5, 7);
export const daysInMonth = (isoDate) => { const d = toDate(isoDate); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); };

/** Indian financial year: FY 2026-27 runs 2026-04-01 .. 2027-03-31 */
export function fiscalYear(isoDate) {
  const y = +isoDate.slice(0, 4), m = monthOf(isoDate);
  const start = m >= 4 ? y : y - 1;
  return { label: `FY ${start}-${String((start + 1) % 100).padStart(2, '0')}`, start: `${start}-04-01`, end: `${start + 1}-03-31` };
}

export function* eachDay(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }

/** Monday of the ISO week containing the date */
export function weekStart(isoDate) {
  const d = toDate(isoDate), dow = (d.getUTCDay() + 6) % 7;
  return iso(new Date(d.getTime() - dow * DAY_MS));
}
