// Database layer — uses Node's built-in SQLite (no native dependencies).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'akaunwatch.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account       TEXT NOT NULL,            -- digits only
  bank          TEXT NOT NULL,
  holder_name   TEXT,                     -- PRIVATE: moderators only, never shown publicly
  police_ref    TEXT,                     -- PRIVATE: police report / NSRC reference, moderators only
  category      TEXT NOT NULL,
  platform      TEXT,
  amount        REAL,
  incident_date TEXT,
  description   TEXT NOT NULL,
  reporter_hash TEXT NOT NULL,            -- salted hash of IP, never the IP itself
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | visible | hidden | expired
  moderated_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_account ON reports(account);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

CREATE TABLE IF NOT EXISTS votes (
  account     TEXT NOT NULL,
  voter_hash  TEXT NOT NULL,
  vote        TEXT NOT NULL,              -- only 'safe' is accepted now (legacy rows may say 'scam' and are ignored)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account, voter_hash)
);

CREATE TABLE IF NOT EXISTS disputes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account        TEXT NOT NULL,
  bank           TEXT NOT NULL,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  explanation    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',   -- pending | upheld | rejected
  decision_note  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at    TEXT
);

CREATE TABLE IF NOT EXISTS cleared_accounts (
  account     TEXT PRIMARY KEY,
  note        TEXT,
  cleared_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS searches (
  account     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_searches_account ON searches(account);

-- Audit trail of every moderator action (never deleted).
CREATE TABLE IF NOT EXISTS admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  note        TEXT,
  actor_hash  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Upgrade databases created by older versions.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('reports', 'police_ref', 'TEXT');
addColumn('reports', 'moderated_at', 'TEXT');
addColumn('disputes', 'decision_note', 'TEXT');
addColumn('disputes', 'shield', 'INTEGER NOT NULL DEFAULT 1');   // 0 = do not hide reports while pending (e.g. repeat dispute)
addColumn('reports', 'original_description', 'TEXT');            // kept when a moderator edits a description

module.exports = db;
