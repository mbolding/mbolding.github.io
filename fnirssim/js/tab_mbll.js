/* fNIRS simulator: the Beer-Lambert tab.  Intensity -> optical density ->
   concentration for one channel, with the equation written out at a cursor,
   an adjustable DPF, and what the law's assumptions cost. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { sig: 'cortex', tc: null, cache: null, cacheKey: '' };
  let ctl = {};

  function cortexRec() {
    const key = S.version;
    if (st.cache && st.cacheKey === key) return st.cache;
    const brain = new Set(S.ds.groups.filter(g => g.kind === 'brain').map(g => g.id));
    st.cache = NIRS.assemble(S.ds, { enabled: brain, noise: false });
    st.cacheKey = key;
    return st.cache;
  }
  function setDpf(mode) {
    const P = S.P;
    if (mode === 'fixed') P.dpf = { mode: 'fixed', age: null, values: S.ds.lambdas.map((_, i) => (i === 0 ? ctl.d1.get() : ctl.d2.get())) };
    else if (mode === 'age') P.dpf = { mode: 'age', age: ctl.age.get(), values: null };
    else P.dpf = { mode: 'model', age: null, values: null };
    NIRS.app.run('conc');
  }
  const setDpfSoon = ui.debounce(() => setDpf(ctl.mode.get()), 150);

  function render() {
    if (!S.ds) return;
    const ds = S.ds, T = D.theme(), ch = ui.chSelect($('mbCh'));
    const c = ds.chans[ch], nL = ds.nL;
    const rec = st.sig === 'cortex' ? cortexRec() : S.rec;
    const I = rec.I[ch];
    const t = ds.t;
    const dpf = NIRS.dsp.dpfValues(ds, S.P, c);
    // sliders show what is in use
    if (ctl.mode.get() !== 'fixed') { ctl.d1.set(+dpf[0].toFixed(1)); if (dpf[1]) ctl.d2.set(+dpf[nL - 1].toFixed(1)); }
    const od = I.map(x => NIRS.dsp.od(x));
    const mb = NIRS.dsp.mbll(od, ds.lambdas, c.rho, dpf);
    if (st.tc === null || st.tc > ds.dur) {
      // default cursor: the cortical peak in this channel
      const cr = cortexRec(), o = NIRS.dsp.od(cr.I[ch][nL - 1]);
      let bi = 0; for (let i = 0; i < o.length; i++) if (o[i] > o[bi]) bi = i;
      st.tc = bi / ds.fs;
    }
    const ic = Math.min(ds.n - 1, Math.round(st.tc * ds.fs));
    const bands = D.taskBands(ds, 0, ds.dur), cur = [{ x: st.tc, color: T.ink, dash: [3, 3] }];
    const pct = I.map(x => { const m = NIRS.mean(x); return Float64Array.from(x, v => 100 * (v / m - 1)); });
    const lamS = (arr, scale, label) => ds.lambdas.map((l, li) => ({ y: arr[li], color: ui.lambdaColor(li), label: `${l} nm`, width: 1.3 }));
    const click = x => { st.tc = NIRS.clamp(x, 0, ds.dur); render(); };
    if (!st.p1) st.p1 = new D.Plot($('cvM1'), { height: 190, onClick: click });
    st.p1.draw({ x: t, xLabel: 'time (s)', yLabel: 'intensity (% of mean)', series: lamS(pct), bands, vlines: cur, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + '%' });
    ui.legend($('m1Legend'), ds.lambdas.map((l, li) => ({ color: ui.lambdaColor(li), label: `${l} nm, mean ${NIRS.fmtPower(NIRS.mean(I[li]))}` })));
    const odm = od.map(x => Float64Array.from(x, v => v * 1000));
    if (!st.p2) st.p2 = new D.Plot($('cvM2'), { height: 190, onClick: click });
    st.p2.draw({ x: t, xLabel: 'time (s)', yLabel: 'ΔOD (milli-OD)', series: lamS(odm), bands, vlines: cur, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + ' mOD' });
    ui.legend($('m2Legend'), ds.lambdas.map((l, li) => ({ color: ui.lambdaColor(li), label: `${l} nm` })));
    if (!st.p3) st.p3 = new D.Plot($('cvM3'), { height: 210, onClick: click });
    st.p3.draw({ x: t, xLabel: 'time (s)', yLabel: 'Δ concentration (µM)', series: [{ y: mb.hbo, color: T.hbo, label: 'HbO' }, { y: mb.hbr, color: T.hbr, label: 'HbR' }], bands, vlines: cur, tipX: x => ui.fmtT(x), tipFmt: v => v.toFixed(3) + ' µM' });
    ui.legend($('m3Legend'), [{ color: T.hbo, label: 'ΔHbO' }, { color: T.hbr, label: 'ΔHbR' }]);
    // the equation
    const E = ds.lambdas.map(l => NIRS.ext(l));
    const f = (v, d) => (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 3 : d);
    let txt = `at t = ${st.tc.toFixed(1)} s, channel ${c.label}, d = ${c.rho.toFixed(2)} cm\n\n`;
    ds.lambdas.forEach((l, li) => {
      txt += `ΔOD(${l}) = <span class="hi">${f(odm[li][ic], 3)} mOD</span> = ( <span class="o">${E[li][0].toFixed(0)}</span>·ΔHbO + <span class="r">${E[li][1].toFixed(0)}</span>·ΔHbR ) × ${c.rho.toFixed(2)} cm × DPF ${dpf[li].toFixed(2)} × 10⁻⁶\n`;
    });
    if (mb.Ei) txt += `\nsolve the ${nL} × 2 system:   <span class="o">ΔHbO = ${f(mb.hbo[ic])} µM</span>     <span class="r">ΔHbR = ${f(mb.hbr[ic])} µM</span>\n                          total ΔHbT = ${f(mb.hbo[ic] + mb.hbr[ic])} µM`;
    else txt += `\nOne equation cannot be solved for two unknowns.`;
    $('mbEq').innerHTML = txt;
    ui.readouts($('mbReadouts'), [
      ['DPF in use', dpf.map(v => v.toFixed(2)).join(' / ')],
      ['True DPF from the light model', c.per.map(q => q.dpf.toFixed(2)).join(' / '), 'mean pathlength divided by the separation, for this head and separation'],
      ['Condition number', NIRS.extCond(ds.lambdas).toFixed(1)]
    ]);
    partial(c, dpf, mb);
  }

  function partial(c, dpf, mb) {
    const ds = S.ds, T = D.theme(), li = ds.nL - 1, q = c.per[li];
    const g = D.fit($('cvPartial'), 150);
    const ctx = g.ctx, L0 = 120, R0 = g.w - 16, tot = q.L;
    const sx = v => L0 + v / Math.max(tot, c.rho * dpf[li]) * (R0 - L0);
    const row = (y, label) => { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(label, L0 - 8, y + 11); };
    // the real path, by layer
    let x = 0;
    row(14, 'where the path is');
    ds.layers.forEach((L, k) => {
      const v = q.Lk[k];
      ctx.fillStyle = T.layers[L.key]; ctx.fillRect(sx(x), 14, Math.max(0.5, sx(x + v) - sx(x)), 22);
      ctx.strokeStyle = T.surface; ctx.lineWidth = 2; ctx.strokeRect(sx(x), 14, Math.max(0.5, sx(x + v) - sx(x)), 22);
      if (sx(x + v) - sx(x) > 46) { ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.fillText(`${L.label.split(' ')[0]} ${v.toFixed(1)}`, (sx(x) + sx(x + v)) / 2, 25); }
      x += v;
    });
    const La = ds.regions.length ? q.La[0] : 0;
    // the region's share
    row(52, 'inside the active region');
    ctx.fillStyle = T.hbo; ctx.fillRect(L0, 52, Math.max(1.5, sx(La) - L0), 22);
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.fillText(La > 0 ? `${La.toFixed(2)} cm` : 'no active region', Math.max(L0, sx(La)) + 6, 63);
    row(90, 'what the law assumes');
    ctx.fillStyle = D.alpha(T.accent, 0.35); ctx.fillRect(L0, 90, sx(c.rho * dpf[li]) - L0, 22);
    ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.fillText(`${(c.rho * dpf[li]).toFixed(1)} cm (d × DPF), all of it changing equally`, L0 + 6, 101);
    ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.fillText(`${ds.lambdas[li]} nm · cm of mean path`, R0, g.h - 8);
    // text
    let html = '';
    if (ds.regions.length) {
      const rg = ds.regions[0], hb = ds.regionHb[rg.id];
      let pk = 0, pr = 0; for (let i = 0; i < hb.hbo.length; i++) { if (hb.hbo[i] > pk) pk = hb.hbo[i]; if (hb.hbr[i] < pr) pr = hb.hbr[i]; }
      const truthR = NIRS.app.truth();
      let mo = 0; const tc = truthR.conc[c.index].hbo; for (let i = 0; i < tc.length; i++) mo = Math.max(mo, tc[i]);
      const pvf = La / (c.rho * dpf[li]);
      html = `<p>In <strong>${rg.label}</strong> the haemoglobin really changes by up to <strong>+${pk.toFixed(1)} µM HbO</strong> and <strong>${pr.toFixed(1)} µM HbR</strong>.
        In this channel the Beer-Lambert law reports a peak of <strong>${mo >= 0 ? '+' : ''}${mo.toFixed(3)} µM</strong> HbO from the cortex (the part of the signal that came from the
        cortex, filtered the same way): ${mo > 0 ? `about <strong>${(pk / mo).toFixed(0)} times smaller</strong>` : 'nothing'}.</p>
        <p>The reason is the <strong>partial volume</strong>: only ${La.toFixed(2)} cm of the ${(c.rho * dpf[li]).toFixed(1)} cm path the law assumes lies in the active cortex
        (${(100 * pvf).toFixed(1)}%), so the change is diluted over the whole path. fNIRS concentrations are therefore always underestimates of the local change, and
        their size depends on the probe and the head as much as on the brain. Comparing amplitudes across channels, people or ages has to reckon with that.</p>`;
    } else html = '<p>This recording has no active region. Load an example with one to see how much of the cortical change the Beer-Lambert law recovers.</p>';
    const tr = c.per.map(q2 => q2.dpf), ratioT = tr[0] / tr[tr.length - 1], ratioA = dpf[0] / dpf[dpf.length - 1];
    html += `<p>The <strong>DPF</strong> in use is ${dpf.map(v => v.toFixed(2)).join(' / ')}; the light model's true value for this channel is ${tr.map(v => v.toFixed(2)).join(' / ')}.
      A DPF that is wrong by the same factor at every wavelength only rescales both concentrations. A wrong <em>ratio</em> between wavelengths
      (here ${ratioA.toFixed(2)} assumed against ${ratioT.toFixed(2)} true) mixes HbO into HbR and back: crosstalk.</p>`;
    $('mbPartialText').innerHTML = html;
  }

  NIRS.tabs.mbll = {
    init() {
      ui.seg($('mbSigSeg'), v => { st.sig = v; render(); });
      ctl.mode = ui.seg($('mbDpfSeg'), v => setDpf(v));
      ctl.d1 = ui.range('mbDpf1', v => v.toFixed(1), () => { ctl.mode.set('fixed'); setDpfSoon(); });
      ctl.d2 = ui.range('mbDpf2', v => v.toFixed(1), () => { ctl.mode.set('fixed'); setDpfSoon(); });
      ctl.age = ui.range('mbAge', v => v.toFixed(v < 2 ? 1 : 0) + ' y', () => { ctl.mode.set('age'); setDpfSoon(); });
    },
    onBuild() {
      st.tc = null; st.cache = null;
      const D0 = S.P.dpf;
      ctl.mode.set(D0.mode);
      ctl.age.set(D0.age === null || D0.age === undefined ? S.ds.head.age : D0.age);
      if (D0.mode === 'fixed') { ctl.d1.set(D0.values[0]); ctl.d2.set(D0.values[D0.values.length - 1]); }
      $('mbDpf1').previousElementSibling.firstChild.textContent = `DPF at ${S.ds.lambdas[0]} nm `;
      $('mbDpf2').previousElementSibling.firstChild.textContent = `DPF at ${S.ds.lambdas[S.ds.nL - 1]} nm `;
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
