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
      this._unlocked = false;
      this._silentAudio = null;
      this.muted = false;
      // Bumped to 1.85 — small phone / glass speakers, plus the
      // missing-fundamental bass tricks below, want extra headroom.
      this.masterGain = 1.85;
    }

    isRunning() {
      return !!(this._ctx && this._ctx.state === "running");
    }
    contextState() {
      return this._ctx ? this._ctx.state : "none";
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
      // Low-shelf bass boost: +7 dB below 260 Hz. On small phone / glass
      // speakers the high-mids dominate naturally, so a shelf compensates
      // and lets the missing-fundamental tricks read as actual bass.
      const lowShelf = this._ctx.createBiquadFilter();
      lowShelf.type = "lowshelf";
      lowShelf.frequency.value = 260;
      lowShelf.gain.value = 7;
      // Dynamics compressor — tames peaks and raises the average loudness
      // so the bass sits inside a denser mix instead of clipping.
      const comp = this._ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 22;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;
      // Chain: master gain → low-shelf → compressor → destination
      master.connect(lowShelf).connect(comp).connect(this._ctx.destination);
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

    // Full unlock — needs to be called from a user gesture. Combines:
    //   1. An <audio> element with a tiny silent data URL, played
    //      synchronously. This wakes the iOS audio pipeline even if the
    //      ringer is on but the device hasn't routed audio output yet.
    //   2. ensureContext() — creates the WebAudio context and plays a
    //      one-sample silent buffer.
    //   3. Awaits ctx.resume() if it returned a promise. Returns true on
    //      "running", false otherwise.
    async unlock() {
      // 1. <audio> element bridge.
      if (!this._silentAudio) {
        try {
          const a = document.createElement("audio");
          // 0.05s of silence as base64 mp3 (works on iOS Safari 14+).
          a.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//FJAhCQEQAGsgIcEbcyCEgaRR8sl0EBFNw3RxQuvHc2bj5Vja3JM45VvNqxhSIyo4z4iEm+JfTW80wIxBLY3yT/M2QmwOmEhO6Cqe///VkIQRYJgYZsHi5MgL61SJBQUFGZ3iX4Ah0vxK6dDuTjVl1NgRSv4ZJ7CIRyfWFNgxlEY/V8M6/9p7Tq//9z7DyQF/ATEAlUYAW/A5GUgZkVOH8FjQNB1XRgT6sb6Z/91pBA5KMz+nADzS6q1hjlS6gj+nLBuY83KZTI7CPS6Wj1Ck6OVlEW/HZuoO1iZQ8DkU0sLB6Z+kY/AGsOyOzMVL+oNbpwk4tKMmIyNzkMjuhCMmCgN2pSZsLBwYRy04EnHsBgrnHIN7ttUVf4WLnW6QzNFFvHhz/4u4tJZ1B7Pr/4nXjzodGzqFqMnLWxnDIcPbeJyKlmwTKAxIzZ3wA/wjjEpA1jLFK1zEMyVc7H80AAQAAFTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";
          a.loop = false;
          a.preload = "auto";
          a.volume = 0.01;
          a.setAttribute("playsinline", "");
          this._silentAudio = a;
          // Try to play; failure is non-fatal.
          const p = a.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch (_) {}
      }

      // 2. AudioContext.
      const ctx = this.ensureContext();
      if (!ctx) return false;

      // 3. Await resume.
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch (_) {}
      }
      this._unlocked = ctx.state === "running";
      return this._unlocked;
    }

    isUnlocked() {
      return this._unlocked && this.isRunning();
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
      // Add harmonics 2F..7F at substantial amplitudes to suggest F via the
      // auditory system's harmonic-template matching. Lower harmonics
      // (which the speaker CAN reproduce) get more weight than the 1/h
      // default — that makes the perceived bass much heavier on tiny
      // speakers that can't render the actual fundamental at all.
      const weights = { 2: 1.00, 3: 0.85, 4: 0.55, 5: 0.40, 6: 0.28, 7: 0.20 };
      for (let h = 2; h <= 7; h++) {
        this._tone(startSec, duration, baseHz * h, baseGain * weights[h], "sine");
      }
    }

    // Dart-hitting-board impact. Four layers, all triggered simultaneously
    // to read as a single THUNK:
    //   1. High-mid noise crack — the "TICK" of the steel tip piercing the
    //      sisal/cork. Sharp attack, brief tail.
    //   2. Body sweep — a 280→55 Hz drop, the "thump" of the board.
    //   3. Missing-fundamental sub-bass (≈45 Hz F0) — uses harmonics
    //      2F..7F so the brain reconstructs a real subwoofer-style boom
    //      from a phone speaker that can't physically reproduce 45 Hz.
    //   4. Low-mid square-wave tone (~140 Hz) for the gut-punch body that
    //      bridges the perceptible range and the missing fundamental.
    _impact(startSec, intensity = 1.0) {
      const i = Math.max(0.4, Math.min(1.2, intensity));
      // 1. Noise crack
      const noiseDur  = 0.040 + 0.045 * i;
      const noiseGain = 0.50 * i;
      const noiseLpf  = 3500 + 4000 * i;
      this._noise(startSec, noiseDur, noiseGain, noiseLpf);
      // 2. Body sweep — much louder and reaches lower than before.
      this._sweep(startSec, 0.110 + 0.040 * i, 280, 55, 0.65 * i);
      // 3. Missing-fundamental sub-bass
      this._missingFundamental(startSec, 0.220 + 0.080 * i, 45, 0.32 * i);
      // 4. Body tone — square wave for richer harmonics in the perceptible
      //    bass range.
      this._tone(startSec, 0.180 + 0.040 * i, 140, 0.28 * i, "square");
      this._tone(startSec, 0.180 + 0.040 * i,  90, 0.22 * i, "triangle");
    }

    // ── sound effects ─────────────────────────────────────────────────────

    // All score plays follow the same arc:
    //   t          → impact (THUNK + low thud)
    //   t + 0.085  → chime (sweep + chord) so the impact is heard distinctly
    // The chime delay is short enough not to feel laggy but long enough that
    // the impact reads as a separate event ("dart sticks, machine chirps").

    playRegular() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._impact(t, 0.7);
      const c = t + 0.085;
      this._sweep(c, 0.100, 1500, 750, 0.35);
      this._tone (c + 0.005, 0.280,  880, 0.18);
      this._tone (c + 0.005, 0.280, 1320, 0.14);
      this._tone (c + 0.005, 0.280, 1760, 0.10);
    }

    playOuterBull() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._impact(t, 0.85);
      const c = t + 0.085;
      this._sweep(c, 0.150, 2800, 340, 0.45);
      [659, 880, 988, 1318, 1976].forEach((f) =>
        this._tone(c + 0.012, 0.350, f, 0.12));
    }

    playRing() {
      // For Double / Triple multipliers (except T20 which is treated as Perfect).
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._impact(t, 0.95);
      const c = t + 0.090;
      this._sweep(c, 0.180, 3500, 260, 0.50);
      [523, 659, 784, 1047, 1318, 1568].forEach((f) =>
        this._tone(c + 0.015, 0.380, f, 0.10));
      this._tone(c + 0.050, 0.700, 1760, 0.08);
    }

    playBull() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._impact(t, 1.0);
      const c = t + 0.090;
      this._sweep(c, 0.250, 4500, 200, 0.55);
      [55, 110, 220, 440, 880, 1318, 1760, 2200, 2637].forEach((f) =>
        this._tone(c + 0.020, 0.450, f, 0.10));
      this._tone(c + 0.050, 0.900, 1760, 0.10);
      this._tone(c + 0.190, 1.100, 2640, 0.08);
      this._missingFundamental(c + 0.010, 0.500, 80, 0.18);
    }

    playPerfect() {
      // Used for double bull and T20-class triples.
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      this._impact(t, 1.1);
      const c = t + 0.100;
      this._sweep(c, 0.300, 5000, 180, 0.60);
      // Ascending arpeggio
      [523, 659, 784, 1047].forEach((f, i) =>
        this._tone(c + 0.030 + i * 0.040, 0.250, f, 0.18, "triangle"));
      // 9-note finale chord
      [523, 659, 784, 988, 1175, 1397, 1568, 1865, 2093].forEach((f) =>
        this._tone(c + 0.190, 0.600, f, 0.08));
      this._tone(c + 0.090, 1.200, 2093, 0.12);
      this._tone(c + 0.290, 1.500, 3136, 0.10);
      this._missingFundamental(c + 0.010, 0.600, 70, 0.20);
    }

    playMiss() {
      if (this.muted || !this.ensureContext()) return;
      const t = this._now();
      // A miss still hits SOMETHING (wall / floor / spider wire) — give it
      // a soft impact so it doesn't feel like the throw vanished.
      this._impact(t, 0.45);
      this._sweep(t + 0.060, 0.350, 220, 110, 0.32);
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
