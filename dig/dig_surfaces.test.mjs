// Agent-surface guard for the DIG Browser dig/* HTML pages.
//
// A full Chromium build is infeasible in CI, so this asserts the agent-driveable
// affordances the AGENT_FRIENDLY pass added directly on the shipped HTML sources
// (the same files build.py embeds into the binary):
//   - stable data-testid on primary CTAs / inputs / nav / status elements,
//   - semantic landmarks + ARIA on every page (welcome/about had 0),
//   - the about page carries a machine-readable version block,
//   - the shields page exposes the page's verification verdict as document
//     data-* attributes an agent can read.
//
// These are string/structure checks on the HTML (no DOM engine); they exist to
// stop the agent hooks from silently drifting out of the pages.
//
// Run:  node dig/dig_surfaces.test.mjs   (Node >= 18)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const about = read('about/dig_about.html');
const welcome = read('welcome/dig_welcome.html');
const shields = read('shields/dig_shields.html');
const newtab = read('newtab/dig_newtab.html');

// Every embedded surface must be a single well-formed-enough HTML doc: one
// <html>, balanced <body>, declared lang.
for (const [name, html] of [['about', about], ['welcome', welcome],
                            ['shields', shields], ['newtab', newtab]]) {
  test(`${name}: basic HTML structure`, () => {
    assert.match(html, /^<!doctype html>/i, 'has doctype');
    assert.match(html, /<html lang="en">/, 'html has lang');
    assert.equal((html.match(/<body/g) || []).length, 1, 'one <body>');
    assert.equal((html.match(/<\/body>/g) || []).length, 1, 'one </body>');
    assert.equal((html.match(/<\/html>/g) || []).length, 1, 'one </html>');
  });
}

test('about: has a main landmark and a data-testid on the page + version + links', () => {
  assert.match(about, /<main\b[^>]*data-testid="about-page"/, 'main[data-testid=about-page]');
  assert.match(about, /role="document"|<main/, 'has a landmark');
  // machine-readable version block (the {{VERSION}} token stays — filled at runtime).
  assert.match(about, /data-testid="about-version"/, 'version element testid');
  assert.match(about, /data-dig-version="\{\{VERSION\}\}"/, 'data-dig-version carries the token');
  assert.match(about, /\{\{VERSION\}\}/, 'version placeholder preserved for runtime fill');
  // the nav links are reachable by stable testids.
  assert.match(about, /data-testid="about-link-network"/);
  assert.match(about, /data-testid="about-link-hub"/);
  assert.match(about, /data-testid="about-link-docs"/);
  assert.match(about, /data-testid="about-link-welcome"/);
});

test('welcome: tour has ARIA + data-testid on controls (was 0 ARIA)', () => {
  assert.match(welcome, /<main\b[^>]*data-testid="welcome-page"/, 'main[data-testid=welcome-page]');
  // the slide deck is a labelled group; slides are testable by index.
  assert.match(welcome, /data-testid="welcome-next"/);
  assert.match(welcome, /data-testid="welcome-back"/);
  assert.match(welcome, /data-testid="welcome-skip"/);
  assert.match(welcome, /data-testid="welcome-finish"/);
  assert.match(welcome, /data-testid="welcome-set-default"/);
  // some ARIA must now exist (role/aria-*), where before there was none.
  assert.match(welcome, /\baria-/, 'has at least one aria-* attribute');
  assert.match(welcome, /role="/, 'has at least one role');
});

test('shields: page exposes the verification verdict as document data-* + testids', () => {
  assert.match(shields, /<main\b[^>]*data-testid="shields-page"/, 'main[data-testid=shields-page]');
  assert.match(shields, /data-testid="shields-badge"/);
  assert.match(shields, /data-testid="shields-status-title"/);
  assert.match(shields, /data-testid="shields-capsule-toggle"/);
  // the script must set document-level data-* attributes for an agent to read
  // the page's verdict without scraping visible text.
  assert.match(shields, /data-dig-scheme/, 'writes data-dig-scheme');
  assert.match(shields, /data-dig-verified/, 'writes data-dig-verified');
  assert.match(shields, /data-dig-source/, 'writes data-dig-source');
  assert.match(shields, /data-dig-capsule/, 'writes data-dig-capsule');
});

test('newtab: primary CTAs/inputs/nav carry stable data-testid', () => {
  assert.match(newtab, /data-testid="ntp-omnibox"/, 'search input');
  assert.match(newtab, /data-testid="ntp-omnibox-go"/, 'go button');
  assert.match(newtab, /data-testid="ntp-tab-apps"/);
  assert.match(newtab, /data-testid="ntp-tab-search"/);
  assert.match(newtab, /data-testid="ntp-wallet"/, 'wallet button');
  assert.match(newtab, /data-testid="ntp-publish"/, 'publish CTA');
  // the apps directory is driven from a data array; each card is addressable.
  assert.match(newtab, /data-testid="ntp-app-card"/, 'app cards');
});
