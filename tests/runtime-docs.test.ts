// The markdown that tells the model what to do when Node.js is missing (spec 2026-10-17, parts 2 and 3).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (p: string) => readFileSync(new URL(`../plugin/${p}`, import.meta.url), 'utf8');
const step0 = () => {
  const skill = read('skills/setup/SKILL.md');
  return skill.slice(skill.indexOf('### 0. Runtime'), skill.indexOf('### 1. CV import'));
};

test('setup runs the runtime step before setup_status', () => {
  const skill = read('skills/setup/SKILL.md');
  const step0 = skill.indexOf('### 0. Runtime');
  assert.ok(step0 > -1 && step0 < skill.indexOf('### 1. CV import'), 'step 0 comes before CV import');
  assert.match(skill, /scripts\/install-node\.sh" --check/);
  // Windows uses winget instead of a shipped PowerShell script, which held the directory submission.
  assert.doesNotMatch(skill, /\.ps1/);
  assert.match(skill, /`winget install --id OpenJS\.NodeJS\.LTS --exact --source winget/);
  assert.match(skill, /Windows, say: open Terminal or PowerShell and run `winget install OpenJS\.NodeJS\.LTS`/);
  assert.match(skill, /never work around a checksum or signature failure/i);
  assert.match(read('commands/setup.md'), /1\. Run step 0 \(Runtime\) of the skill first\. If step 0 stops, stop here too\./);
});

test('setup step 0 never loops on restarts and never reinstalls over a shadowed Node', () => {
  const s = step0();
  // Exit 0: one restart question, then a diagnosis with the exact Node path instead of another restart.
  assert.match(s, /\*\*Check passes \(exit 0\)\*\*/);
  assert.match(s, /Have you quit and reopened the app since Node\.js was installed\?/);
  assert.match(s, /"<path>" --no-warnings "\$\{CLAUDE_PLUGIN_ROOT\}\/servers\/tracker\/src\/index\.ts" < \/dev\/null/);
  assert.match(s, /\$null \| & "<path>" --no-warnings "\$\{CLAUDE_PLUGIN_ROOT\}\/servers\/tracker\/src\/index\.ts"/);
  assert.match(s, /`stdio ready`[^\n]*https:\/\/github\.com\/adamwardecki\/job-tracker-mcp[^\n]*do not suggest another restart/i);
  // Exit 1 is the only route to the installer; exit 3 stops without it.
  assert.match(s, /\*\*Check fails \(exit 1\)\*\*/);
  assert.match(s, /\*\*Exit 3\*\*[^\n]*older copy of Node\.js[^\n]*Do not offer the installer/);
  // Linux has no installer route.
  assert.match(s, /Linux[^\n]*"I'll install it myself"/);
  // After an install, a failing check stops instead of offering the installer again.
  assert.match(s, /run the check again[^\n]*If it still fails, show its message and stop; do not offer the installer again/);
});

test('every tracker command explains a missing runtime in one sentence', () => {
  const missing = /\*\*If the tracker tools are missing\*\* \(search for them first if tools are deferred\), or a hook error says `node` could not start:/;
  for (const name of ['apply', 'status', 'prep', 'cover-letter', 'triage', 'correct', 'import', 'board']) {
    assert.match(read(`commands/${name}.md`), new RegExp(`${missing.source}.*offer to run \`\\/job-tracker:setup\``), name);
  }
  assert.match(read('commands/sweep.md'), new RegExp(`${missing.source}.*Record nothing\\.`));
});

test('setup field lists and settings.example.yaml match the config schema', async () => {
  const { CONFIG_SCHEMA } = await import('../plugin/servers/tracker/src/config.ts');
  const skill = read('skills/setup/SKILL.md');
  const yaml = read('templates/settings.example.yaml');
  for (const section of ['filters', 'prefs', 'writing', 'accounts', 'schedule', 'sources'] as const) {
    const keys = Object.keys(CONFIG_SCHEMA[section].fields);
    const step = skill.split('\n### ').find((s) => s.includes(`section: "${section}"`)) ?? '';
    // Top-level keys only: nested names like `daily` (`days`, ...) sit in parentheses.
    const line = step.split('\n').find((l) => l.startsWith('- Fields: ')) ?? '';
    const listed = [...line.replace(/\([^)]*\)/g, '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(listed, keys, `setup step for ${section}`);
    const block = yaml.slice(yaml.indexOf(`\n${section}:`) + 1).split(/\n(?=[a-z])/)[0] ?? '';
    for (const k of keys) assert.match(block, new RegExp(`\\n  ${k}:`), `settings.example.yaml ${section}.${k}`);
  }
});

test('the board command opens the browser and the sweep report points to it', () => {
  const board = read('commands/board.md');
  assert.match(board, /Call `open_board` with `open: true`\./);
  assert.match(board, /Why: /);
  assert.match(read('commands/sweep.md'), /End the report with the line `Board: run \/job-tracker:board`\./);
});

// Rule delivery (B4): list_rules pages at 10, so a prompt that calls it once sees only part of the rules.
// The retrieval protocol lives once in templates/rules.md ("Reading rules"); every consumer names its types and points there.
const shipped = (dir = '', out: string[] = []): string[] => {
  for (const e of readdirSync(new URL(`../plugin/${dir}`, import.meta.url), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'servers' || e.name === 'scripts') continue;
    if (e.isDirectory()) shipped(`${dir}${e.name}/`, out);
    else if (e.name.endsWith('.md')) out.push(`${dir}${e.name}`);
  }
  return out;
};

test('no shipped prompt calls list_rules without the paging protocol', () => {
  const callers = shipped().filter((f) => f !== 'templates/rules.md' && read(f).includes('list_rules'));
  for (const f of callers) assert.match(read(f), /next_cursor|Reading rules/, `${f} mentions list_rules but not how to page it`);
});

test('the shared Reading rules section carries the whole protocol and its reason', () => {
  const rules = read('templates/rules.md');
  const s = rules.slice(rules.indexOf('## Reading rules'));
  assert.ok(rules.includes('## Reading rules'), 'templates/rules.md has a Reading rules section');
  for (const needle of ['`next_cursor`', '`requires_detail`', '`get_rule`', 'JSON.parse', 'discard', 'two attempts', 'Why: ']) assert.ok(s.includes(needle), needle);
});

// File -> the rule types its "Reading rules" line names (spec B, consumer mapping). [] means all types.
const CONSUMERS: Record<string, string[]> = {
  'agents/sourcer.md': ['sourcing'],
  'skills/source-roles/SKILL.md': ['sourcing'],
  'agents/scorer.md': ['scoring'],
  'skills/verify-employer/SKILL.md': ['scoring'],
  'skills/score-role/SKILL.md': ['scoring'],
  'commands/apply.md': ['forms', 'scoring', 'writing'],
  'skills/fill-form/SKILL.md': ['forms', 'scoring', 'writing'],
  'skills/write-note/SKILL.md': ['writing'],
  'commands/cover-letter.md': ['writing'],
  'skills/inbox-and-calendar/SKILL.md': ['inbox', 'writing'],
  'skills/interview-prep/SKILL.md': ['inbox', 'writing'],
  'commands/sweep.md': ['reporting'],
  'agents/auditor.md': ['reporting'],
  'commands/status.md': ['reporting'],
  'skills/setup/SKILL.md': [],
  'commands/correct.md': [],
  'commands/import.md': [],
};
const RULE_TYPES = ['global', 'sourcing', 'scoring', 'forms', 'writing', 'inbox', 'reporting'];

test('every rules consumer names the types it loads and points at Reading rules with both path forms', () => {
  for (const [f, types] of Object.entries(CONSUMERS)) {
    const line = read(f).split('\n').find((l) => l.includes('Reading rules')) ?? '';
    assert.ok(line, `${f} has a Reading rules line`);
    assert.deepEqual([...line.matchAll(/`([a-z]+)`/g)].map((m) => m[1]).filter((t) => RULE_TYPES.includes(t!)), types, f);
    if (types.length === 0) assert.match(line, /all types/, f);
    assert.match(read(f), /\$\{CLAUDE_PLUGIN_ROOT\}\/templates\/rules\.md/, f);
    assert.match(read(f), /\$\{HERMES_SKILL_DIR\}\/(\.\.\/)+templates\/rules\.md/, f);
  }
});

test('the sweep tells each subagent which rule types to load', () => {
  const sweep = read('commands/sweep.md');
  assert.match(sweep, /`sourcer`[^\n]*rule types[^\n]*`sourcing`/);
  assert.match(sweep, /`scorer`[^\n]*rule types[^\n]*`scoring`/);
  assert.match(sweep, /`auditor`[^\n]*rule types[^\n]*`reporting`/);
});

test('correct classifies new rules, paginates all types for conflicts and never deactivates on its own', () => {
  const c = read('commands/correct.md');
  assert.match(c, /`types`/);
  assert.match(c, /`set_rule_types`/);
  assert.match(c, /Never `deactivate_rule` without the user's yes/);
});
