#!/usr/bin/env node
// Entry point: MCP over stdio, backed by the local SQLite tracker. No network listener.
//
// Env: JOB_TRACKER_HOME (default ~/.job-tracker), JOB_TRACKER_DB (default $JOB_TRACKER_HOME/tracker.db). Flag: --db <path>.

import { createInterface } from 'node:readline';
import { defaultDbPath, openDb } from './db.ts';
import { makeHandler } from './mcp.ts';
import { logPostHog, shutdownPostHogLogs } from './posthog-logs.ts';
import { shutdownPostHog } from './posthog.ts';
import { Tracker } from './tracker.ts';
import { errorMessage, isRecord } from './util.ts';

const argv = process.argv.slice(2);
const opt = <T>(name: string, fallback: T): string | T => {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i + 1]) || fallback;
};
const log = (...a: unknown[]) => process.stderr.write(`[tracker] ${a.join(' ')}\n`);

const dbPath = opt('--db', defaultDbPath());
const handle = makeHandler(new Tracker(openDb(dbPath), { dbPath }), { log });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set<Promise<void>>();
rl.on('line', (line) => {
  const p = onLine(line);
  pending.add(p);
  p.finally(() => pending.delete(p));
});
rl.on('close', async () => {
  await Promise.allSettled([...pending]);
  await shutdownPostHog();
  await shutdownPostHogLogs();
  process.exit(0);
});

async function onLine(line: string): Promise<void> {
  if (!line.trim()) return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    logPostHog('WARN', 'tracker_mcp_invalid_json');
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  try {
    const res = await handle(msg);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (err) {
    logPostHog('ERROR', 'tracker_mcp_request_failed');
    log('reply failed:', errorMessage(err));
    const id = isRecord(msg) ? msg.id : undefined;
    if (id !== undefined && id !== null) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } })}\n`);
  }
}

logPostHog('INFO', 'tracker_mcp_stdio_started');
log(`stdio ready, db ${dbPath}`);
