import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Stage } from '../../factory/config.ts';
import {
  type Action,
  type Ctx,
  decideEvent,
  type IssueSnapshot,
  next,
  type PullSnapshot,
  type RunSnapshot,
  sweep,
} from '../../factory/decide.ts';
import type { FactoryState } from '../../factory/markers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const SINCE = '2026-11-09T11:00:00.000Z';
const ctx: Ctx = { now: NOW, risky: ['plugin/hooks/**', 'factory/**'] };

function st(stage: Stage, extra: Partial<FactoryState> = {}): FactoryState {
  return { stage, since: SINCE, round: 0, attempts: 0, runs: [], ...extra };
}
function snap(state: FactoryState | null, extra: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { number: 7, state, labels: [], brief: null, pr: null, review: null, lastCommand: null, lastRun: null, ...extra };
}
function pr(extra: Partial<PullSnapshot> = {}): PullSnapshot {
  return { number: 51, headSha: 'sha-1', open: true, conflicting: false, files: ['plugin/servers/tracker/src/report.ts'], ...extra };
}
function run(workflow: RunSnapshot['workflow'], conclusion: string | null = 'success', extra: Partial<RunSnapshot> = {}): RunSnapshot {
  return { workflow, conclusion, headSha: 'sha-1', url: `https://example.test/runs/${workflow}-${conclusion}`, completedAt: '2026-11-09T11:30:00Z', ...extra };
}
const saves = (a: Action[]) => a.flatMap((x) => (x.kind === 'save' ? [x.state] : []));
const stages = (a: Action[]) => saves(a).map((s) => s.stage);
const dispatches = (a: Action[]) => a.flatMap((x) => (x.kind === 'dispatch' ? [x.workflow] : []));
const comments = (a: Action[]) => a.flatMap((x) => (x.kind === 'comment' ? [x.body] : []));
const finished = (s: IssueSnapshot, r: RunSnapshot) => decideEvent({ kind: 'run-finished', issue: 7, run: r }, s, ctx);

test('the maintainer queues an issue', () => {
  const a = decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(null), ctx);
  assert.deepEqual(stages(a), ['queued']);
  assert.equal(saves(a)[0]?.since, NOW.toISOString());
  assert.deepEqual(dispatches(a), []);
});

test('nobody else can queue, and an issue in progress is not requeued', () => {
  assert.deepEqual(decideEvent({ kind: 'queued', issue: 7, actor: 'someone' }, snap(null), ctx), []);
  assert.deepEqual(decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(st('building')), ctx), []);
});

test('a blocked issue can be queued again from scratch', () => {
  const a = decideEvent({ kind: 'queued', issue: 7, actor: 'adamwardecki' }, snap(st('blocked', { round: 3 })), ctx);
  assert.equal(saves(a)[0]?.round, 0);
});

test('next starts the oldest queued issue when the factory is idle', () => {
  const older = { ...snap(st('queued', { since: '2026-11-09T09:00:00Z' })), number: 3 };
  const newer = { ...snap(st('queued', { since: '2026-11-09T10:00:00Z' })), number: 4 };
  const waiting = { ...snap(st('ready')), number: 5 };
  const a = next([newer, older, waiting], ctx);
  assert.deepEqual(stages(a), ['planning']);
  assert.deepEqual(dispatches(a), ['plan']);
  assert.ok(a.some((x) => x.kind === 'save' && x.issue === 3));
  assert.ok(a.some((x) => x.kind === 'unlabel' && x.labels.includes('ready-for-agent')));
});

test('next does nothing while another issue is active', () => {
  const busy = { ...snap(st('in-review')), number: 2 };
  const queued = { ...snap(st('queued')), number: 3 };
  assert.deepEqual(next([busy, queued], ctx), []);
});

test('a closed PR finishes the issue', () => {
  assert.deepEqual(stages(decideEvent({ kind: 'pr-closed', issue: 7 }, snap(st('ready')), ctx)), ['done']);
  assert.deepEqual(decideEvent({ kind: 'pr-closed', issue: 7 }, snap(st('done')), ctx), []);
});

const BRIEF = { id: 900, touches: ['plugin/servers/tracker/src/report.ts'], at: '2026-11-09T11:20:00Z' };

test('a plan with a brief on safe paths goes straight to building', () => {
  const a = finished(snap(st('planning'), { brief: BRIEF, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['building']);
  assert.equal(saves(a)[0]?.brief, 900);
  assert.deepEqual(dispatches(a), ['build']);
  assert.deepEqual(saves(a)[0]?.runs, ['https://example.test/runs/plan-success']);
});

test('a plan touching risky paths waits for approval and lists them', () => {
  const risky = { ...BRIEF, touches: ['plugin/hooks/gates.ts', 'docs/setup.md'] };
  const a = finished(snap(st('planning'), { brief: risky, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'plan');
  assert.deepEqual(dispatches(a), []);
  assert.match(comments(a)[0] ?? '', /`plugin\/hooks\/gates.ts`/);
  assert.doesNotMatch(comments(a)[0] ?? '', /docs\/setup.md/);
});

test('a plan with an empty Touches list waits for approval', () => {
  const a = finished(snap(st('planning'), { brief: { ...BRIEF, touches: [] }, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
});

test('a planner that needs a human blocks the issue', () => {
  const a = finished(snap(st('planning'), { labels: ['needs-info'] }), run('plan'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFrom, 'planning');
  assert.match(comments(a)[0] ?? '', /\/retry/);
});

test('a plan without a fresh brief is a failed attempt, and the second one blocks', () => {
  const stale = { ...BRIEF, at: '2026-11-09T10:00:00Z' };
  const first = finished(snap(st('planning'), { brief: stale, labels: ['ready-for-agent'] }), run('plan'));
  assert.deepEqual(stages(first), ['planning']);
  assert.equal(saves(first)[0]?.attempts, 1);
  assert.equal(saves(first)[0]?.failedAt, NOW.toISOString());
  assert.deepEqual(dispatches(first), []);
  const second = finished(snap(st('planning', { attempts: 1 })), run('plan', 'success', { url: 'https://example.test/runs/2' }));
  assert.deepEqual(stages(second), ['blocked']);
});

test('a failed stage run counts as a failed attempt', () => {
  const a = finished(snap(st('building')), run('build', 'failure'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('runs for another stage, still going, cancelled, already seen or older than the stage are ignored', () => {
  const s = snap(st('building'), { pr: pr() });
  assert.deepEqual(finished(s, run('plan')), []);
  assert.deepEqual(finished(s, run('build', 'success', { completedAt: null })), []);
  assert.deepEqual(finished(s, run('build', 'cancelled')), []);
  assert.deepEqual(finished(s, run('build', 'success', { completedAt: '2026-11-09T10:00:00Z' })), []);
  const seen = snap(st('building', { runs: ['https://example.test/runs/build-success'] }), { pr: pr() });
  assert.deepEqual(finished(seen, run('build')), []);
});

test('a build that opened a PR waits for CI', () => {
  const a = finished(snap(st('building'), { pr: pr() }), run('build'));
  assert.deepEqual(stages(a), ['ci']);
  assert.equal(saves(a)[0]?.pr, 51);
  assert.deepEqual(dispatches(a), []);
});

test('a build without an open PR is a failed attempt', () => {
  const a = finished(snap(st('building'), { pr: pr({ open: false }) }), run('build'));
  assert.equal(saves(a)[0]?.attempts, 1);
});

test('green CI on the PR head goes to review; CI on an older head is ignored', () => {
  const s = snap(st('ci', { pr: 51 }), { pr: pr() });
  assert.deepEqual(stages(finished(s, run('ci'))), ['in-review']);
  assert.deepEqual(dispatches(finished(s, run('ci'))), ['review']);
  assert.deepEqual(finished(s, run('ci', 'success', { headSha: 'old' })), []);
});

test('red CI goes to the fixer and counts a round', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 1 }), { pr: pr() }), run('ci', 'failure'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 2);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
  assert.equal(saves(a)[0]?.headSha, 'sha-1');
  assert.deepEqual(dispatches(a), ['fix']);
});

test('red CI after the last round blocks', () => {
  const a = finished(snap(st('ci', { pr: 51, round: 3 }), { pr: pr() }), run('ci', 'failure'));
  assert.deepEqual(stages(a), ['blocked']);
  assert.match(comments(a)[0] ?? '', /3 fix rounds/);
});

test('a review with blocking findings goes to the fixer', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 2, at: '2026-11-09T11:20:00Z' } });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'review');
  assert.equal(saves(a)[0]?.round, 1);
});

test('a clean review on safe files marks the PR ready', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 0, at: '2026-11-09T11:20:00Z' } });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('a clean review on a risky diff waits for approval', () => {
  const s = snap(st('in-review', { pr: 51 }), {
    pr: pr({ files: ['plugin/hooks/gates.ts'] }),
    review: { blocking: 0, at: '2026-11-09T11:20:00Z' },
  });
  const a = finished(s, run('review'));
  assert.deepEqual(stages(a), ['awaiting-approval']);
  assert.equal(saves(a)[0]?.approvalFor, 'diff');
  assert.ok(!a.some((x) => x.kind === 'pr-ready'));
});

test('a review run without a fresh factory review is a failed attempt', () => {
  const s = snap(st('in-review', { pr: 51 }), { pr: pr(), review: { blocking: 0, at: '2026-11-09T10:00:00Z' } });
  assert.equal(saves(finished(s, run('review')))[0]?.attempts, 1);
});

test('a fix that pushed goes back to CI; one that pushed nothing is a failed attempt', () => {
  const pushed = finished(snap(st('fixing', { pr: 51, headSha: 'sha-0' }), { pr: pr() }), run('fix'));
  assert.deepEqual(stages(pushed), ['ci']);
  const idle = finished(snap(st('fixing', { pr: 51, headSha: 'sha-1' }), { pr: pr() }), run('fix'));
  assert.equal(saves(idle)[0]?.attempts, 1);
});

const cmd = (s: IssueSnapshot, command: 'approve' | 'stop' | 'retry', actor = 'adamwardecki') =>
  decideEvent({ kind: 'command', issue: 7, command, actor }, s, ctx);

test('/approve on a plan starts the build; only the maintainer can approve', () => {
  const s = snap(st('awaiting-approval', { approvalFor: 'plan', brief: 900 }));
  assert.deepEqual(dispatches(cmd(s, 'approve')), ['build']);
  assert.equal(saves(cmd(s, 'approve'))[0]?.approvalFor, undefined);
  assert.deepEqual(cmd(s, 'approve', 'someone'), []);
});

test('/approve on a risky diff marks the PR ready', () => {
  const a = cmd(snap(st('awaiting-approval', { approvalFor: 'diff', pr: 51 })), 'approve');
  assert.deepEqual(stages(a), ['ready']);
  assert.ok(a.some((x) => x.kind === 'pr-ready' && x.pr === 51));
});

test('/approve outside awaiting-approval does nothing', () => {
  assert.deepEqual(cmd(snap(st('building')), 'approve'), []);
});

test('/stop blocks an issue in any live stage', () => {
  const a = cmd(snap(st('fixing')), 'stop');
  assert.deepEqual(stages(a), ['blocked']);
  assert.equal(saves(a)[0]?.blockedFrom, 'fixing');
  assert.deepEqual(cmd(snap(st('done')), 'stop'), []);
});

test('/retry resumes the blocked stage with a fresh round count', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'planning', round: 3 })), 'retry');
  assert.deepEqual(stages(a), ['planning']);
  assert.equal(saves(a)[0]?.round, 0);
  assert.deepEqual(dispatches(a), ['plan']);
});

test('/retry at CI goes to the fixer', () => {
  const a = cmd(snap(st('blocked', { blockedFrom: 'ci', pr: 51 }), { pr: pr() }), 'retry');
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'ci');
});

test('the maintainer requesting changes on a ready PR starts an uncounted fix round', () => {
  const s = snap(st('ready', { pr: 51, round: 3 }), { pr: pr() });
  const a = decideEvent({ kind: 'changes-requested', issue: 7, actor: 'adamwardecki' }, s, ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.round, 3);
  assert.equal(saves(a)[0]?.fixReason, 'maintainer');
  assert.deepEqual(decideEvent({ kind: 'changes-requested', issue: 7, actor: 'someone' }, s, ctx), []);
});

test('the sweep retries a failed stage after an hour and keeps the attempt count', () => {
  const early = snap(st('building', { attempts: 1, failedAt: '2026-11-09T11:30:00Z' }));
  assert.deepEqual(sweep([early], ctx), []);
  const late = snap(st('building', { attempts: 1, failedAt: '2026-11-09T10:30:00Z' }));
  const a = sweep([late], ctx);
  assert.deepEqual(dispatches(a), ['build']);
  assert.equal(saves(a)[0]?.attempts, 1);
  assert.equal(saves(a)[0]?.failedAt, undefined);
});

test('the sweep processes a finished run whose event was missed', () => {
  const s = snap(st('building'), { pr: pr(), lastRun: run('build') });
  assert.deepEqual(stages(sweep([s], ctx)), ['ci']);
});

test('the sweep blocks a stage with no progress for 90 minutes', () => {
  const s = snap(st('in-review', { since: '2026-11-09T10:00:00Z' }), { lastRun: run('review', null, { completedAt: null }) });
  const a = sweep([s], ctx);
  assert.deepEqual(stages(a), ['blocked']);
  assert.match(comments(a)[0] ?? '', /90 minutes/);
});

test('the sweep processes a missed /approve', () => {
  const s = snap(st('awaiting-approval', { approvalFor: 'plan' }), { lastCommand: { command: 'approve', at: '2026-11-09T11:10:00Z' } });
  assert.deepEqual(dispatches(sweep([s], ctx)), ['build']);
  const old = snap(st('awaiting-approval', { approvalFor: 'plan' }), { lastCommand: { command: 'approve', at: '2026-11-09T10:10:00Z' } });
  assert.deepEqual(sweep([old], ctx), []);
});

test('the sweep picks up an agent:queued label whose event was missed, then starts it', () => {
  const a = sweep([snap(null, { labels: ['agent:queued'] })], ctx);
  assert.deepEqual(stages(a), ['queued', 'planning']);
  assert.deepEqual(dispatches(a), ['plan']);
});

test('the sweep sends a conflicting ready PR back to rebase before starting new work', () => {
  const ready = { ...snap(st('ready', { pr: 51 }), { pr: pr({ conflicting: true }) }), number: 3 };
  const queued = { ...snap(st('queued')), number: 4 };
  const a = sweep([ready, queued], ctx);
  assert.deepEqual(stages(a), ['fixing']);
  assert.equal(saves(a)[0]?.fixReason, 'rebase');
});
