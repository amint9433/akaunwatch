// AkaunWatch — community bank account checker.
// Zero-dependency Node.js server (node:http + node:sqlite).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PRODUCTION = process.env.NODE_ENV === 'production';
const SALT = process.env.HASH_SALT || '';
const DEFAULT_OPERATOR = 'AkaunWatch (operator name not set)';
const DEFAULT_EMAIL = 'contact@example.com';
const OPERATOR_NAME = process.env.OPERATOR_NAME || DEFAULT_OPERATOR;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || DEFAULT_EMAIL;
const HOSTING_DESC = process.env.HOSTING_DESC || 'our cloud hosting provider, on servers that may be located outside Malaysia';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Moderators: ADMIN_TOKEN (shown as "admin") plus MODERATORS="aisyah:token1,ali:token2" so the log shows who did what.
const MODERATORS = new Map();
if (process.env.ADMIN_TOKEN) MODERATORS.set(process.env.ADMIN_TOKEN, 'admin');
for (const pair of (process.env.MODERATORS || '').split(',')) {
  const i = pair.indexOf(':');
  const name = pair.slice(0, i).trim(), token = pair.slice(i + 1).trim();
  if (i > 0 && name && token.length >= 8) MODERATORS.set(token, name);
}

// Publication rules
const HIGH_REPORTERS = 3;          // distinct reporters for the strongest label
const DISPUTE_SHIELD = 3;          // a pending dispute hides earlier reports only if fewer than this many users reported
const DISPUTE_DEADLINE_DAYS = 14;  // promised decision time
// Retention (PDPA retention principle). The 6-year period follows the general limitation period for
// civil claims (Limitation Act 1953) so evidence exists if a report is challenged — confirm with a lawyer.
const REPORT_PUBLIC_DAYS = 730;    // published reports leave public view after ~2 years
const HOLDER_NAME_DAYS = 30;       // private "name at transfer" deleted this long after moderation
const SEARCH_LOG_DAYS = 90;
const DISPUTE_EMAIL_DAYS = 30;     // after the decision
const VOTE_DAYS = 730;
const RECORD_DAYS = 6 * 365;       // reports, disputes, moderation log and clearings are deleted after this

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
const days = (n) => `-${n} days`;

function maskAccount(a) {
  if (a.length <= 6) return a.slice(0, 2) + '•'.repeat(a.length - 2);
  return a.slice(0, 4) + '•'.repeat(a.length - 7) + a.slice(-3);
}

// Remove personal details people paste into descriptions.
function redact(text, account) {
  let t = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email removed]')
    .replace(/(\+?6?0)[\s-]?1\d[\s-]?\d{3,4}[\s-]?\d{4}/g, '[phone removed]')
    .replace(/\b\d{6}-?\d{2}-?\d{4}\b/g, '[IC removed]');
  if (account) t = t.replace(new RegExp(account.split('').join('[\\s-]?'), 'g'), '[this account]');
  return t.replace(/\b\d(?:[\s-]?\d){7,19}\b/g, '[number removed]'); // other account / card numbers
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
const recentCount = (key, windowMs) => (buckets.get(key) || []).filter((t) => Date.now() - t < windowMs).length;

function moderatorFor(token) {
  for (const [t, name] of MODERATORS) {
    if (t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) return name;
  }
  return null;
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

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const requireReason = (note) => {
  const n = clean(note, 500);
  if (n.length < 5) throw new HttpError(400, 'Please write a short reason (5+ characters). It is kept in the moderation log.');
  return n;
};

// ---------- everything below needs the database ----------
const db = require('./db');

function logAdmin(action, target, note, req) {
  db.prepare('INSERT INTO admin_log (action, target, note, actor_hash) VALUES (?,?,?,?)')
    .run(action, String(target), clean(note, 500) || null, req?.moderator || 'system');
}

// SQL: report is not hidden by an earlier "cleared" decision or by a pending dispute filed after it.
const PUBLIC_REPORT_SQL = `status = 'visible'
  AND NOT EXISTS (SELECT 1 FROM cleared_accounts c WHERE c.account = reports.account AND reports.created_at <= c.cleared_at)
  AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.account = reports.account AND d.status = 'pending' AND d.shield = 1 AND reports.created_at <= d.created_at)`;

function maintenance() {
  const run = (sql, ...p) => db.prepare(sql).run(...p).changes;
  const counts = {
    searches: run(`DELETE FROM searches WHERE created_at < datetime('now', ?)`, days(SEARCH_LOG_DAYS)),
    disputeEmails: run(`UPDATE disputes SET email = '[deleted]' WHERE status != 'pending' AND email != '[deleted]' AND resolved_at < datetime('now', ?)`, days(DISPUTE_EMAIL_DAYS)),
    holderNames: run(`UPDATE reports SET holder_name = NULL WHERE holder_name IS NOT NULL AND status != 'pending' AND moderated_at < datetime('now', ?)`, days(HOLDER_NAME_DAYS)),
    expired: run(`UPDATE reports SET status = 'expired' WHERE status = 'visible' AND created_at < datetime('now', ?)`, days(REPORT_PUBLIC_DAYS)),
    votes: run(`DELETE FROM votes WHERE created_at < datetime('now', ?)`, days(VOTE_DAYS)),
    reports: run(`DELETE FROM reports WHERE created_at < datetime('now', ?)`, days(RECORD_DAYS)),
    disputes: run(`DELETE FROM disputes WHERE status != 'pending' AND resolved_at < datetime('now', ?)`, days(RECORD_DAYS)),
    cleared: run(`DELETE FROM cleared_accounts WHERE cleared_at < datetime('now', ?)`, days(RECORD_DAYS)),
    log: run(`DELETE FROM admin_log WHERE created_at < datetime('now', ?)`, days(RECORD_DAYS)),
  };
  const summary = Object.entries(counts).filter(([k, n]) => n && k !== 'searches').map(([k, n]) => `${k}: ${n}`).join(', ');
  if (summary) logAdmin('retention', 'scheduled clean-up', summary);
}

// ---------- assessment ----------
// Labels describe what users reported, never accuse. Only moderator-approved reports count.
function assess(account) {
  const cleared = db.prepare('SELECT cleared_at FROM cleared_accounts WHERE account = ?').get(account);
  const dispute = db.prepare(`SELECT created_at, shield FROM disputes WHERE account = ? AND status = 'pending' ORDER BY id LIMIT 1`).get(account);
  let reports = db.prepare(`SELECT * FROM reports WHERE account = ? AND status = 'visible' ORDER BY created_at DESC`).all(account);
  const countReporters = (list) => new Set(list.map((r) => r.reporter_hash)).size;

  // A clearing only covers reports made up to that decision; later reports are judged afresh.
  if (cleared) reports = reports.filter((r) => r.created_at > cleared.cleared_at);

  // A pending dispute hides only reports made BEFORE the dispute, and only if few users reported.
  let underReview = false;
  if (dispute && dispute.shield && countReporters(reports) < DISPUTE_SHIELD) {
    const earlier = reports.filter((r) => r.created_at <= dispute.created_at);
    if (earlier.length) { underReview = true; reports = reports.filter((r) => r.created_at > dispute.created_at); }
  }

  const reporters = countReporters(reports);
  let level;
  if (reports.length) level = reporters >= HIGH_REPORTERS ? 'high' : reporters === 2 ? 'medium' : 'low';
  else if (underReview) level = 'review';
  else if (cleared) level = 'cleared';
  else level = 'none';

  const published = reports.length > 0;
  const safeVotes = published ? db.prepare(`SELECT COUNT(*) AS n FROM votes WHERE account = ? AND vote = 'safe'`).get(account).n : null;
  const searches = db.prepare('SELECT COUNT(*) AS n FROM searches WHERE account = ?').get(account).n;

  return {
    account, masked: maskAccount(account), level, underReview,
    disputePending: !!dispute, earlierRemoved: !!cleared, clearedAt: cleared ? cleared.cleared_at : null,
    stats: { reports: reports.length, reporters, safeVotes, searches, totalLost: reports.reduce((s, r) => s + (r.amount || 0), 0) },
    banks: [...new Set(reports.map((r) => r.bank))],
    lastReported: published ? reports[0].created_at : null,
    reports: reports.slice(0, 50).map(publicReport),
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
    banks: BANKS, categories: CATEGORIES, operator: OPERATOR_NAME, contactEmail: CONTACT_EMAIL, hosting: HOSTING_DESC,
    demo: !!db.prepare(`SELECT 1 FROM reports WHERE police_ref LIKE 'DEMO/%' LIMIT 1`).get(),
    disputeDays: DISPUTE_DEADLINE_DAYS, shieldReporters: DISPUTE_SHIELD,
    retention: {
      searchDays: SEARCH_LOG_DAYS, disputeEmailDays: DISPUTE_EMAIL_DAYS, holderNameDays: HOLDER_NAME_DAYS,
      reportPublicDays: REPORT_PUBLIC_DAYS, voteDays: VOTE_DAYS, recordYears: Math.round(RECORD_DAYS / 365),
    },
  }],

  'GET /api/stats': () => {
    const t = db.prepare(`SELECT COUNT(*) AS reports, COUNT(DISTINCT account) AS accounts, COALESCE(SUM(amount),0) AS lost
                          FROM reports WHERE ${PUBLIC_REPORT_SQL}`).get();
    const searches = db.prepare('SELECT COUNT(*) AS n FROM searches').get().n;
    const cats = db.prepare(`SELECT category, COUNT(*) AS n FROM reports WHERE ${PUBLIC_REPORT_SQL} GROUP BY category ORDER BY n DESC`).all()
      .map((c) => ({ ...c, label: CATEGORIES[c.category] || c.category }));
    return [200, { ...t, searches, categories: cats }];
  },

  'GET /api/recent': () => {
    const rows = db.prepare(`SELECT * FROM reports WHERE ${PUBLIC_REPORT_SQL} ORDER BY created_at DESC LIMIT 12`).all();
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
    const description = redact(clean(b.description, 2000), account);
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
    if (!b.agree) return [400, { error: 'Please agree to the Terms of Use and Privacy Notice.' }];

    const dup = db.prepare(`SELECT id FROM reports WHERE account = ? AND reporter_hash = ? AND created_at > datetime('now','-1 day')`).get(account, ip);
    if (dup) return [409, { error: 'You already reported this account in the last 24 hours.' }];

    const r = db.prepare(`INSERT INTO reports (account, bank, holder_name, police_ref, category, platform, amount, incident_date, description, reporter_hash, status)
                          VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`)
      .run(account, bank, clean(b.holderName, 80) || null, policeRef, category, clean(b.platform, 60) || null, amount, incidentDate, description, ip);
    return [201, { ok: true, id: Number(r.lastInsertRowid) }];
  },

  // Only "my deal was fine" votes exist, only on accounts with published reports. They never change the label.
  'POST /api/votes': async (req) => {
    const ip = hashIp(clientIp(req));
    if (rateLimited('vote:' + ip, 10, 3600e3)) return [429, { error: 'Too many votes. Please try later.' }];
    const b = await readJson(req);
    const account = normalizeAccount(b.account);
    if (!validAccount(account) || b.vote !== 'safe') return [400, { error: 'Invalid vote.' }];
    if (!assess(account).stats.reports) return [400, { error: 'Votes are only possible on accounts with published reports.' }];
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

    if (db.prepare(`SELECT 1 FROM disputes WHERE account = ? AND status = 'pending'`).get(account)) {
      return [409, { error: 'A dispute for this account is already being reviewed. We will reply to the person who filed it.' }];
    }
    const visible = db.prepare(`SELECT COUNT(*) AS n FROM reports WHERE account = ? AND ${PUBLIC_REPORT_SQL}`).get(account).n;
    if (!visible) return [400, { error: 'There are no published reports on this account, so there is nothing to dispute.' }];
    // After a rejected dispute, a new dispute is reviewed but does not hide reports automatically.
    const rejectedBefore = !!db.prepare(`SELECT 1 FROM disputes WHERE account = ? AND status = 'rejected'`).get(account);
    db.prepare('INSERT INTO disputes (account, bank, name, email, explanation, shield) VALUES (?,?,?,?,?,?)')
      .run(account, bank, name, email, explanation, rejectedBefore ? 0 : 1);
    return [201, { ok: true, shield: !rejectedBefore }];
  },

  // ----- moderation (requires a moderator token) -----
  'GET /api/admin/overview': (req) => {
    const mapR = (r) => {
      const words = (r.holder_name || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !['bin', 'binti', 'bte', 'a/l', 'a/p'].includes(w));
      return { ...r, categoryLabel: CATEGORIES[r.category], reporter_hash: r.reporter_hash.slice(0, 8),
        nameInDescription: words.some((w) => new RegExp('(^|[^a-z])' + w.replace(/[^a-z0-9]/g, '') + '($|[^a-z])').test(r.description.toLowerCase())),
        reporters: db.prepare(`SELECT COUNT(DISTINCT reporter_hash) AS n FROM reports WHERE account = ? AND status IN ('pending','visible')`).get(r.account).n };
    };
    const pending = db.prepare(`SELECT * FROM reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT 200`).all().map(mapR);
    const reports = db.prepare(`SELECT * FROM reports WHERE status != 'pending' ORDER BY created_at DESC LIMIT 200`).all().map(mapR);
    const disputes = db.prepare(`SELECT *, CAST(julianday('now') - julianday(created_at) AS INTEGER) AS days_open
                                 FROM disputes ORDER BY status='pending' DESC, created_at ASC LIMIT 200`).all();
    const cleared = db.prepare(`SELECT * FROM cleared_accounts ORDER BY cleared_at DESC`).all();
    const log = db.prepare(`SELECT * FROM admin_log ORDER BY id DESC LIMIT 100`).all();
    return [200, { you: req.moderator, deadline: DISPUTE_DEADLINE_DAYS, pending, reports, disputes, cleared, log }];
  },

  'POST /api/admin/report-status': async (req) => {
    const b = await readJson(req);
    const map = { approve: 'visible', reject: 'hidden', hide: 'hidden', restore: 'visible' };
    const status = map[b.action];
    if (!status) return [400, { error: 'Invalid action' }];
    const note = requireReason(b.note);
    const r = db.prepare(`UPDATE reports SET status = ?, moderated_at = datetime('now') WHERE id = ?`).run(status, Number(b.id));
    if (!r.changes) return [404, { error: 'Report not found' }];
    logAdmin(`report-${b.action}`, `report #${Number(b.id)}`, note, req);
    return [200, { ok: true }];
  },

  'POST /api/admin/report-edit': async (req) => {
    const b = await readJson(req);
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(Number(b.id));
    if (!row) return [404, { error: 'Report not found' }];
    const note = requireReason(b.note);
    const description = redact(clean(b.description, 2000), row.account);
    if (description.length < 30) return [400, { error: 'Description must be at least 30 characters.' }];
    db.prepare('UPDATE reports SET description = ?, original_description = COALESCE(original_description, ?) WHERE id = ?')
      .run(description, row.description, row.id);
    logAdmin('report-edit', `report #${row.id}`, note, req);
    return [200, { ok: true }];
  },

  'POST /api/admin/dispute': async (req) => {
    const b = await readJson(req);
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(Number(b.id));
    if (!d) return [404, { error: 'Not found' }];
    if (d.status !== 'pending') return [409, { error: 'This dispute was already decided.' }];
    if (!['upheld', 'rejected'].includes(b.decision)) return [400, { error: 'Invalid decision' }];
    const note = requireReason(b.note);
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
    const note = requireReason(b.note);
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
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
    if (!MODERATORS.size) return send(res, 401, { error: 'Admin disabled: set ADMIN_TOKEN or MODERATORS' });
    const failKey = 'adminfail:' + hashIp(clientIp(req));
    if (recentCount(failKey, 900e3) >= 10) return send(res, 429, { error: 'Too many wrong tokens. Try again in 15 minutes.' });
    const name = moderatorFor(String(req.headers['x-admin-token'] || ''));
    if (!name) { rateLimited(failKey, Infinity, 900e3); return send(res, 401, { error: 'Invalid admin token' }); }
    req.moderator = name;
  }

  try {
    const [status, body] = await handler(req, url);
    send(res, status, body);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    const clientErr = ['Invalid JSON', 'Payload too large'].includes(e.message);
    send(res, clientErr ? 400 : 500, { error: clientErr ? e.message : 'Server error' });
    if (!clientErr) console.error(e);
  }
});

if (require.main === module) {
  const problems = [];
  if (!SALT || SALT === 'change-me-in-production' || SALT.length < 8) problems.push('set HASH_SALT to a long random secret (8+ characters)');
  if (PRODUCTION && OPERATOR_NAME === DEFAULT_OPERATOR) problems.push('set OPERATOR_NAME (e.g. your Sdn Bhd name)');
  if (PRODUCTION && CONTACT_EMAIL === DEFAULT_EMAIL) problems.push('set CONTACT_EMAIL');
  if (problems.length) { console.error('Refusing to start: ' + problems.join('; ') + '.'); process.exit(1); }

  maintenance();
  setInterval(maintenance, 864e5).unref();
  setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k); }, 600e3).unref();
  server.listen(PORT, () => {
    console.log(`AkaunWatch running at http://localhost:${PORT}`);
    if (!MODERATORS.size) console.log('Tip: set ADMIN_TOKEN=... to enable the moderation panel at /#/admin');
    if (OPERATOR_NAME === DEFAULT_OPERATOR) console.log('Warning: OPERATOR_NAME is not set (required when NODE_ENV=production).');
    if (CONTACT_EMAIL === DEFAULT_EMAIL) console.log('Warning: CONTACT_EMAIL is not set (required when NODE_ENV=production).');
  });
}

module.exports = { server, maskAccount, redact, assess, maintenance };
