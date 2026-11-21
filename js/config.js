/* ============================================================
   config.js — Onde o cliente encontra o servidor WebSocket.

   Em desenvolvimento (localhost) aponta para o servidor local.
   Em produção, troque a URL abaixo pela do seu servidor (use wss:// —
   WebSocket seguro — pois o Cloudflare Pages é HTTPS).

   Para jogadores no Brasil, recomenda-se hospedar o servidor numa
   região de São Paulo (Fly.io "gru", veja server/fly.toml) para cortar
   a latência — o endereço fica como "wss://<seu-app>.fly.dev/".
   ============================================================ */

(function () {
  var host = location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1";

  // >>> EDITE AQUI com a URL do seu servidor (ex.: Fly.io em São Paulo) <<<
  var PRODUCTION_WS = "wss://estudio-elemental-subir-presos.fly.dev/";

  // Permite sobrescrever via ?server=wss://... (útil para testes)
  var override = new URLSearchParams(location.search).get("server");

  window.GRUDADOS_CONFIG = {
    serverUrl: override || (isLocal ? "ws://" + host + ":8080" : PRODUCTION_WS),
  };
})();
