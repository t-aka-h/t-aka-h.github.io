// Dartline Display — Count Up game state machine.
// Port of iOS Dartline's Count Up mode: 8 rounds × 3 throws = 24 darts,
// final score = sum of all hits. Bull = 50, outer bull = 25, double/triple
// multipliers apply.
//
// The controller owns this state and broadcasts updates to the display via
// "game_state" messages. The display renders the HUD; it does not mutate
// state.

(() => {
  const TOTAL_ROUNDS = 8;
  const THROWS_PER_ROUND = 3;
  const STORAGE_KEY = "dartline-display.bestCountUp";

  function loadBest() {
    try {
      const v = parseInt(window.localStorage.getItem(STORAGE_KEY) || "0", 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) {
      return 0;
    }
  }
  function saveBest(score) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(score));
    } catch (_) {}
  }

  class CountUpGame {
    constructor() {
      this.totalRounds = TOTAL_ROUNDS;
      this.throwsPerRound = THROWS_PER_ROUND;
      this.best = loadBest();
      this.reset();
    }

    reset() {
      // status: "idle" (not started yet) | "playing" | "finished"
      this.status = "idle";
      this.round = 0;          // 0-indexed; round 1 shown to user.
      this.throwInRound = 0;   // 0-indexed within the current round.
      this.totalScore = 0;
      this.rounds = [];        // rounds[r] = [hit, hit, hit] of { label, points }
      this.lastHit = null;     // most recent { label, points }
    }

    start() {
      this.reset();
      this.status = "playing";
      this.rounds.push([]);
    }

    // Record a hit's scoring result. Returns one of:
    //   "throw"       — recorded, still in this round
    //   "round_end"   — recorded, round just completed (more rounds remain)
    //   "game_end"    — recorded, game just completed
    //   "ignored"     — recorded only if status === "playing"
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const hit = {
        label: score.label,
        points: score.points,
        ring: score.ring,
        number: score.number,
        multiplier: score.multiplier,
      };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.totalScore += hit.points;
      this.throwInRound += 1;
      if (this.throwInRound >= this.throwsPerRound) {
        // Round complete.
        if (this.round + 1 >= this.totalRounds) {
          this.status = "finished";
          if (this.totalScore > this.best) {
            this.best = this.totalScore;
            saveBest(this.best);
          }
          return "game_end";
        }
        this.round += 1;
        this.throwInRound = 0;
        this.rounds.push([]);
        return "round_end";
      }
      return "throw";
    }

    // Serializable snapshot for sending over the wire.
    snapshot() {
      return {
        status:        this.status,
        round:         this.round,
        throwInRound:  this.throwInRound,
        totalRounds:   this.totalRounds,
        throwsPerRound: this.throwsPerRound,
        totalScore:    this.totalScore,
        rounds:        this.rounds,
        lastHit:       this.lastHit,
        best:          this.best,
      };
    }

    // Public helpers
    get throwsRemainingThisRound() {
      return Math.max(0, this.throwsPerRound - this.throwInRound);
    }
    get totalThrows() {
      return this.totalRounds * this.throwsPerRound;
    }
    get throwsTaken() {
      return this.round * this.throwsPerRound + this.throwInRound;
    }
  }

  window.DartlineGame = { CountUpGame, TOTAL_ROUNDS, THROWS_PER_ROUND };
})();
