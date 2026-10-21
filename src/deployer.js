// Deploy pipeline used by both the real API and the simulator:
// archive (respecting .gitignore) -> upload source -> create release -> follow build -> health.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { listFiles, makeIgnore } from './analyzer.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createArchive(dir) {
  const files = listFiles(dir, makeIgnore(dir));
  const out = path.join(os.tmpdir(), `liara-copilot-src-${Date.now()}.tar.gz`);
  await tar.c({ gzip: true, cwd: dir, file: out, portable: true }, files);
  return { file: out, files: files.length, bytes: fs.statSync(out).size };
}

/**
 * Runs a full release and reports progress through onStep({ step, status, detail }).
 * Returns { releaseID, state, buildTail, failReason }.
 */
export async function deployRelease(liara, { app, dir, port, platform, message, envs }, onStep = () => {}) {
  onStep({ step: 'archive', status: 'running', detail: 'فشرده‌سازی سورس (بدون node_modules و .env)' });
  const arc = await createArchive(dir);
  onStep({ step: 'archive', status: 'done', detail: `${arc.files} فایل، ${(arc.bytes / 1024).toFixed(0)} کیلوبایت` });

  onStep({ step: 'upload', status: 'running', detail: 'آپلود سورس روی لیارا' });
  let sourceID;
  try {
    sourceID = await liara.uploadSource(app, arc.file);
  } finally {
    fs.rmSync(arc.file, { force: true });
  }
  onStep({ step: 'upload', status: 'done', detail: `شناسهٔ سورس: ${String(sourceID).slice(0, 10)}` });

  const body = { sourceID, port, type: platform, message: message || 'Deployed by Liara Copilot' };
  if (envs?.length) body.envs = envs;
  onStep({ step: 'release', status: 'running', detail: 'ساخت ریلیز جدید' });
  const releaseID = await liara.createRelease(app, body);
  onStep({ step: 'release', status: 'done', detail: `ریلیز ${String(releaseID).slice(0, 10)}` });

  onStep({ step: 'build', status: 'running', detail: 'در صف بیلد' });
  const tail = [];
  let since;
  let lastState = '';
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    let release = {};
    let lines = [];
    try {
      ({ release, lines } = await liara.buildLogs(releaseID, since));
    } catch {
      try { release = await liara.getRelease(releaseID); } catch { /* keep polling */ }
    }
    for (const l of lines) {
      const text = String(l.line || '').trimEnd();
      if (text) tail.push(l.stream && l.stream !== 'STDOUT' ? `[stderr] ${text}` : text);
      since = l.createdAt || since;
    }
    if (tail.length > 60) tail.splice(0, tail.length - 60);
    const state = release.state || lastState;
    if (state && state !== lastState) {
      lastState = state;
      const fa = { QUEUED: 'در صف بیلد', PENDING: 'در صف بیلد', BUILDING: 'در حال بیلد', PUSHING: 'ذخیرهٔ ایمیج', DEPLOYING: 'بالا آمدن کانتینر و بررسی سلامت', READY: 'آماده', FAILED: 'ناموفق', UNHEALTHY: 'کانتینر سالم بالا نیامد', CANCELED: 'لغو شد', TIMEDOUT: 'زمان بیلد تمام شد' }[state] || state;
      onStep({ step: 'build', status: 'running', detail: fa, state });
    }
    if (lines.length) onStep({ step: 'build', status: 'log', lines: lines.map((l) => String(l.line || '').trimEnd()).filter(Boolean).slice(-8) });
    if (['READY', 'FAILED', 'UNHEALTHY', 'CANCELED', 'TIMEDOUT'].includes(state)) {
      const ok = state === 'READY';
      onStep({ step: 'build', status: ok ? 'done' : 'failed', detail: ok ? 'بیلد و استقرار موفق' : `وضعیت نهایی: ${state}`, state });
      return { releaseID, state, buildTail: tail.slice(-25), failReason: release.failReason || null };
    }
    await sleep(release.queue ? 3000 : 2000);
  }
  onStep({ step: 'build', status: 'failed', detail: 'بیش از ۱۵ دقیقه طول کشید' });
  return { releaseID, state: 'TIMEDOUT', buildTail: tail.slice(-25), failReason: 'copilot timeout' };
}
