// The user's CV file: checks, the owner-only copy next to the tracker database, and change detection.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { CV_MAX_BYTES, checkCvFile, copyCv, cvFileState, sha256File } from '../../plugin/servers/tracker/src/cv.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-cv-'));
});
// Tests that chmod leave nothing unreadable behind, so the temp dir can be removed.
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// chmod does not stop root, and Windows modes are not POSIX.
const skipChmod = process.platform === 'win32' || process.getuid?.() === 0;

const file = (name: string, content: string | Buffer = '%PDF-1.7 made-up CV') => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

test('checkCvFile accepts a PDF or Word file and returns its size', () => {
  assert.equal(checkCvFile(file('cv.pdf', 'abc')), 3);
  assert.equal(checkCvFile(file('cv.DOCX', 'abcd')), 4);
  assert.equal(checkCvFile(file('cv.doc', 'a')), 1);
});

test('checkCvFile rejects what cannot be uploaded, with a message the model can act on', () => {
  assert.throws(() => checkCvFile('cv.pdf'), /must be absolute \(expand ~ first\)/);
  assert.throws(() => checkCvFile(join(dir, 'missing.pdf')), /No file at/);
  mkdirSync(join(dir, 'folder.pdf'));
  assert.throws(() => checkCvFile(join(dir, 'folder.pdf')), /not a file/);
  assert.throws(() => checkCvFile(file('cv.txt')), /PDF or Word/);
  assert.throws(() => checkCvFile(file('empty.pdf', '')), /empty/);
  assert.throws(() => checkCvFile(file('huge.pdf', Buffer.alloc(CV_MAX_BYTES + 1))), /25 MB/);
});

test('copyCv copies into cv/ next to the database, owner-only, replacing a copy with the same name', { skip: process.platform === 'win32' }, () => {
  const src = file('Jane Doe CV.pdf', 'v1');
  const db = join(dir, 'home', 'tracker.db');
  mkdirSync(join(dir, 'home'));
  const dest = copyCv(src, db);
  assert.equal(dest, join(dir, 'home', 'cv', 'Jane Doe CV.pdf'));
  assert.equal(statSync(join(dir, 'home', 'cv')).mode & 0o777, 0o700);
  assert.equal(statSync(dest).mode & 0o777, 0o600);
  writeFileSync(src, 'v2');
  copyCv(src, db);
  assert.equal(sha256File(dest), sha256File(src));
});

test('copyCv needs an on-disk database', () => {
  const src = file('cv.pdf');
  assert.throws(() => copyCv(src, null), /in memory/);
  assert.throws(() => copyCv(src, ':memory:'), /in memory/);
});

test('cvFileState reports a missing file and a changed file', () => {
  const p = file('cv.pdf', 'v1');
  const saved = { path: p, sha256: sha256File(p), bytes: 2 };
  assert.deepEqual(cvFileState(saved), { exists: true, readable: true, changed_since_saved: false });
  writeFileSync(p, 'v2');
  assert.deepEqual(cvFileState(saved), { exists: true, readable: true, changed_since_saved: true });
  writeFileSync(p, 'longer');
  assert.deepEqual(cvFileState(saved), { exists: true, readable: true, changed_since_saved: true });
  assert.deepEqual(cvFileState({ ...saved, path: join(dir, 'gone.pdf') }), { exists: false, readable: false, changed_since_saved: false });
});

test('cvFileState still checks readability when the size already differs', { skip: skipChmod }, () => {
  const p = file('cv.pdf', 'v1');
  const saved = { path: p, sha256: sha256File(p), bytes: 99 };
  chmodSync(p, 0);
  try {
    assert.deepEqual(cvFileState(saved), { exists: true, readable: false, changed_since_saved: false, error: 'EACCES' });
  } finally {
    chmodSync(p, 0o600);
  }
});

test('cvFileState reports an unreadable file instead of throwing', { skip: skipChmod }, () => {
  const p = file('cv.pdf', 'v1');
  const saved = { path: p, sha256: sha256File(p), bytes: 2 };
  chmodSync(p, 0);
  try {
    assert.deepEqual(cvFileState(saved), { exists: true, readable: false, changed_since_saved: false, error: 'EACCES' });
  } finally {
    chmodSync(p, 0o600);
  }
});

test('cvFileState reports a CV in an unsearchable folder as unreadable', { skip: skipChmod }, () => {
  const sub = join(dir, 'locked');
  mkdirSync(sub);
  const p = join(sub, 'cv.pdf');
  writeFileSync(p, 'v1');
  const saved = { path: p, sha256: sha256File(p), bytes: 2 };
  chmodSync(sub, 0);
  try {
    assert.deepEqual(cvFileState(saved), { exists: true, readable: false, changed_since_saved: false, error: 'EACCES' });
  } finally {
    chmodSync(sub, 0o700);
  }
});

test('checkCvFile turns a permission error into a tool error naming the file, not its contents', { skip: skipChmod }, () => {
  const sub = join(dir, 'locked');
  mkdirSync(sub);
  const p = join(sub, 'cv.pdf');
  writeFileSync(p, 'secret-contents');
  chmodSync(sub, 0);
  try {
    assert.throws(
      () => checkCvFile(p),
      (e: unknown) => e instanceof ToolError && /Cannot read cv\.pdf \(EACCES\)\. Ask the user to check the file's permissions/.test(e.message) && !e.message.includes('secret'),
    );
  } finally {
    chmodSync(sub, 0o700);
  }
});

test('copyCv turns copy failures into tool errors', { skip: skipChmod }, () => {
  const src = file('cv.pdf', 'v1');
  const home = join(dir, 'home');
  mkdirSync(home);
  const db = join(home, 'tracker.db');
  // Unreadable source: the copy itself fails.
  chmodSync(src, 0);
  try {
    assert.throws(() => copyCv(src, db), (e: unknown) => e instanceof ToolError && /Cannot copy cv\.pdf into the tracker folder \(EACCES\)/.test(e.message));
  } finally {
    chmodSync(src, 0o600);
  }
  // Unwritable tracker folder with no cv/ yet: mkdir fails.
  const bare = join(dir, 'bare');
  mkdirSync(bare);
  chmodSync(bare, 0o500);
  try {
    assert.throws(() => copyCv(src, join(bare, 'tracker.db')), (e: unknown) => e instanceof ToolError && /Cannot copy cv\.pdf into the tracker folder \(EACCES\)/.test(e.message));
  } finally {
    chmodSync(bare, 0o700);
  }
});

test('save_cv on an unreadable file is a tool error, not a crash', { skip: skipChmod }, () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  chmodSync(p, 0);
  try {
    assert.throws(() => t.saveCv({ path: p, copy: false }), (e: unknown) => e instanceof ToolError && /Cannot read cv\.pdf \(EACCES\)/.test(e.message));
  } finally {
    chmodSync(p, 0o600);
  }
});

const onDisk = () => {
  const dbPath = join(dir, 'tracker.db');
  return new Tracker(openDb(dbPath), { dbPath });
};
// get_cv returns {missing: true} or the record; tests that saved a CV want the record.
const savedCv = (t: Tracker) => {
  const cv = t.getCv();
  assert.ok(!('missing' in cv), 'a CV is saved');
  return cv;
};

test('save_cv with copy: false links a file where it lives; get_cv returns it', () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  assert.deepEqual(t.getCv(), { missing: true });
  assert.deepEqual(t.saveCv({ path: p, copy: false }), { path: p, mode: 'linked', bytes: 2 });
  const cv = savedCv(t);
  assert.equal(cv.path, p);
  assert.equal(cv.mode, 'linked');
  assert.equal(cv.exists, true);
  assert.equal(cv.readable, true);
  assert.equal(cv.changed_since_saved, false);
  assert.match(cv.saved_at, /^\d{4}-\d{2}-\d{2}T/);
});

// A path the user gives can be a download or an upload the app later clears, so copying is the default.
test('save_cv copies by default, so the CV survives the original being moved or deleted', () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  const saved = t.saveCv({ path: p });
  assert.deepEqual(saved, { path: join(dir, 'cv', 'cv.pdf'), mode: 'copied', bytes: 2 });
  rmSync(p);
  const cv = savedCv(t);
  assert.equal(cv.path, saved.path);
  assert.equal(cv.exists, true);
  assert.equal(cv.changed_since_saved, false);
});

test('save_cv with copy keeps a copy next to the database', () => {
  const t = onDisk();
  const p = file('Upload 123.pdf');
  const saved = t.saveCv({ path: p, copy: true });
  assert.equal(saved.path, join(dir, 'cv', 'Upload 123.pdf'));
  assert.equal(saved.mode, 'copied');
  assert.equal(savedCv(t).path, saved.path);
});

test('save_cv with copy on the copy itself keeps the file', { skip: process.platform === 'win32' }, () => {
  const t = onDisk();
  const first = t.saveCv({ path: file('cv.pdf', 'v1'), copy: true });
  const again = t.saveCv({ path: first.path, copy: true });
  assert.equal(again.path, first.path);
  assert.equal(readFileSync(first.path, 'utf8'), 'v1');
  assert.equal(savedCv(t).changed_since_saved, false);
});

test('get_cv flags a moved or edited CV; saving again clears it', () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  t.saveCv({ path: p, copy: false });
  writeFileSync(p, 'v2');
  assert.equal(savedCv(t).changed_since_saved, true);
  t.saveCv({ path: p, copy: false });
  assert.equal(savedCv(t).changed_since_saved, false);
  rmSync(p);
  assert.equal(savedCv(t).exists, false);
});

test('get_cv and setup_status report an unreadable CV instead of throwing', { skip: skipChmod }, () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  t.saveCv({ path: p, copy: false });
  chmodSync(p, 0);
  try {
    const cv = savedCv(t);
    assert.equal(cv.exists, true);
    assert.equal(cv.readable, false);
    assert.equal(cv.changed_since_saved, false);
    const item = t.setupStatus().items.find((i) => i.key === 'cv_file');
    assert.equal(item?.state, 'red');
    assert.equal(item?.detail, `The CV at ${p} cannot be read (EACCES). Fix its permissions or save it again.`);
  } finally {
    chmodSync(p, 0o600);
  }
});

test('the cv key is not a save_config section', () => {
  const t = onDisk();
  assert.throws(() => t.saveConfig({ section: 'cv', data: { path: '/tmp/x.pdf' } }), /unknown section "cv"/);
});

test('save_cv and get_cv are callable over tools/call, and bad files come back as tool errors', async () => {
  const handle = makeHandler(onDisk());
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as RpcResponse;
    return res.result as { isError?: boolean; content: [{ text: string }] };
  };
  const bad = await callTool('save_cv', { path: join(dir, 'nope.pdf') });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /No file at/);
  const ok = await callTool('save_cv', { path: file('cv.pdf'), copy: false });
  assert.equal(ok.isError ?? false, false);
  assert.match((await callTool('get_cv', {})).content[0].text, /"exists": ?true/);
});

test('setup_status cv_file: red until saved, red when gone, amber when changed, green otherwise', () => {
  const t = onDisk();
  const item = () => t.setupStatus().items.find((i) => i.key === 'cv_file');
  const keys = t.setupStatus().items.map((i) => i.key);
  assert.equal(keys.indexOf('cv_file'), keys.indexOf('profile_document') + 1);
  assert.equal(item()?.state, 'red');
  assert.match(item()?.detail || '', /drop it into the chat/);
  const p = file('cv.pdf', 'v1');
  t.saveCv({ path: p, copy: false });
  assert.equal(item()?.state, 'green');
  assert.equal(item()?.detail, 'CV file: cv.pdf (linked)');
  writeFileSync(p, 'v2');
  assert.equal(item()?.state, 'amber');
  rmSync(p);
  assert.equal(item()?.state, 'red');
  assert.match(item()?.detail || '', /is gone/);
});
