// Timestamps are stored as UTC ISO strings. A "day" is a day in the user's timezone (filters.timezone).

import { ToolError } from './errors.ts';

export function isValidTimeZone(tz: unknown): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

// Offset of tz from UTC at instant ms, in ms (+2h for Europe/Berlin in summer).
function offsetAt(ms: number, tz: string): number {
  let f = offsetFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    offsetFormats.set(tz, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const n = (type: string) => Number(parts.find((x) => x.type === type)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(ms / 1000) * 1000;
}

export const zoneError = (tz: unknown) => new ToolError(`Unknown timezone "${tz}". Use an IANA name such as Europe/Berlin.`);

// UTC ms for a wall-clock time in tz. A time in a spring-forward gap resolves forward (02:30 becomes 03:30);
// an ambiguous fall-back time takes whichever occurrence the first guess lands in (later in Berlin, earlier in New York).
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetAt(guess - offsetAt(guess, tz), tz);
  const o2 = offsetAt(guess - o1, tz);
  return guess - Math.min(o1, o2);
}

// Rejects values that Date.UTC would roll over (Feb 30, hour 24, minute 60).
function validWall(y: number, mo: number, d: number, h: number, mi: number, s: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === s;
}

// Capture groups as numbers (a group that did not take part reads as 0).
const groups = (m: RegExpExecArray): number[] => m.slice(1).map((x) => Number(x || 0));

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// [start, end) of local day YYYY-MM-DD in tz, as UTC ISO strings.
export function dayBounds(date: unknown, tz = 'UTC'): [string, string] {
  const m = DAY.exec(String(date ?? ''));
  if (!m) throw new ToolError(`date must be YYYY-MM-DD, got "${date}"`);
  const [y = 0, mo = 0, d = 0] = groups(m);
  if (!validWall(y, mo, d, 0, 0, 0)) throw new ToolError(`date must be YYYY-MM-DD, got "${date}"`);
  if (!isValidTimeZone(tz)) throw zoneError(tz);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return [
    new Date(wallToUtc(y, mo, d, 0, 0, 0, tz)).toISOString(),
    new Date(wallToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz)).toISOString(),
  ];
}

// YYYY-MM-DD of instant ms in tz.
export function localDate(ms: number = Date.now(), tz = 'UTC'): string {
  if (!isValidTimeZone(tz)) throw zoneError(tz);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// "YYYY-MM-DD HH:MM" wall time of the UTC ISO instant in tz. Unparseable input (legacy free text) comes back as is.
export function formatLocal(iso: string, tz = 'UTC'): string {
  if (!isValidTimeZone(tz)) throw zoneError(tz);
  if (Number.isNaN(Date.parse(iso))) return iso;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
}

const WITH_OFFSET = /(?:Z|[+-]\d{2}:\d{2})$/i;
const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const HINT = 'Use ISO 8601, e.g. 2026-10-20T10:00+02:00, or a wall time with tz.';

// UTC ISO string for an ISO time with an offset, or for a wall time read in tz.
export function toUtcIso(value: unknown, tz = 'UTC'): string {
  const s = String(value ?? '').trim();
  if (WITH_OFFSET.test(s)) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) throw new ToolError(`Cannot parse time "${value}". ${HINT}`);
    return new Date(ms).toISOString();
  }
  const m = WALL.exec(s);
  if (!m) throw new ToolError(`Cannot parse time "${value}". ${HINT}`);
  if (!isValidTimeZone(tz)) throw zoneError(tz);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0] = groups(m);
  if (!validWall(y, mo, d, h, mi, sec)) throw new ToolError(`Cannot parse time "${value}": no such date or time. ${HINT}`);
  return new Date(wallToUtc(y, mo, d, h, mi, sec, tz)).toISOString();
}

const EXPLICIT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;

// UTC ISO string for a time that states its own offset, for events that name when they happened. Unlike toUtcIso, a
// wall time is refused rather than read in the user's zone: the offset is what says when it really was.
export function explicitUtcIso(value: unknown, field: string): string {
  const s = String(value ?? '').trim();
  const m = EXPLICIT.exec(s);
  const hint = `${field} must be an ISO 8601 date and time with an explicit offset, e.g. 2026-10-01T09:00:00Z or 2026-10-01T11:00:00+02:00`;
  if (!m) throw new ToolError(`${hint}; got "${s}".`);
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, sec = 0] = groups(m);
  if (!validWall(y, mo, d, h, mi, sec) || Number(m[8] ?? 0) > 23 || Number(m[9] ?? 0) > 59) throw new ToolError(`${field} is not a real date and time: "${s}".`);
  const ms = Date.parse(s.toUpperCase());
  if (Number.isNaN(ms)) throw new ToolError(`${hint}; got "${s}".`);
  return new Date(ms).toISOString();
}
