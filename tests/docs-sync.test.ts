// The docs page (site/docs.html): stays in sync with the plugin's package.json and commands.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const readRepo = (p: string) => readFileSync(join(REPO, p), 'utf8');

const pkg = JSON.parse(readRepo('plugin/package.json'));
const docs = readRepo('site/docs.html');

test('docs page cites the Node.js engine requirement from package.json', () => {
  const engine = pkg.engines.node; // e.g. ">=22.18"
  assert.ok(engine, 'package.json has engines.node');
  // Strip the leading ">>=" or ">=" to get the version digits for the regex
  const version = engine.replace(/^>=\s*/, '');
  assert.match(docs, new RegExp(`Node\\.js\\s+${version.replace('.', '\\.')}`), 'docs mentions Node version');
});

test('docs page lists every shipped command', () => {
  const commandFiles = readdirSync(join(REPO, 'plugin', 'commands'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''));

  for (const name of commandFiles) {
    // Commands ship as /job-tracker:<name> in the docs
    assert.match(
      docs,
      new RegExp(`/job-tracker:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `docs mentions /job-tracker:${name}`,
    );
  }
});

test('docs page has expected sections', () => {
  const sections = ['requirements', 'install', 'setup', 'commands', 'data', 'dev'];
  for (const id of sections) {
    assert.ok(
      docs.includes(`id="${id}"`),
      `docs has section with id="${id}"`,
    );
  }
});

test('docs page links to the GitHub repo', () => {
  assert.ok(
    docs.includes('github.com/adamwardecki/job-tracker-mcp'),
    'docs links to GitHub repo',
  );
});

test('docs page links to privacy policy', () => {
  assert.ok(
    docs.includes('privacy.html'),
    'docs links to privacy page',
  );
});

test('docs page links to developer docs on GitHub', () => {
  assert.ok(
    docs.includes('job-tracker-mcp/blob/main/README.md'),
    'docs links to README on GitHub',
  );
  assert.ok(
    docs.includes('job-tracker-mcp/blob/main/CONTRIBUTING.md'),
    'docs links to CONTRIBUTING on GitHub',
  );
});
