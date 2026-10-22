// Loads settings from .env (this folder first, then the parent folder) without
// printing any value. Every secret stays server-side.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    let value = line.slice(line.indexOf('=') + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== '') process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(ROOT, '..', '.env'));

const argvSim = process.argv.includes('--sim');

const provider = (process.env.LLM_PROVIDER || (process.env.BOXAPI_KEY ? 'boxapi' : 'openai')).toLowerCase();
const providers = {
  boxapi: {
    baseURL: process.env.BOXAPI_BASE_URL || 'https://ai.boxapi.ir/ai/v1',
    apiKey: process.env.BOXAPI_KEY,
    model: (provider === 'boxapi' && process.env.LLM_MODEL) || process.env.BOXAPI_MODEL || 'openai/gpt-6-sol',
    proxy: process.env.BOXAPI_PROXY || '',
    maxConcurrent: Number(process.env.BOXAPI_MAX_CONCURRENT || 1),
    rpm: Number(process.env.BOXAPI_RPM || 18),
    fastModel: process.env.LLM_FAST_MODEL || 'openai/gpt-4.1-mini',
  },
  openai: {
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: (provider === 'openai' && process.env.LLM_MODEL) || process.env.OPENAI_MODEL || 'gpt-6-sol',
    proxy: process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    fastModel: process.env.LLM_FAST_MODEL || 'gpt-4.1-mini',
  },
};

// Second choice when the first provider fails (budget, rate limit, timeout, 5xx). "none" turns it off.
const fallbacks = (process.env.LLM_FALLBACK ?? 'openai').toLowerCase().split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');

const liaraMode = argvSim ? 'sim' : (process.env.LIARA_MODE || 'real').toLowerCase();

export const config = {
  root: ROOT,
  // Separate state per mode so simulator apps never mix with real ones.
  dataDir: path.join(ROOT, 'data', liaraMode),
  port: Number(process.env.PORT || process.env.COPILOT_PORT || 4100),
  // Only this computer by default. To serve it to others set HOST=0.0.0.0 and COPILOT_PASSCODE.
  host: process.env.HOST || '127.0.0.1',
  // "real" talks to api.liara.ir; "sim" runs apps locally behind the same interface.
  liaraMode,
  liara: {
    baseURL: process.env.LIARA_API_URL || 'https://api.liara.ir',
    token: process.env.LIARA_API_TOKEN,
    teamID: process.env.LIARA_TEAM_ID || '',
    appDomainSuffix: process.env.LIARA_APP_DOMAIN || 'liara.run',
  },
  llm: {
    provider,
    ...(providers[provider] || { model: 'none' }),
    // Chosen provider first (the sponsor gateway BoxAPI), then the LLM_FALLBACK providers that have
    // a key. With no model left, the copilot switches to its rule mode.
    chain: provider === 'none' ? [] : [provider, ...fallbacks.filter((k) => k !== provider && providers[k])]
      .filter((k) => providers[k]?.apiKey)
      .map((k) => ({ name: k, ...providers[k], model: k === provider ? providers[k].model : (process.env[`${k.toUpperCase()}_MODEL`] || providers[k].model) })),
    active: null,
    lastFallback: null,
    // USD per million tokens, for providers that do not report the cost of a call themselves
    // (BoxAPI does, in usage.cost). OpenAI list price for gpt-6-sol, October 2026.
    prices: { 'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 } },
    // Free-market dollar rate for showing the cost in toman (late October 2026).
    usdToman: Number(process.env.USD_TOMAN || 270000),
  },
  // Optional passcode for when the copilot itself is hosted publicly.
  passcode: process.env.COPILOT_PASSCODE || '',
  // Apps the copilot is allowed to change. Empty = only apps it created itself.
  allowedApps: (process.env.COPILOT_ALLOWED_APPS || '').split(',').map((s) => s.trim()).filter(Boolean),
  watchIntervalSec: Number(process.env.WATCH_INTERVAL_SEC || 20),
};

export function publicConfig() {
  return {
    liaraMode: config.liaraMode,
    llmProvider: config.llm.provider,
    llmModel: config.llm.model,
    hasLiaraToken: Boolean(config.liara.token),
    hasLlmKey: config.llm.chain.length > 0,
    llmChain: config.llm.chain.map((p) => `${p.name}:${p.model}`),
    llmActive: config.llm.active,
    llmFallback: config.llm.lastFallback,
    passcodeRequired: Boolean(config.passcode),
  };
}
