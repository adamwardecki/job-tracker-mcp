// The markdown that tells the model what to do when Node.js is missing (spec 2026-10-17, parts 2 and 3).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const sweep = read('commands/sweep.md');
  assert.match(sweep, /End the report with the question `Open the job board now\? Reply yes, or run \/job-tracker:board later\.` as its final line\./);
  assert.match(sweep, /Never open the board yourself or call `open_board` with `open: true` during the sweep\. Why: /);
  assert.match(sweep, /If the user replies yes in this session, follow `\/job-tracker:board` \(call `open_board` with `open: true`\)\./);
  assert.doesNotMatch(sweep, /Board: run \/job-tracker:board/);
});

// Rule delivery (B4): list_rules pages, so a prompt that calls it once sees only part of the rules. The retrieval
// protocol lives once in templates/rules.md ("Reading rules"); every consumer names its types and points there.
const SKIP_DIRS = ['node_modules', 'servers', 'scripts']; // not prompts: dependencies, server code, shell scripts
const shipped = (dir = '', out: string[] = []): string[] => {
  for (const e of readdirSync(new URL(`../plugin/${dir}`, import.meta.url), { withFileTypes: true })) {
    if (SKIP_DIRS.includes(e.name)) continue;
    if (e.isDirectory()) shipped(`${dir}${e.name}/`, out);
    else if (e.name.endsWith('.md')) out.push(`${dir}${e.name}`);
  }
  return out;
};

test('only templates/rules.md names list_rules: prompts point at it instead of calling the tool bare', () => {
  const callers = shipped().filter((f) => f !== 'templates/rules.md' && read(f).includes('list_rules'));
  assert.deepEqual(callers, [], 'a prompt that says list_rules is one page of rules; use the "Rules: load" line');
});

test('the shared Reading rules section carries the whole protocol and its reason', () => {
  const rules = read('templates/rules.md');
  const s = rules.slice(rules.indexOf('## Reading rules'));
  assert.ok(rules.includes('## Reading rules'), 'templates/rules.md has a Reading rules section');
  for (const needle of ['`next_cursor`', '`rules_revision`', '`expected_revision`', 'first call for every oversized rule', 'Compare every page and detail response', 'discard all list pages and detail chunks together', '`requires_detail`', '`get_rule`', 'JSON.parse', 'discard', 'two attempts', '`blocked: rules unreadable`', 'only if nothing wrote a rule since', '`add_rule`, `set_rule_types`, `deactivate_rule`', 'A subagent always reads its own', 'Why: ']) assert.ok(s.includes(needle), needle);
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
    const m = read(f).match(/Rules: load ([^(\n]*) \(Reading rules: `([^`]*)`; Hermes: `([^`]*)`\)/);
    assert.ok(m, `${f} has a "Rules: load <types> (Reading rules: ...; Hermes: ...)" sentence`);
    assert.deepEqual([...m[1]!.matchAll(/`([a-z]+)`/g)].map((t) => t[1]).filter((t) => RULE_TYPES.includes(t!)), types, f);
    if (types.length === 0) assert.match(m[1]!, /all types/, f);
    assert.match(m[2]!, /^\$\{CLAUDE_PLUGIN_ROOT\}\/templates\/rules\.md$/, f);
    assert.match(m[3]!, /^\$\{HERMES_SKILL_DIR\}\/(\.\.\/)+templates\/rules\.md$/, f);
  }
});

test('the sweep tells each subagent which rule types to load', () => {
  const sweep = read('commands/sweep.md');
  assert.match(sweep, /`sourcer`[^\n]*rule types[^\n]*`sourcing`/);
  assert.match(sweep, /`scorer`[^\n]*rule types[^\n]*`scoring`/);
  assert.match(sweep, /`auditor`[^\n]*rule types[^\n]*`reporting`/);
  // The sweep's own failed read, or a blocked subagent, makes the run incomplete but the report still goes out.
  assert.match(sweep, /own read fails, or any subagent returns `blocked: rules unreadable`, the run is incomplete: put that first under \*\*Needs you\*\*, still render and deliver the report/);
});

test('correct classifies new rules, paginates all types for conflicts and never deactivates on its own', () => {
  const c = read('commands/correct.md');
  assert.match(c, /`types`/);
  assert.match(c, /`set_rule_types`/);
  assert.match(c, /Never `deactivate_rule` without the user's yes/);
});

// External reconciliation (C4): the shared mechanics live once in the inbox skill; the others point at it.
// One fact per assertion, so rewording a sentence breaks only the guard for the fact it moved.
test('the inbox skill reads full threads and says why', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /Read full threads, not previews/);
  assert.match(s, /Why: the sweep read only the LinkedIn inbox preview/);
});

test('the inbox skill takes its window from the checkpoint and reports coverage per account', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /`checked_through` in `source_health\.checkpoints` minus 48 hours/);
  assert.match(s, /last 30 days/);
  assert.match(s, /explicit date range from the user/);
  assert.match(s, /Follow every connector page/);
  assert.match(s, /`set_source_status`[^\n]*`source_account`/);
  assert.match(s, /`coverage`/);
  assert.match(s, /`checked_through` = the actual end of the window you searched/);
  assert.match(s, /Never `complete`, no `checked_through`/);
  assert.match(s, /never omit a connected source/);
});

test('the inbox skill keys every external record by an immutable identity and passes the real time', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /immutable message ID/);
  assert.match(s, /not the thread ID/);
  assert.match(s, /application ID plus the original application date/);
  assert.match(s, /`occurred_at` is the real time/);
  assert.match(s, /`interview_id`/);
  assert.match(s, /`state: "cancelled"`/);
  // A later sighting of a keyed interview is ordered by its own time, not by reading the oldest message first.
  assert.match(s, /pass `interview_id`, the changed fields and that message's own `occurred_at`/);
  assert.match(s, /`stale: true` result means a newer update is already applied: do nothing/);
  assert.doesNotMatch(s, /oldest message first/);
});

test('the inbox skill treats results correctly: replays are no-ops and conflicts go to the user', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /`duplicate: true`/);
  assert.match(s, /`status_applied: false` with a `conflict`/);
  assert.match(s, /Needs you/);
  assert.match(s, /do not retry or force a status/);
});

test('the inbox skill reconciles clear missing-role evidence and surfaces stranded history', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /A clear sourced receipt can establish a newly discovered `found` role as `applied`/);
  assert.match(s, /without backdating discovery or inventing verification, scoring or queue events/);
  assert.match(s, /A replay does not reproject an old already-recorded stranded receipt/);
  assert.match(s, /surface it under Needs you for explicit reconciliation/);
  assert.doesNotMatch(s, /for example an acknowledgement for a role still in found/);
});

test('acknowledgement classification does not depend on current role status', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  const acknowledgement = s.split('\n').find((line) => line.startsWith('| **Acknowledgement**')) ?? '';
  assert.match(acknowledgement, /For a new receipt, always `record` `actor: "user"`, `status: "applied"`/);
  assert.match(acknowledgement, /regardless of the role's current status/);
  assert.doesNotMatch(s, /Otherwise `record` a note/);
  assert.match(s, /inspect `get_role`'s `events` for the same `source`, `source_account` and `source_id`/);
  assert.match(s, /legacy employer note, keep its stored actor, status, outcome, evidence and occurrence time/);
  assert.match(s, /Why: replay identity belongs to the message, not the role's current status/);
  assert.match(s, /Ordering prevents an older receipt from reopening a rejection/);
  assert.match(s, /Surface a genuine immutable-payload mismatch under Needs you; never invent an id or time/);
});

test('the inbox skill reads calendars before holding a to-book claim, and checkpoints them at the window end', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  const gather = s.indexOf('### 2. Gather mail');
  assert.ok(gather > -1 && s.indexOf('`search_threads`') > gather && s.indexOf('`search_threads`') < s.indexOf('**Window and coverage.**'), 'the gather bullets come before the coverage rules');
  assert.match(s, /Hold the "to book" claim until step 6/);
  const calendar = s.slice(s.indexOf('### 6. Calendar'));
  assert.match(calendar, /`set_source_status`/);
  assert.match(calendar, /end of the search window \(now\), not the end of the 14-day lookahead/);
  assert.match(calendar, /more than a day ahead/);
});

test('a skipped source is unavailable with status degraded; only a real error is failed', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  // `failed` counts toward degradation, and source-roles says only real errors may.
  assert.match(s, /Skipped by design[^\n]*`unavailable` with `status: "degraded"`/);
  assert.match(s, /A real error[^\n]*`status: "failed"`/);
  assert.doesNotMatch(s, /Skipped by design[^\n]*`status: "failed"`/);
  for (const f of ['skills/triage-tracker/SKILL.md', 'skills/source-roles/reference.md', 'skills/source-roles/SKILL.md', 'commands/sweep.md']) {
    assert.doesNotMatch(read(f), /(skipped|no browser)[^\n]*`status: "failed"`/, f);
    assert.doesNotMatch(read(f), /`unavailable`[^\n]*`status: "failed"`/, f);
  }
});

test('the other prompts point at Window and coverage instead of restating it', () => {
  for (const f of ['skills/triage-tracker/SKILL.md', 'skills/source-roles/reference.md', 'skills/source-roles/SKILL.md']) {
    assert.match(read(f), /Window and coverage/, f);
  }
  assert.match(read('skills/triage-tracker/SKILL.md'), /application ID plus the original date/);
  assert.match(read('skills/source-roles/reference.md'), /application ID plus the original date/);
});

test('the sweep passes the run start time and the auditor checks coverage and bookings against it', () => {
  const sweep = read('commands/sweep.md');
  assert.match(sweep, /`source_health`/);
  assert.match(sweep, /checkpoints/);
  assert.match(sweep, /`inbox-and-calendar` skill/);
  assert.match(sweep, /run's start time \(`capabilities\.detected_at` from `start_run`\)/);
  const auditor = read('agents/auditor.md');
  assert.match(auditor, /run's start time/);
  assert.match(auditor, /`last_attempt_at` must be at or after the run's start time/);
  assert.match(auditor, /`source_account`/);
  assert.match(auditor, /`last_error`/);
  assert.match(auditor, /`last_coverage: complete`/);
  assert.match(auditor, /claimed checked, no checkpoint attempt/);
  assert.match(auditor, /`open_items`/);
  assert.doesNotMatch(auditor, /you were told about/);
});

// The delete guard and delete rounds are safety text. AGENTS.md makes anything touching delete gates "ask first", so
// these pins exist to stop a reconciliation edit from changing a byte of them by accident.
test('triage-tracker hard rules, guard and delete rounds are unchanged by the reconciliation edits', () => {
  const s = read('skills/triage-tracker/SKILL.md');
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');
  const section = (from: string, to: string) => {
    const a = s.indexOf(from);
    const b = s.indexOf(to);
    assert.ok(a >= 0 && b > a, `section "${from}" to "${to}" not found: the headings were renamed or moved`);
    return s.slice(a, b);
  };
  const rules = section('## Hard rules', '## Procedure');
  const rounds = section('### 6. Delete in rounds', '### 7. Finish');
  // The rules the hash covers, checked directly so a failure names the rule that changed.
  assert.match(rules, /Resolve every column by its header text, never by index or class/);
  assert.match(rules, /Run the guard before every delete round/);
  assert.match(rules, /Selection must exactly equal the intended list/);
  assert.match(rules, /Never enable auto-apply, change board settings, or withdraw applications/);
  assert.match(rules, /Hook denials are final for that click/);
  assert.match(rules, /Deletes need the user: agree the delete criteria with them before the first round/);
  assert.match(rounds, /Run the guard with `column`, `protectedColumns` and the round's `intended` titles\. Require `ok: true`\./);
  assert.match(rounds, /No other clicks in between/);
  const why = (name: string, text: string, expected: string) =>
    assert.equal(sha(text), expected, `${name} of triage-tracker changed (hash ${sha(text)}). These delete-gate sections are ask-first in AGENTS.md ("anything touching send, submit, consent or delete gates"). If the change was approved, replace the hash in this test; otherwise revert it.`);
  why('Hard rules and guard', rules, '52e64f52998b2a3d40ef7fbd83629c44dd39555f3c67d911b45006575d1712f2');
  why('Delete rounds (step 6)', rounds, '75d87a15fbdd2c41e4eb2932210dcef6afa4c0d46c5ef8e64159d08a5f757cde');
});

test('the inbox skill surfaces an unknown interview replay baseline without inventing metadata', () => {
  const s = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(s, /replay baseline is unknown/);
  assert.match(s, /surface the uncertainty under Needs you/);
  assert.match(s, /Do not change the key or occurrence time/);
  assert.match(s, /genuinely newer dated update/);
  assert.match(s, /Why: pre-upgrade history cannot always prove the accepted external values/);
});

test('drafts that need the CV attach the saved file, and the claim is checked', () => {
  const inbox = read('skills/inbox-and-calendar/SKILL.md');
  assert.match(inbox, /`get_cv`/);
  assert.match(inbox, /Gmail draft attachments/);
  assert.match(inbox, /attach the CV \(`<path>`\) before sending/);
  // Artifacts are insert-only, so the CV is decided before the draft is written and its evidence recorded once.
  const drafts = inbox.slice(inbox.indexOf('### 4. Reply drafts'), inbox.indexOf('### 5.'));
  assert.ok(drafts.indexOf('`get_cv`') !== -1 && drafts.indexOf('`get_cv`') < drafts.indexOf('`create_draft`'), 'get_cv comes before create_draft in section 4');
  assert.ok(drafts.indexOf('`create_draft`') < drafts.indexOf('`add_artifact`'));
  assert.match(drafts, /Attachment: none, user must attach/);
  assert.match(read('skills/write-note/SKILL.md'), /only when the CV will be attached/);
  assert.match(read('agents/auditor.md'), /reported "with CV"/);
});

test('setup copies the CV and looks for a dropped file before asking for its path', () => {
  const skill = read('skills/setup/SKILL.md');
  const s = skill.slice(skill.indexOf('### 1. CV import'), skill.indexOf('### 2.'));
  // A user who dropped their CV into the chat was asked for a path, and a path they gave was only linked.
  assert.match(s, /look for it by name before asking: on macOS `mdfind -name "<file name>"`/);
  assert.match(s, /Ask for the path \(option 2\) only when the search finds nothing or there is no shell\./);
  assert.match(s, /For options 1 and 2, `save_cv` copies the file into `cv\/` in the tracker's folder/);
  assert.match(s, /Pass `copy: false` only if the user asks/);
  assert.doesNotMatch(s, /`copy: true`/);
});
