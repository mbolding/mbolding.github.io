/* fNIRS simulator: the Recording tab.  Raw intensities at each
   wavelength, unprocessed haemoglobin, a channel map, the spectrum and an
   overview of every channel. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { unit: 'pct', metric: 'intensity', conc: null, v: -1 };
  let ctl = {};

  function conc() {
    if (st.v !== S.version) { st.conc = NIRS.pipeline.quickConc(S.ds, S.rec, S.P); st.v = S.version; }
    return st.conc;
  }

  function render() {
    if (!S.ds) return;
    const ds = S.ds, T = D.theme(), ch = ui.chSelect($('recCh'));
    const C = conc();
    const win = Math.min(ctl.win.get(), ds.dur);
    $('recT').max = String(Math.max(0, Math.floor(ds.dur - win)));
    const t0 = Math.min(ctl.t.get(), Math.max(0, ds.dur - win)), t1 = t0 + win;
    const i0 = Math.max(0, Math.floor(t0 * ds.fs)), i1 = Math.min(ds.n, Math.ceil(t1 * ds.fs));
    const t = ds.t.subarray(i0, i1);
    const bands = D.taskBands(ds, t0, t1), ev = D.eventLines(ds, t0, t1);
    const I = S.rec.I[ch];
    const series = ds.lambdas.map((l, li) => {
      const m = NIRS.mean(I[li]);
      return { y: st.unit === 'pct' ? Float64Array.from(I[li].subarray(i0, i1), v => 100 * (v / m - 1)) : I[li].subarray(i0, i1), color: ui.lambdaColor(li), label: l + ' nm', width: 1.2 };
    });
    if (!st.pI) st.pI = new D.Plot($('cvRecI'), { height: 210, margin: [12, 14, 36, 62] });
    st.pI.draw({
      x: t, xLabel: 'time (s)', yLabel: st.unit === 'pct' ? 'intensity (% of mean)' : 'detected power', yLog: st.unit !== 'pct',
      yFmt: st.unit === 'pct' ? undefined : v => NIRS.fmtPower(v), series, bands, vlines: ev,
      tipX: x => ui.fmtT(x), tipFmt: st.unit === 'pct' ? v => v.toFixed(2) + '%' : v => NIRS.fmtPower(v)
    });
    ui.legend($('recILegend'), ds.lambdas.map((l, li) => ({ color: ui.lambdaColor(li), label: `${l} nm (mean ${NIRS.fmtPower(NIRS.mean(I[li]))})` })));
    if (!st.pH) st.pH = new D.Plot($('cvRecHb'), { height: 210, margin: [12, 14, 36, 62] });
    st.pH.draw({
      x: t, xLabel: 'time (s)', yLabel: 'Δ concentration (µM)',
      series: [{ y: C[ch].hbo.subarray(i0, i1), color: T.hbo, label: 'HbO', width: 1.3 }, { y: C[ch].hbr.subarray(i0, i1), color: T.hbr, label: 'HbR', width: 1.3 }],
      bands, vlines: ev, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + ' µM'
    });
    ui.legend($('recHbLegend'), [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }].concat(ds.conditions.map((c, i) => ({ color: D.alpha(ui.condColor(i), 0.45), label: c }))));
    // channel map
    const q = S.res.quality;
    let vals, range, fmt, title;
    if (st.metric === 'intensity') { vals = ds.chans.map((c, i) => Math.log10(Math.max(1e-6, q[i].mean[ds.nL - 1]))); fmt = v => NIRS.fmtPower(Math.pow(10, v)); title = `detected light at ${ds.lambdas[ds.nL - 1]} nm (log scale)`; }
    else if (st.metric === 'sci') { vals = q.map(x => x.sci); range = [0, 1]; fmt = v => v.toFixed(2); title = 'scalp coupling index'; }
    else { vals = C.map(c => NIRS.std(c.hbo)); fmt = v => v.toFixed(3) + ' µM'; title = 'SD of unprocessed HbO'; }
    if (!range) {
      // scale to the long channels; short ones, far brighter, sit at the top of the scale
      let lo = Infinity, hi = -Infinity;
      vals.forEach((v, i) => { if (isFinite(v) && !ds.chans[i].short) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      if (!isFinite(lo)) vals.forEach(v => { if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      if (st.metric === 'intensity') lo = Math.min(lo, hi - 1);
      range = [lo, hi > lo ? hi : lo + 1];
    }
    const g = D.fit($('cvRecMap'), w => Math.min(300, w * 0.66));
    st.map = D.probeMap(g.ctx, ds, { x: 4, y: 18, w: g.w - 8, h: g.h - 22 }, { values: vals, sequential: true, range, selected: ch, bad: S.res.bad });
    g.ctx.fillStyle = T.ink2; g.ctx.font = D.font(10); g.ctx.textAlign = 'left'; g.ctx.textBaseline = 'top'; g.ctx.fillText(title, 6, 2);
    st.vals = vals; st.fmt = fmt;
    D.bindProbe($('cvRecMap'), () => st.map, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); }, ci => `${S.ds.chans[ci].label}: ${st.fmt(st.vals[ci])}${S.res.bad.has(ci) ? ' (rejected: ' + S.res.quality[ci].reasons.join('; ') + ')' : ''}`);
    ui.legend($('recMapLegend'), [{ color: D.seqColor(0.15), label: fmt(range[0]) }, { color: D.seqColor(0.9), label: fmt(range[1]) }, { color: T.crit, label: 'rejected by the quality check', dot: true }]);
    // spectrum of optical density
    const sp = ds.lambdas.map(li0 => null);
    const specs = ds.lambdas.map((l, li) => NIRS.dsp.welch(S.res.od[ch][li], ds.fs, 100));
    const f = specs[0].f.subarray(1);
    const ph = S.cfg.physiology, vl = [];
    const nyq = ds.fs / 2;
    const alias = fr => { let a = fr % ds.fs; if (a > nyq) a = ds.fs - a; return a; };
    if (ph.cardiac.on) { const a = alias(ph.cardiac.rate); vl.push({ x: a, color: T.muted, dash: [2, 3], label: a < ph.cardiac.rate - 0.01 ? 'heart (aliased)' : 'heart' }); }
    if (ph.respiration.on) vl.push({ x: alias(ph.respiration.rate), color: T.muted, dash: [2, 3], label: 'breath' });
    if (ph.mayer.on) vl.push({ x: ph.mayer.rate, color: T.muted, dash: [2, 3], label: 'Mayer' });
    const tf = NIRS.taskFreq(ds); if (tf) vl.push({ x: tf, color: T.accent, dash: [4, 3], label: 'task' });
    if (!st.pS) st.pS = new D.Plot($('cvRecSpec'), { height: 210 });
    st.pS.draw({
      x: f, xLog: true, yLog: true, xLabel: 'frequency (Hz)', yLabel: 'OD power (1/Hz)',
      series: specs.map((s, li) => ({ y: s.p.subarray(1), color: ui.lambdaColor(li), label: ds.lambdas[li] + ' nm', width: 1.4 })),
      vlines: vl.filter(v => v.x > f[0] && v.x < f[f.length - 1]), tipX: x => `${x.toFixed(3)} Hz`, tipFmt: v => v.toExponential(1)
    });
    ui.legend($('recSpecLegend'), ds.lambdas.map((l, li) => ({ color: ui.lambdaColor(li), label: l + ' nm' })).concat([{ color: T.muted, label: 'physiological rates', dash: true }]));
    stack(C);
  }

  function stack(C) {
    const ds = S.ds, T = D.theme();
    const n = ds.chans.length;
    const g = D.fit($('cvRecStack'), Math.max(230, 22 * n + 44));
    const ctx = g.ctx, L = 74, R = g.w - 10, top = 8, bottom = g.h - 36, rowH = (bottom - top) / n;
    const sx = t => L + t / ds.dur * (R - L);
    ds.blocks.forEach(b => { if (b.kind !== 'task') return; ctx.fillStyle = D.alpha(ui.condColor(b.ci), T.dark ? 0.15 : 0.09); ctx.fillRect(sx(b.t0), top, sx(b.t1) - sx(b.t0), bottom - top); });
    ds.events.forEach(e => { if (e.dur >= 3) return; ctx.strokeStyle = D.alpha(ui.condColor(e.ci), 0.4); ctx.beginPath(); ctx.moveTo(sx(e.t), top); ctx.lineTo(sx(e.t), bottom); ctx.stroke(); });
    // a 1 s moving average hides the heartbeat so the slow signals show
    if (st.smV !== S.version) {
      const w = Math.max(1, Math.round(ds.fs));
      st.sm = C.map(c => { const x = c.hbo, out = new Float64Array(x.length); let acc = 0; for (let k = 0; k < x.length; k++) { acc += x[k]; if (k >= w) acc -= x[k - w]; out[k] = acc / Math.min(k + 1, w); } return out; });
      st.smV = S.version;
    }
    const sm = st.sm;
    // one common scale so channels can be compared; robust to a few wild ones
    const sds = sm.map(x => NIRS.std(x)).sort((a, b) => a - b);
    const scale = (sds[Math.floor(sds.length / 2)] || 1) * 4;
    const step = Math.max(1, Math.floor(ds.n / ((R - L) * 2)));
    ds.chans.forEach((c, i) => {
      const y0 = top + (i + 0.5) * rowH, bad = S.res.bad.has(i);
      ctx.fillStyle = i === S.selCh ? T.ink : bad ? T.crit : T.ink2; ctx.font = D.font(10, i === S.selCh ? 700 : 400); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(c.label + (c.short ? ' s' : ''), L - 6, y0);
      ctx.save(); ctx.beginPath(); ctx.rect(L, top + i * rowH, R - L, rowH); ctx.clip();
      ctx.strokeStyle = bad ? D.alpha(T.muted, 0.6) : T.hbo; ctx.lineWidth = 1; ctx.beginPath();
      const x = sm[i], m = NIRS.mean(x);
      for (let k = 0; k < ds.n; k += step) { const X = sx(k / ds.fs), Y = y0 - (x[k] - m) / scale * rowH * 0.5; k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
      ctx.stroke(); ctx.restore();
    });
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    D.ticks(0, ds.dur, 8).forEach(tt => ctx.fillText(Math.round(tt) + ' s', sx(tt), bottom + 4));
    ctx.textAlign = 'right'; ctx.fillText(`1 s moving average · each row ±${(scale / 2).toFixed(2)} µM · s: short channel · red label: rejected`, R, g.h - 14);
    if (!st.stackBound) {
      st.stackBound = true;
      $('cvRecStack').addEventListener('click', e => {
        const r = $('cvRecStack').getBoundingClientRect(), y = e.clientY - r.top;
        const i = Math.floor((y - 8) / ((r.height - 44) / S.ds.chans.length));
        if (i >= 0 && i < S.ds.chans.length) { S.selCh = i; NIRS.app.markAll(); }
      });
    }
  }

  NIRS.tabs.recording = {
    init() {
      ctl.t = ui.range('recT', v => ui.fmtT(v), render);
      ctl.win = ui.range('recWin', v => v + ' s', render);
      ui.seg($('recUnitSeg'), v => { st.unit = v; render(); });
      ui.seg($('recMapSeg'), v => { st.metric = v; render(); });
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
