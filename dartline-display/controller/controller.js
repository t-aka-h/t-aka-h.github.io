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
    modeSelect:        document.getElementById("modeSelect"),
    modeList:          document.getElementById("modeList"),
    scoreboard:        document.getElementById("scoreboard"),
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
        } else if (msg.type === "glass_action") {
          handleGlassAction(msg.action);
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

  // Glass-side gestures (Meta Neural Band pinch / swipe arrive as keydown
  // events on the display, which forwards them as glass_action messages).
  // Routing them through the controller keeps game state single-sourced.
  function handleGlassAction(action) {
    if (action === "primary") {
      // Pinch = same effect as tapping the big iPhone button. Context-aware
      // so a single gesture handles START / LOCK / UNLOCK / PLAY AGAIN.
      onMainButtonClick();
    } else if (action === "back") {
      // Long-pinch / Escape — drop any lock and re-center the aim.
      if (locked) toggleLock();
      if (aimTracker) aimTracker.recalibrate();
    }
    // Other arrow keys are reserved for future use (e.g. navigating
    // between game modes once Cricket / 301 / 501 land).
  }
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
    if (state === "aiming") {
      if (sound) sound.playAimEnter();
      if (window.DartlineHaptics) window.DartlineHaptics.tick();
    }
    refreshMainButton();
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
  let game = window.DartlineGame ? window.DartlineGame.makeGame("count_up") : null;
  let currentModeId = "count_up";

  function populateModeList() {
    if (!els.modeList || !window.DartlineGame) return;
    els.modeList.innerHTML = "";
    window.DartlineGame.MODE_LIST.forEach((mode) => {
      const row = document.createElement("div");
      row.className = "mode-item" + (mode.id === currentModeId ? " selected" : "");
      row.dataset.modeId = mode.id;
      row.innerHTML =
        `<div class="mode-item__name">${mode.name}</div>` +
        `<div class="mode-item__hint">${mode.hint}</div>`;
      row.addEventListener("click", () => {
        if (game && game.snapshot().status === "playing") return; // can't change mid-game
        currentModeId = mode.id;
        game = window.DartlineGame.makeGame(currentModeId);
        populateModeList();
        renderGame();
        refreshMainButton();
        // Notify display so its HUD switches to the new game type's idle view.
        sendMaybe({
          type: "game_state",
          snapshot: game.snapshot(),
          result: "mode_change",
          ts: Date.now(),
        });
      });
      els.modeList.appendChild(row);
    });
  }

  function startNewGame() {
    if (!window.DartlineGame) return;
    // Always make a fresh game instance — handles "PLAY AGAIN" after finish
    // and "START" after a mode change cleanly.
    game = window.DartlineGame.makeGame(currentModeId);
    game.start();
    sendMaybe({ type: "game_state", snapshot: game.snapshot(), result: "start", ts: Date.now() });
    refreshGameSection();
    renderGame();
    refreshMainButton();
  }

  function refreshGameSection() {
    if (!els.modeSelect || !els.scoreboard) return;
    const snap = game ? game.snapshot() : null;
    const isPlaying = snap && snap.status === "playing";
    els.modeSelect.classList.toggle("hidden", !!isPlaying);
    els.scoreboard.classList.toggle("hidden", !isPlaying && snap && snap.status !== "finished");
  }

  function renderGame() {
    if (!game) return;
    const snap = game.snapshot();
    // Round chip — game-type aware.
    let roundText = "";
    if (snap.gameType === "x01") {
      const t = snap.throwsTaken || 0;
      roundText = snap.status === "playing"
        ? `TURN ${snap.round + 1}  ·  ${t} darts`
        : (snap.status === "finished" ? `FINAL  ${t} darts` : `${snap.startingScore} — READY`);
    } else if (snap.gameType === "cricket_standard") {
      const closed = snap.targets.filter((t) => snap.marks[t] >= 3).length;
      roundText = snap.status === "playing"
        ? `${closed} / ${snap.targets.length} CLOSED`
        : (snap.status === "finished" ? `ALL CLOSED` : `READY`);
    } else if (snap.gameType === "cricket_cut_throat") {
      roundText = snap.status === "playing"
        ? `${snap.players[snap.currentPlayer].name} · TURN ${Math.floor(snap.round / 2) + 1}`
        : (snap.status === "finished" ? `FINAL` : `2P — READY`);
    } else if (snap.gameType === "cricket_count_up") {
      const tgts = snap.currentTargets || [];
      const tgtLabel = tgts.length === 1 ? (tgts[0] === 25 ? "BULL" : String(tgts[0])) : "ALL";
      roundText = snap.status === "playing"
        ? `ROUND ${snap.round + 1}/${snap.totalRounds}  →  ${tgtLabel}`
        : (snap.status === "finished" ? `FINAL` : `8 ROUNDS — READY`);
    } else {
      // count_up
      roundText = snap.status === "idle"   ? `ROUND — / ${snap.totalRounds}`
                : snap.status === "finished" ? `FINAL`
                : `ROUND ${snap.round + 1} / ${snap.totalRounds}`;
    }
    els.roundChip.textContent = roundText;

    // 3-dot throw indicator
    const dots = els.throwDots.querySelectorAll(".dot");
    dots.forEach((dot, idx) => {
      dot.classList.toggle("filled", idx < snap.throwInRound && snap.status === "playing");
    });
    if (snap.status === "finished") dots.forEach((dot) => dot.classList.add("filled"));

    // TOTAL number — depends on game type.
    let totalText;
    if (snap.gameType === "x01") {
      totalText = String(snap.remaining);
    } else if (snap.gameType === "cricket_standard") {
      totalText = String(snap.points);
    } else if (snap.gameType === "cricket_cut_throat") {
      totalText = String(snap.players[snap.currentPlayer].points);
    } else {
      totalText = String(snap.totalScore);
    }
    els.totalValue.textContent = totalText;
    const totalEl = els.totalValue.parentElement;
    // "new best" highlight: count_up / cricket_count_up / cricket_standard
    // → higher score is better; x01 / cut_throat → lower-is-better.
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
    totalEl.classList.toggle("new-best", isNewBest);

    // Best chip label varies by game.
    if (snap.gameType === "x01") {
      els.bestChip.textContent = snap.best > 0 ? `BEST ${snap.best} darts` : "BEST —";
    } else if (snap.gameType === "cricket_cut_throat") {
      els.bestChip.textContent = snap.best > 0 ? `LOW ${snap.best}` : "LOW —";
    } else {
      els.bestChip.textContent = snap.best > 0 ? `BEST ${snap.best}` : "BEST —";
    }

    // Last hit
    if (snap.lastHit) {
      const tail = snap.lastHit.bust ? " BUST" :
                   (snap.lastHit.points !== 0
                      ? `  ${snap.lastHit.points > 0 ? "+" : ""}${snap.lastHit.points}`
                      : "");
      els.lastHitChip.textContent = `${snap.lastHit.label}${tail}`;
    } else {
      els.lastHitChip.textContent = "";
    }

    refreshGameSection();
  }

  // ── Main button (state-aware) ───────────────────────────────────────────
  function modeSubLabel(snap) {
    switch (snap.gameType) {
      case "x01": return `${snap.startingScore}${snap.doubleOut ? " · DOUBLE OUT" : ""}`;
      case "cricket_count_up":   return "20→…→BULL→ALL";
      case "cricket_standard":   return "CLOSE 15-20 + BULL";
      case "cricket_cut_throat": return "2 PLAYER · LOW WINS";
      case "count_up":
      default:                   return "8 ROUNDS × 3 THROWS";
    }
  }

  function refreshMainButton() {
    if (!game) return;
    const snap = game.snapshot();
    const calibrating = aimStateNow !== "aiming";
    if (snap.status === "idle") {
      els.mainButton.dataset.mode = "start";
      els.mainButtonLabel.textContent = "START";
      els.mainButtonSub.textContent = modeSubLabel(snap);
      return;
    }
    if (snap.status === "finished") {
      els.mainButton.dataset.mode = "start";
      els.mainButtonLabel.textContent = "PLAY AGAIN";
      let finalText;
      if (snap.gameType === "x01") {
        finalText = `${snap.throwsTaken} darts`;
      } else if (snap.gameType === "cricket_cut_throat") {
        finalText = `LOW ${snap.totalScore}`;
      } else {
        finalText = `FINAL ${snap.totalScore}`;
      }
      els.mainButtonSub.textContent = finalText;
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
    if (window.DartlineHaptics) window.DartlineHaptics.click();
    els.aimStateChip.dataset.state = locked ? "locked" : aimStateNow;
    els.aimStateChip.textContent = locked ? "LOCKED" : aimStateNow.toUpperCase();
    if (miniBoard) miniBoard.setLock(locked, locked ? lockedAim : null);
    refreshMainButton();
  }

  // ── Throw handler ───────────────────────────────────────────────────────
  function onThrow(event) {
    if (sound) sound.playThrowSnap();
    if (window.DartlineHaptics) window.DartlineHaptics.throw_();
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
      // Haptic burst on landing — scales by what got hit. On Android this
      // is a real vibration; on iOS Safari it's a no-op (Apple hasn't
      // shipped Web Vibration).
      if (window.DartlineHaptics) {
        if (result === "game_end") window.DartlineHaptics.gameOver();
        else if (score.ring === "double-bull" ||
                (score.multiplier === 3 && score.points >= 51)) {
          window.DartlineHaptics.perfect();
        } else {
          window.DartlineHaptics.hit(score.ring);
        }
      }
      if ((result === "round_end" || result === "game_end") && locked) {
        toggleLock();
      }
      refreshMainButton();
    }
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  initTrackers();
  populateModeList();
  refreshGameSection();
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
