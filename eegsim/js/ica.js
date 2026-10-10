/* EEG simulator: independent component analysis.
   FastICA with the symmetric update and a tanh contrast, after PCA
   whitening.  The recording model x = A s is exactly what the simulator
   builds, so the components can be checked against the generators that
   really made the data. */
(function (G) {
  'use strict';
  const EEG = G.EEG, la = EEG.la;

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
    const hp = opts.highpass ? EEG.dsp.butter('high', 2, opts.highpass, opts.fs) : null;
    for (let c = 0; c < nCh; c++) {
      let src = rows[c];
      if (hp) { src = Float64Array.from(src); EEG.dsp.filtfilt(hp, src, Math.round(3 * opts.fs / opts.highpass)); }
      const x = new Float64Array(m);
      for (let j = 0; j < m; j++) x[j] = src[Math.floor(j * stride)];
      X.push(x);
    }
    const mean = X.map(x => EEG.mean(x));
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
    const rng = EEG.rng(opts.seed || 7);
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
      // Components that are close to Gaussian (background EEG, sensor noise)
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

  EEG.ica = { fit, activations, clean };
})(typeof window !== 'undefined' ? window : globalThis);
