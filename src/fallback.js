// Rule-based planner used when no LLM is reachable (budget exhausted, provider blocked,
// network down). It drives the same tools and the same approval gate, so the core
// flows (first deploy, new version, incident -> fix -> verify, status) keep working.
import { managedApps, appInfo } from './scope.js';
import { isSecretKey } from './redact.js';

const fa = (n, d = 0) => (n === null || n === undefined ? '-' : Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d }));
const toman = (n) => `${fa(Math.round(n || 0))} تومان`;

const RE = {
  url: /https?:\/\/(?:www\.)?github\.com\/[^\s]+/i,
  path: /(?:[A-Za-z]:[\\/][^\s"']+|(?:\.{1,2}\/|\/)?[\w.-]+(?:[\\/][\w.-]+)+)/,
  version: /(نسخه(?:ٔ|ی)?\s*(?:جدید|تازه|دوم)|new version|آپدیت|به\s*روز|ریلیز جدید)/i,
  deploy: /(دیپلوی|منتشر|بالا\s*بیا|بالا\s*بیار|deploy|راه\s*اندازی|publish|روی لیارا)/i,
  incident: /(۵۰۰|500|خطا|ارور|error|کند|slow|بالا\s*نمی|down|قطع|هشدار|crash|کرش|مشکل|باز\s*نمی)/i,
  status: /(وضعیت|status|چطوره|مصرف|گزارش)/i,
  verify: /(درست شد|بررسی نتیجه|verify|چک کن ببین)/i,
  yes: /^(بله|آره|اره|باشه|اوکی|ok|okay|yes|انجام بده|بزن بریم|حتما|حتماً)\b/i,
};

function pickApp(text, session) {
  const managed = managedApps();
  const named = managed.find((a) => text.toLowerCase().includes(a.toLowerCase()));
  return named || session.currentApp || managed[managed.length - 1] || null;
}

function pickSource(text) {
  const u = text.match(RE.url);
  if (u) return u[0];
  const p = text.match(RE.path);
  return p ? p[0].replace(/[،.]+$/, '') : null;
}

function hypLine(h) {
  return `${fa(h.rank)}. **${h.title}** (احتمال ${fa(h.confidence)}٪): ${h.evidence[0] || ''}`;
}

export async function runFallback(session, text, { runToolByName, say }) {
  const t = text.trim();

  // A short "yes" continues the step the planner proposed last time.
  if (RE.yes.test(t) && session.fallbackNext) {
    const next = session.fallbackNext;
    session.fallbackNext = null;
    return next();
  }

  if ((RE.version.test(t) || RE.deploy.test(t)) && pickSource(t)) {
    const source = pickSource(t);
    const app = pickApp(t, session);
    if (RE.version.test(t) && app) return newVersion(session, app, source, { runToolByName, say });
    return firstDeploy(session, source, { runToolByName, say });
  }
  if (RE.deploy.test(t)) {
    return say('برای انتشار، مسیر پوشهٔ پروژه یا آدرس ریپوی گیت‌هاب را بنویسید. مثلاً: `demo/shop-v1` یا `https://github.com/user/repo`');
  }
  if (RE.verify.test(t)) {
    const app = pickApp(t, session);
    if (!app) return say('هنوز سرویسی که با کوپایلت ساخته شده باشد ندارم.');
    return verify(session, app, { runToolByName, say });
  }
  if (RE.incident.test(t)) {
    const app = pickApp(t, session);
    if (!app) return say('اسم سرویس را بنویسید تا بررسی کنم. فعلاً سرویسی با کوپایلت ساخته نشده.');
    const paths = [...new Set((t.match(/\/[a-z0-9\-/]+/gi) || []).filter((p) => p.length > 1))];
    return incident(session, app, t, paths, { runToolByName, say });
  }
  if (RE.status.test(t) || !t) return status(session, { runToolByName, say });
  return say('من الان در «حالت بدون مدل زبانی» کار می‌کنم و این درخواست‌ها را می‌فهمم:\n- انتشار پروژه (با مسیر پوشه یا آدرس گیت‌هاب)\n- انتشار نسخهٔ جدید\n- «سایتم کند شده» یا «خطای ۵۰۰ دارم»\n- «وضعیت سرویس‌ها»');
}

async function firstDeploy(session, source, { runToolByName, say }) {
  const a = await runToolByName('analyze_project', { source });
  if (a.error) return say(`پروژه را نتوانستم بخوانم: ${a.error}`);
  const r = a.recommendation || {};
  const envs = a.envVars || [];
  await say([
    `پروژه را بررسی کردم. خلاصه:`,
    `- نوع پروژه: **${a.platform}** (${a.platformReason})، پورت ${Number(a.port).toLocaleString('fa-IR', { useGrouping: false })}`,
    envs.length ? `- متغیرهای محیطی: ${envs.map((e) => `\`${e.key}\`${isSecretKey(e.key) ? ' (محرمانه)' : ''}`).join('، ')}` : '- متغیر محیطی خاصی لازم ندارد',
    a.databases?.length ? `- به دیتابیس ${a.databases.join('، ')} نیاز دارد؛ دیتابیس را جدا از کنسول یا با من بعداً می‌سازیم.` : null,
    `- پیشنهاد من: پلن **${r.planID}** با بستهٔ ${r.bundlePlanID}، حدود ${toman(r.monthlyToman)} در ماه. ${r.why?.[0] || ''}`,
    '',
    'جزئیات و هزینه را در کارت زیر ببینید و اگر موافقید تأیید کنید.',
  ].filter((x) => x !== null).join('\n'));
  const res = await runToolByName('deploy_new_app', {
    name: a.suggestedName, source: a.dir, platform: a.platform, planID: r.planID, bundlePlanID: r.bundlePlanID, port: a.port,
    env_vars: envs.map((e) => ({ key: e.key, required: false, hint: isSecretKey(e.key) ? 'محرمانه؛ اگر الان ندارید خالی بگذارید' : 'اختیاری' })),
    reason: r.why?.[0] || 'کوچک‌ترین پلن مناسب این پروژه',
  });
  if (res.status === 'rejected_by_user') return say(res.blockedReason ? `انجام نشد: ${res.blockedReason}` : 'باشه، چیزی ساخته نشد. اگر پلن یا نام دیگری می‌خواهید بگویید.');
  if (res.error) return say(`ساخت سرویس انجام نشد: ${res.error}`);
  if (!res.ok) return say(`بیلد یا استقرار موفق نبود (وضعیت ${res.releaseState}). ${res.failReason || ''}\nلاگ بیلد در کارت بالا هست.`);
  return say(`سایت شما روی لیارا زنده است: ${res.url}\n\nتست زنده: ${fa(res.probe?.ok)} از ${fa(res.probe?.total)} درخواست موفق. از این به بعد ناظر سلامت هر چند ثانیه سایت را چک می‌کند و اگر مشکلی دید خبرتان می‌کنم.\n\nقدم بعدی اختیاری: وصل کردن دامنهٔ خودتان.`);
}

async function newVersion(session, app, source, { runToolByName, say }) {
  const res = await runToolByName('deploy_new_version', { app, source, reason: 'نسخهٔ جدیدی که خواستید' });
  if (res.status === 'rejected_by_user') return say('باشه، نسخهٔ فعلی دست نخورد.');
  if (res.error) return say(`انتشار انجام نشد: ${res.error}`);
  if (!res.ok) return say(`نسخهٔ جدید سالم بالا نیامد (وضعیت ${res.releaseState}). نسخهٔ قبلی سر جایش است.`);
  return say(`نسخهٔ جدید ${app} منتشر شد و صفحهٔ اصلی جواب می‌دهد (${fa(res.probe?.ok)} از ${fa(res.probe?.total)} درخواست موفق). اگر جایی از سایت درست کار نکرد بگویید تا بررسی کنم.`);
}

async function verify(session, app, { runToolByName, say }) {
  const v = await runToolByName('verify_recovery', { app });
  if (v.error) return say(`بررسی انجام نشد: ${v.error}`);
  const b = v.before || {};
  const a = v.after || {};
  return say(`نتیجه: **${v.verdictFa}**\n- درخواست موفق: ${b.successPct !== undefined && b.successPct !== null ? `${fa(b.successPct)}٪` : '-'} ← ${fa(a.successPct)}٪\n- زمان پاسخ میانه: ${b.p50ms ? `${fa(b.p50ms)}ms` : '-'} ← ${fa(a.p50ms)}ms\n- خطا در لاگ بعد از اصلاح: ${fa(a.errorsInLogsSinceFix)}${a.memoryMB ? `\n- رم فعلی: ${fa(a.memoryMB)} مگابایت` : ''}`);
}

async function findLeak(app, { runToolByName }) {
  const arrays = await runToolByName('search_project_code', { app, pattern: '^(const|let|var)\\s+\\w+\\s*=\\s*(\\[\\]|new Map\\(\\)|\\{\\})\\s*;' });
  const pushes = await runToolByName('search_project_code', { app, pattern: '\\.(push|set)\\(' });
  if (!arrays.hits?.length || !pushes.hits?.length) return null;
  for (const arr of arrays.hits) {
    const name = arr.text.match(/(?:const|let|var)\s+(\w+)/)?.[1];
    const grow = pushes.hits.find((p) => p.file === arr.file && p.text.includes(`${name}.`));
    if (name && grow) return { name, declared: arr, grows: grow };
  }
  return null;
}

async function incident(session, app, text, paths, { runToolByName, say }) {
  const r = await runToolByName('investigate_incident', { app, symptom: text, paths });
  if (r.error) return say(`نتوانستم اطلاعات ${app} را از لیارا بخوانم: ${r.error}`);
  const hyps = r.hypotheses || [];
  // A leak explains CPU saturation too, so act on the leak when both show up.
  const top = hyps[0]?.id === 'cpu_saturation' && hyps.find((h) => h.id === 'memory_leak') ? hyps.find((h) => h.id === 'memory_leak') : hyps[0];
  await say([`اطلاعات ${app} را جمع کردم (وضعیت، لاگ، رویدادها، CPU و رم، تست زنده). علت‌های احتمالی به ترتیب:`, ...hyps.slice(0, 3).map(hypLine)].join('\n'));
  if (!top) return null;

  if (top.id === 'missing_env') {
    const key = top.fix.args.variables[0].key;
    await say(`کد جدید متغیر \`${key}\` را لازم دارد ولی روی لیارا تعریف نشده. پیشنهاد: مقدارش را ثبت کنیم (اپ یک بار ری‌استارت می‌شود).${top.altFix ? ' راه دیگر: برگشت به نسخهٔ قبلی.' : ''}`);
    const res = await runToolByName('set_env_vars', { app, variables: [{ key, hint: 'مقدار واقعی کلید را وارد کنید' }], reason: `${key} در لاگ خطا داده و در متغیرهای اپ نیست.` });
    if (res.status === 'rejected_by_user') {
      if (top.altFix?.tool === 'rollback_release') {
        session.fallbackNext = () => rollback(session, app, top.altFix.args.releaseID, { runToolByName, say });
        return say('باشه، متغیر را ثبت نکردم. اگر بخواهید به نسخهٔ قبلی برمی‌گردیم؛ بنویسید «بله».');
      }
      return say('باشه، تغییری ندادم.');
    }
    if (res.error || res.ok === false) return say(`ثبت متغیر انجام نشد: ${res.error || ''}`);
    return verify(session, app, { runToolByName, say });
  }

  if (top.id === 'memory_leak' || top.id === 'memory_pressure' || top.id === 'data_growth') {
    const leak = await findLeak(app, { runToolByName });
    if (leak) {
      await say(`در کد هم دنبال علت گشتم: آرایهٔ \`${leak.name}\` در \`${leak.declared.file}:${leak.declared.line}\` تعریف شده و در \`${leak.grows.file}:${leak.grows.line}\` با هر بازدید بزرگ‌تر می‌شود ولی هیچ‌جا خالی نمی‌شود. یعنی نشت حافظه در کد است و ارتقای پلن فقط مشکل را عقب می‌اندازد.`);
      await runToolByName('handoff_to_coding_agent', {
        app,
        title: `Memory leak: \`${leak.name}\` grows on every request`,
        problem: `The app's memory grows steadily until it hits the plan limit, then responses slow down and the container is OOM-killed.`,
        evidence: top.evidence,
        root_cause: `\`${leak.name}\` is a module-level collection that gets a new entry on every request and is never trimmed.`,
        files: [`${leak.declared.file}:${leak.declared.line}`, `${leak.grows.file}:${leak.grows.line}`],
        suggested_fix: `Keep only aggregated counts instead of full snapshots, or cap the collection (e.g. keep the last 500 entries: \`if (${leak.name}.length > 500) ${leak.name}.splice(0, ${leak.name}.length - 500);\`). Do not store copies of the whole product list per request.`,
        verify_steps: ['Run a load test for 5 minutes and confirm memory stays flat.', 'Deploy, then ask Liara Copilot to verify.'],
      });
    }
    await say('تا اصلاح کد، یک ری‌استارت حافظه را خالی می‌کند و سایت دوباره سریع می‌شود. این راه‌حل موقت است.');
    const res = await runToolByName('restart_app', { app, reason: 'خالی کردن رم تا اصلاح کد نشت حافظه' });
    if (res.status === 'rejected_by_user') return say('باشه، ری‌استارت نکردم. پیام اصلاح برای ایجنت کدنویس آماده است.');
    await new Promise((r) => setTimeout(r, 5000));
    return verify(session, app, { runToolByName, say });
  }

  if (top.id === 'bad_release' && top.fix.tool === 'rollback_release') return rollback(session, app, top.fix.args.releaseID, { runToolByName, say });
  if (top.id === 'app_stopped') {
    const res = await runToolByName('start_app', { app, reason: 'سرویس خاموش بود' });
    if (res.ok) return verify(session, app, { runToolByName, say });
    return null;
  }
  return say(`پیشنهاد: ${top.fix?.fa || 'بررسی دستی'}.`);
}

async function rollback(session, app, releaseID, { runToolByName, say }) {
  const res = await runToolByName('rollback_release', { app, releaseID, reason: 'خطاها بعد از آخرین ریلیز شروع شده‌اند' });
  if (res.status === 'rejected_by_user') return say('باشه، نسخه را عوض نکردم.');
  if (res.error || res.ok === false) return say(`برگشت انجام نشد: ${res.error || ''}`);
  await new Promise((r) => setTimeout(r, 6000));
  return verify(session, app, { runToolByName, say });
}

async function status(session, { runToolByName, say }) {
  const o = await runToolByName('get_account_overview', {});
  if (o.error) return say(`حساب لیارا خوانده نشد: ${o.error}`);
  const lines = [`موجودی حساب: **${toman(o.balanceToman)}**`, `تعداد سرویس‌ها: ${fa(o.apps.length)}`];
  for (const a of o.apps.filter((x) => x.managedByCopilot)) {
    const s = await runToolByName('get_app_status', { app: a.name });
    lines.push(`- **${a.name}**: ${s.status || a.status}، پلن ${a.planID}${s.now?.memoryMB !== undefined ? `، رم ${fa(s.now.memoryMB)} مگابایت` : ''}${s.releases?.[0] ? `، ریلیز ${s.releases[0].tag} (${s.releases[0].state})` : ''}${appInfo(a.name)?.watchPaths ? '' : ''}`);
  }
  return say(lines.join('\n'));
}
