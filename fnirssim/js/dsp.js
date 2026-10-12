/* fNIRS simulator: signal processing.

   The steps of a standard fNIRS pipeline, each small enough to read:
   Butterworth filters run forward and backward, Welch spectra, intensity
   to optical density, channel quality (scalp coupling index, coefficient
   of variation, saturation, signal level), two motion corrections (TDDR
   and spline interpolation), the modified Beer-Lambert law,
   short-channel regression, block averaging and a GLM with
   autoregressive prewhitening. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;
  const dsp = NIRS.dsp = {};

  /* ---------- Butterworth filters as second-order sections ---------- */
  dsp.butter = function (order, fc, fs, type) {
    const K = 2 * fs, wc = 2 * fs * Math.tan(Math.PI * fc / fs);
    const sos = [];
    const hp = type === 'high';
    for (let k = 0; k < Math.floor(order / 2); k++) {
      const theta = Math.PI * (2 * k + 1 + order) / (2 * order);
      const re = Math.cos(theta);                 // pole real part on the unit circle (negative)
      // analog: lowpass wc^2 / (s^2 - 2 re wc s + wc^2), highpass s^2 / (...)
      const a2 = 1, a1 = -2 * re * wc, a0 = wc * wc;
      const b2 = hp ? 1 : 0, b1 = 0, b0 = hp ? 0 : wc * wc;
      const A0 = a2 * K * K + a1 * K + a0, A1 = 2 * (a0 - a2 * K * K), A2 = a2 * K * K - a1 * K + a0;
      const B0 = b2 * K * K + b1 * K + b0, B1 = 2 * (b0 - b2 * K * K), B2 = b2 * K * K - b1 * K + b0;
      sos.push([B0 / A0, B1 / A0, B2 / A0, A1 / A0, A2 / A0]);
    }
    if (order % 2) {
      const a1 = 1, a0 = wc, b1 = hp ? 1 : 0, b0 = hp ? 0 : wc;
      const A0 = a1 * K + a0, A1 = a0 - a1 * K, B0 = b1 * K + b0, B1 = b0 - b1 * K;
      sos.push([B0 / A0, B1 / A0, 0, A1 / A0, 0]);
    }
    return sos;
  };
  dsp.sosfilt = function (sos, x) {
    const y = Float64Array.from(x);
    sos.forEach(([b0, b1, b2, a1, a2]) => {
      let z1 = 0, z2 = 0;
      // start in steady state for the first sample (avoids a step transient)
      const x0 = y[0], dc = (b0 + b1 + b2) / (1 + a1 + a2);
      if (isFinite(dc)) { z1 = x0 * (dc - b0); z2 = x0 * (b2 - a2 * dc); }
      for (let i = 0; i < y.length; i++) {
        const xi = y[i], yi = b0 * xi + z1;
        z1 = b1 * xi - a1 * yi + z2;
        z2 = b2 * xi - a2 * yi;
        y[i] = yi;
      }
    });
    return y;
  };
  // Zero-phase: forward, then backward, with the ends padded by reflection.
  dsp.filtfilt = function (sos, x, pad) {
    const n = x.length;
    pad = Math.min(n - 1, pad || 0);
    const ext = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
    ext.set(x, pad);
    for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
    let y = dsp.sosfilt(sos, ext);
    y.reverse();
    y = dsp.sosfilt(sos, y);
    y.reverse();
    return y.slice(pad, pad + n);
  };
  // A band-pass (either edge may be null), zero phase.
  dsp.bandpass = function (x, fs, hp, lp, orders) {
    orders = orders || [3, 5];
    let y = x;
    if (hp) y = dsp.filtfilt(dsp.butter(orders[0], hp, fs, 'high'), y, Math.round(3 * fs / hp));
    if (lp && lp < fs / 2) y = dsp.filtfilt(dsp.butter(orders[1], lp, fs, 'low'), y, Math.round(6 * fs / lp));
    return y === x ? Float64Array.from(x) : y;
  };
  // Magnitude response of a two-pass (zero-phase) cascade at frequency f.
  dsp.response = function (fs, hp, lp, f, orders) {
    orders = orders || [3, 5];
    let g = 1;
    if (hp) g *= 1 / (1 + Math.pow(Math.tan(Math.PI * hp / fs) / Math.tan(Math.PI * Math.min(f, fs / 2 - 1e-9) / fs), 2 * orders[0]));
    if (lp && lp < fs / 2) g *= 1 / (1 + Math.pow(Math.tan(Math.PI * Math.min(f, fs / 2 - 1e-9) / fs) / Math.tan(Math.PI * lp / fs), 2 * orders[1]));
    return g;    // |H|^2 of one pass = |H| of the forward-backward pair
  };

  /* ---------- spectra ---------- */
  dsp.welch = function (x, fs, segSec) {
    const n = x.length;
    let L = NIRS.nextPow2(Math.round((segSec || 100) * fs));
    while (L > n && L > 16) L >>= 1;
    const step = L >> 1, win = new Float64Array(L);
    let wss = 0;
    for (let i = 0; i < L; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)); wss += win[i] * win[i]; }
    const nf = L / 2 + 1, p = new Float64Array(nf);
    let segs = 0;
    const re = new Float64Array(L), im = new Float64Array(L);
    for (let s0 = 0; s0 + L <= n; s0 += step) {
      let m = 0; for (let i = 0; i < L; i++) m += x[s0 + i]; m /= L;
      for (let i = 0; i < L; i++) { re[i] = (x[s0 + i] - m) * win[i]; im[i] = 0; }
      NIRS.fft(re, im, false);
      for (let k = 0; k < nf; k++) p[k] += (re[k] * re[k] + im[k] * im[k]) * (k === 0 || k === nf - 1 ? 1 : 2);
      segs++;
    }
    for (let k = 0; k < nf; k++) p[k] /= Math.max(1, segs) * fs * wss;
    const f = Float64Array.from({ length: nf }, (_, k) => k * fs / L);
    return { f, p, df: fs / L, segs };
  };

  /* ---------- intensity to optical density ----------
     OD = -log10(I / I0), with I0 the mean intensity of the recording. */
  dsp.od = function (I) {
    let m = 0; for (let i = 0; i < I.length; i++) m += I[i]; m /= I.length;
    const out = new Float64Array(I.length), k = 1 / m;
    for (let i = 0; i < I.length; i++) out[i] = -Math.log10(Math.max(I[i], 1e-9) * k);
    return out;
  };

  /* ---------- channel quality ----------
     SCI (Pollonini and colleagues 2014): the correlation between the two
     wavelengths' signals in the cardiac band.  Light that went through
     tissue carries the heartbeat at every wavelength; light that leaked
     around a badly seated optode, or noise, does not.  CV: standard
     deviation over mean of the raw intensity.  Also flags saturation and
     intensity too close to the detector's noise floor. */
  dsp.quality = function (ds, rec, thr) {
    const fs = ds.fs, nL = ds.nL;
    return ds.chans.map((c, ci) => {
      const I = rec.I[ci];
      const mean = I.map(x => NIRS.mean(x));
      const cv = I.map((x, li) => NIRS.std(x) / mean[li]);
      let sat = 0;
      I.forEach(x => { let k = 0; for (let i = 0; i < x.length; i++) if (x[i] >= ds.det.sat * 0.999) k++; sat = Math.max(sat, k / x.length); });
      let sci = NaN;
      if (fs >= 5 && nL >= 2) {
        const hi = Math.min(2.5, fs / 2 * 0.9);
        const a = dsp.bandpass(dsp.od(I[0]), fs, 0.5, hi, [3, 3]), b = dsp.bandpass(dsp.od(I[nL - 1]), fs, 0.5, hi, [3, 3]);
        sci = NIRS.corr(a, b);
      }
      const low = Math.min(...mean) < 10 * ds.det.floor;
      const reasons = [];
      if (thr) {
        if (isFinite(sci) && sci < thr.sci) reasons.push(`SCI ${sci.toFixed(2)} < ${thr.sci}`);
        if (Math.max(...cv) > thr.cv) reasons.push(`CV ${(100 * Math.max(...cv)).toFixed(1)}% > ${(100 * thr.cv).toFixed(0)}%`);
        if (sat > 0.001) reasons.push(`saturated ${(100 * sat).toFixed(1)}% of the time`);
        if (low) reasons.push('signal at the noise floor');
      }
      return { mean, cv, sci, sat, low, bad: reasons.length > 0, reasons };
    });
  };
  // Scalp coupling index in sliding windows, for the time-resolved view.
  dsp.sciWindows = function (ds, I, win) {
    const fs = ds.fs, nL = ds.nL, n = I[0].length, w = Math.round((win || 10) * fs);
    if (fs < 5 || nL < 2) return null;
    const hi = Math.min(2.5, fs / 2 * 0.9);
    const a = dsp.bandpass(dsp.od(I[0]), fs, 0.5, hi, [3, 3]), b = dsp.bandpass(dsp.od(I[nL - 1]), fs, 0.5, hi, [3, 3]);
    const out = [];
    for (let s = 0; s + w <= n; s += w) out.push({ t: (s + w / 2) / fs, sci: NIRS.corr(a, b, s, s + w) });
    return out;
  };

  /* ---------- motion correction ---------- */
  /* Temporal derivative distribution repair (Fishburn and colleagues
     2019).  Motion makes rare, large jumps in the derivative of the slow
     part of the signal; iteratively reweighted least squares with Tukey's
     biweight finds the typical derivative and down-weights the outliers,
     and integrating the repaired derivative rebuilds the signal. */
  dsp.tddr = function (x, fs) {
    const n = x.length;
    const lp = Math.min(0.5, fs / 2 * 0.9);
    const low = dsp.filtfilt(dsp.butter(3, lp, fs, 'low'), x, Math.round(6 * fs / lp));
    const high = Float64Array.from(x, (v, i) => v - low[i]);
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = low[i + 1] - low[i];
    const w = new Float64Array(n - 1).fill(1), dev = new Float64Array(n - 1), tmp = new Float64Array(n - 1);
    let mu = 0, prev = Infinity;
    for (let it = 0; it < 50; it++) {
      let sw = 0, swd = 0;
      for (let i = 0; i < n - 1; i++) { sw += w[i]; swd += w[i] * d[i]; }
      mu = swd / sw;
      for (let i = 0; i < n - 1; i++) dev[i] = Math.abs(d[i] - mu);
      tmp.set(dev);
      const sigma = 1.4826 * NIRS.quickMedian(tmp) || 1e-12;
      const k = 1 / (4.685 * sigma);
      for (let i = 0; i < n - 1; i++) { const r = dev[i] * k; w[i] = r < 1 ? (1 - r * r) * (1 - r * r) : 0; }
      if (Math.abs(mu - prev) <= 1e-9 * (Math.abs(mu) + 1e-15)) break;
      prev = mu;
    }
    const y = new Float64Array(n);
    for (let i = 1; i < n; i++) y[i] = y[i - 1] + w[i - 1] * (d[i - 1] - mu);
    const off = NIRS.mean(low) - NIRS.mean(y);
    for (let i = 0; i < n; i++) y[i] += off + high[i];
    return { y, weights: w };
  };

  /* Whittaker smoother: minimize |y - z|^2 + lam |D2 z|^2.  A stand-in for
     the cubic smoothing spline of Scholkmann's method, solved directly as
     a banded (pentadiagonal) system. */
  dsp.whittaker = function (y, lam) {
    const n = y.length;
    if (n < 5) return Float64Array.from(y);
    // A = I + lam D'D, symmetric, bandwidth 2: store diag (a0), first (a1), second (a2) off-diagonals
    const a0 = new Float64Array(n), a1 = new Float64Array(n), a2 = new Float64Array(n);
    for (let i = 0; i < n - 2; i++) {
      // row of D: [1 -2 1] at i, i+1, i+2
      const idx = [i, i + 1, i + 2], c = [1, -2, 1];
      for (let p = 0; p < 3; p++) for (let q = p; q < 3; q++) {
        const v = lam * c[p] * c[q], r = idx[q], cc = idx[p];
        if (r === cc) a0[r] += v; else if (r - cc === 1) a1[r] += v; else a2[r] += v;
      }
    }
    for (let i = 0; i < n; i++) a0[i] += 1;
    // banded Cholesky, bandwidth 2
    const L0 = new Float64Array(n), L1 = new Float64Array(n), L2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      L2[i] = i >= 2 ? a2[i] / L0[i - 2] : 0;
      L1[i] = i >= 1 ? (a1[i] - (i >= 2 ? L2[i] * L1[i - 1] : 0)) / L0[i - 1] : 0;
      L0[i] = Math.sqrt(a0[i] - L1[i] * L1[i] - L2[i] * L2[i]);
    }
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) z[i] = (y[i] - (i >= 1 ? L1[i] * z[i - 1] : 0) - (i >= 2 ? L2[i] * z[i - 2] : 0)) / L0[i];
    for (let i = n - 1; i >= 0; i--) z[i] = (z[i] - (i + 1 < n ? L1[i + 1] * z[i + 1] : 0) - (i + 2 < n ? L2[i + 2] * z[i + 2] : 0)) / L0[i];
    return z;
  };

  /* Moving standard deviation over a centred window. */
  dsp.movingStd = function (x, w) {
    const n = x.length, out = new Float64Array(n), h = Math.max(1, Math.floor(w / 2));
    let s = 0, s2 = 0, a = 0, b = -1;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n - 1, i + h);
      while (b < hi) { b++; s += x[b]; s2 += x[b] * x[b]; }
      while (a < lo) { s -= x[a]; s2 -= x[a] * x[a]; a++; }
      const m = b - a + 1, mu = s / m;
      out[i] = Math.sqrt(Math.max(0, s2 / m - mu * mu));
    }
    return out;
  };

  /* Motion artifact detection, used by spline correction and shown on the
     Processing tab: samples whose moving standard deviation (over 1 s) is
     more than `k` times its median, widened by half a second each side. */
  dsp.detectMotion = function (x, fs, k) {
    const n = x.length, msd = dsp.movingStd(x, Math.round(fs));
    const thr = (k || 5) * NIRS.median(msd);
    const mark = new Uint8Array(n), pad = Math.round(0.5 * fs);
    for (let i = 0; i < n; i++) if (msd[i] > thr) for (let j = Math.max(0, i - pad); j <= Math.min(n - 1, i + pad); j++) mark[j] = 1;
    const segs = [];
    for (let i = 0; i < n;) {
      if (!mark[i]) { i++; continue; }
      let j = i; while (j < n && mark[j]) j++;
      segs.push([i, j]); i = j;
    }
    return { segs, thr, msd };
  };

  /* Spline interpolation (Scholkmann and colleagues 2010): within each
     detected artifact, subtract a smooth fit of the artifact itself, then
     shift every segment so it joins the one before it. */
  dsp.splineCorrect = function (x, fs, k, segsIn) {
    const n = x.length;
    const segs = segsIn || dsp.detectMotion(x, fs, k).segs;
    if (!segs.length) return { y: Float64Array.from(x), segs };
    const y = Float64Array.from(x);
    segs.forEach(([a, b]) => {
      const part = x.subarray(a, b), sm = dsp.whittaker(part, 0.5);
      for (let i = a; i < b; i++) y[i] = x[i] - sm[i - a];
    });
    // piecewise level alignment
    const bounds = [];
    let pos = 0;
    segs.forEach(([a, b]) => { if (a > pos) bounds.push([pos, a]); bounds.push([a, b]); pos = b; });
    if (pos < n) bounds.push([pos, n]);
    const win = s => Math.max(1, Math.min(Math.round(fs), Math.floor((s[1] - s[0]) / 3)));
    for (let k2 = 1; k2 < bounds.length; k2++) {
      const p = bounds[k2 - 1], c = bounds[k2];
      const wp = win(p), wc = win(c);
      const mp = NIRS.mean(y, p[1] - wp, p[1]), mc = NIRS.mean(y, c[0], c[0] + wc);
      const d = mp - mc;
      for (let i = c[0]; i < c[1]; i++) y[i] += d;
    }
    const off = NIRS.mean(x) - NIRS.mean(y);
    for (let i = 0; i < n; i++) y[i] += off;
    return { y, segs };
  };

  /* ---------- the modified Beer-Lambert law ---------- */
  // DPF for each wavelength under the analysis settings.
  dsp.dpfValues = function (ds, an, chan) {
    const D = an.dpf;
    if (D.mode === 'fixed') return ds.lambdas.map((_, li) => (D.values.length === 1 ? D.values[0] : D.values[li]));
    if (D.mode === 'model') return chan.per.map(q => q.dpf);
    const age = D.age === null || D.age === undefined ? ds.head.age : D.age;
    return ds.lambdas.map(nm => NIRS.dpfAge(nm, age));
  };
  dsp.mbll = function (od, lambdas, rho, dpf) {
    const Ei = NIRS.mbllInverse(NIRS.mbllMatrix(lambdas, rho, dpf));
    const n = od[0].length;
    const hbo = new Float64Array(n), hbr = new Float64Array(n);
    if (!Ei) { hbo.fill(NaN); hbr.fill(NaN); return { hbo, hbr, Ei: null }; }
    for (let i = 0; i < n; i++) {
      let a = 0, b = 0;
      for (let l = 0; l < od.length; l++) { a += Ei[0][l] * od[l][i]; b += Ei[1][l] * od[l][i]; }
      hbo[i] = a; hbr[i] = b;
    }
    return { hbo, hbr, Ei };
  };

  /* ---------- short-channel regression ----------
     Regress each long channel on its short channel (or the mean of the
     good ones) and keep the residual. */
  dsp.regressOut = function (y, x) {
    const n = y.length, my = NIRS.mean(y), mx = NIRS.mean(x);
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { const a = x[i] - mx; sxy += a * (y[i] - my); sxx += a * a; }
    const beta = sxx > 0 ? sxy / sxx : 0;
    return { y: Float64Array.from(y, (v, i) => v - beta * (x[i] - mx)), beta };
  };
  // Pick the short channel to use for each long channel: nearest good one, or the mean.
  dsp.shortRegressors = function (ds, conc, quality, mode) {
    const shorts = ds.chans.filter(c => c.short && !(quality && quality[c.index].bad));
    if (mode === 'off' || !shorts.length) return ds.chans.map(() => null);
    if (mode === 'mean') {
      const m = k => { const out = new Float64Array(ds.n); shorts.forEach(c => { const s = conc[c.index][k]; for (let i = 0; i < ds.n; i++) out[i] += s[i] / shorts.length; }); return out; };
      const reg = { hbo: m('hbo'), hbr: m('hbr'), from: shorts.map(c => c.label) };
      return ds.chans.map(c => (c.short ? null : reg));
    }
    return ds.chans.map(c => {
      if (c.short) return null;
      const s = ds.geo.sources[c.src], d = ds.geo.detectors[c.det];
      let best = null, bd = Infinity;
      shorts.forEach(sc => {
        const dd = Math.min(Math.hypot(sc.mid[0] - s.x, sc.mid[1] - s.y), Math.hypot(sc.mid[0] - d.x, sc.mid[1] - d.y));
        if (dd < bd) { bd = dd; best = sc; }
      });
      return best ? { hbo: conc[best.index].hbo, hbr: conc[best.index].hbr, from: [best.label], dist: bd } : null;
    });
  };

  /* ---------- epochs and block averages ---------- */
  dsp.epochs = function (series, fs, events, ci, win, base) {
    const n = series.length, i0 = Math.round(win[0] * fs), i1 = Math.round(win[1] * fs), len = i1 - i0 + 1;
    const out = [];
    events.forEach((ev, k) => {
      if (ci !== null && ev.ci !== ci) return;
      const c = Math.round(ev.t * fs);
      if (c + i0 < 0 || c + i1 >= n) return;
      const e = new Float64Array(len);
      for (let j = 0; j < len; j++) e[j] = series[c + i0 + j];
      if (base) {
        const b0 = Math.round(base[0] * fs) - i0, b1 = Math.round(base[1] * fs) - i0;
        const m = NIRS.mean(e, Math.max(0, b0), Math.max(b0 + 1, Math.min(len, b1)));
        for (let j = 0; j < len; j++) e[j] -= m;
      }
      out.push({ data: e, ev, k });
    });
    const times = Float64Array.from({ length: len }, (_, j) => (i0 + j) / fs);
    return { list: out, times, len };
  };
  dsp.average = function (list, count) {
    const k = Math.min(list.length, count === undefined ? list.length : count);
    if (!k) return null;
    const len = list[0].data.length, m = new Float64Array(len), se = new Float64Array(len);
    for (let e = 0; e < k; e++) { const d = list[e].data; for (let j = 0; j < len; j++) m[j] += d[j]; }
    for (let j = 0; j < len; j++) m[j] /= k;
    if (k > 1) {
      for (let e = 0; e < k; e++) { const d = list[e].data; for (let j = 0; j < len; j++) { const x = d[j] - m[j]; se[j] += x * x; } }
      for (let j = 0; j < len; j++) se[j] = Math.sqrt(se[j] / (k - 1) / k);
    }
    return { mean: m, se, n: k };
  };

  /* ---------- the GLM ----------
     Design: one regressor per condition (the stimulus boxcar convolved with
     the HRF and scaled to a peak of 1, so a beta is the size of the
     response in µM), optionally its temporal derivative, cosine drift
     terms below `driftHz`, a constant, and any nuisance regressors (the
     short channel).  Noise: ordinary least squares, or prewhitening with
     an AR(p) model of the residuals (Barker and colleagues 2013). */
  dsp.design = function (ds, an, opts) {
    opts = opts || {};
    const n = ds.n, fs = ds.fs, cols = [], names = [], kinds = [];
    const hrf = NIRS.HRFS[an.hrf] || NIRS.HRFS.canonical;
    ds.conditions.forEach((c, ci) => {
      const box = new Float64Array(n);
      ds.events.forEach(ev => {
        if (ev.ci !== ci) return;
        const i0 = Math.round(ev.t * fs), i1 = Math.max(i0 + 1, Math.round((ev.t + ev.dur) * fs));
        for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) box[i] = 1;
      });
      const norm = a => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i])); if (m > 0) for (let i = 0; i < n; i++) a[i] /= m; return a; };
      cols.push(norm(NIRS.convolveHRF(box, fs, hrf))); names.push(c); kinds.push('task');
      if (an.deriv) { cols.push(norm(NIRS.convolveHRF(box, fs, hrf, true))); names.push(c + "'"); kinds.push('deriv'); }
    });
    const driftHz = opts.driftHz || 0.008;
    const K = Math.max(0, Math.floor(2 * n / fs * driftHz));
    for (let k = 1; k <= K; k++) { cols.push(Float64Array.from({ length: n }, (_, i) => Math.cos(Math.PI * k * (i + 0.5) / n))); names.push('drift ' + k); kinds.push('drift'); }
    cols.push(new Float64Array(n).fill(1)); names.push('constant'); kinds.push('const');
    return { cols, names, kinds, nTask: ds.conditions.length };
  };
  /* A finite impulse response basis for each condition: one regressor per
     time bin after onset.  It makes no assumption about the shape of the
     response, which is what short-channel cleaning needs so that it does
     not mistake a cortical response of an unexpected shape for scalp. */
  dsp.firDesign = function (ds, span, bin, driftHz) {
    const n = ds.n, fs = ds.fs, cols = [];
    const nb = Math.max(1, Math.ceil(span / bin));
    ds.conditions.forEach((c, ci) => {
      for (let b = 0; b < nb; b++) {
        const x = new Float64Array(n);
        ds.events.forEach(ev => {
          if (ev.ci !== ci) return;
          const i0 = Math.round((ev.t + b * bin) * fs), i1 = Math.round((ev.t + (b + 1) * bin) * fs);
          for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) x[i] = 1;
        });
        cols.push(x);
      }
    });
    const K = Math.max(0, Math.floor(2 * n / fs * (driftHz || 0.008)));
    for (let k = 1; k <= K; k++) cols.push(Float64Array.from({ length: n }, (_, i) => Math.cos(Math.PI * k * (i + 0.5) / n)));
    cols.push(new Float64Array(n).fill(1));
    return { cols };
  };
  function arFit(r, p) {
    // Yule-Walker via Levinson-Durbin
    const n = r.length, ac = new Float64Array(p + 1);
    for (let k = 0; k <= p; k++) { let s = 0; for (let i = k; i < n; i++) s += r[i] * r[i - k]; ac[k] = s / n; }
    if (!(ac[0] > 0)) return new Float64Array(0);
    let a = new Float64Array(p + 1), e = ac[0];
    a[0] = 1;
    for (let k = 1; k <= p; k++) {
      let acc = ac[k];
      for (let j = 1; j < k; j++) acc -= a[j] * ac[k - j];
      const kk = acc / e;
      const na = Float64Array.from(a);
      na[k] = kk;
      for (let j = 1; j < k; j++) na[j] = a[j] - kk * a[k - j];
      a = na; e *= (1 - kk * kk);
      if (e <= 0) break;
    }
    return a.subarray(1);
  }
  function whiten(x, a) {
    const n = x.length, y = new Float64Array(n), p = a.length;
    for (let i = 0; i < n; i++) { let s = x[i]; for (let k = 0; k < p && k < i; k++) s -= a[k] * x[i - 1 - k]; y[i] = s; }
    return y;
  }
  // Least squares on a design given as columns: beta, (X'X)^-1, residual.
  function olsCols(cols, y) {
    const p = cols.length, n = y.length;
    const XtX = NIRS.la.zeros(p, p), Xty = new Float64Array(p);
    for (let a = 0; a < p; a++) {
      const ca = cols[a];
      let sy = 0; for (let i = 0; i < n; i++) sy += ca[i] * y[i];
      Xty[a] = sy;
      for (let b = a; b < p; b++) { const cb = cols[b]; let s = 0; for (let i = 0; i < n; i++) s += ca[i] * cb[i]; XtX[a][b] = XtX[b][a] = s; }
    }
    let tr = 0; for (let a = 0; a < p; a++) tr += XtX[a][a];
    for (let a = 0; a < p; a++) XtX[a][a] += 1e-10 * tr / p;
    const XtXi = NIRS.la.inverse(XtX);
    const beta = new Float64Array(p);
    for (let a = 0; a < p; a++) { let s = 0; for (let b = 0; b < p; b++) s += XtXi[a][b] * Xty[b]; beta[a] = s; }
    const e = Float64Array.from(y);
    for (let a = 0; a < p; a++) { const ca = cols[a], ba = beta[a]; if (ba === 0) continue; for (let i = 0; i < n; i++) e[i] -= ba * ca[i]; }
    return { beta, XtXi, e };
  }
  dsp.olsCols = olsCols;
  dsp.glmFit = function (y, cols, opts) {
    opts = opts || {};
    const n = y.length, p = cols.length;
    let fit = olsCols(cols, y), ar = null;
    if (opts.ar) {
      for (let it = 0; it < 2; it++) {
        // residual of the unwhitened model with the current betas
        const r = Float64Array.from(y);
        for (let a = 0; a < p; a++) { const ca = cols[a], ba = fit.beta[a]; for (let i = 0; i < n; i++) r[i] -= ba * ca[i]; }
        ar = arFit(r, opts.order || 10);
        fit = olsCols(cols.map(c => whiten(c, ar)), whiten(y, ar));
      }
    }
    const e = fit.e;
    let rss = 0; for (let i = 0; i < n; i++) rss += e[i] * e[i];
    const df = Math.max(1, n - p - (ar ? ar.length : 0)), s2 = rss / df;
    const beta = fit.beta;
    const se = Float64Array.from({ length: p }, (_, j) => Math.sqrt(Math.max(0, s2 * fit.XtXi[j][j])));
    const t = Float64Array.from(beta, (b, j) => b / (se[j] || Infinity));
    const fitted = new Float64Array(n);
    for (let a = 0; a < p; a++) { const ca = cols[a], ba = beta[a]; for (let i = 0; i < n; i++) fitted[i] += ba * ca[i]; }
    return { beta, se, t, df, fitted, ar, s2 };
  };

  dsp.corrMatrix = function (rows) {
    const k = rows.length, M = NIRS.la.zeros(k, k);
    for (let i = 0; i < k; i++) { M[i][i] = 1; for (let j = i + 1; j < k; j++) M[i][j] = M[j][i] = NIRS.corr(rows[i], rows[j]); }
    return M;
  };
})(typeof window !== 'undefined' ? window : globalThis);
