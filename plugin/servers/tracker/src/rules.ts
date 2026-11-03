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

export function encodeRuleCursor(cursor: RuleCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

const RESTART = 'Restart list_rules without a cursor.';
const badCursor = (why: string) => new ToolError(`cursor is not one list_rules returned (${why}). ${RESTART}`);
const MAX_CURSOR_LENGTH = 1000;
const CURSOR_KEYS = ['v', 'after_id', 'revision', 'types', 'include_inactive'];

// A cursor comes from the model, which may have edited or invented it, so nothing in it is trusted: wrong
// encoding, JSON, version, ids, types or extra fields all end in the same instruction to restart.
export function decodeRuleCursor(cursor: unknown): RuleCursor {
  if (typeof cursor !== 'string' || !cursor) throw badCursor('empty');
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw badCursor('not base64url');
  const text = Buffer.from(cursor, 'base64url').toString();
  // Decoding skips what is not base64url; only an exact round trip proves the cursor was one we wrote.
  if (Buffer.from(text).toString('base64url') !== cursor) throw badCursor('not base64url');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badCursor('not JSON');
  }
  if (!isRecord(parsed)) throw badCursor('not an object');
  if (parsed.v !== 1) throw badCursor('unknown version');
  if (Object.keys(parsed).some((k) => !CURSOR_KEYS.includes(k)) || CURSOR_KEYS.some((k) => !(k in parsed))) throw badCursor('wrong fields');
  const { after_id, revision, types, include_inactive } = parsed;
  if (typeof after_id !== 'number' || !Number.isSafeInteger(after_id) || after_id < 1) throw badCursor('bad rule id');
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw badCursor('bad revision');
  if (typeof include_inactive !== 'boolean') throw badCursor('bad include_inactive');
  let kinds: RuleType[] | null = null;
  if (types !== null) {
    try {
      kinds = normalizeRuleTypes(types);
    } catch {
      throw badCursor('bad types');
    }
    if (kinds.join() !== (types as string[]).join()) throw badCursor('types out of order');
  }
  return { v: 1, after_id, revision, types: kinds, include_inactive };
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
