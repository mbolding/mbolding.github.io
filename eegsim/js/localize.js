/* EEG simulator: source localization.
   The forward problem maps a known dipole to a scalp map.  The inverse
   here is the simplest honest one: find the single dipole whose map best
   fits the data in the least-squares sense.  Moment is linear and solved
   exactly at every candidate position; position is found by a grid search
   refined with Nelder-Mead.  Everything is average referenced, data and
   lead fields alike, so the reference cannot bias the fit. */
(function (G) {
  'use strict';
  const EEG = G.EEG, v3 = EEG.v3;

  function avgRefCols(L, ne) {
    for (let d = 0; d < 3; d++) {
      let m = 0; for (let e = 0; e < ne; e++) m += L[3 * e + d]; m /= ne;
      for (let e = 0; e < ne; e++) L[3 * e + d] -= m;
    }
    return L;
  }
  function avgRef(v) { const m = EEG.mean(v); return Float64Array.from(v, x => x - m); }

  // Least-squares moment and residual at one position.
  function solveAt(L, v, ne) {
    let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0, vv = 0;
    for (let e = 0; e < ne; e++) {
      const x = L[3 * e], y = L[3 * e + 1], z = L[3 * e + 2], d = v[e];
      a00 += x * x; a01 += x * y; a02 += x * z; a11 += y * y; a12 += y * z; a22 += z * z;
      b0 += x * d; b1 += y * d; b2 += z * d; vv += d * d;
    }
    const eps = 1e-9 * (a00 + a11 + a22);
    a00 += eps; a11 += eps; a22 += eps;
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    const q = [(c00 * b0 + c01 * b1 + c02 * b2) / det, (c01 * b0 + c11 * b1 + c12 * b2) / det, (c02 * b0 + c12 * b1 + c22 * b2) / det];
    const resid = Math.max(0, vv - (q[0] * b0 + q[1] * b1 + q[2] * b2));
    return { q, resid, vv };
  }

  /* A grid of candidate positions inside the brain, with average-referenced
     lead fields precomputed for one head model and one electrode set. */
  function buildGrid(model, elecU, spacing) {
    spacing = spacing || 0.7;
    const ne = elecU.length, pts = [], ijk = [];
    const lim = Math.floor(7.7 / spacing);
    for (let k = -lim; k <= lim; k++) for (let j = -lim; j <= lim; j++) for (let i = -lim; i <= lim; i++) {
      const p = [i * spacing, j * spacing, k * spacing];
      if (v3.norm(p) <= 7.7 && p[2] >= -3) { pts.push(p); ijk.push([i, j, k]); }
    }
    const L = new Float64Array(pts.length * 3 * ne), tmp = new Float64Array(3 * ne);
    pts.forEach((p, i) => { EEG.leadfield(model, p, elecU, tmp); avgRefCols(tmp, ne); L.set(tmp, i * 3 * ne); });
    return { pts, ijk, L, ne, spacing, lim, model, elecU };
  }

  function residualAt(model, elecU, pos, v) {
    if (v3.norm(pos) > EEG.HEAD.maxSourceR) return { resid: Infinity, q: [0, 0, 0], vv: 1 };
    const L = avgRefCols(EEG.leadfield(model, pos, elecU), elecU.length);
    return solveAt(L, v, elecU.length);
  }

  // Nelder-Mead over position, moment solved inside the objective.
  function refine(model, elecU, v, start, step) {
    const f = p => residualAt(model, elecU, p, v).resid;
    let S = [start.slice(), v3.add(start, [step, 0, 0]), v3.add(start, [0, step, 0]), v3.add(start, [0, 0, step])];
    let F = S.map(f);
    for (let it = 0; it < 120; it++) {
      const ord = [0, 1, 2, 3].sort((a, b) => F[a] - F[b]);
      S = ord.map(i => S[i]); F = ord.map(i => F[i]);
      if (Math.abs(F[3] - F[0]) <= 1e-10 * (Math.abs(F[0]) + 1e-12) && v3.norm(v3.sub(S[3], S[0])) < 1e-3) break;
      const c = v3.scale(v3.add(v3.add(S[0], S[1]), S[2]), 1 / 3);
      const xr = v3.add(c, v3.sub(c, S[3])), fr = f(xr);
      if (fr < F[0]) {
        const xe = v3.add(c, v3.scale(v3.sub(c, S[3]), 2)), fe = f(xe);
        if (fe < fr) { S[3] = xe; F[3] = fe; } else { S[3] = xr; F[3] = fr; }
      } else if (fr < F[2]) { S[3] = xr; F[3] = fr; }
      else {
        const xc = v3.add(c, v3.scale(v3.sub(S[3], c), 0.5)), fc = f(xc);
        if (fc < F[3]) { S[3] = xc; F[3] = fc; }
        else for (let i = 1; i < 4; i++) { S[i] = v3.add(S[0], v3.scale(v3.sub(S[i], S[0]), 0.5)); F[i] = f(S[i]); }
      }
    }
    let b = 0; for (let i = 1; i < 4; i++) if (F[i] < F[b]) b = i;
    return S[b];
  }

  /* Fit one map.  Returns the position, moment, goodness of fit and, when
     asked, the relative residual at every grid point (the error landscape). */
  function fit(grid, v, opts) {
    opts = opts || {};
    const ne = grid.ne, vr = avgRef(v);
    const land = opts.landscape ? new Float32Array(grid.pts.length) : null;
    let best = -1, bestR = Infinity;
    const sub = new Float64Array(3 * ne);
    for (let i = 0; i < grid.pts.length; i++) {
      const L = grid.L.subarray(i * 3 * ne, (i + 1) * 3 * ne);
      const r = solveAt(L, vr, ne);
      if (land) land[i] = r.resid / r.vv;
      if (r.resid < bestR) { bestR = r.resid; best = i; }
    }
    let pos = grid.pts[best];
    if (opts.refine !== false) pos = refine(grid.model, grid.elecU, vr, pos, grid.spacing / 2);
    const r = residualAt(grid.model, grid.elecU, pos, vr);
    return { pos, q: r.q, gof: 1 - r.resid / r.vv, resid: r.resid, landscape: land, gridBest: best };
  }

  EEG.loc = { buildGrid, fit, residualAt, avgRef, avgRefCols };
})(typeof window !== 'undefined' ? window : globalThis);
