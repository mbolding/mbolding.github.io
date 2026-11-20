/* EEG simulator: the Localization tab.  The forward problem for one
   movable dipole, and a single-dipole inverse fit repeated over many
   noise draws to show how noise, electrode count, depth and the head
   model make the answer uncertain or wrong. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui, v3 = EEG.v3;
  const $ = ui.$, S = EEG.S;
  const st = { count: 32, grids: new Map(), result: null };
  const TRUE = () => EEG.headModel();
  const FIT_MODELS = {
    true: () => EEG.headModel(),
    homog: () => EEG.headModel({ homogeneous: true }),
    r80: () => { const s = EEG.HEAD.sigma.slice(); s[2] = s[0] / 80; return EEG.headModel({ sigma: s }); },
    r20: () => { const s = EEG.HEAD.sigma.slice(); s[2] = s[0] / 20; return EEG.headModel({ sigma: s }); }
  };

  function params() {
    const at = $('locAt').value, depth = parseFloat($('locDepth').value), tilt = parseFloat($('locTilt').value), dir = parseFloat($('locDir').value), amp = parseFloat($('locAmp').value);
    $('locDepthV').textContent = depth.toFixed(1) + ' cm'; $('locTiltV').textContent = tilt + '°'; $('locDirV').textContent = dir + '°'; $('locAmpV').textContent = amp + ' nAm';
    $('locNoiseV').textContent = parseFloat($('locNoise').value).toFixed(2) + ' µV';
    const pos = EEG.placeDipole(at, depth), ori = EEG.orientation(pos, tilt, dir, null);
    const srcs = [{ pos, ori, amp }];
    if ($('locSecond').checked) srcs.push({ pos: [-pos[0], pos[1], pos[2]], ori: [-ori[0], ori[1], ori[2]], amp });
    const labels = EEG.capLabels(st.count), U = labels.map(l => EEG.ELEC[l]);
    return { at, depth, tilt, dir, amp, pos, ori, srcs, labels, U };
  }
  function forwardMap(model, srcs, U) {
    const v = new Float64Array(U.length);
    srcs.forEach(s => { const f = EEG.forward(model, s.pos, v3.scale(s.ori, s.amp), U); for (let i = 0; i < v.length; i++) v[i] += f[i]; });
    return EEG.loc.avgRef(v);
  }
  function grid(key, U) {
    const k = key + '|' + U.length;
    if (!st.grids.has(k)) st.grids.set(k, EEG.loc.buildGrid(FIT_MODELS[key](), U, 0.7));
    return st.grids.get(k);
  }

  function headPair(cv, items, labels, height) {
    const { ctx, w } = D.fit(cv, height || (w => Math.min(260, w / 2 + 10)));
    const size = Math.min(w / 2, 250);
    const hvs = ['top', 'side'].map((view, i) => D.head(ctx, i * w / 2 + (w / 2 - size) / 2, 0, size, view, { labels: true, electrodes: view === 'top' ? labels : null }));
    items(ctx, hvs);
  }

  /* ---------- forward ---------- */
  function drawForward() {
    const p = params(), T = D.theme(), model = TRUE();
    headPair($('cvLocHeads'), (ctx, hvs) => hvs.forEach(hv => p.srcs.forEach((s, i) => D.dipole(ctx, hv, s.pos, s.ori, i ? T.series[4] : T.series[0], { len: 2.6 }))), p.labels);
    const v = forwardMap(model, p.srcs, p.U);
    D.topoCanvas($('cvLocForward'), p.labels, v, { unit: 'µV', maxH: 330, names: p.labels.length <= 32, title: `${p.labels.length} electrodes, average reference` });
    // extrema on a dense set of scalp points, exact
    const pts = EEG.topoGrid(40).pts;
    const dense = forwardMap(model, p.srcs, pts);
    let iMax = 0, iMin = 0; dense.forEach((x, i) => { if (x > dense[iMax]) iMax = i; if (x < dense[iMin]) iMin = i; });
    const sep = Math.acos(EEG.clamp(v3.dot(pts[iMax], pts[iMin]), -1, 1)) * EEG.HEAD.R;
    let iM = 0; v.forEach((x, i) => { if (Math.abs(x) > Math.abs(v[iM])) iM = i; });
    ui.readouts($('fwdReadouts'), [
      ['Largest at an electrode', `${p.labels[iM]} ${EEG.fmt(v[iM], 2)} µV`],
      ['Peak to peak on the scalp', EEG.fmt(dense[iMax] - dense[iMin], 2) + ' µV'],
      ['Between the two poles', sep.toFixed(1) + ' cm', 'great-circle distance between the scalp maximum and minimum'],
      ['RMS over electrodes', EEG.fmt(EEG.rms(v), 2) + ' µV'],
      ['Source depth', p.depth.toFixed(1) + ' cm', 'below the scalp']
    ]);
  }

  /* ---------- inverse ---------- */
  function runFit() {
    const p = params(), T = D.theme(), model = TRUE();
    const sigma = parseFloat($('locNoise').value), runs = parseInt($('locRuns').value, 10), key = $('locModel').value;
    const g = grid(key, p.U), vTrue = forwardMap(model, p.srcs, p.U);
    const fits = [];
    let first = null, measured = null;
    for (let r = 0; r < runs; r++) {
      const rng = EEG.rng(4242 + r);
      const v = Float64Array.from(vTrue, x => x + sigma * rng.gauss());
      const f = EEG.loc.fit(g, v, { landscape: r === 0 });
      if (r === 0) { first = f; measured = EEG.loc.avgRef(v); }
      fits.push(f);
    }
    st.result = { p, first, measured, fits, g, sigma, key, vTrue };
    drawInverse();
  }
  function drawInverse() {
    const R = st.result; if (!R) return;
    const T = D.theme(), p = R.p, f = R.first;
    const fitModel = FIT_MODELS[R.key]();
    const fitted = EEG.loc.avgRef(EEG.forward(fitModel, f.pos, f.q, p.U));
    const resid = R.measured.map((x, i) => x - fitted[i]);
    let mx = 0; R.measured.forEach(x => { mx = Math.max(mx, Math.abs(x)); });
    D.topoCanvas($('cvLocMeasured'), p.labels, R.measured, { range: mx, unit: 'µV', maxH: 240, title: 'measured (true + noise)', names: false });
    D.topoCanvas($('cvLocFitted'), p.labels, fitted, { range: mx, unit: 'µV', maxH: 240, title: 'best single dipole', names: false });
    D.topoCanvas($('cvLocResidual'), p.labels, resid, { range: mx, unit: 'µV', maxH: 240, title: 'residual (what it misses)', names: false });
    // head views with the truth and the cloud of fits
    const mean = [0, 0, 0]; R.fits.forEach(x => { for (let k = 0; k < 3; k++) mean[k] += x.pos[k] / R.fits.length; });
    headPair($('cvLocResult'), (ctx, hvs) => hvs.forEach(hv => {
      R.fits.forEach(x => { const [px, py] = hv.proj(x.pos); ctx.fillStyle = D.alpha(T.series[1], R.fits.length > 1 ? 0.5 : 0.9); ctx.beginPath(); ctx.arc(px, py, 3, 0, 2 * Math.PI); ctx.fill(); });
      p.srcs.forEach(s => D.dipole(ctx, hv, s.pos, s.ori, T.ink, { len: 2.6 }));
      D.dipole(ctx, hv, f.pos, v3.unit(f.q), T.series[1], { len: 2.6, width: 2 });
      if (R.fits.length > 1) { const [mx2, my2] = hv.proj(mean); ctx.strokeStyle = T.series[1]; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(mx2 - 5, my2 - 5); ctx.lineTo(mx2 + 5, my2 + 5); ctx.moveTo(mx2 + 5, my2 - 5); ctx.lineTo(mx2 - 5, my2 + 5); ctx.stroke(); }
    }), p.labels);
    ui.legend($('locLegend'), [{ color: T.ink, label: p.srcs.length > 1 ? 'true sources' : 'true source' }, { color: T.series[1], label: 'fit to the first noise draw' }].concat(R.fits.length > 1 ? [{ color: D.alpha(T.series[1], 0.5), label: `${R.fits.length} fits, one per noise draw (× marks their mean)`, dot: true }] : []));
    drawLandscape(R, fitModel);
    // numbers
    const err = x => v3.norm(v3.sub(x.pos, p.pos)) * 10;
    const errs = R.fits.map(err);
    const spread = Math.sqrt(R.fits.reduce((a, x) => a + v3.norm(v3.sub(x.pos, mean)) ** 2, 0) / R.fits.length) * 10;
    const snr = EEG.rms(R.vTrue) / (R.sigma || 1e-9);
    const pairs = [
      ['Error, first fit', errs[0].toFixed(1) + ' mm'],
      ['Depth error', ((EEG.depthOf(f.pos) - p.depth) * 10).toFixed(1) + ' mm', 'positive means the fit is too deep'],
      ['Goodness of fit', (f.gof * 100).toFixed(1) + '%', 'share of the measured map the fitted dipole explains'],
      ['Moment, fitted', EEG.fmt(v3.norm(f.q), 1) + ' nAm', `true ${p.amp} nAm${p.srcs.length > 1 ? ' each' : ''}`],
      ['Signal to noise', R.sigma ? snr.toFixed(1) : '∞', 'RMS of the true map over the noise per electrode']
    ];
    if (R.fits.length > 1) pairs.push(['Median error', errs.slice().sort((a, b) => a - b)[Math.floor(errs.length / 2)].toFixed(1) + ' mm'], ['Scatter of fits', spread.toFixed(1) + ' mm', 'RMS distance from their mean'], ['Bias', (v3.norm(v3.sub(mean, p.pos)) * 10).toFixed(1) + ' mm', 'distance from the true source to the mean fit']);
    ui.readouts($('invReadouts'), pairs);
  }
  function drawLandscape(R, fitModel) {
    const T = D.theme(), g = R.g, land = R.first.landscape, p = R.p;
    const cv = $('cvLocLandscape');
    const { ctx, w, h } = D.fit(cv, w => Math.min(280, w * 0.6));
    // horizontal slice through the true source
    const kz = Math.round(p.pos[2] / g.spacing);
    const n = 2 * g.lim + 1, m = Array.from({ length: n }, () => new Float32Array(n).fill(NaN));
    let lo = Infinity, hi = -Infinity;
    g.ijk.forEach(([i, j, k], idx) => { if (k !== kz) return; const v = Math.log10(Math.max(1e-5, land[idx])); m[g.lim - j][i + g.lim] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); });
    const size = Math.min(h - 26, w * 0.52), x0 = 6, y0 = 18;
    // low residual maps to the strong end of the sequential scale in either theme
    D.heat(ctx, x0, y0, size, size, m, v => isFinite(v) ? D.lutRGB(1 - (v - lo) / ((hi - lo) || 1), true).concat([255]) : [0, 0, 0, 0], true);
    const sc = size / (n * g.spacing), cx = x0 + size / 2, cy = y0 + size / 2;
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, Math.sqrt(Math.max(0, EEG.HEAD.brainR ** 2 - p.pos[2] ** 2)) * sc, 0, 2 * Math.PI); ctx.stroke();
    const plus = (x, y, col) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6); ctx.stroke(); };
    plus(cx + p.pos[0] * sc, cy - p.pos[1] * sc, T.ink);
    const fp = R.first.pos;
    ctx.strokeStyle = T.series[1]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx + fp[0] * sc, cy - fp[1] * sc, 5, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = T.ink2; ctx.font = D.font(11, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`slice at z = ${p.pos[2].toFixed(1)} cm (nose up)`, x0, 2);
    // residual along the radius through the true source
    const L = x0 + size + 46, Rr = w - 10, Y0 = y0 + 6, Y1 = y0 + size - 22;
    const dir = v3.unit(p.pos), depths = [], res = [];
    const vr = R.measured;
    for (let d = 1.3; d <= 7.5; d += 0.1) {
      const r = EEG.loc.residualAt(fitModel, p.U, v3.scale(dir, EEG.HEAD.R - d), vr);
      depths.push(d); res.push(r.resid / r.vv * 100);
    }
    const rmax = Math.max(...res, 1), sx = d => L + (d - 1.3) / (7.5 - 1.3) * (Rr - L), sy = v => Y1 - v / rmax * (Y1 - Y0);
    ctx.strokeStyle = T.grid; ctx.strokeRect(L + 0.5, Y0 + 0.5, Rr - L, Y1 - Y0);
    ctx.strokeStyle = T.series[0]; ctx.lineWidth = 2; ctx.beginPath(); depths.forEach((d, i) => { i ? ctx.lineTo(sx(d), sy(res[i])) : ctx.moveTo(sx(d), sy(res[i])); }); ctx.stroke();
    ctx.strokeStyle = T.ink; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(sx(p.depth), Y0); ctx.lineTo(sx(p.depth), Y1); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = T.ink2; ctx.font = D.font(11, 600); ctx.fillText('unexplained, along the radius', L, 2);
    ctx.font = D.font(10); ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    [2, 4, 6].forEach(d => ctx.fillText(d + ' cm', sx(d), Y1 + 3));
    ctx.fillText('depth below the scalp (dashed: true)', (L + Rr) / 2, Y1 + 15);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(rmax.toFixed(0) + '%', L - 4, Y0 + 4); ctx.fillText('0%', L - 4, Y1);
  }

  function render() {
    if (!$('locAt').options.length) ui.fill($('locAt'), EEG.DISPLAY_ORDER.filter(k => !['M1', 'M2'].includes(k)).map(k => ({ value: k, label: k })), 'P3');
    drawForward();
    EEG.app.later(runFit);
  }

  EEG.tabs.localization = {
    init() {
      ui.fill($('locAt'), EEG.DISPLAY_ORDER.filter(k => !['M1', 'M2'].includes(k)).map(k => ({ value: k, label: k })), 'P3');
      const refit = ui.debounce(() => EEG.app.later(runFit), 300);
      ['locAt', 'locDepth', 'locTilt', 'locDir', 'locAmp', 'locSecond'].forEach(id => $(id).addEventListener('input', () => { drawForward(); refit(); }));
      ['locNoise', 'locModel', 'locRuns'].forEach(id => $(id).addEventListener('input', () => { params(); refit(); }));
      ui.seg($('locCount'), n => { st.count = +n; drawForward(); refit(); });
      $('btnFit').addEventListener('click', () => EEG.app.later(runFit));
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
