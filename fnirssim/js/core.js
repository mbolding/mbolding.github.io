/* fNIRS simulator: shared numerics.
   Seeded random numbers, an FFT, small dense linear algebra and a few
   helpers.  Everything hangs off one global, NIRS, so the modules load as
   plain <script> tags in the browser and under Node for testing. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS = G.NIRS || {};

  /* ---------- seeded random numbers ----------
     mulberry32, with a Marsaglia polar Gaussian.  Every stochastic part of
     the simulation draws from its own stream, seeded from the program seed
     and a fixed name, so switching one confound off leaves every other
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
      pick: arr => arr[Math.floor(next() * arr.length)],
      sign: () => (next() < 0.5 ? -1 : 1)
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
  NIRS.rng = rng;
  NIRS.hashSeed = hashSeed;
  NIRS.stream = (seed, name) => rng(hashSeed(seed, name));

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
  NIRS.nextPow2 = nextPow2;
  NIRS.fft = fft;

  /* Band-limited Gaussian noise by shaping white noise in the frequency
     domain: gain(f) is any function of frequency in Hz.  The result has
     unit standard deviation (before the gain), so gain sets the shape and
     the caller sets the size. */
  NIRS.shapedNoise = function (n, fs, gain, r) {
    const N = nextPow2(n * 2);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = r.gauss();
    fft(re, im, false);
    for (let k = 0; k <= N / 2; k++) {
      const g = gain(k * fs / N);
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] *= g; im[N - k] *= g; }
    }
    fft(re, im, true);
    const out = new Float64Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { out[i] = re[i]; s += re[i] * re[i]; }
    const sd = Math.sqrt(s / n) || 1;
    for (let i = 0; i < n; i++) out[i] /= sd;
    return out;
  };

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
  // Solve A X = B by Gaussian elimination with partial pivoting.
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

  // Cyclic Jacobi eigen-decomposition of a symmetric matrix: eigenvalues in
  // descending order, eigenvectors as the columns of `vectors`.
  function eigSym(S) {
    const n = S.length;
    const A = S.map(r => Float64Array.from(r));
    const V = eye(n);
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
      if (off < 1e-24) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          const apq = A[p][q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k][p], akq = A[k][q];
            A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p][k], aqk = A[q][k];
            A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
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

  // Ordinary least squares for many right-hand sides that share one design.
  // X: rows of the design (n x p).  Returns the pseudo-inverse pieces so the
  // caller can fit any number of columns: beta = XtXi * Xt y.
  function olsPrep(X) {
    const n = X.length, p = X[0].length;
    const XtX = zeros(p, p);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      for (let a = 0; a < p; a++) { const v = xi[a]; if (v === 0) continue; const row = XtX[a]; for (let b = 0; b < p; b++) row[b] += v * xi[b]; }
    }
    // a whisker of ridge keeps nearly collinear designs solvable
    let tr = 0; for (let a = 0; a < p; a++) tr += XtX[a][a];
    for (let a = 0; a < p; a++) XtX[a][a] += 1e-10 * tr / p;
    const XtXi = inverse(XtX);
    return {
      XtXi, n, p,
      fit(y) {
        const Xty = new Float64Array(p);
        for (let i = 0; i < n; i++) { const v = y[i]; if (v === 0) continue; const xi = X[i]; for (let a = 0; a < p; a++) Xty[a] += xi[a] * v; }
        const beta = new Float64Array(p);
        for (let a = 0; a < p; a++) { let s = 0; const r = XtXi[a]; for (let b = 0; b < p; b++) s += r[b] * Xty[b]; beta[a] = s; }
        return beta;
      }
    };
  }

  NIRS.la = { zeros, eye, transpose, matmul, solve, inverse, eigSym, olsPrep };

  // 2x2 helpers for the Beer-Lambert matrix
  NIRS.cond2 = function (a, b, c, d) {
    // condition number (2-norm) of [[a b],[c d]]
    const s1 = a * a + b * b + c * c + d * d, det = a * d - b * c;
    const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
    const big = Math.sqrt((s1 + disc) / 2), small = Math.sqrt(Math.max(0, (s1 - disc) / 2));
    return small > 0 ? big / small : Infinity;
  };

  /* ---------- small helpers ---------- */
  NIRS.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  NIRS.lerp = (a, b, t) => a + (b - a) * t;
  NIRS.mean = (a, i0 = 0, i1 = a.length) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return i1 > i0 ? s / (i1 - i0) : 0; };
  NIRS.std = (a, i0 = 0, i1 = a.length) => {
    const m = NIRS.mean(a, i0, i1); let s = 0;
    for (let i = i0; i < i1; i++) s += (a[i] - m) * (a[i] - m);
    return i1 - i0 > 1 ? Math.sqrt(s / (i1 - i0 - 1)) : 0;
  };
  NIRS.rms = (a, i0 = 0, i1 = a.length) => {
    let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i];
    return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  };
  // Median by quickselect; reorders its argument.
  NIRS.quickMedian = function (a) {
    const n = a.length;
    if (!n) return 0;
    const select = k => {
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const pivot = a[(lo + hi) >> 1];
        let i = lo, j = hi;
        while (i <= j) {
          while (a[i] < pivot) i++;
          while (a[j] > pivot) j--;
          if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
      }
      return a[k];
    };
    if (n % 2) return select((n - 1) / 2);
    const hi = select(n / 2);
    let lo = -Infinity; for (let i = 0; i < n / 2; i++) if (a[i] > lo) lo = a[i];
    return (lo + hi) / 2;
  };
  NIRS.median = a => { const b = Float64Array.from(a).sort(); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; };
  NIRS.corr = (a, b, i0 = 0, i1 = a.length) => {
    const ma = NIRS.mean(a, i0, i1), mb = NIRS.mean(b, i0, i1);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = i0; i < i1; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  };
  NIRS.fmt = (x, digits = 2) => {
    if (!isFinite(x)) return '–';
    const a = Math.abs(x);
    if (a !== 0 && (a < 0.01 || a >= 1e5)) return x.toExponential(1);
    return x.toFixed(digits);
  };
  // Engineering-style power formatting from nanowatts
  NIRS.fmtPower = nW => {
    if (!isFinite(nW)) return '–';
    const a = Math.abs(nW);
    if (a >= 1e6) return (nW / 1e6).toPrecision(3) + ' mW';
    if (a >= 1e3) return (nW / 1e3).toPrecision(3) + ' µW';
    if (a >= 1) return nW.toPrecision(3) + ' nW';
    if (a >= 1e-3) return (nW * 1e3).toPrecision(3) + ' pW';
    return (nW * 1e6).toPrecision(2) + ' fW';
  };
  // Short power labels for axis ticks: 10 µW, 1 µW, 100 nW
  NIRS.fmtPowerTick = nW => NIRS.fmtPower(nW).replace(/(\.\d*?)0+ /, '$1 ').replace(/\. /, ' ');
  // The gamma function (Lanczos), for the gamma-shaped responses.
  NIRS.gammaFn = function gammaFn(z) {
    // Lanczos approximation
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
    z -= 1;
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  };
  // Two-sided p value of a t statistic with df degrees of freedom, via the
  // regularized incomplete beta function (continued fraction).
  NIRS.tToP = function (t, df) {
    if (!isFinite(t)) return 0;
    const x = df / (df + t * t);
    return incBeta(x, df / 2, 0.5);
  };
  function incBeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const lbeta = NIRS.lgamma(a + b) - NIRS.lgamma(a) - NIRS.lgamma(b);
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b + lbeta);
    if (x < (a + 1) / (a + b + 2)) return front * betacf(x, a, b) / a;
    return 1 - front * betacf(1 - x, b, a) / b;
  }
  function betacf(x, a, b) {
    const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d; let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function lgamma(z) { return Math.log(Math.abs(NIRS.gammaFn(z))); }
  NIRS.lgamma = z => (z > 100 ? (z - 0.5) * Math.log(z) - z + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * z) : lgamma(z));
})(typeof window !== 'undefined' ? window : globalThis);
