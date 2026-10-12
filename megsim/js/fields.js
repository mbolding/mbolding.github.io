/* MEG simulator: the fields of one dipole in two cross-sections.

   The electric picture lies in the plane that contains the dipole and the
   radius through it.  There the potential is computed exactly for the
   four-shell head from the same series the scalp maps use, extended inside
   the head, and the volume currents J = -sigma grad V are traced as
   streamlines: they leave the dipole's head, spread through the brain and
   the CSF, cross the skull almost radially and return to its tail.

   The magnetic picture lies in the plane at right angles to it, across the
   dipole, which is where the field circles the current.  Outside the head
   the total field is the Sarvas formula, exact for any spherically layered
   head.  Inside it is the field of the primary current (Biot-Savart) plus
   that of the volume currents, computed from the Geselowitz surface
   integral for a uniform sphere with the singular part subtracted; within
   a few millimetres of the scalp it is blended to the exact surface value.
   The two meet continuously at the scalp, which the tests check. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3;

  /* The two planes through a dipole at r0 with moment q.  Both contain the
     outward radius e2.  In the electric plane e1 is the direction of the
     tangential part of q; the magnetic plane is the one perpendicular to
     that direction, with e1 = e2 x t so that the current flows toward the
     viewer.  A purely radial dipole has no tangential part; dirHint (a
     tangent direction) keeps the planes defined. */
  function planes(r0, q, dirHint) {
    const e2 = v3.norm(r0) > 1e-6 ? v3.unit(r0) : [0, 0, 1];
    let t = v3.sub(q, v3.scale(e2, v3.dot(q, e2)));
    if (v3.norm(t) < 1e-6 * (v3.norm(q) || 1)) t = dirHint ? v3.sub(dirHint, v3.scale(e2, v3.dot(dirHint, e2))) : MEG.tangentFrame(r0).t1;
    t = v3.unit(t);
    return {
      e2, t,
      electric: { e1: t, e2, normal: v3.cross(t, e2) },
      magnetic: { e1: v3.cross(e2, t), e2, normal: t }
    };
  }

  /* ---------- the potential inside the four-shell head ----------
     In shell j the potential is K sum_n rho0^(n-1) ang_n(u) (A_j rho^n + B_j rho^-(n+1))
     with ang_n(u) = n P_n(x) (q.p) + P'_n(x) (q.u - x q.p), the shell
     coefficients normalised so that B_brain = 1.  In the brain the B part
     is the dipole's own field, which is summed in closed form instead. */
  const NMAXV = 300;
  const modelCache = new Map();
  function interiorModel(opts) {
    const key = JSON.stringify(opts || {});
    if (!modelCache.has(key)) {
      const sigma = ((opts && opts.sigma) || MEG.HEAD.sigma).slice();
      const homogeneous = !!(opts && opts.homogeneous);
      const radii = homogeneous ? [MEG.HEAD.R] : MEG.HEAD.radii.slice();
      const sig = homogeneous ? [sigma[0]] : sigma;
      const tr = MEG.transfer(radii, sig, NMAXV);
      modelCache.set(key, { radii, sigma: sig, A: tr.A, B: tr.B, rn: tr.rn, R: MEG.HEAD.R, K: 1e-3 / (4 * Math.PI * sig[0] * Math.pow(MEG.HEAD.R / 100, 2)) });
    }
    return modelCache.get(key);
  }
  function shellOf(m, r) {
    for (let j = 0; j < m.radii.length; j++) if (r <= m.radii[j] + 1e-9) return j;
    return -1;
  }
  // Potential (uV) at point x (cm) for a dipole q (nA*m) at r0.  NaN outside the head.
  function potential(m, r0, q, x) {
    const r = v3.norm(x);
    const j = shellOf(m, r);
    if (j < 0) return NaN;
    const R = m.R, rho = r / R, rho0 = v3.norm(r0) / R;
    const p = rho0 > 1e-9 ? v3.unit(r0) : [0, 0, 1];
    const u = r > 1e-9 ? v3.scale(x, 1 / r) : [0, 0, 1];
    const xc = MEG.clamp(v3.dot(u, p), -1, 1), qp = v3.dot(q, p), qu = v3.dot(q, u), qn = v3.norm(q) || 1;
    let V = 0;
    if (j === 0) {
      const d = v3.sub(x, r0), dd = v3.norm(d);
      if (dd < 1e-6) return NaN;
      // 1e-5 / (4 pi sigma) volts for q in nA*m and d in cm, times 1e6 for microvolts
      V = 10 / (4 * Math.PI * m.sigma[0]) * v3.dot(q, d) / (dd * dd * dd);
    }
    const A = m.A[j], B = m.B[j];
    let Pm = 1, P = xc, dPm = 0, dP = 1, pw0 = 1, rn = rho, rm = 1 / (rho * rho), S = 0, big = 0;
    for (let n = 1; n <= NMAXV; n++) {
      if (n > 1) {
        const Pn = ((2 * n - 1) * xc * P - (n - 1) * Pm) / n;
        const dPn = dPm + (2 * n - 1) * P;
        Pm = P; P = Pn; dPm = dP; dP = dPn;
        pw0 *= rho0; rn *= rho; rm /= rho;
      }
      const ang = n * P * qp + dP * (qu - xc * qp);
      const radial = j === 0 ? A[n] * rn : A[n] * rn + B[n] * rm;
      const term = pw0 * ang * radial;
      S += term;
      const a = Math.abs(term);
      if (a > big) big = a;
      if (n > 8 && a < 1e-10 * big && Math.abs(pw0 * radial) * n * n * qn < 1e-10 * big) break;
    }
    return V + m.K * S;
  }

  /* The potential and its gradient together, in one pass over the series
     (uV and uV/cm).  With c_n(u) = rho0^(n-1) ang_n(u) and the radial factor
     f_n(rho):  grad V = K sum [ c_n f_n'(rho)/R u + f_n(rho)/r (I - u u^T) d ang_n/du ],
     where d ang_n/du = n P'_n qp p + P''_n (q.u - x qp) p + P'_n (q - qp p),
     and P''_{n+1} = P''_{n-1} + (2n+1) P'_n keeps everything finite at the poles. */
  function potentialGrad(m, r0, q, x) {
    const r = Math.sqrt(x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
    const j = shellOf(m, r);
    if (j < 0 || r < 1e-9) return null;
    const R = m.R, rho = r / R, r0n = Math.sqrt(r0[0] * r0[0] + r0[1] * r0[1] + r0[2] * r0[2]), rho0 = r0n / R;
    const p = rho0 > 1e-9 ? [r0[0] / r0n, r0[1] / r0n, r0[2] / r0n] : [0, 0, 1];
    const u = [x[0] / r, x[1] / r, x[2] / r];
    const xc = MEG.clamp(u[0] * p[0] + u[1] * p[1] + u[2] * p[2], -1, 1);
    const qp = q[0] * p[0] + q[1] * p[1] + q[2] * p[2], qu = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
    const qn = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]) || 1;
    let V = 0, gx = 0, gy = 0, gz = 0;
    if (j === 0) {
      const dx = x[0] - r0[0], dy = x[1] - r0[1], dz = x[2] - r0[2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-12) return null;
      const d = Math.sqrt(d2), C = 10 / (4 * Math.PI * m.sigma[0]), qd = q[0] * dx + q[1] * dy + q[2] * dz;
      V = C * qd / (d2 * d);
      const k1 = C / (d2 * d), k2 = 3 * C * qd / (d2 * d2 * d);
      gx = k1 * q[0] - k2 * dx; gy = k1 * q[1] - k2 * dy; gz = k1 * q[2] - k2 * dz;
    }
    const A = m.A[j], B = m.B[j];
    // a = q - qp p, the part of q across the dipole's radius
    const ax = q[0] - qp * p[0], ay = q[1] - qp * p[1], az = q[2] - qp * p[2];
    let Pm = 1, P = xc, dPm = 0, dP = 1, ddPm = 0, ddP = 0;
    let pw0 = 1, rn = rho, rm = 1 / (rho * rho);
    let S = 0, Sr = 0, Sp = 0, Sa = 0, big = 0;      // value, radial, and the p and a coefficients of d ang/du
    for (let n = 1; n <= NMAXV; n++) {
      if (n > 1) {
        const Pn = ((2 * n - 1) * xc * P - (n - 1) * Pm) / n;
        const dPn = dPm + (2 * n - 1) * P;
        const ddPn = ddPm + (2 * n - 1) * dP;
        Pm = P; P = Pn; dPm = dP; dP = dPn; ddPm = ddP; ddP = ddPn;
        pw0 *= rho0; rn *= rho; rm /= rho;
      }
      const ang = n * P * qp + dP * (qu - xc * qp);
      const f = j === 0 ? A[n] * rn : A[n] * rn + B[n] * rm;
      const fd = j === 0 ? n * A[n] * rn / rho : (n * A[n] * rn - (n + 1) * B[n] * rm) / rho;
      S += pw0 * ang * f;
      Sr += pw0 * ang * fd;
      const w = pw0 * f;
      Sp += w * (n * dP * qp + ddP * (qu - xc * qp));
      Sa += w * dP;
      const tm = Math.abs(pw0 * ang * fd) + Math.abs(pw0 * ang * f);
      if (tm > big) big = tm;
      if (n > 8 && tm < 1e-10 * big && (Math.abs(pw0 * f) + Math.abs(pw0 * fd)) * n * n * qn < 1e-10 * big) break;
    }
    // d ang/du summed: Sp p + Sa a; take its tangential part
    let tx = Sp * p[0] + Sa * ax, ty = Sp * p[1] + Sa * ay, tz = Sp * p[2] + Sa * az;
    const tu = tx * u[0] + ty * u[1] + tz * u[2];
    tx -= tu * u[0]; ty -= tu * u[1]; tz -= tu * u[2];
    const K = m.K;
    V += K * S;
    const kr = K * Sr / R, kt = K / r;
    gx += kr * u[0] + kt * tx; gy += kr * u[1] + kt * ty; gz += kr * u[2] + kt * tz;
    return { V, g: [gx, gy, gz], shell: j };
  }

  /* Volume current density J = -sigma grad V at x, in the plane spanned by
     e1 and e2 (S/m times uV/cm). */
  function currentInPlane(m, r0, q, x, e1, e2) {
    const pg = potentialGrad(m, r0, q, x);
    if (!pg) return null;
    const s = m.sigma[pg.shell], g = pg.g;
    return [-s * (g[0] * e1[0] + g[1] * e1[1] + g[2] * e1[2]), -s * (g[0] * e2[0] + g[1] * e2[1] + g[2] * e2[2])];
  }

  /* ---------- the magnetic field inside a uniform sphere ----------
     B = B0 + Bv.  The volume-current part, by Geselowitz for a sphere of
     conductivity sigma with the potential V on its surface:
        Bv(r) = -(mu0/4pi) sigma oint (V(r') - V(r*)) n' x (r - r') / |r - r'|^3 dS'
     where subtracting V at the nearest surface point r* changes nothing
     (the integral of n' x grad'(1/|r - r'|) over a closed surface is zero)
     but removes the near-singularity for points close to the scalp.  With
     V in uV, lengths in cm and sigma in S/m the factor is -100 sigma fT
     (1e-7 from mu0/4pi, 1e-6 for microvolts, 1e15 for femtotesla). */
  function surfaceQuadrature(N) {
    const R = MEG.HEAD.R, U = MEG.fibonacciSphere(N);
    const ux = Float64Array.from(U, u => u[0]), uy = Float64Array.from(U, u => u[1]), uz = Float64Array.from(U, u => u[2]);
    return { U, ux, uy, uz, R, dS: 4 * Math.PI * R * R / N, N };
  }
  const QUAD = { coarse: null, fine: null };
  function quad(level) {
    if (!QUAD[level]) QUAD[level] = surfaceQuadrature(level === 'fine' ? 4000 : 1600);
    return QUAD[level];
  }

  function makeMagnetic(r0, q, opts) {
    opts = opts || {};
    const Q = quad(opts.fine ? 'fine' : 'coarse');
    const hm = MEG.headModel({ homogeneous: true });
    const Vs = MEG.forwardEEG(hm, r0, q, Q.U);           // potential on the surface, uV
    const sig = hm.sigma[0], R = MEG.HEAD.R;
    const delta = opts.blend || 0.6;
    function surfaceV(u) { return MEG.forwardEEG(hm, r0, q, [u])[0]; }
    function BvNumeric(r) {
      const rr = v3.norm(r);
      const us = rr > 1e-9 ? v3.scale(r, 1 / rr) : [0, 0, 1];
      const Vstar = surfaceV(us);
      let bx = 0, by = 0, bz = 0;
      const ux = Q.ux, uy = Q.uy, uz = Q.uz, Rq = Q.R, x0 = r[0], y0 = r[1], z0 = r[2];
      for (let k = 0; k < Q.N; k++) {
        const nx = ux[k], ny = uy[k], nz = uz[k];
        const dx = x0 - Rq * nx, dy = y0 - Rq * ny, dz = z0 - Rq * nz;
        const d2 = dx * dx + dy * dy + dz * dz;
        const f = (Vs[k] - Vstar) / (d2 * Math.sqrt(d2));
        bx += f * (ny * dz - nz * dy);
        by += f * (nz * dx - nx * dz);
        bz += f * (nx * dy - ny * dx);
      }
      const k = -100 * sig * Q.dS;
      return [k * bx, k * by, k * bz];
    }
    function BvSurface(u) {
      const rs = v3.scale(u, R);
      const B = MEG.sarvas(rs, r0, q), B0 = MEG.biotSavart(rs, r0, q);
      return v3.sub(B, B0);
    }
    // The smooth volume-current part anywhere.
    function Bv(r) {
      const rr = v3.norm(r);
      if (rr >= R) return v3.sub(MEG.sarvas(r, r0, q), MEG.biotSavart(r, r0, q));
      if (rr <= R - delta) return BvNumeric(r);
      const u = v3.scale(r, 1 / rr), t = (rr - (R - delta)) / delta;
      return v3.lerp(BvNumeric(v3.scale(u, R - delta)), BvSurface(u), t);
    }
    // Total field anywhere (fT).
    function B(r) {
      const rr = v3.norm(r);
      if (rr >= R) return MEG.sarvas(r, r0, q);
      return v3.add(MEG.biotSavart(r, r0, q), Bv(r));
    }
    return { B, Bv, BvNumeric, r0, q };
  }

  /* A grid of the smooth part over a plane, for fast drawing.  The plane is
     origin + a e1 + b e2 for a, b in [-L, L]; points outside the head use
     the closed form directly, so the grid only stores the inside. */
  function magneticGrid(mag, plane, L, res) {
    const R = MEG.HEAD.R;
    const n = res, h = 2 * L / (n - 1);
    const gx = new Float32Array(n * n), gy = new Float32Array(n * n), gz = new Float32Array(n * n);
    const inside = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = -L + i * h, b = -L + j * h;
      if (a * a + b * b > (R + h) * (R + h)) continue;
      const p = v3.add(v3.scale(plane.e1, a), v3.scale(plane.e2, b));
      const v = mag.Bv(p);
      const k = j * n + i;
      gx[k] = v[0]; gy[k] = v[1]; gz[k] = v[2]; inside[k] = 1;
    }
    function BvAt(a, b) {
      const fi = (a + L) / h, fj = (b + L) / h;
      const i = Math.floor(fi), j = Math.floor(fj);
      if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return null;
      const s = fi - i, t = fj - j, k = j * n + i;
      if (!(inside[k] && inside[k + 1] && inside[k + n] && inside[k + n + 1])) return null;
      const w00 = (1 - s) * (1 - t), w10 = s * (1 - t), w01 = (1 - s) * t, w11 = s * t;
      return [gx[k] * w00 + gx[k + 1] * w10 + gx[k + n] * w01 + gx[k + n + 1] * w11,
        gy[k] * w00 + gy[k + 1] * w10 + gy[k + n] * w01 + gy[k + n + 1] * w11,
        gz[k] * w00 + gz[k + 1] * w10 + gz[k + n] * w01 + gz[k + n + 1] * w11];
    }
    // Total field at plane coordinates (a, b), as a 3-vector.
    function fieldAt(a, b) {
      const p = v3.add(v3.scale(plane.e1, a), v3.scale(plane.e2, b));
      const rr = v3.norm(p);
      if (rr >= R) return MEG.sarvas(p, mag.r0, mag.q);
      const g = BvAt(a, b);
      return v3.add(MEG.biotSavart(p, mag.r0, mag.q), g || mag.Bv(p));
    }
    return { fieldAt, L, n, h };
  }

  /* ---------- field lines ----------
     Lines of the in-plane field, traced with fourth-order Runge-Kutta on
     the unit direction field with a step that grows with distance from the
     dipole.  Magnetic lines are seeded on the radius above the dipole and
     followed until they close around it; current lines start just in front
     of the dipole and end at its tail. */
  function rk4(dir, p, ds) {
    const k1 = dir(p); if (!k1) return null;
    const k2 = dir([p[0] + ds / 2 * k1[0], p[1] + ds / 2 * k1[1]]); if (!k2) return null;
    const k3 = dir([p[0] + ds / 2 * k2[0], p[1] + ds / 2 * k2[1]]); if (!k3) return null;
    const k4 = dir([p[0] + ds * k3[0], p[1] + ds * k3[1]]); if (!k4) return null;
    return [p[0] + ds / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]), p[1] + ds / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])];
  }

  function magneticLines(grid, plane, dip, opts) {
    opts = opts || {};
    const L = grid.L, nLines = opts.lines || 18;
    const inPlane = (a, b) => { const B = grid.fieldAt(a, b); return [v3.dot(B, plane.e1), v3.dot(B, plane.e2)]; };
    // Seeds on the ray above the dipole, spaced evenly in log distance so
    // the tight loops around the current and the wide ones that leave the
    // head both appear.  (In a slice of a 3D field, line density cannot be
    // made exactly proportional to strength anyway; the colour does that.)
    const r0a = 0, r0b = dip[1];
    const s0 = opts.near || 0.3, s1 = Math.max(s0 * 2, L * 0.97 - r0b);
    const seeds = [];
    const nUp = opts.below ? Math.ceil(nLines * 0.6) : nLines, nDown = nLines - nUp;
    for (let i = 0; i < nUp; i++) seeds.push([r0a, r0b + s0 * Math.pow(s1 / s0, (i + 0.5) / nUp)]);
    // optionally also below the dipole, toward the centre of the head
    const s2 = Math.max(s0 * 2, L * 0.97 + r0b);
    for (let i = 0; i < nDown; i++) seeds.push([r0a, r0b - s0 * Math.pow(s2 / s0, (i + 0.5) / nDown)]);
    const lines = [];
    seeds.forEach(seed => {
      const dir = p => {
        const v = inPlane(p[0], p[1]); const m = Math.hypot(v[0], v[1]);
        return m > 1e-12 ? [v[0] / m, v[1] / m] : null;
      };
      const pts = [seed.slice()];
      let p = seed.slice(), ang0 = Math.atan2(p[1] - dip[1], p[0] - dip[0]), wind = 0, prevAng = ang0;
      for (let it = 0; it < 3000; it++) {
        const dist = Math.hypot(p[0] - dip[0], p[1] - dip[1]);
        const ds = MEG.clamp(0.06 * dist, 0.02, 0.6);
        const q = rk4(dir, p, ds);
        if (!q || Math.abs(q[0]) > L || Math.abs(q[1]) > L) break;
        const ang = Math.atan2(q[1] - dip[1], q[0] - dip[0]);
        let d = ang - prevAng; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
        wind += d; prevAng = ang;
        p = q; pts.push(q);
        if (Math.abs(wind) > 2 * Math.PI - 1e-3) { pts.push(seed.slice()); break; }
      }
      lines.push(pts);
    });
    return lines;
  }

  /* Volume-current streamlines in the electric plane, from just in front
     of the dipole's head (the source of the return current) until they
     come back to its tail. */
  function currentLines(m, r0, q, plane, opts) {
    opts = opts || {};
    const nLines = opts.lines || 16;
    const e1 = plane.e1, e2 = plane.e2;
    const qa = v3.dot(q, e1), qb = v3.dot(q, e2), qn = Math.hypot(qa, qb) || 1;
    const ua = qa / qn, ub = qb / qn;               // dipole direction in the plane
    const ca = v3.dot(r0, e1), cb = v3.dot(r0, e2);
    const rs = opts.seedR || 0.35;
    const toWorld = (a, b) => v3.add(v3.scale(e1, a), v3.scale(e2, b));
    const dir = p => {
      const J = currentInPlane(m, r0, q, toWorld(p[0], p[1]), e1, e2);
      if (!J) return null;
      const n = Math.hypot(J[0], J[1]);
      return n > 0 ? [J[0] / n, J[1] / n] : null;
    };
    const lines = [];
    // A free dipole's line leaving at angle alpha from its axis reaches
    // rs / sin^2(alpha) at its widest.  Choosing alpha for loop sizes spaced
    // evenly in log size, on both sides, gives a nested family from a few
    // millimetres to the size of the head.
    const half = Math.max(1, Math.floor(nLines / 2));
    const cMin = opts.minLoop || 0.9, cMax = opts.maxLoop || 14;
    const alphas = [];
    for (let i = 0; i < half; i++) {
      const C = cMin * Math.pow(cMax / cMin, i / Math.max(1, half - 1));
      const a = Math.asin(Math.sqrt(MEG.clamp(rs / C, 0, 0.999)));
      alphas.push(a, -a);
    }
    alphas.forEach(alpha => {
      const ca2 = Math.cos(alpha), sa2 = Math.sin(alpha);
      const da = ua * ca2 - ub * sa2, db = ub * ca2 + ua * sa2;
      let p = [ca + rs * da, cb + rs * db];
      const pts = [p];
      for (let it = 0; it < 1600; it++) {
        const dist = Math.hypot(p[0] - ca, p[1] - cb);
        const ds = MEG.clamp(0.08 * dist, 0.03, 0.35);
        const qn2 = rk4(dir, p, ds);
        if (!qn2) break;
        p = qn2; pts.push(p);
        const back = (p[0] - ca) * ua + (p[1] - cb) * ub;
        if (it > 5 && Math.hypot(p[0] - ca, p[1] - cb) < rs * 1.05 && back < 0) break;
      }
      lines.push(pts);
    });
    return lines;
  }

  MEG.fields = { planes, interiorModel, potential, potentialGrad, currentInPlane, makeMagnetic, magneticGrid, magneticLines, currentLines, shellOf };
})(typeof window !== 'undefined' ? window : globalThis);
