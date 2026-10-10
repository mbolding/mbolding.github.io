/* Tests for engine.js, the imaging acquisition simulator.
     node tests/test_engine.js

   Every check here is a physics check: the engine is run on real presets
   and phantoms, the data are reconstructed with recon.js, and what comes
   out is compared with what the physics says should come out (an analytic
   signal equation, a predicted displacement in pixels, a calibrated noise
   level) or with the engine's own exact answer computed another way.
   Numbers worth seeing are printed with a leading "    ". */
'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core', 'tissues', 'phantoms', 'fields', 'dsl', 'presets', 'engine', 'recon']);
const E = MRI.engine, U = MRI.util, C = MRI.const;
const { abs, sqrt, hypot, exp, log, sin, cos, PI, max, min, round, floor } = Math;

/* ---------- helpers ---------- */

function info(msg) { console.log('    ' + msg); }

function compile(idOrSource, overrides, edit) {
    const p = MRI.presets.get(idOrSource);
    let src = p ? p.source : idOrSource;
    if (edit) src = edit(src);
    const prog = MRI.dsl.compile(src, { overrides: overrides || {} });
    if (!prog.ok) throw new Error('compile failed: ' + JSON.stringify(prog.errors));
    return prog;
}

function artifacts(patch) {
    const a = E._internal.mergeArtifacts(patch || {});
    return a;
}

/* One acquisition. o: { prog | overrides, edit, phantom | n, phantomOpts, coil, art, seed, forceGeneral, onProgress, shouldAbort } */
async function scan(preset, phantomId, o) {
    o = o || {};
    const prog = o.prog || compile(preset, o.overrides, o.edit);
    const n = o.n || (max(prog.image.nx, prog.image.ny) <= 128 ? 256 : 512);
    const ph = o.phantom || MRI.phantoms.build(phantomId, Object.assign({ n: n }, o.phantomOpts || {}));
    const art = artifacts(o.art);
    const cs = MRI.fields.coilSet(o.coil || 'body');
    const ctx = {
        b0Map: MRI.fields.b0Map(ph, art.b0), b1Map: MRI.fields.b1Map(ph, art.b1),
        coilSet: cs, coilMaps: MRI.fields.coilMaps(cs, ph.n, ph.n, ph.fov, ph.fov), artifacts: art
    };
    const t0 = Date.now();
    const acq = await E.simulate(prog, ph, ctx, { seed: o.seed || 1, forceGeneral: !!o.forceGeneral, onProgress: o.onProgress, shouldAbort: o.shouldAbort });
    acq._wallMs = Date.now() - t0;
    acq._phantom = ph;
    return acq;
}

function recon(acq, o) { return MRI.recon.run(acq, Object.assign({}, MRI.recon.defaults, o || {})); }

// Relative L2 difference of the raw samples of two acquisitions (b relative to a).
function rawDiff(a, b) {
    let num = 0, den = 0;
    for (let i = 0; i < a.readouts.length; i++) {
        const A = a.readouts[i], B = b.readouts[i];
        for (let c = 0; c < a.nCoils; c++) for (let j = 0; j < A.n; j++) {
            num += (A.re[c][j] - B.re[c][j]) ** 2 + (A.im[c][j] - B.im[c][j]) ** 2;
            den += A.re[c][j] ** 2 + A.im[c][j] ** 2;
        }
    }
    return sqrt(num / den);
}
function relDiff(a, b) {
    let num = 0, den = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - b[i]) ** 2; den += a[i] * a[i]; }
    return sqrt(num / den);
}
function maxAbs(a) { let m = 0; for (const v of a) m = max(m, abs(v)); return m; }

// Mean over pixels of the image grid inside a circle (metres, section 3 coordinates).
function discMean(img, nx, ny, fov, cx, cy, r) {
    const D = fov / nx;
    let s = 0, c = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const X = (x - floor(nx / 2)) * D, Y = (y - floor(ny / 2)) * D;
        if ((X - cx) ** 2 + (Y - cy) ** 2 < r * r) { s += img[y * nx + x]; c++; }
    }
    return s / c;
}

// Circular cross-correlation shift of b relative to a (sub-pixel, parabolic peak).
function ccShift(a, b) {
    const n = a.length, cc = new Float64Array(n);
    let bi = 0;
    for (let s = 0; s < n; s++) {
        let v = 0;
        for (let i = 0; i < n; i++) v += a[i] * b[(i + s) % n];
        cc[s] = v;
        if (v > cc[bi]) bi = s;
    }
    const ym = cc[(bi - 1 + n) % n], y0 = cc[bi], yp = cc[(bi + 1) % n];
    let s = bi + 0.5 * (ym - yp) / (ym - 2 * y0 + yp);
    if (s > n / 2) s -= n;
    return s;
}
function projection(img, nx, ny, axis) {
    const p = new Float64Array(axis === 'x' ? nx : ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) p[axis === 'x' ? x : y] += abs(img[y * nx + x]);
    return p;
}
// Sub-pixel half-maximum crossings of a 1D profile: [first rising, last falling].
function halfMaxEdges(p) {
    const m = maxAbs(p) / 2;
    let a = null, b = null;
    for (let i = 1; i < p.length; i++) if (p[i - 1] < m && p[i] >= m) { a = i - 1 + (m - p[i - 1]) / (p[i] - p[i - 1]); break; }
    for (let i = p.length - 2; i >= 0; i--) if (p[i + 1] < m && p[i] >= m) { b = i + (p[i] - m) / (p[i] - p[i + 1]); break; }
    return [a, b];
}

// Bounding box of the object in the truth image.
function bbox(tr, nx, ny) {
    const thr = 0.02 * maxAbs(tr);
    let x0 = nx, x1 = -1, y0 = ny, y1 = -1;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (abs(tr[y * nx + x]) > thr) {
        x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y);
    }
    return { x0, x1, y0, y1 };
}
/* Mean magnitude in two background strips relative to the object's mean:
   "pe": rows above and below the object within its columns (where
   ghosts along a y phase-encode land); "ro": columns left and right of it
   within its rows (where nothing should appear). */
function ghostStrips(img, tr, nx, ny) {
    const b = bbox(tr, nx, ny), thr = 0.05 * maxAbs(tr), m = 3;
    let pe = 0, pc = 0, ro = 0, rc = 0, os = 0, oc = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const v = img[y * nx + x], inX = x >= b.x0 && x <= b.x1, inY = y >= b.y0 && y <= b.y1;
        if (inX && (y < b.y0 - m || y > b.y1 + m)) { pe += v; pc++; }
        if (inY && (x < b.x0 - m || x > b.x1 + m)) { ro += v; rc++; }
        if (abs(tr[y * nx + x]) > thr) { os += v; oc++; }
    }
    return { pe: (pe / pc) / (os / oc), ro: (ro / rc) / (os / oc) };
}

/* A phantom that is a 200 mm disk of a made-up tissue with pd 1, T1 so
   short it recovers fully every TR and T2 so long it never decays: with a
   90 degree excitation every readout sees m = 1 exactly. */
function uniformPhantom(n) {
    const fov = 0.28, dx = fov / n, h = floor(n / 2), label = new Uint8Array(n * n);
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * dx, y = (iy - h) * dx;
        if (x * x + y * y < 0.1 * 0.1) label[iy * n + ix] = 1;
    }
    const unit = { id: 'unit', name: 'Unit', color: '#ffffff', pd: 1, t1: 1e-4, t2: 1e4, t2s: 1e4, cs: 0,
        pulsatile: false, enhances: false, spectrum: { water: 1, lipid: 0, metabolites: {} } };
    return { id: 'uniform', name: 'Uniform', n, fov, dx, label, tissues: [MRI.tissues.get('air'), unit],
        dB0: new Float32Array(n * n), landmarks: [], notes: '' };
}
// The reference scan of ARCHITECTURE.md section 3, with bandwidth and NEX as knobs.
const CAL_SOURCE = (bw, nex) => `
sequence "Noise calibration"
fov 240 mm
matrix 128
slice 5 mm
bandwidth ${bw} Hz/px
oversample 2
averages ${nex}
for line in 0 .. 127 every 20 ms
    rf 90 slice as exc
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + 6 ms
    gy rewind line
    spoil
end
`;

/* ============================================================ */

async function testShapeAndPathway() {
    const prog = compile('gre_t1');
    const acq = await scan(null, 'brain', { prog, art: { noise: 0 }, coil: 'head8' });
    const nAdc = prog.adc.filter(a => !a.dummy).length;
    ok(acq.readouts.length === nAdc, 'one readout per non-dummy ADC (' + acq.readouts.length + ')');
    ok(acq.nCoils === 8 && acq.coilSet.type === 'head8', 'nCoils and coilSet');
    ok(acq.grid.nx === 128 && acq.grid.ny === 128 && acq.grid.readoutAxis === 'x' && acq.grid.oversample === 2, 'grid from program.image');
    const r0 = acq.readouts[0];
    ok(r0.kx instanceof Float32Array && r0.kx.length === r0.n && r0.re.length === 8 && r0.re[0] instanceof Float32Array, 'readout arrays');
    ok(acq.truth && acq.truth.data.length === 128 * 128 && acq.truth.nx === 128, 'truth image on the image grid');
    const st = acq.stats;
    ok(['scanTime', 'computeMs', 'teEff', 'nReadouts', 'fatShiftPx', 'bwPerPixel', 'peBandwidthPerPixel', 'signalScale'].every(k => k in st), 'stats fields');
    near(st.teEff, prog.stats.TE, 1e-9, 'effective TE agrees with the compiler');
    ok(Array.isArray(acq.warnings) && acq.phantomId === 'brain' && acq.program === prog, 'warnings, phantomId, program');
    let mono = true;
    for (let i = 1; i < acq.readouts.length; i++) if (acq.readouts[i].tc <= acq.readouts[i - 1].tc) mono = false;
    ok(mono, 'readouts are in acquisition order');

    // Nominal k on the Cartesian grid: line L at ky = (L - N/2)/FOV, sample j at (j - n/2)/(os FOV).
    let errK = 0;
    for (const r of acq.readouts) {
        const L = r.vars.line;
        for (let j = 0; j < r.n; j++) {
            errK = max(errK, abs(r.kx[j] - (j - r.n / 2) / (0.24 * 2)) * 0.24, abs(r.ky[j] - (L - 64) / 0.24) * 0.24);
        }
    }
    ok(errK < 1e-3, 'gre_t1: nominal k on the grid to 1e-3 of a step (' + errK.toExponential(1) + ')');
    near(acq.readouts[0].te, 0.0025, 1e-6, 'te = tc - tExc');

    // Spin echo: the refocusing pulse negates the prephase and the phase encoding.
    const se = await scan('se', 'brain', { overrides: { N: 64 }, art: { noise: 0 } });
    let errSE = 0;
    for (const r of se.readouts) {
        const L = r.vars.line;
        errSE = max(errSE, abs(r.kx[r.n / 2]) * 0.24, abs(r.ky[0] - (L - 32) / 0.24) * 0.24);
    }
    ok(errSE < 1e-3, 'se: echo centre at kx = 0 and ky of line L after the 180 (' + errSE.toExponential(1) + ')');
    // EPI: alternate lines run backwards.
    const epi = await scan('epi', 'braino', { art: { noise: 0 } });
    const d0 = epi.readouts[0].kx[63] - epi.readouts[0].kx[0], d1 = epi.readouts[1].kx[63] - epi.readouts[1].kx[0];
    ok(d0 > 0 && d1 < 0, 'epi: odd lines are traversed in reverse');
    ok(epi.readouts.every((r, i) => abs(r.ky[0] - (i - 32) / 0.22) < 1e-3 / 0.22), 'epi: each blip steps one line');
}

async function testFastVersusGeneral() {
    /* The fast path (FFT along each straight readout) against direct
       summation. On a 128 raster the general path sums every point exactly
       (no lumping), so this measures the fast path's own error; on the 256
       raster it lumps 2 x 2 cells into rectangles. */
    const cases = [
        ['gre_t1', 'brain', 128, 'body', 0.002], ['gre_t1', 'brain', 128, 'head8', 0.002],
        ['se', 'brain', 128, 'body', 0.002], ['epi', 'brain', 128, 'body', 0.002], ['tse', 'brain', 128, 'body', 0.002],
        ['gre_t1', 'brain', 256, 'body', 0.01], ['gre_t1', 'brain', 256, 'head8', 0.01], ['se', 'shepp', 256, 'head8', 0.01],
        ['radial', 'brain', 256, 'body', 0.01], ['gre_fatsat', 'waterfat', 256, 'body', 0.01]
    ];
    const lines = [];
    for (const [p, ph, n, coil, tol] of cases) {
        const ov = p === 'radial' ? { N: 32, spokes: 48 } : { N: 32 };
        const a = await scan(p, ph, { n, overrides: ov, art: { noise: 0 }, coil });
        const b = await scan(p, ph, { n, overrides: ov, art: { noise: 0 }, coil, forceGeneral: true });
        const dk = rawDiff(a, b), di = relDiff(recon(a).image.mag, recon(b).image.mag);
        ok(a.stats.path === 'fast' && b.stats.path === 'general' && b.warnings.length === 1, p + ': path bookkeeping');
        ok(dk < tol && di < tol, p + ' on ' + ph + ' ' + n + ' ' + coil + ': fast and general paths agree (raw ' + dk.toExponential(2) + ', image ' + di.toExponential(2) + ')');
        lines.push(p + '/' + n + '/' + coil + ' ' + (100 * dk).toFixed(3) + '%');
    }
    info('fast vs general, raw-data difference: ' + lines.join(', '));
}

async function testNoiseCalibration() {
    const ph = uniformPhantom(256);
    const res = {};
    for (const [bw, nex] of [[250, 1], [250, 2], [1000, 1]]) {
        const prog = compile(CAL_SOURCE(bw, nex));
        const clean = await scan(null, null, { prog, phantom: ph, art: { noise: 0 } });
        const noisy = await scan(null, null, { prog, phantom: ph, art: { noise: 1 }, seed: 11 });
        const a = recon(clean), b = recon(noisy);
        const nx = a.image.nx;
        // pure noise image = noisy - clean (complex coil image, readout oversampling cropped)
        let s = 0, s2 = 0, m = 0;
        for (let i = 0; i < nx * nx; i++) for (const part of ['re', 'im']) {
            const d = b.coilImages[part][0][i] - a.coilImages[part][0][i];
            s += d; s2 += d * d; m++;
        }
        const sd = sqrt(s2 / m - (s / m) ** 2);
        const sig = discMean(a.image.mag, nx, nx, 0.24, 0, 0, 0.05);
        res[bw + '/' + nex] = { sd, sig };
    }
    const ref = res['250/1'];
    info('NOISE_REF = ' + E.NOISE_REF.toExponential(5) + '; reference scan: signal ' + ref.sig.toFixed(5) + ', image noise SD ' + ref.sd.toFixed(5) +
        ', NEX 2: ' + res['250/2'].sd.toFixed(5) + ', 1000 Hz/px: ' + res['1000/1'].sd.toFixed(5));
    near(ref.sig, 1, 0.002, 'uniform m = 1, 5 mm slice, unit coil reconstructs to 1.0');
    near(ref.sd, 0.01, 0.0003, 'reference scan has image noise SD 0.01 (SNR 100)');
    near(ref.sd / res['250/2'].sd, sqrt(2), 0.05, 'two averages improve SNR by sqrt 2');
    near(res['1000/1'].sd / ref.sd, 2, 0.06, 'noise grows as sqrt(BW): 4x bandwidth, 2x noise');
    near(E.NOISE_REF, 0.01 / (sqrt(250 * 256) * (1 / 0.48) * (1 / 0.24) * sqrt(256 * 128)), 1e-15, 'NOISE_REF follows from section 3');

    // Same seed, same noise; another seed, other noise; the noise does not depend on the artifacts that are on.
    const prog = compile('gre_t1', { N: 32 });
    const a1 = await scan(null, 'braino', { prog, seed: 5 }), a2 = await scan(null, 'braino', { prog, seed: 5 }), a3 = await scan(null, 'braino', { prog, seed: 6 });
    ok(rawDiff(a1, a2) === 0, 'same seed reproduces the data exactly');
    ok(rawDiff(a1, a3) > 1e-3, 'another seed gives other noise');
}

async function testCleanReconMatchesTruth() {
    /* 1. A uniform disk (braino). With a Hamming filter the ringing from the
       edge dies within a few pixels, so the interior must reconstruct to
       the truth exactly: this checks the signal scaling, the class
       amplitudes and the k-space positions together. */
    const lines = [];
    for (const p of ['gre_t1', 'se', 'gre_t2s', 'epi']) {
        const acq = await scan(p, 'braino', { art: { noise: 0 } });
        const rc = recon(acq, { filter: 'hamming' }), nx = rc.image.nx, D = rc.image.fovX / nx;
        let num = 0, den = 0;
        for (let y = 0; y < nx; y++) for (let x = 0; x < nx; x++) {
            if (hypot((x - nx / 2) * D, (y - nx / 2) * D) > 0.08 - 10 * D) continue;
            num += (rc.image.mag[y * nx + x] - acq.truth.data[y * nx + x]) ** 2; den += acq.truth.data[y * nx + x] ** 2;
        }
        const e = sqrt(num / den);
        ok(e < 0.002, p + ': uniform disk interior matches truth (NRMSE ' + e.toExponential(2) + ')');
        lines.push(p + ' ' + (100 * e).toFixed(3) + '%');
    }
    info('braino interior vs truth (Hamming): ' + lines.join(', '));

    /* 2. The brain, no noise, body coil. The object has sharp edges every
       few millimetres (cortex, sulci, scalp fat), and an unfiltered
       reconstruction rings at each of them (Gibbs) while the truth, being
       box-averaged, does not. So compare only where the truth is flat over
       a 7 x 7 pixel neighbourhood (within 2 %); what is left there is the
       tail of the ringing from edges a few pixels away, a few percent for
       the high-contrast spin echo. Without the restriction the error is
       30 to 50 % and says nothing about the engine. */
    for (const p of ['gre_t1', 'se']) {
        const acq = await scan(p, 'brain', { art: { noise: 0 } });
        const rc = recon(acq), nx = rc.image.nx, tr = acq.truth.data, mg = rc.image.mag, mx = maxAbs(tr);
        let num = 0, den = 0, cnt = 0;
        for (let y = 3; y < nx - 3; y++) for (let x = 3; x < nx - 3; x++) {
            let lo = Infinity, hi = -Infinity, s = 0;
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const v = abs(tr[(y + dy) * nx + x + dx]); lo = min(lo, v); hi = max(hi, v); s += v; }
            const mean = s / 49;
            if (mean < 0.1 * mx || hi - lo > 0.02 * mean) continue;
            num += (mg[y * nx + x] - abs(tr[y * nx + x])) ** 2; den += tr[y * nx + x] ** 2; cnt++;
        }
        const e = sqrt(num / den);
        info(p + ' on the brain: NRMSE ' + (100 * e).toFixed(2) + '% over ' + cnt + ' flat pixels');
        ok(cnt > 100 && e < 0.05, p + ': brain recon matches truth in flat regions (Gibbs-limited, NRMSE ' + e.toFixed(4) + ')');
    }
}

async function testContrast() {
    const brain = MRI.phantoms.build('brain', { n: 256 });
    function amps(preset, overrides) {
        const ev = E.tissueEvolution(compile(preset, overrides), brain);
        const out = {};
        ev.tissues.forEach((t, i) => { out[t.id] = ev.center.amp[i]; });
        return out;
    }
    const se = amps('se'), gre = amps('gre_t1'), fl = amps('flair'), st = amps('stir');
    const f = a => ['csf', 'gm', 'wm', 'fat'].map(k => k + ' ' + a[k].toFixed(3)).join(', ');
    info('se: ' + f(se)); info('gre_t1: ' + f(gre)); info('flair: ' + f(fl)); info('stir: ' + f(st));
    ok(se.csf > se.gm && se.gm > se.wm, 'se (TR 3000, TE 90): CSF > GM > WM');
    ok(gre.wm > gre.gm && gre.gm > gre.csf, 'gre_t1: WM > GM > CSF');
    ok(abs(fl.csf) < 0.15 * abs(fl.wm), 'flair: CSF nulled relative to WM (' + (fl.csf / fl.wm).toFixed(3) + ')');
    ok(abs(st.fat) < 0.25 * abs(st.wm) && abs(st.fat) < 0.15 * abs(st.csf), 'stir: fat near zero (' + (st.fat / st.wm).toFixed(3) + ' of WM)');
    ok(st.wm < 0 && st.csf < 0, 'stir: tissues still inverted at TI give negative (signed) amplitudes');

    /* The same order in the images: mean of the truth and of the
       reconstruction over image pixels that lie wholly inside one tissue
       (the 5 x 5 raster pixels round the pixel centre share its label). */
    for (const [p, order] of [['se', ['csf', 'gm', 'wm']], ['gre_t1', ['wm', 'gm', 'csf']]]) {
        const acq = await scan(p, 'brain', { art: { noise: 0 } });
        const rc = recon(acq), nx = rc.image.nx, D = 0.24 / nx, n = brain.n;
        const sumT = {}, sumR = {}, cnt = {};
        for (let y = 0; y < nx; y++) for (let x = 0; x < nx; x++) {
            const ix = round((x - nx / 2) * D / brain.dx) + n / 2, iy = round((y - nx / 2) * D / brain.dx) + n / 2;
            const L = brain.label[iy * n + ix];
            let pure = L > 0;
            for (let dy = -2; dy <= 2 && pure; dy++) for (let dx = -2; dx <= 2; dx++) if (brain.label[(iy + dy) * n + ix + dx] !== L) { pure = false; break; }
            if (!pure) continue;
            const id = brain.tissues[L].id;
            sumT[id] = (sumT[id] || 0) + acq.truth.data[y * nx + x]; sumR[id] = (sumR[id] || 0) + rc.image.mag[y * nx + x]; cnt[id] = (cnt[id] || 0) + 1;
        }
        const mT = order.map(id => sumT[id] / cnt[id]), mR = order.map(id => sumR[id] / cnt[id]);
        info(p + ' image means (' + order.join(', ') + '): truth ' + mT.map(v => v.toFixed(3)).join(', ') + '; recon ' + mR.map(v => v.toFixed(3)).join(', '));
        ok(mT[0] > mT[1] && mT[1] > mT[2] && mR[0] > mR[1] && mR[1] > mR[2], p + ': ' + order.join(' > ') + ' in the truth and in the reconstruction');
    }

    /* The tracker against textbook equations, on the twelve relaxometry vials:
         spin echo (90 at 0, 180 at TE/2):  pd (1 - 2 e^{-(TR - TE/2)/T1} + e^{-TR/T1}) e^{-TE/T2}
         spoiled gradient echo:             pd sin a (1 - E1)/(1 - cos a E1) e^{-TE/T2*}            */
    const relax = MRI.phantoms.build('relax', { n: 256 });
    for (const p of ['se', 'se_t1', 'gre_t1', 'gre_t2s']) {
        const prog = compile(p), ev = E.tissueEvolution(prog, relax);
        const TR = prog.stats.TR, TE = prog.stats.TE;
        const exc = prog.rf.find(r => r.role === 'excite' && !r.dummy), ref = prog.rf.find(r => r.role === 'refocus' && !r.dummy);
        let err = 0;
        ev.tissues.forEach((t, i) => {
            const T = relax.tissues.find(x => x.id === t.id);
            let S;
            if (ref) S = T.pd * (1 - 2 * exp(-(TR - (ref.t - exc.t)) / T.t1) + exp(-TR / T.t1)) * exp(-TE / T.t2);
            else {
                const a = exc.flip * PI / 180, E1 = exp(-TR / T.t1);
                S = T.pd * sin(a) * (1 - E1) / (1 - cos(a) * E1) * exp(-TE / T.t2s);
            }
            err = max(err, abs(ev.center.amp[i] - S));
        });
        ok(err < 1e-5, p + ': steady-state amplitude of every vial matches the analytic equation (max error ' + err.toExponential(1) + ')');
    }
}

async function testTissueEvolution() {
    const brain = MRI.phantoms.build('brain', { n: 256 });
    const prog = compile('gre_t1');
    const ev = E.tissueEvolution(prog, brain);
    const nT = brain.tissues.length - 1;
    ok(ev.tissues.length === nT && ev.mz.length === nT && ev.mxy.length === nT, 'one curve per non-air tissue');
    ok(ev.t instanceof Float32Array && ev.mz[0].length === ev.t.length && ev.t.length > 2000, 'time grid of about 2000 points plus the RF jumps');
    ok(ev.adc.length === prog.adc.filter(a => !a.dummy).length && ev.center.index === 64, 'every ADC recorded; centre readout is line 64');
    ok(ev.segments.length === 2 && ev.segments[1].t0 >= ev.segments[0].t1, 'first periods plus the steady-state period');
    let sorted = true;
    for (let i = 1; i < ev.t.length; i++) if (ev.t[i] < ev.t[i - 1]) sorted = false;
    ok(sorted, 'time grid is sorted');
    ok(ev.events.some(e => e.kind === 'rf' && e.role === 'excite') && ev.events.some(e => e.kind === 'spoil'), 'events listed');

    /* Mz recovery between pulses: for each tissue, after the second
       excitation Mz(t) = 1 - (1 - Mz0) exp(-(t - t0)/T1). */
    const k = ev.tissues.findIndex(t => t.id === 'wm'), T1 = brain.tissues[k + 1].t1;
    const exc = ev.events.filter(e => e.kind === 'rf' && e.role === 'excite')[1].t;
    let i0 = -1;
    for (let i = 0; i < ev.t.length; i++) if (ev.t[i] > exc + 1e-4) { i0 = i; break; }
    const t0 = ev.t[i0], m0 = ev.mz[k][i0];
    let err = 0;
    for (let i = i0; i < ev.t.length && ev.t[i] < exc + 0.2; i++) err = max(err, abs(ev.mz[k][i] - (1 - (1 - m0) * exp(-(ev.t[i] - t0) / T1))));
    ok(err < 2e-4, 'Mz recovers with T1 between pulses (max error ' + err.toExponential(1) + ')');

    /* Inversion through zero. Lengthen TI past the null so the crossing is
       seen before the excitation, then compare its time with
       T1 ln(1 - Mz_after_inversion). */
    for (const [preset, tid, TI] of [['stir', 'fat', 0.6], ['flair', 'csf', 3.8]]) {
        const p2 = compile(preset, { TI: TI });
        const e2 = E.tissueEvolution(p2, brain, { points: 20000 });
        const q = e2.tissues.findIndex(t => t.id === tid), T1q = brain.tissues[q + 1].t1;
        const seg = e2.segments[e2.segments.length - 1];
        const inv = e2.events.find(e => e.kind === 'rf' && e.role === 'invert' && e.t >= seg.t0 - 1e-9);
        const ex = e2.events.find(e => e.kind === 'rf' && e.role === 'excite' && e.t > inv.t);
        // the record just after the inversion pulse is the second of the pair at its time
        let ia = -1;
        for (let i = seg.i0; i < seg.i1 - 1; i++) if (abs(e2.t[i] - inv.t) < 1e-4 && abs(e2.t[i + 1] - inv.t) < 1e-4) { ia = i + 1; break; }
        const mzBefore = e2.mz[q][ia - 1], mzAfter = e2.mz[q][ia];
        let tz = null;
        for (let i = ia; i < seg.i1 - 1 && e2.t[i + 1] < ex.t - 1e-4; i++) {
            if (e2.mz[q][i] < 0 && e2.mz[q][i + 1] >= 0) { tz = e2.t[i] + (e2.t[i + 1] - e2.t[i]) * (-e2.mz[q][i]) / (e2.mz[q][i + 1] - e2.mz[q][i]); break; }
        }
        const pred = T1q * log(1 - mzAfter);
        info(preset + ': ' + tid + ' Mz ' + mzBefore.toFixed(3) + ' -> ' + mzAfter.toFixed(3) + ' at the inversion, null ' +
            (tz === null ? 'none' : ((tz - inv.t) * 1e3).toFixed(1) + ' ms') + ' after it, predicted ' + (pred * 1e3).toFixed(1) + ' ms');
        near(mzAfter, -mzBefore, 2e-3, preset + ': the inversion flips Mz');
        ok(tz !== null && abs(tz - inv.t - pred) < 0.003, preset + ': ' + tid + ' crosses zero at T1 ln(1 - Mz_inv)');
    }
}

async function testChemicalShift() {
    /* Oil alone (the water made invisible with pd 0) and no field offset,
       so the only displacement is the chemical shift. */
    const opts = { phantomOpts: { overrides: { water: { pd: 0 } } }, art: { noise: 0, b0: { susceptibility: 0 } } };
    for (const p of ['gre_t1', 'se']) {
        const acq = await scan(p, 'waterfat', opts);
        const rc = recon(acq), nx = rc.image.nx, ny = rc.image.ny, tr = acq.truth.data, mg = rc.image.mag;
        const bw = acq.program.image.bwPerPixel, pred = C.FAT_HZ / bw;
        const sx = ccShift(projection(tr, nx, ny, 'x'), projection(mg, nx, ny, 'x'));
        const sy = ccShift(projection(tr, nx, ny, 'y'), projection(mg, nx, ny, 'y'));
        // The oil vial (centre -40, -25 mm, radius 20 mm): its edges along the readout, rows through its centre.
        const D = 0.24 / nx, row = round(-0.025 / D) + nx / 2, x0 = round(-0.07 / D) + nx / 2, x1 = round(-0.01 / D) + nx / 2;
        const profT = [], profR = [];
        for (let x = x0; x <= x1; x++) {
            let a = 0, b = 0;
            for (let y = row - 1; y <= row + 1; y++) { a += abs(tr[y * nx + x]); b += mg[y * nx + x]; }
            profT.push(a); profR.push(b);
        }
        const eT = halfMaxEdges(profT), eR = halfMaxEdges(profR);
        info(p + ': fat shift along readout ' + sx.toFixed(3) + ' px (predicted FAT_HZ/BW = ' + pred.toFixed(3) + '), oil vial edges moved ' +
            (eR[0] - eT[0]).toFixed(2) + ' and ' + (eR[1] - eT[1]).toFixed(2) + ' px');
        near(sx, pred, 0.05, p + ': oil displaced along the readout by FAT_HZ/BW pixels, towards lower x');
        near(sy, 0, 0.05, p + ': no displacement along the phase-encode axis');
        near(eR[0] - eT[0], pred, 0.2, p + ': left edge of the oil vial moves by FAT_HZ/BW');
        near(eR[1] - eT[1], pred, 0.2, p + ': right edge of the oil vial moves by FAT_HZ/BW');
        near(acq.stats.fatShiftPx.readout, pred, 1e-6, p + ': stats.fatShiftPx.readout');
        ok(acq.stats.fatShiftPx.phase === 0 && acq.stats.peBandwidthPerPixel === null, p + ': no phase-encode shift reported');
    }
    // EPI: the off-resonance phase grows line by line, so fat moves along the PHASE axis.
    const acq = await scan('epi', 'waterfat', opts);
    const rc = recon(acq), nx = rc.image.nx, ny = rc.image.ny, tr = acq.truth.data, mg = rc.image.mag;
    const esp = acq.program.stats.echoSpacing, N = acq.program.image.ny;
    const peBW = 1 / (N * esp), pred = C.FAT_HZ / peBW;
    const sy = ccShift(projection(tr, nx, ny, 'y'), projection(mg, nx, ny, 'y'));
    const sx = ccShift(projection(tr, nx, ny, 'x'), projection(mg, nx, ny, 'x'));
    info('epi: fat shift along phase ' + sy.toFixed(2) + ' px (predicted FAT_HZ N ESP = ' + pred.toFixed(2) + '), along readout ' + sx.toFixed(2) +
        ' px; stats: ' + JSON.stringify(acq.stats.fatShiftPx) + ', PE bandwidth ' + acq.stats.peBandwidthPerPixel.toFixed(2) + ' Hz/px');
    near(sy, pred, 0.3, 'epi: oil displaced along phase by FAT_HZ / (1/(N ESP)) pixels');
    near(acq.stats.peBandwidthPerPixel, peBW, 1e-6 * peBW, 'epi: stats.peBandwidthPerPixel = 1/(N ESP)');
    near(acq.stats.fatShiftPx.phase, pred, 1e-3, 'epi: stats.fatShiftPx.phase');
    ok(abs(sx) < 0.3, 'epi: only a small net shift along the readout');
}

async function testB0() {
    const brain = MRI.phantoms.build('brain', { n: 256 });
    const lm = brain.landmarks.find(l => /Orbitofrontal/.test(l.name));
    const ratio = {};
    for (const p of ['gre_t2s', 'se']) {
        const m = {};
        for (const s of [0, 1]) {
            const acq = await scan(p, 'brain', { art: { noise: 0, b0: { susceptibility: s } } });
            const rc = recon(acq);
            m[s] = discMean(rc.image.mag, rc.image.nx, rc.image.ny, rc.image.fovX, lm.x, lm.y, 0.012);
        }
        ratio[p] = m[1] / m[0];
    }
    info('signal near the frontal sinus, susceptibility 1 / 0: gre_t2s ' + ratio.gre_t2s.toFixed(3) + ', se ' + ratio.se.toFixed(3));
    ok(ratio.gre_t2s < 0.85, 'gre_t2s loses signal next to the frontal sinus');
    ok(ratio.se > 0.95 && ratio.se < 1.05, 'se keeps it: the 180 refocuses the static field');

    // EPI: the field shifts tissue along the phase axis (posteriorly for a positive offset with ky rising in time).
    const edge = {};
    for (const p of ['se_epi', 'gre_t1']) {
        const e = {};
        for (const s of [0, 1]) {
            const acq = await scan(p, 'brain', { art: { noise: 0, b0: { susceptibility: s } } });
            const rc = recon(acq), nx = rc.image.nx, ny = rc.image.ny;
            const prof = new Float64Array(ny);
            for (let y = 0; y < ny; y++) for (let x = nx / 2 - 2; x <= nx / 2 + 2; x++) prof[y] += rc.image.mag[y * nx + x];
            e[s] = halfMaxEdges(prof)[0];
        }
        edge[p] = e[1] - e[0];
    }
    info('anterior edge of the head moved by ' + edge.se_epi.toFixed(2) + ' px in se_epi, ' + edge.gre_t1.toFixed(2) + ' px in gre_t1');
    ok(edge.se_epi > 2 && edge.se_epi < 15, 'epi: geometric shift along phase next to the sinus');
    ok(abs(edge.gre_t1) < 0.3, 'gre_t1: no such shift (high bandwidth per pixel, readout along x)');
}

async function testGradientDelay() {
    // Ghost level: mean magnitude in the object shifted by N/2 along phase (outside the object), over the object's mean.
    function nyquistGhost(img, tr, nx, ny) {
        const thr = 0.05 * maxAbs(tr);
        const inObj = (x, y) => x >= 0 && x < nx && y >= 0 && y < ny && abs(tr[y * nx + x]) > thr;
        let gs = 0, gc = 0, os = 0, oc = 0;
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            const v = img[y * nx + x];
            if (inObj(x, y)) { os += v; oc++; }
            let near_ = false;
            for (let d = -2; d <= 2 && !near_; d++) for (let e = -2; e <= 2; e++) if (inObj(x + d, y + e)) { near_ = true; break; }
            if (!near_ && inObj(x, (y + ny / 2) % ny)) { gs += v; gc++; }
        }
        return (gs / gc) / (os / oc);
    }
    const g = {};
    for (const p of ['epi', 'gre_t1']) for (const [key, d] of [['0', 0], ['3us', 3e-6]]) {
        const acq = await scan(p, 'braino', { art: { noise: 0, gradDelay: d } });
        const rc = recon(acq);
        g[p + '_' + key] = { ghost: nyquistGhost(rc.image.mag, acq.truth.data, rc.image.nx, rc.image.ny), mag: rc.image.mag, acq };
    }
    info('N/2 ghost / object: epi ' + g.epi_0.ghost.toFixed(4) + ' -> ' + g.epi_3us.ghost.toFixed(4) + ' with a 3 us delay; gre_t1 ' +
        g.gre_t1_0.ghost.toFixed(4) + ' -> ' + g.gre_t1_3us.ghost.toFixed(4));
    ok(g.epi_0.ghost < 0.03, 'epi without delay: no Nyquist ghost');
    ok(g.epi_3us.ghost > 0.2, 'epi with a 3 us gradient delay: strong N/2 ghost');
    ok(g.gre_t1_3us.ghost < 0.02 && relDiff(g.gre_t1_0.mag, g.gre_t1_3us.mag) < 2e-3, 'gre_t1: the delay only shifts k-space uniformly (a phase ramp): no ghost');
    const corr = recon(g.epi_3us.acq, { epiGhostCorr: true });
    const gc = nyquistGhost(corr.image.mag, g.epi_3us.acq.truth.data, corr.image.nx, corr.image.ny);
    ok(gc < 0.03, 'the recon EPI ghost correction removes it (' + gc.toFixed(4) + '): engine and recon agree on the sign');
}

async function testMotion() {
    const base = await scan('gre_t1', 'braino', { overrides: { N: 64 }, art: { noise: 0 } });
    const rb = recon(base), nx = rb.image.nx, ny = rb.image.ny, tr = base.truth.data;
    const g0 = ghostStrips(rb.image.mag, tr, nx, ny);
    const res = {};
    for (const [name, mo] of [
        ['periodic y', { kind: 'periodic', amp: 0.004, period: 4, axis: 'y' }],
        ['periodic x', { kind: 'periodic', amp: 0.004, period: 4, axis: 'x' }],
        ['sudden', { kind: 'sudden', amp: 0.004, at: 0.5, axis: 'y' }]]) {
        const acq = await scan('gre_t1', 'braino', { overrides: { N: 64 }, art: { noise: 0, motion: Object.assign({ on: true }, mo) } });
        const rc = recon(acq);
        res[name] = { s: ghostStrips(rc.image.mag, tr, nx, ny), d: relDiff(rb.image.mag, rc.image.mag) };
    }
    info('background beside the object along phase / along readout: none ' + g0.pe.toFixed(4) + ' / ' + g0.ro.toFixed(4) + '; ' +
        Object.keys(res).map(k => k + ' ' + res[k].s.pe.toFixed(4) + ' / ' + res[k].s.ro.toFixed(4)).join('; '));
    ok(g0.pe < 0.01 && g0.ro < 0.01, 'no motion: no ghosts');
    ok(res['periodic y'].s.pe > 5 * g0.pe && res['periodic y'].s.ro < 1.5 * g0.ro + 0.002, 'periodic motion along y: ghosts along the phase axis only');
    ok(res['periodic x'].s.pe > 2 * g0.pe && res['periodic x'].s.ro < 1.5 * g0.ro + 0.002, 'periodic motion along x (the readout): ghosts still along phase');
    ok(res.sudden.s.pe > 2 * g0.pe && res.sudden.d > 0.03, 'sudden motion half way: ghosting and blurring (image change ' + res.sudden.d.toFixed(3) + ')');
    // Nodding needs an object that is not round (a disk turned about its centre is unchanged).
    const sb = await scan('gre_t1', 'shepp', { overrides: { N: 64 }, art: { noise: 0 } });
    const sn = await scan('gre_t1', 'shepp', { overrides: { N: 64 }, art: { noise: 0, motion: { on: true, kind: 'nod', amp: 0.05, period: 4 } } });
    const rsb = recon(sb), rsn = recon(sn);
    const gs0 = ghostStrips(rsb.image.mag, sb.truth.data, nx, ny), gs1 = ghostStrips(rsn.image.mag, sb.truth.data, nx, ny);
    const dn = relDiff(rsb.image.mag, rsn.image.mag);
    info('nodding (Shepp-Logan, 0.05 rad): image change ' + (100 * dn).toFixed(1) + '%, background along phase ' + gs0.pe.toFixed(4) + ' -> ' + gs1.pe.toFixed(4));
    ok(dn > 0.05 && gs1.pe > 1.3 * gs0.pe, 'nodding: blurring and ghosts along phase');
    /* The fast path rotates the centre k and the readout direction into the
       head's frame; the general path rotates k sample by sample. On a 128
       raster the general path is exact, so the two must agree. */
    const nodArt = { noise: 0, motion: { on: true, kind: 'nod', amp: 0.1, period: 3 } };
    const nf = await scan('gre_t1', 'shepp', { n: 128, overrides: { N: 32 }, art: nodArt });
    const ng = await scan('gre_t1', 'shepp', { n: 128, overrides: { N: 32 }, art: nodArt, forceGeneral: true });
    ok(rawDiff(nf, ng) < 0.002, 'nodding: fast and general paths agree on the rotated head (' + rawDiff(nf, ng).toExponential(2) + ')');
    const m = E._internal.motionAt({ kind: 'nod', amp: 0.05, period: 4 }, 1, 0, 10, 0);
    ok(m && abs(m.theta - 0.05) < 1e-12 && m.rot && m.dx === 0 && m.dy === 0, 'nod: rotation of amp at a quarter period');
    // a translation that happens before the scan changes nothing but the position
    const st = await scan('gre_t1', 'braino', { overrides: { N: 64 }, art: { noise: 0, motion: { on: true, kind: 'sudden', amp: 0.0075, at: 0, axis: 'y' } } });
    const rs = recon(st);
    const shift = ccShift(projection(rb.image.mag, nx, ny, 'y'), projection(rs.image.mag, nx, ny, 'y'));
    near(shift, 0.0075 / (0.24 / 64), 0.05, 'a step at the start of the scan just moves the object by amp (2 px along y)');
}

async function testFlow() {
    const prog = compile('gre_t1');
    const off = await scan(null, 'brain', { prog, art: { noise: 0 } });
    const on = await scan(null, 'brain', { prog, art: { noise: 0, flow: { on: true } } });
    const a = recon(off), b = recon(on), nx = a.image.nx, ny = a.image.ny;
    const diff = new Float64Array(nx * ny);
    for (let i = 0; i < diff.length; i++) diff[i] = hypot(b.coilImages.re[0][i] - a.coilImages.re[0][i], b.coilImages.im[0][i] - a.coilImages.im[0][i]);
    // where the blood is, on the image grid
    const ph = off._phantom, vi = ph.tissues.findIndex(t => t.id === 'vessel'), D = 0.24 / nx;
    const vcol = new Set(), vrow = new Set();
    for (let iy = 0; iy < ph.n; iy++) for (let ix = 0; ix < ph.n; ix++) if (ph.label[iy * ph.n + ix] === vi) {
        vcol.add(round((ix - ph.n / 2) * ph.dx / D) + nx / 2); vrow.add(round((iy - ph.n / 2) * ph.dx / D) + ny / 2);
    }
    let inV = 0, tot = 0;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const e = diff[y * nx + x] ** 2;
        tot += e;
        for (const c of vcol) if (abs(c - x) <= 1) { inV += e; break; }
    }
    ok(inV / tot > 0.9, 'flow: the change is confined to the columns of the vessels (' + (100 * inV / tot).toFixed(1) + '%), i.e. along phase');
    /* The cardiac modulation has frequency TR/period cycles per line, so the
       first ghost sits that fraction of the FOV from the vessel. */
    const TR = prog.stats.TR, off_ = (TR / 0.9) * ny;
    const col = new Float64Array(ny);
    for (let y = 0; y < ny; y++) for (const c of vcol) col[y] += diff[y * nx + c];
    const sortedCol = Array.from(col).sort((p, q) => p - q), median = sortedCol[ny >> 1];
    const rows = [...vrow].sort((p, q) => p - q), vr = rows[0];          // the anterior vessel
    let peak = 0;
    for (let d = -1; d <= 1; d++) peak = max(peak, col[(round(vr + off_) + d + ny) % ny]);
    info('flow ghost: predicted ' + off_.toFixed(1) + ' rows from the vessel at row ' + vr + '; column signal there ' + peak.toFixed(3) + ', median ' + median.toFixed(4));
    ok(peak > 10 * median + 1e-6, 'flow: a discrete ghost at the predicted offset along phase');
}

async function testSpikeAndZipper() {
    const prog = compile('se');
    const base = await scan(null, 'brain', { prog, art: { noise: 0 } });
    const a = recon(base), nx = a.image.nx, ny = a.image.ny;
    const sp = await scan(null, 'brain', { prog, art: { noise: 0, spike: { on: true } } });
    const b = recon(sp);
    let m = 0, s2 = 0;
    const d = new Float64Array(nx * ny);
    for (let i = 0; i < d.length; i++) { d[i] = hypot(b.coilImages.re[0][i] - a.coilImages.re[0][i], b.coilImages.im[0][i] - a.coilImages.im[0][i]); m += d[i]; s2 += d[i] * d[i]; }
    m /= d.length;
    const cov = sqrt(max(0, s2 / d.length - m * m)) / m;
    const s = sp.stats.spike;
    info('spike in readout ' + s.readout + ' sample ' + s.sample + ': stripes of uniform magnitude ' + m.toFixed(3) + ' (' + (m / discMean(a.image.mag, nx, ny, 0.24, 0, 0, 0.05)).toFixed(1) + 'x the central brain signal)');
    ok(s.readout === round(0.37 * (sp.readouts.length - 1)) || abs(s.readout - 0.37 * sp.readouts.length) < 2, 'spike at 37% of the scan');
    ok(cov < 1e-3, 'spike: one k-space point gives a plane wave over the whole image (herringbone)');
    let only = true;
    for (let i = 0; i < sp.readouts.length; i++) for (let j = 0; j < sp.readouts[i].n; j++) {
        const changed = sp.readouts[i].re[0][j] !== base.readouts[i].re[0][j];
        if (changed !== (i === s.readout && j === s.sample)) only = false;
    }
    ok(only, 'spike: exactly one sample changed');

    for (const [p, hz] of [['se', 3000], ['se', -1500], ['gre_t1', 3000]]) {
        const pr = compile(p);
        const z0 = p === 'se' ? base : await scan(null, 'brain', { prog: pr, art: { noise: 0 } });
        const z1 = await scan(null, 'brain', { prog: pr, art: { noise: 0, zipper: { on: true, offsetHz: hz } } });
        const r0 = recon(z0), r1 = recon(z1);
        const colE = new Float64Array(nx);
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            const i = y * nx + x;
            colE[x] += (r1.coilImages.re[0][i] - r0.coilImages.re[0][i]) ** 2 + (r1.coilImages.im[0][i] - r0.coilImages.im[0][i]) ** 2;
        }
        let cx = 0, tot = 0, wsum = 0;
        for (let x = 0; x < nx; x++) { tot += colE[x]; if (colE[x] > colE[cx]) cx = x; }
        for (let x = 0; x < nx; x++) wsum += x * colE[x];
        const centroid = wsum / tot, pred = nx / 2 + hz / z1.program.image.bwPerPixel;
        info('zipper at ' + hz + ' Hz, ' + p + ': line at column ' + centroid.toFixed(2) + ' (predicted ' + pred.toFixed(2) + ')');
        near(centroid, pred, 0.3, 'zipper ' + p + ' ' + hz + ' Hz: a line at offset/BW pixels from the centre along the readout');
    }
}

async function testDummies() {
    const withD = await scan('gre_t1', 'brain', { art: { noise: 0 } });
    const noD = await scan('gre_t1', 'brain', { art: { noise: 0 }, edit: s => s.replace('dummies 4', 'dummies 0') });
    const c = (acq, i) => hypot(acq.readouts[i].re[0][acq.readouts[i].n / 2], acq.readouts[i].im[0][acq.readouts[i].n / 2]);
    const r = [0, 1, 2, 5, 20].map(i => c(noD, i) / c(withD, i));
    info('no dummies / 4 dummies, centre sample of readouts 0, 1, 2, 5, 20: ' + r.map(v => v.toFixed(3)).join(', '));
    ok(r[0] > 1.3 && r[1] > r[3], 'without dummies the first lines are recorded during the transient (larger signal)');
    ok(abs(r[3] - 1) < 0.01 && abs(r[4] - 1) < 1e-3, 'the steady state is reached within a few TRs');
    const a = recon(withD), b = recon(noD);
    const g0 = ghostStrips(a.image.mag, withD.truth.data, a.image.nx, a.image.ny), g1 = ghostStrips(b.image.mag, noD.truth.data, b.image.nx, b.image.ny);
    const d = relDiff(a.image.mag, b.image.mag);
    info('image change ' + (100 * d).toFixed(2) + '%, background along phase ' + g0.pe.toFixed(4) + ' -> ' + g1.pe.toFixed(4));
    ok(d > 0.005 && g1.pe > 1.1 * g0.pe, 'missing dummies leave an artifact along phase');
}

async function testB1AndFatSat() {
    function ring(tr, nx, r0, r1) {
        const D = 0.24 / nx;
        let s = 0, c = 0;
        for (let y = 0; y < nx; y++) for (let x = 0; x < nx; x++) {
            const r = hypot((x - nx / 2) * D, (y - nx / 2) * D);
            if (r >= r0 && r < r1) { s += tr[y * nx + x]; c++; }
        }
        return s / c;
    }
    const q = {};
    for (const amt of [0, 0.4]) {
        const acq = await scan('se', 'braino', { overrides: { N: 64 }, art: { noise: 0, b1: { amount: amt } } });
        q[amt] = ring(acq.truth.data, 64, 0, 0.02) / ring(acq.truth.data, 64, 0.06, 0.075);
        if (amt) ok(acq.stats.nClasses === 9, 'B1 map binned into 9 classes');
    }
    info('se centre/edge: uniform B1 ' + q[0].toFixed(3) + ', dielectric 0.4 ' + q[0.4].toFixed(3));
    near(q[0], 1, 1e-3, 'uniform B1: uniform disk');
    ok(q[0.4] < 0.9, 'dielectric B1: the centre gets 124% flip and loses spin-echo signal');

    // Fat saturation: spectral classes; fat suppressed, water kept; the +30 Hz edge saturates worse.
    const wf = MRI.phantoms.build('waterfat', { n: 256 });
    const io = wf.tissues.findIndex(t => t.id === 'oil') - 1, iw = wf.tissues.findIndex(t => t.id === 'water') - 1;
    const evS = E.tissueEvolution(compile('gre_fatsat'), wf), evN = E.tissueEvolution(compile('gre_t1'), wf);
    ok(evS.center.amp[io] < 0.05 * evS.center.amp[iw] && evN.center.amp[io] > evN.center.amp[iw], 'fat-sat pulse removes the oil signal and keeps water');
    const acq = await scan('gre_fatsat', 'waterfat', { overrides: { N: 64 }, art: { noise: 0, b0: { susceptibility: 1, shim: 1 } } });
    ok(acq.stats.nClasses > 4, 'spectral pulse: off-resonance classes');
    const tr = acq.truth.data, D = 0.24 / 64;
    let sR = 0, cR = 0, sL = 0, cL = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
        const X = (x - 32) * D, Y = (y - 32) * D, r = hypot(X, Y);
        if (r > 0.091 && r < 0.099 && abs(Y) < 0.03) { if (X > 0) { sR += tr[y * 64 + x]; cR++; } else { sL += tr[y * 64 + x]; cL++; } }
    }
    ok(sR / cR > 2 * (sL / cL), 'with a degraded shim fat saturation fails at the high-field edge of the oil ring');
}

async function testRadialAndSpectroscopy() {
    const acq = await scan('radial', 'braino', { art: { noise: 0 } });
    ok(acq.stats.path === 'fast' && acq.stats.nGeneral === 0 && acq.warnings.length === 0, 'radial spokes run through the fast path');
    const rc = recon(acq), nx = rc.image.nx;
    near(discMean(rc.image.mag, nx, nx, 0.24, 0, 0, 0.04) / discMean(acq.truth.data, nx, nx, 0.24, 0, 0, 0.04), 1, 0.05, 'radial recon of the disk matches truth');

    for (const p of ['fid', 'fid_ws']) {
        let msg = null;
        try { await scan(p, 'braino', {}); } catch (e) { msg = e.message; }
        ok(msg && /no spatial encoding/.test(msg) && /Spectroscopy tab/.test(msg), p + ': rejected with the "no spatial encoding" message');
    }
    let msg = null;
    try { await E.simulate({ ok: false, errors: [] }, MRI.phantoms.build('braino', { n: 256 }), {}, {}); } catch (e) { msg = e.message; }
    ok(msg && /does not compile/.test(msg), 'a failed program is refused');
}

async function testCoilsAndSense() {
    /* The engine weights the signal with the coil maps on the phantom
       raster; recon unfolds SENSE with the same maps on the image grid. If
       the two disagreed on a convention (a conjugate, a flipped axis) the
       unfolding would fail. R = 2 with SENSE must match the fully sampled
       scan; without SENSE the image is folded. */
    const ph = MRI.phantoms.build('brain', { n: 256 });
    const src = MRI.presets.get('gre_r2').source;
    const full = await scan(null, null, { prog: compile(src.replace('step 2 every', 'every')), phantom: ph, coil: 'head8', art: { noise: 0 } });
    const r2 = await scan(null, null, { prog: compile(src), phantom: ph, coil: 'head8', art: { noise: 0 } });
    const rf = recon(full, { coilCombine: 'roemer' }), rs = recon(r2, { coilCombine: 'roemer' }), rn = recon(r2, { coilCombine: 'roemer', parallel: 'none' });
    const dS = relDiff(rf.image.mag, rs.image.mag), dN = relDiff(rf.image.mag, rn.image.mag);
    info('8-channel coil, R = 2: SENSE vs fully sampled ' + (100 * dS).toFixed(2) + '%, folded (no SENSE) ' + (100 * dN).toFixed(1) + '%');
    ok(rs.gfactor && dS < 0.03 && dN > 0.2, 'engine coil weighting and recon SENSE agree: the R = 2 image unfolds');
    ok(r2.nCoils === 8 && r2.readouts[0].re.length === 8, 'eight coils recorded');
}

async function testProgressAndAbort() {
    const fr = [];
    const acq = await scan('se', 'brain', { coil: 'head8', onProgress: f => fr.push(f) });
    let mono = true;
    for (let i = 1; i < fr.length; i++) if (fr[i] < fr[i - 1]) mono = false;
    ok(fr.length >= 3 && mono && fr[fr.length - 1] === 1, 'progress is reported, rises and ends at 1 (' + fr.length + ' calls)');
    ok(acq.stats.computeMs > 0, 'computeMs recorded');
    let calls = 0, err = null;
    try { await scan('se', 'brain', { coil: 'head8', shouldAbort: () => ++calls > 1 }); } catch (e) { err = e; }
    ok(err && err.aborted === true && err.name === 'AbortError', 'shouldAbort stops the computation with an AbortError');
}

async function testPerformance() {
    /* ARCHITECTURE.md 9.5. Best of two runs (the first one also warms up the
       JIT and the phantom and coil-map caches). The Node harness runs the
       modules in a vm context, where every global lookup inside core.js's
       helpers is slower than in a browser, so these are upper bounds. */
    async function best(preset, overrides, n, coil) {
        let t = Infinity;
        for (let i = 0; i < 2; i++) {
            const acq = await scan(preset, 'brain', { overrides, n, coil });
            t = min(t, acq._wallMs);
        }
        return t;
    }
    const tSE = await best('se', {}, 256, 'head8');
    const tEPI = await best('epi', {}, 256, 'head8');
    const tGRE = await best('gre_t1', { N: 256 }, 512, 'head8');
    info('timing (noise on): se 128x128 head8 on the 256 phantom ' + tSE + ' ms; epi 64x64 head8 ' + tEPI + ' ms; gre_t1 256x256 head8 on the 512 phantom ' + tGRE + ' ms');
    ok(tSE < 1500, 'se 128x128, 8 coils, 256 phantom under 1.5 s');
    ok(tEPI < 500, 'epi 64x64, 8 coils under 0.5 s');
    ok(tGRE < 6000, 'gre 256x256, 8 coils, 512 phantom under 6 s');
}

(async function main() {
    const sections = [testShapeAndPathway, testFastVersusGeneral, testNoiseCalibration, testCleanReconMatchesTruth, testContrast,
        testTissueEvolution, testChemicalShift, testB0, testGradientDelay, testMotion, testFlow, testSpikeAndZipper, testDummies,
        testB1AndFatSat, testRadialAndSpectroscopy, testCoilsAndSense, testProgressAndAbort, testPerformance];
    for (const s of sections) {
        console.log('  ' + s.name);
        try { await s(); } catch (e) { ok(false, s.name + ' threw: ' + (e && e.stack || e)); }
    }
    summary('engine');
})();
