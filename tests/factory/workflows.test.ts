// The workflows and the router agree on names, run titles and isolation rules. Read as text: no YAML parser.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CI_WORKFLOW_NAME, STAGE_WORKFLOWS } from '../../factory/config.ts';
import { parseGlobList } from '../../factory/globs.ts';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

test('each stage workflow has the name and run-name the router parses', () => {
  for (const wf of STAGE_WORKFLOWS) {
    const yml = read(`.github/workflows/factory-${wf}.yml`);
    assert.match(yml, new RegExp(`^name: factory-${wf}$`, 'm'));
    assert.ok(yml.includes(`run-name: 'factory-${wf} #\${{ inputs.issue }}'`), `${wf} run-name`);
    assert.match(yml, new RegExp(`^      stage: ${wf}$`, 'm'));
  }
});

test('the router listens to CI and every stage workflow', () => {
  assert.match(read('.github/workflows/ci.yml'), new RegExp(`^name: ${CI_WORKFLOW_NAME}$`, 'm'));
  assert.ok(read('.github/workflows/factory-router.yml').includes('workflows: [CI, factory-plan, factory-build, factory-review, factory-fix]'));
});

test('router and stages run main\'s code, never a branch\'s', () => {
  assert.ok(read('.github/workflows/factory-router.yml').includes('ref: main'));
  const stage = read('.github/workflows/factory-stage.yml');
  assert.ok(stage.includes('ref: main'));
  assert.ok(stage.includes('git checkout origin/main -- .claude'));
});

test('only the planner can read the issue', () => {
  for (const wf of ['build', 'review', 'fix']) {
    const yml = read(`.github/workflows/factory-${wf}.yml`);
    assert.ok(!yml.includes('Bash(gh issue'), `${wf} must not get gh issue tools`);
    assert.match(yml, /^ {6}issues: ''$/m, `${wf} App token gets no issues permission`);
  }
  assert.match(read('.github/workflows/factory-plan.yml'), /^ {6}issues: write$/m);
});

test('the skills pin is a repo and a ref', () => {
  const settings = JSON.parse(read('.claude/settings.json'));
  const source = settings.extraKnownMarketplaces.mattpocock.source;
  assert.equal(source.repo, 'mattpocock/skills');
  assert.match(source.ref, /^([0-9a-f]{40}|v?\d+\.\d+\.\d+)$/);
  assert.equal(settings.enabledPlugins['mattpocock-skills@mattpocock'], true);
});

test('the factory, its prompts and CI are risky paths', () => {
  const risky = parseGlobList(read('factory/risky-paths.txt'));
  for (const p of ['.github/**', '.claude/**', 'factory/**', 'AGENTS.md', 'plugin/hooks/**']) assert.ok(risky.includes(p), p);
});
