# Client Architecture — Grudados

The frontend of **Grudados**, a cooperative online platformer. Several players
join a room, get tied together by a shared rope, and must climb to the door at
the top _together_ while physics pulls everyone back down. Runs in the browser
on desktop and mobile.

This document covers the technical and architectural specification of the client.
For the backend, see [`server/ARCHITECTURE.md`](../server/ARCHITECTURE.md).

---

## 1. Overview

```
        Browser (desktop / mobile)                     Fly.io (gru)
┌──────────────────────────────────────┐        ┌────────────────────┐
│  client/  (Cloudflare Workers assets) │        │  server/ (Node+ws) │
│  - lobby (name / room / character)    │◄────── │  - in-memory rooms │
│  - canvas renderer (60 fps)           │  WSS   │  - authoritative   │
│  - local prediction + interpolation   │ ─────► │    physics @ 60 Hz │
│  - input capture (keyboard / touch)   │        │  - broadcast ~30Hz │
└──────────────────────────────────────┘        └────────────────────┘
          HTTPS static                              WebSocket (wss)
```

- The client is **100% static** — plain HTML, CSS and classic (non-module)
  JavaScript. No build step, no bundler, no framework.
- All art and sound are produced at runtime: characters are drawn from
  sprite sheets onto a `<canvas>`, the scenery is procedurally painted, and the
  music/SFX are synthesized with the **Web Audio API**. No external audio files.
- The server is the **single source of truth** for game physics. The client
  predicts its own player locally and interpolates the others for smoothness,
  but always reconciles against server snapshots.

---

## 2. Technology Stack

| Concern    | Choice                                 | Notes                                            |
| ---------- | -------------------------------------- | ------------------------------------------------ |
| Markup     | Single `index.html`                    | Canvas + overlaid lobby + touch controls         |
| Styling    | Single `style.css`                     | Hand-written, no preprocessor                    |
| Language   | ES5-style "classic scripts"            | Loaded in order via `<script>`, no ES modules    |
| Rendering  | Canvas 2D (`CanvasRenderingContext2D`) | Internal resolution 960×600, scaled responsively |
| Audio      | Web Audio API (`AudioContext`)         | Procedural music + synthesized SFX               |
| Networking | Native `WebSocket`                     | JSON text frames                                 |
| Hosting    | Cloudflare Workers (Static Assets)     | Deployed via `wrangler` + GitHub Actions         |

There are **no runtime dependencies** (no npm packages shipped to the browser).

---

## 3. File Layout

```
client/
  index.html          # Canvas, lobby screens, mute button, touch pad
  style.css           # All styling (lobby panels, HUD, responsive, mobile)
  wrangler.toml       # Cloudflare Workers "static assets" config
  assets/
    sprites/          # Character sprite sheets (char{1..4}_{idle,walk,jump}.png)
    sprites/manifest.json   # Cell sizes, frame counts, anchor, fps per anim
  js/
    config.js         # Resolves the WebSocket server URL (dev vs prod)
    audio.js          # GameAudio — procedural music + SFX (Web Audio)
    characters.js     # CHARACTERS metadata + CharSprites (load & draw frames)
    net.js            # GameNet — WebSocket wrapper, typed message dispatch
    game.js           # Main app: lobby, netcode, render loop, input
```

Scripts are loaded **in dependency order** at the bottom of `index.html`:
`config.js → audio.js → characters.js → net.js → game.js`. Each module exposes a
single global (`GRUDADOS_CONFIG`, `GameAudio`, `CHARACTERS`/`CharSprites`,
`GameNet`) built with an IIFE to avoid leaking internals.

---

## 4. Module Responsibilities

### 4.1 `config.js` — Server discovery

Exposes `window.GRUDADOS_CONFIG.serverUrl`. On `localhost`/`127.0.0.1` it points
to `ws://<host>:8080`; otherwise it uses the hard-coded production URL
(`wss://estudio-elemental-subir-presos.fly.dev/`). A `?server=wss://…` query
parameter overrides both, which is handy for testing against a different backend.
Production must use `wss://` because the site is served over HTTPS.

### 4.2 `net.js` — Network layer (`GameNet`)

A thin wrapper over the native `WebSocket`:

- `connect()` opens the socket and wires `onopen/onmessage/onclose/onerror`.
- Incoming frames are parsed as JSON and dispatched **by type** (`msg.t`) to
  handlers registered with `on(type, fn)`. The special `welcome` message records
  the server-assigned player id (`myId`).
- `send(obj)` serializes to JSON. If the socket is not open yet, the message is
  **queued** and flushed on `open`.
- Exposes `isConnected()` and `myId()`.

### 4.3 `characters.js` — Players & sprites

- `CHARACTERS`: static metadata for the four playable characters (`id`, display
  `name`, `color`, `blurb`).
- `CharSprites`: loads `assets/sprites/manifest.json`, then the referenced sprite
  sheets. It can draw a specific animation frame anchored at the feet, mirror
  horizontally based on `facing`, draw a ground shadow, and render a lobby
  preview. If sprites fail to load, it falls back to a simple capsule drawing so
  the game is always playable. All sprites face **right**; the game mirrors them
  for leftward motion.

### 4.4 `audio.js` — Sound (`GameAudio`)

Everything is synthesized with the Web Audio API — no media files:

- Ambient music: an A-minor pentatonic arpeggio over a slow bass pad, scheduled
  ahead of time with a `setInterval` look-ahead scheduler and smooth gain
  envelopes.
- SFX: `sfxJump()` (square-wave sweep) and `sfxWin()` (triangle arpeggio).
- `start()` must be called from a user gesture (browser autoplay policy);
  `toggleMute()` / `isMuted()` control a master music gain with a soft ramp.

### 4.5 `game.js` — Application core

The largest module. It owns the lobby state machine, the network event handlers,
the fixed-step prediction, the interpolation buffer, the input pipeline, and the
full canvas render loop. Detailed below.

---

## 5. Application Lifecycle & Screens

The lobby is a set of overlaid `<section>` panels on top of the canvas. The
client phase drives which one is visible:

```
name  ──►  home  ──►  room  ──►  playing  ──►  win
                       ▲                         │
                       └───── restart ◄──────────┘
```

- **name** — pick a display name (nothing is persisted), sends `hello`.
- **home** — `create` a room or `join` with a code.
- **room** — waiting lobby: shows the room code, player list, and the character
  picker grid. The host can `start` once there are 2+ players and everyone has a
  character.
- **playing** — the canvas renders the world; input is streamed to the server.
- **win** — someone reached the door; the host can `restart`.

A `netBanner` element surfaces connection state (connecting / lost / reconnecting)
independent of the active screen.

---

## 6. Netcode (Client Side)

The client runs a **client-side prediction + entity interpolation** model on top
of the authoritative server.

### 6.1 Input

Input is a boolean triple `{ left, right, jump }` gathered from the keyboard
(`←/→`, `A/D`, `↑/W/Space`) or on-screen touch buttons. Input is sent **only when
it changes** (`{ t:"input", left, right, jump }`) to minimize traffic. `blur`
clears all keys so the player does not "stick" when the tab loses focus.

### 6.2 Local prediction (own player)

`game.js` mirrors the server physics constants in a `PHYS` object (gravity,
acceleration, max speed, friction, jump velocity, rope spring). Each frame it
advances the local player with a **fixed 60 Hz step** (`STEP_MS = 1000/60`) using
an accumulator, so prediction is frame-rate independent. The rope spring is
applied locally too — otherwise a hanging player would "fall" in the prediction
and get yanked back every snapshot.

### 6.3 Reconciliation

On every `state` snapshot the predicted position is compared to the authoritative
one:

- Small drift (rope stretch, hazard knockbacks) is absorbed with a **soft blend**
  (`RECONCILE_K = 0.3`) toward the server value.
- Large divergence (e.g. a respawn that teleports players hundreds of px) above
  `SNAP_DIST = 160` triggers a hard **snap**.

### 6.4 Remote interpolation (other players)

Snapshots for other players are stored in a per-id buffer. They are rendered with
a fixed `INTERP_DELAY = 100 ms` lag and interpolated between the two surrounding
samples, producing smooth motion despite the ~30 Hz broadcast rate.

### 6.5 Deterministic hazards

Pendulums and birds are **not** sent in each snapshot. Their positions are pure
functions of the server `tick` (`pendulumPos`, `birdX`), re-implemented
identically on the client. Sharing just the `tick` keeps them perfectly in sync.

---

## 7. Rendering

A single `requestAnimationFrame` loop (`frame`) drives everything:

1. Advance local prediction by the fixed-step accumulator.
2. Sample the interpolation buffers for remote players.
3. Update camera (follows the group's vertical progress) and altitude HUD.
4. Paint the scene back-to-front: sky/background gradient, clouds, trees and
   decorations, platforms, the door, pendulums, birds, the connecting rope,
   players (with shadows, mirrored sprites, name tags), then the HUD.

Key rendering facts:

- The canvas has a **fixed internal resolution of 960×600**; CSS scales it to the
  viewport, so layout is resolution-independent.
- **Altitude unit:** 1 meter = 12 px (`PX_PER_METER`, matching the server). The
  HUD shows current altitude and flashes a milestone banner every 100 m.
- The rope is drawn as a curve between consecutive players, matching the server's
  player ordering (the "chain").
- During the lobby, a subtle animated background is rendered so the canvas is
  never blank.

---

## 8. Mobile & Responsiveness

- Viewport is locked (`user-scalable=no`) to behave like an app.
- On-screen touch controls (`#touch`: left/right + jump) appear only while
  playing and map to the same input triple used by the keyboard. Touch handlers
  use `{ passive: false }` and also bind mouse events for desktop testing.
- The canvas scales to fit the screen while preserving the 960×600 aspect.

---

## 9. Message Protocol (client's view)

Client → server: `hello`, `create`, `join`, `start`, `choose`, `input`,
`restart`, `leave`, `ping`.

Server → client: `welcome`, `hello_ok`, `created`, `joined`, `room`, `world`,
`state`, `win`, `error`, `pong`.

| Incoming   | Client reaction                                                      |
| ---------- | -------------------------------------------------------------------- |
| `welcome`  | store own player id                                                  |
| `hello_ok` | advance to the home screen                                           |
| `room`     | re-render the lobby: player list, host, character grid               |
| `world`    | receive map data + player roster, enter `playing`, seed render state |
| `state`    | snapshot: reconcile own player, push remote samples, update HUD/tick |
| `win`      | enter the win screen, show the clear time, play the win jingle       |
| `error`    | show an inline error message on the current screen                   |

All frames are JSON text. The full protocol is defined by the server — see
[`server/ARCHITECTURE.md`](../server/ARCHITECTURE.md).

---

## 10. Deployment

- **Host:** Cloudflare Workers serving the directory as **Static Assets**
  (`wrangler.toml`: `name = "subir-juntos-client"`, `[assets] directory = "."`).
  This yields a global CDN with free, unlimited bandwidth.
- **CI/CD:** `.github/workflows/deploy.yml` runs `cloudflare/wrangler-action` with
  the `deploy` command on every push to `main`. Requires the repo secrets
  `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID`.
- **Production config:** the backend URL is hard-coded in `js/config.js`
  (`PRODUCTION_WS`). It must point at the `wss://` address of the Fly.io app.

> The backend runs on **Fly.io** in the `gru` (São Paulo) region to keep latency
> low for Brazilian players — not on Render.

---

## 11. Design Trade-offs

- **No build step / no framework.** Keeps the project trivially deployable and
  hackable, at the cost of manual DOM wiring and global-per-file modules.
- **Prediction + interpolation** adds complexity but hides network latency; the
  server stays authoritative and cheat-resistant.
- **Everything drawn/synthesized at runtime** means zero art/audio asset pipeline
  beyond the four character sprite sheets, with a capsule fallback if even those
  fail to load.
- **Fixed internal canvas resolution** simplifies all physics/rendering math and
  makes layout scale cleanly across devices.
