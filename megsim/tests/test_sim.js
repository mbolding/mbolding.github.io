'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'examples', 'dsp', 'sim']);
const v3 = MEG.v3;
const prog = (extra, art) => `recording { sensors magnetometers rate 250 Hz highpass off lowpass 100 Hz background 100 fT }
  shielding { room on }
  source auditory A { side both amp 30 nAm }
  timeline { block open 2 s trials 30 isi 1 s { condition tone 100% } }
  artifacts { ${art || 'environment 50 nT  line 100 nT  cardiac 70 bpm 3 pT  blinks 0.3 Hz 2 pT  muscle 0.1 Hz 2 pT  dental 300 pT  jumps 0.1 Hz 5 pT  bad MRT31 noisy  movement 5 mm'} }
  ${extra || ''}`;
const cfg = MEG.dsl.build(prog());
const ds = MEG.simulate(cfg);
const all = new Set(ds.groups.map(g => g.id));
const en = new Set(ds.groups.filter(g => g.on).map(g => g.id));

// Determinism and independence: switching one group off leaves the others sample for sample
{
  const ds2 = MEG.simulate(MEG.dsl.build(prog()));
  const a = MEG.assemble(ds, { enabled: en }), b = MEG.assemble(ds2, { enabled: en });
  let d = 0; a.rows.forEach((r, c) => { for (let i = 0; i < r.length; i += 7) d = Math.max(d, Math.abs(r[i] - b.rows[c][i])); });
  ok(d === 0, 'the same program and seed give the same recording');
  const only = MEG.assemble(ds, { enabled: new Set(['A']), noise: false, filters: false });
  const noBlink = new Set(['A', 'blinks']);
  const withB = MEG.assemble(ds, { enabled: noBlink, noise: false, filters: false });
  const blinkOnly = MEG.assemble(ds, { enabled: new Set(['blinks']), noise: false, filters: false });
  let e = 0; withB.rows.forEach((r, c) => { for (let i = 0; i < r.length; i += 5) e = Math.max(e, Math.abs(r[i] - only.rows[c][i] - blinkOnly.rows[c][i])); });
  ok(e < 1e-3, 'recordings add up: source + blinks = both together (' + e + ')');
}
// Incremental sums: adding then subtracting a group returns to where we were
{
  const base = MEG.sumGroups(ds, new Set(['A', 'background']), {});
  const copy = base.map(r => Float32Array.from(r));
  MEG.sumGroups(ds, new Set(['cardiac', 'environment']), { into: base });
  MEG.sumGroups(ds, new Set(['cardiac', 'environment']), { into: base, subtract: true });
  let e = 0, m = 0; base.forEach((r, c) => { for (let i = 0; i < r.length; i += 3) { e = Math.max(e, Math.abs(r[i] - copy[c][i])); m = Math.max(m, Math.abs(copy[c][i])); } });
  ok(e < 1e-4 * m + 1e-3, 'adding and removing a group is exact to float precision (' + e.toExponential(1) + ')');
}
// Sizes: the environment and the room
{
  const centre = MEG.SITES.findIndex(s => s.th === 0);
  const open = MEG.assemble(ds, { enabled: new Set(['environment']), noise: false, filters: false, room: false });
  const shut = MEG.assemble(ds, { enabled: new Set(['environment']), noise: false, filters: false, room: true });
  let mo = 0; open.rows[centre].forEach(x => { mo = Math.max(mo, Math.abs(x)); });
  ok(mo > 15e6 && mo <= 50.5e6, 'environment at the vertex without the room is tens of nT: ' + MEG.fmtB(mo));
  const ratio = MEG.rms(open.rows[centre]) / MEG.rms(shut.rows[centre]);
  ok(ratio > 300 && ratio < 3000, 'the room attenuates the slow environment by ' + ratio.toFixed(0) + 'x');
  const lineOpen = MEG.assemble(ds, { enabled: new Set(['line']), noise: false, filters: false, room: false }), lineShut = MEG.assemble(ds, { enabled: new Set(['line']), noise: false, filters: false, room: true });
  const lr = MEG.rms(lineOpen.rows[centre]) / MEG.rms(lineShut.rows[centre]);
  ok(lr > 2e4, 'the room attenuates 60 Hz far more: ' + lr.toExponential(1) + 'x');
  const card = MEG.assemble(ds, { enabled: new Set(['cardiac']), noise: false, filters: false });
  let mc = 0; card.rows.forEach(r => r.forEach(x => { mc = Math.max(mc, Math.abs(x)); }));
  near(mc, 3000, 300, 'cardiac peaks at about 3 pT on the worst magnetometer');
}
// Gradiometers reject distant sources but keep the brain
{
  const dsA = MEG.simulate(MEG.dsl.build(prog('', 'environment 50 nT  cardiac 70 bpm 3 pT')));
  const rms = (type, groups) => { MEG.setArray(dsA, type); const r = MEG.assemble(dsA, { enabled: new Set(groups), noise: false, filters: false }); return Math.sqrt(r.rows.reduce((a, row) => a + MEG.rms(row) ** 2, 0) / r.rows.length); };
  const envM = rms('mag', ['environment']), envA = rms('axial', ['environment']), brainM = rms('mag', ['A']), brainA = rms('axial', ['A']);
  const cardM = rms('mag', ['cardiac']), cardA = rms('axial', ['cardiac']);
  console.log(`  environment: mag ${MEG.fmtB(envM)}, axial ${MEG.fmtB(envA)}; heart: mag ${MEG.fmtB(cardM)}, axial ${MEG.fmtB(cardA)}; M100: mag ${MEG.fmtB(brainM)}, axial ${MEG.fmtB(brainA)}`);
  ok(envA < envM / 20, 'axial gradiometers reject the environment by more than 20x');
  ok(cardA < cardM / 2.5, 'and the heart by more than 2.5x');
  ok(brainA > brainM / 2, 'but keep more than half of the brain signal');
}
// OPMs: closer, and lost without the room
{
  const dsO = MEG.simulate(MEG.dsl.build(prog().replace('magnetometers', 'opm')));
  const r = MEG.assemble(dsO, { enabled: new Set(['A']), noise: false, filters: false });
  const m = MEG.assemble(ds, { enabled: new Set(['A']), noise: false, filters: false });
  const pk = rec => { let x = 0; rec.rows.forEach(row => row.forEach(v => { x = Math.max(x, Math.abs(v)); })); return x; };
  ok(pk(r) > 2 * pk(m), `OPMs see the M100 more than twice as large (${MEG.fmtB(pk(r))} vs ${MEG.fmtB(pk(m))})`);
  const sat = MEG.assemble(dsO, { enabled: new Set(['A']), room: false });
  ok(sat.saturated && Math.abs(sat.rows[0][100]) > 1e6, 'OPMs saturate outside the shielded room');
  // OPMs moving through the residual field: nulling makes it 25 times smaller
  const mv = MEG.assemble(dsO, { enabled: new Set(['movement']), noise: false, filters: false, nulling: false });
  const mvN = MEG.assemble(dsO, { enabled: new Set(['movement']), noise: false, filters: false, nulling: true });
  const big = MEG.rms(mv.rows[10]), small = MEG.rms(mvN.rows[10]);
  ok(big > 1000 && Math.abs(big / small - 25) < 1, `moving OPMs pick up the residual field (${MEG.fmtB(big)}), nulling divides it by 25`);
}
// Movement changes what the SQUIDs see of the brain
{
  const still = MEG.assemble(ds, { enabled: new Set(['A']), noise: false, filters: false });
  const moving = MEG.assemble(ds, { enabled: new Set(['A', 'movement']), noise: false, filters: false });
  let d = 0, m = 0; still.rows.forEach((r, c) => { for (let i = 0; i < r.length; i += 3) { d = Math.max(d, Math.abs(r[i] - moving.rows[c][i])); m = Math.max(m, Math.abs(r[i])); } });
  ok(d > 0.05 * m, 'a moving head changes the brain signal at the sensors (' + (100 * d / m).toFixed(0) + '% of peak)');
  const p = ds.pose.at(ds.dur);
  ok(v3.norm(p.trans) > 0.05 && v3.norm(p.trans) < 2, 'the head ends up displaced by ' + (10 * v3.norm(p.trans)).toFixed(1) + ' mm');
}
// Flux jumps are steps that stay; a flat channel is flat
{
  const r = MEG.assemble(ds, { enabled: new Set(['jumps']), noise: false, filters: false });
  const j = ds.jumps.find(x => !x.unshielded);
  if (j) {
    const c = j.site, i = Math.round(j.t * ds.fs);
    near(r.rows[c][Math.min(r.n - 1, i + 50)] - r.rows[c][Math.max(0, i - 50)], j.amp, Math.abs(j.amp) * 0.01 + 1e-6, 'a flux jump is a step of its size');
  } else ok(true, 'no jump in this short recording');
  const cfgF = MEG.dsl.build(prog('', 'bad MLF11 flat'));
  const dsF = MEG.simulate(cfgF);
  const rf = MEG.assemble(dsF, { enabled: new Set(['A', 'bad', 'sensor']) });
  ok(MEG.rms(rf.rows[dsF.badSite]) === 0, 'a flat channel reads zero');
}
// Dental work moves with the jaw
{
  const r = MEG.assemble(ds, { enabled: new Set(['dental']), noise: false, filters: false });
  let m = 0; r.rows.forEach(row => row.forEach(x => { m = Math.max(m, Math.abs(x)); }));
  near(m, 300e3, 30e3, 'dental artifact peaks at about 300 pT');
}
summary('sim');
