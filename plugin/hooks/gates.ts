// Hard gates for the job-hunt plugin (spec §11), one function per hook event. Entry point: main.ts.
// Fails closed for submits (no tracker = no submit) and open for everything unrelated to job hunting.

import { lintProse } from '../servers/tracker/src/lint.ts';
import { errorText } from '../servers/tracker/src/util.ts';
import { isBoardUrl, runningBoardPort } from './lib/board.ts';
import * as C from './lib/classify.ts';
import { activeApprovals, loadSession, saveSession } from './lib/session.ts';
import { normalizeTarget, sameTarget, targetMatchesRole } from './lib/target.ts';
import { gateCheck } from './lib/tracker-client.ts';
import { currentPage, readTranscript, tabIdOf, toolSteps } from './lib/transcript.ts';
import type { GuardResult, HookOutput, HookPayload, ResultStep, SessionState, ToolInput, ToolStep, UseStep } from './lib/types.ts';

const GUARD_MAX_AGE_STEPS = 40;

let out = (obj: HookOutput): void => {
  process.stdout.write(JSON.stringify(obj));
};
export function setOutput(fn: (obj: HookOutput) => void): void {
  out = fn;
}

const isUse = (s: ToolStep): s is UseStep => s.kind === 'use';
const isResult = (s: ToolStep): s is ResultStep => s.kind === 'result';

function deny(payload: HookPayload, session: SessionState, reason: string): void {
  session.denials = [...(session.denials || []), { at: new Date().toISOString(), tool: payload.tool_name, reason: reason.slice(0, 300) }].slice(-50);
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `[job-hunt] ${reason}` } });
  trySaveSession(payload, session);
}

// A session file that cannot be written must not crash the hook or undo a decision already out.
function trySaveSession(payload: HookPayload, session: SessionState): boolean {
  try {
    saveSession(payload.session_id, session);
    return true;
  } catch (err) {
    process.stderr.write(`[job-hunt hook] could not save session state: ${errorText(err)}\n`);
    return false;
  }
}

// ---------------------------------------------------------------- PreToolUse

export async function preTool(payload: HookPayload): Promise<void> {
  const name = payload.tool_name || '';
  const input = payload.tool_input || {};
  const { server, short } = C.splitToolName(name);
  const session = loadSession(payload.session_id);

  // Sending is never done by this plugin, in any session.
  if (C.isSendTool(server, short)) {
    deny(payload, session, `Sending is blocked: the job-hunt plugin only creates drafts. "${short}" on ${server} would send in the user's name. Create a draft instead and tell the user it is waiting.`);
    return;
  }

  // The board is the user's, in any session: see boardGate.
  if (C.isBrowser(server) && (await boardGate(payload, session, short, input))) return;

  if (C.isTracker(server)) {
    if (!session.marked) {
      session.marked = true;
      saveSession(payload.session_id, session);
    }
    if (short === 'verify_artifact') return checkReadback(payload, session, input);
    return;
  }

  if (!session.marked) return; // Browser and draft gates apply to job-hunt sessions only.

  if (C.isDraftWrite(server, short)) {
    const body = C.draftBody(input);
    if (!body) return;
    const lint = lintProse(body);
    if (!lint.ok) {
      const issues = lint.issues.filter((i) => i.severity === 'error').map((i) => `${i.kind}: "${i.match}" (${i.hint})`);
      deny(payload, session, `Draft fails the writing rules. Fix and retry:\n- ${issues.join('\n- ')}`);
      return;
    }
    return;
  }

  if (C.isBrowser(server)) return browserGate(payload, session, short, input);
}

// Moves on the board are recorded as the user's own and skip the confirmation text the tracker tools
// demand, so the model must not reach them through a browser: no opening the board, and no acting on its
// page. Looking is allowed. Returns true when it denied.
async function boardGate(payload: HookPayload, session: SessionState, short: string, input: ToolInput): Promise<boolean> {
  const port = await runningBoardPort();
  let onBoard: boolean;
  if (typeof input.url === 'string') onBoard = isBoardUrl(input.url, port);
  else if (C.onlyReads(short, input)) onBoard = false;
  else {
    const page = currentPage(toolSteps(readTranscript(payload.transcript_path)), tabIdOf(input));
    onBoard = page !== null && isBoardUrl(page.url, port);
  }
  if (onBoard) deny(payload, session, "The Job Tracker board is the user's: a move made there is recorded as the user's own, without the evidence and status rules the tracker tools require. Do not open or operate it in the browser. Change status with transition or record, or ask the user to move the card.");
  return onBoard;
}

async function browserGate(payload: HookPayload, session: SessionState, short: string, input: ToolInput): Promise<void> {
  const action = C.browserAction(short, input);
  if (action === 'other' || action === 'type') return;
  const steps = toolSteps(readTranscript(payload.transcript_path));
  const page = currentPage(steps, tabIdOf(input));
  const url = page?.url || '';
  const host = C.hostOf(url);

  if (action === 'js') {
    const intent = C.jsIntent(input.text || input.code || input.script || input.function || input.expression);
    if (intent === 'submit') return submitGate(payload, session, 'a scripted submit/apply click', page);
    if (intent === 'delete') return deleteGate(payload, session, steps, host, 'a scripted delete');
    if (intent === 'personal') {
      deny(payload, session, 'Scripted write into a personal-data or consent field. These are for the user to fill. Surface the field to the user.');
      return;
    }
    return;
  }

  const label = C.resolveLabel(input, steps);
  const accName = C.accessibleName(label) || '';

  if (action === 'input') {
    if (label && C.PERSONAL.test(label)) {
      deny(payload, session, `"${accName}" asks for personal data (passport, nationality, age, marital status, gender, ID and similar). The plugin never fills these. Leave it and list it for the user.`);
      return;
    }
    if (label && C.CONSENT.test(label) && C.truthy(input.value) && !consentAllowed(session, page)) {
      deny(payload, session, `"${accName}" is a consent (recording, marketing, talent pool). Choose the privacy-preserving option, or ask the user to type /job-tracker:allow-consent <role_id>.`);
      return;
    }
    return;
  }

  // Clicks.
  if (!label) return; // Coordinate click with no resolvable element. Skills require ref clicks for submits; the auditor checks.
  if (C.SEND.test(accName) || (/mail\.google\.com|linkedin\.com/.test(host) && /^send\b/i.test(accName))) {
    deny(payload, session, `Clicking "${accName}" would send a message in the user's name. Sending is blocked; leave it as a draft.`);
    return;
  }
  if (C.PERSONAL_OPTION.test(accName) || (C.PERSONAL.test(label) && /radio|checkbox|option/i.test(label))) {
    deny(payload, session, `"${accName}" answers a personal-data question. Leave it for the user.`);
    return;
  }
  if (C.CONSENT.test(label) && /checkbox|radio|switch/i.test(label) && !C.isDecline(accName) && !consentAllowed(session, page)) {
    deny(payload, session, `"${accName}" ticks a consent. Leave it unticked (privacy-preserving), or ask the user to type /job-tracker:allow-consent <role_id>.`);
    return;
  }
  if (C.SUBMIT.test(accName) && !/^apply (?:filters?|changes)$/i.test(accName)) return submitGate(payload, session, `"${accName}"`, page);
  if (C.DELETE.test(accName)) return deleteGate(payload, session, steps, host, `"${accName}"`);
}

function consentAllowed(session: SessionState, page: { url: string; tab_id?: string } | null): boolean {
  if (!page) return false;
  return activeApprovals(session.consents).some((approval) => sameTarget(approval.target_url, page.url) && (approval.target_tab === undefined || approval.target_tab === page.tab_id));
}

async function submitGate(payload: HookPayload, session: SessionState, what: string, page: { url: string; tab_id?: string } | null): Promise<void> {
  const approvals = activeApprovals(session.approvals);
  if (!approvals.length) {
    deny(payload, session, `Submit blocked: ${what} needs the user's approval in this session. Stop here, show the filled form, and ask the user to type /job-tracker:approve <role_id>. Do not work around this.`);
    return;
  }
  if (!page) {
    deny(payload, session, `Submit blocked: ${what} has no identifiable browser page. Re-read the application form, then ask the user to approve it again.`);
    return;
  }
  const approval = [...approvals].reverse().find((candidate) => sameTarget(candidate.target_url, page.url) && (candidate.target_tab === undefined || candidate.target_tab === page.tab_id));
  if (!approval) {
    deny(payload, session, `Submit blocked: ${what} is on a different page or tab from the approved application. Return to the form and ask the user to approve this role again.`);
    return;
  }
  const gate = await gateCheck(approval.role_id);
  if (!gate.ok) {
    deny(payload, session, `Submit blocked for role ${approval.role_id}: ${(gate.problems || []).join(' ')}`);
    return;
  }
  if (!gate.url || !targetMatchesRole(gate.url, page.url)) {
    deny(payload, session, `Submit blocked for role ${approval.role_id}: the current page no longer matches the role's application URL. Verify the role URL and ask the user to approve again.`);
    return;
  }
  // Approval is single-use. Persist its removal before allowing the click; a failed save blocks.
  session.approvals = approvals.filter((candidate) => candidate !== approval);
  if (!trySaveSession(payload, session)) {
    deny(payload, session, `Submit blocked for role ${approval.role_id}: the one-use approval could not be consumed safely. Ask the user to approve again.`);
  }
}

function deleteGate(payload: HookPayload, session: SessionState, steps: ToolStep[], host: string, what: string): void {
  if (C.ATS_HOST.test(host)) return; // "Remove file" and similar inside an application form.
  let guardIdx = -1;
  let guard: GuardResult | null = null;
  for (let i = steps.length - 1; i >= 0 && i >= steps.length - 400; i--) {
    const s = steps[i]!; // i is within steps by the loop bounds.
    if (s.kind !== 'result') continue;
    const m = s.text.match(/JOBHUNT_TRIAGE_GUARD\s+(\{.*?\})\s*JOBHUNT_END/s);
    if (m) {
      guardIdx = i;
      guard = parseGuard(m[1]!); // The group always takes part in a match.
      break;
    }
  }
  if (!guard) {
    deny(payload, session, `Delete blocked: ${what} needs a fresh triage guard. Run skills/triage-tracker/guard.js with javascript_tool (column by header text, intended list, protected columns) and retry.`);
    return;
  }
  if (guard.ok !== true) {
    deny(payload, session, `Delete blocked: the last triage guard failed: ${(guard.problems || []).join(' ') || 'ok is not true'}. Fix the selection and re-run the guard.`);
    return;
  }
  if (steps.length - guardIdx > GUARD_MAX_AGE_STEPS) {
    deny(payload, session, 'Delete blocked: the triage guard is stale. Re-run it immediately before deleting.');
    return;
  }
  // Since the guard, only the delete control and its confirm dialog may have been clicked.
  for (const s of steps.slice(guardIdx + 1)) {
    if (s.kind !== 'use') continue;
    const { server, short } = C.splitToolName(s.name);
    if (!C.isBrowser(server) || C.browserAction(short, s.input) !== 'click') continue;
    const name = C.accessibleName(C.resolveLabel(s.input, steps)) || '';
    if (!name || !(C.DELETE.test(name) || C.CONFIRM.test(name))) {
      deny(payload, session, `Delete blocked: "${name || 'a coordinate click'}" was clicked after the guard ran, so the selection may have changed. Re-run the guard.`);
      return;
    }
  }
}

// The guard prints one line of JSON; a tool may hand it back JSON-escaped. Unescape \" and \\ in one pass:
// unescaping \\ first would turn an escaped backslash before a quote into a second escape.
function parseGuard(raw: string): GuardResult {
  for (const attempt of [raw, raw.replace(/\\(["\\])/g, '$1')]) {
    try {
      return JSON.parse(attempt) as GuardResult;
    } catch {}
  }
  return { ok: false, problems: ['guard output could not be parsed'] };
}

function checkReadback(payload: HookPayload, session: SessionState, input: ToolInput): void {
  const readback = String(input.readback || '');
  const tokens = [...new Set(readback.match(/[A-Za-z0-9_-]{8,}/g) || [])];
  const steps = toolSteps(readTranscript(payload.transcript_path));
  const reads = steps.filter(isResult).filter((s) => !s.isError && /(get|list|search)_?drafts?|get_message|get_thread/i.test(s.name));
  const seen = reads.some((r) => tokens.some((tok) => r.text.includes(tok)));
  if (!seen) {
    deny(payload, session, 'verify_artifact needs a real read-back: call get_draft or list_drafts in this session and pass its output. A tool result containing the draft id was not found.');
    return;
  }
}

// ---------------------------------------------------------------- UserPromptSubmit

const USER_COMMANDS = new Set(['sweep', 'apply', 'triage', 'setup', 'prep', 'status', 'cover-letter', 'correct', 'import', 'approve', 'allow-consent']);

function userCommand(text: string): { name: string; args: string } | null {
  // Approval must be the user's whole prompt. Mentions, quotations, negations and code examples do
  // not count as authorization.
  const match = text.trim().match(/^\/(?:job-tracker:)?([a-z-]+)(?:\s+([\s\S]*?))?\s*$/);
  if (!match?.[1] || !USER_COMMANDS.has(match[1])) return null;
  return { name: match[1], args: (match[2] || '').trim() };
}

function roleArgument(args: string): number | null {
  const match = args.match(/^#?(\d+)$/);
  return match?.[1] ? Number(match[1]) : null;
}

export async function prompt(payload: HookPayload): Promise<void> {
  const text = String(payload.prompt || '');
  const command = userCommand(text);
  const session = loadSession(payload.session_id);
  const notes: string[] = [];
  let changed = false;
  const now = new Date().toISOString();

  if (command) {
    if (!session.marked) changed = session.marked = true;
    if (command.name === 'sweep' && session.kind !== 'sweep') {
      session.kind = 'sweep';
      changed = true;
    }
  }
  const role_id = command && (command.name === 'approve' || command.name === 'allow-consent') ? roleArgument(command.args) : null;
  if (command?.name === 'approve' && role_id !== null) {
    const gate = await gateCheck(role_id);
    const page = currentPage(toolSteps(readTranscript(payload.transcript_path)));
    const target_url = page ? normalizeTarget(page.url) : null;
    if (!gate.url) {
      notes.push(`[job-hunt] Approval for role ${role_id} was not recorded: ${(gate.problems || []).join(' ') || 'the role has no application URL.'}`);
    } else if (!target_url) {
      notes.push(`[job-hunt] Approval for role ${role_id} was not recorded: the current browser page could not be identified. Re-read the application form and ask the user to approve again.`);
    } else if (!targetMatchesRole(gate.url, target_url)) {
      notes.push(`[job-hunt] Approval for role ${role_id} was not recorded: the current browser page does not match this role's application URL. Return to the correct form and ask the user to approve again.`);
    } else {
      session.approvals = [...activeApprovals(session.approvals).filter((approval) => approval.role_id !== role_id), { role_id, at: now, target_url, ...(page?.tab_id ? { target_tab: page.tab_id } : {}) }];
      changed = true;
      notes.push(gate.ok
        ? `[job-hunt] The user approved one submit for role ${role_id} (${gate.company || ''} ${gate.title || ''}) on the current application page. gate_check passed. The approval lasts up to 2 hours and is consumed by the submit attempt.`
        : `[job-hunt] The user approved role ${role_id} on the current application page, but gate_check fails: ${(gate.problems || []).join(' ')} The submit hook will block until this is resolved. Tell the user.`);
    }
  }
  if (command?.name === 'allow-consent' && role_id !== null) {
    const gate = await gateCheck(role_id);
    const page = currentPage(toolSteps(readTranscript(payload.transcript_path)));
    const target_url = page ? normalizeTarget(page.url) : null;
    if (!gate.url) {
      notes.push(`[job-hunt] Consent permission for role ${role_id} was not recorded: ${(gate.problems || []).join(' ') || 'the role has no application URL.'}`);
    } else if (!target_url) {
      notes.push(`[job-hunt] Consent permission for role ${role_id} was not recorded: the current browser page could not be identified. Re-read the application form and ask the user again.`);
    } else if (!targetMatchesRole(gate.url, target_url)) {
      notes.push(`[job-hunt] Consent permission for role ${role_id} was not recorded: the current browser page does not match this role's application URL.`);
    } else {
      session.consents = [...activeApprovals(session.consents).filter((approval) => approval.role_id !== role_id), { role_id, at: now, target_url, ...(page?.tab_id ? { target_tab: page.tab_id } : {}) }];
      changed = true;
      notes.push(`[job-hunt] The user allowed ticking consent boxes for role ${role_id} on the current application page for 2 hours.`);
    }
  }
  if (changed) saveSession(payload.session_id, session);
  if (notes.length) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: notes.join('\n') } });
}

// ---------------------------------------------------------------- Stop

export async function stop(payload: HookPayload): Promise<void> {
  const session = loadSession(payload.session_id);
  if (session.kind !== 'sweep') return;
  const steps = toolSteps(readTranscript(payload.transcript_path));
  const trackerUses = steps.filter(isUse).filter((s) => C.isTracker(C.splitToolName(s.name).server));
  const resultFor = new Map(steps.filter(isResult).map((s) => [s.id, s]));
  const touched = new Set<number>();
  const recorded = new Set<number>();
  let reported = false;
  for (const u of trackerUses) {
    const { short } = C.splitToolName(u.name);
    const r = resultFor.get(u.id);
    if (!r || r.isError) continue;
    if (short === 'upsert_role') {
      const m = r.text.match(/"role"\s*:\s*\{\s*"id"\s*:\s*(\d+)/);
      if (m) touched.add(Number(m[1]));
    }
    if ((short === 'transition' || short === 'record') && u.input?.role_id != null) recorded.add(Number(u.input.role_id));
    if (short === 'render_report') reported = true;
  }
  const missing = [...touched].filter((id) => !recorded.has(id));
  const problems: string[] = [];
  if (missing.length) problems.push(`Roles touched with no transition/record event: ${missing.join(', ')}. Record an outcome (verified, scored, dropped with evidence, queued with a question) for each.`);
  if (!reported) problems.push('No daily report rendered. Call render_report for today and deliver it.');
  if (!problems.length) return;
  session.stop_blocks = (session.stop_blocks || 0) + 1;
  // The reminder cap lives in the session file. If it cannot be saved the cap cannot work, so fail open rather than block forever.
  if (!trySaveSession(payload, session)) return;
  if (payload.stop_hook_active && session.stop_blocks > 3) {
    process.stderr.write(`[job-hunt] Sweep ended incomplete after 3 reminders: ${problems.join(' ')}\n`);
    return;
  }
  out({ decision: 'block', reason: `[job-hunt] The sweep is not finished:\n- ${problems.join('\n- ')}` });
}

export const HOOK_EVENTS = ['pre-tool', 'prompt', 'stop'] as const;
export const handlers: Record<(typeof HOOK_EVENTS)[number], (payload: HookPayload) => Promise<void>> = { 'pre-tool': preTool, prompt, stop };
