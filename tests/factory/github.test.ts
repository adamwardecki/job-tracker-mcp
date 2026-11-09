import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Gh, pullSnapshot } from '../../factory/github.ts';

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
