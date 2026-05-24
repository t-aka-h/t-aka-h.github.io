// Dartline Display — Display (Meta Ray-Ban Display)
// Phase 0: render incoming motion frames sent by the iPhone controller.

(() => {
  const DEFAULT_SESSION = "DEMO01";
  const RELAY_URL =
    new URLSearchParams(location.search).get("relay") ||
    "wss://dartline-display-relay.darts-relay.workers.dev";

  const params = new URLSearchParams(location.search);
  const sessionId = (params.get("s") || DEFAULT_SESSION).toUpperCase();

  const els = {
    session: document.getElementById("session"),
    status: document.getElementById("status"),
    rate: document.getElementById("rate"),
    boardStage: document.getElementById("boardStage"),
    dartboardCanvas: document.getElementById("dartboardCanvas"),
    aimOverlay: document.getElementById("aimOverlay"),
    throwOverlay: document.getElementById("throwOverlay"),
    throwForce: document.getElementById("throwForce"),
    throwFill: document.getElementById("throwFill"),
    scoreToast: document.getElementById("scoreToast"),
  };

  const board = els.dartboardCanvas
    ? new window.DartlineDartboardCanvas(els.dartboardCanvas)
    : null;
  if (board) board.draw();

  // Web Audio synth — needs a user gesture to unlock on Safari. We attach a
  // one-shot listener that primes the AudioContext the first time anyone
  // interacts with the page (tap, click, key).
  const sound = window.DartlineSound
    ? new window.DartlineSound.SoundSynth()
    : null;
  if (sound) {
    const unlock = () => sound.ensureContext();
    ["pointerdown", "touchstart", "keydown"].forEach((ev) =>
      document.addEventListener(ev, unlock, { once: true, passive: true }));
  }

  els.session.textContent = sessionId;

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "status" + (cls ? " " + cls : "");
  }

  // ---- WebSocket -----------------------------------------------------------

  let ws = null;
  let reconnectAttempts = 0;
  const MAX_BACKOFF_MS = 5000;

  function connect() {
    const url = `${RELAY_URL}/ws?s=${encodeURIComponent(sessionId)}&r=display`;
    setStatus("connecting");
    try {
      ws = new WebSocket(url);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("waiting for controller");
      try { ws.send(JSON.stringify(window.DartlineProtocol.ready())); } catch (_) {}
    });

    ws.addEventListener("message", onMessage);

    ws.addEventListener("close", () => {
      setStatus("disconnected", "error");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setStatus("error", "error");
    });
  }

  function scheduleReconnect() {
    reconnectAttempts += 1;
    const delay = Math.min(500 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
    setTimeout(connect, delay);
  }

  // ---- Frames --------------------------------------------------------------

  let frameCount = 0;
  let lastRateUpdate = Date.now();

  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }

    switch (msg.type) {
      case "hello": {
        const peers = msg.peers || [];
        setStatus(peers.includes("controller") ? "linked" : "waiting for controller",
                  peers.includes("controller") ? "connected" : null);
        break;
      }
      case "peer_joined":
        if (msg.role === "controller") setStatus("linked", "connected");
        break;
      case "peer_left":
        if (msg.role === "controller") setStatus("waiting for controller");
        break;
      case "motion":
        // We no longer render raw motion on the display starting at Phase 2.0,
        // but the message still updates the frame-rate counter so we can see
        // the controller link is alive.
        bumpFrameRate();
        break;
      case "aim":
        renderAim(msg);
        break;
      case "aim_state":
        renderAimState(msg.state);
        break;
      case "lock":
        renderLock(true, { x: msg.x ?? 0, y: msg.y ?? 0 });
        break;
      case "unlock":
        renderLock(false, null);
        break;
      case "throw":
        showThrow(msg);
        handleThrowOnBoard(msg);
        break;
      default:
        // ignore unknown types for now
        break;
    }
  }

  function showThrow(msg) {
    const force = typeof msg.force === "number" ? msg.force : 0;
    const peak = typeof msg.peak === "number" ? msg.peak : 0;
    const el = els.throwOverlay;
    if (!el) return;
    els.throwForce.textContent =
      "force " + force.toFixed(2) +
      "  ·  peak " + peak.toFixed(1) + " m/s²";
    els.throwFill.style.transform = "scaleX(" + Math.max(0.02, Math.min(1, force)) + ")";
    el.classList.remove("active");
    void el.offsetWidth;
    el.classList.add("active");
  }

  function bumpFrameRate() {
    frameCount += 1;
    const now = Date.now();
    if (now - lastRateUpdate >= 1000) {
      const hz = Math.round((frameCount * 1000) / (now - lastRateUpdate));
      els.rate.textContent = `${hz} Hz`;
      frameCount = 0;
      lastRateUpdate = now;
    }
  }

  // Aim coordinates arrive at ~20 Hz. Pass them to the dartboard renderer.
  function renderAim(msg) {
    if (!board) return;
    const x = typeof msg.x === "number" ? msg.x : 0;
    const y = typeof msg.y === "number" ? msg.y : 0;
    board.setAim({ x, y });
    bumpFrameRate();
  }

  function renderAimState(state) {
    if (!els.aimOverlay) return;
    if (state === "aiming") {
      els.aimOverlay.classList.add("hidden");
    } else {
      els.aimOverlay.classList.remove("hidden");
    }
  }

  function renderLock(locked, lockedAim) {
    if (!board) return;
    board.setLock(locked, lockedAim);
  }

  function handleThrowOnBoard(msg) {
    if (!board || !window.DartlineDartboard) return;
    const x = typeof msg.x === "number" ? msg.x : 0;
    const y = typeof msg.y === "number" ? msg.y : 0;
    const score = window.DartlineDartboard.scoreAt(x, y);
    board.addHit(x, y, score);
    showScoreToast(score);
    if (sound) sound.playForScore(score);
  }

  function showScoreToast(score) {
    if (!els.scoreToast) return;
    const label = els.scoreToast.querySelector(".score-toast__label");
    const pts = els.scoreToast.querySelector(".score-toast__pts");
    if (label) label.textContent = score.label;
    if (pts) pts.textContent = String(score.points);
    els.scoreToast.classList.remove("active");
    void els.scoreToast.offsetWidth;
    els.scoreToast.classList.add("active");
    clearTimeout(showScoreToast._t);
    showScoreToast._t = setTimeout(() => {
      els.scoreToast.classList.remove("active");
    }, 1800);
  }

  connect();
})();
