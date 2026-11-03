// Bounded list_rules pages and get_rule: oversized rules arrive intact, in pieces, and never as partial JSON.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import type { RuleRow } from '../../plugin/servers/tracker/src/db.ts';
import { openDb } from '../../plugin/servers/tracker/src/db.ts';
import { ToolError } from '../../plugin/servers/tracker/src/errors.ts';
import type { RpcResponse } from '../../plugin/servers/tracker/src/mcp.ts';
import { makeHandler } from '../../plugin/servers/tracker/src/mcp.ts';
import { detailChunk, encodeCursor } from '../../plugin/servers/tracker/src/rules.ts';
import { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';

const BUDGET = 24 * 1024;
// A lone surrogate half means a chunk was cut inside a pair.
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2), 'utf8');

function fresh(ctx: TestContext) {
  const db = openDb(':memory:');
  ctx.after(() => db.close());
  return new Tracker(db);
}

// Every chunk of a rule, in order, checked against the byte budget as it arrives.
function readDetail(t: Tracker, id: number, limit?: number) {
  const chunks: string[] = [];
  let cursor: string | null = null;
  do {
    const part: ReturnType<Tracker['getRule']> = t.getRule({ id, cursor, limit });
    assert.ok(size(part) <= BUDGET, `chunk of ${size(part)} bytes`);
    assert.ok(part.chunk.length > 0, 'empty chunk');
    chunks.push(part.chunk);
    cursor = part.next_cursor;
  } while (cursor);
  return chunks;
}

test('an oversized rule is a detail reference in the list and arrives intact through get_rule', (ctx) => {
  const t = fresh(ctx);
  const originalText = 'Ł🙂\\\n'.repeat(12000);
  const originalReason = `${'Why: \u0001"quoted"\t'.repeat(300)}end`;
  const ruleId = t.addRule({ text: originalText, reason: originalReason, types: ['writing', 'forms'] }).rule_id;
  const page = t.listRules();
  assert.ok(size(page) <= BUDGET);
  assert.deepEqual(page.rules, [{ id: ruleId, types: ['forms', 'writing'], requires_detail: true }]);
  const chunks = readDetail(t, ruleId);
  assert.ok(chunks.length > 1);
  const rule = JSON.parse(chunks.join(''));
  assert.equal(rule.text, originalText);
  assert.equal(rule.reason, originalReason);
  assert.deepEqual(rule.types, ['forms', 'writing']);
  assert.equal(rule.added_by, 'user');
  assert.equal(rule.active, 1);
});

// A rule as list_rules shows it when it fits: stored fields plus types.
function stored(t: Tracker, id: number) {
  const row = t.q<RuleRow>('SELECT * FROM rules WHERE id = ?', id)[0]!;
  return { ...row, types: t.ruleTypesFor([id]).get(id)! as string[] };
}

// Follow next_cursor to the end and rebuild every rule, reading each detail reference through get_rule.
function collect(t: Tracker, args: Parameters<Tracker['listRules']>[0]) {
  const rules: unknown[] = [];
  const sizes: number[] = [];
  let page = t.listRules(args);
  for (let n = 0; ; n++) {
    if (n >= 200) assert.fail('still paging after 200 pages');
    assert.ok(size(page) <= BUDGET, `page of ${size(page)} bytes`);
    assert.ok(page.rules.length > 0 || page.total === 0, 'empty page while rules remain');
    sizes.push(page.rules.length);
    for (const r of page.rules) rules.push(r.requires_detail ? JSON.parse(readDetail(t, r.id).join('')) : r);
    if (!page.next_cursor) break;
    page = t.listRules({ cursor: page.next_cursor, limit: args?.limit });
  }
  return { rules, sizes };
}

test('pages stop at the byte budget before the count limit and say more remains', (ctx) => {
  const t = fresh(ctx);
  const ids: number[] = [];
  for (let i = 0; i < 30; i++) ids.push(t.addRule({ text: `Medium rule ${i}: ${'x'.repeat(2500)}`, reason: 'r' }).rule_id);
  const page = t.listRules({ limit: 50 });
  assert.ok(size(page) <= BUDGET);
  assert.ok(page.rules.length > 1 && page.rules.length < 30, `${page.rules.length} rules`);
  assert.ok(page.rules.every((r) => !r.requires_detail && typeof r.text === 'string'));
  assert.ok(page.next_cursor);
  assert.equal(page.total, 30);
  // The next page starts right after the last rule that was included.
  const next = t.listRules({ cursor: page.next_cursor, limit: 50 });
  assert.equal(next.rules[0]?.id, ids[page.rules.length]);
  assert.deepEqual(collect(t, { limit: 50 }).rules.map((r) => (r as { id: number }).id), ids);
});

test('a rule that fits alone is not turned into a reference because others came first', (ctx) => {
  const t = fresh(ctx);
  t.addRule({ text: 'a'.repeat(15000), reason: 'r' });
  const second = t.addRule({ text: 'b'.repeat(15000), reason: 'r' }).rule_id;
  const first = t.listRules();
  assert.equal(first.rules.length, 1);
  assert.ok(first.next_cursor);
  const next = t.listRules({ cursor: first.next_cursor });
  assert.equal(next.rules[0]?.id, second);
  assert.equal(next.rules[0]?.requires_detail, undefined);
  assert.equal(next.next_cursor, null);
});

test('a reference counts as progress and the rules after it still arrive', (ctx) => {
  const t = fresh(ctx);
  t.addRule({ text: 'small before', reason: 'r' });
  t.addRule({ text: 'z'.repeat(40000), reason: 'r' });
  t.addRule({ text: 'small after', reason: 'r' });
  const { rules } = collect(t, { limit: 50 });
  assert.deepEqual(rules.map((r) => (r as { text: string }).text.slice(0, 8)), ['small be', 'zzzzzzzz', 'small af']);
});

test('emoji, combining marks and control characters survive at every chunk size', (ctx) => {
  const t = fresh(ctx);
  const text = '🙂e\u0301\u0000\u001f\u2028"\\\n\t🧑\u200d💻Ł'.repeat(40);
  const id = t.addRule({ text, reason: 'Ünïcödé ✓', example: 'x' }).rule_id;
  for (const limit of [1, 2, 3, 5, 7, 64, 4000]) {
    const chunks = readDetail(t, id, limit);
    for (const c of chunks) {
      assert.ok(wellFormed(c), `half a surrogate pair at limit ${limit}`);
      assert.ok(Array.from(c).length <= limit);
    }
    assert.deepEqual(JSON.parse(chunks.join('')), stored(t, id));
  }
});

test('a chunk that would exceed the byte budget is shortened without splitting a code point', () => {
  // 4-byte code points at a limit above what the tool allows: the guard, not the limit, bounds the chunk.
  const serialized = '🙂'.repeat(20000);
  const part = detailChunk(1, serialized, 0, 20000, 3);
  assert.ok(size(part) <= BUDGET);
  assert.ok(Array.from(part.chunk).length < 20000 && wellFormed(part.chunk));
  assert.ok(part.next_cursor);
  const rest = detailChunk(1, serialized, Array.from(part.chunk).length, 20000, 3);
  assert.equal(part.chunk + rest.chunk, serialized.slice(0, (part.chunk + rest.chunk).length));
});

test('there is no empty last chunk when the length divides evenly', (ctx) => {
  const t = fresh(ctx);
  const id = t.addRule({ text: 'Short rule', reason: 'r' }).rule_id;
  const whole = Array.from(JSON.stringify(stored(t, id))).length;
  for (let limit = 1; limit <= whole + 1 && limit <= 4000; limit++) {
    const chunks = readDetail(t, id, limit);
    assert.equal(chunks.length, Math.ceil(whole / limit), `limit ${limit}`);
  }
  assert.equal(t.getRule({ id, limit: whole }).next_cursor, null);
});

test('a cursor for another rule, a stale revision and a bad offset are refused with a restart instruction', (ctx) => {
  const t = fresh(ctx);
  const a = t.addRule({ text: 'a'.repeat(9000), reason: 'r' }).rule_id;
  const b = t.addRule({ text: 'b'.repeat(9000), reason: 'r' }).rule_id;
  const first = t.getRule({ id: a, limit: 100 });
  assert.ok(first.next_cursor);
  assert.throws(() => t.getRule({ id: b, cursor: first.next_cursor }), (e) => e instanceof ToolError && /belongs to rule \d+, not rule \d+. Restart get_rule/.test(e.message));
  const revision = first.rules_revision;
  const past = encodeCursor({ id: a, offset: 99999, revision });
  assert.throws(() => t.getRule({ id: a, cursor: past }), (e) => e instanceof ToolError && /past the end.*Restart get_rule/.test(e.message));
  for (const bad of [{ id: a, offset: -1, revision }, { id: a, offset: 1.5, revision }, { id: a, offset: 'x', revision }, { id: a, revision }, { id: a, offset: 1, revision, extra: 1 }]) {
    assert.throws(() => t.getRule({ id: a, cursor: encodeCursor(bad) }), (e) => e instanceof ToolError && /Restart get_rule/.test(e.message));
  }
  assert.throws(() => t.getRule({ id: a, cursor: 'not a cursor!' }), (e) => e instanceof ToolError && /Restart get_rule/.test(e.message));
  // A list_rules cursor is not a detail cursor.
  const listCursor = t.listRules({ limit: 1 }).next_cursor;
  assert.throws(() => t.getRule({ id: a, cursor: listCursor }), (e) => e instanceof ToolError && /Restart get_rule/.test(e.message));
});

test('a rules change between chunks refuses the next chunk and says to restart', (ctx) => {
  const t = fresh(ctx);
  const id = t.addRule({ text: 'q'.repeat(9000), reason: 'r' }).rule_id;
  const first = t.getRule({ id, limit: 1000 });
  t.addRule({ text: 'another', reason: 'r' });
  assert.throws(() => t.getRule({ id, cursor: first.next_cursor, limit: 1000 }), (e) => e instanceof ToolError && /Rules changed.*Restart get_rule without a cursor/.test(e.message));
  // Starting over works and reads the new revision.
  const again = t.getRule({ id, limit: 1000 });
  assert.equal(again.rules_revision, first.rules_revision + 1);
  t.setRuleTypes({ id, types: ['forms'] });
  assert.throws(() => t.getRule({ id, cursor: again.next_cursor }), (e) => e instanceof ToolError && /Restart get_rule/.test(e.message));
});

test('a rule that does not exist is an error the model can act on', (ctx) => {
  const t = fresh(ctx);
  assert.throws(() => t.getRule({ id: 99 }), (e) => e instanceof ToolError && /No rule 99/.test(e.message));
});

test('an inactive rule keeps its state, types and provenance through get_rule', (ctx) => {
  const t = fresh(ctx);
  const id = t.addRule({ text: 'Old rule', reason: 'Because', example: 'e.g.', types: ['inbox', 'writing'], added_by: 'pipeline', added_on: '2026-02-03' }).rule_id;
  t.deactivateRule({ id });
  const rule = JSON.parse(readDetail(t, id).join(''));
  assert.deepEqual(rule, { id, text: 'Old rule', reason: 'Because', example: 'e.g.', added_by: 'pipeline', added_on: '2026-02-03', active: 0, types: ['writing', 'inbox'] });
});

test('every page and chunk is bounded and complete over small, medium and oversized rules', (ctx) => {
  const t = fresh(ctx);
  const sizes = [20, 3000, 40000, 100, 9000, 9000, 70000, 5, 12000, 4000, 4000, 4000, 30000, 1];
  for (const [i, n] of sizes.entries()) {
    const id = t.addRule({ text: `${i}:${'Ł🙂\\\n'.repeat(Math.ceil(n / 5))}`, reason: `reason ${i}`, types: [['global'], ['sourcing'], ['forms', 'writing']][i % 3] as ['global'] }).rule_id;
    if (i % 5 === 4) t.deactivateRule({ id });
  }
  for (const filter of [{}, { types: ['sourcing' as const] }, { include_inactive: true }, { types: ['writing' as const], include_inactive: true }]) {
    const all = t.listRules({ ...filter, limit: 50 });
    const expected = t.q<{ id: number }>('SELECT id FROM rules ORDER BY id').map((r) => r.id).filter((id) => {
      const row = stored(t, id);
      const wanted: string[] = filter.types ?? [];
      return (filter.include_inactive || row.active) && (!filter.types || row.types.includes('global') || row.types.some((k) => wanted.includes(k)));
    }).map((id) => stored(t, id));
    assert.equal(all.total, expected.length);
    for (const limit of [1, 2, 3, 7, 10, 50]) {
      const { rules } = collect(t, { ...filter, limit });
      assert.deepEqual(rules, expected, `filter ${JSON.stringify(filter)} limit ${limit}`);
    }
  }
});

test('get_rule through the protocol: argument limits and the text result stay in budget', async (ctx) => {
  const t = fresh(ctx);
  const id = t.addRule({ text: 'y'.repeat(20000), reason: 'r' }).rule_id;
  const handle = makeHandler(t);
  const call = async (args: Record<string, unknown>) => {
    const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_rule', arguments: args } })) as RpcResponse;
    return res.result as { isError: boolean; content: [{ text: string }]; structuredContent?: { chunk: string; next_cursor: string | null } };
  };
  const ok = await call({ id });
  assert.equal(ok.isError, false);
  assert.ok(Buffer.byteLength(ok.content[0].text, 'utf8') <= BUDGET);
  assert.equal(Array.from(ok.structuredContent!.chunk).length, 4000);
  assert.match(JSON.parse((await call({ id, limit: 1.5 })).content[0].text).error, /limit/);
  for (const limit of [0, 4001, -1]) assert.match(JSON.parse((await call({ id, limit })).content[0].text).error, /limit must be a whole number from 1 to 4000/);
  assert.equal((await call({})).isError, true);
  assert.match(JSON.parse((await call({ id: 5 })).content[0].text).error, /No rule 5/);
  const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_rules', arguments: {} } })) as RpcResponse;
  const text = (list.result as { content: [{ text: string }] }).content[0].text;
  assert.ok(Buffer.byteLength(text, 'utf8') <= BUDGET);
  assert.equal(JSON.parse(text).rules[0].requires_detail, undefined);
});
