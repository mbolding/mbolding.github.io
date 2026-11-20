'use strict';
/* Tests for js/engine.js. The engine's inputs come from kinetics.js,
   phantoms.js and dsl.js, which may not exist yet, so everything is built
   here by hand in exactly the shapes ARCHITECTURE.md specifies: a Program
   (7.5), a Phantom (6) and a TAC set (5.2, decay-corrected Bq/mL). */
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner', 'engine']);
const U = PET.util, S = PET.scanner, G = S.geom, E = PET.engine, CAL = E.CAL;
const NLOR = G.nA * G.nR;

/* ---------- input builders ---------- */
const N = 256, FOV = 320, DX = 1.25, H = 128;
function makePhantom(id, regions, labelAt, axialLength, outsideFraction) {
    const label = new Uint8Array(N * N), mu = new Float32Array(N * N), pix = new Float64Array(regions.length);
    for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) {
        const p = iy * N + ix, r = labelAt((ix - H) * DX, (iy - H) * DX);
        label[p] = r; mu[p] = regions[r].mu; pix[r]++;
    }
    regions.forEach((rg, r) => { rg.pixels = pix[r]; rg.volume = pix[r] * DX * DX * axialLength / 1000; rg.roi = r > 0; });
    return { id, name: id, description: '', kind: 'solution', n: N, fov: FOV, dx: DX, label, regions, mu,
        axialLength, outsideFraction, condition: null, landmarks: [], notes: '' };
}
const R = (id, mu, tissue, rel) => ({ id, name: id, color: '#888', mu, tissue, rel: rel || 0 });
function cylinder(radius) {
    return makePhantom('cylinder', [R('air', 0, 'air'), R('water', 0.0096, 'water', 1)],
        (x, y) => (x * x + y * y <= radius * radius ? 1 : 0), 200, 0);
}
function hotCold() {           // water cylinder with a hot disk (4:1) and a cold disk
    return makePhantom('hotcold', [R('air', 0, 'air'), R('water', 0.0096, 'water', 1), R('hot', 0.0096, 'water', 4), R('cold', 0.0096, 'water', 0)],
        (x, y) => {
            if (x * x + y * y > 100 * 100) return 0;
            if ((x - 50) ** 2 + y * y <= 15 * 15) return 2;
            if ((x + 40) ** 2 + (y - 30) ** 2 <= 20 * 20) return 3;
            return 1;
        }, 200, 0);
}
function rods(points, radius) {          // small hot rods in air (sharp sinusoids that interpolate well)
    return makePhantom('rods', [R('air', 0, 'air'), R('rod', 0, 'water', 1)],
        (x, y) => (points.some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 <= radius * radius) ? 1 : 0), 50, 0);
}
function lineSources(points, medium) {     // 1-pixel sources, in air or in a 200 mm water cylinder
    return makePhantom('point', [R('air', 0, 'air'), R('source', 0, 'water', 1), R('water', 0.0096, 'water', 0)],
        (x, y) => {
            for (const [px, py] of points) if (Math.abs(x - px) < DX / 2 && Math.abs(y - py) < DX / 2) return 1;
            if (medium === 'water' && x * x + y * y <= 100 * 100) return 2;
            return 0;
        }, 50, 0);
}
/* Synthetic head: 150 x 190 mm ellipse, 6 mm skull around soft tissue. With
   sectors > 0 the brain is cut into angular sectors plus a core, so that a
   kinetics-like phantom has many regions with different curves. */
function head(sectors) {
    const a = 75, b = 95, t = 6, regions = [R('air', 0, 'air'), R('skull', 0.0151, 'bone'), R('brain', 0.0099, 'gm', 1)];
    for (let q = 0; q < (sectors || 0); q++) regions.push(R('sector' + q, 0.0099, 'gm', 1));
    return makePhantom('head', regions, (x, y) => {
        if ((x / a) ** 2 + (y / b) ** 2 > 1) return 0;
        if ((x / (a - t)) ** 2 + (y / (b - t)) ** 2 > 1) return 1;
        if (!sectors || (x / 40) ** 2 + (y / 55) ** 2 <= 1) return 2;
        const ang = Math.atan2(y, x) + Math.PI;
        return 3 + Math.min(sectors - 1, Math.floor(ang / (2 * Math.PI) * sectors));
    }, 150, 0.3);
}
/* TAC set on a 2 s grid from injection to tEnd: fns[r](t) -> Bq/mL (decay corrected). */
function tacSet(phantom, tEnd, fns) {
    const dt = 2, nt = Math.ceil(tEnd / dt) + 1, t = new Float64Array(nt);
    for (let k = 0; k < nt; k++) t[k] = k * dt;
    const regions = phantom.regions.map((rg, r) => {
        const c = new Float64Array(nt), f = fns[r];
        if (f) for (let k = 0; k < nt; k++) c[k] = f(t[k]);
        return c;
    });
    return { t, dt, plasma: new Float64Array(nt), suvScale: 1, regions };
}
const constTACs = (ph, tEnd, conc) => tacSet(ph, tEnd, ph.regions.map((rg, r) => (r === 0 ? null : () => conc * rg.rel)));
function program(o) {
    o = o || {};
    const frames = o.frames || [{ t0: 2700, t1: 3300 }];
    return { ok: true, name: 'test', source: '', params: [], lets: {}, tracer: o.tracer === undefined ? 'FDG' : o.tracer,
        isotope: o.isotope || 'F18', dose: o.dose === undefined ? 185e6 : o.dose, weight: 70, frames,
        scanStart: frames[0].t0, scanEnd: frames[frames.length - 1].t1, dynamic: frames.length > 1,
        energy: { lo: o.lo || 435, hi: o.hi || 650 }, coincidence: o.tau || 4.5e-9,
        tof: { on: !!o.tof, ctr: o.ctr || 400e-12 }, acqMode: o.mode || '3D', warnings: [], stats: {} };
}
const sim = (prog, ph, tacs, physics, opts) => E.simulate(prog, ph, tacs, { physics: physics || {} }, opts || {});
const ALL_OFF = { attenuation: false, scatter: false, randoms: false, noise: false, positronRange: false, detectorBlur: false, detector: { variation: 0 } };
function relL1(a, b) { let d = 0, s = 0; for (let k = 0; k < a.length; k++) { d += Math.abs(a[k] - b[k]); s += Math.abs(b[k]); } return d / s; }
function maxOf(a) { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; }
const fmtM = x => (x / 1e6).toFixed(3) + ' M';

/* Shared inputs: the calibration head at 10 kBq/mL, the 200 mm cylinder. */
const HEAD = head(0), HEAD_TACS = constTACs(HEAD, 3400, 10000);
const CYL = cylinder(100), CYL_TACS = constTACs(CYL, 3400, 10000);

(async function main() {
    /* ---------- API ---------- */
    {
        const d = E.physicsDefaults();
        ok(d.attenuation && d.scatter && d.randoms && d.noise && d.positronRange && d.detectorBlur, 'physics switches default on');
        ok(d.motion.on === false && d.motion.kind === 'step' && d.motion.dx === 6 && d.motion.at === 0.5 && d.motion.period === 5, 'motion defaults');
        ok(d.muMap.model === 'ct' && d.muMap.dx === 0 && d.detector.variation === 0.06 && d.detector.deadBlock === -1 && d.seed === 1, 'muMap, detector, seed defaults');
        d.motion.dx = 99;
        ok(E.physicsDefaults().motion.dx === 6, 'physicsDefaults returns a fresh object');
        ok(CAL.MODE_2D.sens === 0.2 && CAL.MODE_2D.scatter === 0.35 && CAL.MODE_2D.singles === 0.4, '2D factors in CAL');
        ok(CAL.SENS > 0 && CAL.SCATTER > 0 && CAL.RANDOMS > 0, 'calibration constants exported');
    }

    /* ---------- kappa: trues / kappa = P C (the reconstruction contract) ---------- */
    {
        const C0 = 5000, cyl = cylinder(100), tacs = constTACs(cyl, 1000, C0);
        const prog = program({ frames: [{ t0: 0, t1: 600 }] });
        const acq = await sim(prog, cyl, tacs, ALL_OFF);
        const F = acq.frames[0], iso = PET.isotopes.get('F18');
        const img = new Float32Array(N * N);
        for (let p = 0; p < img.length; p++) img[p] = cyl.label[p] === 1 ? C0 : 0;
        // with the detector blur off the engine still band-limits the raster by one pixel
        const ak = S.isoKernel(FOV / N, FOV / N);
        const PC = S.plainProjector(N, FOV).forward(U.convolve2D(img, N, N, ak.kernel, ak.size));
        let worst = 0, mx = maxOf(PC);
        for (let l = 0; l < NLOR; l++) if (PC[l] > 0.05 * mx) worst = Math.max(worst, Math.abs(F.expected.trues[l] / F.kappa / PC[l] - 1));
        ok(worst < 0.002, 'unattenuated, unblurred trues / kappa = P C per LOR (worst ' + (100 * worst).toFixed(3) + ' %)');
        near(U.sum(F.prompts) / U.sum(F.expected.trues), 1, 1e-6, 'noise off and nothing else: prompts are the trues');
        near(F.decayIntegral, PET.isotopes.decayIntegral(iso, 0, 600), 1e-9, 'decayIntegral is the isotope decay integral');
        near(F.kappa / F.kappaNoDecay, F.decayIntegral / F.dur, 1e-12, 'kappa / kappaNoDecay = decayIntegral / duration');
        near(F.kappa, acq.stats.kappa0 * iso.betaPlus * F.decayIntegral, 1e-15, 'kappa = kappa0 betaPlus decayIntegral');
        near(acq.stats.kappa0, CAL.SENS * S.energy.photopeakAcceptance(435, 650) ** 2 * G.sliceThickness * G.dr / (1000 * G.nA), 1e-18,
            'kappa0 = SENS eps_E^2 thickness dr / (1000 nA)');
        near(F.truth.regionMean[1], C0, 1e-6 * C0, 'truth region mean of a constant curve');
        ok(F.truth.regionMean[0] === 0, 'air has no activity');
        const blurred = await sim(prog, cyl, tacs, Object.assign({}, ALL_OFF, { detectorBlur: true }));
        near(U.sum(blurred.frames[0].expected.trues) / F.kappa / U.sum(PC), 1, 0.01, 'with detector blur the total still matches kappa P C');
        const tof = await sim(program({ frames: [{ t0: 0, t1: 600 }], tof: true }), cyl, tacs, ALL_OFF);
        near(U.sum(tof.frames[0].prompts) / F.kappa / U.sum(PC), 1, 0.01, 'TOF bins sum to the same trues');
        const emis = E.frameEmission(prog, cyl, tacs, 0, 600);
        near(emis[H * N + H], iso.betaPlus * C0 * F.decayIntegral, 1e-3 * emis[H * N + H], 'frameEmission gives decays per mL in the frame');
    }

    /* ---------- calibration on the synthetic head (fdg_static-like) ---------- */
    let headBase;
    {
        const acq = headBase = await sim(program(), HEAD, HEAD_TACS, { noise: false });
        const c = acq.frames[0].counts;
        console.log('    head 3D: trues ' + fmtM(c.trues) + ', SF ' + c.sf.toFixed(3) + ', R/T ' + c.rt.toFixed(3) + ', NEC ' + fmtM(c.nec) +
            ', prompts ' + fmtM(c.prompts));
        ok(c.trues > 1.5e6 && c.trues < 2.5e6, 'head: 1.5 to 2.5 M trues in the slice');
        ok(c.sf > 0.30 && c.sf < 0.40, 'head: scatter fraction 0.30 to 0.40 (' + c.sf.toFixed(3) + ')');
        ok(c.rt > 0.2 && c.rt < 0.3, 'head: randoms/trues about 0.25 (' + c.rt.toFixed(3) + ')');
        near(c.nec, c.trues * c.trues / (c.trues + c.scatter + c.randoms), 1e-6 * c.nec, 'NEC = T^2/(T+S+R)');
        near(c.rf, c.randoms / (c.trues + c.scatter + c.randoms), 1e-12, 'RF is the randoms share of the prompts');
        near(acq.stats.scatterFraction, c.sf, 1e-12, 'stats.scatterFraction');
        ok(acq.stats.sliceThickness === G.sliceThickness, 'stats.sliceThickness');
        ok(acq.totals.trues === c.trues && acq.totals.nec > 0, 'totals');
        ok(acq.geom.nA === G.nA && acq.geom.nR === G.nR && acq.geom.nT === 1 && acq.geom.tof === false && acq.geom.dr === 2, 'geom block');
        ok(acq.frames[0].prompts.length === NLOR && acq.frames[0].delayed.length === NLOR && acq.frames[0].scatterEst.length === NLOR &&
            acq.frames[0].randomsSingles.length === NLOR && acq.frames[0].promptsMC === null, 'frame arrays (non-TOF, no motion)');
        ok(acq.corrections.norm.length === NLOR && acq.corrections.acf.length === NLOR && acq.corrections.muCorr.length === N * N && acq.muTrue === HEAD.mu, 'corrections block');
        ok(acq.isotope === 'F18' && acq.tracer === 'FDG' && acq.dose === 185e6 && acq.seed === 1 && acq.phantomId === 'head', 'header fields');
        ok(Array.isArray(acq.warnings) && acq.warnings.length === 0, 'no warnings for a normal scan');
    }
    {
        const acq = await sim(program(), CYL, CYL_TACS, { noise: false });
        const c = acq.frames[0].counts;
        console.log('    200 mm cylinder 3D: trues ' + fmtM(c.trues) + ', SF ' + c.sf.toFixed(3));
        ok(c.sf > 0.30 && c.sf < 0.40, '200 mm water cylinder: SF 0.30 to 0.40 in 3D (' + c.sf.toFixed(3) + ')');
    }
    {
        const pts = [[0, 0], [50, 0], [100, 0], [0, -100]];
        const air = lineSources(pts, 'air'), wat = lineSources(pts, 'water');
        const a1 = await sim(program(), air, constTACs(air, 3400, 1e6), { noise: false });
        const a2 = await sim(program(), wat, constTACs(wat, 3400, 1e6), { noise: false });
        ok(a1.frames[0].counts.sf < 0.01, 'line sources in air: SF near 0 (' + a1.frames[0].counts.sf + ')');
        // Every LOR misses the (empty) mu map, so the sources' own trues sit in the
        // "tails"; the capped tail fit keeps the scatter estimate negligible.
        const ws = (await sim(program(), air, constTACs(air, 3400, 1e6), {})).frames[0];
        ok(ws.scatterScale <= CAL.TAIL_SCALE_MAX && U.sum(ws.scatterEst) < 0.01 * ws.counts.trues, 'line sources in air: scatter correction does nothing');
        ok(a2.frames[0].counts.sf > 0.15, 'line sources in a water cylinder: scatter appears (SF ' + a2.frames[0].counts.sf.toFixed(3) + ')');
    }

    /* ---------- 2D mode ---------- */
    {
        const a2 = await sim(program({ mode: '2D' }), HEAD, HEAD_TACS, { noise: false });
        const c2 = a2.frames[0].counts, c3 = headBase.frames[0].counts;
        console.log('    head 2D: trues ' + fmtM(c2.trues) + ', SF ' + c2.sf.toFixed(3) + ', R/T ' + c2.rt.toFixed(3));
        ok(c2.sf > 0.10 && c2.sf < 0.16, '2D: SF falls to about 0.10 to 0.15 (' + c2.sf.toFixed(3) + ')');
        near(c2.trues / c3.trues, 0.2, 1e-6, '2D: trues x 0.2');
        near(c2.randoms / c3.randoms, 0.16, 1e-6, '2D: randoms x 0.16 (singles x 0.4)');
        const c2c = (await sim(program({ mode: '2D' }), CYL, CYL_TACS, { noise: false })).frames[0].counts;
        ok(c2c.sf > 0.10 && c2c.sf < 0.17, '2D cylinder SF roughly 0.10 to 0.15 (' + c2c.sf.toFixed(3) + ')');
    }

    /* ---------- energy window ---------- */
    {
        const c435 = headBase.frames[0].counts;
        const c460 = (await sim(program({ lo: 460 }), HEAD, HEAD_TACS, { noise: false })).frames[0].counts;
        const c480 = (await sim(program({ lo: 480 }), HEAD, HEAD_TACS, { noise: false })).frames[0].counts;
        const c350 = (await sim(program({ lo: 350 }), HEAD, HEAD_TACS, { noise: false })).frames[0].counts;
        console.log('    energy window: SF 350 keV ' + c350.sf.toFixed(3) + ', 435 keV ' + c435.sf.toFixed(3) + ', 460 keV ' + c460.sf.toFixed(3) +
            ', 480 keV ' + c480.sf.toFixed(3) + '; trues 460/435 ' + (c460.trues / c435.trues).toFixed(3) + ', 480/435 ' + (c480.trues / c435.trues).toFixed(3));
        ok(c460.sf < c435.sf && c480.sf < c460.sf, 'raising the lower level lowers the scatter fraction');
        ok(c460.trues < c435.trues && c460.trues / c435.trues > 0.9, 'and costs a few trues (460 keV)');
        ok(c480.trues / c435.trues > 0.7 && c480.trues / c435.trues < 0.95, 'and more at 480 keV');
        ok(c350.sf > c435.sf, 'a 350 keV lower level lets more scatter in');
        ok(c350.randoms > c435.randoms && c480.randoms < c435.randoms, 'singles, and so randoms, follow the energy window');
    }

    /* ---------- coincidence window ---------- */
    {
        const centre = lineSources([[0, 0]], 'air'), edge = lineSources([[110, 0]], 'air');
        const tC = constTACs(centre, 3400, 1e6), tE = constTACs(edge, 3400, 1e6);
        const ratio = async (ph, tc) => (await sim(program({ tau: 1e-9 }), ph, tc, { noise: false })).frames[0].counts.trues /
            (await sim(program(), ph, tc, { noise: false })).frames[0].counts.trues;
        const rc = await ratio(centre, tC), re = await ratio(edge, tE);
        console.log('    1 ns / 4.5 ns trues: centre source ' + rc.toFixed(3) + ', source 110 mm off centre ' + re.toFixed(3));
        ok(rc > 0.97, '1 ns window keeps trues from the centre');
        ok(re < 0.75, '1 ns window loses trues near the edge of the FOV');
        const a1 = await sim(program({ tau: 1e-9 }), HEAD, HEAD_TACS, { noise: false });
        const a9 = await sim(program({ tau: 9e-9 }), HEAD, HEAD_TACS, { noise: false });
        near(a1.frames[0].counts.randoms / headBase.frames[0].counts.randoms, 1 / 4.5, 1e-9, 'randoms scale with the window width (1 ns)');
        near(a9.frames[0].counts.randoms / headBase.frames[0].counts.randoms, 2, 1e-9, 'randoms scale with the window width (9 ns)');
        ok(a1.frames[0].counts.trues < headBase.frames[0].counts.trues, 'the head loses trues in a 1 ns window');
        ok(a1.warnings.some(w => /coincidence window/.test(w)), 'narrow window warning');
        // dose squared
        const t2 = constTACs(HEAD, 3400, 20000);
        const d2 = await sim(program({ dose: 370e6 }), HEAD, t2, { noise: false });
        near(d2.frames[0].counts.randoms / headBase.frames[0].counts.randoms, 4, 1e-9, 'randoms scale with dose squared');
        near(d2.frames[0].counts.trues / headBase.frames[0].counts.trues, 2, 1e-9, 'trues scale with dose');
    }

    /* ---------- time of flight ---------- */
    let headTOF;
    {
        const a = headTOF = await sim(program({ tof: true }), HEAD, HEAD_TACS, { noise: false });
        const c = a.frames[0].counts, c0 = headBase.frames[0].counts;
        const inside = S.timing.randomsTofFraction(4.5e-9, G.ds, G.nT).inside;
        ok(a.geom.nT === 17 && a.geom.tof === true && a.frames[0].prompts.length === NLOR * 17 && a.frames[0].delayed.length === NLOR * 17 &&
            a.frames[0].scatterEst.length === NLOR * 17 && a.frames[0].randomsSingles.length === NLOR * 17, 'TOF arrays have 17 bins');
        ok(a.frames[0].expected.trues.length === NLOR, 'expected sinograms are summed over TOF');
        near(a.geom.sigmaTOF, 25.46, 0.05, 'sigmaTOF for 400 ps');
        near(c.randoms / c0.randoms, inside, 1e-9, 'TOF keeps only the randoms inside the TOF bins (' + inside.toFixed(3) + ')');
        near(c.trues / c0.trues, 1, 0.01, 'TOF does not change the trues');
        near(c.scatter / c0.scatter, 1, 0.01, 'nor the scatter');
        // a source at x = 60: on the LOR at theta = pi/2 through it, s = -60 mm -> TOF bin 8 - 3 = 5
        const src = lineSources([[60, 0]], 'air');
        const at = await sim(program({ tof: true }), src, constTACs(src, 3400, 1e6), { noise: false });
        const base = (96 * G.nR + 80) * 17, pr = at.frames[0].prompts;
        let best = 0; for (let k = 1; k < 17; k++) if (pr[base + k] > pr[base + best]) best = k;
        ok(best === 5, 'TOF profile peaks at the source (bin ' + best + ')');
    }

    /* ---------- Poisson noise ---------- */
    {
        // Randoms only: no activity in the slice, but the rest of the body sends singles.
        // The prompt sinogram is flat, so its variance across bins should equal its mean.
        const flat = head(0), tz = tacSet(flat, 3400, []);
        const phys = { detector: { variation: 0 } };
        for (const seed of [1, 2, 3, 4]) {
            const a = await sim(program(), flat, tz, Object.assign({ seed }, phys));
            const p = a.frames[0].prompts, d = a.frames[0].delayed, mean = a.frames[0].counts.randoms / NLOR;
            let s = 0, s2 = 0, sd = 0, sd2 = 0;
            for (let l = 0; l < NLOR; l++) { s += p[l]; s2 += p[l] * p[l]; sd += d[l]; sd2 += d[l] * d[l]; }
            const m = s / NLOR, v = s2 / NLOR - m * m, md = sd / NLOR, vd = sd2 / NLOR - md * md;
            near(m / mean, 1, 0.02, 'seed ' + seed + ': prompts mean = expected randoms (' + mean.toFixed(2) + ' per LOR)');
            near(v / m, 1, 0.05, 'seed ' + seed + ': prompts variance = mean (' + (v / m).toFixed(3) + ')');
            near(vd / md, 1, 0.05, 'seed ' + seed + ': delayed variance = mean');
            ok(a.frames[0].counts.trues === 0 && a.frames[0].counts.randoms > 0, 'randoms only');
        }
        // across seeds, bin by bin, in the head: variance across realisations = mean
        const reps = [];
        for (let seed = 11; seed < 17; seed++) reps.push((await sim(program(), HEAD, HEAD_TACS, { seed })).frames[0].prompts);
        const mean = headBase.frames[0].expected, nRep = reps.length;
        let sv = 0, sm = 0;
        for (let l = 0; l < NLOR; l++) {
            const mu = mean.trues[l] + mean.scatter[l] + mean.randoms[l];
            if (mu < 20) continue;
            let a = 0, b = 0; for (const r of reps) { a += r[l]; b += r[l] * r[l]; }
            sv += (b - a * a / nRep) / (nRep - 1); sm += mu;
        }
        near(sv / sm, 1, 0.05, 'head prompts: variance across seeds = mean (' + (sv / sm).toFixed(3) + ')');
        const p1 = (await sim(program(), HEAD, HEAD_TACS, { seed: 7 })).frames[0].prompts;
        const p2 = (await sim(program(), HEAD, HEAD_TACS, { seed: 7 })).frames[0].prompts;
        const p3 = (await sim(program(), HEAD, HEAD_TACS, { seed: 8 })).frames[0].prompts;
        ok(p1.every((v, k) => v === p2[k]), 'same seed, same prompts');
        ok(p1.some((v, k) => v !== p3[k]), 'different seed, different prompts');
        ok(p1.every(v => v >= 0 && v === Math.round(v)), 'prompts are non-negative integers');
        // noise off: prompts are the expected values
        const F = headBase.frames[0];
        let worst = 0;
        for (let l = 0; l < NLOR; l++) {
            const mu = F.expected.trues[l] + F.expected.scatter[l] + F.expected.randoms[l];
            if (mu > 1) worst = Math.max(worst, Math.abs(F.prompts[l] / mu - 1));
        }
        ok(worst < 1e-5, 'noise off: prompts = trues + scatter + randoms per bin');
        ok(F.delayed.every((v, k) => v === F.randomsSingles[k]), 'noise off: delayed = randomsSingles');
        ok(headTOF.frames[0].delayed.every((v, k) => v === headTOF.frames[0].randomsSingles[k]), 'TOF, noise off: delayed = randomsSingles');
    }

    /* ---------- scatter estimate (tail fit) ---------- */
    {
        const F = headBase.frames[0];
        near(F.scatterScale, 1, 0.01, 'aligned mu map, no noise: tail-fit scale = 1');
        near(U.sum(F.scatterEst) / U.sum(F.expected.scatter), 1, 0.01, 'and the estimate matches the scatter');
        const noisy = (await sim(program(), HEAD, HEAD_TACS, {})).frames[0];
        near(noisy.scatterScale, 1, 0.05, 'with noise the tail fit stays near 1 (' + noisy.scatterScale.toFixed(3) + ')');
        const off = (await sim(program(), HEAD, HEAD_TACS, { scatter: false, noise: false })).frames[0];
        ok(U.sum(off.scatterEst) < 0.02 * off.counts.trues, 'no scatter in the data: the estimate is (nearly) zero');
        // Scatter is smooth, so the estimate forgives a few mm; a gross shift shows.
        const shifted = (await sim(program(), HEAD, HEAD_TACS, { noise: false, muMap: { dx: 25 } })).frames[0];
        const dEst = relL1(shifted.scatterEst, F.scatterEst);
        console.log('    mu map shifted 25 mm: tail-fit scale ' + shifted.scatterScale.toFixed(3) + ', scatter estimate changes by ' + (100 * dEst).toFixed(1) + ' %');
        ok(shifted.scatterScale > 1.02 && dEst > 0.03, 'a misaligned mu map corrupts the scatter estimate');
        const hc = hotCold(), a = await sim(program({ tof: true }), hc, constTACs(hc, 3400, 5000), { noise: false });
        near(a.frames[0].scatterScale, 1, 0.01, 'TOF tail fit on the hot/cold cylinder');
        near(U.sum(a.frames[0].scatterEst) / a.frames[0].counts.scatter, 1, 0.01, 'TOF scatter estimate matches the scatter');
    }

    /* ---------- correction mu map ---------- */
    {
        const base = headBase.corrections;
        ok(base.acf.every(v => v >= 1 - 1e-6), 'acf >= 1');
        const centre = 0 * G.nR + 80;
        near(base.acf[centre], 1 / S.attenuationFactors(HEAD.mu, N)[centre], 1e-3, 'acf from the true mu map when aligned');
        const sh = (await sim(program(), HEAD, HEAD_TACS, { noise: false, muMap: { dx: 10 } })).corrections;
        let md = 0; for (let l = 0; l < NLOR; l++) md = Math.max(md, Math.abs(sh.acf[l] - base.acf[l]));
        ok(md > 0.5, 'a shifted correction mu map changes acf (max change ' + md.toFixed(2) + ')');
        ok(sh.muCorr[H * N + H + 64] > 0 && base.muCorr[H * N + H + 64] === 0, 'shifted muCorr moves the head (x = 80 mm now inside)');
        const nb = (await sim(program(), HEAD, HEAD_TACS, { noise: false, muMap: { model: 'nobone' } })).corrections;
        ok(nb.acf.every((v, l) => v <= base.acf[l] * (1 + 1e-5)), "'nobone' never raises acf");
        ok(nb.acf[centre] / base.acf[centre] < 0.95, "'nobone' lowers acf through the skull (" + (nb.acf[centre] / base.acf[centre]).toFixed(3) + ')');
        const skull = (H - 72) * N + H;        // (0, -90 mm) lies in the 6 mm skull
        ok(HEAD.label[skull] === 1 && Math.abs(nb.muCorr[skull] - PET.const.MU_WATER) < 1e-7, "'nobone' replaces bone by soft tissue");
        ok(Math.abs(headBase.muTrue[skull] - 0.0151) < 1e-7, 'true mu map keeps bone');
    }

    /* ---------- normalisation and a dead block ---------- */
    {
        const a = await sim(program(), HEAD, HEAD_TACS, { detector: { variation: 0.06, deadBlock: 7 } });
        const F = a.frames[0], norm = a.corrections.norm;
        let dead = 0, leak = 0;
        for (let l = 0; l < NLOR; l++) if (norm[l] === 0) { dead++; leak += F.prompts[l] + F.delayed[l] + F.scatterEst[l] + F.randomsSingles[l]; }
        ok(dead > 0 && leak === 0, 'a dead block zeroes its LORs (' + dead + ' LORs)');
        const [cA, cB] = S.lorCrystals(0, 80);
        ok(norm[80] > 0 && Math.floor(cA / 8) !== 7 && Math.floor(cB / 8) !== 7, 'other LORs still count');
        ok(a.warnings.some(w => /block 7/.test(w)), 'dead block warning');
        const v = headBase.corrections.norm;
        ok(v.some(x => Math.abs(x - 1) > 0.02), 'crystal efficiencies vary');
        // trues follow the efficiencies: with variation the summed trues are close to without
        const flat = await sim(program(), HEAD, HEAD_TACS, { noise: false, detector: { variation: 0 } });
        near(headBase.frames[0].counts.trues / flat.frames[0].counts.trues, 1, 0.03, 'efficiencies average about 1');
    }

    /* ---------- dynamic frames from a rising then falling curve ---------- */
    {
        const cyl = cylinder(100);
        const curve = t => (t < 300 ? 20000 * t / 300 : t < 900 ? 20000 - 25 * (t - 300) : 5000);
        const tacs = tacSet(cyl, 1000, [null, curve]);
        const frames = []; for (let k = 0; k < 6; k++) frames.push({ t0: 150 * k, t1: 150 * (k + 1) });
        const prog = program({ frames });
        const a = await sim(prog, cyl, tacs, { noise: false, randoms: false });
        const lam = PET.isotopes.lambda('F18');
        const integ = (t0, t1) => { let s = 0; const st = 0.05; for (let t = t0 + st / 2; t < t1; t += st) s += curve(t) * Math.exp(-lam * t) * st; return s; };
        const per = a.frames.map(F => F.counts.trues / integ(F.t0, F.t1));
        ok(Math.max(...per) / Math.min(...per) - 1 < 1e-4, 'frame trues are in proportion to the decayed curve integral (spread ' +
            (Math.max(...per) / Math.min(...per) - 1).toExponential(2) + ')');
        const tr = a.frames.map(F => F.counts.trues);
        ok(tr[2] > tr[1] && tr[1] > tr[0] && tr[2] > tr[3] && tr[3] > tr[4] && tr[4] > tr[5], 'counts rise then fall with the curve');
        a.frames.forEach((F, k) => near(F.truth.regionMean[1], integ(F.t0, F.t1) / F.decayIntegral, 1e-4 * F.truth.regionMean[1], 'frame ' + k + ' truth is the decay-weighted mean'));
        ok(a.frames.every((F, k) => F.index === k && F.dur === 150), 'frame index and duration');
        // frames before injection record nothing
        const b = await sim(program({ frames: [{ t0: -120, t1: -60 }, { t0: 0, t1: 60 }] }), cyl, tacs, { noise: false });
        ok(b.frames[0].counts.trues === 0 && b.frames[0].counts.randoms === 0 && b.frames[1].counts.trues > 0, 'a frame before injection is empty');
        ok(b.warnings.some(w => /before the injection/.test(w)), 'and the engine says so');
    }

    /* ---------- positron range ---------- */
    {
        const src = lineSources([[0, 0]], 'air'), tc = constTACs(src, 3400, 1e6);
        const peak = async (iso, pr) => {
            const F = (await sim(program({ isotope: iso, tracer: null, frames: [{ t0: 0, t1: 60 }] }), src, tc, { noise: false, positronRange: pr })).frames[0];
            return maxOf(F.prompts) / U.sum(F.prompts);
        };
        const f18 = await peak('F18', true), o15 = await peak('O15', true), o15off = await peak('O15', false), f18off = await peak('F18', false);
        ok(o15 < 0.8 * f18, '15O positron range spreads a line source more than 18F (peak share ' + o15.toFixed(4) + ' vs ' + f18.toFixed(4) + ')');
        near(o15off / f18off, 1, 0.01, 'with positron range off the isotopes look alike');
        ok(f18 < f18off && f18 > 0.8 * f18off, '18F range blurs a little (peak share ' + f18.toFixed(4) + ' vs ' + f18off.toFixed(4) + ' without)');
    }

    /* ---------- motion ---------- */
    {
        // 5 mm rods rather than 1-pixel sources: a 1-pixel source is already at the
        // limit of the 2 mm bins, so any interpolation (repositioning, or
        // resampling the moved raster) visibly softens it.
        const src = rods([[40, 20], [-50, -30]], 2.5), tc = constTACs(src, 3400, 1e6);
        const phys = m => ({ noise: false, randoms: false, motion: m });
        const stat = (await sim(program(), src, tc, phys({ on: false }))).frames[0].prompts;
        for (const m of [{ on: true, kind: 'step', dx: 10, dy: 0, rot: 0, at: 0.5 },
            { on: true, kind: 'step', dx: 0, dy: 0, rot: 8, at: 0.4 },
            { on: true, kind: 'drift', dx: 8, dy: -6, rot: 4 },
            { on: true, kind: 'periodic', dx: 0, dy: 10, rot: 0, period: 4 }]) {
            const F = (await sim(program(), src, tc, phys(m))).frames[0];
            const dMove = relL1(F.prompts, stat), dMC = relL1(F.promptsMC, stat);
            console.log('    motion ' + m.kind + ' (' + m.dx + ', ' + m.dy + ' mm, ' + m.rot + ' deg): moving vs static ' + dMove.toFixed(3) +
                ', repositioned vs static ' + dMC.toFixed(3) + '; peak ' + (maxOf(F.prompts) / maxOf(stat)).toFixed(2) + ' -> ' + (maxOf(F.promptsMC) / maxOf(stat)).toFixed(2));
            ok(dMove > 0.5, m.kind + ' motion blurs the sinogram');
            ok(dMC < 0.15 && dMC < 0.25 * dMove, m.kind + ' repositioning restores it');
            ok(maxOf(F.promptsMC) > 0.85 * maxOf(stat), m.kind + ' repositioned sinogram is sharp again');
            near(U.sum(F.prompts) / U.sum(stat), 1, 0.01, m.kind + ' motion in air keeps the counts');
            near(F.poses.reduce((s, p) => s + p.share, 0), 1, 1e-9, m.kind + ' pose shares add to 1');
        }
        // TOF data: r and the position along the LOR both move back (a 120 deg turn also wraps the angle)
        const statT = (await sim(program({ tof: true }), src, tc, phys({ on: false }))).frames[0].prompts;
        for (const m of [{ on: true, kind: 'step', dx: 0, dy: 12, at: 0.5 }, { on: true, kind: 'step', rot: 120, dx: 0, at: 0.5 }]) {
            const FT = (await sim(program({ tof: true }), src, tc, phys(m))).frames[0];
            const dm = relL1(FT.prompts, statT), dc = relL1(FT.promptsMC, statT);
            ok(dm > 0.5 && dc < 0.12 && FT.promptsMC.length === NLOR * 17, 'TOF repositioning (' + (m.rot ? m.rot + ' deg' : m.dy + ' mm') + '): ' + dm.toFixed(3) + ' -> ' + dc.toFixed(3));
        }
        // with noise: promptsMC is the same realisation, repositioned
        const F = (await sim(program(), src, tc, { randoms: false, motion: { on: true, kind: 'step', dx: 10, at: 0.5 } })).frames[0];
        near(U.sum(F.promptsMC) / U.sum(F.prompts), 1, 0.01, 'promptsMC holds the same events as prompts');
        // motion moves the attenuating object too: the head's trues change
        const hm = (await sim(program(), HEAD, HEAD_TACS, { noise: false, motion: { on: true, kind: 'step', dx: 20, at: 0.5 } })).frames[0];
        ok(relL1(hm.expected.trues, headBase.frames[0].expected.trues) > 0.05, 'head motion changes the trues sinogram');
        ok(hm.scatterScale > 1.02, 'and moved trues in the tails inflate the scatter tail fit (' + hm.scatterScale.toFixed(3) + ')');
    }

    /* ---------- progress, abort, yielding, performance ---------- */
    {
        const fr = [];
        await sim(program({ tof: true }), HEAD, HEAD_TACS, {}, { onProgress: f => fr.push(f) });
        ok(fr.length > 2 && fr[fr.length - 1] === 1, 'onProgress is called and ends at 1 (' + fr.length + ' calls)');
        ok(fr.every((f, k) => k === 0 || f >= fr[k - 1]), 'progress never goes backwards');
        let err = null, calls = 0;
        try { await sim(program({ tof: true }), HEAD, HEAD_TACS, {}, { shouldAbort: () => ++calls > 2 }); } catch (e) { err = e; }
        ok(err && err.message === 'aborted', 'shouldAbort rejects with "aborted"');
        let err2 = null;
        try { await sim({ ok: false, errors: [] }, HEAD, HEAD_TACS); } catch (e) { err2 = e; }
        ok(err2 instanceof Error, 'a failed program is rejected');

        // event-loop responsiveness: the longest stretch without a yield
        let last = Date.now(), gap = 0;
        const timer = setInterval(() => { const t = Date.now(); gap = Math.max(gap, t - last); last = t; }, 2);
        await sim(program({ tof: true }), HEAD, HEAD_TACS, {});
        await sim(program({ tof: true }), HEAD, HEAD_TACS, { motion: { on: true, kind: 'step', dx: 6 } });
        clearInterval(timer);
        console.log('    longest block between yields: ' + gap + ' ms');
        ok(gap < 250, 'never blocks the page for long (' + gap + ' ms)');

        const time = async (prog, ph, tacs, physics) => { const t0 = Date.now(); const a = await sim(prog, ph, tacs, physics); return [Date.now() - t0, a]; };
        const [tStatic] = await time(program(), HEAD, HEAD_TACS, {});
        const [tTOF] = await time(program({ tof: true }), HEAD, HEAD_TACS, {});
        // dynamic: a 19-region head (like the brain phantom) with a different curve in every region
        const brain = head(16);
        const fns = brain.regions.map((rg, r) => (r < 2 ? null : t => 9000 * (1 + 0.1 * r) * (1 - Math.exp(-t / (60 + 40 * r))) + 3000 * Math.exp(-t / 400)));
        const dyn = tacSet(brain, 3300, fns);
        const frames = []; let t = 0;
        for (const [k, d] of [[6, 10], [3, 20], [2, 60], [5, 120], [4, 600]]) for (let q = 0; q < k; q++) { frames.push({ t0: t, t1: t + d }); t += d; }
        const [tDyn, aDyn] = await time(program({ frames }), brain, dyn, {});
        const [tMot] = await time(program(), HEAD, HEAD_TACS, { motion: { on: true, kind: 'drift', dx: 6 } });
        console.log('    timings: static ' + tStatic + ' ms, TOF ' + tTOF + ' ms, dynamic (' + aDyn.frames.length + ' frames, 19 regions) ' + tDyn +
            ' ms, drift motion ' + tMot + ' ms');
        ok(aDyn.frames.length === 20, 'dynamic protocol has 20 frames');
        ok(tStatic < 600, 'static, non-TOF under 0.6 s');
        ok(tTOF < 1500, 'static, TOF under 1.5 s');
        ok(tDyn < 4000, 'dynamic 20 frames under 4 s');
    }

    summary('engine');
})().catch(e => { console.error(e); process.exitCode = 1; });
