// Live HTTP checks against the deployed site: status codes and latency per path.

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function hit(url, timeoutMs) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'LiaraCopilot-Probe/1.0' } });
    const text = await res.text().catch(() => '');
    return { status: res.status, ms: Math.round(performance.now() - t0), snippet: res.status >= 400 ? text.replace(/\s+/g, ' ').slice(0, 160) : undefined };
  } catch (e) {
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    return { status: 0, ms: Math.round(performance.now() - t0), error: timeout ? 'timeout' : (e.cause?.code || e.message) };
  }
}

export async function httpCheck(baseUrl, { paths = ['/'], samples = 4, timeoutMs = 10000 } = {}) {
  const perPath = [];
  for (const p of paths.slice(0, 5)) {
    const url = new URL(p, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
    const results = [];
    for (let i = 0; i < samples; i++) {
      const r = await hit(url, timeoutMs);
      results.push(r);
      // A site that is already timing out does not need more samples to prove it.
      if (results.filter((x) => x.error === 'timeout').length >= 2) break;
    }
    const lat = results.filter((r) => r.status > 0).map((r) => r.ms);
    const codes = {};
    for (const r of results) codes[r.status || r.error] = (codes[r.status || r.error] || 0) + 1;
    perPath.push({
      path: p,
      samples: results.length,
      // A 4xx means the page answered (wrong address, auth); only 5xx and timeouts count as failures.
      ok: results.filter((r) => r.status >= 200 && r.status < 500).length,
      clientErrors: results.filter((r) => r.status >= 400 && r.status < 500).length,
      errors5xx: results.filter((r) => r.status >= 500).length,
      failures: results.filter((r) => r.status === 0).length,
      codes,
      p50ms: pct(lat, 50),
      maxMs: lat.length ? Math.max(...lat) : null,
      sampleError: results.find((r) => r.snippet || r.error)?.snippet || results.find((r) => r.error)?.error,
    });
  }
  const all = perPath.reduce((a, p) => a + p.samples, 0);
  const ok = perPath.reduce((a, p) => a + p.ok, 0);
  const allLat = perPath.map((p) => p.p50ms).filter((v) => v !== null);
  return {
    url: baseUrl,
    at: new Date().toISOString(),
    total: all,
    ok,
    errorRate: all ? Math.round(((all - ok) / all) * 100) : 0,
    p50ms: allLat.length ? Math.round(allLat.reduce((a, b) => a + b, 0) / allLat.length) : null,
    worstMs: Math.max(0, ...perPath.map((p) => p.maxMs || 0)),
    paths: perPath,
  };
}
