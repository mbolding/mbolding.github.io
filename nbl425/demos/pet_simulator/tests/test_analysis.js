'use strict';
/* Tests for js/analysis.js. Phantoms and acquisitions are built by hand
   (helpers from test_recon.js) in the shapes ARCHITECTURE.md specifies,
   so these tests do not depend on phantoms.js or engine.js. */
const { load, ok, near, summary } = require('./harness');
const T = require('./test_recon.js');

async function main() {
    const PET = load(['core', 'isotopes', 'scanner', 'recon', 'analysis']);
    const U = PET.util, A = PET.analysis;
    const cyl = T.cylinderPhantom(PET), sph = T.spheresPhantom(PET, 4, 230), brain = T.brainPhantom(PET);
    const bvals = T.brainValues(brain);
    const idx = (ph, id) => ph.regions.findIndex(r => r.id === id);
    const count = m => { let c = 0; for (const v of m) if (v > 0) c++; return c; };

    // ----- region fractions
    for (const m of [64, 128, 256]) {
        const F = A.regionFractions(brain, m), dx = 320 / m;
        // Both grids put pixel floor(n/2) at x = 0, so at the very edge of the
        // FOV they do not cover quite the same strip; everywhere else the
        // fractions are exact.
        let worst = 0;
        for (let iy = 1; iy < m - 1; iy++) for (let ix = 1; ix < m - 1; ix++) { const k = iy * m + ix; let s = 0; for (const f of F) s += f[k]; worst = Math.max(worst, Math.abs(s - 1)); }
        ok(worst < 1e-5, 'fractions add up to 1 in every pixel inside the border, m=' + m);
        let areaErr = 0;
        brain.regions.forEach((r, j) => { if (j === 0) return; const a = U.sum(F[j]) * dx * dx, t = r.pixels * brain.dx * brain.dx; areaErr = Math.max(areaErr, Math.abs(a - t) / Math.max(t, 1)); });
        ok(areaErr < 1e-4, 'each region keeps its area, m=' + m);
    }
    {
        const F = A.regionFractions(cyl, 256), w = idx(cyl, 'water');
        ok(F[w].every((v, k) => v === (cyl.label[k] === w ? 1 : 0)), 'at m = 256 the fractions are the labels');
        ok(A.regionFractions(cyl, 128) === A.regionFractions(cyl, 128), 'fractions are cached');
        const G = A.regionFractions(cyl, 128)[w], m = 128, c = 64;
        let asym = 0;
        for (let d = 1; d < 60; d++) asym = Math.max(asym, Math.abs(G[c * m + c + d] - G[c * m + c - d]), Math.abs(G[(c + d) * m + c] - G[(c - d) * m + c]));
        ok(asym < 1e-6, 'a centred disk gives symmetric fractions (pixel centres line up with the phantom raster)');
        const edge = G.filter(v => v > 0.01 && v < 0.99).length;
        ok(edge > 50, 'edge pixels are partly filled (' + edge + ')');
    }

    // ----- ROI definitions
    {
        const kinds = [[cyl, 'cylinder'], [sph, 'spheres'], [brain, 'brain']];
        kinds.forEach(([ph, k]) => ok(A.phantomKind(ph) === k, 'phantom kind ' + k));
        const D = A.roiDefs(brain), ids = D.map(d => d.id), get = id => D.find(d => d.id === id);
        ['cortex', 'striatum', 'putamen_l', 'putamen_r', 'caudate', 'cerebellum', 'white_matter', 'whole_brain', 'cereb_gm', 'wm', 'gm_occipital', 'putamen_l_post']
            .forEach(id => ok(ids.indexOf(id) >= 0, 'brain ROI ' + id));
        ok(new Set(ids).size === ids.length, 'ROI ids are unique');
        ok(get('cortex').regions.join() === 'gm_frontal,gm_temporal,gm_occipital', 'cortex = frontal + temporal + occipital');
        ok(get('striatum').regions.length === 6 && get('putamen_l').regions.join() === 'putamen_l_ant,putamen_l_post', 'striatum and putamen composites');
        ['cereb_gm', 'wm', 'gm_occipital', 'cerebellum', 'white_matter', 'whole_brain'].forEach(id => ok(get(id).reference === true, id + ' is offered as a reference'));
        ok(!get('cortex').reference && !get('striatum').reference, 'targets are not references');
        ok(ids.indexOf('scalp') < 0 && ids.indexOf('air') < 0, 'regions not marked roi are not offered alone');
        ok(D.every(d => d.name && d.color && Array.isArray(d.regions)), 'every ROI has a name, a colour and regions');

        const Dc = A.roiDefs(cyl), centre = Dc.find(d => d.id === 'centre');
        ok(centre && centre.circle && centre.circle.r === 70 && Dc.some(d => d.id === 'whole'), 'cylinder: centre disk and whole cylinder');
        const Ds = A.roiDefs(sph), sid = Ds.map(d => d.id);
        ok([10, 13, 17, 22, 28, 37].every(d => sid.indexOf('sphere' + d) >= 0) && sid.indexOf('background') >= 0, 'spheres: each sphere and the background');
        ok(Ds.find(d => d.id === 'background').reference, 'sphere background is a reference');

        // rods: one region per rod (named by size) are grouped; one region per group is offered as is
        const rodsA = T.buildPhantom(PET, { id: 'rods', name: 'Rods', regions: [
            { id: 'water', name: 'Water', tissue: 'water', mu: 0.0096, rel: 0, roi: false, inside: (x, y) => x * x + y * y < 100 * 100 },
            { id: 'rod6a', name: '6 mm rod', tissue: 'water', mu: 0.0096, rel: 1, roi: false, inside: (x, y) => (x - 30) ** 2 + y * y < 9 },
            { id: 'rod6b', name: '6 mm rod', tissue: 'water', mu: 0.0096, rel: 1, roi: false, inside: (x, y) => (x - 42) ** 2 + y * y < 9 },
            { id: 'rod10a', name: '10 mm rod', tissue: 'water', mu: 0.0096, rel: 1, roi: false, inside: (x, y) => (x + 40) ** 2 + y * y < 25 }] });
        const Dr = A.roiDefs(rodsA);
        ok(Dr.some(d => d.id === 'rods_6mm' && d.regions.length === 2) && Dr.some(d => d.regions.join() === 'rod10a'), 'rods: grouped by size');
        const pts = T.buildPhantom(PET, { id: 'point', name: 'Line sources', regions: [
            { id: 'src0', name: 'Source at 0 mm', tissue: 'water', mu: 0, rel: 1, roi: false, inside: (x, y) => Math.abs(x) < 0.6 && Math.abs(y) < 0.6 },
            { id: 'src50', name: 'Source at 50 mm', tissue: 'water', mu: 0, rel: 1, roi: false, inside: (x, y) => Math.abs(x - 50) < 0.6 && Math.abs(y) < 0.6 }] });
        ok(A.roiDefs(pts).map(d => d.id).join() === 'src0,src50', 'point: each source');
    }

    // ----- masks and statistics
    {
        const m = 128, dx = 2.5;
        const c = A.roiMask(cyl, m, 'centre');
        near(count(c) * dx * dx / (Math.PI * 70 * 70), 1, 0.02, 'centre disk has the area of a 70 mm radius circle');
        const e = A.roiMask(cyl, m, 'centre', { erode: 2 });
        ok(count(e) < count(c) && e.every((v, k) => !v || c[k]), 'erosion shrinks the mask inside the original');
        near(Math.sqrt(count(e) * dx * dx / Math.PI), 70 - 2 * dx, 1.5, 'two eroded pixels take about 5 mm off the radius');
        ok(A.roiMask(cyl, m, 'centre') === c, 'masks are cached');
        const pl = A.roiMask(brain, 64, 'putamen_l_post');
        ok(count(pl) > 0, 'a small region still gets pixels at m = 64');
        let threw = false; try { A.roiMask(brain, m, 'hippocampus'); } catch (err) { threw = /Unknown ROI/.test(err.message); }
        ok(threw, 'unknown ROI is a clear error');
        const ctx = A.roiMask(brain, m, 'cortex'), F = A.regionFractions(brain, m);
        ok(ctx.every((v, k) => !v || F[idx(brain, 'gm_frontal')][k] + F[idx(brain, 'gm_temporal')][k] + F[idx(brain, 'gm_occipital')][k] >= 0.5 - 1e-6), 'composite mask = union of its regions at threshold 0.5');

        const img = new Float32Array(16).map((v, k) => k), mask = new Float32Array(16); mask[1] = mask[2] = mask[3] = 1;
        const st = A.roiStats(img, mask);
        near(st.mean, 2, 1e-12, 'roiStats mean'); near(st.sd, Math.sqrt(2 / 3), 1e-12, 'roiStats SD (population)');
        ok(st.min === 1 && st.max === 3 && st.nPix === 3 && Math.abs(st.cov - st.sd / 2) < 1e-12, 'roiStats min, max, nPix, cov');
        ok(isNaN(A.roiStats(img, new Float32Array(16)).mean), 'empty mask gives NaN');
        const cm = A.circleMask(128, 320, 20, -10, 15), cs = A.circleMask(128, 320, 20, -10, 15, true);
        near(count(cm) * 6.25 / (Math.PI * 225), 1, 0.06, 'circle mask area');
        near(U.sum(cs) * 6.25 / (Math.PI * 225), 1, 0.005, 'soft circle mask area');
    }

    // ----- profiles, FWHM, point resolution
    {
        const gauss = (m, x0, y0, fx, fy) => {
            const dx = 320 / m, h = m / 2, sx = fx / 2.3548, sy = fy / 2.3548, img = new Float32Array(m * m);
            for (let iy = 0; iy < m; iy++) for (let ix = 0; ix < m; ix++) {
                const x = (ix - h) * dx - x0, y = (iy - h) * dx - y0;
                img[iy * m + ix] = 1000 * Math.exp(-0.5 * (x * x / (sx * sx) + y * y / (sy * sy)));
            }
            return img;
        };
        const g = gauss(256, 0, 0, 8, 8), p = A.profile(g, 256, 320, -30, 0, 30, 0);
        ok(p.s.length > 40 && Math.abs(p.s[p.s.length - 1] - 60) < 1e-9, 'profile samples the segment');
        near(A.fwhm(p.s, p.v), 8, 0.15, 'FWHM of a Gaussian profile');
        near(A.fwhm(p.s, p.v, 0.1), 8 * Math.sqrt(Math.log(10) / Math.log(2)), 0.3, 'FWTM with level 0.1');
        ok(isNaN(A.fwhm(Float64Array.from([0, 1, 2]), Float64Array.from([1, 1, 1]))), 'FWHM of a flat profile is NaN');
        for (const [m, tol] of [[256, 0.04], [128, 0.08]]) {
            const a = A.pointResolution(gauss(m, 50, 0, 6, 9), m, 320, 49, 1);
            near(a.radial / 6, 1, tol, 'radial FWHM at (50, 0), m=' + m + ' (' + a.radial.toFixed(2) + ' mm)');
            near(a.tangential / 9, 1, tol, 'tangential FWHM at (50, 0), m=' + m + ' (' + a.tangential.toFixed(2) + ' mm)');
            const b = A.pointResolution(gauss(m, 0, -100, 9, 6), m, 320, 0, -100);
            near(b.radial / 6, 1, tol, 'radial is along y for a point at (0, -100), m=' + m);
            near(b.tangential / 9, 1, tol, 'tangential is along x for a point at (0, -100), m=' + m);
        }
        // end to end: point sources in air, detector blur with parallax; FBP ramp at 256
        const pts = T.buildPhantom(PET, { id: 'point', name: 'Line sources', axialLength: 50, regions: [0, 50, 100].map(x => (
            { id: 'src' + x, name: 'Source at ' + x + ' mm', tissue: 'water', mu: 0, rel: 1, inside: (px, py) => Math.abs(px - x) < 0.6 && Math.abs(py) < 0.6 })) });
        const acq = T.makeAcq(PET, pts, { values: Float64Array.from(pts.regions.map(r => r.rel * 1e6)), scatter: false, randoms: false, attenuation: false, variation: 0 });
        const r = await PET.recon.run(acq, { method: 'fbp', filter: 'ramp', matrix: 256, postFilter: 0 });
        const res = [0, 50, 100].map(x => A.pointResolution(r.image, 256, 320, x, 0));
        console.log('    FBP point resolution (radial / tangential, mm): ' + res.map((q, k) => [0, 50, 100][k] + ' mm: ' + q.radial.toFixed(2) + ' / ' + q.tangential.toFixed(2)).join(', '));
        ok(res.every(q => q.radial > 2 && q.radial < 7 && q.tangential > 2 && q.tangential < 7), 'reconstructed point sources have plausible FWHM');
        ok(res[2].radial > res[0].radial + 0.5 && res[2].radial > res[2].tangential, 'radial resolution degrades off centre (parallax)');
    }

    // ----- truth image
    {
        const acq = T.makeAcq(PET, brain, { values: [bvals, Float64Array.from(bvals, v => 2 * v)], frames: [{ t0: 0, t1: 300 }, { t0: 300, t1: 900 }] });
        const m = 128, dx = 2.5, t0 = A.truthImage(acq, 0, m, brain), ta = A.truthImage(acq, 'all', m, brain);
        let want = 0; brain.regions.forEach((r, k) => { want += bvals[k] * r.pixels * brain.dx * brain.dx; });
        near(U.sum(t0) * dx * dx / want, 1, 1e-5, 'truth image holds the right total');
        const wm = A.roiStats(t0, A.roiMask(brain, m, 'wm', { threshold: 0.999 })).mean;
        near(wm, bvals[idx(brain, 'wm')], 1e-3, 'truth inside white matter is its value');
        near(U.sum(ta) / U.sum(t0), (300 * 1 + 600 * 2) / 900, 1e-5, "frame 'all' is the duration-weighted mean");
    }

    // ----- GTM partial-volume correction
    {
        const m = 128, dx = 2.5, F = A.regionFractions(brain, m), fw = 6;
        const img = new Float32Array(m * m);
        brain.regions.forEach((r, k) => { const b = U.gaussBlur2D(F[k], m, m, fw / dx); for (let j = 0; j < img.length; j++) img[j] += bvals[k] * b[j]; });
        const g = A.gtm(img, m, 320, brain, fw, { truth: bvals });
        const byId = id => g.rois.find(r => r.id === id);
        let worst = 0;
        g.rois.filter(r => !r.composite).forEach(r => { worst = Math.max(worst, Math.abs(r.corrected - r.truth) / 15000); });
        ok(worst < 1e-3, 'GTM recovers every region value from a blurred noise-free image (worst ' + worst.toExponential(1) + ' of max)');
        const pp = byId('caudate_l');
        ok(Math.abs(pp.observed - pp.truth) > 0.1 * pp.truth, 'partial volume biases the small caudate ROI (observed ' + pp.observed.toFixed(0) + ' vs ' + pp.truth + ')');
        const st = byId('striatum');
        ok(st && st.composite && Math.abs(st.corrected - st.truth) < 1e-3 * st.truth, 'composite (striatum) corrected value is the volume-weighted mean');
        ok(g.rois.every(r => r.id !== 'air'), 'air is solved for but not reported');
        ok(g.matrix.length === g.ids.length && g.matrix[0].length === g.ids.length, 'the transfer matrix is returned');

        // end to end: OSEM of noise-free data with detector blur; GTM moves small regions toward the truth
        const acq = T.makeAcq(PET, brain, { values: bvals });
        const r = await PET.recon.run(acq, { method: 'osem', iterations: 6, subsets: 12, postFilter: 4 });
        const g2 = A.gtm(r.image, m, 320, brain, 6.5, { truth: bvals });
        const e = id => { const q = g2.rois.find(x => x.id === id); return [Math.abs(q.observed - q.truth) / q.truth, Math.abs(q.corrected - q.truth) / q.truth]; };
        const report = ['striatum', 'cortex', 'putamen_l_post', 'cereb_gm'].map(id => id + ' ' + e(id).map(v => (100 * v).toFixed(1) + '%').join(' -> '));
        console.log('    GTM on OSEM, error before -> after: ' + report.join(', '));
        ['striatum', 'cortex', 'putamen_l_post'].forEach(id => ok(e(id)[1] < e(id)[0], 'GTM reduces the partial-volume error of ' + id));
    }

    // ----- NEMA image quality
    {
        const m = 128, dx = 2.5, C = 5000;
        const vals = Float64Array.from(sph.regions.map(r => r.rel * C));
        const acq = T.makeAcq(PET, sph, { values: vals, frames: [{ t0: 0, t1: 600 }] });
        const truth = A.truthImage(acq, 0, m, sph);
        const q = A.nemaIQ(truth, m, 320, sph);
        ok(q.spheres.length === 6 && q.spheres.map(s => s.d).join() === '10,13,17,22,28,37', 'six spheres found with their diameters');
        ok(q.spheres.filter(s => s.kind === 'hot').length === 4 && q.spheres.filter(s => s.kind === 'cold').length === 2, 'four hot, two cold');
        ok(q.bgRois.length === 12, 'twelve background ROIs');
        const cen = A.centroids(sph);
        ok(q.bgRois.every(p => q.spheres.every(s => Math.hypot(p.x - s.x, p.y - s.y) >= s.d / 2 + 18.5)) &&
            q.bgRois.every(p => Math.hypot(p.x - cen[idx(sph, 'lung')].x, p.y - cen[idx(sph, 'lung')].y) > 25.5 + 18.5), 'background ROIs avoid the spheres and the lung insert');
        near(q.bgMean / C, 1, 0.001, 'background mean of the true image');
        ok(q.bgVariability < 0.002, 'no background variability without noise');
        const s22 = q.spheres.find(s => s.d === 22);
        near(s22.trueContrast, 4, 1e-9, 'true contrast is the activity ratio');
        const hot0 = q.spheres.filter(s => s.kind === 'hot');
        ok(hot0.every((s, k) => s.recovery > 0.7 && s.recovery < 1.02 && (k === 0 || s.recovery > hot0[k - 1].recovery)),
            'true image on 2.5 mm pixels: recovery below 1 only from the pixel grid, rising with size (' + hot0.map(s => s.recovery.toFixed(2)).join(', ') + ')');
        const q256 = A.nemaIQ(A.truthImage(acq, 0, 256, sph), 256, 320, sph);
        ok(q256.spheres.filter(s => s.kind === 'hot').every(s => s.recovery > 0.85 && s.recovery < 1.02), 'true image on 1.25 mm pixels: hot recovery near 1 (' +
            q256.spheres.filter(s => s.kind === 'hot').map(s => s.recovery.toFixed(2)).join(', ') + ')');
        ok(q.spheres.filter(s => s.kind === 'cold').every(s => s.recovery > 0.9), 'true image: cold contrast near 1');
        ok(q.lung && q.lung.residual < 0.01, 'lung insert residual of the true image is about 0');

        const blurred = U.gaussBlur2D(truth, m, m, 8 / dx), qb = A.nemaIQ(blurred, m, 320, sph);
        const hot = qb.spheres.filter(s => s.kind === 'hot');
        console.log('    NEMA on an 8 mm blur: hot ' + hot.map(s => s.d + ' mm ' + (100 * s.recovery).toFixed(0) + '%').join(', ') + '; cold ' +
            qb.spheres.filter(s => s.kind === 'cold').map(s => s.d + ' mm ' + (100 * s.recovery).toFixed(0) + '%').join(', ') + '; lung residual ' + (100 * qb.lung.residual).toFixed(1) + '%');
        ok(hot.every((s, k) => k === 0 || s.recovery > hot[k - 1].recovery), 'blurred: hot recovery rises with sphere size');
        ok(hot[0].recovery < 0.6, 'blurred: the 10 mm sphere loses most of its contrast');
        ok(qb.lung.residual > q.lung.residual, 'blurred: spill-in raises the lung residual');
        const rng = U.rng(5), noisy = blurred.map(v => v * (1 + 0.2 * rng.randn()));
        const qn = A.nemaIQ(noisy, m, 320, sph);
        ok(qn.bgVariability > 0.005 && qn.spheres[0].variability >= qn.spheres[5].variability, 'noise gives background variability, larger for small ROIs');
        ok(A.nemaIQ(truth, m, 320, cyl).spheres.length === 0 && A.nemaIQ(truth, m, 320, brain).spheres.length === 0, 'a phantom without spheres gives no spheres');
    }

    // ----- TACs and SUV
    {
        const m = 128, F = A.regionFractions(brain, m), frames = [{ t0: 0, t1: 60 }, { t0: 60, t1: 180 }, { t0: 180, t1: 600 }];
        const images = [1, 2, 3].map(f => { const img = new Float32Array(m * m); brain.regions.forEach((r, k) => { for (let j = 0; j < img.length; j++) img[j] += f * bvals[k] * F[k][j]; }); return img; });
        const t = A.tacs(images, brain, m, ['cereb_gm', 'striatum'], frames, { threshold: 0.999 });
        ok(t.t.join() === '30,120,390', 'TAC times are frame mid-times');
        ok([0, 1, 2].every(k => Math.abs(t.values.cereb_gm[k] - (k + 1) * 8000) < 1), 'TAC values follow the frames');
        ok(t.values.striatum.length === 3, 'composite TAC');
        const suv = A.suvImage(Float32Array.from([5000, 0]), 185e6, 70);
        near(suv[0], 5000 * 70000 / 185e6, 1e-6, 'SUV = C x weight(g) / dose');
    }

    summary('analysis');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
