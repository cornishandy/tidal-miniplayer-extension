import sys,json,pathlib,numpy as np
from scipy.signal import butter,sosfiltfilt,firwin,resample_poly
OUT=pathlib.Path(sys.argv[1])
FIR=firwin(257,1/4,window=('kaiser',12))
def db(x):return float(20*np.log10(max(float(x),1e-20)))
def rms(x):return float(np.sqrt(np.mean(x*x)))
def amplitude(x,f,sr,a=8,b=9):
 z=x[int(a*sr):int(b*sr)];t=np.arange(len(z))/sr
 return abs(2*np.mean(z*np.exp(-2j*np.pi*f*t)))
def run(id):
 m=json.loads((OUT/(id+'.json')).read_text());sr=m['rate'];a=np.fromfile(OUT/(id+'.f32'),dtype='<f4').reshape(6,-1).astype(float);delay=round(m['delayMs']*sr/1000);y=a[0,delay:];x=a[2,:len(y)]
 m['peakDb']=db(np.max(np.abs(a[:2])));m['tp4Db']=max(db(np.max(np.abs(resample_poly(z,4,1,window=FIR)))) for z in a[:2]);m['finite']=bool(np.all(np.isfinite(a)))
 sos=butter(6,150,fs=sr,output='sos');yl=sosfiltfilt(sos,y);xl=sosfiltfilt(sos,x)
 def gain(a0,b0):
  lo,hi=int(a0*sr),int(b0*sr);v=rms(xl[lo:hi]) if len(xl[lo:hi]) else 0;return db(rms(yl[lo:hi])/v) if v>1e-5 else None
 m['steadyBassDb']=gain(1.6,2.6);m['hitBassDb']=gain(3.02,3.30)
 m['voiceDipDb']=None;m['voiceGainDb']=None;m['body250DipDb']=None
 if m['signal'] in ['kick','film','music','dialogue']:
  f=700 if m['signal'] in ['film','dialogue'] else 1000;t=np.arange(len(y))/sr;v=y*np.exp(-2j*np.pi*f*t);lp=butter(4,15,fs=sr,output='sos');env=2*np.abs(sosfiltfilt(lp,v));ref=np.mean(env[int(2.4*sr):int(2.8*sr)]);m['voiceDipDb']=min(0,db(np.min(env[int(3.02*sr):int(3.65*sr)])/max(ref,1e-15)));m['voiceGainDb']=db(ref/amplitude(x,f,sr,2.4,2.8))
  if m['signal'] in ['music','dialogue']:
   env=2*np.abs(sosfiltfilt(lp,y*np.exp(-2j*np.pi*250*t)));ref=np.mean(env[int(2.4*sr):int(2.8*sr)]);m['body250DipDb']=min(0,db(np.min(env[int(3.02*sr):int(3.65*sr)])/max(ref,1e-15)))
 m['tp8Db']=None
 if not m['neutral'] and m['signal'] in ['sine60','overdrive60','isp','pink','music','dialogue','matrix','protection','switch']:
  fir8=firwin(1025,1/8,window=('kaiser',12));m['tp8Db']=max(db(np.max(np.abs(resample_poly(z,8,1,window=fir8)))) for z in (a[:2] if m.get('stereo') else a[:1]))
 if m['signal'] in ['sine60','overdrive60','sine1000','overdrive1000']:
  f=60 if m['signal'].endswith('60') else 1000;lo,hi=8*sr,9*sr;t=np.arange(sr)/sr;z=y[lo:hi];z0=z-np.mean(z);sin=np.sin(2*np.pi*f*t);cos=np.cos(2*np.pi*f*t);fit=2*np.mean(z0*sin)*sin+2*np.mean(z0*cos)*cos
  m['thdnPct']=100*rms(z0-fit)/max(rms(fit),1e-20);m['thd2to10Pct']=100*np.sqrt(sum(amplitude(y,f*k,sr)**2 for k in range(2,11) if f*k<sr/2))/max(amplitude(y,f,sr),1e-20)
 else:m['thdnPct']=None;m['thd2to10Pct']=None
 (OUT/(id+'.metrics.json')).write_text(json.dumps(m,indent=2));(OUT/(id+'.f32')).unlink();return m
for line in sys.stdin:
 try:print(json.dumps(run(json.loads(line)['id'])),flush=True)
 except Exception as e:print(json.dumps({'error':str(e)}),flush=True)
