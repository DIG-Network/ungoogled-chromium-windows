# #30 — chrome://settings DIG cache section (Mojo) — execution blueprint

Backend DONE: dig-node `cache.getConfig`/`cache.setCapBytes`/`cache.clear` RPC (committed digstore 26710f9) + dig_runtime.dll rebuilt (target/release). Browser handler reaches them via `dig::CallDigRpc` FFI.

Already created in C:\d (head start):
- `ui/webui/resources/cr_components/dig_cache/dig_cache.mojom` (DigCacheHandler: GetConfig/SetCapBytes/Clear — direct handler, no factory)
- `chrome/browser/resources/settings/dig_page/dig_page.html`

## Remaining files (verified patterns from the 149 tree — clone customize_color_scheme_mode)

1. **`ui/webui/resources/cr_components/dig_cache/BUILD.gn`** — `mojom("mojom")` (sources=[dig_cache.mojom], public_deps=[//mojo/public/mojom/base], webui_module_path="chrome://resources/cr_components/dig_cache/") + `build_webui("build")` shipping ONLY the mojom-webui.ts (ts_files=[], static_files=[], mojo_files=["$target_gen_dir/dig_cache.mojom-webui.ts"], mojo_files_deps=[":mojom_ts__generator"], generate_grdp=true, grd_prefix="cr_components_dig_cache", grd_resource_path_prefix=rebase_path(".","//ui/webui/resources")). Clone customize_color_scheme_mode/BUILD.gn:1-62.
2. **grdp aggregation** — register the generated `cr_components_dig_cache_resources.grdp` into the shared cr_components resources grd (find where customize_color_scheme_mode's grdp is `<part>`-included — likely ui/webui/resources/BUILD.gn or a cr_components_resources.grd). UNRESOLVED — locate by grepping for `cr_components_customize_color_scheme_mode_resources.grdp`.
3. **`ui/webui/BUILD.gn`** static_library("webui") public_deps += `//ui/webui/resources/cr_components/dig_cache:mojom` (lines ~49-56, beside customize_color_scheme_mode:mojom). The load-bearing C++ binding edit.
4. **`chrome/browser/ui/webui/cr_components/dig_cache/dig_cache_handler.{h,cc}`** — ctor(PendingReceiver<DigCacheHandler>) + mojo::Receiver member; methods post `dig::CallDigRpc(json)` to base::MayBlock thread (cache.getConfig/setCapBytes/clear), parse JSON, run callback. Add sources to `chrome/browser/ui/BUILD.gn` static_library("ui") ~line 1352.
5. **`settings_ui.h/.cc`** — include dig_cache.mojom.h + handler.h; add `void BindInterface(PendingReceiver<dig_cache::mojom::DigCacheHandler>)` + `unique_ptr<DigCacheHandler> dig_cache_handler_` member; impl constructs the handler. (Direct, NOT factory — simpler than customize's factory; .Add<Handler>() maps to BindInterface(PendingReceiver<Handler>).)
6. **`chrome/browser/chrome_browser_interface_binders_webui_parts_desktop.cc`** ~661-671 — `.Add<dig_cache::mojom::DigCacheHandler>()` in the ForWebUI<settings::SettingsUI>() chain + `#include ".../dig_cache.mojom.h"` (~line 139).
7. **`dig_page/dig_page.ts`** — Polymer element (plan skeleton); import `DigCacheHandler` from `chrome://resources/cr_components/dig_cache/dig_cache.mojom-webui.js` (ABSOLUTE path); `DigCacheHandler.getRemote()`.
8. **settings BUILD.gn** (`chrome/browser/resources/settings/BUILD.gn`) — web_component_files += "dig_page/dig_page.ts"; AND add a ts_dep on the dig_cache mojom .ts so the import resolves at compile (UNRESOLVED — how the settings bundle depends on a cr_component mojom; check how settings imports an existing cr_components mojom-webui.js, e.g. customize_color_scheme_mode, + mirror the ts_deps/extra dep).
9. **routing edits**: route.ts (r.DIG=r.BASIC.createSection('/dig','dig',...)), router.ts (SettingsRoutes: DIG), settings_menu/settings_menu.html (<a href="/dig">), settings_main/settings_main.html (<div slot="view" id="dig"><settings-dig-page>), page_visibility.ts (dig key), ensure_lazy_loaded.ts ('settings-dig-page'), lazy_load.ts (import './dig_page/dig_page.js'), icons.html (settings:dig icon).
10. **i18n**: settings_localized_strings_provider.cc AddDigStrings() {digPageTitle→IDS_SETTINGS_DIG, digCacheLimitLabel/Sublabel, digClearCacheButton} + call in dispatcher ~4265; chrome/app/settings_strings.grdp <message> defs for each IDS_.

## Build + verify
gn gen out\Default ; ninja -C out\Default chrome (settings WebUI bundle + mojom gen + C++). Expect 2-4 iterations (grdp aggregation, settings ts-dep, mojom path). Stage dig_runtime.dll. Verify chrome://settings/dig.

## Sub-risks — RESOLVED (both wirings located)
- (2) grdp aggregation → `ui/webui/resources/BUILD.gn` includes the cr_components grdps (beside customize_color_scheme_mode); add dig_cache's there.
- (8) settings TS dep → `chrome/browser/resources/settings/BUILD.gn:462-467` ts_deps lists each cr_component's `:build_ts`; add `"//ui/webui/resources/cr_components/dig_cache:build_ts",` so the dig_cache.mojom-webui import resolves at settings TS-compile.

All wiring points now identified — the build is fully specified + de-risked. ~16 files + a heavy settings-WebUI rebuild (gn gen + ninja chrome, ~15-20 min) + likely 1-2 iterations. Then stage dig_runtime.dll, verify chrome://settings/dig.
