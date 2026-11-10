// Glob matching for factory/risky-paths.txt. `**` crosses directories, `*` and `?` stay inside one segment.

import { posix } from 'node:path';

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more directories; any other `**` matches the rest of the path.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += (c ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseGlobList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const WILD = /[*?]/;
const literalPrefix = (g: string) => g.split(WILD)[0] ?? '';

// Collapse `//`, `./` and `x/..`, and drop leading `/` and `./`, so a path cannot dodge a glob by spelling.
const norm = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(?:\.?\/)+/, '');

// Nothing left, the repo root itself, or a path out of the repo: none of these says where the work happens.
const nowhere = (p: string) => p === '' || p === '.' || p === '..' || p.startsWith('../');

// Changed files (concrete paths) that fall under a risky glob.
export function riskyFiles(paths: readonly string[], globs: readonly string[]): string[] {
  const res = globs.map(globToRegExp);
  return paths.filter((p) => {
    const path = norm(p);
    return nowhere(path) || res.some((r) => r.test(path));
  });
}

// The brief's Touches entries that need approval. An entry is a file, a directory (everything under it) or a
// glob, so it counts when it could cover a risky path. A brief that lists nothing counts as risky: the planner did
// not say where it will work.
export function riskyTouches(touches: readonly string[], globs: readonly string[]): string[] {
  if (touches.length === 0) return ['(no Touches listed)'];
  const res = globs.map(globToRegExp);
  const risky = globs.map((g) => ({ prefix: literalPrefix(g), wild: WILD.test(g) }));
  return touches.filter((t) => {
    const path = norm(t);
    if (nowhere(path) || res.some((r) => r.test(path))) return true;
    // A plain entry may be a directory, so read it as `path/**` too.
    const prefix = WILD.test(path) ? literalPrefix(path) : `${path.replace(/\/$/, '')}/`;
    // Two globs can match a common path only if one literal prefix extends the other, so this test never misses
    // an overlap. It can over-flag (`plugin/*.md` against `plugin/hooks/**`), which only costs an approval. A
    // risky glob with no wildcard matches just itself, so a longer entry prefix cannot reach it.
    return risky.some((g) => g.prefix.startsWith(prefix) || (g.wild && prefix.startsWith(g.prefix)));
  });
}

// The changed paths that an approved Touches list covers. Each entry is read as riskyTouches reads it: a glob, and a
// plain entry also as a directory (`path/**`). An entry naming nowhere covers nothing, and a path out of the repo is
// never covered, so neither can wave a risky file through.
export function coveredBy(paths: readonly string[], globs: readonly string[]): string[] {
  const res = globs
    .map(norm)
    .filter((g) => !nowhere(g))
    .flatMap((g) => (WILD.test(g) ? [globToRegExp(g)] : [globToRegExp(g), globToRegExp(`${g.replace(/\/$/, '')}/**`)]));
  return paths.filter((p) => {
    const path = norm(p);
    return !nowhere(path) && res.some((r) => r.test(path));
  });
}
