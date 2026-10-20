// Test-only adapter around the shipped buildAudioGraph. OfflineAudioContext only.
// Synthetic fixture extension is identical to Sol's design-challenge music/dialogue fixtures.
const oldFixture = window.fixture;
window.fixture = function(kind, sr, seconds, invert = false) {
  if (!['music', 'dialogue'].includes(kind)) return oldFixture(kind, sr, seconds, invert);
  const x = oldFixture(kind === 'dialogue' ? 'film' : 'kick', sr, seconds, invert), hits = x.slice();
  for (let n = 0; n < x.length; n++) {
    const t = n / sr, fade = Math.min(1, t / .02, (seconds - t) / .02);
    if (kind === 'music') x[n] = fade * ((invert ? -1 : 1) * (.09 * Math.sin(2 * Math.PI * 60 * t) + .045 * Math.sin(2 * Math.PI * 90 * t)) + .045 * Math.sin(2 * Math.PI * 1000 * t) + .025 * Math.sin(2 * Math.PI * 2300 * t) + .03 * Math.sin(2 * Math.PI * 250 * t)) + (t > 3 ? hits[n] - fade * 10 ** (-30 / 20) * Math.sin(2 * Math.PI * 1000 * t) : 0);
    else x[n] += .018 * fade * Math.sin(2 * Math.PI * 250 * t);
  }
  return x;
};
function pack(channels) {
  const f = new Float32Array(channels.reduce((n, x) => n + x.length, 0));
  let pos = 0;
  for (const ch of channels) { f.set(ch, pos); pos += ch.length; }
  const bytes = new Uint8Array(f.buffer); let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}
async function offlineGraph(s) {
  const sr = s.rate, seconds = s.seconds || 10, length = Math.ceil(sr * (seconds + (s.drain ?? 1)));
  const ctx = new OfflineAudioContext(s.channels || 2, length, sr);
  if (typeof scheduledClock !== 'undefined') scheduledClock = ctx;
  const a = s.signal === 'baseline' ? Float32Array.from({length:Math.ceil(sr*seconds)},(_,i)=>.05*(Math.sin(2*Math.PI*60*i/sr)+Math.sin(2*Math.PI*1000*i/sr)+Math.sin(2*Math.PI*8000*i/sr))) : s.signal === 'switch' ? Float32Array.from({ length: Math.ceil(sr * seconds) }, (_, i) => .005 * Math.sin(2 * Math.PI * 1000 * i / sr)) : fixture(s.signal || 'sine60', sr, seconds);
  const b = s.invert ? a.map(x => -x) : a;
  const buf = ctx.createBuffer(s.mono ? 1 : 2, s.keepSource ? length : a.length, sr); buf.copyToChannel(a, 0); if (!s.mono) buf.copyToChannel(b, 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  currentStream = {}; captureGen = 0;
  currentParams = { bass: s.bass ?? 28, hpf: 20, mid: s.mid ?? 12, high: s.high || 0, gain: s.gain ?? 2.5, semitones: s.semitones || 0, autoBalance: s.auto !== false, bypass: false, stageBypass: {} };
  currentDynamics = normaliseDynamics(s.dynamics || { leveler: 'peaks', limiter: s.limiter || 'truepeak', ceiling: s.ceiling || 'clean', room: s.room || 'off' });
  makeAudioContext = () => ctx;
  ctx.createMediaStreamSource = () => src;
  const offlineResume = ctx.resume.bind(ctx); ctx.resume = async () => {};
  const token = currentStream, g = await buildAudioGraph(token, s.movieMode !== false, 0);
  ctx.resume = offlineResume;
  if (!g || g.error) throw Error(JSON.stringify(g));
  installGraph(g);
  let errors = 0;
  for (const node of [g.pitchNode, g.bandLevelerNode, g.matchNode, g.lookaheadNode, br.unmud, br.centre, br.peaks, br.truepeak].filter(Boolean)) node.addEventListener('processorerror', () => errors++);
  g.outputSum.connect(ctx.destination);
  src.start();
  return { ctx, g, src, a, seconds, errors: () => errors };
}
async function renderCase(s) {
  const { ctx, g, src, seconds, errors } = await offlineGraph({ ...s, channels: 6 });
  // Six analysis channels follow the original challenge's convention.
  g.outputSum.disconnect(ctx.destination);
  const merger = ctx.createChannelMerger(6), tap = (node, c, both = false) => {
    const sp = ctx.createChannelSplitter(2); node.connect(sp); sp.connect(merger, 0, c); if (both) sp.connect(merger, 1, c + 1);
  };
  tap(g.outputSum, 0, true); tap(src, 2); tap(g.highNode, 3); tap(g.volumeGain, 4); tap(src, 5);
  // The analysis uses six channels, so render a six-channel context from construction.
  merger.connect(ctx.destination);
  const r = await ctx.startRendering();
  const flat = Array.from({ length: 6 }, (_, i) => r.getChannelData(i));
  const result = { data: pack(flat), length: r.length, finite: flat.every(x => x.every(Number.isFinite)), errors: errors(), probe: typeof bassRoomProbe === 'function' ? bassRoomProbe() : { delays: [] } };
  return result;
}
async function renderStereo(s) {
  const { ctx, g, errors } = await offlineGraph(s);
  const prime = s.semitones ? ctx.suspend(.3) : null;
  const rendering = ctx.startRendering();
  let pitchWasActive = false;
  if (prime) {
    await prime;
    await new Promise(resolve => window.setTimeout(resolve, 0));
    if (!pitchPrimed) throw Error('Pitch did not prime during worst-combination endurance');
    applyRoutingState({ immediate: true });
    pitchWasActive = g.pitchWetGain.gain.value === 1;
    await ctx.resume();
  }
  const r = await rendering;
  return { data: pack([r.getChannelData(0), r.getChannelData(1)]), length: r.length, finite: [0, 1].every(c => r.getChannelData(c).every(Number.isFinite)), errors: errors(), pitchWasActive, probe: typeof bassRoomProbe === 'function' ? bassRoomProbe() : { delays: [] } };
}

async function isolated(s) {
  const sr=s.rate, seconds=s.seconds||1.5, len=Math.ceil(sr*seconds), ctx=new OfflineAudioContext(2,len,sr);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL(DYN_WORKLET));
  const node=new AudioWorkletNode(ctx,s.processor,{numberOfInputs:s.processor==='unmud'?2:1,numberOfOutputs:1,outputChannelCount:[2],channelCount:2,channelCountMode:'explicit'});
  let dip=0,errors=0; node.port.onmessage=e=>{dip=Math.max(dip,e.data.dip||0);};node.onprocessorerror=()=>errors++;
  const audio=ctx.createBuffer(s.mono?1:2,len,sr),key=ctx.createBuffer(2,len,sr);let seed=99,pink=0,phase=0;
  for(let i=0;i<len;i++) {
    const t=i/sr;let l=(s.amplitude??.001)*Math.sin(2*Math.PI*(s.frequency||250)*t),r=s.invert?-l:l;
    if(s.fixture){
      if(s.fixture==='attack')l=.3*Math.cos(2*Math.PI*60*(t+.005));
      if(s.fixture==='tiny-impulse')l=i===sr?.001:0;
      if(s.fixture==='quarter')l=Math.sin(Math.PI*i/2+Math.PI/4);
      if(s.fixture==='impulses')l=i%400<128&&Math.floor(i/400)%128===i%400?4:0;
      if(s.fixture==='alternating')l=i%301===0?(Math.floor(i/301)%2?-4:4):0;
      if(s.fixture==='hot')l=4*Math.sin(2*Math.PI*60*t);
      if(s.fixture==='sweep'){phase+=2*Math.PI*(.1+.39*i/len);l=1.5*Math.sin(phase+(s.phase||0));}
      if(s.fixture==='pink'){seed=(seed*1664525+1013904223)>>>0;pink=.95*pink+(seed/2147483648-1)*.4;l=pink;}
      r=s.fixture==='stereo'?(i%307===0?4:0):s.invert?-l:l;if(s.fixture==='stereo')l=0;if(s.fixture==='attack')r=i===sr?4:0;
      if(i>=len-2048)l=r=0;
    }
    audio.getChannelData(0)[i]=l;if(!s.mono)audio.getChannelData(1)[i]=r;
    const k=s.key===false?0:.2*Math.sin(2*Math.PI*60*t);key.getChannelData(0)[i]=k;key.getChannelData(1)[i]=s.keyInvert?-k:k;
  }
  const src=ctx.createBufferSource();src.buffer=audio;src.connect(node);src.start();
  if(s.processor==='unmud'){const ks=ctx.createBufferSource();ks.buffer=key;ks.connect(node,0,1);ks.start();}
  let output=node;
  if(s.ceiling){const sh=ctx.createWaveShaper();sh.curve=s.ceiling==='warm'?makeWarmCurve():makeCeilingCurve();sh.oversample=s.ceiling==='warm'?'4x':'none';if(s.ceiling==='warm'){const trim=ctx.createGain();trim.gain.value=.5;output.connect(trim);output=trim;}output.connect(sh);output=sh;}
  output.connect(ctx.destination);const rendered=await ctx.startRendering(),L=rendered.getChannelData(0),R=rendered.getChannelData(1);
  const amp=(x,f)=>{let re=0,im=0,start=Math.floor(sr*(seconds-Math.min(1,seconds/2))),n=len-start;for(let i=start;i<len;i++){re+=x[i]*Math.cos(2*Math.PI*f*i/sr);im+=x[i]*Math.sin(2*Math.PI*f*i/sr);}return 2*Math.hypot(re,im)/n;};
  let nullError=0,peak=0,peakIndex=0,jump=0;for(let i=0;i<len;i++){nullError=Math.max(nullError,Math.abs(L[i]-audio.getChannelData(0)[i]));if(Math.abs(L[i])>peak){peakIndex=i;}peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));if(i>sr*.9&&i<sr*1.1)jump=Math.max(jump,Math.abs(L[i]-L[i-1]));}
  return{data:pack([L,R]),length:len,gainDb:20*Math.log10(amp(L,s.frequency||250)/(s.amplitude??.001)),nullError,peak,peakIndex,jump,dip,errors,finite:L.every(Number.isFinite)&&R.every(Number.isFinite)};
}
async function switchCase(s) {
  const intendedDips=[], originalRamp=rampGain;
  rampGain=(node,to,dur,ctx)=>{if(to===0&&dur===BASS_DIP_DOWN)intendedDips.push({from:ctx.currentTime,to:ctx.currentTime+.1});return originalRamp(node,to,dur,ctx);};
  const changes=[],defaults={leveler:'full',limiter:'fast',ceiling:'clean',match:false,room:'off'};let at=.15;
  for(const[field,choices]of Object.entries({leveler:['full','slow','bass','peaks'],room:['off','unmud','centre','both'],limiter:['fast','lookahead','truepeak'],ceiling:['clean','warm']})){
    for(const a of choices)for(const b of choices)if(a!==b){changes.push({at,dynamics:{...defaults,[field]:a}});at+=.3;changes.push({at,dynamics:{...defaults,[field]:b}});at+=.3;}
    changes.push({at,dynamics:defaults});at+=.4;
  }
  for(const auto of [false,true,false,true]){changes.push({at,dynamics:defaults,auto});at+=.3;}
  for(let i=0;i<100;i++){changes.push({at,dynamics:i%2?defaults:{leveler:'peaks',limiter:'truepeak',room:'both',ceiling:'warm',match:false}});at+=.01;}changes.push({at,dynamics:defaults});
  if(s.restore){changes.length=0;changes.push({at:.25,dynamics:{leveler:'peaks',limiter:'truepeak',room:'both',ceiling:'warm',match:false}},{at:1,dynamics:defaults});at=1;}
  const{ctx,g}=await offlineGraph({...s,signal:s.restore?'baseline':'switch',seconds:at+1.5,drain:0,bass:s.restore?14:0,mid:s.restore?6:0,high:s.restore?6:0,gain:s.restore?2.5:1,dynamics:defaults});scheduledClock=ctx;g.live=true;
  let change=0,badSums=[],alignmentError=0,lastCallbacks=0;const quanta=Math.floor(ctx.length/256)-1,waits=[];
  for(let q=1;q<=quanta;q++)waits.push(ctx.suspend((q*256+64)/ctx.sampleRate));const rendered=ctx.startRendering();
  for(const wait of waits){await wait;let guard=0;while(guard++<1000){const due=scheduledTasks.find(x=>!x.cancelled&&x.at<=ctx.currentTime+1e-9);if(!due)break;due.cancelled=true;due.fn();}
    while(change<changes.length&&changes[change].at<=ctx.currentTime){const next=changes[change++];currentDynamics=normaliseDynamics(next.dynamics);if('auto'in next)currentParams.autoBalance=next.auto;applyRoutingState();}
    const p=bassRoomProbe();if(Object.values(p.sums).some(x=>x!=null&&x>1.000001))badSums.push({t:ctx.currentTime,...p});
    for(const pad of Object.values(br.pad).filter(Boolean))alignmentError=Math.max(alignmentError,Math.abs(pad.delayTime.value*s.rate-Math.round(pad.delayTime.value*s.rate)));
    if(ctx.currentTime>at+1)lastCallbacks=p.callbacks;await ctx.resume();
  }
  const r=await rendered;await new Promise(resolve=>window.setTimeout(resolve,0));const L=r.getChannelData(0),R=r.getChannelData(1);let jump=0,jumpAt=0,peak=0,longestZero=0,zeros=0;const gaps=[];
  for(let i=1;i<L.length;i++){if(i>s.rate*.1&&Math.abs(L[i]-L[i-1])>jump){jump=Math.abs(L[i]-L[i-1]);jumpAt=i/s.rate;}peak=Math.max(peak,Math.abs(L[i]),Math.abs(R[i]));if(Math.abs(L[i])>=1e-9&&zeros>32)gaps.push({from:(i-zeros)/s.rate,to:i/s.rate});zeros=Math.abs(L[i])<1e-9&&Math.abs(R[i])<1e-9?zeros+1:0;longestZero=Math.max(longestZero,zeros);}
  return{data:pack([L,R]),length:r.length,finite:L.every(Number.isFinite)&&R.every(Number.isFinite),jump,jumpAt,peak,gaps,unplannedGaps:gaps.filter(g=>g.from>.02&&!intendedDips.some(w=>g.from>=w.from&&g.to<=w.to)),badSums:badSums.slice(0,3),alignmentError,longestZero,probe:bassRoomProbe(),callbacksAt100Quanta:lastCallbacks,changes:changes.length};
}
async function runAdditionalChecks(){
  const unmud=[],centre=[];
  for(const rate of[48000,96000]){
    for(const frequency of[60,250,1000]){const hot=await isolated({rate,processor:'unmud',frequency}),quiet=await isolated({rate,processor:'unmud',frequency,key:false}),inv=await isolated({rate,processor:'unmud',frequency,keyInvert:true}),expected=frequency===60?-.132:frequency===250?-3:-.143;
      unmud.push({rate,frequency,hot:hot.gainDb,quiet:quiet.gainDb,inverted:inv.gainDb,ok:Math.abs(hot.gainDb-expected)<=.05&&Math.abs(quiet.gainDb)<=.02&&Math.abs(inv.gainDb-hot.gainDb)<=.01&&hot.finite&&hot.dip<=3.01});}
    const mono=await isolated({rate,processor:'centre-bass',frequency:60,amplitude:.2,mono:true});centre.push({rate,mono:mono.nullError,ok:mono.nullError<=1e-7});
    for(const[frequency,expected]of[[1,-8],[20,-7.65],[100,-4],[1000,-.0905]]){const x=await isolated({rate,processor:'centre-bass',frequency,amplitude:.2,invert:true,seconds:frequency===1?4:2});centre.push({rate,frequency,gain:x.gainDb,ok:Math.abs(x.gainDb-expected)<=.05&&x.finite&&x.peak>1e-5});}
  }
  return[{id:'W-BR-UNMUD',title:'Unmud isolated bell, silent key and anti-phase detector agree at both rates',ok:unmud.every(x=>x.ok),evidence:unmud},{id:'W-BR-CENTRE',title:'Centre bass preserves mono and meets the prewarped side-shelf transfer at both rates',ok:centre.every(x=>x.ok),evidence:centre}];
}
async function renderMovie(s) {
  const sr=s.rate,seconds=s.seconds||1,length=Math.round(sr*(seconds+1)),ctx=new OfflineAudioContext(2,length,sr);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('dynamics.worklet.js'));
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('pitch-shifter.worklet.js'));
  const a=fixture(s.signal||'pink',sr,seconds),buf=ctx.createBuffer(2,s.keepSource?length:a.length,sr);buf.copyToChannel(a,0);buf.copyToChannel(s.invert?a.map(x=>-x):a,1);
  const src=ctx.createBufferSource();src.buffer=buf;
  const g=wireGraph(ctx,src,{bass:s.bass??28,hpf:20,mid:s.mid??12,high:s.high||0,gain:s.gain??2.5,semitones:0,autoBalance:true,bypass:false},s.dynamics,{worklets:true,band:0,trim:0,lookahead:0});
  src.start();const r=await ctx.startRendering();return{data:pack([r.getChannelData(0),r.getChannelData(1)]),length:r.length,error:g.dynError};
}
async function faultCase(s) {
  const {ctx,g}=await offlineGraph({ ...s, seconds:.3,drain:.2,signal:'pink',dynamics:{leveler:s.processor==='bass-peaks'?'peaks':'full',limiter:s.processor==='true-peak'?'truepeak':'fast',ceiling:'clean',room:s.processor==='unmud'?'unmud':s.processor==='centre-bass'?'centre':'off'} });
  currentParams.bypass=true;applyRoutingState({immediate:true});
  const r=await ctx.startRendering();let peak=0;for(const c of[0,1])for(const x of r.getChannelData(c))peak=Math.max(peak,Math.abs(x));
  return{peak,error:dynError,fatal:br.fatal,probe:bassRoomProbe()};
}
