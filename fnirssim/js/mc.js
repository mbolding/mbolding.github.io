/* fNIRS simulator: photons one at a time.

   A Monte Carlo random walk in the same layered half-space the diffusion
   solver uses, run a few thousand photons per animation frame so the
   reader can watch light scatter.  It is a teaching picture, not a
   transport code: scattering is isotropic with the reduced scattering
   coefficient (the similarity relation), absorption is applied as a
   weight along the path (exp(-mua * length) for every layer crossed),
   and the surface reflects by Fresnel's law for n = 1.4.

   Photons that leave the surface within the detector's ring around the
   source are "detected"; by the cylindrical symmetry of a layered slab
   each is rotated so it exits at the detector.  Their paths, weighted,
   pile up into the banana. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;
  const N_IN = 1.4;

  function fresnel(cosi) {
    // reflectance from inside tissue (n = 1.4) toward air (n = 1)
    const n1 = N_IN, n2 = 1;
    const sint = n1 / n2 * Math.sqrt(Math.max(0, 1 - cosi * cosi));
    if (sint >= 1) return 1;
    const cost = Math.sqrt(1 - sint * sint);
    const rs = (n1 * cosi - n2 * cost) / (n1 * cosi + n2 * cost), rp = (n1 * cost - n2 * cosi) / (n1 * cost + n2 * cosi);
    return (rs * rs + rp * rp) / 2;
  }

  class MC {
    /* layers: optical layers [{key, z0, z1, mua, musp}]; opts: { rho, aperture,
       grid: {x0, x1, nx, zmax, nz}, seed, keep } */
    constructor(layers, opts) {
      this.layers = layers;
      this.o = Object.assign({ rho: 3, aperture: 0.2, keep: 120, seed: 7 }, opts || {});
      const g = this.o.grid || { x0: -1.5, x1: this.o.rho + 1.5, nx: 120, zmax: 3, nz: 72 };
      this.grid = g;
      this.r = NIRS.rng(this.o.seed);
      this.reset();
    }
    reset() {
      const g = this.grid;
      this.density = new Float64Array(g.nx * g.nz);
      this.detected = [];       // recent detected paths for drawing
      this.cloud = [];          // recent undetected paths, a few
      this.launched = 0; this.nDet = 0; this.wDet = 0; this.wL = 0; this.wLk = this.layers.map(() => 0);
      this.wDepth = 0; this.nLost = 0; this.nShort = 0; this.shortPaths = [];
      this.tof = new Float64Array(48);  // 0..8 ns
      this.tofMax = 8;
      this.maxDepthHist = new Float64Array(40); // 0..4 cm
    }
    layerAt(z) {
      const L = this.layers;
      for (let k = 0; k < L.length; k++) if (z < L[k].z1) return k;
      return L.length - 1;
    }
    /* Run one photon.  Returns null, or a detected record.  The path is
       written into a reusable buffer and copied only if it is kept. */
    photon() {
      const r = this.r, L = this.layers;
      if (!this.buf) this.buf = new Float64Array(3 * 6002);
      const buf = this.buf, lim = (this.o.rho + 3) * (this.o.rho + 3);
      let np = 0;
      let x = 0, y = 0, z = 0, ux = 0, uy = 0, uz = 1;
      let w = 1, k = 0, steps = 0, total = 0, zmaxReached = 0;
      const lk = this.lk || (this.lk = new Float64Array(L.length));
      lk.fill(0);
      buf[0] = 0; buf[1] = 0; buf[2] = 0; np = 1;
      while (steps++ < 6000) {
        let s = -Math.log(1 - r.next()) / L[k].musp;
        while (true) {
          let zb = Infinity;
          if (uz > 0 && isFinite(L[k].z1)) zb = (L[k].z1 - z) / uz;
          else if (uz < 0) zb = (L[k].z0 - z) / uz;
          if (s <= zb) break;
          x += ux * zb; y += uy * zb; z += uz * zb;
          lk[k] += zb; total += zb; w *= Math.exp(-L[k].mua * zb);
          s -= zb;
          if (uz < 0 && k === 0) {
            if (r.next() < fresnel(-uz)) { uz = -uz; z = 0; continue; }
            buf[3 * np] = x; buf[3 * np + 1] = y; buf[3 * np + 2] = 0; np++;
            return this.exit(x, y, w, total, lk, zmaxReached, np);
          }
          const nk = uz > 0 ? k + 1 : k - 1;
          s *= L[k].musp / L[nk].musp;
          k = nk;
        }
        x += ux * s; y += uy * s; z += uz * s;
        lk[k] += s; total += s; w *= Math.exp(-L[k].mua * s);
        if (z > zmaxReached) zmaxReached = z;
        buf[3 * np] = x; buf[3 * np + 1] = y; buf[3 * np + 2] = z; np++;
        const cz = 2 * r.next() - 1, ph = 2 * Math.PI * r.next(), sz = Math.sqrt(1 - cz * cz);
        ux = sz * Math.cos(ph); uy = sz * Math.sin(ph); uz = cz;
        if (w < 1e-4) { if (r.next() < 0.1) w *= 10; else return this.lost(np); }
        if (x * x + y * y > lim || z > 4) return this.lost(np);
      }
      return this.lost(np);
    }
    lost(np) {
      // keep the odd undetected path, projected onto the x-z plane, for the cloud
      if (++this.nLost % 40 === 0 && np > 3) {
        const p = new Float32Array(2 * np);
        for (let i = 0; i < np; i++) { p[2 * i] = this.buf[3 * i]; p[2 * i + 1] = this.buf[3 * i + 2]; }
        this.cloud.push({ pts: p });
        if (this.cloud.length > 30) this.cloud.shift();
      }
      return null;
    }
    exit(x, y, w, total, lk, zmaxReached, np) {
      const rr = Math.hypot(x, y), rho = this.o.rho, ap = this.o.aperture;
      if (this.o.short && Math.abs(rr - this.o.short) <= ap * 0.6) {
        // a second detector on the other side of the source: rotate the exit to -x
        this.nShort++;
        const c = x / rr, s = y / rr, buf = this.buf, out = new Float32Array(2 * np);
        for (let i = 0; i < np; i++) { out[2 * i] = -(buf[3 * i] * c + buf[3 * i + 1] * s); out[2 * i + 1] = buf[3 * i + 2]; }
        this.shortPaths.push({ pts: out, w });
        if (this.shortPaths.length > 40) this.shortPaths.shift();
        return null;
      }
      if (Math.abs(rr - rho) > ap) return this.lost(np);
      this.nDet++; this.wDet += w; this.wL += w * total;
      for (let i = 0; i < lk.length; i++) this.wLk[i] += w * lk[i];
      const t = total / NIRS.C_TISSUE, bi = Math.floor(t / this.tofMax * this.tof.length);
      if (bi < this.tof.length) this.tof[bi] += w;
      const di = Math.floor(zmaxReached / 4 * this.maxDepthHist.length);
      if (di < this.maxDepthHist.length) this.maxDepthHist[di] += w;
      this.wDepth += w * zmaxReached;
      // rotate about z so the exit is on the +x axis, at the detector
      const c = x / rr, s = y / rr, buf = this.buf, out = new Float32Array(2 * np);
      for (let i = 0; i < np; i++) { out[2 * i] = buf[3 * i] * c + buf[3 * i + 1] * s; out[2 * i + 1] = buf[3 * i + 2]; }
      this.accumulate(out, w);
      const rec = { pts: out, w, L: total, tof: t, depth: zmaxReached };
      this.detected.push(rec);
      if (this.detected.length > this.o.keep) this.detected.shift();
      return rec;
    }
    accumulate(p, w) {
      const g = this.grid, dx = (g.x1 - g.x0) / g.nx, dz = g.zmax / g.nz;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const len = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(len / Math.min(dx, dz)));
        for (let q = 0; q < m; q++) {
          const t = (q + 0.5) / m, X = ax + t * (bx - ax), Z = az + t * (bz - az);
          const ix = Math.floor((X - g.x0) / dx), iz = Math.floor(Z / dz);
          if (ix < 0 || ix >= g.nx || iz < 0 || iz >= g.nz) continue;
          this.density[iz * g.nx + ix] += w * len / m;
        }
      }
    }
    /* Run photons for about `ms` milliseconds; every `every`-th photon has
       its path recorded for the picture. */
    run(ms) {
      const now = () => (typeof performance !== 'undefined' ? performance : Date).now();
      const t0 = now();
      let k = 0;
      do { for (let i = 0; i < 100; i++, k++) { this.launched++; this.photon(); } } while (now() - t0 < ms);
      return k;
    }
    stats() {
      const w = this.wDet || 1;
      return {
        launched: this.launched, detected: this.nDet, weight: this.wDet,
        meanL: this.wL / w, dpf: this.wL / w / this.o.rho, layerL: this.wLk.map(v => v / w), meanDepth: this.wDepth / w,
        perPhoton: this.wDet / Math.max(1, this.launched)
      };
    }
  }
  NIRS.MC = MC;
})(typeof window !== 'undefined' ? window : globalThis);
