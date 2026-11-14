/* ============================================================
   characters.js — Os quatro personagens jogaveis.
   A arte vem de spritesheets (client/assets/sprites/), fatiados
   pelo tools/slice_sprites.py em tiras de animacao (idle/walk/jump)
   com fundo transparente e ancoradas pelos pes.
   Aqui cuidamos de: metadados (nome/cor), carregar as imagens e
   desenhar o frame certo de cada animacao.
   ============================================================ */

var CHARACTERS = [
  {
    id: "monge",
    name: "Monge",
    color: "#ff8a3d",
    blurb: "Peregrino de cajado e chapeu de palha.",
  },
  {
    id: "cavaleiro",
    name: "Cavaleiro",
    color: "#9fb2c4",
    blurb: "Armadura reluzente, escudo e espada.",
  },
  {
    id: "orc",
    name: "Orc",
    color: "#6aa84f",
    blurb: "Brutamontes verde de porrete em punho.",
  },
  {
    id: "guerreira",
    name: "Guerreira",
    color: "#e2583e",
    blurb: "Agil espadachim de lamina azul.",
  },
];

/* ------------------------------------------------------------
   CharSprites — carrega o manifesto + tiras e desenha frames.
   Todos os sprites foram empacotados olhando para a DIREITA;
   o jogo espelha quando facing === -1.
   ------------------------------------------------------------ */
var CharSprites = (function () {
  var BASE = "assets/sprites/";
  var ANIMS = ["idle", "walk", "jump"];
  var STAND_SCREEN = 39; // altura em tela (px) do personagem parado

  var manifest = null;
  var imgs = {}; // nome-do-arquivo -> HTMLImageElement
  var ready = false;

  function load(onReady) {
    fetch(BASE + "manifest.json")
      .then(function (r) {
        return r.json();
      })
      .then(function (m) {
        manifest = m;
        var pending = 0;
        m.chars.forEach(function (entry) {
          ANIMS.forEach(function (anim) {
            var file = entry[anim].file;
            var img = new Image();
            pending++;
            img.onload = img.onerror = function () {
              pending--;
              if (pending === 0) {
                ready = true;
                if (onReady) onReady();
              }
            };
            img.src = BASE + file;
            imgs[file] = img;
          });
        });
      })
      .catch(function () {
        /* sem sprites: o jogo usa o desenho de fallback */
      });
  }

  function info(charIndex, anim) {
    if (!manifest) return null;
    var c = manifest.chars[charIndex];
    return c ? c[anim] : null;
  }

  function frameCount(charIndex, anim) {
    var i = info(charIndex, anim);
    return i ? i.frames : 1;
  }

  function fps(anim) {
    return (manifest && manifest.fps && manifest.fps[anim]) || 8;
  }

  // Frame de ciclo (idle/walk) a partir do relogio em ms.
  function cycleFrame(charIndex, anim, clockMs) {
    var n = frameCount(charIndex, anim);
    return Math.floor((clockMs / 1000) * fps(anim)) % n;
  }

  // Desenha um frame com os pes na origem local (0,0).
  function drawFrame(ctx, charIndex, anim, frame, facing) {
    var i = info(charIndex, anim);
    var img = i && imgs[i.file];
    if (!ready || !i || !img || !img.complete || !img.naturalWidth) {
      drawFallback(ctx, charIndex, facing);
      return;
    }
    var cw = manifest.cellW,
      ch = manifest.cellH;
    var s = STAND_SCREEN / manifest.standH;
    var n = i.frames;
    if (frame < 0) frame = 0;
    if (frame >= n) frame = n - 1;

    // sombra dos pes (nao espelha)
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.20)";
    ctx.beginPath();
    ctx.ellipse(0, -1, 8.5, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.scale(facing, 1); // espelha para a esquerda quando facing === -1
    ctx.imageSmoothingEnabled = true;
    var dx = -manifest.footX * s;
    var dy = -manifest.footY * s;
    ctx.drawImage(img, frame * cw, 0, cw, ch, dx, dy, cw * s, ch * s);
    ctx.restore();
  }

  // Desenho simples enquanto as imagens carregam (ou se falharem).
  function drawFallback(ctx, charIndex, facing) {
    var ch = CHARACTERS[charIndex] || { color: "#888" };
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(0, -1, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ch.color;
    roundCapsule(ctx, -11, -62, 22, 60, 11);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    ctx.arc(0, -52, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function roundCapsule(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }

  // Preview do lobby: idle animado ajustado a uma caixa w x h.
  function drawPreview(ctx, charIndex, w, h, clockMs) {
    ctx.clearRect(0, 0, w, h);
    if (!ready || !manifest) {
      ctx.save();
      ctx.translate(w / 2, h * 0.9);
      drawFallback(ctx, charIndex, 1);
      ctx.restore();
      return;
    }
    var frame = cycleFrame(charIndex, "idle", clockMs);
    var i = info(charIndex, "idle");
    var img = imgs[i.file];
    var cw = manifest.cellW,
      chh = manifest.cellH;
    // escala para a altura do personagem ocupar ~82% da caixa
    var s = (h * 0.82) / manifest.standH;
    if (cw * s > w * 0.98) s = (w * 0.98) / cw;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    var footScreenX = w / 2;
    var footScreenY = h * 0.96;
    var dx = footScreenX - manifest.footX * s;
    var dy = footScreenY - manifest.footY * s;
    if (img && img.complete && img.naturalWidth) {
      ctx.drawImage(img, frame * cw, 0, cw, chh, dx, dy, cw * s, chh * s);
    }
    ctx.restore();
  }

  return {
    load: load,
    drawFrame: drawFrame,
    drawPreview: drawPreview,
    frameCount: frameCount,
    cycleFrame: cycleFrame,
    // Altura em tela (px) do personagem parado — usada para ancorar a corda,
    // nomes etc. ao tamanho atual do sprite.
    standHeight: function () {
      return STAND_SCREEN;
    },
    isReady: function () {
      return ready;
    },
  };
})();
