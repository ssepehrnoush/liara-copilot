// Voice-over for the demo video: speaks every narration line with OpenAI text-to-speech,
// trims silence and speeds each clip up to a brisk pace. The recorder then holds each
// subtitle exactly as long as its clip, so the video is timed to the voice.
//   node scripts/voice-over.js [--narration scripts/demo-narration.json] [--timeline REC/timeline.json] [--out _share/voice]
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
const OUT = path.resolve(opt('--out', '_share/voice'));
const MODEL = opt('--model', 'gpt-4o-mini-tts-2025-12-15');
const VOICE = opt('--voice', 'ash');
const WPS = Number(opt('--wps', '3.3'));
const STYLE = 'Speak natural, casual Tehrani Persian, like a young developer presenting his own project to friends and judges. '
  + 'Warm, friendly and confident, never robotic. Speak quickly, a bit faster than normal conversation, with only very short pauses between sentences. Read the text exactly as written.';
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

// How the speech model should say a few English words; the subtitles keep the original text.
const SPOKEN = [['BoxAPI', 'باکس اِی‌پی‌آی'], ['PAYMENT_API_KEY', 'پِیمِنت اِی‌پی‌آی کی'], ['viewHistory', 'ویو هیستوری'], ['trending.js', 'ترندینگ جی‌اس'], ['Node.js', 'نود جی‌اس']];
const spoken = (text) => SPOKEN.reduce((t, [a, b]) => t.split(a).join(b), text);

const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

async function speak(text, file) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', dispatcher,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, voice: VOICE, input: text, instructions: STYLE, response_format: 'wav' }),
        signal: AbortSignal.timeout(120000),
      });
      if (r.ok) { fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return; }
    } catch { /* network hiccup or timeout: try again */ }
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
  }
  throw new Error(`text-to-speech failed for: ${text.slice(0, 40)}`);
}

let made = 0;
for (const text of texts) {
  const id = crypto.createHash('sha1').update(`v2|${MODEL}|${VOICE}|${WPS}|${spoken(text)}`).digest('hex').slice(0, 12);
  const file = path.join(OUT, `${id}.wav`);
  if (manifest[text]?.file === path.basename(file) && fs.existsSync(file)) continue;
  const raw = path.join(OUT, `${id}.raw.wav`);
  await speak(spoken(text), raw);
  // Trim silence at both ends, shorten pauses inside to 0.15 s, then speed up (pitch kept)
  // until the clip reaches the target pace.
  const trimmed = path.join(OUT, `${id}.trim.wav`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_duration=0.3:stop_threshold=-45dB:stop_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse', trimmed]);
  const words = text.split(/\s+/).length;
  const tempo = Math.min(1.6, Math.max(1, WPS / (words / duration(trimmed))));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', trimmed, '-af', `atempo=${tempo.toFixed(3)}`, '-ar', '48000', '-ac', '1', file]);
  fs.rmSync(raw); fs.rmSync(trimmed);
  manifest[text] = { file: path.basename(file), dur: Number(duration(file).toFixed(3)), tempo: Number(tempo.toFixed(3)) };
  made++;
  console.log(`${manifest[text].dur.toFixed(1)}s x${tempo.toFixed(2)} ${(words / manifest[text].dur).toFixed(1)} w/s  ${id}`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
}
console.log(`voice clips: ${made} new, ${texts.size} total -> ${OUT}`);
