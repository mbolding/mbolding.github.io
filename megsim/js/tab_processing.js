/* MEG simulator: the Processing tab.  Offline filters and what they do to
   waveforms, ICA with removable components (checked against the truth),
   and head movement with its compensation through SSS. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S, dsp = MEG.dsp, v3 = MEG.v3, SUP = MEG.suppress;
  const $ = ui.$;
  const st = { sel: 0, plots: {}, move: null };

  /* ---------- pipeline summary ---------- */
  function drawPipeline() {
    const R = S.cfg.recording, P = S.proc, E = S.epoch, I = S.ica, arr = S.ds.array;
    const step = (t, s) => `<button disabled style="opacity:1;cursor:default"><span>${t}</span><small>${s}</small></button>`;
    const arrow = '<span class="arrow" aria-hidden="true">&rarr;</span>';
    $('pipeline').innerHTML = [
      step('Recorded', `${arr.nch} ${arr.type === 'planar' ? 'channels' : MEG.KIND_LABEL[arr.type]}, online ${R.hp ? R.hp + ' Hz' : 'DC'} to ${R.lp} Hz`),
      step('Noise rejection', S.sup.steps.length ? S.sup.steps.join(', ') : 'none (Noise tab)'),
      step('1 · Filters', [P.hp ? 'HP ' + MEG.fmt(P.hp, P.hp < 1 ? 2 : 1).replace(/\.?0+$/, '') + ' Hz' : null, P.lp ? 'LP ' + P.lp + ' Hz' : null, P.notch ? 'notch ' + P.notch + ' Hz' : null].filter(Boolean).join(', ') + (P.hp || P.lp || P.notch ? `, order ${P.order}, ${P.phase === 'zero' ? 'zero-phase' : 'causal'}` : 'none')),
      step('2 · ICA', I.model ? (I.stale ? 'out of date, run again' : `${I.rejected.size} of ${I.model.k} removed`) : 'not run'),
      step('Epochs', `${Math.round(E.t0 * 1000)} to ${Math.round(E.t1 * 1000)} ms${E.baseline ? ', baseline' : ''}${E.rejectOn ? ', rejection' : ''}`),
      step('Average', 'on the Averaging tab')
    ].join(arrow);
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
    $('fHpV').textContent = MEG.fmt(Math.pow(10, parseFloat($('fHp').value)), 2) + ' Hz';
    $('fLpV').textContent = $('fLp').value + ' Hz';
    $('fNotchWV').textContent = $('fNotchW').value + ' Hz';
    $('fOrderV').textContent = $('fOrder').value + ($('fPhase').value === 'zero' ? ` (×2 = ${2 * $('fOrder').value} effective)` : '');
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
      { x: f, y: f.map(x => db(Math.hypot(...dsp.response(hw, x, fs)))), color: T.muted, dash: [5, 4], label: 'online filters (already applied)', width: 1.5 },
      { x: f, y: f.map(x => db(ch.magnitude(x))), color: T.series[0], label: 'offline filters' }
    ];
    if (!st.plots.resp) st.plots.resp = new D.Plot($('cvFiltResp'), { height: 230 });
    st.plots.resp.draw({ series, xLog: true, xRange: [0.01, fs / 2], yRange: [-60, 6], xLabel: 'frequency (Hz)', yLabel: 'gain (dB)', hlines: [{ y: -3, color: T.grid, dash: [2, 3] }], tipX: x => `${MEG.fmt(x, 2)} Hz`, tipFmt: v => v.toFixed(1) + ' dB' });
    ui.legend($('filtRespLegend'), [{ color: T.series[0], label: 'offline filters' }, { color: T.muted, label: 'online filters, already in the data', dash: true }, { color: T.ink2, label: '−3 dB marks the cutoff', dash: true }]);
  }

  /* ---------- test signals ---------- */
  async function testSignal() {
    const fs = S.ds.fs, kind = $('testSig').value;
    const pre = 2, post = 3, n = Math.round((pre + post) * fs), x = new Float64Array(n), t = i => i / fs - pre;
    const g = (c, s, a) => { for (let i = 0; i < n; i++) { const z = (t(i) - c) / s; x[i] += a * Math.exp(-0.5 * z * z); } };
    let view = [-0.3, 0.8], note = '', unit = 'fT';
    if (kind === 'erp') {
      const tr = await MEG.app.truth();
      const k = parseInt($('testCh').value, 10);
      if (!tr.ok || !(k >= 0)) { note = 'This recording has no evoked sources, so an M100-like wave is used instead.'; g(0.05, 0.01, -60); g(0.1, 0.015, 200); g(0.18, 0.025, -80); }
      else {
        unit = S.ds.array.channels[k].unit;
        let best = tr.rawConds[0], bm = 0;
        tr.rawConds.forEach(c => { let m = 0; for (let i = 0; i < tr.nT; i++) m = Math.max(m, Math.abs(c.data[k * tr.nT + i])); if (m > bm) { bm = m; best = c; } });
        const s0 = Math.round(tr.times[0] * fs);
        for (let i = 0; i < tr.nT; i++) x[Math.round(pre * fs) + s0 + i] = best.data[k * tr.nT + i];
        const end = Math.round(pre * fs) + s0 + tr.nT, tap = Math.round(0.1 * fs);
        for (let i = 0; i < tap; i++) x[end - tap + i] *= 0.5 + 0.5 * Math.cos(Math.PI * i / tap);
        view = [tr.times[0], tr.times[tr.nT - 1]];
      }
    } else if (kind === 'spike') {
      const c = 0.1, sr = 0.07 / 6, sf = 0.07 / 3;
      for (let i = 0; i < n; i++) { const tt = t(i) - c, z = tt / (tt < 0 ? sr : sf); x[i] += 1500 * Math.exp(-0.5 * z * z); }
      g(c + 0.035 + 0.13, 0.07, 700);
    } else if (kind === 'step') { for (let i = 0; i < n; i++) if (t(i) >= 0) x[i] = 3000; view = [-0.5, 2.5]; note = 'A flux jump is a step that stays: a high-pass filter turns it into a decaying transient, and a zero-phase filter spreads it backward in time too.'; }
    else { for (let i = 0; i < n; i++) { const tt = t(i) - 0.4; x[i] = 400 * Math.sin(2 * Math.PI * 10 * tt) * Math.exp(-0.5 * Math.pow(tt / 0.12, 2)); } view = [-0.2, 1]; }
    return { x, n, pre, view, note, unit };
  }
  async function drawTest() {
    const T = D.theme(), fs = S.ds.fs;
    const ts = await testSignal();
    const y = Float64Array.from(ts.x);
    const ch = dsp.chain(S.proc, fs);
    ch.apply(y);
    const tms = Array.from({ length: ts.n }, (_, i) => (i / fs - ts.pre) * 1000);
    const a = Math.max(0, Math.round((ts.view[0] + ts.pre) * fs)), b = Math.min(ts.n, Math.round((ts.view[1] + ts.pre) * fs));
    const sl = arr => Array.prototype.slice.call(arr, a, b);
    if (!st.plots.test) st.plots.test = new D.Plot($('cvFiltTest'), { height: 250 });
    st.plots.test.draw({
      x: sl(tms), xLabel: 'time (ms)', yLabel: ts.unit,
      series: [{ y: sl(ts.x), color: T.ink2, dash: [5, 4], label: 'original', width: 1.6 }, { y: sl(y), color: T.series[0], label: 'filtered' }],
      vlines: [{ x: 0, color: T.muted, label: 'onset' }], tipX: x => `${x.toFixed(0)} ms`, tipFmt: v => ui.fmtV(v, ts.unit)
    });
    ui.legend($('filtTestLegend'), [{ color: T.ink2, label: 'original', dash: true }, { color: T.series[0], label: 'after the offline filters' }]);
    const pk = arr => { let m = 0, im = 0; for (let i = a; i < b; i++) if (Math.abs(arr[i]) > Math.abs(m)) { m = arr[i]; im = i; } return { m, t: (im / fs - ts.pre) * 1000 }; };
    const p0 = pk(ts.x), p1 = pk(y);
    let preMax = 0; for (let i = a; i < Math.round(ts.pre * fs); i++) preMax = Math.max(preMax, Math.abs(y[i] - ts.x[i]));
    let opp = 0; for (let i = a; i < b; i++) if (Math.sign(y[i]) === -Math.sign(p0.m) && Math.abs(y[i]) > opp) opp = Math.abs(y[i]);
    ui.readouts($('filtReadouts'), [
      ['Peak, original', `${ui.fmtV(p0.m, ts.unit)} at ${p0.t.toFixed(0)} ms`],
      ['Peak, filtered', `${ui.fmtV(p1.m, ts.unit)} at ${p1.t.toFixed(0)} ms`],
      ['Amplitude change', `${(Math.round((p1.m / (p0.m || 1) - 1) * 100) || 0)}%`],
      ['Latency shift', `${(p1.t - p0.t).toFixed(0)} ms`],
      ['Before onset', ui.fmtV(preMax, ts.unit), 'largest change before the stimulus: only an acausal filter can put it there'],
      ['Opposite-polarity lobe', ui.fmtV(opp, ts.unit), 'deflection of the opposite sign that the original does not have']
    ]);
    if (ts.note) $('filtReadouts').insertAdjacentHTML('beforeend', `<div class="note" style="grid-column:1/-1">${ts.note}</div>`);
  }

  /* ---------- ICA ---------- */
  function corr(a, b) {
    const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }
  // What could have made a component: every generator's pattern, eyes taken together, on the noise-scaled channels.
  function truthCandidates(sigma) {
    const ds = S.ds, out = [], scaled = v => Float64Array.from(v, (x, i) => x / sigma[i]);
    const byGroup = {};
    ds.gens.forEach(g => {
      if (!S.enabled.has(g.group) || g.kind === 'background') return;
      const p = MEG.genPattern(ds, g);
      if (g.group === 'blinks' || g.group === 'saccades') { byGroup[g.group] = byGroup[g.group] ? byGroup[g.group].map((x, i) => x + p[i]) : Float64Array.from(p); return; }
      out.push({ label: g.kind === 'source' ? g.label : (MEG.ARTIFACT_INFO[g.group] ? MEG.ARTIFACT_INFO[g.group].label + (ds.gens.filter(x => x.group === g.group).length > 1 ? ': ' + g.label : '') : g.label), group: g.group, v: scaled(p) });
    });
    Object.keys(byGroup).forEach(k => out.push({ label: MEG.ARTIFACT_INFO[k].label, group: k, v: scaled(byGroup[k]) }));
    return out;
  }
  function matchComponents() {
    const I = S.ica, arr = S.ds.array;
    const cands = truthCandidates(I.sigma);
    I.matches = I.model.comps.map(c => {
      let best = null, br = 0;
      cands.forEach(t => { const r = Math.abs(corr(c.topo, t.v)); if (r > br) { br = r; best = t; } });
      let e = 0, mx = 0, at = 0; c.topo.forEach((x, i) => { e += x * x; if (x * x > mx) { mx = x * x; at = i; } });
      const single = mx / e > 0.5;
      if (best && br >= 0.9) return { text: `≈ ${best.label}`, r: br, group: best.group };
      if (single) return { text: `one sensor, ${arr.channels[at].name}: a flux jump or a bad channel`, r: mx / e, group: 'single' };
      if (best && br >= 0.7) return { text: `resembles ${best.label}`, r: br, group: best.group };
      return { text: 'mixed: brain activity or noise', r: br, group: null };
    });
  }
  async function runICA() {
    const k = parseInt($('icaK').value, 10);
    const bar = $('icaProgress').firstElementChild;
    $('btnICA').disabled = true; ui.busy(true);
    $('icaStatus').textContent = 'Scaling channels by their noise, whitening and running FastICA...';
    bar.style.width = '5%';
    await new Promise(r => setTimeout(r, 20));
    const t0 = performance.now();
    const hp = (S.proc.hp || 0) < 1 ? 1 : null;
    const sigma = MEG.app.chanSigma();
    const rows = S.filt.rows.map((r, c) => Float32Array.from(r, x => x / sigma[c]));
    try {
      const model = await MEG.ica.fit(rows, { k, fs: S.ds.fs, highpass: hp, seed: S.cfg.recording.seed }, async (it, ch) => {
        bar.style.width = Math.min(95, 5 + it / 2) + '%';
        $('icaStatus').textContent = `Iteration ${it}, median change ${ch.toExponential(1)}...`;
        await new Promise(r => setTimeout(r, 0));
      });
      S.ica = { model, sigma, rejected: new Set(), stale: false, changed: false, type: S.ds.array.type };
      matchComponents();
      st.sel = 0;
      bar.style.width = '100%';
      $('icaStatus').textContent = `${model.k} components in ${Math.round(performance.now() - t0)} ms, ${model.iterations} iterations${model.converged ? '' : ' (stopped at the limit)'}. ` +
        `They keep ${(model.pcaVar * 100).toFixed(1)}% of the variance${hp ? '; fitted on a 1 Hz high-passed copy, as is usual' : ''}. Click a component to inspect it, and Remove to subtract it.`;
    } catch (e) { console.error(e); $('icaStatus').textContent = 'ICA failed: ' + e.message; }
    $('btnICA').disabled = false; ui.busy(false);
    MEG.app.run('ica');
  }
  function compSite(c) {
    const I = S.ica, arr = S.ds.array;
    const v = Float64Array.from(c.topo, (x, i) => x * I.sigma[i]);
    return D.siteValues(arr, v, arr.type === 'planar' ? 'mag' : null);
  }
  function drawICAGrid() {
    const I = S.ica, grid = $('icaGrid');
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
      D.topo(ctx, w / 2, h / 2, Math.min(w, h) / 2 * 0.94, D.sites(), compSite(c), { contours: false, dots: false, res: 40 });
    });
    if (I.stale) $('icaStatus').textContent = 'The sensor array changed since ICA was run, so these components no longer apply. Run ICA again.';
    else if (I.changed) $('icaStatus').textContent = 'Signals or noise rejection changed since ICA was run. The components still apply as spatial filters, but running ICA again will fit the new data.';
  }
  function drawICADetail() {
    const I = S.ica, T = D.theme(), fs = S.ds.fs, arr = S.ds.array;
    const t0 = parseFloat($('icaT').value), win = 10;
    $('icaT').max = Math.max(0, S.ds.dur - win).toFixed(1);
    $('icaTV').textContent = ui.fmtT(t0);
    const i0 = Math.round(t0 * fs), i1 = Math.min(S.ds.n, i0 + win * fs);
    const tt = Array.from({ length: i1 - i0 }, (_, i) => (i0 + i) / fs);
    if (I.model && !I.stale) {
      const c = I.model.comps[st.sel];
      const act = MEG.app.icaActivation(I.model, c, S.filt.rows, I.sigma, i0, i1);
      const full = MEG.app.icaActivation(I.model, c, S.filt.rows, I.sigma, 0, S.ds.n);
      const sp = dsp.welch(full, fs, [[0, S.ds.n]]);
      if (!st.plots.act) st.plots.act = new D.Plot($('cvICAAct'), { height: 160 });
      st.plots.act.draw({ x: tt, series: [{ y: act, color: T.series[0], label: `IC ${st.sel + 1}`, width: 1.2 }], xLabel: 'time (s)', yLabel: 'activation (a.u.)', tipX: x => ui.fmtT(x) });
      if (!st.plots.spec) st.plots.spec = new D.Plot($('cvICASpec'), { height: 150 });
      st.plots.spec.draw({ x: sp.f, series: [{ y: sp.p, color: T.series[0], label: 'power' }], xRange: [0.5, Math.min(fs / 2, 100)], yLog: true, xLabel: 'frequency (Hz)', yLabel: 'power (a.u.)', tipX: x => `${x.toFixed(1)} Hz` });
      const m = I.matches[st.sel];
      $('icaActCap').innerHTML = `IC ${st.sel + 1} explains ${(c.pvaf * 100).toFixed(1)}% of the variance.` + ($('icaTruth').checked ? ` Ground truth: <strong>${m.text}</strong>.` : ' Judge it from its map, time course and spectrum, then reveal the truth to check.');
    } else {
      [$('cvICAAct'), $('cvICASpec')].forEach(cv => D.message(cv, 'Run ICA to see component time courses.', 40));
    }
    const k = parseInt($('icaCh').value, 10);
    if (!(k >= 0)) return;
    if (!st.plots.clean) st.plots.clean = new D.Plot($('cvICAClean'), { height: 230 });
    const before = Array.prototype.slice.call(S.filt.rows[k], i0, i1), after = Array.prototype.slice.call(S.clean[k], i0, i1);
    const n = I.rejected.size, unit = arr.channels[k].unit;
    st.plots.clean.draw({ x: tt, series: [{ y: before, color: T.muted, label: 'before ICA', width: 1.2 }, { y: after, color: T.series[0], label: n ? `after removing ${n}` : 'after (nothing removed)', width: 1.4 }], xLabel: 'time (s)', yLabel: unit, tipX: x => ui.fmtT(x), tipFmt: v => ui.fmtV(v, unit) });
    ui.legend($('icaCleanLegend'), [{ color: T.muted, label: 'before ICA' }, { color: T.series[0], label: n ? `after removing ${n} component${n > 1 ? 's' : ''}` : 'nothing removed yet' }]);
  }

  /* ---------- head movement and compensation ---------- */
  function drawMove() {
    const T = D.theme(), ds = S.ds, P = ds.pose, on = S.enabled.has('movement');
    const xs = [], tr = [[], [], []];
    for (let k = 0; k < P.K - 1; k++) { xs.push(k / P.fs); for (let d = 0; d < 3; d++) tr[d].push((on ? P.tr[d][k] : 0) * 10); }
    if (!st.plots.move) st.plots.move = new D.Plot($('cvMove'), { height: 220 });
    st.plots.move.draw({
      x: xs, xLabel: 'time (s)', yLabel: 'displacement (mm)', yRange: on ? undefined : [-2, 2],
      series: [{ y: tr[0], color: T.series[0], label: 'x', width: 1.4 }, { y: tr[1], color: T.series[1], label: 'y', width: 1.4 }, { y: tr[2], color: T.series[2], label: 'z', width: 1.4 }],
      after: (ctx, m) => { if (!on) D.label(ctx, 'Head movement is switched off (Noise or Recording tab).', (m.X0 + m.X1) / 2, (m.Y0 + m.Y1) / 2 - 16, { align: 'center', color: T.muted }); },
      tipFmt: v => v.toFixed(1) + ' mm', tipX: x => ui.fmtT(x)
    });
    ui.legend($('moveLegend'), [{ color: T.series[0], label: 'x, toward the right ear' }, { color: T.series[1], label: 'y, toward the nose' }, { color: T.series[2], label: 'z, up' }]);
    const arr = ds.array;
    const can = SUP.sssAvailable(arr) && arr.frame === 'device';
    $('btnMove').disabled = !ds.events.length || arr.frame === 'head';
    $('moveNote').textContent = arr.frame === 'head' ? 'OPMs move with the head: the brain does not move relative to them, so there is nothing to compensate.'
      : !ds.events.length ? 'This recording has no stimuli to average.' : !can ? 'Compensation needs SSS, so it needs planar gradiometers with magnetometers; the comparison shows only the blur.' : '';
    if (!st.move || st.move.version !== S.version) ['cvMvStill', 'cvMvMoved', 'cvMvComp'].forEach((id, i) => D.message($(id), ['As if still', 'As recorded', 'Compensated'][i], 60));
  }
  // The evoked sources' field at the peak of their average waveform, per trial at that trial's head position.
  async function compareMovement() {
    const ds = S.ds, arr = ds.array, fs = ds.fs;
    const gens = ds.gens.filter(g => g.evoked && S.enabled.has(g.group));
    if (!gens.length) { $('moveNote').textContent = 'No evoked sources are switched on.'; return; }
    $('btnMove').disabled = true; ui.busy(true);
    // the latency of the largest average response
    const avgAt = (g, lag) => { let s = 0, n = 0; ds.events.forEach(ev => { const i = ev.sample + lag; if (i >= 0 && i < ds.n) { s += g.tc[i]; n++; } }); return n ? s / n : 0; };
    let bestLag = 0, bv = 0;
    for (let lag = 0; lag < Math.round(0.4 * fs); lag += 2) { const v = Math.abs(avgAt(gens[0], lag)); if (v > bv) { bv = v; bestLag = lag; } }
    const amp = gens.map(g => avgAt(g, bestLag));
    const on = S.enabled.has('movement');
    const chansAt = P => arr.channels.map(c => ({ pts: MEG.pointsIn(Object.assign({ frame: 'device' }, c), 'device', 'head', P) }));
    const fieldAt = P => { const ch = chansAt(P), v = new Float64Array(arr.nch); gens.forEach((g, j) => { const f = MEG.forwardMEG(ch, g.pos, v3.scale(g.ori, amp[j])); for (let c = 0; c < arr.nch; c++) v[c] += f[c]; }); return v; };
    const still = fieldAt(ds.pose.ref);
    const can = SUP.sssAvailable(arr);
    const moved = new Float64Array(arr.nch), comp = new Float64Array(arr.nch);
    const order = SUP.defaultOrder(arr.nch), model0 = can ? SUP.sssModel(ds, ds.pose.ref, order) : null;
    const evs = ds.events.slice(0, 120);
    for (let k = 0; k < evs.length; k++) {
      const P = on ? ds.pose.at(evs[k].t + bestLag / fs) : ds.pose.ref;
      const y = fieldAt(P);
      for (let c = 0; c < arr.nch; c++) moved[c] += y[c] / evs.length;
      if (can) {
        const m = SUP.sssModel(ds, P, order);
        const x = m.P.slice(0, m.nin).map(row => { let s = 0; for (let c = 0; c < arr.nch; c++) s += row[c] * y[c]; return s; });
        for (let c = 0; c < arr.nch; c++) { let s = 0; for (let q = 0; q < m.nin; q++) s += model0.Sin[c][q] * x[q]; comp[c] += s / evs.length; }
      }
      if (k % 6 === 5) { ui.progress('icaProgress', 0); $('moveNote').textContent = `Trial ${k + 1} of ${evs.length}...`; await MEG.app.frame(); }
    }
    const err = v => { let a = 0, b = 0; for (let c = 0; c < arr.nch; c++) { a += (v[c] - still[c]) ** 2; b += still[c] ** 2; } return Math.sqrt(a / b); };
    st.move = { version: S.version, still, moved, comp: can ? comp : null, lag: bestLag / fs, errMoved: err(moved), errComp: can ? err(comp) : NaN, n: evs.length, on };
    $('btnMove').disabled = false; ui.busy(false);
    $('moveNote').textContent = '';
    drawMoveMaps();
  }
  function drawMoveMaps() {
    const m = st.move; if (!m || m.version !== S.version) return;
    const arr = S.ds.array, mode = arr.type === 'planar' ? 'rms' : null, unit = arr.type === 'planar' ? 'fT/cm' : 'fT';
    const sv = v => D.siteValues(arr, v, mode);
    const a = sv(m.still), b = sv(m.moved), c = m.comp ? sv(m.comp) : null;
    let mx = 0; [a, b, c].forEach(x => x && x.forEach(y => { mx = Math.max(mx, Math.abs(y)); }));
    const opts = t => ({ unit, maxH: 210, title: t, sequential: !!mode, range: mode ? [0, mx] : mx, colorbar: true, fmt: x => MEG.fmt(x, 0), floor0: !!mode });
    D.topoCanvas($('cvMvStill'), D.sites(), a, opts('As if the head were still'));
    D.topoCanvas($('cvMvMoved'), D.sites(), b, opts('As recorded'));
    if (c) D.topoCanvas($('cvMvComp'), D.sites(), c, opts('Compensated with SSS')); else D.message($('cvMvComp'), 'Compensation needs SSS\n(planar gradiometers).', 120);
    ui.readouts($('moveReadouts'), [
      ['Latency mapped', Math.round(m.lag * 1000) + ' ms'],
      ['Trials', String(m.n)],
      ['Error as recorded', (m.errMoved * 100).toFixed(1) + '%', 'difference from the still map, relative to its size'],
      ['Error compensated', isFinite(m.errComp) ? (m.errComp * 100).toFixed(1) + '%' : '–']
    ]);
  }

  function render() {
    if (!S.ds) return;
    const arr = S.ds.array;
    const keep = st.arrType === arr.type && st.build === S.cfg;
    const opts = arr.channels.map((c, i) => ({ value: String(i), label: c.name }));
    const tc = $('testCh').value;
    ui.fill($('testCh'), opts, keep ? tc : String(ui.bestChannel()));
    const cc = $('icaCh').value;
    ui.fill($('icaCh'), opts, keep ? cc : String(ui.bestChannel()));
    st.arrType = arr.type; st.build = S.cfg;
    drawPipeline(); syncFilters(); drawResponse(); drawTest();
    $('icaK').max = Math.max(4, Math.min(40, arr.nch - 1));
    if (!S.ica.model) { $('icaStatus').textContent = 'ICA has not been run on this recording.'; $('icaProgress').firstElementChild.style.width = '0'; }
    drawICAGrid(); drawICADetail();
    drawMove(); drawMoveMaps();
  }

  MEG.tabs.processing = {
    init() {
      const refilter = ui.debounce(() => { readFilters(); MEG.app.run('filter'); }, 300);
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
          MEG.app.run('ica');
          return;
        }
        const card = e.target.closest('.ica-card'); if (!card) return;
        st.sel = +card.dataset.i; drawICAGrid(); drawICADetail();
      });
      $('icaCh').addEventListener('change', drawICADetail);
      $('icaT').addEventListener('input', ui.debounce(drawICADetail, 60));
      $('btnMove').addEventListener('click', () => compareMovement().catch(e => { console.error(e); ui.busy(false); $('btnMove').disabled = false; }));
    },
    onBuild() {
      $('icaK').value = Math.min(S.icaK || 20, 40); $('icaKV').textContent = $('icaK').value;
      $('icaTruth').checked = false;
      const ev = S.ds.events[0];
      $('icaT').max = Math.max(0, S.ds.dur - 10).toFixed(1);
      $('icaT').value = ev ? Math.max(0, ev.t - 1).toFixed(1) : 0;
      st.move = null;
    },
    onArray() { st.move = null; },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
