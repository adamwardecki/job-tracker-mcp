// Interviews: a confirmed booking updates its pending row instead of adding a second one, and repeated, reordered or
// cancelled calendar events leave the latest state and a history of how it got there.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

function fresh(ctx: TestContext) {
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  return new Tracker(db);
}

function call(t: Tracker) {
  const handle = makeHandler(t);
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as RpcResponse;
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

// An application the employer acknowledged: applied, so an interview may move it on.
function applied(t: Tracker, company = 'Acme', title = 'Engineer'): number {
  const { role } = t.upsertRole({ company, title });
  t.run("UPDATE events SET ts = '2026-01-01T00:00:00.000Z' WHERE role_id = ?", role.id); // the found event upsertRole wrote
  t.insertEvent({ role_id: role.id, status: 'applied', actor: 'user', reason: 'Setup', evidence: 'Received', ts: '2026-09-01T00:00:00.000Z' });
  return role.id;
}

// An interview row as stored, the fields a change can touch plus the identity it is found by.
const snapshot = (t: Tracker, id: number) => ({ ...t.one<Record<string, unknown>>('SELECT starts_at, tz, stage, people, link, booked_by, notes, state, source, source_account, source_id, last_occurred_at FROM interviews WHERE id = ?', id) });

const count = (t: Tracker, table: string, where = '1 = 1', ...params: (string | number)[]) => t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)?.n ?? 0;

test('confirming a booking by id updates the pending row and clears the to-book action', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const pending = t.addInterview({ role_id: roleId, stage: 'Screen', link: 'https://calendar.example.test/book/screen' });
  const booked = t.addInterview({ role_id: roleId, interview_id: pending.interview_id, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00', tz: 'Europe/Warsaw', state: 'scheduled' });
  assert.equal(booked.interview_id, pending.interview_id);
  assert.equal(t.openItems().interviews_to_book.length, 0);
  assert.equal(t.openItems().upcoming_interviews.length, 1);
  assert.equal(t.one<{ n: number }>('SELECT count(*) AS n FROM interviews')?.n, 1);
});

const EVENT = { stage: 'Technical', starts_at: '2099-11-05T14:00:00+01:00', tz: 'Europe/Berlin', link: 'https://meet.example.test/tech', source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-1', occurred_at: '2026-10-01T09:00:00Z' };

test('a repeated calendar occurrence is one interview, and an identical retry changes nothing', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const run = t.startRun({ kind: 'sweep', capabilities: { connectors: {} } }).run_id;
  const first = t.addInterview({ role_id: roleId, ...EVENT, run_id: run });
  assert.deepEqual(first, { interview_id: first.interview_id, created: true, updated: false, stale: false, state: 'scheduled' });
  const events = count(t, 'events');
  const retry = t.addInterview({ role_id: roleId, ...EVENT, source: ' Google_Calendar ', run_id: run });
  assert.deepEqual(retry, { interview_id: first.interview_id, created: false, updated: false, stale: false, state: 'scheduled' });
  assert.equal(count(t, 'interviews'), 1);
  assert.equal(count(t, 'interview_changes'), 1);
  assert.equal(count(t, 'events'), events, 'a retry writes no note');
  assert.deepEqual({ ...t.one<Record<string, unknown>>('SELECT source, source_account, source_id, last_occurred_at, state FROM interviews') }, { source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-1', last_occurred_at: '2026-10-01T09:00:00.000Z', state: 'scheduled' });
  assert.equal(t.one<{ run_id: number }>('SELECT run_id FROM interview_changes')?.run_id, run);
});

const notes = (t: Tracker) => t.q<{ ts: string; run_id: number | null; actor: string; status: string | null; reason: string }>("SELECT ts, run_id, actor, status, reason FROM events WHERE category = 'interview_changed' ORDER BY id");

test('a rescheduled event updates the same row, keeps the old time in the history and leaves a role note', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const run = t.startRun({ kind: 'sweep', capabilities: { connectors: {} } }).run_id;
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  const moved = t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-06T09:30:00+01:00', occurred_at: '2026-10-03T08:00:00Z', run_id: run });
  assert.deepEqual(moved, { interview_id: first.interview_id, created: false, updated: true, stale: false, state: 'scheduled' });
  assert.equal(count(t, 'interviews'), 1);
  assert.equal(t.one<{ starts_at: string }>('SELECT starts_at FROM interviews')?.starts_at, '2099-11-06T08:30:00.000Z');
  const history = t.q<{ occurred_at: string; run_id: number | null; before_json: string | null; after_json: string }>('SELECT occurred_at, run_id, before_json, after_json FROM interview_changes ORDER BY id');
  assert.equal(history.length, 2);
  assert.equal(history[0]?.before_json, null);
  assert.equal(history[1]?.occurred_at, '2026-10-03T08:00:00.000Z');
  assert.equal(history[1]?.run_id, run);
  assert.equal(JSON.parse(history[1]?.before_json ?? '{}').starts_at, '2099-11-05T13:00:00.000Z');
  assert.equal(JSON.parse(history[1]?.after_json ?? '{}').starts_at, '2099-11-06T08:30:00.000Z');
  // The role note D1 reads: one per applied change, dated by the occurrence, carrying the run.
  assert.deepEqual(notes(t).map((n) => [n.ts, n.run_id, n.status]), [['2026-10-01T09:00:00.000Z', null, null], ['2026-10-03T08:00:00.000Z', run, null]]);
  assert.match(notes(t)[1]?.reason ?? '', new RegExp(`Interview ${first.interview_id}.*Technical.*rescheduled`));
  assert.equal(count(t, 'events', "category = 'interview_changed' AND role_id = ?", roleId), 2);
});

test('a cancellation is recorded without a to-book action, and only a newer update can undo it', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  const cancelled = t.addInterview({ role_id: roleId, ...EVENT, state: 'cancelled', occurred_at: '2026-10-04T08:00:00Z' });
  assert.deepEqual(cancelled, { interview_id: first.interview_id, created: false, updated: true, stale: false, state: 'cancelled' });
  assert.equal(t.openItems().interviews_to_book.length, 0);
  assert.equal(t.openItems().upcoming_interviews.length, 0);
  assert.equal(count(t, 'interview_changes'), 2);
  assert.match(notes(t)[1]?.reason ?? '', /cancelled/);
  assert.equal(t.mustRole(roleId).status, 'interviewing', 'a cancelled round does not close the role');
  // Another cancellation at the same moment that differs is a conflict; the same one is a no-op.
  assert.deepEqual(t.addInterview({ role_id: roleId, ...EVENT, state: 'cancelled', occurred_at: '2026-10-04T08:00:00Z' }), { interview_id: first.interview_id, created: false, updated: false, stale: false, state: 'cancelled' });
  assert.throws(() => t.addInterview({ role_id: roleId, ...EVENT, state: 'scheduled', occurred_at: '2026-10-04T08:00:00Z' }), /different state/);
  // A newer scheduling brings it back.
  const rebooked = t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-09T10:00:00+01:00', state: 'scheduled', occurred_at: '2026-10-05T08:00:00Z' });
  assert.equal(rebooked.state, 'scheduled');
  assert.equal(t.openItems().upcoming_interviews.length, 1);
  assert.equal(count(t, 'interviews'), 1);
});

test('a stale pending update cannot undo a scheduling, and a stale scheduling cannot undo a cancellation', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  const older = { role_id: roleId, stage: 'Technical', source: EVENT.source, source_account: EVENT.source_account, source_id: EVENT.source_id, state: 'pending' as const };
  const staleResult = { interview_id: first.interview_id, created: false, updated: false, stale: true, state: 'scheduled' };
  assert.deepEqual(t.addInterview({ ...older, occurred_at: '2026-09-30T09:00:00Z' }), staleResult);
  assert.equal(t.openItems().interviews_to_book.length, 0);
  assert.equal(t.openItems().upcoming_interviews.length, 1);
  assert.equal(count(t, 'interview_changes'), 1);

  t.addInterview({ role_id: roleId, ...EVENT, state: 'cancelled', occurred_at: '2026-10-04T08:00:00Z' });
  const result = t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-07T10:00:00+01:00', occurred_at: '2026-10-02T08:00:00Z' });
  assert.deepEqual(result, { ...staleResult, state: 'cancelled' });
  assert.equal(t.one<{ state: string }>('SELECT state FROM interviews')?.state, 'cancelled');
  assert.equal(count(t, 'interview_changes'), 2);
  assert.equal(notes(t).length, 2);
});

const BOOK = 'https://calendar.example.test/book/screen';

test('a booking confirmed by its link updates the one pending row with that stage and link', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const pending = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  // The same link again is the same pending booking, not a second action.
  assert.deepEqual(t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK }), { interview_id: pending.interview_id, created: false, updated: false, stale: false, state: 'pending' });
  assert.equal(t.openItems().interviews_to_book.length, 1);
  const booked = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK, starts_at: '2099-11-02T10:00:00+01:00', ...{ source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-9', occurred_at: '2026-10-02T08:00:00Z' } });
  assert.deepEqual(booked, { interview_id: pending.interview_id, created: false, updated: true, stale: false, state: 'scheduled' });
  assert.equal(count(t, 'interviews'), 1);
  assert.equal(t.openItems().interviews_to_book.length, 0);
  assert.equal(t.one<{ source_id: string }>('SELECT source_id FROM interviews')?.source_id, 'evt-9', 'the row is now found by the calendar event');
  // The meeting link may change once the row is resolved.
  t.addInterview({ role_id: roleId, interview_id: pending.interview_id, stage: 'Screen', link: 'https://meet.example.test/screen' });
  assert.equal(t.one<{ link: string }>('SELECT link FROM interviews')?.link, 'https://meet.example.test/screen');
});

test('two rounds on one role stay separate', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const screen = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  const tech = t.addInterview({ role_id: roleId, stage: 'Technical', link: 'https://calendar.example.test/book/tech' });
  const again = t.addInterview({ role_id: roleId, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00', tz: 'Europe/Warsaw' });
  const second = t.addInterview({ role_id: roleId, stage: 'Screen', starts_at: '2099-11-03T10:00:00+01:00', tz: 'Europe/Warsaw' });
  assert.equal(new Set([screen.interview_id, tech.interview_id, again.interview_id, second.interview_id]).size, 4);
  assert.equal(count(t, 'interviews'), 4);
  assert.equal(t.openItems().interviews_to_book.length, 2, 'a stage alone never identifies a round, so the link-less call added its own');
  assert.equal(t.openItems().upcoming_interviews.length, 2);
  // Confirming one round by id leaves the other pending.
  t.addInterview({ role_id: roleId, interview_id: tech.interview_id, stage: 'Technical', starts_at: '2099-11-10T10:00:00+01:00' });
  assert.deepEqual(t.openItems().interviews_to_book.map((i) => i.id), [screen.interview_id]);
});

test('several pending rows matching one stage and link are listed and nothing is written', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const a = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  t.run('INSERT INTO interviews(role_id, stage, link, created_at, state) VALUES(?, ?, ?, ?, ?)', roleId, 'Screen', BOOK, '2026-10-01T00:00:00.000Z', 'pending');
  const b = t.one<{ id: number }>('SELECT max(id) AS id FROM interviews')?.id;
  const before = count(t, 'interview_changes');
  assert.throws(() => t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK, starts_at: '2099-11-02T10:00:00+01:00' }), new RegExp(`${a.interview_id}, ${b}`));
  assert.equal(count(t, 'interviews', "state = 'pending'"), 2);
  assert.equal(count(t, 'interview_changes'), before);
});

test('an interview id from another role is refused and that role keeps its interview', (ctx) => {
  const t = fresh(ctx);
  const mine = applied(t, 'Acme', 'Engineer');
  const other = applied(t, 'Zenith', 'Designer');
  const theirs = t.addInterview({ role_id: other, stage: 'Screen', link: BOOK });
  assert.throws(() => t.addInterview({ role_id: mine, interview_id: theirs.interview_id, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00' }), new RegExp(`Interview ${theirs.interview_id} belongs to role ${other}, not role ${mine}`));
  assert.throws(() => t.addInterview({ role_id: mine, interview_id: 999, stage: 'Screen' }), /No interview 999/);
  // The same calendar event cannot move to another role either.
  t.addInterview({ role_id: other, ...EVENT });
  assert.throws(() => t.addInterview({ role_id: mine, ...EVENT, occurred_at: '2026-10-09T09:00:00Z' }), new RegExp(`already recorded for role ${other}, not role ${mine}`));
  assert.equal(count(t, 'interviews'), 2);
  assert.equal(count(t, 'interviews', "state = 'pending' AND role_id = ?", other), 1);
  assert.equal(count(t, 'interview_changes'), 2);
});

test('an interview is found through a linked duplicate, and a new one lands on the canonical role', (ctx) => {
  const t = fresh(ctx);
  const canonical = applied(t, 'Acme', 'Engineer');
  const { role: dup } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/dup' });
  t.linkDuplicateRole({ canonical_role_id: canonical, duplicate_role_id: dup.id, reason: 'Same posting', evidence: 'Both cards link to the same ATS page' });
  // A pending booking that predates the link sits on the duplicate row.
  t.run('INSERT INTO interviews(role_id, stage, link, created_at, state) VALUES(?, ?, ?, ?, ?)', dup.id, 'Screen', BOOK, '2026-10-01T00:00:00.000Z', 'pending');
  const old = t.one<{ id: number }>('SELECT id FROM interviews')?.id;
  const byLink = t.addInterview({ role_id: canonical, stage: 'Screen', link: BOOK, starts_at: '2099-11-02T10:00:00+01:00' });
  assert.equal(byLink.interview_id, old);
  assert.equal(count(t, 'interviews'), 1);
  assert.equal(t.openItems().interviews_to_book.length, 0);
  // The duplicate's id acts on the canonical role, for ids and for new rows.
  const viaAlias = t.addInterview({ role_id: dup.id, interview_id: old, stage: 'Screen', people: 'Dana Ruiz' });
  assert.equal(viaAlias.interview_id, old);
  const fresh_ = t.addInterview({ role_id: dup.id, stage: 'Technical', link: 'https://calendar.example.test/book/tech' });
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM interviews WHERE id = ?', fresh_.interview_id)?.role_id, canonical);
  assert.equal(t.roleDetail({ role_id: dup.id }).interviews.length, 2);
});

test('an invalid zone, date or state writes nothing', async (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const pending = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  const attempt = (extra: Record<string, unknown>) => () => t.addInterview({ role_id: roleId, interview_id: pending.interview_id, stage: 'Screen', ...extra });
  assert.throws(attempt({ starts_at: '2099-11-02T10:00', tz: 'Mars/Base' }), /Unknown timezone "Mars\/Base"/);
  assert.throws(attempt({ starts_at: '2099-02-30T10:00', tz: 'Europe/Berlin' }), /no such date or time/);
  assert.throws(attempt({ starts_at: 'soon' }), /Cannot parse/);
  assert.throws(attempt({ state: 'scheduled' }), /scheduled interview needs starts_at/);
  assert.throws(attempt({ state: 'pending', starts_at: '2099-11-02T10:00:00+01:00' }), /pending interview has no time/);
  assert.throws(attempt({ state: 'booked' }), /state must be pending \| scheduled \| cancelled/);
  assert.throws(() => t.addInterview({ role_id: roleId, ...EVENT, occurred_at: '2026-10-01T09:00:00' }), /explicit offset/);
  assert.throws(() => t.addInterview({ role_id: roleId, stage: 'Screen', source: 'google_calendar', source_id: 'x' }), /come together/);
  assert.throws(() => t.addInterview({ role_id: roleId, stage: 'Screen', run_id: 999 }), /No run 999/);
  assert.equal(count(t, 'interviews'), 1);
  assert.equal(count(t, 'interview_changes'), 1);
  // The same through the tool: the schema accepts the new fields and the handler rejects the bad value.
  const r = await call(t)('add_interview', { role_id: roleId, interview_id: pending.interview_id, stage: 'Screen', starts_at: '2099-11-02T10:00', tz: 'Mars/Base' });
  assert.match(r.error, /Unknown timezone/);
  const ok = await call(t)('add_interview', { role_id: roleId, interview_id: pending.interview_id, stage: 'Screen', starts_at: '2099-11-02T10:00', tz: 'Europe/Berlin', state: 'scheduled' });
  assert.equal(ok.error, '');
  assert.deepEqual(ok.data, { interview_id: pending.interview_id, created: false, updated: true, stale: false, state: 'scheduled' });
  assert.equal(t.one<{ starts_at: string }>('SELECT starts_at FROM interviews')?.starts_at, '2099-11-02T09:00:00.000Z');
});

test('the same event id in different calendars or accounts is a different interview', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const a = t.addInterview({ role_id: roleId, ...EVENT });
  const otherAccount = t.addInterview({ role_id: roleId, ...EVENT, source_account: 'work@example.test' });
  const otherSource = t.addInterview({ role_id: roleId, ...EVENT, source: 'outlook' });
  assert.equal(new Set([a.interview_id, otherAccount.interview_id, otherSource.interview_id]).size, 3);
  assert.equal(count(t, 'interviews'), 3);
  assert.throws(() => t.run("INSERT INTO interviews(role_id, stage, created_at, source, source_account, source_id) VALUES(?, 'x', 'now', 'google_calendar', 'me@example.test', 'evt-1')", roleId), /UNIQUE/);
});

test('a scheduled interview moves an applied role on, but never a closed or dropped one, and a cancelled one never', (ctx) => {
  const t = fresh(ctx);
  const live = applied(t, 'Acme', 'Engineer');
  t.addInterview({ role_id: live, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00' });
  assert.equal(t.mustRole(live).status, 'interviewing');
  assert.equal(count(t, 'events', "role_id = ? AND status = 'interviewing'", live), 1);

  const queued = t.upsertRole({ company: 'Beta', title: 'Engineer' }).role.id;
  t.insertEvent({ role_id: queued, status: 'queued', actor: 'pipeline', reason: 'Setup', ts: '2026-09-01T00:00:00.000Z' });
  t.addInterview({ role_id: queued, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00' });
  assert.equal(t.mustRole(queued).status, 'queued', 'the status machine does not allow queued to interviewing');

  const rejected = applied(t, 'Gamma', 'Engineer');
  t.insertEvent({ role_id: rejected, status: 'closed', outcome: 'rejected', actor: 'employer', reason: 'No', evidence: 'Not moving forward', ts: '2026-09-10T00:00:00.000Z' });
  t.addInterview({ role_id: rejected, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00' });
  t.addInterview({ role_id: rejected, stage: 'Tech', link: BOOK });
  assert.equal(t.mustRole(rejected).status, 'closed');
  assert.deepEqual(t.openItems().interviews_to_book, [], 'a closed role has no booking to make');
  assert.equal(t.openItems().upcoming_interviews.filter((i) => i.company === 'Gamma').length, 0);

  const cancelled = applied(t, 'Delta', 'Engineer');
  t.addInterview({ role_id: cancelled, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00', state: 'cancelled' });
  assert.equal(t.mustRole(cancelled).status, 'applied');
});

test('an older invite cannot reopen a role a later rejection closed', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  t.insertEvent({ role_id: roleId, status: 'closed', outcome: 'rejected', actor: 'employer', reason: 'No', evidence: 'Not moving forward', ts: '2026-10-20T00:00:00.000Z' });
  t.addInterview({ role_id: roleId, ...EVENT });
  assert.equal(t.mustRole(roleId).status, 'closed');
  assert.equal(count(t, 'events', "role_id = ? AND status = 'interviewing'", roleId), 0);
});

test('giving a time to a cancelled interview needs an explicit state', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const gone = t.addInterview({ role_id: roleId, stage: 'Screen', starts_at: '2099-11-02T10:00:00+01:00', state: 'cancelled' });
  assert.throws(() => t.addInterview({ role_id: roleId, interview_id: gone.interview_id, stage: 'Screen', starts_at: '2099-11-04T10:00:00+01:00' }), /cancelled.*state: "scheduled"/);
  assert.equal(t.one<{ state: string }>('SELECT state FROM interviews')?.state, 'cancelled');
  const back = t.addInterview({ role_id: roleId, interview_id: gone.interview_id, stage: 'Screen', starts_at: '2099-11-04T10:00:00+01:00', state: 'scheduled' });
  assert.equal(back.state, 'scheduled');
  assert.equal(t.openItems().upcoming_interviews.length, 1);
});

test('a pending interview from one calendar event is not taken over by another event with the same link', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const a = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK, source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-A', occurred_at: '2026-10-01T09:00:00Z' });
  const b = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK, starts_at: '2099-11-02T10:00:00+01:00', source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-B', occurred_at: '2026-10-02T09:00:00Z' });
  assert.notEqual(a.interview_id, b.interview_id);
  assert.equal(count(t, 'interviews'), 2);
  assert.equal(t.openItems().interviews_to_book.length, 1);
});

test('a local edit does not move the external order, so an earlier cancellation that arrives later still applies', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  // The user adds an interviewer by hand, now, after the calendar event was read.
  const local = t.addInterview({ role_id: roleId, interview_id: first.interview_id, stage: 'Technical', people: 'Dana Ruiz' });
  assert.equal(local.updated, true);
  assert.equal(t.one<{ last_occurred_at: string }>('SELECT last_occurred_at FROM interviews')?.last_occurred_at, '2026-10-01T09:00:00.000Z');
  // The calendar cancelled it on 4 Nov, but the sweep only reads that after the local edit.
  const cancelled = t.addInterview({ role_id: roleId, ...EVENT, state: 'cancelled', occurred_at: '2026-11-04T08:00:00Z' });
  assert.deepEqual(cancelled, { interview_id: first.interview_id, created: false, updated: true, stale: false, state: 'cancelled' });
  assert.equal(t.openItems().upcoming_interviews.length, 0);
  // The newer event wins for the fields it carries; the local edit stays in the history and on the row.
  assert.equal(t.one<{ people: string }>('SELECT people FROM interviews')?.people, 'Dana Ruiz');
  const history = t.q<{ before_json: string | null; after_json: string }>('SELECT before_json, after_json FROM interview_changes ORDER BY id');
  assert.equal(history.length, 3);
  assert.equal(JSON.parse(history[1]?.after_json ?? '{}').people, 'Dana Ruiz');
  assert.equal(JSON.parse(history[2]?.before_json ?? '{}').people, 'Dana Ruiz');
  // An update older than the last external one is still ignored.
  assert.equal(t.addInterview({ role_id: roleId, ...EVENT, occurred_at: '2026-10-15T08:00:00Z' }).stale, true);
});

test('a newer external update wins for the fields it carries over a local edit of them', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  t.addInterview({ role_id: roleId, interview_id: first.interview_id, stage: 'Technical', starts_at: '2099-11-08T10:00:00+01:00' });
  const moved = t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-06T09:30:00+01:00', occurred_at: '2026-10-03T08:00:00Z' });
  assert.equal(moved.updated, true);
  assert.equal(t.one<{ starts_at: string }>('SELECT starts_at FROM interviews')?.starts_at, '2099-11-06T08:30:00.000Z');
  const history = t.q<{ after_json: string }>('SELECT after_json FROM interview_changes ORDER BY id');
  assert.equal(JSON.parse(history[1]?.after_json ?? '{}').starts_at, '2099-11-08T09:00:00.000Z');
  assert.equal(history.length, 3);
});

test('a change note and the interviewing event keep the real receipt time and the join key of their interview', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const started = new Date().toISOString();
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-06T09:30:00+01:00', occurred_at: '2026-10-03T08:00:00Z' });
  const local = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  const rows = t.q<{ ts: string; received_at: string; category: string | null; status: string | null; evidence: string | null }>('SELECT ts, received_at, category, status, evidence FROM events WHERE ts >= ? OR received_at >= ? ORDER BY id', '2026-10-01T00:00:00.000Z', started);
  const written = rows.filter((e) => e.category === 'interview_changed' || e.status === 'interviewing');
  assert.equal(written.length, 4, 'two notes, the interviewing move, and the note of the local row');
  for (const e of written) assert.ok(e.received_at >= started, `received_at ${e.received_at} is when the tracker heard of it, not ${e.ts}`);
  assert.deepEqual(written.filter((e) => e.category === 'interview_changed').map((e) => [e.ts.slice(0, 10), e.evidence]), [
    ['2026-10-01', `interview:${first.interview_id} google_calendar/me@example.test/evt-1`],
    ['2026-10-03', `interview:${first.interview_id} google_calendar/me@example.test/evt-1`],
    [written[3]?.ts.slice(0, 10) ?? '', `interview:${local.interview_id}`],
  ]);
  assert.equal(written.find((e) => e.status === 'interviewing')?.ts, '2026-10-01T09:00:00.000Z', 'dated by the occurrence');
});

test('replaying an identical calendar event after a local edit is a no-op, and a changed one at the same time is still refused', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const first = t.addInterview({ role_id: roleId, ...EVENT });
  t.addInterview({ role_id: roleId, interview_id: first.interview_id, stage: 'Technical', people: 'Dana Ruiz', link: 'https://meet.example.test/moved' });
  const edited = snapshot(t, first.interview_id);
  const changes = count(t, 'interview_changes');
  const replay = t.addInterview({ role_id: roleId, ...EVENT });
  assert.deepEqual(replay, { interview_id: first.interview_id, created: false, updated: false, stale: false, state: 'scheduled' });
  assert.deepEqual(snapshot(t, first.interview_id), edited, 'the local edit is not undone');
  assert.equal(count(t, 'interview_changes'), changes);
  assert.throws(() => t.addInterview({ role_id: roleId, ...EVENT, starts_at: '2099-11-06T09:30:00+01:00' }), /different starts_at/);
  assert.throws(() => t.addInterview({ role_id: roleId, ...EVENT, people: 'Someone Else' }), /different people/);
  assert.deepEqual(snapshot(t, first.interview_id), edited);
});

test('adopting a calendar key on a pending row is recorded in the history', (ctx) => {
  const t = fresh(ctx);
  const roleId = applied(t);
  const pending = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK });
  const adopted = t.addInterview({ role_id: roleId, stage: 'Screen', link: BOOK, source: 'google_calendar', source_account: 'me@example.test', source_id: 'evt-7', occurred_at: '2026-10-02T08:00:00Z' });
  assert.deepEqual(adopted, { interview_id: pending.interview_id, created: false, updated: false, stale: false, state: 'pending' });
  const history = t.q<{ occurred_at: string; before_json: string; after_json: string }>('SELECT occurred_at, before_json, after_json FROM interview_changes WHERE before_json IS NOT NULL');
  assert.equal(history.length, 1);
  assert.equal(history[0]?.occurred_at, '2026-10-02T08:00:00.000Z');
  assert.equal(JSON.parse(history[0]?.before_json ?? '{}').source_id, null);
  assert.equal(JSON.parse(history[0]?.after_json ?? '{}').source_id, 'evt-7');
  assert.equal(snapshot(t, pending.interview_id).source_id, 'evt-7');
});
