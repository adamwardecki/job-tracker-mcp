// Step log for hosts that give hooks no transcript file (Hermes, DeepSeek Harness). Each tool call and
// its result is appended in Claude Code's transcript shape, so lib/transcript.ts reads it unchanged.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { secureDir, secureFile } from '../../servers/tracker/src/fsperm.ts';
import { isRecord } from '../../servers/tracker/src/util.ts';
import { home } from './session.ts';
import type { ToolInput } from './types.ts';

const MAX_RESULT_CHARS = 100_000;
const safeId = (id: unknown) => String(id || 'unknown').replace(/[^\w.-]/g, '_');

export function stepsPath(sessionId: string | undefined): string {
  return join(home(), 'sessions', `${safeId(sessionId)}.steps.jsonl`);
}

function isErrorResult(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.error != null && parsed.error !== false;
}

function flatten(value: unknown, key: string, out: string[]): string[] {
  if (value == null) return out;
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, Array.isArray(value) ? key : k, out);
    return out;
  }
  out.push(key ? `${key}: ${value}` : String(value));
  return out;
}

function resultText(result: unknown): { text: string; isError: boolean } {
  const raw = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, isError: false };
  }
  const flat = typeof parsed === 'object' && parsed !== null ? flatten(parsed, '', []).join('\n') : String(parsed);
  return { text: `${flat}\n${raw}`, isError: isErrorResult(parsed) };
}

export function writeStep(sessionId: string | undefined, callId: string | undefined, name: string, input: ToolInput | undefined, result: unknown): void {
  const id = callId || `hc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const { text, isError } = resultText(result);
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: input || {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text.slice(0, MAX_RESULT_CHARS), is_error: isError }] } },
  ];
  secureDir(join(home(), 'sessions'));
  const path = stepsPath(sessionId);
  appendFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, { mode: 0o600 });
  secureFile(path);
}
