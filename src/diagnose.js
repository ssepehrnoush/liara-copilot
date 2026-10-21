// SRE evidence engine. Collects status, releases, logs, events, CPU/RAM and live
// HTTP probes in parallel, then turns them into ranked, evidence-backed hypotheses.
// The LLM explains and refines these; the numbers come from here, not from the model.
import { httpCheck } from './probe.js';

const MB = 1024 * 1024;
const incidents = new Map();
let incidentSeq = 0;

const ERROR_RE = /\b(error|exception|traceback|fatal|unhandled|uncaught|panic|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EADDRINUSE|heap out of memory|killed|segfault|cannot find module|is not defined|is not set|undefined|status[=: ]5\d\d|\s5\d\d\s)/i;
const ENV_RES = [
  /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{3,})\b['"`]?\s*(?:env(?:ironment)? var(?:iable)? )?(?:is not set|is not defined|is missing|is required|is undefined|not configured|missing)/g,
  /(?:missing|required|undefined|unset)\s+(?:env(?:ironment)?(?: var(?:iable)?)?|config(?:uration)?)\s*[:'"` ]+([A-Z][A-Z0-9_]{2,})/gi,
  /KeyError: '([A-Z][A-Z0-9_]{2,})'/g,
];
const NOT_ENV = new Set(['ERROR', 'TYPEERROR', 'WARN', 'INFO', 'FATAL', 'HTTP', 'GET', 'POST', 'PUT', 'DELETE', 'JSON', 'API', 'URL']);
const n = (v, d = 0) => (v === null || v === undefined ? '-' : Number(v).toLocaleString('fa-IR', { maximumFractionDigits: d }));
const DEP_RE = /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|connection refused|could not connect|timeout acquiring|getaddrinfo)[^\n]{0,80}/i;
const OOM_RE = /(OOMKilled|out of memory|heap out of memory|Killed|exit code 137|exceeded (its )?memory limit)/i;
const RESTART_RE = /(Back-off restarting|CrashLoopBackOff|restart(ed|ing)? (the )?container|container (died|exited|restarted)|Liveness probe failed|Readiness probe failed|unhealthy)/i;

function signature(line) {
  return line
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z?/g, '<t>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(\.\d+)?(ms|s|mb|kb)?/gi, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function linreg(points) {
  const n = points.length;
  if (n < 3) return { slopePerMin: 0, r2: 0 };
  const xs = points.map((p) => (p.t - points[0].t) / 60000);
  const ys = points.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slopePerMin: slope, r2 };
}

function seriesStats(points) {
  if (!points?.length) return null;
  const vals = points.map((p) => p.v);
  const { slopePerMin, r2 } = linreg(points);
  return {
    points: points.length,
    first: vals[0],
    last: vals[vals.length - 1],
    min: Math.min(...vals),
    max: Math.max(...vals),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    slopePerMin,
    r2,
    spanMin: Math.round((points[points.length - 1].t - points[0].t) / 60000),
  };
}

function settle(p) {
  return p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e?.fa || e?.message || String(e) }));
}

function analyzeLogs(lines, appEnvKeys) {
  const groups = new Map();
  const missingEnv = new Map();
  const depErrors = [];
  let errorCount = 0;
  let firstErrorAt = null;
  const accessCodes = {};
  const counters = new Map();
  const latencies = [];
  lines.forEach((l, i) => {
    const text = l.line || '';
    const code = text.match(/\b(GET|POST|PUT|DELETE|PATCH)\s+\S+\s+(\d{3})\b(?:\s+(\d+)ms)?/);
    if (code) {
      accessCodes[code[2]] = (accessCodes[code[2]] || 0) + 1;
      if (code[3]) latencies.push(Number(code[3]));
    }
    // Periodic "stats key=value" lines: remember first/last value of each counter.
    if (/\b(stats?|metrics|memory|heap|cache|queue|size|count)\b/i.test(text)) {
      for (const m of text.matchAll(/\b([A-Za-z][\w.]{2,30})=(\d+(?:\.\d+)?)(MB|KB|ms)?\b/g)) {
        const k = m[1] + (m[3] ? ` (${m[3]})` : '');
        const v = Number(m[2]);
        const c = counters.get(k) || { key: k, first: v, last: v, n: 0 };
        c.last = v;
        c.n++;
        counters.set(k, c);
      }
    }
    if (!ERROR_RE.test(text) || /\b(GET|POST)\s+\S+\s+[23]\d\d\b/.test(text)) return;
    errorCount++;
    if (!firstErrorAt) firstErrorAt = l.t;
    const sig = signature(text);
    const g = groups.get(sig) || { count: 0, first: l.t, last: l.t, sample: text.slice(0, 300), context: [] };
    g.count++;
    g.last = l.t;
    if (!g.context.length) g.context = lines.slice(i + 1, i + 4).map((x) => x.line.slice(0, 200)).filter((x) => /^\s+at |File "|line \d+/.test(x));
    groups.set(sig, g);
    for (const re of ENV_RES) {
      const k = [...text.matchAll(re)].map((m) => m[1]).find((x) => x && !NOT_ENV.has(x.toUpperCase()));
      if (k) {
        missingEnv.set(k, { key: k, count: (missingEnv.get(k)?.count || 0) + 1, sample: text.replace(/^\S+\s+/, '').slice(0, 220), presentInApp: appEnvKeys.includes(k) });
        break;
      }
    }
    const dep = text.match(DEP_RE);
    if (dep && depErrors.length < 5) depErrors.push(dep[0]);
  });
  const top = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  const growing = [...counters.values()].filter((c) => c.n >= 3 && c.last > c.first * 2 && c.last - c.first >= 20).slice(0, 4);
  const third = Math.max(1, Math.floor(latencies.length / 3));
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const latencyTrend = latencies.length >= 9 ? { earlyMs: med(latencies.slice(0, third)), lateMs: med(latencies.slice(-third)) } : null;
  return { total: lines.length, errorCount, firstErrorAt, top, missingEnv: [...missingEnv.values()], depErrors, accessCodes, growing, latencyTrend };
}

function iso(t) {
  return t ? new Date(t).toISOString() : null;
}

export async function collectEvidence(liara, appName, { minutes = 30, paths = ['/'], planCatalog } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const since = nowSec - minutes * 60;
  const app = await liara.getApp(appName);
  const url = liara.appUrl(appName);
  const [releases, applets, logs, events, cpu, mem, summary, probe, catalog] = await Promise.all([
    settle(liara.listReleases(appName, 5)),
    settle(liara.applets(appName)),
    settle(liara.logs(appName, { startSec: since, limit: 600 })),
    settle(liara.events(appName, { startSec: nowSec - 6 * 3600, endSec: nowSec })),
    settle(liara.metric(appName, 'cpu', since)),
    settle(liara.metric(appName, 'memory', since)),
    settle(liara.metricsSummary(appName)),
    settle(httpCheck(url, { paths, samples: 3, timeoutMs: 6000 })),
    planCatalog ? Promise.resolve({ ok: true, v: planCatalog }) : settle(liara.catalog()),
  ]);
  const plan = catalog.ok ? catalog.v.plans.find((p) => p.id === app.planID) : null;
  const ramLimit = (plan?.ramGB || null) && plan.ramGB * 1024 * MB;
  const cpuLimit = plan?.cpu || null;
  const logA = logs.ok ? analyzeLogs(logs.v, app.envs.map((e) => e.key)) : null;
  const memS = mem.ok ? seriesStats(mem.v) : null;
  let cpuS = cpu.ok ? seriesStats(cpu.v) : null;
  // CPU may come back as cores or as percent depending on the endpoint; normalise to % of plan.
  let cpuPct = null;
  if (cpuS && cpuLimit) {
    const asPercent = cpuS.max > cpuLimit * 1.5;
    cpuPct = {
      avg: Math.round(asPercent ? cpuS.avg : (cpuS.avg / cpuLimit) * 100),
      max: Math.round(asPercent ? cpuS.max : (cpuS.max / cpuLimit) * 100),
    };
  }
  const evs = events.ok ? events.v : [];
  const oomEvents = evs.filter((e) => OOM_RE.test(e.text));
  const restartEvents = evs.filter((e) => RESTART_RE.test(e.text));
  const rel = releases.ok ? releases.v.releases : [];
  const latest = rel[0] || null;
  const prevReady = rel.slice(1).find((r) => r.state === 'READY') || null;

  const evidence = {
    app: { name: app.name, status: app.status, scale: app.scale, planID: app.planID, bundlePlanID: app.bundlePlanID, platform: app.platform, url, envKeys: app.envs.map((e) => e.key) },
    limits: { ramMB: ramLimit ? Math.round(ramLimit / MB) : null, cpuCores: cpuLimit },
    window: { minutes, from: iso(since * 1000), to: iso(nowSec * 1000) },
    probe: probe.ok ? probe.v : { error: probe.e },
    releases: rel.slice(0, 4).map((r) => ({ id: r.id, tag: r.tag, state: r.state, createdAt: r.createdAt, finishedAt: r.finishedAt, sourceAvailable: r.sourceAvailable })),
    applets: applets.ok ? applets.v : { error: applets.e },
    logs: logA ? { lines: logA.total, errors: logA.errorCount, firstErrorAt: iso(logA.firstErrorAt), topErrors: logA.top.map((g) => ({ count: g.count, first: iso(g.first), last: iso(g.last), sample: g.sample, stack: g.context })), missingEnv: logA.missingEnv, dependencyErrors: logA.depErrors, accessCodes: logA.accessCodes, growingCounters: logA.growing, latencyTrend: logA.latencyTrend } : { error: logs.e },
    memory: memS ? { firstMB: Math.round(memS.first / MB), lastMB: Math.round(memS.last / MB), maxMB: Math.round(memS.max / MB), slopeMBperMin: Math.round((memS.slopePerMin / MB) * 10) / 10, trendR2: Math.round(memS.r2 * 100) / 100, pctOfLimit: ramLimit ? Math.round((memS.last / ramLimit) * 100) : null, maxPctOfLimit: ramLimit ? Math.round((memS.max / ramLimit) * 100) : null, spanMin: memS.spanMin } : { error: mem.ok ? 'no data' : mem.e },
    cpu: cpuS ? { avgPctOfPlan: cpuPct?.avg ?? null, maxPctOfPlan: cpuPct?.max ?? null, points: cpuS.points } : { error: cpu.ok ? 'no data' : cpu.e },
    summaryNow: summary.ok ? { cpu: summary.v.cpu, memoryMB: Math.round((summary.v.memoryBytes || 0) / MB) } : null,
    events: { total: evs.length, oom: oomEvents.slice(-5).map((e) => ({ at: iso(e.t), text: e.text.slice(0, 200) })), restarts: restartEvents.slice(-5).map((e) => ({ at: iso(e.t), text: e.text.slice(0, 200) })), recent: evs.slice(-6).map((e) => ({ at: iso(e.t), text: e.text.slice(0, 160) })) },
    unavailable: [releases, applets, logs, events, cpu, mem].filter((x) => !x.ok).map((x) => x.e),
  };

  const hypotheses = rankHypotheses(evidence, { latest, prevReady });
  const id = `inc-${++incidentSeq}`;
  const record = { id, app: appName, at: Date.now(), paths, baseline: { probe: evidence.probe, memory: evidence.memory, errors: evidence.logs?.errors ?? null, cpu: evidence.cpu }, hypotheses };
  incidents.set(id, record);
  return { incidentId: id, evidence, hypotheses };
}

function rankHypotheses(ev, { latest, prevReady }) {
  const H = [];
  const probe = ev.probe || {};
  const err5xx = (probe.paths || []).reduce((a, p) => a + p.errors5xx, 0);
  const total = probe.total || 0;
  const timeouts = (probe.paths || []).reduce((a, p) => a + p.failures, 0);
  const lt = ev.logs?.latencyTrend;
  const slow = (probe.p50ms && probe.p50ms > 1500) || timeouts > 0 || (lt && lt.lateMs > 1500);
  const slowFa = probe.p50ms > 1500 ? `زمان پاسخ میانه ${n(probe.p50ms)} میلی‌ثانیه است` : timeouts ? `${n(timeouts)} درخواست تست به تایم‌اوت خورد` : lt ? `زمان پاسخ در لاگ‌ها ${n(lt.lateMs)} میلی‌ثانیه است` : '';
  const latestAt = latest?.finishedAt ? Date.parse(latest.finishedAt) : latest?.createdAt ? Date.parse(latest.createdAt) : null;
  const firstErr = ev.logs?.firstErrorAt ? Date.parse(ev.logs.firstErrorAt) : null;

  if (ev.app.scale === 0) {
    H.push({ id: 'app_stopped', title: 'سرویس خاموش است', confidence: 0.97, evidence: ['مقدار scale برنامه صفر است؛ یعنی هیچ کانتینری اجرا نمی‌شود.'], fix: { tool: 'start_app', fa: 'روشن کردن دوبارهٔ سرویس' } });
  }

  for (const m of ev.logs?.missingEnv || []) {
    H.push({
      id: 'missing_env',
      title: `متغیر محیطی ${m.key} تنظیم نشده`,
      confidence: m.presentInApp ? 0.55 : 0.93,
      evidence: [
        `در لاگ ${n(m.count)} بار خطا دربارهٔ ${m.key} دیده شد: «${m.sample.slice(0, 140)}»`,
        m.presentInApp ? `${m.key} در تنظیمات اپ وجود دارد ولی شاید مقدارش اشتباه است.` : `${m.key} در متغیرهای اپ روی لیارا وجود ندارد.`,
        latestAt && firstErr && firstErr >= latestAt ? 'خطاها بعد از آخرین ریلیز شروع شده‌اند (کد جدید این متغیر را لازم دارد).' : null,
      ].filter(Boolean),
      fix: { tool: 'set_env_vars', args: { variables: [{ key: m.key }] }, fa: `افزودن ${m.key} به متغیرهای اپ (اپ یک بار ری‌استارت می‌شود)` },
      altFix: prevReady?.sourceAvailable ? { tool: 'rollback_release', args: { releaseID: prevReady.id }, fa: `برگشت به ریلیز قبلی (${prevReady.tag || prevReady.id})` } : null,
    });
  }

  const mem = ev.memory || {};
  const oom = ev.events?.oom?.length || 0;
  const cpuHot = (ev.cpu?.maxPctOfPlan || 0) >= 85;
  const leak = mem.slopeMBperMin > 2 && mem.trendR2 > 0.7;
  if (mem.maxPctOfLimit >= 80 || oom || (leak && mem.maxPctOfLimit >= 30)) {
    H.push({
      id: leak ? 'memory_leak' : 'memory_pressure',
      title: leak ? 'نشت حافظه (رم مدام بالا می‌رود)' : 'کمبود رم نسبت به پلن',
      confidence: Math.min(0.95, 0.35 + (leak ? 0.2 : 0) + (mem.maxPctOfLimit >= 60 ? 0.15 : 0) + (mem.maxPctOfLimit >= 85 ? 0.1 : 0) + (oom ? 0.15 : 0) + (slow ? 0.1 : 0) + (leak && cpuHot ? 0.05 : 0) + ((ev.logs?.growingCounters || []).length ? 0.05 : 0)),
      evidence: [
        mem.firstMB != null ? `رم در ${n(mem.spanMin)} دقیقه از ${n(mem.firstMB)} به ${n(mem.lastMB)} مگابایت رسیده (${n(mem.maxPctOfLimit)}٪ سقف ${n(ev.limits.ramMB)} مگابایتی پلن).` : null,
        leak ? `شیب رشد حدود ${n(mem.slopeMBperMin, 1)} مگابایت در دقیقه و تقریباً خطی است (R²=${mem.trendR2})؛ این الگوی نشت حافظه است نه یک جهش ترافیکی.` : null,
        oom ? `${n(oom)} رویداد کمبود حافظه (OOM) و کشته شدن کانتینر ثبت شده.` : null,
        slow ? `${slowFa}.` : null,
        lt && lt.lateMs > lt.earlyMs * 3 ? `زمان پاسخ در لاگ دسترسی از ${n(lt.earlyMs)} به ${n(lt.lateMs)} میلی‌ثانیه رسیده؛ کندی هم‌پای رشد داده‌ها بیشتر شده.` : null,
        ...(ev.logs?.growingCounters || []).map((c) => `در لاگ برنامه، شمارندهٔ ${c.key} از ${n(c.first)} به ${n(c.last)} رسیده و پایین نیامده.`),
        cpuHot && leak ? 'CPU هم به سقف رسیده؛ کدی که روی این دادهٔ رو به رشد کار می‌کند هر بار سنگین‌تر می‌شود، پس کمبود CPU نتیجهٔ همین مشکل است.' : null,
      ].filter(Boolean),
      fix: { tool: 'restart_app', fa: 'ری‌استارت برای خالی شدن رم (راه‌حل موقت، چند ثانیه قطعی)' },
      altFix: leak ? { tool: 'handoff_to_coding_agent', fa: 'پیدا کردن محل نشت در کد و فرستادن اصلاحیه برای ایجنت کدنویس' } : { tool: 'change_plan', fa: 'ارتقای پلن به رم بیشتر (هزینه دارد)' },
    });
  }

  const cpu = ev.cpu || {};
  if (cpu.maxPctOfPlan >= 85) {
    const fromLeak = H.some((h) => h.id === 'memory_leak');
    H.push({
      id: 'cpu_saturation',
      title: fromLeak ? 'پردازنده به سقف پلن رسیده (نشانهٔ همان نشت)' : 'پردازنده به سقف پلن رسیده',
      confidence: (cpu.avgPctOfPlan >= 70 ? 0.75 : 0.5) - (fromLeak ? 0.2 : 0),
      evidence: [`مصرف CPU به ${n(cpu.maxPctOfPlan)}٪ سهم پلن رسیده (میانگین ${n(cpu.avgPctOfPlan)}٪).`, slow ? `کندی (${slowFa}) با اشباع CPU هم‌خوان است.` : null, fromLeak ? 'چون رم هم خطی بالا می‌رود، ارتقای پلن فقط مشکل را عقب می‌اندازد.' : null].filter(Boolean),
      fix: { tool: fromLeak ? 'handoff_to_coding_agent' : 'change_plan', fa: fromLeak ? 'اصلاح کد مسبب نشت' : 'ارتقای پلن یا بهینه‌سازی کد پرمصرف' },
    });
  }

  if ((ev.logs?.dependencyErrors || []).length) {
    H.push({ id: 'dependency_down', title: 'سرویس وابسته (دیتابیس یا API بیرونی) در دسترس نیست', confidence: 0.7, evidence: ev.logs.dependencyErrors.slice(0, 3).map((d) => `لاگ: «${d}»`), fix: { tool: null, fa: 'بررسی آدرس و وضعیت دیتابیس یا سرویس بیرونی' } });
  }

  const restarts = ev.events?.restarts?.length || 0;
  if (restarts >= 2 && !oom) {
    H.push({ id: 'crash_loop', title: 'کانتینر مدام کرش و ری‌استارت می‌شود', confidence: 0.65, evidence: [`${n(restarts)} رویداد ری‌استارت یا ناسالم بودن در ۶ ساعت اخیر.`], fix: { tool: 'get_logs', fa: 'خواندن لاگ لحظهٔ کرش' } });
  }

  if (err5xx && latestAt && firstErr && firstErr >= latestAt && !H.some((h) => h.id === 'missing_env')) {
    H.push({
      id: 'bad_release',
      title: 'باگ در آخرین نسخهٔ منتشرشده',
      confidence: 0.6,
      evidence: [`${n(err5xx)} از ${n(total)} درخواست تست خطای 5xx گرفت.`, `اولین خطا ${new Date(firstErr).toLocaleTimeString('fa-IR')} بعد از انتشار ریلیز ${latest.tag || ''} ثبت شده.`, ev.logs.topErrors[0] ? `خطای غالب: «${ev.logs.topErrors[0].sample.slice(0, 140)}»` : null].filter(Boolean),
      fix: prevReady?.sourceAvailable ? { tool: 'rollback_release', args: { releaseID: prevReady.id }, fa: 'برگشت به ریلیز سالم قبلی' } : { tool: 'handoff_to_coding_agent', fa: 'ارسال گزارش خطا به ایجنت کدنویس' },
    });
  } else if (err5xx && !H.length) {
    H.push({ id: 'app_error', title: 'خطای داخلی برنامه', confidence: 0.55, evidence: [`${n(err5xx)} از ${n(total)} درخواست خطای 5xx گرفت.`, ev.logs?.topErrors?.[0] ? `خطای غالب در لاگ: «${ev.logs.topErrors[0].sample.slice(0, 140)}»` : 'در بازهٔ لاگ خطای مشخصی پیدا نشد.'], fix: { tool: 'handoff_to_coding_agent', fa: 'ارسال جزئیات خطا به ایجنت کدنویس' } });
  }

  if (slow && !H.some((h) => ['memory_leak', 'memory_pressure', 'cpu_saturation'].includes(h.id))) {
    H.push({ id: 'slow_app', title: 'کندی بدون کمبود منابع (احتمالاً کوئری یا سرویس بیرونی کند)', confidence: 0.45, evidence: [`میانهٔ زمان پاسخ ${n(probe.p50ms)} میلی‌ثانیه است ولی رم و CPU در محدودهٔ عادی است.`], fix: { tool: 'search_project_code', fa: 'بررسی کد مسیرهای کند' } });
  }

  if (!H.length) {
    H.push({ id: 'no_server_issue', title: 'از سمت سرور مشکلی دیده نشد', confidence: 0.6, evidence: [`${n(probe.ok ?? 0)} از ${n(total)} درخواست تست موفق بود (میانه ${n(probe.p50ms)} میلی‌ثانیه).`, 'در لاگ‌ها و رویدادها خطای جدی نبود.'], fix: { tool: null, fa: 'بررسی سمت کاربر: اینترنت، DNS یا کش مرورگر' } });
  }
  return H.sort((a, b) => b.confidence - a.confidence).map((h, i) => ({ rank: i + 1, ...h, confidence: Math.round(h.confidence * 100) }));
}

export function getIncident(id) {
  return incidents.get(id);
}

export function latestIncident(app) {
  return [...incidents.values()].filter((i) => i.app === app).sort((a, b) => b.at - a.at)[0];
}

export async function verifyRecovery(liara, appName, incidentId, { sinceMs } = {}) {
  const inc = (incidentId && incidents.get(incidentId)) || latestIncident(appName);
  const paths = inc?.paths || ['/'];
  const nowSec = Math.floor(Date.now() / 1000);
  const fromMs = sinceMs || Date.now() - 120000;
  const fromSec = Math.floor(fromMs / 1000);
  const [probe, logs, mem] = await Promise.all([
    httpCheck(liara.appUrl(appName), { paths, samples: 5 }),
    settle(liara.logs(appName, { startSec: fromSec, limit: 300 })),
    settle(liara.metric(appName, 'memory', nowSec - 5 * 60)),
  ]);
  const errorsAfter = logs.ok ? logs.v.filter((l) => (l.t || 0) >= fromMs && ERROR_RE.test(l.line) && !/\b(GET|POST)\s+\S+\s+[23]\d\d\b/.test(l.line)).length : null;
  const memNow = mem.ok && mem.v.length ? Math.round(mem.v[mem.v.length - 1].v / MB) : null;
  const before = inc?.baseline || {};
  const okBefore = before.probe?.total ? Math.round((before.probe.ok / before.probe.total) * 100) : null;
  const okAfter = probe.total ? Math.round((probe.ok / probe.total) * 100) : 0;
  const latencyImproved = before.probe?.p50ms && probe.p50ms ? probe.p50ms < before.probe.p50ms * 0.6 : null;
  let verdict = 'not_recovered';
  if (okAfter === 100 && (errorsAfter === 0 || errorsAfter === null) && (probe.p50ms ?? 0) < 1500) verdict = 'recovered';
  else if (okAfter > (okBefore ?? 0) || latencyImproved) verdict = 'improved';
  return {
    incidentId: inc?.id || null,
    verdict,
    verdictFa: { recovered: 'مشکل برطرف شد', improved: 'بهتر شده ولی کامل نه', not_recovered: 'هنوز برطرف نشده' }[verdict],
    before: inc ? { successPct: okBefore, p50ms: before.probe?.p50ms ?? null, errorsInLogs: before.errors, memoryMB: before.memory?.lastMB ?? null } : null,
    after: { successPct: okAfter, p50ms: probe.p50ms, errorsInLogsSinceFix: errorsAfter, memoryMB: memNow },
    probe,
  };
}
