// Test harness for the source-resolution policy (dig/node/dig_source_resolution.mjs).
//
// A full Chromium build is infeasible in CI, so the *pure* resolution policy the
// native chia:// loader mirrors (candidate ordering, the setting gate, the
// short-TTL reachability memo, and the resolve plan) lives in a single JS module
// that this harness exercises directly. The C++ loader carries a pointer back to
// that module; these tests guard the contract both sides share.
//
// Run:  node dig/node/dig_source_resolution.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIG_LOCAL_HOST,
  DEFAULT_LOCAL_PORT,
  HEALTH_PATH,
  RPC_PATH,
  PROBE_TTL_MS,
  SOURCE_LOCAL_NODE,
  SOURCE_IN_PROCESS,
  localNodeCandidates,
  isHealthyDigNode,
  ReachabilityMemo,
  resolveSourcePlan,
} from "./dig_source_resolution.mjs";

test("local-node candidates: dig.local FIRST, then localhost:<port> (default 8080)", () => {
  const c = localNodeCandidates();
  assert.deepEqual(c, [`http://${DIG_LOCAL_HOST}`, `http://localhost:${DEFAULT_LOCAL_PORT}`]);
  assert.equal(c[0], "http://dig.local", "dig.local has NO port and is tried first");
  assert.equal(DEFAULT_LOCAL_PORT, 8080, "default localhost listener port is 8080");
});

test("a custom port is honored on the localhost candidate (dig.local stays portless)", () => {
  const c = localNodeCandidates({ port: 9099 });
  assert.deepEqual(c, ["http://dig.local", "http://localhost:9099"]);
});

test("the setting can DISABLE the local node entirely (consumer needs none)", () => {
  // preferLocalNode:false → no standalone-node candidates; the browser consumes
  // via its in-process node only, still fully functional.
  assert.deepEqual(localNodeCandidates({ preferLocalNode: false }), []);
  // default (omitted) prefers the local node.
  assert.equal(localNodeCandidates().length, 2);
  assert.equal(localNodeCandidates({ preferLocalNode: true }).length, 2);
});

test("the probe paths are /health (liveness) and / (rpc), never a content method", () => {
  assert.equal(HEALTH_PATH, "/health");
  assert.equal(RPC_PATH, "/");
});

test("isHealthyDigNode requires status:ok AND mode:local-node", () => {
  assert.equal(isHealthyDigNode({ status: "ok", mode: "local-node" }), true);
  // accepts a JSON string too (what a raw HTTP body is).
  assert.equal(isHealthyDigNode('{"status":"ok","mode":"local-node","version":"1"}'), true);
  // a different service squatting the port is rejected.
  assert.equal(isHealthyDigNode({ status: "ok", mode: "something-else" }), false);
  assert.equal(isHealthyDigNode({ status: "degraded", mode: "local-node" }), false);
  // malformed / empty → false (fail safe: fall through to the in-process node).
  assert.equal(isHealthyDigNode("not json"), false);
  assert.equal(isHealthyDigNode(null), false);
  assert.equal(isHealthyDigNode(undefined), false);
  assert.equal(isHealthyDigNode(42), false);
});

test("ReachabilityMemo caches a verdict for the TTL then goes stale", () => {
  const memo = new ReachabilityMemo(PROBE_TTL_MS);
  const url = "http://dig.local";
  // No verdict yet.
  assert.equal(memo.get(url, 1000), null);
  memo.put(url, true, 1000);
  // Fresh within the TTL.
  assert.equal(memo.get(url, 1000), true);
  assert.equal(memo.get(url, 1000 + PROBE_TTL_MS - 1), true);
  // Stale exactly at/after the TTL → null (caller re-probes).
  assert.equal(memo.get(url, 1000 + PROBE_TTL_MS), null);
  // A negative verdict is cached the same way (don't hammer a down node).
  memo.put(url, false, 5000);
  assert.equal(memo.get(url, 5000), false);
  assert.equal(memo.get(url, 5000 + PROBE_TTL_MS), null);
});

test("resolveSourcePlan: unknown candidates become probe steps, in-process is terminal", () => {
  const candidates = localNodeCandidates();
  const memo = new ReachabilityMemo();
  const { plan } = resolveSourcePlan({ candidates, memo, now: 0 });
  assert.deepEqual(plan, [
    { kind: "probe", baseUrl: "http://dig.local" },
    { kind: "probe", baseUrl: "http://localhost:8080" },
    { kind: "in-process" },
  ]);
  // The plan ALWAYS ends with in-process (standalone browser with no local node
  // still resolves every request).
  assert.equal(plan[plan.length - 1].kind, "in-process");
});

test("resolveSourcePlan: a fresh-reachable candidate is used directly (no re-probe)", () => {
  const candidates = localNodeCandidates();
  const memo = new ReachabilityMemo();
  memo.put("http://dig.local", true, 100);
  const { plan } = resolveSourcePlan({ candidates, memo, now: 100 });
  assert.equal(plan[0].kind, "local");
  assert.equal(plan[0].baseUrl, "http://dig.local");
});

test("resolveSourcePlan: a fresh-unreachable candidate is skipped without a probe", () => {
  const candidates = localNodeCandidates();
  const memo = new ReachabilityMemo();
  memo.put("http://dig.local", false, 100); // known down, still fresh
  const { plan } = resolveSourcePlan({ candidates, memo, now: 100 });
  // dig.local is skipped; localhost has no verdict so it is a probe step.
  assert.deepEqual(plan, [
    { kind: "probe", baseUrl: "http://localhost:8080" },
    { kind: "in-process" },
  ]);
});

test("resolveSourcePlan: disabled setting → only the in-process node", () => {
  const candidates = localNodeCandidates({ preferLocalNode: false });
  const memo = new ReachabilityMemo();
  const { plan } = resolveSourcePlan({ candidates, memo, now: 0 });
  assert.deepEqual(plan, [{ kind: "in-process" }]);
});

test("stable source posture names for the controller/agent surface", () => {
  assert.equal(SOURCE_LOCAL_NODE, "local-node");
  assert.equal(SOURCE_IN_PROCESS, "in-process");
});
