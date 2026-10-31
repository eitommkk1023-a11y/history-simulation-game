const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const modulePath = path.join(__dirname, '../src/volcano-core.js');
const Core = fs.existsSync(modulePath) ? require(modulePath) : {};

// Removing the public numerical implementation must fail an assertion before any fixture runs.
test('provides the shared browser and worker numerical factory', () => {
  assert.equal(typeof Core.create, 'function');
  assert.equal(typeof Core.decorate, 'function');
});

function fixture(options = {}) {
  const width = options.width || 20, height = options.height || 20;
  const elevation = Float32Array.from({ length: width * height }, (_, i) =>
    options.terrain ? options.terrain(i % width, Math.floor(i / width)) : 100);
  const volcanoes = options.volcanoes || [{ id: 0, x: 10, y: 10, radius: 2, height: 100,
    summit: 200, kind: 1, active: true, morphology: 'shield', composition: 'basalt',
    structure: 'normal', setting: 'land', magmaVolume: 2e8, supply: 0, gas: 0.15,
    pressure: 0.5, temperature: 1180, viscosity: 250 }];
  return Core.create({ width, height, metresPerBlock: 1000, elevation, volcanoes, seed: 813,
    ...options, elevation, volcanoes });
}
function conserved(engine) {
  const m = engine.measure();
  assert.ok(Math.abs(m.massErrorDRE) <= Math.max(1e-5, m.sourceDRE * 1e-10), JSON.stringify(m));
  assert.ok(Math.abs(m.reservoirErrorDRE) <= Math.max(1e-5, m.initialMagmaDRE * 1e-10));
  for (const material of ['lava', 'ash', 'pumice', 'pyro']) {
    const a = m.materials[material];
    assert.ok(Math.abs(a.sourceDRE - a.currentDRE - a.exportedDRE) < Math.max(1e-5, a.sourceDRE * 1e-10));
  }
  return m;
}
function erupted(options = {}, level = 2, day = 8) {
  const e = fixture(options); assert.equal(e.erupt(0, level).ok, true); e.advanceTo(day); return e;
}
function centerOf(detail, field = 'lava') {
  let x = 0, y = 0, w = 0;
  for (const c of detail) { x += c.x * c[field]; y += c.y * c[field]; w += c[field]; }
  return { x: x / w, y: y / w, w };
}

test('terrain input stays immutable and a quiet engine never erupts', () => {
  const base = new Float32Array(100).fill(75);
  const e = fixture({ width: 10, height: 10, elevation: base, volcanoes: [] });
  e.advanceTo(3650); assert.deepEqual(Array.from(base), Array(100).fill(75));
  assert.equal(e.measure().sourceDRE, 0); assert.equal(e.measure().totalCells, 0);
});

test('decoration deterministically covers morphologies, compositions, caldera and submarine settings', () => {
  const vs = Array.from({ length: 240 }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20), kind: i % 2, active: true, radius: 2 }));
  const geo = { gridW: 20, gridH: 12, gridStep: 1, kmPerBlock: 1,
    crust: vs.map((_, i) => i % 4), boundaryType: vs.map((_, i) => i % 5), volcanism: vs.map(() => 1000) };
  const a = Core.decorate(vs, geo, 123, (x) => x < 5 ? -200 : 100);
  assert.deepEqual(a, Core.decorate(vs, geo, 123, (x) => x < 5 ? -200 : 100));
  assert.deepEqual(new Set(a.map(v => v.morphology)), new Set(['strato', 'shield', 'dome', 'scoria']));
  assert.deepEqual(new Set(a.map(v => v.composition)), new Set(['basalt', 'andesite', 'dacite', 'rhyolite']));
  assert.ok(a.some(v => v.structure === 'caldera')); assert.ok(a.some(v => v.setting === 'submarine'));
  a.forEach((v, i) => assert.equal(v.id, i));
});

test('a transform ocean floor does not receive universal magma recharge', () => {
  const vs = [{ x: 0, y: 0, kind: 1, active: false, radius: 2 }];
  const [v] = Core.decorate(vs, { gridW: 1, gridH: 1, gridStep: 1, crust: [0], boundaryType: [3], volcanism: [0], cause: [8] }, 2, () => -1000);
  assert.equal(v.supply, 0); assert.equal(v.active, false);
});

test('inactive, depleted, unknown, invalid strength and busy eruptions are explicit rejections', () => {
  const e = fixture(); assert.equal(e.erupt(9, 2).ok, false);
  assert.equal(e.erupt(0, 0).ok, false); assert.equal(e.erupt(0, 2.5).ok, false);
  assert.equal(e.erupt(0, 2).ok, true); assert.match(e.erupt(0, 2).reason, /busy/);
  const saved = fixture().snapshot(); saved.volcanoes[0].active = false;
  const inactive = fixture({ volcanoes: saved.volcanoes }); assert.match(inactive.erupt(0, 2).reason, /inactive/);
  saved.volcanoes[0].active = true; saved.volcanoes[0].magmaVolume = 0;
  assert.match(fixture({ volcanoes: saved.volcanoes }).erupt(0, 2).reason, /magma/);
});

test('four requested strengths reserve increasing finite volumes and inject over time', () => {
  const volumes = [];
  for (let level = 1; level <= 4; level++) {
    const e = fixture(); assert.equal(e.erupt(0, level).ok, true);
    const m = conserved(e); assert.equal(m.currentDRE, 0); assert.ok(m.pendingDRE > 0);
    volumes.push(m.pendingDRE); e.advanceTo(1); conserved(e); assert.ok(e.measure().currentDRE > 0);
    e.advanceTo(20); assert.equal(conserved(e).pendingDRE, 0);
  }
  assert.ok(volumes.every((v, i) => !i || v > volumes[i - 1]));
  const v = fixture().snapshot().volcanoes[0]; v.magmaVolume = 1234;
  const small = fixture({ volcanoes: [v] }); small.erupt(0, 4); assert.equal(small.measure().sourceDRE, 1234);
});

test('flat lava spreads across shared cells with a conservative DRE and bulk ledger', () => {
  const e = erupted({}, 3, 20), m = conserved(e);
  assert.ok(m.materials.lava.currentDRE > 1e6); assert.ok(m.totalCells > 20);
  assert.ok(e.drainChanges().detail.filter(c => c.lava > 0.01).length > 5);
  assert.ok(m.bulkVolume >= m.currentDRE);
});

test('lava follows a slope and concentrates into a valley', () => {
  const slope = erupted({ terrain: x => 500 - x * 30 }, 2, 12);
  assert.ok(centerOf(slope.drainChanges().detail).x > 10.15);
  const valley = erupted({ terrain: (x, y) => 400 - x * 20 + Math.abs(y - 10) * 90 }, 2, 12);
  const d = valley.drainChanges().detail;
  const onAxis = d.filter(c => Math.abs(c.y - 10) < 1).reduce((s, c) => s + c.lava, 0);
  assert.ok(onAxis > d.reduce((s, c) => s + c.lava, 0) * 0.7); conserved(valley);
});

test('submarine surface chills while its interior remains hot and mobile', () => {
  const e = erupted({ terrain: () => -500 }, 3, 1);
  const hot = e.snapshot().cells.filter(c => c.liquid > 0);
  assert.ok(hot.some(c => c.interior > c.surface + 100));
  assert.ok(hot.some(c => c.interior > 850)); conserved(e);
});

test('identical physics is independent of advanceTo partitioning', () => {
  const a = fixture(), b = fixture(); a.erupt(0, 3); b.erupt(0, 3);
  a.advanceTo(70); for (const day of [1, 3, 10, 31, 49, 70]) b.advanceTo(day);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('JSON save restoration continues the active eruption bit for bit', () => {
  const a = erupted({}, 4, 1), b = fixture(); b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  a.advanceTo(40); b.advanceTo(40); assert.deepEqual(a.snapshot(), b.snapshot()); conserved(b);
});

test('restore rejects nonfinite and inconsistent data atomically', () => {
  const e = erupted(), before = e.snapshot();
  for (const mutate of [s => { s.day = -1; }, s => { s.cells[0].liquid = NaN; },
    s => { s.volcanoes[0].magmaVolume = -1; }, s => { s.cells[0].x = 1e9; },
    s => { s.ledger.sourceDRE += 1e7; }, s => { s.version = 999; }]) {
    const bad = structuredClone(before); mutate(bad); assert.throws(() => e.restore(bad)); assert.deepEqual(e.snapshot(), before);
  }
});

test('restore emits every saved deposited base cell and full detail', () => {
  const a = erupted(), first = a.drainChanges(); assert.ok(first.cells.length);
  assert.equal(a.drainChanges().cells.length, 0); assert.equal(a.drainChanges().detail.length, first.detail.length);
  const b = fixture(); b.restore(a.snapshot()); const rebuilt = b.drainChanges();
  assert.equal(rebuilt.detail.length, first.detail.length); assert.deepEqual(rebuilt.cells, first.cells);
});

test('base downsampling accounts for deposited bulk and retained subthreshold ash', () => {
  const e = erupted({}, 3, 10), changes = e.drainChanges(), m = conserved(e);
  const visibleVolume = changes.cells.reduce((sum, [i, z]) => sum + (z - 100) * 1e6, 0);
  assert.ok(Math.abs(visibleVolume + m.hiddenAshBulk - m.bulkVolume) < m.bulkVolume * 1e-10);
  for (const c of changes.detail.slice(0, 20)) assert.equal(e.heightAt(c.x, c.y), c.z);
});

test('wind transports ash downwind and thin deposits retain mass', () => {
  const v = fixture().snapshot().volcanoes[0]; Object.assign(v, { composition: 'rhyolite', morphology: 'dome', gas: 0.9, viscosity: 1e8, temperature: 850 });
  const climate = { w: 1, h: 1, step: 20, tMean: Array(12).fill(150), precip: Array(12).fill(0),
    windDir: Array(12).fill(192), windSpeed: Array(12).fill(100) };
  const e = erupted({ volcanoes: [v], climate }, 3, 8), m = conserved(e);
  assert.ok(centerOf(e.drainChanges().detail, 'ash').x > 10.5);
  assert.ok(m.materials.ash.currentDRE > 0); assert.ok(m.materials.pumice.currentDRE > 0);
  // Thin fall-out is tested separately with a small reservoir; a large event may exceed the threshold everywhere.
});

test('energetic pyroclasts cross a low ridge but cannot overtop an arbitrarily high wall', () => {
  const v = fixture().snapshot().volcanoes[0]; Object.assign(v, { x: 8, composition: 'dacite', morphology: 'strato', gas: 0.9, viscosity: 1e6 });
  const low = erupted({ volcanoes: [v], terrain: x => x === 10 ? 250 : 100 }, 3, 8);
  const high = erupted({ volcanoes: [v], terrain: x => x === 10 ? 8000 : 100 }, 3, 8);
  const past = e => e.drainChanges().detail.filter(c => c.x > 11 && Math.abs(c.y - 10) < 2).reduce((s, c) => s + c.pyro, 0);
  assert.ok(past(low) > 0); assert.equal(past(high), 0); conserved(low); conserved(high);
});

test('large gas-rich felsic eruptions can form broad non-welded shirasu deposits', () => {
  const v = fixture().snapshot().volcanoes[0]; Object.assign(v, { composition: 'rhyolite', morphology: 'strato', gas: 0.9, viscosity: 1e8 });
  const e = erupted({ volcanoes: [v] }, 4, 15), changes = e.drainChanges();
  assert.ok(changes.events.some(e => e.type === 'shirasu'));
  assert.ok(changes.detail.filter(c => c.pyro > 0).length > 40);
  assert.ok(e.measure().materials.pyro.bulkVolume > e.measure().materials.pyro.currentDRE * 2.5);
});

test('rain erodes deposits after an eruption without modifying natural relief', () => {
  const climate = { w: 1, h: 1, step: 20, precip: Array(12).fill(900), tMean: Array(12).fill(150) };
  const e = erupted({ climate, terrain: x => 700 - 30 * x }, 3, 20);
  const before = e.measure(); e.advanceTo(120); const after = conserved(e);
  assert.ok(after.erodedDRE > before.erodedDRE); assert.ok(after.laharDRE > 0);
  assert.ok(e.drainChanges().detail.every(c => c.z >= 700 - 30 * c.x - 0.001));
});

test('frozen cells retire from flow while deposits survive and new lava reuses them', () => {
  const e = erupted({}, 1, 300), m = conserved(e);
  assert.equal(m.activeCells, 0); assert.ok(m.totalCells > 0); assert.ok(m.materials.lava.currentDRE > 0);
  const old = m.totalCells; assert.equal(e.erupt(0, 1).ok, true); e.advanceTo(310);
  conserved(e); assert.ok(e.measure().totalCells < old * 3);
});

test('repeated eruptions expand laterally and shields spread more broadly than domes', () => {
  const v = fixture().snapshot().volcanoes[0];
  const shield = fixture(), dome = fixture({ volcanoes: [{ ...v, morphology: 'dome', composition: 'rhyolite', viscosity: 1e9, temperature: 850, gas: 0.1 }] });
  const footprint = e => e.drainChanges().detail.filter(c => c.lava > 0.1).length;
  shield.erupt(0, 2); shield.advanceTo(30); const first = footprint(shield);
  shield.erupt(0, 2); shield.advanceTo(60); assert.ok(footprint(shield) > first);
  dome.erupt(0, 2); dome.advanceTo(60); assert.ok(footprint(shield) > footprint(dome)); conserved(shield); conserved(dome);
});

test('overlapping volcanoes conserve independent reservations in shared terrain', () => {
  const v = fixture().snapshot().volcanoes[0];
  const e = fixture({ volcanoes: [v, { ...v, id: 1, x: 10.2 }] });
  e.erupt(0, 2); e.erupt(1, 3); e.advanceTo(40); conserved(e);
  assert.equal(e.snapshot().volcanoes.filter(v => v.lastEruptionDay === 0).length, 2);
});

test('low-frequency recharge can reactivate a supported dormant system without erupting it', () => {
  const v = fixture().snapshot().volcanoes[0]; Object.assign(v, { active: false, supply: 1e6, magmaVolume: 1e6, capacity: 1e8 });
  const e = fixture({ volcanoes: [v] }); e.advanceTo(360);
  assert.equal(e.snapshot().volcanoes[0].active, true); assert.equal(e.measure().sourceDRE, 0);
  assert.equal(e.measure().activeCells, 0); conserved(e);
});

test('invalid dimensions, nonfinite terrain, malformed climate, and reversed time are rejected', () => {
  assert.throws(() => fixture({ metresPerBlock: 0 })); assert.throws(() => fixture({ width: -1 }));
  assert.throws(() => fixture({ terrain: () => NaN })); assert.throws(() => fixture({ climate: { w: 1, h: 1, step: 1, precip: [NaN] } }));
  const e = fixture({ day: 100 }); assert.equal(e.snapshot().day, 100);
  assert.throws(() => e.advanceTo(99)); assert.throws(() => e.advanceTo(100.5));
});

test('small ash fall remains recorded without raising the coarse terrain',()=>{
  const v=fixture().snapshot().volcanoes[0];Object.assign(v,{magmaVolume:100,gas:.9,composition:'rhyolite',viscosity:1e8,temperature:850});
  const e=erupted({volcanoes:[v]},1,10),m=conserved(e);
  assert.ok(m.hiddenAshBulk>0); assert.ok(m.hiddenAshBulk<=m.materials.ash.bulkVolume);
  assert.ok(e.drainChanges().detail.some(c=>c.ash>0&&c.ash<.01));
});
test('long inactive weak supply enters dormancy without spontaneous eruptions',()=>{
 const e=fixture();e.advanceTo(36000);assert.equal(e.snapshot().volcanoes[0].active,false);assert.equal(e.measure().sourceDRE,0);
});
test('pressure and viscosity affect discharge duration and partition',()=>{
 const v=fixture().snapshot().volcanoes[0];
 const low=fixture({volcanoes:[{...v,pressure:.1}]}),high=fixture({volcanoes:[{...v,pressure:.95}]});
 const a=low.erupt(0,2),b=high.erupt(0,2);assert.notEqual(a.durationDays,b.durationDays);
 const thick=fixture({volcanoes:[{...v,viscosity:1e8}]});assert.notEqual(thick.erupt(0,2).durationDays,b.durationDays);
});


test('six repeated eruptions at the game scale build broad islands and distinguish shield from strato',()=>{
 const run=morphology=>{
  const basalt=morphology==='shield';
  const v={...fixture().snapshot().volcanoes[0],morphology,composition:basalt?'basalt':'andesite',setting:'submarine',capacity:2e9,magmaVolume:2e9,temperature:basalt?1180:1000,viscosity:basalt?250:1e5};
  const e=fixture({metresPerBlock:3330,terrain:()=>-5,volcanoes:[v]});
  let first=0;
  for(let n=0;n<6;n++){assert.equal(e.erupt(0,3).ok,true);e.advanceTo((n+1)*60);conserved(e);if(n===0)first=e.drainChanges().detail.filter(p=>p.lava>.1).length;}
  const d=e.drainChanges(),wetToDry=d.cells.filter(p=>p[1]>0);
  assert.ok(wetToDry.length>=2,'island spans more than one base cell');
  const footprint=d.detail.filter(p=>p.lava>.1).length;
  assert.ok(footprint>first,'repeated eruption expands laterally');
  assert.ok(Math.max(...d.detail.map(p=>p.z))<200,'no isolated kilometre-scale spike');
  return footprint;
 };
 assert.ok(run('shield')>run('strato'));
});
