import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../site/assets/laptop-chat.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

function chat({ loaded = false, reduced = false } = {}) {
  const steps = [...html.matchAll(/data-chat-at="(\d+)"(?: data-chat-until="(\d+)")?/g)].map((match) => {
    const classes = new Set<string>();
    return {
      dataset: { chatAt: match[1], chatUntil: match[2] },
      hasAttribute: (name: string) => name === 'data-chat-until' && match[2] !== undefined,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, visible: boolean) => visible ? classes.add(name) : classes.delete(name),
      },
      visible: () => classes.has('is-visible'),
    };
  });
  const events = new Map<string, () => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0;
  let id = 0;
  const listen = (name: string, callback: () => void) => events.set(name, callback);
  const motion = { matches: reduced, addEventListener: listen };
  const document = {
    readyState: loaded ? 'complete' : 'interactive',
    hidden: false,
    querySelector: () => ({ querySelectorAll: () => steps }),
    addEventListener: listen,
  };
  runInNewContext(script, {
    document,
    window: { addEventListener: listen },
    matchMedia: () => motion,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++id, { at: now + delay, callback }); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
  });
  return {
    steps, document, motion, timers,
    fire: (event: string) => events.get(event)?.(),
    tick(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = end;
    },
  };
}

test('the laptop chat waits for page load plus one second, reveals the roles, and repeats', () => {
  const c = chat();
  assert.equal(c.steps.length, 7);
  c.tick(5000);
  assert.equal(c.timers.size, 0, 'nothing starts before page load');
  c.fire('load');
  c.tick(999);
  assert.ok(c.steps.every((step) => !step.visible()));
  c.tick(1);
  assert.ok(c.steps[0]!.visible(), 'the user message starts at one second');
  c.tick(450);
  assert.ok(c.steps[1]!.visible(), 'the agent shows a typing indicator');
  c.tick(1750);
  assert.ok(!c.steps[1]!.visible());
  assert.ok(c.steps[2]!.visible(), 'the sweep summary follows the typing indicator');
  assert.ok(c.steps.slice(3).every((step) => !step.visible()));
  c.tick(1100);
  assert.ok(c.steps[3]!.visible(), 'roles arrive one at a time');
  assert.ok(!c.steps[4]!.visible());
  c.tick(3300);
  assert.ok(c.steps.filter((_, index) => index !== 1).every((step) => step.visible()));
  c.tick(7400);
  assert.ok(c.steps.every((step) => !step.visible()), 'the completed conversation resets');
  c.tick(1000);
  assert.ok(c.steps[0]!.visible(), 'the next conversation starts automatically');
});

test('reduced motion keeps the completed conversation still and reacts to preference changes', () => {
  const c = chat({ loaded: true, reduced: true });
  assert.equal(c.timers.size, 0);
  assert.ok(c.steps.filter((_, index) => index !== 1).every((step) => step.visible()));
  assert.ok(!c.steps[1]!.visible());
  c.motion.matches = false;
  c.fire('change');
  c.tick(1000);
  assert.ok(c.steps[0]!.visible());
  assert.ok(!c.steps[2]!.visible());
  c.motion.matches = true;
  c.fire('change');
  assert.equal(c.timers.size, 0);
  assert.ok(c.steps[6]!.visible());
});

test('a hidden tab stops scheduling the demo and restarts it when visible', () => {
  const c = chat({ loaded: true });
  c.tick(3200);
  c.document.hidden = true;
  c.fire('visibilitychange');
  assert.equal(c.timers.size, 0);
  c.tick(30000);
  c.document.hidden = false;
  c.fire('visibilitychange');
  c.tick(999);
  assert.ok(c.steps.every((step) => !step.visible()));
  c.tick(1);
  assert.ok(c.steps[0]!.visible());
});
