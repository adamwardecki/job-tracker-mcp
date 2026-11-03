// What the board page reads and the one write it makes. board-server.ts calls these; the MCP server does not.

import { ToolError } from './errors.ts';
import type { Status, Tracker } from './tracker.ts';
import { groupOf, isCard, STATUSES, userMoves } from './tracker.ts';
import { isRecord, oneOf } from './util.ts';

// These steps need research with evidence (the verify-employer skill), so a drag can't do them.
const CLAUDE_ONLY: readonly Status[] = ['found', 'verified'];
const MOVE_KEYS: readonly string[] = ['role_id', 'to', 'reason', 'evidence', 'outcome'];
const NOTE_KEYS: readonly string[] = ['role_id', 'reason'];
// A drag is a decision in itself, so the board doesn't ask why; the user can add their own reason as a note.
const DEFAULT_REASON = 'Moved on the board';

export interface BoardRole {
  id: number;
  company: string;
  title: string;
  status: Status;
  score: number | null;
  location_type: string | null;
  url: string | null;
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  comp_period: string | null;
  last_event: string | null;
  question: string | null;
}

export function boardView(t: Tracker) {
  // One card per linked group: a duplicate's history counts toward its canonical role's card.
  const rows = t.q<BoardRole & { verified_at: string | null }>(`SELECT r.id, c.name AS company, r.title, COALESCE(r.status, 'found') AS status, r.score, r.location_type, r.url,
      r.comp_min, r.comp_max, r.comp_currency, r.comp_period, r.verified_at,
      (SELECT MAX(ts) FROM events e WHERE e.role_id IN ${groupOf('r.id')}) AS last_event,
      CASE WHEN r.status = 'queued' THEN (SELECT question FROM events e WHERE e.role_id IN ${groupOf('r.id')} AND e.status = 'queued' ORDER BY e.ts DESC, e.id DESC LIMIT 1) END AS question
    FROM roles r JOIN companies c ON c.id = r.company_id WHERE ${isCard('r.id')} ORDER BY r.score DESC NULLS LAST, r.updated_at DESC`);
  // Each card carries the lanes it may be dragged to, so the page lights up only those.
  const roles = rows.map(({ verified_at, ...r }) => ({ ...r, moves: userMoves({ ...r, verified_at }).moves }));
  const rules = t.q<{ id: number; text: string }>('SELECT id, text FROM rules WHERE active = 1 ORDER BY id');
  return { statuses: STATUSES, roles, rules };
}

const optionalString = (key: string, v: unknown): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ToolError(`${key} must be a string.`);
  return v;
};

function checkBody(body: unknown, keys: readonly string[]): Record<string, unknown> & { role_id: number } {
  if (!isRecord(body)) throw new ToolError(`Send a JSON object with: ${keys.join(', ')}.`);
  const extra = Object.keys(body).filter((k) => !keys.includes(k));
  if (extra.length) throw new ToolError(`Unknown field: ${extra.join(', ')}. Allowed: ${keys.join(', ')}.`);
  const { role_id } = body;
  if (typeof role_id !== 'number' || !Number.isInteger(role_id)) throw new ToolError('role_id must be an integer.');
  return { ...body, role_id };
}

export function boardMove(t: Tracker, input: unknown) {
  const body = checkBody(input, MOVE_KEYS);
  const { role_id, to } = body;
  if (!oneOf(STATUSES, to)) throw new ToolError(`to must be one of: ${STATUSES.join(', ')}`);
  if (CLAUDE_ONLY.includes(to)) throw new ToolError(`Moving to ${to} needs Claude: run a sweep, or ask Claude to verify role ${role_id}.`);
  // A same-status transition is legal (re-running a step with new evidence) but would only add a no-op event here.
  const current = t.cardRow(role_id);
  if (current && (current.status || 'found') === to) throw new ToolError(`Role ${role_id} is already ${to}.`);
  const reason = optionalString('reason', body.reason)?.trim() || DEFAULT_REASON;
  const args = { role_id, to, reason, evidence: optionalString('evidence', body.evidence), outcome: optionalString('outcome', body.outcome) };
  // The user is the authority on their own search: any lane to any lane, and applied or dropped without evidence.
  return t.transition(args, { actor: 'user', selfReported: true });
}

// The user's own reason for a move, added after it: events are append-only, so it is a note, not an edit.
export function boardNote(t: Tracker, input: unknown) {
  const body = checkBody(input, NOTE_KEYS);
  // record rejects an empty reason with its own message.
  const reason = optionalString('reason', body.reason)?.trim() ?? '';
  return t.record({ role_id: body.role_id, reason, actor: 'user' });
}
