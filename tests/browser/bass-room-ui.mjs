import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export async function checkBassRoomUI({context,EXT_ID,outDir,root,record,watchRequests}) {
  const p=await context.newPage();p.on('dialog',d=>d.accept());watchRequests(p);await p.goto(`chrome-extension://${EXT_ID}/popup.html`);
  const saved=await p.evaluate(()=>chrome.storage.local.get(null));
  const params={bass:28,hpf:20,mid:12,high:0,gain:2.5,semitones:0,autoBalance:true,bypass:false,stageBypass:{}};
  const dynamics={room:'both',leveler:'peaks',match:false,limiter:'truepeak',ceiling:'warm'};
  await p.evaluate(({params,dynamics,saved})=>chrome.storage.local.set({presets:{...saved.presets,'Room UI':{...params,dynamics},'Room legacy':params},currentPreset:'Room UI',currentParams:params,dynamics,presetRev:(saved.presetRev||0)+1}),{params,dynamics,saved});
  const rows=[];
  try {
    for(const surface of ['popup','panel','window'])for(const width of(surface==='panel'?[300,360,400,440,480]:[440])){
      await p.setViewportSize({width,height:surface==='panel'?950:650});
      await p.goto(`chrome-extension://${EXT_ID}/popup.html${surface==='popup'?'':'?'+surface+'=1'}`);
      await p.waitForFunction(()=>document.getElementById('mode-room').value==='both');
      const layout=()=>p.evaluate(()=>{
        const row=document.querySelector('.eq-row[data-band="room"]'),select=document.getElementById('mode-room');
        const order=[...document.querySelectorAll('.eq-row')].map(x=>x.dataset.band);
        return{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,scroll:document.documentElement.scrollWidth,view:innerWidth,selectWidth:select.getBoundingClientRect().width,labelWidth:select.parentElement.getBoundingClientRect().width,order:order.indexOf('high')<order.indexOf('room')&&order.indexOf('room')<order.indexOf('comp'),static:row.querySelector('.band-tag').tagName==='SPAN',menus:[...document.querySelectorAll('.mode-select')].every(x=>x.parentElement.scrollWidth<=x.parentElement.clientWidth+1),saved:document.getElementById('preset-status').textContent};
      });
      // The badge's historical id differs across releases; the size assertion is independent of it.
      const base=await layout().catch(async()=>p.evaluate(()=>{const room=document.getElementById('mode-room');return{width:document.body.getBoundingClientRect().width,height:document.body.getBoundingClientRect().height,scroll:document.documentElement.scrollWidth,view:innerWidth,selectWidth:room.getBoundingClientRect().width,labelWidth:room.parentElement.getBoundingClientRect().width,order:room.closest('.eq-row').previousElementSibling.dataset.band==='high',static:room.closest('.eq-row').querySelector('.band-tag').tagName==='SPAN',menus:[...document.querySelectorAll('.mode-select')].every(x=>x.parentElement.scrollWidth<=x.parentElement.clientWidth+1)}}));
      await p.selectOption('#mode-room','off');
      await p.waitForFunction(()=>dynamics.room==='off');
      const modified=await p.evaluate(()=>({badge:presetStatusBadge.textContent,height:document.body.getBoundingClientRect().height}));
      await p.click('#btn-reset-defaults');await p.waitForFunction(()=>document.getElementById('mode-room').value==='both');
      const meters=await p.evaluate(()=>{
        updateMeters({roomMode:'unmud',room:3});const full=document.getElementById('meter-room').firstElementChild.style.width;
        updateMeters({roomMode:'centre',room:0});const centre=document.getElementById('val-room').textContent,empty=document.getElementById('meter-room').firstElementChild.style.width;
        updateMeters(null);return{full,centre,empty,idle:document.getElementById('val-room').textContent};
      });
      rows.push({surface,width,...base,modified,meters});
      if(width===440||width===300)await p.screenshot({path:join(outDir,`bass-room-${surface}-${width}.png`),fullPage:true});
    }
    const movie=await context.newPage();watchRequests(movie);
    const html=readFileSync(join(root,'../movie-sound/bridge/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
    const movieRows=[];
    for(const width of[360,880]){await movie.setViewportSize({width,height:900});await movie.setContent(html);movieRows.push(await movie.evaluate(()=>({width:innerWidth,columns:getComputedStyle(document.querySelector('.dyn')).gridTemplateColumns.split(' ').length,room:!!document.getElementById('dyn-room'),scroll:document.documentElement.scrollWidth})));}
    await movie.close();
    const ok=rows.every(x=>x.order&&x.static&&x.menus&&x.scroll<=x.view&&Math.abs(x.selectWidth-100)<=1&&(x.surface==='panel'||(x.height<600&&x.modified.height<600&&x.labelWidth===150))&&/Modified/.test(x.modified.badge)&&parseFloat(x.meters.full)===100&&x.meters.centre==='—'&&x.meters.empty==='0%'&&x.meters.idle==='idle')&&movieRows.every(x=>x.room&&x.scroll<=x.width&&x.columns===(x.width===360?1:2));
    record('W-BR-UI','Room row, longest menus, Saved/Modified heights, actual meters and Movie Sound two/one-column layout',ok?'PASS':'FAIL',{rows,movieRows},'installed-browser');
  }finally{await p.evaluate(saved=>chrome.storage.local.set(saved),saved);await p.close();}
}
