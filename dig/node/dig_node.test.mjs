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
import * as dep from "./dig_deploy_flow.mjs";

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

// ---- 3. the local PUBLISH / DEPLOY flow (#95 Pass D) -----------------------

// Rebuild the page's restated deploy-flow helpers from its <script> + the
// constants they close over, exactly like the controller helpers above, so the
// test exercises the SHIPPED page code (the page can't `import` the module).
const depConstsSrc = `
  var STAGE_METHOD = 'dig.stage';
  var STAGE_ERR = {INVALID_PARAMS:-32602, NOT_A_DIR:-32011, NO_FILES:-32012, OVER_CAP:-32013, COMPILE_IO:-32014};
  var WALLET_MINT = 'chia_mintStore';
  var WALLET_ADVANCE = 'chia_advanceStore';
  var SPEND_BROADCAST = 'broadcast';
  var DEFAULT_DIG_BASE_UNITS = 100000;
  var DIG_DECIMALS = 3;
  var DEPLOY_ERR = {
    STAGE_INVALID:'DIG_ERR_STAGE_INVALID', STAGE_NOT_A_DIR:'DIG_ERR_STAGE_NOT_A_DIR',
    STAGE_EMPTY:'DIG_ERR_STAGE_EMPTY', STAGE_OVER_CAP:'DIG_ERR_STAGE_OVER_CAP',
    STAGE_COMPILE:'DIG_ERR_STAGE_COMPILE',
    INSUFFICIENT_DIG:'DIG_ERR_INSUFFICIENT_DIG', NOT_FAST_FORWARD:'DIG_ERR_NOT_FAST_FORWARD',
    WALLET_DECLINED:'DIG_ERR_WALLET_DECLINED', WALLET_UNAUTHORIZED:'DIG_ERR_WALLET_UNAUTHORIZED',
    BROADCAST_DISABLED:'DIG_ERR_BROADCAST_DISABLED',
    ANCHOR_TIMEOUT:'DIG_ERR_ANCHOR_TIMEOUT', PUSH_FAILED:'DIG_ERR_PUSH_FAILED',
    WALLET_UNREACHABLE:'DIG_ERR_WALLET_UNREACHABLE', NODE_UNREACHABLE:'DIG_ERR_NODE_UNREACHABLE',
    UNKNOWN:'DIG_ERR_UNKNOWN'
  };
  var DEPLOY_MODE = {NEW:'new', UPDATE:'update'};
  var DEPLOY_STATE = {IDLE:'idle', STAGING:'staging', STAGED:'staged', SIGNING:'signing',
                      ANCHORING:'anchoring', PUSHING:'pushing', DONE:'done', ERROR:'error'};
  var HAPPY_PATH = [DEPLOY_STATE.IDLE, DEPLOY_STATE.STAGING, DEPLOY_STATE.STAGED,
                    DEPLOY_STATE.SIGNING, DEPLOY_STATE.ANCHORING, DEPLOY_STATE.PUSHING, DEPLOY_STATE.DONE];
`;
const depSrc =
  depConstsSrc + "\n" +
  extractFn("nextState") + "\n" +
  extractFn("buildStageRequest") + "\n" +
  extractFn("stageErrToDeployErr") + "\n" +
  extractFn("parseStageResult") + "\n" +
  extractFn("digAmountForCapsule") + "\n" +
  extractFn("trimZeros") + "\n" +
  extractFn("formatDig") + "\n" +
  extractFn("formatUsd") + "\n" +
  extractFn("formatXch") + "\n" +
  extractFn("fmtBytes2") + "\n" +
  extractFn("buildCostPreview") + "\n" +
  extractFn("buildMintRequest") + "\n" +
  extractFn("buildAdvanceRequest") + "\n" +
  extractFn("classifyWalletError") + "\n" +
  extractFn("parseSpendResult") + "\n" +
  extractFn("normalizeHex") + "\n" +
  extractFn("buildDeployResult") + "\n" +
  "export {nextState, buildStageRequest, stageErrToDeployErr, parseStageResult, " +
  "digAmountForCapsule, formatDig, formatUsd, buildCostPreview, buildMintRequest, " +
  "buildAdvanceRequest, classifyWalletError, parseSpendResult, normalizeHex, buildDeployResult};";
const depPage = await import("data:text/javascript," + encodeURIComponent(depSrc));

const STAGE_OK = {
  jsonrpc: "2.0", id: 1,
  result: {
    capsule: "aa".repeat(32) + ":" + "bb".repeat(32),
    store_id: "aa".repeat(32), root: "bb".repeat(32),
    module_path: "C:/x.dig", size: 104857600,
    content_address: "dig://" + "aa".repeat(32) + ":" + "bb".repeat(32) + "/",
    files: 12, ephemeral: true,
  },
};

test("page deploy: nextState walks the happy path identically to the module", () => {
  for (const s of ["idle", "staging", "staged", "signing", "anchoring", "pushing", "done", "error"]) {
    assert.equal(depPage.nextState(s), dep.nextState(s), `nextState(${s})`);
  }
});

test("page deploy: buildStageRequest matches the module (dig.stage params)", () => {
  const a = depPage.buildStageRequest({ dir: "/x", storeId: "ab".repeat(32) });
  const b = dep.buildStageRequest({ dir: "/x", storeId: "ab".repeat(32) });
  assert.deepEqual(a, b);
  assert.equal(a.method, "dig.stage");
  assert.throws(() => depPage.buildStageRequest({}), TypeError);
});

test("page deploy: parseStageResult + stageErrToDeployErr match the module", () => {
  assert.deepEqual(depPage.parseStageResult(STAGE_OK), dep.parseStageResult(STAGE_OK));
  for (const code of [-32602, -32011, -32012, -32013, -32014, -99999]) {
    assert.equal(depPage.stageErrToDeployErr(code), dep.stageErrToDeployErr(code), `code ${code}`);
  }
});

test("page deploy: dynamic cost preview matches the module (USD-pegged)", () => {
  assert.deepEqual(depPage.digAmountForCapsule({ targetUsd: 1, digPriceUsd: 0.05 }),
                   dep.digAmountForCapsule({ targetUsd: 1, digPriceUsd: 0.05 }));
  const stage = dep.parseStageResult(STAGE_OK);
  assert.deepEqual(
    depPage.buildCostPreview({ stage, digPriceUsd: 0.05, targetUsd: 1, feeMojos: 5000000 }),
    dep.buildCostPreview({ stage, digPriceUsd: 0.05, targetUsd: 1, feeMojos: 5000000 }));
  assert.equal(depPage.formatDig(100), dep.formatDig(100));
  assert.equal(depPage.formatUsd(1), dep.formatUsd(1));
});

test("page deploy: mint/advance request builders match the module", () => {
  assert.deepEqual(depPage.buildMintRequest({ digBaseUnits: 20000, label: "S" }),
                   dep.buildMintRequest({ digBaseUnits: 20000, label: "S" }));
  assert.deepEqual(
    depPage.buildAdvanceRequest({ storeId: "ab".repeat(32), newRoot: "cd".repeat(32), digBaseUnits: 20000 }),
    dep.buildAdvanceRequest({ storeId: "ab".repeat(32), newRoot: "cd".repeat(32), digBaseUnits: 20000 }));
});

test("page deploy: spend parse + error classification match the module (broadcast gate)", () => {
  const signed = { status: "signed", success: true, spendBundle: { coinSpends: 3, aggregatedSignature: "ab" }, storeId: "0x" + "aa".repeat(32) };
  assert.deepEqual(depPage.parseSpendResult(signed), dep.parseSpendResult(signed));
  assert.equal(depPage.parseSpendResult(signed).broadcasted, false, "signed = not pushed");
  for (const e of [{ code: 4001 }, { code: 4100 }, { code: 4900 },
                   { message: "not enough DIG" }, { message: "non-fast-forward" }]) {
    assert.equal(depPage.classifyWalletError(e), dep.classifyWalletError(e), JSON.stringify(e));
  }
});

test("page deploy: buildDeployResult matches the module (capsule/URN/chia://)", () => {
  const stage = dep.parseStageResult(STAGE_OK);
  const spend = dep.parseSpendResult({ status: "broadcast", success: true,
    spendBundle: { coinSpends: 3, aggregatedSignature: "ab" },
    storeId: "0x" + "11".repeat(32), newRoot: "0x" + "22".repeat(32) });
  assert.deepEqual(depPage.buildDeployResult({ mode: "new", stage, spend }),
                   dep.buildDeployResult({ mode: "new", stage, spend }));
});

test("page: the Publish panel + its flow steps carry stable testids", () => {
  for (const t of [
    "node-publish", "node-publish-setup", "node-publish-mode-new", "node-publish-mode-update",
    "node-publish-dir", "node-publish-store", "node-publish-label", "node-publish-stage",
    "node-publish-review", "node-publish-review-stats", "node-publish-cost",
    "node-publish-capsule-toggle", "node-publish-capsule", "node-publish-sign", "node-publish-cancel",
    "node-publish-progress", "node-publish-done", "node-publish-result-url",
    "node-publish-result-capsule", "node-publish-another", "node-publish-error",
    "node-publish-advanced-toggle", "node-publish-salt", "node-publish-writer", "node-publish-fee",
  ]) {
    assert.match(html, new RegExp(`data-testid="${t}"`), `data-testid=${t}`);
  }
});

test("page: Publish uses plain language with the capsule behind disclosure", () => {
  assert.match(html, /Launch a site/, "plain 'launch a site'");
  assert.match(html, /Publish an update/, "plain 'publish an update'");
  // the protocol-level capsule id is behind a 'Capsule details' expander.
  assert.match(html, /Capsule details/);
  assert.match(html, /storeId:rootHash/, "capsule defined");
});

test("page: Publish exposes the deploy state as a document data-* for agents", () => {
  assert.match(html, /data-dig-deploy/, "writes data-dig-deploy posture");
  assert.match(html, /data-dig-deploy-error/, "error code attribute");
});

test("page: Publish wires the engine contracts (dig.stage + wallet store spends)", () => {
  assert.match(html, /dig\.stage/, "stages via dig.stage");
  assert.match(html, /chia_mintStore/, "mints via chia_mintStore");
  assert.match(html, /chia_advanceStore/, "advances via chia_advanceStore");
});

test("page: Publish surfaces the task-required catalogued error codes", () => {
  for (const c of ["DIG_ERR_INSUFFICIENT_DIG", "DIG_ERR_NOT_FAST_FORWARD",
                   "DIG_ERR_ANCHOR_TIMEOUT", "DIG_ERR_PUSH_FAILED", "DIG_ERR_BROADCAST_DISABLED"]) {
    assert.match(html, new RegExp(c), c);
  }
});
