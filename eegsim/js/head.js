/* EEG simulator: the head.
   A four-shell spherical head (brain, CSF, skull, scalp), the 10-10
   electrode system laid out on it, the three caps, the analytic forward
   solution for a current dipole, and spherical splines for maps and the
   surface Laplacian.

   Coordinates are in centimetres with x to the right ear, y to the nose
   and z up through the vertex. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const v3 = EEG.v3;
  const DEG = Math.PI / 180;

  /* ---------- the head model ---------- */
  const HEAD = {
    R: 9.2,
    radii: [8.0, 8.2, 8.7, 9.2],           // outer radius of brain, CSF, skull, scalp
    names: ['brain', 'CSF', 'skull', 'scalp'],
    sigma: [0.33, 1.79, 0.0083, 0.33],     // S/m; skull is 1/40 of brain by default
    brainR: 8.0,
    maxSourceR: 7.9                        // dipoles must sit inside the brain
  };
  EEG.HEAD = HEAD;

  const NMAX = 120;

  /* Transfer coefficients of the layered sphere.  For each Legendre order n
     the potential in shell j is a_j r^n + b_j r^-(n+1).  Starting with
     b = 1 in the scalp and zero normal current at the surface, the
     continuity of potential and of normal current density is propagated
     inward to the brain, where b_brain is the dipole's own coefficient.
     t_n is then the surface potential per unit source coefficient, and for a
     single homogeneous shell it reduces to (2n+1)/n. Radii are normalised so
     the scalp is r = 1. */
  function transfer(radii, sigma, nmax) {
    const R = radii[radii.length - 1];
    const r = radii.map(x => x / R);
    const N = r.length;
    const t = new Float64Array(nmax + 1);
    for (let n = 1; n <= nmax; n++) {
      let b = 1, a = (n + 1) / n;
      const vs = a + b;
      for (let j = N - 2; j >= 0; j--) {
        const rr = r[j];
        const rn = Math.pow(rr, n), rm = Math.pow(rr, -n - 1);
        const u = a * rn + b * rm;
        const w = sigma[j + 1] * (n * a * rn - (n + 1) * b * rm) / rr;
        const aj = ((n + 1) * u / rr + w / sigma[j]) / ((2 * n + 1) * rn / rr);
        const bj = (u - aj * rn) / rm;
        a = aj; b = bj;
      }
      t[n] = vs / b;
    }
    return t;
  }

  /* A head model bundles the geometry, conductivities and their transfer
     coefficients.  `homogeneous` replaces the four shells with one sphere of
     brain conductivity, which is what the head would look like to a dipole
     if the skull were not there. */
  function headModel(opts) {
    opts = opts || {};
    const sigma = (opts.sigma || HEAD.sigma).slice();
    const homogeneous = !!opts.homogeneous;
    const radii = homogeneous ? [HEAD.R] : HEAD.radii.slice();
    const sig = homogeneous ? [sigma[0]] : sigma;
    const R = HEAD.R;
    return {
      R, radii, sigma: sig, fullSigma: sigma, homogeneous,
      tn: transfer(radii, sig, NMAX),
      nmax: NMAX,
      // microvolts per nA*m, with R in metres: 1e-9 A*m * 1e6 uV/V / (4 pi sigma R^2)
      K: 1e-3 / (4 * Math.PI * sig[0] * Math.pow(R / 100, 2)),
      key: (homogeneous ? 'h' : 'l') + sig.map(s => s.toPrecision(4)).join(',')
    };
  }
  EEG.headModel = headModel;
  EEG.transfer = transfer;

  /* Lead field of a dipole at `pos` (cm) for electrodes `elecs` (unit
     vectors on the scalp).  Returns Float64Array(3 * ne): the potential at
     each electrode, in uV, for a 1 nA*m dipole along x, y and z.

     Surface potential, for x = cos(angle between electrode and dipole):
       V = K sum_n t_n rho^(n-1) [ n P_n(x) (q.p) + P'_n(x) (q.e - x q.p) ]
     which is the series for a dipole in a sphere written so that it holds
     for any orientation without splitting q into radial and tangential
     parts.  p is the unit vector to the dipole, e to the electrode. */
  function leadfield(model, pos, elecs, out) {
    const ne = elecs.length;
    out = out || new Float64Array(3 * ne);
    const r0 = v3.norm(pos);
    const rho = r0 / model.R;
    const p = r0 > 1e-9 ? [pos[0] / r0, pos[1] / r0, pos[2] / r0] : [0, 0, 1];
    const tn = model.tn;
    // weights w_n = t_n rho^(n-1), truncated once they no longer matter
    const w = leadfield._w || (leadfield._w = new Float64Array(NMAX + 1));
    let nUse = 1, pw = 1;
    for (let n = 1; n <= model.nmax; n++) {
      w[n] = tn[n] * pw;
      nUse = n;
      if (n > 3 && Math.abs(w[n]) * n * n < 1e-10 * Math.abs(w[1])) break;
      pw *= rho;
    }
    const K = model.K;
    for (let e = 0; e < ne; e++) {
      const u = elecs[e];
      const x = EEG.clamp(u[0] * p[0] + u[1] * p[1] + u[2] * p[2], -1, 1);
      let Pm = 1, P = x, dPm = 0, dP = 1;
      let S1 = w[1] * P, S2 = w[1] * dP;
      for (let n = 1; n < nUse; n++) {
        const Pn = ((2 * n + 1) * x * P - n * Pm) / (n + 1);
        const dPn = dPm + (2 * n + 1) * P;
        Pm = P; P = Pn; dPm = dP; dP = dPn;
        const k = n + 1;
        S1 += w[k] * k * P;
        S2 += w[k] * dP;
      }
      const a = K * (S1 - x * S2), b = K * S2;
      out[3 * e] = a * p[0] + b * u[0];
      out[3 * e + 1] = a * p[1] + b * u[1];
      out[3 * e + 2] = a * p[2] + b * u[2];
    }
    return out;
  }
  EEG.leadfield = leadfield;

  // Potentials (uV) at the electrodes for a dipole of moment `q` (nA*m vector).
  EEG.forward = function (model, pos, q, elecs) {
    const L = leadfield(model, pos, elecs);
    const v = new Float64Array(elecs.length);
    for (let e = 0; e < elecs.length; e++) v[e] = L[3 * e] * q[0] + L[3 * e + 1] * q[1] + L[3 * e + 2] * q[2];
    return v;
  };

  /* ---------- the 10-10 system ---------- */
  function sph(thetaDeg, azDeg) {
    const t = thetaDeg * DEG, a = azDeg * DEG;
    return [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
  }
  EEG.sph = sph;

  // Points along the circle on the sphere through A, B and C, equally spaced
  // in angle: the arcs that the 10-10 rows follow from ear to ear.
  function arc(A, B, C, steps) {
    const n = v3.unit(v3.cross(v3.sub(B, A), v3.sub(C, A)));
    const c = v3.scale(n, v3.dot(n, A));
    const ua = v3.sub(A, c), ub = v3.sub(B, c), uc = v3.sub(C, c);
    const e1 = v3.unit(ua);
    let e2 = v3.unit(v3.cross(n, e1));
    if (v3.dot(ub, e2) < 0) e2 = v3.scale(e2, -1);
    let total = Math.atan2(v3.dot(uc, e2), v3.dot(uc, e1));
    if (total < 0) total += 2 * Math.PI;
    const r = v3.norm(ua), out = [];
    for (let k = 0; k <= steps; k++) {
      const ang = total * k / steps;
      out.push(v3.unit(v3.add(c, v3.add(v3.scale(e1, r * Math.cos(ang)), v3.scale(e2, r * Math.sin(ang))))));
    }
    return out;
  }

  const ELEC = {};
  (function build() {
    // The equator is the 10% ring through Fpz, T7, Oz and T8, spaced 18 deg.
    const ring = [['Fpz', 0], ['Fp2', 18], ['AF8', 36], ['F8', 54], ['FT8', 72], ['T8', 90], ['TP8', 108],
      ['P8', 126], ['PO8', 144], ['O2', 162], ['Oz', 180], ['O1', -162], ['PO7', -144], ['P7', -126],
      ['TP7', -108], ['T7', -90], ['FT7', -72], ['F7', -54], ['AF7', -36], ['Fp1', -18]];
    ring.forEach(([k, az]) => { ELEC[k] = sph(90, az); });
    // Midline
    [['AFz', 72, 0], ['Fz', 54, 0], ['FCz', 36, 0], ['Cz', 0, 0], ['CPz', 36, 180], ['Pz', 54, 180],
      ['POz', 72, 180], ['Iz', 108, 180], ['Nz', 108, 0]].forEach(([k, t, az]) => { ELEC[k] = sph(t, az); });
    // Coronal-ish rows, each an arc from the left equator through the midline to the right
    const rows = [
      [['AF7', 'AF5', 'AF3', 'AF1', 'AFz', 'AF2', 'AF4', 'AF6', 'AF8']],
      [['F7', 'F5', 'F3', 'F1', 'Fz', 'F2', 'F4', 'F6', 'F8']],
      [['FT7', 'FC5', 'FC3', 'FC1', 'FCz', 'FC2', 'FC4', 'FC6', 'FT8']],
      [['T7', 'C5', 'C3', 'C1', 'Cz', 'C2', 'C4', 'C6', 'T8']],
      [['TP7', 'CP5', 'CP3', 'CP1', 'CPz', 'CP2', 'CP4', 'CP6', 'TP8']],
      [['P7', 'P5', 'P3', 'P1', 'Pz', 'P2', 'P4', 'P6', 'P8']],
      [['PO7', 'PO5', 'PO3', 'PO1', 'POz', 'PO2', 'PO4', 'PO6', 'PO8']]
    ];
    rows.forEach(([labels]) => {
      const pts = arc(ELEC[labels[0]], ELEC[labels[4]], ELEC[labels[8]], 8);
      labels.forEach((k, i) => { ELEC[k] = pts[i]; });
    });
    // The 10% ring below the equator, and the mastoids
    [['P9', -126], ['P10', 126], ['TP9', -108], ['TP10', 108], ['PO9', -144], ['PO10', 144]]
      .forEach(([k, az]) => { ELEC[k] = sph(108, az); });
    ELEC.M1 = sph(116, -112);
    ELEC.M2 = sph(116, 112);
  })();
  EEG.ELEC = ELEC;

  // Old 10-20 names still printed on many caps.
  EEG.ALIAS = { T3: 'T7', T4: 'T8', T5: 'P7', T6: 'P8', A1: 'M1', A2: 'M2' };
  EEG.resolveLabel = function (name) {
    if (!name) return null;
    const direct = Object.keys(ELEC).find(k => k.toLowerCase() === String(name).toLowerCase());
    if (direct) return direct;
    const al = Object.keys(EEG.ALIAS).find(k => k.toLowerCase() === String(name).toLowerCase());
    return al ? EEG.ALIAS[al] : null;
  };

  // Front to back, left to right: the order traces are drawn in.
  EEG.DISPLAY_ORDER = ['Fp1', 'Fpz', 'Fp2', 'AF7', 'AF3', 'AFz', 'AF4', 'AF8',
    'F7', 'F5', 'F3', 'F1', 'Fz', 'F2', 'F4', 'F6', 'F8',
    'FT7', 'FC5', 'FC3', 'FC1', 'FCz', 'FC2', 'FC4', 'FC6', 'FT8',
    'T7', 'C5', 'C3', 'C1', 'Cz', 'C2', 'C4', 'C6', 'T8',
    'TP7', 'CP5', 'CP3', 'CP1', 'CPz', 'CP2', 'CP4', 'CP6', 'TP8',
    'P9', 'P7', 'P5', 'P3', 'P1', 'Pz', 'P2', 'P4', 'P6', 'P8', 'P10',
    'PO7', 'PO3', 'POz', 'PO4', 'PO8', 'O1', 'Oz', 'O2', 'Iz', 'M1', 'M2'];

  const CAPS = {
    19: ['Fp1', 'Fp2', 'F7', 'F3', 'Fz', 'F4', 'F8', 'T7', 'C3', 'Cz', 'C4', 'T8', 'P7', 'P3', 'Pz', 'P4', 'P8', 'O1', 'O2'],
    32: ['Fp1', 'AF3', 'F7', 'F3', 'FC1', 'FC5', 'T7', 'C3', 'CP1', 'CP5', 'P7', 'P3', 'Pz', 'PO3', 'O1', 'Oz',
      'O2', 'PO4', 'P4', 'P8', 'CP6', 'CP2', 'C4', 'T8', 'FC6', 'FC2', 'F4', 'F8', 'AF4', 'Fp2', 'Fz', 'Cz'],
    64: ['Fp1', 'AF7', 'AF3', 'F1', 'F3', 'F5', 'F7', 'FT7', 'FC5', 'FC3', 'FC1', 'C1', 'C3', 'C5', 'T7', 'TP7',
      'CP5', 'CP3', 'CP1', 'P1', 'P3', 'P5', 'P7', 'P9', 'PO7', 'PO3', 'O1', 'Iz', 'Oz', 'POz', 'Pz', 'CPz',
      'Fpz', 'Fp2', 'AF8', 'AF4', 'AFz', 'Fz', 'F2', 'F4', 'F6', 'F8', 'FT8', 'FC6', 'FC4', 'FC2', 'FCz', 'Cz',
      'C2', 'C4', 'C6', 'T8', 'TP8', 'CP6', 'CP4', 'CP2', 'P2', 'P4', 'P6', 'P8', 'P10', 'PO8', 'PO4', 'O2']
  };
  EEG.sortLabels = labels => labels.slice().sort((a, b) => EEG.DISPLAY_ORDER.indexOf(a) - EEG.DISPLAY_ORDER.indexOf(b));
  EEG.capLabels = n => EEG.sortLabels(CAPS[n] || CAPS[32]);
  EEG.CAP_SIZES = [19, 32, 64];

  // Clinical bipolar chains: the longitudinal "double banana" and the transverse rows.
  EEG.BIPOLAR = {
    longitudinal: [
      ['Fp1', 'F7'], ['F7', 'T7'], ['T7', 'P7'], ['P7', 'O1'],
      ['Fp1', 'F3'], ['F3', 'C3'], ['C3', 'P3'], ['P3', 'O1'],
      ['Fz', 'Cz'], ['Cz', 'Pz'],
      ['Fp2', 'F4'], ['F4', 'C4'], ['C4', 'P4'], ['P4', 'O2'],
      ['Fp2', 'F8'], ['F8', 'T8'], ['T8', 'P8'], ['P8', 'O2']
    ],
    transverse: [
      ['F7', 'F3'], ['F3', 'Fz'], ['Fz', 'F4'], ['F4', 'F8'],
      ['T7', 'C3'], ['C3', 'Cz'], ['Cz', 'C4'], ['C4', 'T8'],
      ['P7', 'P3'], ['P3', 'Pz'], ['Pz', 'P4'], ['P4', 'P8']
    ]
  };

  /* ---------- dipole placement helpers ----------
     "at Pz depth 3 cm" puts the dipole 3 cm below the scalp on the radius
     through Pz.  Orientation is a tilt from the outward radial direction
     (0 = radial out, 90 = tangential, 180 = radial in) and a direction for
     the tangential part, given either as an electrode to lean toward or an
     angle in the tangent plane (0 = toward the nose, 90 = toward the right ear). */
  EEG.placeDipole = function (label, depthCm) {
    const u = ELEC[label] || ELEC.Cz;
    const r = EEG.clamp(HEAD.R - depthCm, 0, HEAD.maxSourceR);
    return v3.scale(u, r);
  };
  EEG.depthOf = pos => HEAD.R - v3.norm(pos);
  EEG.tangentFrame = function (pos) {
    const r = v3.norm(pos);
    const rh = r > 1e-6 ? v3.scale(pos, 1 / r) : [0, 0, 1];
    let ref = [0, 1, 0];
    if (Math.abs(v3.dot(ref, rh)) > 0.97) ref = [0, 0, 1];
    const t1 = v3.unit(v3.sub(ref, v3.scale(rh, v3.dot(ref, rh))));   // toward the nose
    let t2 = v3.unit(v3.cross(t1, rh));                               // toward the right ear
    return { rh, t1, t2 };
  };
  EEG.orientation = function (pos, tiltDeg, dirDeg, towardLabel) {
    const f = EEG.tangentFrame(pos);
    let tdir;
    if (towardLabel && ELEC[towardLabel]) {
      const target = v3.scale(ELEC[towardLabel], HEAD.R);
      const d = v3.sub(target, pos);
      const tang = v3.sub(d, v3.scale(f.rh, v3.dot(d, f.rh)));
      tdir = v3.norm(tang) > 1e-6 ? v3.unit(tang) : f.t1;
    } else {
      const a = (dirDeg || 0) * DEG;
      tdir = v3.add(v3.scale(f.t1, Math.cos(a)), v3.scale(f.t2, Math.sin(a)));
    }
    const t = (tiltDeg || 0) * DEG;
    return v3.unit(v3.add(v3.scale(f.rh, Math.cos(t)), v3.scale(tdir, Math.sin(t))));
  };
  // Recover tilt and in-plane direction from a moment vector, for the editors.
  EEG.orientationAngles = function (pos, ori) {
    const f = EEG.tangentFrame(pos);
    const c = EEG.clamp(v3.dot(ori, f.rh), -1, 1);
    const tilt = Math.acos(c) / DEG;
    const a = Math.atan2(v3.dot(ori, f.t2), v3.dot(ori, f.t1)) / DEG;
    return { tilt, dir: (a + 360) % 360 };
  };
  EEG.nearestElectrode = function (pos, labels) {
    const u = v3.unit(pos);
    let best = null, bd = -2;
    (labels || Object.keys(ELEC)).forEach(k => { const d = v3.dot(u, ELEC[k]); if (d > bd) { bd = d; best = k; } });
    return best;
  };

  /* ---------- map projection ----------
     Azimuthal equidistant, nose up.  The head outline is drawn at 110 deg
     from the vertex, a little below the 10% ring, so Fpz, T7, Oz and T8 sit
     about nine tenths of the way out. */
  const THETA_MAX = 110 * DEG;
  EEG.THETA_MAX = THETA_MAX;
  EEG.project = function (u) {
    const th = Math.acos(EEG.clamp(u[2], -1, 1));
    const az = Math.atan2(u[0], u[1]);
    const rho = th / THETA_MAX;
    return [rho * Math.sin(az), rho * Math.cos(az)];
  };
  EEG.unproject = function (mx, my) {
    const rho = Math.hypot(mx, my);
    const th = rho * THETA_MAX, az = Math.atan2(mx, my);
    return [Math.sin(th) * Math.sin(az), Math.sin(th) * Math.cos(az), Math.cos(th)];
  };
  EEG.topoGrid = function (res) {
    const idx = [], pts = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const mx = (i + 0.5) / res * 2 - 1, my = 1 - (j + 0.5) / res * 2;
        if (mx * mx + my * my <= 1.0001) { idx.push(j * res + i); pts.push(EEG.unproject(mx, my)); }
      }
    }
    return { res, idx: Int32Array.from(idx), pts };
  };

  /* ---------- spherical splines ----------
     Perrin et al. (1989).  With m = 4 the interpolating function is
       g(x) = 1/(4 pi) sum (2n+1) / (n(n+1))^m P_n(x)
     and the surface Laplacian of the interpolant comes from the same sum
     with one power of n(n+1) removed.  Both are tabulated once. */
  const SPL = (function () {
    const M = 4, N = 60, T = 4001;
    const g = new Float64Array(T), h = new Float64Array(T);
    const P = new Float64Array(N + 1), dP = new Float64Array(N + 1);
    for (let i = 0; i < T; i++) {
      const x = -1 + 2 * i / (T - 1);
      EEG.legendre(x, N, P, dP);
      let sg = 0, sh = 0;
      for (let n = 1; n <= N; n++) {
        const nn = n * (n + 1);
        sg += (2 * n + 1) / Math.pow(nn, M) * P[n];
        sh += (2 * n + 1) / Math.pow(nn, M - 1) * P[n];
      }
      g[i] = sg / (4 * Math.PI);
      h[i] = sh / (4 * Math.PI);
    }
    function look(tab, x) {
      const f = (EEG.clamp(x, -1, 1) + 1) * (T - 1) / 2;
      const i = Math.min(T - 2, Math.floor(f)), t = f - i;
      return tab[i] * (1 - t) + tab[i + 1] * t;
    }
    return { g: x => look(g, x), h: x => look(h, x) };
  })();

  EEG.makeSpline = function (U, lambda) {
    lambda = lambda === undefined ? 1e-5 : lambda;
    const n = U.length;
    const A = EEG.la.zeros(n + 1, n + 1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] = SPL.g(v3.dot(U[i], U[j])) + (i === j ? lambda : 0);
      A[i][n] = 1; A[n][i] = 1;
    }
    const Minv = EEG.la.inverse(A);
    return {
      n, U,
      // W (points x n, row-major): values at the points from values at the electrodes
      interpMatrix(points) {
        const W = new Float32Array(points.length * n);
        const gk = new Float64Array(n);
        for (let p = 0; p < points.length; p++) {
          const q = points[p];
          for (let k = 0; k < n; k++) gk[k] = SPL.g(q[0] * U[k][0] + q[1] * U[k][1] + q[2] * U[k][2]);
          for (let j = 0; j < n; j++) {
            let s = Minv[n][j];
            for (let k = 0; k < n; k++) s += gk[k] * Minv[k][j];
            W[p * n + j] = s;
          }
        }
        return W;
      },
      // n x n operator giving the current source density, -Laplacian(V), in uV/cm^2
      csdMatrix() {
        const R2 = HEAD.R * HEAD.R;
        const T = EEG.la.zeros(n, n);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += SPL.h(v3.dot(U[i], U[k])) * Minv[k][j];
            T[i][j] = s / R2;
          }
        }
        return T;
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
