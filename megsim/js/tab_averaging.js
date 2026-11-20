/* MEG simulator: the Averaging tab.  The evoked field emerging from the
   noise trial by trial, on one sensor or all of them at once; signal to
   noise against the square root of N; an image of every epoch; and field
   maps of the average next to the true evoked field. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S;
  const $ = ui.$;
  const st = { N: 1, playing: false, lat: null, shown: null, plots: {}, mapMode: 'rms' };

  function chIndex() { return parseInt($('avgCh').value, 10); }
  function accepted(ci) { return S.ep.list.filter(e => e.ev.ci === ci && !e.rejected); }
  function diffPair() {
    const c = S.ds.conditions;
    if (c.length < 2) return null;
    const n = c.map((_, i) => S.ds.events.filter(e => e.ci === i).length);
    const [a, b] = n[0] < n[1] ? [0, 1] : [1, 0];
    return { a, b, label: `${c[a]} − ${c[b]}` };
  }
  const truthNow = () => (S.truth && S.truth.ok ? S.truth : null);
  // The condition that reaches the best SNR at this channel (peak × √trials), for the SNR plot.
  function focusCond(k, truth) {
    if (!truth) return 0;
    let best = 0, bm = -1;
    truth.conds.forEach((c, i) => { let m = 0; for (let t = 0; t < truth.nT; t++) if (truth.times[t] > 0) m = Math.max(m, Math.abs(c.data[k * truth.nT + t])); m *= Math.sqrt(accepted(i).length); if (m > bm) { bm = m; best = i; } });
    return best;
  }
  function cumulative(ci, k) {
    const eps = accepted(ci), nT = S.ep.nT, out = [new Float64Array(nT)];
    eps.forEach((e, j) => { const prev = out[j], cur = new Float64Array(nT); for (let t = 0; t < nT; t++) cur[t] = prev[t] + e.data[k * nT + t]; out.push(cur); });
    return { cum: out, eps };
  }
  const avgAt = (cum, n) => { const c = cum[n], nT = c.length, a = new Float64Array(nT); for (let t = 0; t < nT; t++) a[t] = c[t] / Math.max(1, n); return a; };
  // The average of the first n accepted epochs of a condition, every channel.
  function averageAll(ci, n) {
    const eps = accepted(ci).slice(0, n), ep = S.ep, acc = new Float64Array(ep.nCh * ep.nT);
    eps.forEach(e => { for (let i = 0; i < acc.length; i++) acc[i] += e.data[i]; });
    if (eps.length) for (let i = 0; i < acc.length; i++) acc[i] /= eps.length;
    return { data: acc, n: eps.length };
  }

  function drawERP() {
    const T = D.theme(), ep = S.ep, k = chIndex(), arr = S.ds.array;
    if (!(k >= 0)) return;
    const truth = truthNow();
    const times = Array.from(ep.times, t => t * 1000);
    const conds = S.ds.conditions, unit = arr.channels[k].unit;
    const series = [];
    st.cums = {};
    const butterfly = $('avgButterfly').checked;
    if (butterfly) {
      const idx = ui.chans(arr.channels[k].kind);
      conds.forEach((c, ci) => {
        if (!st.shown.has(ci)) return;
        const av = averageAll(ci, st.N);
        idx.forEach(ch => { if (ch !== k) series.push({ y: Array.from(av.data.subarray(ch * ep.nT, (ch + 1) * ep.nT)), color: ui.condColor(ci), alpha: 0.18, width: 0.8, noTip: true }); });
      });
    }
    conds.forEach((c, ci) => {
      if (!st.shown.has(ci)) return;
      const col = ui.condColor(ci);
      const { cum, eps } = cumulative(ci, k);
      st.cums[ci] = cum;
      const n = Math.min(st.N, eps.length);
      if (!n) return;
      if ($('avgSingle').checked) series.push({ y: Array.from(eps[n - 1].data.subarray(k * ep.nT, (k + 1) * ep.nT)), color: col, alpha: 0.3, width: 1, label: `${c}: trial ${n}`, noTip: true });
      if ($('avgTruth').checked && truth) series.push({ y: Array.from(truth.conds[ci].data.subarray(k * ep.nT, (k + 1) * ep.nT)), color: col, dash: [6, 4], width: 1.6, label: `${c}: true field` });
      series.push({ y: Array.from(avgAt(cum, n)), color: col, width: 2.4, label: `${c}: average of ${n}, ${arr.channels[k].name}` });
    });
    const dp = diffPair();
    if ($('avgDiff').checked && dp && st.cums[dp.a] && st.cums[dp.b]) {
      const na = Math.min(st.N, st.cums[dp.a].length - 1), nb = Math.min(st.N, st.cums[dp.b].length - 1);
      if (na && nb) { const a = avgAt(st.cums[dp.a], na), b = avgAt(st.cums[dp.b], nb); series.push({ y: Array.from(a, (v, i) => v - b[i]), color: T.ink, width: 1.8, label: dp.label }); }
    }
    if (!st.plots.erp) st.plots.erp = new D.Plot($('cvERP'), { height: 330, onClick: x => { st.lat = x; drawERP(); drawTopos(); } });
    const E = S.epoch;
    st.plots.erp.draw({
      x: times, series, xLabel: 'time from stimulus (ms)', yLabel: `${arr.channels[k].name} (${unit})`,
      bands: E.baseline ? [{ x0: E.baseline[0] * 1000, x1: E.baseline[1] * 1000, fill: T.band, label: 'baseline' }] : [],
      vlines: [{ x: 0, color: T.muted }].concat(st.lat !== null ? [{ x: st.lat, color: T.accent, label: Math.round(st.lat) + ' ms' }] : []),
      tipX: x => `${x.toFixed(0)} ms`, tipFmt: v => ui.fmtV(v, unit)
    });
    const leg = [];
    conds.forEach((c, ci) => { if (st.shown.has(ci)) leg.push({ color: ui.condColor(ci), label: c }); });
    if (truth) leg.push({ color: T.ink2, label: 'true evoked field, same processing', dash: true });
    if (butterfly) leg.push({ color: D.alpha(T.ink2, 0.4), label: `faint: every other ${MEG.KIND_LABEL[arr.channels[k].kind].replace(/s$/, '')}` });
    if ($('avgDiff').checked && dp) leg.push({ color: T.ink, label: dp.label });
    ui.legend($('erpLegend'), leg);
    drawSNR(k, truth);
  }

  function drawSNR(k, truth) {
    const T = D.theme(), ep = S.ep, cv = $('cvSNR');
    if (!truth) { D.message(cv, S.truthNone ? 'This recording has no evoked sources,\nso there is no true signal to measure against.' : 'Computing the true evoked field…', 120); ui.legend($('snrLegend'), []); st.snr = null; return; }
    const ci = focusCond(k, truth);
    const { cum } = st.cums[ci] ? { cum: st.cums[ci] } : cumulative(ci, k);
    const tr = truth.conds[ci].data.subarray(k * ep.nT, (k + 1) * ep.nT);
    const nT = ep.nT, zero = ep.zero, E = S.epoch;
    let sig = 0; for (let t = zero; t < nT; t++) sig = Math.max(sig, Math.abs(tr[t]));
    const b0 = E.baseline ? MEG.clamp(Math.round((E.baseline[0] - E.t0) * S.ds.fs), 0, nT - 1) : 0, b1 = Math.max(b0 + 2, zero);
    const Ns = [], snrB = [], snrT = [];
    for (let n = 1; n < cum.length; n++) {
      const a = avgAt(cum, n);
      let sb = 0, mb = 0; for (let t = b0; t < b1; t++) mb += a[t]; mb /= (b1 - b0);
      for (let t = b0; t < b1; t++) sb += (a[t] - mb) ** 2;
      let stt = 0; for (let t = 0; t < nT; t++) stt += (a[t] - tr[t]) ** 2;
      Ns.push(n); snrB.push(sig / Math.sqrt(sb / (b1 - b0) || 1e-30)); snrT.push(sig / Math.sqrt(stt / nT || 1e-30));
    }
    if (!Ns.length) { D.message(cv, 'No accepted trials.'); return; }
    let a = 0; Ns.forEach((n, i) => { a += Math.log(snrT[i]) - 0.5 * Math.log(n); }); a = Math.exp(a / Ns.length);
    const theory = Ns.map(n => a * Math.sqrt(n));
    const curN = Math.min(st.N, Ns.length);
    if (!st.plots.snr) st.plots.snr = new D.Plot($('cvSNR'), { height: 300 });
    st.plots.snr.draw({
      x: Ns, xLog: true, yLog: true, xLabel: `number of ${S.ds.conditions[ci]} trials averaged`, yLabel: 'signal to noise ratio',
      series: [{ y: theory, color: T.muted, dash: [5, 4], width: 1.5, label: '∝ √N' }, { y: snrB, color: T.series[6], label: 'noise from the baseline' }, { y: snrT, color: T.ink, label: 'noise from the true field' }],
      markers: [{ x: curN, y: snrT[curN - 1], color: T.ink, label: `N = ${curN}` }],
      xRange: [1, Math.max(2, Ns.length)], tipX: x => `N = ${Math.round(x)}`, tipFmt: v => v.toFixed(2)
    });
    ui.legend($('snrLegend'), [{ color: T.series[6], label: 'noise measured in the baseline' }, { color: T.ink, label: 'noise measured against the true field' }, { color: T.muted, label: 'slope ½: SNR ∝ √N', dash: true }]);
    st.snr = { N: curN, snrB: snrB[curN - 1], snrT: snrT[curN - 1], sig, cond: S.ds.conditions[ci], need2x: 4 * curN };
  }

  function drawImage() {
    const T = D.theme(), ep = S.ep, k = chIndex(), ci = +$('imgCond').value, arr = S.ds.array;
    const cv = $('cvERPImage');
    const eps = ep.list.filter(e => e.ev.ci === ci);
    if (!eps.length || !(k >= 0)) { D.message(cv, 'No epochs for this condition.'); return; }
    const sort = $('imgSort').value;
    const evGen = S.ds.gens.find(g => g.kind === 'source' && g.jitter && S.enabled.has(g.group));
    const jit = e => evGen ? evGen.jitter[S.ds.events.indexOf(e.ev)] : 0;
    const peak = e => { let m = 0; for (let t = ep.zero; t < ep.nT; t++) { const v = e.data[k * ep.nT + t]; if (Math.abs(v) > Math.abs(m)) m = v; } return m; };
    const order = eps.slice();
    if (sort === 'jitter') order.sort((a, b) => jit(a) - jit(b));
    else if (sort === 'amp') order.sort((a, b) => peak(a) - peak(b));
    const raw = order.map(e => e.data.subarray(k * ep.nT, (k + 1) * ep.nT));
    // Smooth each accepted row with its accepted neighbours; rejected rows stay raw.
    const half = (parseInt($('imgSmooth').value, 10) - 1) >> 1, okIdx = [];
    order.forEach((e, i) => { if (!e.rejected) okIdx.push(i); });
    const rows = raw.map((r, i) => {
      const j = okIdx.indexOf(i);
      if (!half || j < 0) return r;
      const lo = Math.max(0, j - half), hi = Math.min(okIdx.length - 1, j + half), out = new Float64Array(r.length);
      for (let q = lo; q <= hi; q++) { const rr = raw[okIdx[q]]; for (let t = 0; t < out.length; t++) out[t] += rr[t]; }
      for (let t = 0; t < out.length; t++) out[t] /= hi - lo + 1;
      return out;
    });
    const all = []; rows.forEach(r => { for (let t = 0; t < r.length; t += 3) all.push(Math.abs(r[t])); });
    all.sort((a, b) => a - b);
    const lim = all[Math.floor(all.length * 0.97)] || 1;
    const rowH = MEG.clamp(Math.floor(320 / rows.length), 1, 6);
    const { ctx, w } = D.fit(cv, rows.length * rowH + 40);
    const L = 40, R = w - 64, Y0 = 4, Y1 = Y0 + rows.length * rowH;
    D.heat(ctx, L, Y0, R - L, Y1 - Y0, rows, v => D.lutRGB(v / lim), false);
    const sx = t => L + (t - ep.times[0]) / (ep.times[ep.nT - 1] - ep.times[0]) * (R - L);
    ctx.strokeStyle = T.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx(0), Y0); ctx.lineTo(sx(0), Y1); ctx.stroke();
    order.forEach((e, i) => { if (e.rejected) { ctx.fillStyle = T.crit; ctx.fillRect(L - 8, Y0 + i * rowH, 5, Math.max(1, rowH - (rowH > 2 ? 1 : 0))); } });
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    D.ticks(ep.times[0], ep.times[ep.nT - 1], 6).forEach(t => ctx.fillText(Math.round(t * 1000), sx(t), Y1 + 4));
    ctx.fillText('time from stimulus (ms)', (L + R) / 2, Y1 + 18);
    ctx.save(); ctx.translate(12, (Y0 + Y1) / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.ink2; ctx.fillText(`${rows.length} trials${sort !== 'order' ? ', sorted' : ''}${half ? ', smoothed' : ''}`, 0, 0); ctx.restore();
    for (let i = 0; i < Y1 - Y0; i++) { const rgb = D.lutRGB(1 - 2 * i / (Y1 - Y0)); ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.fillRect(R + 10, Y0 + i, 8, 1.5); }
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const unit = arr.channels[k].unit;
    ctx.fillText('+' + ui.fmtV(lim, unit, 0), R + 21, Y0 + 5); ctx.fillText('−' + ui.fmtV(lim, unit, 0), R + 21, Y1 - 5);
    if (order.some(e => e.rejected)) { ctx.fillStyle = T.crit; ctx.textAlign = 'left'; ctx.fillText('rejected', 2, Y1 + 30); }
  }

  function drawTopos() {
    const T = D.theme(), ep = S.ep, cv = $('cvERPTopo'), arr = S.ds.array, truth = truthNow();
    if (st.lat === null) {
      if (truth) { let best = 0, bm = 0; truth.conds.forEach(c => { for (let t = ep.zero; t < truth.nT; t++) for (let ch = 0; ch < truth.nCh; ch++) { const v = Math.abs(c.data[ch * truth.nT + t]); if (v > bm) { bm = v; best = truth.times[t]; } } }); st.lat = best * 1000; }
      else st.lat = 100;
    }
    const ti = MEG.clamp(Math.round((st.lat / 1000 - ep.times[0]) * S.ds.fs), 0, ep.nT - 1);
    $('latLabel').textContent = `at ${Math.round(ep.times[ti] * 1000)} ms, first ${st.N} trials of each condition; click the plot of the average to move`;
    const mode = arr.type === 'planar' ? st.mapMode : null;
    const toSites = v => D.siteValues(arr, v, mode);
    const maps = [];
    S.ds.conditions.forEach((c, ci) => {
      if (!st.shown.has(ci)) return;
      const av = averageAll(ci, st.N);
      if (!av.n) return;
      const v = Float64Array.from({ length: ep.nCh }, (_, ch) => av.data[ch * ep.nT + ti]);
      maps.push({ label: `${c}, average of ${av.n}`, v: toSites(v), color: ui.condColor(ci) });
      if (truth) maps.push({ label: `${c}, true field`, v: toSites(Float64Array.from({ length: ep.nCh }, (_, ch) => truth.conds[ci].data[ch * truth.nT + ti])), color: T.ink2 });
    });
    if (!maps.length) { D.fit(cv, 40); return; }
    const seq = mode === 'rms';
    let mx = 0; maps.forEach(m => m.v.forEach(x => { mx = Math.max(mx, Math.abs(x)); }));
    const n = maps.length, cols = Math.min(n, truth ? 2 : 3), rowsN = Math.ceil(n / cols);
    const { ctx, w } = D.fit(cv, w => rowsN * Math.min(240, w / cols + 30) + 34);
    const cell = Math.min(240, w / cols + 30), r = Math.min(w / cols / 2 - 10, cell / 2 - 22);
    maps.forEach((m, i) => {
      const cx = (i % cols + 0.5) * w / cols, cy = Math.floor(i / cols) * cell + 20 + r + 4;
      D.topo(ctx, cx, cy, r, D.sites(), m.v, { range: seq ? [0, mx || 1] : (mx || 1), sequential: seq, floor0: seq });
      ctx.fillStyle = m.color; ctx.font = D.font(11, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(m.label, cx, cy - r - 20);
    });
    const unit = mode === 'mag' || !mode ? (arr.type === 'planar' ? 'fT' : ui.unitOf(arr.type)) : 'fT/cm';
    D.colorbar(ctx, w / 2 - Math.min(140, w * 0.35), rowsN * cell + 6, Math.min(280, w * 0.7), 9, seq ? [0, mx || 1] : (mx || 1), { unit, sequential: seq, fmt: x => MEG.fmt(x, Math.abs(x) < 10 ? 1 : 0) });
  }

  function readouts() {
    const conds = S.ds.conditions;
    const pairs = conds.map((c, ci) => { const all = S.ep.list.filter(e => e.ev.ci === ci).length, ok = accepted(ci).length; return [c, `${ok} of ${all} kept`, `${all - ok} rejected`]; });
    if (st.snr) pairs.push(['SNR now', `${st.snr.snrB.toFixed(1)} (baseline) · ${st.snr.snrT.toFixed(1)} (truth)`, `${st.snr.cond}, N = ${st.snr.N}`], ['To double it', `${st.snr.need2x} trials`, 'four times as many']);
    const rej = S.ep.list.filter(e => e.rejected);
    if (rej.length) {
      const arr = S.ds.array, count = {};
      rej.forEach(e => { if (e.worstCh >= 0) { const nm = arr.channels[e.worstCh].name; count[nm] = (count[nm] || 0) + 1; } });
      const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
      if (top) pairs.push(['Worst sensor', top, `${count[top]} rejections were driven by ${top}`]);
    }
    ui.readouts($('avgReadouts'), pairs);
  }
  function maxN() { let m = 1; S.ds.conditions.forEach((_, ci) => { if (st.shown.has(ci)) m = Math.max(m, accepted(ci).length); }); return m; }
  function syncN() { const m = maxN(); st.N = MEG.clamp(st.N, 1, m); $('avgN').max = m; $('avgN').value = st.N; $('avgNV').textContent = st.N; }

  function epochLabels() {
    $('epT0V').textContent = $('epT0').value + ' ms'; $('epT1V').textContent = $('epT1').value + ' ms';
    $('blV').textContent = $('bl0').value + ' ms';
    const f = Math.pow(10, parseFloat($('rj').value)) * 1000;
    $('rjV').textContent = S.ds && S.ds.array.type === 'planar' ? `${MEG.fmtB(f, 1)}, ${MEG.fmt(f, 0)} fT/cm` : MEG.fmtB(f, 1) + ' peak to peak';
  }
  function epochControls() {
    const E = S.epoch;
    $('epT0').value = Math.round(E.t0 * 1000); $('epT1').value = Math.round(E.t1 * 1000);
    $('blOn').checked = !!E.baseline; if (E.baseline) $('bl0').value = Math.round(E.baseline[0] * 1000);
    $('rjOn').checked = !!E.rejectOn; $('rj').value = Math.log10(E.rejField / 1000).toFixed(2);
    $('rjBad').checked = E.ignoreBad;
    $('rjBadBox').hidden = !(S.enabled.has('bad') && S.ds.badSite >= 0);
    $('rjBadName').textContent = S.ds.badSite >= 0 ? MEG.SITES[S.ds.badSite].name : '';
    epochLabels();
  }
  function readEpoch() {
    const E = S.epoch;
    E.t0 = parseFloat($('epT0').value) / 1000; E.t1 = parseFloat($('epT1').value) / 1000;
    const b0 = Math.max(E.t0, parseFloat($('bl0').value) / 1000);
    E.baseline = $('blOn').checked ? [b0, 0] : null;
    E.rejectOn = $('rjOn').checked;
    E.rejField = Math.pow(10, parseFloat($('rj').value)) * 1000; E.rejGrad = E.rejField;
    E.ignoreBad = $('rjBad').checked;
  }

  function render() {
    if (!S.ds) return;
    if (!S.ds.events.length) {
      ['cvERP', 'cvSNR', 'cvERPImage', 'cvERPTopo'].forEach(id => D.message($(id), 'This recording has no trials. Add a trials block to the timeline.'));
      ['erpLegend', 'snrLegend'].forEach(id => { $(id).innerHTML = ''; });
      ui.readouts($('avgReadouts'), []); $('avgConds').innerHTML = '';
      return;
    }
    epochControls();
    const arr = S.ds.array;
    const cur = $('avgCh').value;
    const opts = arr.channels.map((c, i) => ({ value: String(i), label: c.name }));
    ui.fill($('avgCh'), opts, !st.resetCh && st.arrType === arr.type && cur !== '' ? cur : String(ui.bestChannel()));
    st.resetCh = false; st.arrType = arr.type;
    if (!st.shown) st.shown = new Set(S.ds.conditions.map((_, i) => i));
    $('avgConds').innerHTML = S.ds.conditions.map((c, i) => `<label class="check"><input type="checkbox" data-ci="${i}" ${st.shown.has(i) ? 'checked' : ''}><span class="sw dot" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${ui.condColor(i)}"></span>${c}</label>`).join('');
    const most = S.ds.conditions.map((_, i) => S.ds.events.filter(e => e.ci === i).length).reduce((b, n, i, a) => (n > a[b] ? i : b), 0);
    ui.fill($('imgCond'), S.ds.conditions.map((c, i) => ({ value: String(i), label: c })), $('imgCond').value || String(most));
    $('avgDiff').disabled = !diffPair();
    $('avgMapBox').hidden = arr.type !== 'planar';
    syncN();
    drawERP(); readouts(); drawImage(); drawTopos();
    if (!truthNow()) {
      const v = S.version;
      MEG.app.truth().then(tr => { S.truthNone = !tr.ok; if (S.version === v && S.tab === 'averaging') { if (tr.ok) st.lat = null; drawERP(); readouts(); drawTopos(); } }).catch(e => console.error(e));
    }
  }
  function quick() { syncN(); drawERP(); readouts(); drawTopos(); }

  function play() {
    if (!st.playing || S.tab !== 'averaging') { st.playing = false; $('avgPlay').textContent = 'Play'; return; }
    if (st.N >= maxN()) { st.playing = false; $('avgPlay').textContent = 'Play'; return; }
    st.N += st.N < 20 ? 1 : st.N < 60 ? 2 : 4;
    quick();
    st.timer = setTimeout(play, st.N < 20 ? 170 : 120);
  }

  MEG.tabs.averaging = {
    init() {
      $('avgConds').insertAdjacentHTML('beforebegin', '<div class="checks" id="rjBadBox" hidden><label class="check"><input type="checkbox" id="rjBad" checked> Ignore the bad sensor <b id="rjBadName"></b> when rejecting, as an analyst would after marking it</label></div>');
      $('cvERPTopo').insertAdjacentHTML('beforebegin', '<div class="btnrow" id="avgMapBox" style="margin-bottom:6px" hidden><span class="lbl" style="margin:0">Map</span><div class="seg" id="avgMapSeg"><button data-m="rms" aria-pressed="true">Planar gradient</button><button data-m="mag" aria-pressed="false">Magnetometers</button></div></div>');
      ui.seg($('avgMapSeg'), v => { st.mapMode = v; drawTopos(); });
      const re = ui.debounce(() => { readEpoch(); MEG.app.run('epoch'); }, 220);
      ['epT0', 'epT1', 'bl0', 'rj'].forEach(id => $(id).addEventListener('input', () => { epochLabels(); re(); }));
      ['blOn', 'rjOn', 'rjBad'].forEach(id => $(id).addEventListener('change', re));
      $('avgCh').addEventListener('change', () => { drawERP(); readouts(); drawImage(); });
      $('avgConds').addEventListener('change', e => { const ci = +e.target.dataset.ci; if (e.target.checked) st.shown.add(ci); else st.shown.delete(ci); quick(); });
      ['avgSingle', 'avgTruth', 'avgButterfly'].forEach(id => $(id).addEventListener('change', drawERP));
      $('avgDiff').addEventListener('change', () => { drawERP(); drawTopos(); });
      $('avgN').addEventListener('input', () => { st.N = +$('avgN').value; quick(); });
      $('avgPlay').addEventListener('click', () => {
        st.playing = !st.playing; $('avgPlay').textContent = st.playing ? 'Pause' : 'Play';
        if (st.playing) { if (st.N >= maxN()) st.N = 1; play(); } else clearTimeout(st.timer);
      });
      $('avgStep').addEventListener('click', () => { st.N++; quick(); });
      $('avgAll').addEventListener('click', () => { st.N = maxN(); quick(); });
      $('avgReset').addEventListener('click', () => { st.N = 1; quick(); });
      ['imgCond', 'imgSort', 'imgSmooth'].forEach(id => $(id).addEventListener('change', drawImage));
    },
    onBuild(keep) { if (!keep) { st.N = 1; st.lat = null; st.shown = null; st.resetCh = true; $('imgCond').innerHTML = ''; } S.truthNone = false; },
    onArray() { st.resetCh = true; st.lat = null; },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
