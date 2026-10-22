// HTTP server: serves the Persian UI, the chat/approval API (SSE) and the status panel data.
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, publicConfig } from './config.js';
import { LiaraApi } from './liara/client.js';
import { LiaraSim } from './liara/sim.js';
import { getSession, runTurn, resolveApproval, emit, broadcast, llmState, probeLlm, rejectAllPending } from './agent.js';
import { killSwitch, setKillSwitch } from './safety.js';
import { audit } from './audit.js';
import { llmUsage } from './llm.js';
import { recentAudit, auditBus } from './audit.js';
import { managedApps, canModify, appInfo } from './scope.js';
import { startWatcher, healthSnapshot } from './watcher.js';
import { listRules, disableRule, describeRule } from './rules.js';
import { makeRuleRunner } from './ruleRunner.js';
import { downsample } from './metrics.js';

const MB = 1024 * 1024;
const liara = config.liaraMode === 'sim'
  ? new LiaraSim({ dataDir: config.dataDir, balance: Number(process.env.SIM_BALANCE || 2500000) })
  : new LiaraApi(config.liara);
if (liara.restore) await liara.restore();

const app = express();
// A page on another site can send a "simple" POST to localhost without asking the browser first,
// but not one with a JSON content type. Every state-changing call must be JSON (the UI's always
// is), so such a page cannot press approve or turn the kill switch off.
// (The header itself is checked: req.is() ignores it on a POST with no body, like "new chat".)
app.use('/api', (req, res, next) => (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '') ? res.status(415).json({ error: 'JSON only' }) : next()));
app.use(express.json({ limit: '1mb' }));

// ---- optional passcode (for a public deployment of the copilot itself) ----
const authToken = config.passcode ? crypto.createHash('sha256').update(`lc:${config.passcode}`).digest('hex').slice(0, 32) : null;
app.post('/api/login', (req, res) => {
  if (!authToken) return res.json({ ok: true });
  if (req.body?.passcode !== config.passcode) return res.status(401).json({ ok: false });
  res.setHeader('Set-Cookie', `lc_auth=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});
app.use('/api', (req, res, next) => {
  if (!authToken || req.path === '/config') return next();
  const ok = (req.headers.cookie || '').split(';').some((c) => c.trim() === `lc_auth=${authToken}`);
  return ok ? next() : res.status(401).json({ error: 'auth' });
});

app.get('/api/config', (_req, res) => res.json({ ...publicConfig(), llmAvailable: !(llmState.downUntil > Date.now()), llmReason: llmState.reason, llmUsage, killSwitch: killSwitch() }));

// Emergency stop: from now on only read-only tools run; open approval cards are rejected.
app.post('/api/killswitch', (req, res) => {
  // Only an explicit true or false counts: a missing value never turns the stop off.
  if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: 'body must be {"on": true|false}' });
  const { on } = req.body;
  if (!on && killSwitch().forced) return res.status(409).json({ error: 'COPILOT_READONLY=1 is set on the server', killSwitch: killSwitch() });
  const ks = setKillSwitch(on);
  if (on) rejectAllPending('kill switch');
  audit({ actor: 'user', kind: on ? 'kill_switch_on' : 'kill_switch_off', tool: 'kill_switch', risk: 'auto', summary: on ? 'توقف اضطراری روشن شد: فقط خواندن' : 'توقف اضطراری خاموش شد', status: on ? 'blocked' : 'ok' });
  broadcast('kill_switch', { killSwitch: ks });
  res.json({ killSwitch: ks });
});

probeLlm();
// Re-probe only while the model is marked down, so a healthy setup spends no extra calls.
setInterval(() => { if (llmState.downUntil > Date.now()) probeLlm(); }, 5 * 60 * 1000).unref();

// ---- chat session (server-sent events) ----
app.get('/api/session/:id/events', (req, res) => {
  const s = getSession(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const after = Number(req.query.after || 0);
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  for (const ev of s.buffer) if (ev.seq > after) send(ev);
  s.listeners.add(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    s.listeners.delete(send);
  });
});

app.post('/api/session/:id/chat', (req, res) => {
  const s = getSession(req.params.id);
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'empty' });
  if (s.busy) return res.status(409).json({ error: 'busy' });
  runTurn(s, text, liara);
  res.json({ ok: true });
});

app.post('/api/session/:id/approvals/:aid', (req, res) => {
  const s = getSession(req.params.id);
  const { action = 'reject', inputs = {}, note } = req.body || {};
  const ok = resolveApproval(s, req.params.aid, { action, inputs, note });
  res.json({ ok });
});

app.post('/api/session/:id/reset', (req, res) => {
  const s = getSession(req.params.id);
  if (s.busy) return res.status(409).json({ error: 'busy' });
  s.messages = [];
  s.buffer = [];
  s.project = null;
  s.usage = null;
  emit(s, 'reset', {});
  res.json({ ok: true });
});

// ---- standing rules: switching one off is always allowed (it only removes automation) ----
app.post('/api/rules/:id/disable', (req, res) => {
  const r = disableRule(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  audit({ actor: 'user', kind: 'rule_disabled', tool: 'rules', risk: 'auto', app: r.app, summary: `قانون خودکار خاموش شد: ${describeRule(r)}`, status: 'ok' });
  statusCache.at = 0;
  res.json({ ok: true });
});

// ---- status panel ----
let statusCache = { at: 0, data: null };
async function buildStatus() {
  const settle = (p) => p.then((v) => v, (e) => ({ error: e.fa || e.message }));
  const [billing, apps, cat] = await Promise.all([settle(liara.billing()), settle(liara.listApps()), settle(liara.catalog())]);
  const list = Array.isArray(apps) ? apps : [];
  const managed = new Set(managedApps());
  const detailed = await Promise.all(list.map(async (a) => {
    const base = { name: a.name, platform: a.platform, status: a.status, scale: a.scale, planID: a.planID, isDeployed: a.isDeployed, managed: canModify(a.name), url: liara.appUrl(a.name) };
    if (!managed.has(a.name)) return base;
    const [sum, rel] = await Promise.all([settle(liara.metricsSummary(a.name)), settle(liara.listReleases(a.name, 1))]);
    const plan = cat.plans?.find((p) => p.id === a.planID);
    const memMB = sum.error ? null : Math.round((sum.memoryBytes || 0) / MB);
    return {
      ...base,
      memMB,
      ramLimitMB: plan ? plan.ramGB * 1024 : null,
      cpu: sum.error ? null : sum.cpu,
      cpuLimit: plan?.cpu ?? null,
      lastRelease: rel.releases?.[0] ? { tag: rel.releases[0].tag, state: rel.releases[0].state, at: rel.releases[0].finishedAt || rel.releases[0].createdAt } : null,
      health: healthSnapshot(a.name),
      watchPaths: appInfo(a.name)?.watchPaths || ['/'],
    };
  }));
  return {
    mode: config.liaraMode,
    balance: billing.error ? null : Math.round(billing.balance),
    account: billing.error ? null : billing.account,
    balanceError: billing.error || null,
    appsError: apps.error || null,
    apps: detailed.sort((x, y) => Number(y.managed) - Number(x.managed)),
    rules: listRules().map((r) => ({ id: r.id, app: r.app, fa: r.fa, action: r.action, firedLastHour: r.firedLastHour, maxPerHour: r.maxPerHour, lastFiredAt: r.fired.at(-1) || null })),
    at: Date.now(),
  };
}

app.get('/api/status', async (_req, res) => {
  try {
    if (!statusCache.data || Date.now() - statusCache.at > 4000) statusCache = { at: Date.now(), data: await buildStatus() };
    res.json(statusCache.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/apps/:name/metrics', async (req, res) => {
  // A day is the longest range worth asking for: Liara returns about one day even for a week.
  const minutes = Math.min(1440, Math.max(1, Number(req.query.minutes) || 30));
  const since = Math.floor(Date.now() / 1000) - minutes * 60;
  try {
    const [mem, cpu] = await Promise.all([liara.metric(req.params.name, 'memory', since), liara.metric(req.params.name, 'cpu', since)]);
    res.json({
      minutes,
      memory: downsample(mem).map((p) => ({ t: p.t, mb: Math.round(p.v / MB), hiMb: Math.round(p.hi / MB) })),
      cpu: downsample(cpu).map((p) => ({ t: p.t, v: p.v, hi: p.hi })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.fa || e.message });
  }
});

app.get('/api/apps/:name/logs', async (req, res) => {
  try {
    const lines = await liara.logs(req.params.name, { startSec: Math.floor(Date.now() / 1000) - 5 * 60, limit: 60 });
    res.json({ lines: lines.map((l) => ({ t: l.t, line: l.line.slice(0, 300), err: /error|exception|fatal|killed|unhandled/i.test(l.line) })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.fa || e.message });
  }
});

app.get('/api/audit', (req, res) => res.json(recentAudit(Number(req.query.limit || 80))));
auditBus.on('entry', (rec) => broadcast('audit', { entry: rec }));

// ---- static UI ----
app.use(express.static(path.join(config.root, 'web'), { extensions: ['html'] }));
app.use('/assets', express.static(path.join(config.root, 'assets')));

startWatcher(liara, (alert) => broadcast('alert', { alert }), makeRuleRunner(liara, (type, data) => { statusCache.at = 0; broadcast(type, data); }));

const server = app.listen(config.port, config.host, () => {
  const c = publicConfig();
  console.log(`Liara Copilot on http://localhost:${config.port}  (liara: ${c.liaraMode}, llm: ${c.llmProvider}/${c.llmModel}, token: ${c.hasLiaraToken ? 'yes' : 'NO'})`);
});

const shutdown = async () => {
  server.close();
  if (liara.shutdown) await liara.shutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
