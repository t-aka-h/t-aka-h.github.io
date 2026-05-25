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
    // Neural Band hint + pulse
    pinchHint:       document.getElementById("pinchHint"),
    pinchPulse:      document.getElementById("pinchPulse"),
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
    if (state === "aiming") {
      els.aimOverlay.classList.add("hidden");
      // Belt-and-suspenders — if the CSS didn't load (cached HTML against
      // missing stylesheet), the inline style still hides the overlay.
      els.aimOverlay.style.display = "none";
    } else {
      els.aimOverlay.classList.remove("hidden");
      els.aimOverlay.style.display = "";
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
    // Round label — game-type aware.
    let roundLabel = "";
    if (snap.gameType === "x01") {
      roundLabel = snap.status === "idle"     ? `${snap.startingScore || 501}`
                 : snap.status === "finished" ? `FINAL`
                 : `TURN ${snap.round + 1}`;
    } else if (snap.gameType === "cricket_count_up") {
      const tgts = snap.currentTargets || [];
      const tgtLabel = tgts.length === 1 ? (tgts[0] === 25 ? "BULL" : String(tgts[0])) : "ALL";
      roundLabel = snap.status === "idle"     ? "READY"
                 : snap.status === "finished" ? "FINAL"
                 : `R${snap.round + 1} → ${tgtLabel}`;
    } else if (snap.gameType === "cricket_standard") {
      const targets = snap.targets || [];
      const closed = targets.filter((t) => (snap.marks || {})[t] >= 3).length;
      roundLabel = snap.status === "idle"     ? "READY"
                 : snap.status === "finished" ? "FINAL"
                 : `${closed} / ${targets.length} CLOSED`;
    } else if (snap.gameType === "cricket_cut_throat") {
      const p = (snap.players || [])[snap.currentPlayer] || { name: "P?" };
      roundLabel = snap.status === "idle"     ? "READY"
                 : snap.status === "finished" ? "FINAL"
                 : `${p.name} · TURN ${Math.floor(snap.round / 2) + 1}`;
    } else {
      roundLabel = snap.status === "idle"     ? "READY"
                 : snap.status === "finished" ? "FINAL"
                 : `ROUND ${snap.round + 1} / ${snap.totalRounds}`;
    }
    els.hudRoundLabel.textContent = roundLabel;

    // 3 dots
    const dots = els.hudDots.querySelectorAll(".hudDot");
    dots.forEach((dot, idx) => {
      const filled = snap.status === "playing"
        ? idx < snap.throwInRound
        : snap.status === "finished";
      dot.classList.toggle("filled", filled);
    });

    // Primary big number — depends on game type.
    let primaryNumber;
    if (snap.gameType === "x01") {
      primaryNumber = String(snap.remaining ?? snap.startingScore ?? 0);
    } else if (snap.gameType === "cricket_standard") {
      primaryNumber = String(snap.points ?? 0);
    } else if (snap.gameType === "cricket_cut_throat") {
      const p = (snap.players || [])[snap.currentPlayer] || { points: 0 };
      primaryNumber = String(p.points);
    } else {
      primaryNumber = String(snap.totalScore ?? 0);
    }
    els.hudTotal.textContent = primaryNumber;

    // "new best" highlight — semantics differ per game.
    let isNewBest = false;
    if (snap.status === "finished") {
      if (snap.gameType === "x01") {
        isNewBest = snap.throwsTaken > 0 && snap.throwsTaken === snap.best;
      } else if (snap.gameType === "cricket_cut_throat") {
        isNewBest = snap.totalScore > 0 && snap.totalScore === snap.best;
      } else {
        isNewBest = snap.totalScore > 0 && snap.totalScore >= snap.best;
      }
    }
    els.hudTotal.classList.toggle("new-best", isNewBest);

    // Best label — also game-aware.
    if (snap.gameType === "x01") {
      els.hudBest.textContent = snap.best > 0 ? `BEST ${snap.best}d` : "BEST —";
    } else if (snap.gameType === "cricket_cut_throat") {
      els.hudBest.textContent = snap.best > 0 ? `LOW ${snap.best}` : "LOW —";
    } else {
      els.hudBest.textContent = snap.best > 0 ? `BEST ${snap.best}` : "BEST —";
    }

    // Game-over modal — show the game-appropriate final score.
    if (snap.status === "finished" && result === "game_end") {
      let finalNumber;
      if (snap.gameType === "x01") finalNumber = `${snap.throwsTaken}d`;
      else if (snap.gameType === "cricket_cut_throat") finalNumber = String(snap.totalScore);
      else finalNumber = String(snap.totalScore);
      els.gameOverScore.textContent = finalNumber;
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
    // Show / hide the "PINCH to start" hint based on game phase.
    updatePinchHint(snap);
  }

  // ── Neural Band integration ────────────────────────────────────────────
  // The Meta Neural Band fires Enter (pinch) and arrow-key events into the
  // focused Web App. We forward those gestures over the relay so the
  // controller — which owns game state — can act on them. The user can
  // then play with eyes fixed on the glass and the iPhone purely held as
  // a dart, no glance at the phone screen needed.

  let lastGameSnapshot = null;

  function updatePinchHint(snap) {
    lastGameSnapshot = snap;
    if (!els.pinchHint) return;
    let text = "";
    if (!snap || snap.status === "idle") text = "PINCH to start";
    else if (snap.status === "finished") text = "PINCH to play again";
    // While playing the hint is suppressed — the LOCK affordance lives on
    // the iPhone scoreboard and would be too visually noisy on the glass.
    if (text) {
      els.pinchHint.textContent = text;
      els.pinchHint.classList.remove("hidden");
    } else {
      els.pinchHint.classList.add("hidden");
    }
  }
  updatePinchHint(null);   // show "PINCH to start" on cold boot

  function pulsePinch() {
    if (!els.pinchPulse) return;
    els.pinchPulse.classList.remove("active");
    void els.pinchPulse.offsetWidth;
    els.pinchPulse.classList.add("active");
  }

  function sendGlassAction(action) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: "glass_action", action, ts: Date.now() }));
    } catch (_) {}
    pulsePinch();
  }

  window.addEventListener("keydown", (e) => {
    // Pinch / select.
    if (e.key === "Enter" || e.key === " ") {
      sendGlassAction("primary");
      e.preventDefault();
      return;
    }
    // Back gesture — long-pinch on Neural Band fires Escape in the
    // wearable runtime per Meta's docs.
    if (e.key === "Escape" || e.key === "Backspace") {
      sendGlassAction("back");
      e.preventDefault();
      return;
    }
    // Optional navigation gestures (Neural Band swipe = arrow keys) —
    // currently unused but routed so the controller can adopt them later.
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      sendGlassAction(e.key.toLowerCase());
      e.preventDefault();
    }
  });

  connect();
})();
