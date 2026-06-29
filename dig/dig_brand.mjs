// DIG Browser shared brand constants — the SINGLE SOURCE OF TRUTH for the
// ecosystem wordmarks the browser surfaces render.
//
// WHY this exists: the hub wordmark was being rendered two ways even within the
// SAME browser (NTP/About said "DIGHUb" but the My Node surface said "DIGHub"),
// and a test had pinned the wrong casing. SYSTEM.md "Canonical terminology &
// branding" fixes the hub wordmark as **DIGHUb** (capital U, lowercase b) in all
// user-facing prose/UI. Centralising it here — and guarding every surface in
// dig/dig_brand.test.mjs — means the casing can never silently re-drift.
//
// NOTE: the embedded HTML pages (dig/**/*.html) are self-contained resources
// that build.py inlines verbatim, so they cannot `import` this module; they
// restate the literal. dig/dig_brand.test.mjs scans those pages (and these .mjs
// sources) for the wrong casing so the two stay in lockstep — the same no-drift
// pattern dig_node.test.mjs uses for the controller/deploy helpers.
//
// Run:  node dig/dig_brand.test.mjs   (Node >= 18)

/**
 * The canonical DIGHUb wordmark for user-facing prose/UI/help. This is the
 * publishing-hub brand (the site at hub.dig.net).
 *
 * Casing is load-bearing: capital "D", "I", "G", capital "U", lowercase "b".
 * The lowercase code identifier `dighub` (e.g. the `dighub` remote, a CSS class)
 * and the bare domain `hub.dig.net` stay lowercase — those are NOT wordmarks.
 */
export const WORDMARK_HUB = "DIGHUb";

/** The token sigil. Written `$DIG` on first user-facing reference in prose/CTAs. */
export const TOKEN_SIGIL = "$DIG";
