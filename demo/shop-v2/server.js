// Ketabkadeh v2: adds online checkout and a "trending now" box.
import http from 'node:http';
import { products } from './catalog.js';
import { createPaymentSession } from './payment.js';
import { recordView, trending, historySize } from './trending.js';

const PORT = Number(process.env.PORT || 3000);
const SHOP_NAME = process.env.SHOP_NAME || 'کتاب‌کده';
const fmt = (n) => n.toLocaleString('fa-IR');

function log(level, msg) {
  console.log(`${new Date().toISOString()} ${level} ${msg}`);
}

function page(title, body) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:Vazirmatn,Tahoma,sans-serif;margin:0;background:#faf7f2;color:#2b2420}
header{background:#3d2c24;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}
header a{color:#f6d9a8;text-decoration:none;margin-inline-start:16px}
main{max-width:980px;margin:24px auto;padding:0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
.card{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 3px #0001}
.card h3{margin:0 0 6px;font-size:16px}.muted{color:#7a6d64;font-size:13px}.price{color:#a0522d;font-weight:bold}
.trend{background:#fff3e0;border-radius:12px;padding:10px 16px;margin-bottom:18px}
.btn{display:inline-block;background:#a0522d;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none}
</style></head><body><header><strong>${SHOP_NAME}</strong><nav><a href="/">کتاب‌ها</a><a href="/checkout">سبد خرید</a></nav></header><main>${body}</main></body></html>`;
}

function home(req) {
  const list = products.slice(0, 24);
  recordView(req, products);
  const top = trending().map((p) => p.title).join('، ');
  const cards = list.map((p) => `<div class="card"><h3>${p.title}</h3><div class="muted">${p.author}</div><div class="price">${fmt(p.price)} تومان</div></div>`).join('');
  return page(SHOP_NAME, `<div class="trend">پرطرفدارهای امروز: ${top}</div><h2>تازه‌های کتاب‌فروشی</h2><div class="grid">${cards}</div>`);
}

function checkout() {
  const cart = [{ id: 3, price: products[2].price, qty: 1 }, { id: 9, price: products[8].price, qty: 2 }];
  const session = createPaymentSession(cart);
  return page('پرداخت', `<h2>سبد خرید</h2><p>مبلغ قابل پرداخت: <b>${fmt(session.total)} تومان</b></p><p class="muted">درگاه: ${session.gateway}، شناسهٔ پرداخت ${session.sessionId}</p><a class="btn" href="#">پرداخت آنلاین</a>`);
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, 'http://x');
  const done = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
    log(status >= 500 ? 'ERROR' : 'INFO', `${req.method} ${url.pathname} ${status} ${Date.now() - t0}ms`);
  };
  try {
    if (url.pathname === '/') return done(200, 'text/html; charset=utf-8', home(req));
    if (url.pathname === '/checkout') return done(200, 'text/html; charset=utf-8', checkout());
    if (url.pathname === '/api/products') {
      recordView(req, products);
      return done(200, 'application/json', JSON.stringify({ items: products.slice(0, 50), trending: trending().map((p) => p.id) }));
    }
    if (url.pathname === '/api/review') {
      // Visitors' reviews are logged for moderation (user-generated text ends up in the logs).
      const text = (url.searchParams.get('text') || '').slice(0, 500);
      log('INFO', `new review for book ${Number(url.searchParams.get('book')) || 0}: ${text}`);
      return done(200, 'application/json', '{"ok":true}');
    }
    if (url.pathname === '/health') return done(200, 'application/json', '{"ok":true}');
    return done(404, 'text/plain; charset=utf-8', 'not found');
  } catch (err) {
    console.error(`${new Date().toISOString()} ERROR Unhandled error on ${req.method} ${url.pathname}: ${err.stack}`);
    return done(500, 'text/plain; charset=utf-8', 'Internal Server Error');
  }
});

setInterval(() => {
  const m = process.memoryUsage();
  log('INFO', `stats viewHistory=${historySize()} heapUsed=${Math.round(m.heapUsed / 1048576)}MB rss=${Math.round(m.rss / 1048576)}MB`);
}, 30000).unref();

server.listen(PORT, () => log('INFO', `${SHOP_NAME} v2 listening on port ${PORT}`));
