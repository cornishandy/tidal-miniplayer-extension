// Synthetic rendering and hostname checks: no browser or extension load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = name => readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
function loadPhysics() {
  const points = [];
  function ctx2d() {
    const ctx = {
      lineWidth: 1,
      strokeStyle: '',
      fillStyle: '',
      font: '',
      textAlign: '',
      shadowColor: '',
      shadowBlur: 0,
      clearRect() {}, beginPath() {}, moveTo() {}, closePath() {}, stroke() {}, fill() {},
      fillText() {}, setTransform() {},
      lineTo(x, y) { points.push({ x, y, w: ctx.lineWidth }); },
      createLinearGradient() { return { addColorStop() {} }; }
    };
    return ctx;
  }
  function canvas() {
    return {
      width: 300, height: 50, clientWidth: 300, clientHeight: 50,
      getContext: () => ctx2d(),
      getBoundingClientRect: () => ({ width: 300, height: 50 })
    };
  }
  const readout = { textContent: '' };
  const doc = { body: { classList: ['theme-cyan'] }, defaultView: { devicePixelRatio: 1 } };
  const sandbox = { console, Math, Number, Object, Array, requestAnimationFrame() { return 0; }, cancelAnimationFrame() {}, document: doc, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read('physics-view.js') + '\nglobalThis.PhysicsView = PhysicsView;', sandbox, { filename: 'physics-view.js' });
  const view = new sandbox.PhysicsView({ liveCanvas: canvas(), bodeCanvas: canvas(), readoutEl: readout, doc });
  return {
    view,
    readout,
    clear() { points.length = 0; },
    curveYs() { return points.filter((p) => p.w === 2).map((p) => p.y); }
  };
}


test('BYP-01: true bypass draws a flat response even with non-neutral stages', () => {
  const phys = loadPhysics(); phys.clear();
  const params = { bass: 20, hpf: 180, mid: 12, high: -12, gain: 2, semitones: 3, autoBalance: true, bypass: true, stageBypass: {} };
  phys.view.updateState(params, true);
  assert.ok(Object.values(phys.view.bypassOf()).every(Boolean));
  const ys = phys.curveYs();
  assert.ok(ys.length > 100);
  assert.ok(ys.every(y => Math.abs(y - 23) < 1e-9), 'all frequencies at 0 dB');
  phys.clear(); phys.view.updateState({ ...params, bypass: false }, true);
  assert.ok(phys.curveYs().some(y => Math.abs(y - 23) > 4), 'enabled response still reflects edits');
});

test('TAB-01: content and page bridge agree on strict Tidal hosts', () => {
  const content = read('content.js');
  const guard = content.slice(content.indexOf('  const ', content.indexOf('__TIDAL_MINIPLAYER_INJECTED__ = true')), content.indexOf('  let currentTrackInfo'));
  for (const [hostname, expected] of [['tidal.com', true], ['listen.tidal.com', true], ['a.b.tidal.com', true],
    ['nottidal.com', false], ['tidal.com.evil.example', false], ['example.com', false]]) {
    const ctx = vm.createContext({ window: { location: { hostname } } });
    assert.equal(vm.runInContext(guard + ';isTidal', ctx), expected, hostname);
    const bridge = read('page-bridge.js');
    const condition = bridge.match(/if \(!\((.*?)\) \|\| window.__tmePageBridge/)[1];
    assert.equal(vm.runInNewContext(condition, { host: hostname }), expected, hostname + ' bridge');
  }
});
