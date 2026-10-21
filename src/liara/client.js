// Thin client over the real Liara management API (https://api.liara.ir).
// Endpoints follow the official OpenAPI spec (developers.liara.ir/spec/paas.yaml)
// and the official CLI (@liara/cli 9.4.7) for deploy and logs v2.
// Every method returns normalized data so the agent and the simulator share one shape.
import fs from 'node:fs';

export class LiaraError extends Error {
  constructor(status, apiMessage, path) {
    super(`Liara API ${status} on ${path}: ${apiMessage || 'error'}`);
    this.status = status;
    this.apiMessage = apiMessage;
    this.path = path;
    this.fa = explainStatus(status, apiMessage);
  }
}

export function explainStatus(status, msg = '') {
  switch (status) {
    case 401: return 'توکن API لیارا نامعتبر یا منقضی است. از کنسول لیارا بخش «کلیدهای API» توکن تازه بسازید.';
    case 402: return 'موجودی حساب لیارا کافی نیست. لطفاً حساب را از کنسول لیارا شارژ کنید.';
    case 403: return `لیارا اجازهٔ این کار را نداد (${msg || 'دسترسی'}).`;
    case 404: return 'این سرویس یا منبع در حساب لیارا پیدا نشد.';
    case 409: return 'این نام قبلاً در لیارا استفاده شده. یک نام دیگر انتخاب کنید.';
    case 413: return 'حجم سورس از سقف مجاز پلن بیشتر است. فایل‌های اضافه را در .gitignore بگذارید.';
    case 429: return 'تعداد درخواست‌ها به API لیارا زیاد شده. چند ثانیه بعد دوباره امتحان می‌شود.';
    default: return status >= 500 ? 'سرور لیارا موقتاً خطا داد. کمی بعد دوباره تلاش می‌شود.' : `خطای ${status} از API لیارا: ${msg}`;
  }
}

const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function normProject(p = {}) {
  return {
    id: p._id,
    name: p.project_id,
    platform: p.type,
    status: p.status,
    scale: p.scale,
    planID: p.planID,
    bundlePlanID: p.bundlePlanID,
    isDeployed: p.isDeployed,
    createdAt: p.created_at,
    hourlyPrice: p.hourlyPrice,
    zeroDowntime: p.zeroDowntime,
    defaultSubdomain: p.defaultSubdomain,
    envs: (p.envs || []).map((e) => ({ key: e.key, value: e.value, encrypted: !!e.encrypted })),
  };
}

// Liara (Loki/Prometheus style) timestamps arrive as ns strings, s numbers or ISO strings.
function toMs(ts) {
  if (ts === undefined || ts === null) return null;
  if (typeof ts === 'string' && /^\d{16,}$/.test(ts)) return Number(BigInt(ts) / 1000000n);
  const n = Number(ts);
  if (!Number.isNaN(n)) return n > 1e12 ? n : n * 1000;
  const d = Date.parse(ts);
  return Number.isNaN(d) ? null : d;
}

export class LiaraApi {
  constructor({ baseURL, token, teamID = '', appDomainSuffix = 'liara.run' }) {
    this.baseURL = baseURL.replace(/\/$/, '');
    this.token = token;
    this.teamID = teamID;
    this.appDomainSuffix = appDomainSuffix;
    this.mode = 'real';
    this._catalog = null;
  }

  appUrl(name) {
    return `https://${name}.${this.appDomainSuffix}`;
  }

  async req(method, path, { query, json, body, timeoutMs = 20000, retries = 1 } = {}) {
    const url = new URL(this.baseURL + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (this.teamID) url.searchParams.set('teamID', this.teamID);
    const headers = { Authorization: `Bearer ${this.token}` };
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if (attempt < retries) continue;
        const err = new LiaraError(0, e.cause?.code || e.message, path);
        err.fa = 'ارتباط با API لیارا برقرار نشد (شبکه یا تایم‌اوت).';
        throw err;
      }
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (res.ok) return data;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new LiaraError(res.status, data?.message || data?.data?.code || text.slice(0, 200), path);
    }
  }

  // ---------- account ----------
  // In team mode /v1/billing still reports the personal wallet; the team wallet is in /v1/me.
  async billing() {
    if (this.teamID) {
      const d = await this.req('GET', '/v1/me');
      return { balance: Number(d?.team?.balance ?? 0), minCredit: d?.team?.minCreditAmount ?? null, account: d?.team?.teamName ? `تیم ${d.team.teamName}` : 'تیم' };
    }
    const d = await this.req('GET', '/v1/billing');
    return { balance: Number(d?.user?.balance ?? 0), minCredit: d?.user?.minCreditAmount ?? null, account: 'حساب شخصی' };
  }

  async teams() {
    const d = await this.req('GET', '/v2/teams');
    return (d.teams || []).map((t) => ({ id: t._id, name: t.name }));
  }

  async catalog() {
    if (this._catalog && Date.now() - this._catalog.at < 10 * 60 * 1000) return this._catalog.data;
    const d = await this.req('GET', '/v1/me');
    const projects = d?.plans?.projects || {};
    const bundles = d?.plans?.projectBundlePlans || {};
    const plans = Object.entries(projects)
      .filter(([id, p]) => p.available && (p.region || 'iran') === 'iran' && /g2$/.test(id))
      .map(([id, p]) => ({
        id,
        cpu: p.CPU?.amount,
        ramGB: p.RAM?.amount,
        diskGB: p.volume,
        hourly: p.price,
        monthly: p.displayPrice || Math.round(p.price * 720),
        bundles: Object.entries(bundles[id] || {})
          .filter(([, b]) => b.available)
          .map(([bid, b]) => ({
            id: bid,
            hourly: b.displayHourlyPrice,
            monthly: b.displayPrice,
            zeroDowntime: b.zeroDowntime,
            rollback: b.rollback,
            logsRetentionDays: b.maxLogsRetention,
            metricsRetentionDays: b.maxReportRetention,
            buildTimeoutMin: b.buildTimeout,
            maxSourceMB: b.maxSourceSize,
          })),
      }))
      .sort((a, b) => a.hourly - b.hourly);
    const data = { plans };
    this._catalog = { at: Date.now(), data };
    return data;
  }

  // ---------- apps ----------
  async listApps() {
    const d = await this.req('GET', '/v1/projects');
    return (d.projects || []).map(normProject);
  }

  async getApp(name) {
    const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}`);
    return normProject(d.project);
  }

  async createApp({ name, platform, planID, bundlePlanID, network }) {
    const json = { name, platform, planID, bundlePlanID };
    if (network) json.network = network;
    return this.req('POST', '/v1/projects', { json });
  }

  // Apps live in a private network; the official CLI refuses to create an app without one.
  async networks() {
    const d = await this.req('GET', '/v1/networks');
    return (d.networks || []).map((n) => ({ id: n._id, name: n.name }));
  }

  async createNetwork(networkName) {
    return this.req('POST', '/v1/networks', { json: { networkName } });
  }

  async restart(name) {
    return this.req('POST', `/v1/projects/${encodeURIComponent(name)}/actions/restart`);
  }

  async scale(name, scale) {
    return this.req('POST', `/v1/projects/${encodeURIComponent(name)}/actions/scale`, { json: { scale } });
  }

  async resize(name, planID, bundlePlanID) {
    const json = { planID };
    if (bundlePlanID) json.bundlePlanID = bundlePlanID;
    return this.req('POST', `/v1/projects/${encodeURIComponent(name)}/resize`, { json });
  }

  async updateEnvs(name, variables) {
    return this.req('POST', '/v1/projects/update-envs', { json: { project: name, variables } });
  }

  async setZeroDowntime(appId, enable) {
    return this.req('POST', `/v1/projects/${appId}/zero-downtime/${enable ? 'enable' : 'disable'}`);
  }

  // ---------- deploy ----------
  async uploadSource(name, tgzPath) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(tgzPath)], { type: 'application/gzip' }), 'source.tar.gz');
    const d = await this.req('POST', `/v2/projects/${encodeURIComponent(name)}/sources`, { body: fd, timeoutMs: 5 * 60 * 1000, retries: 0 });
    return d.sourceID;
  }

  async createRelease(name, body) {
    const d = await this.req('POST', `/v2/projects/${encodeURIComponent(name)}/releases`, { json: body, timeoutMs: 60000, retries: 0 });
    return d.releaseID;
  }

  async getRelease(releaseID) {
    const d = await this.req('GET', `/v1/releases/${releaseID}`);
    return d.release || d;
  }

  async buildLogs(releaseID, since) {
    const d = await this.req('GET', `/v2/releases/${releaseID}/build-logs`, { query: { since } });
    return { release: d.release || {}, lines: d.buildOutput || [] };
  }

  async listReleases(name, count = 10) {
    const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/releases`, { query: { page: 1, count } });
    return {
      current: d.currentRelease,
      releases: (d.releases || []).map((r) => ({
        id: r._id,
        tag: r.tag,
        state: r.state,
        port: r.port,
        platform: r.projectType || r.type,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
        failReason: r.failReason,
        sourceAvailable: r.sourceAvailable,
        sourceID: r.sourceID,
        message: r.gitInfo?.message || r.message || null,
      })),
    };
  }

  // ---------- observability ----------
  async logs(name, { startSec, limit = 400 } = {}) {
    const start = startSec ?? Math.floor(Date.now() / 1000) - 15 * 60;
    let lines = [];
    try {
      const d = await this.req('GET', `/v2/projects/${encodeURIComponent(name)}/logs`, { query: { start, direction: 'forward' }, timeoutMs: 20000 });
      for (const entry of d.data || []) {
        for (const v of entry.values || []) {
          // Each value is [ns timestamp, '{"type":"stdout","_entry":"<line>"}'].
          let line = String(v[1] ?? '');
          let stream;
          if (line.startsWith('{')) {
            try { const j = JSON.parse(line); line = String(j._entry ?? j.log ?? j.message ?? ''); stream = j.type; } catch { /* keep raw */ }
          }
          if (line.trim()) lines.push({ t: toMs(v[0]), line, stream, releaseId: entry.metaData?.releaseId });
        }
      }
    } catch (e) {
      if (e.status === 404) throw e;
      const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/logs`, { query: { since: start } });
      lines = (Array.isArray(d) ? d : d.data || []).map((l) => ({ t: toMs(l.datetime), line: String(l.message ?? ''), stream: l.type }));
    }
    lines.sort((a, b) => (a.t || 0) - (b.t || 0));
    return lines.slice(-limit);
  }

  async events(name, { startSec, endSec } = {}) {
    const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/events`, { query: { start: startSec, end: endSec } });
    const out = [];
    for (const entry of d.data || []) {
      for (const v of entry.values || []) out.push({ t: toMs(v[0]), text: String(v[1] ?? ''), meta: entry.metaData || {} });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // The applets endpoint answered 500 on our account (2026-10-21), so fall back to the
  // applet ids that the metrics summary reports: one entry per running container.
  async applets(name) {
    try {
      const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/applets`, { retries: 0 });
      return (d.applets || []).map((a) => ({ id: a.id, name: a.name, state: a.state, reason: a.reason, since: a.timestamp, releaseTag: a.release?.tag }));
    } catch (e) {
      if (e.status === 404) throw e;
      const s = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/metrics/summary`);
      return (s.memoryUsage || []).map((m) => ({ id: m.applet, name, state: 'RUNNING', reason: null, since: null, releaseTag: null, source: 'metrics' }));
    }
  }

  async metricsSummary(name) {
    const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/metrics/summary`);
    const last = (arr) => (arr || []).map((x) => toNum(Array.isArray(x.value) ? x.value[1] : x.value)).filter((v) => v !== null);
    return {
      cpu: last(d.cpuUsage).reduce((a, b) => a + b, 0),
      memoryBytes: last(d.memoryUsage).reduce((a, b) => a + b, 0),
      disks: d.disksUsage || [],
      raw: d,
    };
  }

  // kind: cpu | memory | network-receive | network-transmit
  async metric(name, kind, sinceSec) {
    const d = await this.req('GET', `/v1/projects/${encodeURIComponent(name)}/metrics/${kind}`, { query: { since: sinceSec } });
    const byT = new Map();
    for (const series of d.result || []) {
      for (const [ts, val] of series.values || []) {
        const t = toMs(ts);
        byT.set(t, (byT.get(t) || 0) + Number(val));
      }
    }
    return [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
  }

  // ---------- domains ----------
  async domains(name) {
    const d = await this.req('GET', '/v1/domains', { query: { project: name } });
    return (d.domains || []).map((x) => ({ id: x._id, name: x.name, status: x.status, ssl: x.certificatesStatus, cname: x.CNameRecord, redirectTo: x.redirectTo }));
  }

  async addDomain(name, domain) {
    const d = await this.req('POST', '/v1/domains', { json: { name: domain, project: name, type: 'PROJECT' } });
    return d.domain || d;
  }

  async checkDomain(id) {
    const d = await this.req('GET', `/v1/domains/${id}/check`);
    return d.domain || d;
  }

  async enableSsl(domain) {
    return this.req('POST', '/v1/domains/provision-ssl-certs', { json: { domain } });
  }
}
