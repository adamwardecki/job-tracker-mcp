// Crash reports: a bug (any error that is not a ToolError) goes to PostHog error tracking only under the same
// opt-in as usage analytics, with personal data stripped from the message and the stack. No test touches the
// network: every Analytics here gets a recording send.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Analytics, PLUGIN_ROOT, scrubError } from '../../plugin/servers/tracker/src/analytics.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

type Body = { event: string; distinct_id: string; properties: Record<string, unknown> };
type Frame = { filename: string; function?: string; lineno?: number; colno?: number; in_app: boolean; platform: string };
type Exception = { type: string; value: string; mechanism: { handled: boolean; type: string }; stacktrace?: { type: string; frames: Frame[] } };

let dir: string;
let sent: Body[];
const tracker = () => {
  sent = [];
  const analytics = new Analytics({ version: '9.9.9', env: {}, send: async (_url, body) => void sent.push(JSON.parse(body)) });
  return new Tracker(openDb(join(dir, 'tracker.db')), { dbPath: join(dir, 'tracker.db'), analytics });
};
const exceptions = () => sent.filter((b) => b.event === '$exception');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-crash-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A stack as Node prints it, with frames in the plugin, in Node itself and elsewhere on the user's disk.
function fakeError(message: string): TypeError {
  const err = new TypeError(message);
  err.stack = [
    `TypeError: ${message}`,
    `    at Tracker.upsertRole (file://${join(PLUGIN_ROOT, 'servers/tracker/src/tracker.ts')}:812:17)`,
    `    at ${join(PLUGIN_ROOT, 'servers/tracker/src/mcp.ts')}:73:40`,
    '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    `    at run (${join(homedir(), 'Jane Doe/secret-project/run.js')}:1:1)`,
  ].join('\n');
  return err;
}

test('scrubError strips emails, URLs, paths, quoted text and long numbers from the message', () => {
  const home = homedir();
  const [ex] = scrubError(
    fakeError(`Unexpected token 'A', "Acme Robotics" is not valid JSON at ${home}/Documents/cv-jane.pdf for jane@example.com via https://jobs.ashbyhq.com/acme/123?x=1, call +48 600 123 456 or 600123456 (reading 'location_line')`),
    { handled: true },
  ).$exception_list;
  assert.ok(ex);
  assert.equal(ex.type, 'TypeError');
  for (const leak of ['Acme', 'Robotics', 'jane', 'example.com', 'ashbyhq', 'Documents', home, '600123456', '600 123 456']) assert.ok(!ex.value.includes(leak), `${leak} in ${ex.value}`);
  assert.match(ex.value, /is not valid JSON/);
  assert.match(ex.value, /'location_line'/, 'quoted code identifiers stay: they say what failed');
  assert.match(ex.value, /<email>/);
  assert.match(ex.value, /<url>/);
  assert.match(ex.value, /<path>/);
});

test('scrubError keeps plugin frames relative to the plugin, oldest first, and never sends other paths', () => {
  const [ex] = scrubError(fakeError('boom'), { handled: false }).$exception_list;
  const frames = ex?.stacktrace?.frames ?? [];
  assert.equal(ex?.stacktrace?.type, 'raw');
  assert.equal(ex?.mechanism.handled, false);
  assert.deepEqual(frames.map((f) => f.filename), ['run.js', 'node:internal/process/task_queues', 'servers/tracker/src/mcp.ts', 'servers/tracker/src/tracker.ts']);
  assert.deepEqual(frames.map((f) => f.in_app), [false, false, true, true]);
  assert.equal(frames[3]?.function, 'Tracker.upsertRole');
  assert.equal(frames[3]?.lineno, 812);
  assert.equal(frames[3]?.platform, 'node:javascript');
  assert.ok(!JSON.stringify(frames).includes('Jane'), 'a path outside the plugin keeps only its file name');
});

test('scrubError copes with things that are not Errors', () => {
  const [ex] = scrubError('Acme said no', { handled: true }).$exception_list;
  assert.equal(ex?.type, 'Error');
  assert.ok(!ex?.value.includes('Acme'));
  assert.equal(scrubError({ name: 'Evil Name With Spaces', message: 'x' }, { handled: true }).$exception_list[0]?.type, 'Error');
});

test('no crash report before opt-in or after a revoke; one after opt-in', () => {
  const t = tracker();
  t.reportCrash(fakeError('boom'), { where: 'tool' });
  assert.deepEqual(exceptions(), []);
  t.setUsageAnalytics({ allow: true });
  t.reportCrash(fakeError('boom'), { where: 'tool', tool: 'upsert_role' });
  const [report] = exceptions();
  assert.ok(report);
  assert.equal(report.distinct_id, t.usageAnalytics()?.install_id);
  assert.equal(report.properties.$exception_level, 'error');
  assert.equal(report.properties.where, 'tool');
  assert.equal(report.properties.tool, 'upsert_role');
  assert.equal(report.properties.$process_person_profile, false);
  assert.equal((report.properties.$exception_list as Exception[])[0]?.type, 'TypeError');
  t.setUsageAnalytics({ allow: false });
  t.reportCrash(fakeError('boom'), { where: 'tool' });
  assert.equal(exceptions().length, 1);
});

test('a tool that crashes is reported; a ToolError the model can fix is not', async () => {
  const t = tracker();
  t.setUsageAnalytics({ allow: true });
  const handle = makeHandler(t);
  const call = (name: string) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });
  t.getProfile = () => {
    throw new ToolError('Fix your arguments');
  };
  await call('get_profile');
  assert.deepEqual(exceptions(), []);
  t.getProfile = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'filters') for Acme Robotics");
  };
  await call('get_profile');
  const [report] = exceptions();
  assert.ok(report);
  assert.equal(report.properties.tool, 'get_profile');
  assert.equal(report.properties.where, 'tool');
  const ex = (report.properties.$exception_list as Exception[])[0];
  assert.equal(ex?.mechanism.handled, true);
  assert.match(ex?.value ?? '', /reading 'filters'/);
  assert.ok(!ex?.value.includes('Acme'), 'capitalised words after the first are names until proven otherwise');
  assert.match(ex?.value ?? '', /^Cannot read/);
});

test('a crash report never throws, even when sending fails', () => {
  const analytics = new Analytics({ version: '1', env: {}, send: () => { throw new Error('offline'); } });
  const t = new Tracker(openDb(join(dir, 'tracker.db')), { analytics });
  t.setUsageAnalytics({ allow: true });
  t.reportCrash(fakeError('boom'), { where: 'uncaught' });
  t.reportCrash(undefined, { where: 'uncaught' });
});
