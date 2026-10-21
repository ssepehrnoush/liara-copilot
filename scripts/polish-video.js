// Final edit of the demo video: animated intro, chapter and outro cards (art made with
// OpenArt, Persian text and motion rendered here), one-sentence subtitles, a chapter badge,
// and soft fades between parts.
//   node scripts/polish-video.js --rec _share/rec-final --art _share/art --narration _share/defense/narration-timed.json --out _share/video
// With --voice DIR (clips from scripts/voice-over.js), the subtitles come from the recording's
// own cues, silent stretches are squeezed, and the voice clips become the soundtrack.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REC = path.resolve(opt('--rec', '_share/rec-final'));
const ART = path.resolve(opt('--art', '_share/art'));
const NAR = path.resolve(opt('--narration', '_share/defense/narration-timed.json'));
const VOICE = opt('--voice', '') && path.resolve(opt('--voice'));
// Current narration by line id: a line edited after the recording is spoken and subtitled
// as edited. Cards speak the "card-<id>" lines.
const lines = VOICE && fs.existsSync(opt('--lines', 'scripts/demo-narration.json')) ? JSON.parse(fs.readFileSync(opt('--lines', 'scripts/demo-narration.json'), 'utf8')) : {};
const clips = VOICE ? JSON.parse(fs.readFileSync(path.join(VOICE, 'manifest.json'), 'utf8')) : {};
const OUT = path.resolve(opt('--out', '_share/video'));
const WORK = path.join(OUT, 'work');
const CHROME = opt('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const FONT = pathToFileURL(path.resolve('node_modules/vazirmatn/fonts/ttf')).href;
const FPS = 30;
fs.mkdirSync(WORK, { recursive: true });

const fa = (x) => String(x).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
const ff = (argv, label) => {
  let r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { cwd: WORK, stdio: 'inherit' });
  // x264 can fail to allocate when the machine is short of memory: retry once with fewer threads.
  if (r.status !== 0) r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv.slice(0, -1), '-threads', '2', argv.at(-1)], { cwd: WORK, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${label}`);
};
const ENC = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p'];

// ---------------------------------------------------------------- chapters (main-video seconds)
const timeline = JSON.parse(fs.readFileSync(path.join(REC, 'timeline.json'), 'utf8'));
const t0 = timeline.frames[0].t;
let totalMain = (timeline.end - t0) / 1000;
let narration;
let framesList = path.join(REC, 'frames.txt');
let chapterAt;
if (!VOICE) {
  narration = JSON.parse(fs.readFileSync(NAR, 'utf8'));
  chapterAt = [3, 8, 14, 16, 22].map((i) => narration[i - 1].start); // 1-based shot index
} else {
  // Voice mode: keep each cue at real speed while its clip plays and squeeze the silent rest
  // of the cue (to a third, at least 1.2 s), so nothing on screen waits without a reason.
  const cues = timeline.cues.map((c) => {
    const text = lines[c.id] && !lines[c.id].includes('{') ? lines[c.id] : c.text;
    return { id: c.id, text, start: (c.start - t0) / 1000, end: (c.end - t0) / 1000, clip: clips[text] };
  });
  const knots = [[0, 0]];
  const squeeze = (b) => {
    const [a, A] = knots.at(-1);
    const len = b - a;
    knots.push([b, A + (len <= 1.2 ? len : Math.max(1.2, len / 3))]);
  };
  const keep = (b) => { const [a, A] = knots.at(-1); knots.push([b, A + (b - a)]); };
  const stretch = (b, len) => { const [, A] = knots.at(-1); knots.push([b, A + len]); };
  squeeze(cues[0].start);
  for (const c of cues) {
    const need = c.clip ? c.clip.dur + 0.45 : c.end - c.start;
    // A clip longer than its scene plays over the scene slowed a little, never over the next line.
    if (c.end - c.start <= need) stretch(c.end, need);
    else { keep(c.start + need); squeeze(c.end); }
  }
  squeeze(totalMain);
  const warp = (t) => {
    for (let i = 1; i < knots.length; i++) {
      const [a, A] = knots[i - 1];
      const [b, B] = knots[i];
      if (t <= b) return b === a ? A : A + ((t - a) / (b - a)) * (B - A);
    }
    return knots.at(-1)[1];
  };
  const list = [];
  timeline.frames.forEach((f, i) => {
    const a = (f.t - t0) / 1000;
    const b = ((timeline.frames[i + 1]?.t ?? timeline.end) - t0) / 1000;
    list.push(`file '${f.path || `frames/${f.file}`}'`, `duration ${Math.max(0.001, warp(b) - warp(a)).toFixed(4)}`);
  });
  framesList = path.join(REC, 'frames-voice.txt');
  fs.writeFileSync(framesList, list.join('\n'));
  const before = totalMain;
  totalMain = warp(totalMain);
  narration = cues.map((c) => ({ id: c.id, screen: '', say: c.text, start: warp(c.start), dur: warp(c.end) - warp(c.start), voice: c.clip && { file: path.join(VOICE, c.clip.file), dur: c.clip.dur } }));
  const at = (id) => narration.find((n) => n.id === id)?.start;
  chapterAt = ['ask-deploy', 'v2', 'injection', 'load', 'audit'].map(at);
  console.log(`voice mode: ${cues.length} cues, main video ${Math.round(before)} s -> ${Math.round(totalMain)} s`);
}
const CHAPTERS = [
  { n: 1, title: 'دیپلوی از صفر', sub: 'از معرفی پروژه تا سایت آماده روی لیارا', icon: 'ch1-deploy.png' },
  { n: 2, title: 'خطای ۵۰۰ و رفعش', sub: 'پیدا کردن علت از روی لاگ و رفعش با تأیید کاربر', icon: 'ch2-error.png' },
  { n: 3, title: 'حملهٔ تزریق دستور', sub: 'وقتی کسی از طریق لاگ می‌خواهد به هوش مصنوعی دستور بدهد', icon: 'ch3-shield.png' },
  { n: 4, title: 'کندی و نشت حافظه', sub: 'از هشدار کندی تا پیدا کردن مشکل در کد', icon: 'ch4-memory.png' },
  { n: 5, title: 'گزارش و توقف اضطراری', sub: 'ثبت همهٔ کارها و دکمهٔ توقف', icon: 'ch5-audit.png' },
].map((c, i) => ({ ...c, from: chapterAt[i] })).filter((c) => c.from !== undefined); // a scene that was not recorded has no chapter
const chapters = [
  { from: 0, to: CHAPTERS[0].from, badge: null },
  ...CHAPTERS.map((c, i) => ({ ...c, to: CHAPTERS[i + 1]?.from ?? totalMain })),
];
const CARD = { intro: 4.5, chapter: 2.6, outro: 5.5 };
// A card with a voice line stays up until the line is done; the voice starts after the fade-in.
const CARD_LEAD = 0.4;
const cardClip = (id) => clips[lines[`card-${id}`]];
const cardDur = (id, base) => (cardClip(id) ? Math.max(base, CARD_LEAD + cardClip(id).dur + 0.6) : base);

// ---------------------------------------------------------------- 1) subtitles: one sentence at a time
// Each sentence is one subtitle, so the text never changes mid-sentence. A long sentence is
// shown on two lines, broken at the comma (or else the space) nearest the middle.
function sentences(text) {
  return text.split(/(?<=[.!؟?])\s+/).filter(Boolean).map((p) => {
    if (p.length <= 78) return [p];
    const mid = p.length / 2;
    const near = (re) => [...p.matchAll(re)].map((m) => m.index + 1).filter((i) => i > 20 && i < p.length - 20)
      .sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
    const comma = near(/[،:؛]\s/g);
    const cut = comma && Math.abs(comma - mid) < p.length / 4 ? comma : near(/\s/g);
    return cut ? [p.slice(0, cut).trim(), p.slice(cut).trim()] : [p];
  });
}
const ts = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};
// libass lays a line out left-to-right by default, which moves the final "." or "؟" to the
// wrong end. A right-to-left embedding (RLE ... PDF) around every line fixes that.
const rtl = (text) => `‫${text}‬`;
const events = [];
for (const n of narration) {
  const parts = sentences(n.say);
  const len = (lines) => lines.join(' ').length;
  const total = parts.reduce((a, p) => a + len(p), 0);
  let t = n.start;
  // With a voice clip, sentences follow the clip; the last one stays up until the next cue.
  const spoken = n.voice ? Math.min(n.dur, n.voice.dur + 0.2) : n.dur;
  for (const [k, p] of parts.entries()) {
    const d = k === parts.length - 1 ? n.start + n.dur - t : (len(p) / total) * spoken;
    events.push(`Dialogue: 0,${ts(t)},${ts(t + d - 0.02)},Fa,,0,0,0,,${p.map(rtl).join('\\N')}`);
    t += d;
  }
}
for (const c of chapters) {
  if (!c.n) continue;
  events.push(`Dialogue: 1,${ts(c.from)},${ts(c.to)},Badge,,0,0,0,,${rtl(`قسمت ${fa(c.n)} از ${fa(5)}، ${c.title}`)}`);
}
const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 0', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Fa,Vazirmatn,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,2,140,140,38,1',
  'Style: Badge,Vazirmatn,24,&H00F5D84C,&H00F5D84C,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,9,40,40,976,1',
  '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...events,
].join('\n');
fs.writeFileSync(path.join(WORK, 'polish.ass'), ass);

// Main video with the new subtitles (frames come from the recording).
const frames = framesList.replace(/\\/g, '/');
const esc = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
const fontsdir = esc(path.resolve('node_modules/vazirmatn/fonts/ttf'));
const assP = esc(path.join(WORK, 'polish.ass'));
console.log('main video with sentence subtitles');
const frameF = 'scale=1920:960:flags=lanczos,pad=1920:1080:0:0:color=0x0d1117';
spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', frames, '-vf', `${frameF},ass='${assP}':fontsdir='${fontsdir}'`, ...ENC, path.join(WORK, 'main-sub.mp4')], { cwd: REC, stdio: 'inherit' });

// ---------------------------------------------------------------- 2) cards rendered as HTML animations
const img = (f) => pathToFileURL(path.join(ART, f)).href;
const BASE_CSS = `
@font-face{font-family:Vazirmatn;font-weight:400;src:url('${FONT}/Vazirmatn-Regular.ttf')}
@font-face{font-family:Vazirmatn;font-weight:700;src:url('${FONT}/Vazirmatn-Bold.ttf')}
@font-face{font-family:Vazirmatn;font-weight:900;src:url('${FONT}/Vazirmatn-Black.ttf')}
*{margin:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden;background:#060b17;font-family:Vazirmatn;color:#fff;direction:rtl}
.bg{position:absolute;inset:-60px;background-size:cover;background-position:center;filter:blur(46px) saturate(1.3) brightness(.55);animation:bgz 6s ease-out both}
.veil{position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%,rgba(20,120,255,.18),transparent 60%),linear-gradient(90deg,rgba(6,11,23,.15) 0%,rgba(6,11,23,.75) 55%,rgba(6,11,23,.92) 100%)}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(120,190,255,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(120,190,255,.06) 1px,transparent 1px);background-size:64px 64px;mask-image:radial-gradient(ellipse at 70% 50%,#000 20%,transparent 70%);animation:gridm 6s linear both}
.art{position:absolute;left:150px;top:50%;width:720px;height:720px;margin-top:-360px;border-radius:44px;background-size:cover;box-shadow:0 0 120px rgba(40,140,255,.35),0 30px 80px rgba(0,0,0,.5);animation:pop 1.1s cubic-bezier(.2,.9,.25,1.15) both, float 6s ease-in-out 1.1s forwards}
.txt{position:absolute;right:150px;top:50%;width:820px;transform:translateY(-50%)}
.kicker{font-size:30px;font-weight:700;color:#4cd8f5;letter-spacing:1px;animation:up .7s .25s both}
h1{font-size:96px;font-weight:900;line-height:1.25;margin-top:14px;animation:up .8s .4s both;text-shadow:0 8px 40px rgba(0,0,0,.5)}
.sub{font-size:36px;font-weight:400;color:#c7d6ee;line-height:1.7;margin-top:18px;animation:up .8s .62s both}
.chips{display:flex;gap:14px;margin-top:34px;flex-wrap:wrap;animation:up .8s .85s both}
.chip{font-size:24px;font-weight:700;padding:8px 22px;border-radius:999px;background:rgba(76,216,245,.12);border:1px solid rgba(76,216,245,.45);color:#bff3ff}
.num{position:absolute;right:150px;top:150px;font-size:190px;font-weight:900;color:rgba(76,216,245,.14);animation:up .9s .1s both}
.bar{position:absolute;right:150px;bottom:150px;height:6px;width:820px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden}
.bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#1478ff,#4cd8f5);transform-origin:right;animation:fill var(--dur) linear both}
.url{font-family:ui-monospace,Consolas,monospace;direction:ltr;unicode-bidi:plaintext;text-align:right;font-size:34px;color:#fff;margin-top:26px;animation:up .8s .8s both}
@keyframes up{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.82) rotate(-2deg)}to{opacity:1;transform:none}}
@keyframes float{from{transform:translateY(0)}to{transform:translateY(-14px)}}
@keyframes bgz{from{transform:scale(1.12)}to{transform:scale(1)}}
@keyframes gridm{from{background-position:0 0}to{background-position:-64px 0}}
@keyframes fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
`;
const cardHtml = (c) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body style="--dur:${c.dur}s">
<div class="bg" style="background-image:url('${img(c.icon)}')"></div><div class="veil"></div><div class="grid"></div>
${c.num ? `<div class="num">${c.num}</div>` : ''}
<div class="art" style="background-image:url('${img(c.icon)}')"></div>
<div class="txt">${c.kicker ? `<div class="kicker">${c.kicker}</div>` : ''}<h1>${c.title}</h1>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}${c.url ? `<div class="url">${c.url}</div>` : ''}${c.chips ? `<div class="chips">${c.chips.map((x) => `<span class="chip">${x}</span>`).join('')}</div>` : ''}</div>
${c.bar ? '<div class="bar"><i></i></div>' : ''}
</body></html>`;

const cards = [
  { id: 'intro', dur: cardDur('intro', CARD.intro), icon: 'hero.png', kicker: 'چالش لیارا · هکاتون Agentic AI استارکوچ', title: 'لیارا کوپایلت', sub: 'دستیاری که به برنامه‌نویس‌ها کمک می‌کند سایتشان را روی لیارا منتشر و نگهداری کنند', chips: ['اتصال مستقیم به لیارا', 'هر تغییر با تأیید کاربر', 'پیدا کردن علت خطا'] },
  ...chapters.filter((c) => c.n).map((c) => ({ id: `ch${c.n}`, dur: cardDur(`ch${c.n}`, CARD.chapter), icon: c.icon, kicker: `قسمت ${['', 'اول', 'دوم', 'سوم', 'چهارم', 'پنجم'][c.n]}`, num: fa(c.n), title: c.title, sub: c.sub, bar: true })),
  { id: 'outro', dur: cardDur('outro', CARD.outro), icon: 'hero.png', kicker: 'کد و مستندات پروژه', title: 'لیارا کوپایلت', url: 'github.com/ssepehrnoush/liara-copilot', chips: ['دیپلوی از صفر', 'عیب‌یابی ۵۰۰ و کندی', 'ضد تزریق دستور', 'توقف اضطراری'] },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
for (const c of cards) {
  if (fs.existsSync(path.join(WORK, `card-${c.id}.mp4`)) && !args.includes('--rerender')) continue;
  const dir = path.join(WORK, `card-${c.id}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(WORK, `card-${c.id}.html`);
  fs.writeFileSync(file, cardHtml(c));
  await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  const n = Math.round(c.dur * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate((ms) => document.getAnimations().forEach((a) => { a.currentTime = ms; }), (i / FPS) * 1000);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  const fadeOut = (c.dur - 0.35).toFixed(2);
  ff(['-framerate', String(FPS), '-i', `card-${c.id}/f%04d.jpg`, '-vf', `fade=in:st=0:d=0.35,fade=out:st=${fadeOut}:d=0.35`, ...ENC, `card-${c.id}.mp4`], c.id);
  console.log('card', c.id);
}
await browser.close();

// ---------------------------------------------------------------- 3) cut the main video and join everything
const card = Object.fromEntries(cards.map((c) => [c.id, c]));
const parts = ['card-intro.mp4'];
const cardAt = { intro: 0 };
let clock = card.intro.dur;
const offsets = [];
chapters.forEach((c, i) => {
  if (c.n) {
    parts.push(`card-ch${c.n}.mp4`);
    cardAt[`ch${c.n}`] = clock;
    clock += card[`ch${c.n}`].dur;
  }
  const len = c.to - c.from;
  const name = `seg${i}.mp4`;
  const fo = Math.max(0, len - 0.25).toFixed(2);
  ff(['-ss', c.from.toFixed(3), '-i', 'main-sub.mp4', '-t', len.toFixed(3), '-vf', `fade=in:st=0:d=0.25,fade=out:st=${fo}:d=0.25`, ...ENC, name], name);
  parts.push(name);
  offsets.push({ from: c.from, to: c.to, at: clock });
  clock += len;
});
parts.push('card-outro.mp4');
cardAt.outro = clock;
const total = clock + card.outro.dur;
fs.writeFileSync(path.join(WORK, 'parts.txt'), parts.map((p) => `file '${p}'`).join('\n'));
const FINAL = path.join(OUT, 'liara-copilot-demo-final.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', 'parts.txt', ...ENC, '-movflags', '+faststart', VOICE ? path.join(WORK, 'silent.mp4') : FINAL], 'concat');

// Narration times in the final video, for the voice-over sheet.
const finalNar = narration.map((n) => {
  const o = offsets.find((x) => n.start >= x.from - 0.01 && n.start < x.to) || offsets.at(-1);
  return { ...n, finalStart: o.at + (n.start - o.from) };
});
if (VOICE) {
  // Soundtrack: every clip at its cue's place in the final cut.
  const voiced = [
    ...finalNar.filter((n) => n.voice),
    ...Object.keys(cardAt).filter(cardClip).map((id) => ({ finalStart: cardAt[id] + CARD_LEAD, voice: { file: path.join(VOICE, cardClip(id).file) } })),
  ];
  const inputs = voiced.flatMap((n) => ['-i', n.voice.file]);
  const graph = voiced.map((n, i) => `[${i}:a]aresample=48000,adelay=${Math.round(n.finalStart * 1000)}:all=1[a${i}]`).join(';')
    + `;${voiced.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voiced.length}:normalize=0:dropout_transition=0,apad,atrim=0:${total.toFixed(3)},loudnorm=I=-16:TP=-1.5[out]`;
  ff([...inputs, '-filter_complex', graph, '-map', '[out]', '-ac', '2', 'voice.wav'], 'voice mix');
  ff(['-i', 'silent.mp4', '-i', 'voice.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', FINAL], 'mux');
}
fs.writeFileSync(path.join(OUT, 'narration-final.json'), JSON.stringify({ cards: { intro: [0, card.intro.dur, lines['card-intro'] || ''], chapters: chapters.filter((c) => c.n).map((c) => ({ n: c.n, title: c.title, at: cardAt[`ch${c.n}`], dur: card[`ch${c.n}`].dur, say: lines[`card-ch${c.n}`] || '' })), outro: [cardAt.outro, card.outro.dur, lines['card-outro'] || ''] }, shots: finalNar, total }, null, 1));
console.log(`done: ${path.join(OUT, 'liara-copilot-demo-final.mp4')} (${Math.round(total)} s)`);
