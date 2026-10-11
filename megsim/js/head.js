/* MEG simulator: the head and the sensors.
   One spherical head, used two ways.  For MEG the field outside a
   spherically symmetric conductor has an exact closed form (Sarvas, 1987)
   that does not depend on the conductivities at all, which is itself a
   lesson.  For the EEG comparison the same head is four shells (brain,
   CSF, skull, scalp) and the scalp potential is the exact series solution.
   The sensors are one whole-head array whose 102 sites carry
   magnetometers, axial gradiometers, planar gradiometers or, for the
   on-scalp alternative, optically pumped magnetometers.

   Coordinates are in centimetres with x to the right ear, y to the nose
   and z up through the vertex.  Fields are in femtotesla, dipole moments
   in nanoampere-metres. */
(function (G) {
  'use strict';
  const MEG = G.MEG;
  const v3 = MEG.v3;
  const DEG = Math.PI / 180;

  /* ---------- the head ---------- */
  const HEAD = {
    R: 9.2,
    radii: [8.0, 8.2, 8.7, 9.2],           // outer radius of brain, CSF, skull, scalp
    names: ['brain', 'CSF', 'skull', 'scalp'],
    sigma: [0.33, 1.79, 0.0083, 0.33],     // S/m; skull is 1/40 of brain by default
    brainR: 8.0,
    maxSourceR: 7.9
  };
  MEG.HEAD = HEAD;

  /* ---------- EEG: the four-shell sphere ----------
     For each Legendre order n the potential in shell j is
     a_j r^n + b_j r^-(n+1).  Starting with b = 1 in the scalp and zero
     normal current at the surface, continuity of potential and of normal
     current density is propagated inward to the brain, where b_brain is the
     dipole's own coefficient.  Every shell's coefficients are kept,
     normalised so b_brain = 1, because the cross-section views need the
     potential inside the head as well as on it.  Radii are normalised so
     the scalp is r = 1. */
  const NMAX = 120;
  function transfer(radii, sigma, nmax) {
    const R = radii[radii.length - 1];
    const r = radii.map(x => x / R);
    const N = r.length;
    const t = new Float64Array(nmax + 1);
    const A = r.map(() => new Float64Array(nmax + 1)), B = r.map(() => new Float64Array(nmax + 1));
    for (let n = 1; n <= nmax; n++) {
      let b = 1, a = (n + 1) / n;
      const vs = a + b;
      A[N - 1][n] = a; B[N - 1][n] = b;
      for (let j = N - 2; j >= 0; j--) {
        const rr = r[j];
        const rn = Math.pow(rr, n), rm = Math.pow(rr, -n - 1);
        const u = a * rn + b * rm;
        const w = sigma[j + 1] * (n * a * rn - (n + 1) * b * rm) / rr;
        const aj = ((n + 1) * u / rr + w / sigma[j]) / ((2 * n + 1) * rn / rr);
        const bj = (u - aj * rn) / rm;
        a = aj; b = bj;
        A[j][n] = a; B[j][n] = b;
      }
      t[n] = vs / b;
      for (let j = 0; j < N; j++) { A[j][n] /= b; B[j][n] /= b; }
    }
    return { t, A, B, rn: r };
  }

  function headModel(opts) {
    opts = opts || {};
    const sigma = (opts.sigma || HEAD.sigma).slice();
    const homogeneous = !!opts.homogeneous;
    const radii = homogeneous ? [HEAD.R] : HEAD.radii.slice();
    const sig = homogeneous ? [sigma[0]] : sigma;
    const R = HEAD.R;
    const tr = transfer(radii, sig, NMAX);
    return {
      R, radii, sigma: sig, fullSigma: sigma, homogeneous,
      tn: tr.t, coefA: tr.A, coefB: tr.B, rn: tr.rn,
      nmax: NMAX,
      // microvolts per nA*m, with R in metres: 1e-9 A*m * 1e6 uV/V / (4 pi sigma R^2)
      K: 1e-3 / (4 * Math.PI * sig[0] * Math.pow(R / 100, 2)),
      key: (homogeneous ? 'h' : 'l') + sig.map(s => s.toPrecision(4)).join(',')
    };
  }
  MEG.headModel = headModel;
  MEG.transfer = transfer;

  /* EEG lead field of a dipole at `pos` (cm) for electrodes `elecs` (unit
     vectors on the scalp): Float64Array(3 * ne), microvolts per nA*m for
     a dipole along x, y and z.  For x = cos(angle between electrode and
     dipole):  V = K sum_n t_n rho^(n-1) [ n P_n(x) (q.p) + P'_n(x) (q.e - x q.p) ]. */
  const lfW = new Float64Array(NMAX + 1);
  function leadfieldEEG(model, pos, elecs, out) {
    const ne = elecs.length;
    out = out || new Float64Array(3 * ne);
    const r0 = v3.norm(pos);
    const rho = r0 / model.R;
    const p = r0 > 1e-9 ? [pos[0] / r0, pos[1] / r0, pos[2] / r0] : [0, 0, 1];
    const tn = model.tn, w = lfW;
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
      const x = MEG.clamp(u[0] * p[0] + u[1] * p[1] + u[2] * p[2], -1, 1);
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
  MEG.leadfieldEEG = leadfieldEEG;
  MEG.forwardEEG = function (model, pos, q, elecs) {
    const L = leadfieldEEG(model, pos, elecs);
    const v = new Float64Array(elecs.length);
    for (let e = 0; e < elecs.length; e++) v[e] = L[3 * e] * q[0] + L[3 * e + 1] * q[1] + L[3 * e + 2] * q[2];
    return v;
  };

  /* ---------- MEG: the Sarvas formula ----------
     The magnetic field outside a spherically symmetric conductor centred
     at the origin, for a current dipole q at r0, including the volume
     currents:
        B(r) = mu0 / (4 pi F^2) [ F q x r0 - ((q x r0) . r) grad F ]
        F = a (r a + r^2 - r0 . r),  a = r - r0
        grad F = (a^2/r + a.r/a + 2a + 2r) r - (a + 2r + a.r/a) r0
     Only q x r0 enters, so a radial dipole makes no field outside, and a
     dipole at the centre makes none either.  With q in nA*m and lengths
     in cm, mu0/4pi makes the factor 1000 for femtotesla.
     sarvasPrep caches the q-independent part for one point. */
  function sarvasPrep(r, r0) {
    const ax = r[0] - r0[0], ay = r[1] - r0[1], az = r[2] - r0[2];
    const a = Math.sqrt(ax * ax + ay * ay + az * az);
    const rr = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    const adotr = ax * r[0] + ay * r[1] + az * r[2];
    const r0dotr = r0[0] * r[0] + r0[1] * r[1] + r0[2] * r[2];
    const F = a * (rr * a + rr * rr - r0dotr);
    const c1 = a * a / rr + adotr / a + 2 * a + 2 * rr;
    const c2 = a + 2 * rr + adotr / a;
    const gF = [c1 * r[0] - c2 * r0[0], c1 * r[1] - c2 * r0[1], c1 * r[2] - c2 * r0[2]];
    return { F, gF, r, r0 };
  }
  function sarvasFromPrep(P, q, out) {
    const r0 = P.r0, r = P.r;
    const cx = q[1] * r0[2] - q[2] * r0[1], cy = q[2] * r0[0] - q[0] * r0[2], cz = q[0] * r0[1] - q[1] * r0[0];
    const cr = cx * r[0] + cy * r[1] + cz * r[2];
    const k = 1000 / (P.F * P.F);
    out = out || [0, 0, 0];
    out[0] = k * (P.F * cx - cr * P.gF[0]);
    out[1] = k * (P.F * cy - cr * P.gF[1]);
    out[2] = k * (P.F * cz - cr * P.gF[2]);
    return out;
  }
  MEG.sarvas = (r, r0, q) => sarvasFromPrep(sarvasPrep(r, r0), q);
  MEG.sarvasPrep = sarvasPrep;
  MEG.sarvasFromPrep = sarvasFromPrep;

  // Field of the primary current alone (Biot-Savart for a current element), fT.
  MEG.biotSavart = function (r, r0, q) {
    const a = v3.sub(r, r0), d = v3.norm(a), d3 = d * d * d;
    const c = v3.cross(q, a);
    return [1000 * c[0] / d3, 1000 * c[1] / d3, 1000 * c[2] / d3];
  };

  /* Field of a magnetic dipole m (A*m^2) at rm, seen at r (cm), in fT:
     mu0/4pi [3 (m.a) a - m] / |a|^3, where 1e-7 * 1e6 (cm^-3 to m^-3) *
     1e15 (T to fT) gives the factor 1e14. */
  MEG.magDipole = function (r, rm, m, out) {
    const ax = r[0] - rm[0], ay = r[1] - rm[1], az = r[2] - rm[2];
    const d2 = ax * ax + ay * ay + az * az, d = Math.sqrt(d2), d3 = d2 * d;
    const md = (m[0] * ax + m[1] * ay + m[2] * az) / d2;
    const k = 1e14 / d3;
    out = out || [0, 0, 0];
    out[0] = k * (3 * md * ax - m[0]); out[1] = k * (3 * md * ay - m[1]); out[2] = k * (3 * md * az - m[2]);
    return out;
  };

  /* ---------- the 10-10 electrode system (for the EEG comparison) ---------- */
  function sph(thetaDeg, azDeg) {
    const t = thetaDeg * DEG, a = azDeg * DEG;
    return [Math.sin(t) * Math.sin(a), Math.sin(t) * Math.cos(a), Math.cos(t)];
  }
  MEG.sph = sph;
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
    const ring = [['Fpz', 0], ['Fp2', 18], ['AF8', 36], ['F8', 54], ['FT8', 72], ['T8', 90], ['TP8', 108],
      ['P8', 126], ['PO8', 144], ['O2', 162], ['Oz', 180], ['O1', -162], ['PO7', -144], ['P7', -126],
      ['TP7', -108], ['T7', -90], ['FT7', -72], ['F7', -54], ['AF7', -36], ['Fp1', -18]];
    ring.forEach(([k, az]) => { ELEC[k] = sph(90, az); });
    [['AFz', 72, 0], ['Fz', 54, 0], ['FCz', 36, 0], ['Cz', 0, 0], ['CPz', 36, 180], ['Pz', 54, 180],
      ['POz', 72, 180], ['Iz', 108, 180], ['Nz', 108, 0]].forEach(([k, t, az]) => { ELEC[k] = sph(t, az); });
    const rows = [
      ['AF7', 'AF5', 'AF3', 'AF1', 'AFz', 'AF2', 'AF4', 'AF6', 'AF8'],
      ['F7', 'F5', 'F3', 'F1', 'Fz', 'F2', 'F4', 'F6', 'F8'],
      ['FT7', 'FC5', 'FC3', 'FC1', 'FCz', 'FC2', 'FC4', 'FC6', 'FT8'],
      ['T7', 'C5', 'C3', 'C1', 'Cz', 'C2', 'C4', 'C6', 'T8'],
      ['TP7', 'CP5', 'CP3', 'CP1', 'CPz', 'CP2', 'CP4', 'CP6', 'TP8'],
      ['P7', 'P5', 'P3', 'P1', 'Pz', 'P2', 'P4', 'P6', 'P8'],
      ['PO7', 'PO5', 'PO3', 'PO1', 'POz', 'PO2', 'PO4', 'PO6', 'PO8']
    ];
    rows.forEach(labels => {
      const pts = arc(ELEC[labels[0]], ELEC[labels[4]], ELEC[labels[8]], 8);
      labels.forEach((k, i) => { ELEC[k] = pts[i]; });
    });
    // the inferior row, 10% below the equator
    [['F9', -54], ['F10', 54], ['FT9', -72], ['FT10', 72], ['T9', -90], ['T10', 90],
      ['P9', -126], ['P10', 126], ['TP9', -108], ['TP10', 108], ['PO9', -144], ['PO10', 144]]
      .forEach(([k, az]) => { ELEC[k] = sph(108, az); });
    ELEC.M1 = sph(116, -112);
    ELEC.M2 = sph(116, 112);
    // fiducials on the scalp: nasion and the two preauricular points
    ELEC.LPA = sph(112, -90);
    ELEC.RPA = sph(112, 90);
  })();
  MEG.ELEC = ELEC;
  MEG.ALIAS = { T3: 'T7', T4: 'T8', T5: 'P7', T6: 'P8', A1: 'M1', A2: 'M2' };
  MEG.EEG64 = ['Fp1', 'AF7', 'AF3', 'F1', 'F3', 'F5', 'F7', 'FT7', 'FC5', 'FC3', 'FC1', 'C1', 'C3', 'C5', 'T7', 'TP7',
    'CP5', 'CP3', 'CP1', 'P1', 'P3', 'P5', 'P7', 'P9', 'PO7', 'PO3', 'O1', 'Iz', 'Oz', 'POz', 'Pz', 'CPz',
    'Fpz', 'Fp2', 'AF8', 'AF4', 'AFz', 'Fz', 'F2', 'F4', 'F6', 'F8', 'FT8', 'FC6', 'FC4', 'FC2', 'FCz', 'Cz',
    'C2', 'C4', 'C6', 'T8', 'TP8', 'CP6', 'CP4', 'CP2', 'P2', 'P4', 'P6', 'P8', 'P10', 'PO8', 'PO4', 'O2'];
  MEG.PLACES = Object.keys(ELEC).filter(k => !['LPA', 'RPA', 'Nz', 'M1', 'M2'].includes(k));

  /* ---------- dipole placement ----------
     "at T7 depth 3 cm" puts the dipole 3 cm below the scalp on the radius
     through T7.  Orientation is a tilt from the outward radial direction
     (0 = radial out, 90 = tangential, 180 = radial in) and a direction for
     the tangential part, toward an electrode or as an angle in the tangent
     plane (0 = toward the nose, 90 = toward the right ear on top of the
     head). */
  MEG.placeDipole = function (label, depthCm) {
    const u = ELEC[label] || ELEC.Cz;
    const r = MEG.clamp(HEAD.R - depthCm, 0, HEAD.maxSourceR);
    return v3.scale(u, r);
  };
  MEG.depthOf = pos => HEAD.R - v3.norm(pos);
  MEG.tangentFrame = function (pos) {
    const r = v3.norm(pos);
    const rh = r > 1e-6 ? v3.scale(pos, 1 / r) : [0, 0, 1];
    let ref = [0, 1, 0];
    if (Math.abs(v3.dot(ref, rh)) > 0.97) ref = [0, 0, 1];
    const t1 = v3.unit(v3.sub(ref, v3.scale(rh, v3.dot(ref, rh))));
    const t2 = v3.unit(v3.cross(t1, rh));
    return { rh, t1, t2 };
  };
  MEG.orientation = function (pos, tiltDeg, dirDeg, towardLabel) {
    const f = MEG.tangentFrame(pos);
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
  MEG.orientationAngles = function (pos, ori) {
    const f = MEG.tangentFrame(pos);
    const c = MEG.clamp(v3.dot(ori, f.rh), -1, 1);
    const tilt = Math.acos(c) / DEG;
    const a = Math.atan2(v3.dot(ori, f.t2), v3.dot(ori, f.t1)) / DEG;
    return { tilt, dir: (a + 360) % 360 };
  };
  MEG.nearestPlace = function (pos) {
    const u = v3.unit(pos);
    let best = null, bd = -2;
    MEG.PLACES.forEach(k => { const d = v3.dot(u, ELEC[k]); if (d > bd) { bd = d; best = k; } });
    return best;
  };

  /* ---------- where the built-in generators sit ----------
     Auditory cortex lies on the supratemporal plane, inside the Sylvian
     fissure, so its current flows up and down: tangential to the head and
     ideal for MEG.  The right one sits a little further forward than the
     left, as in most brains.  The hand area of primary somatosensory
     cortex (area 3b) lines the back wall of the central sulcus, so the
     N20m current points forward, also tangential.  The beta rhythm comes
     from the motor strip on the front wall, under a centimetre away.
     Alpha comes from the walls of the parieto-occipital and calcarine
     sulci. */
  function tangential(pos, dirVec) {
    const rh = v3.unit(pos);
    return v3.unit(v3.sub(dirVec, v3.scale(rh, v3.dot(dirVec, rh))));
  }
  function generator(name, dir, depth, ori, role) {
    const pos = v3.scale(v3.unit(dir), MEG.clamp(HEAD.R - depth, 0, HEAD.maxSourceR));
    const o = typeof ori === 'function' ? ori(pos) : ori;
    const ang = MEG.orientationAngles(pos, o);
    return { name, pos, ori: o, depth: HEAD.R - v3.norm(pos), at: MEG.nearestPlace(pos), tilt: ang.tilt, dir: ang.dir, toward: null, role: role || 'evoked' };
  }
  MEG.evokedDipoles = function (s) {
    if (s.type === 'auditory') {
      const out = [];
      if (s.side !== 'right') out.push(generator('left', [-5.7, -0.9, -1.6], s.depth, p => tangential(p, [0, 0.3, -1])));
      if (s.side !== 'left') out.push(generator('right', [5.7, -0.4, -1.6], s.depth, p => tangential(p, [0, 0.3, -1])));
      return out;
    }
    const hem = s.side === 'right' ? 'C4' : 'C3', front = s.side === 'right' ? 'FC4' : 'FC3';
    const out = [generator('S1', ELEC[hem], s.depth, p => MEG.orientation(p, 90, 0))];
    if (s.beta) out.push(generator('M1 beta', v3.lerp(ELEC[hem], ELEC[front], 0.2), s.depth, p => MEG.orientation(p, 90, 0), 'beta'));
    return out;
  };
  MEG.alphaDipoles = function (depth) {
    return [
      generator('left', [-1.8, -6.0, 1.8], depth, p => MEG.orientation(p, 90, 0, 'Cz')),
      generator('right', [1.8, -6.0, 1.8], depth, p => MEG.orientation(p, 90, 0, 'Cz'))
    ];
  };

  /* ---------- the whole-head sensor array ----------
     102 sites in rings 16 degrees apart, the lower rings cut away in front
     where the face is.  Names follow the CTF style: M, then L, R or Z for
     the side, then the region (F frontal, C central, T temporal, P
     parietal, O occipital), then the row and the place in the row. */
  /* The SQUID helmet is not a sphere around the head: real helmets are
     shaped for the population, so the coils sit 2.4 cm from the scalp on
     top, nearly 4 cm in front.  That spread of distances is also what lets
     SSS tell sources inside the helmet from sources outside it; on a
     sphere centred on the head the two would look identical to radial
     coils. */
  const ARRAY = {
    helmet: { centre: [0, 1.0, 0.6], axes: [12.0, 13.2, 11.0] },   // ellipsoid for the SQUID pickup coils
    squidR: 11.6,             // distance of the top coil from the centre of the head
    opmGap: 0.6,              // OPM sensing volume above the scalp
    axialBase: 5.0,           // axial gradiometer baseline
    planarBase: 1.68,         // planar gradiometer baseline
    noise: { mag: 3, axial: 4, planar: 3, opm: 15, ref: 1 }   // fT/sqrt(Hz) (fT/cm/sqrt(Hz) for planar); references are larger, quieter coils
  };
  // Where a site direction meets the helmet, and the helmet's outward normal there.
  function helmetPoint(u) {
    const H = ARRAY.helmet, a = H.axes;
    const t = 1 / Math.sqrt((u[0] / a[0]) ** 2 + (u[1] / a[1]) ** 2 + (u[2] / a[2]) ** 2);
    const q = v3.scale(u, t);
    return { r: v3.add(H.centre, q), n: v3.unit([q[0] / (a[0] * a[0]), q[1] / (a[1] * a[1]), q[2] / (a[2] * a[2])]) };
  }
  MEG.helmetPoint = helmetPoint;
  MEG.ARRAY = ARRAY;
  MEG.SENSOR_TYPES = ['mag', 'axial', 'planar', 'opm'];
  MEG.SENSOR_INFO = {
    mag: { label: 'Magnetometers', short: 'magnetometer', unit: 'fT', desc: 'One flat pickup coil per site, 2.4 cm above the scalp through the dewar. Measures the field itself: deep reach, but every distant source too.' },
    axial: { label: 'Axial gradiometers', short: 'axial gradiometer', unit: 'fT', desc: 'Two coaxial coils 5 cm apart, wound in opposition. A distant source puts nearly the same field through both and cancels; a nearby brain source does not.' },
    planar: { label: 'Planar gradiometers', short: 'planar gradiometer', unit: 'fT/cm', desc: 'Two figure-of-eight coils per site measuring the field’s slope along the surface in two directions, with a magnetometer beside them, as in the 306-channel MEGIN (Elekta) systems. The gradient peaks right above a source and falls off fastest with distance.' },
    opm: { label: 'OPMs on the scalp', short: 'OPM', unit: 'fT', desc: 'Optically pumped magnetometers in a helmet worn on the head, 6 mm from the scalp. No cryogenics, closer to the brain, but a higher noise floor and a small dynamic range.' }
  };

  function siteDirections() {
    const rings = [0, 16, 32, 48, 64, 80, 96, 112, 128];
    const cut = { 80: 44, 96: 62, 112: 80, 128: 112 };     // half-width of the face gap, degrees of azimuth
    const out = [];
    rings.forEach((th, ri) => {
      if (th === 0) { out.push({ th: 0, az: 0, ring: 0 }); return; }
      const n = Math.round(2 * Math.PI * Math.sin(th * DEG) / (16 * DEG));
      const c = cut[th] || 0;
      for (let k = 0; k < n; k++) {
        let az = (k + (ri % 2 ? 0.5 : 0)) * 360 / n;
        if (az > 180) az -= 360;
        if (Math.abs(az) < c) continue;
        out.push({ th, az, ring: ri });
      }
    });
    return out;
  }
  function classify(th, az) {
    const a = Math.abs(az);
    const side = (Math.abs(Math.sin(az * DEG)) * Math.sin(th * DEG) < 0.09) ? 'Z' : (az < 0 ? 'L' : 'R');
    let lobe;
    if (th < 20) lobe = 'C';
    else if (th >= 76 && a >= 50 && a <= 140) lobe = 'T';
    else if (a >= 140 && th >= 60) lobe = 'O';
    else if (th >= 100 && a >= 128) lobe = 'O';
    else if (a < 55) lobe = 'F';
    else if (a >= 108) lobe = 'P';
    else lobe = 'C';
    return { side, lobe };
  }
  const SITES = (function () {
    const dirs = siteDirections().map(d => Object.assign(d, classify(d.th, d.az), { u: sph(d.th, d.az) }));
    // number the sites within each side and region: row, then front to back
    const groups = {};
    dirs.forEach(d => { const k = d.side + d.lobe; (groups[k] = groups[k] || []).push(d); });
    Object.keys(groups).forEach(k => {
      const g = groups[k];
      const rows = Array.from(new Set(g.map(d => d.ring))).sort((a, b) => a - b);
      g.forEach(d => { d.row = rows.indexOf(d.ring) + 1; });
      rows.forEach((rg, i) => {
        g.filter(d => d.ring === rg).sort((a, b) => Math.abs(a.az) - Math.abs(b.az)).forEach((d, j) => { d.col = j + 1; });
      });
      g.forEach(d => { d.name = `M${d.side}${d.lobe}${d.row}${d.col}`; });
    });
    // display order: region from front to back, then left to right
    const regionOrder = ['F', 'C', 'T', 'P', 'O'], sideOrder = ['L', 'Z', 'R'];
    dirs.sort((a, b) => regionOrder.indexOf(a.lobe) - regionOrder.indexOf(b.lobe) || sideOrder.indexOf(a.side) - sideOrder.indexOf(b.side) || a.row - b.row || a.col - b.col);
    return dirs;
  })();
  MEG.SITES = SITES;
  MEG.REGION_NAMES = { F: 'frontal', C: 'central', T: 'temporal', P: 'parietal', O: 'occipital' };
  MEG.SIDE_NAMES = { L: 'left', R: 'right', Z: 'midline' };

  /* Build the channels of one array type.  Each channel is a set of
     integration points {r, n, w}: the reading is sum w (n . B(r)).
     Magnetometers and OPMs have one point, gradiometers two.  Small
     gradiometer imbalances (the second coil is not quite equal and
     opposite) are drawn from a fixed stream so they never change. */
  function buildArray(type, opts) {
    opts = opts || {};
    const st = MEG.stream(opts.seed || 1, 'imbalance:' + type);
    const chans = [];
    const frame = type === 'opm' ? 'head' : 'device';
    const rS = type === 'opm' ? HEAD.R + ARRAY.opmGap : ARRAY.squidR;
    SITES.forEach((s, si) => {
      const u = s.u;
      const hp = type === 'opm' ? { r: v3.scale(u, rS), n: u } : helmetPoint(u);
      const pos = hp.r, nrm = hp.n;
      if (type === 'mag' || type === 'opm') {
        chans.push({ name: s.name, site: si, kind: type, unit: 'fT', pts: [{ r: pos, n: nrm, w: 1 }], u, pos, nrm });
      } else if (type === 'axial') {
        const eps = 0.004 * st.gauss();
        const up = v3.add(pos, v3.scale(nrm, ARRAY.axialBase));
        chans.push({ name: s.name, site: si, kind: 'axial', unit: 'fT', pts: [{ r: pos, n: nrm, w: 1 }, { r: up, n: nrm, w: -(1 + eps) }], u, pos, nrm, imbalance: eps });
      } else if (type === 'planar') {
        // a triplet, as in the 306-channel systems: one magnetometer and two planar gradiometers
        chans.push({ name: s.name, site: si, kind: 'mag', unit: 'fT', pts: [{ r: pos, n: nrm, w: 1 }], u, pos, nrm });
        const f = MEG.tangentFrame(nrm), b = ARRAY.planarBase;
        [['a', f.t1], ['b', f.t2]].forEach(([sfx, t]) => {
          const eps = 0.0005 * st.gauss();
          const rp = v3.add(pos, v3.scale(t, b / 2)), rm = v3.sub(pos, v3.scale(t, b / 2));
          chans.push({ name: s.name + sfx, site: si, kind: 'planar', axis: sfx, dir: t, unit: 'fT/cm', pts: [{ r: rp, n: nrm, w: 1 / b }, { r: rm, n: nrm, w: -(1 + eps) / b }], u, pos, nrm, imbalance: eps });
        });
      }
    });
    // The reference array, high in the dewar (or, for OPMs, on the wall
    // of the room): three triaxial magnetometers that see the environment
    // but almost none of the brain.
    const refPts = type === 'opm' ? [[0, -32, 24], [10, -32, 24], [0, -22, 24]] : [[0, 1, 28], [10, 1, 28], [0, 11, 28]];
    const refs = [];
    refPts.forEach((p, i) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((n, k) => {
      refs.push({ name: `R${i + 1}${'xyz'[k]}`, kind: 'ref', unit: 'fT', pts: [{ r: p, n, w: 1 }] });
    }));
    // the channel kind each map and trace view shows first: the gradiometers of a triplet array
    const main = type === 'planar' ? 'planar' : type;
    return {
      type, frame, label: MEG.SENSOR_INFO[type].label, unit: type === 'planar' ? 'fT/cm' : 'fT', main,
      kinds: Array.from(new Set(chans.map(c => c.kind))),
      channels: chans, refs, names: chans.map(c => c.name), nch: chans.length,
      siteR: rS, noise: ARRAY.noise[type], perSite: type === 'planar' ? 3 : 1,
      siteChannels: SITES.map((_, si) => chans.map((c, i) => c.site === si ? i : -1).filter(i => i >= 0)),
      sitePos: SITES.map(s => type === 'opm' ? v3.scale(s.u, rS) : helmetPoint(s.u).r)
    };
  }
  MEG.buildArray = buildArray;
  // Noise density of a channel: magnetometers in fT, gradiometers in fT/cm, both per root hertz.
  MEG.chanNoise = (arr, ch, override) => override || (ch.kind === 'mag' && arr.type === 'planar' ? ARRAY.noise.mag : arr.noise);
  MEG.KIND_LABEL = { mag: 'magnetometers', axial: 'axial gradiometers', planar: 'planar gradiometers', opm: 'OPMs' };
  const ARRAY_CACHE = {};
  MEG.getArray = type => ARRAY_CACHE[type] || (ARRAY_CACHE[type] = buildArray(type));

  /* Channel points expressed in another frame.  A pose is {R, c}: a head
     point p sits at R p + c in the device.  SQUID channels live in the
     device, OPM channels on the head. */
  MEG.pointsIn = function (ch, from, to, pose) {
    if (from === to || !pose) return ch.pts;
    if (from === 'device' && to === 'head') {
      return ch.pts.map(p => ({ r: MEG.matTVec(pose.R, v3.sub(p.r, pose.c)), n: MEG.matTVec(pose.R, p.n), w: p.w }));
    }
    return ch.pts.map(p => ({ r: v3.add(MEG.matVec(pose.R, p.r), pose.c), n: MEG.matVec(pose.R, p.n), w: p.w }));
  };

  /* Lead field of a current dipole at head position r0 for a list of
     channels: Float64Array(3 * nch), the reading per nA*m along x, y and
     z of the head frame.  Channel points must be in the head frame (the
     sphere's centre is the origin). */
  MEG.leadfieldMEG = function (chans, r0, out) {
    const n = chans.length;
    out = out || new Float64Array(3 * n);
    const bx = [0, 0, 0], by = [0, 0, 0], bz = [0, 0, 0];
    for (let c = 0; c < n; c++) {
      let lx = 0, ly = 0, lz = 0;
      const pts = chans[c].pts || chans[c];
      for (let k = 0; k < pts.length; k++) {
        const p = pts[k], P = sarvasPrep(p.r, r0);
        sarvasFromPrep(P, [1, 0, 0], bx); sarvasFromPrep(P, [0, 1, 0], by); sarvasFromPrep(P, [0, 0, 1], bz);
        const nx = p.n[0] * p.w, ny = p.n[1] * p.w, nz = p.n[2] * p.w;
        lx += nx * bx[0] + ny * bx[1] + nz * bx[2];
        ly += nx * by[0] + ny * by[1] + nz * by[2];
        lz += nx * bz[0] + ny * bz[1] + nz * bz[2];
      }
      out[3 * c] = lx; out[3 * c + 1] = ly; out[3 * c + 2] = lz;
    }
    return out;
  };
  // The reading of every channel for one current dipole (head frame).
  MEG.forwardMEG = function (chans, r0, q) {
    const L = MEG.leadfieldMEG(chans, r0);
    const v = new Float64Array(chans.length);
    for (let c = 0; c < chans.length; c++) v[c] = L[3 * c] * q[0] + L[3 * c + 1] * q[1] + L[3 * c + 2] * q[2];
    return v;
  };
  // The reading of every channel for one magnetic dipole (any frame, consistent with the points).
  MEG.forwardMag = function (chans, rm, m, out) {
    const n = chans.length, b = [0, 0, 0];
    out = out || new Float64Array(n);
    for (let c = 0; c < n; c++) {
      const pts = chans[c].pts || chans[c];
      let s = 0;
      for (let k = 0; k < pts.length; k++) { const p = pts[k]; MEG.magDipole(p.r, rm, m, b); s += p.w * (p.n[0] * b[0] + p.n[1] * b[1] + p.n[2] * b[2]); }
      out[c] = s;
    }
    return out;
  };
  // The reading of every channel for an arbitrary field function B(r) (fT).
  MEG.forwardField = function (chans, Bfun) {
    return Float64Array.from(chans, ch => { const pts = ch.pts || ch; let s = 0; pts.forEach(p => { const b = Bfun(p.r); s += p.w * (p.n[0] * b[0] + p.n[1] * b[1] + p.n[2] * b[2]); }); return s; });
  };

  /* ---------- map projection ----------
     Azimuthal equidistant from the vertex, nose up.  The map's rim is 135
     degrees from the vertex so the lowest occipital sensors fit inside. */
  const THETA_MAX = 135 * DEG;
  MEG.THETA_MAX = THETA_MAX;
  MEG.project = function (u) {
    const th = Math.acos(MEG.clamp(u[2] / (v3.norm(u) || 1), -1, 1));
    const az = Math.atan2(u[0], u[1]);
    const rho = th / THETA_MAX;
    return [rho * Math.sin(az), rho * Math.cos(az)];
  };
  MEG.unproject = function (mx, my) {
    const rho = Math.hypot(mx, my);
    const th = rho * THETA_MAX, az = Math.atan2(mx, my);
    return [Math.sin(th) * Math.sin(az), Math.sin(th) * Math.cos(az), Math.cos(th)];
  };
  MEG.topoGrid = function (res) {
    const idx = [], pts = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const mx = (i + 0.5) / res * 2 - 1, my = 1 - (j + 0.5) / res * 2;
        if (mx * mx + my * my <= 1.0001) { idx.push(j * res + i); pts.push(MEG.unproject(mx, my)); }
      }
    }
    return { res, idx: Int32Array.from(idx), pts };
  };

  /* ---------- spherical splines ----------
     Perrin et al. (1989), m = 4, for drawing maps between sensors. */
  const SPL = (function () {
    const M = 4, N = 60, T = 4001;
    const g = new Float64Array(T);
    const P = new Float64Array(N + 1), dP = new Float64Array(N + 1);
    for (let i = 0; i < T; i++) {
      const x = -1 + 2 * i / (T - 1);
      MEG.legendre(x, N, P, dP);
      let sg = 0;
      for (let n = 1; n <= N; n++) sg += (2 * n + 1) / Math.pow(n * (n + 1), M) * P[n];
      g[i] = sg / (4 * Math.PI);
    }
    return x => { const f = (MEG.clamp(x, -1, 1) + 1) * (T - 1) / 2, i = Math.min(T - 2, Math.floor(f)), t = f - i; return g[i] * (1 - t) + g[i + 1] * t; };
  })();
  MEG.makeSpline = function (U, lambda) {
    lambda = lambda === undefined ? 1e-5 : lambda;
    const n = U.length;
    const A = MEG.la.zeros(n + 1, n + 1);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] = SPL(v3.dot(U[i], U[j])) + (i === j ? lambda : 0);
      A[i][n] = 1; A[n][i] = 1;
    }
    const Minv = MEG.la.inverse(A);
    return {
      n, U,
      interpMatrix(points) {
        const W = new Float32Array(points.length * n);
        const gk = new Float64Array(n);
        for (let p = 0; p < points.length; p++) {
          const q = points[p];
          for (let k = 0; k < n; k++) gk[k] = SPL(q[0] * U[k][0] + q[1] * U[k][1] + q[2] * U[k][2]);
          for (let j = 0; j < n; j++) {
            let s = Minv[n][j];
            for (let k = 0; k < n; k++) s += gk[k] * Minv[k][j];
            W[p * n + j] = s;
          }
        }
        return W;
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
