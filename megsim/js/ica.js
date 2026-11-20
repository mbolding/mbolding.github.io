/* MEG simulator: independent component analysis.
   FastICA with the symmetric update and a tanh contrast, after PCA
   whitening.  The recording model x = A s is exactly what the simulator
   builds, so the components can be checked against the generators that
   really made the data. */
(function (G) {
  'use strict';
  const MEG = G.MEG, la = MEG.la;

  function symDecorrelate(W) {
    const k = W.length;
    const S = la.matmul(W, la.transpose(W));
    const { values, vectors: E } = la.eigSym(S);
    const D = la.zeros(k, k);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      let s = 0;
      for (let p = 0; p < k; p++) s += E[i][p] * E[j][p] / Math.sqrt(Math.max(values[p], 1e-12));
      D[i][j] = s;
    }
    return la.matmul(D, W);
  }

  /* rows: channel arrays.  opts: { k, maxSamples, highpass (Hz, for the
     fitting copy only), fs, seed }.  `progress(iter, change)` is called
     between batches of iterations so the page can stay responsive. */
  async function fit(rows, opts, progress) {
    const nCh = rows.length, n = rows[0].length;
    const m = Math.min(n, opts.maxSamples || 10000), stride = n / m;
    const X = [];
    const hp = opts.highpass ? MEG.dsp.butter('high', 2, opts.highpass, opts.fs) : null;
    for (let c = 0; c < nCh; c++) {
      let src = rows[c];
      if (hp) { src = Float64Array.from(src); MEG.dsp.filtfilt(hp, src, Math.round(3 * opts.fs / opts.highpass)); }
      const x = new Float64Array(m);
      for (let j = 0; j < m; j++) x[j] = src[Math.floor(j * stride)];
      X.push(x);
    }
    const mean = X.map(x => MEG.mean(x));
    X.forEach((x, c) => { const mu = mean[c]; for (let j = 0; j < m; j++) x[j] -= mu; });
    // covariance and PCA
    const C = la.zeros(nCh, nCh);
    for (let a = 0; a < nCh; a++) for (let b = a; b < nCh; b++) {
      let s = 0; const xa = X[a], xb = X[b];
      for (let j = 0; j < m; j++) s += xa[j] * xb[j];
      C[a][b] = C[b][a] = s / m;
    }
    const { values, vectors: E } = la.eigSym(C);
    let rank = 0; while (rank < nCh && values[rank] > values[0] * 1e-7) rank++;
    const k = Math.max(2, Math.min(opts.k || 20, rank));
    const totalVar = values.reduce((a, b) => a + Math.max(b, 0), 0);
    const pcaVar = values.slice(0, k).reduce((a, b) => a + b, 0);
    const V = la.zeros(k, nCh), Vinv = la.zeros(nCh, k);
    for (let i = 0; i < k; i++) {
      const s = Math.sqrt(values[i]);
      for (let c = 0; c < nCh; c++) { V[i][c] = E[c][i] / s; Vinv[c][i] = E[c][i] * s; }
    }
    const Z = la.zeros(k, m);
    for (let i = 0; i < k; i++) {
      const zi = Z[i], Vi = V[i];
      for (let c = 0; c < nCh; c++) { const w = Vi[c], xc = X[c]; for (let j = 0; j < m; j++) zi[j] += w * xc[j]; }
    }
    // FastICA, symmetric
    const rng = MEG.rng(opts.seed || 7);
    let W = symDecorrelate(Array.from({ length: k }, () => Float64Array.from({ length: k }, () => rng.gauss())));
    const Y = new Float64Array(m);
    let iter = 0, change = 1, prevChange = 1, mu = 1;
    const maxIter = opts.maxIter || 200, tol = opts.tol || 1e-4;
    for (; iter < maxIter; iter++) {
      const Wn = la.zeros(k, k);
      for (let i = 0; i < k; i++) {
        Y.fill(0);
        const Wi = W[i];
        for (let p = 0; p < k; p++) { const w = Wi[p], zp = Z[p]; for (let j = 0; j < m; j++) Y[j] += w * zp[j]; }
        let gp = 0;
        const row = Wn[i];
        for (let j = 0; j < m; j++) { const g = Math.tanh(Y[j]); Y[j] = g; gp += 1 - g * g; }
        gp /= m;
        for (let p = 0; p < k; p++) { let s = 0; const zp = Z[p]; for (let j = 0; j < m; j++) s += Y[j] * zp[j]; row[p] = s / m - gp * Wi[p]; }
      }
      let Wd = symDecorrelate(Wn);
      // Stabilized FastICA: once it starts to oscillate, take half steps
      if (mu < 1) {
        for (let i = 0; i < k; i++) {
          let d = 0; for (let p = 0; p < k; p++) d += Wd[i][p] * W[i][p];
          const sg = d < 0 ? -1 : 1;
          for (let p = 0; p < k; p++) Wd[i][p] = W[i][p] + mu * (sg * Wd[i][p] - W[i][p]);
        }
        Wd = symDecorrelate(Wd);
      }
      // Components that are close to Gaussian (background MEG, sensor noise)
      // have no preferred rotation and keep wandering, so convergence is
      // judged on the median per-component change.
      const ch = [];
      for (let i = 0; i < k; i++) { let d = 0; for (let p = 0; p < k; p++) d += Wd[i][p] * W[i][p]; ch.push(Math.abs(1 - Math.abs(d))); }
      ch.sort((a, b) => a - b);
      change = ch[Math.floor(0.5 * k)];
      W = Wd;
      if (change < tol) { iter++; break; }
      if (iter > 20 && change > prevChange && mu === 1) mu = 0.5;
      prevChange = change;
      if (iter % 4 === 3 && progress) await progress(iter + 1, change);
    }
    // unmixing U = W V and mixing A = Vinv W^T
    const U = la.matmul(W, V), A = la.matmul(Vinv, la.transpose(W));
    const comps = [];
    for (let i = 0; i < k; i++) {
      const topo = Float64Array.from(A, r => r[i]);
      let v = 0, big = 0; for (let c = 0; c < nCh; c++) { v += topo[c] * topo[c]; if (Math.abs(topo[c]) > Math.abs(big)) big = topo[c]; }
      const sg = big < 0 ? -1 : 1;
      comps.push({ topo: topo.map(x => x * sg), unmix: Float64Array.from(U[i], x => x * sg), variance: v });
    }
    comps.sort((a, b) => b.variance - a.variance);
    comps.forEach((c, i) => { c.index = i; c.pvaf = c.variance / totalVar; });
    return { k, comps, mean, iterations: iter, converged: change < tol, pcaVar: pcaVar / totalVar, nCh };
  }

  // Component activations over [i0, i1).
  function activations(model, rows, i0, i1) {
    const len = i1 - i0;
    return model.comps.map(c => {
      const s = new Float32Array(len);
      for (let ch = 0; ch < rows.length; ch++) {
        const w = c.unmix[ch], r = rows[ch], mu = model.mean[ch];
        if (w === 0) continue;
        for (let i = 0; i < len; i++) s[i] += w * (r[i0 + i] - mu);
      }
      return s;
    });
  }
  // Subtract the back-projection of the rejected components.
  function clean(model, rows, rejected) {
    const out = rows.map(r => Float32Array.from(r));
    const n = rows[0].length;
    rejected.forEach(ci => {
      const c = model.comps[ci]; if (!c) return;
      const s = activations({ comps: [c], mean: model.mean }, rows, 0, n)[0];
      for (let ch = 0; ch < out.length; ch++) { const a = c.topo[ch], o = out[ch]; for (let i = 0; i < n; i++) o[i] -= a * s[i]; }
    });
    return out;
  }

  /* What made each component, from the simulation's own generators.  Every
     step from a generator to a component's activation is linear: its pattern
     goes through the noise rejection as the data did (references, SSS, SSP),
     the component's unmixing row turns that pattern into a gain on its time
     course, and the time course goes through the online filters, the time
     courses tSSS projected out and the offline filters.  A signal's share of
     the activation's variance is how much of the component it made.  It is
     taken as the smaller of two numbers that agree when the signals are
     independent: the variance the signal adds, over the activation's, and
     the squared correlation of the two time courses.  The second stops two
     large signals that cancel in a component from naming it.  A map that
     merely looks like a blink's is not enough: on magnetometers many smooth
     maps correlate by 0.7 or more.  Patterns are taken at the starting head
     position.
     opts: { rows (the channels ICA was given, before scaling), sigma, sup
     (the page's S.sup), enabled (Set of group ids), room, chain (the
     offline filters) }.  Returns one { text, share, group } per component. */
  const SPLIT = { muscle: true, hpi: true };    // separate muscles and coils; other groups are taken whole
  function identify(ds, model, opts) {
    const R = ds.cfg.recording, fs = ds.fs, n = ds.n, arr = ds.array, nch = arr.nch, dsp = MEG.dsp;
    const online = [];
    if (R.hp) online.push(...dsp.butter('high', 1, R.hp, fs));
    if (R.lp && R.lp < fs / 2) online.push(...dsp.butter('low', 4, R.lp, fs));
    const step = Math.max(1, Math.floor(n / 10000)), m = Math.floor((n - 1) / step) + 1;
    // tSSS removed the same time courses from every channel, window by window
    const tq = opts.sup && opts.sup.info && opts.sup.info.tsss;
    const tsss = y => {
      if (tq) tq.forEach(({ s, Q }) => Q.forEach(q => {
        const L = q.length; let d = 0;
        for (let t = 0; t < L; t++) d += y[s + t] * q[t];
        for (let t = 0; t < L; t++) y[s + t] -= d * q[t];
      }));
    };
    // a time course through the filters, sampled every `step`, mean removed
    const sub = x => {
      const y = Float64Array.from(x);
      if (online.length) dsp.sosfilt(online, y);
      tsss(y);
      if (opts.chain && !opts.chain.empty) opts.chain.apply(y);
      const o = new Float64Array(m); let mu = 0;
      for (let j = 0; j < m; j++) { o[j] = y[j * step]; mu += o[j]; }
      mu /= m; for (let j = 0; j < m; j++) o[j] -= mu;
      return o;
    };
    const dot = (a, b) => { let s = 0; for (let j = 0; j < m; j++) s += a[j] * b[j]; return s / m; };
    // each component's unmixing row on the unscaled channels, its activation and that activation's variance
    const W = model.comps.map(c => Float64Array.from(c.unmix, (u, ch) => u / opts.sigma[ch]));
    const acts = W.map(w => {
      const a = new Float64Array(m);
      for (let ch = 0; ch < nch; ch++) { const wc = w[ch], r = opts.rows[ch]; if (!wc) continue; for (let j = 0; j < m; j++) a[j] += wc * r[j * step]; }
      let mu = 0; for (let j = 0; j < m; j++) mu += a[j]; mu /= m;
      for (let j = 0; j < m; j++) a[j] -= mu;
      return a;
    });
    const actVar = acts.map(a => dot(a, a) || 1);
    // v: the variance a signal adds to component i; cov: its covariance with the activation
    const share = (v, cov, i) => (v > 0 ? Math.min(v / actVar[i], cov * cov / (v * actVar[i])) : 0);
    // the candidates: each source and artifact as a whole (both auditory cortices
    // of one source share a waveform, both eyes blink together), each muscle and HPI coil apart
    const cands = new Map();
    ds.gens.forEach(g => {
      if (!opts.enabled.has(g.group) || g.kind === 'background') return;
      const info = MEG.ARTIFACT_INFO[g.group], grp = ds.groups.find(x => x.id === g.group);
      const key = SPLIT[g.group] ? g.group + '|' + g.label : g.group;
      const label = g.group === 'hpi' ? g.label : SPLIT[g.group] ? info.label + ': ' + g.label : info ? info.label : grp ? grp.label : g.label;
      if (!cands.has(key)) cands.set(key, { label, group: g.group, gens: [] });
      cands.get(key).gens.push(g);
    });
    const shares = model.comps.map(() => []);
    cands.forEach(cd => {
      const F = cd.gens.map(g => sub(g.tcRoom ? (opts.room ? g.tcRoom : g.tcOpen) : g.tc));
      const P = cd.gens.map(g => MEG.suppress.patternAfter(ds, opts.sup, g));
      const C = F.map(a => F.map(b => dot(a, b)));
      W.forEach((w, i) => {
        const gain = P.map(p => { let s = 0; for (let ch = 0; ch < nch; ch++) s += w[ch] * p[ch]; return s; });
        let v = 0, cov = 0;
        gain.forEach((ga, a) => { cov += ga * dot(F[a], acts[i]); gain.forEach((gb, b) => { v += ga * gb * C[a][b]; }); });
        shares[i].push({ label: cd.label, group: cd.group, share: share(v, cov, i) });
      });
    });
    // dental work is a magnet whose pattern changes as it moves, sampled at its own rate
    const T = ds.topo;
    if (opts.enabled.has('dental') && T.dental) {
      const D = (opts.enabled.has('movement') && T.dental.moving) || T.dental.still;
      const Dp = MEG.suppress.rowsAfter(opts.sup, D.slice(0, nch), D.slice(nch));
      const fsJ = ds.dental.fs, KJ = ds.dental.K;
      W.forEach((w, i) => {
        const d = new Float64Array(KJ);
        for (let ch = 0; ch < nch; ch++) { const wc = w[ch], r = Dp[ch]; if (!wc) continue; for (let k = 0; k < KJ; k++) d[k] += wc * r[k]; }
        const x = new Float64Array(n);
        for (let s = 0; s < n; s++) { const f = Math.min(KJ - 1.0001, s / fs * fsJ), k = Math.floor(f), u = f - k; x[s] = d[k] + (d[k + 1] - d[k]) * u; }
        const o = sub(x);
        shares[i].push({ label: MEG.ARTIFACT_INFO.dental.label, group: 'dental', share: share(dot(o, o), dot(o, acts[i]), i) });
      });
    }
    return model.comps.map((c, i) => {
      let best = shares[i].reduce((a, b) => (b.share > a.share ? b : a), { share: 0, label: null, group: null });
      // muscles that fire together can share a component: name them together when no one of them makes half of it
      Object.keys(SPLIT).forEach(gid => {
        const parts = shares[i].filter(x => x.group === gid && x.share >= 0.1).sort((a, b) => b.share - a.share);
        const sum = parts.reduce((a, x) => a + x.share, 0);
        if (parts.length > 1 && best.share < 0.5 && sum >= 0.5) best = { label: gid === 'hpi' ? parts.map(x => x.label).join(' and ') : `${MEG.ARTIFACT_INFO[gid].label}: ${parts.map(x => x.label.split(': ').pop()).join(' and ')}`, group: gid, share: sum };
      });
      let e = 0, mx = 0, at = 0; c.topo.forEach((x, ch) => { e += x * x; if (x * x > mx) { mx = x * x; at = ch; } });
      if (best.share >= 0.5) return { text: `≈ ${best.label}`, share: best.share, group: best.group };
      if (mx / e > 0.5) return { text: `one sensor, ${arr.channels[at].name}: a flux jump or a bad channel`, share: null, group: 'single' };
      if (best.share >= 0.1) return { text: `partly ${best.label}`, share: best.share, group: best.group };
      return { text: 'mixed: brain activity or noise', share: best.share, group: null };
    });
  }

  MEG.ica = { fit, activations, clean, identify };
})(typeof window !== 'undefined' ? window : globalThis);
