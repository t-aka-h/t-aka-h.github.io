// Dartline Display — game state machines.
// Web port of iOS Dartline's game suite. Single-player flavor only for now
// (Cut Throat keeps a 2-player Pass & Play turn-take since the format is
// inherently multi-player).
//
// Each game exposes the same interface:
//   game.start()
//   game.recordHit(score) → "throw" | "round_end" | "game_end" | "bust" |
//                          "player_change" | "ignored"
//   game.snapshot() → serializable object the display can render
//
// snapshot.gameType identifies which game it is so the display can pick
// the right HUD template:
//   "count_up" | "x01" | "cricket_count_up" | "cricket_standard" |
//   "cricket_cut_throat"

(() => {

  // ── shared constants ────────────────────────────────────────────────────

  const CRICKET_TARGETS = Object.freeze([15, 16, 17, 18, 19, 20, 25]);
  // Round → list of valid targets for Cricket Count Up.
  const CRICKET_COUNT_UP_TARGETS = Object.freeze([
    [20], [19], [18], [17], [16], [15], [25],
    [15, 16, 17, 18, 19, 20, 25],
  ]);

  // LocalStorage keys for best scores.
  const STORAGE = Object.freeze({
    count_up:            "dartline-display.bestCountUp",
    x01_301:             "dartline-display.bestX01_301",
    x01_501:             "dartline-display.bestX01_501",
    cricket_count_up:    "dartline-display.bestCricketCountUp",
    cricket_standard:    "dartline-display.bestCricketStandard",
    cricket_cut_throat:  "dartline-display.bestCricketCutThroat",
    practice:            "dartline-display.bestPractice",
  });
  function practiceBestKey(targetNumber, targetRing) {
    return `${STORAGE.practice}.${targetNumber}.${targetRing}`;
  }

  function loadBest(key) {
    try {
      const v = parseInt(window.localStorage.getItem(key) || "0", 10);
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) { return 0; }
  }
  function saveBest(key, score) {
    try { window.localStorage.setItem(key, String(score)); } catch (_) {}
  }

  // For Cricket: classify a dartboard hit into (target, marks). Returns
  // { targetNum: null, marks: 0 } when the dart landed outside any
  // Cricket-scoring region.
  function cricketMarks(score) {
    if (!score) return { targetNum: null, marks: 0 };
    if (score.ring === "double-bull") return { targetNum: 25, marks: 2 };
    if (score.ring === "outer-bull")  return { targetNum: 25, marks: 1 };
    if (CRICKET_TARGETS.includes(score.number)) {
      return { targetNum: score.number, marks: score.multiplier };
    }
    return { targetNum: null, marks: 0 };
  }

  // ── BaseGame ────────────────────────────────────────────────────────────
  class BaseGame {
    constructor() {
      this.status = "idle";
      this.round = 0;
      this.throwInRound = 0;
      this.rounds = [];
      this.lastHit = null;
      this.totalScore = 0;
      this.best = 0;
      this.gameType = "base";
    }
    start() { this.status = "playing"; this.round = 0; this.throwInRound = 0; this.rounds = [[]]; this.lastHit = null; }
    recordHit(_score) { return "ignored"; }
    snapshot() {
      return {
        gameType: this.gameType,
        status: this.status,
        round: this.round,
        throwInRound: this.throwInRound,
        throwsPerRound: 3,
        totalScore: this.totalScore,
        rounds: this.rounds,
        lastHit: this.lastHit,
        best: this.best,
      };
    }
  }

  // ── 1. Count Up ─────────────────────────────────────────────────────────
  const COUNT_UP_ROUNDS = 8;

  class CountUpGame extends BaseGame {
    constructor() {
      super();
      this.gameType = "count_up";
      this.totalRounds = COUNT_UP_ROUNDS;
      this.throwsPerRound = 3;
      this.best = loadBest(STORAGE.count_up);
    }
    start() {
      super.start();
      this.totalScore = 0;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const hit = { label: score.label, points: score.points, ring: score.ring,
                    number: score.number, multiplier: score.multiplier };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.totalScore += hit.points;
      this.throwInRound += 1;
      if (this.throwInRound >= this.throwsPerRound) {
        if (this.round + 1 >= this.totalRounds) {
          this.status = "finished";
          if (this.totalScore > this.best) {
            this.best = this.totalScore;
            saveBest(STORAGE.count_up, this.best);
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
    snapshot() {
      return { ...super.snapshot(), totalRounds: this.totalRounds };
    }
  }

  // ── 2. X01 (301 / 501) ──────────────────────────────────────────────────
  // Subtract every hit from a starting total. Reach exactly 0 to win.
  // BUST: a throw that would drop you below 0 (or to 1 in double-out) is
  // discarded and the round resets to its starting remaining.

  class X01Game extends BaseGame {
    constructor({ startingScore = 501, doubleOut = false } = {}) {
      super();
      this.gameType = "x01";
      this.startingScore = startingScore;
      this.doubleOut = doubleOut;
      this.throwsPerRound = 3;
      this.remaining = startingScore;
      this.roundStartRemaining = startingScore;
      this.totalRounds = null; // unbounded
      const key = startingScore === 301 ? STORAGE.x01_301 : STORAGE.x01_501;
      this._storageKey = key;
      // Best for X01 = fewest throws to finish; 0 means "no record yet".
      // We store as throws-to-finish.
      this.best = loadBest(key);
    }
    start() {
      super.start();
      this.remaining = this.startingScore;
      this.roundStartRemaining = this.startingScore;
      this.totalScore = 0;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const hit = { label: score.label, points: score.points, ring: score.ring,
                    number: score.number, multiplier: score.multiplier,
                    bust: false };
      const candidate = this.remaining - hit.points;
      const isDoubleFinish = (hit.multiplier === 2 || hit.ring === "double-bull");
      let bust = false;
      if (candidate < 0) bust = true;
      else if (candidate === 0 && this.doubleOut && !isDoubleFinish) bust = true;
      else if (candidate === 1 && this.doubleOut) bust = true;

      if (bust) {
        hit.bust = true;
        this.rounds[this.round].push(hit);
        this.lastHit = hit;
        // Forfeit the round: restore start-of-round remaining and advance.
        this.remaining = this.roundStartRemaining;
        this.round += 1;
        this.throwInRound = 0;
        this.rounds.push([]);
        return "bust";
      }

      this.remaining = candidate;
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.throwInRound += 1;
      this.totalScore = this.startingScore - this.remaining;

      if (this.remaining === 0) {
        this.status = "finished";
        const throwsTaken = this.round * 3 + this.throwInRound;
        // Lower is better for X01 → "best" stored as fewest throws.
        if (this.best === 0 || throwsTaken < this.best) {
          this.best = throwsTaken;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }

      if (this.throwInRound >= this.throwsPerRound) {
        this.round += 1;
        this.throwInRound = 0;
        this.roundStartRemaining = this.remaining;
        this.rounds.push([]);
        return "round_end";
      }
      return "throw";
    }
    snapshot() {
      return {
        ...super.snapshot(),
        startingScore: this.startingScore,
        doubleOut: this.doubleOut,
        remaining: this.remaining,
        roundStartRemaining: this.roundStartRemaining,
        throwsTaken: this.round * 3 + this.throwInRound,
      };
    }
  }

  // ── 3. Cricket Count Up ─────────────────────────────────────────────────
  // 8 rounds, each round has a designated target (20, 19, ..., 15, Bull, ALL).
  // Only hits ON the round's target count toward your total. T20 in round 1
  // is 60 points, S20 in round 4 is 0 points.

  class CricketCountUpGame extends BaseGame {
    constructor() {
      super();
      this.gameType = "cricket_count_up";
      this.totalRounds = CRICKET_COUNT_UP_TARGETS.length;
      this.throwsPerRound = 3;
      this.best = loadBest(STORAGE.cricket_count_up);
    }
    start() {
      super.start();
      this.totalScore = 0;
    }
    targetsForRound(roundIdx) {
      return CRICKET_COUNT_UP_TARGETS[roundIdx] || [];
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const targets = this.targetsForRound(this.round);
      const { targetNum, marks } = cricketMarks(score);
      let pointsAwarded = 0;
      let onTarget = false;
      if (targetNum != null && targets.includes(targetNum)) {
        // Bull scores 25 (or 50 for double-bull) per mark.
        const perMark = targetNum;   // works because cricketMarks normalizes bull to 25
        // For double-bull (marks=2), reward is 50, equivalent to 25*2.
        pointsAwarded = perMark * marks;
        onTarget = true;
      }
      const hit = {
        label: score.label, points: pointsAwarded, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        onTarget, targetNum,
      };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.totalScore += pointsAwarded;
      this.throwInRound += 1;
      if (this.throwInRound >= this.throwsPerRound) {
        if (this.round + 1 >= this.totalRounds) {
          this.status = "finished";
          if (this.totalScore > this.best) {
            this.best = this.totalScore;
            saveBest(STORAGE.cricket_count_up, this.best);
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
    snapshot() {
      return {
        ...super.snapshot(),
        totalRounds: this.totalRounds,
        currentTargets: this.targetsForRound(this.round),
      };
    }
  }

  // ── 4. Cricket Standard (single-player adaptation) ──────────────────────
  // Close all 7 targets (15-20, Bull) with 3 marks each. Hits past 3 on an
  // already-closed target add the dart's number to your point total. Round
  // ends after 3 throws. Game ends when ALL targets are closed.

  class CricketStandardGame extends BaseGame {
    constructor() {
      super();
      this.gameType = "cricket_standard";
      this.throwsPerRound = 3;
      this.targets = CRICKET_TARGETS.slice();
      this.marks = {};
      this.points = 0;
      this.best = loadBest(STORAGE.cricket_standard);  // best = highest points after closing all
    }
    start() {
      super.start();
      this.marks = {};
      this.targets.forEach((t) => { this.marks[t] = 0; });
      this.points = 0;
      this.totalScore = 0;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const { targetNum, marks } = cricketMarks(score);
      let marksAdded = 0;
      let pointsAdded = 0;
      if (targetNum != null) {
        const current = this.marks[targetNum];
        if (current < 3) {
          const closing = Math.min(marks, 3 - current);
          const overflow = marks - closing;
          this.marks[targetNum] = current + closing;
          marksAdded = closing;
          if (overflow > 0) {
            pointsAdded = overflow * targetNum;
            this.points += pointsAdded;
          }
        } else {
          // Target already closed → all marks score points.
          pointsAdded = marks * targetNum;
          this.points += pointsAdded;
        }
      }
      const hit = {
        label: score.label, points: pointsAdded, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        targetNum, marksAdded,
      };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.totalScore = this.points;
      this.throwInRound += 1;

      const allClosed = this.targets.every((t) => this.marks[t] >= 3);
      if (allClosed) {
        this.status = "finished";
        if (this.points > this.best) {
          this.best = this.points;
          saveBest(STORAGE.cricket_standard, this.best);
        }
        return "game_end";
      }
      if (this.throwInRound >= this.throwsPerRound) {
        this.round += 1;
        this.throwInRound = 0;
        this.rounds.push([]);
        return "round_end";
      }
      return "throw";
    }
    snapshot() {
      return {
        ...super.snapshot(),
        marks: { ...this.marks },
        points: this.points,
        targets: this.targets.slice(),
      };
    }
  }

  // ── 5. Cricket Cut Throat (2-player Pass & Play) ────────────────────────
  // Same target / mark structure as Standard, but points from over-marks on
  // a closed target go to the OPPOSITE player. Lowest total points wins
  // once all of one player's targets are closed.

  class CricketCutThroatGame extends BaseGame {
    constructor() {
      super();
      this.gameType = "cricket_cut_throat";
      this.throwsPerRound = 3;
      this.targets = CRICKET_TARGETS.slice();
      this.players = [
        { name: "P1", marks: {}, points: 0 },
        { name: "P2", marks: {}, points: 0 },
      ];
      this.currentPlayer = 0;
      this.best = loadBest(STORAGE.cricket_cut_throat);  // best = lowest losing-player points
    }
    start() {
      super.start();
      this.players.forEach((p) => {
        p.marks = {};
        this.targets.forEach((t) => { p.marks[t] = 0; });
        p.points = 0;
      });
      this.currentPlayer = 0;
      this.totalScore = 0;
    }
    _otherPlayer() { return this.currentPlayer === 0 ? 1 : 0; }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me    = this.players[this.currentPlayer];
      const other = this.players[this._otherPlayer()];
      const { targetNum, marks } = cricketMarks(score);
      let marksAdded = 0;
      let pointsAddedToOpponent = 0;
      if (targetNum != null) {
        const current = me.marks[targetNum];
        if (current < 3) {
          const closing = Math.min(marks, 3 - current);
          const overflow = marks - closing;
          me.marks[targetNum] = current + closing;
          marksAdded = closing;
          // In Cut Throat, overflow points only go to opponent if the
          // OPPONENT hasn't closed that target yet — closed-on-both means
          // no scoring at all.
          if (overflow > 0 && other.marks[targetNum] < 3) {
            pointsAddedToOpponent = overflow * targetNum;
            other.points += pointsAddedToOpponent;
          }
        } else {
          // Already closed by me — score points TO opponent if they haven't
          // also closed it.
          if (other.marks[targetNum] < 3) {
            pointsAddedToOpponent = marks * targetNum;
            other.points += pointsAddedToOpponent;
          }
        }
      }
      const hit = {
        label: score.label, points: pointsAddedToOpponent, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        targetNum, marksAdded, pointedAtPlayer: other.name,
      };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.throwInRound += 1;

      const meClosedAll = this.targets.every((t) => me.marks[t] >= 3);
      if (meClosedAll) {
        // I closed all targets — game ends. The player with FEWEST points
        // wins (this is Cut Throat).
        this.status = "finished";
        const myPts    = me.points;
        const otherPts = other.points;
        const winner = myPts <= otherPts ? me : other;
        this.totalScore = winner.points;
        // Store lowest losing-player points → "best" defends a clean game.
        if (this.best === 0 || winner.points < this.best) {
          this.best = winner.points;
          saveBest(STORAGE.cricket_cut_throat, this.best);
        }
        return "game_end";
      }
      if (this.throwInRound >= this.throwsPerRound) {
        // End of turn — swap player and start a new round shell.
        this.currentPlayer = this._otherPlayer();
        this.round += 1;
        this.throwInRound = 0;
        this.rounds.push([]);
        return "player_change";
      }
      return "throw";
    }
    snapshot() {
      return {
        ...super.snapshot(),
        targets: this.targets.slice(),
        players: this.players.map((p) => ({
          name: p.name,
          marks: { ...p.marks },
          points: p.points,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 6. Practice (single-target, 30 throws) ──────────────────────────────
  // Pick a target number (15-20 or 25 = Bull) and ring constraint
  // ("any" / "single" / "double" / "triple") and try to land 30 darts on
  // it. Tracks hits, current streak, longest streak, hit rate.

  class PracticeGame extends BaseGame {
    constructor({ targetNumber = 20, targetRing = "any" } = {}) {
      super();
      this.gameType = "practice";
      this.targetNumber = targetNumber;
      this.targetRing = targetRing;
      this.maxThrows = 30;
      this.throwsPerRound = 3;
      this.totalRounds = this.maxThrows / this.throwsPerRound;
      this.hits = 0;
      this.streak = 0;
      this.longestStreak = 0;
      this._storageKey = practiceBestKey(targetNumber, targetRing);
      this.best = loadBest(this._storageKey);
    }
    start() {
      super.start();
      this.hits = 0;
      this.streak = 0;
      this.longestStreak = 0;
      this.totalScore = 0;
    }
    isOnTarget(score) {
      if (this.targetNumber === 25) {
        // Both outer and double bull count as the bull target.
        return score.ring === "outer-bull" || score.ring === "double-bull";
      }
      if (score.number !== this.targetNumber) return false;
      if (this.targetRing === "any")    return true;
      if (this.targetRing === "single") return score.ring === "single";
      if (this.targetRing === "double") return score.ring === "double";
      if (this.targetRing === "triple") return score.ring === "triple";
      return false;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const onTarget = this.isOnTarget(score);
      if (onTarget) {
        this.hits += 1;
        this.streak += 1;
        if (this.streak > this.longestStreak) this.longestStreak = this.streak;
      } else {
        this.streak = 0;
      }
      const hit = {
        label: score.label, points: onTarget ? score.points : 0,
        ring: score.ring, number: score.number, multiplier: score.multiplier,
        onTarget,
      };
      this.rounds[this.round].push(hit);
      this.lastHit = hit;
      this.totalScore = this.hits;
      this.throwInRound += 1;

      const totalThrows = this.round * this.throwsPerRound + this.throwInRound;
      if (totalThrows >= this.maxThrows) {
        this.status = "finished";
        if (this.hits > this.best) {
          this.best = this.hits;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      if (this.throwInRound >= this.throwsPerRound) {
        this.round += 1;
        this.throwInRound = 0;
        this.rounds.push([]);
        return "round_end";
      }
      return "throw";
    }
    snapshot() {
      const totalThrows = this.round * this.throwsPerRound + this.throwInRound;
      return {
        ...super.snapshot(),
        targetNumber: this.targetNumber,
        targetRing:   this.targetRing,
        maxThrows:    this.maxThrows,
        totalRounds:  this.totalRounds,
        hits:         this.hits,
        streak:       this.streak,
        longestStreak:this.longestStreak,
        throwsTaken:  totalThrows,
        hitRate:      totalThrows > 0 ? this.hits / totalThrows : 0,
      };
    }
  }

  // ── Factory + registry ──────────────────────────────────────────────────
  function makeGame(mode, options) {
    switch (mode) {
      case "x01_301":            return new X01Game({ startingScore: 301, doubleOut: false });
      case "x01_501":            return new X01Game({ startingScore: 501, doubleOut: false });
      case "x01_501_do":         return new X01Game({ startingScore: 501, doubleOut: true });
      case "cricket_count_up":   return new CricketCountUpGame();
      case "cricket_standard":   return new CricketStandardGame();
      case "cricket_cut_throat": return new CricketCutThroatGame();
      case "practice":           return new PracticeGame(options || {});
      case "count_up":
      default:                   return new CountUpGame();
    }
  }

  // Display metadata for the mode-select UI.
  const MODE_LIST = Object.freeze([
    { id: "count_up",            name: "Count Up",         hint: "8 rounds, sum the points" },
    { id: "x01_301",             name: "301",              hint: "Reach 0 from 301" },
    { id: "x01_501",             name: "501",              hint: "Reach 0 from 501" },
    { id: "cricket_count_up",    name: "Cricket Count Up", hint: "20→19→…→Bull→ALL" },
    { id: "cricket_standard",    name: "Cricket Standard", hint: "Close 15-20 + Bull, score on closed" },
    { id: "cricket_cut_throat",  name: "Cut Throat",       hint: "2-player, low score wins" },
    { id: "practice",            name: "Practice",         hint: "Pick a target, 30 throws" },
  ]);

  window.DartlineGame = {
    CountUpGame, X01Game, CricketCountUpGame, CricketStandardGame, CricketCutThroatGame,
    PracticeGame,
    makeGame, MODE_LIST, CRICKET_TARGETS, CRICKET_COUNT_UP_TARGETS,
  };
})();
