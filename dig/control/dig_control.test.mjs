// Test harness for the DIG Browser CONTROL PANE policy (dig/control/dig_control.mjs).
//
// dig://control is the full-page Control Pane opened from the dedicated toolbar
// button (next to Wallet + Shields). It is the browser-as-CONTROLLER surface:
// when a LOCAL dig-node is present it shows the node-MANAGEMENT UI (driven by the
// control.* admin RPCs); when none is present it shows an INSTALL landing that
// nudges the user to download a standalone dig-node. Crucially, browsing/reading
// is NEVER gated on a local node — chia:// reads transparently fall back to
// rpc.dig.net behind the scenes; only the MANAGEMENT UI requires a local node.
//
// A full Chromium build is infeasible in CI, so the *pure* control-pane policy —
// the probe-base ordering, the node-detect verdict, the management-vs-install
// branch decision, and the read-fallback decision (does this address need a
// local node?) — lives in this one JS module the page re-states and this harness
// exercises directly. The control.* method/auth/error contract itself is owned by
// dig_node_controller.mjs (the Control Pane reuses that node controller); this
// module is only the PAGE POSTURE layer on top of it.
//
// Run:  node dig/control/dig_control.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_BASES,
  HEALTH_PATH,
  RPC_FALLBACK_BASE,
  PANE_MANAGE,
  PANE_INSTALL,
  detectVerdict,
  paneState,
  readFallbackPlan,
  needsLocalNode,
  INSTALL_URL,
} from "./dig_control.mjs";
import {
  CONTROL_BASES as CONTROLLER_BASES,
  isLocalDigNode,
} from "../node/dig_node_controller.mjs";

test("Control Pane probes the SAME loopback bases as the node controller", () => {
  // The Control Pane is the node controller's full-page host; it must not invent
  // its own endpoints — dig.local FIRST, then localhost:8080.
  assert.deepEqual(CONTROL_BASES, CONTROLLER_BASES);
  assert.deepEqual(CONTROL_BASES, ["http://dig.local", "http://localhost:8080"]);
  assert.equal(HEALTH_PATH, "/health", "cheap GET liveness probe");
});

test("the read fallback target is rpc.dig.net (reads never require a local node)", () => {
  assert.equal(RPC_FALLBACK_BASE, "https://rpc.dig.net");
});

test("the install landing points at the dig-installer releases (same as #95/#100)", () => {
  // Reuse the SAME install target the My Node nudge + extension use, so the nudge
  // is consistent across surfaces.
  assert.equal(INSTALL_URL, "https://github.com/DIG-Network/dig-installer/releases");
});

test("detectVerdict: a healthy local dig-node /health body → detected", () => {
  // Mirrors isLocalDigNode (status:ok AND mode:local-node) so the two can't drift.
  assert.equal(detectVerdict({ status: "ok", mode: "local-node" }), true);
  assert.equal(detectVerdict('{"status":"ok","mode":"local-node"}'), true);
  // matches the node controller's predicate exactly.
  for (const b of [
    { status: "ok", mode: "local-node" },
    { status: "ok", mode: "blind-proxy" },
    { status: "degraded", mode: "local-node" },
    "not json",
    null,
    7,
  ]) {
    assert.equal(detectVerdict(b), isLocalDigNode(b),
                 `verdict for ${JSON.stringify(b)} matches the controller`);
  }
});

test("paneState: NO node → INSTALL landing (honest: never fake node status)", () => {
  const s = paneState({ nodeDetected: false });
  assert.equal(s.pane, PANE_INSTALL);
  assert.equal(s.canManage, false);
  // The pane must make clear browsing still works without a node.
  assert.equal(s.browsingWorks, true);
});

test("paneState: node present → MANAGEMENT UI (canManage true)", () => {
  const s = paneState({ nodeDetected: true });
  assert.equal(s.pane, PANE_MANAGE);
  assert.equal(s.canManage, true);
  assert.equal(s.browsingWorks, true, "browsing always works regardless");
});

test("paneState: defaults to the INSTALL landing until the probe answers", () => {
  // No args / undefined verdict → the safe, honest default (don't show controls
  // we can't back). Same posture the page boots into before detectNode resolves.
  assert.equal(paneState().pane, PANE_INSTALL);
  assert.equal(paneState({}).pane, PANE_INSTALL);
  assert.equal(paneState({ nodeDetected: undefined }).pane, PANE_INSTALL);
});

test("needsLocalNode: only MANAGEMENT operations require a local node; reads don't", () => {
  // A control.* management call requires a local node.
  assert.equal(needsLocalNode("control.status"), true);
  assert.equal(needsLocalNode("control.cache.clear"), true);
  assert.equal(needsLocalNode("control.hostedStores.pin"), true);
  // A plain content read does NOT — it falls back to rpc.dig.net.
  assert.equal(needsLocalNode("dig.getContent"), false);
  assert.equal(needsLocalNode("dig.resolve"), false);
});

test("readFallbackPlan: with a local node, read locally; else read via rpc.dig.net", () => {
  // Detected local node → prefer it for reads, with rpc.dig.net still the terminal
  // fallback (matches the source-resolution policy: local first, network last).
  const withNode = readFallbackPlan({ nodeDetected: true });
  assert.equal(withNode[0].kind, "local");
  assert.equal(withNode[0].baseUrl, "http://dig.local");
  assert.equal(withNode[withNode.length - 1].kind, "rpc");
  assert.equal(withNode[withNode.length - 1].baseUrl, RPC_FALLBACK_BASE);

  // No local node → reads transparently go to rpc.dig.net (the management UI is
  // hidden, but browsing is unaffected — the whole point of the honest landing).
  const noNode = readFallbackPlan({ nodeDetected: false });
  assert.deepEqual(noNode, [{ kind: "rpc", baseUrl: RPC_FALLBACK_BASE }]);
});

test("readFallbackPlan: ALWAYS ends with rpc.dig.net (reads never dead-end)", () => {
  for (const detected of [true, false]) {
    const plan = readFallbackPlan({ nodeDetected: detected });
    assert.equal(plan[plan.length - 1].kind, "rpc",
                 `detected=${detected} ends at the network fallback`);
  }
});
