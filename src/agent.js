// Agent loop: LLM with tool calling, plus a human-in-the-loop gate enforced in code.
// Read-only tools run at once; every other tool first shows an approval card and waits.
import { randomUUID } from 'node:crypto';
import { chat } from './llm.js';
import { SYSTEM_PROMPT, contextNote } from './prompts.js';
import { toolByName, toolSchemas, RISK_FA } from './tools/index.js';
import { audit } from './audit.js';
import { scrubDeep } from './redact.js';
import { managedApps, appInfo } from './scope.js';
import { config } from './config.js';
import { runFallback } from './fallback.js';
import { pokeWatcher } from './watcher.js';
import { killSwitch, appSecrets, forgetSecrets, findInjections, INJECTION_RULE } from './safety.js';

const sessions = new Map();
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STEPS = 14;

export function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { id, messages: [], pending: new Map(), listeners: new Set(), buffer: [], seq: 0, busy: false, project: null, currentApp: null };
    sessions.set(id, s);
  }
  return s;
}

export function emit(session, type, data = {}) {
  const ev = { seq: ++session.seq, type, at: Date.now(), ...data };
  session.buffer.push(ev);
  if (session.buffer.length > 400) session.buffer.splice(0, session.buffer.length - 400);
  for (const fn of session.listeners) fn(ev);
}

export function broadcast(type, data) {
  for (const s of sessions.values()) emit(s, type, data);
}

// Kill switch turned on: every open approval card is answered "no".
export function rejectAllPending(note) {
  for (const s of sessions.values()) {
    for (const [id, p] of s.pending) p.resolve({ action: 'reject', note });
  }
}

export function resolveApproval(session, id, decision) {
  const p = session.pending.get(id);
  if (!p) return false;
  p.resolve(decision);
  return true;
}

function waitDecision(session, id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      resolve({ action: 'reject', note: 'timeout' });
    }, APPROVAL_TIMEOUT_MS);
    session.pending.set(id, {
      resolve: (d) => {
        clearTimeout(timer);
        session.pending.delete(id);
        resolve(d);
      },
    });
  });
}

function clip(obj, max) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function buildMessages(session) {
  const knownPages = managedApps().map((a) => `${a}: ${(appInfo(a)?.watchPaths || ['/']).join(' ')}`).join('; ');
  const note = { role: 'system', content: contextNote({ mode: config.liaraMode, managed: managedApps(), currentApp: session.currentApp, project: session.project, knownPages, now: session.turnStartedAt }) };
  // Keep the last turns in full, shorten older tool outputs to save context.
  const msgs = session.messages.slice(-60);
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  const at = lastUser < 0 ? msgs.length : lastUser;
  const shown = msgs.map((m, i) => (m.role === 'tool' && i < lastUser ? { ...m, content: clip(m.content, 1500) } : m));
  // Fixed instructions first and the live context just before the newest user message: every
  // call of a turn then starts with the same bytes as the call before it, which the provider
  // bills at the cached rate.
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...shown.slice(0, at), note, ...shown.slice(at)];
}

async function runTool(session, call, ctx) {
  const tool = toolByName[call.function.name];
  if (!tool) return { error: `unknown tool ${call.function.name}` };
  let args;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    return { error: 'arguments were not valid JSON' };
  }
  const app = args.app || args.name || null;
  const started = Date.now();
  let inputs = {};
  let kind = 'auto';

  if (tool.risk !== 'auto' && killSwitch().on) {
    // ---- kill switch: the copilot is read-only until a human turns it back on ----
    const msg = 'کلید توقف اضطراری روشن است؛ کوپایلت فقط می‌خواند و هیچ تغییری روی لیارا نمی‌دهد.';
    audit({ actor: 'agent', kind: 'refused', tool: tool.name, risk: tool.risk, app, summary: msg, status: 'blocked' });
    emit(session, 'tool_end', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, ok: false, error: msg });
    return { error: msg, killSwitch: true };
  }

  if (tool.risk !== 'auto') {
    // ---- approval gate ----
    let card;
    for (;;) {
      try {
        card = await tool.preview(args, ctx);
      } catch (e) {
        audit({ actor: 'agent', kind: 'refused', tool: tool.name, risk: tool.risk, app, summary: e.message, status: 'error' });
        emit(session, 'tool_end', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, ok: false, error: e.message });
        return { error: e.message };
      }
      const id = randomUUID().slice(0, 8);
      emit(session, 'approval', { id, callId: call.id, tool: tool.name, labelFa: tool.labelFa, risk: tool.risk, riskFa: RISK_FA[tool.risk], card });
      audit({ actor: 'agent', kind: 'approval_requested', tool: tool.name, risk: tool.risk, app, summary: card.summaryFa, args });
      const decision = await waitDecision(session, id);
      emit(session, 'approval_resolved', { id, action: decision.action });
      if (decision.action === 'retry') continue;
      if (decision.action !== 'approve' || card.blocked) {
        audit({ actor: 'user', kind: 'rejected', tool: tool.name, risk: tool.risk, app, summary: decision.note || 'rejected by user', status: 'rejected' });
        return { status: 'rejected_by_user', note: decision.note || null, blockedReason: card.blocked?.reasonFa || null };
      }
      inputs = decision.inputs || {};
      kind = 'approved';
      audit({ actor: 'user', kind: 'approved', tool: tool.name, risk: tool.risk, app, summary: card.summaryFa, status: 'approved' }, Object.values(inputs));
      break;
    }
  }

  emit(session, 'tool_start', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, risk: tool.risk, args: scrubDeep(args, Object.values(inputs)) });
  const step = (s) => emit(session, 'tool_progress', { callId: call.id, tool: tool.name, ...s });
  try {
    const result = await tool.run(args, { ...ctx, step, inputs });
    if (tool.name === 'set_env_vars' && app) forgetSecrets(app);
    // Mask every env value of the app wherever it shows up (logs often print config).
    const secrets = [...Object.values(inputs), ...(await appSecrets(ctx.liara, app))];
    const safe = scrubDeep(result, secrets);
    // Untrusted text (logs, files) that tries to instruct an AI: flag it, never act on it.
    const injections = findInjections(tool.name, safe);
    if (injections.length) {
      safe.securityNotice = { promptInjectionAttempts: injections, rule: INJECTION_RULE };
      emit(session, 'security', { tool: tool.name, app, samples: injections });
      audit({ actor: 'agent', kind: 'security_alert', tool: tool.name, risk: 'auto', app, summary: `تلاش برای تزریق دستور در ${tool.labelFa} شناسایی و نادیده گرفته شد (${injections.length} مورد)`, status: 'blocked' });
    }
    emit(session, 'tool_end', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, ok: result?.ok !== false && !result?.error, ui: tool.ui, data: tool.ui ? safe : undefined, ms: Date.now() - started });
    audit({ actor: 'agent', kind, tool: tool.name, risk: tool.risk, app, status: result?.ok === false || result?.error ? 'error' : 'ok', durationMs: Date.now() - started, summary: tool.labelFa, args }, secrets);
    if (kind !== 'auto') {
      emit(session, 'refresh', {});
      pokeWatcher();
    }
    return kind === 'approved' ? { approvedByUser: true, ...safe } : safe;
  } catch (e) {
    const msg = e.fa ? `${e.fa} (${e.status || ''})` : e.message;
    emit(session, 'tool_end', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, ok: false, error: msg, ms: Date.now() - started });
    audit({ actor: 'agent', kind, tool: tool.name, risk: tool.risk, app, status: 'error', durationMs: Date.now() - started, summary: msg, args }, Object.values(inputs));
    return { error: msg, liaraStatus: e.status || null };
  }
}

export const llmState = { downUntil: 0, reason: null, checkedAt: 0 };
const PROVIDER_FA = { boxapi: 'BoxAPI', openai: 'OpenAI' };
const providerFa = (name) => PROVIDER_FA[name] || name;

// Tells the UI and the audit log which provider answered, once per change, so a fallback
// (or an exhausted BoxAPI budget) is never silent.
function noteProvider(session) {
  const fb = config.llm.lastFallback;
  const key = fb ? `${fb.to}:${fb.budget}` : config.llm.active;
  if (llmState.lastProvider === key) return;
  const first = llmState.lastProvider === undefined;
  llmState.lastProvider = key;
  const p = config.llm.chain.find((x) => x.name === config.llm.active);
  broadcast('llm_status', { available: true, provider: config.llm.active, model: p?.model, fallback: Boolean(fb), budget: Boolean(fb?.budget), reason: fb?.failed?.map((f) => f.reason).join(' | ').slice(0, 200) });
  if (fb) audit({ actor: 'agent', kind: 'alert', tool: 'llm', risk: 'auto', summary: fb.budget ? `اعتبار ${providerFa(fb.failed[0].name)} تمام شده؛ پاسخ از ${providerFa(fb.to)} (پشتیبان) آمد` : `${providerFa(fb.failed[0].name)} جواب نداد؛ پاسخ از ${providerFa(fb.to)} (پشتیبان) آمد`, status: 'error' });
  else if (!first) audit({ actor: 'agent', kind: 'alert', tool: 'llm', risk: 'auto', summary: `پاسخ‌ها دوباره از ${providerFa(config.llm.active)} می‌آید`, status: 'ok' });
}

// Cheap 1-token call so the UI can say up front whether the model is reachable.
export async function probeLlm() {
  llmState.checkedAt = Date.now();
  if (!config.llm.chain.length) {
    llmState.downUntil = Number.MAX_SAFE_INTEGER;
    llmState.reason = 'no LLM configured';
    return false;
  }
  try {
    await chat({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
    llmState.downUntil = 0;
    llmState.reason = null;
    return true;
  } catch (e) {
    if (e.unavailable) {
      llmState.downUntil = Date.now() + 5 * 60 * 1000;
      llmState.reason = e.message.slice(0, 160);
    }
    return false;
  }
}

// No LLM reachable: the rule-based planner drives the same tools and approval gate.
async function fallbackTurn(session, userText, ctx) {
  emit(session, 'llm_status', { available: false, reason: llmState.reason });
  const say = async (text) => {
    if (!text) return;
    const msgId = randomUUID().slice(0, 8);
    emit(session, 'assistant_start', { msgId, mode: 'rules' });
    emit(session, 'delta', { msgId, text });
    emit(session, 'assistant_end', { msgId });
    session.messages.push({ role: 'assistant', content: text });
  };
  const runToolByName = async (name, args) => {
    const r = await runTool(session, { id: `fb_${randomUUID().slice(0, 8)}`, function: { name, arguments: JSON.stringify(args) } }, ctx);
    if (r?.securityNotice) await say(`⚠️ در متنی که خواندم (${r.securityNotice.promptInjectionAttempts.length} خط) کسی سعی کرده به هوش مصنوعی دستور بدهد. این متن داده حساب شد و هیچ کاری بر اساس آن انجام نشد.`);
    return r;
  };
  await runFallback(session, userText, { runToolByName, say });
}

// Every assistant tool call must be followed by a tool message, or the next LLM call fails.
function repairHistory(session) {
  const answered = new Set(session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    session.messages.splice(i + 1, 0, ...missing.map((c) => ({ role: 'tool', tool_call_id: c.id, content: '{"error":"interrupted"}' })));
    break;
  }
}

// Fixes that should be checked right after the user approves them, when an incident is open.
const AUTO_VERIFY = new Set(['set_env_vars', 'fix_code', 'restart_app', 'rollback_release', 'change_plan', 'start_app']);

// The check runs in the same step as the fix, so the model does not need another full-context
// call just to ask for it. It shows up in the UI as its own row and before/after card.
async function autoVerify(session, call, result, ctx) {
  if (!AUTO_VERIFY.has(call.function.name) || !result?.approvedByUser || result.ok === false || result.error) return null;
  let app;
  try { app = JSON.parse(call.function.arguments || '{}').app; } catch { return null; }
  const inc = session.lastIncident;
  if (!app || inc?.app !== app) return null;
  await new Promise((r) => setTimeout(r, 2000));
  return runTool(session, { id: `verify_${randomUUID().slice(0, 8)}`, function: { name: 'verify_recovery', arguments: JSON.stringify({ app, incidentId: inc.id }) } }, ctx);
}

// What the model reads: a tool may drop fields that only the UI cards need.
function modelView(name, result) {
  if (!result || result.error) return result;
  const view = toolByName[name]?.forModel;
  const slim = view ? view(result) : result;
  return result.verification ? { ...slim, verification: modelView('verify_recovery', result.verification) } : slim;
}

const fa = (n) => Math.round(n).toLocaleString('fa-IR');
const emptyUsage = () => ({ calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUSD: 0, unpriced: 0 });

function addUsage(total, out) {
  total.calls++;
  total.promptTokens += out.usage?.prompt_tokens || 0;
  total.cachedTokens += out.usage?.prompt_tokens_details?.cached_tokens || 0;
  total.completionTokens += out.usage?.completion_tokens || 0;
  if (out.costUSD === null || out.costUSD === undefined) total.unpriced++;
  else total.costUSD += out.costUSD;
}

// One audit row per turn with what the model cost, and a running total for the header chip.
function recordUsage(session, turn) {
  if (!turn.calls) return;
  const tomanNow = turn.costUSD * config.llm.usdToman;
  audit({ actor: 'agent', kind: 'llm_usage', tool: 'llm', risk: 'auto', status: 'ok', usage: { ...turn, toman: Math.round(tomanNow) },
    summary: `هزینهٔ مدل در این نوبت: حدود ${fa(tomanNow)} تومان (${fa(turn.calls)} فراخوانی، ${fa(turn.promptTokens)} توکن ورودی که ${fa(turn.cachedTokens)} از کش بود)` });
  emit(session, 'usage', { turn, session: session.usage, usdToman: config.llm.usdToman });
}

export async function runTurn(session, userText, liara) {
  if (session.busy) {
    emit(session, 'error', { message: 'هنوز درخواست قبلی در حال انجام است.' });
    return;
  }
  session.busy = true;
  session.turnStartedAt = Date.now();
  session.messages.push({ role: 'user', content: userText });
  emit(session, 'user', { text: userText });
  const ctx = { liara, session };
  const turnUsage = emptyUsage();
  session.usage ||= emptyUsage();
  try {
    if (llmState.downUntil > Date.now() || !config.llm.chain.length) {
      await fallbackTurn(session, userText, ctx);
      return;
    }
    // A model may answer with nothing, or with tool calls that name no tool or carry broken
    // JSON. After two such calls the turn goes to rule mode.
    let broken = 0;
    const toRuleMode = async (why) => {
      audit({ actor: 'agent', kind: 'alert', tool: 'llm', risk: 'auto', summary: `پاسخ مدل ${providerFa(config.llm.active)} قابل استفاده نبود (${why})؛ این نوبت با حالت قواعد ادامه یافت`, status: 'error' });
      llmState.lastProvider = undefined;
      llmState.reason = `پاسخ مدل قابل استفاده نبود: ${why}`;
      await fallbackTurn(session, userText, ctx);
    };
    for (let stepNo = 0; stepNo < MAX_STEPS; stepNo++) {
      const msgId = randomUUID().slice(0, 8);
      emit(session, 'assistant_start', { msgId });
      let message;
      try {
        const out = await chat({
          messages: buildMessages(session),
          tools: toolSchemas(),
          onDelta: (d) => emit(session, 'delta', { msgId, text: d }),
          cacheKey: `liara-copilot-${session.id}`,
        });
        message = out.message;
        addUsage(turnUsage, out);
        addUsage(session.usage, out);
      } catch (e) {
        emit(session, 'assistant_end', { msgId });
        if (!e.unavailable) throw e;
        llmState.downUntil = Date.now() + 5 * 60 * 1000;
        llmState.reason = e.message.slice(0, 160);
        emit(session, 'llm_status', { available: false, reason: llmState.reason });
        audit({ actor: 'agent', kind: 'alert', tool: 'llm', risk: 'auto', summary: 'مدل زبانی در دسترس نیست؛ حالت قواعد فعال شد', status: 'error' });
        if (stepNo === 0) {
          await fallbackTurn(session, userText, ctx);
          return;
        }
        throw e;
      }
      emit(session, 'assistant_end', { msgId });
      noteProvider(session);
      if (stepNo === 0 && !message.tool_calls?.length && !String(message.content || '').trim()) {
        await toRuleMode('پاسخ خالی');
        return;
      }
      session.messages.push(message);
      if (!message.tool_calls?.length) break;
      for (const call of message.tool_calls) {
        let result = await runTool(session, call, ctx);
        if (/^unknown tool|not valid JSON/.test(result?.error || '')) broken++;
        const verification = await autoVerify(session, call, result, ctx);
        if (verification) result = { ...result, verification };
        session.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(scrubDeep(modelView(call.function.name, result)), 14000) });
      }
      if (broken >= 2) {
        await toRuleMode('فراخوانی ابزار نامعتبر');
        return;
      }
    }
  } catch (e) {
    emit(session, 'error', { message: `خطا در ارتباط با مدل: ${e.message.slice(0, 200)}` });
    repairHistory(session);
  } finally {
    recordUsage(session, turnUsage);
    session.busy = false;
    emit(session, 'turn_end', {});
  }
}
