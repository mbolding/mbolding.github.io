'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'examples', 'dsp', 'sim', 'suppress']);
const S = MEG.suppress;
const prog = (sensors, art) => `recording { sensors ${sensors} rate 250 Hz highpass 0.1 Hz lowpass 100 Hz background off }
  shielding { room on }
  source auditory A { side both amp 30 nAm }
  timeline { trials 25 isi 1 s { condition tone 100% } }
  artifacts { ${art} }`;
const rmsAll = rows => Math.sqrt(rows.reduce((a, r) => a + MEG.rms(r) ** 2, 0) / rows.length);
const diff = (a, b) => a.map((r, c) => Float32Array.from(r, (x, i) => x - b[c][i]));

(async () => {
  // Reference compensation on magnetometers
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('magnetometers', 'environment 50 nT')));
    const env = MEG.assemble(ds, { enabled: new Set(['environment']), noise: false });
    const W = S.refWeights(ds);
    const comp = S.applyRefs(env.rows, env.refs, W);
    const before = rmsAll(env.rows), after = rmsAll(comp);
    console.log(`  reference compensation: environment ${MEG.fmtB(before)} -> ${MEG.fmtB(after)} (${(before / after).toFixed(0)}x)`);
    ok(before / after > 30, 'references remove the environment from magnetometers by more than 30x');
    const brain = MEG.assemble(ds, { enabled: new Set(['A']), noise: false });
    const bc = S.applyRefs(brain.rows, brain.refs, W);
    const loss = rmsAll(diff(brain.rows, bc)) / rmsAll(brain.rows);
    ok(loss < 0.05, 'and change the brain signal by less than 5% (' + (100 * loss).toFixed(2) + '%)');
  }
  // SSP from the empty room
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('magnetometers', 'environment 50 nT  line 100 nT')));
    const env = MEG.assemble(ds, { enabled: new Set(['environment', 'line']), noise: false });
    const vecs = S.sspEmptyRoom(ds, 3, { room: true });
    const U = S.orthonormal(vecs.map(x => x.v));
    const after = rmsAll(S.applySSP(env.rows, U)), before = rmsAll(env.rows);
    console.log(`  SSP (3 vectors): environment ${MEG.fmtB(before)} -> ${MEG.fmtB(after)} (${(before / after).toFixed(0)}x); shares ${vecs.map(v => (100 * v.share).toFixed(1) + '%').join(', ')}`);
    ok(before / after > 30, 'three empty-room projectors remove the environment by more than 30x');
    const pat = MEG.genPattern(ds, ds.gens.find(g => g.group === 'A'));
    const loss = S.projectionLoss(pat, U);
    // Empty-room projectors are smooth patterns; on magnetometers they overlap a brain source's smooth field a lot.
    ok(loss > 0.05 && loss < 0.7, 'the auditory source loses part of its field to the projectors (' + (100 * loss).toFixed(1) + '%)');
    const dsP = MEG.simulate(MEG.dsl.build(prog('planar', 'environment 50 nT  line 100 nT')));
    const UP = S.orthonormal(S.sspEmptyRoom(dsP, 3, { room: true }).map(x => x.v));
    const lossP = S.projectionLoss(MEG.genPattern(dsP, dsP.gens.find(g => g.group === 'A')), UP);
    ok(lossP < loss, 'the 306-style array loses less to the same number of projectors (' + (100 * lossP).toFixed(1) + '%)');
  }
  // SSS on the 306-style array; refused for single-kind arrays
  ok(!S.sssAvailable(MEG.getArray('mag')) && !S.sssAvailable(MEG.getArray('opm')) && S.sssAvailable(MEG.getArray('planar')), 'SSS is offered only for the magnetometer-plus-gradiometer array');
  for (const sensors of ['planar']) {
    const ds = MEG.simulate(MEG.dsl.build(prog(sensors, 'environment 50 nT  line 100 nT')));
    const model = S.sssModel(ds, ds.pose.ref, S.defaultOrder(ds.array.nch));
    console.log(`  ${sensors}: SSS order ${model.order} (${model.nin} + ${model.nout} terms for ${ds.array.nch} channels), condition ${model.cond.toExponential(1)}, rank ${model.rank}`);
    const brain = MEG.assemble(ds, { enabled: new Set(['A']), noise: false });
    const sb = await S.applySSS(ds, brain.rows, {});
    const err = rmsAll(diff(sb.rows, brain.rows)) / rmsAll(brain.rows);
    ok(err < 0.05, `${sensors}: SSS keeps the brain signal (error ${(100 * err).toFixed(2)}%)`);
    const env = MEG.assemble(ds, { enabled: new Set(['environment', 'line']), noise: false });
    const se = await S.applySSS(ds, env.rows, {});
    const red = rmsAll(env.rows) / rmsAll(se.rows);
    ok(red > 100, `${sensors}: SSS removes the environment by ${red.toFixed(0)}x`);
  }
  // tSSS removes dental work that SSS keeps
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('planar', 'dental 300 pT')));
    const dent = MEG.assemble(ds, { enabled: new Set(['dental', 'A']), noise: true });
    const brain = MEG.assemble(ds, { enabled: new Set(['A']), noise: false });
    const s1 = await S.applySSS(ds, dent.rows, {});
    const s2 = await S.applySSS(ds, dent.rows, { tsss: true, buffer: 10, corr: 0.98 });
    const e1 = rmsAll(diff(s1.rows, brain.rows)), e2 = rmsAll(diff(s2.rows, brain.rows)), e0 = rmsAll(diff(dent.rows, brain.rows));
    console.log(`  dental: raw ${MEG.fmtB(e0)}, after SSS ${MEG.fmtB(e1)}, after tSSS ${MEG.fmtB(e2)} (removed ${s2.info.removed} components in ${s2.info.windows} windows)`);
    ok(e1 > 0.3 * e0, 'SSS leaves most of the dental artifact (it is inside the helmet)');
    ok(e2 < 0.3 * e1, 'tSSS removes most of what SSS left');
  }
  // Movement compensation brings the moving brain back to the starting position
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('planar', 'movement 8 mm')));
    const still = MEG.assemble(ds, { enabled: new Set(['A']), noise: false });
    const moving = MEG.assemble(ds, { enabled: new Set(['A', 'movement']), noise: false });
    const plain = await S.applySSS(ds, moving.rows, { moving: true });
    const comp = await S.applySSS(ds, moving.rows, { moving: true, compensate: true });
    const ref = await S.applySSS(ds, still.rows, {});
    const ePlain = rmsAll(diff(plain.rows, ref.rows)), eComp = rmsAll(diff(comp.rows, ref.rows));
    console.log(`  movement: error without compensation ${MEG.fmtB(ePlain)}, with ${MEG.fmtB(eComp)} (signal ${MEG.fmtB(rmsAll(ref.rows))})`);
    ok(eComp < 0.5 * ePlain, 'movement compensation halves the error or better');
  }
  summary('suppress');
})();
