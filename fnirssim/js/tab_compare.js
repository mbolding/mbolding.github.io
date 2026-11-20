/* fNIRS simulator: the fNIRS vs fMRI tab.  One neural event through the
   balloon model, then each modality's own measurement of it. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { stim: 'block' };
  let ctl = {};

  function model() {
    const dt = 0.05, dur = st.stim === 'block' ? 60 : 32, n = Math.round(dur / dt), t0 = 5, len = st.stim === 'block' ? 20 : 2;
    const u = new Float64Array(n);
    for (let i = Math.round(t0 / dt); i < Math.round((t0 + len) / dt); i++) u[i] = 1;
    const hb = NIRS.balloon(u, dt, ctl.flow.get(), { n: ctl.n.get(), alpha: ctl.alpha.get(), dip: $('cmpDip').checked });
    const t = Float64Array.from({ length: n }, (_, i) => i * dt - t0);
    return { t, u, hb, dt, len, n };
  }
  const pk = a => { let m = 0, im = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > Math.abs(m)) { m = a[i]; im = i; } return [m, im]; };

  function render() {
    const T = D.theme(), M = model(), hb = M.hb, t = M.t;
    const pct = (a, off) => Float64Array.from(a, v => 100 * (v - off));
    const band = [{ x0: 0, x1: M.len, fill: D.alpha(T.accent, 0.1), label: 'neural activity' }];
    if (!st.p1) st.p1 = new D.Plot($('cvCmpDrive'), { height: 230 });
    st.p1.draw({
      x: t, xLabel: 'time from stimulus onset (s)', yLabel: 'change from rest (%)',
      series: [{ y: pct(hb.f, 1), color: T.series[0], label: 'blood flow (CBF)' }, { y: pct(hb.m, 1), color: T.series[3], label: 'oxygen use (CMRO2)' }, { y: pct(hb.v, 1), color: T.series[2], label: 'venous volume (CBV)', dash: [5, 3] }],
      bands: band, tipX: x => `${x.toFixed(1)} s`, tipFmt: v => v.toFixed(1) + '%'
    });
    ui.legend($('cmpDriveLegend'), [{ color: T.series[0], label: 'CBF' }, { color: T.series[3], label: 'CMRO2' }, { color: T.series[2], label: 'CBV', dash: true }, { color: D.alpha(T.accent, 0.5), label: 'neural activity' }]);
    if (!st.p2) st.p2 = new D.Plot($('cvCmpHb'), { height: 230 });
    st.p2.draw({
      x: t, xLabel: 'time from stimulus onset (s)', yLabel: 'Δ concentration in tissue (µM)', yZero: true,
      series: [{ y: hb.hbo, color: T.hbo, label: 'HbO' }, { y: hb.hbr, color: T.hbr, label: 'HbR' }, { y: hb.hbt, color: T.hbt, label: 'HbT', dash: [5, 3] }],
      bands: band, tipX: x => `${x.toFixed(1)} s`, tipFmt: v => v.toFixed(2) + ' µM'
    });
    ui.legend($('cmpHbLegend'), [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }, { color: T.hbt, label: 'HbT', dash: true }]);
    // sampling
    const noise = $('cmpNoise').checked, TR = ctl.tr.get(), r = NIRS.rng(9);
    const [po] = pk(hb.hbo), [pr] = pk(hb.hbr), [pb] = pk(hb.bold);
    const fnirsDt = 0.1, step = Math.round(fnirsDt / M.dt);
    const ft = [], fo = [], fr = [];
    for (let i = 0; i < M.n; i += step) { ft.push(t[i]); fo.push(hb.hbo[i] / po + (noise ? 0.06 * r.gauss() : 0)); fr.push(-hb.hbr[i] / Math.abs(pr) + (noise ? 0.15 * r.gauss() : 0)); }
    const bt = [], bv = [];
    const trStep = Math.round(TR / M.dt), off = Math.round(((r.next() * TR) % TR) / M.dt);
    for (let i = off; i < M.n; i += trStep) { bt.push(t[i]); bv.push(hb.bold[i] / pb + (noise ? 0.06 * r.gauss() : 0)); }
    if (!st.p3) st.p3 = new D.Plot($('cvCmpSig'), { height: 270 });
    st.p3.draw({
      x: t, xLabel: 'time from stimulus onset (s)', yLabel: 'signal (each scaled to its peak)', yZero: true,
      series: [
        { x: Float64Array.from(ft), y: Float64Array.from(fo), color: T.hbo, width: 1.2, alpha: 0.85, label: 'fNIRS HbO (10 Hz)' },
        { x: Float64Array.from(ft), y: Float64Array.from(fr), color: T.hbr, width: 1.2, alpha: 0.85, label: 'fNIRS −HbR (10 Hz)' },
        { y: Float64Array.from(hb.bold, v => v / pb), color: T.bold, width: 1.2, dash: [4, 3], label: 'BOLD (underlying)' },
        { x: Float64Array.from(bt), y: Float64Array.from(bv), color: T.bold, width: 2.2, label: `fMRI BOLD (TR ${TR.toFixed(1)} s)` }
      ],
      markers: bt.map((x, i) => ({ x, y: bv[i], color: T.bold, r: 4 })),
      bands: band, tipX: x => `${x.toFixed(1)} s`, tipFmt: v => v.toFixed(2)
    });
    ui.legend($('cmpSigLegend'), [{ color: T.hbo, label: 'fNIRS HbO' }, { color: T.hbr, label: 'fNIRS −HbR' }, { color: T.bold, label: 'fMRI BOLD, sampled', dot: true }, { color: T.bold, label: 'BOLD, continuous', dash: true }]);
    const ttp = a => t[pk(a)[1]].toFixed(1) + ' s';
    const negHbr = Float64Array.from(hb.hbr, v => -v);
    let usO = 0, usB = 0; for (let i = Math.round((M.len + 5 + 6) / M.dt); i < M.n; i++) { usO = Math.min(usO, hb.hbo[i]); usB = Math.min(usB, hb.bold[i]); }
    let dip = 0; for (let i = Math.round(5 / M.dt); i < Math.round(7 / M.dt); i++) dip = Math.max(dip, hb.hbr[i]);
    ui.readouts($('cmpReadouts'), [
      ['Peak HbO / HbR', `+${po.toFixed(1)} / ${pr.toFixed(1)} µM`], ['HbO : HbR', (po / Math.abs(pr)).toFixed(1) + ' : 1'],
      ['Peak BOLD', '+' + (100 * pb).toFixed(2) + '%'], ['Time to peak HbO / HbR / BOLD', `${ttp(hb.hbo)} / ${ttp(negHbr)} / ${ttp(hb.bold)}`],
      ['Shape of −HbR vs BOLD', 'r = ' + NIRS.corr(negHbr, hb.bold).toFixed(3)],
      ['Samples during the response', `fNIRS ${Math.round((M.len + 15) / fnirsDt)}, fMRI ${Math.round((M.len + 15) / TR)}`],
      ['Post-stimulus undershoot (BOLD)', (100 * usB).toFixed(2) + '%'],
      ['Initial dip in HbR (first 2 s)', $('cmpDip').checked ? '+' + dip.toFixed(2) + ' µM' : 'off']
    ]);
    space();
  }

  function space() {
    const T = D.theme();
    const layers = NIRS.headLayers('adult');
    const cv = $('cvCmpSpace'), wpx = cv.clientWidth || 400;
    const xr = [-1.5, 4.5], zmax = 4;
    const g = D.fit(cv, Math.min(370, (wpx - 60) / (xr[1] - xr[0]) * zmax + 40));
    const rect = { x: 50, y: 34, w: g.w - 60, h: g.h - 38 };
    const map = D.crossSection(g.ctx, rect, layers, xr, zmax, { labelSide: 'right' });
    const sol = NIRS.fluence(NIRS.opticalLayers(layers, 850));
    const f = NIRS.sensitivityPlane(sol, 3, xr[0] - 1.5, xr[1] - 1.5, 160, zmax, 80);
    D.fieldImage(g.ctx, rect, f.data, 160, 80, T.photon, { decades: 2.5, maxAlpha: 230 });
    // fMRI voxels over the brain
    const ctx = g.ctx, bt = NIRS.brainTop(layers);
    ctx.strokeStyle = D.alpha(T.bold, 0.3); ctx.lineWidth = 0.6;
    for (let x = xr[0]; x <= xr[1] + 1e-9; x += 0.25) { ctx.beginPath(); ctx.moveTo(map.sx(x), map.sz(0)); ctx.lineTo(map.sx(x), map.sz(zmax)); ctx.stroke(); }
    for (let z = 0; z <= zmax + 1e-9; z += 0.25) { ctx.beginPath(); ctx.moveTo(map.sx(xr[0]), map.sz(z)); ctx.lineTo(map.sx(xr[1]), map.sz(z)); ctx.stroke(); }
    // one highlighted voxel in the cortex
    ctx.fillStyle = D.alpha(T.bold, 0.55); ctx.fillRect(map.sx(1.5), map.sz(1.5), map.sx(1.75) - map.sx(1.5), map.sz(1.75) - map.sz(1.5));
    D.optodeMarks(ctx, map, 0, 3, {});

  }

  NIRS.tabs.compare = {
    init() {
      ui.seg($('cmpStimSeg'), v => { st.stim = v; render(); });
      ctl.flow = ui.range('cmpFlow', v => Math.round(v * 100) + '%', render);
      ctl.n = ui.range('cmpN', v => v.toFixed(1), render);
      ctl.alpha = ui.range('cmpAlpha', v => v.toFixed(2), render);
      ctl.tr = ui.range('cmpTR', v => v.toFixed(1) + ' s', render);
      ['cmpDip', 'cmpNoise'].forEach(id => $(id).addEventListener('change', render));
    },
    onBuild() {
      const a = S.cfg.activations[0];
      if (a) { ctl.flow.set(Math.min(1, Math.max(0.1, a.flow))); ctl.n.set(a.n); $('cmpDip').checked = a.dip; }
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
