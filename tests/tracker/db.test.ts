// Database layer: locking, migrations and file permissions.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, readTx, SCHEMA_V1, SCHEMA_VERSION, tx } from '../../plugin/servers/tracker/src/db.ts';
import { secureDir, secureFile } from '../../plugin/servers/tracker/src/fsperm.ts';
import { importLegacy } from '../../plugin/servers/tracker/src/legacy.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';
import { REWIND_TO_V5 } from './helpers.ts';

const tempDb = () => join(mkdtempSync(join(tmpdir(), 'jh-db-')), 'tracker.db');
const addRule = (db: ReturnType<typeof openDb>, text: string) =>
  db.exec(`INSERT INTO rules(text, reason, added_by, added_on) VALUES('${text}', 'b', 'user', '2026-01-01')`);
const ruleTexts = (db: ReturnType<typeof openDb>) =>
  db.prepare('SELECT text FROM rules ORDER BY id').all().map((r) => r.text);

test('a second writer waits for the lock instead of failing', { timeout: 10_000 }, async () => {
  const path = tempDb();
  openDb(path).close();
  const dbUrl = new URL('../../plugin/servers/tracker/src/db.ts', import.meta.url).href;
  // Another process (another Claude session) holds the write lock for 300 ms.
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { openDb } from ${JSON.stringify(dbUrl)};
    const db = openDb(${JSON.stringify(path)});
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO rules(text, reason, added_by, added_on) VALUES('a', 'b', 'user', '2026-01-01')");
    process.stdout.write('locked\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('COMMIT');
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d) => /locked/.test(String(d)) && resolve());
    void exited.then((code) => reject(new Error(`child exited (${code}) before taking the lock`)));
  });
  const db = openDb(path);
  try {
    assert.equal(new Tracker(db).addRule({ text: 'c', reason: 'd' }).rule_id, 2);
  } finally {
    db.close();
  }
  assert.equal(await exited, 0);
});

test('a nested tx joins the outer transaction and commits once', () => {
  const db = openDb(':memory:');
  tx(db, () => {
    addRule(db, 'outer');
    tx(db, () => addRule(db, 'inner'));
    assert.equal(db.isTransaction, true);
  });
  assert.equal(db.isTransaction, false);
  assert.deepEqual(ruleTexts(db), ['outer', 'inner']);
});

test('a throw inside a nested tx rolls back the outer writes too', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => {
    addRule(db, 'outer');
    tx(db, () => {
      addRule(db, 'inner');
      throw new Error('boom');
    });
  }), /boom/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(ruleTexts(db), []);
  tx(db, () => addRule(db, 'after')); // the inTx marker was cleared
  assert.deepEqual(ruleTexts(db), ['after']);
});

test('a readTx inside a tx joins it and sees its uncommitted write', () => {
  const db = openDb(':memory:');
  tx(db, () => {
    addRule(db, 'outer');
    assert.deepEqual(readTx(db, () => ruleTexts(db)), ['outer']);
    assert.equal(db.isTransaction, true, 'the read did not commit the outer transaction');
    addRule(db, 'later');
  });
  assert.deepEqual(ruleTexts(db), ['outer', 'later']);
});

test('a throw inside a readTx nested in a tx rolls the outer writes back', () => {
  const db = openDb(':memory:');
  assert.throws(() => tx(db, () => {
    addRule(db, 'outer');
    readTx(db, () => {
      throw new Error('boom');
    });
  }), /boom/);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(ruleTexts(db), []);
  tx(db, () => addRule(db, 'after'));
  assert.deepEqual(ruleTexts(db), ['after']);
});

test('a tx inside a readTx is a bug: it throws a plain Error and the read ends cleanly', () => {
  const db = openDb(':memory:');
  addRule(db, 'kept');
  assert.throws(() => readTx(db, () => tx(db, () => addRule(db, 'sneaked'))), (e) => e instanceof Error && e.constructor === Error && /read transaction/.test(e.message));
  assert.equal(db.isTransaction, false);
  assert.deepEqual(ruleTexts(db), ['kept']);
  tx(db, () => addRule(db, 'after')); // neither marker is left behind
  assert.deepEqual(readTx(db, () => ruleTexts(db)), ['kept', 'after']);
});

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('a pre-versioning database is marked v1 and migrated to the current version', () => {
  const path = tempDb();
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.exec(`
    INSERT INTO profile(key, value) VALUES('filters', '{"timezone":"Europe/Berlin"}');
    INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z');
    INSERT INTO roles(id, company_id, title, first_seen, updated_at, status) VALUES(1, 1, 'Eng', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'applied');
    INSERT INTO interviews(role_id, starts_at, tz, stage, created_at) VALUES(1, '2026-10-20T10:00+02:00', NULL, 'screen', '2026-01-01T00:00:00Z');
    INSERT INTO interviews(role_id, starts_at, tz, stage, created_at) VALUES(1, '2026-10-21T10:00', NULL, 'tech', '2026-01-01T00:00:00Z');
    INSERT INTO interviews(role_id, starts_at, tz, stage, created_at) VALUES(1, '2026-10-22T10:00', 'Asia/Tokyo', 'final', '2026-01-01T00:00:00Z');
    INSERT INTO interviews(role_id, starts_at, tz, stage, created_at) VALUES(1, 'next week', NULL, 'offer chat', '2026-01-01T00:00:00Z');
    INSERT INTO interviews(role_id, starts_at, tz, stage, created_at) VALUES(1, '2026-10-23T10:00', 'Mars/Base', 'bad zone', '2026-01-01T00:00:00Z');
  `);
  raw.close();
  const db = openDb(path);
  assert.equal(userVersion(db), SCHEMA_VERSION);
  assert.equal((db.prepare('SELECT title FROM roles WHERE id = 1').get() as { title: string }).title, 'Eng');
  assert.ok(db.prepare('PRAGMA table_info(artifacts)').all().some((c) => c.name === 'run_id'));
  assert.deepEqual(db.prepare('SELECT starts_at FROM interviews ORDER BY id').all().map((r) => r.starts_at), [
    '2026-10-20T08:00:00.000Z',
    '2026-10-21T08:00:00.000Z',
    '2026-10-22T01:00:00.000Z',
    'next week',
    '2026-10-23T08:00:00.000Z', // invalid row tz: falls back to filters.timezone (Europe/Berlin)
  ]);
  db.close();
  // Reopening is a no-op.
  const again = openDb(path);
  assert.equal(userVersion(again), SCHEMA_VERSION);
  again.close();
});

// A database as the release before rule types left it (schema v4): active and inactive rules, an event citing each.
function v4Database(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.exec(`
    ALTER TABLE artifacts ADD COLUMN run_id INTEGER;
    CREATE TABLE role_urls (role_id INTEGER NOT NULL REFERENCES roles(id), url TEXT NOT NULL, normalized_url TEXT NOT NULL, evidence TEXT, PRIMARY KEY (role_id, normalized_url));
    CREATE TABLE role_postings (role_id INTEGER NOT NULL REFERENCES roles(id), provider TEXT NOT NULL, employer_key TEXT NOT NULL, posting_id TEXT NOT NULL, PRIMARY KEY (role_id, provider, employer_key, posting_id));
    CREATE TABLE role_links (duplicate_role_id INTEGER PRIMARY KEY REFERENCES roles(id), canonical_role_id INTEGER NOT NULL REFERENCES roles(id), reason TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL);
    PRAGMA user_version = 4;
    INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z');
    INSERT INTO roles(id, company_id, title, first_seen, updated_at, status) VALUES(1, 1, 'Engineer', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'dropped');
    INSERT INTO rules(id, text, reason, example, added_by, added_on, active) VALUES(3, 'No agencies', 'Seen twice', 'Acme Staffing', 'pipeline', '2026-02-03', 1);
    INSERT INTO rules(id, text, reason, example, added_by, added_on, active) VALUES(9, 'No crypto', 'User said so', NULL, 'user', '2026-01-04', 0);
    INSERT INTO events(id, role_id, ts, status, actor, reason, evidence) VALUES(1, 1, '2026-02-04T00:00:00Z', 'dropped', 'pipeline', 'Agency', 'rule:3');
    INSERT INTO events(id, role_id, ts, status, actor, reason, evidence) VALUES(2, 1, '2026-02-05T00:00:00Z', 'dropped', 'pipeline', 'Crypto', 'rule:9');
  `);
  raw.close();
}

test('upgrading from v4 classifies every rule as global and keeps its provenance and citations', () => {
  const path = tempDb();
  v4Database(path);
  const db = openDb(path);
  let revision: number;
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT * FROM rules ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 3, text: 'No agencies', reason: 'Seen twice', example: 'Acme Staffing', added_by: 'pipeline', added_on: '2026-02-03', active: 1 },
      { id: 9, text: 'No crypto', reason: 'User said so', example: null, added_by: 'user', added_on: '2026-01-04', active: 0 },
    ]);
    assert.deepEqual(db.prepare('SELECT rule_id, type FROM rule_types ORDER BY rule_id').all().map((r) => ({ ...r })), [
      { rule_id: 3, type: 'global' },
      { rule_id: 9, type: 'global' },
    ]);
    const t = new Tracker(db);
    assert.deepEqual(t.listRules({ include_inactive: true }).rules.map((r) => [r.id, r.types]), [[3, ['global']], [9, ['global']]]);
    // The events that cite a rule still resolve, and a new citation of an old rule still validates.
    assert.deepEqual(db.prepare('SELECT id, evidence FROM events ORDER BY id').all().map((r) => ({ ...r })), [{ id: 1, evidence: 'rule:3' }, { id: 2, evidence: 'rule:9' }]);
    t.record({ role_id: 1, status: 'dropped', reason: 'Agency again', evidence: 'rule:9', actor: 'pipeline' });
    t.addRule({ text: 'New', reason: 'r', types: ['forms'] });
    revision = t.listRules().rules_revision;
    assert.equal(revision, 1);
  } finally {
    db.close();
  }
  const again = openDb(path);
  try {
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM rule_types').get()?.n, 3, 'reopening adds no type rows');
    assert.equal(new Tracker(again).listRules().rules_revision, revision, 'reopening does not reset the revision');
  } finally {
    again.close();
  }
});

const ROLE_ONE = 'https://jobs.ashbyhq.com/acme/one?utm_source=mail';

// A database as the previous release left it: two rows for one posting, a same-title row that is another
// posting, a role without a URL, and history on each.
function v2Database(path: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.exec('ALTER TABLE artifacts ADD COLUMN run_id INTEGER; PRAGMA user_version = 2;');
  const role = raw.prepare("INSERT INTO roles(id, company_id, title, url, first_seen, updated_at, status) VALUES(?, 1, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)");
  raw.exec("INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z')");
  role.run(1, 'Engineer', ROLE_ONE, 'applied');
  role.run(2, 'Engineer', 'https://jobs.ashbyhq.com/acme/one', 'closed');
  role.run(3, 'Engineer', 'https://jobs.ashbyhq.com/acme/two', 'found');
  role.run(4, 'Designer', null, 'found');
  raw.exec(`
    INSERT INTO events(id, role_id, ts, status, actor, reason, evidence) VALUES(7, 1, '2026-01-02T00:00:00Z', 'applied', 'user', 'Sent', 'Thanks for applying');
    INSERT INTO events(id, role_id, ts, status, outcome, actor, reason, evidence) VALUES(8, 2, '2026-01-03T00:00:00Z', 'closed', 'rejected', 'employer', 'No', 'Not moving forward');
    INSERT INTO artifacts(id, role_id, kind, content, created_at) VALUES(5, 2, 'note', 'Prep', '2026-01-02T00:00:00Z');
    INSERT INTO interviews(id, role_id, stage, created_at) VALUES(6, 1, 'screen', '2026-01-02T00:00:00Z');
  `);
  raw.close();
}

// A database as the release before event sources left it (schema v5): the current schema minus what v6 added.
function v5Database(path: string): void {
  const db = openDb(path);
  db.exec(`
    ${REWIND_TO_V5}
    INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z');
    INSERT INTO roles(id, company_id, title, first_seen, updated_at, status) VALUES(1, 1, 'Engineer', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'queued');
    INSERT INTO events(id, role_id, ts, status, actor, reason) VALUES(1, 1, '2026-02-04T00:00:00Z', 'found', 'pipeline', 'Found');
    INSERT INTO events(id, role_id, ts, status, actor, reason) VALUES(2, 1, '2026-02-05T00:00:00.000Z', 'queued', 'pipeline', 'Queued');
  `);
  db.close();
}

test('upgrading from v5 keeps every event, dates its receipt by its time, and makes external ids unique', () => {
  const path = tempDb();
  v5Database(path);
  const db = openDb(path);
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT id, ts, received_at, source, source_account, source_id FROM events ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 1, ts: '2026-02-04T00:00:00Z', received_at: '2026-02-04T00:00:00Z', source: null, source_account: null, source_id: null },
      { id: 2, ts: '2026-02-05T00:00:00.000Z', received_at: '2026-02-05T00:00:00.000Z', source: null, source_account: null, source_id: null },
    ]);
    const t = new Tracker(db);
    const ack = { role_id: 1, actor: 'user', status: 'applied', reason: 'Ack', evidence: 'Received', source: 'gmail', source_account: 'jobs@example.test', source_id: 'm1', occurred_at: '2026-03-01T09:00:00Z' };
    assert.equal(t.record(ack).duplicate, false);
    assert.equal(t.record(ack).duplicate, true);
    // The index is the backstop under the check: a second row with the same identity cannot be written at all.
    assert.throws(() => db.exec("INSERT INTO events(role_id, ts, actor, reason, source, source_account, source_id) VALUES(1, '2026-03-02T00:00:00Z', 'user', 'x', 'gmail', 'jobs@example.test', 'm1')"), /UNIQUE/);
    // Events without an external identity are not constrained by it.
    db.exec("INSERT INTO events(role_id, ts, actor, reason) VALUES(1, '2026-03-02T00:00:00Z', 'user', 'a'), (1, '2026-03-02T00:00:00Z', 'user', 'b')");
  } finally {
    db.close();
  }
  const again = openDb(path);
  try {
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM events').get()?.n, 5, 'reopening adds nothing');
  } finally {
    again.close();
  }
});

test('migrating keeps every row and indexes every URL, and duplicates become a lookup conflict', () => {
  const path = tempDb();
  v2Database(path);
  // Reopening must not run the backfill twice.
  for (let i = 0; i < 2; i++) openDb(path).close();
  const db = openDb(path);
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.deepEqual(db.prepare('SELECT id, title, url, status FROM roles ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 1, title: 'Engineer', url: ROLE_ONE, status: 'applied' },
      { id: 2, title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/one', status: 'closed' },
      { id: 3, title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/two', status: 'found' },
      { id: 4, title: 'Designer', url: null, status: 'found' },
    ]);
    assert.deepEqual(db.prepare('SELECT id, role_id, evidence FROM events ORDER BY id').all().map((r) => ({ ...r })), [
      { id: 7, role_id: 1, evidence: 'Thanks for applying' },
      { id: 8, role_id: 2, evidence: 'Not moving forward' },
    ]);
    assert.deepEqual({ ...db.prepare('SELECT id, role_id, content FROM artifacts').get() }, { id: 5, role_id: 2, content: 'Prep' });
    assert.deepEqual({ ...db.prepare('SELECT id, role_id FROM interviews').get() }, { id: 6, role_id: 1 });
    assert.deepEqual(db.prepare('SELECT role_id, url, normalized_url, evidence FROM role_urls ORDER BY role_id').all().map((r) => ({ ...r })), [
      { role_id: 1, url: ROLE_ONE, normalized_url: 'https://jobs.ashbyhq.com/acme/one', evidence: null },
      { role_id: 2, url: 'https://jobs.ashbyhq.com/acme/one', normalized_url: 'https://jobs.ashbyhq.com/acme/one', evidence: null },
      { role_id: 3, url: 'https://jobs.ashbyhq.com/acme/two', normalized_url: 'https://jobs.ashbyhq.com/acme/two', evidence: null },
    ]);
    assert.deepEqual(db.prepare('SELECT role_id, provider, employer_key, posting_id FROM role_postings ORDER BY role_id').all().map((r) => ({ ...r })), [
      { role_id: 1, provider: 'ashby', employer_key: 'acme', posting_id: 'one' },
      { role_id: 2, provider: 'ashby', employer_key: 'acme', posting_id: 'one' },
      { role_id: 3, provider: 'ashby', employer_key: 'acme', posting_id: 'two' },
    ]);
    const t = new Tracker(db);
    const looked = t.findCompany({ url: 'https://jobs.ashbyhq.com/acme/one' });
    assert.equal(looked.verdict, 'skip');
    assert.deepEqual(looked.exact_role_ids, [1, 2]);
    assert.throws(() => t.upsertRole({ company: 'Acme', title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/one' }), /roles 1, 2/);
    assert.equal(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM roles')?.n, 4, 'a conflict creates nothing');
    assert.equal(t.mustRole(1).url, ROLE_ONE, 'a conflict overwrites nothing');
    assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/acme/two' }).exact_role_ids, [3]);
  } finally {
    db.close();
  }
});

test('an upgraded database links its old duplicates, and the link survives reopening', () => {
  const path = tempDb();
  v2Database(path);
  const db = openDb(path);
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    const t = new Tracker(db);
    assert.equal(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM role_links')?.n, 0);
    // Role 2's rejection is newer than role 1's application, so role 1 must hold it before it can be the card.
    assert.throws(() => t.linkDuplicateRole({ canonical_role_id: 1, duplicate_role_id: 2, reason: 'Same posting', evidence: 'Both link to acme/one' }), /role 1 is applied and role 2 is closed \(rejected\)/);
    t.record({ role_id: 1, status: 'closed', outcome: 'rejected', actor: 'employer', reason: 'No', evidence: 'Not moving forward' });
    t.linkDuplicateRole({ canonical_role_id: 1, duplicate_role_id: 2, reason: 'Same posting', evidence: 'Both link to acme/one' });
  } finally {
    db.close();
  }
  const again = openDb(path);
  try {
    const t = new Tracker(again);
    assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/acme/one' }).exact_role_ids, [1]);
    assert.deepEqual(t.roleDetail({ role_id: 2 }).events.map((e) => [e.id, e.role_id]).slice(0, 2), [[7, 1], [8, 2]]);
    assert.deepEqual(t.roleDetail({ role_id: 2 }).artifacts.map((a) => [a.id, a.role_id]), [[5, 2]]);
    assert.deepEqual(t.roleDetail({ role_id: 2 }).interviews.map((i) => [i.id, i.role_id]), [[6, 1]]);
  } finally {
    again.close();
  }
});

test('a historical URL the parser rejects survives as a raw alias and stays findable', () => {
  const path = tempDb();
  const urls = ['https://user:secret@careers.example/job', 'mailto:jobs@acme.example', 'see the careers page'];
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.exec('ALTER TABLE artifacts ADD COLUMN run_id INTEGER; PRAGMA user_version = 2;');
  raw.exec("INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z')");
  const role = raw.prepare("INSERT INTO roles(company_id, title, url, first_seen, updated_at, status) VALUES(1, 'Engineer', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'found')");
  for (const url of [...urls, '', '   ', new Uint8Array([1, 2])]) role.run(url);
  raw.close();
  // A throw here would stop the server from starting at all.
  const db = openDb(path);
  try {
    const t = new Tracker(db);
    assert.deepEqual(db.prepare('SELECT url, normalized_url FROM role_urls ORDER BY role_id').all().map((r) => ({ ...r })), urls.map((url) => ({ url, normalized_url: url })));
    urls.forEach((url, i) => {
      assert.deepEqual(t.findCompany({ url }).exact_role_ids, [i + 1]);
      assert.equal(t.findCompany({ url }).verdict, 'skip');
    });
    // Updating such a role by id must not re-parse the URL it already holds.
    assert.equal(t.upsertRole({ id: 1, title: 'Engineer', stack: 'TypeScript' }).role.url, urls[0]);
    assert.deepEqual(t.roleDetail({ role_id: 2 }).urls.map((u) => u.url), [urls[1]]);
    assert.deepEqual(t.roleDetail({ role_id: 2 }).postings, []);
    // The next real link replaces the stored junk without losing it.
    const posting = 'https://jobs.ashbyhq.com/acme/one';
    assert.equal(t.upsertRole({ id: 3, title: 'Engineer', url: posting }).role.url, posting);
    assert.deepEqual(t.findCompany({ url: urls[2]! }).exact_role_ids, [3]); // urls has three entries
  } finally {
    db.close();
  }
});

test('URLs from importLegacy on an upgraded database are indexed like any other', () => {
  const path = tempDb();
  v2Database(path);
  const db = openDb(path);
  try {
    const t = new Tracker(db);
    const unusual = 'https://user:secret@careers.zenith.example/1';
    importLegacy(t, {
      queue: [
        { filename: 'zenith-engineer.md', content: '# Zenith · Engineer (queued 2026-10-01)\n\n- **Posting:** https://jobs.ashbyhq.com/zenith/9?utm_source=old\n' },
        { filename: 'orbit-engineer.md', content: `# Orbit · Engineer (queued 2026-10-01)\n\n- **Posting:** ${unusual}\n` },
      ],
    });
    const zenith = t.findCompany({ url: 'https://jobs.ashbyhq.com/zenith/9' });
    assert.equal(zenith.verdict, 'skip');
    assert.equal(zenith.exact_role_ids.length, 1);
    assert.deepEqual(t.roleDetail({ role_id: zenith.exact_role_ids[0]! }).postings.map((p) => ({ ...p })), [{ provider: 'ashby', employer_key: 'zenith', posting_id: '9' }]); // length checked above
    assert.equal(t.findCompany({ url: unusual }).exact_role_ids.length, 1, 'one odd line must not abort the import');
    assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/acme/one' }).exact_role_ids, [1, 2], 'the backfill still stands');
  } finally {
    db.close();
  }
});

test('a legacy note that gives a URL-less role its URL indexes it', () => {
  const db = openDb(':memory:');
  try {
    const t = new Tracker(db);
    const { role } = t.upsertRole({ company: 'Zenith', title: 'Engineer' });
    importLegacy(t, { queue: [{ filename: 'zenith-note.md', content: '# Zenith · Engineer\n\n- **Posting:** https://jobs.ashbyhq.com/zenith/9\n' }] });
    assert.equal(t.mustRole(role.id).url, 'https://jobs.ashbyhq.com/zenith/9');
    assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/zenith/9' }).exact_role_ids, [role.id]);
  } finally {
    db.close();
  }
});

test('a database from a newer plugin is refused, read-write and read-only', () => {
  const path = tempDb();
  openDb(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDb(path), /schema version 99/);
  assert.throws(() => openDb(path, { readOnly: true }), /schema version 99/);
});

test('concurrent opens of a pre-versioning database migrate it exactly once', { timeout: 30_000 }, async () => {
  const path = tempDb();
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_V1);
  raw.close();
  const dbUrl = new URL('../../plugin/servers/tracker/src/db.ts', import.meta.url).href;
  const start = Date.now() + 500; // all children open together, after their startup cost
  const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { openDb } from ${JSON.stringify(dbUrl)};
      while (Date.now() < ${start});
      openDb(${JSON.stringify(path)}).close();
    `], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  const results = await Promise.all(Array.from({ length: 6 }, run));
  for (const r of results) assert.deepEqual(r, { code: 0, stderr: '' });
  const db = openDb(path);
  try {
    assert.equal(userVersion(db), SCHEMA_VERSION);
    assert.equal(db.prepare('PRAGMA table_info(artifacts)').all().filter((c) => c.name === 'run_id').length, 1);
  } finally {
    db.close();
  }
});

test('opening an old database read-only leaves it untouched', () => {
  for (const version of [0, 1]) {
    const path = tempDb();
    const raw = new DatabaseSync(path);
    raw.exec(SCHEMA_V1);
    raw.exec(`PRAGMA user_version = ${version}`);
    raw.close();
    const db = openDb(path, { readOnly: true });
    try {
      assert.equal(userVersion(db), version);
      assert.ok(!db.prepare('PRAGMA table_info(artifacts)').all().some((c) => c.name === 'run_id'));
    } finally {
      db.close();
    }
  }
});

test('the newer-version error names the database file', () => {
  const path = tempDb();
  openDb(path).close();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDb(path), (err) => err instanceof Error && err.message.startsWith(path));
});

const mode = (p: string) => statSync(p).mode & 0o777;
const withHome = (home: string, fn: () => void) => {
  const before = { home: process.env.JOB_TRACKER_HOME, db: process.env.JOB_TRACKER_DB };
  process.env.JOB_TRACKER_HOME = home;
  delete process.env.JOB_TRACKER_DB;
  try {
    fn();
  } finally {
    for (const [key, value] of [['JOB_TRACKER_HOME', before.home], ['JOB_TRACKER_DB', before.db]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('the tracker home and database are owner-only', { skip: process.platform === 'win32' }, () => {
  const home = join(mkdtempSync(join(tmpdir(), 'jh-perm-')), 'home');
  withHome(home, () => {
    const path = join(home, 'tracker.db');
    const db = openDb(path);
    try {
      assert.equal(mode(home), 0o700);
      assert.equal(mode(path), 0o600);
      for (const f of [`${path}-wal`, `${path}-shm`]) {
        assert.ok(existsSync(f), `${f} exists while the connection is open`);
        assert.equal(mode(f), 0o600);
      }
    } finally {
      db.close();
    }
  });
});

test('an existing loose home and database are tightened', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'jh-perm-'));
  const path = join(home, 'tracker.db');
  openDb(path).close();
  chmodSync(home, 0o755);
  chmodSync(path, 0o644);
  withHome(home, () => openDb(path).close());
  assert.equal(mode(home), 0o700);
  assert.equal(mode(path), 0o600);
});

test('a database outside the tracker home leaves its directory alone', { skip: process.platform === 'win32' }, () => {
  const other = mkdtempSync(join(tmpdir(), 'jh-other-'));
  chmodSync(other, 0o755);
  const path = join(other, 'tracker.db');
  withHome(join(mkdtempSync(join(tmpdir(), 'jh-perm-')), 'home'), () => openDb(path).close());
  assert.equal(mode(other), 0o755);
  assert.equal(mode(path), 0o600);
});

test('permission tightening is best effort: unsupported chmod warns, anything else throws', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-perm-'));
  const file = join(dir, 'f');
  writeFileSync(file, '');
  const failWith = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const lines: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    for (const code of ['EPERM', 'ENOTSUP', 'EROFS']) {
      secureFile(file, failWith(code));
      secureDir(dir, failWith(code));
    }
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(lines.length, 6);
  assert.equal(lines[0], `[job-hunt] could not restrict permissions on ${file}: EPERM\n`);
  assert.throws(() => secureFile(file, failWith('EIO')), /EIO/);
  assert.throws(() => secureDir(dir, failWith('ENOENT')), /ENOENT/);
  secureFile(join(dir, 'missing')); // a missing file is ignored
});
