import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { importLegacy, mapStatus } from '../../plugin/servers/tracker/src/legacy.ts';
import { lintProse } from '../../plugin/servers/tracker/src/lint.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { renderReport, runAudit } from '../../plugin/servers/tracker/src/report.ts';
import { formatLocal, localDate } from '../../plugin/servers/tracker/src/time.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
// fresh() sets filters.timezone to Europe/Berlin; "today" is that local day.
const today = () => localDate(Date.now(), 'Europe/Berlin');

function fresh() {
  const t = new Tracker(openDb(':memory:'));
  t.saveConfig({
    section: 'filters',
    data: {
      work_mode: ['remote'],
      residence_country: 'DE',
      timezone: 'Europe/Berlin',
      pay_floor: { amount: 80000, currency: 'EUR', period: 'year', basis: 'gross' },
      excluded_industries: ['crypto', 'gambling', 'defense'],
    },
  });
  return t;
}

interface CallResult {
  isError: boolean;
  content: [{ text: string }];
  structuredContent?: Record<string, unknown>;
}

function call(t: Tracker) {
  const handle = makeHandler(t);
  let id = 0;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })) as RpcResponse;
    const r = res.result as CallResult;
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent, text: r.content[0].text };
  };
}

const verify = (t: Tracker, role_id: number, line = 'Remote (Europe)', type = 'remote') =>
  t.transition({ role_id, to: 'verified', reason: 'Checked ATS', evidence: `https://jobs.ashbyhq.com/x/1: "${line}"`, location_line: line, location_type: type });

test('AC3: a role applied to under an alias is deduped (alias and fuzzy)', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'The Flex', company_aliases: ['Base360'], title: 'Senior Full-Stack Product Engineer', url: 'https://jobs.ashbyhq.com/theflex/abc', source: 'ashby' });
  verify(t, role.id);
  t.transition({ role_id: role.id, to: 'scored', reason: 'fits', score: 8 });
  t.transition({ role_id: role.id, to: 'queued', reason: 'top pick' });
  t.transition({ role_id: role.id, to: 'applied', reason: 'submitted', evidence: 'Thanks for applying to The Flex!' });

  const byAlias = t.findCompany({ name: 'Base360' });
  assert.equal(byAlias.verdict, 'skip');
  assert.equal(byAlias.live_application, true);

  // No alias recorded for "Flex Living": token containment gives a possible match, never "new".
  const fuzzy = t.findCompany({ name: 'Flex Living' });
  assert.notEqual(fuzzy.verdict, 'new');
  assert.equal(fuzzy.matches[0]?.company.name, 'The Flex');

  // Same ATS slug from another URL is certain.
  const bySlug = t.findCompany({ name: 'Flex Living', url: 'https://jobs.ashbyhq.com/theflex/zzz' });
  assert.equal(bySlug.verdict, 'skip');

  // Unrelated company stays new.
  assert.equal(t.findCompany({ name: 'Acme Robotics' }).verdict, 'new');
});

test('AC4: a "Remote" tag contradicted by the ATS is dropped with the ATS quote as evidence', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Wolverton', title: 'Senior Frontend Engineer', url: 'https://www.linkedin.com/jobs/view/1', source: 'linkedin', location_type: 'remote' });
  assert.throws(() => t.transition({ role_id: role.id, to: 'dropped', reason: 'hybrid', category: 'location' }), /evidence/);
  const quote = 'https://careers.example.com/job/1: "Hybrid (8 days/month in our Berlin office)"';
  t.transition({ role_id: role.id, to: 'dropped', reason: 'ATS says hybrid, 8 days a month', category: 'location', evidence: quote });
  const d = t.roleDetail({ role_id: role.id });
  assert.equal(d.role.status, 'dropped');
  assert.equal(d.events.at(-1)?.evidence, quote);
  assert.throws(() => verify(t, role.id), /Illegal transition dropped/);
});

test('AC5: pay floor drops only when the band maximum is below it', () => {
  const t = fresh();
  assert.equal(t.checkPay({ comp_min: 42000, comp_max: 78000, currency: 'EUR', period: 'year' }).verdict, 'drop');
  const s = t.checkPay({ comp_min: 79000, comp_max: 97000, currency: 'EUR', period: 'year' });
  assert.equal(s.verdict, 'straddles');
  assert.match(s.reason, /straddles/);
  assert.equal(t.checkPay({ comp_min: 95000, comp_max: 120000, currency: 'EUR' }).verdict, 'keep');
  assert.equal(t.checkPay({ comp_max: 70000, currency: 'EUR', equity: '1%' }).verdict, 'drop');
  // Monthly and hourly are annualised from the top of the band.
  assert.equal(t.checkPay({ comp_min: 6000, comp_max: 8000, currency: 'EUR', period: 'month' }).verdict, 'straddles');
  assert.equal(t.checkPay({ comp_max: 60, currency: 'EUR', period: 'hour' }).verdict, 'keep');
  // Another currency without a rate is unknown, with a rate it is decided.
  assert.equal(t.checkPay({ comp_max: 100000, currency: 'USD' }).verdict, 'unknown');
  assert.equal(t.checkPay({ comp_max: 100000, currency: 'USD', fx_rate: 0.75 }).verdict, 'drop');
});

test('state machine: illegal moves, required fields, verified_at only via verify', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Product Engineer', url: 'https://jobs.example.com/acme/product-engineer', source: 'hn' });
  assert.throws(() => t.transition({ role_id: role.id, to: 'applied', reason: 'x', evidence: 'y' }), /Illegal transition found → applied/);
  assert.throws(() => t.transition({ role_id: role.id, to: 'verified', reason: 'x', evidence: 'no url', location_line: 'Remote', location_type: 'remote' }), /URL/);
  assert.throws(() => t.record({ role_id: role.id, status: 'verified', reason: 'x', actor: 'pipeline', evidence: 'https://a "b"' }), /transition/);
  assert.throws(() => t.record({ role_id: role.id, status: 'scored', reason: '', actor: 'pipeline' }), /reason/);
  assert.equal(t.gateCheck({ role_id: role.id }).ok, false);
  verify(t, role.id);
  assert.ok(t.roleRow(role.id)?.verified_at);
  assert.equal(t.gateCheck({ role_id: role.id }).ok, true);
  assert.equal(t.gateCheck({ role_id: role.id }).url, role.url);
  t.transition({ role_id: role.id, to: 'scored', reason: 'ok' });
  t.transition({ role_id: role.id, to: 'queued', reason: 'ok' });
  assert.throws(() => t.transition({ role_id: role.id, to: 'applied', reason: 'ok' }), /confirmation/);
  assert.throws(() => t.transition({ role_id: role.id, to: 'closed', reason: 'gone' }), /outcome/);
  // Rejections arrive from outside at any time.
  t.record({ role_id: role.id, status: 'closed', outcome: 'rejected', reason: 'Rejection email', evidence: 'We decided to move forward with other candidates', actor: 'employer' });
  assert.equal(t.pipelineSummary().rejections.length, 1);
});

test('gate_check: no_cold_apply and a live application elsewhere block a submit', () => {
  const t = fresh();
  const a = t.upsertRole({ company: 'Acme', title: 'Role A', source: 'x' }).role;
  const b = t.upsertRole({ company: 'Acme', title: 'Role B', source: 'x' }).role;
  for (const r of [a, b]) verify(t, r.id);
  t.record({ role_id: a.id, status: 'applied', reason: 'user applied', evidence: 'confirmation', actor: 'user' });
  const g = t.gateCheck({ role_id: b.id });
  assert.equal(g.ok, false);
  assert.equal(g.live_elsewhere, true);
  const c = t.upsertRole({ company: 'Intro Co', title: 'Eng', source: 'x' });
  verify(t, c.role.id);
  t.setNoColdApply({ company_id: c.company.id, reason: 'Intro via recruiter open' });
  assert.equal(t.gateCheck({ role_id: c.role.id }).no_cold_apply, true);
  assert.equal(t.findCompany({ name: 'Intro Co' }).verdict, 'skip');
});

test('AC9: a Gmail draft is only verified with a read-back containing its id, and the report only claims verified drafts', () => {
  const t = fresh();
  const { artifact_id } = t.addArtifact({ kind: 'gmail_draft', ref: 'r-123456', content: 'Thanks, Tuesday at 10:00 works for me.\n\nAlex' });
  assert.equal(t.openItems().unverified_drafts.length, 1);
  assert.throws(() => t.verifyArtifact({ artifact_id, readback: '{"drafts": []}' }), /does not contain draft id/);
  let report = renderReport(t, { date: today() }).markdown;
  assert.match(report, /not confirmed by read-back/);
  t.verifyArtifact({ artifact_id, readback: '{"id":"r-123456","message":{"snippet":"Thanks, Tuesday"}}' });
  report = renderReport(t, { date: today() }).markdown;
  assert.doesNotMatch(report, /not confirmed by read-back/);
  assert.match(report, /read back: r-123456/);
});

test('AC10: a cover note with an em dash or a volunteered gap fails lint and the audit', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x' });
  const clean = 'I built the screens developers open when a check fails. That work is close to yours. I am based in Germany and available from October.';
  assert.equal(lintProse(clean).ok, true);
  const dash = lintProse('I built the check results page — the one people open first.');
  assert.equal(dash.ok, false);
  assert.equal(dash.issues[0]?.kind, 'em_dash');
  for (const gap of [
    "I don't have direct experience with Kubernetes, but I learn fast.",
    'While I have not used Go professionally, I am keen.',
    'My experience with AWS is limited.',
    'I have limited exposure to Python.',
    "I haven't worked with GraphQL yet.",
    "I'm new to Rust.",
  ]) {
    const r = lintProse(gap);
    assert.equal(r.ok, false, gap);
    assert.ok(r.issues.some((i) => i.kind === 'volunteered_gap'), gap);
  }
  assert.equal(lintProse("It's not about speed, it's about trust.").ok, false);
  assert.equal(lintProse('Honestly, I think this is a great fit.').ok, false);
  assert.equal(lintProse('word '.repeat(210), { max_words: 200 }).ok, false);

  t.addArtifact({ role_id: role.id, kind: 'cover_note', content: 'I shipped the editor — and I would love to do it again.' });
  const audit = runAudit(t, { date: today() });
  assert.equal(audit.ok, false);
  assert.ok(audit.failures.some((f) => f.check === 'prose_lint'));
});

test('lint reports a gap once when several gap patterns match the same words', () => {
  const gaps = lintProse("While I haven't worked with Kafka, I learn fast.").issues.filter((i) => i.kind === 'volunteered_gap');
  assert.equal(gaps.length, 1);
  const two = lintProse("I'm new to Rust. Later on, my experience with Go is limited.").issues.filter((i) => i.kind === 'volunteered_gap');
  assert.equal(two.length, 2, 'separate gaps are still reported separately');
});

test('lint flags bare URLs in a signature without catastrophic backtracking', () => {
  const urls = (text: string) => lintProse(text).issues.filter((i) => i.kind === 'bare_url_signature').length;
  assert.equal(urls('Thanks,\nAda\nhttps://ada.example https://github.com/ada'), 1);
  assert.equal(urls('Thanks,\nAda\n  https://ada.example\n'), 1);
  assert.equal(urls('See https://ada.example for the write-up.\nThanks,\nAda'), 0);
  // CodeQL js/redos: \S+ and the repeated group used to split "!http://" runs every possible way.
  const started = performance.now();
  urls(`\nhttp://${'!http://'.repeat(28)} x`);
  assert.ok(performance.now() - started < 250, 'bare URL check backtracks');
});

test('stale queue keys off the last event, not edits to the role row', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x', url: 'https://jobs.ashbyhq.com/acme/1' });
  verify(t, role.id);
  t.transition({ role_id: role.id, to: 'scored', reason: 'ok' });
  t.transition({ role_id: role.id, to: 'queued', reason: 'ok' });
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  t.run('UPDATE events SET ts = ? WHERE role_id = ?', old, role.id);
  // A field edit bumps updated_at but is not activity on the application.
  t.upsertRole({ id: role.id, title: 'Eng', stack: 'TypeScript' });
  const s = t.pipelineSummary();
  assert.equal(s.queue.length, 0);
  assert.deepEqual(s.stale_queue.map((r) => r.last_activity), [old]);
  assert.deepEqual(t.openItems().stale_queue.map((r) => r.last_event), [old]);
});

test('audit flags excluded industries that got past scoring', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Chain Co', title: 'Eng', source: 'x', industry: 'crypto exchange' });
  verify(t, role.id);
  t.transition({ role_id: role.id, to: 'scored', reason: 'ok' });
  assert.ok(runAudit(t, { date: today() }).failures.some((f) => f.check === 'excluded_industry'));
});

test('AC2: report names missing capabilities and what was queued because of them', () => {
  const t = fresh();
  const { run_id } = t.startRun({ kind: 'sweep', capabilities: { connectors: { gmail: true, calendar: true, linkedin: false }, browser: null, local_folder: false } });
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', url: 'https://jobs.ashbyhq.com/acme/1', source: 'ashby' });
  verify(t, role.id);
  t.transition({ role_id: role.id, to: 'scored', reason: 'ok', score: 8 });
  t.transition({ role_id: role.id, to: 'queued', reason: 'ready to apply', blocked_by: 'browser', question: 'Apply in a browser session?' });
  const { markdown } = renderReport(t, { date: today(), run_id, headline: 'One strong find queued; no browser this run.' });
  assert.match(markdown, /Missing this run: browser, local folder, LinkedIn/);
  assert.match(markdown, /Queued because of it: Acme \(role 1\)/);
  assert.match(markdown, /## Needs you\n\n1\. \*\*Acme\*\*, Eng \(role 1\): Apply in a browser session\? To apply: `\/job-tracker:apply 1`/);
  assert.match(markdown, /Emails or messages sent \| 0/);
});

test('a stored capabilities.tracker from an older version is hidden, and the profile round-trips through save_config', () => {
  const t = fresh();
  t.run("INSERT INTO profile(key, value) VALUES('capabilities', ?)", JSON.stringify({ connectors: { gmail: true }, browser: null, tracker: 'remote' }));
  const caps = t.section('capabilities');
  assert.equal('tracker' in caps, false);
  assert.equal(caps.connectors?.gmail, true);
  t.saveConfig({ section: 'capabilities', data: { ...caps } });
  assert.equal('tracker' in t.section('capabilities'), false);
});

test('accounts saved with the old recruiter_email field read back as job_inbox_email and save again', () => {
  const t = fresh();
  t.run("INSERT INTO profile(key, value) VALUES('accounts', ?)", JSON.stringify({ recruiter_email: 'me@example.com', invite_calendar: 'personal' }));
  const acc = t.section('accounts');
  assert.equal(acc.job_inbox_email, 'me@example.com');
  assert.equal('recruiter_email' in acc, false);
  t.saveConfig({ section: 'accounts', data: { ...acc } });
  assert.throws(() => t.saveConfig({ section: 'accounts', data: { recruiter_email: 'x', invite_calendar: 'y' } }), /accounts\.recruiter_email: unknown field/);
});

test('AC1: setup_status works with connectors only; no browser is amber with a recordable decision', () => {
  const t = fresh();
  t.saveDocument({ name: 'profile', content: '# Profile\n\n## Acme (2020-2024)\nStack: TypeScript, React' });
  t.saveConfig({ section: 'accounts', data: { job_inbox_email: 'personal', invite_calendar: 'personal', connected_calendar: 'personal' } });
  t.saveConfig({ section: 'schedule', data: { daily: { days: 'weekdays', time: '07:00', tz: 'Europe/Berlin' } } });
  t.startRun({ kind: 'setup', capabilities: { connectors: { gmail: true, calendar: true }, browser: null } });
  let s = t.setupStatus();
  assert.equal(s.db_path, null);
  assert.equal('tracker' in s, false);
  assert.equal(s.items.find((i) => i.key === 'browser')?.state, 'amber');
  assert.equal(s.all_green, false);
  for (const i of s.items.filter((i) => i.state !== 'green')) t.recordDecision({ key: i.key, decision: 'Accepted for now' });
  s = t.setupStatus();
  assert.equal(s.all_green, true);
});

test('setup warns when invites land on a different calendar than the connected one', () => {
  const t = fresh();
  t.saveConfig({ section: 'accounts', data: { job_inbox_email: 'personal', invite_calendar: 'personal', connected_calendar: 'work' } });
  const acc = t.setupStatus().items.find((i) => i.key === 'accounts');
  assert.equal(acc?.state, 'amber');
  assert.match(acc?.detail ?? '', /connected calendar is "work"/);
});

test('setup_status flags ats_boards enabled with no boards to fetch', () => {
  const t = fresh();
  const state = () => t.setupStatus().items.find((i) => i.key === 'sources');
  t.saveConfig({ section: 'sources', data: { enabled: ['linkedin', 'ats_boards'] } });
  assert.equal(state()?.state, 'amber');
  assert.match(state()?.detail ?? '', /sources\.boards is empty/);
  t.saveConfig({ section: 'sources', data: { enabled: ['linkedin', 'ats_boards'], boards: ['https://jobs.ashbyhq.com/acme'] } });
  assert.equal(state()?.state, 'green');
});

test('config validation rejects unknown fields and unattended submit', () => {
  const t = fresh();
  assert.throws(() => t.saveConfig({ section: 'filters', data: { work_mode: ['anywhere'], residence_country: 'DE', timezone: 'x', pay_floor: { amount: 1, currency: 'EUR' } } }), /not one of/);
  assert.throws(() => t.saveConfig({ section: 'prefs', data: { titel: [] } }), /unknown field/);
  assert.throws(() => t.saveConfig({ section: 'filters', data: { remote: 'fully_remote' } }), /Expected filters fields: work_mode \(required\): array of remote\|hybrid\|onsite, .*pay_floor \(required\): \{ amount \(required\): number/);
  assert.throws(() => t.saveConfig({ section: 'autonomy', data: { unattended: ['search', 'submit'] } }), /always need the user/);
});

test('source health: three consecutive failures degrade a source, and only changes are reported', () => {
  const t = fresh();
  t.setSourceStatus({ name: 'linkedin', status: 'ok', found: 3 });
  t.setSourceStatus({ name: 'linkedin', status: 'failed', error: '429' });
  t.setSourceStatus({ name: 'linkedin', status: 'failed', error: '429' });
  const r = t.setSourceStatus({ name: 'linkedin', status: 'failed', error: '429' });
  assert.equal(r.source?.status, 'degraded');
  assert.equal(r.changed, true);
  assert.equal(t.setSourceStatus({ name: 'linkedin', status: 'failed', error: '429' }).changed, false);
});

test('MCP: tools/list, argument validation and tool errors come back as isError', async () => {
  const t = fresh();
  const c = call(t);
  const handle = makeHandler(t);
  const list = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as RpcResponse;
  const names = (list.result as { tools: { name: string }[] }).tools.map((x) => x.name);
  for (const n of ['find_company', 'upsert_role', 'record', 'transition', 'open_items', 'get_profile', 'save_config', 'add_rule', 'list_rules', 'source_health', 'set_source_status', 'setup_status', 'render_report', 'import_legacy']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /sql/i.test(n)), 'no raw SQL tool');
  assert.match((await c('upsert_role', { company: 'A' })).error, /title is required/);
  assert.match((await c('upsert_role', { title: 'x', bogus: 1 })).error, /unknown argument/);
  const { data } = await c('upsert_role', { company: 'A', title: 'Eng', source: 's' });
  const role = data?.role as { id: number };
  assert.match((await c('transition', { role_id: role.id, to: 'applied', reason: 'r', evidence: 'e' })).error, /Illegal transition/);
  const n = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(n, null);
});

test('AC11: legacy import reproduces live processes, rejections and queue', () => {
  const t = fresh();
  const out = importLegacyFixture(t);
  const s = t.pipelineSummary({ stale_after_days: 1e6 });
  const names = (list: { company: string }[]) => list.map((r) => r.company).sort();
  assert.deepEqual(names(s.live_processes), ['Driftwood AI', 'Mosaic Data']);
  assert.deepEqual(names(s.rejections), ['Cobalt Flow', 'Harbor Labs', 'Pinecrest', 'Relay Mail']);
  assert.equal(out.imported.outcomes_from_meta, 1, 'rejection read from a replies meta row');
  assert.deepEqual(names(s.queue), ['Rivet Runtime', 'The Other Company']);
  assert.equal(out.imported.meta_rows_skipped, 1);
  assert.equal(out.imported.group_drops, 3);
  assert.ok(t.findCompany({ name: 'Castor' }).matches.length, 'group drop company imported');
  assert.equal(t.findCompany({ name: 'Base99.io' }).verdict, 'skip', 'alias from "The Nest / Base99.io" applied');
  assert.ok(out.imported.no_cold_apply.includes('Intro Example'));
  assert.equal(out.imported.rules, 2);
  assert.equal(t.listRules().rules[0]?.added_by, 'user');
  // Rejection feedback is kept verbatim in evidence.
  const cam = t.findCompany({ name: 'Cobalt Flow' }).matches[0]?.roles[0];
  assert.ok(cam);
  assert.match(t.roleDetail({ role_id: cam.id }).events.at(-1)?.evidence ?? '', /detailed rejection feedback/);
});

function importLegacyFixture(t: Tracker) {
  return importLegacy(t, {
    applied_log: fixture('applied-log.md'),
    preferences: fixture('outreach-preferences.md'),
    queue: [
      { filename: 'rivet-design-engineer.md', content: '# Rivet Runtime · Design Engineer (queued 2026-10-01)\n\n- **Posting:** https://jobs.ashbyhq.com/rivet-runtime/1\n' },
      { filename: 'DROPPED-beacon-senior.md', content: '# Beacon · Senior Product Engineer\n' },
      { filename: 'DONE-oriel.md', content: '# Oriel — Product Engineer\n' },
    ],
  });
}

test('legacy status mapping', () => {
  assert.deepEqual(mapStatus('Submitted ✅'), { status: 'applied' });
  assert.deepEqual(mapStatus('Closed — rejected ❌'), { status: 'closed', outcome: 'rejected' });
  assert.deepEqual(mapStatus('Awaiting Sam: CV + submit ⏳'), { status: 'queued' });
  assert.deepEqual(mapStatus('Awaiting response'), { status: 'applied' });
  assert.deepEqual(mapStatus('🟡 **AWAITING SAM — book the slot**'), { status: 'interviewing' });
  assert.deepEqual(mapStatus('Dropped — location gate'), { status: 'dropped' });
  assert.deepEqual(mapStatus('Logged'), { status: null });
});

test('interview times are stored in UTC, so upcoming works across offsets', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x' });
  const soon = new Date(Date.now() + 3600e3);
  // Tokyo wall time one hour from now, written without an offset.
  const wall = soon.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(' ', 'T').slice(0, 16);
  t.addInterview({ role_id: role.id, stage: 'screen', starts_at: wall, tz: 'Asia/Tokyo' });
  const stored = t.q<{ starts_at: string }>('SELECT starts_at FROM interviews')[0]?.starts_at ?? '';
  assert.match(stored, /Z$/);
  assert.ok(Math.abs(Date.parse(stored) - soon.getTime()) < 60e3);
  assert.equal(t.openItems().upcoming_interviews.length, 1);
  assert.throws(() => t.addInterview({ role_id: role.id, stage: 'tech', starts_at: 'soon' }), /Cannot parse/);
  assert.throws(() => t.addInterview({ role_id: role.id, stage: 'tech', starts_at: wall, tz: 'Mars/Base' }), /Unknown timezone/);
});

test('reports group by the local day in filters.timezone, not the UTC day', () => {
  const t = fresh(); // Europe/Berlin
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x' });
  // 00:30 on 18 Oct in Berlin is 22:30 on 17 Oct in UTC.
  t.insertEvent({ role_id: role.id, status: 'dropped', category: 'pay', actor: 'pipeline', reason: 'Band too low', evidence: '"EUR 40k"', ts: '2026-10-17T22:30:00.000Z' });
  assert.match(renderReport(t, { date: '2026-10-18' }).markdown, /## Dropped\n\n- pay: Acme/);
  assert.doesNotMatch(renderReport(t, { date: '2026-10-17' }).markdown, /## Dropped/);
});

test('a run-scoped report and audit cover only that run', () => {
  const date = today(); // before the first write, so a midnight rollover cannot split the test
  const t = fresh();
  const caps = { connectors: {}, browser: 'claude-in-chrome' };
  const a = t.startRun({ kind: 'sweep', capabilities: caps }).run_id;
  const r1 = t.upsertRole({ company: 'Alpha', title: 'Eng', source: 'x' }).role;
  t.transition({ role_id: r1.id, to: 'dropped', reason: 'pay', evidence: '"EUR 40k"', category: 'pay', run_id: a });
  t.finishRun({ run_id: a, summary: 'one' });
  const b = t.startRun({ kind: 'sweep', capabilities: caps }).run_id;
  const r2 = t.upsertRole({ company: 'Beta', title: 'Eng', source: 'x' }).role;
  // A drop without evidence, as an old or buggy writer might leave it.
  t.insertEvent({ role_id: r2.id, status: 'dropped', category: 'pay', actor: 'pipeline', reason: 'pay', run_id: b });
  const ra = renderReport(t, { date, run_id: a }).markdown;
  assert.match(ra, /Alpha/);
  assert.doesNotMatch(ra, /Beta/);
  const rb = renderReport(t, { date, run_id: b }).markdown;
  assert.match(rb, /Beta/);
  assert.doesNotMatch(rb, /Alpha/);
  assert.match(renderReport(t, { date }).markdown, /Alpha/);
  assert.equal(runAudit(t, { run_id: a }).ok, true);
  assert.deepEqual(runAudit(t, { date, run_id: a }).date, null); // run_id wins over date
  assert.equal(runAudit(t, { run_id: b }).failures[0]?.check, 'drop_without_evidence');
  assert.throws(() => runAudit(t, {}), /date or run_id/);
  assert.throws(() => runAudit(t, { run_id: 999 }), /No run 999/);
});

test('the report shows upcoming interviews in local wall time', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x' });
  const start = localDate(Date.now() + 2 * 864e5, 'Europe/Berlin');
  t.addInterview({ role_id: role.id, stage: 'screen', starts_at: `${start}T10:00`, tz: 'Europe/Berlin' });
  t.addInterview({ role_id: role.id, stage: 'tech', starts_at: `${start}T09:00Z` });
  const md = renderReport(t, { date: today() }).markdown;
  assert.ok(md.includes(`- ${start} 10:00 (Europe/Berlin): **Acme**, screen`));
  // No tz on the interview: shown in filters.timezone, not as raw UTC.
  assert.ok(md.includes(`- ${formatLocal(`${start}T09:00:00.000Z`, 'Europe/Berlin')} (Europe/Berlin): **Acme**, tech`));
});

test('an unparseable legacy interview time is shown as written, not a crash', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Acme', title: 'Eng', source: 'x' });
  // The v1 -> v2 migration leaves free text as is; it sorts after any ISO string, so it counts as upcoming.
  t.run("INSERT INTO interviews(role_id, starts_at, stage, created_at) VALUES(?, 'Tuesday 10am', 'screen', ?)", role.id, new Date().toISOString());
  assert.equal(t.openItems().upcoming_interviews.length, 1);
  assert.ok(renderReport(t, { date: today() }).markdown.includes('- Tuesday 10am (Europe/Berlin): **Acme**, screen'));
});

// A run fixed to 10:00-12:00 on 18 Oct. Untagged rows count only when written inside that window.
function windowed(finished: string | null) {
  const t = fresh();
  const run_id = t.startRun({ kind: 'sweep', capabilities: { connectors: {} } }).run_id;
  t.run('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?', '2026-10-18T10:00:00.000Z', finished, run_id);
  const drop = (company: string, ts: string, run: number | null = null) => {
    const { role } = t.upsertRole({ company, title: 'Eng', source: 'x' });
    // No evidence, so the audit flags each one that is in scope.
    t.insertEvent({ role_id: role.id, status: 'dropped', category: 'pay', actor: 'pipeline', reason: 'pay', ts, run_id: run });
    return role.id;
  };
  const art = (role_id: number, created_at: string, run: number | null = null) =>
    t.run("INSERT INTO artifacts(role_id, kind, path_or_ref, created_at, run_id) VALUES(?, 'gmail_draft', ?, ?, ?)", role_id, `d-${created_at}`, created_at, run);
  return { t, run_id, drop, art };
}

test('a run covers untagged rows written inside its window, and tagged rows wherever they are', () => {
  const { t, run_id, drop, art } = windowed('2026-10-18T12:00:00.000Z');
  const inside = drop('Inside', '2026-10-18T11:00:00.000Z');
  const edge = drop('Edge', '2026-10-18T12:00:00.000Z'); // closed at the end
  const before = drop('Before', '2026-10-18T09:59:59.000Z');
  const after = drop('After', '2026-10-18T12:00:01.000Z');
  const tagged = drop('Tagged', '2026-10-18T15:00:00.000Z', run_id);
  const other = drop('Other', '2026-10-18T11:00:00.000Z', run_id + 1); // tagged for another run
  art(inside, '2026-10-18T11:00:00.000Z');
  art(before, '2026-10-18T09:00:00.000Z');
  art(tagged, '2026-10-18T15:00:00.000Z', run_id);
  const md = renderReport(t, { date: '2026-10-18', run_id }).markdown;
  for (const name of ['Inside', 'Edge', 'Tagged']) assert.match(md, new RegExp(`${name} \\(pay\\)`));
  for (const name of ['Before', 'After', 'Other']) assert.doesNotMatch(md, new RegExp(`${name} \\(pay\\)`));
  const audit = runAudit(t, { run_id });
  assert.deepEqual(audit.failures.filter((f) => f.check === 'drop_without_evidence').map((f) => f.role_id).sort(), [inside, edge, tagged].sort());
  assert.deepEqual(audit.failures.filter((f) => f.check === 'draft_not_read_back').map((f) => f.detail).sort(), ['Gmail draft d-2026-10-18T11:00:00.000Z not read back.', 'Gmail draft d-2026-10-18T15:00:00.000Z not read back.']);
  assert.ok(![before, after, other].some((id) => audit.failures.some((f) => f.role_id === id)));
  const listed = t.listArtifacts({ run_id }).artifacts.map((a) => a.role_id).sort();
  assert.deepEqual(listed, [inside, tagged].sort());
  // run_id wins over date in list_artifacts too.
  assert.equal(t.listArtifacts({ run_id, date: '2020-01-01' }).artifacts.length, 2);
});

test('an unfinished run covers untagged rows up to now', () => {
  const { t, run_id, drop } = windowed(null);
  const soon = new Date(Date.now() + 3600e3).toISOString();
  drop('Past', '2026-10-18T11:00:00.000Z');
  drop('Future', soon);
  const md = renderReport(t, { date: '2026-10-18', run_id }).markdown;
  assert.match(md, /Past \(pay\)/);
  assert.doesNotMatch(md, /Future/);
});

test('transition records the pipeline by default and the user when the board passes actor', () => {
  const t = fresh();
  const { role } = t.upsertRole({ company: 'Northwind', title: 'Backend Engineer', url: 'https://jobs.ashbyhq.com/northwind/1', source: 'ashby' });
  verify(t, role.id);
  t.transition({ role_id: role.id, to: 'scored', reason: 'fits', score: 7 });
  t.transition({ role_id: role.id, to: 'queued', reason: 'Moved on the board' }, { actor: 'user' });
  const actors = t.roleDetail({ role_id: role.id }).events.map((e) => [e.status, e.actor]);
  assert.deepEqual(actors.slice(-3), [['verified', 'pipeline'], ['scored', 'pipeline'], ['queued', 'user']]);
});
