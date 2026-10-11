'use strict';
/* Tests for js/recon.js.

   The engine and phantom modules are written in parallel, so these
   tests build their own inputs in exactly the shapes ARCHITECTURE.md
   specifies: synthetic phantoms (section 6) and synthetic AcqData
   (section 8.3) made from a known concentration image with
   PET.scanner. The helpers are exported (and the tests only run when
   this file is the main module) so tests/test_analysis.js can reuse
   them. */
const { load, ok, near, summary } = require('./harness');

/* ---------- synthetic phantoms (ARCHITECTURE.md section 6) ---------- */

/* Paint regions in order (later ones overwrite earlier ones) onto the
   256 x 256, 320 mm raster with hard labels, like phantoms.js does.
   spec.regions[k] = { id, name, tissue, mu, rel, roi, color, inside(x, y) }
   regions[0] is always air. */
function buildPhantom(PET, spec) {
    const n = 256, fov = 320, dx = fov / n, h = n / 2;
    const regions = [{ id: 'air', name: 'Air', color: '#000000', mu: 0, tissue: 'air', rel: 0, roi: false }]
        .concat(spec.regions.map(r => Object.assign({ rel: 0, roi: true, color: '#888888' }, r)));
    const label = new Uint8Array(n * n), mu = new Float32Array(n * n);
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * dx, y = (iy - h) * dx;
        let lab = 0;
        for (let k = 1; k < regions.length; k++) if (regions[k].inside(x, y)) lab = k;
        label[iy * n + ix] = lab;
        mu[iy * n + ix] = regions[lab].mu;
    }
    const axialLength = spec.axialLength || 200;
    regions.forEach((r, k) => {
        let c = 0; for (let j = 0; j < label.length; j++) if (label[j] === k) c++;
        r.pixels = c; r.volume = c * dx * dx * axialLength / 1000;
        delete r.inside;
    });
    return {
        id: spec.id, name: spec.name, description: spec.name, kind: spec.kind || 'solution',
        n: n, fov: fov, dx: dx, label: label, regions: regions, mu: mu,
        axialLength: axialLength, outsideFraction: spec.outsideFraction || 0,
        condition: spec.condition || null, landmarks: [], notes: ''
    };
}
const circ = (cx, cy, r) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
const ell = (cx, cy, a, b) => (x, y) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1;

/* 200 mm water cylinder with a 3 mm PMMA wall. Optional extra disks
   (hot or cold), given as { id, x, y, d, rel }. */
function cylinderPhantom(PET, extra) {
    const regions = [
        { id: 'wall', name: 'PMMA wall', tissue: 'plastic', mu: 0.0103, rel: 0, roi: false, inside: circ(0, 0, 103) },
        { id: 'water', name: 'Water', tissue: 'water', mu: 0.0096, rel: 1, roi: true, inside: circ(0, 0, 100) }
    ];
    (extra || []).forEach(e => regions.push({ id: e.id, name: e.name || e.id, tissue: e.tissue || 'water', mu: e.mu === undefined ? 0.0096 : e.mu, rel: e.rel, roi: true, inside: circ(e.x, e.y, e.d / 2) }));
    return buildPhantom(PET, { id: 'cylinder', name: 'Uniform cylinder', regions: regions, axialLength: 200 });
}
/* NEMA-like: 200 mm cylinder background, four hot disks (10 to 22 mm,
   ratio 4), two cold disks (28, 37 mm) on a 57.2 mm circle, and a
   central lung insert without activity. */
function spheresPhantom(PET, ratio, diameter) {
    ratio = ratio || 4;
    const ds = [10, 13, 17, 22, 28, 37], R = 57.2, rb = (diameter || 200) / 2;
    const regions = [
        { id: 'wall', name: 'PMMA wall', tissue: 'plastic', mu: 0.0103, rel: 0, roi: false, inside: circ(0, 0, rb + 3) },
        { id: 'background', name: 'Background', tissue: 'water', mu: 0.0096, rel: 1, roi: true, inside: circ(0, 0, rb) },
        { id: 'lung', name: 'Lung insert', tissue: 'lung', mu: 0.0030, rel: 0, roi: true, inside: circ(0, 0, 25.5) }
    ];
    ds.forEach((d, k) => {
        const a = k * Math.PI / 3;
        regions.push({ id: 'sphere' + d, name: d + ' mm sphere', tissue: 'water', mu: 0.0096, rel: d < 25 ? ratio : 0, roi: true,
            inside: circ(R * Math.cos(a), R * Math.sin(a), d / 2) });
    });
    return buildPhantom(PET, { id: 'spheres', name: 'Hot and cold spheres', regions: regions, axialLength: 180 });
}
/* A small schematic brain using the contract's region ids. Radiological
   convention: anterior up (negative y), patient's left on image right. */
function brainPhantom(PET) {
    const brain = ell(0, -4, 63, 80);
    const regions = [
        { id: 'scalp', name: 'Scalp', tissue: 'soft', mu: 0.0096, roi: false, inside: ell(0, 0, 75, 95) },
        { id: 'skull', name: 'Skull', tissue: 'bone', mu: 0.0151, roi: false, inside: ell(0, 0, 71, 91) },
        { id: 'csf', name: 'CSF', tissue: 'csf', mu: 0.0096, roi: false, inside: ell(0, -2, 66, 85) },
        { id: 'gm_frontal', name: 'Frontal cortex', tissue: 'gm', mu: 0.0099, inside: (x, y) => brain(x, y) && y < -25 },
        { id: 'gm_temporal', name: 'Temporal cortex', tissue: 'gm', mu: 0.0099, inside: (x, y) => brain(x, y) && y >= -25 && y < 25 },
        { id: 'gm_occipital', name: 'Occipital cortex', tissue: 'gm', mu: 0.0099, inside: (x, y) => brain(x, y) && y >= 25 },
        { id: 'wm', name: 'White matter', tissue: 'wm', mu: 0.0099, inside: ell(0, -4, 58, 75) },
        { id: 'ventricles', name: 'Ventricles', tissue: 'csf', mu: 0.0096, roi: false, inside: (x, y) => ell(-8, -18, 5, 13)(x, y) || ell(8, -18, 5, 13)(x, y) },
        { id: 'caudate_r', name: 'Caudate (R)', tissue: 'gm', mu: 0.0099, inside: circ(-15, -20, 6) },
        { id: 'caudate_l', name: 'Caudate (L)', tissue: 'gm', mu: 0.0099, inside: circ(15, -20, 6) },
        { id: 'putamen_r_ant', name: 'Putamen anterior (R)', tissue: 'gm', mu: 0.0099, inside: ell(-28, -12, 5.5, 8) },
        { id: 'putamen_r_post', name: 'Putamen posterior (R)', tissue: 'gm', mu: 0.0099, inside: ell(-28, 4, 5.5, 8) },
        { id: 'putamen_l_ant', name: 'Putamen anterior (L)', tissue: 'gm', mu: 0.0099, inside: ell(28, -12, 5.5, 8) },
        { id: 'putamen_l_post', name: 'Putamen posterior (L)', tissue: 'gm', mu: 0.0099, inside: ell(28, 4, 5.5, 8) },
        { id: 'thalamus', name: 'Thalamus', tissue: 'gm', mu: 0.0099, inside: (x, y) => ell(-9, 14, 7, 9)(x, y) || ell(9, 14, 7, 9)(x, y) },
        { id: 'cereb_gm', name: 'Cerebellar gray matter', tissue: 'gm', mu: 0.0099, inside: ell(0, 60, 42, 20) },
        { id: 'cereb_wm', name: 'Cerebellar white matter', tissue: 'wm', mu: 0.0099, inside: ell(0, 60, 28, 8) },
        { id: 'sinus', name: 'Venous sinus', tissue: 'blood', mu: 0.0099, roi: false, inside: circ(0, 82, 4.5) }
    ];
    return buildPhantom(PET, { id: 'brain', name: 'Brain', kind: 'brain', condition: 'normal', regions: regions, axialLength: 150, outsideFraction: 0.3 });
}
/* Decay-corrected Bq/mL per region of the brain phantom for tests. */
function brainValues(ph) {
    const v = { scalp: 1500, skull: 0, csf: 0, gm_frontal: 10000, gm_temporal: 9000, gm_occipital: 10500, wm: 4000, ventricles: 0,
        caudate_r: 11000, caudate_l: 10000, putamen_r_ant: 12000, putamen_r_post: 11500, putamen_l_ant: 9000, putamen_l_post: 5000,
        thalamus: 9000, cereb_gm: 8000, cereb_wm: 3500, sinus: 15000, air: 0 };
    return Float64Array.from(ph.regions.map(r => v[r.id] || 0));
}
function concImage(ph, values) {
    const out = new Float32Array(ph.n * ph.n);
    for (let k = 0; k < out.length; k++) out[k] = values[ph.label[k]];
    return out;
}

/* ---------- synthetic AcqData (ARCHITECTURE.md 8.3) ----------
   expected trues  = kappa * blur(P C) * attenuation * norm
   scatter         = a smooth broad blur of the attenuated-away part, scaled to a scatter fraction
   randoms         = flat times norm, scaled to a randoms/trues ratio
   prompts         = Poisson(T + S + R) (or the expected values), delayed = Poisson(R)
   scatterEst      = the true scatter, randomsSingles = the expected randoms
   o = { values: Float64Array per region (or one per frame), frames: [{t0, t1}], isotope, tof, noise, seed,
         attenuation, scatter, randoms, blur, range, variation, deadBlock, targetTrues, sf, rf,
         muCorr (mu map used for correction), shift: {dx, dy} (object moved; promptsMC holds the unmoved data) } */
const projCache = {};
function proj(PET, tof) {
    const S = PET.scanner, key = tof ? 'tof' : 'plain';
    if (!projCache[key] || projCache[key].PET !== PET) projCache[key] = { PET: PET, P: S.projector({ n: 256, tof: tof ? { sigma: S.timing.sigmaPos(400e-12) } : null }) };
    return projCache[key].P;
}
function scatterShape(PET, L) {
    // Gaussian along r (sigma 70 mm) then across angles (sigma 2 rows, wrapping theta + pi to -r)
    const G = PET.scanner.geom, nA = G.nA, nR = G.nR, sg = 70 / G.dr, h = Math.ceil(3 * sg);
    const kr = []; for (let d = -h; d <= h; d++) kr.push(Math.exp(-0.5 * (d / sg) ** 2));
    const tmp = new Float32Array(nA * nR), out = new Float32Array(nA * nR);
    for (let a = 0; a < nA; a++) for (let i = 0; i < nR; i++) {
        let s = 0; for (let d = -h; d <= h; d++) { const j = i + d; if (j >= 0 && j < nR) s += L[a * nR + j] * kr[d + h]; }
        tmp[a * nR + i] = s;
    }
    const ka = [0.06, 0.24, 0.4, 0.24, 0.06];
    for (let a = 0; a < nA; a++) for (let i = 0; i < nR; i++) {
        let s = 0;
        for (let d = -2; d <= 2; d++) {
            let aa = a + d, ii = i;
            if (aa < 0) { aa += nA; ii = nR - i; } else if (aa >= nA) { aa -= nA; ii = nR - i; }
            if (ii >= 0 && ii < nR) s += tmp[aa * nR + ii] * ka[d + 2];
        }
        out[a * nR + i] = s;
    }
    return out;
}
function makeAcq(PET, ph, o) {
    o = Object.assign({ frames: [{ t0: 0, t1: 600 }], isotope: 'F18', tof: false, noise: false, seed: 7, attenuation: true,
        scatter: true, randoms: true, blur: true, range: false, variation: 0.06, deadBlock: -1, targetTrues: 2e6,
        sf: 0.3, rf: 0.25, muCorr: null, shift: null }, o || {});
    const U = PET.util, S = PET.scanner, G = S.geom, I = PET.isotopes, iso = I.get(o.isotope);
    const n = ph.n, NL = G.nA * G.nR, nT = o.tof ? G.nT : 1, P = proj(PET, o.tof), P0 = proj(PET, false);
    const ones = new Float32Array(NL).fill(1);
    const af = o.attenuation ? S.attenuationFactors(ph.mu, n) : ones;
    const afCorr = S.attenuationFactors(o.muCorr || ph.mu, n), acf = new Float32Array(NL);
    for (let k = 0; k < NL; k++) acf[k] = 1 / afCorr[k];
    const norm = S.normalization({ variation: o.variation, deadBlock: o.deadBlock, seed: 4242 }).bins;
    const rng = U.rng(o.seed), sigT = S.timing.sigmaPos(400e-12), tauW = 4.5e-9;
    const perBin = S.timing.randomsTofFraction(tauW, G.ds, G.nT).perBin;
    let kappa0 = null;
    const frames = o.frames.map((fr, fi) => {
        const values = Array.isArray(o.values) || (o.values && o.values[0] && o.values[0].length) ? (o.values[fi] || o.values[0]) : o.values;
        const vals = values || Float64Array.from(ph.regions.map(r => r.rel));
        let C = concImage(ph, vals);
        if (o.range) { const k = I.rangeKernel(iso, ph.dx); C = U.convolve2D(C, n, n, k.kernel, k.size); }
        const sim = (img) => {
            const pc = P.forward(img);
            const b = o.blur ? S.blurRadial(pc, nT, false) : pc;
            const t = new Float32Array(b.length);
            for (let k = 0; k < NL; k++) for (let q = 0; q < nT; q++) t[k * nT + q] = b[k * nT + q] * af[k] * norm[k];
            return { pc: pc, t: t };
        };
        const moved = o.shift ? U.transformImage(C, n, ph.dx, o.shift.dx || 0, o.shift.dy || 0, 0) : C;
        const main = sim(moved), ref = o.shift ? sim(C) : main;
        const dI = I.decayIntegral(iso, Math.max(0, fr.t0), Math.max(0, fr.t1)), dur = fr.t1 - fr.t0;
        if (kappa0 === null) { const s = U.sum(main.t); kappa0 = s > 0 ? o.targetTrues / (iso.betaPlus * dI * s) : 1; }
        const kappa = fr.t1 > 0 ? kappa0 * iso.betaPlus * dI : 0, kappaNoDecay = fr.t1 > 0 ? kappa0 * iso.betaPlus * dur : 0;
        const build = (m) => {
            const T = new Float32Array(m.t.length); for (let k = 0; k < T.length; k++) T[k] = kappa * m.t[k];
            const sumT = U.sum(T);
            // scatter: L = (unattenuated non-TOF projection) x (1 - a), smoothed
            const pcn = S.sumTOF(m.pc, nT), L = new Float32Array(NL);
            for (let k = 0; k < NL; k++) L[k] = pcn[k] * (1 - af[k]);
            let Sl = scatterShape(PET, L);
            for (let k = 0; k < NL; k++) Sl[k] *= norm[k];
            const sSum = U.sum(Sl), sScale = (o.scatter && sSum > 0) ? (o.sf / (1 - o.sf)) * sumT / sSum : 0;
            const Sc = new Float32Array(T.length);
            for (let k = 0; k < NL; k++) {
                const sv = Sl[k] * sScale;
                if (nT === 1) { Sc[k] = sv; continue; }
                // TOF: spread over bins like the trues profile blurred by a broad Gaussian (sigma 4 bins)
                const prof = new Float64Array(nT); let ps = 0;
                for (let q = 0; q < nT; q++) {
                    let v = 0; for (let p = 0; p < nT; p++) v += (m.t[k * nT + p] + 1e-6 * Math.exp(-0.5 * ((p - 8) / 4) ** 2)) * Math.exp(-0.5 * ((q - p) / 4) ** 2);
                    prof[q] = v; ps += v;
                }
                for (let q = 0; q < nT; q++) Sc[k * nT + q] = sv * prof[q] / ps;
            }
            // randoms: flat times norm
            let nsum = 0; for (let k = 0; k < NL; k++) nsum += norm[k];
            const rl = o.randoms ? o.rf * sumT / nsum : 0, R = new Float32Array(T.length);
            for (let k = 0; k < NL; k++) for (let q = 0; q < nT; q++) R[k * nT + q] = rl * norm[k] * (nT > 1 ? perBin : 1);
            const E = new Float32Array(T.length); for (let k = 0; k < E.length; k++) E[k] = T[k] + Sc[k] + R[k];
            return { T: T, S: Sc, R: R, E: E };
        };
        const A = build(main), B = o.shift ? build(ref) : null;
        const prompts = o.noise ? U.poissonArray(rng, A.E) : A.E;
        const delayed = o.noise ? U.poissonArray(rng, A.R) : Float32Array.from(A.R);
        const promptsMC = B ? (o.noise ? U.poissonArray(rng, B.E) : B.E) : null;
        const tr = U.sum(A.T), sc = U.sum(A.S), rr = U.sum(A.R);
        return {
            index: fi, t0: fr.t0, t1: fr.t1, dur: dur, decayIntegral: dI, kappa: kappa, kappaNoDecay: kappaNoDecay,
            prompts: prompts, promptsMC: promptsMC, delayed: delayed, randomsSingles: A.R, scatterEst: A.S,
            expected: { trues: S.sumTOF(A.T, nT), scatter: S.sumTOF(A.S, nT), randoms: S.sumTOF(A.R, nT) },
            counts: { prompts: U.sum(prompts), trues: tr, scatter: sc, randoms: rr, nec: tr * tr / (tr + sc + rr), sf: sc / (tr + sc), rf: rr / tr },
            truth: { regionMean: Float64Array.from(vals) }
        };
    });
    const tot = k => frames.reduce((s, f) => s + f.counts[k], 0);
    return {
        program: { ok: true, name: 'synthetic', frames: o.frames, isotope: iso.id, tracer: null, dose: 40e6, weight: 70 },
        phantomId: ph.id, phantomOpts: {}, seed: o.seed,
        physics: { attenuation: o.attenuation, scatter: o.scatter, randoms: o.randoms, noise: o.noise, positronRange: o.range,
            detectorBlur: o.blur, motion: { on: !!o.shift, kind: 'step', dx: o.shift ? o.shift.dx : 0, dy: 0, rot: 0 },
            muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' }, detector: { variation: o.variation, deadBlock: o.deadBlock }, seed: o.seed },
        isotope: iso.id, tracer: null, dose: 40e6, weight: 70,
        geom: { nA: G.nA, nR: G.nR, nT: nT, tof: !!o.tof, ctr: 400e-12, sigmaTOF: o.tof ? sigT : 0, ds: G.ds, dr: G.dr },
        frames: frames,
        corrections: { norm: norm, acf: acf, muCorr: o.muCorr || ph.mu },
        muTrue: ph.mu,
        totals: { prompts: tot('prompts'), trues: tot('trues'), scatter: tot('scatter'), randoms: tot('randoms'), nec: tot('nec') },
        stats: { computeMs: 0, sliceThickness: 4 }, warnings: []
    };
}

/* ROI helpers in image coordinates (mm) */
function diskMean(img, n, dx, cx, cy, r0, r1) {
    if (r1 === undefined) { r1 = r0; r0 = 0; }
    const h = Math.floor(n / 2); let s = 0, c = 0;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * dx - cx, y = (iy - h) * dx - cy, d = Math.sqrt(x * x + y * y);
        if (d >= r0 && d <= r1) { s += img[iy * n + ix]; c++; }
    }
    return s / c;
}
function diskSD(img, n, dx, cx, cy, r) {
    const m = diskMean(img, n, dx, cx, cy, r), h = Math.floor(n / 2); let s = 0, c = 0;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * dx - cx, y = (iy - h) * dx - cy;
        if (x * x + y * y <= r * r) { s += (img[iy * n + ix] - m) ** 2; c++; }
    }
    return Math.sqrt(s / c);
}
/* FWHM (mm) of the row through the brightest pixel near (x, y) */
function rowFwhm(img, n, dx, x, y) {
    const h = Math.floor(n / 2); let best = -Infinity, bx = 0, by = 0;
    for (let iy = Math.round(y / dx) + h - 3; iy <= Math.round(y / dx) + h + 3; iy++) for (let ix = Math.round(x / dx) + h - 3; ix <= Math.round(x / dx) + h + 3; ix++)
        if (img[iy * n + ix] > best) { best = img[iy * n + ix]; bx = ix; by = iy; }
    const v = k => img[by * n + k], half = best / 2;
    let l = bx; while (l > 0 && v(l) > half) l--;
    let r = bx; while (r < n - 1 && v(r) > half) r++;
    const xl = l + (half - v(l)) / (v(l + 1) - v(l)), xr = r - 1 + (v(r - 1) - half) / (v(r - 1) - v(r));
    return (xr - xl) * dx;
}

module.exports = { buildPhantom, cylinderPhantom, spheresPhantom, brainPhantom, brainValues, concImage, makeAcq, diskMean, diskSD, rowFwhm };

/* ---------- the tests ---------- */
async function main() {
    const PET = load(['core', 'isotopes', 'scanner', 'recon']);
    const U = PET.util, S = PET.scanner, G = S.geom, R = PET.recon, X = R._internal;
    const C0 = 40e6 / (Math.PI * 100 * 100 * 200 / 1000);     // 40 MBq in the 200 mm cylinder, Bq/mL
    const cyl = cylinderPhantom(PET);
    const cylValues = Float64Array.from(cyl.regions.map(r => r.rel * C0));
    const run = (acq, o, h) => R.run(acq, o, h);
    const centre = (res) => diskMean(res.image, res.n, res.dx, 0, 0, 50);

    // ----- filters
    {
        const W = R.filters.window;
        near(W('ramp', 0.7, 1), 1, 1e-12, 'ramp window is flat');
        near(W('ramp', 0.7, 0.5), 0, 1e-12, 'every window but Butterworth is zero above the cutoff');
        near(W('hann', 0.5, 0.5), 0, 1e-12, 'Hann reaches zero at the cutoff');
        near(W('hamming', 0.5, 0.5), 0.08, 1e-12, 'Hamming keeps 8 % at the cutoff');
        near(W('shepp', 1, 1), 2 / Math.PI, 1e-9, 'Shepp-Logan window at the cutoff is sinc(1/2)');
        near(W('cosine', 1, 1), 0, 1e-9, 'cosine window at the cutoff');
        near(W('butterworth', 0.4, 0.4, 5), Math.SQRT1_2, 1e-9, 'Butterworth is 0.707 at the cutoff');
        ok(W('butterworth', 0.6, 0.4, 8) < W('butterworth', 0.6, 0.4, 2), 'higher Butterworth order falls faster');
        let threw = false; try { W('wiener', 0.5, 1); } catch (e) { threw = true; }
        ok(threw, 'unknown filter throws');
        const rsp = R.filters.response('hann', 0.8, 4, 51);
        ok(rsp.u.length === 51 && rsp.response.length === 51 && rsp.window.length === 51, 'response arrays have nFreq points');
        near(rsp.freq[50], 0.25, 1e-12, 'frequency axis ends at Nyquist of 2 mm bins (0.25 cycles/mm)');
        near(rsp.response[20], rsp.u[20] * rsp.window[20], 1e-12, 'response = ramp x window');
        ok(R.filters.list.length === 6 && R.filters.list.every(f => f.id && f.name && f.description), 'filter list has six entries with names');
        const H = X.rampSpectrum(512), nyq = 0.25;
        ok(H[0] > 0 && H[0] < 0.01 * nyq, 'discrete ramp has a small positive DC term (no DC shift), ' + H[0].toExponential(2));
        near(H[256] / nyq, 1, 0.02, 'ramp reaches |f| at Nyquist');
        near(H[128] / (128 / (512 * 2)), 1, 0.02, 'ramp is |f| at mid frequencies');
        const d1 = R.defaults; d1.corrections.attenuation = false; d1.iterations = 99;
        ok(R.defaults.corrections.attenuation === true && R.defaults.iterations === 4, 'defaults are a fresh copy each time');
        ok(['bp', 'fbp', 'mlem', 'osem'].indexOf(R.defaults.method) >= 0 && R.defaults.matrix === 128 && R.defaults.postFilter === 3, 'defaults follow the contract');
    }

    // ----- operators: subset blur equals blurRadial, range convolution, pixel backprojection
    {
        const rng = U.rng(3);
        for (const nT of [1, G.nT]) {
            const x = new Float32Array(G.nA * G.nR * nT); for (let k = 0; k < x.length; k++) x[k] = rng();
            const full = S.blurRadial(x, nT, false), fullT = S.blurRadial(x, nT, true);
            const sub = S.subsets(12)[5], a = X.blurRows(x, new Float32Array(x.length), sub, nT, false), b = X.blurRows(x, new Float32Array(x.length), sub, nT, true);
            let e1 = 0, e2 = 0;
            for (const ang of sub) for (let k = ang * G.nR * nT; k < (ang + 1) * G.nR * nT; k++) { e1 = Math.max(e1, Math.abs(a[k] - full[k])); e2 = Math.max(e2, Math.abs(b[k] - fullT[k])); }
            ok(e1 < 1e-5 && e2 < 1e-5, 'subset blur matches blurRadial and its transpose, nT=' + nT);
        }
        const k = PET.isotopes.rangeKernel('O15', 2.5), n = 64, img = new Float32Array(n * n), y = new Float32Array(n * n);
        for (let j = 0; j < img.length; j++) { img[j] = rng(); y[j] = rng(); }
        const c1 = X.convolveSym(img, n, k.kernel, k.size), c2 = U.convolve2D(img, n, n, k.kernel, k.size);
        let e = 0; for (let j = 0; j < img.length; j++) e = Math.max(e, Math.abs(c1[j] - c2[j]));
        ok(e < 1e-5, 'gather convolution equals PET.util.convolve2D for the range kernel');
        const cy = X.convolveSym(y, n, k.kernel, k.size);
        let l = 0, r = 0; for (let j = 0; j < img.length; j++) { l += c1[j] * y[j]; r += img[j] * cy[j]; }
        near(l / r, 1, 1e-5, 'range convolution is its own adjoint');
    }

    // ----- uniform cylinder, noise-free, every effect on and corrected: Bq/mL come out right
    const cylAcq = makeAcq(PET, cyl, { values: cylValues });
    const cylTof = makeAcq(PET, cyl, { values: cylValues, tof: true });
    near(cylAcq.frames[0].counts.sf, 0.3, 0.01, 'synthetic data has the requested scatter fraction');
    {
        for (const filter of ['ramp', 'shepp', 'hann', 'butterworth']) {
            const r = await run(cylAcq, { method: 'fbp', filter: filter, postFilter: 0 });
            near(centre(r) / C0, 1, 0.02, 'FBP (' + filter + ') of a uniform cylinder gives its concentration');
        }
        const fb = await run(cylAcq, { method: 'fbp', filter: 'ramp', postFilter: 0 });
        near(diskMean(fb.image, fb.n, fb.dx, 0, 0, 115, 140) / C0, 0, 0.02, 'FBP: nothing outside the cylinder once scatter and randoms are corrected');
        ok(fb.corrected.length === G.nA * G.nR && fb.iterations === null && fb.frames === null, 'FBP result shape');
        const os = await run(cylAcq, { method: 'osem', iterations: 4, subsets: 12, postFilter: 0 });
        near(centre(os) / C0, 1, 0.03, 'OSEM 4x12 of a uniform cylinder gives its concentration');
        ok(os.iterations.length === 4 && os.iterations[3] === os.image && os.info.iterationsDone === 4, 'OSEM keeps every iteration');
        const ml = await run(cylAcq, { method: 'mlem', iterations: 40, postFilter: 0, matrix: 64 });
        near(centre(ml) / C0, 1, 0.03, 'MLEM (40 iterations) of a uniform cylinder gives its concentration');
        const bp = await run(cylAcq, { method: 'bp', postFilter: 0 });
        near(diskMean(bp.image, bp.n, bp.dx, 0, 0, 98) / C0, 1, 0.05, 'backprojection is scaled to the right mean in a uniform cylinder');
        ok(diskMean(bp.image, bp.n, bp.dx, 0, 0, 10) > 1.3 * diskMean(bp.image, bp.n, bp.dx, 0, 0, 80, 95), 'backprojection shows the 1/r blur (peaked centre)');
        for (const m of [64, 256]) {
            const r = await run(cylAcq, { method: 'fbp', filter: 'ramp', postFilter: 0, matrix: m });
            ok(r.n === m && Math.abs(r.dx - 320 / m) < 1e-9, 'matrix ' + m + ' gives n and dx');
            near(centre(r) / C0, 1, 0.02, 'FBP at matrix ' + m);
        }
        const o256 = await run(cylAcq, { method: 'osem', matrix: 256, postFilter: 0 });
        near(centre(o256) / C0, 1, 0.03, 'OSEM at matrix 256');

        // TOF data
        const ft = await run(cylTof, { method: 'fbp', filter: 'ramp', postFilter: 0 });
        near(centre(ft) / C0, 1, 0.02, 'FBP of TOF data (bins summed)');
        ok(ft.info.notes.indexOf('FBP ignores time of flight: the TOF bins were summed.') >= 0 && !ft.info.tofUsed, 'FBP notes that it summed the TOF bins');
        const ot = await run(cylTof, { method: 'osem', postFilter: 0 });
        ok(ot.info.tofUsed, 'OSEM uses TOF when the data has it');
        near(centre(ot) / C0, 1, 0.03, 'TOF OSEM of a uniform cylinder');
        const mt = await run(cylTof, { method: 'mlem', iterations: 15, postFilter: 0, matrix: 64 });
        near(centre(mt) / C0, 1, 0.03, 'TOF MLEM of a uniform cylinder');
        const on = await run(cylTof, { method: 'osem', tof: false, postFilter: 0 });
        ok(!on.info.tofUsed && on.info.notes.some(s => /summed/.test(s)), 'TOF switched off: bins summed and noted');
        near(centre(on) / C0, 1, 0.03, 'non-TOF OSEM of TOF data');
        const bt = await run(cylTof, { method: 'bp', postFilter: 0 });
        near(diskMean(bt.image, bt.n, bt.dx, 0, 0, 98) / C0, 1, 0.05, 'TOF backprojection has the right mean in a uniform cylinder');
        const spill = r => diskMean(r.image, r.n, r.dx, 0, 0, 110, 130) / diskMean(r.image, r.n, r.dx, 0, 0, 98);
        ok(spill(bt) < 0.6 * spill(bp), 'TOF backprojection spreads much less outside the object (' + spill(bt).toFixed(2) + ' vs ' + spill(bp).toFixed(2) + ')');
        const nt = await run(cylAcq, { method: 'osem', tof: true });
        ok(!nt.info.tofUsed && nt.info.notes.some(s => /no time-of-flight data/.test(s)), 'non-TOF data with tof on is noted');
    }

    // ----- Poisson noise: still unbiased, post-filter reduces noise, delayed randoms add noise in FBP
    {
        const noisy = makeAcq(PET, cyl, { values: cylValues, noise: true, seed: 11, rf: 1.0 });
        const a = await run(noisy, { method: 'osem', postFilter: 0 }), b = await run(noisy, { method: 'osem', postFilter: 6 });
        near(centre(a) / C0, 1, 0.03, 'OSEM of noisy data is unbiased in a large ROI');
        ok(diskSD(b.image, b.n, b.dx, 0, 0, 50) < 0.7 * diskSD(a.image, a.n, a.dx, 0, 0, 50), 'a 6 mm post-filter lowers the noise');
        const fd = await run(noisy, { method: 'fbp', postFilter: 0, corrections: { randomsMethod: 'delayed' } });
        const fs = await run(noisy, { method: 'fbp', postFilter: 0, corrections: { randomsMethod: 'singles' } });
        near(centre(fd) / C0, 1, 0.03, 'FBP with delayed-window randoms is unbiased');
        near(centre(fs) / C0, 1, 0.03, 'FBP with randoms from singles is unbiased');
        ok(diskSD(fd.image, fd.n, fd.dx, 0, 0, 50) > diskSD(fs.image, fs.n, fs.dx, 0, 0, 50), 'subtracting the noisy delayed window adds noise');
        ok(fd.info.notes.some(s => /delayed window/.test(s)), 'FBP notes that delayed randoms are noisy');
    }

    // ----- attenuation: missing correction gives a central dip, a wrong one the opposite
    {
        const ratio = r => diskMean(r.image, r.n, r.dx, 0, 0, 15) / diskMean(r.image, r.n, r.dx, 0, 0, 75, 90);
        for (const method of ['fbp', 'osem']) {
            const off = await run(cylAcq, { method: method, corrections: { attenuation: false } });
            ok(ratio(off) < 0.8, method + ' without attenuation correction: central dip (centre/edge ' + ratio(off).toFixed(2) + ')');
            ok(centre(off) < 0.5 * C0, method + ' without attenuation correction: values far too low');
            ok(off.info.notes.some(s => /Attenuation correction is off/.test(s)), 'note explains the missing attenuation correction');
        }
        const noAtt = makeAcq(PET, cyl, { values: cylValues, attenuation: false, scatter: false });
        for (const method of ['fbp', 'osem']) {
            const over = await run(noAtt, { method: method });
            ok(ratio(over) > 1.2, method + ' with attenuation correction but no attenuation: hot centre (' + ratio(over).toFixed(2) + ')');
            ok(over.info.notes.some(s => /over-corrected/.test(s)), 'note explains the over-correction');
        }
    }

    // ----- scatter and randoms switched off: smooth background, values too high
    {
        const both = await run(cylAcq, { method: 'fbp', postFilter: 0 });
        const outside = r => diskMean(r.image, r.n, r.dx, 0, 0, 115, 140) / C0;
        near(outside(both), 0, 0.005, 'fully corrected FBP: the air around the cylinder is empty');
        for (const which of ['scatter', 'randoms']) {
            const r = await run(cylAcq, { method: 'fbp', postFilter: 0, corrections: { [which]: false } });
            ok(centre(r) > 1.05 * C0, which + ' correction off: the cylinder reads too high');
            ok(outside(r) > outside(both) + 0.01, which + ' correction off: activity appears outside the object (' + outside(r).toFixed(3) + ' of the cylinder value)');
            ok(r.info.notes.some(s => new RegExp(which === 'scatter' ? 'Scatter correction is off' : 'Randoms correction is off').test(s)), which + ': note');
        }
    }

    // ----- decay correction: kappaNoDecay gives the frame-average activity
    {
        const late = makeAcq(PET, cyl, { values: cylValues, frames: [{ t0: 3600, t1: 4200 }] });
        const a = await run(late, { method: 'fbp', postFilter: 0 }), b = await run(late, { method: 'fbp', postFilter: 0, corrections: { decay: false } });
        const F = late.frames[0];
        near(centre(a) / C0, 1, 0.02, 'decay-corrected image of a late frame gives the concentration at injection');
        near(centre(b) / centre(a), F.decayIntegral / F.dur, 0.003, 'without decay correction the image is lower by decayIntegral/duration');
        ok(b.info.notes.some(s => /Decay correction is off/.test(s)), 'decay note');
    }

    // ----- normalisation and a dead block
    {
        const dead = makeAcq(PET, cyl, { values: cylValues, variation: 0.1, deadBlock: 5 });
        const nz = []; dead.corrections.norm.forEach((v, k) => { if (v === 0) nz.push(k); });
        ok(nz.length > 0, 'dead block zeroes some LORs');
        const f = await run(dead, { method: 'fbp', postFilter: 0 });
        ok(nz.every(k => f.corrected[k] === 0), 'FBP sets the dead LORs to zero');
        ok(f.info.notes.some(s => /dead detector block/.test(s) && /streaks/.test(s)), 'FBP note on the dead block');
        const o = await run(dead, { method: 'osem', postFilter: 0 });
        near(centre(o) / C0, 1, 0.03, 'OSEM is unaffected on average by a dead block (no data there, nothing modelled)');
        ok(o.info.notes.some(s => /dead detector block/.test(s) && /MLEM and OSEM/.test(s)), 'OSEM note on the dead block');
        const fOff = await run(dead, { method: 'fbp', postFilter: 0, corrections: { normalization: false } });
        const good = await run(makeAcq(PET, cyl, { values: cylValues, variation: 0.1 }), { method: 'fbp', postFilter: 0 });
        ok(diskSD(fOff.image, fOff.n, fOff.dx, 0, 0, 80) > 3 * diskSD(good.image, good.n, good.dx, 0, 0, 80), 'without normalisation the uniform cylinder is no longer uniform');
        ok(fOff.info.notes.some(s => /Normalisation is off/.test(s)), 'normalisation note');
    }

    // ----- TOF converges faster: contrast recovery of a hot disk vs iteration
    {
        const sph = spheresPhantom(PET, 4);
        const vals = Float64Array.from(sph.regions.map(r => r.rel * 5000));
        const a0 = makeAcq(PET, sph, { values: vals }), a1 = makeAcq(PET, sph, { values: vals, tof: true });
        const id = sph.regions.findIndex(r => r.id === 'sphere22'), ang = (3) * Math.PI / 3, cx = 57.2 * Math.cos(ang), cy = 57.2 * Math.sin(ang);
        // background: small disks between the spheres, clear of the cold ones and the lung insert
        const bgm = img => { let s = 0; for (let k = 0; k < 6; k++) { const b = (k + 0.5) * Math.PI / 3; s += diskMean(img, 128, 2.5, 57.2 * Math.cos(b), 57.2 * Math.sin(b), 5); } return s / 6; };
        const rec = img => (diskMean(img, 128, 2.5, cx, cy, 7) / bgm(img) - 1) / 3;
        const o = { method: 'osem', iterations: 6, subsets: 6, postFilter: 0 };
        const r0 = await run(a0, o), r1 = await run(a1, o);
        const c0 = r0.iterations.map(rec), c1 = r1.iterations.map(rec);
        console.log('    22 mm disk contrast recovery by iteration, non-TOF: ' + c0.map(v => v.toFixed(2)).join(' ') + '; TOF: ' + c1.map(v => v.toFixed(2)).join(' '));
        const first = c => { const k = c.findIndex(v => v >= 0.75); return k < 0 ? Infinity : k + 1; };
        ok(first(c1) < first(c0), 'TOF OSEM reaches 75 % contrast recovery in fewer iterations (' + first(c1) + ' vs ' + first(c0) + ')');
        ok(c1[0] > c0[0], 'TOF recovers more contrast after the first iteration');
        ok(sph.regions[id].rel === 4, 'test disk is hot');
    }

    // ----- PSF and positron range in the system model sharpen small objects
    {
        const pt = cylinderPhantom(PET, [{ id: 'rod', x: 60, y: 0, d: 2.5, rel: 40 }]);
        const vals = Float64Array.from(pt.regions.map(r => r.rel * 2000));
        const acq = makeAcq(PET, pt, { values: vals, scatter: false, randoms: false });
        const o = { method: 'osem', iterations: 6, subsets: 12, postFilter: 0 };
        const a = await run(acq, o), b = await run(acq, Object.assign({}, o, { psf: true }));
        const fa = rowFwhm(a.image, 128, 2.5, 60, 0), fb = rowFwhm(b.image, 128, 2.5, 60, 0);
        console.log('    rod FWHM without PSF ' + fa.toFixed(2) + ' mm, with PSF ' + fb.toFixed(2) + ' mm');
        ok(fb < 0.92 * fa, 'resolution modelling narrows the profile of a small rod');
        ok(b.info.psf && b.info.notes.some(s => /Gibbs/.test(s)), 'PSF is reported and noted');
        const fp = await run(acq, { method: 'fbp', psf: true });
        ok(fp.info.notes.some(s => /PSF/.test(s)) && !fp.info.psf, 'FBP notes that it ignores PSF');

        const accO = makeAcq(PET, pt, { values: vals, isotope: 'O15', range: true, blur: false, scatter: false, randoms: false, frames: [{ t0: 0, t1: 120 }] });
        const c = await run(accO, Object.assign({}, o, { matrix: 128 })), d = await run(accO, Object.assign({}, o, { matrix: 128, rangeCorrection: true }));
        const pc = diskMean(c.image, 128, 2.5, 60, 0, 2), pd = diskMean(d.image, 128, 2.5, 60, 0, 2);
        console.log('    O-15 rod peak without range correction ' + (pc / 2000).toFixed(1) + ', with ' + (pd / 2000).toFixed(1) + ' (x background-free units)');
        ok(pd > 1.15 * pc, 'positron range correction raises the peak of a small O-15 rod');
        ok(d.info.rangeCorrection, 'range correction reported');
    }

    // ----- motion: promptsMC is used when motion correction is on
    {
        const hot = cylinderPhantom(PET, [{ id: 'hot', x: 0, y: 0, d: 30, rel: 5 }]);
        const vals = Float64Array.from(hot.regions.map(r => r.rel * 3000));
        const acq = makeAcq(PET, hot, { values: vals, shift: { dx: 20, dy: 0 } });
        const centroidX = r => { let s = 0, w = 0; const h = r.n / 2; for (let iy = 0; iy < r.n; iy++) for (let ix = 0; ix < r.n; ix++) { const v = Math.max(0, r.image[iy * r.n + ix] - 3000); s += v * (ix - h) * r.dx; w += v; } return s / w; };
        const a = await run(acq, { method: 'fbp' }), b = await run(acq, { method: 'fbp', corrections: { motion: true } });
        near(centroidX(a), 20, 2, 'without motion correction the hot disk is where it moved to');
        near(centroidX(b), 0, 1, 'with motion correction the events are moved back (promptsMC)');
        ok(a.info.notes.some(s => /moved during the scan/.test(s)) && b.info.notes.some(s => /Motion correction is on/.test(s)), 'motion notes');
        const c = await run(cylAcq, { method: 'fbp', corrections: { motion: true } });
        ok(c.info.notes.some(s => /no motion to correct/.test(s)), 'motion correction without motion is noted');
    }

    // ----- several frames: 'all', duration-weighted image, a frame before injection
    {
        const frames = [{ t0: -60, t1: 0 }, { t0: 0, t1: 60 }, { t0: 60, t1: 180 }, { t0: 180, t1: 600 }];
        const mult = [0, 3, 2, 1];
        const values = mult.map(m => Float64Array.from(cylValues, v => v * m));
        const acq = makeAcq(PET, cyl, { values: values, frames: frames });
        const prog = [];
        const r = await run(acq, { method: 'fbp', frame: 'all', postFilter: 0 }, { onProgress: f => prog.push(f) });
        ok(r.frames.length === 4 && r.frame === 'all', 'all frames reconstructed');
        near(diskMean(r.frames[0], r.n, r.dx, 0, 0, 50), 0, 1e-6, 'the frame before injection is empty');
        for (let k = 1; k < 4; k++) near(diskMean(r.frames[k], r.n, r.dx, 0, 0, 50) / (C0 * mult[k]), 1, 0.02, 'frame ' + k + ' concentration');
        near(centre(r) / C0, (60 * 3 + 120 * 2 + 420) / 600, 0.02, 'image is the duration-weighted mean of the frames');
        ok(prog.length > 2 && prog.every((v, k) => k === 0 || v >= prog[k - 1]) && prog[prog.length - 1] === 1, 'progress rises to 1');
        ok(r.info.notes.some(s => /hold no counts/.test(s)) && r.info.notes.some(s => /duration-weighted/.test(s)), 'multi-frame notes');
        const e = await run(acq, { method: 'osem', frame: 0 });
        ok(e.image.every(v => v === 0) && e.info.notes.some(s => /before the injection/.test(s)), 'single empty frame: zero image and a note');
        const o = await run(acq, { method: 'osem', frame: 'all', keepIterations: false, postFilter: 0 });
        near(diskMean(o.frames[2], o.n, o.dx, 0, 0, 50) / (2 * C0), 1, 0.03, 'OSEM frame 2 of all');
        let threw = null; try { await run(acq, { frame: 9 }); } catch (err) { threw = err; }
        ok(threw && /does not exist/.test(threw.message), 'a frame that does not exist is a clear error');
    }

    // ----- hooks: onIteration, abort, yielding
    {
        const ks = [];
        const r = await run(cylAcq, { method: 'osem', iterations: 3, keepIterations: false }, { onIteration: (k, img) => ks.push([k, img instanceof Float32Array]) });
        ok(ks.length === 3 && ks.every((v, i) => v[0] === i + 1 && v[1]), 'onIteration(k, image) for every iteration');
        ok(r.iterations === null, 'keepIterations false keeps no iterations');
        let calls = 0, err = null;
        try { await run(cylTof, { method: 'osem' }, { shouldAbort: () => ++calls > 3 }); } catch (e) { err = e; }
        ok(err && err.message === 'aborted', 'shouldAbort rejects with Error("aborted")');
        // the longest stretch without yielding, once projectors are built (warm runs)
        const yf = U.yieldFrame;
        for (const o of [{ method: 'osem' }, { method: 'mlem', iterations: 2 }, { method: 'bp' }, { method: 'osem', matrix: 256, iterations: 1, psf: true }]) {
            await run(cylTof, o);
            let last = Date.now(), gap = 0, n = 0;
            U.yieldFrame = () => { const t = Date.now(); gap = Math.max(gap, t - last); n++; return yf().then(() => { last = Date.now(); }); };
            await run(cylTof, o);
            gap = Math.max(gap, Date.now() - last);
            U.yieldFrame = yf;
            console.log('    longest time between yields, TOF ' + o.method + (o.matrix ? ' ' + o.matrix : '') + ': ' + gap + ' ms (' + n + ' yields)');
            ok(n > 0 && gap < 150, 'TOF ' + o.method + ' yields at least every 150 ms (longest ' + gap + ' ms)');
        }
    }

    // ----- performance (section 9): warm runs at 128 x 128
    {
        const time = async (acq, o) => { await run(acq, o); const t0 = Date.now(); await run(acq, o); return Date.now() - t0; };
        const tO = await time(cylAcq, { method: 'osem', iterations: 4, subsets: 12 });
        const tT = await time(cylTof, { method: 'osem', iterations: 4, subsets: 12 });
        const tF = await time(cylAcq, { method: 'fbp' });
        const tP = await time(cylAcq, { method: 'osem', psf: true });
        const tB = await time(cylTof, { method: 'bp' });
        console.log('    timings 128x128: OSEM 4x12 ' + tO + ' ms (target 500), TOF OSEM ' + tT + ' ms (target 2000), FBP ' + tF + ' ms (target 100), OSEM+PSF ' + tP + ' ms, TOF bp ' + tB + ' ms');
        ok(tO < 1000, 'OSEM 4x12 non-TOF within twice its target');
        ok(tT < 4000, 'TOF OSEM within twice its target');
        ok(tF < 200, 'FBP within twice its target');
    }

    summary('recon');
}

if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
