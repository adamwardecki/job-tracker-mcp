// The user's CV file: checks, the owner-only copy next to the tracker database, and change detection.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { CV_MAX_BYTES, checkCvFile, copyCv, cvFileState, sha256File } from '../../plugin/servers/tracker/src/cv.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-cv-'));
});

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
  assert.throws(() => checkCvFile('cv.pdf'), /must be absolute/);
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
  const sha256 = sha256File(p);
  assert.deepEqual(cvFileState({ path: p, sha256 }), { exists: true, changed_since_saved: false });
  writeFileSync(p, 'v2');
  assert.deepEqual(cvFileState({ path: p, sha256 }), { exists: true, changed_since_saved: true });
  assert.deepEqual(cvFileState({ path: join(dir, 'gone.pdf'), sha256 }), { exists: false, changed_since_saved: false });
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

test('save_cv links a file where it lives; get_cv returns it', () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  assert.deepEqual(t.getCv(), { missing: true });
  assert.deepEqual(t.saveCv({ path: p }), { path: p, mode: 'linked', bytes: 2 });
  const cv = savedCv(t);
  assert.equal(cv.path, p);
  assert.equal(cv.mode, 'linked');
  assert.equal(cv.exists, true);
  assert.equal(cv.changed_since_saved, false);
  assert.match(cv.saved_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('save_cv with copy keeps a copy next to the database', () => {
  const t = onDisk();
  const p = file('Upload 123.pdf');
  const saved = t.saveCv({ path: p, copy: true });
  assert.equal(saved.path, join(dir, 'cv', 'Upload 123.pdf'));
  assert.equal(saved.mode, 'copied');
  assert.equal(savedCv(t).path, saved.path);
});

test('get_cv flags a moved or edited CV; saving again clears it', () => {
  const t = onDisk();
  const p = file('cv.pdf', 'v1');
  t.saveCv({ path: p });
  writeFileSync(p, 'v2');
  assert.equal(savedCv(t).changed_since_saved, true);
  t.saveCv({ path: p });
  assert.equal(savedCv(t).changed_since_saved, false);
  rmSync(p);
  assert.equal(savedCv(t).exists, false);
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
