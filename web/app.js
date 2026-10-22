/* Liara Copilot UI: chat + approval cards + live status. Plain JS, no build step. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
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
  const faNum = (n, d = 0) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '-' : Number(n).toLocaleString('fa-IR', { maximumFractionDigits: d }));
  const toman = (n) => (n === null || n === undefined ? '-' : `${faNum(Math.round(n))} تومان`);
  const time = (t) => new Date(t).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { breaks: true }));

  // Line icons (24px grid, drawn with the text colour) instead of emoji, so the UI reads like a
  // product and matches the console it would live in.
  const PATHS = {
    sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4M22 5h-4"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="11" cy="11" r="3"/><path d="m16 16-2.5-2.5"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
    pulse: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    bot: '<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4M8 16h.01M16 16h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    upload: '<path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24"/><path d="M12 12v9M16 16l-4-4-4 4"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    arrowUpCircle: '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 16V8"/>',
    power: '<path d="M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    play: '<path d="M6 4l14 8-14 8z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4M12 16h.01"/>',
    stethoscope: '<path d="M11 2v2M5 2v2M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    gauge: '<path d="m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0"/>',
    package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
    chart: '<path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    stop: '<path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z"/><path d="M9 9h6v6H9z"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    plus: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>',
  };
  const icon = (name, cls = '') => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', `ic ${cls}`.trim());
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = PATHS[name] || PATHS.sparkles;
    return s;
  };
  // A small tinted square with an icon, at the start of every card title.
  const tile = (name, tone = 'accent') => h('span', { class: `itile ${tone}` }, icon(name));
  const ICONS = {
    get_account_overview: 'wallet', list_plans: 'list', analyze_project: 'scan', get_app_status: 'server', get_logs: 'file', get_metrics: 'activity', http_check: 'globe',
    investigate_incident: 'stethoscope', verify_recovery: 'checkCircle', search_project_code: 'search', read_project_file: 'code', handoff_to_coding_agent: 'bot', get_domain_guide: 'link',
    deploy_new_app: 'rocket', deploy_new_version: 'upload', fix_code: 'wrench', set_env_vars: 'key', restart_app: 'refresh', rollback_release: 'undo', change_plan: 'arrowUpCircle', stop_app: 'power', start_app: 'play', add_domain: 'link', create_rule: 'cog', list_rules: 'cog', disable_rule: 'pause',
  };
  const IMPACT_ICON = { cost: 'coins', downtime: 'clock', restart: 'refresh', reversible: 'undo', security: 'lock', note: 'info' };

  // ------------------------------------------------------------ session
  let sid = localStorage.getItem('lc_session');
  if (!sid) {
    sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('lc_session', sid);
  }
  let lastSeq = 0;
  let es = null;
  let busy = false;
  const bubbles = new Map();
  const acts = new Map();
  const approvals = new Map();
  const messages = $('#messages');

  const api = async (path, opts = {}) => {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401) {
      $('#login').classList.remove('hidden');
      throw new Error('auth');
    }
    return res.json();
  };

  // Follow new content unless the user scrolled up to read something.
  let stick = true;
  messages.addEventListener('scroll', () => { stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120; });
  const scrollDown = () => {
    if (stick) messages.scrollTop = messages.scrollHeight;
  };
  const add = (el) => {
    $('#welcome')?.classList.add('hidden');
    messages.append(el);
    scrollDown();
    return el;
  };

  function setBusy(b) {
    busy = b;
    $('#send').disabled = b;
    $('#send').textContent = b ? 'در حال کار…' : 'ارسال';
  }

  function connect() {
    if (es) es.close();
    es = new EventSource(`/api/session/${sid}/events?after=${lastSeq}`);
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      if (ev.seq <= lastSeq) return;
      lastSeq = ev.seq;
      try { handle(ev); } catch (e) { console.error(e, ev); }
    };
    es.onerror = () => {
      es.close();
      setTimeout(connect, 2000);
    };
  }

  // ------------------------------------------------------------ event handling
  function handle(ev) {
    switch (ev.type) {
      case 'user':
        setBusy(true);
        add(h('div', { class: 'msg user' }, ev.text));
        break;
      case 'assistant_start': {
        const el = add(h('div', { class: 'msg assistant typing' }));
        bubbles.set(ev.msgId, { el, text: '', raf: 0 });
        break;
      }
      case 'delta': {
        const b = bubbles.get(ev.msgId);
        if (!b) break;
        b.text += ev.text;
        if (!b.raf) b.raf = requestAnimationFrame(() => { b.el.innerHTML = md(b.text); b.raf = 0; scrollDown(); });
        break;
      }
      case 'assistant_end': {
        const b = bubbles.get(ev.msgId);
        if (!b) break;
        if (b.raf) cancelAnimationFrame(b.raf);
        b.el.classList.remove('typing');
        if (!b.text.trim()) b.el.remove();
        else b.el.innerHTML = md(b.text);
        break;
      }
      case 'tool_start':
        actRow(ev.callId, ev.tool, ev.labelFa, ev.risk === 'auto' ? 'auto' : 'approved');
        break;
      case 'tool_progress':
        actProgress(ev);
        break;
      case 'tool_end':
        actEnd(ev);
        break;
      case 'approval':
        renderApproval(ev);
        break;
      case 'approval_resolved':
        resolveApprovalUI(ev.id, ev.action);
        break;
      case 'error':
        add(h('div', { class: 'msg error' }, ev.message));
        break;
      case 'turn_end':
        setBusy(false);
        for (const b of bubbles.values()) b.el.classList.remove('typing');
        refreshStatus();
        break;
      case 'llm_status': {
        const c = $('#modelChip');
        if (!ev.available) {
          c.textContent = 'حالت قواعد: مدل زبانی در دسترس نیست';
          c.className = 'chip sim';
          c.title = ev.reason || '';
        } else if (ev.provider) {
          c.textContent = modelLabel(ev.model, ev.provider) + (ev.fallback ? (ev.budget ? ' (اعتبار BoxAPI تمام شده)' : ' (پشتیبان)') : '');
          c.className = `chip ${ev.fallback ? 'sim' : 'muted'}`;
          c.title = ev.reason || '';
        }
        break;
      }
      case 'refresh':
        refreshStatus(true);
        break;
      case 'alert':
        showAlert(ev.alert);
        break;
      case 'audit':
        prependAudit(ev.entry);
        break;
      case 'kill_switch':
        setKill(ev.killSwitch);
        break;
      case 'security':
        add(h('div', { class: 'card security' },
          h('h4', {}, tile('shieldAlert', 'bad'), 'تلاش برای تزریق دستور شناسایی شد'),
          h('div', {}, `در ${ev.app ? `لاگ‌ها یا فایل‌های ${ev.app}` : 'متن خوانده‌شده'} متنی هست که سعی می‌کند به هوش مصنوعی دستور بدهد. کوپایلت این متن را فقط داده حساب کرد؛ هیچ ابزاری به خاطر آن اجرا نمی‌شود و هر تغییری همچنان کارت تأیید شما را لازم دارد.`),
          h('pre', {}, ev.samples.join('\n'))));
        break;
      case 'rule':
        renderRule(ev);
        break;
      case 'usage': {
        // Running model cost of this conversation (the audit tab has one row per turn).
        const u = ev.session;
        const c = $('#costChip');
        c.textContent = `هزینهٔ این گفتگو: حدود ${toman(u.costUSD * ev.usdToman)}`;
        c.title = `${faNum(u.calls)} فراخوانی مدل، ${faNum(u.promptTokens)} توکن ورودی (${faNum(u.cachedTokens)} از کش) و ${faNum(u.completionTokens)} توکن خروجی، معادل ${faNum(u.costUSD, 3)} دلار`;
        c.classList.remove('hidden');
        break;
      }
      case 'reset':
        messages.innerHTML = '';
        messages.append(welcomeClone);
        welcomeClone.classList.remove('hidden');
        $('#costChip').classList.add('hidden');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ activity rows
  // Read-only steps in a row fold into one quiet line ("۴ بررسی خودکار انجام شد"), opened on a
  // click; steps that change something (deploy, fix) keep their own row with live progress.
  let group = null;
  function groupFor() {
    if (group && messages.lastElementChild === group.el) return group;
    const head = h('button', { class: 'group-head', type: 'button' });
    const list = h('div', { class: 'group-list' });
    const el = h('div', { class: 'group' }, head, list);
    head.addEventListener('click', () => el.classList.toggle('open'));
    add(el);
    group = { el, head, list, acts: [] };
    return group;
  }
  function paintGroup(g) {
    const running = g.acts.filter((a) => !a.done);
    const failed = g.acts.filter((a) => a.done && !a.ok).length;
    const secs = g.acts.reduce((s, a) => s + (a.ms || 0), 0) / 1000;
    // replaceChildren() would print a null as the text "null", so leave the optional parts out.
    g.head.replaceChildren(...[
      running.length ? h('span', { class: 'spin' }) : h('span', { class: failed ? 'bad-ico' : 'ok-ico' }, icon(failed ? 'x' : 'check')),
      h('span', {}, running.length ? `در حال ${running.at(-1).label}…` : `${faNum(g.acts.length)} بررسی خودکار انجام شد${failed ? `، ${faNum(failed)} ناموفق` : ''}`),
      h('span', { class: 'g-icons' }, ...g.acts.map((a) => icon(ICONS[a.tool] || 'cog'))),
      !running.length && secs >= 0.1 ? h('span', { class: 'meta' }, `${faNum(secs, 1)} ثانیه`) : null,
      icon('chevron', 'chev'),
    ].filter(Boolean));
  }

  function actRow(callId, tool, label, kind) {
    let a = acts.get(callId);
    if (a) return a;
    const status = h('span', { class: 'spin' });
    const meta = h('span', { class: 'meta' });
    const body = h('div', { class: 'body' });
    const steps = h('ul', { class: 'steps' });
    body.append(steps);
    const el = h('div', { class: 'act' },
      h('div', { class: 'head', onclick: () => el.classList.toggle('open') }, status, icon(ICONS[tool] || 'cog', 'act-ic'), h('span', { class: 'label' }, label || tool),
        h('span', { class: `badge ${kind}` }, kind === 'auto' ? 'خودکار' : 'با تأیید شما'), meta),
      body);
    a = { el, status, meta, steps, body, stepEls: new Map(), log: null, tool, label: label || tool };
    if (kind === 'auto') {
      a.group = groupFor();
      a.group.acts.push(a);
      a.group.list.append(el);
      paintGroup(a.group);
      scrollDown();
    } else add(el);
    acts.set(callId, a);
    return a;
  }

  function actProgress(ev) {
    const a = actRow(ev.callId, ev.tool, '', 'approved');
    a.el.classList.add('open');
    if (ev.status === 'log') {
      if (!a.log) { a.log = h('div', { class: 'buildlog' }); a.body.append(a.log); }
      a.log.textContent += ev.lines.join('\n') + '\n';
      a.log.scrollTop = a.log.scrollHeight;
      return;
    }
    let li = a.stepEls.get(ev.step);
    const ico = ev.status === 'done' ? h('span', { class: 'ok-ico' }, icon('check')) : ev.status === 'failed' ? h('span', { class: 'bad-ico' }, icon('x')) : h('span', { class: 'spin' });
    const STEP_FA = { balance: 'موجودی', network: 'شبکهٔ خصوصی', create: 'ساخت اپ', envs: 'متغیرها', archive: 'فشرده‌سازی', upload: 'آپلود', release: 'ریلیز', build: 'بیلد و استقرار', probe: 'تست زنده', wait: 'بالا آمدن اپ', restart: 'ری‌استارت', resize: 'تغییر پلن', scale: 'روشن/خاموش', switch: 'جابه‌جایی نسخه' };
    const content = [ico, h('span', {}, STEP_FA[ev.step] || ev.step), h('span', { class: 'd' }, ev.detail || '')];
    if (!li) {
      li = h('li', {}, ...content);
      a.stepEls.set(ev.step, li);
      a.steps.append(li);
    } else {
      li.replaceChildren(...content);
    }
    scrollDown();
  }

  function actEnd(ev) {
    const a = actRow(ev.callId, ev.tool, ev.labelFa, 'auto');
    a.status.replaceWith(a.status = ev.ok ? h('span', { class: 'ok-ico' }, icon('check')) : h('span', { class: 'bad-ico' }, icon('x')));
    a.meta.textContent = ev.ms ? `${faNum(ev.ms / 1000, 1)} ثانیه` : '';
    Object.assign(a, { done: true, ok: ev.ok, ms: ev.ms || 0 });
    if (a.group) paintGroup(a.group);
    if (ev.error) {
      a.body.append(h('div', { class: 'blocked' }, ev.error));
      a.el.classList.add('open');
      a.group?.el.classList.add('open');
    }
    if (ev.ui && ev.data) {
      const card = renderToolCard(ev.ui, ev.data);
      if (card) add(card);
    }
    if (!ev.error && a.tool && !['deploy_new_app', 'deploy_new_version', 'fix_code'].includes(a.tool)) setTimeout(() => a.el.classList.remove('open'), 1500);
  }

  // ------------------------------------------------------------ tool cards
  function renderToolCard(ui, d) {
    if (ui === 'analysis') return analysisCard(d);
    if (ui === 'diagnosis') return diagnosisCard(d);
    if (ui === 'verify') return verifyCard(d);
    if (ui === 'handoff') return handoffCard(d);
    if (ui === 'deploy') return deployCard(d);
    return null;
  }

  function analysisCard(d) {
    const r = d.recommendation || {};
    return h('div', { class: 'card' },
      h('h4', {}, tile('scan'), 'نتیجهٔ تحلیل پروژه', h('span', { class: 'badge' }, d.suggestedName)),
      h('dl', { class: 'kv' },
        h('dt', {}, 'نوع پروژه'), h('dd', {}, `${d.platform || 'نامشخص'} (${d.platformReason})`),
        h('dt', {}, 'پورت'), h('dd', {}, Number(d.port).toLocaleString('fa-IR', { useGrouping: false })),
        d.startCommand ? [h('dt', {}, 'دستور اجرا'), h('dd', {}, h('span', { class: 'pill' }, d.startCommand))] : null,
        h('dt', {}, 'حجم'), h('dd', {}, `${faNum(d.files)} فایل، ${d.sizeMB < 1 ? `${faNum(Math.max(1, d.sizeMB * 1024))} کیلوبایت` : `${faNum(d.sizeMB, 1)} مگابایت`}`),
        d.databases?.length ? [h('dt', {}, 'دیتابیس'), h('dd', {}, d.databases.join('، '))] : null,
        d.routes?.length ? [h('dt', {}, 'صفحه‌ها'), h('dd', {}, h('div', { class: 'pill-list' }, d.routes.map((x) => h('span', { class: 'pill' }, x))))] : null,
      ),
      d.envVars?.length ? h('div', {}, h('div', { class: 'small-muted' }, 'متغیرهای محیطی که کد می‌خواند:'),
        h('div', { class: 'pill-list' }, d.envVars.map((e) => h('span', { class: `pill ${/KEY|SECRET|TOKEN|PASS|URL/i.test(e.key) ? 'secret' : ''}`, title: e.files.join(', ') }, e.key)))) : null,
      ...(d.warnings || []).map((w) => h('div', { class: 'warnline' }, w)),
      r.planID ? h('div', { class: 'recommend' },
        h('b', {}, `پیشنهاد: پلن ${r.planID}`), ` (${faNum(r.cpu, 2)} هستهٔ CPU، ${faNum((r.ramGB || 0) * 1024)} مگابایت رم) با بستهٔ ${r.bundlePlanID}، حدود ${toman(r.monthlyToman)} در ماه`,
        h('div', { class: 'small-muted' }, (r.why || []).join('؛ '))) : null,
    );
  }

  function diagnosisCard(d) {
    const ev = d.evidence || {};
    const p = ev.probe || {};
    const succ = p.total ? Math.round((p.ok / p.total) * 100) : null;
    const memPct = ev.memory?.pctOfLimit;
    const stat = (n, l, cls) => h('div', { class: `stat ${cls || ''}` }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
    return h('div', { class: 'card' },
      h('h4', {}, tile('stethoscope'), 'عیب‌یابی', h('span', { class: 'badge' }, ev.app?.name), d.symptom ? h('span', { class: 'small-muted' }, `«${d.symptom}»`) : null),
      h('div', { class: 'sub' }, `منابع بررسی‌شده: وضعیت سرویس، ${faNum(ev.releases?.length)} ریلیز اخیر، ${faNum(ev.logs?.lines)} خط لاگ، ${faNum(ev.events?.total)} رویداد، نمودار CPU و رم، و ${faNum(p.total)} درخواست زنده.`),
      h('div', { class: 'stats' },
        stat(succ === null ? '-' : `${faNum(succ)}٪`, 'درخواست موفق', succ === 100 ? 'good' : succ >= 50 ? 'warn' : 'bad'),
        stat(p.p50ms ? `${faNum(p.p50ms)}ms` : (p.paths || []).some((x) => x.failures) ? 'تایم‌اوت' : '-', 'زمان پاسخ میانه', !p.p50ms || p.p50ms > 1500 ? 'bad' : p.p50ms > 600 ? 'warn' : 'good'),
        stat(faNum(ev.logs?.errors), 'خطا در لاگ', ev.logs?.errors ? 'bad' : 'good'),
        stat(memPct === null || memPct === undefined ? '-' : `${faNum(memPct)}٪`, `رم از ${faNum(ev.limits?.ramMB)}MB`, memPct >= 85 ? 'bad' : memPct >= 65 ? 'warn' : 'good'),
        ev.cpu?.maxPctOfPlan !== undefined && ev.cpu?.maxPctOfPlan !== null ? stat(`${faNum(ev.cpu.maxPctOfPlan)}٪`, 'بیشینهٔ CPU', ev.cpu.maxPctOfPlan >= 85 ? 'bad' : 'good') : null,
      ),
      h('div', { class: 'small-muted' }, 'علت‌های احتمالی، به ترتیب احتمال:'),
      (d.hypotheses || []).slice(0, 4).map((x) => h('div', { class: 'hyp' },
        h('div', { class: 'top' }, h('span', { class: 'rank' }, faNum(x.rank)), h('span', { class: 't' }, x.title), h('span', { class: 'conf' }, `${faNum(x.confidence)}٪`)),
        h('div', { class: 'bar' }, h('i', { style: `width:${x.confidence}%` })),
        h('ul', {}, (x.evidence || []).map((e) => h('li', {}, e))),
        x.fix?.fa ? h('div', { class: 'fix' }, `راه‌حل پیشنهادی: ${x.fix.fa}`) : null,
      )),
    );
  }

  function verifyCard(d) {
    const b = d.before || {};
    const a = d.after || {};
    const row = (l, x, y) => h('tr', {}, h('td', {}, l), h('td', { class: 'before' }, x), h('td', {}, y));
    return h('div', { class: 'card' },
      h('h4', {}, tile('checkCircle', 'ok'), 'بررسی نتیجه', h('span', { class: `verdict ${d.verdict}` }, d.verdictFa)),
      h('table', { class: 'changes' },
        h('tr', {}, h('th', {}, 'شاخص'), h('th', {}, 'قبل'), h('th', {}, 'بعد')),
        row('درخواست موفق', b.successPct !== undefined && b.successPct !== null ? `${faNum(b.successPct)}٪` : '-', `${faNum(a.successPct)}٪`),
        row('زمان پاسخ میانه', b.p50ms ? `${faNum(b.p50ms)}ms` : b.successPct === 0 ? 'تایم‌اوت یا خطا' : '-', a.p50ms ? `${faNum(a.p50ms)}ms` : '-'),
        row('خطا در لاگ', faNum(b.errorsInLogs), a.errorsInLogsSinceFix === null ? '-' : `${faNum(a.errorsInLogsSinceFix)} (بعد از اصلاح)`),
        row('مصرف رم', b.memoryMB ? `${faNum(b.memoryMB)}MB` : '-', a.memoryMB ? `${faNum(a.memoryMB)}MB` : '-'),
      ),
      d.switchover ? h('div', { class: 'small-muted' }, d.switchover.noteFa) : null,
    );
  }

  function handoffCard(d) {
    const btn = h('button', { class: 'ghost small', onclick: async () => { await navigator.clipboard.writeText(d.markdown); btn.textContent = 'کپی شد'; } }, 'کپی برای ایجنت کدنویس');
    return h('div', { class: 'card handoff' },
      h('h4', {}, tile('bot'), 'پیام برای ایجنت کدنویس (Claude Code، Cursor، Copilot)'),
      h('div', { class: 'sub' }, `ذخیره شد: ${d.savedTo}. کافی است به ایجنت کدنویستان بگویید این فایل را بخواند و اجرا کند.`),
      h('pre', {}, d.markdown),
      h('div', { class: 'actions' }, btn),
    );
  }

  function deployCard(d) {
    if (!d.ok) {
      return h('div', { class: 'card' }, h('h4', {}, tile('alert', 'warn'), 'انتشار کامل نشد'),
        d.error === 'insufficient_balance' ? h('div', { class: 'blocked' }, `موجودی ${toman(d.balanceToman)} است؛ برای هر ساعت ${toman(d.needPerHourToman)} لازم است.`) : null,
        d.failReason ? h('div', { class: 'blocked' }, d.failReason) : null,
        d.error && d.error !== 'insufficient_balance' ? h('div', { class: 'blocked' }, d.error) : null,
        d.note ? h('div', { class: 'small-muted' }, d.note) : null,
        d.buildTail?.length ? h('div', { class: 'buildlog' }, d.buildTail.join('\n')) : null);
    }
    const p = d.probe;
    return h('div', { class: 'card' },
      h('h4', {}, tile(d.files ? 'wrench' : 'rocket', 'ok'), d.files ? 'کد اصلاح و منتشر شد' : 'سایت زنده است'),
      d.files ? h('div', { class: 'small-muted' }, `${faNum(d.changedLines)} خط در ${d.files.join('، ')} عوض شد؛ پشتیبان فایل‌های اصلی نگه داشته شد.`) : null,
      d.url ? h('div', {}, h('a', { href: d.url, target: '_blank', rel: 'noopener', style: 'direction:ltr;font-weight:700' }, d.url)) : null,
      p ? h('div', { class: 'small-muted' }, `تست زنده: ${faNum(p.ok)} از ${faNum(p.total)} درخواست موفق، زمان پاسخ میانه ${faNum(p.p50ms)} میلی‌ثانیه`) : null,
      d.envsSet?.length ? h('div', { class: 'small-muted' }, `متغیرهای ثبت‌شده: ${d.envsSet.join('، ')} (مقادیر مخفی)`) : null,
    );
  }

  // ------------------------------------------------------------ approval cards
  function renderApproval(ev) {
    const c = ev.card || {};
    const inputs = new Map();
    const approve = h('button', { class: ev.risk === 'high' ? 'danger' : 'primary' }, 'تأیید و اجرا');
    const reject = h('button', { class: 'ghost' }, 'رد');
    let confirmBox = null;
    const validate = () => {
      const missing = [...inputs.values()].some(({ input, required }) => required && !input.value.trim());
      approve.disabled = Boolean(c.blocked) || missing || (confirmBox && !confirmBox.checked);
    };
    const inputEls = (c.inputs || []).map((i) => {
      const input = h('input', { type: i.secret ? 'password' : 'text', dir: 'auto', class: i.secret ? '' : 'plain', value: i.prefill || '', placeholder: i.secret ? 'مقدار را اینجا وارد کنید' : '', autocomplete: 'off', oninput: validate });
      inputs.set(i.key, { input, required: i.required });
      return h('label', {}, h('span', { class: 'k' }, `${i.key}${i.required ? ' *' : ''}`), input, i.hint ? h('span', { class: 'hint' }, i.hint) : null);
    });
    if (ev.risk === 'high' && !c.blocked) {
      confirmBox = h('input', { type: 'checkbox', onchange: validate });
    }
    const send = async (action) => {
      const values = {};
      for (const [k, { input }] of inputs) values[k] = input.value;
      approve.disabled = true;
      reject.disabled = true;
      await api(`/api/session/${sid}/approvals/${ev.id}`, { method: 'POST', body: { action, inputs: action === 'approve' ? values : {} } });
      for (const { input } of inputs.values()) input.value = input.type === 'password' ? '••••••' : input.value;
    };
    approve.addEventListener('click', () => send('approve'));
    reject.addEventListener('click', () => send('reject'));
    const el = h('div', { class: `card approval r-${ev.risk}` },
      h('h4', {}, tile(ICONS[ev.tool] || 'shield', `r-${ev.risk}`), h('span', { class: 't-stack' }, h('span', { class: 'kick' }, 'اقدام پیشنهادی · نیاز به تأیید شما'), h('span', {}, c.titleFa || ev.labelFa)), h('span', { class: `badge ${ev.risk}` }, `ریسک ${ev.riskFa}`)),
      c.summaryFa ? h('div', {}, c.summaryFa) : null,
      c.reasonFa ? h('div', { class: 'why' }, h('b', {}, 'چرا؟ '), c.reasonFa) : null,
      c.changes?.length ? h('table', { class: 'changes' },
        h('tr', {}, h('th', {}, 'چه چیزی'), h('th', {}, 'الان'), h('th', {}, 'بعد از تأیید')),
        c.changes.map((x) => h('tr', {}, h('td', {}, x.label), h('td', { class: x.before ? 'before' : '' }, x.before || '-'), h('td', {}, x.after || '-')))) : null,
      c.diff?.length ? h('div', { class: 'diff' }, c.diff.map((d) => h('div', { class: 'hunk' },
        h('div', { class: 'hunk-h' }, `${d.file}:${d.line}`),
        h('pre', {}, d.before.map((l) => h('span', { class: 'del' }, `- ${l}`)), d.after.map((l) => h('span', { class: 'add' }, `+ ${l}`)))))) : null,
      c.impacts?.length ? h('ul', { class: 'impacts' }, c.impacts.map((x) => h('li', {}, icon(IMPACT_ICON[x.kind] || 'info'), h('span', {}, x.text)))) : null,
      c.steps?.length ? h('details', {}, h('summary', { class: 'small-muted' }, 'مراحل اجرا'), h('ol', { class: 'ordered' }, c.steps.map((s) => h('li', {}, s)))) : null,
      inputEls.length ? h('div', { class: 'inputs' }, inputEls) : null,
      c.blocked ? h('div', { class: 'blocked' }, c.blocked.reasonFa) : null,
      h('div', { class: 'actions' },
        c.blocked?.actionUrl ? h('a', { class: 'primary', href: c.blocked.actionUrl, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, c.blocked.actionLabel) : null,
        c.blocked?.retryLabel ? h('button', { class: 'ghost', onclick: () => send('retry') }, c.blocked.retryLabel) : null,
        c.blocked ? null : approve,
        reject,
        confirmBox ? h('label', { class: 'confirmrow' }, confirmBox, 'می‌دانم این کار هزینه یا قطعی دارد') : null,
      ),
      h('div', { class: 'resolved hidden' }),
    );
    approvals.set(ev.id, el);
    validate();
    add(el);
  }

  function resolveApprovalUI(id, action) {
    const el = approvals.get(id);
    if (!el) return;
    el.querySelectorAll('button, input').forEach((b) => { b.disabled = true; });
    const r = el.querySelector('.resolved');
    r.classList.remove('hidden');
    r.textContent = action === 'approve' ? '✓ تأیید شد و اجرا شد (نتیجه در ردیف بعدی)' : action === 'retry' ? '↻ دوباره بررسی شد' : '✗ رد شد؛ هیچ تغییری انجام نشد.';
    el.querySelector('.actions')?.classList.add('hidden');
  }

  // ------------------------------------------------------------ status panel
  let statusTimer = null;
  // Per app: the last errors (refreshed with the panel) and the usage history of the chosen range.
  const metricCache = new Map();
  const RANGES = [[5, '۵ دقیقه'], [30, '۳۰ دقیقه'], [360, '۶ ساعت'], [1440, '۲۴ ساعت']];
  const rangeOf = new Map();
  const rangeFor = (name) => rangeOf.get(name) || 5;
  // A longer range changes slowly, so it is fetched less often.
  const seriesMaxAge = (minutes) => (minutes <= 5 ? 12000 : minutes <= 30 ? 30000 : 60000);
  const level = (pct) => (pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : 'ok');
  const svg = (w, hgt, cls, inner) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    el.setAttribute('class', cls);
    el.innerHTML = inner;
    return el;
  };

  // Ring gauge: the share of the plan in use, colored by how close it is to the cap.
  function gauge(label, pct, sub) {
    const R = 30;
    const C = 2 * Math.PI * R;
    const fill = (C * Math.min(1, Math.max(0, pct) / 100)).toFixed(1);
    return h('div', { class: `gauge ${level(pct)}` },
      svg(80, 80, 'ring', `<circle class="track" cx="40" cy="40" r="${R}"/>${pct > 0 ? `<circle class="val" cx="40" cy="40" r="${R}" stroke-dasharray="${fill} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/>` : ''}<text x="40" y="46">${faNum(pct)}٪</text>`),
      h('div', { class: 'g-label' }, label), h('div', { class: 'g-sub' }, sub));
  }

  // RAM and CPU over the chosen range, both as a share of the plan, so one axis fits both and the
  // dashed line is the cap. Time runs like the text: the past on the right, now on the left.
  function trendChart(a, m) {
    const minutes = rangeFor(a.name);
    const pills = h('div', { class: 'ranges' }, ...RANGES.map(([min, fa]) => h('button', { class: `range${min === minutes ? ' on' : ''}`, onclick: () => setRange(a.name, min) }, fa)));
    const span = (m?.minutes || minutes) * 60000;
    // Liara's clock can run a little ahead of this machine's: "now" is whichever is later, so the
    // newest point never falls off the left edge.
    const to = Math.max(Date.now(), m?.memory?.at(-1)?.t || 0, m?.cpu?.at(-1)?.t || 0);
    const from = to - span;
    const ram = (m?.memory || []).filter((p) => p.t >= from).map((p) => ({ t: p.t, v: (p.mb / a.ramLimitMB) * 100, hi: (p.hiMb / a.ramLimitMB) * 100, mb: p.mb, hiMb: p.hiMb }));
    const cpu = a.cpuLimit ? (m?.cpu || []).filter((p) => p.t >= from).map((p) => ({ t: p.t, v: (p.v / a.cpuLimit) * 100, hi: (p.hi / a.cpuLimit) * 100 })) : [];
    if (ram.length < 2 && cpu.length < 2) return h('div', { class: 'trend' }, h('div', { class: 'trend-head' }, h('span', {}, 'روند مصرف'), pills), h('div', { class: 'trend-empty' }, 'هنوز داده‌ای در این بازه نیست.'));
    const W = 300;
    const PW = 270;
    const top = 6;
    const PH = 110;
    const peak = Math.max(100, ...ram.map((p) => p.v), ...cpu.map((p) => p.v));
    const ymax = peak <= 100 ? 100 : Math.ceil(peak / 25) * 25;
    const x = (t) => PW * (1 - (t - from) / span);
    const y = (v) => top + PH - (Math.max(0, v) / ymax) * PH;
    // A stretch with no points (the app was off or restarting) is a gap, not a straight line.
    const segments = (pts) => {
      const steps = pts.slice(1).map((p, i) => p.t - pts[i].t).sort((p, q) => p - q);
      const gap = Math.max(90000, 3 * (steps[Math.floor(steps.length / 2)] || 0));
      const segs = [];
      pts.forEach((p, i) => { if (!i || p.t - pts[i - 1].t > gap) segs.push([]); segs.at(-1).push(p); });
      return segs;
    };
    // A soft curve through the points (Catmull-Rom as cubic Béziers), kept inside the plot.
    const inPlot = (v) => Math.min(top + PH, Math.max(top, v));
    const line = (seg) => {
      const P = seg.map((p) => [x(p.t), y(p.v)]);
      const f = (n) => n.toFixed(1);
      let d = `M${f(P[0][0])},${f(P[0][1])}`;
      for (let i = 0; i < P.length - 1; i++) {
        const [p0, p1, p2, p3] = [P[i - 1] || P[i], P[i], P[i + 1], P[i + 2] || P[i + 1]];
        d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(inPlot(p1[1] + (p2[1] - p0[1]) / 6))} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(inPlot(p2[1] - (p3[1] - p1[1]) / 6))} ${f(p2[0])},${f(p2[1])}`;
      }
      return d;
    };
    const area = (seg) => `${line(seg)} L${x(seg.at(-1).t).toFixed(1)},${y(0)} L${x(seg[0].t).toFixed(1)},${y(0)} Z`;
    const ramSegs = ram.length > 1 ? segments(ram) : [];
    const grid = [0, 50, 100].map((v) => `<line class="grid" x1="0" x2="${PW}" y1="${y(v)}" y2="${y(v)}"/><text class="ylab" x="${PW + 4}" y="${y(v) + 3.5}">${faNum(v)}٪</text>`).join('');
    const startLabel = minutes >= 60 ? `${faNum(minutes / 60)} ساعت پیش` : `${faNum(minutes)} دقیقه پیش`;
    const chart = svg(W, 136, 'trend-svg', `${grid}<line class="cap" x1="0" x2="${PW}" y1="${y(100)}" y2="${y(100)}"/>`
      + (ramSegs.length ? `<path class="ram-area" d="${ramSegs.map(area).join(' ')}"/><path class="ram" d="${ramSegs.map(line).join(' ')}"/>` : '')
      + (cpu.length > 1 ? `<path class="cpu" d="${segments(cpu).map(line).join(' ')}"/>` : '')
      + (ram.length > 1 && to - ram.at(-1).t < span / 10 ? `<circle class="now-dot" cx="${x(ram.at(-1).t).toFixed(1)}" cy="${y(ram.at(-1).v).toFixed(1)}" r="3.6"/>` : '')
      + `<line class="guide" x1="0" x2="0" y1="${top}" y2="${top + PH}" visibility="hidden"/>`
      + `<text class="xlab" x="${PW}" y="132" text-anchor="start">${startLabel}</text><text class="xlab" x="0" y="132" text-anchor="end">الان</text>`
      + `<rect class="hit" x="0" y="0" width="${PW}" height="${top + PH}"/>`);
    const tip = h('div', { class: 'trend-tip hidden' });
    const nearest = (pts, t) => pts.reduce((b, p) => (!b || Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), null);
    chart.addEventListener('mousemove', (e) => {
      const box = chart.getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      if (px > PW) return;
      const t = from + (1 - px / PW) * span;
      const r = nearest(ram, t);
      const c = nearest(cpu, t);
      const at = (r || c).t;
      if (Math.abs(at - t) > span / 20) { tip.classList.add('hidden'); return; }
      const guide = chart.querySelector('.guide');
      guide.setAttribute('x1', x(at));
      guide.setAttribute('x2', x(at));
      guide.setAttribute('visibility', 'visible');
      tip.replaceChildren(...[h('div', { class: 'tt' }, minutes > 30 ? new Date(at).toLocaleString('fa-IR', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : time(at)),
        r ? h('div', {}, h('i', { class: 'sw ram' }), `رم ${faNum(r.mb)}MB (${faNum(r.v)}٪)`, r.hiMb > r.mb ? h('span', { class: 'pk' }, ` · بیشینه ${faNum(r.hiMb)}MB`) : null) : null,
        c ? h('div', {}, h('i', { class: 'sw cpu' }), `CPU ${faNum(c.v)}٪`, c.hi > c.v + 1 ? h('span', { class: 'pk' }, ` · بیشینه ${faNum(c.hi)}٪`) : null) : null].filter(Boolean));
      tip.classList.remove('hidden');
      const left = (x(at) / W) * box.width;
      tip.style.left = left > box.width / 2 ? 'auto' : `${left + 10}px`;
      tip.style.right = left > box.width / 2 ? `${box.width - left + 10}px` : 'auto';
    });
    chart.addEventListener('mouseleave', () => { tip.classList.add('hidden'); chart.querySelector('.guide').setAttribute('visibility', 'hidden'); });
    return h('div', { class: 'trend' }, h('div', { class: 'trend-head' }, h('span', {}, 'روند مصرف'), pills), h('div', { class: 'trend-plot' }, chart, tip),
      h('div', { class: 'trend-legend' }, h('span', {}, h('i', { class: 'sw ram' }), 'رم'), cpu.length > 1 ? h('span', {}, h('i', { class: 'sw cpu' }), 'CPU') : null, h('span', {}, h('i', { class: 'sw cap' }), 'سقف پلن')));
  }

  async function setRange(name, minutes) {
    rangeOf.set(name, minutes);
    await loadMetrics(name, true);
    refreshStatus(false);
  }

  async function loadMetrics(name, withSeries) {
    const minutes = rangeFor(name);
    try {
      const [m, l] = await Promise.all([
        withSeries ? api(`/api/apps/${encodeURIComponent(name)}/metrics?minutes=${minutes}`) : null,
        api(`/api/apps/${encodeURIComponent(name)}/logs`),
      ]);
      const c = metricCache.get(name) || {};
      metricCache.set(name, { ...c, at: Date.now(), errors: (l.lines || []).filter((x) => x.err).slice(-3), ...(m ? { seriesAt: Date.now(), minutes: m.minutes || minutes, memory: m.memory || [], cpu: m.cpu || [] } : {}) });
    } catch { /* ignore */ }
  }

  // A standing rule fired: one card per run, updated from "running" to its result.
  const ruleCards = new Map();
  const RULE_STATUS = { running: ['در حال اجرا', 'medium'], done: ['انجام شد', 'ok'], error: ['خطا', 'error'], limit: ['سقف این ساعت پر شد', 'alert'], refused: ['اجرا نشد', 'error'] };
  function renderRule(ev) {
    const [stFa, stCls] = RULE_STATUS[ev.status] || [ev.status, ''];
    const hyps = ev.data?.hypotheses || [];
    const body = [
      h('h4', {}, tile('cog'), 'قانون خودکار', h('span', { class: `badge ${stCls}` }, stFa)),
      h('div', { class: 'sub' }, ev.ruleFa),
      h('div', {}, h('b', {}, 'چه دید: '), ev.readingFa),
      h('div', {}, h('b', {}, 'نتیجه: '), ev.resultFa),
      hyps.length ? h('ol', { class: 'rule-hyps' }, ...hyps.map((x) => h('li', {}, `${x.title} (${faNum(x.confidence)}٪): ${x.evidence}`))) : null,
      ev.status !== 'limit' && ev.status !== 'refused' ? h('div', { class: 'small-muted' }, `${faNum(ev.firedThisHour)} از ${faNum(ev.maxPerHour)} بار مجاز در این ساعت · ثبت در گزارش اقدامات`) : null,
      ev.status === 'done' && ev.action !== 'notify' ? h('div', { class: 'actions' }, h('button', { class: 'primary small', onclick: () => sendText(`قانون خودکار روی ${ev.app} اجرا شد («${ev.readingFa}»). علت اصلی را بررسی کن.`) }, 'بررسی کن')) : null,
    ];
    // A run moves from running to done or error on one card; a hold-back notice gets its own.
    const key = ['running', 'done', 'error'].includes(ev.status) ? `${ev.ruleId}:${ev.firedThisHour}` : `${ev.ruleId}:${ev.status}:${ev.seq}`;
    const old = ruleCards.get(key);
    if (old) old.replaceChildren(...body.filter(Boolean));
    else ruleCards.set(key, add(h('div', { class: 'card rule' }, ...body)));
    if (ev.status !== 'running') refreshStatus(true);
  }

  async function refreshStatus(force) {
    let s;
    try { s = await api('/api/status'); } catch { return; }
    const chip = $('#balanceChip');
    chip.textContent = s.balance === null ? 'موجودی: نامشخص' : `موجودی: ${toman(s.balance)}`;
    const box = $('#apps');
    const managed = s.apps.filter((a) => a.managed);
    await Promise.all(managed.map((a) => {
      const c = metricCache.get(a.name);
      const series = force || !c?.seriesAt || c.minutes !== rangeFor(a.name) || Date.now() - c.seriesAt > seriesMaxAge(rangeFor(a.name));
      return series || Date.now() - c.at > 12000 ? loadMetrics(a.name, series) : null;
    }));
    const cards = s.apps.map((a) => appCard(a));
    const rules = s.rules?.length ? h('div', { class: 'auto-rules' },
      h('div', { class: 'rules-h' }, icon('cog'), 'قانون‌های خودکار'),
      ...s.rules.map((r) => h('div', { class: 'rule-row' },
        h('div', {}, r.fa, h('div', { class: 'small-muted' }, r.lastFiredAt ? `آخرین اجرا ${time(r.lastFiredAt)} · ${faNum(r.firedLastHour)} بار در ساعت اخیر` : 'هنوز اجرا نشده')),
        h('button', { class: 'ghost small', title: 'این قانون دیگر اجرا نمی‌شود', onclick: async () => { await api(`/api/rules/${r.id}/disable`, { method: 'POST' }).catch(() => null); refreshStatus(true); } }, 'خاموش')))) : null;
    box.replaceChildren(
      h('div', { class: 'account' }, h('div', {}, h('div', { class: 'small-muted' }, `موجودی ${s.account || 'حساب لیارا'}`), h('div', { class: 'big' }, toman(s.balance))),
        h('div', { class: 'small-muted' }, s.mode === 'sim' ? 'حالت شبیه‌ساز محلی' : 'متصل به api.liara.ir', h('br'), `${faNum(s.apps.length)} سرویس`)),
      ...(rules ? [rules] : []),
      ...(cards.length ? cards : [h('div', { class: 'empty' }, 'هنوز سرویسی در حساب نیست. پروژه‌تان را بدهید تا اولین سرویس را بسازیم.')]),
    );
  }

  function appCard(a) {
    const hl = a.health?.level || (a.scale === 0 ? 'off' : 'unknown');
    const levelFa = { healthy: 'سالم', degraded: 'کند / پرمصرف', down: 'خطا', unknown: a.isDeployed ? 'در حال بررسی' : 'دیپلوی نشده', off: 'خاموش' }[hl];
    const m = metricCache.get(a.name);
    const memPct = a.memMB !== null && a.memMB !== undefined && a.ramLimitMB ? Math.round((a.memMB / a.ramLimitMB) * 100) : null;
    const cpuPct = a.cpu !== null && a.cpu !== undefined && a.cpuLimit ? Math.min(100, Math.round((a.cpu / a.cpuLimit) * 100)) : null;
    const lp = a.health?.lastProbe;
    return h('div', { class: 'app' },
      h('div', { class: 'row' }, h('span', { class: `dot ${hl}` }), h('span', { class: 'name' }, a.name), h('span', { class: `badge ${hl}` }, levelFa),
        a.managed ? h('span', { class: 'badge' }, 'مدیریت با کوپایلت') : h('span', { class: 'badge' }, 'فقط خواندنی')),
      h('div', { class: 'row small-muted' }, `${a.platform || ''} · ${a.planID || ''}`, a.lastRelease ? ` · ریلیز ${a.lastRelease.tag || ''} (${a.lastRelease.state})` : ''),
      a.isDeployed ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.url) : null,
      a.managed && memPct !== null ? h('div', { class: 'usage' },
        h('div', { class: 'gauges' }, gauge('رم', memPct, `${faNum(a.memMB)} از ${faNum(a.ramLimitMB)}MB`), cpuPct !== null ? gauge('CPU', cpuPct, `از ${faNum(a.cpuLimit, 2)} هسته`) : null),
        trendChart(a, m)) : null,
      lp ? h('div', { class: 'small-muted' }, `آخرین تست: ${lp.ok === lp.total ? 'موفق' : `${faNum(lp.total - lp.ok)} صفحه خطا`} · ${faNum(lp.p50ms)}ms · ${time(lp.t)}`) : null,
      m?.errors?.length ? h('div', { class: 'errs' }, m.errors.map((e) => e.line).join('\n')) : null,
    );
  }

  function showAlert(al) {
    const box = $('#alertBox');
    if (!al || al.level === 'healthy') {
      box.className = 'alert healthy';
      box.replaceChildren(h('span', { class: 'msg-a' }, `✓ ${al?.app || ''}: ${al?.fa || 'سالم'}`));
      setTimeout(() => box.classList.add('hidden'), 8000);
      refreshStatus(true);
      return;
    }
    box.className = `alert ${al.level}`;
    box.replaceChildren(
      icon(al.level === 'down' ? 'flame' : 'alert'),
      h('span', { class: 'msg-a' }, `ناظر سلامت: ${al.app}، ${al.fa}`),
      h('button', { class: 'primary small', onclick: () => { box.classList.add('hidden'); sendText(`ناظر سلامت هشدار داد: «${al.fa}» روی ${al.app}. بررسی کن علتش چیه.`); } }, 'بررسی کن'),
      h('button', { class: 'ghost small', onclick: () => box.classList.add('hidden') }, 'بعداً'),
    );
    refreshStatus(true);
  }

  // ------------------------------------------------------------ audit log
  let killOn = false;
  function setKill(ks) {
    killOn = Boolean(ks?.on);
    const b = $('#killBtn');
    b.classList.toggle('on', killOn);
    b.replaceChildren(icon(killOn ? 'play' : 'stop'), killOn ? 'فعال کردن دوباره' : 'توقف اضطراری');
    $('#killBox').classList.toggle('hidden', !killOn);
  }
  $('#killBtn').addEventListener('click', async () => {
    const turnOn = !killOn;
    if (turnOn && !confirm('توقف اضطراری: از این لحظه کوپایلت فقط می‌خواند و کارت‌های تأیید باز رد می‌شوند. ادامه؟')) return;
    const r = await api('/api/killswitch', { method: 'POST', body: { on: turnOn } }).catch(() => null);
    if (r?.killSwitch) setKill(r.killSwitch);
  });

  const KIND_FA = { security_alert: ['امنیتی', 'error'], kill_switch_on: ['توقف اضطراری', 'error'], kill_switch_off: ['فعال‌سازی دوباره', 'ok'], auto: ['خودکار', 'auto'], approved: ['تأییدشده', 'approved'], rejected: ['رد شد', 'rejected'], approval_requested: ['درخواست تأیید', 'medium'], alert: ['هشدار', 'alert'], refused: ['خارج از محدوده', 'error'], llm_usage: ['هزینهٔ مدل', 'auto'], rule_fired: ['قانون خودکار', 'auto'], rule_skipped: ['قانون: سقف پر شد', 'alert'], rule_disabled: ['قانون خاموش شد', 'ok'] };
  const ACTOR = { agent: 'sparkles', user: 'user', watcher: 'eye', rule: 'cog' };
  function auditRow(e) {
    const [k, cls] = KIND_FA[e.kind] || [e.kind, ''];
    return h('div', { class: 'aud' },
      h('div', { class: 'row' }, icon(ACTOR[e.actor] || 'info'), h('span', { class: `badge ${cls}` }, k), h('b', {}, e.summary || e.tool), e.app ? h('span', { class: 'small-muted' }, e.app) : null,
        e.status === 'error' ? h('span', { class: 'badge error' }, 'خطا') : null, h('span', { class: 'time' }, time(e.at))),
      e.durationMs ? h('div', { class: 's' }, `${e.tool} · ${faNum(e.durationMs / 1000, 1)} ثانیه`) : h('div', { class: 's' }, e.tool),
    );
  }
  function prependAudit(e) {
    $('#audit').prepend(auditRow(e));
  }
  async function loadAudit() {
    try {
      const list = await api('/api/audit');
      $('#audit').replaceChildren(...list.map(auditRow));
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ input
  async function sendText(text) {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await api(`/api/session/${sid}/chat`, { method: 'POST', body: { text } }).catch(() => null);
    if (!r?.ok) setBusy(false);
  }

  const input = $('#input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight)}px`; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#form').requestSubmit();
    }
  });
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value;
    input.value = '';
    input.style.height = 'auto';
    sendText(t);
  });
  $('#suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    input.value = b.dataset.text;
    input.focus();
    input.dispatchEvent(new Event('input'));
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $('#tab-status').classList.toggle('hidden', t.dataset.tab !== 'status');
    $('#tab-audit').classList.toggle('hidden', t.dataset.tab !== 'audit');
  }));
  $('#resetBtn').addEventListener('click', async () => {
    if (busy) return;
    await api(`/api/session/${sid}/reset`, { method: 'POST' });
  });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: $('#passcode').value }) });
    if (r.ok) { $('#login').classList.add('hidden'); boot(); }
  });

  // Icons for the header buttons and the suggestion chips (named in the HTML with data-icon).
  document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(icon(el.dataset.icon)));

  const welcomeClone = $('#welcome');

  const PROVIDERS = { boxapi: 'BoxAPI', openai: 'OpenAI' };
  const modelLabel = (model, provider) => `مدل: ${String(model || '').split('/').pop()} از ${PROVIDERS[provider] || provider}`;

  async function boot() {
    const cfg = await fetch('/api/config').then((r) => r.json());
    const mc = $('#modeChip');
    mc.textContent = cfg.liaraMode === 'sim' ? 'شبیه‌ساز لیارا (محلی)' : 'متصل به API واقعی لیارا';
    mc.className = `chip ${cfg.liaraMode === 'sim' ? 'sim' : 'real'}`;
    $('#modelChip').textContent = modelLabel(cfg.llmModel, cfg.llmProvider);
    $('#modelChip').title = cfg.llmChain.length > 1 ? `پشتیبان: ${cfg.llmChain.slice(1).join('، ')}` : '';
    if (cfg.llmAvailable === false) handle({ type: 'llm_status', available: false, reason: cfg.llmReason });
    else if (cfg.llmFallback && cfg.llmActive) {
      const model = (cfg.llmChain.find((c) => c.startsWith(`${cfg.llmActive}:`)) || '').split(':').slice(1).join(':');
      handle({ type: 'llm_status', available: true, provider: cfg.llmActive, model, fallback: true, budget: cfg.llmFallback.budget, reason: cfg.llmFallback.failed.map((f) => f.reason).join(' | ') });
    }
    setKill(cfg.killSwitch);
    try { await api('/api/status'); } catch { return; }
    connect();
    refreshStatus(true);
    loadAudit();
    clearInterval(statusTimer);
    statusTimer = setInterval(() => refreshStatus(false), 5000);
  }
  boot();
})();
