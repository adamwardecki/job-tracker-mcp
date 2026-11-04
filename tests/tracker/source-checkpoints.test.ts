// Source checkpoints: the end of the last fully successful scan of one account, kept apart from sources.last_run,
// which moves on failure too.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

function fresh(ctx: TestContext) {
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  return new Tracker(db);
}

const ACCOUNT = 'jobs@example.test';

test('only a complete scan sets the checkpoint; later partial and unavailable reports keep it', (ctx) => {
  const t = fresh(ctx);
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'partial', checked_through: '2026-10-30T00:00:00Z' });
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(t.sourceHealth().checkpoints[0]?.last_coverage, 'partial');
  t.setSourceStatus({ name: 'gmail', status: 'failed', source_account: ACCOUNT, coverage: 'unavailable', error: 'connector offline' });
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(t.sourceHealth().checkpoints[0]?.last_coverage, 'unavailable');
});

test('two accounts of one source keep their own checkpoints, and a new account starts empty', (ctx) => {
  const t = fresh(ctx);
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: 'jobs@example.test', coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: 'other@example.test', coverage: 'partial' });
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: 'jobs@example.test', coverage: 'unavailable' });
  const [jobs, other] = t.sourceHealth().checkpoints;
  assert.equal(jobs?.source_account, 'jobs@example.test');
  assert.equal(jobs?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(jobs?.last_coverage, 'unavailable');
  assert.equal(other?.source_account, 'other@example.test');
  assert.equal(other?.checked_through, null);
  assert.equal(other?.last_coverage, 'partial');
  // A complete scan of one account leaves the other where it was, and Gmail is the same source as gmail.
  t.setSourceStatus({ name: 'Gmail', status: 'ok', source_account: 'other@example.test', coverage: 'complete', checked_through: '2026-10-25T12:00:00+02:00' });
  const after = t.sourceHealth().checkpoints.map((c) => [c.source, c.source_account, c.checked_through]);
  assert.deepEqual(after, [
    ['gmail', 'jobs@example.test', '2026-10-29T00:00:00.000Z'],
    ['gmail', 'other@example.test', '2026-10-25T10:00:00.000Z'],
  ]);
});

test('a late complete scan never moves the checkpoint backward but still records the attempt', (ctx) => {
  const t = fresh(ctx);
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
  const first = t.sourceHealth().checkpoints[0];
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-20T00:00:00Z' });
  const second = t.sourceHealth().checkpoints[0];
  assert.equal(second?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(second?.last_coverage, 'complete');
  assert.ok((second?.last_attempt_at ?? '') >= (first?.last_attempt_at ?? ''));
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-11-01T00:00:00Z' });
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, '2026-11-01T00:00:00.000Z');
});

test('a source failing mid-run after a complete scan keeps the checkpoint and still counts the failure', (ctx) => {
  const t = fresh(ctx);
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
  for (let i = 0; i < 2; i++) t.setSourceStatus({ name: 'gmail', status: 'failed', error: '429', source_account: ACCOUNT, coverage: 'partial', checked_through: '2026-10-31T00:00:00Z' });
  const third = t.setSourceStatus({ name: 'gmail', status: 'failed', error: '429', source_account: ACCOUNT, coverage: 'unavailable' });
  assert.equal(third.source?.consecutive_failures, 3);
  assert.equal(third.source?.status, 'degraded');
  assert.equal(third.changed, true);
  assert.equal(third.checkpoint?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, '2026-10-29T00:00:00.000Z');
  assert.equal(t.sourceHealth().sources[0]?.last_error, '429');
});

test('calls without the new fields behave as before and write no checkpoint', (ctx) => {
  const t = fresh(ctx);
  const r = t.setSourceStatus({ name: 'linkedin', status: 'ok', found: 3 });
  assert.equal(r.changed, true);
  assert.equal('checkpoint' in r, false);
  assert.deepEqual(t.sourceHealth().checkpoints, []);
  assert.equal(t.sourceHealth().sources[0]?.found, 3);
});

for (const [label, args, message] of [
  ['an invalid timestamp', { coverage: 'complete', source_account: ACCOUNT, checked_through: 'yesterday' }, /checked_through must be an ISO 8601 date and time with an explicit offset/],
  ['a timestamp without an offset', { coverage: 'complete', source_account: ACCOUNT, checked_through: '2026-10-29T00:00:00' }, /explicit offset/],
  ['a partial report with an invalid timestamp', { coverage: 'partial', source_account: ACCOUNT, checked_through: 'soon' }, /explicit offset/],
  ['a future timestamp', { coverage: 'complete', source_account: ACCOUNT, checked_through: '2999-01-01T00:00:00Z' }, /in the future/],
  ['a missing account', { coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' }, /coverage needs source_account/],
  ['a blank account', { coverage: 'partial', source_account: '  ' }, /source_account must not be empty/],
  ['complete without checked_through', { coverage: 'complete', source_account: ACCOUNT }, /complete needs checked_through/],
  ['an unknown coverage', { coverage: 'full', source_account: ACCOUNT }, /coverage must be one of complete \| partial \| unavailable/],
  ['an account without coverage', { source_account: ACCOUNT }, /come with coverage/],
  ['checked_through without coverage', { checked_through: '2026-10-29T00:00:00Z' }, /come with coverage/],
] as const) {
  test(`${label} is refused and nothing is written`, (ctx) => {
    const t = fresh(ctx);
    assert.throws(() => t.setSourceStatus({ name: 'gmail', status: 'ok', found: 2, ...args }), message);
    assert.deepEqual(t.sourceHealth(), { sources: [], checkpoints: [] });
  });
}

for (const status of ['failed', 'degraded', 'disabled']) {
  test(`a complete report with status ${status} is refused and nothing is written`, (ctx) => {
    const t = fresh(ctx);
    t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
    const before = JSON.stringify(t.sourceHealth());
    assert.throws(() => t.setSourceStatus({ name: 'gmail', status, source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-30T00:00:00Z' }), new RegExp(`complete needs status ok, not ${status}`));
    assert.equal(JSON.stringify(t.sourceHealth()), before);
  });
}

test('a partial report on a fresh account leaves the cutoff null even with checked_through', (ctx) => {
  const t = fresh(ctx);
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'partial', checked_through: '2026-10-30T00:00:00Z' });
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, null);
  assert.equal(t.sourceHealth().checkpoints[0]?.last_coverage, 'partial');
  t.setSourceStatus({ name: 'gmail', status: 'failed', source_account: ACCOUNT, coverage: 'unavailable', checked_through: '2026-10-31T00:00:00Z' });
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, null);
});

test('every report moves last_attempt_at, a late complete one included', (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  const t = fresh(ctx);
  const attempt = () => t.sourceHealth().checkpoints[0]?.last_attempt_at;
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-29T00:00:00Z' });
  assert.equal(attempt(), '2026-11-04T12:00:00.000Z');
  ctx.mock.timers.setTime(Date.parse('2026-11-04T13:00:00Z'));
  t.setSourceStatus({ name: 'gmail', status: 'ok', source_account: ACCOUNT, coverage: 'complete', checked_through: '2026-10-20T00:00:00Z' });
  assert.equal(attempt(), '2026-11-04T13:00:00.000Z');
  assert.equal(t.sourceHealth().checkpoints[0]?.checked_through, '2026-10-29T00:00:00.000Z');
  ctx.mock.timers.setTime(Date.parse('2026-11-04T14:00:00Z'));
  t.setSourceStatus({ name: 'gmail', status: 'failed', source_account: ACCOUNT, coverage: 'unavailable' });
  assert.equal(attempt(), '2026-11-04T14:00:00.000Z');
});
