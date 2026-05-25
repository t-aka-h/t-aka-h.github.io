// Dartline Display — Controller (iPhone Safari)
// Tilt to aim, tap LOCK to freeze, swing to throw. Count Up runs as the
// default game mode: 8 rounds × 3 throws = 24 darts, sum of all hit points.

(() => {
  const DEFAULT_SESSION = "DEMO01";
  const RELAY_URL =
    new URLSearchParams(location.search).get("relay") ||
    "wss://dartline-display-relay.darts-relay.workers.dev";

  const params = new URLSearchParams(location.search);
  const sessionId = (params.get("s") || DEFAULT_SESSION).toUpperCase();

  const els = {
    sessionId: document.getElementById("sessionId"),
    status:    document.getElementById("status"),
    permissionCard:   document.getElementById("permissionCard"),
    permissionButton: document.getElementById("permissionButton"),
    roundChip:   document.getElementById("roundChip"),
    throwDots:   document.getElementById("throwDots"),
    totalValue:  document.getElementById("totalValue"),
    bestChip:    document.getElementById("bestChip"),
    lastHitChip: document.getElementById("lastHitChip"),
    mainButton:      document.getElementById("mainButton"),
    mainButtonLabel: document.getElementById("mainButtonLabel"),
    mainButtonSub:   document.getElementById("mainButtonSub"),
    aimStateChip:    document.getElementById("aimStateChip"),
    recalibrateButton: document.getElementById("recalibrateButton"),
    audioTestButton:   document.getElementById("audioTestButton"),
    miniDartboardCanvas: document.getElementById("miniDartboardCanvas"),
    miniAimOverlay:      document.getElementById("miniAimOverlay"),
  };

  // ── Mini dartboard mirror on the iPhone — Glass remains the main view,
  //    this is for setup / fallback / glancing while the user is between
  //    throws. Uses the same Canvas renderer the Glass uses.
  const miniBoard = (els.miniDartboardCanvas && window.DartlineDartboardCanvas)
    ? new window.DartlineDartboardCanvas(els.miniDartboardCanvas)
    : null;
  if (miniBoard) miniBoard.draw();

  els.sessionId.textContent = sessionId;

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "footer__meta footer__meta--status" + (cls ? " " + cls : "");
  }

  // ── Web Audio ───────────────────────────────────────────────────────────
  const sound = window.DartlineSound
    ? new window.DartlineSound.SoundSynth()
    : null;
  let audioReady = false;
  function refreshAudioChip() {
    if (!els.audioTestButton || !sound) return;
    const state = sound.contextState();
    els.audioTestButton.dataset.state = sound.isRunning() ? "on" : "off";
    els.audioTestButton.textContent = sound.isRunning() ? "♪ TEST" : `♪ TEST (${state})`;
  }
  async function unlockAudio({ playConfirm }) {
    if (!sound) return;
    const ok = await sound.unlock();
    refreshAudioChip();
    if (ok && playConfirm && !audioReady) {
      audioReady = true;
      sound.playAimEnter();
    } else if (ok && playConfirm) {
      // Subsequent presses of TEST always play a tone so the user can
      // verify audio at any time.
      sound.playAimEnter();
    }
  }
  if (sound) {
    // First user-gesture anywhere → unlock + play confirmation tone so
    // the user gets immediate audible feedback that audio is alive.
    const firstTouch = () => unlockAudio({ playConfirm: true });
    ["pointerdown", "touchstart", "keydown"].forEach((ev) =>
      document.addEventListener(ev, firstTouch, { once: true, passive: true }));
  }

  // ── WebSocket ───────────────────────────────────────────────────────────
  let ws = null;
  let reconnectAttempts = 0;
  const MAX_BACKOFF_MS = 5000;

  function connect() {
    const url = `${RELAY_URL}/ws?s=${encodeURIComponent(sessionId)}&r=controller`;
    setStatus("connecting", "waiting");
    try {
      ws = new WebSocket(url);
    } catch (_) {
      scheduleReconnect();
      return;
    }
    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("connected", "connected");
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "hello") {
          const hasDisplay = (msg.peers || []).includes("display");
          setStatus(hasDisplay ? "linked" : "waiting display", hasDisplay ? "connected" : "waiting");
          // Display may already be connected — push current state in case
          // it loaded before us and missed the live updates.
          if (hasDisplay) sendInitialState();
        } else if (msg.type === "peer_joined" && msg.role === "display") {
          setStatus("linked", "connected");
          // New display joined — replay current state so it doesn't sit on
          // its boot-time "calibrating" overlay forever.
          sendInitialState();
        } else if (msg.type === "peer_left" && msg.role === "display") {
          setStatus("waiting display", "waiting");
        }
      } catch (_) {}
    });
    ws.addEventListener("close", () => { setStatus("disconnected", "error"); scheduleReconnect(); });
    ws.addEventListener("error", () => { setStatus("error", "error"); });
  }

  // Resend the controller's current state — used when a display joins (or
  // when we discover a display is already connected on hello).
  function sendInitialState() {
    sendMaybe({ type: "aim_state", state: aimStateNow, ts: Date.now() });
    if (locked) {
      sendMaybe({ type: "lock", x: lockedAim.x, y: lockedAim.y, ts: Date.now() });
    } else {
      sendMaybe({ type: "unlock", ts: Date.now() });
    }
    if (game) {
      sendMaybe({ type: "game_state", snapshot: game.snapshot(), result: "rejoin", ts: Date.now() });
    }
  }

  // Heartbeat — broadcast the current aim_state every 1500 ms so a display
  // that joined late (or any cached display that missed earlier state
  // updates) catches up within ~2 seconds. Cheap insurance against the
  // Worker-as-pure-relay design having no history.
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendMaybe({ type: "aim_state", state: aimStateNow, ts: Date.now() });
  }, 1500);
  function scheduleReconnect() {
    reconnectAttempts += 1;
    const delay = Math.min(500 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
    setTimeout(connect, delay);
  }
  function sendMaybe(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch (_) {}
  }

  // ── Sensor permissions ──────────────────────────────────────────────────
  function needsPermission() {
    return typeof DeviceMotionEvent !== "undefined" &&
           typeof DeviceMotionEvent.requestPermission === "function";
  }
  async function requestPermissions() {
    try {
      const m = await DeviceMotionEvent.requestPermission();
      let o = "granted";
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        o = await DeviceOrientationEvent.requestPermission();
      }
      if (m === "granted" && o === "granted") {
        els.permissionCard.classList.add("hidden");
        startSensors();
      } else {
        setStatus("permission denied", "error");
      }
    } catch (_) {
      setStatus("permission error", "error");
    }
  }

  // ── Sensor + tracker plumbing ───────────────────────────────────────────
  const SEND_INTERVAL_MS = 20;       // raw motion → relay
  const AIM_SEND_INTERVAL_MS = 33;   // 30 Hz aim updates
  let lastSentAt = 0;
  let lastAimSentAt = 0;
  let lastAimSent = { x: 0, y: 0 };
  let latestRotationRate = null;
  const latest = { ax: 0, ay: 0, az: 0, alpha: 0, beta: 0, gamma: 0 };

  let throwDetector = null;
  let throwResolver = null;
  let aimTracker = null;
  let aimStateNow = "calibrating";
  let locked = false;
  let lockedAim = { x: 0, y: 0 };

  function initTrackers() {
    if (!window.DartlineMotion) return;
    throwDetector = new window.DartlineMotion.ThrowDetector();
    throwDetector.on(onThrow);
    throwResolver = new window.DartlineMotion.ThrowResolver();
    aimTracker = new window.DartlineMotion.AimTracker();
    aimTracker.onStateChange(onAimState);
    aimTracker.onAim(onAim);
    onAimState(aimTracker.state);
  }

  function onMotion(event) {
    const acc = event.accelerationIncludingGravity || event.acceleration || {};
    latest.ax = acc.x ?? 0;
    latest.ay = acc.y ?? 0;
    latest.az = acc.z ?? 0;
    if (event.rotationRate) {
      latestRotationRate = {
        alpha: event.rotationRate.alpha ?? 0,
        beta:  event.rotationRate.beta  ?? 0,
        gamma: event.rotationRate.gamma ?? 0,
      };
    }
    flushMotion();
    if (throwDetector) throwDetector.feed(latest.ax, latest.ay, latest.az);
  }
  function onOrientation(event) {
    latest.alpha = event.alpha ?? 0;
    latest.beta  = event.beta  ?? 0;
    latest.gamma = event.gamma ?? 0;
    flushMotion();
    if (aimTracker) {
      aimTracker.feed({
        beta: latest.beta,
        gamma: latest.gamma,
        rotationRate: latestRotationRate,
      });
    }
  }
  function flushMotion() {
    const now = Date.now();
    if (now - lastSentAt < SEND_INTERVAL_MS) return;
    lastSentAt = now;
    sendMaybe(window.DartlineProtocol.motion({ ...latest, ts: now }));
  }

  function onAimState(state) {
    aimStateNow = state;
    els.aimStateChip.textContent = state.toUpperCase();
    // Locked state takes precedence visually.
    els.aimStateChip.dataset.state = locked ? "locked" : state;
    sendMaybe({ type: "aim_state", state, ts: Date.now() });
    if (state === "aiming" && sound) sound.playAimEnter();
    refreshMainButton();
    // Mirror calibration overlay on the iPhone canvas too.
    if (els.miniAimOverlay) {
      els.miniAimOverlay.classList.toggle("hidden", state === "aiming");
    }
  }

  function onAim(aim) {
    lastAimSent = aim;
    // Mirror live aim onto the iPhone canvas at full 60 fps locally (no
    // throttling — only the over-the-wire path is throttled to 30 Hz).
    if (miniBoard) miniBoard.setAim({ x: aim.x, y: aim.y });
    const now = Date.now();
    if (now - lastAimSentAt < AIM_SEND_INTERVAL_MS) return;
    lastAimSentAt = now;
    sendMaybe({ type: "aim", x: aim.x, y: aim.y, ts: now });
  }

  function startSensors() {
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrientation);
  }

  // ── Game ────────────────────────────────────────────────────────────────
  const game = window.DartlineGame ? new window.DartlineGame.CountUpGame() : null;

  function startNewGame() {
    if (!game) return;
    game.start();
    sendMaybe({ type: "game_state", snapshot: game.snapshot(), result: "start", ts: Date.now() });
    renderGame();
    refreshMainButton();
  }

  function renderGame() {
    if (!game) return;
    const snap = game.snapshot();
    // Round chip
    if (snap.status === "idle") {
      els.roundChip.textContent = `ROUND — / ${snap.totalRounds}`;
    } else if (snap.status === "finished") {
      els.roundChip.textContent = `FINAL`;
    } else {
      els.roundChip.textContent = `ROUND ${snap.round + 1} / ${snap.totalRounds}`;
    }
    // 3-dot throw indicator
    const dots = els.throwDots.querySelectorAll(".dot");
    dots.forEach((dot, idx) => {
      dot.classList.toggle("filled", idx < snap.throwInRound && snap.status === "playing");
    });
    if (snap.status === "finished") {
      // After finish: light all 3 dots amber.
      dots.forEach((dot) => dot.classList.add("filled"));
    }
    // Total
    els.totalValue.textContent = String(snap.totalScore);
    const totalEl = els.totalValue.parentElement;
    const isNewBest = snap.status === "finished" && snap.totalScore > 0 && snap.totalScore >= snap.best;
    totalEl.classList.toggle("new-best", isNewBest);
    // Best
    els.bestChip.textContent = snap.best > 0 ? `BEST ${snap.best}` : "BEST —";
    // Last hit
    if (snap.lastHit) {
      els.lastHitChip.textContent =
        `${snap.lastHit.label}  ${snap.lastHit.points > 0 ? "+" : ""}${snap.lastHit.points}`;
    } else {
      els.lastHitChip.textContent = "";
    }
  }

  // ── Main button (state-aware) ───────────────────────────────────────────
  function refreshMainButton() {
    if (!game) return;
    const snap = game.snapshot();
    const calibrating = aimStateNow !== "aiming";
    if (snap.status === "idle") {
      els.mainButton.dataset.mode = "start";
      els.mainButtonLabel.textContent = "START";
      els.mainButtonSub.textContent = "8 ラウンド × 3 投";
      return;
    }
    if (snap.status === "finished") {
      els.mainButton.dataset.mode = "start";
      els.mainButtonLabel.textContent = "PLAY AGAIN";
      els.mainButtonSub.textContent = `FINAL ${snap.totalScore}`;
      return;
    }
    // playing
    if (calibrating) {
      els.mainButton.dataset.mode = "disabled";
      els.mainButtonLabel.textContent = "...";
      els.mainButtonSub.textContent = "CALIBRATING";
      return;
    }
    if (locked) {
      els.mainButton.dataset.mode = "unlock";
      els.mainButtonLabel.textContent = "UNLOCK";
      els.mainButtonSub.textContent = "AIMING FROZEN";
    } else {
      els.mainButton.dataset.mode = "lock";
      els.mainButtonLabel.textContent = "LOCK";
      els.mainButtonSub.textContent = `THROW ${snap.throwInRound + 1} OF ${snap.throwsPerRound}`;
    }
  }

  function onMainButtonClick() {
    if (!game) return;
    const snap = game.snapshot();
    if (snap.status === "idle" || snap.status === "finished") {
      startNewGame();
      return;
    }
    // playing
    if (aimStateNow !== "aiming") return;   // disabled
    toggleLock();
  }

  function toggleLock() {
    if (locked) {
      locked = false;
      sendMaybe({ type: "unlock", ts: Date.now() });
    } else {
      lockedAim = { x: lastAimSent.x, y: lastAimSent.y };
      locked = true;
      sendMaybe({ type: "lock", x: lockedAim.x, y: lockedAim.y, ts: Date.now() });
      if (sound) sound.playAimLock();
    }
    els.aimStateChip.dataset.state = locked ? "locked" : aimStateNow;
    els.aimStateChip.textContent = locked ? "LOCKED" : aimStateNow.toUpperCase();
    if (miniBoard) miniBoard.setLock(locked, locked ? lockedAim : null);
    refreshMainButton();
  }

  // ── Throw handler ───────────────────────────────────────────────────────
  function onThrow(event) {
    if (sound) sound.playThrowSnap();
    const baseAim = locked ? lockedAim : lastAimSent;
    // Apply ThrowResolver: turn (aim, force) into the actual landing point.
    // This gives the game challenge — perfect intent isn't perfect outcome.
    const landing = throwResolver
      ? throwResolver.resolve(baseAim, event.force)
      : { x: baseAim.x, y: baseAim.y };
    sendMaybe({
      type: "throw",
      x: landing.x, y: landing.y,
      force: event.force, peak: event.peak,
      ts: event.ts, locked,
      aimX: baseAim.x, aimY: baseAim.y,   // original intent — for diagnostics
    });
    // Score the LANDING (not the intent) and advance the game.
    if (game && window.DartlineDartboard && game.snapshot().status === "playing") {
      const score = window.DartlineDartboard.scoreAt(landing.x, landing.y);
      const result = game.recordHit(score);
      renderGame();
      sendMaybe({
        type: "game_state",
        snapshot: game.snapshot(),
        result,
        ts: Date.now(),
      });
      // Mirror the hit on the iPhone canvas too.
      if (miniBoard) miniBoard.addHit(landing.x, landing.y, score);
      // Brief local impact tap on the iPhone speaker so the user feels the
      // hit in their throwing hand. The Glass plays the full score chime.
      if (sound) sound._impact(sound._now(), 0.6);
      if ((result === "round_end" || result === "game_end") && locked) {
        toggleLock();
      }
      refreshMainButton();
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  initTrackers();
  renderGame();
  refreshMainButton();
  els.mainButton.addEventListener("click", onMainButtonClick);
  els.recalibrateButton.addEventListener("click", () => {
    if (locked) toggleLock();
    if (aimTracker) aimTracker.recalibrate();
  });
  if (els.audioTestButton) {
    els.audioTestButton.addEventListener("click", () => {
      unlockAudio({ playConfirm: true });
    });
  }
  refreshAudioChip();
  connect();
  if (needsPermission()) {
    els.permissionCard.classList.remove("hidden");
    els.permissionButton.addEventListener("click", requestPermissions);
  } else {
    startSensors();
  }
})();
