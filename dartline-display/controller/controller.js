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
    render();
    flush();
  }

  function onOrientation(event) {
    latest.alpha = event.alpha ?? 0;
    latest.beta = event.beta ?? 0;
    latest.gamma = event.gamma ?? 0;
    render();
    flush();
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

  // ---- Boot ----------------------------------------------------------------

  connect();
  if (needsPermission()) {
    els.permissionCard.classList.remove("hidden");
    els.permissionButton.addEventListener("click", requestPermissions);
  } else {
    startSensors();
  }
})();
