// DIG Browser "My Node" local PUBLISH / DEPLOY flow — the browser-as-local-hub
// centrepiece (#95 Pass D). This is the LOCAL, in-process equivalent of the
// digstore CLI `deploy` / the hub StagingView: launch a brand-new site (MINT a
// store) or publish an update (ADVANCE a store) entirely on this device, signed
// by the in-process DIG wallet — no hub spend service.
//
// SERVE/CONSUME split (SYSTEM.md → "Roles — serving vs consuming"): publishing
// is the SUPPLY side, so it runs through the node the browser controls. The flow
// has two distinct transports, both already present (this module adds NO new
// transport — additive policy only):
//
//   1. STAGE / COMPILE a folder → capsule `.module`  ──  `dig.stage`
//      Served by the dig-node `handle_rpc` dispatch (digstore crates/dig-node),
//      which backs BOTH the in-process FFI (`dig::CallDigRpc`) AND a standalone
//      dig-node's loopback JSON-RPC at POST "/". The My Node page already POSTs
//      `control.*` to that loopback base, so it reaches `dig.stage` the same way.
//      Request : { dir, store_id?, salt?, metadata? }
//      Result  : { capsule, store_id, root, module_path, size, content_address,
//                  files, ephemeral }
//      Errors  : -32602 invalid params · -32011 dir-not-a-dir · -32012 no files
//                · -32013 over the store size cap · -32014 compile/IO failure.
//
//   2. SIGN the on-chain spend  ──  the in-process wallet via `window.chia`
//      `chia_mintStore`   { label?, description?, digAmount?, fee? }
//                         → { storeId, launcherId, coinId, digPaid, status, … }
//      `chia_advanceStore`{ storeId, newRoot, label?, description?, digAmount?,
//                           fee?, writerSeed? }
//                         → { storeId, newCoinId, newRoot, digPaid, status, … }
//      Broadcast is GATED: `status:"broadcast"` = pushed to mainnet (real $DIG
//      spent); `status:"signed"` = built+signed but NOT pushed (the wallet runs
//      without DIG_WALLET_ALLOW_BROADCAST=1). There is no separate boolean — the
//      `status` string is the contract.
//
//   3. ANCHOR (watch) + §21 PUSH so others can read the new capsule. The wallet
//      pushes the spend bundle; anchoring is observed by re-reading the on-chain
//      root (dig.getAnchoredRoot, already in the loader), and §21 push hands the
//      compiled `.module` to a remote (default rpc.dig.net / DIGHub, or a
//      self-hosted remote) — driven by the node's control surface.
//
// This module is the SINGLE SOURCE OF TRUTH for the PURE deploy-flow policy: the
// state machine (idle → staging → staged → cost → signing → anchoring → pushing
// → done | error), the `dig.stage` request builder + result parser, the wallet
// mint/advance request builders + result parsers, the dynamic USD-pegged cost
// preview (DIG amount = target_usd ÷ live DIG price, SYSTEM.md → Core concept →
// Pricing), cost formatting, and the catalogued error-code mapping. The DOM glue
// in dig/node/dig_node.html re-states these functions (it is a self-contained
// embeddable page that can't `import`); dig_node.test.mjs guards the two copies
// against drift. Any change here must mirror BOTH and the engine contracts.
//
// Run:  node dig/node/dig_deploy_flow.test.mjs   (Node >= 18)

// ---- engine contract: dig.stage (dig-node handle_rpc) ----------------------

/** The staging/compile RPC method name, dispatched verbatim by dig-node. */
export const STAGE_METHOD = "dig.stage";

/** Catalogued dig.stage JSON-RPC error codes (digstore crates/dig-node). */
export const STAGE_ERR = Object.freeze({
  INVALID_PARAMS: -32602, // missing/empty dir, malformed store_id/salt
  NOT_A_DIR: -32011, // dir is not a readable directory
  NO_FILES: -32012, // empty folder — nothing to publish
  OVER_CAP: -32013, // over the store size cap
  COMPILE_IO: -32014, // compile / IO failure
});

// ---- engine contract: wallet store spends (window.chia) --------------------

/** The wallet store-spend methods (digstore crates/dig-wallet, Pass B). */
export const WALLET_MINT = "chia_mintStore";
export const WALLET_ADVANCE = "chia_advanceStore";

/**
 * The wallet's status string in a store-spend result:
 *   "broadcast" — the signed bundle was pushed to mainnet (real $DIG spent);
 *   "signed"    — built + signed but NOT pushed (broadcast disabled). There is
 *                 no separate boolean — this string IS the contract.
 */
export const SPEND_BROADCAST = "broadcast";
export const SPEND_SIGNED = "signed";

// Protocol default DIG amount (base units; DIG has 3 decimals → 100_000 = 100
// DIG). The wallet uses this when `digAmount` is omitted; we always send an
// explicit, dynamically-priced amount so the cost preview matches what is spent.
export const DEFAULT_DIG_BASE_UNITS = 100000;
export const DIG_DECIMALS = 3;

// ---- catalogued deploy-flow error codes ------------------------------------
//
// Browser surface → DIG_ERR_* prefix, aligned with the chia:// loader taxonomy
// (windows-dig-browser-ux.patch dig_err::k*) and the ecosystem catalogue
// (docs.dig.net static/error-codes.json: non-fast-forward, insufficient-funds,
// update-failed/Anchoring timed out, WALLET_DECLINED, DIG_INSUFFICIENT). Stable
// so the UI + an agent can branch on the code without scraping prose.
export const DEPLOY_ERR = Object.freeze({
  // staging
  STAGE_INVALID: "DIG_ERR_STAGE_INVALID", // bad dir / params (-32602)
  STAGE_NOT_A_DIR: "DIG_ERR_STAGE_NOT_A_DIR", // -32011
  STAGE_EMPTY: "DIG_ERR_STAGE_EMPTY", // empty folder (-32012)
  STAGE_OVER_CAP: "DIG_ERR_STAGE_OVER_CAP", // over the size cap (-32013)
  STAGE_COMPILE: "DIG_ERR_STAGE_COMPILE", // compile/IO failure (-32014)
  // signing
  INSUFFICIENT_DIG: "DIG_ERR_INSUFFICIENT_DIG", // not enough $DIG for the capsule
  NOT_FAST_FORWARD: "DIG_ERR_NOT_FAST_FORWARD", // remote root advanced past yours
  WALLET_DECLINED: "DIG_ERR_WALLET_DECLINED", // user rejected the signature
  WALLET_UNAUTHORIZED: "DIG_ERR_WALLET_UNAUTHORIZED", // origin/session can't sign
  BROADCAST_DISABLED: "DIG_ERR_BROADCAST_DISABLED", // signed but not pushed
  // anchor / push
  ANCHOR_TIMEOUT: "DIG_ERR_ANCHOR_TIMEOUT", // on-chain confirmation timed out
  PUSH_FAILED: "DIG_ERR_PUSH_FAILED", // §21 push to the remote failed
  // transport
  WALLET_UNREACHABLE: "DIG_ERR_WALLET_UNREACHABLE", // wallet bridge down
  NODE_UNREACHABLE: "DIG_ERR_NODE_UNREACHABLE", // staging node unreachable
  UNKNOWN: "DIG_ERR_UNKNOWN",
});

// ---- the deploy mode + the state machine -----------------------------------

/** The two local publish flows. NEW mints a store; UPDATE advances one. */
export const DEPLOY_MODE = Object.freeze({ NEW: "new", UPDATE: "update" });

/**
 * The ordered, linear deploy states. Progress is forward-only on success; any
 * step can transition to `error` (carrying a DEPLOY_ERR code). `done` carries
 * the result {capsule, urn, hubUrl?}. These are the canonical posture strings
 * the page writes to `data-dig-deploy` so an agent can read progress.
 */
export const DEPLOY_STATE = Object.freeze({
  IDLE: "idle", // before a folder is chosen
  STAGING: "staging", // dig.stage running (compile)
  STAGED: "staged", // capsule compiled; cost preview shown
  SIGNING: "signing", // wallet mint/advance in flight
  ANCHORING: "anchoring", // watching the on-chain root confirm
  PUSHING: "pushing", // §21 push of the compiled module to a remote
  DONE: "done", // published — result available
  ERROR: "error", // failed — code + message available
});

// The forward-only happy path. nextState() walks it; a step may also fail to
// ERROR. Used to keep the page's progress UI and any agent driver in lockstep.
const HAPPY_PATH = [
  DEPLOY_STATE.IDLE,
  DEPLOY_STATE.STAGING,
  DEPLOY_STATE.STAGED,
  DEPLOY_STATE.SIGNING,
  DEPLOY_STATE.ANCHORING,
  DEPLOY_STATE.PUSHING,
  DEPLOY_STATE.DONE,
];

/**
 * The next state on success from a given state (the forward-only happy path).
 * Terminal states (`done`, `error`) return themselves.
 *
 * @param {string} state a DEPLOY_STATE value.
 * @returns {string} the next DEPLOY_STATE on success.
 */
export function nextState(state) {
  if (state === DEPLOY_STATE.DONE || state === DEPLOY_STATE.ERROR) return state;
  const i = HAPPY_PATH.indexOf(state);
  if (i === -1 || i === HAPPY_PATH.length - 1) return state;
  return HAPPY_PATH[i + 1];
}

/**
 * Is `state` a terminal state (no further automatic progress)?
 * @param {string} state
 * @returns {boolean}
 */
export function isTerminal(state) {
  return state === DEPLOY_STATE.DONE || state === DEPLOY_STATE.ERROR;
}

// ---- dig.stage request + result --------------------------------------------

/**
 * Build the `dig.stage` JSON-RPC request that compiles a folder into a capsule
 * `.module`. For a NEW store, omit `store_id` (the node returns an ephemeral,
 * content-derived preview id, `ephemeral:true`). For an UPDATE, pass the
 * existing `store_id` so the staged root is computed for that store. A `salt`
 * (64-hex) marks a PRIVATE store; `metadata` (a dighub manifest object) is
 * embedded in the module.
 *
 * @param {object} args
 * @param {string} args.dir absolute folder path to publish (required).
 * @param {string} [args.storeId] existing store id to update (UPDATE only).
 * @param {string} [args.salt] 64-hex secret salt → a private store.
 * @param {object} [args.metadata] dighub manifest object to embed.
 * @param {number} [args.id] JSON-RPC id (default 1).
 * @returns {{jsonrpc:"2.0", id:number, method:string, params:object}}
 */
export function buildStageRequest(args = {}) {
  const dir = args.dir;
  if (typeof dir !== "string" || !dir.trim()) {
    throw new TypeError("buildStageRequest: a non-empty `dir` is required");
  }
  const params = { dir };
  if (args.storeId) params.store_id = args.storeId;
  if (args.salt) params.salt = args.salt;
  if (args.metadata && typeof args.metadata === "object") {
    params.metadata = args.metadata;
  }
  return {
    jsonrpc: "2.0",
    id: Number.isInteger(args.id) ? args.id : 1,
    method: STAGE_METHOD,
    params,
  };
}

/**
 * Parse a `dig.stage` JSON-RPC response into a stable result OR a classified
 * error. On success returns the compiled-capsule facts the cost preview + the
 * sign step need; on a JSON-RPC error maps the catalogued stage code to a
 * DEPLOY_ERR code.
 *
 * @param {object|string} response the dig.stage JSON-RPC response.
 * @returns {{ok:true, capsule:string, storeId:string, root:string,
 *            modulePath:string, size:number, contentAddress:string,
 *            files:number, ephemeral:boolean}
 *          | {ok:false, code:string, message:string}}
 */
export function parseStageResult(response) {
  let v = response;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) {
      return { ok: false, code: DEPLOY_ERR.STAGE_COMPILE, message: "Malformed response from the node." };
    }
  }
  if (!v || typeof v !== "object") {
    return { ok: false, code: DEPLOY_ERR.NODE_UNREACHABLE, message: "No response from the node." };
  }
  if (v.error && typeof v.error === "object") {
    return { ok: false, code: stageErrToDeployErr(v.error.code), message: v.error.message || "Staging failed." };
  }
  const r = v.result || {};
  if (!r.capsule || !r.store_id || !r.root) {
    return { ok: false, code: DEPLOY_ERR.STAGE_COMPILE, message: "The node returned an incomplete staging result." };
  }
  return {
    ok: true,
    capsule: r.capsule,
    storeId: r.store_id,
    root: r.root,
    modulePath: r.module_path || "",
    size: Number(r.size) || 0,
    contentAddress: r.content_address || `dig://${r.store_id}:${r.root}/`,
    files: Number(r.files) || 0,
    ephemeral: !!r.ephemeral,
  };
}

/**
 * Map a `dig.stage` JSON-RPC error code to a catalogued DEPLOY_ERR code.
 * @param {number} code the JSON-RPC error code.
 * @returns {string} a DEPLOY_ERR value.
 */
export function stageErrToDeployErr(code) {
  switch (code) {
    case STAGE_ERR.INVALID_PARAMS: return DEPLOY_ERR.STAGE_INVALID;
    case STAGE_ERR.NOT_A_DIR: return DEPLOY_ERR.STAGE_NOT_A_DIR;
    case STAGE_ERR.NO_FILES: return DEPLOY_ERR.STAGE_EMPTY;
    case STAGE_ERR.OVER_CAP: return DEPLOY_ERR.STAGE_OVER_CAP;
    case STAGE_ERR.COMPILE_IO: return DEPLOY_ERR.STAGE_COMPILE;
    default: return DEPLOY_ERR.STAGE_COMPILE;
  }
}

// ---- cost preview (dynamic, USD-pegged) ------------------------------------

/**
 * The per-capsule DIG amount, in base units, for the dynamic USD-pegged price
 * (SYSTEM.md → Core concept → Pricing: dig_amount = target_usd ÷ live DIG
 * price, ≈ $1/capsule/year; uniform per fixed-size capsule). The wallet takes
 * `digAmount` as an INPUT and never fetches a price, so the page computes it and
 * sends it — making the previewed cost EXACTLY what is spent.
 *
 * When the live price is unknown (null/0/NaN), falls back to the protocol
 * default (100 DIG) so the flow still works offline — flagged via `pegged:false`
 * so the UI can say "estimated".
 *
 * @param {object} args
 * @param {number} [args.targetUsd=1] the USD target per capsule (per year).
 * @param {number} [args.digPriceUsd] the live DIG price in USD (per 1 DIG).
 * @returns {{digBaseUnits:number, dig:number, targetUsd:number,
 *            digPriceUsd:(number|null), pegged:boolean}}
 */
export function digAmountForCapsule(args = {}) {
  const targetUsd = Number.isFinite(args.targetUsd) && args.targetUsd > 0 ? args.targetUsd : 1;
  const price = Number(args.digPriceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      digBaseUnits: DEFAULT_DIG_BASE_UNITS,
      dig: DEFAULT_DIG_BASE_UNITS / 10 ** DIG_DECIMALS,
      targetUsd,
      digPriceUsd: null,
      pegged: false,
    };
  }
  const dig = targetUsd / price; // whole DIG
  const digBaseUnits = Math.max(1, Math.round(dig * 10 ** DIG_DECIMALS));
  return {
    digBaseUnits,
    dig: digBaseUnits / 10 ** DIG_DECIMALS,
    targetUsd,
    digPriceUsd: price,
    pegged: true,
  };
}

/**
 * Build a human + machine cost preview for a staged capsule, mirroring the CLI
 * `deploy --dry-run` / the hub cost card. Combines the dynamic DIG amount with
 * the staged capsule size and an (optional, caller-provided) XCH network fee.
 *
 * @param {object} args
 * @param {object} args.stage a successful {@link parseStageResult}.
 * @param {number} [args.digPriceUsd] live DIG price (per DIG) for the peg.
 * @param {number} [args.targetUsd=1] USD target per capsule.
 * @param {number} [args.feeMojos=0] the XCH network fee, in mojos.
 * @returns {{dig:number, digBaseUnits:number, digText:string, usd:(number|null),
 *            usdText:string, pegged:boolean, feeMojos:number, feeXch:number,
 *            feeText:string, sizeBytes:number, sizeText:string, files:number}}
 */
export function buildCostPreview(args = {}) {
  const stage = args.stage || {};
  const amount = digAmountForCapsule({ targetUsd: args.targetUsd, digPriceUsd: args.digPriceUsd });
  const feeMojos = Number.isFinite(args.feeMojos) && args.feeMojos > 0 ? Math.round(args.feeMojos) : 0;
  const feeXch = feeMojos / 1e12; // 1 XCH = 1e12 mojos
  const usd = amount.pegged ? amount.dig * amount.digPriceUsd : null;
  return {
    dig: amount.dig,
    digBaseUnits: amount.digBaseUnits,
    digText: formatDig(amount.dig),
    usd,
    usdText: usd == null ? "—" : formatUsd(usd),
    pegged: amount.pegged,
    feeMojos,
    feeXch,
    feeText: feeMojos ? `${formatXch(feeXch)} XCH` : "auto",
    sizeBytes: Number(stage.size) || 0,
    sizeText: formatBytes(Number(stage.size) || 0),
    files: Number(stage.files) || 0,
  };
}

/** Format a DIG amount (whole DIG) for display, e.g. "100 $DIG". */
export function formatDig(dig) {
  const n = Number(dig) || 0;
  const s = n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);
  return `${trimZeros(s)} $DIG`;
}

/** Format a USD amount, e.g. "$1.00". */
export function formatUsd(usd) {
  const n = Number(usd) || 0;
  return `$${n.toFixed(2)}`;
}

/** Format an XCH amount (already in whole XCH) compactly. */
export function formatXch(xch) {
  const n = Number(xch) || 0;
  if (n === 0) return "0";
  if (n < 1e-6) return n.toExponential(2);
  return trimZeros(n.toFixed(9));
}

/** Format a byte count with binary units (matches the controller fmtBytes). */
export function formatBytes(bytes) {
  let n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}

function trimZeros(s) {
  return String(s).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

// ---- wallet mint / advance request + result --------------------------------

/**
 * Build the `chia_mintStore` request (launch a brand-new site). The DIG amount
 * is sent explicitly (the dynamically-priced base units) so the spend matches
 * the preview; the wallet never fetches a price.
 *
 * @param {object} args
 * @param {number} args.digBaseUnits the dynamic DIG amount, base units (required).
 * @param {string} [args.label] a human label embedded in the store metadata.
 * @param {string} [args.description] a human description.
 * @param {number} [args.feeMojos] the XCH network fee, mojos (0/omitted → auto).
 * @returns {{method:string, params:object}}
 */
export function buildMintRequest(args = {}) {
  const params = {};
  if (Number.isFinite(args.digBaseUnits) && args.digBaseUnits > 0) {
    params.digAmount = Math.round(args.digBaseUnits);
  }
  if (args.label) params.label = args.label;
  if (args.description) params.description = args.description;
  if (Number.isFinite(args.feeMojos) && args.feeMojos > 0) params.fee = Math.round(args.feeMojos);
  return { method: WALLET_MINT, params };
}

/**
 * Build the `chia_advanceStore` request (publish an update). Requires the store
 * id being advanced and the new root from the freshly-staged capsule.
 *
 * @param {object} args
 * @param {string} args.storeId the store to advance (required).
 * @param {string} args.newRoot the staged capsule's root hash (required).
 * @param {number} [args.digBaseUnits] the dynamic DIG amount, base units.
 * @param {string} [args.label]
 * @param {string} [args.description]
 * @param {number} [args.feeMojos]
 * @param {string} [args.writerSeed] a 32-byte deploy-token seed → writer-authorized.
 * @returns {{method:string, params:object}}
 */
export function buildAdvanceRequest(args = {}) {
  if (!args.storeId) throw new TypeError("buildAdvanceRequest: `storeId` is required");
  if (!args.newRoot) throw new TypeError("buildAdvanceRequest: `newRoot` is required");
  const params = { storeId: args.storeId, newRoot: args.newRoot };
  if (Number.isFinite(args.digBaseUnits) && args.digBaseUnits > 0) {
    params.digAmount = Math.round(args.digBaseUnits);
  }
  if (args.label) params.label = args.label;
  if (args.description) params.description = args.description;
  if (Number.isFinite(args.feeMojos) && args.feeMojos > 0) params.fee = Math.round(args.feeMojos);
  if (args.writerSeed) params.writerSeed = args.writerSeed;
  return { method: WALLET_ADVANCE, params };
}

/**
 * Parse a wallet store-spend result (mint OR advance) into a stable shape, and
 * surface the broadcast gate: `broadcasted:false` means the bundle was signed
 * but NOT pushed (the wallet runs without DIG_WALLET_ALLOW_BROADCAST=1), which
 * the caller treats as a non-fatal warning (DIG_ERR_BROADCAST_DISABLED) — the
 * spend is ready but nothing was published yet.
 *
 * @param {object|string} result the wallet's result object (the `data` payload).
 * @returns {{ok:true, storeId:string, root:(string|undefined),
 *            coinId:(string|undefined), digPaid:(string|undefined),
 *            broadcasted:boolean}
 *          | {ok:false, code:string, message:string}}
 */
export function parseSpendResult(result) {
  let v = result;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) {
      return { ok: false, code: DEPLOY_ERR.UNKNOWN, message: "Malformed wallet response." };
    }
  }
  if (!v || typeof v !== "object") {
    return { ok: false, code: DEPLOY_ERR.WALLET_UNREACHABLE, message: "No response from the wallet." };
  }
  if (v.success === false || v.error) {
    return { ok: false, code: classifyWalletError(v), message: v.error || "The spend failed." };
  }
  return {
    ok: true,
    storeId: v.storeId || v.launcherId,
    root: v.newRoot,
    coinId: v.coinId || v.newCoinId,
    digPaid: v.digPaid,
    broadcasted: v.status === SPEND_BROADCAST,
  };
}

/**
 * Map a wallet error (a thrown provider error OR an error result body) to a
 * catalogued DEPLOY_ERR code. Branches on the provider's stable numeric `code`
 * (4001/4100/4200/4900) and on substrings of the message for the on-chain
 * conditions the wallet reports as text (insufficient DIG, non-fast-forward).
 *
 * @param {object} err a thrown {code,message} OR an error result {error,…}.
 * @returns {string} a DEPLOY_ERR value.
 */
export function classifyWalletError(err) {
  const e = err || {};
  // 1) the provider's stable numeric codes (dig_provider.js ERROR_CODES).
  if (e.code === 4001) return DEPLOY_ERR.WALLET_DECLINED; // user rejected / pending
  if (e.code === 4100) return DEPLOY_ERR.WALLET_UNAUTHORIZED; // origin/session can't sign
  if (e.code === 4200) return DEPLOY_ERR.WALLET_UNAUTHORIZED; // unsupported → can't perform
  if (e.code === 4900) return DEPLOY_ERR.WALLET_UNREACHABLE; // bridge down
  // 2) on-chain conditions the wallet reports in the message text.
  const msg = String(e.message || e.error || "").toLowerCase();
  if (/insufficient|not enough|over[_ ]?quota|over the (dig|store)/.test(msg)) {
    return DEPLOY_ERR.INSUFFICIENT_DIG;
  }
  if (/fast[- ]?forward|root has advanced|behind|stale root/.test(msg)) {
    return DEPLOY_ERR.NOT_FAST_FORWARD;
  }
  if (/declin|reject|denied/.test(msg)) return DEPLOY_ERR.WALLET_DECLINED;
  if (/broadcast/.test(msg) && /disabl/.test(msg)) return DEPLOY_ERR.BROADCAST_DISABLED;
  if (/timed? ?out|timeout/.test(msg)) return DEPLOY_ERR.ANCHOR_TIMEOUT;
  return DEPLOY_ERR.UNKNOWN;
}

// ---- result assembly -------------------------------------------------------

/**
 * Assemble the final published result from the staged capsule + the spend
 * result: the canonical capsule (storeId:rootHash), the chia:// URN to open it
 * in the browser, and an optional DIGHub URL where a hosted view lives. For a
 * NEW store the on-chain store id comes from the mint (the staged id was an
 * ephemeral preview); for an UPDATE the store id is unchanged and the root is
 * the staged root.
 *
 * @param {object} args
 * @param {string} args.mode DEPLOY_MODE.NEW | DEPLOY_MODE.UPDATE.
 * @param {object} args.stage a successful {@link parseStageResult}.
 * @param {object} args.spend a successful {@link parseSpendResult}.
 * @param {string} [args.hubBase="https://hub.dig.net"] the DIGHub base.
 * @returns {{capsule:string, storeId:string, root:string, urn:string,
 *            chiaUrl:string, hubUrl:string, broadcasted:boolean}}
 */
export function buildDeployResult(args = {}) {
  const mode = args.mode;
  const stage = args.stage || {};
  const spend = args.spend || {};
  // NEW: the real on-chain store id is the mint's launcher id; the root is 0 for
  // a freshly-minted empty store (content is published by the FIRST advance).
  // But for the browser's one-shot "launch a site" we mint THEN advance with the
  // staged root, so prefer the spend's root when present, else the staged root.
  const storeId = normalizeHex(
    mode === DEPLOY_MODE.NEW ? (spend.storeId || stage.storeId) : (stage.storeId || spend.storeId)
  );
  const root = normalizeHex(spend.root || stage.root);
  const capsule = `${storeId}:${root}`;
  const hubBase = (args.hubBase || "https://hub.dig.net").replace(/\/+$/, "");
  return {
    capsule,
    storeId,
    root,
    urn: `urn:dig:chia:${storeId}:${root}`,
    chiaUrl: `chia://${root}.${storeId}/`,
    hubUrl: `${hubBase}/store/${storeId}`,
    broadcasted: !!spend.broadcasted,
  };
}

/** Strip a leading 0x and lowercase a hex id (canonical capsule form). */
export function normalizeHex(h) {
  return String(h == null ? "" : h).replace(/^0x/i, "").toLowerCase();
}
