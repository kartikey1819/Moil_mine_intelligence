/* ECharts wrapper: theme taken from the CSS design tokens (light / dark), auto-resize, disposal per page. */
import * as echarts from 'echarts';

const live = new Set();
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function palette() {
  return {
    text: css('--text'), text2: css('--text-2'), muted: css('--muted'), faint: css('--faint'), border: css('--border'), surface: css('--surface'), surface3: css('--surface-3'),
    brand: css('--brand'), brand2: css('--brand-2'), rose: css('--rose'), actual: css('--c-actual'), plan: css('--c-plan'), forecast: css('--c-forecast'), band: css('--c-band'),
    crit: css('--crit'), high: css('--high'), med: css('--med'), low: css('--low'), info: css('--info'),
    series: [css('--brand'), '#2f7ed8', '#e0913a', '#2a9d8f', css('--rose'), '#6c7a89', '#8e6cc0', '#c4a000'],
  };
}

function baseOption(p) {
  return {
    color: p.series,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: p.text2 },
    grid: { left: 12, right: 16, top: 34, bottom: 8, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: p.surface, borderColor: p.border, textStyle: { color: p.text, fontSize: 12 }, extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.18);border-radius:8px;' },
    legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: p.muted, fontSize: 11 } },
  };
}
const axisDefaults = (p) => ({
  axisLine: { lineStyle: { color: p.border } }, axisTick: { show: false }, axisLabel: { color: p.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: p.border, type: 'dashed' } }, nameTextStyle: { color: p.muted, fontSize: 11 },
});

/** Create (or update) a chart in `el`. `build(p)` returns an ECharts option using the current palette. */
export function chart(el, build) {
  if (!el) return null;
  let inst = echarts.getInstanceByDom(el) || echarts.init(el, null, { renderer: 'canvas' });
  const render = () => {
    const p = palette(), opt = build(p);
    const ax = axisDefaults(p);
    const withAxis = (a) => (Array.isArray(a) ? a.map((x) => ({ ...ax, ...x, axisLabel: { ...ax.axisLabel, ...(x.axisLabel || {}) }, splitLine: { ...ax.splitLine, ...(x.splitLine || {}) } })) : a && { ...ax, ...a, axisLabel: { ...ax.axisLabel, ...(a.axisLabel || {}) }, splitLine: { ...ax.splitLine, ...(a.splitLine || {}) } });
    const b = baseOption(p);
    inst.setOption({ ...b, ...opt, xAxis: withAxis(opt.xAxis), yAxis: withAxis(opt.yAxis), tooltip: { ...b.tooltip, ...(opt.tooltip || {}) },
      legend: opt.legend === false ? { show: false } : { ...b.legend, ...(opt.legend || {}) } }, true);
  };
  render();
  if (!el._ro) { el._ro = new ResizeObserver(() => inst.resize()); el._ro.observe(el); }
  el._render = render;
  live.add(el);
  return inst;
}

const fmtT = (v) => (v == null ? '—' : Math.abs(v) >= 1e4 ? `${(v / 1e3).toFixed(1)} kt` : `${Math.round(v).toLocaleString('en-IN')} t`);
const fmtD = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Weekly actual-vs-plan history joined to a probabilistic forecast (P10–P90 band, P50 line). */
export function fanChart(el, { hist, weeks, title = '', extra = [] }) {
  const hx = hist.map((s) => s.period), fx = weeks.map((w) => w.start), x = [...hx, ...fx];
  const nH = hx.length;
  return chart(el, (p) => ({
    legend: { data: ['Actual', 'Plan', 'Forecast P50', 'P10–P90 band', ...extra.map((e) => e.name)] },
    tooltip: {
      trigger: 'axis',
      formatter: (items) => {
        const i = items[0].dataIndex, head = `<b>Week of ${fmtD(x[i])}</b>`;
        if (i < nH) { const h = hist[i]; return `${head}<br>Actual <b>${fmtT(h.actual)}</b><br>Plan ${fmtT(h.plan)} · ${(h.actual / h.plan * 100).toFixed(1)}%${h.rain_mm != null ? `<br>Rain ${h.rain_mm} mm` : ''}`; }
        const w = weeks[i - nH];
        return `${head} <span style="color:${p.forecast}">forecast</span><br>P50 <b>${fmtT(w.p50)}</b> · plan ${fmtT(w.plan)}<br>P10–P90 ${fmtT(w.p10)} – ${fmtT(w.p90)}${w.p_below_90 != null ? `<br>P(&lt;90% of plan) ${(w.p_below_90 * 100).toFixed(0)}%` : ''}${extra.map((e) => (e.data[i] != null ? `<br>${e.name} ${fmtT(e.data[i])}` : '')).join('')}`;
      },
    },
    grid: { left: 8, right: 14, top: 34, bottom: 4, containLabel: true },
    xAxis: { type: 'category', data: x, axisLabel: { formatter: (v) => fmtD(v) }, boundaryGap: true },
    yAxis: { type: 'value', axisLabel: { formatter: (v) => (v >= 1e3 ? `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : v) } },
    series: [
      { name: 'Actual', type: 'bar', data: [...hist.map((s) => s.actual), ...fx.map(() => null)], itemStyle: { color: p.actual, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 14 },
      { name: 'Plan', type: 'line', step: 'middle', data: [...hist.map((s) => s.plan), ...weeks.map((w) => w.plan)], symbol: 'none', lineStyle: { color: p.plan, type: 'dashed', width: 1.5 }, z: 5 },
      { name: 'band-lo', type: 'line', stack: 'band', data: [...hx.map(() => null), ...weeks.map((w) => w.p10)], symbol: 'none', lineStyle: { opacity: 0 }, silent: true },
      { name: 'P10–P90 band', type: 'line', stack: 'band', data: [...hx.map(() => null), ...weeks.map((w) => w.p90 - w.p10)], symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: p.band }, itemStyle: { color: p.band }, silent: true },
      { name: 'Forecast P50', type: 'line', data: [...hx.map(() => null), ...weeks.map((w) => w.p50)], symbol: 'circle', symbolSize: 5, lineStyle: { color: p.forecast, width: 2.5 }, itemStyle: { color: p.forecast }, z: 6,
        markLine: fx.length ? { silent: true, symbol: 'none', label: { formatter: 'forecast →', color: p.muted, fontSize: 10, position: 'insideEndTop' }, lineStyle: { color: p.faint }, data: [{ xAxis: fx[0] }] } : undefined },
      ...extra.map((e) => ({ name: e.name, type: 'line', data: e.data, symbol: 'none', lineStyle: { color: e.color || p.low, width: 2, type: e.dashed ? 'dashed' : 'solid' }, itemStyle: { color: e.color || p.low }, z: 7 })),
    ],
  }));
}

/** Waterfall: start value, signed contributions, end value. items: [{name, value}] */
export function waterfall(el, { start, items, endLabel, startLabel, plan }) {
  return chart(el, (p) => {
    const names = [startLabel, ...items.map((i) => i.name), endLabel];
    let run = start;
    const base = [0], up = [start], down = [null];
    items.forEach((it) => {
      if (it.value >= 0) { base.push(run); up.push(it.value); down.push(null); run += it.value; }
      else { run += it.value; base.push(run); up.push(null); down.push(-it.value); }
    });
    base.push(0); up.push(run); down.push(null);
    const lo = Math.min(start, run, ...base.slice(1, -1)) * 0.97;
    return {
      legend: false,
      grid: { left: 8, right: 14, top: 20, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (it) => { const i = it[0].dataIndex; const v = i === 0 ? start : i === names.length - 1 ? run : items[i - 1].value; return `<b>${names[i]}</b><br>${i === 0 || i === names.length - 1 ? fmtT(v) : `${v >= 0 ? '+' : '−'}${fmtT(Math.abs(v))}`}`; } },
      xAxis: { type: 'category', data: names, axisLabel: { interval: 0, fontSize: 10.5, formatter: (v) => v.replace(' ', '\n') } },
      yAxis: { type: 'value', min: Math.floor(lo / 100) * 100, axisLabel: { formatter: (v) => (v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v) } },
      series: [
        { type: 'bar', stack: 'w', data: base, itemStyle: { color: 'transparent' }, silent: true },
        { type: 'bar', stack: 'w', data: up.map((v, i) => (v == null ? null : { value: v, itemStyle: { color: i === 0 || i === names.length - 1 ? p.forecast : p.low, borderRadius: 3 } })), barMaxWidth: 34,
          label: { show: true, position: 'top', fontSize: 10, color: p.muted, formatter: (d) => (d.dataIndex === 0 || d.dataIndex === names.length - 1 ? fmtT(d.value) : `+${fmtT(d.value)}`) } },
        { type: 'bar', stack: 'w', data: down.map((v) => (v == null ? null : { value: v, itemStyle: { color: p.crit, borderRadius: 3 } })), barMaxWidth: 34,
          label: { show: true, position: 'bottom', fontSize: 10, color: p.muted, formatter: (d) => `−${fmtT(d.value)}` },
          markLine: plan ? { silent: true, symbol: 'none', data: [{ yAxis: plan }], lineStyle: { color: p.plan, type: 'dashed' }, label: { formatter: `plan ${fmtT(plan)}`, color: p.muted, fontSize: 10, position: 'insideEndTop' } } : undefined },
      ],
    };
  });
}

export function rerenderCharts() { live.forEach((el) => { if (document.body.contains(el)) el._render?.(); else live.delete(el); }); }
export function disposeCharts() {
  live.forEach((el) => { el._ro?.disconnect(); echarts.getInstanceByDom(el)?.dispose(); });
  live.clear();
}
export { echarts };
