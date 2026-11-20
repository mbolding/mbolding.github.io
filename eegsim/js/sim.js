/* EEG simulator: making a recording.

   The model is the one ICA assumes: every waveform in the head is a
   generator with a fixed scalp topography and a time course, and every
   electrode records the sum of all of them, x = A s + noise.  Brain
   sources get their topographies from the layered-sphere forward model;
   eye, muscle and heart artifacts from dipoles outside the skull.  Then
   the recording chain is applied in the order the hardware applies it:
   electrode noise, subtraction of the online reference, amplifier noise,
   the analog filters, line pickup through the impedance mismatch, and
   finally the digitizer's quantization and clipping. */
(function (G) {
  'use strict';
  const EEG = G.EEG, v3 = EEG.v3, dsp = EEG.dsp;

  EEG.ARTIFACTS = ['blinks', 'saccades', 'muscle', 'cardiac', 'line', 'drift', 'pops', 'bad'];
  EEG.ARTIFACT_INFO = {
    blinks: { label: 'Blinks', desc: 'The eyelid slides over the positively charged cornea: a large positive wave at Fp1 and Fp2, a few hundred milliseconds long, fading toward the back of the head.' },
    saccades: { label: 'Eye movements', desc: 'Each eye is a dipole, cornea positive. A sideways glance swings both dipoles and leaves a box-shaped step, positive on the side the eyes moved toward, negative on the other.' },
    muscle: { label: 'Muscle', desc: 'Temporalis, frontalis and neck muscles fire in bursts. Their activity is broadband above about 20 Hz and confined to the electrodes nearest the muscle.' },
    cardiac: { label: 'Cardiac', desc: 'The heart is far away, so its field is nearly uniform over the head: a small QRS spike on every channel about once a second, largest with a mastoid reference.' },
    line: { label: 'Line noise', desc: 'Mains voltage couples into the body as a common-mode signal. The differential amplifier rejects most of it; an impedance mismatch between an electrode and the reference converts some of it into a differential signal.' },
    drift: { label: 'Slow drift', desc: 'Sweat and electrode polarization add slow, wandering offsets, larger at high-impedance electrodes.' },
    pops: { label: 'Electrode pops', desc: 'A sudden change at one electrode’s gel interface: a step on a single channel, then a slow exponential recovery.' },
    bad: { label: 'High-impedance channel', desc: 'One electrode is poorly attached. Its impedance raises its thermal noise, its line pickup and its drift.' }
  };
  EEG.GROUP_KIND_LABEL = { source: 'Brain source', background: 'Background EEG', artifact: 'Artifact', sensor: 'Sensor noise' };

  /* ---------- the timeline ---------- */
  function compileTimeline(cfg, rng) {
    let t = 0;
    const blocks = [], events = [], conds = [];
    cfg.timeline.segments.forEach(seg => {
      if (seg.kind === 'block') { blocks.push({ t0: t, t1: t + seg.dur, state: seg.state, task: false }); t += seg.dur; return; }
      // Exact condition counts by largest remainder, then ordered
      const raw = seg.conditions.map(c => c.p * seg.n);
      const cnt = raw.map(Math.floor);
      let left = seg.n - cnt.reduce((a, b) => a + b, 0);
      raw.map((r, i) => [r - cnt[i], i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => cnt[i]++);
      let list = [];
      if (seg.order === 'alternate') {
        const c2 = cnt.slice();
        while (list.length < seg.n) c2.forEach((c, i) => { if (c2[i] > 0) { list.push(seg.conditions[i].name); c2[i]--; } });
      } else {
        seg.conditions.forEach((c, i) => { for (let k = 0; k < cnt[i]; k++) list.push(c.name); });
        if (seg.order === 'random') for (let i = list.length - 1; i > 0; i--) { const j = rng.int(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
      }
      seg.conditions.forEach(c => { if (!conds.includes(c.name)) conds.push(c.name); });
      const t0 = t;
      let tt = t + 1.0;
      list.forEach(cond => { events.push({ t: tt, cond }); tt += seg.isi + rng.uniform(0, seg.jitter); });
      const t1 = events[events.length - 1].t + 1.5;
      blocks.push({ t0, t1, state: 'open', task: true });
      t = t1;
    });
    return { blocks, events, conditions: conds, dur: t };
  }
  EEG.compileTimeline = compileTimeline;

  /* ---------- waveform helpers ---------- */
  function normalize(a) { const r = EEG.rms(a) || 1; for (let i = 0; i < a.length; i++) a[i] /= r; return a; }
  // White noise through a two-pole resonator: a rhythm that waxes and wanes.
  function narrowband(n, fs, f, bw, rng) {
    const r = Math.exp(-Math.PI * bw / fs), w = 2 * Math.PI * f / fs;
    const a1 = 2 * r * Math.cos(w), a2 = -r * r;
    const out = new Float32Array(n);
    let y1 = 0, y2 = 0;
    for (let i = -Math.round(3 * fs); i < n; i++) {
      const y = a1 * y1 + a2 * y2 + rng.gauss();
      y2 = y1; y1 = y;
      if (i >= 0) out[i] = y;
    }
    return normalize(out);
  }
  // Approximately 1/f noise (Kellet's filter bank), steepened above about 20 Hz.
  function pink(n, fs, rng, lpHz) {
    const out = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, lp = 0;
    const al = 1 - Math.exp(-2 * Math.PI * (lpHz || 20) / fs);
    for (let i = -Math.round(2 * fs); i < n; i++) {
      const w = rng.gauss();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      lp += al * (p - lp);
      if (i >= 0) out[i] = lp;
    }
    return normalize(out);
  }
  function addBump(tc, fs, tc0, sigma, amp) {
    const c = tc0 * fs, s = sigma * fs, i0 = Math.max(0, Math.floor(c - 4 * s)), i1 = Math.min(tc.length - 1, Math.ceil(c + 4 * s));
    for (let i = i0; i <= i1; i++) { const z = (i - c) / s; tc[i] += amp * Math.exp(-0.5 * z * z); }
  }
  function poisson(rng, rate, t0, t1, minGap) {
    const out = [];
    if (!(rate > 0)) return out;
    let t = t0 + rng.exp(rate);
    while (t < t1) { out.push(t); t += (minGap || 0) + rng.exp(rate); }
    return out;
  }
  // Seconds within blocks of a given eye state, as [t0, t1] ranges.
  function stateRanges(blocks, state) { return blocks.filter(b => b.state === state).map(b => [b.t0, b.t1]); }
  function eventsInRanges(rng, rate, ranges, margin) {
    const out = [];
    ranges.forEach(([a, b]) => { out.push(...poisson(rng, rate, a + margin, b - margin, 0.6)); });
    return out;
  }

  function dipTopo(model, pos, ori, elecU) {
    const L = EEG.leadfield(model, pos, elecU);
    const t = new Float64Array(elecU.length);
    for (let e = 0; e < elecU.length; e++) t[e] = L[3 * e] * ori[0] + L[3 * e + 1] * ori[1] + L[3 * e + 2] * ori[2];
    return t;
  }
  // Artifact topographies are scaled so the largest scalp value is 1; their
  // amplitudes in the program are then microvolts at the worst electrode.
  function unitTopo(t, nCap) {
    let m = 0; for (let e = 0; e < nCap; e++) m = Math.max(m, Math.abs(t[e]));
    for (let e = 0; e < t.length; e++) t[e] /= (m || 1);
    return t;
  }

  /* Analog Butterworth response at f/fc, used to attenuate line harmonics
     before they are sampled: aliasing happens in the digitizer, so a
     digital filter afterwards could not remove what has already folded. */
  function analogButter(order, x) {
    let hr = 1, hi = 0;
    for (let k = 0; k < order; k++) {
      const ang = Math.PI * (2 * k + order + 1) / (2 * order), pr = Math.cos(ang), pi = Math.sin(ang);
      // (-p) / (j x - p)
      const nr = -pr, ni = -pi, dr = -pr, di = x - pi, m = dr * dr + di * di;
      const qr = (nr * dr + ni * di) / m, qi = (ni * dr - nr * di) / m;
      const tr = hr * qr - hi * qi; hi = hr * qi + hi * qr; hr = tr;
    }
    return { mag: Math.hypot(hr, hi), phase: Math.atan2(hi, hr) };
  }
  EEG.analogButter = analogButter;

  /* ---------- simulate ---------- */
  EEG.simulate = function (cfg) {
    const R = cfg.recording, fs = R.fs, seed = R.seed;
    const tl = compileTimeline(cfg, EEG.stream(seed, 'timeline'));
    const n = Math.round(tl.dur * fs);
    const capLabels = EEG.capLabels(R.cap);
    const rowLabels = capLabels.concat(['M1', 'M2']);
    const elecLabels = rowLabels.slice();
    if (!elecLabels.includes(R.reference)) elecLabels.push(R.reference);
    const elecU = elecLabels.map(l => EEG.ELEC[l]);
    const refE = elecLabels.indexOf(R.reference);
    const nCap = capLabels.length, nE = elecLabels.length;
    const model = EEG.headModel({ sigma: cfg.head.sigma, homogeneous: cfg.head.homogeneous });
    const outside = EEG.headModel({ homogeneous: true });
    tl.events.forEach(ev => { ev.sample = Math.round(ev.t * fs); ev.ci = tl.conditions.indexOf(ev.cond); });
    const ds = {
      cfg, fs, n, dur: n / fs, capLabels, rowLabels, nCap, elecLabels, elecU, refE, model,
      blocks: tl.blocks, events: tl.events, conditions: tl.conditions, gens: [], groups: []
    };
    const openR = stateRanges(tl.blocks, 'open');

    // Eye state at every sample, smoothed: the alpha envelope and the blink gate use it.
    const eyesClosed = new Uint8Array(n);
    tl.blocks.forEach(b => { if (b.state === 'closed') eyesClosed.fill(1, Math.round(b.t0 * fs), Math.min(n, Math.round(b.t1 * fs))); });
    ds.eyesClosed = eyesClosed;

    /* --- brain sources --- */
    cfg.sources.forEach((s, si) => {
      const st = EEG.stream(seed, 'src:' + s.name);
      const add = (label, g, tc, extra) => ds.gens.push(Object.assign({
        group: s.name, kind: 'source', label, pos: g.pos, ori: g.ori, tc, topo: dipTopo(model, g.pos, g.ori, elecU), slot: si
      }, extra || {}));
      if (s.type === 'dipole') {
        let tc;
        if (s.signal === 'sine') { tc = new Float32Array(n); const ph = st.uniform(0, 2 * Math.PI); for (let i = 0; i < n; i++) tc[i] = s.amp * Math.sin(2 * Math.PI * s.freq * i / fs + ph); }
        else { tc = s.signal === 'burst' ? narrowband(n, fs, s.freq, 1.5, st) : pink(n, fs, st, 30); for (let i = 0; i < n; i++) tc[i] *= s.amp / Math.SQRT2; }
        add(s.label, s, tc);
      } else if (s.type === 'pair') {
        const lagS = Math.round(Math.abs(s.lag) * fs);
        const common = narrowband(n + lagS, fs, s.freq, 2, st);
        const ia = narrowband(n, fs, s.freq, 2, st), ib = narrowband(n, fs, s.freq, 2, st);
        const kc = Math.sqrt(s.coupling), ki = Math.sqrt(1 - s.coupling), A = s.amp / Math.SQRT2;
        const ta = new Float32Array(n), tb = new Float32Array(n);
        // B lags A by `lag`: B(t) sees the common drive A saw lag seconds earlier
        const oa = s.lag >= 0 ? lagS : 0, ob = s.lag >= 0 ? 0 : lagS;
        for (let i = 0; i < n; i++) { ta[i] = A * (kc * common[i + oa] + ki * ia[i]); tb[i] = A * (kc * common[i + ob] + ki * ib[i]); }
        add(s.label + ' ' + s.dipoles[0].name, s.dipoles[0], ta, { part: 0 });
        add(s.label + ' ' + s.dipoles[1].name, s.dipoles[1], tb, { part: 1 });
      } else if (s.type === 'alpha') {
        // Envelope follows the eyes with a 0.4 s lag, and dips after each stimulus (ERD)
        const env = new Float32Array(n), a = Math.exp(-1 / (0.4 * fs));
        let y = eyesClosed[0] ? s.closed : s.open;
        for (let i = 0; i < n; i++) { const tgt = eyesClosed[i] ? s.closed : s.open; y = tgt + (y - tgt) * a; env[i] = y; }
        if (s.erd > 0) tl.events.forEach(ev => {
          const i0 = Math.round((ev.t + 0.1) * fs), i1 = Math.min(n, Math.round((ev.t + 1.0) * fs));
          for (let i = i0; i < i1; i++) { const u = (i / fs - ev.t - 0.1) / 0.9; env[i] *= 1 - s.erd * Math.pow(Math.sin(Math.PI * u), 2); }
        });
        const common = narrowband(n, fs, s.freq, s.bandwidth, st);
        const A = s.amp / Math.SQRT2;
        s.dipoles.forEach((d, k) => {
          const own = narrowband(n, fs, s.freq, s.bandwidth, st), tc = new Float32Array(n);
          for (let i = 0; i < n; i++) tc[i] = A * env[i] * (0.9 * common[i] + 0.436 * own[i]);
          add(s.label + ' ' + d.name, d, tc, { part: k });
        });
        ds.alphaEnvelope = env;
      } else if (s.type === 'erp') {
        const tc = new Float32Array(n), jit = [];
        const gainOf = c => s.conditions.length ? ((s.conditions.find(x => x.name === c) || { gain: 0 }).gain) : 1;
        tl.events.forEach(ev => {
          const j = s.jitter ? EEG.clamp(st.gauss() * s.jitter, -3 * s.jitter, 3 * s.jitter) : 0;
          const av = Math.max(0.2, 1 + 0.15 * st.gauss());
          jit.push(j);
          const g = gainOf(ev.cond);
          if (!g) return;
          s.peaks.forEach(p => addBump(tc, fs, ev.t + p.latency + j, p.width / 2.3548, s.amp * g * p.gain * av));
        });
        add(s.label, s, tc, { jitter: jit });
      } else if (s.type === 'spike') {
        const tc = new Float32Array(n);
        const times = poisson(st, s.rate, 0.8, tl.dur - 1, 0.4);
        const w = s.width;
        times.forEach(t0 => {
          // a sharp asymmetric spike, then an aftergoing slow wave of the same sign
          const c = t0 * fs, sr = w / 6 * fs, sf = w / 3 * fs;
          for (let i = Math.max(0, Math.floor(c - 4 * sr)); i < Math.min(n, Math.ceil(c + 4 * sf)); i++) {
            const z = (i - c) / (i < c ? sr : sf); tc[i] += s.amp * Math.exp(-0.5 * z * z);
          }
          addBump(tc, fs, t0 + w / 2 + 0.13, 0.07, s.amp * s.wave);
          addBump(tc, fs, t0 + w / 2 + 0.01, 0.012, -0.15 * s.amp);
        });
        add(s.label, s, tc, { events: times });
      }
      ds.groups.push({ id: s.name, label: s.label, kind: 'source', type: s.type, slot: si, on: true });
    });

    /* --- background EEG: random cortical dipoles with 1/f time courses --- */
    if (R.background > 0) {
      const st = EEG.stream(seed, 'background');
      const K = 16, sum = elecLabels.map(() => new Float32Array(n));
      ds.bgDipoles = [];
      for (let k = 0; k < K; k++) {
        let u; do { u = v3.unit([st.gauss(), st.gauss(), st.gauss()]); } while (u[2] < -0.15);
        const pos = v3.scale(u, st.uniform(6.6, 7.8));
        const ori = EEG.orientation(pos, st.uniform(0, 40), st.uniform(0, 360));
        const topo = dipTopo(model, pos, ori, elecU), tc = pink(n, fs, st, 22);
        for (let e = 0; e < nE; e++) { const w = topo[e], o = sum[e]; for (let i = 0; i < n; i++) o[i] += w * tc[i]; }
        ds.bgDipoles.push({ pos, ori });
      }
      // Scale to the requested RMS, measured on the average-referenced cap
      let ss = 0, cnt = 0;
      const step = Math.max(1, Math.floor(n / 4000));
      for (let i = 0; i < n; i += step) {
        let m = 0; for (let e = 0; e < nCap; e++) m += sum[e][i]; m /= nCap;
        for (let e = 0; e < nCap; e++) { const d = sum[e][i] - m; ss += d * d; cnt++; }
      }
      const k = R.background / Math.sqrt(ss / cnt);
      sum.forEach(a => { for (let i = 0; i < n; i++) a[i] *= k; });
      ds.bgSum = sum;
      ds.groups.push({ id: 'background', label: 'Background EEG', kind: 'background', on: true });
    }

    /* --- artifacts with topographies --- */
    const A = cfg.artifacts;
    const eyeL = [-3.2, 7.0, -2.6], eyeR = [3.2, 7.0, -2.6];
    ds.eyes = [eyeL, eyeR];
    const artGen = (group, label, topo, tc, extra) => ds.gens.push(Object.assign({ group, kind: 'artifact', label, topo, tc }, extra || {}));
    {
      // Blinks: vertical eye dipoles, only while the eyes are open
      const st = EEG.stream(seed, 'blinks');
      const ori = v3.unit([0, 0.45, 1]);
      const bL = dipTopo(outside, eyeL, ori, elecU), bR = dipTopo(outside, eyeR, ori, elecU);
      const topo = unitTopo(bL.map((x, e) => x + bR[e]), nCap);
      const tc = new Float32Array(n), times = eventsInRanges(st, A.blinks.rate, openR, 0.3);
      times.forEach(t0 => {
        const amp = A.blinks.amp * st.uniform(0.7, 1.3), i0 = Math.round(t0 * fs), len = Math.round(0.7 * fs);
        for (let i = 0; i < len && i0 + i < n; i++) { const t = i / fs; tc[i0 + i] += amp * Math.pow(t / 0.11, 2) * Math.exp(2 * (1 - t / 0.11)); }
      });
      artGen('blinks', 'Blinks', topo, tc, { events: times });
    }
    {
      // Horizontal saccades: both eye dipoles swing left or right together
      const st = EEG.stream(seed, 'saccades');
      const ori = [1, 0, 0];
      const tL = dipTopo(outside, eyeL, ori, elecU), tR = dipTopo(outside, eyeR, ori, elecU);
      const topo = unitTopo(tL.map((x, e) => x + tR[e]), nCap);
      const tc = new Float32Array(n), times = eventsInRanges(st, A.saccades.rate, openR, 0.5);
      let gaze = 0, i = 0;
      const ramp = Math.round(0.04 * fs);
      const target = new Float32Array(n);
      times.forEach(t0 => {
        const away = st.pick([-1, -0.6, 0.6, 1]), hold = st.uniform(0.4, 1.6);
        const a = Math.round(t0 * fs), b = Math.min(n, Math.round((t0 + hold) * fs));
        for (let k = a; k < b; k++) target[k] = away;
      });
      for (i = 0; i < n; i++) { gaze += EEG.clamp(target[i] - gaze, -1 / ramp, 1 / ramp); tc[i] = A.saccades.amp * gaze; }
      artGen('saccades', 'Eye movements', topo, tc, { events: times });
    }
    {
      // Muscle: four generators just inside the scalp, bursting in plausible combinations
      const st = EEG.stream(seed, 'muscle');
      const sites = [
        { label: 'Left temporalis', u: EEG.sph(100, -78) },
        { label: 'Right temporalis', u: EEG.sph(100, 78) },
        { label: 'Frontalis', u: EEG.sph(78, 0) },
        { label: 'Neck', u: EEG.sph(118, 180) }
      ];
      const hp = dsp.butter('high', 2, 20, fs), lp = fs > 400 ? dsp.butter('low', 2, 150, fs) : null;
      const envs = sites.map((_, k) => { const e = new Float32Array(n); if (k < 2) e.fill(0.06); return e; });
      const patterns = [[0, 1], [0, 1], [0, 1], [2], [3], [3], [0], [1]];
      poisson(st, A.muscle.rate, 0.5, tl.dur - 0.5, 0.5).forEach(t0 => {
        const pat = st.pick(patterns), d = st.uniform(0.6, 2.0), edge = 0.12;
        const i0 = Math.round(t0 * fs), i1 = Math.min(n, Math.round((t0 + d) * fs));
        for (let i = i0; i < i1; i++) {
          const t = i / fs - t0, g = Math.min(1, t / edge, (d - t) / edge);
          pat.forEach(k => { envs[k][i] = Math.max(envs[k][i], g * st.uniform(0.85, 1)); });
        }
      });
      sites.forEach((s, k) => {
        const pos = v3.scale(s.u, 0.88 * EEG.HEAD.R);
        const ori = EEG.orientation(pos, 90, 0, 'Cz');
        const topo = unitTopo(dipTopo(outside, pos, ori, elecU), nCap);
        const car = new Float32Array(n); for (let i = 0; i < n; i++) car[i] = st.gauss();
        dsp.sosfilt(hp, car); if (lp) dsp.sosfilt(lp, car); normalize(car);
        const tc = new Float32Array(n); for (let i = 0; i < n; i++) tc[i] = A.muscle.amp * envs[k][i] * car[i];
        artGen('muscle', s.label, topo, tc, { site: s.u });
      });
    }
    {
      // Cardiac: a distant dipole gives a nearly linear potential gradient across the head
      const st = EEG.stream(seed, 'cardiac');
      const d = v3.unit([-0.7, 0.25, -0.65]);
      const topo = unitTopo(Float64Array.from(elecU, u => v3.dot(u, d)), nCap);
      const tc = new Float32Array(n), beats = [];
      const waves = [[0.12, -0.18, 0.025], [-0.12, -0.035, 0.009], [1, 0, 0.011], [-0.3, 0.035, 0.011], [0.28, 0.25, 0.05]];
      let t = 0.3 + st.uniform(0, 0.5);
      while (t < tl.dur - 0.4) {
        beats.push(t);
        waves.forEach(([a, c, s]) => addBump(tc, fs, t + c, s, A.cardiac.amp * a));
        t += (1 / A.cardiac.rate) * (1 + 0.04 * Math.sin(2 * Math.PI * 0.25 * t) + 0.02 * st.gauss());
      }
      artGen('cardiac', 'Cardiac', topo, tc, { events: beats });
    }

    /* --- electrode properties: impedance, drift, pops --- */
    const zs = EEG.stream(seed, 'impedance');
    ds.Z = Float64Array.from(elecLabels, () => R.impedance * Math.exp(0.35 * zs.gauss()));
    ds.Zbad = Float64Array.from(ds.Z);
    const badE = elecLabels.indexOf(A.bad.label);
    if (badE >= 0) ds.Zbad[badE] = A.bad.impedance;
    ds.badE = badE;
    {
      const st = EEG.stream(seed, 'pops');
      ds.pops = poisson(st, A.pops.rate, 1, tl.dur - 1, 0.3).map(t0 => {
        // the bad electrode pops far more often than the rest
        const w = elecLabels.map((_, e) => (e === refE && e !== badE) ? 0 : (e === badE ? 12 : 1));
        let r = st.uniform(0, w.reduce((a, b) => a + b, 0)), e = 0;
        while (r > w[e]) { r -= w[e]; e++; }
        return { e: Math.min(e, nE - 1), t0, amp: A.pops.amp * st.uniform(0.5, 1.5) * (st.next() < 0.5 ? -1 : 1), tau: st.uniform(0.3, 1.2) };
      });
    }
    {
      // Line noise: common-mode waveform at the body, attenuated by the analog anti-alias filter
      const st = EEG.stream(seed, 'line');
      const wave = new Float32Array(n), quad = new Float32Array(n);
      const harm = [[1, 1], [2, 0.08], [3, 0.25], [5, 0.06]];
      const lpOn = R.lp && R.lp < 100000;
      harm.forEach(([h, a]) => {
        const f = R.mains * h, ph = st.uniform(0, 2 * Math.PI);
        const H = lpOn ? analogButter(4, f / R.lp) : { mag: 1, phase: 0 };
        for (let i = 0; i < n; i++) wave[i] += a * H.mag * Math.sin(2 * Math.PI * f * i / fs + ph + H.phase);
        if (h === 1) for (let i = 0; i < n; i++) quad[i] = H.mag * Math.cos(2 * Math.PI * f * i / fs + ph + H.phase);
      });
      ds.line = { wave, quad, direct: Float64Array.from(rowLabels, () => 0.25 * st.gauss()) };
    }

    // Group list for the toggles, in a fixed order
    EEG.ARTIFACTS.forEach(k => ds.groups.push({ id: k, label: EEG.ARTIFACT_INFO[k].label, kind: 'artifact', on: !!A[k].on }));
    ds.groups.push({ id: 'sensor', label: 'Electrode and amplifier noise', kind: 'sensor', on: true });
    return ds;
  };

  /* Line coupling coefficient for each recorded row: the fraction of the
     body's common-mode voltage that appears between the row's electrode and
     the reference.  Each electrode impedance and the amplifier input
     impedance form a voltage divider; when the two dividers differ, part of
     the common mode becomes differential.  The rest leaks through the
     finite common-mode rejection ratio. */
  EEG.lineCoupling = function (ds, badOn) {
    const R = ds.cfg.recording, Z = badOn ? ds.Zbad : ds.Z, Zin = R.input, zr = Z[ds.refE];
    const leak = Math.pow(10, -R.cmrr / 20);
    return ds.rowLabels.map(l => {
      const e = ds.elecLabels.indexOf(l);
      return Zin / (Zin + Z[e]) - Zin / (Zin + zr) + leak;
    });
  };

  /* ---------- assemble a recording ----------
     opt.enabled is a Set of group ids.  opt.noise = false skips the
     electrode and amplifier noise, opt.filters = false the analog filters
     and opt.quantize = false the digitizer, which is how the noise-free
     "truth" signals are made for comparison. */
  EEG.assemble = function (ds, opt) {
    const on = g => opt.enabled.has(g);
    const noiseOn = opt.noise !== false && on('sensor');
    const { fs, rowLabels, elecLabels, refE } = ds;
    const R = ds.cfg.recording;
    // opt.range = [i0, i1) assembles only that window (no filters there: they need history)
    const i0 = opt.range ? opt.range[0] : 0, n = opt.range ? opt.range[1] - opt.range[0] : ds.n;
    const nRow = rowLabels.length;
    const rowE = rowLabels.map(l => elecLabels.indexOf(l));
    const rows = rowLabels.map(() => new Float32Array(n));
    const refRow = rowE.indexOf(refE);

    if (on('background') && ds.bgSum) {
      const b = ds.bgSum[refE];
      for (let r = 0; r < nRow; r++) { const a = ds.bgSum[rowE[r]], o = rows[r]; for (let i = 0; i < n; i++) o[i] = a[i0 + i] - b[i0 + i]; }
    }
    ds.gens.forEach(g => {
      if (!on(g.group)) return;
      const tr = g.topo[refE], tc = g.tc;
      for (let r = 0; r < nRow; r++) {
        const w = g.topo[rowE[r]] - tr;
        if (Math.abs(w) < 1e-9) continue;
        const o = rows[r];
        for (let i = 0; i < n; i++) o[i] += w * tc[i0 + i];
      }
    });

    // Electrode-local signals.  Whatever happens at the reference electrode
    // is subtracted from every channel.
    const badOn = on('bad'), Z = badOn ? ds.Zbad : ds.Z, Z0 = R.impedance;
    const driftOn = on('drift'), popsOn = on('pops');
    const cache = ds.noiseCache || (ds.noiseCache = {});
    function local(e) {
      if (!noiseOn && !driftOn && !popsOn) return null;
      const x = new Float32Array(n), lab = elecLabels[e], zr = Math.sqrt(Z[e] / Z0);
      if (noiseOn) {
        // electrode noise at the nominal impedance, cached; it scales as sqrt(Z)
        let u = cache['e:' + lab];
        if (!u) {
          const st = EEG.stream(R.seed, 'enoise:' + lab), N = ds.n;
          const p = pink(N, fs, st, 40);
          u = cache['e:' + lab] = new Float32Array(N);
          for (let i = 0; i < N; i++) u[i] = 0.35 * st.gauss() + 0.45 * p[i];
        }
        for (let i = 0; i < n; i++) x[i] = zr * u[i0 + i];
      }
      if (driftOn) {
        // a random walk sampled at 10 Hz, high-passed at 0.02 Hz and interpolated
        const st = EEG.stream(R.seed, 'drift:' + lab);
        const m = Math.ceil(ds.n / fs * 10) + 2, d = new Float64Array(m);
        let w = 0, y = 0, prev = 0; const a = Math.exp(-2 * Math.PI * 0.02 / 10);
        for (let k = 0; k < m; k++) { w += st.gauss(); y = a * (y + w - prev); prev = w; d[k] = y; }
        const r = EEG.rms(d) || 1, amp = ds.cfg.artifacts.drift.amp * zr * st.uniform(0.4, 1.6) / r;
        for (let i = 0; i < n; i++) { const f = (i0 + i) / fs * 10, k = Math.floor(f), t = f - k; x[i] += amp * (d[k] * (1 - t) + d[k + 1] * t); }
      }
      if (popsOn) ds.pops.forEach(p => {
        if (p.e !== e) return;
        const a = Math.round(p.t0 * fs), rise = Math.max(1, Math.round(0.004 * fs));
        for (let i = Math.max(a, i0); i < i0 + n; i++) {
          const t = (i - a) / fs, v = p.amp * Math.min(1, (i - a + 1) / rise) * Math.exp(-t / p.tau);
          if (Math.abs(v) < 0.01 && t > p.tau) break;
          x[i - i0] += v;
        }
      });
      return x;
    }
    const refLocal = local(refE);
    for (let r = 0; r < nRow; r++) {
      if (r === refRow) continue;
      const x = local(rowE[r]), o = rows[r];
      if (x) for (let i = 0; i < n; i++) o[i] += x[i];
      if (refLocal) for (let i = 0; i < n; i++) o[i] -= refLocal[i];
      if (noiseOn) {
        let u = cache['a:' + rowLabels[r]];
        if (!u) { const st = EEG.stream(R.seed, 'anoise:' + rowLabels[r]), N = ds.n; u = cache['a:' + rowLabels[r]] = new Float32Array(N); for (let i = 0; i < N; i++) u[i] = 0.25 * st.gauss(); }
        for (let i = 0; i < n; i++) o[i] += u[i0 + i];
      }
    }

    // The analog filters, causal as all hardware is
    if (opt.filters !== false && !opt.range) {
      const sos = [];
      if (R.hp) sos.push(...dsp.butter('high', 1, R.hp, fs));
      if (R.lp && R.lp < fs / 2) sos.push(...dsp.butter('low', 4, R.lp, fs));
      if (sos.length) rows.forEach((o, r) => { if (r !== refRow) dsp.sosfilt(sos, o); });
    }

    // Line pickup, already shaped by the analog filter when it was generated
    if (on('line')) {
      const k = EEG.lineCoupling(ds, badOn), Vcm = ds.cfg.artifacts.line.amp, L = ds.line;
      for (let r = 0; r < nRow; r++) {
        if (r === refRow) continue;
        const a = k[r] * Vcm, b = L.direct[r], o = rows[r];
        for (let i = 0; i < n; i++) o[i] += a * L.wave[i0 + i] + b * L.quad[i0 + i];
      }
    }

    // The digitizer: round to the nearest step and clip at the input range
    if (opt.quantize !== false) {
      const range = R.range, step = 2 * range / Math.pow(2, R.bits), hi = range - step;
      rows.forEach(o => { for (let i = 0; i < n; i++) { let v = Math.round(o[i] / step) * step; o[i] = v > hi ? hi : v < -range ? -range : v; } });
    }
    if (refRow >= 0) rows[refRow].fill(0);
    return { labels: rowLabels.slice(), rows, nCap: ds.nCap, fs, refRow, n };
  };

  // The topography each generator leaves on the recorded rows, before any
  // re-referencing.  Used to match ICA components with what caused them.
  EEG.rowTopo = function (ds, topo) {
    const tr = topo[ds.refE];
    return ds.rowLabels.map(l => topo[ds.elecLabels.indexOf(l)] - tr);
  };
})(typeof window !== 'undefined' ? window : globalThis);
