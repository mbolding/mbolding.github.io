/* fNIRS simulator: diffuse optical tomography.

   With many overlapping channels at several separations, the sensitivity
   of every channel to every voxel under the probe forms a matrix A.  A
   small absorption change x in the tissue gives measurements y = A x
   (the Rytov approximation), plus noise.  The inverse problem is badly
   underdetermined, so the reconstruction is regularized:

     x = W^2 A^T (A W^2 A^T + lambda I)^-1 y

   where W optionally boosts deep voxels (depth compensation) to undo the
   steep loss of sensitivity with depth.  One wavelength is enough to show
   the idea; with two, the same step gives images of HbO and HbR. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;

  NIRS.DOT_ARRAYS = {
    hd: { label: 'High density: 1.5 cm grid, 1.5 / 3.4 / 4.5 cm channels', build: () => Object.assign(NIRS.LAYOUTS.hd(6, 1.5), { maxSep: 4.6, minSep: 1.4 }) },
    hdshort: { label: 'High density, nearest neighbours only (1.5 cm)', build: () => Object.assign(NIRS.LAYOUTS.hd(6, 1.5), { maxSep: 1.6, minSep: 1.4 }) },
    sparse: { label: 'Sparse: 3 cm grid, 3 cm channels (topography)', build: () => Object.assign(NIRS.LAYOUTS.hd(4, 3), { maxSep: 3.1, minSep: 2.9 }) }
  };

  /* Voxel grid under the probe and the sensitivity matrix of an array. */
  NIRS.dotModel = function (headName, nm, arrayKey, opts) {
    opts = opts || {};
    const layers = NIRS.headLayers(headName);
    const ol = NIRS.opticalLayers(layers, nm);
    const sol = NIRS.fluence(ol);
    const geo = NIRS.buildProbe(NIRS.DOT_ARRAYS[arrayKey].build());
    const h = opts.h || 0.3, ext = opts.ext || 4.2, nxy = Math.round(2 * ext / h);
    const dz = opts.dz || 0.2, zs = []; for (let z = dz * 0.75; z <= (opts.zmax || 3.0); z += dz) zs.push(z);
    const xs = Float64Array.from({ length: nxy }, (_, i) => -ext + (i + 0.5) * h);
    const nv = nxy * nxy * zs.length, nc = geo.channels.length;
    const A = new Array(nc);
    const dV = h * h * dz;
    geo.channels.forEach((c, ci) => {
      const s = geo.sources[c.src], d = geo.detectors[c.det];
      const Gd = NIRS.Gat(sol, c.rho, sol.j0);
      const row = new Float32Array(nv);
      let q = 0;
      for (let k = 0; k < zs.length; k++) {
        const j = Math.min(sol.Nz - 1, Math.floor(zs[k] / sol.dz));
        for (let iy = 0; iy < nxy; iy++) for (let ix = 0; ix < nxy; ix++, q++) {
          const x = xs[ix], y = xs[iy];
          row[q] = NIRS.Gat(sol, Math.hypot(x - s.x, y - s.y), j) * NIRS.Gat(sol, Math.hypot(x - d.x, y - d.y), j) / Gd * dV;
        }
      }
      A[ci] = row;
    });
    // column norms: the total sensitivity of each voxel
    const colNorm = new Float64Array(nv);
    A.forEach(row => { for (let v = 0; v < nv; v++) colNorm[v] += row[v] * row[v]; });
    for (let v = 0; v < nv; v++) colNorm[v] = Math.sqrt(colNorm[v]);
    return { A, geo, xs, zs, nxy, nv, nc, h, layers, ol, sol, colNorm, brainTop: NIRS.brainTop(layers), nm };
  };

  // A target: soft spheres of absorption change (1/cm).
  NIRS.dotTarget = function (M, targets) {
    const x = new Float64Array(M.nv);
    let q = 0;
    for (let k = 0; k < M.zs.length; k++) for (let iy = 0; iy < M.nxy; iy++) for (let ix = 0; ix < M.nxy; ix++, q++) {
      let v = 0;
      targets.forEach(t => {
        const d = Math.sqrt((M.xs[ix] - t.x) ** 2 + (M.xs[iy] - t.y) ** 2 + (M.zs[k] - t.z) ** 2);
        v += t.dmua / (1 + Math.exp((d - t.r) / 0.08));
      });
      x[q] = v;
    }
    return x;
  };

  NIRS.dotForward = function (M, x, noise, seed) {
    const r = NIRS.rng(seed || 3);
    return M.A.map(row => {
      let s = 0; for (let v = 0; v < M.nv; v++) s += row[v] * x[v];
      return s + noise * r.gauss();
    });
  };

  /* Regularized minimum-norm reconstruction, in two steps so that
     changing lambda is instant: prepare() builds K = A W^2 A^T for a
     depth-compensation strength gamma (0 to 1), with
     W = (|A_v|^2 + (beta max|A|)^2)^(-gamma/2), which lifts deep voxels
     without letting the ones the probe cannot see at all run away;
     solve() applies lambda (relative to the largest diagonal of K). */
  NIRS.dotPrepare = function (M, gamma) {
    const nc = M.nc, nv = M.nv;
    let cmax = 0; for (let v = 0; v < nv; v++) cmax = Math.max(cmax, M.colNorm[v]);
    const beta = 0.03 * cmax, w2 = new Float64Array(nv);
    let wmax = 0;
    for (let v = 0; v < nv; v++) { w2[v] = Math.pow(M.colNorm[v] * M.colNorm[v] + beta * beta, -gamma); if (w2[v] > wmax) wmax = w2[v]; }
    for (let v = 0; v < nv; v++) w2[v] /= wmax;
    const K = NIRS.la.zeros(nc, nc), tmp = new Float64Array(nv);
    for (let i = 0; i < nc; i++) {
      const ai = M.A[i];
      for (let v = 0; v < nv; v++) tmp[v] = ai[v] * w2[v];
      for (let j = i; j < nc; j++) {
        const aj = M.A[j]; let s = 0;
        for (let v = 0; v < nv; v++) s += tmp[v] * aj[v];
        K[i][j] = K[j][i] = s;
      }
    }
    let dmax = 0; for (let i = 0; i < nc; i++) dmax = Math.max(dmax, K[i][i]);
    return { K, w2, dmax, gamma };
  };
  NIRS.dotSolve = function (M, prep, y, lambda) {
    const nc = M.nc, nv = M.nv;
    const K = prep.K.map(r => Float64Array.from(r));
    for (let i = 0; i < nc; i++) K[i][i] += lambda * prep.dmax;
    const c = NIRS.la.solve(K, Float64Array.from(y));
    const x = new Float64Array(nv);
    for (let i = 0; i < nc; i++) { const ai = M.A[i], ci = c[i]; for (let v = 0; v < nv; v++) x[v] += ai[v] * ci; }
    for (let v = 0; v < nv; v++) x[v] *= prep.w2[v];
    return x;
  };
  NIRS.dotReconstruct = (M, y, lambda, gamma) => NIRS.dotSolve(M, NIRS.dotPrepare(M, gamma), y, lambda);

  // Peak location of an image and its value.
  NIRS.dotPeak = function (M, x) {
    let best = -Infinity, bq = 0;
    for (let q = 0; q < M.nv; q++) if (x[q] > best) { best = x[q]; bq = q; }
    const k = Math.floor(bq / (M.nxy * M.nxy)), rem = bq % (M.nxy * M.nxy), iy = Math.floor(rem / M.nxy), ix = rem % M.nxy;
    return { x: M.xs[ix], y: M.xs[iy], z: M.zs[k], v: best };
  };
})(typeof window !== 'undefined' ? window : globalThis);
