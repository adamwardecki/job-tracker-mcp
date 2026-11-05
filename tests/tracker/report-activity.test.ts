// Daily report: a queued role shows in detail only when its action changed in the report's scope (it entered the queue,
// or its question or blocker changed). The rest of the queue is a count, with the 14+ day ones named.
// The user's zone is Europe/Warsaw. Its offset is +01:00 from 2026-10-25 (the end of summer time) and +02:00 before,
// so the local day 2026-10-31 is [2026-10-30T23:00Z, 2026-10-31T23:00Z). Every test freezes the clock.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { renderReport } from '../../plugin/servers/tracker/src/report.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

// The clock for most tests: 2026-10-31 13:00 in Warsaw.
const NOON = '2026-10-31T12:00:00.000Z';

function fresh(ctx: TestContext, nowIso = NOON) {
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse(nowIso) });
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  const t = new Tracker(db);
  t.saveConfig({ section: 'filters', data: { work_mode: ['remote'], residence_country: 'PL', timezone: 'Europe/Warsaw', pay_floor: { amount: 80000, currency: 'EUR', period: 'year', basis: 'gross' }, excluded_industries: ['crypto'] } });
  return t;
}

interface QueuedOptions {
  title?: string;
  score?: number;
  question?: string | null;
  blocked_by?: string | null;
  at: string;
}

// A role queued at `at`. The found event upsertRole writes is moved back to the same time, so the clock says nothing about it.
function queued(t: Tracker, company: string, { title = 'Engineer', score, question = null, blocked_by = null, at }: QueuedOptions): number {
  const { role } = t.upsertRole({ company, title });
  t.run('UPDATE events SET ts = ? WHERE role_id = ?', at, role.id);
  if (score != null) t.run('UPDATE roles SET score = ? WHERE id = ?', score, role.id);
  requeue(t, role.id, { at, question, blocked_by });
  return role.id;
}

// Another queued event, the way a later sweep step or the board writes one.
function requeue(t: Tracker, role_id: number, { at, question = null, blocked_by = null }: { at: string; question?: string | null; blocked_by?: string | null }): number {
  return t.insertEvent({ role_id, status: 'queued', actor: 'pipeline', reason: 'Ready to apply', question, blocked_by, ts: at });
}

test('a role queued today or with a new question is detailed; one unchanged since 20 October is only counted', (ctx) => {
  const t = fresh(ctx);
  const unchangedId = queued(t, 'Unchanged Acme', { score: 7, at: '2026-10-20T10:00:00.000Z' });
  const newId = queued(t, 'New Acme', { score: 9, at: '2026-10-31T08:00:00.000Z' });
  const changedQuestionId = queued(t, 'Changed Acme', { score: 8, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  requeue(t, changedQuestionId, { at: '2026-10-31T09:00:00.000Z', question: 'Relocation needed?' });

  const report = renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(report.queue_activity.new_or_changed, [newId, changedQuestionId]);
  assert.deepEqual(report.queue_activity.waiting, [unchangedId]);
  assert.match(report.markdown, /New or changed today/);
  assert.match(report.markdown, /Still waiting \(1\)/);
  assert.doesNotMatch(report.markdown, /Unchanged Acme.*Apply or drop/);
  assert.match(report.markdown, /job-tracker:board|job-tracker:status/);
});

const waitingIds = (t: Tracker, date = '2026-10-31') => renderReport(t, { date }).queue_activity;

test('repeating an identical queue event today does not bring the role back', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Repeat Acme', { score: 7, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  requeue(t, id, { at: '2026-10-31T09:00:00.000Z', question: 'Visa sponsorship?' });
  t.transition({ role_id: id, to: 'queued', reason: 'Re-checked, still ready', question: 'Visa sponsorship?' });
  assert.deepEqual(waitingIds(t), { new_or_changed: [], waiting: [id], stale_waiting: [] });
});

test('an unrelated note today does not bring the role back', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Note Acme', { score: 7, at: '2026-10-20T10:00:00.000Z' });
  t.record({ role_id: id, reason: 'Recruiter called, nothing decided', actor: 'user' });
  assert.deepEqual(waitingIds(t), { new_or_changed: [], waiting: [id], stale_waiting: [] });
});

test('refreshing the score and URL today does not bring the role back', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Refresh Acme', { score: 7, at: '2026-10-20T10:00:00.000Z' });
  t.upsertRole({ id, title: 'Engineer', url: 'https://jobs.ashbyhq.com/refresh/1', stack: 'Go', comp_min: 90000 });
  t.run('UPDATE roles SET score = 8 WHERE id = ?', id);
  t.transition({ role_id: id, to: 'queued', reason: 'Score updated', score: 9 });
  assert.deepEqual(waitingIds(t), { new_or_changed: [], waiting: [id], stale_waiting: [] });
  assert.equal(t.mustRole(id).score, 9);
});

test('a changed blocker brings the role back', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Blocked Acme', { score: 7, blocked_by: 'browser', at: '2026-10-20T10:00:00.000Z' });
  requeue(t, id, { at: '2026-10-31T09:00:00.000Z', blocked_by: 'login' });
  const report = renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(report.queue_activity, { new_or_changed: [id], waiting: [], stale_waiting: [] });
  assert.match(report.markdown, /### New or changed today\n\n1\. \*\*Blocked Acme\*\*, Engineer \(role \d+\): Apply or drop\?/);
  assert.doesNotMatch(report.markdown, /Still waiting/);
});

test('a cleared question brings the role back, and an unchanged one the next day does not', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Cleared Acme', { score: 7, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  requeue(t, id, { at: '2026-10-31T09:00:00.000Z', question: null });
  assert.deepEqual(waitingIds(t).new_or_changed, [id]);
  assert.deepEqual(waitingIds(t, '2026-11-01'), { new_or_changed: [], waiting: [id], stale_waiting: [] });
});

test('a role that left the queue in the run is not listed, whatever it did earlier', (ctx) => {
  const t = fresh(ctx);
  const applied = queued(t, 'Applied Acme', { score: 9, at: '2026-10-31T08:00:00.000Z' });
  const dropped = queued(t, 'Dropped Acme', { score: 8, question: 'Visa sponsorship?', at: '2026-10-31T08:00:00.000Z' });
  const stays = queued(t, 'Stays Acme', { score: 7, at: '2026-10-31T08:00:00.000Z' });
  t.transition({ role_id: applied, to: 'applied', reason: 'Submitted', evidence: 'Thanks for applying to Applied Acme' });
  t.transition({ role_id: dropped, to: 'dropped', reason: 'Employer said no visa', evidence: '"We do not sponsor visas"' });
  const report = renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(report.queue_activity, { new_or_changed: [stays], waiting: [], stale_waiting: [] });
  assert.doesNotMatch(report.markdown, /### New or changed today[^#]*(Applied|Dropped) Acme/);
});

test('a role untouched for 14+ days is waiting and stale, and named in the report', (ctx) => {
  const t = fresh(ctx);
  const fresher = queued(t, 'Fresh Acme', { score: 5, at: '2026-10-25T10:00:00.000Z' });
  const stale = queued(t, 'Stale Acme', { score: 9, at: '2026-10-10T10:00:00.000Z' });
  const report = renderReport(t, { date: '2026-10-31' });
  // Fresh ones first, then the stale ones, each in open_items order.
  assert.deepEqual(report.queue_activity, { new_or_changed: [], waiting: [fresher, stale], stale_waiting: [stale] });
  assert.match(report.markdown, /### Still waiting \(2\)/);
  assert.match(report.markdown, /1 untouched for 14\+ days/);
  assert.match(report.markdown, new RegExp(`14\\+ days: \\*\\*Stale Acme\\*\\*, Engineer \\(role ${stale}, last activity 2026-10-10\\)`));
  assert.doesNotMatch(report.markdown, /Fresh Acme/);
  assert.doesNotMatch(report.markdown, /Needs you\n\n### New or changed today/);
});

// A run covering [from, to] on the frozen day.
function run(t: Tracker, from: string, to: string): number {
  const { run_id } = t.startRun({ kind: 'sweep', capabilities: { connectors: {} } });
  t.run('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?', from, to, run_id);
  return run_id;
}

test('two runs on one day: each report details only what its own run changed', (ctx) => {
  const t = fresh(ctx, '2026-10-31T14:00:00.000Z');
  const a = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T11:00:00.000Z');
  const b = run(t, '2026-10-31T12:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const inA = queued(t, 'Run A Acme', { score: 9, at: '2026-10-31T10:30:00.000Z' });
  t.run('UPDATE events SET run_id = ? WHERE role_id = ?', a, inA);
  const inB = queued(t, 'Run B Acme', { score: 8, at: '2026-10-31T12:30:00.000Z' });
  t.run('UPDATE events SET run_id = ? WHERE role_id = ?', b, inB);
  // Written during run B by a hook, with no run id: the window still covers it.
  const untagged = queued(t, 'Untagged Acme', { score: 7, at: '2026-10-31T12:45:00.000Z' });
  assert.deepEqual(renderReport(t, { date: '2026-10-31', run_id: b }).queue_activity, { new_or_changed: [inB, untagged], waiting: [inA], stale_waiting: [] });
  assert.deepEqual(renderReport(t, { date: '2026-10-31', run_id: a }).queue_activity, { new_or_changed: [inA], waiting: [inB, untagged], stale_waiting: [] });
  assert.deepEqual(renderReport(t, { date: '2026-10-31' }).queue_activity, { new_or_changed: [inA, inB, untagged], waiting: [], stale_waiting: [] });
});

test('the day starts at Warsaw midnight: 23:00Z on 30 October after summer time ended', (ctx) => {
  const t = fresh(ctx, '2026-11-01T06:00:00.000Z');
  const before = queued(t, 'Before Acme', { score: 9, at: '2026-10-30T22:59:59.000Z' });
  const first = queued(t, 'First Acme', { score: 8, at: '2026-10-30T23:00:00.000Z' });
  const last = queued(t, 'Last Acme', { score: 7, at: '2026-10-31T22:59:59.000Z' });
  const after = queued(t, 'After Acme', { score: 6, at: '2026-10-31T23:00:00.000Z' });
  assert.deepEqual(waitingIds(t, '2026-10-31'), { new_or_changed: [first, last], waiting: [before, after], stale_waiting: [] });
});

test('the day of the clock change is 25 hours: 24 October 22:00Z to 25 October 23:00Z', (ctx) => {
  const t = fresh(ctx, '2026-10-26T12:00:00.000Z');
  const before = queued(t, 'Before Acme', { score: 9, at: '2026-10-24T21:59:59.000Z' });
  const first = queued(t, 'First Acme', { score: 8, at: '2026-10-24T22:00:00.000Z' });
  // 23:30 in Warsaw (+01:00 by then), which a flat +02:00 would put on the next day.
  const last = queued(t, 'Last Acme', { score: 7, at: '2026-10-25T22:30:00.000Z' });
  const after = queued(t, 'After Acme', { score: 6, at: '2026-10-25T23:00:00.000Z' });
  assert.deepEqual(waitingIds(t, '2026-10-25'), { new_or_changed: [first, last], waiting: [before, after], stale_waiting: [] });
});

test('events written on a linked duplicate count toward its canonical card, in one history', (ctx) => {
  const t = fresh(ctx);
  // The copy was found before the role it duplicates, as a link needs.
  const copyOf = (company: string) => {
    const id = t.upsertRole({ company, title: 'Engineer (LinkedIn)' }).role.id;
    t.run("UPDATE events SET ts = '2026-10-19T10:00:00.000Z' WHERE role_id = ?", id);
    return id;
  };
  const link = (canonical: number, duplicate: number) => t.linkDuplicateRole({ canonical_role_id: canonical, duplicate_role_id: duplicate, reason: 'Same posting listed twice', evidence: 'Both link to the same Ashby page' });
  const legacy = (role_id: number, at: string, question: string | null) =>
    t.run("INSERT INTO events(role_id, ts, status, actor, reason, question) VALUES(?, ?, 'queued', 'pipeline', 'Ready to apply', ?)", role_id, at, question);
  const asked = queued(t, 'Alias Acme', { title: 'Engineer', score: 9, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  const askedCopy = copyOf('Alias Acme');
  link(asked, askedCopy);
  legacy(askedCopy, '2026-10-31T09:00:00.000Z', 'Relocation needed?'); // a new question, written on the copy
  const same = queued(t, 'Alias Beta', { score: 8, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  const sameCopy = copyOf('Alias Beta');
  link(same, sameCopy);
  legacy(sameCopy, '2026-10-31T09:00:00.000Z', 'Visa sponsorship?'); // the same question again
  const report = renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(report.queue_activity, { new_or_changed: [asked], waiting: [same], stale_waiting: [] });
  assert.match(report.markdown, new RegExp(`\\*\\*Alias Acme\\*\\*, Engineer \\(role ${asked}\\): Relocation needed\\?`));
  assert.doesNotMatch(report.markdown, /Alias Beta/);
});

test('a draft that was never read back stays under Needs you however old it is', (ctx) => {
  const t = fresh(ctx);
  const { artifact_id } = t.addArtifact({ kind: 'gmail_draft', ref: 'r-old-1', content: 'Thanks, Tuesday works for me.\n\nAlex' });
  t.run("UPDATE artifacts SET created_at = '2026-09-01T10:00:00.000Z' WHERE id = ?", artifact_id);
  const markdown = renderReport(t, { date: '2026-10-31' }).markdown;
  assert.match(markdown, /### Other open actions\n\n1\. Draft r-old-1 was not confirmed by read-back\. Check Gmail drafts\./);
});

test('a booking still to be confirmed stays under Needs you and Interviews however old it is', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Booked Acme', title: 'Engineer' });
  t.insertEvent({ role_id: role.id, status: 'applied', actor: 'user', reason: 'Setup', evidence: 'Received', ts: '2026-09-01T00:00:00.000Z' });
  t.addInterview({ role_id: role.id, stage: 'screen', link: 'https://cal.example.test/booked-acme' });
  t.run("UPDATE interviews SET created_at = '2026-09-02T00:00:00.000Z'");
  const markdown = renderReport(t, { date: '2026-10-31' }).markdown;
  assert.match(markdown, /### Other open actions\n\n1\. Book \*\*Booked Acme\*\* screen: https:\/\/cal\.example\.test\/booked-acme/);
  assert.match(markdown, /## Interviews\n\n- To book: \*\*Booked Acme\*\*, screen \(https:\/\/cal\.example\.test\/booked-acme\)/);
});

test('an audit failure on a role whose queue entry is unchanged is still listed', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Chain Co', title: 'Engineer', industry: 'crypto exchange' });
  t.run("UPDATE events SET ts = '2026-10-20T10:00:00.000Z' WHERE role_id = ?", role.id);
  requeue(t, role.id, { at: '2026-10-20T10:00:00.000Z' });
  requeue(t, role.id, { at: '2026-10-31T09:00:00.000Z' }); // the same action again, today
  const report = renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(report.queue_activity, { new_or_changed: [], waiting: [role.id], stale_waiting: [] });
  assert.equal(report.audit_ok, false);
  assert.match(report.markdown, /### Other open actions\n\n1\. Audit: Chain Co \(crypto exchange\) reached queued despite the excluded-industries filter\./);
  assert.match(report.markdown, /### Still waiting \(1\)/);
});

test('rendering a report writes no events and changes no timestamps', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Read Acme', { score: 7, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  queued(t, 'Read Beta', { score: 8, at: '2026-10-31T08:00:00.000Z' });
  t.addArtifact({ kind: 'gmail_draft', ref: 'r-read-1', content: 'Thanks.\n\nAlex' });
  const snapshot = () => ({
    events: t.q('SELECT * FROM events ORDER BY id'),
    roles: t.q('SELECT id, status, score, first_seen, updated_at, verified_at FROM roles ORDER BY id'),
    artifacts: t.q('SELECT * FROM artifacts ORDER BY id'),
    runs: t.q('SELECT * FROM runs ORDER BY id'),
  });
  const before = snapshot();
  ctx.mock.timers.setTime(Date.parse('2026-10-31T18:00:00.000Z')); // later, so a write would stamp a different time
  renderReport(t, { date: '2026-10-31' });
  renderReport(t, { date: '2026-10-31' });
  assert.deepEqual(snapshot(), before);
  assert.equal(t.mustRole(id).updated_at, '2026-10-31T12:00:00.000Z');
});

const ACK = { actor: 'user', status: 'applied', reason: 'Acknowledgement found in the mailbox', evidence: 'Your application for Ext Acme Engineer was received.', source: 'gmail', source_account: 'jobs@example.test', source_id: 'message-1', occurred_at: '2026-10-05T09:00:00Z' };

test('an old application confirmation found in this run is reported as recorded, with its original date, and not as a submission', (ctx) => {
  const t = fresh(ctx);
  const r = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const id = queued(t, 'Ext Acme', { score: 7, at: '2026-09-01T10:00:00.000Z' });
  const first = t.record({ ...ACK, role_id: id, run_id: r });
  assert.equal(first.duplicate, false);
  for (const args of [{ date: '2026-10-31', run_id: r }, { date: '2026-10-31' }]) {
    const markdown = renderReport(t, args).markdown;
    assert.match(markdown, /## Applied\n\n- \*\*Ext Acme\*\*, Engineer\. Recorded from gmail, applied 2026-10-05: "Your application for Ext Acme Engineer was received\."/);
    assert.match(markdown, /\| Applications submitted \| 0 \|/);
    assert.match(markdown, /\| Applications recorded from mail or boards \| 1 \|/);
    assert.doesNotMatch(markdown, /Confirmation: "Your application/);
  }
  // On the day it happened nothing was received, so that day's report does not claim it.
  assert.doesNotMatch(renderReport(t, { date: '2026-10-05' }).markdown, /Ext Acme/);
});

test('replaying the same source event in a later run does not announce it again', (ctx) => {
  const t = fresh(ctx);
  const first = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const id = queued(t, 'Ext Acme', { score: 7, at: '2026-09-01T10:00:00.000Z' });
  t.record({ ...ACK, role_id: id, run_id: first });
  ctx.mock.timers.setTime(Date.parse('2026-11-01T10:00:00.000Z'));
  const second = run(t, '2026-11-01T09:00:00.000Z', '2026-11-01T11:00:00.000Z');
  const replay = t.record({ ...ACK, role_id: id, run_id: second });
  assert.equal(replay.duplicate, true);
  for (const args of [{ date: '2026-11-01', run_id: second }, { date: '2026-11-01' }]) {
    const markdown = renderReport(t, args).markdown;
    assert.doesNotMatch(markdown, /Ext Acme/);
    assert.match(markdown, /\| Applications recorded from mail or boards \| 0 \|/);
  }
  assert.match(renderReport(t, { date: '2026-10-31', run_id: first }).markdown, /Recorded from gmail, applied 2026-10-05/);
});

test('board and pipeline applications keep their own labels beside a recorded one', (ctx) => {
  const t = fresh(ctx);
  const sent = queued(t, 'Sent Acme', { at: '2026-10-31T08:00:00.000Z' });
  const board = queued(t, 'Board Acme', { at: '2026-10-31T08:00:00.000Z' });
  const mail = queued(t, 'Ext Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.insertEvent({ role_id: sent, status: 'applied', actor: 'pipeline', reason: 'Submitted', evidence: 'Thanks for applying to Sent Acme!', ts: '2026-10-31T09:00:00.000Z' });
  t.insertEvent({ role_id: board, status: 'applied', actor: 'user', reason: 'Moved on the board', ts: '2026-10-31T09:30:00.000Z' });
  t.record({ ...ACK, role_id: mail });
  const markdown = renderReport(t, { date: '2026-10-31' }).markdown;
  assert.match(markdown, /- \*\*Sent Acme\*\*, Engineer\. Confirmation: "Thanks for applying to Sent Acme!"/);
  assert.match(markdown, /- \*\*Board Acme\*\*, Engineer\. Marked applied by you on the board, without confirmation text\./);
  assert.match(markdown, /- \*\*Ext Acme\*\*, Engineer\. Recorded from gmail, applied 2026-10-05:/);
  assert.match(markdown, /\| Applications submitted \| 1 \|/);
  assert.match(markdown, /\| Applications recorded from mail or boards \| 1 \|/);
});

test('a calendar change received today for an old occurrence is a booking change today', (ctx) => {
  const t = fresh(ctx);
  const r = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const { role } = t.upsertRole({ company: 'Booking Acme', title: 'Engineer' });
  t.insertEvent({ role_id: role.id, status: 'applied', actor: 'user', reason: 'Setup', evidence: 'Received', ts: '2026-09-01T00:00:00.000Z' });
  t.addInterview({ role_id: role.id, stage: 'screen', starts_at: '2026-11-10T09:00:00Z', source: 'calendar', source_account: 'jobs@example.test', source_id: 'event-1', occurred_at: '2026-10-05T08:00:00Z', run_id: r });
  for (const args of [{ date: '2026-10-31', run_id: r }, { date: '2026-10-31' }]) {
    const markdown = renderReport(t, args).markdown;
    assert.match(markdown, /## Interviews\n\n(?:- .*\n)*- Booking change: \*\*Booking Acme\*\*, Engineer: Interview 1 \(screen\) booked for 2026-11-10T09:00:00\.000Z/);
  }
  assert.doesNotMatch(renderReport(t, { date: '2026-10-05' }).markdown, /Booking change/);
  assert.doesNotMatch(renderReport(t, { date: '2026-11-01' }).markdown, /Booking change/);
});

test('a role that went back to the queue today is new again even with the same question', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Return Acme', { score: 7, question: 'Visa sponsorship?', at: '2026-10-20T10:00:00.000Z' });
  t.insertEvent({ role_id: id, status: 'scored', actor: 'user', reason: 'Moved on the board', ts: '2026-10-31T08:00:00.000Z' });
  requeue(t, id, { at: '2026-10-31T09:00:00.000Z', question: 'Visa sponsorship?' });
  assert.deepEqual(waitingIds(t), { new_or_changed: [id], waiting: [], stale_waiting: [] });
});

const REJECTION = { actor: 'employer', status: 'closed', outcome: 'rejected', reason: 'Rejection email', evidence: 'We will not be moving forward.', source: 'gmail', source_account: 'jobs@example.test', source_id: 'message-9', occurred_at: '2026-10-28T09:00:00Z' };
const LATE_REJECTION = /## Replies\n\n- \*\*Late Acme\*\*, Engineer: closed \(rejected, 2026-10-28\)\. Rejection email Feedback: "We will not be moving forward\."/;

test('a rejection read today that happened three days ago is reported today with its original date', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Late Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.record({ ...REJECTION, role_id: id }); // no run_id
  assert.match(renderReport(t, { date: '2026-10-31' }).markdown, LATE_REJECTION);
  assert.doesNotMatch(renderReport(t, { date: '2026-10-28' }).markdown, /Late Acme/);
});

test('the same late rejection is found in a run-scoped report', (ctx) => {
  const t = fresh(ctx);
  const r = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const id = queued(t, 'Late Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.record({ ...REJECTION, role_id: id, run_id: r });
  assert.match(renderReport(t, { date: '2026-10-31', run_id: r }).markdown, LATE_REJECTION);
});

test('replaying a late rejection in a later run does not show it again', (ctx) => {
  const t = fresh(ctx);
  const first = run(t, '2026-10-31T10:00:00.000Z', '2026-10-31T13:00:00.000Z');
  const id = queued(t, 'Late Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.record({ ...REJECTION, role_id: id, run_id: first });
  ctx.mock.timers.setTime(Date.parse('2026-11-01T10:00:00.000Z'));
  const second = run(t, '2026-11-01T09:00:00.000Z', '2026-11-01T11:00:00.000Z');
  assert.equal(t.record({ ...REJECTION, role_id: id, run_id: second }).duplicate, true);
  for (const args of [{ date: '2026-11-01', run_id: second }, { date: '2026-11-01' }]) assert.doesNotMatch(renderReport(t, args).markdown, /Late Acme/);
  assert.match(renderReport(t, { date: '2026-10-31', run_id: first }).markdown, LATE_REJECTION);
});

test('a drop read late from outside is listed with its original date', (ctx) => {
  const t = fresh(ctx);
  const id = queued(t, 'Late Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.record({ actor: 'employer', status: 'dropped', category: 'closed_posting', reason: 'Posting withdrawn', evidence: '"This position has been filled"', source: 'gmail', source_account: 'jobs@example.test', source_id: 'message-10', occurred_at: '2026-10-28T09:00:00Z', role_id: id });
  assert.match(renderReport(t, { date: '2026-10-31' }).markdown, /## Dropped\n\n- closed_posting: Late Acme \(Posting withdrawn, 2026-10-28\)/);
});

test('replies and drops that did not come from outside are still found by when they happened', (ctx) => {
  const t = fresh(ctx);
  const replied = queued(t, 'Today Acme', { at: '2026-09-01T10:00:00.000Z' });
  const old = queued(t, 'Old Acme', { at: '2026-09-01T10:00:00.000Z' });
  const dropped = queued(t, 'Drop Acme', { at: '2026-09-01T10:00:00.000Z' });
  t.record({ role_id: replied, actor: 'employer', reason: 'Recruiter wrote back', status: 'closed', outcome: 'rejected', evidence: 'Not this time.' });
  t.insertEvent({ role_id: old, status: 'closed', outcome: 'rejected', actor: 'employer', reason: 'Old rejection', evidence: 'No.', ts: '2026-10-20T09:00:00.000Z' }); // written today, dated earlier
  t.transition({ role_id: dropped, to: 'dropped', reason: 'Pay too low', evidence: '"EUR 40k"', category: 'pay' });
  const markdown = renderReport(t, { date: '2026-10-31' }).markdown;
  assert.match(markdown, /- \*\*Today Acme\*\*, Engineer: closed \(rejected\)\. Recruiter wrote back Feedback: "Not this time\."/);
  assert.doesNotMatch(markdown, /Old Acme/);
  assert.match(markdown, /- pay: Drop Acme \(Pay too low\)/);
});
