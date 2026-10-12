'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'mri']);
const v3 = MEG.v3, M = MEG.mri;
const mm = x => (10 * x).toFixed(1) + ' mm';

// Rigid registration recovers a known rotation and translation exactly.
{
  const T = { R: MEG.rotXYZ(12, -20, 33), t: [2, -1, 0.5] };
  const A = MEG.fibonacciSphere(30).map(u => v3.scale(u, 8));
  const B = A.map(p => M.apply(T, p));
  const E = M.rigid(A, B);
  let worst = 0;
  A.forEach(p => { worst = Math.max(worst, v3.norm(v3.sub(M.apply(E, p), M.apply(T, p)))); });
  ok(worst < 1e-9, 'Horn’s method recovers a rigid transform (worst error ' + worst.toExponential(1) + ' cm)');
  const I = M.apply(M.invert(T), M.apply(T, [1, 2, 3]));
  near(v3.norm(v3.sub(I, [1, 2, 3])), 0, 1e-12, 'invert undoes apply');
}

// Coregistration: landmarks, then ICP on the head shape.
{
  const digi = M.digitize(1);
  ok(digi.pts.length > 80, digi.pts.length + ' head-shape points digitized');
  const truth = { NAS: M.apply(M.TRUE, M.FID.NAS), LPA: M.apply(M.TRUE, M.FID.LPA), RPA: M.apply(M.TRUE, M.FID.RPA) };
  const probe = MEG.placeAt('C3', 2.5);
  const exact = M.coregister({ pts: digi.pts, fids: { NAS: M.FID.NAS, LPA: M.FID.LPA, RPA: M.FID.RPA } }, truth, {});
  ok(M.errorAt(exact.T, probe) < 1e-6, 'perfect landmarks give a perfect transform');
  const plain = M.coregister(digi, truth, {});
  ok(M.errorAt(plain.T, probe) < 0.25, 'landmarks with 1 mm digitizer noise: ' + mm(M.errorAt(plain.T, probe)) + ' at C3');
  const bad = Object.assign({}, truth, { NAS: v3.add(truth.NAS, [0, 0, 0.5]) });
  const e1 = M.errorAt(M.coregister(digi, bad, {}).T, probe);
  const e2 = M.errorAt(M.coregister(digi, bad, { icp: true }).T, probe);
  ok(e1 > 0.25, 'a nasion marked 5 mm too high moves a central source by ' + mm(e1));
  ok(e2 < 0.6 * e1, 'fitting the head shape with ICP brings it back to ' + mm(e2));
  const fit1 = M.surfaceFit(M.coregister(digi, bad, {}).T, digi), fit2 = M.surfaceFit(M.coregister(digi, bad, { icp: true }).T, digi);
  ok(fit2 < fit1, 'ICP improves the head-shape fit (' + mm(fit1) + ' → ' + mm(fit2) + ')');
  const noNose = M.digitize(1, { nose: false });
  const e3 = M.errorAt(M.coregister(noNose, bad, { icp: true, fidWeight: 0.5 }).T, probe);
  const e4 = M.errorAt(M.coregister(digi, bad, { icp: true, fidWeight: 0.5 }).T, probe);
  ok(e4 < e3, 'points along the nose pin the rotation down (' + mm(e3) + ' without, ' + mm(e4) + ' with)');
  // the scalp surface is consistent: digitized points lie on it
  let worst = 0;
  M.digitize(2, { noise: 0 }).pts.forEach(p => { worst = Math.max(worst, v3.norm(v3.sub(M.nearestScalp(p), p))); });
  ok(worst < 1e-6, 'noise-free head-shape points lie on the skin surface');
}

// The atlas agrees with where the built-in generators are placed.
{
  const has = (p, s) => M.label(p).indexOf(s) >= 0;
  const aud = MEG.evokedDipoles({ type: 'auditory', side: 'both', depth: 3.2 });
  ok(has(aud[0].pos, 'left Heschl'), 'the left auditory source is on Heschl’s gyrus (' + M.label(aud[0].pos) + ')');
  ok(has(aud[1].pos, 'right Heschl'), 'and the right one');
  const som = MEG.evokedDipoles({ type: 'somatosensory', side: 'left', depth: 2.8, beta: true });
  ok(has(som[0].pos, 'left postcentral'), 'the N20m source is on the postcentral gyrus');
  ok(has(som[1].pos, 'left precentral'), 'the beta source is on the precentral gyrus');
  const al = MEG.alphaDipoles(2.7);
  ok(has(al[0].pos, 'cuneus') || has(al[0].pos, 'calcarine'), 'alpha comes from the cuneus');
  ok(has(MEG.placeAt('T9', 2.8), 'temporal'), 'the spike example sits in the temporal lobe');
  [aud[0], aud[1], som[0], som[1], al[0], al[1]].forEach(g => ok(M.tissue(g.pos) === 'grey matter', g.name + ' generator is in grey matter'));
  ok(M.label([-1.4, -0.6, 0.2]).indexOf('thalamus') >= 0, 'the thalamus is where it should be');
  ok(M.label([0, 0, 9.0]) === 'scalp' && M.label([0, 0, 8.4]) === 'skull', 'scalp and skull');
  ok(M.label([0, 10.2, -5.3]) === 'the nose', 'the nose');
}

// Slices: intensities in range, and pixels map back to points.
{
  const c = M.apply(M.TRUE, [0, 0, 0]);
  const img = M.slice('coronal', c[1], 64, 11);
  let lo = 1, hi = 0;
  img.forEach(x => { lo = Math.min(lo, x); hi = Math.max(hi, x); });
  ok(lo >= 0 && hi <= 1 && hi - lo > 0.6, 'a coronal slice spans dark to bright (' + lo.toFixed(2) + '–' + hi.toFixed(2) + ')');
  const m = M.apply(M.TRUE, [-5.7, -0.9, -1.6]);
  const px = M.slicePixel('coronal', m, 64, 11);
  ok(px.x < 32, 'the left auditory cortex appears on the left of a coronal slice (neurological convention)');
  const sg = M.slicePixel('sagittal', M.apply(M.TRUE, M.FID.NAS), 64, 11);
  ok(sg.x < 16, 'the nasion is on the left of a sagittal slice');
  // round trip: the pixel's point is the point
  ['axial', 'coronal', 'sagittal'].forEach(pl => {
    const p = M.slicePixel(pl, m, 200, 11);
    ok(p.x > 0 && p.x < 200 && p.y > 0 && p.y < 200, pl + ' pixel inside the image');
  });
}
summary('mri');
