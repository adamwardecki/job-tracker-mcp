// Posting identity: exact URLs and ATS posting IDs decide which role a lead is, never the title alone.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
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
