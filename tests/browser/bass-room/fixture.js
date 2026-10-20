// Deterministic synthetic material only. No device, media capture or AudioContext.
window.fixture = function fixture(kind, rate, seconds = 10, invertBass = false) {
  const n = Math.round(rate * seconds), x = new Float32Array(n);
  let seed = 0x5eeda11, b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  const rand=()=>{ seed ^= seed<<13; seed ^= seed>>>17; seed ^= seed<<5; return (seed>>>0)/2147483648-1; };
  for(let i=0;i<n;i++) {
    const t=i/rate;
    if(kind.startsWith('sine')) x[i]=0.1*Math.sin(2*Math.PI*Number(kind.slice(4))*t); // -20 dBFS sample amplitude
    else if(kind==='pink') {
      const w=rand(); b0=.99886*b0+w*.0555179;b1=.99332*b1+w*.0750759;b2=.969*b2+w*.153852;
      b3=.8665*b3+w*.3104856;b4=.55*b4+w*.5329522;b5=-.7616*b5-w*.016898;
      x[i]=(b0+b1+b2+b3+b4+b5+b6+w*.5362)*.022;b6=w*.115926;
    } else if(kind==='kick' || kind==='film') {
      // 55 Hz, exponential 90 ms decay, 5 ms raised-cosine onset; at 3, 5, 7 s.
      const since=t-3-2*Math.floor(Math.max(0,t-3)/2);
      const hit=t>=3 && since<.65 ? .6*Math.exp(-since/.09)*Math.min(1,.5-.5*Math.cos(Math.PI*Math.min(1,since/.005)))*Math.sin(2*Math.PI*55*since):0;
      const dialogue=kind==='kick' ? Math.pow(10,-30/20)*Math.sin(2*Math.PI*1000*t)
        : Math.pow(10,-24/20)*(Math.sin(2*Math.PI*700*t)+.5*Math.sin(2*Math.PI*1300*t)+.25*Math.sin(2*Math.PI*2300*t))/Math.sqrt(1+.25+.0625);
      x[i]=dialogue+(invertBass?-hit:hit);
    } else if(kind==='impulse') x[i]=i===Math.round(rate)?0.001:0;
    else if(kind==='tiny60') x[i]=1e-8*Math.sin(2*Math.PI*60*t);
    else if(kind==='overdrive60') x[i]=.8*Math.sin(2*Math.PI*60*t);
    else if(kind==='overdrive1000') x[i]=.8*Math.sin(2*Math.PI*1000*t);
    else if(kind==='isp') x[i]=.8*Math.sin(2*Math.PI*(rate/4)*t+Math.PI/4);
    else throw new Error('unknown fixture '+kind);
    if(!['impulse'].includes(kind)) x[i]*=Math.min(1,t/.02,(seconds-t)/.02); // no artificial truncation edge
  }
  return x;
};
