// Dartline Display — Dartboard geometry and scoring.
// Pure functions, no DOM. Used by display.js to draw and score, and
// optionally by controller.js for local previews.
//
// Coordinate system:
//   (x, y) in [-1, +1] with (0, 0) = bullseye, +x = right, +y = up.
//   The double ring outer edge is r = 1.0; anything farther is a miss.

(() => {
  // Standard dartboard segment numbers, clockwise starting from the top (20).
  // 20 is centered at 12 o'clock; each segment is 18° wide.
  const SEGMENT_NUMBERS = Object.freeze([
    20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
    3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
  ]);

  // Normalized ring boundaries (radii from center). Simplified from BDO
  // measurements — close enough for Phase 2 hit visualization.
  const RINGS = Object.freeze({
    doubleBull: 0.05,   // 50 points
    outerBull:  0.12,   // 25 points
    innerSingle: 0.60,
    triple:      0.66,
    outerSingle: 0.94,
    double:      1.00,
  });

  function normalizeAngleDeg(deg) {
    return ((deg % 360) + 360) % 360;
  }

  // Returns the segment index (0..19) that covers angle clockwiseFromTopDeg.
  // 0 = the segment scoring "20" (centered at the top, ±9°).
  function segmentIndexAt(clockwiseFromTopDeg) {
    const a = normalizeAngleDeg(clockwiseFromTopDeg + 9);
    return Math.floor(a / 18) % 20;
  }

  // Convert (x, y) with +y = up to clockwise-from-top angle in degrees.
  function angleFromTop(x, y) {
    const mathDeg = (Math.atan2(y, x) * 180) / Math.PI;
    // mathDeg: +90 = up, 0 = right, -90 = down, ±180 = left.
    // We want: 0 = up, 90 = right, 180 = down, 270 = left.
    return normalizeAngleDeg(90 - mathDeg);
  }

  // Main scoring function. Returns:
  //   { number, multiplier, label, points, ring, segmentIndex }
  // ring is one of: "double-bull", "outer-bull", "triple", "double",
  //                  "single", "miss".
  function scoreAt(x, y) {
    const r = Math.hypot(x, y);
    if (r > RINGS.double) {
      return {
        number: 0, multiplier: 0, label: "MISS",
        points: 0, ring: "miss", segmentIndex: -1,
      };
    }
    if (r <= RINGS.doubleBull) {
      return {
        number: 50, multiplier: 1, label: "BULL",
        points: 50, ring: "double-bull", segmentIndex: -1,
      };
    }
    if (r <= RINGS.outerBull) {
      return {
        number: 25, multiplier: 1, label: "25",
        points: 25, ring: "outer-bull", segmentIndex: -1,
      };
    }
    const idx = segmentIndexAt(angleFromTop(x, y));
    const num = SEGMENT_NUMBERS[idx];
    let multiplier = 1;
    let ring = "single";
    if (r > RINGS.innerSingle && r <= RINGS.triple) {
      multiplier = 3;
      ring = "triple";
    } else if (r > RINGS.outerSingle) {
      multiplier = 2;
      ring = "double";
    }
    const points = num * multiplier;
    const label =
      multiplier === 3 ? `T${num}` :
      multiplier === 2 ? `D${num}` : String(num);
    return { number: num, multiplier, label, points, ring, segmentIndex: idx };
  }

  // Helper for drawing: returns the start/end clockwise-from-top angle (deg)
  // covered by the given segment index.
  function segmentArcDeg(segmentIndex) {
    const center = segmentIndex * 18;
    return { startDeg: center - 9, endDeg: center + 9 };
  }

  window.DartlineDartboard = {
    SEGMENT_NUMBERS,
    RINGS,
    scoreAt,
    segmentIndexAt,
    angleFromTop,
    segmentArcDeg,
  };
})();
