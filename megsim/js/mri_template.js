/* MEG simulator: the template MRI.

   The structural MRI is the MNI ICBM152 2009c nonlinear symmetric template
   (Fonov et al. 2009, 2011), an average of 152 young adults, with the
   CerebrA atlas (Manera et al. 2020) in the same space, shrunk to the head
   model's size (js/template.js, made by tools/build_template.py).  One
   compressed file, data/mni152.bin.gz, holds three volumes: the T1 at
   1.5 mm, an atlas label for every voxel, and the scalp's signed distance
   at 3 mm for the digitizer and ICP.  It is fetched the first time a tab
   needs the anatomy; until it arrives, or if it cannot be loaded (a page
   opened from the disk, a browser that cannot decompress it), the
   synthetic head in mri.js stands in.

   Frames: the MRI frame is the template's own (MNI) coordinates times the
   scale, in cm, so the anatomy needs no transform of its own; head
   coordinates reach it through the true head-to-MRI transform. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, T = MEG.TEMPLATE;
  if (!T || !MEG.mri) return;
  const M = MEG.mri;

  // Undo the plane predictor of the build script: each voxel was stored as
  // its difference from left + up - upleft within its axial slice, mod 256.
  function unpredict(res, nx, ny, nz) {
    const a = new Uint8Array(nx * ny * nz);
    for (let k = 0; k < nz; k++) {
      const o = k * nx * ny;
      a[o] = res[o];
      for (let i = 1; i < nx; i++) a[o + i] = (res[o + i] + a[o + i - 1]) & 255;
      for (let j = 1; j < ny; j++) {
        const r = o + j * nx, u = r - nx;
        a[r] = (res[r] + a[u]) & 255;
        for (let i = 1; i < nx; i++) a[r + i] = (res[r + i] + a[r + i - 1] + a[u + i] - a[u + i - 1]) & 255;
      }
    }
    return a;
  }

  function build(u8) {
    const V = T.volume, [nx, ny, nz] = V.t1.dims, n = nx * ny * nz, [sx, sy, sz] = V.sdf.dims;
    if (u8.length !== V.bytes) throw new Error(`the template volume has ${u8.length} bytes, not ${V.bytes}`);
    const t1 = unpredict(u8.subarray(0, n), nx, ny, nz);
    const lab = u8.slice(n, 2 * n);
    const sdq = unpredict(u8.subarray(2 * n, 2 * n + sx * sy * sz), sx, sy, sz);
    const sc = T.scale, lo = V.lo, st = V.t1.step, slo = V.sdf.lo, ss = V.sdf.step, unit = V.sdf.unit, zero = V.sdf.zero;
    // the rotation, orthonormal again after its rounding in template.js
    const R0 = T.toMRI.R, a = v3.unit(R0[0]), b = v3.unit(v3.sub(R0[1], v3.scale(a, v3.dot(a, R0[1]))));
    const TRUE = { R: [a, b, v3.cross(a, b)], t: T.toMRI.t.slice() }, TRUE_INV = M.invert(TRUE);
    const apply = M.apply;
    const toTpl = m => [m[0] * 10 / sc, m[1] * 10 / sc, m[2] * 10 / sc];       // MRI cm -> template mm
    const headToTpl = p => toTpl(apply(TRUE, p));

    // The T1 (0 to 1) at a template point, trilinear.
    function t1At(q) {
      const fx = (q[0] - lo[0]) / st, fy = (q[1] - lo[1]) / st, fz = (q[2] - lo[2]) / st;
      if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return 0;
      const i = Math.min(nx - 2, fx | 0), j = Math.min(ny - 2, fy | 0), k = Math.min(nz - 2, fz | 0);
      const a = fx - i, b = fy - j, c = fz - k, X = nx, XY = nx * ny, o = k * XY + j * X + i;
      const v00 = t1[o] + a * (t1[o + 1] - t1[o]), v10 = t1[o + X] + a * (t1[o + X + 1] - t1[o + X]);
      const v01 = t1[o + XY] + a * (t1[o + XY + 1] - t1[o + XY]), v11 = t1[o + XY + X] + a * (t1[o + XY + X + 1] - t1[o + XY + X]);
      const w0 = v00 + b * (v10 - v00), w1 = v01 + b * (v11 - v01);
      return (w0 + c * (w1 - w0)) / 255;
    }
    // The atlas code of the voxel a template point falls in.
    function codeAt(q) {
      const i = Math.round((q[0] - lo[0]) / st), j = Math.round((q[1] - lo[1]) / st), k = Math.round((q[2] - lo[2]) / st);
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
      return lab[(k * ny + j) * nx + i];
    }
    // The scalp's signed distance (template mm, positive outside), trilinear,
    // continued past the edge of its box by the distance to the box.
    function sdfAt(q) {
      let fx = (q[0] - slo[0]) / ss, fy = (q[1] - slo[1]) / ss, fz = (q[2] - slo[2]) / ss, extra = 0;
      const cl = (f, m) => { if (f < 0) { extra += -f * ss; return 0; } if (f > m - 1) { extra += (f - m + 1) * ss; return m - 1; } return f; };
      fx = cl(fx, sx); fy = cl(fy, sy); fz = cl(fz, sz);
      const i = Math.min(sx - 2, fx | 0), j = Math.min(sy - 2, fy | 0), k = Math.min(sz - 2, fz | 0);
      const a = fx - i, b = fy - j, c = fz - k, X = sx, XY = sx * sy, o = k * XY + j * X + i;
      const v00 = sdq[o] + a * (sdq[o + 1] - sdq[o]), v10 = sdq[o + X] + a * (sdq[o + X + 1] - sdq[o + X]);
      const v01 = sdq[o + XY] + a * (sdq[o + XY + 1] - sdq[o + XY]), v11 = sdq[o + XY + X] + a * (sdq[o + XY + X + 1] - sdq[o + XY + X]);
      const w0 = v00 + b * (v10 - v00), w1 = v01 + b * (v11 - v01);
      return (w0 + c * (w1 - w0) - zero) * unit + extra;
    }
    // Head frame, cm.
    const skinSDF = p => sdfAt(headToTpl(p)) * sc / 10;
    function nearestScalp(q) {
      let p = q.slice();
      for (let it = 0; it < 60; it++) {
        const d = skinSDF(p);
        if (Math.abs(d) < 1e-10) break;
        const e = 1e-4;
        const gx = (skinSDF([p[0] + e, p[1], p[2]]) - skinSDF([p[0] - e, p[1], p[2]])) / (2 * e);
        const gy = (skinSDF([p[0], p[1] + e, p[2]]) - skinSDF([p[0], p[1] - e, p[2]])) / (2 * e);
        const gz = (skinSDF([p[0], p[1], p[2] + e]) - skinSDF([p[0], p[1], p[2] - e])) / (2 * e);
        const g2 = gx * gx + gy * gy + gz * gz || 1;
        p = [p[0] - d * gx / g2, p[1] - d * gy / g2, p[2] - d * gz / g2];
      }
      return p;
    }

    /* One slice of the MRI, as in mri.js: plane 'axial', 'coronal' or
       'sagittal' at the fixed MRI coordinate `at` (cm), covering +-half cm
       around the head's centre, neurological convention, face on the left
       of sagittal slices.  Each pixel averages four samples, as a voxel
       averages what it contains. */
    function slice(plane, at, res, half, centre) {
      const c = centre || apply(TRUE, [0, 0, 0]);
      const img = new Float32Array(res * res), step = 2 * half / res, h = step / 4;
      const pt = plane === 'axial' ? (a, b) => [c[0] + a, c[1] + b, at] : plane === 'coronal' ? (a, b) => [c[0] + a, at, c[2] + b] : (a, b) => [at, c[1] - a, c[2] + b];
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
          const a = -half + (i + 0.5) * step, b = half - (j + 0.5) * step;
          img[j * res + i] = 0.25 * (t1At(toTpl(pt(a - h, b - h))) + t1At(toTpl(pt(a + h, b - h))) + t1At(toTpl(pt(a - h, b + h))) + t1At(toTpl(pt(a + h, b + h))));
        }
      }
      return img;
    }
    function slicePixel(plane, m, res, half, centre) {
      const c = centre || apply(TRUE, [0, 0, 0]);
      let a, b, off;
      if (plane === 'axial') { a = m[0] - c[0]; b = m[1] - c[1]; off = m[2]; }
      else if (plane === 'coronal') { a = m[0] - c[0]; b = m[2] - c[2]; off = m[1]; }
      else { a = c[1] - m[1]; b = m[2] - c[2]; off = m[0]; }
      return { x: (a + half) / (2 * half) * res, y: (half - b) / (2 * half) * res, off };
    }

    /* The atlas: CerebrA's regions and the tissue around them.  White
       matter carries the name of the gyrus above it (within 7 mm); the rest
       of the codes are the build script's classes outside the atlas. */
    const NAMES = T.names, WM = T.wmOf;
    const entry = code => (code > WM && code <= WM + 102 ? [NAMES[code - WM][0], NAMES[code - WM][1], 'white matter'] : NAMES[code] || NAMES[0]);
    // A point on the skin can round to a voxel just outside it: the distance decides.
    const codeOf = q => { const c = codeAt(q); return c === 0 && sdfAt(q) < 0 ? 106 : c; };
    function label(p) {
      const q = headToTpl(p), e = entry(codeOf(q));
      const side = e[1] === 'L' ? 'left ' : e[1] === 'R' ? 'right ' : e[1] === 'x' ? (q[0] < 0 ? 'left ' : 'right ') : '';
      return side + e[0];
    }
    const tissue = p => entry(codeOf(headToTpl(p)))[2];

    /* The digitizer: points over the scalp above the ears, leaving out the
       face and the ears themselves, a line down the bridge of the nose (the
       template's tip is cut off by its field of view), and the landmarks. */
    function digitize(seed, opts) {
      opts = opts || {};
      const stm = MEG.stream(seed || 1, 'digitizer'), noise = opts.noise === undefined ? 0.1 : opts.noise;
      const jit = p => v3.add(p, [noise * stm.gauss(), noise * stm.gauss(), noise * stm.gauss()]);
      const pts = [], ears = T.canal;
      MEG.fibonacciSphere(400).forEach(u => {
        if (u[2] < -0.3) return;
        if (u[1] > 0.45 && u[2] < -0.15) return;
        const p = nearestScalp(v3.scale(u, MEG.scalpR(u)));
        if (Math.min(v3.norm(v3.sub(p, ears[0])), v3.norm(v3.sub(p, ears[1]))) < 3.2) return;
        if (pts.length < (opts.scalp || 110) && stm.next() < 0.45) pts.push(jit(p));
      });
      if (opts.nose !== false) {
        const N = T.fid.NAS;
        for (let k = 0; k < 18; k++) pts.push(jit(nearestScalp([(k % 3 - 1) * 0.3, N[1] + 2.5, N[2] - 0.15 - 1.45 * k / 17])));
      }
      const sf = MEG.stream(seed || 1, 'digitizer landmarks');
      const jitF = p => v3.add(p, [noise * sf.gauss(), noise * sf.gauss(), noise * sf.gauss()]);
      return { pts, fids: { NAS: jitF(T.fid.NAS), LPA: jitF(T.fid.LPA), RPA: jitF(T.fid.RPA) } };
    }

    return {
      kind: 'template', name: 'the MNI ICBM152 template', TRUE, TRUE_INV,
      FID: { NAS: T.fid.NAS.slice(), LPA: T.fid.LPA.slice(), RPA: T.fid.RPA.slice() },
      t1: p => t1At(headToTpl(p)), skinSDF, slice, slicePixel, nearestScalp, digitize, label, tissue,
      rim: T.rim.map(p => p.slice()),
      mm: v => v * 10 / sc, coordName: 'MNI',
      code: p => codeOf(headToTpl(p))
    };
  }

  // The file as the server sent it: still gzipped (as from GitHub Pages), or
  // already inflated by the browser when the server added Content-Encoding.
  async function inflate(u8) {
    if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
    if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot decompress the template');
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  let pending = null;
  // Load the template once; resolves with the MRI in use either way.
  M.load = function () {
    if (M.kind === 'template') return Promise.resolve(M.backend);
    if (pending) return pending;
    if (typeof fetch !== 'function') return Promise.resolve(M.backend);
    M.status = 'loading';
    pending = fetch(T.volume.file)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(buf => inflate(new Uint8Array(buf)))
      .then(u8 => { M.use(build(u8)); return M.backend; })
      .catch(err => { M.error = err; M.use(M.synthetic, 'failed'); return M.backend; });
    return pending;
  };
  // For tests and tools: use a buffer already in hand (uncompressed).
  M.useBuffer = function (u8) { M.use(build(u8)); return M.backend; };
})(typeof window !== 'undefined' ? window : globalThis);
