// Narrowing helpers for GitHub JSON, which arrives as unknown.

import { isRecord } from '../plugin/servers/tracker/src/util.ts';
import type { StageWorkflow } from './config.ts';
import type { RunSnapshot } from './decide.ts';

export function dig(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
export const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// A workflow run from the REST API or a workflow_run payload.
export function runFrom(r: unknown, workflow: StageWorkflow | 'ci'): RunSnapshot {
  return {
    workflow,
    conclusion: str(dig(r, 'conclusion')) || null,
    headSha: str(dig(r, 'head_sha')),
    url: str(dig(r, 'html_url')),
    createdAt: str(dig(r, 'created_at')) || null,
    completedAt: dig(r, 'status') === 'completed' ? str(dig(r, 'updated_at')) || null : null,
  };
}
