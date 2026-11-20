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
  // A pattern through the spatial steps equals the data through them: what ICA's Reveal compares components with
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('magnetometers', 'environment 50 nT  line 100 nT  cardiac 70 bpm 3 pT')));
    const W = S.refWeights(ds), U = S.orthonormal(S.sspEmptyRoom(ds, 3, { room: true }).map(x => x.v));
    const g = ds.gens.find(x => x.group === 'cardiac');
    const rec = MEG.assemble(ds, { enabled: new Set(['cardiac']), noise: false, filters: false });
    const i = g.tc.reduce((b, x, k, a) => (Math.abs(x) > Math.abs(a[b]) ? k : b), 0);
    const data = S.applySSP(S.applyRefs(rec.rows, rec.refs, W), U).map(r => r[i] / g.tc[i]);
    const pat = S.patternAfter(ds, { W, U }, g);
    const err = Math.sqrt(pat.reduce((a, x, c) => a + (x - data[c]) ** 2, 0) / pat.reduce((a, x) => a + x * x, 0));
    ok(err < 1e-4, `the heart's pattern after references and SSP matches the data (relative error ${err.toExponential(1)})`);
    const raw = MEG.genPattern(ds, g), cosine = (a, b) => { let ab = 0, aa = 0, bb = 0; a.forEach((x, c) => { ab += x * b[c]; aa += x * x; bb += b[c] * b[c]; }); return ab / Math.sqrt(aa * bb); };
    console.log(`  heart: raw pattern vs after references and SSP, cosine ${cosine(raw, pat).toFixed(2)}`);
    ok(cosine(raw, pat) < 0.9, 'and differs from the raw pattern, so Reveal must not use the raw one');
  }
  {
    const ds = MEG.simulate(MEG.dsl.build(prog('planar', 'environment 50 nT')));
    const model = S.sssModel(ds, ds.pose.ref, S.defaultOrder(ds.array.nch));
    const g = ds.gens.find(x => x.group === 'A');
    const pat = S.patternAfter(ds, { sssModel: model }, g), ref = S.sssProjectPattern(model, MEG.genPattern(ds, g));
    const err = Math.sqrt(pat.reduce((a, x, c) => a + (x - ref[c]) ** 2, 0) / ref.reduce((a, x) => a + x * x, 0));
    ok(err < 1e-4, `a pattern through SSS matches the SSS projection (relative error ${err.toExponential(1)})`);
  }
  // The sensor-noise cost of the steps, as the Noise tab states it, matches the noise itself
  {
    const rmsKind = (ds, rows, kind) => { const idx = ds.array.channels.map((c, i) => (c.kind === kind ? i : -1)).filter(i => i >= 0); return Math.sqrt(idx.reduce((a, c) => a + MEG.rms(rows[c]) ** 2, 0) / idx.length); };
    const noiseRows = ds => { const nch = ds.array.nch, ntot = nch + ds.array.refs.length, rows = []; for (let c = 0; c < ntot; c++) rows.push(Float32Array.from(MEG.sensorNoise(ds, c))); return { rows: rows.slice(0, nch), refs: rows.slice(nch) }; };
    const dm = MEG.simulate(MEG.dsl.build(prog('magnetometers', '')));
    const nm = noiseRows(dm), W = S.refWeights(dm);
    const measured = rmsKind(dm, S.applyRefs(nm.rows, nm.refs, W), 'mag') / rmsKind(dm, nm.rows, 'mag');
    const stated = S.sensorNoiseGain(dm, { W }).mag;
    near(stated, measured, 0.05 * measured, 'reference compensation: stated noise gain on magnetometers');
    const dp = MEG.simulate(MEG.dsl.build(prog('planar', '')));
    const np = noiseRows(dp), model = S.sssModel(dp, dp.pose.ref, S.defaultOrder(dp.array.nch));
    const sss = await S.applySSS(dp, np.rows, {});
    const gain = S.sensorNoiseGain(dp, { sssModel: model });
    near(gain.mag, rmsKind(dp, sss.rows, 'mag') / rmsKind(dp, np.rows, 'mag'), 0.05 * gain.mag, 'SSS: stated noise gain on magnetometers');
    near(gain.planar, rmsKind(dp, sss.rows, 'planar') / rmsKind(dp, np.rows, 'planar'), 0.05 * gain.planar, 'SSS: stated noise gain on planar gradiometers');
    console.log(`  sensor noise: references x${stated.toFixed(2)} on magnetometers; SSS x${gain.mag.toFixed(2)} on magnetometers, x${gain.planar.toFixed(2)} on gradiometers`);
  }
  summary('suppress');
})();
