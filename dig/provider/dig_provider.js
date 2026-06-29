// DIG Browser injected wallet provider (CHIP-0002 `window.chia`).
//
// Injected into every page's main world at document start. It reaches the
// browser's built-in Chia wallet through a NATIVE bridge — `window.__digWalletRpc`
// (a frame-scoped Mojo pipe to the browser process, installed by the renderer
// just before this script) — NOT the network. There is no fetch, no loopback
// HTTP, no http/https mismatch, and crucially nothing for the page's
// Content-Security-Policy to block, so the wallet is reachable on ANY dapp.
//
// Security: the browser process supplies the calling frame's UNSPOOFABLE
// committed origin to the wallet's per-origin approval gate; key/sign methods
// stay refused until the user approves this site in the DIG wallet.
(function () {
  if (window.chia) return; // never clobber an already-present provider
  var listeners = {};

  // ---- Self-description (agent/dapp introspection) --------------------------
  // The provider's own version. Substituted at build time from the running
  // browser build (build.py replaces the {{VERSION}} token in this file before
  // it is compiled into the renderer); if the token is left unreplaced (e.g.
  // running the raw source) it falls back to the literal so callers always read
  // a string, never `undefined`.
  var PROVIDER_VERSION = "{{VERSION}}";
  if (PROVIDER_VERSION === "{{" + "VERSION}}") PROVIDER_VERSION = "0.0.0-dev";

  // The CHIP-0002 / Chia method surface this provider supports, byte-aligned
  // with the dig-chrome-extension's wallet-methods.mjs WALLET_METHODS so a dapp
  // sees the SAME catalogue on the native DIG Browser and on the extension.
  // Every entry is fully namespaced (chip0002_* | chia_*).
  var WALLET_METHODS = [
    // CHIP-0002 core (asset-generic).
    "chip0002_chainId",
    "chip0002_connect",
    "chip0002_getPublicKeys",
    "chip0002_signMessage",
    "chip0002_signCoinSpends",
    "chip0002_getAssetBalance",
    "chip0002_getAssetCoins",
    // chia_* (addresses, sends, NFTs, DIDs, offers).
    "chia_getAddress",
    "chia_signMessageByAddress",
    "chia_send",
    "chia_getTransactions",
    "chia_getNfts",
    "chia_transferNft",
    "chia_mintNft",
    "chia_bulkMintNfts",
    "chia_getDids",
    "chia_createDidWallet",
    "chia_transferDid",
    "chia_getOfferSummary",
    "chia_createOffer",
    "chia_takeOffer",
    "chia_cancelOffer"
  ];

  // Stable, documented thrown-error codes. Aligned to the standard injected-
  // wallet (EIP-1193 / CHIP-0002 / WalletConnect-Sage) convention so an agent
  // can branch on `err.code` without string-matching prose:
  //   4001 user rejected · 4100 unauthorized (origin not approved / can't sign)
  //   4200 unsupported method · 4900 wallet unreachable / malformed transport.
  var ERROR_CODES = {
    USER_REJECTED: 4001,
    UNAUTHORIZED: 4100,
    UNSUPPORTED_METHOD: 4200,
    WALLET_UNREACHABLE: 4900
  };

  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { /* a listener must not break dispatch */ }
    });
  }

  // Forward one request to the native bridge, resolving with the raw envelope
  // string (or "" if the bridge is absent / the wallet is unreachable).
  function nativeCall(reqJson) {
    return new Promise(function (resolve) {
      var b = window.__digWalletRpc;
      if (!b || typeof b.request !== "function") { resolve(""); return; }
      try {
        b.request(reqJson, function (resp) { resolve(resp || ""); });
      } catch (e) {
        resolve("");
      }
    });
  }

  // One CHIP-0002 RPC. The bridge returns the wallet's JSON envelope
  // {"status":<u16>,"body":<json>}; map it to the same resolve/reject + error
  // shapes the dapp ecosystem expects (mirrors the WalletConnect→Sage path).
  async function rpc(method, params) {
    var raw = await nativeCall(
      JSON.stringify({ method: method, params: params || {} })
    );
    if (!raw) {
      var ne = new Error("DIG wallet is not reachable");
      ne.code = ERROR_CODES.WALLET_UNREACHABLE;
      throw ne;
    }
    var env;
    try { env = JSON.parse(raw); } catch (_) { env = null; }
    if (!env) {
      var be = new Error("DIG wallet returned a malformed response");
      be.code = ERROR_CODES.WALLET_UNREACHABLE;
      throw be;
    }
    var status = env.status || 0;
    var body = env.body || {};
    if (status === 202) {
      // Approval still pending in the wallet — caller's connect() retry loop
      // waits on this; standalone callers see the user-rejected-class code.
      var pe = new Error("Connection pending approval in the DIG wallet");
      pe.code = ERROR_CODES.USER_REJECTED;
      pe.pending = true;
      // Preserve the raw wallet status for callers that want the transport code.
      pe.status = status;
      throw pe;
    }
    if (status < 200 || status >= 300) {
      var fe = new Error(body.error || "DIG wallet error " + status);
      // Map the wallet's HTTP-like status onto the standard wallet error codes:
      // 401/403 → unauthorized (origin not approved / can't sign);
      // 404/501 → unsupported method; anything else → unreachable/transport.
      fe.code = (status === 401 || status === 403)
        ? ERROR_CODES.UNAUTHORIZED
        : (status === 404 || status === 501)
          ? ERROR_CODES.UNSUPPORTED_METHOD
          : ERROR_CODES.WALLET_UNREACHABLE;
      // Preserve the raw wallet status so callers can still see the transport code.
      fe.status = status;
      throw fe;
    }
    return body.data;
  }

  // connect() blocks until the user approves this origin (or rejects / times out).
  async function connect(eager) {
    var deadline = Date.now() + 120000;
    for (;;) {
      try {
        var r = await rpc("chip0002_connect", { eager: !!eager });
        window.chia.isConnected = true;
        emit("connect", r);
        return r;
      } catch (e) {
        if (e.pending && Date.now() < deadline) {
          await new Promise(function (res) { setTimeout(res, 1200); });
          continue;
        }
        throw e;
      }
    }
  }

  // Normalise a method to its canonical namespaced form (mirrors the extension's
  // wallet-methods.mjs normalizeMethod): bare "getPublicKeys" → "chip0002_…";
  // already-namespaced chip0002_*/chia_* names pass through unchanged.
  function normalizeMethod(method) {
    if (!method) return method;
    return /^(chip0002_|chia_)/.test(method) ? method : "chip0002_" + method;
  }

  window.chia = {
    isDIG: true,
    isConnected: false,
    // --- Self-description: an agent/dapp can introspect the provider without
    // reading source. version/info/methods/errorCodes are the machine surface;
    // the typed contract is dig/provider/dig_provider.d.ts. ---
    version: PROVIDER_VERSION,
    info: {
      isDIG: true,
      // brokered in-process by the browser's native wallet (not WalletConnect).
      transport: "native",
      // distinguishes the native DIG Browser provider from the extension's.
      edition: "browser",
      // the user-facing scheme this browser registers (SYSTEM.md canonical).
      scheme: "chia",
      version: PROVIDER_VERSION
    },
    // The supported CHIP-0002/chia_* method catalogue (also reachable over the
    // wire via request({method:"chip0002_getMethods"})).
    methods: WALLET_METHODS.slice(),
    // The stable thrown-error code enum (documented in dig_provider.d.ts).
    errorCodes: ERROR_CODES,
    // CHIP-0002 entrypoint. Accepts both the bare ("getPublicKeys") and namespaced
    // ("chip0002_getPublicKeys", "chia_getAddress") method names.
    request: function (args) {
      var method = args && args.method;
      var params = args && args.params;
      // Introspection RPC: answered locally, never forwarded to the bridge, so
      // an agent can enumerate the surface even before the wallet is reachable.
      if (method === "chip0002_getMethods" || method === "getMethods") {
        return Promise.resolve(WALLET_METHODS.slice());
      }
      if (method === "connect" || method === "chip0002_connect") {
        return connect(params && params.eager);
      }
      return rpc(normalizeMethod(method), params);
    },
    connect: connect,
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off: function (ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== fn; });
    },
  };

  window.dispatchEvent(new Event("chia#initialized"));
})();
