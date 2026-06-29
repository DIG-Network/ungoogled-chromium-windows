// DIG Browser per-resource inclusion-proof LEDGER — the pure model behind the
// chia://shields per-capsule proof list.
//
// WHY this exists: chia://shields already shows the AGGREGATE verdict for the
// active page (verified / served-locally) plus the capsule (storeId:rootHash)
// disclosure. But a capsule is many resources, each with its OWN Merkle
// inclusion proof that the loader verifies client-side, fail-closed. This module
// is the SINGLE SOURCE OF TRUTH for the *pure* ledger model the shields page
// renders: a per-capsule accumulator keyed by `storeId:rootHash`, and the
// pass/fail grouping the page lists under "Verified (N)" / "Failed (M)".
//
// The native loader (chrome/browser/dig/dig_url_loader_factory.cc, the
// DigURLLoader fetch→verify→decrypt path) keeps the EQUIVALENT browser-side
// accumulator in C++ (a process-global LedgerStore keyed by capsule), recording
// the SAME {resourcePath, storeId, rootHash, inclusionProofPassed, errorCode}
// tuple as each resource is served + verified, and exposes it to the shields
// WebUI via a same-origin chia://-served JSON data blob
// (chia://shields/ledger?host=… — a path under the shields host, so the panel's
// fetch is never CORS-blocked) — the same embedded-resource idiom the loader
// already uses for chia://node and chia://about. The shields page (dig/shields/dig_shields.html)
// restates groupLedger() verbatim (it is a self-contained embeddable resource
// that cannot import this module) and dig_shields.test.mjs guards that copy. Any
// change to the entry shape, the capsule key, or the grouping must be made in
// ALL THREE places (this module, the C++ LedgerStore, the page copy).
//
// The verdict is ALREADY computed in the loader (verification happens there);
// this model never re-verifies. It only RECORDS and GROUPS what the loader
// decided, fail-closed: anything without a positive pass verdict counts as
// failed.
//
// Run:  node dig/shields/dig_ledger.test.mjs   (Node >= 18)

// The default view's resource key (paper §8.5): an empty / "/" resource path
// resolves to index.html, matching the loader's MimeForResourceKey + the crypto
// layer's CanonicalRootlessUrn default. Kept identical so the ledger lists the
// SAME path the loader keyed the retrieval by.
export const DEFAULT_RESOURCE_KEY = "index.html";

// Bound the per-capsule ledger so a long-lived tab loading thousands of
// subresources can't grow it without limit. The most recent entries are kept
// (oldest evicted) — they are what the user is most likely inspecting.
export const DEFAULT_MAX_ENTRIES = 256;

/**
 * The canonical capsule key — `storeId:rootHash`, lowercased. A rootless /
 * not-yet-resolved capsule keys under `<storeId>:latest` so it still groups
 * cleanly. This MUST match the C++ LedgerStore key and the capsule string the
 * shields header already shows.
 *
 * @param {string} storeId 64-hex store id.
 * @param {string} rootHash 64-hex root, or "" / "latest" when unresolved.
 * @returns {string} `storeId:rootHash` (lowercased).
 */
export function capsuleKey(storeId, rootHash) {
  const s = String(storeId || "").toLowerCase();
  const r = String(rootHash || "").toLowerCase();
  return s + ":" + (r && r !== "latest" ? r : "latest");
}

/**
 * Normalize a resource path to the form the loader keyed the retrieval by: drop
 * a leading slash; an empty path (or bare "/") is the default view (index.html).
 *
 * @param {string} resourcePath
 * @returns {string}
 */
function normalizeResourcePath(resourcePath) {
  let p = String(resourcePath || "");
  while (p.startsWith("/")) p = p.slice(1);
  return p === "" ? DEFAULT_RESOURCE_KEY : p;
}

/**
 * A per-tab/per-capsule accumulator of inclusion-proof verdicts. The native
 * loader keeps the C++ equivalent; this is the testable pure model.
 *
 * Entries are keyed by capsule (`storeId:rootHash`) AND by resourcePath within a
 * capsule: re-serving the same resource UPDATES its verdict rather than
 * appending a duplicate (so a retry that succeeds replaces the earlier failure).
 */
export class LedgerStore {
  /** @param {object} [opts] @param {number} [opts.maxEntries=DEFAULT_MAX_ENTRIES] */
  constructor(opts = {}) {
    this._max =
      Number.isInteger(opts.maxEntries) && opts.maxEntries > 0
        ? opts.maxEntries
        : DEFAULT_MAX_ENTRIES;
    // capsuleKey -> Map<resourcePath, entry> (insertion order preserved by Map).
    this._byCapsule = new Map();
  }

  /**
   * Record one resource's verdict for its capsule. The verdict is whatever the
   * loader already decided — this never re-verifies.
   *
   * @param {object} e
   * @param {string} e.storeId 64-hex store id.
   * @param {string} e.rootHash 64-hex root (or "" / "latest").
   * @param {string} e.resourcePath the served resource path.
   * @param {boolean} e.inclusionProofPassed the loader's per-resource verdict.
   * @param {string} [e.errorCode] a catalogued DIG_ERR_* code on failure ("" on pass).
   */
  record(e) {
    const key = capsuleKey(e && e.storeId, e && e.rootHash);
    const resourcePath = normalizeResourcePath(e && e.resourcePath);
    const passed = (e && e.inclusionProofPassed) === true;
    const entry = {
      resourcePath,
      storeId: String((e && e.storeId) || "").toLowerCase(),
      rootHash: String((e && e.rootHash) || "").toLowerCase(),
      inclusionProofPassed: passed,
      // On a pass there is no error; on a fail keep the catalogued code (fall back
      // to a generic proof-mismatch class when the caller didn't supply one).
      errorCode: passed ? "" : String((e && e.errorCode) || ""),
    };
    let perResource = this._byCapsule.get(key);
    if (!perResource) {
      perResource = new Map();
      this._byCapsule.set(key, perResource);
    }
    // Update-in-place when re-served (re-insert to move it to most-recent).
    perResource.delete(resourcePath);
    perResource.set(resourcePath, entry);
    // Evict the oldest while over the cap.
    while (perResource.size > this._max) {
      const oldest = perResource.keys().next().value;
      perResource.delete(oldest);
    }
  }

  /**
   * The recorded entries for one capsule, in insertion (load) order.
   * @param {string} storeId @param {string} rootHash
   * @returns {Array<object>} a fresh array (callers may sort/group freely).
   */
  entriesFor(storeId, rootHash) {
    const perResource = this._byCapsule.get(capsuleKey(storeId, rootHash));
    return perResource ? Array.from(perResource.values()) : [];
  }
}

/**
 * Group a capsule's ledger entries into PASSED vs FAILED with counts + the
 * derived states the shields page branches on. Fail-closed: an entry without a
 * positive `inclusionProofPassed === true` verdict counts as FAILED. Pure — does
 * not mutate its input.
 *
 * @param {Array<object>} entries the ledger entries (from {@link LedgerStore#entriesFor}
 *   or the chia://shields/ledger JSON blob). Non-arrays are treated as empty.
 * @returns {{
 *   passed: Array<object>, failed: Array<object>,
 *   passedCount: number, failedCount: number, total: number,
 *   allPassed: boolean, empty: boolean
 * }}
 *   - `empty` — nothing has been recorded for this capsule yet (NOT the same as
 *     all-passed; nothing was verified).
 *   - `allPassed` — there is at least one entry and NONE failed.
 */
export function groupLedger(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const passed = [];
  const failed = [];
  for (const e of list) {
    if (e && e.inclusionProofPassed === true) {
      passed.push(e);
    } else {
      failed.push(e);
    }
  }
  const total = passed.length + failed.length;
  return {
    passed,
    failed,
    passedCount: passed.length,
    failedCount: failed.length,
    total,
    empty: total === 0,
    allPassed: total > 0 && failed.length === 0,
  };
}
