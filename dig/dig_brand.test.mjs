// Brand no-drift guard for the DIG Browser surfaces.
//
// SYSTEM.md "Canonical terminology & branding" fixes the hub wordmark as
// **DIGHUb** in all user-facing prose/UI. This was rendered two ways even within
// the SAME browser (NTP/About correctly said "DIGHUb"; the My Node surface said
// the off-canon "DIGHub"), and a test had pinned the wrong casing — actively
// enforcing the drift. This test is the regression guard: it scans every shipped
// dig/* HTML page + the .mjs sources for the wrong casing and asserts ZERO
// matches, so the bug can never silently resurface.
//
// The wordmark literal lives in dig/dig_brand.mjs (the single source of truth).
// The embedded HTML pages can't `import` (build.py inlines them verbatim), so
// this string scan keeps the restated literal in lockstep with the constant —
// the same no-drift pattern dig_node.test.mjs uses for the deploy helpers.
//
// Run:  node dig/dig_brand.test.mjs   (Node >= 18)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WORDMARK_HUB, TOKEN_SIGIL } from "./dig_brand.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), "utf8");

// Every user-facing browser surface + the doc/source files that render the hub
// wordmark. (The embedded HTML pages are the actual shipped surfaces.)
const SURFACES = [
  "newtab/dig_newtab.html",
  "about/dig_about.html",
  "node/dig_node.html",
  "node/dig_deploy_flow.mjs",
  "welcome/dig_welcome.html",
  "shields/dig_shields.html",
];

// The off-canon casing, as a whole word. We must NOT match the canonical
// "DIGHUb" (a [b] follows the U) nor the lowercase code id "dighub". The hub
// wordmark mis-casing is exactly "DIGHub" followed by a non-letter / end.
const WRONG = /DIGHub\b/g;

test("the canonical hub wordmark constant is DIGHUb (exact casing)", () => {
  assert.equal(WORDMARK_HUB, "DIGHUb");
  assert.equal(TOKEN_SIGIL, "$DIG");
});

for (const rel of SURFACES) {
  test(`${rel}: never renders the off-canon "DIGHub" casing`, () => {
    const text = read(rel);
    const hits = text.match(WRONG) || [];
    assert.deepEqual(
      hits,
      [],
      `found ${hits.length} off-canon "DIGHub" in ${rel}; use the canonical ${WORDMARK_HUB}`
    );
  });
}

test("the My Node surface labels hosted features with the canonical DIGHUb", () => {
  const html = read("node/dig_node.html");
  // The outbound "hosted-only features" section header + its copy name the hub.
  assert.match(html, new RegExp("On " + WORDMARK_HUB), "section header uses DIGHUb");
  assert.match(html, new RegExp(WORDMARK_HUB + " runs"), "section copy uses DIGHUb");
});

// The canonical ordered Get-$DIG venue set (mirrors hub lib/links.js
// GET_DIG_SOURCES: TibetSwap leads, then dexie, then 9mm.pro). The NTP surfaces
// all three wherever it offers to acquire the token, so a short user has every
// liquid path in one place — not just TibetSwap.
const DIG_TAIL = "a406d3a9de984d03c9591c10d917593b434d5263cabe2b42f6b367df16832f81";
const VENUES = [
  "https://v2.tibetswap.io",
  `https://dexie.space/offers/${DIG_TAIL}/XCH`,
  `https://xch.9mm.pro/token/${DIG_TAIL}`,
];
const DISCORD = "https://discord.gg/dignetwork";

test("NTP surfaces all THREE canonical Get-$DIG venues in order", () => {
  const html = read("newtab/dig_newtab.html");
  let cursor = 0;
  for (const url of VENUES) {
    const at = html.indexOf(url, cursor);
    assert.notEqual(at, -1, `NTP is missing the Get-$DIG venue ${url}`);
    cursor = at; // ordering: each venue appears at/after the previous one
  }
  // the token is written with its sigil where the venues are surfaced.
  assert.match(html, /Get <b>\$DIG<\/b>/, "the directory Get-$DIG line sigils the token");
});

test("the community/help Discord is surfaced (NTP footer + About)", () => {
  assert.match(read("newtab/dig_newtab.html"), new RegExp(DISCORD.replace(/\./g, "\\.")),
               "NTP footer links Discord");
  assert.match(read("about/dig_about.html"), new RegExp(DISCORD.replace(/\./g, "\\.")),
               "About links Discord");
});
