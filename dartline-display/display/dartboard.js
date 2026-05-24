// Dartline Display — Canvas 2D dartboard renderer.
// One DartboardCanvas instance owns a <canvas> element. The display.js
// module instantiates it, then calls drawHit() / setCrosshair() / setLock()
// in response to incoming messages.

(() => {
  const COLOR = Object.freeze({
    cabinet:    "#000000",
    rim:        "#46E3FF",   // outer LED bezel
    wire:       "#C8D0DC",   // chrome spider
    numberRing: "#08051A",
    segmentDark:  "#0E0C20", // CYAN-tinted segment
    segmentLight: "#EAF0F8", // off-white segment
    ringPrimary:   "#FF2D87", // hot magenta (double/triple alternates)
    ringSecondary: "#00E5FF", // electric cyan (double/triple alternates)
    bullInner:  "#FF2D87",   // double bull
    bullOuter:  "#FFB547",   // outer bull (amber)
    crosshair:  "#00E5FF",
    crosshairLocked: "#FF2D87",
    hit:        "#FFB547",
    hitGlow:    "rgba(255, 181, 71, 0.65)",
    numberText: "#FFFFFF",
  });

  // Hit history — drawn as fading dots. Cap size keeps the canvas readable.
  const MAX_HITS = 3;

  class DartboardCanvas {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.hits = [];           // [{ x, y, score, ts }]
      this.aim = { x: 0, y: 0 };
      this.locked = false;
      this.lockedAim = null;
      this._resize();
      window.addEventListener("resize", () => { this._resize(); this.draw(); });
    }

    _resize() {
      // Canvas is square; size from its bounding box and account for DPR.
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
      // R is the radius corresponding to the dartboard's double-ring outer
      // edge. Leave ~6% margin so numbers and rim are visible.
      this.R = side * 0.46;
    }

    setAim(aim) {
      this.aim = aim;
      this.draw();
    }

    setLock(locked, lockedAim) {
      this.locked = locked;
      this.lockedAim = lockedAim || null;
      this.draw();
    }

    addHit(x, y, score) {
      this.hits.push({ x, y, score, ts: Date.now() });
      if (this.hits.length > MAX_HITS) this.hits.shift();
      this.draw();
    }

    clearHits() {
      this.hits = [];
      this.draw();
    }

    // World-to-canvas: (x, y) in [-1, +1] with +y up.
    _world(x, y) {
      return [this.cx + x * this.R, this.cy - y * this.R];
    }

    draw() {
      const ctx = this.ctx;
      const { cx, cy, R, side } = this;
      ctx.clearRect(0, 0, side, side);

      // Cabinet bezel — a thin glowing rim that survives on additive displays.
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLOR.rim;
      ctx.shadowColor = COLOR.rim;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Number ring background ring.
      ctx.fillStyle = COLOR.numberRing;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.08, 0, Math.PI * 2);
      ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
      ctx.fill();

      // 20 segments. Each spans 18°; segment 0 (= "20") is centered at the
      // top (-90° in canvas terms, which is 12 o'clock).
      const RINGS = window.DartlineDartboard.RINGS;
      const NUMS  = window.DartlineDartboard.SEGMENT_NUMBERS;
      for (let i = 0; i < 20; i++) {
        const centerDeg = i * 18;                 // clockwise from top
        const a0 = (centerDeg - 9 - 90) * Math.PI / 180;
        const a1 = (centerDeg + 9 - 90) * Math.PI / 180;
        const dark = (i % 2) === 0;
        // Base segment (single ring portion).
        ctx.fillStyle = dark ? COLOR.segmentDark : COLOR.segmentLight;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, a0, a1);
        ctx.closePath();
        ctx.fill();

        // Triple ring band.
        const ringColor = dark ? COLOR.ringPrimary : COLOR.ringSecondary;
        ctx.fillStyle = ringColor;
        ctx.beginPath();
        ctx.arc(cx, cy, R * RINGS.triple, a0, a1);
        ctx.arc(cx, cy, R * RINGS.innerSingle, a1, a0, true);
        ctx.closePath();
        ctx.fill();

        // Double ring band.
        ctx.fillStyle = ringColor;
        ctx.beginPath();
        ctx.arc(cx, cy, R * RINGS.double, a0, a1);
        ctx.arc(cx, cy, R * RINGS.outerSingle, a1, a0, true);
        ctx.closePath();
        ctx.fill();
      }

      // Spider wires (segment borders) — bright chrome strokes.
      ctx.strokeStyle = COLOR.wire;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 20; i++) {
        const a = ((i + 0.5) * 18 - 90) * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * R * RINGS.outerBull,
                   cy + Math.sin(a) * R * RINGS.outerBull);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      }
      // Concentric ring strokes.
      const ringRadii = [RINGS.outerBull, RINGS.innerSingle, RINGS.triple,
                         RINGS.outerSingle, RINGS.double];
      ctx.lineWidth = 1.5;
      for (const rr of ringRadii) {
        ctx.beginPath();
        ctx.arc(cx, cy, R * rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Bulls.
      ctx.fillStyle = COLOR.bullOuter;
      ctx.beginPath();
      ctx.arc(cx, cy, R * RINGS.outerBull, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLOR.bullInner;
      ctx.shadowColor = COLOR.bullInner;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, R * RINGS.doubleBull, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Numbers around the rim.
      ctx.fillStyle = COLOR.numberText;
      ctx.font = `${Math.round(R * 0.085)}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelR = R * 1.04;
      for (let i = 0; i < 20; i++) {
        const a = (i * 18 - 90) * Math.PI / 180;
        const tx = cx + Math.cos(a) * labelR;
        const ty = cy + Math.sin(a) * labelR;
        ctx.fillText(String(NUMS[i]), tx, ty);
      }

      // Past hits (oldest first, newest brightest).
      const now = Date.now();
      this.hits.forEach((hit, idx) => {
        const age = (now - hit.ts) / 1500; // fade over 1.5 s
        const fade = Math.max(0.45, 1 - age * 0.6);
        const [px, py] = this._world(hit.x, hit.y);
        ctx.fillStyle = COLOR.hitGlow;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = COLOR.hit;
        ctx.globalAlpha = fade;
        ctx.beginPath();
        ctx.arc(px, py, R * 0.022, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });

      // Crosshair — when locked, draw the lockedAim with a different style.
      const aim = this.locked && this.lockedAim ? this.lockedAim : this.aim;
      const color = this.locked ? COLOR.crosshairLocked : COLOR.crosshair;
      const [ax, ay] = this._world(aim.x, aim.y);
      const arm = R * 0.08;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = this.locked ? 16 : 10;
      ctx.beginPath();
      ctx.moveTo(ax - arm, ay); ctx.lineTo(ax + arm, ay);
      ctx.moveTo(ax, ay - arm); ctx.lineTo(ax, ay + arm);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ax, ay, R * 0.025, 0, Math.PI * 2);
      ctx.fill();
      if (this.locked) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ax, ay, R * 0.07, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  window.DartlineDartboardCanvas = DartboardCanvas;
})();
