/* ============================================================
   config.js — Onde o cliente encontra o servidor WebSocket.

   Em desenvolvimento (localhost) aponta para o servidor local.
   Em produção, troque a URL abaixo pela do seu serviço no Render
   (use wss:// — WebSocket seguro — pois o Cloudflare Pages é HTTPS).
   ============================================================ */

(function () {
  var host = location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1";

  // >>> EDITE AQUI com a URL do seu servidor no Render <<<
  var PRODUCTION_WS = "wss://subir-juntos-server.onrender.com/";

  // Permite sobrescrever via ?server=wss://... (útil para testes)
  var override = new URLSearchParams(location.search).get("server");

  window.GRUDADOS_CONFIG = {
    serverUrl: override || (isLocal ? "ws://" + host + ":8080" : PRODUCTION_WS),
  };
})();
