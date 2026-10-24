// Hermes host adapter. Hermes hook payloads differ from Claude Code's: tool names can be
// connectors__x__y or built-in browser_* tools, and there is no transcript file. These helpers map
// Hermes onto the shapes hooks/gates.ts already understands, so the gate logic stays shared.

import { isRecord } from '../../../servers/tracker/src/util.ts';
import { writeStep } from '../steps.ts';
import type { ToolInput } from '../types.ts';

// The Hermes hook kwargs that __init__.py pipes to hooks/hermes.ts as JSON.
export interface HermesPayload {
  session_id?: string;
  task_id?: string;
  parent_session_id?: string;
  tool_call_id?: string;
  tool_name?: string;
  args?: ToolInput;
  result?: unknown;
  user_message?: unknown;
}

export function normalizeToolName(name: unknown): string {
  const n = String(name || '');
  if (n.startsWith('mcp__')) return n;
  if (n.startsWith('connectors__')) return `mcp__${n.slice('connectors__'.length)}`;
  if (n.startsWith('browser_')) return `mcp__hermes_browser__${n}`;
  return n;
}

export function appendStep(p: HermesPayload): void {
  writeStep(p.session_id, p.tool_call_id, normalizeToolName(p.tool_name), p.args, p.result);
}

// Markers copied from Hermes agent/skill_commands.py; keep them byte-identical.
const INVOKED = '[IMPORTANT: The user has invoked the ';
const LOADED = 'The full skill content is loaded below.]';
const INSTRUCTION = 'The user has provided the following instruction alongside the skill invocation: ';
const RUNTIME_NOTE = '\n\n[Runtime note:';

// A slash-skill turn embeds the whole skill body. Only the skill name and the user's own instruction
// (after the LAST instruction marker) may be read. The body can quote "/job-tracker:approve 999" and
// must never count as approval.
export function unwrapSkillInvocation(text: string): { text: string; skill: string | null; args: string | null } {
  if (!text.startsWith(INVOKED) || !text.includes(LOADED)) return { text, skill: null, args: null };
  const skill = (text.slice(INVOKED.length).match(/^"\/?([^"]*)"/) || [])[1] || null;
  const at = text.lastIndexOf(INSTRUCTION);
  let args = at < 0 ? '' : text.slice(at + INSTRUCTION.length);
  const end = args.indexOf(RUNTIME_NOTE);
  if (end >= 0) args = args.slice(0, end);
  args = args.trim();
  return { text: skill ? `/${skill}${args ? ` ${args}` : ''}` : args, skill, args };
}

export function userText(message: unknown): string {
  const text = typeof message === 'string'
    ? message
    : Array.isArray(message)
      ? message.map((c) => (typeof c === 'string' ? c : isRecord(c) && c.type === 'text' ? c.text || '' : '')).filter(Boolean).join('\n')
      : '';
  return unwrapSkillInvocation(text).text;
}
