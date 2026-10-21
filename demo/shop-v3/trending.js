// v3: "trending now" box. Keeps one counter per book instead of a copy of every visit,
// so memory stays flat and each request costs the same no matter how long the app runs.
import { products } from './catalog.js';

const counts = new Map();
let views = 0;

export function recordView(_req, list) {
  views++;
  for (const p of list) counts.set(p.id, (counts.get(p.id) || 0) + (p.stock > 0 ? 1 : 0.5));
}

export function trending(limit = 6) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => products[id - 1]);
}

export function historySize() {
  return views;
}
