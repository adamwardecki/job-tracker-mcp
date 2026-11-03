// gate_check from a hook: reads the local tracker database read-only.

import { existsSync } from 'node:fs';

import type { GateResult } from '../../servers/tracker/src/tracker.ts';
import { errorMessage } from '../../servers/tracker/src/util.ts';

export async function gateCheck(roleId: number): Promise<GateResult> {
  try {
    const { defaultDbPath, openDb, SCHEMA_VERSION } = await import('../../servers/tracker/src/db.ts');
    const path = defaultDbPath();
    if (!existsSync(path)) return { ok: false, problems: [`No tracker database at ${path}. A submit cannot be checked, so it is blocked.`] };
    const { Tracker } = await import('../../servers/tracker/src/tracker.ts');
    const db = openDb(path, { readOnly: true });
    try {
      // A hook only reads, so it never migrates. An older schema lacks tables the check needs; say so plainly.
      const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (user_version < SCHEMA_VERSION) return { ok: false, problems: [`The tracker database is at schema v${user_version}; start the tracker once to upgrade it. A submit cannot be checked until then, so it is blocked.`] };
      return new Tracker(db).gateCheck({ role_id: roleId });
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, problems: [`Tracker check failed (${errorMessage(err)}). Blocked.`] };
  }
}
