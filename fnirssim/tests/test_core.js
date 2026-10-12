'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core']);

// seeded streams are reproducible and independent by name
const a = NIRS.stream(1, 'x'), b = NIRS.stream(1, 'x'), c = NIRS.stream(1, 'y');
let same = true, diff = false;
for (let i = 0; i < 100; i++) { const u = a.next(), v = b.next(), w = c.next(); if (u !== v) same = false; if (u !== w) diff = true; }
ok(same, 'same seed and name give the same stream');
ok(diff, 'different names give different streams');
const g = NIRS.rng(5); let s = 0, s2 = 0; const n = 20000;
for (let i = 0; i < n; i++) { const x = g.gauss(); s += x; s2 += x * x; }
near(s / n, 0, 0.03, 'Gaussian mean');
near(Math.sqrt(s2 / n), 1, 0.03, 'Gaussian sd');

// FFT against a direct DFT, and the round trip
for (const m of [8, 64, 256]) {
  const re = new Float64Array(m), im = new Float64Array(m), r = NIRS.rng(m);
  for (let i = 0; i < m; i++) { re[i] = r.next() - 0.5; im[i] = r.next() - 0.5; }
  const R = Float64Array.from(re), I = Float64Array.from(im);
  NIRS.fft(R, I, false);
  let err = 0;
  for (let k = 0; k < m; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < m; j++) { const ang = -2 * Math.PI * j * k / m; sr += re[j] * Math.cos(ang) - im[j] * Math.sin(ang); si += re[j] * Math.sin(ang) + im[j] * Math.cos(ang); }
    err = Math.max(err, Math.abs(sr - R[k]), Math.abs(si - I[k]));
  }
  ok(err < 1e-9, `FFT matches the DFT for n = ${m}`);
  NIRS.fft(R, I, true);
  let rt = 0; for (let i = 0; i < m; i++) rt = Math.max(rt, Math.abs(R[i] - re[i]));
  ok(rt < 1e-12, `FFT round trip for n = ${m}`);
}
// shaped noise has unit variance and the requested spectrum
const sn = NIRS.shapedNoise(4096, 10, f => (f < 1 ? 1 : 0), NIRS.rng(3));
near(NIRS.std(sn), 1, 0.02, 'shaped noise has unit SD');

// linear algebra
const A = [[4, 1, 2], [1, 3, 0], [2, 0, 5]], x = NIRS.la.solve(A, [1, 2, 3]);
const back = A.map(r => r[0] * x[0] + r[1] * x[1] + r[2] * x[2]);
ok(Math.abs(back[0] - 1) + Math.abs(back[1] - 2) + Math.abs(back[2] - 3) < 1e-12, 'solve');
const E = NIRS.la.eigSym(A);
ok(E.values[0] >= E.values[1] && E.values[1] >= E.values[2], 'eigenvalues sorted');
near(E.values.reduce((p, v) => p + v, 0), 12, 1e-9, 'eigenvalues sum to the trace');
near(NIRS.cond2(1, 0, 0, 2), 2, 1e-12, 'condition number of diag(1, 2)');

// medians and statistics
const r2 = NIRS.rng(9);
for (const m of [1, 2, 5, 100, 1001]) {
  const v = Float64Array.from({ length: m }, () => r2.gauss());
  near(NIRS.quickMedian(Float64Array.from(v)), NIRS.median(v), 1e-12, `quickselect median, n = ${m}`);
}
near(NIRS.tToP(1.96, 1e5), 0.05, 0.001, 't to p, large df');
near(NIRS.tToP(2.228, 10), 0.05, 0.001, 't to p, df 10');
near(NIRS.tToP(0, 30), 1, 1e-9, 't = 0 gives p = 1');
near(NIRS.gammaFn(5), 24, 1e-9, 'gamma(5) = 4!');
near(NIRS.corr([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-12, 'correlation of proportional series');
ok(NIRS.fmtPowerTick(1e4) === '10 µW' && NIRS.fmtPowerTick(0.1) === '100 pW', 'power tick labels');
summary('core');
