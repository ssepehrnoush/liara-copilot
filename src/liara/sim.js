// Local stand-in for the Liara API with the same normalized interface as client.js.
// It really runs each app as a Node process with the plan's memory limit, captures its
// stdout as logs, samples RSS/CPU as metrics and emits OOM/restart events, so the whole
// deploy -> incident -> fix -> verify loop can be tested before the account has credit.
// The UI always labels this mode as "شبیه‌ساز".
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { LiaraError } from './client.js';

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sim-preload.cjs');

// Same numbers as the real /v1/me catalog (checked 2026-10-21).
const bundle = (id, monthly, hourly) => ({
  id, monthly, hourly, zeroDowntime: id !== 'basic', rollback: true,
  logsRetentionDays: { basic: 7, standard: 30, pro: 60 }[id], metricsRetentionDays: { basic: 7, standard: 30, pro: 60 }[id], buildTimeoutMin: 10, maxSourceMB: 256,
});
const CATALOG = {
  plans: [
    { id: 'small-g2', cpu: 0.5, ramGB: 0.5, diskGB: 5, hourly: 659.72, monthly: 475000, bundles: [bundle('basic', 275000, 381), bundle('standard', 475000, 659), bundle('pro', 825000, 1145)] },
    { id: 'medium-g2', cpu: 1, ramGB: 1, diskGB: 10, hourly: 1145.83, monthly: 825000, bundles: [bundle('basic', 475000, 659), bundle('standard', 825000, 1145), bundle('pro', 1475000, 2048)] },
    { id: 'standard-base-g2', cpu: 1, ramGB: 2, diskGB: 20, hourly: 2048.61, monthly: 1475000, bundles: [bundle('basic', 825000, 1145), bundle('standard', 1475000, 2048), bundle('pro', 2650000, 3680)] },
    { id: 'standard-plus-g2', cpu: 2, ramGB: 4, diskGB: 40, hourly: 3680.55, monthly: 2650000, bundles: [bundle('basic', 1475000, 2048), bundle('standard', 2650000, 3680), bundle('pro', 4600000, 6388)] },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

export class LiaraSim {
  constructor({ dataDir, balance = 2500000 }) {
    this.mode = 'sim';
    this.dir = path.join(dataDir, 'sim');
    fs.mkdirSync(path.join(this.dir, 'sources'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'releases'), { recursive: true });
    this.stateFile = path.join(this.dir, 'state.json');
    this.apps = new Map();
    this.releases = new Map();
    this.balance = balance;
    this.load();
  }

  // ---------- persistence ----------
  load() {
    let st = {};
    try { st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { st = {}; }
    if (typeof st.balance === 'number') this.balance = st.balance;
    for (const r of st.releases || []) this.releases.set(r.id, { ...r, buildLines: [] });
    for (const a of st.apps || []) {
      this.apps.set(a.name, { ...a, proc: null, logs: [], events: [], mem: [], cpu: [], restarts: 0 });
    }
    this._restoring = [...this.apps.values()].filter((a) => a.currentRelease && a.scale > 0);
  }

  async restore() {
    for (const app of this._restoring || []) {
      this.event(app, 'Simulator restarted: starting container again');
      this.startProc(app).catch(() => {});
    }
    this._restoring = [];
  }

  save() {
    const apps = [...this.apps.values()].map(({ proc, logs, events, mem, cpu, restarts, stopping, ...rest }) => rest);
    const releases = [...this.releases.values()].map(({ buildLines, ...r }) => r);
    fs.writeFileSync(this.stateFile, JSON.stringify({ balance: this.balance, apps, releases }, null, 2));
  }

  // ---------- helpers ----------
  appUrl(name) {
    const a = this.apps.get(name);
    return a?.port ? `http://127.0.0.1:${a.port}` : `http://127.0.0.1:1`;
  }

  must(name) {
    const a = this.apps.get(name);
    if (!a) throw new LiaraError(404, 'App does not exists.', `/v1/projects/${name}`);
    return a;
  }

  log(app, line, stream = 'stdout') {
    app.logs.push({ t: Date.now(), line, stream, releaseId: app.currentRelease });
    if (app.logs.length > 5000) app.logs.splice(0, app.logs.length - 5000);
  }

  event(app, text) {
    app.events.push({ t: Date.now(), text, meta: {} });
    if (app.events.length > 500) app.events.shift();
  }

  plan(app) {
    return CATALOG.plans.find((p) => p.id === app.planID) || CATALOG.plans[0];
  }

  // ---------- process lifecycle ----------
  async startProc(app) {
    const rel = this.releases.get(app.currentRelease);
    if (!rel) return false;
    const cwd = path.join(this.dir, 'releases', rel.id);
    let entry = 'index.js';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const m = (pkg.scripts?.start || '').match(/node\s+([^\s]+)/);
      entry = m ? m[1] : pkg.main || (fs.existsSync(path.join(cwd, 'server.js')) ? 'server.js' : 'index.js');
    } catch { /* default entry */ }
    if (!app.port) app.port = await freePort(4300 + this.apps.size);
    const heapMB = Math.round(this.plan(app).ramGB * 1024 * 0.7);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', ...Object.fromEntries(app.envs.map((e) => [e.key, e.value])), PORT: String(app.port), SIM_RAM_LIMIT_MB: String(this.plan(app).ramGB * 1024) };
    const child = spawn(process.execPath, [`--max-old-space-size=${heapMB}`, '-r', PRELOAD, entry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    app.proc = child;
    app.status = 'RUNNING';
    app.startedAt = Date.now();
    app.lastCpu = null;
    this.event(app, `Started container ${app.name}-${rel.id.slice(0, 6)} (plan ${app.planID}, memory limit ${this.plan(app).ramGB * 1024}Mi)`);
    let stderrTail = '';
    const onData = (stream) => (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (stream === 'stderr') stderrTail = (stderrTail + '\n' + line).slice(-2000);
        this.log(app, line, stream);
      }
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    child.on('message', (m) => {
      if (!m || m.type !== 'metrics') return;
      app.mem.push({ t: Date.now(), v: m.rss });
      if (app.lastCpu) {
        const used = (m.cpu - app.lastCpu.cpu) / 1e6 / ((Date.now() - app.lastCpu.t) / 1000);
        app.cpu.push({ t: Date.now(), v: Math.max(0, Math.min(this.plan(app).cpu, used)) });
      }
      app.lastCpu = { cpu: m.cpu, t: Date.now() };
      const cut = Date.now() - 3 * 3600 * 1000;
      while (app.mem.length && app.mem[0].t < cut) app.mem.shift();
      while (app.cpu.length && app.cpu[0].t < cut) app.cpu.shift();
      // Hard RAM limit like a container cgroup: kill when RSS exceeds the plan.
      if (m.rss > this.plan(app).ramGB * 1024 * 1024 * 1024) {
        app.oomPending = true;
        child.kill('SIGKILL');
      }
    });
    child.on('exit', (code, signal) => {
      if (app.proc !== child) return;
      app.proc = null;
      if (app.stopping) {
        app.stopping = false;
        return;
      }
      const oom = app.oomPending || /heap out of memory|Allocation failed/i.test(stderrTail);
      app.oomPending = false;
      app.restarts = (app.restarts || 0) + 1;
      app.status = 'RESTARTING';
      if (oom) {
        this.event(app, 'OOMKilled: container exceeded its memory limit and was killed (exit code 137)');
        this.log(app, 'Killed', 'stderr');
      } else {
        this.event(app, `Container exited with code ${code ?? signal}`);
      }
      this.event(app, 'Back-off restarting failed container');
      setTimeout(() => { if (!app.proc && app.scale > 0) this.startProc(app); }, 2500);
    });
    return true;
  }

  async stopProc(app) {
    if (!app.proc) return;
    const p = app.proc;
    app.stopping = true;
    p.kill();
    await new Promise((r) => { p.once('exit', r); setTimeout(r, 3000); });
    app.proc = null;
  }

  async waitHealthy(app, ms = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        const r = await fetch(`http://127.0.0.1:${app.port}/`, { signal: AbortSignal.timeout(2000) });
        if (r.status > 0) return true;
      } catch { /* not up yet */ }
      if (!app.proc) return false;
      await sleep(400);
    }
    return false;
  }

  // ---------- normalized API ----------
  async billing() {
    return { balance: this.balance, minCredit: 20000 };
  }

  async catalog() {
    return CATALOG;
  }

  view(a) {
    return {
      id: a.id, name: a.name, platform: a.platform, status: a.scale === 0 ? 'STOPPED' : a.status || 'NOT_DEPLOYED', scale: a.scale, planID: a.planID,
      bundlePlanID: a.bundlePlanID, isDeployed: Boolean(a.currentRelease), createdAt: a.createdAt, hourlyPrice: null, zeroDowntime: false,
      defaultSubdomain: true, envs: a.envs.map((e) => ({ ...e })),
    };
  }

  async listApps() {
    return [...this.apps.values()].map((a) => this.view(a));
  }

  async getApp(name) {
    return this.view(this.must(name));
  }

  async networks() {
    return [{ id: 'sim-network', name: 'default' }];
  }

  async createNetwork() {
    return {};
  }

  async createApp({ name, platform, planID, bundlePlanID }) {
    if (this.apps.has(name)) throw new LiaraError(409, 'App already exists', '/v1/projects');
    const plan = CATALOG.plans.find((p) => p.id === planID);
    if (!plan) throw new LiaraError(400, 'plan not found', '/v1/projects');
    if (this.balance < plan.hourly) throw new LiaraError(402, 'Not enough balance', '/v1/projects');
    const app = { id: randomUUID().replace(/-/g, '').slice(0, 24), name, platform, planID, bundlePlanID, envs: [], scale: 1, status: 'NOT_DEPLOYED', createdAt: new Date().toISOString(), currentRelease: null, port: null, proc: null, logs: [], events: [], mem: [], cpu: [], restarts: 0, domains: [] };
    this.apps.set(name, app);
    this.event(app, `App ${name} created on plan ${planID}`);
    this.save();
    return { project: { _id: app.id } };
  }

  async uploadSource(name, tgzPath) {
    this.must(name);
    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    fs.copyFileSync(tgzPath, path.join(this.dir, 'sources', `${id}.tar.gz`));
    await sleep(600);
    return id;
  }

  async createRelease(name, body) {
    const app = this.must(name);
    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    const n = [...this.releases.values()].filter((r) => r.app === name).length + 1;
    const rel = { id, app: name, tag: `v${n}`, state: 'QUEUED', port: body.port, platform: body.type, sourceID: body.sourceID, createdAt: new Date().toISOString(), finishedAt: null, failReason: null, sourceAvailable: true, message: body.message, buildLines: [] };
    this.releases.set(id, rel);
    this.save();
    this.build(app, rel).catch((e) => { rel.state = 'FAILED'; rel.failReason = e.message; this.save(); });
    return id;
  }

  async build(app, rel) {
    const line = (l, stream = 'STDOUT') => rel.buildLines.push({ line: `${l}\n`, stream, createdAt: new Date().toISOString() });
    await sleep(800);
    rel.state = 'BUILDING';
    line(`Creating build environment for ${rel.platform}...`);
    const dest = path.join(this.dir, 'releases', rel.id);
    fs.mkdirSync(dest, { recursive: true });
    await tar.x({ file: path.join(this.dir, 'sources', `${rel.sourceID}.tar.gz`), cwd: dest });
    line(`Detected platform: ${rel.platform}, Node ${process.versions.node}`);
    await sleep(700);
    const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')); } catch { return {}; } })();
    const deps = Object.keys(pkg.dependencies || {});
    line(deps.length ? `npm ci --omit=dev (${deps.length} packages)` : 'npm ci --omit=dev (no dependencies)');
    await sleep(900);
    line('Successfully built image');
    line('Successfully tagged release image');
    rel.state = 'PUSHING';
    line('Pushing... 100%');
    await sleep(500);
    rel.state = 'DEPLOYING';
    await this.stopProc(app);
    const prev = app.currentRelease;
    app.currentRelease = rel.id;
    app.restarts = 0;
    await this.startProc(app);
    const healthy = await this.waitHealthy(app);
    rel.finishedAt = new Date().toISOString();
    if (healthy) {
      rel.state = 'READY';
      this.event(app, `Release ${rel.tag} is ready`);
    } else {
      rel.state = 'UNHEALTHY';
      rel.failReason = 'container did not become healthy';
      this.event(app, `Release ${rel.tag} is unhealthy; container did not answer on port ${app.port}`);
      if (prev) app.currentRelease = prev;
    }
    this.save();
  }

  async getRelease(id) {
    const r = this.releases.get(id);
    if (!r) throw new LiaraError(404, 'release not found', `/v1/releases/${id}`);
    return { state: r.state, failReason: r.failReason, queue: 0 };
  }

  async buildLogs(id, since) {
    const r = this.releases.get(id);
    if (!r) throw new LiaraError(404, 'release not found', `/v2/releases/${id}/build-logs`);
    const lines = since ? r.buildLines.filter((l) => l.createdAt > since) : r.buildLines;
    return { release: { state: r.state, failReason: r.failReason }, lines };
  }

  async listReleases(name, count = 10) {
    const app = this.must(name);
    const rels = [...this.releases.values()].filter((r) => r.app === name).reverse().slice(0, count);
    return { current: app.currentRelease, releases: rels.map(({ buildLines, app: _a, ...r }) => r) };
  }

  async logs(name, { startSec, limit = 400 } = {}) {
    const app = this.must(name);
    const from = (startSec || 0) * 1000;
    return app.logs.filter((l) => l.t >= from).slice(-limit).map((l) => ({ ...l }));
  }

  async events(name, { startSec, endSec } = {}) {
    const app = this.must(name);
    const from = (startSec || 0) * 1000;
    const to = endSec ? endSec * 1000 : Infinity;
    return app.events.filter((e) => e.t >= from && e.t <= to);
  }

  async applets(name) {
    const app = this.must(name);
    if (!app.currentRelease || app.scale === 0) return [];
    const rel = this.releases.get(app.currentRelease);
    return [{ id: `${app.name}-${app.currentRelease.slice(0, 6)}`, name: app.name, state: app.proc ? 'RUNNING' : 'RESTARTING', reason: app.restarts ? `restarts: ${app.restarts}` : null, since: new Date(app.startedAt || Date.now()).toISOString(), releaseTag: rel?.tag }];
  }

  async metricsSummary(name) {
    const app = this.must(name);
    return { cpu: app.cpu.at(-1)?.v || 0, memoryBytes: app.proc ? app.mem.at(-1)?.v || 0 : 0, disks: [] };
  }

  async metric(name, kind, sinceSec) {
    const app = this.must(name);
    const from = (sinceSec || 0) * 1000;
    const src = kind === 'cpu' ? app.cpu : kind === 'memory' ? app.mem : [];
    // Bucket into 15 s points like a metrics backend would.
    const buckets = new Map();
    for (const p of src) {
      if (p.t < from) continue;
      const b = Math.floor(p.t / 15000) * 15000;
      const cur = buckets.get(b);
      buckets.set(b, cur ? { s: cur.s + p.v, n: cur.n + 1 } : { s: p.v, n: 1 });
    }
    return [...buckets.entries()].map(([t, { s, n }]) => ({ t, v: s / n }));
  }

  async updateEnvs(name, variables) {
    const app = this.must(name);
    app.envs = variables.map((v) => ({ key: v.key, value: String(v.value), encrypted: false }));
    this.event(app, 'Environment variables updated; restarting container');
    this.save();
    if (app.currentRelease && app.scale > 0) {
      await this.stopProc(app);
      app.restarts = 0;
      await this.startProc(app);
    }
    return { message: 'envs updated' };
  }

  async restart(name) {
    const app = this.must(name);
    this.event(app, 'Restart requested by user');
    await this.stopProc(app);
    app.restarts = 0;
    if (app.scale > 0) await this.startProc(app);
    return {};
  }

  async scale(name, scale) {
    const app = this.must(name);
    app.scale = scale;
    this.event(app, scale ? 'App turned on' : 'App turned off');
    if (scale === 0) await this.stopProc(app);
    else if (!app.proc) await this.startProc(app);
    this.save();
    return {};
  }

  async resize(name, planID, bundlePlanID) {
    const app = this.must(name);
    if (!CATALOG.plans.find((p) => p.id === planID)) throw new LiaraError(400, 'plan not found', `/v1/projects/${name}/resize`);
    app.planID = planID;
    if (bundlePlanID) app.bundlePlanID = bundlePlanID;
    this.event(app, `Plan changed to ${planID}; restarting with new resources`);
    this.save();
    await this.stopProc(app);
    if (app.scale > 0) await this.startProc(app);
    return {};
  }

  async setZeroDowntime() {
    return {};
  }

  async domains(name) {
    return (this.must(name).domains || []).map((d) => ({ ...d }));
  }

  async addDomain(name, domain) {
    const app = this.must(name);
    const d = { id: randomUUID().slice(0, 12), name: domain, status: 'PENDING_DNS', ssl: null, cname: `${name}.liara.run` };
    app.domains = [...(app.domains || []), d];
    this.save();
    return { _id: d.id };
  }

  async checkDomain(id) {
    for (const a of this.apps.values()) {
      const d = (a.domains || []).find((x) => x.id === id);
      if (d) return d;
    }
    throw new LiaraError(404, 'domain not found', `/v1/domains/${id}/check`);
  }

  async enableSsl() {
    return {};
  }

  async shutdown() {
    for (const a of this.apps.values()) await this.stopProc(a);
  }
}
