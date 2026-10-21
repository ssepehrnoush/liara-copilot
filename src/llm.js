// OpenAI-compatible chat client with streaming + tool calls.
// Provider is chosen by env (LLM_PROVIDER=boxapi|openai); BoxAPI is the default when its key exists.
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from './config.js';

// Node's built-in fetch ignores HTTPS_PROXY; a provider with `proxy` set goes through it.
// Used for api.openai.com from Iran (local VPN); BoxAPI is an Iranian gateway and goes direct.
const agents = new Map();
function send(p, url, init) {
  if (!p.proxy) return fetch(url, init);
  if (!agents.has(p.proxy)) agents.set(p.proxy, new ProxyAgent(p.proxy));
  return undiciFetch(url, { ...init, dispatcher: agents.get(p.proxy) });
}

// Per-provider gate: BoxAPI allows 1 concurrent request and 20 per minute for the whole key
// (shared with the other hackathon apps), so calls wait in line instead of failing.
const gates = new Map();
function gate(p) {
  if (!gates.has(p.name)) gates.set(p.name, { tail: Promise.resolve(), active: 0, starts: [] });
  return gates.get(p.name);
}
async function withGate(p, fn) {
  if (!p.maxConcurrent && !p.rpm) return fn();
  const g = gate(p);
  const run = async () => {
    if (p.rpm) {
      const now = Date.now();
      g.starts = g.starts.filter((t) => now - t < 60000);
      if (g.starts.length >= p.rpm) await new Promise((r) => setTimeout(r, 60000 - (now - g.starts[0]) + 50));
      g.starts.push(Date.now());
    }
    return fn();
  };
  // maxConcurrent is 1 in practice: chain calls one after another.
  const result = g.tail.then(run, run);
  g.tail = result.catch(() => {});
  return result;
}

function unavailable(msg) {
  const e = new Error(msg);
  e.unavailable = true;
  return e;
}

// Running totals since start, per provider (BoxAPI reports the cost of each call in usage).
export const llmUsage = {};

// Try each configured provider in order (BoxAPI, then any LLM_FALLBACK provider).
// A provider that is out of budget, blocked or misconfigured is skipped for this call.
export async function chat({ messages, tools, onDelta, maxTokens = 2000 }) {
  const chain = config.llm.chain;
  if (!chain.length) throw unavailable('no LLM provider configured');
  let lastErr;
  const failed = [];
  for (const [i, p] of chain.entries()) {
    try {
      const out = await withGate(p, async () => readStream(await open(p, { messages, tools, maxTokens, last: i === chain.length - 1 }), onDelta));
      if (failed.length) {
        config.llm.lastFallback = { at: Date.now(), to: p.name, model: p.model, failed, budget: failed.some((f) => /402|budget|spending limit/i.test(f.reason)) };
        console.warn(`[llm] ${failed.map((f) => `${f.name} failed (${f.reason.slice(0, 90)})`).join('; ')} -> answered by ${p.name}:${p.model}`);
      } else config.llm.lastFallback = null;
      config.llm.active = p.name;
      const u = (llmUsage[p.name] ||= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUSD: 0 });
      u.calls++;
      u.promptTokens += out.usage?.prompt_tokens || 0;
      u.cachedTokens += out.usage?.prompt_tokens_details?.cached_tokens || 0;
      u.completionTokens += out.usage?.completion_tokens || 0;
      u.costUSD += out.usage?.cost || 0;
      return out;
    } catch (e) {
      lastErr = e;
      if (!e.unavailable) throw e;
      failed.push({ name: p.name, reason: e.message });
    }
  }
  throw lastErr;
}

async function open(p, { messages, tools, maxTokens, last = true }) {
  const body = { model: p.model, messages, stream: true };
  // OpenAI sends token usage on a stream only when asked; BoxAPI always does.
  if (p.name === 'openai') body.stream_options = { include_usage: true };
  // Newer reasoning-era models reject some sampling params; send only what each family accepts.
  const reasoning = /gpt-([5-9]|\d\d)|(^|\/)o\d|~openai\/gpt-/.test(p.model);
  if (reasoning) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  // OpenAI only allows function tools on chat/completions for GPT-5 when reasoning is off.
  // GPT-5.6 and gpt-6-sol need the same on BoxAPI too (gpt-6.1-sol and gpt-6-astra take tools
  // only on /v1/responses, so they are not used).
  if ((p.name === 'openai' && /gpt-5/.test(p.model)) || /gpt-5\.[6-9]|gpt-6/.test(p.model)) body.reasoning_effort = 'none';
  // Through BoxAPI the same models accept tools with low effort; keeps the shared credit lean.
  else if (reasoning) body.reasoning_effort = process.env.LLM_REASONING_EFFORT || 'low';
  if (process.env.LLM_TEMPERATURE) body.temperature = Number(process.env.LLM_TEMPERATURE);
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  let res;
  // With a fallback provider behind this one, give up sooner and let it answer.
  const attempts = last ? 5 : 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      res = await send(p, `${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      if (attempt < (last ? 2 : 1)) continue;
      throw unavailable(`${p.name} network error: ${e.cause?.code || e.message}`);
    }
    if (res.ok) return res;
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) {
      // The BoxAPI key is shared with other apps, so a 429 can come from their traffic:
      // wait as long as the gateway asks (Retry-After), else back off 2, 4, 8, 16 s.
      const after = Number(res.headers.get('retry-after'));
      const wait = after > 0 ? Math.min(after, last ? 30 : 5) * 1000 : 2000 * 2 ** attempt;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, wait + Math.random() * 500));
      continue;
    }
    const err = new Error(`${p.name} ${res.status}: ${txt.slice(0, 300)}`);
    // Budget exhausted, key rejected, region blocked or model gone: try the next provider.
    err.unavailable = [401, 402, 403, 404].includes(res.status);
    throw err;
  }
  throw unavailable(`${p.name} ${res?.status || 'error'}`);
}

async function readStream(res, onDelta) {
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];
  let finish = null;
  let usage = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.content) {
        content += d.content;
        onDelta?.(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].function.name += tc.function.name;
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, finish, usage };
}
