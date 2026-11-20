/* MEG simulator: shared numerics.
   Seeded random numbers, an FFT, Legendre polynomials, small dense linear
   algebra, 3-vectors and rotations.  Everything hangs off one global, MEG,
   so the modules load as plain <script> tags in the browser and under Node
   for testing. */
(function (G) {
  'use strict';
  const MEG = G.MEG = G.MEG || {};

  /* ---------- seeded random numbers ----------
     mulberry32, with a Marsaglia polar Gaussian.  Every stochastic part of
     the simulation draws from its own stream, seeded from the program seed
     and a fixed name, so switching one artifact off leaves every other
     waveform sample-for-sample unchanged. */
  function rng(seed) {
    let s = (seed >>> 0) || 0x9E3779B9;
    let spare = null;
    function next() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function gauss() {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u, v, r;
      do { u = 2 * next() - 1; v = 2 * next() - 1; r = u * u + v * v; } while (r >= 1 || r === 0);
      const f = Math.sqrt(-2 * Math.log(r) / r);
      spare = v * f;
      return u * f;
    }
    return {
      next, gauss,
      int: n => Math.floor(next() * n),
      uniform: (a, b) => a + (b - a) * next(),
      exp: rate => -Math.log(1 - next()) / rate,
      pick: arr => arr[Math.floor(next() * arr.length)]
    };
  }
  function hashSeed(seed, name) {
    let h = (seed >>> 0) ^ 0x811C9DC5;
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  MEG.rng = rng;
  MEG.hashSeed = hashSeed;
  MEG.stream = (seed, name) => rng(hashSeed(seed, name));

  /* ---------- FFT ----------
     Iterative radix-2, in place, on separate real and imaginary arrays.
     The inverse is scaled by 1/n. */
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  MEG.nextPow2 = nextPow2;
  MEG.fft = fft;

  /* ---------- Legendre polynomials ----------
     P_n(x) and dP_n/dx for n = 0..N.  The derivative uses
     P'_{n+1} = P'_{n-1} + (2n+1) P_n, which stays finite at x = +-1. */
  function legendre(x, N, P, dP) {
    P[0] = 1; dP[0] = 0;
    if (N < 1) return;
    P[1] = x; dP[1] = 1;
    for (let n = 1; n < N; n++) {
      P[n + 1] = ((2 * n + 1) * x * P[n] - n * P[n - 1]) / (n + 1);
      dP[n + 1] = dP[n - 1] + (2 * n + 1) * P[n];
    }
  }
  MEG.legendre = legendre;

  /* ---------- 3-vectors and rotations ---------- */
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: a => Math.hypot(a[0], a[1], a[2]),
    unit: a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; },
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
  };
  MEG.v3 = v3;

  // Rotation matrix (rows) from small rotations about x, y and z in degrees,
  // applied in that order: R = Rz Ry Rx.
  MEG.rotXYZ = function (ax, ay, az) {
    const D = Math.PI / 180, a = ax * D, b = ay * D, c = az * D;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    return [
      [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
      [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
      [-sb, cb * sa, cb * ca]
    ];
  };
  MEG.matVec = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
  MEG.matTVec = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];
  MEG.mat3mul = (A, B) => [0, 1, 2].map(i => [0, 1, 2].map(j => A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]));
  MEG.mat3T = A => [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]];
  MEG.IDENTITY3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  // N roughly evenly spaced unit vectors (a Fibonacci lattice).
  MEG.fibonacciSphere = function (N) {
    const out = [], g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const z = 1 - (2 * i + 1) / N, r = Math.sqrt(Math.max(0, 1 - z * z)), a = g * i;
      out.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    return out;
  };

  /* ---------- dense linear algebra ----------
     Matrices are arrays of Float64Array rows.  Sizes here never exceed a
     few hundred. */
  function zeros(r, c) { const m = new Array(r); for (let i = 0; i < r; i++) m[i] = new Float64Array(c); return m; }
  function eye(n) { const m = zeros(n, n); for (let i = 0; i < n; i++) m[i][i] = 1; return m; }
  function transpose(A) {
    const r = A.length, c = A[0].length, T = zeros(c, r);
    for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = A[i][j];
    return T;
  }
  function matmul(A, B) {
    const r = A.length, k = B.length, c = B[0].length, C = zeros(r, c);
    for (let i = 0; i < r; i++) {
      const Ai = A[i], Ci = C[i];
      for (let p = 0; p < k; p++) {
        const a = Ai[p]; if (a === 0) continue;
        const Bp = B[p];
        for (let j = 0; j < c; j++) Ci[j] += a * Bp[j];
      }
    }
    return C;
  }
  // A^T A for A given as rows (r x c): returns c x c.
  function gram(A) {
    const r = A.length, c = A[0].length, C = zeros(c, c);
    for (let k = 0; k < r; k++) {
      const a = A[k];
      for (let i = 0; i < c; i++) { const ai = a[i]; if (ai === 0) continue; const Ci = C[i]; for (let j = i; j < c; j++) Ci[j] += ai * a[j]; }
    }
    for (let i = 0; i < c; i++) for (let j = 0; j < i; j++) C[i][j] = C[j][i];
    return C;
  }
  // Solve A X = B for X by Gaussian elimination with partial pivoting.
  // B may be a vector or a matrix (array of rows).
  function solve(A, B) {
    const n = A.length;
    const M = A.map(r => Float64Array.from(r));
    const vec = !(B[0] && B[0].length !== undefined);
    const R = vec ? Array.from(B, v => Float64Array.of(v)) : B.map(r => Float64Array.from(r));
    const m = R[0].length;
    for (let col = 0; col < n; col++) {
      let piv = col, best = Math.abs(M[col][col]);
      for (let r = col + 1; r < n; r++) { const v = Math.abs(M[r][col]); if (v > best) { best = v; piv = r; } }
      if (best < 1e-300) throw new Error('singular matrix');
      if (piv !== col) { [M[col], M[piv]] = [M[piv], M[col]]; [R[col], R[piv]] = [R[piv], R[col]]; }
      const d = M[col][col];
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / d; if (f === 0) continue;
        const Mr = M[r], Mc = M[col];
        for (let j = col; j < n; j++) Mr[j] -= f * Mc[j];
        const Rr = R[r], Rc = R[col];
        for (let j = 0; j < m; j++) Rr[j] -= f * Rc[j];
      }
    }
    for (let col = n - 1; col >= 0; col--) {
      const Rc = R[col], d = M[col][col];
      for (let j = 0; j < m; j++) Rc[j] /= d;
      for (let r = 0; r < col; r++) {
        const f = M[r][col]; if (f === 0) continue;
        const Rr = R[r];
        for (let j = 0; j < m; j++) Rr[j] -= f * Rc[j];
      }
    }
    return vec ? Float64Array.from(R, r => r[0]) : R;
  }
  function inverse(A) { return solve(A, eye(A.length)); }

  /* Symmetric eigen-decomposition: Householder reduction to tridiagonal
     form and the implicit QL algorithm (tred2 and tql2, as in EISPACK and
     JAMA).  Returns the eigenvalues in descending order and the
     eigenvectors as the columns of `vectors`. */
  function eigSym(S) {
    const n = S.length;
    const V = S.map(r => Float64Array.from(r));
    const d = new Float64Array(n), e = new Float64Array(n);
    // tred2
    for (let j = 0; j < n; j++) d[j] = V[n - 1][j];
    for (let i = n - 1; i > 0; i--) {
      let scale = 0, h = 0;
      for (let k = 0; k < i; k++) scale += Math.abs(d[k]);
      if (scale === 0) {
        e[i] = d[i - 1];
        for (let j = 0; j < i; j++) { d[j] = V[i - 1][j]; V[i][j] = 0; V[j][i] = 0; }
      } else {
        for (let k = 0; k < i; k++) { d[k] /= scale; h += d[k] * d[k]; }
        let f = d[i - 1], g = Math.sqrt(h);
        if (f > 0) g = -g;
        e[i] = scale * g;
        h -= f * g;
        d[i - 1] = f - g;
        for (let j = 0; j < i; j++) e[j] = 0;
        for (let j = 0; j < i; j++) {
          f = d[j]; V[j][i] = f; g = e[j] + V[j][j] * f;
          for (let k = j + 1; k <= i - 1; k++) { g += V[k][j] * d[k]; e[k] += V[k][j] * f; }
          e[j] = g;
        }
        f = 0;
        for (let j = 0; j < i; j++) { e[j] /= h; f += e[j] * d[j]; }
        const hh = f / (h + h);
        for (let j = 0; j < i; j++) e[j] -= hh * d[j];
        for (let j = 0; j < i; j++) {
          f = d[j]; g = e[j];
          for (let k = j; k <= i - 1; k++) V[k][j] -= (f * e[k] + g * d[k]);
          d[j] = V[i - 1][j]; V[i][j] = 0;
        }
      }
      d[i] = h;
    }
    for (let i = 0; i < n - 1; i++) {
      V[n - 1][i] = V[i][i]; V[i][i] = 1;
      const h = d[i + 1];
      if (h !== 0) {
        for (let k = 0; k <= i; k++) d[k] = V[k][i + 1] / h;
        for (let j = 0; j <= i; j++) {
          let g = 0;
          for (let k = 0; k <= i; k++) g += V[k][i + 1] * V[k][j];
          for (let k = 0; k <= i; k++) V[k][j] -= g * d[k];
        }
      }
      for (let k = 0; k <= i; k++) V[k][i + 1] = 0;
    }
    for (let j = 0; j < n; j++) { d[j] = V[n - 1][j]; V[n - 1][j] = 0; }
    V[n - 1][n - 1] = 1;
    e[0] = 0;
    // tql2
    for (let i = 1; i < n; i++) e[i - 1] = e[i];
    e[n - 1] = 0;
    let f = 0, tst1 = 0;
    const eps = Math.pow(2, -52);
    for (let l = 0; l < n; l++) {
      tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
      let m = l;
      while (m < n) { if (Math.abs(e[m]) <= eps * tst1) break; m++; }
      if (m === n) m = n - 1;
      if (m > l) {
        let iter = 0;
        do {
          iter++;
          let g = d[l], p = (d[l + 1] - g) / (2 * e[l]), r = Math.hypot(p, 1);
          if (p < 0) r = -r;
          d[l] = e[l] / (p + r);
          d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1];
          let h = g - d[l];
          for (let i = l + 2; i < n; i++) d[i] -= h;
          f += h;
          p = d[m];
          let c = 1, c2 = c, c3 = c, s = 0, s2 = 0;
          const el1 = e[l + 1];
          for (let i = m - 1; i >= l; i--) {
            c3 = c2; c2 = c; s2 = s;
            g = c * e[i]; h = c * p; r = Math.hypot(p, e[i]);
            e[i + 1] = s * r; s = e[i] / r; c = p / r;
            p = c * d[i] - s * g;
            d[i + 1] = h + s * (c * g + s * d[i]);
            for (let k = 0; k < n; k++) {
              const vk = V[k];
              h = vk[i + 1];
              vk[i + 1] = s * vk[i] + c * h;
              vk[i] = c * vk[i] - s * h;
            }
          }
          p = -s * s2 * c3 * el1 * e[l] / dl1;
          e[l] = s * p;
          d[l] = c * p;
        } while (Math.abs(e[l]) > eps * tst1 && iter < 60);
      }
      d[l] += f;
      e[l] = 0;
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d[b] - d[a]);
    const values = Float64Array.from(order, i => d[i]);
    const vectors = zeros(n, n);
    for (let j = 0; j < n; j++) { const oj = order[j]; for (let i = 0; i < n; i++) vectors[i][j] = V[i][oj]; }
    return { values, vectors };
  }

  /* Pseudo-inverse of A (rows r x c) through the eigen-decomposition of
     A^T A, discarding directions whose singular value is below
     tol * the largest.  Returns c x r. */
  function pinv(A, tol) {
    tol = tol === undefined ? 1e-8 : tol;
    const r = A.length, c = A[0].length;
    const { values, vectors: V } = eigSym(gram(A));
    const smax = Math.sqrt(Math.max(values[0], 0));
    const keep = [];
    for (let k = 0; k < c; k++) if (Math.sqrt(Math.max(values[k], 0)) > tol * smax) keep.push(k);
    const K = keep.length;
    // pinv = V_k diag(1/s^2) (A V_k)^T
    const AV = zeros(r, K);
    for (let t = 0; t < r; t++) {
      const At = A[t], o = AV[t];
      for (let j = 0; j < K; j++) { const k = keep[j]; let s = 0; for (let p = 0; p < c; p++) s += At[p] * V[p][k]; o[j] = s / values[k]; }
    }
    const P = zeros(c, r);
    for (let i = 0; i < c; i++) {
      const Pi = P[i], Vi = V[i];
      for (let j = 0; j < K; j++) {
        const w = Vi[keep[j]]; if (w === 0) continue;
        for (let t = 0; t < r; t++) Pi[t] += w * AV[t][j];
      }
    }
    return { P, rank: K, values };
  }

  MEG.la = { zeros, eye, transpose, matmul, gram, solve, inverse, eigSym, pinv };

  /* ---------- small helpers ---------- */
  MEG.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  MEG.lerp = (a, b, t) => a + (b - a) * t;
  MEG.mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
  MEG.rms = (a, i0 = 0, i1 = a.length) => {
    let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i];
    return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  };
  MEG.fmt = (x, digits = 2) => {
    if (!isFinite(x)) return '–';
    const a = Math.abs(x);
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return x.toExponential(1);
    return x.toFixed(digits);
  };
  /* A magnetic field in femtotesla written with a sensible prefix:
     120 fT, 3.4 pT, 50 nT, 50 µT. */
  MEG.fmtB = function (fT, digits) {
    if (!isFinite(fT)) return '–';
    const a = Math.abs(fT);
    const units = [[1e9, 'µT'], [1e6, 'nT'], [1e3, 'pT'], [1, 'fT'], [1e-3, 'aT']];
    let u = units.find(([s]) => a >= s * 0.9995) || units[units.length - 1];
    if (a === 0) u = [1, 'fT'];
    const v = fT / u[0], d = digits === undefined ? (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2) : digits;
    return `${v.toFixed(d)} ${u[1]}`;
  };
})(typeof window !== 'undefined' ? window : globalThis);
