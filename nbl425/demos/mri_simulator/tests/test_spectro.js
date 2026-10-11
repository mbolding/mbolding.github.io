/* Tests for js/spectro.js (ARCHITECTURE.md section 11).
     node tests/test_spectro.js
   Physics checks: line positions and the frequency sign convention,
   J splitting, water suppression from the Mz model, shim broadening,
   SNR versus averages, T1 saturation at short TR, first-order phasing,
   the lipid-dominated brain spectrum, NAA/Cr, spin-echo J modulation,
   and the speed target. */
'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core', 'tissues', 'phantoms', 'fields', 'dsl', 'presets', 'spectro']);
const S = MRI.spectro, C = MRI.const;

/* ---------- helpers ---------- */
function compile(id, overrides) {
    const p = MRI.dsl.compile(MRI.presets.get(id).source, { overrides: overrides || {} });
    if (!p.ok) throw new Error('preset ' + id + ' does not compile: ' + JSON.stringify(p.errors));
    return p;
}
function art(patch) {
    const a = { noise: 1, b0: { susceptibility: 1, shim: 0 }, b1: { amount: 0 },
        spike: { on: false, amp: 50, at: 0.37 }, zipper: { on: false, offsetHz: 3000, amp: 0.02 } };
    return Object.assign(a, patch || {});
}
function phantom(id) { return MRI.phantoms.build(id, { n: 256 }); }
function sim(program, ph, artifacts, seed) {
    return S.simulate(program, ph, { b0Map: MRI.fields.b0Map(ph, artifacts.b0), artifacts: artifacts }, { seed: seed || 1 });
}
function proc(data, patch) { return S.process(data, Object.assign({}, S.defaults, patch || {})); }
function comp(spec, id) { return spec.components.find(c => c.id === id); }
function peak(spec, id) { return spec.peaks.find(p => p.id === id); }
// Tallest point of y within [lo, hi] ppm, refined by a parabola. Returns {ppm, height, k}.
function maxIn(y, ppm, lo, hi) {
    let k = -1;
    for (let i = 0; i < y.length; i++) if (ppm[i] >= lo && ppm[i] <= hi && (k < 0 || y[i] > y[k])) k = i;
    const y0 = y[k - 1], y1 = y[k], y2 = y[k + 1], den = y0 - 2 * y1 + y2;
    const d = den < 0 ? 0.5 * (y0 - y2) / den : 0;
    return { k: k, ppm: ppm[k] + d * (ppm[k + 1] - ppm[k]), height: y1 - 0.25 * (y0 - y2) * d };
}
// Linear interpolation of y at ppm value x.
function at(y, ppm, x) {
    let k = 0;
    while (k < ppm.length - 2 && ppm[k + 1] < x) k++;
    const f = (x - ppm[k]) / (ppm[k + 1] - ppm[k]);
    return y[k] + f * (y[k + 1] - y[k]);
}
// FWHM (Hz) of the peak of y at index k, by linear interpolation.
function fwhm(y, k, stepHz) {
    const h = y[k] / 2;
    let l = k, r = k;
    while (l > 0 && y[l] > h) l--;
    while (r < y.length - 1 && y[r] > h) r++;
    const xl = l + (h - y[l]) / (y[l + 1] - y[l]), xr = r - (h - y[r]) / (y[r - 1] - y[r]);
    return (xr - xl) * stepHz;
}
const sincp = x => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

const braino = phantom('braino');
const brain = phantom('brain');
const FID = compile('fid'), FIDWS = compile('fid_ws');

/* ---------- 1. API shape and the contract defaults ---------- */
{
    const d = S.defaults;
    ok(d.lb === 1 && d.gb === 0 && d.zf === 2 && d.ph0 === 0 && d.ph1 === 0 && d.autoPhase === true && d.refPpm === 4.7 && d.display === 'real',
        'defaults match the contract');
    const data = sim(FID, braino, art());
    ok(data.n === 2048 && Math.abs(data.dwell - 2.5e-4) < 1e-12 && Math.abs(data.sw - 4000) < 1e-6, 'n, dwell, sw from the ADC');
    near(data.delay, 0.25e-3, 1e-9, 'delay = first sample after the excitation centre');
    ok(data.nTransients === 16, 'nTransients = NA (dummies excluded): ' + data.nTransients);
    ok(data.fid.re.length === 2048 && data.fid.im.length === 2048, 'fid arrays');
    ok(data.components.map(c => c.id).join(',') === 'water,NAA,Cr,Cho,mI,Glu,Lac', 'braino components in library order: ' + data.components.map(c => c.id));
    ok(data.components.every(c => c.name && /^#[0-9a-f]{6}$/i.test(c.color) && c.re.length === 2048), 'component names, colours, arrays');
    ok(typeof data.noiseSigma === 'number' && data.noiseSigma > 0, 'noiseSigma');
    ok(data.info && Array.isArray(data.info.notes) && 'waterSuppression' in data.info && 'linewidthHz' in data.info, 'info fields');
    const sp = proc(data);
    ok(sp.n === 4096 && sp.hz.length === 4096 && sp.ppm.length === 4096 && sp.re.length === 4096 && sp.mag.length === 4096, 'spectrum arrays (zf 2)');
    let asc = true;
    for (let k = 1; k < sp.n; k++) if (!(sp.ppm[k] > sp.ppm[k - 1]) || !(sp.hz[k] > sp.hz[k - 1])) asc = false;
    ok(asc, 'hz and ppm ascend with index');
    near(sp.hz[2048], 0, 1e-12, 'hz = 0 at index floor(N/2)');
    near(sp.ppm[2048], 4.7, 1e-12, 'ppm at the centre is refPpm');
    near(sp.hz[1] - sp.hz[0], 4000 / 4096, 1e-12, 'frequency step SW/N');
    ok(sp.peaks.length >= 9 && sp.peaks.every(p => 'id' in p && 'name' in p && 'ppm' in p && 'height' in p && 'area' in p), 'peak table');
    ok(sp.metrics && 'snr' in sp.metrics && 'fwhmHz' in sp.metrics && sp.metrics.ratios && 'NAA_Cr' in sp.metrics.ratios && 'Cho_Cr' in sp.metrics.ratios, 'metrics');
    ok(sp.components.length === data.components.length && sp.components[0].re.length === 4096, 'components processed');
    const sp2 = proc(data, { refPpm: 4.8 });
    near(sp2.ppm[2048], 4.8, 1e-12, 'refPpm shifts the axis');
}

/* ---------- 2. Frequency sign, scaling and phasing on a synthetic FID ----------
   One line at +100 Hz, T2* 0.1 s, starting 1 ms after "excitation": the
   spectrum must peak at +100 Hz (ppm above water), with height A*T2eff,
   and autoPhase must make it absorptive. */
{
    // SW 4096 Hz and 4096 points: a 1 Hz grid, so the line centre is a grid point.
    const n = 4096, dt = 1 / 4096, T2 = 0.1, A = 3, delay = 1e-3;
    function synth(f) {
        const re = new Float64Array(n), im = new Float64Array(n);
        for (let j = 0; j < n; j++) {
            const t = delay + j * dt, a = A * Math.exp(-t / T2);
            re[j] = a * Math.cos(2 * Math.PI * f * t); im[j] = a * Math.sin(2 * Math.PI * f * t);
        }
        return { n: n, dwell: dt, sw: 1 / dt, delay: delay, nTransients: 1, fid: { re, im }, components: [], noiseSigma: 0, info: {} };
    }
    const f = 100, spec = synth(f);
    // Off the grid the phase is still found at the exact line centre (true phase 0 here).
    for (const fo of [100.37, -250.81]) {
        const so = S.process(synth(fo), { lb: 1, zf: 2, autoPhase: true });
        ok(Math.abs(so.phase.ph0) < 0.5, 'off-grid line at ' + fo + ' Hz: autoPhase ph0 = ' + so.phase.ph0.toFixed(3) + ' deg (true 0)');
    }
    for (const zf of [1, 2, 4]) {
        const sp = S.process(spec, { lb: 0, gb: 0, zf: zf, autoPhase: true });
        let k = 0;
        for (let i = 1; i < sp.n; i++) if (sp.mag[i] > sp.mag[k]) k = i;
        near(sp.hz[k], f, sp.hz[1] - sp.hz[0], 'zf ' + zf + ': line at +100 Hz appears at +100 Hz');
        ok(sp.ppm[k] > 4.7, 'zf ' + zf + ': higher frequency is higher ppm');
        const pk = maxIn(sp.re, sp.ppm, 4.7 + 90 / C.PPM_HZ, 4.7 + 110 / C.PPM_HZ);
        // continuous integral of A exp(-t/T2) from the first sample: A e^{-delay/T2} T2 (truncation negligible)
        near(pk.height / (A * Math.exp(-delay / T2) * T2), 1, 0.02, 'zf ' + zf + ': peak height = amplitude x T2 (spectrum scaled by dwell)');
        near(sp.phase.ph1, -360 * delay * 1000, 1e-9, 'zf ' + zf + ': autoPhase ph1 = -360 deg x delay per Hz');
        ok(Math.abs(sp.im[k]) < 0.02 * sp.re[k], 'zf ' + zf + ': autoPhased peak is absorptive (im ' + sp.im[k] + ', re ' + sp.re[k] + ')');
    }
    // Manual phase: ph1 from the delay and ph0 = 0 gives the same result as autoPhase here.
    const man = S.process(spec, { lb: 0, zf: 2, autoPhase: false, ph0: 0, ph1: -360 * delay * 1000 });
    const au = S.process(spec, { lb: 0, zf: 2, autoPhase: true });
    let dmax = 0;
    for (let k = 0; k < man.n; k++) dmax = Math.max(dmax, Math.abs(man.re[k] - au.re[k]));
    ok(dmax < 1e-3 * A * T2, 'manual ph0/ph1 convention matches autoPhase (max diff ' + dmax + ')');
    // Exponential line broadening adds lb Hz to the FWHM.
    const w0 = S.process(spec, { lb: 0, zf: 8 }), w2 = S.process(spec, { lb: 2, zf: 8 });
    const k0 = maxIn(w0.re, w0.ppm, 5, 6).k, k2 = maxIn(w2.re, w2.ppm, 5, 6).k;
    near(fwhm(w0.re, k0, w0.hz[1] - w0.hz[0]), 1 / (Math.PI * T2), 0.15, 'FWHM = 1/(pi T2*)');
    near(fwhm(w2.re, k2, w2.hz[1] - w2.hz[0]) - fwhm(w0.re, k0, w0.hz[1] - w0.hz[0]), 2, 0.15, 'lb 2 Hz broadens by 2 Hz');
}

/* ---------- 3. Peaks at the right ppm on the MRS phantom ---------- */
{
    const data = sim(FIDWS, braino, art());
    const sp = proc(data);
    const tol = 0.004;                      // ppm (0.5 Hz)
    near(peak(sp, 'NAA').ppm, 2.008, tol, 'NAA at 2.008 ppm');
    near(peak(sp, 'Cr').ppm, 3.027, tol, 'Cr CH3 at 3.027 ppm');
    near(peak(sp, 'Cr2').ppm, 3.913, tol, 'Cr CH2 at 3.913 ppm');
    near(peak(sp, 'Cho').ppm, 3.20, tol, 'Cho at 3.20 ppm');
    near(peak(sp, 'water').ppm, 4.70, tol, 'residual water at 4.70 ppm');
    // Noise-free components, each at its own lines.
    const q = proc(sim(FIDWS, braino, art({ noise: 0 })), { lb: 0, zf: 8 });
    near(maxIn(comp(q, 'NAA').re, q.ppm, 1.9, 2.1).ppm, 2.008, 0.002, 'NAA component at 2.008');
    near(maxIn(comp(q, 'Cr').re, q.ppm, 2.9, 3.1).ppm, 3.027, 0.002, 'Cr component at 3.027');
    near(maxIn(comp(q, 'Cr').re, q.ppm, 3.8, 4.0).ppm, 3.913, 0.002, 'Cr component at 3.913');
    near(maxIn(comp(q, 'Cho').re, q.ppm, 3.1, 3.3).ppm, 3.20, 0.002, 'Cho component at 3.20');
    // Lactate methyl doublet: two lines J = 6.93 Hz apart, centred on 1.31 ppm.
    const lac = comp(q, 'Lac').re;
    const a = maxIn(lac, q.ppm, 1.25, 1.31), b = maxIn(lac, q.ppm, 1.31, 1.37);
    near((b.ppm - a.ppm) * C.PPM_HZ, 6.93, 0.25, 'Lac doublet split by J = 6.93 Hz');
    near((a.ppm + b.ppm) / 2, 1.31, 0.002, 'Lac doublet centred on 1.31 ppm');
    near(a.height / b.height, 1, 0.02, 'Lac doublet lines equal (1:1)');
    // Lactate methine quartet at 4.10 ppm: lines at +-J/2 and +-3J/2 (1:3:3:1).
    const jp = 6.93 / C.PPM_HZ;
    const qa = maxIn(lac, q.ppm, 4.10 - 2 * jp, 4.10 - jp), qb = maxIn(lac, q.ppm, 4.10 - jp, 4.10);
    const qc = maxIn(lac, q.ppm, 4.10, 4.10 + jp), qd = maxIn(lac, q.ppm, 4.10 + jp, 4.10 + 2 * jp);
    near((qd.ppm - qa.ppm) * C.PPM_HZ, 3 * 6.93, 0.4, 'Lac quartet outer lines 3J apart');
    near((qc.ppm - qb.ppm) * C.PPM_HZ, 6.93, 0.4, 'Lac quartet inner lines J apart');
    near(qb.height / qa.height, 3, 0.45, 'Lac quartet inner/outer about 3 (lines overlap a little)');
    near(qc.height / qd.height, 3, 0.45, 'Lac quartet symmetric');
}

/* ---------- 4. Water suppression (CHESS) ---------- */
{
    const d0 = sim(FID, braino, art()), d1 = sim(FIDWS, braino, art());
    const s0 = proc(d0), s1 = proc(d1);
    ok(d1.info.waterSuppression > 50, 'fid_ws suppresses water more than 50 times with a good shim: ' + d1.info.waterSuppression);
    ok(peak(s0, 'water').height / peak(s1, 'water').height > 50, 'measured water peak ratio > 50: ' + peak(s0, 'water').height / peak(s1, 'water').height);
    ok(d0.info.waterSuppression === 1, 'no saturation pulses: suppression factor 1');
    // Analytic Mz for braino water (single bin at 0 Hz, Gaussian profile 1, hard pulse profile 1):
    // CHESS1 90 -> Mz 0; recover dt1; CHESS2 100 -> Mz cos100; recover dt2; excite 90.
    const rf = FIDWS.rf.filter(r => !r.dummy);
    const T1 = 1.5, dt1 = rf[1].t - rf[0].t, dt2 = rf[2].t - rf[1].t;
    let mz = 1 - Math.exp(-dt1 / T1);
    mz *= Math.cos(100 * Math.PI / 180);
    mz = 1 - (1 - mz) * Math.exp(-dt2 / T1);
    near(d1.info.relativeSignal.water, mz, 1e-6, 'suppressed water Mz from the CHESS recursion');
    const unsup = 1 - Math.exp(-(FID.stats.TR) / T1);         // 90 deg every TR, steady state
    near(d0.info.relativeSignal.water, unsup, 1e-6, 'unsuppressed water Mz = 1 - exp(-TR/T1)');
    near(d1.info.waterResidual, mz / unsup, 1e-6, 'waterResidual = suppressed / unsuppressed');
    // NAA's singlet at 2.008 ppm is 344 Hz from water, far outside the 80 Hz CHESS band.
    near(peak(s1, 'NAA').height / peak(s0, 'NAA').height, 1, 0.1, 'NAA untouched by CHESS');
    // A degraded shim spreads water over many Hz and part of it escapes the narrow CHESS band.
    const dBad = sim(FIDWS, braino, art({ b0: { susceptibility: 1, shim: 1 } }));
    ok(dBad.info.waterSuppression < d1.info.waterSuppression / 3, 'poor shim spoils water suppression: ' + dBad.info.waterSuppression);
}

/* ---------- 5. Shim: lines broaden when the shim is degraded ---------- */
{
    const good = sim(FIDWS, braino, art({ noise: 0 }));
    const bad = sim(FIDWS, braino, art({ noise: 0, b0: { susceptibility: 1, shim: 1 } }));
    near(good.info.linewidthHz, 1 / (Math.PI * 0.30) + 1, 0.05, 'braino water FWHM with a perfect field = 1/(pi T2) + 1 Hz');
    ok(bad.info.linewidthHz > 4 * good.info.linewidthHz, 'water linewidth grows with shim 1: ' + good.info.linewidthHz + ' -> ' + bad.info.linewidthHz);
    const pg = proc(good, { lb: 0, zf: 8 }), pb = proc(bad, { lb: 0, zf: 8 });
    const ng = maxIn(comp(pg, 'NAA').re, pg.ppm, 1.9, 2.1), nb = maxIn(comp(pb, 'NAA').re, pb.ppm, 1.8, 2.2);
    const fg = fwhm(comp(pg, 'NAA').re, ng.k, pg.hz[1] - pg.hz[0]), fb = fwhm(comp(pb, 'NAA').re, nb.k, pb.hz[1] - pb.hz[0]);
    near(fg, 1 / (Math.PI * 0.25) + 1, 0.1, 'NAA FWHM with a good shim = 1/(pi T2) + 1 Hz');
    ok(fb > fg + 5, 'NAA broadens measurably with shim 1: ' + fg.toFixed(2) + ' -> ' + fb.toFixed(2) + ' Hz');
    ok(nb.height < 0.5 * ng.height, 'and its peak drops (same area, wider line)');
    // The shim panel's water line agrees with info.linewidthHz.
    const wl = S.waterLine(braino, { b0Map: MRI.fields.b0Map(braino, { susceptibility: 1, shim: 1 }), artifacts: art() });
    near(wl.fwhmHz, bad.info.linewidthHz, 1e-9, 'waterLine() gives the same FWHM');
    ok(bad.info.notes.some(s => /shim/i.test(s)), 'a note explains the broad line');
}

/* ---------- 6. SNR scales as sqrt(NA); the noise calibration ---------- */
{
    const p16 = FID, p4 = compile('fid', { NA: 4 }), p64 = compile('fid', { NA: 64 });
    const a = sim(p4, braino, art()), b = sim(p64, braino, art());
    near(a.noiseSigma / b.noiseSigma, 4, 1e-9, 'noise SD ratio NA 4 vs 64 = sqrt(16)');
    let r4 = 0, r16 = 0, r64 = 0;
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    for (const s of seeds) {
        r4 += proc(sim(p4, braino, art(), s)).metrics.snr;
        r16 += proc(sim(p16, braino, art(), s)).metrics.snr;
        r64 += proc(sim(p64, braino, art(), s)).metrics.snr;
    }
    r4 /= seeds.length; r16 /= seeds.length; r64 /= seeds.length;
    near(r64 / r4, 4, 0.3, 'SNR(NA 64) / SNR(NA 4) = 4');
    near(r16 / r4, 2, 0.15, 'SNR(NA 16) / SNR(NA 4) = 2');
    ok(r16 > 30 && r16 < 60, 'braino fid NA 16, lb 1 Hz: NAA SNR ' + r16.toFixed(1) + ' in 30..60');
    const ws = proc(sim(FIDWS, braino, art())).metrics.snr;
    ok(ws > 30 && ws < 60, 'and with water suppression: ' + ws.toFixed(1));
    // Noise grows as sqrt(SW) per sample, so the spectral noise for a fixed acquisition time does not.
    const w8 = compile('fid', { SW: 8000, NP: 4096 });
    near(sim(w8, braino, art()).noiseSigma / sim(FID, braino, art()).noiseSigma, Math.SQRT2, 1e-9, 'noise per sample scales as sqrt(SW)');
    // Seeded, reproducible noise.
    const x1 = sim(FID, braino, art(), 5), x2 = sim(FID, braino, art(), 5), x3 = sim(FID, braino, art(), 6);
    ok(x1.fid.re[100] === x2.fid.re[100] && x1.fid.re[100] !== x3.fid.re[100], 'same seed, same noise; new seed, new noise');
    // noise 0: the FID is exactly the sum of the components and there is no SNR to report.
    const z = sim(FID, braino, art({ noise: 0 }));
    let dev = 0;
    for (let j = 0; j < z.n; j++) {
        let r = 0, i = 0;
        for (const c of z.components) { r += c.re[j]; i += c.im[j]; }
        dev = Math.max(dev, Math.abs(r - z.fid.re[j]), Math.abs(i - z.fid.im[j]));
    }
    ok(dev < 1e-9, 'noise 0: fid = sum of components');
    ok(proc(z).metrics.snr === null, 'noise 0: snr is null');
}

/* ---------- 7. Short TR: T1 saturation from the Mz model ---------- */
{
    // NP 1024 so a 300 ms TR fits the 256 ms acquisition.
    const long = compile('fid', { TR: 3, NP: 1024 }), short = compile('fid', { TR: 0.3, NP: 1024 });
    const dl = sim(long, braino, art({ noise: 0 })), ds = sim(short, braino, art({ noise: 0 }));
    // Steady state for flip a every TR: Mz = (1 - E1)/(1 - E1 cos a), signal Mz sin a,
    // with a = 90 deg x sinc(f dur) (the 0.1 ms hard pulse's profile at the line frequency).
    function expected(TR, group) {
        const lines = group === 'water' ? [{ ppm: 4.7, nH: 1 }] : MRI.tissues.metabolites[group].lines;
        const T1 = group === 'water' ? 1.5 : MRI.tissues.metabolites[group].t1;
        let num = 0, den = 0;
        for (const l of lines) {
            const a = Math.PI / 2 * sincp((l.ppm - 4.7) * C.PPM_HZ * 1e-4), E1 = Math.exp(-TR / T1);
            num += l.nH * (1 - E1) / (1 - E1 * Math.cos(a)) * Math.sin(a);
            den += l.nH;
        }
        return num / den;
    }
    for (const g of ['water', 'NAA', 'Cr', 'Cho']) {
        near(dl.info.relativeSignal[g], expected(3, g), 2e-4, g + ' relative signal at TR 3 s');
        near(ds.info.relativeSignal[g], expected(0.3, g), 2e-4, g + ' relative signal at TR 300 ms');
    }
    // The acquired amplitude (first FID point of each component) falls by the same factor.
    for (const g of ['water', 'NAA']) {
        const cl = dl.components.find(c => c.id === g), cs = ds.components.find(c => c.id === g);
        const ratio = Math.hypot(cs.re[0], cs.im[0]) / Math.hypot(cl.re[0], cl.im[0]);
        near(ratio, expected(0.3, g) / expected(3, g), 2e-3, g + ' signal ratio TR 300 ms / 3 s = ' + ratio.toFixed(4));
    }
    ok(ds.info.relativeSignal.NAA < 0.25 && ds.info.notes.some(s => /T1/.test(s)), 'short TR is flagged in the notes');
}

/* ---------- 8. autoPhase removes the first-order phase of a 2 ms delay ---------- */
{
    const p = compile('fid_ws', { delay: 2e-3 });
    const d = sim(p, braino, art({ noise: 0 }));
    near(d.delay, 2e-3, 1e-9, 'delay 2 ms');
    const sp = proc(d, { lb: 1, zf: 4 });
    near(sp.phase.ph1, -720, 1e-6, 'ph1 = -360 deg x 2 ms = -720 deg/kHz');
    const naa = comp(sp, 'NAA');
    const pk = maxIn(naa.re, sp.ppm, 1.95, 2.06);
    ok(pk.height > 0, 'NAA real peak is positive');
    near(pk.ppm, 2.008, 0.002, 'at 2.008 ppm');
    const imPk = at(naa.im, sp.ppm, pk.ppm);
    ok(Math.abs(imPk) < 0.03 * pk.height, 'dispersion part at the peak is small (' + (imPk / pk.height).toFixed(4) + ')');
    const dp = 2 / C.PPM_HZ;                   // 2 Hz either side
    const l = at(naa.re, sp.ppm, pk.ppm - dp), r = at(naa.re, sp.ppm, pk.ppm + dp);
    ok(Math.abs(l - r) < 0.03 * pk.height, 'NAA line is symmetric (' + l.toFixed(4) + ' vs ' + r.toFixed(4) + ')');
    // Without phasing the same line is a mess: 2 ms at -344 Hz is about -248 degrees of phase.
    const raw = proc(d, { lb: 1, zf: 4, autoPhase: false, ph0: 0, ph1: 0 });
    ok(at(comp(raw, 'NAA').re, raw.ppm, 2.008) < 0.5 * pk.height, 'unphased NAA real part is far from absorptive');
    // Every component is phased with the same ph0 and ph1 as the total.
    const tot = proc(sim(p, braino, art()), { lb: 1, zf: 4 });
    near(maxIn(tot.re, tot.ppm, 1.95, 2.06).ppm, 2.008, 0.003, 'NAA in the phased total spectrum at 2.008');
}

/* ---------- 9. The whole head: lipid and water dominate ---------- */
{
    const d = sim(FID, brain, art());
    const sp = proc(d);
    const naaComp = maxIn(comp(sp, 'NAA').re, sp.ppm, 1.95, 2.06).height;
    ok(peak(sp, 'lipid13').height > 20 * naaComp, 'lipid at 1.3 ppm is more than 20 times NAA: ' + (peak(sp, 'lipid13').height / naaComp).toFixed(0));
    const tall = sp.metrics.tallestPpm;
    ok(Math.abs(tall - 4.7) < 0.1 || Math.abs(tall - 1.3) < 0.1, 'tallest peak is water or lipid: ' + tall.toFixed(2) + ' ppm');
    ok(peak(sp, 'water').height > 1000 * naaComp, 'water is three orders of magnitude above NAA');
    ok(d.info.notes.some(s => /lipid dominates/i.test(s) && /whole head/i.test(s)), 'note: scalp lipid dominates');
    const dws = sim(FIDWS, brain, art());
    const spws = proc(dws);
    ok(spws.metrics.tallestPpm > 1.2 && spws.metrics.tallestPpm < 1.4, 'with water suppressed, lipid 1.3 is the tallest peak');
    ok(dws.info.waterSuppression < 50, 'the sinus field makes water suppression of the whole head poor: ' + dws.info.waterSuppression.toFixed(1));
    ok(brain.tissues.some(t => t.id === 'fat') && d.components.some(c => c.id === 'lipid'), 'brain has a lipid component');
}

/* ---------- 10. NAA/Cr on the MRS phantom ---------- */
{
    const d = sim(FIDWS, braino, art({ noise: 0 }));
    const sp = proc(d);                                  // lb 1, zf 2
    /* Expected from the model: concentration ratio (12.5 x 3)/(10 x 3) times the
       T1 saturation of each singlet times the fraction of each Lorentzian that
       falls inside its integration window (T2 sets the width). */
    const lw = (T2) => 1 / (Math.PI * T2) + 1 + 1;        // natural + unresolved (1 Hz) + lb (1 Hz)
    const inWin = (ppm0, lo, hi, w) => (Math.atan((hi - ppm0) * C.PPM_HZ / (w / 2)) - Math.atan((lo - ppm0) * C.PPM_HZ / (w / 2))) / Math.PI;
    const t1f = (T1) => 1 - Math.exp(-3 / T1);
    const expNAA = 12.5 * 3 * t1f(1.40) * Math.exp(-0.25e-3 / 0.25) * inWin(2.008, 1.9, 2.1, lw(0.25));
    const expCr = 10 * 3 * t1f(1.30) * Math.exp(-0.25e-3 / 0.15) * inWin(3.027, 2.95, 3.1, lw(0.15));
    const expected = expNAA / expCr;
    near(sp.metrics.componentRatios.NAA_Cr, expected, 0.05 * expected,
        'NAA/Cr from the NAA and Cr signals = 1.25 x T1/T2 weighting (' + expected.toFixed(3) + ')');
    near(sp.metrics.componentRatios.NAA_Cr, 1.25, 0.15, 'close to the concentration ratio 1.25');
    // The integral over 1.9-2.1 ppm of the whole spectrum also holds glutamate (2.04 ppm).
    const naaWin = S.ratioWindows.NAA, crWin = S.ratioWindows.Cr;
    ok(naaWin[0] === 1.9 && naaWin[1] === 2.1 && crWin[0] === 2.95 && crWin[1] === 3.1, 'ratio windows per contract');
    ok(sp.metrics.ratios.NAA_Cr > sp.metrics.componentRatios.NAA_Cr, 'window NAA/Cr includes the glutamate under NAA: ' + sp.metrics.ratios.NAA_Cr.toFixed(2));
    near(sp.metrics.componentRatios.Cho_Cr, (3 * 9 * t1f(1.2)) / (10 * 3 * t1f(1.3)), 0.12, 'Cho/Cr close to the weighted concentration ratio');
}

/* ---------- 11. Spin echo: chemical shift refocused, lactate J-modulated ---------- */
{
    const se = (te) => MRI.dsl.compile([
        'sequence "Spin-echo spectroscopy"',
        'param TE = ' + te + ' ms',
        'dummies 1',
        'repeat 2 every 3000 ms',
        '    rf 90 hard dur 0.1 ms as exc',
        '    rf 180 hard dur 0.2 ms at exc + TE/2',
        '    adc 2048 dwell 250 us at exc + TE',
        'end'].join('\n'));
    const p144 = se(144), p288 = se(288);
    ok(p144.ok && p288.ok, 'spin-echo programs compile');
    const d144 = sim(p144, braino, art({ noise: 0 })), d288 = sim(p288, braino, art({ noise: 0 }));
    near(d144.delay, 0, 1e-9, 'after a refocusing pulse the phase clock restarts at the echo (delay 0)');
    near(d144.te, 0.144, 1e-9, 'te = time since excitation');
    const s144 = proc(d144, { lb: 1 }), s288 = proc(d288, { lb: 1 });
    const lac144 = at(comp(s144, 'Lac').re, s144.ppm, 1.31 - 3.465 / C.PPM_HZ);
    const lac288 = at(comp(s288, 'Lac').re, s288.ppm, 1.31 - 3.465 / C.PPM_HZ);
    ok(lac144 < 0, 'lactate doublet inverted at TE 144 ms (1/J)');
    ok(lac288 > 0, 'and upright at TE 288 ms');
    const naa144 = maxIn(comp(s144, 'NAA').re, s144.ppm, 1.95, 2.06), naa288 = maxIn(comp(s288, 'NAA').re, s288.ppm, 1.95, 2.06);
    ok(naa144.height > 0 && naa288.height > 0, 'singlets stay upright in a spin echo');
    near(naa288.height / naa144.height, Math.exp(-0.144 / 0.25), 0.03, 'NAA decays as exp(-TE/T2) between the echoes');
    ok(d144.info.notes.some(s => /J-modulated/.test(s)), 'note on J modulation');
}

/* ---------- 12. Guards, B1, hardware faults ---------- */
{
    let msg = '';
    try { sim(compile('se'), braino, art()); } catch (e) { msg = e.message; }
    ok(/gradient/.test(msg) && /ADC/.test(msg), 'an imaging sequence is refused with a clear message: ' + msg.slice(0, 60));
    msg = '';
    try { S.simulate({ ok: false }, braino, {}, {}); } catch (e) { msg = e.message; }
    ok(/compile/.test(msg), 'a failed program is refused');
    // ctx without b0Map: the field is computed from artifacts.b0
    const d1 = S.simulate(FID, braino, { artifacts: art({ b0: { susceptibility: 1, shim: 1 } }) }, { seed: 1 });
    const d2 = sim(FID, braino, art({ b0: { susceptibility: 1, shim: 1 } }));
    ok(d1.fid.re[10] === d2.fid.re[10], 'missing b0Map is computed from artifacts.b0');
    // B1 inhomogeneity: water suppression depends on the flip angle
    const b1 = sim(FIDWS, brain, art({ b1: { amount: 0.4 } }));
    const b0 = sim(FIDWS, brain, art());
    ok(Math.abs(b1.info.waterSuppression - b0.info.waterSuppression) > 0.5 && b1.info.notes.some(s => /B1/.test(s)),
        'B1 inhomogeneity changes water suppression: ' + b0.info.waterSuppression.toFixed(1) + ' -> ' + b1.info.waterSuppression.toFixed(1));
    // Zipper: a spurious narrow line at the interference frequency (aliased into the spectral width)
    const zp = proc(sim(FIDWS, braino, art({ zipper: { on: true, offsetHz: 1500, amp: 0.02 } })));
    let kz = 0;
    for (let k = 0; k < zp.n; k++) if (zp.hz[k] > 1400 && zp.hz[k] < 1600 && zp.mag[k] > zp.mag[kz]) kz = k;
    near(zp.hz[kz], 1500, 2, 'zipper line at +1500 Hz');
    // Spike: one bad sample spreads over the whole spectrum as a ripple and raises the apparent
    // noise (measured without apodisation, which would damp a spike late in the FID).
    const sk = proc(sim(FIDWS, braino, art({ spike: { on: true, amp: 50, at: 0.37 } })), { lb: 0 });
    const sk0 = proc(sim(FIDWS, braino, art()), { lb: 0 });
    ok(sk.metrics.noiseSd > 2 * sk0.metrics.noiseSd, 'spike raises the baseline noise: ' + sk0.metrics.noiseSd.toFixed(4) + ' -> ' + sk.metrics.noiseSd.toFixed(4));
}

/* ---------- 13. User errors are marked for the app ---------- */
{
    const errOf = (fn) => { try { fn(); } catch (e) { return e; } return null; };
    const e1 = errOf(() => sim(compile('se'), braino, art()));
    const e2 = errOf(() => S.simulate({ ok: false }, braino, {}, {}));
    const noAdc = MRI.dsl.compile('sequence "x"\nrepeat 2 every 1000 ms\n    rf 90 hard dur 0.1 ms\nend');
    const e3 = errOf(() => sim(noAdc, braino, art()));
    const e4 = errOf(() => S.simulate(FID, null, {}, {}));
    ok([e1, e2, e3, e4].every(e => e && e.userMessage === true),
        'user-facing errors carry userMessage (imaging sequence, failed compile, no ADC, no phantom): ' + [e1, e2, e3, e4].map(e => e && e.message.slice(0, 30)).join(' / '));
}

/* ---------- 14. The peak table never shows a negative height, area or SNR ----------
   A peak that cannot be measured (no maximum inside its window, not above
   the local baseline, a negative area, or under 3 noise SD) has null
   height, area and snr and a reason. Swept over settings that used to give
   negative numbers: truncation (NP 256), a long delay, a 5 degree flip, a
   poor shim, the brain and the water-and-fat phantom, with and without noise. */
{
    const settings = [['fid', {}], ['fid', { NP: 256 }], ['fid', { delay: 0.005 }], ['fid', { flip: 5 }], ['fid_ws', {}], ['fid_ws', { NP: 512 }]];
    let bad = [], checked = 0, nullRows = 0;
    for (const [id, ov] of settings) for (const ph of [braino, brain, phantom('waterfat')]) for (const shim of [0, 1]) for (const noise of [0, 1]) {
        const d = sim(compile(id, ov), ph, art({ noise: noise, b0: { susceptibility: 1, shim: shim } }));
        const sp = proc(d);
        for (const q of sp.peaks) {
            checked++;
            const vals = [q.height, q.area, q.snr];
            if (vals.some(v => v !== null && !(v > 0))) bad.push(id + JSON.stringify(ov) + ' ' + ph.id + ' shim ' + shim + ' noise ' + noise + ' ' + q.id + ': ' + vals.join(', '));
            if (q.resolved !== (q.height !== null) || (q.resolved && q.area === null) || (!q.resolved && !q.reason)) bad.push(q.id + ': resolved flag inconsistent');
            if (noise && q.resolved && q.height < 3 * sp.metrics.noiseSd) bad.push(q.id + ': resolved below 3 SD');
            if (!q.resolved) nullRows++;
        }
        const r = sp.metrics.ratios, rc = sp.metrics.componentRatios;
        for (const v of [r.NAA_Cr, r.Cho_Cr, rc.NAA_Cr, rc.Cho_Cr]) if (v !== null && !(v > 0)) bad.push(id + ' ' + ph.id + ': ratio ' + v);
        if (sp.metrics.snr !== null && !(sp.metrics.snr > 0)) bad.push(id + ' ' + ph.id + ': snr ' + sp.metrics.snr);
    }
    ok(bad.length === 0, 'no negative or zero height, area, SNR or ratio in ' + checked + ' peak rows (' + nullRows + ' not resolved)' + (bad.length ? ': ' + bad.slice(0, 4).join(' | ') : ''));
    // No metabolites, no metabolite ratios.
    const wf = proc(sim(FID, phantom('waterfat'), art()));
    ok(wf.metrics.ratios.NAA_Cr === null && wf.metrics.ratios.Cho_Cr === null && wf.metrics.componentRatios.NAA_Cr === null,
        'water and fat phantom: no NAA/Cr or Cho/Cr (no metabolites)');
    // Glx: the flanks of its window hold NAA lines; the area is positive and near the Glu + Gln lines' own integral.
    const q = proc(sim(FIDWS, braino, art({ noise: 0 })));
    const g = peak(q, 'Glx');
    let own = 0;
    const glx = ['Glu', 'Gln'].map(id => comp(q, id)).filter(Boolean);          // braino has no glutamine
    for (let k = 0; k < q.n; k++) if (q.ppm[k] >= g.window[0] && q.ppm[k] <= g.window[1]) for (const c of glx) own += c.re[k];
    own *= q.hz[1] - q.hz[0];
    ok(g.resolved && g.area > 0.75 * own && g.area < 1.1 * own, 'Glx area positive and close to the glutamate lines\' own integral: ' + g.area.toFixed(3) + ' vs ' + own.toFixed(3));
    // Truncation sinc ripple does not drag the baseline down: a centre frequency between grid points changes nothing.
    const at0 = proc(sim(FID, braino, art({ noise: 0 }))), at20 = proc(sim(FID, braino, art({ noise: 0, b0: { susceptibility: 1, shim: 0, shimCoeffs: { z0: 20 } } })));
    near(peak(at20, 'Glx').area / peak(at0, 'Glx').area, 1, 0.08, 'Glx area does not depend on where the lines fall on the frequency grid');
    near(at20.metrics.ratios.NAA_Cr / at0.metrics.ratios.NAA_Cr, 1, 0.06, 'nor does the window NAA/Cr');
}

/* ---------- 15. Peak windows follow water (a Z0 error) ---------- */
{
    const off = 20 / C.PPM_HZ;                    // a 20 Hz centre-frequency error
    const b0 = { susceptibility: 1, shim: 0, shimCoeffs: { z0: 20 } };
    const s0 = proc(sim(FIDWS, braino, art())), s1 = proc(sim(FIDWS, braino, art({ b0: b0 })));
    near(s1.metrics.waterOffsetPpm, off, 0.01, 'water found ' + s1.metrics.waterOffsetPpm.toFixed(3) + ' ppm off (Z0 20 Hz = ' + off.toFixed(3) + ' ppm)');
    let worst = 0;
    for (const id of ['NAA', 'Cr', 'Cho', 'Cr2']) {
        const a = peak(s0, id), b = peak(s1, id);
        ok(b.resolved && Math.abs(b.ppm - off - a.ppm) < 0.005, id + ' found at its shifted position (' + b.ppm.toFixed(3) + ' ppm)');
        worst = Math.max(worst, Math.abs(b.height / a.height - 1));
    }
    ok(worst < 0.1, 'and with the same heights (worst ' + (100 * worst).toFixed(1) + '%)');
    ok(s1.notes.some(t => /moved by \+0\.16 ppm/.test(t)), 'a note says the windows moved: ' + s1.notes.join(' | '));
    ok(s0.notes.length === 0 && Math.abs(s0.metrics.waterOffsetPpm) < 0.01, 'no shift and no note when water is on 4.7 ppm');
}

/* ---------- 15b. The windows follow water over the whole Z0 range ----------
   Z0 reaches +/-100 Hz (0.78 ppm). Water just outside a +/-0.3 ppm search
   window used to let the rising tail of the line pass for water (a false
   +0.29 ppm shift, NAA "dominated by water"). The windows now follow the
   water line the simulator knows. */
{
    const PPM_HZ = C.PPM_HZ;
    const z0art = z0 => art({ b0: { susceptibility: 1, shim: 0, shimCoeffs: { z0: z0 } } });
    const s0 = proc(sim(FIDWS, braino, art()));
    for (const z0 of [60, 90, 100, -100]) {
        for (const [name, prog, ph] of [['braino fid_ws', FIDWS, braino], ['braino fid', FID, braino], ['brain fid', FID, brain]]) {
            const d = sim(prog, ph, z0art(z0)), sp = proc(d);
            const w = comp(sp, 'water');
            const truth = maxIn(w.re.map(Math.abs), sp.ppm, 4.7 - 1.2, 4.7 + 1.2).ppm - 4.7;
            // (the brain's own susceptibility field moves its water line by about 2 Hz)
            near(d.info.waterPeakHz, z0, 3, name + ' Z0 ' + z0 + ' Hz: info.waterPeakHz = ' + d.info.waterPeakHz.toFixed(2) + ' Hz');
            near(sp.metrics.waterOffsetPpm, truth, 0.01, name + ' Z0 ' + z0 + ' Hz: windows moved by ' + sp.metrics.waterOffsetPpm.toFixed(3) +
                ' ppm, water line at ' + truth.toFixed(3));
            if (prog === FIDWS) {
                const off = sp.metrics.waterOffsetPpm;
                for (const id of ['NAA', 'Cr', 'Cho']) {
                    const a = peak(s0, id), b = peak(sp, id);
                    ok(b.resolved && !b.contaminatedBy && Math.abs(b.ppm - off - a.ppm) < 0.01,
                        name + ' Z0 ' + z0 + ' Hz: ' + id + ' found at ' + (b.ppm === null ? '-' : b.ppm.toFixed(3)) + ' ppm, ' + (b.contaminatedBy || 'clean'));
                }
                ok(sp.metrics.snrPeak === 'NAA', name + ' Z0 ' + z0 + ' Hz: SNR from NAA (' + sp.metrics.snrPeak + ')');
            }
        }
    }
    // Beyond the range the windows can follow (1 ppm) they stay at the nominal ppm, and a note says why.
    const far = proc(sim(FIDWS, braino, z0art(140)));
    ok(far.metrics.waterOffsetPpm === 0 && far.notes.some(t => /too far from 4\.70/.test(t)), 'water 1.1 ppm off is not followed, with a note: ' + far.notes.join(' | '));
    // A re-referenced spectrum (water put back on 4.70 ppm) needs no shift.
    const d100 = sim(FIDWS, braino, z0art(100));
    const reref = proc(d100, { refPpm: 4.7 - d100.info.waterPeakHz / PPM_HZ });
    ok(Math.abs(reref.metrics.waterOffsetPpm) < 0.005 && peak(reref, 'NAA').resolved, 're-referenced: no shift, NAA found (' + reref.metrics.waterOffsetPpm.toFixed(4) + ')');
    // SpecData without info.waterPeakHz: detection is the fallback, and either finds the water line or leaves the windows alone.
    for (const z0 of [20, 40, 60, 80, 90, 100, -100]) {
        for (const [name, prog, ov] of [['fid', 'fid', {}], ['fid NP 256', 'fid', { NP: 256 }], ['fid_ws', 'fid_ws', {}]]) {
            const d = sim(compile(prog, ov), braino, z0art(z0));
            const water = d.info.waterPeakHz / PPM_HZ;
            delete d.info.waterPeakHz;
            const off = proc(d).metrics.waterOffsetPpm;
            ok(off === 0 || Math.abs(off - water) < 0.02, 'fallback, braino ' + name + ' Z0 ' + z0 + ' Hz: shift ' + off.toFixed(3) + ' ppm (water at ' + water.toFixed(3) + ')');
        }
    }
}

/* ---------- 16. NAA under scalp lipid ---------- */
{
    const d = sim(FID, brain, art()), sp = proc(d);
    const naa = peak(sp, 'NAA');
    const own = maxIn(comp(sp, 'NAA').re, sp.ppm, 1.9, 2.1).height;
    ok(naa.contaminatedBy === 'lipid' && sp.metrics.snrPeak === 'NAA (under lipid)', 'brain: the NAA window is flagged as lipid-dominated');
    near(sp.metrics.snr, own / sp.metrics.noiseSd, 0.06 * sp.metrics.snr, 'brain: SNR is the NAA component height over the noise SD (' + sp.metrics.snr.toFixed(1) + ')');
    ok(naa.height / sp.metrics.noiseSd > 10 * sp.metrics.snr, 'and far below the SNR of the lipid peak in the window (' + (naa.height / sp.metrics.noiseSd).toFixed(0) + ')');
    ok(sp.notes.some(t => /lipid/.test(t) && /SNR/.test(t)), 'a note explains the SNR');
    ok(peak(sp, 'Lac').contaminatedBy === 'lipid' && peak(sp, 'Cr').contaminatedBy === null, 'Lac sits under lipid 1.3; Cr (CH3) does not');
    ok(sp.metrics.ratios.NAA_Cr === null && sp.metrics.componentRatios.NAA_Cr > 1, 'window NAA/Cr withheld when lipid fills the window; the per-metabolite ratio stays');
    const b = proc(sim(FID, braino, art()));
    ok(peak(b, 'NAA').contaminatedBy === null && b.metrics.snrPeak === 'NAA' && b.notes.length === 0, 'MRS phantom: NAA is NAA');
}

/* ---------- 17. Notes: T1, truncation, broad lines ---------- */
{
    const t1 = (d) => d.info.notes.filter(t => /short compared with T1|T1-weighted/.test(t));
    // CHESS suppresses water; that is not T1 saturation.
    const wf = phantom('waterfat');
    const ws = sim(FIDWS, wf, art());
    ok(t1(ws).length === 0, 'water and fat with CHESS: no T1 note blaming T1 for the suppressed water (' + t1(ws).join('') + ')');
    // Without NAA the note uses the lipid (oil T1 0.28 s at TR 300 ms).
    const short = sim(compile('fid', { TR: 0.3, NP: 1024 }), wf, art());
    ok(t1(short).length === 1 && /lipid at/.test(t1(short)[0]), 'water and fat at TR 300 ms: the T1 note names lipid: ' + t1(short).join(''));
    // A small flip leaves Mz nearly fully relaxed: no T1 note at TR 3 s.
    const f30 = sim(compile('fid', { flip: 30 }), braino, art());
    ok(t1(f30).length === 0, 'flip 30 degrees at TR 3 s: no T1 note (the small signal is the flip angle, not saturation)');
    const s300 = sim(compile('fid', { TR: 0.3, NP: 1024 }), braino, art());
    ok(t1(s300).length === 1 && /NAA at 1\d percent/.test(t1(s300)[0]), 'TR 300 ms on braino: NAA at about 19 percent: ' + t1(s300).join(''));
    // Truncation.
    const trunc = (d) => d.info.notes.some(t => /truncated/.test(t) && /sinc/.test(t));
    ok(trunc(sim(compile('fid', { NP: 256 }), braino, art())), 'NP 256 (64 ms): truncation note');
    ok(!trunc(sim(FID, braino, art())), 'NP 2048 (512 ms): no truncation note');
    // Broad lines.
    const broad = (d) => d.info.notes.some(t => /too broad/.test(t) && /[Ss]him first/.test(t));
    ok(broad(sim(FID, braino, art({ b0: { susceptibility: 1, shim: 1 } }))), 'unshimmed: "lines too broad, shim first"');
    ok(!broad(sim(FID, braino, art())) && !broad(sim(FID, brain, art())), 'shimmed braino and the brain (7.6 Hz): no such note');
    // ... and the peak table agrees with that note: with the water line over 10 Hz
    // no metabolite is reported (CHESS on, water not found, the NAA hump used to be
    // credited to Glx), while water and lipid rows are still measured.
    const unshim = art({ b0: { susceptibility: 1, shim: 1 } });
    for (const [label, p] of [['fid', FID], ['fid_ws', FIDWS]]) {
        const sp = proc(sim(p, braino, unshim));
        const metab = sp.peaks.filter(q => ['Cr2', 'mI', 'Cho', 'Cr', 'Glx', 'NAA', 'Lac'].includes(q.id));
        ok(metab.every(q => !q.resolved && q.height === null && q.snr === null && /too broad/.test(q.reason)),
            'unshimmed braino ' + label + ': every metabolite row not resolved, "too broad" (' + metab.filter(q => q.resolved).map(q => q.id).join(' ') + ')');
        ok(sp.metrics.snr === null && /too broad/.test(sp.metrics.snrPeak), 'unshimmed braino ' + label + ': no NAA SNR (' + sp.metrics.snrPeak + ')');
    }
    // (The windows follow the true water line, 25 Hz off here; the scalp lipid sits in a
    // different part of the unshimmed field, so its 1.3 ppm row may fall at its window's edge.)
    const ub = proc(sim(FID, brain, unshim));
    const ul = peak(ub, 'lipid13');
    ok(peak(ub, 'water').resolved && !peak(ub, 'NAA').resolved && /too broad/.test(peak(ub, 'NAA').reason) && (ul.resolved || /no maximum/.test(ul.reason)),
        'unshimmed brain: water still measured, NAA not ("too broad"); lipid 1.3 ' + (ul.resolved ? 'measured' : ul.reason));
    const okBrain = proc(sim(FID, brain, art()));
    ok(peak(okBrain, 'Cho').resolved && okBrain.metrics.snr > 0, 'shimmed brain (7.6 Hz): metabolites still reported, NAA SNR ' + okBrain.metrics.snr.toFixed(1));
}

/* ---------- 18. Speed ---------- */
{
    const ctx = { b0Map: MRI.fields.b0Map(braino, { susceptibility: 1, shim: 0 }), artifacts: art() };
    let t = Date.now();
    S.simulate(FID, braino, ctx, { seed: 3 });
    const cold = Date.now() - t;
    t = Date.now();
    for (let i = 0; i < 3; i++) S.simulate(FID, braino, ctx, { seed: 3 + i });
    const warm = (Date.now() - t) / 3;
    ok(warm < 200, 'fid on braino, NP 2048, NA 16: ' + warm.toFixed(0) + ' ms (first call ' + cold + ' ms)');
    const bctx = { b0Map: MRI.fields.b0Map(brain, { susceptibility: 1, shim: 1 }), artifacts: art() };
    t = Date.now();
    S.simulate(FIDWS, brain, bctx, { seed: 3 });
    const tb = Date.now() - t;
    ok(tb < 400, 'fid_ws on the brain with a poor shim: ' + tb + ' ms');
    t = Date.now();
    const d = S.simulate(FID, braino, ctx, { seed: 3 });
    S.process(d, S.defaults);
    t = Date.now();
    S.process(d, S.defaults);
    ok(Date.now() - t < 50, 'process under 50 ms: ' + (Date.now() - t) + ' ms');
    console.log('  timing: braino fid ' + warm.toFixed(0) + ' ms (cold ' + cold + ' ms), brain fid_ws shim 1 ' + tb + ' ms');
}

summary('spectro');
