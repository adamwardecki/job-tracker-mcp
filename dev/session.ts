// Starts Claude Code on the released plugin with real data, or on this worktree's plugin with a copy of it.
// Maintainer tool; not shipped.
//
//   npm run dev     copy ~/.job-tracker/tracker.db into ~/.job-tracker-dev, refresh the marketplace, then start
//                   Claude Code with this worktree's plugin/ on the copy (the released plugin turned off)
//   npm run prod    back up ~/.job-tracker/tracker.db, update the released plugin, then start Claude Code on it
//
// Arguments after `--` go to claude, e.g. `npm run dev -- --resume`.
//
// Nothing is switched on disk: dev turns the released plugin off with --settings for its own session only,
// so "back to prod" is just starting claude without those flags.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { secureDir, secureFile } from '../plugin/servers/tracker/src/fsperm.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'job-tracker@job-tracker-mcp';
const MARKETPLACE = 'job-tracker-mcp';
const PROD_HOME = join(homedir(), '.job-tracker');
const DEV_HOME = join(homedir(), '.job-tracker-dev');
const PROD_DB = join(PROD_HOME, 'tracker.db');

// SQLite's backup API, not a file copy: production sessions may have the DB open with an unflushed WAL.
async function copyDb(from: string, to: string): Promise<void> {
  if (!existsSync(from)) throw new Error(`${from} does not exist; nothing to copy.`);
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(source, to);
  } finally {
    source.close();
  }
  secureFile(to);
}

// Marketplace and plugin updates need the network; being offline should not stop a session from starting.
function claudeCli(args: string[]): void {
  const r = spawnSync('claude', args, { stdio: 'inherit', env: cleanEnv() });
  if (r.error) throw new Error(`could not run claude (${r.error.message}); is Claude Code on PATH?`);
  if (r.status !== 0) process.stderr.write(`[session] claude ${args.join(' ')} failed; continuing.\n`);
}

function startClaude(args: string[], env: NodeJS.ProcessEnv): never {
  const r = spawnSync('claude', args, { stdio: 'inherit', env, cwd: process.env.INIT_CWD ?? REPO });
  if (r.error) throw new Error(`could not run claude (${r.error.message}); is Claude Code on PATH?`);
  process.exit(r.status ?? 1);
}

// A JOB_TRACKER_* variable left in the shell would point either mode at the wrong folder.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.JOB_TRACKER_HOME;
  delete env.JOB_TRACKER_DB;
  return env;
}

async function dev(passthrough: string[]): Promise<void> {
  secureDir(DEV_HOME);
  const to = join(DEV_HOME, 'tracker.db');
  await copyDb(PROD_DB, to);
  process.stderr.write(`[session] copied ${PROD_DB} to ${to}\n`);
  claudeCli(['plugin', 'marketplace', 'update', MARKETPLACE]);
  // Without the override both copies load as job-tracker and every hook runs twice, against different folders.
  const settings = JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } });
  // The copy carries the real database's usage-analytics opt-in; dev sessions stay out of the production project.
  startClaude(['--plugin-dir', join(REPO, 'plugin'), '--settings', settings, ...passthrough], { ...cleanEnv(), JOB_TRACKER_HOME: DEV_HOME, JOB_TRACKER_ANALYTICS: 'off' });
}

async function prod(passthrough: string[]): Promise<void> {
  // Migrations only go forward, so an update rewrites the real DB the first time it opens it.
  if (existsSync(PROD_DB)) {
    const to = join(PROD_HOME, `backup-${new Date().toISOString().slice(0, 10)}.db`);
    await copyDb(PROD_DB, to);
    process.stderr.write(`[session] backed up ${PROD_DB} to ${to}\n`);
  }
  claudeCli(['plugin', 'marketplace', 'update', MARKETPLACE]);
  claudeCli(['plugin', 'update', PLUGIN_ID]);
  startClaude(passthrough, cleanEnv());
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'dev') await dev(rest);
else if (mode === 'prod') await prod(rest);
else {
  process.stderr.write(`usage: node dev/session.ts dev|prod [claude args...]; got ${mode ?? 'nothing'}\n`);
  process.exit(2);
}
