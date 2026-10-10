'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core']);
const U = PET.util;


// FFT round trip and agreement with a direct DFT, for power-of-two and other sizes
for (const n of [8, 12, 64, 96, 100]) {
    const re = new Float64Array(n), im = new Float64Array(n);
    const rng = U.rng(n);
    for (let i = 0; i < n; i++) { re[i] = rng() - 0.5; im[i] = rng() - 0.5; }
    const r2 = Float64Array.from(re), i2 = Float64Array.from(im);
    U.fft(r2, i2, false);
    let err = 0;
    for (let k = 0; k < n; k++) {
        let sr = 0, si = 0;
        for (let j = 0; j < n; j++) {
            const a = -2 * Math.PI * j * k / n;
            sr += re[j] * Math.cos(a) - im[j] * Math.sin(a);
            si += re[j] * Math.sin(a) + im[j] * Math.cos(a);
        }
        err = Math.max(err, Math.abs(sr - r2[k]), Math.abs(si - i2[k]));
    }
    ok(err < 1e-9, 'fft matches DFT for n=' + n + ' (err ' + err + ')');
    U.fft(r2, i2, true);
    let rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(r2[i] - re[i]), Math.abs(i2[i] - im[i]));
    ok(rt < 1e-9, 'fft round trip n=' + n);
}

// Centred 2D: a delta at the image centre has flat k-space; a delta at
// k-space centre is a flat image.
for (const [nx, ny] of [[8, 8], [6, 10], [7, 5]]) {
    const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
    re[Math.floor(ny / 2) * nx + Math.floor(nx / 2)] = 1;
    const K = U.fft2c(re, im, nx, ny);
    let dev = 0;
    for (let i = 0; i < nx * ny; i++) dev = Math.max(dev, Math.abs(K.re[i] - 1), Math.abs(K.im[i]));
    ok(dev < 1e-9, 'centred delta -> flat k-space ' + nx + 'x' + ny);
    const X = U.ifft2c(K.re, K.im, nx, ny);
    let rt = 0;
    for (let i = 0; i < nx * ny; i++) rt = Math.max(rt, Math.abs(X.re[i] - re[i]), Math.abs(X.im[i]));
    ok(rt < 1e-9, 'fft2c/ifft2c round trip ' + nx + 'x' + ny);
}

// A shifted object gives the expected linear phase: x0 = +1 pixel => phase -2pi k/N
{
    const n = 16, re = new Float64Array(n * n), im = new Float64Array(n * n);
    re[(n / 2) * n + n / 2 + 1] = 1;
    const K = U.fft2c(re, im, n, n);
    const kIdx = n / 2 + 1;                    // kx = +1 cycle per FOV
    const ph = Math.atan2(K.im[(n / 2) * n + kIdx], K.re[(n / 2) * n + kIdx]);
    near(ph, -2 * Math.PI / n, 1e-9, 'shift theorem sign convention (s = sum m exp(-i2pi k x))');
}

// RNG reproducible and roughly normal
{
    const a = U.rng(42), b = U.rng(42);
    ok(a() === b() && a() === b(), 'rng reproducible');
    const r = U.rng(7); let s = 0, s2 = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const v = r.randn(); s += v; s2 += v * v; }
    near(s / N, 0, 0.03, 'randn mean'); near(s2 / N, 1, 0.05, 'randn variance');
}

// Formatting
ok(U.fmtTime(0.09) === '90 ms', 'fmtTime ms: ' + U.fmtTime(0.09));
ok(U.fmtTime(330) === '5 min 30 s', 'fmtTime min: ' + U.fmtTime(330));
ok(U.fmtTime(2700) === '45 min', 'fmtTime whole minutes: ' + U.fmtTime(2700));
ok(U.fmtTime(4e-10) === '400 ps', 'fmtTime ps: ' + U.fmtTime(4e-10));
ok(U.fmtActivity(185e6) === '185 MBq', 'fmtActivity: ' + U.fmtActivity(185e6));
ok(U.fmtConc(6400) === '6.4 kBq/mL', 'fmtConc: ' + U.fmtConc(6400));
ok(U.fmtCounts(2.1e6) === '2.1 M', 'fmtCounts: ' + U.fmtCounts(2.1e6));

summary('core');
