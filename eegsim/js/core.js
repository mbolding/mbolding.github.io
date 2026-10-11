/* EEG simulator: shared numerics.
   Seeded random numbers, an FFT, Legendre polynomials, small dense linear
   algebra and 3-vectors.  Everything hangs off one global, EEG, so the
   modules load as plain <script> tags in the browser and under Node for
   testing. */
(function (G) {
  'use strict';
  const EEG = G.EEG = G.EEG || {};

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
  EEG.rng = rng;
  EEG.hashSeed = hashSeed;
  EEG.stream = (seed, name) => rng(hashSeed(seed, name));

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
  EEG.nextPow2 = nextPow2;
  EEG.fft = fft;

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
  EEG.legendre = legendre;

  /* ---------- 3-vectors ---------- */
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm: a => Math.hypot(a[0], a[1], a[2]),
    unit: a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
  };
  EEG.v3 = v3;

  /* ---------- dense linear algebra ----------
     Matrices are arrays of Float64Array rows.  Sizes here never exceed a
     few hundred, so the textbook algorithms are plenty. */
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
  // Solve A X = B for X by Gaussian elimination with partial pivoting.
  // B may be a vector or a matrix (array of rows).
  function solve(A, B) {
    const n = A.length;
    const M = A.map(r => Float64Array.from(r));
    const vec = !(B[0] && B[0].length !== undefined);
    const R = vec ? B.map(v => Float64Array.of(v)) : B.map(r => Float64Array.from(r));
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

  // Cyclic Jacobi eigen-decomposition of a symmetric matrix.  Returns the
  // eigenvalues sorted in descending order and the eigenvectors as the
  // columns of `vectors`.
  function eigSym(S) {
    const n = S.length;
    const A = S.map(r => Float64Array.from(r));
    const V = eye(n);
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = A[p][q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k][p], akq = A[k][q];
            A[k][p] = c * akp - s * akq;
            A[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p][k], aqk = A[q][k];
            A[p][k] = c * apk - s * aqk;
            A[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
    const values = Float64Array.from(order, i => A[i][i]);
    const vectors = zeros(n, n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) vectors[i][j] = V[i][order[j]];
    return { values, vectors };
  }

  EEG.la = { zeros, eye, transpose, matmul, solve, inverse, eigSym };

  /* ---------- small helpers ---------- */
  EEG.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  EEG.lerp = (a, b, t) => a + (b - a) * t;
  EEG.mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
  EEG.rms = (a, i0 = 0, i1 = a.length) => {
    let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i];
    return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  };
  EEG.fmt = (x, digits = 2) => {
    if (!isFinite(x)) return '–';
    const a = Math.abs(x);
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return x.toExponential(1);
    return x.toFixed(digits);
  };
})(typeof window !== 'undefined' ? window : globalThis);
