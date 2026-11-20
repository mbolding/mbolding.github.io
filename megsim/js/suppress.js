/* MEG simulator: removing what the room let through.

   Four software methods, applied in this order after the recording:

   Reference compensation.  A few magnetometers high in the dewar see the
   environment but hardly any brain.  The environment near the head is
   close to a uniform field plus a linear gradient (eight numbers), and the
   references measure those eight numbers, so each channel's share can be
   predicted and subtracted.  Weights come from the geometry, as in CTF's
   synthetic gradiometers.

   Signal space separation (Taulu and Kajola, 2005).  Outside the sources
   the field is a sum of vector spherical harmonics.  Terms that grow with
   distance from the centre of the head come from outside the helmet;
   terms that fall off come from inside it.  Fitting both and keeping only
   the inside part removes the environment by geometry alone.  The temporal
   extension (tSSS) also removes sources close to the sensors, which leak
   into both parts with the same time course.  Recomputing the inside part
   for each head position and rebuilding it for one fixed position is
   movement compensation.

   Signal space projection (Uusitalo and Ilmoniemi, 1997).  The directions
   in sensor space that the noise occupies, here from an empty-room
   recording or from averaged heartbeats and blinks, are projected out of
   every sample.  Brain signals lose whatever part of them points the same
   way, so the forward model must be projected too. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, la = MEG.la;

  /* ---------- small helpers on channel x time data ---------- */
  // Y (rows) -> A Y, for A given as rows (k x nch).  Blocked over time.
  function mulRows(A, Y, n) {
    const k = A.length, nch = Y.length, out = [];
    for (let i = 0; i < k; i++) out.push(new Float32Array(n));
    const B = 2048, acc = new Float64Array(B);
    for (let s = 0; s < n; s += B) {
      const e = Math.min(n, s + B), L = e - s;
      for (let i = 0; i < k; i++) {
        acc.fill(0, 0, L);
        const Ai = A[i];
        for (let c = 0; c < nch; c += 4) {
          const w0 = Ai[c] || 0, w1 = c + 1 < nch ? Ai[c + 1] : 0, w2 = c + 2 < nch ? Ai[c + 2] : 0, w3 = c + 3 < nch ? Ai[c + 3] : 0;
          const y0 = Y[c], y1 = Y[Math.min(c + 1, nch - 1)], y2 = Y[Math.min(c + 2, nch - 1)], y3 = Y[Math.min(c + 3, nch - 1)];
          for (let t = 0; t < L; t++) acc[t] += w0 * y0[s + t] + w1 * y1[s + t] + w2 * y2[s + t] + w3 * y3[s + t];
        }
        const o = out[i];
        for (let t = 0; t < L; t++) o[s + t] = acc[t];
      }
    }
    return out;
  }
  MEG.mulRows = mulRows;

  /* ---------- reference compensation ---------- */
  // The eight fields: uniform along x, y, z, and the five independent
  // gradients of a current-free field (a symmetric, traceless matrix).
  const BASIS = [
    r => [1, 0, 0], r => [0, 1, 0], r => [0, 0, 1],
    r => [r[0], -r[1], 0], r => [0, r[1], -r[2]], r => [r[1], r[0], 0], r => [r[2], 0, r[0]], r => [0, r[2], r[1]]
  ];
  function responses(chans) {
    return chans.map(ch => Float64Array.from(BASIS, f => {
      let s = 0; ch.pts.forEach(p => { const b = f(p.r); s += p.w * (p.n[0] * b[0] + p.n[1] * b[1] + p.n[2] * b[2]); }); return s;
    }));
  }
  /* Weights W (nch x nref): channel prediction = W ref.  For OPMs, whose
     sensors ride on the head, the geometry is taken at the starting pose. */
  function refWeights(ds) {
    const arr = ds.array;
    const chans = arr.frame === 'head' ? arr.channels.map(c => ({ pts: MEG.pointsIn(Object.assign({ frame: 'head' }, c), 'head', 'device', ds.pose.ref) })) : arr.channels;
    const Pc = responses(chans), Pr = responses(arr.refs);
    const { P } = la.pinv(Pr, 1e-10);              // 8 x nref
    return Pc.map(row => { const w = new Float64Array(arr.refs.length); for (let j = 0; j < w.length; j++) { let s = 0; for (let k = 0; k < 8; k++) s += row[k] * P[k][j]; w[j] = s; } return w; });
  }
  function applyRefs(rows, refs, W) {
    const n = rows[0].length;
    const pred = mulRows(W, refs, n);
    return rows.map((r, c) => { const o = new Float32Array(n), p = pred[c]; for (let i = 0; i < n; i++) o[i] = r[i] - p[i]; return o; });
  }

  /* ---------- signal space projection ---------- */
  /* Projectors from an empty-room recording: the environment and the line
     field as they reach the sensors (with or without the room), plus sensor
     noise.  Their covariance comes straight from the generators' patterns
     and time courses, after the online high-pass, so no data are needed. */
  function emptyRoomCov(ds, opts) {
    const arr = ds.array, T = ds.topo, nch = arr.nch, room = opts.room;
    const gens = ds.gens.map((g, gi) => ({ g, gi })).filter(x => x.g.group === 'environment' || x.g.group === 'line');
    const R = ds.cfg.recording, fs = ds.fs;
    const sos = R.hp ? MEG.dsp.butter('high', 1, Math.max(R.hp, 0.1), fs) : MEG.dsp.butter('high', 1, 0.1, fs);
    const step = Math.max(1, Math.floor(ds.n / 20000));
    const tcs = gens.map(({ g }) => {
      const tc = Float64Array.from(room ? g.tcRoom : g.tcOpen);
      MEG.dsp.sosfilt(sos, tc);
      const sub = []; for (let i = 0; i < tc.length; i += step) sub.push(tc[i]);
      return Float64Array.from(sub);
    });
    const m = tcs.length, N = tcs[0] ? tcs[0].length : 1;
    const Ct = la.zeros(m, m);
    for (let a = 0; a < m; a++) for (let b = a; b < m; b++) { let s = 0; for (let i = 0; i < N; i++) s += tcs[a][i] * tcs[b][i]; Ct[a][b] = Ct[b][a] = s / N; }
    const A = gens.map(({ gi }) => T.static[gi]);
    const C = la.zeros(nch, nch);
    for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) {
      const w = Ct[a][b]; if (w === 0) continue;
      const Aa = A[a], Ab = A[b];
      for (let i = 0; i < nch; i++) { const x = w * Aa[i]; if (x === 0) continue; const Ci = C[i]; for (let j = 0; j < nch; j++) Ci[j] += x * Ab[j]; }
    }
    const dens = R.noise || arr.noise, nv = dens * dens * Math.min(fs / 2, R.lp || fs / 2);
    for (let i = 0; i < nch; i++) C[i][i] += nv;
    return C;
  }
  // The k leading directions of a covariance, as unit columns.
  function topVectors(C, k) {
    const { values, vectors } = la.eigSym(C);
    const out = [];
    for (let j = 0; j < k; j++) out.push({ v: Float64Array.from(vectors, r => r[j]), value: values[j], share: values[j] / values.reduce((a, b) => a + Math.max(0, b), 0) });
    return out;
  }
  function sspEmptyRoom(ds, k, opts) { return topVectors(emptyRoomCov(ds, opts || { room: ds.cfg.shielding.room }), k).map((x, i) => Object.assign(x, { label: `Empty room ${i + 1}`, kind: 'room' })); }
  /* A projector from an artifact's own events: the average field over a
     short window around each heartbeat or blink, and its first principal
     component in sensor space. */
  function sspFromEvents(rows, fs, times, win, label, kind) {
    const nch = rows.length, n = rows[0].length, a = Math.round(win[0] * fs), b = Math.round(win[1] * fs), L = b - a;
    const avg = rows.map(() => new Float64Array(L));
    let cnt = 0;
    times.forEach(t => { const c = Math.round(t * fs); if (c + a < 0 || c + b >= n) return; cnt++; for (let ch = 0; ch < nch; ch++) { const r = rows[ch], o = avg[ch]; for (let i = 0; i < L; i++) o[i] += r[c + a + i]; } });
    if (!cnt) return null;
    avg.forEach(o => { let m = 0; for (let i = 0; i < L; i++) { o[i] /= cnt; m += o[i]; } m /= L; for (let i = 0; i < L; i++) o[i] -= m; });
    const C = la.zeros(nch, nch);
    for (let i = 0; i < nch; i++) for (let j = i; j < nch; j++) { let s = 0; const x = avg[i], y = avg[j]; for (let t = 0; t < L; t++) s += x[t] * y[t]; C[i][j] = C[j][i] = s; }
    const top = topVectors(C, 1)[0];
    return Object.assign(top, { label, kind, events: cnt });
  }
  // Orthonormalize a set of projection vectors (Gram-Schmidt) and project.
  function orthonormal(vecs) {
    const out = [];
    vecs.forEach(v => {
      const u = Float64Array.from(v);
      out.forEach(w => { let d = 0; for (let i = 0; i < u.length; i++) d += u[i] * w[i]; for (let i = 0; i < u.length; i++) u[i] -= d * w[i]; });
      let nn = 0; for (let i = 0; i < u.length; i++) nn += u[i] * u[i]; nn = Math.sqrt(nn);
      if (nn > 1e-8) { for (let i = 0; i < u.length; i++) u[i] /= nn; out.push(u); }
    });
    return out;
  }
  function applySSP(rows, U) {
    if (!U.length) return rows;
    const n = rows[0].length, coef = mulRows(U, rows, n), nch = rows.length;
    return rows.map((r, c) => {
      const o = Float32Array.from(r);
      U.forEach((u, k) => { const w = u[c]; if (w === 0) return; const x = coef[k]; for (let i = 0; i < n; i++) o[i] -= w * x[i]; });
      return o;
    });
  }
  // The share of a pattern's power that the projection removes.
  function projectionLoss(a, U) {
    let tot = 0; a.forEach(x => { tot += x * x; });
    let kept = 0; U.forEach(u => { let d = 0; for (let i = 0; i < a.length; i++) d += u[i] * a[i]; kept += d * d; });
    return tot > 0 ? kept / tot : 0;
  }
  function projectVector(a, U) {
    const o = Float64Array.from(a);
    U.forEach(u => { let d = 0; for (let i = 0; i < a.length; i++) d += u[i] * a[i]; for (let i = 0; i < a.length; i++) o[i] -= d * u[i]; });
    return o;
  }

  /* ---------- signal space separation ---------- */
  // Real spherical harmonics up to degree L as solid harmonics:
  // r^-(l+1) Y_lm (inner, fall off) or r^l Y_lm (outer, grow).
  const NORM = [];
  (function () {
    const fact = [1]; for (let i = 1; i <= 30; i++) fact.push(fact[i - 1] * i);
    for (let l = 0; l <= 12; l++) { NORM.push([]); for (let m = 0; m <= l; m++) NORM[l].push(Math.sqrt((2 * l + 1) / (4 * Math.PI) * fact[l - m] / fact[l + m]) * (m ? Math.SQRT2 : 1)); }
  })();
  const PLM = Array.from({ length: 13 }, () => new Float64Array(13));
  function solid(x, y, z, L, inner, out) {
    const r = Math.sqrt(x * x + y * y + z * z), ct = z / r, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = Math.atan2(y, x);
    for (let m = 0; m <= L; m++) {
      let pmm = 1;
      for (let k = 1; k <= m; k++) pmm *= -(2 * k - 1) * st;
      PLM[m][m] = pmm;
      if (m < L) PLM[m + 1][m] = ct * (2 * m + 1) * pmm;
      for (let l = m + 2; l <= L; l++) PLM[l][m] = ((2 * l - 1) * ct * PLM[l - 1][m] - (l + m - 1) * PLM[l - 2][m]) / (l - m);
    }
    let idx = 0;
    for (let l = 1; l <= L; l++) {
      const rl = inner ? Math.pow(r, -l - 1) : Math.pow(r, l);
      for (let m = -l; m <= l; m++) {
        const am = Math.abs(m), base = NORM[l][am] * PLM[l][am] * rl;
        out[idx++] = m > 0 ? base * Math.cos(m * ph) : m < 0 ? base * Math.sin(am * ph) : base;
      }
    }
    return out;
  }
  MEG.solidHarmonics = solid;
  /* The SSS basis for a set of channels whose points are given relative to
     the expansion origin: one column per term, the channel's reading of the
     field -grad(r^-(l+1) Y_lm) (inner) or -grad(r^l Y_lm) (outer), each
     column scaled to unit length. */
  function basis(chans, L, inner) {
    const nt = L * (L + 2), nch = chans.length, S = la.zeros(nch, nt);
    const fp = new Float64Array(nt), fm = new Float64Array(nt), h = 1e-3;
    chans.forEach((ch, c) => {
      const row = S[c];
      ch.pts.forEach(p => {
        for (let d = 0; d < 3; d++) {
          if (p.n[d] === 0) continue;
          const a = p.r.slice(), b = p.r.slice(); a[d] += h; b[d] -= h;
          solid(a[0], a[1], a[2], L, inner, fp); solid(b[0], b[1], b[2], L, inner, fm);
          const k = -p.w * p.n[d] / (2 * h);
          for (let t = 0; t < nt; t++) row[t] += k * (fp[t] - fm[t]);
        }
      });
    });
    const scale = new Float64Array(nt);
    for (let t = 0; t < nt; t++) { let s = 0; for (let c = 0; c < nch; c++) s += S[c][t] * S[c][t]; scale[t] = Math.sqrt(s) || 1; for (let c = 0; c < nch; c++) S[c][t] /= scale[t]; }
    return { S, nt, scale };
  }
  MEG.sssBasisFor = basis;
  function defaultOrder(nch) { return nch >= 250 ? [8, 3] : [6, 3]; }
  /* SSS can only tell inside from outside if the array measures the field
     in more than one way at each place.  On one helmet surface, a single
     kind of sensor sees an inside source and an outside one with almost the
     same pattern; the 306-style array, with a magnetometer and two planar
     gradiometers at every site, does not.  (Measured on this simulator's
     helmet: with magnetometers alone the inside and outside expansions
     reproduce each other to 1 part in 10^4.) */
  function sssAvailable(arr) { return arr.type === 'planar'; }
  const SSS_WHY = {
    mag: 'Magnetometers alone measure only the field normal to one helmet surface, where a source inside and a source outside produce almost the same pattern. SSS needs the field and its gradient at each site, as in the 306-channel arrays (choose planar gradiometers).',
    axial: 'Axial gradiometers alone cannot tell the expansions apart well enough on this helmet; CTF systems rely on their reference array instead. SSS here needs the 306-channel style array (planar gradiometers with magnetometers).',
    opm: 'Every OPM is the same distance from the centre of the head and measures one component of the field, so inside and outside are indistinguishable. Multi-axis OPMs make SSS possible again.'
  };

  /* Channel points relative to the inner origin (the centre of the head, in
     head coordinates) and to the outer origin (the centre of the helmet). */
  function chansForPose(ds, pose) {
    const arr = ds.array;
    if (arr.frame === 'head') {
      const inner = arr.channels;
      const outer = arr.channels.map(c => ({ pts: MEG.pointsIn(Object.assign({ frame: 'head' }, c), 'head', 'device', pose) }));
      return { inner, outer };
    }
    const inner = arr.channels.map(c => ({ pts: MEG.pointsIn(Object.assign({ frame: 'device' }, c), 'device', 'head', pose) }));
    return { inner, outer: arr.channels };
  }
  function sssModel(ds, pose, order) {
    const [Lin, Lout] = order;
    const ch = chansForPose(ds, pose);
    const Bin = basis(ch.inner, Lin, true), Bout = basis(ch.outer, Lout, false);
    const nch = ds.array.nch, nin = Bin.nt, nout = Bout.nt;
    const S = la.zeros(nch, nin + nout);
    for (let c = 0; c < nch; c++) { S[c].set(Bin.S[c], 0); S[c].set(Bout.S[c], nin); }
    const pv = la.pinv(S, 1e-7);
    const { values } = pv;
    const cond = Math.sqrt(Math.max(values[0], 0) / Math.max(values[values.length - 1], 1e-300));
    return { Sin: Bin.S, Sout: Bout.S, P: pv.P, nin, nout, rank: pv.rank, cond, order };
  }
  MEG.sssModel = sssModel;

  /* Apply SSS to channel data.  opts: { order, tsss, corr, buffer (s),
     compensate (rebuild at the reference pose), moving (the head moves),
     cache (a Map that keeps the per-second models between calls) }.
     progress(fraction) is awaited now and then.  Returns { rows, info }. */
  async function applySSS(ds, rows, opts, progress) {
    opts = opts || {};
    const nch = rows.length, n = rows[0].length, fs = ds.fs;
    const order = opts.order || defaultOrder(nch);
    const ref = ds.pose.ref;
    const moving = !!opts.moving && ds.array.frame === 'device';
    const compensate = !!opts.compensate && moving;
    const chunk = compensate ? Math.round(1 * fs) : n;
    const out = rows.map(() => new Float32Array(n));
    const model0 = sssModel(ds, ref, order);
    let info = { order, nin: model0.nin, nout: model0.nout, cond: model0.cond, rank: model0.rank, removed: 0, windows: 0 };
    // Coefficients: X = P Y, inside and outside parts
    const coefIn = model0.Sin[0].length;
    const Xin = [], Xout = [];
    for (let k = 0; k < model0.nin; k++) Xin.push(new Float32Array(n));
    for (let k = 0; k < model0.nout; k++) Xout.push(new Float32Array(n));
    const models = [];
    const cache = opts.cache || null;
    for (let s = 0; s < n; s += chunk) {
      const e = Math.min(n, s + chunk);
      const key = order.join(',') + ':' + s;
      let model = model0;
      if (compensate) {
        model = cache && cache.has(key) ? cache.get(key) : sssModel(ds, ds.pose.at((s + e) / 2 / fs), order);
        if (cache) cache.set(key, model);
      }
      models.push({ s, e, model });
      const Ys = rows.map(r => r.subarray(s, e));
      const X = mulRows(model.P, Ys, e - s);
      for (let k = 0; k < model.nin; k++) Xin[k].set(X[k], s);
      for (let k = 0; k < model.nout; k++) Xout[k].set(X[model.nin + k], s);
      if (progress && compensate) await progress(0.6 * e / n);
    }
    // tSSS: remove time courses shared by the inside and outside parts
    if (opts.tsss) {
      const win = Math.round((opts.buffer || 10) * fs), lim = opts.corr || 0.98;
      for (let s = 0; s < n; s += win) {
        const e = Math.min(n, s + win); if (e - s < fs) continue;
        const A = Xin.map(x => x.subarray(s, e)), B = Xout.map(x => x.subarray(s, e));
        const Q = tsssVectors(A, B, lim);
        const L = e - s;
        Q.forEach(q => {
          A.forEach(x => { let d = 0; for (let t = 0; t < L; t++) d += x[t] * q[t]; for (let t = 0; t < L; t++) x[t] -= d * q[t]; });
        });
        info.removed += Q.length; info.windows++;
        if (progress) await progress(0.6 + 0.3 * e / n);
      }
    }
    // Rebuild the inside part, at the starting head position when compensating
    const Sref = compensate ? model0.Sin : null;
    models.forEach(({ s, e, model }) => {
      const S = Sref || model.Sin, L = e - s;
      const X = Xin.map(x => x.subarray(s, e));
      const Y = mulRows(S, X, L);
      for (let c = 0; c < nch; c++) out[c].set(Y[c], s);
    });
    if (progress) await progress(1);
    info.coefIn = coefIn;
    info.Xout = opts.keepOuter ? Xout : null;
    return { rows: out, info, model: model0 };
  }
  /* tSSS: the time courses shared by the inside and the outside parts of
     one window.  The squared cosines of the angles between the two row
     spaces are the eigenvalues of (Uin^T Uout)^T (Uin^T Uout); directions
     whose cosine passes `lim` are returned as orthonormal time vectors. */
  function tsssVectors(A, B, lim) {
    const Uin = rowBasis(A), Uout = rowBasis(B);
    if (!Uin.length || !Uout.length) return [];
    const L = A[0].length, M = la.zeros(Uout.length, Uout.length);
    const G = Uin.map(u => Float64Array.from(Uout, w => { let d = 0; for (let t = 0; t < L; t++) d += u[t] * w[t]; return d; }));
    for (let a = 0; a < Uout.length; a++) for (let b = 0; b < Uout.length; b++) { let d = 0; for (let i = 0; i < G.length; i++) d += G[i][a] * G[i][b]; M[a][b] = d; }
    const { values, vectors } = la.eigSym(M);
    const bad = [];
    values.forEach((v, j) => { if (Math.sqrt(Math.max(0, v)) > lim) { const q = new Float64Array(L); for (let a = 0; a < Uout.length; a++) { const w = vectors[a][j], u = Uout[a]; for (let t = 0; t < L; t++) q[t] += w * u[t]; } bad.push(q); } });
    return orthonormal(bad);
  }

  /* The noise budget: the same rejection applied to the contributions of
     single signals over one short window.  Every step is linear, so the
     parts still add up to the whole; tSSS's temporal projection is found
     from the whole and then applied to every part.  parts: [{ rows, refs }],
     opts: { W, sss: { order, tsss, corr, compensate, moving, t (window
     centre, s) }, U }.  Returns the processed rows of each part. */
  function decompose(ds, parts, opts) {
    opts = opts || {};
    const nch = ds.array.nch, n = parts[0].rows[0].length;
    let cur = parts.map(p => p.rows);
    if (opts.W) cur = cur.map((rows, k) => applyRefs(rows, parts[k].refs, opts.W));
    if (opts.sss) {
      const o = opts.sss, order = o.order || defaultOrder(nch);
      const compensate = !!o.compensate && !!o.moving && ds.array.frame === 'device';
      const model0 = sssModel(ds, ds.pose.ref, order);
      const model = compensate ? sssModel(ds, ds.pose.at(o.t || 0), order) : model0;
      const Pin = model.P.slice(0, model.nin), Pout = model.P.slice(model.nin);
      const Xin = cur.map(rows => mulRows(Pin, rows, n));
      if (o.tsss) {
        const Xout = cur.map(rows => mulRows(Pout, rows, n));
        const total = X => X[0].map((_, k) => { const t = new Float64Array(n); X.forEach(Xp => { const x = Xp[k]; for (let i = 0; i < n; i++) t[i] += x[i]; }); return t; });
        const Q = tsssVectors(total(Xin), total(Xout), o.corr || 0.98);
        Xin.forEach(X => Q.forEach(q => X.forEach(x => { let d = 0; for (let t = 0; t < n; t++) d += x[t] * q[t]; for (let t = 0; t < n; t++) x[t] -= d * q[t]; })));
      }
      cur = Xin.map(X => mulRows(model0.Sin, X, n));
    }
    if (opts.U && opts.U.length) cur = cur.map(rows => applySSP(rows, opts.U));
    return cur;
  }

  // Orthonormal basis of the row space (in time) of a few rows of data.
  function rowBasis(A) {
    const k = A.length, L = A[0].length;
    const C = la.zeros(k, k);
    for (let i = 0; i < k; i++) for (let j = i; j < k; j++) { let s = 0; const x = A[i], y = A[j]; for (let t = 0; t < L; t++) s += x[t] * y[t]; C[i][j] = C[j][i] = s; }
    const { values, vectors } = la.eigSym(C);
    const out = [];
    for (let j = 0; j < k; j++) {
      if (!(values[j] > values[0] * 1e-8)) break;
      const u = new Float64Array(L), sc = 1 / Math.sqrt(values[j]);
      for (let i = 0; i < k; i++) { const w = vectors[i][j] * sc; if (w === 0) continue; const x = A[i]; for (let t = 0; t < L; t++) u[t] += w * x[t]; }
      out.push(u);
    }
    return out;
  }
  /* The same operation on one pattern (a sensor-space vector): what SSS
     does to a brain source's field, without movement. */
  function sssProjectPattern(model, a) {
    const nin = model.nin;
    const x = new Float64Array(nin);
    for (let k = 0; k < nin; k++) { let s = 0; const Pk = model.P[k]; for (let c = 0; c < a.length; c++) s += Pk[c] * a[c]; x[k] = s; }
    return Float64Array.from(model.Sin, row => { let s = 0; for (let k = 0; k < nin; k++) s += row[k] * x[k]; return s; });
  }

  MEG.suppress = { sssAvailable, SSS_WHY, refWeights, applyRefs, emptyRoomCov, sspEmptyRoom, sspFromEvents, orthonormal, applySSP, projectionLoss, projectVector, applySSS, sssModel, sssProjectPattern, defaultOrder, mulRows, decompose, tsssVectors };
})(typeof window !== 'undefined' ? window : globalThis);
