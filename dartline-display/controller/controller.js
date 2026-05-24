// Dartline Display — Controller (iPhone Safari)
// Phase 0: stream raw DeviceMotion / DeviceOrientation to the display.

(() => {
  const DEFAULT_SESSION = "DEMO01";
  // Override at runtime by serving with ?s=ABC123. For local dev without a
  // worker deployed yet, set RELAY_URL to e.g. ws://192.168.1.x:8787 .
  const RELAY_URL =
    new URLSearchParams(location.search).get("relay") ||
    "wss://dartline-display-relay.darts-relay.workers.dev";

  const params = new URLSearchParams(location.search);
  const sessionId = (params.get("s") || DEFAULT_SESSION).toUpperCase();

  const els = {
    session: document.getElementById("sessionId"),
    status: document.getElementById("status"),
    permissionCard: document.getElementById("permissionCard"),
    permissionButton: document.getElementById("permissionButton"),
    ax: document.getElementById("ax"),
    ay: document.getElementById("ay"),
    az: document.getElementById("az"),
    alpha: document.getElementById("alpha"),
    beta: document.getElementById("beta"),
    gamma: document.getElementById("gamma"),
    peakMag: document.getElementById("peakMag"),
    lastForce: document.getElementById("lastForce"),
    throwCount: document.getElementById("throwCount"),
    throwFlash: document.getElementById("throwFlash"),
    aimState: document.getElementById("aimState"),
    aimXY: document.getElementById("aimXY"),
    recalibrateButton: document.getElementById("recalibrateButton"),
    lockButton: document.getElementById("lockButton"),
  };

  els.session.textContent = sessionId;

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "value" + (cls ? " " + cls : "");
  }

  // ---- WebSocket -----------------------------------------------------------

  let ws = null;
  let reconnectAttempts = 0;
  const MAX_BACKOFF_MS = 5000;

  function connect() {
    const url = `${RELAY_URL}/ws?s=${encodeURIComponent(sessionId)}&r=controller`;
    setStatus("connecting", "waiting");
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setStatus("error", "error");
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
      setStatus("connected", "connected");
    });

    ws.addEventListener("message", (event) => {
      // Phase 0: log only; controller doesn't act on display messages yet.
      // (Future: handle menu selections from the glasses.)
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "hello" || msg.type === "peer_joined" || msg.type === "peer_left") {
          // Keep status fresh based on whether a display is present.
          if (msg.type === "hello") {
            const hasDisplay = (msg.peers || []).includes("display");
            setStatus(hasDisplay ? "linked" : "waiting for display", hasDisplay ? "connected" : "waiting");
          } else if (msg.type === "peer_joined" && msg.role === "display") {
            setStatus("linked", "connected");
          } else if (msg.type === "peer_left" && msg.role === "display") {
            setStatus("waiting for display", "waiting");
          }
        }
      } catch (_) {}
    });

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

  function sendMaybe(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  // ---- Sensors -------------------------------------------------------------

  // iOS 13+ requires an explicit permission request triggered by a user gesture.
  function needsPermission() {
    return (
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    );
  }

  async function requestPermissions() {
    try {
      const motionPerm = await DeviceMotionEvent.requestPermission();
      let orientPerm = "granted";
      if (
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        orientPerm = await DeviceOrientationEvent.requestPermission();
      }
      if (motionPerm === "granted" && orientPerm === "granted") {
        els.permissionCard.classList.add("hidden");
        startSensors();
      } else {
        setStatus("permission denied", "error");
      }
    } catch (e) {
      setStatus("permission error", "error");
    }
  }

  // Throttle outbound motion frames so we don't flood the relay.
  // 50 Hz feels plenty for Phase 0.
  const SEND_INTERVAL_MS = 20;
  let lastSentAt = 0;
  let latest = { ax: 0, ay: 0, az: 0, alpha: 0, beta: 0, gamma: 0 };

  function onMotion(event) {
    const acc = event.accelerationIncludingGravity || event.acceleration || {};
    latest.ax = acc.x ?? 0;
    latest.ay = acc.y ?? 0;
    latest.az = acc.z ?? 0;
    // Capture rotationRate for the aim tracker's calibration check.
    if (event.rotationRate) {
      latestRotationRate = {
        alpha: event.rotationRate.alpha ?? 0,
        beta:  event.rotationRate.beta  ?? 0,
        gamma: event.rotationRate.gamma ?? 0,
      };
    }
    render();
    flush();
    if (throwDetector) {
      throwDetector.feed(latest.ax, latest.ay, latest.az);
      const peak = throwDetector.peakMagnitude || 0;
      if (peak > 0) els.peakMag.textContent = peak.toFixed(2);
    }
  }

  function onOrientation(event) {
    latest.alpha = event.alpha ?? 0;
    latest.beta = event.beta ?? 0;
    latest.gamma = event.gamma ?? 0;
    render();
    flush();
    if (aimTracker) {
      aimTracker.feed({
        beta: latest.beta,
        gamma: latest.gamma,
        rotationRate: latestRotationRate,
      });
    }
  }

  function render() {
    els.ax.textContent = latest.ax.toFixed(2);
    els.ay.textContent = latest.ay.toFixed(2);
    els.az.textContent = latest.az.toFixed(2);
    els.alpha.textContent = latest.alpha.toFixed(1);
    els.beta.textContent = latest.beta.toFixed(1);
    els.gamma.textContent = latest.gamma.toFixed(1);
  }

  function flush() {
    const now = Date.now();
    if (now - lastSentAt < SEND_INTERVAL_MS) return;
    lastSentAt = now;
    sendMaybe(window.DartlineProtocol.motion({ ...latest, ts: now }));
  }

  function startSensors() {
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrientation);
  }

  // ---- Throw detection -----------------------------------------------------

  let throwDetector = null;
  let throwCount = 0;
  let latestRotationRate = null;
  let aimTracker = null;
  let lastAimSent = { x: 0, y: 0 };
  let lastAimSentAt = 0;
  const AIM_SEND_INTERVAL_MS = 50; // 20 Hz aim updates over the wire.
  let locked = false;
  let lockedAim = { x: 0, y: 0 };

  function initThrowDetector() {
    if (!window.DartlineMotion) return;
    throwDetector = new window.DartlineMotion.ThrowDetector();
    throwDetector.on(onThrow);
    aimTracker = new window.DartlineMotion.AimTracker();
    aimTracker.onStateChange(onAimState);
    aimTracker.onAim(onAim);
    onAimState(aimTracker.state);
    if (els.recalibrateButton) {
      els.recalibrateButton.addEventListener("click", () => {
        if (locked) toggleLock();   // implicitly release lock on re-center
        aimTracker.recalibrate();
      });
    }
    if (els.lockButton) {
      els.lockButton.addEventListener("click", toggleLock);
      updateLockButton();
    }
  }

  function toggleLock() {
    if (locked) {
      locked = false;
      sendMaybe({ type: "unlock", ts: Date.now() });
    } else {
      lockedAim = { x: lastAimSent.x, y: lastAimSent.y };
      locked = true;
      sendMaybe({
        type: "lock",
        x: lockedAim.x,
        y: lockedAim.y,
        ts: Date.now(),
      });
    }
    updateLockButton();
  }

  function updateLockButton() {
    if (!els.lockButton) return;
    if (locked) {
      els.lockButton.textContent = "UNLOCK";
      els.lockButton.classList.add("primary--lock-on");
    } else {
      els.lockButton.textContent = "LOCK";
      els.lockButton.classList.remove("primary--lock-on");
    }
  }

  function onAimState(state) {
    els.aimState.textContent = state;
    els.aimState.className = "value " + (state === "aiming" ? "connected" : "waiting");
    // Send a state update so the display can show "calibrating" vs "aiming".
    sendMaybe({ type: "aim_state", state, ts: Date.now() });
  }

  function onAim(aim) {
    lastAimSent = aim;
    els.aimXY.textContent = aim.x.toFixed(2) + "  ·  " + aim.y.toFixed(2);
    const now = Date.now();
    if (now - lastAimSentAt < AIM_SEND_INTERVAL_MS) return;
    lastAimSentAt = now;
    sendMaybe({ type: "aim", x: aim.x, y: aim.y, ts: now });
  }

  function onThrow(event) {
    throwCount += 1;
    els.throwCount.textContent = String(throwCount);
    els.lastForce.textContent = event.force.toFixed(2) + "  (peak " + event.peak.toFixed(1) + ")";
    flashThrow(event.force);
    // Use the locked aim if available, otherwise fall back to the live aim.
    const aim = locked ? lockedAim : lastAimSent;
    sendMaybe({
      type: "throw",
      x: aim.x,
      y: aim.y,
      force: event.force,
      peak: event.peak,
      ts: event.ts,
      locked,
    });
  }

  function flashThrow(force) {
    const el = els.throwFlash;
    if (!el) return;
    el.querySelector(".throw-flash__force").textContent = "force " + force.toFixed(2);
    el.classList.remove("active");
    void el.offsetWidth;
    el.classList.add("active");
  }

  // ---- Boot ----------------------------------------------------------------

  initThrowDetector();
  connect();
  if (needsPermission()) {
    els.permissionCard.classList.remove("hidden");
    els.permissionButton.addEventListener("click", requestPermissions);
  } else {
    startSensors();
  }
})();
