// Append-only audit log of every action (auto or approved), stored as JSONL.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { scrubDeep } from './redact.js';

const FILE = path.join(config.dataDir, 'audit.jsonl');
fs.mkdirSync(config.dataDir, { recursive: true });

export const auditBus = new EventEmitter();
let cache = [];
try {
  cache = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).slice(-300).map((l) => JSON.parse(l));
} catch {
  cache = [];
}

let seq = cache.length ? Math.max(...cache.map((e) => e.seq || 0)) : 0;

/**
 * @param {object} entry { actor, kind, tool, risk, app, summary, status, args, result, durationMs }
 */
export function audit(entry, secretValues = []) {
  const rec = scrubDeep({ seq: ++seq, at: new Date().toISOString(), ...entry }, secretValues);
  cache.push(rec);
  if (cache.length > 300) cache = cache.slice(-300);
  fs.appendFile(FILE, JSON.stringify(rec) + '\n', () => {});
  auditBus.emit('entry', rec);
  return rec;
}

export function recentAudit(limit = 80) {
  return cache.slice(-limit).reverse();
}
