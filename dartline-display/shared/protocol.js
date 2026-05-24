// Dartline Display — WebSocket message schema.
// Loaded as a plain script (no modules) so both controller and display
// can use it the same way.
//
// Convention: every message is a JSON object with a "type" field.

window.DartlineProtocol = (() => {
  // Phase 0 — raw motion echo. Will be replaced by structured throw events
  // in Phase 1.
  function motion({ ax, ay, az, alpha, beta, gamma, ts }) {
    return { type: "motion", ax, ay, az, alpha, beta, gamma, ts };
  }

  // Display reports it is ready and listening.
  function ready() {
    return { type: "ready" };
  }

  // Controller -> Display: current aim coordinates in normalized space
  // (-1..+1 on each axis, 0 = center).
  function aim({ x, y, ts }) {
    return { type: "aim", x, y, ts };
  }

  // Controller -> Display: a completed throw landed at (x, y).
  function throwLanded({ x, y, force, score, segment, ts }) {
    return { type: "throw", x, y, force, score, segment, ts };
  }

  return { motion, ready, aim, throwLanded };
})();
