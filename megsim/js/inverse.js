/* MEG simulator: the inverse problem.

   Three ways to turn the same field maps back into sources, each with its
   own assumption:

   Dipole fitting assumes one (or a few) point sources and finds the
   position whose field best matches the data in the least-squares sense.
   Moment is linear and solved exactly at each candidate; position is found
   by a grid search refined with Nelder-Mead.

   Minimum norm assumes nothing about the number of sources and spreads
   activity over the whole source space, choosing, among the infinitely
   many current distributions that explain the data, the one with the
   least total power.  Superficial sources need the least current to make a
   given field, so plain minimum norm drags deep activity to the surface;
   depth weighting and noise normalization (dSPM, sLORETA) push back.

   The LCMV beamformer assumes the sources are uncorrelated in time.  For
   each location it builds a spatial filter that passes that location with
   unit gain while suppressing everything else in the data covariance.
   When two sources are correlated, each one's filter cancels the other
   and both shrink or merge.

   Everything works on whitened data: each channel divided by its noise,
   so magnetometers and gradiometers can be combined and the noise is the
   same in every direction of sensor space.  In a spherical head a radial
   current makes no field, so each source location has two tangential
   orientations. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, la = MEG.la;

  /* ---------- the source space ----------
     A grid every `spacing` cm over the template's brain, grey and white
     matter but not CSF or skull (js/template.js carries the mask at 6 mm),
     so an estimate cannot land outside the brain.  Without the template it
     is a sphere, cut below z = -3.5 cm.  6 mm is fine enough that a
     beamformer's sharp peak lands on a grid point. */
  const BRAIN = MEG.TEMPLATE && MEG.TEMPLATE.grid ? (function (g) {
    return { bits: MEG.b64(g.mask), lim: g.lim, w: 2 * g.lim + 1, sp: g.spacing };
  })(MEG.TEMPLATE.grid) : null;
  function brainCell(i, j, k) {
    const L = BRAIN.lim;
    if (i < -L || i > L || j < -L || j > L || k < -L || k > L) return false;
    const n = ((k + L) * BRAIN.w + (j + L)) * BRAIN.w + (i + L);
    return ((BRAIN.bits[n >> 3] >> (n & 7)) & 1) === 1;
  }
  /* The grid cells on the brain's outer surface, the cortex as far as a
     6 mm grid can tell: brain cells next to the outside, where the outside
     is what can be reached from beyond the head without crossing the brain
     (so the ventricles' walls do not count).  Cells more than 2.5 cm below
     the centre are left out, and the cerebellum with them. */
  let CORTEX = null;
  function cortexCells() {
    if (CORTEX) return CORTEX;
    const L = BRAIN.lim + 1, w = 2 * L + 1, at = (i, j, k) => ((k + L) * w + (j + L)) * w + (i + L);
    const out = new Uint8Array(w * w * w), stack = [at(-L, -L, -L)];
    out[stack[0]] = 1;
    while (stack.length) {
      const n = stack.pop(), i = n % w - L, j = Math.floor(n / w) % w - L, k = Math.floor(n / (w * w)) - L;
      [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].forEach(([a, b, c]) => {
        const x = i + a, y = j + b, z = k + c;
        if (Math.abs(x) > L || Math.abs(y) > L || Math.abs(z) > L) return;
        const m = at(x, y, z);
        if (!out[m] && !brainCell(x, y, z)) { out[m] = 1; stack.push(m); }
      });
    }
    CORTEX = sourceGrid(BRAIN.sp).ijk.filter(([i, j, k]) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => out[at(i + a, j + b, k + c)]))
      .map(q => v3.scale(q, BRAIN.sp)).filter(p => p[2] > -2.5);
    return CORTEX;
  }
  // Inside the brain, to the grid's resolution: where a fitted dipole may go.
  MEG.inBrain = function (p) {
    const r = v3.norm(p);
    if (r < 0.3) return false;
    if (!BRAIN) return r <= 7.8;
    return brainCell(Math.round(p[0] / BRAIN.sp), Math.round(p[1] / BRAIN.sp), Math.round(p[2] / BRAIN.sp));
  };
  function sourceGrid(spacing) {
    spacing = spacing || 0.6;
    const tpl = BRAIN && Math.abs(spacing - BRAIN.sp) < 1e-9;
    const lim = tpl ? BRAIN.lim : Math.ceil(7.7 / spacing), pts = [], ijk = [];
    for (let k = -lim; k <= lim; k++) for (let j = -lim; j <= lim; j++) for (let i = -lim; i <= lim; i++) {
      const p = [i * spacing, j * spacing, k * spacing];
      const r = v3.norm(p);
      if (tpl ? brainCell(i, j, k) : r <= 7.6 && r >= 0.6 && p[2] >= -3.5) { pts.push(p); ijk.push([i, j, k]); }
    }
    const ori = pts.map(p => { const f = MEG.tangentFrame(p); return [f.t1, f.t2]; });
    return { pts, ijk, ori, spacing, lim, n: pts.length };
  }

  /* Channels of the current array as head-frame points at the starting pose. */
  function headChannels(ds) {
    const arr = ds.array;
    if (arr.frame === 'head') return arr.channels;
    return arr.channels.map(c => ({ pts: MEG.pointsIn(Object.assign({ frame: 'device' }, c), 'device', 'head', ds.pose.ref) }));
  }
  // Noise of every channel per root hertz, times the root of the bandwidth: a diagonal noise model.
  function channelNoise(ds, bw) {
    const arr = ds.array;
    return Float64Array.from(arr.channels, ch => MEG.chanNoise(arr, ch, ds.cfg.recording.noise) * Math.sqrt(bw || 40));
  }

  /* Lead fields for the grid: for every point, the readings for a unit
     dipole along each of its two tangential directions, each channel
     divided by its sensor noise.  Stored as L[2 * point + k] = Float64Array(nch). */
  function gridLeadfield(chans, grid, white) {
    const nch = chans.length, L = new Array(2 * grid.n);
    const tmp = new Float64Array(3 * nch);
    grid.pts.forEach((p, i) => {
      MEG.leadfieldMEG(chans, p, tmp);
      grid.ori[i].forEach((o, k) => {
        const col = new Float64Array(nch);
        for (let c = 0; c < nch; c++) col[c] = (tmp[3 * c] * o[0] + tmp[3 * c + 1] * o[1] + tmp[3 * c + 2] * o[2]) / white[c];
        L[2 * i + k] = col;
      });
    });
    return L;
  }

  /* ---------- a common data set for every method ----------
     Trials of a controlled scenario: one or two current dipoles with evoked
     waveforms, the second correlated with the first by `corr`, plus
     spontaneous brain activity from random cortical dipoles and white
     sensor noise.  Everything is returned per channel and per trial so the
     dipole fit and minimum norm can use the average and the beamformer the
     single-trial covariance. */
  /* Evoked waveforms: source 1 peaks at 100 ms; source 2 shares that
     waveform by `rho` and has its own, peaking at 160 ms, made orthogonal
     to the first over the active window and of the same norm. */
  function waveforms(times, rho) {
    const nT = times.length;
    const bump = (c, w) => Float64Array.from(times, t => Math.exp(-0.5 * ((t - c) / w) ** 2));
    const w1 = bump(0.1, 0.025), w2own = bump(0.16, 0.03);
    const act = times.map(t => (t >= 0 && t <= 0.35 ? 1 : 0));
    const dot = (a, b) => { let s = 0; for (let i = 0; i < nT; i++) s += a[i] * b[i] * act[i]; return s; };
    const g = dot(w2own, w1) / dot(w1, w1);
    const own = Float64Array.from(w2own, (x, i) => x - g * w1[i]);
    const sc = Math.sqrt(dot(w1, w1) / (dot(own, own) || 1));
    for (let i = 0; i < nT; i++) own[i] *= sc;
    return [w1, Float64Array.from(w1, (x, i) => rho * x + Math.sqrt(1 - rho * rho) * own[i])];
  }
  /* Fifty fixed random cortical dipoles for the spontaneous background, and
     the scale that gives `rms` on the channels.  Fifty is few enough that a
     beamformer can tune most of them out, as it can the strongest of the
     real background; where they fall matters, and this draw (BG_DRAW) puts
     none right on top of the scenarios' sources, on any array. */
  const BG_DRAW = 30;
  function backgroundPatterns(chans, seed, rms) {
    const bg = [], bgR = MEG.rng(BG_DRAW + (seed || 11) - 11), nch = chans.length;
    const shell = BRAIN ? cortexCells() : null;
    for (let k = 0; k < 50; k++) {
      let pos;
      if (shell) pos = bgR.pick(shell);
      else { let u; do { u = v3.unit([bgR.gauss(), bgR.gauss(), bgR.gauss()]); } while (u[2] < -0.3); pos = v3.scale(u, bgR.uniform(6.2, 7.6)); }
      const ori = v3.unit([bgR.gauss(), bgR.gauss(), bgR.gauss()]);
      bg.push(MEG.forwardMEG(chans, pos, ori));
    }
    let bgPow = 0; bg.forEach(b => b.forEach(x => { bgPow += x * x; }));
    return { bg, scale: (rms === undefined ? 150 : rms) / Math.sqrt(bgPow / nch) };
  }
  /* Normal deviates in bulk: 65536 drawn once, then picked at random by a
     xorshift generator.  Twenty times faster than drawing each one, and
     the same to any statistic computed here. */
  let NORM_TABLE = null;
  function fastNormal(seed) {
    if (!NORM_TABLE) { const r = MEG.rng(424242); NORM_TABLE = Float64Array.from({ length: 65536 }, () => r.gauss()); }
    let x = (MEG.hashSeed(seed >>> 0, 'normal') >>> 0) || 1;
    return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return NORM_TABLE[x >>> 16]; };
  }
  // Background patterns depend only on the channels and the seed: keep them.
  const BG_CACHE = new WeakMap();
  const EPOCH = { fs: 250, t0: -0.2, t1: 0.5 };
  const epochTimes = () => { const nT = Math.round((EPOCH.t1 - EPOCH.t0) * EPOCH.fs) + 1; return Float64Array.from({ length: nT }, (_, i) => EPOCH.t0 + i / EPOCH.fs); };
  function scenario(ds, opts) {
    opts = opts || {};
    const chans = headChannels(ds), nch = chans.length, fs = EPOCH.fs;
    const times = epochTimes(), nT = times.length;
    const rng = MEG.rng(opts.seed || 11);
    const srcs = opts.sources;
    const nTr = opts.trials || 60;
    const rho = srcs.length > 1 ? MEG.clamp(opts.corr === undefined ? 0 : opts.corr, -1, 1) : 0;
    const wave = waveforms(times, rho);
    // patterns
    const pat = srcs.map(s => MEG.forwardMEG(chans, s.pos, v3.scale(s.ori, 1)));
    // background brain noise: fixed random dipoles with 1/f-ish time courses per trial
    const { bg, scale: bgScale } = backgroundPatterns(chans, opts.seed, opts.background);
    const sens = Float64Array.from(ds.array.channels, ch => MEG.chanNoise(ds.array, ch, ds.cfg.recording.noise) * Math.sqrt(40));
    const noiseScale = opts.noiseScale === undefined ? 1 : opts.noiseScale;
    const trials = [];
    for (let r = 0; r < nTr; r++) {
      const Y = Array.from({ length: nch }, () => new Float64Array(nT));
      const amp = srcs.map(() => Math.max(0.3, 1 + 0.2 * rng.gauss()));
      srcs.forEach((s, si) => {
        const p = pat[si], wv = wave[si], a = s.amp * amp[si];
        for (let c = 0; c < nch; c++) { const w = p[c] * a; if (!w) continue; const o = Y[c]; for (let i = 0; i < nT; i++) o[i] += w * wv[i]; }
      });
      // background: each dipole an AR(1) process, smooth like brain activity
      bg.forEach(b => {
        let y = rng.gauss();
        const tc = new Float64Array(nT);
        for (let i = 0; i < nT; i++) { y = 0.93 * y + 0.37 * rng.gauss(); tc[i] = y * bgScale * noiseScale; }
        for (let c = 0; c < nch; c++) { const w = b[c]; const o = Y[c]; for (let i = 0; i < nT; i++) o[i] += w * tc[i]; }
      });
      for (let c = 0; c < nch; c++) { const o = Y[c], s = sens[c] * noiseScale; for (let i = 0; i < nT; i++) o[i] += s * rng.gauss(); }
      trials.push(Y);
    }
    return { trials, times, fs, nch, chans, srcs, wave, nT };
  }

  /* ---------- the same scenario, fast ----------
     A trial is a few time courses (the sources' and the background's)
     mixed by fixed patterns, plus white sensor noise.  scenarioData keeps
     the time courses of every trial and the channel-space average, which is
     all a field map needs.  scenarioStats then forms the covariances in the
     brain's signal space, where the sensor noise (white after dividing each
     channel by its noise) stays white: the same statistics, several times
     faster than in channel space. */
  function scenarioData(ds, opts) {
    opts = opts || {};
    const chans = headChannels(ds), nch = chans.length, seed = opts.seed || 11;
    const times = epochTimes(), nT = times.length;
    // separate streams, so the noise stays the same draw when only the sources change
    const rAmp = MEG.rng(MEG.hashSeed(seed, 'amplitude')), gBg = fastNormal(seed + 1), gSens = fastNormal(seed + 2);
    const srcs = opts.sources, ns = srcs.length, nTr = opts.trials || 60;
    const rho = ns > 1 ? MEG.clamp(opts.corr === undefined ? 0 : opts.corr, -1, 1) : 0;
    const wave = waveforms(times, rho);
    const pat = srcs.map(s => MEG.forwardMEG(chans, s.pos, s.ori));
    const key = ds.array;
    let cache = BG_CACHE.get(key);
    if (!cache || cache.seed !== seed || cache.rms !== opts.background) { cache = Object.assign(backgroundPatterns(chans, seed, opts.background), { seed, rms: opts.background }); BG_CACHE.set(key, cache); }
    const { bg, scale: bgScale } = cache;
    const sens = channelNoise(ds, 40);
    const noiseScale = opts.noiseScale === undefined ? 1 : opts.noiseScale;
    const mix = pat.concat(bg), q = mix.length;
    const Z = [], zbar = Array.from({ length: q }, () => new Float64Array(nT));
    for (let r = 0; r < nTr; r++) {
      const z = new Float32Array(q * nT);
      for (let si = 0; si < 2; si++) { const a = Math.max(0.3, 1 + 0.2 * rAmp.gauss()); if (si < ns) { const amp = srcs[si].amp * a; for (let i = 0; i < nT; i++) z[si * nT + i] = amp * wave[si][i]; } }
      for (let k = ns; k < q; k++) { let y = gBg(); for (let i = 0; i < nT; i++) { y = 0.93 * y + 0.37 * gBg(); z[k * nT + i] = y * bgScale * noiseScale; } }
      for (let k = 0; k < q; k++) { const zb = zbar[k]; for (let i = 0; i < nT; i++) zb[i] += z[k * nT + i] / nTr; }
      Z.push(z);
    }
    // the average: sources and background through their patterns, plus the averaged sensor noise
    const avg = Array.from({ length: nch }, (_, c) => { const o = new Float64Array(nT), sd = sens[c] * noiseScale / Math.sqrt(nTr); for (let i = 0; i < nT; i++) o[i] = sd * gSens(); return o; });
    const fwd = Array.from({ length: nch }, () => new Float64Array(nT));
    for (let k = 0; k < q; k++) {
      const p = mix[k], zb = zbar[k];
      for (let c = 0; c < nch; c++) {
        const w = p[c]; if (!w) continue;
        const o = avg[c]; for (let i = 0; i < nT; i++) o[i] += w * zb[i];
        if (k < ns) { const f = fwd[c]; for (let i = 0; i < nT; i++) f[i] += w * zb[i]; }
      }
    }
    const meanAmp = srcs.map((_, si) => { let m = 0, b = 0; for (let i = 0; i < nT; i++) if (Math.abs(wave[si][i]) > Math.abs(b)) { b = wave[si][i]; m = zbar[si][i]; } return b ? m / b : 0; });
    return { times, fs: EPOCH.fs, nT, nch, chans, srcs, wave, rho, nTr, Z, q, ns, mix, avg, fwd, noiseScale, seed, meanAmp };
  }
  function scenarioStats(model, data, opts) {
    opts = opts || {};
    const { U } = model, r = U.length, { nT, times, Z, q, nTr } = data;
    const mixR = new Float64Array(q * r);
    data.mix.forEach((p, j) => mixR.set(reduceVec(model, p), j * r));
    const avgR = reduceRows(model, data.avg, nT);
    const win = opts.win || [0.05, 0.3];
    const use = new Int8Array(nT);
    for (let i = 0; i < nT; i++) use[i] = times[i] < 0 && times[i] >= -0.2 ? 1 : (times[i] >= win[0] && times[i] < win[1] ? 2 : 0);
    const Cn = new Float64Array(r * r), Cd = new Float64Array(r * r);
    let nn = 0, nd = 0;
    const gauss = fastNormal(data.seed + 101), y = new Float64Array(r), sd = data.noiseScale;
    for (let t = 0; t < nTr; t++) {
      const z = Z[t];
      for (let i = 0; i < nT; i++) {
        if (!use[i]) continue;
        for (let k = 0; k < r; k++) y[k] = sd * gauss();
        for (let j = 0; j < q; j++) { const zj = z[j * nT + i]; if (zj === 0) continue; const o = j * r; for (let k = 0; k < r; k++) y[k] += mixR[o + k] * zj; }
        let C;
        if (use[i] === 1) { C = Cn; nn++; } else { C = Cd; nd++; }
        for (let a = 0; a < r; a++) { const ya = y[a], o = a * r; for (let b = a; b < r; b++) C[o + b] += ya * y[b]; }
      }
    }
    const full = (C, n) => Array.from({ length: r }, (_, a) => Float64Array.from({ length: r }, (_, b) => (a <= b ? C[a * r + b] : C[b * r + a]) / Math.max(1, n)));
    return { avgR, noiseCovR: full(Cn, nn), dataCovR: full(Cd, nd) };
  }

  /* Average of the trials, noise covariance from the baseline and data
     covariance from the active window (single trials, average removed or
     not, as a beamformer user would choose). */
  function statistics(data, opts) {
    opts = opts || {};
    const { trials, times, nch, nT } = data;
    const nTr = trials.length;
    const avg = Array.from({ length: nch }, () => new Float64Array(nT));
    trials.forEach(Y => { for (let c = 0; c < nch; c++) { const o = avg[c], y = Y[c]; for (let i = 0; i < nT; i++) o[i] += y[i] / nTr; } });
    const idx = (a, b) => { const out = []; for (let i = 0; i < nT; i++) if (times[i] >= a && times[i] < b) out.push(i); return out; };
    const base = idx(-0.2, 0), active = idx(opts.win ? opts.win[0] : 0.05, opts.win ? opts.win[1] : 0.3);
    const cov = (ix, demean) => {
      const C = la.zeros(nch, nch); let cnt = 0;
      trials.forEach(Y => {
        ix.forEach(i => {
          cnt++;
          for (let a = 0; a < nch; a++) { const ya = Y[a][i] - (demean ? avg[a][i] : 0); if (ya === 0) continue; const Ca = C[a]; for (let b = a; b < nch; b++) Ca[b] += ya * (Y[b][i] - (demean ? avg[b][i] : 0)); }
        });
      });
      for (let a = 0; a < nch; a++) for (let b = a; b < nch; b++) { C[a][b] /= cnt; C[b][a] = C[a][b]; }
      return C;
    };
    return { avg, noiseCov: cov(base, false), dataCov: cov(active, false), base, active };
  }

  /* ---------- the brain's signal space ----------
     Only about a hundred directions in sensor space can be reached by any
     source in the brain (the lead fields' principal subspace).  Everything
     below works in that subspace, which is faster and loses nothing a
     brain source could have produced. */
  function signalSpace(Ld, nch, tol) {
    const G = la.zeros(nch, nch);
    Ld.forEach(col => { for (let a = 0; a < nch; a++) { const x = col[a]; if (x === 0) continue; const Ga = G[a]; for (let b = a; b < nch; b++) Ga[b] += x * col[b]; } });
    for (let a = 0; a < nch; a++) for (let b = 0; b < a; b++) G[a][b] = G[b][a];
    const { values, vectors } = la.eigSym(G);
    let r = 0; while (r < nch && values[r] > (tol || 1e-7) * values[0]) r++;
    const U = Array.from({ length: r }, (_, k) => Float64Array.from(vectors, row => row[k]));   // r rows of length nch
    return { U, r };
  }
  const project = (U, v) => Float64Array.from(U, u => { let s = 0; for (let c = 0; c < v.length; c++) s += u[c] * v[c]; return s; });
  // A channel-space vector (field units) -> the signal space, each channel divided by its noise.
  function reduceVec(model, v) {
    const x = Float64Array.from(v);
    if (model.project) model.project(x);
    for (let c = 0; c < x.length; c++) x[c] /= model.white[c];
    return project(model.U, x);
  }
  // Every time sample of channel rows (rows[c][i], i < nT) -> r rows in the signal space.
  function reduceRows(model, rows, nT, stride) {
    const { U, white } = model, r = U.length, nch = rows.length, st = stride || 1;
    const out = Array.from({ length: r }, () => new Float64Array(nT));
    const col = new Float64Array(nch);
    for (let i = 0; i < nT; i += st) {
      for (let c = 0; c < nch; c++) col[c] = rows[c][i];
      if (model.project) model.project(col);
      for (let k = 0; k < r; k++) { const u = U[k]; let s = 0; for (let c = 0; c < nch; c++) s += u[c] * col[c] / white[c]; out[k][i] = s; }
    }
    return out;
  }

  /* ---------- whitening ----------
     Background brain activity is correlated across channels, so dividing
     each channel by its own noise is not enough.  The whitener is
     C^(-1/2) of the noise covariance measured in the baseline (after the
     channels are put on one scale and projected on the signal space),
     regularized by adding a share of its mean diagonal, as MNE does.  In
     whitened coordinates the noise is the same in every direction, which
     every method below assumes. */
  function reduceCov(model, C) {
    const { U, white } = model, r = U.length, nch = C.length;
    const D = C.map((row, a) => Float64Array.from(row, (x, b) => x / (white[a] * white[b])));
    const UD = U.map(u => Float64Array.from({ length: nch }, (_, b) => { let s = 0; for (let a = 0; a < nch; a++) s += u[a] * D[a][b]; return s; }));
    return UD.map(row => Float64Array.from(U, u => { let s = 0; for (let b = 0; b < nch; b++) s += row[b] * u[b]; return s; }));
  }
  function whitener(model, noiseCov, reg) { return whitenerR(reduceCov(model, noiseCov), reg); }
  // The same from a covariance already in the signal space.
  function whitenerR(Cr, reg) {
    const r = Cr.length;
    let md = 0; for (let a = 0; a < r; a++) md += Cr[a][a]; md /= r;
    const { values, vectors: V } = la.eigSym(Cr);
    const add = (reg === undefined ? 0.1 : reg) * md;
    const d = Float64Array.from(values, x => 1 / Math.sqrt(Math.max(x, 0) + add));
    const W = la.zeros(r, r);
    for (let a = 0; a < r; a++) for (let k = 0; k < r; k++) { const x = V[a][k] * d[k]; if (x === 0) continue; const Wa = W[a]; for (let b = 0; b < r; b++) Wa[b] += x * V[b][k]; }
    return { W, r };
  }
  // A channel-space vector -> whitened signal-space coordinates.
  function whitenVec(model, Wh, v) {
    const u = project(model.U, Float64Array.from(v, (x, c) => x / model.white[c]));
    return Float64Array.from(Wh.W, row => { let s = 0; for (let k = 0; k < u.length; k++) s += row[k] * u[k]; return s; });
  }
  function whitenCov(model, Wh, C) { return whitenCovR(Wh, reduceCov(model, C)); }
  const whitenCovR = (Wh, Cr) => la.matmul(la.matmul(Wh.W, Cr), Wh.W);
  const whitenVecR = (Wh, u) => Float64Array.from(Wh.W, row => { let s = 0; for (let k = 0; k < u.length; k++) s += row[k] * u[k]; return s; });
  /* A whitened model: the grid lead fields in whitened signal-space coordinates. */
  function withWhitener(model, Wh) {
    const r = Wh.r;
    const Lw = model.Lr.map(col => Float64Array.from(Wh.W, row => { let s = 0; for (let k = 0; k < r; k++) s += row[k] * col[k]; return s; }));
    return Object.assign({}, model, { Lw, Wh });
  }

  /* ---------- dipole fitting ---------- */
  function solve2(L0, L1, v, n) {
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0, vv = 0;
    for (let c = 0; c < n; c++) { const x = L0[c], y = L1[c], d = v[c]; a00 += x * x; a01 += x * y; a11 += y * y; b0 += x * d; b1 += y * d; vv += d * d; }
    const det = a00 * a11 - a01 * a01 || 1e-30;
    const q0 = (a11 * b0 - a01 * b1) / det, q1 = (a00 * b1 - a01 * b0) / det;
    return { q: [q0, q1], resid: Math.max(0, vv - q0 * b0 - q1 * b1), vv };
  }
  // Whitened signal-space lead fields of the two tangential orientations at any position.
  function columnsAt(model, pos) {
    const chans = model.chans, nch = chans.length, tmp = MEG.leadfieldMEG(chans, pos), f = MEG.tangentFrame(pos);
    const cols = [f.t1, f.t2].map(o => {
      const c = new Float64Array(nch);
      for (let i = 0; i < nch; i++) c[i] = tmp[3 * i] * o[0] + tmp[3 * i + 1] * o[1] + tmp[3 * i + 2] * o[2];
      return whitenVecR(model.Wh, reduceVec(model, c));
    });
    return { cols, f };
  }
  function residualAt(model, pos, v) {
    if (!MEG.inBrain(pos)) return { resid: Infinity, vv: 1, q: [0, 0, 0] };
    const { cols, f } = columnsAt(model, pos);
    const r = solve2(cols[0], cols[1], v, v.length);
    return { resid: r.resid, vv: r.vv, q: v3.add(v3.scale(f.t1, r.q[0]), v3.scale(f.t2, r.q[1])) };
  }
  function nelderMead(f, start, step) {
    let S = [start.slice(), v3.add(start, [step, 0, 0]), v3.add(start, [0, step, 0]), v3.add(start, [0, 0, step])];
    let F = S.map(f);
    for (let it = 0; it < 150; it++) {
      const ord = [0, 1, 2, 3].sort((a, b) => F[a] - F[b]);
      S = ord.map(i => S[i]); F = ord.map(i => F[i]);
      if (Math.abs(F[3] - F[0]) <= 1e-10 * (Math.abs(F[0]) + 1e-12) && v3.norm(v3.sub(S[3], S[0])) < 1e-3) break;
      const c = v3.scale(v3.add(v3.add(S[0], S[1]), S[2]), 1 / 3);
      const xr = v3.add(c, v3.sub(c, S[3])), fr = f(xr);
      if (fr < F[0]) { const xe = v3.add(c, v3.scale(v3.sub(c, S[3]), 2)), fe = f(xe); if (fe < fr) { S[3] = xe; F[3] = fe; } else { S[3] = xr; F[3] = fr; } }
      else if (fr < F[2]) { S[3] = xr; F[3] = fr; }
      else {
        const xc = v3.add(c, v3.scale(v3.sub(S[3], c), 0.5)), fc = f(xc);
        if (fc < F[3]) { S[3] = xc; F[3] = fc; } else for (let i = 1; i < 4; i++) { S[i] = v3.add(S[0], v3.scale(v3.sub(S[i], S[0]), 0.5)); F[i] = f(S[i]); }
      }
    }
    let b = 0; for (let i = 1; i < 4; i++) if (F[i] < F[b]) b = i;
    return S[b];
  }
  /* Fit one dipole to one whitened map v.  Returns position, moment (nA m),
     goodness of fit and the relative residual at every grid point. */
  function dipoleFit(model, v, opts) {
    opts = opts || {};
    const { grid, Lw } = model, nch = v.length;
    const land = new Float32Array(grid.n), resid = new Float32Array(grid.n);
    let best = 0, bestR = Infinity;
    for (let i = 0; i < grid.n; i++) {
      const r = solve2(Lw[2 * i], Lw[2 * i + 1], v, nch);
      land[i] = r.resid / r.vv; resid[i] = r.resid;
      if (r.resid < bestR) { bestR = r.resid; best = i; }
    }
    const pos = opts.refine === false ? grid.pts[best] : nelderMead(p => residualAt(model, p, v).resid, grid.pts[best], grid.spacing / 2);
    const r = residualAt(model, pos, v);
    return { pos, q: r.q, gof: 1 - r.resid / r.vv, landscape: land, resid, residBest: Math.min(r.resid, bestR), vv: r.vv };
  }
  // Least squares with a few columns: coefficients and residual.
  function lsq(cols, v) {
    const k = cols.length, n = v.length, A = la.zeros(k, k), b = new Float64Array(k);
    let vv = 0; for (let c = 0; c < n; c++) vv += v[c] * v[c];
    for (let i = 0; i < k; i++) {
      for (let j = i; j < k; j++) { let s = 0; for (let c = 0; c < n; c++) s += cols[i][c] * cols[j][c]; A[i][j] = s; A[j][i] = s; }
      let s = 0; for (let c = 0; c < n; c++) s += cols[i][c] * v[c]; b[i] = s;
    }
    let tr = 0; for (let i = 0; i < k; i++) tr += A[i][i];
    for (let i = 0; i < k; i++) A[i][i] += 1e-9 * tr / k + 1e-300;
    const x = la.solve(A, b);
    let xb = 0; for (let i = 0; i < k; i++) xb += x[i] * b[i];
    return { x, resid: Math.max(0, vv - xb), vv };
  }
  /* Two dipoles at once.  Each dipole in turn is searched over the grid
     with the other held fixed (its field projected out of the data and
     of every candidate's), then refined.  A pair of dipoles has many local
     minima, so the search starts from the single-dipole fit and from six
     points 1.5 cm around it, on a grid twice as coarse, and the best pair
     is then polished on the full grid.  resid[k] is the residual at every
     grid point for dipole k with the other where it ended up: the ground
     for its confidence volume. */
  function dipoleFit2(model, v, first) {
    const { grid, Lw } = model, n = v.length;
    const one = first || dipoleFit(model, v);
    const coarse = [], all = [];
    grid.ijk.forEach((q, i) => { all.push(i); if (q[0] % 2 === 0 && q[1] % 2 === 0 && q[2] % 2 === 0) coarse.push(i); });
    const basis = cols => {
      const Q = [];
      cols.forEach(c => { const u = Float64Array.from(c); Q.forEach(q => { let d = 0; for (let i = 0; i < n; i++) d += q[i] * u[i]; for (let i = 0; i < n; i++) u[i] -= d * q[i]; }); let nn = 0; for (let i = 0; i < n; i++) nn += u[i] * u[i]; nn = Math.sqrt(nn); if (nn > 1e-12) { for (let i = 0; i < n; i++) u[i] /= nn; Q.push(u); } });
      return Q;
    };
    const perp = (Q, x) => { const o = Float64Array.from(x); Q.forEach(q => { let d = 0; for (let i = 0; i < n; i++) d += q[i] * o[i]; for (let i = 0; i < n; i++) o[i] -= d * q[i]; }); return o; };
    const inside = p => v3.norm(p) >= 0.6 && MEG.inBrain(p);
    // the best place for one dipole given the other's columns, over a list of grid points
    const search = (other, list) => {
      const Q = basis(columnsAt(model, other).cols), vp = perp(Q, v), land = new Float32Array(grid.n).fill(Infinity);
      let best = list[0], bestR = Infinity;
      list.forEach(i => {
        if (v3.norm(v3.sub(grid.pts[i], other)) < 1.2) return;
        const r = solve2(perp(Q, Lw[2 * i]), perp(Q, Lw[2 * i + 1]), vp, n);
        land[i] = r.resid;
        if (r.resid < bestR) { bestR = r.resid; best = i; }
      });
      return { best, land, resid: bestR };
    };
    const jointCols = (ca, p) => (inside(p) ? lsq(ca.concat(columnsAt(model, p).cols), v).resid : Infinity);
    const refine = (other, start) => { const ca = columnsAt(model, other).cols; return nelderMead(p => jointCols(ca, p), start, grid.spacing / 2); };
    // multi-start on the coarse grid
    const starts = [one.pos];
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].forEach(d => { const p = v3.add(one.pos, v3.scale(d, 1.5)); if (inside(p)) starts.push(p); });
    let pair = null, pairR = Infinity;
    starts.forEach(s0 => {
      let a = s0, b = null, r = Infinity;
      for (let round = 0; round < 2; round++) {
        const sb = search(a, coarse); b = grid.pts[sb.best];
        const sa = search(b, coarse); a = grid.pts[sa.best]; r = sa.resid;
      }
      if (r < pairR) { pairR = r; pair = [a, b]; }
    });
    // polish on the full grid
    const pos = pair.slice(), resid = [null, null];
    for (let round = 0; round < 2; round++) {
      for (let k = 1; k >= 0; k--) {
        const other = pos[1 - k], s = search(other, all);
        pos[k] = refine(other, grid.pts[s.best]);
        resid[k] = s.land;
      }
    }
    const ca = columnsAt(model, pos[0]), cb = columnsAt(model, pos[1]);
    const r = lsq(ca.cols.concat(cb.cols), v);
    const q = [v3.add(v3.scale(ca.f.t1, r.x[0]), v3.scale(ca.f.t2, r.x[1])), v3.add(v3.scale(cb.f.t1, r.x[2]), v3.scale(cb.f.t2, r.x[3]))];
    return { pos, q, gof: 1 - r.resid / r.vv, resid, residBest: r.resid, vv: r.vv, one };
  }
  /* Where else the dipole could be: grid points whose residual is within
     `level` of the best (7.81, the 95% point of chi-square with three
     degrees of freedom, for data whitened to unit noise). */
  function confidence(resid, best, level) {
    const lv = level || 7.81, out = new Float32Array(resid.length);
    for (let i = 0; i < resid.length; i++) out[i] = resid[i] - best <= lv ? 1 : 0;
    return out;
  }

  /* ---------- minimum norm ----------
     Whitened lead field L (nch x 2n), source prior R = diag(w), with
     depth weighting w_i = |L_i|^(-2 gamma).  R is scaled so that
     trace(L R L^T) = nch, and lambda^2 = 1/SNR^2, as MNE does.
     K = R L^T (L R L^T + lambda^2 I)^-1.  dSPM divides each source by the
     noise it would show (the norm of its row of K); sLORETA by the
     estimate's whole variance under the model, signal prior and noise
     together: the diagonal of K (L R L^T + lambda^2 I) K^T = R L^T G^-1 L R,
     which keeps sLORETA's exact localization of a single noiseless source
     even with depth weighting (with R = I it is the resolution matrix's
     diagonal, as Pascual-Marqui defined it). */
  function minimumNorm(model, opts) {
    opts = opts || {};
    const { Lw, grid } = model, nch = Lw[0].length, ns = Lw.length;
    const gamma = opts.depth === false ? 0 : (opts.depthExp || 0.8);
    const w = new Float64Array(ns);
    for (let i = 0; i < grid.n; i++) {
      let s = 0; for (let k = 0; k < 2; k++) { const col = Lw[2 * i + k]; for (let c = 0; c < nch; c++) s += col[c] * col[c]; }
      const d = Math.pow(s / 2 + 1e-30, -gamma);
      w[2 * i] = d; w[2 * i + 1] = d;
    }
    // G = L R L^T
    const Gm = la.zeros(nch, nch);
    for (let j = 0; j < ns; j++) {
      const col = Lw[j], wj = w[j];
      for (let a = 0; a < nch; a++) { const x = wj * col[a]; if (x === 0) continue; const Ga = Gm[a]; for (let b = a; b < nch; b++) Ga[b] += x * col[b]; }
    }
    let tr = 0; for (let a = 0; a < nch; a++) { tr += Gm[a][a]; for (let b = 0; b < a; b++) Gm[a][b] = Gm[b][a]; }
    const scale = nch / tr;
    for (let a = 0; a < nch; a++) for (let b = 0; b < nch; b++) Gm[a][b] *= scale;
    for (let j = 0; j < ns; j++) w[j] *= scale;
    const lam2 = 1 / Math.pow(opts.snr || 3, 2);
    for (let a = 0; a < nch; a++) Gm[a][a] += lam2;
    const Ginv = la.inverse(Gm);
    // K rows: K_j = w_j L_j^T Ginv
    const K = new Array(ns);
    for (let j = 0; j < ns; j++) {
      const col = Lw[j], row = new Float64Array(nch);
      for (let a = 0; a < nch; a++) { const x = col[a]; if (x === 0) continue; const Ga = Ginv[a]; for (let b = 0; b < nch; b++) row[b] += x * Ga[b]; }
      for (let b = 0; b < nch; b++) row[b] *= w[j];
      K[j] = row;
    }
    // normalization per location
    const norm = new Float64Array(grid.n).fill(1);
    if (opts.method === 'dspm' || opts.method === 'sloreta') {
      for (let i = 0; i < grid.n; i++) {
        let s = 0;
        if (opts.method === 'dspm') { for (let k = 0; k < 2; k++) { const r = K[2 * i + k]; for (let c = 0; c < nch; c++) s += r[c] * r[c]; } }
        else { for (let k = 0; k < 2; k++) { const r = K[2 * i + k], col = Lw[2 * i + k]; let d = 0; for (let c = 0; c < nch; c++) d += r[c] * col[c]; s += w[2 * i + k] * d; } }
        norm[i] = Math.sqrt(s / 2) || 1;
      }
    }
    return { K, norm, method: opts.method || 'mne', apply(v) { return sourcePower(K, norm, v, grid.n); } };
  }
  function sourcePower(K, norm, v, n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0, b = 0; const r0 = K[2 * i], r1 = K[2 * i + 1];
      for (let c = 0; c < v.length; c++) { a += r0[c] * v[c]; b += r1[c] * v[c]; }
      out[i] = Math.sqrt(a * a + b * b) / norm[i];
    }
    return out;
  }

  /* ---------- LCMV beamformer ----------
     Whitened data covariance C, regularized by `reg` times its mean
     diagonal.  For each location, A = L^T C^-1 L (2 x 2); the best
     orientation is the eigenvector of A with the smallest eigenvalue, whose
     inverse is the filter's output power.  Dividing by the power the same
     filter passes from the noise covariance N (measured in the baseline)
     gives the neural activity index, which removes the bias toward the
     centre of the head. */
  function lcmv(model, Cw, Nw, opts) {
    opts = opts || {};
    const { Lw, grid } = model, nch = Lw[0].length;
    const reg = opts.reg === undefined ? 0.05 : opts.reg;
    const C = Cw.map(r => Float64Array.from(r));
    let md = 0; for (let a = 0; a < nch; a++) md += C[a][a]; md /= nch;
    for (let a = 0; a < nch; a++) C[a][a] += reg * md;
    const Ci = la.inverse(C);
    const out = new Float32Array(grid.n), oris = [];
    const tmp0 = new Float64Array(nch), tmp1 = new Float64Array(nch), wv = new Float64Array(nch);
    for (let i = 0; i < grid.n; i++) {
      const L0 = Lw[2 * i], L1 = Lw[2 * i + 1];
      for (let a = 0; a < nch; a++) { const Ca = Ci[a]; let s0 = 0, s1 = 0; for (let b = 0; b < nch; b++) { s0 += Ca[b] * L0[b]; s1 += Ca[b] * L1[b]; } tmp0[a] = s0; tmp1[a] = s1; }
      let a00 = 0, a01 = 0, a11 = 0;
      for (let a = 0; a < nch; a++) { a00 += L0[a] * tmp0[a]; a01 += L0[a] * tmp1[a]; a11 += L1[a] * tmp1[a]; }
      const tr = a00 + a11, det = a00 * a11 - a01 * a01, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const lmin = Math.max(tr / 2 - disc, 1e-30);
      let ex = a01, ey = lmin - a00; if (Math.abs(ex) + Math.abs(ey) < 1e-30) { ex = 1; ey = 0; }
      const en = Math.hypot(ex, ey); ex /= en; ey /= en;
      const power = 1 / lmin;
      // the unit-gain filter w = C^-1 l / (l^T C^-1 l) and the noise it passes, w^T N w
      for (let a = 0; a < nch; a++) wv[a] = (ex * tmp0[a] + ey * tmp1[a]) / lmin;
      let nn = 0;
      if (Nw) { for (let a = 0; a < nch; a++) { const Na = Nw[a]; let s = 0; for (let b = 0; b < nch; b++) s += Na[b] * wv[b]; nn += wv[a] * s; } }
      else { for (let a = 0; a < nch; a++) nn += wv[a] * wv[a]; }
      out[i] = opts.normalize === false ? power : power / Math.max(nn, 1e-30);
      oris.push([ex, ey]);
    }
    return { power: out, oris };
  }

  /* ---------- one model per array ----------
     opts.project(col), when given, is applied to every lead field in
     field units before whitening: the SSP projection (and the zeroed bad
     channels) the data went through, so the model sees what the data saw.
     modelSteps yields its progress, so a page can build it in slices. */
  function* modelSteps(ds, opts) {
    opts = opts || {};
    const grid = sourceGrid(opts.spacing || 0.6);
    const chans = headChannels(ds), nch = chans.length;
    const white = channelNoise(ds, opts.bandwidth || 40);
    const proj = opts.project || null;
    const Ld = new Array(2 * grid.n), tmp = new Float64Array(3 * nch);
    for (let i = 0; i < grid.n; i++) {
      MEG.leadfieldMEG(chans, grid.pts[i], tmp);
      for (let k = 0; k < 2; k++) {
        const o = grid.ori[i][k], col = new Float64Array(nch);
        for (let c = 0; c < nch; c++) col[c] = tmp[3 * c] * o[0] + tmp[3 * c + 1] * o[1] + tmp[3 * c + 2] * o[2];
        if (proj) proj(col);
        for (let c = 0; c < nch; c++) col[c] /= white[c];
        Ld[2 * i + k] = col;
      }
      if (i % 500 === 499) yield 0.35 * i / grid.n;
    }
    // the signal space: the leading eigenvectors of the lead fields' Gram matrix
    const Gm = la.zeros(nch, nch);
    for (let j = 0; j < Ld.length; j++) {
      const col = Ld[j];
      for (let a = 0; a < nch; a++) { const x = col[a]; if (x === 0) continue; const Ga = Gm[a]; for (let b = a; b < nch; b++) Ga[b] += x * col[b]; }
      if (j % 1500 === 1499) yield 0.35 + 0.3 * j / Ld.length;
    }
    for (let a = 0; a < nch; a++) for (let b = 0; b < a; b++) Gm[a][b] = Gm[b][a];
    yield 0.65;
    const { values, vectors } = la.eigSym(Gm);
    const tol = opts.tol || 1e-5;
    let r = 0; while (r < nch && values[r] > tol * values[0]) r++;
    const U = Array.from({ length: r }, (_, k) => Float64Array.from(vectors, row => row[k]));
    yield 0.8;
    const Lr = new Array(Ld.length);
    for (let j = 0; j < Ld.length; j++) { Lr[j] = project(U, Ld[j]); if (j % 2000 === 1999) yield 0.8 + 0.2 * j / Ld.length; }
    return { grid, chans, white, U, r, Lr, type: ds.array.type, project: proj };
  }
  function buildModel(ds, opts) {
    const it = modelSteps(ds, opts);
    let s; do { s = it.next(); } while (!s.done);
    return s.value;
  }
  // The same, awaiting tick(fraction) between slices (tick may throw to abandon the build).
  async function buildModelAsync(ds, opts, tick) {
    const it = modelSteps(ds, opts);
    let s; do { s = it.next(); if (!s.done && tick) await tick(s.value); } while (!s.done);
    return s.value;
  }
  // withWhitener in slices.
  async function withWhitenerAsync(model, Wh, tick) {
    const r = Wh.r, Lw = new Array(model.Lr.length);
    for (let j = 0; j < Lw.length; j++) {
      const col = model.Lr[j];
      Lw[j] = Float64Array.from(Wh.W, row => { let s = 0; for (let k = 0; k < r; k++) s += row[k] * col[k]; return s; });
      if (tick && j % 3000 === 2999) await tick(j / Lw.length);
    }
    return Object.assign({}, model, { Lw, Wh });
  }

  // Peaks of a volume image: local maxima above `frac` of the global maximum, best first.
  function peaks(model, img, frac, minSep) {
    const g = model.grid, key = (i, j, k) => (i + g.lim) + (2 * g.lim + 1) * ((j + g.lim) + (2 * g.lim + 1) * (k + g.lim));
    const index = new Map(); g.ijk.forEach(([i, j, k], n) => index.set(key(i, j, k), n));
    let mx = 0; img.forEach(x => { mx = Math.max(mx, x); });
    const out = [];
    g.ijk.forEach(([i, j, k], n) => {
      const v = img[n]; if (v < frac * mx) return;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
        if (!di && !dj && !dk) continue;
        const m = index.get(key(i + di, j + dj, k + dk));
        if (m !== undefined && img[m] > v) return;
      }
      out.push({ n, pos: g.pts[n], value: v });
    });
    out.sort((a, b) => b.value - a.value);
    const kept = [];
    out.forEach(p => { if (kept.every(q => v3.norm(v3.sub(q.pos, p.pos)) >= (minSep || 2))) kept.push(p); });
    return kept;
  }
  // Volume above half the maximum, in cm^3: how spread out an estimate is.
  function spread(model, img, frac) {
    let mx = 0; img.forEach(x => { mx = Math.max(mx, x); });
    let n = 0; img.forEach(x => { if (x >= (frac || 0.5) * mx) n++; });
    return n * Math.pow(model.grid.spacing, 3);
  }

  MEG.inverse = { sourceGrid, headChannels, channelNoise, gridLeadfield, signalSpace, scenario, statistics, scenarioData, scenarioStats, waveforms, fastNormal, EPOCH, reduceVec, reduceRows, reduceCov, whitener, whitenerR, whitenVec, whitenVecR, whitenCov, whitenCovR, withWhitener, withWhitenerAsync, columnsAt, dipoleFit, dipoleFit2, confidence, residualAt, lsq, minimumNorm, lcmv, modelSteps, buildModel, buildModelAsync, peaks, spread, solve2 };
})(typeof window !== 'undefined' ? window : globalThis);
