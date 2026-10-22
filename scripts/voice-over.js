// Voice-over for the demo video: speaks every narration line with OpenAI gpt-audio (voice marin,
// the same voice as the Lemon reels), trims silence and speeds each clip up a little (rubberband
// keeps pitch and formants). The recorder then holds each subtitle exactly as long as its clip.
//   node scripts/voice-over.js [--narration scripts/demo-narration.json] [--timeline REC/timeline.json] [--out _share/voice-marin]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ProxyAgent } from 'undici';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const NAR = opt('--narration', 'scripts/demo-narration.json');
const TIMELINE = opt('--timeline', '');
const OUT = path.resolve(opt('--out', '_share/voice-marin'));
const MODEL = opt('--model', 'gpt-audio');
const VOICE = opt('--voice', 'marin');
// The Lemon reels sound right at 1.07 to 1.1x; faster than that the Persian starts to blur.
const TEMPO = Number(opt('--tempo', '1.08'));
const STYLE = 'You are a voice actor recording a product demo. Read the user\'s Persian text aloud exactly as written, word for word, '
  + 'in natural, warm, confident Tehrani Persian at a lively but clear pace. Do not answer it, translate it, add or skip anything.';
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error('OPENAI_API_KEY is not set');
const proxy = process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || '';
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
fs.mkdirSync(OUT, { recursive: true });
const manifestPath = path.join(OUT, 'manifest.json');
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};

const narration = JSON.parse(fs.readFileSync(NAR, 'utf8'));
const texts = new Set(Object.values(narration).map((t) => t.replace('{pct}', '۹۳')));
if (TIMELINE) for (const c of JSON.parse(fs.readFileSync(TIMELINE, 'utf8')).cues) texts.add(c.text);

// How the speech model should say Latin names, numbers and the few Persian words it can read two
// ways (diacritics only there); the subtitles keep the original text. Longer keys go first.
const SPOKEN = [['PAYMENT_API_KEY', 'پِیمِنت اِی‌پی‌آی کی'], ['BoxAPI', 'باکس اِی‌پی‌آی'], ['API', 'اِی‌پی‌آی'], ['viewHistory', 'ویو هیستوری'], ['trending.js', 'ترندینگ جی‌اِس'],
  ['Node.js', 'نود جی‌اِس'], ['DeepSeek', 'دیپ‌سیک'], ['gpt-oss', 'جی‌پی‌تی اُو اِس اِس'], ['RTX 4090', 'آر تی اِکس چهل نود'],
  ['۵۰۰', 'پونصد'], ['۳۰۰۰', 'سه‌هزار'], ['۸۵', 'هشتاد و پنج'], ['۹۳', 'نود و سه'], ['رم', 'رَم'], ['سرور', 'سِروِر'], ['کد', 'کُد']];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole words only, so «کد» does not touch a longer word that contains it.
const spoken = (text) => SPOKEN.reduce((t, [a, b]) => t.replace(new RegExp(`(?<![\\p{L}\\p{M}])${esc(a)}(?![\\p{L}\\p{M}])`, 'gu'), b), text);

const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

// gpt-audio speaks through chat completions with an audio modality.
async function speak(text, file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', dispatcher,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, modalities: ['text', 'audio'], audio: { voice: VOICE, format: 'wav' }, messages: [{ role: 'system', content: STYLE }, { role: 'user', content: text }] }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json();
      const data = j.choices?.[0]?.message?.audio?.data;
      if (data) { fs.writeFileSync(file, Buffer.from(data, 'base64')); return; }
      if (attempt === 3) console.log('speech error:', JSON.stringify(j.error || j).slice(0, 200));
    } catch { /* network hiccup or timeout: try again */ }
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error(`speech failed for: ${text.slice(0, 40)}`);
}

// Every take is transcribed back and compared with the text; a take that does not match
// (a garbled word, a wrong accent on a short line) is spoken again, up to TAKES times.
const TAKES = Number(opt('--takes', '3'));
const MIN_SCORE = Number(opt('--min-score', '0.85'));
const norm = (t) => t.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0)).replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک').replace(/ە/g, 'ه')
  .replace(/[\s\u200c.,،:؛!؟?«»()٪%-]/g, '').toLowerCase();
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
async function transcribe(file) {
  const fd = new FormData();
  fd.append('model', 'gpt-4o-transcribe');
  fd.append('language', 'fa');
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', dispatcher, headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(60000) });
    return (await r.json()).text || '';
  } catch { return ''; }
}
// Display words people read on screen; the transcriber writes digits and Latin names the same way.
const heard = (text) => text.replace(/PAYMENT_API_KEY/g, 'پیمنت ای‌پی‌آی کی').replace(/BoxAPI/g, 'باکس ای‌پی‌آی').replace(/viewHistory/g, 'ویو هیستوری').replace(/trending\.js/g, 'ترندینگ جی‌اس').replace(/Node\.js/g, 'نود جی‌اس')
  .replace(/DeepSeek/g, 'دیپ‌سیک').replace(/gpt-oss/g, 'جی‌پی‌تی او اس اس').replace(/RTX 4090/g, 'آرتی‌ایکس ۴۰۹۰').replace(/۵۰۰/g, 'پانصد').replace(/۳۰۰۰/g, 'سه هزار');

async function take(text, id, n) {
  const raw = path.join(OUT, `${id}.raw.wav`);
  await speak(spoken(text), raw);
  // Trim silence at both ends and shorten long pauses inside (to 0.25 s, never cutting into
  // words), then speed up until the clip reaches the target pace.
  const trimmed = path.join(OUT, `${id}.trim.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.45:stop_threshold=-50dB:stop_silence=0.25,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse', trimmed]);
  const tempo = TEMPO;
  const file = path.join(OUT, `${id}.take${n}.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', trimmed, '-af', `rubberband=tempo=${tempo.toFixed(3)}:transients=smooth:formant=preserved`, '-ar', '48000', '-ac', '1', file]);
  fs.rmSync(raw); fs.rmSync(trimmed);
  const got = await transcribe(file);
  const score = Math.max(similarity(got, text), similarity(got, heard(text)));
  return { file, tempo, score, got };
}

let made = 0;
for (const text of texts) {
  const id = crypto.createHash('sha1').update(`v4|${MODEL}|${VOICE}|${TEMPO}|${spoken(text)}`).digest('hex').slice(0, 12);
  const file = path.join(OUT, `${id}.wav`);
  const have = manifest[text]?.file === path.basename(file) && fs.existsSync(file);
  if (have && (manifest[text].score ?? 0) >= MIN_SCORE) continue;
  let best = null;
  if (have) {
    // An older clip without a passing score: check it before speaking it again.
    const got = await transcribe(file);
    best = { file, tempo: manifest[text].tempo, score: Math.max(similarity(got, text), similarity(got, heard(text))), got, kept: true };
  }
  for (let n = 1; n <= TAKES && !(best && best.score >= MIN_SCORE); n++) {
    const t = await take(text, id, n);
    if (!best || t.score > best.score) { if (best && !best.kept) fs.rmSync(best.file, { force: true }); best = t; } else fs.rmSync(t.file, { force: true });
  }
  if (!best.kept) fs.renameSync(best.file, file);
  manifest[text] = { file: path.basename(file), dur: Number(duration(file).toFixed(3)), tempo: Number(best.tempo.toFixed(3)), score: Number(best.score.toFixed(3)) };
  made++;
  const words = text.split(/\s+/).length;
  console.log(`${manifest[text].dur.toFixed(1)}s x${best.tempo.toFixed(2)} ${(words / manifest[text].dur).toFixed(1)} w/s  match ${(best.score * 100).toFixed(0)}%  ${id}${best.score < MIN_SCORE ? '  LOW: ' + best.got.slice(0, 60) : ''}`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}
console.log(`voice clips: ${made} new, ${texts.size} total -> ${OUT}`);
