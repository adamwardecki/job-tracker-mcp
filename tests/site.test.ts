// The landing page (site): the water overlay, the stylesheet and the scripts the pages load.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(REPO, 'site');

test("the water overlay shares the artwork's coordinates and sits under the screen layer", () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const image = html.match(/src="assets\/zen-engawa\.webp"[\s\S]*?width="(\d+)"\s+height="(\d+)"/);
  assert.ok(image, 'the hero image keeps its intrinsic size');
  assert.match(html, new RegExp(`<svg\\s+class="garden-water"\\s+viewBox="0 0 ${image[1]} ${image[2]}"`));
  assert.ok(html.indexOf('class="garden-water"') < html.indexOf('class="laptop-screen"'));
});

test('reduced motion stops every animation, and the ripples rest invisible', () => {
  const css = readFileSync(join(SITE, 'assets', 'style.css'), 'utf8');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\*,\s*\*:before,\s*\*:after\s*\{[^}]*animation: none !important;/);
  assert.match(css, /\.water-ripple\s*\{[^}]*opacity: 0;/);
});

test('every script the pages load, and every module main.js imports, exists; nothing loads a renderer', () => {
  const mainJs = readFileSync(join(SITE, 'assets', 'main.js'), 'utf8');
  for (const page of ['index.html', 'privacy.html']) {
    const html = readFileSync(join(SITE, page), 'utf8');
    for (const [, src] of html.matchAll(/<script[^>]* src="([^"]+)"/g)) assert.ok(existsSync(join(SITE, src!)), `${page}: ${src}`);
    assert.doesNotMatch(html, /painted-hero|paintedHero/, page);
  }
  for (const [, path] of mainJs.matchAll(/import\("\.\/([^"]+)"\)/g)) assert.ok(existsSync(join(SITE, 'assets', path!)), path);
  assert.doesNotMatch(mainJs, /painted-hero|paintedHero|baseTransform/);
});

test('both pages load one stylesheet', () => {
  for (const page of ['index.html', 'privacy.html']) {
    const html = readFileSync(join(SITE, page), 'utf8');
    assert.deepEqual([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]), ['assets/style.css'], page);
  }
});

test('every color in style.css comes from a :root variable', () => {
  const css = readFileSync(join(SITE, 'assets', 'style.css'), 'utf8');
  const root = css.match(/:root\s*\{[^}]*\}/)?.[0] ?? '';
  // A mask gradient reads only alpha, so its #000 is not a color choice.
  const rest = css.replace(root, '').replace(/mask-image:[^;]*;/g, '');
  assert.deepEqual(rest.match(/#[0-9a-fA-F]{3,8}\b|(?<!-)\b(?:white|black)\b(?!-)|rgba?\(|hsla?\(/g), null);
});

test('the hero has a How it works button that opens a dialog with the local reel', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="demo"|demo-section/);
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('class="garden-art"'));
  const actions = hero.slice(hero.indexOf('class="hero-actions"'));
  assert.ok(actions.indexOf('>Get Job Tracker') > 0 && actions.indexOf('>Get Job Tracker') < actions.indexOf('data-video-dialog="demo-dialog"'), 'the button follows Get Job Tracker');
  assert.match(actions, /<button[^>]*data-video-dialog="demo-dialog"[^>]*>\s*How it works\s*<\/button>/);
  const dialog = html.match(/<dialog[^>]*id="demo-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(dialog, /aria-label="[^"]+"/);
  assert.match(dialog, /data-dialog-close/);
  assert.match(dialog, /src="assets\/job-tracker-reel\.mp4"/);
});

test('the setup video button lives only in the desktop panel and opens a dialog', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const panels = [...html.matchAll(/<section\s+role="tabpanel"\s+id="(panel-[a-z]+)"[\s\S]*?<\/section>\s*(?=<section\s+role="tabpanel"|<\/div>)/g)];
  assert.equal(panels.length, 3);
  for (const [panel, id] of panels) assert.equal(panel.includes('data-video-dialog="setup-dialog"'), id === 'panel-desktop', id);
  assert.match(html, /<dialog[^>]*id="setup-dialog"[^>]*aria-label="[^"]+"/);
  const dialog = html.match(/<dialog[\s\S]*?<\/dialog>/)?.[0] ?? '';
  assert.match(dialog, /<video[^>]*\scontrols\b/);
  assert.match(dialog, /data-dialog-close/);
  const js = readFileSync(join(SITE, 'assets', 'main.js'), 'utf8');
  assert.match(js, /showModal\(\)/);
  assert.match(js, /\.play\(\)/);
  assert.match(js, /\.pause\(\)/);
});

test('every video on the page is a committed local file', () => {
  const html = readFileSync(join(SITE, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<(?:video|source)[^>]*?\ssrc="([^"]+)"/g)].map((m) => m[1]!); // group 1 is not optional in the regex
  assert.equal(srcs.length, 2);
  for (const [video] of html.matchAll(/<video[^>]*>/g)) {
    for (const attr of [/\scontrols\b/, /\splaysinline\b/, /preload="metadata"/, /aria-label="[^"]+"/, /width="\d+"/, /height="\d+"/]) assert.match(video, attr);
    assert.doesNotMatch(video, /autoplay/); // playback starts from the button's click handler, never on load
  }
  for (const src of srcs) {
    assert.doesNotMatch(src, /^(?:[a-z]+:)?\/\//i, src);
    assert.ok(existsSync(join(SITE, src)), src);
  }
  assert.doesNotMatch(html, /<iframe/);
});
