const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const ui=fs.readFileSync('src/volcano-ui.js','utf8');
test('every successful eruption creates smoke, including beyond twelve volcanoes',async()=>{
 const make=ui.slice(ui.indexOf('async function eruptVolcano('),ui.indexOf('function volcanoAtScreen('));
 const sim={plumes:[]},status={};
 const ctx={sim,world:{volcanoes:[{x:0,y:0}],climate:{cell:{n:1,windDir:[0]}}},volcanoReady:()=>true,clockSetPlaying(){},volcanoCall:async()=>({ok:true}),labReady(){},labCell:()=>0,clockMonth:()=>0,labMakePlume:()=>({}),document:{getElementById:()=>status},requestRender(){},menuMsg(){}};
 vm.createContext(ctx);vm.runInContext(make,ctx);for(let i=0;i<15;i++)await ctx.eruptVolcano(0,1);
 assert.equal(sim.plumes.length,15);
});
test('eruption leaves running or paused clock unchanged',async()=>{
 const make=ui.slice(ui.indexOf('async function eruptVolcano('),ui.indexOf('function volcanoAtScreen('));
 for(const playing of [true,false]){
 const clock={playing},ctx={clock,sim:{plumes:[]},world:{volcanoes:[{x:0,y:0}],climate:{cell:{n:1,windDir:[0]}}},volcanoReady:()=>true,clockSetPlaying:value=>clock.playing=value,volcanoCall:async()=>({ok:true}),labReady(){},labCell:()=>0,clockMonth:()=>0,labMakePlume:()=>({}),document:{getElementById:()=>({})},requestRender(){},menuMsg(){}};
 vm.createContext(ctx);vm.runInContext(make,ctx);await ctx.eruptVolcano(0,1);assert.equal(clock.playing,playing);
 }
});

test('lava cools from glowing flow to dark solid rock',()=>{
 const src=ui.slice(ui.indexOf('function lavaDisplayColor('),ui.indexOf('function rebuildVolcanoDetail('));
 const f=vm.runInNewContext('('+src.trim()+')');
 const hot=f({active:true,temperature:1150,surfaceTemperature:1100,liquidFraction:1});
 const crust=f({active:true,temperature:1150,surfaceTemperature:100,liquidFraction:1});
 const solid=f({active:false,temperature:100,surfaceTemperature:100,liquidFraction:0});
 assert.ok(hot[0]>crust[0]&&crust[0]>solid[0]);assert.ok(hot[0]>hot[1]*2);
});
