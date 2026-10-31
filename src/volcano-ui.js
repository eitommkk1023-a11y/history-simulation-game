// Embedded inside the game's main closure; DOM/render adapter only, no physics.
const volcanoSource = document.getElementById('volcano-src').textContent;
let volcanoWorker = null, volcanoSeq = 0, volcanoWaiting = new Map(), volcanoFault = null;
let volcanoBaseElev = null, volcanoBaseType = null, volcanoBaseBiome = null, volcanoBaseSea = null;
let volcanoBaseVolcanoes = [], volcanoBaseRegions = new Map(), volcanoBaseEnv = null;
let volcanoDetail = [], volcanoSky = [], volcanoLastMetrics = {}, volcanoTargetDay = -1;
let volcanoSelected = -1, volcanoMeshes = [], volcanoStateVersion = 0;
let volcanoPatchMap = new Map(), volcanoFineLookup = new Map();
const volcanoMaskData = new Uint8Array(W*H);
const volcanoMaskTexture = new THREE.DataTexture(volcanoMaskData,W,H,THREE.LuminanceFormat);
volcanoMaskTexture.magFilter=volcanoMaskTexture.minFilter=THREE.NearestFilter;
volcanoMaskTexture.needsUpdate=true;

const VOLCANO_LABELS = {strato:'成層火山',shield:'楯状火山',dome:'溶岩ドーム',scoria:'スコリア丘'};
const COMPOSITION_LABELS = {basalt:'玄武岩質',andesite:'安山岩質',dacite:'デイサイト質',rhyolite:'流紋岩質'};
function volcanoType(v) { return (v.setting === 'submarine' ? '海底火山 / ' : '') + (v.structure === 'caldera' ? 'カルデラ / ' : '') + (VOLCANO_LABELS[v.morphology] || (v.kind === 1 ? '楯状火山' : '成層火山')); }
function volcanoReady() { return !!volcanoWorker && !volcanoFault && volcanoWaiting.size === 0; }
function volcanoCall(cmd, payload) {
  if (!volcanoWorker || volcanoFault) return Promise.reject(new Error(volcanoFault || '火山計算の準備中です'));
  const id = ++volcanoSeq;
  return new Promise((resolve,reject)=>{ volcanoWaiting.set(id,{resolve,reject}); volcanoWorker.postMessage({id,cmd,payload}); });
}
function disposeVolcanoRuntime() {
  if (volcanoWorker) volcanoWorker.terminate(); volcanoWorker = null;
  for (const pending of volcanoWaiting.values()) pending.reject(new Error('世界を切り替えました'));
  volcanoBaseElev=volcanoBaseType=volcanoBaseBiome=volcanoBaseSea=volcanoBaseEnv=null;volcanoBaseVolcanoes=[];volcanoBaseRegions.clear();
  volcanoWaiting.clear(); volcanoFault = null; volcanoDetail = []; volcanoSky = []; volcanoTargetDay = -1;
  for (const mesh of volcanoMeshes) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  volcanoMeshes = [];volcanoPatchMap.clear();volcanoFineLookup.clear();volcanoMaskData.fill(0);volcanoMaskTexture.needsUpdate=true; document.getElementById('volcanoPanel').classList.remove('show');
}
async function initVolcanoRuntime(snapshot) {
  disposeVolcanoRuntime();
  volcanoBaseElev = world.elev.slice(); volcanoBaseType = world.type.slice(); volcanoBaseBiome = world.biome.slice(); volcanoBaseSea = world.seaId.slice();
  volcanoBaseVolcanoes = world.volcanoes.map(v=>({...v})); volcanoBaseRegions.clear();
  volcanoBaseEnv = Object.fromEntries(Object.entries(world.fauna.env).map(([k,v])=>[k,v.slice()]));
  const program = volcanoSource + `\nlet engine;
self.onmessage = function(e) {
 const {id,cmd,payload} = e.data;
 try {
  let result;
  if(cmd==='init'){engine=VolcanoCore.create(payload.input); if(payload.snapshot)engine.restore(payload.snapshot); result=true;}
  else if(cmd==='advance'){engine.advanceTo(payload.day);result=true;}
  else if(cmd==='erupt'){result=engine.erupt(payload.id,payload.level);}
  else if(cmd==='snapshot'){result=engine.snapshot();}
  else throw Error('Unknown volcano command');
  self.postMessage({id,result,changes:cmd==='snapshot'?null:engine.drainChanges()});
 }catch(error){self.postMessage({id,error:String(error.stack||error)});}
};`;
  const url=URL.createObjectURL(new Blob([program],{type:'text/javascript'}));
  volcanoWorker=new Worker(url); URL.revokeObjectURL(url);
  volcanoWorker.onmessage = e => {
    const msg=e.data, pending=volcanoWaiting.get(msg.id); if(!pending)return;
    volcanoWaiting.delete(msg.id);
    if(msg.error){volcanoFault=msg.error;clock.playing=false;pending.reject(new Error(msg.error));showError('火山計算: '+msg.error);return;}
    try { if(msg.changes)applyVolcanoChanges(msg.changes); pending.resolve(msg.result); refreshVolcanoPanel(); }
    catch(error){volcanoFault=String(error.stack||error);clock.playing=false;pending.reject(error);showError('火山表示: '+error.message);}
  };
  volcanoWorker.onerror=e=>{volcanoFault=e.message;clock.playing=false;for(const p of volcanoWaiting.values())p.reject(new Error(e.message));volcanoWaiting.clear();showError(e.message);};
  const cc=world.climate.cell;
  const input={width:W,height:H,metresPerBlock:world.geology.kmPerBlock*1000,elevation:volcanoBaseElev,
    volcanoes:world.volcanoes,geology:world.geology,seed:seedToInt(currentSeed),day:clock.day,
    climate:{w:cc.gridW,h:cc.gridH,step:cc.gridStep,tMean:cc.tMean,precip:cc.precip,windDir:cc.windDir,windSpeed:cc.windSpeed},
    river:{water:world.water,lakeId:world.lakeId,lakeLevels:world.lakeLevels,riverPts:world.riverPts,riverStarts:world.riverStarts}};
  volcanoTargetDay=clock.day;
  await volcanoCall('init',{input,snapshot});
  if(snapshot?.pending?.length){labReady();for(const p of snapshot.pending){const v=world.volcanoes[p.id],cc=world.climate.cell,c=labCell(v.x,v.y),th=cc.windDir[clockMonth()*cc.n+c]/256*Math.PI*2;const plume=labMakePlume(v,p.level>=3,th);plume.daysLeft=Math.max(1,Math.ceil(p.stepsLeft/4));sim.plumes.push(plume);}}

}
function advanceVolcanoClock() {
  if(!volcanoWorker || volcanoFault || clock.day<=volcanoTargetDay)return;
  volcanoTargetDay=clock.day;
  volcanoCall('advance',{day:clock.day}).catch(e=>menuMsg(e.message));
}
function updateVolcanoTerrainRegions(cells) {
  // Update only affected coarse mesh vertices and one ring of normals.
  if(!terrainMesh || !cells.length)return;
  const geo=terrainMesh.geometry,pos=geo.attributes.position,n=MESH_RES+1,affected=new Set();
  for(const [i] of cells){const x=i%W,y=Math.floor(i/W),u=x/W*MESH_RES,v=y/H*MESH_RES;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const a=Math.round(u)+dx,b=Math.round(v)+dy;if(a>=0&&b>=0&&a<n&&b<n)affected.add(b*n+a);}}
  for(const i of affected){const fx=(pos.getX(i)+W/2)*(W-1)/W,fy=(pos.getZ(i)+H/2)*(H-1)/H;const z=heightAt(world.elev,fx,fy);pos.setY(i,z);meshHeights[i]=z;}
  const normal=geo.attributes.normal,step=W/MESH_RES;
  for(const i of affected){const x=i%n,y=Math.floor(i/n),l=meshHeights[y*n+Math.max(0,x-1)],r=meshHeights[y*n+Math.min(n-1,x+1)],u=meshHeights[Math.max(0,y-1)*n+x],d=meshHeights[Math.min(n-1,y+1)*n+x];const nx=l-r,nz=u-d,len=Math.hypot(nx,2*step,nz);normal.setXYZ(i,nx/len,2*step/len,nz/len);}
  pos.needsUpdate=true;normal.needsUpdate=true;geo.computeBoundingSphere();
}
function applyVolcanoChanges(change) {
  const cells=change.cells||[],climateCells=new Set();
  for(const [i,z] of cells){
    if(!volcanoBaseRegions.has(i))volcanoBaseRegions.set(i,world.regionId[i]);
    world.elev[i]=z;
    if(z>0 && !world.type[i]){world.type[i]=2;world.seaId[i]=0;world.biome[i]=12;world.regionId[i]=50000+world.volcanoes.reduce((best,v,k,vs)=>((v.x-i%W)**2+(v.y-Math.floor(i/W))**2 < (vs[best].x-i%W)**2+(vs[best].y-Math.floor(i/W))**2)?k:best,0);}
    else if(z<=0 && !volcanoBaseType[i]){world.type[i]=0;world.biome[i]=volcanoBaseBiome[i];world.seaId[i]=volcanoBaseSea[i];}
    const x=i%W,y=Math.floor(i/W),cc=world.climate.cell;climateCells.add(Math.floor(y/cc.gridStep)*cc.gridW+Math.floor(x/cc.gridStep));
    // Repaint only changed texture pixels, preserving all other selected layers.
    if(terrainTex && terrainTex.image && terrainTex.image.data){const d=terrainTex.image.data,o=((H-1-y)*W+x)*4;
      if(world.type[i]){d[o]=100;d[o+1]=91;d[o+2]=78;}else{d[o]=40;d[o+1]=70;d[o+2]=120;}}
  }
  if(cells.length && terrainTex)terrainTex.needsUpdate=true;
  updateVolcanoTerrainRegions(cells);
  if(cells.length && riverMesh){const pos=riverMesh.geometry.attributes.position,center=riverMesh.geometry.attributes.aCenter;for(let i=0;i<pos.count;i++){pos.setY(i,meshHeightAtWorld(pos.getX(i),pos.getZ(i))+.002);center.setY(i,meshHeightAtWorld(center.getX(i),center.getZ(i))+.002);}pos.needsUpdate=true;center.needsUpdate=true;}
  if(change.volcanoes)world.volcanoes=change.volcanoes;
  if(change.detail)volcanoDetail=change.detail;
  volcanoSky=change.sky||[];volcanoLastMetrics=change.metrics||{};
  const messages={eruption:'噴火を開始',dormant:'休止状態へ移行',reactivation:'活動を再開',lahar:'雨で火山堆積物が流れ、火山泥流が発生',shirasu:'大量の珪長質火砕物が堆積', 'eruption-end':'マグマの噴出が終了'};
  for(const ev of change.events||[]){const e=names.byKey.get('volcano:'+ev.id);const name=ev.id<0?'火山地帯':e?nameOf(e):'火山 '+ev.id;
    postEvent({cat:'nature',imp:ev.type==='eruption'?2:0,group:'volcano-'+ev.type,text:name+'：'+(messages[ev.type]||ev.text)});}
  updateVolcanoEnvironment(climateCells);
  rebuildVolcanoDetail();volcMarkersBuild();volcanoStateVersion++;
  const vs=world.volcanoes;document.getElementById('iVolc').textContent=vs.length+'（活'+vs.filter(v=>v.active).length+'）';
  requestRender();
}
function updateVolcanoEnvironment(changed) {
  if(!changed.size || !world.fauna)return;
  const cc=world.climate.cell,S=cc.gridStep,env=world.fauna.env;
  for(const c of changed){let land=0,rock=0;const x0=c%cc.gridW*S,y0=Math.floor(c/cc.gridW)*S;
    for(let dy=0;dy<S;dy++)for(let dx=0;dx<S;dx++){const i=(y0+dy)*W+x0+dx;if(world.type[i]){land++;if(world.biome[i]===12)rock++;}}
    const oldLand=env.land[c]/255,share=land/(S*S);env.land[c]=Math.round(share*255);
    if(share>oldLand && share>0){const retain=oldLand/share;for(const k of ['forest','grass','evergreen','wetland'])env[k][c]=Math.round(env[k][c]*retain);}
    if(sim && land && rock)sim.ash[c]=Math.max(sim.ash[c],rock/land*0.4);
  }
  if(sim){for(const p of volcanoDetail){if(p.ash>0){const c=labCell(p.x,p.y);if(c>=0&&c<sim.n)sim.ash[c]=Math.max(sim.ash[c],Math.min(1,p.ash/0.1));}}labUploadTextures();}
  faDirty=true;
}
function volcanoBaseHeight(x,y) {
  const a=Math.max(0,Math.min(W-1,x)),b=Math.max(0,Math.min(H-1,y)),ix=Math.floor(a),iy=Math.floor(b),fx=a-ix,fy=b-iy;
  const x1=Math.min(W-1,ix+1),y1=Math.min(H-1,iy+1),e=volcanoBaseElev;
  return (e[iy*W+ix]*(1-fx)+e[iy*W+x1]*fx)*(1-fy)+(e[y1*W+ix]*(1-fx)+e[y1*W+x1]*fx)*fy;
}
function rebuildVolcanoDetail(force=false) {
  if(!volcanoBaseElev)return;
  const refinement=volcanoLastMetrics.refinement||8,step=1/refinement,N=W*refinement;
  const next=new Map(),patches=new Map(),dirty=new Set();
  for(const p of volcanoDetail){const ix=Math.floor(p.x*refinement),iy=Math.floor(p.y*refinement),key=iy*N+ix;
    next.set(key,p);const prev=volcanoFineLookup.get(key),bx=Math.floor(p.x),by=Math.floor(p.y),tile=Math.floor(by/4)*Math.ceil(W/4)+Math.floor(bx/4);
    if(force||!prev||prev.z!==p.z||prev.temperature!==p.temperature||prev.ash!==p.ash||prev.pyro!==p.pyro||prev.pumice!==p.pumice)dirty.add(tile);
    if(!patches.has(tile))patches.set(tile,new Set());patches.get(tile).add(by*W+bx);
  }
  for(const [key,p]of volcanoFineLookup)if(!next.has(key))dirty.add(Math.floor(p.y/4)*Math.ceil(W/4)+Math.floor(p.x/4));
  volcanoFineLookup=next;
  for(const tile of dirty){const old=volcanoPatchMap.get(tile);if(old){scene.remove(old.mesh);old.mesh.geometry.dispose();old.mesh.material.dispose();for(const i of old.cells){const x=i%W,y=Math.floor(i/W);volcanoMaskData[(H-1-y)*W+x]=0;}volcanoPatchMap.delete(tile);}
    const cells=patches.get(tile);if(!cells)continue;
    const positions=[],colors=[],indices=[];
    for(const base of cells){const bx=base%W,by=Math.floor(base/W);volcanoMaskData[(H-1-by)*W+bx]=255;
      for(let sy=0;sy<refinement;sy++)for(let sx=0;sx<refinement;sx++){
        const ix=bx*refinement+sx,iy=by*refinement+sy,p=next.get(iy*N+ix),x=(ix+.5)*step,y=(iy+.5)*step;
        const z=p?p.z:volcanoBaseHeight(x,y),hot=p&&p.temperature>650&&p.active;
        let color=hot?[.98,.25,.035]:p?(p.pyro>p.lava?[.68,.63,.53]:p.pumice>0?[.72,.70,.63]:[.36,.32,.28]):[.36,.39,.3];
        if(z<0)color=[.16,.27,.42];
        if(terrainTex && terrainTex.image.data && viewMode!=='biome' && viewMode!=='elev'){const data=terrainTex.image.data,o=((H-1-by)*W+bx)*4;color=[data[o]/255,data[o+1]/255,data[o+2]/255];}
        const k=positions.length/3;
        for(const [dx,dy]of [[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]){
          const vx=x+dx*step,vy=y+dy*step;
          // Average the shared neighbouring finite-volume heights for a watertight mesh.
          const gx=Math.round(vx*refinement),gy=Math.round(vy*refinement);let total=0,count=0;
          for(let oy=-1;oy<=0;oy++)for(let ox=-1;ox<=0;ox++){const px=gx+ox,py=gy+oy;if(px<0||py<0||px>=N||py>=H*refinement)continue;const q=next.get(py*N+px);total+=q?q.z:volcanoBaseHeight((px+.5)*step,(py+.5)*step);count++;}
          let height=total/Math.max(1,count);
          // Blend the external patch border into the unchanged overview mesh.
          const edgeX=Math.abs(vx-Math.round(vx))<1e-8,edgeY=Math.abs(vy-Math.round(vy))<1e-8;
          const hasBase=(xx,yy)=>xx>=0&&yy>=0&&xx<W&&yy<H&&patches.get(Math.floor(yy/4)*Math.ceil(W/4)+Math.floor(xx/4))?.has(yy*W+xx);
          let border=(edgeX&&(!hasBase(Math.round(vx)-1,Math.floor(y))||!hasBase(Math.round(vx),Math.floor(y))))||(edgeY&&(!hasBase(Math.floor(x),Math.round(vy)-1)||!hasBase(Math.floor(x),Math.round(vy))));
          const X=toWorldX(vx),Z=toWorldZ(vy),Y=border?meshHeightAtWorld(X,Z):elevationToDisplay(height,verticalExaggeration,world.geology.kmPerBlock*1000);
          positions.push(X,Y,Z);colors.push(...color);
        }
        indices.push(k,k+1,k+2,k,k+2,k+3);
      }
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.setIndex(indices);geo.computeVertexNormals();
    const mat=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geo,mat);scene.add(mesh);volcanoPatchMap.set(tile,{mesh,cells});
  }
  volcanoMeshes=Array.from(volcanoPatchMap.values(),p=>p.mesh);volcanoMaskTexture.needsUpdate=true;
}

function updateVolcanoSky() {
  let haze=0;
  for(const p of volcanoSky){const dx=cam.tx+W/2-p.x,dy=cam.tz+H/2-p.y;haze+=p.strength/(1+(dx*dx+dy*dy)/(300*300));}
  haze=Math.min(.8,haze);
  const color=new THREE.Color(0x0a121d).lerp(new THREE.Color(0x36322f),haze);
  renderer.setClearColor(color);scene.fog.color.copy(color);scene.fog.near=5400*(1-haze*.7);scene.fog.far=12600*(1-haze*.65);sun.intensity=.55*(1-haze*.8);
}
function openVolcano(id) {
  if(!world || !world.volcanoes[id])return;
  volcanoSelected=id;document.getElementById('volcanoPanel').classList.add('show');refreshVolcanoPanel();
}
function refreshVolcanoPanel() {
  if(volcanoSelected<0 || !world)return;
  const v=world.volcanoes[volcanoSelected];if(!v)return;
  const e=names.byKey.get('volcano:'+volcanoSelected);
  document.getElementById('volcanoTitle').textContent=e?nameOf(e):'火山 '+volcanoSelected;
  document.getElementById('volcanoInfo').textContent=volcanoType(v)+' / '+(v.active?'活動中':'休止中')+'\n'+(COMPOSITION_LABELS[v.composition]||'')+' / '+Math.round(v.temperature||0)+'℃\nマグマ '+((v.magmaVolume||0)/1e9).toFixed(3)+' km³ / 圧力 '+Math.round((v.pressure||0)*100)+'%';
  for(const b of document.querySelectorAll('#volcanoPanel [data-level]'))b.disabled=!v.active||!volcanoReady()||!!v.eruption;
  document.getElementById('volcanoStatus').textContent=!v.active?'活動が再開するまで噴火操作はできません':volcanoFault?'計算エラー':!volcanoReady()?'計算中…':'噴火規模を選んでください';
}
async function eruptVolcano(id,level) {
  if(!volcanoReady())return {ok:false,reason:'計算中です'};
  try {const result=await volcanoCall('erupt',{id,level});
    if(!result.ok){document.getElementById('volcanoStatus').textContent=result.reason||'噴火できません';return result;}
    const v=world.volcanoes[id];labReady();const cc=world.climate.cell,c=labCell(v.x,v.y),m=clockMonth(),th=cc.windDir[m*cc.n+c]/256*Math.PI*2;
    sim.plumes.push(labMakePlume(v,level>=3,th));
    document.getElementById('volcanoStatus').textContent='噴火を開始しました。時間を進めると溶岩が流れます。';requestRender();return result;
  }catch(e){menuMsg(e.message);return {ok:false,reason:e.message};}
}
function volcanoAtScreen(x,y) {
  if(!world)return -1;let chosen=-1,distance=28*28;const point=new THREE.Vector3();
  world.volcanoes.forEach((v,i)=>{const X=toWorldX(v.x),Z=toWorldZ(v.y);point.set(X,Math.max(0,meshHeightAtWorld(X,Z))+2,Z).project(camera);if(point.z>1||point.z< -1)return;
    const dx=(point.x+1)*innerWidth/2-x,dy=(1-point.y)*innerHeight/2-y,d=dx*dx+dy*dy;if(d<distance){distance=d;chosen=i;}});return chosen;
}
function setupVolcanoControls() {
  bindTap(document.getElementById('volcanoClose'),()=>document.getElementById('volcanoPanel').classList.remove('show'));
  for(const button of document.querySelectorAll('#volcanoPanel [data-level]'))bindTap(button,()=>eruptVolcano(volcanoSelected,Number(button.dataset.level)));
  bindTap(document.getElementById('volcanoRename'),()=>{const e=names.byKey.get('volcano:'+volcanoSelected);if(e)renameOpen(e);});
  let mouse=null;
  canvas.addEventListener('pointerdown',e=>{if(e.pointerType==='touch')return;mouse={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,at:performance.now(),button:e.button};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!mouse||e.pointerType==='touch')return;const dx=e.clientX-mouse.x,dy=e.clientY-mouse.y;mouse.x=e.clientX;mouse.y=e.clientY;
    if(mouse.button===2||e.shiftKey){cam.yaw-=dx*.006;cam.pitch+=dy*.005;}else{const k=cam.dist*1.25/innerHeight,sy=Math.sin(cam.yaw),cy=Math.cos(cam.yaw);cam.tx+=(-dx*cy-dy*sy)*k;cam.tz+=(dx*sy-dy*cy)*k;}updateCamera();});
  canvas.addEventListener('pointerup',e=>{if(!mouse||e.pointerType==='touch')return;const m=mouse;mouse=null;if(Math.hypot(e.clientX-m.startX,e.clientY-m.startY)>8)return;
    if(performance.now()-m.at>=LABEL_HOLD_MS){if(!labelTap(e.clientX,e.clientY)){const i=volcanoAtScreen(e.clientX,e.clientY);if(i>=0)renameOpen(names.byKey.get('volcano:'+i));}}
    else{const i=volcanoAtScreen(e.clientX,e.clientY);if(i>=0)openVolcano(i);}});
  canvas.addEventListener('pointercancel',()=>{mouse=null;});
  canvas.addEventListener('wheel',e=>{e.preventDefault();cam.dist*=Math.exp(Math.max(-200,Math.min(200,e.deltaY))*.001);updateCamera();},{passive:false});
}

// Snapshot is a barrier in the same worker queue as advances and eruptions.
let volcanoSaveQueue = Promise.resolve();
function serializeState() {
  const capture = async () => {
    if(!world || busy || !volcanoWorker)throw new Error('世界の準備が終わるまで保存できません');
    const instance=volcanoWorker, wasPlaying=clock.playing; clock.playing=false;
    try {
      const physical=await volcanoCall('snapshot');
      if(instance!==volcanoWorker)throw new Error('保存中に世界が切り替わりました');
      const state=serializeBaseState();state.volcano=physical;
      return typeof structuredClone==='function'?structuredClone(state):unpackTyped(packTyped(state));
    } finally {if(instance===volcanoWorker && !busy && !volcanoFault)clock.playing=wasPlaying;timebarUpdate();}
  };
  const result=volcanoSaveQueue.then(capture);volcanoSaveQueue=result.catch(()=>{});return result;
}
