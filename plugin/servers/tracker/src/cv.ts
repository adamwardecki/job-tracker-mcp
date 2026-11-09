// The user's CV file: the checks before it is recorded, its hash, and the owner-only copy kept next to
// the tracker database. Tracker stores the result; nothing here touches the database.

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ToolError } from './errors.ts';
import { secureDir, secureFile } from './fsperm.ts';
import { isRecord, oneOf } from './util.ts';

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

// Only filesystem errors carry an errno code; anything else is a bug and must keep propagating.
function errnoCode(e: unknown): string | null {
  return isRecord(e) && typeof e.code === 'string' ? e.code : null;
}

// sha256File for save_cv: a file that stat could see but cannot be read is something the user can fix.
export function hashCvFile(path: string): string {
  try {
    return sha256File(path);
  } catch (e) {
    const code = errnoCode(e);
    if (code) throw new ToolError(`Cannot read ${basename(path)} (${code}). Ask the user to check the file's permissions or choose another location.`);
    throw e;
  }
}

// Returns the size in bytes, or throws a ToolError that says what to ask the user.
export function checkCvFile(path: string): number {
  if (!isAbsolute(path)) throw new ToolError(`path must be absolute (expand ~ first), got "${path}". Ask the user for the full path to the CV file.`);
  let st: Stats | undefined;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch (e) {
    const code = errnoCode(e);
    if (code) throw new ToolError(`Cannot read ${basename(path)} (${code}). Ask the user to check the file's permissions or choose another location.`);
    throw e;
  }
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
  const dest = join(dir, basename(src));
  try {
    secureDir(dir);
    // The copy keeps the source's mode until secureFile runs; that is safe because cv/ is already 0700.
    if (resolve(src) !== dest) copyFileSync(src, dest);
    secureFile(dest);
  } catch (e) {
    const code = errnoCode(e);
    if (code) throw new ToolError(`Cannot copy ${basename(src)} into the tracker folder (${code}). Check that the file is readable and the tracker folder is writable, or save it with copy: false.`);
    throw e;
  }
  return dest;
}

export interface CvFileState {
  exists: boolean;
  readable: boolean;
  changed_since_saved: boolean;
  // errno code (EACCES, EPERM, ...) when the file is there but cannot be read.
  error?: string;
}

export function cvFileState(cv: Pick<CvRecord, 'path' | 'sha256' | 'bytes'>): CvFileState {
  try {
    const st = statSync(cv.path, { throwIfNoEntry: false });
    if (!st?.isFile()) return { exists: false, readable: false, changed_since_saved: false };
    // A different size means a different file, so skip reading (and hashing) a file we already know changed.
    if (st.size !== cv.bytes) return { exists: true, readable: true, changed_since_saved: true };
    return { exists: true, readable: true, changed_since_saved: sha256File(cv.path) !== cv.sha256 };
  } catch (e) {
    const code = errnoCode(e);
    if (!code) throw e;
    return { exists: true, readable: false, changed_since_saved: false, error: code };
  }
}
