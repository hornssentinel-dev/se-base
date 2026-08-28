// SQLite storage layer. Replaces the single data/storage.json blob that the
// app used before multi-user support: every write there was a read-whole-file /
// mutate / rewrite cycle, so two people saving at once silently lost one of the
// two edits. Here each record is its own row and each write is a transaction.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'se-tracker.db');

for (const dir of [DATA_DIR, IMAGE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(DB_FILE);

// WAL lets readers run concurrently with the single writer, which is what makes
// one SQLite file fine for a team this size. foreign_keys is off by default in
// SQLite and has to be re-enabled per connection.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Opportunity sub-structures (products/notes/demos/poc) stay as JSON columns
// rather than child tables: the UI always loads and saves them together with
// their parent opp, so normalising them would buy no query flexibility we use
// while forcing a rewrite of most of the React component. Note images live on
// disk (see IMAGE_DIR), so these JSON blobs stay small.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    role          TEXT NOT NULL DEFAULT 'se' CHECK (role IN ('admin','se')),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invites (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL COLLATE NOCASE,
    name       TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT 'se' CHECK (role IN ('admin','se')),
    invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opportunities (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account      TEXT NOT NULL DEFAULT '',
    segment      TEXT NOT NULL DEFAULT '',
    se_stage     TEXT NOT NULL DEFAULT '',
    acct_mgr     TEXT NOT NULL DEFAULT '',
    acv          REAL NOT NULL DEFAULT 0,
    close_date   TEXT,
    close_status TEXT,
    champion     TEXT NOT NULL DEFAULT '',
    competitor   TEXT NOT NULL DEFAULT '',
    next_action  TEXT NOT NULL DEFAULT '',
    sfdc_url     TEXT NOT NULL DEFAULT '',
    products     TEXT NOT NULL DEFAULT '[]',
    notes        TEXT NOT NULL DEFAULT '[]',
    demos        TEXT NOT NULL DEFAULT '[]',
    poc          TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- Shared org-wide library: no user_id, every SE reads and edits the same list.
  CREATE TABLE IF NOT EXISTS business_cases (
    id         TEXT PRIMARY KEY,
    product    TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    detail     TEXT NOT NULL DEFAULT '',
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opp_id      TEXT,
    text        TEXT NOT NULL DEFAULT '',
    opp_account TEXT NOT NULL DEFAULT '',
    done        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_opps_user     ON opportunities(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_user    ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
`);

const parse = (raw, fallback) => {
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

// Rows go back to the client in the exact shape the React app already uses, so
// the UI keeps its existing camelCase opp objects and nothing downstream cares
// that storage changed.
export function rowToOpp(row) {
  return {
    id: row.id,
    userId: row.user_id,
    account: row.account,
    segment: row.segment,
    seStage: row.se_stage,
    acctMgr: row.acct_mgr,
    acv: row.acv,
    closeDate: row.close_date || '',
    closeStatus: row.close_status || undefined,
    champion: row.champion,
    competitor: row.competitor,
    nextAction: row.next_action,
    sfdcUrl: row.sfdc_url,
    products: parse(row.products, []),
    notes: parse(row.notes, []),
    demos: parse(row.demos, []),
    poc: row.poc ? parse(row.poc, null) : null,
    createdAt: row.created_at,
  };
}

export function oppToRow(opp, userId, now) {
  return {
    id: opp.id,
    user_id: userId,
    account: opp.account ?? '',
    segment: opp.segment ?? '',
    se_stage: opp.seStage ?? '',
    acct_mgr: opp.acctMgr ?? '',
    acv: Number(opp.acv) || 0,
    close_date: opp.closeDate || null,
    close_status: opp.closeStatus || null,
    champion: opp.champion ?? '',
    competitor: opp.competitor ?? '',
    next_action: opp.nextAction ?? '',
    sfdc_url: opp.sfdcUrl ?? '',
    products: JSON.stringify(opp.products ?? []),
    notes: JSON.stringify(opp.notes ?? []),
    demos: JSON.stringify(opp.demos ?? []),
    poc: opp.poc ? JSON.stringify(opp.poc) : null,
    created_at: opp.createdAt || now,
    updated_at: now,
  };
}

export const rowToBizCase = (row) => ({
  id: row.id,
  product: row.product,
  title: row.title,
  detail: row.detail,
});

export const rowToTask = (row) => ({
  id: row.id,
  text: row.text,
  oppId: row.opp_id,
  oppAccount: row.opp_account,
  done: !!row.done,
  createdAt: row.created_at,
});
