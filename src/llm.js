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

function unavailable(msg) {
  const e = new Error(msg);
  e.unavailable = true;
  return e;
}

// Try each configured provider in order (BoxAPI first, then OpenAI if its key exists).
// A provider that is out of budget, blocked or misconfigured is skipped for this call.
export async function chat({ messages, tools, onDelta, maxTokens = 2000 }) {
  const chain = config.llm.chain;
  if (!chain.length) throw unavailable('no LLM provider configured');
  let lastErr;
  for (const p of chain) {
    try {
      const res = await open(p, { messages, tools, maxTokens });
      const out = await readStream(res, onDelta);
      config.llm.active = p.name;
      return out;
    } catch (e) {
      lastErr = e;
      if (!e.unavailable) throw e;
    }
  }
  throw lastErr;
}

async function open(p, { messages, tools, maxTokens }) {
  const body = { model: p.model, messages, stream: true };
  // Newer reasoning-era models reject some sampling params; send only what each family accepts.
  if (/gpt-5|(^|\/)o\d/.test(p.model)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  // OpenAI only allows function tools on chat/completions for GPT-5 when reasoning is off.
  if (p.name === 'openai' && /gpt-5/.test(p.model)) body.reasoning_effort = 'none';
  if (process.env.LLM_TEMPERATURE) body.temperature = Number(process.env.LLM_TEMPERATURE);
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await send(p, `${p.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      if (attempt < 2) continue;
      throw unavailable(`${p.name} network error: ${e.cause?.code || e.message}`);
    }
    if (res.ok) return res;
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
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
