'use strict';
/* The lessons the examples and the Guide promise, checked against the
   simulation itself, so a change to the model cannot quietly break a claim
   the page makes. */
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'hemo', 'probe', 'dsl', 'sim', 'dsp', 'pipeline', 'examples', 'dot']);
const src = name => NIRS.EXAMPLES.find(e => e.name === name).src;
const peak = a => { let m = 0; for (const v of a) if (Math.abs(v) > Math.abs(m)) m = v; return m; };
function record(s, mod) {
  const cfg = NIRS.dsl.build(s), ds = NIRS.simulate(cfg), rec = NIRS.assemble(ds);
  const P = Object.assign(NIRS.pipeline.defaults(cfg), mod || {});
  const res = NIRS.pipeline.run(ds, rec, P);
  return { cfg, ds, rec, P, res, truth: NIRS.pipeline.truth(ds, P) };
}
const rerun = (R, mod) => { const P = Object.assign({}, R.P, mod); return { P, res: NIRS.pipeline.run(R.ds, R.rec, P), glm: null }; };
const longs = ds => ds.chans.filter(c => !c.short);

// 1. the scalp confound: a false activation that short-channel regression removes
{
  const R = record(src('Scalp confound: a false activation'));
  const off = R.res.avg[0], gOff = NIRS.pipeline.glm(R.ds, R.res, R.P);
  ok(longs(R.ds).every(c => peak(off[c.index].mHbo.mean) > 0.5), 'scalp confound: every long channel shows an HbO "activation" above 0.5 µM');
  ok(longs(R.ds).every(c => gOff[c.index].hbo.t[0] > 5), 'scalp confound: and the GLM calls every one significant');
  ok(longs(R.ds).every(c => Math.abs(peak(R.truth.avg[0][c.index].mHbo.mean)) < 1e-6), 'scalp confound: although the cortex did nothing');
  const on = rerun(R, { short: 'nearest', shortMode: 'glm' });
  const gOn = NIRS.pipeline.glm(R.ds, on.res, on.P);
  ok(longs(R.ds).every(c => Math.abs(peak(on.res.avg[0][c.index].mHbo.mean)) < 0.1 * peak(off[c.index].mHbo.mean)), 'scalp confound: short-channel regression removes over 90% of it from every average');
  ok(longs(R.ds).every(c => Math.abs(gOn[c.index].hbo.beta[0]) < 0.03 * gOff[c.index].hbo.beta[0]), 'scalp confound: and over 97% of it from every GLM beta');
}
// 2. finger tapping: the response where the cortex is, of the right size and shape
{
  const R = record(src('Finger tapping, block design'));
  const i = R.ds.chans.find(c => c.label === 'S3-D1').index;
  const m = R.res.avg[0][i], t = R.truth.avg[0][i];
  near(peak(m.mHbo.mean) / peak(t.mHbo.mean), 1, 0.25, 'tapping: the averaged HbO peak matches the truth within 25%');
  ok(peak(m.mHbr.mean) < 0 && peak(t.mHbr.mean) < 0, 'tapping: HbR falls');
  const ratio = peak(m.mHbo.mean) / -peak(m.mHbr.mean);
  ok(ratio > 2 && ratio < 6, `tapping: HbO rises ${ratio.toFixed(1)} times as much as HbR falls`);
  const g = NIRS.pipeline.glm(R.ds, R.res, R.P);
  ok(g[i].hbo.t[0] > 10 && g[i].hbr.t[0] < -10, 'tapping: the GLM finds the channel above the cortex');
  near(g[i].hbo.beta[0] / peak(t.mHbo.mean), 1, 0.25, 'tapping: GLM beta matches the true peak within 25%');
  const far = longs(R.ds).filter(c => peak(R.truth.avg[0][c.index].mHbo.mean) < 0.003);
  ok(far.length >= 3 && far.every(c => Math.abs(g[c.index].hbo.beta[0]) < 0.03), 'tapping: channels that do not see the cortex have betas near zero');
  // the true local change is far larger than what the Beer-Lambert law reports
  const local = Math.max(...R.ds.regionHb[R.ds.regions[0].id].hbo);
  ok(local / peak(t.mHbo.mean) > 15, `tapping: partial volume shrinks a ${local.toFixed(1)} µM local change ${(local / peak(t.mHbo.mean)).toFixed(0)} times`);
  // estimating the short channel's weight before anything else takes some of the response with it
  const before = rerun(R, { short: 'nearest', shortMode: 'before' });
  const taskbp = record(src('Finger tapping, block design').replace('taskbp 0.6 uM', 'taskbp 1.5 uM'), { short: 'nearest' });
  const tb = rerun(taskbp, { shortMode: 'before' });
  const j = taskbp.ds.chans.find(c => c.label === 'S3-D1').index;
  ok(peak(tb.res.avg[0][j].mHbo.mean) < 0.75 * peak(taskbp.res.avg[0][j].mHbo.mean), "tapping with a strong scalp response: regressing the short channel 'before' removes part of the real response");
  ok(before.res.avg[0][i].mHbo, 'before mode runs');
  // TDDR shrinks a clean response a little, faithful to the published method
  const td = rerun(R, { motion: 'tddr' });
  const shrink = peak(td.res.avg[0][i].mHbo.mean) / peak(m.mHbo.mean);
  ok(shrink > 0.6 && shrink < 1, `tapping: TDDR on clean data keeps ${(100 * shrink).toFixed(0)}% of the response`);
}
// 3. motion: no correction is worst
{
  const R = record(src('Motion artifacts'));
  const err = r => { let e = 0; longs(R.ds).forEach(c => { const a = r.avg[0][c.index].mHbo.mean, t = R.truth.avg[0][c.index].mHbo.mean; for (let k = 0; k < a.length; k++) e += (a[k] - t[k]) ** 2; }); return Math.sqrt(e); };
  const eN = err(R.res), eT = err(rerun(R, { motion: 'tddr' }).res), eS = err(rerun(R, { motion: 'spline' }).res);
  ok(eT < eN && eS < eN, `motion: TDDR (${eT.toFixed(2)}) and spline (${eS.toFixed(2)}) both beat no correction (${eN.toFixed(2)})`);
}
// 4. heads and depth
{
  const adult = record(src('Finger tapping, block design')), thick = record(src('Adult with a thick skull')), deep = record(src('Deep (sulcal) activation'));
  const pk = R => peak(R.truth.avg[0][R.ds.chans.find(c => c.label === 'S3-D1').index].mHbo.mean);
  ok(pk(thick) < 0.4 * pk(adult), 'a thick skull shrinks the measured response');
  ok(pk(deep) < 0.3 * pk(adult), 'a deep activation nearly vanishes');
  const inf = record(src('Infant: thin skull, short channels'));
  const best = Math.max(...longs(inf.ds).map(c => c.per[1].La[0] / c.per[1].L));
  const bestA = Math.max(...longs(adult.ds).map(c => c.per[1].La[0] / c.per[1].L));
  ok(best > bestA, 'infant 2 cm channels see more of their region than adult 3 cm channels');
}
// 5. wavelengths
{
  const g1 = NIRS.noiseGain([760, 850], 3, 6), g2 = NIRS.noiseGain([830, 850], 3, 6);
  ok(g2[0] > 5 * g1[0] && g2[1] > 5 * g1[1], '830/850 nm amplifies noise more than five times as much as 760/850');
  const R = record(src('Wavelengths 830 and 850 nm')), A = record(src('Finger tapping, block design'));
  const sd = r => NIRS.mean(longs(r.ds).map(c => NIRS.std(r.res.conc[c.index].hbr)));
  ok(sd(R) > 2 * sd(A), 'and the recorded HbR is much noisier');
  ok(NIRS.mbllInverse(NIRS.mbllMatrix([800], 3, 6)) === null, 'a single wavelength cannot be solved');
}
// 6. quality: dark hair fails the coupling index with an APD and partly recovers with a SiPM
{
  const apd = record(src('Dense, dark hair')), sipm = record(src('Dense, dark hair').replace('detector apd', 'detector sipm'));
  const good = R => longs(R.ds).filter(c => !R.res.bad.has(c.index)).length;
  ok(good(apd) <= 2, `dark hair, APD: ${good(apd)} long channels survive`);
  ok(good(sipm) > good(apd), `dark hair, SiPM: ${good(sipm)} survive`);
  const loose = record(src('A loose optode and room light'));
  ok(NIRS.channelsOfOptode(loose.ds, 'D2').every(i => loose.res.bad.has(i)), 'the loose optode\'s channels are rejected');
  const ok2 = longs(loose.ds).filter(c => !NIRS.channelsOfOptode(loose.ds, 'D2').includes(c.index));
  ok(ok2.every(c => !loose.res.bad.has(c.index)), 'and the rest are kept');
}
// 7. sampling: the heartbeat aliases at 1 Hz
{
  const R = record(src('Sampling too slowly: the heartbeat aliases'));
  ok(R.res.quality.every(q => !isFinite(q.sci)), 'at 1 Hz the scalp coupling index cannot be computed');
  const w = NIRS.dsp.welch(R.res.od[0][1], R.ds.fs, 200);
  let pk = 0; for (let k = 1; k < w.p.length; k++) if (w.f[k] > 0.15 && w.f[k] < 0.5 && w.p[k] > w.p[pk]) pk = k;
  near(w.f[pk], 0.2, 0.03, 'the 72 bpm heartbeat folds down to 0.2 Hz');
}
// 8. connectivity: systemic physiology correlates everything; short channels reveal the pair
{
  const R = record(src('Resting-state connectivity pair'));
  const ri = R.ds.regions.findIndex(r => r.kind === 'pair'), rj = R.ds.regions.length - 1;
  const L = longs(R.ds);
  const blind = L.filter(c => c.per[1].La[ri] + c.per[1].La[rj] < 0.005);
  const mean = rows => { let s = 0, k = 0; for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) { s += NIRS.corr(rows[a], rows[b]); k++; } return s / k; };
  const rOff = mean(blind.map(c => R.res.clean[c.index].hbo));
  const on = rerun(R, { short: 'nearest', shortMode: 'before' });
  const rOn = mean(blind.map(c => on.res.clean[c.index].hbo));
  ok(blind.length >= 2 && rOff > 0.5, `without short channels, channels that see neither region correlate (r = ${rOff.toFixed(2)})`);
  ok(rOn < rOff - 0.3, `short-channel regression removes most of that (r = ${rOn.toFixed(2)})`);
  const best = r => L.slice().sort((a, b) => b.per[1].La[r] - a.per[1].La[r])[0].index;
  const pairR = NIRS.corr(on.res.clean[best(ri)].hbo, on.res.clean[best(rj)].hbo);
  ok(pairR > rOn + 0.2, `and the coupled pair stands out (r = ${pairR.toFixed(2)})`);
}
// 9. tomography: a high-density array localizes, a sparse one cannot
{
  const run = arr => {
    const M = NIRS.dotModel('adult', 850, arr), t = { x: 0.7, y: -0.4, z: 1.6, r: 0.5, dmua: 0.02 };
    const x = NIRS.dotTarget(M, [t]), y = NIRS.dotForward(M, x, 0), ym = Math.max(...y.map(Math.abs));
    const pk = NIRS.dotPeak(M, NIRS.dotReconstruct(M, NIRS.dotForward(M, x, 0.02 * ym, 5), 0.01, 0.5));
    return { lat: Math.hypot(pk.x - t.x, pk.y - t.y), z: pk.z };
  };
  const hd = run('hd'), sp = run('sparse'), nn = run('hdshort');
  ok(hd.lat < 0.4 && hd.z > 1.0, `HD-DOT finds the target within ${(hd.lat * 10).toFixed(0)} mm sideways, ${(hd.z * 10).toFixed(0)} mm deep (true 16)`);
  ok(sp.lat > hd.lat, 'a sparse array localizes worse');
  ok(nn.z < 0.6, 'nearest-neighbour channels alone put it at the surface');
}
summary('lessons');
