// Agent-surface + no-drift guard for the chia://node "My Node" controller page
// (dig/node/dig_node.html).
//
// A full Chromium build is infeasible in CI, so this test does two things on the
// shipped HTML source (the same file build.py embeds into the binary):
//   1. extracts the PURE controller functions restated in the page's <script>
//      and asserts they behave identically to dig/node/dig_node_controller.mjs —
//      the page is a self-contained embeddable resource so it can't `import` the
//      module, and this guarantees the two copies never drift; and
//   2. asserts the agent-driveable affordances are present (stable data-testid on
//      every primary control/input/nav, ARIA landmarks, the document-level
//      data-dig-node posture attribute, and the {{DIG_CONTROL_TOKEN}} injection
//      placeholder the loader fills browser-side).
//
// Run:  node dig/node/dig_node.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as mod from "./dig_node_controller.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "dig_node.html"), "utf8");

// Pull a single named function (incl. body) out of the page's <script> by
// brace-balancing from its first '{'.
function extractFn(name) {
  const start = html.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in dig_node.html`);
  const open = html.indexOf("{", start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

// Rebuild a module from the page's restated helpers + the constants they close
// over (lifted verbatim from the page so the test exercises the SHIPPED code).
const constsSrc = `
  var CONTROL_TOKEN_HEADER = 'X-Dig-Control-Token';
  var CONTROL_TOKEN_PARAM = '_control_token';
  var CONTROL_ERR = {UNAUTHORIZED:-32020, NOT_SUPPORTED:-32021, CONTROL_ERROR:-32022};
  var _rpcId = 0;
`;
const src =
  constsSrc + "\n" +
  extractFn("buildControlRequest") + "\n" +
  extractFn("controlHeaders") + "\n" +
  extractFn("isLocalDigNode") + "\n" +
  extractFn("classifyControlResponse") + "\n" +
  extractFn("nodeSurfaceState") + "\n" +
  "export {buildControlRequest, controlHeaders, isLocalDigNode, " +
  "classifyControlResponse, nodeSurfaceState};";
const page = await import("data:text/javascript," + encodeURIComponent(src));

// ---- 1. the page's pure functions match the module contract ----------------

test("page buildControlRequest matches the module (shape + token in params)", () => {
  const a = page.buildControlRequest("control.status", {}, "tok");
  const b = mod.buildControlRequest("control.status", {}, "tok");
  assert.equal(a.method, b.method);
  assert.equal(a.jsonrpc, "2.0");
  assert.equal(a.params._control_token, "tok");
  assert.throws(() => page.buildControlRequest("dig.getContent", {}, "t"), TypeError);
});

test("page controlHeaders matches the module", () => {
  assert.deepEqual(page.controlHeaders("tok"), mod.controlHeaders("tok"));
  assert.deepEqual(page.controlHeaders(null), mod.controlHeaders(null));
  assert.deepEqual(page.controlHeaders("tok"),
                   { "Content-Type": "application/json", "X-Dig-Control-Token": "tok" });
});

test("page isLocalDigNode matches the module (status:ok + mode:local-node)", () => {
  for (const b of [
    { status: "ok", mode: "local-node" },
    { status: "ok", mode: "blind-proxy" },
    { status: "degraded", mode: "local-node" },
    "not json", null, 7,
  ]) {
    assert.equal(page.isLocalDigNode(b), mod.isLocalDigNode(b), `verdict for ${JSON.stringify(b)}`);
  }
  assert.equal(page.isLocalDigNode({ status: "ok", mode: "local-node" }), true);
});

test("page classifyControlResponse maps the catalogued error codes like the module", () => {
  for (const r of [
    { result: { running: true } },
    { error: { code: -32020, message: "x", data: { code: "UNAUTHORIZED" } } },
    { error: { code: -32021, message: "x" } },
    { error: { code: -32022, message: "x" } },
    { error: { code: -32601, message: "x" } },
    "not json", null,
  ]) {
    assert.equal(page.classifyControlResponse(r).kind, mod.classifyControlResponse(r).kind,
                 `kind for ${JSON.stringify(r)}`);
  }
  assert.equal(page.classifyControlResponse({ error: { code: -32020, message: "x" } }).kind,
               "unauthorized");
});

test("page nodeSurfaceState matches the module (no-node / needs-token / ready)", () => {
  for (const a of [
    { nodeDetected: false, hasToken: false },
    { nodeDetected: false, hasToken: true },
    { nodeDetected: true, hasToken: false },
    { nodeDetected: true, hasToken: true },
  ]) {
    assert.deepEqual(page.nodeSurfaceState(a), mod.nodeSurfaceState(a), JSON.stringify(a));
  }
});

// ---- 2. agent / driveability affordances on the HTML -----------------------

test("page: basic HTML structure", () => {
  assert.match(html, /^<!doctype html>/i, "has doctype");
  assert.match(html, /<html lang="en">/, "html has lang");
  assert.equal((html.match(/<body/g) || []).length, 1, "one <body>");
  assert.equal((html.match(/<\/body>/g) || []).length, 1, "one </body>");
  assert.equal((html.match(/<\/html>/g) || []).length, 1, "one </html>");
});

test("page: the three posture surfaces + status pill carry stable testids", () => {
  assert.match(html, /data-testid="node-status-pill"/);
  assert.match(html, /data-testid="node-empty"/, "no-node state");
  assert.match(html, /data-testid="node-needs-token"/, "needs-token state");
  assert.match(html, /data-testid="node-ready"/, "ready state");
});

test("page: every primary control/input carries a stable testid", () => {
  for (const t of [
    "node-recheck", "node-install-link",
    "node-token-input", "node-token-apply",
    "node-stats", "node-status-raw-toggle",
    "node-pin-input", "node-pin", "node-stores-refresh", "node-stores-list",
    "node-cache-stats", "node-cap-input", "node-cap-apply", "node-cache-clear",
    "node-sync-stats", "node-upstream-input", "node-upstream-apply", "node-op-note",
  ]) {
    assert.match(html, new RegExp(`data-testid="${t}"`), `data-testid=${t}`);
  }
});

test("page: ARIA landmarks + live regions exist", () => {
  assert.match(html, /\baria-label=/, "labelled sections");
  assert.match(html, /\baria-live="polite"/, "live status region");
  assert.match(html, /role="status"/, "status role");
  assert.match(html, /aria-expanded=/, "disclosure has aria-expanded");
});

test("page: exposes the node posture as a document data-* attribute for agents", () => {
  assert.match(html, /data-dig-node/, "writes data-dig-node posture");
});

test("page: carries the browser-filled control-token injection placeholder", () => {
  // The loader replaces {{DIG_CONTROL_TOKEN}} with the token it reads from the
  // node config dir; the literal placeholder must remain in the source.
  assert.match(html, /\{\{DIG_CONTROL_TOKEN\}\}/, "control-token placeholder preserved");
});

test("page: progressive disclosure — plain language by default, capsule/storeId on demand", () => {
  // capsule term is explained (capsule = storeId:rootHash) for the deeper layer.
  assert.match(html, /storeId:rootHash/, "explains capsule id");
  // raw control.status JSON is behind a disclosure, not shown by default.
  assert.match(html, /Raw control\.status/);
});

test("page: hosted-only features are labeled 'On DIGHub' outbound cards, not faked", () => {
  assert.match(html, /On DIGHub/);
  assert.match(html, /data-testid="node-hub-handles"/);
  assert.match(html, /data-testid="node-hub-discover"/);
});

test("page: does NOT implement local publish/deploy (deferred to Pass D)", () => {
  // Guardrail: the My Node controller surface must not grow a deploy/publish
  // flow here — that is a separate pass. Catch an accidental add.
  assert.doesNotMatch(html, /data-testid="node-deploy"/, "no deploy CTA");
  assert.doesNotMatch(html, /chia:\/\/node\/deploy/, "no deploy route wired");
});
