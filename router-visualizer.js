// router-visualizer.js - Audio Signal Path & DSP Physics Visualizer
// Animates signal flow, particles and the combined filter response curve for the current settings.
// It is an illustration driven by the slider values, not a meter of the live audio.
//
// Two layouts:
//   'side'    - a panel docked beside the controls (popup and standalone window). Both stay visible.
//   'overlay' - a drawer that slides over the content (the Document PiP window, which is too narrow).

var AudioRouterVisualizer = (typeof window !== 'undefined' && window.AudioRouterVisualizer) || class AudioRouterVisualizer {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.doc = options.doc || document;
    this.mode = options.mode === 'side' ? 'side' : 'overlay';
    this.onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
    this.isOpen = false;
    this.animFrameId = null;

    this.currentParams = {
      bass: 5.0,
      hpf: 30,
      mid: 1.5,
      high: 2.0,
      gain: 1.0,
      pitch: 1.0,
      autoBalance: true,
      stageBypass: { hpf: false, eq: false, comp: false, gain: false }
    };
    this.isCapturing = false;

    // Simulation Particle System
    this.particles = [];
    this.particleCount = 50;
    this.time = 0;

    // Canvas palettes follow the popup's visual theme (body.theme-*). No class = cyan.
    this.activeTheme = 'theme-cyan';
    this.themeColors = {
      'theme-cyan': { line: '#00e5ff', glow: 'rgba(0,229,255,0.4)', p1: '#00e5ff', p2: '#ff007f', p3: '#ffe600' },
      'theme-amber': { line: '#ff9d00', glow: 'rgba(255,157,0,0.4)', p1: '#ff9d00', p2: '#ffcc00', p3: '#ff5500' },
      'theme-synthwave': { line: '#ff007f', glow: 'rgba(255,0,127,0.45)', p1: '#ff007f', p2: '#a855f7', p3: '#00e5ff' },
      'theme-matrix': { line: '#00ff66', glow: 'rgba(0,255,102,0.4)', p1: '#00ff66', p2: '#adff2f', p3: '#32cd32' },
      'theme-oled': { line: '#b388ff', glow: 'rgba(179,136,255,0.35)', p1: '#b388ff', p2: '#7c4dff', p3: '#ffffff' }
    };

    this.initDOM();
    this.setupListeners();
    this.resizeCanvases();
  }

  initDOM() {
    const side = this.mode === 'side';

    if (!side) {
      this.overlay = this.doc.createElement('div');
      this.overlay.className = 'router-drawer-overlay';
    }

    this.drawer = this.doc.createElement('aside');
    this.drawer.id = 'physics-panel';
    this.drawer.className = side ? 'router-drawer side-panel' : 'router-drawer slide-from-left';

    this.drawer.innerHTML = `
      <div class="drawer-inner">
      <div class="drawer-header">
        <div class="drawer-title-group">
          <span class="drawer-icon">🔬</span>
          <div style="min-width:0; overflow:hidden;">
            <h3 class="drawer-title">Signal Path & Physics</h3>
            <p class="drawer-subtitle">Animated model of your settings (not a live meter)</p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 4px; flex-shrink:0;">
          <button class="btn-info-guide" id="btn-guide-toggle" title="How this visual works">ℹ️ Guide</button>
          <button class="btn-close-drawer" id="btn-close-drawer" title="Hide the Physics panel">✕</button>
        </div>
      </div>

      <div class="drawer-body">
        <!-- Animated Signal Flow Canvas -->
        <div class="drawer-section">
          <div class="pipeline-header-row">
            <span class="section-label">⚡ SIGNAL PIPELINE</span>
            <span class="physics-legend"><span class="legend-dot"></span> Animated</span>
          </div>

          <div class="canvas-wrapper">
            <canvas id="pipeline-canvas" width="620" height="220"></canvas>
          </div>

          <!-- Stage columns with A/B bypass toggles -->
          <div class="stage-labels-grid">
            <div class="stage-label-col" data-stage="source">
              <b>1. In</b>
              <span class="stage-sub">PCM</span>
              <span class="stage-fixed-badge">Fixed</span>
            </div>

            <div class="stage-label-col" data-stage="hpf">
              <b>2. HPF</b>
              <span class="stage-sub">Barrier</span>
              <button class="stage-toggle-btn active" id="toggle-stage-hpf" title="Click to toggle HPF bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="eq">
              <b>3. EQ</b>
              <span class="stage-sub">3-Band</span>
              <button class="stage-toggle-btn active" id="toggle-stage-eq" title="Click to toggle EQ bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="comp">
              <b>4. Comp</b>
              <span class="stage-sub">Leveler</span>
              <button class="stage-toggle-btn active" id="toggle-stage-comp" title="Click to toggle Compressor bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="gain">
              <b>5. Gain</b>
              <span class="stage-sub">Boost</span>
              <button class="stage-toggle-btn active" id="toggle-stage-gain" title="Click to toggle Master Boost bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="speaker">
              <b>6. Out</b>
              <span class="stage-sub">Acoustic</span>
              <span class="stage-fixed-badge">Output</span>
            </div>
          </div>
        </div>

        <!-- Frequency Response Transfer Function Curve H(f) -->
        <div class="drawer-section">
          <div class="section-label-row">
            <span class="section-label">📈 FREQUENCY RESPONSE H(f)</span>
            <span class="physics-legend"><span class="legend-dot"></span> Magnitude (dB)</span>
          </div>
          <div class="canvas-wrapper">
            <canvas id="bode-canvas" width="620" height="150"></canvas>
          </div>
          <div class="physics-readout" id="physics-readout">
            HPF: <span>30 Hz</span> | Bass: <span>+5.0 dB</span> @ 120 Hz | Mid: <span>+1.5 dB</span> | High: <span>+2.0 dB</span>
          </div>
        </div>
      </div>

      <!-- Physics guide (covers the panel while open) -->
      <div class="guide-modal" id="guide-modal">
        <div class="guide-modal-content">
          <div class="guide-modal-header">
            <h4>🔬 Physics Visualizer Guide</h4>
            <button class="btn-close-modal" id="btn-close-guide">✕</button>
          </div>
          <div class="guide-modal-body" id="guide-modal-body">
            <!-- Dynamic info content will be populated here -->
          </div>
        </div>
      </div>
      </div>
    `;

    // Inject Styles into the target document
    const style = this.doc.createElement('style');
    style.textContent = `
      /* Overlay drawer (PiP window) */
      .router-drawer-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px);
        z-index: 99990; opacity: 0; pointer-events: none; transition: opacity 0.25s ease;
      }
      .router-drawer-overlay.open {
        opacity: 1; pointer-events: auto;
      }
      .router-drawer.slide-from-left {
        position: fixed; top: 0; left: 0; bottom: 0; width: 100%; max-width: 100%;
        background: var(--bg-primary, #121216); color: var(--text-main, #fff);
        z-index: 99999; transform: translateX(-100%); transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex; flex-direction: column; box-shadow: 8px 0 32px rgba(0,0,0,0.8);
        box-sizing: border-box; overflow: hidden;
      }
      .router-drawer.slide-from-left.open {
        transform: translateX(0);
      }
      .router-drawer.slide-from-left .drawer-inner {
        display: flex; flex-direction: column; height: 100%; width: 100%; position: relative; overflow: hidden;
      }

      /* Side panel (popup and standalone window): docked beside the controls, both visible at once */
      .router-drawer.side-panel {
        position: relative; flex: 0 0 auto; width: 0; overflow: hidden;
        background: var(--bg-primary, #121216); color: var(--text-main, #fff);
        border-left: 0 solid var(--border-color, rgba(255,255,255,0.08));
        transition: width 0.25s ease, border-left-width 0.25s ease;
        box-sizing: border-box;
      }
      .router-drawer.side-panel.open {
        width: 300px; border-left-width: 1px;
      }
      .router-drawer.side-panel.no-anim {
        transition: none;
      }
      /* Fixed-width inner so the canvases have their final size even while the panel animates. */
      .router-drawer.side-panel .drawer-inner {
        position: absolute; top: 0; bottom: 0; right: 0; width: 299px;
        display: flex; flex-direction: column; overflow: hidden;
      }
      .side-panel #pipeline-canvas { height: 104px; }
      .side-panel #bode-canvas { height: 74px; }
      .side-panel .drawer-body { padding: 4px 8px 6px; gap: 4px; }
      .side-panel .drawer-header { padding: 4px 8px; }
      .side-panel .stage-label-col { min-height: 40px; padding: 2px 1px; }

      .drawer-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
        background: var(--bg-secondary, #18181f); flex-shrink: 0;
        width: 100%; box-sizing: border-box; overflow: hidden;
      }
      .drawer-title-group { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; }
      .drawer-icon { font-size: 14px; flex-shrink: 0; }
      .drawer-title { font-size: 11px; font-weight: 700; color: var(--text-main, #fff); letter-spacing: 0.3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .drawer-subtitle { font-size: 8.5px; color: var(--text-muted, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .btn-close-drawer {
        background: none; border: none; color: var(--text-muted, #888); font-size: 13px;
        cursor: pointer; padding: 2px 5px; border-radius: 4px; transition: color 0.15s;
      }
      .btn-close-drawer:hover { color: #fff; background: rgba(255,255,255,0.1); }
      .btn-info-guide {
        background: var(--accent-glow, rgba(0,229,255,0.12)); border: 1px solid var(--accent, #00e5ff);
        color: var(--accent, #00e5ff); font-size: 8.5px; font-weight: 700; padding: 2px 6px;
        border-radius: 10px; cursor: pointer; transition: all 0.15s; white-space: nowrap;
      }
      .btn-info-guide:hover { background: var(--accent, #00e5ff); color: #000; }

      .drawer-body { flex: 1; overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; width: 100%; box-sizing: border-box; }
      .drawer-section { display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; }
      .section-label { font-size: 9px; font-weight: 700; color: var(--text-muted, #888); letter-spacing: 0.8px; white-space: nowrap; }
      .section-label-row { display: flex; justify-content: space-between; align-items: center; width: 100%; }
      .pipeline-header-row {
        display: flex; justify-content: space-between; align-items: center; width: 100%; min-width: 0; overflow: hidden;
      }
      .physics-legend {
        font-size: 8px; color: var(--accent, #00e5ff); display: flex; align-items: center;
        gap: 3px; white-space: nowrap; flex-shrink: 0;
      }
      .legend-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent, #00e5ff); flex-shrink: 0; }

      /* Canvas Wrappers */
      .canvas-wrapper {
        width: 100%; border-radius: 6px; overflow: hidden; background: #0c0c10;
        border: 1px solid var(--border-color, rgba(255,255,255,0.08));
        box-shadow: inset 0 0 16px rgba(0,0,0,0.6);
        box-sizing: border-box;
      }
      .canvas-wrapper canvas { width: 100%; height: auto; display: block; }

      /* Stage Columns Grid (Strict 100% Fit) */
      .stage-labels-grid {
        display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2px;
        text-align: center; margin-top: 2px; width: 100%; max-width: 100%;
        box-sizing: border-box; overflow: hidden;
      }
      .stage-label-col {
        font-size: 8px; color: var(--text-muted, #888); line-height: 1.1;
        background: var(--bg-card, rgba(255,255,255,0.02)); padding: 3px 1px; border-radius: 4px;
        display: flex; flex-direction: column; align-items: center; justify-content: space-between;
        gap: 2px; min-height: 44px; min-width: 0; overflow: hidden; border: 1px solid transparent;
        box-sizing: border-box;
      }
      .stage-label-col b { color: var(--text-main, #fff); font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .stage-sub { font-size: 7px; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .stage-fixed-badge {
        font-size: 7px; color: #666; padding: 1px 2px; border-radius: 4px;
        background: rgba(255,255,255,0.04); white-space: nowrap;
      }
      .stage-toggle-btn {
        font-size: 7px; font-weight: 700; padding: 1px 3px; border-radius: 6px;
        cursor: pointer; border: 1px solid transparent; transition: all 0.15s; white-space: nowrap;
      }
      .stage-toggle-btn.active {
        background: var(--accent-glow, rgba(0,229,255,0.15));
        color: var(--accent, #00e5ff); border-color: var(--accent, #00e5ff);
      }
      .stage-toggle-btn.bypassed {
        background: rgba(255,255,255,0.05); color: #888; border-color: #555;
      }

      .physics-readout {
        font-size: 8.5px; color: var(--text-muted, #888); text-align: center;
        background: var(--bg-card, rgba(255,255,255,0.02)); padding: 4px; border-radius: 4px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; box-sizing: border-box;
      }
      .physics-readout span { color: var(--accent, #00e5ff); font-weight: 600; }

      /* Guide Modal */
      .guide-modal {
        position: absolute; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(6px);
        z-index: 100005; display: none; padding: 10px;
      }
      .guide-modal.open { display: flex; align-items: center; justify-content: center; }
      .guide-modal-content {
        background: var(--bg-secondary, #181820); border: 1px solid var(--border-color, rgba(255,255,255,0.15));
        border-radius: 8px; max-height: 92%; width: 100%; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.8); overflow: hidden;
      }
      .guide-modal-header {
        display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
        border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
        background: rgba(255,255,255,0.02);
      }
      .guide-modal-header h4 { font-size: 11px; color: var(--accent, #00e5ff); font-weight: 700; margin: 0; }
      .btn-close-modal {
        background: none; border: none; color: #888; font-size: 13px; cursor: pointer;
      }
      .btn-close-modal:hover { color: #fff; }
      .guide-modal-body {
        padding: 10px; overflow-y: auto; font-size: 9.5px; line-height: 1.5; color: #ccc;
        display: flex; flex-direction: column; gap: 7px;
      }
      .guide-card {
        background: var(--bg-card, rgba(255,255,255,0.03)); border: 1px solid var(--border-color, rgba(255,255,255,0.06));
        border-radius: 5px; padding: 7px 9px;
      }
      .guide-card h5 { font-size: 10px; color: #fff; margin-bottom: 2px; font-weight: 700; }
      .guide-card p { font-size: 9px; color: #aaa; margin: 0; }
      .guide-highlight { color: var(--accent, #00e5ff); font-weight: 600; }
    `;
    this.doc.head.appendChild(style);

    if (this.overlay) this.container.appendChild(this.overlay);
    this.container.appendChild(this.drawer);

    this.pipelineCanvas = this.drawer.querySelector('#pipeline-canvas');
    this.pipelineCtx = this.pipelineCanvas ? this.pipelineCanvas.getContext('2d') : null;

    this.bodeCanvas = this.drawer.querySelector('#bode-canvas');
    this.bodeCtx = this.bodeCanvas ? this.bodeCanvas.getContext('2d') : null;

    this.readoutEl = this.drawer.querySelector('#physics-readout');
    this.guideModal = this.drawer.querySelector('#guide-modal');
    this.guideModalBody = this.drawer.querySelector('#guide-modal-body');
  }

  // Logical (CSS px) drawing size of a canvas. Overlay mode draws at the intrinsic 620-wide
  // bitmap and lets CSS scale it; side mode draws 1:1 at the panel's size (crisp on Retina).
  logicalSize(canvas) {
    return { w: canvas._logicalW || canvas.width, h: canvas._logicalH || canvas.height };
  }

  resizeCanvases() {
    const win = this.doc.defaultView;
    const dpr = (win && win.devicePixelRatio) || 1;
    for (const c of [this.pipelineCanvas, this.bodeCanvas]) {
      if (!c) continue;
      if (this.mode !== 'side') {
        if (c === this.pipelineCanvas && this.particles.length === 0) this.initParticles(c.width, c.height);
        continue;
      }
      const rect = c.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || (c === this.pipelineCanvas ? 283 : 283)));
      const h = Math.max(1, Math.round(rect.height || (c === this.pipelineCanvas ? 104 : 74)));
      if (c._logicalW === w && c._logicalH === h && c._dpr === dpr) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c._logicalW = w; c._logicalH = h; c._dpr = dpr;
      c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      if (c === this.pipelineCanvas) this.initParticles(w, h);
    }
  }

  initParticles(width = 620, height = 220) {
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      this.particles.push({
        x: Math.random() * width,
        y: height / 2 + (Math.random() - 0.5) * 40,
        baseY: height / 2,
        speed: 1.8 + Math.random() * 2.2,
        radius: 1.5 + Math.random() * 2.2,
        stage: 1,
        colorType: Math.floor(Math.random() * 3),
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  setupListeners() {
    const btnClose = this.drawer.querySelector('#btn-close-drawer');
    if (btnClose) btnClose.onclick = () => this.close();
    if (this.overlay) this.overlay.onclick = () => this.close();

    // Stage bypass toggles
    this.setupStageBypass('toggle-stage-hpf', 'hpf');
    this.setupStageBypass('toggle-stage-eq', 'eq');
    this.setupStageBypass('toggle-stage-comp', 'comp');
    this.setupStageBypass('toggle-stage-gain', 'gain');

    // Guide Modal
    const btnGuide = this.drawer.querySelector('#btn-guide-toggle');
    const btnCloseGuide = this.drawer.querySelector('#btn-close-guide');
    if (btnGuide) btnGuide.onclick = () => this.openGuide();
    if (btnCloseGuide) btnCloseGuide.onclick = () => this.closeGuide();
  }

  setupStageBypass(btnId, stageKey) {
    const btn = this.drawer.querySelector(`#${btnId}`);
    if (!btn) return;
    btn.onclick = () => {
      if (!this.currentParams.stageBypass) {
        this.currentParams.stageBypass = { hpf: false, eq: false, comp: false, gain: false };
      }
      const isBypassed = !this.currentParams.stageBypass[stageKey];
      this.currentParams.stageBypass[stageKey] = isBypassed;

      if (isBypassed) {
        btn.className = 'stage-toggle-btn bypassed';
        btn.textContent = '○ BYPASS';
        btn.title = `Stage bypassed. Click to enable.`;
      } else {
        btn.className = 'stage-toggle-btn active';
        btn.textContent = '● ON';
        btn.title = `Stage active. Click to bypass for A/B testing.`;
      }

      // Dispatch to audio engine
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'UPDATE_AUDIO_PARAMS',
          params: this.currentParams
        });
      }
    };
  }

  openGuide() {
    if (!this.guideModal || !this.guideModalBody) return;

    this.guideModalBody.innerHTML = `
      <div class="guide-card">
        <h5>What this shows</h5>
        <p>An animated model built from your slider values: the wave and dots react to the settings, not to the music itself. Use it to see which stage does what, and to A/B each stage with the <span class="guide-highlight">● ON / ○ BYPASS</span> buttons.</p>
      </div>

      <div class="guide-card">
        <h5>🌊 Why the Wave Grows (Stage 3 Superposition)</h5>
        <p>The drawn signal is a sum of sine waves:
        <span class="guide-highlight">y(x, t) = A_bass·sin(ω₁x - t) + A_mid·sin(ω₂x - t) + A_high·sin(ω₃x - t)</span>.<br>
        Raising <b>Bass</b> (+5 dB to +14 dB) or <b>Mid</b> increases the amplitude, so the wave expands vertically, the way more voltage moves a speaker cone further.</p>
      </div>

      <div class="guide-card">
        <h5>🛡️ Stage 2: HPF (High Pass Filter) Barrier</h5>
        <p>Sub-bass below the cutoff (default <span class="guide-highlight">30 Hz</span>) is mostly inaudible rumble that wastes amplifier power and pushes drivers into distortion. The barrier reflects those low-frequency packets and lets clean, punchy bass through.</p>
      </div>

      <div class="guide-card">
        <h5>✨ Moving Dots (Audio Energy Packets)</h5>
        <p>The dots stand for audio sample buffers moving through the DSP chain. Their vertical jitter grows with bass energy and their speed follows Pitch / Speed.</p>
      </div>

      <div class="guide-card">
        <h5>⚖️ Stage 4: Dynamics Compressor Ceiling</h5>
        <p>The dashed lines mark the Auto-Balancing ceiling and floor. Peaks are clamped so heavy bass boosts stay balanced, and quieter passages are lifted.</p>
      </div>

      <div class="guide-card">
        <h5>📈 Frequency Response H(f)</h5>
        <p>The curve combines HPF, Bass, Mid, High and Master Volume into one magnitude plot (±24 dB) from 20 Hz to 20 kHz.</p>
      </div>
    `;

    this.guideModal.classList.add('open');
  }

  closeGuide() {
    if (this.guideModal) this.guideModal.classList.remove('open');
  }

  updateState(params, isCapturing) {
    if (params) {
      this.currentParams = { ...this.currentParams, ...params };
      if (!this.currentParams.stageBypass) {
        this.currentParams.stageBypass = { hpf: false, eq: false, comp: false, gain: false };
      }
    }
    if (typeof isCapturing === 'boolean') {
      this.isCapturing = isCapturing;
    }
    this.syncStageButtons();
    this.updateReadout();
  }

  // Reflect saved A/B bypass state on the stage buttons (e.g. when the popup is reopened).
  syncStageButtons() {
    if (!this.drawer) return;
    const bypass = this.currentParams.stageBypass || {};
    [['toggle-stage-hpf', 'hpf'], ['toggle-stage-eq', 'eq'], ['toggle-stage-comp', 'comp'], ['toggle-stage-gain', 'gain']]
      .forEach(([btnId, key]) => {
        const btn = this.drawer.querySelector(`#${btnId}`);
        if (!btn) return;
        if (bypass[key]) {
          btn.className = 'stage-toggle-btn bypassed';
          btn.textContent = '○ BYPASS';
          btn.title = 'Stage bypassed. Click to enable.';
        } else {
          btn.className = 'stage-toggle-btn active';
          btn.textContent = '● ON';
          btn.title = 'Stage active. Click to bypass for A/B testing.';
        }
      });
  }

  updateReadout() {
    if (!this.readoutEl) return;
    const p = this.currentParams;
    const bypass = p.stageBypass || {};
    const hpfStr = bypass.hpf ? '<span style="color:#777">Bypassed</span>' : `<span>${Math.round(p.hpf || 30)} Hz</span>`;
    const bassStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>+${parseFloat(p.bass || 0).toFixed(1)} dB</span>`;
    const midStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>${(p.mid >= 0 ? '+' : '') + parseFloat(p.mid || 0).toFixed(1)} dB</span>`;
    const highStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>${(p.high >= 0 ? '+' : '') + parseFloat(p.high || 0).toFixed(1)} dB</span>`;

    this.readoutEl.innerHTML = `HPF: ${hpfStr} | Bass: ${bassStr} @ 120 Hz | Mid: ${midStr} | High: ${highStr}`;
  }

  // Pick the canvas palette from the document's theme class.
  syncTheme() {
    const body = this.doc.body;
    if (!body) return;
    let found = 'theme-cyan';
    for (const cls of body.classList) {
      if (this.themeColors[cls]) { found = cls; break; }
    }
    this.activeTheme = found;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open(opts = {}) {
    this.isOpen = true;
    const instant = !!opts.instant && this.mode === 'side';
    if (instant) {
      this.drawer.classList.add('no-anim');
      void this.drawer.offsetWidth; // apply "no transition" before the width changes
    }
    if (this.overlay) this.overlay.classList.add('open');
    this.drawer.classList.add('open');
    if (instant) {
      void this.drawer.offsetWidth;
      this.drawer.classList.remove('no-anim');
    }
    this.resizeCanvases();
    this.startAnimation();
    if (this.onToggle) this.onToggle(true);
  }

  close() {
    this.isOpen = false;
    if (this.overlay) this.overlay.classList.remove('open');
    this.drawer.classList.remove('open');
    this.closeGuide();
    this.stopAnimation();
    if (this.onToggle) this.onToggle(false);
  }

  startAnimation() {
    if (this.animFrameId) return;
    const render = () => {
      this.syncTheme();
      this.drawPipeline();
      this.drawBode();
      this.time += 0.04 * (this.currentParams.pitch || 1.0);
      this.animFrameId = requestAnimationFrame(render);
    };
    this.animFrameId = requestAnimationFrame(render);
  }

  stopAnimation() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  drawPipeline() {
    if (!this.pipelineCtx || !this.pipelineCanvas) return;
    const ctx = this.pipelineCtx;
    const { w, h } = this.logicalSize(this.pipelineCanvas);
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyan'];
    const compact = w < 400; // side panel: smaller margins and labels

    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 30) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const stageWidth = w / 6;
    const p = this.currentParams;
    const bypass = p.stageBypass || {};
    const ampScale = h / 220; // the wave was designed for a 220px-tall canvas

    // 1. Stage Divider Lines
    for (let i = 1; i < 6; i++) {
      const sx = i * stageWidth;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 2. Stage 2: HPF Barrier Wall Visualization
    const hpfX = stageWidth * 1.5;
    const hpfActive = !bypass.hpf;
    const hpfFreq = p.hpf || 30;
    const barrierHeight = hpfActive ? Math.min(h * 0.82, (40 + (hpfFreq / 200) * 140) * ampScale) : 0;

    if (hpfActive) {
      ctx.fillStyle = 'rgba(255, 68, 68, 0.12)';
      ctx.fillRect(hpfX - 10, (h - barrierHeight) / 2, 20, barrierHeight);
      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hpfX, (h - barrierHeight) / 2);
      ctx.lineTo(hpfX, (h + barrierHeight) / 2);
      ctx.stroke();

      ctx.fillStyle = '#ff4444';
      ctx.font = `${compact ? 7.5 : 8.5}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`< ${Math.round(hpfFreq)}Hz`, hpfX, h - 5);
    }

    // 3. Stage 4: Compressor Ceiling / Floor Lines
    const compActive = !bypass.comp && p.autoBalance;
    if (compActive) {
      const compX1 = stageWidth * 3;
      const compX2 = stageWidth * 4;
      const ceilingY = 35 * ampScale;
      const floorY = h - 35 * ampScale;

      ctx.strokeStyle = 'rgba(255, 170, 0, 0.5)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.moveTo(compX1, ceilingY);
      ctx.lineTo(compX2, ceilingY);
      ctx.moveTo(compX1, floorY);
      ctx.lineTo(compX2, floorY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffaa00';
      ctx.font = `${compact ? 7 : 8}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('Ceiling', (compX1 + compX2) / 2, ceilingY - 3);
      ctx.fillText('Floor', (compX1 + compX2) / 2, floorY + 9);
    }

    // 4. Cumulative Waveform Math (Left to Right)
    ctx.lineWidth = compact ? 2 : 2.5;
    ctx.strokeStyle = this.isCapturing ? theme.line : 'rgba(255,255,255,0.2)';
    ctx.shadowColor = this.isCapturing ? theme.glow : 'transparent';
    ctx.shadowBlur = 10;
    ctx.beginPath();

    const baselineY = h / 2;
    const xScale = 620 / w; // keep the same number of wave cycles across the canvas at any width

    for (let x = 0; x < w; x += 2) {
      const stageIdx = Math.floor(x / stageWidth);
      let amp = 12; // Base PCM amplitude

      // Stage 2: HPF cleans the deep sub-bass wobble
      if (stageIdx >= 1) {
        if (!bypass.hpf) {
          amp *= 0.9;
        }
      }

      // Stage 3: EQ increases amplitude vertically based on dB boost
      if (stageIdx >= 2) {
        if (!bypass.eq) {
          const bassBoost = (p.bass || 0) * 2.2;
          const midBoost = (p.mid || 0) * 1.5;
          amp += (bassBoost + midBoost);
        }
      }

      // Stage 4: Compressor clamps dynamic range
      if (stageIdx >= 3) {
        if (!bypass.comp && p.autoBalance) {
          amp = Math.min(amp, 45); // Clamp ceiling
        }
      }

      // Stage 5: Master Volume Gain & Pitch
      if (stageIdx >= 4) {
        if (!bypass.gain) {
          amp *= (p.gain || 1.0);
        }
      }

      // Stage 6: Speaker Output Wavefront
      if (stageIdx >= 5) {
        amp *= 1.05;
      }

      amp *= ampScale;

      // Superposition Formula: y(x, t) = A * [sin(w1*x - t) + 0.4*sin(w2*x - t)]
      const freq1 = 0.04 * (p.pitch || 1.0) * xScale;
      const freq2 = 0.08 * (p.pitch || 1.0) * xScale;
      const y = baselineY +
        Math.sin(x * freq1 - this.time * 3) * amp +
        Math.sin(x * freq2 - this.time * 5) * (amp * 0.35);

      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 5. Signal Particles Simulation
    this.particles.forEach(pt => {
      pt.x += pt.speed * (p.pitch || 1.0) / xScale;
      if (pt.x > w) {
        pt.x = 0;
        pt.y = pt.baseY + (Math.random() - 0.5) * 30 * ampScale;
      }

      const curStage = Math.floor(pt.x / stageWidth);
      let yJitter = Math.sin(pt.x * 0.05 * xScale - this.time * 4 + pt.phase) * (8 + (p.bass || 0) * 2) * ampScale;

      // HPF collision reflection for sub-bass particles
      if (!bypass.hpf && curStage === 1 && pt.x > hpfX - 15 && pt.x < hpfX + 5 && pt.colorType === 0) {
        pt.x = Math.max(0, pt.x - 4); // Reflect backward
      }

      // Comp clamp
      if (!bypass.comp && p.autoBalance && curStage >= 3) {
        yJitter = Math.max(-42 * ampScale, Math.min(42 * ampScale, yJitter));
      }

      const renderY = pt.baseY + yJitter;

      ctx.beginPath();
      ctx.arc(pt.x, renderY, pt.radius * (compact ? 0.8 : 1), 0, Math.PI * 2);

      if (pt.colorType === 0) ctx.fillStyle = theme.p1;
      else if (pt.colorType === 1) ctx.fillStyle = theme.p2;
      else ctx.fillStyle = theme.p3;

      ctx.fill();
    });
  }

  drawBode() {
    if (!this.bodeCtx || !this.bodeCanvas) return;
    const ctx = this.bodeCtx;
    const { w, h } = this.logicalSize(this.bodeCanvas);
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyan'];
    const compact = w < 400;

    ctx.clearRect(0, 0, w, h);

    const p = this.currentParams;
    const bypass = p.stageBypass || {};

    // Zero dB center line
    const zeroY = h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();

    // Frequency markers
    const freqs = [20, 60, 200, 1000, 5000, 20000];
    ctx.font = `${compact ? 7 : 8}px sans-serif`;
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';

    freqs.forEach(f => {
      const x = (Math.log10(f / 20) / Math.log10(20000 / 20)) * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      const label = f >= 1000 ? `${f / 1000}k` : `${f}Hz`;
      const tx = Math.min(w - 10, Math.max(10, x));
      ctx.fillText(label, tx, h - 3);
    });

    // Plot Frequency Response Transfer Function |H(f)| (in dB)
    ctx.beginPath();
    ctx.lineWidth = compact ? 2 : 2.5;
    ctx.strokeStyle = theme.line;
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 8;

    const topPad = 6;
    const bottomPad = 12;

    for (let px = 0; px < w; px += 2) {
      const f = 20 * Math.pow(1000, px / w);
      let totalDb = 0;

      // 1. HPF (High-Pass Filter 2nd order Butterworth)
      if (!bypass.hpf) {
        const fc = p.hpf || 30;
        const hpfMag = Math.pow(f / fc, 2) / Math.sqrt(1 + Math.pow(f / fc, 4));
        totalDb += 20 * Math.log10(Math.max(0.001, hpfMag));
      }

      // 2. Bass Boost (low-shelf; drawn as a bump centred near the shelf corner)
      if (!bypass.eq) {
        const bassGain = p.bass || 0;
        const fb = 65;
        const q = 0.9;
        const bassResponse = bassGain / (1 + Math.pow((f - fb) / (fb / q), 2));
        totalDb += bassResponse;

        // 3. Mid (Peaking @ 1000Hz)
        const midGain = p.mid || 0;
        const fm = 1000;
        const midResponse = midGain / (1 + Math.pow((f - fm) / (fm / 0.8), 2));
        totalDb += midResponse;

        // 4. High (High Shelf @ 8000Hz)
        const highGain = p.high || 0;
        const fh = 8000;
        const highResponse = highGain / (1 + Math.pow(fh / f, 2));
        totalDb += highResponse;
      }

      // 5. Master Gain
      if (!bypass.gain) {
        const gainDb = 20 * Math.log10(Math.max(0.1, p.gain || 1.0));
        totalDb += gainDb;
      }

      // Scale dB to Canvas Y (±24 dB range)
      const y = zeroY - (totalDb / 24) * (h / 2 - bottomPad);
      const clampedY = Math.max(topPad, Math.min(h - bottomPad, y));

      if (px === 0) ctx.moveTo(px, clampedY);
      else ctx.lineTo(px, clampedY);
    }

    ctx.stroke();
    ctx.shadowBlur = 0;
  }
};

// Attach globally
if (typeof window !== 'undefined') {
  window.AudioRouterVisualizer = AudioRouterVisualizer;
}
