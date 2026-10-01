// physics-view.js - Signal pipeline and frequency-response drawing for the popup's main screen.
// An illustration driven by the slider values (not a meter of the live audio). Two canvases:
//   pipeline: animated wave through In → HPF → EQ → Comp → Gain → Out
//   bode:     combined magnitude response of HPF + Bass + Mid + High + Master Volume
// Per-band bypass (stageBypass.hpf/bass/mid/high/gain, autoBalance) is reflected in both.

class PhysicsView {
  constructor({ pipelineCanvas, bodeCanvas, readoutEl, doc = document }) {
    this.doc = doc;
    this.pipelineCanvas = pipelineCanvas;
    this.bodeCanvas = bodeCanvas;
    this.readoutEl = readoutEl || null;
    this.pipelineCtx = pipelineCanvas ? pipelineCanvas.getContext('2d') : null;
    this.bodeCtx = bodeCanvas ? bodeCanvas.getContext('2d') : null;

    this.params = {
      bass: 5.0, hpf: 30, mid: 1.5, high: 2.0, gain: 1.0, pitch: 1.0, autoBalance: true,
      stageBypass: { hpf: false, bass: false, mid: false, high: false, gain: false, speed: false }
    };
    this.isCapturing = false;
    this.time = 0;
    this.frames = 0;
    this.animFrameId = null;
    this.particles = [];
    this.particleCount = 40;

    // Canvas palettes follow the popup's visual theme (body.theme-*). No class = cyan.
    this.activeTheme = 'theme-cyan';
    this.themeColors = {
      'theme-cyan': { line: '#00e5ff', glow: 'rgba(0,229,255,0.4)', p1: '#00e5ff', p2: '#ff007f', p3: '#ffe600' },
      'theme-amber': { line: '#ff9d00', glow: 'rgba(255,157,0,0.4)', p1: '#ff9d00', p2: '#ffcc00', p3: '#ff5500' },
      'theme-synthwave': { line: '#ff007f', glow: 'rgba(255,0,127,0.45)', p1: '#ff007f', p2: '#a855f7', p3: '#00e5ff' },
      'theme-matrix': { line: '#00ff66', glow: 'rgba(0,255,102,0.4)', p1: '#00ff66', p2: '#adff2f', p3: '#32cd32' },
      'theme-oled': { line: '#b388ff', glow: 'rgba(179,136,255,0.35)', p1: '#b388ff', p2: '#7c4dff', p3: '#ffffff' }
    };

    this.resize();
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
      speed: !!b.speed
    };
  }

  logicalSize(canvas) {
    return { w: canvas._logicalW || canvas.width, h: canvas._logicalH || canvas.height };
  }

  // Draw 1:1 at the canvas's CSS size (crisp on Retina). Re-seeds particles when the size changes.
  resize() {
    const win = this.doc.defaultView;
    const dpr = (win && win.devicePixelRatio) || 1;
    for (const c of [this.pipelineCanvas, this.bodeCanvas]) {
      if (!c) continue;
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || c.clientWidth || 300));
      const h = Math.max(1, Math.round(rect.height || c.clientHeight || 60));
      if (c._logicalW === w && c._logicalH === h && c._dpr === dpr) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c._logicalW = w; c._logicalH = h; c._dpr = dpr;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      if (c === this.pipelineCanvas) this.initParticles(w, h);
    }
  }

  initParticles(width, height) {
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      this.particles.push({
        x: Math.random() * width,
        baseY: height / 2,
        speed: 1.2 + Math.random() * 1.6,
        radius: 1.2 + Math.random() * 1.6,
        colorType: Math.floor(Math.random() * 3),
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  updateState(params, isCapturing) {
    if (params) this.params = { ...this.params, ...params, stageBypass: { ...(params.stageBypass || this.params.stageBypass) } };
    if (typeof isCapturing === 'boolean') this.isCapturing = isCapturing;
    this.updateReadout();
    if (!this.animFrameId) { this.resize(); this.drawPipeline(); this.drawBode(); }
  }

  updateReadout() {
    if (!this.readoutEl) return;
    const p = this.params;
    const off = this.bypassOf(p);
    const db = (v) => `${v >= 0 ? '+' : ''}${(+v).toFixed(1)}`;
    const parts = [
      `HPF ${off.hpf ? 'off' : `${Math.round(p.hpf || 30)}Hz`}`,
      `Low ${off.bass ? 'off' : db(p.bass || 0)}`,
      `Mid ${off.mid ? 'off' : db(p.mid || 0)}`,
      `Hi ${off.high ? 'off' : db(p.high || 0)}`,
      `Vol ${off.gain ? 'off' : `${Math.round((p.gain || 1) * 100)}%`}`
    ];
    this.readoutEl.textContent = parts.join(' · ');
  }

  syncTheme() {
    const body = this.doc.body;
    if (!body) return;
    let found = 'theme-cyan';
    for (const cls of body.classList) if (this.themeColors[cls]) { found = cls; break; }
    this.activeTheme = found;
  }

  start() {
    if (this.animFrameId) return;
    const render = () => {
      this.syncTheme();
      this.resize();
      this.drawPipeline();
      this.drawBode();
      this.time += 0.04 * (this.bypassOf().speed ? 1 : (this.params.pitch || 1.0));
      this.frames++;
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  stop() {
    if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
    this.animFrameId = null;
  }

  drawPipeline() {
    if (!this.pipelineCtx || !this.pipelineCanvas) return;
    const ctx = this.pipelineCtx;
    const { w, h } = this.logicalSize(this.pipelineCanvas);
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyan'];
    const p = this.params;
    const off = this.bypassOf(p);
    const ampScale = h / 220;
    const stageWidth = w / 6;
    const xScale = 620 / w;

    ctx.clearRect(0, 0, w, h);

    // Stage dividers and names
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    const names = ['In', 'HPF', 'EQ', 'Comp', 'Gain', 'Out'];
    for (let i = 0; i < 6; i++) {
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(i * stageWidth, 0); ctx.lineTo(i * stageWidth, h); ctx.stroke();
        ctx.setLineDash([]);
      }
      const stageOff = (i === 1 && off.hpf) || (i === 2 && off.bass && off.mid && off.high) || (i === 3 && off.comp) || (i === 4 && off.gain);
      ctx.fillStyle = stageOff ? '#555' : '#888';
      ctx.fillText(names[i] + (stageOff ? ' off' : ''), i * stageWidth + 4, 10);
    }

    // HPF barrier
    const hpfX = stageWidth * 1.5;
    if (!off.hpf) {
      const hpfFreq = p.hpf || 30;
      const barrierHeight = Math.min(h * 0.8, (40 + (hpfFreq / 200) * 140) * ampScale);
      ctx.fillStyle = 'rgba(255, 68, 68, 0.12)';
      ctx.fillRect(hpfX - 8, (h - barrierHeight) / 2, 16, barrierHeight);
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(hpfX, (h - barrierHeight) / 2); ctx.lineTo(hpfX, (h + barrierHeight) / 2); ctx.stroke();
    }

    // Compressor ceiling / floor
    if (!off.comp) {
      const x1 = stageWidth * 3, x2 = stageWidth * 4;
      const ceilingY = 14, floorY = h - 10;
      ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x1, ceilingY); ctx.lineTo(x2, ceilingY); ctx.moveTo(x1, floorY); ctx.lineTo(x2, floorY); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Wave: amplitude grows through the stages according to the settings
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.isCapturing ? theme.line : 'rgba(255,255,255,0.25)';
    ctx.shadowColor = this.isCapturing ? theme.glow : 'transparent';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const baselineY = h / 2;
    for (let x = 0; x < w; x += 2) {
      const stageIdx = Math.floor(x / stageWidth);
      let amp = 12;
      if (stageIdx >= 1 && !off.hpf) amp *= 0.9;
      if (stageIdx >= 2) {
        amp += (off.bass ? 0 : (p.bass || 0) * 2.2) + (off.mid ? 0 : (p.mid || 0) * 1.5) + (off.high ? 0 : (p.high || 0) * 0.6);
      }
      if (stageIdx >= 3 && !off.comp) amp = Math.min(amp, 45);
      if (stageIdx >= 4 && !off.gain) amp *= (p.gain || 1.0);
      if (stageIdx >= 5) amp *= 1.05;
      amp *= ampScale;
      const speed = off.speed ? 1 : (p.pitch || 1.0);
      const y = baselineY + Math.sin(x * 0.04 * speed * xScale - this.time * 3) * amp + Math.sin(x * 0.08 * speed * xScale - this.time * 5) * amp * 0.35;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Particles
    const speed = off.speed ? 1 : (p.pitch || 1.0);
    for (const pt of this.particles) {
      pt.x += pt.speed * speed / xScale;
      if (pt.x > w) pt.x = 0;
      const curStage = Math.floor(pt.x / stageWidth);
      let jitter = Math.sin(pt.x * 0.05 * xScale - this.time * 4 + pt.phase) * (8 + (off.bass ? 0 : (p.bass || 0)) * 2) * ampScale;
      if (!off.hpf && curStage === 1 && pt.x > hpfX - 12 && pt.x < hpfX + 4 && pt.colorType === 0) pt.x = Math.max(0, pt.x - 4);
      if (!off.comp && curStage >= 3) jitter = Math.max(-42 * ampScale, Math.min(42 * ampScale, jitter));
      ctx.beginPath();
      ctx.arc(pt.x, pt.baseY + jitter, pt.radius, 0, Math.PI * 2);
      ctx.fillStyle = pt.colorType === 0 ? theme.p1 : pt.colorType === 1 ? theme.p2 : theme.p3;
      ctx.fill();
    }
  }

  drawBode() {
    if (!this.bodeCtx || !this.bodeCanvas) return;
    const ctx = this.bodeCtx;
    const { w, h } = this.logicalSize(this.bodeCanvas);
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyan'];
    const p = this.params;
    const off = this.bypassOf(p);
    const zeroY = h / 2;
    const topPad = 6, bottomPad = 12;

    ctx.clearRect(0, 0, w, h);

    // Grid: 0 dB line and frequency markers
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
    ctx.font = '8px sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    for (const f of [20, 60, 200, 1000, 5000, 20000]) {
      const x = (Math.log10(f / 20) / Math.log10(1000)) * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}Hz`, Math.min(w - 12, Math.max(14, x)), h - 3);
    }
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

    // Fill under the curve, then the curve
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
