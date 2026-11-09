import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BRIEF_MARKER,
  type FactoryState,
  parseBriefTouches,
  parseCommand,
  parseReview,
  parseState,
  renderState,
} from '../../factory/markers.ts';

const STATE: FactoryState = {
  stage: 'fixing',
  since: '2026-11-09T11:00:00.000Z',
  round: 2,
  attempts: 1,
  pr: 51,
  brief: 900,
  headSha: 'abc',
  fixReason: 'review',
  runs: ['https://example.test/runs/1'],
};

test('state comments round-trip', () => {
  const body = renderState(STATE);
  assert.match(body, /Factory: \*\*fixing\*\* · PR #51 · fix round 2/);
  assert.deepEqual(parseState(body), STATE);
});

test('state parsing rejects missing, malformed and unknown-stage markers', () => {
  assert.equal(parseState('hello'), null);
  assert.equal(parseState('<!-- factory:state {not json} -->'), null);
  assert.equal(parseState('<!-- factory:state {"stage":"shipping","since":"x","round":0,"attempts":0,"runs":[]} -->'), null);
});

test('brief touches are read from the Factory block', () => {
  const body = [
    BRIEF_MARKER,
    '## Agent Brief',
    '**Summary:** add a thing',
    '### Factory',
    '**Seams:**',
    '- the record tool call',
    '',
    '**Touches:**',
    '',
    '- `plugin/servers/tracker/src/report.ts`',
    '* tests/tracker/report-activity.test.ts',
    '',
    'Trailing text',
  ].join('\n');
  assert.deepEqual(parseBriefTouches(body), ['plugin/servers/tracker/src/report.ts', 'tests/tracker/report-activity.test.ts']);
});

test('a brief without the marker or the Touches heading has no touches', () => {
  assert.equal(parseBriefTouches('**Touches:**\n- `a.ts`'), null);
  assert.equal(parseBriefTouches(`${BRIEF_MARKER}\n## Agent Brief`), null);
});

test('review markers carry the blocking count', () => {
  assert.deepEqual(parseReview('<!-- factory:review {"blocking":2,"nits":1} -->\n## Standards'), { blocking: 2, nits: 1 });
  assert.equal(parseReview('<!-- factory:review {"blocking":"2"} -->'), null);
  assert.equal(parseReview('LGTM'), null);
});

test('commands are a slash word at the start of the comment', () => {
  assert.equal(parseCommand('/approve'), 'approve');
  assert.equal(parseCommand('  /stop please\nthanks'), 'stop');
  assert.equal(parseCommand('/retry'), 'retry');
  assert.equal(parseCommand('/approved'), null);
  assert.equal(parseCommand('please /approve'), null);
});
