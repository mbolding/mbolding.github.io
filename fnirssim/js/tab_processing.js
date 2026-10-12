/* fNIRS simulator: the Processing tab.  Each step of the pipeline with its
   switch and its effect on the selected channel. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = {};
  let ctl = {};

  function chips() {
    const P = S.P, res = S.res;
    const items = [
      ['Raw intensity', true],
      [`Quality: ${P.qualityOn ? res.bad.size + ' rejected' : 'off'}`, P.qualityOn],
      ['Optical density', true],
      [`Motion: ${P.motion}`, P.motion !== 'none'],
      [`Band-pass ${P.hp ? P.hp + ' Hz' : 'DC'} to ${P.lp ? P.lp + ' Hz' : '∞'}`, !!(P.hp || P.lp)],
      [`Beer-Lambert, DPF ${P.dpf.mode === 'fixed' ? P.dpf.values.join(' / ') : P.dpf.mode}`, true],
      [`Short channels: ${P.short}${P.short !== 'off' ? ', ' + (P.shortMode === 'glm' ? 'with the task' : 'before') : ''}`, P.short !== 'off'],
      ['Average and GLM', true]
    ];
    $('pipeChips').innerHTML = items.map(([t, on], i) => `${i ? '<span class="ar">&rarr;</span>' : ''}<span class="st ${on ? 'on' : 'off'}">${t}</span>`).join('');
  }

  function qtable() {
    const ds = S.ds, q = S.res.quality;
    const rows = ds.chans.map((c, i) => {
      const x = q[i], bad = x.bad && S.P.qualityOn;
      return `<tr data-i="${i}" class="${bad ? 'bad' : ''}${i === S.selCh ? ' sel' : ''}"><td>${c.label}${c.short ? ' <span class="badge">short</span>' : ''}</td><td>${c.rho.toFixed(1)} cm</td>
        <td>${x.mean.map(v => NIRS.fmtPower(v)).join(' / ')}</td><td>${x.cv.map(v => (100 * v).toFixed(1)).join(' / ')}%</td><td>${isFinite(x.sci) ? x.sci.toFixed(2) : 'n/a'}</td>
        <td style="text-align:left">${x.bad ? `<span class="badge bad">${x.reasons.join('; ')}</span>` : '<span class="badge ok">kept</span>'}</td></tr>`;
    }).join('');
    $('qTable').innerHTML = `<tr><th>Channel</th><th>Distance</th><th>Mean light</th><th>CV</th><th>SCI</th><th style="text-align:left">Verdict</th></tr>${rows}`;
    $('qTable').querySelectorAll('tr[data-i]').forEach(tr => tr.addEventListener('click', () => { S.selCh = +tr.dataset.i; NIRS.app.markAll(); }));
  }

  function render() {
    if (!S.ds) return;
    const ds = S.ds, T = D.theme(), P = S.P, res = S.res;
    const ch = ui.chSelect($('prCh'));
    chips(); qtable();
    // SCI map and time course
    const g = D.fit($('cvQMap'), w => Math.min(260, w * 0.62));
    st.qmap = D.probeMap(g.ctx, ds, { x: 4, y: 4, w: g.w - 8, h: g.h - 8 }, { values: res.quality.map(x => x.sci), sequential: true, range: [0, 1], selected: ch, bad: P.qualityOn ? res.bad : null });
    D.bindProbe($('cvQMap'), () => st.qmap, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); }, ci => `${S.ds.chans[ci].label}: SCI ${S.res.quality[ci].sci.toFixed(2)}`);
    const sw = NIRS.dsp.sciWindows(ds, S.rec.I[ch], 10);
    if (!st.pSci) st.pSci = new D.Plot($('cvSci'), { height: 150 });
    if (sw) st.pSci.draw({
      x: Float64Array.from(sw, w => w.t), xLabel: 'time (s)', yLabel: 'SCI (10 s windows)', yRange: [-0.2, 1.05],
      series: [{ y: Float64Array.from(sw, w => w.sci), color: T.accent, label: ds.chans[ch].label }], hlines: [{ y: P.sci, color: T.crit, dash: [4, 3] }],
      tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(2)
    });
    else { const gg = D.fit($('cvSci'), 60); gg.ctx.fillStyle = T.muted; gg.ctx.font = D.font(11); gg.ctx.fillText(`The scalp coupling index needs the heartbeat, so a sampling rate of at least 5 Hz (this recording: ${ds.fs} Hz).`, 8, 30); }
    motion(ch); filt(ch); scr(ch);
  }

  function motion(ch) {
    const ds = S.ds, T = D.theme(), res = S.res, P = S.P, li = ds.nL - 1;
    const raw = res.od[ch][li], cor = res.odm[ch][li];
    const k = 1000;
    const series = [{ y: Float64Array.from(raw, v => v * k), color: T.muted, label: 'before', width: 1.2 }];
    if (P.motion !== 'none') series.push({ y: Float64Array.from(cor, v => v * k), color: T.accent, label: 'after ' + P.motion.toUpperCase(), width: 1.3 });
    const c = ds.chans[ch], names = [ds.geo.sources[c.src].name, ds.geo.detectors[c.det].name];
    const marks = [];
    if (S.enabled.has('spikes')) ds.spikeEvents.forEach(e => { if (e.optodes.some(o => names.includes(o))) marks.push({ x: e.t, color: T.serious, dash: [2, 2] }); });
    if (S.enabled.has('shifts')) ds.shiftEvents.forEach(e => { if (names.includes(e.optode)) marks.push({ x: e.t, color: T.crit, dash: [5, 2] }); });
    const segs = res.motionSegs[ch] ? res.motionSegs[ch].segs.map(([a, b]) => ({ x0: a / ds.fs, x1: b / ds.fs, fill: D.alpha(T.serious, 0.12) })) : [];
    if (!st.pM) st.pM = new D.Plot($('cvMotion'), { height: 220 });
    st.pM.draw({ x: ds.t, xLabel: 'time (s)', yLabel: `ΔOD at ${ds.lambdas[li]} nm (mOD)`, series, vlines: marks, bands: segs, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(2) + ' mOD' });
    ui.legend($('motionLegend'), [{ color: T.muted, label: 'before' }].concat(P.motion !== 'none' ? [{ color: T.accent, label: 'after' }] : [], marks.length ? [{ color: T.serious, label: 'true motion events', dash: true }] : [], segs.length ? [{ color: D.alpha(T.serious, 0.4), label: 'detected as artifact' }] : []));
    const txt = {
      none: 'No correction: every spike and step goes into the averages. Spikes are rare enough that a few trials can be rejected instead; steps shift everything after them.',
      tddr: 'TDDR looks at the derivative of the slow part of the signal. Motion makes a few huge jumps; physiology makes many small ones. Robust weights (Tukey\'s biweight, iterated) shrink the outliers, and integrating the repaired derivative rebuilds the signal. It needs no threshold, but its weights shrink every large change a little, task-locked ones included: compare the averages with and without it.',
      spline: 'Spline interpolation finds stretches where the moving standard deviation jumps above a threshold (shaded), fits a smooth curve to each stretch and subtracts it, then shifts each segment to join the one before. It handles steps well but can only fix what it detects.'
    }[P.motion];
    $('motionText').innerHTML = `<p class="cap">${txt}${marks.length ? ` This channel's optodes (${names.join(', ')}) moved ${marks.length} time${marks.length > 1 ? 's' : ''}.` : ''}</p>`;
  }

  function filt(ch) {
    const ds = S.ds, T = D.theme(), res = S.res, P = S.P, c = ds.chans[ch];
    const dpf = res.conc[ch].dpf;
    const before = NIRS.dsp.mbll(res.odm[ch], ds.lambdas, c.rho, dpf).hbo;
    const wa = NIRS.dsp.welch(before, ds.fs, 120), wb = NIRS.dsp.welch(res.conc[ch].hbo, ds.fs, 120);
    const f = wa.f.subarray(1);
    const resp = Float64Array.from(f, x => NIRS.dsp.response(ds.fs, P.hp, P.lp, x));
    const pmax = Math.max(...wa.p.subarray(1));
    const tf = NIRS.taskFreq(ds), ph = S.cfg.physiology;
    const vl = [];
    if (tf) vl.push({ x: tf, color: T.accent, dash: [4, 3], label: 'task' });
    if (ph.mayer.on) vl.push({ x: ph.mayer.rate, color: T.muted, dash: [2, 3], label: 'Mayer' });
    if (ph.cardiac.on && ph.cardiac.rate < ds.fs / 2) vl.push({ x: ph.cardiac.rate, color: T.muted, dash: [2, 3], label: 'heart' });
    if (!st.pF) st.pF = new D.Plot($('cvFilt'), { height: 220 });
    st.pF.draw({
      x: f, xLog: true, yLog: true, xLabel: 'frequency (Hz)', yLabel: 'HbO power (µM²/Hz)', yRange: [pmax * 1e-7, pmax * 3],
      series: [{ y: wa.p.subarray(1), color: T.muted, label: 'before', width: 1.3 }, { y: wb.p.subarray(1), color: T.hbo, label: 'after', width: 1.4 },
        { y: Float64Array.from(resp, v => Math.max(1e-12, v * pmax)), color: T.accent, dash: [3, 3], width: 1.2, label: 'filter gain (scaled)', noTip: true }],
      vlines: vl.filter(v => v.x > f[0] && v.x < f[f.length - 1]), tipX: x => `${x.toFixed(3)} Hz`, tipFmt: v => v.toExponential(1)
    });
    ui.legend($('filtLegend'), [{ color: T.muted, label: 'before filtering' }, { color: T.hbo, label: 'after' }, { color: T.accent, label: 'filter response', dash: true }]);
    let warn = '';
    if (tf && P.hp && P.hp > tf * 0.5) warn = ` <strong>The high-pass cut-off (${P.hp} Hz) is close to the task frequency (${tf.toFixed(3)} Hz): it is removing the response.</strong>`;
    if (P.lp && ph.mayer.on && P.lp < ph.mayer.rate) warn += ' The low-pass is below the Mayer waves, which also takes the faster part of the response.';
    $('filtText').innerHTML = `<p class="cap">A band-pass keeps what can be haemodynamic: the high-pass removes drift slower than the task, the low-pass removes the heartbeat and breathing.
      Mayer waves near 0.1 Hz overlap the response and survive any filter that keeps it.${warn}</p>`;
  }

  function scr(ch) {
    const ds = S.ds, T = D.theme(), res = S.res, P = S.P, c = ds.chans[ch];
    const sr = res.shortReg[ch], clean = res.clean[ch];
    const series = [{ y: res.conc[ch].hbo, color: T.muted, label: 'long channel', width: 1.2 }];
    let txt;
    if (c.short) txt = 'This is a short channel itself: it is the regressor, not the target. Pick a long channel.';
    else if (!sr) txt = P.short === 'off' ? 'Short-channel regression is off. Switch it on above to remove what the short channels say came from the scalp.' : 'No usable short channel (none in the probe, or all rejected by the quality check).';
    else {
      const b = clean.betaO, mx = NIRS.mean(sr.hbo);
      series.push({ y: Float64Array.from(sr.hbo, v => b * (v - mx)), color: T.det, label: `short channel × ${b.toFixed(2)}`, width: 1.1 });
      series.push({ y: clean.hbo, color: T.hbo, label: 'after regression', width: 1.4 });
      const v0 = NIRS.std(res.conc[ch].hbo), v1 = NIRS.std(clean.hbo);
      const scc = ds.chans.find(x => x.label === sr.from[0]);
      const where = sr.from.length > 1 ? ' (the mean of all good short channels)' : scc && scc.src === c.src ? ` (beside this channel's own source, ${c.s})` : sr.dist !== undefined ? ` (${(sr.dist * 10).toFixed(0)} mm from this channel's nearer optode)` : '';
      txt = `Regressor: ${sr.from.join(', ')}${where}. Weight ${b.toFixed(2)}; correlation of long and short ${NIRS.corr(res.conc[ch].hbo, sr.hbo).toFixed(2)};
        ${(100 * (1 - (v1 * v1) / (v0 * v0))).toFixed(0)}% of the HbO variance removed. ${P.shortMode === 'glm' ? 'The weight was estimated together with a flexible model of the task response, so a cortical response that happens to resemble the scalp signal is not taken away with it.' : 'The weight was estimated before anything else: if the scalp signal is time-locked to the task, the regression also removes the part of the cortical response that resembles it. Compare the averages with "With the task".'}`;
    }
    if (!st.pR) st.pR = new D.Plot($('cvSCR'), { height: 230 });
    st.pR.draw({ x: ds.t, xLabel: 'time (s)', yLabel: 'ΔHbO (µM)', series, bands: D.taskBands(ds, 0, ds.dur), tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + ' µM' });
    ui.legend($('scrLegend'), series.map(s => ({ color: s.color, label: s.label })));
    $('scrText').innerHTML = `<p class="cap">${txt}</p>`;
  }

  NIRS.tabs.processing = {
    init() {
      $('prQual').addEventListener('change', () => { S.P.qualityOn = $('prQual').checked; NIRS.app.run('quality'); });
      const soon = stage => ui.debounce(() => NIRS.app.run(stage), 200);
      const q = soon('quality'), f = soon('filter');
      ctl.sci = ui.range('prSci', v => v.toFixed(2), v => { S.P.sci = v; q(); });
      ctl.cv = ui.range('prCv', v => Math.round(v * 100) + '%', v => { S.P.cv = v; q(); });
      ctl.motion = ui.seg($('prMotionSeg'), v => { S.P.motion = v; NIRS.app.later(() => NIRS.app.run('motion')); });
      ctl.hp = ui.range('prHp', v => (v > 0 ? v.toFixed(3) + ' Hz' : 'off'), v => { S.P.hp = v > 0 ? v : null; f(); });
      const lpOff = v => v >= +$('prLp').max - 1e-9;
      ctl.lp = ui.range('prLp', v => (lpOff(v) ? 'off' : v.toFixed(2) + ' Hz'), v => { S.P.lp = lpOff(v) ? null : v; f(); });
      ctl.short = ui.seg($('prShortSeg'), v => { S.P.short = v; NIRS.app.later(() => NIRS.app.run('short')); });
      ctl.mode = ui.seg($('prShortModeSeg'), v => { S.P.shortMode = v; NIRS.app.later(() => NIRS.app.run('short')); });
    },
    onBuild() {
      const P = S.P;
      $('prQual').checked = P.qualityOn;
      ctl.sci.set(P.sci); ctl.cv.set(Math.min(0.5, P.cv)); ctl.motion.set(P.motion);
      ctl.hp.set(P.hp || 0);
      $('prLp').max = String(+Math.min(2, S.ds.fs / 2 * 0.95).toFixed(2));
      ctl.lp.set(P.lp || +$('prLp').max);
      ctl.short.set(P.short); ctl.mode.set(P.shortMode);
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
