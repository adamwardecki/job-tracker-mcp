// Rule types: which consumers a rule applies to.

import type { RuleRow } from './db.ts';
import { ToolError } from './errors.ts';
import { isRecord, oneOf } from './util.ts';

export const RULE_TYPES = ['global', 'sourcing', 'scoring', 'forms', 'writing', 'inbox', 'reporting'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

// checkArgs only checks that `types` is an array, so the list and every item are checked here. Returns the
// distinct types in RULE_TYPES order, so the same set always stores and reads back the same way.
export function normalizeRuleTypes(types: unknown): RuleType[] {
  if (!Array.isArray(types)) throw new ToolError(`types must be a list of rule types: ${RULE_TYPES.join(', ')}`);
  if (!types.length) throw new ToolError(`types needs at least one of: ${RULE_TYPES.join(', ')}. Use ["global"] for a rule every consumer must read.`);
  for (const [i, v] of types.entries()) {
    if (!oneOf(RULE_TYPES, v)) throw new ToolError(`types[${i}]: ${JSON.stringify(v)} is not a rule type. Use: ${RULE_TYPES.join(', ')}`);
  }
  return RULE_TYPES.filter((t) => types.includes(t));
}

export const DEFAULT_RULE_LIMIT = 10;
export const MAX_RULE_LIMIT = 50;

// One entry of a list_rules page: the stored fields plus types. Only an entry that needs a get_rule read
// carries just id, types and requires_detail.
export type RuleListItem = Pick<RuleRow, 'id'> & Partial<Omit<RuleRow, 'id'>> & { types: RuleType[]; requires_detail?: true };

// What a cursor remembers: where the page ended and the filters and rules revision it was issued under.
export interface RuleCursor {
  v: 1;
  after_id: number;
  revision: number;
  types: RuleType[] | null;
  include_inactive: boolean;
}

// checkArgs only checks that limit is an integer; the range is checked here. Null and undefined are the default.
export function normalizeRuleLimit(limit: unknown): number {
  if (limit == null) return DEFAULT_RULE_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_RULE_LIMIT) {
    throw new ToolError(`limit must be a whole number from 1 to ${MAX_RULE_LIMIT} (default ${DEFAULT_RULE_LIMIT}), got ${JSON.stringify(limit)}`);
  }
  return limit;
}

// ---------- cursors ----------
// A cursor is base64url JSON {v: 1, ...fields}. The envelope below is shared by every paged tool; each tool
// validates its own fields after decodeCursor, so a cursor from one tool or shape is never read as another's.

const MAX_CURSOR_LENGTH = 1000;

export const badCursor = (tool: string, why: string) => new ToolError(`cursor is not one ${tool} returned (${why}). Restart ${tool} without a cursor.`);

export function encodeCursor(fields: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...fields })).toString('base64url');
}

// A cursor comes from the model, which may have edited or invented it, so nothing in it is trusted. Returns
// the parsed record with the version and key set checked: `keys` are the fields the tool's cursors carry, and
// the caller validates each value. Every failure is a ToolError that says to restart.
export function decodeCursor(cursor: unknown, tool: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof cursor !== 'string' || !cursor) throw badCursor(tool, 'empty');
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor(tool, 'not base64url');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw badCursor(tool, 'not JSON');
  }
  if (!isRecord(parsed)) throw badCursor(tool, 'not an object');
  if (parsed.v !== 1) throw badCursor(tool, 'unknown version');
  if (Object.keys(parsed).some((k) => k !== 'v' && !keys.includes(k))) throw badCursor(tool, 'wrong fields');
  return parsed;
}

export function cursorInt(tool: string, field: string, value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw badCursor(tool, `bad ${field}`);
  return value;
}

// Pages read at two revisions could skip or repeat what changed between them, so the caller starts over.
export function assertFreshRevision(tool: string, cursorRevision: number, current: number): void {
  if (cursorRevision !== current) {
    throw new ToolError(`Rules changed since this page was read (revision ${cursorRevision}, now ${current}). Restart ${tool} without a cursor and discard the pages already read.`);
  }
}

const RULE_CURSOR_KEYS = ['after_id', 'revision', 'types', 'include_inactive'];

export function encodeRuleCursor({ after_id, revision, types, include_inactive }: RuleCursor): string {
  return encodeCursor({ after_id, revision, types, include_inactive });
}

export function decodeRuleCursor(cursor: unknown): RuleCursor {
  const tool = 'list_rules';
  const raw = decodeCursor(cursor, tool, RULE_CURSOR_KEYS);
  const after_id = cursorInt(tool, 'rule id', raw.after_id, 1);
  const revision = cursorInt(tool, 'revision', raw.revision, 0);
  if (typeof raw.include_inactive !== 'boolean') throw badCursor(tool, 'bad include_inactive');
  let types: RuleType[] | null = null;
  if (raw.types !== null) {
    if (!Array.isArray(raw.types)) throw badCursor(tool, 'bad types');
    try {
      types = normalizeRuleTypes(raw.types);
    } catch {
      throw badCursor(tool, 'bad types');
    }
    // Cursors are issued with canonical types; a different order or a repeat was edited.
    if (types.join() !== raw.types.join()) throw badCursor(tool, 'types out of order');
  }
  return { v: 1, after_id, revision, types, include_inactive: raw.include_inactive };
}

export interface RuleFilters {
  types: RuleType[] | null;
  include_inactive: boolean;
}

// The filters a call lists under. Omitted filters are inherited from the cursor, so a caller can pass the cursor
// alone; one that is given must match the cursor once both are normalized, or the pages would mix two listings.
export function resolveRuleFilters(types: unknown, includeInactive: boolean | null | undefined, after: RuleCursor | null): RuleFilters {
  const asked = types == null ? null : normalizeRuleTypes(types);
  if (!after) return { types: asked, include_inactive: includeInactive ?? false };
  const show = (k: RuleType[] | null) => (k ? k.join(', ') : 'all types');
  if (asked && asked.join() !== (after.types ?? []).join()) {
    throw new ToolError(`types (${show(asked)}) differ from the cursor's (${show(after.types)}). Restart list_rules without a cursor to change the filter, or omit types to continue this listing.`);
  }
  if (includeInactive != null && includeInactive !== after.include_inactive) {
    throw new ToolError(`include_inactive (${includeInactive}) differs from the cursor's (${after.include_inactive}). Restart list_rules without a cursor to change the filter, or omit include_inactive to continue this listing.`);
  }
  return { types: after.types, include_inactive: after.include_inactive };
}
