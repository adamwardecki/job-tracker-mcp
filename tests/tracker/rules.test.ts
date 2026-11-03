// Rule types: classification stores a rule's consumers without touching its text or provenance.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { RULE_TYPES } from '../../plugin/servers/tracker/src/rules.ts';
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
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

const revision = (t: Tracker) => t.listRules().rules_revision;

test('the rule types are the seven consumers, in order', () => {
  assert.deepEqual([...RULE_TYPES], ['global', 'sourcing', 'scoring', 'forms', 'writing', 'inbox', 'reporting']);
});

test('classification preserves provenance', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'Use employer evidence', reason: 'Aggregator was stale', example: 'Acme', types: ['sourcing', 'scoring'] });
  const before = t.listRules().rules[0];
  assert.deepEqual(before?.types, ['sourcing', 'scoring']);
  assert.equal(before?.added_by, 'user'); // addRule's default author
  t.setRuleTypes({ id: rule_id, types: ['scoring', 'scoring'] });
  const after = t.listRules().rules[0];
  assert.deepEqual(after?.types, ['scoring']);
  assert.equal(after?.text, before?.text);
  assert.equal(after?.reason, 'Aggregator was stale');
  assert.equal(after?.example, 'Acme');
  assert.equal(after?.added_by, before?.added_by);
  assert.equal(after?.added_on, before?.added_on);
  assert.equal(after?.active, 1);
});

test('classification keeps the author a pipeline rule was added with', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'Skip staffing agencies', reason: 'Seen twice', added_by: 'pipeline', added_on: '2026-02-03' });
  t.setRuleTypes({ id: rule_id, types: ['sourcing'] });
  const r = t.listRules().rules[0];
  assert.deepEqual([r?.added_by, r?.added_on, r?.types], ['pipeline', '2026-02-03', ['sourcing']]);
});

test('omitted types include legacy rules globally', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  // A row written straight to the table, as a release before rule types left it, has no type rows at all.
  t.run("INSERT INTO rules(text, reason, added_by, added_on) VALUES('Legacy row', 'Old', 'user', '2026-01-01')");
  assert.equal((await c('add_rule', { text: 'Omitted', reason: 'r' })).error, '');
  assert.equal((await c('add_rule', { text: 'Null', reason: 'r', types: null })).error, '');
  const listed = (await c('list_rules', {})).data?.rules as { text: string; types: string[] }[];
  assert.deepEqual(listed.map((r) => [r.text, r.types]), [['Legacy row', ['global']], ['Omitted', ['global']], ['Null', ['global']]]);
});

test('a rule keeps several types, deduplicated in the order of the list of types', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'Plain', reason: 'r', types: ['writing', 'sourcing', 'writing', 'forms'] });
  assert.deepEqual(t.listRules().rules[0]?.types, ['sourcing', 'forms', 'writing']);
  assert.deepEqual(t.setRuleTypes({ id: rule_id, types: ['reporting', 'global', 'inbox', 'global'] }).types, ['global', 'inbox', 'reporting']);
  assert.deepEqual(t.listRules().rules[0]?.types, ['global', 'inbox', 'reporting']);
});

const BAD: [string, unknown, RegExp][] = [
  ['an empty list', [], /at least one/],
  ['an unknown type', ['unknown'], /unknown/],
  ['a number', [7], /7/],
  ['a mixed list', ['scoring', 7], /7/],
  ['a string', 'scoring', /expected array|list of rule types/],
  ['a valid type beside an unknown one', ['scoring', 'Scoring'], /Scoring/],
];

for (const [label, types, message] of BAD) {
  test(`${label} is rejected by add_rule and set_rule_types without a write`, async (ctx) => {
    const t = fresh(ctx);
    const c = call(t);
    const { rule_id } = t.addRule({ text: 'Kept', reason: 'r', types: ['forms'] });
    const rev = revision(t);
    const added = await c('add_rule', { text: 'Rejected', reason: 'r', types });
    assert.match(added.error, message);
    assert.equal(t.listRules().rules.length, 1);
    const set = await c('set_rule_types', { id: rule_id, types });
    assert.match(set.error, message);
    assert.deepEqual(t.listRules().rules.map((r) => [r.text, r.types]), [['Kept', ['forms']]]);
    assert.equal(revision(t), rev);
    assert.throws(() => t.addRule({ text: 'Direct', reason: 'r', types: types as string[] }), message);
    assert.throws(() => t.setRuleTypes({ id: rule_id, types: types as string[] }), message);
    assert.equal(t.listRules().rules.length, 1);
  });
}

test('set_rule_types needs types and an existing rule, and rejects a non-list', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { rule_id } = t.addRule({ text: 'Kept', reason: 'r' });
  assert.match((await c('set_rule_types', { id: rule_id })).error, /types is required/);
  assert.match((await c('set_rule_types', { id: rule_id, types: null })).error, /types is required/);
  assert.match((await c('set_rule_types', { id: rule_id, types: 'scoring' })).error, /types: expected array/);
  assert.match((await c('set_rule_types', { id: 99, types: ['scoring'] })).error, /No rule 99/);
  assert.match((await c('add_rule', { text: 't', reason: 'r', types: 'scoring' })).error, /types: expected array/);
});

test('set_rule_types returns the rule, its types and the revision', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { rule_id } = t.addRule({ text: 'Kept', reason: 'r' });
  const { data } = await c('set_rule_types', { id: rule_id, types: ['scoring', 'inbox'] });
  assert.deepEqual(data, { rule_id, types: ['scoring', 'inbox'], rules_revision: revision(t) });
  const listed = (await c('list_rules', {})).data?.rules as { types: string[] }[];
  assert.deepEqual(listed[0]?.types, ['scoring', 'inbox']);
});

test('the revision moves on a real change only', (ctx) => {
  const t = fresh(ctx);
  const start = revision(t);
  const { rule_id } = t.addRule({ text: 'One', reason: 'r', types: ['scoring'] });
  assert.equal(revision(t), start + 1);
  assert.equal(revision(t), start + 1); // a read
  t.listRules({ include_inactive: true });
  assert.equal(revision(t), start + 1);
  assert.equal(t.setRuleTypes({ id: rule_id, types: ['scoring', 'scoring'] }).rules_revision, start + 1); // same set
  t.setRuleTypes({ id: rule_id, types: ['scoring', 'forms'] });
  assert.equal(revision(t), start + 2);
  t.setRuleTypes({ id: rule_id, types: ['forms', 'scoring'] }); // same set, other order
  assert.equal(revision(t), start + 2);
  t.deactivateRule({ id: rule_id });
  assert.equal(revision(t), start + 3);
  t.deactivateRule({ id: rule_id }); // already inactive
  assert.equal(revision(t), start + 3);
  assert.throws(() => t.deactivateRule({ id: 99 }), /No rule 99/);
  assert.equal(revision(t), start + 3);
});

test('an inactive rule keeps its types and can be reclassified', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'One', reason: 'r', types: ['inbox'] });
  t.deactivateRule({ id: rule_id });
  assert.deepEqual(t.listRules().rules, []);
  assert.deepEqual(t.listRules({ include_inactive: true }).rules[0]?.types, ['inbox']);
  t.setRuleTypes({ id: rule_id, types: ['reporting'] });
  assert.deepEqual(t.listRules({ include_inactive: true }).rules[0]?.types, ['reporting']);
});

test('a failed add leaves neither a rule nor a revision change', (ctx) => {
  const t = fresh(ctx);
  const start = revision(t);
  // Fail after the rule row is written: the type rows cannot reference a missing table.
  t.run('ALTER TABLE rule_types RENAME TO rule_types_gone');
  assert.throws(() => t.addRule({ text: 'Half', reason: 'r', types: ['forms'] }));
  assert.equal(t.q('SELECT id FROM rules').length, 0);
  t.run('ALTER TABLE rule_types_gone RENAME TO rule_types');
  assert.equal(revision(t), start);
});

test('each rule lists its own types', (ctx) => {
  const t = fresh(ctx);
  t.addRule({ text: 'One', reason: 'r', types: ['sourcing'] });
  t.addRule({ text: 'Two', reason: 'r', types: ['forms', 'writing'] });
  t.addRule({ text: 'Three', reason: 'r' });
  t.addRule({ text: 'Four', reason: 'r', types: ['reporting', 'inbox'] });
  assert.deepEqual(t.listRules().rules.map((r) => [r.text, r.types]), [
    ['One', ['sourcing']],
    ['Two', ['forms', 'writing']],
    ['Three', ['global']],
    ['Four', ['inbox', 'reporting']],
  ]);
});

test('a missing revision row is a bug, not a tool error', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'One', reason: 'r' });
  t.run('DELETE FROM rule_state');
  assert.throws(() => t.listRules(), (e) => e instanceof Error && !(e instanceof ToolError) && /rule_state/.test(e.message));
  assert.throws(() => t.addRule({ text: 'Two', reason: 'r' }), (e) => e instanceof Error && !(e instanceof ToolError) && /rule_state/.test(e.message));
  assert.throws(() => t.deactivateRule({ id: rule_id }), (e) => e instanceof Error && !(e instanceof ToolError));
  assert.equal(t.q('SELECT id FROM rules').length, 1, 'the failed add left no rule');
  assert.equal(t.one<{ active: number }>('SELECT active FROM rules WHERE id = ?', rule_id)?.active, 1, 'the failed deactivation rolled back');
});

test('a failed reclassification keeps the old types', (ctx) => {
  const t = fresh(ctx);
  const { rule_id } = t.addRule({ text: 'One', reason: 'r', types: ['scoring', 'forms'] });
  const start = revision(t);
  // The delete succeeds, then the insert of the new type fails.
  t.run("CREATE TRIGGER no_inbox BEFORE INSERT ON rule_types WHEN NEW.type = 'inbox' BEGIN SELECT RAISE(ABORT, 'no inbox'); END");
  assert.throws(() => t.setRuleTypes({ id: rule_id, types: ['inbox'] }), /no inbox/);
  assert.deepEqual(t.listRules().rules[0]?.types, ['scoring', 'forms']);
  assert.equal(revision(t), start);
});

function seedFour(t: Tracker) {
  const globalId = t.addRule({ text: 'G', reason: 'r' }).rule_id;
  const sourcingId = t.addRule({ text: 'S', reason: 'r', types: ['sourcing'] }).rule_id;
  const formsId = t.addRule({ text: 'F', reason: 'r', types: ['forms'] }).rule_id;
  const multiTypeId = t.addRule({ text: 'M', reason: 'r', types: ['sourcing', 'scoring'] }).rule_id;
  return { globalId, sourcingId, formsId, multiTypeId };
}

test('a typed request pages through its own rules and the global ones, each once', (ctx) => {
  const t = fresh(ctx);
  const { globalId, sourcingId, multiTypeId } = seedFour(t);
  const first = t.listRules({ types: ['sourcing'], limit: 1 });
  assert.deepEqual(first.rules.map((r) => r.id), [globalId]);
  assert.equal(first.total, 3);
  assert.ok(first.next_cursor);
  const second = t.listRules({ cursor: first.next_cursor, limit: 1 });
  assert.deepEqual(second.rules.map((r) => r.id), [sourcingId]);
  const third = t.listRules({ cursor: second.next_cursor, limit: 1 });
  assert.deepEqual(third.rules.map((r) => r.id), [multiTypeId]);
  assert.equal(third.next_cursor, null);
  assert.equal(third.total, 3);
  assert.equal(third.rules_revision, first.rules_revision);
});

const ids = (page: { rules: { id: number }[] }) => page.rules.map((r) => r.id);

// Follow next_cursor to the end, returning each page's ids.
function pages(t: Tracker, first: Parameters<Tracker['listRules']>[0]) {
  const out: number[][] = [];
  let page = t.listRules(first);
  out.push(ids(page));
  while (page.next_cursor) {
    page = t.listRules({ cursor: page.next_cursor, limit: first?.limit });
    out.push(ids(page));
  }
  return out;
}

test('the default page is ten rules and says where the rest is', (ctx) => {
  const t = fresh(ctx);
  for (let i = 1; i <= 12; i++) t.addRule({ text: `Rule ${i}`, reason: 'r' });
  const first = t.listRules();
  assert.deepEqual(ids(first), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(first.total, 12);
  assert.ok(first.next_cursor);
  const second = t.listRules({ cursor: first.next_cursor });
  assert.deepEqual(ids(second), [11, 12]);
  assert.equal(second.next_cursor, null);
  assert.equal(second.total, 12);
});

test('a page that ends exactly on the last rule has no cursor', (ctx) => {
  const t = fresh(ctx);
  for (let i = 1; i <= 4; i++) t.addRule({ text: `Rule ${i}`, reason: 'r' });
  assert.deepEqual(pages(t, { limit: 2 }), [[1, 2], [3, 4]]);
  const whole = t.listRules({ limit: 4 });
  assert.equal(whole.next_cursor, null);
  assert.equal(t.listRules({ limit: 50 }).next_cursor, null);
});

test('an empty result is an empty page, not an error', (ctx) => {
  const t = fresh(ctx);
  assert.deepEqual(t.listRules(), { rules: [], next_cursor: null, total: 0, rules_revision: revision(t) });
  t.addRule({ text: 'Forms only', reason: 'r', types: ['forms'] });
  const none = t.listRules({ types: ['inbox'] });
  assert.deepEqual([none.rules, none.next_cursor, none.total], [[], null, 0]);
});

test('inactive rules are left out unless asked for, and the cursor remembers the choice', (ctx) => {
  const t = fresh(ctx);
  const a = t.addRule({ text: 'A', reason: 'r', types: ['forms'] }).rule_id;
  const b = t.addRule({ text: 'B', reason: 'r', types: ['forms'] }).rule_id;
  const c = t.addRule({ text: 'C', reason: 'r' }).rule_id;
  t.deactivateRule({ id: b });
  assert.deepEqual(pages(t, { types: ['forms'], limit: 1 }), [[a], [c]]);
  assert.equal(t.listRules({ types: ['forms'] }).total, 2);
  assert.deepEqual(pages(t, { types: ['forms'], limit: 1, include_inactive: true }), [[a], [b], [c]]);
  assert.equal(t.listRules({ types: ['forms'], include_inactive: true }).total, 3);
});

test('repeating or reordering requested types changes nothing', (ctx) => {
  const t = fresh(ctx);
  const { globalId, sourcingId, multiTypeId } = seedFour(t);
  const once = t.listRules({ types: ['sourcing', 'scoring'] });
  const messy = t.listRules({ types: ['scoring', 'sourcing', 'scoring', 'global'] });
  assert.deepEqual(ids(once), [globalId, sourcingId, multiTypeId]);
  assert.deepEqual(ids(messy), ids(once));
  assert.equal(messy.total, 3);
  // The same filter, spelled differently, is not a changed filter on a continuation.
  const first = t.listRules({ types: ['sourcing', 'scoring'], limit: 1 });
  assert.deepEqual(ids(t.listRules({ cursor: first.next_cursor, types: ['scoring', 'sourcing', 'sourcing'], limit: 1 })), [sourcingId]);
});

test('a rule with no type rows is global in a filtered request', (ctx) => {
  const t = fresh(ctx);
  t.run("INSERT INTO rules(text, reason, added_by, added_on) VALUES('Legacy row', 'Old', 'user', '2026-01-01')");
  const { sourcingId } = seedFour(t);
  assert.deepEqual(ids(t.listRules({ types: ['sourcing'] })).slice(0, 2), [1, 2]);
  assert.deepEqual(t.listRules({ types: ['global'] }).rules.map((r) => r.text), ['Legacy row', 'G']);
  assert.ok(sourcingId);
});

const RESTART = /Restart list_rules without a cursor/;

test('a limit outside 1 to 50, or not a whole number, is rejected', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  seedFour(t);
  for (const limit of [0, 51, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => t.listRules({ limit }), (e) => e instanceof ToolError && /limit must be a whole number from 1 to 50/.test(e.message), `direct limit ${limit}`);
  }
  for (const limit of [0, 51, 1.5]) {
    const { error } = await c('list_rules', { limit });
    assert.match(error, /limit/, `handler limit ${limit}`);
  }
  assert.equal((await c('list_rules', { limit: 50 })).error, '');
  assert.equal((await c('list_rules', { limit: 1 })).error, '');
  assert.deepEqual(ids({ rules: (await c('list_rules', { limit: null })).data?.rules as { id: number }[] }), [1, 2, 3, 4]);
});

test('a malformed cursor is a restart instruction, never a raw exception', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  seedFour(t);
  const good = t.listRules({ limit: 1 }).next_cursor as string;
  const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
  const base = { v: 1, after_id: 1, revision: revision(t), types: null, include_inactive: false };
  const bad: [string, string][] = [
    ['empty', ''],
    ['not base64url', 'not base64!!'],
    ['padded base64', `${good}=`],
    ['standard base64 alphabet', 'ab+/cd'],
    ['not JSON', b64('{nope')],
    ['JSON null', b64('null')],
    ['JSON array', b64([1])],
    ['JSON string', b64('"x"')],
    ['version 2', b64({ ...base, v: 2 })],
    ['missing version', b64({ after_id: 1, revision: 0, types: null, include_inactive: false })],
    ['negative id', b64({ ...base, after_id: -1 })],
    ['zero id', b64({ ...base, after_id: 0 })],
    ['fractional id', b64({ ...base, after_id: 1.5 })],
    ['string id', b64({ ...base, after_id: '1' })],
    ['huge id', b64({ ...base, after_id: 1e300 })],
    ['negative revision', b64({ ...base, revision: -1 })],
    ['fractional revision', b64({ ...base, revision: 1.5 })],
    ['unknown type', b64({ ...base, types: ['nope'] })],
    ['empty types', b64({ ...base, types: [] })],
    ['unordered types', b64({ ...base, types: ['scoring', 'sourcing'] })],
    ['duplicate types', b64({ ...base, types: ['sourcing', 'sourcing'] })],
    ['types not a list', b64({ ...base, types: 'sourcing' })],
    ['include_inactive not boolean', b64({ ...base, include_inactive: 1 })],
    ['extra field', b64({ ...base, extra: true })],
    ['too long', 'A'.repeat(5000)],
  ];
  for (const [label, cursor] of bad) {
    assert.throws(() => t.listRules({ cursor }), (e) => e instanceof ToolError && RESTART.test(e.message), label);
    const { error } = await c('list_rules', { cursor });
    assert.match(error, RESTART, label);
  }
  // The cursor the server issued still works.
  assert.equal(t.listRules({ cursor: good, limit: 1 }).rules.length, 1);
});

test('a continuation cannot change the filters it was issued with', (ctx) => {
  const t = fresh(ctx);
  seedFour(t);
  const typed = t.listRules({ types: ['sourcing'], limit: 1 }).next_cursor as string;
  assert.throws(() => t.listRules({ cursor: typed, types: ['forms'] }), (e) => e instanceof ToolError && /types.*sourcing/.test(e.message) && RESTART.test(e.message));
  assert.throws(() => t.listRules({ cursor: typed, types: ['sourcing', 'forms'] }), ToolError);
  assert.throws(() => t.listRules({ cursor: typed, include_inactive: true }), (e) => e instanceof ToolError && /include_inactive/.test(e.message));
  const untyped = t.listRules({ limit: 1 }).next_cursor as string;
  assert.throws(() => t.listRules({ cursor: untyped, types: ['sourcing'] }), (e) => e instanceof ToolError && /types/.test(e.message));
  // Repeating the same filters, or omitting them, is fine; so is another page size.
  assert.equal(t.listRules({ cursor: typed, types: ['sourcing'], include_inactive: false, limit: 2 }).rules.length, 2);
  assert.equal(t.listRules({ cursor: typed, types: null, include_inactive: null, limit: 2 }).rules.length, 2);
});

test('the limit can change between pages without skipping or repeating rules', (ctx) => {
  const t = fresh(ctx);
  for (let i = 1; i <= 7; i++) t.addRule({ text: `Rule ${i}`, reason: 'r' });
  const a = t.listRules({ limit: 2 });
  const b = t.listRules({ cursor: a.next_cursor, limit: 4 });
  const c = t.listRules({ cursor: b.next_cursor, limit: 1 });
  assert.deepEqual([ids(a), ids(b), ids(c), c.next_cursor], [[1, 2], [3, 4, 5, 6], [7], null]);
});

test('a read at one revision gives the same pages every time', (ctx) => {
  const t = fresh(ctx);
  for (let i = 1; i <= 5; i++) t.addRule({ text: `Rule ${i}`, reason: 'r', types: i % 2 ? ['scoring'] : ['forms'] });
  const first = t.listRules({ types: ['scoring'], limit: 2 });
  assert.deepEqual(t.listRules({ types: ['scoring'], limit: 2 }), first);
  assert.deepEqual(t.listRules({ cursor: first.next_cursor, limit: 2 }), t.listRules({ cursor: first.next_cursor, limit: 2 }));
  assert.equal(revision(t), first.rules_revision);
});

const STALE = /Rules changed since this page was read.*Restart list_rules without a cursor/s;

const MUTATIONS: [string, (t: Tracker, ruleIds: ReturnType<typeof seedFour>) => void][] = [
  ['a rule is added', (t) => t.addRule({ text: 'New', reason: 'r', types: ['sourcing'] })],
  ['a rule on a later page is reclassified', (t, r) => t.setRuleTypes({ id: r.multiTypeId, types: ['forms'] })],
  ['a rule already read is reclassified', (t, r) => t.setRuleTypes({ id: r.globalId, types: ['forms'] })],
  ['a rule on a later page is deactivated', (t, r) => t.deactivateRule({ id: r.multiTypeId })],
  ['a rule already read is deactivated', (t, r) => t.deactivateRule({ id: r.globalId })],
];

for (const [label, mutate] of MUTATIONS) {
  test(`${label} between pages: the next call says to restart`, async (ctx) => {
    const t = fresh(ctx);
    const c = call(t);
    const seeded = seedFour(t);
    const first = t.listRules({ types: ['sourcing'], limit: 1 });
    mutate(t, seeded);
    assert.throws(() => t.listRules({ cursor: first.next_cursor, limit: 1 }), (e) => e instanceof ToolError && STALE.test(e.message));
    assert.match((await c('list_rules', { cursor: first.next_cursor as string, limit: 1 })).error, STALE);
    // Restarting works and reads one consistent revision to the end.
    const restart = t.listRules({ types: ['sourcing'], limit: 1 });
    assert.notEqual(restart.rules_revision, first.rules_revision);
    const seen = pages(t, { types: ['sourcing'], limit: 1 }).flat();
    assert.equal(seen.length, restart.total);
    assert.equal(new Set(seen).size, seen.length);
  });
}

test('changes that leave the revision alone do not stale a cursor', (ctx) => {
  const t = fresh(ctx);
  const seeded = seedFour(t);
  const first = t.listRules({ limit: 1 });
  t.setRuleTypes({ id: seeded.sourcingId, types: ['sourcing'] }); // same set
  t.listRules();
  assert.deepEqual(ids(t.listRules({ cursor: first.next_cursor, limit: 1 })), [seeded.sourcingId]);
});

test('list_rules over MCP takes lists of valid types and rejects bad items', async (ctx) => {
  const t = fresh(ctx);
  const c = call(t);
  const { globalId, sourcingId } = seedFour(t);
  const ok = await c('list_rules', { types: ['sourcing'], limit: 2 });
  assert.equal(ok.error, '');
  assert.deepEqual(ids({ rules: ok.data?.rules as { id: number }[] }), [globalId, sourcingId]);
  assert.equal(ok.data?.total, 3);
  assert.equal(typeof ok.data?.next_cursor, 'string');
  assert.deepEqual(Object.keys(ok.data ?? {}).sort(), ['next_cursor', 'rules', 'rules_revision', 'total']);
  assert.match((await c('list_rules', { types: ['unknown'] })).error, /unknown/);
  assert.match((await c('list_rules', { types: ['sourcing', 7] })).error, /types\[1\].*7/);
  assert.match((await c('list_rules', { types: [] })).error, /at least one/);
  assert.match((await c('list_rules', { types: 'sourcing' })).error, /types: expected array/);
  assert.match((await c('list_rules', { cursor: 7 })).error, /cursor: expected string/);
  assert.match((await c('list_rules', { types: ['Sourcing'] })).error, /Sourcing/);
});

test('the largest page carries every rule its own types', (ctx) => {
  const t = fresh(ctx);
  for (let i = 1; i <= 60; i++) t.addRule({ text: `Rule ${i}`, reason: 'r', types: i % 2 ? ['writing', 'forms'] : ['inbox'] });
  const page = t.listRules({ limit: 50 });
  assert.equal(page.rules.length, 50);
  assert.equal(page.total, 60);
  assert.ok(page.next_cursor);
  assert.deepEqual(page.rules.map((r) => r.types.join()), Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 'forms,writing' : 'inbox')));
  assert.deepEqual(ids(t.listRules({ cursor: page.next_cursor, limit: 50 })), [51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
});
