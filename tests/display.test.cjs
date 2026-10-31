const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('自然地理生成器.html','utf8');
test('physical metres convert to render units without modifying input',()=>{
 const m=html.match(/function elevationToDisplay\(e, scale, metresPerUnit\) \{[\s\S]*?\n\}/);
 assert.ok(m,'shared elevation converter must exist');
 const convert=vm.runInNewContext('('+m[0]+')');
 const original=[-3330,0,3330];
 for(const scale of [1,1.5,2])assert.deepEqual(original.map(e=>convert(e,scale,3330)),[-scale,0,scale]);
 assert.deepEqual(original,[-3330,0,3330]);
});
test('all embedded scripts parse',()=>{for(const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(s[1].trim())new vm.Script(s[1]);});
test('mesh sampling preserves data and distinguishes average, direct and mountain relief',()=>{
 const fn=html.match(/function heightAt\(elev, fx, fy\) \{[\s\S]*?\n\}/)[0];
 const a=new Float32Array(81).fill(100);a[40]=8500;const before=a.slice();
 const sample=mode=>vm.runInNewContext('('+fn+')(a,4,4)',{a,W:9,H:9,MESH_RES:3,lakeId:null,lakeLevels:null,terrainSampling:mode,verticalExaggeration:1,world:null,elevationToDisplay:e=>e});
 const standard=sample('standard'),direct=sample('direct'),mountain=sample('mountain');
 assert.equal(direct,8500);assert.ok(standard<mountain&&mountain<direct);assert.deepEqual(a,before);
});
