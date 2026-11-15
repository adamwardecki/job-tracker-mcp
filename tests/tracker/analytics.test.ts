// Anonymous usage analytics: nothing leaves the machine until the user opts in, a revoke stops it at once (in
// every process on the database), and events carry only enum-like values. No test touches the network: every
// Analytics here gets a recording send.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Analytics } from '../../plugin/servers/tracker/src/analytics.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

type Sent = { url: string; body: { api_key: string; event: string; distinct_id: string; properties: Record<string, unknown> } };

let dir: string;
let sent: Sent[];
const recorder = () => {
  sent = [];
  return new Analytics({ version: '9.9.9', env: {}, send: async (url, body) => void sent.push({ url, body: JSON.parse(body) }) });
};
const tracker = (analytics: Analytics | null = recorder()) => new Tracker(openDb(join(dir, 'tracker.db')), { dbPath: join(dir, 'tracker.db'), analytics });
const capabilities = { connectors: { gmail: true, calendar: true, linkedin: false }, browser: null, local_folder: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-analytics-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('nothing is sent before the user opts in', () => {
  const t = tracker();
  t.startRun({ kind: 'sweep', capabilities });
  t.upsertRole({ company: 'Acme Robotics', title: 'Staff Engineer', url: 'https://jobs.ashbyhq.com/acme/1' });
  assert.equal(t.usageAnalytics(), null);
  assert.deepEqual(sent, []);
});

test('declining records the decision and sends nothing', () => {
  const t = tracker();
  const r = t.setUsageAnalytics({ allow: false });
  assert.equal(r.allowed, false);
  t.startRun({ kind: 'sweep', capabilities });
  assert.deepEqual(sent, []);
  const saved = t.usageAnalytics();
  assert.equal(saved?.allowed, false);
  assert.equal(saved?.install_id, undefined);
  assert.ok(saved?.decided_at);
});

test('after opt-in, events go to PostHog under a random install id with no person profile and no geo lookup', () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  const id = t.usageAnalytics()?.install_id;
  assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  t.startRun({ kind: 'sweep', capabilities });
  assert.deepEqual(sent.map((s) => s.body.event), ['usage_analytics_enabled', 'run_started']);
  const run = sent[1]!; // two events were just asserted
  assert.match(run.url, /\/i\/v0\/e\/$/);
  assert.match(run.body.api_key, /^phc_/);
  assert.equal(run.body.distinct_id, id);
  assert.equal(run.body.properties.$process_person_profile, false);
  assert.equal(run.body.properties.$geoip_disable, true);
  assert.equal(run.body.properties.run_kind, 'sweep');
  assert.equal(run.body.properties.plugin_version, '9.9.9');
});

test('revoking stops events and forgets the install id; opting in again gets a new one', () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  const first = t.usageAnalytics()?.install_id;
  t.setUsageAnalytics({ allow: false });
  sent.length = 0;
  t.startRun({ kind: 'sweep', capabilities });
  assert.deepEqual(sent, []);
  assert.equal(t.usageAnalytics()?.install_id, undefined);
  t.setUsageAnalytics({ allow: true });
  assert.notEqual(t.usageAnalytics()?.install_id, first);
});

test('a revoke in one process stops another process on the same database at once', () => {
  const server = tracker(null);
  const board = tracker();
  server.setUsageAnalytics({ allow: true });
  board.upsertRole({ company: 'Acme Robotics', title: 'Staff Engineer' });
  assert.equal(sent.length, 1);
  server.setUsageAnalytics({ allow: false });
  board.addRule({ text: 'Skip agencies', reason: 'User asked' });
  assert.equal(sent.length, 1);
});

test('events carry no names, URLs or free text', () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  t.startRun({ kind: 'Acme weekly sweep for Jane', capabilities });
  const { role } = t.upsertRole({ company: 'Acme Robotics', title: 'Staff Engineer', url: 'https://jobs.ashbyhq.com/acme/1', source: 'jane@example.com' });
  t.addArtifact({ role_id: role.id, kind: 'cover_note', content: 'Dear Acme' });
  t.addRule({ text: 'Skip Acme', reason: 'Jane said so', added_by: 'Jane Doe' });
  const text = JSON.stringify(sent.map((s) => s.body));
  for (const secret of ['Acme', 'acme', 'Jane', 'jane', 'Staff', 'ashbyhq', 'Dear']) assert.ok(!text.includes(secret), secret);
  assert.equal(sent.find((s) => s.body.event === 'run_started')?.body.properties.run_kind, 'other');
});

test('DO_NOT_TRACK and JOB_TRACKER_ANALYTICS=off stop sending even after opt-in', () => {
  for (const env of [{ DO_NOT_TRACK: '1' }, { JOB_TRACKER_ANALYTICS: 'off' }]) {
    const out: string[] = [];
    const analytics = new Analytics({ version: '1', env, send: async (_url, body) => void out.push(body) });
    analytics.capture('3f1c1a8e-0000-4000-8000-000000000000', 'run_started');
    assert.deepEqual(out, [], JSON.stringify(env));
  }
});

test('a failing send never breaks the tracker call', async () => {
  const analytics = new Analytics({ version: '1', env: {}, send: () => Promise.reject(new Error('offline')) });
  const t = tracker(analytics);
  t.setUsageAnalytics({ allow: true });
  assert.ok(t.startRun({ kind: 'sweep', capabilities }).run_id);
  await analytics.flush(100);
  const throwing = new Analytics({ version: '1', env: {}, send: () => { throw new Error('boom'); } });
  const t2 = tracker(throwing);
  assert.ok(t2.startRun({ kind: 'sweep', capabilities }).run_id);
});

test('setup steps are tracked with enum values only', () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  t.setupStatus();
  t.saveConfig({ section: 'prefs', data: { titles: ['Staff Engineer at Acme'] } });
  t.saveDocument({ name: 'profile', content: 'Jane Doe, Acme Robotics' });
  t.recordDecision({ key: 'browser', decision: 'Jane has no browser' });
  t.recordDecision({ key: 'Acme thing', decision: 'x' });
  const events = sent.map((s) => s.body);
  assert.deepEqual(events.map((e) => e.event), ['usage_analytics_enabled', 'setup_status_checked', 'config_saved', 'document_saved', 'setup_decision_recorded', 'setup_decision_recorded']);
  const status = events[1]!.properties; // listed above
  assert.equal(status.state_usage_analytics, 'green');
  assert.equal(status.state_filters, 'red');
  assert.equal(typeof status.green_count, 'number');
  assert.equal(events[2]!.properties.section, 'prefs');
  assert.equal(events[3]!.properties.document, 'profile');
  assert.equal(events[4]!.properties.item, 'browser');
  assert.equal(events[5]!.properties.item, 'other');
  const text = JSON.stringify(events);
  for (const secret of ['Acme', 'Jane', 'Staff']) assert.ok(!text.includes(secret), secret);
});

test('every setup_status item key is sent by name when a decision is recorded', () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  for (const { key } of t.setupStatus().items) t.recordDecision({ key, decision: 'accepted' });
  const items = sent.filter((s) => s.body.event === 'setup_decision_recorded').map((s) => s.body.properties.item);
  assert.ok(items.length > 10);
  assert.ok(!items.includes('other'), 'a new setup_status item needs adding to SETUP_ITEMS in tracker.ts');
});

test('setup_status lists the analytics choice first: amber until asked, green either way after', () => {
  const t = tracker(null);
  assert.equal(t.setupStatus().items[0]?.key, 'usage_analytics');
  const item = () => t.setupStatus().items.find((i) => i.key === 'usage_analytics');
  assert.equal(item()?.state, 'amber');
  t.setUsageAnalytics({ allow: false });
  assert.equal(item()?.state, 'green');
  assert.match(item()?.detail ?? '', /off/);
  t.setUsageAnalytics({ allow: true });
  assert.match(item()?.detail ?? '', /on/);
});

test('set_usage_analytics is a tool that needs allow', async () => {
  const handle = makeHandler(tracker(null));
  const call = async (args: Record<string, unknown>) => (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_usage_analytics', arguments: args } })) as RpcResponse;
  const missing = await call({});
  assert.equal((missing.result as { isError?: boolean }).isError, true);
  const ok = await call({ allow: true });
  assert.notEqual((ok.result as { isError?: boolean }).isError, true);
});
