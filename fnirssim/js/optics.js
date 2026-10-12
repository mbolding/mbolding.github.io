/* fNIRS simulator: optics.

   Everything about light in the head that the rest of the simulator needs:

   - absorption spectra of oxy- and deoxyhaemoglobin (Prahl's tabulation of
     Gratzer and Kollias) and of water (Hale and Querry, Kou and colleagues),
     600 to 1000 nm;
   - five tissue types and the head models built from them (adult, adult
     with a thick skull, infant), each a stack of flat layers;
   - a finite-volume solution of the diffusion equation for a point source
     on the surface of the layered half-space.  The geometry is
     axisymmetric, so one solve per wavelength gives the fluence G(r, z)
     everywhere, and by reciprocity the sensitivity of every
     source-detector pair:  J(x) = G(|x - s|) G(|x - d|) / G(|d - s|).
     Its integral over a layer is that layer's mean partial pathlength,
     the quantity the modified Beer-Lambert law silently assumes;
   - analytic results for a homogeneous half-space (continuous wave,
     frequency domain and time domain) for the instrument comparisons;
   - the modified Beer-Lambert law itself.

   Lengths are in cm, absorption and scattering coefficients in 1/cm,
   haemoglobin concentrations in micromolar. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;
  const LN10 = Math.LN10;

  /* ---------- haemoglobin extinction, cm^-1 / M (decadic) ----------
     Scott Prahl's compilation.  10 nm steps below 650 and above 900 nm,
     2 nm steps in between. */
  const EXT_COARSE_LO = [[600, 3200, 14677.2], [610, 1506, 9443.6], [620, 942, 6509.6], [630, 610, 5148.8], [640, 442, 4345.2]];
  const EXT_FINE = [
    [368, 3750.12], [356.8, 3642.64], [345.6, 3535.16], [335.2, 3427.68], [325.6, 3320.2], [319.6, 3226.56],
    [314, 3140.28], [308.4, 3053.96], [302.8, 2967.68], [298, 2881.4], [294, 2795.12], [290, 2708.84],
    [285.6, 2627.64], [282, 2554.4], [279.2, 2481.16], [277.6, 2407.92], [276, 2334.68], [274.4, 2261.48],
    [272.8, 2188.24], [274.4, 2115], [276, 2051.96], [277.6, 2000.48], [279.2, 1949.04], [282, 1897.56],
    [286, 1846.08], [290, 1794.28], [294, 1741], [298, 1687.76], [302.8, 1634.48], [308.4, 1583.52],
    [314, 1540.48], [319.6, 1497.4], [325.2, 1454.36], [332, 1411.32], [340, 1368.28], [348, 1325.88],
    [356, 1285.16], [364, 1244.44], [372.4, 1203.68], [381.2, 1152.8], [390, 1102.2], [398.8, 1102.2],
    [407.6, 1102.2], [418.8, 1101.76], [432.4, 1100.48], [446, 1115.88], [459.6, 1161.64], [473.2, 1207.4],
    [487.6, 1266.04], [502.8, 1333.24], [518, 1405.24], [533.2, 1515.32], [548.4, 1541.76], [562, 1560.48],
    [574, 1560.48], [586, 1548.52], [598, 1508.44], [610, 1459.56], [622.8, 1410.52], [636.4, 1361.32],
    [650, 1311.88], [663.6, 1262.44], [677.2, 1213], [689.2, 1163.56], [699.6, 1114.8], [710, 1075.44],
    [720.4, 1036.08], [730.8, 996.72], [740, 957.36], [748, 921.8], [756, 890.8], [764, 859.8],
    [772, 828.8], [786.4, 802.96], [807.2, 782.36], [816, 761.72], [828, 743.84], [836, 737.08],
    [844, 730.28], [856, 723.52], [864, 717.08], [872, 711.84], [880, 706.6], [887.2, 701.32],
    [901.6, 696.08], [916, 693.76], [930.4, 693.6], [944.8, 693.48], [956.4, 693.32], [965.2, 693.2],
    [974, 693.04], [982.8, 692.92], [991.6, 692.76], [1001.2, 692.64], [1011.6, 692.48], [1022, 692.36],
    [1032.4, 692.2], [1042.8, 691.96], [1050, 691.76], [1054, 691.52], [1058, 691.32], [1062, 691.08],
    [1066, 690.88], [1072.8, 690.64], [1082.4, 692.44], [1092, 694.32], [1101.6, 696.2], [1111.2, 698.04],
    [1118.4, 699.92], [1123.2, 701.8], [1128, 705.84], [1132.8, 709.96], [1137.6, 714.08], [1142.8, 718.2],
    [1148.4, 722.32], [1154, 726.44], [1159.6, 729.84], [1165.2, 733.2], [1170, 736.6], [1174, 739.96],
    [1178, 743.6], [1182, 747.24], [1186, 750.88], [1190, 754.52], [1194, 758.16], [1198, 761.84]
  ];
  const EXT_COARSE_HI = [[910, 1214, 774.56], [920, 1224, 777.36], [930, 1222, 763.84], [940, 1214, 693.44], [950, 1204, 602.24],
    [960, 1186, 525.56], [970, 1162, 429.32], [980, 1128, 359.656], [990, 1080, 283.22], [1000, 1024, 206.784]];
  const EXT = EXT_COARSE_LO.concat(EXT_FINE.map((e, i) => [650 + 2 * i, e[0], e[1]]), EXT_COARSE_HI);
  const EXT_NM = Float64Array.from(EXT, e => e[0]);
  const EXT_LO = Float64Array.from(EXT, e => Math.log(e[1]));
  const EXT_LR = Float64Array.from(EXT, e => Math.log(e[2]));
  NIRS.LAMBDA_RANGE = [600, 1000];

  function locate(xs, x) {
    if (x <= xs[0]) return [0, 0];
    const n = xs.length;
    if (x >= xs[n - 1]) return [n - 2, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    return [lo, (x - xs[lo]) / (xs[lo + 1] - xs[lo])];
  }
  // Interpolated in log space, where the spectra are smooth.
  NIRS.ext = function (nm) {
    const [i, f] = locate(EXT_NM, nm);
    return [Math.exp(EXT_LO[i] + f * (EXT_LO[i + 1] - EXT_LO[i])), Math.exp(EXT_LR[i] + f * (EXT_LR[i + 1] - EXT_LR[i]))];
  };
  // Where the two spectra cross in the near infrared (the isosbestic point).
  NIRS.ISOSBESTIC = (() => {
    for (let nm = 700; nm < 900; nm += 0.1) {
      const a = NIRS.ext(nm), b = NIRS.ext(nm + 0.1);
      if ((a[0] - a[1]) * (b[0] - b[1]) <= 0) return Math.round((nm + 0.05) * 10) / 10;
    }
    return 800;
  })();

  /* ---------- water absorption, 1/cm ---------- */
  const WATER = [[600, 0.0023], [620, 0.0028], [640, 0.0031], [660, 0.0036], [680, 0.0045], [700, 0.0060], [720, 0.0105],
    [730, 0.0165], [740, 0.0251], [750, 0.0261], [760, 0.0256], [770, 0.0242], [780, 0.0223], [790, 0.0204], [800, 0.0196],
    [810, 0.0211], [820, 0.0257], [830, 0.0294], [840, 0.0360], [850, 0.0433], [860, 0.0461], [870, 0.0494], [880, 0.0545],
    [890, 0.0610], [900, 0.0679], [910, 0.0820], [920, 0.1100], [930, 0.1700], [940, 0.2700], [950, 0.3700], [960, 0.4200],
    [970, 0.4500], [980, 0.4400], [990, 0.4000], [1000, 0.3600]];
  const W_NM = Float64Array.from(WATER, w => w[0]), W_L = Float64Array.from(WATER, w => Math.log(w[1]));
  NIRS.waterMua = function (nm) { const [i, f] = locate(W_NM, nm); return Math.exp(W_L[i] + f * (W_L[i + 1] - W_L[i])); };
  // Melanin (hair and skin pigment), relative to its value at 700 nm.
  NIRS.melanin = nm => Math.pow(nm / 700, -3.46);

  /* ---------- tissues ----------
     Composition at rest.  hbo and hbr in µM, water as a volume fraction,
     `other` a weakly wavelength-dependent background absorber (lipid,
     cytochromes, bone mineral) in 1/cm at 800 nm.  Reduced scattering
     follows a power law mus'(l) = musp (l / 800 nm)^-b.  The values sit
     between the adult head models of Okada, Strangman and Fukui at 800 nm
     and give differential pathlength factors near the measured 6 to 7. */
  const TISSUES = {
    scalp: { label: 'Scalp', hbo: 30, hbr: 12, water: 0.60, other: 0.09, musp: 12, b: 1.2 },
    skull: { label: 'Skull', hbo: 14, hbr: 6, water: 0.20, other: 0.11, musp: 12.5, b: 1.0 },
    csf: { label: 'CSF', hbo: 0, hbr: 0, water: 0.99, other: 0.012, musp: 2.4, b: 0.5 },
    gray: { label: 'Gray matter', hbo: 55, hbr: 25, water: 0.80, other: 0.03, musp: 15, b: 1.2 },
    white: { label: 'White matter', hbo: 20, hbr: 10, water: 0.70, other: 0.07, musp: 50, b: 1.1 }
  };
  NIRS.TISSUES = TISSUES;
  NIRS.LAYER_ORDER = ['scalp', 'skull', 'csf', 'gray', 'white'];

  /* Head models.  Thicknesses in cm; white matter fills the rest.  The
     infant has a thin, less mineralized skull, little CSF and unmyelinated
     (much less scattering) white matter. */
  const HEADS = {
    adult: {
      label: 'Adult', radius: 9.0, age: 30,
      thick: { scalp: 0.5, skull: 0.7, csf: 0.2, gray: 0.4 }, tissue: {}
    },
    thick: {
      label: 'Adult with a thick skull', radius: 9.4, age: 45,
      thick: { scalp: 0.6, skull: 1.1, csf: 0.25, gray: 0.4 }, tissue: { skull: { musp: 13.5 } }
    },
    infant: {
      label: 'Infant (6 months)', radius: 6.5, age: 0.5,
      thick: { scalp: 0.2, skull: 0.2, csf: 0.15, gray: 0.3 },
      tissue: {
        scalp: { hbo: 22, hbr: 9, water: 0.75 }, skull: { musp: 9, water: 0.45, other: 0.05 },
        gray: { hbo: 34, hbr: 17, water: 0.90, musp: 9 }, white: { hbo: 22, hbr: 12, water: 0.92, musp: 8, other: 0.03 }
      }
    }
  };
  NIRS.HEADS = HEADS;

  /* Hair between the optode and the scalp.  `couple` is the mean fraction
     of light that gets through the interface at each optode, `spread` how
     much it varies from optode to optode, and `melanin` the optical depth
     of pigment at 700 nm, which costs more light at short wavelengths. */
  const HAIR = {
    none: { label: 'No hair (forehead) or well parted', couple: 0.85, spread: 0.10, melanin: 0 },
    light: { label: 'Light, sparse hair', couple: 0.65, spread: 0.25, melanin: 0.08 },
    dense: { label: 'Dense hair', couple: 0.5, spread: 0.45, melanin: 0.15 },
    dark: { label: 'Dense, dark hair', couple: 0.42, spread: 0.6, melanin: 0.55 }
  };
  NIRS.HAIR = HAIR;

  // Absorption and reduced scattering of a tissue at a wavelength.
  NIRS.tissueMua = function (t, nm) {
    const [eo, er] = NIRS.ext(nm);
    return LN10 * 1e-6 * (eo * t.hbo + er * t.hbr) + t.water * NIRS.waterMua(nm) + t.other * Math.pow(nm / 800, -1);
  };
  NIRS.tissueMusp = (t, nm) => t.musp * Math.pow(nm / 800, -t.b);

  /* The layer stack for a head model at one wavelength, with any overrides
     from the program: { thick: {scalp: cm...}, tissue: {gray: {...}} }. */
  NIRS.headLayers = function (headName, over) {
    const H = HEADS[headName] || HEADS.adult;
    over = over || {};
    const thick = Object.assign({}, H.thick, over.thick || {});
    let z = 0;
    return NIRS.LAYER_ORDER.map(k => {
      const t = Object.assign({}, TISSUES[k], H.tissue[k] || {}, (over.tissue || {})[k] || {});
      const d = k === 'white' ? Infinity : thick[k];
      const layer = { key: k, label: TISSUES[k].label, tissue: t, z0: z, z1: z + d, d };
      z += d;
      return layer;
    });
  };
  NIRS.opticalLayers = function (layers, nm) {
    return layers.map(L => ({ key: L.key, z0: L.z0, z1: L.z1, mua: NIRS.tissueMua(L.tissue, nm), musp: NIRS.tissueMusp(L.tissue, nm) }));
  };
  NIRS.brainTop = layers => layers.find(L => L.key === 'gray').z0;

  /* ---------- boundary ----------
     Effective reflection coefficient of a tissue-air boundary (Groenhuis),
     and the coefficient A in the partial-current boundary condition. */
  const N_TISSUE = 1.4;
  const R_EFF = -1.440 / (N_TISSUE * N_TISSUE) + 0.710 / N_TISSUE + 0.668 + 0.0636 * N_TISSUE;
  const A_BC = (1 + R_EFF) / (1 - R_EFF);
  NIRS.A_BC = A_BC;
  NIRS.C_TISSUE = 29.9792458 / N_TISSUE;   // speed of light in tissue, cm/ns

  /* ---------- diffusion in a layered half-space ----------
     Cylindrical cells (r outward from the source, z down from the
     surface), finite volumes with harmonic-mean diffusion coefficients on
     the faces, the partial-current condition at the surface and zero
     fluence on the far boundaries.  The matrix is symmetric, positive
     definite and banded (bandwidth Nz), so a banded Cholesky
     factorization solves it directly. */
  const GRID = { dr: 0.05, dz: 0.05, Nr: 132, Nz: 84 };
  NIRS.GRID = GRID;
  const fluenceCache = new Map();

  NIRS.fluence = function (optLayers, opts) {
    opts = opts || {};
    const g = Object.assign({}, GRID, opts.grid || {});
    const key = JSON.stringify([g, optLayers.map(L => [L.z0, L.z1 === Infinity ? 99 : L.z1, +L.mua.toPrecision(6), +L.musp.toPrecision(6)])]);
    if (!opts.noCache && fluenceCache.has(key)) return fluenceCache.get(key);
    const { dr, dz, Nr, Nz } = g;
    const N = Nr * Nz, bw = Nz, W = bw + 1;
    // per-depth optical properties, volume averaged across interfaces
    const muaZ = new Float64Array(Nz), DZ = new Float64Array(Nz), layerFrac = optLayers.map(() => new Float64Array(Nz));
    for (let j = 0; j < Nz; j++) {
      const a = j * dz, b = (j + 1) * dz;
      let sMua = 0, sRes = 0;
      optLayers.forEach((L, li) => {
        const o = Math.max(0, Math.min(b, L.z1) - Math.max(a, L.z0));
        if (o <= 0) return;
        layerFrac[li][j] = o / dz;
        sMua += L.mua * o;
        sRes += o * 3 * (L.mua + L.musp);    // resistance to diffusion, 1/D per unit length
      });
      muaZ[j] = sMua / dz;
      DZ[j] = dz / sRes;
    }
    const Ab = new Float64Array(N * W);       // Ab[k*W + m] = A(k, k-m)
    const addDiag = (k, v) => { Ab[k * W] += v; };
    for (let i = 0; i < Nr; i++) {
      const Az = Math.PI * (2 * i + 1) * dr * dr;          // area of the top or bottom face of ring i
      const V = Az * dz;
      const Ar = 2 * Math.PI * (i + 1) * dr * dz;          // area of the outer face of ring i
      for (let j = 0; j < Nz; j++) {
        const k = i * Nz + j;
        addDiag(k, muaZ[j] * V);
        // outer radial face
        if (i < Nr - 1) {
          const c = Ar * DZ[j] / dr;
          addDiag(k, c); addDiag(k + Nz, c);
          Ab[(k + Nz) * W + Nz] -= c;
        } else addDiag(k, Ar * DZ[j] / (dr / 2));
        // lower face
        if (j < Nz - 1) {
          const Df = 2 * DZ[j] * DZ[j + 1] / (DZ[j] + DZ[j + 1]);
          const c = Az * Df / dz;
          addDiag(k, c); addDiag(k + 1, c);
          Ab[(k + 1) * W + 1] -= c;
        } else addDiag(k, Az * DZ[j] / (dz / 2));
        if (j === 0) addDiag(k, Az / (dz / (2 * DZ[0]) + 2 * A_BC));
      }
    }
    // banded Cholesky, in place: L(k, k-m) stored at Ab[k*W + m]
    for (let k = 0; k < N; k++) {
      const p0 = Math.max(0, k - bw), kW = k * W;
      for (let p = p0; p < k; p++) {
        const pW = p * W;
        let s = Ab[kW + k - p];
        // q runs from p0 (p0 >= p - bw always holds here) up to p - 1
        let a = kW + k - p0, b = pW + p - p0;
        for (let q = p0; q < p; q++, a--, b--) s -= Ab[a] * Ab[b];
        Ab[kW + k - p] = s / Ab[pW];
      }
      let s = Ab[kW];
      for (let q = p0; q < k; q++) { const l = Ab[kW + k - q]; s -= l * l; }
      Ab[kW] = Math.sqrt(s);
    }
    // isotropic point source one transport length below the surface, on the axis
    const musp0 = optLayers[0].musp;
    const j0 = Math.min(Nz - 1, Math.floor((1 / musp0) / dz));
    const x = new Float64Array(N);
    x[j0] = 1;
    for (let k = 0; k < N; k++) {           // forward: L y = b
      let s = x[k];
      const p0 = Math.max(0, k - bw);
      for (let p = p0; p < k; p++) s -= Ab[k * W + (k - p)] * x[p];
      x[k] = s / Ab[k * W];
    }
    for (let k = N - 1; k >= 0; k--) {      // back: L^T x = y
      let s = x[k];
      const p1 = Math.min(N - 1, k + bw);
      for (let p = k + 1; p <= p1; p++) s -= Ab[p * W + (p - k)] * x[p];
      x[k] = s / Ab[k * W];
    }
    // surface reflectance: the outward partial current at each radius
    const refl = new Float64Array(Nr), cTop = 1 / (dz / (2 * DZ[0]) + 2 * A_BC);
    for (let i = 0; i < Nr; i++) refl[i] = Math.max(1e-300, x[i * Nz] * cTop);
    for (let k = 0; k < N; k++) if (!(x[k] > 1e-300)) x[k] = 1e-300;
    const sol = { G: x, refl, Nr, Nz, dr, dz, j0, layerFrac, layers: optLayers, muaZ, DZ };
    if (!opts.noCache) {
      if (fluenceCache.size > 40) fluenceCache.delete(fluenceCache.keys().next().value);
      fluenceCache.set(key, sol);
    }
    return sol;
  };

  // Fluence at radius r in depth cell j (linear in r between cell centres).
  function Gat(sol, r, j) {
    const t = r / sol.dr - 0.5;
    if (t <= 0) return sol.G[j];
    const i = Math.floor(t);
    if (i >= sol.Nr - 1) return 0;
    const f = t - i;
    return (1 - f) * sol.G[i * sol.Nz + j] + f * sol.G[(i + 1) * sol.Nz + j];
  }
  NIRS.Gat = Gat;
  // Diffuse reflectance (per cm^2 of detector, per unit source power), log-interpolated.
  NIRS.reflectance = function (sol, rho) {
    const t = rho / sol.dr - 0.5;
    if (t <= 0) return sol.refl[0];
    const i = Math.min(sol.Nr - 2, Math.floor(t)), f = t - i;
    return Math.exp((1 - f) * Math.log(sol.refl[i]) + f * Math.log(sol.refl[i + 1]));
  };

  /* Partial pathlengths of one source-detector separation.  Integrates the
     sensitivity over the half-space on a grid of the cell size, using the
     symmetry about the source-detector axis.  Returns the mean pathlength
     in each layer, per depth cell, and the total. */
  const pathCache = new Map();
  NIRS.pathlengths = function (sol, rho) {
    const key = sol.G.length + '|' + rho.toFixed(4);
    let byRho = pathCache.get(sol);
    if (!byRho) { byRho = new Map(); pathCache.set(sol, byRho); }
    if (byRho.has(key)) return byRho.get(key);
    const h = sol.dr, Wd = Math.min(2.6, sol.Nr * sol.dr - rho / 2 - 0.2);
    const nx = Math.ceil((rho + 2 * Wd) / h), ny = Math.ceil(Wd / h);
    const xs0 = -rho / 2 - Wd;
    const Nz = sol.Nz, npt = nx * ny;
    const i1 = new Int32Array(npt), f1 = new Float64Array(npt), i2 = new Int32Array(npt), f2 = new Float64Array(npt);
    const prep = (r, idx, ia, fa) => {
      const t = r / sol.dr - 0.5;
      if (t <= 0) { ia[idx] = 0; fa[idx] = 0; return; }
      const i = Math.floor(t);
      if (i >= sol.Nr - 1) { ia[idx] = -1; return; }
      ia[idx] = i; fa[idx] = t - i;
    };
    let p = 0;
    for (let a = 0; a < nx; a++) {
      const x = xs0 + (a + 0.5) * h;
      for (let b = 0; b < ny; b++, p++) {
        const y = (b + 0.5) * h;
        prep(Math.sqrt((x + rho / 2) * (x + rho / 2) + y * y), p, i1, f1);
        prep(Math.sqrt((x - rho / 2) * (x - rho / 2) + y * y), p, i2, f2);
      }
    }
    const Gd = Gat(sol, rho, sol.j0);
    const dV = 2 * h * h * sol.dz;
    const depth = new Float64Array(Nz);
    const G = sol.G;
    for (let j = 0; j < Nz; j++) {
      let s = 0;
      for (let q = 0; q < npt; q++) {
        const ia = i1[q], ib = i2[q];
        if (ia < 0 || ib < 0) continue;
        const fa = f1[q], fb = f2[q];
        const g1 = (1 - fa) * G[ia * Nz + j] + fa * G[(ia + 1) * Nz + j];
        const g2 = (1 - fb) * G[ib * Nz + j] + fb * G[(ib + 1) * Nz + j];
        s += g1 * g2;
      }
      depth[j] = s * dV / Gd;
    }
    const layers = sol.layers.map((L, li) => { let s = 0; for (let j = 0; j < Nz; j++) s += depth[j] * sol.layerFrac[li][j]; return s; });
    let total = 0; for (let j = 0; j < Nz; j++) total += depth[j];
    const out = { rho, total, layers, depth, dpf: total / rho, R: NIRS.reflectance(sol, rho) };
    byRho.set(key, out);
    return out;
  };

  /* Sensitivity in the plane through the source and detector (y = 0),
     on an nx-by-nz grid covering x0..x1 and 0..zmax. */
  NIRS.sensitivityPlane = function (sol, rho, x0, x1, nx, zmax, nzOut) {
    const nz = nzOut || Math.min(sol.Nz, Math.round(zmax / sol.dz));
    const out = new Float32Array(nx * nz);
    const Gd = Gat(sol, rho, sol.j0);
    for (let a = 0; a < nx; a++) {
      const x = x0 + (a + 0.5) * (x1 - x0) / nx;
      for (let b = 0; b < nz; b++) {
        const z = (b + 0.5) * zmax / nz;
        const j = Math.min(sol.Nz - 1, Math.floor(z / sol.dz));
        out[b * nx + a] = Gat(sol, Math.abs(x + rho / 2), j) * Gat(sol, Math.abs(x - rho / 2), j) / Gd;
      }
    }
    return { data: out, nx, nz, x0, x1, zmax };
  };

  /* Mean pathlength through a soft-edged sphere (an activation region) for
     a source and detector anywhere on the surface.  Positions are [x, y]
     in cm on the probe patch; the region is {x, y, z, r} and only counts
     below brainTop.  Returns cm of path weighted by the region profile. */
  NIRS.regionPath = function (sol, src, det, reg, brainTop) {
    const rho = Math.hypot(det[0] - src[0], det[1] - src[1]);
    const Gd = Gat(sol, rho, sol.j0);
    const R = reg.r, edge = Math.max(0.05, 0.12 * R), ext = R + 4 * edge;
    const h = Math.max(0.05, Math.min(0.1, R / 5));
    const n = Math.ceil(2 * ext / h);
    const dz = sol.dz, j0 = Math.max(Math.floor(brainTop / dz), Math.floor((reg.z - ext) / dz)), j1 = Math.min(sol.Nz - 1, Math.ceil((reg.z + ext) / dz));
    let s = 0;
    for (let a = 0; a < n; a++) {
      const x = reg.x - ext + (a + 0.5) * h;
      for (let b = 0; b < n; b++) {
        const y = reg.y - ext + (b + 0.5) * h;
        const dxy2 = (x - reg.x) * (x - reg.x) + (y - reg.y) * (y - reg.y);
        if (dxy2 > ext * ext) continue;
        const r1 = Math.hypot(x - src[0], y - src[1]), r2 = Math.hypot(x - det[0], y - det[1]);
        for (let j = j0; j <= j1; j++) {
          const z = (j + 0.5) * dz;
          if (z < brainTop) continue;
          const d = Math.sqrt(dxy2 + (z - reg.z) * (z - reg.z));
          const w = 1 / (1 + Math.exp((d - R) / edge));
          if (w < 1e-4) continue;
          s += w * Gat(sol, r1, j) * Gat(sol, r2, j);
        }
      }
    }
    return s * h * h * dz / Gd;
  };
  // Volume of the region below brainTop (cm^3), for converting path to "partial volume".
  NIRS.regionVolume = function (reg, brainTop) {
    const R = reg.r, edge = Math.max(0.05, 0.12 * R), ext = R + 4 * edge, h = Math.max(0.03, R / 12);
    let s = 0; const n = Math.ceil(2 * ext / h);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) {
      const x = -ext + (a + 0.5) * h, y = -ext + (b + 0.5) * h, z = reg.z - ext + (c + 0.5) * h;
      if (z < brainTop) continue;
      const d = Math.sqrt(x * x + y * y + (z - reg.z) * (z - reg.z));
      s += 1 / (1 + Math.exp((d - R) / edge));
    }
    return s * h * h * h;
  };

  /* ---------- a homogeneous half-space, analytically ----------
     Farrell, Patterson and Wilson (1992) for continuous wave, the same
     dipole solution with a complex wavenumber for frequency domain, and
     Patterson, Chance and Wilson (1989) for time domain. */
  function homog(mua, musp) {
    const D = 1 / (3 * (mua + musp)), z0 = 1 / (mua + musp), zb = 2 * A_BC * D;
    return { D, z0, zb, mueff: Math.sqrt(mua / D) };
  }
  NIRS.homogCW = function (mua, musp, rho) {
    const h = homog(mua, musp);
    const r1 = Math.hypot(h.z0, rho), r2 = Math.hypot(h.z0 + 2 * h.zb, rho);
    return (h.z0 * (h.mueff + 1 / r1) * Math.exp(-h.mueff * r1) / (r1 * r1) +
      (h.z0 + 2 * h.zb) * (h.mueff + 1 / r2) * Math.exp(-h.mueff * r2) / (r2 * r2)) / (4 * Math.PI);
  };
  // Mean pathlength in a homogeneous half-space (differential pathlength x rho).
  NIRS.homogDPF = function (mua, musp, rho) {
    const s = Math.sqrt(3 * mua * musp);
    return 3 * musp * rho / (2 * (1 + rho * s));
  };
  // Frequency domain: AC amplitude (relative to DC) and phase (radians) at f MHz.
  NIRS.homogFD = function (mua, musp, rho, fMHz) {
    const h = homog(mua, musp);
    const w = 2 * Math.PI * fMHz * 1e6, v = NIRS.C_TISSUE * 1e9;   // cm/s
    // k^2 = (mua + i w / v) / D ; k = a + ib
    const kr2 = mua / h.D, ki2 = w / v / h.D;
    const mag = Math.sqrt(Math.hypot(kr2, ki2)), ang = Math.atan2(ki2, kr2) / 2;
    const ka = mag * Math.cos(ang), kb = mag * Math.sin(ang);
    const term = (z, r) => {
      // z (k + 1/r) exp(-k r) / r^2, complex
      const er = Math.exp(-ka * r), c = Math.cos(-kb * r), s = Math.sin(-kb * r);
      const pr = ka + 1 / r, pi = kb;
      return [z * er * (pr * c - pi * s) / (r * r), z * er * (pr * s + pi * c) / (r * r)];
    };
    const r1 = Math.hypot(h.z0, rho), r2 = Math.hypot(h.z0 + 2 * h.zb, rho);
    const a = term(h.z0, r1), b = term(h.z0 + 2 * h.zb, r2);
    const re = (a[0] + b[0]) / (4 * Math.PI), im = (a[1] + b[1]) / (4 * Math.PI);
    const dc = NIRS.homogCW(mua, musp, rho);
    return { ac: Math.hypot(re, im) / dc, phase: -Math.atan2(im, re) };
  };
  // Time domain: reflectance at time t ns after the pulse (arbitrary units).
  NIRS.homogTD = function (mua, musp, rho, tns) {
    if (tns <= 0) return 0;
    const h = homog(mua, musp), c = NIRS.C_TISSUE, Dc = h.D * c;
    const r1s = h.z0 * h.z0 + rho * rho, r2s = (h.z0 + 2 * h.zb) * (h.z0 + 2 * h.zb) + rho * rho;
    return Math.pow(4 * Math.PI * Dc, -1.5) * Math.pow(tns, -2.5) * Math.exp(-mua * c * tns) *
      (h.z0 * Math.exp(-r1s / (4 * Dc * tns)) + (h.z0 + 2 * h.zb) * Math.exp(-r2s / (4 * Dc * tns))) / 2;
  };

  /* ---------- the modified Beer-Lambert law ----------
     dOD(l) = -log10(I / I0) = [e_HbO(l) dHbO + e_HbR(l) dHbR] * rho * DPF(l)
     with e in 1/(cm M) and concentrations in M; here concentrations are in
     µM, so the matrix carries a factor 1e-6. */
  NIRS.mbllMatrix = function (lambdas, rho, dpf, spectra) {
    return lambdas.map((nm, k) => {
      const e = spectra ? spectra[k] : NIRS.ext(nm);
      const L = rho * (Array.isArray(dpf) ? dpf[k] : dpf) * 1e-6;
      return [e[0] * L, e[1] * L];
    });
  };
  // Least-squares inverse (exact for two wavelengths): returns a 2 x nL matrix.
  NIRS.mbllInverse = function (E) {
    const Et = NIRS.la.transpose(E);
    const EtE = NIRS.la.matmul(Et, E);
    const det = EtE[0][0] * EtE[1][1] - EtE[0][1] * EtE[1][0];
    if (!(Math.abs(det) > 1e-30 * (EtE[0][0] * EtE[1][1] + 1e-300))) return null;
    const inv = [[EtE[1][1] / det, -EtE[0][1] / det], [-EtE[1][0] / det, EtE[0][0] / det]];
    return NIRS.la.matmul(inv, Et);
  };
  // Condition number of the extinction matrix (scale-free), for 2 or 3 wavelengths.
  NIRS.extCond = function (lambdas) {
    const E = lambdas.map(nm => NIRS.ext(nm));
    if (E.length < 2) return Infinity;
    const EtE = NIRS.la.matmul(NIRS.la.transpose(E), E);
    const tr = EtE[0][0] + EtE[1][1], det = EtE[0][0] * EtE[1][1] - EtE[0][1] * EtE[1][0];
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
    return l2 > 0 ? Math.sqrt(l1 / l2) : Infinity;
  };
  /* Noise gain of each chromophore: the standard deviation of the
     recovered dHbO and dHbR (µM) for unit noise (1 mOD) on every
     wavelength, at a given separation and DPF. */
  NIRS.noiseGain = function (lambdas, rho, dpf) {
    const Ei = NIRS.mbllInverse(NIRS.mbllMatrix(lambdas, rho, dpf));
    if (!Ei) return [Infinity, Infinity];
    return Ei.map(row => 1e-3 * Math.sqrt(row.reduce((s, v) => s + v * v, 0)));
  };

  /* Differential pathlength factor as a function of wavelength and age,
     the general equation of Scholkmann and Wolf (2013) for the adult
     forehead. */
  NIRS.dpfAge = function (nm, age) {
    return 223.3 + 0.05624 * Math.pow(Math.max(0, age), 0.8493) - 5.723e-7 * nm * nm * nm + 0.001245 * nm * nm - 0.9025 * nm;
  };

  /* An LED's emission is tens of nanometres wide, so the extinction it
     effectively sees is the emission-weighted average, not the value at
     its peak. */
  NIRS.effectiveExt = function (nm, fwhm) {
    if (!fwhm || fwhm < 1) return NIRS.ext(nm);
    const sd = fwhm / 2.3548;
    let so = 0, sr = 0, sw = 0;
    for (let x = -3 * sd; x <= 3 * sd; x += sd / 8) {
      const w = Math.exp(-x * x / (2 * sd * sd)), e = NIRS.ext(nm + x);
      so += w * e[0]; sr += w * e[1]; sw += w;
    }
    return [so / sw, sr / sw];
  };
})(typeof window !== 'undefined' ? window : globalThis);
