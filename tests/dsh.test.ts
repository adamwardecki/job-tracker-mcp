// DeepSeek Harness host: prompt mapping, hooks/dsh.ts end to end, dsh-hooks.json, and the installer.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatePrompt } from '../plugin/hooks/lib/hosts/dsh.ts';
import { openDb } from '../plugin/servers/tracker/src/db.ts';
import { Tracker } from '../plugin/servers/tracker/src/tracker.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(REPO, 'plugin');
const HOOK = join(PLUGIN, 'hooks', 'dsh.ts');
const INSTALL = join(PLUGIN, 'scripts', 'dsh-install.ts');
const CHROME = 'mcp__claude-in-chrome__';
const TRACKER = 'mcp__job_tracker__';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jh-dsh-'));
});

test('typed /job-tracker-<name> commands map onto the form the prompt gate parses', () => {
  assert.deepEqual(gatePrompt('/job-tracker-approve 12'), { prompt: '/job-tracker:approve 12', command: 'approve', args: '12' });
  assert.deepEqual(gatePrompt('  /job-tracker-sweep \n'), { prompt: '/job-tracker:sweep', command: 'sweep', args: '' });
  // Only a whole-prompt command maps; quotations and other forms pass through unchanged.
  assert.deepEqual(gatePrompt('please run /job-tracker-approve 12'), { prompt: 'please run /job-tracker-approve 12', command: null, args: '' });
  assert.deepEqual(gatePrompt('/job-tracker:approve 12'), { prompt: '/job-tracker:approve 12', command: null, args: '' });
  assert.equal(gatePrompt(undefined).prompt, '');
});

// --- hooks/dsh.ts e2e, with the payloads dsh-hooks-claude-code sends ---

function dsh(event: string, payload: Record<string, unknown>, status = 0) {
  const r = spawnSync(process.execPath, ['--no-warnings', HOOK, event], { input: JSON.stringify({ transcript_path: '', hook_event_name: event, ...payload }), env: { ...process.env, JOB_TRACKER_HOME: home, JOB_TRACKER_DB: '' }, encoding: 'utf8' });
  assert.equal(r.status, status, r.stderr);
  return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

const deniedBy = (out: { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null) =>
  out?.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason || '' : null;

function verifiedRole() {
  const t = new Tracker(openDb(join(home, 'tracker.db')));
  const role = t.upsertRole({ company: 'Beta', title: 'Founding Engineer', url: 'https://jobs.ashbyhq.com/beta/1', source: 'ashby' }).role;
  t.transition({ role_id: role.id, to: 'verified', reason: 'checked', evidence: 'https://jobs.ashbyhq.com/beta/1 "Remote (EU)"', location_line: 'Remote (EU)', location_type: 'remote' });
  t.db.close();
  return role;
}

function openApplication(sid: string) {
  dsh('post-tool', { session_id: sid, tool_use_id: 'n1', tool_name: `${CHROME}navigate`, tool_input: { url: 'https://jobs.ashbyhq.com/beta/1', tabId: 1 }, tool_response: 'url: https://jobs.ashbyhq.com/beta/1\ntabId: 1' });
  dsh('post-tool', { session_id: sid, tool_use_id: 'n2', tool_name: `${CHROME}read_page`, tool_input: { tabId: 1 }, tool_response: 'button "Submit application" [ref_45]' });
}

const click = (sid: string) => ({ session_id: sid, tool_name: `${CHROME}computer`, tool_input: { action: 'left_click', ref: 'ref_45', tabId: 1 } });

test('dsh.ts: send tools are blocked, unrelated tools pass silently', () => {
  assert.match(deniedBy(dsh('pre-tool', { session_id: 'd1', tool_name: 'mcp__gmail__send_email', tool_input: { to: 'a@example.com', body: 'hi' } }).out) || '', /drafts/);
  assert.equal(dsh('pre-tool', { session_id: 'd1', tool_name: 'mcp__github__list_issues', tool_input: {} }).out, null);
});

test('dsh.ts: a submit click needs the user approval typed as /job-tracker-approve, and uses it once', () => {
  const role = verifiedRole();
  const sid = 'd2';
  dsh('pre-tool', { session_id: sid, tool_name: `${TRACKER}open_items`, tool_input: {} }); // marks the session
  openApplication(sid);
  assert.match(deniedBy(dsh('pre-tool', click(sid)).out) || '', /needs the user's approval/);
  const approved = dsh('prompt', { session_id: sid, prompt: `/job-tracker-approve ${role.id}` }).out;
  assert.equal(approved.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(approved.hookSpecificOutput.additionalContext, /gate_check passed/);
  assert.match(approved.hookSpecificOutput.additionalContext, new RegExp(`\\$ARGUMENTS = "${role.id}"`));
  assert.equal(dsh('pre-tool', click(sid)).out, null);
  assert.match(deniedBy(dsh('pre-tool', click(sid)).out) || '', /needs the user's approval/, 'approval is consumed by one submit attempt');
});

test('dsh.ts: an approval that opens a fresh session (a subagent task) is not recorded', () => {
  // dsh gives a subagent its own session and sends its task through the same prompt hook. A fresh session
  // has no browser page in its step log, so the approval cannot bind to a form.
  const role = verifiedRole();
  const out = dsh('prompt', { session_id: 'child', prompt: `/job-tracker-approve ${role.id}` }).out;
  assert.match(out.hookSpecificOutput.additionalContext, /was not recorded: the current browser page could not be identified/);
  openApplication('child');
  assert.match(deniedBy(dsh('pre-tool', click('child')).out) || '', /needs the user's approval/);
});

test('dsh.ts: an unfinished sweep is held three times, then let go', () => {
  const sid = 'd4';
  dsh('prompt', { session_id: sid, prompt: '/job-tracker-sweep' });
  dsh('post-tool', { session_id: sid, tool_use_id: 'u1', tool_name: `${TRACKER}upsert_role`, tool_input: { company: 'A', title: 'B' }, tool_response: JSON.stringify({ role: { id: 1, title: 'B' }, created: true }) });
  for (let i = 0; i < 3; i++) {
    const { out } = dsh('stop', { session_id: sid, stop_hook_active: false });
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /render_report/);
  }
  // The bridge always sends stop_hook_active: false; the hook counts the blocks itself.
  assert.equal(dsh('stop', { session_id: sid, stop_hook_active: false }).out, null);
});

test('dsh.ts: tracker errors in the step log do not count as done', () => {
  const sid = 'd5';
  dsh('prompt', { session_id: sid, prompt: '/job-tracker-sweep' });
  dsh('post-tool', { session_id: sid, tool_use_id: 'r1', tool_name: `${TRACKER}render_report`, tool_input: {}, tool_response: JSON.stringify({ error: 'no run' }) });
  assert.match(dsh('stop', { session_id: sid }).out.reason, /No daily report rendered/);
});

// --- hooks/dsh-hooks.json ---

const DSH_HOOKS = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'dsh-hooks.json'), 'utf8'));
const CLAUDE_HOOKS = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
type Group = { matcher?: string; hooks: { type: string; command: string; timeout: number }[] };

test('dsh-hooks.json gates the same tools as hooks.json, through hooks/dsh.ts', () => {
  const matchers = (h: { hooks: Record<string, Group[]> }) => h.hooks.PreToolUse?.map((g) => g.matcher);
  assert.deepEqual(matchers(DSH_HOOKS), matchers(CLAUDE_HOOKS));
  const events: Record<string, string> = { PreToolUse: 'pre-tool', PostToolUse: 'post-tool', UserPromptSubmit: 'prompt', Stop: 'stop' };
  assert.deepEqual(Object.keys(DSH_HOOKS.hooks).sort(), Object.keys(events).sort());
  for (const [event, groups] of Object.entries(DSH_HOOKS.hooks as Record<string, Group[]>)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        assert.equal(h.type, 'command');
        assert.ok(h.command.startsWith(`node --no-warnings "\${CLAUDE_PLUGIN_ROOT}/hooks/dsh.ts" ${events[event]}`), h.command);
        // dsh.ts gives up after 10 s; the bridge's timeout must be longer, or a slow gate passes.
        assert.ok(h.timeout > 10, `${event} timeout`);
      }
    }
  }
});

function runHookCommand(command: string, path: string, input = JSON.stringify({ session_id: 'w1', tool_name: `${CHROME}computer`, tool_input: {} })) {
  const line = command.replaceAll(`\${CLAUDE_PLUGIN_ROOT}`, PLUGIN);
  return spawnSync('/bin/bash', ['-c', line], { input, env: { PATH: path, JOB_TRACKER_HOME: home }, encoding: 'utf8' });
}

function nodeBin() {
  const bin = mkdtempSync(join(tmpdir(), 'jh-node-'));
  symlinkSync(process.execPath, join(bin, 'node'));
  return bin;
}

test('dsh-hooks.json: when node cannot start, browser and mail tools are blocked and others pass', { skip: !existsSync('/bin/bash') }, () => {
  const [closed, open] = DSH_HOOKS.hooks.PreToolUse as Group[];
  const noNode = mkdtempSync(join(tmpdir(), 'jh-nonode-'));
  const blocked = runHookCommand(closed?.hooks[0]?.command || '', noNode);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /The gate could not run, so this browser or mail action is blocked/);
  // Any status other than 2 is a non-blocking error in the bridge.
  assert.notEqual(runHookCommand(open?.hooks[0]?.command || '', noNode).status, 2);
  // With node present the wrapper adds nothing: an allowed call still exits 0.
  assert.equal(runHookCommand(closed?.hooks[0]?.command || '', nodeBin()).status, 0);
});

test('dsh-hooks.json: a gate crash blocks browser and mail tools and lets other tools through', { skip: !existsSync('/bin/bash') }, () => {
  const [closed, open] = DSH_HOOKS.hooks.PreToolUse as Group[];
  // An unreadable payload makes dsh.ts fail before it knows the tool.
  assert.equal(runHookCommand(closed?.hooks[0]?.command || '', nodeBin(), '{not json').status, 2);
  assert.equal(runHookCommand(open?.hooks[0]?.command || '', nodeBin(), '{not json').status, 1);
});

// --- scripts/dsh-install.ts ---

function install(dshHome: string, ...args: string[]) {
  // A PATH with node and no dsh, so the installer prints the bridge install steps instead of running them.
  const bin = mkdtempSync(join(tmpdir(), 'jh-bin-'));
  symlinkSync(process.execPath, join(bin, 'node'));
  const r = spawnSync(process.execPath, ['--no-warnings', INSTALL, ...args], { env: { HOME: dshHome, PATH: bin, DSH_HOME: dshHome }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const frontmatter = (text: string) => Object.fromEntries((text.match(/^---\n([\s\S]*?)\n---/)?.[1] || '').split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));

test('dsh-install writes every command, skill and agent as a dsh skill with plugin paths filled in', () => {
  const stdout = install(home);
  assert.match(stdout, /dsh plugin --profile web add @deepseek-ai\/dsh-hooks-claude-code/);
  const skills = join(home, 'skills');
  const names = readdirSync(skills).sort();
  const expected = readdirSync(join(PLUGIN, 'commands')).length + readdirSync(join(PLUGIN, 'skills')).length + readdirSync(join(PLUGIN, 'agents')).length;
  assert.equal(names.length, expected);
  for (const name of ['job-tracker-sweep', 'job-tracker-approve', 'job-tracker-setup', 'job-tracker-setup-guide', 'job-tracker-fill-form', 'job-tracker-agent-scorer']) assert.ok(names.includes(name), name);
  for (const name of names) {
    // dsh drops a skill whose name is not kebab-case.
    assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const text = readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
    const fm = frontmatter(text);
    assert.equal(fm.name, name);
    assert.ok(JSON.parse(fm.description || '""').length > 20, `${name} has a description`);
    assert.doesNotMatch(text, /job-tracker:/, `${name} uses dsh skill names`);
    assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${name} has plugin paths filled in`);
  }
  assert.equal(frontmatter(readFileSync(join(skills, 'job-tracker-approve', 'SKILL.md'), 'utf8'))['disable-model-invocation'], 'true');
  assert.equal(frontmatter(readFileSync(join(skills, 'job-tracker-agent-scorer', 'SKILL.md'), 'utf8'))['user-invocable'], 'false');
  assert.match(readFileSync(join(skills, 'job-tracker-triage-tracker', 'SKILL.md'), 'utf8'), new RegExp(`${PLUGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/skills/triage-tracker/guard\\.js`));
  assert.ok(lstatSync(join(skills, 'job-tracker-triage-tracker', 'guard.js')).isSymbolicLink());
  assert.match(readFileSync(join(skills, 'job-tracker-sweep', 'SKILL.md'), 'utf8'), /skill `job-tracker-agent-<name>`/);
});

test('dsh-install patches each profile once, keeps the user\'s entries, and uninstalls cleanly', () => {
  const web = join(home, 'profiles', 'web', 'cordis.patch.yml');
  mkdirSync(dirname(web), { recursive: true });
  const mine = "# my patch\n- insert:\n    - id: my-memory\n      name: '@deepseek-ai/dsh-mcp-client'\n";
  writeFileSync(web, mine);
  const own = join(home, 'skills', 'job-tracker-mine');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'SKILL.md'), '---\nname: job-tracker-mine\ndescription: mine\n---\n');

  install(home);
  install(home);
  const patched = readFileSync(web, 'utf8');
  assert.ok(patched.startsWith(mine.trimEnd()));
  assert.equal(patched.split('# >>> job-tracker').length, 2, 'one block after two installs');
  assert.match(patched, /serverName: job_tracker/);
  assert.match(patched, new RegExp(`args: \\['--no-warnings', '${join(PLUGIN, 'servers', 'tracker', 'src', 'index.ts').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\]`));
  assert.match(patched, new RegExp(`configPath: '${join(PLUGIN, 'hooks', 'dsh-hooks.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.match(patched, /command: '.*\/node'/);
  assert.ok(existsSync(join(home, 'profiles', 'headless', 'cordis.patch.yml')));

  install(home, '--uninstall');
  assert.equal(readFileSync(web, 'utf8'), mine);
  assert.deepEqual(readdirSync(join(home, 'skills')), ['job-tracker-mine'], 'only skills the installer wrote are removed');
});

test('dsh-install leaves a patch file it cannot safely extend alone and prints the block', () => {
  const tui = join(home, 'profiles', 'tui', 'cordis.patch.yml');
  mkdirSync(dirname(tui), { recursive: true });
  writeFileSync(tui, '[]\n');
  const stdout = install(home, '--profile', 'tui');
  assert.equal(readFileSync(tui, 'utf8'), '[]\n');
  assert.match(stdout, /is not a plain patch list/);
  assert.match(stdout, /id: job-tracker-hooks/);
  assert.equal(basename(dirname(tui)), 'tui');
});
