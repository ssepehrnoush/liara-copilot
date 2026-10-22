/* Execution paths page: the measured model comparison, the cost charts and the self-hosting
   estimate, all drawn from paths-data.json. Plain JS and inline SVG, no build step. */
(() => {
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs = {}, text) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  // SVG text with Persian content: always right-to-left, placed by its visible edge so the
  // anchor does not flip with the page direction. align: right | left | middle.
  const t = (x, y, text, align = 'right', cls) => s('text', { x, y, direction: 'rtl', 'text-anchor': { right: 'start', left: 'end', middle: 'middle' }[align], class: cls }, text);
  const fa = (n, d = 0) => Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d });
  const toman = (t) => (t === 0 ? '۰ تومان' : `${fa(Math.round(t / 10) * 10)} تومان`);
  const million = (t) => (t === 0 ? '۰' : `${fa(t / 1e6, t < 1e7 ? 1 : 0)} میلیون`);
  const KIND = { closed: 'API بسته', open: 'وزن باز', none: 'بدون مدل' };

  // ---- tooltip (mouse, touch and keyboard focus) ----
  const tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x + 14;
    if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    let top = y + 14;
    if (top + r.height > innerHeight - 8) top = y - r.height - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  const hideTip = () => { tip.hidden = true; };
  const row = (k, v, color) => `<div class="row"><span>${color ? `<i style="background:${color}"></i>` : ''}${k}</span><span>${v}</span></div>`;

  let D;
  fetch('paths-data.json').then((r) => r.json()).then((data) => {
    D = data;
    prepare();
    renderStatic();
    renderCharts();
    let t;
    addEventListener('resize', () => { clearTimeout(t); t = setTimeout(renderCharts, 120); });
  });

  function prepare() {
    const S = Object.keys(D.scenarios);
    const sum = (p, f) => S.reduce((a, k) => a + (p.runs[k]?.[f] || 0), 0);
    for (const p of D.paths) {
      p.toman = sum(p, 'costUSD') * D.usdToman;
      p.pass = S.filter((k) => p.runs[k]?.ok).length;
      p.seconds = sum(p, 'seconds');
      p.calls = sum(p, 'calls');
      p.inputTokens = sum(p, 'inputTokens');
      p.cachedTokens = sum(p, 'cachedTokens');
      p.outputTokens = sum(p, 'outputTokens');
    }
    D.byId = Object.fromEntries(D.paths.map((p) => [p.id, p]));
    for (const m of D.selfHost.models) m.cap = capacity(m);
  }

  // Conversations one GPU setup can serve: published tokens/s divided by the tokens one
  // conversation needs (measured input, minus the share a prefix cache serves, plus output).
  function capacity(m) {
    const p = D.byId[m.id];
    const gpu = D.selfHost.gpus[m.gpu];
    const rent = gpu.monthlyToman ? gpu.monthlyToman * m.gpuCount : null;
    if (!m.tokPerSec) return { rent, perConv: null };
    const perConv = p.inputTokens * (1 - D.selfHost.cacheShare) + p.outputTokens;
    const perHour = m.tokPerSec.map((t) => (t * 3600) / perConv);
    const perMonth = perHour.map((x) => x * D.selfHost.busyHoursPerMonth);
    return { rent, perConv, perHour, perMonth, convCost: rent ? perMonth.map((n) => rent / n) : null };
  }

  // ------------------------------------------------------------ tiles, tables, lists
  function renderStatic() {
    $('#measuredChip').textContent = `سنجش ${new Date(D.measuredAt).toLocaleDateString('fa-IR', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const sol = D.byId['gpt-6-sol'];
    const cheapest = D.paths.filter((p) => p.pass === 4 && p.kind !== 'none').sort((a, b) => a.toman - b.toman)[0];
    const qwen = D.selfHost.models.find((m) => m.id === 'qwen3.6-35b-a3b');
    const tile = (lbl, val, unit, note, cls) => h('div', { class: `tile ${cls || ''}` }, h('span', { class: 'lbl' }, lbl), h('span', { class: 'val' }, val, unit ? h('small', {}, unit) : null), h('span', { class: 'note' }, note));
    $('#tiles').replaceChildren(
      tile('مدل فعلی، GPT-6 Sol', toman(sol.toman), 'هر گفتگو', `${fa(sol.pass)} از ۴ کار، بهترین کیفیتِ اصلاح کد`),
      tile('ارزان‌ترین مدلِ ۴ از ۴', toman(cheapest.toman), 'هر گفتگو', [h('bdi', {}, cheapest.name), `، ${fa(sol.toman / cheapest.toman)} برابر ارزان‌تر از Sol`], 'accent'),
      tile('بدون هیچ هزینهٔ مدل', '۰ تومان', null, 'حالت قواعد؛ ۴ از ۴، ولی فقط درخواست‌های مشخص'),
      tile('سرور خودی با یک RTX 4090', `${fa(qwen.cap.perMonth[0] / 1000)} تا ${fa(qwen.cap.perMonth[1] / 1000)} هزار`, 'گفتگو در ماه', [h('bdi', {}, 'Qwen3.6 35B'), `، اجارهٔ ماهانه حدود ${million(qwen.cap.rent)} تومان (تخمین)`]),
    );

    // Results table: closed models first, then open-weight, then rule mode.
    const order = { closed: 0, open: 1, none: 2 };
    const rows = [...D.paths].sort((a, b) => order[a.kind] - order[b.kind]);
    const S = Object.keys(D.scenarios);
    $('#resultsTable').replaceChildren(
      h('thead', {}, h('tr', {}, ...['مسیر', 'نوع', 'چهار کار', 'هزینهٔ هر گفتگو', 'زمان کل', 'رم بعد از اصلاح نشت', 'یادداشت'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((p) => h('tr', { class: p.pass < 4 ? 'dim' : null },
        h('td', { class: 'name' }, h('b', {}, p.name), p.kind !== 'none' ? h('code', {}, p.model) : h('code', {}, 'LLM_PROVIDER=none')),
        h('td', {}, h('span', { class: 'kind' }, h('i', { style: `background:${p.kind === 'closed' ? 'var(--s1)' : p.kind === 'open' ? 'var(--s3)' : 'var(--neutral)'}` }), KIND[p.kind])),
        h('td', {}, h('div', { class: 'marks' }, ...S.map((k) => {
          const r = p.runs[k];
          const t = `${D.scenarios[k]}: ${r?.ok ? 'موفق' : 'ناموفق'}${r?.retries ? ' (یک تلاش اشتباه که خودش درست کرد)' : ''}`;
          return h('span', { class: `mk ${r?.ok ? 'ok' : 'no'}`, title: t, 'aria-label': t }, r?.ok ? '✓' : '✗');
        }), h('span', { class: 'score' }, `${fa(p.pass)} از ۴`))),
        h('td', { class: 'num' }, toman(p.toman)),
        h('td', { class: 'num' }, `${fa(p.seconds)} ثانیه`),
        h('td', { class: 'num', title: 'هرچه کمتر، اصلاح ریشه‌ای‌تر. ۵۶ مگابایت یعنی کد را بازنویسی کرد تا فقط شمارنده نگه دارد.' }, p.runs.s4?.ok && p.runs.s4.memoryAfterMB ? `${fa(p.runs.s4.memoryAfterMB)} مگابایت` : '-'),
        h('td', { class: 'note' }, p.note),
      ))),
    );

    // Self-hosting table.
    const sh = D.selfHost;
    $('#hostSub').textContent = `ظرفیت = توان پردازش کارت (توکن در ثانیه، از بنچمارک‌های منتشرشده) تقسیم بر توکن‌های هر گفتگو (اندازه‌گیری‌شده، با فرض اینکه ${fa(sh.cacheShare * 100)}٪ ورودی از کش بیاید، مثل اجرای Sol). هر ماه ${fa(sh.busyHoursPerMonth)} ساعت پرکار حساب شده.`;
    const rng = (a, f = (x) => fa(x)) => `${f(a[0])} تا ${f(a[1])}`;
    $('#hostTable').replaceChildren(
      h('thead', {}, h('tr', {}, ...['مدل', 'نتیجهٔ سنجش', 'اندازه', 'حافظهٔ لازم', 'سخت‌افزار', 'اجارهٔ ماهانه', 'گفتگو در ساعت', 'گفتگو در ماه', 'هزینهٔ هر گفتگو با ظرفیت پر', 'همین مدل از API'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...sh.models.map((m) => {
        const p = D.byId[m.id];
        const gpu = sh.gpus[m.gpu];
        const c = m.cap;
        const hw = `${m.gpuCount > 1 ? `${fa(m.gpuCount)} × ` : ''}${gpu.name}`;
        return h('tr', { class: p.pass < 4 ? 'dim' : null },
          h('td', { class: 'name' }, h('b', {}, p.name)),
          h('td', { class: 'num' }, `${fa(p.pass)} از ۴`),
          h('td', {}, m.params),
          h('td', {}, m.memory),
          h('td', {}, hw),
          h('td', { class: 'num' }, c.rent ? `${million(c.rent)} تومان` : 'قیمت عمومی در ایران پیدا نشد'),
          h('td', { class: 'num' }, c.perHour ? rng(c.perHour) + (m.assumed ? ' (فرض: هم‌ردهٔ Qwen)' : '') : '-'),
          h('td', { class: 'num' }, c.perMonth ? `${rng(c.perMonth.map((x) => x / 1000))} هزار` : '-'),
          h('td', { class: 'num' }, c.convCost ? `${rng([c.convCost[1], c.convCost[0]], (x) => fa(Math.round(x / 10) * 10))} تومان` : m.gpuCount > 1 ? 'در ایران عملاً در دسترس نیست' : '-'),
          h('td', { class: 'num' }, toman(p.toman)),
        );
      })),
    );
    const q = qwen.cap;
    $('#hostTakeaway').textContent = `جمع‌بندی: اگر فقط هزینه مهم باشد، مدل ارزان از راه API برنده است؛ مثلاً DeepSeek حدود ${toman(D.byId['deepseek-v4-flash'].toman)} برای هر گفتگو. سرور خودی وقتی می‌ارزد که لیارا استقلال بخواهد (داده از ایران بیرون نرود و تحریم اثری نداشته باشد) یا حجم بالا باشد: یک RTX 4090 با Qwen در ظرفیت پر هر گفتگو را ${toman(q.convCost[1])} تا ${toman(q.convCost[0])} درمی‌آورد و از حدود ${fa(Math.ceil(q.rent / D.byId['gpt-6-sol'].toman / 100) * 100)} گفتگو در ماه از Sol ارزان‌تر می‌شود.`;

    $('#rejected').replaceChildren(...D.rejected.map((r) => h('li', {}, h('b', {}, r.name), h('span', {}, r.why))));
    $('#method').replaceChildren(
      ...[
        'هر مسیر روی شبیه‌ساز خالیِ لیارا، با همان چهار پیام و همان کد کوپایلت، یک بار از اول اجرا شد. کارت‌های تأیید خودکار تأیید شدند.',
        'در سناریوی نشت حافظه، بازدیدکنندهٔ ساختگی (۸ درخواست در ثانیه) آن‌قدر کار کرد تا رم از ۲۸۰ مگابایت گذشت.',
        'هزینهٔ هر درخواست را خود BoxAPI اعلام کرد. GPT-6 Sol روی OpenAI با همان قیمتِ BoxAPI سنجیده شد. هر دلار ۲۷۰ هزار تومان حساب شده.',
        'یک اجرا برای هر مدل است؛ عددها ممکن است در اجرای بعدی کمی فرق کنند. ظرفیت سرور خودی تخمین است و با یک تست بار روی کارت واقعی دقیق می‌شود.',
        'فکر کردنِ مدل: GPT-6 و DeepSeek خاموش، Qwen خاموش، gpt-oss-120b «متوسط» و gpt-oss-20b «کم». با «کم»، gpt-oss-120b فقط ۱ از ۴ موفق شد.',
      ].map((t) => h('li', {}, t)),
    );
    $('#sources').replaceChildren(...Object.values(D.sources).map((src) => h('li', {}, h('a', { href: src.url, target: '_blank', rel: 'noopener' }, src.label))));
  }

  // ------------------------------------------------------------ charts
  function renderCharts() {
    costChart();
    renderCalc();
  }

  // Horizontal bars, right-anchored for a right-to-left page; one hue, value at the tip.
  function costChart() {
    const box = $('#costChart');
    const W = Math.max(300, box.clientWidth);
    const narrow = W < 560;
    const items = [...D.paths].sort((a, b) => b.toman - a.toman);
    const max = items[0].toman;
    const rowH = narrow ? 52 : 40;
    const labelW = narrow ? 0 : 180;
    const valueRoom = 128;
    const x0 = W - labelW - (narrow ? 0 : 12);
    const plotW = x0 - valueRoom;
    const H = items.length * rowH + 8;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'هزینهٔ هر گفتگوی کامل برای هر مسیر' });
    svg.append(s('line', { x1: x0, x2: x0, y1: 0, y2: H - 4, class: 'axisline' }));
    $('#costLegend').replaceChildren(h('span', {}, h('i', { style: 'background:var(--s1)' }), 'هزینهٔ اندازه‌گیری‌شدهٔ هر گفتگو'));
    items.forEach((p, i) => {
      const y = i * rowH + 4;
      const barY = narrow ? y + 26 : y + 12;
      const bh = 14;
      const len = max ? (p.toman / max) * plotW : 0;
      const g = s('g', { class: 'row' });
      // The name stays alone on its line so Latin and Persian never mix in one SVG text.
      const label = p.name;
      const kindLine = `${KIND[p.kind]}${p.pass < 4 ? `، ${fa(p.pass)} از ۴ کار` : ''}`;
      g.append(t(W - 2, narrow ? y + 14 : barY + 11, label, 'right', 'lbl'));
      if (!narrow) g.append(t(W - 2, barY + 27, kindLine, 'right'));
      const color = p.kind === 'none' ? 'var(--neutral)' : 'var(--s1)';
      if (len >= 6) {
        const r = 4;
        const left = x0 - len;
        g.append(s('path', { class: 'bar', fill: color, d: `M${x0},${barY} H${left + r} Q${left},${barY} ${left},${barY + r} V${barY + bh - r} Q${left},${barY + bh} ${left + r},${barY + bh} H${x0} Z` }));
      } else if (len > 0) {
        g.append(s('rect', { class: 'bar', fill: color, x: x0 - len, y: barY, width: len, height: bh }));
      }
      g.append(t(x0 - len - 6, barY + 11, toman(p.toman), 'right', 'val'));
      const hit = s('rect', { class: 'hit', x: 0, y, width: W, height: rowH, tabindex: 0, 'aria-label': `${label}: ${toman(p.toman)}` });
      const html = () => `<b>${p.name}</b>${row('نوع', KIND[p.kind])}${row('هزینهٔ هر گفتگو', toman(p.toman))}${row('چهار کار', `${fa(p.pass)} از ۴`)}${p.calls ? row('فراخوانی مدل', fa(p.calls)) + row('توکن ورودی', `${fa(p.inputTokens)} (${fa(p.cachedTokens)} از کش)`) + row('توکن خروجی', fa(p.outputTokens)) : ''}${row('زمان کل', `${fa(p.seconds)} ثانیه`)}`;
      hit.addEventListener('mousemove', (e) => showTip(html(), e.clientX, e.clientY));
      hit.addEventListener('mouseleave', hideTip);
      hit.addEventListener('focus', () => { const b = hit.getBoundingClientRect(); showTip(html(), b.left + b.width / 2, b.top); });
      hit.addEventListener('blur', hideTip);
      g.prepend(hit);
      svg.append(g);
    });
    box.replaceChildren(svg);
  }

  // Monthly cost for Liara as a function of users: three API lines and a stepped self-host line.
  function series() {
    const qwen = D.selfHost.models.find((m) => m.id === 'qwen3.6-35b-a3b');
    const capLow = qwen.cap.perMonth[0];
    const api = (id, color) => ({ id, name: `API: ${D.byId[id].name}`, short: D.byId[id].name, color, cost: (conv) => conv * D.byId[id].toman });
    return [
      api('gpt-6-sol', 'var(--s1)'),
      api('gpt-6-luna', 'var(--s2)'),
      api('deepseek-v4-flash', 'var(--s3)'),
      { id: 'self', name: 'سرور خودی: Qwen روی RTX 4090', short: 'سرور خودی', color: 'var(--s4)', step: true, cards: (conv) => Math.max(1, Math.ceil(conv / capLow)), cost: (conv) => (conv > 0 ? Math.max(1, Math.ceil(conv / capLow)) * qwen.cap.rent : 0) },
    ];
  }

  function renderCalc() {
    const users = Number($('#users').value);
    const perUser = Number($('#perUser').value);
    $('#usersOut').textContent = `${fa(users)} کاربر`;
    const conv = users * perUser;
    const list = series();
    const best = list.reduce((a, b) => (b.cost(conv) < a.cost(conv) ? b : a));
    $('#calcTiles').replaceChildren(...list.map((sr) => h('div', { class: `tile ${sr === best ? 'best' : ''}` },
      h('span', { class: 'lbl' }, h('i', { class: 'key', style: `background:${sr.color}` }), sr.name),
      h('span', { class: 'val' }, million(sr.cost(conv)), h('small', {}, 'تومان در ماه')),
      h('span', { class: 'note' }, sr.step ? `${fa(sr.cards(conv))} کارت گرافیک برای ${fa(conv)} گفتگو` : `${fa(conv)} گفتگو × ${toman(D.byId[sr.id].toman)}`))));
    $('#lineLegend').replaceChildren(...list.map((sr) => h('span', {}, h('i', { class: 'line', style: `background:${sr.color}` }), sr.name)));
    const qwen = D.selfHost.models.find((m) => m.id === 'qwen3.6-35b-a3b');
    $('#calcAssume').textContent = `فرض‌ها: هزینهٔ هر گفتگو همان عدد اندازه‌گیری‌شده است. هر کارت RTX 4090 با Qwen تا ${fa(Math.floor(qwen.cap.perMonth[0] / 100) * 100)} گفتگو در ماه حساب شده (کف تخمین، برای اطمینان) و اجاره‌اش ${million(qwen.cap.rent)} تومان. حالت قواعد همیشه ۰ تومان است ولی فقط درخواست‌های مشخص را می‌فهمد.`;
    lineChart(list, users, perUser);
  }
  $('#users').addEventListener('input', () => D && renderCalc());
  $('#perUser').addEventListener('change', () => D && renderCalc());

  // Clean tick step (1, 2, 2.5 or 5 times a power of ten) for about four gridlines.
  function niceStep(max) {
    const raw = max / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  function lineChart(list, U, perUser) {
    const box = $('#lineChart');
    const W = Math.max(300, box.clientWidth);
    const narrow = W < 560;
    const m = { l: 74, r: narrow ? 14 : 132, t: 30, b: 42 };
    const H = narrow ? 280 : 340;
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const top = Math.max(...list.map((sr) => sr.cost(U * perUser)));
    const step = niceStep(top);
    const ticks = Math.ceil(top / step);
    const maxY = ticks * step;
    const X = (u) => m.l + (u / U) * pw;
    const Y = (c) => m.t + ph - (c / maxY) * ph;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'هزینهٔ ماهانه بر حسب تعداد کاربر' });
    // Recessive grid and axes; the numeric axis runs left to right like most charts.
    for (let i = 0; i <= ticks; i++) {
      const v = step * i;
      svg.append(s('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: i ? 'gridline' : 'axisline' }));
      svg.append(t(m.l - 8, Y(v) + 4, million(v), 'right'));
    }
    for (let i = 0; i <= 4; i++) {
      const u = (U / 4) * i;
      svg.append(t(X(u), m.t + ph + 18, fa(Math.round(u)), 'middle'));
    }
    svg.append(t(m.l + pw / 2, H - 4, 'تعداد کاربر', 'middle'));
    svg.append(t(m.l - 8, 12, 'تومان در ماه', 'right'));

    const steps = 120;
    for (const sr of list) {
      let d = '';
      if (sr.step) {
        // Flat while one more card is not needed, then a jump: draw it as a true step.
        let prevC = null;
        for (let i = 0; i <= steps; i++) {
          const u = (U / steps) * i;
          const c = sr.cost(u * perUser);
          if (prevC === null) d += `M${X(u)},${Y(c)}`;
          else if (c !== prevC) d += `H${X(u)}V${Y(c)}`;
          prevC = c;
        }
        d += `H${X(U)}`;
      } else {
        d = `M${X(0)},${Y(0)}L${X(U)},${Y(sr.cost(U * perUser))}`;
      }
      svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    // Direct end labels, nudged apart so they never overlap (the legend stays as the backup).
    if (!narrow) {
      const ends = list.map((sr) => ({ sr, y: Y(sr.cost(U * perUser)) })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 16) ends[i].y = ends[i - 1].y + 16;
      for (const e of ends) {
        svg.append(s('circle', { cx: X(U), cy: Y(e.sr.cost(U * perUser)), r: 4, fill: e.sr.color, class: 'dot' }));
        svg.append(t(X(U) + 10, e.y + 4, e.sr.short, 'left', 'lbl'));
      }
    }
    // Crosshair with a tooltip of every series at the hovered user count.
    const cross = s('line', { y1: m.t, y2: m.t + ph, class: 'cross', visibility: 'hidden' });
    const dots = list.map((sr) => s('circle', { r: 4, fill: sr.color, class: 'dot', visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const overlay = s('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
    const move = (clientX, clientY) => {
      const b = svg.getBoundingClientRect();
      const px = ((clientX - b.left) / b.width) * W;
      const u = Math.max(0, Math.min(U, ((px - m.l) / pw) * U));
      const conv = u * perUser;
      cross.setAttribute('x1', X(u));
      cross.setAttribute('x2', X(u));
      cross.setAttribute('visibility', 'visible');
      list.forEach((sr, i) => { dots[i].setAttribute('cx', X(u)); dots[i].setAttribute('cy', Y(sr.cost(conv))); dots[i].setAttribute('visibility', 'visible'); });
      const rows = [...list].sort((a, b) => b.cost(conv) - a.cost(conv)).map((sr) => row(sr.name, `${million(sr.cost(conv))} تومان`, sr.color)).join('');
      showTip(`<b>${fa(Math.round(u))} کاربر، ${fa(Math.round(conv))} گفتگو در ماه</b>${rows}`, clientX, clientY);
    };
    const leave = () => { hideTip(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); };
    overlay.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    overlay.addEventListener('mouseleave', leave);
    overlay.addEventListener('touchstart', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    overlay.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    overlay.addEventListener('touchend', leave);
    svg.append(overlay);
    box.replaceChildren(svg);
  }
})();
