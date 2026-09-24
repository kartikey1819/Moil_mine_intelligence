/* Small HTML building blocks shared by the pages. */
import { esc } from './format.js';

export const loading = (msg = 'Loading…', sub = '') => `<div class="loading-block"><div class="spinner"></div><div><b>${esc(msg)}</b>${sub ? `<div class="small">${esc(sub)}</div>` : ''}</div></div>`;
export const errorBox = (e) => `<div class="err"><b>Could not load.</b> ${esc(e?.message || e)}</div>`;
export const badge = (sev, text = sev) => `<span class="badge ${esc(sev)}">${esc(text)}</span>`;

/** Provenance chip: live | real | sim | ml */
export const src = (kind, text) => `<span class="src ${kind}" title="${esc({ live: 'Fetched live from a public API', real: 'Real observational / reanalysis data', sim: 'Simulated prototype data — replace with MOIL records', ml: 'Model output' }[kind] || '')}">${esc(text)}</span>`;

export function card({ title, sub = '', right = '', body = '', foot = '', cls = '', id = '', bodyCls = '' }) {
  return `<section class="card ${cls}" ${id ? `id="${id}"` : ''}>
    ${title ? `<div class="card-h"><h3>${title}${sub ? ` <span class="sub">${sub}</span>` : ''}</h3><div class="row wrap">${right}</div></div>` : ''}
    <div class="card-b ${bodyCls}">${body}</div>${foot ? `<div class="card-f">${foot}</div>` : ''}</section>`;
}

export function kpi({ label, value, unit = '', foot = '', tone = '', bar = null, icon = '' }) {
  return `<div class="card kpi ${tone}"><div class="lbl">${icon}${label}</div><div class="val">${value}${unit ? `<small>${unit}</small>` : ''}</div>
    ${bar != null ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, bar * 100)).toFixed(1)}%"></i></div>` : ''}<div class="foot">${foot}</div></div>`;
}

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const sevColor = (s) => ({ Critical: 'var(--crit)', High: 'var(--high)', Medium: 'var(--med)', Low: 'var(--low)' }[s] || 'var(--muted)');
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
