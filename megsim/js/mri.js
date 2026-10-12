/* MEG simulator: the structural MRI and coregistration.

   MEG localizes sources in head coordinates, defined by three landmarks
   digitized on the participant: the nasion and the two preauricular
   points.  To show a source on the anatomy, the MRI must be put in the
   same frame.  The landmarks are found again on the MRI, a rigid transform
   lines the two sets up, and the hundred or so head-shape points traced
   with the digitizer pen are then fitted to the MRI's scalp surface by
   iterative closest points (ICP).  Every millimetre of error in that
   transform moves every source by the same amount on the anatomy.

   The MRI here is synthetic, built from signed distances around the head
   model's sphere: a folded cortex with its white matter, ventricles, deep
   nuclei, brainstem and cerebellum, the skull and its base, the face, eyes,
   sinuses, mouth and neck, sampled as a T1-weighted image.  It lives in
   scanner coordinates, a few centimetres and degrees away from head
   coordinates. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, la = MEG.la;
  const DEG = Math.PI / 180;

  /* ---------- the true transform from head to MRI coordinates ---------- */
  const TRUE = { R: MEG.rotXYZ(3, -1.5, 2.5), t: [1.3, -2.6, 4.1] };
  const apply = (T, p) => v3.add(MEG.matVec(T.R, p), T.t);
  const invert = T => { const Rt = MEG.mat3T(T.R); return { R: Rt, t: v3.scale(MEG.matVec(Rt, T.t), -1) }; };
  const TRUE_INV = invert(TRUE);

  /* ---------- a small geometry kit: signed distances, negative inside ---------- */
  const R = MEG.HEAD.R;
  const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
  const sig = t => 1 / (1 + Math.exp(-t));
  // An ellipsoid (a close approximation of the true distance).
  function sdE(p, c, a) {
    const x = (p[0] - c[0]) / a[0], y = (p[1] - c[1]) / a[1], z = (p[2] - c[2]) / a[2];
    const k0 = Math.sqrt(x * x + y * y + z * z), k1 = Math.sqrt((x / a[0]) ** 2 + (y / a[1]) ** 2 + (z / a[2]) ** 2);
    return k1 > 1e-12 ? k0 * (k0 - 1) / k1 : -Math.min(a[0], a[1], a[2]);
  }
  // A capsule from a to b whose radius goes from ra to rb.
  function sdCone(p, a, b, ra, rb) {
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], px = p[0] - a[0], py = p[1] - a[1], pz = p[2] - a[2];
    const t = clamp01((px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz));
    return Math.hypot(px - t * bx, py - t * by, pz - t * bz) - (ra + (rb - ra) * t);
  }
  // A tube along a polyline of [x, y, z, radius] points.
  function sdTube(p, pts) {
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) { const v = sdCone(p, pts[i], pts[i + 1], pts[i][3], pts[i + 1][3]); if (v < d) d = v; }
    return d;
  }
  const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  const absX = p => [Math.abs(p[0]), p[1], p[2]];          // symmetric structures are written for the right side
  const inEllipsoid = (p, E) => ((p[0] - E.c[0]) / E.a[0]) ** 2 + ((p[1] - E.c[1]) / E.a[1]) ** 2 + ((p[2] - E.c[2]) / E.a[2]) ** 2;
  const inAny = (p, list) => list.some(E => inEllipsoid(p, E) < 1);

  /* ---------- the head's surface ----------
     The cranium is the head model's sphere, which is also the conductor's
     scalp; below and in front of it are the face, the nose, the lips and
     chin and the neck, and an ear behind each preauricular point.  The
     landmarks lie on this skin: the nasion where the nose meets the brow,
     the preauricular points just in front of each ear. */
  const FID = { NAS: v3.scale(MEG.sph(108, 0), R), LPA: v3.scale(MEG.ELEC.LPA, R), RPA: v3.scale(MEG.ELEC.RPA, R) };
  const EAR_C = Math.cos(0.44), EAR_S = Math.sin(0.44);
  function earSDF(p) {
    const q = absX(p);
    if (q[0] < 7.5 || q[2] > 0 || q[2] < -6 || q[1] > 1.5 || q[1] < -4.8) return 9;
    const dx = q[0] - 9.45, dy = q[1] + 1.85;
    // the auricle: a thin plate flaring backward, with the bowl of the concha in its outer face and the tragus in front
    let d = sdE([dx * EAR_C + dy * EAR_S, -dx * EAR_S + dy * EAR_C, q[2]], [0, 0, -3.1], [0.3, 1.3, 2.35]);
    d = smin(d, sdE(q, [9.0, -0.75, -3.5], [0.45, 0.4, 0.45]), 0.3);
    return Math.max(d, -sdE(q, [9.8, -1.15, -3.45], [0.38, 0.7, 0.8]));
  }
  function faceSDF(p) {
    let d = sdE(p, [0, 3.0, -6.4], [5.6, 5.85, 4.6]);                      // cheeks, maxilla and jaw
    d = smin(d, sdE(p, [0, 6.95, -9.95], [2.75, 1.6, 1.45]), 0.9);          // the chin
    d = smin(d, sdE(p, [0, 8.2, -7.75], [2.35, 0.8, 1.2]), 0.5);            // the lips
    d = Math.max(d, -sdE(p, [0, 8.75, -7.78], [2.0, 0.75, 0.035]));         // closed between them
    return smin(d, sdE(p, [0, -0.4, -16.5], [5.7, 6.1, 10.6]), 1.4);        // the neck
  }
  function noseSDF(p) {
    if (p[1] < 7.5 || Math.abs(p[0]) > 2.6) return 9;
    return smin(sdCone(p, [0, 8.7, -3.4], [0, 10.38, -5.55], 0.45, 0.78), sdE(p, [0, 9.5, -5.95], [1.6, 0.85, 0.62]), 0.35);
  }
  function skinSDF(p) {
    let d = Math.hypot(p[0], p[1], p[2]) - R;
    if (p[2] < -1 || p[1] > 7) { d = smin(d, faceSDF(p), 0.7); d = smin(d, noseSDF(p), 0.22); }
    return Math.min(d, earSDF(p));
  }
  // The nearest point of the skin: Newton steps along the distance's gradient.
  function nearestScalp(q) {
    let p = q.slice();
    for (let it = 0; it < 40; it++) {
      const d = skinSDF(p);
      if (Math.abs(d) < 1e-9) break;
      const e = 1e-5;
      const gx = (skinSDF([p[0] + e, p[1], p[2]]) - skinSDF([p[0] - e, p[1], p[2]])) / (2 * e);
      const gy = (skinSDF([p[0], p[1] + e, p[2]]) - skinSDF([p[0], p[1] - e, p[2]])) / (2 * e);
      const gz = (skinSDF([p[0], p[1], p[2] + e]) - skinSDF([p[0], p[1], p[2] - e])) / (2 * e);
      const g2 = gx * gx + gy * gy + gz * gz || 1;
      p = [p[0] - d * gx / g2, p[1] - d * gy / g2, p[2] - d * gz / g2];
    }
    return p;
  }

  /* ---------- the cortex ----------
     Sulci as curves on the brain's surface, given as [polar angle from the
     vertex, azimuth from the nose] pairs for the right hemisphere (the left
     is the mirror image), with a depth and a half-width in cm.  They are
     placed around the built-in generators: the hand areas of motor and
     somatosensory cortex face each other across the central sulcus under
     C3 and C4, Heschl's gyrus lies under the Sylvian fissure, and the alpha
     generators sit by the parieto-occipital sulcus.  Smaller sulci fill the
     rest: the zero lines of two smooth fields on each surface of the brain,
     leaning and curving as they go down. */
  const SULCUS_DEFS = [
    { name: 'central', pts: [[6, 170], [25, 112], [46, 86], [65, 72], [82, 66]], depth: 2.0, w: 0.12 },
    { name: 'precentral', pts: [[18, 70], [30, 80], [46, 68], [65, 58], [82, 52]], depth: 1.2, w: 0.09 },
    { name: 'postcentral', pts: [[25, 150], [30, 138], [46, 100], [65, 88], [82, 81]], depth: 1.2, w: 0.09 },
    { name: 'Sylvian', pts: [[95, 38], [97, 62], [98, 92], [94, 122], [86, 138]], depth: 3.1, w: 0.14 },
    { name: 'superior temporal', pts: [[104, 48], [109, 80], [109, 112], [102, 140]], depth: 1.4, w: 0.1 },
    { name: 'inferior temporal', pts: [[118, 60], [120, 100], [115, 138]], depth: 1.0, w: 0.09 },
    { name: 'intraparietal', pts: [[35, 140], [52, 145], [72, 152]], depth: 1.4, w: 0.1 },
    { name: 'superior frontal', pts: [[28, 22], [50, 20], [74, 18]], depth: 1.2, w: 0.1 },
    { name: 'inferior frontal', pts: [[52, 44], [68, 42], [84, 34]], depth: 1.1, w: 0.1 },
    { name: 'parieto-occipital', pts: [[48, 176], [64, 166], [78, 158]], depth: 1.8, w: 0.12 },
    { name: 'calcarine', pts: [[86, 176], [97, 166]], depth: 1.5, w: 0.1 },
    { name: 'lateral occipital', pts: [[88, 148], [102, 160]], depth: 1.0, w: 0.09 }
  ];
  const SULCI = [];
  [-1, 1].forEach(sd => SULCUS_DEFS.forEach(d => {
    const pts = d.pts.map(([t, a]) => MEG.sph(t, sd * a));
    const dense = [];
    for (let i = 0; i + 1 < pts.length; i++) for (let k = 0; k < 12; k++) dense.push(v3.unit(v3.lerp(pts[i], pts[i + 1], k / 12)));
    dense.push(pts[pts.length - 1]);
    const centre = v3.unit(dense.reduce((acc, q) => v3.add(acc, q), [0, 0, 0]));
    const reach = Math.max(...dense.map(q => Math.acos(MEG.clamp(v3.dot(q, centre), -1, 1))));
    SULCI.push({ name: d.name, side: sd < 0 ? 'left' : 'right', pts, dense, depth: d.depth, w: d.w, centre, reach });
  }));
  const defOf = name => SULCUS_DEFS.find(d => d.name === name).pts;
  // Where a sulcus crosses a latitude (its azimuth there), or an azimuth (its latitude there).
  function crossing(name, x, along) {
    const P = defOf(name), i0 = along === 'th' ? 0 : 1, i1 = 1 - i0;
    const pts = P.slice().sort((p, q) => p[i0] - q[i0]);
    if (x <= pts[0][i0]) return pts[0][i1];
    for (let i = 0; i + 1 < pts.length; i++) {
      if (x <= pts[i + 1][i0]) return MEG.lerp(pts[i][i1], pts[i + 1][i1], (x - pts[i][i0]) / (pts[i + 1][i0] - pts[i][i0]));
    }
    return pts[pts.length - 1][i1];
  }
  // The deepest named sulcus at a direction: depth falls off with distance (on the brain's surface) from its curve.
  function sulcusScan(u) {
    let best = 0, gap = 9;
    for (const s of SULCI) {
      if (Math.acos(MEG.clamp(u[0] * s.centre[0] + u[1] * s.centre[1] + u[2] * s.centre[2], -1, 1)) > s.reach + 0.35) continue;
      let dmin = 1e9;
      for (const q of s.dense) { const d = (u[0] - q[0]) ** 2 + (u[1] - q[1]) ** 2 + (u[2] - q[2]) ** 2; if (d < dmin) dmin = d; }
      const dist = Math.sqrt(dmin) * 7.9, depth = s.depth * Math.exp(-0.5 * (dist / (s.w * 6)) ** 2);
      if (depth > best) { best = depth; gap = dist - s.w; }
    }
    return { depth: best, gap };
  }
  // The same, tabulated every half degree the first time it is needed.
  const TAB = { step: 0.5, nT: 361, nP: 721, depth: null, gap: null };
  function sulcusAt(u) {
    if (!TAB.depth) {
      TAB.depth = new Float32Array(TAB.nT * TAB.nP); TAB.gap = new Float32Array(TAB.nT * TAB.nP);
      for (let i = 0; i < TAB.nT; i++) for (let j = 0; j < TAB.nP; j++) {
        const s = sulcusScan(MEG.sph(i * TAB.step, j * TAB.step - 180));
        TAB.depth[i * TAB.nP + j] = s.depth; TAB.gap[i * TAB.nP + j] = s.gap;
      }
    }
    const th = Math.acos(MEG.clamp(u[2], -1, 1)) / DEG / TAB.step, ph = (Math.atan2(u[0], u[1]) / DEG + 180) / TAB.step;
    const i = Math.min(TAB.nT - 2, Math.floor(th)), j = Math.min(TAB.nP - 2, Math.floor(ph)), fi = th - i, fj = ph - j;
    const k = i * TAB.nP + j, n = TAB.nP;
    const lerp2 = A => (A[k] * (1 - fj) + A[k + 1] * fj) * (1 - fi) + (A[k + n] * (1 - fj) + A[k + n + 1] * fj) * fi;
    return { depth: lerp2(TAB.depth), gap: lerp2(TAB.gap) };
  }
  // Small undulations of the brain's surface.
  function minorFold(u) {
    return Math.sin(9.1 * u[0] + 2.3) * Math.sin(8.3 * u[1] - 1.1) * Math.sin(7.7 * u[2] + 0.7) + 0.5 * Math.sin(13.7 * u[0] - 5.1 * u[2]) * Math.sin(11.9 * u[1] + 3.3 * u[0]);
  }
  function foldA(a, b, c) {
    return Math.sin(17.3 * a + 4.1 * b + 1.3) * Math.cos(15.1 * b - 3.7 * c + 0.4) +
      0.9 * Math.sin(13.9 * c + 6.2 * a - 2.2) * Math.cos(16.7 * a - 5.3 * c + 1.9) + 0.6 * Math.sin(21.1 * b + 9.4 * c + 0.3);
  }
  function foldB(a, b, c) {
    return Math.sin(12.1 * b - 6.3 * c + 2.1) * Math.cos(14.3 * a + 2.9 * b - 0.6) +
      0.8 * Math.sin(19.7 * c - 4.4 * a + 0.9) * Math.cos(11.3 * b + 7.1 * a + 1.4) + 0.5 * Math.sin(23.3 * a - 8.1 * b + 2.6);
  }
  /* How far (cm, along the brain's surface) a direction is from the nearest
     minor sulcus at depth dd: the zero lines of two fields, |f| over the
     length of its gradient, so that a sulcus has the same width wherever the
     field happens to be flat. */
  function minorSulcus(u, dd) {
    const k = 0.09 * dd + 0.035 * dd * dd;
    const a = u[0] + k * Math.sin(3.1 * u[1] + 1.7 * u[2]), b = u[1] + k * Math.sin(2.7 * u[2] - 2.3 * u[0]), c = u[2] + k * Math.sin(2.9 * u[0] + 1.3 * u[1]);
    const e = 0.004, dist = (f, sc) => {
      const f0 = f(sc * a, sc * b, sc * c);
      const gx = f(sc * (a + e), sc * b, sc * c) - f0, gy = f(sc * a, sc * (b + e), sc * c) - f0, gz = f(sc * a, sc * b, sc * (c + e)) - f0;
      return 7.9 * Math.abs(f0) / (Math.hypot(gx, gy, gz) / e + 1e-6);
    };
    return Math.min(dist(foldA, 1.0), 1.35 * dist(foldB, 0.95));
  }

  /* ---------- the skull base ----------
     The cranial cavity is the sphere above a floor: the anterior fossa
     (orbital roofs bulging up, the cribriform plate between them), the
     middle fossa (a bowl under each temporal lobe, behind the sphenoid
     ridge), the sella and clivus in the midline, and the posterior fossa
     (a bowl under each cerebellar hemisphere, behind the petrous ridge),
     opening at the foramen magnum.  The tentorium roofs the posterior
     fossa. */
  const petroY = ax => 0.6 - 0.6 * ax;                       // the petrous ridge, between middle and posterior fossae
  function floorZ(x, y) {
    const ax = Math.abs(x);
    if ((x / 1.35) ** 2 + ((y + 3.6) / 1.55) ** 2 < 1) return -20;          // the foramen magnum
    const zA = -3.35 + 0.8 * Math.exp(-(((ax - 2.9) / 1.5) ** 2));
    const zM = -5.25 + 0.55 * ((y - 0.1) / 2.3) ** 2 + 0.16 * (ax - 4.1) ** 2 + 0.2 * Math.max(0, ax - 5.6) ** 2;
    const zP = -6.95 + 0.35 * ((ax - 2.6) / 2.4) ** 2 + 0.12 * Math.max(0, -5.6 - y) ** 2 + 0.2 * Math.max(0, ax - 5.2) ** 2;
    const wA = sig((y - (1.9 + 0.28 * ax)) / 0.32), wP = sig((petroY(ax) - y) / 0.32);
    let z = wA * zA + wP * zP + (1 - wA - wP) * zM;
    // midline: the planum and tuberculum, the pituitary fossa, the dorsum sellae, then the clivus down to the foramen
    const mid = y > 1.85 ? -3.55 : y > 0.75 ? -4.35 + 0.2 * Math.cos((y - 1.3) * 2.8) : y > 0.4 ? -3.75 : -3.75 + (y - 0.4) * 0.92;
    const wm = sig((1.55 - ax) / 0.22) * (y > -3.3 && y < 2.9 ? 1 : 0);
    return z * (1 - wm) + Math.max(z, mid) * wm;
  }
  const tentZ = (x, y) => -1.2 - 0.17 * x * x * sig((y + 1.5) / 0.8) - 0.11 * x * x * (1 - sig((y + 1.5) / 0.8)) - 0.22 * Math.max(0, -2.4 - y);

  /* ---------- structures ----------
     Each is a signed distance in head coordinates (cm).  Left and right are
     mirror images, written for the right side and evaluated at |x|. */
  // The brainstem: cerebral peduncles and tectum, the pons bulging forward, the medulla and cord leaning back.
  function stemSDF(p) {
    const q = absX(p);
    let d = sdCone(q, [0.62, -0.3, -0.45], [0.52, -0.85, -2.6], 0.6, 0.52);
    d = smin(d, sdE(p, [0, -1.45, -1.55], [0.95, 0.85, 1.05]), 0.4);
    d = smin(d, sdE(q, [0.33, -2.15, -1.0], [0.32, 0.28, 0.28]), 0.15);
    d = smin(d, sdE(q, [0.33, -2.2, -1.62], [0.3, 0.27, 0.26]), 0.15);
    d = smin(d, sdE(p, [0, -0.95, -3.65], [1.45, 1.25, 1.05]), 0.5);
    d = smin(d, sdCone(p, [0, -1.55, -4.4], [0, -2.25, -6.7], 0.8, 0.62), 0.4);
    return smin(d, sdCone(p, [0, -2.25, -6.7], [0, -2.15, -17], 0.55, 0.45), 0.3);
  }
  function cbSDF(p) {
    const q = absX(p);
    return smin(sdE(q, [2.6, -4.95, -4.5], [3.5, 3.25, 2.35]), sdE(p, [0, -4.9, -3.55], [1.2, 2.6, 2.25]), 0.9);
  }
  const LV = [[1.0, 3.35, 0.95, 0.22], [1.05, 2.3, 1.15, 0.42], [1.0, 0.6, 1.45, 0.33], [1.2, -1.4, 1.4, 0.35], [1.85, -2.6, 0.95, 0.55], [1.95, -4.3, 0.75, 0.24]];
  const LV_T = [[1.85, -2.6, 0.95, 0.38], [2.9, -2.1, -0.5, 0.27], [3.25, -0.7, -1.8, 0.21], [3.15, 0.35, -2.25, 0.13]];
  const CAUDATE = [[1.55, 1.3, 1.75, 0.38], [1.65, -0.5, 1.75, 0.29], [1.85, -1.8, 1.45, 0.2]];
  const HIPPO = [[2.95, -2.4, -0.95, 0.38], [3.25, -1.2, -1.85, 0.44], [3.1, 0.0, -2.35, 0.4]];
  const FORNIX = [[0.22, 0.95, 0.55, 0.15], [0.2, -0.5, 1.1, 0.16], [0.55, -1.8, 0.95, 0.15], [1.5, -2.45, 0.25, 0.13]];
  const OPTIC_TRACT = [[0.6, 1.25, -2.65, 0.16], [1.85, -0.5, -2.15, 0.15]];
  const OPTIC_NERVE = [[0.45, 1.75, -2.85, 0.17], [1.35, 3.1, -3.75, 0.18]];
  const MANDIBLE = [[0, 7.25, -9.85, 0.55], [1.5, 7.0, -9.95, 0.55], [3.0, 5.6, -9.95, 0.5], [4.35, 3.1, -9.7, 0.45], [4.75, 1.6, -8.9, 0.45], [4.9, 1.0, -7.2, 0.42], [5.0, 0.6, -5.6, 0.38], [5.05, 0.35, -4.75, 0.42]];
  const ORBIT = { apex: [1.35, 3.0, -3.75], open: [3.15, 7.55, -3.85], globe: [3.15, 6.4, -3.95], gr: 1.15 };
  const RECTI = [[3.15, 6.05, -2.95], [3.15, 6.05, -4.95], [2.1, 6.05, -3.95], [4.2, 6.05, -3.95]];
  const HAND = ['C3', 'C4'].map((c, i) => v3.unit(v3.lerp(MEG.ELEC[c], MEG.ELEC[i ? 'FC4' : 'FC3'], 0.1)));
  // Heschl's gyrus on each superior temporal plane, with the Sylvian fissure's cleft above it.
  const HESCHL = [[-5.711, -0.902, -1.603], [5.763, -0.404, -1.618]].map(c => ({ c, a: [0.9, 0.45, 0.38] }));
  const CLEFT = HESCHL.map(h => ({ c: v3.add(h.c, [0, 0, 0.56]), a: [1.7, 1.0, 0.13] }));

  // Tissue intensities on the T1-weighted image, and a record for each kind of answer.
  const I1 = { air: 0.02, skin: 0.44, fat: 0.9, bone: 0.07, marrow: 0.52, csf: 0.1, grey: 0.46, white: 0.78, caudate: 0.58, putamen: 0.58, pallidum: 0.67, thalamus: 0.62, stem: 0.7, cbGrey: 0.43, cbWhite: 0.72, muscle: 0.36, mucosa: 0.44, cartilage: 0.38, vitreous: 0.08, lens: 0.55, sclera: 0.26, nerve: 0.64, gland: 0.66, tooth: 0.04, disc: 0.3, cord: 0.62, pit: 0.6 };
  const rec = (v, tissue, part, sided) => ({ v, tissue, part: part || null, sided: !!sided });
  const AIR = rec(I1.air, 'air', 'outside the head'), CSF = rec(I1.csf, 'CSF', null), GREY = rec(I1.grey, 'grey matter', null), WHITE = rec(I1.white, 'white matter', null);
  const SCALP = rec(I1.fat, 'scalp', 'scalp'), SKIN = rec(I1.skin, 'scalp', 'scalp'), MUSCLE = rec(I1.muscle, 'muscle', 'muscles of the face and neck');
  const SKULL = rec(I1.bone, 'skull', 'skull'), DIPLOE = rec(I1.marrow, 'skull', 'skull');
  const R_ = {
    tent: rec(0.12, 'dura', 'tentorium'), floorCSF: rec(I1.csf, 'CSF', 'CSF'), cistern: rec(I1.csf, 'CSF', 'basal cistern'), sheath: rec(I1.csf, 'CSF', 'cistern around the brainstem'),
    midbrain: rec(I1.stem, 'white matter', 'midbrain'), pons: rec(I1.stem, 'white matter', 'pons'), medulla: rec(I1.stem, 'white matter', 'medulla'), cord: rec(I1.cord, 'white matter', 'spinal cord'),
    aqueduct: rec(I1.csf, 'CSF', 'cerebral aqueduct'), v4: rec(I1.csf, 'CSF', 'fourth ventricle'), v3: rec(I1.csf, 'CSF', 'third ventricle'), lv: rec(I1.csf + 0.01, 'CSF', 'lateral ventricle', true),
    cbGrey: rec(I1.cbGrey, 'grey matter', 'cerebellum', true), cbWhite: rec(I1.cbWhite, 'white matter', 'cerebellum', true), vermis: rec(I1.cbGrey, 'grey matter', 'vermis of the cerebellum'),
    vermisW: rec(I1.cbWhite, 'white matter', 'vermis of the cerebellum'), dentate: rec(0.52, 'grey matter', 'dentate nucleus', true), peduncle: rec(I1.cbWhite, 'white matter', 'cerebellar peduncle', true),
    thal: rec(I1.thalamus, 'grey matter', 'thalamus', true), caud: rec(I1.caudate, 'grey matter', 'caudate nucleus', true), put: rec(I1.putamen, 'grey matter', 'putamen', true),
    pall: rec(I1.pallidum, 'grey matter', 'globus pallidus', true), claus: rec(0.52, 'grey matter', 'claustrum', true), insula: rec(I1.grey, 'grey matter', 'insula', true),
    sylv: rec(I1.csf, 'CSF', 'Sylvian fissure', true), hippo: rec(0.5, 'grey matter', 'hippocampus', true), amyg: rec(0.5, 'grey matter', 'amygdala', true),
    cc: rec(0.82, 'white matter', 'corpus callosum'), fornix: rec(0.76, 'white matter', 'fornix'), septum: rec(0.5, 'grey matter', 'septum pellucidum'),
    hypo: rec(0.55, 'grey matter', 'hypothalamus'), mammillary: rec(0.55, 'grey matter', 'mammillary body', true), chiasm: rec(I1.nerve, 'white matter', 'optic chiasm'),
    tract: rec(I1.nerve, 'white matter', 'optic tract', true), opticN: rec(I1.nerve, 'white matter', 'optic nerve', true), pit: rec(I1.pit, 'gland', 'pituitary gland'),
    heschl: rec(I1.grey, 'grey matter', 'Heschl’s gyrus (primary auditory cortex)', true),
    petrous: rec(0.05, 'bone', 'petrous bone', true), base: rec(I1.bone, 'skull', 'skull base'), baseM: rec(I1.marrow, 'skull', 'skull base'), facial: rec(I1.bone, 'bone', 'facial bones'),
    globe: rec(I1.vitreous, 'eye', 'eye', true), sclera: rec(I1.sclera, 'eye', 'eye', true), lens: rec(I1.lens, 'eye', 'lens of the eye', true), orbFat: rec(I1.fat, 'fat', 'orbit', true),
    rectus: rec(I1.muscle, 'muscle', 'eye muscle', true), orbWall: rec(I1.bone, 'bone', 'orbital wall', true),
    nasal: rec(I1.air, 'air', 'nasal cavity'), septumN: rec(0.36, 'cartilage', 'nasal septum'), turb: rec(I1.mucosa, 'mucosa', 'nasal turbinate', true),
    ethmoid: rec(I1.air, 'air', 'ethmoid air cells', true), ethmoidS: rec(0.16, 'bone', 'ethmoid air cells', true), maxSin: rec(I1.air, 'air', 'maxillary sinus', true),
    sphSin: rec(I1.air, 'air', 'sphenoid sinus'), frontSin: rec(I1.air, 'air', 'frontal sinus'), mastoid: rec(I1.air, 'air', 'mastoid air cells', true), mastoidB: rec(0.12, 'bone', 'mastoid air cells', true),
    canal: rec(I1.air, 'air', 'ear canal', true), ear: rec(I1.cartilage, 'cartilage', 'ear', true), earSkin: rec(I1.skin, 'skin and soft tissue', 'ear', true),
    nose: rec(I1.cartilage, 'cartilage', 'the nose'), noseSkin: rec(I1.skin, 'skin and soft tissue', 'the nose'), noseFat: rec(0.75, 'fat', 'the nose'), nostril: rec(I1.air, 'air', 'the nose'),
    palate: rec(I1.bone, 'bone', 'hard palate'), palateM: rec(I1.marrow, 'bone', 'hard palate'), softPalate: rec(I1.mucosa, 'muscle', 'soft palate'), tooth: rec(I1.tooth, 'tooth', 'teeth'),
    tongue: rec(0.4, 'muscle', 'tongue'), tongueF: rec(0.6, 'muscle', 'tongue'), mouth: rec(I1.air, 'air', 'mouth'), pharynx: rec(I1.air, 'air', 'pharynx'),
    mand: rec(I1.bone, 'bone', 'mandible', true), mandM: rec(I1.marrow, 'bone', 'mandible', true), masseter: rec(I1.muscle, 'muscle', 'masseter muscle', true),
    pteryg: rec(I1.muscle, 'muscle', 'pterygoid muscle', true), parotid: rec(I1.gland, 'gland', 'parotid gland', true), temporalis: rec(I1.muscle, 'muscle', 'temporalis muscle', true),
    vert: rec(I1.marrow + 0.04, 'bone', 'cervical vertebra'), vertC: rec(0.1, 'bone', 'cervical vertebra'), disc: rec(I1.disc, 'disc', 'intervertebral disc'),
    spinalCSF: rec(I1.csf, 'CSF', 'spinal canal'), lips: rec(0.42, 'muscle', 'lips'), fatFace: rec(0.88, 'fat', 'subcutaneous fat'), skinFace: rec(I1.skin, 'skin and soft tissue', 'skin')
  };

  // Deep structures of the cerebrum, or null.
  function deep(p, x, y, z) {
    const ax = Math.abs(x), q = [ax, y, z];
    if (ax > 5.1 || y > 4.2 || y < -4.8 || z > 2.6 || z < -3.4) return null;
    if (sdTube(q, LV) < 0 || sdTube(q, LV_T) < 0) return R_.lv;
    // the corpus callosum, an arch thicker at its two ends, and the fornix and septum under it
    const e = Math.hypot((y + 0.2) / 3.3, (z - 0.75) / 1.25), th = 0.24 + 0.2 * Math.exp(-(((y - 3.0) / 0.7) ** 2)) + 0.24 * Math.exp(-(((y + 3.35) / 0.7) ** 2));
    if (ax < 1.7 && (z > 0.75 || y > 2.6) && Math.abs(e - 1) * 1.25 < th * 0.5) return R_.cc;
    if (sdTube(q, FORNIX) < 0) return R_.fornix;
    if (ax < 0.07 && e < 1 && z > 0.55 && y > -0.6) return R_.septum;
    if (ax < 0.1 && y > -1.8 && y < 0.95 && z > -1.9 && z < 0.55) return R_.v3;
    if (sdE(q, [1.25, -0.8, 0.0], [0.82, 1.5, 0.78]) < 0) return R_.thal;
    if (sdE(q, [1.75, 2.3, 0.85], [0.62, 1.0, 0.9]) < 0 || sdTube(q, CAUDATE) < 0) return R_.caud;
    if (sdE(q, [2.2, 0.55, -0.05], [0.42, 1.0, 0.65]) < 0) return R_.pall;
    if (sdE(q, [2.9, 0.9, 0.15], [0.62, 1.75, 1.05]) < 0) return R_.put;
    if (ax > 3.0) {
      const ins = sdE(q, [2.3, 0.7, -0.15], [2.35, 2.7, 1.75]);
      if (ins > -0.3 && ins < 0.22 && ax > 4.0) return ins < 0 ? R_.insula : R_.sylv;
      const cl = sdE(q, [2.3, 0.7, -0.15], [1.7, 2.35, 1.45]);
      if (cl > -0.07 && cl < 0.03 && ax > 3.65) return R_.claus;
    }
    if (sdTube(q, HIPPO) < 0) return R_.hippo;
    if (sdE(q, [2.85, 0.8, -2.5], [0.6, 0.6, 0.55]) < 0) return R_.amyg;
    return null;
  }

  /* The posterior fossa under the tentorium.  The cerebellum fills it, less
     a film of CSF along its walls and round the brainstem, the fourth
     ventricle in front and the cisterna magna below; its folia are thin
     layers of cortex parallel to the surface with white matter between. */
  function posteriorFossa(p, x, y, z, r, fz, zt) {
    if (z > zt - 0.1) return R_.tent;
    if (sdE(p, [0, -2.62, -3.95], [0.62, 0.38, 0.95]) < 0) return R_.v4;
    const ax = Math.abs(x), q = [ax, y, z];
    if (sdCone(q, [0.95, -1.7, -3.55], [1.95, -3.35, -3.9], 0.48, 0.55) < 0) return R_.peduncle;
    const wall = Math.min(zt - 0.1 - z, z - fz - 0.15, (petroY(ax) - y) * 0.86, 8.06 - r, stemSDF(p) - 0.3);
    if (wall < 0.12) return CSF;
    if (sdE(p, [0, -6.3, -6.25], [1.5, 1.3, 0.75]) < 0) return CSF;            // the cisterna magna
    if (ax < 0.07 && y < -6.2) return CSF;                                       // between the hemispheres, at the back
    const verm = ax < 0.95, dc = wall - 0.12;
    if (sdE(q, [1.45, -4.3, -4.1], [0.5, 0.75, 0.55]) < 0) return R_.dentate;
    if (dc > 1.35 + 0.2 * Math.sin(2.1 * x + 1.3 * y)) return verm ? R_.vermisW : R_.cbWhite;
    const ang = Math.atan2(z + 3.6, y + 2.9), rad = Math.hypot(y + 2.9, z + 3.6);
    const ray = Math.abs(Math.sin(6.5 * ang + 0.35 * Math.sin(2.3 * rad + 0.8 * x)));
    if (dc > 0.3 && ray < 0.16 * Math.min(1, dc / 1.2)) return verm ? R_.vermisW : R_.cbWhite;
    const ph = dc / 0.27 + 0.8 * Math.sin(1.9 * x + 1.3 * Math.sin(1.1 * z)) + 2.6 * ang;
    const f = ph - Math.floor(ph);
    if (dc < 1.1 && f > 0.45 && f < 0.53) return CSF;
    if (dc > 0.28 && f < 0.15) return verm ? R_.vermisW : R_.cbWhite;
    return verm ? R_.vermis : R_.cbGrey;
  }

  // Named sulci of the medial face, as polylines in (y, z): callosal, cingulate with its marginal ramus, parieto-occipital, calcarine.
  const MEDIAL_SULCI = [
    { pts: Array.from({ length: 13 }, (_, i) => { const a = Math.PI * (0.02 + 0.96 * i / 12); return [-0.2 + 3.62 * Math.cos(a), 0.75 + 1.42 * Math.sin(a)]; }), depth: 0.6 },
    { pts: Array.from({ length: 11 }, (_, i) => { const a = Math.PI * (0.05 + 0.6 * i / 10); return [-0.2 + 4.4 * Math.cos(a), 0.75 + 2.35 * Math.sin(a)]; }).reverse().concat([[-2.6, 4.6], [-2.9, 7.0]]), depth: 1.1 },
    { pts: [[-3.5, 0.9], [-4.6, 2.2], [-5.6, 3.4], [-6.3, 4.4]], depth: 1.9 },
    { pts: [[-3.5, 0.45], [-4.9, 0.35], [-6.3, 0.2], [-7.5, 0.1]], depth: 1.6 }
  ];
  function medialSulcus(y, z, dm, right) {
    if (right) { y = 1.04 * y + 0.15; z = 0.97 * z + 0.12; }
    let best = 9;
    for (const s of MEDIAL_SULCI) {
      if (dm > s.depth + 0.3) continue;
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const [ay, az] = s.pts[i], [by, bz] = s.pts[i + 1], vy = by - ay, vz = bz - az;
        const t = clamp01(((y - ay) * vy + (z - az) * vz) / (vy * vy + vz * vz));
        const d = Math.hypot(y - ay - t * vy, z - az - t * vz) + (dm > s.depth ? 9 : 0);
        if (d < best) best = d;
      }
    }
    return best;
  }

  // The cerebral cortex and white matter, from the depth below the nearest surface of the brain.
  function cerebrum(p, x, y, z, r, u, fz, zt) {
    const ax = Math.abs(x);
    const surf = 7.9 + 0.12 * minorFold(u), dc = surf - r;
    if (dc < 0) return CSF;
    if (inAny(p, CLEFT)) return CSF;
    if (inAny(p, HESCHL)) return R_.heschl;
    // (held still round the hand knobs, where the somatosensory and motor generators sit on the central sulcus's walls)
    const knob = Math.max(v3.dot(u, HAND[0]), v3.dot(u, HAND[1]));
    const wob = (0.012 * Math.sin(23 * u[0] + 17 * u[2] + 1.1) + 0.012 * Math.sin(19 * u[1] - 21 * u[2]) + 0.012 * dc) * clamp01((Math.acos(MEG.clamp(knob, -1, 1)) - 0.12) / 0.15);
    const sc = sulcusAt(v3.unit([u[0] + wob * Math.sin(3.3 * u[1] + 1.2), u[1] + wob * Math.sin(2.9 * u[2] - 0.4), u[2] + wob * Math.sin(3.1 * u[0] + 0.8)]));
    if (sc.depth > 0.25 && dc < sc.depth && sc.gap < 0.03) return CSF;                 // a named sulcus
    if (sc.depth > 0.25 && dc < sc.depth + 0.3 && sc.gap < 0.35) return GREY;          // and the cortex lining it
    // the medial face, wherever the hemispheres are not joined; the basal faces on the fossae and the tentorium
    const e = Math.hypot((y + 0.2) / 3.3, (z - 0.75) / 1.25);
    const dm = e > 1.1 || z < -1.3 ? ax - 0.035 - 0.09 * clamp01((r - 6.6) / 1.3) : 99;
    const db = z - fz - 0.15;
    const dt = y < petroY(ax) ? z - zt - 0.12 : 99;
    if (dm < 0 || db < 0 || dt < 0) return CSF;
    const d = Math.min(dc, dm, db, dt);
    // smaller sulci: sheets standing on whichever surface is nearest, leaning and narrowing as they go down
    const md = 1.25 + 0.85 * (0.5 + 0.5 * Math.sin(5.3 * u[0] - 3.7 * u[1] + 2.9 * u[2]) * Math.cos(4.1 * u[2] + 1.3 * u[0]));
    if (d > md + 0.35) return WHITE;
    let m = minorSulcus(u, d);
    // the cingulate sulcus arches over the callosum on the medial face
    if (d === dm) {
      const ty = (y + 0.2) / 4.3, tz = (z - 0.75) / 2.3, th = Math.atan2(tz, ty);
      const sh = x < 0 ? 0 : 1.9;
      const g = (a, b) => Math.sin(6.3 * Math.hypot(a, b) * 0.62 + sh + 0.9 * Math.sin(2.7 * Math.atan2(b, a) + 0.6 + sh) + 0.6 * Math.sin(5.1 * th + 1.3 * a));
      const g0 = g(ty, tz), gy = (g(ty + 0.002, tz) - g0) / (0.002 * 4.3), gz = (g(ty, tz + 0.002) - g0) / (0.002 * 2.3);
      m = Math.min(dm < 0.55 ? 1.6 * Math.abs(g0) / (Math.hypot(gy, gz) + 1e-6) : 9, medialSulcus(y, z, dm, x > 0));
    }
    if (d < md && m < 0.075 * (1 - 0.5 * d / md)) return CSF;
    if (d < 0.3 || (d < md + 0.3 && m < 0.36)) return GREY;
    return WHITE;
  }

  // Inside the head, below the floor of the skull or outside the cranium: the face, the ears and the neck.
  function faceNeck(p, x, y, z, r, fz) {
    const ax = Math.abs(x), q = [ax, y, z];
    const s = -skinSDF(p);
    if (s < 0.1) return earSDF(p) < 0 ? R_.earSkin : noseSDF(p) < 0 ? R_.noseSkin : R_.skinFace;
    if (earSDF(p) < 0) return R_.ear;
    if (r > R - 0.15 && noseSDF(p) < 0) {
      if (sdE(q, [0.45, 9.85, -6.0], [0.33, 0.62, 0.3]) < 0) return R_.nostril;
      return s < 0.3 ? R_.noseSkin : (ax < 0.12 ? R_.nose : R_.noseFat);
    }
    if (sdCone(q, [9.05, -0.65, -3.55], [6.8, -0.5, -3.7], 0.32, 0.25) < 0) return R_.canal;
    // the orbits: the eye, its muscles and nerve in a cone of fat and bone
    if (ax > 0.6 && ax < 5.6 && y > 2.6 && z > -6.2 && z < -1.6) {
      const cone = smin(sdCone(q, ORBIT.apex, ORBIT.open, 0.35, 1.6), sdE(q, [2.95, 5.6, -3.85], [1.55, 2.3, 1.4]), 0.6);
      if (cone < 0) {
        const g = v3.norm(v3.sub(q, ORBIT.globe));
        if (g < ORBIT.gr) {
          if (sdE(q, [3.15, 7.38, -3.95], [0.42, 0.17, 0.42]) < 0) return R_.lens;
          return g > ORBIT.gr - 0.09 ? R_.sclera : R_.globe;
        }
        if (sdCone(q, [3.05, 5.35, -3.92], ORBIT.apex, 0.22, 0.18) < 0) return R_.opticN;
        for (const ins of RECTI) if (sdCone(q, ORBIT.apex, ins, 0.12, 0.27) < 0) return R_.rectus;
        return R_.orbFat;
      }
      if (cone < 0.13 && y < 7.3) return R_.orbWall;
    }
    // the skull base, between the cranial cavity and everything below it
    if (z > fz - (y > 2.5 ? 0.22 : 0.6) && fz > -19) {
      if (sdE(p, [0, 1.35, -4.95], [1.3, 0.95, 0.7]) < 0) return R_.sphSin;
      return (fz - z > 0.18 && fz - z < 0.42 && y < 2.5) ? R_.baseM : R_.base;
    }
    if (sdE(p, [0, 1.35, -4.95], [1.3, 0.95, 0.7]) < 0) return R_.sphSin;
    // the nasal cavity and the sinuses around it
    const nc = (x / 1.25) ** 2 + ((z + 5.3) / 2.05) ** 2;
    if (nc < 1 && y > 2.3 && y < 9.2) {
      if (ax < 0.13) return R_.septumN;
      if (ax < 0.3) return R_.turb;                                                    // mucosa on the septum
      const tq = [ax, y, z];
      if (sdE(tq, [1.05, 5.6, -6.55], [0.55, 2.7, 0.62]) < 0 || sdE(tq, [1.0, 5.3, -5.3], [0.5, 2.2, 0.48]) < 0 || sdE(tq, [0.9, 4.6, -4.25], [0.4, 1.5, 0.36]) < 0) return R_.turb;
      if (nc > 0.72) return R_.turb;                                                   // mucosa on the outer walls
      return R_.nasal;
    }
    if (nc < 1.25 && y > 2.3 && y < 8.6) return R_.facial;
    if (ax > 0.3 && ax < 1.85 && y > 3.5 && y < 7.3 && z < fz && z > -5.2) return Math.sin(4.6 * x) * Math.sin(4.3 * y) * Math.sin(4.9 * z) > -0.25 ? R_.ethmoid : R_.ethmoidS;
    const mx = sdE(q, [2.85, 5.25, -6.2], [1.15, 1.75, 1.15]);
    if (mx < 0) return R_.maxSin;
    if (mx < 0.12) return R_.facial;
    const mast = sdE(q, [6.2, -2.4, -5.3], [1.0, 1.15, 1.25]);
    if (mast < 0) return Math.sin(5.1 * x + 1) * Math.sin(4.7 * y) * Math.sin(5.3 * z) > -0.2 ? R_.mastoid : R_.mastoidB;
    if (sdCone(q, [1.9, -0.55, -4.6], [6.1, -3.05, -5.0], 0.72, 0.85) < 0) return R_.petrous;
    // mouth: palate, teeth, tongue; the pharynx behind
    const arch = (x / 2.45) ** 2 + ((y - 5.3) / 3.0) ** 2;
    if (y > 2.9 && arch < 1 && z < -7.25 && z > -7.6) return z > -7.38 && z < -7.48 ? R_.palateM : R_.palate;
    const archR = Math.hypot(x / 2.45, (y - 5.3) / 3.0);
    if (y > 3.6 && archR > 0.84 && archR < 1.08 && ((z < -7.6 && z > -8.45) || (z < -8.55 && z > -9.35))) return R_.tooth;
    if (y > 2.9 && arch < 1 && z <= -7.6 && z > -7.78) return R_.mouth;
    if (sdE(p, [0, 4.6, -8.75], [2.05, 3.2, 1.35]) < 0) return Math.abs(x) < 0.12 ? R_.tongueF : R_.tongue;
    if (sdCone(p, [0, 3.0, -7.45], [0, 2.0, -8.7], 0.38, 0.28) < 0) return R_.softPalate;
    if (sdE(p, [0, 1.95, -5.75], [1.2, 0.8, 0.6]) < 0 || ((x / 1.3) ** 2 + ((y - 1.25) / 0.52) ** 2 < 1 && z < -5.6)) return R_.pharynx;
    const lips = sdE(p, [0, 8.2, -7.75], [2.35, 0.8, 1.2]);
    if (lips < 0 && y > 7.6) return R_.lips;
    // jaw and its muscles, the parotid gland
    const md = sdTube(q, MANDIBLE);
    if (md < 0) return md > -0.13 ? R_.mand : R_.mandM;
    if (sdE(q, [5.45, 2.0, -7.4], [0.62, 1.55, 2.05]) < 0) return R_.masseter;
    if (sdE(q, [3.7, 1.9, -7.6], [0.55, 1.2, 1.6]) < 0 || sdE(q, [3.9, 1.3, -5.6], [0.6, 0.8, 0.55]) < 0) return R_.pteryg;
    if (sdE(q, [5.85, -0.7, -6.8], [0.95, 1.25, 1.9]) < 0) return R_.parotid;
    // the spine: vertebral bodies and discs in front, the canal with the cord behind
    const st = stemSDF(p);
    if (st < 0) return z < -7 ? R_.cord : R_.medulla;
    if ((x / 0.88) ** 2 + ((y + 2.15) / 0.85) ** 2 < 1 && z < -6.4) return R_.spinalCSF;
    if (z < -7.0) {
      if (sdCone(p, [0, -0.35, -8.3], [0, -0.25, -6.95], 0.45, 0.4) < 0) return R_.vert;                 // the dens
      if (sdE(p, [0, 0.75, -7.35], [0.62, 0.32, 0.38]) < 0) return R_.vertC;                             // the arch of C1
      const vb = (x / 0.95) ** 2 + ((y + 0.55) / 0.8) ** 2;
      if (vb < 1 && z < -8.3) {
        const lev = (-z - 8.3) % 2.0;
        if (lev > 1.62) return R_.disc;
        return vb > 0.8 || lev < 0.07 || lev > 1.55 ? R_.vertC : R_.vert;
      }
      if (sdE(p, [0, -3.75, -7.4], [1.2, 0.35, 0.35]) < 0 || sdE(p, [0, -3.9, -9.9], [0.45, 1.0, 0.5]) < 0) return R_.vertC;
    }
    // the rest: fat under the skin, muscle deeper, with planes of fat between muscles
    if (s < 0.4 + 0.25 * Math.sin(1.3 * x + 2.1) * Math.sin(1.1 * y - 0.7 * z)) return R_.fatFace;
    return MUSCLE;
  }

  /* The tissue at a head-frame point: its T1 intensity (air dark, fat
     bright, bone dark with brighter marrow, CSF dark, grey matter mid,
     white matter bright, deep nuclei between), what it is, and the name of
     the structure where it has one. */
  function anat(p) {
    const x = p[0], y = p[1], z = p[2], r = Math.hypot(x, y, z);
    if (r > R - 0.3 && skinSDF(p) > 0) return AIR;
    const fz = floorZ(x, y);
    if (r < 8.2 && z > fz) {
      const u = r > 1e-9 ? [x / r, y / r, z / r] : [0, 0, 1];
      if (r > 8.06) return CSF;
      const ax = Math.abs(x);
      if (ax > 1.2 && z < -3.0 && y < 1.0 && sdCone([ax, y, z], [1.9, -0.55, -4.6], [6.1, -3.05, -5.0], 0.72, 0.85) < 0) return R_.petrous;
      if (z < fz + 0.15) return R_.floorCSF;
      const zt = tentZ(x, y);
      if (y < petroY(ax) && z < zt) {
        if (ax < 1.8 && y > -3.4) { const st = stemSDF(p); if (st < 0) return z > -2.65 ? R_.midbrain : z > -4.5 ? R_.pons : R_.medulla; }
        return posteriorFossa(p, x, y, z, r, fz, zt);
      }
      // the brainstem through the notch of the tentorium, and the cisterns around it
      if (ax < 2.2 && y > -3.4 && y < 2.8 && z < -0.3) {
        const st = stemSDF(p);
        if (st < 0) {
          if (sdCone(p, [0, -1.62, -0.95], [0, -1.85, -2.5], 0.07, 0.07) < 0) return R_.aqueduct;
          return z > -2.65 ? R_.midbrain : z > -4.5 ? R_.pons : R_.medulla;
        }
        if (z < -1.3) {
          if (sdE(p, [0, 1.42, -2.7], [0.75, 0.3, 0.17]) < 0) return R_.chiasm;
          if (sdTube([ax, y, z], OPTIC_TRACT) < 0) return R_.tract;
          if (sdTube([ax, y, z], OPTIC_NERVE) < 0) return R_.opticN;
          if (sdE(p, [0, 1.2, -4.0], [0.6, 0.45, 0.32]) < 0 || sdCone(p, [0, 1.3, -2.8], [0, 1.2, -3.7], 0.09, 0.09) < 0) return R_.pit;
          if (sdE([ax, y, z], [0.25, -0.2, -2.05], [0.22, 0.22, 0.22]) < 0) return R_.mammillary;
          if (ax < 0.7 && y > -0.5 && y < 1.2 && z > -2.15) return ax < 0.1 ? R_.v3 : R_.hypo;
          if (st < 0.32) return R_.sheath;                                                   // CSF all round the brainstem
          if (sdE(p, [0, 1.05, -3.0], [1.45, 1.1, 0.62]) < 0) return R_.cistern;             // the suprasellar cistern
          if (ax < 0.6 && y > -0.9 && y < 0.6 && z < -2.0) return R_.cistern;                // the interpeduncular fossa
        }
      }
      const dp = deep(p, x, y, z);
      if (dp) return dp;
      return cerebrum(p, x, y, z, r, u, fz, zt);
    }
    if (r >= 8.2 && r < 8.7 && z > fz - 0.5) {
      // the vault: two tables of compact bone with marrow between, the frontal sinus in front
      if (r > 8.25 && r < 8.65 && sdE(p, [0, 8.25, -1.55], [1.55, 0.6, 0.85]) < 0) return R_.frontSin;
      return r > 8.32 && r < 8.58 ? DIPLOE : SKULL;
    }
    if (r <= R && z > fz) {
      // the scalp: skin over fat, with the temporalis muscle on the temple
      if (r > R - 0.13) return SKIN;
      if (Math.abs(x) > 5.6 && ((y - 0.6) / 3.2) ** 2 + ((z + 0.4) / 2.9) ** 2 < 1) return R_.temporalis;
      return SCALP;
    }
    return faceNeck(p, x, y, z, r, fz);
  }
  const t1 = p => anat(p).v;

  /* ---------- the image ----------
     One slice of the MRI in scanner coordinates.  plane: 'axial' (z fixed),
     'coronal' (y fixed) or 'sagittal' (x fixed); `at` is the fixed MRI
     coordinate; the image covers +-half cm around the head's centre.
     Axial and coronal slices follow the neurological convention (left on
     the left); sagittal slices put the face on the left.  Each pixel
     averages five samples (its corners, shared with its neighbours, and its
     centre), as a scanner's voxel averages what it contains; a smooth bias
     field and noise make it look like an image rather than a drawing. */
  const hash = (a, b, c) => { const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return h - Math.floor(h); };
  function slice(plane, at, res, half, centre) {
    const c = centre || apply(TRUE, [0, 0, 0]);
    const pt = (a, b) => (plane === 'axial' ? [c[0] + a, c[1] + b, at] : plane === 'coronal' ? [c[0] + a, at, c[2] + b] : [at, c[1] - a, c[2] + b]);
    const n = res + 1, corner = new Float32Array(n * n), step = 2 * half / res;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) corner[j * n + i] = anat(apply(TRUE_INV, pt(-half + i * step, half - j * step))).v;
    const img = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const p = apply(TRUE_INV, pt(-half + (i + 0.5) * step, half - (j + 0.5) * step));
      const v = 0.5 * anat(p).v + 0.125 * (corner[j * n + i] + corner[j * n + i + 1] + corner[(j + 1) * n + i] + corner[(j + 1) * n + i + 1]);
      const bias = 1 + 0.06 * Math.sin(0.17 * p[0] + 0.4) * Math.cos(0.13 * p[1] - 0.2) + 0.04 * Math.sin(0.21 * p[2] + 0.9);
      // Rician-like noise: a floor of noise in the air, a little grain everywhere else
      const g1 = hash(p[0], p[1], p[2]) - 0.5, g2 = hash(p[1] + 3.1, p[2] - 1.7, p[0] + 0.3) - 0.5;
      const sv = v * bias + 0.045 * g1, sq = 0.045 * g2;
      img[j * res + i] = MEG.clamp(Math.sqrt(sv * sv + sq * sq), 0, 1);
    }
    return img;
  }
  // Pixel coordinates of an MRI-frame point on a slice drawn as above.
  function slicePixel(plane, m, res, half, centre) {
    const c = centre || apply(TRUE, [0, 0, 0]);
    let a, b, off;
    if (plane === 'axial') { a = m[0] - c[0]; b = m[1] - c[1]; off = m[2]; }
    else if (plane === 'coronal') { a = m[0] - c[0]; b = m[2] - c[2]; off = m[1]; }
    else { a = c[1] - m[1]; b = m[2] - c[2]; off = m[0]; }
    return { x: (a + half) / (2 * half) * res, y: (half - b) / (2 * half) * res, off };
  }

  /* ---------- the digitizer ---------- */
  function digitize(seed, opts) {
    opts = opts || {};
    const st = MEG.stream(seed || 1, 'digitizer'), noise = opts.noise === undefined ? 0.1 : opts.noise;
    const jit = p => v3.add(p, [noise * st.gauss(), noise * st.gauss(), noise * st.gauss()]);
    const pts = [];
    // over the scalp: above the ears, leaving the face and the ears themselves
    MEG.fibonacciSphere(400).forEach(u => {
      if (u[2] < -0.15) return;
      if (u[1] > 0.55 && u[2] < 0.35) return;
      if (Math.hypot(Math.abs(u[0]) * R - 9.2, u[1] * R + 1.6, u[2] * R + 2.6) < 2.8) return;
      if (pts.length < (opts.scalp || 110) && st.next() < 0.45) pts.push(jit(v3.scale(u, R)));
    });
    // along the nose, from the bridge to the tip
    if (opts.nose !== false) for (let k = 0; k < 24; k++) {
      const z = -2.9 - 3.4 * k / 23, x = (k % 3 - 1) * 0.4;
      pts.push(jit(nearestScalp([x, 14, z])));
    }
    // the landmarks from their own stream, so they stay put whether or not the nose is traced
    const sf = MEG.stream(seed || 1, 'digitizer landmarks');
    const jitF = p => v3.add(p, [noise * sf.gauss(), noise * sf.gauss(), noise * sf.gauss()]);
    const fids = { NAS: jitF(FID.NAS), LPA: jitF(FID.LPA), RPA: jitF(FID.RPA) };
    return { pts, fids };
  }

  /* ---------- rigid registration ----------
     Horn's closed form: the rotation is the eigenvector of a 4 x 4 matrix
     built from the cross-covariance of the two centred point sets, read as
     a quaternion.  Weighted, so landmarks can count for more. */
  function rigid(A, B, w) {
    const n = A.length; w = w || A.map(() => 1);
    const W = w.reduce((s, x) => s + x, 0);
    const ca = [0, 0, 0], cb = [0, 0, 0];
    A.forEach((a, i) => { for (let k = 0; k < 3; k++) { ca[k] += w[i] * a[k] / W; cb[k] += w[i] * B[i][k] / W; } });
    const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < n; i++) { const a = v3.sub(A[i], ca), b = v3.sub(B[i], cb); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w[i] * a[r] * b[c]; }
    const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
    const N = [
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
    ];
    const { vectors } = la.eigSym(N);
    const [q0, q1, q2, q3] = [vectors[0][0], vectors[1][0], vectors[2][0], vectors[3][0]];
    const R = [
      [q0 * q0 + q1 * q1 - q2 * q2 - q3 * q3, 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2)],
      [2 * (q1 * q2 + q0 * q3), q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, 2 * (q2 * q3 - q0 * q1)],
      [2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), q0 * q0 - q1 * q1 - q2 * q2 + q3 * q3]
    ];
    return { R, t: v3.sub(cb, MEG.matVec(R, ca)) };
  }

  /* Coregistration as an MEG lab does it.  digi: head-frame points from
     the digitizer; mriFids: the three landmarks as marked on the MRI (in
     MRI coordinates, with whatever error the marker made).  Step 1 lines
     the landmarks up; step 2, if asked, runs ICP between the head-shape
     points and the MRI scalp, keeping the landmarks in with a weight. */
  function coregister(digi, mriFids, opts) {
    opts = opts || {};
    const names = ['NAS', 'LPA', 'RPA'];
    let T = rigid(names.map(k => digi.fids[k]), names.map(k => mriFids[k]));
    const history = [{ T, step: 'landmarks' }];
    if (opts.icp) {
      const wF = opts.fidWeight === undefined ? 5 : opts.fidWeight;
      for (let it = 0; it < (opts.iterations || 25); it++) {
        const A = [], B = [], w = [];
        digi.pts.forEach(p => {
          const m = apply(T, p);                                     // where this point lands in the MRI
          const near = apply(TRUE, nearestScalp(apply(TRUE_INV, m)));  // the nearest point of the MRI's scalp
          A.push(p); B.push(near); w.push(1);
        });
        names.forEach(k => { A.push(digi.fids[k]); B.push(mriFids[k]); w.push(wF); });
        T = rigid(A, B, w);
        history.push({ T, step: 'icp ' + (it + 1) });
      }
    }
    return { T, history };
  }
  // How far the estimated transform puts a head-frame point from where it really is, cm.
  const errorAt = (T, p) => v3.norm(v3.sub(apply(T, p), apply(TRUE, p)));
  // RMS distance of the digitized points from the scalp after registration.
  function surfaceFit(T, digi) {
    let s = 0; digi.pts.forEach(p => { const m = apply(T, p); const near = apply(TRUE, nearestScalp(apply(TRUE_INV, m))); s += v3.norm(v3.sub(m, near)) ** 2; });
    return Math.sqrt(s / digi.pts.length);
  }

  /* ---------- a rough atlas ----------
     The tissue and the name of the place a head-frame point falls in, from
     the same anatomy the image is drawn with.  Cortical regions are named
     by where the point lies relative to the central sulcus, the Sylvian
     fissure and the temporal sulci, as an atlas would. */
  const tissue = p => anat(p).tissue;
  function label(p) {
    const a = anat(p), r = v3.norm(p);
    const u = v3.unit(p), az = Math.atan2(u[0], u[1]) / DEG;
    const side = Math.abs(p[0]) < 0.15 ? 'midline:' : az < 0 ? 'left' : 'right';
    if (a.part) return a.sided && side !== 'midline:' ? `${side} ${a.part}` : a.part;
    if (a.tissue === 'CSF') return r > 7.95 ? 'CSF, outside the brain' : 'CSF in a sulcus';
    const th = Math.acos(MEG.clamp(u[2], -1, 1)) / DEG, aa = Math.abs(az);
    if (r < 3.4) return 'deep white matter, near the midline';
    if (Math.abs(p[0]) < 0.6 && p[2] > 1.6) return `${side === 'midline:' ? 'midline' : side} cingulate and medial frontal cortex`;
    if (th < 10) return `${side} paracentral lobule`;
    let region;
    const thS = crossing('Sylvian', aa, 'az'), thSTS = crossing('superior temporal', aa, 'az'), thITS = crossing('inferior temporal', aa, 'az');
    if (aa > 148 || (aa > 132 && th > 84)) {
      region = Math.abs(p[0]) > 2.4 ? 'lateral occipital cortex' : th > 84 ? 'calcarine cortex (primary visual)' : 'cuneus, by the parieto-occipital sulcus';
    } else if (th > thS && aa > 32) {
      region = th < thSTS ? 'superior temporal gyrus' : th < thITS ? 'middle temporal gyrus' : 'inferior temporal gyrus';
    } else if (th > 96 && aa < 40) {
      region = 'orbitofrontal cortex';
    } else {
      const d = aa - crossing('central', th, 'th');
      if (Math.abs(d) < 10) region = d > 0 ? 'postcentral gyrus (primary somatosensory)' : 'precentral gyrus (primary motor)';
      else if (d < 0) region = d > -24 ? 'premotor cortex' : th < 42 ? 'superior frontal gyrus' : th < 68 ? 'middle frontal gyrus' : 'inferior frontal gyrus';
      else region = th < 52 ? 'superior parietal lobule' : aa < 135 ? 'supramarginal gyrus' : 'angular gyrus';
    }
    return `${side} ${region}`;
  }

  MEG.mri = { TRUE, TRUE_INV, apply, invert, t1, anat, floorZ, skinSDF, slice, slicePixel, nearestScalp, digitize, rigid, coregister, errorAt, surfaceFit, label, tissue, FID, SULCI };
})(typeof window !== 'undefined' ? window : globalThis);
