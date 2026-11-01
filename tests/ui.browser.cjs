const {chromium,webkit}=require('playwright'); const assert=require('node:assert/strict');
(async()=>{
 const kind=process.env.TEST_BROWSER==='webkit'?webkit:chromium;
 const browser=await kind.launch(kind===chromium?{executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader'],proxy:{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}}:{headless:true,proxy:{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}});
 const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
 await page.route('**/*.html',r=>r.fulfill({contentType:'text/html',body:require('node:fs').readFileSync('自然地理生成器.html','utf8').replaceAll('generate(randomSeed())',"generate('549589336')")}));
 await page.goto('http://127.0.0.1:8000/'+encodeURIComponent('自然地理生成器.html'));
 await page.waitForFunction(()=>!!window.__geo,{},{timeout:30000});
 assert.equal(await page.locator('#volcanoPanel').count(),1,'individual eruption controls exist');
 await page.locator('#btnView').click();
 assert.equal(await page.locator('#displayModes button').count(),7);
 await page.locator('#displayModes button').filter({hasText:'地質'}).click();
 assert.equal(await page.locator('#btnView').textContent(),'表示：地質');
 await page.waitForFunction(()=>window.__geo.world && window.__geo.volcanoReady(),{},{timeout:240000});
 console.log('world ready');
 const terrain=await page.evaluate(()=>{
  const g=window.__geo,w=g.world,e=w.elev,n=Math.sqrt(e.length);let land=0,max=-Infinity,edge=true;
  for(let i=0;i<e.length;i++){if(e[i]>0)land++;if(e[i]>max)max=e[i];if((i<n||i>=e.length-n||i%n===0||i%n===n-1)&&e[i]>=0)edge=false;}
  const before=Array.from(e),camera=JSON.stringify(g.cam);
  for(const mode of ['standard','direct','mountain','standard'])g.setTerrainSampling(mode);
  return {land:land/e.length,max,edge,unchanged:before.every((v,i)=>v===e[i]),camera:camera===JSON.stringify(g.cam)};
 });console.log('terrain',terrain);assert.ok(terrain.edge&&terrain.unchanged&&terrain.camera);assert.ok(terrain.land>.42&&terrain.land<.47);

 await page.locator('#btnView').click();
 for(const id of ['displayLabels','displayFeatures','displayVolcanoes'])await page.locator('#'+id).uncheck();
 const hidden=await page.evaluate(async()=>(await window.__geo.serializeState()).view);
 assert.equal(hidden.labels,false);assert.equal(hidden.features,false);assert.equal(hidden.markers,false);
 assert.equal(await page.locator('#labels .plabel:visible').count(),0);
 for(const id of ['displayLabels','displayFeatures','displayVolcanoes'])await page.locator('#'+id).check();
 await page.locator('#displayClose').click();
 console.log('PASS map annotation toggles and saved visibility state');

 await page.locator('#btnFullscreen').click();
 assert.equal(await page.evaluate(()=>!!document.fullscreenElement),true);
 await page.locator('#btnFullscreen').click();

 const sample=await page.evaluate(()=>Array.from(window.__geo.world.elev.slice(0,100)));
 for(const scale of [1,1.5,2,10,20])await page.evaluate(s=>window.__geo.setHeightScale(s),scale);
 assert.deepEqual(await page.evaluate(()=>Array.from(window.__geo.world.elev.slice(0,100))),sample);
 const id=await page.evaluate(()=>window.__geo.world.volcanoes.findIndex(v=>v.active)); assert.ok(id>=0);
 await page.evaluate(i=>{const g=window.__geo,v=g.world.volcanoes[i];Object.assign(g.cam,{tx:v.x-1500,tz:v.y-1500,dist:100,pitch:1});g.updateCamera();g.openVolcano(i);},id);
 await page.waitForFunction(()=>window.__geo.volcanoRenderState().patches>0);
 console.log('PASS fine volcano terrain before eruption');
 assert.equal(await page.locator('#volcanoPanel [data-level]').count(),4);
 await page.locator('#volcanoPanel [data-level="1"]').click();
 await page.waitForFunction(()=>window.__geo.volcanoReady());
 await page.waitForFunction(()=>window.__geo.sim?.plumes.some(p=>p.pts.geometry.attributes.aAlpha.array.some(a=>a>0)));
 assert.equal(await page.locator('#toasts .toast').count(),0,'history notifications do not obstruct view');
 console.log('PASS visible smoke particles, no toast overlay, 10x/20x and fullscreen');

 await page.evaluate(()=>window.__geo.stepVolcanoDays(2));
 await page.evaluate(async()=>{window.testVolcanoSave=await window.__geo.serializeState();});
 const snapshot=await page.evaluate(()=>({volcano:!!window.testVolcanoSave.volcano}));
 assert.ok(snapshot.volcano,'worker snapshot included');
 assert.ok(await page.evaluate(()=>window.__geo.volcanoMetrics().sourceDRE>0),'eruption injected material');
 const r=await page.evaluate(()=>({w:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(r.scroll<=r.w);
 const expected=await page.evaluate(async()=>{await window.__geo.stepVolcanoDays(3);return (await window.__geo.serializeState()).volcano;});
 await page.evaluate(()=>window.__geo.loadState(window.testVolcanoSave));
 await page.waitForFunction(()=>window.__geo.world && window.__geo.volcanoReady(),{},{timeout:240000});
 await page.evaluate(()=>window.__geo.stepVolcanoDays(3));
 assert.deepEqual(await page.evaluate(async()=>(await window.__geo.serializeState()).volcano),expected,'save/load continuation is identical');
 console.log('PASS save/load deterministic continuation');
 await page.evaluate(()=>window.__geo.labRestore());
 assert.equal(await page.evaluate(()=>window.__geo.volcanoMetrics().sourceDRE),0,'reset removes volcanic deposits');
 assert.equal(await page.evaluate(()=>window.__geo.volcanoReady()),true);
 assert.deepEqual(errors,[]); console.log('PASS mobile view, scales, individual eruption, worker advance, snapshot, no JS errors');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
