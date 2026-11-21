/* ============================================================
   net.js — Camada de rede do cliente (WebSocket).
   Expõe GameNet: connect, send e um despachante de mensagens
   por tipo (on('state', fn), etc). Reconecta sozinho no lobby.
   ============================================================ */

var GameNet = (function () {
  var ws = null;
  var handlers = {};
  var myId = null;
  var queue = []; // mensagens enfileiradas antes de abrir
  var connected = false;

  // ---- Telemetria de rede (p/ o HUD de diagnóstico) -----------------
  var PING_EVERY = 1500; // frequência do ping (ms)
  var pingTimer = null;
  var stats = {
    ping: null, // RTT do último ping (ms)
    pingAvg: null, // média móvel do RTT (ms)
    pingMax: null, // pior RTT recente (ms)
    rxMsgs: 0, // total de mensagens recebidas (contador acumulado)
    rxBytes: 0, // total de bytes recebidos (contador acumulado)
    server: null, // carga do servidor: {rooms, players, simMs, simGap}
  };
  var pingWindow = []; // últimos RTTs, p/ média e pico

  function now() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  function startPinging() {
    stopPinging();
    pingTimer = setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "ping", ts: now() }));
      }
    }, PING_EVERY);
  }
  function stopPinging() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function recordPong(msg) {
    if (typeof msg.ts === "number") {
      var rtt = Math.max(0, Math.round(now() - msg.ts));
      stats.ping = rtt;
      pingWindow.push(rtt);
      if (pingWindow.length > 8) pingWindow.shift();
      var sum = 0,
        max = 0;
      for (var i = 0; i < pingWindow.length; i++) {
        sum += pingWindow[i];
        if (pingWindow[i] > max) max = pingWindow[i];
      }
      stats.pingAvg = Math.round(sum / pingWindow.length);
      stats.pingMax = max;
    }
    stats.server = {
      rooms: msg.rooms,
      playing: msg.playing,
      players: msg.players,
      simMs: msg.simMs,
      simGap: msg.simGap,
      simMsMax: msg.simMsMax,
      rss: msg.rss,
    };
  }

  function emit(type, payload) {
    (handlers[type] || []).forEach(function (fn) {
      fn(payload);
    });
  }

  function connect() {
    var url = window.GRUDADOS_CONFIG.serverUrl;
    ws = new WebSocket(url);

    ws.onopen = function () {
      connected = true;
      startPinging();
      emit("open");
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
    };

    ws.onmessage = function (ev) {
      stats.rxMsgs++;
      stats.rxBytes += ev.data && ev.data.length ? ev.data.length : 0;
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.t === "welcome") myId = msg.id;
      if (msg.t === "pong") {
        recordPong(msg);
        return; // consumido aqui; não precisa de handler externo
      }
      emit(msg.t, msg);
    };

    ws.onclose = function () {
      connected = false;
      stopPinging();
      stats.ping = null;
      stats.server = null;
      emit("close");
    };

    ws.onerror = function () {
      emit("neterror");
    };
  }

  return {
    connect: connect,
    isConnected: function () {
      return connected;
    },
    myId: function () {
      return myId;
    },
    stats: function () {
      return stats;
    },
    on: function (type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
    },
    send: function (obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      } else {
        queue.push(obj);
      }
    },
  };
})();
