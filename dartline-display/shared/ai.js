// Dartline Display — COM AI player.
// Generates simulated throws for matches where one or more "players" is
// computer-controlled. Web port of iOS Dartline's COMAI (Day 2).
//
// Three difficulty tiers:
//   easy    — wild scatter, frequently misses entirely
//   normal  — moderate accuracy, average human-ish bullseye rate
//   hard    — tight scatter, can string together triples
//
// The AI's output is consumed by the controller as if it were a real
// throw — same (x, y, force) shape — so the existing scoring and audio
// paths handle COM throws without special-casing.

(() => {
  const DIFFICULTY = Object.freeze({
    easy: {
      // Standard-deviation of the landing scatter (normalized 0..1 board).
      scatter: 0.22,
      // Chance the COM picks "miss the board entirely".
      missRate: 0.10,
      // Spread of the simulated force (around its ideal 0.55).
      forceSigma: 0.18,
      // Aim adjustment toward target's center vs. spraying — higher = better aim.
      targetWeight: 0.85,
    },
    normal: {
      scatter: 0.13,
      missRate: 0.04,
      forceSigma: 0.10,
      targetWeight: 0.92,
    },
    hard: {
      scatter: 0.07,
      missRate: 0.01,
      forceSigma: 0.06,
      targetWeight: 0.97,
    },
  });

  // Pseudo-gaussian via two uniform samples (Box-Muller's polar form);
  // good enough for arcade scatter and avoids a heavy stats library.
  function gauss(sigma) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const mag = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return mag * sigma;
  }

  // For a "number" target on the dartboard, return the canonical (x, y) at
  // the center of the segment, mid-radius (single-ring sweet spot).
  function targetCenter(number, ring) {
    if (number === 25) return { x: 0, y: 0 };  // bull center
    const SEGS = window.DartlineDartboard.SEGMENT_NUMBERS;
    const idx = SEGS.indexOf(number);
    if (idx < 0) return { x: 0, y: 0 };
    const centerDeg = idx * 18;
    // Pick radius based on ring: triple band centered on ~0.63, double on
    // ~0.97, single on ~0.45. Default to a comfortable single.
    let r = 0.45;
    if (ring === "triple") r = 0.63;
    else if (ring === "double") r = 0.97;
    const rad = (centerDeg - 90) * Math.PI / 180;
    return { x: Math.cos(rad) * r, y: -Math.sin(rad) * r };
  }

  // Decide what the COM is shooting for given the current game snapshot.
  // For Count Up / X01 / Practice this is just T20 (or the practice target).
  // Cricket variants prefer the highest open target.
  function pickTarget(snap) {
    if (!snap) return { number: 20, ring: "triple" };
    switch (snap.gameType) {
      case "x01": {
        // If remaining is small enough, aim for the finishing combination.
        const rem = snap.remaining || 0;
        if (rem <= 50 && rem > 0) {
          if (rem === 50) return { number: 25, ring: "double" }; // double bull
          if (rem % 2 === 0 && rem / 2 <= 20) return { number: rem / 2, ring: "double" };
          if (rem <= 20) return { number: rem, ring: "single" };
        }
        return { number: 20, ring: "triple" };
      }
      case "cricket_count_up": {
        const t = (snap.currentTargets || [])[0];
        if (t == null) return { number: 20, ring: "triple" };
        return { number: t, ring: t === 25 ? "double" : "triple" };
      }
      case "cricket_standard":
      case "cricket_cut_throat": {
        const marks = snap.marks || (snap.players && snap.players[1].marks) || {};
        const tgts = (snap.targets || [20, 19, 18, 17, 16, 15, 25]);
        // Pick the highest-value target that hasn't been closed yet.
        const open = tgts.filter((t) => (marks[t] || 0) < 3);
        const pick = open[0] || 20;
        return { number: pick, ring: pick === 25 ? "double" : "triple" };
      }
      case "practice": {
        return { number: snap.targetNumber, ring: snap.targetRing === "any" ? "triple" : snap.targetRing };
      }
      case "count_up":
      default:
        return { number: 20, ring: "triple" };
    }
  }

  class COMAI {
    constructor(difficulty = "normal") {
      this.difficulty = (difficulty in DIFFICULTY) ? difficulty : "normal";
      this.params = DIFFICULTY[this.difficulty];
    }

    // Returns { x, y, force, peak } shaped just like a ThrowDetector event
    // + ThrowResolver landing. The controller funnels this through the
    // same scoring path used for human throws.
    plan(snap) {
      const target = pickTarget(snap);
      const aim = targetCenter(target.number, target.ring);
      const p = this.params;

      // Catastrophic miss roll — sprays well outside the board.
      if (Math.random() < p.missRate) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 1.05 + Math.random() * 0.20;
        return {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          force: 0.10 + Math.random() * 0.30,
          peak: 12,
          target,
        };
      }

      // Normal throw — drift toward aim with gaussian scatter.
      const w = p.targetWeight;
      const cx = aim.x * w + (Math.random() * 2 - 1) * 0.05 * (1 - w);
      const cy = aim.y * w + (Math.random() * 2 - 1) * 0.05 * (1 - w);
      const landing = {
        x: cx + gauss(p.scatter),
        y: cy + gauss(p.scatter),
      };
      // Force centered on the ideal release (0.55).
      const force = Math.max(0.05, Math.min(0.98, 0.55 + gauss(p.forceSigma)));
      return { x: landing.x, y: landing.y, force, peak: 18 + force * 25, target };
    }
  }

  window.DartlineAI = { COMAI, DIFFICULTY, pickTarget, targetCenter };
})();
