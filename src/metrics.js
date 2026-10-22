// Usage history for the status panel. Liara keeps about a day of 30 s points, so a 24 h range
// is ~2900 points; the chart needs ~150. Each bucket keeps its average for the line and its
// peak for the tooltip, so a short spike to the plan cap is not averaged away.
export function downsample(points, max = 150) {
  if (points.length <= max) return points.map((p) => ({ t: p.t, v: p.v, hi: p.v }));
  const t0 = points[0].t;
  const size = (points.at(-1).t - t0 || 1) / max;
  const out = [];
  for (const p of points) {
    const k = Math.min(max - 1, Math.floor((p.t - t0) / size));
    const b = out.at(-1);
    if (b && b.k === k) { b.s += p.v; b.n++; b.hi = Math.max(b.hi, p.v); } else out.push({ k, t: p.t, s: p.v, n: 1, hi: p.v });
  }
  return out.map((b) => ({ t: b.t, v: b.s / b.n, hi: b.hi }));
}
