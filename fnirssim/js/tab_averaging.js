/* fNIRS simulator: the Averaging and GLM tab.  The block average
   emerging trial by trial against the truth, every channel's average on
   the probe, the GLM with its design matrix and statistic map, and
   connectivity between channels. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { view: 'avg', cond: 0, n: null, play: null, raw: null, rawV: -1, mapKey: 'hbo', stat: 't', conn: null, connV: -1 };
  let ctl = {};

  function rawAvg() {
    // the same averages with no short-channel regression, for comparison
    if (st.rawV !== S.version) { st.raw = NIRS.pipeline.averages(S.ds, S.res.conc, S.P); st.rawV = S.version; }
    return st.raw;
  }
  const peakOf = a => { let m = 0, im = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > Math.abs(m)) { m = a[i]; im = i; } return [m, im]; };

  /* ---------- block average ---------- */
  function renderAvg() {
    const ds = S.ds, T = D.theme(), P = S.P, res = S.res;
    const ch = ui.chSelect($('avCh'));
    if (!ds.conditions.length) {
      const g = D.fit($('cvAvg'), 80); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('This recording has no task (a resting-state run): see Connectivity.', 12, 40);
      D.fit($('cvAvgMap'), 40); $('avReadouts').innerHTML = ''; $('avCallout').innerHTML = ''; return;
    }
    ui.fill($('avCond'), ds.conditions.map((c, i) => ({ value: String(i), label: `${c} (${ds.events.filter(e => e.ci === i).length})` })), String(st.cond));
    const A = res.avg[st.cond][ch];
    const nMax = A.hbo.length;
    $('avN').max = String(Math.max(1, nMax));
    if (st.n === null || st.n > nMax) { st.n = nMax; ctl.n.set(nMax); }
    const n = Math.max(1, Math.min(st.n, nMax));
    const mo = NIRS.dsp.average(A.hbo, n), mr = NIRS.dsp.average(A.hbr, n);
    const t = A.times;
    const series = [];
    if ($('avTrials').checked) {
      A.hbo.slice(0, n).forEach(e => series.push({ y: e.data, color: T.hbo, alpha: 0.18, width: 0.8 }));
      A.hbr.slice(0, n).forEach(e => series.push({ y: e.data, color: T.hbr, alpha: 0.18, width: 0.8 }));
    }
    if (mo && n > 1) {
      series.push({ y: Float64Array.from(mo.mean, (v, i) => v + mo.se[i]), y2: Float64Array.from(mo.mean, (v, i) => v - mo.se[i]), fill: D.alpha(T.hbo, 0.15) });
      series.push({ y: Float64Array.from(mr.mean, (v, i) => v + mr.se[i]), y2: Float64Array.from(mr.mean, (v, i) => v - mr.se[i]), fill: D.alpha(T.hbr, 0.15) });
    }
    const showRaw = $('avCompare').checked && P.short !== 'off';
    if (showRaw) {
      const R = rawAvg()[st.cond][ch], ro = NIRS.dsp.average(R.hbo, n), rr = NIRS.dsp.average(R.hbr, n);
      series.push({ y: ro.mean, color: T.hbo, dash: [1.5, 3], width: 1.6, label: 'HbO, no short-channel regression' });
      series.push({ y: rr.mean, color: T.hbr, dash: [1.5, 3], width: 1.6, label: 'HbR, no short-channel regression' });
    }
    let tr = null;
    if ($('avTruth').checked) {
      tr = NIRS.app.truth().avg[st.cond][ch];
      series.push({ y: tr.mHbo.mean, color: T.hbo, dash: [6, 4], width: 1.6, label: 'true cortical HbO' });
      series.push({ y: tr.mHbr.mean, color: T.hbr, dash: [6, 4], width: 1.6, label: 'true cortical HbR' });
    }
    series.push({ y: mo.mean, color: T.hbo, width: 2.4, label: 'HbO' }, { y: mr.mean, color: T.hbr, width: 2.4, label: 'HbR' });
    const evDur = NIRS.mean(ds.events.filter(e => e.ci === st.cond).map(e => e.dur));
    if (!st.pA) st.pA = new D.Plot($('cvAvg'), { height: 300 });
    st.pA.draw({
      x: t, xLabel: 'time from onset (s)', yLabel: 'ΔHb (µM)', series, yZero: true,
      bands: [{ x0: 0, x1: evDur, fill: D.alpha(ui.condColor(st.cond), 0.1), label: ds.conditions[st.cond] }],
      title: `${ds.chans[ch].label}${res.bad.has(ch) ? ' (rejected by the quality check)' : ''}: ${n} of ${nMax} trial${nMax > 1 ? 's' : ''}`,
      tipX: x => `${x.toFixed(1)} s`, tipFmt: v => v.toFixed(3) + ' µM'
    });
    ui.legend($('avLegend'), [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }].concat(n > 1 ? [{ color: D.alpha(T.hbo, 0.4), label: '± standard error' }] : [],
      tr ? [{ color: T.ink2, label: 'truth (the cortex alone)', dash: true }] : [], showRaw ? [{ color: T.muted, label: 'without short-channel regression (dotted)', dash: true }] : []));
    const [po, io] = peakOf(mo.mean), [pr, ir] = peakOf(mr.mean);
    const seO = n > 1 ? NIRS.mean(mo.se) : NaN;
    ui.readouts($('avReadouts'), [
      ['Trials', `${n}`], ['HbO peak', `${ui.fmtUM(po)} at ${t[io].toFixed(1)} s`], ['HbR peak', `${ui.fmtUM(pr)} at ${t[ir].toFixed(1)} s`],
      ['HbO peak / standard error', isFinite(seO) ? (Math.abs(po) / seO).toFixed(1) : '–', 'grows roughly as the square root of the number of trials'],
      ['True cortical peak (HbO / HbR)', tr ? `${ui.fmtUM(peakOf(tr.mHbo.mean)[0])} / ${ui.fmtUM(peakOf(tr.mHbr.mean)[0])}` : '–']
    ]);
    avgMap(n);
  }

  function avgMap(n) {
    const ds = S.ds, T = D.theme(), res = S.res;
    const g = D.fit($('cvAvgMap'), w => Math.min(460, Math.max(260, w * 0.8)));
    const ms = ds.chans.map((c, i) => { const A = res.avg[st.cond][i]; return { o: NIRS.dsp.average(A.hbo, n), r: NIRS.dsp.average(A.hbr, n) }; });
    let scale = 0;
    ds.chans.forEach((c, i) => { if (c.short || res.bad.has(i)) return; ms[i].o.mean.forEach(v => { scale = Math.max(scale, Math.abs(v)); }); ms[i].r.mean.forEach(v => { scale = Math.max(scale, Math.abs(v)); }); });
    scale = scale || 1;
    const curves = ds.chans.map((c, i) => (ctx, cx, cy, sc) => {
      const w = Math.min(64, Math.max(38, sc * 1.45)), h = w * 0.6, x0 = cx - w / 2, y0 = cy - h / 2;
      ctx.fillStyle = D.alpha(T.card, 0.92); ctx.strokeStyle = i === S.selCh ? T.ink : T.border; ctx.lineWidth = i === S.selCh ? 1.5 : 1;
      ctx.fillRect(x0, y0, w, h); ctx.strokeRect(x0, y0, w, h);
      const bad = res.bad.has(i);
      // short channels keep their scalp signal, so they get a scale of their own
      let sc2 = scale;
      if (c.short) { sc2 = 0; ms[i].o.mean.forEach(v => { sc2 = Math.max(sc2, Math.abs(v)); }); ms[i].r.mean.forEach(v => { sc2 = Math.max(sc2, Math.abs(v)); }); sc2 = sc2 || 1; }
      const draw = (arr, color) => {
        ctx.strokeStyle = bad ? T.muted : color; ctx.lineWidth = 1.4; ctx.beginPath();
        for (let k = 0; k < arr.length; k++) { const X = x0 + 2 + k / (arr.length - 1) * (w - 4), Y = cy - arr[k] / sc2 * (h / 2 - 3); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
        ctx.stroke();
      };
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
      ctx.strokeStyle = T.grid; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(x0 + 2, cy); ctx.lineTo(x0 + w - 2, cy); ctx.stroke();
      draw(ms[i].o.mean, T.hbo); draw(ms[i].r.mean, T.hbr);
      ctx.restore();
      if (c.short) { ctx.fillStyle = T.muted; ctx.font = D.font(8); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(`short ±${sc2.toFixed(1)}`, x0 + 2, y0 + 1); }
    });
    st.amap = D.probeMap(g.ctx, ds, { x: 4, y: 4, w: g.w - 8, h: g.h - 22 }, { curves, labels: true, regions: NIRS.app.regionMarks(), selected: S.selCh, bad: res.bad, scalebar: false });
    g.ctx.fillStyle = T.ink2; g.ctx.font = D.font(10); g.ctx.textAlign = 'left'; g.ctx.textBaseline = 'bottom';
    g.ctx.fillText(`each box: HbO (red) and HbR (blue) average; long channels share one scale, ±${scale.toFixed(2)} µM full height`, 6, g.h - 4);
    D.bindProbe($('cvAvgMap'), () => st.amap, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); });
    // what the averages are saying: compare every channel with its own truth
    const tr = NIRS.app.truth().avg[st.cond];
    const longs = ds.chans.filter(c => !c.short && !res.bad.has(c.index));
    const info = longs.map(c => { const m = ms[c.index].o; return { c, m: peakOf(m.mean)[0], se: n > 1 ? NIRS.mean(m.se) : Infinity, tr: peakOf(tr[c.index].mHbo.mean)[0] }; });
    const up = info.filter(x => x.m > 3 * x.se);
    const excess = info.filter(x => x.m - x.tr > 3 * x.se && x.m - x.tr > 0.02);
    const real = info.filter(x => x.tr > 0.01).sort((a, b) => b.tr - a.tr);
    const tb = S.enabled.has('taskbp');
    let msg = '', cls = '';
    if (excess.length >= 2) {
      msg = `<strong>${excess.length} of ${longs.length} channels show more HbO rise than the cortex explains</strong>${real.length ? ` (it responds under ${real.map(x => x.c.label).join(', ')})` : ' (it did nothing at all: the dashed truth is flat)'}.`;
      msg += tb ? (S.P.short === 'off' ? ' The excess is the scalp\'s task-evoked blood flow. Switch on short-channel regression on the Processing tab.' : ' Short-channel regression has not removed all of it: check which short channel each uses.') : ' Something time-locked other than the cortex is in the data: look at the Confounds tab.';
      cls = 'bad';
    } else if (real.length && up.some(x => real.includes(x))) {
      msg = `<strong>The response is where the cortex is:</strong> strongest in ${real[0].c.label}${real.length > 1 ? `, and a little in ${real.slice(1).map(x => x.c.label).join(', ')}, whose bananas just graze the region` : ''}.${S.P.short !== 'off' && tb ? ' Short-channel regression removed the scalp response; the dotted lines show the averages without it.' : ''}`;
      cls = 'good';
    } else if (!real.length && !up.length) { msg = 'No channel shows a reliable response, and there is none in the cortex to find.'; cls = 'good'; }
    else if (real.length) msg = `The cortex responds under ${real.map(x => x.c.label).join(', ')}, but the averages do not show it clearly yet: try more trials, or check the quality and motion settings.`;
    $('avCallout').innerHTML = msg ? `<div class="callout ${cls}">${msg}</div>` : '';
  }

  function play() {
    if (st.play) { clearInterval(st.play); st.play = null; $('avPlay').textContent = 'Play from one trial'; return; }
    const max = +$('avN').max;
    st.n = 1; ctl.n.set(1); renderAvg();
    $('avPlay').textContent = 'Stop';
    st.play = setInterval(() => {
      if (S.tab !== 'averaging' || st.n >= max) { clearInterval(st.play); st.play = null; $('avPlay').textContent = 'Play from one trial'; return; }
      st.n++; ctl.n.set(st.n); renderAvg();
    }, Math.max(120, 2400 / max));
  }

  /* ---------- GLM ---------- */
  function renderGlm() {
    const ds = S.ds, T = D.theme(), P = S.P;
    const ch = ui.chSelect($('glCh'));
    if (!ds.conditions.length) { const g = D.fit($('cvGlmFit'), 80); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('No task in this recording, so nothing to model.', 12, 40); return; }
    ui.fill($('glCond'), ds.conditions.map((c, i) => ({ value: String(i), label: c })), String(st.cond));
    if (P.hrf === 'off') { P.hrf = 'canonical'; ctl.hrf.set('canonical'); S.glm = null; }
    const glm = NIRS.app.glm();
    const k = NIRS.pipeline.taskIndex(P, st.cond);
    const fo = glm[ch].hbo, fr = glm[ch].hbr;
    if (!st.pF) st.pF = new D.Plot($('cvGlmFit'), { height: 240 });
    st.pF.draw({
      x: ds.t, xLabel: 'time (s)', yLabel: 'ΔHb (µM)',
      series: [{ y: fo.y, color: T.hbo, alpha: 0.35, width: 0.8, label: 'HbO data' }, { y: fr.y, color: T.hbr, alpha: 0.35, width: 0.8, label: 'HbR data' },
        { y: fo.fitted, color: T.hbo, width: 2.2, label: 'HbO model' }, { y: fr.fitted, color: T.hbr, width: 2.2, label: 'HbR model' }],
      bands: D.taskBands(ds, 0, ds.dur), tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + ' µM'
    });
    ui.legend($('glmLegend'), [{ color: D.alpha(T.hbo, 0.5), label: 'data' }, { color: T.hbo, label: 'HbO model' }, { color: T.hbr, label: 'HbR model' }]);
    design(ch);
    // map
    const key = st.mapKey, stat = st.stat;
    const vals = ds.chans.map((c, i) => (c.short ? NaN : glm[i][key][stat === 't' ? 't' : 'beta'][k]));
    let m = 0; vals.forEach(v => { if (isFinite(v)) m = Math.max(m, Math.abs(v)); });
    const g = D.fit($('cvGlmMap'), w => Math.min(300, w * 0.66));
    st.gmap = D.probeMap(g.ctx, ds, { x: 4, y: 4, w: g.w - 8, h: g.h - 8 }, { values: vals, range: m || 1, selected: ch, bad: S.res.bad, regions: NIRS.app.regionMarks() });
    D.bindProbe($('cvGlmMap'), () => st.gmap, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); });
    ui.legend($('glmMapLegend'), [{ color: D.divColor(-0.9), label: `−${(m || 1).toFixed(stat === 't' ? 1 : 3)}` }, { color: D.divColor(0), label: '0' }, { color: D.divColor(0.9), label: `+${(m || 1).toFixed(stat === 't' ? 1 : 3)} ${stat === 't' ? '(t)' : 'µM'}` }, { color: T.hbo, label: 'true cortical region', dash: true }]);
    // table
    const longs = ds.chans.filter(c => !c.short);
    const nTests = longs.length * 2, alpha = 0.05 / nTests;
    const tr = NIRS.app.truth().avg[st.cond];
    const rows = longs.map(c => {
      const i = c.index, o = glm[i].hbo, r = glm[i].hbr;
      const po = NIRS.tToP(o.t[k], o.df), pr = NIRS.tToP(r.t[k], r.df);
      const sig = (p, t, sign) => p < alpha && Math.sign(t) === sign ? ' ●' : '';
      return `<tr data-i="${i}" class="${S.res.bad.has(i) ? 'bad' : ''}${i === S.selCh ? ' sel' : ''}"><td>${c.label}</td>
        <td>${o.beta[k].toFixed(3)}</td><td>${o.t[k].toFixed(1)}${sig(po, o.t[k], 1)}</td><td>${r.beta[k].toFixed(3)}</td><td>${r.t[k].toFixed(1)}${sig(pr, r.t[k], -1)}</td>
        <td>${peakOf(tr[i].mHbo.mean)[0].toFixed(3)}</td></tr>`;
    }).join('');
    $('glmTable').innerHTML = `<tr><th>Channel</th><th>β HbO</th><th>t HbO</th><th>β HbR</th><th>t HbR</th><th>true HbO</th></tr>${rows}
      <tr><td colspan="6" style="text-align:left;color:var(--muted);white-space:normal">● significant in the expected direction after Bonferroni correction for ${nTests} tests (p &lt; ${alpha.toExponential(1)}).
      β is the response peak in µM; "true" is the cortex-only peak. ${P.noise === 'ols' ? 'OLS ignores the serial correlation of fNIRS noise, so its t values are too large: switch to AR.' : ''}</td></tr>`;
    $('glmTable').querySelectorAll('tr[data-i]').forEach(tr2 => tr2.addEventListener('click', () => { S.selCh = +tr2.dataset.i; NIRS.app.markAll(); }));
  }
  function design(ch) {
    const ds = S.ds, T = D.theme(), P = S.P;
    const des = NIRS.dsp.design(ds, P, { driftHz: Math.max(0.004, P.hp || 0.008) });
    const cols = des.cols.slice(), names = des.names.slice();
    const g = D.fit($('cvDesign'), 190);
    const ctx = g.ctx, L = 10, top = 6, bottom = g.h - 44, wcol = Math.min(40, (g.w - 20) / cols.length);
    const rows = 120;
    cols.forEach((c, j) => {
      let lo = Infinity, hi = -Infinity; for (let i = 0; i < c.length; i++) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
      const m = [];
      for (let r = 0; r < rows; r++) { const i = Math.floor(r / rows * c.length); m.push(Float32Array.of(hi > lo ? (c[i] - lo) / (hi - lo) : 0.5)); }
      D.heat(ctx, L + j * wcol + 1, top, wcol - 2, bottom - top, m, v => D.lutRGB(v, true), true);
      ctx.save(); ctx.translate(L + j * wcol + wcol / 2, bottom + 4); ctx.rotate(Math.PI / 4); ctx.fillStyle = T.ink2; ctx.font = D.font(9); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(names[j], 0, 0); ctx.restore();
    });
  }

  /* ---------- connectivity ---------- */
  function renderConn() {
    const ds = S.ds, T = D.theme(), res = S.res;
    const longs = ds.chans.filter(c => !c.short && !res.bad.has(c.index));
    if (st.connV !== S.version) {
      st.conn = NIRS.dsp.corrMatrix(longs.map(c => res.clean[c.index].hbo));
      st.connV = S.version;
    }
    const M = st.conn, n = longs.length;
    const g = D.fit($('cvConn'), w => Math.min(420, w * 0.85));
    const ctx = g.ctx, L = 64, top = 8, size = Math.min(g.w - L - 60, g.h - top - 56);
    const cell = size / n;
    D.heat(ctx, L, top, size, size, M.map(r => Float32Array.from(r)), v => D.lutRGB(v, false), false);
    ctx.font = D.font(Math.min(10, cell * 0.8)); ctx.fillStyle = T.ink2;
    longs.forEach((c, i) => {
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(c.label, L - 4, top + (i + 0.5) * cell);
      ctx.save(); ctx.translate(L + (i + 0.5) * cell, top + size + 4); ctx.rotate(Math.PI / 3); ctx.textAlign = 'left'; ctx.fillText(c.label, 0, 0); ctx.restore();
    });
    // vertical colour bar
    for (let i = 0; i < size; i++) { const v = 1 - 2 * i / size; ctx.fillStyle = D.divColor(v); ctx.fillRect(L + size + 14, top + i, 12, 1.5); }
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('+1', L + size + 30, top); ctx.textBaseline = 'middle'; ctx.fillText('0', L + size + 30, top + size / 2); ctx.textBaseline = 'bottom'; ctx.fillText('−1', L + size + 30, top + size);
    ui.legend($('connLegend'), [{ color: D.divColor(-0.9), label: 'r = −1' }, { color: D.divColor(0), label: '0' }, { color: D.divColor(0.9), label: '+1' }]);
    // seed map
    let seed = S.selCh;
    if (!longs.some(c => c.index === seed)) seed = longs[0] ? longs[0].index : 0;
    const si = longs.findIndex(c => c.index === seed);
    const vals = ds.chans.map(c => { const j = longs.findIndex(x => x.index === c.index); return j < 0 || si < 0 ? NaN : M[si][j]; });
    const gm = D.fit($('cvConnMap'), w => Math.min(300, w * 0.66));
    st.cmap = D.probeMap(gm.ctx, ds, { x: 4, y: 4, w: gm.w - 8, h: gm.h - 8 }, { values: vals, range: 1, selected: seed, bad: res.bad, regions: NIRS.app.regionMarks() });
    D.bindProbe($('cvConnMap'), () => st.cmap, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); }, ci => `${S.ds.chans[ci].label}: r = ${isFinite(st.cvals[ci]) ? st.cvals[ci].toFixed(2) : '–'}`);
    st.cvals = vals;
    // numbers
    let sum = 0, cnt = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += M[i][j]; cnt++; }
    const pairReg = ds.regions.filter(r => r.kind === 'pair');
    let pr = '–', tru = '–', far = '–';
    if (pairReg.length >= 2) {
      const ri = ds.regions.indexOf(pairReg[0]), rj = ds.regions.indexOf(pairReg[1]);
      const best = ri2 => longs.map((c, j) => [c.per[ds.nL - 1].La[ri2], j]).sort((a, b) => b[0] - a[0])[0][1];
      const a = best(ri), b = best(rj);
      pr = `${M[a][b].toFixed(2)} (${longs[a].label} and ${longs[b].label})`;
      tru = NIRS.corr(ds.regionHb[pairReg[0].id].hbo, ds.regionHb[pairReg[1].id].hbo).toFixed(2);
      // pairs that see neither region
      const blind = longs.map((c, j) => [c.per[ds.nL - 1].La[ri] + c.per[ds.nL - 1].La[rj], j]).filter(x => x[0] < 0.005).map(x => x[1]);
      let s2 = 0, c2 = 0; for (let x = 0; x < blind.length; x++) for (let y = x + 1; y < blind.length; y++) { s2 += M[blind[x]][blind[y]]; c2++; }
      if (c2) far = (s2 / c2).toFixed(2);
    }
    ui.readouts($('connReadouts'), [
      ['Mean correlation, all channel pairs', cnt ? (sum / cnt).toFixed(2) : '–'],
      ['Between the channels over the two regions', pr], ['True correlation of the two regions', tru],
      ['Among channels that see neither region', far, 'should be near zero; anything else is systemic or artifactual']
    ]);
    const P = S.P;
    $('connText').innerHTML = `<p class="cap">${P.short === 'off'
      ? 'Without short-channel regression, the Mayer waves, breathing and slow fluctuations of the scalp are shared by every channel, so everything correlates with everything and the real network is hidden. Switch short-channel regression on (Processing tab) and look again.'
      : 'With the scalp signal regressed out, channels that see the coupled regions stand out from the rest. The brain\'s own share of the systemic physiology, which the short channels cannot see, still adds some correlation everywhere.'} The band-pass is ${P.hp || 'DC'} to ${P.lp || '∞'} Hz; resting-state analyses usually keep 0.01 to 0.1 Hz.</p>`;
  }

  function render() {
    if (!S.ds) return;
    ['avg', 'glm', 'conn'].forEach(v => { $('avPanel' + v[0].toUpperCase() + v.slice(1)).hidden = v !== st.view; });
    if (st.view === 'avg') renderAvg(); else if (st.view === 'glm') { NIRS.app.later(renderGlm); } else renderConn();
  }

  NIRS.tabs.averaging = {
    init() {
      ui.seg($('avViewSeg'), v => { st.view = v; render(); });
      ctl.n = ui.range('avN', v => String(v), v => { st.n = v; renderAvg(); });
      $('avCond').addEventListener('change', () => { st.cond = +$('avCond').value; st.n = null; render(); });
      $('glCond').addEventListener('change', () => { st.cond = +$('glCond').value; render(); });
      ['avTruth', 'avTrials', 'avCompare'].forEach(id => $(id).addEventListener('change', renderAvg));
      $('avPlay').addEventListener('click', play);
      ctl.hrf = ui.seg($('glHrfSeg'), v => { S.P.hrf = v; S.glm = null; render(); });
      ctl.noise = ui.seg($('glNoiseSeg'), v => { S.P.noise = v; S.glm = null; render(); });
      $('glDeriv').addEventListener('change', () => { S.P.deriv = $('glDeriv').checked; S.glm = null; render(); });
      ui.seg($('glMapSeg'), v => { st.mapKey = v; render(); });
      ui.seg($('glStatSeg'), v => { st.stat = v; render(); });
    },
    onBuild() {
      st.cond = 0; st.n = null; st.rawV = -1; st.connV = -1;
      ctl.hrf.set(S.P.hrf === 'off' ? 'canonical' : S.P.hrf); ctl.noise.set(S.P.noise); $('glDeriv').checked = S.P.deriv;
      if (!S.ds.conditions.length) { st.view = 'conn'; $('avViewSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === 'conn'))); }
      else if (st.view === 'conn' && !S.cfg.pairs.length) { st.view = 'avg'; $('avViewSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === 'avg'))); }
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
