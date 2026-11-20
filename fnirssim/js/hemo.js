/* fNIRS simulator: haemodynamics and physiology.

   - The balloon model (Buxton, Wong and Frank 1998; Friston and colleagues
     2000) turns neural activity into blood flow f, venous volume v and
     deoxyhaemoglobin content q.  Oxygen consumption is tied to flow by a
     coupling ratio n (Davis, Hoge), and can be made to lead flow, which
     produces an initial dip.  From f, v and q come the tissue
     concentration changes fNIRS measures and the BOLD signal fMRI
     measures, so the two modalities see one and the same event.
   - Haemodynamic response functions for the GLM.
   - Generators for the systemic physiology that contaminates every
     channel: the cardiac pulse, respiration, Mayer waves, very slow
     drift and the task-evoked change in blood pressure. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;

  NIRS.BALLOON = {
    kappa: 0.55,   // decay of the vasodilatory signal, 1/s
    gamma: 0.30,   // flow-dependent elimination (autoregulation), 1/s
    tau: 2.5,      // mean transit time of the venous compartment, s
    tauN: 1.0,     // neurovascular delay: the vasodilatory signal follows activity with this time constant, s
    dipWeight: 0.35, // with dip on, the share of CMRO2 that follows activity directly rather than flow
    alpha: 0.25,   // Grubb's exponent, volume = flow^alpha at steady state
    E0: 0.40,      // resting oxygen extraction fraction
    n: 2.5,        // coupling ratio: fractional change in CBF / fractional change in CMRO2
    hbt0: 80, hbr0: 25,   // resting tissue concentrations in gray matter, µM
    V0: 0.03       // resting venous blood volume fraction (for BOLD)
  };

  /* Integrate the balloon model.  u is neural activity sampled every dt
     seconds (1 means the activity that sustains a flow increase of
     `flow`); opts may override any of the parameters above and add
     dip: true (CMRO2 follows activity with its own, faster time constant).
     Returns arrays of f, v, q, m (CMRO2) and the derived changes in HbO,
     HbR, HbT (µM) and BOLD (fractional). */
  NIRS.balloon = function (u, dt, flow, opts) {
    const P = Object.assign({}, NIRS.BALLOON, opts || {});
    const n = u.length;
    const f = new Float64Array(n), v = new Float64Array(n), q = new Float64Array(n), m = new Float64Array(n);
    const hbo = new Float64Array(n), hbr = new Float64Array(n), hbt = new Float64Array(n), bold = new Float64Array(n);
    const eps = flow * P.gamma;              // steady-state flow change equals flow * u
    const sub = Math.max(1, Math.ceil(dt / 0.05)), h = dt / sub;
    let s = 0, F = 1, V = 1, Q = 1, M = 1, ulp = 0, un = 0;
    const k1 = 7 * P.E0, k2 = 2, k3 = 2 * P.E0 - 0.2;
    for (let i = 0; i < n; i++) {
      const ui = u[i];
      for (let k = 0; k < sub; k++) {
        un += h * (ui - un) / P.tauN;
        const ds = eps * un - P.kappa * s - P.gamma * (F - 1);
        const fout = Math.pow(V, 1 / P.alpha);
        let mm;
        if (P.dip) {
          ulp += h * (ui - ulp) / 0.6;
          mm = 1 + ((1 - P.dipWeight) * (F - 1) + P.dipWeight * flow * ulp) / P.n;
        } else mm = 1 + (F - 1) / P.n;
        const dV = (F - fout) / P.tau;
        const dQ = (mm - fout * Q / V) / P.tau;
        s += h * ds; F += h * s; V += h * dV; Q += h * dQ;
        if (F < 0.2) F = 0.2;
        M = mm;
      }
      f[i] = F; v[i] = V; q[i] = Q; m[i] = M;
      hbr[i] = P.hbr0 * (Q - 1);
      hbt[i] = P.hbt0 * (V - 1);
      hbo[i] = hbt[i] - hbr[i];
      bold[i] = P.V0 * (k1 * (1 - Q) + k2 * (1 - Q / V) + k3 * (1 - V));
    }
    return { f, v, q, m, hbo, hbr, hbt, bold };
  };

  /* ---------- haemodynamic response functions ---------- */
  function gammaPdf(t, k, theta) {
    if (t <= 0) return 0;
    return Math.exp((k - 1) * Math.log(t) - t / theta - NIRS.lgamma(k) - k * Math.log(theta));
  }
  NIRS.gammaPdf = gammaPdf;
  // SPM's canonical double gamma: peak near 5 s, undershoot near 15 s.
  NIRS.hrfCanonical = t => gammaPdf(t, 6, 1) - gammaPdf(t, 16, 1) / 6;
  // A single gamma peaking at 6 s with no undershoot (Homer's default shape).
  NIRS.hrfGamma = t => (t > 0 ? (t / 3) * (t / 3) * Math.exp(-t / 3) : 0);
  NIRS.HRFS = { canonical: NIRS.hrfCanonical, gamma: NIRS.hrfGamma };

  // Convolve a stimulus series (sampled at fs) with an HRF, normalized to unit peak.
  NIRS.convolveHRF = function (x, fs, hrf, deriv) {
    const len = Math.ceil(32 * fs), k = new Float64Array(len);
    let pk = 0;
    for (let i = 0; i < len; i++) { k[i] = hrf(i / fs); if (Math.abs(k[i]) > pk) pk = Math.abs(k[i]); }
    if (deriv) { const d = new Float64Array(len); for (let i = 1; i < len; i++) d[i] = (k[i] - k[i - 1]) * fs; pk = 0; for (let i = 0; i < len; i++) { k[i] = d[i]; if (Math.abs(d[i]) > pk) pk = Math.abs(d[i]); } }
    const n = x.length, out = new Float64Array(n);
    // response to a 1 s boxcar should peak near 1, whatever the sampling rate
    const scale = 1 / (pk * fs);
    for (let i = 0; i < n; i++) {
      const xi = x[i]; if (xi === 0) continue;
      const m = Math.min(len, n - i);
      for (let j = 0; j < m; j++) out[i + j] += xi * k[j] * scale;
    }
    return out;
  };

  /* ---------- physiology ----------
     Each generator returns a unit-amplitude series (peak to peak 1 for the
     periodic ones, a typical excursion of 1 for the noisy ones); the
     simulation scales it to micromolar and spreads it over the layers. */
  NIRS.physio = {
    // Arterial pulse with heart-rate variability and respiratory sinus arrhythmia.
    cardiac(n, fs, rateHz, respHz, r) {
      const out = new Float64Array(n);
      const slow = NIRS.shapedNoise(n, fs, f => (f < 0.05 ? 1 : f < 0.15 ? 0.3 : 0), r);
      let ph = r.next();
      for (let i = 0; i < n; i++) {
        const t = i / fs;
        const rate = rateHz * (1 + 0.035 * slow[i] + 0.025 * Math.sin(2 * Math.PI * respHz * t));
        ph += rate / fs;
        const x = ph - Math.floor(ph);
        // systolic upstroke, then the dicrotic wave
        out[i] = Math.exp(-Math.pow((x - 0.16) / 0.07, 2)) + 0.38 * Math.exp(-Math.pow((x - 0.46) / 0.11, 2));
      }
      normalizeP2P(out);
      return out;
    },
    respiration(n, fs, rateHz, r) {
      const out = new Float64Array(n);
      const slow = NIRS.shapedNoise(n, fs, f => (f < 0.03 ? 1 : 0), r);
      const depth = NIRS.shapedNoise(n, fs, f => (f < 0.02 ? 1 : 0), r);
      let ph = r.next();
      for (let i = 0; i < n; i++) {
        ph += rateHz * (1 + 0.08 * slow[i]) / fs;
        out[i] = (1 + 0.15 * depth[i]) * Math.sin(2 * Math.PI * ph);
      }
      normalizeP2P(out);
      return out;
    },
    // Mayer waves: a narrow band of blood-pressure oscillation near 0.1 Hz.
    mayer(n, fs, centreHz, r) {
      const bw = 0.025;
      const out = NIRS.shapedNoise(n, fs, f => Math.exp(-0.5 * Math.pow((f - centreHz) / bw, 2)), r);
      for (let i = 0; i < n; i++) out[i] *= 1 / 2.8;    // unit sd -> a typical peak-to-peak of about 1
      return out;
    },
    // Spontaneous low-frequency fluctuations (vasomotion and slow drift): a
    // 1/f spectrum from a few minutes' period up to about half a hertz.
    drift(n, fs, r) {
      const out = NIRS.shapedNoise(n, fs, f => (f < 0.002 ? 0 : Math.pow(f / 0.002, -0.6) * Math.exp(-Math.pow(f / 0.5, 2))), r);
      for (let i = 0; i < n; i++) out[i] *= 1 / 2.8;
      return out;
    },
    // Task-evoked systemic response: blood pressure and scalp blood flow rise
    // with each block or trial, a little sooner and broader than the cortical
    // response, with some variability from trial to trial.
    taskBP(n, fs, events, r, opts) {
      opts = opts || {};
      const x = new Float64Array(n);
      events.forEach(ev => {
        const g = Math.max(0, 1 + (opts.variability === undefined ? 0.3 : opts.variability) * r.gauss());
        const i0 = Math.round(ev.t * fs), i1 = Math.max(i0 + 1, Math.round((ev.t + Math.max(ev.dur, 1)) * fs));
        for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) x[i] += g;
      });
      // unit-area kernel: a sustained block settles at 1, a brief trial peaks lower
      const delay = opts.delay || 0, len = Math.ceil(40 * fs), k = new Float64Array(len);
      let area = 0;
      for (let i = 0; i < len; i++) { k[i] = gammaPdf(i / fs - delay, 3, 1.4); area += k[i]; }
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const xi = x[i]; if (xi === 0) continue;
        const m = Math.min(len, n - i);
        for (let j = 0; j < m; j++) out[i + j] += xi * k[j] / area;
      }
      return out;
    }
  };
  function normalizeP2P(a) {
    let lo = Infinity, hi = -Infinity, s = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; s += a[i]; }
    const m = s / a.length, k = hi > lo ? 1 / (hi - lo) : 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - m) * k;
  }

  /* How strongly each systemic signal reaches each layer, and how it
     divides between HbO and HbR.  Scalp is the reference (1).  The brain
     gets a share of the pulse but only a little of the slow waves and
     almost none of the task-evoked blood pressure change, because cerebral
     autoregulation holds brain flow steady while the scalp has none. */
  NIRS.SYSTEMIC = {
    cardiac: { label: 'Cardiac pulsation', hbr: 0.08, layers: { scalp: 1, skull: 0.25, csf: 0, gray: 0.4, white: 0.2 } },
    respiration: { label: 'Respiration', hbr: 0.45, layers: { scalp: 1, skull: 0.25, csf: 0, gray: 0.12, white: 0.06 } },
    mayer: { label: 'Mayer waves', hbr: -0.25, layers: { scalp: 1, skull: 0.25, csf: 0, gray: 0.12, white: 0.06 } },
    drift: { label: 'Low-frequency fluctuations', hbr: -0.3, layers: { scalp: 1, skull: 0.25, csf: 0, gray: 0.12, white: 0.06 } },
    taskbp: { label: 'Task-evoked blood pressure', hbr: -0.12, layers: { scalp: 1, skull: 0.25, csf: 0, gray: 0.04, white: 0.02 } }
  };
})(typeof window !== 'undefined' ? window : globalThis);
