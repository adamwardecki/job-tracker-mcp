// The board's HTTP server: a static page plus a small JSON API over the tracker. board.ts runs it.
// Loopback only; every API call carries the token; Host is checked so a rebinding DNS name can't reach it.

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { boardMove, boardNote, boardView } from './board-api.ts';
import { ToolError } from './errors.ts';
import type { Tracker } from './tracker.ts';
import { errorText } from './util.ts';

const asset = (name: string) => readFileSync(new URL(`./board/${name}`, import.meta.url));
const STATIC: Record<string, { type: string; body: Buffer }> = {
  '/': { type: 'text/html; charset=utf-8', body: asset('index.html') },
  '/board.css': { type: 'text/css; charset=utf-8', body: asset('board.css') },
  '/board.js': { type: 'text/javascript; charset=utf-8', body: asset('board.js') },
};
// Fonts ship with the board so it stays offline and only serves explicitly listed assets.
for (const family of ['geist', 'geist-mono', 'petrona', 'petrona-italic']) {
  for (const subset of ['latin', 'latin-ext']) {
    const name = `fonts/${family}-${subset}.woff2`;
    STATIC[`/${name}`] = { type: 'font/woff2', body: asset(name) };
  }
}
const MAX_BODY = 64 * 1024;
// No CORS headers are ever sent, so other origins can't read responses.
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BoardServerOptions {
  tracker: Tracker;
  token: string;
  idleMs: number;
  onIdle: () => void;
  log?: (msg: string) => void;
}

export function createBoardServer({ tracker, token, idleMs, onIdle, log = () => {} }: BoardServerOptions): Server {
  const expected = Buffer.from(`Bearer ${token}`);
  // onIdle stops the process; once it has run, a late call must not schedule it again.
  let fired = false;
  const arm = () =>
    setTimeout(() => {
      fired = true;
      onIdle();
    }, idleMs);
  let idle = arm();
  // Only authenticated calls keep the board alive, so a stray probe can't.
  const touch = () => {
    if (fired) return;
    clearTimeout(idle);
    idle = arm();
  };
  const authorized = (header: string | undefined): boolean => {
    const got = Buffer.from(header ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${errorText(err)}`);
      if (!res.headersSent) send(res, 500, { error: 'Internal error.' });
    });
  });
  // Bodies are capped at 64 KB and only loopback can connect, so slow senders get little time.
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.on('close', () => clearTimeout(idle));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : 0;
    const host = req.headers.host;
    const target = req.url ?? '';
    // Not `new URL`: it throws on `//` and reads `//x/api/board` as /api/board. The Host gate runs first.
    const path = target.split('?')[0] ?? '';
    const file = STATIC[path];
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) send(res, 421, { error: 'Wrong host.' });
    else if (!target.startsWith('/') || target.startsWith('//')) send(res, 400, { error: 'Bad request.' });
    else if (file && req.method === 'GET') {
      res.writeHead(200, { ...HEADERS, 'Content-Type': file.type });
      res.end(file.body);
    } else if (!path.startsWith('/api/')) send(res, 404, { error: 'Not found.' });
    else if (!authorized(req.headers.authorization)) send(res, 401, { error: 'Missing or wrong token. Run /job-tracker:board in Claude for a fresh link.' });
    else if (req.method !== 'GET' && !fromPage(req, host)) send(res, 403, { error: 'Changes are accepted only from the board page in your browser.' });
    else {
      touch();
      const [status, body] = await api(req, path);
      send(res, status, body);
    }
  }

  async function api(req: IncomingMessage, path: string): Promise<[number, unknown]> {
    try {
      if (req.method === 'GET' && path === '/api/health') return [200, { ok: true }];
      if (req.method === 'GET' && path === '/api/board') return [200, boardView(tracker)];
      if (req.method === 'POST' && path === '/api/move') return [200, boardMove(tracker, await readJson(req))];
      if (req.method === 'POST' && path === '/api/note') return [200, boardNote(tracker, await readJson(req))];
      return [404, { error: 'Not found.' }];
    } catch (err) {
      if (err instanceof HttpError) return [err.status, { error: err.message }];
      if (err instanceof ToolError) return [400, { error: err.message }];
      throw err;
    }
  }

  return server;
}

// A browser marks a write from the board page with the page's own origin. A script holding the token (the
// agent included) sends neither header unless it forges them on purpose, so moves come from someone at the board.
function fromPage(req: IncomingMessage, host: string | undefined): boolean {
  const site = req.headers['sec-fetch-site'];
  return req.headers.origin === `http://${host}` && (site === undefined || site === 'same-origin');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// A cross-site form can't send application/json without a CORS preflight, which this server never answers.
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send Content-Type: application/json.');
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not valid JSON.');
  }
}
