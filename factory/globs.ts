// Glob matching for factory/risky-paths.txt. `**` crosses directories, `*` and `?` stay inside one segment.

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

const clean = (p: string) => p.replace(/^\.\//, '');

// Changed files (concrete paths) that fall under a risky glob.
export function riskyFiles(paths: readonly string[], globs: readonly string[]): string[] {
  const res = globs.map(globToRegExp);
  return paths.filter((p) => res.some((r) => r.test(clean(p))));
}

// The brief's Touches entries that need approval. A wildcard entry counts when it could cover a risky path, and a
// brief that lists nothing counts as risky: the planner did not say where it will work.
export function riskyTouches(touches: readonly string[], globs: readonly string[]): string[] {
  if (touches.length === 0) return ['(no Touches listed)'];
  const res = globs.map(globToRegExp);
  const prefixes = globs.map((g) => g.split(/[*?]/)[0] ?? '');
  return touches.filter((t) => {
    const path = clean(t);
    if (res.some((r) => r.test(path))) return true;
    if (!/[*?]/.test(path)) return false;
    const touch = globToRegExp(path);
    return prefixes.some((p) => touch.test(p));
  });
}
