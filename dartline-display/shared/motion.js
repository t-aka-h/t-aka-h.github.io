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

  // ──────────────────────────────────────────────────────────────────────────
  // AimTracker — turns DeviceOrientation deltas into a normalized aim point
  // in the range [-1, +1] on each axis (0 = pointing at the reference / center).
  //
  // Two states:
  //   "calibrating" — wait for the phone to hold still, then capture the
  //                   resting beta/gamma as the reference orientation.
  //   "aiming"      — emit a smoothed aim from beta/gamma deltas.
  //
  // The caller feeds each deviceorientation event; the tracker decides when
  // to fire onAimChange callbacks. Recalibration is a single method call —
  // useful for a "re-center" button in the UI.
  // ──────────────────────────────────────────────────────────────────────────

  const AIM_DEFAULTS = {
    // Tilt angle that maps to the edge of the display (after smoothing).
    // 25° means a comfortable wrist movement reaches the corners.
    sensitivityDeg: 25,

    // Low-pass coefficient (0..1). Higher = snappier, lower = smoother.
    // 0.40 gives a noticeable but pleasant lag.
    smoothing: 0.40,

    // Clamp output to slightly past the edges so the cursor visibly leaves
    // the visible play area at extreme tilts.
    maxRadius: 1.05,

    // Calibration requires N consecutive frames with all rotationRate
    // components below this threshold (degrees per second). Once met,
    // we capture the current beta/gamma as the reference.
    calibStillRateDps: 20,
    calibFramesRequired: 14,

    // Hard timeout — even with some wobble, calibration completes after
    // this many ms so the user is never stuck on "Hold still".
    calibTimeoutMs: 2200,

    // Optional emit throttle (ms). 0 = emit on every input frame.
    emitMinIntervalMs: 0,
  };

  class AimTracker {
    constructor(options = {}) {
      this.opts = { ...AIM_DEFAULTS, ...options };
      this._aimListeners = [];
      this._stateListeners = [];
      this.reset();
    }

    reset() {
      this.state = "calibrating";
      this.refBeta = null;
      this.refGamma = null;
      this.smoothedX = 0;
      this.smoothedY = 0;
      this.calibFrames = 0;
      this.calibStartAt = 0;
      this.lastEmitAt = 0;
    }

    recalibrate() {
      this.reset();
      this._notifyState();
    }

    onAim(fn) {
      this._aimListeners.push(fn);
      return () => {
        const i = this._aimListeners.indexOf(fn);
        if (i >= 0) this._aimListeners.splice(i, 1);
      };
    }

    onStateChange(fn) {
      this._stateListeners.push(fn);
      return () => {
        const i = this._stateListeners.indexOf(fn);
        if (i >= 0) this._stateListeners.splice(i, 1);
      };
    }

    // Caller passes the latest deviceorientation values.
    // rotationRate is optional but lets us calibrate faster — pass null if
    // unavailable and we'll fall back to the timeout.
    feed({ beta, gamma, rotationRate, now }) {
      if (beta == null || gamma == null) return null;
      now = now ?? Date.now();

      if (this.state === "calibrating") {
        if (!this.calibStartAt) this.calibStartAt = now;
        const stillByRate =
          !rotationRate ||
          (Math.abs(rotationRate.alpha ?? 0) < this.opts.calibStillRateDps &&
           Math.abs(rotationRate.beta  ?? 0) < this.opts.calibStillRateDps &&
           Math.abs(rotationRate.gamma ?? 0) < this.opts.calibStillRateDps);
        if (stillByRate) {
          this.calibFrames += 1;
        } else {
          this.calibFrames = 0;
        }
        const enoughFrames = this.calibFrames >= this.opts.calibFramesRequired;
        const timedOut = (now - this.calibStartAt) >= this.opts.calibTimeoutMs;
        if (enoughFrames || timedOut) {
          this.refBeta = beta;
          this.refGamma = gamma;
          this.smoothedX = 0;
          this.smoothedY = 0;
          this.state = "aiming";
          this._notifyState();
        }
        return null;
      }

      // aiming
      const dBeta  = beta  - this.refBeta;
      const dGamma = gamma - this.refGamma;
      // Match iOS Dartline's laser-pointer feel:
      //   tilt right (top edge to user's right)  →  cursor right
      //   tilt left                              →  cursor left
      //   tilt up    (top edge toward user)      →  cursor up
      //   tilt down                              →  cursor down
      // iOS DeviceOrientation: "tilt right" from the user's POV produces
      // NEGATIVE gamma (the right SIDE of the phone tilts down, not up), so
      // we invert gamma to match natural intent. Beta is already aligned.
      const rawX = -dGamma / this.opts.sensitivityDeg;
      const rawY =  dBeta  / this.opts.sensitivityDeg;
      const s = this.opts.smoothing;
      this.smoothedX = this.smoothedX * (1 - s) + rawX * s;
      this.smoothedY = this.smoothedY * (1 - s) + rawY * s;

      const r = this.opts.maxRadius;
      const x = Math.max(-r, Math.min(r, this.smoothedX));
      const y = Math.max(-r, Math.min(r, this.smoothedY));

      if (this.opts.emitMinIntervalMs > 0 &&
          (now - this.lastEmitAt) < this.opts.emitMinIntervalMs) {
        return { x, y, ts: now, throttled: true };
      }
      this.lastEmitAt = now;
      const aim = { x, y, ts: now };
      for (const fn of this._aimListeners) {
        try { fn(aim); } catch (_) {}
      }
      return aim;
    }

    _notifyState() {
      for (const fn of this._stateListeners) {
        try { fn(this.state); } catch (_) {}
      }
    }
  }

  window.DartlineMotion = { ThrowDetector, AimTracker, DEFAULTS, AIM_DEFAULTS };
})();
