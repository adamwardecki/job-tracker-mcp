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
