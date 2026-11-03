// list_rules paging: filtered pages, revision-bound cursors and what a bad or stale cursor says.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
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
    const r = res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: Record<string, unknown> };
    return { error: r.isError ? String(JSON.parse(r.content[0].text).error) : '', data: r.structuredContent };
  };
}

const revision = (t: Tracker) => t.listRules().rules_revision;

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
  // A paging regression that never ends must fail the test, not hang it.
  for (let n = 0; page.next_cursor; n++) {
    if (n >= 100) assert.fail('still paging after 100 pages');
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
  seedFour(t);
  assert.deepEqual(t.listRules({ types: ['sourcing'] }).rules.map((r) => r.text), ['Legacy row', 'G', 'S', 'M']);
  assert.deepEqual(t.listRules({ types: ['global'] }).rules.map((r) => r.text), ['Legacy row', 'G']);
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
    ['too long', 'A'.repeat(1002)],
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

test('a cursor of exactly 1000 characters is decoded; the next possible size is refused', (ctx) => {
  const t = fresh(ctx);
  seedFour(t);
  // Valid JSON padded with spaces, so only its length tells it from a cursor the server could have issued.
  const sized = (length: number) => {
    const json = JSON.stringify({ v: 1, after_id: 1, revision: revision(t), types: null, include_inactive: false });
    for (let pad = 0; pad < 2000; pad++) {
      const cursor = Buffer.from(json + ' '.repeat(pad)).toString('base64url');
      if (cursor.length === length) return cursor;
    }
    throw new Error(`no cursor of length ${length}`);
  };
  const atCap = sized(1000);
  assert.deepEqual(ids(t.listRules({ cursor: atCap })), [2, 3, 4]);
  const over = sized(1002); // unpadded base64 has no 1001-character form
  assert.throws(() => t.listRules({ cursor: over }), (e) => e instanceof ToolError && /not base64url/.test(e.message) && RESTART.test(e.message));
});

test('listing rules does not need the write lock another connection holds', (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'jh-rules-'));
  const path = join(dir, 'tracker.db');
  const db = openDb(path);
  const other = openDb(path);
  ctx.after(() => {
    if (other.isTransaction) other.exec('ROLLBACK');
    other.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const t = new Tracker(db);
  seedFour(t);
  // The board server writes from its own connection. A short wait turns lock contention into a quick failure.
  db.exec('PRAGMA busy_timeout = 100;');
  other.exec('BEGIN IMMEDIATE');
  const page = t.listRules({ types: ['sourcing'], limit: 2 });
  assert.deepEqual(ids(page), [1, 2]);
  assert.equal(page.total, 3);
  assert.deepEqual(ids(t.listRules({ cursor: page.next_cursor })), [4]);
});
