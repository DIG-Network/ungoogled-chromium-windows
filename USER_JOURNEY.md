# DIG Browser — user journey

How a person actually moves through DIG Browser, surface by surface, and where
each surface hands off to the rest of the DIG ecosystem. This is the end-to-end
narrative behind the user-facing files in `dig/` and the UX patches in
`patches/ungoogled-chromium/windows/`.

> **Canonical vocabulary** (see the superproject `SYSTEM.md` → "Canonical
> terminology & branding"):
> - **User-facing content scheme: `chia://`.** The browser registers the scheme
>   whose literal value is `"chia"` (the C++ identifier is `kDigScheme`). Users
>   type/click `chia://…`. The URN namespace `urn:dig:` is unchanged.
> - **DIG Wallet** = the user's Chia wallet, built into DIG Browser.
> - **store** = the on-chain singleton identity; **capsule** = one immutable
>   generation of a store, written `storeId:rootHash`.
> - **DIGHUb** is the publishing hub; the token is **$DIG**.

---

## 1. First run — the welcome tour (`chia://welcome`)

On first launch DIG Browser opens its own branded welcome tour instead of a bare
new tab (decided by `GetFirstRunTabsForState` in
`windows-dig-about-welcome.patch`; an explicit distribution `initial_preferences`
config still wins). The tour is `dig/welcome/dig_welcome.html`, a 5-slide
walkthrough in the DIG palette:

1. **Welcome** — what DIG Browser is.
2. **Open the in-network web** — type a `chia://` address or a **store id** and
   the browser opens it straight from the DIG Network, verified on its on-chain
   root and decrypted on-device. (Honest scope: it does **not** resolve human
   names yet — paste an address or id.)
3. **Your DIG Wallet, built in** — the DIG Wallet (your Chia wallet, built into
   DIG Browser) lives in the toolbar and is your account across the network;
   apps connect only with per-site approval.
4. **Private from the first click** — encrypted DNS + HTTPS-only, no trackers/
   telemetry, DuckDuckGo search by default.
5. **You're all set** — a "Set as default" prompt (opens
   `chrome://settings/defaultBrowser`) and "Start browsing", both of which land
   the user on `chia://home`.

**Hand-off:** Finish / Skip → `chia://home`.

---

## 2. Home — the new-tab page (`chia://home`)

`dig/newtab/dig_newtab.html` is both the new-tab page and `chia://home` (single
source; `build.py` generates `dig_home_html.inc` from it). It is the daily hub.

- **Brand logo / wordmark → `chia://home`.** The home affordance lives here
  because the toolbar's former home button was repurposed as the DIG Wallet
  button (see §5). An explicit **"DIG Network ↗"** footer link goes to the
  marketing site `https://dig.net`.
- **Two tabs:**
  - **Apps** (default) — a small directory of first-party / ecosystem
    destinations (DIGHUb, docs, TibetSwap for **$DIG**, sample dapps). The tab is
    named "Apps" (not "App Store") to avoid the trademark and the collision with
    DIG's own *store* concept.
  - **Search** — an omnibox. The classifier (`classify()` + `digToChiaUrl()`,
    a port of `net::dig::ParseDigUrn` + `url_fixer.cc`) routes input:
    - `chia://…`, `urn:dig:…`, or a bare 64-hex **store id** → opens on the DIG
      Network (canonical host form `chia://[<root>.]<store>/…`);
    - an `http(s)://` URL or dotted host → navigates the web;
    - **anything else → DuckDuckGo web search.** A bare word is *never* treated
      as a DIG address (no name resolution is promised).
- **Wallet button** in the header opens `chia://wallet`.
- **"Powered by Chia"** trust line; footer reiterates that every `chia://` page
  is Merkle-verified on its on-chain root and decrypted on-device.

**Hand-offs:** Apps cards → DIGHUb / docs / dapps (web). Omnibox → `chia://…`
content, a web URL, or DuckDuckGo. Wallet → `chia://wallet`. Publish → DIGHUb.

---

## 3. Opening content — `chia://` navigation + verification

When the user opens a `chia://` address (from the omnibox, a link, or a typed
address), the native dig handler (`windows-add-dig-protocol.patch`) resolves the
resource end-to-end: fetch from `rpc.dig.net` (or the local cache), verify
against the on-chain root, decrypt on-device, then commit. The loader is
**fail-closed** — a `chia://` page only ever renders if it passed verification,
so a committed `chia://` page is verified by construction.

Locally-cached pages load instantly and offline (the local cache is capped and
managed in settings — see §6).

---

## 4. The verified badge — DIG identity panel (`chia://shields`)

A toolbar shield button (the Brave-Shields analogue,
`windows-dig-shields.patch`) opens `dig/shields/dig_shields.html` as a small
popup, anchored under the button. It is a **read-only posture readout**, not a
per-site control panel:

- **Status hero** — is this a DIG Network page, a built-in DIG Browser surface,
  or a standard web page? For a verified `chia://` page it shows "Verified DIG
  content", an "On-chain verified" chip, and whether it was served from the
  device or the network.
- **Capsule disclosure (progressive)** — when the page pins a specific
  `rootHash` (host form `<rootHash>.<storeId>`), the panel surfaces it: plain
  **"Verified version"** by default, expanding to the protocol-level **capsule**
  id `storeId:rootHash` with a one-line definition. This is the browser's
  surfacing of the ecosystem-wide *capsule* concept.
- **Privacy posture** — the hardened, **browser-wide** defaults (trackers/ads
  blocked, fingerprinting reduced, HTTPS-only + encrypted DNS, DNT + no
  telemetry), each shown "On". The copy is framed as a readout of browser-wide
  defaults, not toggles this panel can flip.

**Hand-off:** "Manage DIG settings & cache" → `chia://settings`; "Privacy &
security settings" → `chia://privacy`.

---

## 5. The DIG Wallet (`chia://wallet`)

The toolbar's former home button is the **DIG Wallet** button
(`windows-dig-browser-ux.patch`): a wallet-pouch icon with a Chia leaf knocked
out of its face. It opens the in-process DIG Wallet (`chia://wallet`) — the
user's Chia wallet, built into DIG Browser — as a docked side panel.

Click behaviours (surfaced in the button tooltip so they're discoverable, and
intended to be mirrored as explicit controls in the wallet panel header):

- **Click** — open / focus the docked panel (right edge by default).
- **Alt + click** — toggle which edge the panel docks to (left / right;
  persisted per profile in `dig.wallet_panel.dock_left`).
- **Shift + click** — pop the wallet out as its own free-floating window.

Web and `chia://` pages reach the wallet through the injected provider
(`window.chia`, CHIP-0002 — `dig/provider/dig_provider.js` +
`windows-dig-wallet-bridge.patch`), which proxies over a frame-scoped Mojo pipe
to the in-process wallet. The wallet stamps the committed origin server-side and
enforces a **per-origin approval gate** — apps connect only with the user's
approval, one site at a time.

**Hand-off:** dapps ↔ wallet via `window.chia`; spend/sign flows run in the
in-process wallet.

---

## 6. Settings — the DIG section (`chia://settings` → DIG)

`chrome://settings` (rewritten to `chia://settings`) gains a dedicated **DIG
Network** section (`windows-dig-settings-section.patch`) with its own left-nav
entry. It exposes the native local-cache controls via a Mojo handler
(`DigCacheHandler`):

- A plain-language intro (the DIG Network is a decentralized web where every page
  is proven on-chain, secured by the **$DIG** token; visited pages are cached
  on-device to load fast and offline).
- A **local cache limit** slider (1–50 GB) with a live usage readout — "Most
  space DIG Browser may use to store sites from the DIG Network on this device."
- A **Clear cache** button (content re-warms from `rpc.dig.net` on next visit).

---

## Surface map (quick reference)

| Surface | URL | Source | Role |
|---|---|---|---|
| Welcome tour | `chia://welcome` | `dig/welcome/dig_welcome.html` | First-run onboarding |
| Home / new tab | `chia://home` | `dig/newtab/dig_newtab.html` | Daily hub: Apps + Search + Wallet |
| About | `chia://about` | `dig/about/dig_about.html` | What DIG Browser is + version |
| DIG identity panel | `chia://shields` | `dig/shields/dig_shields.html` | Verification + privacy posture readout (capsule) |
| DIG Wallet | `chia://wallet` | in-process DIG runtime | The built-in Chia wallet |
| Settings → DIG | `chia://settings` (→ `/dig`) | `windows-dig-settings-section.patch` | Local-cache controls |
| Injected provider | `window.chia` | `dig/provider/dig_provider.js` | CHIP-0002 wallet bridge for pages |

## Ecosystem hand-offs

- **DIGHUb** (`hub.dig.net`) — publish/manage stores; the DIG Wallet is the
  account. Reached from the home "+ Publish" button and Apps card.
- **docs.dig.net** — protocol / CLI / build docs. Reached from Apps + footer.
- **dig.net** — marketing site. Reached from the explicit "DIG Network ↗"
  footer link (the brand logo goes to `chia://home`, not the marketing site).
- **TibetSwap / dexie / 9mm** — acquire **$DIG** to publish. TibetSwap is
  surfaced on the home Apps directory + footer.
- **rpc.dig.net** — the read path the native `chia://` handler fetches from
  (then verifies on-chain + decrypts on-device); the local cache sits in front.
- **CHIP-0035 / on-chain root** — the source of truth the verified badge and the
  capsule (`storeId:rootHash`) are anchored to.
