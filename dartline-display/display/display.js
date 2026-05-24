// Dartline Display — Display (Meta Ray-Ban Display)
// Renders the dartboard + HUD for the controller's Count Up game.

(() => {
  const DEFAULT_SESSION = "DEMO01";
  const RELAY_URL =
    new URLSearchParams(location.search).get("relay") ||
    "wss://dartline-display-relay.darts-relay.workers.dev";

  const params = new URLSearchParams(location.search);
  const sessionId = (params.get("s") || DEFAULT_SESSION).toUpperCase();

  const els = {
    session: document.getElementById("session"),
    status:  document.getElementById("status"),
    // Top HUD
    hudRoundLabel: document.getElementById("hudRoundLabel"),
    hudDots:       document.getElementById("hudDots"),
    hudTotal:      document.getElementById("hudTotal"),
    hudBest:       document.getElementById("hudBest"),
    // Board stage
    boardStage:      document.getElementById("boardStage"),
    dartboardCanvas: document.getElementById("dartboardCanvas"),
    aimOverlay:      document.getElementById("aimOverlay"),
    scoreToast:      document.getElementById("scoreToast"),
    // Game-over modal
    gameOverModal:   document.getElementById("gameOverModal"),
    gameOverScore:   document.getElementById("gameOverScore"),
    gameOverBadge:   document.getElementById("gameOverBadge"),
  };

  els.session.textContent = sessionId;

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "hud-bottom__status" + (cls ? " " + cls : "");
  }

  const board = els.dartboardCanvas
    ? new window.DartlineDartboardCanvas(els.dartboardCanvas)
    : null;
  if (board) board.draw();

  const sound = window.DartlineSound
    ? new window.DartlineSound.SoundSynth()
    : null;
  if (sound) {
    const unlock = () => sound.ensureContext();
    ["pointerdown", "touchstart", "keydown"].forEach((ev) =>
      document.addEventListener(ev, unlock, { once: true, passive: true }));
  }

  // ── WebSocket ───────────────────────────────────────────────────────────
  let ws = null;
  let reconnectAttempts = 0;
  const MAX_BACKOFF_MS = 5000;

  function connect() {
    const url = `${RELAY_URL}/ws?s=${encodeURIComponent(sessionId)}&r=display`;
    setStatus("connecting");
    try { ws = new WebSocket(url); }
    catch (_) { scheduleReconnect(); return; }

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("waiting controller");
      try { ws.send(JSON.stringify(window.DartlineProtocol.ready())); } catch (_) {}
    });
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", () => { setStatus("disconnected", "error"); scheduleReconnect(); });
    ws.addEventListener("error", () => { setStatus("error", "error"); });
  }
  function scheduleReconnect() {
    reconnectAttempts += 1;
    const delay = Math.min(500 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
    setTimeout(connect, delay);
  }

  function onMessage(event) {
    let msg;
    try { msg = JSON.parse(event.data); } catch (_) { return; }
    switch (msg.type) {
      case "hello": {
        const peers = msg.peers || [];
        if (peers.includes("controller")) setStatus("linked", "connected");
        else setStatus("waiting controller");
        break;
      }
      case "peer_joined":
        if (msg.role === "controller") setStatus("linked", "connected");
        break;
      case "peer_left":
        if (msg.role === "controller") setStatus("waiting controller");
        break;
      case "motion":
        // No raw motion display — but still good to drop a pulse so we know
        // packets are flowing. No-op here for now.
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
        handleThrowOnBoard(msg);
        break;
      case "game_state":
        renderGameState(msg.snapshot, msg.result);
        break;
      default: break;
    }
  }

  // ── Aim / lock / throw ──────────────────────────────────────────────────
  function renderAim(msg) {
    if (!board) return;
    board.setAim({
      x: typeof msg.x === "number" ? msg.x : 0,
      y: typeof msg.y === "number" ? msg.y : 0,
    });
  }
  function renderAimState(state) {
    if (!els.aimOverlay) return;
    if (state === "aiming") els.aimOverlay.classList.add("hidden");
    else els.aimOverlay.classList.remove("hidden");
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
    if (pts)   pts.textContent   = String(score.points);
    els.scoreToast.classList.remove("active");
    void els.scoreToast.offsetWidth;
    els.scoreToast.classList.add("active");
    clearTimeout(showScoreToast._t);
    showScoreToast._t = setTimeout(() => {
      els.scoreToast.classList.remove("active");
    }, 1800);
  }

  // ── Game HUD ────────────────────────────────────────────────────────────
  function renderGameState(snap, result) {
    if (!snap) return;
    // Round label
    if (snap.status === "idle") {
      els.hudRoundLabel.textContent = "READY";
    } else if (snap.status === "finished") {
      els.hudRoundLabel.textContent = "FINAL";
    } else {
      els.hudRoundLabel.textContent = `ROUND ${snap.round + 1} / ${snap.totalRounds}`;
    }
    // 3 dots
    const dots = els.hudDots.querySelectorAll(".hudDot");
    dots.forEach((dot, idx) => {
      const filled = snap.status === "playing"
        ? idx < snap.throwInRound
        : snap.status === "finished";
      dot.classList.toggle("filled", filled);
    });
    // Total
    els.hudTotal.textContent = String(snap.totalScore);
    const isNewBest = snap.status === "finished" && snap.totalScore > 0 && snap.totalScore >= snap.best;
    els.hudTotal.classList.toggle("new-best", isNewBest);
    // Best
    els.hudBest.textContent = snap.best > 0 ? `BEST ${snap.best}` : "BEST —";

    // Game-over modal
    if (snap.status === "finished" && result === "game_end") {
      els.gameOverScore.textContent = String(snap.totalScore);
      els.gameOverBadge.classList.toggle("hidden", !isNewBest);
      els.gameOverModal.classList.remove("hidden");
      els.gameOverModal.setAttribute("aria-hidden", "false");
      // Auto-hide after 6 seconds so a stale modal doesn't block the next game.
      clearTimeout(renderGameState._modalT);
      renderGameState._modalT = setTimeout(() => {
        els.gameOverModal.classList.add("hidden");
        els.gameOverModal.setAttribute("aria-hidden", "true");
      }, 6000);
    } else if (snap.status !== "finished") {
      els.gameOverModal.classList.add("hidden");
      els.gameOverModal.setAttribute("aria-hidden", "true");
    }
  }

  connect();
})();
