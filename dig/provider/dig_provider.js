// DIG Browser injected wallet provider (CHIP-0002 `window.chia`).
//
// Injected into every page's main world at document start. It proxies CHIP-0002
// requests to the browser's built-in Chia wallet over loopback
// (http://127.0.0.1:9777/api/wc/request). 127.0.0.1 is a "potentially
// trustworthy" origin, so this works from https pages without a mixed-content
// error. Security is the wallet's per-origin approval gate: the wallet reads the
// unspoofable HTTP Origin header and refuses key/sign methods until the user
// approves this site in the DIG wallet's Connections view.
(function () {
  if (window.chia) return; // never clobber an already-present provider
  var ENDPOINT = "http://127.0.0.1:9777/api/wc/request";
  var listeners = {};

  function emit(ev, data) {
    (listeners[ev] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { /* a listener must not break dispatch */ }
    });
  }

  async function rpc(method, params) {
    var res;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: method, params: params || {} }),
      });
    } catch (e) {
      var ne = new Error("DIG wallet is not reachable");
      ne.code = -1;
      throw ne;
    }
    if (res.status === 202) {
      var pe = new Error("Connection pending approval in the DIG wallet");
      pe.code = 4001;
      pe.pending = true;
      throw pe;
    }
    var json = {};
    try { json = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      var fe = new Error(json.error || "DIG wallet error " + res.status);
      fe.code = res.status;
      throw fe;
    }
    return json.data;
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
