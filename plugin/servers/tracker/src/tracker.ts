// Domain logic behind the tracker tools. Every write goes through here; nothing else touches the DB.

import { basename, resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementResultingChanges } from 'node:sqlite';
import type { ConfigSections, Profile, SectionName } from './config.ts';
import { DEFAULTS, describeSection, SECTION_NAMES, validateSection } from './config.ts';
import type { CvRecord } from './cv.ts';
import { checkCvFile, copyCv, cvFileState, sha256File } from './cv.ts';
import type { ArtifactRow, CompanyRow, EventRow, InterviewRow, RoleLinkRow, RolePostingRow, RoleRow, RoleUrlRow, RuleRow, RuleTypeRow, RunRow, SourceCheckpointRow, SourceRow } from './db.ts';
import { now, readTx, tx } from './db.ts';
import { ToolError } from './errors.ts';
import type { ExternalIdentity } from './external.ts';
import { externalIdentity, FUTURE_SKEW_MS, occurrenceTime, requireKey, requireSameFields } from './external.ts';
import { atsFromUrl, nameScore, normalizeDomain, normalizeName } from './fuzzy.ts';
import type { LintResult } from './lint.ts';
import { lintProse } from './lint.ts';
import { checkPay } from './pay.ts';
import type { PostingIdentity, PostingKey } from './posting.ts';
import { parsePostingUrl, urlIdentity } from './posting.ts';
import type { RuleListItem, RuleType } from './rules.ts';
import { assertFreshDetailRevision, assertFreshRevision, decodeDetailCursor, decodeRuleCursor, detailChunk, detailRevisionMismatch, encodeRuleCursor, normalizeDetailLimit, normalizeRuleLimit, normalizeRuleTypes, packRulePage, RULE_TYPES, resolveRuleFilters } from './rules.ts';
import { dayBounds, explicitUtcIso, isValidTimeZone, toUtcIso, zoneError } from './time.ts';
import type { ArgsFor } from './tools.ts';
import { isRecord, oneOf, parseJson } from './util.ts';

export { ToolError };

const COVERAGES = ['complete', 'partial', 'unavailable'] as const;
type Coverage = (typeof COVERAGES)[number];

// Every database has the rule_state row from migration 5 on, so a missing one is damage, not something the model can fix.
const MISSING_RULE_STATE = 'The rule_state row is missing from the tracker database; rule changes cannot be tracked.';

export interface GateResult {
  ok: boolean;
  problems: string[];
  role_id?: number;
  company?: string;
  title?: string;
  url?: string;
  verified?: boolean;
  dedupe_clean?: boolean;
  no_cold_apply?: boolean;
  live_elsewhere?: boolean;
  previous_application?: boolean;
  matched_role_id?: number;
}

export const STATUSES = ['found', 'verified', 'scored', 'queued', 'applied', 'interviewing', 'offer', 'dropped', 'closed'] as const;
export const LIVE = ['applied', 'interviewing', 'offer'] as const;
export const OUTCOMES = ['rejected', 'withdrawn', 'role_closed'] as const;
export type Status = (typeof STATUSES)[number];
export type LiveStatus = (typeof LIVE)[number];
export type Outcome = (typeof OUTCOMES)[number];
const PROSE_KINDS = ['cover_note', 'form_answers', 'gmail_draft'];
const DOCUMENTS = ['profile', 'stories', 'reusable-answers', 'voice'];
const ROLE_FIELDS = ['title', 'url', 'ats', 'location_line', 'location_type', 'comp_min', 'comp_max', 'comp_currency', 'comp_period', 'equity', 'stack', 'industry', 'source', 'posted_at'] as const;

// A company with its aliases parsed.
export type Company = Omit<CompanyRow, 'aliases'> & { aliases: string[] };

// What insertEvent writes. Defaults to null for every optional column, ts to now.
export interface EventInput {
  role_id: number;
  status?: string | null;
  outcome?: string | null;
  category?: string | null;
  question?: string | null;
  blocked_by?: string | null;
  actor: string;
  reason: string;
  evidence?: string | null;
  run_id?: number | null;
  // When it happened. Defaults to now; an event from outside carries the time its source gives.
  ts?: string;
  // An event from a mailbox or board: which source and account, the source's own id for it, and when it reached us.
  source?: string | null;
  source_account?: string | null;
  source_id?: string | null;
  received_at?: string;
}

// What a repeated external event must repeat. Every EventInput field is decided here, so adding one forces a choice
// between 'compare' (a difference is a conflict) and 'ignore' (it may differ between a first call and its retry).
const EVENT_REPEAT = {
  actor: 'compare',
  status: 'compare',
  outcome: 'compare',
  category: 'compare',
  question: 'compare',
  blocked_by: 'compare',
  evidence: 'compare',
  ts: 'compare', // the occurrence time, called occurred_at by the caller
  role_id: 'ignore', // checked on its own, as the canonical role, so an alias id is the same role
  reason: 'ignore', // prose, reworded on a retry
  run_id: 'ignore', // which run saw it
  received_at: 'ignore', // when it reached the tracker
  source: 'ignore', // the key the earlier row was found by
  source_account: 'ignore',
  source_id: 'ignore',
} as const satisfies Record<keyof EventInput, 'compare' | 'ignore'>;
const REPEATED = (Object.keys(EVENT_REPEAT) as (keyof EventInput)[]).filter((k) => EVENT_REPEAT[k] === 'compare');

export const INTERVIEW_STATES = ['pending', 'scheduled', 'cancelled'] as const;

// The interview columns an update may change, and what is kept of them in the change history.
type InterviewValues = Pick<InterviewRow, 'starts_at' | 'tz' | 'stage' | 'people' | 'link' | 'booked_by' | 'notes' | 'state'>;

// Every interview column is decided here, so adding one forces a choice between 'compare' (a difference is a change to
// apply and keep) and 'ignore' (bookkeeping that differs between a call and its retry).
const INTERVIEW_REPEAT = {
  starts_at: 'compare',
  tz: 'compare',
  stage: 'compare',
  people: 'compare',
  link: 'compare',
  booked_by: 'compare',
  notes: 'compare',
  state: 'compare',
  id: 'ignore',
  role_id: 'ignore', // checked on its own, as the canonical role
  created_at: 'ignore',
  updated_at: 'ignore',
  source: 'ignore', // the key the row is found by
  source_account: 'ignore',
  source_id: 'ignore',
  last_occurred_at: 'ignore', // the order of updates, checked on its own
} as const satisfies Record<keyof InterviewRow, 'compare' | 'ignore'>;
const INTERVIEW_VALUES = (Object.keys(INTERVIEW_REPEAT) as (keyof InterviewRow)[]).filter((k): k is keyof InterviewValues => INTERVIEW_REPEAT[k] === 'compare');
// The calendar event or message an interview was recorded from.
type InterviewKey = Pick<InterviewRow, 'source' | 'source_account' | 'source_id'>;
type LoggedInterview = InterviewValues & InterviewKey;
// When a call's change happened (ts), when the tracker heard of it, and the run that saw it.
interface InterviewTiming {
  ts: string;
  received: string;
  run_id: number | null;
}

// Where an update with an occurrence time stands among those already applied to its interview: older (ignored), the
// same time (a repeat) or newer. A call without one (a hand edit), or an interview with no dated update yet, has no
// order and is newer.
function orderOf(known: InterviewRow | undefined, occurred: string | null, ts: string): 'older' | 'same' | 'newer' {
  const newest = occurred ? known?.last_occurred_at : null;
  if (!newest) return 'newer';
  return ts < newest ? 'older' : ts === newest ? 'same' : 'newer';
}

// What a change did to an interview, in a few words for the role note.
function describeInterviewChange(before: InterviewValues | null, after: InterviewValues): string {
  if (!before) return { pending: 'added, still to book', scheduled: `booked for ${after.starts_at}`, cancelled: 'recorded as cancelled' }[after.state];
  if (after.state === 'cancelled' && before.state !== 'cancelled') return 'cancelled';
  if (after.state === 'scheduled' && before.state === 'scheduled' && after.starts_at !== before.starts_at) return `rescheduled from ${before.starts_at} to ${after.starts_at}`;
  if (after.state !== before.state) return `now ${after.state}${after.starts_at ? ` for ${after.starts_at}` : ''}`;
  return `updated (${INTERVIEW_VALUES.filter((k) => before[k] !== after[k]).join(', ')})`;
}

// What add_interview returns: which interview, whether this call created or changed it, or was ignored as older.
const interviewResult = (interview_id: number, state: InterviewRow['state'], flags: { created?: true; updated?: true; stale?: true } = {}) => ({ interview_id, created: false, updated: false, stale: false, ...flags, state });
const interviewSnapshot = (row: InterviewValues): InterviewValues => Object.fromEntries(INTERVIEW_VALUES.map((k) => [k, row[k] ?? null])) as InterviewValues;

// What scope() returns: the run if any, and SQL conditions as [sql, params].
// window(col): col lies in the covered time window. rows(alias, tsCol): rows tagged with the run, or in the window.
export interface Scope {
  run: RunRow | undefined;
  window: (col: string) => [string, SQLInputValue[]];
  rows: (alias: string, tsCol: string) => [string, SQLInputValue[]];
}

type RoleSummary = Pick<RoleRow, 'id' | 'title' | 'url' | 'status' | 'updated_at'>;

// Allowed moves (spec §5.4). Self-transitions are allowed so a step can be re-run with new evidence.
export const MACHINE: Record<Status, readonly Status[]> = {
  found: ['verified', 'dropped'],
  verified: ['scored', 'dropped'],
  scored: ['queued', 'dropped'],
  queued: ['applied', 'dropped', 'closed'],
  applied: ['interviewing', 'offer', 'closed'],
  interviewing: ['offer', 'closed'],
  offer: ['closed'],
  dropped: [],
  closed: [],
};

// The statuses the board shows as lanes. Between them the user moves freely, back and out of dropped or closed:
// the user is the authority on their own search. found and verified are the sweep's own steps.
export const BOARD_LANES = ['scored', 'queued', 'applied', 'interviewing', 'offer', 'dropped', 'closed'] as const;
// Lanes that rest on Claude's research: a role gets there from the board only if it was verified and scored.
const RESEARCHED: readonly Status[] = ['scored', 'queued'];

// Where the user may move a role on the board, and why not when nowhere.
export function userMoves(role: Pick<RoleRow, 'status' | 'verified_at' | 'score'>): { moves: Status[]; why?: string } {
  const from = role.status || 'found';
  if (!oneOf(BOARD_LANES, from)) return { moves: [], why: `is still in the sweep (${from}): Claude verifies and scores it first` };
  const researched = role.verified_at != null && role.score != null;
  return { moves: BOARD_LANES.filter((s) => s !== from && (researched || !RESEARCHED.includes(s))) };
}

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ToolError(msg);
}
const marks = (ids: readonly unknown[]) => ids.map(() => '?').join(', ');
const day = (iso: string | null | undefined) => String(iso || '').slice(0, 10);

const companyAliases = (aliases: string[] | null | undefined, url: string | null | undefined): string[] => {
  const { slug } = atsFromUrl(url);
  return [...(aliases ?? []), ...(slug ? [slug] : [])];
};

type ClaimedUrl = PostingIdentity & { url: string };
// What upsertRole will update: a known role, or a new one at company.
type Target = { role: RoleRow } | { role: undefined; company: string };

// The role's own URL first, then its aliases, each validated. A lookup tolerates a bad URL but a write must not:
// what is stored here decides which history a later lead joins.
function claimedUrls(f: ArgsFor<'upsert_role'>): ClaimedUrl[] {
  const aliases: readonly unknown[] = f.url_aliases ?? [];
  for (const [i, a] of aliases.entries()) req(typeof a === 'string' && a.trim(), `url_aliases[${i}] must be a URL string.`);
  req(!aliases.length || f.identity_evidence?.trim(), 'url_aliases need identity_evidence: say how you confirmed the listings are one posting, e.g. the card links to the ATS page.');
  return [...(f.url ? [f.url] : []), ...(f.url_aliases ?? [])].map((url) => ({ url, ...parsePostingUrl(url) }));
}

// SQL fragments for consumers that show one card per linked group. col is a role id column.
// isCard: the role is not a linked duplicate. groupOf: the ids of a canonical role's group, for `x IN groupOf(...)`.
// canonicalOf: the card a role's rows are attributed to.
export const isCard = (col: string) => `${col} NOT IN (SELECT duplicate_role_id FROM role_links)`;
export const groupOf = (col: string) => `(SELECT ${col} UNION ALL SELECT duplicate_role_id FROM role_links WHERE canonical_role_id = ${col})`;
export const canonicalOf = (col: string) => `COALESCE((SELECT canonical_role_id FROM role_links WHERE duplicate_role_id = ${col}), ${col})`;

// Statuses that record what happened with the employer. Everything before them is the sweep's own preparation,
// including a drop before any application.
const AUTHORITATIVE: readonly Status[] = ['applied', 'interviewing', 'offer', 'closed'];
type StatusEvent = Pick<EventRow, 'id' | 'role_id' | 'ts' | 'status' | 'outcome' | 'actor' | 'source'>;
const statusInstant = (ts: string) => (Number.isNaN(Date.parse(ts)) ? Number.NEGATIVE_INFINITY : Date.parse(ts));
const orderStatusEvents = (a: StatusEvent, b: StatusEvent) => statusInstant(a.ts) - statusInstant(b.ts) || a.id - b.id;

// Only the first inserted, unsourced pipeline discovery is bookkeeping; later found events are decisions.
function substantiveStatusEvents(events: readonly StatusEvent[]): StatusEvent[] {
  const first = new Map<number, StatusEvent>();
  for (const event of events) {
    const known = first.get(event.role_id);
    if (!known || event.id < known.id) first.set(event.role_id, event);
  }
  return events.filter((event) => !(first.get(event.role_id)?.id === event.id && event.status === 'found' && event.actor === 'pipeline' && event.source === null)).sort(orderStatusEvents);
}

const stateLabel = (e: Pick<StatusEvent, 'status' | 'outcome'>) => (e.status === 'closed' ? `closed (${e.outcome ?? 'no outcome'})` : String(e.status));
const hasEmployerHistory = (evs: readonly StatusEvent[]) => evs.some((e) => oneOf(AUTHORITATIVE, e.status));
// Events that show the user already applied to a posting. A rejection or withdrawal ends an application, so either
// counts even when no applied event was imported with it. A closed posting (role_closed) alone does not.
// Not AUTHORITATIVE: that set decides whether two histories may be linked, and counts any closed outcome, since a
// posting that closed is still something the employer did. This one decides whether applying again is allowed.
const APPLIED_SQL = "(status IN ('applied', 'interviewing', 'offer') OR (status = 'closed' AND outcome IN ('rejected', 'withdrawn')))";

// Whether a duplicate's history can sit under the canonical role's card without hiding what happened. Each side is
// a root id and its group's status events, oldest first. Nothing here ranks states: the canonical role must already
// show the latest state itself, and the normal evidence-backed workflow corrects it first when it does not.
function checkHistories(canonical: { id: number; status: RoleRow['status']; events: StatusEvent[] }, duplicate: { id: number; status: RoleRow['status']; events: StatusEvent[] }): void {
  const canonicalSubstantive = substantiveStatusEvents(canonical.events);
  const duplicateSubstantive = substantiveStatusEvents(duplicate.events);
  const c = canonicalSubstantive.at(-1) ?? canonical.events.at(-1);
  const d = duplicateSubstantive.at(-1) ?? duplicate.events.at(-1);
  for (const [root, claimed] of [[canonical, c], [duplicate, d]] as const) {
    req(!claimed || claimed.status === root.status, `Roles ${canonical.id} (actual ${canonical.status ?? 'no status'}) and ${duplicate.id} (actual ${duplicate.status ?? 'no status'}) need reconciliation: role ${root.id}'s latest evidence claims ${claimed ? stateLabel(claimed) : 'no status'}. Nothing was written. Reconcile with transition or record, or choose a canonical card that already holds the state.`);
  }
  // Discovery timestamps describe bookkeeping order, not competing decisions about the posting.
  if (!canonicalSubstantive.length && !duplicateSubstantive.length) {
    req(canonical.status === duplicate.status, `The actual card statuses disagree: role ${canonical.id} is ${canonical.status ?? 'no status'} and role ${duplicate.id} is ${duplicate.status ?? 'no status'}. Nothing was written. Reconcile the cards before linking.`);
    return;
  }
  const canonicalHistory = hasEmployerHistory(canonical.events);
  const duplicateHistory = hasEmployerHistory(duplicate.events);
  // No status on the duplicate, or preparation only under a role that went further: nothing the employer did is hidden.
  if (!d) return;
  if (canonicalHistory && !duplicateHistory) return;
  if (duplicateHistory) {
    req(c && canonicalHistory, `Role ${duplicate.id} is ${stateLabel(d)}, but role ${canonical.id} has no application history. Nothing was written. Record that state on role ${canonical.id} first (transition or record, with its evidence), or link role ${canonical.id} into role ${duplicate.id}.`);
    req(canonical.status === duplicate.status && c.status === d.status && (c.outcome ?? null) === (d.outcome ?? null), `The histories disagree: role ${canonical.id} is ${stateLabel(c)} and role ${duplicate.id} is ${stateLabel(d)}. Nothing was written. Linking would hide one of them; correct the wrong one with transition or record first.`);
  }
  // Every substantive status counts, including a later move back to queued or dropped.
  req(c && statusInstant(c.ts) >= statusInstant(d.ts), `Role ${duplicate.id} became ${stateLabel(d)} on ${d.ts}, after role ${canonical.id} (${c?.ts ?? 'no status yet'}). Nothing was written. The canonical role must hold the latest state: link role ${canonical.id} into role ${duplicate.id} instead, or record the state on role ${canonical.id} first.`);
}

const keyLabel = (k: PostingKey) => `${k.provider} ${k.employer_key}/${k.posting_id}`;

// Two posting IDs on one employer's board are two requisitions, whatever the titles say, so no role may hold both.
// A key on another ATS or board can be the same job after an employer moves ATS, which only evidence can show.
function checkPostingKeys(held: readonly PostingKey[], claimed: readonly PostingKey[], evidenced: boolean): void {
  const known = [...held];
  for (const k of claimed) {
    if (known.some((h) => keyLabel(h) === keyLabel(k))) continue;
    for (const h of known) {
      req(h.provider !== k.provider || h.employer_key !== k.employer_key, `${keyLabel(h)} and ${keyLabel(k)} are different postings, so one role cannot hold both. Nothing was written. Track the other one as its own role (upsert_role without id).`);
      req(evidenced, `${keyLabel(k)} is on another ATS or employer board than ${keyLabel(h)}. Nothing was written. If the employer moved the posting, pass identity_evidence saying how you confirmed it is the same job; otherwise track it as its own role.`);
    }
    known.push(k);
  }
}

// Whether a URL seen for a known role becomes its main one. gate_check returns that URL and the submit gate binds
// approval to it, so an ATS link always beats a listing that only points at the job, in either order. Between two
// links of the same kind only an explicit update by id moves it: an old link seen again is not a refresh.
function takesPrimary(current: string | null, incoming: PostingIdentity, explicit: boolean): boolean {
  if (!current) return true;
  const held = urlIdentity(current);
  if (held.normalized_url === incoming.normalized_url) return false;
  if (!held.posting !== !incoming.posting) return !!incoming.posting;
  return explicit;
}

// Matches a rule with any of these types, or with no type rows at all (written before types existed, so global).
// EXISTS cannot repeat a rule that has several matching types. One `?` per type.
function typeFilterSql(matched: readonly RuleType[]): string {
  const hasRows = 'SELECT 1 FROM rule_types rt WHERE rt.rule_id = rules.id';
  return `(EXISTS (${hasRows} AND rt.type IN (${matched.map(() => '?').join(',')})) OR NOT EXISTS (${hasRows}))`;
}

export class Tracker {
  db: DatabaseSync;
  dbPath: string | null;

  constructor(db: DatabaseSync, { dbPath = null }: { dbPath?: string | null } = {}) {
    this.db = db;
    this.dbPath = dbPath;
  }

  // Row types are declared by the caller; node:sqlite returns untyped records.
  q<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
    return this.db.prepare(sql).run(...params);
  }

  // ---------- profile and documents ----------

  getProfile(): Profile {
    const out: Record<string, unknown> = {};
    for (const section of SECTION_NAMES) {
      const row = this.one<{ value: string }>('SELECT value FROM profile WHERE key = ?', section);
      const defaults = DEFAULTS[section];
      out[section] = row ? parseJson(row.value, {}) : defaults ? { ...defaults } : null;
    }
    // Capabilities saved by an older version may carry the retired `tracker` field, which save_config rejects.
    if (isRecord(out.capabilities)) delete out.capabilities.tracker;
    // accounts.recruiter_email was renamed to job_inbox_email (the user's own inbox that recruiters write to).
    if (isRecord(out.accounts) && 'recruiter_email' in out.accounts) {
      const { recruiter_email, ...rest } = out.accounts;
      out.accounts = { job_inbox_email: recruiter_email, ...rest };
    }
    // Sections saved with save_config passed validateSection; capabilities from start_run did not, and the rest are DEFAULTS or null.
    return out as Profile;
  }

  section<K extends SectionName>(name: K): Partial<ConfigSections[K]> {
    return this.getProfile()[name] || {};
  }

  // The user's IANA timezone (filters.timezone), UTC if unset or invalid.
  timezone(): string {
    const tz = this.section('filters').timezone;
    return isValidTimeZone(tz) ? tz : 'UTC';
  }

  // Rows a report covers. With run_id (wins over date): rows tagged with the run, plus untagged rows written
  // during it (inbox outcomes, hook writes); the window is closed, [started_at, finished_at or now].
  // Otherwise: the local day `date` in the user's timezone, half-open [start, end).
  scope({ date, run_id }: { date?: string | null; run_id?: number | null } = {}): Scope {
    let run: RunRow | undefined;
    let from: string;
    let to: string;
    let end: '<' | '<=';
    if (run_id != null) {
      run = this.one<RunRow>('SELECT * FROM runs WHERE id = ?', run_id);
      req(run, `No run ${run_id}`);
      from = run.started_at;
      to = run.finished_at || now();
      end = '<=';
    } else {
      req(date, 'Pass date or run_id');
      [from, to] = dayBounds(date, this.timezone());
      run = this.one<RunRow>('SELECT * FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY id DESC LIMIT 1', from, to);
      end = '<';
    }
    const window = (col: string): [string, SQLInputValue[]] => [`${col} >= ? AND ${col} ${end} ?`, [from, to]];
    const rows = (a: string, col: string): [string, SQLInputValue[]] => {
      const [cond, p] = window(`${a}.${col}`);
      return run_id != null ? [`(${a}.run_id = ? OR (${a}.run_id IS NULL AND ${cond}))`, [run_id, ...p]] : [`(${cond})`, p];
    };
    return { run, window, rows };
  }

  saveConfig({ section, data }: ArgsFor<'save_config'>) {
    const defaults = oneOf(SECTION_NAMES, section) ? DEFAULTS[section] : undefined;
    const merged = section === 'capabilities' ? data : { ...(defaults || {}), ...data };
    const errors = validateSection(section, merged);
    if (errors.length) {
      const shape = oneOf(SECTION_NAMES, section) ? `\nExpected ${describeSection(section)}` : '';
      throw new ToolError(`Invalid config:\n- ${errors.join('\n- ')}${shape}`);
    }
    this.run('INSERT INTO profile(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', section, JSON.stringify(merged));
    return { saved: section, value: merged };
  }

  getDocument({ name }: ArgsFor<'get_document'>) {
    req(DOCUMENTS.includes(name), `Unknown document "${name}". Known: ${DOCUMENTS.join(', ')}`);
    const row = this.one<{ content: string; updated_at: string }>('SELECT content, updated_at FROM documents WHERE name = ?', name);
    return row ? { name, content: row.content, updated_at: row.updated_at } : { name, content: null, missing: true };
  }

  saveDocument({ name, content }: ArgsFor<'save_document'>) {
    req(DOCUMENTS.includes(name), `Unknown document "${name}". Known: ${DOCUMENTS.join(', ')}`);
    req(typeof content === 'string' && content.trim(), 'content is required');
    this.run('INSERT INTO documents(name, content, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at', name, content, now());
    return { saved: name, chars: content.length };
  }

  // ---------- CV file ----------

  saveCv({ path, copy }: ArgsFor<'save_cv'>) {
    const bytes = checkCvFile(path);
    const stored = copy ? copyCv(path, this.dbPath) : resolve(path);
    const cv: CvRecord = { path: stored, mode: copy ? 'copied' : 'linked', sha256: sha256File(stored), bytes, saved_at: now() };
    this.run("INSERT INTO profile(key, value) VALUES('cv', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(cv));
    return { path: cv.path, mode: cv.mode, bytes };
  }

  getCv() {
    const cv = parseJson<CvRecord | null>(this.one<{ value: string }>("SELECT value FROM profile WHERE key = 'cv'")?.value, null);
    if (!cv) return { missing: true as const };
    return { path: cv.path, mode: cv.mode, ...cvFileState(cv), saved_at: cv.saved_at };
  }

  // ---------- setup and runs ----------

  setupStatus() {
    const p = this.getProfile();
    const saved = new Set(this.q<{ key: string }>('SELECT key FROM profile').map((r) => r.key));
    const docs = new Set(this.q<{ name: string }>('SELECT name FROM documents').map((r) => r.name));
    const decisions = parseJson<Record<string, string>>(this.one<{ value: string }>("SELECT value FROM profile WHERE key = '_decisions'")?.value, {});
    const items: { key: string; state: 'green' | 'amber' | 'red'; detail: string; decision: string | undefined }[] = [];
    const add = (key: string, state: 'green' | 'amber' | 'red', detail: string) => items.push({ key, state: decisions[key] && state !== 'green' ? 'amber' : state, detail, decision: decisions[key] || undefined });
    add('profile_document', docs.has('profile') ? 'green' : 'red', docs.has('profile') ? 'profile.md saved' : 'Import a CV and save the profile document (with a stack line per role).');
    const cv = this.getCv();
    if ('missing' in cv) add('cv_file', 'red', 'Save the CV file: drop it into the chat, or give its path.');
    else if (!cv.exists) add('cv_file', 'red', `The CV at ${cv.path} is gone. Save it again.`);
    else if (cv.changed_since_saved) add('cv_file', 'amber', 'The CV changed since it was saved. Re-import the profile, then save the CV again.');
    else add('cv_file', 'green', `CV file: ${basename(cv.path)} (${cv.mode})`);
    add('filters', saved.has('filters') ? 'green' : 'red', saved.has('filters') ? 'Hard filters saved' : 'Hard filters not set.');
    add('prefs', saved.has('prefs') ? 'green' : 'amber', saved.has('prefs') ? 'Soft preferences saved' : 'Soft preferences not set; scoring will be coarse.');
    add('writing', saved.has('writing') ? 'green' : 'amber', saved.has('writing') ? 'Writing rules saved' : 'Using default writing rules.');
    const acc = p.accounts;
    if (!saved.has('accounts')) add('accounts', 'red', 'Which inbox do recruiters use, and which calendar do invites land on?');
    else if (acc?.connected_calendar && acc.invite_calendar && acc.connected_calendar !== acc.invite_calendar)
      add('accounts', 'amber', `Invites land on "${acc.invite_calendar}" but the connected calendar is "${acc.connected_calendar}".`);
    else add('accounts', 'green', 'Inbox and calendar accounts recorded');
    const caps = p.capabilities || {};
    const conn = caps.connectors || {};
    add('connectors', conn.gmail && conn.calendar ? 'green' : saved.has('capabilities') ? 'amber' : 'red',
      saved.has('capabilities') ? `gmail: ${!!conn.gmail}, calendar: ${!!conn.calendar}, linkedin: ${!!conn.linkedin}` : 'No capability detection recorded yet.');
    add('browser', caps.browser ? 'green' : 'amber', caps.browser ? `Browser: ${caps.browser}` : 'No browser detected. Browser sources and applying are queued for interactive sessions.');
    const noBoards = (p.sources?.enabled || []).includes('ats_boards') && !(p.sources?.boards || []).length;
    if (!saved.has('sources')) add('sources', 'amber', 'No sources chosen; defaults will be used.');
    else if (noBoards) add('sources', 'amber', 'ats_boards is enabled but sources.boards is empty, so it has nothing to fetch. Ask for employer job board URLs, or disable ats_boards.');
    else add('sources', 'green', `${(p.sources?.enabled || []).length} sources enabled`);
    add('autonomy', saved.has('autonomy') ? 'green' : 'amber', `Unattended: ${(p.autonomy?.unattended || []).join(', ')}`);
    add('schedule', saved.has('schedule') ? 'green' : 'red', saved.has('schedule') ? `Daily: ${JSON.stringify(p.schedule?.daily || {})}` : 'No daily task scheduled.');
    add('stories', docs.has('stories') ? 'green' : 'amber', docs.has('stories') ? 'stories.md saved' : 'No interview stories yet (needed for /prep).');
    const rules = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM rules WHERE active = 1')?.n ?? 0;
    add('calibration', rules > 0 || decisions.calibration ? 'green' : 'amber', rules > 0 ? `${rules} active rules` : 'Calibration run not done yet.');
    const all_green = items.every((i) => i.state === 'green' || i.decision);
    return { db_path: this.dbPath, items, all_green };
  }

  recordDecision({ key, decision }: ArgsFor<'record_setup_decision'>) {
    const cur = parseJson<Record<string, string>>(this.one<{ value: string }>("SELECT value FROM profile WHERE key = '_decisions'")?.value, {});
    cur[key] = decision;
    this.run("INSERT INTO profile(key, value) VALUES('_decisions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(cur));
    return { recorded: key };
  }

  startRun({ kind, capabilities }: ArgsFor<'start_run'>) {
    req(kind, 'kind is required');
    const caps = { ...(capabilities || {}), detected_at: now() };
    const r = this.run('INSERT INTO runs(kind, started_at, capabilities) VALUES(?, ?, ?)', kind, now(), JSON.stringify(caps));
    if (capabilities) {
      this.run("INSERT INTO profile(key, value) VALUES('capabilities', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(caps));
    }
    return { run_id: Number(r.lastInsertRowid), capabilities: caps };
  }

  finishRun({ run_id, summary }: ArgsFor<'finish_run'>) {
    const r = this.run('UPDATE runs SET finished_at = ?, summary = ? WHERE id = ?', now(), summary || null, run_id);
    req(r.changes, `No run ${run_id}`);
    return { finished: run_id };
  }

  // ---------- companies and dedupe ----------

  companyRow(id: number): Company | undefined {
    const c = this.one<CompanyRow>('SELECT * FROM companies WHERE id = ?', id);
    return c ? { ...c, aliases: parseJson<string[]>(c.aliases, []) } : undefined;
  }

  // For ids that must exist (foreign keys, rows just written).
  mustCompany(id: number): Company {
    const c = this.companyRow(id);
    req(c, `No company ${id}`);
    return c;
  }

  findCompany({ name, domain, url }: ArgsFor<'find_company'>) {
    req(name || domain || url, 'Pass name, domain or url');
    const dom = normalizeDomain(domain);
    const slug = atsFromUrl(url).slug;
    const exact_role_ids = url ? this.exactGroups(urlIdentity(url)) : [];
    const exact = exact_role_ids.map((id) => this.mustRole(id));
    const exactCompanies = new Set(exact.map((r) => r.company_id));
    const matches: { c: CompanyRow; score: number }[] = [];
    for (const c of this.q<CompanyRow>('SELECT * FROM companies')) {
      const aliases = parseJson<string[]>(c.aliases, []);
      let score = name ? nameScore(name, [c.name, ...aliases]) : 0;
      if (dom && c.domain && normalizeDomain(c.domain) === dom) score = 1;
      if (slug && aliases.map((a) => String(a).toLowerCase()).includes(slug)) score = Math.max(score, 1);
      if (exactCompanies.has(c.id)) score = 1;
      if (score >= 0.8) matches.push({ c, score });
    }
    // The company holding the posting comes first, so the cut to five and upsertCompany's pick cannot miss it.
    matches.sort((a, b) => Number(exactCompanies.has(b.c.id)) - Number(exactCompanies.has(a.c.id)) || b.score - a.score);
    const out = matches.slice(0, 5).map(({ c, score }) => ({
      company: { id: c.id, name: c.name, aliases: parseJson<string[]>(c.aliases, []), domain: c.domain, no_cold_apply: !!c.no_cold_apply, no_cold_apply_reason: c.no_cold_apply_reason },
      score: Math.round(score * 100) / 100,
      certain: score >= 1,
      // One card per linked group, so a duplicate's stale status is never read as a process of its own.
      roles: this.q<RoleSummary>(`SELECT id, title, url, status, updated_at FROM roles r WHERE company_id = ? AND ${isCard('r.id')} ORDER BY updated_at DESC`, c.id),
    }));
    const certain = out.filter((m) => m.certain);
    const pool = certain.length ? certain : out;
    const no_cold_apply = pool.some((m) => m.company.no_cold_apply);
    const live = pool.flatMap((m) => m.roles.filter((r) => oneOf(LIVE, r.status)));
    let verdict: 'new' | 'seen' | 'skip' = 'new';
    let why = 'No match on name, aliases, domain or ATS slug.';
    if (out.length) {
      verdict = 'seen';
      const first = certain[0];
      why = first ? `Known company: ${first.company.name}.` : `Possible match: ${out.map((m) => `${m.company.name} (${m.score})`).join(', ')}. Confirm before treating as new.`;
    }
    const [same, ...others] = exact;
    if (same) {
      verdict = 'skip';
      why = others.length ? `This posting matches roles ${exact_role_ids.join(', ')}. Check them with get_role before treating it as anything else.` : `This posting is already tracked as role ${same.id} (${same.status}).`;
    }
    if (live.length && certain.length) {
      verdict = 'skip';
      why = `Live application at this company: ${live.map((r) => `${r.title} (${r.status})`).join('; ')}.`;
    }
    if (no_cold_apply) {
      verdict = 'skip';
      why = `no_cold_apply: ${pool.find((m) => m.company.no_cold_apply)?.company.no_cold_apply_reason || 'intro or recruiter process open'}.`;
    }
    return { verdict, why, live_application: live.length > 0, no_cold_apply, matches: out, exact_role_ids };
  }

  mergeCompany(c: Company, aliases: string[], domain?: string | null): Company {
    const merged = [...new Set([...c.aliases, ...aliases].filter((a) => a && normalizeName(a) !== normalizeName(c.name)))];
    this.run('UPDATE companies SET aliases = ?, domain = COALESCE(domain, ?) WHERE id = ?', JSON.stringify(merged), domain ? normalizeDomain(domain) : null, c.id);
    return this.mustCompany(c.id);
  }

  upsertCompany({ name, aliases, domain, url }: { name: string; aliases?: string[] | null; domain?: string | null; url?: string | null }) {
    const allAliases = companyAliases(aliases, url);
    const found = this.findCompany({ name, domain, url });
    const hit = found.matches.find((m) => m.certain);
    if (hit) return { company: this.mergeCompany(this.mustCompany(hit.company.id), allAliases, domain), created: false };
    const r = this.run('INSERT INTO companies(name, aliases, domain, created_at) VALUES(?, ?, ?, ?)', name, JSON.stringify([...new Set(allAliases)]), domain ? normalizeDomain(domain) : null, now());
    return { company: this.mustCompany(Number(r.lastInsertRowid)), created: true, possible_matches: found.matches };
  }

  setNoColdApply({ company_id, on = true, reason }: ArgsFor<'set_no_cold_apply'>) {
    req(!on || reason, 'reason is required when setting no_cold_apply');
    const r = this.run('UPDATE companies SET no_cold_apply = ?, no_cold_apply_reason = ? WHERE id = ?', on ? 1 : 0, on ? (reason ?? null) : null, company_id);
    req(r.changes, `No company ${company_id}`);
    return { company: this.companyRow(company_id) };
  }

  addAlias({ company_id, alias }: ArgsFor<'add_alias'>) {
    const c = this.companyRow(company_id);
    req(c, `No company ${company_id}`);
    const aliases = [...new Set([...c.aliases, alias])];
    this.run('UPDATE companies SET aliases = ? WHERE id = ?', JSON.stringify(aliases), company_id);
    return { company: this.companyRow(company_id) };
  }

  // ---------- roles and events ----------

  roleRow(id: number): RoleRow | undefined {
    return this.one<RoleRow>('SELECT * FROM roles WHERE id = ?', id);
  }

  // For ids that must exist (foreign keys, rows just written).
  mustRole(id: number): RoleRow {
    const role = this.roleRow(id);
    req(role, `No role ${id}`);
    return role;
  }

  // Every role holding this exact URL or ATS posting, on any company. More than one is a conflict for the
  // caller to resolve: choosing one here could attach a new application to the wrong history.
  exactRoleIds({ normalized_url, posting }: PostingIdentity): number[] {
    return this.q<{ role_id: number }>(
      `SELECT role_id FROM role_urls WHERE normalized_url = ?
       UNION SELECT role_id FROM role_postings WHERE provider = ? AND employer_key = ? AND posting_id = ? ORDER BY role_id`,
      normalized_url, posting?.provider ?? null, posting?.employer_key ?? null, posting?.posting_id ?? null,
    ).map((r) => r.role_id);
  }

  // The canonical roles behind an exact match: rows of one linked group are one role, independent rows a conflict.
  exactGroups(identity: PostingIdentity): number[] {
    return [...new Set(this.exactRoleIds(identity).map((id) => this.canonicalRoleId(id)))].sort((a, b) => a - b);
  }

  // The canonical roles of every row that holds a URL or ATS posting of this group, the group's own root included.
  samePostingGroups(group: readonly number[]): number[] {
    return this.q<{ id: number }>(
      `SELECT DISTINCT ${canonicalOf('m.role_id')} AS id FROM (
         SELECT role_id FROM role_urls WHERE normalized_url IN (SELECT normalized_url FROM role_urls WHERE role_id IN (${marks(group)}))
         UNION SELECT p.role_id FROM role_postings p JOIN role_postings g ON g.provider = p.provider AND g.employer_key = p.employer_key AND g.posting_id = p.posting_id
         WHERE g.role_id IN (${marks(group)})
       ) m ORDER BY id`,
      ...group, ...group,
    ).map((r) => r.id);
  }

  // Internal, inside the caller's transaction. Records that a role answers to these URLs and the ATS postings
  // behind them. Accepts whatever is already stored or imported; upsertRole validates what callers send and refuses
  // collisions before it gets here. A URL the role already has keeps its first row, evidence included.
  indexRoleUrls(role_id: number, urls: readonly string[], evidence?: string): void {
    for (const url of urls) {
      const { normalized_url, posting } = urlIdentity(url);
      if (!normalized_url) continue;
      this.run('INSERT OR IGNORE INTO role_urls(role_id, url, normalized_url, evidence) VALUES(?, ?, ?, ?)', role_id, url, normalized_url, evidence ?? null);
      if (posting) this.run('INSERT OR IGNORE INTO role_postings(role_id, provider, employer_key, posting_id) VALUES(?, ?, ?, ?)', role_id, posting.provider, posting.employer_key, posting.posting_id);
    }
  }

  // Which existing role this call is about, or none for a new one. Reads only: everything that can refuse the call
  // is checked here or in checkPostingKeys, before anything is written.
  resolveTarget(f: ArgsFor<'upsert_role'>, claims: readonly ClaimedUrl[]): Target {
    const holders = claims.map((c) => this.exactRoleIds(c));
    if (f.id) {
      const role = this.cardRow(f.id);
      req(role, `No role ${f.id}`);
      // A role keeps what its group already holds, so an old duplicate can still be updated. Only a new claim can collide.
      const group = this.roleGroupIds(role.id);
      const taken = [...new Set(holders.filter((h) => !h.some((id) => group.includes(id))).flat())];
      req(!taken.length, `This URL belongs to role ${taken.join(', ')}, so it cannot be added to role ${role.id}. Nothing was written. Check them with get_role.`);
      return { role };
    }
    const matched = [...new Set(holders.flat().map((id) => this.canonicalRoleId(id)))].sort((a, b) => a - b);
    req(matched.length < 2, `This posting matches roles ${matched.join(', ')}. Nothing was written. Check them with get_role, then pass id to update one.`);
    const [hit] = matched;
    if (hit !== undefined) return { role: this.mustRole(hit) };
    req(f.company, 'company is required for a new role');
    return { role: undefined, company: f.company };
  }

  upsertRole(f: ArgsFor<'upsert_role'>) {
    req(f.title, 'title is required');
    const title = f.title;
    const claims = claimedUrls(f);
    return tx(this.db, () => {
      const target = this.resolveTarget(f, claims);
      const { role } = target;
      const held = role ? this.groupPostings(this.roleGroupIds(role.id)) : [];
      checkPostingKeys(held, claims.flatMap((c) => (c.posting ? [c.posting] : [])), !!f.identity_evidence?.trim());

      const lookup = { name: f.company, domain: f.company_domain, url: claims[0]?.url };
      const dedupe = f.id ? undefined : this.findCompany(lookup);
      let company: Company;
      let possible_role_ids: number[] = [];
      if (target.role) {
        company = this.mustCompany(target.role.company_id);
        // The posting says which company this is. A name that disagrees is a label from the listing, not a move.
        if (!f.id && f.company && nameScore(f.company, [company.name, ...company.aliases]) >= 1) company = this.mergeCompany(company, companyAliases(f.company_aliases, lookup.url), f.company_domain);
      } else {
        company = this.upsertCompany({ ...lookup, name: target.company, aliases: f.company_aliases }).company;
        const nt = normalizeName(title);
        possible_role_ids = this.q<Pick<RoleRow, 'id' | 'title'>>(`SELECT id, title FROM roles r WHERE company_id = ? AND ${isCard('r.id')}`, company.id).filter((r) => normalizeName(r.title) === nt).map((r) => r.id);
      }
      const vals: Record<string, SQLInputValue> = {};
      for (const k of ROLE_FIELDS) {
        const v = f[k];
        if (v !== undefined) vals[k] = v;
      }
      // url is offered first (an update by id may refresh it), then aliases. An alias can upgrade a listing to an
      // ATS link, or give a role with no URL its ATS link; a listing alias never becomes the URL approval binds to.
      let primary = role?.url ?? null;
      let chosen: string | undefined;
      for (const [i, c] of claims.entries()) {
        const isUrl = i === 0 && !!f.url;
        if ((isUrl || primary || c.posting) && takesPrimary(primary, c, isUrl && !!f.id)) [primary, chosen] = [c.url, c.url];
      }
      if (chosen) vals.url = chosen;
      else delete vals.url;
      if (!vals.ats && chosen) {
        const ats = atsFromUrl(chosen).ats;
        if (ats) vals.ats = ats;
        else delete vals.ats;
      }
      let created = false;
      let roleId: number;
      if (role) {
        roleId = role.id;
        const keys = Object.keys(vals);
        if (keys.length) this.run(`UPDATE roles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => vals[k] ?? null), now(), role.id);
      } else {
        const keys = Object.keys(vals);
        const r = this.run(
          `INSERT INTO roles(company_id, ${keys.join(', ')}, first_seen, updated_at, status) VALUES(?, ${keys.map(() => '?').join(', ')}, ?, ?, 'found')`,
          company.id, ...keys.map((k) => vals[k] ?? null), now(), now(),
        );
        roleId = Number(r.lastInsertRowid);
        this.insertEvent({ role_id: roleId, status: 'found', reason: `Found via ${f.source || 'unknown source'}`, evidence: f.url || null, actor: 'pipeline' });
        created = true;
      }
      // Evidence is about URLs joining an existing role: aliases, and a url new to the role (an ATS move needs it).
      // A brand-new role's own url is just where it was found. Aliases go first, so a url also listed as an alias keeps
      // it, and a URL the role already holds keeps its first row and evidence.
      const evidence = f.identity_evidence ?? undefined;
      this.indexRoleUrls(roleId, f.url_aliases ?? [], evidence);
      if (f.url) this.indexRoleUrls(roleId, [f.url], target.role ? evidence : undefined);
      return { role: this.mustRole(roleId), company, created, dedupe, possible_role_ids };
    });
  }

  // Every event lands on the canonical role, so nothing can move a linked duplicate's status after the link. This
  // covers the event and the status only: callers must resolve the id themselves (cardRow) before any other write to
  // roles, such as verified_at, score or url. projectStatus: false appends the evidence and leaves the role's status
  // alone, for history that is not the latest word on the role. Returns the new event's id.
  insertEvent({ role_id: requested, status = null, outcome = null, category = null, question = null, blocked_by = null, actor, reason, evidence = null, run_id = null, ts = now(), source = null, source_account = null, source_id = null, received_at = ts }: EventInput, { projectStatus = true }: { projectStatus?: boolean } = {}): number {
    const role_id = this.canonicalRoleId(requested);
    const { lastInsertRowid } = this.run(
      'INSERT INTO events(role_id, ts, status, outcome, category, question, blocked_by, actor, reason, evidence, run_id, source, source_account, source_id, received_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      role_id, ts, status, outcome, category, question, blocked_by, actor, reason, evidence, run_id, source, source_account, source_id, received_at,
    );
    if (status && projectStatus) this.run('UPDATE roles SET status = ?, updated_at = ? WHERE id = ?', status, now(), role_id);
    return Number(lastInsertRowid);
  }

  // selfReported: the user moved the role on the board themselves. Their own word is the evidence for an
  // application or a drop, so there is no confirmation or employer quote to capture.
  validateEvent(a: EventInput, { selfReported = false }: { selfReported?: boolean } = {}): void {
    req(this.roleRow(a.role_id), `No role ${a.role_id}`);
    req(a.reason && String(a.reason).trim(), 'reason is required on every event');
    if (a.status != null) req(oneOf(STATUSES, a.status), `Unknown status "${a.status}". Known: ${STATUSES.join(', ')}`);
    if (a.status === 'dropped' && !selfReported) req(a.evidence && String(a.evidence).trim(), 'A drop needs evidence: a verbatim quote from the employer page (with URL) or rule:<id>.');
    if (a.status === 'applied' && !selfReported) req(a.evidence && String(a.evidence).trim(), 'applied needs evidence: the captured confirmation text.');
    if (a.status === 'closed') req(oneOf(OUTCOMES, a.outcome), `closed needs outcome: ${OUTCOMES.join(' | ')}`);
    if (a.evidence && /^rule:(\d+)$/.test(a.evidence)) {
      const id = Number(a.evidence.split(':')[1]);
      req(this.one('SELECT 1 FROM rules WHERE id = ?', id), `evidence cites rule ${id}, which does not exist`);
    }
  }

  // The board (board-api.ts) passes actor 'user' and selfReported: the move follows userMoves instead of
  // MACHINE. The MCP tool's schema has neither and checkArgs rejects unknown arguments, so calls from the
  // model are always the pipeline, forward-only, and always need evidence for applied and dropped. (record
  // takes an actor, but never selfReported.)
  transition(input: ArgsFor<'transition'>, { actor = 'pipeline', selfReported = false }: { actor?: 'pipeline' | 'user'; selfReported?: boolean } = {}) {
    req(input.to, 'to is required');
    req(!selfReported || actor === 'user', 'Only the user can make a self-reported move.');
    return tx(this.db, () => {
      const role = this.cardRow(input.role_id);
      req(role, `No role ${input.role_id}`);
      // A linked duplicate's id moves its canonical role: the check, the event and the row update all use that role.
      const a = { ...input, role_id: role.id };
      const from = role.status || 'found';
      if (selfReported) {
        const { moves, why } = userMoves(role);
        req(!why, `Role ${a.role_id} ${why}.`);
        req(oneOf(moves, a.to), `Role ${a.role_id} needs Claude to verify and score it before it can be ${a.to}.`);
      } else {
        const allowed = oneOf(STATUSES, from) ? MACHINE[from] : [];
        req(from === a.to || oneOf(allowed, a.to), `Illegal transition ${from} → ${a.to}. Allowed from ${from}: ${allowed.join(', ') || 'none (terminal)'}.`);
      }
      if (a.to === 'verified') {
        req(a.evidence && /https?:\/\//.test(a.evidence), 'verified needs evidence with the employer posting URL and the verbatim location line.');
        req(a.location_line && a.location_type, 'verified needs location_line (verbatim from the employer ATS) and location_type.');
        req(oneOf(['remote', 'hybrid', 'onsite', 'unknown'], a.location_type), 'location_type: remote | hybrid | onsite | unknown');
      }
      if (a.to === 'queued' && a.blocked_by) req(oneOf(['browser', 'user', 'login', 'captcha', 'other'], a.blocked_by), 'blocked_by: browser | user | login | captcha | other');
      if (a.asked_salary != null) {
        req(a.to === 'applied', 'asked_salary goes with applied only: the salary entered on the application form.');
        req(a.asked_salary.trim(), 'asked_salary is empty. Pass the salary field\'s value as entered, or omit it if the form had no salary field.');
      }
      const ev: EventInput = { ...a, status: a.to, actor };
      this.validateEvent(ev, { selfReported });
      if (a.to === 'verified') {
        this.run('UPDATE roles SET verified_at = ?, location_line = ?, location_type = ? WHERE id = ?', now(), a.location_line ?? null, a.location_type ?? null, a.role_id);
      }
      if (a.score != null || a.score_notes != null) {
        this.run('UPDATE roles SET score = COALESCE(?, score), score_notes = COALESCE(?, score_notes) WHERE id = ?', a.score ?? null, a.score_notes ?? null, a.role_id);
      }
      if (a.asked_salary != null) this.run('UPDATE roles SET asked_salary = ? WHERE id = ?', a.asked_salary.trim(), a.role_id);
      this.insertEvent(ev);
      return { role: this.roleRow(a.role_id), from, to: a.to };
    });
  }

  // Appends an event without the machine check, for outcomes that arrive from outside and for notes. With source,
  // source_account, source_id and occurred_at the event is external: the same occurrence is recorded once, it is
  // dated by when it happened rather than when it arrived, and it moves the status only if it is the newest status
  // event of the role's group and the status machine allows the move, or clear evidence establishes a missing
  // application on a found card with no local status decisions. Otherwise it is kept as evidence.
  record(a: ArgsFor<'record'>) {
    req(oneOf(['user', 'employer', 'pipeline'], a.actor), 'actor: user | employer | pipeline');
    req(a.status !== 'verified', 'Use transition(to: "verified") so verified_at is set with evidence.');
    const { source, source_account, source_id, occurred_at, ...rest } = a;
    const external = externalIdentity(a);
    return tx(this.db, () => {
      const ev: EventInput = { ...rest, role_id: this.canonicalRoleId(a.role_id) };
      this.validateEvent(ev);
      if (!external) {
        const event_id = this.insertEvent(ev);
        return { role: this.roleRow(ev.role_id), event_id, duplicate: false, status_applied: !!ev.status };
      }
      const { ts } = external;
      const key = { source: external.source, source_account: external.account, source_id: external.id };
      const known = this.one<EventRow>('SELECT * FROM events WHERE source = ? AND source_account = ? AND source_id = ?', key.source, key.source_account, key.source_id);
      if (known) {
        this.requireSameOccurrence(known, { ...ev, ts });
        return { role: this.roleRow(ev.role_id), event_id: known.id, duplicate: true, status_applied: false };
      }
      const { project, conflict } = this.projection(ev, ts, { externalRecord: true });
      const event_id = this.insertEvent({ ...ev, ...key, ts, received_at: now() }, { projectStatus: project });
      return { role: this.roleRow(ev.role_id), event_id, duplicate: false, status_applied: project, ...(conflict ? { conflict } : {}) };
    });
  }

  private requireSameOccurrence(known: EventRow, next: EventInput & { ts: string }): void {
    const label = `${known.source} id ${known.source_id}`;
    const knownRole = this.canonicalRoleId(known.role_id);
    req(knownRole === next.role_id, `${label} was already recorded for role ${knownRole}, not role ${next.role_id}. Nothing was written. Use the role it was first recorded on, or a source_id that identifies this occurrence.`);
    requireSameFields(label, known, next, REPEATED, { ts: 'occurred_at' });
  }

  // Discovery marks when we learned of a role, not when an application happened. Order all substantive history
  // first so backfilled receipts cannot reopen rejections. An unreconciled found card needs an actionable conflict.
  private projection(ev: EventInput, ts: string, { externalRecord = false }: { externalRecord?: boolean } = {}): { project: boolean; conflict?: string } {
    if (!ev.status) return { project: false };
    const role = this.mustRole(ev.role_id);
    const events = substantiveStatusEvents(this.groupStatusEvents(this.roleGroupIds(role.id)));
    const latest = events.at(-1);
    const at = Date.parse(ts);
    const label = stateLabel({ status: ev.status, outcome: ev.outcome ?? null });
    const from = role.status || 'found';
    const unreconciled = () => ({ project: false, conflict: `Role ${role.id} is still found but its substantive history disagrees with ${label}. It was recorded as evidence only. Reconcile the role with the user before recording a state correction.` });
    if (latest && at < statusInstant(latest.ts)) return from === 'found' ? unreconciled() : { project: false };
    if (latest && at === statusInstant(latest.ts)) {
      if (latest.status === ev.status && (latest.outcome ?? null) === (ev.outcome ?? null)) return from === 'found' && ev.status !== 'found' ? unreconciled() : { project: false };
      return { project: false, conflict: `The role already has ${stateLabel(latest)} at the same time (${ts}), so ${label} was recorded as evidence only and the status stays ${role.status}. Decide which came last, then settle it with transition or record.` };
    }
    // Only keyed external evidence can establish a missing application; local decisions anywhere in the group veto it.
    if (externalRecord && from === 'found' && (ev.status === 'applied' || ev.status === 'closed')) {
      if (events.some((event) => event.source === null)) return unreconciled();
      if (String(ev.evidence ?? '').trim()) return { project: true };
    }
    const allowed = oneOf(STATUSES, from) ? MACHINE[from] : [];
    if (from === ev.status || oneOf(allowed, ev.status)) return { project: true };
    return { project: false, conflict: `Moving from ${from} to ${ev.status} is not allowed by the status machine (allowed from ${from}: ${allowed.join(', ') || 'none (terminal)'}), so ${label} was recorded as evidence only and the status stays ${from}. If the role really changed, settle it with transition or the user.` };
  }

  // Links always point at a root (linkDuplicateRole flattens them), so one lookup finds the canonical role.
  canonicalRoleId(id: number): number {
    return this.one<{ id: number }>('SELECT canonical_role_id AS id FROM role_links WHERE duplicate_role_id = ?', id)?.id ?? id;
  }

  // The row a role id acts on: the canonical role of its group, or the role itself.
  cardRow(id: number): RoleRow | undefined {
    return this.roleRow(this.canonicalRoleId(id));
  }

  // The canonical role first, then its linked duplicates in id order.
  roleGroupIds(id: number): number[] {
    const root = this.canonicalRoleId(id);
    return [root, ...this.q<{ id: number }>('SELECT duplicate_role_id AS id FROM role_links WHERE canonical_role_id = ? ORDER BY duplicate_role_id', root).map((r) => r.id)];
  }

  // Every ATS posting a group of roles holds.
  groupPostings(ids: readonly number[]): PostingKey[] {
    return this.q<PostingKey>(`SELECT DISTINCT provider, employer_key, posting_id FROM role_postings WHERE role_id IN (${marks(ids)})`, ...ids);
  }

  // Status events of a group of roles, oldest first.
  groupStatusEvents(ids: readonly number[]): StatusEvent[] {
    return this.q<StatusEvent>(`SELECT id, role_id, ts, status, outcome, actor, source FROM events WHERE status IS NOT NULL AND role_id IN (${marks(ids)})`, ...ids).sort(orderStatusEvents);
  }

  linkDuplicateRole({ canonical_role_id, duplicate_role_id, reason, evidence }: ArgsFor<'link_duplicate_role'>) {
    req(reason.trim(), 'reason is required: why the two rows are one role.');
    req(evidence.trim(), 'evidence is required: how you confirmed both rows are the same posting, e.g. the ATS URL both link to.');
    req(canonical_role_id !== duplicate_role_id, `Role ${duplicate_role_id} cannot be linked to itself. Pass the other row as canonical_role_id.`);
    return tx(this.db, () => {
      // A duplicate named as canonical stands for its root, like any old id. The duplicate is taken as named.
      const canonical = this.mustRole(this.canonicalRoleId(canonical_role_id));
      const duplicate = this.mustRole(duplicate_role_id);
      const group = () => ({ canonical_role_id: canonical.id, linked_role_ids: this.roleGroupIds(canonical.id).slice(1) });
      req(duplicate.id !== canonical.id, `Role ${canonical.id} is the canonical role of this group (linked: ${group().linked_role_ids.join(', ')}). Nothing was written. A group's root cannot become a duplicate of its own members.`);
      const root = this.canonicalRoleId(duplicate.id);
      if (root === canonical.id) return group();
      req(root === duplicate.id, `Role ${duplicate.id} is already linked to role ${root}. Nothing was written. To merge the groups, link role ${root} into role ${canonical.id}.`);
      const company = this.mustCompany(canonical.company_id);
      req(duplicate.company_id === company.id, `Role ${duplicate.id} is at ${this.mustCompany(duplicate.company_id).name} and role ${canonical.id} at ${company.name}. Only roles at the same company can be linked. Nothing was written.`);
      const canonicalGroup = this.roleGroupIds(canonical.id);
      const duplicateGroup = this.roleGroupIds(duplicate.id);
      const held = this.groupPostings(canonicalGroup);
      for (const k of this.groupPostings(duplicateGroup)) {
        const clash = held.find((h) => h.provider === k.provider && h.employer_key === k.employer_key && h.posting_id !== k.posting_id);
        if (clash) throw new ToolError(`${keyLabel(clash)} and ${keyLabel(k)} are different postings on one employer board, so roles ${canonical.id} and ${duplicate.id} are different requisitions. Nothing was written.`);
      }
      checkHistories({ id: canonical.id, status: canonical.status, events: this.groupStatusEvents(canonicalGroup) }, { id: duplicate.id, status: duplicate.status, events: this.groupStatusEvents(duplicateGroup) });
      // A root's own duplicates move with it, so every link still points at a root.
      this.run('UPDATE role_links SET canonical_role_id = ? WHERE canonical_role_id = ?', canonical.id, duplicate.id);
      this.run('INSERT INTO role_links(duplicate_role_id, canonical_role_id, reason, evidence, created_at) VALUES(?, ?, ?, ?, ?)', duplicate.id, canonical.id, reason.trim(), evidence.trim(), now());
      return group();
    });
  }

  // A linked duplicate's id shows its canonical role, with the history, artifacts, interviews and URLs of every row
  // in the group under their original ids.
  roleDetail({ role_id }: ArgsFor<'get_role'>) {
    const role = this.cardRow(role_id);
    req(role, `No role ${role_id}`);
    const group = this.roleGroupIds(role.id);
    const inGroup = `IN (${marks(group)})`;
    type ArtifactSummary = Pick<ArtifactRow, 'id' | 'role_id' | 'kind' | 'path_or_ref' | 'verified_at' | 'created_at' | 'lint'>;
    type LinkSummary = Omit<RoleLinkRow, 'canonical_role_id'> & Pick<RoleRow, 'title' | 'url' | 'status'>;
    // Rows come canonical role first, so the first of each key is the one kept.
    const distinct = <T>(rows: T[], key: (r: T) => string) => {
      const seen = new Set<string>();
      return rows.filter((r) => !seen.has(key(r)) && !!seen.add(key(r)));
    };
    return {
      requested_role_id: role_id,
      role,
      linked_role_ids: group.slice(1),
      links: this.q<LinkSummary>(`SELECT l.duplicate_role_id, r.title, r.url, r.status, l.reason, l.evidence, l.created_at FROM role_links l JOIN roles r ON r.id = l.duplicate_role_id
        WHERE l.canonical_role_id = ? ORDER BY l.duplicate_role_id`, role.id),
      company: this.companyRow(role.company_id),
      events: this.q<EventRow>(`SELECT * FROM events WHERE role_id ${inGroup} ORDER BY ts, id`, ...group),
      artifacts: this.q<ArtifactSummary>(`SELECT id, role_id, kind, path_or_ref, verified_at, created_at, lint FROM artifacts WHERE role_id ${inGroup} ORDER BY id`, ...group).map((a) => ({ ...a, lint: parseJson<LintResult | null>(a.lint, null) })),
      interviews: this.q<InterviewRow>(`SELECT * FROM interviews WHERE role_id ${inGroup} ORDER BY id`, ...group),
      // A URL or posting several rows hold is listed once, as the canonical role holds it.
      urls: distinct(this.q<Omit<RoleUrlRow, 'role_id'>>(`SELECT url, normalized_url, evidence FROM role_urls WHERE role_id ${inGroup} ORDER BY role_id != ?, role_id, normalized_url`, ...group, role.id), (u) => u.normalized_url),
      postings: distinct(this.q<Omit<RolePostingRow, 'role_id'>>(`SELECT provider, employer_key, posting_id FROM role_postings WHERE role_id ${inGroup} ORDER BY role_id != ?, role_id, provider, employer_key, posting_id`, ...group, role.id), keyLabel),
    };
  }

  // A posting is applied to once. The current status is not enough: a board move or a re-run can put a rejected
  // role back in the queue, so the history of every row for this posting decides, under any of its ids.
  gateCheck({ role_id: requested }: ArgsFor<'gate_check'>): GateResult {
    const role = this.cardRow(requested);
    if (!role) return { ok: false, problems: [`No role ${requested}`] };
    const role_id = role.id;
    const company = this.mustCompany(role.company_id);
    const group = this.roleGroupIds(role_id);
    const problems: string[] = [];
    if (!role.verified_at) problems.push('Role not verified on the employer posting (verified_at is empty).');
    if (company.no_cold_apply) problems.push(`Company is no_cold_apply: ${company.no_cold_apply_reason || 'intro or recruiter process open'}.`);
    // Rows outside the group that hold one of its URLs or postings are the same posting under a history nobody has
    // reconciled. Until they are linked (or one is corrected), neither can be applied to, and their history counts.
    const unresolved = this.samePostingGroups(group).filter((id) => id !== role_id);
    // Other cards only: a linked duplicate's status stopped moving at the link, so its group's card speaks for it.
    // An unresolved row for this posting is reported below as this posting, not as a second live process.
    const others = this.q<Pick<RoleRow, 'id' | 'title' | 'status'>>(`SELECT id, title, status FROM roles r WHERE company_id = ? AND id != ? AND ${isCard('r.id')}`, company.id, role_id).filter((r) => oneOf(LIVE, r.status) && !unresolved.includes(r.id));
    if (others.length) problems.push(`Live application at this company already: ${others.map((r) => `${r.title} (${r.status})`).join('; ')}.`);
    if (oneOf(['dropped', 'closed'], role.status)) problems.push(`Role is ${role.status}.`);
    if (oneOf(LIVE, role.status)) problems.push(`Role is already ${role.status}.`);
    if (unresolved.length) problems.push(`This posting is also tracked as role ${unresolved.join(', ')}. Check them with get_role; link them with link_duplicate_role if they are one posting, or correct the wrong URL, before applying.`);
    const history = [...group, ...unresolved.flatMap((id) => this.roleGroupIds(id))];
    const previous = this.one<StatusEvent & Pick<EventRow, 'role_id'>>(`SELECT role_id, ts, status, outcome FROM events WHERE role_id IN (${marks(history)}) AND ${APPLIED_SQL} ORDER BY ts DESC, id DESC LIMIT 1`, ...history);
    if (previous) problems.push(`This posting was applied to before: role ${previous.role_id} was ${stateLabel(previous)} on ${day(previous.ts)}. A posting is applied to once, even after a rejection or a move back to the queue.`);
    return {
      ok: problems.length === 0,
      role_id,
      company: company.name,
      title: role.title,
      url: role.url || undefined,
      verified: !!role.verified_at,
      dedupe_clean: others.length === 0 && !unresolved.length && !previous,
      no_cold_apply: !!company.no_cold_apply,
      live_elsewhere: others.length > 0,
      previous_application: !!previous,
      ...(previous ? { matched_role_id: previous.role_id } : {}),
      problems,
    };
  }

  checkPay(a: ArgsFor<'check_pay'>) {
    return checkPay(a, this.section('filters').pay_floor);
  }

  // ---------- artifacts ----------

  addArtifact({ role_id: requested, kind, ref, content }: ArgsFor<'add_artifact'>) {
    const role_id = requested == null ? null : this.canonicalRoleId(requested);
    req(['cover_note', 'cover_letter_pdf', 'gmail_draft', 'form_answers', 'confirmation', 'note'].includes(kind), 'kind: cover_note | cover_letter_pdf | gmail_draft | form_answers | confirmation | note');
    if (role_id != null) req(this.roleRow(role_id), `No role ${requested}`);
    if (kind === 'gmail_draft') req(ref, 'gmail_draft needs ref = the Gmail draft id');
    const maxWords = kind === 'cover_note' ? this.section('writing').max_words_cover_note : undefined;
    const lint = content && PROSE_KINDS.includes(kind) ? lintProse(content, { max_words: maxWords }) : null;
    const r = this.run('INSERT INTO artifacts(role_id, kind, path_or_ref, content, lint, created_at) VALUES(?, ?, ?, ?, ?, ?)', role_id ?? null, kind, ref || null, content || null, lint ? JSON.stringify(lint) : null, now());
    return { artifact_id: Number(r.lastInsertRowid), lint, verified: false, note: kind === 'gmail_draft' ? 'Unverified until read back with get_draft/list_drafts and verify_artifact.' : undefined };
  }

  listArtifacts({ date, role_id, kind, run_id }: ArgsFor<'list_artifacts'> = {}) {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (date || run_id != null) {
      const [cond, p] = this.scope({ date, run_id }).rows('a', 'created_at');
      where.push(cond);
      params.push(...p);
    }
    // A role's artifacts include those of its linked duplicates, under their original role_id.
    if (role_id != null) {
      const group = this.roleGroupIds(role_id);
      where.push(`a.role_id IN (${marks(group)})`);
      params.push(...group);
    }
    if (kind) where.push('a.kind = ?') && params.push(kind);
    type Listed = Pick<ArtifactRow, 'id' | 'role_id' | 'kind' | 'path_or_ref' | 'content' | 'lint' | 'verified_at' | 'created_at'> & { company: string | null };
    const rows = this.q<Listed>(`SELECT a.id, a.role_id, a.kind, a.path_or_ref, a.content, a.lint, a.verified_at, a.created_at, c.name AS company FROM artifacts a
      LEFT JOIN roles r ON r.id = ${canonicalOf('a.role_id')} LEFT JOIN companies c ON c.id = r.company_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id`, ...params);
    return { artifacts: rows.map((a) => ({ ...a, lint: parseJson<LintResult | null>(a.lint, null) })) };
  }

  verifyArtifact({ artifact_id, readback }: ArgsFor<'verify_artifact'>) {
    const a = this.one<ArtifactRow>('SELECT * FROM artifacts WHERE id = ?', artifact_id);
    req(a, `No artifact ${artifact_id}`);
    req(readback && String(readback).trim(), 'readback is required: the text returned when reading the artifact back.');
    if (a.kind === 'gmail_draft') req(String(readback).includes(String(a.path_or_ref)), `Read-back does not contain draft id ${a.path_or_ref}. Read the draft back with get_draft/list_drafts first.`);
    this.run('UPDATE artifacts SET verified_at = ?, readback = ? WHERE id = ?', now(), String(readback).slice(0, 4000), artifact_id);
    return { artifact_id, verified: true };
  }

  // ---------- rules, sources, interviews ----------

  addRule({ text, reason, example, types, added_by = 'user', added_on }: ArgsFor<'add_rule'> & { added_on?: string }) {
    req(text && reason, 'text and reason are required');
    // An omitted or null types is global: a rule nobody classified must still reach every consumer.
    const kinds = types == null ? (['global'] as RuleType[]) : normalizeRuleTypes(types);
    return tx(this.db, () => {
      const r = this.run('INSERT INTO rules(text, reason, example, added_by, added_on) VALUES(?, ?, ?, ?, ?)', text, reason, example || null, added_by, added_on || day(now()));
      const rule_id = Number(r.lastInsertRowid);
      this.storeRuleTypes(rule_id, kinds);
      this.bumpRulesRevision();
      return { rule_id };
    });
  }

  listRules({ types, limit, cursor, include_inactive }: ArgsFor<'list_rules'> = {}) {
    const after = cursor == null ? null : decodeRuleCursor(cursor);
    const { types: filter, include_inactive: inactive } = resolveRuleFilters(types, include_inactive, after);
    const size = normalizeRuleLimit(limit);
    return readTx(this.db, () => {
      const revision = this.rulesRevision();
      if (after) assertFreshRevision('list_rules', after.revision, revision);
      // Any requested type or global.
      const matched = filter ? [...new Set<RuleType>([...filter, 'global'])] : [];
      const where = `${inactive ? '1' : 'active = 1'}${filter ? ` AND ${typeFilterSql(matched)}` : ''}`;
      const total = this.one<{ n: number }>(`SELECT COUNT(*) AS n FROM rules WHERE ${where}`, ...matched)?.n ?? 0;
      const rows = this.q<RuleRow>(`SELECT * FROM rules WHERE ${where} AND id > ? ORDER BY id LIMIT ?`, ...matched, after?.after_id ?? 0, size + 1);
      const page = rows.slice(0, size);
      const kinds = this.ruleTypesFor(page.map((r) => r.id));
      // ruleTypesFor answers every id it is given, so the lookup cannot miss.
      const candidates: RuleListItem[] = page.map((r) => ({ ...r, types: kinds.get(r.id)! }));
      const cursorAfter = (id: number) => encodeRuleCursor({ v: 1, after_id: id, revision, types: filter, include_inactive: inactive });
      const { rules, next_cursor } = packRulePage(candidates, rows.length > size, { total, rules_revision: revision, cursorAfter });
      return { rules, next_cursor, total, rules_revision: revision };
    });
  }

  // One rule as list_rules would show it, in pieces of its JSON text. For a rule list_rules marked requires_detail.
  getRule({ id, cursor, limit, expected_revision }: ArgsFor<'get_rule'>) {
    const after = cursor == null ? null : decodeDetailCursor(cursor);
    const size = normalizeDetailLimit(limit);
    if (expected_revision != null && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)) throw new ToolError('expected_revision must be a nonnegative safe integer from list_rules.rules_revision.');
    if (after && after.id !== id) throw new ToolError(`cursor belongs to rule ${after.id}, not rule ${id}. Restart get_rule for rule ${id} without a cursor.`);
    return readTx(this.db, () => {
      const revision = this.rulesRevision();
      if (expected_revision != null) {
        if (after && expected_revision !== after.revision) throw detailRevisionMismatch(expected_revision, after.revision);
        assertFreshDetailRevision(expected_revision, revision);
      }
      if (after) assertFreshDetailRevision(after.revision, revision);
      const rule = this.one<RuleRow>('SELECT * FROM rules WHERE id = ?', id);
      req(rule, `No rule ${id}`);
      const item: RuleListItem = { ...rule, types: this.ruleTypesFor([id]).get(id)! };
      return detailChunk(id, JSON.stringify(item), after?.offset ?? 0, size, revision);
    });
  }

  setRuleTypes({ id, types }: ArgsFor<'set_rule_types'>) {
    const kinds = normalizeRuleTypes(types);
    return tx(this.db, () => {
      req(this.one('SELECT 1 FROM rules WHERE id = ?', id), `No rule ${id}`);
      const current = this.ruleTypesFor([id]).get(id) ?? ['global'];
      if (current.join() !== kinds.join()) {
        this.run('DELETE FROM rule_types WHERE rule_id = ?', id);
        this.storeRuleTypes(id, kinds);
        this.bumpRulesRevision();
      }
      return { rule_id: id, types: kinds, rules_revision: this.rulesRevision() };
    });
  }

  deactivateRule({ id }: ArgsFor<'deactivate_rule'>) {
    return tx(this.db, () => {
      const rule = this.one<Pick<RuleRow, 'active'>>('SELECT active FROM rules WHERE id = ?', id);
      req(rule, `No rule ${id}`);
      if (rule.active) {
        this.run('UPDATE rules SET active = 0 WHERE id = ?', id);
        this.bumpRulesRevision();
      }
      return { deactivated: id };
    });
  }

  // Internal, inside the caller's transaction.
  private storeRuleTypes(ruleId: number, kinds: RuleType[]) {
    for (const type of kinds) this.run('INSERT INTO rule_types(rule_id, type) VALUES(?, ?)', ruleId, type);
  }

  // The stored types of these rules, each in RULE_TYPES order. A rule with no type rows (written before rule
  // types existed) is global, so every id asked for comes back with at least one type. Callers pass one page
  // (at most MAX_RULE_LIMIT ids) or one id, so the IN list stays far below SQLite's variable limit.
  ruleTypesFor(ids: readonly number[]): Map<number, RuleType[]> {
    const stored = new Map<number, Set<string>>();
    if (ids.length) {
      const rows = this.q<RuleTypeRow>(`SELECT rule_id, type FROM rule_types WHERE rule_id IN (${ids.map(() => '?').join(',')})`, ...ids);
      for (const { rule_id, type } of rows) stored.set(rule_id, (stored.get(rule_id) ?? new Set()).add(type));
    }
    return new Map(ids.map((id) => {
      const kinds = RULE_TYPES.filter((t) => stored.get(id)?.has(t));
      return [id, kinds.length ? kinds : ['global']];
    }));
  }

  private rulesRevision(): number {
    const row = this.one<{ revision: number }>('SELECT revision FROM rule_state WHERE id = 1');
    if (!row) throw new Error(MISSING_RULE_STATE);
    return row.revision;
  }

  private bumpRulesRevision() {
    const r = this.run('UPDATE rule_state SET revision = revision + 1 WHERE id = 1');
    if (r.changes !== 1) throw new Error(MISSING_RULE_STATE);
  }

  sourceHealth() {
    return {
      sources: this.q<SourceRow>('SELECT * FROM sources ORDER BY name'),
      checkpoints: this.q<SourceCheckpointRow>('SELECT source, source_account, checked_through, last_coverage, last_attempt_at FROM source_checkpoints ORDER BY source, source_account'),
    };
  }

  setSourceStatus({ name, status, found, applied, error, source_account, checked_through, coverage, degrade_after = 3 }: ArgsFor<'set_source_status'> & { degrade_after?: number }) {
    req(name && ['ok', 'degraded', 'failed', 'disabled'].includes(status), 'name and status (ok | degraded | failed | disabled) are required');
    const report = this.checkpointReport({ name, status, source_account, checked_through, coverage });
    return tx(this.db, () => {
      const cur = this.one<SourceRow>('SELECT * FROM sources WHERE name = ?', name);
      const failures = status === 'failed' ? (cur?.consecutive_failures || 0) + 1 : status === 'ok' ? 0 : cur?.consecutive_failures || 0;
      let effective = status;
      if (status === 'failed' && failures >= degrade_after) effective = 'degraded';
      const changed = !cur || cur.status !== effective;
      this.run(
        `INSERT INTO sources(name, last_run, status, status_changed_at, consecutive_failures, found, applied, last_error) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run = excluded.last_run, status = excluded.status,
           status_changed_at = CASE WHEN sources.status != excluded.status THEN excluded.status_changed_at ELSE sources.status_changed_at END,
           consecutive_failures = excluded.consecutive_failures, found = sources.found + excluded.found,
           applied = sources.applied + excluded.applied, last_error = excluded.last_error`,
        name, now(), effective, now(), failures, found || 0, applied || 0, error || null,
      );
      const source = this.one<SourceRow>('SELECT * FROM sources WHERE name = ?', name);
      if (!report) return { source, changed };
      return { source, changed, checkpoint: this.writeCheckpoint(report) };
    });
  }

  // The checkpoint part of a set_source_status call, validated before anything is written; null when the call has none.
  private checkpointReport(a: { name: string; status: string; source_account?: string | null | undefined; checked_through?: string | null | undefined; coverage?: string | null | undefined }) {
    const given = (v: unknown) => v != null;
    if (!given(a.source_account) && !given(a.checked_through) && !given(a.coverage)) return null;
    req(given(a.coverage), 'source_account and checked_through describe a scan and come with coverage (complete | partial | unavailable). Nothing was written.');
    req(oneOf(COVERAGES, a.coverage), `coverage must be one of ${COVERAGES.join(' | ')}; got "${a.coverage}". Nothing was written.`);
    req(given(a.source_account), 'coverage needs source_account: the mailbox or board account the scan covered, so that two accounts never share a checkpoint. Nothing was written.');
    // Checkpoints lowercase the source so Gmail and gmail match across tools; sources.name keeps its spelling for old callers.
    // requireKey, not a bare trim: a blank name is a valid sources row but must not become an empty checkpoint source.
    const source = requireKey(a.name, 'name').toLowerCase();
    const account = requireKey(a.source_account, 'source_account');
    const through = given(a.checked_through) ? explicitUtcIso(a.checked_through, 'checked_through') : null;
    if (through && Date.parse(through) > Date.now() + FUTURE_SKEW_MS) throw new ToolError(`checked_through is in the future (${through}). Pass how far the scan actually reached. Nothing was written.`);
    if (a.coverage === 'complete') {
      req(through, 'coverage complete needs checked_through: the time the scan reached, ISO 8601 with an explicit offset. Nothing was written.');
      req(a.status === 'ok', `coverage complete needs status ok, not ${a.status}: a failed, degraded or disabled source did not finish a scan. Report partial or unavailable instead. Nothing was written.`);
    }
    return { source, account, coverage: a.coverage, through };
  }

  // Only a complete scan moves checked_through, and only forward. Every report records the attempt. checked_through is
  // validated but ignored for partial and unavailable reports: they do not say the records up to it were checked.
  private writeCheckpoint({ source, account, coverage, through }: { source: string; account: string; coverage: Coverage; through: string | null }) {
    const known = this.one<SourceCheckpointRow>('SELECT * FROM source_checkpoints WHERE source = ? AND source_account = ?', source, account);
    const advance = coverage === 'complete' && through && (!known?.checked_through || through > known.checked_through);
    this.run(
      `INSERT INTO source_checkpoints(source, source_account, checked_through, last_coverage, last_attempt_at) VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(source, source_account) DO UPDATE SET checked_through = excluded.checked_through, last_coverage = excluded.last_coverage, last_attempt_at = excluded.last_attempt_at`,
      source, account, advance ? through : (known?.checked_through ?? null), coverage, now(),
    );
    return this.one<SourceCheckpointRow>('SELECT source, source_account, checked_through, last_coverage, last_attempt_at FROM source_checkpoints WHERE source = ? AND source_account = ?', source, account);
  }

  addInterview(a: ArgsFor<'add_interview'>) {
    req(a.stage, 'stage is required');
    // An occurrence is a full external key with its time, or, for a later sighting of an interview already known by
    // its id (another message or source), just the time. A source group is whole or absent either way.
    const keyless = [a.source, a.source_account, a.source_id].every((v) => v == null);
    req(a.occurred_at == null || a.interview_id != null || !keyless, 'occurred_at identifies an update by when it happened: pass it with interview_id, or with source, source_account and source_id.');
    const external = a.interview_id != null && a.occurred_at != null && keyless ? null : externalIdentity(a);
    const occurred = external?.ts ?? (a.occurred_at != null ? occurrenceTime(a.occurred_at, 'occurred_at') : null);
    return tx(this.db, () => {
      const role = this.cardRow(a.role_id);
      req(role, `No role ${a.role_id}`);
      if (a.run_id != null) req(this.one('SELECT 1 FROM runs WHERE id = ?', a.run_id), `No run ${a.run_id}`);
      const known = this.findInterview(role, a, external);
      const received = now();
      // ts is when it happened: the source's own time, or now for a call that names none.
      const when: InterviewTiming = { ts: occurred ?? received, received, run_id: a.run_id ?? null };
      const order = orderOf(known, occurred, when.ts);
      // Checked before the values: an update this old is ignored whatever it says.
      if (known && order === 'older') return interviewResult(known.id, known.state, { stale: true });
      if (known && order === 'same') {
        this.requireReplay(a, known);
        return interviewResult(known.id, known.state);
      }
      const next = this.interviewValues(a, known);
      const key: InterviewKey = external ? { source: external.source, source_account: external.account, source_id: external.id } : { source: known?.source ?? null, source_account: known?.source_account ?? null, source_id: known?.source_id ?? null };
      if (!known) return interviewResult(this.insertInterview(role, next, key, occurred, when), next.state, { created: true });
      return this.updateInterview(role, known, next, key, occurred != null, when);
    });
  }

  private insertInterview(role: RoleRow, next: InterviewValues, key: InterviewKey, occurred: string | null, when: InterviewTiming): number {
    const r = this.run(
      'INSERT INTO interviews(role_id, starts_at, tz, stage, people, link, booked_by, notes, created_at, state, updated_at, source, source_account, source_id, last_occurred_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      role.id, next.starts_at, next.tz, next.stage, next.people, next.link, next.booked_by, next.notes, when.received, next.state, when.received, key.source, key.source_account, key.source_id, occurred,
    );
    const id = Number(r.lastInsertRowid);
    this.logInterviewChange(id, null, { ...next, ...key }, when);
    this.afterInterviewChange(role, id, null, next, key, when);
    if (occurred != null) this.saveInterviewExternalState(id, occurred, next);
    return id;
  }

  private updateInterview(role: RoleRow, known: InterviewRow, next: InterviewValues, key: InterviewKey, dated: boolean, when: InterviewTiming) {
    const before = interviewSnapshot(known);
    if (INTERVIEW_VALUES.every((k) => before[k] === next[k])) {
      // Nothing changed, but a dated repeat is still the newest word on the interview.
      if (dated) {
        this.adoptSourceKey(known, key, when);
        this.saveInterviewExternalState(known.id, when.ts, next);
      }
      return interviewResult(known.id, known.state);
    }
    // An update without an occurrence time (a hand edit) leaves the order alone: an event that happened before the
    // edit but is read after it must still apply. The newer dated update wins for the fields it carries.
    const last = dated ? when.ts : known.last_occurred_at;
    this.run('UPDATE interviews SET starts_at = ?, tz = ?, stage = ?, people = ?, link = ?, booked_by = ?, notes = ?, state = ?, updated_at = ?, source = ?, source_account = ?, source_id = ?, last_occurred_at = ? WHERE id = ?',
      next.starts_at, next.tz, next.stage, next.people, next.link, next.booked_by, next.notes, next.state, when.received, key.source, key.source_account, key.source_id, last, known.id);
    this.logInterviewChange(known.id, { ...before, source: known.source, source_account: known.source_account, source_id: known.source_id }, { ...next, ...key }, when);
    this.afterInterviewChange(role, known.id, before, next, key, when);
    if (dated) this.saveInterviewExternalState(known.id, when.ts, next);
    return interviewResult(known.id, next.state, { updated: true });
  }

  // A dated call that changes none of the interview's fields. A row recorded without an identity (a booking link)
  // gains the calendar event it turned out to be, if the call carries one, and the history says when; otherwise it only
  // moves the order along, so that an older update is ignored from here on.
  private adoptSourceKey(known: InterviewRow, key: InterviewKey, when: InterviewTiming): void {
    this.run('UPDATE interviews SET source = ?, source_account = ?, source_id = ?, last_occurred_at = ? WHERE id = ?', key.source, key.source_account, key.source_id, when.ts, known.id);
    if (known.source == null && key.source != null) {
      const values = interviewSnapshot(known);
      this.logInterviewChange(known.id, { ...values, source: null, source_account: null, source_id: null }, { ...values, ...key }, when);
    }
  }

  // Accepted dated calls save even when no fields changed. Local edits and stale/replayed calls never replace it.
  private saveInterviewExternalState(interviewId: number, occurredAt: string, values: InterviewValues): void {
    this.run(`INSERT INTO interview_external_state(interview_id, occurred_at, snapshot_json) VALUES(?, ?, ?)
      ON CONFLICT(interview_id) DO UPDATE SET occurred_at = excluded.occurred_at, snapshot_json = excluded.snapshot_json`,
      interviewId, occurredAt, JSON.stringify(interviewSnapshot(values)));
  }

  // The accepted external values are independent of local edits, including ones at the same occurrence time.
  private requireReplay(a: ArgsFor<'add_interview'>, known: InterviewRow): void {
    const entry = this.one<{ snapshot_json: string }>('SELECT snapshot_json FROM interview_external_state WHERE interview_id = ? AND occurred_at = ?', known.id, known.last_occurred_at);
    req(entry, `Interview ${known.id} replay baseline is unknown after upgrade. Nothing was written. Surface this uncertainty under Needs you for reconciliation. Do not alter the key or occurrence time to force a replay; a genuinely newer dated update can establish the baseline.`);
    const last = interviewSnapshot(JSON.parse(entry.snapshot_json) as InterviewValues);
    requireSameFields(known.source ? `${known.source} id ${known.source_id}` : `Interview ${known.id}`, last, this.interviewValues({ ...a, state: a.state ?? last.state }, { ...known, ...last }), INTERVIEW_VALUES);
  }

  // The interview a call is about: by id, or by the source's own id for it. Either must belong to the role's group.
  private findInterview(role: RoleRow, a: ArgsFor<'add_interview'>, external: ExternalIdentity | null): InterviewRow | undefined {
    const byKey = external ? this.one<InterviewRow>('SELECT * FROM interviews WHERE source = ? AND source_account = ? AND source_id = ?', external.source, external.account, external.id) : undefined;
    if (a.interview_id != null) {
      const row = this.interviewOf(role, a.interview_id);
      if (external && row.source != null) req(row.source === external.source && row.source_account === external.account && row.source_id === external.id, `Interview ${row.id} was recorded from ${row.source} id ${row.source_id}, not ${external.source} id ${external.id}. Nothing was written. An interview keeps the occurrence it came from.`);
      req(!byKey || byKey.id === row.id, `${external?.source} id ${external?.id} is interview ${byKey?.id}, not interview ${row.id}. Nothing was written. Use interview_id ${byKey?.id}, or omit interview_id.`);
      return row;
    }
    if (byKey) {
      const owner = this.canonicalRoleId(byKey.role_id);
      req(owner === role.id, `${byKey.source} id ${byKey.source_id} was already recorded for role ${owner}, not role ${role.id}. Nothing was written. Use the role it was first recorded on, or a source_id that identifies this occurrence.`);
      return byKey;
    }
    // No id or key: the call names no round, except by its booking link. Exactly one pending row of this stage with
    // this link is that booking; several are not guessed between. A row from another occurrence is not a candidate for one.
    const link = a.link?.trim();
    if (!link) return undefined;
    const group = this.roleGroupIds(role.id);
    const candidates = this.q<InterviewRow>(`SELECT * FROM interviews WHERE role_id IN (${marks(group)}) AND state = 'pending' ORDER BY id`, ...group)
      .filter((i) => i.stage?.trim() === a.stage.trim() && i.link?.trim() === link && (!external || i.source == null));
    req(candidates.length < 2, `Pending interviews ${candidates.map((i) => i.id).join(', ')} of role ${role.id} all match stage "${a.stage}" and this link. Nothing was written. Pass interview_id to say which one this is.`);
    return candidates[0];
  }

  // An interview by id, which must belong to the role's group: an id from another role is never updated.
  private interviewOf(role: RoleRow, id: number): InterviewRow {
    const row = this.one<InterviewRow>('SELECT * FROM interviews WHERE id = ?', id);
    req(row, `No interview ${id}`);
    req(this.canonicalRoleId(row.role_id) === role.id, `Interview ${id} belongs to role ${this.canonicalRoleId(row.role_id)}, not role ${role.id}. Nothing was written. Pass the interview_id of this role's own interview (get_role lists them), or omit it to add one.`);
    return row;
  }

  // What an interview becomes: the call's fields over the stored ones, which stay where the call omits them. A new
  // interview is scheduled with a time and pending without.
  private interviewValues(a: ArgsFor<'add_interview'>, known: InterviewRow | undefined): InterviewValues {
    if (a.tz != null && !isValidTimeZone(a.tz)) throw zoneError(a.tz);
    const pick = <K extends 'people' | 'link' | 'booked_by' | 'notes'>(k: K): string | null => (a[k] != null ? a[k] || null : (known?.[k] ?? null));
    const tz = a.tz != null ? a.tz || null : (known?.tz ?? null);
    const given = a.starts_at ? toUtcIso(a.starts_at, tz || this.timezone()) : null;
    req(a.state != null || !given || known?.state !== 'cancelled', `Interview ${known?.id} is cancelled. Nothing was written. To rebook it with this time, pass state: "scheduled".`);
    const state = a.state ?? (given ? 'scheduled' : (known?.state ?? 'pending'));
    req(oneOf(INTERVIEW_STATES, state), `state must be ${INTERVIEW_STATES.join(' | ')}, got "${state}".`);
    req(!(state === 'pending' && given), 'A pending interview has no time yet: omit starts_at, or pass state: "scheduled" with it.');
    const starts_at = state === 'pending' ? null : given ?? known?.starts_at ?? null;
    req(state !== 'scheduled' || starts_at, 'A scheduled interview needs starts_at.');
    return { starts_at, tz, stage: a.stage, people: pick('people'), link: pick('link'), booked_by: pick('booked_by'), notes: pick('notes'), state };
  }

  // What an applied change leaves behind: a role note saying what happened (for the report), and the move to
  // interviewing when the interview is live and the status machine allows it from where the role is. A closed or
  // dropped role keeps its status, and so does a role an older event would reopen. The note is not an external event:
  // events_external is unique per source id, which a second change of one interview would break, so its evidence
  // names the interview and its calendar key instead, for whoever joins them.
  private afterInterviewChange(role: RoleRow, id: number, before: InterviewValues | null, after: InterviewValues, key: InterviewKey, when: InterviewTiming): void {
    const evidence = `interview:${id}${key.source ? ` ${key.source}/${key.source_account}/${key.source_id}` : ''}`;
    const { ts, received: received_at, run_id } = when;
    this.insertEvent({ role_id: role.id, category: 'interview_changed', actor: 'pipeline', reason: `Interview ${id} (${after.stage}) ${describeInterviewChange(before, after)}`, evidence, run_id, ts, received_at });
    if (after.state === 'cancelled' || role.status === 'interviewing') return;
    const ev: EventInput = { role_id: role.id, status: 'interviewing', actor: 'employer', reason: `Interview: ${after.stage}`, evidence: after.link || after.notes || null, run_id };
    if (this.projection(ev, ts).project) this.insertEvent({ ...ev, ts, received_at });
  }

  // before_json and after_json hold the interview's fields and the calendar key it is found by.
  private logInterviewChange(interview_id: number, before: LoggedInterview | null, after: LoggedInterview, when: InterviewTiming): void {
    this.run('INSERT INTO interview_changes(interview_id, occurred_at, received_at, run_id, before_json, after_json) VALUES(?, ?, ?, ?, ?, ?)',
      interview_id, when.ts, when.received, when.run_id, before && JSON.stringify(before), JSON.stringify(after));
  }

  // ---------- views ----------

  // Views show one card per linked group: duplicates are left out, and their events, questions and interviews count
  // toward the canonical role's card, judged by that card's status.
  openItems({ stale_after_days }: ArgsFor<'open_items'> = {}) {
    const cutoff = new Date(Date.now() - (stale_after_days ?? 14) * 864e5).toISOString();
    type Queued = Pick<RoleRow, 'id' | 'title' | 'url' | 'score'> & { company: string; question: string | null; blocked_by: string | null; last_event: string | null };
    type Booking = InterviewRow & { company: string; title: string };
    const all = this.q<Queued>(`
      SELECT r.id, c.name AS company, r.title, r.url, r.score,
        (SELECT question FROM events e WHERE e.role_id IN ${groupOf('r.id')} AND e.status = 'queued' ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS question,
        (SELECT blocked_by FROM events e WHERE e.role_id IN ${groupOf('r.id')} AND e.status = 'queued' ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS blocked_by
        , (SELECT MAX(ts) FROM events e WHERE e.role_id IN ${groupOf('r.id')}) AS last_event
      FROM roles r JOIN companies c ON c.id = r.company_id WHERE r.status = 'queued' AND ${isCard('r.id')} ORDER BY r.score DESC NULLS LAST, r.updated_at`);
    // A queued role with no events has last_event NULL, which compared false both ways; keep that.
    const queue = all.filter((r) => r.last_event != null && r.last_event >= cutoff);
    // question and blocked_by stay on a stale entry: a report for an earlier day can find one changed.
    const stale_queue = all.filter((r) => r.last_event != null && r.last_event < cutoff).map(({ id, company, title, last_event, question, blocked_by }) => ({ id, company, title, last_event, question, blocked_by }));
    const drafts = this.q<{ id: number; role_id: number | null; draft_id: string | null; created_at: string; company: string | null }>(`SELECT a.id, a.role_id, a.path_or_ref AS draft_id, a.created_at, c.name AS company FROM artifacts a
      LEFT JOIN roles r ON r.id = ${canonicalOf('a.role_id')} LEFT JOIN companies c ON c.id = r.company_id WHERE a.kind = 'gmail_draft' AND a.verified_at IS NULL`);
    const to_book = this.q<Booking>(`SELECT i.*, c.name AS company, r.title FROM interviews i JOIN roles r ON r.id = ${canonicalOf('i.role_id')} JOIN companies c ON c.id = r.company_id WHERE i.state = 'pending' AND r.status NOT IN ('closed', 'dropped')`);
    const upcoming = this.q<Booking>(`SELECT i.*, c.name AS company, r.title FROM interviews i JOIN roles r ON r.id = ${canonicalOf('i.role_id')} JOIN companies c ON c.id = r.company_id WHERE i.state = 'scheduled' AND i.starts_at >= ? AND r.status NOT IN ('closed', 'dropped') ORDER BY i.starts_at`, now());
    // Questions raised on roles outside the queue (e.g. an applied role that broke a filter).
    const questions = this.q<Pick<RoleRow, 'id' | 'title' | 'status'> & { company: string; question: string; ts: string }>(`SELECT r.id, c.name AS company, r.title, r.status, e.question, e.ts FROM roles r JOIN companies c ON c.id = r.company_id
      JOIN events e ON e.id = (SELECT id FROM events WHERE role_id IN ${groupOf('r.id')} ORDER BY ts DESC, id DESC LIMIT 1)
      WHERE e.question IS NOT NULL AND r.status NOT IN ('queued', 'dropped', 'closed') AND ${isCard('r.id')}`);
    return { queue, stale_queue, questions, unverified_drafts: drafts, interviews_to_book: to_book, upcoming_interviews: upcoming };
  }

  pipelineSummary({ stale_after_days }: ArgsFor<'pipeline_summary'> = {}) {
    type Listed = Pick<RoleRow, 'id' | 'title' | 'status' | 'updated_at'> & { company: string };
    const counts = Object.fromEntries(this.q<{ status: string | null; n: number }>(`SELECT status, COUNT(*) AS n FROM roles r WHERE ${isCard('r.id')} GROUP BY status`).map((r) => [r.status, r.n]));
    const cutoff = new Date(Date.now() - (stale_after_days ?? 14) * 864e5).toISOString();
    const stale = (r: Listed & { last_event: string | null }) => (r.last_event || r.updated_at) < cutoff;
    const list = (where: string, ...p: SQLInputValue[]) => this.q<Listed>(`SELECT r.id, c.name AS company, r.title, r.status, r.updated_at FROM roles r JOIN companies c ON c.id = r.company_id WHERE ${where} AND ${isCard('r.id')} ORDER BY r.updated_at DESC`, ...p);
    const queue = this.q<Listed & { last_event: string | null }>(`SELECT r.id, c.name AS company, r.title, r.status, r.updated_at, (SELECT MAX(ts) FROM events e WHERE e.role_id IN ${groupOf('r.id')}) AS last_event
      FROM roles r JOIN companies c ON c.id = r.company_id WHERE r.status = 'queued' AND ${isCard('r.id')} ORDER BY last_event DESC`);
    return {
      counts,
      live_processes: list("r.status IN ('interviewing', 'offer')"),
      awaiting_reply: list("r.status = 'applied'").length,
      rejections: this.q<{ id: number; company: string; title: string; ts: string; evidence: string | null }>(`SELECT r.id, c.name AS company, r.title, e.ts, e.evidence FROM roles r JOIN companies c ON c.id = r.company_id
        JOIN events e ON e.id = (SELECT id FROM events WHERE role_id IN ${groupOf('r.id')} AND status = 'closed' ORDER BY ts DESC, id DESC LIMIT 1)
        WHERE r.status = 'closed' AND e.outcome = 'rejected' AND ${isCard('r.id')} ORDER BY e.ts DESC`),
      queue: queue.filter((r) => !stale(r)),
      stale_queue: queue.filter(stale).map(({ id, company, title, updated_at, last_event }) => ({ id, company, title, last_activity: last_event || updated_at })),
    };
  }
}
