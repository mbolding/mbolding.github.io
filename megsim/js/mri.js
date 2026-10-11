/* MEG simulator: the structural MRI and coregistration.

   MEG localizes sources in head coordinates, defined by three landmarks
   digitized on the participant: the nasion and the two preauricular
   points.  To show a source on the anatomy, the MRI must be put in the
   same frame.  The landmarks are found again on the MRI, a rigid transform
   lines the two sets up, and the hundred or so head-shape points traced
   with the digitizer pen are then fitted to the MRI's scalp surface by
   iterative closest points (ICP).  Every millimetre of error in that
   transform moves every source by the same amount on the anatomy.

   The MRI here is synthetic: the same spherical head with a folded cortex,
   a skull with marrow, ventricles, deep nuclei and a nose, sampled as a
   T1-weighted image.  It lives in scanner coordinates, a few centimetres
   and degrees away from head coordinates. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, la = MEG.la;
  const DEG = Math.PI / 180;

  /* ---------- the true transform from head to MRI coordinates ---------- */
  const TRUE = { R: MEG.rotXYZ(7, -4, 9), t: [1.3, -2.6, 4.1] };
  const apply = (T, p) => v3.add(MEG.matVec(T.R, p), T.t);
  const invert = T => { const Rt = MEG.mat3T(T.R); return { R: Rt, t: v3.scale(MEG.matVec(Rt, T.t), -1) }; };
  const TRUE_INV = invert(TRUE);

  /* ---------- anatomy, in head coordinates ----------
     The cranium is the head model's sphere; a face and a nose are added
     below the nasion so the image and the digitized head shape look like a
     person.  They are not part of the conductor. */
  const NOSE = { c: [0, 8.8, -5.3], a: [0.9, 1.5, 2.3] };
  const FACE = { c: [0, 3.0, -6.0], a: [5.2, 5.9, 4.6] };
  // The ears, just behind the preauricular points, so the landmarks can be found on the image.
  const EARS = [-1, 1].map(sd => ({ c: [sd * 9.25, -1.7, -3.1], a: [0.75, 1.25, 2.3] }));
  const FID = { NAS: v3.scale(MEG.sph(108, 0), MEG.HEAD.R), LPA: v3.scale(MEG.ELEC.LPA, MEG.HEAD.R), RPA: v3.scale(MEG.ELEC.RPA, MEG.HEAD.R) };
  const inEllipsoid = (p, E) => ((p[0] - E.c[0]) / E.a[0]) ** 2 + ((p[1] - E.c[1]) / E.a[1]) ** 2 + ((p[2] - E.c[2]) / E.a[2]) ** 2;
  /* Sulci as curves on the brain's surface, given as [polar angle from the
     vertex, azimuth from the nose] pairs for the right hemisphere (the left
     is the mirror image), with a depth and a half-width in cm.  They are
     placed around the built-in generators: the hand areas of motor and
     somatosensory cortex face each other across the central sulcus under
     C3 and C4, Heschl's gyrus lies under the Sylvian fissure, and the alpha
     generators sit by the parieto-occipital sulcus. */
  const SULCUS_DEFS = [
    { name: 'central', pts: [[6, 170], [25, 112], [46, 86], [65, 72], [82, 66]], depth: 2.0, w: 0.12 },
    { name: 'precentral', pts: [[18, 70], [30, 80], [46, 68], [65, 58], [82, 52]], depth: 1.2, w: 0.09 },
    { name: 'postcentral', pts: [[25, 150], [30, 138], [46, 100], [65, 88], [82, 81]], depth: 1.2, w: 0.09 },
    { name: 'Sylvian', pts: [[95, 38], [97, 62], [98, 92], [94, 122], [86, 138]], depth: 2.6, w: 0.16 },
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
    // densify every polyline into short arcs
    const dense = [];
    for (let i = 0; i + 1 < pts.length; i++) for (let k = 0; k < 12; k++) dense.push(v3.unit(v3.lerp(pts[i], pts[i + 1], k / 12)));
    dense.push(pts[pts.length - 1]);
    SULCI.push({ name: d.name, side: sd < 0 ? 'left' : 'right', pts, dense, depth: d.depth, w: d.w });
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
  // Deepest sulcus at a direction: depth weighted by distance (on the brain's surface) from its curve.
  function sulcusAt(u) {
    let best = 0, gap = 1e9, which = null;
    SULCI.forEach(s => {
      let dmin = 1e9;
      for (let i = 0; i < s.dense.length; i++) { const q = s.dense[i]; const d = (u[0] - q[0]) ** 2 + (u[1] - q[1]) ** 2 + (u[2] - q[2]) ** 2; if (d < dmin) dmin = d; }
      const dist = Math.sqrt(dmin) * 7.9;
      const depth = s.depth * Math.exp(-0.5 * (dist / (s.w * 6)) ** 2);
      if (depth > best) { best = depth; gap = dist - s.w; which = s; }
    });
    return { depth: best, gap, sulcus: which };
  }
  // Small random folding everywhere else: a cheap smooth noise on the sphere.
  function minorFold(u) {
    return Math.sin(9.1 * u[0] + 2.3) * Math.sin(8.3 * u[1] - 1.1) * Math.sin(7.7 * u[2] + 0.7) + 0.5 * Math.sin(13.7 * u[0] - 5.1 * u[2]) * Math.sin(11.9 * u[1] + 3.3 * u[0]);
  }
  /* The many smaller sulci between the named ones: the zero contours of a
     smooth field on the sphere, about a centimetre deep, so that slices show
     a gyral pattern everywhere and not only at the named sulci. */
  function foldField(u) {
    const [a, b, c] = u;
    return Math.sin(17.3 * a + 4.1 * b + 1.3) * Math.cos(15.1 * b - 3.7 * c + 0.4) +
      0.9 * Math.sin(13.9 * c + 6.2 * a - 2.2) * Math.cos(16.7 * a - 5.3 * c + 1.9) +
      0.6 * Math.sin(21.1 * b + 9.4 * c + 0.3);
  }
  // Heschl's gyrus on each superior temporal plane, with the Sylvian fissure's cleft above it.
  const HESCHL = [[-5.711, -0.902, -1.603], [5.763, -0.404, -1.618]].map(c => ({ c, a: [0.9, 0.45, 0.38] }));
  const CLEFT = HESCHL.map(h => ({ c: v3.add(h.c, [0, 0, 0.56]), a: [1.7, 1.0, 0.13] }));
  const DEEP = {
    ventricles: [{ c: [-0.85, 0.3, 1.0], a: [0.5, 2.8, 0.55] }, { c: [0.85, 0.3, 1.0], a: [0.5, 2.8, 0.55] }],
    thalamus: [{ c: [-1.3, -0.6, -0.05], a: [0.9, 1.5, 0.8] }, { c: [1.3, -0.6, -0.05], a: [0.9, 1.5, 0.8] }],
    basal: [{ c: [-2.4, 1.6, 0.3], a: [0.9, 1.6, 1.3] }, { c: [2.4, 1.6, 0.3], a: [0.9, 1.6, 1.3] }]
  };
  const inAny = (p, list) => list.some(E => inEllipsoid(p, E) < 1);
  // Tissue intensities on the T1-weighted image.
  const T = { air: 0.02, skin: 0.5, fat: 0.88, bone: 0.06, marrow: 0.48, csf: 0.12, grey: 0.45, white: 0.74, deepGrey: 0.55, eye: 0.18, cartilage: 0.6, muscle: 0.36, stem: 0.64 };

  /* ---------- the skull base and what lies below it ----------
     The cranial cavity is the head model's sphere above a floor: the
     anterior fossa under the frontal lobes, the middle fossa under the
     temporal lobes, the sella and clivus in the midline and the posterior
     fossa under the cerebellum.  Below the floor are the orbits, the nasal
     cavity and sinuses, and the muscles of the face and neck.  None of it
     changes the conductor, which stays a sphere: it is there so that the
     slices look like a head. */
  const sstep = (a, b, t) => a + (b - a) * (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  function floorZ(x, y) {
    const ax = Math.abs(x);
    // the sphenoid ridge runs forward and out from the middle; the middle fossa is a bowl behind it
    const ridge = 1.6 + 0.32 * ax, mid = -5.0 + 0.5 * (y / 2.6) ** 2;
    let z = y > ridge ? sstep(mid, -2.75 - 0.25 * Math.exp(-ax * ax), (y - ridge) / 2.2) : y > -2.4 ? mid : sstep(mid, -6.9, (-2.4 - y) / 1.8);
    if (ax < 2.6 && y < 2.6 && y > -3.6) {
      const sel = y > -0.4 ? -3.9 : -3.9 - (-0.4 - y) * 0.95;
      z = Math.max(z, sstep(sel, z, (ax - 1.5) / 1.1));
    }
    return z;
  }
  // The tentorium over the cerebellum: a tent, highest in front by the midbrain and in the midline, lowest at the back of the head.
  const tentZ = (x, y) => -1.15 - 0.33 * Math.max(0, -2 - y) - 0.016 * x * x;
  // The brainstem and spinal cord: leaning back as they descend, the pons bulging forward. 1 inside, 2 in the CSF around it.
  function stemAt(x, y, z) {
    if (z > -0.6) return 0;
    const pons = Math.exp(-0.5 * ((z + 3.0) / 0.9) ** 2), low = MEG.clamp((-z - 5) / 2, 0, 1);
    const ax = 1.15 + 0.35 * pons - 0.25 * low, ay = 1.0 + 0.5 * pons - 0.2 * low;
    const yc = -1.0 + 0.22 * (z + 0.6) + 0.45 * pons;
    const e = (x / ax) ** 2 + ((y - yc) / ay) ** 2;
    return e < 1 ? 1 : e < 1.55 ? 2 : 0;
  }
  const GLOBES = [-1, 1].map(sd => ({ c: [sd * 3.1, 6.55, -4.05], r: 1.1, apex: [sd * 1.3, 3.2, -3.7] }));
  // The eyes, the fat around them and the optic nerves, in their cones of bone.
  function orbitAt(p) {
    for (const g of GLOBES) {
      const d = v3.norm(v3.sub(p, g.c));
      if (d < g.r) return d > g.r - 0.12 ? { v: 0.3, tissue: 'eye', part: 'eye' } : { v: T.eye, tissue: 'eye', part: 'eye' };
      const ax = v3.sub(g.c, g.apex), L = v3.norm(ax), u = v3.scale(ax, 1 / L), q = v3.sub(p, g.apex), t = v3.dot(q, u);
      if (t > 0 && t < L + 0.6) {
        const rad = v3.norm(v3.sub(q, v3.scale(u, t))), lim = 0.35 + 1.55 * Math.min(1, t / L);
        if (rad < 0.22 && t < L - 0.9) return { v: 0.66, tissue: 'optic nerve', part: 'optic nerve' };
        if (rad < lim) return { v: rad > lim - 0.25 ? 0.4 : T.fat, tissue: 'orbit', part: 'orbit' };
      }
    }
    return null;
  }
  const SINUS = {
    sphenoid: { c: [0, 1.25, -4.85], a: [1.35, 0.95, 0.75] },
    maxillary: [-1, 1].map(sd => ({ c: [sd * 2.85, 5.0, -6.1], a: [1.15, 1.75, 1.05] }))
  };
  const MUSCLE = { v: T.muscle, tissue: 'muscle', part: 'muscles of the face and neck' };
  const CSF = { v: T.csf, tissue: 'CSF', part: 'CSF' };
  // Below the floor of the skull, inside the head.
  function underFloor(x, y, z, fz) {
    const ax = Math.abs(x);
    if (z > fz - 0.55) { const k = (fz - z) / 0.55; return { v: k > 0.3 && k < 0.7 ? T.marrow : T.bone, tissue: 'skull', part: 'skull base' }; }
    const P = [x, y, z];
    if (inEllipsoid(P, SINUS.sphenoid) < 1) return { v: T.air, tissue: 'air', part: 'sphenoid sinus' };
    // the nasal cavity: an elliptic tube from the choanae to the nostrils, the septum down its middle, turbinates on its walls
    const nc = (x / 1.35) ** 2 + ((z + 5.3) / 2.0) ** 2;
    if (nc < 1 && y > 1.8 && y < 9) {
      if (ax < 0.12) return { v: 0.42, tissue: 'cartilage', part: 'nasal septum' };
      if (nc > 0.45 && ax > 0.55 && Math.sin(4.2 * z + 1.1) > 0.35) return { v: 0.4, tissue: 'mucosa', part: 'nasal turbinate' };
      return { v: T.air, tissue: 'air', part: 'nasal cavity' };
    }
    if (inAny(P, SINUS.maxillary)) return { v: T.air, tissue: 'air', part: 'maxillary sinus' };
    if ((x / 1.0) ** 2 + ((y - 0.4) / 0.75) ** 2 < 1 && z < -6.1) return { v: T.air, tissue: 'air', part: 'pharynx' };
    if (ax > 6.0 && y > -3.2 && y < -0.8 && z > -6.3 && z < -3.8) return { v: Math.sin(9 * x) * Math.sin(9 * y) > 0.2 ? T.air : T.bone, tissue: 'bone', part: 'mastoid air cells' };
    if (ax > 1.4 && ax < 2.6 && y > -0.4 && y < 2.2 && z < -6.0) return { v: T.fat, tissue: 'fat', part: 'parapharyngeal fat' };
    return MUSCLE;
  }
  // The cerebellum: folia around a white core, the vermis between the hemispheres, the fourth ventricle in front.
  function cerebellum(x, y, z, r, fz, zt) {
    if (r > 7.85 || z > zt - 0.18 || z < fz + 0.25) return { v: T.csf, tissue: 'CSF', part: 'CSF' };
    if (Math.abs(x) < 0.6 && y > -3.1 && z > -4.6 && z < -2.4) return { v: T.csf, tissue: 'CSF', part: 'fourth ventricle' };
    const name = Math.abs(x) < 0.9 ? 'vermis of the cerebellum' : 'cerebellum';
    // the arbor vitae: white matter fanning out from the roof of the fourth ventricle, folia of cortex between its branches
    const dy = y + 3.0, dz = z + 3.6, rad = Math.hypot(dy, dz) + 0.25 * Math.abs(x) / 3, ang = Math.atan2(dz, dy);
    const ray = Math.abs(Math.sin(7.5 * ang + 0.5 * Math.sin(1.7 * rad + x)));
    if (rad < 1.3 || (ray < 0.2 * (1 - rad / 5.2) && rad < 4.2)) return { v: T.white, tissue: 'white matter', part: name };
    return { v: Math.sin(19 * rad + 3 * ang) > 0.55 ? 0.38 : 0.48, tissue: 'grey matter', part: name };
  }

  /* The tissue at a head-frame point: its T1 intensity (air dark, scalp
     fat bright, skull dark with brighter marrow, CSF dark, grey matter mid,
     white matter bright), what it is, and, outside the cerebrum, the name
     of the structure. */
  function anat(p) {
    const r = v3.norm(p), x = p[0], y = p[1], z = p[2], u = r > 1e-9 ? v3.scale(p, 1 / r) : [0, 0, 1];
    if (r > MEG.HEAD.R) {
      const n = inEllipsoid(p, NOSE), f = inEllipsoid(p, FACE);
      if (n < 1) return { v: n > 0.72 ? T.skin : T.cartilage, tissue: 'skin and soft tissue', part: 'the nose' };
      if (f < 1) return { v: f > 0.88 ? T.skin : (f > 0.5 ? T.fat : T.muscle), tissue: 'skin and soft tissue', part: 'the face' };
      for (const E of EARS) { const e = inEllipsoid(p, E); if (e < 1) return { v: e > 0.55 ? T.skin : T.cartilage, tissue: 'skin and soft tissue', part: x < 0 ? 'the left ear' : 'the right ear' }; }
      return { v: T.air, tissue: 'air', part: 'outside the head' };
    }
    const o = orbitAt(p); if (o) return o;
    const fz = floorZ(x, y);
    if (r > 9.05) return { v: T.skin, tissue: 'scalp', part: 'scalp' };
    if (r > 8.75) return { v: T.fat, tissue: 'scalp', part: 'scalp' };
    if (r > 8.2) {
      if (z > fz - 0.4) { const k = (r - 8.2) / 0.55; return { v: k > 0.3 && k < 0.7 ? T.marrow : T.bone, tissue: 'skull', part: 'skull' }; }
      return y > 4.5 ? { v: T.bone, tissue: 'skull', part: 'facial bones' } : MUSCLE;
    }
    const sa = stemAt(x, y, z);
    if (z < fz) {
      if (sa === 1) return { v: T.stem, tissue: 'white matter', part: z < -7 ? 'spinal cord' : 'brainstem' };
      if (sa === 2) return CSF;
      return underFloor(x, y, z, fz);
    }
    // the cranial cavity
    if (sa === 1) return { v: T.stem, tissue: 'white matter', part: z > -1.6 ? 'midbrain' : z > -4.2 ? 'pons' : 'medulla' };
    if (sa === 2) return { v: T.csf, tissue: 'CSF', part: 'cistern around the brainstem' };
    if (z < fz + 0.2) return CSF;
    const zt = tentZ(x, y);
    if (y < -2.0 && z < zt) return cerebellum(x, y, z, r, fz, zt);
    if (Math.abs(x) < 1.6 && y > -0.4 && y < 2.4 && z < -2.6) return { v: T.csf, tissue: 'CSF', part: 'suprasellar cistern' };
    // the cerebrum
    const grey = { v: T.grey, tissue: 'grey matter', part: null }, white = { v: T.white, tissue: 'white matter', part: null };
    // the corpus callosum: an arch of white matter over the ventricles, thicker at its two ends
    const arch = Math.hypot(y / 3.0, (z - 0.55) / 1.35);
    if (Math.abs(x) < 1.6 && z > 0.45 && Math.abs(arch - 1) < 0.075 + 0.05 * Math.abs(y) / 3) return { v: 0.8, tissue: 'white matter', part: 'corpus callosum' };
    if (Math.abs(x) < 0.12 && arch > 1 && r > 2.5) return CSF;               // the fissure between the hemispheres
    if (Math.abs(x) < 0.42 && arch > 1 && r > 2.5) return grey;              // the medial cortex, cingulate gyrus first
    const surf = 7.9 + 0.12 * minorFold(u);
    if (r > surf) return CSF;                                                 // CSF over the brain
    if (inAny(p, CLEFT)) return CSF;
    if (inAny(p, HESCHL)) return grey;
    const sc = sulcusAt(u);
    const bottom = surf - sc.depth;
    if (sc.depth > 0.25 && r > bottom && sc.gap < 0) return CSF;              // inside a sulcus
    if (surf - r < 0.3 || z < fz + 0.5 || (y < -2.0 && z < zt + 0.35)) return grey;  // cortex under every surface
    if (sc.depth > 0.25 && r > bottom - 0.3 && sc.gap < 0.35) return grey;     // cortex lining the sulcus
    // minor sulci lean and curve as they go down, and narrow toward their floor
    const dd = surf - r, bend = [Math.sin(3.1 * u[1] + 1.7 * u[2]), Math.sin(2.7 * u[2] - 2.3 * u[0]), Math.sin(2.9 * u[0] + 1.3 * u[1])];
    const mf = Math.abs(foldField(v3.unit(v3.add(u, v3.scale(bend, 0.035 * dd + 0.012 * dd * dd))))), md = 0.95 + 0.3 * minorFold(v3.scale(u, 1.7));
    if (dd < md && mf < 0.2 - 0.12 * dd / md) return CSF;                       // a minor sulcus
    if (dd < md + 0.28 && mf < 0.62) return grey;                               // and its cortex
    if (inAny(p, DEEP.ventricles)) return { v: T.csf + 0.02, tissue: 'CSF', part: null };
    if (inAny(p, DEEP.thalamus) || inAny(p, DEEP.basal)) return { v: T.deepGrey, tissue: 'grey matter', part: null };
    return white;
  }
  const t1 = p => anat(p).v;
  // A little texture so the image does not look computer-drawn.
  function grain(p) {
    const h = Math.sin(p[0] * 127.1 + p[1] * 311.7 + p[2] * 74.7) * 43758.5453;
    return (h - Math.floor(h) - 0.5) * 0.06;
  }

  /* One slice of the MRI in scanner coordinates.  plane: 'axial' (z fixed),
     'coronal' (y fixed) or 'sagittal' (x fixed); `at` is the fixed MRI
     coordinate; the image covers +-half cm around the head's centre.
     Axial and coronal slices follow the neurological convention (left on
     the left); sagittal slices put the face on the left. */
  function slice(plane, at, res, half, centre) {
    const c = centre || apply(TRUE, [0, 0, 0]);
    const img = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const a = -half + (i + 0.5) / res * 2 * half, b = half - (j + 0.5) / res * 2 * half;
      let m;
      if (plane === 'axial') m = [c[0] + a, c[1] + b, at];
      else if (plane === 'coronal') m = [c[0] + a, at, c[2] + b];
      else m = [at, c[1] - a, c[2] + b];                       // anterior to the left
      const p = apply(TRUE_INV, m);
      img[j * res + i] = MEG.clamp(t1(p) + grain(p), 0, 1);
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

  /* ---------- the head surface and the digitizer ---------- */
  // Nearest point on the skin (the cranium's sphere, the face and the nose) to a head-frame point.
  function nearestScalp(q) {
    const R = MEG.HEAD.R;
    const onE = E => {
      const d = v3.sub(q, E.c);
      const k = 1 / Math.sqrt((d[0] / E.a[0]) ** 2 + (d[1] / E.a[1]) ** 2 + (d[2] / E.a[2]) ** 2);
      return v3.add(E.c, v3.scale(d, k));
    };
    const s = v3.scale(v3.unit(q), R), n = onE(NOSE), f = onE(FACE);
    const cands = [];
    if (inEllipsoid(s, NOSE) >= 0.98 && inEllipsoid(s, FACE) >= 0.98) cands.push(s);
    if (v3.norm(n) >= R - 0.02 && inEllipsoid(n, FACE) >= 0.98) cands.push(n);
    if (v3.norm(f) >= R - 0.02 && inEllipsoid(f, NOSE) >= 0.98) cands.push(f);
    if (!cands.length) cands.push(s);
    cands.sort((a, b) => v3.norm(v3.sub(a, q)) - v3.norm(v3.sub(b, q)));
    return cands[0];
  }
  function digitize(seed, opts) {
    opts = opts || {};
    const st = MEG.stream(seed || 1, 'digitizer'), noise = opts.noise === undefined ? 0.1 : opts.noise;
    const jit = p => v3.add(p, [noise * st.gauss(), noise * st.gauss(), noise * st.gauss()]);
    const pts = [];
    // over the scalp: above the ears, leaving the face
    MEG.fibonacciSphere(400).forEach(u => {
      if (u[2] < -0.15) return;
      if (u[1] > 0.55 && u[2] < 0.35) return;
      if (pts.length < (opts.scalp || 110) && st.next() < 0.45) pts.push(jit(v3.scale(u, MEG.HEAD.R)));
    });
    // along the nose and brow
    if (opts.nose !== false) for (let k = 0; k < 24; k++) {
      const z = -2.6 - 4.5 * k / 23, x = (k % 3 - 1) * 0.55;
      const p = nearestScalp([x, 14, z]);
      pts.push(jit(p));
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
    if (r > MEG.HEAD.R) return a.part;
    if (a.part === 'scalp' || a.part === 'skull') return a.part;
    if (r > 8.0 && a.tissue === 'CSF' && !a.part) return 'CSF, outside the brain';
    if (a.part) {
      const sided = ['eye', 'orbit', 'optic nerve', 'maxillary sinus', 'mastoid air cells', 'cerebellum', 'parapharyngeal fat'];
      return sided.includes(a.part) ? `${side === 'midline:' ? 'midline' : side} ${a.part}` : a.part;
    }
    const th = Math.acos(MEG.clamp(u[2], -1, 1)) / DEG, aa = Math.abs(az);
    if (inAny(p, HESCHL)) return `${side} Heschl’s gyrus (primary auditory cortex)`;
    if (inAny(p, DEEP.ventricles)) return `${side} lateral ventricle`;
    if (inAny(p, DEEP.thalamus)) return `${side} thalamus`;
    if (inAny(p, DEEP.basal)) return `${side} basal ganglia`;
    if (r < 3.4) return 'deep white matter, near the midline';
    if (th < 10) return `${side} paracentral lobule`;
    let region;
    const thS = crossing('Sylvian', aa, 'az'), thSTS = crossing('superior temporal', aa, 'az'), thITS = crossing('inferior temporal', aa, 'az');
    if (aa > 148 || (aa > 132 && th > 84)) {
      region = Math.abs(p[0]) > 2.4 ? 'lateral occipital cortex' : th > 84 ? 'calcarine cortex (primary visual)' : 'cuneus, by the parieto-occipital sulcus';
    } else if (th > thS && aa > 32) {
      if (r < 5.4 && th < thS + 10 && aa < 120) region = 'insula';
      else region = th < thSTS ? 'superior temporal gyrus' : th < thITS ? 'middle temporal gyrus' : 'inferior temporal gyrus';
    } else if (r < 5.4 && th > thS - 12 && aa > 32 && aa < 120) {
      region = 'insula';
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

  MEG.mri = { TRUE, TRUE_INV, apply, invert, t1, anat, floorZ, slice, slicePixel, nearestScalp, digitize, rigid, coregister, errorAt, surfaceFit, label, tissue, FID, NOSE, FACE, SULCI };
})(typeof window !== 'undefined' ? window : globalThis);
