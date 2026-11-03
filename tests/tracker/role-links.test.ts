// Historical duplicates: two rows for one posting, from before exact lookups, linked without losing either history.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { boardView } from '../../plugin/servers/tracker/src/board-api.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { importLegacy } from '../../plugin/servers/tracker/src/legacy.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { renderReport, runAudit } from '../../plugin/servers/tracker/src/report.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

function fresh(ctx: TestContext) {
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  const t = new Tracker(db);
  t.db.exec("INSERT INTO companies(id, name, created_at) VALUES(1, 'Acme', '2026-01-01T00:00:00Z'), (2, 'Zenith', '2026-01-01T00:00:00Z')");
  return t;
}

function call(t: Tracker) {
  const handle = makeHandler(t);
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as RpcResponse;
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> & { role?: { id: number } } };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

const ONE = 'https://jobs.ashbyhq.com/acme/one';
type Ev = [ts: string, status: string | null, outcome?: string | null, extra?: { evidence?: string; question?: string }];

// A row as an older release left it, written straight to the tables so no lookup could merge it first.
// Its status is the last status in its history, as insertEvent would have left it.
function legacyRole(t: Tracker, id: number, history: Ev[], { company = 1, url = ONE as string | null, title = 'Engineer' } = {}): number {
  const status = history.filter(([, s]) => s).at(-1)?.[1] ?? null;
  t.run("INSERT INTO roles(id, company_id, title, url, first_seen, updated_at, status) VALUES(?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)", id, company, title, url, status);
  if (url) t.indexRoleUrls(id, [url]);
  for (const [ts, s, outcome, extra] of history) t.run("INSERT INTO events(role_id, ts, status, outcome, evidence, question, actor, reason) VALUES(?, ?, ?, ?, ?, ?, 'import', 'Legacy row')", id, ts, s, outcome ?? null, extra?.evidence ?? null, extra?.question ?? null);
  return id;
}

const PREP: Ev[] = [['2026-01-02T00:00:00Z', 'found'], ['2026-01-03T00:00:00Z', 'scored'], ['2026-01-04T00:00:00Z', 'queued']];
const APPLIED: Ev[] = [['2026-01-01T00:00:00Z', 'found'], ['2026-01-05T00:00:00Z', 'applied']];
const LINK = { reason: 'Same Ashby posting tracked twice', evidence: `Both rows link to ${ONE}` };

test('a linked duplicate keeps its history and resolves to the canonical role', async (ctx) => {
  const t = fresh(ctx);
  const canonicalId = legacyRole(t, 1, APPLIED);
  const duplicateId = legacyRole(t, 2, PREP);
  t.run("INSERT INTO artifacts(role_id, kind, content, created_at) VALUES(?, 'note', 'Prep notes', '2026-01-03T00:00:00Z')", duplicateId);
  t.run("INSERT INTO interviews(role_id, stage, created_at) VALUES(?, 'screen', '2026-01-03T00:00:00Z')", duplicateId);
  const linked = await call(t)('link_duplicate_role', { canonical_role_id: canonicalId, duplicate_role_id: duplicateId, ...LINK });
  assert.equal(linked.error, '');
  assert.deepEqual(linked.data, { canonical_role_id: canonicalId, linked_role_ids: [duplicateId] });
  assert.equal(t.roleDetail({ role_id: duplicateId }).role.id, canonicalId);
  assert.equal(t.roleDetail({ role_id: duplicateId }).requested_role_id, duplicateId);
  assert.deepEqual(t.roleDetail({ role_id: canonicalId }).linked_role_ids, [duplicateId]);
  assert.ok(t.roleDetail({ role_id: canonicalId }).events.some((e) => e.role_id === duplicateId));
  assert.equal(t.one<{ n: number }>('SELECT count(*) AS n FROM roles')?.n, 2);
  assert.equal(boardView(t).roles.length, 1);
});

async function linkedPair(t: Tracker) {
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.equal(r.error, '');
}

test('notes, transitions, interviews, artifacts and updates sent through an old id land on the canonical role', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  const tool = call(t);
  assert.equal((await tool('record', { role_id: 2, reason: 'Recruiter called', actor: 'employer' })).error, '');
  // From the duplicate's own queued status this move would be illegal; the canonical role is applied.
  const moved = await tool('transition', { role_id: 2, to: 'interviewing', reason: 'Invite' });
  assert.equal(moved.error, '');
  assert.equal(moved.data?.role?.id, 1);
  assert.equal((await tool('add_interview', { role_id: 2, stage: 'tech' })).error, '');
  const art = await tool('add_artifact', { role_id: 2, kind: 'note', content: 'Prep' });
  assert.equal((await tool('upsert_role', { id: 2, title: 'Engineer', stack: 'TypeScript' })).data?.role?.id, 1);
  assert.equal(t.mustRole(1).status, 'interviewing');
  assert.equal(t.mustRole(1).stack, 'TypeScript');
  assert.equal(t.mustRole(2).status, 'queued', 'the duplicate row keeps its last status');
  assert.equal(t.mustRole(2).stack, null);
  const fresh_ = t.q<{ role_id: number }>("SELECT role_id FROM events WHERE ts > '2026-06-01'");
  assert.deepEqual(fresh_.map((e) => e.role_id), [1, 1]);
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM interviews WHERE stage = ?', 'tech')?.role_id, 1);
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM artifacts WHERE id = ?', Number(art.data?.artifact_id))?.role_id, 1);
  assert.equal((await tool('gate_check', { role_id: 2 })).data?.role_id, 1);
});

const linkCount = (t: Tracker) => t.one<{ n: number }>('SELECT COUNT(*) AS n FROM role_links')?.n;

test('a role cannot be linked to itself', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 1, ...LINK });
  assert.match(r.error, /to itself/);
  assert.equal(linkCount(t), 0);
});

test('roles at different companies cannot be linked', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP, { company: 2, url: 'https://jobs.ashbyhq.com/zenith/one' });
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /Role 2 is at Zenith and role 1 at Acme\. Only roles at the same company/);
  assert.equal(linkCount(t), 0);
});

test('a link needs a reason and evidence', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP);
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, reason: 'Same job' })).error, /evidence is required/);
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, reason: 'Same job', evidence: '   ' })).error, /evidence/);
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, reason: ' ', evidence: 'Same URL' })).error, /reason/);
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 9, ...LINK })).error, /No role 9/);
  assert.equal(linkCount(t), 0);
});

test('two posting IDs from one employer board are different requisitions and are not linked', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP, { url: 'https://jobs.ashbyhq.com/acme/two' });
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /ashby acme\/one and ashby acme\/two are different postings/);
  assert.equal(linkCount(t), 0);
  // A posting on another ATS can be the same job after a move, which the evidence vouches for.
  legacyRole(t, 3, PREP, { url: 'https://jobs.lever.co/acme/0b1c' });
  assert.equal((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 3, ...LINK })).error, '');
});

const REJECTED: Ev[] = [...APPLIED, ['2026-02-01T00:00:00Z', 'closed', 'rejected']];
const OFFER: Ev[] = [...APPLIED, ['2026-01-20T00:00:00Z', 'interviewing'], ['2026-02-02T00:00:00Z', 'offer']];

test('conflicting outcomes are not linked, and no status changes', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, REJECTED);
  legacyRole(t, 2, OFFER);
  for (const [canonical_role_id, duplicate_role_id] of [[1, 2], [2, 1]]) {
    const r = await call(t)('link_duplicate_role', { canonical_role_id, duplicate_role_id, ...LINK });
    assert.match(r.error, canonical_role_id === 1 ? /role 1 is closed \(rejected\) and role 2 is offer/ : /role 2 is offer and role 1 is closed \(rejected\)/);
  }
  assert.equal(linkCount(t), 0);
  assert.deepEqual([t.mustRole(1).status, t.mustRole(2).status], ['closed', 'offer']);
});

test('a duplicate with an application history needs that state on the canonical role first', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, PREP);
  legacyRole(t, 2, APPLIED);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /Role 2 is applied, but role 1 has no application history/);
  assert.equal(linkCount(t), 0);
  assert.equal((await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 1, ...LINK })).error, '');
});

test('matching histories link only when the canonical role reached the state last', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, REJECTED);
  legacyRole(t, 2, [...APPLIED, ['2026-02-03T00:00:00Z', 'closed', 'rejected']]);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /Role 2 became closed \(rejected\) on 2026-02-03T00:00:00Z, after role 1 \(2026-02-01T00:00:00Z\)/);
  assert.equal(linkCount(t), 0);
  assert.equal((await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 1, ...LINK })).error, '');
  assert.deepEqual(t.roleGroupIds(1), [2, 1]);
  assert.deepEqual([t.mustRole(1).status, t.mustRole(2).status], ['closed', 'closed']);
});

test('two preparatory rows link when the canonical one moved last', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, [['2026-01-01T00:00:00Z', 'found']]);
  legacyRole(t, 2, PREP);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /Role 2 became queued on 2026-01-04T00:00:00Z, after role 1 \(2026-01-01T00:00:00Z\)/);
  assert.equal((await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 1, ...LINK })).error, '');
});

test('linking the same pair again returns the current group and writes nothing', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  const before = t.q<object>('SELECT * FROM role_links').map((r) => ({ ...r }));
  const again = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, reason: 'Again', evidence: 'Same URL' });
  assert.equal(again.error, '');
  assert.deepEqual(again.data, { canonical_role_id: 1, linked_role_ids: [2] });
  assert.deepEqual(t.q<object>('SELECT * FROM role_links').map((r) => ({ ...r })), before);
});

test('ids that are already linked resolve to their root, or are refused with the root to use', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  legacyRole(t, 3, PREP);
  // A duplicate given as canonical stands for its root.
  const viaOld = await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 3, ...LINK });
  assert.deepEqual(viaOld.data, { canonical_role_id: 1, linked_role_ids: [2, 3] });
  // A group's root cannot become a duplicate of one of its own members.
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 1, ...LINK })).error, /Role 1 is the canonical role of this group \(linked: 2, 3\)/);
  // A duplicate already linked elsewhere is not silently moved.
  legacyRole(t, 4, REJECTED.map(([ts, s, o]) => [ts.replace('2026-', '2027-'), s, o] as Ev));
  assert.match((await call(t)('link_duplicate_role', { canonical_role_id: 4, duplicate_role_id: 2, ...LINK })).error, /Role 2 is already linked to role 1\. Nothing was written\. To merge the groups, link role 1 into role 4/);
  assert.deepEqual(t.roleGroupIds(1), [1, 2, 3]);
  assert.deepEqual(t.roleGroupIds(4), [4]);
});

test('linking a canonical role moves its duplicates to the new root in one step', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  legacyRole(t, 3, [...APPLIED, ['2026-03-01T00:00:00Z', 'applied']]);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 3, duplicate_role_id: 1, ...LINK });
  assert.deepEqual(r.data, { canonical_role_id: 3, linked_role_ids: [1, 2] });
  for (const id of [1, 2, 3]) assert.deepEqual(t.roleGroupIds(id), [3, 1, 2]);
  assert.deepEqual(t.q<object>('SELECT duplicate_role_id, canonical_role_id, reason FROM role_links ORDER BY duplicate_role_id').map((l) => ({ ...l })), [
    { duplicate_role_id: 1, canonical_role_id: 3, reason: LINK.reason },
    { duplicate_role_id: 2, canonical_role_id: 3, reason: LINK.reason },
  ]);
  assert.equal(t.roleDetail({ role_id: 2 }).role.id, 3);
  assert.equal(boardView(t).roles.length, 1);
});

test('a link that fails part-way leaves every earlier link as it was', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  legacyRole(t, 3, [...APPLIED, ['2026-03-01T00:00:00Z', 'applied']]);
  // The flattening update runs, then the new link's insert fails.
  t.db.exec("CREATE TEMP TRIGGER fail_link BEFORE INSERT ON role_links BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  await assert.rejects(async () => t.linkDuplicateRole({ canonical_role_id: 3, duplicate_role_id: 1, ...LINK }), /disk full/);
  assert.deepEqual(t.q<object>('SELECT duplicate_role_id, canonical_role_id FROM role_links').map((l) => ({ ...l })), [{ duplicate_role_id: 2, canonical_role_id: 1 }]);
  assert.deepEqual(t.roleGroupIds(2), [1, 2]);
});

test('artifacts and interviews keep their original role and show under the group', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP);
  t.run("INSERT INTO artifacts(id, role_id, kind, content, created_at) VALUES(10, 2, 'note', 'Old prep', '2026-01-03T00:00:00Z'), (11, 1, 'confirmation', 'Thanks', '2026-01-05T00:00:00Z')");
  t.run("INSERT INTO interviews(id, role_id, stage, created_at) VALUES(20, 2, 'screen', '2026-01-03T00:00:00Z')");
  await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.deepEqual(t.q<object>('SELECT id, role_id FROM artifacts ORDER BY id').map((r) => ({ ...r })), [{ id: 10, role_id: 2 }, { id: 11, role_id: 1 }]);
  assert.deepEqual(t.q<object>('SELECT id, role_id FROM interviews').map((r) => ({ ...r })), [{ id: 20, role_id: 2 }]);
  const detail = t.roleDetail({ role_id: 1 });
  assert.deepEqual(detail.artifacts.map((a) => [a.id, a.role_id]), [[10, 2], [11, 1]]);
  assert.deepEqual(detail.interviews.map((i) => [i.id, i.role_id]), [[20, 2]]);
  assert.deepEqual(detail.links.map((l) => ({ ...l, created_at: '' })), [{ duplicate_role_id: 2, title: 'Engineer', url: ONE, status: 'queued', ...LINK, created_at: '' }]);
  for (const role_id of [1, 2]) assert.deepEqual(t.listArtifacts({ role_id }).artifacts.map((a) => a.id), [10, 11]);
  assert.deepEqual(t.listArtifacts({ role_id: 1, kind: 'note' }).artifacts.map((a) => a.role_id), [2]);
});

test('an exact match on several rows of one group is the canonical role; independent rows still conflict', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  const found = t.findCompany({ url: `${ONE}?utm_source=mail` });
  assert.deepEqual(found.exact_role_ids, [1]);
  assert.equal(found.verdict, 'skip');
  assert.doesNotMatch(found.why, /matches roles/);
  const up = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE, stack: 'Go' });
  assert.equal(up.created, false);
  assert.equal(up.role.id, 1);
  // A URL already held by the duplicate is the group's own, so the canonical role may take it.
  t.indexRoleUrls(2, ['https://www.linkedin.com/jobs/view/77']);
  assert.equal(t.upsertRole({ id: 1, title: 'Engineer', url_aliases: ['https://www.linkedin.com/jobs/view/77'], identity_evidence: 'Card links to Ashby' }).role.id, 1);
  // A title-only lead lists the group once, as its canonical role.
  assert.deepEqual(t.upsertRole({ company: 'Acme', title: 'Engineer' }).possible_role_ids, [1]);
  // A third row for the same posting that was never linked is another history: still a conflict.
  legacyRole(t, 4, PREP);
  assert.deepEqual(t.findCompany({ url: ONE }).exact_role_ids, [1, 4]);
  assert.throws(() => t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE }), /matches roles 1, 4/);
});

test('reports and audits attribute a duplicate\'s old events to the canonical card', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, []);
  t.run("INSERT INTO events(id, role_id, ts, status, actor, reason) VALUES(50, 2, '2026-01-04T10:00:00Z', 'applied', 'pipeline', 'Submitted')");
  t.run("UPDATE roles SET title = 'Senior Engineer' WHERE id = 1");
  await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(renderReport(t, { date: '2026-01-04' }).markdown, /\*\*Acme\*\*, Senior Engineer\./);
  assert.deepEqual(runAudit(t, { date: '2026-01-04' }).failures.map((f) => [f.check, f.role_id]), [['applied_without_confirmation', 1]]);
  assert.equal(t.one<{ role_id: number }>('SELECT role_id FROM events WHERE id = 50')?.role_id, 2, 'the event itself is not rewritten');
});

test('the legacy import treats a linked group as one role', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, PREP);
  legacyRole(t, 2, APPLIED);
  await call(t)('link_duplicate_role', { canonical_role_id: 2, duplicate_role_id: 1, ...LINK });
  importLegacy(t, {
    queue: [
      { filename: 'acme-engineer.md', content: `# Acme · Engineer\n\n- **Posting:** ${ONE}?utm_source=old\n` },
      { filename: 'acme-prep.md', content: '# Acme · Engineer\n\nPrep notes\n' },
    ],
    applied_log: '| 2026-03-01 | Acme | Engineer | Ashby | Applied | Awaiting reply |\n',
  });
  assert.deepEqual(t.q<{ role_id: number }>("SELECT role_id FROM artifacts WHERE path_or_ref LIKE 'legacy:%' ORDER BY id").map((a) => a.role_id), [2, 2]);
  assert.equal(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM roles')?.n, 2);
  assert.equal(t.mustRole(1).status, 'queued');
});

test('the legacy import refuses a URL held by two independent roles', (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, PREP);
  legacyRole(t, 2, APPLIED);
  assert.throws(() => importLegacy(t, { queue: [{ filename: 'acme.md', content: `# Acme · Engineer\n\n- **Posting:** ${ONE}\n` }] }), /matches roles 1, 2/);
  assert.equal(t.one<{ n: number }>('SELECT COUNT(*) AS n FROM artifacts')?.n, 0);
});

test('a URL both rows hold is listed once, with the canonical role\'s evidence', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, PREP, { url: `${ONE}?utm_source=mail` });
  t.run("UPDATE role_urls SET evidence = 'Seen on the careers page' WHERE role_id = 1");
  t.run("UPDATE role_urls SET evidence = 'From a recruiter mail' WHERE role_id = 2");
  await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.deepEqual(t.roleDetail({ role_id: 2 }).urls.map((u) => ({ ...u })), [{ url: ONE, normalized_url: ONE, evidence: 'Seen on the careers page' }]);
});

test('closed with another outcome is a disagreement', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, REJECTED);
  legacyRole(t, 2, [...APPLIED, ['2026-01-20T00:00:00Z', 'closed', 'withdrawn']]);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /role 1 is closed \(rejected\) and role 2 is closed \(withdrawn\)/);
  assert.equal(linkCount(t), 0);
});

test('a different latest status is a disagreement even when the canonical one is newer', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, [...APPLIED, ['2026-02-05T00:00:00Z', 'interviewing']]);
  legacyRole(t, 2, [...APPLIED, ['2026-02-02T00:00:00Z', 'offer']]);
  const r = await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK });
  assert.match(r.error, /role 1 is interviewing and role 2 is offer/);
  assert.equal(linkCount(t), 0);
});

test('the same state reached at the same moment links', async (ctx) => {
  const t = fresh(ctx);
  legacyRole(t, 1, APPLIED);
  legacyRole(t, 2, APPLIED);
  assert.equal((await call(t)('link_duplicate_role', { canonical_role_id: 1, duplicate_role_id: 2, ...LINK })).error, '');
});

test('an event written straight to a linked duplicate lands on the canonical role', async (ctx) => {
  const t = fresh(ctx);
  await linkedPair(t);
  t.insertEvent({ role_id: 2, status: 'interviewing', actor: 'employer', reason: 'Invite' });
  assert.equal(t.one<{ role_id: number }>("SELECT role_id FROM events WHERE reason = 'Invite'")?.role_id, 1);
  assert.deepEqual([t.mustRole(1).status, t.mustRole(2).status], ['interviewing', 'queued']);
});

test('views count a group once and take its newest events and questions', (ctx) => {
  const t = fresh(ctx);
  t.run("INSERT INTO companies(id, name, created_at) VALUES(3, 'Orbit', '2026-01-01T00:00:00Z'), (4, 'Nimbus', '2026-01-01T00:00:00Z')");
  const recent = new Date(Date.now() - 864e5).toISOString();
  const link = (canonical_role_id: number, duplicate_role_id: number) => t.linkDuplicateRole({ canonical_role_id, duplicate_role_id, ...LINK });
  // Fresh queue: the canonical role's own events are old, the duplicate has a note from yesterday.
  legacyRole(t, 10, [['2026-01-01T00:00:00Z', 'found'], ['2026-01-10T00:00:00Z', 'queued', null, { question: 'Canonical question?' }]]);
  legacyRole(t, 11, [['2026-01-02T00:00:00Z', 'found'], ['2026-01-05T00:00:00Z', 'queued'], [recent, null]]);
  link(10, 11);
  // Stale queue: everything is old, the duplicate's note is the newest.
  const zenith = 'https://jobs.ashbyhq.com/zenith/one';
  legacyRole(t, 20, [['2026-01-10T00:00:00Z', 'queued']], { company: 2, url: zenith });
  legacyRole(t, 21, [['2026-01-05T00:00:00Z', 'queued'], ['2026-02-01T00:00:00Z', null]], { company: 2, url: zenith });
  link(20, 21);
  // Live process: both rows interviewing, the group's latest event (the duplicate's note) asks a question.
  const orbit = 'https://jobs.ashbyhq.com/orbit/one';
  legacyRole(t, 30, [...APPLIED, ['2026-02-05T00:00:00Z', 'interviewing']], { company: 3, url: orbit });
  legacyRole(t, 31, [...APPLIED, ['2026-02-01T00:00:00Z', 'interviewing'], ['2026-02-10T00:00:00Z', null, null, { question: 'Which slot?' }]], { company: 3, url: orbit });
  link(30, 31);
  // Rejection: both closed at the same moment; the duplicate's event was written last, so it is the group's latest.
  const nimbus = 'https://jobs.ashbyhq.com/nimbus/one';
  legacyRole(t, 40, [...APPLIED, ['2026-03-01T00:00:00Z', 'closed', 'rejected', { evidence: 'Canonical feedback' }]], { company: 4, url: nimbus });
  legacyRole(t, 41, [...APPLIED, ['2026-03-01T00:00:00Z', 'closed', 'rejected', { evidence: 'Duplicate feedback' }]], { company: 4, url: nimbus });
  link(40, 41);

  const items = t.openItems();
  assert.deepEqual(items.queue.map((q) => [q.id, q.question, q.last_event]), [[10, 'Canonical question?', recent]]);
  assert.deepEqual(items.stale_queue.map((q) => [q.id, q.last_event]), [[20, '2026-02-01T00:00:00Z']]);
  assert.deepEqual(items.questions.map((q) => [q.id, q.question]), [[30, 'Which slot?']]);
  const summary = t.pipelineSummary();
  assert.deepEqual(summary.live_processes.map((r) => r.id), [30]);
  assert.deepEqual(summary.rejections.map((r) => [r.id, r.evidence]), [[40, 'Duplicate feedback']]);
  assert.deepEqual(summary.queue.map((q) => [q.id, q.last_event]), [[10, recent]]);
  assert.deepEqual(summary.stale_queue.map((q) => [q.id, q.last_activity]), [[20, '2026-02-01T00:00:00Z']]);
  assert.equal(boardView(t).roles.find((r) => r.id === 10)?.last_event, recent);
});
