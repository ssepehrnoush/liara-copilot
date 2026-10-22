// Runs the standing rules the user approved, from the health watcher's checks. Every run goes to
// the audit log and is shown in every open conversation, with what triggered it and the
// measured result. The kill switch and the app scope apply exactly as for approved actions.
import { dueRules, markFired, setRunning, describeRule } from './rules.js';
import { toolByName } from './tools/index.js';
import { collectEvidence } from './diagnose.js';
import { httpCheck } from './probe.js';
import { audit } from './audit.js';
import { killSwitch } from './safety.js';
import { canModify, appInfo } from './scope.js';

const MB = 1024 * 1024;
const fa = (n) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: 1 });
const pagesOf = (app) => (appInfo(app)?.watchPaths || ['/']).slice(0, 4);

export function makeRuleRunner(liara, broadcast) {
  return async (app, snap) => {
    for (const due of dueRules(app, snap)) {
      const { rule, readingFa } = due;
      const base = { ruleId: rule.id, app, action: rule.action, ruleFa: describeRule(rule), readingFa, firedThisHour: due.firedThisHour, maxPerHour: rule.maxPerHour };
      if (due.limitReached) {
        audit({ actor: 'rule', kind: 'rule_skipped', tool: 'rules', risk: 'auto', app, summary: `قانون خودکار اجرا نشد: سقف ${fa(rule.maxPerHour)} بار در ساعت پر شده (${readingFa})`, status: 'blocked' });
        broadcast('rule', { ...base, status: 'limit', resultFa: 'سقف این ساعت پر شده و کاری انجام نشد. اگر مشکل ادامه دارد، «بررسی کن» بزنید.' });
        continue;
      }
      const blocked = rule.action === 'restart' && (killSwitch().on ? 'توقف اضطراری روشن است؛ قانون اجرا نشد.' : !canModify(app) ? 'این اپ در محدودهٔ مدیریت کوپایلت نیست.' : null);
      markFired(rule);
      if (blocked) {
        audit({ actor: 'rule', kind: 'refused', tool: 'restart_app', risk: 'medium', app, summary: `قانون خودکار: ${blocked}`, status: 'blocked' });
        broadcast('rule', { ...base, status: 'refused', resultFa: blocked });
        continue;
      }
      setRunning(rule, true);
      broadcast('rule', { ...base, status: 'running', resultFa: rule.action === 'restart' ? 'در حال ری‌استارت…' : 'در حال انجام…' });
      try {
        let resultFa = 'خبر داده شد؛ کار دیگری انجام نشد.';
        let data = null;
        if (rule.action === 'investigate') {
          const ev = await collectEvidence(liara, app, { paths: pagesOf(app), lastFixAt: appInfo(app)?.lastFixAt || null });
          const top = ev.hypotheses.slice(0, 3);
          data = { hypotheses: top.map((x) => ({ title: x.title, confidence: x.confidence, evidence: x.evidence[0] || '', fixFa: x.fix?.fa || '' })) };
          resultFa = top.length ? `علت محتمل: ${top[0].title} (${fa(top[0].confidence)}٪). برای اصلاح، «بررسی کن» بزنید.` : 'علت مشخصی پیدا نشد.';
        } else if (rule.action === 'restart') {
          await toolByName.restart_app.run({ app, reason: `قانون خودکار: ${readingFa}` }, { liara, step: () => {}, session: {} });
          const p = await httpCheck(liara.appUrl(app), { paths: pagesOf(app), samples: 2 });
          let memMB = null;
          try { memMB = Math.round(((await liara.metricsSummary(app)).memoryBytes || 0) / MB); } catch { /* metrics may lag */ }
          data = { probe: { ok: p.ok, total: p.total, p50ms: p.p50ms }, memMB };
          resultFa = `ری‌استارت انجام شد؛ بعد از آن ${fa(p.ok)} از ${fa(p.total)} درخواست موفق${memMB ? ` و رم ${fa(memMB)} مگابایت` : ''}. ری‌استارت راه موقت است؛ برای علت اصلی «بررسی کن» بزنید.`;
        }
        audit({ actor: 'rule', kind: 'rule_fired', tool: rule.action === 'restart' ? 'restart_app' : rule.action, risk: rule.action === 'restart' ? 'medium' : 'auto', app, summary: `قانون خودکار، ${readingFa}: ${resultFa}`, status: 'ok' });
        broadcast('rule', { ...base, status: 'done', resultFa, data });
      } catch (e) {
        const msg = e.fa || e.message;
        audit({ actor: 'rule', kind: 'rule_fired', tool: rule.action, risk: 'auto', app, summary: `قانون خودکار اجرا شد ولی خطا داد: ${msg}`, status: 'error' });
        broadcast('rule', { ...base, status: 'error', resultFa: `خطا: ${msg}` });
      } finally {
        setRunning(rule, false);
      }
    }
  };
}
