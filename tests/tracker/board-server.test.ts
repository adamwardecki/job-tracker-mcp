import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { request } from 'node:http';
import { test } from 'node:test';
import { createBoardServer } from '../../plugin/servers/tracker/src/board-server.ts';
import type { Tracker } from '../../plugin/servers/tracker/src/tracker.ts';
import { seeded } from './board-seed.ts';

const TOKEN = 'a'.repeat(64);

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function board({ idleMs = 60_000, onIdle = () => {}, tracker }: { idleMs?: number; onIdle?: () => void; tracker?: Tracker } = {}) {
  const s = seeded();
  const server = createBoardServer({ tracker: tracker ?? s.t, token: TOKEN, idleMs, onIdle });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const port = addr.port;
  const send = (method: string, path: string, { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<Reply>((done, fail) => {
      const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      });
      req.on('error', fail);
      req.end(body);
    });
  const auth = { authorization: `Bearer ${TOKEN}` };
  // What the board page's fetch sends on a write.
  const page = { ...auth, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' };
  const json = { ...page, 'content-type': 'application/json' };
  const close = () =>
    new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    });
  return { ...s, port, send, auth, page, json, close };
}

test('API calls without the token, or with a wrong one, get 401', async () => {
  const b = await board();
  try {
    assert.equal((await b.send('GET', '/api/board')).status, 401);
    assert.equal((await b.send('GET', '/api/health', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status, 401);
    assert.equal((await b.send('GET', '/api/health', { headers: { authorization: 'Bearer short' } })).status, 401);
  } finally {
    await b.close();
  }
});

test('a foreign Host header gets 421, even with the token (DNS rebinding)', async () => {
  const b = await board();
  try {
    assert.equal((await b.send('GET', '/', { headers: { host: `evil.example:${b.port}` } })).status, 421);
    assert.equal((await b.send('GET', '/api/board', { headers: { ...b.auth, host: `evil.example:${b.port}` } })).status, 421);
    assert.equal((await b.send('GET', '/api/health', { headers: { ...b.auth, host: `localhost:${b.port}` } })).status, 200);
  } finally {
    await b.close();
  }
});

test('the page is static, carries no data and sends a strict CSP', async () => {
  const b = await board();
  try {
    const page = await b.send('GET', '/');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    assert.doesNotMatch(page.body, /Northwind/);
    assert.match((await b.send('GET', '/board.js')).headers['content-type'] ?? '', /text\/javascript/);
    assert.match((await b.send('GET', '/board.css')).headers['content-type'] ?? '', /text\/css/);
    assert.equal((await b.send('GET', '/nope')).status, 404);
  } finally {
    await b.close();
  }
});

test('the board serves bundled fonts under its same-origin font policy', async () => {
  const b = await board();
  try {
    const page = await b.send('GET', '/');
    assert.match(String(page.headers['content-security-policy']), /font-src 'self';/);
    for (const family of ['geist', 'geist-mono', 'petrona', 'petrona-italic']) {
      for (const subset of ['latin', 'latin-ext']) {
        const font = await b.send('GET', `/fonts/${family}-${subset}.woff2`);
        assert.equal(font.status, 200);
        assert.equal(font.headers['content-type'], 'font/woff2');
        assert.ok(font.body.startsWith('wOF2'), 'serves a WOFF2 font');
      }
    }
    assert.equal((await b.send('GET', '/fonts/unknown.woff2')).status, 404);
  } finally {
    await b.close();
  }
});

test('the board data and moves go through the tracker rules', async () => {
  const b = await board();
  try {
    const view = JSON.parse((await b.send('GET', '/api/board', { headers: b.auth })).body);
    assert.ok(view.roles.some((r: { company: string }) => r.company === 'Northwind'));
    const ok = await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ role_id: b.scored, to: 'queued', reason: 'Moved on the board' }) });
    assert.equal(ok.status, 200);
    assert.equal(b.t.roleDetail({ role_id: b.scored }).events.at(-1)?.actor, 'user');
    const sweep = await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ role_id: b.found, to: 'applied', reason: 'r', evidence: 'e' }) });
    assert.equal(sweep.status, 400);
    assert.match(JSON.parse(sweep.body).error, /still in the sweep \(found\)/);
    const back = await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ role_id: b.scored, to: 'scored' }) });
    assert.equal(back.status, 200);
    const noEvidence = await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ role_id: b.scored, to: 'dropped' }) });
    assert.equal(noEvidence.status, 200);
    assert.equal(b.t.roleRow(b.scored)?.status, 'dropped');
    const verified = await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ role_id: b.queued, to: 'verified', reason: 'r' }) });
    assert.equal(verified.status, 400);
  } finally {
    await b.close();
  }
});

test('posts must be JSON, small and well formed', async () => {
  const b = await board();
  try {
    const body = JSON.stringify({ role_id: b.scored, to: 'queued', reason: 'r' });
    assert.equal((await b.send('POST', '/api/move', { headers: { ...b.page, 'content-type': 'text/plain' }, body })).status, 415);
    assert.equal((await b.send('POST', '/api/move', { headers: b.json, body: '{oops' })).status, 400);
    assert.equal((await b.send('POST', '/api/move', { headers: b.json, body: JSON.stringify({ reason: 'x'.repeat(70 * 1024) }) })).status, 413);
  } finally {
    await b.close();
  }
});

test('the idle timer fires after idleMs without an authenticated API call', async () => {
  let fired: () => void = () => {};
  const idle = new Promise<void>((done) => {
    fired = done;
  });
  const b = await board({ idleMs: 100, onIdle: () => fired() });
  try {
    await idle;
  } finally {
    await b.close();
  }
});

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

test('odd request targets are refused after the Host check, never a 500', async () => {
  const b = await board();
  try {
    assert.equal((await b.send('GET', '//')).status, 400);
    assert.equal((await b.send('GET', '//x/api/board', { headers: b.auth })).status, 400);
    assert.equal((await b.send('GET', '//', { headers: { host: `evil.example:${b.port}` } })).status, 421);
    assert.equal((await b.send('GET', '/api/health?x=1', { headers: b.auth })).status, 200);
  } finally {
    await b.close();
  }
});

test('the content type must be exactly application/json', async () => {
  const b = await board();
  try {
    const body = JSON.stringify({ role_id: b.scored, to: 'queued', reason: 'r' });
    assert.equal((await b.send('POST', '/api/move', { headers: { ...b.page, 'content-type': 'application/jsonp' }, body })).status, 415);
    assert.equal((await b.send('POST', '/api/move', { headers: { ...b.page, 'content-type': 'application/json; charset=utf-8' }, body })).status, 200);
  } finally {
    await b.close();
  }
});

test('no CORS headers, even on a preflight', async () => {
  const b = await board();
  try {
    const r = await b.send('OPTIONS', '/api/move', { headers: { ...b.auth, origin: 'https://evil.example' } });
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    assert.equal(r.headers['access-control-allow-methods'], undefined);
  } finally {
    await b.close();
  }
});

test('an internal failure answers a generic 500', async () => {
  const s = seeded();
  const broken = Object.create(s.t, {
    q: {
      value: () => {
        throw new Error('Northwind secret');
      },
    },
  }) as Tracker;
  const b = await board({ tracker: broken });
  try {
    const r = await b.send('GET', '/api/board', { headers: b.auth });
    assert.equal(r.status, 500);
    assert.equal(r.body, '{"error":"Internal error."}');
  } finally {
    await b.close();
  }
});

test('onIdle runs once, and only authenticated calls defer it', async () => {
  let calls = 0;
  const b = await board({ idleMs: 150, onIdle: () => calls++ });
  try {
    await sleep(100);
    await b.send('GET', '/api/health', { headers: b.auth });
    await sleep(100); // 200 ms since start: would have fired without the call
    assert.equal(calls, 0);
    await sleep(100);
    assert.equal(calls, 1);
    await b.send('GET', '/api/health', { headers: b.auth });
    await sleep(250);
    assert.equal(calls, 1);
  } finally {
    await b.close();
  }
});

test('unauthenticated probes do not defer onIdle', async () => {
  let calls = 0;
  const b = await board({ idleMs: 150, onIdle: () => calls++ });
  try {
    await sleep(100);
    assert.equal((await b.send('GET', '/api/health')).status, 401);
    await sleep(100);
    assert.equal(calls, 1);
  } finally {
    await b.close();
  }
});

test('a note is posted to /api/note and recorded as the user', async () => {
  const b = await board();
  try {
    const res = await b.send('POST', '/api/note', { headers: b.json, body: JSON.stringify({ role_id: b.queued, reason: 'Recruiter says remote is fine' }) });
    assert.equal(res.status, 200);
    const ev = b.t.roleDetail({ role_id: b.queued }).events.at(-1);
    assert.equal(ev?.reason, 'Recruiter says remote is fine');
    assert.equal(ev?.actor, 'user');
    assert.equal((await b.send('POST', '/api/note', { headers: b.json, body: JSON.stringify({ role_id: b.queued }) })).status, 400);
    assert.equal((await b.send('POST', '/api/note', { body: '{}' })).status, 401);
  } finally {
    await b.close();
  }
});

test('writes are accepted only from the board page itself', async () => {
  const b = await board();
  try {
    const body = JSON.stringify({ role_id: b.scored, to: 'queued' });
    const post = (headers: Record<string, string>) => b.send('POST', '/api/move', { headers: { ...b.auth, 'content-type': 'application/json', ...headers }, body });
    // A script with the token but no browser headers (curl, fetch from Node).
    const script = await post({});
    assert.equal(script.status, 403);
    assert.match(JSON.parse(script.body).error, /board page/);
    assert.equal((await post({ origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ origin: `http://127.0.0.1:${b.port}`, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(b.t.roleRow(b.scored)?.status, 'scored');
    // localhost is the same board, so its own origin is fine.
    assert.equal((await post({ host: `localhost:${b.port}`, origin: `http://localhost:${b.port}`, 'sec-fetch-site': 'same-origin' })).status, 200);
    // Reads stay open to any token holder.
    assert.equal((await b.send('GET', '/api/board', { headers: b.auth })).status, 200);
  } finally {
    await b.close();
  }
});
