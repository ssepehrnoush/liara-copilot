// Reads a project folder (or a public GitHub repo) and works out what Liara needs:
// platform, port, start command, env vars the code reads, size, and a plan suggestion.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ignore from 'ignore';
import * as tar from 'tar';
import { config } from './config.js';

export const DEFAULT_IGNORES = [
  '.git', '.idea', '.vscode', '.next', '*.*~', 'node_modules', 'bower_components', '.DS_Store',
  'venv', '.venv', '__pycache__', '*.py[cod]', 'vendor', '.env', '.env.*', '!.env.example', 'liara.json',
  'dist', 'build', 'coverage', '*.log', 'LIARA_COPILOT_TASK.md',
];

const SOURCE_EXT = /\.(m?js|cjs|ts|tsx|jsx|py|php|go|cs|rb|vue|svelte|json|ya?ml|toml|env\.example)$/i;
const IGNORED_ENV = new Set(['PORT', 'NODE_ENV', 'HOME', 'PATH', 'PWD', 'HOSTNAME', 'TZ', 'CI', 'npm_package_version']);

export function makeIgnore(dir) {
  const ig = ignore().add(DEFAULT_IGNORES);
  for (const f of ['.gitignore', '.liaraignore']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) ig.add(fs.readFileSync(p, 'utf8'));
  }
  return ig;
}

export function listFiles(dir, ig = makeIgnore(dir), maxFiles = 20000) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ig.ignores(ent.isDirectory() ? `${r}/` : r)) continue;
      if (ent.isDirectory()) walk(r);
      else if (ent.isFile()) {
        out.push(r);
        if (out.length >= maxFiles) return;
      }
    }
  };
  walk('');
  return out;
}

// Fetch a public GitHub repo as a tarball and extract it to a workspace folder.
export async function fetchGithub(url) {
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^\s#?]+))?\/?$/i);
  if (!m) throw new Error('آدرس گیت‌هاب معتبر نیست. نمونه: https://github.com/user/repo');
  const [, owner, repo, branch] = m;
  const ref = branch || 'HEAD';
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`دانلود ریپو ناموفق بود (HTTP ${res.status}). ریپو باید عمومی باشد.`);
  const dest = path.join(config.dataDir, 'workspace', `${owner}-${repo}-${Date.now()}`);
  fs.mkdirSync(dest, { recursive: true });
  const tmp = path.join(os.tmpdir(), `lc-${Date.now()}.tgz`);
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  await tar.x({ file: tmp, cwd: dest, strip: 1 });
  fs.rmSync(tmp, { force: true });
  return dest;
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function detectPlatform(dir, files) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const pkg = has('package.json') ? readJSON(path.join(dir, 'package.json')) : null;
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (has('liara.json')) {
    const lj = readJSON(path.join(dir, 'liara.json'));
    if (lj?.platform) return { platform: lj.platform, reason: 'liara.json', liaraJson: lj, pkg, deps };
  }
  if (files.some((f) => /\.csproj$/.test(f))) return { platform: 'dotnet', reason: 'فایل .csproj', pkg, deps };
  if (has('composer.json')) {
    const c = readJSON(path.join(dir, 'composer.json'));
    return { platform: c?.require?.['laravel/framework'] ? 'laravel' : 'php', reason: 'composer.json', pkg, deps };
  }
  if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile')) {
    const req = has('requirements.txt') ? fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8').toLowerCase() : '';
    if (req.includes('django')) return { platform: 'django', reason: 'Django در requirements.txt', pkg, deps };
    if (req.includes('flask')) return { platform: 'flask', reason: 'Flask در requirements.txt', pkg, deps };
    return { platform: 'python', reason: 'پروژهٔ پایتون', pkg, deps };
  }
  if (has('go.mod')) return { platform: 'go', reason: 'go.mod', pkg, deps };
  if (pkg) {
    if (deps.next) return { platform: 'next', reason: 'وابستگی next در package.json', pkg, deps };
    if (deps['@angular/core']) return { platform: 'angular', reason: 'Angular', pkg, deps };
    if (deps.vue && !deps.express) return { platform: 'vue', reason: 'Vue (سایت استاتیک بعد از بیلد)', pkg, deps };
    if (deps.react && !deps.express && (deps.vite || deps['react-scripts'])) return { platform: 'react', reason: 'React (سایت استاتیک بعد از بیلد)', pkg, deps };
    return { platform: 'node', reason: 'package.json (Node.js)', pkg, deps };
  }
  if (has('Dockerfile')) return { platform: 'docker', reason: 'Dockerfile', pkg, deps };
  if (has('index.php')) return { platform: 'php', reason: 'index.php', pkg, deps };
  if (has('index.html')) return { platform: 'static', reason: 'index.html (سایت استاتیک)', pkg, deps };
  return { platform: null, reason: 'نوع پروژه تشخیص داده نشد', pkg, deps };
}

function scanCode(dir, files) {
  const envs = new Map();
  const ports = new Map();
  const routes = new Set();
  const add = (k, file) => {
    if (!k || IGNORED_ENV.has(k) || k.startsWith('npm_')) return;
    if (!envs.has(k)) envs.set(k, new Set());
    envs.get(k).add(file);
  };
  let scanned = 0;
  for (const f of files) {
    if (!SOURCE_EXT.test(f) || /package-lock|yarn\.lock|pnpm-lock/.test(f)) continue;
    const abs = path.join(dir, f);
    let txt;
    try {
      if (fs.statSync(abs).size > 400 * 1024) continue;
      txt = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    scanned++;
    for (const m of txt.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) add(m[1], f);
    for (const m of txt.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) add(m[1], f);
    for (const m of txt.matchAll(/os\.(?:environ\.get|getenv|environ\[)\(?\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) add(m[1], f);
    for (const m of txt.matchAll(/\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) add(m[1], f);
    for (const m of txt.matchAll(/os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g)) add(m[1], f);
    for (const m of txt.matchAll(/(?:\.get\(\s*|(?:pathname|url|path)\s*===\s*|@app\.route\(\s*)['"](\/[a-z0-9\-/]*)['"]/gi)) {
      // Only pages that are safe to hit repeatedly: no admin, writes or user-content endpoints.
      if (!/admin|internal|debug|chaos|metrics|review|comment|webhook|callback|login|logout|signup|register|delete|reset|upload/i.test(m[1])) routes.add(m[1]);
    }
    for (const m of txt.matchAll(/(?:PORT\s*\|\|\s*|listen\(\s*|port\s*[:=]\s*)(\d{4,5})\b/g)) {
      const p = Number(m[1]);
      if (p >= 1000 && p < 65536) ports.set(p, (ports.get(p) || 0) + 1);
    }
  }
  if (fs.existsSync(path.join(dir, '.env.example'))) {
    for (const line of fs.readFileSync(path.join(dir, '.env.example'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
      if (m) add(m[1], '.env.example');
    }
  }
  return {
    scanned,
    envs: [...envs.entries()].map(([key, set]) => ({ key, files: [...set].slice(0, 3) })),
    port: [...ports.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    routes: [...routes].slice(0, 12),
  };
}

const HEAVY_DEPS = ['puppeteer', 'playwright', 'sharp', 'tensorflow', '@tensorflow/tfjs-node', 'canvas', 'ffmpeg', 'torch', 'opencv'];
const DB_DEPS = {
  pg: 'PostgreSQL', 'pg-promise': 'PostgreSQL', mysql: 'MySQL', mysql2: 'MySQL', mongoose: 'MongoDB', mongodb: 'MongoDB',
  redis: 'Redis', ioredis: 'Redis', prisma: 'دیتابیس (Prisma)', '@prisma/client': 'دیتابیس (Prisma)', sequelize: 'SQL', typeorm: 'SQL',
  psycopg2: 'PostgreSQL', 'psycopg2-binary': 'PostgreSQL', pymongo: 'MongoDB',
};

const DEFAULT_PORT = { node: 3000, next: 3000, flask: 5000, django: 8000, python: 8000, go: 8080, php: 80, laravel: 80, static: 80, react: 80, vue: 80, angular: 80, dotnet: 80, docker: 80 };

export function recommendPlan(analysis, catalog) {
  const plans = catalog?.plans || [];
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]));
  let target = 'small-g2';
  const why = [];
  if (['static', 'react', 'vue', 'angular'].includes(analysis.platform)) {
    why.push('سایت استاتیک است و منابع کمی لازم دارد');
  } else if (analysis.platform === 'next' || analysis.heavyDeps.length) {
    target = 'medium-g2';
    why.push(analysis.platform === 'next' ? 'Next.js برای رندر سمت سرور حدود ۱ گیگ رم می‌خواهد' : `کتابخانهٔ سنگین (${analysis.heavyDeps.join('، ')}) رم بیشتری لازم دارد`);
  } else {
    why.push('برای یک سرویس وب سبک، کوچک‌ترین پلن کافی است و بعداً با دیدن مصرف واقعی قابل ارتقاست');
  }
  if (analysis.sizeMB > 150) why.push('حجم پروژه زیاد است؛ فایل‌های اضافه را در .gitignore بگذارید');
  const plan = byId[target] || plans[0] || null;
  const bundle = plan?.bundles?.find((b) => b.id === 'basic') || plan?.bundles?.[0] || null;
  return {
    planID: plan?.id || target,
    bundlePlanID: bundle?.id || 'basic',
    cpu: plan?.cpu,
    ramGB: plan?.ramGB,
    diskGB: plan?.diskGB,
    monthlyToman: plan && bundle ? plan.monthly + bundle.monthly : null,
    hourlyToman: plan && bundle ? Math.round((plan.hourly + bundle.hourly) * 100) / 100 : null,
    why,
    alternatives: plans.filter((p) => p.id !== plan?.id).slice(0, 3).map((p) => ({ planID: p.id, cpu: p.cpu, ramGB: p.ramGB, monthlyToman: p.monthly + (p.bundles.find((b) => b.id === 'basic')?.monthly || 0) })),
  };
}

export async function analyzeProject(source) {
  let dir = source;
  let origin = 'local';
  if (/^https?:\/\/(www\.)?github\.com\//i.test(source)) {
    dir = await fetchGithub(source);
    origin = 'github';
  }
  dir = path.isAbsolute(dir) || fs.existsSync(path.resolve(dir)) ? path.resolve(dir) : path.resolve(config.root, dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`پوشهٔ پروژه پیدا نشد: ${source}`);
  }
  const ig = makeIgnore(dir);
  const files = listFiles(dir, ig);
  if (!files.length) throw new Error('پوشهٔ پروژه خالی است.');
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
  }
  const det = detectPlatform(dir, files);
  const scan = scanCode(dir, files);
  const deps = Object.keys(det.deps || {});
  let pyReq = '';
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) pyReq = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8').toLowerCase();
  const heavyDeps = HEAVY_DEPS.filter((d) => deps.includes(d) || pyReq.includes(d));
  const databases = [...new Set(Object.entries(DB_DEPS).filter(([d]) => deps.includes(d) || pyReq.includes(d)).map(([, v]) => v))];
  const port = det.liaraJson?.port || scan.port || DEFAULT_PORT[det.platform] || 3000;
  const pkg = det.pkg;
  const warnings = [];
  if (det.platform === 'node' && !pkg?.scripts?.start) warnings.push('در package.json اسکریپت start نیست؛ لیارا برای اجرای اپ Node به `npm start` نیاز دارد.');
  if (fs.existsSync(path.join(dir, '.env'))) warnings.push('فایل .env در پروژه هست. این فایل آپلود نمی‌شود؛ مقادیرش را به‌صورت متغیر محیطی امن در لیارا ثبت می‌کنیم.');
  if (!det.platform) warnings.push('نوع پروژه مشخص نشد. اگر Dockerfile اضافه کنید، روی پلتفرم docker قابل اجراست.');
  const name = (det.liaraJson?.app || pkg?.name || path.basename(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'my-app';
  return {
    dir,
    origin,
    platform: det.platform,
    platformReason: det.reason,
    suggestedName: name,
    port,
    startCommand: pkg?.scripts?.start || null,
    nodeVersion: pkg?.engines?.node || null,
    files: files.length,
    sizeMB: Math.round((bytes / 1024 / 1024) * 100) / 100,
    dependencies: deps.slice(0, 25),
    heavyDeps,
    databases,
    envVars: scan.envs,
    routes: scan.routes,
    warnings,
    liaraJson: det.liaraJson || null,
  };
}

// Read-only helpers for the SRE agent to look at the code it deployed.
export function searchCode(dir, pattern, maxHits = 30) {
  const ig = makeIgnore(dir);
  const files = listFiles(dir, ig).filter((f) => SOURCE_EXT.test(f) && !/lock/.test(f));
  let re;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (hits.length < maxHits && re.test(line)) hits.push({ file: f, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return hits;
}

export function readFileSafe(dir, rel, fromLine = 1, toLine = 120) {
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir))) throw new Error('مسیر خارج از پوشهٔ پروژه است.');
  if (makeIgnore(dir).ignores(path.relative(dir, abs).split(path.sep).join('/'))) throw new Error('این فایل جزو فایل‌های نادیده‌گرفته‌شده (مثل .env) است و خوانده نمی‌شود.');
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const a = Math.max(1, fromLine);
  const b = Math.min(lines.length, toLine);
  return { file: rel, from: a, to: b, total: lines.length, text: lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n') };
}
