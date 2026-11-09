// The text formats the factory reads back from GitHub: the router's state comment, the planner's brief, the
// reviewer's verdict and the maintainer's slash commands.

import { isRecord, oneOf } from '../plugin/servers/tracker/src/util.ts';
import { STAGES, type Stage } from './config.ts';

export const FIX_REASONS = ['ci', 'review', 'maintainer', 'rebase'] as const;
export type FixReason = (typeof FIX_REASONS)[number];

export const COMMANDS = ['approve', 'stop', 'retry'] as const;
export type Command = (typeof COMMANDS)[number];

export type FactoryState = {
  stage: Stage;
  since: string; // ISO time the current stage began
  round: number; // fix rounds counted toward MAX_ROUNDS (CI and reviewer)
  attempts: number; // failed runs of the current stage
  failedAt?: string;
  pr?: number;
  brief?: number; // comment id of the brief the later stages work from
  approvalFor?: 'plan' | 'diff';
  blockedFrom?: Stage;
  headSha?: string; // PR head when the fixer was dispatched; unchanged after it means it pushed nothing
  fixReason?: FixReason;
  runs: string[];
};

const STATE_RE = /<!-- factory:state (\{.*?\}) -->/s;
const REVIEW_RE = /<!-- factory:review (\{.*?\}) -->/s;
export const BRIEF_MARKER = '<!-- factory:brief v1 -->';

function json(re: RegExp, body: string): unknown {
  const m = re.exec(body);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1] ?? '');
  } catch {
    return undefined;
  }
}

export function renderState(s: FactoryState): string {
  const pr = s.pr ? ` · PR #${s.pr}` : '';
  const runs = s.runs.length ? `\n\nRuns: ${s.runs.map((u, i) => `[${i + 1}](${u})`).join(' ')}` : '';
  return `<!-- factory:state ${JSON.stringify(s)} -->\nFactory: **${s.stage}**${pr} · fix round ${s.round}${runs}`;
}

export function parseState(body: string): FactoryState | null {
  const v = json(STATE_RE, body);
  if (!isRecord(v) || !oneOf(STAGES, v.stage) || typeof v.since !== 'string') return null;
  if (typeof v.round !== 'number' || typeof v.attempts !== 'number' || !Array.isArray(v.runs)) return null;
  const s: FactoryState = {
    stage: v.stage,
    since: v.since,
    round: v.round,
    attempts: v.attempts,
    runs: v.runs.filter((r): r is string => typeof r === 'string'),
  };
  if (typeof v.failedAt === 'string') s.failedAt = v.failedAt;
  if (typeof v.pr === 'number') s.pr = v.pr;
  if (typeof v.brief === 'number') s.brief = v.brief;
  if (v.approvalFor === 'plan' || v.approvalFor === 'diff') s.approvalFor = v.approvalFor;
  if (oneOf(STAGES, v.blockedFrom)) s.blockedFrom = v.blockedFrom;
  if (typeof v.headSha === 'string') s.headSha = v.headSha;
  if (oneOf(FIX_REASONS, v.fixReason)) s.fixReason = v.fixReason;
  return s;
}

// The bulleted paths under "**Touches:**" in the brief's Factory block. null when the marker or the heading is
// missing, which the router treats as a planner that broke its contract.
export function parseBriefTouches(body: string): string[] | null {
  if (!body.includes(BRIEF_MARKER)) return null;
  const lines = body.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === '**touches:**');
  if (start < 0) return null;
  const touches: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*[-*]\s+`?([^`\s]+)`?\s*$/.exec(line);
    if (m?.[1]) touches.push(m[1]);
    else if (line.trim() !== '' || touches.length > 0) break;
  }
  return touches;
}

export function parseReview(body: string): { blocking: number; nits: number } | null {
  const v = json(REVIEW_RE, body);
  if (!isRecord(v) || typeof v.blocking !== 'number') return null;
  return { blocking: v.blocking, nits: typeof v.nits === 'number' ? v.nits : 0 };
}

export function parseCommand(body: string): Command | null {
  const word = /^\/(approve|stop|retry)\b/.exec(body.trim())?.[1];
  return oneOf(COMMANDS, word) ? word : null;
}
