// Posting identity: exact URLs and ATS posting IDs decide which role a lead is, never the title alone.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { boardMove } from '../../plugin/servers/tracker/src/board-api.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { importLegacy } from '../../plugin/servers/tracker/src/legacy.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

function fresh(ctx: TestContext) {
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  return new Tracker(db);
}

function call(t: Tracker) {
  const handle = makeHandler(t);
  return async (name: string, args: Record<string, unknown>) => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as RpcResponse;
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, never> };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

const count = (t: Tracker, table: string) => t.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
const counts = (t: Tracker) => ({ roles: count(t, 'roles'), companies: count(t, 'companies'), urls: count(t, 'role_urls') });

// node:sqlite rows have a null prototype, which strict deepEqual counts as a difference.
const rows = (list: readonly object[] | undefined) => list?.map((r) => ({ ...r }));

const ONE = 'https://jobs.ashbyhq.com/acme/one';
const LINKEDIN = 'https://www.linkedin.com/jobs/view/123';

test('same title with different posting IDs creates separate roles', (ctx) => {
  const t = fresh(ctx);
  const first = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const second = t.upsertRole({ company: 'Acme', title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/two' });
  assert.notEqual(second.role.id, first.role.id);
  assert.equal(second.created, true);
});

test('confirmed aliases return one role', (ctx) => {
  const t = fresh(ctx);
  const first = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  t.upsertRole({ id: first.role.id, title: 'Engineer', url_aliases: [LINKEDIN], identity_evidence: `LinkedIn card links to ${ONE}` });
  assert.equal(t.findCompany({ url: LINKEDIN }).verdict, 'skip');
  assert.equal(t.upsertRole({ company: 'Acme', title: 'Product Engineer', url: `${ONE}?utm_source=mail` }).role.id, first.role.id);
});

test('URL refresh retains the previous lookup', (ctx) => {
  const t = fresh(ctx);
  const old = 'https://careers.acme.example/jobs/old';
  const fresher = 'https://careers.acme.example/jobs/new';
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: old });
  assert.equal(t.upsertRole({ id: role.id, title: 'Engineer', url: fresher }).role.url, fresher);
  assert.equal(t.findCompany({ url: old }).verdict, 'skip');
  assert.equal(t.findCompany({ url: fresher }).verdict, 'skip');
  const again = t.upsertRole({ company: 'Acme', title: 'Engineer', url: old });
  assert.equal(again.role.id, role.id);
  assert.equal(again.created, false);
  assert.equal(again.role.url, fresher, 'seeing the old link again does not move the role back');
});

test('the same posting ID under another employer on a shared ATS host is another role', (ctx) => {
  const t = fresh(ctx);
  const acme = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const zenith = t.upsertRole({ company: 'Zenith', title: 'Engineer', url: 'https://jobs.ashbyhq.com/zenith/one' });
  assert.equal(zenith.created, true);
  assert.notEqual(zenith.company.id, acme.company.id);
  assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/zenith/one' }).exact_role_ids, [zenith.role.id]);
});

test('two links to one ATS posting are one role even when the URLs differ', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const apply = t.upsertRole({ company: 'Acme', title: 'Engineer', url: 'https://jobs.ashbyhq.com/ACME/one/application' });
  assert.equal(apply.role.id, role.id);
  assert.equal(apply.created, false);
  assert.equal(apply.role.url, ONE);
  assert.deepEqual(t.findCompany({ url: 'https://jobs.ashbyhq.com/acme/one/application?utm_source=x' }).exact_role_ids, [role.id]);
  assert.deepEqual(rows(t.roleDetail({ role_id: role.id }).postings), [{ provider: 'ashby', employer_key: 'acme', posting_id: 'one' }]);
});

test('a title-only lead creates a distinct role and names the possible matches', (ctx) => {
  const t = fresh(ctx);
  const first = t.upsertRole({ company: 'Acme', title: 'Senior Engineer', url: ONE });
  assert.deepEqual(first.possible_role_ids, []);
  t.upsertRole({ company: 'Acme', title: 'Designer' });
  t.upsertRole({ company: 'Zenith', title: 'Senior Engineer' });
  const lead = t.upsertRole({ company: 'Acme', title: 'senior  engineer' });
  assert.equal(lead.created, true);
  assert.notEqual(lead.role.id, first.role.id);
  assert.deepEqual(lead.possible_role_ids, [first.role.id]);
  assert.equal(t.roleDetail({ role_id: first.role.id }).role.title, 'Senior Engineer', 'the candidate is not touched');
  // A link that is not on file changes nothing about that: the title is still only a candidate.
  const linked = t.upsertRole({ company: 'Acme', title: 'Senior Engineer', url: 'https://www.linkedin.com/jobs/view/9' });
  assert.equal(linked.created, true);
  assert.deepEqual(linked.possible_role_ids, [first.role.id, lead.role.id]);
});

test('an explicit id still updates a role, with or without a URL', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const updated = t.upsertRole({ id: role.id, title: 'Staff Engineer', stack: 'TypeScript', url: `${ONE}?utm_source=x` });
  assert.equal(updated.created, false);
  assert.equal(updated.role.title, 'Staff Engineer');
  assert.equal(updated.role.stack, 'TypeScript');
  assert.equal(updated.role.url, ONE, 'a tracking parameter is not a new link');
  assert.deepEqual(updated.possible_role_ids, []);
  assert.throws(() => t.upsertRole({ id: 99, title: 'Engineer' }), /No role 99/);
});

test('a null url does not clear the stored link', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  assert.equal(t.upsertRole({ id: role.id, title: 'Engineer', url: null }).role.url, ONE);
});

test('an exact match is found across companies and never moves the role', (ctx) => {
  const t = fresh(ctx);
  const { role, company } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const before = counts(t);
  const r = t.upsertRole({ company: 'Totally Different Staffing', company_aliases: ['TDS'], company_domain: 'tds.example', title: 'Engineer', url: ONE });
  assert.equal(r.role.id, role.id);
  assert.equal(r.role.company_id, company.id);
  assert.equal(r.company.name, 'Acme');
  assert.deepEqual(counts(t), before);
  const stored = t.mustCompany(company.id);
  assert.ok(!stored.aliases.includes('TDS'), 'a name that disagrees must not teach the company an alias');
  assert.equal(stored.domain, null);
});

test('an exact match under the company\'s own name still learns its aliases', (ctx) => {
  const t = fresh(ctx);
  const { role, company } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  t.upsertRole({ company: 'Acme', company_aliases: ['Acme Robots'], company_domain: 'acme.example', title: 'Engineer', url: ONE });
  const stored = t.mustCompany(company.id);
  assert.ok(stored.aliases.includes('Acme Robots'));
  assert.equal(stored.domain, 'acme.example');
  assert.equal(t.upsertRole({ title: 'Engineer', url: ONE }).role.id, role.id, 'the URL alone identifies a known role');
  assert.throws(() => t.upsertRole({ title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/new' }), /company is required/);
});

test('an aggregator alias never replaces the employer URL', (ctx) => {
  const t = fresh(ctx);
  const careers = 'https://careers.acme.example/jobs/1';
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: careers });
  t.upsertRole({ id: role.id, title: 'Engineer', url_aliases: [LINKEDIN], identity_evidence: `The card links to ${careers}` });
  const seen = t.upsertRole({ company: 'Acme', title: 'Engineer', url: LINKEDIN });
  assert.equal(seen.role.id, role.id);
  assert.equal(seen.role.url, careers);

  const ats = t.upsertRole({ company: 'Zenith', title: 'Engineer', url: 'https://jobs.ashbyhq.com/zenith/1' });
  const byId = t.upsertRole({ id: ats.role.id, title: 'Engineer', url: 'https://www.linkedin.com/jobs/view/5' });
  assert.equal(byId.role.url, 'https://jobs.ashbyhq.com/zenith/1', 'even by id, a listing does not outrank an ATS link');
  assert.equal(byId.role.ats, 'ashby');
  assert.deepEqual(t.findCompany({ url: 'https://www.linkedin.com/jobs/view/5' }).exact_role_ids, [ats.role.id]);
});

test('an ATS link replaces an aggregator URL and keeps the aggregator lookup', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: LINKEDIN });
  assert.equal(role.ats, null);
  const updated = t.upsertRole({ id: role.id, title: 'Engineer', url: ONE });
  assert.equal(updated.role.url, ONE);
  assert.equal(updated.role.ats, 'ashby');
  assert.deepEqual(t.findCompany({ url: LINKEDIN }).exact_role_ids, [role.id]);

  // The same rule holds for an alias added to a known role.
  const listed = t.upsertRole({ company: 'Zenith', title: 'Engineer', url: 'https://www.linkedin.com/jobs/view/5' }).role;
  const upgraded = t.upsertRole({ id: listed.id, title: 'Engineer', url_aliases: ['https://jobs.ashbyhq.com/zenith/1'], identity_evidence: 'The card links to the Ashby page' });
  assert.equal(upgraded.role.url, 'https://jobs.ashbyhq.com/zenith/1');
});

test('a new role takes its ATS alias as its URL when the given URL is only a listing', (ctx) => {
  const t = fresh(ctx);
  const listing = 'https://www.linkedin.com/jobs/view/5';
  const ats = 'https://jobs.ashbyhq.com/zenith/1';
  const made = t.upsertRole({ company: 'Zenith', title: 'Engineer', url: listing, url_aliases: [ats], identity_evidence: 'The card links to the Ashby page' });
  assert.equal(made.created, true);
  assert.equal(made.role.url, ats);
  assert.equal(made.role.ats, 'ashby');
  assert.deepEqual(t.findCompany({ url: listing }).exact_role_ids, [made.role.id]);
  assert.deepEqual(t.roleDetail({ role_id: made.role.id }).urls.map((u) => u.url).sort(), [ats, listing].sort());
  // An ATS URL given as url keeps its place over an ATS alias.
  const both = t.upsertRole({ company: 'Orbit', title: 'Engineer', url: 'https://jobs.lever.co/orbit/7', url_aliases: [ats.replace('zenith', 'orbit')], identity_evidence: 'Same req number on both pages' });
  assert.equal(both.role.url, 'https://jobs.lever.co/orbit/7');
});

test('one role never holds two postings from the same employer board', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const after = () => ({ ...counts(t), postings: count(t, 'role_postings') });
  const before = after();
  const conflict = /ashby acme\/one and ashby acme\/two are different postings/;
  const two = 'https://jobs.ashbyhq.com/acme/two';
  assert.match((await c('upsert_role', { id: role.id, title: 'Engineer', url: two })).error, conflict);
  assert.match((await c('upsert_role', { id: role.id, title: 'Engineer', url: two, identity_evidence: 'Looks the same' })).error, conflict, 'evidence does not make two reqs one');
  assert.match((await c('upsert_role', { id: role.id, title: 'Engineer', url_aliases: [two], identity_evidence: 'Looks the same' })).error, conflict);
  // Without id: a known alias pulls the call onto the role, and the new URL would add the second req.
  assert.match((await c('upsert_role', { company: 'Acme', title: 'Engineer', url: two, url_aliases: [ONE], identity_evidence: 'Looks the same' })).error, conflict);
  // A new role cannot start with two either.
  assert.match((await c('upsert_role', { company: 'Zenith', title: 'Engineer', url: 'https://jobs.ashbyhq.com/zenith/1', url_aliases: ['https://jobs.ashbyhq.com/zenith/2'], identity_evidence: 'x' })).error, /ashby zenith\/1 and ashby zenith\/2 are different postings/);
  assert.deepEqual(after(), before);
  assert.equal(t.mustRole(role.id).url, ONE);
  // The same posting again, under any link to it, is fine.
  for (const url of [`${ONE}?utm_source=x`, 'https://jobs.ashbyhq.com/ACME/one/application']) assert.equal((await c('upsert_role', { id: role.id, title: 'Engineer', url })).error, '');
  assert.deepEqual(after(), { ...before, urls: before.urls + 1 });
});

test('a posting on another ATS or employer board joins a role only with evidence', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const moved = 'https://jobs.lever.co/acme/abc';
  const before = counts(t);
  assert.match((await c('upsert_role', { id: role.id, title: 'Engineer', url: moved })).error, /lever acme\/abc is on another ATS or employer board than ashby acme\/one.*identity_evidence/);
  assert.match((await c('upsert_role', { id: role.id, title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme-labs/one' })).error, /identity_evidence/);
  assert.deepEqual(counts(t), before);
  const evidence = 'Acme moved to Lever; the req number 42 matches';
  const ok = await c('upsert_role', { id: role.id, title: 'Engineer', url: moved, identity_evidence: evidence });
  assert.equal(ok.error, '');
  assert.equal(t.mustRole(role.id).url, moved);
  // The evidence that let the posting join is kept with it; the URL the role already had keeps none.
  const byUrl = Object.fromEntries(t.roleDetail({ role_id: role.id }).urls.map((u) => [u.url, u.evidence]));
  assert.deepEqual(byUrl, { [ONE]: null, [moved]: evidence });
  assert.deepEqual(t.roleDetail({ role_id: role.id }).postings.map((p) => p.provider).sort(), ['ashby', 'lever']);
  assert.deepEqual(t.findCompany({ url: ONE }).exact_role_ids, [role.id]);
});

test('upsert_role and get_role expose aliases, evidence and postings', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const evidence = `LinkedIn card links to ${ONE}`;
  const made = await c('upsert_role', { company: 'Acme', title: 'Engineer', url: `${ONE}?utm_source=mail`, url_aliases: [LINKEDIN], identity_evidence: evidence });
  assert.equal(made.error, '');
  assert.deepEqual(made.data?.possible_role_ids, []);
  const role = made.data?.role as unknown as { id: number };
  const detail = await c('get_role', { role_id: role.id });
  // The evidence is about the alias. The main URL was given, not inferred, so it carries none.
  assert.deepEqual(rows(detail.data?.urls), [
    { url: `${ONE}?utm_source=mail`, normalized_url: ONE, evidence: null },
    { url: LINKEDIN, normalized_url: LINKEDIN, evidence },
  ]);
  assert.deepEqual(rows(detail.data?.postings), [{ provider: 'ashby', employer_key: 'acme', posting_id: 'one' }]);
  const found = await c('find_company', { url: LINKEDIN });
  assert.equal(found.data?.verdict, 'skip');
  assert.deepEqual(found.data?.exact_role_ids, [role.id]);
});

test('upsert_role rejects bad aliases and writes nothing', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const before = counts(t);
  const base = { id: role.id, title: 'Engineer' };
  assert.match((await c('upsert_role', { ...base, url_aliases: LINKEDIN, identity_evidence: 'x' })).error, /url_aliases: expected array/);
  assert.match((await c('upsert_role', { ...base, url_aliases: [LINKEDIN, 7], identity_evidence: 'x' })).error, /url_aliases\[1\] must be a URL string/);
  assert.match((await c('upsert_role', { ...base, url_aliases: ['  '], identity_evidence: 'x' })).error, /url_aliases\[0\] must be a URL string/);
  assert.match((await c('upsert_role', { ...base, url_aliases: [LINKEDIN] })).error, /need identity_evidence/);
  assert.match((await c('upsert_role', { ...base, url_aliases: [LINKEDIN], identity_evidence: '   ' })).error, /need identity_evidence/);
  assert.match((await c('upsert_role', { ...base, url_aliases: ['nonsense'], identity_evidence: 'x' })).error, /Not a valid URL/);
  assert.match((await c('upsert_role', { ...base, url_aliases: ['https://user:secret@example.test/job'], identity_evidence: 'x' })).error, /credentials/);
  assert.match((await c('upsert_role', { company: 'New Co', title: 'Engineer', url: 'ftp://example.test/job' })).error, /http\(s\)/);
  assert.deepEqual(counts(t), before);
  assert.equal((await c('upsert_role', { ...base, url_aliases: [] })).error, '', 'an empty list claims nothing');
});

test('upsert_role refuses to give one role an identity another role holds', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const a = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE }).role;
  const b = t.upsertRole({ company: 'Acme', title: 'Designer', url: 'https://jobs.ashbyhq.com/acme/two' }).role;
  const before = counts(t);
  const refused = new RegExp(`belongs to role ${a.id}, so it cannot be added to role ${b.id}`);
  assert.match((await c('upsert_role', { id: b.id, title: 'Designer', url: `${ONE}?utm_source=x` })).error, refused);
  assert.match((await c('upsert_role', { id: b.id, title: 'Designer', url: 'https://jobs.ashbyhq.com/acme/one/application' })).error, refused, 'same posting key, different URL');
  assert.match((await c('upsert_role', { id: b.id, title: 'Designer', url_aliases: [ONE], identity_evidence: 'A guess' })).error, refused);
  // Two known roles in one call is a request to merge them, which this tool does not do.
  const both = await c('upsert_role', { company: 'Acme', title: 'Engineer', url: ONE, url_aliases: [b.url as string], identity_evidence: 'A guess' });
  assert.match(both.error, new RegExp(`matches roles ${a.id}, ${b.id}`));
  assert.deepEqual(counts(t), before);
  assert.equal(t.mustRole(b.id).title, 'Designer');
});

test('a lookup conflict creates no company and leaves both roles alone', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const a = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE }).role;
  const b = t.upsertRole({ company: 'Acme', title: 'Engineer', url: 'https://jobs.ashbyhq.com/acme/two' }).role;
  t.run('INSERT INTO role_postings(role_id, provider, employer_key, posting_id) VALUES(?, ?, ?, ?)', b.id, 'ashby', 'acme', 'one');
  const before = counts(t);
  assert.match((await c('upsert_role', { company: 'New Co', title: 'Other', url: ONE })).error, new RegExp(`matches roles ${a.id}, ${b.id}.*pass id`));
  assert.deepEqual(counts(t), before);
  assert.equal(t.mustRole(a.id).title, 'Engineer');
  // Either holder can still be updated by id, so the conflict does not freeze them.
  assert.equal(t.upsertRole({ id: a.id, title: 'Engineer', stack: 'Go', url: ONE }).role.stack, 'Go');
  const looked = t.findCompany({ url: ONE });
  assert.equal(looked.verdict, 'skip');
  assert.match(looked.why, new RegExp(`roles ${a.id}, ${b.id}`));
});

test('a lookup never throws on a URL a write would reject', (ctx) => {
  const t = fresh(ctx);
  t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  for (const url of ['nonsense', 'mailto:jobs@acme.example', 'https://user:secret@example.test/job']) assert.deepEqual(t.findCompany({ url }).exact_role_ids, []);
});

test('two connections upserting one posting create one role', { timeout: 30_000 }, async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-identity-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'tracker.db');
  openDb(path).close();
  const url = (f: string) => JSON.stringify(new URL(`../../plugin/servers/tracker/src/${f}`, import.meta.url).href);
  const start = Date.now() + 500; // the children start writing together, after their startup cost
  const run = () => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
      import { openDb } from ${url('db.ts')};
      import { Tracker } from ${url('tracker.ts')};
      const db = openDb(${JSON.stringify(path)});
      const t = new Tracker(db);
      while (Date.now() < ${start});
      const r = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ${JSON.stringify(ONE)} });
      process.stdout.write(String(r.role.id) + ' ' + r.created);
      db.close();
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: 4 }, run));
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0]);
  assert.deepEqual(results.map((r) => r.out).sort(), ['1 false', '1 false', '1 false', '1 true']);
  const db = openDb(path);
  ctx.after(() => db.close());
  assert.deepEqual(counts(new Tracker(db)), { roles: 1, companies: 1, urls: 1 });
});

test('a main URL that joins a role only through a known alias keeps the evidence', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url: ONE });
  const evidence = 'The LinkedIn card links to the Ashby page';
  assert.equal(t.upsertRole({ company: 'Acme', title: 'Engineer', url: LINKEDIN, url_aliases: [ONE], identity_evidence: evidence }).role.id, role.id);
  const byUrl = Object.fromEntries(t.roleDetail({ role_id: role.id }).urls.map((u) => [u.url, u.evidence]));
  assert.deepEqual(byUrl, { [ONE]: null, [LINKEDIN]: evidence });
});

test('an ATS alias gives a URL-less new role its main URL', (ctx) => {
  const t = fresh(ctx);
  const made = t.upsertRole({ company: 'Acme', title: 'Engineer', url_aliases: [ONE], identity_evidence: 'Recruiter mail names the Ashby req' });
  assert.equal(made.role.url, ONE);
  assert.equal(made.role.ats, 'ashby');
  // A listing alone is still no main URL: approval would bind to a page that is not the form.
  assert.equal(t.upsertRole({ company: 'Zenith', title: 'Engineer', url_aliases: [LINKEDIN], identity_evidence: 'x' }).role.url, null);
});

test('an ATS alias gives a URL-less role its main URL on an update by id', (ctx) => {
  const t = fresh(ctx);
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer' });
  const updated = t.upsertRole({ id: role.id, title: 'Engineer', url_aliases: [ONE], identity_evidence: 'Recruiter mail names the Ashby req' });
  assert.equal(updated.role.url, ONE);
  assert.equal(updated.role.ats, 'ashby');
});

// --- Repeat applications: history decides, not the current status ---

const NEW_REQ = 'https://jobs.ashbyhq.com/acme/new-req';

const verify = (t: Tracker, role_id: number, url: string) =>
  t.transition({ role_id, to: 'verified', reason: 'Checked the ATS', evidence: `${url} "Remote (EU)"`, location_line: 'Remote (EU)', location_type: 'remote' });

// A role taken through the pipeline, applied to with a confirmation, then rejected by the employer.
function appliedThenRejected(t: Tracker, url = ONE): number {
  const { role } = t.upsertRole({ company: 'Acme', title: 'Engineer', url, source: 'ashby' });
  verify(t, role.id, url);
  t.transition({ role_id: role.id, to: 'scored', reason: 'Fits', score: 8 });
  t.transition({ role_id: role.id, to: 'queued', reason: 'Top pick' });
  t.transition({ role_id: role.id, to: 'applied', reason: 'Submitted', evidence: 'Thanks for applying to Acme!' });
  t.record({ role_id: role.id, status: 'closed', outcome: 'rejected', reason: 'Rejection email', evidence: 'We decided to move forward with other candidates', actor: 'employer' });
  return role.id;
}

test('a rejected role moved back to the queue keeps its block; another req at the company does not', (ctx) => {
  const t = fresh(ctx);
  const originalId = appliedThenRejected(t);
  boardMove(t, { role_id: originalId, to: 'queued' });
  assert.equal(t.mustRole(originalId).status, 'queued');
  assert.equal(t.gateCheck({ role_id: originalId }).ok, false);
  assert.equal(t.gateCheck({ role_id: originalId }).previous_application, true);
  assert.equal(t.findCompany({ name: 'Acme', url: NEW_REQ }).verdict, 'seen');
  const newVerifiedRoleId = t.upsertRole({ company: 'Acme', title: 'Engineer', url: NEW_REQ, source: 'ashby' }).role.id;
  verify(t, newVerifiedRoleId, NEW_REQ);
  assert.equal(t.gateCheck({ role_id: newVerifiedRoleId }).ok, true);
});

// A row an older release made for a posting another row also holds, with its own history, written straight to the
// tables so no lookup merges it first.
function oldRow(t: Tracker, company_id: number, url: string, history: [ts: string, status: string, outcome?: string][]): number {
  const status = history.at(-1)?.[1] ?? null;
  const id = Number(t.run("INSERT INTO roles(company_id, title, url, first_seen, updated_at, status) VALUES(?, 'Engineer', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)", company_id, url, status).lastInsertRowid);
  t.indexRoleUrls(id, [url]);
  for (const [ts, s, outcome] of history) t.run("INSERT INTO events(role_id, ts, status, outcome, actor, reason, evidence) VALUES(?, ?, ?, ?, 'import', 'Legacy row', 'Thanks for applying')", id, ts, s, outcome ?? null);
  return id;
}

// Researched and queued, as the pipeline leaves a role it has not applied to.
function queuedRole(t: Tracker, url: string, company = 'Acme'): number {
  const { role } = t.upsertRole({ company, title: 'Engineer', url, source: 'ashby' });
  verify(t, role.id, url);
  t.transition({ role_id: role.id, to: 'scored', reason: 'Fits', score: 8 });
  t.transition({ role_id: role.id, to: 'queued', reason: 'Top pick' });
  return role.id;
}

test('an application recorded on a linked duplicate blocks the group, through either id', (ctx) => {
  const t = fresh(ctx);
  const canonicalId = queuedRole(t, ONE);
  // The old row was applied to, then the posting closed; the canonical row only saw it close.
  const duplicateId = oldRow(t, t.mustRole(canonicalId).company_id, ONE, [['2026-01-05T00:00:00Z', 'applied'], ['2026-01-10T00:00:00Z', 'closed', 'role_closed']]);
  t.record({ role_id: canonicalId, status: 'closed', outcome: 'role_closed', reason: 'Posting closed', evidence: 'This job is no longer available', actor: 'employer' });
  t.linkDuplicateRole({ canonical_role_id: canonicalId, duplicate_role_id: duplicateId, reason: 'Same Ashby posting', evidence: `Both rows link to ${ONE}` });
  boardMove(t, { role_id: canonicalId, to: 'queued' });
  for (const role_id of [canonicalId, duplicateId]) {
    const gate = t.gateCheck({ role_id });
    assert.equal(gate.role_id, canonicalId);
    assert.equal(gate.ok, false);
    assert.equal(gate.previous_application, true);
    assert.equal(gate.matched_role_id, duplicateId);
    assert.equal(gate.dedupe_clean, false);
    assert.equal(gate.live_elsewhere, false);
    assert.match(gate.problems.join(' '), new RegExp(`role ${duplicateId} was applied on 2026-01-05`));
  }
});

test('a rejection imported without an application still blocks the reopened role', (ctx) => {
  const t = fresh(ctx);
  importLegacy(t, { applied_log: '| 2026-03-01 | Acme | Engineer | LinkedIn | Applied | Rejected |\n' });
  const id = t.q<{ id: number }>('SELECT id FROM roles')[0]?.id ?? 0;
  assert.deepEqual(t.roleDetail({ role_id: id }).events.map((e) => [e.status, e.outcome]), [['closed', 'rejected']]);
  // The role is researched again later and the user drags it back to the queue.
  t.upsertRole({ id, title: 'Engineer', url: ONE });
  t.run("UPDATE roles SET verified_at = '2026-04-01T00:00:00Z', score = 8 WHERE id = ?", id);
  boardMove(t, { role_id: id, to: 'queued' });
  const gate = t.gateCheck({ role_id: id });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.match(gate.problems.join(' '), /closed \(rejected\) on 2026-03-01/);
});

test('a posting held by two independent roles cannot be applied to until they are resolved', (ctx) => {
  const t = fresh(ctx);
  const a = queuedRole(t, ONE);
  const b = oldRow(t, t.mustRole(a).company_id, `${ONE}?utm_source=mail`, [['2026-01-02T00:00:00Z', 'found']]);
  for (const [role_id, other] of [[a, b], [b, a]] as const) {
    const gate = t.gateCheck({ role_id });
    assert.equal(gate.ok, false);
    assert.equal(gate.dedupe_clean, false);
    assert.equal(gate.previous_application, false);
    assert.match(gate.problems.join(' '), new RegExp(`also tracked as role ${other}\\b.*link_duplicate_role`));
  }
  // Linked, they are one role again, and the ambiguity is gone.
  t.linkDuplicateRole({ canonical_role_id: a, duplicate_role_id: b, reason: 'Same posting', evidence: `Both link to ${ONE}` });
  assert.equal(t.gateCheck({ role_id: a }).ok, true);
});

test('an application on the other row of an unresolved posting is a previous application', (ctx) => {
  const t = fresh(ctx);
  const a = queuedRole(t, ONE);
  const b = oldRow(t, t.mustRole(a).company_id, ONE, [['2026-01-02T00:00:00Z', 'applied'], ['2026-01-09T00:00:00Z', 'closed', 'rejected']]);
  const gate = t.gateCheck({ role_id: a });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.equal(gate.matched_role_id, b);
});

test('a linked duplicate\'s stale status is not a live application of its own', (ctx) => {
  const t = fresh(ctx);
  const canonicalId = queuedRole(t, ONE);
  const companyId = t.mustRole(canonicalId).company_id;
  // Both rows say applied when they are linked; the rejection comes later and lands on the canonical row only.
  const duplicateId = oldRow(t, companyId, ONE, [['2026-01-05T00:00:00Z', 'applied']]);
  t.transition({ role_id: canonicalId, to: 'applied', reason: 'Submitted', evidence: 'Thanks for applying to Acme!' });
  t.linkDuplicateRole({ canonical_role_id: canonicalId, duplicate_role_id: duplicateId, reason: 'Same posting', evidence: `Both link to ${ONE}` });
  t.record({ role_id: duplicateId, status: 'closed', outcome: 'rejected', reason: 'Rejection email', evidence: 'Not moving forward', actor: 'employer' });
  assert.equal(t.mustRole(canonicalId).status, 'closed');
  assert.equal(t.mustRole(duplicateId).status, 'applied');
  const other = queuedRole(t, NEW_REQ);
  const gate = t.gateCheck({ role_id: other });
  assert.equal(gate.live_elsewhere, false);
  assert.equal(gate.ok, true);
  const found = t.findCompany({ name: 'Acme', url: 'https://jobs.ashbyhq.com/acme/third' });
  assert.equal(found.live_application, false);
  assert.equal(found.verdict, 'seen');
  assert.deepEqual(found.matches[0]?.roles.map((r) => r.id).sort(), [canonicalId, other].sort(), 'one card per group');
  // The group itself is judged by its own history, whichever id is asked.
  for (const role_id of [canonicalId, duplicateId]) assert.equal(t.gateCheck({ role_id }).previous_application, true);
});

test('a live application elsewhere at the company, or no_cold_apply, still blocks a never-applied role', (ctx) => {
  const t = fresh(ctx);
  const live = queuedRole(t, ONE);
  t.transition({ role_id: live, to: 'applied', reason: 'Submitted', evidence: 'Thanks for applying to Acme!' });
  // Another req at the company, found under the company's brand name.
  t.addAlias({ company_id: t.mustRole(live).company_id, alias: 'Acme Robots' });
  const other = queuedRole(t, NEW_REQ, 'Acme Robots');
  assert.equal(t.mustRole(other).company_id, t.mustRole(live).company_id);
  const gate = t.gateCheck({ role_id: other });
  assert.equal(gate.ok, false);
  assert.equal(gate.live_elsewhere, true);
  assert.equal(gate.previous_application, false);
  assert.equal(t.findCompany({ name: 'Acme Robots', url: 'https://jobs.ashbyhq.com/acme/third' }).verdict, 'skip');
  const intro = queuedRole(t, 'https://jobs.ashbyhq.com/zenith/1', 'Zenith');
  t.setNoColdApply({ company_id: t.mustRole(intro).company_id, reason: 'Recruiter intro open' });
  assert.equal(t.gateCheck({ role_id: intro }).ok, false);
  assert.equal(t.gateCheck({ role_id: intro }).previous_application, false);
});

test('a withdrawal imported without an application still blocks the reopened role', (ctx) => {
  const t = fresh(ctx);
  importLegacy(t, { applied_log: '| 2026-03-01 | Acme | Engineer | LinkedIn | Applied | Withdrew |\n' });
  const id = t.q<{ id: number }>('SELECT id FROM roles')[0]?.id ?? 0;
  assert.deepEqual(t.roleDetail({ role_id: id }).events.map((e) => [e.status, e.outcome]), [['closed', 'withdrawn']]);
  t.upsertRole({ id, title: 'Engineer', url: ONE });
  t.run("UPDATE roles SET verified_at = '2026-04-01T00:00:00Z', score = 8 WHERE id = ?", id);
  boardMove(t, { role_id: id, to: 'queued' });
  const gate = t.gateCheck({ role_id: id });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.match(gate.problems.join(' '), /closed \(withdrawn\) on 2026-03-01/);
});

test('an interview with no applied event on file blocks the reopened role', (ctx) => {
  const t = fresh(ctx);
  const id = queuedRole(t, ONE);
  // The invite arrived for an application made outside the tracker, then the user dragged the card back.
  t.record({ role_id: id, status: 'interviewing', reason: 'Invite', evidence: 'Book a call with us', actor: 'employer' });
  boardMove(t, { role_id: id, to: 'queued' });
  assert.ok(!t.roleDetail({ role_id: id }).events.some((e) => e.status === 'applied'));
  const gate = t.gateCheck({ role_id: id });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.equal(gate.matched_role_id, id);
});

test('history on a row linked under an unlinked holder of the posting counts', (ctx) => {
  const t = fresh(ctx);
  const a = queuedRole(t, ONE);
  const companyId = t.mustRole(a).company_id;
  // B holds the posting and is not linked to A. C, linked under B, holds the application; B only saw the posting close.
  const c = oldRow(t, companyId, 'https://www.linkedin.com/jobs/view/55', [['2026-01-05T00:00:00Z', 'applied'], ['2026-01-10T00:00:00Z', 'closed', 'role_closed']]);
  const b = oldRow(t, companyId, ONE, [['2026-01-12T00:00:00Z', 'closed', 'role_closed']]);
  t.linkDuplicateRole({ canonical_role_id: b, duplicate_role_id: c, reason: 'Same job', evidence: `The LinkedIn card links to ${ONE}` });
  const gate = t.gateCheck({ role_id: a });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.equal(gate.matched_role_id, c);
});

test('a URL only a linked duplicate holds still finds another unlinked row for it', (ctx) => {
  const t = fresh(ctx);
  const r = queuedRole(t, ONE);
  const companyId = t.mustRole(r).company_id;
  const d = oldRow(t, companyId, LINKEDIN, [['2026-01-02T00:00:00Z', 'found']]);
  t.linkDuplicateRole({ canonical_role_id: r, duplicate_role_id: d, reason: 'Same job', evidence: `The LinkedIn card links to ${ONE}` });
  const e = oldRow(t, companyId, LINKEDIN, [['2026-01-03T00:00:00Z', 'found']]);
  const gate = t.gateCheck({ role_id: r });
  assert.equal(gate.ok, false);
  assert.equal(gate.dedupe_clean, false);
  assert.match(gate.problems.join(' '), new RegExp(`also tracked as role ${e}\\b`));
});

test('two rows with one ATS posting under different URLs block on the posting key alone', (ctx) => {
  const t = fresh(ctx);
  const a = queuedRole(t, 'https://jobs.ashbyhq.com/acme/x');
  const b = oldRow(t, t.mustRole(a).company_id, 'https://jobs.ashbyhq.com/acme/x/application', [['2026-01-02T00:00:00Z', 'applied']]);
  assert.equal(t.one<{ n: number }>('SELECT COUNT(DISTINCT normalized_url) AS n FROM role_urls')?.n, 2, 'the URLs differ');
  const gate = t.gateCheck({ role_id: a });
  assert.equal(gate.ok, false);
  assert.equal(gate.previous_application, true);
  assert.equal(gate.matched_role_id, b);
  assert.match(gate.problems.join(' '), new RegExp(`also tracked as role ${b}\\b`));
  // The other row is still applied, but it is reported as this posting, not as a second live process.
  assert.equal(gate.live_elsewhere, false);
  assert.doesNotMatch(gate.problems.join(' '), /Live application at this company/);
});
