/* fNIRS simulator: recording a session.

   simulate(cfg) does the expensive, random part once:
     - expands the timeline into blocks and trials;
     - solves the light transport for every wavelength and finds, for every
       channel, its baseline intensity, its mean partial pathlength in each
       tissue layer and in each cortical region;
     - runs the balloon model for every region and generates every systemic
       signal and every artifact.
   Each contribution is stored separately, as "minus the change in log
   intensity" a channel would see from it alone, so assemble() can switch
   any of them on or off without changing the rest by a single sample.

   assemble(ds, opts) then builds the raw intensities a CW instrument
   reports: baseline times exp(-sum of the enabled contributions), times the
   motion-induced coupling changes, plus ambient light, the detector's
   noise and its saturation. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;
  const LN10 = Math.LN10;

  /* Detectors: noise floor (nW rms per sample), shot-like noise (nW per
     sqrt nW), source and electronics instability (fraction), saturation (nW). */
  NIRS.DETECTORS = {
    photodiode: { label: 'Silicon photodiode', floor: 0.02, shot: 3e-6, drift: 2e-4, sat: 1e5, desc: 'cheap, linear, wide dynamic range, but a high noise floor' },
    apd: { label: 'Avalanche photodiode', floor: 0.002, shot: 3e-6, drift: 2e-4, sat: 5e4, desc: 'internal gain lowers the noise floor ten times' },
    sipm: { label: 'Silicon photomultiplier', floor: 0.0004, shot: 2.5e-6, drift: 2e-4, sat: 2e3, desc: 'single-photon sensitivity, but it saturates early' }
  };
  NIRS.DETECTOR_AREA = 0.07;   // cm^2, a 3 mm fibre bundle or detector window
  NIRS.LED_FWHM = 35;          // nm
  NIRS.LASER_FWHM = 2;

  /* ---------- the timeline ---------- */
  NIRS.expandTimeline = function (cfg) {
    const r = NIRS.stream(cfg.recording.seed, 'timeline');
    const conds = [], events = [], blocks = [];
    const ci = name => { let i = conds.indexOf(name); if (i < 0) { conds.push(name); i = conds.length - 1; } return i; };
    let t = 0;
    const pickOrder = (seg, k) => {
      const C = seg.conditions;
      if (seg.order === 'alternate') return C[k % C.length].name;
      if (seg.order === 'sequence') { let acc = 0; for (const c of C) { acc += c.p * seg.n; if (k < acc - 1e-9) return c.name; } return C[C.length - 1].name; }
      let u = r.next(), acc = 0;
      for (const c of C) { acc += c.p; if (u < acc) return c.name; }
      return C[C.length - 1].name;
    };
    cfg.timeline.segments.forEach(seg => {
      if (seg.kind === 'rest') { blocks.push({ t0: t, t1: t + seg.dur, kind: 'rest' }); t += seg.dur; return; }
      if (seg.kind === 'block') {
        const c = ci(seg.cond);
        events.push({ t, dur: seg.dur, ci: c, cond: seg.cond });
        blocks.push({ t0: t, t1: t + seg.dur, kind: 'task', ci: c, cond: seg.cond });
        t += seg.dur; return;
      }
      seg.conditions.forEach(c => ci(c.name));
      if (seg.kind === 'blocks') {
        for (let k = 0; k < seg.n; k++) {
          const name = pickOrder(seg, k), c = ci(name);
          events.push({ t, dur: seg.on, ci: c, cond: name });
          blocks.push({ t0: t, t1: t + seg.on, kind: 'task', ci: c, cond: name });
          const off = seg.off + r.next() * seg.jitter;
          blocks.push({ t0: t + seg.on, t1: t + seg.on + off, kind: 'rest' });
          t += seg.on + off;
        }
      } else {
        const t0 = t;
        for (let k = 0; k < seg.n; k++) {
          const name = pickOrder(seg, k);
          events.push({ t, dur: seg.dur, ci: ci(name), cond: name });
          t += seg.isi + r.next() * seg.jitter;
        }
        t += 15;
        blocks.push({ t0, t1: t, kind: 'events' });
      }
    });
    return { events, blocks, conditions: conds, dur: Math.max(t, 10) };
  };

  /* A smooth random gain field over the probe for the scalp signals: 1 on
     average, varying by about `het` from place to place over ~5 cm.  One
     field serves every systemic signal, because they all ride on the same
     scalp vessels; where the scalp is thicker or better perfused, all of
     them are bigger. */
  function gainField(r, het) {
    const k = [];
    for (let i = 0; i < 4; i++) k.push({ kx: r.gauss() * 0.6, ky: r.gauss() * 0.6, ph: r.next() * 2 * Math.PI, a: r.gauss() });
    const norm = Math.sqrt(k.reduce((s, q) => s + q.a * q.a, 0) / 2) || 1;
    return (x, y) => Math.max(0.05, 1 + het * k.reduce((s, q) => s + q.a * Math.cos(q.kx * x + q.ky * y + q.ph), 0) / norm);
  }

  /* ---------- simulate ---------- */
  NIRS.simulate = function (cfg) {
    const R = cfg.recording, fs = R.fs, seed = R.seed;
    const tl = NIRS.expandTimeline(cfg);
    const n = Math.max(16, Math.round(tl.dur * fs));
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i / fs;
    const geo = cfg.geometry || NIRS.buildProbe(cfg.probe);
    const lambdas = R.wavelengths, nL = lambdas.length;
    const layers = NIRS.headLayers(cfg.head.model, { thick: cfg.head.thick });
    const brainTop = NIRS.brainTop(layers);
    const head = NIRS.HEADS[cfg.head.model];
    const fwhm = R.source === 'led' ? NIRS.LED_FWHM : NIRS.LASER_FWHM;
    // the extinction each source really sees, which the analysis does not know
    const extTrue = lambdas.map(nm => NIRS.effectiveExt(nm, fwhm));

    /* optics per wavelength */
    const optics = lambdas.map(nm => {
      const ol = NIRS.opticalLayers(layers, nm);
      return { nm, ol, sol: NIRS.fluence(ol) };
    });

    /* regions: every activation and both regions of every pair */
    const regions = [];
    cfg.activations.forEach(a => regions.push({ id: 'act:' + a.name, kind: 'activation', src: a, x: a.x, y: a.y, z: a.depth, r: a.radius, label: a.label }));
    cfg.pairs.forEach(p => p.regions.forEach((g, k) => regions.push({ id: 'pair:' + p.name + ':' + k, kind: 'pair', pair: p, k, src: g, x: g.x, y: g.y, z: g.depth, r: g.radius, label: p.label + ' ' + g.name })));

    /* coupling at every optode: hair, plus the program's poor optode */
    const hair = NIRS.HAIR[cfg.head.hair] || NIRS.HAIR.none;
    const rc = NIRS.stream(seed, 'coupling');
    const optodes = geo.sources.concat(geo.detectors);
    optodes.forEach(o => {
      const c = hair.couple * Math.exp(hair.spread * rc.gauss() - hair.spread * hair.spread / 2);
      o.couple = NIRS.clamp(c, 0.005, 0.98);
      o.trans = lambdas.map(nm => o.couple * Math.exp(-hair.melanin * NIRS.melanin(nm)));
    });

    /* channels: baseline intensity and partial pathlengths */
    const det = NIRS.DETECTORS[R.detector];
    const chans = geo.channels.map((c, ci) => {
      const s = geo.sources[c.src], d = geo.detectors[c.det];
      const per = optics.map((o, li) => {
        const pl = NIRS.pathlengths(o.sol, c.rho);
        const La = regions.map(rg => NIRS.regionPath(o.sol, [s.x, s.y], [d.x, d.y], rg, brainTop));
        const I0 = R.power * 1e6 * pl.R * NIRS.DETECTOR_AREA * s.trans[li] * d.trans[li];
        return { R: pl.R, L: pl.total, Lk: pl.layers.slice(), dpf: pl.dpf, La, I0 };
      });
      return Object.assign({}, c, { index: ci, per });
    });

    /* ---------- components ----------
       Each: { id, kind, label, on, terms: [{ series: Float64Array(n), coef: [ch][l] }] }
       contribution to -ln(I) = sum over terms of coef * series. */
    const groups = [];
    const extO = li => extTrue[li][0], extR = li => extTrue[li][1];

    // cortical regions through the balloon model
    const regionHb = {};
    const condIndex = name => tl.conditions.indexOf(name);
    regions.forEach((rg, ri) => {
      let u, hb;
      if (rg.kind === 'activation') {
        const a = rg.src, ru = NIRS.stream(seed, 'trialgain:' + a.name);
        u = new Float64Array(n);
        const gains = {};
        if (a.conditions.length) a.conditions.forEach(c => { gains[c.name] = c.gain; });
        tl.events.forEach(ev => {
          const g = a.conditions.length ? (gains[ev.cond] || 0) : 1;
          if (!g) return;
          const gv = g * Math.max(0, 1 + 0.2 * ru.gauss());
          const i0 = Math.round(ev.t * fs), i1 = Math.max(i0 + 1, Math.round((ev.t + ev.dur) * fs));
          for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) u[i] += gv;
        });
        hb = NIRS.balloon(u, 1 / fs, a.flow, { n: a.n, dip: a.dip });
      } else {
        const p = rg.pair;
        if (!p._z) {
          const rz = NIRS.stream(seed, 'pair:' + p.name);
          const band = f => (f >= p.band[0] && f <= p.band[1] ? 1 : Math.exp(-Math.pow((f < p.band[0] ? p.band[0] - f : f - p.band[1]) / 0.01, 2)));
          const zs = NIRS.shapedNoise(n, fs, band, rz), za = NIRS.shapedNoise(n, fs, band, rz), zb = NIRS.shapedNoise(n, fs, band, rz);
          const c = Math.sqrt(p.coupling), cc = Math.sqrt(1 - p.coupling);
          p._z = [Float64Array.from(zs, (v, i) => p.fluct * (c * v + cc * za[i])), Float64Array.from(zs, (v, i) => p.fluct * (c * v + cc * zb[i]))];
        }
        u = p._z[rg.k];
        hb = NIRS.balloon(u, 1 / fs, 1, {});
      }
      regionHb[rg.id] = { hbo: hb.hbo, hbr: hb.hbr, hbt: hb.hbt, bold: hb.bold, f: hb.f, u };
      const gid = rg.kind === 'activation' ? rg.id : 'pair:' + rg.pair.name;
      let grp = groups.find(g => g.id === gid);
      if (!grp) {
        grp = { id: gid, kind: 'brain', label: rg.kind === 'activation' ? 'Activation: ' + rg.label : 'Connectivity pair: ' + rg.pair.label, on: true, terms: [] };
        groups.push(grp);
      }
      grp.terms.push({ series: hb.hbo, coef: chans.map(c => c.per.map((q, li) => LN10 * 1e-6 * q.La[ri] * extO(li))) });
      grp.terms.push({ series: hb.hbr, coef: chans.map(c => c.per.map((q, li) => LN10 * 1e-6 * q.La[ri] * extR(li))) });
    });
    cfg.pairs.forEach(p => { delete p._z; });

    // systemic physiology, spread over the layers
    const PH = cfg.physiology, het = PH.heterogeneity;
    const sysSeries = {};
    const respRate = PH.respiration.rate || 0.25;
    const field = gainField(NIRS.stream(seed, 'scalpfield'), het);
    ['cardiac', 'respiration', 'mayer', 'drift', 'taskbp'].forEach(k => {
      const A = PH[k], info = NIRS.SYSTEMIC[k];
      const rs = NIRS.stream(seed, 'physio:' + k);
      let x;
      if (k === 'cardiac') x = NIRS.physio.cardiac(n, fs, A.rate, respRate, rs);
      else if (k === 'respiration') x = NIRS.physio.respiration(n, fs, A.rate, rs);
      else if (k === 'mayer') x = NIRS.physio.mayer(n, fs, A.rate, rs);
      else if (k === 'drift') x = NIRS.physio.drift(n, fs, rs);
      else x = NIRS.physio.taskBP(n, fs, tl.events, rs, { delay: A.delay });
      const amp = A.amp;
      const series = Float64Array.from(x, v => v * amp);
      sysSeries[k] = series;
      const coef = chans.map(c => {
        const s = geo.sources[c.src], d = geo.detectors[c.det];
        const g = c.short ? field(s.x, s.y) : (field(s.x, s.y) + field(d.x, d.y)) / 2;
        return c.per.map((q, li) => {
          let w = 0;
          layers.forEach((L, k2) => {
            const lw = info.layers[L.key] * (L.key === 'scalp' ? g : 1) * (L.key === 'gray' || L.key === 'white' ? PH.brain : 1);
            w += q.Lk[k2] * lw;
          });
          return LN10 * 1e-6 * w * (extO(li) + info.hbr * extR(li));
        });
      });
      groups.push({ id: k, kind: 'physio', label: info.label, on: A.on, terms: [{ series, coef }] });
    });

    /* ---------- artifacts ---------- */
    const art = cfg.artifacts;
    const optIndex = name => optodes.findIndex(o => o.name === name);
    const nOpt = optodes.length;
    // motion: change in log coupling at each optode
    const rm = NIRS.stream(seed, 'spikes');
    const spikeLn = optodes.map(() => new Float64Array(n));
    const spikeEvents = [];
    {
      const A = art.spikes;
      let tt = rm.exp(A.rate);
      while (tt < tl.dur - 2) {
        const group = rm.next() < 0.3;
        const centre = optodes[rm.int(nOpt)];
        const hit = group ? optodes.map((o, i) => i).filter(i => Math.hypot(optodes[i].x - centre.x, optodes[i].y - centre.y) < 3.2) : [optIndex(centre.name)];
        const dur = rm.uniform(0.4, 3), sign = rm.next() < 0.7 ? -1 : 1;
        hit.forEach(oi => {
          const a = sign * A.amp * rm.uniform(0.4, 1.6);
          const i0 = Math.round(tt * fs), i1 = Math.min(n, Math.round((tt + dur * 3) * fs));
          for (let i = Math.max(0, i0); i < i1; i++) {
            const s = (i / fs - tt);
            const env = s < 0.15 ? s / 0.15 : Math.exp(-(s - 0.15) / (dur * 0.6));
            // a jolt with some ringing, not a clean bump
            spikeLn[oi][i] += a * env * (1 + 0.35 * Math.sin(2 * Math.PI * s * 2.3));
          }
        });
        spikeEvents.push({ t: tt, optodes: hit.map(i => optodes[i].name) });
        tt += rm.exp(A.rate) + 1;
      }
    }
    const rsft = NIRS.stream(seed, 'shifts');
    const shiftLn = optodes.map(() => new Float64Array(n));
    const shiftEvents = [];
    {
      const A = art.shifts;
      for (let k = 0; k < A.count; k++) {
        const tt = rsft.uniform(0.1, 0.95) * tl.dur, oi = rsft.int(nOpt);
        const a = rsft.sign() * A.amp * rsft.uniform(0.5, 1.5);
        for (let i = Math.max(0, Math.round(tt * fs)); i < n; i++) {
          const s = i / fs - tt;
          shiftLn[oi][i] += a * Math.min(1, s / 0.4);
        }
        shiftEvents.push({ t: tt, optode: optodes[oi].name, size: a });
      }
    }
    const lamFactor = lambdas.map(nm => 1 + 0.12 * (nm - 800) / 100);
    groups.push({ id: 'spikes', kind: 'artifact', label: 'Motion spikes', on: art.spikes.on });
    groups.push({ id: 'shifts', kind: 'artifact', label: 'Baseline shifts', on: art.shifts.on });
    groups.push({ id: 'poor', kind: 'artifact', label: 'Poorly coupled optode (' + art.poor.optode + ')', on: art.poor.on });

    // ambient light at each detector, before the demodulation rejects it
    const ra = NIRS.stream(seed, 'ambient');
    const A = art.ambient;
    const nSlots = R.multiplex === 'time' ? geo.sources.length * nL + 1 : 1;
    const Tint = 1 / (fs * nSlots);
    const sinc = x => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const flickAmp = A.flicker > 0 ? Math.abs(sinc(A.flicker * Tint)) : 0;
    const ambient = geo.detectors.map((d, di) => {
      const base = new Float64Array(n), flick = new Float64Array(n);
      const lvl = A.level * (0.6 + 0.8 * ra.next());
      const slow = NIRS.shapedNoise(n, fs, f => (f < 0.01 ? 1 : 0), ra);
      let ph = ra.next() * 2 * Math.PI;
      const fjit = NIRS.shapedNoise(n, fs, f => (f < 0.005 ? 1 : 0), ra);
      for (let i = 0; i < n; i++) {
        const tt = i / fs;
        base[i] = lvl * (1 + 0.15 * slow[i]) * (A.change !== null && tt >= A.change ? 3 : 1);
        // mains frequency wanders by a few hundredths of a hertz, so its alias wanders too
        const f = A.flicker * (1 + 2e-4 * fjit[i]);
        ph += 2 * Math.PI * f / fs;
        flick[i] = base[i] * 0.5 * flickAmp * Math.sin(ph);
      }
      return { base, flick, total: Float64Array.from(base, (v, i) => v + flick[i]) };
    });
    groups.push({ id: 'ambient', kind: 'artifact', label: 'Ambient light', on: A.on });
    groups.push({ id: 'noise', kind: 'noise', label: 'Detector and source noise', on: true });

    const ds = {
      cfg, fs, n, t, dur: n / fs, lambdas, nL, geo, optodes, chans, layers, brainTop, head, hair, det, optics, extTrue, fwhm,
      regions, regionHb, sysSeries, events: tl.events, blocks: tl.blocks, conditions: tl.conditions,
      groups, spikeLn, shiftLn, spikeEvents, shiftEvents, lamFactor, ambient, nSlots, flickAmp,
      poorIndex: optIndex(art.poor.optode), seed
    };
    return ds;
  };

  /* Ambient light that survives the demodulation, per multiplexing scheme:
     lock-in detection at a modulation frequency rejects it almost
     completely, time multiplexing with a dark slot subtracts the steady
     part but not what changes between slots, and no multiplexing adds it all. */
  NIRS.AMBIENT_REJECTION = {
    frequency: { base: 0.001, flick: 0.001 },
    time: { base: 0.01, flick: 0.2 },
    none: { base: 1, flick: 1 }
  };

  /* ---------- assemble ----------
     opts: { enabled: Set of group ids, noise: true, filters: true,
             only: [channel indices] } */
  NIRS.assemble = function (ds, opts) {
    opts = opts || {};
    const en = opts.enabled || new Set(ds.groups.filter(g => g.on).map(g => g.id));
    const n = ds.n, nL = ds.nL, R = ds.cfg.recording;
    const chans = ds.chans;
    const I = chans.map(() => ds.lambdas.map(() => new Float64Array(n)));
    const active = ds.groups.filter(g => en.has(g.id) && g.terms);
    const mux = R.multiplex;
    chans.forEach((c, ci) => {
      for (let li = 0; li < nL; li++) {
        const out = I[ci][li];
        let couple = 1;
        if (en.has('poor') && ds.poorIndex >= 0) {
          const pi = ds.poorIndex, so = c.src, dn = ds.geo.sources.length + c.det;
          if (pi === so || pi === dn) couple = ds.cfg.artifacts.poor.couple;
        }
        const lnI0 = Math.log(c.per[li].I0 * couple);
        out.fill(lnI0);
        active.forEach(g => g.terms.forEach(term => {
          const k = term.coef[ci][li], s = term.series;
          if (k === 0) return;
          for (let i = 0; i < n; i++) out[i] -= k * s[i];
        }));
        const so = c.src, dn = ds.geo.sources.length + c.det, lf = ds.lamFactor[li];
        if (en.has('spikes')) { const a = ds.spikeLn[so], b = ds.spikeLn[dn]; for (let i = 0; i < n; i++) out[i] += lf * (a[i] + b[i]); }
        if (en.has('shifts')) { const a = ds.shiftLn[so], b = ds.shiftLn[dn]; for (let i = 0; i < n; i++) out[i] += lf * (a[i] + b[i]); }
        for (let i = 0; i < n; i++) out[i] = Math.exp(out[i]);
      }
    });
    // without multiplexing every source is on at once: a detector sees them all
    let meas = I;
    if (mux === 'none') {
      meas = chans.map((c, ci) => ds.lambdas.map((_, li) => {
        const out = new Float64Array(n);
        chans.forEach((c2, cj) => { if (c2.det === c.det) { const x = I[cj][li]; for (let i = 0; i < n; i++) out[i] += x[i]; } });
        return out;
      }));
    }
    const det = ds.det, rn = NIRS.stream(ds.seed, 'noise');
    const rej = NIRS.AMBIENT_REJECTION[mux];
    // time multiplexing divides each detector's time between the slots: more noise per sample
    const slotPenalty = mux === 'time' ? Math.sqrt(ds.nSlots / 4) : 1;
    const noiseOn = opts.noise !== false && en.has('noise');
    chans.forEach((c, ci) => {
      for (let li = 0; li < nL; li++) {
        const out = meas[ci][li];
        if (en.has('ambient')) {
          // a dark slot removes what is steady but not a flicker that changes between slots
          const amb = ds.ambient[c.det];
          for (let i = 0; i < n; i++) out[i] += rej.base * amb.base[i] + rej.flick * amb.flick[i];
        }
        if (noiseOn) {
          // ambient photons add shot noise even when demodulation removes their mean
          const amb = en.has('ambient') ? ds.ambient[c.det].total : null;
          for (let i = 0; i < n; i++) {
            const x = out[i], light = Math.max(0, x) + (amb ? amb[i] : 0);
            const sd = Math.sqrt(det.floor * det.floor * slotPenalty * slotPenalty + det.shot * light * slotPenalty + (det.drift * x) * (det.drift * x));
            out[i] = x + sd * rn.gauss();
          }
        }
        const sat = det.sat;
        for (let i = 0; i < n; i++) { if (out[i] > sat) out[i] = sat; if (out[i] < 1e-6) out[i] = 1e-6; }
      }
    });
    return { I: meas, enabled: en };
  };

  // Which channels touch an optode (for marking a poor optode or a motion event)
  NIRS.channelsOfOptode = function (ds, name) {
    const oi = ds.optodes.findIndex(o => o.name === name);
    const nS = ds.geo.sources.length;
    return ds.chans.filter(c => c.src === oi || nS + c.det === oi).map(c => c.index);
  };
})(typeof window !== 'undefined' ? window : globalThis);
