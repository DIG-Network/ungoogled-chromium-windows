// DIG Browser CONTROL PANE policy — the page-posture layer for dig://control.
//
// dig://control is the full-page Control Pane opened from the dedicated toolbar
// button (next to the Wallet + Shields buttons). It is the browser-as-CONTROLLER
// surface of the serve/consume split (SYSTEM.md → "the browser is also the
// dig-node's CONTROLLER UI"):
//
//   - if a LOCAL dig-node is reachable (dig.local / localhost), show the node
//     MANAGEMENT UI, driven by the control.* admin RPCs (status, config, cache,
//     hosted stores, §21 sync) — the contract owned by dig_node_controller.mjs;
//   - if NONE is reachable, show an INSTALL landing that nudges the user to
//     download a standalone dig-node (the same dig-installer target #95/#100 use).
//
// HONEST UX (hard rule): the Control Pane NEVER shows a management control it
// can't actually back. When no local node answers, it shows the install landing,
// not a greyed-out fake dashboard. And it makes clear that BROWSING STILL WORKS
// without a node: chia:// reads transparently fall back to rpc.dig.net behind the
// scenes (the read path is the browser's own in-process node → rpc.dig.net). Only
// the MANAGEMENT UI requires a local node; consumption never does.
//
// This module is the SINGLE SOURCE OF TRUTH for the *pure* Control Pane posture —
// the management-vs-install branch, the "does this op need a local node" split,
// and the read-fallback plan. It deliberately REUSES dig_node_controller.mjs for
// the loopback bases + the node-detect predicate so the Control Pane and the
// (legacy, omnibox-only) dig://node page share one definition of "is a node
// present" and can never drift. The DOM glue in dig/control/dig_control.html
// re-states these functions (it is a self-contained embeddable page that imports
// nothing); dig_control.test.mjs guards both copies against this contract.
//
// Run:  node dig/control/dig_control.test.mjs   (Node >= 18)

import {
  CONTROL_BASES as CONTROLLER_BASES,
  HEALTH_PATH as CONTROLLER_HEALTH_PATH,
  isLocalDigNode,
} from "../node/dig_node_controller.mjs";

// The local dig-node's loopback bases, in the SAME preference order the read
// path + the node controller use: the friendly installer name dig.local (no
// port — the privileged :80 loopback) first, then the always-on localhost
// listener (default 8080). Re-exported FROM the node controller so the Control
// Pane cannot invent its own endpoints.
export const CONTROL_BASES = CONTROLLER_BASES;
export const HEALTH_PATH = CONTROLLER_HEALTH_PATH;

// Where chia:// reads fall back to when no local node serves them — the network
// read RPC the browser's in-process node reaches. Browsing is NEVER gated on a
// local node: this is always reachable, so the Control Pane's "no node" landing
// can honestly say "you can still browse".
export const RPC_FALLBACK_BASE = "https://rpc.dig.net";

// The install nudge target — the dig-installer releases, the SAME target the My
// Node nudge (dig_node.html) and the extension (#89/#95/#100) point at, so the
// download nudge is consistent across every DIG surface.
export const INSTALL_URL =
  "https://github.com/DIG-Network/dig-installer/releases";

// The two top-level Control Pane postures. Stable names so the page + an agent
// can read which branch is rendered without scraping prose.
export const PANE_MANAGE = "manage"; // a local node is present → node management
export const PANE_INSTALL = "install"; // no local node → install landing

/**
 * Is a /health body a live LOCAL dig-node? Delegates to the node controller's
 * predicate (status:"ok" AND mode:"local-node") so the Control Pane and the
 * dig://node page agree on detection. Accepts a parsed object or a JSON string;
 * anything malformed → false (fail safe → the install landing, never a fake
 * dashboard).
 *
 * @param {object|string} body the /health response.
 * @returns {boolean}
 */
export function detectVerdict(body) {
  return isLocalDigNode(body);
}

/**
 * Decide the Control Pane's top-level posture from the node-detection verdict.
 * The honest default (no/undefined verdict) is the INSTALL landing — we never
 * render management controls we can't back. `browsingWorks` is ALWAYS true: it
 * tells the page to reassure the user that consumption is unaffected by the
 * absence of a node (reads fall back to rpc.dig.net).
 *
 * @param {object} [args]
 * @param {boolean} [args.nodeDetected] the /health probe said it is a local node.
 * @returns {{pane:'manage'|'install', canManage:boolean, browsingWorks:boolean}}
 */
export function paneState(args) {
  const nodeDetected = !!(args && args.nodeDetected === true);
  return {
    pane: nodeDetected ? PANE_MANAGE : PANE_INSTALL,
    canManage: nodeDetected,
    browsingWorks: true,
  };
}

/**
 * Does a given JSON-RPC method require a LOCAL dig-node? Only the control.*
 * MANAGEMENT methods do; content reads (dig.*) do not — they fall back to
 * rpc.dig.net. This is the split that lets the Control Pane gate ONLY the
 * management UI on a local node while browsing stays fully functional.
 *
 * @param {string} method a JSON-RPC method name.
 * @returns {boolean} true iff the method is a control.* management op.
 */
export function needsLocalNode(method) {
  return typeof method === "string" && method.startsWith("control.");
}

/**
 * Build the ordered read-source plan for chia:// content from the Control Pane's
 * detection verdict. With a local node present, prefer it (dig.local first), and
 * ALWAYS terminate at rpc.dig.net so a read never dead-ends. With no local node,
 * the plan is simply rpc.dig.net — the honest "browsing still works" guarantee.
 *
 * This is the READ ordering ONLY (the caller always verifies the Merkle proof +
 * decrypts client-side, fail-closed); it mirrors the source-resolution policy
 * (dig_source_resolution.mjs) but expresses the terminal network fallback
 * explicitly as rpc.dig.net for the Control Pane's messaging.
 *
 * @param {object} args
 * @param {boolean} args.nodeDetected a local node is reachable.
 * @returns {Array<{kind:'local'|'rpc', baseUrl:string}>} ordered read plan,
 *   always ending in an `rpc` step at {@link RPC_FALLBACK_BASE}.
 */
export function readFallbackPlan(args) {
  const nodeDetected = !!(args && args.nodeDetected === true);
  const plan = [];
  if (nodeDetected) {
    // Local node first, in the same preference order as the bases.
    for (const baseUrl of CONTROL_BASES) plan.push({ kind: "local", baseUrl });
  }
  // rpc.dig.net is the terminal, always-present network fallback.
  plan.push({ kind: "rpc", baseUrl: RPC_FALLBACK_BASE });
  return plan;
}
