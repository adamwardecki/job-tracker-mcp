#!/usr/bin/env node
// Entry point: MCP over stdio, backed by the local SQLite tracker. No network listener.
//
// Env: JOB_TRACKER_HOME (default ~/.job-tracker), JOB_TRACKER_DB (default $JOB_TRACKER_HOME/tracker.db). Flag: --db <path>.

import { createInterface } from 'node:readline';
import { Analytics } from './analytics.ts';
import { defaultDbPath, openDb } from './db.ts';
import { makeHandler, SERVER_INFO } from './mcp.ts';
import { Tracker } from './tracker.ts';
import { errorMessage, errorText, isRecord } from './util.ts';

const argv = process.argv.slice(2);
const opt = <T>(name: string, fallback: T): string | T => {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i + 1]) || fallback;
};
const log = (...a: unknown[]) => process.stderr.write(`[tracker] ${a.join(' ')}\n`);

const dbPath = opt('--db', defaultDbPath());
const analytics = new Analytics({ version: SERVER_INFO.version });
const tracker = new Tracker(openDb(dbPath), { dbPath, analytics });
const handle = makeHandler(tracker, { log });

// A crash that ends the server is reported (only if the user opted in), then the process exits as Node would.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    log(`${event}: ${errorText(err)}`);
    tracker.reportCrash(err, { where: event === 'uncaughtException' ? 'uncaught' : 'unhandled_rejection', handled: false });
    void analytics.flush(1500).finally(() => process.exit(1));
  });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set<Promise<void>>();
rl.on('line', (line) => {
  const p = onLine(line);
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  await analytics.flush();
  process.exit(0);
});

async function onLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  try {
    const res = await handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (err) {
    log('reply failed:', errorMessage(err));
    tracker.reportCrash(err, { where: 'reply' });
    const id = isRecord(msg) ? msg.id : undefined;
    if (id !== undefined && id !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } })}\n`);
  }
}

log(`stdio ready, db ${dbPath}`);
tracker.track('server_started');
