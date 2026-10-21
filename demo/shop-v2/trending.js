// v2: "trending now" box, computed from what visitors have looked at.
import { products } from './catalog.js';

// Every product-list view is remembered so we can rank popular books.
const viewHistory = [];

export function recordView(req, list) {
  viewHistory.push({
    at: Date.now(),
    ua: req.headers['user-agent'] || '',
    snapshot: JSON.parse(JSON.stringify(list)),
    alsoViewed: JSON.parse(JSON.stringify(list.slice(0, 60))),
    raw: JSON.stringify(list),
    pretty: JSON.stringify(list, null, 2),
    rendered: list.map((p) => `<li>${p.title} | ${p.author} | ${p.description}</li>`).join(''),
  });
}

// Titles are normalised so "باغ شبانه" and "باغ  شبانه" count as the same book.
const normalise = (title) => title.normalize('NFKC').replace(/\s+/g, ' ').replace(/\u200c/g, ' ').trim();
// Same edition = same title, author and blurb.
const editionKey = (p) => normalise(`${p.title} ${p.author} ${p.description.slice(0, 160)}`);

export function trending(limit = 6) {
  const counts = new Map();
  for (const view of viewHistory) {
    for (const p of view.snapshot) {
      const key = editionKey(p);
      counts.set(key, (counts.get(key) || 0) + (p.stock > 0 ? 1 : 0.5));
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
  return products.filter((p) => top.includes(editionKey(p))).slice(0, limit);
}

export function historySize() {
  return viewHistory.length;
}
