// Dartline Display — Canvas 2D dartboard renderer.
// Port of the iOS Dartline DartboardView (Day 1.8 / 1.9 / 1.12).
//
// Visual layers (back to front):
//   1. Outer cabinet (deep purple-black) + chamfer
//   2. Outer cyan LED rim with 2-stage glow + 20 boundary markers
//   3. Number ring background
//   4. 20 segments (cyan-dark / cool off-white, alternating)
//   5. Triple and Double bands (hot magenta + electric cyan, alternating)
//   6. Honeycomb dot overlay (multiply blend) — adds "hole" texture
//   7. 2-layer chrome spider (dark stroke under, bright silver over)
//   8. Numbers (heavy + black shadow for legibility)
//   9. Top-half glass highlight (plusLighter blend)
//  10. Bullseye stack (outer amber + inner magenta with strong emission)
//  11. Hit markers (3-layer LED glow + black outline + radial gradient)
//  12. Pulsing rings on the most recent hit
//  13. Crosshair (cyan when free, magenta with halo when locked)

(() => {
  const COLOR = Object.freeze({
    // Cabinet / chassis
    cabinet:       "#05030F",
    cabinetEdge:   "#261A4A",
    numberRing:    "#08051A",
    // Segments
    segmentDark:   "#0E0C20",
    segmentLight:  "#EAF0F8",
    // Rings (alternate per segment)
    ringPrimary:   "#FF2D87",   // hot magenta
    ringSecondary: "#00E5FF",   // electric cyan
    // Bulls
    bullInner:     "#FF2D87",
    bullOuter:     "#FFB547",
    bullCenterHi:  "#FFFFFF",
    // LED rim
    ledRim:        "#46E3FF",
    // Spider
    spiderShadow:  "rgba(8, 5, 26, 0.85)",
    spiderChrome:  "#D5DCE6",
    // Text
    numberText:    "#FFFFFF",
    numberShadow:  "rgba(0, 0, 0, 0.85)",
    // Crosshair
    crosshair:        "#00E5FF",
    crosshairLocked:  "#FF2D87",
    // Hit
    hitGlow:       "rgba(255, 181, 71, 0.55)",
    hitCenter:     "#FFD27F",
    hitOutline:    "rgba(0, 0, 0, 0.85)",
  });

  const MAX_HITS = 3;
  const PULSE_CYCLE_MS = 900;
  const HIT_FADE_MS = 1800;

  class DartboardCanvas {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.hits = [];           // [{ x, y, score, ts }]
      this.aim = { x: 0, y: 0 };
      this.locked = false;
      this.lockedAim = null;
      this._animPending = false;
      this._honeycombCache = null;
      this._lastSide = 0;
      // Eased aim — chases the target each frame so on-screen motion stays
      // 60 fps smooth even when WebSocket updates land at ~30 Hz with jitter.
      this._easedAim = { x: 0, y: 0 };
      this._easedAimRate = 0.28;  // larger = snappier, smaller = floatier
      this._resize();
      window.addEventListener("resize", () => {
        this._resize();
        this._honeycombCache = null;
        this.requestDraw();
      });
      // Continuous animation loop — eases the crosshair and redraws when
      // either the cursor is in motion or there are pulsing hits.
      const tick = () => {
        const target = this.locked && this.lockedAim ? this.lockedAim : this.aim;
        const dx = target.x - this._easedAim.x;
        const dy = target.y - this._easedAim.y;
        const moving = Math.abs(dx) > 0.0008 || Math.abs(dy) > 0.0008;
        if (moving) {
          this._easedAim.x += dx * this._easedAimRate;
          this._easedAim.y += dy * this._easedAimRate;
        }
        if (moving || this.hits.length > 0) this.draw();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    _resize() {
      const rect = this.canvas.getBoundingClientRect();
      const side = Math.min(rect.width, rect.height) || 480;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(side * dpr);
      this.canvas.height = Math.round(side * dpr);
      this.canvas.style.width = side + "px";
      this.canvas.style.height = side + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.side = side;
      this.cx = side / 2;
      this.cy = side / 2;
      // Radius of the dartboard (double-ring outer edge).
      // Leave headroom for cabinet chamfer + outer LED rim.
      this.R = side * 0.42;
    }

    setAim(aim) {
      this.aim = aim;
      this.requestDraw();
    }

    setLock(locked, lockedAim) {
      this.locked = locked;
      this.lockedAim = lockedAim || null;
      this.requestDraw();
    }

    addHit(x, y, score) {
      this.hits.push({ x, y, score, ts: Date.now() });
      if (this.hits.length > MAX_HITS) this.hits.shift();
      this.requestDraw();
    }

    clearHits() {
      this.hits = [];
      this.requestDraw();
    }

    requestDraw() {
      if (this._animPending) return;
      this._animPending = true;
      requestAnimationFrame(() => {
        this._animPending = false;
        this.draw();
      });
    }

    _world(x, y) {
      return [this.cx + x * this.R, this.cy - y * this.R];
    }

    draw() {
      const ctx = this.ctx;
      const { cx, cy, R, side } = this;
      const RINGS = window.DartlineDartboard.RINGS;
      const NUMS  = window.DartlineDartboard.SEGMENT_NUMBERS;

      // ── Cabinet background ─────────────────────────────────────────────
      ctx.fillStyle = COLOR.cabinet;
      ctx.fillRect(0, 0, side, side);

      // ── Cabinet chamfer (purple ring around the LED rim) ──────────────
      ctx.strokeStyle = COLOR.cabinetEdge;
      ctx.lineWidth = R * 0.06;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.18, 0, Math.PI * 2);
      ctx.stroke();

      // ── Outer cyan LED rim (2-stage glow) ──────────────────────────────
      ctx.strokeStyle = COLOR.ledRim;
      // Wide soft halo.
      ctx.shadowColor = COLOR.ledRim;
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.13, 0, Math.PI * 2);
      ctx.stroke();
      // Tight bright core.
      ctx.shadowBlur = 6;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // 20 boundary marker LEDs around the rim.
      ctx.fillStyle = COLOR.ledRim;
      ctx.shadowColor = COLOR.ledRim;
      ctx.shadowBlur = 8;
      for (let i = 0; i < 20; i++) {
        const a = ((i + 0.5) * 18 - 90) * Math.PI / 180;
        const px = cx + Math.cos(a) * R * 1.13;
        const py = cy + Math.sin(a) * R * 1.13;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.012, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // ── Number ring background ─────────────────────────────────────────
      ctx.fillStyle = COLOR.numberRing;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.10, 0, Math.PI * 2);
      ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
      ctx.fill("evenodd");

      // ── 20 segments + double/triple bands ──────────────────────────────
      for (let i = 0; i < 20; i++) {
        const centerDeg = i * 18;
        const a0 = (centerDeg - 9 - 90) * Math.PI / 180;
        const a1 = (centerDeg + 9 - 90) * Math.PI / 180;
        const dark = (i % 2) === 0;
        // Base wedge.
        ctx.fillStyle = dark ? COLOR.segmentDark : COLOR.segmentLight;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a1);
        ctx.closePath();
        ctx.fill();

        const ringColor = dark ? COLOR.ringPrimary : COLOR.ringSecondary;
        // Triple band.
        ctx.fillStyle = ringColor;
        ctx.beginPath();
        ctx.arc(cx, cy, R * RINGS.triple, a0, a1);
        ctx.arc(cx, cy, R * RINGS.innerSingle, a1, a0, true);
        ctx.closePath();
        ctx.fill();
        // Double band.
        ctx.fillStyle = ringColor;
        ctx.beginPath();
        ctx.arc(cx, cy, R * RINGS.double, a0, a1);
        ctx.arc(cx, cy, R * RINGS.outerSingle, a1, a0, true);
        ctx.closePath();
        ctx.fill();
      }

      // ── Honeycomb dot overlay (multiply blend) ─────────────────────────
      this._drawHoneycomb(ctx, R);

      // ── 2-layer chrome spider ──────────────────────────────────────────
      // Dark shadow stroke first (slightly thicker), then bright chrome
      // stroke on top (thinner) — gives a beveled-wire look.
      const spiderInner = R * RINGS.outerBull;
      const spiderOuter = R;
      const ringRadii = [RINGS.outerBull, RINGS.innerSingle, RINGS.triple,
                         RINGS.outerSingle, RINGS.double];

      // Layer 1: shadow.
      ctx.strokeStyle = COLOR.spiderShadow;
      ctx.lineWidth = 3.5;
      for (let i = 0; i < 20; i++) {
        const a = ((i + 0.5) * 18 - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * spiderInner, cy + Math.sin(a) * spiderInner);
        ctx.lineTo(cx + Math.cos(a) * spiderOuter, cy + Math.sin(a) * spiderOuter);
        ctx.stroke();
      }
      for (const rr of ringRadii) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Layer 2: chrome highlight.
      ctx.strokeStyle = COLOR.spiderChrome;
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 20; i++) {
        const a = ((i + 0.5) * 18 - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * spiderInner, cy + Math.sin(a) * spiderInner);
        ctx.lineTo(cx + Math.cos(a) * spiderOuter, cy + Math.sin(a) * spiderOuter);
        ctx.stroke();
      }
      for (const rr of ringRadii) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ── Top-half glass highlight (plus-lighter blend) ─────────────────
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const grad = ctx.createLinearGradient(cx, cy - R, cx, cy);
      grad.addColorStop(0, "rgba(255, 255, 255, 0.18)");
      grad.addColorStop(0.45, "rgba(255, 255, 255, 0.05)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0.0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, Math.PI, Math.PI * 2);
      ctx.lineTo(cx + R, cy);
      ctx.arc(cx, cy, R, 0, Math.PI, true);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ── Numbers (heavy + black shadow) ─────────────────────────────────
      const fontPx = Math.round(R * 0.10);
      ctx.font = `900 ${fontPx}px -apple-system, "Helvetica Neue", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelR = R * 1.05;
      for (let i = 0; i < 20; i++) {
        const a = (i * 18 - 90) * Math.PI / 180;
        const tx = cx + Math.cos(a) * labelR;
        const ty = cy + Math.sin(a) * labelR;
        ctx.fillStyle = COLOR.numberShadow;
        ctx.fillText(String(NUMS[i]), tx + 1, ty + 1);
        ctx.fillStyle = COLOR.numberText;
        ctx.fillText(String(NUMS[i]), tx, ty);
      }

      // ── Bullseye stack with strong emission ────────────────────────────
      // Outer bull (amber).
      ctx.shadowColor = COLOR.bullOuter;
      ctx.shadowBlur = 14;
      ctx.fillStyle = COLOR.bullOuter;
      ctx.beginPath();
      ctx.arc(cx, cy, R * RINGS.outerBull, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Inner bull — radial gradient white→magenta with glow.
      const bullR = R * RINGS.doubleBull;
      const bullGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, bullR);
      bullGrad.addColorStop(0, COLOR.bullCenterHi);
      bullGrad.addColorStop(0.45, "#FFB1D2");
      bullGrad.addColorStop(1, COLOR.bullInner);
      ctx.shadowColor = COLOR.bullInner;
      ctx.shadowBlur = 18;
      ctx.fillStyle = bullGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, bullR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 8;
      ctx.fillStyle = bullGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, bullR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // ── Hit markers ────────────────────────────────────────────────────
      this._drawHits(ctx, R);

      // ── Crosshair ──────────────────────────────────────────────────────
      this._drawCrosshair(ctx, R);
    }

    _drawHoneycomb(ctx, R) {
      // Cached canvas so we don't recompute the dot grid every frame.
      if (!this._honeycombCache || this._lastSide !== this.side) {
        const off = document.createElement("canvas");
        off.width = this.canvas.width;
        off.height = this.canvas.height;
        const octx = off.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const step = R * 0.045;
        const dot = R * 0.011;
        octx.fillStyle = "rgba(0, 0, 0, 0.30)";
        const cols = Math.ceil(this.side / step) + 2;
        const rows = Math.ceil(this.side / (step * 0.866)) + 2;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            const offsetX = (row % 2 === 0) ? 0 : step / 2;
            const px = col * step + offsetX;
            const py = row * step * 0.866;
            const dx = px - this.cx;
            const dy = py - this.cy;
            if (Math.hypot(dx, dy) > R * 1.02) continue;
            // Mask: only within the board.
            octx.beginPath();
            octx.arc(px, py, dot, 0, Math.PI * 2);
            octx.fill();
          }
        }
        this._honeycombCache = off;
        this._lastSide = this.side;
      }
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.drawImage(this._honeycombCache, 0, 0, this.side, this.side);
      ctx.restore();
    }

    _drawHits(ctx, R) {
      const now = Date.now();
      this.hits.forEach((hit, idx) => {
        const [px, py] = this._world(hit.x, hit.y);
        const age = now - hit.ts;
        const fade = Math.max(0.35, 1 - age / HIT_FADE_MS);

        // Pulsing rings on the most recent hit only.
        const isLatest = idx === this.hits.length - 1;
        if (isLatest && age < PULSE_CYCLE_MS * 3) {
          for (const phaseOffset of [0, PULSE_CYCLE_MS / 2]) {
            const phase = ((now + phaseOffset) % PULSE_CYCLE_MS) / PULSE_CYCLE_MS;
            const ringR = R * (0.025 + 0.13 * phase);
            const ringAlpha = (1 - phase) * 0.7;
            ctx.strokeStyle = `rgba(255, 181, 71, ${ringAlpha.toFixed(3)})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, ringR, 0, Math.PI * 2);
            ctx.stroke();
          }
        }

        // Soft amber glow halo.
        ctx.fillStyle = COLOR.hitGlow;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.05, 0, Math.PI * 2);
        ctx.fill();

        // Black outline for contrast against bright segments.
        const outlineLW = Math.max(1.2, R * 0.005);
        ctx.lineWidth = outlineLW;
        ctx.strokeStyle = COLOR.hitOutline;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.022, 0, Math.PI * 2);
        ctx.stroke();

        // Bright LED center with radial gradient (white → amber).
        ctx.globalAlpha = fade;
        const led = ctx.createRadialGradient(px, py, 0, px, py, R * 0.022);
        led.addColorStop(0, "#FFFFFF");
        led.addColorStop(0.55, COLOR.hitCenter);
        led.addColorStop(1, "rgba(255, 181, 71, 0.95)");
        ctx.fillStyle = led;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.022, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    _drawCrosshair(ctx, R) {
      // Use the eased position so the crosshair glides between samples.
      const aim = this._easedAim;
      const color = this.locked ? COLOR.crosshairLocked : COLOR.crosshair;
      const [ax, ay] = this._world(aim.x, aim.y);
      const arm = R * 0.085;
      ctx.shadowColor = color;
      ctx.shadowBlur = this.locked ? 18 : 12;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax - arm, ay); ctx.lineTo(ax + arm, ay);
      ctx.moveTo(ax, ay - arm); ctx.lineTo(ax, ay + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ax, ay, R * 0.028, 0, Math.PI * 2);
      ctx.fill();
      if (this.locked) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ax, ay, R * 0.075, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  window.DartlineDartboardCanvas = DartboardCanvas;
})();
