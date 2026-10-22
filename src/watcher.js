// Light health watcher (not 24/7 SRE, just an early warning while the copilot is open):
// probes each managed app's pages and reads its RAM, then raises an alert on a change.
import { httpCheck } from './probe.js';
import { managedApps, appInfo } from './scope.js';
import { audit } from './audit.js';
import { config } from './config.js';

const MB = 1024 * 1024;
const state = new Map();

function health(app) {
  if (!state.has(app)) state.set(app, { probes: [], baselineMs: null, level: 'unknown', mem: null, lastAlertAt: 0, alert: null });
  return state.get(app);
}

export function healthSnapshot(app) {
  const h = state.get(app);
  if (!h) return null;
  const last = h.probes.at(-1);
  return { level: h.level, lastProbe: last || null, baselineMs: h.baselineMs, alert: h.alert, mem: h.mem, history: h.probes.slice(-20).map((p) => ({ t: p.t, ms: p.p50ms, ok: p.ok === p.total })) };
}

function judge(h) {
  const recent = h.probes.slice(-3);
  if (recent.length < 2) return { level: 'unknown' };
  const last = recent.at(-1);
  const with5xx = recent.filter((p) => p.paths.some((x) => x.errors5xx > 0)).length;
  const lat = recent.map((p) => p.p50ms || 0).sort((a, b) => a - b)[Math.floor(recent.length / 2)];
  const timeouts = last.paths.reduce((a, x) => a + x.failures, 0);
  // No answer at all (timeouts, connection errors) is the worst case, not a healthy one.
  const dead = recent.filter((p) => p.ok === 0).length;
  if (dead >= 2) return { level: 'down', fa: 'سایت جواب نمی‌دهد: درخواست‌ها به تایم‌اوت یا خطای سرور خوردند' };
  if (with5xx >= 2) {
    const sample = last.paths.find((x) => x.errors5xx > 0) || last.paths[0];
    return { level: 'down', fa: `صفحهٔ ${sample?.path || '/'} خطا می‌دهد (${Object.keys(sample?.codes || {}).join('، ')})` };
  }
  if (timeouts && recent.slice(0, -1).some((p) => (p.p50ms || 0) > 1000)) return { level: 'degraded', fa: 'سایت خیلی کند شده و بعضی درخواست‌ها به تایم‌اوت خوردند' };
  if (h.mem?.pct >= 85) return { level: 'degraded', fa: `مصرف رم به ${h.mem.pct}٪ سقف پلن رسیده` };
  const slow = Math.max(lat, last.p50ms || 0);
  if (slow > 1500 && (!h.baselineMs || slow > h.baselineMs * 3)) return { level: 'degraded', fa: `سایت کند شده: زمان پاسخ حدود ${slow.toLocaleString('fa-IR')} میلی‌ثانیه${h.baselineMs ? ` (حالت عادی ${h.baselineMs.toLocaleString('fa-IR')})` : ''}` };
  return { level: 'healthy' };
}

let pokeTimer = null;
let runNow = null;
// Re-check soon after a fix so the status and alert do not lag behind reality.
export function pokeWatcher(delayMs = 4000) {
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => runNow?.(), delayMs);
}

// onChecked(app, snapshot) runs after each app check without holding up the next one; the
// standing rules hang off it.
export function startWatcher(liara, onAlert, onChecked) {
  let tick = 0;
  const run = async () => {
    tick++;
    let existing = [];
    try { existing = (await liara.listApps()).filter((a) => a.isDeployed && a.scale !== 0).map((a) => a.name); } catch { return; }
    const apps = managedApps().filter((n) => existing.includes(n));
    await Promise.all(apps.map(async (name) => {
      const h = health(name);
      try {
        const info = appInfo(name) || {};
        const paths = (info.watchPaths?.length ? info.watchPaths : ['/']).slice(0, 4);
        const p = await httpCheck(liara.appUrl(name), { paths, samples: 1, timeoutMs: 8000 });
        h.probes.push({ t: Date.now(), ok: p.ok, total: p.total, p50ms: p.p50ms, paths: p.paths });
        if (h.probes.length > 60) h.probes.shift();
        if (p.ok === p.total && p.p50ms && (h.level === 'healthy' || h.level === 'unknown')) h.baselineMs = h.baselineMs ? Math.round(h.baselineMs * 0.9 + Math.min(p.p50ms, h.baselineMs * 1.5) * 0.1) : p.p50ms;
        if (tick % 2 === 1) {
          const [s, a, cat] = await Promise.all([liara.metricsSummary(name), liara.getApp(name), liara.catalog()]);
          const plan = cat.plans.find((x) => x.id === a.planID);
          const mb = Math.round((s.memoryBytes || 0) / MB);
          h.mem = { mb, limitMB: plan ? plan.ramGB * 1024 : null, pct: plan ? Math.round((mb / (plan.ramGB * 1024)) * 100) : null };
        }
      } catch {
        /* app may be deploying; try next tick */
      }
      const j = judge(h);
      const prev = h.level;
      h.level = j.level;
      onChecked?.(name, { level: j.level, fa: j.fa, mem: h.mem, probes: h.probes.slice(-3) })?.catch?.(() => {});
      if ((j.level === 'down' || j.level === 'degraded') && (prev !== j.level || Date.now() - h.lastAlertAt > 5 * 60 * 1000)) {
        h.lastAlertAt = Date.now();
        h.alert = { app: name, level: j.level, fa: j.fa, at: Date.now() };
        audit({ actor: 'watcher', kind: 'alert', tool: 'health_watch', risk: 'auto', app: name, summary: j.fa, status: j.level });
        onAlert(h.alert);
      }
      if (j.level === 'healthy' && prev !== 'healthy' && h.alert) {
        h.alert = null;
        onAlert({ app: name, level: 'healthy', fa: 'سرویس دوباره سالم است', at: Date.now() });
      }
    }));
  };
  runNow = () => run().catch(() => {});
  const timer = setInterval(() => run().catch(() => {}), config.watchIntervalSec * 1000);
  setTimeout(() => run().catch(() => {}), 3000);
  return () => clearInterval(timer);
}
