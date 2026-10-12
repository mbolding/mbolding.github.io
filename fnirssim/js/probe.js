/* fNIRS simulator: probe geometry.

   Optodes are placed on a small flat patch of the head, in cm, with x to
   the patch's right and y toward the nose.  The patch is anchored at a
   10-20 position and wrapped onto a spherical head for drawing.  A modest
   array over one region is all the simulator needs, so the optics treat
   the patch as flat (the curvature over 3 cm changes little). */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;

  /* 10-20 positions as (polar angle from the vertex, azimuth from the
     nose toward the right ear), in degrees. */
  const TEN20 = {
    Fpz: [72, 0], Fp1: [72, -18], Fp2: [72, 18], AFz: [54, 0], AF3: [58, -25], AF4: [58, 25],
    Fz: [36, 0], F3: [46, -40], F4: [46, 40], F7: [72, -54], F8: [72, 54],
    FCz: [18, 0], FC3: [40, -64], FC4: [40, 64], Cz: [0, 0], C3: [36, -90], C4: [36, 90], T7: [72, -90], T8: [72, 90],
    CPz: [18, 180], CP3: [40, -116], CP4: [40, 116], Pz: [36, 180], P3: [46, -140], P4: [46, 140], P7: [72, -126], P8: [72, 126],
    POz: [54, 180], Oz: [72, 180], O1: [72, -162], O2: [72, 162]
  };
  NIRS.TEN20 = TEN20;
  const deg = Math.PI / 180;
  NIRS.ten20Unit = function (name) {
    const a = TEN20[name]; if (!a) return null;
    const th = a[0] * deg, ph = a[1] * deg;
    return [Math.sin(th) * Math.sin(ph), Math.sin(th) * Math.cos(ph), Math.cos(th)];
  };
  NIRS.resolve1020 = function (s) {
    const k = Object.keys(TEN20).find(n => n.toLowerCase() === String(s).toLowerCase());
    return k || null;
  };

  const norm = v => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  /* The local frame at an anchor: P outward, ey toward the nose along the
     surface, ex = ey x P, then rotated by `rot` degrees. */
  NIRS.patchFrame = function (anchor, rot) {
    const P = NIRS.ten20Unit(anchor) || [0, 0, 1];
    const y = [0, 1, 0];
    let ey = [y[0] - P[1] * P[0], y[1] - P[1] * P[1], y[2] - P[1] * P[2]];
    if (Math.hypot(...ey) < 1e-3) ey = [0, 0, 1];
    ey = norm(ey);
    let ex = norm(cross(ey, P));
    if (rot) {
      const c = Math.cos(rot * deg), s = Math.sin(rot * deg);
      const nx = ex.map((v, i) => c * v + s * ey[i]), ny = ey.map((v, i) => -s * ex[i] + c * v);
      ex = nx; ey = ny;
    }
    return { P, ex, ey };
  };
  // Patch coordinates (cm) to a unit vector on the head, by the exponential map.
  NIRS.patchToHead = function (frame, u, v, R) {
    const d = Math.hypot(u, v);
    if (d < 1e-9) return frame.P.slice();
    const a = d / R, c = Math.cos(a), s = Math.sin(a);
    return frame.P.map((p, i) => c * p + s * (u * frame.ex[i] + v * frame.ey[i]) / d);
  };
  // Unit vector to the 2D top view (nose up), radius 1 at the equator.
  NIRS.topView = function (U) {
    const th = Math.acos(NIRS.clamp(U[2], -1, 1)), ph = Math.atan2(U[0], U[1]);
    const r = th / (Math.PI / 2) * 0.92;
    return [r * Math.sin(ph), r * Math.cos(ph)];
  };

  /* Default arrays.  `motor`: four sources and four detectors on a 3 cm
     checkerboard (ten 3 cm channels) with an 8 mm short-separation
     detector beside each source.  `hd`: a high-density grid for
     tomography, sources and detectors interleaved at 1.5 cm. */
  NIRS.LAYOUTS = {
    motor() {
      const S = [[-4.5, 1.5], [1.5, 1.5], [-1.5, -1.5], [4.5, -1.5]];
      const D = [[-1.5, 1.5], [4.5, 1.5], [-4.5, -1.5], [1.5, -1.5]];
      return {
        sources: S.map((p, i) => ({ name: 'S' + (i + 1), x: p[0], y: p[1] })),
        detectors: D.map((p, i) => ({ name: 'D' + (i + 1), x: p[0], y: p[1] })),
        shorts: S.map((p, i) => ({ of: 'S' + (i + 1), dist: 0.8, angle: -45 }))
      };
    },
    // a forehead strip: three sources below four detectors, six 3.35 cm channels
    forehead() {
      return {
        sources: [-3, 0, 3].map((x, i) => ({ name: 'S' + (i + 1), x, y: -1.5 })),
        detectors: [-4.5, -1.5, 1.5, 4.5].map((x, i) => ({ name: 'D' + (i + 1), x, y: 1.5 })),
        shorts: [0, 1, 2].map(i => ({ of: 'S' + (i + 1), dist: 0.8, angle: -90 }))
      };
    },
    hd(n, pitch) {
      n = n || 6; pitch = pitch || 1.5;
      const sources = [], detectors = [];
      const half = (n - 1) / 2;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = (i - half) * pitch, y = (j - half) * pitch;
        if ((i + j) % 2 === 0) sources.push({ name: 'S' + (sources.length + 1), x, y });
        else detectors.push({ name: 'D' + (detectors.length + 1), x, y });
      }
      return { sources, detectors, shorts: [] };
    }
  };
  NIRS.LAYOUT_NAMES = ['motor', 'forehead'];

  /* Expand a probe description into optodes and channels.
     probe: { sources, detectors, shorts: [{of, dist, angle}], maxSep, minSep,
              explicit: [[S, D], ...] | null }.
     Short detectors are named SS1, SS2... and are channels only with
     their own source. */
  NIRS.buildProbe = function (probe) {
    const sources = probe.sources.map(s => Object.assign({ kind: 'source' }, s));
    const detectors = probe.detectors.map(d => Object.assign({ kind: 'detector', short: false }, d));
    (probe.shorts || []).forEach((sh, i) => {
      const s = sources.find(x => x.name === sh.of);
      if (!s) return;
      const a = (sh.angle === undefined ? -45 : sh.angle) * deg;
      detectors.push({ kind: 'detector', short: true, name: sh.name || 'SS' + (i + 1), of: s.name,
        x: s.x + sh.dist * Math.cos(a), y: s.y + sh.dist * Math.sin(a) });
    });
    const channels = [];
    const maxSep = probe.maxSep || 3.5, minSep = probe.minSep === undefined ? 1.5 : probe.minSep;
    sources.forEach((s, si) => detectors.forEach((d, di) => {
      const rho = Math.hypot(d.x - s.x, d.y - s.y);
      let use;
      if (d.short) use = d.of === s.name;
      else if (probe.explicit) use = probe.explicit.some(p => p[0] === s.name && p[1] === d.name);
      else use = rho <= maxSep + 1e-9 && rho >= minSep - 1e-9;
      if (!use) return;
      channels.push({ src: si, det: di, s: s.name, d: d.name, rho, short: !!d.short || rho < 1.5,
        mid: [(s.x + d.x) / 2, (s.y + d.y) / 2], label: s.name + '-' + d.name });
    }));
    // each long channel's nearest short channel, by distance between midpoints
    const shorts = channels.map((c, i) => i).filter(i => channels[i].short);
    channels.forEach(c => {
      if (c.short || !shorts.length) { c.nearestShort = -1; return; }
      let best = -1, bd = Infinity;
      shorts.forEach(i => {
        const sc = channels[i];
        // the scalp a long channel samples is under its two optodes, so measure to the nearer one
        const sx = sources[c.src], dx = detectors[c.det];
        const dd = Math.min(Math.hypot(sc.mid[0] - sx.x, sc.mid[1] - sx.y), Math.hypot(sc.mid[0] - dx.x, sc.mid[1] - dx.y));
        if (dd < bd) { bd = dd; best = i; }
      });
      c.nearestShort = best; c.shortDist = bd;
    });
    return { sources, detectors, channels };
  };
})(typeof window !== 'undefined' ? window : globalThis);
