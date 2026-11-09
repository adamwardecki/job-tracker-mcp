// The user's CV file: the checks before it is recorded, its hash, and the owner-only copy kept next to
// the tracker database. Tracker stores the result; nothing here touches the database.

import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ToolError } from './errors.ts';
import { secureDir, secureFile } from './fsperm.ts';
import { oneOf } from './util.ts';

export const CV_EXTENSIONS = ['.pdf', '.docx', '.doc'] as const;
// Gmail's attachment cap: a larger CV could not go on a draft anyway.
export const CV_MAX_BYTES = 25 * 1024 * 1024;

export interface CvRecord {
  path: string;
  mode: 'linked' | 'copied';
  sha256: string;
  bytes: number;
  saved_at: string;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Returns the size in bytes, or throws a ToolError that says what to ask the user.
export function checkCvFile(path: string): number {
  if (!isAbsolute(path)) throw new ToolError(`path must be absolute, got "${path}". Ask the user for the full path to the CV file.`);
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) throw new ToolError(`No file at ${path}. Check the path with the user, or ask them to drop the CV file into the chat.`);
  if (!st.isFile()) throw new ToolError(`${path} is not a file. Pass the CV file itself, not its folder.`);
  const ext = extname(path).toLowerCase();
  if (!oneOf(CV_EXTENSIONS, ext)) throw new ToolError(`The CV must be a PDF or Word file (${CV_EXTENSIONS.join(', ')}); ${basename(path)} is not.`);
  if (st.size === 0) throw new ToolError(`${basename(path)} is empty. Ask the user for the CV file again.`);
  if (st.size > CV_MAX_BYTES) throw new ToolError(`${basename(path)} is larger than 25 MB, Gmail's attachment limit. Ask the user for a smaller export.`);
  return st.size;
}

// Copies the CV into <folder of tracker.db>/cv/, owner-only. A copy with the same name is replaced; older
// copies with other names are left alone.
export function copyCv(src: string, dbPath: string | null): string {
  if (!dbPath || dbPath === ':memory:') throw new ToolError('This tracker runs in memory, so there is no folder to copy the CV into. Save it with copy: false.');
  const dir = join(dirname(resolve(dbPath)), 'cv');
  secureDir(dir);
  const dest = join(dir, basename(src));
  if (resolve(src) !== dest) copyFileSync(src, dest);
  secureFile(dest);
  return dest;
}

export function cvFileState(cv: Pick<CvRecord, 'path' | 'sha256'>): { exists: boolean; changed_since_saved: boolean } {
  const exists = statSync(cv.path, { throwIfNoEntry: false })?.isFile() ?? false;
  return { exists, changed_since_saved: exists && sha256File(cv.path) !== cv.sha256 };
}
