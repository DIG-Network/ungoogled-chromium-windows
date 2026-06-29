// Test harness for the My Node local PUBLISH/DEPLOY flow policy
// (dig/node/dig_deploy_flow.mjs).
//
// A full Chromium build is infeasible in CI, so the PURE deploy-flow policy the
// chia://node "Publish / Deploy" panel drives — the state machine, the dig.stage
// request/result, the dynamic USD-pegged cost preview + formatting, the wallet
// mint/advance request/result, the catalogued error-code mapping, and the final
// result assembly — lives in one JS module this harness exercises directly. The
// dig_node.html page re-states the same functions; dig_node.test.mjs guards that
// copy against this contract so the two can never drift.
//
// The engine contracts mirrored here are FIXED by digstore:
//   - dig.stage   (crates/dig-node handle_rpc): req {dir,store_id?,salt?,metadata?}
//     → {capsule,store_id,root,module_path,size,content_address,files,ephemeral};
//     errs -32602/-32011/-32012/-32013/-32014.
//   - chia_mintStore / chia_advanceStore (crates/dig-wallet Pass B): the spend
//     envelope {status:"broadcast"|"signed", success, spendBundle, …}.
//
// Run:  node dig/node/dig_deploy_flow.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_METHOD,
  STAGE_ERR,
  WALLET_MINT,
  WALLET_ADVANCE,
  SPEND_BROADCAST,
  SPEND_SIGNED,
  DEFAULT_DIG_BASE_UNITS,
  DEPLOY_ERR,
  DEPLOY_MODE,
  DEPLOY_STATE,
  nextState,
  isTerminal,
  buildStageRequest,
  parseStageResult,
  stageErrToDeployErr,
  digAmountForCapsule,
  buildCostPreview,
  formatDig,
  formatUsd,
  formatBytes,
  buildMintRequest,
  buildAdvanceRequest,
  parseSpendResult,
  classifyWalletError,
  buildDeployResult,
  normalizeHex,
  chiaContentUrl,
} from "./dig_deploy_flow.mjs";

// ---- engine contract constants (must match digstore) -----------------------

test("dig.stage method name + catalogued error codes match the dig-node contract", () => {
  assert.equal(STAGE_METHOD, "dig.stage");
  assert.equal(STAGE_ERR.INVALID_PARAMS, -32602);
  assert.equal(STAGE_ERR.NOT_A_DIR, -32011);
  assert.equal(STAGE_ERR.NO_FILES, -32012);
  assert.equal(STAGE_ERR.OVER_CAP, -32013);
  assert.equal(STAGE_ERR.COMPILE_IO, -32014);
});

test("wallet store-spend method names + status strings match the dig-wallet contract", () => {
  assert.equal(WALLET_MINT, "chia_mintStore");
  assert.equal(WALLET_ADVANCE, "chia_advanceStore");
  assert.equal(SPEND_BROADCAST, "broadcast");
  assert.equal(SPEND_SIGNED, "signed");
  assert.equal(DEFAULT_DIG_BASE_UNITS, 100000); // 100 DIG, 3 decimals
});

// ---- the state machine -----------------------------------------------------

test("nextState walks the forward-only happy path then rests at done", () => {
  assert.equal(nextState(DEPLOY_STATE.IDLE), DEPLOY_STATE.STAGING);
  assert.equal(nextState(DEPLOY_STATE.STAGING), DEPLOY_STATE.STAGED);
  assert.equal(nextState(DEPLOY_STATE.STAGED), DEPLOY_STATE.SIGNING);
  assert.equal(nextState(DEPLOY_STATE.SIGNING), DEPLOY_STATE.ANCHORING);
  assert.equal(nextState(DEPLOY_STATE.ANCHORING), DEPLOY_STATE.PUSHING);
  assert.equal(nextState(DEPLOY_STATE.PUSHING), DEPLOY_STATE.DONE);
  assert.equal(nextState(DEPLOY_STATE.DONE), DEPLOY_STATE.DONE, "done is terminal");
  assert.equal(nextState(DEPLOY_STATE.ERROR), DEPLOY_STATE.ERROR, "error is terminal");
});

test("isTerminal only for done/error", () => {
  assert.equal(isTerminal(DEPLOY_STATE.DONE), true);
  assert.equal(isTerminal(DEPLOY_STATE.ERROR), true);
  for (const s of [DEPLOY_STATE.IDLE, DEPLOY_STATE.STAGING, DEPLOY_STATE.STAGED,
                   DEPLOY_STATE.SIGNING, DEPLOY_STATE.ANCHORING, DEPLOY_STATE.PUSHING]) {
    assert.equal(isTerminal(s), false, `${s} is not terminal`);
  }
});

test("DEPLOY_MODE has exactly the two local flows", () => {
  assert.deepEqual(DEPLOY_MODE, { NEW: "new", UPDATE: "update" });
});

// ---- dig.stage request -----------------------------------------------------

test("buildStageRequest: NEW omits store_id (node returns an ephemeral preview id)", () => {
  const req = buildStageRequest({ dir: "C:/sites/blog" });
  assert.equal(req.jsonrpc, "2.0");
  assert.equal(req.method, "dig.stage");
  assert.equal(req.params.dir, "C:/sites/blog");
  assert.ok(!("store_id" in req.params), "no store_id for a new store");
});

test("buildStageRequest: UPDATE carries the existing store_id; salt → private; metadata embeds", () => {
  const req = buildStageRequest({
    dir: "/home/u/site", storeId: "ab".repeat(32), salt: "cd".repeat(32),
    metadata: { name: "My Site" }, id: 7,
  });
  assert.equal(req.id, 7);
  assert.equal(req.params.store_id, "ab".repeat(32));
  assert.equal(req.params.salt, "cd".repeat(32));
  assert.deepEqual(req.params.metadata, { name: "My Site" });
});

test("buildStageRequest: a missing/blank dir throws (the user must pick a folder)", () => {
  assert.throws(() => buildStageRequest({}), TypeError);
  assert.throws(() => buildStageRequest({ dir: "   " }), TypeError);
});

// ---- dig.stage result ------------------------------------------------------

const STAGE_OK = {
  jsonrpc: "2.0", id: 1,
  result: {
    capsule: "aa".repeat(32) + ":" + "bb".repeat(32),
    store_id: "aa".repeat(32),
    root: "bb".repeat(32),
    module_path: "C:/Users/u/DigNode/stage/x.dig",
    size: 104857600,
    content_address: "dig://" + "aa".repeat(32) + ":" + "bb".repeat(32) + "/",
    files: 12,
    ephemeral: true,
  },
};

test("parseStageResult: lifts the compiled-capsule facts on success", () => {
  const r = parseStageResult(STAGE_OK);
  assert.equal(r.ok, true);
  assert.equal(r.capsule, "aa".repeat(32) + ":" + "bb".repeat(32));
  assert.equal(r.storeId, "aa".repeat(32));
  assert.equal(r.root, "bb".repeat(32));
  assert.equal(r.size, 104857600);
  assert.equal(r.files, 12);
  assert.equal(r.ephemeral, true);
  assert.match(r.contentAddress, /^dig:\/\//);
});

test("parseStageResult: accepts a JSON string body", () => {
  assert.equal(parseStageResult(JSON.stringify(STAGE_OK)).ok, true);
});

test("parseStageResult: maps every catalogued stage error to a DEPLOY_ERR code", () => {
  const cases = [
    [-32602, DEPLOY_ERR.STAGE_INVALID],
    [-32011, DEPLOY_ERR.STAGE_NOT_A_DIR],
    [-32012, DEPLOY_ERR.STAGE_EMPTY],
    [-32013, DEPLOY_ERR.STAGE_OVER_CAP],
    [-32014, DEPLOY_ERR.STAGE_COMPILE],
  ];
  for (const [code, want] of cases) {
    const r = parseStageResult({ error: { code, message: "x" } });
    assert.equal(r.ok, false);
    assert.equal(r.code, want, `stage err ${code} → ${want}`);
  }
});

test("parseStageResult: malformed / empty / incomplete bodies fail safe", () => {
  assert.equal(parseStageResult("not json").ok, false);
  assert.equal(parseStageResult(null).code, DEPLOY_ERR.NODE_UNREACHABLE);
  assert.equal(parseStageResult({ result: { store_id: "x" } }).code, DEPLOY_ERR.STAGE_COMPILE);
});

test("stageErrToDeployErr: unknown codes fall back to compile/IO", () => {
  assert.equal(stageErrToDeployErr(-99999), DEPLOY_ERR.STAGE_COMPILE);
});

// ---- cost preview (dynamic, USD-pegged) ------------------------------------

test("digAmountForCapsule: pegs DIG to a USD target ÷ live price (SYSTEM.md pricing)", () => {
  // $1 target ÷ $0.05/DIG = 20 DIG = 20_000 base units (3 decimals).
  const a = digAmountForCapsule({ targetUsd: 1, digPriceUsd: 0.05 });
  assert.equal(a.pegged, true);
  assert.equal(a.dig, 20);
  assert.equal(a.digBaseUnits, 20000);
  assert.equal(a.digPriceUsd, 0.05);
});

test("digAmountForCapsule: no/zero price → protocol default (100 DIG), flagged not-pegged", () => {
  for (const p of [undefined, 0, NaN, -1, "x"]) {
    const a = digAmountForCapsule({ digPriceUsd: p });
    assert.equal(a.pegged, false, `price ${p}`);
    assert.equal(a.digBaseUnits, DEFAULT_DIG_BASE_UNITS);
    assert.equal(a.dig, 100);
    assert.equal(a.digPriceUsd, null);
  }
});

test("buildCostPreview: combines dynamic DIG, size, and an optional XCH fee", () => {
  const stage = parseStageResult(STAGE_OK);
  const c = buildCostPreview({ stage, digPriceUsd: 0.05, targetUsd: 1, feeMojos: 5_000_000 });
  assert.equal(c.dig, 20);
  assert.equal(c.digBaseUnits, 20000);
  assert.equal(c.pegged, true);
  assert.equal(c.usd, 1, "20 DIG × $0.05 = $1.00");
  assert.equal(c.usdText, "$1.00");
  assert.equal(c.feeMojos, 5_000_000);
  assert.equal(c.feeXch, 0.000005);
  assert.equal(c.sizeBytes, 104857600);
  assert.equal(c.sizeText, "100 MiB");
  assert.equal(c.files, 12);
});

test("buildCostPreview: no live price → not-pegged, usd unknown, fee 'auto'", () => {
  const stage = parseStageResult(STAGE_OK);
  const c = buildCostPreview({ stage });
  assert.equal(c.pegged, false);
  assert.equal(c.usd, null);
  assert.equal(c.usdText, "—");
  assert.equal(c.feeText, "auto");
  assert.equal(c.digBaseUnits, DEFAULT_DIG_BASE_UNITS);
});

test("formatters: DIG / USD / bytes are human-friendly", () => {
  assert.equal(formatDig(100), "100 $DIG");
  assert.equal(formatDig(20), "20 $DIG");
  assert.equal(formatDig(0.5), "0.5 $DIG");
  assert.equal(formatUsd(1), "$1.00");
  assert.equal(formatBytes(104857600), "100 MiB");
  assert.equal(formatBytes(512), "512 B");
});

// ---- wallet mint / advance request -----------------------------------------

test("buildMintRequest: sends the dynamic DIG amount + optional label/desc/fee", () => {
  const { method, params } = buildMintRequest({
    digBaseUnits: 20000, label: "My Site", description: "hello", feeMojos: 5000000,
  });
  assert.equal(method, "chia_mintStore");
  assert.equal(params.digAmount, 20000);
  assert.equal(params.label, "My Site");
  assert.equal(params.description, "hello");
  assert.equal(params.fee, 5000000);
});

test("buildMintRequest: omits digAmount when not provided (wallet uses its default)", () => {
  const { params } = buildMintRequest({});
  assert.ok(!("digAmount" in params));
  assert.ok(!("fee" in params));
});

test("buildAdvanceRequest: requires storeId + newRoot; carries writerSeed (deploy token)", () => {
  const { method, params } = buildAdvanceRequest({
    storeId: "ab".repeat(32), newRoot: "cd".repeat(32), digBaseUnits: 20000,
    writerSeed: "ef".repeat(32),
  });
  assert.equal(method, "chia_advanceStore");
  assert.equal(params.storeId, "ab".repeat(32));
  assert.equal(params.newRoot, "cd".repeat(32));
  assert.equal(params.digAmount, 20000);
  assert.equal(params.writerSeed, "ef".repeat(32));
});

test("buildAdvanceRequest: throws without storeId or newRoot", () => {
  assert.throws(() => buildAdvanceRequest({ newRoot: "x" }), TypeError);
  assert.throws(() => buildAdvanceRequest({ storeId: "x" }), TypeError);
});

// ---- wallet spend result + the broadcast gate ------------------------------

test("parseSpendResult: mint success (broadcast) lifts the on-chain ids", () => {
  const r = parseSpendResult({
    status: "broadcast", success: true,
    spendBundle: { coinSpends: 3, aggregatedSignature: "ab" },
    storeId: "0x" + "aa".repeat(32), launcherId: "0x" + "aa".repeat(32),
    coinId: "0x" + "cc".repeat(32), digPaid: "20000",
  });
  assert.equal(r.ok, true);
  assert.equal(r.broadcasted, true);
  assert.equal(r.storeId, "0x" + "aa".repeat(32));
  assert.equal(r.coinId, "0x" + "cc".repeat(32));
  assert.equal(r.digPaid, "20000");
});

test("parseSpendResult: advance success (broadcast) lifts newRoot + newCoinId", () => {
  const r = parseSpendResult({
    status: "broadcast", success: true,
    spendBundle: { coinSpends: 2, aggregatedSignature: "ab" },
    storeId: "0x" + "aa".repeat(32), newRoot: "0x" + "bb".repeat(32),
    newCoinId: "0x" + "dd".repeat(32), digPaid: "20000",
  });
  assert.equal(r.ok, true);
  assert.equal(r.broadcasted, true);
  assert.equal(r.root, "0x" + "bb".repeat(32));
  assert.equal(r.coinId, "0x" + "dd".repeat(32));
});

test("parseSpendResult: status 'signed' means signed-but-not-pushed (broadcast disabled)", () => {
  const r = parseSpendResult({
    status: "signed", success: true,
    spendBundle: { coinSpends: 3, aggregatedSignature: "ab" },
    storeId: "0x" + "aa".repeat(32),
  });
  assert.equal(r.ok, true, "the spend still succeeded (built + signed)");
  assert.equal(r.broadcasted, false, "but nothing was pushed");
});

test("parseSpendResult: an error body classifies to a DEPLOY_ERR code", () => {
  const r = parseSpendResult({ error: "not enough DIG to cover this capsule" });
  assert.equal(r.ok, false);
  assert.equal(r.code, DEPLOY_ERR.INSUFFICIENT_DIG);
});

// ---- wallet error classification -------------------------------------------

test("classifyWalletError: provider numeric codes map to DEPLOY_ERR", () => {
  assert.equal(classifyWalletError({ code: 4001 }), DEPLOY_ERR.WALLET_DECLINED);
  assert.equal(classifyWalletError({ code: 4100 }), DEPLOY_ERR.WALLET_UNAUTHORIZED);
  assert.equal(classifyWalletError({ code: 4200 }), DEPLOY_ERR.WALLET_UNAUTHORIZED);
  assert.equal(classifyWalletError({ code: 4900 }), DEPLOY_ERR.WALLET_UNREACHABLE);
});

test("classifyWalletError: on-chain conditions from the message text", () => {
  assert.equal(classifyWalletError({ message: "Not enough DIG in your wallet" }),
               DEPLOY_ERR.INSUFFICIENT_DIG);
  assert.equal(classifyWalletError({ error: "over_quota" }), DEPLOY_ERR.INSUFFICIENT_DIG);
  assert.equal(classifyWalletError({ message: "the remote root has advanced past yours" }),
               DEPLOY_ERR.NOT_FAST_FORWARD);
  assert.equal(classifyWalletError({ message: "non-fast-forward" }), DEPLOY_ERR.NOT_FAST_FORWARD);
  assert.equal(classifyWalletError({ message: "user declined the signature" }),
               DEPLOY_ERR.WALLET_DECLINED);
  assert.equal(classifyWalletError({ message: "confirmation timed out" }),
               DEPLOY_ERR.ANCHOR_TIMEOUT);
  assert.equal(classifyWalletError({ message: "something odd" }), DEPLOY_ERR.UNKNOWN);
});

test("DEPLOY_ERR has the task-required catalogued publish codes (DIG_ERR_ prefix)", () => {
  for (const k of ["INSUFFICIENT_DIG", "NOT_FAST_FORWARD", "ANCHOR_TIMEOUT",
                   "PUSH_FAILED", "BROADCAST_DISABLED"]) {
    assert.ok(k in DEPLOY_ERR, `${k} present`);
    assert.match(DEPLOY_ERR[k], /^DIG_ERR_/, `${DEPLOY_ERR[k]} uses the loader prefix`);
  }
});

// ---- final result assembly -------------------------------------------------

test("buildDeployResult: NEW uses the mint's on-chain store id, canonical capsule + URN", () => {
  const stage = parseStageResult(STAGE_OK);
  const spend = parseSpendResult({
    status: "broadcast", success: true,
    spendBundle: { coinSpends: 3, aggregatedSignature: "ab" },
    storeId: "0x" + "11".repeat(32), newRoot: "0x" + "22".repeat(32),
    coinId: "0x" + "cc".repeat(32),
  });
  const out = buildDeployResult({ mode: DEPLOY_MODE.NEW, stage, spend });
  assert.equal(out.storeId, "11".repeat(32), "0x stripped + lowercased");
  assert.equal(out.root, "22".repeat(32));
  assert.equal(out.capsule, "11".repeat(32) + ":" + "22".repeat(32));
  assert.equal(out.urn, "urn:dig:chia:" + "11".repeat(32) + ":" + "22".repeat(32));
  assert.equal(out.chiaUrl, "chia://" + "22".repeat(32) + "." + "11".repeat(32) + "/");
  assert.equal(out.hubUrl, "https://hub.dig.net/store/" + "11".repeat(32));
  assert.equal(out.broadcasted, true);
});

test("buildDeployResult: UPDATE keeps the staged store id + the staged root", () => {
  const stage = parseStageResult(STAGE_OK); // store aa…, root bb…
  const spend = parseSpendResult({
    status: "broadcast", success: true,
    spendBundle: { coinSpends: 2, aggregatedSignature: "ab" },
    storeId: "0x" + "aa".repeat(32), newRoot: "0x" + "bb".repeat(32),
  });
  const out = buildDeployResult({ mode: DEPLOY_MODE.UPDATE, stage, spend });
  assert.equal(out.storeId, "aa".repeat(32));
  assert.equal(out.root, "bb".repeat(32));
  assert.equal(out.capsule, "aa".repeat(32) + ":" + "bb".repeat(32));
});

test("normalizeHex: strips 0x and lowercases (canonical capsule form)", () => {
  assert.equal(normalizeHex("0xABCD"), "abcd");
  assert.equal(normalizeHex("ABCD"), "abcd");
  assert.equal(normalizeHex(null), "");
});

// ---- the canonical content-open address ------------------------------------

test("chiaContentUrl: derives the canonical chia://<root>.<store>/ open address", () => {
  // The user-facing content-open scheme is chia:// (SYSTEM.md → Canonical
  // terminology) — the SAME form the Done step shows — never dig://.
  assert.equal(
    chiaContentUrl("aa".repeat(32), "bb".repeat(32)),
    "chia://" + "bb".repeat(32) + "." + "aa".repeat(32) + "/"
  );
  // normalizes 0x + casing like the rest of the flow.
  assert.equal(
    chiaContentUrl("0x" + "AA".repeat(32), "0x" + "BB".repeat(32)),
    "chia://" + "bb".repeat(32) + "." + "aa".repeat(32) + "/"
  );
});

test("chiaContentUrl: a rootless store id → chia://<store>/", () => {
  assert.equal(chiaContentUrl("aa".repeat(32), ""), "chia://" + "aa".repeat(32) + "/");
});

test("the Review-step content address agrees with the Done-step chia:// address", () => {
  // Regression guard: the Publish→Review step must show the SAME chia:// open
  // address the Done step shows — not the dig:// staging fallback.
  const stage = parseStageResult(STAGE_OK); // store aa…, root bb…
  const review = chiaContentUrl(stage.storeId, stage.root);
  const spend = parseSpendResult({
    status: "broadcast", success: true,
    spendBundle: { coinSpends: 2, aggregatedSignature: "ab" },
    storeId: "0x" + "aa".repeat(32), newRoot: "0x" + "bb".repeat(32),
  });
  const done = buildDeployResult({ mode: DEPLOY_MODE.UPDATE, stage, spend });
  assert.equal(review, done.chiaUrl);
  assert.match(review, /^chia:\/\//);
});
