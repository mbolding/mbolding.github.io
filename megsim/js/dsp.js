/* MEG simulator: signal processing.
   Butterworth and notch filters as second-order sections, zero-phase
   filtering, a magnitude-only FFT filter (used for the shielded room),
   Welch spectra, Morlet time-frequency maps and epoching. */
(function (G) {
  'use strict';
  const MEG = G.MEG;

  /* ---------- filter design ----------
     Butterworth by the bilinear transform with a pre-warped cutoff.  Each
     conjugate pair of analog poles becomes one biquad; an odd order adds a
     first-order section.  Sections are {b0, b1, b2, a1, a2} with a0 = 1. */
  function butter(type, order, fc, fs) {
    const K = 2 * fs;
    const wa = K * Math.tan(Math.PI * Math.min(fc, fs * 0.499) / fs);
    const sos = [];
    const cdiv = (ar, ai, br, bi) => { const m = br * br + bi * bi; return [(ar * br + ai * bi) / m, (ai * br - ar * bi) / m]; };
    for (let k = 0; k < Math.floor(order / 2); k++) {
      const ang = Math.PI * (2 * k + order + 1) / (2 * order);
      const pr = Math.cos(ang), pi = Math.sin(ang);
      let sr, si;
      if (type === 'low') { sr = pr * wa; si = pi * wa; } else { const m = pr * pr + pi * pi; sr = wa * pr / m; si = -wa * pi / m; }
      const [zr, zi] = cdiv(K + sr, si, K - sr, -si);
      const a1 = -2 * zr, a2 = zr * zr + zi * zi;
      const b = type === 'low' ? [1, 2, 1] : [1, -2, 1];
      const g = type === 'low' ? (1 + a1 + a2) / 4 : (1 - a1 + a2) / 4;
      sos.push({ b0: b[0] * g, b1: b[1] * g, b2: b[2] * g, a1, a2 });
    }
    if (order % 2) {
      const z = (K - wa) / (K + wa);
      if (type === 'low') { const g = (1 - z) / 2; sos.push({ b0: g, b1: g, b2: 0, a1: -z, a2: 0 }); } else { const g = (1 + z) / 2; sos.push({ b0: g, b1: -g, b2: 0, a1: -z, a2: 0 }); }
    }
    return sos;
  }
  function notch(f0, bw, fs) {
    const w0 = 2 * Math.PI * f0 / fs, Q = f0 / bw, al = Math.sin(w0) / (2 * Q), c = Math.cos(w0), a0 = 1 + al;
    return [{ b0: 1 / a0, b1: -2 * c / a0, b2: 1 / a0, a1: -2 * c / a0, a2: (1 - al) / a0 }];
  }
  // In place, causal, zero initial state (direct form II transposed).
  function sosfilt(sos, x) {
    const n = x.length;
    for (const s of sos) {
      const { b0, b1, b2, a1, a2 } = s;
      let z1 = 0, z2 = 0;
      for (let i = 0; i < n; i++) {
        const xi = x[i];
        const y = b0 * xi + z1;
        z1 = b1 * xi - a1 * y + z2;
        z2 = b2 * xi - a2 * y;
        x[i] = y;
      }
    }
    return x;
  }
  // Forward and backward, with odd reflection at both ends.
  function filtfilt(sos, x, pad) {
    const n = x.length, p = Math.max(0, Math.min(pad, n - 1));
    const y = new Float64Array(n + 2 * p);
    for (let i = 0; i < n; i++) y[p + i] = x[i];
    for (let k = 1; k <= p; k++) { y[p - k] = 2 * x[0] - x[k]; y[p + n - 1 + k] = 2 * x[n - 1] - x[n - 1 - k]; }
    sosfilt(sos, y); y.reverse(); sosfilt(sos, y); y.reverse();
    for (let i = 0; i < n; i++) x[i] = y[p + i];
    return x;
  }
  function response(sos, f, fs) {
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    let hr = 1, hi = 0;
    for (const s of sos) {
      const nr = s.b0 + s.b1 * c1 + s.b2 * c2, ni = -s.b1 * s1 - s.b2 * s2;
      const dr = 1 + s.a1 * c1 + s.a2 * c2, di = -s.a1 * s1 - s.a2 * s2;
      const m = dr * dr + di * di;
      const qr = (nr * dr + ni * di) / m, qi = (ni * dr - nr * di) / m;
      const tr = hr * qr - hi * qi; hi = hr * qi + hi * qr; hr = tr;
    }
    return [hr, hi];
  }

  /* An offline filter chain from the Processing settings. */
  function chain(settings, fs) {
    const sos = [];
    const order = settings.order || 4;
    let fmin = Infinity;
    if (settings.hp) { sos.push(...butter('high', order, settings.hp, fs)); fmin = Math.min(fmin, settings.hp); }
    if (settings.lp && settings.lp < fs / 2) sos.push(...butter('low', order, settings.lp, fs));
    if (settings.notch) {
      const harmonics = settings.harmonics ? [1, 2, 3] : [1];
      harmonics.forEach(h => { const f = settings.notch * h; if (f < fs / 2 - 1) sos.push(...notch(f, settings.notchWidth || 2, fs)); });
      fmin = Math.min(fmin, settings.notchWidth || 2);
    }
    const zero = settings.phase !== 'causal';
    const pad = isFinite(fmin) ? Math.round(Math.min(3 * fs / fmin, 20 * fs)) : Math.round(fs);
    return {
      sos, zero, pad, empty: sos.length === 0,
      apply(x) { if (!sos.length) return x; return zero ? filtfilt(sos, x, pad) : sosfilt(sos, x); },
      magnitude(f) { const [r, i] = response(sos, f, fs); const m = Math.hypot(r, i); return zero ? m * m : m; },
      phase(f) { if (zero) return 0; const [r, i] = response(sos, f, fs); return Math.atan2(i, r); }
    };
  }

  /* Multiply the spectrum of x by a real gain g(f): zero phase, any shape.
     The signal is mirrored at both ends first so the circular FFT does not
     wrap the end onto the start. */
  function fftGain(x, fs, g) {
    const n = x.length, N = MEG.nextPow2(2 * n);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < n; i++) { re[i] = x[i]; re[2 * n - 1 - i] = x[i]; }
    for (let i = 2 * n; i < N; i++) re[i] = x[0];
    MEG.fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      const gk = g(k * fs / N);
      re[k] *= gk; im[k] *= gk;
      if (k && k < N / 2) { re[N - k] *= gk; im[N - k] *= gk; }
    }
    MEG.fft(re, im, true);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = re[i];
    return out;
  }

  /* ---------- spectra ----------
     Welch's method: Hann-windowed segments with half overlap, mean
     removed, averaged periodograms scaled to a one-sided power density
     (units^2/Hz).  `ranges` lists [start, end) sample ranges to use. */
  function hann(N) { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N); return w; }
  function segments(ranges, N) {
    const out = [];
    ranges.forEach(([a, b]) => { for (let s = a; s + N <= b; s += N >> 1) out.push(s); });
    return out;
  }
  function welch(x, fs, ranges, N) {
    N = N || MEG.nextPow2(2 * fs);
    const w = hann(N); let U = 0; for (let i = 0; i < N; i++) U += w[i] * w[i];
    const nf = N / 2 + 1, pxx = new Float64Array(nf);
    const re = new Float64Array(N), im = new Float64Array(N);
    const segs = segments(ranges, N);
    segs.forEach(s => {
      let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N;
      for (let i = 0; i < N; i++) { re[i] = (x[s + i] - m) * w[i]; im[i] = 0; }
      MEG.fft(re, im);
      for (let k = 0; k < nf; k++) pxx[k] += re[k] * re[k] + im[k] * im[k];
    });
    const f = new Float64Array(nf), scale = 1 / (Math.max(1, segs.length) * fs * U);
    for (let k = 0; k < nf; k++) { f[k] = k * fs / N; pxx[k] *= scale * ((k === 0 || k === nf - 1) ? 1 : 2); }
    return { f, p: pxx, nseg: segs.length, df: fs / N };
  }
  function bandPower(spec, f0, f1) {
    let s = 0;
    for (let k = 0; k < spec.f.length; k++) if (spec.f[k] >= f0 && spec.f[k] < f1) s += spec.p[k] * spec.df;
    return s;
  }

  /* ---------- Morlet wavelets ----------
     Convolution in the frequency domain with a Gaussian centred on each
     frequency (the analytic Morlet wavelet).  Scaled so a sinusoid of
     amplitude A at that frequency has power A^2. */
  function tfr(x, fs, i0, i1, freqs, cycles, cols) {
    const fmin = freqs[0];
    const margin = Math.ceil(3 * cycles(fmin) / (2 * Math.PI * fmin) * fs);
    const a = Math.max(0, i0 - margin), b = Math.min(x.length, i1 + margin);
    const L = b - a, N = MEG.nextPow2(L + 2 * margin);
    const re = new Float64Array(N), im = new Float64Array(N);
    let m = 0; for (let i = a; i < b; i++) m += x[i]; m /= L;
    for (let i = 0; i < L; i++) re[i] = x[a + i] - m;
    MEG.fft(re, im);
    const nt = i1 - i0;
    cols = Math.min(cols || nt, nt);
    const out = freqs.map(() => new Float32Array(cols));
    const cr = new Float64Array(N), ci = new Float64Array(N);
    freqs.forEach((f, fi) => {
      const sf = f / cycles(f);
      for (let k = 0; k < N; k++) {
        const nu = k <= N / 2 ? k * fs / N : 0;
        const g = k <= N / 2 ? 2 * Math.exp(-0.5 * Math.pow((nu - f) / sf, 2)) : 0;
        cr[k] = re[k] * g; ci[k] = im[k] * g;
      }
      MEG.fft(cr, ci, true);
      const row = out[fi], off = i0 - a;
      for (let c = 0; c < cols; c++) {
        const s0 = Math.floor(c * nt / cols), s1 = Math.max(s0 + 1, Math.floor((c + 1) * nt / cols));
        let acc = 0;
        for (let s = s0; s < s1; s++) { const k = off + s; acc += cr[k] * cr[k] + ci[k] * ci[k]; }
        row[c] = acc / (s1 - s0);
      }
    });
    return out;
  }

  /* ---------- epochs ----------
     Cuts [t0, t1] around each event from every channel, subtracting the
     baseline mean if given, and records each epoch's largest
     peak-to-peak excursion for artifact rejection. */
  function epoch(rows, fs, events, t0, t1, baseline) {
    const s0 = Math.round(t0 * fs), s1 = Math.round(t1 * fs), nT = s1 - s0 + 1, nCh = rows.length, n = rows[0].length;
    const times = new Float64Array(nT);
    for (let i = 0; i < nT; i++) times[i] = (s0 + i) / fs;
    let b0 = 0, b1 = 0;
    if (baseline) {
      b0 = MEG.clamp(Math.round(baseline[0] * fs) - s0, 0, nT - 1);
      b1 = MEG.clamp(Math.round(baseline[1] * fs) - s0, b0 + 1, nT);
    }
    const list = [];
    events.forEach((ev, k) => {
      const c = ev.sample;
      if (c + s0 < 0 || c + s1 >= n) return;
      const data = new Float32Array(nCh * nT), p2p = new Float32Array(nCh);
      for (let ch = 0; ch < nCh; ch++) {
        const r = rows[ch], o = ch * nT;
        let m = 0;
        if (baseline) { for (let i = b0; i < b1; i++) m += r[c + s0 + i]; m /= (b1 - b0); }
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < nT; i++) { const v = r[c + s0 + i] - m; data[o + i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
        p2p[ch] = hi - lo;
      }
      list.push({ ev, k, data, p2p });
    });
    return { times, nT, nCh, list, zero: -s0 };
  }

  MEG.dsp = { butter, notch, sosfilt, filtfilt, response, chain, fftGain, welch, bandPower, tfr, epoch, hann };
})(typeof window !== 'undefined' ? window : globalThis);
