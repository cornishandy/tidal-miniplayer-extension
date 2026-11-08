// Focused layout regression: real action popup, then responsive panel/fallback documents.
// Usage: CHROME_BIN=/path/to/chrome node tests/browser/progress-layout.mjs <scratch-extension> <evidence-dir>
// Uses a disposable profile, synthetic metadata, blocked networking and disabled audio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawn} from 'node:child_process';
if (!process.argv[2] || !process.argv[3]) throw Error('Expected scratch-extension and evidence-dir');
const out=path.resolve(process.argv[3]);
fs.mkdirSync(out,{recursive:true});
const ext=fs.realpathSync(process.argv[2]);
const extId=[...createHash('sha256').update(ext).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const profile=fs.mkdtempSync(path.join(out,'profile-'));
const chrome=process.env.CHROME_BIN || path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const browser=spawn(chrome,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,'--mute-audio','--disable-audio-output','--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check','--no-proxy-server','--host-resolver-rules=MAP * ~NOTFOUND','about:blank'],{stdio:['ignore','ignore','pipe']});
let ws,seq=0;const pending=new Map();const log={};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...sessionId?{sessionId}:{}}));setTimeout(()=>{if(pending.delete(id))reject(Error('timeout '+method));},10000).unref();});}
async function ev(session,expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function attach(id){return (await call('Target.attachToTarget',{targetId:id,flatten:true})).sessionId;}
try{
 const endpoint=await new Promise((res,rej)=>{let s='';browser.stderr.on('data',b=>{s+=b;let m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m)res(m[1]);});browser.on('exit',c=>rej(Error('Chrome exit '+c)));setTimeout(()=>rej(Error('Chrome timeout')),15000).unref();});
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});ws.onmessage=e=>{let m=JSON.parse(e.data);if(m.id){let p=pending.get(m.id);pending.delete(m.id);m.error?p?.reject(Error(JSON.stringify(m.error))):p?.resolve(m.result);}};
 await delay(1200);log.initial=await call('Target.getTargets');
 const worker=log.initial.targetInfos.find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extId}/background.js`);if(!worker)throw Error('No extension worker');
 const sw=await attach(worker.targetId);log.worker=worker;
 log.open=await ev(sw,'chrome.action.openPopup().then(()=>"opened",e=>({error:e.message}))');
 await delay(600);log.openTargets=await call('Target.getTargets');
 const popup=log.openTargets.targetInfos.find(t=>t.url===worker.url.replace('background.js','popup.html'));if(!popup)throw Error('No popup target after action.openPopup');
 let s=await attach(popup.targetId);log.popup=popup;
 log.identity=await ev(s,`({url:location.href,viewIsPopup:chrome.extension.getViews({type:'popup'}).includes(window),innerWidth,innerHeight,outerWidth,outerHeight,userAgent:navigator.userAgent})`);
 assert.equal(log.open,'opened');
 assert.equal(log.identity.viewIsPopup,true);
 log.layouts={};
 for(const layout of ['actualpopup','panel390','window1280']) {
 if(layout!=='actualpopup') {
  const url=worker.url.replace('background.js',layout==='panel390'?'popup.html?panel=1':'popup.html?undocked=true');
  const target=await call('Target.createTarget',{url});
  s=await attach(target.targetId);
  await call('Emulation.setDeviceMetricsOverride',{width:layout==='panel390'?390:1280,height:900,deviceScaleFactor:1,mobile:false},s);
  await delay(600);
 }
 log.layouts[layout]={};
 await ev(s,'clearInterval(trackPollInterval)');
 const art='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="#7154b0"/><text x="12" y="70" fill="white">TEST ART</text></svg>');
 for(const mode of ['noart','art','noart-again']){
  await ev(s,`updatePlayerUI(${JSON.stringify({title:'Synthetic audit track',artist:'Synthetic fixture artist',currentTime:80,duration:240,isPlaying:true,favoriteFound:true,isFavorite:false,artwork:mode==='art'?art:null})})`);await delay(150);
  const measure=await ev(s,`(()=>{const sel=['body','.popup-container','.popup-main','.np','.np-main','#player-title','.np-artist','.transport','#player-btn-play','#art-cover','.progress'];return {innerWidth,innerHeight,nodes:Object.fromEntries(sel.map(k=>{let e=document.querySelector(k),c=getComputedStyle(e),r=e.getBoundingClientRect();return [k,{text:e.innerText,rect:JSON.parse(JSON.stringify(r)),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,display:c.display,flex:c.flex,position:c.position,width:c.width,minWidth:c.minWidth,hidden:e.hidden,gridTemplateAreas:c.gridTemplateAreas}]}))}})()`);
  log.layouts[layout][mode]=measure;fs.writeFileSync(path.join(out,layout+'-'+mode+'.json'),JSON.stringify(measure,null,2));
  const shot=await call('Page.captureScreenshot',{format:'png'},s);fs.writeFileSync(path.join(out,layout+'-'+mode+'.png'),Buffer.from(shot.data,'base64'));
 }
 }
 // Assert after collecting all states, so a failing baseline still preserves every measurement.
 for(const [layout,states] of Object.entries(log.layouts)) for(const [mode,m] of Object.entries(states)) {
  const n=m.nodes, title=n['#player-title'], play=n['#player-btn-play'];
  assert.equal(m.innerWidth,layout==='actualpopup'?440:layout==='panel390'?390:1280);
  assert.equal(play.rect.width,40,`${layout}/${mode}: play width`);
  assert.equal(play.rect.height,40,`${layout}/${mode}: play height`);
  assert.ok(title.clientWidth>=title.scrollWidth,`${layout}/${mode}: synthetic title must be readable`);
  assert.ok(n['.transport'].clientWidth>=n['.transport'].scrollWidth,`${layout}/${mode}: transport must fit`);
  assert.ok(n['.progress'].rect.y>=n['.transport'].rect.bottom,`${layout}/${mode}: progress below transport`);
  if(layout==='panel390') assert.equal(n['.np'].display,'grid');
 }
 log.assertions='passed';
}catch(e){log.error=String(e);process.exitCode=1;console.error(e);}finally{
 if(ws?.readyState===1){try{await call('Browser.close');}catch{}ws.close();}
 if(browser.exitCode===null){browser.kill('SIGTERM');await new Promise(r=>browser.once('exit',r));}
 fs.rmSync(profile,{recursive:true,force:true});log.cleanup={browserStopped:browser.exitCode!==null,profileRemoved:!fs.existsSync(profile)};fs.writeFileSync(path.join(out,'probe.json'),JSON.stringify(log,null,2));console.log(JSON.stringify(log));
}
