// Runs inside the existing, fully muted/isolated browser. Never starts a browser or opens a device.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { checkBassRoomUI } from './bass-room-ui.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const db = v => 20 * Math.log10(Math.max(v, 1e-20));
export async function runBassRoomChecks({ context, extDir, EXT_ID, outDir, record, watchRequests }) {
  const dir = join(outDir, 'bass-room'); mkdirSync(dir, { recursive: true });
  const source = readFileSync(join(extDir, 'offscreen.js'), 'utf8');
  const baseline = execFileSync('git', ['show', '27ac887:offscreen.js'], { cwd: root, encoding: 'utf8' });
  const fixture = readFileSync(join(here, 'bass-room/fixture.js'), 'utf8');
  const adapter = readFileSync(join(here, 'bass-room/engine.js'), 'utf8');
  const page = await context.newPage(); watchRequests(page);
  await page.addInitScript(() => { window.AudioContext = function() { throw Error('Realtime AudioContext forbidden by bass-room tests'); }; });
  await page.goto(`chrome-extension://${EXT_ID}/offscreen.html`);
  const run = (s, method = 'renderStereo', src = source, prefix = '') => page.evaluate(`(async()=>{${prefix}\n${src}\n${fixture}\n${adapter}\nreturn await ${method}(${JSON.stringify(s)});})()`);
  const decoded = result => Buffer.from(result.data, 'base64');
  const checks = [];
  const selected = (process.env.BASS_ROOM_PHASES || 'all').split(',');
  const phase = name => selected.includes('all') || selected.includes(name);
  const saveCheck = (id, title, ok, evidence) => { checks.push({ id, ok, evidence }); record(id, title, ok ? 'PASS' : 'FAIL', evidence, 'offline-audio'); };
  // Independent numerical analysis uses scipy's polyphase reconstruction and Butterworth demodulation.
  // Environment override avoids any dependency on a user's Documents checkout or Python environment.
  const py = spawn(process.env.BASS_ROOM_PYTHON || '/Users/andrewphillips/Library/Caches/eq-boost-double/sol/venv/bin/python', [join(here, 'bass-room/analyze.py'), dir], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  let waiter = null, pyError = '';
  py.stderr.on('data', x => { pyError += x; });
  createInterface({ input: py.stdout }).on('line', line => { const fn = waiter; waiter = null; if (fn) fn(JSON.parse(line)); });
  py.on('error', e => { if (waiter) { waiter({ error: String(e) }); waiter = null; } });
  const analyze = (id, meta, data) => {
    writeFileSync(join(dir, id + '.json'), JSON.stringify(meta)); writeFileSync(join(dir, id + '.f32'), data);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiter = null; reject(Error('Analysis timeout: ' + pyError)); }, 60000);
      waiter = x => { clearTimeout(timeout); x.error ? reject(Error(x.error)) : resolve(x); };
      py.stdin.write(JSON.stringify({ id }) + '\n');
    });
  };
  try {
    if (phase('ui')) await checkBassRoomUI({context,EXT_ID,outDir,root,record,watchRequests});
    if (phase('golden')) {
    const goldens = [];
    for (const rate of [48000, 96000]) {
      const s = { rate, seconds: 1, drain: 1, signal: 'pink', bass: 5, mid: 1.5, high: 2, gain: 1, dynamics: { leveler: 'full', match: false, limiter: 'fast', ceiling: 'clean' } };
      const before = decoded(await run(s, 'renderStereo', baseline)), afterResult = await run(s), after = decoded(afterResult);
      const hash = x => createHash('sha256').update(x).digest('hex');
      // Committed reference is regenerated only from immutable 27ac887, never from current code.
      const goldenFile = join(root, `tests/fixtures/default-golden-${rate}.f32`);
      if (process.env.BASS_ROOM_UPDATE_GOLDENS === '1') writeFileSync(goldenFile, before);
      if (!existsSync(goldenFile) || !readFileSync(goldenFile).equals(before)) throw Error('Committed golden differs from immutable pre-change source: ' + goldenFile);
      goldens.push({ rate, bytes: before.length, equal: before.equals(after), baseline: '27ac887', hash: hash(before), currentHash: hash(after), probe: afterResult.probe });
    }
    saveCheck('W-BR-GOLDEN', 'Fresh default Float32 renders exactly match the immutable pre-change graph at 48/96 kHz', goldens.every(x => x.equal && !x.probe.unmud && !x.probe.peaks && !x.probe.truepeak && !x.probe.delays.length), goldens);
    }
    if (phase('bounds')) {
    const bounds = [];
    for (const rate of [48000, 96000]) for (const range of ['old', 'new']) for (const limiter of ['fast', 'lookahead', 'truepeak']) for (const ceiling of ['clean', 'warm']) {
      const row = { rate, range, limiter, ceiling, metrics: {} };
      for (const signal of ['sine60', 'overdrive60', 'music', 'dialogue', 'isp']) for (const neutral of (signal === 'sine60' ? [false, true] : [false])) {
        const id = [rate, range, 'peaks', limiter, ceiling, signal, neutral ? 'zero' : 'boost'].join('_');
        const s = { rate, range, signal, neutral, bass: neutral ? 0 : range === 'old' ? 14 : 28, mid: range === 'old' ? 6 : 12, limiter, ceiling };
        const r = await run(s, 'renderCase');
        const delayMs = (Math.round(.005 * rate) + 1 + (limiter === 'fast' ? Math.round(.006 * rate) : limiter === 'lookahead' ? Math.round(.005 * rate) + 1 : Math.ceil(.005 * rate) + 33)) * 1000 / rate;
        row.metrics[signal + (neutral ? '-zero' : '')] = await analyze(id, { ...s, length: r.length, channels: 6, delayMs, seconds: 10, mode: 'peaks', errors: r.errors }, decoded(r));
      }
      const m = row.metrics, warm = ceiling === 'warm', newer = range === 'new';
      row.boost = m.sine60.steadyBassDb - m['sine60-zero'].steadyBassDb;
      row.ok = row.boost >= (warm ? newer ? 15 : 12 : newer ? 16.5 : 12.3)
        && Math.min(m.music.voiceDipDb, m.dialogue.voiceDipDb) >= (warm ? -5 : -3)
        && m.sine60.thdnPct <= (warm ? 5 : .05)
        && m.overdrive60.thdnPct <= (warm ? 8 : limiter === 'fast' ? 2.2 : .12)
        && Object.values(m).every(x => x.finite && !x.errors && x.peakDb <= db(.967) + 1e-5)
        && (limiter !== 'truepeak' || Object.values(m).every(x => x.tp4Db <= -.3 && (x.tp8Db == null || x.tp8Db <= -.3)));
      bounds.push(row);
      console.log('BASS-ROOM bounds', rate, range, limiter, ceiling, row.ok, row.boost.toFixed(3));
    }
    writeFileSync(join(dir, 'bounds.json'), JSON.stringify(bounds, null, 2));
    saveCheck('W-BR-BOUNDS', 'Bass peaks: both ranges, rates, ceilings and all limiters meet boost, voice, distortion and peak bounds', bounds.every(x => x.ok), bounds.map(({ metrics, ...x }) => ({ ...x, voice: [metrics.music.voiceDipDb, metrics.dialogue.voiceDipDb], thdn: [metrics.sine60.thdnPct, metrics.overdrive60.thdnPct] })));
    }
    if (phase('matrix')) {
    const matrix = [];
    for (const rate of [48000, 96000]) for (const leveler of ['full', 'slow', 'bass', 'peaks']) for (const room of ['off', 'unmud', 'centre', 'both']) for (const limiter of ['fast', 'lookahead', 'truepeak']) for (const ceiling of ['clean', 'warm']) for (const match of [false, true]) {
      const dynamics = { leveler, room, limiter, ceiling, match }, id = ['matrix', rate, leveler, room, limiter, ceiling, match].join('_');
      const r = await run({ rate, seconds: .25, drain: .1, signal: 'pink', dynamics, invert: room === 'centre' || room === 'both' });
      // Feed analysis six channels; only first two are measured for this short matrix.
      const data = decoded(r), input = Buffer.alloc(data.length * 3); data.copy(input);
      const m = await analyze(id, { rate, signal: 'matrix', neutral: false, length: r.length, channels: 6, delayMs: 0, stereo: true }, input);
      // analyze.py evaluates independent reconstructed peaks for every matrix render.
      matrix.push({ rate, dynamics, finite: r.finite, errors: r.errors, sample: m.peakDb, tp4: m.tp4Db, tp8: m.tp8Db, probe: r.probe });
    }
    writeFileSync(join(dir, 'matrix.json'), JSON.stringify(matrix, null, 2));
    saveCheck('W-BR-MATRIX', '384 startup combinations at both rates are finite, sample-bounded and correctly routed; True peak is checked after either ceiling', matrix.every(x => x.finite && !x.errors && x.sample <= db(.967) + 1e-5 && (x.dynamics.limiter !== 'truepeak' || (x.tp4 <= -.3 && x.tp8 <= -.3)) && x.probe.room === x.dynamics.room && x.probe.peaksOn === (x.dynamics.leveler === 'peaks') && x.probe.limiter === x.dynamics.limiter && !x.probe.delays.length && !x.probe.error), { cases: matrix.length, failed: matrix.filter(x => !x.finite || x.errors || x.sample > db(.967) + 1e-5 || (x.dynamics.limiter === 'truepeak' && (x.tp4 > -.3 || x.tp8 > -.3)) || x.probe.room !== x.dynamics.room || x.probe.peaksOn !== (x.dynamics.leveler === 'peaks') || x.probe.limiter !== x.dynamics.limiter || x.probe.delays.length || x.probe.error) });
    }
    if (phase('protection')) {
    const protection = [];
    for (const rate of [48000,96000]) for (const ceiling of ['clean','warm']) for (const fixture of ['quarter','impulses','alternating','hot','pink','sweep','stereo']) {
      const id = ['protection',rate,ceiling,fixture].join('_');
      const r = await run({rate,processor:'true-peak',ceiling,fixture,mono:fixture==='hot',seconds:2}, 'isolated');
      const data = decoded(r), input = Buffer.alloc(data.length * 3); data.copy(input);
      const m = await analyze(id,{rate,signal:'protection',neutral:false,stereo:true,delayMs:0,length:r.length},input);
      protection.push({rate,ceiling,fixture,tp4:m.tp4Db,tp8:m.tp8Db,finite:r.finite,errors:r.errors});
    }
    saveCheck('W-BR-TRUEPEAK','Post-ceiling independent 4×/8× peaks meet −0.3 dBTP for impulses at every block offset, phase sweep, pink, hot and stereo-only peaks',protection.every(x=>x.finite&&!x.errors&&x.tp4<=-.3&&x.tp8<=-.3),protection);
    }
    if (phase('switch')) {
    const switching = [];
    for (const rate of [48000,96000]) {
      const prefix = `let scheduledClock=null; const scheduledTasks=[]; const setTimeout=(fn,ms)=>{const t={fn,at:(scheduledClock?scheduledClock.currentTime:0)+ms/1000};scheduledTasks.push(t);return t;};const clearTimeout=t=>{if(t)t.cancelled=true;};`;
      const r = await run({rate},'switchCase',source,prefix);
      const data = decoded(r), input = Buffer.alloc(data.length * 3); data.copy(input);
      const m = await analyze('switch_'+rate,{rate,signal:'switch',neutral:false,stereo:true,delayMs:0,length:r.length},input);
      delete r.data; switching.push({...r,rate,tp4:m.tp4Db,tp8:m.tp8Db});
    }
    saveCheck('W-BR-SWITCH','Every selector pair and 100 rapid toggles: complementary fades, aligned buffering, smooth output, complete parking and zero extra delay',switching.every(x=>x.finite&&x.jump<=.003&&x.peak<=.967&&!x.badSums.length&&!x.probe.error&&x.probe.retirement.pending===0&&x.probe.retirement.timedOut===0&&x.probe.retirement.acked>0&&x.probe.retirement.acked===x.probe.retirement.retired&&x.alignmentError<=1&&!x.probe.delays.length&&!x.probe.unmud&&!x.probe.centre&&!x.probe.peaks&&!x.probe.truepeak&&x.probe.callbacks===x.callbacksAt100Quanta&&!x.unplannedGaps.length&&x.gaps.every(g=>g.to-g.from<=.04)),switching);
    }
    if (phase('parity')) {
    const parity = [], movieGoldens = [], endurance = [];
    const moviePath = join(root,'../movie-sound/bridge/bridge.js');
    const oldMovie = execFileSync('git',['show','d0f171b:bridge/bridge.js'],{cwd:join(root,'../movie-sound'),encoding:'utf8'}).split('const page =')[0].replace(/\bexport /g,'');
    const movieSource = readFileSync(moviePath,'utf8').split('const page =')[0].replace(/\bexport /g,'');
    for (const rate of [48000,96000]) {
      for (const dynamics of [{leveler:'full',limiter:'fast',ceiling:'clean',match:false,room:'off'},{leveler:'peaks',limiter:'truepeak',ceiling:'warm',match:true,room:'both'}]) {
        const s={rate,dynamics,signal:'pink',seconds:1,invert:true,keepSource:true};
        const ext=decoded(await run(s)), movie=decoded(await run(s,'renderMovie',movieSource));
        let maxDiff=0, differing=0, first=-1,last=-1;
        for(let i=0;i<ext.length;i+=4) { const d=Math.abs(ext.readFloatLE(i)-movie.readFloatLE(i)); maxDiff=Math.max(maxDiff,d); if(d>1e-7){differing++;if(first<0)first=i/4;last=i/4;} }
        if(!ext.equals(movie)){writeFileSync(join(dir,'parity_'+rate+'_'+dynamics.leveler+'_ext.f32'),ext);writeFileSync(join(dir,'parity_'+rate+'_'+dynamics.leveler+'_movie.f32'),movie);}
        parity.push({rate,dynamics,first,last,equal:ext.equals(movie),maxDiff,differing,bytes:ext.length});
      }
      const s={rate,dynamics:{leveler:'full',limiter:'fast',ceiling:'clean',match:false,room:'off'},signal:'pink',seconds:1,invert:true};
      const before=decoded(await run(s,'renderMovie',oldMovie)),after=decoded(await run(s,'renderMovie',movieSource));
      movieGoldens.push({rate,equal:before.equals(after),bytes:before.length});
      const r=await run({rate,seconds:60,drain:1,signal:'pink',dynamics:{leveler:'peaks',limiter:'truepeak',ceiling:'warm',match:true,room:'both'}});
      endurance.push({rate,semitones:0,finite:r.finite,errors:r.errors,length:r.length});
      const pitched=await run({rate,seconds:60,drain:1,signal:'pink',movieMode:false,semitones:2,dynamics:{leveler:'peaks',limiter:'truepeak',ceiling:'warm',match:true,room:'both'}});
      endurance.push({rate,semitones:2,pitchWasActive:pitched.pitchWasActive,finite:pitched.finite,errors:pitched.errors,length:pitched.length});
    }
    saveCheck('W-BR-PARITY','Both shipped applications match default and worst-combination offline output within 1e−7',parity.every(x=>x.maxDiff<=1e-7),parity);
    saveCheck('W-BR-MOVIE-GOLDEN','Movie Sound fresh default and drain exactly match its immutable pre-change graph',movieGoldens.every(x=>x.equal),movieGoldens);
    saveCheck('W-BR-ENDURANCE','60-second worst selectable combination is finite with zero processorerror at 48/96 kHz',endurance.every(x=>x.finite&&!x.errors&&(!x.semitones||x.pitchWasActive)),endurance);
    }
    if (phase('restore')) {
      const restored=[];
      const amplitude=(buffer,rate,freq)=>{const n=buffer.length/8,start=n-Math.round(rate*.5);let re=0,im=0,peak=0;for(let i=start;i<n;i++){const v=buffer.readFloatLE(i*4);re+=v*Math.cos(2*Math.PI*freq*i/rate);im+=v*Math.sin(2*Math.PI*freq*i/rate);peak=Math.max(peak,Math.abs(v));}return{amp:2*Math.hypot(re,im)/(n-start),phase:Math.atan2(im,re),peak};};
      for(const rate of [48000,96000]){
        const prefix=`let scheduledClock=null; const scheduledTasks=[]; const setTimeout=(fn,ms)=>{const t={fn,at:(scheduledClock?scheduledClock.currentTime:0)+ms/1000};scheduledTasks.push(t);return t;};const clearTimeout=t=>{if(t)t.cancelled=true;};`;
        const r=await run({rate,restore:true},'switchCase',source,prefix),actual=decoded(r);
        const reference=decoded(await run({rate,signal:'baseline',seconds:2.5,drain:0,bass:14,mid:6,high:6,gain:2.5,dynamics:{leveler:'full',match:false,limiter:'fast',ceiling:'clean',room:'off'}}));
        const probes=[60,1000,8000].map(freq=>{const a=amplitude(actual,rate,freq),b=amplitude(reference,rate,freq);return{freq,deltaDb:db(a.amp/b.amp),peakDelta:a.peak-b.peak,phaseDelaySamples:Math.atan2(Math.sin(a.phase-b.phase),Math.cos(a.phase-b.phase))*rate/(2*Math.PI*freq)};});
        restored.push({rate,probes,probe:r.probe});
      }
      saveCheck('W-BR-RESTORE','After all new switches turn off, settled 60/1000/8000 Hz probes and peaks return to the fresh default with zero extra buffering',restored.every(x=>!x.probe.delays.length&&x.probes.every(p=>Math.abs(p.deltaDb)<=.3&&Math.abs(p.peakDelta)<=.004&&Math.abs(p.phaseDelaySamples)<=1)),restored);
    }
    if (phase('fault')) {
      const faults=[];
      for(const processor of ['unmud','centre-bass','bass-peaks','true-peak']) {
        const prefix=`const NativeAWN=window.AudioWorkletNode;const AudioWorkletNode=class extends NativeAWN{constructor(ctx,name,options){if(name===${JSON.stringify(processor)})throw Error('Injected optional-stage failure');super(ctx,name,options);}};`;
        faults.push({processor,...await run({rate:48000,processor},'faultCase',source,prefix)});
      }
      saveCheck('W-BR-FAIL-CLOSED','Each optional-stage construction failure is visible and remains muted even after selecting direct bypass',faults.every(x=>x.fatal&&x.error&&x.peak<=1e-7),faults);
    }
    if (phase('attack')) {
      const attacks=[],warmDelay=[];
      for(const rate of [48000,96000]) {
        const r=await run({rate,processor:'true-peak',fixture:'attack',seconds:2},'isolated');
        attacks.push({rate,jump:r.jump,finite:r.finite,errors:r.errors});
        const clean=await run({rate,processor:'true-peak',fixture:'tiny-impulse',ceiling:'clean',seconds:2},'isolated');
        const warm=await run({rate,processor:'true-peak',fixture:'tiny-impulse',ceiling:'warm',seconds:2},'isolated');
        warmDelay.push({rate,cleanSamples:clean.peakIndex-rate,warmSamples:warm.peakIndex-rate,warmExtraSamples:warm.peakIndex-clean.peakIndex});
      }
      saveCheck('W-BR-ATTACK','True peak linked attack meets the quiet-channel jump bound at both rates',attacks.every(x=>x.finite&&!x.errors&&x.jump<=(x.rate===48000?.003:.0015)),{attacks,warmDelay});
    }
    if (phase('isolated')) {
    const more = await run({ rate: 48000 }, 'runAdditionalChecks');
    for (const check of more) saveCheck(check.id, check.title, check.ok, check.evidence);    }

  } finally {
    py.stdin.end(); await new Promise(r => py.once('close', r));
    await page.close();
    writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks, null, 2));
  }
}
