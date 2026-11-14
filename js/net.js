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
      emit("open");
      while (queue.length) ws.send(JSON.stringify(queue.shift()));
    };

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.t === "welcome") myId = msg.id;
      emit(msg.t, msg);
    };

    ws.onclose = function () {
      connected = false;
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
