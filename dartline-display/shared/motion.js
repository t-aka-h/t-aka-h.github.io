// Dartline Display — Throw detection.
// Reads DeviceMotionEvent.accelerationIncludingGravity (m/s²) on each frame
// and emits a single "throw" event when a swing-and-release pattern is detected.
//
// Algorithm (3-state machine):
//
//   idle   ─ mag > spikeThreshold ──→ armed
//   armed  ─ track peak for peakWindowMs ──→ emit throw, enter cooldown
//   cooldown (cooldownMs) ──→ idle
//
// Tuning constants are exposed via `new ThrowDetector(options)` so we can
// adjust them during real-device testing without code edits.

(() => {
  const DEFAULTS = {
    // Acceleration magnitude (m/s², including gravity) above which we consider
    // a "throw motion" to be in progress. Resting orientation reads ~9.8.
    spikeThreshold: 18,

    // After the spike, keep tracking peak magnitude for this long.
    peakWindowMs: 220,

    // ── settle-based gating ──────────────────────────────────────────────
    // After emitting a throw, we wait for the phone to stop moving before
    // accepting another throw. The phone is "settled" once magnitude stays
    // under `settleThreshold` for `settleFramesRequired` consecutive frames.
    // This lets the user fire rapid throws as soon as the arm rests, while
    // still absorbing the post-release rebound spike.
    settleThreshold: 12,
    settleFramesRequired: 4,

    // Safety net — if we never settle (constant shaking), force-release the
    // gate after this long so the detector doesn't get stuck.
    maxSettleMs: 800,

    // Map peak magnitude → normalized force in [0, 1].
    //   forceFloor = peak that yields force 0
    //   forceCeil  = peak that yields force 1
    forceFloor: 15,
    forceCeil: 45,

    // Sample period used for the abort guard. If we never saw a peak above
    // (spikeThreshold + minOvershoot) during the armed window, abort —
    // treat it as a stationary tap / placement bump.
    minOvershoot: 4,
  };

  class ThrowDetector {
    constructor(options = {}) {
      this.opts = { ...DEFAULTS, ...options };
      this.reset();
      // Subscribers: function(event) where event = { force, peak, ts }.
      this._listeners = [];
    }

    reset() {
      this.state = "idle";
      this.peakMagnitude = 0;
      this.armedAt = 0;
      this.settleEnteredAt = 0;
      this.settleFrames = 0;
    }

    on(fn) {
      this._listeners.push(fn);
      return () => {
        const i = this._listeners.indexOf(fn);
        if (i >= 0) this._listeners.splice(i, 1);
      };
    }

    // Call this on every devicemotion frame. `ax, ay, az` should be the
    // accelerationIncludingGravity values in m/s². `now` defaults to
    // Date.now() but can be passed for deterministic tests.
    feed(ax, ay, az, now) {
      now = now ?? Date.now();
      const mag = Math.hypot(ax, ay, az);

      switch (this.state) {
        case "idle":
          if (mag >= this.opts.spikeThreshold) {
            this.state = "armed";
            this.peakMagnitude = mag;
            this.armedAt = now;
          }
          return null;

        case "armed": {
          if (mag > this.peakMagnitude) this.peakMagnitude = mag;
          const elapsed = now - this.armedAt;
          if (elapsed < this.opts.peakWindowMs) return null;
          // Window closed — decide.
          const overshoot = this.peakMagnitude - this.opts.spikeThreshold;
          if (overshoot < this.opts.minOvershoot) {
            // Looked like a spike but never built up — abort silently.
            this.state = "settling";
            this.settleEnteredAt = now;
            this.settleFrames = 0;
            this.peakMagnitude = 0;
            this.armedAt = 0;
            return null;
          }
          const force = this._normalizeForce(this.peakMagnitude);
          const event = {
            force,
            peak: this.peakMagnitude,
            ts: now,
          };
          this.state = "settling";
          this.settleEnteredAt = now;
          this.settleFrames = 0;
          this.peakMagnitude = 0;
          this.armedAt = 0;
          for (const fn of this._listeners) {
            try { fn(event); } catch (_) {}
          }
          return event;
        }

        case "settling": {
          // Wait for the phone to come to rest before accepting the next
          // throw. Any sample at or above settleThreshold resets the count,
          // so the rebound spike from the previous throw won't slip past.
          if (mag < this.opts.settleThreshold) {
            this.settleFrames += 1;
          } else {
            this.settleFrames = 0;
          }
          const stuck = (now - this.settleEnteredAt) >= this.opts.maxSettleMs;
          if (this.settleFrames >= this.opts.settleFramesRequired || stuck) {
            this.state = "idle";
            this.settleFrames = 0;
            this.settleEnteredAt = 0;
          }
          return null;
        }

        default:
          return null;
      }
    }

    _normalizeForce(peak) {
      const { forceFloor, forceCeil } = this.opts;
      if (forceCeil <= forceFloor) return 0;
      const n = (peak - forceFloor) / (forceCeil - forceFloor);
      return Math.max(0, Math.min(1, n));
    }
  }

  window.DartlineMotion = { ThrowDetector, DEFAULTS };
})();
