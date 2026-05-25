// Dartline Display — haptics wrapper around the Web Vibration API.
//
// Real talk:
//   - iOS Safari ignores navigator.vibrate() — Apple has never shipped it.
//     None of these calls will produce haptic feedback on iPhone today.
//   - Android Chrome + Firefox honor it.
//   - Meta Ray-Ban Display Web Apps may or may not (Meta hasn't documented).
//
// Why call it anyway?
//   - The day iOS ships Web Haptics (or Meta wires their device API into
//     navigator.vibrate), these calls light up with zero code changes.
//   - Even on iOS today, the heavy-bass audio synth ends up driving the
//     speaker membrane hard enough that the user's grip transmits some
//     low-frequency mechanical feedback. The audio IS half the haptics on
//     iOS Safari.

(() => {
  function _vib(pattern) {
    if (typeof navigator === "undefined" || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (_) {}
  }

  const Haptics = {
    // Quick "tick" on small actions (button focus, calibration step).
    tick()  { _vib(10); },
    // "Click" — confirmation events like LOCK.
    click() { _vib([12, 18, 22]); },
    // Throw release — sharp snap with a tail.
    throw_() { _vib([10, 40, 24]); },
    // Hit feedback scales with intensity 0..1.
    //   miss        ~25 ms
    //   single      ~35 ms
    //   ring        ~50 ms
    //   bull        ~70 ms with double pulse
    //   perfect    pattern with celebratory ramp
    hit(ring) {
      switch (ring) {
        case "miss":        return _vib(18);
        case "outer-bull":  return _vib([30, 25, 20]);
        case "double":
        case "triple":      return _vib([40, 20, 50]);
        case "double-bull": return _vib([60, 30, 70]);
        default:            return _vib(28);
      }
    },
    perfect() { _vib([50, 40, 70, 40, 90, 40, 110]); },
    // Game flow.
    gameStart() { _vib([15, 60, 15]); },
    gameOver()  { _vib([80, 40, 80, 40, 80]); },
  };

  window.DartlineHaptics = Haptics;
})();
