/* Global UI state: mine in focus, theme, platform metadata. */
const listeners = new Set();
const saved = (() => { try { return JSON.parse(localStorage.getItem('moil-ui') || '{}'); } catch { return {}; } })();

export const state = {
  mine: saved.mine || 'balaghat',
  theme: document.documentElement.dataset.theme || 'light',
  meta: null,
};

export function set(patch) {
  Object.assign(state, patch);
  try { localStorage.setItem('moil-ui', JSON.stringify({ mine: state.mine })); } catch { /* private mode */ }
  listeners.forEach((fn) => fn(patch));
}
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const mineMeta = (id = state.mine) => state.meta?.mines.find((m) => m.id === id);
