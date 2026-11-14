// docs/hermes.md: the table of contents under the title lists every `##` heading, in order, with GitHub's anchors.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const lines = readFileSync(join(REPO, 'docs/hermes.md'), 'utf8').split('\n');

// GitHub's slug: lowercase, drop punctuation, spaces become hyphens.
const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');

test('Hermes doc table of contents matches its ## headings', () => {
  const headings: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      const marker = f[1]!.slice(0, 3); // the regex always captures a fence
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null) {
      const h = /^## (.+?)\s*#*\s*$/.exec(line);
      if (h) headings.push(h[1]!); // the regex always captures the heading text
    }
  }
  assert.ok(headings.length > 0, 'the doc has ## headings');

  assert.match(lines[0] ?? '', /^# /, 'the first line is the title');
  assert.equal(lines[1], '', 'a blank line follows the title');
  const toc: string[] = [];
  for (let i = 2; i < lines.length && lines[i]?.startsWith('- '); i++) toc.push(lines[i]!); // bounded by the loop condition

  assert.deepEqual(
    toc,
    headings.map((h) => `- [${h}](#${slug(h)})`),
  );
  assert.equal(lines[2 + toc.length], '', 'a blank line ends the list');
});
