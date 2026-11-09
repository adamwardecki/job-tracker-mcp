import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderState } from '../../factory/markers.ts';
import { stateFrom } from '../../factory/snapshot.ts';

const state = { stage: 'ci' as const, since: '2026-11-09T11:00:00.000Z', round: 0, attempts: 0, runs: [] };

test('state comes only from the router account, latest first', () => {
  const comments = [
    { id: 1, author: 'github-actions[bot]', body: renderState({ ...state, stage: 'planning' }), at: '2026-11-09T10:00:00Z' },
    { id: 2, author: 'github-actions[bot]', body: renderState(state), at: '2026-11-09T11:00:00Z' },
    { id: 3, author: 'someone', body: renderState({ ...state, stage: 'ready' }), at: '2026-11-09T11:05:00Z' },
  ];
  assert.deepEqual(stateFrom(comments), { id: 2, state });
});

test('no router comment means no state', () => {
  assert.equal(stateFrom([{ id: 3, author: 'someone', body: renderState(state), at: 'x' }]), null);
});
