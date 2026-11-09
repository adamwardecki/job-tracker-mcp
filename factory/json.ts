// Narrowing helpers for GitHub JSON, which arrives as unknown.

import { isRecord } from '../plugin/servers/tracker/src/util.ts';

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
