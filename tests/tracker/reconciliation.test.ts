// External evidence: events recorded from a mailbox or board are idempotent and ordered by when they happened.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
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
  const { event_id } = t.record({ ...ACK, role_id: roleId, occurred_at: '2026-10-01T11:00:00+02:00' });
  const ev = t.one<{ ts: string; received_at: string; source: string; source_account: string; source_id: string }>('SELECT * FROM events WHERE id = ?', event_id);
  assert.equal(ev?.ts, '2026-10-01T09:00:00.000Z');
  assert.ok(ev && ev.received_at > '2026-11-01', `received_at is the time of the call, got ${ev?.received_at}`);
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
  // History left on the duplicate by an older release, after the link; the canonical row never saw it.
  t.run("INSERT INTO events(role_id, ts, status, outcome, actor, reason, evidence) VALUES(?, '2026-10-25T00:00:00Z', 'closed', 'rejected', 'import', 'Legacy rejection', 'No')", duplicate);
  const ack = t.record({ ...ACK, role_id: duplicate });
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
