'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner']);
const U = PET.util, S = PET.scanner, G = S.geom;

// Geometry
near(G.crystalPitch, 4.09, 0.01, 'crystal pitch');
ok(G.nA === G.nCrystals / 2, 'one angle per crystal-pair rotation');
{
    const l = S.lorFromPoints(-100, 30, 100, 30);       // horizontal line y = 30
    near(l.theta, Math.PI / 2, 1e-9, 'horizontal LOR has normal along y');
    near(l.r, 30, 1e-9, 'horizontal LOR r = y');
    const b = S.binOf(l.r, l.theta);
    ok(b.a === 96 && b.i === 95, 'binOf for y = 30 line (a ' + b.a + ', i ' + b.i + ')');
    const e = S.lorEndpoints(0, 80);                    // t = 0, r = 0: vertical line x = 0
    near(e.x1, 0, 1e-9, 'endpoint x'); near(Math.abs(e.y1), 250, 1e-9, 'endpoint on ring');
    ok(Math.abs(e.cA - e.cB) === 192, 'central LOR joins opposite crystals');
}

// Projector: line integral of a uniform disk of radius 80 mm, value 1, is the chord length 2 sqrt(80^2 - r^2)
function disk(n, fov, R, val, cx, cy) {
    const img = new Float32Array(n * n), dx = fov / n, h = n / 2;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        // 4x4 supersampling so the edge has partial-volume values
        let f = 0;
        for (let q = 0; q < 16; q++) {
            const x = (ix - h + ((q % 4) + 0.5) / 4 - 0.5) * dx - (cx || 0), y = (iy - h + (Math.floor(q / 4) + 0.5) / 4 - 0.5) * dx - (cy || 0);
            if (x * x + y * y <= R * R) f++;
        }
        img[iy * n + ix] = val * f / 16;
    }
    return img;
}
for (const n of [128, 256]) {
    const P = S.projector({ n });
    const img = disk(n, G.fov, 80, 1);
    const t0 = Date.now();
    const sino = P.forward(img);
    const ms = Date.now() - t0;
    let err = 0;
    for (const a of [0, 31, 96, 150]) for (const i of [80, 60, 100, 45]) {
        const r = G.radius(i), exp = r * r < 6400 ? 2 * Math.sqrt(6400 - r * r) : 0;
        err = Math.max(err, Math.abs(sino[a * G.nR + i] - exp));
    }
    ok(err < 1.5, 'disk chord lengths n=' + n + ' (max err ' + err.toFixed(3) + ' mm)');
    console.log('    forward n=' + n + ': ' + ms + ' ms');
    // adjoint test <P x, y> = <x, P^T y>
    const rng = U.rng(3);
    const y = new Float32Array(P.size); for (let k = 0; k < y.length; k++) y[k] = rng();
    const t1 = Date.now();
    const bty = P.back(y);
    console.log('    back n=' + n + ': ' + (Date.now() - t1) + ' ms');
    let lhs = 0, rhs = 0;
    for (let k = 0; k < y.length; k++) lhs += sino[k] * y[k];
    for (let k = 0; k < img.length; k++) rhs += img[k] * bty[k];
    near(lhs / rhs, 1, 1e-4, 'projector adjointness n=' + n);
}

// TOF: summing over TOF bins gives the non-TOF projection; the TOF profile peaks where the source is
{
    const n = 128, P = S.projector({ n }), PT = S.projector({ n, tof: { sigma: S.timing.sigmaPos(400e-12) } });
    near(S.timing.sigmaPos(400e-12), 25.5, 0.2, 'TOF sigma for 400 ps');
    const img = disk(n, G.fov, 15, 1, 60, 0);            // small disk at x = 60
    const s1 = P.forward(img), s2 = PT.forward(img), s2sum = S.sumTOF(s2, G.nT);
    let tot1 = 0, tot2 = 0;
    for (let k = 0; k < s1.length; k++) { tot1 += s1[k]; tot2 += s2sum[k]; }
    near(tot2 / tot1, 1, 0.01, 'TOF bins sum to non-TOF');
    // angle a = 96 (t = pi/2): LOR normal along y, s = -x. Source at x = 60 => s = -60 => bin 8 - 3 = 5
    const a = 96, i = 80, base = (a * G.nR + i) * G.nT;
    let best = 0; for (let t = 1; t < G.nT; t++) if (s2[base + t] > s2[base + best]) best = t;
    ok(best === 5, 'TOF profile peaks at the source (bin ' + best + ')');
    // TOF adjoint
    const rng = U.rng(5), y = new Float32Array(PT.size); for (let k = 0; k < y.length; k++) y[k] = rng();
    const t0 = Date.now(); const bty = PT.back(y); console.log('    TOF back n=128: ' + (Date.now() - t0) + ' ms');
    let lhs = 0, rhs = 0;
    for (let k = 0; k < y.length; k++) lhs += s2[k] * y[k];
    for (let k = 0; k < img.length; k++) rhs += img[k] * bty[k];
    near(lhs / rhs, 1, 1e-4, 'TOF projector adjointness');
}

// Subsets cover every angle once
{
    const sub = S.subsets(12); let cnt = 0; const seen = new Set();
    sub.forEach(s => s.forEach(a => { cnt++; seen.add(a); }));
    ok(cnt === G.nA && seen.size === G.nA, 'subsets partition the angles');
}

// Detector blur conserves counts and its transpose is the adjoint
{
    const rng = U.rng(9), x = new Float32Array(G.nA * G.nR), y = new Float32Array(G.nA * G.nR);
    for (let k = 0; k < x.length; k++) { x[k] = rng(); y[k] = rng(); }
    const bx = S.blurRadial(x, 1, false), bty = S.blurRadial(y, 1, true);
    let sx = 0, sbx = 0, l = 0, r = 0;
    for (let k = 0; k < x.length; k++) { sx += x[k]; sbx += bx[k]; l += bx[k] * y[k]; r += x[k] * bty[k]; }
    near(sbx / sx, 1, 0.01, 'blur conserves counts (edges lose a little)');
    near(l / r, 1, 1e-5, 'blur transpose is adjoint');
}

// Attenuation: water disk of radius 100 mm, central LOR survives exp(-0.0096 * 200)
{
    const n = 256, mu = disk(n, G.fov, 100, PET.const.MU_WATER);
    const af = S.attenuationFactors(mu, n);
    near(af[0 * G.nR + 80], Math.exp(-0.0096 * 200), 0.01, 'central attenuation factor of 20 cm water');
    near(af[0 * G.nR + 5], 1, 1e-6, 'LOR outside the object is not attenuated');
}

// Normalisation: dead block zeroes some LORs, efficiencies average about 1
{
    const nm = S.normalization({ variation: 0.06, deadBlock: 3 });
    let zeros = 0, s = 0; for (const v of nm.bins) { if (v === 0) zeros++; s += v; }
    ok(zeros > 0, 'dead block removes LORs (' + zeros + ')');
    const nm0 = S.normalization({ variation: 0 });
    ok(nm0.bins.every(v => Math.abs(v - 1) < 1e-6), 'zero variation gives unit efficiencies');
}

// Energy window physics
{
    const E = S.energy;
    near(E.comptonEnergy(Math.PI), 170.3, 0.1, 'backscatter energy');
    const pk = E.photopeakAcceptance(435, 650), pkWide = E.photopeakAcceptance(350, 650);
    ok(pk > 0.9 && pk < 1, 'photopeak acceptance 435-650 keV is high (' + pk.toFixed(3) + ')');
    const sc435 = E.scatterAcceptance(435, 650), sc350 = E.scatterAcceptance(350, 650);
    ok(sc350 > sc435, 'lower threshold accepts more scatter (' + sc350.toFixed(3) + ' > ' + sc435.toFixed(3) + ')');
    ok(pkWide >= pk, 'wider window keeps the photopeak');
    let ip = 0, is = 0; for (let e = 0; e < 800; e += 1) { const sp = E.spectrum(e); ip += sp.photopeak; is += sp.scatter; }
    near(ip, 1, 0.01, 'photopeak spectrum normalised'); near(is, 1, 0.02, 'scatter spectrum normalised');
}

// Timing window: a 1 ns window loses trues 100 mm from the LOR centre; 4.5 ns keeps them
{
    const T = S.timing;
    ok(T.trueAcceptance(100, 4.5e-9, 400e-12) > 0.999, 'wide window keeps edge trues');
    ok(T.trueAcceptance(140, 1e-9, 400e-12) < 0.05, '1 ns window cuts events 140 mm off centre');
    near(T.trueAcceptance(0, 1e-9, 400e-12), 1, 0.01, '1 ns window keeps central trues');
    const f = T.randomsTofFraction(4e-9, G.ds, G.nT);
    near(f.perBin, 2 * 20 / 2.99792458e11 / 4e-9, 1e-6, 'randoms fraction per TOF bin');
}

// Isotopes
{
    const I = PET.isotopes;
    near(I.get('18F').halfLife / 60, 109.77, 0.01, '18F half-life');
    near(I.decay('C11', I.get('C11').halfLife), 0.5, 1e-9, 'decay over one half-life');
    near(I.decayIntegral('F18', 0, 600), 600 * (1 - 600 * I.lambda('F18') / 2), 2, 'decay integral over 10 min');
    const wF = I.rangeStats('F18'), wO = I.rangeStats('O15');
    near(wF.mean1D, 0.3, 1e-9, 'F18 1D mean range is half the 3D mean');
    ok(wO.rms1D > 3 * wF.rms1D, 'O15 positron range much wider than F18 (RMS ' + wF.rms1D.toFixed(2) + ' vs ' + wO.rms1D.toFixed(2) + ' mm)');
    const rng = U.rng(2); let m = 0; for (let q = 0; q < 20000; q++) m += Math.abs(I.sampleRange('C11', rng)[0]);
    near(m / 20000, 0.6, 0.03, 'sampled C11 displacement has the model 1D mean');
    const k = I.rangeKernel('O15', 1.25);
    near(U.sum(k.kernel), 1, 1e-4, 'range kernel sums to 1');
    const kf = I.rangeKernel('F18', 1.25), c = (kf.size * kf.size - 1) / 2, co = (k.size * k.size - 1) / 2;
    ok(kf.kernel[c] > k.kernel[co], 'F18 kernel more concentrated at the centre than O15');
    ok(PET.tracers.get('pib').isotope === 'C11', 'PiB is carbon-11');
    ok(PET.tracers.normalizeId('FE-PE2I') === 'FE-PE2I' && PET.tracers.normalizeId('fepe2i') === 'FE-PE2I', 'tracer aliases');
}

// Core helpers
{
    near(U.erf(1), 0.8427, 1e-4, 'erf(1)');
    const rng = U.rng(11); let s = 0, s2 = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const v = U.poisson(rng, 3.5); s += v; s2 += v * v; }
    near(s / N, 3.5, 0.05, 'Poisson mean (small)'); near(s2 / N - (s / N) ** 2, 3.5, 0.15, 'Poisson variance (small)');
    s = 0; s2 = 0; for (let i = 0; i < N; i++) { const v = U.poisson(rng, 200); s += v; s2 += v * v; }
    near(s / N, 200, 0.5, 'Poisson mean (large)'); near(s2 / N - (s / N) ** 2, 200, 8, 'Poisson variance (large)');
    const img = new Float32Array(64 * 64).fill(1), b = U.gaussBlur2D(img, 64, 64, 4);
    near(b[32 * 64 + 32], 1, 1e-6, 'blur keeps a uniform image uniform');
    const r = U.resample(disk(256, 320, 80, 1), 256, 128);
    near(r[64 * 128 + 64], 1, 1e-6, 'resample keeps interior value');
    // the centre fine pixel lies wholly inside the centre coarse pixel; its
    // neighbour at ix = 127 straddles coarse pixels 63 and 64 equally
    const d = new Float32Array(256 * 256); d[128 * 256 + 128] = 16;
    near(U.resample(d, 256, 128)[64 * 128 + 64], 4, 1e-6, 'centre fine pixel falls in the centre coarse pixel');
    d[128 * 256 + 128] = 0; d[128 * 256 + 127] = 16;
    const rd = U.resample(d, 256, 128);
    near(rd[64 * 128 + 63], 2, 1e-6, 'straddling fine pixel splits evenly (left)');
    near(rd[64 * 128 + 64], 2, 1e-6, 'straddling fine pixel splits evenly (right)');
    let tot = 0; for (const v of rd) tot += v; near(tot * 4, 16, 1e-4, 'resample conserves the integral');
    const t = U.transformImage(disk(128, 320, 20, 1), 128, 2.5, 25, 0, 0);
    near(t[64 * 128 + 64 + 10], 1, 1e-6, 'shift moves the object 10 px right');
}

summary('scanner');
