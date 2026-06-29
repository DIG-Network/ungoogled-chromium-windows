// Test harness for the per-capsule inclusion-proof LEDGER (dig/shields/dig_ledger.mjs).
//
// A full Chromium build is infeasible in CI, so the PURE ledger logic the native
// chia:// loader mirrors in C++ (the per-capsule accumulator keyed by
// storeId:rootHash, and the pass/fail grouping the shields page renders) lives in
// a single JS module this harness exercises directly. The C++ loader's
// LedgerStore (dig_url_loader_factory.cc) records the SAME {resourcePath, storeId,
// rootHash, inclusionProofPassed, errorCode} entries; the shields page restates
// groupLedger() verbatim and dig_shields.test.mjs guards that copy. Change all
// three in lockstep.
//
// Run:  node dig/shields/dig_ledger.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capsuleKey,
  LedgerStore,
  groupLedger,
} from "./dig_ledger.mjs";

const STORE = "1426d9064bb59353e2ad3845c1d250af1f75476a6d4d85f2c4d6b90696359907";
const ROOT = "cc77916250e587e9d39d9fca59afdaf1bce89aa26c4d56249b2c14406dda8e4e";

test("capsuleKey is the canonical storeId:rootHash (lowercased)", () => {
  assert.equal(capsuleKey(STORE, ROOT), STORE + ":" + ROOT);
  assert.equal(capsuleKey(STORE.toUpperCase(), ROOT.toUpperCase()), STORE + ":" + ROOT);
  // A rootless capsule (root resolved to "latest" / unknown) still keys cleanly.
  assert.equal(capsuleKey(STORE, ""), STORE + ":latest");
  assert.equal(capsuleKey(STORE, "latest"), STORE + ":latest");
});

test("LedgerStore.record accumulates per-capsule entries keyed by storeId:rootHash", () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "index.html", inclusionProofPassed: true });
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "app.js", inclusionProofPassed: true });
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.resourcePath), ["index.html", "app.js"]);
  // A different capsule is a separate ledger.
  assert.equal(store.entriesFor(STORE, "deadbeef").length, 0);
});

test("LedgerStore.record normalizes resourcePath (leading slash dropped, empty/'/' → index.html)", () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "/style.css", inclusionProofPassed: true });
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "", inclusionProofPassed: true });
  // A bare "/" normalizes to the SAME default-view key as "" → it updates, not duplicates.
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "/", inclusionProofPassed: true });
  const paths = store.entriesFor(STORE, ROOT).map((e) => e.resourcePath);
  assert.deepEqual(paths, ["style.css", "index.html"]);
});

test("LedgerStore.record is idempotent per resourcePath — re-fetch UPDATES, never duplicates", () => {
  const store = new LedgerStore();
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "app.js", inclusionProofPassed: false, errorCode: "DIG_ERR_PROOF_MISMATCH" });
  // Same resource re-served (e.g. retry succeeds) → the latest verdict wins, one entry.
  store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "app.js", inclusionProofPassed: true });
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inclusionProofPassed, true);
  assert.equal(entries[0].errorCode, "");
});

test("LedgerStore caps per-capsule entries (bounds memory) keeping the most recent", () => {
  const store = new LedgerStore({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) {
    store.record({ storeId: STORE, rootHash: ROOT, resourcePath: "r" + i + ".js", inclusionProofPassed: true });
  }
  const entries = store.entriesFor(STORE, ROOT);
  assert.equal(entries.length, 3);
  // Oldest (r0, r1) evicted; the most recent three remain in order.
  assert.deepEqual(entries.map((e) => e.resourcePath), ["r2.js", "r3.js", "r4.js"]);
});

test("groupLedger splits PASSED vs FAILED and counts each", () => {
  const entries = [
    { resourcePath: "index.html", inclusionProofPassed: true, errorCode: "" },
    { resourcePath: "app.js", inclusionProofPassed: true, errorCode: "" },
    { resourcePath: "evil.js", inclusionProofPassed: false, errorCode: "DIG_ERR_PROOF_MISMATCH" },
    { resourcePath: "missing.png", inclusionProofPassed: false, errorCode: "DIG_ERR_NOT_FOUND" },
  ];
  const g = groupLedger(entries);
  assert.equal(g.passedCount, 2);
  assert.equal(g.failedCount, 2);
  assert.deepEqual(g.passed.map((e) => e.resourcePath), ["index.html", "app.js"]);
  assert.deepEqual(g.failed.map((e) => e.resourcePath), ["evil.js", "missing.png"]);
  // The aggregate verdict is true only when there are entries and NONE failed.
  assert.equal(g.allPassed, false);
  assert.equal(g.total, 4);
  assert.equal(g.empty, false);
});

test("groupLedger: all-passed and empty states are distinguishable", () => {
  const allPass = groupLedger([
    { resourcePath: "index.html", inclusionProofPassed: true, errorCode: "" },
  ]);
  assert.equal(allPass.allPassed, true);
  assert.equal(allPass.empty, false);
  assert.equal(allPass.failedCount, 0);

  const none = groupLedger([]);
  assert.equal(none.empty, true);
  assert.equal(none.allPassed, false, "no entries is NOT 'all passed' — nothing was verified yet");
  assert.equal(none.passedCount, 0);
  assert.equal(none.failedCount, 0);

  // Defensive: a non-array argument is treated as empty.
  assert.equal(groupLedger(null).empty, true);
  assert.equal(groupLedger(undefined).empty, true);
});

test("groupLedger does not mutate its input and tolerates missing fields", () => {
  const entries = [{ resourcePath: "x.js" }]; // no inclusionProofPassed → treated as failed (fail-closed)
  const g = groupLedger(entries);
  assert.equal(g.failedCount, 1, "an entry without a positive pass verdict counts as failed (fail-closed)");
  assert.equal(g.passedCount, 0);
  assert.equal(entries.length, 1, "input untouched");
});
