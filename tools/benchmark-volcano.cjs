// Bounded numerical benchmark; excludes world generation, rendering and device hardware.
const C=require('../src/volcano-core.js');
const {performance}=require('node:perf_hooks');
function make(n){return C.create({width:64,height:64,metresPerBlock:3330,elevation:new Float32Array(4096).fill(100),seed:813,volcanoes:Array.from({length:n},(_,id)=>({id,x:5+id%10*5,y:5+Math.floor(id/10)*5,radius:2,active:true,kind:1,morphology:'shield',composition:'basalt',capacity:2e9,magmaVolume:2e9,supply:0,gas:.15,pressure:.5,temperature:1180,viscosity:250}))});}
const out=[];
for(const [label,n,erupt,days]of [['90 quiet volcanoes / 100 years',90,0,36000],['4 simultaneous eruptions / 1 year',4,4,360],['cooled deposits / another 100 years',1,1,36000]]){
 const e=make(n);for(let i=0;i<erupt;i++)e.erupt(i,3);
 if(label.startsWith('cooled'))e.advanceTo(360);
 const before=e.measure().totalCells,start=performance.now();e.advanceTo(days);const elapsed=performance.now()-start,m=e.measure();
 if(Math.abs(m.massErrorDRE)>Math.max(1e-4,m.sourceDRE*1e-10))throw Error('mass drift');
 out.push({scenario:label,elapsedMs:Math.round(elapsed),cellsBefore:before,cellsAfter:m.totalCells,activeCells:m.activeCells,massErrorDRE:m.massErrorDRE,snapshotKiB:Math.round(JSON.stringify(e.snapshot()).length/1024)});
}
console.log(JSON.stringify(out,null,2));
