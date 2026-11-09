// The user's CV file: checks, the owner-only copy next to the tracker database, and change detection.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { CV_MAX_BYTES, checkCvFile, copyCv, cvFileState, sha256File } from '../../plugin/servers/tracker/src/cv.ts';

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
