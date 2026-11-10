// gate_check from a hook: reads the local tracker database read-only.

import { existsSync } from 'node:fs';

import type { RoleRow } from '../../servers/tracker/src/db.ts';
import type { GateResult } from '../../servers/tracker/src/tracker.ts';
import { errorMessage } from '../../servers/tracker/src/util.ts';
import { targetMatchesRole } from './target.ts';

export async function gateCheck(roleId: number): Promise<GateResult> {
  try {
    const { defaultDbPath, openDb, SCHEMA_VERSION } = await import('../../servers/tracker/src/db.ts');
    const path = defaultDbPath();
    if (!existsSync(path)) return { ok: false, problems: [`No tracker database at ${path}. A submit cannot be checked, so it is blocked.`] };
    const { Tracker } = await import('../../servers/tracker/src/tracker.ts');
    const db = openDb(path, { readOnly: true });
    try {
      // A hook only reads, so it never migrates. An older schema lacks tables the check needs; say so plainly.
      // Anything but the current version blocks, including a value that is not a number at all.
      const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: unknown };
      if (user_version !== SCHEMA_VERSION) return { ok: false, problems: [`The tracker database is at schema v${user_version}; start the tracker once to upgrade it. A submit cannot be checked until then, so it is blocked.`] };
      return new Tracker(db).gateCheck({ role_id: roleId });
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, problems: [`Tracker check failed (${errorMessage(err)}). Blocked.`] };
  }
}

// Read the preference afresh so disabling auto-apply takes effect in an already-running session.
export async function autoApplyCheck(pageUrl: string): Promise<GateResult> {
  try {
    const { defaultDbPath, openDb, SCHEMA_VERSION } = await import('../../servers/tracker/src/db.ts');
    const path = defaultDbPath();
    if (!existsSync(path)) return { ok: false, problems: ['No tracker database.'] };
    const { Tracker } = await import('../../servers/tracker/src/tracker.ts');
    const db = openDb(path, { readOnly: true });
    try {
      const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: unknown };
      if (user_version !== SCHEMA_VERSION) return { ok: false, problems: ['The tracker database needs upgrading.'] };
      const t = new Tracker(db);
      if (t.section('autonomy').auto_apply !== true) return { ok: false, problems: ['Auto-apply is not enabled.'] };
      const roles = t.q<Pick<RoleRow, 'id' | 'url' | 'status' | 'score'>>('SELECT id, url, status, score FROM roles WHERE url IS NOT NULL')
        .filter((role) => role.url && targetMatchesRole(role.url, pageUrl));
      if (roles.length !== 1) return { ok: false, problems: ['The current page must identify exactly one tracked role.'] };
      const role = roles[0]!; // The unique match is required above.
      const gate = t.gateCheck({ role_id: role.id });
      if (role.status !== 'queued' || role.score === null) gate.problems.push('Auto-apply needs a scored, queued role.');
      const queued = t.one<{ question: string | null }>("SELECT question FROM events WHERE role_id = ? AND status = 'queued' ORDER BY ts DESC, id DESC LIMIT 1", role.id);
      if (!queued || queued.question) gate.problems.push('Resolve the queued question before automatic submission.');
      return { ...gate, ok: gate.problems.length === 0 };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, problems: [`Tracker check failed (${errorMessage(err)}). Blocked.`] };
  }
}
