/* EEG simulator: the Processing tab.  Re-referencing, offline filters and
   what they do to waveforms, and ICA with removable components. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui, dsp = EEG.dsp;
  const $ = ui.$, S = EEG.S;
  const st = { sel: 0, plots: {} };

  const REF_INFO = {
    online: ['As recorded', r => `Every channel is its electrode minus ${r}, the online reference. ${r} itself is flat, and anything that happens at ${r} appears, inverted, in every channel.`],
    mastoids: ['Linked mastoids', () => 'Subtract the mean of M1 and M2. Traditional for ERPs because the mastoids are far from most generators, though not silent: temporal sources and the heart reach them.'],
    average: ['Average', () => 'Subtract the mean of all scalp channels at each instant. It approximates a reference at infinity when the cap covers the head densely and evenly, and gets worse with fewer channels and a bare lower head.'],
    Cz: ['Cz', () => 'Subtract Cz. Hides whatever is under the vertex and is a poor choice for central components, but is a common online reference.'],
    bipolar: ['Bipolar, longitudinal', () => 'Each trace is the difference between neighbouring electrodes along the front-to-back chains (the clinical "double banana"). Shared, distant activity cancels; a focal source appears as a phase reversal between the two channels that share the electrode above it.'],
    transverse: ['Bipolar, transverse', () => 'Neighbouring differences across the head from left to right, the complement of the longitudinal chains.'],
    laplacian: ['Surface Laplacian', () => 'The current source density: how sharply the potential curves at each electrode, computed with spherical splines. Reference-free, sharpens local superficial sources and suppresses broad ones, including volume-conducted activity from far away. Units are µV/cm².']
  };

  /* ---------- pipeline summary ---------- */
  function drawPipeline() {
    const R = S.cfg.recording, P = S.proc, E = S.epoch, I = S.ica;
    const step = (t, s) => `<button disabled style="opacity:1;cursor:default"><span>${t}</span><small>${s}</small></button>`;
    const arrow = '<span class="arrow" aria-hidden="true">&rarr;</span>';
    $('pipeline').innerHTML = [
      step('Recorded', `against ${R.reference}, hardware ${R.hp ? R.hp + ' Hz' : 'DC'} to ${R.lp} Hz`),
      step('1 · Re-reference', REF_INFO[P.reref][0]),
      step('2 · Filters', [P.hp ? 'HP ' + EEG.fmt(P.hp, 2) + ' Hz' : null, P.lp ? 'LP ' + P.lp + ' Hz' : null, P.notch ? 'notch ' + P.notch + ' Hz' : null].filter(Boolean).join(', ') + (P.hp || P.lp || P.notch ? `, order ${P.order}, ${P.phase === 'zero' ? 'zero-phase' : 'causal'}` : 'none')),
      step('3 · ICA', I.model ? (I.stale ? 'out of date, run again' : `${I.rejected.size} of ${I.model.k} removed`) : 'not run'),
      step('Epochs', `${Math.round(E.t0 * 1000)} to ${Math.round(E.t1 * 1000)} ms${E.baseline ? ', baseline' : ''}${E.reject ? ', reject ±' + E.reject + ' µV' : ''}`),
      step('Average', 'on the ERP averaging tab')
    ].join(arrow);
  }

  /* ---------- re-reference ---------- */
  function refButtons() {
    const modes = ['online', 'mastoids', 'average', 'Cz', 'bipolar', 'transverse', 'laplacian'].filter(m => m !== 'Cz' || S.ds.capLabels.includes('Cz'));
    $('refSeg').innerHTML = modes.map(m => `<button data-ref="${m}" aria-pressed="${m === S.proc.reref}">${m === 'online' ? 'As recorded' : REF_INFO[m][0]}</button>`).join('');
    $('refText').innerHTML = `<p>${REF_INFO[S.proc.reref][1](S.cfg.recording.reference)}</p>`;
  }
  function drawRefCompare() {
    const T = D.theme(), ds = S.ds, fs = ds.fs;
    const t = parseFloat($('refTime').value);
    $('refTime').max = ds.dur.toFixed(2);
    $('refTimeV').textContent = ui.fmtT(t);
    const i = EEG.clamp(Math.round(t * fs), 0, ds.n - 1);
    const v = S.rec.rows.map(r => r[i]);
    const modes = ['online', 'mastoids', 'average'].concat(ds.capLabels.includes('Cz') && S.cfg.recording.reference !== 'Cz' ? ['Cz'] : []).concat(['laplacian']);
    const maps = modes.map(m => ({ m, out: EEG.refVector(v, m) }));
    let mx = 0; maps.forEach(o => { if (o.m !== 'laplacian') o.out.values.forEach(x => { mx = Math.max(mx, Math.abs(x)); }); });
    const cv = $('cvRefCompare');
    const n = maps.length;
    const { ctx, w, h } = D.fit(cv, w => Math.min(190, w / n + 46));
    const r = Math.min(w / n / 2 - 6, (h - 46) / 2);
    maps.forEach((o, k) => {
      const cx = (k + 0.5) * w / n, cy = 18 + r + 4;
      const lap = o.m === 'laplacian';
      const res = D.topo(ctx, cx, cy, r, o.out.labels, o.out.values, { range: lap ? undefined : mx || 1, contours: r > 40 });
      ctx.fillStyle = T.ink2; ctx.font = D.font(11, o.m === S.proc.reref ? 700 : 500); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(o.m === 'online' ? `as recorded (${S.cfg.recording.reference})` : REF_INFO[o.m][0].replace('Surface ', ''), cx, 2);
      ctx.fillStyle = T.muted; ctx.font = D.font(10);
      ctx.fillText(lap ? `±${EEG.fmt(res.range, 2)} µV/cm²` : `±${EEG.fmt(mx, 0)} µV`, cx, cy + r + 6);
    });
  }

  /* ---------- filters ---------- */
  function readFilters() {
    const P = S.proc, fs = S.ds.fs;
    P.hp = $('fHpOn').checked ? +Math.pow(10, parseFloat($('fHp').value)).toPrecision(2) : null;
    P.lp = $('fLpOn').checked ? Math.min(parseFloat($('fLp').value), Math.floor(fs / 2 - 1)) : null;
    P.notch = +$('fNotch').value || null;
    P.notchWidth = parseFloat($('fNotchW').value);
    P.order = parseInt($('fOrder').value, 10);
    P.phase = $('fPhase').value;
    P.harmonics = $('fHarm').checked;
  }
  function syncFilters() {
    const P = S.proc;
    $('fHpOn').checked = !!P.hp; if (P.hp) $('fHp').value = Math.log10(P.hp);
    $('fLpOn').checked = !!P.lp; if (P.lp) $('fLp').value = P.lp;
    $('fLp').max = Math.floor(S.ds.fs / 2 - 1);
    $('fNotch').value = String(P.notch || 0);
    $('fNotchW').value = P.notchWidth; $('fOrder').value = P.order; $('fPhase').value = P.phase; $('fHarm').checked = !!P.harmonics;
    labels();
  }
  function labels() {
    $('fHpV').textContent = EEG.fmt(Math.pow(10, parseFloat($('fHp').value)), 2) + ' Hz';
    $('fLpV').textContent = $('fLp').value + ' Hz';
    $('fNotchWV').textContent = $('fNotchW').value + ' Hz';
    $('fOrderV').textContent = $('fOrder').value + (S.proc && S.proc.phase === 'zero' ? ` (×2 = ${2 * $('fOrder').value} effective)` : '');
  }
  function drawResponse() {
    const T = D.theme(), fs = S.ds.fs, R = S.cfg.recording;
    const ch = dsp.chain(S.proc, fs);
    const f = []; for (let k = 0; k <= 400; k++) f.push(Math.pow(10, -2 + k / 400 * (Math.log10(fs / 2) + 2)));
    const db = m => 20 * Math.log10(Math.max(m, 1e-6));
    const hw = [];
    if (R.hp) hw.push(...dsp.butter('high', 1, R.hp, fs));
    if (R.lp && R.lp < fs / 2) hw.push(...dsp.butter('low', 4, R.lp, fs));
    const series = [
      { x: f, y: f.map(x => db(Math.hypot(...dsp.response(hw, x, fs)))), color: T.muted, dash: [5, 4], label: 'hardware filters (already applied)', width: 1.5 },
      { x: f, y: f.map(x => db(ch.magnitude(x))), color: T.series[0], label: 'offline filters' }
    ];
    if (!st.plots.resp) st.plots.resp = new D.Plot($('cvFiltResp'), { height: 230 });
    st.plots.resp.draw({ series, xLog: true, xRange: [0.01, fs / 2], yRange: [-60, 6], xLabel: 'frequency (Hz)', yLabel: 'gain (dB)', hlines: [{ y: -3, color: T.grid, dash: [2, 3] }], tipX: x => `${EEG.fmt(x, 2)} Hz`, tipFmt: v => v.toFixed(1) + ' dB' });
    ui.legend($('filtRespLegend'), [{ color: T.series[0], label: 'offline filters' }, { color: T.muted, label: 'hardware filters (already applied)', dash: true }, { color: T.ink2, label: '−3 dB marks the cutoff', dash: true }]);
  }

  /* ---------- test signals ---------- */
  function testSignal() {
    const fs = S.ds.fs, kind = $('testSig').value;
    const pre = 2, post = 3, n = Math.round((pre + post) * fs), x = new Float64Array(n), t = i => i / fs - pre;
    const g = (c, s, a) => { for (let i = 0; i < n; i++) { const z = (t(i) - c) / s; x[i] += a * Math.exp(-0.5 * z * z); } };
    let view = [-0.5, 1.2], note = '';
    if (kind === 'erp') {
      const tr = EEG.app.truth();
      const labs = tr.labels || [];
      const k = labs.indexOf($('testCh').value);
      if (!tr.raw || k < 0) { kind === 'erp' && (note = 'This program has no ERP sources, so a P300-like wave is used instead.'); g(0.35, 0.25 / 2.355, 10); }
      else {
        // the condition with the biggest response at that channel
        let best = tr.raw[0], bm = 0;
        tr.raw.forEach(c => { let m = 0; for (let i = 0; i < c.nT; i++) m = Math.max(m, Math.abs(c.data[k * c.nT + i])); if (m > bm) { bm = m; best = c; } });
        const s0 = Math.round(best.times[0] * fs);
        for (let i = 0; i < best.nT; i++) x[Math.round(pre * fs) + s0 + i] = best.data[k * best.nT + i];
        // taper the end so the truncated epoch does not look like a step
        const end = Math.round(pre * fs) + s0 + best.nT, tap = Math.round(0.15 * fs);
        for (let i = 0; i < tap; i++) x[end - tap + i] *= 0.5 + 0.5 * Math.cos(Math.PI * i / tap);
        view = [best.times[0], best.times[best.nT - 1]];
      }
    } else if (kind === 'p300') g(0.35, 0.25 / 2.355, 10);
    else if (kind === 'spike') {
      const c = 0.1, sr = 0.07 / 6, sf = 0.07 / 3;
      for (let i = 0; i < n; i++) { const tt = t(i) - c, z = tt / (tt < 0 ? sr : sf); x[i] += -100 * Math.exp(-0.5 * z * z); }
      g(c + 0.035 + 0.13, 0.07, -50); view = [-0.3, 0.8];
    } else if (kind === 'step') { for (let i = 0; i < n; i++) if (t(i) >= 0) x[i] = 50 * Math.exp(-t(i) / 1.0); view = [-0.5, 2]; }
    else { for (let i = 0; i < n; i++) { const tt = t(i) - 0.4; x[i] = 10 * Math.sin(2 * Math.PI * 10 * tt) * Math.exp(-0.5 * Math.pow(tt / 0.12, 2)); } view = [-0.2, 1]; }
    return { x, n, pre, view, note };
  }
  function drawTest() {
    const T = D.theme(), fs = S.ds.fs;
    const ts = testSignal();
    const y = Float64Array.from(ts.x);
    const ch = dsp.chain(S.proc, fs);
    ch.apply(y);
    const tms = Array.from({ length: ts.n }, (_, i) => (i / fs - ts.pre) * 1000);
    const a = Math.max(0, Math.round((ts.view[0] + ts.pre) * fs)), b = Math.min(ts.n, Math.round((ts.view[1] + ts.pre) * fs));
    const sl = arr => Array.prototype.slice.call(arr, a, b);
    if (!st.plots.test) st.plots.test = new D.Plot($('cvFiltTest'), { height: 250 });
    st.plots.test.draw({
      x: sl(tms), xLabel: 'time (ms)', yLabel: 'µV',
      series: [{ y: sl(ts.x), color: T.ink2, dash: [5, 4], label: 'original', width: 1.6 }, { y: sl(y), color: T.series[0], label: 'filtered' }],
      vlines: [{ x: 0, color: T.muted, label: 'onset' }], tipX: x => `${x.toFixed(0)} ms`, tipFmt: v => v.toFixed(2) + ' µV'
    });
    ui.legend($('filtTestLegend'), [{ color: T.ink2, label: 'original', dash: true }, { color: T.series[0], label: 'after the offline filters' }]);
    // impulse and step responses
    const n = Math.round(4 * fs), c = Math.round(2 * fs);
    const imp = new Float64Array(n); imp[c] = 1; ch.apply(imp);
    const stp = new Float64Array(n); for (let i = c; i < n; i++) stp[i] = 1; ch.apply(stp);
    let mi = 0; imp.forEach(v => { mi = Math.max(mi, Math.abs(v)); });
    const tt = Array.from({ length: n }, (_, i) => (i - c) / fs * 1000);
    const span = S.proc.hp && S.proc.hp < 1 ? 2000 : 600;
    const lo = Math.max(0, c - Math.round(span / 2000 * fs)), hi = Math.min(n, c + Math.round(span / 1000 * fs));
    if (!st.plots.imp) st.plots.imp = new D.Plot($('cvFiltImpulse'), { height: 250 });
    st.plots.imp.draw({
      x: tt.slice(lo, hi), xLabel: 'time from the input (ms)', yLabel: 'relative output',
      series: [{ y: Array.from(imp.slice(lo, hi), v => v / (mi || 1)), color: T.series[1], label: 'impulse response (scaled)' }, { y: Array.from(stp.slice(lo, hi)), color: T.series[2], label: 'step response' }],
      vlines: [{ x: 0, color: T.muted }], tipX: x => `${x.toFixed(0)} ms`, tipFmt: v => v.toFixed(3)
    });
    ui.legend($('filtImpLegend'), [{ color: T.series[1], label: 'impulse response, scaled to peak 1' }, { color: T.series[2], label: 'step response' }]);
    // measures
    const pk = arr => { let m = 0, im = 0; for (let i = a; i < b; i++) if (Math.abs(arr[i]) > Math.abs(m)) { m = arr[i]; im = i; } return { m, t: (im / fs - ts.pre) * 1000 }; };
    const p0 = pk(ts.x), p1 = pk(y);
    let preMax = 0; for (let i = a; i < Math.round(ts.pre * fs); i++) preMax = Math.max(preMax, Math.abs(y[i] - ts.x[i]));
    let opp = 0; for (let i = a; i < b; i++) if (Math.sign(y[i]) === -Math.sign(p0.m) && Math.abs(y[i]) > opp) opp = Math.abs(y[i]);
    ui.readouts($('filtReadouts'), [
      ['Peak, original', `${EEG.fmt(p0.m, 1)} µV at ${p0.t.toFixed(0)} ms`],
      ['Peak, filtered', `${EEG.fmt(p1.m, 1)} µV at ${p1.t.toFixed(0)} ms`],
      ['Amplitude change', `${((p1.m / (p0.m || 1) - 1) * 100).toFixed(0)}%`],
      ['Latency shift', `${(p1.t - p0.t).toFixed(0)} ms`],
      ['Before onset', `${EEG.fmt(preMax, 2)} µV`, 'largest change before the stimulus: only an acausal filter can put it there'],
      ['Opposite-polarity lobe', `${EEG.fmt(opp, 2)} µV`, 'deflection of the opposite sign that the original does not have']
    ]);
    if (ts.note) $('filtReadouts').insertAdjacentHTML('beforeend', `<div class="note" style="grid-column:1/-1">${ts.note}</div>`);
  }

  /* ---------- ICA ---------- */
  function truthCandidates() {
    const ds = S.ds, out = [];
    ds.gens.forEach(g => out.push({ label: g.kind === 'artifact' && g.group === 'muscle' ? 'Muscle: ' + g.label.toLowerCase() : g.label, group: g.group, v: EEG.refVector(EEG.rowTopo(ds, g.topo)).values, tc: g.tc }));
    out.push({ label: 'Line noise', group: 'line', v: EEG.refVector(EEG.lineCoupling(ds, true)).values });
    if (ds.badE >= 0 && ds.rowLabels.includes(ds.elecLabels[ds.badE])) {
      const d = ds.rowLabels.map(l => l === ds.elecLabels[ds.badE] ? 1 : 0);
      out.push({ label: `Bad electrode ${ds.elecLabels[ds.badE]}`, group: 'bad', v: EEG.refVector(d).values });
    }
    return out;
  }
  function corr(a, b) {
    const n = a.length, ma = EEG.mean(a), mb = EEG.mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }
  function matchComponents() {
    const cands = truthCandidates(), I = S.ica, labels = S.filt.labels;
    I.matches = I.model.comps.map(c => {
      let best = null, br = 0;
      cands.forEach(t => { const r = Math.abs(corr(c.topo, t.v)); if (r > br) { br = r; best = t; } });
      let e = 0, mx = 0, at = 0; c.topo.forEach((x, i) => { e += x * x; if (x * x > mx) { mx = x * x; at = i; } });
      const single = mx / e > 0.6;
      if (best && br >= 0.9) return { text: `≈ ${best.label}`, r: br, group: best.group };
      if (single) return { text: `one channel, ${labels[at]}: a pop, drift or bad contact`, r: mx / e, group: 'single' };
      if (best && br >= 0.7) return { text: `resembles ${best.label}`, r: br, group: best.group };
      return { text: 'mixed: background EEG or noise', r: br, group: null };
    });
  }
  async function runICA() {
    if (!S.filt.positions) { $('icaStatus').textContent = 'ICA runs on a referential montage. Switch the re-reference away from bipolar first.'; return; }
    const k = parseInt($('icaK').value, 10);
    const bar = $('icaProgress').firstElementChild;
    $('btnICA').disabled = true; ui.busy(true);
    $('icaStatus').textContent = 'Whitening and running FastICA...';
    bar.style.width = '5%';
    await new Promise(r => setTimeout(r, 20));
    const t0 = performance.now();
    const hp = (S.proc.hp || 0) < 1 ? 1 : null;
    try {
      const model = await EEG.ica.fit(S.filt.rows, { k, fs: S.ds.fs, highpass: hp, seed: S.cfg.recording.seed }, async (it, ch) => {
        bar.style.width = Math.min(95, 5 + it / 2) + '%';
        $('icaStatus').textContent = `Iteration ${it}, median change ${ch.toExponential(1)}...`;
        await new Promise(r => setTimeout(r, 0));
      });
      S.ica = { model, rejected: new Set(), stale: false, labels: S.filt.labels.slice(), mode: S.proc.reref, changed: false };
      matchComponents();
      st.sel = 0;
      bar.style.width = '100%';
      $('icaStatus').textContent = `${model.k} components in ${Math.round(performance.now() - t0)} ms, ${model.iterations} iterations${model.converged ? '' : ' (stopped at the limit)'}. ` +
        `The ${model.k} components keep ${(model.pcaVar * 100).toFixed(1)}% of the variance${hp ? '; fitted on a 1 Hz high-passed copy, as is usual' : ''}. Click a component to inspect it, and Remove to subtract it.`;
    } catch (e) { console.error(e); $('icaStatus').textContent = 'ICA failed: ' + e.message; }
    $('btnICA').disabled = false; ui.busy(false);
    EEG.app.run('ica');
  }
  function drawICAGrid() {
    const I = S.ica, grid = $('icaGrid'), T = D.theme();
    if (!I.model) { grid.innerHTML = ''; return; }
    const reveal = $('icaTruth').checked;
    grid.innerHTML = I.model.comps.map((c, i) => `<div class="ica-card${i === st.sel ? ' sel' : ''}${I.rejected.has(i) ? ' rej' : ''}" data-i="${i}">
      <button class="ghost small x" data-x="${i}">${I.rejected.has(i) ? 'Keep' : 'Remove'}</button>
      <canvas class="bare" data-c="${i}"></canvas>
      <div class="t"><b>IC ${i + 1}</b><span>${(c.pvaf * 100).toFixed(1)}%</span></div>
      <div class="m">${reveal ? I.matches[i].text + (I.matches[i].group && I.matches[i].group !== 'single' ? ` (r ${I.matches[i].r.toFixed(2)})` : '') : (I.rejected.has(i) ? 'removed' : '&nbsp;')}</div></div>`).join('');
    grid.querySelectorAll('canvas').forEach(cv => {
      const i = +cv.dataset.c, c = I.model.comps[i];
      const { ctx, w, h } = D.fit(cv, w => w * 0.92);
      D.topo(ctx, w / 2, h / 2 + 3, Math.min(w, h) / 2 * 0.82, I.labels, c.topo, { contours: false, electrodes: false, res: 40 });
    });
    if (I.stale) $('icaStatus').textContent = 'The montage changed since ICA was run, so these components no longer apply. Run ICA again.';
    else if (I.changed) $('icaStatus').textContent = 'Signals were switched on or off since ICA was run. The components still apply as spatial filters, but running ICA again will fit the new data.';
  }
  function drawICADetail() {
    const I = S.ica, T = D.theme(), fs = S.ds.fs;
    const t0 = parseFloat($('icaT').value), win = 10;
    $('icaT').max = Math.max(0, S.ds.dur - win).toFixed(1);
    $('icaTV').textContent = ui.fmtT(t0);
    const i0 = Math.round(t0 * fs), i1 = Math.min(S.ds.n, i0 + win * fs);
    const tt = Array.from({ length: i1 - i0 }, (_, i) => (i0 + i) / fs);
    if (I.model && !I.stale) {
      const c = I.model.comps[st.sel];
      const act = EEG.ica.activations({ comps: [c], mean: I.model.mean }, S.filt.rows, i0, i1)[0];
      const full = EEG.ica.activations({ comps: [c], mean: I.model.mean }, S.filt.rows, 0, S.ds.n)[0];
      const sp = dsp.welch(full, fs, [[0, S.ds.n]]);
      if (!st.plots.act) st.plots.act = new D.Plot($('cvICAAct'), { height: 160 });
      st.plots.act.draw({ x: tt, series: [{ y: act, color: T.series[0], label: `IC ${st.sel + 1}`, width: 1.2 }], xLabel: 'time (s)', yLabel: 'activation (a.u.)', tipX: x => ui.fmtT(x) });
      if (!st.plots.spec) st.plots.spec = new D.Plot($('cvICASpec'), { height: 150 });
      st.plots.spec.draw({ x: sp.f, series: [{ y: sp.p, color: T.series[0], label: 'power' }], xRange: [0.5, Math.min(fs / 2, 100)], yLog: true, xLabel: 'frequency (Hz)', yLabel: 'power (a.u.)', tipX: x => `${x.toFixed(1)} Hz` });
      const m = I.matches[st.sel];
      $('icaActCap').innerHTML = `IC ${st.sel + 1} explains ${(c.pvaf * 100).toFixed(1)}% of the variance.` + ($('icaTruth').checked ? ` Ground truth: <strong>${m.text}</strong>.` : ' Judge it from its map, time course and spectrum, then reveal the truth to check.');
    } else {
      [$('cvICAAct'), $('cvICASpec')].forEach(cv => { const g = D.fit(cv, 40); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('Run ICA to see component time courses.', 8, 24); });
    }
    // before and after
    const labels = S.filt.labels, k = labels.indexOf($('icaCh').value);
    if (k < 0) return;
    if (!st.plots.clean) st.plots.clean = new D.Plot($('cvICAClean'), { height: 230 });
    const before = Array.prototype.slice.call(S.filt.rows[k], i0, i1), after = Array.prototype.slice.call(S.clean[k], i0, i1);
    const n = I.rejected.size;
    st.plots.clean.draw({ x: tt, series: [{ y: before, color: T.muted, label: 'before ICA', width: 1.2 }, { y: after, color: T.series[0], label: n ? `after removing ${n}` : 'after (nothing removed)', width: 1.4 }], xLabel: 'time (s)', yLabel: S.filt.unit, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(1) });
    ui.legend($('icaCleanLegend'), [{ color: T.muted, label: 'before ICA' }, { color: T.series[0], label: n ? `after removing ${n} component${n > 1 ? 's' : ''}` : 'nothing removed yet' }]);
  }

  function render() {
    if (!S.ds) return;
    const tlabs = (EEG.app.truth().labels) || S.filt.labels;
    const cur = $('testCh').value;
    ui.fill($('testCh'), ui.chOptions(tlabs), tlabs.includes(cur) ? cur : ui.pick(tlabs, ['Pz', 'P8', 'Cz', 'Oz']));
    drawPipeline(); refButtons(); drawRefCompare(); syncFilters(); drawResponse(); drawTest();
    const nCh = S.filt.labels.length;
    $('icaK').max = Math.max(4, Math.min(40, nCh - 1));
    const cc = $('icaCh').value;
    ui.fill($('icaCh'), ui.chOptions(S.filt.labels), S.filt.labels.includes(cc) ? cc : ui.pick(S.filt.labels, ['Fp1', 'Fp2', 'Fz']));
    $('btnICA').disabled = !S.filt.positions;
    if (!S.ica.model) { $('icaStatus').textContent = S.filt.positions ? 'ICA has not been run on this recording.' : 'ICA needs a referential montage; bipolar channels are not independent mixtures.'; $('icaProgress').firstElementChild.style.width = '0'; }
    drawICAGrid(); drawICADetail();
  }

  EEG.tabs.processing = {
    init() {
      $('cvICAAct').insertAdjacentHTML('afterend', '<canvas id="cvICASpec" style="margin-top:8px"></canvas>');
      $('refSeg').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        S.proc.reref = b.dataset.ref;
        EEG.app.later(() => EEG.app.run('process'));
      });
      $('refTime').addEventListener('input', ui.debounce(drawRefCompare, 30));
      const refilter = ui.debounce(() => { readFilters(); EEG.app.later(() => EEG.app.run('process')); }, 250);
      ['fHpOn', 'fHp', 'fLpOn', 'fLp', 'fNotch', 'fNotchW', 'fOrder', 'fPhase', 'fHarm'].forEach(id => $(id).addEventListener('input', () => { labels(); refilter(); }));
      ['testSig', 'testCh'].forEach(id => $(id).addEventListener('change', drawTest));
      ui.range('icaK', v => String(v));
      $('btnICA').addEventListener('click', runICA);
      $('icaTruth').addEventListener('change', () => { drawICAGrid(); drawICADetail(); });
      $('icaGrid').addEventListener('click', e => {
        const x = e.target.closest('[data-x]');
        if (x) {
          const i = +x.dataset.x;
          if (S.ica.rejected.has(i)) S.ica.rejected.delete(i); else S.ica.rejected.add(i);
          st.sel = i;
          EEG.app.later(() => EEG.app.run('ica'));
          return;
        }
        const card = e.target.closest('.ica-card'); if (!card) return;
        st.sel = +card.dataset.i; drawICAGrid(); drawICADetail();
      });
      $('icaCh').addEventListener('change', drawICADetail);
      $('icaT').addEventListener('input', ui.debounce(drawICADetail, 60));
    },
    onBuild() {
      $('icaK').value = Math.min(S.icaK || 20, S.cfg.recording.cap - 1); $('icaKV').textContent = $('icaK').value;
      $('icaTruth').checked = false;
      $('refTime').value = Math.min(S.ds.dur / 3, 12).toFixed(2);
      const ev = S.ds.events[0];
      $('icaT').max = Math.max(0, S.ds.dur - 10).toFixed(1);
      $('icaT').value = ev ? Math.max(0, ev.t - 1).toFixed(1) : 0;
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
