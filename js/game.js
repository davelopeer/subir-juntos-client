/* ============================================================
   game.js — Cliente do jogo Grudados (online).
   O servidor manda a física; aqui apenas:
     - cuidamos do lobby (nome, criar/entrar, sala de espera);
     - lemos os inputs (teclado + toque) e enviamos ao servidor;
     - prevemos o próprio boneco localmente (client-side prediction) e
       interpolamos os remotos a partir do estado recebido, para um
       movimento suave e responsivo mesmo com latência alta;
     - mostramos o HUD de altitude (metros).
   Arte e som reaproveitados do jogo original (canvas + Web Audio).
   ============================================================ */

(function () {
  "use strict";

  var canvas = document.getElementById("game");
  var ctx = canvas.getContext("2d");
  var muteBtn = document.getElementById("muteBtn");

  var VIEW_W = canvas.width; // 960
  var VIEW_H = canvas.height; // 600

  // ---- DOM do lobby --------------------------------------------------
  var overlay = document.getElementById("overlay");
  var touch = document.getElementById("touch");
  var screens = {
    name: document.getElementById("screen-name"),
    home: document.getElementById("screen-home"),
    room: document.getElementById("screen-room"),
    win: document.getElementById("screen-win"),
  };
  var nameInput = document.getElementById("nameInput");
  var joinInput = document.getElementById("joinInput");
  var helloName = document.getElementById("helloName");
  var roomCodeEl = document.getElementById("roomCode");
  var playerListEl = document.getElementById("playerList");
  var charGridEl = document.getElementById("charGrid");
  var roomStatusEl = document.getElementById("roomStatus");
  var startBtn = document.getElementById("startBtn");
  var homeError = document.getElementById("homeError");
  var roomError = document.getElementById("roomError");
  var winTimeEl = document.getElementById("winTime");
  var winHintEl = document.getElementById("winHint");
  var netBanner = document.getElementById("netBanner");

  // ---- Estado do cliente --------------------------------------------
  var phase = "name"; // name | home | room | playing | win
  var world = null; // dados do mapa vindos do servidor
  var youId = null;
  var hostId = null;
  var playersMeta = {}; // id -> {name, charIndex}
  var order = []; // ordem dos jogadores (corrente da corda)
  var targets = {}; // id -> alvo de interpolação {x,y,facing,bob,grounded,jumped}
  var rpos = {}; // id -> posição renderizada (suavizada)
  var cam = { x: 0, y: 0 };
  var elapsed = 0;

  // ---- Relógio de render (corrige a "travada" cosmética) -----------
  // ANTES: uma única variável `tick` era incrementada a cada quadro de
  // render (~60/s) E sobrescrita a cada snapshot (~30/s). Como as duas
  // cadências não batem (e têm jitter), o `tick` ficava não-monotônico e
  // TUDO que é desenhado a partir dele pulava: nuvens, pêndulos, pássaros,
  // brilho da porta, asa… (por isso "até as nuvens travam e reaparecem").
  // AGORA: `serverTick` guarda o tick autoritativo do último snapshot e
  // `renderTick` (float) avança por TEMPO REAL, apenas seguindo de perto o
  // servidor — suave e sem serrilhado, mas ainda sincronizado com os perigos.
  var serverTick = 0; // tick do último snapshot (autoritativo)
  var serverTickAt = 0; // performance.now() de quando o snapshot chegou
  var renderTick = 0; // relógio suave usado SÓ para desenhar

  // HUD de altitude
  var bestMeters = 0;
  var milestone = 0; // último múltiplo de 100 alcançado
  var banner = { text: "", t: 0 };

  // Perigos: mesma margem usada no servidor para os pássaros "darem a volta".
  var BIRD_MARGIN = 80;

  // ---- HUD de diagnóstico (ping / FPS / travadas) -------------------
  // Fica sempre na tela para o jogador conseguir reportar onde está o
  // gargalo: render do próprio aparelho, rede, ou o servidor. Tecla "P"
  // esconde/mostra.
  var diag = {
    show: true,
    frames: 0, // frames desde a última amostragem
    fps: 0, // quadros por segundo (render local)
    stateCount: 0, // snapshots recebidos desde a última amostragem
    stateRate: 0, // snapshots/s vindos do servidor (ideal ~30)
    lastStateAt: 0, // instante do último snapshot (p/ medir intervalos)
    gapMax: 0, // maior intervalo entre snapshots na janela (ms) → travadas
    gapMaxShown: 0, // valor exibido (decai devagar p/ picos ficarem visíveis)
    lastSampleAt: 0, // instante da última amostragem de 1 s
    rxMsgs: 0, // snapshot anterior do contador de mensagens
    rxBytes: 0, // snapshot anterior do contador de bytes
    kbps: 0, // tráfego de entrada (KB/s)

    // --- métricas que apontam a CAMADA do problema -----------------
    // JITTER: desvio-padrão do intervalo entre snapshots. Alto = rede
    // instável → o buffer de interpolação dos remotos sofre.
    gapSum: 0,
    gapSqSum: 0,
    gapN: 0,
    jitter: 0,
    // STARVE: vezes/s que o buffer de um remoto esvaziou (congela e pula).
    starveCount: 0,
    starveRate: 0,
    // SNAP: teleportes do PRÓPRIO boneco (reconciliação dura) e a última
    // divergência em px (mostra o quão perto do limiar de snap você anda).
    snapCount: 0,
    snapRate: 0,
    lastDrift: 0,
    // JANK: pior quadro único da janela (ms). Alto = engasgo do aparelho.
    jankMax: 0,
    jankShown: 0,
    // BUFFER: profundidade média do buffer de interpolação dos remotos.
    bufDepth: 0,
    // VEREDITO: camada mais provável do gargalo (heurística, no drawDiag).
  };

  // Entrada local do jogador
  var input = { left: false, right: false, jump: false };
  var lastSent = { left: false, right: false, jump: false };
  var keys = {};

  // ---- Predição/interpolação (netcode) ------------------------------
  // Física do jogador local — espelha server/src/room.js (passo a 60 Hz).
  // Serve só para PREVER o próprio boneco entre snapshots; o servidor
  // continua autoritativo e reconcilia a posição a cada estado recebido.
  var PHYS = {
    GRAVITY: 0.35,
    MOVE_ACCEL: 0.9,
    AIR_ACCEL: 0.6,
    MAX_SPEED: 4.3,
    FRICTION: 0.78,
    JUMP_VEL: -10.7,
    MAX_FALL: 12.8,
    HW: 12, // meia-largura da "caixa" do personagem
    // Corda: mesmos valores de server/src/room.js. A previsão local também
    // aplica a mola (senão o jogador pendurado "cai" na previsão e o
    // reconcile o puxa de volta a cada snapshot → looping sobe-e-desce).
    ROPE_LEN: 120,
    ROPE_K: 0.06,
    ROPE_DAMP: 0.12,
  };
  var STEP_MS = 1000 / 60; // passo fixo da simulação local
  // Atraso de interpolação dos remotos, medido em TICKS do servidor (não em ms
  // de relógio local). Interpolar na linha do tempo do servidor imuniza contra
  // rajadas de rede: mesmo que 3 snapshots cheguem juntos, eles ficam espaçados
  // corretamente por tick, então não há o "corre e congela" (STARVE). O valor é
  // ADAPTATIVO: cresce quando há starve (rede pior) e volta ao mínimo quando
  // acalma. Troca um pouco de latência visual por fluidez (coop, sem PvP).
  var DELAY_TICKS = 7; // ~116 ms (ajustado 1x/s em frame())
  var DELAY_TICKS_MIN = 7;
  var DELAY_TICKS_MAX = 20; // ~333 ms
  // Limiar de snap: só teleporta a previsão quando a divergência é enorme
  // (renascimento move centenas de px). A esticada da corda e os trancos de
  // perigo ficam abaixo disso e são absorvidos pelo blend suave — sem o
  // "teleporte do nada" nem a travada de zerar a velocidade a cada snapshot.
  var SNAP_DIST = 160; // divergência (px) acima da qual damos snap
  var RECONCILE_K = 0.3; // correção suave de drift por snapshot (puxa mais rápido)

  var me = null; // estado físico previsto do jogador local
  var buf = {}; // id -> histórico de snapshots p/ interpolar remotos
  var simAcc = 0; // acumulador do passo fixo
  var lastFrameTs = null;

  // ============================================================
  //  Rede
  // ============================================================
  GameNet.on("open", function () {
    hideBanner();
  });
  GameNet.on("close", function () {
    showBanner("Conexão perdida. Recarregue a página para reconectar.");
  });
  GameNet.on("neterror", function () {
    showBanner("Não foi possível falar com o servidor.");
  });

  GameNet.on("hello_ok", function () {
    go("home");
  });

  GameNet.on("room", function (msg) {
    hostId = msg.hostId;
    order = msg.players.map(function (p) {
      return p.id;
    });
    playersMeta = {};
    msg.players.forEach(function (p) {
      playersMeta[p.id] = { name: p.name, charIndex: p.charIndex };
    });
    if (phase !== "playing") renderRoom(msg);
  });

  GameNet.on("error", function (msg) {
    if (phase === "home") homeError.textContent = msg.msg;
    else if (phase === "room") roomError.textContent = msg.msg;
  });

  GameNet.on("world", function (msg) {
    world = msg.world;
    youId = msg.youId;
    hostId = msg.hostId;
    order = msg.players.map(function (p) {
      return p.id;
    });
    playersMeta = {};
    msg.players.forEach(function (p) {
      playersMeta[p.id] = { name: p.name, charIndex: p.charIndex };
    });
    targets = {};
    rpos = {};
    me = null;
    buf = {};
    simAcc = 0;
    lastFrameTs = null;
    bestMeters = 0;
    milestone = 0;
    banner = { text: "", t: 0 };
    // câmera começa na base
    cam.x = 0;
    cam.y = world.worldH - VIEW_H;
    go("playing");
    GameAudio.start();
  });

  GameNet.on("state", function (msg) {
    var now = performance.now();
    // tick autoritativo p/ o relógio de render seguir (ver renderTick).
    serverTick = msg.tick;
    serverTickAt = now;
    elapsed = msg.elapsed;
    order = msg.players.map(function (p) {
      return p.id;
    });
    // diagnóstico: conta snapshots, mede o maior intervalo entre eles
    // (gap grande = "travada") e acumula p/ o desvio-padrão (JITTER).
    diag.stateCount++;
    if (diag.lastStateAt) {
      var gap = now - diag.lastStateAt;
      if (gap > diag.gapMax) diag.gapMax = gap;
      diag.gapSum += gap;
      diag.gapSqSum += gap * gap;
      diag.gapN++;
    }
    diag.lastStateAt = now;
    msg.players.forEach(function (p) {
      targets[p.id] = p;
      if (p.id === youId) {
        // jogador local: inicia/reconcilia a previsão (Parte B).
        if (!me) me = initMe(p);
        else reconcile(me, p);
        if (!rpos[p.id]) {
          rpos[p.id] = {
            x: p.x,
            y: p.y,
            facing: p.facing,
            bob: p.bob,
            vx: 0,
            vy: 0,
            grounded: p.grounded,
          };
        }
        // o pulo do próprio boneco já soa na previsão; ignora o flag do
        // servidor aqui para não tocar duas vezes.
      } else {
        // remotos: alimenta o buffer de interpolação (Parte C).
        pushSample(p.id, now, p);
        if (p.jumped) GameAudio.sfxJump();
        if (!rpos[p.id]) {
          // primeira vez: aparece já na posição certa
          rpos[p.id] = { x: p.x, y: p.y, facing: p.facing, bob: p.bob };
        }
      }
    });
    if (msg.phase === "win" && phase !== "win") enterWin(msg.elapsed);
  });

  GameNet.on("win", function (msg) {
    enterWin(msg.time);
  });

  // ============================================================
  //  Navegação de telas
  // ============================================================
  function go(p) {
    phase = p;
    for (var k in screens) screens[k].classList.add("hidden");
    homeError.textContent = "";
    roomError.textContent = "";
    if (p === "playing") {
      overlay.classList.add("hidden");
      touch.classList.remove("hidden");
    } else {
      overlay.classList.remove("hidden");
      touch.classList.add("hidden");
      if (screens[p]) screens[p].classList.remove("hidden");
    }
  }

  function renderRoom(msg) {
    go("room");
    roomCodeEl.textContent = msg.code;
    playerListEl.innerHTML = "";
    var myId = GameNet.myId();
    msg.players.forEach(function (p) {
      var ch = CHARACTERS[p.charIndex];
      var li = document.createElement("li");
      var dot = document.createElement("span");
      dot.className = "dot";
      // sem personagem escolhido ainda: bolinha neutra
      dot.style.background = ch ? ch.color : "rgba(255,255,255,0.25)";
      li.appendChild(dot);
      var nm = document.createElement("span");
      nm.textContent = p.name + (p.id === myId ? " (você)" : "");
      li.appendChild(nm);
      if (p.id === msg.hostId) {
        var tag = document.createElement("span");
        tag.className = "host-tag";
        tag.textContent = "host";
        li.appendChild(tag);
      }
      playerListEl.appendChild(li);
    });

    updateCharGrid(msg.players, myId);

    var n = msg.players.length;
    var amHost = GameNet.myId() === msg.hostId;
    var allChosen = msg.players.every(function (p) {
      return p.charIndex !== null && p.charIndex !== undefined;
    });
    if (n < msg.minToStart) {
      roomStatusEl.textContent =
        "Esperando mais jogadores… (mínimo " + msg.minToStart + ")";
    } else if (!allChosen) {
      roomStatusEl.textContent = "Esperando todos escolherem um personagem…";
    } else {
      roomStatusEl.textContent =
        n + "/" + msg.maxPlayers + " jogadores. Pronto para começar!";
    }
    startBtn.classList.toggle("hidden", !amHost);
    startBtn.disabled = !(amHost && n >= msg.minToStart && allChosen);
    if (!amHost) {
      roomStatusEl.textContent += " Aguardando o host iniciar.";
    }
  }

  // Canvases de preview dos cards (para animar o idle no lobby).
  var charCanvases = [];
  // Seleção atual do próprio jogador e quais personagens já são de outros.
  var myCharIndex = null;
  var takenByOther = {}; // index -> true

  // Monta os cards de personagem uma única vez.
  function buildCharGrid() {
    charGridEl.innerHTML = "";
    charCanvases = [];
    CHARACTERS.forEach(function (ch, i) {
      var card = document.createElement("button");
      card.className = "char-card";
      card.type = "button";
      var cv = document.createElement("canvas");
      cv.width = 56;
      cv.height = 56;
      cv.className = "char-canvas";
      var nm = document.createElement("span");
      nm.className = "char-name";
      nm.textContent = ch.name;
      var who = document.createElement("span");
      who.className = "char-who";
      card.appendChild(cv);
      card.appendChild(nm);
      card.appendChild(who);
      card.addEventListener("click", function () {
        if (takenByOther[i]) return; // de outro jogador: bloqueado
        // clicar no que já é meu deseleciona; senão, escolhe este
        GameNet.send({
          t: "choose",
          charIndex: myCharIndex === i ? null : i,
        });
      });
      charGridEl.appendChild(card);
      charCanvases.push(cv.getContext("2d"));
      CharSprites.drawPreview(charCanvases[i], i, cv.width, cv.height, 0);
    });
  }

  // Anima o idle dos previews do lobby (chamado no loop principal).
  function animatePreviews(now) {
    for (var i = 0; i < charCanvases.length; i++) {
      CharSprites.drawPreview(charCanvases[i], i, 56, 56, now);
    }
  }

  // Destaca a minha seleção, trava os personagens já tomados por outros
  // e mostra o dono de cada um. Personagens são exclusivos.
  function updateCharGrid(players, myId) {
    var byIndex = {}; // index -> jogador dono (único)
    myCharIndex = null;
    takenByOther = {};
    players.forEach(function (p) {
      if (p.charIndex === null || p.charIndex === undefined) return;
      byIndex[p.charIndex] = p;
      if (p.id === myId) myCharIndex = p.charIndex;
      else takenByOther[p.charIndex] = true;
    });
    var cards = charGridEl.children;
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("selected", i === myCharIndex);
      cards[i].classList.toggle("taken", !!takenByOther[i]);
      cards[i].disabled = !!takenByOther[i];
      var who = cards[i].querySelector(".char-who");
      var owner = byIndex[i];
      who.textContent = owner ? (owner.id === myId ? "você" : owner.name) : "";
    }
  }

  function enterWin(time) {
    go("win");
    winTimeEl.textContent = "Tempo: " + Number(time).toFixed(1) + "s";
    var amHost = GameNet.myId() === hostId;
    document.getElementById("winAgain").classList.toggle("hidden", !amHost);
    winHintEl.textContent = amHost
      ? ""
      : "Aguardando o host reiniciar a partida.";
    GameAudio.sfxWin();
  }

  function showBanner(text) {
    netBanner.textContent = text;
    netBanner.classList.remove("hidden");
  }
  function hideBanner() {
    netBanner.classList.add("hidden");
  }

  // ============================================================
  //  Botões do lobby
  // ============================================================
  document.getElementById("nameOk").addEventListener("click", function () {
    var name = (nameInput.value || "").trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    helloName.textContent = name;
    GameAudio.start();
    GameNet.send({ t: "hello", name: name });
  });
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("nameOk").click();
  });

  document.getElementById("createBtn").addEventListener("click", function () {
    homeError.textContent = "";
    GameNet.send({ t: "create" });
  });
  document.getElementById("joinBtn").addEventListener("click", function () {
    var code = (joinInput.value || "").trim().toUpperCase();
    if (!code) {
      joinInput.focus();
      return;
    }
    homeError.textContent = "";
    GameNet.send({ t: "join", code: code });
  });
  joinInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("joinBtn").click();
  });

  startBtn.addEventListener("click", function () {
    GameNet.send({ t: "start" });
  });
  document.getElementById("leaveBtn").addEventListener("click", function () {
    GameNet.send({ t: "leave" });
    go("home");
  });
  document.getElementById("winAgain").addEventListener("click", function () {
    GameNet.send({ t: "restart" });
  });
  document.getElementById("winLeave").addEventListener("click", function () {
    GameNet.send({ t: "leave" });
    go("home");
  });

  // ============================================================
  //  Entrada: teclado
  // ============================================================
  function refreshInput() {
    input.left = !!(keys["ArrowLeft"] || keys["KeyA"]);
    input.right = !!(keys["ArrowRight"] || keys["KeyD"]);
    input.jump = !!(keys["ArrowUp"] || keys["KeyW"] || keys["Space"]);
    sendInputIfChanged();
  }
  function sendInputIfChanged() {
    if (
      input.left !== lastSent.left ||
      input.right !== lastSent.right ||
      input.jump !== lastSent.jump
    ) {
      lastSent = { left: input.left, right: input.right, jump: input.jump };
      GameNet.send({
        t: "input",
        left: input.left,
        right: input.right,
        jump: input.jump,
      });
    }
  }

  window.addEventListener("keydown", function (e) {
    if (phase !== "playing") return;
    keys[e.code] = true;
    if (
      e.code === "Space" ||
      e.code === "ArrowLeft" ||
      e.code === "ArrowRight" ||
      e.code === "ArrowUp" ||
      e.code === "ArrowDown"
    ) {
      e.preventDefault();
    }
    if (e.code === "KeyM") setMuteUI(GameAudio.toggleMute());
    refreshInput();
  });
  window.addEventListener("keyup", function (e) {
    keys[e.code] = false;
    refreshInput();
  });
  // Se a aba perde o foco, zera tudo para a tecla não "colar".
  window.addEventListener("blur", function () {
    keys = {};
    refreshInput();
  });

  // "P" liga/desliga o HUD de diagnóstico (em qualquer tela, menos ao digitar).
  window.addEventListener("keydown", function (e) {
    if (e.code !== "KeyP") return;
    var el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    diag.show = !diag.show;
  });

  // ============================================================
  //  Entrada: toque (mobile)
  // ============================================================
  function bindTouch(id, key) {
    var el = document.getElementById(id);
    function on(e) {
      e.preventDefault();
      keys[key] = true;
      refreshInput();
    }
    function off(e) {
      e.preventDefault();
      keys[key] = false;
      refreshInput();
    }
    el.addEventListener("touchstart", on, { passive: false });
    el.addEventListener("touchend", off, { passive: false });
    el.addEventListener("touchcancel", off, { passive: false });
    el.addEventListener("mousedown", on);
    el.addEventListener("mouseup", off);
    el.addEventListener("mouseleave", off);
  }
  bindTouch("btnLeft", "ArrowLeft");
  bindTouch("btnRight", "ArrowRight");
  bindTouch("btnJump", "ArrowUp");

  // ============================================================
  //  Botão de mudo
  // ============================================================
  function setMuteUI(muted) {
    muteBtn.textContent = muted ? "♪̸" : "♪";
    muteBtn.classList.toggle("off", muted);
  }
  muteBtn.addEventListener("click", function () {
    GameAudio.start();
    setMuteUI(GameAudio.toggleMute());
  });

  // ============================================================
  //  Render do mundo (portado do jogo original)
  // ============================================================
  function drawBackground() {
    var sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, "#4ea6e6");
    sky.addColorStop(0.55, "#8fd0f0");
    sky.addColorStop(1, "#cdeffb");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.save();
    ctx.globalAlpha = 0.9;
    var sunG = ctx.createRadialGradient(780, 110, 10, 780, 110, 90);
    sunG.addColorStop(0, "#fff7cf");
    sunG.addColorStop(1, "rgba(255,247,207,0)");
    ctx.fillStyle = sunG;
    ctx.beginPath();
    ctx.arc(780, 110, 90, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff3b0";
    ctx.beginPath();
    ctx.arc(780, 110, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    var cloudOff = (renderTick * 0.2) % (VIEW_W + 200);
    drawCloud(120 - cloudOff + cam.x * -0.05, 90, 1);
    drawCloud(520 - cloudOff + cam.x * -0.05, 150, 0.8);
    drawCloud(820 - cloudOff + cam.x * -0.05, 70, 1.1);
    drawCloud(360 - cloudOff + cam.x * -0.05 + 900, 120, 0.9);

    var hillY = VIEW_H - 40 + cam.y * 0.04;
    ctx.fillStyle = "#6fae5f";
    for (var h = -1; h < 4; h++) {
      ctx.beginPath();
      ctx.arc(h * 320 + 120, hillY, 220, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = "#5d9b4f";
    for (var h2 = -1; h2 < 5; h2++) {
      ctx.beginPath();
      ctx.arc(h2 * 260 + 40, hillY + 40, 180, Math.PI, 0);
      ctx.fill();
    }
  }

  function drawCloud(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.arc(28, 6, 22, 0, Math.PI * 2);
    ctx.arc(-26, 8, 20, 0, Math.PI * 2);
    ctx.arc(6, -14, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawTree(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = "#7a5230";
    ctx.fillRect(-7, -46, 14, 48);
    var greens = ["#2e7d32", "#388e3c", "#43a047"];
    for (var i = 0; i < 3; i++) {
      ctx.fillStyle = greens[i];
      ctx.beginPath();
      ctx.arc(-14 + i * 14, -58 - i * 6, 26 - i * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#4caf50";
    ctx.beginPath();
    ctx.arc(0, -72, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPlatform(p) {
    if (p.ground) {
      var g = ctx.createLinearGradient(0, p.y, 0, p.y + 120);
      g.addColorStop(0, "#8d6e3a");
      g.addColorStop(1, "#5e4525");
      ctx.fillStyle = g;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.fillStyle = "#57a548";
      ctx.fillRect(p.x, p.y, p.w, 14);
      ctx.fillStyle = "#6cc257";
      for (var i = p.x; i < p.x + p.w; i += 10) {
        ctx.beginPath();
        ctx.arc(i, p.y, 6, Math.PI, 0);
        ctx.fill();
      }
      return;
    }
    var rr = 8;
    ctx.fillStyle = "#6b4a2a";
    roundRect(p.x, p.y + 6, p.w, p.h, rr);
    ctx.fill();
    ctx.fillStyle = p.top ? "#73c267" : "#57a548";
    roundRect(p.x, p.y, p.w, 14, rr);
    ctx.fill();
    ctx.fillStyle = p.top ? "#8ede7f" : "#6cc257";
    for (var j = p.x + 5; j < p.x + p.w - 3; j += 11) {
      ctx.beginPath();
      ctx.arc(j, p.y + 2, 5, Math.PI, 0);
      ctx.fill();
    }
  }

  // Mesmas fórmulas determinísticas do servidor (world.js), para o
  // balanço dos pêndulos e o voo dos pássaros ficarem sincronizados.
  function pendulumPos(pend, t) {
    var angle = pend.amp * Math.sin(t * pend.speed + pend.phase);
    return {
      x: pend.ax + Math.sin(angle) * pend.len,
      y: pend.ay + Math.cos(angle) * pend.len,
    };
  }
  function birdX(bird, t, worldW) {
    var span = worldW + BIRD_MARGIN * 2;
    var tt = (t * bird.speed + bird.phase) % span;
    if (tt < 0) tt += span;
    return bird.dir === 1 ? -BIRD_MARGIN + tt : worldW + BIRD_MARGIN - tt;
  }

  function drawPendulums() {
    if (!world.pendulums) return;
    for (var i = 0; i < world.pendulums.length; i++) {
      var pd = world.pendulums[i];
      var b = pendulumPos(pd, renderTick);
      // viga/âncora
      ctx.fillStyle = "#5a4630";
      ctx.fillRect(pd.ax - 18, pd.ay - 8, 36, 8);
      // corda
      ctx.strokeStyle = "#7a6a4a";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(pd.ax, pd.ay);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      // peso (bola de ferro)
      var g = ctx.createRadialGradient(
        b.x - pd.r * 0.3,
        b.y - pd.r * 0.3,
        2,
        b.x,
        b.y,
        pd.r,
      );
      g.addColorStop(0, "#9aa3ad");
      g.addColorStop(1, "#3c444d");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(b.x, b.y, pd.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawBirds() {
    if (!world.birds) return;
    for (var i = 0; i < world.birds.length; i++) {
      var bd = world.birds[i];
      var x = birdX(bd, renderTick, world.worldW);
      var y = bd.y + Math.sin(renderTick * 0.2 + bd.phase) * 4;
      drawBird(x, y, bd.dir);
    }
  }

  function drawBird(x, y, dir) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1); // vira o pássaro conforme a direção do voo
    // corpo
    ctx.fillStyle = "#44474d";
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    // cabeça
    ctx.beginPath();
    ctx.arc(13, -4, 6, 0, Math.PI * 2);
    ctx.fill();
    // bico
    ctx.fillStyle = "#f2a63b";
    ctx.beginPath();
    ctx.moveTo(18, -4);
    ctx.lineTo(27, -2);
    ctx.lineTo(18, 0);
    ctx.closePath();
    ctx.fill();
    // asa batendo
    var flap = Math.sin(renderTick * 0.3) * 10;
    ctx.fillStyle = "#2f3237";
    ctx.beginPath();
    ctx.moveTo(-2, -2);
    ctx.lineTo(-16, -10 - flap);
    ctx.lineTo(-10, 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawDoor() {
    var d = world.door;
    ctx.save();
    var glow = ctx.createRadialGradient(
      d.x + d.w / 2,
      d.y + d.h / 2,
      6,
      d.x + d.w / 2,
      d.y + d.h / 2,
      80,
    );
    var pulse = 0.35 + Math.sin(renderTick * 0.06) * 0.15;
    glow.addColorStop(0, "rgba(255,230,120," + pulse + ")");
    glow.addColorStop(1, "rgba(255,230,120,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(d.x - 60, d.y - 60, d.w + 120, d.h + 120);
    ctx.restore();

    ctx.fillStyle = "#4a2f17";
    roundRect(d.x - 6, d.y - 6, d.w + 12, d.h + 6, 6);
    ctx.fill();
    var g = ctx.createLinearGradient(d.x, d.y, d.x + d.w, d.y);
    g.addColorStop(0, "#9c6b3a");
    g.addColorStop(0.5, "#b9834b");
    g.addColorStop(1, "#8a5c30");
    ctx.fillStyle = g;
    roundRect(d.x, d.y, d.w, d.h, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(d.x + d.w / 2, d.y + 4);
    ctx.lineTo(d.x + d.w / 2, d.y + d.h - 4);
    ctx.stroke();
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.arc(d.x + d.w - 12, d.y + d.h / 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText("CHEGADA", d.x + d.w / 2, d.y - 14);
  }

  function drawRope() {
    if (order.length < 2) return;
    ctx.save();
    ctx.strokeStyle = "#6b4f2a";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    // A corda prende na cintura: ~55% da altura do personagem, acima dos pés.
    // Deriva do tamanho atual do sprite para acompanhar mudanças de escala.
    var anchorY = CharSprites.standHeight() * 0.55;
    for (var i = 0; i < order.length - 1; i++) {
      var a = rpos[order[i]];
      var b = rpos[order[i + 1]];
      if (!a || !b) continue;
      var ax = a.x,
        ay = a.y - anchorY;
      var bx = b.x,
        by = b.y - anchorY;
      var midx = (ax + bx) / 2;
      var midy = (ay + by) / 2 + 10;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(midx, midy, bx, by);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlayers() {
    var now = performance.now();
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      var p = rpos[id];
      var meta = playersMeta[id];
      if (!p || !meta) continue;
      var ch = CHARACTERS[meta.charIndex];
      var idx = meta.charIndex;

      // decide a animação a partir do estado interpolado
      var anim, frame;
      if (p.grounded === false) {
        anim = "jump";
        var n = CharSprites.frameCount(idx, "jump");
        var vy = p.vy || 0;
        var t = vy < -0.6 ? 0.3 : vy > 0.6 ? 0.72 : 0.5; // sobe / cai / ápice
        frame = Math.min(n - 1, Math.floor(n * t));
      } else if (Math.abs(p.vx || 0) > 0.4) {
        anim = "walk";
        frame = CharSprites.cycleFrame(idx, "walk", now);
      } else {
        anim = "idle";
        frame = CharSprites.cycleFrame(idx, "idle", now);
      }

      // sombra fica no chão, mesmo durante o pulo: achamos a plataforma
      // logo abaixo dos pés e desenhamos a sombra ali (encolhe com a altura).
      var groundY = groundYUnder(p.x, p.y);
      if (groundY != null) {
        var height = groundY - p.y; // 0 no chão, cresce no ar
        var factor = Math.max(0, 1 - height / 180);
        ctx.save();
        ctx.translate(p.x, groundY);
        CharSprites.drawShadow(ctx, factor);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      CharSprites.drawFrame(ctx, idx, anim, frame, p.facing);
      ctx.restore();

      // nome acima do personagem (destaca o "você")
      var isMe = id === youId;
      ctx.font = "bold 11px Trebuchet MS";
      ctx.textAlign = "center";
      var label = meta.name + (isMe ? " (você)" : "");
      var w = ctx.measureText(label).width + 12;
      roundRectFill(p.x - w / 2, p.y - 100, w, 16, 5, ch.color);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, p.x, p.y - 88);
    }
  }

  function updateCameraAndMeters() {
    var minY = Infinity;
    var sumX = 0;
    var n = 0;
    for (var i = 0; i < order.length; i++) {
      var p = rpos[order[i]];
      if (!p) continue;
      if (p.y < minY) minY = p.y;
      sumX += p.x;
      n++;
    }
    if (!n) return;
    var avgX = sumX / n;

    var targetY = minY - VIEW_H * 0.62;
    var targetX = avgX - VIEW_W / 2;
    cam.x += (targetX - cam.x) * 0.1;
    cam.y += (targetY - cam.y) * 0.12;
    if (cam.x < 0) cam.x = 0;
    if (cam.x > world.worldW - VIEW_W) cam.x = world.worldW - VIEW_W;
    if (cam.y < 0) cam.y = 0;
    if (cam.y > world.worldH - VIEW_H) cam.y = world.worldH - VIEW_H;

    // altitude: metros do jogador mais alto (minY = mais alto)
    var meters = Math.max(
      0,
      Math.floor((world.groundTop - minY) / world.pxPerMeter),
    );
    if (meters > bestMeters) bestMeters = meters;
    if (bestMeters >= milestone + 100) {
      milestone = Math.floor(bestMeters / 100) * 100;
      banner = { text: milestone + " m!", t: renderTick };
    }
  }

  function drawHud() {
    // barra superior
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, 0, VIEW_W, 34);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px Trebuchet MS";
    ctx.textAlign = "left";
    ctx.fillText("Subam juntos até a porta! 🚪", 14, 22);
    ctx.textAlign = "right";
    ctx.fillText("Tempo: " + elapsed.toFixed(1) + "s", VIEW_W - 14, 22);

    // marcador de altitude (canto superior esquerdo, abaixo da barra)
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(12, 44, 116, 40, 10);
    ctx.fill();
    ctx.fillStyle = "#8ede7f";
    ctx.font = "bold 22px Trebuchet MS";
    ctx.textAlign = "left";
    ctx.fillText(bestMeters + " m", 24, 72);
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "10px Trebuchet MS";
    ctx.fillText("ALTITUDE", 24, 56);
    ctx.restore();

    // banner de marco a cada 100 m (fica ~1.5s)
    var age = renderTick - banner.t;
    if (banner.text && age < 90) {
      var a = age < 15 ? age / 15 : age > 75 ? (90 - age) / 15 : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.textAlign = "center";
      ctx.fillStyle = "#ffe14d";
      ctx.font = "bold 44px Trebuchet MS";
      ctx.fillText(banner.text, VIEW_W / 2, 120);
      ctx.restore();
    }
  }

  // ---- HUD de diagnóstico (desenhado por cima de tudo) --------------
  // Cada métrica ganha cor (verde/amarelo/vermelho) para o jogador ver
  // num relance QUAL camada está ruim:
  //   FPS baixo       → o aparelho/navegador dele não dá conta do render;
  //   PING alto        → latência de rede até o servidor;
  //   REDE < ~30/s     → snapshots não chegam (rede ruim ou servidor cheio);
  //   TRAVA alta       → houve um "soluço" (maior buraco entre snapshots);
  //   LOOP (servidor)  → o event loop do servidor está atrasado p/ todos.
  function diagColor(value, good, warn, invert) {
    // invert=false: maior é melhor | invert=true: menor é melhor
    if (invert)
      return value <= good ? "#8ede7f" : value <= warn ? "#ffe14d" : "#ff6b6b";
    return value >= good ? "#8ede7f" : value >= warn ? "#ffe14d" : "#ff6b6b";
  }

  // Heurística de "onde está o gargalo". Olha as métricas piores e nomeia a
  // camada provável, para o jogador não precisar interpretar número por número.
  function computeVerdict(s) {
    // fora da partida não há snapshots → métricas de rede não se aplicam.
    if (phase !== "playing") return ["— (em jogo)", "rgba(255,255,255,0.5)"];
    if (diag.fps < 30 || diag.jankShown > 100)
      return ["aparelho (render)", "#ff6b6b"];
    if (s.server && s.server.simGap > 20) return ["servidor (loop)", "#ff6b6b"];
    // "rede" só quando o buffer REALMENTE falhou (starve) ou há perda de
    // pacotes sustentada — não a cada pico de jitter, que o buffer absorve.
    if (diag.starveRate > 1 || diag.stateRate < 18 || diag.jitter > 60)
      return ["rede (jitter/perda)", "#ffe14d"];
    if (diag.snapRate > 1) return ["previsão (snap)", "#ffe14d"];
    if (s.ping != null && s.pingAvg > 160)
      return ["latência (rede)", "#ffe14d"];
    return ["sem gargalo", "#8ede7f"];
  }

  function drawDiag() {
    if (!diag.show) return;
    var s = GameNet.stats();
    var lines = [];

    // headline: camada mais provável do problema (leitura num relance)
    var verdict = computeVerdict(s);
    lines.push(["PROVÁVEL", verdict[0], verdict[1]]);

    // --- aparelho (render local) ---
    lines.push(["FPS", String(diag.fps), diagColor(diag.fps, 50, 30, false)]);
    lines.push([
      "JANK",
      Math.round(diag.jankShown) + " ms",
      diagColor(diag.jankShown, 30, 80, true),
    ]);

    // --- rede ---
    if (s.ping == null) {
      lines.push(["PING", GameNet.isConnected() ? "…" : "offline", "#ff6b6b"]);
    } else {
      lines.push([
        "PING",
        s.ping + " ms  (méd " + s.pingAvg + " / máx " + s.pingMax + ")",
        diagColor(s.ping, 80, 160, true),
      ]);
    }
    lines.push([
      "REDE",
      diag.stateRate + "/s   " + diag.kbps.toFixed(1) + " KB/s",
      diagColor(diag.stateRate, 25, 15, false),
    ]);
    lines.push([
      "JITTER",
      diag.jitter + " ms",
      diagColor(diag.jitter, 25, 50, true),
    ]);
    lines.push([
      "TRAVA",
      Math.round(diag.gapMaxShown) + " ms",
      diagColor(diag.gapMaxShown, 100, 250, true),
    ]);

    // --- netcode (previsão + interpolação) ---
    lines.push([
      "STARVE",
      diag.starveRate +
        "/s  buf " +
        diag.bufDepth +
        "  atraso " +
        Math.round(DELAY_TICKS * STEP_MS) +
        "ms",
      diagColor(diag.starveRate, 0, 2, true),
    ]);
    lines.push([
      "SNAP",
      diag.snapRate + "/s   drift " + diag.lastDrift + " px",
      diagColor(diag.snapRate, 0, 1, true),
    ]);

    // --- servidor --- (tolerante a servidor antigo que não manda os campos)
    if (s.server) {
      var sv = s.server;
      var q = function (v) {
        return v != null ? v : "?";
      };
      lines.push([
        "SERVIDOR",
        "loop +" +
          q(sv.simGap) +
          " ms  passo " +
          q(sv.simMs) +
          "/" +
          q(sv.simMsMax) +
          " ms",
        sv.simGap != null
          ? diagColor(sv.simGap, 5, 20, true)
          : "rgba(255,255,255,0.5)",
      ]);
      lines.push([
        "SALAS",
        q(sv.playing) +
          "/" +
          q(sv.rooms) +
          "  jog " +
          q(sv.players) +
          (sv.rss != null ? "  " + sv.rss + "MB" : ""),
        "rgba(255,255,255,0.8)",
      ]);
    }

    // caixa
    var padX = 10;
    var lineH = 16;
    var w = 252;
    var h = 12 + lines.length * lineH + 12;
    var x = VIEW_W - w - 10;
    var y = 44;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(x, y, w, h, 8);
    ctx.fill();

    ctx.font = "10px Trebuchet MS";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("DIAGNÓSTICO  (P esconde)", x + padX, y + 12);

    var ty = y + 12 + lineH;
    for (var i = 0; i < lines.length; i++) {
      ctx.font = "bold 11px Trebuchet MS";
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.fillText(lines[i][0], x + padX, ty);
      ctx.fillStyle = lines[i][2];
      ctx.fillText(lines[i][1], x + padX + 64, ty);
      ty += lineH;
    }
    ctx.restore();
  }

  function renderPlay() {
    drawBackground();
    ctx.save();
    ctx.translate(-cam.x, -cam.y);
    for (var d = 0; d < world.decos.length; d++) {
      drawTree(world.decos[d].x, world.decos[d].y, world.decos[d].s);
    }
    for (var i = 0; i < world.platforms.length; i++) {
      drawPlatform(world.platforms[i]);
    }
    drawDoor();
    drawPendulums();
    drawRope();
    drawPlayers();
    drawBirds();
    ctx.restore();
    drawHud();
  }

  // Fundo bonito para quando está no lobby (atrás do overlay).
  function renderLobbyBg() {
    var sky = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    sky.addColorStop(0, "#3d8fd1");
    sky.addColorStop(1, "#bfe9fb");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.fillStyle = "#6fae5f";
    for (var h = -1; h < 5; h++) {
      ctx.beginPath();
      ctx.arc(h * 280 + 80, VIEW_H - 10, 200, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = "#5d9b4f";
    ctx.fillRect(0, VIEW_H - 40, VIEW_W, 40);
    ctx.save();
    ctx.translate(0, VIEW_H - 40);
    drawTree(70, 0, 1.3);
    drawTree(890, 0, 1.5);
    drawTree(150, 4, 0.9);
    ctx.restore();
  }

  // ============================================================
  //  Helpers de desenho
  // ============================================================
  function roundRect(x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function roundRectFill(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    roundRect(x, y, w, h, r);
    ctx.fill();
  }

  // ============================================================
  //  Predição local e interpolação dos remotos (netcode)
  //  Parte B: a física do jogador local é prevista a 60 Hz aqui,
  //  espelhando server/src/room.js, para o próprio boneco responder na
  //  hora sem esperar o round-trip. O servidor continua autoritativo:
  //  cada snapshot reconcilia a posição (blend suave; snap em corda/
  //  hazard/respawn). Simplificação coop (sem PvP): sem replay de inputs.
  // ============================================================
  // Topo da plataforma mais próxima abaixo dos pés (x, feetY), p/ a sombra.
  // Retorna null se não houver chão abaixo (fora de qualquer plataforma).
  function groundYUnder(x, feetY) {
    var platforms = world && world.platforms;
    if (!platforms) return null;
    var hw = PHYS.HW;
    var best = null;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      var overlapX = x + hw > p.x && x - hw < p.x + p.w;
      if (!overlapX) continue;
      // plataforma deve estar no nível dos pés ou abaixo (com folga p/ o pulo)
      if (p.y < feetY - 2) continue;
      if (best == null || p.y < best) best = p.y;
    }
    return best;
  }

  function resolvePlatformsLocal(pl) {
    var hw = PHYS.HW;
    pl.grounded = false;
    var bottom = pl.y;
    var prevBottom = pl.prevY;
    var platforms = world.platforms;
    for (var i = 0; i < platforms.length; i++) {
      var p = platforms[i];
      var top = p.y;
      var overlapX = pl.x + hw > p.x && pl.x - hw < p.x + p.w;
      if (!overlapX) continue;
      // plataforma "um sentido": só aterrissa vindo de cima, caindo
      if (pl.vy >= 0 && prevBottom <= top + 6 && bottom >= top) {
        pl.y = top;
        pl.vy = 0;
        pl.grounded = true;
      }
    }
  }

  // Aplica a mola da corda na PREVISÃO do jogador local, igual ao servidor
  // (room.js step()). O servidor aplica a cada par consecutivo da corrente a
  // mesma força (em sentidos opostos) a cada ponta; então, para o jogador
  // local, basta puxá-lo em direção a cada vizinho adjacente na ordem.
  // Usa a posição RENDERIZADA dos vizinhos (rpos) — é o que o jogador vê.
  function applyRopeLocal(p) {
    if (order.length < 2) return;
    var idx = order.indexOf(youId);
    if (idx === -1) return;
    var neighbors = [];
    if (idx > 0) neighbors.push(order[idx - 1]);
    if (idx < order.length - 1) neighbors.push(order[idx + 1]);
    for (var n = 0; n < neighbors.length; n++) {
      var np = rpos[neighbors[n]];
      if (!np) continue;
      var dx = np.x - p.x;
      var dy = np.y - p.y;
      var dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      if (dist <= PHYS.ROPE_LEN) continue;
      var nx = dx / dist;
      var ny = dy / dist;
      var stretch = dist - PHYS.ROPE_LEN;
      var force = stretch * PHYS.ROPE_K;
      // vizinho remoto: rpos guarda delta por snapshot (~2 ticks) → *0.5 p/
      // aproximar a velocidade por tick usada no amortecimento.
      var nvx = (np.vx || 0) * 0.5;
      var nvy = (np.vy || 0) * 0.5;
      var relV = (nvx - p.vx) * nx + (nvy - p.vy) * ny;
      var totalF = force + relV * PHYS.ROPE_DAMP;
      p.vx += nx * totalF;
      p.vy += ny * totalF;
    }
  }

  // Um passo de física do jogador local. Espelha room.js: inputs + gravidade,
  // depois a corda, depois integração/colisão. (Perigos vêm da reconciliação.)
  function stepLocalPlayer(p, inp) {
    var accel = p.grounded ? PHYS.MOVE_ACCEL : PHYS.AIR_ACCEL;
    if (inp.left && !inp.right) {
      p.vx -= accel;
      p.facing = -1;
    } else if (inp.right && !inp.left) {
      p.vx += accel;
      p.facing = 1;
    } else if (p.grounded) {
      p.vx *= PHYS.FRICTION;
      if (Math.abs(p.vx) < 0.05) p.vx = 0;
    }
    if (p.vx > PHYS.MAX_SPEED) p.vx = PHYS.MAX_SPEED;
    if (p.vx < -PHYS.MAX_SPEED) p.vx = -PHYS.MAX_SPEED;

    if (inp.jump && !p.jumpPrev && p.grounded) {
      p.vy = PHYS.JUMP_VEL;
      p.grounded = false;
      GameAudio.sfxJump(); // feedback imediato do próprio pulo
    }
    p.jumpPrev = inp.jump;

    p.vy += PHYS.GRAVITY;
    if (p.vy > PHYS.MAX_FALL) p.vy = PHYS.MAX_FALL;

    // corda (depois da gravidade, antes de integrar — ordem igual ao servidor)
    applyRopeLocal(p);

    p.prevY = p.y;
    p.x += p.vx;
    p.y += p.vy;

    var hw = PHYS.HW;
    if (p.x < hw) {
      p.x = hw;
      if (p.vx < 0) p.vx = 0;
    }
    if (p.x > world.worldW - hw) {
      p.x = world.worldW - hw;
      if (p.vx > 0) p.vx = 0;
    }
    resolvePlatformsLocal(p);

    if (p.grounded && Math.abs(p.vx) > 0.3) p.bob += 0.3;
    else if (!p.grounded) p.bob += 0.08;
  }

  function initMe(p) {
    return {
      x: p.x,
      y: p.y,
      prevY: p.y,
      vx: 0,
      vy: 0,
      grounded: p.grounded !== false,
      jumpPrev: input.jump, // evita pulo fantasma se a tecla já está pressionada
      facing: p.facing || 1,
      bob: p.bob || 0,
    };
  }

  // Reconcilia a previsão local com a posição autoritativa do servidor.
  function reconcile(m, p) {
    var dx = p.x - m.x;
    var dy = p.y - m.y;
    // diagnóstico: divergência atual (px) entre previsão e servidor.
    diag.lastDrift = Math.round(Math.sqrt(dx * dx + dy * dy));
    if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
      // divergência grande (corda/hazard/respawn): snap direto = teleporte
      diag.snapCount++;
      m.x = p.x;
      m.y = p.y;
      m.prevY = p.y;
      m.vx = 0;
      m.vy = 0;
      m.grounded = p.grounded !== false;
    } else {
      // drift normal: correção suave (facing/vx/vy seguem a previsão local)
      m.x += dx * RECONCILE_K;
      m.y += dy * RECONCILE_K;
    }
  }

  // ---- Buffer de interpolação dos remotos (Parte C) ----------------
  // Cada sample é carimbado com o TICK do servidor (não a hora de chegada),
  // para a interpolação rodar na linha do tempo do servidor (ver sampleBuffer).
  function pushSample(id, t, p) {
    var b = buf[id] || (buf[id] = []);
    var last = b.length ? b[b.length - 1] : null;
    // ignora snapshot repetido/fora de ordem (rajada) — evita span de tick 0.
    if (last && serverTick <= last.tk) return;
    b.push({
      tk: serverTick, // tick do servidor deste snapshot
      t: t, // hora de chegada (só p/ limitar o histórico)
      x: p.x,
      y: p.y,
      facing: p.facing,
      bob: p.bob,
      grounded: p.grounded,
    });
    while (b.length > 2 && b[0].t < t - 1000) b.shift(); // ~1s de histórico
  }

  // Posição interpolada de um remoto no tick de render (atrasado): renderTk.
  function sampleBuffer(id, renderTk) {
    var b = buf[id];
    if (!b || !b.length) return rpos[id] || null;
    if (renderTk <= b[0].tk) {
      var f = b[0];
      return {
        x: f.x,
        y: f.y,
        facing: f.facing,
        bob: f.bob,
        grounded: f.grounded,
        vx: 0,
        vy: 0,
      };
    }
    for (var i = 0; i < b.length - 1; i++) {
      var a = b[i];
      var c = b[i + 1];
      if (renderTk >= a.tk && renderTk <= c.tk) {
        var span = c.tk - a.tk || 1;
        var alpha = (renderTk - a.tk) / span;
        var pick = alpha < 0.5 ? a : c;
        return {
          x: a.x + (c.x - a.x) * alpha,
          y: a.y + (c.y - a.y) * alpha,
          bob: a.bob + (c.bob - a.bob) * alpha,
          facing: pick.facing,
          grounded: pick.grounded,
          vx: c.x - a.x, // sinal/magnitude: andar vs. parado
          vy: c.y - a.y, // sobe/desce: frame do pulo
        };
      }
    }
    // starved: o render "passou" do sample mais novo (buffer vazio) → o
    // remoto congela aqui e vai "pular" quando o próximo snapshot chegar.
    diag.starveCount++;
    var last = b[b.length - 1]; // usa o mais recente
    return {
      x: last.x,
      y: last.y,
      facing: last.facing,
      bob: last.bob,
      grounded: last.grounded,
      vx: 0,
      vy: 0,
    };
  }

  // ============================================================
  //  Loop principal
  // ============================================================
  function frame(ts) {
    if (ts == null) ts = performance.now();
    var dt = lastFrameTs == null ? 0 : ts - lastFrameTs;
    lastFrameTs = ts;
    // JANK: pior quadro único (medido ANTES do clamp p/ não mascarar engasgos).
    if (dt > diag.jankMax) diag.jankMax = dt;
    if (dt > 250) dt = 250; // após aba em 2º plano, evita "catch-up" enorme

    // Relógio de render suave. REGRA: o movimento vem do avanço por TEMPO REAL
    // (≈1 tick/quadro, idêntico aos 60 fps); o servidor só corrige a DERIVA,
    // devagar. A versão anterior usava só um LERP até o alvo — como o alvo
    // cresce ~1/quadro e o snap era em 8, a diferença subia e "pulava"
    // (dente-de-serra) → nuvens/pássaros picotados. Agora não há salto.
    renderTick += dt / STEP_MS; // avanço suave por tempo real
    if (serverTickAt) {
      var target = serverTick + (ts - serverTickAt) / STEP_MS;
      var err = target - renderTick;
      if (err > 20 || err < -20)
        renderTick = target; // resync duro (aba em 2º plano / lag grande)
      else renderTick += err * 0.03; // correção de deriva imperceptível
    }

    // Amostragem das métricas de diagnóstico, uma vez por segundo.
    diag.frames++;
    if (!diag.lastSampleAt) diag.lastSampleAt = ts;
    var sampleDt = ts - diag.lastSampleAt;
    if (sampleDt >= 1000) {
      var secs = sampleDt / 1000;
      diag.fps = Math.round(diag.frames / secs);
      diag.stateRate = Math.round(diag.stateCount / secs);
      var st = GameNet.stats();
      diag.kbps = (st.rxBytes - diag.rxBytes) / secs / 1024;
      diag.rxBytes = st.rxBytes;
      diag.rxMsgs = st.rxMsgs;
      // pico de "travada" decai ao longo de alguns segundos p/ ficar visível
      diag.gapMaxShown = Math.max(diag.gapMax, diag.gapMaxShown * 0.5);
      diag.jankShown = Math.max(diag.jankMax, diag.jankShown * 0.5);
      // JITTER: desvio-padrão do intervalo entre snapshots na janela.
      if (diag.gapN > 1) {
        var mean = diag.gapSum / diag.gapN;
        var variance = diag.gapSqSum / diag.gapN - mean * mean;
        diag.jitter = Math.round(Math.sqrt(Math.max(0, variance)));
      } else {
        diag.jitter = 0;
      }
      diag.starveRate = Math.round(diag.starveCount / secs);
      diag.snapRate = Math.round(diag.snapCount / secs);
      // atraso de interpolação adaptativo (em ticks): mínimo quando a rede está
      // boa; sobe quando houve STARVE (buffer esvaziou de fato) ou jitter alto.
      var jitterTicks = diag.jitter / STEP_MS; // jitter (ms) → ticks
      var targetTicks =
        DELAY_TICKS_MIN + jitterTicks * 1.5 + diag.starveRate * 2;
      if (targetTicks < DELAY_TICKS_MIN) targetTicks = DELAY_TICKS_MIN;
      if (targetTicks > DELAY_TICKS_MAX) targetTicks = DELAY_TICKS_MAX;
      // sobe rápido (evita travar já), desce devagar (não "repuxa" os remotos).
      var k = targetTicks > DELAY_TICKS ? 0.5 : 0.08;
      DELAY_TICKS += (targetTicks - DELAY_TICKS) * k;
      // BUFFER: profundidade média dos buffers de interpolação dos remotos.
      var bSum = 0,
        bN = 0;
      for (var bid in buf) {
        if (bid === youId) continue;
        bSum += buf[bid].length;
        bN++;
      }
      diag.bufDepth = bN ? Math.round((bSum / bN) * 10) / 10 : 0;
      // zera os acumuladores da janela
      diag.gapMax = 0;
      diag.jankMax = 0;
      diag.gapSum = 0;
      diag.gapSqSum = 0;
      diag.gapN = 0;
      diag.starveCount = 0;
      diag.snapCount = 0;
      diag.frames = 0;
      diag.stateCount = 0;
      diag.lastSampleAt = ts;
    }

    if ((phase === "playing" || phase === "win") && world) {
      // Parte B: avança a previsão do jogador local em passo fixo de 60 Hz.
      if (phase === "playing" && me) {
        simAcc += dt;
        if (simAcc > 100) simAcc = 100; // limita a rajada de sub-passos
        while (simAcc >= STEP_MS) {
          stepLocalPlayer(me, input);
          simAcc -= STEP_MS;
        }
      }
      if (me) {
        // o próprio boneco é desenhado a partir da previsão (responde na hora)
        rpos[youId] = {
          x: me.x,
          y: me.y,
          facing: me.facing,
          bob: me.bob,
          vx: me.vx,
          vy: me.vy,
          grounded: me.grounded,
        };
      }
      // Parte C: remotos interpolados N ticks atrás do relógio do servidor.
      var renderTk = renderTick - DELAY_TICKS;
      for (var i = 0; i < order.length; i++) {
        var id = order[i];
        if (id === youId) continue;
        var s = sampleBuffer(id, renderTk);
        if (s) rpos[id] = s;
      }
      updateCameraAndMeters();
      renderPlay();
    } else {
      renderLobbyBg();
      if (phase === "room") animatePreviews(performance.now());
    }

    drawDiag(); // por cima de tudo, em qualquer tela

    requestAnimationFrame(frame);
  }

  // ============================================================
  //  Início
  // ============================================================
  GameNet.connect();
  CharSprites.load(function () {
    // repinta os previews assim que as imagens terminam de carregar
    if (phase === "room") animatePreviews(performance.now());
  });
  buildCharGrid();
  go("name");
  nameInput.focus();
  requestAnimationFrame(frame);
})();
