'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'dsp', 'sim', 'suppress', 'inverse']);
const v3 = MEG.v3, I = MEG.inverse;
const ds = MEG.simulate(MEG.dsl.build('recording { sensors magnetometers rate 250 Hz background off } timeline { block open 2 s }'));
const model = I.buildModel(ds, { spacing: 0.8 });
ok(model.r > 50 && model.r <= model.chans.length, 'the brain signal space has ' + model.r + ' dimensions');
const tang = (p, d) => v3.unit(v3.sub(d, v3.scale(v3.unit(p), v3.dot(d, v3.unit(p)))));
function analyse(srcs, corr, trials) {
  const data = I.scenario(ds, { sources: srcs, corr, trials: trials || 80 });
  const st = I.statistics(data);
  const ti = data.times.findIndex(x => x >= 0.1);
  const v = Float64Array.from(st.avg, r => r[ti]);
  const WhA = I.whitener(model, st.noiseCov.map(r => r.map(x => x / data.trials.length)), 0.1);
  const mA = I.withWhitener(model, WhA), vw = I.whitenVec(model, WhA, v);
  const Wh = I.whitener(model, st.noiseCov, 0.1), m = I.withWhitener(model, Wh);
  const bf = I.lcmv(m, I.whitenCov(model, Wh, st.dataCov), I.whitenCov(model, Wh, st.noiseCov), {});
  return { fit: I.dipoleFit(mA, vw), mne: I.minimumNorm(mA, { method: 'mne', depth: false }).apply(vw), dspm: I.minimumNorm(mA, { method: 'dspm' }).apply(vw), bf: bf.power };
}
const peak = img => I.peaks(model, img, 0.3, 2)[0];
const maxOf = img => { let m = 0; img.forEach(x => { m = Math.max(m, x); }); return m; };
{
  const A = { pos: MEG.placeAt('C3', 2.5), amp: 20 }; A.ori = MEG.orientation(A.pos, 90, 0);
  const r = analyse([A]);
  const e = p => v3.norm(v3.sub(p, A.pos)) * 10;
  ok(e(r.fit.pos) < 5, 'dipole fit finds a superficial source within 5 mm (' + e(r.fit.pos).toFixed(1) + ')');
  ok(e(peak(r.mne).pos) < 20, 'minimum norm peaks within 2 cm of it (' + e(peak(r.mne).pos).toFixed(0) + ' mm)');
  ok(e(peak(r.bf).pos) < 10, 'the beamformer peaks within 1 cm (' + e(peak(r.bf).pos).toFixed(0) + ' mm)');
}
{
  const D = { pos: MEG.placeAt('C3', 5), amp: 30 }; D.ori = MEG.orientation(D.pos, 90, 0);
  const r = analyse([D]);
  const dm = MEG.depthOf(peak(r.mne).pos), dd = MEG.depthOf(peak(r.dspm).pos);
  ok(dm < 4, `plain minimum norm drags a 5 cm deep source to the surface (peak at ${dm.toFixed(1)} cm)`);
  ok(dd > dm, `dSPM puts it deeper (${dd.toFixed(1)} cm)`);
}
{
  const L = { pos: [-5.7, -0.9, -1.6], amp: 25 }; L.ori = tang(L.pos, [0, 0.3, -1]);
  const R = { pos: [5.7, -0.4, -1.6], amp: 25 }; R.ori = tang(R.pos, [0, 0.3, -1]);
  const u = analyse([L, R], 0, 100), c = analyse([L, R], 1, 100);
  const ratio = maxOf(c.bf) / maxOf(u.bf);
  ok(ratio < 0.75, 'correlated sources cut the beamformer’s peak activity index (to ' + (100 * ratio).toFixed(0) + '%)');
  ok(c.fit.gof < 0.8, 'one dipole cannot explain two hemispheres (goodness of fit ' + (100 * c.fit.gof).toFixed(0) + '%)');
}
// The fast scenario: the same statistics in the signal space, sLORETA and two-dipole fits.
{
  const L = { pos: [-5.7, -0.9, -1.6], amp: 25 }; L.ori = tang(L.pos, [0, 0.3, -1]);
  const R = { pos: [5.7, -0.4, -1.6], amp: 25 }; R.ori = tang(R.pos, [0, 0.3, -1]);
  const run = (srcs, corr) => {
    const data = I.scenarioData(ds, { sources: srcs, corr, trials: 100 });
    const st = I.scenarioStats(model, data);
    const Wh = I.whitenerR(st.noiseCovR.map(r => r.map(x => x / 100)), 0.1), m = I.withWhitener(model, Wh);
    const ti = data.times.findIndex(x => x >= 0.1 - 1e-9);
    return { data, st, Wh, m, vw: I.whitenVecR(Wh, Float64Array.from(st.avgR, r => r[ti])) };
  };
  const one = run([L], 0);
  const red = I.reduceRows(model, one.data.avg, one.data.nT);
  let diff = 0; red.forEach((r, k) => r.forEach((x, i) => { diff = Math.max(diff, Math.abs(x - one.st.avgR[k][i])); }));
  ok(diff < 1e-9, 'the signal-space average is the average projected');
  const e = p => v3.norm(v3.sub(p, L.pos)) * 10;
  const slo = I.minimumNorm(one.m, { method: 'sloreta' }).apply(one.vw);
  ok(e(peak(slo).pos) < 10, 'sLORETA puts a single source within 1 cm (' + e(peak(slo).pos).toFixed(0) + ' mm)');
  const fit = I.dipoleFit(one.m, one.vw);
  const conf = I.confidence(fit.resid, fit.residBest);
  let n = 0; conf.forEach(x => { n += x; });
  ok(n >= 1 && n * Math.pow(model.grid.spacing, 3) < 3, 'a strong source has a small 95% confidence volume (' + (n * Math.pow(model.grid.spacing, 3)).toFixed(1) + ' cm³)');
  const two = run([L, R], 1);
  const f2 = I.dipoleFit2(two.m, two.vw);
  const err2 = f2.pos.map(p => Math.min(v3.norm(v3.sub(p, L.pos)), v3.norm(v3.sub(p, R.pos))) * 10);
  ok(err2.every(x => x < 10) && Math.abs(f2.pos[0][0] - f2.pos[1][0]) > 8, 'two dipoles find two fully correlated sources (' + err2.map(x => x.toFixed(0)).join(', ') + ' mm)');
  ok(f2.gof > I.dipoleFit(two.m, two.vw).gof + 0.2, 'and explain far more of the field than one');
}
summary('inverse');
