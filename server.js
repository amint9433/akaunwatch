// AkaunWatch — community bank account checker.
// Zero-dependency Node.js server (node:http + node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SALT = process.env.HASH_SALT || '';
const OPERATOR_NAME = process.env.OPERATOR_NAME || 'AkaunWatch (operator name not set)';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'contact@example.com';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Publication thresholds
const HIGH_REPORTERS = 3;          // distinct reporters for the strongest label
const DISPUTE_SHIELD = 3;          // while a dispute is pending, hide accounts with fewer reporters than this
const REPORT_MAX_AGE_DAYS = 730;   // published reports expire after ~2 years
const SEARCH_LOG_DAYS = 90;        // search log retention
const DISPUTE_EMAIL_DAYS = 30;     // dispute emails deleted this long after a decision

const BANKS = [
  'Maybank', 'CIMB Bank', 'Public Bank', 'RHB Bank', 'Hong Leong Bank', 'AmBank',
  'Bank Islam', 'Bank Rakyat', 'BSN', 'Affin Bank', 'Alliance Bank', 'Bank Muamalat',
  'OCBC Bank', 'UOB', 'HSBC', 'Standard Chartered', 'Agrobank', 'MBSB Bank',
  'Al Rajhi Bank', 'Kuwait Finance House', 'GXBank', 'Boost Bank', 'AEON Bank',
  "Touch 'n Go eWallet", 'Other',
];

const CATEGORIES = {
  shopping: 'Online shopping / item not received',
  investment: 'Investment / crypto',
  impersonation: 'Impersonation (police, bank, LHDN, courier)',
  love: 'Online romance',
  job: 'Job / task offer',
  loan: 'Loan offer',
  rental: 'Rental / property',
  ticket: 'Ticket / event / travel',
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

// Strip phone numbers / emails / IC numbers people paste into descriptions.
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

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20_000) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ---------- everything below needs the database ----------
const db = require('./db');

function logAdmin(action, target, note, req) {
  db.prepare('INSERT INTO admin_log (action, target, note, actor_hash) VALUES (?,?,?,?)')
    .run(action, String(target), clean(note, 500) || null, req ? hashIp(clientIp(req)).slice(0, 8) : 'system');
}

// Data retention (PDPA retention principle). Runs at startup and daily.
function maintenance() {
  db.prepare(`DELETE FROM searches WHERE created_at < datetime('now', ?)`).run(`-${SEARCH_LOG_DAYS} days`);
  db.prepare(`UPDATE disputes SET email = '[deleted]' WHERE status != 'pending' AND email != '[deleted]'
              AND resolved_at < datetime('now', ?)`).run(`-${DISPUTE_EMAIL_DAYS} days`);
  const r = db.prepare(`UPDATE reports SET status = 'expired' WHERE status = 'visible' AND created_at < datetime('now', ?)`)
    .run(`-${REPORT_MAX_AGE_DAYS} days`);
  if (r.changes) logAdmin('auto-expire', `${r.changes} reports`, `Older than ${REPORT_MAX_AGE_DAYS} days`);
}

// ---------- assessment ----------
// Labels describe what users reported, never accuse. Only moderator-approved reports count.
function assess(account) {
  const cleared = db.prepare('SELECT note, cleared_at FROM cleared_accounts WHERE account = ?').get(account);
  const reports = db.prepare(`SELECT * FROM reports WHERE account = ? AND status = 'visible' ORDER BY created_at DESC`).all(account);
  const safeVotes = db.prepare(`SELECT COUNT(*) AS n FROM votes WHERE account = ? AND vote = 'safe'`).get(account).n;
  const searches = db.prepare('SELECT COUNT(*) AS n FROM searches WHERE account = ?').get(account).n;
  const pendingDispute = db.prepare(`SELECT COUNT(*) AS n FROM disputes WHERE account = ? AND status = 'pending'`).get(account).n > 0;

  const reporters = new Set(reports.map((r) => r.reporter_hash)).size;
  let level;
  if (cleared) level = 'cleared';
  else if (reports.length === 0) level = 'none';
  else if (pendingDispute && reporters < DISPUTE_SHIELD) level = 'review';
  else if (reporters >= HIGH_REPORTERS) level = 'high';
  else if (reporters === 2) level = 'medium';
  else level = 'low';

  const hideDetails = level === 'cleared' || level === 'review';
  return {
    account, masked: maskAccount(account), level, pendingDispute,
    stats: {
      reports: hideDetails ? 0 : reports.length,
      reporters: hideDetails ? 0 : reporters,
      safeVotes, searches,
      totalLost: hideDetails ? 0 : reports.reduce((s, r) => s + (r.amount || 0), 0),
    },
    banks: hideDetails ? [] : [...new Set(reports.map((r) => r.bank))],
    lastReported: !hideDetails && reports.length ? reports[0].created_at : null,
    reports: hideDetails ? [] : reports.slice(0, 50).map(publicReport),
  };
}

// Note: holder name and police reference are deliberately NOT included.
const publicReport = (r) => ({
  id: r.id, bank: r.bank, category: r.category, categoryLabel: CATEGORIES[r.category] || r.category,
  platform: r.platform, amount: r.amount, incidentDate: r.incident_date, description: r.description,
  createdAt: r.created_at, account: maskAccount(r.account),
});

// ---------- routes ----------
const routes = {
  'GET /api/meta': () => [200, {
    banks: BANKS, categories: CATEGORIES, operator: OPERATOR_NAME, contactEmail: CONTACT_EMAIL,
    retention: { searchDays: SEARCH_LOG_DAYS, disputeEmailDays: DISPUTE_EMAIL_DAYS, reportDays: REPORT_MAX_AGE_DAYS },
  }],

  'GET /api/stats': () => {
    const t = db.prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT account) AS accounts, COALESCE(SUM(amount),0) AS lost
                          FROM reports WHERE status='visible' AND account NOT IN (SELECT account FROM cleared_accounts)`).get();
    const searches = db.prepare('SELECT COUNT(*) AS n FROM searches').get().n;
    const cats = db.prepare(`SELECT category, COUNT(*) AS n FROM reports WHERE status='visible' GROUP BY category ORDER BY n DESC`).all()
      .map((c) => ({ ...c, label: CATEGORIES[c.category] || c.category }));
    return [200, { ...t, searches, categories: cats }];
  },

  'GET /api/recent': () => {
    const rows = db.prepare(`SELECT * FROM reports WHERE status='visible'
                             AND account NOT IN (SELECT account FROM cleared_accounts)
                             AND account NOT IN (SELECT account FROM disputes WHERE status='pending')
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
    const policeRef = clean(b.policeRef, 40);
    const description = redact(clean(b.description, 2000));
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
    const incidentDate = clean(b.incidentDate, 10) || null;

    if (!validAccount(account)) return [400, { error: 'Account number must be 6–20 digits.' }];
    if (!BANKS.includes(bank)) return [400, { error: 'Please choose a bank.' }];
    if (!CATEGORIES[category]) return [400, { error: 'Please choose what happened.' }];
    if (!/^[A-Za-z0-9][A-Za-z0-9/\-. ]{3,39}$/.test(policeRef)) return [400, { error: 'Please enter your police report or NSRC reference number.' }];
    if (description.length < 30) return [400, { error: 'Please describe what happened (at least 30 characters).' }];
    if (amount != null && (!Number.isFinite(amount) || amount < 0 || amount > 1e8)) return [400, { error: 'Invalid amount.' }];
    if (incidentDate && (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate) || new Date(incidentDate) > new Date())) return [400, { error: 'Invalid date.' }];
    if (!b.confirm) return [400, { error: 'Please confirm the declaration.' }];

    const dup = db.prepare(`SELECT id FROM reports WHERE account = ? AND reporter_hash = ? AND created_at > datetime('now','-1 day')`).get(account, ip);
    if (dup) return [409, { error: 'You already reported this account in the last 24 hours.' }];

    const r = db.prepare(`INSERT INTO reports (account, bank, holder_name, police_ref, category, platform, amount, incident_date, description, reporter_hash, status)
                          VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`)
      .run(account, bank, clean(b.holderName, 80) || null, policeRef, category, clean(b.platform, 60) || null, amount, incidentDate, description, ip);
    return [201, { ok: true, id: Number(r.lastInsertRowid) }];
  },

  // Only "my deal was fine" votes exist. They are shown but never raise or lower the label.
  'POST /api/votes': async (req) => {
    const ip = hashIp(clientIp(req));
    if (rateLimited('vote:' + ip, 10, 3600e3)) return [429, { error: 'Too many votes. Please try later.' }];
    const b = await readJson(req);
    const account = normalizeAccount(b.account);
    if (!validAccount(account) || b.vote !== 'safe') return [400, { error: 'Invalid vote.' }];
    db.prepare(`INSERT INTO votes (account, voter_hash, vote) VALUES (?,?,'safe')
                ON CONFLICT(account, voter_hash) DO UPDATE SET vote = 'safe', created_at = datetime('now')`).run(account, ip);
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
    if (!b.consent) return [400, { error: 'Please agree to the privacy notice.' }];
    db.prepare('INSERT INTO disputes (account, bank, name, email, explanation) VALUES (?,?,?,?,?)').run(account, bank, name, email, explanation);
    return [201, { ok: true }];
  },

  // ----- moderation (requires ADMIN_TOKEN) -----
  'GET /api/admin/overview': () => {
    const mapR = (r) => ({ ...r, categoryLabel: CATEGORIES[r.category], reporter_hash: r.reporter_hash.slice(0, 8),
      reporters: db.prepare(`SELECT COUNT(DISTINCT reporter_hash) AS n FROM reports WHERE account = ? AND status IN ('pending','visible')`).get(r.account).n });
    const pending = db.prepare(`SELECT * FROM reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT 200`).all().map(mapR);
    const reports = db.prepare(`SELECT * FROM reports WHERE status != 'pending' ORDER BY created_at DESC LIMIT 200`).all().map(mapR);
    const disputes = db.prepare(`SELECT * FROM disputes ORDER BY status='pending' DESC, created_at DESC LIMIT 200`).all();
    const cleared = db.prepare(`SELECT * FROM cleared_accounts ORDER BY cleared_at DESC`).all();
    const log = db.prepare(`SELECT * FROM admin_log ORDER BY id DESC LIMIT 100`).all();
    return [200, { pending, reports, disputes, cleared, log }];
  },

  'POST /api/admin/report-status': async (req) => {
    const b = await readJson(req);
    const map = { approve: 'visible', reject: 'hidden', hide: 'hidden', restore: 'visible' };
    const status = map[b.action];
    if (!status) return [400, { error: 'Invalid action' }];
    const r = db.prepare(`UPDATE reports SET status = ?, moderated_at = datetime('now') WHERE id = ?`).run(status, Number(b.id));
    if (!r.changes) return [404, { error: 'Report not found' }];
    logAdmin(`report-${b.action}`, `report #${Number(b.id)}`, b.note, req);
    return [200, { ok: true }];
  },

  'POST /api/admin/dispute': async (req) => {
    const b = await readJson(req);
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(Number(b.id));
    if (!d) return [404, { error: 'Not found' }];
    if (!['upheld', 'rejected'].includes(b.decision)) return [400, { error: 'Invalid decision' }];
    const note = clean(b.note, 500);
    if (note.length < 5) return [400, { error: 'Please write a short reason for the decision (it is kept in the log).' }];
    db.prepare(`UPDATE disputes SET status = ?, decision_note = ?, resolved_at = datetime('now') WHERE id = ?`).run(b.decision, note, d.id);
    if (b.decision === 'upheld') {
      db.prepare(`INSERT INTO cleared_accounts (account, note) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET note = excluded.note, cleared_at = datetime('now')`)
        .run(d.account, note);
    }
    logAdmin(`dispute-${b.decision}`, `dispute #${d.id} (account ${d.account})`, note, req);
    return [200, { ok: true }];
  },

  'POST /api/admin/unclear': async (req) => {
    const b = await readJson(req);
    const account = normalizeAccount(b.account);
    const note = clean(b.note, 500);
    if (note.length < 5) return [400, { error: 'Please write a short reason (it is kept in the log).' }];
    db.prepare('DELETE FROM cleared_accounts WHERE account = ?').run(account);
    logAdmin('uncleared', `account ${account}`, note, req);
    return [200, { ok: true }];
  },
};

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'");

  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'Not found' });

  if (url.pathname.startsWith('/api/admin/')) {
    const token = String(req.headers['x-admin-token'] || '');
    const ok = ADMIN_TOKEN && token.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
    if (!ok) return send(res, 401, { error: ADMIN_TOKEN ? 'Invalid admin token' : 'Admin disabled: set ADMIN_TOKEN env variable' });
  }

  try {
    const [status, body] = await handler(req, url);
    send(res, status, body);
  } catch (e) {
    const clientErr = ['Invalid JSON', 'Payload too large'].includes(e.message);
    send(res, clientErr ? 400 : 500, { error: clientErr ? e.message : 'Server error' });
    if (!clientErr) console.error(e);
  }
});

if (require.main === module) {
  if (!SALT || SALT === 'change-me-in-production' || SALT.length < 8) {
    console.error('Refusing to start: set HASH_SALT to a long random secret (8+ characters).');
    process.exit(1);
  }
  maintenance();
  setInterval(maintenance, 864e5).unref();
  setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();
  server.listen(PORT, () => {
    console.log(`AkaunWatch running at http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) console.log('Tip: set ADMIN_TOKEN=... to enable the moderation panel at /#/admin');
    if (CONTACT_EMAIL === 'contact@example.com') console.log('Warning: set CONTACT_EMAIL so people can reach you for disputes and privacy requests.');
  });
}

module.exports = { server, maskAccount, redact, assess };
