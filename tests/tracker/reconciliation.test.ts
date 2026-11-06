// External evidence: events recorded from a mailbox or board are idempotent and ordered by when they happened.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { externalIdentity, requireSameFields } from '../../plugin/servers/tracker/src/external.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { renderReport } from '../../plugin/servers/tracker/src/report.ts';
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
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> & { role?: { id: number; status: string } } };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

const ONE = 'https://jobs.ashbyhq.com/acme/one';

// A role as the sweep left it: queued on 2026-09-01. Setup events carry explicit times so that the external
// occurrences below sit after or before them on purpose, whatever the clock says today.
function queued(t: Tracker, { title = 'Engineer', url = ONE as string | null, at = '2026-09-01T00:00:00Z' } = {}): number {
  const { role } = t.upsertRole({ company: 'Acme', title, ...(url ? { url } : {}) });
  t.run("UPDATE events SET ts = '2026-01-01T00:00:00.000Z' WHERE role_id = ?", role.id); // the found event upsertRole wrote
  t.insertEvent({ role_id: role.id, status: 'queued', actor: 'pipeline', reason: 'Setup', ts: at });
  return role.id;
}

const ACK = { actor: 'user', status: 'applied', reason: 'External acknowledgement', evidence: 'Your application for Acme Engineer was received.', source: 'gmail', source_account: 'jobs@example.test', source_id: 'message-1', occurred_at: '2026-10-01T09:00:00Z' };
const REJECTION = { actor: 'employer', status: 'closed', outcome: 'rejected', reason: 'Rejection email', evidence: 'We will not be moving forward.', source: 'gmail', source_account: 'jobs@example.test', source_id: 'message-2', occurred_at: '2026-10-20T09:00:00Z' };

const count = (t: Tracker, where = '1 = 1', ...params: (string | number)[]) => t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ${where}`, ...params)?.n ?? 0;
const status = (t: Tracker, id: number) => t.roleDetail({ role_id: id }).role.status;

test('a historical receipt establishes a newly discovered application without backdating discovery', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T12:00:00Z') });
  const t = fresh(ctx);
  const rpc = call(t);
  const discovered = await rpc('upsert_role', { company: 'Example Labs', title: 'Engineer', source: 'inbound', url: 'https://jobs.ashbyhq.com/example/one' });
  assert.equal(discovered.error, '');
  const id = discovered.data?.role?.id;
  assert.ok(id);
  const discovery = t.roleDetail({ role_id: id }).events[0];
  assert.ok(discovery);
  const firstSeen = t.mustRole(id).first_seen;
  const result = await rpc('record', { ...ACK, role_id: id, occurred_at: '2026-11-06T11:00:00Z' });
  assert.equal(result.error, '');
  assert.equal(result.data?.status_applied, true);
  assert.equal(result.data?.role?.status, 'applied');
  assert.equal(result.data?.conflict, undefined);
  assert.equal(t.pipelineSummary().awaiting_reply, 1);
  assert.equal(t.findCompany({ name: 'Example Labs' }).live_application, true);
  const events = t.roleDetail({ role_id: id }).events;
  assert.deepEqual(events.map((e) => e.status), ['applied', 'found']);
  assert.deepEqual(events.find((e) => e.id === discovery.id), discovery);
  assert.equal(t.mustRole(id).first_seen, firstSeen);
  const other = t.upsertRole({ company: 'Example Labs', title: 'Designer', url: 'https://jobs.ashbyhq.com/example/two' }).role.id;
  t.transition({ role_id: other, to: 'verified', reason: 'Employer posting', evidence: 'https://jobs.ashbyhq.com/example/two Remote', location_line: 'Remote', location_type: 'remote' });
  const gate = t.gateCheck({ role_id: other });
  assert.equal(gate.live_elsewhere, true);
  assert.equal(gate.ok, false);
});

test('replaying an acknowledgement adds one event', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const input = { ...ACK, role_id: roleId };
  const first = t.record(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.status_applied, true);
  assert.equal(first.role?.status, 'applied');
  // A stored updated_at the retry could only change by writing the role.
  t.run("UPDATE roles SET updated_at = '2026-10-02T00:00:00.000Z' WHERE id = ?", roleId);
  const events = count(t);

  const second = t.record(input);
  assert.equal(second.event_id, first.event_id);
  assert.equal(second.duplicate, true);
  assert.equal(second.status_applied, false);
  assert.equal(second.role?.updated_at, '2026-10-02T00:00:00.000Z');
  assert.equal(t.q('SELECT id FROM events WHERE source_id = ?', 'message-1').length, 1);
  assert.equal(count(t), events, 'no extra status event');
});

test('replaying through the MCP tool returns the original event', async (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const rpc = call(t);
  const first = await rpc('record', { ...ACK, role_id: roleId });
  const second = await rpc('record', { ...ACK, role_id: roleId });
  assert.deepEqual([first.error, second.error], ['', '']);
  assert.equal(first.data?.duplicate, false);
  assert.equal(second.data?.duplicate, true);
  assert.equal(second.data?.event_id, first.data?.event_id);
  assert.equal(second.data?.status_applied, false);
  assert.equal(count(t, 'source_id = ?', 'message-1'), 1);
});

test('the event time is the normalized occurrence, and receipt time is kept apart', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const before = new Date().toISOString();
  const { event_id } = t.record({ ...ACK, role_id: roleId, occurred_at: '2026-10-01T11:00:00+02:00' });
  const after = new Date().toISOString();
  const ev = t.one<{ ts: string; received_at: string; source: string; source_account: string; source_id: string }>('SELECT * FROM events WHERE id = ?', event_id);
  assert.equal(ev?.ts, '2026-10-01T09:00:00.000Z');
  assert.ok(ev && ev.received_at >= before && ev.received_at <= after, `received_at is the time of the call (${before} to ${after}), got ${ev?.received_at}`);
  assert.deepEqual([ev.source, ev.source_account, ev.source_id], ['gmail', 'jobs@example.test', 'message-1']);
  // The same instant written in another offset is the same occurrence.
  const again = t.record({ ...ACK, role_id: roleId, occurred_at: '2026-10-01T09:00:00Z' });
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, event_id);
});

test('an older acknowledgement is recorded but does not reopen a rejection', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const rejected = t.record({ ...REJECTION, role_id: roleId });
  assert.equal(rejected.status_applied, true);
  assert.equal(status(t, roleId), 'closed');

  const ack = t.record({ ...ACK, role_id: roleId, actor: 'pipeline' });
  assert.equal(ack.duplicate, false);
  assert.equal(ack.status_applied, false);
  assert.equal(ack.conflict, undefined, 'an older event is ordinary history, not a conflict');
  assert.equal(status(t, roleId), 'closed');
  assert.deepEqual(t.roleDetail({ role_id: roleId }).events.filter((e) => e.source).map((e) => [e.ts, e.status, e.outcome]), [
    ['2026-10-01T09:00:00.000Z', 'applied', null],
    ['2026-10-20T09:00:00.000Z', 'closed', 'rejected'],
  ]);
});

test('an imported acknowledgement is not a submission by the plugin', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  t.record({ ...ACK, role_id: roleId, actor: 'pipeline' });
  const report = renderReport(t, { date: '2026-10-01' }).markdown;
  assert.match(report, /\| Applications submitted \| 0 \|/);
  assert.doesNotMatch(report, /Confirmation: "Your application/);
});

test('an older acknowledgement still counts as a previous application at the gate', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t, { at: '2026-10-15T00:00:00Z' });
  const ack = t.record({ ...ACK, role_id: roleId });
  assert.equal(ack.status_applied, false);
  assert.equal(status(t, roleId), 'queued');
  const gate = t.gateCheck({ role_id: roleId });
  assert.equal(gate.previous_application, true);
  assert.equal(gate.matched_role_id, roleId);
});

test('a rejection that sits on a linked duplicate still wins over an older acknowledgement', (ctx) => {
  const t = fresh(ctx);
  const canonical = queued(t);
  const duplicate = queued(t, { title: 'Engineer (LinkedIn)', url: null, at: '2026-08-01T00:00:00Z' });
  for (const id of [canonical, duplicate]) t.insertEvent({ role_id: id, status: 'applied', actor: 'user', reason: 'Applied', evidence: 'Sent', ts: '2026-10-05T00:00:00Z' });
  t.linkDuplicateRole({ canonical_role_id: canonical, duplicate_role_id: duplicate, reason: 'Same posting', evidence: `Both link to ${ONE}` });
  // History left on the duplicate by an older release, after the link; the canonical row never saw it. Its rejection is
  // the only status event later than the acknowledgement below, which is itself later than the canonical row's own.
  t.run("INSERT INTO events(role_id, ts, status, outcome, actor, reason, evidence) VALUES(?, '2026-10-25T00:00:00Z', 'closed', 'rejected', 'import', 'Legacy rejection', 'No')", duplicate);
  const ack = t.record({ ...ACK, role_id: duplicate, occurred_at: '2026-10-10T09:00:00Z' });
  assert.equal(ack.status_applied, false);
  assert.equal(ack.role?.id, canonical);
  assert.equal(status(t, canonical), 'applied', 'the card was not moved by an older event');
  assert.equal(t.q<{ role_id: number }>('SELECT role_id FROM events WHERE source_id = ?', 'message-1')[0]?.role_id, canonical);
});

test('equal-time conflicting outcomes keep the current status and return a conflict', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  t.record({ ...REJECTION, role_id: roleId });
  const second = t.record({ ...ACK, role_id: roleId, source_id: 'message-3', occurred_at: REJECTION.occurred_at });
  assert.equal(second.duplicate, false);
  assert.equal(second.status_applied, false);
  assert.match(String(second.conflict), /same time/i);
  assert.equal(status(t, roleId), 'closed');
  assert.equal(count(t, 'source_id = ?', 'message-3'), 1, 'the evidence is still recorded');
});

test('a newer event the status machine does not allow is recorded without moving the status', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const invite = t.record({ ...ACK, role_id: roleId, status: 'interviewing', source_id: 'message-4', evidence: 'Invitation to interview', occurred_at: '2026-10-02T09:00:00Z' });
  assert.equal(invite.status_applied, false);
  assert.match(String(invite.conflict), /queued .* interviewing/);
  assert.equal(status(t, roleId), 'queued');
  assert.equal(count(t, 'source_id = ?', 'message-4'), 1);

  const closed = queued(t, { title: 'Designer', url: null });
  t.record({ ...REJECTION, role_id: closed, source_id: 'message-5' });
  const later = t.record({ ...ACK, role_id: closed, status: 'interviewing', source_id: 'message-6', occurred_at: '2026-10-30T09:00:00Z' });
  assert.equal(later.status_applied, false);
  assert.ok(later.conflict);
  assert.equal(status(t, closed), 'closed', 'a rejection is never reopened automatically');
});

test('the same source id in two accounts is two occurrences', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const first = t.record({ ...ACK, role_id: roleId, source_account: 'jobs@example.test' });
  const other = t.record({ ...ACK, role_id: roleId, source_account: 'other@example.test', evidence: 'Another mailbox, another message.' });
  assert.equal(other.duplicate, false);
  assert.notEqual(other.event_id, first.event_id);
  assert.equal(count(t, 'source_id = ?', 'message-1'), 2);
});

test('external metadata must come as a complete group', async (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const rpc = call(t);
  const before = count(t);
  for (const missing of ['source', 'source_account', 'source_id', 'occurred_at']) {
    const input: Record<string, unknown> = { ...ACK, role_id: roleId };
    delete input[missing];
    const res = await rpc('record', input);
    assert.match(res.error, /source, source_account, source_id and occurred_at/, `without ${missing}`);
  }
  for (const key of ['source', 'source_account', 'source_id']) {
    const res = await rpc('record', { ...ACK, role_id: roleId, [key]: '  ' });
    assert.match(res.error, new RegExp(`${key} must not be empty`), key);
  }
  assert.equal(count(t), before, 'nothing was written');
  assert.equal(status(t, roleId), 'queued');
});

test('an occurrence time needs an explicit offset and a real date', async (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const rpc = call(t);
  const before = count(t);
  for (const bad of ['2026-10-01T09:00:00', '2026-10-01', '2026-02-30T09:00:00Z', 'yesterday', '2026-10-01T25:00:00Z', '2026-10-01T09:00:00+25:00']) {
    const res = await rpc('record', { ...ACK, role_id: roleId, occurred_at: bad });
    assert.match(res.error, /occurred_at (must|is not)/, bad);
  }
  assert.equal(count(t), before);
});

test('a retry through an alias role id is the same occurrence', (ctx) => {
  const t = fresh(ctx);
  const canonical = queued(t);
  const duplicate = queued(t, { title: 'Engineer (LinkedIn)', url: null, at: '2026-08-01T00:00:00Z' });
  t.linkDuplicateRole({ canonical_role_id: canonical, duplicate_role_id: duplicate, reason: 'Same posting', evidence: `Both link to ${ONE}` });
  const first = t.record({ ...ACK, role_id: duplicate });
  const again = t.record({ ...ACK, role_id: canonical });
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, first.event_id);
  assert.equal(count(t, 'source_id = ?', 'message-1'), 1);
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM events WHERE id = ?', first.event_id)?.role_id, canonical);
});

test('the same source key under a different role is refused', (ctx) => {
  const t = fresh(ctx);
  const one = queued(t);
  const two = queued(t, { title: 'Designer', url: null });
  t.record({ ...ACK, role_id: one });
  const before = count(t);
  assert.throws(() => t.record({ ...ACK, role_id: two }), /already recorded for role \d+, not role \d+/);
  assert.equal(count(t), before);
  assert.equal(status(t, two), 'queued');
});

test('a repeated id with changed evidence is a conflict, not a silent discard', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  t.record({ ...ACK, role_id: roleId });
  const before = count(t);
  assert.throws(() => t.record({ ...ACK, role_id: roleId, evidence: 'Unfortunately we are not proceeding.' }), /gmail id message-1 was already recorded with different evidence/);
  assert.throws(() => t.record({ ...ACK, role_id: roleId, status: 'closed', outcome: 'rejected' }), /different status/);
  assert.throws(() => t.record({ ...ACK, role_id: roleId, occurred_at: '2026-10-02T09:00:00Z' }), /different occurred_at/);
  assert.equal(count(t), before);
});

test('a retry that differs only in run and reason returns the original event', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const first = t.record({ ...ACK, role_id: roleId, run_id: 7 });
  const again = t.record({ ...ACK, role_id: roleId, run_id: 9, reason: 'Seen again in the next sweep' });
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, first.event_id);
  assert.equal(t.one<{ run_id: number }>('SELECT run_id FROM events WHERE id = ?', first.event_id)?.run_id, 7);
});

test('external events keep the evidence rules of record', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  assert.throws(() => t.record({ ...ACK, role_id: roleId, evidence: '' }), /applied needs evidence/);
  assert.throws(() => t.record({ ...REJECTION, role_id: roleId, status: 'dropped', evidence: '' }), /drop needs evidence/);
  assert.equal(count(t, 'source IS NOT NULL'), 0);
});

test('a record without metadata behaves as it did', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const input = { role_id: roleId, actor: 'user', status: 'applied', reason: 'Applied by hand', evidence: 'Sent' };
  const first = t.record(input);
  const second = t.record(input);
  assert.notEqual(second.event_id, first.event_id, 'without an external id every call is an event');
  assert.equal(second.duplicate, false);
  assert.equal(first.status_applied, true);
  assert.equal(t.record({ role_id: roleId, actor: 'user', reason: 'Note only' }).status_applied, false);
  const ev = t.one<{ ts: string; received_at: string; source: string | null }>('SELECT * FROM events WHERE id = ?', first.event_id);
  assert.equal(ev?.received_at, ev?.ts);
  assert.equal(ev?.source, null);
  // Not older than the queue, but out of order for the machine: a plain record still projects any status.
  assert.equal(t.record({ role_id: roleId, actor: 'employer', status: 'closed', outcome: 'rejected', reason: 'Rejected' }).role?.status, 'closed');
});

test('two connections replaying one message record it once', { timeout: 30_000 }, async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-recon-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tracker.db');
  const db = openDb(path);
  const t = new Tracker(db);
  const roleId = queued(t);
  db.close();
  const src = (f: string) => new URL(`../../plugin/servers/tracker/src/${f}`, import.meta.url).href;
  const script = `
    import { openDb } from ${JSON.stringify(src('db.ts'))};
    import { Tracker } from ${JSON.stringify(src('tracker.ts'))};
    const db = openDb(${JSON.stringify(path)});
    const r = new Tracker(db).record(${JSON.stringify({ ...ACK, role_id: roleId })});
    process.stdout.write(JSON.stringify({ event_id: r.event_id, duplicate: r.duplicate }));
    db.close();
  `;
  const run = () => new Promise<{ event_id: number; duplicate: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
  });
  const results = await Promise.all([run(), run(), run()]);
  assert.equal(new Set(results.map((r) => r.event_id)).size, 1);
  assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true, true]);
  const check = openDb(path);
  try {
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM events WHERE source_id = ?').get('message-1')?.n, 1);
  } finally {
    check.close();
  }
});

test('an occurrence more than a day in the future is refused', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T12:00:00Z') });
  const t = fresh(ctx);
  const roleId = queued(t);
  const before = count(t);
  // A little ahead is clock skew between the mailbox and this machine; a year ahead would pin the role against every later event.
  assert.equal(t.record({ ...ACK, role_id: roleId, occurred_at: '2026-11-05T11:59:00Z' }).duplicate, false);
  assert.equal(t.record({ ...ACK, role_id: roleId, source_id: 'edge', occurred_at: '2026-11-05T12:00:00Z' }).duplicate, false, 'exactly 24 hours ahead is allowed');
  for (const future of ['2026-11-05T12:00:00.001Z', '2026-11-05T12:01:00Z', '2027-10-01T09:00:00Z', '2026-11-05T16:00:00+02:00']) {
    const res = await call(t)('record', { ...ACK, role_id: roleId, source_id: `future-${future}`, occurred_at: future });
    assert.match(res.error, /occurred_at is in the future/, future);
  }
  assert.equal(count(t), before + 2, 'only the two within a day were written');
});

test('source names are one key whatever their case or padding, accounts and ids are not', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const first = t.record({ ...ACK, role_id: roleId, source: ' Gmail ' });
  assert.equal(t.one<{ source: string }>('SELECT source FROM events WHERE id = ?', first.event_id)?.source, 'gmail');
  const again = t.record({ ...ACK, role_id: roleId, source: 'GMAIL' });
  assert.equal(again.duplicate, true);
  assert.equal(again.event_id, first.event_id);
  const other = t.record({ ...ACK, role_id: roleId, source_account: 'Jobs@Example.test', evidence: 'Another account.' });
  assert.equal(other.duplicate, false, 'source_account keeps its case');
  const id = t.record({ ...ACK, role_id: roleId, source_id: 'Message-1', evidence: 'Another id.' });
  assert.equal(id.duplicate, false, 'source_id keeps its case');
});

test('a retry that changes any compared field is a conflict naming it', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  t.record({ ...ACK, role_id: roleId });
  const before = count(t);
  const changes: Record<string, unknown> = { actor: 'employer', status: 'interviewing', outcome: 'withdrawn', category: 'agency', question: 'Which visa?', blocked_by: 'user', evidence: 'Different text.', occurred_at: '2026-10-01T09:00:01Z' };
  for (const [field, value] of Object.entries(changes)) {
    assert.throws(() => t.record({ ...ACK, role_id: roleId, [field]: value }), new RegExp(`already recorded with different [a-z_, ]*${field}`), field);
  }
  assert.equal(count(t), before);
});

test('a second acknowledgement of the same status', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  t.record({ ...ACK, role_id: roleId });
  // Newer and the same status: the machine allows staying put, so it is applied without a conflict.
  const newer = t.record({ ...ACK, role_id: roleId, source_id: 'message-5', occurred_at: '2026-10-05T09:00:00Z' });
  assert.equal(newer.status_applied, true);
  assert.equal(newer.conflict, undefined);
  // At the same instant as the status it repeats, nothing is left to decide: kept as evidence, no conflict, role untouched.
  t.run("UPDATE roles SET updated_at = '2026-10-06T00:00:00.000Z' WHERE id = ?", roleId);
  const same = t.record({ ...ACK, role_id: roleId, source_id: 'message-6', occurred_at: '2026-10-05T09:00:00Z' });
  assert.equal(same.duplicate, false);
  assert.equal(same.status_applied, false);
  assert.equal(same.conflict, undefined);
  assert.equal(same.role?.updated_at, '2026-10-06T00:00:00.000Z');
  assert.equal(count(t, 'source_id = ?', 'message-6'), 1);
});

test('a retry through a role that was linked as a duplicate afterwards is the same occurrence', (ctx) => {
  const t = fresh(ctx);
  const canonical = queued(t);
  const duplicate = queued(t, { title: 'Engineer (LinkedIn)', url: null, at: '2026-08-01T00:00:00Z' });
  const first = t.record({ ...ACK, role_id: duplicate });
  t.insertEvent({ role_id: canonical, status: 'applied', actor: 'user', reason: 'Applied', evidence: 'Sent', ts: '2026-10-05T00:00:00Z' });
  t.linkDuplicateRole({ canonical_role_id: canonical, duplicate_role_id: duplicate, reason: 'Same posting', evidence: `Both link to ${ONE}` });
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM events WHERE id = ?', first.event_id)?.role_id, duplicate, 'the event was written before the link');
  for (const id of [duplicate, canonical]) {
    const again = t.record({ ...ACK, role_id: id });
    assert.equal(again.duplicate, true, `retry through ${id}`);
    assert.equal(again.event_id, first.event_id);
  }
  assert.equal(count(t, 'source_id = ?', 'message-1'), 1);
});

test('the shared checks name the caller\'s own field names', () => {
  const names = { source: 'cal_source', account: 'calendar', id: 'event_id', at: 'starts' };
  assert.equal(externalIdentity({}, names), null);
  assert.deepEqual(externalIdentity({ cal_source: ' Google ', calendar: 'Me@Example.test ', event_id: 'e1', starts: '2026-10-01T11:00:00+02:00' }, names), { source: 'google', account: 'Me@Example.test', id: 'e1', ts: '2026-10-01T09:00:00.000Z' });
  assert.throws(() => externalIdentity({ cal_source: 'google' }, names), /cal_source, calendar, event_id and starts .* all four, or none/);
  assert.throws(() => externalIdentity({ cal_source: 'google', calendar: 'a', event_id: ' ', starts: '2026-10-01T09:00:00Z' }, names), /event_id must not be empty/);
  assert.throws(() => externalIdentity({ cal_source: 'google', calendar: 'a', event_id: 'e', starts: '2026-10-01T09:00' }, names), /starts must be/);
  assert.throws(() => requireSameFields('google id e1', { a: 'x', b: null, c: 1 }, { a: 'y', c: 2 }, ['a', 'b', 'c'], { c: 'count' }), /google id e1 was already recorded with different a, count\./);
  requireSameFields('google id e1', { a: 'x', b: null }, { a: 'x' }, ['a', 'b']); // null and absent are the same
});

test('null external fields count as not given', async (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const rpc = call(t);
  const none = { source: null, source_account: null, source_id: null, occurred_at: null };
  const plain = await rpc('record', { role_id: roleId, actor: 'user', reason: 'Note', ...none });
  assert.equal(plain.error, '');
  assert.equal(count(t, 'source IS NOT NULL'), 0);
  const partial = await rpc('record', { role_id: roleId, actor: 'user', reason: 'Note', ...none, source: 'gmail' });
  assert.match(partial.error, /come together/);
});

test('of two status events at the same time the later row speaks for the role', (ctx) => {
  const t = fresh(ctx);
  const roleId = queued(t);
  const at = '2026-10-10T09:00:00.000Z';
  t.run("INSERT INTO events(role_id, ts, status, outcome, actor, reason, evidence) VALUES(?, ?, 'closed', 'rejected', 'import', 'Rejected', 'No')", roleId, at);
  t.run("INSERT INTO events(role_id, ts, status, actor, reason, evidence) VALUES(?, ?, 'applied', 'import', 'Applied', 'Sent')", roleId, at);
  const ack = t.record({ ...ACK, role_id: roleId, occurred_at: at });
  assert.equal(ack.conflict, undefined, 'it repeats the status of the later row');
  assert.equal(ack.status_applied, false);
});

for (const order of ['receipt first', 'rejection first'] as const) {
  test(`historical receipt and newer rejection before discovery: ${order}`, (ctx) => {
    const t = fresh(ctx);
    const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
    const inputs = order === 'receipt first' ? [ACK, REJECTION] : [REJECTION, ACK];
    for (const input of inputs) {
      const result = t.record({ ...input, role_id: id });
      assert.equal(result.status_applied, input === REJECTION || order === 'receipt first');
      assert.equal(result.conflict, undefined);
    }
    assert.equal(status(t, id), 'closed');
    assert.equal(count(t, 'role_id = ?', id), 3);
  });
}

for (const outcome of ['rejected', 'withdrawn', 'role_closed']) {
  test(`a clear historical ${outcome} establishes a newly discovered closed role`, (ctx) => {
    const t = fresh(ctx);
    const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
    const result = t.record({ ...REJECTION, role_id: id, outcome });
    assert.equal(result.status_applied, true);
    assert.equal(result.conflict, undefined);
    assert.equal(status(t, id), 'closed');
    assert.equal(count(t, 'role_id = ?', id), 2);
  });
}

test('equal-time contradictory historical evidence does not replace a bootstrapped receipt', (ctx) => {
  const t = fresh(ctx);
  const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
  assert.equal(t.record({ ...ACK, role_id: id }).status_applied, true);
  const rejection = t.record({ ...REJECTION, role_id: id, occurred_at: ACK.occurred_at });
  assert.equal(rejection.status_applied, false);
  assert.match(String(rejection.conflict), /same time/);
  assert.equal(status(t, id), 'applied');
  assert.equal(count(t, 'role_id = ?', id), 3);
});

for (const decision of ['queued', 'dropped', 'closed']) {
  test(`a later user ${decision} decision survives an older receipt`, (ctx) => {
    const t = fresh(ctx);
    const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
    assert.equal(t.record({ ...ACK, role_id: id }).status_applied, true);
    t.record({ role_id: id, status: decision, actor: 'user', reason: 'User decision', evidence: 'User decided', ...(decision === 'closed' ? { outcome: 'withdrawn' } : {}) });
    const result = t.record({ ...ACK, role_id: id, source_id: 'older-receipt', occurred_at: '2026-10-02T09:00:00Z' });
    assert.equal(result.status_applied, false);
    assert.equal(result.conflict, undefined);
    assert.equal(status(t, id), decision);
    assert.equal(count(t, 'role_id = ?', id), 4);
  });
}

for (const [label, actor, statusValue] of [['second found', 'pipeline', 'found'], ['import status', 'import', 'applied'], ['earlier local decision', 'user', 'found']] as const) {
  test(`a found card with a ${label} cannot bootstrap past a substantive local decision`, (ctx) => {
    const t = fresh(ctx);
    const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
    t.run('INSERT INTO events(role_id, ts, status, actor, reason) VALUES(?, ?, ?, ?, ?)', id, label === 'earlier local decision' ? '2026-09-01T00:00:00Z' : '2026-11-01T00:00:00Z', statusValue, actor, 'Explicit decision');
    const result = t.record({ ...ACK, role_id: id });
    assert.equal(result.status_applied, false);
    assert.match(String(result.conflict), /found|decision|reconcil/i);
    assert.equal(status(t, id), 'found');
    assert.equal(count(t, 'role_id = ?', id), 3);
  });
}

test('a substantive local decision retained on a child prevents bootstrap of its found group', (ctx) => {
  const t = fresh(ctx);
  const root = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
  const child = t.upsertRole({ company: 'Acme', title: 'Engineer copy' }).role.id;
  t.linkDuplicateRole({ canonical_role_id: root, duplicate_role_id: child, reason: 'Same posting', evidence: 'Requisition 42' });
  t.run("INSERT INTO events(role_id, ts, status, actor, reason) VALUES(?, '2026-09-01T00:00:00Z', 'found', 'user', 'User reset')", child);
  const result = t.record({ ...ACK, role_id: root });
  assert.equal(result.status_applied, false);
  assert.ok(result.conflict);
  assert.equal(status(t, root), 'found');
  assert.equal(count(t), 4);
});

test('bootstrap needs nonblank evidence and a valid closed outcome', async (ctx) => {
  const t = fresh(ctx);
  const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
  const rpc = call(t);
  assert.match((await rpc('record', { ...ACK, role_id: id, evidence: '  ' })).error, /applied needs evidence/);
  assert.match((await rpc('record', { ...REJECTION, role_id: id, outcome: 'other' })).error, /outcome/);
  const emptyClosed = t.record({ ...REJECTION, role_id: id, evidence: '  ' });
  assert.equal(emptyClosed.status_applied, false);
  assert.ok(emptyClosed.conflict);
  assert.equal(status(t, id), 'found');
  assert.equal(count(t), 2);
});

test('bookings and other external statuses cannot bootstrap an application', (ctx) => {
  const t = fresh(ctx);
  const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
  t.addInterview({ role_id: id, stage: 'screen', link: 'https://calendar.example.test/one' });
  assert.equal(status(t, id), 'found');
  for (const next of ['interviewing', 'offer', 'queued']) {
    const result = t.record({ ...ACK, role_id: id, status: next, source_id: next, occurred_at: '2026-10-02T09:00:00Z' });
    assert.equal(result.status_applied, false);
    assert.ok(result.conflict);
    assert.equal(status(t, id), 'found');
  }
  assert.throws(() => t.transition({ role_id: id, to: 'applied', reason: 'No bypass', evidence: 'Sent' }), /Illegal transition/);
});

test('retrying a legacy stranded receipt does not reproject it', (ctx) => {
  const t = fresh(ctx);
  const id = t.upsertRole({ company: 'Acme', title: 'Engineer' }).role.id;
  t.insertEvent({ ...ACK, role_id: id, ts: '2026-10-01T09:00:00.000Z' }, { projectStatus: false });
  const before = count(t);
  const result = t.record({ ...ACK, role_id: id });
  assert.equal(result.duplicate, true);
  assert.equal(result.status_applied, false);
  assert.equal(status(t, id), 'found');
  assert.equal(count(t), before);
});
