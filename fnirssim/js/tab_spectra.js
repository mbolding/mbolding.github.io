/* fNIRS simulator: the Wavelengths tab.  Absorption spectra, the
   extinction matrix and its conditioning, every pair at once, and the
   crosstalk a poor choice produces. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { condMap: null, condKey: '' };
  let ctl = {};
  const GM = NIRS.TISSUES.gray;

  function lambdas() {
    const l = [ctl.l1.get(), ctl.l2.get()];
    if ($('spUse3').checked) l.push(ctl.l3.get());
    if (st.single) return [ctl.l1.get()];
    return l;
  }
  // Relative OD noise at each wavelength from the light that survives 3 cm of
  // a head-like medium (shot-noise limited: noise grows as 1/sqrt(light)).
  function odNoise(nm) {
    if (!$('spLight').checked) return 1;
    const mix = nm2 => {
      const a = 0.5 * NIRS.tissueMua(NIRS.TISSUES.scalp, nm2) + 0.5 * NIRS.tissueMua(GM, nm2);
      const s = 0.5 * NIRS.tissueMusp(NIRS.TISSUES.scalp, nm2) + 0.5 * NIRS.tissueMusp(GM, nm2);
      return NIRS.homogCW(a, s, 3);
    };
    return Math.sqrt(mix(800) / mix(nm));
  }
  function gains(ls) {
    const Ei = NIRS.mbllInverse(NIRS.mbllMatrix(ls, 3, 6));
    if (!Ei) return null;
    const sig = ls.map(odNoise);
    return Ei.map(row => 1e-3 * Math.sqrt(row.reduce((s, v, k) => s + v * v * sig[k] * sig[k], 0)));
  }

  function drawSpectra() {
    const T = D.theme(), ls = lambdas();
    const nm = [], ao = [], ar = [], aw = [], at = [], eo = [], er = [];
    for (let x = 600; x <= 1000; x += 2) {
      nm.push(x);
      const e = NIRS.ext(x);
      const o = Math.LN10 * 1e-6 * e[0] * GM.hbo, r = Math.LN10 * 1e-6 * e[1] * GM.hbr, w = GM.water * NIRS.waterMua(x);
      ao.push(o); ar.push(r); aw.push(w); at.push(o + r + w); eo.push(e[0]); er.push(e[1]);
    }
    const vl = ls.map((l, i) => ({ x: l, color: T.ink, width: 1.5, label: `λ${i + 1} ${l}` }));
    if (!st.pAbs) st.pAbs = new D.Plot($('cvAbs'), { height: 270, onClick: x => moveNearest(x) });
    st.pAbs.draw({
      x: Float64Array.from(nm), xLabel: 'wavelength (nm)', yLabel: 'absorption µa (1/cm)', yLog: true, yRange: [1e-3, 30],
      series: [
        { y: Float64Array.from(at), color: T.trace, width: 1.2, dash: [2, 2], label: 'total' },
        { y: Float64Array.from(ao), color: T.hbo, label: 'HbO (55 µM)' }, { y: Float64Array.from(ar), color: T.hbr, label: 'HbR (25 µM)' },
        { y: Float64Array.from(aw), color: T.water, label: 'water (80%)' }
      ],
      bands: [{ x0: 650, x1: 950, fill: D.alpha(T.good, 0.06) }], vlines: vl,
      after: (ctx, m) => { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('near-infrared window', m.sx(800), m.Y1 - 4); },
      tipX: x => `${x.toFixed(0)} nm`, tipFmt: v => v.toFixed(4) + ' /cm'
    });
    ui.legend($('absLegend'), [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }, { color: T.water, label: 'water' }, { color: T.trace, label: 'total', dash: true }]);
    const sub = nm.map((x, i) => i).filter(i => nm[i] >= 650 && nm[i] <= 950);
    if (!st.pExt) st.pExt = new D.Plot($('cvExt'), { height: 270, onClick: x => moveNearest(x) });
    st.pExt.draw({
      x: Float64Array.from(sub.map(i => nm[i])), xLabel: 'wavelength (nm)', yLabel: 'extinction (1/cm/M)', yRange: [0, 3600],
      series: [{ y: Float64Array.from(sub.map(i => eo[i])), color: T.hbo, label: 'HbO' }, { y: Float64Array.from(sub.map(i => er[i])), color: T.hbr, label: 'HbR' }],
      vlines: vl.concat([{ x: NIRS.ISOSBESTIC, color: T.muted, dash: [3, 3], label: 'isosbestic ' + NIRS.ISOSBESTIC.toFixed(0) }]),
      markers: ls.flatMap(l => { const e = NIRS.ext(l); return [{ x: l, y: e[0], color: T.hbo }, { x: l, y: e[1], color: T.hbr }]; }),
      tipX: x => `${x.toFixed(0)} nm`, tipFmt: v => v.toFixed(0)
    });
    ui.legend($('extLegend'), [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }]);
  }
  function moveNearest(x) {
    const c = [ctl.l1, ctl.l2].concat($('spUse3').checked ? [ctl.l3] : []);
    let best = c[0], bd = Infinity;
    c.forEach(k => { const d = Math.abs(k.get() - x); if (d < bd) { bd = d; best = k; } });
    best.set(Math.round(NIRS.clamp(x, 600, 1000)));
    st.single = false;
    renderAll();
  }

  function drawMatrix() {
    const ls = lambdas(), T = D.theme();
    const E = ls.map(l => NIRS.ext(l));
    const f0 = v => v.toFixed(0).padStart(6);
    let txt = `  ΔOD(λ)  =  [ ε_HbO(λ)   ε_HbR(λ) ] · [ ΔHbO ΔHbR ]ᵀ · d · DPF\n\n`;
    ls.forEach((l, i) => { txt += `  ${String(l).padStart(4)} nm   [ <span class="o">${f0(E[i][0])}</span>   <span class="r">${f0(E[i][1])}</span> ]   ratio HbR/HbO ${(E[i][1] / E[i][0]).toFixed(2)}\n`; });
    const cond = ls.length >= 2 ? NIRS.extCond(ls) : Infinity;
    const g = ls.length >= 2 ? gains(ls) : null, gRef = gains([760, 850]);
    txt += `\n  condition number  <span class="hi">${isFinite(cond) ? cond.toFixed(1) : '∞ (cannot be solved)'}</span>`;
    $('spMatrix').innerHTML = txt;
    ui.readouts($('spReadouts'), [
      ['Noise in ΔHbO per mOD', g ? g[0].toFixed(3) + ' µM' : '–'], ['Noise in ΔHbR per mOD', g ? g[1].toFixed(3) + ' µM' : '–'],
      ['…relative to 760 / 850 nm', g ? `${(g[0] / gRef[0]).toFixed(1)}× / ${(g[1] / gRef[1]).toFixed(1)}×` : '–'],
      ['Wavelengths below the isosbestic point', `${ls.filter(l => l < NIRS.ISOSBESTIC - 3).length} of ${ls.length}`]
    ]);
    let msg, cls;
    const below = ls.filter(l => l < NIRS.ISOSBESTIC - 3).length, above = ls.filter(l => l > NIRS.ISOSBESTIC + 3).length;
    if (ls.length < 2) { msg = '<strong>One wavelength, two unknowns.</strong> Any change in light could be HbO, HbR, or any mix of the two: there is one equation and no unique answer. Early single-wavelength instruments could only report "total attenuation".'; cls = 'bad'; }
    else if (cond > 12) { msg = `<strong>Nearly parallel equations.</strong> ${below === 0 || above === 0 ? 'Both wavelengths are on the same side of the isosbestic point, so HbO and HbR absorb in almost the same ratio at each.' : 'The two absorb in too similar a ratio at these wavelengths.'} The solution exists but amplifies noise ${g ? (Math.max(g[0] / gRef[0], g[1] / gRef[1])).toFixed(0) + ' times' : ''} more than 760 / 850, and any error in the pathlengths turns HbO into HbR.`; cls = 'bad'; }
    else if (ls.some(l => l < 680 || l > 920)) { msg = '<strong>Well conditioned, but light is scarce.</strong> Near the edges of the window, haemoglobin (below 680 nm) or water (above 920 nm) absorbs so much that far less light gets through, and the noise per measurement rises; tick "count the light" to include it.'; cls = ''; }
    else { msg = '<strong>A good pair.</strong> One wavelength on each side of the isosbestic point: at the shorter one HbR dominates, at the longer one HbO does, so the two equations are nearly independent.'; cls = 'good'; }
    $('spCallout').innerHTML = `<div class="callout ${cls}">${msg}</div>`;
  }

  function condMap() {
    const key = $('spLight').checked ? 'L' : 'N';
    if (st.condMap && st.condKey === key) return st.condMap;
    const lo = 650, hi = 950, step = 5, n = Math.round((hi - lo) / step) + 1;
    const m = new Array(n);
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      m[j] = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const a = lo + i * step, b = lo + j * step;
        const g = Math.abs(a - b) < 4 ? null : gains([a, b]);
        const v = g ? Math.hypot(g[0], g[1]) : Infinity;
        m[j][i] = v; if (v < best) best = v;
      }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) m[j][i] = m[j][i] / best;
    st.condMap = { m, lo, hi, step, n }; st.condKey = key;
    return st.condMap;
  }
  function drawCond() {
    const T = D.theme(), C = condMap(), ls = lambdas();
    const cv = $('cvCond');
    const { ctx, w, h } = D.fit(cv, w => Math.min(380, w));
    const L = 46, B = 34, side = Math.min(w - L - 70, h - B - 8);
    const rect = { x: L, y: 6, w: side, h: side };
    const rows = [];
    for (let j = C.n - 1; j >= 0; j--) rows.push(C.m[j]);
    // quality: 1 at the best pair, falling with the log of the amplification
    D.heat(ctx, rect.x, rect.y, rect.w, rect.h, rows, v => {
      if (!isFinite(v)) return D.hexRgb(T.surface);
      const q = NIRS.clamp(1 - Math.log10(v) / 1.5, 0, 1);
      return D.lutRGB(q, true);
    }, false);
    ctx.strokeStyle = T.axis; ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);
    const sx = l => rect.x + (l - C.lo) / (C.hi - C.lo) * rect.w, sy = l => rect.y + rect.h - (l - C.lo) / (C.hi - C.lo) * rect.h;
    ctx.fillStyle = T.muted; ctx.font = D.font(10);
    [650, 700, 750, 800, 850, 900, 950].forEach(l => {
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(l, sx(l), rect.y + rect.h + 4);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(l, rect.x - 4, sy(l));
    });
    ctx.fillStyle = T.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('wavelength 1 (nm)', rect.x + rect.w / 2, h - 1);
    ctx.save(); ctx.translate(10, rect.y + rect.h / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('wavelength 2 (nm)', 0, 0); ctx.restore();
    ctx.strokeStyle = T.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(sx(NIRS.ISOSBESTIC), rect.y); ctx.lineTo(sx(NIRS.ISOSBESTIC), rect.y + rect.h); ctx.moveTo(rect.x, sy(NIRS.ISOSBESTIC)); ctx.lineTo(rect.x + rect.w, sy(NIRS.ISOSBESTIC)); ctx.stroke(); ctx.setLineDash([]);
    if (ls.length >= 2) {
      const x = sx(NIRS.clamp(ls[0], 650, 950)), y = sy(NIRS.clamp(ls[1], 650, 950));
      ctx.strokeStyle = T.crit; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.moveTo(x, y - 7); ctx.lineTo(x, y + 7); ctx.stroke();
    }
    // colour key
    const kx = rect.x + rect.w + 14, kh = rect.h;
    for (let i = 0; i < kh; i++) { const q = 1 - i / kh; const c = D.lutRGB(q, true); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(kx, rect.y + i, 12, 1.5); }
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('best', kx + 16, rect.y); ctx.textBaseline = 'middle'; ctx.fillText('5×', kx + 16, rect.y + kh * (Math.log10(5) / 1.5)); ctx.textBaseline = 'bottom'; ctx.fillText('30× worse', kx + 16, rect.y + kh);
    st.condRect = { rect, sx, sy, C };
  }

  function drawCross() {
    const T = D.theme(), ls = lambdas();
    const fs = 10, n = 600;
    const u = new Float64Array(n); for (let i = 50; i < 250; i++) u[i] = 1;
    const hb = NIRS.balloon(u, 1 / fs, 0.5);
    const k = 0.04;   // the response as a 3 cm channel's Beer-Lambert estimate would see it
    const tO = Float64Array.from(hb.hbo, v => v * k), tR = Float64Array.from(hb.hbr, v => v * k);
    const t = Float64Array.from({ length: n }, (_, i) => i / fs - 5);
    const sig = ctl.noise.get() * 1e-3, err = ctl.dpf.get() / 100;
    const run = (L, cv, plotKey, title) => {
      const dpfTrue = L.map((_, i) => 6 * (1 + (L.length > 1 ? (i === 0 ? err / 2 : -err / 2) : 0)));
      const Etrue = NIRS.mbllMatrix(L, 3, dpfTrue), Ei = NIRS.mbllInverse(NIRS.mbllMatrix(L, 3, 6));
      const r = NIRS.rng(4);
      const od = L.map((l, li) => Float64Array.from({ length: n }, (_, i) => Etrue[li][0] * tO[i] + Etrue[li][1] * tR[i] + sig * odNoise(l) * r.gauss()));
      const series = [];
      if (Ei) {
        const rO = Float64Array.from({ length: n }, (_, i) => od.reduce((s, x, l) => s + Ei[0][l] * x[i], 0));
        const rR = Float64Array.from({ length: n }, (_, i) => od.reduce((s, x, l) => s + Ei[1][l] * x[i], 0));
        series.push({ y: rO, color: T.hbo, label: 'recovered HbO', width: 1.2, alpha: 0.8 }, { y: rR, color: T.hbr, label: 'recovered HbR', width: 1.2, alpha: 0.8 });
      }
      // the truth goes on top, so the noise cannot hide it
      series.push({ y: tO, color: T.ink, dash: [5, 4], width: 1.6, label: 'true HbO' }, { y: tR, color: T.ink2, dash: [2, 3], width: 1.6, label: 'true HbR' });
      if (!st[plotKey]) st[plotKey] = new D.Plot(cv, { height: 230 });
      st[plotKey].draw({
        x: t, xLabel: 'time from block onset (s)', yLabel: 'ΔHb (µM)', yRange: [-0.35, 0.75], series, title: title + (Ei ? '' : '  (cannot be solved)'),
        bands: [{ x0: 0, x1: 20, fill: D.alpha(T.accent, 0.07) }], tipX: x => `${x.toFixed(1)} s`, tipFmt: v => v.toFixed(3) + ' µM'
      });
    };
    run([760, 850], $('cvCrossA'), 'pA', '760 / 850 nm');
    run(ls, $('cvCrossB'), 'pB', ls.join(' / ') + ' nm');
    ui.legend($('crossLegend'), [{ color: T.hbo, label: 'HbO recovered' }, { color: T.hbr, label: 'HbR recovered' }, { color: T.ink, label: 'true HbO', dash: true }, { color: T.ink2, label: 'true HbR', dash: true }]);
  }

  function renderAll() { $('spL3').disabled = !$('spUse3').checked; drawSpectra(); drawMatrix(); drawCond(); drawCross(); }

  NIRS.tabs.spectra = {
    init() {
      ctl.l1 = ui.range('spL1', v => v + ' nm', () => { st.single = false; renderAll(); });
      ctl.l2 = ui.range('spL2', v => v + ' nm', () => { st.single = false; renderAll(); });
      ctl.l3 = ui.range('spL3', v => v + ' nm', renderAll);
      ctl.noise = ui.range('spNoise', v => v.toFixed(2) + ' mOD', drawCross);
      ctl.dpf = ui.range('spDpfErr', v => (v > 0 ? '+' : '') + v + '%', drawCross);
      $('spUse3').addEventListener('change', renderAll);
      $('spLight').addEventListener('change', renderAll);
      $('spPresets').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const p = b.dataset.p.split(',').map(Number);
        st.single = p.length === 1;
        ctl.l1.set(p[0]); if (p[1]) ctl.l2.set(p[1]);
        $('spUse3').checked = false;
        renderAll();
      }));
      $('cvCond').addEventListener('click', e => {
        if (!st.condRect) return;
        const r = $('cvCond').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, R = st.condRect;
        if (x < R.rect.x || x > R.rect.x + R.rect.w || y < R.rect.y || y > R.rect.y + R.rect.h) return;
        const l1 = R.C.lo + (x - R.rect.x) / R.rect.w * (R.C.hi - R.C.lo), l2 = R.C.lo + (R.rect.y + R.rect.h - y) / R.rect.h * (R.C.hi - R.C.lo);
        ctl.l1.set(Math.round(l1)); ctl.l2.set(Math.round(l2)); st.single = false; renderAll();
      });
      $('cvCond').style.cursor = 'crosshair';
      $('btnUseLambda').addEventListener('click', () => {
        const ls = lambdas().map(Math.round);
        NIRS.app.setRecordingOption('wavelengths', `wavelengths ${ls.join(' ')} nm`);
        $('useLambdaNote').textContent = `Rebuilt at ${ls.join(' / ')} nm.`;
      });
    },
    onBuild() {
      const L = S.cfg.recording.wavelengths;
      st.single = L.length === 1;
      ctl.l1.set(Math.round(L[0])); if (L[1]) ctl.l2.set(Math.round(L[1]));
      $('spUse3').checked = L.length === 3; if (L[2]) ctl.l3.set(Math.round(L[2]));
    },
    render: renderAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
