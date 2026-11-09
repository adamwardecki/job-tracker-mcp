import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEvent } from '../../factory/events.ts';

function build(name: string, payload: unknown, issue = 7) {
  const parsed = parseEvent(name, payload);
  assert.ok(parsed && parsed !== 'sweep', `expected an event for ${name}`);
  return { target: parsed.target, event: parsed.build(issue) };
}

test('schedule and manual runs sweep', () => {
  assert.equal(parseEvent('schedule', {}), 'sweep');
  assert.equal(parseEvent('workflow_dispatch', {}), 'sweep');
});

test('adding agent:queued queues the issue', () => {
  const { target, event } = build('issues', { action: 'labeled', label: { name: 'agent:queued' }, issue: { number: 7 }, sender: { login: 'adamwardecki' } });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, { kind: 'queued', issue: 7, actor: 'adamwardecki' });
  assert.equal(parseEvent('issues', { action: 'labeled', label: { name: 'bug' }, issue: { number: 7 } }), null);
});

test('slash commands on issues and PRs', () => {
  const onIssue = build('issue_comment', { action: 'created', issue: { number: 7 }, comment: { body: '/approve', user: { login: 'adamwardecki' } } });
  assert.deepEqual(onIssue.target, { issue: 7 });
  assert.deepEqual(onIssue.event, { kind: 'command', issue: 7, command: 'approve', actor: 'adamwardecki' });
  const onPr = build('issue_comment', { action: 'created', issue: { number: 51, pull_request: {} }, comment: { body: '/stop', user: { login: 'adamwardecki' } } });
  assert.deepEqual(onPr.target, { pr: 51 });
  assert.equal(parseEvent('issue_comment', { action: 'created', issue: { number: 7 }, comment: { body: 'nice' } }), null);
});

test('a changes-requested review on a factory branch', () => {
  const { target, event } = build('pull_request_review', {
    action: 'submitted',
    review: { state: 'changes_requested', user: { login: 'adamwardecki' } },
    pull_request: { head: { ref: 'factory/issue-7' } },
  });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, { kind: 'changes-requested', issue: 7, actor: 'adamwardecki' });
  assert.equal(parseEvent('pull_request_review', { action: 'submitted', review: { state: 'approved' }, pull_request: { head: { ref: 'factory/issue-7' } } }), null);
  assert.equal(parseEvent('pull_request_review', { action: 'submitted', review: { state: 'changes_requested' }, pull_request: { head: { ref: 'main' } } }), null);
});

test('a closed factory PR', () => {
  const { event } = build('pull_request_target', { action: 'closed', pull_request: { head: { ref: 'factory/issue-7' } } });
  assert.deepEqual(event, { kind: 'pr-closed', issue: 7 });
});

test('a finished CI run on a factory branch', () => {
  const { target, event } = build('workflow_run', {
    action: 'completed',
    workflow_run: { name: 'CI', head_branch: 'factory/issue-7', head_sha: 'sha-1', html_url: 'https://example.test/r/1', conclusion: 'failure', status: 'completed', updated_at: '2026-11-09T11:30:00Z' },
  });
  assert.deepEqual(target, { issue: 7 });
  assert.deepEqual(event, {
    kind: 'run-finished',
    issue: 7,
    run: { workflow: 'ci', conclusion: 'failure', headSha: 'sha-1', url: 'https://example.test/r/1', completedAt: '2026-11-09T11:30:00Z' },
  });
});

test('a finished stage run is matched by its run-name', () => {
  const { target, event } = build('workflow_run', {
    action: 'completed',
    workflow_run: { name: 'factory-review', display_title: 'factory-review #12', head_sha: 'main-sha', html_url: 'https://example.test/r/2', conclusion: 'success', status: 'completed', updated_at: '2026-11-09T11:40:00Z' },
  }, 12);
  assert.deepEqual(target, { issue: 12 });
  assert.equal(event.kind === 'run-finished' && event.run.workflow, 'review');
  assert.equal(parseEvent('workflow_run', { action: 'completed', workflow_run: { name: 'Pages', display_title: 'x' } }), null);
});
