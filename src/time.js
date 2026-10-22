// Times the model reads and repeats are Tehran time (UTC+3:30, no daylight saving since 2022), so
// what it tells the user matches the clock on their screen instead of UTC.
const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hourCycle: 'h23', ...opts });
const hm = fmt({ hour: '2-digit', minute: '2-digit' });
const hms = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const full = fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const tehranHM = (t) => hm.format(new Date(t));
export const tehranHMS = (t) => hms.format(new Date(t));
// "2026-10-22 22:21:05"
export function tehranStamp(t) {
  const p = Object.fromEntries(full.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
