// Dartline Display — game state machines.
// Web port of iOS Dartline's game suite. Every game (except solo-only
// Practice) optionally supports a COM opponent by passing
// { comDifficulty: "easy" | "normal" | "hard" } to the constructor.
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
//   "cricket_cut_throat" | "practice"
//
// Multi-player snapshot conventions:
//   - snap.players: [{ name, type, ... }, ...] — always present, length
//     1 for solo, 2 for vs COM, more for Pass & Play.
//   - snap.currentPlayer: index into players[].
//   - Top-level fields (totalScore, remaining, marks, points, round,
//     throwInRound, rounds, lastHit) reflect the CURRENT player's state
//     for backward compatibility with the existing HUD code paths.

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
  function vsComKey(baseKey, comDifficulty) {
    return comDifficulty ? `${baseKey}.vs_${comDifficulty}` : baseKey;
  }
  function comName(difficulty) {
    return `COM ${difficulty[0].toUpperCase()}`;
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
      this.players = [];
      this.currentPlayer = 0;
      this.lastHit = null;
      this.best = 0;
      this.gameType = "base";
    }
    get cur() { return this.players[this.currentPlayer]; }
  }

  // Build a player array based on a "vs COM" flag. Subclasses pass in a
  // factory that produces game-specific per-player state.
  function buildPlayers(comDifficulty, mkState) {
    const players = [{ name: "P1", type: "human", difficulty: null, ...mkState() }];
    if (comDifficulty) {
      players.push({
        name: comName(comDifficulty),
        type: "com",
        difficulty: comDifficulty,
        ...mkState(),
      });
    }
    return players;
  }

  // ── 1. Count Up ─────────────────────────────────────────────────────────
  const COUNT_UP_ROUNDS = 8;

  class CountUpGame extends BaseGame {
    constructor({ comDifficulty = null } = {}) {
      super();
      this.gameType = "count_up";
      this.totalRounds = COUNT_UP_ROUNDS;
      this.throwsPerRound = 3;
      this.comDifficulty = comDifficulty;
      this.players = buildPlayers(comDifficulty, () => ({
        totalScore: 0, rounds: [[]], round: 0, throwInRound: 0,
      }));
      this._storageKey = vsComKey(STORAGE.count_up, comDifficulty);
      this.best = loadBest(this._storageKey);
    }
    start() {
      this.status = "playing";
      this.players.forEach((p) => {
        p.totalScore = 0; p.rounds = [[]]; p.round = 0; p.throwInRound = 0;
      });
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me = this.cur;
      const hit = { label: score.label, points: score.points, ring: score.ring,
                    number: score.number, multiplier: score.multiplier };
      me.rounds[me.round].push(hit);
      me.totalScore += hit.points;
      me.throwInRound += 1;
      this.lastHit = hit;
      if (me.throwInRound < this.throwsPerRound) return "throw";
      // End of this player's turn.
      const next = this.currentPlayer + 1;
      if (next < this.players.length) {
        this.currentPlayer = next;
        return "player_change";
      }
      // All players done this round.
      if (me.round + 1 >= this.totalRounds) {
        this.status = "finished";
        const human = this.players.find((p) => p.type === "human") || this.players[0];
        if (human.totalScore > this.best) {
          this.best = human.totalScore;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      const newRound = me.round + 1;
      this.players.forEach((p) => {
        p.round = newRound; p.throwInRound = 0; p.rounds.push([]);
      });
      this.currentPlayer = 0;
      return "round_end";
    }
    snapshot() {
      const me = this.cur;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        totalRounds: this.totalRounds,
        totalScore: me.totalScore,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        comDifficulty: this.comDifficulty,
        players: this.players.map((p) => ({
          name: p.name, type: p.type, totalScore: p.totalScore,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 2. X01 (301 / 501) ──────────────────────────────────────────────────
  class X01Game extends BaseGame {
    constructor({ startingScore = 501, doubleOut = false, comDifficulty = null } = {}) {
      super();
      this.gameType = "x01";
      this.startingScore = startingScore;
      this.doubleOut = doubleOut;
      this.comDifficulty = comDifficulty;
      this.throwsPerRound = 3;
      this.totalRounds = null;
      this.players = buildPlayers(comDifficulty, () => ({
        remaining: startingScore,
        roundStartRemaining: startingScore,
        rounds: [[]],
        round: 0,
        throwInRound: 0,
      }));
      const baseKey = startingScore === 301 ? STORAGE.x01_301 : STORAGE.x01_501;
      this._storageKey = vsComKey(baseKey, comDifficulty);
      this.best = loadBest(this._storageKey);
    }
    start() {
      this.status = "playing";
      this.players.forEach((p) => {
        p.remaining = this.startingScore;
        p.roundStartRemaining = this.startingScore;
        p.rounds = [[]]; p.round = 0; p.throwInRound = 0;
      });
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    _advanceTurn(resultIfPlayerChange) {
      const me = this.cur;
      me.round += 1;
      me.throwInRound = 0;
      me.roundStartRemaining = me.remaining;
      me.rounds.push([]);
      const next = this.currentPlayer + 1;
      if (next < this.players.length) {
        this.currentPlayer = next;
        return resultIfPlayerChange;
      }
      this.currentPlayer = 0;
      return "round_end";
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me = this.cur;
      const hit = { label: score.label, points: score.points, ring: score.ring,
                    number: score.number, multiplier: score.multiplier, bust: false };
      const candidate = me.remaining - hit.points;
      const isDoubleFinish = (hit.multiplier === 2 || hit.ring === "double-bull");
      let bust = false;
      if (candidate < 0) bust = true;
      else if (candidate === 0 && this.doubleOut && !isDoubleFinish) bust = true;
      else if (candidate === 1 && this.doubleOut) bust = true;
      if (bust) {
        hit.bust = true;
        me.rounds[me.round].push(hit);
        me.remaining = me.roundStartRemaining;
        this.lastHit = hit;
        return this._advanceTurn("bust");
      }
      me.remaining = candidate;
      me.rounds[me.round].push(hit);
      me.throwInRound += 1;
      this.lastHit = hit;
      if (me.remaining === 0) {
        this.status = "finished";
        const throwsTaken = me.round * 3 + me.throwInRound;
        if (me.type === "human" && (this.best === 0 || throwsTaken < this.best)) {
          this.best = throwsTaken;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      if (me.throwInRound < this.throwsPerRound) return "throw";
      return this._advanceTurn("player_change");
    }
    snapshot() {
      const me = this.cur;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        startingScore: this.startingScore,
        doubleOut: this.doubleOut,
        remaining: me.remaining,
        roundStartRemaining: me.roundStartRemaining,
        throwsTaken: me.round * 3 + me.throwInRound,
        totalScore: this.startingScore - me.remaining,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        comDifficulty: this.comDifficulty,
        players: this.players.map((p) => ({
          name: p.name, type: p.type, remaining: p.remaining,
          throwsTaken: p.round * 3 + p.throwInRound,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 3. Cricket Count Up ─────────────────────────────────────────────────
  class CricketCountUpGame extends BaseGame {
    constructor({ comDifficulty = null } = {}) {
      super();
      this.gameType = "cricket_count_up";
      this.totalRounds = CRICKET_COUNT_UP_TARGETS.length;
      this.throwsPerRound = 3;
      this.comDifficulty = comDifficulty;
      this.players = buildPlayers(comDifficulty, () => ({
        totalScore: 0, rounds: [[]], round: 0, throwInRound: 0,
      }));
      this._storageKey = vsComKey(STORAGE.cricket_count_up, comDifficulty);
      this.best = loadBest(this._storageKey);
    }
    start() {
      this.status = "playing";
      this.players.forEach((p) => {
        p.totalScore = 0; p.rounds = [[]]; p.round = 0; p.throwInRound = 0;
      });
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    targetsForRound(roundIdx) {
      return CRICKET_COUNT_UP_TARGETS[roundIdx] || [];
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me = this.cur;
      const targets = this.targetsForRound(me.round);
      const { targetNum, marks } = cricketMarks(score);
      let pointsAwarded = 0;
      let onTarget = false;
      if (targetNum != null && targets.includes(targetNum)) {
        pointsAwarded = targetNum * marks;
        onTarget = true;
      }
      const hit = {
        label: score.label, points: pointsAwarded, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        onTarget, targetNum,
      };
      me.rounds[me.round].push(hit);
      me.totalScore += pointsAwarded;
      me.throwInRound += 1;
      this.lastHit = hit;
      if (me.throwInRound < this.throwsPerRound) return "throw";
      const next = this.currentPlayer + 1;
      if (next < this.players.length) {
        this.currentPlayer = next;
        return "player_change";
      }
      if (me.round + 1 >= this.totalRounds) {
        this.status = "finished";
        const human = this.players.find((p) => p.type === "human") || this.players[0];
        if (human.totalScore > this.best) {
          this.best = human.totalScore;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      const newRound = me.round + 1;
      this.players.forEach((p) => {
        p.round = newRound; p.throwInRound = 0; p.rounds.push([]);
      });
      this.currentPlayer = 0;
      return "round_end";
    }
    snapshot() {
      const me = this.cur;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        totalRounds: this.totalRounds,
        currentTargets: this.targetsForRound(me.round),
        totalScore: me.totalScore,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        comDifficulty: this.comDifficulty,
        players: this.players.map((p) => ({
          name: p.name, type: p.type, totalScore: p.totalScore,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 4. Cricket Standard ─────────────────────────────────────────────────
  class CricketStandardGame extends BaseGame {
    constructor({ comDifficulty = null } = {}) {
      super();
      this.gameType = "cricket_standard";
      this.throwsPerRound = 3;
      this.comDifficulty = comDifficulty;
      this.targets = CRICKET_TARGETS.slice();
      this.players = buildPlayers(comDifficulty, () => ({
        marks: Object.fromEntries(CRICKET_TARGETS.map((t) => [t, 0])),
        points: 0,
        rounds: [[]],
        round: 0,
        throwInRound: 0,
      }));
      this._storageKey = vsComKey(STORAGE.cricket_standard, comDifficulty);
      this.best = loadBest(this._storageKey);
    }
    start() {
      this.status = "playing";
      this.players.forEach((p) => {
        CRICKET_TARGETS.forEach((t) => { p.marks[t] = 0; });
        p.points = 0;
        p.rounds = [[]]; p.round = 0; p.throwInRound = 0;
      });
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me = this.cur;
      const other = this.players[(this.currentPlayer + 1) % this.players.length];
      const { targetNum, marks } = cricketMarks(score);
      let marksAdded = 0, pointsAdded = 0;
      if (targetNum != null) {
        const current = me.marks[targetNum];
        if (current < 3) {
          const closing = Math.min(marks, 3 - current);
          const overflow = marks - closing;
          me.marks[targetNum] = current + closing;
          marksAdded = closing;
          if (overflow > 0 && (!other || other.marks[targetNum] < 3)) {
            pointsAdded = overflow * targetNum;
            me.points += pointsAdded;
          }
        } else if (!other || other.marks[targetNum] < 3) {
          pointsAdded = marks * targetNum;
          me.points += pointsAdded;
        }
      }
      const hit = {
        label: score.label, points: pointsAdded, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        targetNum, marksAdded,
      };
      me.rounds[me.round].push(hit);
      me.throwInRound += 1;
      this.lastHit = hit;
      const meClosedAll = this.targets.every((t) => me.marks[t] >= 3);
      // Standard Cricket: game ends when a player closes all targets AND has
      // points ≥ opponents. If they closed but have fewer points, keep going.
      if (meClosedAll) {
        const maxOtherPts = this.players
          .filter((p) => p !== me)
          .reduce((acc, p) => Math.max(acc, p.points), 0);
        if (me.points >= maxOtherPts) {
          this.status = "finished";
          if (me.type === "human" && me.points > this.best) {
            this.best = me.points;
            saveBest(this._storageKey, this.best);
          }
          return "game_end";
        }
      }
      if (me.throwInRound < this.throwsPerRound) return "throw";
      const next = this.currentPlayer + 1;
      if (next < this.players.length) {
        this.currentPlayer = next;
        return "player_change";
      }
      this.players.forEach((p) => {
        p.round += 1; p.throwInRound = 0; p.rounds.push([]);
      });
      this.currentPlayer = 0;
      return "round_end";
    }
    snapshot() {
      const me = this.cur;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        targets: this.targets.slice(),
        marks: { ...me.marks },
        points: me.points,
        totalScore: me.points,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        comDifficulty: this.comDifficulty,
        players: this.players.map((p) => ({
          name: p.name, type: p.type,
          marks: { ...p.marks }, points: p.points,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 5. Cricket Cut Throat ───────────────────────────────────────────────
  // Score over-marks to the opponent; lowest points wins.
  class CricketCutThroatGame extends BaseGame {
    constructor({ comDifficulty = null } = {}) {
      super();
      this.gameType = "cricket_cut_throat";
      this.throwsPerRound = 3;
      this.comDifficulty = comDifficulty;
      this.targets = CRICKET_TARGETS.slice();
      this.players = [
        { name: "P1", type: "human", difficulty: null,
          marks: {}, points: 0, rounds: [[]], round: 0, throwInRound: 0 },
        { name: comDifficulty ? comName(comDifficulty) : "P2",
          type: comDifficulty ? "com" : "human",
          difficulty: comDifficulty || null,
          marks: {}, points: 0, rounds: [[]], round: 0, throwInRound: 0 },
      ];
      this.players.forEach((p) => {
        CRICKET_TARGETS.forEach((t) => { p.marks[t] = 0; });
      });
      this.currentPlayer = 0;
      this._storageKey = vsComKey(STORAGE.cricket_cut_throat, comDifficulty);
      this.best = loadBest(this._storageKey);
    }
    start() {
      this.status = "playing";
      this.players.forEach((p) => {
        CRICKET_TARGETS.forEach((t) => { p.marks[t] = 0; });
        p.points = 0;
        p.rounds = [[]]; p.round = 0; p.throwInRound = 0;
      });
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    recordHit(score) {
      if (this.status !== "playing") return "ignored";
      const me = this.cur;
      const other = this.players[(this.currentPlayer + 1) % this.players.length];
      const { targetNum, marks } = cricketMarks(score);
      let marksAdded = 0, pointsAddedToOpponent = 0;
      if (targetNum != null) {
        const current = me.marks[targetNum];
        if (current < 3) {
          const closing = Math.min(marks, 3 - current);
          const overflow = marks - closing;
          me.marks[targetNum] = current + closing;
          marksAdded = closing;
          if (overflow > 0 && other.marks[targetNum] < 3) {
            pointsAddedToOpponent = overflow * targetNum;
            other.points += pointsAddedToOpponent;
          }
        } else if (other.marks[targetNum] < 3) {
          pointsAddedToOpponent = marks * targetNum;
          other.points += pointsAddedToOpponent;
        }
      }
      const hit = {
        label: score.label, points: pointsAddedToOpponent, ring: score.ring,
        number: score.number, multiplier: score.multiplier,
        targetNum, marksAdded, pointedAtPlayer: other.name,
      };
      me.rounds[me.round].push(hit);
      me.throwInRound += 1;
      this.lastHit = hit;
      const meClosedAll = this.targets.every((t) => me.marks[t] >= 3);
      if (meClosedAll) {
        this.status = "finished";
        const winner = me.points <= other.points ? me : other;
        if (this.best === 0 || winner.points < this.best) {
          this.best = winner.points;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      if (me.throwInRound < this.throwsPerRound) return "throw";
      this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
      this.cur.round += 1;
      this.cur.throwInRound = 0;
      this.cur.rounds.push([]);
      return "player_change";
    }
    snapshot() {
      const me = this.cur;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        targets: this.targets.slice(),
        totalScore: me.points,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        comDifficulty: this.comDifficulty,
        players: this.players.map((p) => ({
          name: p.name, type: p.type,
          marks: { ...p.marks }, points: p.points,
        })),
        currentPlayer: this.currentPlayer,
      };
    }
  }

  // ── 6. Practice ─────────────────────────────────────────────────────────
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
      // Practice is solo — single "player" entry kept for snapshot uniformity.
      this.players = [{
        name: "P1", type: "human", difficulty: null,
        rounds: [[]], round: 0, throwInRound: 0,
      }];
      this.currentPlayer = 0;
    }
    start() {
      this.status = "playing";
      this.hits = 0; this.streak = 0; this.longestStreak = 0;
      this.players[0].rounds = [[]];
      this.players[0].round = 0;
      this.players[0].throwInRound = 0;
      this.currentPlayer = 0;
      this.lastHit = null;
    }
    isOnTarget(score) {
      if (this.targetNumber === 25) {
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
      const me = this.players[0];
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
      me.rounds[me.round].push(hit);
      me.throwInRound += 1;
      this.lastHit = hit;
      const totalThrows = me.round * this.throwsPerRound + me.throwInRound;
      if (totalThrows >= this.maxThrows) {
        this.status = "finished";
        if (this.hits > this.best) {
          this.best = this.hits;
          saveBest(this._storageKey, this.best);
        }
        return "game_end";
      }
      if (me.throwInRound >= this.throwsPerRound) {
        me.round += 1;
        me.throwInRound = 0;
        me.rounds.push([]);
        return "round_end";
      }
      return "throw";
    }
    snapshot() {
      const me = this.players[0];
      const totalThrows = me.round * this.throwsPerRound + me.throwInRound;
      return {
        gameType: this.gameType,
        status: this.status,
        round: me.round, throwInRound: me.throwInRound,
        throwsPerRound: this.throwsPerRound,
        totalRounds: this.totalRounds,
        targetNumber: this.targetNumber,
        targetRing: this.targetRing,
        maxThrows: this.maxThrows,
        hits: this.hits,
        streak: this.streak,
        longestStreak: this.longestStreak,
        throwsTaken: totalThrows,
        hitRate: totalThrows > 0 ? this.hits / totalThrows : 0,
        rounds: me.rounds,
        lastHit: this.lastHit,
        best: this.best,
        totalScore: this.hits,
        players: [{ name: "P1", type: "human" }],
        currentPlayer: 0,
      };
    }
  }

  // ── Factory + registry ──────────────────────────────────────────────────
  function makeGame(mode, options) {
    const opts = options || {};
    switch (mode) {
      case "x01_301":            return new X01Game({ startingScore: 301, doubleOut: false, comDifficulty: opts.comDifficulty });
      case "x01_501":            return new X01Game({ startingScore: 501, doubleOut: false, comDifficulty: opts.comDifficulty });
      case "x01_501_do":         return new X01Game({ startingScore: 501, doubleOut: true,  comDifficulty: opts.comDifficulty });
      case "cricket_count_up":   return new CricketCountUpGame({ comDifficulty: opts.comDifficulty });
      case "cricket_standard":   return new CricketStandardGame({ comDifficulty: opts.comDifficulty });
      case "cricket_cut_throat": return new CricketCutThroatGame({ comDifficulty: opts.comDifficulty });
      case "practice":           return new PracticeGame(opts);
      case "count_up":
      default:                   return new CountUpGame({ comDifficulty: opts.comDifficulty });
    }
  }

  // Game-type entries — the comDifficulty variants are now picked via a
  // separate opponent selector in the UI.
  const MODE_LIST = Object.freeze([
    { id: "count_up",            name: "Count Up",         hint: "8 rounds, sum the points" },
    { id: "x01_301",             name: "301",              hint: "Reach 0 from 301" },
    { id: "x01_501",             name: "501",              hint: "Reach 0 from 501" },
    { id: "cricket_count_up",    name: "Cricket Count Up", hint: "20→19→…→Bull→ALL" },
    { id: "cricket_standard",    name: "Cricket Standard", hint: "Close 15-20 + Bull, score on closed" },
    { id: "cricket_cut_throat",  name: "Cut Throat",       hint: "Low score wins (vs human or COM)" },
    { id: "practice",            name: "Practice",         hint: "Pick a target, 30 throws (solo)" },
  ]);

  // Opponent selector — applies to every mode except Practice (which is
  // inherently solo). The controller stores currentOpponent and feeds it
  // into makeGame() as { comDifficulty: "easy" | "normal" | "hard" | null }.
  const OPPONENT_LIST = Object.freeze([
    { id: null,     name: "SOLO",     hint: "1 player" },
    { id: "easy",   name: "COM EASY",   hint: "wild scatter" },
    { id: "normal", name: "COM NORMAL", hint: "balanced" },
    { id: "hard",   name: "COM HARD",   hint: "tight, dangerous" },
  ]);

  function supportsOpponent(modeId) {
    return modeId !== "practice";
  }

  window.DartlineGame = {
    CountUpGame, X01Game, CricketCountUpGame,
    CricketStandardGame, CricketCutThroatGame, PracticeGame,
    makeGame, MODE_LIST, OPPONENT_LIST, supportsOpponent,
    CRICKET_TARGETS, CRICKET_COUNT_UP_TARGETS,
  };
})();
