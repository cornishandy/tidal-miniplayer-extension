// router-visualizer.js - Audio Signal Path & Dynamic DSP Physics Visualizer
// Animates audio flow, particles, biquad filter transfer curves, and cumulative waveform mechanics.

var AudioRouterVisualizer = (typeof window !== 'undefined' && window.AudioRouterVisualizer) || class AudioRouterVisualizer {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.doc = options.doc || document;
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

    // Active color scheme
    this.activeTheme = 'theme-cyber';
    this.themeColors = {
      'theme-cyber': { line: '#00e5ff', glow: 'rgba(0,229,255,0.4)', p1: '#00e5ff', p2: '#ff007f', p3: '#ffe600' },
      'theme-amber': { line: '#ff9d00', glow: 'rgba(255,157,0,0.4)', p1: '#ff9d00', p2: '#ffcc00', p3: '#ff5500' },
      'theme-synthwave': { line: '#ff007f', glow: 'rgba(255,0,127,0.45)', p1: '#ff007f', p2: '#a855f7', p3: '#00e5ff' },
      'theme-matrix': { line: '#00ff66', glow: 'rgba(0,255,102,0.4)', p1: '#00ff66', p2: '#adff2f', p3: '#32cd32' },
      'theme-oled': { line: '#b388ff', glow: 'rgba(179,136,255,0.35)', p1: '#b388ff', p2: '#7c4dff', p3: '#ffffff' }
    };

    this.initDOM();
    this.initParticles();
    this.setupListeners();
  }

  initDOM() {
    // Drawer Overlay
    this.overlay = this.doc.createElement('div');
    this.overlay.className = 'router-drawer-overlay';

    // Slide-out Drawer Panel
    this.drawer = this.doc.createElement('div');
    this.drawer.className = 'router-drawer slide-from-left';

    this.drawer.innerHTML = `
      <div class="drawer-header">
        <div class="drawer-title-group">
          <span class="drawer-icon">🔬</span>
          <div style="min-width:0; overflow:hidden;">
            <h3 class="drawer-title">Audio Signal Path & Physics</h3>
            <p class="drawer-subtitle">Dynamic DSP signal flow & biquad physics</p>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 4px; flex-shrink:0;">
          <button class="btn-info-guide" id="btn-guide-toggle" title="How This Visual Works & Physics Guide">ℹ️ Guide</button>
          <button class="btn-close-drawer" id="btn-close-drawer" title="Close Physics Drawer">✕</button>
        </div>
      </div>

      <div class="drawer-body">
        <!-- Visual Theme Selector -->
        <div class="drawer-section">
          <div class="section-label">🎨 VISUAL THEME</div>
          <div class="theme-pills">
            <button class="theme-pill active" data-theme="theme-cyber">
              <span class="theme-dot" style="background:#00e5ff;"></span> Cyber Neon
            </button>
            <button class="theme-pill" data-theme="theme-amber">
              <span class="theme-dot" style="background:#ff9d00;"></span> Technics 1200
            </button>
            <button class="theme-pill" data-theme="theme-synthwave">
              <span class="theme-dot" style="background:#ff007f;"></span> Synthwave 80s
            </button>
            <button class="theme-pill" data-theme="theme-matrix">
              <span class="theme-dot" style="background:#00ff66;"></span> Matrix Terminal
            </button>
            <button class="theme-pill" data-theme="theme-oled">
              <span class="theme-dot" style="background:#b388ff;"></span> Midnight OLED
            </button>
          </div>
        </div>

        <!-- Dynamic Animated Signal Flow Canvas -->
        <div class="drawer-section">
          <div class="pipeline-header-row">
            <span class="section-label">⚡ LIVE SIGNAL PIPELINE</span>
            <span class="physics-legend"><span class="legend-dot"></span> 60 FPS Real-Time Physics</span>
          </div>

          <div class="canvas-wrapper">
            <canvas id="pipeline-canvas" width="620" height="220"></canvas>
          </div>

          <!-- Interactive Stage Columns with Bypass Toggles & Info -->
          <div class="stage-labels-grid">
            <div class="stage-label-col" data-stage="source">
              <div class="stage-col-header">
                <b>1. In</b>
                <button class="stage-info-btn" data-stage-info="1" title="Stage 1 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">PCM</span>
              <span class="stage-fixed-badge">Fixed</span>
            </div>

            <div class="stage-label-col" data-stage="hpf">
              <div class="stage-col-header">
                <b>2. HPF</b>
                <button class="stage-info-btn" data-stage-info="2" title="Stage 2 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">Barrier</span>
              <button class="stage-toggle-btn active" id="toggle-stage-hpf" title="Click to toggle HPF bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="eq">
              <div class="stage-col-header">
                <b>3. EQ</b>
                <button class="stage-info-btn" data-stage-info="3" title="Stage 3 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">3-Band</span>
              <button class="stage-toggle-btn active" id="toggle-stage-eq" title="Click to toggle EQ bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="comp">
              <div class="stage-col-header">
                <b>4. Comp</b>
                <button class="stage-info-btn" data-stage-info="4" title="Stage 4 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">Leveler</span>
              <button class="stage-toggle-btn active" id="toggle-stage-comp" title="Click to toggle Compressor bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="gain">
              <div class="stage-col-header">
                <b>5. Gain</b>
                <button class="stage-info-btn" data-stage-info="5" title="Stage 5 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">Boost</span>
              <button class="stage-toggle-btn active" id="toggle-stage-gain" title="Click to toggle Master Boost bypass (A/B test)">● ON</button>
            </div>

            <div class="stage-label-col" data-stage="speaker">
              <div class="stage-col-header">
                <b>6. Out</b>
                <button class="stage-info-btn" data-stage-info="6" title="Stage 6 Specs">ℹ️</button>
              </div>
              <span class="stage-sub">Acoustic</span>
              <span class="stage-fixed-badge">Output</span>
            </div>
          </div>
        </div>

        <!-- Frequency Response Transfer Function Curve H(f) -->
        <div class="drawer-section">
          <div class="section-label-row">
            <span class="section-label">📈 FREQUENCY RESPONSE H(f)</span>
            <span class="physics-legend"><span class="legend-dot"></span> Combined Magnitude (dB)</span>
          </div>
          <div class="canvas-wrapper">
            <canvas id="bode-canvas" width="620" height="150"></canvas>
          </div>
          <div class="physics-readout" id="physics-readout">
            HPF: <span>30 Hz</span> | Bass: <span>+5.0 dB</span> @ 65Hz | Mid: <span>+1.5 dB</span> | High: <span>+2.0 dB</span>
          </div>
        </div>
      </div>

      <!-- Technical Physics & Router Guide Modal -->
      <div class="guide-modal" id="guide-modal">
        <div class="guide-modal-content">
          <div class="guide-modal-header">
            <h4>🔬 Physics Visualizer & Router Guide</h4>
            <button class="btn-close-modal" id="btn-close-guide">✕</button>
          </div>
          <div class="guide-modal-body" id="guide-modal-body">
            <!-- Dynamic info content will be populated here -->
          </div>
        </div>
      </div>
    `;

    // Inject Styles into the target document
    const style = this.doc.createElement('style');
    style.textContent = `
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

      .drawer-body { flex: 1; overflow-y: auto; padding: 6px 10px; display: flex; flex-direction: column; gap: 8px; width: 100%; box-sizing: border-box; }
      .drawer-section { display: flex; flex-direction: column; gap: 4px; width: 100%; box-sizing: border-box; }
      .section-label { font-size: 9px; font-weight: 700; color: var(--text-muted, #888); letter-spacing: 0.8px; white-space: nowrap; }
      .section-label-row { display: flex; justify-content: space-between; align-items: center; width: 100%; }
      .pipeline-header-row {
        display: flex; justify-content: space-between; align-items: center; width: 100%; min-width: 0; overflow: hidden;
      }
      .pipeline-title-group { display: flex; align-items: center; gap: 5px; }
      .physics-legend {
        font-size: 8px; color: var(--accent, #00e5ff); display: flex; align-items: center;
        gap: 3px; white-space: nowrap; flex-shrink: 0;
      }
      .legend-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent, #00e5ff); flex-shrink: 0; }

      /* Themes */
      .theme-pills { display: flex; flex-wrap: wrap; gap: 3px; }
      .theme-pill {
        display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px;
        background: var(--bg-surface, #1e1e26); border: 1px solid var(--border-color, rgba(255,255,255,0.1));
        border-radius: 10px; font-size: 8.5px; font-weight: 600; color: var(--text-muted, #aaa);
        cursor: pointer; transition: all 0.2s;
      }
      .theme-pill:hover { border-color: var(--accent, #00e5ff); color: var(--text-main, #fff); }
      .theme-pill.active {
        background: var(--accent-glow, rgba(0,229,255,0.15)); border-color: var(--accent, #00e5ff);
        color: var(--accent, #00e5ff); box-shadow: 0 0 6px var(--accent-glow, rgba(0,229,255,0.25));
      }
      .theme-dot { width: 5px; height: 5px; border-radius: 50%; }

      /* Canvas Wrappers */
      .canvas-wrapper {
        width: 100%; border-radius: 6px; overflow: hidden; background: #0c0c10;
        border: 1px solid var(--border-color, rgba(255,255,255,0.08));
        box-shadow: inset 0 0 16px rgba(0,0,0,0.6);
        box-sizing: border-box;
      }
      .canvas-wrapper canvas { width: 100%; height: auto; display: block; }

      /* Interactive Stage Columns Grid (Strict 100% Fit) */
      .stage-labels-grid {
        display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 2px;
        text-align: center; margin-top: 2px; width: 100%; max-width: 100%;
        box-sizing: border-box; overflow: hidden;
      }
      .stage-label-col {
        font-size: 8px; color: var(--text-muted, #888); line-height: 1.1;
        background: var(--bg-card, rgba(255,255,255,0.02)); padding: 3px 1px; border-radius: 4px;
        display: flex; flex-direction: column; align-items: center; justify-content: space-between;
        gap: 2px; min-height: 48px; min-width: 0; overflow: hidden; border: 1px solid transparent;
        box-sizing: border-box;
      }
      .stage-col-header {
        display: flex; align-items: center; justify-content: center; gap: 1px; width: 100%; min-width: 0;
      }
      .stage-label-col b { color: var(--text-main, #fff); font-size: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .stage-sub { font-size: 7px; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
      .stage-info-btn {
        background: none; border: none; font-size: 7.5px; cursor: pointer; padding: 0;
        opacity: 0.7; transition: opacity 0.15s; flex-shrink: 0;
      }
      .stage-info-btn:hover { opacity: 1; transform: scale(1.1); }
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

    this.container.appendChild(this.overlay);
    this.container.appendChild(this.drawer);

    this.pipelineCanvas = this.drawer.querySelector('#pipeline-canvas');
    this.pipelineCtx = this.pipelineCanvas ? this.pipelineCanvas.getContext('2d') : null;

    this.bodeCanvas = this.drawer.querySelector('#bode-canvas');
    this.bodeCtx = this.bodeCanvas ? this.bodeCanvas.getContext('2d') : null;

    this.readoutEl = this.drawer.querySelector('#physics-readout');
    this.guideModal = this.drawer.querySelector('#guide-modal');
    this.guideModalBody = this.drawer.querySelector('#guide-modal-body');
  }

  initParticles() {
    this.particles = [];
    const width = 620;
    const height = 220;

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
    this.overlay.onclick = () => this.close();

    // Theme selector
    const themePills = this.drawer.querySelectorAll('.theme-pill');
    themePills.forEach(pill => {
      pill.onclick = () => {
        themePills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.activeTheme = pill.getAttribute('data-theme');
      };
    });

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

    // Stage Info Buttons
    const infoBtns = this.drawer.querySelectorAll('.stage-info-btn');
    infoBtns.forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const stageNum = btn.getAttribute('data-stage-info');
        this.openGuide(stageNum);
      };
    });
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

  openGuide(highlightStage = null) {
    if (!this.guideModal || !this.guideModalBody) return;

    this.guideModalBody.innerHTML = `
      <div class="guide-card">
        <h5>🌊 Why the Wave Enlarges Up and Down (Stage 3 Superposition)</h5>
        <p>The audio signal is mathematically calculated via Fourier wave superposition:
        <span class="guide-highlight">y(x, t) = A_bass·sin(ω₁x - t) + A_mid·sin(ω₂x - t) + A_high·sin(ω₃x - t)</span>.<br>
        When you boost the <b>Bass</b> (+5dB to +14dB) or <b>Mid</b> sliders, the voltage amplitude (<span class="guide-highlight">V_peak</span>) physically increases. In physics, voltage directly controls speaker cone excursion—the wave expands vertically to show the increased air displacement you hear!</p>
      </div>

      <div class="guide-card">
        <h5>🛡️ Stage 2: HPF (High Pass Filter) Barrier Explained</h5>
        <p>Sub-bass below <span class="guide-highlight">30 Hz</span> is mostly inaudible mud that robs amplifier wattage and forces speaker voice coils into mechanical distortion. The vertical barrier reflects and blocks sub-audible low-frequency waves, leaving clean, punchy musical bass.</p>
      </div>

      <div class="guide-card">
        <h5>✨ Moving Dots (Audio Energy Packets)</h5>
        <p>The glowing dots represent discrete <b>32-bit floating-point audio sample buffers</b> moving through the DSP pipeline. Their vertical jitter represents instantaneous voltage energy, and their speed corresponds to playback pitch/speed.</p>
      </div>

      <div class="guide-card">
        <h5>⚖️ Stage 4: Dynamics Compressor Ceiling</h5>
        <p>The dashed horizontal lines show the dynamic compression ceiling. When bass or explosions surge, the compressor clamps the peak to prevent digital clipping (0 dBFS inter-sample overshoot) while raising quiet vocal whispers.</p>
      </div>

      <div class="guide-card">
        <h5>🎛️ Stage Bypass A/B Testing</h5>
        <p>Click any stage toggle (<span class="guide-highlight">● ON / ○ BYPASS</span>) to mute or isolate that individual DSP stage and immediately hear how it transforms your sound in real time.</p>
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
    this.updateReadout();
  }

  updateReadout() {
    if (!this.readoutEl) return;
    const p = this.currentParams;
    const bypass = p.stageBypass || {};
    const hpfStr = bypass.hpf ? '<span style="color:#777">Bypassed</span>' : `<span>${Math.round(p.hpf || 30)} Hz</span>`;
    const bassStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>+${parseFloat(p.bass || 0).toFixed(1)} dB</span>`;
    const midStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>${(p.mid >= 0 ? '+' : '') + parseFloat(p.mid || 0).toFixed(1)} dB</span>`;
    const highStr = bypass.eq ? '<span style="color:#777">Flat</span>' : `<span>${(p.high >= 0 ? '+' : '') + parseFloat(p.high || 0).toFixed(1)} dB</span>`;

    this.readoutEl.innerHTML = `HPF: ${hpfStr} | Bass: ${bassStr} @ 65Hz | Mid: ${midStr} | High: ${highStr}`;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.isOpen = true;
    this.overlay.classList.add('open');
    this.drawer.classList.add('open');
    this.startAnimation();
  }

  close() {
    this.isOpen = false;
    this.overlay.classList.remove('open');
    this.drawer.classList.remove('open');
    this.closeGuide();
    this.stopAnimation();
  }

  startAnimation() {
    if (this.animFrameId) return;
    const render = () => {
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
    const w = this.pipelineCanvas.width;
    const h = this.pipelineCanvas.height;
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyber'];

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

    // 1. Stage Divider Lines & Labels
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
    const barrierHeight = hpfActive ? Math.min(180, 40 + (hpfFreq / 200) * 140) : 0;

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
      ctx.font = '8.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`< ${Math.round(hpfFreq)}Hz Cut`, hpfX, h - 8);
    }

    // 3. Stage 4: Compressor Ceiling / Floor Lines
    const compActive = !bypass.comp && p.autoBalance;
    if (compActive) {
      const compX1 = stageWidth * 3;
      const compX2 = stageWidth * 4;
      const ceilingY = 35;
      const floorY = h - 35;

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
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Ceiling', (compX1 + compX2) / 2, ceilingY - 4);
      ctx.fillText('Floor', (compX1 + compX2) / 2, floorY + 11);
    }

    // 4. Cumulative Waveform Math (Left to Right)
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = this.isCapturing ? theme.line : 'rgba(255,255,255,0.2)';
    ctx.shadowColor = this.isCapturing ? theme.glow : 'transparent';
    ctx.shadowBlur = 10;
    ctx.beginPath();

    const baselineY = h / 2;

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

      // Superposition Formula: y(x, t) = A * [sin(w1*x - t) + 0.4*sin(w2*x - t)]
      const freq1 = 0.04 * (p.pitch || 1.0);
      const freq2 = 0.08 * (p.pitch || 1.0);
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
      pt.x += pt.speed * (p.pitch || 1.0);
      if (pt.x > w) {
        pt.x = 0;
        pt.y = pt.baseY + (Math.random() - 0.5) * 30;
      }

      const curStage = Math.floor(pt.x / stageWidth);
      let yJitter = Math.sin(pt.x * 0.05 - this.time * 4 + pt.phase) * (8 + (p.bass || 0) * 2);

      // HPF collision reflection for sub-bass particles
      if (!bypass.hpf && curStage === 1 && pt.x > hpfX - 15 && pt.x < hpfX + 5 && pt.colorType === 0) {
        pt.x = Math.max(0, pt.x - 4); // Reflect backward
      }

      // Comp clamp
      if (!bypass.comp && p.autoBalance && curStage >= 3) {
        yJitter = Math.max(-42, Math.min(42, yJitter));
      }

      const renderY = pt.baseY + yJitter;

      ctx.beginPath();
      ctx.arc(pt.x, renderY, pt.radius, 0, Math.PI * 2);

      if (pt.colorType === 0) ctx.fillStyle = theme.p1;
      else if (pt.colorType === 1) ctx.fillStyle = theme.p2;
      else ctx.fillStyle = theme.p3;

      ctx.fill();
    });
  }

  drawBode() {
    if (!this.bodeCtx || !this.bodeCanvas) return;
    const ctx = this.bodeCtx;
    const w = this.bodeCanvas.width;
    const h = this.bodeCanvas.height;
    const theme = this.themeColors[this.activeTheme] || this.themeColors['theme-cyber'];

    ctx.clearRect(0, 0, w, h);

    const p = this.currentParams;
    const bypass = p.stageBypass || {};

    // Grid lines (dB and Frequencies)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;

    // Zero dB center line
    const zeroY = h / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.stroke();

    // Frequency markers (20Hz, 100Hz, 1kHz, 10kHz, 20kHz)
    const freqs = [20, 60, 200, 1000, 5000, 20000];
    ctx.font = '8px sans-serif';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';

    freqs.forEach(f => {
      const x = (Math.log10(f / 20) / Math.log10(20000 / 20)) * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}Hz`, x, h - 4);
    });

    // Plot Frequency Response Transfer Function |H(f)| (in dB)
    ctx.beginPath();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = theme.line;
    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 8;

    for (let px = 0; px < w; px += 2) {
      const f = 20 * Math.pow(1000, px / w);
      let totalDb = 0;

      // 1. HPF (High-Pass Filter 2nd order Butterworth)
      if (!bypass.hpf) {
        const fc = p.hpf || 30;
        const hpfMag = Math.pow(f / fc, 2) / Math.sqrt(1 + Math.pow(f / fc, 4));
        totalDb += 20 * Math.log10(Math.max(0.001, hpfMag));
      }

      // 2. Bass Boost (Peaking / Low-shelf @ 65Hz)
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
      const y = zeroY - (totalDb / 24) * (h / 2 - 15);
      const clampedY = Math.max(8, Math.min(h - 15, y));

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
