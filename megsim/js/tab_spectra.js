/* MEG simulator: the Spectra tab.  Amplitude spectral density against the
   sensor noise floor, band-power maps over the helmet, and time-frequency
   maps of the continuous recording or around the stimuli. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S, dsp = MEG.dsp;
  const $ = ui.$;
  const st = { psd: null };
  const BANDS = [[1, 4, 'δ'], [4, 8, 'θ'], [8, 13, 'α'], [13, 30, 'β'], [30, 45, 'γ']];

  function ranges(kind) {
    const ds = S.ds, fs = ds.fs;
    const of = f => ds.blocks.filter(f).map(b => [Math.round(b.t0 * fs), Math.min(ds.n, Math.round(b.t1 * fs))]);
    if (kind === 'closed') return of(b => b.state === 'closed');
    if (kind === 'open') return of(b => b.state === 'open');
    if (kind === 'task') return of(b => b.task);
    return [[0, ds.n]];
  }
  // A segment length that fits every range: long enough to resolve 0.1 Hz when it can.
  function segLen(rs) {
    const fs = S.ds.fs; let N = MEG.nextPow2(8 * fs);
    const shortest = Math.min(...rs.map(([a, b]) => b - a));
    while (N > 256 && N > shortest) N >>= 1;
    return N;
  }
  const dataRows = v => v === 'raw' ? S.rec.rows : v === 'sup' ? S.sup.rows : S.clean;
  const VIEW_LABEL = { raw: 'as recorded', sup: 'noise rejected', proc: 'processed' };

  /* ---------- the amplitude spectrum ---------- */
  function spectrum(rows, ch, rs) {
    const fs = S.ds.fs, N = segLen(rs);
    if (ch !== 'mean') return dsp.welch(rows[+ch], fs, rs, N);
    const idx = ui.chans(), acc = { f: null, p: null };
    idx.forEach(c => { const s = dsp.welch(rows[c], fs, rs, N); if (!acc.p) { acc.f = s.f; acc.p = new Float64Array(s.p.length); } for (let k = 0; k < s.p.length; k++) acc.p[k] += s.p[k] / idx.length; });
    return acc;
  }
  function drawPSD() {
    const T = D.theme(), ds = S.ds, fs = ds.fs, arr = ds.array;
    const ch = $('psdCh').value, segKind = $('psdSeg').value, dataKind = $('psdData').value;
    const unit = ch === 'mean' ? ui.unitOf(arr.main) : arr.channels[+ch].unit;
    const runs = [];
    const views = dataKind === 'both' ? ['raw', 'sup'] : [dataKind];
    views.forEach(v => {
      const rows = dataRows(v);
      const tag = dataKind === 'both' ? VIEW_LABEL[v] : '';
      const dash = dataKind === 'both' && v === 'raw' ? [5, 4] : null;
      if (segKind === 'eyes') {
        [['closed', T.series[6]], ['open', T.series[2]]].forEach(([k, c]) => {
          const r = ranges(k); if (!r.length) return;
          runs.push({ spec: spectrum(rows, ch, r), color: c, dash, label: `eyes ${k}${tag ? ', ' + tag : ''}` });
        });
      } else {
        const r = ranges(segKind === 'task' ? 'task' : 'all'); if (!r.length) return;
        runs.push({ spec: spectrum(rows, ch, r), color: dash ? T.muted : T.series[0], dash, label: tag || (segKind === 'task' ? 'task blocks' : 'whole recording') });
      }
    });
    const floor = MEG.chanNoise(arr, ch === 'mean' ? arr.channels[ui.chans()[0]] : arr.channels[+ch], S.cfg.recording.noise);
    const fmax = Math.min(fs / 2, 250);
    if (!st.psd) st.psd = new D.Plot($('cvPSD'), { height: 320 });
    const lineF = S.cfg.recording.mains;
    const fmin = Math.max(0.1, runs.length ? runs[0].spec.f[1] : 0.1);
    let top = floor * 10;
    runs.forEach(r => r.spec.p.forEach((p, k) => { if (r.spec.f[k] >= fmin && r.spec.f[k] <= fmax) top = Math.max(top, Math.sqrt(p)); }));
    st.psd.draw({
      yRange: [floor / 20, top * 1.6],
      series: runs.map(r => ({ x: r.spec.f, y: Float64Array.from(r.spec.p, Math.sqrt), color: r.color, dash: r.dash, label: r.label, width: 1.5 })),
      xRange: [fmin, fmax], xLog: true, yLog: true, xLabel: 'frequency (Hz)', yLabel: `amplitude (${unit}/√Hz)`,
      bands: BANDS.filter(b => b[0] < fmax).map((b, i) => ({ x0: b[0], x1: Math.min(b[1], fmax), fill: i % 2 ? 'transparent' : T.band, label: b[2] })),
      hlines: [{ y: floor, color: T.muted, dash: [4, 4], label: `sensor noise ${floor} ${unit}/√Hz` }],
      vlines: lineF < fmax ? [{ x: lineF, color: T.muted, dash: [2, 3], label: lineF + ' Hz mains' }] : [],
      tipFmt: v => MEG.fmt(v, v < 10 ? 1 : 0) + ` ${unit}/√Hz`, tipX: x => `${x.toFixed(x < 2 ? 2 : 1)} Hz`
    });
    ui.legend($('psdLegend'), runs.map(r => ({ color: r.color, label: r.label, dash: !!r.dash })).concat([{ color: T.muted, label: 'white sensor noise', dash: true }]));
    if (!runs.length) $('psdLegend').textContent = segKind === 'eyes' ? 'This recording has no eyes-closed or eyes-open blocks.' : 'Nothing to show for this choice.';
  }

  /* ---------- band power map ---------- */
  function drawBand() {
    const cv = $('cvBandTopo'), ds = S.ds, arr = ds.array, fs = ds.fs;
    const sel = $('bandSel').value, seg = $('bandSeg').value;
    const [f0, f1] = sel === 'line' ? [S.cfg.recording.mains - 1, S.cfg.recording.mains + 1] : sel.split(',').map(Number);
    const rows = S.sup.rows;
    const bp = (c, kind) => { const r = ranges(kind); return r.length ? dsp.bandPower(dsp.welch(rows[c], fs, r, segLen(r)), f0, f1) : NaN; };
    const sitePower = kind => Float64Array.from(MEG.SITES, (_, si) => {
      const list = arr.siteChannels[si].filter(c => arr.channels[c].kind === arr.main);
      return list.reduce((a, c) => a + bp(c, kind), 0);
    });
    const unit = ui.unitOf(arr.main);
    let v, title, u;
    if (seg === 'ratio') {
      if (!ds.blocks.some(b => b.state === 'closed') || !ds.blocks.some(b => b.state === 'open')) { D.message(cv, 'This recording needs both eyes-closed and eyes-open blocks.'); return; }
      const a = sitePower('closed'), b = sitePower('open');
      v = a.map((x, i) => x / b[i]); u = '×'; title = 'eyes closed ÷ eyes open';
    } else {
      v = sitePower(seg); u = `${unit}²`; title = seg === 'all' ? 'whole recording' : 'eyes ' + seg;
      if (Array.prototype.some.call(v, x => !isFinite(x))) { D.message(cv, `No eyes-${seg} blocks in this recording.`); return; }
    }
    let mx = 0; v.forEach(x => { if (isFinite(x)) mx = Math.max(mx, x); });
    D.topoCanvas(cv, D.sites(), v, { sequential: true, range: [0, mx || 1], unit: u, title: `${title}${arr.type === 'planar' ? ', both gradiometers' : ''}`, maxH: 300, fmt: x => MEG.fmt(x, x < 10 ? 1 : 0), floor0: true });
  }

  /* ---------- time-frequency ---------- */
  function freqs(f0, f1, n) { const a = Math.log(f0), b = Math.log(f1); return Array.from({ length: n }, (_, i) => Math.exp(a + (b - a) * i / (n - 1))); }
  function cyclesFor(fr) { const a = Math.log(fr[0]), b = Math.log(fr[fr.length - 1]); return f => 3 + 6 * (Math.log(f) - a) / (b - a || 1); }
  function drawTFImage(rows, fr, x0, x1, opts) {
    const T = D.theme(), cv = $('cvTF');
    const { ctx, w, h } = D.fit(cv, 300);
    const L = 54, R = w - 76, Y0 = 8, Y1 = h - 34;
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
    D.ticks(x0, x1, 8).forEach(t => ctx.fillText(opts.ms ? Math.round(t * 1000) : MEG.fmt(t, t % 1 ? 1 : 0), sx(t), Y1 + 4));
    ctx.fillStyle = T.ink2; ctx.font = D.font(11); ctx.textBaseline = 'bottom'; ctx.fillText(opts.ms ? 'time from stimulus (ms)' : 'time (s)', (L + R) / 2, h - 2);
    (opts.marks || []).forEach(m => {
      const x = sx(m.t); if (x < L || x > R) return;
      ctx.strokeStyle = m.color; ctx.lineWidth = m.width || 1; ctx.setLineDash(m.dash || []); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
      if (m.label) D.label(ctx, m.label, x + 3, Y0 + 8, { size: 10, weight: 600 });
    });
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
    const mode = $('tfMode').value, ds = S.ds, fs = ds.fs, T = D.theme(), arr = ds.array;
    $('tfStartBox').hidden = $('tfLenBox').hidden = mode !== 'cont';
    $('tfCondBox').hidden = $('tfKindBox').hidden = mode !== 'erp';
    const k = parseInt($('tfCh').value, 10);
    if (!(k >= 0)) return;
    const x = S.clean[k], unit = arr.channels[k].unit;
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
      $('tfCap').textContent = `Power in dB (re 1 ${unit}²) at each time and frequency, processed data. Wavelets widen from 3 cycles at the lowest frequency to 9 at the highest, so low frequencies are sharp in frequency and blurred in time, and high frequencies the reverse. Dashed lines mark block changes; faint lines are stimuli.`;
    } else {
      if (!ds.events.length) { D.message($('cvTF'), 'This recording has no trials.'); return; }
      const ci = +$('tfCond').value, kind = $('tfKind').value, E = S.epoch;
      const fr = freqs(2, Math.min(45, fs * 0.4), 28), cyc = cyclesFor(fr);
      const marg = Math.ceil(0.6 * fs), s0 = Math.round(E.t0 * fs), s1 = Math.round(E.t1 * fs), nT = s1 - s0;
      const evs = S.ep.list.filter(e => e.ev.ci === ci && !e.rejected).map(e => e.ev.sample).filter(c => c + s0 - marg >= 0 && c + s1 + marg < ds.n);
      if (!evs.length) { D.message($('cvTF'), 'No accepted trials for this condition.'); return; }
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
      const nb = Math.max(1, Math.round(cols * (Math.min(0, E.baseline ? E.baseline[1] : 0) - E.t0) / (E.t1 - E.t0)));
      const rows = P.map(r => { let b = 0; for (let j = 0; j < nb; j++) b += r[j]; b /= nb; return Float32Array.from(r, v => 10 * Math.log10((v + 1e-12) / (b + 1e-12))); });
      drawTFImage(rows, fr, E.t0, E.t1, { diverging: true, ms: true, marks: [{ t: 0, color: T.ink, width: 1.5, label: 'stimulus' }] });
      $('tfCap').textContent = `${evs.length} ${ds.conditions[ci]} trials. Colour is the change in power from the pre-stimulus baseline, in dB: red for an increase (synchronization), blue for a decrease (desynchronization). ` +
        ({ total: 'Total power counts everything that changes after the stimulus.', evoked: 'Evoked power is the power of the average: only activity phase-locked to the stimulus survives.', induced: 'Induced power removes the average from every trial first: what is left changes with the stimulus but not in phase with it, like the beta drop and rebound over the motor cortex.' })[kind] +
        (E.t1 - E.t0 < 0.8 ? ' A longer epoch (Averaging tab) shows slower changes.' : '');
    }
  }

  // The channel where the rhythms are: alpha or beta generators first, then any source.
  function rhythmChannel() {
    const ds = S.ds, list = ui.chans();
    const gens = ds.gens.filter(g => g.kind === 'source' && (g.rhythm || (S.cfg.sources.find(s => s.name === g.group) || {}).type === 'alpha'));
    if (!gens.length) return ui.bestChannel();
    let best = list[0], bv = -1;
    list.forEach(c => { let s = 0; gens.forEach(g => { s += Math.abs(MEG.genPattern(ds, g)[c]); }); if (s > bv) { bv = s; best = c; } });
    return best;
  }

  function render() {
    if (!S.ds) return;
    const arr = S.ds.array, ds = S.ds;
    const opts = [{ value: 'mean', label: `Mean over the ${MEG.KIND_LABEL[arr.main]}` }].concat(arr.channels.map((c, i) => ({ value: String(i), label: c.name })));
    const keep = st.arrType === arr.type && st.build === S.cfg;
    const cur = $('psdCh').value;
    ui.fill($('psdCh'), opts, keep && opts.some(o => o.value === cur) ? cur : String(rhythmChannel()));
    const tc = $('tfCh').value;
    ui.fill($('tfCh'), opts.slice(1), keep && opts.some(o => o.value === tc) ? tc : String(rhythmChannel()));
    ui.fill($('tfCond'), ds.conditions.map((c, i) => ({ value: String(i), label: c })), $('tfCond').value || '0');
    if (!keep) {
      $('psdSeg').value = ds.blocks.some(b => b.state === 'closed') && ds.blocks.some(b => b.state === 'open') ? 'eyes' : 'all';
      $('bandSeg').value = $('psdSeg').value === 'eyes' ? 'ratio' : 'all';
      const cb = ds.blocks.find(b => b.state === 'closed');
      $('tfStart').value = cb ? Math.max(0, Math.floor(cb.t1 - 15)) : 0;
    }
    st.arrType = arr.type; st.build = S.cfg;
    drawPSD(); drawBand(); drawTF();
  }

  MEG.tabs.spectra = {
    init() {
      ['psdCh', 'psdSeg', 'psdData'].forEach(id => $(id).addEventListener('change', drawPSD));
      ['bandSel', 'bandSeg'].forEach(id => $(id).addEventListener('change', drawBand));
      ['tfCh', 'tfMode', 'tfLen', 'tfCond', 'tfKind'].forEach(id => $(id).addEventListener('change', drawTF));
      $('tfStart').addEventListener('input', ui.debounce(drawTF, 80));
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
