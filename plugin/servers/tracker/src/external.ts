// Events and rows that come from outside (a mailbox, a calendar, a board): the identity that makes a repeat the same
// occurrence, and the check that a repeat really is. Shared by every tool that takes these fields, each passing its
// own argument names so the errors name what the caller wrote.

import { ToolError } from './errors.ts';
import { explicitUtcIso } from './time.ts';

// Why: a time far ahead would outrank every later event and pin the role; a day allows for clock skew.
export const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

// The argument names of the four fields: source, the account that scopes its ids, the source's id, and when it happened.
export interface ExternalFieldNames {
  source: string;
  account: string;
  id: string;
  at: string;
}
export const EXTERNAL_FIELDS: ExternalFieldNames = { source: 'source', account: 'source_account', id: 'source_id', at: 'occurred_at' };

export interface ExternalIdentity {
  source: string;
  account: string;
  id: string;
  // The normalized UTC time it happened.
  ts: string;
}

// A source, account or id as stored: a non-empty string, trimmed.
export function requireKey(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${name} must not be empty.`);
  return value.trim();
}

// The external identity of a call: all four fields or none (null). Keys are stored trimmed, so a retry with stray
// whitespace is the same occurrence, and the source name is lowercase so Gmail and gmail are one source. Account and
// id keep their case: providers may distinguish it. A null value counts as not given.
export function externalIdentity(args: Readonly<Record<string, unknown>>, names: ExternalFieldNames = EXTERNAL_FIELDS): ExternalIdentity | null {
  const all = [names.source, names.account, names.id, names.at];
  const given = all.filter((n) => args[n] != null);
  if (!given.length) return null;
  if (given.length !== all.length) throw new ToolError(`${all.slice(0, -1).join(', ')} and ${names.at} identify one occurrence from outside (a message or board record) and come together: pass all four, or none.`);
  const key = (name: string) => requireKey(args[name], name);
  const ts = explicitUtcIso(args[names.at], names.at);
  if (Date.parse(ts) > Date.now() + FUTURE_SKEW_MS) throw new ToolError(`${names.at} is in the future (${ts}). Use the time the message or board record itself carries, not a time you expect it to happen. Nothing was written.`);
  return { source: key(names.source).toLowerCase(), account: key(names.account), id: key(names.id), ts };
}

// A repeated external id must be the same occurrence. fields are the ones that define it; what may differ is how it
// reached us. names says what to call a field in the error when its column is not what the caller wrote.
export function requireSameFields<K extends string>(label: string, known: Readonly<Partial<Record<K, unknown>>>, next: Readonly<Partial<Record<K, unknown>>>, fields: readonly K[], names?: Readonly<Partial<Record<K, string>>>): void {
  const differs = fields.filter((f) => (known[f] ?? null) !== (next[f] ?? null)).map((f) => names?.[f] ?? f);
  if (differs.length) throw new ToolError(`${label} was already recorded with different ${differs.join(', ')}. Nothing was written. An id names one immutable occurrence: give a new occurrence its own id, and correct a wrong record with a new event.`);
}
