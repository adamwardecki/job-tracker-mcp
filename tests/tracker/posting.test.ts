import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
import { type PostingKey, parsePostingUrl } from '../../plugin/servers/tracker/src/posting.ts';

const EMBED = 'https://boards.greenhouse.io/embed/job_app';

test('ashby: strips tracking and fragment, keys on org and job id', () => {
  assert.deepEqual(parsePostingUrl('https://jobs.ashbyhq.com/acme/job-1?utm_source=li#apply'), {
    normalized_url: 'https://jobs.ashbyhq.com/acme/job-1',
    posting: { provider: 'ashby', employer_key: 'acme', posting_id: 'job-1' },
  });
});

test('greenhouse: embed form takes the tenant from for= and the id from token=', () => {
  assert.deepEqual(parsePostingUrl(`${EMBED}?for=acme&token=123&gh_src=x`).posting,
    { provider: 'greenhouse', employer_key: 'acme', posting_id: '123' });
});

test('unknown host: the significant query is part of the normalized URL', () => {
  assert.equal(parsePostingUrl('https://careers.example/job?id=1').normalized_url, 'https://careers.example/job?id=1');
  assert.notEqual(parsePostingUrl('https://careers.example/job?id=1').normalized_url,
    parsePostingUrl('https://careers.example/job?id=2').normalized_url);
});

test('ashby: /application suffix is the same posting as the bare job URL', () => {
  const a = parsePostingUrl('https://jobs.ashbyhq.com/acme/job-1/application');
  assert.deepEqual(a.posting, { provider: 'ashby', employer_key: 'acme', posting_id: 'job-1' });
  assert.equal(a.normalized_url, 'https://jobs.ashbyhq.com/acme/job-1/application');
});

test('ashby: org slug lowercases, a UUID id lowercases, any other id keeps its case', () => {
  assert.deepEqual(parsePostingUrl('https://Jobs.AshbyHQ.com/ACME/3FA85F64-5717-4562-B3FC-2C963F66AFA6').posting,
    { provider: 'ashby', employer_key: 'acme', posting_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' });
  assert.deepEqual(parsePostingUrl('https://jobs.ashbyhq.com/acme/Job-AbC').posting,
    { provider: 'ashby', employer_key: 'acme', posting_id: 'Job-AbC' });
});

test('ashby: a board page with no job id has no posting identity', () => {
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/acme').posting, null);
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/').posting, null);
});

test('ashby: extra path segments are not guessed at', () => {
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/acme/job-1/something/else').posting, null);
});

test('greenhouse: board path /org/jobs/id on boards and job-boards hosts', () => {
  const want = { provider: 'greenhouse', employer_key: 'acme', posting_id: '4012345' };
  assert.deepEqual(parsePostingUrl('https://boards.greenhouse.io/Acme/jobs/4012345?gh_src=abc').posting, want);
  assert.deepEqual(parsePostingUrl('https://job-boards.greenhouse.io/acme/jobs/4012345').posting, want);
  assert.deepEqual(parsePostingUrl('https://job-boards.eu.greenhouse.io/acme/jobs/4012345').posting, want);
});

test('greenhouse: boards-api path carries the tenant', () => {
  assert.deepEqual(parsePostingUrl('https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345').posting,
    { provider: 'greenhouse', employer_key: 'acme', posting_id: '4012345' });
});

test('greenhouse: embed without a tenant or token has no identity', () => {
  assert.equal(parsePostingUrl(`${EMBED}?token=123`).posting, null);
  assert.equal(parsePostingUrl(`${EMBED}?for=acme`).posting, null);
  assert.equal(parsePostingUrl(`${EMBED}?for&token=1`).posting, null);
  assert.equal(parsePostingUrl(`${EMBED}?for=acme&token`).posting, null);
});

test('greenhouse: embed keeps for= and token= in the normalized URL and drops gh_src', () => {
  assert.equal(parsePostingUrl(`${EMBED}?for=acme&gh_src=x&token=123#top`).normalized_url,
    `${EMBED}?for=acme&token=123`);
});

test('greenhouse: a non-numeric job id is not guessed', () => {
  assert.equal(parsePostingUrl('https://boards.greenhouse.io/acme/jobs/engineer').posting, null);
});

test('greenhouse: a company page carrying gh_jid has no tenant, so no identity', () => {
  const r = parsePostingUrl('https://careers.example/open-roles?gh_jid=4012345');
  assert.equal(r.posting, null);
  assert.equal(r.normalized_url, 'https://careers.example/open-roles?gh_jid=4012345');
});

test('lever: US and EU hosts give the same identity; /apply is the same posting', () => {
  const want = { provider: 'lever', employer_key: 'acme', posting_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6' };
  assert.deepEqual(parsePostingUrl('https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6?lever-source=li&lever-origin=x').posting, want);
  assert.deepEqual(parsePostingUrl('https://jobs.eu.lever.co/Acme/3FA85F64-5717-4562-B3FC-2C963F66AFA6/apply').posting, want);
});

test('lever: tracking-only differences normalize to one URL', () => {
  assert.equal(parsePostingUrl('https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6?lever-source=li').normalized_url,
    'https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(parsePostingUrl('https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6?lever-origin=a&lever-source=b').normalized_url,
    'https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6');
});

test('lever: a board with no posting id has no identity', () => {
  assert.equal(parsePostingUrl('https://jobs.lever.co/acme').posting, null);
});

test('workable: shortcode keeps its case and /apply is the same posting', () => {
  assert.deepEqual(parsePostingUrl('https://apply.workable.com/Acme/j/ABC123DEF4/').posting,
    { provider: 'workable', employer_key: 'acme', posting_id: 'ABC123DEF4' });
  assert.deepEqual(parsePostingUrl('https://apply.workable.com/acme/j/ABC123DEF4/apply/').posting,
    { provider: 'workable', employer_key: 'acme', posting_id: 'ABC123DEF4' });
});

test('workable: a shortcode without an account, or the account alone, has no identity', () => {
  assert.equal(parsePostingUrl('https://apply.workable.com/j/ABC123DEF4').posting, null);
  assert.equal(parsePostingUrl('https://apply.workable.com/acme/').posting, null);
});

test('trk, trackingId and utm_* are stripped; other params survive in order and unrewritten', () => {
  assert.equal(parsePostingUrl('https://careers.example/job?utm_Medium=x&id=A%2Fb&trk=1&trackingId=z&ref=Friend&utm_campaign=q').normalized_url,
    'https://careers.example/job?id=A%2Fb&ref=Friend');
});

test('unknown params on a known ATS are kept and do not change the identity', () => {
  const r = parsePostingUrl('https://jobs.ashbyhq.com/acme/job-1?ashby_jid=9&utm_source=x');
  assert.equal(r.normalized_url, 'https://jobs.ashbyhq.com/acme/job-1?ashby_jid=9');
  assert.deepEqual(r.posting, { provider: 'ashby', employer_key: 'acme', posting_id: 'job-1' });
});

test('an embedded URL in a query value is not parsed or stripped', () => {
  const r = parsePostingUrl('https://careers.example/redirect?next=https%3A%2F%2Fjobs.lever.co%2Facme%2Fx%3Futm_source%3Dli');
  assert.equal(r.normalized_url, 'https://careers.example/redirect?next=https%3A%2F%2Fjobs.lever.co%2Facme%2Fx%3Futm_source%3Dli');
  assert.equal(r.posting, null);
});

test('different significant queries on one path stay different', () => {
  assert.notEqual(parsePostingUrl('https://careers.example/job?req=1&utm_source=a').normalized_url,
    parsePostingUrl('https://careers.example/job?req=2&utm_source=a').normalized_url);
  assert.equal(parsePostingUrl('https://careers.example/job?req=1&utm_source=a').normalized_url,
    parsePostingUrl('https://careers.example/job?utm_source=b&req=1').normalized_url);
});

test('malformed percent escapes do not throw and are not decoded into an identity', () => {
  const r = parsePostingUrl('https://jobs.ashbyhq.com/acme/job-%ZZ');
  assert.equal(r.posting, null);
  assert.equal(r.normalized_url, 'https://jobs.ashbyhq.com/acme/job-%ZZ');
  assert.equal(parsePostingUrl('https://careers.example/job?q=%E0%A4%A&utm_source=x').normalized_url, 'https://careers.example/job?q=%E0%A4%A');
});

test('unknown HTTP(S) hosts return the URL with no posting, and a shared ATS host never guesses a tenant', () => {
  assert.deepEqual(parsePostingUrl('http://Careers.Example/Jobs/Senior-Eng#x'),
    { normalized_url: 'http://careers.example/Jobs/Senior-Eng', posting: null });
  assert.equal(parsePostingUrl('https://acme.teamtailor.com/jobs/123-engineer').posting, null);
  assert.equal(parsePostingUrl('https://www.linkedin.com/jobs/view/123456').posting, null);
});

test('invalid, empty and non-http URLs throw ToolError', () => {
  for (const bad of ['', '   ', 'not a url', 'ftp://example.test/job', 'javascript:alert(1)', 'mailto:a@example.test']) {
    assert.throws(() => parsePostingUrl(bad), ToolError, bad);
  }
});

test('credentials throw ToolError, including a bare username', () => {
  assert.throws(() => parsePostingUrl('https://user:secret@example.test/job'), ToolError);
  assert.throws(() => parsePostingUrl('https://token@jobs.lever.co/acme/x'), /credentials/i);
});

test('a reserved suffix word is never read as the posting id', () => {
  for (const url of [
    'https://jobs.ashbyhq.com/acme/application',
    'https://jobs.ashbyhq.com/acme/Application',
    'https://jobs.ashbyhq.com/acme/embed',
    'https://jobs.ashbyhq.com/acme/jobs',
    'https://jobs.lever.co/acme/apply',
    'https://jobs.eu.lever.co/acme/APPLY',
    'https://apply.workable.com/acme/j/apply',
    'https://apply.workable.com/acme/j/Apply',
  ]) {
    assert.equal(parsePostingUrl(url).posting, null, url);
  }
});

test('greenhouse embed: a duplicated or undecodable for/token gives no identity but keeps the URL', () => {
  for (const q of ['for=%FF&token=1', 'for=%ZZ&token=1', 'for=%20&token=1', 'for=acme&for=globex&token=123', 'for=acme&token=123&token=456']) {
    const r = parsePostingUrl(`${EMBED}?${q}`);
    assert.equal(r.posting, null, q);
    assert.equal(r.normalized_url, `${EMBED}?${q}`, q);
  }
});

test('a query piece containing a semicolon is not a tracking parameter', () => {
  assert.equal(parsePostingUrl('https://careers.example/job?utm_source=x;id=1').normalized_url, 'https://careers.example/job?utm_source=x;id=1');
  assert.notEqual(parsePostingUrl('https://careers.example/job?utm_source=x;id=1').normalized_url,
    parsePostingUrl('https://careers.example/job?utm_source=x;id=2').normalized_url);
});

test('tracking names match exactly as listed, not case-insensitively', () => {
  assert.equal(parsePostingUrl('https://careers.example/job?TRK=a').normalized_url, 'https://careers.example/job?TRK=a');
  assert.notEqual(parsePostingUrl('https://careers.example/job?TRK=a').normalized_url, parsePostingUrl('https://careers.example/job?TRK=b').normalized_url);
  assert.equal(parsePostingUrl('https://careers.example/job?UTM_source=a&Gh_Src=b&trackingid=c&Lever-Source=d').normalized_url,
    'https://careers.example/job?UTM_source=a&Gh_Src=b&trackingid=c&Lever-Source=d');
  assert.equal(parsePostingUrl('https://careers.example/job?utm_source=a&gh_src=b&trk=c&trackingId=d&lever-source=e&lever-origin=f&id=1').normalized_url,
    'https://careers.example/job?id=1');
});

test('unknown URL: a hash-route fragment (#/ or #!) is kept, other fragments are dropped', () => {
  assert.equal(parsePostingUrl('https://careers.example/#/jobs/1').normalized_url, 'https://careers.example/#/jobs/1');
  assert.equal(parsePostingUrl('https://careers.example/#!/jobs/2').normalized_url, 'https://careers.example/#!/jobs/2');
  assert.notEqual(parsePostingUrl('https://careers.example/#/jobs/1').normalized_url, parsePostingUrl('https://careers.example/#/jobs/2').normalized_url);
  assert.equal(parsePostingUrl('https://careers.example/job?id=1#apply').normalized_url, 'https://careers.example/job?id=1');
  assert.equal(parsePostingUrl('https://careers.example/job#').normalized_url, 'https://careers.example/job');
});

test('known ATS posting: every fragment is dropped, even a hash route', () => {
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/acme/job-1#/apply').normalized_url, 'https://jobs.ashbyhq.com/acme/job-1');
  assert.equal(parsePostingUrl('https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6#!x').normalized_url,
    'https://jobs.lever.co/acme/3fa85f64-5717-4562-b3fc-2c963f66afa6');
});

test('greenhouse embed: + is a space, so a blank or spaced for/token gives no identity and a+b is not a%2Bb', () => {
  assert.equal(parsePostingUrl(`${EMBED}?for=+&token=1`).posting, null);
  assert.equal(parsePostingUrl(`${EMBED}?for=a+b&token=1`).posting, null);
  assert.equal(parsePostingUrl(`${EMBED}?for=acme&token=+`).posting, null);
  assert.deepEqual(parsePostingUrl(`${EMBED}?for=a%2Bb&token=1`).posting,
    { provider: 'greenhouse', employer_key: 'a+b', posting_id: '1' });
});

test('path slugs containing spaces keep their identity', () => {
  assert.deepEqual(parsePostingUrl('https://jobs.ashbyhq.com/Acme%20Corp/job-1').posting,
    { provider: 'ashby', employer_key: 'acme corp', posting_id: 'job-1' });
  assert.deepEqual(parsePostingUrl('https://boards.greenhouse.io/a%20b/jobs/1').posting,
    { provider: 'greenhouse', employer_key: 'a b', posting_id: '1' });
});

test('greenhouse embed: a for/token value containing a semicolon gives no identity', () => {
  for (const q of ['for=acme;for=globex&token=1', 'for=acme&token=1;token=2', 'for=acme&token=1;x', 'x=1;for=globex&for=acme&token=1']) {
    assert.equal(parsePostingUrl(`${EMBED}?${q}`).posting, null, q);
  }
});

test('known ATS host with no posting identity keeps a hash-route fragment', () => {
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/acme#/jobs/1').normalized_url, 'https://jobs.ashbyhq.com/acme#/jobs/1');
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/acme#apply').normalized_url, 'https://jobs.ashbyhq.com/acme');
});

test('greenhouse embed: only the exact /embed/job_app path is a posting', () => {
  assert.equal(parsePostingUrl('https://boards.greenhouse.io/embed/other?for=acme&token=1').posting, null);
  assert.equal(parsePostingUrl('https://boards.greenhouse.io/embed/job_app/x?for=acme&token=1').posting, null);
});

test('greenhouse boards-api: only the v1 path is understood', () => {
  assert.equal(parsePostingUrl('https://boards-api.greenhouse.io/v2/boards/acme/jobs/1').posting, null);
});

test('a blank path slug (%20) is not an employer', () => {
  assert.equal(parsePostingUrl('https://jobs.ashbyhq.com/%20/job-1').posting, null);
});

test('a percent-encoded tracking name is still stripped', () => {
  assert.equal(parsePostingUrl('https://careers.example/job?%75tm_source=x&id=1').normalized_url, 'https://careers.example/job?id=1');
});

test('a trailing dot on the ATS hostname keeps the identity', () => {
  assert.deepEqual(parsePostingUrl('https://jobs.ashbyhq.com./acme/job-1').posting, { provider: 'ashby', employer_key: 'acme', posting_id: 'job-1' });
});

test('the same posting id under two employers is two identities, per provider', () => {
  const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const cases: [string, PostingKey][] = [
    ['https://jobs.ashbyhq.com/acme/job-1', { provider: 'ashby', employer_key: 'acme', posting_id: 'job-1' }],
    ['https://jobs.ashbyhq.com/globex/job-1', { provider: 'ashby', employer_key: 'globex', posting_id: 'job-1' }],
    [`https://jobs.lever.co/acme/${uuid}`, { provider: 'lever', employer_key: 'acme', posting_id: uuid }],
    [`https://jobs.lever.co/globex/${uuid}`, { provider: 'lever', employer_key: 'globex', posting_id: uuid }],
    ['https://boards.greenhouse.io/acme/jobs/123', { provider: 'greenhouse', employer_key: 'acme', posting_id: '123' }],
    ['https://boards.greenhouse.io/globex/jobs/123', { provider: 'greenhouse', employer_key: 'globex', posting_id: '123' }],
    [`${EMBED}?for=globex&token=123`, { provider: 'greenhouse', employer_key: 'globex', posting_id: '123' }],
    ['https://apply.workable.com/acme/j/ABC123DEF4', { provider: 'workable', employer_key: 'acme', posting_id: 'ABC123DEF4' }],
    ['https://apply.workable.com/globex/j/ABC123DEF4', { provider: 'workable', employer_key: 'globex', posting_id: 'ABC123DEF4' }],
  ];
  for (const [url, want] of cases) assert.deepEqual(parsePostingUrl(url).posting, want, url);
});
