// Daily report (spec §9) and post-run audit (spec §11). Both are pure reads. Events and artifacts of a linked
// duplicate are attributed to its canonical role's card, under their own ids.

import type { SQLInputValue } from 'node:sqlite';
import type { CapabilitiesConfig } from './config.ts';
import type { ArtifactRow, EventRow, SourceRow } from './db.ts';
import { lintProse } from './lint.ts';
import { formatLocal, isValidTimeZone } from './time.ts';
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

function eventsIn(t: Tracker, scope: Scope, where = '1 = 1', ...params: SQLInputValue[]): ScopedEvent[] {
  const [cond, p] = scope.rows('e', 'ts');
  return t.q<ScopedEvent>(
    `SELECT e.*, r.id AS card_id, r.title, r.url, r.industry, r.company_id, c.name AS company FROM events e JOIN roles r ON r.id = ${canonicalOf('e.role_id')} JOIN companies c ON c.id = r.company_id
     WHERE ${cond} AND ${where} ORDER BY e.ts, e.id`,
    ...p, ...params,
  );
}

function artifactsIn(t: Tracker, scope: Scope, where = '1 = 1', ...params: SQLInputValue[]): ScopedArtifact[] {
  const [cond, p] = scope.rows('a', 'created_at');
  return t.q<ScopedArtifact>(
    `SELECT a.*, r.id AS card_id, c.name AS company FROM artifacts a LEFT JOIN roles r ON r.id = ${canonicalOf('a.role_id')} LEFT JOIN companies c ON c.id = r.company_id
     WHERE ${cond} AND ${where} ORDER BY a.id`,
    ...p, ...params,
  );
}

const CAPABILITY_LABELS: Readonly<Record<string, string>> = { browser: 'browser', local_folder: 'local folder', gmail: 'Gmail', calendar: 'Calendar', linkedin: 'LinkedIn' };

export function renderReport(t: Tracker, { date, run_id, headline }: ArgsFor<'render_report'>) {
  const scope = t.scope({ date, run_id });
  const caps = parseJson<CapabilitiesConfig | null>(scope.run?.capabilities, null);
  const items = t.openItems();
  const tz = t.timezone();
  const audit = runAudit(t, { date, run_id });
  const out = [`# Daily report · ${date}`, ''];

  // Only what the plugin submitted; an application the user recorded (e.g. on the board, actor 'user') is theirs, and
  // so is one found in a mailbox or board afterwards (source set): a receipt is not a submission.
  const applied = eventsIn(t, scope, "e.status = 'applied' AND e.actor = 'pipeline' AND e.source IS NULL");
  // Only the board can record applied without confirmation text. Listing these lets the user spot one they didn't make.
  const selfReported = eventsIn(t, scope, "e.status = 'applied' AND e.actor = 'user' AND (e.evidence IS NULL OR trim(e.evidence) = '')");
  const replies = eventsIn(t, scope, "e.actor = 'employer'");
  const dropped = eventsIn(t, scope, "e.status = 'dropped' AND e.actor != 'import'");
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

  // 1. Needs you
  const needs: string[] = [];
  for (const q of items.queue) {
    const why = q.question || (q.blocked_by === 'browser' ? 'Needs a browser session to apply.' : 'Apply or drop?');
    needs.push(`**${q.company}**, ${q.title} (role ${q.id}): ${why} To apply: \`/job-tracker:apply ${q.id}\``);
  }
  for (const q of items.questions) needs.push(`**${q.company}**, ${q.title} (role ${q.id}, ${q.status}): ${q.question}`);
  for (const d of items.unverified_drafts) needs.push(`Draft ${d.draft_id}${d.company ? ` (${d.company})` : ''} was not confirmed by read-back. Check Gmail drafts.`);
  for (const i of items.interviews_to_book) needs.push(`Book **${i.company}** ${i.stage}${i.link ? `: ${i.link}` : ''}`);
  for (const f of audit.failures) needs.push(`Audit: ${f.detail}`);
  if (items.stale_queue.length) needs.push(`${items.stale_queue.length} queued role(s) untouched for 14+ days. Run /job-tracker:status to apply or drop them.`);
  if (needs.length) out.push('## Needs you', '', ...needs.map((n, i) => `${i + 1}. ${n}`), '');

  // 2. Interviews
  if (items.upcoming_interviews.length || items.interviews_to_book.length) {
    out.push('## Interviews', '');
    for (const i of items.upcoming_interviews) {
      const zone = isValidTimeZone(i.tz) ? i.tz : tz;
      // The upcoming query excludes null starts_at; 'TBD' only satisfies the column's nullable type.
      out.push(`- ${i.starts_at ? formatLocal(i.starts_at, zone) : 'TBD'} (${zone}): **${i.company}**, ${i.stage}${i.people ? ` with ${i.people}` : ''}`);
    }
    for (const i of items.interviews_to_book) out.push(`- To book: **${i.company}**, ${i.stage}${i.link ? ` (${i.link})` : ''}`);
    out.push('');
  }

  // 3. Applied today (only with captured confirmation), then what the user marked applied on the board
  if (applied.length || selfReported.length) {
    out.push('## Applied', '');
    for (const e of applied) out.push(`- **${e.company}**, ${e.title}. Confirmation: "${String(e.evidence).replace(/\s+/g, ' ').slice(0, 140)}"`);
    for (const e of selfReported) out.push(`- **${e.company}**, ${e.title}. Marked applied by you on the board, without confirmation text.`);
    out.push('');
  }

  // 4. Replies
  if (replies.length || verifiedDrafts.length) {
    out.push('## Replies', '');
    for (const e of replies) {
      const label = e.status === 'closed' ? `closed (${e.outcome})` : e.status || 'note';
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
      group.push(`${e.company} (${e.reason})`);
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
  out.push(`| Queued for you | ${items.queue.length} |`);
  out.push(`| Roles assessed today | ${assessed} |`);
  out.push(`| Drafts created (read back) | ${drafts.length} (${verifiedDrafts.length}) |`);
  out.push(`| Emails or messages sent | 0 (sending is blocked) |`);
  out.push(`| Audit | ${audit.ok ? 'pass' : `${audit.failures.length} failure(s)`} |`);
  return { date, markdown: out.join('\n'), audit_ok: audit.ok };
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
