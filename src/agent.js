// Agent loop: LLM with tool calling, plus a human-in-the-loop gate enforced in code.
// Read-only tools run at once; every other tool first shows an approval card and waits.
import { randomUUID } from 'node:crypto';
import { chat } from './llm.js';
import { systemPrompt } from './prompts.js';
import { toolByName, toolSchemas, RISK_FA } from './tools/index.js';
import { audit } from './audit.js';
import { scrubDeep } from './redact.js';
import { managedApps } from './scope.js';
import { config } from './config.js';
import { runFallback } from './fallback.js';
import { pokeWatcher } from './watcher.js';

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
  const sys = { role: 'system', content: systemPrompt({ mode: config.liaraMode, managed: managedApps(), currentApp: session.currentApp, project: session.project }) };
  // Keep the last turns in full, shorten older tool outputs to save context.
  const msgs = session.messages.slice(-60);
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
  return [sys, ...msgs.map((m, i) => (m.role === 'tool' && i < lastUser ? { ...m, content: clip(m.content, 1500) } : m))];
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
    const safe = scrubDeep(result, Object.values(inputs));
    emit(session, 'tool_end', { callId: call.id, tool: tool.name, labelFa: tool.labelFa, ok: result?.ok !== false && !result?.error, ui: tool.ui, data: tool.ui ? safe : undefined, ms: Date.now() - started });
    audit({ actor: kind === 'auto' ? 'agent' : 'agent', kind, tool: tool.name, risk: tool.risk, app, status: result?.ok === false || result?.error ? 'error' : 'ok', durationMs: Date.now() - started, summary: tool.labelFa, args }, Object.values(inputs));
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
  const runToolByName = (name, args) => runTool(session, { id: `fb_${randomUUID().slice(0, 8)}`, function: { name, arguments: JSON.stringify(args) } }, ctx);
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

export async function runTurn(session, userText, liara) {
  if (session.busy) {
    emit(session, 'error', { message: 'هنوز درخواست قبلی در حال انجام است.' });
    return;
  }
  session.busy = true;
  session.messages.push({ role: 'user', content: userText });
  emit(session, 'user', { text: userText });
  const ctx = { liara, session };
  try {
    if (llmState.downUntil > Date.now() || !config.llm.chain.length) {
      await fallbackTurn(session, userText, ctx);
      return;
    }
    for (let stepNo = 0; stepNo < MAX_STEPS; stepNo++) {
      const msgId = randomUUID().slice(0, 8);
      emit(session, 'assistant_start', { msgId });
      let message;
      try {
        ({ message } = await chat({
          messages: buildMessages(session),
          tools: toolSchemas(),
          onDelta: (d) => emit(session, 'delta', { msgId, text: d }),
        }));
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
      session.messages.push(message);
      if (!message.tool_calls?.length) break;
      for (const call of message.tool_calls) {
        const result = await runTool(session, call, ctx);
        session.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(scrubDeep(result), 14000) });
      }
    }
  } catch (e) {
    emit(session, 'error', { message: `خطا در ارتباط با مدل: ${e.message.slice(0, 200)}` });
    repairHistory(session);
  } finally {
    session.busy = false;
    emit(session, 'turn_end', {});
  }
}
