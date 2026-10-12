'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'probe', 'mc']);

// Prahl's table, and the features of the spectra
const e800 = NIRS.ext(800);
near(e800[0], 816, 1e-6, 'HbO extinction at 800 nm');
near(e800[1], 761.72, 1e-6, 'HbR extinction at 800 nm');
ok(NIRS.ext(760)[1] > 2 * NIRS.ext(760)[0], 'HbR dominates at 760 nm');
ok(NIRS.ext(850)[0] > 1.4 * NIRS.ext(850)[1], 'HbO dominates at 850 nm');
ok(NIRS.ISOSBESTIC > 795 && NIRS.ISOSBESTIC < 800, `isosbestic point near 797 nm (${NIRS.ISOSBESTIC})`);
ok(NIRS.ext(600)[1] > 10 * NIRS.ext(800)[1], 'haemoglobin absorbs far more at 600 nm');
ok(NIRS.waterMua(970) > 10 * NIRS.waterMua(800), 'water peak near 970 nm');
ok(NIRS.waterMua(740) > NIRS.waterMua(700) && NIRS.waterMua(760) > NIRS.waterMua(800), 'water shoulder near 740-760 nm');

// tissue optics are in the usual range at 800 nm
const layers = NIRS.headLayers('adult');
NIRS.opticalLayers(layers, 800).forEach(L => {
  if (L.key === 'csf') { ok(L.mua < 0.06 && L.musp < 4, 'CSF is clear'); return; }
  ok(L.mua > 0.1 && L.mua < 0.3, `${L.key} absorption ${L.mua.toFixed(3)} /cm`);
  ok(L.musp > 8 && L.musp < 60, `${L.key} scattering ${L.musp.toFixed(1)} /cm`);
});
near(NIRS.brainTop(layers), 1.4, 1e-9, 'adult brain starts 14 mm down');
near(NIRS.brainTop(NIRS.headLayers('infant')), 0.55, 1e-9, 'infant brain starts 5.5 mm down');

// the diffusion solver: the integrated sensitivity is the derivative of ln(G)
const ol = NIRS.opticalLayers(layers, 850);
const sol = NIRS.fluence(ol);
const d = 1e-3, sol2 = NIRS.fluence(ol.map(L => Object.assign({}, L, { mua: L.mua + d })), { noCache: true });
for (const rho of [1, 3]) {
  const deriv = -(Math.log(NIRS.Gat(sol2, rho, sol2.j0)) - Math.log(NIRS.Gat(sol, rho, sol.j0))) / d;
  const L = NIRS.pathlengths(sol, rho).total;
  near(L / deriv, 1, 0.03, `pathlength integral equals -dlnG/dmua at ${rho} cm`);
}
// against the analytic homogeneous half-space
const hom = [{ key: 'gray', z0: 0, z1: Infinity, mua: 0.1, musp: 10 }];
const sh = NIRS.fluence(hom, { noCache: true });
for (const rho of [2, 3, 4]) {
  const p = NIRS.pathlengths(sh, rho);
  near(p.total / (rho * NIRS.homogDPF(0.1, 10, rho)), 1, 0.06, `homogeneous mean pathlength at ${rho} cm`);
  near(p.R / NIRS.homogCW(0.1, 10, rho), 1, 0.15, `homogeneous reflectance at ${rho} cm`);
}
// what an adult head does to a 3 cm channel
const p3 = NIRS.pathlengths(sol, 3), p08 = NIRS.pathlengths(sol, 0.8), p5 = NIRS.pathlengths(sol, 5);
ok(p3.dpf > 5.5 && p3.dpf < 8, `adult DPF at 3 cm, 850 nm: ${p3.dpf.toFixed(2)}`);
const brain = p => (p.layers[3] + p.layers[4]) / p.total;
ok(brain(p08) < 0.01, `an 8 mm channel barely reaches the brain (${(100 * brain(p08)).toFixed(2)}%)`);
ok(brain(p3) > 0.03 && brain(p3) < 0.12, `a 3 cm channel: ${(100 * brain(p3)).toFixed(1)}% of its path in the brain`);
ok(brain(p5) > brain(p3), 'longer separation reaches deeper');
ok(p5.R < p3.R / 50 && p3.R < p08.R / 300, 'longer separation detects far less light');
const infant = NIRS.fluence(NIRS.opticalLayers(NIRS.headLayers('infant'), 850)), thick = NIRS.fluence(NIRS.opticalLayers(NIRS.headLayers('thick'), 850));
ok(brain(NIRS.pathlengths(infant, 2)) > brain(p3), 'an infant 2 cm channel sees more brain than an adult 3 cm channel');
ok(brain(NIRS.pathlengths(thick, 3)) < 0.6 * brain(p3), 'a thick skull hides the brain');
// a region's pathlength is inside the channel's brain path
const La = NIRS.regionPath(sol, [-1.5, 0], [1.5, 0], { x: 0, y: 0, z: 1.7, r: 0.8 }, 1.4);
ok(La > 0.1 && La < p3.layers[3] + p3.layers[4], `region path ${La.toFixed(3)} cm is part of the brain path`);
ok(NIRS.regionPath(sol, [-1.5, 0], [1.5, 0], { x: 0, y: 5, z: 1.7, r: 0.8 }, 1.4) < 0.01 * La, 'a region 5 cm off the channel is not seen');

// the Beer-Lambert matrix
const E = NIRS.mbllMatrix([760, 850], 3, 6), Ei = NIRS.mbllInverse(E);
const od = [E[0][0] * 0.5 + E[0][1] * -0.2, E[1][0] * 0.5 + E[1][1] * -0.2];
near(Ei[0][0] * od[0] + Ei[0][1] * od[1], 0.5, 1e-9, 'Beer-Lambert round trip, HbO');
near(Ei[1][0] * od[0] + Ei[1][1] * od[1], -0.2, 1e-9, 'Beer-Lambert round trip, HbR');
ok(NIRS.mbllInverse(NIRS.mbllMatrix([800], 3, 6)) === null, 'one wavelength cannot be inverted');
ok(NIRS.extCond([760, 850]) < 4, 'a good pair is well conditioned');
ok(NIRS.extCond([830, 850]) > 20, 'two wavelengths above the isosbestic point are ill conditioned');
near(NIRS.dpfAge(807, 30), 6.0, 0.25, 'Scholkmann-Wolf DPF for a 30-year-old');
ok(NIRS.dpfAge(760, 30) > NIRS.dpfAge(850, 30), 'DPF falls with wavelength');
const led = NIRS.effectiveExt(735, 35), las = NIRS.ext(735);
ok(Math.abs(led[1] / las[1] - 1) > 0.01, 'an LED sees a different extinction from its nominal value');

// frequency and time domain: phase grows with separation, the TD curve decays faster with more absorption
ok(NIRS.homogFD(0.1, 10, 4, 100).phase > NIRS.homogFD(0.1, 10, 2, 100).phase, 'phase grows with separation');
ok(NIRS.homogTD(0.2, 10, 3, 3) < NIRS.homogTD(0.1, 10, 3, 3), 'more absorption, fewer late photons');

// the Monte Carlo agrees with diffusion theory
const mc = new NIRS.MC(ol, { rho: 1.5, aperture: 0.2, seed: 3 });
let t0 = Date.now(); while (mc.nDet < 400 && Date.now() - t0 < 20000) mc.run(200);
const ms = mc.stats(), pd = NIRS.pathlengths(sol, 1.5);
ok(ms.detected >= 400, `Monte Carlo detected ${ms.detected} photons`);
near(ms.dpf / pd.dpf, 1, 0.15, 'Monte Carlo DPF matches diffusion within 15%');
near(ms.layerL[0] / pd.layers[0], 1, 0.2, 'Monte Carlo scalp pathlength matches diffusion within 20%');
summary('optics');
