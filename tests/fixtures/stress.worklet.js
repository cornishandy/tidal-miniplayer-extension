// Test-only load for the audio thread (scratch builds only). iters: arithmetic per block. burstMs/every: a stall of
// burstMs milliseconds once every `every` blocks, like the operating system pausing the audio thread for a moment.
class Stress extends AudioWorkletProcessor {
  constructor(o) { super(); const p = (o && o.processorOptions) || {}; this.iters = p.iters || 0; this.burstMs = p.burstMs || 0; this.every = p.every || 64; this.sink = 0; this.calls = 0; this.t0 = Date.now(); }
  process(inputs, outputs) {
    let s = 0; for (let i = 0; i < this.iters; i++) s += Math.sqrt(i + this.sink); this.sink = s * 1e-12;
    if (this.burstMs && this.calls % this.every === 0) { const t = Date.now(); while (Date.now() - t < this.burstMs) {} }
    outputs[0][0].fill(0);
    if (++this.calls % 750 === 0) { const t = Date.now(); this.port.postMessage({ calls: this.calls, msPer750: t - this.t0 }); this.t0 = t; }
    return true;
  }
}
registerProcessor('stress', Stress);
