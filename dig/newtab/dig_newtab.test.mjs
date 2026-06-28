// Lightweight test harness for the chia://home (new-tab page) omnibox logic.
//
// A full Chromium build is infeasible in CI for a copy/UX change, so this test
// exercises the two pure functions that drive the NTP omnibox — classify() and
// digToChiaUrl() — directly. The functions are the single source of truth in
// dig/newtab/dig_newtab.html (mirroring net::dig::ParseDigUrn + url_fixer.cc);
// this harness EXTRACTS them from that HTML so the test can never drift from the
// shipped page.
//
// Run:  node dig/newtab/dig_newtab.test.mjs
// (Node >= 18; uses the built-in `node:test` runner + `node:assert`.)

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'dig_newtab.html'), 'utf8');

// Pull a single named function (incl. its body) out of the page's <script>.
// Matches `function NAME(...) { ... }` up to the matching closing brace by
// brace-balancing from the first `{`.
function extractFn(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, `function ${name} not found in dig_newtab.html`);
  const open = html.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

// Rebuild a module exposing the three interdependent helpers.
const src =
  extractFn('isHex64') + '\n' +
  extractFn('isAllHex') + '\n' +
  extractFn('digToChiaUrl') + '\n' +
  extractFn('classify') + '\n' +
  'export {classify, digToChiaUrl};';
const mod = await import(
  'data:text/javascript,' + encodeURIComponent(src));
const {classify, digToChiaUrl} = mod;

const STORE = 'a'.repeat(64);
const ROOT = 'b'.repeat(64);

test('classify: chia:// and urn:dig: inputs are DIG', () => {
  assert.equal(classify('chia://' + STORE), 'dig');
  assert.equal(classify('urn:dig:chia:' + STORE), 'dig');
});

test('classify: a bare 64-hex store id is DIG', () => {
  assert.equal(classify(STORE), 'dig');
  assert.equal(classify(STORE + '/index.html'), 'dig');
  assert.equal(classify(STORE + ':' + ROOT), 'dig');
});

test('classify: http(s) and dotted hosts are URL', () => {
  assert.equal(classify('https://dig.net'), 'url');
  assert.equal(classify('example.com'), 'url');
  assert.equal(classify('docs.dig.net/path'), 'url');
});

// Regression guard for the honest-copy fix: the NTP does NOT resolve names.
// A bare word (a would-be "store name") must fall through to web search, never
// be treated as a DIG address — otherwise the UI would over-promise handle
// resolution that doesn't exist yet.
test('classify: a bare name is a web search, NOT a DIG address', () => {
  assert.equal(classify('mystore'), 'search');
  assert.equal(classify('cool app'), 'search');
  assert.equal(classify('photos'), 'search');
});

test('classify: empty / whitespace is search', () => {
  assert.equal(classify(''), 'search');
  assert.equal(classify('   '), 'search');
});

test('digToChiaUrl: bare store id -> canonical host form', () => {
  assert.equal(digToChiaUrl(STORE), 'chia://' + STORE + '/');
});

test('digToChiaUrl: store:root -> root.store host', () => {
  assert.equal(digToChiaUrl(STORE + ':' + ROOT), 'chia://' + ROOT + '.' + STORE + '/');
});

test('digToChiaUrl: urn:dig:chain:store:root -> root.store host', () => {
  assert.equal(
    digToChiaUrl('urn:dig:chia:' + STORE + ':' + ROOT),
    'chia://' + ROOT + '.' + STORE + '/');
});

test('digToChiaUrl: resource path preserved; index.html dropped', () => {
  assert.equal(digToChiaUrl(STORE + '/app.js'), 'chia://' + STORE + '/app.js');
  assert.equal(digToChiaUrl(STORE + '/index.html'), 'chia://' + STORE + '/');
});

test('digToChiaUrl: ?salt is carried onto the canonical url', () => {
  assert.equal(
    digToChiaUrl(STORE + '?salt=dead'),
    'chia://' + STORE + '/?salt=dead');
});

test('digToChiaUrl: already-host form (root.store) returns null', () => {
  // Caller navigates host-form input as-is; digToChiaUrl signals that with null.
  assert.equal(digToChiaUrl('chia://' + ROOT + '.' + STORE + '/'), null);
});

test('digToChiaUrl: non-hex / non-DIG input returns null', () => {
  assert.equal(digToChiaUrl('not-a-store'), null);
  assert.equal(digToChiaUrl('https://dig.net'), null);
});
