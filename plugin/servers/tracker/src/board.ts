#!/usr/bin/env node
// Board entry: serves the kanban page and its API on 127.0.0.1 for one database. open_board starts it
// detached. It stops itself after --idle-ms (default 30 minutes) without an authenticated API call.
//
// Flags: --db <path> (default as index.ts), --idle-ms <ms>. Logs go to stderr; stdout stays empty.

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Analytics } from './analytics.ts';
import { createBoardServer } from './board-server.ts';
import { boardStatePath, removeBoardState, writeBoardState } from './board-state.ts';
import { defaultDbPath, openDb } from './db.ts';
import { SERVER_INFO } from './mcp.ts';
import { Tracker } from './tracker.ts';
import { errorText } from './util.ts';

// A closed pipe (the launcher is gone) must not crash a board that is meant to outlive it.
process.stderr.on('error', () => {});

const argv = process.argv.slice(2);
const log = (msg: string) => process.stderr.write(`[board] ${msg}\n`);
const fail = (msg: string): never => {
  log(msg);
  process.exit(2);
};
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  // Why: silently falling back would open the real default database when the caller meant another one.
  if (!v || v.startsWith('--')) return fail(`${name} needs a value`);
  return v;
};

const dbPath = resolve(opt('--db', defaultDbPath()));
const idleMs = Number(opt('--idle-ms', String(30 * 60_000)));
// Why: setTimeout treats NaN, 0 and anything above 2^31-1 as 1 ms, so the board would vanish at once.
if (!Number.isInteger(idleMs) || idleMs < 1 || idleMs > 2147483647) fail('--idle-ms must be an integer from 1 to 2147483647');
const token = randomBytes(32).toString('hex');
const file = boardStatePath(dbPath);
// Board moves send usage events too, but only while the user's opt-in in the database says so.
const analytics = new Analytics({ version: SERVER_INFO.version });
const tracker = new Tracker(openDb(dbPath), { dbPath, analytics });
const server = createBoardServer({ tracker, token, idleMs, onIdle: stop, log });

// Every exit path, including an uncaught exception, removes our state file (only if it names this pid).
process.on('exit', () => removeBoardState(file, process.pid));

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close(() => void analytics.flush().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('board: no TCP address');
  writeBoardState(file, { port: addr.port, token, pid: process.pid, db: dbPath });
  log(`listening on 127.0.0.1:${addr.port}`);
});
// A crash that ends the board is reported (only if the user opted in), then the process exits as Node would.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    log(`${event}: ${errorText(err)}`);
    tracker.reportCrash(err, { where: event === 'uncaughtException' ? 'board_uncaught' : 'board_unhandled_rejection', handled: false });
    void analytics.flush(1500).finally(() => process.exit(1));
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
