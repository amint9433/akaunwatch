// AkaunWatch — community bank account checker.
// Zero-dependency Node.js server (node:http + node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SALT = process.env.HASH_SALT || 'change-me-in-production';
const PUBLIC_DIR = path.join(__dirname, 'public');

const BANKS = [
  'Maybank', 'CIMB Bank', 'Public Bank', 'RHB Bank', 'Hong Leong Bank', 'AmBank',
  'Bank Islam', 'Bank Rakyat', 'BSN', 'Affin Bank', 'Alliance Bank', 'Bank Muamalat',
  'OCBC Bank', 'UOB', 'HSBC', 'Standard Chartered', 'Agrobank', 'MBSB Bank',
  'Al Rajhi Bank', 'Kuwait Finance House', 'GXBank', 'Boost Bank', 'AEON Bank',
  "Touch 'n Go eWallet", 'Other',
];

const CATEGORIES = {
  shopping: 'Online shopping / fake seller',
  investment: 'Investment / crypto scam',
  impersonation: 'Impersonation (police, bank, LHDN, courier)',
  love: 'Love / romance scam',
  job: 'Job / task scam',
  loan: 'Loan scam',
  rental: 'Rental / property scam',
  ticket: 'Ticket / event / travel scam',
  other: 'Other',
};

// ---------- helpers ----------
const normalizeAccount = (s) => String(s || '').replace(/\D/g, '');
const validAccount = (a) => a.length >= 6 && a.length <= 20;
const hashIp = (ip) => crypto.createHash('sha256').update(SALT + ip).digest('hex').slice(0, 32);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);

function maskAccount(a) {
  if (a.length <= 6) return a.slice(0, 2) + '•'.repeat(a.length - 2);
  return a.slice(0, 4) + '•'.repeat(a.length - 7) + a.slice(-3);
}

// "AHMAD BIN ABDULLAH" -> "AH*** B** AB******"
function maskName(name) {
  if (!name) return null;
  return name.toUpperCase().split(/\s+/).filter(Boolean)
    .map((w) => (w.length <= 2 ? w[0] + '*' : w.slice(0, 2) + '*'.repeat(Math.min(w.length - 2, 6))))
    .join(' ');
}

// Strip phone numbers / emails people paste into descriptions (privacy of third parties).
function redact(text) {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]')
    .replace(/(\+?6?0)[\s-]?1\d[\s-]?\d{3,4}[\s-]?\d{4}/g, '[phone removed]')
    .replace(/\b\d{6}-?\d{2}-?\d{4}\b/g, '[IC removed]');
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (process.env.TRUST_PROXY && fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

// Simple in-memory rate limiter: key -> [timestamps]
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20_000) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---------- risk scoring ----------
function assess(account) {
  const cleared = db.prepare('SELECT note, cleared_at FROM cleared_accounts WHERE account = ?').get(account);
  const reports = db.prepare(`SELECT * FROM reports WHERE account = ? AND status = 'visible' ORDER BY created_at DESC`).all(account);
  const v = db.prepare(`SELECT SUM(vote='safe') AS safe, SUM(vote='scam') AS scam FROM votes WHERE account = ?`).get(account);
  const searches = db.prepare('SELECT COUNT(*) AS n FROM searches WHERE account = ?').get(account).n;
  const pendingDispute = db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE account = ? AND status = 'pending'`).get(account).n > 0;

  const reporters = new Set(reports.map((r) => r.reporter_hash)).size;
  const safe = v.safe || 0, scam = v.scam || 0;
  const totalLost = reports.reduce((s, r) => s + (r.amount || 0), 0);

  // Distinct reporters matter far more than raw count (one angry person can't flag an account alone).
  const score = reporters * 3 + Math.min(reports.length - reporters, 3) + scam - safe * 1.5;
  let level;
  if (cleared) level = 'cleared';
  else if (reports.length === 0 && scam === 0) level = 'none';
  else if (reporters >= 3 || score >= 9) level = 'high';
  else if (reporters >= 2 || score >= 4) level = 'medium';
  else level = 'low';

  const byCategory = {};
  for (const r of reports) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  const banks = [...new Set(reports.map((r) => r.bank))];
  const names = [...new Set(reports.map((r) => maskName(r.holder_name)).filter(Boolean))];

  return {
    account, masked: maskAccount(account), level, cleared: cleared || null, pendingDispute,
    stats: { reports: reports.length, reporters, safeVotes: safe, scamVotes: scam, searches, totalLost },
    banks, names, byCategory,
    firstReported: reports.length ? reports[reports.length - 1].created_at : null,
    lastReported: reports.length ? reports[0].created_at : null,
    reports: cleared ? [] : reports.slice(0, 50).map(publicReport),
  };
}

const publicReport = (r) => ({
  id: r.id, bank: r.bank, holderName: maskName(r.holder_name), category: r.category,
  categoryLabel: CATEGORIES[r.category] || r.category, platform: r.platform, amount: r.amount,
  incidentDate: r.incident_date, description: r.description, createdAt: r.created_at,
  account: maskAccount(r.account),
});

// ---------- routes ----------
const routes = {
  'GET /api/meta': () => [200, { banks: BANKS, categories: CATEGORIES }],

  'GET /api/stats': () => {
    const t = db.prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT account) AS accounts, COALESCE(SUM(amount),0) AS lost
                          FROM reports WHERE status='visible'`).get();
    const searches = db.prepare('SELECT COUNT(*) AS n FROM searches').get().n;
    const cats = db.prepare(`SELECT category, COUNT(*) AS n FROM reports WHERE status='visible' GROUP BY category ORDER BY n DESC`).all()
      .map((c) => ({ ...c, label: CATEGORIES[c.category] || c.category }));
    const banks = db.prepare(`SELECT bank, COUNT(DISTINCT account) AS n FROM reports WHERE status='visible' GROUP BY bank ORDER BY n DESC LIMIT 6`).all();
    return [200, { ...t, searches, categories: cats, banks }];
  },

  'GET /api/recent': () => {
    const rows = db.prepare(`SELECT * FROM reports WHERE status='visible'
                             AND account NOT IN (SELECT account FROM cleared_accounts)
                             ORDER BY created_at DESC LIMIT 12`).all();
    return [200, rows.map((r) => ({ ...publicReport(r), description: r.description.slice(0, 160) }))];
  },

  'GET /api/lookup': (req, url) => {
    const account = normalizeAccount(url.searchParams.get('account'));
    if (!validAccount(account)) return [400, { error: 'Enter a valid account number (6–20 digits).' }];
    if (rateLimited('lookup:' + hashIp(clientIp(req)), 60, 60e3)) return [429, { error: 'Too many searches. Please wait a minute.' }];
    db.prepare('INSERT INTO searches (account) VALUES (?)').run(account);
    return [200, assess(account)];
  },

  'POST /api/reports': async (req) => {
    const ip = hashIp(clientIp(req));
    if (rateLimited('report:' + ip, 5, 3600e3)) return [429, { error: 'Report limit reached (5 per hour). Please try later.' }];
    const b = await readJson(req);
    if (b.website) return [200, { ok: true }]; // honeypot field filled by bots
    const account = normalizeAccount(b.account);
    const bank = clean(b.bank, 60);
    const category = clean(b.category, 30);
    const description = redact(clean(b.description, 2000));
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
    const incidentDate = clean(b.incidentDate, 10) || null;

    if (!validAccount(account)) return [400, { error: 'Account number must be 6–20 digits.' }];
    if (!BANKS.includes(bank)) return [400, { error: 'Please choose a bank.' }];
    if (!CATEGORIES[category]) return [400, { error: 'Please choose a scam type.' }];
    if (description.length < 30) return [400, { error: 'Please describe what happened (at least 30 characters).' }];
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1e8)) return [400, { error: 'Invalid amount.' }];
    if (incidentDate && (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || new Date(incidentDate) > new Date())) return [400, { error: 'Invalid incident date.' }];
    if (!b.confirm) return [400, { error: 'Please confirm your report is truthful.' }];

    const dup = db.prepare('SELECT id FROM reports WHERE account = ? AND reporter_hash = ? AND created_at > datetime(\'now\',\'-1 day\')').get(account, ip);
    if (dup) return [409, { error: 'You already reported this account in the last 24 hours.' }];

    const r = db.prepare(`INSERT INTO reports (account, bank, holder_name, category, platform, amount, incident_date, description, reporter_hash)
                          VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(account, bank, clean(b.holderName, 80) || null, category, clean(b.platform, 60) || null, amount, incidentDate, description, ip);
    return [201, { ok: true, id: Number(r.lastInsertRowid) }];
  },

  'POST /api/votes': async (req) => {
    const ip = hashIp(clientIp(req));
    if (rateLimited('vote:' + ip, 30, 3600e3)) return [429, { error: 'Too many votes. Please try later.' }];
    const b = await readJson(req);
    const account = normalizeAccount(b.account);
    if (!validAccount(account) || !['safe', 'scam'].includes(b.vote)) return [400, { error: 'Invalid vote.' }];
    db.prepare(`INSERT INTO votes (account, voter_hash, vote) VALUES (?,?,?)
                ON CONFLICT(account, voter_hash) DO UPDATE SET vote = excluded.vote, created_at = datetime('now')`).run(account, ip, b.vote);
    return [200, assess(account)];
  },

  'POST /api/disputes': async (req) => {
    const ip = hashIp(clientIp(req));
    if (rateLimited('dispute:' + ip, 3, 3600e3)) return [429, { error: 'Too many requests. Please try later.' }];
    const b = await readJson(req);
    if (b.website) return [200, { ok: true }];
    const account = normalizeAccount(b.account);
    const bank = clean(b.bank, 60), name = clean(b.name, 80), email = clean(b.email, 120), explanation = clean(b.explanation, 3000);
    if (!validAccount(account)) return [400, { error: 'Account number must be 6–20 digits.' }];
    if (!BANKS.includes(bank)) return [400, { error: 'Please choose a bank.' }];
    if (name.length < 3) return [400, { error: 'Please enter your name.' }];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [400, { error: 'Please enter a valid email.' }];
    if (explanation.length < 30) return [400, { error: 'Please explain (at least 30 characters).' }];
    db.prepare('INSERT INTO disputes (account, bank, name, email, explanation) VALUES (?,?,?,?,?)').run(account, bank, name, email, explanation);
    return [201, { ok: true }];
  },

  // ----- moderation (requires ADMIN_TOKEN) -----
  'GET /api/admin/overview': () => {
    const reports = db.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT 200`).all()
      .map((r) => ({ ...r, categoryLabel: CATEGORIES[r.category], reporter_hash: r.reporter_hash.slice(0, 8) }));
    const disputes = db.prepare(`SELECT * FROM disputes ORDER BY status='pending' DESC, created_at DESC LIMIT 200`).all();
    const cleared = db.prepare(`SELECT * FROM cleared_accounts ORDER BY cleared_at DESC`).all();
    return [200, { reports, disputes, cleared }];
  },

  'POST /api/admin/report-status': async (req) => {
    const b = await readJson(req);
    if (!['visible', 'hidden'].includes(b.status)) return [400, { error: 'Invalid status' }];
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(b.status, Number(b.id));
    return [200, { ok: true }];
  },

  'POST /api/admin/dispute': async (req) => {
    const b = await readJson(req);
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(Number(b.id));
    if (!d) return [404, { error: 'Not found' }];
    if (!['upheld', 'rejected'].includes(b.decision)) return [400, { error: 'Invalid decision' }];
    db.prepare(`UPDATE disputes SET status = ?, resolved_at = datetime('now') WHERE id = ?`).run(b.decision, d.id);
    if (b.decision === 'upheld') {
      db.prepare(`INSERT INTO cleared_accounts (account, note) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET note = excluded.note`)
        .run(d.account, clean(b.note, 300) || 'Verified by moderators after review.');
    }
    return [200, { ok: true }];
  },

  'POST /api/admin/unclear': async (req) => {
    const b = await readJson(req);
    db.prepare('DELETE FROM cleared_accounts WHERE account = ?').run(normalizeAccount(b.account));
    return [200, { ok: true }];
  },
};

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'");

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Not found' });

  if (url.pathname.startsWith('/api/admin/')) {
    const token = req.headers['x-admin-token'] || '';
    const ok = ADMIN_TOKEN && token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!ok) return send(res, 401, { error: ADMIN_TOKEN ? 'Invalid admin token' : 'Admin disabled: set ADMIN_TOKEN env variable' });
  }

  try {
    const [status, body] = await handler(req, url);
    send(res, status, body);
  } catch (e) {
    send(res, e.message === 'Invalid JSON' || e.message === 'Payload too large' ? 400 : 500, { error: e.message || 'Server error' });
    if (!['Invalid JSON', 'Payload too large'].includes(e.message)) console.error(e);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`AkaunWatch running at http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) console.log('Tip: set ADMIN_TOKEN=... to enable the moderation panel at /#/admin');
  });
}

module.exports = { server, maskAccount, maskName, redact, assess };
