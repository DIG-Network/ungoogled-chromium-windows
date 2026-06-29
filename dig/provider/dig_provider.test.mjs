// Test harness for the injected window.chia provider (dig/provider/dig_provider.js).
//
// A full Chromium build is infeasible in CI for an introspection/agent-surface
// change, so this loads the IIFE provider source directly under a synthetic
// `window` and asserts the self-describing surface an agent relies on:
//   - window.chia.version / .info (provider identity)
//   - window.chia.methods (the static method catalogue)
//   - request({method:'chip0002_getMethods'}) (the introspection RPC, answered
//     locally without touching the native bridge)
//   - the stable thrown-error codes (4001/4100/4200 + provider transport codes)
//
// The provider is the single source of truth (compiled verbatim into the
// renderer by build.py); this harness EXECUTES that exact file so the test can
// never drift from the shipped provider.
//
// Run:  node dig/provider/dig_provider.test.mjs
// (Node >= 18; uses the built-in `node:test` runner + `node:assert`.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const providerSrc = readFileSync(join(here, 'dig_provider.js'), 'utf8');

// The provider runs in a separate vm realm, so arrays/objects it returns have a
// different Array/Object prototype and `deepStrictEqual` (which checks the
// prototype) would reject them. Compare structurally by value instead.
function sameJson(a, b) {
  assert.equal(JSON.stringify(a), JSON.stringify(b));
}

// Load the provider IIFE into a sandbox with a synthetic window. `bridge`, when
// provided, becomes window.__digWalletRpc (the native Mojo pipe stand-in).
function loadProvider(bridge) {
  const events = [];
  const sandbox = {
    window: {
      dispatchEvent(ev) { events.push(ev.type); },
    },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout,
    Date,
    Promise,
  };
  if (bridge) sandbox.window.__digWalletRpc = bridge;
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(providerSrc, sandbox, { filename: 'dig_provider.js' });
  return { chia: sandbox.window.chia, events };
}

test('provider exposes a stable identity: isDIG + version + info', () => {
  const { chia } = loadProvider();
  assert.equal(chia.isDIG, true);
  assert.equal(typeof chia.version, 'string');
  assert.ok(chia.version.length > 0, 'version is a non-empty string');
  assert.ok(chia.info && typeof chia.info === 'object', 'info object present');
  assert.equal(chia.info.isDIG, true);
  assert.equal(chia.info.edition, 'browser');
  assert.equal(chia.info.transport, 'native');
  assert.equal(chia.info.scheme, 'chia');
});

test('provider exposes a static method catalogue (window.chia.methods)', () => {
  const { chia } = loadProvider();
  assert.ok(Array.isArray(chia.methods), 'methods is an array');
  // CHIP-0002 core + chia_* surface must be present and namespaced.
  assert.ok(chia.methods.includes('chip0002_connect'));
  assert.ok(chia.methods.includes('chip0002_getPublicKeys'));
  assert.ok(chia.methods.includes('chip0002_signCoinSpends'));
  assert.ok(chia.methods.includes('chia_getAddress'));
  assert.ok(chia.methods.includes('chia_createOffer'));
  // every entry is namespaced (an agent can branch on the prefix).
  for (const m of chia.methods) {
    assert.match(m, /^(chip0002_|chia_)/, `${m} is namespaced`);
  }
  // no duplicates.
  assert.equal(new Set(chia.methods).size, chia.methods.length);
});

test('chip0002_getMethods is answered locally (no bridge call) and returns the catalogue', async () => {
  let bridgeCalls = 0;
  const bridge = {
    request() { bridgeCalls += 1; /* never resolves: must not be reached */ },
  };
  const { chia } = loadProvider(bridge);
  const res = await chia.request({ method: 'chip0002_getMethods' });
  assert.deepEqual(res, chia.methods);
  // The bare form resolves to the same introspection answer.
  const res2 = await chia.request({ method: 'getMethods' });
  assert.deepEqual(res2, chia.methods);
  assert.equal(bridgeCalls, 0, 'introspection must not hit the native bridge');
});

test('errorCodes catalogue is exported and uses standard wallet codes', () => {
  const { chia } = loadProvider();
  assert.ok(chia.errorCodes && typeof chia.errorCodes === 'object');
  assert.equal(chia.errorCodes.USER_REJECTED, 4001);
  assert.equal(chia.errorCodes.UNAUTHORIZED, 4100);
  assert.equal(chia.errorCodes.UNSUPPORTED_METHOD, 4200);
  assert.equal(chia.errorCodes.WALLET_UNREACHABLE, 4900);
});

test('an unreachable bridge throws WALLET_UNREACHABLE (4900), not the ad-hoc -1', async () => {
  // No bridge installed at all.
  const { chia } = loadProvider();
  await assert.rejects(
    () => chia.request({ method: 'getPublicKeys' }),
    (e) => { assert.equal(e.code, 4900); return true; });
});

test('a 401 from the wallet maps to UNAUTHORIZED (4100)', async () => {
  const bridge = {
    request(_req, cb) {
      cb(JSON.stringify({ status: 401, body: { error: 'origin not approved' } }));
    },
  };
  const { chia } = loadProvider(bridge);
  await assert.rejects(
    () => chia.request({ method: 'getPublicKeys' }),
    (e) => { assert.equal(e.code, 4100); return true; });
});

test('a pending (202) connect surfaces USER_REJECTED-class pending code (4001)', async () => {
  const bridge = {
    request(_req, cb) { cb(JSON.stringify({ status: 202, body: {} })); },
  };
  const { chia } = loadProvider(bridge);
  // rpc() (not connect()'s retry loop) throws the pending error with code 4001.
  await assert.rejects(
    () => chia.request({ method: 'getPublicKeys' }),
    (e) => { assert.equal(e.code, 4001); assert.equal(e.pending, true); return true; });
});

test('a successful call returns body.data and marks connected on connect', async () => {
  const bridge = {
    request(req, cb) {
      const parsed = JSON.parse(req);
      if (parsed.method === 'chip0002_connect') {
        cb(JSON.stringify({ status: 200, body: { data: { connected: true } } }));
      } else {
        cb(JSON.stringify({ status: 200, body: { data: ['pk1', 'pk2'] } }));
      }
    },
  };
  const { chia } = loadProvider(bridge);
  const keys = await chia.request({ method: 'getPublicKeys' });
  sameJson(keys, ['pk1', 'pk2']);
  await chia.connect();
  assert.equal(chia.isConnected, true);
});
