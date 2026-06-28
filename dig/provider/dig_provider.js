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
      ne.code = -1;
      throw ne;
    }
    var env;
    try { env = JSON.parse(raw); } catch (_) { env = null; }
    if (!env) {
      var be = new Error("DIG wallet returned a malformed response");
      be.code = -1;
      throw be;
    }
    var status = env.status || 0;
    var body = env.body || {};
    if (status === 202) {
      var pe = new Error("Connection pending approval in the DIG wallet");
      pe.code = 4001;
      pe.pending = true;
      throw pe;
    }
    if (status < 200 || status >= 300) {
      var fe = new Error(body.error || "DIG wallet error " + status);
      fe.code = status;
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

  window.chia = {
    isDIG: true,
    isConnected: false,
    // CHIP-0002 entrypoint. Accepts both the bare ("getPublicKeys") and namespaced
    // ("chip0002_getPublicKeys", "chia_getAddress") method names.
    request: function (args) {
      var method = args && args.method;
      var params = args && args.params;
      if (method === "connect" || method === "chip0002_connect") {
        return connect(params && params.eager);
      }
      var m = /^(chip0002_|chia_)/.test(method) ? method : "chip0002_" + method;
      return rpc(m, params);
    },
    connect: connect,
    on: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    off: function (ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter(function (x) { return x !== fn; });
    },
  };

  window.dispatchEvent(new Event("chia#initialized"));
})();
