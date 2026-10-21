// Which apps the copilot may change, and where each app's source lives.
// Default: only apps the copilot created itself (plus COPILOT_ALLOWED_APPS). Every other
// app in the account stays read-only, so a shared Liara account is safe.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'apps.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

let registry = load();

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(registry, null, 2));
}

export function registerApp(name, info = {}) {
  registry[name] = { ...(registry[name] || {}), ...info, updatedAt: new Date().toISOString() };
  if (!registry[name].createdAt) registry[name].createdAt = registry[name].updatedAt;
  save();
}

export function appInfo(name) {
  return registry[name] || null;
}

export function canModify(name) {
  if (process.env.COPILOT_SCOPE === 'all') return true;
  return Boolean(registry[name]?.managed) || config.allowedApps.includes(name);
}

export function managedApps() {
  return Object.entries(registry).filter(([, v]) => v.managed).map(([k]) => k);
}
