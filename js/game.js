/* ============================================================
   game.js — Cliente do jogo Grudados (online).
   O servidor manda a física; aqui apenas:
     - cuidamos do lobby (nome, criar/entrar, sala de espera);
     - lemos os inputs (teclado + toque) e enviamos ao servidor;
     - desenhamos o mundo e os jogadores interpolando o estado
       recebido para um movimento suave;
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
  var tick = 0;

  // HUD de altitude
  var bestMeters = 0;
  var milestone = 0; // último múltiplo de 100 alcançado
  var banner = { text: "", t: 0 };

  // Perigos: mesma margem usada no servidor para os pássaros "darem a volta".
  var BIRD_MARGIN = 80;

  // Entrada local do jogador
  var input = { left: false, right: false, jump: false };
  var lastSent = { left: false, right: false, jump: false };
  var keys = {};

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
    tick = msg.tick;
    elapsed = msg.elapsed;
    order = msg.players.map(function (p) {
      return p.id;
    });
    msg.players.forEach(function (p) {
      targets[p.id] = p;
      if (!rpos[p.id]) {
        // primeira vez: aparece já na posição certa
        rpos[p.id] = { x: p.x, y: p.y, facing: p.facing, bob: p.bob };
      }
      if (p.jumped) GameAudio.sfxJump();
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

    var cloudOff = (tick * 0.2) % (VIEW_W + 200);
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
      var b = pendulumPos(pd, tick);
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
      var x = birdX(bd, tick, world.worldW);
      var y = bd.y + Math.sin(tick * 0.2 + bd.phase) * 4;
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
    var flap = Math.sin(tick * 0.3) * 10;
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
    var pulse = 0.35 + Math.sin(tick * 0.06) * 0.15;
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
      banner = { text: milestone + " m!", t: tick };
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
    var age = tick - banner.t;
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
  //  Loop principal
  // ============================================================
  function frame() {
    tick++;

    if ((phase === "playing" || phase === "win") && world) {
      // interpolação suave rumo ao último estado recebido
      for (var i = 0; i < order.length; i++) {
        var id = order[i];
        var tgt = targets[id];
        if (!tgt) continue;
        if (!rpos[id])
          rpos[id] = {
            x: tgt.x,
            y: tgt.y,
            facing: tgt.facing,
            bob: tgt.bob,
            vx: 0,
            vy: 0,
            grounded: tgt.grounded,
          };
        var r = rpos[id];
        var prevx = r.x,
          prevy = r.y;
        r.x += (tgt.x - r.x) * 0.35;
        r.y += (tgt.y - r.y) * 0.35;
        r.vx = r.x - prevx; // velocidade renderizada: define andar vs. parado
        r.vy = r.y - prevy; // sobe/desce: escolhe o frame do pulo
        r.bob = tgt.bob;
        r.facing = tgt.facing;
        r.grounded = tgt.grounded;
      }
      updateCameraAndMeters();
      renderPlay();
    } else {
      renderLobbyBg();
      if (phase === "room") animatePreviews(performance.now());
    }

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
