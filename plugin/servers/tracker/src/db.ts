import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { secureDir, secureFile } from './fsperm.ts';
import { urlIdentity } from './posting.ts';
import { isValidTimeZone, toUtcIso } from './time.ts';

export function jobTrackerHome(): string {
  return process.env.JOB_TRACKER_HOME || join(homedir(), '.job-tracker');
}

export function defaultDbPath(): string {
  return process.env.JOB_TRACKER_DB || join(jobTrackerHome(), 'tracker.db');
}

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  domain TEXT,
  notes TEXT,
  no_cold_apply INTEGER NOT NULL DEFAULT 0,
  no_cold_apply_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  url TEXT,
  ats TEXT,
  location_line TEXT,
  location_type TEXT,
  comp_min INTEGER, comp_max INTEGER, comp_currency TEXT, comp_period TEXT, equity TEXT,
  stack TEXT, industry TEXT, source TEXT,
  first_seen TEXT NOT NULL, posted_at TEXT,
  verified_at TEXT,
  score REAL, score_notes TEXT,
  status TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS roles_company ON roles(company_id);
CREATE INDEX IF NOT EXISTS roles_url ON roles(url);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  ts TEXT NOT NULL,
  status TEXT,
  outcome TEXT,
  category TEXT,
  question TEXT,
  blocked_by TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT,
  run_id INTEGER
);
CREATE INDEX IF NOT EXISTS events_role ON events(role_id);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  role_id INTEGER REFERENCES roles(id),
  kind TEXT NOT NULL,
  path_or_ref TEXT,
  content TEXT,
  lint TEXT,
  verified_at TEXT,
  readback TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  name TEXT PRIMARY KEY,
  last_run TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  status_changed_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  reason TEXT NOT NULL,
  example TEXT,
  added_by TEXT NOT NULL,
  added_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  starts_at TEXT,
  tz TEXT,
  stage TEXT,
  people TEXT,
  link TEXT,
  booked_by TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  capabilities TEXT,
  summary TEXT
);
`;

// Row shapes for the current schema (SCHEMA_V1 plus MIGRATIONS). INTEGER flags are 0/1 numbers; JSON-text columns stay strings until parsed.
export interface CompanyRow {
  id: number;
  name: string;
  aliases: string;
  domain: string | null;
  notes: string | null;
  no_cold_apply: number;
  no_cold_apply_reason: string | null;
  created_at: string;
}

export interface RoleRow {
  id: number;
  company_id: number;
  title: string;
  url: string | null;
  ats: string | null;
  location_line: string | null;
  location_type: string | null;
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  comp_period: string | null;
  equity: string | null;
  stack: string | null;
  industry: string | null;
  source: string | null;
  first_seen: string;
  posted_at: string | null;
  verified_at: string | null;
  score: number | null;
  score_notes: string | null;
  status: string | null;
  updated_at: string;
}

export interface RoleUrlRow {
  role_id: number;
  url: string;
  normalized_url: string;
  evidence: string | null;
}

export interface RolePostingRow {
  role_id: number;
  provider: string;
  employer_key: string;
  posting_id: string;
}

export interface EventRow {
  id: number;
  role_id: number;
  ts: string;
  status: string | null;
  outcome: string | null;
  category: string | null;
  question: string | null;
  blocked_by: string | null;
  actor: string;
  reason: string;
  evidence: string | null;
  run_id: number | null;
}

export interface ArtifactRow {
  id: number;
  role_id: number | null;
  kind: string;
  path_or_ref: string | null;
  content: string | null;
  lint: string | null;
  verified_at: string | null;
  readback: string | null;
  created_at: string;
  run_id: number | null;
}

export interface SourceRow {
  name: string;
  last_run: string | null;
  status: string;
  status_changed_at: string | null;
  consecutive_failures: number;
  found: number;
  applied: number;
  last_error: string | null;
}

export interface RuleRow {
  id: number;
  text: string;
  reason: string;
  example: string | null;
  added_by: string;
  added_on: string;
  active: number;
}

export interface ProfileRow {
  key: string;
  value: string;
}

export interface DocumentRow {
  name: string;
  content: string;
  updated_at: string;
}

export interface InterviewRow {
  id: number;
  role_id: number;
  starts_at: string | null;
  tz: string | null;
  stage: string | null;
  people: string | null;
  link: string | null;
  booked_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface RunRow {
  id: number;
  kind: string;
  started_at: string;
  finished_at: string | null;
  capabilities: string | null;
  summary: string | null;
}

// Two processes opening a fresh database at once can both try to switch it to WAL. SQLite skips
// the busy handler there when waiting would deadlock a lock upgrade, so one fails at once with
// SQLITE_BUSY. Skip if already WAL; else retry. Worst case is about the deadline plus busy_timeout,
// since a single attempt can itself block that long.
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + 5000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      if (row.journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (err) {
      const code = (err as { errcode?: number }).errcode;
      if (code === undefined || (code & 0xff) !== 5 || Date.now() > deadline) throw err; // 5 = SQLITE_BUSY, incl. extended codes
      Atomics.wait(sleep, 0, 0, 20);
    }
  }
}

export function openDb(path: string = defaultDbPath(), { readOnly = false }: { readOnly?: boolean } = {}): DatabaseSync {
  const onDisk = path !== ':memory:';
  if (onDisk && !readOnly) {
    const dir = dirname(resolve(path));
    if (dir === resolve(jobTrackerHome())) secureDir(dir);
    else mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
  // Another session or a hook may hold the write lock; wait for it instead of failing.
  db.exec('PRAGMA busy_timeout = 5000;');
  if (readOnly) {
    schemaVersion(db, path); // refuse a newer database even when only reading
    return db;
  }
  if (onDisk) {
    secureFile(path); // before WAL: SQLite gives -wal and -shm the database file's mode
    enableWal(db);
  }
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, path);
  if (onDisk) for (const f of [`${path}-wal`, `${path}-shm`]) secureFile(f);
  return db;
}

// BEGIN IMMEDIATE takes the write lock up front, so a read-then-write cannot lose a race.
// Nested calls join the outer transaction: they neither begin nor commit, and an inner
// failure only rolls anything back if it propagates out of the outermost call.
const inTx = new WeakSet<DatabaseSync>();
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (inTx.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTx.add(db);
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    // A failed COMMIT may already have ended the transaction; don't let ROLLBACK mask the real error.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  } finally {
    inTx.delete(db);
  }
}

export function now(): string {
  return new Date().toISOString();
}

// Records that a role answers to this URL, and to the ATS posting behind it if there is one. Evidence is kept if
// the URL is seen again. Whether the identity may join this role is for the caller to decide.
export function indexRoleUrl(db: DatabaseSync, role_id: number, url: string, evidence: string | null = null): void {
  const { normalized_url, posting } = urlIdentity(url);
  if (!normalized_url) return;
  db.prepare(`INSERT INTO role_urls(role_id, url, normalized_url, evidence) VALUES(?, ?, ?, ?)
    ON CONFLICT(role_id, normalized_url) DO UPDATE SET evidence = COALESCE(role_urls.evidence, excluded.evidence)`).run(role_id, url, normalized_url, evidence);
  if (posting) db.prepare('INSERT OR IGNORE INTO role_postings(role_id, provider, employer_key, posting_id) VALUES(?, ?, ?, ?)').run(role_id, posting.provider, posting.employer_key, posting.posting_id);
}

export const SCHEMA_VERSION = 3;

// MIGRATIONS[i] takes the schema from version i + 1 to i + 2. Append only; never edit a shipped one.
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 2: run attribution for artifacts, an index for run-scoped reports, interview times in UTC.
  (db) => {
    db.exec('ALTER TABLE artifacts ADD COLUMN run_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS events_run ON events(run_id)');
    let fallback = 'UTC';
    try {
      const row = db.prepare("SELECT value FROM profile WHERE key = 'filters'").get() as Pick<ProfileRow, 'value'> | undefined;
      const tz: unknown = JSON.parse(row?.value || '{}').timezone;
      if (isValidTimeZone(tz)) fallback = tz;
    } catch {
      // Unreadable filters: keep UTC.
    }
    const update = db.prepare('UPDATE interviews SET starts_at = ? WHERE id = ?');
    const rows = db.prepare('SELECT id, starts_at, tz FROM interviews WHERE starts_at IS NOT NULL').all() as Pick<InterviewRow, 'id' | 'starts_at' | 'tz'>[];
    for (const i of rows) {
      try {
        update.run(toUtcIso(i.starts_at, isValidTimeZone(i.tz) ? i.tz : fallback), i.id);
      } catch {
        // Not a parseable time: leave it for the user to see.
      }
    }
  },
  // 3: every URL and ATS posting a role answers to. Keys are per role, not global: rows that already share a
  // posting must survive the migration and show up as a lookup conflict, since which one is right is not ours to guess.
  (db) => {
    db.exec(`
      CREATE TABLE role_urls (
        role_id INTEGER NOT NULL REFERENCES roles(id),
        url TEXT NOT NULL,
        normalized_url TEXT NOT NULL,
        evidence TEXT,
        PRIMARY KEY (role_id, normalized_url)
      );
      CREATE INDEX role_urls_lookup ON role_urls(normalized_url);
      CREATE TABLE role_postings (
        role_id INTEGER NOT NULL REFERENCES roles(id),
        provider TEXT NOT NULL,
        employer_key TEXT NOT NULL,
        posting_id TEXT NOT NULL,
        PRIMARY KEY (role_id, provider, employer_key, posting_id)
      );
      CREATE INDEX role_postings_lookup ON role_postings(provider, employer_key, posting_id);
    `);
    const rows = db.prepare("SELECT id, url FROM roles WHERE typeof(url) = 'text' ORDER BY id").all() as { id: number; url: string }[];
    for (const r of rows) indexRoleUrl(db, r.id, r.url);
  },
];

function schemaVersion(db: DatabaseSync, path: string): number {
  const { user_version: v } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (v > SCHEMA_VERSION) throw new Error(`${path} is schema version ${v}, but this plugin knows up to ${SCHEMA_VERSION}. Update the plugin.`);
  return v;
}

// One step per transaction, with the version re-read under the write lock: another process may
// be migrating the same file, and a stale read would run a step twice or move the version backwards.
function migrate(db: DatabaseSync, path: string): void {
  if (schemaVersion(db, path) === SCHEMA_VERSION) return; // common case: no write lock
  for (;;) {
    const done = tx(db, () => {
      const v = schemaVersion(db, path);
      if (v >= SCHEMA_VERSION) return true;
      if (v === 0) {
        // Fresh file, or a database from before versioning (identical to v1): CREATE IF NOT EXISTS covers both.
        db.exec(SCHEMA_V1);
        db.exec('PRAGMA user_version = 1');
        return false;
      }
      const step = MIGRATIONS[v - 1];
      if (!step) throw new Error(`No migration from schema version ${v}.`);
      step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      return false;
    });
    if (done) return;
  }
}
