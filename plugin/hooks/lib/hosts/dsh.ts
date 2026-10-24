// DeepSeek Harness host adapter. dsh runs Claude Code command hooks through
// @deepseek-ai/dsh-hooks-claude-code, so payloads are already in Claude Code's shape. Two things differ:
// skill names cannot contain a colon (users type /job-tracker-approve, not /job-tracker:approve), and the
// prompt payload is the text of every message claimed for the step, not one typed message.

import type { ToolInput } from '../types.ts';

// The dsh-hooks-claude-code payload fields hooks/dsh.ts reads. transcript_path is always '' and
// stop_hook_active always false, so neither is read.
export interface DshPayload {
  session_id?: string;
  tool_name?: string;
  tool_input?: ToolInput;
  tool_use_id?: string;
  tool_response?: unknown;
  prompt?: string;
}

// Map a typed /job-tracker-<name> command onto the /job-tracker:<name> form the prompt gate parses. Like
// the gate, this only matches when the command is the whole prompt.
export function gatePrompt(text: unknown): { prompt: string; command: string | null; args: string } {
  const prompt = String(text || '');
  const match = prompt.trim().match(/^\/job-tracker-([a-z][a-z-]*)(?:\s+([\s\S]*?))?\s*$/);
  if (!match?.[1]) return { prompt, command: null, args: '' };
  const args = (match[2] || '').trim();
  return { prompt: `/job-tracker:${match[1]}${args ? ` ${args}` : ''}`, command: match[1], args };
}
