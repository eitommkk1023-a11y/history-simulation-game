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
