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
    ax: document.getElementById("ax"),
    ay: document.getElementById("ay"),
    az: document.getElementById("az"),
    alpha: document.getElementById("alpha"),
    beta: document.getElementById("beta"),
    gamma: document.getElementById("gamma"),
    throwOverlay: document.getElementById("throwOverlay"),
    throwForce: document.getElementById("throwForce"),
    throwFill: document.getElementById("throwFill"),
  };

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
        renderMotion(msg);
        break;
      case "throw":
        showThrow(msg);
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

  function renderMotion(msg) {
    setValue(els.ax, msg.ax, 2);
    setValue(els.ay, msg.ay, 2);
    setValue(els.az, msg.az, 2);
    setValue(els.alpha, msg.alpha, 1);
    setValue(els.beta,  msg.beta,  1);
    setValue(els.gamma, msg.gamma, 1);

    frameCount += 1;
    const now = Date.now();
    if (now - lastRateUpdate >= 1000) {
      const hz = Math.round((frameCount * 1000) / (now - lastRateUpdate));
      els.rate.textContent = `${hz} Hz`;
      frameCount = 0;
      lastRateUpdate = now;
    }
  }

  function setValue(el, n, digits) {
    if (typeof n !== "number" || !isFinite(n)) return;
    el.textContent = n.toFixed(digits);
    // Brief flash so a glance at the glasses confirms data is flowing.
    el.classList.remove("pulse");
    // Force reflow so re-adding the class restarts the animation.
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  connect();
})();
