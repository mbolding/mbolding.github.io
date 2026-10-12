'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core']);
const la = MEG.la;

// FFT agrees with a direct DFT and round-trips
{
  const n = 64, re = new Float64Array(n), im = new Float64Array(n), r = MEG.rng(3);
  for (let i = 0; i < n; i++) { re[i] = r.gauss(); im[i] = r.gauss(); }
  const r2 = Float64Array.from(re), i2 = Float64Array.from(im);
  MEG.fft(r2, i2);
  let err = 0;
  for (let k = 0; k < n; k++) {
    let sr = 0, si = 0;
    for (let j = 0; j < n; j++) { const a = -2 * Math.PI * j * k / n; sr += re[j] * Math.cos(a) - im[j] * Math.sin(a); si += re[j] * Math.sin(a) + im[j] * Math.cos(a); }
    err = Math.max(err, Math.abs(sr - r2[k]), Math.abs(si - i2[k]));
  }
  ok(err < 1e-9, 'fft matches DFT (err ' + err + ')');
  MEG.fft(r2, i2, true);
  let rt = 0; for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(r2[i] - re[i]));
  ok(rt < 1e-12, 'fft round trip');
}

// Symmetric eigen-decomposition
for (const n of [1, 2, 5, 30, 120]) {
  const r = MEG.rng(n + 10);
  const A = la.zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const v = r.gauss(); A[i][j] = A[j][i] = v; }
  const { values, vectors: V } = la.eigSym(A);
  let res = 0, orth = 0, sorted = true;
  for (let k = 0; k < n; k++) {
    if (k && values[k] > values[k - 1] + 1e-12) sorted = false;
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += A[i][j] * V[j][k]; res = Math.max(res, Math.abs(s - values[k] * V[i][k])); }
    for (let l = 0; l < n; l++) { let s = 0; for (let i = 0; i < n; i++) s += V[i][k] * V[i][l]; orth = Math.max(orth, Math.abs(s - (k === l ? 1 : 0))); }
  }
  ok(res < 1e-9, `eigSym residual n=${n} (${res})`);
  ok(orth < 1e-9, `eigSym orthonormal n=${n} (${orth})`);
  ok(sorted, `eigSym sorted descending n=${n}`);
}
// Rank-deficient covariance
{
  const r = MEG.rng(5), n = 40, k = 7, X = la.zeros(n, 300), B = la.zeros(n, k);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) B[i][j] = r.gauss();
  for (let t = 0; t < 300; t++) { const s = Array.from({ length: k }, () => r.gauss()); for (let i = 0; i < n; i++) { let v = 0; for (let j = 0; j < k; j++) v += B[i][j] * s[j]; X[i][t] = v; } }
  const C = la.matmul(X, la.transpose(X));
  const { values } = la.eigSym(C);
  ok(values[k - 1] > 1e-6 * values[0] && Math.abs(values[k]) < 1e-9 * values[0], 'eigSym finds the rank of a rank-7 covariance');
}

// Pseudo-inverse: A pinv(A) A = A, and the least-squares solution of a tall system
{
  const r = MEG.rng(9), m = 50, n = 12, A = la.zeros(m, n);
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) A[i][j] = r.gauss();
  const { P, rank } = la.pinv(A);
  ok(rank === n, 'pinv full rank');
  const PA = la.matmul(P, A);
  let e = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) e = Math.max(e, Math.abs(PA[i][j] - (i === j ? 1 : 0)));
  ok(e < 1e-9, 'pinv(A) A = I for a tall full-rank A (' + e + ')');
  // rank deficient: duplicate a column
  const A2 = A.map(row => { const o = new Float64Array(n + 1); o.set(row); o[n] = row[0] * 2; return o; });
  const p2 = la.pinv(A2);
  ok(p2.rank === n, 'pinv detects a dependent column');
  const APA = la.matmul(la.matmul(A2, p2.P), A2);
  let e2 = 0; for (let i = 0; i < m; i++) for (let j = 0; j <= n; j++) e2 = Math.max(e2, Math.abs(APA[i][j] - A2[i][j]));
  ok(e2 < 1e-8, 'A pinv(A) A = A when rank deficient (' + e2 + ')');
}

// Rotations are orthonormal and invert by transpose
{
  const R = MEG.rotXYZ(10, -20, 35), v = [1, 2, 3];
  const back = MEG.matTVec(R, MEG.matVec(R, v));
  near(MEG.v3.norm(MEG.v3.sub(back, v)), 0, 1e-12, 'rotation inverts by transpose');
  near(MEG.v3.norm(MEG.matVec(R, v)), MEG.v3.norm(v), 1e-12, 'rotation keeps length');
}
ok(MEG.fmtB(120) === '120 fT' && MEG.fmtB(3400) === '3.40 pT' && MEG.fmtB(5e10) === '50.0 µT', 'field formatting: ' + [MEG.fmtB(120), MEG.fmtB(3400), MEG.fmtB(5e10)].join(', '));
summary('core');
