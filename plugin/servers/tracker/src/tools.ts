// Tool catalogue: JSON Schemas for tools/list and handlers for tools/call.

import { openBoard } from './board-launch.ts';
import type { CapabilitiesConfig } from './config.ts';
import type { LegacyQueueFile } from './legacy.ts';
import { importLegacy } from './legacy.ts';
import { lintProse } from './lint.ts';
import { renderReport, runAudit } from './report.ts';
import { RULE_TYPES } from './rules.ts';
import type { ArgsOf, ObjSchema, Props } from './schema.ts';
import { bool, int, num, obj, str, strList, typed } from './schema.ts';
import type { Tracker } from './tracker.ts';
import { OUTCOMES, STATUSES } from './tracker.ts';
import { isRecord } from './util.ts';

const roleFields = {
  id: int('Existing role id to update'),
  company: str('Company name as the employer writes it'),
  company_aliases: strList('Other names, e.g. a brand vs the legal entity'),
  company_domain: str('Employer website domain'),
  title: str('Role title, verbatim'),
  url: str('Posting URL (employer ATS preferred)'),
  url_aliases: strList('Other URLs for this same posting, e.g. the LinkedIn card of an Ashby job. Needs identity_evidence'),
  identity_evidence: str('How you confirmed the listings are one posting. Required with url_aliases, and to add an ATS posting from another ATS or employer board to a known role'),
  ats: str('ashby | greenhouse | lever | workable | teamtailor | personio | join | workday | other'),
  location_line: str('Verbatim location line from the employer ATS'),
  location_type: str('remote | hybrid | onsite | unknown'),
  comp_min: num('Band minimum'),
  comp_max: num('Band maximum'),
  comp_currency: str('ISO currency code'),
  comp_period: str('year | month | day | hour'),
  equity: str('Equity as stated'),
  stack: str('Stack as stated'),
  industry: str('Industry of the business line the role sits in'),
  source: str('Where the lead came from'),
  posted_at: str('Posting date if shown'),
};

// Input schema per tool, keyed by tool name. tools/list sends these unchanged.
export const SCHEMAS = {
  setup_status: obj({}),
  record_setup_decision: obj({ key: str('setup_status item key'), decision: str("The user's decision, in their words") }, ['key', 'decision']),
  start_run: obj({
    kind: str('sweep | apply | triage | setup | calibration'),
    capabilities: typed<CapabilitiesConfig>('object', '{connectors: {gmail, calendar, linkedin}, browser: "claude-in-chrome" | "built-in" | null, local_folder: bool}'),
  }, ['kind', 'capabilities']),
  finish_run: obj({ run_id: int('From start_run'), summary: str('What happened') }, ['run_id']),
  get_profile: obj({}),
  save_config: obj({ section: str('filters | prefs | writing | accounts | autonomy | schedule | sources | capabilities'), data: typed<Record<string, unknown>>('object', 'Section contents') }, ['section', 'data']),
  get_document: obj({ name: str('profile | stories | reusable-answers | voice') }, ['name']),
  save_document: obj({ name: str('profile | stories | reusable-answers | voice'), content: str('Markdown') }, ['name', 'content']),
  find_company: obj({ name: str('Company name'), domain: str('Website domain'), url: str('Posting URL') }),
  set_no_cold_apply: obj({ company_id: int('Company id'), on: bool('true to set, false to clear'), reason: str('Why') }, ['company_id']),
  add_alias: obj({ company_id: int('Company id'), alias: str('Alias') }, ['company_id', 'alias']),
  upsert_role: obj(roleFields, ['title']),
  get_role: obj({ role_id: int('Role id') }, ['role_id']),
  link_duplicate_role: obj({
    canonical_role_id: int('The role to keep as the card. A linked duplicate\'s id stands for its canonical role'),
    duplicate_role_id: int('The other row for the same posting. Its history, artifacts and interviews stay and show under the canonical role'),
    reason: str('Why the two rows are one role'),
    evidence: str('How you confirmed they are the same posting, e.g. both link to the same ATS URL'),
  }, ['canonical_role_id', 'duplicate_role_id', 'reason', 'evidence']),
  transition: obj({
    role_id: int('Role id'),
    to: str(STATUSES.join(' | ')),
    reason: str('Why, one sentence'),
    evidence: str('Verbatim quote with URL, rule:<id>, or confirmation text'),
    outcome: str(`${OUTCOMES.join(' | ')} (closed only)`),
    category: str('For drops: location | pay | industry | role_shape | stack | culture | duplicate | gated | other'),
    question: str('For queued: the single blocking question for the user'),
    blocked_by: str('For queued: browser | user | login | captcha | other'),
    location_line: str('verified only: verbatim from the ATS'),
    location_type: str('verified only: remote | hybrid | onsite | unknown'),
    score: num('scored only: 0 to 10'),
    score_notes: str('scored only: short notes, including gaps kept internal'),
    run_id: int('Current run id'),
  }, ['role_id', 'to', 'reason']),
  record: obj({
    role_id: int('Role id'),
    status: str(`${STATUSES.join(' | ')} (omit for a note)`),
    reason: str('Why'),
    evidence: str('Verbatim quote, feedback, or URL'),
    outcome: str(OUTCOMES.join(' | ')),
    category: str('Drop category'),
    question: str('Blocking question for the user (shown under Needs you until a later event)'),
    blocked_by: str('browser | user | login | captcha | other'),
    actor: str('user | employer | pipeline'),
    run_id: int('Current run id'),
  }, ['role_id', 'reason', 'actor']),
  check_pay: obj({
    comp_min: num('Band minimum'),
    comp_max: num('Band maximum'),
    currency: str('ISO code'),
    period: str('year | month | week | day | hour'),
    fx_rate: num('Floor-currency units per 1 unit of currency'),
    equity: str('Equity, if any'),
  }, ['currency']),
  gate_check: obj({ role_id: int('Role id') }, ['role_id']),
  add_artifact: obj({
    role_id: int('Role id (omit for drafts not tied to a role)'),
    kind: str('cover_note | cover_letter_pdf | gmail_draft | form_answers | confirmation | note'),
    ref: str('Path, URL or Gmail draft id'),
    content: str('Text content'),
  }, ['kind']),
  list_artifacts: obj({ date: str('YYYY-MM-DD, a day in filters.timezone (ignored when run_id is given)'), run_id: int('Artifacts from this run'), role_id: int('Role id'), kind: str('Artifact kind') }),
  verify_artifact: obj({ artifact_id: int('Artifact id'), readback: str('Read-back output') }, ['artifact_id', 'readback']),
  lint_prose: obj({ text: str('Text to lint'), max_words: int('Word limit') }, ['text']),
  open_items: obj({ stale_after_days: int('Queue items untouched this long are listed as stale (default 14)') }),
  pipeline_summary: obj({ stale_after_days: int('Default 14') }),
  open_board: obj({ open: bool('true also opens it in the default browser. Only when the user asked to see the board now; never in a scheduled run.') }),
  add_rule: obj({ text: str('The rule, imperative'), reason: str('Why (the incident or the user words)'), example: str('Concrete example'), types: strList(`Which consumers read it: ${RULE_TYPES.join(' | ')}. Omit for global`), added_by: str('user | pipeline') }, ['text', 'reason']),
  list_rules: obj({
    types: strList(`Only rules for these consumers (and global ones): ${RULE_TYPES.join(' | ')}. Omit for all`),
    limit: int('Page size, 1 to 50 (default 10)'),
    cursor: str('next_cursor from the previous page. Omit types and include_inactive to keep the cursor\'s'),
    include_inactive: bool('Include deactivated rules'),
  }),
  get_rule: obj({
    id: int('Rule id, from a list_rules entry with requires_detail'),
    cursor: str('next_cursor from the previous chunk. Omit for the first chunk'),
    limit: int('Chunk size in characters, 1 to 4000 (default 4000)'),
  }, ['id']),
  set_rule_types: obj({ id: int('Rule id'), types: strList(`One or more of: ${RULE_TYPES.join(' | ')}`) }, ['id', 'types']),
  deactivate_rule: obj({ id: int('Rule id') }, ['id']),
  source_health: obj({}),
  set_source_status: obj({ name: str('Source name'), status: str('ok | degraded | failed | disabled'), found: int('Leads found'), applied: int('Applications from it'), error: str('Error text') }, ['name', 'status']),
  add_interview: obj({
    role_id: int('Role id'),
    starts_at: str('ISO datetime, omit if not booked yet'),
    tz: str('IANA timezone'),
    stage: str('Stage name'),
    people: str('Interviewers'),
    link: str('Booking or meeting link'),
    booked_by: str('user | employer'),
    notes: str('Notes'),
  }, ['role_id', 'stage']),
  render_report: obj({ date: str('YYYY-MM-DD, a day in filters.timezone (report title; ignored for scope when run_id is given)'), run_id: int('Run id (preferred)'), headline: str('One or two sentences: the outcome') }, ['date']),
  audit: obj({ run_id: int('Run id'), date: str('YYYY-MM-DD, a day in filters.timezone (ignored when run_id is given)') }),
  import_legacy: obj({
    applied_log: str('applied-log.md contents'),
    preferences: str('outreach-preferences.md contents'),
    queue: typed<LegacyQueueFile[]>('array', 'Queue notes', { items: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] } }),
    documents: typed<Record<string, string | undefined>>('object', '{profile, stories, "reusable-answers"} markdown'),
    path: str('Local path to the pipeline/ folder'),
  }),
};

export type ToolName = keyof typeof SCHEMAS;
export type ArgsFor<N extends ToolName> = ArgsOf<(typeof SCHEMAS)[N]>;

// A is the handler's argument type. Tool (A = never) accepts every tool; mcp.ts calls a handler only
// after checkArgs has checked the arguments against its inputSchema.
export interface Tool<A = never> {
  name: string;
  description: string;
  inputSchema: ObjSchema<Props, string>;
  handler: (t: Tracker, a: A) => unknown;
}

const defineTool = <N extends ToolName>(name: N, description: string, handler: (t: Tracker, a: ArgsFor<N>) => unknown): Tool<ArgsFor<N>> => ({
  name,
  description,
  inputSchema: SCHEMAS[name],
  handler,
});

export const TOOLS: Tool[] = [
  defineTool('setup_status', 'Checklist of what is configured, missing or degraded. Call at the start of every run.', (t) => t.setupStatus()),
  defineTool('record_setup_decision', 'Record the user decision for an amber setup item (e.g. "no browser, accepted"), so setup can complete.', (t, a) => t.recordDecision(a)),
  defineTool('start_run', 'Start a run and record detected capabilities (connectors, browser, local folder). Returns run_id.', (t, a) => t.startRun(a)),
  defineTool('finish_run', 'Close a run with a one-paragraph summary.', (t, a) => t.finishRun(a)),
  defineTool('get_profile', 'All config sections: filters, prefs, writing, accounts, autonomy, schedule, sources, capabilities.', (t) => t.getProfile()),
  defineTool('save_config', 'Validate and save one config section. Unknown fields are rejected. Field names and types are in templates/settings.example.yaml; an invalid call returns the section\'s expected fields.', (t, a) => t.saveConfig(a)),
  defineTool('get_document', 'Read a user document: profile (CV distilled), stories, reusable-answers, voice.', (t, a) => t.getDocument(a)),
  defineTool('save_document', 'Save a user document (markdown).', (t, a) => t.saveDocument(a)),
  defineTool('find_company', 'Dedupe check. Pass url when you have one: an exact URL or ATS posting, under any company and any recorded alias, is checked first and listed in exact_role_ids. Then fuzzy match on name, aliases, domain and ATS slug. verdict: new | seen | skip (live application, same posting, or no_cold_apply). seen is a known company with nothing blocking: a different requisition there is a lead, even after a rejection. skip for a tracked posting is for discovery; to apply to a known queued role, pass its id to gate_check.', (t, a) => t.findCompany(a)),
  defineTool('set_no_cold_apply', 'Mark a company as no_cold_apply (an intro or recruiter process is open), or clear it.', (t, a) => t.setNoColdApply(a)),
  defineTool('add_alias', 'Add an alias to a company (brand, former name, parent) so dedupe catches it.', (t, a) => t.addAlias(a)),
  defineTool('upsert_role', 'Create or update a role (creates the company if needed). Pass id to update a known role. Otherwise a role is matched on its exact URL or ATS posting, never on title: with no match a new role starts as found, and possible_role_ids lists same-title roles at the company to rule out before scoring. A URL matching several roles, or a second posting ID from the same employer board, returns an error and writes nothing. Returns the find_company dedupe result unless id is given.', (t, a) => t.upsertRole(a)),
  defineTool('get_role', 'Role with its company, full event history, artifacts, interviews, and the urls and ATS postings it is known by. A linked duplicate\'s id returns its canonical role; history, artifacts, interviews and URLs then cover the whole group under their original ids, with requested_role_id, linked_role_ids and links.', (t, a) => t.roleDetail(a)),
  defineTool('link_duplicate_role', 'Link a historical duplicate row to the canonical role for the same posting. Nothing is deleted: the duplicate\'s events, artifacts and interviews show under the canonical role, and its id resolves to that role in every tool. Same company only. Refuses two posting IDs from one employer board, and histories that disagree. A duplicate with only preparatory states links under a role with an application history, or under a preparatory role that moved last. A duplicate with an application history needs the same latest status and outcome on the canonical role, no older (fix it with transition or record first). A duplicate already linked to another role is refused. A canonical role\'s own duplicates move along when it is linked. Linking the same pair again returns the group.', (t, a) => t.linkDuplicateRole(a)),
  defineTool('transition', 'Move a role through found → verified → scored → queued → applied → interviewing → offer (dropped from found/verified/scored/queued; closed from queued/applied/interviewing/offer). Rejects illegal moves. verified needs evidence (URL + verbatim location line), location_line and location_type. dropped needs evidence (quote or rule:<id>). applied needs the confirmation text. closed needs outcome.', (t, a) => t.transition(a)),
  defineTool('record', 'Append a validated event without the state-machine check: outcomes from outside (rejection, invite, user decision) or a note (omit status).', (t, a) => t.record(a)),
  defineTool('check_pay', 'Deterministic pay-floor check. Drops only if the band maximum is below the floor; straddling bands are kept and flagged. Pass fx_rate when the currency differs from the floor (look it up, never guess).', (t, a) => t.checkPay(a)),
  defineTool('gate_check', 'Pre-submit check: role verified, not no_cold_apply, no live application at the company, and this posting never applied to before. Any applied, interviewing, offer, rejected or withdrawn event on a row for the posting blocks it, even back in the queue (previous_application, matched_role_id). A posting held by several unlinked roles is blocked until resolved. Call before preparing an application; hooks check again at submit.', (t, a) => t.gateCheck(a)),
  defineTool('add_artifact', 'Save a cover note, PDF, Gmail draft id, form answers, confirmation or note. Prose is linted. gmail_draft stays unverified until verify_artifact.', (t, a) => t.addArtifact(a)),
  defineTool('list_artifacts', 'Artifacts for a run, a local day or a role, with lint results and read-back state. The auditor uses this.', (t, a) => t.listArtifacts(a)),
  defineTool('verify_artifact', 'Mark an artifact verified after reading it back. For gmail_draft, readback must be the get_draft/list_drafts output containing the draft id.', (t, a) => t.verifyArtifact(a)),
  defineTool('lint_prose', 'Lint outbound prose: em/en dashes, "not X but Y", fake-candid openers, volunteered gaps, length.', (_t, a) => lintProse(a.text, { max_words: a.max_words })),
  defineTool('open_items', 'Queue (fresh and stale), unverified drafts, interviews to book, upcoming interviews.', (t, a) => t.openItems(a)),
  defineTool('pipeline_summary', 'Counts by status, live processes, rejections, queue (fresh and stale).', (t, a) => t.pipelineSummary(a)),
  defineTool('open_board', 'Start the local kanban board (or reuse the running one). With open: true it opens in the user\'s browser and the link is not returned; otherwise the link is returned. The user drags cards to move roles; moves follow transition\'s rules and are recorded as the user\'s. The board stops after 30 idle minutes.', (t, a) => openBoard({ dbPath: t.dbPath, open: a.open ?? false })),
  defineTool('add_rule', 'Add a user preference or correction as a rule, with reason and example. types says which consumers read it; omit it for global.', (t, a) => t.addRule(a)),
  defineTool('list_rules', 'Rules with provenance and types, one page at a time: at most 10 by default, limit up to 50. Follow next_cursor until it is null; never act on a partial set. types filters to those consumers plus global rules, which are always included. If rules changed mid-listing, the cursor is refused: restart without it. An entry with requires_detail is too large to list: read it with get_rule. Results stay under 24 KiB, so a page can hold fewer rules than limit; next_cursor says whether more remain.', (t, a) => t.listRules(a)),
  defineTool('get_rule', 'Read one whole rule in chunks. Only for a list_rules entry marked requires_detail. Call until next_cursor is null, join every chunk in order, then JSON.parse the result. Never act on a partial chunk. If rules changed meanwhile, the cursor is refused: restart without it.', (t, a) => t.getRule(a)),
  defineTool('set_rule_types', 'Change which consumers a rule applies to. Edits the classification only: text, reason and who added it stay. Returns the types and rules_revision.', (t, a) => t.setRuleTypes(a)),
  defineTool('deactivate_rule', 'Deactivate a rule. Repeating it on an inactive rule is a no-op.', (t, a) => t.deactivateRule(a)),
  defineTool('source_health', 'Per-source status, consecutive failures, yield.', (t) => t.sourceHealth()),
  defineTool('set_source_status', 'Record a source result for this run. Three consecutive failures mark it degraded.', (t, a) => t.setSourceStatus(a)),
  defineTool('add_interview', 'Record an interview (or a booking link still to book: omit starts_at). Moves the role to interviewing.', (t, a) => t.addInterview(a)),
  defineTool('render_report', 'Markdown daily report. With run_id it covers that run; otherwise the local day. Lead with the outcome via headline. Only read-back drafts and confirmed submissions are claimed.', (t, a) => renderReport(t, a)),
  defineTool('audit', 'Post-run rule check for a run (preferred) or a local day: excluded industries, drops without evidence, applied without confirmation, prose lint, drafts not read back, no_cold_apply. Pass run_id or date.', (t, a) => runAudit(t, a)),
  defineTool('import_legacy', 'One-off import of the manual pipeline: applied-log.md, outreach-preferences.md, queue/*.md, and user documents. Pass the contents, or path to a local pipeline/ folder.', (t, a) => importLegacy(t, a)),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// Minimal argument check against the declared schema: required keys, no unknown keys, basic types.
export function checkArgs(tool: Tool, args: unknown): string[] {
  const schema = tool.inputSchema;
  const errors: string[] = [];
  if (!isRecord(args)) return ['arguments must be an object'];
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') errors.push(`${k} is required`);
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) {
      errors.push(`unknown argument "${k}"`);
      continue;
    }
    if (v === null || v === undefined) continue;
    const t = Array.isArray(v) ? 'array' : typeof v;
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? t === 'number' : p.type === t;
    if (!ok) errors.push(`${k}: expected ${p.type}, got ${t}`);
  }
  return errors;
}
