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
