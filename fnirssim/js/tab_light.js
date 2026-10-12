/* fNIRS simulator: the Light in tissue tab.  Photons from the Monte Carlo
   drawn over the diffusion-theory sensitivity, the separation trade-off,
   partial pathlengths, depth profiles and the time-of-flight distribution. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const SHORT = 0.8;
  const st = { head: 'adult', rho: 3, nm: 850, view: 'both', running: true, mc: null, anim: null, bg: null, key: '', lastStats: 0, curve: null, curveKey: '' };
  let ctl = {};
  const XR = [-1.3, 6.2], ZMAX = 2.6;

  function model() {
    const layers = NIRS.headLayers(st.head), ol = NIRS.opticalLayers(layers, st.nm);
    return { layers, ol, sol: NIRS.fluence(ol) };
  }
  function resetMC() {
    const M = model();
    st.M = M;
    st.mc = new NIRS.MC(M.ol, { rho: st.rho, aperture: st.rho < 1.2 ? 0.12 : 0.2, short: $('lightShort').checked ? SHORT : 0,
      grid: { x0: XR[0], x1: XR[1], nx: 150, zmax: ZMAX, nz: 56 }, keep: 60, seed: 17 });
    st.bg = null;
  }

  /* static layer: layers, diffusion banana(s), optodes */
  function background(w, h, rect) {
    const key = [w, h, st.head, st.rho, st.nm, st.view, $('lightShort').checked, D.theme().dark].join('|');
    if (st.bg && st.bgKey === key) return st.bg;
    const cv = document.createElement('canvas'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const T = D.theme();
    const map = D.crossSection(ctx, rect, st.M.layers, XR, ZMAX, { labels: true, labelSide: 'right' });
    if (st.view === 'both' || st.view === 'banana') {
      const nx = 220, nz = 80;
      const f = NIRS.sensitivityPlane(st.M.sol, st.rho, XR[0] - st.rho / 2, XR[1] - st.rho / 2, nx, ZMAX, nz);
      D.fieldImage(ctx, rect, f.data, nx, nz, T.photon, { decades: 3, maxAlpha: st.view === 'banana' ? 235 : 150 });
      if ($('lightShort').checked) {
        const g = NIRS.sensitivityPlane(st.M.sol, SHORT, XR[0] + SHORT / 2, XR[1] + SHORT / 2, nx, ZMAX, nz);
        D.fieldImage(ctx, rect, g.data, nx, nz, T.det, { decades: 2.5, maxAlpha: st.view === 'banana' ? 200 : 120 });
      }
    }
    D.optodeMarks(ctx, map, 0, $('lightShort').checked ? [st.rho, -SHORT] : st.rho, { srcLabel: 'source', detLabels: ['detector, ' + st.rho.toFixed(1) + ' cm', 'short, 8 mm'] });
    st.bg = cv; st.bgKey = key; st.map = map;
    return cv;
  }

  function drawLight() {
    const cv = $('cvLight');
    const width = cv.clientWidth || 800;
    const rectW = width - 70, h = Math.round(rectW / (XR[1] - XR[0]) * ZMAX) + 34;
    const { ctx, w } = D.fit(cv, h);
    const rect = { x: 52, y: 30, w: w - 66, h: h - 34 };
    const T = D.theme();
    if (!st.mc) resetMC();
    ctx.drawImage(background(w, h, rect), 0, 0, w, h);
    const map = st.map;
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    if (st.view === 'mc') {
      const g = st.mc.grid;
      D.fieldImage(ctx, { x: map.sx(g.x0), y: rect.y, w: map.sx(g.x1) - map.sx(g.x0), h: map.sz(g.zmax) - rect.y }, st.mc.density, g.nx, g.nz, T.photon, { decades: 2.5, maxAlpha: 240 });
    }
    if (st.view !== 'banana') {
      const path = (p, color, alpha, width) => {
        ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.beginPath();
        for (let i = 0; i < p.length; i += 2) { const X = map.sx(p[i]), Y = map.sz(p[i + 1]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
        ctx.stroke();
      };
      if (st.view !== 'mc') {
        st.mc.cloud.forEach(c => path(c.pts, T.muted, 0.18, 0.8));
        if ($('lightShort').checked) { const sp = st.mc.shortPaths.slice(-10); sp.forEach((c, i) => path(c.pts, T.det, 0.15 + 0.5 * (i + 1) / sp.length, 1)); }
      }
      const late = $('lightLate').checked, gate = ctl.gate.get();
      // only the most recent few, so the banana underneath stays visible
      const det = st.mc.detected.filter(d => !late || d.tof >= gate).slice(-24);
      const n = det.length;
      if (st.view !== 'mc') det.forEach((d, i) => path(d.pts, T.photon, 0.12 + 0.6 * Math.pow((i + 1) / n, 2), i === n - 1 ? 1.8 : 1));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(`${st.nm} nm · ${NIRS.HEADS[st.head].label} · the newest photon is drawn thickest`, rect.x + rect.w, 4);
    readouts();
  }

  function readouts() {
    const mcs = st.mc.stats(), pl = NIRS.pathlengths(st.M.sol, st.rho), ps = NIRS.pathlengths(st.M.sol, SHORT);
    const brain = L => (L.layers[3] + L.layers[4]) / L.total;
    const pw = 10e6 * pl.R * NIRS.DETECTOR_AREA * Math.pow(NIRS.HAIR.none.couple, 2);
    ui.readouts($('lightReadouts'), [
      ['Detected from 10 mW', NIRS.fmtPower(pw)],
      ['Mean path / DPF', `${pl.total.toFixed(1)} cm / ${pl.dpf.toFixed(2)}`],
      ['Share of path in the brain', (100 * brain(pl)).toFixed(1) + '%'],
      ['…for the 8 mm channel', (100 * brain(ps)).toFixed(2) + '%'],
      ['Photons launched', mcs.launched.toLocaleString()],
      ['Detected at ' + st.rho.toFixed(1) + ' cm', mcs.detected.toLocaleString()],
      ['Photon DPF', mcs.detected > 5 ? mcs.dpf.toFixed(2) : '–', 'From the detected Monte Carlo photons, weighted by absorption'],
      ['Photons’ mean deepest point', mcs.detected > 5 ? (mcs.meanDepth * 10).toFixed(1) + ' mm' : '–']
    ]);
  }

  /* trade-off curves, cached per head and wavelength */
  function curves() {
    const key = st.head + '|' + st.nm;
    if (st.curveKey === key && st.curve) return st.curve;
    const xs = [], R = [], br = [], dp = [];
    for (let r = 0.5; r <= 5.001; r += 0.25) {
      const p = NIRS.pathlengths(st.M.sol, r);
      xs.push(r); R.push(10e6 * p.R * NIRS.DETECTOR_AREA * Math.pow(NIRS.HAIR.none.couple, 2)); br.push(100 * (p.layers[3] + p.layers[4]) / p.total); dp.push(p.dpf);
    }
    st.curve = { xs: Float64Array.from(xs), R: Float64Array.from(R), br: Float64Array.from(br), dp: Float64Array.from(dp) };
    st.curveKey = key;
    return st.curve;
  }
  function drawTrade() {
    const T = D.theme(), c = curves();
    const pl = NIRS.pathlengths(st.M.sol, st.rho);
    const det = NIRS.DETECTORS.apd;
    if (!st.pTL) st.pTL = new D.Plot($('cvTradeLight'), { height: 190, margin: [12, 14, 34, 66] });
    st.pTL.draw({
      x: c.xs, yLog: true, xLabel: '', yLabel: 'detected power', yFmt: v => NIRS.fmtPowerTick(v),
      series: [{ y: c.R, color: T.accent, label: 'detected (10 mW)' }],
      hlines: [{ y: det.floor * 10, color: T.crit, dash: [4, 3] }],
      markers: [{ x: st.rho, y: 10e6 * pl.R * NIRS.DETECTOR_AREA * Math.pow(NIRS.HAIR.none.couple, 2), color: T.ink }],
      after: (ctx, m) => { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText('10 x APD noise floor', m.X1 - 4, m.sy(det.floor * 10) - 2); },
      tipX: x => `${x.toFixed(2)} cm`, tipFmt: v => NIRS.fmtPower(v)
    });
    if (!st.pTD) st.pTD = new D.Plot($('cvTradeDepth'), { height: 170, margin: [12, 14, 36, 66] });
    st.pTD.draw({
      x: c.xs, xLabel: 'source-detector separation (cm)', yLabel: 'path in brain (%)', yZero: true,
      series: [{ y: c.br, color: T.hbo, label: 'brain share of path' }],
      markers: [{ x: st.rho, y: 100 * (pl.layers[3] + pl.layers[4]) / pl.total, color: T.ink }],
      tipX: x => `${x.toFixed(2)} cm`, tipFmt: v => v.toFixed(1) + '%'
    });
  }

  function drawLayers() {
    const T = D.theme();
    const pl = NIRS.pathlengths(st.M.sol, st.rho), mcs = st.mc.stats();
    const g = D.fit($('cvLayerBars'), 190);
    const ctx = g.ctx, L0 = 96, R0 = g.w - 60, rowH = (g.h - 36) / 5;
    const max = Math.max(...pl.layers, ...(mcs.detected > 5 ? mcs.layerL : [0])) * 1.1 || 1;
    const sx = v => L0 + v / max * (R0 - L0);
    ctx.font = D.font(10);
    D.ticks(0, max, 5).forEach(v => { const x = Math.round(sx(v)) + 0.5; ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(x, 6); ctx.lineTo(x, g.h - 28); ctx.stroke(); ctx.fillStyle = T.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(v.toFixed(v < 2 ? 1 : 0), x, g.h - 24); });
    ctx.fillStyle = T.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('mean pathlength in the layer (cm)', (L0 + R0) / 2, g.h - 1);
    st.M.layers.forEach((L, i) => {
      const y = 8 + i * rowH;
      ctx.fillStyle = T.ink2; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(L.label, L0 - 8, y + rowH * 0.4);
      const bh = Math.min(10, rowH * 0.32);
      ctx.fillStyle = T.accent; ctx.fillRect(L0, y + rowH * 0.4 - bh - 1, Math.max(1, sx(pl.layers[i]) - L0), bh);
      if (mcs.detected > 5) { ctx.fillStyle = T.photon; ctx.fillRect(L0, y + rowH * 0.4 + 1, Math.max(1, sx(mcs.layerL[i]) - L0), bh); }
      ctx.fillStyle = T.ink2; ctx.textAlign = 'left';
      ctx.fillText(pl.layers[i].toFixed(2), sx(pl.layers[i]) + 4, y + rowH * 0.4 - bh / 2 - 1);
    });
    ctx.fillStyle = T.accent; ctx.fillRect(R0 - 30, 8, 9, 9); ctx.fillStyle = T.photon; ctx.fillRect(R0 - 30, 22, 9, 9);
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('diffusion', R0 - 17, 12.5); ctx.fillText('photons', R0 - 17, 26.5);
    // depth profile
    const ps = NIRS.pathlengths(st.M.sol, SHORT);
    const nz = pl.depth.length, dz = st.M.sol.dz;
    const xs = Float64Array.from({ length: nz }, (_, j) => (j + 0.5) * dz * 10);
    const nrm = a => { const m = Math.max(...a); return Float64Array.from(a, v => v / m); };
    if (!st.pDP) st.pDP = new D.Plot($('cvDepthProfile'), { height: 170, margin: [12, 14, 36, 50] });
    const vl = st.M.layers.filter(L => isFinite(L.z1)).map(L => ({ x: L.z1 * 10, color: T.layers.line, label: '' }));
    st.pDP.draw({
      x: xs, xRange: [0, 30], xLabel: 'depth below the scalp (mm)', yLabel: 'sensitivity (rel.)', yRange: [0, 1.05],
      series: [{ y: nrm(pl.depth), color: T.photon, label: st.rho.toFixed(1) + ' cm channel' }, { y: nrm(ps.depth), color: T.det, label: '8 mm channel', dash: [4, 3] }],
      vlines: vl, bands: [{ x0: NIRS.brainTop(st.M.layers) * 10, x1: 30, fill: D.alpha(T.hbo, 0.06), label: 'brain' }],
      tipX: x => `${x.toFixed(1)} mm`, tipFmt: v => v.toFixed(3)
    });
  }

  function drawTOF() {
    const T = D.theme(), mc = st.mc;
    const n = mc.tof.length, dt = mc.tofMax / n;
    const xs = Float64Array.from({ length: n }, (_, i) => (i + 0.5) * dt);
    const tot = mc.tof.reduce((a, b) => a + b, 0) || 1;
    const ys = Float64Array.from(mc.tof, v => v / tot / dt);
    const gate = ctl.gate.get();
    if (!st.pTOF) st.pTOF = new D.Plot($('cvTOF'), { height: 200 });
    st.pTOF.draw({
      x: xs, xLabel: 'time of flight (ns)', yLabel: 'photons per ns (fraction)', yZero: true, xRange: [0, 6],
      series: [{ y: ys, color: T.photon, label: 'detected photons', width: 2 }],
      bands: [{ x0: gate, x1: 8, fill: D.alpha(T.hbo, 0.07), label: 'late gate' }], vlines: [{ x: gate, color: T.hbo, dash: [4, 3] }],
      tipX: x => `${x.toFixed(2)} ns`, tipFmt: v => (v * 100).toFixed(1) + '%/ns'
    });
    const det = mc.detected, early = det.filter(d => d.tof < gate), late = det.filter(d => d.tof >= gate);
    const md = a => a.length ? (a.reduce((s, d) => s + d.depth * d.w, 0) / a.reduce((s, d) => s + d.w, 0) * 10).toFixed(1) + ' mm' : '–';
    let lateW = 0; for (let i = 0; i < n; i++) if ((i + 0.5) * dt >= gate) lateW += mc.tof[i];
    ui.readouts($('tofReadouts'), [
      ['Mean time of flight', mc.detected ? (mc.wL / mc.wDet / NIRS.C_TISSUE).toFixed(2) + ' ns' : '–'],
      ['Photons after the gate', (100 * lateW / tot).toFixed(0) + '%'],
      ['Deepest point, early photons', md(early)], ['Deepest point, late photons', md(late)]
    ]);
  }

  function loop() {
    if (S.tab !== 'light') { st.anim = null; return; }
    if (st.running && st.mc) st.mc.run(9);
    drawLight();
    const now = performance.now();
    if (now - st.lastStats > 600) { st.lastStats = now; drawLayers(); drawTOF(); }
    st.anim = requestAnimationFrame(loop);
  }
  function changed(resetCurves) {
    resetMC();
    if (resetCurves) st.curve = null;
    drawLight(); drawTrade(); drawLayers(); drawTOF();
  }
  const changedSoon = ui.debounce(() => changed(false), 120);

  NIRS.tabs.light = {
    init() {
      ui.seg($('lightHeadSeg'), v => { st.head = v; changed(true); });
      ctl.rho = ui.range('lightRho', v => v.toFixed(1) + ' cm', v => { st.rho = v; changedSoon(); });
      ctl.nm = ui.range('lightNm', v => v + ' nm', v => { st.nm = v; st.curve = null; changedSoon(); });
      ui.seg($('lightViewSeg'), v => { st.view = v; st.bg = null; drawLight(); });
      ctl.gate = ui.range('lightGate', v => v.toFixed(2) + ' ns', () => { drawTOF(); drawLight(); });
      $('mcPlay').addEventListener('click', () => { st.running = !st.running; $('mcPlay').textContent = st.running ? 'Pause photons' : 'Run photons'; });
      $('mcReset').addEventListener('click', () => changed(false));
      $('lightShort').addEventListener('change', () => changed(false));
      $('lightLate').addEventListener('change', drawLight);
      const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { st.running = false; $('mcPlay').textContent = 'Run photons'; }
    },
    onBuild() {
      if (!S.cfg) return;
      const nm = S.cfg.recording.wavelengths[S.cfg.recording.wavelengths.length - 1];
      st.head = S.cfg.head.model; st.nm = Math.round(nm);
      ctl.nm.set(st.nm);
      $('lightHeadSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.head)));
      const long = S.ds && S.ds.chans.find(c => !c.short);
      if (long) { st.rho = Math.round(long.rho * 10) / 10; ctl.rho.set(st.rho); }
      st.mc = null; st.curve = null;
    },
    render() { if (!st.mc) resetMC(); drawLight(); drawTrade(); drawLayers(); drawTOF(); },
    show() { if (!st.anim) st.anim = requestAnimationFrame(loop); },
    hide() { if (st.anim) cancelAnimationFrame(st.anim); st.anim = null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
