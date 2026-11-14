/* ============================================================
   audio.js — Música ambiente e efeitos, 100% gerados via Web Audio.
   Não depende de nenhum arquivo externo.
   ============================================================ */

var GameAudio = (function () {
  var ctx = null;
  var masterGain = null;
  var musicGain = null;
  var started = false;
  var muted = false;
  var schedulerTimer = null;

  // Uma pequena melodia em lá menor pentatônica, bem tranquila,
  // "clima de floresta". Frequências em Hz.
  var A2 = 110.0;
  var scale = [
    A2 * 1, // A
    A2 * 1.2, // C
    A2 * 1.333, // D
    A2 * 1.5, // E
    A2 * 1.8, // G
    A2 * 2, // A (oitava)
    A2 * 2.4, // C
    A2 * 3, // E
  ];

  var noteIndex = 0;
  var nextNoteTime = 0;
  var step = 0;

  function ensureCtx() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0; // sobe suavemente no fade-in
    musicGain.connect(masterGain);
  }

  // Toca uma nota com envelope suave (clima de harpa/flauta).
  function playNote(freq, time, duration, gain, type) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || "triangle";
    osc.frequency.value = freq;

    // leve detune para dar "vida"
    osc.detune.value = step % 2 === 0 ? -4 : 4;

    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(gain, time + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(g);
    g.connect(musicGain);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  // Pad grave contínuo, trocando a cada compasso para dar profundidade.
  function playPad(freq, time, duration) {
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;

    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.06, time + 0.6);
    g.gain.setValueAtTime(0.06, time + duration - 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc.connect(g);
    g.connect(musicGain);
    osc.start(time);
    osc.stop(time + duration + 0.05);
  }

  var noteDur = 0.42; // segundos por passo

  function scheduler() {
    if (!ctx) return;
    while (nextNoteTime < ctx.currentTime + 0.2) {
      // melodia: sobe e desce pela escala criando um arpejo relaxante
      var pattern = [0, 2, 4, 3, 5, 3, 2, 1];
      var idx = pattern[step % pattern.length];
      var freq = scale[idx];
      playNote(freq, nextNoteTime, noteDur * 1.6, 0.14, "triangle");

      // de vez em quando uma nota mais aguda, como um passarinho
      if (step % 8 === 6) {
        playNote(scale[7] * 2, nextNoteTime, 0.5, 0.05, "sine");
      }

      // pad a cada 4 passos
      if (step % 4 === 0) {
        var bass = [A2, A2 * 0.75, A2, A2 * 1.333];
        playPad(bass[(step / 4) % bass.length], nextNoteTime, noteDur * 4);
      }

      nextNoteTime += noteDur;
      step++;
    }
  }

  return {
    // Deve ser chamado a partir de um gesto do usuário (clique/tecla).
    start: function () {
      ensureCtx();
      if (ctx.state === "suspended") ctx.resume();
      if (started) return;
      started = true;
      nextNoteTime = ctx.currentTime + 0.1;
      step = 0;
      // fade-in suave
      musicGain.gain.cancelScheduledValues(ctx.currentTime);
      musicGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      if (!muted) {
        musicGain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 2.5);
      }
      schedulerTimer = setInterval(scheduler, 60);
    },

    resume: function () {
      if (ctx && ctx.state === "suspended") ctx.resume();
    },

    toggleMute: function () {
      muted = !muted;
      if (ctx && musicGain) {
        musicGain.gain.cancelScheduledValues(ctx.currentTime);
        musicGain.gain.setTargetAtTime(
          muted ? 0.0001 : 0.9,
          ctx.currentTime,
          0.3,
        );
      }
      return muted;
    },

    isMuted: function () {
      return muted;
    },

    // Efeitos sonoros simples -------------------------------------------
    sfxJump: function () {
      if (!ctx || muted) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(320, t);
      osc.frequency.exponentialRampToValueAtTime(620, t + 0.12);
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 0.2);
    },

    sfxWin: function () {
      if (!ctx || muted) return;
      var t = ctx.currentTime;
      var notes = [scale[0], scale[2], scale[3], scale[5], scale[7] * 1.5];
      for (var i = 0; i < notes.length; i++) {
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = notes[i];
        var start = t + i * 0.12;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.2, start + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
        osc.connect(g);
        g.connect(masterGain);
        osc.start(start);
        osc.stop(start + 0.55);
      }
    },
  };
})();
