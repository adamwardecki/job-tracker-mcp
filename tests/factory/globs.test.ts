import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveredBy, globToRegExp, parseGlobList, riskyFiles, riskyTouches } from '../../factory/globs.ts';

const RISKY = ['plugin/hooks/**', 'plugin/servers/tracker/src/db.ts', '.github/**'];

test('** crosses directories and * stays inside one', () => {
  assert.ok(globToRegExp('plugin/hooks/**').test('plugin/hooks/gates.ts'));
  assert.ok(globToRegExp('plugin/hooks/**').test('plugin/hooks/sub/dir/x.ts'));
  assert.ok(globToRegExp('tests/*.test.ts').test('tests/hooks.test.ts'));
  assert.ok(!globToRegExp('tests/*.test.ts').test('tests/tracker/db.test.ts'));
  assert.ok(globToRegExp('**/x.ts').test('x.ts'));
  assert.ok(!globToRegExp('plugin/hooks/**').test('plugin/hooksx/a.ts'));
});

test('parseGlobList drops blanks and comments', () => {
  assert.deepEqual(parseGlobList('# risky\nplugin/hooks/**\n\n  .github/**  \n'), ['plugin/hooks/**', '.github/**']);
});

test('riskyFiles lists changed files under a risky glob', () => {
  assert.deepEqual(riskyFiles(['plugin/hooks/gates.ts', 'docs/setup.md', 'plugin/servers/tracker/src/db.ts'], RISKY), [
    'plugin/hooks/gates.ts',
    'plugin/servers/tracker/src/db.ts',
  ]);
});

test('riskyTouches flags concrete paths and wildcards that could cover a risky path', () => {
  assert.deepEqual(riskyTouches(['docs/setup.md', 'plugin/hooks/gates.ts'], RISKY), ['plugin/hooks/gates.ts']);
  assert.deepEqual(riskyTouches(['plugin/**'], RISKY), ['plugin/**']);
  assert.deepEqual(riskyTouches(['plugin/servers/*/src/*.ts'], RISKY), ['plugin/servers/*/src/*.ts']);
  assert.deepEqual(riskyTouches(['./docs/setup.md', 'tests/factory/*.test.ts'], RISKY), []);
});

test('an empty Touches list counts as risky', () => {
  assert.deepEqual(riskyTouches([], RISKY), ['(no Touches listed)']);
});

test('glob literals are escaped, ? is one character and a/**/b spans zero or more directories', () => {
  assert.ok(globToRegExp('a.b').test('a.b'));
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(globToRegExp('factor?/x.ts').test('factory/x.ts'));
  assert.ok(!globToRegExp('factor?/x.ts').test('factor/x.ts'));
  assert.ok(!globToRegExp('a?b').test('a/b'));
  assert.ok(globToRegExp('a/**/b').test('a/b'));
  assert.ok(globToRegExp('a/**/b').test('a/x/y/b'));
  assert.ok(!globToRegExp('a/**/b').test('a/x/y/c'));
});

const WIDE = [...RISKY, 'factory/**'];

test('riskyTouches flags wildcard entries whose literal prefix meets a risky glob', () => {
  for (const t of ['plugin/*/gates.ts', '**/hooks.json', '*/hooks/main.ts', 'factor?/main.ts', '.git*/workflows/ci.yml']) {
    assert.deepEqual(riskyTouches([t], WIDE), [t], t);
  }
});

test('riskyTouches flags directories that contain a risky path', () => {
  for (const t of ['plugin/hooks', 'plugin/hooks/', '.github', 'factory', 'plugin/servers/tracker']) {
    assert.deepEqual(riskyTouches([t], WIDE), [t], t);
  }
  // A directory entry can hold files a wildcard risky glob matches even when the glob's literal prefix is shorter.
  assert.deepEqual(riskyTouches(['plugin/hooks'], ['plugin/*/gates.ts']), ['plugin/hooks']);
  assert.deepEqual(riskyTouches(['plugin/servers/tracker/src/db.tsx'], ['plugin/servers/tracker/src/db.ts']), []);
});

test('riskyTouches normalises paths before matching', () => {
  for (const t of ['plugin//hooks/gates.ts', 'plugin/./hooks/x.ts', '/plugin/hooks/x.ts', '././plugin/hooks/x.ts', 'plugin/x/../hooks/x.ts', 'plugin\\hooks\\x.ts']) {
    assert.deepEqual(riskyTouches([t], WIDE), [t], t);
  }
});

test('riskyTouches flags entries that normalise to nothing or leave the repo', () => {
  for (const t of ['', '.', './', '/', 'a/..', '..', '../x.ts', 'docs/../../x.ts']) {
    assert.deepEqual(riskyTouches([t], WIDE), [t], JSON.stringify(t));
  }
});

test('riskyTouches leaves paths outside the risky globs alone', () => {
  assert.deepEqual(riskyTouches(['docs/setup.md', './docs/setup.md', 'tests/factory/*.test.ts', 'plugin/hooksx/a.ts'], WIDE), []);
});

test('riskyFiles normalises changed paths', () => {
  assert.deepEqual(riskyFiles(['./plugin/hooks/gates.ts', 'plugin//hooks/x.ts', 'docs/setup.md'], WIDE), ['./plugin/hooks/gates.ts', 'plugin//hooks/x.ts']);
});

test('coveredBy reads a plain approved entry as a file or a directory', () => {
  const files = ['plugin/hooks/gates.ts', 'plugin/hooks/sub/x.ts', 'plugin/hooksx/a.ts', 'AGENTS.md'];
  assert.deepEqual(coveredBy(files, ['plugin/hooks']), ['plugin/hooks/gates.ts', 'plugin/hooks/sub/x.ts']);
  assert.deepEqual(coveredBy(files, ['plugin/hooks/']), ['plugin/hooks/gates.ts', 'plugin/hooks/sub/x.ts']);
  assert.deepEqual(coveredBy(files, ['./AGENTS.md']), ['AGENTS.md']);
  assert.deepEqual(coveredBy(['./AGENTS.md', 'plugin//hooks/x.ts'], ['AGENTS.md', 'plugin/hooks']), ['./AGENTS.md', 'plugin//hooks/x.ts']);
});

test('coveredBy reads a wildcard entry as a glob only', () => {
  assert.deepEqual(coveredBy(['plugin/hooks/gates.ts', 'plugin/hooks/a/b.ts'], ['plugin/hooks/*.ts']), ['plugin/hooks/gates.ts']);
});

test('coveredBy: entries naming nowhere cover nothing, and paths out of the repo are never covered', () => {
  assert.deepEqual(coveredBy(['a.ts', 'docs/x.md'], ['', '.', './', '/', '..', '../x']), []);
  assert.deepEqual(coveredBy(['..', '../x.ts', ''], ['**']), []);
  assert.deepEqual(coveredBy(['a.ts'], []), []);
});
