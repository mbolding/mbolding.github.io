/* MEG simulator: the MEG & EEG fields tab.  One current dipole that can be
   moved, tilted from tangential to radial and pushed deeper; the magnetic
   field around it and the volume currents through the head; the MEG field
   map and the EEG potential map side by side and overlaid; how the signal
   falls with tilt and depth for each sensor type; and what one sensor of
   each type can see. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, v3 = MEG.v3, S = MEG.S;
  const $ = ui.$;
  const st = { sens: 'mag', plots: {}, mapPts: {}, lfInit: false };
  const KINDS = [['mag', 'Magnetometer'], ['axial', 'Axial gradiometer'], ['planar', 'Planar gradiometer'], ['opm', 'OPM'], ['eeg', 'EEG electrode']];
  const U64 = () => MEG.EEG64.map(l => MEG.ELEC[l]);
  const models = new Map();
  function eegModel() {
    const homog = $('fdHomog').checked, ratio = parseFloat($('fdSkull').value);
    const key = homog ? 'h' : String(ratio);
    if (!models.has(key)) {
      const sigma = MEG.HEAD.sigma.slice(); sigma[2] = sigma[0] / ratio;
      models.set(key, homog ? MEG.headModel({ homogeneous: true }) : MEG.headModel({ sigma }));
    }
    return models.get(key);
  }
  const peakAbs = v => { let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i])); return m; };

  function geom() {
    const at = $('fdAt').value, depth = parseFloat($('fdDepth').value), tilt = parseFloat($('fdTilt').value), dir = parseFloat($('fdDir').value), amp = parseFloat($('fdAmp').value);
    const pos = MEG.placeAt(at, depth), ori = MEG.orientation(pos, tilt, dir), hint = MEG.orientation(pos, 90, dir);
    return { at, depth, tilt, dir, amp, pos, ori, q: v3.scale(ori, amp), hint };
  }
  function labels() {
    const g = geom();
    $('fdDepthV').textContent = g.depth.toFixed(1) + ' cm';
    const t = g.tilt;
    $('fdTiltV').textContent = `${t}°, ${t < 8 ? 'radial, outward' : t > 172 ? 'radial, inward' : Math.abs(t - 90) < 8 ? 'tangential' : t < 90 ? 'mostly radial' : 'tilted inward'}`.replace(/mostly radial/, t < 45 ? 'mostly radial' : 'mostly tangential');
    const d = ((g.dir % 360) + 360) % 360;
    const word = ['toward the nose', 'toward the right front', 'toward the right ear', 'toward the right back', 'toward the back', 'toward the left back', 'toward the left ear', 'toward the left front'][Math.round(d / 45) % 8];
    $('fdDirV').textContent = `${d}°, ${word}`;
    $('fdAmpV').textContent = g.amp + ' nAm';
    $('fdSkullV').textContent = '1 : ' + $('fdSkull').value;
    $('lfDepthV').textContent = parseFloat($('lfDepth').value).toFixed(1) + ' cm';
    return g;
  }

  // The readings of one array for the dipole, and the values per site to map.
  function megMap(type, g, mode) {
    const arr = MEG.getArray(type), v = MEG.forwardMEG(arr.channels, g.pos, g.q);
    const sv = D.siteValues(arr, v, type === 'planar' ? mode : null);
    const kind = type === 'planar' ? (mode === 'mag' ? 'mag' : 'planar') : type;
    let peak = 0; arr.channels.forEach((c, i) => { if (c.kind === kind) peak = Math.max(peak, Math.abs(v[i])); });
    return { arr, v, sv, unit: kind === 'planar' ? 'fT/cm' : 'fT', peak };
  }
  // A small arrow (or a dot for a radial dipole) where the dipole sits under the map.
  function dipoleMark(ctx, out, g, T) {
    const p0 = D.mapXY(g.pos, out.cx, out.cy, out.r);
    const tang = v3.sub(g.ori, v3.scale(v3.unit(g.pos), v3.dot(g.ori, v3.unit(g.pos))));
    const tl = v3.norm(tang);
    ctx.save();
    if (tl > 0.15) {
      const t = v3.scale(tang, 1 / tl);
      const a = D.mapXY(v3.sub(g.pos, v3.scale(t, 1.2)), out.cx, out.cy, out.r), b = D.mapXY(v3.add(g.pos, v3.scale(t, 1.2)), out.cx, out.cy, out.r);
      ctx.strokeStyle = T.card; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      D.arrow(ctx, a[0], a[1], b[0], b[1], T.series[1], 2.4, 8);
    }
    if (tl < 0.97) { ctx.strokeStyle = T.series[1]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p0[0], p0[1], 5, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.restore();
  }
  function eegGrid(g, res) {
    const grid = D.grid(res), model = eegModel();
    const Vg = MEG.forwardEEG(model, g.pos, g.q, grid.pts), V64 = MEG.forwardEEG(model, g.pos, g.q, U64());
    const m = MEG.mean(V64);
    const vals = Float32Array.from(Vg, x => x - m);
    for (let i = 0; i < V64.length; i++) V64[i] -= m;
    return { grid, vals, V64 };
  }

  function drawPlanes(g) {
    const T = D.theme();
    const sigma = MEG.HEAD.sigma.slice(); sigma[2] = sigma[0] / parseFloat($('fdSkull').value);
    MEG.views.magneticPlane($('cvFieldB'), { r0: g.pos, q: g.q, dirHint: g.hint, primary: $('fdPrimary').checked, lines: $('fdLines').checked, helmet: $('fdHelmet').checked, opm: st.sens === 'opm', height: w => Math.min(400, w * 0.92) });
    MEG.views.electricPlane($('cvFieldJ'), { r0: g.pos, q: g.q, dirHint: g.hint, sigma, homogeneous: $('fdHomog').checked, height: w => Math.min(400, w * 0.92), lines: 16 });
    const radial = g.tilt < 3 || g.tilt > 177;
    $('fdBCap').innerHTML = $('fdPrimary').checked
      ? 'Only the primary current\'s own field (Biot-Savart), as if the head were not a conductor. Compare with the full field: outside a spherical head the volume currents cancel the part of this field that a radial current makes, exactly.'
      : (radial ? '<strong>A radial dipole makes no magnetic field outside a spherical head:</strong> its primary current\'s field is cancelled exactly by that of the volume currents. Tick "Primary current only" to see what is cancelled.'
        : 'Colour is the strength of the field in this plane on a logarithmic scale; lines follow its direction. The tangential part of the current flows out of the page at the dipole. Outside the head the field is that of the whole head, primary and volume currents together. Orange squares are the coils near this plane.');
    void T;
  }

  function drawMaps(g) {
    const T = D.theme();
    const mode = $('fdPlanarShow').value;
    const mm = megMap(st.sens, g, mode);
    const seq = st.sens === 'planar' && mode === 'rms';
    const title = st.sens === 'planar' ? { rms: 'Planar gradient, length', a: 'Gradiometers a (front-back)', b: 'Gradiometers b (across)' }[mode] : MEG.SENSOR_INFO[st.sens].label;
    const fmtU = v => MEG.fmt(v, Math.abs(v) < 10 ? 1 : 0);
    const o1 = D.topoCanvas($('cvFdMEG'), D.sites(), mm.sv, { unit: mm.unit, maxH: 300, title: 'MEG: ' + title, sequential: seq, range: seq ? [0, peakAbs(mm.sv) || 1] : (peakAbs(mm.sv) || 1), fmt: fmtU, selected: st.site, floor0: seq });
    dipoleMark(o1.ctx, o1, g, T);
    st.mapPts.meg = o1.xy;
    // EEG, computed at every pixel of the map
    const e = eegGrid(g, 72);
    const pe = peakAbs(e.V64);
    const o2 = D.gridCanvas($('cvFdEEG'), e.grid, e.vals, { unit: 'µV', maxH: 300, title: 'EEG: potential, average reference', range: peakAbs(e.vals) || 1, fmt: v => MEG.fmt(v, Math.abs(v) < 10 ? 2 : 1) });
    MEG.EEG64.forEach(l => { const [x, y] = D.mapXY(MEG.ELEC[l], o2.cx, o2.cy, o2.r); o2.ctx.fillStyle = D.alpha(T.ink, 0.7); o2.ctx.beginPath(); o2.ctx.arc(x, y, 1.3, 0, 2 * Math.PI); o2.ctx.fill(); });
    dipoleMark(o2.ctx, o2, g, T);
    // overlay: EEG colour, magnetometer contours
    const mag = megMap('mag', g, null);
    const o3 = D.gridCanvas($('cvFdBoth'), e.grid, e.vals, { unit: 'µV', maxH: 300, title: 'EEG colour, MEG contour lines', range: peakAbs(e.vals) || 1, contours: false, fmt: v => MEG.fmt(v, Math.abs(v) < 10 ? 2 : 1) });
    const c = D.topoInterp(D.sites(), e.grid.res), res = e.grid.res;
    const full = new Float32Array(res * res).fill(NaN);
    for (let p = 0; p < e.grid.idx.length; p++) { let s = 0; const off = p * c.n; for (let j = 0; j < c.n; j++) s += c.W[off + j] * mag.sv[j]; full[e.grid.idx[p]] = s; }
    const pm = peakAbs(mag.sv);
    if (pm > 1e-6) {
      const step = D.ticks(0, pm, 4)[1] || pm / 3;
      const levels = []; for (let k = 1; k * step < pm; k++) levels.push(k * step, -k * step);
      D.contours(o3.ctx, full, res, o3.cx, o3.cy, o3.r, levels, T.ink);
    }
    dipoleMark(o3.ctx, o3, g, T);
    st.mapPts.both = MEG.SITES.map(s => D.mapXY(s.u, o3.cx, o3.cy, o3.r));
    // readouts: the angle between the two patterns' axes, at the source
    const u0 = v3.unit(g.pos);
    const axis = (pMax, pMin) => { const d = v3.sub(pMax, pMin); return v3.sub(d, v3.scale(u0, v3.dot(d, u0))); };
    // extrema of both maps on the same grid (the MEG map interpolated between the sites)
    let mMax = -1, mMin = -1; e.grid.idx.forEach((q, p) => { const x = full[q]; if (mMax < 0 || x > full[e.grid.idx[mMax]]) mMax = p; if (mMin < 0 || x < full[e.grid.idx[mMin]]) mMin = p; });
    let gMax = 0, gMin = 0; e.vals.forEach((x, i) => { if (x > e.vals[gMax]) gMax = i; if (x < e.vals[gMin]) gMin = i; });
    const aM = axis(e.grid.pts[mMax], e.grid.pts[mMin]), aE = axis(e.grid.pts[gMax], e.grid.pts[gMin]);
    const ang = pm > 1e-3 * (mm.peak + 1e-9) && v3.norm(aM) > 0 && v3.norm(aE) > 0 ? Math.acos(MEG.clamp(Math.abs(v3.dot(aM, aE)) / (v3.norm(aM) * v3.norm(aE)), 0, 1)) / Math.PI * 180 : NaN;
    const sepM = Math.acos(MEG.clamp(v3.dot(e.grid.pts[mMax], e.grid.pts[mMin]), -1, 1)) * MEG.HEAD.R;
    const sepE = Math.acos(MEG.clamp(v3.dot(e.grid.pts[gMax], e.grid.pts[gMin]), -1, 1)) * MEG.HEAD.R;
    const radialShare = Math.abs(v3.dot(g.ori, u0));
    ui.readouts($('fdReadouts'), [
      ['MEG peak', ui.fmtV(mm.peak, mm.unit), MEG.SENSOR_INFO[st.sens].label],
      ['EEG peak', MEG.fmt(pe, pe < 10 ? 2 : 1) + ' µV', '64 electrodes, average reference'],
      ['Angle between the maps', isFinite(ang) ? Math.round(ang) + '°' : 'no MEG field', 'between the line joining the two MEG extrema and the line joining the two EEG extrema'],
      ['MEG extrema apart', pm > 1e-3 ? sepM.toFixed(1) + ' cm' : '–', 'magnetometers, measured along the scalp; grows with depth'],
      ['EEG extrema apart', sepE.toFixed(1) + ' cm'],
      ['Radial part of the moment', Math.round(radialShare * 100) + '%', 'invisible to MEG in a spherical head']
    ]);
  }

  function drawCurves(g) {
    const T = D.theme(), model = eegModel(), U = U64();
    const megPeak = (type, pos, q) => {
      const arr = MEG.getArray(type), v = MEG.forwardMEG(arr.channels, pos, q), kind = type === 'planar' ? 'planar' : type;
      let m = 0; arr.channels.forEach((c, i) => { if (c.kind === kind) m = Math.max(m, Math.abs(v[i])); }); return m;
    };
    const eegPeak = (pos, q) => { const v = MEG.forwardEEG(model, pos, q, U), m = MEG.mean(v); let p = 0; v.forEach(x => { p = Math.max(p, Math.abs(x - m)); }); return p; };
    // tilt
    const ts = [], tm = [], te = [];
    for (let t = 0; t <= 180; t += 3) { const q = v3.scale(MEG.orientation(g.pos, t, g.dir), g.amp); ts.push(t); tm.push(megPeak('mag', g.pos, q)); te.push(eegPeak(g.pos, q)); }
    const nm = Math.max(...tm) || 1, ne = Math.max(...te) || 1;
    if (!st.plots.tilt) st.plots.tilt = new D.Plot($('cvFdTilt'), { height: 230 });
    st.plots.tilt.draw({
      x: ts, xRange: [0, 180], yRange: [0, 105], xTicks: [0, 30, 60, 90, 120, 150, 180], xLabel: 'tilt from radial (degrees)', yLabel: '% of the largest',
      series: [{ y: tm.map(v => 100 * v / nm), color: T.series[0], label: 'MEG' }, { y: te.map(v => 100 * v / ne), color: T.series[1], label: 'EEG' }],
      vlines: [{ x: g.tilt, color: T.muted, dash: [4, 3] }], bands: [{ x0: 0, x1: 8, label: 'radial' }, { x0: 82, x1: 98, label: 'tangential' }, { x0: 172, x1: 180 }],
      tipFmt: v => v.toFixed(0) + '%', tipX: x => Math.round(x) + '° from radial'
    });
    ui.legend($('fdTiltLegend'), [{ color: T.series[0], label: 'MEG (any sensor type)' }, { color: T.series[1], label: 'EEG' }]);
    // depth
    const ds = [], cols = { mag: [], axial: [], planar: [], opm: [], eeg: [] };
    for (let d = 1.4; d <= 8.61; d += 0.2) {
      const pos = MEG.placeAt(g.at, d), q = v3.scale(MEG.orientation(pos, g.tilt, g.dir), g.amp);
      ds.push(d);
      ['mag', 'axial', 'planar', 'opm'].forEach(k => cols[k].push(megPeak(k, pos, q)));
      cols.eeg.push(eegPeak(pos, q));
    }
    const rel = a => a.map(v => v / (a[0] || 1));
    if (!st.plots.depth) st.plots.depth = new D.Plot($('cvFdDepth'), { height: 230 });
    const radial = g.tilt < 2 || g.tilt > 178;
    st.plots.depth.draw({
      x: ds, xRange: [1.4, 8.6], yLog: true, yRange: [1e-3, 1.5], xLabel: 'depth below the scalp (cm)', yLabel: 'relative to 1.4 cm deep',
      series: radial ? [{ y: rel(cols.eeg), color: T.series[1], label: 'EEG' }] : [
        { y: rel(cols.mag), color: T.series[0], label: 'magnetometers' }, { y: rel(cols.axial), color: T.series[2], label: 'axial gradiometers' },
        { y: rel(cols.planar), color: T.series[3], label: 'planar gradiometers' }, { y: rel(cols.opm), color: T.series[4], label: 'OPMs' }, { y: rel(cols.eeg), color: T.series[1], label: 'EEG' }],
      vlines: [{ x: g.depth, color: T.muted, dash: [4, 3] }, { x: MEG.HEAD.R - MEG.HEAD.brainR, label: 'brain surface', color: T.grid }],
      tipFmt: v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%', tipX: x => x.toFixed(1) + ' cm deep'
    });
    ui.legend($('fdDepthLegend'), radial ? [{ color: T.series[1], label: 'EEG (a radial dipole has no MEG field at any depth)' }] : [{ color: T.series[0], label: 'magnetometers' }, { color: T.series[2], label: 'axial gradiometers' }, { color: T.series[3], label: 'planar gradiometers' }, { color: T.series[4], label: 'OPMs' }, { color: T.series[1], label: 'EEG' }]);
  }

  /* ---------- what one sensor sees ---------- */
  function lfMaps() {
    const T = D.theme(), si = parseInt($('lfSite').value, 10), depth = parseFloat($('lfDepth').value), rc = MEG.HEAD.R - depth;
    const grid = D.grid(44), npt = grid.pts.length;
    const box = $('lfGrid');
    if (!st.lfInit) {
      box.innerHTML = KINDS.map(([k, name]) => `<div class="lf"><canvas id="lf_${k}" class="click"></canvas><b>${name}</b><span id="lfA_${k}"></span></div>`).join('');
      KINDS.forEach(([k]) => $('lf_' + k).addEventListener('click', ev => pickFromMap(ev, $('lf_' + k), 'lf')));
      st.lfInit = true;
    }
    const site = MEG.SITES[si];
    // nearest EEG electrode to the site
    let el = MEG.EEG64[0], bd = -2; MEG.EEG64.forEach(l => { const d = v3.dot(MEG.ELEC[l], site.u); if (d > bd) { bd = d; el = l; } });
    const U = U64(), model = eegModel(), ei = MEG.EEG64.indexOf(el);
    // area weights of the map's pixels on the cortex sphere
    const TH = MEG.THETA_MAX, cell = Math.pow(2 / grid.res, 2);
    const wts = grid.pts.map(u => { const th = Math.acos(MEG.clamp(u[2], -1, 1)); return (th > 1e-6 ? Math.sin(th) / th : 1) * TH * TH * cell * rc * rc; });
    KINDS.forEach(([k]) => {
      const vals = new Float32Array(npt);
      let chan = null;
      if (k !== 'eeg') { const arr = MEG.getArray(k); chan = arr.channels[arr.siteChannels[si][k === 'planar' ? 1 : 0]]; }
      const L3 = new Float64Array(3);
      for (let p = 0; p < npt; p++) {
        const pos = v3.scale(grid.pts[p], rc);
        if (k === 'eeg') {
          const L = MEG.leadfieldEEG(model, pos, U);
          let mx = 0, my = 0, mz = 0; for (let e = 0; e < U.length; e++) { mx += L[3 * e]; my += L[3 * e + 1]; mz += L[3 * e + 2]; }
          mx /= U.length; my /= U.length; mz /= U.length;
          vals[p] = Math.hypot(L[3 * ei] - mx, L[3 * ei + 1] - my, L[3 * ei + 2] - mz);
        } else { MEG.leadfieldMEG([chan], pos, L3); vals[p] = Math.hypot(L3[0], L3[1], L3[2]); }
      }
      let mx = 0; vals.forEach(v => { mx = Math.max(mx, v); });
      let area = 0; vals.forEach((v, p) => { if (v >= 0.5 * mx) area += wts[p]; });
      const out = D.gridCanvas($('lf_' + k), grid, vals, { sequential: true, range: [0, mx || 1], colorbar: false, maxH: 190, contours: false, size: w => Math.min(w, 190) });
      const [x, y] = k === 'eeg' ? D.mapXY(MEG.ELEC[el], out.cx, out.cy, out.r) : D.mapXY(site.u, out.cx, out.cy, out.r);
      [[T.card, 4], [T.crit, 1.6]].forEach(([c, lw]) => { out.ctx.strokeStyle = c; out.ctx.lineWidth = lw; out.ctx.beginPath(); out.ctx.moveTo(x - 6, y); out.ctx.lineTo(x - 2.5, y); out.ctx.moveTo(x + 2.5, y); out.ctx.lineTo(x + 6, y); out.ctx.moveTo(x, y - 6); out.ctx.lineTo(x, y - 2.5); out.ctx.moveTo(x, y + 2.5); out.ctx.lineTo(x, y + 6); out.ctx.stroke(); });
      st.mapPts['lf_' + k] = MEG.SITES.map(s => D.mapXY(s.u, out.cx, out.cy, out.r));
      $('lfA_' + k).textContent = `${k === 'eeg' ? el + ': ' : ''}${area.toFixed(0)} cm² above half`;
    });
  }
  function pickFromMap(ev, cv, which) {
    const pts = st.mapPts[which === 'lf' ? cv.id : which]; if (!pts) return;
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = -1, bd = 400;
    pts.forEach((p, j) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; best = j; } });
    if (best < 0) return;
    st.site = best; $('lfSite').value = String(best);
    lfMaps();
    drawMaps(geom());
  }

  function fillFrom() {
    const opts = [{ value: '', label: 'a free dipole' }];
    if (S.ds) S.ds.gens.forEach((gn, i) => { if (gn.kind === 'source') opts.push({ value: String(i), label: gn.label }); });
    const cur = $('fdFrom').value;
    ui.fill($('fdFrom'), opts, opts.some(o => o.value === cur) ? cur : '');
  }
  function applyFrom() {
    const i = $('fdFrom').value; if (i === '' || !S.ds) return;
    const gn = S.ds.gens[+i]; if (!gn) return;
    const place = MEG.nearestPlace(gn.pos), depth = MEG.depthOf(gn.pos), ang = MEG.orientationAngles(gn.pos, gn.ori);
    $('fdAt').value = place; $('fdDepth').value = depth.toFixed(1); $('fdTilt').value = Math.round(ang.tilt); $('fdDir').value = Math.round(ang.dir) % 360;
    const src = S.cfg.sources.find(s => s.name === gn.group);
    if (src && src.amp) $('fdAmp').value = Math.min(100, Math.max(1, Math.round(Math.abs(src.amp))));
  }

  function render() {
    const g = labels();
    fillFrom();
    if (st.site === null || st.site === undefined) {
      let best = 0, bd = -2; MEG.SITES.forEach((s, j) => { const d = v3.dot(s.u, v3.unit(g.pos)); if (d > bd) { bd = d; best = j; } });
      st.site = best; $('lfSite').value = String(best);
    }
    drawPlanes(g); drawMaps(g); drawCurves(g); lfMaps();
  }
  const redraw = ui.debounce(() => { const g = labels(); drawPlanes(g); drawMaps(g); drawCurves(g); }, 60);

  MEG.tabs.fields = {
    needsData: false,
    init() {
      ui.fill($('fdAt'), MEG.PLACES.slice().sort().map(p => ({ value: p, label: p })), 'C3');
      ui.fill($('lfSite'), MEG.SITES.map((s, j) => ({ value: String(j), label: s.name })));
      ui.seg($('fdSensSeg'), v => { st.sens = v; $('fdPlanarShow').hidden = v !== 'planar'; const g = labels(); drawMaps(g); drawPlanes(g); });
      $('fdPlanarShow').hidden = true;
      $('fdPlanarShow').addEventListener('change', () => drawMaps(geom()));
      ['fdAt', 'fdDepth', 'fdTilt', 'fdDir', 'fdAmp', 'fdSkull', 'fdHomog'].forEach(id => $(id).addEventListener('input', () => { $('fdFrom').value = ''; labels(); redraw(); }));
      ['fdLines', 'fdPrimary', 'fdHelmet'].forEach(id => $(id).addEventListener('change', () => drawPlanes(geom())));
      $('fdFrom').addEventListener('change', () => { applyFrom(); labels(); redraw(); });
      ['fdSkull', 'fdHomog'].forEach(id => $(id).addEventListener('input', ui.debounce(lfMaps, 120)));
      $('lfSite').addEventListener('change', () => { st.site = parseInt($('lfSite').value, 10); lfMaps(); drawMaps(geom()); });
      $('lfDepth').addEventListener('input', ui.debounce(() => { labels(); lfMaps(); }, 80));
      $('cvFdMEG').classList.add('click'); $('cvFdBoth').classList.add('click');
      $('cvFdMEG').addEventListener('click', ev => pickFromMap(ev, $('cvFdMEG'), 'meg'));
      $('cvFdBoth').addEventListener('click', ev => pickFromMap(ev, $('cvFdBoth'), 'both'));
    },
    onBuild() { fillFrom(); },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
