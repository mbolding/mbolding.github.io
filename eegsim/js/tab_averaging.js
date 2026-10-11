/* EEG simulator: the ERP averaging tab.  The average emerging from the
   noise trial by trial, signal to noise against the square root of N, an
   ERP image, and scalp maps at a chosen latency. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui;
  const $ = ui.$, S = EEG.S;
  const st = { N: 1, playing: false, lat: null, shown: null, plots: {} };

  function chIndex() { return S.filt.labels.indexOf($('avgCh').value); }
  function accepted(ci) { return S.ep.list.filter(e => e.ev.ci === ci && !e.rejected); }
  function diffPair() {
    const c = S.ds.conditions;
    if (c.length < 2) return null;
    const n = c.map((_, i) => S.ds.events.filter(e => e.ci === i).length);
    const [a, b] = n[0] === n[1] ? [0, 1] : (n[0] < n[1] ? [0, 1] : [1, 0]);
    return { a, b, label: `${c[a]} − ${c[b]}` };
  }
  // The condition whose true ERP is largest at this channel, for the SNR plot.
  function focusCond(k, truth) {
    if (!truth || !truth.filt) return 0;
    let best = 0, bm = -1;
    truth.filt.forEach((c, i) => { let m = 0; for (let t = 0; t < c.nT; t++) if (c.times[t] > 0) m = Math.max(m, Math.abs(c.data[k * c.nT + t])); if (m > bm && accepted(i).length) { bm = m; best = i; } });
    return best;
  }

  function cumulative(ci, k) {
    const eps = accepted(ci), nT = S.ep.nT, out = [new Float64Array(nT)];
    eps.forEach((e, j) => { const prev = out[j], cur = new Float64Array(nT); for (let t = 0; t < nT; t++) cur[t] = prev[t] + e.data[k * nT + t]; out.push(cur); });
    return { cum: out, eps };
  }
  const avgAt = (cum, n) => { const c = cum[n], nT = c.length, a = new Float64Array(nT); for (let t = 0; t < nT; t++) a[t] = c[t] / Math.max(1, n); return a; };

  function drawERP() {
    const T = D.theme(), ep = S.ep, k = chIndex();
    if (k < 0) return;
    const truth = EEG.app.truth();
    const times = Array.from(ep.times, t => t * 1000);
    const conds = S.ds.conditions;
    const series = [], marks = [];
    const neg = $('avgNeg').checked;
    st.cums = {};
    conds.forEach((c, ci) => {
      if (!st.shown.has(ci)) return;
      const col = ui.condColor(ci);
      const { cum, eps } = cumulative(ci, k);
      st.cums[ci] = cum;
      const n = Math.min(st.N, eps.length);
      if (!n) return;
      if ($('avgSingle').checked) series.push({ y: Array.from(eps[n - 1].data.subarray(k * ep.nT, (k + 1) * ep.nT)), color: col, alpha: 0.28, width: 1, label: `${c}: trial ${n}`, noTip: true });
      if ($('avgTruthRaw').checked && truth.raw) series.push({ y: Array.from(truth.raw[ci].data.subarray(k * ep.nT, (k + 1) * ep.nT)), color: col, dash: [1.5, 3], width: 1.5, label: `${c}: true, unfiltered` });
      if ($('avgTruth').checked && truth.filt) series.push({ y: Array.from(truth.filt[ci].data.subarray(k * ep.nT, (k + 1) * ep.nT)), color: col, dash: [6, 4], width: 1.5, label: `${c}: true, same filters` });
      series.push({ y: Array.from(avgAt(cum, n)), color: col, width: 2.2, label: `${c}: average of ${n}` });
    });
    const dp = diffPair();
    if ($('avgDiff').checked && dp && st.cums[dp.a] && st.cums[dp.b]) {
      const na = Math.min(st.N, st.cums[dp.a].length - 1), nb = Math.min(st.N, st.cums[dp.b].length - 1);
      if (na && nb) { const a = avgAt(st.cums[dp.a], na), b = avgAt(st.cums[dp.b], nb); series.push({ y: Array.from(a, (v, i) => v - b[i]), color: T.ink, width: 1.8, label: dp.label }); }
    }
    if (!st.plots.erp) st.plots.erp = new D.Plot($('cvERP'), { height: 320, onClick: x => { st.lat = x; drawERP(); drawTopos(); } });
    const E = S.epoch;
    st.plots.erp.draw({
      x: times, series, xLabel: 'time from stimulus (ms)', yLabel: `${S.filt.labels[k]} (${S.filt.unit})${neg ? ', negative up' : ''}`, invertY: neg,
      bands: E.baseline ? [{ x0: E.baseline[0] * 1000, x1: E.baseline[1] * 1000, fill: T.band, label: 'baseline' }] : [],
      vlines: [{ x: 0, color: T.muted }].concat(st.lat !== null ? [{ x: st.lat, color: T.accent, label: Math.round(st.lat) + ' ms' }] : []),
      tipX: x => `${x.toFixed(0)} ms`, tipFmt: v => v.toFixed(2)
    });
    const leg = [];
    conds.forEach((c, ci) => { if (st.shown.has(ci)) leg.push({ color: ui.condColor(ci), label: c }); });
    leg.push({ color: T.ink2, label: 'true ERP through the same filters', dash: true });
    if ($('avgDiff').checked && dp) leg.push({ color: T.ink, label: dp.label });
    ui.legend($('erpLegend'), leg);
    drawSNR(k, truth);
  }

  function drawSNR(k, truth) {
    const T = D.theme(), ep = S.ep, cv = $('cvSNR');
    if (!truth.filt) { const g = D.fit(cv, 80); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('This program has no ERP sources, so there is no true signal to measure against.', 8, 30); ui.legend($('snrLegend'), []); st.snr = null; return; }
    const ci = focusCond(k, truth);
    const { cum } = st.cums[ci] ? { cum: st.cums[ci] } : cumulative(ci, k);
    const tr = truth.filt[ci].data.subarray(k * ep.nT, (k + 1) * ep.nT);
    const nT = ep.nT, zero = ep.zero, E = S.epoch;
    let sig = 0; for (let t = zero; t < nT; t++) sig = Math.max(sig, Math.abs(tr[t]));
    const b0 = E.baseline ? EEG.clamp(Math.round((E.baseline[0] - E.t0) * S.ds.fs), 0, nT - 1) : 0, b1 = Math.max(b0 + 2, zero);
    const Ns = [], snrB = [], snrT = [];
    for (let n = 1; n < cum.length; n++) {
      const a = avgAt(cum, n);
      let sb = 0, mb = 0; for (let t = b0; t < b1; t++) mb += a[t]; mb /= (b1 - b0);
      for (let t = b0; t < b1; t++) sb += (a[t] - mb) ** 2;
      let stt = 0; for (let t = 0; t < nT; t++) stt += (a[t] - tr[t]) ** 2;
      Ns.push(n); snrB.push(sig / Math.sqrt(sb / (b1 - b0))); snrT.push(sig / Math.sqrt(stt / nT));
    }
    if (!Ns.length) return;
    // a line of slope 1/2 fitted to the truth-based estimate
    let a = 0; Ns.forEach((n, i) => { a += Math.log(snrT[i]) - 0.5 * Math.log(n); }); a = Math.exp(a / Ns.length);
    const theory = Ns.map(n => a * Math.sqrt(n));
    const curN = Math.min(st.N, Ns.length);
    if (!st.plots.snr) st.plots.snr = new D.Plot($('cvSNR'), { height: 300 });
    st.plots.snr.draw({
      x: Ns, xLog: true, yLog: true, xLabel: `number of ${S.ds.conditions[ci]} trials averaged`, yLabel: 'signal to noise ratio',
      series: [{ y: theory, color: T.ink2, dash: [5, 4], width: 1.5, label: '∝ √N' }, { y: snrB, color: T.series[0], label: 'noise from the baseline' }, { y: snrT, color: T.series[1], label: 'noise from the true ERP' }],
      markers: [{ x: curN, y: snrT[curN - 1], color: T.series[1], label: `N = ${curN}` }],
      xRange: [1, Math.max(2, Ns.length)], tipX: x => `N = ${Math.round(x)}`, tipFmt: v => v.toFixed(2)
    });
    ui.legend($('snrLegend'), [{ color: T.series[0], label: 'noise measured in the baseline' }, { color: T.series[1], label: 'noise measured against the true ERP' }, { color: T.ink2, label: 'slope ½: SNR ∝ √N', dash: true }]);
    st.snr = { N: curN, snrB: snrB[curN - 1], snrT: snrT[curN - 1], sig, cond: S.ds.conditions[ci], need2x: 4 * curN };
  }

  function drawImage() {
    const T = D.theme(), ep = S.ep, k = chIndex(), ci = +$('imgCond').value, fs = S.ds.fs;
    const cv = $('cvERPImage');
    const eps = ep.list.filter(e => e.ev.ci === ci);
    if (!eps.length || k < 0) { const g = D.fit(cv, 60); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('No epochs for this condition.', 8, 30); return; }
    const sort = $('imgSort').value;
    const erp = S.ds.gens.filter(g => g.kind === 'source' && g.jitter && S.enabled.has(g.group));
    const jit = e => erp.length ? erp[erp.length - 1].jitter[S.ds.events.indexOf(e.ev)] : 0;
    const peak = e => { let m = 0; for (let t = ep.zero; t < ep.nT; t++) { const v = e.data[k * ep.nT + t]; if (Math.abs(v) > Math.abs(m)) m = v; } return m; };
    const order = eps.slice();
    if (sort === 'jitter') order.sort((a, b) => jit(a) - jit(b));
    else if (sort === 'amp') order.sort((a, b) => peak(a) - peak(b));
    const rows = order.map(e => e.data.subarray(k * ep.nT, (k + 1) * ep.nT));
    const all = []; rows.forEach(r => { for (let t = 0; t < r.length; t += 3) all.push(Math.abs(r[t])); });
    all.sort((a, b) => a - b);
    const lim = all[Math.floor(all.length * 0.97)] || 1;
    const rowH = EEG.clamp(Math.floor(320 / rows.length), 1, 6);
    const { ctx, w, h } = D.fit(cv, rows.length * rowH + 40);
    const L = 40, R = w - 50, Y0 = 4, Y1 = Y0 + rows.length * rowH;
    D.heat(ctx, L, Y0, R - L, Y1 - Y0, rows, v => D.lutRGB(v / lim), false);
    const sx = t => L + (t - ep.times[0]) / (ep.times[ep.nT - 1] - ep.times[0]) * (R - L);
    ctx.strokeStyle = T.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx(0), Y0); ctx.lineTo(sx(0), Y1); ctx.stroke();
    order.forEach((e, i) => { if (e.rejected) { ctx.fillStyle = T.crit; ctx.fillRect(L - 8, Y0 + i * rowH, 5, Math.max(1, rowH - (rowH > 2 ? 1 : 0))); } });
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    D.ticks(ep.times[0], ep.times[ep.nT - 1], 6).forEach(t => ctx.fillText(Math.round(t * 1000), sx(t), Y1 + 4));
    ctx.fillText('time from stimulus (ms)', (L + R) / 2, Y1 + 18);
    ctx.save(); ctx.translate(12, (Y0 + Y1) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.ink2; ctx.fillText(`${rows.length} trials${sort !== 'order' ? ', sorted' : ''}`, 0, 0); ctx.restore();
    // colour scale
    for (let i = 0; i < Y1 - Y0; i++) { const rgb = D.lutRGB(1 - 2 * i / (Y1 - Y0)); ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.fillRect(R + 10, Y0 + i, 8, 1.5); }
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('+' + EEG.fmt(lim, 0), R + 21, Y0 + 5); ctx.fillText('−' + EEG.fmt(lim, 0), R + 21, Y1 - 5);
    if (order.some(e => e.rejected)) { ctx.fillStyle = T.crit; ctx.textAlign = 'left'; ctx.fillText('rejected', 2, Y1 + 30); }
  }

  function drawTopos() {
    const T = D.theme(), ep = S.ep, cv = $('cvERPTopo');
    if (!S.filt.positions) { const g = D.fit(cv, 60); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('Scalp maps need a referential montage.', 8, 30); return; }
    if (st.lat === null) { const truth = EEG.app.truth(); st.lat = truth.filt ? (() => { let best = 0, bm = 0; truth.filt.forEach(c => { for (let t = ep.zero; t < c.nT; t++) for (let ch = 0; ch < c.nCh; ch++) { const v = Math.abs(c.data[ch * c.nT + t]); if (v > bm) { bm = v; best = c.times[t]; } } }); return best * 1000; })() : 300; }
    const ti = EEG.clamp(Math.round((st.lat / 1000 - ep.times[0]) * S.ds.fs), 0, ep.nT - 1);
    $('latLabel').textContent = `at ${Math.round(ep.times[ti] * 1000)} ms, first ${st.N} trials of each condition; click the ERP plot to move`;
    const maps = [];
    S.ds.conditions.forEach((c, ci) => {
      if (!st.shown.has(ci)) return;
      const eps = accepted(ci).slice(0, st.N);
      if (!eps.length) return;
      const v = new Float64Array(ep.nCh);
      eps.forEach(e => { for (let ch = 0; ch < ep.nCh; ch++) v[ch] += e.data[ch * ep.nT + ti]; });
      for (let ch = 0; ch < ep.nCh; ch++) v[ch] /= eps.length;
      maps.push({ label: `${c} (${eps.length})`, v, color: ui.condColor(ci), ci });
    });
    const dp = diffPair();
    if ($('avgDiff').checked && dp) { const a = maps.find(m => m.ci === dp.a), b = maps.find(m => m.ci === dp.b); if (a && b) maps.push({ label: dp.label, v: a.v.map((x, i) => x - b.v[i]), color: T.ink }); }
    if (!maps.length) { D.fit(cv, 40); return; }
    let mx = 0; maps.forEach(m => m.v.forEach(x => { mx = Math.max(mx, Math.abs(x)); }));
    const n = maps.length, cols = Math.min(n, 3), rowsN = Math.ceil(n / cols);
    const { ctx, w } = D.fit(cv, w => rowsN * Math.min(220, w / cols + 30) + 34);
    const cell = Math.min(220, w / cols + 30), r = Math.min(w / cols / 2 - 10, cell / 2 - 24);
    maps.forEach((m, i) => {
      const cx = (i % cols + 0.5) * w / cols, cy = Math.floor(i / cols) * cell + 20 + r + 6;
      D.topo(ctx, cx, cy, r, S.filt.labels, m.v, { range: mx || 1 });
      ctx.fillStyle = m.color; ctx.font = D.font(11, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(m.label, cx, cy - r - 20);
    });
    D.colorbar(ctx, w / 2 - Math.min(140, w * 0.35), rowsN * cell + 6, Math.min(280, w * 0.7), 9, mx || 1, { unit: S.filt.unit });
  }

  function readouts() {
    const conds = S.ds.conditions;
    const pairs = conds.map((c, ci) => { const all = S.ep.list.filter(e => e.ev.ci === ci).length, ok = accepted(ci).length; return [c, `${ok} of ${all} kept`, `${all - ok} rejected`]; });
    if (st.snr) pairs.push(['SNR now', `${st.snr.snrB.toFixed(1)} (baseline) · ${st.snr.snrT.toFixed(1)} (truth)`, `${st.snr.cond}, N = ${st.snr.N}`], ['To double it', `${st.snr.need2x} trials`, 'four times as many']);
    ui.readouts($('avgReadouts'), pairs);
  }
  function maxN() { let m = 1; S.ds.conditions.forEach((_, ci) => { if (st.shown.has(ci)) m = Math.max(m, accepted(ci).length); }); return m; }
  function syncN() { const m = maxN(); st.N = EEG.clamp(st.N, 1, m); $('avgN').max = m; $('avgN').value = st.N; $('avgNV').textContent = st.N; }

  function epochControls() {
    const E = S.epoch;
    $('epT0').value = Math.round(E.t0 * 1000); $('epT1').value = Math.round(E.t1 * 1000);
    $('blOn').checked = !!E.baseline; if (E.baseline) $('bl0').value = Math.round(E.baseline[0] * 1000);
    $('rjOn').checked = !!E.reject; if (E.reject) $('rj').value = E.reject;
    $('epT0V').textContent = $('epT0').value + ' ms'; $('epT1V').textContent = $('epT1').value + ' ms';
    $('blV').textContent = $('bl0').value + ' ms'; $('rjV').textContent = $('rj').value + ' µV';
    $('rjOn').disabled = S.filt.unit !== 'µV';
  }
  function readEpoch() {
    const E = S.epoch;
    E.t0 = parseFloat($('epT0').value) / 1000; E.t1 = parseFloat($('epT1').value) / 1000;
    const b0 = Math.max(E.t0, parseFloat($('bl0').value) / 1000);
    E.baseline = $('blOn').checked ? [b0, 0] : null;
    E.reject = $('rjOn').checked ? parseFloat($('rj').value) : null;
  }

  function render() {
    const cv = $('cvERP');
    if (!S.ds) return;
    if (!S.ds.events.length) {
      ['cvERP', 'cvSNR', 'cvERPImage', 'cvERPTopo'].forEach(id => { const g = D.fit($(id), 60); g.ctx.fillStyle = D.theme().muted; g.ctx.font = D.font(12); g.ctx.fillText('This recording has no trials. Add a trials block to the timeline.', 8, 30); });
      ['erpLegend', 'snrLegend'].forEach(id => { $(id).innerHTML = ''; });
      ui.readouts($('avgReadouts'), []); $('avgConds').innerHTML = '';
      return;
    }
    epochControls();
    const labels = S.filt.labels, cur = $('avgCh').value;
    const truth = EEG.app.truth();
    let pref = ['Pz', 'Cz', 'Oz'];
    if (truth.filt) {
      // default to the channel where the conditions differ most, or else respond most
      const dp = diffPair();
      let best = null, bm = 0;
      const f0 = truth.filt[0];
      for (let ch = 0; ch < f0.nCh; ch++) for (let t = 0; t < f0.nT; t++) {
        const v = dp ? Math.abs(truth.filt[dp.a].data[ch * f0.nT + t] - truth.filt[dp.b].data[ch * f0.nT + t])
          : Math.max(...truth.filt.map(c => Math.abs(c.data[ch * c.nT + t])));
        if (v > bm) { bm = v; best = labels[ch]; }
      }
      if (best) pref = [best].concat(pref);
    }
    ui.fill($('avgCh'), ui.chOptions(labels), labels.includes(cur) && !st.resetCh ? cur : ui.pick(labels, pref));
    st.resetCh = false;
    if (!st.shown) st.shown = new Set(S.ds.conditions.map((_, i) => i));
    $('avgConds').innerHTML = S.ds.conditions.map((c, i) => `<label class="check"><input type="checkbox" data-ci="${i}" ${st.shown.has(i) ? 'checked' : ''}><span class="sw dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ui.condColor(i)}"></span>${c}</label>`).join('');
    ui.fill($('imgCond'), S.ds.conditions.map((c, i) => ({ value: String(i), label: c })), $('imgCond').value || String(diffPair() ? diffPair().a : 0));
    $('avgDiff').disabled = !diffPair();
    syncN();
    drawERP(); readouts(); drawImage(); drawTopos();
  }
  function quick() { syncN(); drawERP(); readouts(); drawTopos(); }

  function play() {
    if (!st.playing || S.tab !== 'averaging') { st.playing = false; $('avgPlay').textContent = 'Play'; return; }
    if (st.N >= maxN()) { st.playing = false; $('avgPlay').textContent = 'Play'; return; }
    st.N += st.N < 20 ? 1 : st.N < 60 ? 2 : 4;
    quick();
    st.timer = setTimeout(play, st.N < 20 ? 160 : 110);
  }

  EEG.tabs.averaging = {
    init() {
      const re = ui.debounce(() => { readEpoch(); EEG.app.later(() => EEG.app.run('epoch')); }, 200);
      ['epT0', 'epT1', 'bl0', 'rj'].forEach(id => $(id).addEventListener('input', () => { epochLabels(); re(); }));
      ['blOn', 'rjOn'].forEach(id => $(id).addEventListener('change', re));
      function epochLabels() { $('epT0V').textContent = $('epT0').value + ' ms'; $('epT1V').textContent = $('epT1').value + ' ms'; $('blV').textContent = $('bl0').value + ' ms'; $('rjV').textContent = $('rj').value + ' µV'; }
      $('avgCh').addEventListener('change', () => { drawERP(); readouts(); drawImage(); });
      $('avgConds').addEventListener('change', e => { const ci = +e.target.dataset.ci; if (e.target.checked) st.shown.add(ci); else st.shown.delete(ci); quick(); });
      ['avgSingle', 'avgTruth', 'avgTruthRaw', 'avgNeg'].forEach(id => $(id).addEventListener('change', drawERP));
      $('avgDiff').addEventListener('change', () => { drawERP(); drawTopos(); });
      $('avgN').addEventListener('input', () => { st.N = +$('avgN').value; quick(); });
      $('avgPlay').addEventListener('click', () => {
        st.playing = !st.playing; $('avgPlay').textContent = st.playing ? 'Pause' : 'Play';
        if (st.playing) { if (st.N >= maxN()) st.N = 1; play(); } else clearTimeout(st.timer);
      });
      $('avgStep').addEventListener('click', () => { st.N++; quick(); });
      $('avgAll').addEventListener('click', () => { st.N = maxN(); quick(); });
      $('avgReset').addEventListener('click', () => { st.N = 1; quick(); });
      ['imgCond', 'imgSort'].forEach(id => $(id).addEventListener('change', drawImage));
    },
    onBuild(keep) { if (!keep) { st.N = 1; st.lat = null; st.shown = null; st.resetCh = true; } },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
