// Daily report (spec §9) and post-run audit (spec §11). Both are pure reads. Events and artifacts of a linked
// duplicate are attributed to its canonical role's card, under their own ids.

import type { SQLInputValue } from 'node:sqlite';
import type { CapabilitiesConfig } from './config.ts';
import type { ArtifactRow, EventRow, SourceRow } from './db.ts';
import { lintProse } from './lint.ts';
import { formatLocal, isValidTimeZone, localDate } from './time.ts';
import type { ArgsFor } from './tools.ts';
import type { Scope, Tracker } from './tracker.ts';
import { canonicalOf, LIVE } from './tracker.ts';
import { parseJson } from './util.ts';

// card_id is the canonical role an event or artifact is attributed to; role_id stays the row it was written on.
type ScopedEvent = EventRow & { card_id: number; title: string; url: string | null; industry: string | null; company_id: number; company: string };
type ScopedArtifact = ArtifactRow & { card_id: number | null; company: string | null };

export interface AuditFailure {
  check: string;
  role_id?: number | null;
  artifact_id?: number;
  detail: string;
}

// The events a scope covers, found by column col: when they happened (ts), or, for events from outside that were read
// during the scope but happened earlier, when they were received (received_at).
function eventsAt(t: Tracker, scope: Scope, col: 'ts' | 'received_at', where = '1 = 1', ...params: SQLInputValue[]): ScopedEvent[] {
  const [cond, p] = scope.rows('e', col);
  return t.q<ScopedEvent>(
    `SELECT e.*, r.id AS card_id, r.title, r.url, r.industry, r.company_id, c.name AS company FROM events e JOIN roles r ON r.id = ${canonicalOf('e.role_id')} JOIN companies c ON c.id = r.company_id
     WHERE ${cond} AND ${where} ORDER BY e.ts, e.id`,
    ...p, ...params,
  );
}

const eventsIn = (t: Tracker, scope: Scope, where = '1 = 1', ...params: SQLInputValue[]) => eventsAt(t, scope, 'ts', where, ...params);

// In JS because ts text is not one format ('…:00Z' from older releases, '…:00.000Z' from now), so SQL order is not time order.
const timeOf = (iso: string) => (Number.isNaN(Date.parse(iso)) ? Number.NEGATIVE_INFINITY : Date.parse(iso));
const byTime = (a: Pick<EventRow, 'id' | 'ts'>, b: Pick<EventRow, 'id' | 'ts'>) => timeOf(a.ts) - timeOf(b.ts) || a.id - b.id;

// Events dated by when they happened, except those from outside, which are found by when they were received: a
// rejection read today may be days old, and reading it again in a later run adds no event.
function eventsOrReceived(t: Tracker, scope: Scope, where: string, ...params: SQLInputValue[]): ScopedEvent[] {
  const own = eventsIn(t, scope, `e.source IS NULL AND ${where}`, ...params);
  const outside = eventsAt(t, scope, 'received_at', `e.source IS NOT NULL AND ${where}`, ...params);
  return [...own, ...outside].sort(byTime);
}

function artifactsIn(t: Tracker, scope: Scope, where = '1 = 1', ...params: SQLInputValue[]): ScopedArtifact[] {
  const [cond, p] = scope.rows('a', 'created_at');
  return t.q<ScopedArtifact>(
    `SELECT a.*, r.id AS card_id, c.name AS company FROM artifacts a LEFT JOIN roles r ON r.id = ${canonicalOf('a.role_id')} LEFT JOIN companies c ON c.id = r.company_id
     WHERE ${cond} AND ${where} ORDER BY a.id`,
    ...p, ...params,
  );
}

// Canonical role ids of the queued roles, in open_items order (fresh ones, then the 14+ day ones). new_or_changed:
// the action (queued, question, blocked_by) changed in the report's scope. waiting: everything else, stale included.
// stale_waiting: the part of waiting with no activity for 14+ days.
type OpenItems = ReturnType<Tracker['openItems']>;

export interface QueueActivity {
  new_or_changed: number[];
  waiting: number[];
  stale_waiting: number[];
}

// A queued role asks one thing of the user, which is (queued, question, blocked_by). Its events, in the order of
// their times across the whole group, are replayed from the first: the action changed at an event if the role was not
// queued before it or the question or blocker differs from the previous queued event. Events before the scope only
// set what "previous" is; scores, URLs and notes are not part of the action. Another status takes the role out of the
// queue, so a later queued event is a new entry.
function changedInScope(t: Tracker, scope: Scope, cardIds: number[]): Set<number> {
  if (!cardIds.length) return new Set();
  // Not canonicalOf in the WHERE: the group's ids as a list lets events_role find the rows.
  const marks = cardIds.map(() => '?').join(', ');
  const [cond, p] = scope.rows('e', 'ts');
  const rows = t.q<Pick<EventRow, 'id' | 'ts' | 'status' | 'question' | 'blocked_by'> & { card_id: number; in_scope: number }>(
    `SELECT e.id, e.ts, e.status, e.question, e.blocked_by, ${canonicalOf('e.role_id')} AS card_id, CASE WHEN ${cond} THEN 1 ELSE 0 END AS in_scope FROM events e
     WHERE e.status IS NOT NULL AND (e.role_id IN (${marks}) OR e.role_id IN (SELECT duplicate_role_id FROM role_links WHERE canonical_role_id IN (${marks})))`,
    ...p, ...cardIds, ...cardIds,
  );
  rows.sort(byTime);
  const previous = new Map<number, string | null>();
  const changed = new Set<number>();
  for (const e of rows) {
    if (e.status !== 'queued') {
      previous.set(e.card_id, null);
      continue;
    }
    const fingerprint = JSON.stringify([e.question, e.blocked_by]);
    if (e.in_scope && previous.get(e.card_id) !== fingerprint) changed.add(e.card_id);
    previous.set(e.card_id, fingerprint);
  }
  return changed;
}

export function queueActivity(t: Tracker, scope: Scope, items: OpenItems = t.openItems()): QueueActivity {
  const { queue, stale_queue } = items;
  const ids = [...queue, ...stale_queue].map((r) => r.id);
  const changed = changedInScope(t, scope, ids);
  const stale = new Set(stale_queue.map((r) => r.id));
  const waiting = ids.filter((id) => !changed.has(id));
  return { new_or_changed: ids.filter((id) => changed.has(id)), waiting, stale_waiting: waiting.filter((id) => stale.has(id)) };
}

// The local day of a stored time; text that is not a time (legacy free text) is shown as written.
const localDay = (iso: string | null, tz: string) => (iso == null || Number.isNaN(Date.parse(iso)) ? String(iso) : localDate(Date.parse(iso), tz));

const CAPABILITY_LABELS: Readonly<Record<string, string>> = { browser: 'browser', local_folder: 'local folder', gmail: 'Gmail', calendar: 'Calendar', linkedin: 'LinkedIn' };

// What a queued role asks of the user: its question, else its blocker, else the decision itself.
const ask = (q: { question: string | null; blocked_by: string | null }) => q.question || (q.blocked_by === 'browser' ? 'Needs a browser session to apply.' : q.blocked_by ? `Blocked by ${q.blocked_by}.` : 'Apply or drop?');

// The "Needs you" section: what changed in this scope in detail, then the other open actions whatever their age, then
// the unchanged queue. An old queue decision is never "new"; it is waiting.
function needsYou(items: OpenItems, activity: QueueActivity, audit: ReturnType<typeof runAudit>, tz: string): string[] {
  const queued = new Map([...items.queue, ...items.stale_queue].map((q) => [q.id, q]));
  const changedNow = activity.new_or_changed.flatMap((id) => queued.get(id) ?? []);
  const others: string[] = [];
  for (const q of items.questions) others.push(`**${q.company}**, ${q.title} (role ${q.id}, ${q.status}): ${q.question}`);
  for (const d of items.unverified_drafts) others.push(`Draft ${d.draft_id}${d.company ? ` (${d.company})` : ''} was not confirmed by read-back. Check Gmail drafts.`);
  for (const i of items.interviews_to_book) others.push(`Book **${i.company}** ${i.stage}${i.link ? `: ${i.link}` : ''}`);
  for (const f of audit.failures) others.push(`Audit: ${f.detail}`);
  if (!changedNow.length && !others.length && !activity.waiting.length) return [];
  const numbered = (lines: string[]) => lines.map((n, i) => `${i + 1}. ${n}`);
  const out = ['## Needs you', ''];
  if (changedNow.length) out.push('### New or changed today', '', ...numbered(changedNow.map((q) => `**${q.company}**, ${q.title} (role ${q.id}): ${ask(q)} To apply: \`/job-tracker:apply ${q.id}\``)), '');
  if (others.length) out.push('### Other open actions', '', ...numbered(others), '');
  if (activity.waiting.length) {
    const staleIds = new Set(activity.stale_waiting);
    const stale = items.stale_queue.filter((q) => staleIds.has(q.id));
    out.push(`### Still waiting (${activity.waiting.length})`, '');
    out.push(`${activity.waiting.length} queued role(s) are unchanged in this report, ${stale.length} of them with no activity for 14+ days. Nothing here was researched or decided today. \`/job-tracker:board\` or \`/job-tracker:status\` lists them all.`, '');
    for (const q of stale) out.push(`- **${q.company}**, ${q.title} (role ${q.id}, 14+ days, last activity ${localDay(q.last_event, tz)}): ${ask(q)}`);
    if (stale.length) out.push('');
  }
  return out;
}

export function renderReport(t: Tracker, { date, run_id, headline }: ArgsFor<'render_report'>) {
  const scope = t.scope({ date, run_id });
  const caps = parseJson<CapabilitiesConfig | null>(scope.run?.capabilities, null);
  const items = t.openItems();
  const activity = queueActivity(t, scope, items);
  const tz = t.timezone();
  const audit = runAudit(t, { date, run_id });
  const out = [`# Daily report · ${date}`, ''];

  // Only what the plugin submitted; an application the user recorded (e.g. on the board, actor 'user') is theirs, and
  // so is one found in a mailbox or board afterwards (source set): a receipt is not a submission.
  const applied = eventsIn(t, scope, "e.status = 'applied' AND e.actor = 'pipeline' AND e.source IS NULL");
  // Only the board can record applied without confirmation text. Listing these lets the user spot one they didn't make.
  const selfReported = eventsIn(t, scope, "e.status = 'applied' AND e.actor = 'user' AND (e.evidence IS NULL OR trim(e.evidence) = '')");
  // An application found in a mailbox or on a board: dated by when it happened, reported in the scope that received it.
  // Replaying it in a later run adds no event, so it is not announced again. Every new acknowledgement is recorded
  // this way, including the employer's receipt for a submission the plugin made (in this run or an earlier one, on any
  // row of the card's group): that one already has its confirmation, so listing it here would claim a second,
  // outside application.
  const recorded = eventsAt(t, scope, 'received_at', `e.status = 'applied' AND e.source IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM events s WHERE s.status = 'applied' AND s.actor = 'pipeline' AND s.source IS NULL
      AND (s.role_id = r.id OR s.role_id IN (SELECT duplicate_role_id FROM role_links WHERE canonical_role_id = r.id)))`);
  // A calendar or mail change to a booking is news when it arrives, whenever the meeting itself was changed.
  const bookingChanges = eventsAt(t, scope, 'received_at', "e.category = 'interview_changed'");
  const replies = eventsOrReceived(t, scope, "e.actor = 'employer'");
  const dropped = eventsOrReceived(t, scope, "e.status = 'dropped' AND e.actor != 'import'");
  const assessed = new Set(eventsIn(t, scope, "e.status IN ('verified', 'scored', 'dropped') AND e.actor != 'import'").map((e) => e.card_id)).size;
  const drafts = artifactsIn(t, scope, "a.kind = 'gmail_draft'");
  const verifiedDrafts = drafts.filter((d) => d.verified_at);

  if (headline) out.push(`**${headline.trim()}**`, '');

  // Capabilities: what was missing and what was queued because of it.
  const missing: string[] = [];
  if (caps) {
    if (!caps.browser) missing.push('browser');
    if (caps.local_folder === false) missing.push('local_folder');
    for (const [k, v] of Object.entries(caps.connectors || {})) if (!v) missing.push(k);
  }
  const blockedQueue = items.queue.filter((q) => q.blocked_by === 'browser' || q.blocked_by === 'login');

  out.push(...needsYou(items, activity, audit, tz));

  // 2. Interviews
  if (items.upcoming_interviews.length || items.interviews_to_book.length || bookingChanges.length) {
    out.push('## Interviews', '');
    for (const i of items.upcoming_interviews) {
      const zone = isValidTimeZone(i.tz) ? i.tz : tz;
      // The upcoming query excludes null starts_at; 'TBD' only satisfies the column's nullable type.
      out.push(`- ${i.starts_at ? formatLocal(i.starts_at, zone) : 'TBD'} (${zone}): **${i.company}**, ${i.stage}${i.people ? ` with ${i.people}` : ''}`);
    }
    for (const i of items.interviews_to_book) out.push(`- To book: **${i.company}**, ${i.stage}${i.link ? ` (${i.link})` : ''}`);
    for (const e of bookingChanges) out.push(`- Booking change: **${e.company}**, ${e.title}: ${e.reason}`);
    out.push('');
  }

  // 3. Applied today (only with captured confirmation), then what the user marked applied on the board, then what was
  // found elsewhere (not a submission by the plugin)
  if (applied.length || selfReported.length || recorded.length) {
    out.push('## Applied', '');
    for (const e of applied) out.push(`- **${e.company}**, ${e.title}. Confirmation: "${String(e.evidence).replace(/\s+/g, ' ').slice(0, 140)}"`);
    for (const e of selfReported) out.push(`- **${e.company}**, ${e.title}. Marked applied by you on the board, without confirmation text.`);
    for (const e of recorded) out.push(`- **${e.company}**, ${e.title}. Recorded from ${e.source}, applied ${localDay(e.ts, tz)}: "${String(e.evidence ?? '').replace(/\s+/g, ' ').slice(0, 140)}"`);
    out.push('');
  }

  // 4. Replies
  if (replies.length || verifiedDrafts.length) {
    out.push('## Replies', '');
    for (const e of replies) {
      // An event from outside says when it happened: it may be older than the report that finds it.
      const when = e.source ? localDay(e.ts, tz) : '';
      const label = e.status === 'closed' ? `closed (${e.outcome}${when ? `, ${when}` : ''})` : `${e.status || 'note'}${when ? ` (${when})` : ''}`;
      out.push(`- **${e.company}**, ${e.title}: ${label}. ${e.reason}${e.evidence && e.status === 'closed' ? ` Feedback: "${String(e.evidence).replace(/\s+/g, ' ').slice(0, 300)}"` : ''}`);
    }
    if (verifiedDrafts.length) out.push(`- Reply drafts created and read back: ${verifiedDrafts.map((d) => d.path_or_ref).join(', ')}`);
    out.push('');
  }

  // 5. Dropped, grouped
  if (dropped.length) {
    out.push('## Dropped', '');
    const groups = new Map<string, string[]>();
    for (const e of dropped) {
      // Only the board can drop without evidence (validateEvent), and only as the user.
      const key = e.actor === 'user' && !e.evidence?.trim() ? 'by you on the board' : e.category || 'other';
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(`${e.company} (${e.reason}${e.source ? `, ${localDay(e.ts, tz)}` : ''})`);
    }
    for (const [k, v] of groups) out.push(`- ${k}: ${v.join('; ')}`);
    out.push('');
  }

  // 6. Sources: only changes
  const [inWindow, windowParams] = scope.window('status_changed_at');
  const changed = t.q<SourceRow>(`SELECT * FROM sources WHERE ${inWindow}`, ...windowParams);
  if (changed.length || missing.length) {
    out.push('## Sources', '');
    if (missing.length) {
      const names = missing.map((m) => CAPABILITY_LABELS[m] || m).join(', ');
      out.push(`- Missing this run: ${names}.${blockedQueue.length ? ` Queued because of it: ${blockedQueue.map((q) => `${q.company} (role ${q.id})`).join(', ')}.` : ' Nothing was queued because of it.'}`);
    }
    for (const s of changed) out.push(`- ${s.name}: now ${s.status}${s.last_error ? ` (${s.last_error})` : ''}`);
    out.push('');
  }

  out.push('| | |', '|---|---|');
  out.push(`| Applications submitted | ${applied.length} |`);
  out.push(`| Queued for you | ${activity.new_or_changed.length + activity.waiting.length} |`);
  out.push(`| New or changed today | ${activity.new_or_changed.length} |`);
  out.push(`| Applications recorded from mail or boards | ${recorded.length} |`);
  out.push(`| Roles assessed today | ${assessed} |`);
  out.push(`| Drafts created (read back) | ${drafts.length} (${verifiedDrafts.length}) |`);
  out.push(`| Emails or messages sent | 0 (sending is blocked) |`);
  out.push(`| Audit | ${audit.ok ? 'pass' : `${audit.failures.length} failure(s)`} |`);
  return { date, markdown: out.join('\n'), audit_ok: audit.ok, queue_activity: activity };
}

export function runAudit(t: Tracker, { date, run_id }: ArgsFor<'audit'>) {
  const scope = t.scope({ date, run_id });
  const failures: AuditFailure[] = [];
  const excluded = (t.section('filters').excluded_industries || []).map((s) => s.toLowerCase());
  if (excluded.length) {
    const touched = eventsIn(t, scope, "e.status IN ('scored', 'queued', 'applied')").filter((e) => e.industry && excluded.some((x) => e.industry?.toLowerCase().includes(x)));
    for (const e of touched) failures.push({ check: 'excluded_industry', role_id: e.card_id, detail: `${e.company} (${e.industry}) reached ${e.status} despite the excluded-industries filter.` });
  }
  for (const e of eventsIn(t, scope, "e.status = 'dropped' AND (e.evidence IS NULL OR trim(e.evidence) = '') AND e.actor != 'user'"))
    failures.push({ check: 'drop_without_evidence', role_id: e.card_id, detail: `Drop of ${e.company} has no evidence.` });
  // The board's self-reported applications are the user's word, listed in the report instead.
  for (const e of eventsIn(t, scope, "e.status = 'applied' AND (e.evidence IS NULL OR trim(e.evidence) = '') AND e.actor != 'user'"))
    failures.push({ check: 'applied_without_confirmation', role_id: e.card_id, detail: `${e.company} marked applied without confirmation text.` });
  for (const e of eventsIn(t, scope, "e.status = 'verified'")) {
    // The row the event was written on is the one it verified.
    const r = t.mustRole(e.role_id);
    if (!r.verified_at || !r.location_line) failures.push({ check: 'verified_without_location', role_id: e.card_id, detail: `${e.company} verified without a location line.` });
  }
  const maxWords = t.section('writing').max_words_cover_note;
  for (const a of artifactsIn(t, scope, "a.kind IN ('cover_note', 'form_answers', 'gmail_draft') AND a.content IS NOT NULL")) {
    const lint = lintProse(a.content, { max_words: a.kind === 'cover_note' ? maxWords : undefined });
    if (!lint.ok) {
      const kinds = [...new Set(lint.issues.filter((i) => i.severity === 'error').map((i) => i.kind))].join(', ');
      failures.push({ check: 'prose_lint', artifact_id: a.id, role_id: a.card_id, detail: `${a.kind} ${a.id}${a.company ? ` (${a.company})` : ''} fails lint: ${kinds}.` });
    }
  }
  for (const a of artifactsIn(t, scope, "a.kind = 'gmail_draft' AND a.verified_at IS NULL"))
    failures.push({ check: 'draft_not_read_back', artifact_id: a.id, detail: `Gmail draft ${a.path_or_ref} not read back.` });
  for (const e of eventsIn(t, scope, `e.status IN (${LIVE.map(() => '?').join(', ')})`, ...LIVE)) {
    const c = t.one<{ no_cold_apply: number; no_cold_apply_reason: string | null }>('SELECT no_cold_apply, no_cold_apply_reason FROM companies WHERE id = ?', e.company_id);
    if (c?.no_cold_apply && e.status === 'applied' && e.actor === 'pipeline' && !e.source)
      failures.push({ check: 'no_cold_apply', role_id: e.card_id, detail: `Applied to ${e.company} despite no_cold_apply (${c.no_cold_apply_reason}).` });
  }
  return { date: run_id != null ? null : (date ?? null), run_id: run_id ?? null, ok: failures.length === 0, failures };
}
