# DIG Browser (Windows)

**DIG Browser** is the DIG Network's privacy-respecting desktop browser: a
clean, professionally branded build of [ungoogled-chromium](//github.com/Eloston/ungoogled-chromium)
with **native `chia://` protocol support**. Navigate to a `chia://` address and the
browser resolves the resource from the DIG content network, **verifies it against
its on-chain Merkle root, and decrypts it on your device** — the same client-side
verify/decrypt contract used by the DIG Chrome extension, the DIG Hub, and the
`digstore` CLI (see the ecosystem `SYSTEM.md`).

> **Scheme note (two schemes, split by what they address — per `SYSTEM.md`).**
> - **`chia://` = DIG Network content** — what you type/click to open a verified
>   capsule/resource (`chia://[<root>.]<storeID>/<resource>`). This is the scheme
>   the rest of this section is about.
> - **`dig://` = the browser's own internal pages** — its DIG-branded chrome:
>   `dig://home`, `dig://wallet`, `dig://shields`, `dig://node`, `dig://settings`,
>   `dig://welcome`, `dig://about`. Served directly from the binary (local UI, not
>   chain content).
>
> Distinct, unchanged concepts that also use these words: the `urn:dig:` URN
> namespace, and the digstore **§21 remote-transport locator**
> `dig://<host>/<store_id>` (a developer/wire contract) — NOT the same as the
> browser's internal `dig://` scheme. Mnemonic: DIG-branded chrome = `dig://`;
> Chia-anchored content = `chia://`.

It is ungoogled-chromium underneath (no Google services, no telemetry), rebranded
as a DIG Network product and themed in the DIG brand purple (`#5800D6`).

## What `chia://` does

`chia://` is a first-class URL scheme. You can type any of these into the address
bar (or link to them from a page):

```
chia://<storeID>[:<root>]/<resourceKey>           # shorthand
chia://urn:dig:chia:<storeID>[:<root>]/<resourceKey>
urn:dig:chia:<storeID>[:<root>]/<resourceKey>     # full URN
chia://<storeID>/index.html?salt=<hex>            # private store
```

`<storeID>` and `<root>` are 64-char hex; an empty resource path resolves to
`index.html`. The optional `?salt=<hex>` is the private-store secret salt.

### How `chia://` → `rpc.dig.net` works (the native read path)

The native handler (`net/url_request/dig_protocol_handler.cc`) mirrors the
reference extension exactly, but in C++ with BoringSSL instead of the WASM
crypto module:

1. **Parse the URN** (`dig_urn.cc`) — full form or shorthand, plus `?salt=`.
2. **Retrieval key** — `retrieval_key = SHA-256(canonical rootless URN)` where the
   canonical rootless URN is `urn:dig:chia:<storeID>/<resourceKey>`
   (`dig_crypto.cc`, SYSTEM.md "Retrieval key"). The URN itself is never sent.
3. **Fetch** — `POST` JSON-RPC 2.0 `dig.getContent` to the configured DIG RPC
   endpoint (default `https://rpc.dig.net/`), streaming 3 MiB windows and
   reassembling `{ ciphertext, chunk_lens, inclusion_proof, total_length,
   complete, next_offset }` (SYSTEM.md "JSON-RPC 2.0 read methods").
4. **Verify** — recompute the leaf `SHA-256(ciphertext)` and fold the Merkle
   inclusion proof (`NODE_TAG = "digstore:node:v1"`) up to the trusted root; if
   the URN pinned a `<root>`, the proof root must equal it (SYSTEM.md "Merkle
   inclusion proof").
5. **Decrypt** — derive the per-URN AES-256 key with HKDF-SHA256
   (salt `SHA-256("digstore-hkdf-salt-v1" [|| secret_salt])`,
   info `"digstore-aes-256-gcm-key-v1"`, ikm = canonical URN) and decrypt
   AES-256-GCM-SIV under a fixed nonce, split by `chunk_lens`
   (SYSTEM.md "AES-256-GCM-SIV + HKDF-SHA256").
6. **Render** — serve the verified, decrypted bytes with a MIME type derived
   from the resource extension.

The pipeline is **fail-closed**: a decoy, tampered bytes, a wrong root, or a
wrong/missing salt fail verification or the GCM-SIV tag and surface a branded
error page — content is never shown unless it verifies *and* decrypts.

### Where `chia://` content is read from (source resolution)

The DIG Browser is a **consumer** in the DIG serve/consume split (`SYSTEM.md` →
"Roles — serving vs consuming"). For every `chia://` read it picks a source **in
order**:

1. **A local standalone dig-node**, if one is reachable — preferred, because it
   is local/offline-capable and contributes to the network. It is addressed
   `http://dig.local` **first** (the `dig-installer` maps that name to the
   node's privileged `:80` loopback listener), then `http://localhost:8080` (the
   node's always-on localhost listener). The browser does a cheap `GET /health`
   liveness probe (confirming `status:"ok"` + `mode:"local-node"`) and **memoizes
   the verdict for ~5s**, so a page's many subresources never each re-probe a
   down node and a single failed probe never stalls a load.
2. **The browser's own in-process dig-node** otherwise — which itself reaches
   `rpc.dig.net` when it has no cached capsule.

Either way the served bytes are **always** verified against the on-chain root
and decrypted on your device — the source is never trusted (fail-closed). So the
browser is **fully functional standalone** (no local node needed), and when a
local dig-node *is* present it consumes from it and they share one `.dig` cache.

- **Disable** consuming from a local node (in-process only) with the
  `--disable-local-dig-node` command-line switch.
- The pure resolution policy (ordering, port, host, probe path, TTL) lives in
  [`dig/node/dig_source_resolution.mjs`](dig/node/dig_source_resolution.mjs)
  with a Node test harness; the native loader mirrors it in C++.

### Run & manage your node — `dig://node` (My Node)

The DIG Browser is also your node's **controller**. When a local standalone
**dig-node** is running, open **`dig://node`** ("My Node") to manage it: see its
status, the **stores it hosts** (pin / unpin), the **cache** (view / clear / set
cap), **§21 sync** status, and the **upstream** it fetches from. It drives the
node's `control.*` admin RPCs over loopback only.

- **Hidden when you have no local node.** Consumption never needs one, so with no
  node present the page shows a **calm, dismissible nudge** instead of an empty
  controller: it says the browser already works fully on its own (in-process node
  + `rpc.dig.net`, nothing to install to browse), then invites installing a
  **standalone dig-node** to run a full node, contribute to the network, share
  your `.dig` cache, and unlock this My Node controller. The **Install dig-node**
  link points at the [`dig-installer` releases](https://github.com/DIG-Network/dig-installer/releases)
  (the same target the `dig-chrome-extension` uses). Never alarmist; dismissing it
  is remembered (localStorage), and "Check again" re-engages.
- **Loopback-gated by a control token.** The node writes a secret token to
  `<config_dir>/control-token`; every `control.*` call carries it in the
  `X-Dig-Control-Token` header. The browser reads the token on this device and
  injects it into the page (a renderer page can't read the filesystem); it is
  sent only to your local node and never leaves the machine.
- **Self-describing.** `dig://node?describe=1` emits the node's
  `GET /openrpc.json` control contract as JSON (an agent entry point). The control
  policy (method names, the auth scheme, the catalogued error codes
  `-32020`/`-32021`/`-32022`) lives in
  [`dig/node/dig_node_controller.mjs`](dig/node/dig_node_controller.mjs) with a
  Node test harness; the page restates it and `dig/node/dig_node.test.mjs` guards
  the two against drift and against the dig-node contract.

### Publish from the browser — local launch & deploy (`dig://node` → Publish)

My Node has a **Publish** panel — the browser-as-local-hub centrepiece. It puts a
folder of files on the DIG Network **from this device**, signed by the in-process
**DIG Wallet**, with no hub spend service:

- **Launch a site** — pick a folder → the local node compiles it into a
  **capsule** (`dig.stage`) → a **cost preview** (the dynamic, USD-pegged **$DIG**
  amount ÷ live price + the XCH network fee) → sign in the wallet
  (`chia_mintStore`) → anchor on-chain → §21 push so others can read it →
  result: the **capsule** (`storeId:rootHash`), the `chia://` URN, and a DIGHUb
  link.
- **Publish an update** — pick a store you own + a folder → `dig.stage` → cost →
  `chia_advanceStore` (or a writer **deploy token**) → anchor → §21 push.
- **Plain language, progressive disclosure.** "Launch a site" / "Publish an
  update" by default; the capsule / `storeId:rootHash`, the compiled module path,
  and the URN live behind "Capsule details" / "Advanced" expanders. The deploy
  posture is exposed as a document `data-dig-deploy` attribute
  (`idle`/`staging`/`staged`/`signing`/`anchoring`/`pushing`/`done`/`error`) and
  failures as `data-dig-deploy-error` carrying a stable code.
- **Catalogued error codes** (`DIG_ERR_*`, aligned with the loader taxonomy +
  `docs.dig.net` `error-codes.json`): `DIG_ERR_INSUFFICIENT_DIG`,
  `DIG_ERR_NOT_FAST_FORWARD`, `DIG_ERR_ANCHOR_TIMEOUT`, `DIG_ERR_PUSH_FAILED`,
  `DIG_ERR_BROADCAST_DISABLED`, plus the staging codes
  (`DIG_ERR_STAGE_EMPTY`/`_OVER_CAP`/…).
- **Broadcast-gated.** The wallet signs the spend; it is pushed to mainnet only
  when the wallet runs with `DIG_WALLET_ALLOW_BROADCAST=1` (otherwise
  signed-but-not-pushed — the panel says so). A publish never hand-rolls a spend:
  the wallet builds it via `digstore-chain`.
- The pure flow policy (state machine, `dig.stage` + wallet request/result, the
  dynamic cost preview, error-code mapping) lives in
  [`dig/node/dig_deploy_flow.mjs`](dig/node/dig_deploy_flow.mjs) with a Node test
  harness; the page restates it and `dig/node/dig_node.test.mjs` guards the two
  against drift and against the dig-node / dig-wallet engine contracts.

The native crypto (`net/url_request/dig_crypto.cc`) is a byte-for-byte C++ port
of `digstore-core` (`crypto.rs` / `merkle.rs` / `urn.rs`), so it stays
byte-identical to the `dig_client` WASM the rest of the ecosystem shares. Changing
the URN scheme, retrieval key, Merkle tags, or HKDF/AES parameters here **must**
be coordinated with the other modules per `SYSTEM.md`.

### Toolbar buttons dock into the Side Panel

The **DIG Wallet** button (left-most, the wallet mark — it is the repurposed home
button) and the **DIG identity** button (next to it, the shield mark) both open
their `chia://` surface **DOCKED in Chromium's built-in Side Panel** by default —
not a free-floating popup window. A docked panel reserves layout space (the page
content reflows beside it) and stays attached to the window; it cannot be dragged
off. Click the button again to close it (the panel toggles), exactly like every
other side-panel toolbar entry.

| Click | Wallet button (`dig://wallet`) | Identity button (`dig://shields`) |
|-------|----------------------------------|-------------------------------------|
| plain click | dock in the Side Panel (right edge by default); toggle closed | same |
| **Alt**+click | flip which edge the Side Panel docks to (left ↔ right; persists per profile) | same (shared pref) |
| **Shift**+click | pop out as a free-floating window (the old pre-Side-Panel behavior, now opt-in) | same |

Mechanism: the two surfaces are registered as **global (window-scoped)
`SidePanelEntry` objects** under their own ids — `kDigWallet` / `kDigShields`
(`side_panel_entry_id.h`, both with a `std::nullopt` action id like Chromium's
own `kWebView`/`kSidePanelDev`) — from `SidePanelHelper::PopulateGlobalEntries()`,
the same hook Chromium uses for reading-list/bookmarks. Each entry's content is a
profile-bound `views::WebView` that `LoadInitialURL()`s the existing `chia://`
surface, so the docked panel renders the **same page** the popup did, verified and
decrypted the same way — the page HTML/JS is unchanged. The entries are registered
header-less (`set_should_show_header(false)`) because a `std::nullopt`-action entry
must skip the `SidePanelHeaderController` (its `SidePanelHelper::GetActionItem()`
`CHECK`s the action id has a value); the `chia://` pages carry their own header.
The dock edge is Chromium's own `prefs::kSidePanelHorizontalAlignment`
(`side_panel.is_right_aligned`), so Alt+click moves the whole Side Panel — DIG
panels and Chromium's own entries alike. The plumbing lives in
`windows-dig-sidepanel.patch` (`dig_side_panel.{h,cc}`); the buttons drive it via
`BrowserWindowInterface::GetFeatures().side_panel_ui()->Toggle(...)` in
`windows-dig-browser-ux.patch` (wallet) and `windows-dig-shields.patch` (identity).

### DIG identity panel — `dig://shields` (the per-resource proof ledger)

The signature DIG-identity toolbar button (next to the wallet button) opens the
**DIG identity panel** — `dig://shields`, the Brave-Shields analogue. Besides the
aggregate verified badge, served-locally state, the capsule (`storeId:rootHash`)
disclosure, and the privacy posture, it lists the **per-resource inclusion-proof
LEDGER** for the page's capsule:

- Every resource the loader served + verified for this capsule is recorded —
  `{resourcePath, storeId, rootHash, inclusionProofPassed, errorCode}` — keyed by
  the committed capsule. The verdict is computed **once, in the loader** (the same
  fail-closed Merkle verification above); the panel only lists it.
- The panel renders two sections — **Verified (N)** and **Failed (M)** — each a
  list of resource paths with a plain check/✗. The **proof root** and (on a
  failure) the catalogued `DIG_ERR_*` code sit behind a per-row **Proof detail**
  disclosure, so the default view stays plain while building the mental model
  *capsule root → per-resource inclusion proof*. Empty / all-passed / some-failed
  states are each handled.
- **How it's wired.** The loader keeps a process-global, per-capsule accumulator
  (`RecordLedgerEntry` in `dig_url_loader_factory.cc`) and serves it back to the
  panel as a same-origin JSON blob at **`dig://shields/ledger?host=…`** (a path
  under the `shields` host, so the panel's `fetch().json()` is never CORS-blocked).
  The pure model — the capsule key, the entry shape, the pass/fail grouping —
  lives in [`dig/shields/dig_ledger.mjs`](dig/shields/dig_ledger.mjs) with a Node
  test harness; the page restates `groupLedger()` verbatim and
  `dig/shields/dig_shields.test.mjs` guards the two against drift.
- The panel exposes the tally as document `data-dig-ledger-passed` /
  `data-dig-ledger-failed` so an agent reads the per-capsule verdict without
  scraping the list.

## Agent / programmatic surface

DIG Browser is self-describing so an agent or dapp can introspect it without
out-of-band knowledge:

- **Injected wallet (`window.chia`)** — a CHIP-0002 provider injected into every
  page. It exposes its own identity and capabilities:
  - `window.chia.isDIG` / `.version` / `.info` (`{isDIG, transport:"native",
    edition:"browser", scheme:"chia", version}`),
  - `window.chia.methods` — the supported method catalogue (also over the wire
    via `request({method:"chip0002_getMethods"})`, answered locally),
  - `window.chia.errorCodes` and the documented thrown-error codes: `4001`
    user-rejected/pending, `4100` unauthorized, `4200` unsupported method, `4900`
    wallet unreachable. The typed contract is
    [`dig/provider/dig_provider.d.ts`](dig/provider/dig_provider.js).
  It is byte-aligned with the `dig-chrome-extension`'s `window.chia` so a dapp
  sees the same surface on either.
- **Version** — `dig://about` shows the running build (the `{{VERSION}}` token is
  filled at request time from `version_info`; the same value is substituted into
  the provider's `window.chia.version` at build time).
- **`chia://` loader error taxonomy** — a failed load serves the branded error
  page with a **stable, machine-readable code**: a `<meta name="dig-error-code">`
  tag + a `data-dig-error` attribute on `<body>` + an `X-Dig-Error` response
  header. The codes mirror the ecosystem catalogue
  (docs.dig.net `static/error-codes.json` → `dig-loader`):
  `DIG_ERR_PROOF_MISMATCH` (tamper / wrong root), `DIG_ERR_DECRYPT_TAG` (wrong
  key/salt / corrupt), `DIG_ERR_NOT_FOUND` (blind miss / decoy / invalid URN),
  `DIG_ERR_NETWORK` (node/CDN unreachable or transport failure).
- **Driveable UI** — the built-in `dig/*` surfaces (`dig://home`, `about`,
  `welcome`, `shields`, `node`) carry stable `data-testid` hooks and ARIA
  landmarks; `dig://shields` exposes the active page's verification verdict as
  document `data-dig-scheme` / `data-dig-verified` / `data-dig-source` /
  `data-dig-capsule` attributes plus the per-resource proof tally as
  `data-dig-ledger-passed` / `data-dig-ledger-failed` (the ledger feed itself is
  `dig://shields/ledger?host=…`), `dig://node` exposes its controller posture as
  `data-dig-node` (`no-node` / `needs-token` / `ready`), and the My Node Publish
  panel exposes the deploy posture as `data-dig-deploy`
  (`idle`…`done`/`error`) plus `data-dig-deploy-error` (a stable `DIG_ERR_*` code).

The pure JS surfaces have Node test harnesses (no Chromium build needed) under
`dig/`: `dig/provider/dig_provider.test.mjs`, `dig/dig_surfaces.test.mjs`,
`dig/newtab/dig_newtab.test.mjs`, `dig/node/dig_source_resolution.test.mjs`,
`dig/node/dig_node_controller.test.mjs`, `dig/node/dig_deploy_flow.test.mjs`,
`dig/node/dig_node.test.mjs`, `dig/shields/dig_ledger.test.mjs`, and
`dig/shields/dig_shields.test.mjs`.
`devutils/validate_patch_hunks.py` checks that the hand-edited `.patch` hunk
headers stay internally consistent.

## DIG Browser build layout

DIG-specific changes live in two places:

- **`patches/ungoogled-chromium/windows/windows-add-dig-protocol.patch`** — the
  `chia://` scheme registration (the C++ identifier `url::kDigScheme` maps to the
  string `"chia"`) + the native RPC/verify/decrypt handler and its crypto/URN
  helpers (`net/url_request/dig_{protocol_handler,crypto,urn}.{cc,h}`).
- **`patches/ungoogled-chromium/windows/windows-dig-branding.patch`** — product
  and company names (DIG Browser / DIG Network) in the channel `BRANDING` file.
- **`patches/ungoogled-chromium/windows/windows-dig-newtab.patch`** — the brand
  purple default theme tint and the branded start page wiring.
- **`dig/branding/`** — the DIG icon set (`product_logo_*.png`, `chrome.ico`)
  generated from the DIG logo, and **`dig/newtab/dig_newtab.html`** — the polished
  branded new-tab / start page.
- **`build.py` → `_apply_dig_branding()`** — overlays the binary brand assets
  (icons, new-tab page) and the user-visible product strings onto the Chromium
  tree after patches are applied (binary assets are not practical as text quilt
  patches).

All three patches are listed at the end of `patches/series` (after the upstream
ungoogled patches) in apply order.

> **Build-time-verify notes.** The native crypto/RPC C++ and the branding assets
> are validated independently (the crypto algorithm is covered by an end-to-end
> round-trip + fail-closed test against the canonical `digstore-core` contract).
> A few branding surfaces — the exact line anchors of the new-tab HTML resource
> and the `chromium_strings.grd` message elements — depend on the Chromium
> milestone and are confirmed during a full source build; the `.grd` strings are
> applied via a tolerant text substitution in `build.py` rather than line-anchored
> hunks so they survive rebases.

---

# ungoogled-chromium-windows

Windows packaging for [ungoogled-chromium](//github.com/Eloston/ungoogled-chromium).

## Downloads

[Download binaries from the Contributor Binaries website](//ungoogled-software.github.io/ungoogled-chromium-binaries/).

Or install using `winget install --id=eloston.ungoogled-chromium -e`.

**Source Code**: It is recommended to use a tag via `git checkout` (see building instructions below). You may also use `master`, but it is for development and may not be stable.

## Building

Google only supports [Windows 10 x64 or newer](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md#system-requirements). These instructions are tested on Windows 10 Pro x64.

NOTE: The default configuration will build 64-bit binaries for maximum security (TODO: Link some explanation). This can be changed to 32-bit by setting `target_cpu` to `"x86"` in `flags.windows.gn` or passing `--x86` as an argument to `build.py`.

### Setting up the build environment

**IMPORTANT**: Please setup only what is referenced below. Do NOT setup other Chromium compilation tools like `depot_tools`, since we have a custom build process which avoids using Google's pre-built binaries.

#### Setting up Visual Studio

[Follow the "Visual Studio" section of the official Windows build instructions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md#visual-studio).

* Make sure to read through the entire section and install/configure all the required components.
* If your Visual Studio is installed in a directory other than the default, you'll need to set a few environment variables to point the toolchains to your installation path. (Copied from [instructions for Electron](https://electronjs.org/docs/development/build-instructions-windows))
	* `vs2019_install = DRIVE:\path\to\Microsoft Visual Studio\2019\Community` (replace `2019` and `Community` with your installed versions)
	* `WINDOWSSDKDIR = DRIVE:\path\to\Windows Kits\10`
	* `GYP_MSVS_VERSION = 2019` (replace 2019 with your installed version's year)


#### Other build requirements

**IMPORTANT**: Currently, the `MAX_PATH` path length restriction (which is 260 characters by default) must be lifted in for our Python build scripts. This can be lifted in Windows 10 (v1607 or newer) with the official installer for Python 3.11 or newer (you will see a button at the end of installation to do this). See [Issue #345](https://github.com/Eloston/ungoogled-chromium/issues/345) for other methods for older Windows versions.

1. Setup the following:
    * 7-Zip
    * Python 3.11 or above
		* Can be installed using WinGet or the Microsoft Store.
		* If you don't plan on using the Microsoft Store version of Python:
			* Check "Add python.exe to PATH" before install.
			* At the end of the Python installer, click the button to lift the `MAX_PATH` length restriction.
			* Disable the `python3.exe` and `python.exe` aliases in `Settings > Apps > Advanced app settings > App execution aliases`. They will typically be referred to as "App Installer". See [this question on stackoverflow.com](https://stackoverflow.com/questions/57485491/python-python3-executes-in-command-prompt-but-does-not-run-correctly) to understand why.
			* Ensure that your Python directory either has a copy of Python named "python3.exe" or a symlink linking to the Python executable.
		* The `httplib2` module at version 0.22.0. This can be installed using `pip install httplib2==0.22.0`.
    * Make sure to lift the `MAX_PATH` length restriction, either by clicking the button at the end of the Python installer or by [following these instructions](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation?tabs=registry#:~:text=Enable,Later).
    * Git (to fetch all required ungoogled-chromium scripts)
        * During setup, make sure "Git from the command line and also from 3rd-party software" is selected. This is usually the recommended option.

### Building

Run in `Developer Command Prompt for VS` (as administrator):

```cmd
git clone --recurse-submodules https://github.com/ungoogled-software/ungoogled-chromium-windows.git
cd ungoogled-chromium-windows
# Replace TAG_OR_BRANCH_HERE with a tag or branch name
git checkout --recurse-submodules TAG_OR_BRANCH_HERE
python3 build.py
python3 package.py
```

A zip archive and an installer will be created under `build`.

**NOTE**: If the build fails, you must take additional steps before re-running the build:

* If the build fails while downloading the Chromium source code (which is during `build.py`), it can be fixed by removing `build\download_cache` and re-running the build instructions.
* If the build fails at any other point during `build.py`, it can be fixed by removing everything under `build` other than `build\download_cache` and re-running the build instructions. This will clear out all the code used by the build, and any files generated by the build.

An efficient way to delete large amounts of files is using `Remove-Item PATH -Recurse -Force`. Be careful however, files deleted by that command will be permanently lost.

## Developer info

### First-time setup

1. [Setup MSYS2](http://www.msys2.org/)
2. Run the following in a "MSYS2 MSYS" shell:

```sh
pacman -S quilt python3 vim tar dos2unix
# By default, there doesn't seem to be a vi command for less, quilt edit, etc.
ln -s /usr/bin/vim /usr/bin/vi
```

### Updating patches and pruning list

1. Start `Developer Command Prompt for VS` and `MSYS2 MSYS` shell and navigate to source folder
	1. `Developer Command Prompt for VS`
		* `cd c:\path\to\repo\ungoogled-chromium-windows`
	1. `MSYS2 MSYS`
		* `cd /path/to/repo/ungoogled-chromium-windows`
		* You can use Git Bash to determine the path to this repo
		* Or, you can find it yourself via `/<drive letter>/<path with forward slashes>`
1. Retrieve downloads
	**`Developer Command Prompt for VS`**
	* `mkdir "build\download_cache"`
	* `python3 ungoogled-chromium\utils\downloads.py retrieve -i downloads.ini -c build\download_cache`
1. Clone sources
	**`Developer Command Prompt for VS`**
	* `python3 ungoogled-chromium\utils\clone.py -o build\src`
1. Check for rust version change (see below)
1. Update pruning list
	**`Developer Command Prompt for VS`**
	* `python3 ungoogled-chromium\devutils\update_lists.py -t build\src --domain-regex ungoogled-chromium\domain_regex.list`
1. Unpack downloads
	**`Developer Command Prompt for VS`**
	* `python3 ungoogled-chromium\utils\downloads.py unpack -i downloads.ini -c build\download_cache build\src`
1. Apply ungoogled-chromium patches
	**`Developer Command Prompt for VS`**
	* `python3 ungoogled-chromium\utils\patches.py apply --patch-bin build\src\third_party\git\usr\bin\patch.exe build\src ungoogled-chromium\patches`
1. Update windows patches
	**`MSYS2 MSYS`**
	1. Setup shell to update patches
		* `source devutils/set_quilt_vars.sh`
	1. Go into the source tree
		* `cd build/src`
	1. Fix line breaks of files to patch
		* `grep -r ../../patches/ -e "^+++" | awk '{print substr($2,3)}' | xargs dos2unix`
	1. Use quilt to refresh patches. See ungoogled-chromium's [docs/developing.md](https://github.com/Eloston/ungoogled-chromium/blob/master/docs/developing.md#updating-patches) section "Updating patches" for more details
	1. Go back to repo root
		* `cd ../..`
	1. Sanity checking for consistency in series file
		* `./devutils/check_patch_files.sh`
1. Use Git to add changes and commit

### Update dependencies

**NOTE:** For all steps, update `downloads.ini` accordingly.

1. Check the [LLVM GitHub](https://github.com/llvm/llvm-project/releases/) for the latest version of LLVM.
	1. Download `LLVM-*-win64.exe` file.
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
1. Check the esbuild version in file `build/src/third_party/devtools-frontend/src/DEPS` and find the closest release in the [esbuild GitHub](https://github.com/evanw/esbuild/releases) to it.
	* Example: `version:3@0.24.0.chromium.2` should be `0.24.0`
1. Check the ninja version in file `build/src/third_party/devtools-frontend/src/DEPS` and find the closest release in the [ninja GitHub](https://github.com/ninja-build/ninja/releases/) to it.
	1. Download the `ninja-win.zip` file.
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
1. Check the [Git GitHub](https://github.com/git-for-windows/git/releases/) for the latest version of Git.
	1. Get the SHA-256 checksum for `PortableGit-<version>-64-bit.7z.exe`.
1. Check for commit hash changes of `src` submodule in `third_party/microsoft_dxheaders` (e.g. using GitHub `https://github.com/chromium/chromium/tree/<version>/third_party/microsoft_dxheaders`).
	1. Replace `version` with the Chromium version in `ungoogled-chromium/chromium_version.txt`.
1. Check the node version changes in `third_party/node/update_node_binaries` (e.g. using GitHub `https://github.com/chromium/chromium/tree/<version>/third_party/node/update_node_binaries`).
	1. Download the "Standalone Binary" version from the [NodeJS website](https://nodejs.org/en/download).
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
1. Check for version changes of windows rust crate (`third_party/rust/windows_x86_64_msvc/`).
	1. Download rust crate zip file.
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
	1. Update `patches/ungoogled-chromium/windows/windows-fix-building-with-rust.patch` accordingly.

### Update rust
1. Check `RUST_REVISION` constant in file `tools/rust/update_rust.py` in build root.
	* Example: Revision could be `f7b43542838f0a4a6cfdb17fbeadf45002042a77`
1. Get date for nightly rust build from the Rust GitHub page: `https://github.com/rust-lang/rust/commit/f7b43542838f0a4a6cfdb17fbeadf45002042a77`
	1. Replace `RUST_REVISION` with the obtained value
	1. Adapt `downloads.ini` accordingly
	* Example: The above revision corresponds to the nightly build date `2025-03-14` (`YYYY-mm-dd`)
1. Download nightly rust build from: `https://static.rust-lang.org/dist/<build-date>/rust-nightly-x86_64-pc-windows-msvc.tar.gz`
	1. Replace `build-date` with the obtained value
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
	1. Extract archive
	1. Execute `rustc\bin\rustc.exe -V` to get rust version string
	1. Adapt `patches\ungoogled-chromium\windows\windows-fix-building-with-rust.patch` accordingly
1. Download nightly rust build from: `https://static.rust-lang.org/dist/<build-date>/rust-nightly-i686-pc-windows-msvc.tar.gz`
	1. Replace `build-date` with the obtained value
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
1. Download nightly rust build from: `https://static.rust-lang.org/dist/<build-date>/rust-nightly-aarch64-pc-windows-msvc.tar.gz`
	1. Replace `build-date` with the obtained value
	1. Get the SHA-512 checksum using `sha512sum` in **`MSYS2 MSYS`**.
## License

See [LICENSE](LICENSE)
