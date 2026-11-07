// One-off migration from the manual markdown pipeline (spec §13). Imported events bypass the state
// machine (history is what it is) but keep the original row as evidence.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RoleRow } from './db.ts';
import { tx } from './db.ts';
import { ToolError } from './errors.ts';
import { normalizeName } from './fuzzy.ts';
import { urlIdentity } from './posting.ts';
import type { ArgsFor } from './tools.ts';
import type { Company, Tracker } from './tracker.ts';
import { isCard } from './tracker.ts';
import { oneOf } from './util.ts';

// A queue note: the file name, its markdown, and (when read from disk) its modification time.
export interface LegacyQueueFile {
  filename: string;
  content: string;
  mtime?: number;
}

interface Mapped {
  status: string | null;
  outcome?: string | null;
}

interface LogRow {
  date: string;
  suffix: string;
  company: string;
  role: string;
  source: string;
  action: string;
  status: string;
  raw: string;
}

const strip = (s: string | null | undefined) =>
  String(s || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](\s|$)/g, '$1$2')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F2FF}]|\u{FE0F}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// Ordered: first match wins. Outcomes beat intents; "awaiting reply" is an application, "awaiting <person>" is the queue.
const STATUS_MAP: [RegExp, Mapped][] = [
  [/reject/i, { status: 'closed', outcome: 'rejected' }],
  [/withdr[ae]w/i, { status: 'closed', outcome: 'withdrawn' }],
  [/expired|role closed|posting (?:closed|gone|removed)|no longer (?:open|available|listed)/i, { status: 'closed', outcome: 'role_closed' }],
  [/\boffer\b/i, { status: 'offer' }],
  [/interview|round|book the slot|confirm the invite|scheduled|booked/i, { status: 'interviewing' }],
  [/awaiting (?:response|reply|replies|feedback|outcome|ack)|submitted|^applied|auto-applied|sent ✉|sent —|holding note/i, { status: 'applied' }],
  [/awaiting intros?|intro (?:requested|pending|open)/i, { status: null }],
  [/drop|no contact|not contacted|none contacted|not applying|skipped/i, { status: 'dropped' }],
  [/queued|parked|flagged|decides|decide|needs\b|awaiting|draft (?:ready|awaiting)|blocked|still queued|your call/i, { status: 'queued' }],
  [/^closed\b/i, { status: 'closed', outcome: null }],
];

export function mapStatus(cell: string): Mapped {
  const s = strip(cell);
  for (const [re, out] of STATUS_MAP) if (re.test(s)) return out;
  return { status: null };
}

function splitRow(line: string): LogRow | null {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(' | ').map((c) => c.trim());
  if (cells.length < 4) return null;
  // cells has at least four entries from here on.
  const date = (cells[0]!.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
  if (!date) return null;
  const suffix = cells[0]!.slice(10).trim();
  const status = cells[cells.length - 1]!;
  return {
    date,
    suffix,
    company: cells[1]!,
    role: cells[2]!,
    source: cells.length >= 6 ? cells[3]! : '',
    action: cells.slice(cells.length >= 6 ? 4 : 3, -1).join(' | '),
    status,
    raw: line.trim(),
  };
}

const PAREN_DROP = /^(?:via|client|applied|queued|ashby|greenhouse|lever|workable|remote|hybrid|onsite|on-site|f\/m\/d|m\/f\/d|contract|freelance|\d)/i;

export function cleanCompany(cell: string): { name: string; aliases: string[] } {
  let s = strip(cell);
  const aliases: string[] = [];
  s = s.replace(/\(([^)]*)\)/g, (_, inner: string) => {
    if (!PAREN_DROP.test(inner.trim()) && !/[$€£:]/.test(inner) && inner.length < 40) aliases.push(inner.trim());
    return ' ';
  });
  const parts = s.split(/\s+\/\s+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { name: parts[0] || '', aliases: [...aliases, ...parts.slice(1)] };
}

export function cleanTitle(cell: string): string {
  let s = strip(cell).split(/ — | – | -- /)[0] ?? '';
  s = s.replace(/\(([^)]*)\)/g, (m, inner: string) => (/[$€£\d]|applied|queued|ashby|remote|hybrid|onsite|via|greenhouse|lever|location/i.test(inner) ? ' ' : m));
  s = s.replace(/\s+/g, ' ').replace(/[,;:.\s]+$/, '').trim();
  return s.length > 120 ? s.slice(0, 120) : s;
}

const BOLD = /\*\*([^*]{2,60}?)\*\*/g;
const NOT_A_COMPANY = /\b(?:rule|drop|dropped|why|note|reason|required|only|not|no|none|all|both|every|today|run|sweep|source|backend|frontend|remote|hybrid|onsite|location|salary|stack|crypto|defen[cs]e|gambling|staff|senior|lead|engineer|product|full[- ]stack|founding|role|roles|job|jobs|years?|uk|us|eu)\b/i;

function groupCompanies(row: LogRow): { name: string; title: string }[] {
  const names: { name: string; title: string }[] = [];
  for (const cell of [row.role, row.action]) {
    for (const m of cell.matchAll(BOLD)) {
      const n = strip(m[1]).replace(/[:.,;]+$/, '');
      if (n.split(' ').length <= 5 && /^[A-Z0-9]/.test(n) && !NOT_A_COMPANY.test(n) && !/[€$£%]/.test(n)) {
        const after = cell.slice(m.index + m[0].length).replace(/^\s*[,:—-]?\s*/, '');
        names.push({ name: n, title: cleanTitle(after.split(/[.(;]/)[0] ?? '') || '(unspecified)' });
      }
    }
    if (names.length) break;
  }
  if (!names.length && / · /.test(row.role)) {
    for (const part of row.role.split(' · ')) {
      const n = strip(part).replace(/\(.*?\)/g, '').trim();
      if (n && n.length <= 40) names.push({ name: n, title: '(unspecified)' });
    }
  }
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(normalizeName(n.name)) && seen.add(normalizeName(n.name)));
}

const SUFFIX_RANK = (s: string) => (!s ? 0 : /pm/i.test(s) ? 1 : /2nd/i.test(s) ? 2 : /3rd/i.test(s) ? 3 : /follow/i.test(s) ? 4 : 5);
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GROUP_DROP = /drop|not shortlisted|no contact|excluded industr|not touched/i;
const OUTCOME_ROW = /repl|interview|inbox|mail/i;
const NO_COLD = /^[—–-]+\s*no[ -]cold[ -]apply:?\s*/i;
const OUTCOME_SENTENCE: [RegExp, Mapped][] = [
  [/withdr[ae]w/i, { status: 'closed', outcome: 'withdrawn' }],
  [/reject|not moving forward|position (?:was )?filled|declined/i, { status: 'closed', outcome: 'rejected' }],
  [/closed the|role (?:was )?closed|won't go ahead|no longer hiring/i, { status: 'closed', outcome: 'role_closed' }],
  [/interview|next round|round booked|booked|call (?:today|with)|hiring[- ]manager|stage/i, { status: 'interviewing' }],
];
const INTRO = /awaiting intros?|intro (?:requested|pending|open|sent)|requested (?:an )?intro|recruiter (?:process|screen)|via recruiter/i;

export function parseAppliedLog(markdown: string): (LogRow & { order: number })[] {
  const rows: (LogRow & { order: number })[] = [];
  let order = 0;
  for (const line of String(markdown).split('\n')) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const r = splitRow(line);
    if (r) rows.push({ ...r, order: order++ });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || SUFFIX_RANK(a.suffix) - SUFFIX_RANK(b.suffix) || a.order - b.order);
  return rows;
}

export function importLegacy(t: Tracker, args: ArgsFor<'import_legacy'>) {
  let { applied_log, preferences, queue, documents, path } = args;
  if (path) {
    const p = path.replace(/^~(?=\/)/, process.env.HOME || '');
    const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined);
    applied_log ??= read(join(p, 'applied-log.md'));
    preferences ??= read(join(p, 'outreach-preferences.md'));
    if (!queue && existsSync(join(p, 'queue'))) {
      queue = readdirSync(join(p, 'queue'))
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .map((f) => ({ filename: f, content: readFileSync(join(p, 'queue', f), 'utf8'), mtime: statSync(join(p, 'queue', f)).mtimeMs }));
    }
    documents ??= {
      profile: read(join(dirname(p), 'profile.md')) ?? read(join(p, 'profile.md')),
      stories: read(join(dirname(p), 'interview-stories.md')) ?? read(join(p, 'interview-stories.md')),
      'reusable-answers': read(join(p, 'reusable-answers.md')) ?? read(join(dirname(p), 'reusable-answers.md')),
    };
  }
  const stats = { rows: 0, meta_rows_skipped: 0, outcomes_from_meta: 0, events: 0, companies: 0, roles: 0, notes: 0, group_drops: 0, rules: 0, queue: 0, queue_skipped: 0, documents: 0, no_cold_apply: [] as string[], unparsed: [] as string[] };
  const companyCount = () => t.one<{ n: number }>('SELECT COUNT(*) AS n FROM companies')?.n ?? 0;

  const roleFor = (companyName: string, aliases: string[], title: string, url?: string | null) => {
    // An exact URL or ATS posting decides first, as everywhere: rows of one linked group are one role, and
    // independent rows are a conflict the user resolves before importing.
    const exact = url ? t.exactGroups(urlIdentity(url)) : [];
    if (exact.length > 1) throw new ToolError(`A queue note's posting matches roles ${exact.join(', ')}. Nothing was imported. Check them with get_role, link them with link_duplicate_role if they are one posting, then import again.`);
    const before = companyCount();
    const { company } = t.upsertCompany({ name: companyName, aliases, url });
    if (companyCount() > before) stats.companies++;
    // A linked duplicate is its canonical role's history, not a role to attach to.
    const roles = t.q<RoleRow>(`SELECT * FROM roles r WHERE company_id = ? AND ${isCard('r.id')}`, company.id);
    const nt = normalizeName(title);
    const hit = exact[0] === undefined ? undefined : t.mustRole(exact[0]);
    // Matching on the title is allowed only in this one-off import of the user's own log, whose rows name roles by
    // title and carry no URL. Everywhere else a same title is only a candidate (upsert_role's possible_role_ids).
    const role = hit || roles.find((r) => normalizeName(r.title) === nt) ||
      roles.find((r) => nt && normalizeName(r.title) && (normalizeName(r.title).startsWith(nt) || nt.startsWith(normalizeName(r.title))));
    return { company: hit ? t.mustCompany(hit.company_id) : company, role, roles };
  };
  const newRole = (company: Company, title: string, url: string | null | undefined, source: string, ts: string) => {
    const r = t.run(`INSERT INTO roles(company_id, title, url, source, first_seen, updated_at, status) VALUES(?, ?, ?, ?, ?, ?, NULL)`, company.id, title || '(unspecified)', url || null, source || 'legacy', ts, ts);
    stats.roles++;
    const id = Number(r.lastInsertRowid);
    if (url) t.indexRoleUrls(id, [url]);
    return t.mustRole(id);
  };
  const event = (role: RoleRow, ts: string, mapped: Mapped, reason: string, evidence: string | null | undefined) => {
    t.insertEvent({ role_id: role.id, ts, status: mapped.status, outcome: mapped.outcome ?? null, actor: 'import', reason, evidence: evidence?.slice(0, 2000) ?? null });
    stats.events++;
    if (!mapped.status) stats.notes++;
  };

  // Meta rows like "— replies received —" carry outcomes in prose: "**Acme rejected** (...)".
  // Only companies already known get an event, and only the sentence that names them is read.
  const applyOutcomeSentences = (row: LogRow, ts: string) => {
    let n = 0;
    const text = `${row.role} ${row.action}`;
    const known = t
      .q<{ id: number; name: string; aliases: string }>('SELECT id, name, aliases FROM companies')
      .flatMap((c) => [c.name, ...(JSON.parse(c.aliases) as string[])].filter((x) => x && x.length >= 3).map((label) => ({ id: c.id, label })));
    for (const sentence of text.split(/(?<=[.!?)])\s+(?=\*\*|[A-Z])/)) {
      const plain = strip(sentence);
      const hit = known
        .map((k) => ({ ...k, at: plain.search(new RegExp(`(^|[^\\w])${escapeRe(k.label)}([^\\w]|$)`, 'i')) }))
        .filter((k) => k.at >= 0 && k.at < 40)
        .sort((a, b) => a.at - b.at)[0];
      if (!hit) continue;
      const outcome = OUTCOME_SENTENCE.find(([re]) => re.test(plain));
      if (!outcome) continue;
      const roles = t.q<RoleRow>(`SELECT * FROM roles r WHERE company_id = ? AND ${isCard('r.id')} ORDER BY updated_at DESC`, hit.id);
      const role = roles.find((r) => oneOf(['applied', 'interviewing', 'offer'], r.status)) || roles.find((r) => r.status === 'queued');
      if (!role || role.status === outcome[1].status) continue;
      event(role, ts, outcome[1], `Legacy log ${row.date}: ${plain.slice(0, 200)}`, row.raw);
      n++;
    }
    return n;
  };

  tx(t.db, () => {
    if (applied_log) {
      const rows = parseAppliedLog(applied_log);
      rows.forEach((row, i) => {
        stats.rows++;
        const ts = `${row.date}T12:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
        const companyCell = strip(row.company);
        const mapped = mapStatus(row.status);
        if (/^[—–-]/.test(companyCell) || !companyCell) {
          if (GROUP_DROP.test(companyCell)) {
            for (const g of groupCompanies(row)) {
              const { company, role: existing } = roleFor(g.name, [], g.title);
              const role = existing || newRole(company, g.title, null, strip(row.source), ts);
              if (!existing || !oneOf(['applied', 'interviewing', 'offer', 'closed'], existing.status)) {
                event(role, ts, { status: 'dropped' }, `Legacy log ${row.date}: dropped in a group row`, row.raw);
                stats.group_drops++;
              }
            }
          } else if (OUTCOME_ROW.test(companyCell)) {
            stats.outcomes_from_meta += applyOutcomeSentences(row, ts);
          } else if (NO_COLD.test(companyCell)) {
            const name = companyCell.replace(NO_COLD, '').replace(/[—–-]+\s*$/, '').trim();
            const hit = name && t.findCompany({ name }).matches.find((m) => m.certain);
            if (hit) {
              t.setNoColdApply({ company_id: hit.company.id, on: true, reason: `Legacy log ${row.date}: ${strip(row.role).slice(0, 160)}` });
              stats.no_cold_apply.push(hit.company.name);
            } else stats.meta_rows_skipped++;
          } else stats.meta_rows_skipped++;
          return;
        }
        for (const part of companyCell.split(/\s+\+\s+/)) {
          const { name, aliases } = cleanCompany(part);
          if (!name) continue;
          const title = cleanTitle(row.role) || '(unspecified)';
          let { company, role, roles } = roleFor(name, aliases, title);
          if (!role && mapped.status && ['closed', 'interviewing', 'offer'].includes(mapped.status)) {
            const live = roles.filter((r) => oneOf(['applied', 'interviewing', 'offer', 'queued'], r.status));
            if (live.length === 1) role = live[0];
          }
          if (!role && !mapped.status && roles.length === 1) role = roles[0];
          role ||= newRole(company, title, null, strip(row.source).slice(0, 120), ts);
          if (!mapped.status) stats.unparsed.push(`${row.date} ${name}: "${strip(row.status).slice(0, 60)}"`);
          // "Needs <user>" on a live process is a to-do, not a step back to the queue.
          const eff = mapped.status === 'queued' && oneOf(['applied', 'interviewing', 'offer'], role.status) ? { status: null } : mapped;
          event(role, ts, eff, `Legacy log ${row.date}: ${strip(row.status).slice(0, 200) || 'row'}`, row.raw);
          if (INTRO.test(`${row.status} ${row.action}`) && !company.no_cold_apply) {
            t.setNoColdApply({ company_id: company.id, on: true, reason: `Legacy log ${row.date}: intro or recruiter process open` });
            stats.no_cold_apply.push(company.name);
          }
        }
      });
    }

    if (queue?.length) {
      for (const { filename, content, mtime } of queue) {
        const prefix = (filename.match(/^(DROPPED|DONE|EXPIRED|PARKED)-/) || [])[1];
        const h1 = (String(content).match(/^#\s+(.+)$/m) || [])[1] || filename.replace(/\.md$/, '');
        const [cpart = '', ...rest] = strip(h1).split(/ · | — | – /);
        const { name, aliases } = cleanCompany(cpart);
        const title = cleanTitle(rest.join(' — ')) || '(unspecified)';
        const url = (String(content).match(/\*\*(?:Posting|Apply|URL|Link)[^*]*\*\*:?\s*(https?:\/\/[^\s)>\]]+)/i) || String(content).match(/(https?:\/\/(?:jobs\.ashbyhq\.com|job-boards\.greenhouse\.io|boards\.greenhouse\.io|jobs\.lever\.co|apply\.workable\.com)[^\s)>\]]+)/) || [])[1];
        if (!name || /^(?:parked|queue|readme)\b|\d{4}-\d{2}-\d{2}/i.test(name)) {
          stats.queue_skipped++;
          continue;
        }
        const dated = (String(content).match(/(?:queued|found|date|added)[^0-9\n]{0,20}(\d{4}-\d{2}-\d{2})/i) || String(content).match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
        const ts = dated ? `${dated}T12:00:00.000Z` : mtime ? new Date(mtime).toISOString() : new Date().toISOString();
        let { company, role, roles } = roleFor(name, aliases, title, url);
        // A note about a company already in the pipeline (prep, a reply, a variant title) attaches
        // to its most recent role instead of creating a second one.
        role ||= roles.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        role ||= newRole(company, title, url, 'legacy queue', ts);
        if (url && !role.url) {
          t.run('UPDATE roles SET url = ? WHERE id = ?', url, role.id);
          t.indexRoleUrls(role.id, [url]);
        }
        const mapped: Mapped = prefix === 'DROPPED' ? { status: 'dropped' } : prefix === 'DONE' ? { status: 'applied' } : prefix === 'EXPIRED' ? { status: 'closed', outcome: 'role_closed' } : { status: 'queued' };
        const current = t.mustRole(role.id).status;
        if (!current || current === 'queued' || current === 'found' || (current === 'dropped' && mapped.status === 'dropped')) {
          if (current !== mapped.status || mapped.status !== 'queued') {
            t.insertEvent({ role_id: role.id, ts, status: mapped.status, outcome: mapped.outcome ?? null, actor: 'import', reason: `Legacy queue file ${filename}`, evidence: `queue/${filename}`, question: prefix === 'PARKED' ? 'Parked in the old pipeline: your call.' : null });
            stats.events++;
          }
        }
        t.run('INSERT INTO artifacts(role_id, kind, path_or_ref, content, created_at) VALUES(?, ?, ?, ?, ?)', role.id, 'note', `legacy:queue/${filename}`, content, ts);
        stats.queue++;
      }
    }

    if (preferences) {
      const bullets: string[] = [];
      let cur: string | null = null;
      for (const line of String(preferences).split('\n')) {
        if (/^- /.test(line)) {
          if (cur) bullets.push(cur);
          cur = line.slice(2);
        } else if (cur !== null && line.trim()) cur += `\n${line}`;
        else if (cur !== null && !line.trim()) cur += '\n';
      }
      if (cur) bullets.push(cur);
      for (const b of bullets) {
        const date = (b.match(/[Aa]dded (\d{4}-\d{2}-\d{2})/) || b.match(/\(added (\d{4}-\d{2}-\d{2})\)/) || [])[1] || null;
        const paren = (b.match(/^Added \d{4}-\d{2}-\d{2}[^(]*\(([^)]*)\)/) || [])[1];
        const text = b.replace(/^Added \d{4}-\d{2}-\d{2}[^:]*:\s*/, '').trim();
        if (!text) continue;
        t.addRule({ text, reason: strip(paren || 'Imported from outreach preferences'), added_by: /\bby (?:the )?(?:user\b|[A-Z][a-z]+)/.test(strip(paren || b.slice(0, 120))) ? 'user' : 'pipeline', added_on: date || undefined });
        stats.rules++;
      }
    }
  });

  if (documents) {
    for (const [name, content] of Object.entries(documents)) {
      if (content?.trim()) {
        t.saveDocument({ name, content });
        stats.documents++;
      }
    }
  }
  stats.unparsed = stats.unparsed.slice(0, 50);
  return { imported: stats, summary: t.pipelineSummary() };
}
