// Test harness for the My Node controller policy (dig/node/dig_node_controller.mjs).
//
// A full Chromium build is infeasible in CI, so the *pure* controller policy the
// chia://node surface drives — the control endpoints + canonical method names,
// building an authorized control.* request, parsing /health + /openrpc.json, the
// catalogued error-code mapping, and the surface enabled/disabled decision —
// lives in one JS module this harness exercises directly. The dig_node.html page
// re-states the same functions; dig_node.test.mjs guards that copy against this
// contract so the two can never drift.
//
// Run:  node dig/node/dig_node_controller.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIG_LOCAL_BASE,
  LOCALHOST_BASE,
  CONTROL_BASES,
  HEALTH_PATH,
  OPENRPC_PATH,
  RPC_PATH,
  CONTROL_TOKEN_HEADER,
  CONTROL_TOKEN_PARAM,
  CONTROL_TOKEN_FILE,
  CONTROL_METHODS,
  CONTROL_ERR,
  buildControlRequest,
  controlHeaders,
  isLocalDigNode,
  classifyControlResponse,
  nodeSurfaceState,
  controlAuthFromOpenRpc,
} from "./dig_node_controller.mjs";

test("control endpoints: dig.local FIRST, then localhost:8080; cheap GET probes", () => {
  assert.deepEqual(CONTROL_BASES, [DIG_LOCAL_BASE, LOCALHOST_BASE]);
  assert.equal(DIG_LOCAL_BASE, "http://dig.local", "dig.local has NO port, tried first");
  assert.equal(LOCALHOST_BASE, "http://localhost:8080", "default localhost listener");
  assert.equal(HEALTH_PATH, "/health");
  assert.equal(OPENRPC_PATH, "/openrpc.json");
  assert.equal(RPC_PATH, "/");
});

test("control auth scheme matches the dig-node contract (header/param/file)", () => {
  assert.equal(CONTROL_TOKEN_HEADER, "X-Dig-Control-Token");
  assert.equal(CONTROL_TOKEN_PARAM, "_control_token");
  assert.equal(CONTROL_TOKEN_FILE, "control-token");
});

test("canonical control.* method names match the node surface (12 methods)", () => {
  assert.deepEqual(CONTROL_METHODS, {
    status: "control.status",
    configGet: "control.config.get",
    configSetUpstream: "control.config.setUpstream",
    cacheGet: "control.cache.get",
    cacheSetCap: "control.cache.setCap",
    cacheClear: "control.cache.clear",
    hostedStoresList: "control.hostedStores.list",
    hostedStoresPin: "control.hostedStores.pin",
    hostedStoresUnpin: "control.hostedStores.unpin",
    hostedStoresStatus: "control.hostedStores.status",
    syncStatus: "control.sync.status",
    syncTrigger: "control.sync.trigger",
  });
  // every value is a control.*-prefixed string.
  for (const m of Object.values(CONTROL_METHODS)) {
    assert.ok(m.startsWith("control."), `${m} is a control.* method`);
  }
});

test("catalogued control error codes match the dig-node contract", () => {
  assert.equal(CONTROL_ERR.UNAUTHORIZED, -32020);
  assert.equal(CONTROL_ERR.NOT_SUPPORTED, -32021);
  assert.equal(CONTROL_ERR.CONTROL_ERROR, -32022);
});

test("buildControlRequest: well-formed JSON-RPC with the token in params", () => {
  const req = buildControlRequest(CONTROL_METHODS.status, {}, "ab".repeat(32));
  assert.equal(req.jsonrpc, "2.0");
  assert.equal(req.method, "control.status");
  assert.equal(typeof req.id, "number");
  assert.equal(req.params[CONTROL_TOKEN_PARAM], "ab".repeat(32));
});

test("buildControlRequest: merges params without mutating the caller's object", () => {
  const params = { store: "f".repeat(64) };
  const req = buildControlRequest(CONTROL_METHODS.hostedStoresPin, params, "tok");
  assert.equal(req.params.store, "f".repeat(64));
  assert.equal(req.params._control_token, "tok");
  assert.deepEqual(params, { store: "f".repeat(64) }, "caller params untouched");
});

test("buildControlRequest: no token → no _control_token (node answers UNAUTHORIZED)", () => {
  const req = buildControlRequest(CONTROL_METHODS.status, {}, null);
  assert.ok(!(CONTROL_TOKEN_PARAM in req.params), "no token param when unknown");
});

test("buildControlRequest: rejects a non-control method", () => {
  assert.throws(() => buildControlRequest("dig.getContent", {}, "t"), TypeError);
  assert.throws(() => buildControlRequest("cache.clear", {}, "t"), TypeError);
});

test("controlHeaders: sets the token header only when a token exists", () => {
  assert.deepEqual(controlHeaders("tok"), {
    "Content-Type": "application/json",
    "X-Dig-Control-Token": "tok",
  });
  assert.deepEqual(controlHeaders(null), { "Content-Type": "application/json" });
  assert.deepEqual(controlHeaders(""), { "Content-Type": "application/json" });
});

test("isLocalDigNode requires status:ok AND mode:local-node", () => {
  assert.equal(isLocalDigNode({ status: "ok", mode: "local-node" }), true);
  assert.equal(isLocalDigNode('{"status":"ok","mode":"local-node","version":"1"}'), true);
  assert.equal(isLocalDigNode({ status: "ok", mode: "blind-proxy" }), false);
  assert.equal(isLocalDigNode({ status: "degraded", mode: "local-node" }), false);
  assert.equal(isLocalDigNode("not json"), false);
  assert.equal(isLocalDigNode(null), false);
  assert.equal(isLocalDigNode(undefined), false);
  assert.equal(isLocalDigNode(7), false);
});

test("classifyControlResponse: ok lifts the result", () => {
  const c = classifyControlResponse({ jsonrpc: "2.0", id: 1, result: { running: true } });
  assert.equal(c.kind, "ok");
  assert.deepEqual(c.result, { running: true });
});

test("classifyControlResponse: maps each catalogued error code to its kind", () => {
  const unauth = classifyControlResponse({
    error: { code: -32020, message: "control token required",
             data: { code: "UNAUTHORIZED", origin: "shell" } },
  });
  assert.equal(unauth.kind, "unauthorized");
  assert.equal(unauth.code, -32020);
  assert.equal(unauth.dataCode, "UNAUTHORIZED");

  assert.equal(classifyControlResponse({ error: { code: -32021, message: "x" } }).kind,
               "not-supported");
  assert.equal(classifyControlResponse({ error: { code: -32022, message: "x" } }).kind,
               "control-error");
  // any other JSON-RPC error → generic 'error'.
  assert.equal(classifyControlResponse({ error: { code: -32601, message: "no method" } }).kind,
               "error");
});

test("classifyControlResponse: accepts a JSON string body; malformed → error", () => {
  assert.equal(classifyControlResponse('{"result":{"ok":1}}').kind, "ok");
  assert.equal(classifyControlResponse("not json").kind, "error");
  assert.equal(classifyControlResponse(null).kind, "error");
});

test("nodeSurfaceState: hidden with no node, needs-token, then ready", () => {
  assert.deepEqual(nodeSurfaceState({ nodeDetected: false, hasToken: false }),
                   { state: "no-node", canControl: false });
  assert.deepEqual(nodeSurfaceState({ nodeDetected: false, hasToken: true }),
                   { state: "no-node", canControl: false }, "no node trumps token");
  assert.deepEqual(nodeSurfaceState({ nodeDetected: true, hasToken: false }),
                   { state: "needs-token", canControl: false });
  assert.deepEqual(nodeSurfaceState({ nodeDetected: true, hasToken: true }),
                   { state: "ready", canControl: true });
});

test("controlAuthFromOpenRpc: reads info.x-control-auth, falls back to defaults", () => {
  const doc = {
    openrpc: "1.2.6",
    info: {
      title: "dig-node JSON-RPC",
      "x-control-auth": {
        scheme: "local-token",
        header: "X-Dig-Control-Token",
        param: "_control_token",
        token_file: "/home/u/DigNode/control-token",
        applies_to: "control.*",
      },
    },
  };
  const a = controlAuthFromOpenRpc(doc);
  assert.equal(a.scheme, "local-token");
  assert.equal(a.header, "X-Dig-Control-Token");
  assert.equal(a.param, "_control_token");
  assert.equal(a.tokenFile, "/home/u/DigNode/control-token");
  // accepts a JSON string.
  assert.equal(controlAuthFromOpenRpc(JSON.stringify(doc)).header, "X-Dig-Control-Token");
  // absent descriptor → this module's defaults (older node still works).
  const d = controlAuthFromOpenRpc({ openrpc: "1.2.6", info: { title: "x" } });
  assert.equal(d.header, CONTROL_TOKEN_HEADER);
  assert.equal(d.param, CONTROL_TOKEN_PARAM);
  assert.equal(d.tokenFile, CONTROL_TOKEN_FILE);
  assert.equal(controlAuthFromOpenRpc("not json").scheme, "local-token");
});
