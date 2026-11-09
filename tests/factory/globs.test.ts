import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp, parseGlobList, riskyFiles, riskyTouches } from '../../factory/globs.ts';

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
