/* MEG simulator: making a recording.

   Every waveform in and around the head is a generator with a time course
   and a spatial pattern at the sensors, and every sensor records the sum,
   x = A s + noise, the model ICA assumes.  Brain sources, the eyes and the
   muscles are current dipoles in the spherical head, seen through the
   Sarvas formula.  The heart, the environment, the mains wiring, dental
   work and the head position coils are magnetic dipoles.  Time courses do
   not depend on the sensors, so the same brain can be recorded with a
   different array; the patterns are recomputed for the array in use and,
   when the head moves, for every head position.

   The recording chain then adds what the hardware adds: the shielded room's
   attenuation of everything outside it, SQUID flux jumps, a misbehaving
   channel, white and 1/f sensor noise, and the online filters. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3, dsp = MEG.dsp;

  MEG.ARTIFACTS = ['environment', 'line', 'cardiac', 'blinks', 'saccades', 'muscle', 'dental', 'jumps', 'bad', 'movement'];
  MEG.ARTIFACT_INFO = {
    environment: { label: 'Environment', desc: 'Moving steel and currents metres away: an elevator, passing cars, the building. Tens of nanotesla at the head and nearly the same at every sensor, because the sources are far away compared with the size of the helmet.' },
    line: { label: 'Line noise', desc: 'Mains-frequency field from the building’s wiring. The shielded room’s aluminium layer is very effective at 50 or 60 Hz, so inside only picotesla remain.' },
    cardiac: { label: 'Cardiac', desc: 'The heart’s own magnetic field. Far from the head, so broad and smooth over the helmet and largest on the lowest sensors. Gradiometers see much less of it than magnetometers.' },
    blinks: { label: 'Blinks', desc: 'The eye is a current dipole like any other. A blink moves charge across it and makes a large slow wave on the frontal sensors.' },
    saccades: { label: 'Eye movements', desc: 'A sideways glance swings both eyes’ dipoles: box-shaped steps on the frontal and temporal sensors.' },
    muscle: { label: 'Muscle', desc: 'Temporalis, frontalis and neck muscles fire in bursts: broadband activity above about 20 Hz on the sensors nearest the muscle.' },
    dental: { label: 'Dental work', desc: 'Magnetized braces, wires or crowns are a permanent magnet in the mouth. Still, they only add a constant offset; every movement of the jaw or head turns them into a large, slow artifact. They sit inside the helmet, so SSS counts them as brain; tSSS can remove them.' },
    jumps: { label: 'SQUID jumps', desc: 'A SQUID’s feedback loop can lose lock when the field changes too fast and relock one flux quantum away: a sudden step on one channel that stays. OPMs have no flux jumps.' },
    bad: { label: 'Bad channel', desc: 'One sensor misbehaving: noisy, flat (dead) or jumpy.' },
    movement: { label: 'Head movement', desc: 'The head drifts and shifts in the helmet. With SQUIDs the sensors stay put and the brain moves under them; with OPMs the sensors move with the head through the room’s residual field.' },
    hpi: { label: 'HPI coils', desc: 'Head position indicator coils on the scalp, driven above the band of interest so the system can track the head.' }
  };
  MEG.GROUP_KIND_LABEL = { source: 'Brain source', background: 'Background brain activity', artifact: 'Artifact', sensor: 'Sensor noise' };

  /* ---------- the shielded room ----------
     Mu-metal layers divert slowly varying fields around the room;
     aluminium adds eddy-current shielding that grows with frequency.  The
     shielding factor is modelled as 500 (54 dB) at DC, rising above
     0.6 Hz and levelling off near 96 dB. */
  MEG.SHIELD = { dc: 500, fc: 0.6, max: 6.3e4 };
  MEG.shieldingFactor = f => Math.min(MEG.SHIELD.max, MEG.SHIELD.dc * Math.sqrt(1 + (f / MEG.SHIELD.fc) * (f / MEG.SHIELD.fc)));
  // Residual static field inside the room, seen only by sensors that move (OPMs).
  MEG.RESIDUAL = { uniform: [9e6, -6e6, 14e6], gradient: [[2e4, 0.5e4, 0], [0.5e4, -1e4, 0.8e4], [0, 0.8e4, -1e4]], nulling: 1 / 25 };   // fT, fT/cm

  /* ---------- the timeline ---------- */
  function compileTimeline(cfg, rng) {
    let t = 0;
    const blocks = [], events = [], conds = [];
    cfg.timeline.segments.forEach(seg => {
      if (seg.kind === 'block') { blocks.push({ t0: t, t1: t + seg.dur, state: seg.state, task: false }); t += seg.dur; return; }
      const raw = seg.conditions.map(c => c.p * seg.n);
      const cnt = raw.map(Math.floor);
      const left = seg.n - cnt.reduce((a, b) => a + b, 0);
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
  MEG.compileTimeline = compileTimeline;

  /* ---------- waveform helpers ---------- */
  function normalize(a) { const r = MEG.rms(a) || 1; for (let i = 0; i < a.length; i++) a[i] /= r; return a; }
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
  // Approximately 1/f noise (Kellet's filter bank), steepened above lpHz.
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
  function addBump(tc, fs, t0, sigma, amp) {
    const c = t0 * fs, s = sigma * fs, i0 = Math.max(0, Math.floor(c - 4 * s)), i1 = Math.min(tc.length - 1, Math.ceil(c + 4 * s));
    for (let i = i0; i <= i1; i++) { const z = (i - c) / s; tc[i] += amp * Math.exp(-0.5 * z * z); }
  }
  // A smooth step from 0 to amp over [t0, t0 + dur].
  function addRamp(tc, fs, t0, dur, amp) {
    const i0 = Math.max(0, Math.round(t0 * fs)), i1 = Math.round((t0 + dur) * fs);
    for (let i = i0; i < tc.length; i++) { const u = i >= i1 ? 1 : (i - t0 * fs) / (dur * fs); tc[i] += amp * (u >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, u))); }
  }
  function poisson(rng, rate, t0, t1, minGap) {
    const out = [];
    if (!(rate > 0)) return out;
    let t = t0 + rng.exp(rate);
    while (t < t1) { out.push(t); t += (minGap || 0) + rng.exp(rate); }
    return out;
  }
  function stateRanges(blocks, state) { return blocks.filter(b => b.state === state).map(b => [b.t0, b.t1]); }
  function eventsInRanges(rng, rate, ranges, margin) {
    const out = [];
    ranges.forEach(([a, b]) => { out.push(...poisson(rng, rate, a + margin, b - margin, 0.6)); });
    return out;
  }
  MEG.wave = { narrowband, pink, addBump, normalize };

  /* ---------- head pose ----------
     The head's position in the helmet over time, sampled at 10 Hz: a slow
     drift, breathing, and now and then a quick shift that partly returns.
     A pose maps head coordinates to device coordinates, p -> R p + c. */
  function makePose(cfg, dur, seed) {
    const fsP = 10, K = Math.max(2, Math.ceil(dur * fsP) + 2);
    const c0 = cfg.head.position.slice();
    const A = cfg.artifacts.movement;
    const tr = [new Float32Array(K), new Float32Array(K), new Float32Array(K)], rot = [new Float32Array(K), new Float32Array(K), new Float32Array(K)];
    const st = MEG.stream(seed, 'movement');
    const amp = A.amp;                        // cm
    // drift: integrated noise through a slow low-pass, scaled to amp/2
    for (let d = 0; d < 6; d++) {
      const x = d < 3 ? tr[d] : rot[d - 3];
      let y = 0, v = 0;
      const a = Math.exp(-2 * Math.PI * 0.01 / fsP);
      for (let k = 0; k < K; k++) { v = a * v + st.gauss(); y = a * y + (1 - a) * v; x[k] = y; }
      const m = MEG.mean(x); for (let k = 0; k < K; k++) x[k] -= m;
      const r = MEG.rms(x) || 1, s = d < 3 ? amp * 0.3 / r : amp * 10 * 0.25 / r;   // rotations: ~0.25 deg per mm of drift
      for (let k = 0; k < K; k++) x[k] *= s;
    }
    // sinking: the head slowly settles downward and backward
    for (let k = 0; k < K; k++) { const u = k / (K - 1); tr[2][k] -= amp * 0.5 * (1 - Math.exp(-3 * u)); tr[1][k] -= amp * 0.2 * u; }
    // jerks
    poisson(st, 1 / 25, 2, dur - 2, 3).forEach(t0 => {
      const dir = v3.unit([st.gauss(), st.gauss(), st.gauss()]), size = amp * st.uniform(0.3, 0.8), back = st.uniform(0.3, 0.9);
      const rotAx = [st.gauss(), st.gauss(), st.gauss()], rotSize = amp * 10 * 0.3 * st.uniform(0.3, 1);
      const rise = st.uniform(0.2, 0.6), hold = st.uniform(1, 6);
      for (let k = 0; k < K; k++) {
        const t = k / fsP - t0;
        if (t < 0) continue;
        const up = t < rise ? 0.5 - 0.5 * Math.cos(Math.PI * t / rise) : 1;
        const g = t < rise + hold ? up : 1 - back * (1 - Math.exp(-(t - rise - hold) / 1.5));
        for (let d = 0; d < 3; d++) { tr[d][k] += dir[d] * size * g; rot[d][k] += rotAx[d] * rotSize * g / 1.7; }
      }
    });
    // breathing
    for (let k = 0; k < K; k++) tr[2][k] += 0.03 * Math.sin(2 * Math.PI * 0.25 * k / fsP);
    // start the trajectory at the nominal position
    for (let d = 0; d < 3; d++) { const a0 = tr[d][0], b0 = rot[d][0]; for (let k = 0; k < K; k++) { tr[d][k] -= a0; rot[d][k] -= b0; } }
    function at(t) {
      const f = MEG.clamp(t * fsP, 0, K - 1.0001), k = Math.floor(f), u = f - k;
      const T = [0, 1, 2].map(d => tr[d][k] + (tr[d][k + 1] - tr[d][k]) * u), Rr = [0, 1, 2].map(d => rot[d][k] + (rot[d][k + 1] - rot[d][k]) * u);
      return { R: MEG.rotXYZ(Rr[0], Rr[1], Rr[2]), c: v3.add(c0, T), trans: T, rot: Rr };
    }
    return { fs: fsP, K, tr, rot, c0, at, ref: { R: MEG.IDENTITY3, c: c0.slice(), trans: [0, 0, 0], rot: [0, 0, 0] } };
  }
  MEG.makePose = makePose;

  /* ---------- simulate ---------- */
  MEG.simulate = function (cfg) {
    const R = cfg.recording, fs = R.fs, seed = R.seed;
    const tl = compileTimeline(cfg, MEG.stream(seed, 'timeline'));
    const n = Math.round(tl.dur * fs);
    tl.events.forEach(ev => { ev.sample = Math.round(ev.t * fs); ev.ci = tl.conditions.indexOf(ev.cond); });
    const ds = {
      cfg, fs, n, dur: n / fs, blocks: tl.blocks, events: tl.events, conditions: tl.conditions,
      gens: [], groups: [], pose: makePose(cfg, n / fs, seed), noiseCache: {}, topoCache: {}
    };
    const openR = stateRanges(tl.blocks, 'open');
    const eyesClosed = new Uint8Array(n);
    tl.blocks.forEach(b => { if (b.state === 'closed') eyesClosed.fill(1, Math.round(b.t0 * fs), Math.min(n, Math.round(b.t1 * fs))); });
    ds.eyesClosed = eyesClosed;
    const magArr = MEG.getArray('mag');
    // the largest reading on the centred magnetometer array, for scaling things given in fT
    const peakMag = (model, pos, dir, frame) => {
      const chans = magArr.channels;
      const v = model === 'current' ? MEG.forwardMEG(chans, pos, dir) : MEG.forwardMag(chans, pos, dir);
      let m = 0; v.forEach(x => { m = Math.max(m, Math.abs(x)); });
      return m || 1;
    };

    /* --- brain sources --- */
    cfg.sources.forEach((s, si) => {
      const st = MEG.stream(seed, 'src:' + s.name);
      const add = (label, g, tc, extra) => ds.gens.push(Object.assign({
        group: s.name, kind: 'source', label, frame: 'head', model: 'current', pos: g.pos, ori: g.ori, tc, slot: si, geom: g
      }, extra || {}));
      const evoked = (peaks, amp, jitter, gainOf) => {
        const tc = new Float32Array(n), jit = [], av = [];
        tl.events.forEach(ev => {
          const j = jitter ? MEG.clamp(st.gauss() * jitter, -3 * jitter, 3 * jitter) : 0;
          const a = Math.max(0.2, 1 + 0.15 * st.gauss());
          jit.push(j); av.push(a);
          const g = gainOf(ev.cond);
          if (!g) return;
          peaks.forEach(p => addBump(tc, fs, ev.t + p.latency + j, p.width / 2.3548, amp * g * p.gain * a));
        });
        return { tc, jit, av };
      };
      const gainOf = c => s.conditions && s.conditions.length ? ((s.conditions.find(x => x.name === c) || { gain: 0 }).gain) : 1;
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
        const oa = s.lag >= 0 ? lagS : 0, ob = s.lag >= 0 ? 0 : lagS;
        for (let i = 0; i < n; i++) { ta[i] = A * (kc * common[i + oa] + ki * ia[i]); tb[i] = A * (kc * common[i + ob] + ki * ib[i]); }
        add(s.label + ' ' + s.dipoles[0].name, s.dipoles[0], ta, { part: 0 });
        add(s.label + ' ' + s.dipoles[1].name, s.dipoles[1], tb, { part: 1 });
      } else if (s.type === 'auditory') {
        // Both hemispheres share the waveform trial by trial: highly correlated sources.
        const e = evoked(s.peaks, s.amp, s.jitter, gainOf);
        s.dipoles.forEach((d, k) => {
          const tc = Float32Array.from(e.tc);
          if (s.dipoles.length > 1) { const own = 1 + 0.05 * (k ? 1 : -1); for (let i = 0; i < n; i++) tc[i] *= own; }
          add(`${s.label} ${d.name}`, d, tc, { part: k, jitter: e.jit, evoked: true });
        });
      } else if (s.type === 'somatosensory') {
        const e = evoked(s.peaks, s.amp, s.jitter, gainOf);
        add(`${s.label} ${s.dipoles[0].name}`, s.dipoles[0], e.tc, { part: 0, jitter: e.jit, evoked: true });
        if (s.beta && s.dipoles[1]) {
          const env = new Float32Array(n).fill(1);
          tl.events.forEach(ev => {
            if (!gainOf(ev.cond)) return;
            const i0 = Math.max(0, Math.round((ev.t - 0.1) * fs)), i1 = Math.min(n, Math.round((ev.t + 1.6) * fs));
            for (let i = i0; i < i1; i++) {
              const t = i / fs - ev.t;
              const dip = s.beta.erd * Math.exp(-0.5 * Math.pow((t - 0.3) / 0.16, 2));
              const reb = s.beta.rebound * Math.exp(-0.5 * Math.pow((t - 0.85) / 0.2, 2));
              env[i] = Math.max(0.05, env[i] * (1 - dip) + reb);
            }
          });
          const nb = narrowband(n, fs, s.beta.freq, 3, st), tc = new Float32Array(n);
          for (let i = 0; i < n; i++) tc[i] = s.beta.amp / Math.SQRT2 * env[i] * nb[i];
          add(`${s.label} ${s.dipoles[1].name}`, s.dipoles[1], tc, { part: 1, rhythm: true });
          ds.betaEnvelope = env;
        }
      } else if (s.type === 'alpha') {
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
          add(`${s.label} ${d.name}`, d, tc, { part: k });
        });
        ds.alphaEnvelope = env;
      } else if (s.type === 'spike') {
        const tc = new Float32Array(n);
        const times = poisson(st, s.rate, 0.8, tl.dur - 1, 0.4);
        const w = s.width;
        times.forEach(t0 => {
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

    /* --- background: random cortical dipoles with 1/f time courses, scaled
       so the magnetometers see the requested RMS --- */
    if (R.background > 0) {
      const st = MEG.stream(seed, 'background');
      const K = 16, list = [];
      for (let k = 0; k < K; k++) {
        let u; do { u = v3.unit([st.gauss(), st.gauss(), st.gauss()]); } while (u[2] < -0.3);
        const pos = v3.scale(u, st.uniform(6.2, 7.6));
        const ori = v3.unit([st.gauss(), st.gauss(), st.gauss()]);
        list.push({ pos, ori, tc: pink(n, fs, st, 25) });
      }
      let ss = 0;
      list.forEach(b => { const v = MEG.forwardMEG(magArr.channels, b.pos, b.ori); v.forEach(x => { ss += x * x; }); });
      const k = R.background / Math.sqrt(ss / magArr.nch);
      list.forEach((b, i) => { for (let j = 0; j < n; j++) b.tc[j] *= k; ds.gens.push({ group: 'background', kind: 'background', label: 'Background ' + (i + 1), frame: 'head', model: 'current', pos: b.pos, ori: b.ori, tc: b.tc }); });
      ds.groups.push({ id: 'background', label: 'Background brain activity', kind: 'background', on: true });
    }

    /* --- the environment: magnetic dipoles metres away --- */
    const A = cfg.artifacts;
    {
      const st = MEG.stream(seed, 'environment');
      const srcs = [];
      // an elevator 16 m away: trips of 8-20 s, with the car's steel and motor currents moving
      {
        const pos = [1400, -800, 0], tz = new Float32Array(n), tx = new Float32Array(n);
        let level = st.uniform(-1, 1);
        poisson(st, 1 / 45, 1, tl.dur, 10).forEach(t0 => {
          const nl = st.uniform(-1, 1), dur = st.uniform(8, 20);
          addRamp(tz, fs, t0, dur, nl - level); addRamp(tx, fs, t0, dur, 0.3 * (nl - level) * st.uniform(-1, 1));
          level = nl;
        });
        srcs.push({ label: 'Elevator', pos, comps: [[[0, 0, 1], tz], [[1, 0, 0], tx]], w: 1 });
      }
      // traffic 40 m away: each passing vehicle a smooth bump of a few seconds
      {
        const pos = [-3000, 2600, -500], tx = new Float32Array(n), ty = new Float32Array(n);
        poisson(st, 1 / 12, 0, tl.dur + 5, 1).forEach(t0 => {
          const a = st.uniform(0, 2 * Math.PI), s = st.uniform(2, 6), m = st.uniform(0.2, 1) * (st.next() < 0.5 ? -1 : 1);
          addBump(tx, fs, t0, s, m * Math.cos(a)); addBump(ty, fs, t0, s, m * Math.sin(a));
        });
        srcs.push({ label: 'Traffic', pos, comps: [[[1, 0, 0], tx], [[0, 1, 0], ty]], w: 0.6 });
      }
      // the city and the geomagnetic field: slow wandering in all three directions
      {
        const pos = [8000, 6000, 3000];
        const comps = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(d => [d, pink(n, fs, st, 0.5)]);
        srcs.push({ label: 'Urban drift', pos, comps, w: 0.25 });
      }
      // scale: the largest field at the centre of the helmet, without the room, is A.environment.amp
      const centre = [0, 0, MEG.ARRAY.squidR];
      const Bc = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
      srcs.forEach(s => {
        const rel = v3.norm(s.pos);
        s.comps.forEach(([d, tc]) => {
          const m = MEG.mean(tc); for (let i = 0; i < n; i++) tc[i] -= m;
          const b = MEG.magDipole(centre, s.pos, d);
          const scale = s.w * Math.pow(rel / 1000, 3) / (MEG.rms(tc) || 1);   // compensate distance so each source counts as weighted
          for (let i = 0; i < n; i++) tc[i] *= scale;
          for (let i = 0; i < n; i++) { Bc[0][i] += b[0] * tc[i]; Bc[1][i] += b[1] * tc[i]; Bc[2][i] += b[2] * tc[i]; }
        });
      });
      let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.hypot(Bc[0][i], Bc[1][i], Bc[2][i]));
      const k = A.environment.amp / (mx || 1);
      const shield = f => 1 / MEG.shieldingFactor(f);
      srcs.forEach(s => s.comps.forEach(([d, tc], ci) => {
        for (let i = 0; i < n; i++) tc[i] *= k;
        ds.gens.push({ group: 'environment', kind: 'artifact', label: `${s.label}${s.comps.length > 1 ? ' ' + 'xyz'[d.indexOf(1)] : ''}`, frame: 'device', model: 'magnetic',
          pos: s.pos, ori: d, tcOpen: tc, tcRoom: dsp.fftGain(tc, fs, shield), part: ci, source: s.label });
      }));
    }
    /* --- line noise: the building's wiring 5 m away, with harmonics --- */
    {
      const st = MEG.stream(seed, 'line');
      const pos = [-250, 350, -150], harm = [[1, 1], [2, 0.05], [3, 0.3], [5, 0.12]];
      const centre = [0, 0, MEG.ARRAY.squidR];
      [[1, 0, 0], [0, 1, 0]].forEach((d, k) => {
        const open = new Float32Array(n), room = new Float32Array(n);
        harm.forEach(([h, a]) => {
          const f = R.mains * h; if (f >= fs / 2) return;
          const ph = st.uniform(0, 2 * Math.PI) + (k ? Math.PI / 2 : 0), sf = MEG.shieldingFactor(f);
          for (let i = 0; i < n; i++) { const v = a * Math.sin(2 * Math.PI * f * i / fs + ph); open[i] += v; room[i] += v / sf; }
        });
        const b = v3.norm(MEG.magDipole(centre, pos, d)), s = A.line.amp / (b * 1.3);
        for (let i = 0; i < n; i++) { open[i] *= s; room[i] *= s; }
        ds.gens.push({ group: 'line', kind: 'artifact', label: 'Mains ' + 'xy'[k], frame: 'device', model: 'magnetic', pos, ori: d, tcOpen: open, tcRoom: room, part: k });
      });
    }
    /* --- the heart: a magnetic dipole in the chest --- */
    {
      const st = MEG.stream(seed, 'cardiac');
      const pos = [-3, 4, -34], ori = v3.unit([0.35, 0.55, -0.75]);
      const tc = new Float32Array(n), beats = [];
      const waves = [[0.12, -0.18, 0.025], [-0.12, -0.035, 0.009], [1, 0, 0.011], [-0.3, 0.035, 0.011], [0.28, 0.25, 0.05]];
      let t = 0.3 + st.uniform(0, 0.5);
      while (t < tl.dur - 0.4) {
        beats.push(t);
        waves.forEach(([a, c, s]) => addBump(tc, fs, t + c, s, a));
        t += (1 / A.cardiac.rate) * (1 + 0.04 * Math.sin(2 * Math.PI * 0.25 * t) + 0.02 * st.gauss());
      }
      const k = A.cardiac.amp / peakMag('magnetic', pos, ori);
      for (let i = 0; i < n; i++) tc[i] *= k;
      ds.gens.push({ group: 'cardiac', kind: 'artifact', label: 'Cardiac', frame: 'device', model: 'magnetic', pos, ori, tc, events: beats });
    }
    /* --- the eyes: current dipoles in the orbits --- */
    const eyeL = [-3.2, 7.0, -2.6], eyeR = [3.2, 7.0, -2.6];
    ds.eyes = [eyeL, eyeR];
    const eyesPeak = ori => {
      const a = MEG.forwardMEG(magArr.channels, eyeL, ori), b = MEG.forwardMEG(magArr.channels, eyeR, ori);
      let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] + b[i]));
      return m || 1;
    };
    {
      const st = MEG.stream(seed, 'blinks');
      const ori = v3.unit([0, 0.45, 1]);
      const tc = new Float32Array(n), times = eventsInRanges(st, A.blinks.rate, openR, 0.3);
      times.forEach(t0 => {
        const amp = st.uniform(0.7, 1.3), i0 = Math.round(t0 * fs), len = Math.round(0.7 * fs);
        for (let i = 0; i < len && i0 + i < n; i++) { const t = i / fs; tc[i0 + i] += amp * Math.pow(t / 0.11, 2) * Math.exp(2 * (1 - t / 0.11)); }
      });
      const k = A.blinks.amp / eyesPeak(ori);
      for (let i = 0; i < n; i++) tc[i] *= k;
      [eyeL, eyeR].forEach((p, j) => ds.gens.push({ group: 'blinks', kind: 'artifact', label: 'Blinks ' + (j ? 'right eye' : 'left eye'), frame: 'head', model: 'current', pos: p, ori, tc, events: times }));
    }
    {
      const st = MEG.stream(seed, 'saccades');
      const ori = [1, 0, 0];
      const tc = new Float32Array(n), times = eventsInRanges(st, A.saccades.rate, openR, 0.5);
      const target = new Float32Array(n), ramp = Math.round(0.04 * fs);
      times.forEach(t0 => {
        const away = st.pick([-1, -0.6, 0.6, 1]), hold = st.uniform(0.4, 1.6);
        const a = Math.round(t0 * fs), b = Math.min(n, Math.round((t0 + hold) * fs));
        for (let k = a; k < b; k++) target[k] = away;
      });
      let gaze = 0;
      for (let i = 0; i < n; i++) { gaze += MEG.clamp(target[i] - gaze, -1 / ramp, 1 / ramp); tc[i] = gaze; }
      const k = A.saccades.amp / eyesPeak(ori);
      for (let i = 0; i < n; i++) tc[i] *= k;
      [eyeL, eyeR].forEach((p, j) => ds.gens.push({ group: 'saccades', kind: 'artifact', label: 'Eye movements ' + (j ? 'right eye' : 'left eye'), frame: 'head', model: 'current', pos: p, ori, tc, events: times }));
    }
    /* --- muscles: four generators just under the scalp --- */
    {
      const st = MEG.stream(seed, 'muscle');
      const sites = [
        { label: 'Left temporalis', u: MEG.sph(100, -78) }, { label: 'Right temporalis', u: MEG.sph(100, 78) },
        { label: 'Frontalis', u: MEG.sph(78, 0) }, { label: 'Neck', u: MEG.sph(118, 180) }
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
        const pos = v3.scale(s.u, 0.95 * MEG.HEAD.R), ori = MEG.orientation(pos, 90, 0, 'Cz');
        const car = new Float32Array(n); for (let i = 0; i < n; i++) car[i] = st.gauss();
        dsp.sosfilt(hp, car); if (lp) dsp.sosfilt(lp, car); normalize(car);
        const scale = A.muscle.amp / 3 / peakMag('current', pos, ori);
        const tc = new Float32Array(n); for (let i = 0; i < n; i++) tc[i] = scale * envs[k][i] * car[i];
        ds.gens.push({ group: 'muscle', kind: 'artifact', label: s.label, frame: 'head', model: 'current', pos, ori, tc, site: s.u });
      });
    }
    /* --- dental work: a permanent magnet in the mouth that the jaw moves --- */
    {
      const st = MEG.stream(seed, 'dental');
      const fsJ = 25, KJ = Math.ceil(tl.dur * fsJ) + 2, jaw = new Float32Array(KJ);
      poisson(st, 1 / 25, 1, tl.dur - 1, 4).forEach(t0 => {
        const dur = st.uniform(2, 6), f = st.uniform(1.2, 2.2), a = st.uniform(0.3, 1);
        for (let k = Math.floor(t0 * fsJ); k < Math.min(KJ, Math.ceil((t0 + dur) * fsJ)); k++) {
          const t = k / fsJ - t0, w = Math.sin(Math.PI * t / dur);
          jaw[k] = Math.max(jaw[k], a * w * (0.5 - 0.5 * Math.cos(2 * Math.PI * f * t)));
        }
      });
      // slow swallowing and posture changes
      let y = 0; for (let k = 0; k < KJ; k++) { y = 0.995 * y + 0.01 * st.gauss(); jaw[k] += 0.15 * y; }
      ds.dental = { pos: [1.6, 6.2, -6.0], m: v3.scale(v3.unit([0.2, 0.5, 0.8]), 1), jaw, fs: fsJ, K: KJ, scale: 1 };
      // scale the magnet so the largest jaw-driven change on the centred magnetometers is A.dental.amp
      const f = dentalFields(ds, magArr.channels.map(c => c.pts), 'head', null);
      let m = 0; f.forEach(row => row.forEach(x => { m = Math.max(m, Math.abs(x)); }));
      ds.dental.scale = A.dental.amp / (m || 1);
    }
    /* --- SQUID flux jumps --- */
    {
      const st = MEG.stream(seed, 'jumps');
      // Without the room the field changes faster than the feedback loops can follow, so they jump ten times as often.
      const mk = (r, unshielded) => poisson(st, r, 1, tl.dur - 1, 0.5).map(t => ({ t, unshielded, site: st.int(MEG.SITES.length), sub: st.int(2), amp: A.jumps.amp * st.uniform(0.3, 1.5) * (st.next() < 0.5 ? -1 : 1) }));
      ds.jumps = mk(A.jumps.rate, false).concat(mk(A.jumps.rate * 9, true));
      ds.jumps.forEach(j => { j.sub = st.int(3); });
      const badSite = MEG.SITES.findIndex(s => s.name === A.bad.label);
      ds.badSite = badSite;
      ds.badJumps = poisson(MEG.stream(seed, 'badjumps'), 0.25, 1, tl.dur - 1, 0.5).map(t => ({ t, amp: A.jumps.amp * 2 * st.uniform(0.5, 1.5) * (st.next() < 0.5 ? -1 : 1) }));
    }
    /* --- head position indicator coils --- */
    if (R.hpi) {
      const coils = [[MEG.sph(62, -42), 'left forehead'], [MEG.sph(62, 42), 'right forehead'], [MEG.sph(104, -112), 'behind the left ear'], [MEG.sph(104, 112), 'behind the right ear']];
      const freqs = [0, 1, 2, 3].map(k => Math.round(fs * (0.16 + 0.043 * k)) + 3);
      ds.hpiFreqs = freqs;
      coils.forEach(([u, label], k) => {
        const pos = v3.scale(u, MEG.HEAD.R + 0.2), ori = u, f = freqs[k];
        const tc = new Float32Array(n); for (let i = 0; i < n; i++) tc[i] = Math.sin(2 * Math.PI * f * i / fs);
        const sc = 5000 / peakMag('magnetic', pos, ori);
        for (let i = 0; i < n; i++) tc[i] *= sc;
        ds.gens.push({ group: 'hpi', kind: 'artifact', label: `HPI coil, ${label} (${f} Hz)`, frame: 'head', model: 'magnetic', pos, ori, tc, freq: f });
      });
      ds.hpiCoils = coils.map(([u]) => v3.scale(u, MEG.HEAD.R + 0.2));
    }

    // Toggle list, in a fixed order
    ['environment', 'line', 'cardiac', 'blinks', 'saccades', 'muscle', 'dental', 'jumps', 'bad', 'movement'].forEach(k => ds.groups.push({ id: k, label: MEG.ARTIFACT_INFO[k].label, kind: 'artifact', on: !!A[k].on }));
    if (R.hpi) ds.groups.push({ id: 'hpi', label: MEG.ARTIFACT_INFO.hpi.label, kind: 'artifact', on: true });
    ds.groups.push({ id: 'sensor', label: 'Sensor noise', kind: 'sensor', on: true });
    MEG.setArray(ds, R.sensors);
    return ds;
  };

  /* The dental magnet's field at a set of channels over time (at its own
     25 Hz), relative to its mean.  Jaw opening drops the teeth by up to
     8 mm and tilts the magnet; head movement carries everything along. */
  function dentalFields(ds, chanPts, chanFrame, pose) {
    const D = ds.dental, out = chanPts.map(() => new Float32Array(D.K));
    const b = [0, 0, 0];
    for (let k = 0; k < D.K; k++) {
      const j = D.jaw[k];
      const p = v3.add(D.pos, v3.scale([0, -0.25, -1], 0.8 * j));
      const Rj = MEG.rotXYZ(-15 * j, 0, 0), m = MEG.matVec(Rj, D.m);
      let pp = p, mm = m;
      if (pose && chanFrame === 'device') { const P = pose.at(k / D.fs); pp = v3.add(MEG.matVec(P.R, p), P.c); mm = MEG.matVec(P.R, m); }
      chanPts.forEach((pts, c) => {
        let s = 0;
        for (let q = 0; q < pts.length; q++) { const pt = pts[q]; MEG.magDipole(pt.r, pp, mm, b); s += pt.w * (pt.n[0] * b[0] + pt.n[1] * b[1] + pt.n[2] * b[2]); }
        out[c][k] = s;
      });
    }
    out.forEach(row => { const m = MEG.mean(row); for (let k = 0; k < row.length; k++) row[k] -= m; });
    return out;
  }

  /* ---------- patterns for one sensor array ----------
     For each generator, its reading per unit time course on every channel
     and reference channel.  If the generator and the sensors live in
     different frames (brain and SQUIDs, room and OPMs), the pattern
     changes as the head moves: it is computed at the starting pose and,
     every 0.25 s, along the trajectory, and interpolated in between. */
  const TOPO_DT = 0.25;
  function genTopo(g, chans) {
    if (g.model === 'current') return MEG.forwardMEG(chans, g.pos, g.ori);
    return MEG.forwardMag(chans, g.pos, g.ori);
  }
  function transformed(chans, toFrame, pose) {
    return chans.map(ch => ({ pts: ch.frame === toFrame ? ch.pts : MEG.pointsIn(ch, ch.frame, toFrame, pose) }));
  }
  MEG.setArray = function (ds, type) {
    const arr = MEG.getArray(type);
    ds.array = arr;
    if (ds.topoCache[type]) { ds.topo = ds.topoCache[type]; return; }
    const chans = arr.channels.map(c => Object.assign({ frame: arr.frame }, c)).concat(arr.refs.map(c => Object.assign({ frame: 'device' }, c)));
    const P0 = ds.pose.ref, K = Math.max(2, Math.ceil(ds.dur / TOPO_DT) + 1);
    const static0 = { head: transformed(chans, 'head', P0), device: transformed(chans, 'device', P0) };
    const T = { static: [], moving: null, K, dt: TOPO_DT, nch: arr.nch, nref: arr.refs.length, chans, arr };
    ds.gens.forEach((g, gi) => { T.static[gi] = genTopo(g, static0[g.frame]); });
    // dental work (head frame), sampled at 25 Hz, with the head still
    const still = dentalFields(ds, static0.head.map(c => c.pts), 'head', null);
    T.dental = { still: still.map(r => { for (let k = 0; k < r.length; k++) r[k] *= ds.dental.scale; return r; }), moving: null };
    ds.topoCache[type] = T;
    ds.topo = T;
  };

  /* The patterns along the head's trajectory, computed the first time
     movement is switched on for this array. */
  function ensureMoving(ds) {
    const T = ds.topo;
    if (T.moving) return;
    const chans = T.chans, arr = T.arr, K = T.K;
    const poseCh = {};
    const lazyPose = f => {
      if (!poseCh[f]) { poseCh[f] = []; for (let k = 0; k < K; k++) poseCh[f].push(transformed(chans, f, ds.pose.at(k * TOPO_DT))); }
      return poseCh[f];
    };
    T.moving = ds.gens.map(g => {
      if (!chans.some(c => c.frame !== g.frame)) return null;
      const pc = lazyPose(g.frame), M = new Float32Array(K * chans.length);
      for (let k = 0; k < K; k++) M.set(genTopo(g, pc[k]), k * chans.length);
      return M;
    });
    if (arr.frame === 'device') {
      const dev = dentalFields(ds, chans.map(c => c.pts), 'device', ds.pose);
      T.dental.moving = dev.map(r => { for (let k = 0; k < r.length; k++) r[k] *= ds.dental.scale; return r; });
    } else T.dental.moving = T.dental.still;   // OPMs move with the head and the teeth
    // OPMs moving through the residual field of the room
    if (arr.frame === 'head') {
      const RES = MEG.RESIDUAL, nch = arr.nch, KP = ds.pose.K, field = new Float32Array(nch * KP);
      const B = r => v3.add(RES.uniform, MEG.matVec(RES.gradient, r));
      const at = (c, P) => MEG.pointsIn(Object.assign({ frame: 'head' }, arr.channels[c]), 'head', 'device', P)[0];
      const ref = arr.channels.map((_, c) => at(c, ds.pose.ref));
      for (let k = 0; k < KP; k++) {
        const P = ds.pose.at(k / ds.pose.fs);
        for (let c = 0; c < nch; c++) { const p = at(c, P); field[k * nch + c] = v3.dot(B(p.r), p.n) - v3.dot(B(ref[c].r), ref[c].n); }
      }
      T.residual = field;
    }
  }
  MEG.ensureMoving = ensureMoving;

  /* ---------- assemble a recording ----------
     In two steps.  sumGroups adds up what the generators of some groups
     put on every channel (and reference channel); it is linear, so the
     page keeps a running sum and adds or subtracts one group when it is
     switched.  finish then adds what the hardware adds: flux jumps, a bad
     channel, sensor noise, the online filters and, for OPMs outside the
     room, saturation.

     opt.room and opt.nulling switch the shielded room and the OPM nulling
     coils; opt.moving the head's movement; opt.range = [i0, i1) does only
     that window (and no filters); opt.genFilter(g) can leave out some of a
     group's generators (the true evoked field keeps only the evoked ones). */
  MEG.sumGroups = function (ds, groups, opt) {
    opt = opt || {};
    const arr = ds.array, T = ds.topo, nch = arr.nch, nref = arr.refs.length, ntot = nch + nref;
    const fs = ds.fs;
    const i0 = opt.range ? opt.range[0] : 0, n = opt.range ? opt.range[1] - opt.range[0] : ds.n;
    const room = opt.room !== undefined ? opt.room : ds.cfg.shielding.room;
    const nulling = opt.nulling !== undefined ? opt.nulling : ds.cfg.shielding.nulling;
    const moving = !!opt.moving;
    const rows = opt.into || []; if (!opt.into) for (let c = 0; c < ntot; c++) rows.push(new Float32Array(n));
    const sign = opt.subtract ? -1 : 1;
    if (moving) ensureMoving(ds);
    const K = T.K, dtS = T.dt * fs;
    // Static patterns are mixed four generators at a time: the loop is
    // limited by memory traffic on the output rows, not by arithmetic.
    const still = [];
    ds.gens.forEach((g, gi) => {
      if (!groups.has(g.group) || (opt.genFilter && !opt.genFilter(g))) return;
      const tc = g.tcRoom ? (room ? g.tcRoom : g.tcOpen) : g.tc;
      const M = moving ? T.moving[gi] : null;
      if (!M) { still.push({ tc, topo: T.static[gi] }); return; }
      // the pattern changes linearly between pose samples
      for (let c = 0; c < ntot; c++) {
        const o = rows[c];
        for (let k = 0; k < K - 1; k++) {
          const a = Math.max(Math.ceil(k * dtS), i0), b = Math.min(k === K - 2 ? i0 + n : Math.ceil((k + 1) * dtS), i0 + n);
          if (b <= a) continue;
          const wA = sign * M[k * ntot + c], slope = (sign * M[(k + 1) * ntot + c] - wA) / dtS, base = k * dtS;
          for (let s = a; s < b; s++) o[s - i0] += (wA + slope * (s - base)) * tc[s];
        }
      }
    });
    const Z = new Float32Array(1);
    for (let c = 0; c < ntot; c++) {
      const o = rows[c];
      for (let g = 0; g < still.length; g += 4) {
        const q = still.slice(g, g + 4);
        const w = q.map(x => sign * x.topo[c]);
        while (q.length < 4) { q.push({ tc: Z }); w.push(0); }
        const t0 = q[0].tc, t1 = q[1].tc, t2 = q[2].tc, t3 = q[3].tc, w0 = w[0], w1 = w[1], w2 = w[2], w3 = w[3];
        if (w1 === 0 && w2 === 0 && w3 === 0) { for (let i = 0; i < n; i++) o[i] += w0 * t0[i0 + i]; }
        else if (w2 === 0 && w3 === 0) { for (let i = 0; i < n; i++) o[i] += w0 * t0[i0 + i] + w1 * t1[i0 + i]; }
        else if (w3 === 0) { for (let i = 0; i < n; i++) o[i] += w0 * t0[i0 + i] + w1 * t1[i0 + i] + w2 * t2[i0 + i]; }
        else { for (let i = 0; i < n; i++) o[i] += w0 * t0[i0 + i] + w1 * t1[i0 + i] + w2 * t2[i0 + i] + w3 * t3[i0 + i]; }
      }
    }
    // dental work: its own 25 Hz samples, interpolated
    if (groups.has('dental')) {
      const D = moving ? T.dental.moving : T.dental.still, fsJ = ds.dental.fs, KJ = ds.dental.K;
      for (let c = 0; c < ntot; c++) {
        const src = D[c], o = rows[c];
        for (let i = 0; i < n; i++) { const f = Math.min(KJ - 1.0001, (i0 + i) / fs * fsJ), k = Math.floor(f), u = f - k; o[i] += sign * (src[k] + (src[k + 1] - src[k]) * u); }
      }
    }
    // OPMs moving through the room's residual field
    if (groups.has('movement') && moving && T.residual) {
      const KP = ds.pose.K, fsP = ds.pose.fs, sc = sign * (nulling ? MEG.RESIDUAL.nulling : 1);
      for (let c = 0; c < nch; c++) {
        const o = rows[c];
        for (let i = 0; i < n; i++) { const f = Math.min(KP - 1.0001, (i0 + i) / fs * fsP), k = Math.floor(f), u = f - k; const a = T.residual[k * nch + c], b = T.residual[(k + 1) * nch + c]; o[i] += sc * (a + (b - a) * u); }
      }
    }
    return rows;
  };

  /* Gaussian deviates for sensor noise come from a table of 65536 exact
     normal quantiles indexed at random: five times faster than computing
     each one, and indistinguishable from it in a spectrum or to ICA. */
  const GTAB = (function () {
    const N = 65536, t = new Float32Array(N);
    // inverse normal CDF by Acklam's rational approximation
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239],
      b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1],
      cc = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
      d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    for (let i = 0; i < N; i++) {
      const p = (i + 0.5) / N;
      let x;
      if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
      else if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((cc[0] * q + cc[1]) * q + cc[2]) * q + cc[3]) * q + cc[4]) * q + cc[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
      else { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
      t[i] = x;
    }
    return t;
  })();
  MEG.GTAB = GTAB;

  // Sensor noise for one channel: white plus 1/f below a corner, cached.
  MEG.sensorNoise = function (ds, c) {
    const arr = ds.array, R = ds.cfg.recording, fs = ds.fs;
    const name = c < arr.nch ? arr.channels[c].name : arr.refs[c - arr.nch].name;
    const key = arr.type + ':' + name;
    let u = ds.noiseCache[key];
    if (!u) {
      const ch = c < arr.nch ? arr.channels[c] : { kind: 'mag' };
      const dens = c < arr.nch ? MEG.chanNoise(arr, ch, R.noise) : MEG.ARRAY.noise.ref, corner = arr.type === 'opm' ? 3 : 1;
      const white = dens * Math.sqrt(fs / 2), slow = dens * Math.sqrt(corner * Math.PI / 2);
      const N = ds.n;
      // the 1/f part: white noise through a one-pole low-pass at a quarter of
      // the corner, which rises at low frequencies like real sensors' excess noise
      const a = Math.exp(-2 * Math.PI * corner / 4 / fs), b = Math.sqrt(1 - a * a) * slow * 2;
      u = ds.noiseCache[key] = new Float32Array(N);
      // mulberry32 inline: two table lookups per sample
      let s = MEG.hashSeed(R.seed, 'noise:' + key) || 1, y = 0;
      for (let i = 0; i < N; i++) {
        s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), s | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); t ^= t >>> 14;
        y = a * y + b * GTAB[t & 65535];
        u[i] = white * GTAB[(t >>> 16) & 65535] + y;
      }
    }
    return u;
  };

  MEG.finish = function (ds, sum, opt) {
    opt = opt || {};
    const on = g => opt.enabled.has(g);
    const arr = ds.array, nch = arr.nch, nref = arr.refs.length, ntot = nch + nref;
    const fs = ds.fs, R = ds.cfg.recording;
    const i0 = opt.range ? opt.range[0] : 0, n = opt.range ? opt.range[1] - opt.range[0] : ds.n;
    const room = opt.room !== undefined ? opt.room : ds.cfg.shielding.room;
    const rows = sum.map(r => Float32Array.from(r));
    const squid = arr.type !== 'opm';
    const chanOfSite = (site, sub) => { const list = arr.siteChannels[site]; return list[sub % list.length]; };
    if (squid && on('jumps')) ds.jumps.forEach(j => {
      if (j.unshielded && room) return;
      const c = chanOfSite(j.site, j.sub), a = Math.max(0, Math.round(j.t * fs) - i0);
      if (a >= n) return;
      const o = rows[c]; for (let i = a; i < n; i++) o[i] += j.amp;
    });
    const badOn = on('bad') && ds.badSite >= 0;
    const badChans = badOn ? arr.siteChannels[ds.badSite] : [];
    const mode = ds.cfg.artifacts.bad.mode;
    if (opt.noise !== false && on('sensor')) {
      for (let c = 0; c < ntot; c++) {
        const u = MEG.sensorNoise(ds, c), g = badChans.includes(c) && mode === 'noisy' ? 15 : 1, o = rows[c];
        for (let i = 0; i < n; i++) o[i] += g * u[i0 + i];
      }
    }
    if (badOn && mode === 'jumpy' && squid) ds.badJumps.forEach(j => {
      const c = badChans[0], a = Math.max(0, Math.round(j.t * fs) - i0); if (a >= n) return;
      const o = rows[c]; for (let i = a; i < n; i++) o[i] += j.amp;
    });
    if (opt.filters !== false && !opt.range) {
      const sos = [];
      if (R.hp) sos.push(...dsp.butter('high', 1, R.hp, fs));
      if (R.lp && R.lp < fs / 2) sos.push(...dsp.butter('low', 4, R.lp, fs));
      if (sos.length) rows.forEach(o => dsp.sosfilt(sos, o));
    }
    if (badOn && mode === 'flat') badChans.forEach(c => rows[c].fill(0));
    let saturated = false;
    if (arr.type === 'opm' && !room) {
      saturated = true;
      const st = MEG.stream(R.seed, 'rail');
      for (let c = 0; c < nch; c++) rows[c].fill((st.next() < 0.5 ? -1 : 1) * 4.5e6);
    }
    return {
      labels: arr.names.slice(), rows: rows.slice(0, nch), refs: rows.slice(nch), refLabels: arr.refs.map(r => r.name),
      fs, n, unit: arr.unit, type: arr.type, saturated
    };
  };

  // The whole thing in one call: for the truth signals and short windows.
  MEG.assemble = function (ds, opt) {
    opt = Object.assign({}, opt);
    if (opt.moving === undefined) opt.moving = opt.enabled.has('movement');
    const sum = MEG.sumGroups(ds, opt.enabled, opt);
    return MEG.finish(ds, sum, opt);
  };

  /* After a generator has moved (the Sources tab moves them), recompute
     its patterns for every array already prepared; the patterns along the
     head's trajectory are recomputed the next time movement is used. */
  MEG.refreshGen = function (ds, gi) {
    const g = ds.gens[gi];
    Object.values(ds.topoCache).forEach(T => {
      T.static[gi] = genTopo(g, transformed(T.chans, g.frame, ds.pose.ref));
      T.moving = null;
    });
  };

  /* The pattern a generator leaves on the channels at the starting pose. */
  MEG.genPattern = function (ds, g) {
    const gi = ds.gens.indexOf(g);
    return ds.topo.static[gi].subarray(0, ds.array.nch);
  };
})(typeof window !== 'undefined' ? window : globalThis);
