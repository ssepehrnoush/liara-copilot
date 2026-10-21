// Joins parts of several recordings into one timeline and shortens long waits, so a
// scene can be re-recorded without redoing the whole video.
//   node scripts/merge-recordings.js --out _share/rec-final _share/rec-a:0-255.6 _share/rec-b
//   then: node scripts/build-video.js _share/rec-final
// Inside a cue that lasts longer than it needs to be read, the first 10 s keep real speed
// (so cards stay readable) and the rest is squeezed to fit.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = path.resolve(args[outIdx + 1]);
// --keep: no squeezing here (scripts/polish-video.js --voice squeezes around the voice clips).
const KEEP_ALL = args.includes('--keep');
const parts = args.filter((a, i) => i !== outIdx && i !== outIdx + 1 && a !== '--keep');
const minDur = (text) => Math.max(2500, text.length * 45);
const KEEP = 10000;

fs.mkdirSync(out, { recursive: true });
const frames = [];
const cues = [];
let offset = 0;

for (const spec of parts) {
  const [dir, range] = spec.split(/:(?=[\d.]+-)/);
  const tl = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
  const t0 = tl.frames[0].t;
  const [from, to] = range ? range.split('-').map((x) => (x === '' ? Infinity : Number(x) * 1000)) : [0, Infinity];
  const lo = t0 + from;
  const hi = Math.min(t0 + to, tl.end);

  // Piecewise-linear time map: [segment start, segment end, scale].
  const segs = [];
  for (const c of tl.cues) {
    const s = Math.max(c.start, lo);
    const e = Math.min(c.end ?? tl.end, hi);
    if (e <= s) continue;
    const target = Math.max(minDur(c.text), 14000);
    if (!KEEP_ALL && e - s > target + 2000) {
      segs.push([s, s + KEEP, 1], [s + KEEP, e, (target - KEEP) / (e - s - KEEP)]);
    } else segs.push([s, e, 1]);
  }
  const map = (t) => {
    let acc = 0;
    for (const [s, e, k] of segs) {
      if (t >= e) acc += (e - s) * k;
      else if (t > s) return acc + (t - s) * k;
      else return acc;
    }
    return acc;
  };
  const rel = path.relative(out, path.resolve(dir)).replace(/\\/g, '/');
  for (const f of tl.frames) {
    if (f.t < lo || f.t > hi) continue;
    frames.push({ t: offset + map(f.t), path: `${rel}/frames/${f.file}` });
  }
  for (const c of tl.cues) {
    const s = Math.max(c.start, lo);
    const e = Math.min(c.end ?? tl.end, hi);
    if (e - s < 300) continue;
    cues.push({ start: offset + map(s), end: offset + map(e), text: c.text, ...(c.id && { id: c.id }) });
  }
  offset += map(hi) + 40;
  console.log(`${dir}: ${Math.round((hi - lo) / 1000)} s -> ${Math.round(map(hi) / 1000)} s`);
}

// Drop frames that collapsed onto the same instant after squeezing.
const kept = frames.filter((f, i) => i === 0 || f.t - frames[i - 1].t >= 8);
fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ frames: kept, cues, end: offset }, null, 1));
console.log(`merged: ${kept.length} frames, ${Math.round(offset / 1000)} s`);
