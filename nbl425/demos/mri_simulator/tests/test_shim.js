/* Tests for interactive shimming in fields.js (ARCHITECTURE.md section 7.1):
   the shim terms, the un-shimmed residual, shim currents in b0Map, the
   auto-shim and the field statistics, and that the imaging engine and
   the spectroscopy simulator see the shim currents. */
'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core', 'tissues', 'phantoms', 'fields', 'dsl', 'presets', 'engine', 'spectro']);
const F = MRI.fields, PH = MRI.phantoms, S = MRI.spectro;
const { abs, sqrt, max } = Math;

const braino = PH.build('braino', { n: 256 });
const brain = PH.build('brain', { n: 256 });
const RC = F.residualCoeffs;
const IDS = ['z0', 'x', 'y', 'xy', 'x2y2', 'z2'];
const neg = c => Object.fromEntries(IDS.map(id => [id, -c[id]]));
const h = 128;
const at = (ph, m, x, y) => m[(Math.round(y / ph.dx) + h) * ph.n + Math.round(x / ph.dx) + h];
function pdRms(ph, m, region) {
    let W = 0, S2 = 0;
    for (let iy = 0; iy < ph.n; iy++) for (let ix = 0; ix < ph.n; ix++) {
        const i = iy * ph.n + ix, L = ph.label[i];
        if (!L) continue;
        const x = (ix - h) * ph.dx, y = (iy - h) * ph.dx;
        if (region === 'center' && x * x + y * y > 0.06 * 0.06) continue;
        const w = ph.tissues[L].pd;
        W += w; S2 += w * m[i] * m[i];
    }
    return sqrt(S2 / W);
}

/* ---------- 1. The terms ---------- */
{
    const T = F.shimTerms;
    ok(Array.isArray(T) && T.map(t => t.id).join() === IDS.join(), 'six shim terms z0 x y xy x2y2 z2');
    ok(T.map(t => t.order).join() === '0,1,1,2,2,2', 'orders 0, 1, 1, 2, 2, 2');
    ok(T.every(t => typeof t.name === 'string' && typeof t.fn === 'function'), 'each term has a name and fn(x, y)');
    const fn = id => T.find(t => t.id === id).fn;
    near(fn('z0')(0.05, -0.03), 1, 1e-12, 'z0 = 1 everywhere');
    near(fn('x')(0.1, 0.07), 1, 1e-12, 'x = 1 at x = 100 mm');
    near(fn('y')(0.02, -0.1), -1, 1e-12, 'y = -1 at y = -100 mm');
    near(fn('xy')(0.1, 0.1), 2, 1e-12, 'xy = 2xy/R^2');
    near(fn('x2y2')(0.1, 0), 1, 1e-12, 'x2-y2 = 1 at x = 100 mm');
    near(fn('x2y2')(0, 0.1), -1, 1e-12, 'x2-y2 = -1 at y = 100 mm');
    near(fn('z2')(0.06, 0.08), -1, 1e-12, 'z2 = -(x^2 + y^2)/R^2 in the plane z = 0');
    near(F.shimRadius, 0.1, 0, 'reference radius 100 mm');
    ok(F.defaults.b0.shimCoeffs && IDS.every(id => F.defaults.b0.shimCoeffs[id] === 0), 'default shim coefficients are zero');
    ok(F.shimLimits.z0 === 100 && F.shimLimits.x === 150 && F.shimLimits.z2 === 150, 'shim limits: z0 100 Hz, others 150 Hz');
}

/* ---------- 2. The residual and shim currents in b0Map ---------- */
{
    near(RC.z0, 25, 5, 'residual centre-frequency offset about +25 Hz');
    ok(['x', 'y', 'xy', 'x2y2', 'z2'].every(id => abs(RC[id]) >= 5 && abs(RC[id]) <= 60), 'residual X, Y, XY, X2-Y2 and Z2 terms of tens of Hz');
    const zero = F.b0Map(braino, { susceptibility: 1, shim: 0, shimCoeffs: {} });
    ok(zero.every(v => v === 0), 'braino: no residual, no shims, no field');
    const un = F.b0Map(braino, { susceptibility: 1, shim: 1, shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } });
    const st = F.fieldStats(braino, un);
    ok(st.mean > 20 && st.sd > 5 && st.max - st.min > 30, 'shim 1 with zero coefficients: residual present (mean ' + st.mean.toFixed(1) + ' Hz, SD ' + st.sd.toFixed(1) + ' Hz, range ' + (st.max - st.min).toFixed(1) + ' Hz)');
    near(at(braino, un, 0, 0), RC.z0, 1e-4, 'residual at the centre is Z0');
    // Brain: tens of Hz across the head.
    const ub = F.b0Map(brain, { susceptibility: 0, shim: 1 });
    const sb = F.fieldStats(brain, ub);
    ok(sb.max - sb.min > 20 && sb.max - sb.min < 120, 'residual spans tens of Hz across the head: ' + (sb.max - sb.min).toFixed(1) + ' Hz');

    // Each coefficient is Hz at 100 mm.
    const one = (id, v) => F.b0Map(braino, { susceptibility: 0, shim: 0, shimCoeffs: { [id]: v } });
    const dx = braino.dx, x76 = Math.round(0.076 / dx) * dx, x38 = Math.round(0.038 / dx) * dx;
    near(at(braino, one('x', 10), x76, 0), 10 * x76 / 0.1, 1e-4, 'X 10 Hz: 10 Hz x (x / 100 mm)');
    near(at(braino, one('y', -20), 0, x76), -20 * x76 / 0.1, 1e-4, 'Y -20 Hz: -20 Hz x (y / 100 mm)');
    near(at(braino, one('z2', 30), x76, 0), -30 * x76 * x76 / 0.01, 1e-4, 'Z2 30 Hz: -30 Hz (r / 100 mm)^2');
    near(at(braino, one('xy', 15), x38, x38), 15 * 2 * x38 * x38 / 0.01, 1e-4, 'XY 15 Hz: 15 Hz x 2xy / R^2');
    near(at(braino, one('z0', -7), 0.03, 0.04), -7, 1e-6, 'Z0 -7 Hz everywhere');
    // Linear in the coefficients, with shim scaling the residual.
    const half = F.b0Map(braino, { susceptibility: 0, shim: 0.5 });
    ok(half.every((v, i) => abs(v - 0.5 * un[i]) < 1e-4), 'shim scales the residual');

    // Air stays exactly 0 whatever the shims do.
    const wild = F.b0Map(brain, { susceptibility: 2, shim: 1, shimCoeffs: { z0: 50, x: -140, y: 90, xy: 70, x2y2: -60, z2: 120 } });
    let airBad = 0;
    for (let i = 0; i < wild.length; i++) if (!brain.label[i] && wild[i] !== 0) airBad++;
    ok(airBad === 0, 'b0 is exactly 0 in air with shims on');

    // Shim currents equal to minus the residual cancel it exactly.
    const cancel = F.b0Map(brain, { susceptibility: 1, shim: 1, shimCoeffs: neg(RC) });
    ok(cancel.every((v, i) => v === brain.dB0[i]), 'shimCoeffs = -residual coefficients cancel the residual exactly (bit for bit)');
    const cancelB = F.b0Map(braino, { susceptibility: 1, shim: 1, shimCoeffs: neg(RC) });
    ok(cancelB.every(v => v === 0), 'and leave braino with no field at all');
    near(F.shimResidual(0.1, 0), RC.z0 + RC.x + RC.x2y2 - RC.z2, 1e-9, 'shimResidual(x, y) evaluates the residual');
    near(F.shimField({ x: 10, z2: -10 }, 0.05, 0), 10 * 0.5 + 10 * 0.25, 1e-9, 'shimField evaluates any set of coefficients');
}

/* ---------- 3. fieldStats ---------- */
{
    const z = F.fieldStats(braino, new Float32Array(256 * 256));
    ok(z.mean === 0 && z.sd === 0 && z.fwhmHz === 0 && z.nPoints > 15000, 'uniform field: mean 0, SD 0, FWHM 0');
    // A linear field g x over a disk of radius a: SD g a / 2, semicircular histogram of FWHM sqrt(3) g a.
    const lin = F.b0Map(braino, { susceptibility: 0, shimCoeffs: { x: 20 } });
    const s = F.fieldStats(braino, lin), a = 0.08, g = 200;
    near(s.mean, 0, 0.05, 'linear field: mean 0');
    near(s.sd, g * a / 2, 0.15, 'linear field: SD = g a / 2');
    near(s.fwhmHz, sqrt(3) * g * a, 1.5, 'linear field: FWHM of the semicircle = sqrt(3) g a');
    let sum = 0;
    for (let k = 0; k < s.hist.counts.length; k++) sum += s.hist.counts[k];
    near(sum, 1, 1e-5, 'histogram counts sum to 1');
    ok(s.hist.centers.length === s.hist.counts.length && s.hist.centers.length >= 60 && s.hist.binHz > 0, 'histogram centres and counts');
    near(s.hist.centers[0], s.min, 1e-3, 'histogram starts at the minimum');
    const sc = F.fieldStats(braino, lin, { region: 'center' });
    near(sc.sd, g * 0.06 / 2, 0.15, 'central region (60 mm radius): SD = g r / 2');
    ok(sc.nPoints < s.nPoints, 'central region has fewer points');
    const s30 = F.fieldStats(braino, lin, { region: 'center', radius: 0.03 });
    near(s30.sd, g * 0.03 / 2, 0.2, 'radius option');
    // A pure bowl over a disk gives a flat histogram: FWHM is its whole range.
    const bowl = F.b0Map(braino, { susceptibility: 0, shimCoeffs: { z2: -30 } });
    const sbw = F.fieldStats(braino, bowl);
    near(sbw.fwhmHz, 30 * 0.64, 1.2, 'bowl: flat distribution, FWHM = range');
    // pd weighting
    const m = F.b0Map(brain, { susceptibility: 1, shim: 1 });
    let W = 0, S1 = 0;
    for (let i = 0; i < m.length; i++) { const L = brain.label[i]; if (!L) continue; const w = brain.tissues[L].pd; W += w; S1 += w * m[i]; }
    near(F.fieldStats(brain, m).mean, S1 / W, 1e-6, 'mean is pd-weighted');
    near(F.fieldStats(brain, m).rms, pdRms(brain, m), 1e-6, 'rms is the pd-weighted RMS about 0 Hz');
}

/* ---------- 4. autoShim ---------- */
{
    // braino: no intrinsic field, so the residual can be removed completely.
    const b0 = { susceptibility: 1, shim: 1, shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } };
    const r = F.autoShim(braino, b0, { region: 'object' });
    ok(r.rmsBefore > 20, 'braino un-shimmed RMS ' + r.rmsBefore.toFixed(1) + ' Hz');
    ok(r.rmsAfter < 0.5, 'autoShim on braino: RMS after < 0.5 Hz (' + r.rmsAfter.toExponential(2) + ')');
    ok(IDS.every(id => abs(r.shimCoeffs[id] + RC[id]) < 1e-6), 'autoShim finds minus the residual coefficients');
    const m = F.b0Map(braino, Object.assign({}, b0, { shimCoeffs: r.total }));
    ok(pdRms(braino, m) < 0.5, 'applying the result: field RMS < 0.5 Hz (' + pdRms(braino, m).toExponential(2) + ')');
    near(r.rmsBefore, pdRms(braino, F.b0Map(braino, b0)), 1e-6, 'rmsBefore is the pd-weighted RMS field');
    ok(r.nPoints > 15000 && r.region === 'object', 'region reported');

    // Coefficients ADD to the existing ones.
    const start = { z0: 30, x: 40, y: -5, xy: 0, x2y2: 20, z2: 10 };
    const b1 = { susceptibility: 1, shim: 1, shimCoeffs: start };
    const r1 = F.autoShim(braino, b1, { region: 'object' });
    ok(IDS.every(id => abs(start[id] + r1.shimCoeffs[id] + RC[id]) < 1e-6), 'returned coefficients are the change to add to the existing ones');
    ok(IDS.every(id => abs(r1.total[id] - (start[id] + r1.shimCoeffs[id])) < 1e-12), 'total = existing + change');
    // The central region alone also determines all six terms on braino.
    const r2 = F.autoShim(braino, b0, { region: 'center', radius: 0.06 });
    ok(r2.rmsAfter < 0.5 && r2.region === 'center' && r2.nPoints < r.nPoints, 'central-region auto-shim on braino');
    // A precomputed map gives the same answer.
    const r3 = F.autoShim(braino, b0, { b0Map: F.b0Map(braino, b0) });
    ok(IDS.every(id => abs(r3.shimCoeffs[id] - r.shimCoeffs[id]) < 1e-9), 'opts.b0Map is used');

    // Brain: the residual goes, the sinus field stays.
    const bb = { susceptibility: 1, shim: 1 };
    const rb = F.autoShim(brain, bb, { region: 'object' });
    const r0 = F.autoShim(brain, { susceptibility: 1, shim: 0 }, { region: 'object' });
    const mb = F.b0Map(brain, Object.assign({}, bb, { shimCoeffs: rb.total }));
    const m0 = F.b0Map(brain, { susceptibility: 1, shim: 0, shimCoeffs: r0.total });
    let diff = 0;
    for (let i = 0; i < mb.length; i++) diff = max(diff, abs(mb[i] - m0[i]));
    ok(diff < 1e-3, 'brain: the shimmed field does not depend on the residual (it is removed completely): max diff ' + diff.toExponential(2) + ' Hz');
    ok(rb.rmsAfter < rb.rmsBefore && rb.rmsAfter > 3, 'brain: RMS ' + rb.rmsBefore.toFixed(1) + ' -> ' + rb.rmsAfter.toFixed(1) + ' Hz, the sinus field cannot be shimmed away');
    const lm = brain.landmarks.find(l => /Orbitofrontal/.test(l.name));
    ok(lm && at(brain, mb, lm.x, lm.y) > 50, 'brain: the orbitofrontal field next to the sinus is still > 50 Hz after auto-shim (' + (lm ? at(brain, mb, lm.x, lm.y).toFixed(0) : '?') + ' Hz)');
    const rc = F.autoShim(brain, bb, { region: 'center' });
    const mc = F.b0Map(brain, Object.assign({}, bb, { shimCoeffs: rc.total }));
    ok(F.fieldStats(brain, mc, { region: 'center' }).sd < F.fieldStats(brain, mb, { region: 'center' }).sd,
        'brain: shimming the central region makes the centre more uniform than a whole-object shim');
}

/* ---------- 5. The engine and the spectroscopy simulator pick the shims up ---------- */
(async function () {
    // Spectroscopy: the water line narrows after auto-shim.
    const base = { noise: 0, b0: { susceptibility: 1, shim: 1, shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } }, b1: { amount: 0 } };
    const wBad = S.waterLine(braino, { artifacts: base });
    const r = F.autoShim(braino, base.b0, {});
    const good = { noise: 0, b0: Object.assign({}, base.b0, { shimCoeffs: r.total }), b1: { amount: 0 } };
    const wGood = S.waterLine(braino, { artifacts: good });
    ok(wBad.fwhmHz > 10 && wGood.fwhmHz < 2.2, 'waterLine FWHM shrinks after auto-shim: ' + wBad.fwhmHz.toFixed(2) + ' -> ' + wGood.fwhmHz.toFixed(2) + ' Hz');
    near(wGood.fwhmHz, 1 / (Math.PI * 0.30) + 1, 0.05, 'shimmed braino water line = 1/(pi T2) + 1 Hz');
    near(wGood.peakHz, 0, 0.3, 'and Z0 puts water back on the receiver frequency');
    const prog = MRI.dsl.compile(MRI.presets.get('fid').source);
    const dBad = S.simulate(prog, braino, { artifacts: base }, { seed: 2 });
    const dGood = S.simulate(prog, braino, { artifacts: good }, { seed: 2 });
    ok(dGood.info.linewidthHz < 0.2 * dBad.info.linewidthHz, 'spectro.simulate reads shimCoeffs from artifacts.b0: ' + dBad.info.linewidthHz.toFixed(1) + ' -> ' + dGood.info.linewidthHz.toFixed(2) + ' Hz');
    const sBad = S.process(dBad, S.defaults), sGood = S.process(dGood, S.defaults);
    const pk = (s, id) => s.peaks.find(p => p.id === id);
    ok(abs(pk(sGood, 'water').ppm - 4.7) < 0.01 && pk(sBad, 'water').ppm > 4.8, 'the Z0 error shifts water off 4.7 ppm until shimmed: ' + pk(sBad, 'water').ppm.toFixed(3) + ' -> ' + pk(sGood, 'water').ppm.toFixed(3) + ' ppm');

    // Imaging engine: a GRE of braino is identical to the ideal field once shimmed.
    const E = MRI.engine;
    const g = MRI.dsl.compile(MRI.presets.get('gre_t2s').source, { overrides: { N: 64 } });
    const cs = F.coilSet('body');
    const run = async (b0) => {
        const art = E._internal.mergeArtifacts({ noise: 0, b0: b0 });
        // no b0Map in ctx: the engine computes it from artifacts.b0 itself
        const acq = await E.simulate(g, braino, { coilSet: cs, coilMaps: F.coilMaps(cs, 256, 256, braino.fov, braino.fov), artifacts: art }, { seed: 1 });
        const ro = acq.readouts[acq.readouts.length >> 1];
        let s = 0;
        for (let j = 0; j < ro.n; j++) s += Math.hypot(ro.re[0][j], ro.im[0][j]);
        return s;
    };
    const ideal = await run({ susceptibility: 1, shim: 0 });
    const unshim = await run({ susceptibility: 1, shim: 1 });
    const shimmed = await run({ susceptibility: 1, shim: 1, shimCoeffs: r.total });
    ok(abs(unshim - ideal) > 0.01 * ideal, 'engine: the residual changes the GRE echo (' + (unshim / ideal).toFixed(3) + ' of ideal)');
    near(shimmed / ideal, 1, 1e-4, 'engine: shim currents from autoShim restore the ideal echo');

    summary('shim');
})().catch(e => { console.error(e); process.exitCode = 1; });
