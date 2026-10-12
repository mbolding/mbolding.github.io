'use strict';
const { load, ok, near, summary } = require('./harness');
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const MEG = load(['core', 'head', 'fields', 'dsl', 'mri', 'mri_template']);
const v3 = MEG.v3, M = MEG.mri;
const mm = x => (10 * x).toFixed(1) + ' mm';
const has = (p, s) => M.label(p).indexOf(s) >= 0;

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

/* Coregistration as the tab does it, on whichever MRI is in use: landmarks,
   then ICP on the head shape.  Returns the errors for the report. */
function coregistration(name) {
  const digi = M.digitize(1);
  ok(digi.pts.length > 80, `${name}: ${digi.pts.length} head-shape points digitized`);
  const truth = { NAS: M.apply(M.TRUE, M.FID.NAS), LPA: M.apply(M.TRUE, M.FID.LPA), RPA: M.apply(M.TRUE, M.FID.RPA) };
  const probe = MEG.placeAt('C3', 2.5);
  const exact = M.coregister({ pts: digi.pts, fids: { NAS: M.FID.NAS, LPA: M.FID.LPA, RPA: M.FID.RPA } }, truth, {});
  ok(M.errorAt(exact.T, probe) < 1e-6, `${name}: perfect landmarks give a perfect transform`);
  const plain = M.coregister(digi, truth, {});
  ok(M.errorAt(plain.T, probe) < 0.25, `${name}: landmarks with 1 mm digitizer noise: ${mm(M.errorAt(plain.T, probe))} at C3`);
  const up = v3.sub(M.apply(M.TRUE, [0, 0, 1]), M.apply(M.TRUE, [0, 0, 0]));
  const bad = Object.assign({}, truth, { NAS: v3.add(truth.NAS, v3.scale(up, 0.5)) });
  const e1 = M.errorAt(M.coregister(digi, bad, {}).T, probe);
  const e2 = M.errorAt(M.coregister(digi, bad, { icp: true }).T, probe);
  ok(e1 > 0.25, `${name}: a nasion marked 5 mm too high moves a central source by ${mm(e1)}`);
  ok(e2 < 0.6 * e1, `${name}: fitting the head shape with ICP brings it back to ${mm(e2)}`);
  const fit1 = M.surfaceFit(M.coregister(digi, bad, {}).T, digi), fit2 = M.surfaceFit(M.coregister(digi, bad, { icp: true }).T, digi);
  ok(fit2 < fit1, `${name}: ICP improves the head-shape fit (${mm(fit1)} → ${mm(fit2)})`);
  const noNose = M.digitize(1, { nose: false });
  const e3 = M.errorAt(M.coregister(noNose, bad, { icp: true, fidWeight: 0.5 }).T, probe);
  const e4 = M.errorAt(M.coregister(digi, bad, { icp: true, fidWeight: 0.5 }).T, probe);
  ok(e4 < e3, `${name}: points along the nose pin the rotation down (${mm(e3)} without, ${mm(e4)} with)`);
  let worst = 0;
  M.digitize(2, { noise: 0 }).pts.forEach(p => { worst = Math.max(worst, v3.norm(v3.sub(M.nearestScalp(p), p))); });
  ok(worst < 1e-6, `${name}: noise-free head-shape points lie on the skin surface`);
  // the numbers the Guide quotes: the tab's ICP keeps each landmark as one more point
  const rimWorst = T => Math.max(...M.rim.map(p => M.errorAt(T, p)));
  const tab = { icp: true, fidWeight: 1 };
  console.log(`  ${name}: nasion 5 mm high: ${mm(e1)} at C3, ${mm(rimWorst(M.coregister(digi, bad, {}).T))} worst in the cortex; ` +
    `with ICP ${mm(rimWorst(M.coregister(digi, bad, tab).T))} worst, without the nose ${mm(rimWorst(M.coregister(noNose, bad, tab).T))}`);
}
// Slices: intensities in range, and pixels map back to points.
function slices(name, leftAud) {
  const c = M.apply(M.TRUE, [0, 0, 0]);
  const img = M.slice('coronal', c[1], 64, 11);
  let lo = 1, hi = 0;
  img.forEach(x => { lo = Math.min(lo, x); hi = Math.max(hi, x); });
  ok(lo >= 0 && hi <= 1 && hi - lo > 0.6, `${name}: a coronal slice spans dark to bright (${lo.toFixed(2)}–${hi.toFixed(2)})`);
  const m = M.apply(M.TRUE, leftAud);
  ok(M.slicePixel('coronal', m, 64, 11).x < 32, `${name}: the left auditory cortex appears on the left of a coronal slice (neurological convention)`);
  ok(M.slicePixel('sagittal', M.apply(M.TRUE, M.FID.NAS), 64, 11).x < 16, `${name}: the nasion is on the left of a sagittal slice`);
  ['axial', 'coronal', 'sagittal'].forEach(pl => {
    const p = M.slicePixel(pl, m, 200, 11);
    ok(p.x > 0 && p.x < 200 && p.y > 0 && p.y < 200, `${name}: ${pl} pixel inside the image`);
  });
}

/* ---------- the synthetic head: the stand-in before the template loads ---------- */
ok(M.kind === 'synthetic', 'the synthetic head is in use until the template loads');
coregistration('synthetic');
{
  // its anatomy is built around version 1's generator sites on the sphere
  const E = MEG.ELEC_SPHERE, at = (u, r) => v3.scale(v3.unit(u), r);
  const aud = [at([-5.7, -0.9, -1.6], 6.0), at([5.7, -0.4, -1.6], 6.0)];
  ok(has(aud[0], 'left Heschl') && has(aud[1], 'right Heschl'), 'synthetic: Heschl’s gyri where version 1 put the auditory sources');
  const s1 = at(E.C3, 6.4), m1 = at(v3.lerp(E.C3, E.FC3, 0.2), 6.4);
  ok(has(s1, 'left postcentral') && has(m1, 'left precentral'), 'synthetic: the hand area straddles the central sulcus under C3');
  ok(has(at([-1.8, -6.0, 1.8], 6.5), 'cuneus') || has(at([-1.8, -6.0, 1.8], 6.5), 'calcarine'), 'synthetic: alpha’s cuneus');
  ok(has(at(E.T9, 6.4), 'temporal'), 'synthetic: the temporal lobe under T9');
  [aud[0], s1, m1].forEach(p => ok(M.tissue(p) === 'grey matter', 'synthetic: a generator site is in grey matter'));
  ok(M.label([-1.4, -0.6, 0.2]).indexOf('thalamus') >= 0, 'synthetic: the thalamus is where it should be');
  ok(M.label([0, 0, 9.0]) === 'scalp' && M.label([0, 0, 8.4]) === 'skull', 'synthetic: scalp and skull');
  ok(M.label([0, 10.2, -5.3]) === 'the nose', 'synthetic: the nose');
}
slices('synthetic', [-5.7, -0.9, -1.6]);

/* ---------- the template ---------- */
let heard = 0;
M.onChange(() => { heard++; });
const t0 = Date.now();
M.useBuffer(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'mni152.bin.gz')))));
ok(M.kind === 'template' && heard === 1, `the template replaces it, and listeners hear (decoded in ${Date.now() - t0} ms)`);
{
  // the built-in generators sit on the atlas regions they are named for, in grey matter
  const D = MEG.GEN_DEPTH;
  const aud = MEG.evokedDipoles({ type: 'auditory', side: 'both', depth: D.auditory });
  ok(has(aud[0].pos, 'left Heschl'), 'the left auditory source is on Heschl’s gyrus (' + M.label(aud[0].pos) + ')');
  ok(has(aud[1].pos, 'right Heschl'), 'and the right one');
  ok(aud[1].pos[1] > aud[0].pos[1] + 0.2, 'the right auditory cortex sits a little further forward');
  const som = MEG.evokedDipoles({ type: 'somatosensory', side: 'left', depth: D.somatosensory, beta: true });
  ok(has(som[0].pos, 'left postcentral'), 'the N20m source is on the postcentral gyrus (' + M.label(som[0].pos) + ')');
  ok(has(som[1].pos, 'left precentral'), 'the beta source is on the precentral gyrus (' + M.label(som[1].pos) + ')');
  const somR = MEG.evokedDipoles({ type: 'somatosensory', side: 'right', depth: D.somatosensory });
  ok(has(somR[0].pos, 'right postcentral'), 'and on the right');
  const al = MEG.alphaDipoles(D.alpha);
  ok(has(al[0].pos, 'left cuneus') && has(al[1].pos, 'right cuneus'), 'alpha comes from the cuneus on each side');
  ok(has(MEG.placeAt('T9', 2.8), 'temporal'), 'the spike example sits in the temporal lobe (' + M.label(MEG.placeAt('T9', 2.8)) + ')');
  [aud[0], aud[1], som[0], som[1], al[0], al[1]].forEach(g => ok(M.tissue(g.pos) === 'grey matter', g.name + ' generator is in grey matter'));
  // a deeper source moves along the line through its site
  const deeper = MEG.evokedDipoles({ type: 'auditory', side: 'left', depth: D.auditory + 1 })[0];
  near(MEG.depthOf(deeper.pos) - MEG.depthOf(aud[0].pos), 1, 1e-9, 'asking for 1 cm more depth moves the auditory source 1 cm deeper');
  near(v3.dot(v3.unit(deeper.pos), v3.unit(aud[0].pos)), 1, 1e-12, 'along the same direction');
}
{
  // landmarks on the skin, the head symmetric, tissue in the right places
  ['NAS', 'LPA', 'RPA'].forEach(k => ok(Math.abs(M.skinSDF(M.FID[k])) < 0.05, `the ${k} landmark is on the skin (${mm(M.skinSDF(M.FID[k]))})`));
  near(M.FID.LPA[0] + M.FID.RPA[0], 0, 1e-9, 'the preauricular points are symmetric');
  ok(M.FID.NAS[1] > 9 && Math.abs(M.FID.NAS[0]) < 1e-9, 'the nasion is in front, on the midline');
  ok(M.label(M.FID.NAS) === 'the nose', 'the nasion is at the root of the nose');
  ok(M.label(M.FID.LPA) === 'scalp' && M.label(M.FID.RPA) === 'scalp', 'the preauricular points are on the scalp');
  ok(M.label([0, 0, 0]) === 'third ventricle', 'the centre of the sphere is in the third ventricle');
  ok(M.label([0, 0, 9.0]) === 'scalp' && M.tissue([0, 0, 8.4]) === 'skull', 'scalp and skull over the vertex');
  ok(M.label([0, 0, 12]) === 'outside the head', 'and air above them');
  ok(M.label(MEG.EYES[0]) === 'left eye' && M.label(MEG.EYES[1]) === 'right eye', 'the eyes are the eyes');
  ok(has([-1.4, -1.2, 0.6], 'thalamus'), 'the left thalamus (' + M.label([-1.4, -1.2, 0.6]) + ')');
  ok(M.label(MEG.placeAt('Cz', 2.5)) === 'dura and venous sinus', 'between the hemispheres at the top: the falx and the sagittal sinus');
}
coregistration('template');
slices('template', MEG.GEN_SITES.audL);
{
  // the source grid is the brain: grey or white matter, never skull, CSF or scalp
  const n = MEG.TEMPLATE.grid.n, bits = MEG.b64(MEG.TEMPLATE.grid.mask), L = MEG.TEMPLATE.grid.lim, w = 2 * L + 1;
  let count = 0, brain = 0;
  const bad = {};
  for (let k = -L; k <= L; k++) for (let j = -L; j <= L; j++) for (let i = -L; i <= L; i++) {
    const b = ((k + L) * w + (j + L)) * w + (i + L);
    if (!((bits[b >> 3] >> (b & 7)) & 1)) continue;
    count++;
    const t = M.tissue([i * 0.6, j * 0.6, k * 0.6]);
    if (t === 'grey matter' || t === 'white matter') brain++; else bad[t] = (bad[t] || 0) + 1;
  }
  ok(count === n, `the grid mask has its ${n} points`);
  ok(brain === count, `every source grid point is grey or white matter (else: ${JSON.stringify(bad)})`);
}
{
  // the scalp table agrees with the scalp, away from the ears and the face
  let worst = 0;
  MEG.fibonacciSphere(300).filter(u => u[2] > -0.2 && !(u[1] > 0.5 && u[2] < 0.1)).forEach(u => { worst = Math.max(worst, Math.abs(M.skinSDF(v3.scale(u, MEG.scalpR(u))))); });
  ok(worst < 0.25, 'the scalp table is within ' + mm(worst) + ' of the scalp');
  // OPMs sit just off the scalp; the SQUID helmet clears it everywhere
  let lo = 9, hi = 0, squid = 9;
  MEG.SITES.forEach(s => { const g = M.skinSDF(MEG.opmPoint(s.u)); lo = Math.min(lo, g); hi = Math.max(hi, g); squid = Math.min(squid, M.skinSDF(MEG.helmetPoint(s.u).r)); });
  ok(lo > 0.3 && hi < 0.9, `OPMs ${mm(lo)} to ${mm(hi)} from the scalp (nearer by the ears, which they skirt)`);
  ok(squid > 1.5, `the nearest SQUID coil is ${mm(squid)} from the scalp`);
}
M.use(M.synthetic);
ok(M.kind === 'synthetic' && heard === 2, 'and the synthetic head can be put back');
summary('mri');
