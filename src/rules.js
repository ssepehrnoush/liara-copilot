// Standing rules: the user approves "when X happens, do Y" once, through an approval card, and
// the health watcher then does Y on its own within the rule's hourly limit. Only low-impact
// actions qualify (tell, investigate, restart). Anything that costs money or changes code
// (plan change, rollback, code fix) still needs its own approval card every time.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

let FILE = path.join(config.dataDir, 'rules.json');
const HOUR = 3600 * 1000;
const fa = (n) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: 1 });

export const TRIGGERS = {
  ram_above: { fa: (v) => `رم از ${fa(v)}٪ سقف پلن بگذرد`, min: 50, max: 98 },
  down: { fa: () => 'سایت از دسترس خارج شود یا مدام خطای سرور بدهد', min: null, max: null },
  errors_above: { fa: (v) => `بیش از ${fa(v)}٪ درخواست‌های تست خطا بگیرند`, min: 5, max: 100 },
  every_hours: { fa: (v) => `هر ${fa(v)} ساعت یک بار`, min: 1, max: 24 },
};
export const ACTIONS = {
  notify: 'فقط خبر بده',
  investigate: 'عیب‌یابی کن و نتیجه را بگو',
  restart: 'سرویس را ری‌استارت کن و نتیجه را بسنج',
};

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
let rules = load();
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rules.map(({ running, ...r }) => r), null, 2));
}

// Tests point the rules at a throwaway file so they never touch real state.
export function useRulesFile(file) {
  FILE = file;
  rules = load();
}

// Throws a Persian message when the rule is not one the copilot may run on its own.
export function checkRule({ trigger, action, maxPerHour = 1 }) {
  const t = TRIGGERS[trigger?.type];
  if (!t) throw new Error(`شرط «${trigger?.type}» پشتیبانی نمی‌شود. شرط‌های مجاز: رم بالا، از دسترس خارج شدن، درصد خطا، و «هر چند ساعت».`);
  if (t.min !== null && !(trigger.value >= t.min && trigger.value <= t.max)) throw new Error(`مقدار شرط باید بین ${fa(t.min)} و ${fa(t.max)} باشد.`);
  if (!ACTIONS[action]) throw new Error('این کار را نمی‌شود خودکار کرد. فقط «خبر بده»، «عیب‌یابی کن» و «ری‌استارت» خودکار می‌شوند؛ تغییر پلن، برگشت به نسخهٔ قبلی و اصلاح کد هر بار کارت تأیید جدا می‌خواهند.');
  if (!(maxPerHour >= 1 && maxPerHour <= 4)) throw new Error('سقف اجرا باید بین ۱ تا ۴ بار در ساعت باشد.');
  if (trigger.type === 'every_hours' && action === 'restart') throw new Error('ری‌استارتِ زمان‌بندی‌شده بدون مشکل لازم نیست؛ ری‌استارت فقط با شرطِ رم، خطا یا از دسترس خارج شدن خودکار می‌شود.');
}

export function describeRule(r) {
  const limit = r.trigger.type === 'every_hours' ? '' : `، حداکثر ${fa(r.maxPerHour)} بار در ساعت`;
  return `روی ${r.app}: اگر ${TRIGGERS[r.trigger.type].fa(r.trigger.value)}، ${ACTIONS[r.action]}${limit}`;
}

export function addRule({ app, trigger, action, maxPerHour = 1 }) {
  checkRule({ trigger, action, maxPerHour });
  const rule = { id: randomUUID().slice(0, 8), app, trigger: { type: trigger.type, value: trigger.value ?? null }, action, maxPerHour, active: true, createdAt: Date.now(), fired: [] };
  rules.push(rule);
  save();
  return rule;
}

export function listRules({ app, active = true } = {}) {
  return rules.filter((r) => (!app || r.app === app) && (!active || r.active)).map((r) => ({ ...r, fa: describeRule(r), firedLastHour: r.fired.filter((t) => Date.now() - t < HOUR).length }));
}

export function disableRule(id) {
  const r = rules.find((x) => x.id === id);
  if (!r) return null;
  r.active = false;
  r.disabledAt = Date.now();
  save();
  return r;
}

// What the watcher saw for one app on this tick -> rules to fire now. Within the hourly budget
// a condition rule fires again at once if the condition cleared in between (a leak refilling
// RAM after a restart), otherwise only after an even share of the hour. A rule whose budget
// is used up comes back once with limitReached, so the user hears that it held back.
export function dueRules(app, snap, now = Date.now()) {
  const out = [];
  for (const r of rules.filter((x) => x.active && x.app === app && !x.running)) {
    let hit = false;
    let readingFa = '';
    if (r.trigger.type === 'ram_above') {
      hit = snap.mem?.pct >= r.trigger.value;
      readingFa = `رم به ${fa(snap.mem?.pct)}٪ سقف پلن رسید`;
    } else if (r.trigger.type === 'down') {
      hit = snap.level === 'down';
      readingFa = snap.fa || 'سایت جواب نمی‌دهد';
    } else if (r.trigger.type === 'errors_above') {
      const p = snap.probes || [];
      const total = p.reduce((a, x) => a + x.total, 0);
      const pct = total ? Math.round(((total - p.reduce((a, x) => a + x.ok, 0)) / total) * 100) : 0;
      hit = p.length >= 2 && pct >= r.trigger.value;
      readingFa = `${fa(pct)}٪ درخواست‌های تست خطا گرفتند`;
    } else if (r.trigger.type === 'every_hours') {
      const last = r.fired.at(-1) || 0;
      hit = now - last >= r.trigger.value * HOUR;
      readingFa = 'زمان گزارش دوره‌ای رسید';
    }
    if (!hit) {
      r.armed = true;
      continue;
    }
    const inHour = r.fired.filter((t) => now - t < HOUR).length;
    if (r.trigger.type !== 'every_hours') {
      if (inHour >= r.maxPerHour) {
        if (!r.limitNotifiedAt || now - r.limitNotifiedAt > HOUR) {
          r.limitNotifiedAt = now;
          out.push({ rule: r, readingFa, limitReached: true, firedThisHour: inHour });
        }
        continue;
      }
      if (r.armed === false && now - (r.fired.at(-1) || 0) < HOUR / r.maxPerHour) continue;
    }
    out.push({ rule: r, readingFa, firedThisHour: inHour + 1 });
  }
  return out;
}

export function markFired(rule, now = Date.now()) {
  rule.fired = [...rule.fired.filter((t) => now - t < 24 * HOUR), now];
  rule.armed = false;
  save();
}

export function setRunning(rule, on) {
  rule.running = on;
}
