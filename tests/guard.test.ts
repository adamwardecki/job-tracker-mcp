// Runs skills/triage-tracker/guard.js against the synthetic board in headless Chrome (AC8).
// Skips when Chrome is not installed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
const board = readFileSync(join(root, 'tests/fixtures/jobcopilot-board.html'), 'utf8');
const guard = readFileSync(join(root, 'plugin/skills/triage-tracker/guard.js'), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'guard-'));

// The parts of the JOBHUNT_TRIAGE_GUARD output these tests read.
interface GuardOut {
  ok: boolean;
  problems: string[];
  count?: number;
  protected: Record<string, { count: number; checked: number }>;
  extra: string[];
  delete_controls: { label: string }[];
}

// Chrome on macOS prints the DOM but may not exit; stop it once the document is out.
function dumpDom(file: string, timeoutMs: number): Promise<string> {
  assert.ok(CHROME, 'Chrome not found');
  return new Promise<string>((resolve, reject) => {
    const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${join(dir, `profile-${Math.random().toString(36).slice(2)}`)}`, '--dump-dom', `file://${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`Chrome timed out after ${timeoutMs}ms; stderr: ${err.slice(-500) || '(none)'}`));
    }, timeoutMs);
    p.stderr.on('data', (d: Buffer) => {
      err += d;
    });
    p.stdout.on('data', (d: Buffer) => {
      buf += d;
      if (buf.includes('</html>')) {
        clearTimeout(timer);
        p.kill('SIGKILL');
        resolve(buf);
      }
    });
    p.on('exit', () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

// The first Chrome start on a fresh CI runner pays for cold disk and font caches while the rest of the
// suite runs in parallel: about 11s on Ubuntu, and past 30s on a slow runner. Pay it once here, with room,
// so the 30s limit on each guard run below still catches a real hang.
before(async () => {
  if (!CHROME) return;
  const file = join(dir, 'warmup.html');
  writeFileSync(file, '<!doctype html><html><body></body></html>');
  await dumpDom(file, 120000);
}, { timeout: 130000 });

// check: [[column, title], ...] boxes to tick before running the guard.
async function runGuard(input: Record<string, unknown>, check: [string, string][]): Promise<GuardOut> {
  assert.ok(CHROME, 'Chrome not found');
  const script = `
    window.onerror = (msg, src, line, col) => { const e = document.createElement('pre'); e.id = 'err'; e.textContent = msg + ' @' + line + ':' + col; document.body.appendChild(e); };
    for (const [col, title] of ${JSON.stringify(check)}) {
      const column = [...document.querySelectorAll('.at-card')].find((c) => c.querySelector('.at-title').textContent === col);
      const job = [...column.querySelectorAll('.job')].find((j) => j.querySelector('.job-title').textContent === title);
      job.querySelector('input').checked = true;
    }
    const line = ${guard.replace('__JOBHUNT_GUARD_INPUT__', JSON.stringify(input))};
    const pre = document.createElement('pre'); pre.id = 'out'; pre.textContent = line; document.body.appendChild(pre);`;
  const file = join(dir, `case-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, board.replace('</body>', `<script>${script}</script></body>`));
  const dom = await dumpDom(file, 30000);
  const m = dom.match(/<pre id="out">JOBHUNT_TRIAGE_GUARD (\{.*?\}) JOBHUNT_END<\/pre>/s);
  assert.ok(m, `guard produced no output: ${(dom.match(/<pre id="err">[^<]*/) || [dom.slice(-300)])[0]}`);
  // &amp; goes last, so a title containing "&lt;" is not decoded twice.
  return JSON.parse(m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

const base = { column: 'Saved', protectedColumns: ['Applied'], allColumns: ['Applied', 'Saved', 'Interviewing', 'Offer', 'Rejected'] };

test('AC8 guard: resolves Saved by header text even though Applied is the first .at-card', { skip: !CHROME && 'Chrome not found' }, async () => {
  const r = await runGuard({ ...base, intended: ['Backend Engineer', 'Frontend Lead'], expectedCounts: { Applied: 5 } }, [['Saved', 'Backend Engineer'], ['Saved', 'Frontend Lead']]);
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(r.count, 4);
  assert.deepEqual(r.protected.Applied, { count: 5, checked: 0 });
  assert.equal(r.delete_controls[0]?.label, 'Delete selected');
});

test('AC8 guard: a checked card in Applied (identical markup) fails', { skip: !CHROME && 'Chrome not found' }, async () => {
  const r = await runGuard({ ...base, intended: ['Senior Engineer'] }, [['Saved', 'Senior Engineer'], ['Applied', 'Senior Engineer']]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /protected column "Applied" has 1 checked/.test(p)));
});

test('AC8 guard: selection must equal the intended list exactly', { skip: !CHROME && 'Chrome not found' }, async () => {
  const r = await runGuard({ ...base, intended: ['Backend Engineer'] }, [['Saved', 'Backend Engineer'], ['Saved', 'Product Engineer']]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['Product Engineer']);
});

test('AC8 guard: a changed protected count fails', { skip: !CHROME && 'Chrome not found' }, async () => {
  const r = await runGuard({ ...base, intended: ['Backend Engineer'], expectedCounts: { Applied: 6 } }, [['Saved', 'Backend Engineer']]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /count changed: expected 6, now 5/.test(p)));
});
