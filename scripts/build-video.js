// Turns a recording made by record-demo.js into demo.mp4 with burned-in Persian subtitles,
// plus demo.srt and narration.txt (the subtitle text with times, for the voice-over).
//   node scripts/build-video.js _share/rec
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = path.resolve(process.argv[2] || '_share/rec');
const { frames, cues, end } = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
const fontDir = path.resolve('node_modules/vazirmatn/fonts/ttf');

// ffmpeg concat list: every frame shown until the next one arrives.
const list = [];
frames.forEach((f, i) => {
  const next = i + 1 < frames.length ? frames[i + 1].t : end;
  list.push(`file 'frames/${f.file}'`, `duration ${Math.max(0.001, (next - f.t) / 1000).toFixed(3)}`);
});
list.push(`file 'frames/${frames.at(-1).file}'`);
fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));

const ts = (ms, sep) => {
  const s = Math.max(0, ms) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return sep === 'srt'
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0').replace('.', ',')}`
    : `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
};
const t0 = frames[0].t;
const shift = (c) => ({ ...c, start: c.start - t0, end: (c.end ?? end) - t0 });
const subs = cues.map(shift).filter((c) => c.end - c.start > 300);

fs.writeFileSync(path.join(dir, 'demo.srt'), subs.map((c, i) => `${i + 1}\n${ts(c.start, 'srt')} --> ${ts(c.end, 'srt')}\n${c.text}\n`).join('\n'));
fs.writeFileSync(path.join(dir, 'narration.txt'), subs.map((c) => `[${ts(c.start, 'srt').slice(3, 8)} تا ${ts(c.end, 'srt').slice(3, 8)}] ${c.text}`).join('\n\n') + '\n');

// Balanced manual line breaks: libass would otherwise break next to Latin words in RTL text.
function lines(text, max = 88) {
  const n = Math.ceil(text.length / max);
  if (n <= 1) return text;
  const target = Math.ceil(text.length / n);
  const out = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && `${cur} ${w}`.length > target && out.length < n - 1) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  out.push(cur);
  return out.join('\\N');
}

const ass = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1920', 'PlayResY: 1080', 'WrapStyle: 2', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Fa,Vazirmatn,34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,120,120,14,1',
  '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ...subs.map((c) => `Dialogue: 0,${ts(c.start)},${ts(c.end)},Fa,,0,0,0,,${lines(c.text)}`),
].join('\n');
fs.writeFileSync(path.join(dir, 'demo.ass'), ass);

const fontsdir = fontDir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
const assPath = path.join(dir, 'demo.ass').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
const run = (argv, label) => {
  console.log('ffmpeg', label);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${label}`);
};
const common = ['-f', 'concat', '-safe', '0', '-i', 'frames.txt'];
const enc = ['-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
// The page fills 1920x960; a dark 120 px band under it carries the subtitles.
const frame = 'scale=1920:960:flags=lanczos,pad=1920:1080:0:0:color=0x0d1117';
run([...common, '-vf', `${frame},ass='${assPath}':fontsdir='${fontsdir}'`, ...enc, 'demo.mp4'], 'with subtitles');
run([...common, '-vf', frame, ...enc, 'demo-nosub.mp4'], 'without subtitles');
console.log(`done: ${path.join(dir, 'demo.mp4')} (${Math.round((end - t0) / 1000)} s), demo.srt, narration.txt`);
