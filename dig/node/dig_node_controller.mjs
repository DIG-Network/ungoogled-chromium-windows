// DIG Browser "My Node" controller policy — the browser-as-CONTROLLER side of
// the serve/consume split (SYSTEM.md → "the browser is also the dig-node's
// CONTROLLER UI").
//
// When a LOCAL standalone dig-node is present, the browser's "My Node" surface
// (chia://node) drives the node's control.* admin RPCs — status, hosted stores
// (list/pin/unpin), cache (view/clear/setCap), §21 sync (status/trigger), and
// config (get/upstream). These control methods live BESIDE the node's read RPC,
// are loopback-only, and are gated by a local control token:
//   - the node writes a 64-hex token to <config_dir>/control-token,
//   - every control.* call must carry it in the X-Dig-Control-Token header
//     (or, equivalently, params._control_token),
//   - the contract is self-describing via GET /openrpc.json (and rpc.discover),
//     whose info.x-control-auth states the scheme/header/param/token_file.
//
// A plain CONSUMER (the extension, or the browser with no local node) uses only
// the read methods and never needs any of this — so the My Node surface is
// HIDDEN/greyed when no local node is detected. Consumption never needs a node.
//
// This module is the SINGLE SOURCE OF TRUTH for the *pure* controller policy:
// the control endpoints + the canonical method names, building an authorized
// control.* JSON-RPC request, parsing the node's /health + /openrpc.json
// discovery, mapping the catalogued control error codes, and deciding the My
// Node surface's enabled/disabled state. The DOM glue in dig/node/dig_node.html
// imports nothing (it is a self-contained embeddable page) but re-states these
// same functions; dig_node.test.mjs guards BOTH this module and the page copy
// so they cannot drift. Any change to a method name / header / port / error
// code must be made in BOTH places AND mirror the dig-node contract upstream.
//
// Contract source of truth: dig-node (dig-companion) src/{meta,server,control,
// config}.rs. Run: node dig/node/dig_node_controller.test.mjs   (Node >= 18)

// The local dig-node's control endpoints, in the SAME preference order the read
// path uses (SYSTEM.md "Source-resolution order"): the friendly installer name
// dig.local (no port — the node's privileged :80 loopback) first, then the
// always-on localhost listener (default 8080). The control.* methods are POSTed
// to "/" (JSON-RPC); /health and /openrpc.json are cheap GETs.
export const DIG_LOCAL_BASE = "http://dig.local";
export const LOCALHOST_BASE = "http://localhost:8080";
export const CONTROL_BASES = [DIG_LOCAL_BASE, LOCALHOST_BASE];

export const HEALTH_PATH = "/health";
export const OPENRPC_PATH = "/openrpc.json";
export const RPC_PATH = "/";

// The local-token auth scheme (dig-node control.rs / meta.rs x-control-auth).
export const CONTROL_TOKEN_HEADER = "X-Dig-Control-Token";
export const CONTROL_TOKEN_PARAM = "_control_token";
export const CONTROL_TOKEN_FILE = "control-token";

// The canonical control.* method names (dig-node meta.rs:157-237). These are the
// surfaces the My Node UI drives. Grouped for the UI's progressive disclosure.
export const CONTROL_METHODS = Object.freeze({
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

// The catalogued control-plane JSON-RPC error codes (dig-node meta.rs:300-302).
// UNAUTHORIZED: missing/blank/wrong control token. NOT_SUPPORTED: the operation
// is unavailable on this build (e.g. no §21 identity). CONTROL_ERROR: it failed
// at runtime. Stable so the UI can react precisely (re-auth vs explain vs show
// the message) without scraping prose.
export const CONTROL_ERR = Object.freeze({
  UNAUTHORIZED: -32020,
  NOT_SUPPORTED: -32021,
  CONTROL_ERROR: -32022,
});

let _rpcId = 0;

/**
 * Build a JSON-RPC 2.0 control.* request object, authorized with the local
 * control token. The token rides in `params._control_token` (the header is the
 * preferred channel and the caller SHOULD also set it on the fetch; the param
 * is the equivalent fallback the node accepts — control.rs). A `null`/empty
 * token still produces a well-formed request (the node answers UNAUTHORIZED),
 * so the UI surfaces a clean "needs the node's control token" state rather than
 * throwing.
 *
 * @param {string} method one of CONTROL_METHODS.* (a "control."-prefixed name).
 * @param {object} [params] method params (merged; never mutated).
 * @param {string|null} [token] the 64-hex control token, or null/"" if unknown.
 * @returns {{jsonrpc:"2.0", id:number, method:string, params:object}}
 */
export function buildControlRequest(method, params = {}, token = null) {
  if (typeof method !== "string" || !method.startsWith("control.")) {
    throw new TypeError(`not a control.* method: ${String(method)}`);
  }
  const merged = { ...(params || {}) };
  if (token) merged[CONTROL_TOKEN_PARAM] = token;
  return { jsonrpc: "2.0", id: ++_rpcId, method, params: merged };
}

/**
 * The fetch headers for a control.* POST: JSON content + the control token in
 * the X-Dig-Control-Token header (the node's preferred auth channel). Omits the
 * header entirely when there is no token (so the node replies UNAUTHORIZED).
 *
 * @param {string|null} [token]
 * @returns {Record<string,string>}
 */
export function controlHeaders(token = null) {
  const h = { "Content-Type": "application/json" };
  if (token) h[CONTROL_TOKEN_HEADER] = token;
  return h;
}

/**
 * Is a /health body a live LOCAL dig-node? Requires status:"ok" AND
 * mode:"local-node" (so another service squatting the port is rejected), the
 * same predicate the read-path source resolver uses. Accepts a parsed object or
 * a JSON string; anything malformed → false (fail safe → the My Node surface
 * stays hidden).
 *
 * @param {object|string} body the /health response.
 * @returns {boolean}
 */
export function isLocalDigNode(body) {
  let v = body;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) { return false; }
  }
  if (!v || typeof v !== "object") return false;
  return v.status === "ok" && v.mode === "local-node";
}

/**
 * Classify a control.* JSON-RPC response so the UI reacts precisely. Maps the
 * catalogued error codes to a stable `kind` and lifts the result/message.
 *
 * @param {object|string} response the JSON-RPC response (object or JSON string).
 * @returns {{kind:'ok'|'unauthorized'|'not-supported'|'control-error'|'error',
 *            result?:any, code?:number, message?:string, dataCode?:string}}
 *   - 'ok' with `result` on success,
 *   - 'unauthorized' (re-auth: bad/missing token),
 *   - 'not-supported' (explain: unavailable on this build),
 *   - 'control-error' (runtime failure: show message),
 *   - 'error' (any other JSON-RPC error or a malformed body).
 */
export function classifyControlResponse(response) {
  let v = response;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) {
      return { kind: "error", message: "Malformed response from the node." };
    }
  }
  if (!v || typeof v !== "object") {
    return { kind: "error", message: "Empty response from the node." };
  }
  if (v.error && typeof v.error === "object") {
    const code = v.error.code;
    const message = v.error.message || "Control operation failed.";
    const dataCode = v.error.data && v.error.data.code;
    let kind = "error";
    if (code === CONTROL_ERR.UNAUTHORIZED) kind = "unauthorized";
    else if (code === CONTROL_ERR.NOT_SUPPORTED) kind = "not-supported";
    else if (code === CONTROL_ERR.CONTROL_ERROR) kind = "control-error";
    return { kind, code, message, dataCode };
  }
  return { kind: "ok", result: v.result };
}

/**
 * Decide the My Node surface's posture from a /health probe verdict + whether a
 * control token is available. Drives "hidden/greyed when no local node, active
 * otherwise" (consumption never needs a node) plus the in-between
 * "node present but the control token is missing" case.
 *
 * @param {object} args
 * @param {boolean} args.nodeDetected the /health probe said it is a local node.
 * @param {boolean} args.hasToken a control token is available to authorize.
 * @returns {{state:'no-node'|'needs-token'|'ready', canControl:boolean}}
 */
export function nodeSurfaceState(args) {
  const nodeDetected = !!(args && args.nodeDetected);
  const hasToken = !!(args && args.hasToken);
  if (!nodeDetected) return { state: "no-node", canControl: false };
  if (!hasToken) return { state: "needs-token", canControl: false };
  return { state: "ready", canControl: true };
}

/**
 * Extract the control-auth descriptor from a node /openrpc.json document so the
 * controller learns the auth scheme/header/param/token_file from the contract
 * itself rather than hard-coding it (info.x-control-auth, dig-node meta.rs).
 * Returns sane defaults (this module's constants) when the field is absent, so
 * an older node without the descriptor still works.
 *
 * @param {object|string} doc the OpenRPC document (object or JSON string).
 * @returns {{scheme:string, header:string, param:string, tokenFile:string}}
 */
export function controlAuthFromOpenRpc(doc) {
  let v = doc;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch (_) { v = null; }
  }
  const auth = v && v.info && v.info["x-control-auth"];
  return {
    scheme: (auth && auth.scheme) || "local-token",
    header: (auth && auth.header) || CONTROL_TOKEN_HEADER,
    param: (auth && auth.param) || CONTROL_TOKEN_PARAM,
    tokenFile: (auth && auth.token_file) || CONTROL_TOKEN_FILE,
  };
}
