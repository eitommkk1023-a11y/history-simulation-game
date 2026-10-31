const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader'],proxy:{server:process.env.HTTPS_PROXY,bypass:'127.0.0.1,localhost'}});
 const page=await browser.newPage({viewport:{width:812,height:375},hasTouch:true,isMobile:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto('http://127.0.0.1:8000/'+encodeURIComponent('自然地理生成器.html'));
 await page.locator('#btnView').click();
 const box=await page.locator('#displayBody').boundingBox();assert.ok(box.y+box.height<=375);
 assert.ok(await page.locator('#displayBody').evaluate(e=>e.scrollHeight>e.clientHeight));
 const cdp=await page.context().newCDPSession(page);
 const tx=box.x+box.width-12,start=box.y+box.height-20;
 for(let pass=0;pass<4;pass++){
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:start}]});
 for(let step=1;step<=10;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx,y:start-step*(box.height-40)/10}]});await page.waitForTimeout(20);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(100);
 }

 assert.ok(await page.locator('#displayBody').evaluate(e=>e.scrollTop>0),'real touch scroll moves the menu');
 await page.locator('#heightScale').selectOption('20');
 const select=await page.locator('#heightScale').boundingBox();assert.ok(select.y>=box.y&&select.y+select.height<=box.y+box.height);
 console.log('PASS landscape touch scrolling and reachable height selector');
 await page.locator('#displayWind').check();await page.locator('#displayWaves').check();
 await page.locator('#displayClose').click();
 await page.waitForFunction(()=>window.__geo?.world&&window.__geo.volcanoReady(),{},{timeout:240000});
 await page.waitForFunction(()=>window.__geo.weatherGlyphs().wind>0&&window.__geo.weatherGlyphs().waves>0);
 const before=await page.locator('#weatherMotion').evaluate(e=>e.toDataURL());await page.waitForTimeout(250);
 assert.notEqual(await page.locator('#weatherMotion').evaluate(e=>e.toDataURL()),before,'wind and waves animate');
 const state=await page.evaluate(()=>window.__geo.serializeState());assert.equal(state.view.wind,true);assert.equal(state.view.waves,true);
 await page.locator('#btnView').click();await page.locator('#displayWind').uncheck();await page.locator('#displayWaves').uncheck();await page.locator('#displayClose').click();
 await page.waitForFunction(()=>window.__geo.weatherGlyphs().wind===0&&window.__geo.weatherGlyphs().waves===0);
 assert.deepEqual(errors,[]);console.log('PASS animated wind/waves, persisted settings, disabling clears overlay');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
