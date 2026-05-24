// Dartline Display — Web Audio synth.
// Port of iOS Dartline SoundSynth.swift (Day 1.11 / 1.13 / 1.14).
//
// All sounds are synthesized live from oscillators + noise buffers, no audio
// files. Each effect is a 3-layer stack:
//   1. Noise crack (band-limited white noise) — the "ZKYUN" head transient
//   2. Exponential frequency sweep — the body of the snap
//   3. Chord / harmonic stack — the tonal tail
//
// Missing-fundamental technique: small speakers (iPhone, glasses) can't
// reproduce sub-200 Hz tones, so we add harmonics 2F..5F at small amplitudes;
// the auditory system reconstructs the perceived F as "ズーン感" bass.
//
// AudioContext must be unlocked by a user gesture (browser policy). The
// caller should call ensureContext() from a click / touch handler before
// trying to play.

(() => {
  class SoundSynth {
    constructor() {
      this._ctx = null;
      this._master = null;
      this.muted = false;
      // Bumped from 0.85 → 1.10. iPhone speakers + Web Audio default gain
      // through the system mixer have been quiet in practice.
      this.masterGain = 1.10;
    }

    // Lazily create the context. MUST be called from a user gesture for the
    // first invocation, otherwise iOS Safari keeps it suspended.
    ensureContext() {
      if (this._ctx) {
        if (this._ctx.state === "suspended") {
          this._ctx.resume().catch(() => {});
        }
        return this._ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this._ctx = new AC({ latencyHint: "interactive" });
      const master = this._ctx.createGain();
      master.gain.value = this.masterGain;
      master.connect(this._ctx.destination);
      this._master = master;
      // iOS Safari quirk: even with resume(), the audio output stream stays
      // dormant until something plays. Kick it off with an inaudible buffer
      // so the first real SE doesn't get clipped.
      try {
        const sr = this._ctx.sampleRate;
        const buf = this._ctx.createBuffer(1, 1, sr);
        const src = this._ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this._ctx.destination);
        src.start(0);
      } catch (_) {}
      if (this._ctx.state === "suspended") {
        this._ctx.resume().catch(() => {});
      }
      return this._ctx;
    }

    setMuted(m) { this.muted = !!m; }

    // ── primitives ────────────────────────────────────────────────────────

    _now() { return this._ctx ? this._ctx.currentTime : 0; }

    _noise(startSec, duration, gain, lpfHz) {
      const ctx = this._ctx; if (!ctx) return;
      const sr = ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * duration));
      const buf = ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const lpf = ctx.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = lpfHz;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, startSec);
      env.gain.linearRampToValueAtTime(gain, startSec + 0.004);
      env.gain.exponentialRampToValueAtTime(0.001, startSec + duration);
      src.connect(lpf).connect(env).connect(this._master);
      src.start(startSec);
      src.stop(startSec + duration + 0.02);
    }

    _sweep(startSec, duration, fromHz, toHz, gain) {
      const ctx = this._ctx; if (!ctx) return;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const safeTo = Math.max(20, toHz);
      osc.frequency.setValueAtTime(fromHz, startSec);
      osc.frequency.exponentialRampToValueAtTime(safeTo, startSec + duration);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, startSec);
      env.gain.linearRampToValueAtTime(gain, startSec + 0.008);
      env.gain.exponentialRampToValueAtTime(0.001, startSec + duration);
      osc.connect(env).connect(this._master);
      osc.start(startSec);
      osc.stop(startSec + duration + 0.02);
    }

    _tone(startSec, duration, freqHz, gain, type = "sine") {
      const ctx = this._ctx; if (!ctx) return;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freqHz;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, startSec);
      env.gain.linearRampToValueAtTime(gain, startSec + 0.006);
      env.gain.exponentialRampToValueAtTime(0.001, startSec + duration);
      osc.connect(env).connect(this._master);
      osc.start(startSec);
      osc.stop(startSec + duration + 0.02);
    }

    _missingFundamental(startSec, duration, baseHz, baseGain) {
      // Add harmonics 2F..5F at small amplitudes to suggest F via the
      // auditory system's harmonic-template matching.
      for (let h = 2; h <= 5; h++) {
        this._tone(startSec, duration, baseHz * h, baseGain * 0.85 / h, "sine");
      }
    }

    // ── sound effects ─────────────────────────────────────────────────────

    playRegular() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._noise(t, 0.050, 0.42, 5500);
      this._sweep(t + 0.005, 0.100, 1500, 750, 0.35);
      this._tone (t + 0.010, 0.280,  880, 0.18);
      this._tone (t + 0.010, 0.280, 1320, 0.14);
      this._tone (t + 0.010, 0.280, 1760, 0.10);
    }

    playOuterBull() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._noise(t, 0.070, 0.55, 6500);
      this._sweep(t + 0.008, 0.150, 2800, 340, 0.45);
      [659, 880, 988, 1318, 1976].forEach((f) =>
        this._tone(t + 0.020, 0.350, f, 0.12));
    }

    playRing() {
      // For Double / Triple multipliers (except T20 which is treated as Perfect).
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._noise(t, 0.080, 0.60, 7500);
      this._sweep(t + 0.008, 0.180, 3500, 260, 0.50);
      [523, 659, 784, 1047, 1318, 1568].forEach((f) =>
        this._tone(t + 0.025, 0.380, f, 0.10));
      this._tone(t + 0.060, 0.700, 1760, 0.08);
    }

    playBull() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._noise(t, 0.100, 0.62, 8000);
      this._sweep(t + 0.010, 0.250, 4500, 200, 0.55);
      [55, 110, 220, 440, 880, 1318, 1760, 2200, 2637].forEach((f) =>
        this._tone(t + 0.030, 0.450, f, 0.10));
      this._tone(t + 0.060, 0.900, 1760, 0.10);
      this._tone(t + 0.200, 1.100, 2640, 0.08);
      this._missingFundamental(t + 0.020, 0.500, 80, 0.18);
    }

    playPerfect() {
      // Used for double bull and T20-class triples.
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._noise(t, 0.120, 0.65, 9000);
      this._sweep(t + 0.010, 0.300, 5000, 180, 0.60);
      // Ascending arpeggio
      [523, 659, 784, 1047].forEach((f, i) =>
        this._tone(t + 0.040 + i * 0.040, 0.250, f, 0.18, "triangle"));
      // 9-note finale chord
      [523, 659, 784, 988, 1175, 1397, 1568, 1865, 2093].forEach((f) =>
        this._tone(t + 0.200, 0.600, f, 0.08));
      this._tone(t + 0.100, 1.200, 2093, 0.12);
      this._tone(t + 0.300, 1.500, 3136, 0.10);
      this._missingFundamental(t + 0.020, 0.600, 70, 0.20);
    }

    playMiss() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._sweep(t, 0.350, 220, 110, 0.35);
      this._noise(t, 0.080, 0.15, 1500);
    }

    playAimLock() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._tone(t,         0.080, 1480, 0.25);
      this._tone(t + 0.020, 0.060, 1976, 0.22);
    }

    playThrowSnap() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._sweep(t,        0.080, 900, 240, 0.30);
      this._noise(t,        0.020, 0.25, 4000);
    }

    playAimEnter() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._sweep(t, 0.150, 440, 660, 0.25);
    }

    // Convenience: pick the right SE for a scoring result.
    playForScore(score) {
      if (!score) return;
      if (score.ring === "double-bull") return this.playPerfect();
      if (score.ring === "outer-bull")  return this.playOuterBull();
      if (score.ring === "miss")        return this.playMiss();
      // T20 (60), T19 (57), T18 (54) class — escalate to Perfect.
      if (score.multiplier === 3 && score.points >= 51) return this.playPerfect();
      if (score.multiplier === 3 || score.multiplier === 2) return this.playRing();
      return this.playRegular();
    }
  }

  window.DartlineSound = { SoundSynth };
})();
