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

  const ICONS = {
    get_account_overview: '💳', list_plans: '📋', analyze_project: '🔍', get_app_status: '📊', get_logs: '📜', get_metrics: '📈', http_check: '🌐',
    investigate_incident: '🩺', verify_recovery: '✅', search_project_code: '🔎', read_project_file: '📄', handoff_to_coding_agent: '🤝', get_domain_guide: '🌍',
    deploy_new_app: '🚀', deploy_new_version: '📦', set_env_vars: '🔑', restart_app: '🔄', rollback_release: '↩️', change_plan: '⚙️', stop_app: '⏹️', start_app: '▶️', add_domain: '🌍',
  };
  const IMPACT_ICON = { cost: '💰', downtime: '⏱️', restart: '🔄', reversible: '↩️', security: '🔒', note: 'ℹ️' };

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
          h('h4', {}, '🛡️ تلاش برای تزریق دستور شناسایی شد'),
          h('div', {}, `در ${ev.app ? `لاگ‌ها یا فایل‌های ${ev.app}` : 'متن خوانده‌شده'} متنی هست که سعی می‌کند به هوش مصنوعی دستور بدهد. کوپایلت این متن را فقط داده حساب کرد؛ هیچ ابزاری به خاطر آن اجرا نمی‌شود و هر تغییری همچنان کارت تأیید شما را لازم دارد.`),
          h('pre', {}, ev.samples.join('\n'))));
        break;
      case 'reset':
        messages.innerHTML = '';
        messages.append(welcomeClone);
        welcomeClone.classList.remove('hidden');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ activity rows
  function actRow(callId, tool, label, kind) {
    let a = acts.get(callId);
    if (a) return a;
    const status = h('span', { class: 'spin' });
    const meta = h('span', { class: 'meta' });
    const body = h('div', { class: 'body' });
    const steps = h('ul', { class: 'steps' });
    body.append(steps);
    const el = h('div', { class: 'act' },
      h('div', { class: 'head', onclick: () => el.classList.toggle('open') }, status, h('span', {}, ICONS[tool] || '🔧'), h('span', { class: 'label' }, label || tool),
        h('span', { class: `badge ${kind}` }, kind === 'auto' ? 'خودکار' : 'با تأیید شما'), meta),
      body);
    add(el);
    a = { el, status, meta, steps, body, stepEls: new Map(), log: null, tool };
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
    const ico = ev.status === 'done' ? h('span', { class: 'ok-ico' }, '✓') : ev.status === 'failed' ? h('span', { class: 'bad-ico' }, '✗') : h('span', { class: 'spin' });
    const STEP_FA = { balance: 'موجودی', network: 'شبکهٔ خصوصی', create: 'ساخت اپ', envs: 'متغیرها', archive: 'فشرده‌سازی', upload: 'آپلود', release: 'ریلیز', build: 'بیلد و استقرار', probe: 'تست زنده', wait: 'بالا آمدن اپ', restart: 'ری‌استارت', resize: 'تغییر پلن', scale: 'روشن/خاموش' };
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
    a.status.replaceWith(a.status = ev.ok ? h('span', { class: 'ok-ico' }, '✓') : h('span', { class: 'bad-ico' }, '✗'));
    a.meta.textContent = ev.ms ? `${faNum(ev.ms / 1000, 1)} ثانیه` : '';
    if (ev.error) {
      a.body.append(h('div', { class: 'blocked' }, ev.error));
      a.el.classList.add('open');
    }
    if (ev.ui && ev.data) {
      const card = renderToolCard(ev.ui, ev.data);
      if (card) add(card);
    }
    if (!ev.error && a.tool && !['deploy_new_app', 'deploy_new_version'].includes(a.tool)) setTimeout(() => a.el.classList.remove('open'), 1500);
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
      h('h4', {}, '🔍 نتیجهٔ تحلیل پروژه', h('span', { class: 'badge' }, d.suggestedName)),
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
      h('h4', {}, '🩺 عیب‌یابی', h('span', { class: 'badge' }, ev.app?.name), d.symptom ? h('span', { class: 'small-muted' }, `«${d.symptom}»`) : null),
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
      h('h4', {}, '✅ بررسی نتیجه', h('span', { class: `verdict ${d.verdict}` }, d.verdictFa)),
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
    const btn = h('button', { class: 'ghost small', onclick: async () => { await navigator.clipboard.writeText(d.markdown); btn.textContent = 'کپی شد ✓'; } }, 'کپی برای ایجنت کدنویس');
    return h('div', { class: 'card handoff' },
      h('h4', {}, '🤝 پیام برای ایجنت کدنویس (Claude Code، Cursor، Copilot)'),
      h('div', { class: 'sub' }, `ذخیره شد: ${d.savedTo}. کافی است به ایجنت کدنویستان بگویید این فایل را بخواند و اجرا کند.`),
      h('pre', {}, d.markdown),
      h('div', { class: 'actions' }, btn),
    );
  }

  function deployCard(d) {
    if (!d.ok) {
      return h('div', { class: 'card' }, h('h4', {}, '⚠️ انتشار کامل نشد'),
        d.error === 'insufficient_balance' ? h('div', { class: 'blocked' }, `موجودی ${toman(d.balanceToman)} است؛ برای هر ساعت ${toman(d.needPerHourToman)} لازم است.`) : null,
        d.failReason ? h('div', { class: 'blocked' }, d.failReason) : null,
        d.buildTail?.length ? h('div', { class: 'buildlog' }, d.buildTail.join('\n')) : null);
    }
    const p = d.probe;
    return h('div', { class: 'card' },
      h('h4', {}, '🎉 سایت زنده است'),
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
      h('h4', {}, '🛡️ نیاز به تأیید شما:', c.titleFa || ev.labelFa, h('span', { class: `badge ${ev.risk}` }, `ریسک ${ev.riskFa}`)),
      c.summaryFa ? h('div', {}, c.summaryFa) : null,
      c.reasonFa ? h('div', { class: 'why' }, h('b', {}, 'چرا؟ '), c.reasonFa) : null,
      c.changes?.length ? h('table', { class: 'changes' },
        h('tr', {}, h('th', {}, 'چه چیزی'), h('th', {}, 'الان'), h('th', {}, 'بعد از تأیید')),
        c.changes.map((x) => h('tr', {}, h('td', {}, x.label), h('td', { class: x.before ? 'before' : '' }, x.before || '-'), h('td', {}, x.after || '-')))) : null,
      c.impacts?.length ? h('ul', { class: 'impacts' }, c.impacts.map((x) => h('li', {}, `${IMPACT_ICON[x.kind] || '•'} ${x.text}`))) : null,
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
  const metricCache = new Map();
  function sparkline(points, limit) {
    if (!points?.length) return null;
    const W = 300;
    const H = 44;
    const vals = points.map((p) => p.mb);
    const max = Math.max(limit || 0, ...vals) * 1.05 || 1;
    const t0 = points[0].t;
    const t1 = points.at(-1).t || t0 + 1;
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (v) => H - (v / max) * H;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.mb).toFixed(1)}`).join(' ');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'spark');
    svg.innerHTML = `<path class="area" d="${line} L${W},${H} L0,${H} Z"/><path class="line" d="${line}"/>${limit ? `<line class="limit" x1="0" x2="${W}" y1="${y(limit)}" y2="${y(limit)}"/>` : ''}`;
    return svg;
  }

  async function loadMetrics(name) {
    try {
      const [m, l] = await Promise.all([api(`/api/apps/${encodeURIComponent(name)}/metrics?minutes=20`), api(`/api/apps/${encodeURIComponent(name)}/logs`)]);
      metricCache.set(name, { at: Date.now(), memory: m.memory || [], errors: (l.lines || []).filter((x) => x.err).slice(-3) });
    } catch { /* ignore */ }
  }

  async function refreshStatus(force) {
    let s;
    try { s = await api('/api/status'); } catch { return; }
    const chip = $('#balanceChip');
    chip.textContent = s.balance === null ? 'موجودی: نامشخص' : `موجودی: ${toman(s.balance)}`;
    const box = $('#apps');
    const managed = s.apps.filter((a) => a.managed);
    await Promise.all(managed.map((a) => (force || !metricCache.has(a.name) || Date.now() - metricCache.get(a.name).at > 12000 ? loadMetrics(a.name) : null)));
    const cards = s.apps.map((a) => appCard(a));
    box.replaceChildren(
      h('div', { class: 'account' }, h('div', {}, h('div', { class: 'small-muted' }, `موجودی ${s.account || 'حساب لیارا'}`), h('div', { class: 'big' }, toman(s.balance))),
        h('div', { class: 'small-muted' }, s.mode === 'sim' ? 'حالت شبیه‌ساز محلی' : 'متصل به api.liara.ir', h('br'), `${faNum(s.apps.length)} سرویس`)),
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
      a.managed && memPct !== null ? h('div', { class: 'metricrow' }, h('span', {}, 'رم'), h('div', { class: `bar ram ${memPct >= 85 ? 'bad' : memPct >= 65 ? 'warn' : ''}` }, h('i', { style: `width:${Math.min(100, memPct)}%` })), h('span', { class: 'v' }, `${a.memMB} / ${a.ramLimitMB} MB`)) : null,
      a.managed && cpuPct !== null ? h('div', { class: 'metricrow' }, h('span', {}, 'CPU'), h('div', { class: 'bar' }, h('i', { style: `width:${cpuPct}%` })), h('span', { class: 'v' }, `${cpuPct}%`)) : null,
      a.managed && m?.memory?.length > 1 ? [h('div', { class: 'small-muted' }, 'رم در ۲۰ دقیقهٔ اخیر (خط قرمز: سقف پلن)'), sparkline(m.memory, a.ramLimitMB)] : null,
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
      h('span', {}, al.level === 'down' ? '🔥' : '⚠️'),
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
    b.textContent = killOn ? '▶️ فعال کردن دوباره' : '🛑 توقف اقدامات';
    $('#killBox').classList.toggle('hidden', !killOn);
  }
  $('#killBtn').addEventListener('click', async () => {
    const turnOn = !killOn;
    if (turnOn && !confirm('توقف اضطراری: از این لحظه کوپایلت فقط می‌خواند و کارت‌های تأیید باز رد می‌شوند. ادامه؟')) return;
    const r = await api('/api/killswitch', { method: 'POST', body: { on: turnOn } }).catch(() => null);
    if (r?.killSwitch) setKill(r.killSwitch);
  });

  const KIND_FA = { security_alert: ['امنیتی', 'error'], kill_switch_on: ['توقف اضطراری', 'error'], kill_switch_off: ['فعال‌سازی دوباره', 'ok'], auto: ['خودکار', 'auto'], approved: ['تأییدشده', 'approved'], rejected: ['رد شد', 'rejected'], approval_requested: ['درخواست تأیید', 'medium'], alert: ['هشدار', 'alert'], refused: ['خارج از محدوده', 'error'] };
  const ACTOR = { agent: '🤖', user: '👤', watcher: '👁️' };
  function auditRow(e) {
    const [k, cls] = KIND_FA[e.kind] || [e.kind, ''];
    return h('div', { class: 'aud' },
      h('div', { class: 'row' }, h('span', {}, ACTOR[e.actor] || '•'), h('span', { class: `badge ${cls}` }, k), h('b', {}, e.summary || e.tool), e.app ? h('span', { class: 'small-muted' }, e.app) : null,
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

  const welcomeClone = $('#welcome');

  const modelLabel = (model, provider) => `مدل: ${String(model || '').split('/').pop()} از ${provider === 'boxapi' ? 'BoxAPI' : 'OpenAI'}`;

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
