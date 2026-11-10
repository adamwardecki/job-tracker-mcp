// The workflows and the router agree on names, run titles and isolation rules. Read as text: no YAML parser.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CI_WORKFLOW_NAME, STAGE_WORKFLOWS } from '../../factory/config.ts';
import { parseGlobList, riskyFiles } from '../../factory/globs.ts';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const WORKFLOWS = readdirSync(join(REPO, '.github/workflows'))
  .filter((f) => f.startsWith('factory-'))
  .map((f) => `.github/workflows/${f}`);
// The --allowedTools list a stage wrapper passes, split on the commas between tools.
const allowedTools = (yml: string) => (/^ {6}allowed_tools: '([^']*)'$/m.exec(yml)?.[1] ?? '').split(/,(?![^(]*\))/);

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
  // An overlay of main's .claude would stage files on the branch and break the fixer's rebase; the router gates
  // risky diffs before review and fix run instead.
  assert.ok(!stage.includes('git checkout origin/main --'));
  // Dev tools install from main's lockfile, without scripts, before the switch to the PR branch.
  const install = stage.indexOf('npm ci --prefix dev --ignore-scripts');
  assert.ok(install > 0 && install < stage.indexOf('git checkout "factory/issue-'), 'install before the switch');
  assert.match(stage, /if: inputs\.stage == 'build' \|\| inputs\.stage == 'fix'\n {8}run: npm ci --prefix dev --ignore-scripts\n/, 'only build and fix install');
  assert.ok(!stage.includes('npm run setup'));
  assert.ok(!/^ {10}cache:/m.test(stage), 'no npm cache in main\'s scope');
});

test('the stage context comes from main, and the CI log only from the recorded run', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  assert.ok(stage.includes('node --no-warnings factory/stage-context.ts "$STAGE" "$ISSUE" .factory'));
  assert.ok(stage.includes('.factory/ci-run-id'));
  assert.ok(stage.includes('gh run view "$run_id" --log-failed'));
  for (const f of WORKFLOWS) assert.ok(!/gh run list[^\n]*--branch/.test(read(f)), `${f} looks a run up by branch`);
});

test('the router ignores runs from forks', () => {
  assert.ok(read('.github/workflows/factory-router.yml').includes('github.event.workflow_run.head_repository.full_name == github.repository'));
});

test('the planner runs no code', () => {
  const tools = allowedTools(read('.github/workflows/factory-plan.yml'));
  for (const t of tools) assert.ok(!/^Bash\((node|npm)\b/.test(t), `planner tool ${t}`);
  assert.ok(!read('.claude/skills/factory-plan/SKILL.md').includes('npm run setup'));
});

test('no stage reads PR comments', () => {
  for (const f of WORKFLOWS) assert.ok(!read(f).includes('gh pr view'), f);
});

test('the stages get exactly the secrets they need', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  assert.match(stage, /^ {4}secrets:\n {6}FACTORY_APP_PRIVATE_KEY: \{ required: true \}\n {6}CLAUDE_CODE_OAUTH_TOKEN: \{ required: true \}$/m);
  for (const wf of STAGE_WORKFLOWS) {
    const yml = read(`.github/workflows/factory-${wf}.yml`);
    assert.ok(!yml.includes('secrets: inherit'), `${wf} inherits secrets`);
    assert.ok(yml.includes(`      FACTORY_APP_PRIVATE_KEY: \${{ secrets.FACTORY_APP_PRIVATE_KEY }}\n      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n`), `${wf} secrets`);
    assert.equal(yml.match(/\$\{\{ secrets\./g)?.length, 2, `${wf} passes only two secrets`);
  }
});

test('the stages that run code scrub its environment', () => {
  for (const wf of ['build', 'review', 'fix']) assert.match(read(`.github/workflows/factory-${wf}.yml`), /^ {6}scrub_env: '1'$/m, wf);
  assert.ok(read('.github/workflows/factory-stage.yml').includes(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: \${{ inputs.scrub_env }}`));
});

test('every action is pinned to a commit, with its exact version alongside', () => {
  let seen = 0;
  for (const f of WORKFLOWS) {
    for (const m of read(f).matchAll(/uses: (\S+)(.*)$/gm)) {
      if (m[1] === './.github/workflows/factory-stage.yml') continue;
      seen++;
      assert.match(m[1] ?? '', /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
      assert.match(m[2] ?? '', /^ # v\d+\.\d+\.\d+$/, `${f}: ${m[1]} names its version`);
    }
  }
  assert.equal(seen, 7, 'the router\'s checkout, setup-node and token; the stage\'s token, checkout, setup-node and claude-code-action');
});

test('the stage checks the factory variables before using them', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  assert.ok(stage.includes('[[ "$BOT_ID" =~ ^[0-9]+$ ]]'));
  assert.ok(stage.includes('[[ "$APP_SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]'));
  assert.ok(stage.indexOf('Check the factory variables') < stage.indexOf('create-github-app-token'));
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
  // A tag can be moved; a commit cannot.
  assert.match(source.ref, /^[0-9a-f]{40}$/);
  assert.equal(settings.enabledPlugins['mattpocock-skills@mattpocock'], true);
});

test('the factory, its prompts and CI are risky paths', () => {
  const risky = parseGlobList(read('factory/risky-paths.txt'));
  for (const p of ['.github/**', '**/.claude/**', 'factory/**', 'AGENTS.md', 'plugin/hooks/**']) assert.ok(risky.includes(p), p);
  assert.ok(!risky.includes('.claude/**'), 'the root-only glob would miss a nested .claude/');
});

test('the files the agents load or run are risky paths', () => {
  const risky = parseGlobList(read('factory/risky-paths.txt'));
  const loaded = ['.mcp.json', '.claude.json', '**/CLAUDE.md', '**/CLAUDE.local.md', 'CONTRIBUTING.md', '.gitignore', '.gitmodules', '.husky/**', '.ripgreprc', 'biome.json', 'tsconfig.json'];
  for (const p of loaded) assert.ok(risky.includes(p), p);
});

test('the docs Matt Pocock\'s skills read and the factory\'s scratch directory are risky paths', () => {
  const risky = parseGlobList(read('factory/risky-paths.txt'));
  const docs = ['docs/agents/**', 'GLOSSARY.md', 'GLOSSARY-MAP.md', 'CONTEXT.md', 'CONTEXT-MAP.md', 'docs/adr/**', '**/docs/adr/**', '.factory/**'];
  for (const p of docs) assert.ok(risky.includes(p), p);
});

test('a .claude directory at any level, the root one included, is risky', () => {
  const risky = parseGlobList(read('factory/risky-paths.txt'));
  const files = [
    '.claude/settings.json',
    '.claude/skills/factory-review/SKILL.md',
    'plugin/.claude/settings.json',
    'tests/.claude/skills/x/SKILL.md',
    'docs/agents/issue-tracker.md',
    'GLOSSARY.md',
    'docs/adr/0001-x.md',
    'plugin/docs/adr/0002-y.md',
    '.factory/mp/tdd/SKILL.md',
  ];
  assert.deepEqual(riskyFiles(files, risky), files);
  assert.deepEqual(riskyFiles(['docs/setup.md', 'plugin/claude/x.md', 'tests/factory/decide.test.ts'], risky), []);
});

// The planner and the reviewer read the repo and write their drafts under .factory/; nothing else.
const READ_AND_DRAFT = ['Read(./**)', 'Grep', 'Glob', 'Edit(./.factory/**)', 'Skill'];

test('the planner\'s and the reviewer\'s tools are exactly these', () => {
  assert.deepEqual(allowedTools(read('.github/workflows/factory-plan.yml')), [...READ_AND_DRAFT, 'Bash(gh issue view:*)', 'Bash(gh issue comment:*)', 'Bash(gh issue edit:*)']);
  assert.deepEqual(allowedTools(read('.github/workflows/factory-review.yml')), [
    ...READ_AND_DRAFT,
    'Agent',
    'Bash(git diff:*)',
    'Bash(git log:*)',
    'Bash(git rev-parse:*)',
    'Bash(gh pr diff:*)',
    'Bash(gh pr review:*)',
  ]);
  for (const wf of ['plan', 'review']) {
    for (const t of allowedTools(read(`.github/workflows/factory-${wf}.yml`))) {
      assert.ok(!/^Bash\((npm|node)\b/.test(t), `${wf}: ${t}`);
      assert.notEqual(t, 'Bash(git:*)', wf);
      assert.ok(!['Read', 'Edit', 'Write'].includes(t), `${wf}: unscoped ${t}`);
      assert.ok(!t.startsWith('Write'), `${wf}: ${t}`);
    }
  }
});

test('no stage reads outside the repo or reinstalls the dev tools', () => {
  for (const wf of STAGE_WORKFLOWS) {
    const tools = allowedTools(read(`.github/workflows/factory-${wf}.yml`));
    assert.ok(tools.includes('Read(./**)') && !tools.includes('Read'), `${wf}: Read is scoped to the repo`);
    assert.ok(!tools.some((t) => t.includes('npm run setup')), `${wf}: npm run setup`);
  }
});

test('review and fix run only on the PR head the router checked', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  const sw = stage.indexOf('git checkout "factory/issue-$ISSUE"');
  const check = stage.indexOf('[[ "$head" == "$gated" ]] || {');
  assert.ok(sw > 0 && check > sw, 'the head is checked after the switch');
  assert.ok(stage.includes('gated=$(cat .factory/head-sha)'));
  assert.ok(stage.includes('head=$(git rev-parse HEAD)'));
  assert.ok(stage.indexOf('factory/stage-context.ts') < sw, 'head-sha is written from main before the switch');
});

// The router's job condition, as one line.
const routerIf = () => (/^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(read('.github/workflows/factory-router.yml'))?.[1] ?? '').replace(/\s+/g, ' ').trim();

test('the router wakes only for events it can act on', () => {
  const cond = routerIf();
  const clauses = [
    "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    "(github.event_name == 'workflow_run' && github.event.workflow_run.head_repository.full_name == github.repository && (github.event.workflow_run.name != 'CI' || startsWith(github.event.workflow_run.head_branch, 'factory/issue-')))",
    "(github.event_name == 'issue_comment' && startsWith(github.event.comment.body, '/') && github.actor == 'adamwardecki')",
    "(github.event_name == 'issues' && github.event.label.name == 'agent:queued' && github.actor == 'adamwardecki')",
    "(github.event_name == 'pull_request_review' && github.event.review.state == 'changes_requested' && github.actor == 'adamwardecki' && github.event.pull_request.head.repo.full_name == github.repository)",
    "(github.event_name == 'pull_request_target' && startsWith(github.event.pull_request.head.ref, 'factory/issue-') && github.event.pull_request.head.repo.full_name == github.repository)",
  ];
  assert.equal(cond, clauses.join(' || '));
});

test('only build and fix keep git credentials; the router keeps none', () => {
  assert.match(read('.github/workflows/factory-router.yml'), /ref: main\n {10}persist-credentials: false\n/);
  const stage = read('.github/workflows/factory-stage.yml');
  assert.ok(stage.includes(`token: \${{ steps.app.outputs.token }}\n          persist-credentials: \${{ inputs.stage == 'build' || inputs.stage == 'fix' }}\n`));
});

test('the skills pin and the stage context are read from main, before the switch to the PR branch', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  const sw = stage.indexOf('git checkout "factory/issue-$ISSUE"');
  for (const step of ['Read the skills pin', 'Fetch Matt Pocock\'s skills at the pin', 'Build the stage context']) {
    const at = stage.indexOf(`- name: ${step}`);
    assert.ok(at > stage.indexOf('ref: main') && at < sw, step);
  }
});

test('the stage job\'s GITHUB_TOKEN only reads', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  const block = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(stage)?.[1] ?? '';
  const perms = block.trim().split('\n').map((l) => l.trim());
  assert.deepEqual(perms, ['contents: read', 'issues: read', 'pull-requests: read', 'actions: read']);
  for (const wf of STAGE_WORKFLOWS) {
    const top = /^permissions:\n((?: {2}.*\n)+)/m.exec(read(`.github/workflows/factory-${wf}.yml`))?.[1] ?? '';
    for (const l of top.trim().split('\n')) assert.match(l.trim(), /^[a-z-]+: read$/, `${wf}: ${l}`);
  }
});

test('the CI log goes in a tilde fence that backticks in the log cannot close', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  assert.ok(stage.includes(`{ echo '~~~~~~'; gh run view "$run_id" --log-failed | tail -n 300; echo '~~~~~~'; } >> .factory/context.md`));
  assert.ok(!stage.includes('```'));
});

test('a failed stage prints Claude\'s error only when the run never reached the model', () => {
  const stage = read('.github/workflows/factory-stage.yml');
  const step = stage.slice(stage.indexOf('- name: Show why Claude stopped before starting'));
  assert.match(step, /if: failure\(\)/);
  // A run that made a model call can quote issue text or code; the log is public.
  assert.match(step, /\(\.total_cost_usd \/\/ 0\) == 0/);
  assert.match(step, /\(\.modelUsage \/\/ \{\} \| length\) == 0/);
  assert.doesNotMatch(stage, /show_full_output/);
});
