// physics-view.js - The two drawings on the main screen.
//   live:  the real spectrum of the audio while the EQ is on. Grey = what the tab sends (before the
//          chain), colour = what you hear (after the output ceiling). Still and flat when the EQ is off.
//   bode:  the combined magnitude response of HPF + Bass + Mid + High + Master Volume from the
//          current settings (a picture of the settings, not a measurement).
// Both use the same log frequency axis, 20 Hz .. 20 kHz.

class PhysicsView {
  constructor({ liveCanvas, bodeCanvas, readoutEl, doc = document }) {
    this.doc = doc;
    this.liveCanvas = liveCanvas;
    this.bodeCanvas = bodeCanvas;
    this.readoutEl = readoutEl || null;
    this.liveCtx = liveCanvas ? liveCanvas.getContext('2d') : null;
    this.bodeCtx = bodeCanvas ? bodeCanvas.getContext('2d') : null;

    this.params = {
      bass: 5.0, hpf: 30, mid: 1.5, high: 2.0, gain: 1.0, semitones: 0, autoBalance: true,
      stageBypass: { hpf: false, bass: false, mid: false, high: false, gain: false, pitch: false }
    };
    this.isCapturing = false;
    this.frame = null;      // latest { input: dB[72], output: dB[72] } or null when nothing is processed
    this.frames = 0;        // draws of a live frame (used by the test harness)
    this.animFrameId = null;

    // Colours follow the popup's visual theme (body.theme-*). No class = cyan.
    this.activeTheme = 'theme-cyan';
    this.themeColors = {
      'theme-cyan': { line: '#00e5ff', glow: 'rgba(0,229,255,0.4)' },
      'theme-amber': { line: '#ff9d00', glow: 'rgba(255,157,0,0.4)' },
      'theme-synthwave': { line: '#ff007f', glow: 'rgba(255,0,127,0.45)' },
      'theme-matrix': { line: '#00ff66', glow: 'rgba(0,255,102,0.4)' },
      'theme-oled': { line: '#b388ff', glow: 'rgba(179,136,255,0.35)' }
    };

    this.resize();
    this.drawIdle();
    this.drawBode();
  }

  // Which bands are off. Accepts the legacy `eq` flag (whole 3-band EQ) from older saved presets.
  bypassOf(p = this.params) {
    const b = p.stageBypass || {};
    return {
      hpf: !!b.hpf,
      bass: !!(b.bass || b.eq),
      mid: !!(b.mid || b.eq),
      high: !!(b.high || b.eq),
      comp: !p.autoBalance || !!b.comp,
      gain: !!b.gain,
      pitch: !!(b.pitch || b.speed)
    };
  }

  logicalSize(canvas) {
    return { w: canvas._logicalW || canvas.width, h: canvas._logicalH || canvas.height };
  }

  // Draw 1:1 at the canvas's CSS size (crisp on Retina).
  resize() {
    const win = this.doc.defaultView;
    const dpr = (win && win.devicePixelRatio) || 1;
    for (const c of [this.liveCanvas, this.bodeCanvas]) {
      if (!c) continue;
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || c.clientWidth || 300));
      const h = Math.max(1, Math.round(rect.height || c.clientHeight || 50));
      if (c._logicalW === w && c._logicalH === h && c._dpr === dpr) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c._logicalW = w; c._logicalH = h; c._dpr = dpr;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  updateState(params, isCapturing) {
    if (params) this.params = { ...this.params, ...params, stageBypass: { ...(params.stageBypass || this.params.stageBypass) } };
    if (typeof isCapturing === 'boolean') this.isCapturing = isCapturing;
    this.syncTheme();
    this.resize();
    this.updateReadout();
    this.drawBode();
    if (!this.frame) this.drawIdle();
  }

  // A new live frame (or null when nothing is being processed). Frames arrive ~15 times a second.
  setFrame(frame) {
    const had = !!this.frame;
    this.frame = frame && frame.input && frame.output ? frame : null;
    if (this.frame) {
      if (!this.animFrameId) this.animFrameId = requestAnimationFrame(() => this.renderLive());
    } else if (had || this.animFrameId) {
      if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
      this.drawIdle();
    }
  }

  renderLive() {
    this.animFrameId = null;
    if (!this.frame) { this.drawIdle(); return; }
    this.syncTheme();
    this.resize();
    this.drawLive(this.frame);
    this.frames++;
  }

  updateReadout() {
    if (!this.readoutEl) return;
    const p = this.params;
    const off = this.bypassOf(p);
    const db = (v) => `${v >= 0 ? '+' : ''}${(+v).toFixed(1)}`;
    this.readoutEl.textContent = [
      `HPF ${off.hpf ? 'off' : `${Math.round(p.hpf || 30)}Hz`}`,
      `Low ${off.bass ? 'off' : db(p.bass || 0)}`,
      `Mid ${off.mid ? 'off' : db(p.mid || 0)}`,
      `Hi ${off.high ? 'off' : db(p.high || 0)}`,
      `Vol ${off.gain ? 'off' : `${Math.round((p.gain || 1) * 100)}%`}`
    ].join(' · ');
  }

  syncTheme() {
    const body = this.doc.body;
    if (!body) return;
    let found = 'theme-cyan';
    for (const cls of body.classList) if (this.themeColors[cls]) { found = cls; break; }
    this.activeTheme = found;
  }

  theme() {
    return this.themeColors[this.activeTheme] || this.themeColors['theme-cyan'];
  }

  // x position of a frequency on the shared log axis
  xOf(f, w) {
    return (Math.log10(f / 20) / 3) * w;
  }

  drawAxis(ctx, w, h, withLabels) {
    for (const f of [20, 60, 200, 1000, 5000, 20000]) {
      const x = this.xOf(f, w);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      if (withLabels) {
        ctx.font = '8px sans-serif';
        ctx.fillStyle = '#666';
        ctx.textAlign = 'center';
        ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}Hz`, Math.min(w - 12, Math.max(14, x)), h - 3);
      }
    }
  }

  // ---- live spectrum ----
  drawIdle() {
    if (!this.liveCtx || !this.liveCanvas) return;
    const ctx = this.liveCtx;
    const { w, h } = this.logicalSize(this.liveCanvas);
    ctx.clearRect(0, 0, w, h);
    this.drawAxis(ctx, w, h, false);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h - 8); ctx.lineTo(w, h - 8); ctx.stroke();
    ctx.font = '9px sans-serif';
    ctx.fillStyle = '#6a6a76';
    ctx.textAlign = 'center';
    ctx.fillText(this.isCapturing ? 'waiting for audio…' : 'LIVE · EQ is off, nothing is being processed', w / 2, h / 2 + 3);
  }

  drawLive(frame) {
    if (!this.liveCtx || !this.liveCanvas) return;
    const ctx = this.liveCtx;
    const { w, h } = this.logicalSize(this.liveCanvas);
    const theme = this.theme();
    const n = frame.input.length;
    const top = 4, bottom = h - 8;
    const DB_MIN = -95, DB_MAX = -10; // 0 dB = full-scale sine
    const yOf = (db) => bottom - (Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN) * (bottom - top);
    const xOfIdx = (i) => (i + 0.5) / n * w;

    ctx.clearRect(0, 0, w, h);
    this.drawAxis(ctx, w, h, false);

    const area = (arr, fill, line, width) => {
      ctx.beginPath();
      ctx.moveTo(0, bottom);
      for (let i = 0; i < n; i++) ctx.lineTo(xOfIdx(i), yOf(arr[i]));
      ctx.lineTo(w, bottom);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < n; i++) (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, xOfIdx(i), yOf(arr[i]));
      ctx.strokeStyle = line;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    // What the tab sends (grey), then what you hear (theme colour)
    area(frame.input, 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0.35)', 1);
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 6;
    area(frame.output, theme.glow.replace(/[\d.]+\)$/, '0.18)'), theme.line, 1.6);
    ctx.shadowBlur = 0;

    // Legend
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#8a8a96';
    ctx.fillText('LIVE  in', 4, 10);
    ctx.fillStyle = theme.line;
    ctx.fillText('out', 42, 10);
  }

  // ---- settings response ----
  drawBode() {
    if (!this.bodeCtx || !this.bodeCanvas) return;
    const ctx = this.bodeCtx;
    const { w, h } = this.logicalSize(this.bodeCanvas);
    const theme = this.theme();
    const p = this.params;
    const off = this.bypassOf(p);
    const zeroY = h / 2 - 2;
    const topPad = 4, bottomPad = 11;

    ctx.clearRect(0, 0, w, h);
    this.drawAxis(ctx, w, h, true);

    // 0 dB line
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#555';
    ctx.fillText('0 dB', 3, zeroY - 3);

    // |H(f)| in dB, ±24 dB visible
    const pts = [];
    for (let px = 0; px <= w; px += 2) {
      const f = 20 * Math.pow(1000, px / w);
      let totalDb = 0;
      if (!off.hpf) {
        const fc = p.hpf || 30;
        const mag = Math.pow(f / fc, 2) / Math.sqrt(1 + Math.pow(f / fc, 4));
        totalDb += 20 * Math.log10(Math.max(0.001, mag));
      }
      if (!off.bass) totalDb += (p.bass || 0) / (1 + Math.pow((f - 65) / (65 / 0.9), 2));
      if (!off.mid) totalDb += (p.mid || 0) / (1 + Math.pow((f - 1000) / (1000 / 0.8), 2));
      if (!off.high) totalDb += (p.high || 0) / (1 + Math.pow(8000 / f, 2));
      if (!off.gain) totalDb += 20 * Math.log10(Math.max(0.1, p.gain || 1.0));
      const y = zeroY - (totalDb / 24) * (h / 2 - bottomPad);
      pts.push([px, Math.max(topPad, Math.min(h - bottomPad, y))]);
    }

    ctx.beginPath();
    ctx.moveTo(pts[0][0], zeroY);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(pts[pts.length - 1][0], zeroY);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, theme.glow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = theme.line;
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 6;
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

if (typeof window !== 'undefined') window.PhysicsView = PhysicsView;
