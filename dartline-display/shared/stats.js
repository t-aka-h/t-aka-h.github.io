// Dartline Display — career stats + play history persistence.
// LocalStorage-backed. Used by the controller to record every throw and
// every completed game across all modes.

(() => {
  const STATS_KEY   = "dartline-display.careerStats.v1";
  const HISTORY_KEY = "dartline-display.playHistory.v1";
  const MAX_HISTORY_PER_MODE = 50;

  const EMPTY_STATS = Object.freeze({
    totalGames:    0,
    totalThrows:   0,
    totalPoints:   0,
    bullHits:      0,    // either bull (outer or double)
    doubleBullHits: 0,
    triple20Hits:  0,
    perfectHits:   0,    // T20 / double bull / treble-class
    misses:        0,
    firstPlayedAt: null, // ISO date
    lastPlayedAt:  null,
  });

  function loadStats() {
    try {
      const raw = window.localStorage.getItem(STATS_KEY);
      if (!raw) return { ...EMPTY_STATS };
      const parsed = JSON.parse(raw);
      return { ...EMPTY_STATS, ...parsed };
    } catch (_) {
      return { ...EMPTY_STATS };
    }
  }
  function saveStats(s) {
    try { window.localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (_) {}
  }

  function loadHistory() {
    try {
      const raw = window.localStorage.getItem(HISTORY_KEY);
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch (_) {
      return {};
    }
  }
  function saveHistory(h) {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (_) {}
  }

  // Run-time live state. Refresh = read from storage.
  let stats = loadStats();
  let history = loadHistory();

  function recordThrow(score) {
    if (!score) return;
    stats.totalThrows += 1;
    stats.totalPoints += score.points || 0;
    if (score.ring === "outer-bull" || score.ring === "double-bull") {
      stats.bullHits += 1;
      if (score.ring === "double-bull") stats.doubleBullHits += 1;
    }
    if (score.number === 20 && score.multiplier === 3) stats.triple20Hits += 1;
    if (score.ring === "double-bull" ||
        (score.multiplier === 3 && score.points >= 51)) {
      stats.perfectHits += 1;
    }
    if (score.ring === "miss") stats.misses += 1;
    const now = new Date().toISOString();
    if (!stats.firstPlayedAt) stats.firstPlayedAt = now;
    stats.lastPlayedAt = now;
    saveStats(stats);
  }

  function recordGameEnd(snap, wasNewBest = false) {
    if (!snap || !snap.gameType) return;
    stats.totalGames += 1;
    saveStats(stats);

    // Per-mode history
    const modeKey = (snap.gameType === "x01")
      ? `x01_${snap.startingScore}${snap.doubleOut ? "_do" : ""}`
      : snap.gameType;
    if (!history[modeKey]) history[modeKey] = [];
    const entry = {
      ts:        Date.now(),
      gameType:  snap.gameType,
      finalScore:  snap.totalScore || 0,
      remaining:   snap.remaining ?? null,
      throwsTaken: snap.throwsTaken ?? null,
      hits:        snap.hits ?? null,
      maxThrows:   snap.maxThrows ?? null,
      wasNewBest:  !!wasNewBest,
    };
    history[modeKey].unshift(entry);
    if (history[modeKey].length > MAX_HISTORY_PER_MODE) {
      history[modeKey].length = MAX_HISTORY_PER_MODE;
    }
    saveHistory(history);
  }

  function clearHistory() {
    history = {};
    saveHistory(history);
  }
  function resetAll() {
    stats = { ...EMPTY_STATS };
    saveStats(stats);
    history = {};
    saveHistory(history);
  }

  function getStats() { return { ...stats }; }
  function getHistory() { return JSON.parse(JSON.stringify(history)); }
  function getHistoryForMode(modeKey) {
    return (history[modeKey] || []).slice();
  }

  function bullHitRate() {
    return stats.totalThrows > 0 ? stats.bullHits / stats.totalThrows : 0;
  }
  function t20HitRate() {
    return stats.totalThrows > 0 ? stats.triple20Hits / stats.totalThrows : 0;
  }
  function averagePointsPerThrow() {
    return stats.totalThrows > 0 ? stats.totalPoints / stats.totalThrows : 0;
  }

  window.DartlineStats = {
    recordThrow, recordGameEnd,
    clearHistory, resetAll,
    getStats, getHistory, getHistoryForMode,
    bullHitRate, t20HitRate, averagePointsPerThrow,
  };
})();
