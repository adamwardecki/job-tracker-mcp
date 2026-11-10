import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Gh, latestLabeler, pullSnapshot } from '../../factory/github.ts';

test('pullSnapshot lists both sides of a rename', async () => {
  const gh: Gh = {
    repo: 'o/r',
    call: async (_method, path) => {
      if (path.startsWith('/repos/o/r/pulls/51/files')) {
        return [{ filename: 'docs/gates.ts', previous_filename: 'plugin/hooks/gates.ts', status: 'renamed' }, { filename: 'docs/setup.md', status: 'modified' }];
      }
      return { head: { sha: 'abc' }, state: 'open', mergeable_state: 'clean', node_id: 'PR_1' };
    },
  };
  const snap = await pullSnapshot(gh, 51);
  assert.deepEqual(snap.files, ['docs/gates.ts', 'plugin/hooks/gates.ts', 'docs/setup.md']);
});

test('latestLabeler reads the newest labelling of that label across timeline pages', async () => {
  const labeled = (name: string, login: string, at: string) => ({ event: 'labeled', label: { name }, actor: { login }, created_at: at });
  const first = [
    labeled('agent:queued', 'someone', '2026-11-09T09:00:00Z'),
    ...Array.from({ length: 99 }, () => ({ event: 'commented', actor: { login: 'x' }, created_at: '2026-11-09T09:30:00Z' })),
  ];
  const second = [labeled('agent:queued', 'adamwardecki', '2026-11-09T10:00:00Z'), labeled('bug', 'factory-app[bot]', '2026-11-09T11:00:00Z'), { event: 'unlabeled', label: { name: 'agent:queued' }, actor: { login: 'y' }, created_at: '2026-11-09T11:30:00Z' }];
  const gh: Gh = {
    repo: 'o/r',
    call: async (_method, path) => {
      assert.match(path, /^\/repos\/o\/r\/issues\/7\/timeline\?/);
      return path.endsWith('page=1') ? first : second;
    },
  };
  assert.deepEqual(await latestLabeler(gh, 7, 'agent:queued'), { login: 'adamwardecki', at: '2026-11-09T10:00:00Z' });
  assert.equal(await latestLabeler(gh, 7, 'agent:ready'), null);
});
