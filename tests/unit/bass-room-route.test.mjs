// Bass-room routing (1.6.0). Fake Web Audio graph, no device, no sound.
// Proves the fresh default start never splices the new stages, fades stay complementary,
// and turning a stage off parks it and restores the 1.4.0 wires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(join(root, 'offscreen.js'), 'utf8');

test('the default connect block does not mention the new stages', () => {
  const start = SRC.indexOf('sourceNodeLocal.connect(directPassThroughGain)');
  const end = SRC.indexOf('sourceNodeLocal.connect(inputAnalyser)');
  assert.ok(start > 0 && end > start, 'default connect block not found');
  const block = SRC.slice(start, end);
  for (const word of ['unmud', 'true-peak', 'bass-peaks', 'centre-bass', 'createDelay', 'centreNode', 'bassPeaks']) {
    assert.equal(block.includes(word), false, 'default connect block mentions ' + word);
  }
});

function load() {
  let nowMs = 0;
  let seq = 1;
  const jobs = [];
  const delays = [];
  const created = [];
  class Param {
    constructor(value) { this.value = value; this._brFade = null; }
    setTargetAtTime(v) { this.value = v; }
    setValueAtTime(v) { this.value = v; }
    linearRampToValueAtTime() {}
    cancelScheduledValues() {}
  }
  function makeNode(kind) {
    const node = {
      kind,
      gain: new Param(1),
      delayTime: new Param(0),
      release: { value: 0.2 },
      _edges: [],
      port: {
        onmessage: null,
        posts: [],
        postMessage(data) { this.posts.push(data); if (data.type === 'park' && this.onmessage) this.onmessage({ data: { parked: true } }); },
        close() { this.closed = true; }
      },
      connect(dest, out = 0, inp = 0) {
        if (this._edges.some((e) => e.dest === dest && e.out === out && e.inp === inp)) {
          const err = new Error('already connected');
          err.name = 'InvalidAccessError';
          throw err;
        }
        this._edges.push({ dest, out, inp });
      },
      disconnect(dest) {
        if (dest == null) { this._edges.length = 0; return; }
        const i = this._edges.findIndex((e) => e.dest === dest);
        if (i < 0) throw new Error('not connected');
        this._edges.splice(i, 1);
      },
      to(dest) { return this._edges.some((e) => e.dest === dest); }
    };
    return node;
  }
  const ctx = {
    state: 'running',
    sampleRate: 48000,
    currentTime: 0,
    createGain() { return makeNode('gain'); },
    createDelay(max) {
      const d = makeNode('delay');
      d.max = max;
      delays.push(d);
      return d;
    }
  };
  function makeDyn(name, inputs) {
    if (makeDyn.fail && makeDyn.fail[name]) return null;
    const node = makeNode(name);
    node.inputs = inputs;
    created.push(name);
    return node;
  }
  makeDyn.fail = null;
  const sandbox = {
    console, Math, Number, Object, Array, Error, String, Boolean, isFinite, Infinity, Float32Array, Promise, JSON,
    setTimeout(fn, ms) {
      const id = seq++;
      jobs.push({ id, at: nowMs + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) {
      const i = jobs.findIndex((j) => j.id === id);
      if (i >= 0) jobs.splice(i, 1);
    },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); }, getURL: (p) => p } },
    AudioContext: function AudioContext() {},
    AudioWorkletNode: function AudioWorkletNode() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC + `
    globalThis.__api = {
      empty: emptyBass,
      setDyn(d) { currentDynamics = normaliseDynamics(d); },
      setAuto(on) { currentParams.autoBalance = !!on; },
      norm: normaliseDynamics,
      eff: () => effectiveDynamics(),
      err: () => dynError,
      held: (p, now) => heldGain(p, now),
      apply: applyRoutingToGraph,
      br: () => br
    };
  `, sandbox, { filename: 'offscreen.js' });
  const api = sandbox.__api;
  function flush(ms) {
    const end = nowMs + ms;
    let guard = 0;
    while (guard++ < 10000) {
      const due = jobs.filter((j) => j.at <= end).sort((a, b) => a.at - b.at || a.id - b.id);
      if (!due.length) break;
      const j = due[0];
      const idx = jobs.findIndex((x) => x.id === j.id);
      if (idx >= 0) jobs.splice(idx, 1);
      nowMs = j.at;
      ctx.currentTime = nowMs / 1000;
      j.fn();
    }
    nowMs = end;
    ctx.currentTime = nowMs / 1000;
  }
  function graph() {
    const g = {
      audioCtx: ctx,
      highNode: makeNode('high'),
      hpfNode: makeNode('hpf'),
      autoBalanceComp: makeNode('comp'),
      autoBalanceWetGain: makeNode('wet'),
      autoBalanceBypassGain: makeNode('bypass'),
      bandLevelerGain: makeNode('band'),
      bandLevelerNode: makeNode('band-leveler'),
      levelerOut: makeNode('levelerOut'),
      volumeGain: makeNode('volume'),
      masterLimiter: makeNode('master'),
      lookaheadNode: makeNode('lookahead'),
      lookaheadGain: makeNode('laGain'),
      limiterFastGain: makeNode('fastGain'),
      limiterOut: makeNode('limiterOut'),
      matchWetGain: makeNode('matchWet'),
      matchDryGain: makeNode('matchDry'),
      matchNode: makeNode('match'),
      ceilingWarmGain: makeNode('warm'),
      ceilingCleanGain: makeNode('clean'),
      pitchWetGain: makeNode('pitchWet'),
      pitchDryGain: makeNode('pitchDry'),
      dspPathGain: makeNode('dsp'),
      directPassThroughGain: makeNode('direct'),
      movieMode: false,
      makeDyn,
      wired: false,
      live: false,
      _br: null,
      dynError: null,
      outputSum: makeNode('output')
    };
    g.autoBalanceComp.release = { value: 0.2 };
    return g;
  }
  function wireDefault(g) {
    const { highNode: high, autoBalanceComp: comp, autoBalanceWetGain: wet, autoBalanceBypassGain: bypass,
      bandLevelerNode: band, volumeGain: vol, masterLimiter: master, lookaheadNode: la } = g;
    high.connect(comp); high.connect(bypass); high.connect(band);
    vol.connect(master); vol.connect(la);
  }
  function held(node) {
    return node && node.gain ? api.held(node.gain, ctx.currentTime) : null;
  }
  function sums(g) {
    const slot = g._br;
    const leveler = held(g.autoBalanceWetGain) + held(g.autoBalanceBypassGain) + held(g.bandLevelerGain);
    const post = slot && slot.peaksDry && slot.peaksWet ? held(slot.peaksDry) + held(slot.peaksWet) : null;
    const lim = held(g.limiterFastGain) + held(g.lookaheadGain) + (slot && slot.tpGain ? held(slot.tpGain) : 0);
    const room = slot && slot.roomDry && slot.roomWet ? held(slot.roomDry) + held(slot.roomWet) : null;
    return { leveler, post, lim, room };
  }
  function assertSums(g, where) {
    const s = sums(g);
    assert.ok(s.leveler <= 1.000001, where + ' leveler sum ' + s.leveler);
    if (s.post != null) assert.ok(s.post <= 1.000001, where + ' post sum ' + s.post);
    assert.ok(s.lim <= 1.000001, where + ' limiter sum ' + s.lim);
    if (s.room != null) assert.ok(s.room <= 1.000001, where + ' room sum ' + s.room);
  }
  return { api, ctx, delays, created, makeDyn, flush, graph, wireDefault, held, sums, assertSums, jobs };
}

function settle(env, g) {
  env.api.setDyn({ leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: true });
  env.wireDefault(g);
  g.wired = true;
  g._br = env.api.empty();
  g.live = false;
  env.api.apply(g, { immediate: true });
}

test('a fresh default start does not create the new stages or a delay', () => {
  const env = load();
  const g = env.graph();
  const before = env.delays.length;
  settle(env, g);
  assert.equal(env.created.length, 0, 'makeDyn ran on the default start');
  assert.equal(env.delays.length, before, 'createDelay ran on the default start');
  assert.equal(g.volumeGain.to(g.masterLimiter), true);
  assert.equal(g.volumeGain.to(g.lookaheadNode), true);
  assert.equal(g._br.preLim, null);
  assert.equal(g._br.peaks, null);
  assert.equal(g._br.unmud, null);
  assert.equal(g._br.truepeak, null);
  assert.equal(g._br.postSpliced, false);
  assert.equal(env.held(g.autoBalanceWetGain), 1);
  assert.equal(env.held(g.autoBalanceBypassGain), 0);
  assert.equal(env.held(g.bandLevelerGain), 0);
  assert.equal(env.held(g.limiterFastGain), 1);
  assert.equal(env.held(g.lookaheadGain), 0);
  env.assertSums(g, 'default');
  assert.equal(env.api.err(), null);
});

test('peaks startup sets the bypass gain before the default wires, then splices only once wired', () => {
  const env = load();
  const g = env.graph();
  env.api.setDyn({ leveler: 'peaks', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: true });
  assert.equal(env.held(g.autoBalanceBypassGain), 1);
  assert.equal(env.held(g.autoBalanceWetGain), 0);
  assert.equal(env.created.length, 0, 'unwired apply created a worklet');
  env.wireDefault(g);
  g.wired = true;
  g._br = env.api.empty();
  g.live = false;
  env.api.apply(g, { immediate: true });
  assert.equal(g._br.appliedPeaks, true);
  assert.ok(env.created.includes('bass-peaks'));
  assert.equal(g.volumeGain.to(g.masterLimiter), false, 'volume still feeds the limiter directly');
  assert.equal(g._br.peaksWet.gain.value, 1);
  assert.equal(env.held(g.limiterFastGain), 1);
  env.assertSums(g, 'peaks settled');
});

test('live peaks enter and leave: complementary gains, no leftover delay, parked port', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = true;
  env.api.setDyn({ leveler: 'peaks', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: false });
  env.flush(2000);
  env.assertSums(g, 'peaks on');
  assert.equal(g._br.appliedPeaks, true);
  assert.ok(g._br.peaks, 'peaks node missing');
  assert.equal(env.held(g._br.peaksWet), 1);
  assert.equal(g.volumeGain.to(g._br.peaksDry), false);
  assert.deepEqual(g._br.pad.peaksDry, null);
  assert.deepEqual(g._br.pad.bypass, null);
  assert.equal(env.delays.length > 0, true, 'the alignment delay was never created');
  const parked = g._br.peaks;
  const callbacks = g._br.callbacks;
  env.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: false });
  env.flush(2000);
  env.assertSums(g, 'peaks off');
  assert.equal(g._br.appliedPeaks, false);
  assert.equal(g._br.peaks, null);
  assert.equal(g._br.split, false);
  assert.equal(g._br.postSpliced, false);
  assert.equal(g.volumeGain.to(g.masterLimiter), true);
  assert.equal(g.volumeGain.to(g.lookaheadNode), true);
  assert.equal(g._br.pad.peaksDry, null);
  assert.equal(g._br.pad.bypass, null);
  assert.equal(parked.port.onmessage, null);
  assert.ok(parked.port.posts.some((p) => p.type === 'park'));
  assert.equal(g._br.callbacks, callbacks);
});

test('100 rapid peaks toggles keep the gain sum at or under 1 and settle on the last request', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = true;
  let peaks = 0;
  for (let i = 0; i < 100; i++) {
    peaks = i % 2 === 0 ? 1 : 0;
    env.api.setDyn({ leveler: peaks ? 'peaks' : 'full', limiter: 'fast', ceiling: 'clean', room: 'off' });
    env.api.apply(g, { immediate: false });
    env.flush(10);
    env.assertSums(g, 'toggle ' + i);
  }
  env.flush(3000);
  env.assertSums(g, 'after toggles');
  assert.equal(g._br.appliedPeaks, false, 'last request was Full');
  assert.equal(g._br.peaks, null);
  assert.equal(g._br.postSpliced, false);
  assert.equal(g.volumeGain.to(g.masterLimiter), true);
  assert.equal(g._br.pad.peaksDry, null);
  assert.equal(g._br.pad.bypass, null);
  env.api.setDyn({ leveler: 'peaks', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: false });
  env.flush(3000);
  assert.equal(g._br.appliedPeaks, true);
  assert.ok(g._br.peaks);
  assert.equal(g._br.pad.peaksDry, null);
  assert.equal(g._br.pad.bypass, null);
  env.assertSums(g, 'peaks after toggles');
});

test('room unmud taps the high-pass before the shelf, and off restores the direct high-node wires', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = true;
  env.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'unmud' });
  env.api.apply(g, { immediate: false });
  env.flush(2000);
  assert.equal(g._br.appliedRoom, 'unmud');
  assert.equal(g._br.unmud.inputs, 2);
  assert.equal(g.hpfNode.to(g._br.unmud), true);
  assert.ok(g.hpfNode._edges.some((e) => e.dest === g._br.unmud && e.inp === 1));
  assert.equal(g.highNode.to(g.autoBalanceComp), false);
  assert.equal(env.held(g._br.roomWet), 1);
  const parked = g._br.unmud;
  env.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: false });
  env.flush(2000);
  assert.equal(g._br.appliedRoom, 'off');
  assert.equal(g._br.unmud, null);
  assert.equal(g._br.roomSpliced, false);
  assert.equal(g.highNode.to(g.autoBalanceComp), true);
  assert.equal(g.highNode.to(g.autoBalanceBypassGain), true);
  assert.equal(parked.port.onmessage, null);
  env.assertSums(g, 'room off');
});

test('centre and both, and true peak replaces the limiter then leaves it', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = true;
  env.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'both' });
  env.api.apply(g, { immediate: false });
  env.flush(2000);
  assert.equal(g._br.appliedRoom, 'both');
  assert.ok(g._br.unmud && g._br.centre);
  assert.equal(g._br.unmud.to(g._br.centre), true);
  env.api.setDyn({ leveler: 'full', limiter: 'truepeak', ceiling: 'clean', room: 'centre' });
  env.api.apply(g, { immediate: false });
  env.flush(3000);
  assert.equal(g._br.appliedRoom, 'centre');
  assert.equal(g._br.unmud, null);
  assert.ok(g._br.centre);
  assert.equal(g._br.appliedLimiter, 'truepeak');
  assert.ok(g._br.truepeak);
  assert.equal(env.held(g._br.tpGain), 1);
  assert.equal(env.held(g.limiterFastGain), 0);
  assert.equal(env.held(g.lookaheadGain), 0);
  assert.equal(g._br.pad.truepeak, null);
  assert.equal(g._br.pad.fast, null);
  env.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: false });
  env.flush(3000);
  assert.equal(g._br.truepeak, null);
  assert.equal(g._br.centre, null);
  assert.equal(g._br.postSpliced, false);
  assert.equal(env.held(g.limiterFastGain), 1);
  assert.equal(g.volumeGain.to(g.masterLimiter), true);
  env.assertSums(g, 'all off');
});

test('a failed optional stage reports an error and latches output mute until restart', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = false;
  env.makeDyn.fail = { 'bass-peaks': true };
  env.api.setDyn({ leveler: 'peaks', limiter: 'fast', ceiling: 'clean', room: 'off' });
  env.api.apply(g, { immediate: true });
  assert.equal(g._br.appliedPeaks, false);
  assert.equal(g._br.peaks, null);
  assert.equal(g._br.postSpliced, false);
  assert.match(env.api.err(), /Bass peaks/);
  assert.equal(g._br.fatal, true);
  assert.equal(env.held(g.outputSum), 0);
  assert.equal(env.held(g.directPassThroughGain), 0);
  const tp = load();
  const g2 = tp.graph();
  settle(tp, g2);
  tp.makeDyn.fail = { 'true-peak': true };
  tp.api.setDyn({ leveler: 'full', limiter: 'truepeak', ceiling: 'clean', room: 'off' });
  tp.api.apply(g2, { immediate: true });
  assert.equal(g2._br.truepeak, null);
  assert.equal(g2._br.tpFailed, true);
  assert.equal(g2._br.appliedLimiter, 'lookahead');
  assert.match(tp.api.err(), /True peak/);
  assert.equal(g2._br.fatal,true);
  assert.equal(tp.held(g2.outputSum),0);
  tp.api.setDyn({room:'off',leveler:'full',limiter:'fast'});tp.api.apply(g2,{immediate:true});
  assert.equal(tp.held(g2.outputSum),0,'a later default must not release the failure mute');
  assert.equal(tp.held(g2.directPassThroughGain), 0);
  assert.equal(g2.volumeGain.to(g2.masterLimiter), true);
  const room = load();
  const g3 = room.graph();
  settle(room, g3);
  room.makeDyn.fail = { unmud: true, 'centre-bass': true };
  room.api.setDyn({ leveler: 'full', limiter: 'fast', ceiling: 'clean', room: 'both' });
  room.api.apply(g3, { immediate: true });
  assert.equal(g3._br.appliedRoom, 'off');
  assert.equal(g3._br.unmud, null);
  assert.equal(g3._br.centre, null);
  assert.equal(g3.highNode.to(g3.autoBalanceComp), true);
  assert.match(room.api.err(), /Room/);
});

test('AUTO off does not run bass peaks; room still can', () => {
  const env = load();
  const g = env.graph();
  settle(env, g);
  g.live = false;
  env.api.setAuto(false);
  env.api.setDyn({ leveler: 'peaks', limiter: 'fast', ceiling: 'clean', room: 'unmud' });
  env.api.apply(g, { immediate: true });
  assert.equal(g._br.peaks, null, 'bass peaks ran while AUTO was off');
  assert.equal(g._br.appliedPeaks, false);
  assert.ok(g._br.unmud, 'room should not depend on AUTO');
  assert.equal(g._br.appliedRoom, 'unmud');
  assert.equal(env.held(g.autoBalanceBypassGain), 1, 'AUTO off keeps the dry leveler');
  assert.equal(env.held(g.autoBalanceWetGain), 0);
});

test('a parked node error is ignored, but an active processorerror latches the visible mute', () => {
  const e=load(),g=e.graph();settle(e,g);e.api.setDyn({room:'unmud',leveler:'full',limiter:'fast'});e.api.apply(g,{immediate:true});
  const retired=g._br.unmud;e.api.setDyn({room:'off'});e.api.apply(g,{immediate:true});retired.onprocessorerror();
  assert.equal(g._br.fatal,false,'a retired node muted the current graph');
  e.api.setDyn({room:'unmud'});e.api.apply(g,{immediate:true});g._br.unmud.onprocessorerror();
  assert.equal(g._br.fatal,true);assert.equal(e.held(g.outputSum),0);assert.match(e.api.err(),/output muted/);
});
