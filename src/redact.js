// Secret hygiene: env values and tokens never reach the LLM, the audit log or the UI.

const SAFE_ENV_KEYS = new Set(['NODE_ENV', 'PORT', 'TZ', 'LOG_LEVEL', 'APP_ENV', 'DEBUG', 'SHOP_NAME', 'APP_NAME']);
const SECRET_HINT = /(KEY|SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|AUTH|DSN|_URL|URI|COOKIE|SESSION|SALT)/i;

// Used for UI hints (password-style input). Values of every non-safe key are masked anyway.
export function isSecretKey(key) {
  return !SAFE_ENV_KEYS.has(key) && SECRET_HINT.test(key);
}

export function maskValue(value) {
  if (value === undefined || value === null || value === '') return '(خالی)';
  const s = String(value);
  if (s.length <= 4) return '••••';
  return `${s.slice(0, 2)}••••${s.slice(-2)} (${s.length} کاراکتر)`;
}

export function maskEnvs(envs = []) {
  return envs.map((e) => ({
    key: e.key,
    value: SAFE_ENV_KEYS.has(e.key) ? e.value : maskValue(e.value),
    masked: !SAFE_ENV_KEYS.has(e.key),
  }));
}

const TOKEN_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{16,})/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,
  /((?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*)([^\s"',]{4,})/gi,
  /(:\/\/[^:/\s]+:)([^@\s]{3,})(@)/g, // credentials inside URLs
];

export function scrubText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  out = out.replace(TOKEN_PATTERNS[0], '[redacted-key]');
  out = out.replace(TOKEN_PATTERNS[1], '[redacted-jwt]');
  out = out.replace(TOKEN_PATTERNS[2], '$1[redacted]');
  out = out.replace(TOKEN_PATTERNS[3], '$1[redacted]');
  out = out.replace(TOKEN_PATTERNS[4], '$1[redacted]$3');
  return out;
}

// Deep-scrub any object before it is logged or shown to the model.
export function scrubDeep(obj, secretValues = []) {
  const secrets = secretValues.filter((v) => typeof v === 'string' && v.length >= 4);
  const walk = (v) => {
    if (typeof v === 'string') {
      let s = scrubText(v);
      for (const sec of secrets) s = s.split(sec).join('[secret]');
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const r = {};
      for (const [k, val] of Object.entries(v)) r[k] = walk(val);
      return r;
    }
    return v;
  };
  return walk(obj);
}
