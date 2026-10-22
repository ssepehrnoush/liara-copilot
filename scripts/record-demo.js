// Records the demo video from a real run: drives the copilot UI in Chrome, captures frames
// with the DevTools screencast, speeds up the waits, and writes Persian subtitles.
// The mouse pointer and the small terminal panel are overlays so viewers can follow along;
// every click, request and command behind them is real.
//
//   node scripts/record-demo.js --base http://localhost:4100 --shop https://ketabkadeh-app.liara.run --out _share/rec
//   then: node scripts/build-video.js _share/rec
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('--base', 'http://localhost:4100');
const SHOP = opt('--shop', 'https://ketabkadeh-app.liara.run');
const OUT = path.resolve(opt('--out', '_share/rec'));
const CHROME = opt('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
// 1 intro, 2 deploy, 3 new version, 4 HTTP 500, 5 memory leak, 6 execution paths, 7 standing rule,
// 8 prompt injection, 9 audit log and kill switch.
const ONLY = opt('--scenes', '1,2,3,4,5,6,7,8,9').split(',').map(Number);
const PAYMENT_KEY = 'sandbox_test_key_123';
const APP = new URL(SHOP).hostname.split('.')[0];
// Narration lines by id, and the voice clips made from them by scripts/voice-over.js.
const NARRATION = JSON.parse(fs.readFileSync(opt('--narration', 'scripts/demo-narration.json'), 'utf8'));
const VOICE = path.join(opt('--voice', '_share/voice-marin'), 'manifest.json');
const voice = fs.existsSync(VOICE) ? JSON.parse(fs.readFileSync(VOICE, 'utf8')) : {};
// Fixed pauses (reading a card, looking at the shop) are scaled by --pace; the voice sets the rest.
const PACE = Number(opt('--pace', '1'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- recorder
const rec = {
  frames: [],
  vt: 0,
  lastReal: Date.now(),
  speed: 1,
  cues: [],
  tick() {
    const now = Date.now();
    this.vt += (now - this.lastReal) / this.speed;
    this.lastReal = now;
    return this.vt;
  },
  setSpeed(s) {
    this.tick();
    this.speed = s;
  },
};

let cdp = null;
let n = 0;
async function attach(page) {
  if (cdp) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', async (f) => {
    const t = rec.tick();
    // Keep about 25 frames per second of final video; sped-up parts keep proportionally fewer.
    if (rec.frames.length && t - rec.frames.at(-1).t < 40) {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      return;
    }
    const file = `f${String(++n).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(OUT, 'frames', file), Buffer.from(f.data, 'base64'));
    rec.frames.push({ t, file });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 960, everyNthFrame: 1 });
}

// Subtitle cue: stays until the next one, and at least as long as its voice clip needs
// (or a fast reader, when there is no clip).
const minDur = (text) => (voice[text] ? voice[text].dur * 1000 + 350 : Math.max(2500, text.length * 45));
async function finishCue() {
  const prev = rec.cues.at(-1);
  if (!prev || prev.end !== null) return;
  const shown = rec.tick() - prev.start;
  if (shown < minDur(prev.text)) await hold((minDur(prev.text) - shown) / 1000, true);
  prev.end = rec.tick();
}
async function say(id, vars = {}) {
  const text = NARRATION[id].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  await finishCue();
  rec.cues.push({ start: rec.tick(), end: null, text, id });
  log('SAY', id, voice[text] ? `${voice[text].dur}s` : 'no voice clip');
}
async function hold(sec, exact = false) {
  const s = rec.speed;
  rec.setSpeed(1);
  await sleep((exact ? sec : sec * PACE) * 1000);
  rec.setSpeed(s);
}
async function fast(factor, fn) {
  const s = rec.speed;
  rec.setSpeed(factor);
  await overlaySpeed(factor);
  try { return await fn(); } finally { rec.setSpeed(s); await overlaySpeed(1); }
}

// ---------------------------------------------------------------- overlays
const OVERLAY = () => {
  if (window.__demo) return;
  window.__demo = true;
  const css = document.createElement('style');
  css.textContent = `
  #demo-cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:99999;pointer-events:none;transition:transform .55s cubic-bezier(.4,.1,.2,1);transform:translate(800px,450px)}
  #demo-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}
  .demo-ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid #1478ff;z-index:99998;pointer-events:none;animation:demoRip .55s ease-out forwards}
  @keyframes demoRip{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.6)}}
  #demo-term{position:fixed;left:18px;bottom:18px;width:560px;max-height:230px;z-index:99997;background:#0d1117;color:#c9d1d9;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px ui-monospace,Consolas,monospace;direction:ltr;text-align:left;overflow:hidden;display:none}
  #demo-term .bar{background:#161b22;color:#8b949e;padding:5px 10px;font-size:12px}
  #demo-term .body{padding:8px 12px;white-space:pre-wrap;max-height:190px;overflow:hidden}
  #demo-term .cmd{color:#7ee787}
  #demo-speed{position:fixed;top:70px;left:18px;z-index:99997;background:rgba(20,120,255,.92);color:#fff;font:600 15px Vazirmatn,Tahoma;padding:4px 12px;border-radius:999px;display:none}`;
  document.documentElement.appendChild(css);
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2l15 11-7 1.2L15.5 21l-3 1.4-3.3-6.8L4 20z" fill="#111" stroke="#fff" stroke-width="1.4"/></svg>';
  const t = document.createElement('div');
  t.id = 'demo-term';
  t.innerHTML = '<div class="bar">Terminal</div><div class="body"></div>';
  const sp = document.createElement('div');
  sp.id = 'demo-speed';
  const mount = () => { document.body.append(c, t, sp); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  window.__cursor = (x, y) => { c.style.transform = `translate(${x - 4}px,${y - 2}px)`; };
  window.__ripple = (x, y) => { const r = document.createElement('div'); r.className = 'demo-ripple'; r.style.left = `${x}px`; r.style.top = `${y}px`; document.body.appendChild(r); setTimeout(() => r.remove(), 700); };
  window.__term = {
    show(cmd) { t.style.display = 'block'; t.querySelector('.body').innerHTML = ''; this.add(`$ ${cmd}`, 'cmd'); },
    add(line, cls) { const b = t.querySelector('.body'); const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = line; b.appendChild(d); while (b.children.length > 11) b.firstChild.remove(); },
    hide() { t.style.display = 'none'; },
  };
  window.__speed = (f) => { if (f > 1) { sp.textContent = `⏩ ${f.toLocaleString('fa-IR')} برابر سرعت`; sp.style.display = 'block'; } else sp.style.display = 'none'; };
};

let page;
let shop;
async function overlaySpeed(f) {
  for (const p of [page, shop]) if (p) await p.evaluate((x) => window.__speed?.(x), f).catch(() => {});
}
async function moveTo(p, loc) {
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  const b = await loc.boundingBox();
  if (!b) return null;
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await p.evaluate(([a, c]) => window.__cursor(a, c), [x, y]);
  await sleep(650);
  return { x, y };
}
async function click(p, loc) {
  const pt = await moveTo(p, loc);
  if (pt) await p.evaluate(([a, c]) => window.__ripple(a, c), [pt.x, pt.y]);
  await loc.click();
  await sleep(300);
}
async function typeInto(p, loc, text) {
  await click(p, loc);
  await loc.pressSequentially(text, { delay: 28 });
}
const children = [];
async function term(p, cmd, argv, { untilLine, keep = false } = {}) {
  await p.evaluate((c) => window.__term.show(c), cmd);
  const child = spawn(process.execPath, argv, { cwd: process.cwd() });
  children.push(child);
  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/).filter(Boolean)) {
      p.evaluate((l) => window.__term.add(l), line).catch(() => {});
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  if (!keep) await new Promise((r) => child.on('exit', r));
  return child;
}

// ---------------------------------------------------------------- copilot helpers
const busy = () => page.evaluate(() => document.querySelector('#send')?.disabled);
async function send(text) {
  const box = page.locator('#input');
  await typeInto(page, box, text);
  await sleep(400);
  await click(page, page.locator('#send'));
}
async function waitTurnEnd(timeoutMs = 240000) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < timeoutMs) {
    if (!(await busy())) return true;
    await sleep(500);
  }
  return false;
}
// Answers every approval card of the current turn: reads it for a moment, fills the inputs, approves.
async function approveAll({ readSec = 4, inputs = {}, onCard, waitSpeed = 6 } = {}) {
  const seen = new Set();
  const t0 = Date.now();
  const base = rec.speed;
  await sleep(1000);
  while (Date.now() - t0 < 600000) {
    const cards = await page.locator('.card.approval').all();
    for (const c of cards) {
      const id = await c.evaluate((e) => e.dataset.demoId || (e.dataset.demoId = Math.random().toString(36).slice(2)));
      if (seen.has(id)) continue;
      seen.add(id);
      const resolved = await c.locator('.resolved:not(.hidden)').count();
      if (resolved) continue;
      rec.setSpeed(base);
      await overlaySpeed(1);
      await c.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      if (onCard) await onCard(c);
      await hold(readSec);
      for (const inp of await c.locator('.inputs label').all()) {
        const key = (await inp.locator('.k').innerText()).replace('*', '').trim();
        const field = inp.locator('input');
        if ((await field.inputValue()) === '' && inputs[key]) await typeInto(page, field, inputs[key]);
      }
      const box = c.locator('.confirmrow input');
      if (await box.count()) await click(page, box);
      await click(page, c.locator('button', { hasText: 'تأیید و اجرا' }));
      // Waiting for the work (build, restart, checks) is sped up until the next card or the end.
      rec.setSpeed(waitSpeed);
      await overlaySpeed(waitSpeed);
    }
    if (!(await busy())) break;
    await sleep(600);
  }
  rec.setSpeed(base);
  await overlaySpeed(1);
  return seen.size;
}
// Waits for one more element matching `selector` than there were when `before` was counted.
async function waitNew(selector, before, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await page.locator(selector).count()) > before) return true;
    await sleep(500);
  }
  throw new Error(`timeout waiting for new ${selector}`);
}
const count = (selector) => page.locator(selector).count();

async function show(selector, readSec = 4) {
  const el = page.locator(selector).last();
  await el.waitFor({ timeout: 120000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await hold(readSec);
}
async function openShop(pathname, readSec = 4) {
  await shop.goto(SHOP + pathname, { waitUntil: 'load' }).catch(() => {});
  await shop.evaluate(OVERLAY).catch(() => {});
  await shop.bringToFront();
  await attach(shop);
  await hold(readSec);
}
async function backToCopilot() {
  await page.bringToFront();
  await attach(page);
}
// Opens a page of the copilot itself (the execution paths page, or back to the chat) in the
// recorded tab, with the overlays put back.
async function goCopilot(pathname, readSec = 2) {
  await page.goto(BASE + pathname, { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(OVERLAY);
  await page.evaluate(() => document.fonts.ready);
  await attach(page);
  await hold(readSec);
}
async function scrollTo(selector, readSec) {
  await page.locator(selector).first().evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await sleep(700);
  if (readSec) await hold(readSec);
}

// ---------------------------------------------------------------- scenes
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1.2, locale: 'fa-IR' });
page = await context.newPage();
await page.goto(BASE, { waitUntil: 'load' });
await sleep(2500);
await page.evaluate(OVERLAY);
await page.evaluate(() => document.fonts.ready);
shop = await context.newPage();
await page.bringToFront();
await attach(page);
await sleep(1500);

try {
  if (ONLY.includes(1)) {
    await say('intro');
    await moveTo(page, page.locator('#modeChip'));
    await hold(4);
    await say('header');
    await moveTo(page, page.locator('.rules'));
    await hold(5);
  }

  if (ONLY.includes(2)) {
    await say('ask-deploy');
    await click(page, page.locator('#suggestions button').first());
    await hold(1);
    await click(page, page.locator('#send'));
    await page.locator('.card').filter({ hasText: 'نتیجهٔ تحلیل پروژه' }).waitFor({ timeout: 120000 });
    await say('analysis');
    await show('.card:has-text("نتیجهٔ تحلیل پروژه")', 5);
    await say('create-card');
    await approveAll({ readSec: 6, inputs: { SHOP_NAME: 'کتاب‌کده' }, onCard: async () => {} });
    await fast(6, async () => {
      await say('building');
      await page.locator('.card').filter({ hasText: 'سایت زنده است' }).waitFor({ timeout: 300000 });
      await waitTurnEnd();
    });
    await say('live');
    await show('.card:has-text("سایت زنده است")', 4);
    await openShop('/', 4);
    await backToCopilot();
  }

  if (ONLY.includes(3)) {
    await say('v2');
    await click(page, page.locator('#suggestions button').nth(1));
    await hold(1);
    await click(page, page.locator('#send'));
    await approveAll({ readSec: 4 });
    await fast(8, () => waitTurnEnd());
    // The release row keeps its steps open: point at the wait for Liara's version switch.
    const sw = page.locator('.act .steps li', { hasText: 'جابه‌جایی نسخه' }).last();
    if (await sw.count()) {
      await say('switch');
      await moveTo(page, sw);
      await hold(3);
    }
    await hold(1);
  }

  if (ONLY.includes(4)) {
    await say('broken');
    await openShop('/checkout', 3);
    await openShop('/checkout', 1);
    await backToCopilot();
    await fast(8, async () => {
      await say('watching');
      await page.locator('#alertBox.down').waitFor({ timeout: 240000 });
    });
    await moveTo(page, page.locator('#alertBox'));
    await hold(3);
    await say('alert-500');
    const diag4 = await count('.card:has-text("عیب‌یابی")');
    const verify4 = await count('.card:has-text("بررسی نتیجه")');
    await click(page, page.locator('#alertBox button', { hasText: 'بررسی کن' }));
    await waitNew('.card:has-text("عیب‌یابی")', diag4);
    const pct = (await page.locator('.card:has-text("عیب‌یابی")').last().locator('.conf').first().innerText()).replace('٪', '').trim();
    await say('cause-500', { pct });
    await show('.card:has-text("عیب‌یابی")', 6);
    await say('fix-500');
    await approveAll({ readSec: 5, inputs: { PAYMENT_API_KEY: PAYMENT_KEY } });
    await fast(4, () => waitTurnEnd());
    await waitNew('.card:has-text("بررسی نتیجه")', verify4, 60000).catch(() => {});
    await say('verified-500');
    await show('.card:has-text("بررسی نتیجه")', 5);
    await openShop('/checkout', 4);
    await backToCopilot();
  }

  if (ONLY.includes(5)) {
    await say('load');
    // Four visitors a second: the small plan has half a CPU core, more would hide the leak behind CPU.
    const load = await term(page, `node demo/loadgen.js ${SHOP} 4 15`, ['demo/loadgen.js', SHOP, '4', '15'], { keep: true });
    await hold(5);
    await fast(20, async () => {
      await say('load-growing');
      await page.locator('#alertBox.degraded, #alertBox.down').waitFor({ timeout: 900000 });
    });
    const down = await page.locator('#alertBox.down').count();
    await say(down ? 'alert-down' : 'alert-slow');
    await moveTo(page, page.locator('#alertBox'));
    await hold(2);
    const diag5 = await count('.card:has-text("عیب‌یابی")');
    const verify5 = await count('.card:has-text("بررسی نتیجه")');
    await click(page, page.locator('#alertBox button', { hasText: 'بررسی کن' }));
    await fast(2, () => waitNew('.card:has-text("عیب‌یابی")', diag5));
    // The visitors stop here so the check after the fix measures the fix, not new load.
    load.kill();
    await page.evaluate(() => window.__term.hide());
    await say('cause-leak');
    await show('.card:has-text("عیب‌یابی")', 5);
    const showDiff = async (c) => {
      await say('code-card');
      const d = c.locator('.diff');
      if (await d.count()) await d.first().evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    };
    let approved = await approveAll({ readSec: 6, onCard: showDiff });
    await fast(6, () => waitTurnEnd());
    if (!approved) {
      // The agent stopped at a recommendation: the user asks for the code fix in plain words.
      await send('اصلاح کد رو انجام بده.');
      approved = await approveAll({ readSec: 6, onCard: showDiff });
      await fast(6, () => waitTurnEnd());
    }
    if ((await count('.card:has-text("بررسی نتیجه")')) > verify5) {
      await say('verified-leak');
      await show('.card:has-text("بررسی نتیجه")', 5);
    }
  }

  if (ONLY.includes(6)) {
    await say('cost');
    await moveTo(page, page.locator('#costChip'));
    await hold(3);
    await say('paths-intro');
    await click(page, page.locator('a.chip.link'));
    await goCopilot('/paths.html', 3);
    await say('paths-table');
    await scrollTo('#resultsTable', 3);
    await scrollTo('#costChart', 3);
    await say('paths-calc');
    await scrollTo('#lineChart', 1);
    await moveTo(page, page.locator('#users'));
    // Slide the user count up so the self-hosted line crosses the current model.
    for (const v of [2000, 4000, 6000, 8000, 10000, 15000, 20000]) {
      await page.locator('#users').evaluate((e, x) => { e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
      await sleep(450);
    }
    await hold(2);
    await say('paths-host');
    await scrollTo('#hostTable', 4);
    await say('paths-rejected');
    await scrollTo('#rejected', 4);
    await goCopilot('/', 2);
  }

  if (ONLY.includes(7)) {
    await say('rule-ask');
    await click(page, page.locator('#suggestions button', { hasText: 'قانون خودکار' }));
    await hold(1);
    await click(page, page.locator('#send'));
    await approveAll({ readSec: 4, onCard: async () => { await say('rule-card'); } });
    await fast(4, () => waitTurnEnd());
    const panel = page.locator('.auto-rules');
    await panel.waitFor({ timeout: 30000 }).catch(() => {});
    if (await panel.count()) {
      await moveTo(page, panel);
      await hold(3);
    }
  }

  if (ONLY.includes(8)) {
    await say('injection');
    const reviews = async () => {
      const r = await page.evaluate(async (app) => (await fetch(`/api/apps/${app}/logs`)).json(), APP).catch(() => ({}));
      return (r.lines || []).filter((l) => /new review for book/.test(l.line)).length;
    };
    const before = await reviews();
    await term(page, `node demo/send-review.js ${SHOP}`, ['demo/send-review.js', SHOP]);
    await hold(3);
    await page.evaluate(() => window.__term.hide());
    // Liara's log pipeline lags a few seconds; ask only once the new line is really there.
    await fast(6, async () => {
      for (let i = 0; i < 60 && (await reviews()) <= before; i++) await sleep(2000);
    });
    await send('لاگ‌های اخیر سایت رو بخون ببین چه خبره.');
    await page.locator('.card.security').waitFor({ timeout: 120000 });
    await say('injection-caught');
    await show('.card.security', 6);
    await waitTurnEnd();
    await hold(2);
  }

  if (ONLY.includes(9)) {
    await say('audit');
    await click(page, page.locator('.tab', { hasText: 'گزارش اقدامات' }));
    await hold(5);
    await say('kill');
    await moveTo(page, page.locator('#killBtn'));
    await hold(5);
  }
} catch (e) {
  log('ERROR', e.message);
  for (const c of children) c.kill();
  fs.writeFileSync(path.join(OUT, 'error.txt'), String(e.stack));
} finally {
  await finishCue().catch(() => {});
  const end = rec.tick();
  await cdp?.send('Page.stopScreencast').catch(() => {});
  fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ frames: rec.frames, cues: rec.cues, end }, null, 1));
  log('frames', rec.frames.length, 'virtual seconds', Math.round(end / 1000));
  await browser.close();
}
