// Look of the video's title, chapter and closing cards: flat, minimal drawings made of a few
// shapes on a light background (hand-written SVG, so nothing looks machine-generated), with the
// Persian text on the right. polish-video.js renders these pages frame by frame.

const INK = '#1F2A44';
const BLUE = '#3A7BFF';
const MINT = '#9FE3C8';
const GREEN = '#2BB58A';
const PEACH = '#FFC9A8';
const CORAL = '#FF8A65';
const BUTTER = '#FFE08A';
const LILAC = '#CFC6FF';

const star = (x, y, s, fill) => `<path d="M${x} ${y - s}l${s * 0.3} ${s * 0.7} ${s * 0.7} ${s * 0.3} -${s * 0.7} ${s * 0.3} -${s * 0.3} ${s * 0.7} -${s * 0.3} -${s * 0.7} -${s * 0.7} -${s * 0.3} ${s * 0.7} -${s * 0.3}z" fill="${fill}"/>`;
const svg = (body) => `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

// Keyed by the art file names the cards already use.
export const ART = {
  // A smiling cloud and a small rocket leaving it: deploying to the cloud.
  'hero.png': svg(`
    <circle cx="200" cy="205" r="165" fill="#E3EDFF"/>
    ${star(92, 112, 20, BUTTER)}${star(318, 292, 14, BUTTER)}
    <circle cx="322" cy="168" r="7" fill="${MINT}"/><circle cx="96" cy="300" r="6" fill="${LILAC}"/>
    <path d="M214 176 C238 160 256 142 268 120" stroke="${PEACH}" stroke-width="10" fill="none" stroke-dasharray="1 20"/>
    <g transform="translate(288 92) rotate(40)">
      <path d="M0 -50 C20 -32 22 8 15 32 L-15 32 C-22 8 -20 -32 0 -50Z" fill="${BLUE}" stroke="${INK}" stroke-width="6"/>
      <circle cx="0" cy="-8" r="9" fill="#fff" stroke="${INK}" stroke-width="5"/>
      <path d="M-15 12 L-30 36 L-13 32Z M15 12 L30 36 L13 32Z" fill="${CORAL}" stroke="${INK}" stroke-width="5"/>
      <path d="M-8 36 Q0 60 8 36Z" fill="${BUTTER}"/>
    </g>
    <ellipse cx="205" cy="306" rx="112" ry="11" fill="${INK}" opacity=".08"/>
    <path d="M112 286 C78 286 70 242 102 232 C100 196 140 184 160 202 C172 158 238 154 252 202 C286 190 318 216 306 250 C332 258 324 288 300 286 Z" fill="#fff" stroke="${INK}" stroke-width="6"/>
    <circle cx="180" cy="242" r="6.5" fill="${INK}"/><circle cx="230" cy="242" r="6.5" fill="${INK}"/>
    <path d="M192 260 Q205 271 218 260" stroke="${INK}" stroke-width="5.5" fill="none"/>
    <circle cx="162" cy="260" r="9" fill="${PEACH}"/><circle cx="248" cy="260" r="9" fill="${PEACH}"/>`),

  // A browser window with a steady pulse and a check: from project to a healthy site.
  'ch1-deploy.png': svg(`
    <circle cx="200" cy="205" r="165" fill="#DFF5EC"/>
    ${star(330, 104, 16, BUTTER)}<circle cx="76" cy="300" r="7" fill="${LILAC}"/>
    <rect x="66" y="100" width="258" height="186" rx="24" fill="#fff" stroke="${INK}" stroke-width="6"/>
    <line x1="66" y1="142" x2="324" y2="142" stroke="${INK}" stroke-width="6"/>
    <circle cx="94" cy="121" r="7" fill="${CORAL}"/><circle cx="117" cy="121" r="7" fill="${BUTTER}"/><circle cx="140" cy="121" r="7" fill="${MINT}"/>
    <path d="M92 222 H146 L164 186 L186 252 L206 204 L220 222 H296" stroke="${BLUE}" stroke-width="9" fill="none"/>
    <circle cx="302" cy="282" r="44" fill="${GREEN}" stroke="${INK}" stroke-width="6"/>
    <path d="M282 282 L297 297 L322 268" stroke="#fff" stroke-width="10" fill="none"/>`),

  // Three bars of different cost and a cheerful coin on the cheapest one: cost and paths.
  'ch4-memory.png': svg(`
    <circle cx="200" cy="205" r="165" fill="#FFF0DE"/>
    ${star(86, 118, 18, BUTTER)}<circle cx="330" cy="140" r="7" fill="${MINT}"/>
    <line x1="80" y1="300" x2="320" y2="300" stroke="${INK}" stroke-width="6"/>
    <rect x="102" y="140" width="52" height="160" rx="14" fill="${LILAC}" stroke="${INK}" stroke-width="6"/>
    <rect x="174" y="196" width="52" height="104" rx="14" fill="${MINT}" stroke="${INK}" stroke-width="6"/>
    <rect x="246" y="246" width="52" height="54" rx="14" fill="${BLUE}" stroke="${INK}" stroke-width="6"/>
    <circle cx="272" cy="196" r="36" fill="${BUTTER}" stroke="${INK}" stroke-width="6"/>
    <circle cx="272" cy="196" r="24" fill="none" stroke="#E8BE45" stroke-width="5"/>
    <circle cx="262" cy="192" r="4.5" fill="${INK}"/><circle cx="282" cy="192" r="4.5" fill="${INK}"/>
    <path d="M264 204 Q272 211 280 204" stroke="${INK}" stroke-width="4.5" fill="none"/>`),

  // A shield with a check and a gear behind it: automation that stays safe.
  'ch3-shield.png': svg(`
    <circle cx="200" cy="205" r="165" fill="#ECE8FF"/>
    ${star(320, 300, 16, BUTTER)}<circle cx="330" cy="120" r="7" fill="${PEACH}"/>
    <g transform="translate(130 136)" fill="${PEACH}" stroke="${INK}" stroke-width="6">
      ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<rect x="-11" y="-66" width="22" height="26" rx="6" transform="rotate(${a})"/>`).join('')}
      <circle r="48"/><circle r="17" fill="#fff"/>
    </g>
    <path d="M214 104 L306 136 C306 226 270 282 214 310 C158 282 122 226 122 136 Z" fill="${MINT}" stroke="${INK}" stroke-width="6"/>
    <path d="M178 206 L206 234 L254 180" stroke="${INK}" stroke-width="11" fill="none"/>`),
};

export const CARD_CSS = (font) => `
@font-face{font-family:Vazirmatn;font-weight:400;src:url('${font}/Vazirmatn-Regular.ttf')}
@font-face{font-family:Vazirmatn;font-weight:700;src:url('${font}/Vazirmatn-Bold.ttf')}
@font-face{font-family:Vazirmatn;font-weight:900;src:url('${font}/Vazirmatn-Black.ttf')}
*{margin:0;box-sizing:border-box}
html,body{width:1920px;height:1080px;overflow:hidden;background:#FBF7F1;font-family:Vazirmatn;color:${INK};direction:rtl}
.dots{position:absolute;inset:0;background-image:radial-gradient(#E9E2D5 2px,transparent 2.5px);background-size:44px 44px;opacity:.7}
.art{position:absolute;left:170px;top:50%;width:640px;height:640px;margin-top:-320px;animation:pop 1s cubic-bezier(.2,.9,.25,1.2) both, float 6s ease-in-out 1s forwards}
.art svg{width:100%;height:100%;display:block}
.txt{position:absolute;right:150px;top:50%;width:820px;transform:translateY(-50%)}
.kicker{font-size:30px;font-weight:700;color:${BLUE};animation:up .7s .25s both}
h1{font-size:96px;font-weight:900;line-height:1.25;margin-top:14px;animation:up .8s .4s both}
.sub{font-size:36px;font-weight:400;color:#5B6475;line-height:1.7;margin-top:18px;animation:up .8s .62s both}
.chips{display:flex;gap:14px;margin-top:34px;flex-wrap:wrap;animation:up .8s .85s both}
.chip{font-size:24px;font-weight:700;padding:8px 22px;border-radius:999px;background:#fff;border:3px solid ${INK};color:${INK}}
.num{position:absolute;right:150px;top:140px;font-size:190px;font-weight:900;color:rgba(58,123,255,.12);animation:up .9s .1s both}
.bar{position:absolute;right:150px;bottom:150px;height:8px;width:820px;border-radius:8px;background:#ECE5D8;overflow:hidden}
.bar i{display:block;height:100%;width:100%;background:${BLUE};transform-origin:right;animation:fill var(--dur) linear both}
.url{font-family:ui-monospace,Consolas,monospace;direction:ltr;unicode-bidi:plaintext;text-align:right;font-size:34px;color:${INK};margin-top:26px;animation:up .8s .8s both}
@keyframes up{from{opacity:0;transform:translateY(34px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.8) rotate(-3deg)}to{opacity:1;transform:none}}
@keyframes float{from{transform:translateY(0)}to{transform:translateY(-12px)}}
@keyframes fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
`;

// One card page: { icon, kicker, num, title, sub, url, chips, bar, dur }.
export const cardHtml = (c, font) => `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><style>${CARD_CSS(font)}</style></head><body style="--dur:${c.dur}s">
<div class="dots"></div>
${c.num ? `<div class="num">${c.num}</div>` : ''}
<div class="art">${ART[c.icon] || ''}</div>
<div class="txt">${c.kicker ? `<div class="kicker">${c.kicker}</div>` : ''}<h1>${c.title}</h1>${c.sub ? `<div class="sub">${c.sub}</div>` : ''}${c.url ? `<div class="url">${c.url}</div>` : ''}${c.chips ? `<div class="chips">${c.chips.map((x) => `<span class="chip">${x}</span>`).join('')}</div>` : ''}</div>
${c.bar ? '<div class="bar"><i></i></div>' : ''}
</body></html>`;
