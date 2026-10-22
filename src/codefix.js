// Code fixes the user approves: small exact edits to the project's own source files.
// Each edit replaces one snippet that must appear exactly once, so the model cannot rewrite
// whole files. Originals are backed up first, JavaScript is syntax-checked after the edit,
// and any failure puts the original files back.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeIgnore, SOURCE_EXT } from './analyzer.js';

export const LIMITS = { files: 3, edits: 6, changedLines: 80 };
const JS_EXT = /\.(m?js|cjs)$/i;

// A model fooled by a log line could try to plant code that phones home, runs commands,
// reads secrets or deletes files. An edit may keep such code but never add more of it.
const RISKY = [
  /\bfetch\s*\(/g, /\bhttps?\.(?:request|get)\s*\(/g, /XMLHttpRequest|WebSocket|\bnet\.connect/g,
  /child_process|\b(?:exec|execSync|execFile|spawn|spawnSync|fork)\s*\(/g, /\beval\s*\(|new\s+Function\s*\(/g,
  /process\.env/g, /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/g,
  /\bimport\s*\(|require\s*\(\s*['"](?:node:)?(?:net|dgram|tls|http|https|child_process)['"]|from\s+['"](?:node:)?(?:net|dgram|tls|http|https|child_process)['"]/g,
];
const count = (re, s) => (s.match(re) || []).length;

const lines = (s) => (s === '' ? 0 : s.split('\n').length);

function fail(msg) {
  const e = new Error(msg);
  e.codefix = true;
  return e;
}

// A project-relative path that stays inside the folder and is not ignored (.env, node_modules...).
export function safeRel(dir, file) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, String(file || '').replace(/^[\\/]+/, ''));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw fail(`مسیر «${file}» بیرون از پوشهٔ پروژه است.`);
  const posix = rel.split(path.sep).join('/');
  if (makeIgnore(root).ignores(posix)) throw fail(`فایل «${posix}» جزو فایل‌های نادیده‌گرفته‌شده (مثل .env) است و دست نمی‌خورد.`);
  if (!SOURCE_EXT.test(posix) || /\.env/i.test(posix)) throw fail(`«${posix}» فایل کد نیست؛ فقط فایل‌های کد اصلاح می‌شوند.`);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw fail(`فایل «${posix}» در پروژه نیست.`);
  return posix;
}

// Checks every edit against the files on disk and returns what will change, without writing.
export function planEdits(dir, edits) {
  if (!Array.isArray(edits) || !edits.length) throw fail('هیچ تغییری مشخص نشده.');
  if (edits.length > LIMITS.edits) throw fail(`حداکثر ${LIMITS.edits} تکه تغییر در یک اصلاح مجاز است؛ اصلاح را کوچک‌تر کنید.`);
  const files = new Map();
  const diff = [];
  let changed = 0;
  for (const e of edits) {
    const rel = safeRel(dir, e.file);
    if (!files.has(rel)) {
      const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
      files.set(rel, { eol: raw.includes('\r\n') ? '\r\n' : '\n', text: raw.replace(/\r\n/g, '\n') });
    }
    const f = files.get(rel);
    const find = String(e.find || '').replace(/\r\n/g, '\n');
    const replace = String(e.replace ?? '').replace(/\r\n/g, '\n');
    if (!find.trim()) throw fail(`متن قبلی برای ${rel} خالی است.`);
    if (find === replace) throw fail(`تغییر ${rel} هیچ فرقی با کد فعلی ندارد.`);
    if (RISKY.some((re) => count(re, replace) > count(re, find))) {
      throw fail(`این اصلاح در ${rel} کدی اضافه می‌کند که به بیرون وصل می‌شود، دستور اجرا می‌کند، متغیر محیطی می‌خواند یا فایل پاک می‌کند. اصلاح خودکار فقط برای تغییر امن است؛ این یکی را به ایجنت کدنویس بسپارید.`);
    }
    const at = f.text.indexOf(find);
    if (at < 0) throw fail(`متن قبلی دقیقاً در ${rel} پیدا نشد؛ اول فایل را بخوانید و متن را عیناً کپی کنید.`);
    if (f.text.indexOf(find, at + 1) >= 0) throw fail(`متن قبلی بیش از یک بار در ${rel} آمده؛ چند خط اطرافش را هم بیاورید تا یکتا شود.`);
    const line = f.text.slice(0, at).split('\n').length;
    f.text = f.text.slice(0, at) + replace + f.text.slice(at + find.length);
    changed += Math.max(lines(find), lines(replace));
    diff.push({ file: rel, line, before: find.split('\n'), after: replace === '' ? [] : replace.split('\n') });
  }
  if (files.size > LIMITS.files) throw fail(`حداکثر ${LIMITS.files} فایل در یک اصلاح مجاز است.`);
  if (changed > LIMITS.changedLines) throw fail(`این اصلاح ${changed} خط را عوض می‌کند؛ سقف ${LIMITS.changedLines} خط است. برای تغییر بزرگ از ایجنت کدنویس کمک بگیرید.`);
  return { files: [...files.keys()], diff, changedLines: changed, next: files };
}

// Writes the planned files after copying the originals into backupDir.
export function applyPlan(dir, plan, backupDir) {
  for (const rel of plan.files) {
    const dest = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), dest);
  }
  for (const [rel, f] of plan.next) fs.writeFileSync(path.join(dir, rel), f.eol === '\n' ? f.text : f.text.replace(/\n/g, f.eol));
}

export function restore(dir, files, backupDir) {
  for (const rel of files) fs.copyFileSync(path.join(backupDir, rel), path.join(dir, rel));
}

// node --check on edited JavaScript files; null when everything parses.
export function syntaxError(dir, files) {
  for (const rel of files.filter((f) => JS_EXT.test(f))) {
    const r = spawnSync(process.execPath, ['--check', path.join(dir, rel)], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) return { file: rel, message: (r.stderr || '').split('\n').filter((l) => /Error|^\s*\^/.test(l) || /:\d+$/.test(l)).slice(0, 4).join('\n') || 'syntax error' };
  }
  return null;
}

// The same check on the planned text before anything is written, so the approval card never
// offers an edit that does not even parse. The probe file sits next to the original to keep
// its module type (the nearest package.json "type").
export function plannedSyntaxError(dir, plan) {
  for (const rel of plan.files.filter((f) => JS_EXT.test(f))) {
    const probe = path.join(path.dirname(rel), `.lc-check-${process.pid}-${path.basename(rel)}`);
    fs.writeFileSync(path.join(dir, probe), plan.next.get(rel).text);
    try {
      const bad = syntaxError(dir, [probe]);
      if (bad) return { file: rel, message: bad.message };
    } finally {
      fs.rmSync(path.join(dir, probe), { force: true });
    }
  }
  return null;
}
