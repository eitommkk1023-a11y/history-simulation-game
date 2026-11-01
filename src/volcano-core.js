/* Volcanic surface model. All lengths are metres internally; API x/y are world blocks.
 * DRE volumes use 2600 kg/m³. See docs/volcano-core.md for approximations and ledgers. */
const VolcanoCore = (() => {
  'use strict';
  const REFINE = 8, DT = 21600, DAY = 86400, ASH_THRESHOLD = 0.01;
  const MATERIALS = ['lava', 'ash', 'pumice', 'pyro'];
  const EXPANSION = { lava: 1, ash: 3.5, pumice: 5, pyro: 2.4 };
  const COMPOSITION = {
    basalt: { temperature: 1180, viscosity: 250, solidus: 850, gas: 0.2 },
    andesite: { temperature: 1050, viscosity: 80000, solidus: 780, gas: 0.5 },
    dacite: { temperature: 950, viscosity: 3000000, solidus: 730, gas: 0.7 },
    rhyolite: { temperature: 850, viscosity: 100000000, solidus: 680, gas: 0.8 }
  };
  const NEIGHBOURS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const copy = o => JSON.parse(JSON.stringify(o));
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  const finite = (x, name) => { if (!Number.isFinite(x)) throw new TypeError(`${name} must be finite`); return x; };
  function validNumbers(o) {
    if (typeof o === 'number') finite(o, 'state value');
    else if (o && typeof o === 'object') for (const v of Object.values(o)) validNumbers(v);
  }
  function hash(seed) {
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15;
    return h >>> 0;
  }
  function decorate(volcanoes, geology = {}, seed = 1, sampleHeight = () => 0) {
    if (!Array.isArray(volcanoes)) throw new TypeError('volcanoes must be an array');
    return volcanoes.map((old, id) => {
      finite(old.x, 'volcano x'); finite(old.y, 'volcano y'); validNumbers(old);
      const h = hash(`${seed}:${id}:${old.x}:${old.y}`), r = h / 4294967296;
      const gw = geology.gridW || 1, gh = geology.gridH || 1, step = geology.gridStep || 1;
      const gi = clamp(Math.floor(old.y / step), 0, gh - 1) * gw + clamp(Math.floor(old.x / step), 0, gw - 1);
      const crust = geology.crust?.[gi] ?? 1, boundary = geology.boundaryType?.[gi] || 0;
      const history = geology.volcanism?.[gi] || 0, cause = geology.cause?.[gi] || 0;
      const basement = finite(sampleHeight(old.x, old.y), 'sample height');
      const supported = history > 100 || boundary === 1 || boundary === 2 || cause === 5 || cause === 6;
      // Transform faults and oceanic crust alone supply no magma.
      const magmaSource = (boundary === 3 || cause === 8) && history <= 100 ? false : supported || (!geology.crust && !!old.active);
      const composition = old.composition || (crust === 0 || old.kind === 1
        ? (r < 0.82 ? 'basalt' : 'andesite')
        : r < 0.4 ? 'andesite' : r < 0.72 ? 'dacite' : r < 0.92 ? 'rhyolite' : 'basalt');
      if (!COMPOSITION[composition]) throw new TypeError('unknown composition');
      const props = COMPOSITION[composition], r2 = ((h >>> 8) & 65535) / 65536;
      const morphology = old.morphology || (composition === 'basalt'
        ? (r2 < 0.74 ? 'shield' : 'scoria') : r2 < 0.23 ? 'dome' : r2 > 0.92 ? 'scoria' : 'strato');
      const capacity = old.capacity ?? Math.max(old.magmaVolume || 0, (morphology === 'shield' ? 1.8e9 : morphology === 'scoria' ? 1e8 : 8e8) * (0.7 + r));
      const magmaVolume = old.magmaVolume ?? capacity * (0.25 + r2 * 0.6);
      const active = old.active === undefined ? magmaSource : !!old.active;
      return { ...old, id, kind: old.kind === 1 ? 1 : 0, active,
        radius: old.radius ?? 2, height: old.height ?? 0, summit: old.summit ?? basement,
        morphology, structure: old.structure || ((composition === 'rhyolite' || composition === 'dacite') && r2 > 0.52 ? 'caldera' : 'normal'),
        setting: old.setting || (basement < 0 ? 'submarine' : 'land'), composition, capacity,
        magmaVolume, supply: old.supply ?? (magmaSource ? capacity / (360 * (50 + r * 150)) : 0),
        pressure: old.pressure ?? clamp(magmaVolume / Math.max(1, capacity), 0, 1),
        gas: old.gas ?? clamp(props.gas + (r2 - 0.5) * 0.2, 0, 1),
        viscosity: old.viscosity ?? props.viscosity, temperature: old.temperature ?? props.temperature,
        tectonicContext: old.tectonicContext || (boundary===2?'rift':boundary===1?'subduction':old.kind===1?'hotspot':'inherited'),
        lastEruptionDay: old.lastEruptionDay ?? null };
    });
  }

  function create(options) {
    if (!options || typeof options !== 'object') throw new TypeError('engine options required');
    const { width: W, height: H, metresPerBlock: scale } = options;
    if (!Number.isSafeInteger(W) || !Number.isSafeInteger(H) || W < 1 || H < 1 || W * H > 1e8) throw new RangeError('invalid dimensions');
    if (!(finite(scale, 'metresPerBlock') > 0)) throw new RangeError('metresPerBlock must be positive');
    if (!options.elevation || options.elevation.length !== W * H) throw new RangeError('elevation size mismatch');
    const base = Float32Array.from(options.elevation);
    let baseHash = 2166136261;
    const bits = new Uint32Array(base.buffer);
    for (let i = 0; i < base.length; i++) { finite(base[i], 'elevation'); baseHash = Math.imul(baseHash ^ bits[i], 16777619); }
    const FW = W * REFINE, FH = H * REFINE, edge = scale / REFINE, area = edge * edge;
    const climate = options.climate || null, river = options.river || null;
    if (climate) {
      if (!Number.isInteger(climate.w) || !Number.isInteger(climate.h) || climate.w < 1 || climate.h < 1 || !(climate.step > 0)) throw new RangeError('invalid climate grid');
      for (const field of ['tMean', 'precip', 'windDir', 'windSpeed']) if (climate[field]) {
        if (climate[field].length !== 12 * climate.w * climate.h) throw new RangeError(`invalid climate ${field} length`);
        for (const x of climate[field]) finite(x, `climate ${field}`);
      }
    }
    if (river) {
      for (const field of ['water', 'lakeId']) if (river[field] && river[field].length !== W * H) throw new RangeError(`invalid river ${field} length`);
      for (const field of ['water', 'lakeId', 'lakeLevels', 'riverPts', 'riverStarts']) if (river[field]) for (const x of river[field]) finite(x, field);
      if (river.riverPts && river.riverPts.length % 3) throw new RangeError('riverPts must contain x,y,width triples');
    }
    function baseHeight(x, y) {
      x = clamp(x, 0, W - 1); y = clamp(y, 0, H - 1);
      const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
      const jx = Math.min(ix + 1, W - 1), jy = Math.min(iy + 1, H - 1);
      return (base[iy * W + ix] * (1 - tx) + base[iy * W + jx] * tx) * (1 - ty)
        + (base[jy * W + ix] * (1 - tx) + base[jy * W + jx] * tx) * ty;
    }
    let volcanoes = decorate(options.volcanoes || [], options.geology || {}, options.seed ?? 1, baseHeight);
    const checkVolcanoes = vs => {
      if (!Array.isArray(vs) || vs.length !== volcanoes.length) throw new RangeError('volcano count mismatch');
      vs.forEach((v, i) => {
        if (v.id !== i || !(v.x >= 0 && v.x < W && v.y >= 0 && v.y < H)) throw new RangeError('invalid volcano coordinates/id');
        for (const k of ['capacity', 'magmaVolume', 'supply', 'radius', 'viscosity']) if (!(v[k] >= 0)) throw new RangeError(`invalid volcano ${k}`);
        if (!(v.capacity > 0) || v.magmaVolume > v.capacity || !(v.viscosity > 0) || !(v.gas >= 0 && v.gas <= 1) || !(v.pressure >= 0 && v.pressure <= 1)) throw new RangeError('invalid reservoir');
        if (!COMPOSITION[v.composition] || !['strato','shield','dome','scoria'].includes(v.morphology) || !['caldera','normal'].includes(v.structure) || !['land','submarine'].includes(v.setting)) throw new RangeError('invalid volcano classification');
      });
    };
    checkVolcanoes(volcanoes);
    let day = options.day ?? 0;
    if (!Number.isSafeInteger(day) || day < 0) throw new RangeError('invalid initial day');
    let tick = day * 4, rng = hash(options.seed ?? 1) || 1;
    let cells = new Map(), active = new Set(), erodible = new Set(), dirty = new Set(), pending = [], sky = [], events = [];
    let ledger = { initialMagmaDRE: sum(volcanoes.map(v => v.magmaVolume)), rechargedDRE: 0,
      sourceDRE: 0, exportedDRE: 0, erodedDRE: 0, laharDRE: 0,
      materials: Object.fromEntries(MATERIALS.map(k => [k, { sourceDRE: 0, exportedDRE: 0 }])) };
    const inside = (x, y) => x >= 0 && x < FW && y >= 0 && y < FH;
    const key = (x, y) => y * FW + x;
    const baseIndex = (x, y) => Math.floor(y / REFINE) * W + Math.floor(x / REFINE);
    const orderedCells = () => Array.from(cells.values()).sort((a,b) => key(a.x,a.y) - key(b.x,b.y));
    const random = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 4294967296; };
    function emit(type, id, text) { events.push({ type, id, day: tick / 4, text }); if (events.length > 256) events.shift(); }
    function get(x, y) {
      const k = key(x, y); let c = cells.get(k);
      if (!c) {
        c = { x, y, liquid: 0, solid: 0, ash: 0, pumice: 0, pyro: 0, pyroBulk: 0,
          surface: 15, interior: 15, viscosity: 250, solidus: 850, eruptionTemperature: 1180, floating: 0 };
        cells.set(k, c);
      }
      return c;
    }
    const bulk = c => c.liquid + c.solid + c.ash * EXPANSION.ash + c.pumice * EXPANSION.pumice + c.pyroBulk;
    function surfaceAt(x, y) {
      const c = cells.get(key(x,y));
      return baseHeight((x + 0.5) / REFINE, (y + 0.5) / REFINE) + (c ? bulk(c) / area : 0);
    }
    function heightAt(x, y) {
      finite(x,'x'); finite(y,'y');
      const ix = clamp(Math.floor(x * REFINE), 0, FW - 1), iy = clamp(Math.floor(y * REFINE), 0, FH - 1);
      const c = cells.get(key(ix, iy));
      return baseHeight(x, y) + (c ? bulk(c) / area : 0);
    }
    function waterAt(x, y) {
      if (!inside(x,y)) return false;
      const z = surfaceAt(x, y), bi = baseIndex(x,y), lake = river?.lakeId?.[bi] || 0;
      if (z < 0) return true;
      return !!lake && z < (river?.lakeLevels?.[lake] ?? base[bi] + 2);
    }
    function weather(x, y, atDay = tick / 4) {
      if (!climate) return { temp: 15, rain: 60, wx: 0.7, wy: 0.3, wind: 4 };
      const ci = clamp(Math.floor(y / climate.step), 0, climate.h - 1) * climate.w + clamp(Math.floor(x / climate.step), 0, climate.w - 1);
      const i = (Math.floor(atDay / 30) % 12) * climate.w * climate.h + ci;
      const angle = (climate.windDir?.[i] ?? 192) / 256 * Math.PI * 2;
      return { temp: (climate.tMean?.[i] ?? 150) / 10, rain: Math.max(0, climate.precip?.[i] ?? 60),
        wx: -Math.sin(angle), wy: Math.cos(angle), wind: (climate.windSpeed?.[i] ?? 40) / 10 };
    }
    // Reuse the supplied river polylines. Endpoint heights determine direction, so
    // both mouth-first and source-first encodings work. Index only line segments.
    const riverRoutes = new Map();
    if (river?.riverPts?.length) {
      const p = river.riverPts, starts = river.riverStarts?.length ? Array.from(river.riverStarts) : [0];
      for (let line = 0; line < starts.length; line++) {
        const end = starts[line + 1] ?? p.length / 3;
        for (let j = starts[line]; j + 1 < end; j++) {
          let ax = p[j*3], ay = p[j*3+1], bx = p[(j+1)*3], by = p[(j+1)*3+1];
          if (baseHeight(ax,ay) < baseHeight(bx,by)) [ax,ay,bx,by] = [bx,by,ax,ay];
          const steps = Math.max(1, Math.ceil(Math.hypot(bx-ax,by-ay) * 2));
          for (let q = 0; q < steps; q++) {
            const x = clamp(Math.floor(ax+(bx-ax)*q/steps),0,W-1), y = clamp(Math.floor(ay+(by-ay)*q/steps),0,H-1);
            riverRoutes.set(y*W+x, { x: clamp(Math.floor(bx*REFINE),0,FW-1), y: clamp(Math.floor(by*REFINE),0,FH-1) });
          }
        }
      }
    }
    function mark(c) { dirty.add(baseIndex(c.x,c.y)); }
    function exported(material, amount) { ledger.exportedDRE += amount; ledger.materials[material].exportedDRE += amount; }
    function addMaterial(material, x, y, amount, expansion = EXPANSION[material]) {
      if (!(amount > 0)) return;
      if (!inside(x,y)) { exported(material,amount); return; }
      const c = get(x,y); c[material] += amount;
      if (material === 'pyro') c.pyroBulk += amount * expansion;
      if (material === 'pumice' && waterAt(x,y)) c.floating += amount * 0.8;
      erodible.add(key(x,y)); mark(c);
    }
    function addLava(x,y,amount,v) {
      if (!(amount > 0)) return;
      if (!inside(x,y)) { exported('lava',amount); return; }
      const c = get(x,y), total = c.liquid + amount;
      c.interior = (c.interior*c.liquid + v.temperature*amount) / total;
      c.surface = (c.surface*c.liquid + v.temperature*amount) / total;
      c.viscosity = (c.viscosity*c.liquid + v.viscosity*amount) / total;
      c.solidus = (c.solidus*c.liquid + COMPOSITION[v.composition].solidus*amount) / total;
      c.eruptionTemperature = (c.eruptionTemperature*c.liquid + v.temperature*amount) / total;
      c.liquid = total; active.add(key(x,y)); mark(c);
    }
    function normalized(points) {
      const merged = new Map();
      for (const p of points) { const k = `${p.x},${p.y}`, old = merged.get(k); if (old) old.w += p.w; else merged.set(k,{...p}); }
      const list = Array.from(merged.values()), weight = sum(list.map(p => p.w));
      for (const p of list) p.w /= weight;
      return list;
    }
    function fallout(v, level, coarse) {
      const w = weather(v.x,v.y), points = [];
      // Quadrature of an elongated fall-out plume. Each weighted sample deposits
      // into one sparse fine cell; unresolved area is represented in its mass.
      const reach = (coarse ? 700 + level*500 : 1800 + level*2600) / edge;
      const drift = coarse ? 0.25 : 0.6 + w.wind*0.07;
      for (let along = 0; along < 12; along++) for (let side = -5; side <= 5; side++) {
        const f = (along+0.5)/12, cross = side/5;
        const forward = (f*drift-0.12)*reach;
        const lateral = cross*reach*(0.12+f*0.34);
        points.push({ x: Math.floor(v.x*REFINE+w.wx*forward-w.wy*lateral),
          y: Math.floor(v.y*REFINE+w.wy*forward+w.wx*lateral),
          w: Math.exp(-2*f*f-3*cross*cross) / (1+along*0.1) });
      }
      return normalized(points);
    }
    function pyroPaths(v, level, shirasu) {
      const points = [], sx = clamp(Math.floor(v.x*REFINE),0,FW-1), sy = clamp(Math.floor(v.y*REFINE),0,FH-1);
      const initial = surfaceAt(sx,sy) + 100 + level*150 + (shirasu ? 180 : 0);
      const count = shirasu ? 40 : 24, maxSteps = Math.min(100, Math.ceil((2500+level*2000)/edge));
      for (let ray = 0; ray < count; ray++) {
        const angle = ray/count*Math.PI*2, dx = Math.cos(angle), dy = Math.sin(angle);
        let x = sx, y = sy, head = initial, remaining = 1/count;
        const seen = new Set([key(x,y)]);
        for (let s = 0; s < maxSteps && remaining > 1e-6; s++) {
          let next = null, best = Infinity;
          for (const [ox,oy] of NEIGHBOURS) {
            const nx = x+ox, ny = y+oy, distance = Math.hypot(ox,oy)*edge;
            if (seen.has(key(nx,ny)) || ox*dx+oy*dy < -0.15) continue;
            const z = inside(nx,ny) ? surfaceAt(nx,ny) : -1000;
            const friction = distance*(shirasu ? 0.025 : 0.055);
            if (z >= head-friction) continue;
            const score = z*0.2 - (ox*dx+oy*dy)*edge*0.7 + (1-(ox*dx+oy*dy)/Math.hypot(ox,oy))*edge*0.4;
            if (score < best) { best = score; next = { x:nx,y:ny,head:head-friction,z }; }
          }
          if (!next) break;
          const fraction = clamp(0.035 + edge / Math.max(edge*2,(head-surfaceAt(x,y))*18),0.035,0.45);
          const deposit = remaining*fraction; points.push({x,y,w:deposit}); remaining -= deposit;
          x=next.x; y=next.y; head=next.head;
          if (!inside(x,y)) break;
          seen.add(key(x,y));
        }
        points.push({ x,y,w:remaining });
      }
      return normalized(points);
    }
    function erupt(id, level) {
      if (!Number.isInteger(id) || !volcanoes[id]) return { ok:false,reason:'unknown volcano' };
      if (!Number.isInteger(level) || level < 1 || level > 4) return { ok:false,reason:'strength must be 1..4' };
      const v = volcanoes[id];
      if (!v.active) return { ok:false,reason:'inactive volcano' };
      if (pending.some(p => p.id === id)) return { ok:false,reason:'busy eruption' };
      if (!(v.magmaVolume > 0)) return { ok:false,reason:'no magma available' };
      const volume = Math.min(v.magmaVolume, [0,1e6,1e7,8e7,4e8][level] * (0.65 + 0.35 * v.pressure));
      const felsic = v.composition === 'rhyolite' || v.composition === 'dacite';
      const shirasu = felsic && v.gas >= 0.7 && level >= 3 && v.setting === 'land';
      const explosion = clamp(v.gas*(0.2+level*0.10+v.pressure*.18)+(felsic?0.18:0),0.02,0.88);
      const fractions = { lava:1-explosion, ash:explosion*0.48, pumice:explosion*(felsic?0.2:0.08), pyro:explosion*(felsic?0.32:0.44) };
      const angle = random()*Math.PI*2, ventType = (v.morphology === 'shield' || v.tectonicContext==='rift') ? (level >= 2 ? 'fissure' : 'flank') : v.pressure>.65 && random()<.35 ? 'flank' : 'summit';
      const vents = [], count = ventType === 'fissure' ? 5 : 1;
      for (let j=0;j<count;j++) {
        const offset = ventType === 'fissure' ? (j-(count-1)/2)*Math.min(v.radius*REFINE*0.15,2) : ventType === 'flank' ? Math.min(v.radius*REFINE*0.2,3) : 0;
        vents.push({ x:clamp(Math.floor(v.x*REFINE+Math.cos(angle)*offset),0,FW-1), y:clamp(Math.floor(v.y*REFINE+Math.sin(angle)*offset),0,FH-1), w:1/count });
      }
      const resistance=clamp(Math.log10(v.viscosity)/8,0,1.5);
      const steps = clamp(Math.ceil([0,4,8,16,32][level]*(.7+.5*resistance)/(0.5+v.pressure*.5)/(count>1?1.25:1)/(1+Math.min(.2,v.supply/Math.max(volume,1)))),1,80);
      pending.push({ id, level, remaining:volume, volume, stepsLeft:steps, rate:volume/steps,
        fractions, vents, ash:fallout(v,level,false), pumice:fallout(v,level,true), pyro:pyroPaths(v,level,shirasu), shirasu, ventType });
      pending.sort((a,b)=>a.id-b.id);
      v.magmaVolume -= volume; v.pressure = clamp(v.magmaVolume/v.capacity,0,1); v.lastEruptionDay = tick/4;
      ledger.sourceDRE += volume;
      sky.push({ x:v.x,y:v.y,strength:explosion*level/4,day:tick/4,id }); if (sky.length>64) sky.shift();
      emit('eruption',id,`${v.composition} ${ventType} eruption`);
      if (shirasu) emit('shirasu',id,'Broad non-welded felsic pyroclastic deposit');
      return { ok:true,volumeDRE:volume,durationDays:steps/4,ventType };
    }
    function inject() {
      for (const p of pending) {
        const amount = p.stepsLeft === 1 ? p.remaining : Math.min(p.rate,p.remaining), v=volcanoes[p.id];
        let assigned=0;
        for (const material of MATERIALS) {
          const dose = material === 'pyro' ? amount-assigned : amount*p.fractions[material]; assigned += dose;
          ledger.materials[material].sourceDRE += dose;
          const kernel = material === 'lava' ? p.vents : p[material]; let distributed=0;
          for (let i=0;i<kernel.length;i++) {
            const q=kernel[i], share=i===kernel.length-1 ? dose-distributed : dose*q.w; distributed+=share;
            if (material==='lava') addLava(q.x,q.y,share,v);
            else addMaterial(material,q.x,q.y,share,material==='pyro'&&p.shirasu ? 3.3 : EXPANSION[material]);
          }
        }
        p.remaining -= amount; p.stepsLeft--;
        if (!p.stepsLeft) emit('eruption-end',p.id,'Reservoir discharge completed');
      }
      pending = pending.filter(p=>p.stepsLeft>0);
    }
    function flowAndCool() {
      // Read old state throughout allocation. Accumulate transported volume and
      // sensible heat/mixing properties before changing any cell (no traversal bias).
      const delta = new Map(), oldKeys=Array.from(active).sort((a,b)=>a-b);
      function change(k, volume, c) {
        let d=delta.get(k); if(!d){d=[0,0,0,0,0,0];delta.set(k,d);}
        d[0]+=volume; d[1]+=volume*c.interior; d[2]+=volume*c.surface;
        d[3]+=volume*c.viscosity; d[4]+=volume*c.solidus; d[5]+=volume*c.eruptionTemperature;
      }
      for (const k of oldKeys) {
        const c=cells.get(k); if(!c || c.liquid<=0) continue;
        const h=c.liquid/area, z=surfaceAt(c.x,c.y), mu=c.viscosity*Math.exp(clamp((c.eruptionTemperature-c.interior)/75,0,15));
        const candidates=[]; let total=0;
        for(const [ox,oy] of NEIGHBOURS){
          const x=c.x+ox,y=c.y+oy, distance=edge*Math.hypot(ox,oy);
          const down=z-(inside(x,y)?surfaceAt(x,y):baseHeight((x+.5)/REFINE,(y+.5)/REFINE));
          if(down<=0)continue;
          const q=Math.min(2600*9.81*h*h*h/(3*mu)*(down/distance)*edge*DT/8, down*area/10);
          if(q>0){candidates.push({x,y,q});total+=q;}
        }
        if(total>0){
          const factor=Math.min(1,c.liquid*0.42/total);
          for(const q of candidates){
            const amount=q.q*factor; change(k,-amount,c);
            if(inside(q.x,q.y))change(key(q.x,q.y),amount,c); else exported('lava',amount);
          }
        }
      }
      for(const [k,d] of delta){
        const c=get(k%FW,Math.floor(k/FW)), old=c.liquid, next=Math.max(0,old+d[0]);
        if(next>0){
          c.interior=(old*c.interior+d[1])/next; c.surface=(old*c.surface+d[2])/next;
          c.viscosity=Math.max(1,(old*c.viscosity+d[3])/next); c.solidus=(old*c.solidus+d[4])/next;
          c.eruptionTemperature=(old*c.eruptionTemperature+d[5])/next;
          active.add(k);
        }
        c.liquid=next; mark(c);
      }
      for(const k of Array.from(active).sort((a,b)=>a-b)){
        const c=cells.get(k);
        if(!c || c.liquid<=0){active.delete(k);continue;}
        const depth=(c.liquid+c.solid)/area, wet=waterAt(c.x,c.y), air=wet?4:weather((c.x+.5)/REFINE,(c.y+.5)/REFINE).temp;
        const surfaceTau=3600*(wet?0.35:10)*(1+Math.sqrt(depth)*0.3);
        const interiorTau=DAY*(0.3+1.8*Math.pow(Math.max(depth,.01),1.1));
        c.surface=air+(c.surface-air)*Math.exp(-DT/surfaceTau);
        c.interior += (c.surface-c.interior)*(1-Math.exp(-DT/interiorTau));
        // Crust growth approximates latent-heat-limited solidification. A cool
        // skin never instantly freezes a thick insulated submarine interior.
        const crustFraction=(1-Math.exp(-DT/(interiorTau*3)))*clamp((c.solidus-c.surface)/Math.max(1,c.solidus-air),0,1);
        const frozen=c.interior<=c.solidus || c.liquid<1e-7 ? c.liquid : c.liquid*crustFraction;
        c.liquid-=frozen;c.solid+=frozen;
        if(!c.liquid)active.delete(k);
        mark(c);
      }
    }
    function downhill(x,y,steps,routing){
      let current={x,y};
      for(let s=0;s<steps;s++){
        const z=surfaceAt(current.x,current.y), route=routing?riverRoutes.get(baseIndex(current.x,current.y)):null;
        if(route && (route.x!==current.x||route.y!==current.y) && surfaceAt(route.x,route.y)<=z){current={...route};continue;}
        let next=null,best=z;
        for(const [ox,oy] of NEIGHBOURS){const nx=current.x+ox,ny=current.y+oy;
          const nz=inside(nx,ny)?surfaceAt(nx,ny):baseHeight((nx+.5)/REFINE,(ny+.5)/REFINE)-.01;
          if(nz<best){best=nz;next={x:nx,y:ny};}
        }
        if(!next)break;current=next;if(!inside(current.x,current.y))break;
      }
      return current;
    }
    function monthly(){
      for(const v of volcanoes){
        const quiet=tick/4-(v.lastEruptionDay??0);
        if(v.active && quiet>=18000 && v.supply/v.capacity < 1/(360*200) && !pending.some(p=>p.id===v.id)){
          v.active=false;emit('dormant',v.id,'休止状態へ移行');
        }
        if(v.supply<=0)continue;
        const addition=Math.min(v.capacity-v.magmaVolume,v.supply*30);v.magmaVolume+=addition;ledger.rechargedDRE+=addition;
        v.pressure=clamp(v.magmaVolume/v.capacity,0,1);
        if(!v.active && v.pressure>.55 && random()<clamp((v.pressure-.5)*2,0,1)){v.active=true;emit('reactivation',v.id,'活動を再開');}
      }
      const transfers=[];
      for(const k of Array.from(erodible).sort((a,b)=>a-b)){
        const c=cells.get(k);if(!c)continue;
        // Sub-millimetre loose cover remains in the mass/terrain ledger but is
        // below this grid's transport resolution. New deposition reactivates it.
        if((c.ash*EXPANSION.ash+c.pumice*EXPANSION.pumice+c.pyroBulk)/area<.001){erodible.delete(k);continue;}
        const w=weather((c.x+.5)/REFINE,(c.y+.5)/REFINE), z=surfaceAt(c.x,c.y), near=downhill(c.x,c.y,1,false);
        const fall=inside(near.x,near.y)?Math.max(0,z-surfaceAt(near.x,near.y)):edge;
        const slope=fall/edge, water=river?.water?.[baseIndex(c.x,c.y)]||0;
        const fraction=clamp(w.rain/1000*(0.02+slope*0.5)*(water?2:1),0,0.18);
        const lahar=w.rain>=160 && (slope>.01 || water);
        const dest=downhill(c.x,c.y,lahar?8:2,lahar);
        if((dest.x!==c.x||dest.y!==c.y) && fraction>0){
          for(const material of ['ash','pumice','pyro']){
            const dose=c[material]*fraction*(material==='pumice'?.6:1);if(dose<=0)continue;
            const expansion=material==='pyro'?c.pyroBulk/Math.max(c.pyro,1e-30):EXPANSION[material];
            c[material]-=dose;if(material==='pyro')c.pyroBulk-=dose*expansion;
            if(material==='pumice')c.floating=Math.min(c.floating,c.pumice);
            ledger.erodedDRE+=dose;if(lahar)ledger.laharDRE+=dose;
            transfers.push({material,...dest,dose,expansion});mark(c);
          }
        }
        if(c.floating>0 && waterAt(c.x,c.y)){
          const drift=c.floating*0.2, x=c.x+Math.sign(w.wx), y=c.y+Math.sign(w.wy);
          c.floating-=drift;c.pumice-=drift;transfers.push({material:'pumice',x,y,dose:drift,expansion:5});mark(c);
        }
      }
      for(const t of transfers)addMaterial(t.material,t.x,t.y,t.dose,t.expansion);
      if(transfers.length && ledger.laharDRE>0)emit('lahar',-1,'Rain remobilized loose volcanic deposits');
    }
    function advanceTo(target){
      if(!Number.isSafeInteger(target)||target<day||target*4>Number.MAX_SAFE_INTEGER)throw new RangeError('time must advance to an integer day');
      const end=target*4;
      while(tick<end){
        if(!pending.length&&!active.size){
          // Empty/frozen periods jump to monthly boundaries; no per-day map scan.
          tick=Math.min(end,(Math.floor(tick/120)+1)*120);
          if(tick%120===0)monthly();
        }else{
          inject();flowAndCool();tick++;
          if(tick%120===0)monthly();
        }
        sky=sky.filter(s=>tick/4-s.day<180);
      }
      day=target;
      for(const v of volcanoes){const z=heightAt(v.x,v.y);v.summit=Math.round(z);v.setting=z<0?'submarine':'land';}
    }
    function totals(stateCells=cells,statePending=pending,stateVolcanoes=volcanoes,stateLedger=ledger){
      const materials=Object.fromEntries(MATERIALS.map(k=>[k,{...stateLedger.materials[k],currentDRE:0,bulkVolume:0}]));
      let activeCells=0, floatingPumiceDRE=0;
      const baseAsh=new Map();
      const list=Array.from(stateCells.values()).sort((a,b)=>key(a.x,a.y)-key(b.x,b.y));
      for(const c of list){
        const lava=c.liquid+c.solid;
        materials.lava.currentDRE+=lava;materials.lava.bulkVolume+=lava;
        for(const k of ['ash','pumice','pyro']){materials[k].currentDRE+=c[k];materials[k].bulkVolume+=k==='pyro'?c.pyroBulk:c[k]*EXPANSION[k];}
        if(c.liquid>0)activeCells++;floatingPumiceDRE+=c.floating;
        const bi=baseIndex(c.x,c.y);baseAsh.set(bi,(baseAsh.get(bi)||0)+c.ash*EXPANSION.ash);
      }
      const currentDRE=sum(MATERIALS.map(k=>materials[k].currentDRE)),pendingDRE=sum(statePending.map(p=>p.remaining));
      const reservoirDRE=sum(stateVolcanoes.map(v=>v.magmaVolume));
      return {...stateLedger,materials,currentDRE,pendingDRE,reservoirDRE,
        massErrorDRE:stateLedger.sourceDRE-currentDRE-stateLedger.exportedDRE-pendingDRE,
        reservoirErrorDRE:stateLedger.initialMagmaDRE+stateLedger.rechargedDRE-reservoirDRE-stateLedger.sourceDRE,
        bulkVolume:sum(MATERIALS.map(k=>materials[k].bulkVolume)),hiddenAshBulk:sum(Array.from(baseAsh.values()).filter(v=>v/(scale*scale)<ASH_THRESHOLD)),
        activeCells,totalCells:stateCells.size,floatingPumiceDRE,refinement:REFINE,detailStep:1/REFINE,day };
    }
    const measure=()=>totals();
    function drainChanges(){
      const aggregate=new Map(),detail=[];
      for(const c of orderedCells()){
        const bi=baseIndex(c.x,c.y);let a=aggregate.get(bi);if(!a){a={other:0,ash:0};aggregate.set(bi,a);}
        a.other+=c.liquid+c.solid+c.pumice*5+c.pyroBulk;a.ash+=c.ash*3.5;
        const x=(c.x+.5)/REFINE,y=(c.y+.5)/REFINE;
        detail.push({x,y,z:baseHeight(x,y)+bulk(c)/area,lava:(c.liquid+c.solid)/area,
          ash:c.ash*3.5/area,pumice:c.pumice*5/area,pyro:c.pyroBulk/area,
          active:c.liquid>0,surfaceTemperature:c.surface,liquidFraction:c.liquid/Math.max(1e-30,c.liquid+c.solid),temperature:c.liquid>0?c.interior:c.surface});
      }
      const output=[];
      for(const bi of Array.from(dirty).sort((a,b)=>a-b)){
        const a=aggregate.get(bi)||{other:0,ash:0};
        output.push([bi,base[bi]+(a.other+(a.ash/(scale*scale)>=ASH_THRESHOLD?a.ash:0))/(scale*scale)]);
      }
      const out={cells:output,detail,volcanoes:volcanoes.map(v=>({...copy(v),eruption:pending.some(p=>p.id===v.id)})),events:copy(events),
        sky:sky.map(s=>({x:s.x,y:s.y,strength:s.strength*Math.exp(-(tick/4-s.day)/24),ageDays:tick/4-s.day})),metrics:measure()};
      dirty.clear();events=[];return out;
    }
    function snapshot(){
      return {version:1,width:W,height:H,metresPerBlock:scale,refinement:REFINE,baseHash:baseHash>>>0,
        day,tick,rng,volcanoes:copy(volcanoes),cells:copy(orderedCells()),pending:copy(pending),sky:copy(sky),events:copy(events),ledger:copy(ledger)};
    }
    function restore(saved){
      // Build and audit an entirely separate candidate. No live state changes
      // until dimensions, finite values, material/reservoir ledgers and references pass.
      if(!saved||saved.version!==1||saved.width!==W||saved.height!==H||saved.metresPerBlock!==scale||saved.refinement!==REFINE||saved.baseHash!==(baseHash>>>0))throw new RangeError('incompatible volcano snapshot');
      validNumbers(saved);
      if(!Number.isSafeInteger(saved.day)||saved.day<0||saved.tick!==saved.day*4||!Number.isInteger(saved.rng)||saved.rng<0||saved.rng>4294967295)throw new RangeError('invalid snapshot clock/rng');
      checkVolcanoes(saved.volcanoes);
      if(!Array.isArray(saved.cells)||!Array.isArray(saved.pending)||!Array.isArray(saved.sky)||!Array.isArray(saved.events)||!saved.ledger)throw new TypeError('invalid snapshot arrays');
      const next=copy(saved),newCells=new Map(),newActive=new Set(),newErodible=new Set();
      for(const c of next.cells){
        if(!Number.isInteger(c.x)||!Number.isInteger(c.y)||!inside(c.x,c.y)||newCells.has(key(c.x,c.y)))throw new RangeError('invalid snapshot cell');
        for(const name of ['liquid','solid','ash','pumice','pyro','pyroBulk','floating'])if(!(c[name]>=0))throw new RangeError('invalid material volume');
        for(const name of ['surface','interior','viscosity','solidus','eruptionTemperature'])finite(c[name],name);
        if(c.floating>c.pumice||c.viscosity<=0||c.pyroBulk<c.pyro||c.pyroBulk>c.pyro*6+1e-7)throw new RangeError('inconsistent material state');
        const k=key(c.x,c.y);newCells.set(k,c);if(c.liquid>0)newActive.add(k);if(c.ash+c.pumice+c.pyro>1e-10)newErodible.add(k);
      }
      const ids=new Set();
      for(const p of next.pending){
        if(!Number.isInteger(p.id)||!next.volcanoes[p.id]||ids.has(p.id)||!Number.isInteger(p.level)||p.level<1||p.level>4||!Number.isInteger(p.stepsLeft)||p.stepsLeft<1||p.stepsLeft>80||!(p.remaining>0)||!(p.volume>=p.remaining)||!(p.rate>0))throw new RangeError('invalid pending eruption');
        ids.add(p.id);
        if(!p.fractions||Math.abs(sum(MATERIALS.map(k=>p.fractions[k]))-1)>1e-10||MATERIALS.some(k=>!(p.fractions[k]>=0)))throw new RangeError('invalid material fractions');
        for(const name of ['vents','ash','pumice','pyro']){
          if(!Array.isArray(p[name])||!p[name].length||p[name].length>10000)throw new RangeError('invalid eruption footprint');
          if(Math.abs(sum(p[name].map(q=>q.w))-1)>1e-10)throw new RangeError('invalid footprint weights');
          for(const q of p[name])if(!Number.isSafeInteger(q.x)||!Number.isSafeInteger(q.y)||!(q.w>=0))throw new RangeError('invalid footprint point');
        }
      }
      for(const k of ['initialMagmaDRE','rechargedDRE','sourceDRE','exportedDRE','erodedDRE','laharDRE'])if(!(next.ledger[k]>=0))throw new RangeError('invalid ledger');
      for(const k of MATERIALS)for(const n of ['sourceDRE','exportedDRE'])if(!(next.ledger.materials?.[k]?.[n]>=0))throw new RangeError('invalid material ledger');
      const m=totals(newCells,next.pending,next.volcanoes,next.ledger),tolerance=Math.max(1e-4,next.ledger.sourceDRE*1e-9);
      if(Math.abs(m.massErrorDRE)>tolerance||Math.abs(m.reservoirErrorDRE)>Math.max(tolerance,next.ledger.initialMagmaDRE*1e-9))throw new RangeError('unbalanced snapshot ledger');
      for(const k of MATERIALS){const a=m.materials[k];if(Math.abs(a.sourceDRE-a.currentDRE-a.exportedDRE)>tolerance)throw new RangeError('unbalanced material ledger');}
      if(Math.abs(sum(MATERIALS.map(k=>next.ledger.materials[k].exportedDRE))-next.ledger.exportedDRE)>tolerance||Math.abs(sum(MATERIALS.map(k=>next.ledger.materials[k].sourceDRE))+m.pendingDRE-next.ledger.sourceDRE)>tolerance)throw new RangeError('inconsistent aggregate ledger');
      if(next.sky.length>64||next.events.length>256)throw new RangeError('oversized transient state');
      for(const s of next.sky)if(!(s.day>=0&&s.day<=next.day)||!(s.strength>=0&&s.strength<=1)||!Number.isFinite(s.x)||!Number.isFinite(s.y))throw new RangeError('invalid sky state');
      const rebuilt=new Set(dirty);for(const c of cells.values())rebuilt.add(baseIndex(c.x,c.y));for(const c of newCells.values())rebuilt.add(baseIndex(c.x,c.y));
      cells=newCells;active=newActive;erodible=newErodible;dirty=rebuilt;volcanoes=next.volcanoes;
      pending=next.pending;sky=next.sky;events=next.events;ledger=next.ledger;day=next.day;tick=next.tick;rng=next.rng;
      return {ok:true};
    }
    return {erupt,advanceTo,drainChanges,heightAt,snapshot,restore,measure};
  }
  return {decorate,create,version:1,refinement:REFINE};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = VolcanoCore;
