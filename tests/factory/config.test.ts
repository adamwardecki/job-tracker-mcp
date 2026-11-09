import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchFor, issueForBranch, runTitle, stageLabel } from '../../factory/config.ts';

test('branch names round-trip to issue numbers', () => {
  assert.equal(branchFor(12), 'factory/issue-12');
  assert.equal(issueForBranch('factory/issue-12'), 12);
});

test('branches outside the factory map to no issue', () => {
  assert.equal(issueForBranch('adamwardecki/feature'), null);
  assert.equal(issueForBranch('factory/issue-12-extra'), null);
});

test('labels and run titles use the documented formats', () => {
  assert.equal(stageLabel('in-review'), 'agent:in-review');
  assert.equal(runTitle('build', 7), 'factory-build #7');
});
