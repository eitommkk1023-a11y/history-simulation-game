const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader'],proxy:{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}});
 const page=await browser.newPage({viewport:{width:820,height:1180},hasTouch:true,isMobile:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
 // Exercise the retained v11 generator without a needless v12 generation first.
 await page.route('**/*.html',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync('自然地理生成器.html','utf8').replaceAll('generate(randomSeed())',"generate('legacy-compat-813',11)")}));
 await page.goto('http://127.0.0.1:8000/game.html');
 await page.waitForFunction(()=>window.__geo?.world&&window.__geo.volcanoReady(),{},{timeout:240000});
 console.log('legacy world ready');
 assert.equal(await page.evaluate(()=>window.__geo.world.stats.version),11);
 await page.evaluate(async()=>{const g=window.__geo;window.legacySave=await g.serializeState();delete window.legacySave.volcano;window.legacyTerrain=g.world.elev.slice();});
 const dormant=await page.evaluate(()=>window.__geo.world.volcanoes.findIndex(v=>!v.active));
 assert.ok(dormant>=0);await page.evaluate(i=>window.__geo.openVolcano(i),dormant);
 assert.equal(await page.locator('#volcanoPanel [data-level]:disabled').count(),4);
 await page.locator('#volcanoRename').click();await page.locator('#rnInput').fill('検証火山');await page.locator('#rnOk').click();
 assert.equal(await page.evaluate(i=>window.__geo.names.overrides['volcano:'+i].user,dormant),'検証火山');
 await page.locator('#volcanoClose').click();
 const id=await page.evaluate(()=>{const g=window.__geo,i=g.world.volcanoes.findIndex(v=>v.active),v=g.world.volcanoes[i];Object.assign(g.cam,{tx:v.x-1500,tz:v.y-1500,dist:200,pitch:1.2});g.updateCamera();return i;});
 await page.touchscreen.tap(410,590);
 await page.waitForFunction(()=>document.getElementById('volcanoPanel').classList.contains('show'));
 await page.locator('#volcanoClose').click();
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:410,y:590}]});
 await page.waitForTimeout(800);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForFunction(()=>document.getElementById('rename').classList.contains('show'));
 await page.locator('#rnCancel').click();
 for(const size of [{width:1180,height:820},{width:1440,height:900}]){
  await page.setViewportSize(size);await page.locator('#btnView').click();await page.locator('#displayModes button').first().click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }
 await page.evaluate(()=>window.__geo.loadState(window.legacySave));
 await page.waitForFunction(()=>window.__geo?.world&&window.__geo.volcanoReady(),{},{timeout:240000});
 assert.equal(await page.evaluate(()=>window.legacyTerrain.every((v,i)=>v===window.__geo.world.elev[i])),true,'v11 terrain is unchanged after legacy load');
 assert.ok(await page.evaluate(()=>window.__geo.world.riverPts.length>0&&!!window.__geo.world.fauna&&!!window.__geo.world.climate));
 assert.deepEqual(errors,[]);
 console.log('PASS legacy generation/save, iPad portrait/landscape, PC layout, dormant gating, rename, real touch tap and long press');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
