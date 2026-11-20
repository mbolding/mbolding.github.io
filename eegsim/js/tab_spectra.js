/* EEG simulator: the Spectra tab.  Power spectra, band-power maps,
   time-frequency maps and coherence. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui, dsp = EEG.dsp;
  const $ = ui.$, S = EEG.S;
  const st = { psd: null, coh: null, cohF: 10 };
  const BANDS = [[1, 4, 'δ'], [4, 8, 'θ'], [8, 13, 'α'], [13, 30, 'β'], [30, 45, 'γ']];

  function ranges(kind) {
    const ds = S.ds, fs = ds.fs, all = [[0, ds.n]];
    const of = f => ds.blocks.filter(f).map(b => [Math.round(b.t0 * fs), Math.min(ds.n, Math.round(b.t1 * fs))]);
    if (kind === 'closed') return of(b => b.state === 'closed');
    if (kind === 'open') return of(b => b.state === 'open');
    if (kind === 'task') return of(b => b.task);
    return all;
  }
  const hasClosed = () => S.ds.blocks.some(b => b.state === 'closed');
  function series(view, label) {
    if (view === 'raw') { const k = S.rec.labels.indexOf(label); return k >= 0 && k < S.rec.nCap ? S.rec.rows[k] : null; }
    const k = S.filt.labels.indexOf(label); return k >= 0 ? S.clean[k] : null;
  }
  const fmax = () => Math.min(S.ds.fs / 2, 100);

  /* ---------- power spectrum ---------- */
  function drawPSD() {
    const T = D.theme(), fs = S.ds.fs;
    const ch = $('psdCh').value, segKind = $('psdSeg').value, dataKind = $('psdData').value;
    const runs = [];
    const views = dataKind === 'both' ? ['raw', 'proc'] : [dataKind];
    views.forEach(v => {
      const x = series(v, ch);
      if (!x) return;
      const tag = dataKind === 'both' ? (v === 'raw' ? 'as recorded' : 'processed') : '';
      if (segKind === 'eyes') {
        [['closed', T.series[6]], ['open', T.series[2]]].forEach(([k, c]) => {
          const r = ranges(k); if (!r.length) return;
          runs.push({ spec: dsp.welch(x, fs, r), color: c, dash: v === 'raw' && dataKind === 'both' ? [5, 4] : null, label: `eyes ${k}${tag ? ', ' + tag : ''}` });
        });
      } else {
        const r = ranges(segKind === 'task' ? 'task' : 'all');
        if (!r.length) return;
        runs.push({ spec: dsp.welch(x, fs, r), color: v === 'raw' && dataKind === 'both' ? T.muted : T.series[0], dash: v === 'raw' && dataKind === 'both' ? [5, 4] : null, label: tag || (segKind === 'task' ? 'task blocks' : 'whole recording') });
      }
    });
    if (!st.psd) st.psd = new D.Plot($('cvPSD'), { height: 300 });
    const unit = S.filt.unit === 'µV' || $('psdData').value === 'raw' ? 'µV²/Hz' : '(µV/cm²)²/Hz';
    const lineF = S.cfg.recording.mains;
    st.psd.draw({
      series: runs.map(r => ({ x: r.spec.f, y: r.spec.p, color: r.color, dash: r.dash, label: r.label, width: 1.8 })),
      xRange: [0.5, fmax()], yLog: true, xLabel: 'frequency (Hz)', yLabel: 'power density, ' + unit,
      bands: BANDS.filter(b => b[0] < fmax()).map((b, i) => ({ x0: b[0], x1: Math.min(b[1], fmax()), fill: i % 2 ? 'transparent' : T.band, label: b[2] })),
      vlines: lineF < fmax() ? [{ x: lineF, color: T.muted, dash: [2, 3], label: lineF + ' Hz mains' }] : [],
      tipFmt: v => EEG.fmt(v, 2), tipX: x => `${x.toFixed(1)} Hz`
    });
    ui.legend($('psdLegend'), runs.map(r => ({ color: r.color, label: r.label, dash: !!r.dash })));
    if (!runs.length) $('psdLegend').textContent = segKind === 'eyes' ? 'This recording has no eyes-closed or eyes-open blocks.' : 'Nothing to show for this choice.';
  }

  /* ---------- band power map ---------- */
  function drawBand() {
    const cv = $('cvBandTopo');
    if (!S.filt.positions) { const g = D.fit(cv, 60); g.ctx.fillStyle = D.theme().muted; g.ctx.font = D.font(12); g.ctx.fillText('Band maps need a referential montage.', 10, 30); return; }
    const sel = $('bandSel').value, seg = $('bandSeg').value, fs = S.ds.fs;
    const [f0, f1] = sel === 'line' ? [S.cfg.recording.mains - 1, S.cfg.recording.mains + 1] : sel.split(',').map(Number);
    const bp = (k, kind) => { const r = ranges(kind); return r.length ? dsp.bandPower(dsp.welch(S.clean[k], fs, r), f0, f1) : NaN; };
    const labels = S.filt.labels;
    let v, unit, title;
    if (seg === 'ratio') {
      if (!hasClosed()) { const g = D.fit(cv, 60); g.ctx.fillStyle = D.theme().muted; g.ctx.font = D.font(12); g.ctx.fillText('No eyes-closed blocks in this recording.', 10, 30); return; }
      v = labels.map((_, k) => bp(k, 'closed') / bp(k, 'open')); unit = '×'; title = 'eyes closed ÷ eyes open';
    } else {
      v = labels.map((_, k) => bp(k, seg)); unit = S.filt.unit === 'µV' ? 'µV²' : '(µV/cm²)²'; title = seg === 'all' ? 'whole recording' : 'eyes ' + seg;
      if (v.some(x => !isFinite(x))) { const g = D.fit(cv, 60); g.ctx.fillStyle = D.theme().muted; g.ctx.font = D.font(12); g.ctx.fillText(`No eyes-${seg} blocks in this recording.`, 10, 30); return; }
    }
    let mx = 0; v.forEach(x => { if (isFinite(x)) mx = Math.max(mx, x); });
    D.topoCanvas(cv, labels, v, { sequential: true, range: [0, mx || 1], unit, title, maxH: 300, names: labels.length <= 32, fmt: x => EEG.fmt(x, x < 10 ? 1 : 0) });
  }

  /* ---------- time-frequency ---------- */
  function freqs(f0, f1, n) { const a = Math.log(f0), b = Math.log(f1); return Array.from({ length: n }, (_, i) => Math.exp(a + (b - a) * i / (n - 1))); }
  function cyclesFor(fr) { const a = Math.log(fr[0]), b = Math.log(fr[fr.length - 1]); return f => 3 + 6 * (Math.log(f) - a) / (b - a || 1); }
  function drawTFImage(rows, fr, x0, x1, opts) {
    const T = D.theme(), cv = $('cvTF');
    const { ctx, w, h } = D.fit(cv, 300);
    const L = 54, R = w - 70, Y0 = 8, Y1 = h - 34;
    const flip = rows.slice().reverse();
    let lo = Infinity, hi = -Infinity;
    rows.forEach(r => r.forEach(v => { if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    let colorOf, range;
    if (opts.diverging) { range = Math.max(1, Math.min(8, Math.max(Math.abs(lo), Math.abs(hi)))); colorOf = v => D.lutRGB(v / range); }
    else { range = [hi - 35, hi]; colorOf = v => D.lutRGB((v - range[0]) / (range[1] - range[0]), true); }
    D.heat(ctx, L, Y0, R - L, Y1 - Y0, flip, colorOf, true);
    ctx.strokeStyle = T.axis; ctx.strokeRect(L + 0.5, Y0 + 0.5, R - L, Y1 - Y0);
    const sy = f => Y1 - (Math.log(f) - Math.log(fr[0])) / (Math.log(fr[fr.length - 1]) - Math.log(fr[0])) * (Y1 - Y0);
    const sx = t => L + (t - x0) / (x1 - x0) * (R - L);
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [2, 4, 8, 10, 13, 20, 30, 40, 60, 80].filter(f => f >= fr[0] && f <= fr[fr.length - 1]).forEach(f => { ctx.fillText(f, L - 5, sy(f)); });
    ctx.save(); ctx.translate(12, (Y0 + Y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = T.ink2; ctx.font = D.font(11); ctx.fillText('frequency (Hz)', 0, 0); ctx.restore();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = T.muted;
    D.ticks(x0, x1, 8).forEach(t => ctx.fillText(opts.ms ? Math.round(t * 1000) : EEG.fmt(t, t % 1 ? 1 : 0), sx(t), Y1 + 4));
    ctx.fillStyle = T.ink2; ctx.font = D.font(11); ctx.textBaseline = 'bottom'; ctx.fillText(opts.ms ? 'time from stimulus (ms)' : 'time (s)', (L + R) / 2, h - 2);
    (opts.marks || []).forEach(m => {
      const x = sx(m.t); if (x < L || x > R) return;
      ctx.strokeStyle = m.color; ctx.lineWidth = m.width || 1; ctx.setLineDash(m.dash || []); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
      if (m.label) { ctx.fillStyle = T.ink; ctx.font = D.font(10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(m.label, x + 3, Y0 + 2); }
    });
    // colour bar on the right
    const bx = R + 18, bw = 10;
    for (let i = 0; i < Y1 - Y0; i++) {
      const t = 1 - i / (Y1 - Y0);
      const rgb = opts.diverging ? D.lutRGB(2 * t - 1) : D.lutRGB(t, true);
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.fillRect(bx, Y0 + i, bw, 1.5);
    }
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    if (opts.diverging) { ctx.fillText('+' + range.toFixed(1), bx + bw + 3, Y0 + 4); ctx.fillText('0 dB', bx + bw + 3, (Y0 + Y1) / 2); ctx.fillText('−' + range.toFixed(1), bx + bw + 3, Y1 - 4); }
    else { ctx.fillText(range[1].toFixed(0), bx + bw + 3, Y0 + 4); ctx.fillText(range[0].toFixed(0), bx + bw + 3, Y1 - 4); ctx.fillText('dB', bx + bw + 3, (Y0 + Y1) / 2); }
  }
  function drawTF() {
    const mode = $('tfMode').value, ds = S.ds, fs = ds.fs, T = D.theme();
    $('tfStartBox').hidden = $('tfLenBox').hidden = mode !== 'cont';
    $('tfCondBox').hidden = $('tfKindBox').hidden = mode !== 'erp';
    const k = S.filt.labels.indexOf($('tfCh').value);
    if (k < 0) return;
    const x = S.clean[k];
    if (mode === 'cont') {
      const len = Math.min(parseFloat($('tfLen').value), ds.dur);
      $('tfStart').max = Math.max(0, ds.dur - len).toFixed(0);
      const t0 = Math.min(parseFloat($('tfStart').value), ds.dur - len);
      $('tfStartV').textContent = ui.fmtT(t0);
      const fr = freqs(1.5, Math.min(80, fs * 0.4), 40);
      const i0 = Math.round(t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(len * fs));
      const cols = Math.min(700, i1 - i0);
      const P = dsp.tfr(x, fs, i0, i1, fr, cyclesFor(fr), cols).map(r => r.map(v => 10 * Math.log10(v + 1e-12)));
      const marks = [];
      ds.blocks.forEach(b => { if (b.t0 > t0 && b.t0 < t0 + len) marks.push({ t: b.t0, color: T.ink, width: 1.5, dash: [4, 3], label: b.task ? 'trials' : 'eyes ' + b.state }); });
      ds.events.forEach(ev => { if (ev.t > t0 && ev.t < t0 + len && len <= 30) marks.push({ t: ev.t, color: D.alpha(ui.condColor(ev.ci), 0.5) }); });
      drawTFImage(P, fr, t0, t0 + len, { marks });
      $('tfCap').textContent = 'Power in dB (µV²) at each time and frequency. Wavelets widen from 3 cycles at the lowest frequency to 9 at the highest, so low frequencies are sharp in frequency and blurred in time, and high frequencies the reverse. Dashed lines mark block changes; faint lines are stimuli.';
    } else {
      if (!ds.events.length) { const g = D.fit($('cvTF'), 60); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('This recording has no trials.', 10, 30); return; }
      const ci = +$('tfCond').value, kind = $('tfKind').value, E = S.epoch;
      const fr = freqs(2, Math.min(45, fs * 0.4), 28), cyc = cyclesFor(fr);
      const marg = Math.ceil(0.6 * fs), s0 = Math.round(E.t0 * fs), s1 = Math.round(E.t1 * fs), nT = s1 - s0;
      const evs = S.ep.list.filter(e => e.ev.ci === ci && !e.rejected).map(e => e.ev.sample).filter(c => c + s0 - marg >= 0 && c + s1 + marg < ds.n);
      if (!evs.length) return;
      const W = nT + 2 * marg;
      const avg = new Float64Array(W);
      evs.forEach(c => { for (let i = 0; i < W; i++) avg[i] += x[c + s0 - marg + i]; });
      for (let i = 0; i < W; i++) avg[i] /= evs.length;
      const cols = Math.min(240, nT);
      let P;
      if (kind === 'evoked') P = dsp.tfr(avg, fs, marg, marg + nT, fr, cyc, cols);
      else {
        P = fr.map(() => new Float64Array(cols));
        const tmp = new Float64Array(W);
        evs.forEach(c => {
          for (let i = 0; i < W; i++) tmp[i] = x[c + s0 - marg + i] - (kind === 'induced' ? avg[i] : 0);
          const p = dsp.tfr(tmp, fs, marg, marg + nT, fr, cyc, cols);
          p.forEach((r, fi) => { for (let j = 0; j < cols; j++) P[fi][j] += r[j] / evs.length; });
        });
      }
      // dB change from the pre-stimulus baseline
      const nb = Math.max(1, Math.round(cols * (Math.min(0, E.baseline ? E.baseline[1] : 0) - E.t0) / (E.t1 - E.t0)));
      const rows = P.map(r => { let b = 0; for (let j = 0; j < nb; j++) b += r[j]; b /= nb; return Float32Array.from(r, v => 10 * Math.log10((v + 1e-12) / (b + 1e-12))); });
      drawTFImage(rows, fr, E.t0, E.t1, { diverging: true, ms: true, marks: [{ t: 0, color: T.ink, width: 1.5, label: 'stimulus' }] });
      $('tfCap').textContent = `${evs.length} ${ds.conditions[ci]} trials. Colour is the change in power from the pre-stimulus baseline, in dB: red for an increase (synchronization), blue for a decrease (desynchronization). ` +
        ({ total: 'Total power counts everything that changes after the stimulus.', evoked: 'Evoked power is the power of the average: only activity phase-locked to the stimulus survives.', induced: 'Induced power removes the average from every trial first: what is left changes with the stimulus but not in phase with it, like alpha desynchronization.' })[kind];
    }
  }

  /* ---------- coherence ---------- */
  // Coherence of one seed channel with every channel at a single frequency
  // bin, from the same Hann segments Welch uses, by direct DFT of that bin.
  function seedCoherence(rows, a, fs, k) {
    const N = EEG.nextPow2(2 * fs), n = rows[0].length, w = dsp.hann(N);
    const cs = new Float64Array(N), sn = new Float64Array(N);
    for (let i = 0; i < N; i++) { cs[i] = w[i] * Math.cos(2 * Math.PI * k * i / N); sn[i] = -w[i] * Math.sin(2 * Math.PI * k * i / N); }
    const nc = rows.length, sxx = new Float64Array(nc), sxr = new Float64Array(nc), sxi = new Float64Array(nc);
    let saa = 0;
    const bin = (x, s) => { let m = 0; for (let i = 0; i < N; i++) m += x[s + i]; m /= N; let re = 0, im = 0; for (let i = 0; i < N; i++) { const v = x[s + i] - m; re += v * cs[i]; im += v * sn[i]; } return [re, im]; };
    for (let s = 0; s + N <= n; s += N >> 1) {
      const [ar, ai] = bin(rows[a], s);
      saa += ar * ar + ai * ai;
      for (let c = 0; c < nc; c++) {
        const [br, bi] = bin(rows[c], s);
        sxx[c] += br * br + bi * bi; sxr[c] += ar * br + ai * bi; sxi[c] += ai * br - ar * bi;
      }
    }
    const coh = [], icoh = [];
    for (let c = 0; c < nc; c++) { const d = saa * sxx[c]; coh.push(d ? (sxr[c] ** 2 + sxi[c] ** 2) / d : 0); icoh.push(d ? Math.abs(sxi[c]) / Math.sqrt(d) : 0); }
    return { coh, icoh };
  }
  function drawCoh() {
    const T = D.theme(), fs = S.ds.fs, labels = S.filt.labels;
    const a = labels.indexOf($('cohA').value), b = labels.indexOf($('cohB').value);
    if (a < 0 || b < 0) return;
    const R = [[0, S.ds.n]];
    const c = dsp.welch(S.clean[a], fs, R, null, S.clean[b]);
    const fm = Math.min(45, fs / 2);
    const series = [{ x: c.f, y: c.coh, color: T.series[0], label: '|coherence|²' }, { x: c.f, y: Array.from(c.icoh, Math.abs), color: T.series[1], label: '|imaginary coherency|' }];
    const pair = S.ds.gens.filter(g => g.kind === 'source' && S.cfg.sources.find(s => s.name === g.group && s.type === 'pair') && S.enabled.has(g.group));
    if (pair.length === 2) {
      const t = dsp.welch(pair[0].tc, fs, R, null, pair[1].tc);
      series.push({ x: t.f, y: t.coh, color: T.ink2, dash: [5, 4], label: 'true source coherence', width: 1.5 });
    }
    if (!st.coh) st.coh = new D.Plot($('cvCoh'), { height: 260, onClick: f => { st.cohF = EEG.clamp(f, 1, fm); drawCoh(); } });
    st.coh.draw({ series, xRange: [1, fm], yRange: [0, 1.02], xLabel: 'frequency (Hz)  (click to choose the map frequency)', yLabel: 'coherence', vlines: [{ x: st.cohF, color: T.accent, label: st.cohF.toFixed(1) + ' Hz' }], tipX: x => `${x.toFixed(1)} Hz`, tipFmt: v => v.toFixed(2) });
    ui.legend($('cohLegend'), series.map(s => ({ color: s.color, label: s.label, dash: !!s.dash })));
    // seed maps
    const cv = $('cvCohMap');
    if (!S.filt.positions) { const g = D.fit(cv, 60); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('Seed maps need a referential montage.', 10, 30); return; }
    const { coh, icoh } = seedCoherence(S.clean, a, fs, Math.round(st.cohF / c.df));
    const { ctx, w, h } = D.fit(cv, w => Math.min(250, w / 2 + 40));
    const r = Math.min(w / 4, h / 2 - 22) * 0.9;
    const marks = {}; marks[labels[a]] = T.accent;
    D.topo(ctx, w * 0.25, h / 2 + 6, r, labels, coh, { sequential: true, range: [0, 1], marks });
    D.topo(ctx, w * 0.75, h / 2 + 6, r, labels, icoh, { sequential: true, range: [0, Math.max(0.2, ...icoh)], marks });
    ctx.fillStyle = T.ink2; ctx.font = D.font(11, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`|coherence|² with ${labels[a]}, ${st.cohF.toFixed(1)} Hz`, w * 0.25, 2);
    ctx.fillText(`|imaginary coherency|`, w * 0.75, 2);
    $('cohCap').textContent = `Seed maps at ${st.cohF.toFixed(1)} Hz from ${labels[a]} (marked). Ordinary coherence spreads in a broad halo around the seed, because neighbouring electrodes see the same sources. The imaginary part is close to zero near the seed and survives only where there is a real time lag.`;
  }

  function fillChannels() {
    const labels = S.filt.labels;
    const keep = (id, prefs) => {
      const want = st.want && st.want[id], cur = $(id).value;
      ui.fill($(id), ui.chOptions(labels), want && labels.includes(want) ? want : labels.includes(cur) ? cur : ui.pick(labels, prefs));
    };
    keep('psdCh', ['O1', 'Oz', 'O2', 'Pz', 'P7-O1']);
    keep('tfCh', ['O1', 'Oz', 'Pz', 'P7-O1']);
    keep('cohA', ['C3', 'P3', 'O1', 'F7-T7']);
    keep('cohB', ['C4', 'CP1', 'P4', 'O2', 'T7-P7']);
    if (!S.ds.events.length) $('tfMode').value = 'cont';
    ui.fill($('tfCond'), S.ds.conditions.map((c, i) => ({ value: String(i), label: c })), $('tfCond').value || String(Math.max(0, S.ds.conditions.length - 1)));
    $('psdSeg').value = $('psdSeg').value === 'eyes' && !hasClosed() ? 'all' : $('psdSeg').value;
    st.want = null;
  }

  function render() {
    if (!S.ds) return;
    fillChannels();
    drawPSD(); drawBand(); drawTF(); drawCoh();
  }

  EEG.tabs.spectra = {
    init() {
      ['psdCh', 'psdSeg', 'psdData'].forEach(id => $(id).addEventListener('change', drawPSD));
      ['bandSel', 'bandSeg'].forEach(id => $(id).addEventListener('change', drawBand));
      ['tfCh', 'tfMode', 'tfLen', 'tfCond', 'tfKind'].forEach(id => $(id).addEventListener('change', () => EEG.app.later(drawTF)));
      $('tfStart').addEventListener('input', ui.debounce(drawTF, 80));
      ['cohA', 'cohB'].forEach(id => $(id).addEventListener('change', () => EEG.app.later(drawCoh)));
    },
    onBuild() {
      const hasEyes = S.ds.blocks.some(b => b.state === 'closed');
      $('psdSeg').value = hasEyes ? 'eyes' : (S.ds.events.length ? 'task' : 'all');
      $('bandSeg').value = hasEyes ? 'ratio' : 'all';
      $('tfMode').value = S.ds.events.length && !hasEyes ? 'erp' : 'cont';
      $('tfStart').value = 0;
      const pair = S.cfg.sources.find(s => s.type === 'pair');
      st.cohF = pair ? pair.freq : 10;
      // Start where the sources are: a pair's first electrode and its nearest neighbour,
      // so the volume-conduction halo is the first thing on screen.
      st.want = {};
      const caps = S.ds.capLabels;
      const focus = S.cfg.sources.find(s => s.type !== 'erp' && s.type !== 'alpha');
      const at = focus ? (focus.dipoles ? focus.dipoles[0].at : focus.at) : null;
      if (at && caps.includes(at)) {
        st.want.psdCh = st.want.tfCh = at;
        const u = EEG.ELEC[at];
        const nb = caps.filter(l => l !== at).sort((p, q) => EEG.v3.dot(EEG.ELEC[q], u) - EEG.v3.dot(EEG.ELEC[p], u))[0];
        st.want.cohA = at; st.want.cohB = nb;
      }
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
