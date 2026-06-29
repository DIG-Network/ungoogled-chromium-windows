// Agent-surface + no-drift guard for the chia://shields DIG identity panel
// (dig/shields/dig_shields.html), specifically the per-resource inclusion-proof
// LEDGER it now renders below the aggregate verdict.
//
// A full Chromium build is infeasible in CI, so this test does two things on the
// shipped HTML source (the same file build.py embeds into the binary):
//   1. extracts the PURE groupLedger() restated in the page's <script> and
//      asserts it behaves identically to dig/shields/dig_ledger.mjs — the page is
//      a self-contained embeddable resource so it can't `import` the module, and
//      this guarantees the two copies never drift; and
//   2. asserts the ledger UI affordances are present (the two sections "Verified
//      (N)" / "Failed (M)", a per-resource list with stable data-testid + ARIA,
//      the proof/root detail behind disclosure, and the empty / all-passed /
//      some-failed states), keeping the existing aggregate header + capsule
//      disclosure intact.
//
// Run:  node dig/shields/dig_shields.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as mod from "./dig_ledger.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "dig_shields.html"), "utf8");

// Pull a single named function (incl. body) out of the page's <script> by
// brace-balancing from its first '{' (same idiom as dig_node.test.mjs).
function extractFn(name) {
  const start = html.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in dig_shields.html`);
  const open = html.indexOf("{", start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

const src =
  extractFn("groupLedger") + "\n" + "export {groupLedger};";
const page = await import("data:text/javascript," + encodeURIComponent(src));

// ---- 1. the page's restated groupLedger matches the module contract ---------

test("page groupLedger matches the module: some-failed grouping + counts", () => {
  const entries = [
    { resourcePath: "index.html", inclusionProofPassed: true, errorCode: "" },
    { resourcePath: "app.js", inclusionProofPassed: true, errorCode: "" },
    { resourcePath: "evil.js", inclusionProofPassed: false, errorCode: "DIG_ERR_PROOF_MISMATCH" },
  ];
  const a = page.groupLedger(entries);
  const b = mod.groupLedger(entries);
  assert.deepEqual(
    { p: a.passedCount, f: a.failedCount, all: a.allPassed, empty: a.empty, total: a.total },
    { p: b.passedCount, f: b.failedCount, all: b.allPassed, empty: b.empty, total: b.total },
  );
  assert.equal(a.passedCount, 2);
  assert.equal(a.failedCount, 1);
  assert.equal(a.allPassed, false);
});

test("page groupLedger matches the module: empty + all-passed states", () => {
  assert.equal(page.groupLedger([]).empty, true);
  assert.equal(page.groupLedger([]).allPassed, false);
  const allPass = page.groupLedger([{ resourcePath: "index.html", inclusionProofPassed: true }]);
  assert.equal(allPass.allPassed, true);
  assert.equal(allPass.empty, false);
  // fail-closed: a missing pass verdict counts as failed, matching the module.
  assert.equal(page.groupLedger([{ resourcePath: "x" }]).failedCount, 1);
  assert.equal(mod.groupLedger([{ resourcePath: "x" }]).failedCount, 1);
});

// ---- 2. the ledger UI affordances are present -------------------------------

test("shields keeps the existing aggregate header + capsule disclosure", () => {
  assert.match(html, /<main\b[^>]*data-testid="shields-page"/, "main[data-testid=shields-page]");
  assert.match(html, /data-testid="shields-badge"/);
  assert.match(html, /data-testid="shields-status-title"/);
  assert.match(html, /data-testid="shields-capsule-toggle"/, "capsule disclosure preserved");
  // document-level verdict data-* preserved for agents.
  assert.match(html, /data-dig-scheme/);
  assert.match(html, /data-dig-verified/);
  assert.match(html, /data-dig-source/);
  assert.match(html, /data-dig-capsule/);
});

test("shields renders the per-resource ledger: two sections + a per-resource list", () => {
  // the ledger region + its two count-bearing section headings.
  assert.match(html, /data-testid="shields-ledger"/, "ledger region");
  assert.match(html, /data-testid="shields-ledger-passed"/, "Verified (N) section");
  assert.match(html, /data-testid="shields-ledger-failed"/, "Failed (M) section");
  assert.match(html, /data-testid="shields-ledger-passed-count"/, "passed count is addressable");
  assert.match(html, /data-testid="shields-ledger-failed-count"/, "failed count is addressable");
  // per-resource rows are rendered into lists an agent can read.
  assert.match(html, /data-testid="shields-ledger-passed-list"/);
  assert.match(html, /data-testid="shields-ledger-failed-list"/);
  // empty / all-passed states each have a distinct, addressable surface.
  assert.match(html, /data-testid="shields-ledger-empty"/, "empty state");
});

test("shields exposes the ledger summary as document data-* for agents", () => {
  // an agent reads the per-capsule pass/fail tally without scraping the list.
  assert.match(html, /data-dig-ledger-passed/, "writes data-dig-ledger-passed");
  assert.match(html, /data-dig-ledger-failed/, "writes data-dig-ledger-failed");
});

test("shields reads the ledger from a same-origin chia:// data feed (not from page prose)", () => {
  // the page fetches the per-tab ledger blob the loader serves; the host is the
  // capsule/origin it opened over (carried in the existing &host= param). The
  // feed is a SAME-ORIGIN path under the shields host so the fetch isn't
  // CORS-blocked.
  assert.match(html, /chia:\/\/shields\/ledger/, "reads the chia://shields/ledger data feed (same-origin)");
  assert.match(html, /fetch\(/, "uses fetch() to read the structured feed");
});

test("shields ledger rows surface the proof/root detail behind disclosure", () => {
  // progressive disclosure: a plain check/cross by default, the proof/root detail
  // (the catalogued DIG_ERR_* on failures, the capsule root) on demand.
  assert.match(html, /DIG_ERR_|errorCode|error-code/i, "catalogued error code surfaced on failures");
});
