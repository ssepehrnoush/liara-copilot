// Simulated visitors for the demo: node demo/loadgen.js <url> [requestsPerSecond] [minutes]
// Prints throughput, errors and latency every 5 seconds so the slowdown is visible on camera.
const [, , base = 'http://127.0.0.1:4300', rpsArg = '5', minArg = '10'] = process.argv;
const rps = Number(rpsArg);
const stopAt = Date.now() + Number(minArg) * 60000;
const paths = ['/', '/api/products', '/', '/api/products', '/health'];
let window = [];
let i = 0;

async function one() {
  const p = paths[i++ % paths.length];
  const t0 = performance.now();
  try {
    const r = await fetch(new URL(p, base), { signal: AbortSignal.timeout(15000) });
    await r.arrayBuffer();
    window.push({ ok: r.status < 500, ms: performance.now() - t0 });
  } catch {
    window.push({ ok: false, ms: performance.now() - t0 });
  }
}

const timer = setInterval(() => {
  if (Date.now() > stopAt) {
    clearInterval(timer);
    clearInterval(report);
    return;
  }
  one();
}, 1000 / rps);

const report = setInterval(() => {
  const w = window;
  window = [];
  if (!w.length) return;
  const lat = w.map((x) => x.ms).sort((a, b) => a - b);
  const p50 = Math.round(lat[Math.floor(lat.length / 2)]);
  const errs = w.filter((x) => !x.ok).length;
  console.log(`${new Date().toLocaleTimeString('en-GB')}  requests=${w.length}  errors=${errs}  p50=${p50}ms  max=${Math.round(lat.at(-1))}ms`);
}, 5000);

console.log(`Sending ~${rps} req/s to ${base} for ${minArg} min (Ctrl+C to stop)`);
