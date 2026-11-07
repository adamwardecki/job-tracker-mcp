import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

test('historical inbound evidence, duplicate linking and replay preserve one truthful application history', async (ctx) => {
  ctx.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T11:58:00Z') });
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  const t = new Tracker(db);
  const handle = makeHandler(t);
  let id = 0;
  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) as RpcResponse;
    const result = response.result as { isError?: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> & { role?: { id: number; status: string } } };
    assert.notEqual(result.isError, true, `${name}: ${result.content[0].text}`);
    assert.ok(result.structuredContent, `${name} returns structured content`);
    return result.structuredContent;
  }

  const receipt = {
    actor: 'user', status: 'applied', reason: 'Application acknowledgement found in mail',
    evidence: 'Your application for Example Labs Engineer, requisition 42, was received.',
    source: 'gmail', source_account: 'jobs@example.test', source_id: 'receipt-42', occurred_at: '2026-11-01T09:00:00Z',
  };
  // The existing copy was reconciled in an earlier run, so this run reports only its newly received evidence.
  const prior = await call('start_run', { kind: 'triage', capabilities: { connectors: { gmail: true } } });
  const copy = await call('upsert_role', { company: 'Example Labs', title: 'Engineer copy', url: 'https://careers.example.test/req-42', source: 'inbound' });
  const duplicate = copy.role?.id;
  assert.ok(duplicate);
  await call('record', { ...receipt, role_id: duplicate, source_id: 'prior-board-receipt-42', source: 'board', run_id: prior.run_id });
  await call('finish_run', { run_id: prior.run_id, summary: 'Reconciled an existing application card.' });

  ctx.mock.timers.setTime(Date.parse('2026-11-06T12:00:00Z'));
  const current = await call('start_run', { kind: 'triage', capabilities: { connectors: { gmail: true } } });
  const found = await call('upsert_role', { company: 'Example Labs', title: 'Engineer', url: 'https://jobs.ashbyhq.com/example-labs/42', source: 'inbound' });
  const role_id = found.role?.id;
  assert.ok(role_id);
  assert.notEqual(role_id, duplicate);
  const discovery = t.roleDetail({ role_id }).events[0];
  assert.ok(discovery);
  assert.equal(discovery.status, 'found');
  assert.equal(discovery.ts, '2026-11-06T12:00:00.000Z');
  const firstSeen = t.mustRole(role_id).first_seen;
  assert.equal(firstSeen, '2026-11-06T12:00:00.000Z');
  const copyDiscovery = t.roleDetail({ role_id: duplicate }).events.find((event) => event.status === 'found');
  assert.ok(copyDiscovery);

  const input = { ...receipt, role_id, run_id: current.run_id };
  const applied = await call('record', input);
  assert.equal(applied.status_applied, true);
  assert.equal(applied.duplicate, false);
  assert.equal(applied.role?.status, 'applied');
  assert.equal(applied.conflict, undefined);
  const receiptEvent = t.roleDetail({ role_id }).events.find((event) => event.id === applied.event_id);
  assert.ok(receiptEvent);
  assert.equal(receiptEvent.ts, '2026-11-01T09:00:00.000Z');
  assert.equal(receiptEvent.received_at, '2026-11-06T12:00:00.000Z');
  assert.equal(receiptEvent.source_id, 'receipt-42');
  assert.equal(t.mustRole(role_id).first_seen, firstSeen);
  assert.deepEqual(t.roleDetail({ role_id }).events.find((event) => event.id === discovery.id), discovery);

  const linked = await call('link_duplicate_role', {
    canonical_role_id: role_id, duplicate_role_id: duplicate, reason: 'Same requisition listed twice',
    evidence: 'https://careers.example.test/req-42 links to https://jobs.ashbyhq.com/example-labs/42; both name requisition 42.',
  });
  assert.deepEqual(linked.linked_role_ids, [duplicate]);
  const summary = t.pipelineSummary();
  assert.equal(summary.awaiting_reply, 1);
  assert.equal(summary.counts.applied, 1);
  assert.equal((await call('find_company', { name: 'Example Labs' })).live_application, true);
  assert.deepEqual(t.roleDetail({ role_id }).events.find((event) => event.id === copyDiscovery.id), copyDiscovery);

  const other = await call('upsert_role', { company: 'Example Labs', title: 'Designer', url: 'https://jobs.ashbyhq.com/example-labs/43', source: 'ashby' });
  assert.ok(other.role?.id);
  await call('transition', { role_id: other.role.id, to: 'verified', reason: 'Checked employer posting', evidence: 'https://jobs.ashbyhq.com/example-labs/43: "Remote (Europe)"', location_line: 'Remote (Europe)', location_type: 'remote' });
  const gate = await call('gate_check', { role_id: other.role.id });
  assert.equal(gate.live_elsewhere, true);
  assert.equal(gate.ok, false);
  assert.match(JSON.stringify(gate.problems), /Live application at this company already: Engineer \(applied\)/);

  ctx.mock.timers.setTime(Date.parse('2026-11-06T12:02:00Z'));
  const rejected = await call('record', {
    role_id: duplicate, actor: 'employer', status: 'closed', outcome: 'rejected', reason: 'Rejection found in mail',
    evidence: 'We will not be moving forward with your application for requisition 42.',
    source: 'gmail', source_account: 'jobs@example.test', source_id: 'rejection-42', occurred_at: '2026-11-03T09:00:00Z', run_id: current.run_id,
  });
  assert.equal(rejected.status_applied, true);
  assert.equal(rejected.conflict, undefined);
  assert.equal(rejected.role?.status, 'closed');
  const rejectionEvent = t.roleDetail({ role_id }).events.find((event) => event.id === rejected.event_id);
  assert.ok(rejectionEvent);
  assert.equal(rejectionEvent.outcome, 'rejected');
  assert.equal(rejectionEvent.ts, '2026-11-03T09:00:00.000Z');
  assert.equal(rejectionEvent.received_at, '2026-11-06T12:02:00.000Z');
  const beforeReplay = t.roleDetail({ role_id });
  const replay = await call('record', input);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.status_applied, false);
  assert.equal(replay.event_id, applied.event_id);
  assert.equal(replay.role?.status, 'closed');
  assert.deepEqual(t.roleDetail({ role_id }), beforeReplay);
  assert.equal(t.mustRole(role_id).first_seen, firstSeen);
  assert.deepEqual(beforeReplay.events.find((event) => event.id === discovery.id), discovery);
  assert.equal(t.pipelineSummary().awaiting_reply, 0);
  assert.deepEqual(t.pipelineSummary().rejections.map((role) => role.id), [role_id]);

  const report = await call('render_report', { date: '2026-11-06', run_id: current.run_id });
  assert.equal(typeof report.markdown, 'string');
  const markdown = String(report.markdown);
  assert.match(markdown, /\*\*Example Labs\*\*, Engineer\. Recorded from gmail, applied 2026-11-01: "Your application for Example Labs Engineer, requisition 42, was received\."/);
  assert.match(markdown, /\*\*Example Labs\*\*, Engineer: closed \(rejected, 2026-11-03\)\. Rejection found in mail Feedback: "We will not be moving forward with your application for requisition 42\."/);
  assert.match(markdown, /\| Applications recorded from mail or boards \| 1 \|/);
  assert.match(markdown, /\| Applications submitted \| 0 \|/);
  assert.doesNotMatch(markdown, /Engineer copy|Recorded from board|Confirmation:/);
});
