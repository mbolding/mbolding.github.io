/* MEG simulator: the Source estimation tab.

   1. Coregistration.  Three landmarks marked on the template MRI line it up
      with the head frame the MEG was localized in; fitting the digitized
      head shape to the MRI's scalp (ICP) can refine it.
   2. The data.  A forward model, one or two dipoles in the sphere, plus
      background brain activity and sensor noise, averaged over trials; or
      the average of this recording after everything the other tabs did.
   3. Three inverse solutions of the same data: a dipole fit, a minimum-norm
      estimate and an LCMV beamformer, drawn on the MRI through the
      coregistration, next to where the sources really are. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S, v3 = MEG.v3, I = MEG.inverse, M = MEG.mri;
  const $ = ui.$;
  const FIDS = ['NAS', 'LPA', 'RPA'];
  const FID_LABEL = { NAS: 'Nasion', LPA: 'Left ear', RPA: 'Right ear' };
  const PLANES = ['axial', 'coronal', 'sagittal'];
  const AXIS = { axial: 'z', coronal: 'y', sagittal: 'x' };
  const HALF = 11.5;                          // half the width of an MRI slice, cm
  let C0 = M.apply(M.TRUE, [0, 0, 0]);        // the head's centre in MRI coordinates (set again when the MRI changes)
  const ABORT = { abort: true };
  const mm = d => (isFinite(d) ? `${Math.round(d * 10)} mm` : 'none');
  const cm3 = x => `${x < 10 ? x.toFixed(1) : Math.round(x)} cm³`;
  const st = {
    fid: 'NAS', marks: null, digi: {}, T: null, Tinv: null, careless: 0,
    mode: 'scenario', preset: 'aud1', src: null, lat: 0.1, data: null,
    models: new Map(), stats: null, wh: null, fitC: null, lcmvC: null, res: null,
    gen: 0, auto: false, needs: false, timer: null, slices: new Map(), views: new Map(), plots: {}
  };

  /* ---------- MRI slices ---------- */
  function sliceImg(plane, at, res) {
    const key = `${plane}|${at.toFixed(2)}|${res}`;
    let img = st.slices.get(key);
    if (!img) {
      img = M.slice(plane, at, res, HALF);
      st.slices.set(key, img);
      if (st.slices.size > 48) st.slices.delete(st.slices.keys().next().value);
    }
    return img;
  }
  const fixedOf = (plane, m) => (plane === 'axial' ? m[2] : plane === 'coronal' ? m[1] : m[0]);
  // Canvas pixel -> MRI point on the slice, and back.
  function pxToMRI(view, px, py) {
    const a = -HALF + px / view.w * 2 * HALF, b = HALF - py / view.w * 2 * HALF;
    if (view.plane === 'axial') return [C0[0] + a, C0[1] + b, view.at];
    if (view.plane === 'coronal') return [C0[0] + a, view.at, C0[2] + b];
    return [view.at, C0[1] - a, C0[2] + b];
  }
  function mriToPx(view, m) {
    const q = M.slicePixel(view.plane, m, 1, HALF);
    return { x: q.x * view.w, y: q.y * view.w, off: q.off - view.at };
  }
  // Full strength on the slice, faint within a centimetre of it, hidden beyond.
  const nearness = off => (Math.abs(off) < 0.35 ? 1 : Math.abs(off) < 1.2 ? 0.4 : 0);
  function hexRGB(c) {
    if (c.startsWith('#')) { const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }
    const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : [255, 255, 255];
  }
  const ON_IMAGE = 'rgba(255,255,255,0.85)';

  function drawMRI(cv, plane, at, res, opts) {
    opts = opts || {};
    const { ctx, w } = D.fit(cv, w => w);
    const view = { plane, at, w, res, info: opts.info || null };
    D.slice(ctx, 0, 0, w, sliceImg(plane, at, res), res, opts.overlay ? opts.overlay(view) : null);
    st.views.set(cv, view);
    ctx.font = D.font(10, 600); ctx.fillStyle = ON_IMAGE; ctx.textBaseline = 'middle';
    const ends = plane === 'sagittal' ? ['A', 'P'] : ['L', 'R'];
    ctx.textAlign = 'left'; ctx.fillText(ends[0], 5, w / 2);
    ctx.textAlign = 'right'; ctx.fillText(ends[1], w - 5, w / 2);
    ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`${plane}, ${M.coordName ? M.coordName + ' ' : ''}${AXIS[plane]} = ${Math.round(M.mm(at))} mm`, 6, 5);
    if (opts.title) { ctx.textAlign = 'right'; ctx.font = D.font(10, 600); ctx.fillText(opts.title, w - 6, 5); }
    if (opts.draw) opts.draw(ctx, m => mriToPx(view, m), view);
    return view;
  }
  function cross(ctx, x, y, r, color, alpha, lw) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.lineWidth = (lw || 2) + 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
    ctx.lineWidth = lw || 2; ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke();
    ctx.restore();
  }
  function ring(ctx, x, y, r, color, alpha, label) {
    ctx.save(); ctx.globalAlpha = alpha;
    if (alpha < 1) ctx.setLineDash([3, 2]);
    ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);
    if (label) { ctx.font = D.font(10, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.strokeText(label, x + r + 1, y - r + 3); ctx.fillStyle = color; ctx.fillText(label, x + r + 1, y - r + 3); }
    ctx.restore();
  }
  function dot(ctx, x, y, r, color, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* ---------- 1. coregistration ---------- */
  const trueFid = k => M.apply(M.TRUE, M.FID[k]);
  const exactMarks = () => { const m = {}; FIDS.forEach(k => { m[k] = trueFid(k); }); return m; };
  // The head-frame "up" (toward the vertex) in MRI coordinates.
  let UP = v3.sub(M.apply(M.TRUE, [0, 0, 1]), C0);
  function digi() {
    const nose = $('coNose').checked;
    if (!st.digi[nose]) st.digi[nose] = M.digitize(3, { nose });
    return st.digi[nose];
  }
  function coregister() {
    if (!st.marks) st.marks = exactMarks();
    // ICP counts each landmark as one more head-shape point, so the shape can overrule a bad mark
    st.T = M.coregister(digi(), st.marks, { icp: $('coICP').checked, fidWeight: 1 }).T;
    st.Tinv = M.invert(st.T);
  }
  const toAnatomy = p => M.apply(M.TRUE_INV, M.apply(st.T, p));     // where a head-frame point is drawn, in the true anatomy
  const placeName = p => M.label(toAnatomy(p));

  function coregRender() {
    const T = D.theme();
    coregister();
    const srcs = trueSources();
    const which = $('coSlice').value;
    const c = which === 'fid' ? st.marks[st.fid] : which === 'src' && srcs.length ? M.apply(M.TRUE, srcs[0].pos) : C0;
    const colors = { NAS: T.series[6], LPA: T.series[1], RPA: T.series[3] };
    const pts = $('coPoints').checked ? digi().pts.map(p => M.apply(st.T, p)) : [];
    const ptCol = T.series[4];
    ['cvMriAx', 'cvMriCor', 'cvMriSag'].forEach((id, k) => {
      const plane = PLANES[k];
      drawMRI($(id), plane, fixedOf(plane, c), 176, {
        draw(ctx, px) {
          pts.forEach(m => { const q = px(m); if (Math.abs(q.off) > 0.45) return; dot(ctx, q.x, q.y, 2.3, ptCol, 1); });
          srcs.forEach((s, i) => {
            const qt = px(M.apply(M.TRUE, s.pos)), qe = px(M.apply(st.T, s.pos));
            const at = nearness(qt.off), ae = nearness(qe.off);
            if (at) ring(ctx, qt.x, qt.y, 7, T.series[2], at, srcs.length > 1 ? String(i + 1) : null);
            if (ae) dot(ctx, qe.x, qe.y, 3.2, T.series[0], ae);
          });
          FIDS.forEach(f => { const q = px(st.marks[f]); const a = nearness(q.off); if (a) cross(ctx, q.x, q.y, f === st.fid ? 9 : 6, colors[f], a, f === st.fid ? 2.6 : 1.8); });
        }
      });
    });
    const leg = FIDS.map(f => ({ color: colors[f], label: `${FID_LABEL[f].toLowerCase()} as marked`, dot: true }));
    if (pts.length) leg.push({ color: ptCol, label: 'digitized head shape', dot: true });
    if (srcs.length) leg.push({ color: T.series[2], label: 'a true source, where it is', dot: true }, { color: T.series[0], label: 'where this transform draws it', dot: true });
    ui.legend($('coLegend'), leg);
    const errF = f => v3.norm(v3.sub(st.marks[f], trueFid(f)));
    // over the brain's surface, where a rotation error is largest
    let worst = 0; M.rim.forEach(p => { worst = Math.max(worst, M.errorAt(st.T, p)); });
    const pairs = FIDS.map(f => [`${FID_LABEL[f]} marked`, mm(errF(f)), `How far the ${FID_LABEL[f].toLowerCase()} mark is from the true landmark on the MRI`]);
    pairs.push(['Head shape fit', mm(M.surfaceFit(st.T, digi())), 'RMS distance of the digitized head-shape points from the MRI scalp']);
    if (srcs.length) pairs.push(['Error at the source', mm(M.errorAt(st.T, srcs[0].pos)), 'How far from its true place on the anatomy a perfect estimate of source 1 would be drawn']);
    pairs.push(['Largest in the cortex', mm(worst), 'The largest displacement anywhere on the brain’s surface']);
    ui.readouts($('coReadouts'), pairs);
  }
  // A new transform redraws everything drawn through it; nothing needs recomputing.
  function coregChanged() { coregRender(); rowsRender(); }

  /* ---------- 2. the data ----------
     The scenarios start from the built-in generators' sites on the template:
     Heschl's gyri and the hand area of somatosensory cortex. */
  const GS = MEG.GEN_SITES, siteDepth = p => MEG.HEAD.R - v3.norm(p);
  const AUD_L = GS.audL, AUD_R = GS.audR;
  const tang = (p, d) => v3.unit(v3.sub(d, v3.scale(v3.unit(p), v3.dot(d, v3.unit(p)))));
  // Auditory currents flow down through the supratemporal plane; elsewhere tangential and forward.
  const ORI = { aud: p => tang(p, [0, 0.3, -1]), fwd: p => MEG.orientation(p, 90, 0) };
  const PRESETS = {
    aud1: { s: [{ dir: AUD_L, depth: siteDepth(AUD_L), ori: 'aud' }], amp: 30 },
    som: { s: [{ dir: GS.s1L, depth: siteDepth(GS.s1L), ori: 'fwd' }], amp: 20 },
    deep: { s: [{ dir: GS.s1L, depth: 5, ori: 'fwd' }], amp: 40 },
    aud2: { s: [{ dir: AUD_L, depth: siteDepth(AUD_L), ori: 'aud' }, { dir: AUD_R, depth: siteDepth(AUD_R), ori: 'aud' }], amp: 30, corr: 0 },
    near: { s: [{ dir: GS.s1L, depth: siteDepth(GS.s1L), ori: 'fwd' }, { dir: MEG.ELEC.P3, depth: 3.2, ori: 'fwd' }], amp: 20, corr: 0 }
  };
  const mirror = s => ({ dir: [-s.dir[0], s.dir[1], s.dir[2]], depth: s.depth, ori: s.ori });
  function applyPreset(name) {
    const P = PRESETS[name]; if (!P) return;
    const s = P.s.map(x => Object.assign({}, x));
    st.src = Object.assign(st.src || { trials: 80, noise: 1, corr: 0 }, { s: [s[0], s[1] || mirror(s[0])], two: P.s.length > 1, amp: P.amp });
    if (P.corr !== undefined) st.src.corr = P.corr;
    st.preset = name;
  }
  function scenarioSources() {
    const P = st.src, list = P.two ? P.s : [P.s[0]];
    return list.map((s, i) => {
      const pos = v3.scale(v3.unit(s.dir), MEG.clamp(MEG.HEAD.R - s.depth, 1, 7.6));
      return { pos, ori: ORI[s.ori](pos), amp: P.amp, name: `source ${i + 1}` };
    });
  }
  // The true sources of the data being analysed (head frame).
  function trueSources() {
    if (st.mode === 'scenario') return st.src ? scenarioSources() : [];
    if (!S.ds) return [];
    return S.ds.gens.filter(g => g.kind === 'source' && g.evoked && S.enabled.has(g.group)).map(g => ({ pos: g.pos, ori: g.ori, name: g.label }));
  }
  function syncScenario() {
    const P = st.src;
    $('invPreset').value = st.preset;
    $('invAt1').value = MEG.nearestPlace(P.s[0].dir); $('invAt2').value = MEG.nearestPlace(P.s[1].dir);
    $('invD1').value = P.s[0].depth; $('invD2').value = P.s[1].depth;
    $('invTwo').checked = P.two; $('invAmp').value = P.amp; $('invCorr').value = P.corr;
    $('invTrials').value = P.trials; $('invNoise').value = P.noise;
    ['invAt2', 'invD2', 'invCorr'].forEach(id => { $(id).disabled = !P.two; });
    labels();
  }
  function labels() {
    const P = st.src;
    $('invD1V').textContent = P.s[0].depth.toFixed(1) + ' cm'; $('invD2V').textContent = P.s[1].depth.toFixed(1) + ' cm';
    $('invAmpV').textContent = P.amp + ' nAm'; $('invCorrV').textContent = P.corr.toFixed(2);
    $('invTrialsV').textContent = P.trials; $('invNoiseV').textContent = '× ' + P.noise.toFixed(2);
    $('invLatV').textContent = Math.round(st.lat * 1000) + ' ms';
    $('invRegV').textContent = (parseFloat($('invReg').value) * 100).toFixed(0) + '%';
    $('invThrV').textContent = Math.round(parseFloat($('invThr').value) * 100) + '% of the maximum';
  }

  function makeData() {
    if (!S.ds) return null;
    if (st.mode === 'scenario') {
      const P = st.src, srcs = scenarioSources();
      const key = `sc|${S.ds.array.type}|${JSON.stringify([srcs.map(s => s.pos.map(x => x.toFixed(3)).concat(s.ori.map(x => x.toFixed(3)))), P.amp, P.two ? P.corr : 0, P.trials, P.noise])}`;
      if (st.data && st.data.key === key) return st.data;
      const d = I.scenarioData(S.ds, { sources: srcs, corr: P.corr, trials: P.trials, noiseScale: P.noise });
      st.data = Object.assign(d, { key, kind: 'scenario', nAvg: P.trials, noiseKey: `sc|${P.trials}|${P.noise}` });
      return st.data;
    }
    if (!S.ep || !S.ds.events.length) return null;
    const ci = Math.max(0, +$('invCond').value || 0), key = `rec|${S.version}|${ci}`;
    if (st.data && st.data.key === key) { attachTruth(st.data); return st.data; }
    const ep = S.ep, eps = ep.list.filter(e => e.ev.ci === ci && !e.rejected);
    if (!eps.length) return null;
    const nT = ep.nT, nch = ep.nCh;
    const avg = Array.from({ length: nch }, () => new Float64Array(nT));
    eps.forEach(e => { for (let c = 0; c < nch; c++) { const o = avg[c], off = c * nT; for (let i = 0; i < nT; i++) o[i] += e.data[off + i]; } });
    avg.forEach(o => { for (let i = 0; i < nT; i++) o[i] /= eps.length; });
    st.data = { key, kind: 'recording', times: Float64Array.from(ep.times), nT, nch, avg, fwd: null, eps, ci, nAvg: eps.length, noiseKey: key };
    attachTruth(st.data);
    return st.data;
  }
  // The true evoked field of the recording, when the app has it: the forward model of the real sources.
  function attachTruth(d) {
    if (d.fwd || d.kind !== 'recording' || !S.truth || !S.truth.ok) return;
    const tr = S.truth.conds[d.ci].data, nT = d.nT;
    d.fwd = Array.from({ length: d.nch }, (_, c) => Float64Array.from(tr.subarray(c * nT, (c + 1) * nT)));
  }
  function latIndex(d) {
    let best = 0, bd = Infinity;
    d.times.forEach((t, i) => { const x = Math.abs(t - st.lat); if (x < bd) { bd = x; best = i; } });
    return best;
  }

  function dataRender() {
    const T = D.theme(), d = makeData(), arr = S.ds.array;
    $('cvInvSrc').hidden = st.mode !== 'scenario';
    if (!d) {
      const msg = st.mode === 'recording' ? 'This recording has no trials to average.\nAdd a trials block to the timeline on the Experiment tab.' : 'No data.';
      D.message($('cvInvMap'), msg, 160); D.message($('cvInvWave'), '', 40);
      ui.readouts($('invDataReadouts'), []); ui.legend($('invWaveLegend'), []); $('invMapCap').textContent = '';
      return;
    }
    const ti = latIndex(d), lat = d.times[ti];
    // maps: the forward model, the noise and their sum, the data
    const mode = arr.type === 'planar' ? 'mag' : null;
    const col = rows => Float64Array.from(rows, r => r[ti]);
    const vData = col(d.avg), vFwd = d.fwd ? col(d.fwd) : null;
    const maps = [];
    if (vFwd) maps.push({ label: 'the forward model', sub: 'the sources alone', v: vFwd }, { label: 'plus the noise', sub: `averaged over ${d.nAvg} trials`, v: vData.map((x, i) => x - vFwd[i]) });
    maps.push({ label: 'equals the data', sub: 'what the inverse sees', v: vData });
    const sv = maps.map(m => D.siteValues(arr, m.v, mode));
    let mx = 0; sv.forEach(v => v.forEach(x => { mx = Math.max(mx, Math.abs(x)); }));
    const cv = $('cvInvMap'), n = maps.length;
    const { ctx, w } = D.fit(cv, w => Math.min(w / n, 230) + 62);
    const r = Math.min(w / n / 2 - 10, 105);
    maps.forEach((m, i) => {
      const cx = (i + 0.5) * w / n, cy = 34 + r;
      D.topo(ctx, cx, cy, r, D.sites(), sv[i], { range: mx || 1 });
      const roomy = w / n > 170;
      ctx.fillStyle = T.ink; ctx.font = D.font(roomy ? 11 : 10, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(m.label, cx, 2);
      if (roomy) { ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.fillText(m.sub, cx, 16); }
    });
    D.colorbar(ctx, w / 2 - Math.min(130, w * 0.3), 34 + 2 * r + 8, Math.min(260, w * 0.6), 8, mx || 1, { unit: 'fT', fmt: x => MEG.fmt(x, Math.abs(x) < 10 ? 1 : 0) });
    $('invMapCap').textContent = `At ${Math.round(lat * 1000)} ms, ${arr.type === 'planar' ? 'the magnetometers of the planar array' : MEG.KIND_LABEL[arr.type]}. ` +
      (d.kind === 'scenario' ? 'The forward model is exact: one field for one source. The inverse problem starts from the map on the right.'
        : vFwd ? 'The forward model here is the true evoked field of the recording’s sources through the same processing.' : 'Computing the true evoked field…');
    // waveforms: every channel of the main kind, with the signal and noise power across them
    const idx = ui.chans(arr.main), unitW = ui.unitOf(arr.main === 'planar' ? 'planar' : 'mag');
    const times = Array.from(d.times, t => t * 1000);
    const series = idx.map(c => ({ y: Array.from(d.avg[c]), color: T.ink2, alpha: 0.16, width: 0.8, noTip: true }));
    const rms = rows => Array.from(d.times, (_, i) => { let s = 0; idx.forEach(c => { s += rows[c][i] * rows[c][i]; }); return Math.sqrt(s / idx.length); });
    let noiseRMS = null, sigRMS = null;
    if (d.fwd) {
      sigRMS = rms(d.fwd);
      noiseRMS = rms(d.avg.map((row, c) => (idx.includes(c) ? row.map((x, i) => x - d.fwd[c][i]) : row)));
      series.push({ y: noiseRMS, color: T.muted, width: 1.6, dash: [4, 3], label: 'noise, RMS over channels' }, { y: sigRMS, color: T.accent, width: 2.2, label: 'signal, RMS over channels' });
    }
    if (!st.plots.wave) st.plots.wave = new D.Plot($('cvInvWave'), { height: 190, onClick: x => setLatency(x / 1000) });
    st.plots.wave.draw({
      x: times, series, xLabel: '', yLabel: unitW, xRange: [times[0], times[times.length - 1]],
      vlines: [{ x: 0, color: T.muted }, { x: lat * 1000, color: T.accent, label: Math.round(lat * 1000) + ' ms' }],
      bands: [{ x0: times[0], x1: 0, fill: T.band, label: 'baseline' }, { x0: 50, x1: 300, fill: D.alpha(T.series[6], 0.08) }],
      tipX: x => `${Math.round(x)} ms`, tipFmt: v => ui.fmtV(v, unitW)
    });
    const leg = [{ color: D.alpha(T.ink2, 0.5), label: `every ${MEG.KIND_LABEL[arr.main].replace(/s$/, '')}, averaged` }, { color: D.alpha(T.series[6], 0.35), label: 'shaded: the beamformer’s window', dot: true }];
    if (d.fwd) leg.push({ color: T.accent, label: 'signal (RMS)' }, { color: T.muted, label: 'noise (RMS)', dash: true });
    if (d.kind === 'scenario') {
      const srcT = d.wave.slice(0, d.ns).map((wv, i) => ({ y: Array.from(wv, x => x * d.meanAmp[i]), color: T.series[2], width: 2, dash: i ? [6, 4] : [], label: `source ${i + 1}` }));
      if (!st.plots.src) st.plots.src = new D.Plot($('cvInvSrc'), { height: 120, onClick: x => setLatency(x / 1000) });
      st.plots.src.draw({
        x: times, series: srcT, xLabel: 'time from stimulus (ms)', yLabel: 'nAm', xRange: [times[0], times[times.length - 1]], yZero: true,
        vlines: [{ x: 0, color: T.muted }, { x: lat * 1000, color: T.accent }],
        tipX: x => `${Math.round(x)} ms`, tipFmt: v => v.toFixed(1) + ' nAm'
      });
      leg.push({ color: T.series[2], label: d.ns > 1 ? `source time courses (1 solid, 2 dashed; r = ${d.rho.toFixed(2)})` : 'source time course' });
    }
    ui.legend($('invWaveLegend'), leg);
    const pairs = [];
    if (d.fwd) {
      const s = sigRMS[ti], nz = noiseRMS[ti];
      pairs.push(['Signal at this latency', ui.fmtV(s, unitW), 'RMS over channels of the true field'], ['Noise', ui.fmtV(nz, unitW), 'RMS over channels of the data minus the true field'], ['Signal to noise', (s / (nz || 1)).toFixed(1), 'Ratio of the two']);
    }
    pairs.push(['Trials averaged', String(d.nAvg)]);
    ui.readouts($('invDataReadouts'), pairs);
    if (d.kind === 'recording') recNote(d);
  }
  function recNote(d) {
    const bad = S.enabled.has('bad') && S.ds.badSite >= 0;
    const NAMES = { references: 'reference compensation' };
    const done = (S.sup ? S.sup.steps : []).map(x => NAMES[x] || x);
    const P = S.proc;
    if (P.hp || P.lp || P.notch) done.push('the offline filters');
    if (S.ica.model && !S.ica.stale && S.ica.rejected.size) done.push(`ICA (${S.ica.rejected.size} component${S.ica.rejected.size > 1 ? 's' : ''} removed)`);
    const list = done.length ? done.length > 1 ? done.slice(0, -1).join(', ') + ' and ' + done[done.length - 1] : done[0] : 'no noise rejection or filtering';
    const moving = S.enabled.has('movement') && !(S.sup && S.sup.sss && S.sup.sss.comp);
    $('invRecNote').innerHTML = `The average of the ${d.nAvg} accepted <b>${S.ds.conditions[d.ci]}</b> epochs, after ${list}. ` +
      `The noise covariance comes from their baseline, the beamformer’s data covariance from 50 to 300 ms of the single epochs.` +
      (bad ? ` The bad sensor ${MEG.SITES[S.ds.badSite].name} is left out.` : '') +
      (moving ? ' <b>The head moved during the recording and nothing compensated for it</b>, so the sensors were not where the model puts them.' : '');
  }
  function setLatency(t) {
    const d = st.data;
    const lo = 0, hi = d ? Math.min(0.4, d.times[d.times.length - 1]) : 0.4;
    st.lat = MEG.clamp(t, lo, hi);
    $('invLat').value = Math.round(st.lat * 1000);
    labels(); dataRender(); schedule();
  }

  /* ---------- 3. the inverse ---------- */
  function modelSpec() {
    // the array and where the head sat in it
    const p0 = I.headChannels(S.ds)[0].pts[0].r, type = S.ds.array.type + ' ' + p0.map(x => x.toFixed(3)).join(',');
    if (st.mode === 'scenario') return { key: type + '|plain', project: null };
    const U = (S.sup && S.sup.U) || [], arr = S.ds.array;
    const bad = S.enabled.has('bad') && S.ds.badSite >= 0 ? arr.siteChannels[S.ds.badSite] : [];
    if (!U.length && !bad.length) return { key: type + '|plain', project: null };
    const sig = U.map(u => u[0].toFixed(7) + ':' + u[u.length - 1].toFixed(7)).join(',');
    return {
      key: `${type}|ssp ${U.length} ${sig}|bad ${bad.join(',')}`,
      project: col => { if (U.length) col.set(MEG.suppress.projectVector(col, U)); bad.forEach(c => { col[c] = 0; }); }
    };
  }
  async function recordingStats(model, d, tick) {
    const { U, white } = model, r = U.length, nch = d.nch, nT = d.nT;
    const avgR = I.reduceRows(model, d.avg, nT);
    const stride = Math.max(1, Math.round(S.ds.fs / 250)), base = [], act = [];
    for (let i = 0; i < nT; i += stride) { const t = d.times[i]; if (t < 0) base.push(i); else if (t >= 0.05 && t < 0.3) act.push(i); }
    const Cn = new Float64Array(r * r), Cd = new Float64Array(r * r), col = new Float64Array(nch), y = new Float64Array(r);
    let nn = 0, nd = 0;
    for (let e = 0; e < d.eps.length; e++) {
      const data = d.eps[e].data;
      const add = (i, C) => {
        for (let c = 0; c < nch; c++) col[c] = data[c * nT + i];
        if (model.project) model.project(col);
        for (let c = 0; c < nch; c++) col[c] /= white[c];
        for (let k = 0; k < r; k++) { const u = U[k]; let s = 0; for (let c = 0; c < nch; c++) s += u[c] * col[c]; y[k] = s; }
        for (let a = 0; a < r; a++) { const ya = y[a], o = a * r; for (let b = a; b < r; b++) C[o + b] += ya * y[b]; }
      };
      base.forEach(i => { add(i, Cn); nn++; });
      act.forEach(i => { add(i, Cd); nd++; });
      if (e % 6 === 5) await tick(e / d.eps.length);
    }
    const full = (C, n) => Array.from({ length: r }, (_, a) => Float64Array.from({ length: r }, (_, b) => (a <= b ? C[a * r + b] : C[b * r + a]) / Math.max(1, n)));
    return { avgR, noiseCovR: full(Cn, nn), dataCovR: full(Cd, nd) };
  }

  // Run the estimate soon, if it has been run once (the first time is explicit: it is slow).
  function schedule() {
    if (!st.auto) { st.stale = !!st.res; rowsRender(); return; }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => estimate(), 250);
  }
  async function estimate() {
    if (!S.ds) return;
    if (S.tab !== 'estimation') { st.needs = true; return; }
    const gen = ++st.gen, t0 = performance.now();
    st.needs = false;
    const status = $('invStatus');
    const tick = async (f, msg) => { ui.progress('invProgress', f); if (msg) status.textContent = msg; await MEG.app.frame(); if (gen !== st.gen) throw ABORT; };
    ui.busy(true);
    try {
      const d = makeData();
      if (!d) { status.textContent = 'There are no data to estimate from.'; st.res = null; rowsRender(); return; }
      const spec = modelSpec();
      let model = st.models.get(spec.key);
      if (!model) {
        await tick(0.01, `Computing the field that a dipole at each point of the source grid makes at the ${S.ds.array.nch} channels. This is done once for each sensor array…`);
        model = await I.buildModelAsync(S.ds, { project: spec.project }, f => tick(0.02 + 0.55 * f));
        model.key = spec.key;
        st.models.set(spec.key, model);
      }
      const skey = spec.key + '|' + d.key;
      if (!st.stats || st.stats.key !== skey) {
        await tick(0.6, 'Noise and data covariance…');
        const s = d.kind === 'scenario' ? I.scenarioStats(model, d) : await recordingStats(model, d, f => tick(0.6 + 0.1 * f));
        st.stats = Object.assign(s, { key: skey });
      }
      const stats = st.stats;
      // the whitener depends only on the noise, so it is kept while only the sources change
      const wkey = spec.key + '|' + d.noiseKey;
      if (!st.wh || st.wh.key !== wkey) {
        await tick(0.7, 'Whitening the lead fields with the noise covariance…');
        const Wh = I.whitenerR(stats.noiseCovR.map(row => row.map(x => x / d.nAvg)), 0.1);
        const m = await I.withWhitenerAsync(model, Wh, f => tick(0.7 + 0.08 * f));
        st.wh = { key: wkey, Wh, m, K: {} };
      }
      const { Wh, m } = st.wh;
      const ti = latIndex(d);
      const vw = I.whitenVecR(Wh, Float64Array.from(stats.avgR, row => row[ti]));
      const ndip = +$('invNDip').value;
      const fkey = `${skey}|${wkey}|${ti}|${ndip}`;
      if (!st.fitC || st.fitC.key !== fkey) {
        await tick(0.8, ndip === 2 ? 'Fitting two dipoles…' : 'Fitting a dipole…');
        const one = I.dipoleFit(m, vw);
        st.fitC = { key: fkey, fit: ndip === 2 ? I.dipoleFit2(m, vw, one) : one };
      }
      const method = $('invMNE').value;
      if (!st.wh.K[method]) { await tick(0.86, 'Minimum norm…'); st.wh.K[method] = I.minimumNorm(m, { method, depth: method !== 'mne' }); }
      const mne = st.wh.K[method].apply(vw);
      const reg = parseFloat($('invReg').value);
      const bkey = `${skey}|${wkey}|${reg}`;
      if (!st.lcmvC || st.lcmvC.key !== bkey) {
        await tick(0.93, 'Beamformer…');
        st.lcmvC = { key: bkey, bf: I.lcmv(m, I.whitenCovR(Wh, stats.dataCovR), I.whitenCovR(Wh, stats.noiseCovR), { reg }) };
      }
      let snr = 0; vw.forEach(x => { snr += x * x; });
      st.res = { model, ti, lat: d.times[ti], fit: st.fitC.fit, ndip, mne, method, bf: st.lcmvC.bf.power, reg, data: d, srcs: trueSources(), snr: Math.sqrt(snr / vw.length), trials: d.nAvg };
      st.auto = true; st.stale = false;
      ui.progress('invProgress', 0);
      status.textContent = `Estimated at ${Math.round(d.times[ti] * 1000)} ms in ${((performance.now() - t0) / 1000).toFixed(1)} s. ` +
        'From now on the estimates follow the controls.';
      rowsRender();
    } catch (e) {
      if (e !== ABORT) { console.error(e); status.textContent = 'Error: ' + e.message; ui.progress('invProgress', 0); }
    } finally {
      if (gen === st.gen) ui.busy(false);
    }
  }

  /* Volumes on the grid, sampled anywhere by trilinear interpolation. */
  function volume(grid, img) {
    const n = 2 * grid.lim + 1, vol = new Float32Array(n * n * n);
    let mx = 0; img.forEach(x => { if (x > mx) mx = x; });
    grid.ijk.forEach(([i, j, k], p) => { vol[(i + grid.lim) + n * ((j + grid.lim) + n * (k + grid.lim))] = img[p] / (mx || 1); });
    return { vol, n, lim: grid.lim, sp: grid.spacing, max: mx };
  }
  function sample(V, p) {
    const n = V.n, x = p[0] / V.sp + V.lim, y = p[1] / V.sp + V.lim, z = p[2] / V.sp + V.lim;
    if (x < 0 || y < 0 || z < 0 || x >= n - 1 || y >= n - 1 || z >= n - 1) return 0;
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k, a = V.vol;
    const o = i + n * (j + n * k), dj = n, dk = n * n;
    const c00 = a[o] * (1 - fx) + a[o + 1] * fx, c10 = a[o + dj] * (1 - fx) + a[o + dj + 1] * fx;
    const c01 = a[o + dk] * (1 - fx) + a[o + dk + 1] * fx, c11 = a[o + dj + dk] * (1 - fx) + a[o + dj + dk + 1] * fx;
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
  }
  // The colour image of a volume over a slice, through the estimated transform.
  function overlay(V, thr, maskRGB) {
    return view => {
      const res = view.res, out = new Uint8ClampedArray(res * res * 4), Ti = st.Tinv, R = Ti.R, t = Ti.t, L = D.HOT;
      const sv = { plane: view.plane, at: view.at, w: res };
      for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const m = pxToMRI(sv, i + 0.5, j + 0.5);
        const p = [R[0][0] * m[0] + R[0][1] * m[1] + R[0][2] * m[2] + t[0], R[1][0] * m[0] + R[1][1] * m[1] + R[1][2] * m[2] + t[1], R[2][0] * m[0] + R[2][1] * m[1] + R[2][2] * m[2] + t[2]];
        const v = sample(V, p);
        if (v <= 0 || v < thr) continue;
        const q = 4 * (j * res + i);
        if (maskRGB) { out[q] = maskRGB[0]; out[q + 1] = maskRGB[1]; out[q + 2] = maskRGB[2]; out[q + 3] = 120; continue; }
        const f = thr < 1 ? (v - thr) / (1 - thr) : 1, k = Math.round(MEG.clamp(f, 0, 1) * 255) * 3;
        out[q] = L[k]; out[q + 1] = L[k + 1]; out[q + 2] = L[k + 2]; out[q + 3] = Math.round(255 * (0.5 + 0.45 * f));
      }
      return out;
    };
  }

  const ROWS = [
    { id: 'fit', title: 'Dipole fit' },
    { id: 'mne', title: 'Minimum norm' },
    { id: 'bf', title: 'Beamformer (LCMV)' }
  ];
  const MNE_TEXT = {
    mne: ['Plain minimum norm', 'Current spread over the whole grid, the distribution with the least total power that explains the map. With no depth weighting, shallow currents always win.'],
    dspm: ['dSPM', 'Minimum norm with depth weighting, each point divided by the noise it would show: a statistical map that is good at finding activity, blurred and often too deep for placing it.'],
    sloreta: ['sLORETA', 'Minimum norm with depth weighting, each point divided by the spread of its own estimate: it puts a single noiseless source exactly in place, blurred all the same.']
  };
  const nearestTo = (p, srcs) => { let b = Infinity, k = -1; srcs.forEach((s, i) => { const d = v3.norm(v3.sub(p, s.pos)); if (d < b) { b = d; k = i; } }); return { d: b, k }; };
  // For each true source, the distance to the nearest peak of an image above `thr` of its maximum.
  // contrast: the maximum over the median, how much anything stands out at all.
  function peaksNear(model, img, thr, srcs) {
    const pk = I.peaks(model, img, Math.max(thr, 0.2), 1.5);
    const sorted = Float32Array.from(img).sort();
    const contrast = sorted[sorted.length - 1] / Math.max(1e-30, sorted[sorted.length >> 1]);
    return { pk, contrast, near: srcs.map(s => pk.reduce((b, p) => Math.min(b, v3.norm(v3.sub(p.pos, s.pos))), Infinity)) };
  }
  const FLAT = 2;   // a map whose maximum is less than twice its median shows nothing in particular
  const listMM = arr => arr.map(mm).join(' · ');

  function rowsRender() {
    const box = $('invRows');
    box.classList.toggle('stale', !!st.stale && !!st.res);
    const R = st.res, T = D.theme();
    if (!R) {
      // before any estimate: the anatomy around the true sources
      const srcs = trueSources(), c = srcs.length ? M.apply(M.TRUE, srcs[0].pos) : C0;
      const rings = (ctx, px) => srcs.forEach((s, i) => { const q = px(M.apply(M.TRUE, s.pos)); const a = nearness(q.off); if (a) ring(ctx, q.x, q.y, 8, T.series[2], a, srcs.length > 1 ? String(i + 1) : null); });
      ROWS.forEach(r => { PLANES.forEach((plane, k) => drawMRI($(`cv-${r.id}-${k}`), plane, fixedOf(plane, c), 144, { draw: rings, title: k === 1 ? 'not estimated yet' : '' })); $(`ro-${r.id}`).innerHTML = ''; $(`lab-${r.id}`).textContent = ''; });
      describe(); $('invVerdict').innerHTML = '';
      ui.legend($('invLegend'), srcs.length ? [{ color: T.series[2], label: 'a true source, where it is in the anatomy', dot: true }] : []);
      return;
    }
    describe();
    const model = R.model, g = model.grid, thr = parseFloat($('invThr').value), srcs = R.srcs;
    const green = T.series[2], blue = T.series[0];
    const fitPos = R.ndip === 2 ? R.fit.pos : [R.fit.pos];
    const fitQ = R.ndip === 2 ? R.fit.q : [R.fit.q];
    // the dipole's 95% confidence volume: for two dipoles, each with the other held where it is
    const conf = new Float32Array(g.n);
    (R.ndip === 2 ? R.fit.resid : [R.fit.resid]).forEach(res => { const c = I.confidence(res, R.fit.residBest); for (let i = 0; i < g.n; i++) if (c[i]) conf[i] = 1; });
    let nconf = 0; conf.forEach(x => { nconf += x; });
    const confVol = nconf * Math.pow(g.spacing, 3);
    const imgs = { fit: conf, mne: R.mne, bf: R.bf };
    const vols = { fit: volume(g, conf), mne: volume(g, R.mne), bf: volume(g, R.bf) };
    const pk = { mne: peaksNear(model, R.mne, thr, srcs), bf: peaksNear(model, R.bf, thr, srcs) };
    const peakOf = id => (id === 'fit' ? fitPos[0] : pk[id].pk.length ? pk[id].pk[0].pos : g.pts[0]);
    const which = $('invSlices').value;
    const markers = id => (ctx, px) => {
      srcs.forEach((s, i) => { const q = px(M.apply(M.TRUE, s.pos)); const a = nearness(q.off); if (a) ring(ctx, q.x, q.y, 8, green, a, srcs.length > 1 ? String(i + 1) : null); });
      if (id === 'fit') {
        fitPos.forEach((p, i) => {
          const q = px(M.apply(st.T, p)), a = nearness(q.off); if (!a) return;
          const dir = v3.unit(M.apply({ R: st.T.R, t: [0, 0, 0] }, fitQ[i]));
          const tip = px(v3.add(M.apply(st.T, p), v3.scale(dir, 1.4)));
          const len = Math.hypot(tip.x - q.x, tip.y - q.y);
          ctx.save(); ctx.globalAlpha = a;
          if (len > 3) { D.arrow(ctx, q.x, q.y, tip.x, tip.y, 'rgba(0,0,0,0.55)', 4.5, 9); D.arrow(ctx, q.x, q.y, tip.x, tip.y, blue, 2.4, 8); }
          ctx.restore();
          dot(ctx, q.x, q.y, 4.5, blue, a);
        });
      } else {
        pk[id].pk.slice(0, 3).forEach((p, i) => { const q = px(M.apply(st.T, p.pos)), a = nearness(q.off); if (a) cross(ctx, q.x, q.y, i ? 5 : 7, blue, a, i ? 1.8 : 2.4); });
      }
    };
    ROWS.forEach(row => {
      const id = row.id;
      const c = which === 'peak' || !srcs.length ? M.apply(st.T, peakOf(id)) : M.apply(M.TRUE, srcs[0].pos);
      const V = vols[id];
      const mask = id === 'fit' ? hexRGB(blue) : null;
      const info = m => { const v = sample(V, M.apply(st.Tinv, m)); return id === 'fit' ? (v >= 0.5 ? '<div>inside the 95% confidence volume</div>' : '') : `<div>${row.title}: ${Math.round(v * 100)}% of its maximum</div>`; };
      PLANES.forEach((plane, k) => drawMRI($(`cv-${id}-${k}`), plane, fixedOf(plane, c), 144, { overlay: overlay(V, id === 'fit' ? 0.5 : thr, mask), draw: markers(id), info }));
      // readouts
      const pairs = [];
      if (id === 'fit') {
        if (srcs.length) {
          if (R.ndip === 2) pairs.push(['From the sources', listMM(fitPos.map(p => nearestTo(p, srcs).d)), 'Distance of each fitted dipole from the nearest true source, in the head frame']);
          else pairs.push([srcs.length > 1 ? 'From the nearer source' : 'From the source', mm(nearestTo(fitPos[0], srcs).d), 'Distance of the fitted dipole from the true source, in the head frame']);
        }
        pairs.push(['Goodness of fit', `${Math.round(Math.max(0, R.fit.gof) * 100)}%`, 'Share of the whitened field the dipole model explains']);
        pairs.push(['Moment', fitQ.map(q => `${Math.round(v3.norm(q))}`).join(' · ') + ' nAm', 'Size of the fitted current']);
        pairs.push(['95% confidence', cm3(confVol), 'Volume of the places where a dipole fits almost as well (Δχ² < 7.8): shaded on the slices']);
      } else {
        const img = imgs[id], P = pk[id];
        if (srcs.length) pairs.push([srcs.length > 1 ? 'Nearest peak to each source' : 'Peak from the source', P.contrast < FLAT ? 'no clear peak' : listMM(P.near), 'Distance from each true source to the nearest local maximum above the threshold']);
        pairs.push(['Contrast', `${P.contrast.toFixed(1)} ×`, 'The maximum over the median of the whole map: near 1, nothing stands out']);
        if (P.pk.length) pairs.push(['Peak depth', `${MEG.depthOf(P.pk[0].pos).toFixed(1)} cm` + (srcs.length ? ` (true ${MEG.depthOf(srcs[nearestTo(P.pk[0].pos, srcs).k].pos).toFixed(1)})` : ''), 'Depth below the scalp of the largest peak and of the source nearest to it']);
        pairs.push(['Above half maximum', cm3(I.spread(model, img, 0.5)), 'How much of the brain the estimate lights up: its blur']);
        if (id === 'bf' && srcs.length) {
          let mx = 0; img.forEach(x => { mx = Math.max(mx, x); });
          const at = srcs.map(s => { let b = 0; g.pts.forEach((p, i) => { if (v3.norm(v3.sub(p, s.pos)) < 0.9) b = Math.max(b, img[i]); }); return `${Math.round(100 * b / (mx || 1))}%`; });
          pairs.push(['At the source', at.join(' · '), 'The activity index at each true source, as a share of its maximum']);
        }
      }
      ui.readouts($(`ro-${id}`), pairs);
      const where = id === 'fit' ? fitPos : pk[id].pk.slice(0, srcs.length > 1 ? 2 : 1).map(p => p.pos);
      $(`lab-${id}`).innerHTML = where.length ? `Drawn in: ${where.map(p => `<b>${placeName(p)}</b>`).join('; ')}` : '';
    });
    ui.legend($('invLegend'), [
      { color: green, label: 'a true source, where it is in the anatomy', dot: true },
      { color: blue, label: 'the estimate, placed on the MRI through the coregistration', dot: true },
      { color: D.alpha(blue, 0.45), label: 'the dipole’s 95% confidence volume' },
      { color: '#d7301f', label: `minimum norm and beamformer above ${Math.round(thr * 100)}% of their maximum` }
    ]);
    $('invVerdict').innerHTML = verdict(R, { confVol, pk, fitPos });
  }
  function describe() {
    const method = $('invMNE').value, t = MNE_TEXT[method];
    const ndip = +$('invNDip').value;
    $('ttl-mne').textContent = t[0];
    $('desc-mne').textContent = t[1];
    $('desc-fit').textContent = ndip === 2 ? 'Assumes exactly two point sources and moves both until their summed field best matches the map at this latency, by least squares.'
      : 'Assumes one point source and finds where its field best matches the map at this latency, by least squares. Shaded: everywhere it fits almost as well.';
    $('desc-bf').textContent = 'For each point, a spatial filter that passes that point and suppresses everything else in the data covariance (50 to 300 ms of the single trials). It assumes the sources are uncorrelated.';
  }

  function verdict(R, x) {
    const srcs = R.srcs, out = [];
    if (!srcs.length) return '<p>This recording has no evoked sources switched on, so there is no right answer to compare with. The three methods still disagree with each other in ways that follow from their assumptions.</p>';
    const two = srcs.length > 1, d = R.data;
    const conf = x.confVol, gof = Math.round(Math.max(0, R.fit.gof) * 100);
    // the dipole fit
    if (!two) {
      const e = nearestTo(x.fitPos[0], srcs).d;
      out.push(`<strong>Dipole fit:</strong> ${mm(e)} from the source, explaining ${gof}% of the field` +
        (conf > 3 ? `, but at this signal to noise a dipole anywhere in ${cm3(conf)} fits almost as well.` : '.') +
        (R.ndip === 2 ? ' The second dipole has nothing real to fit: it is placed on the noise.' : ''));
    } else if (R.ndip === 1) {
      const n = nearestTo(x.fitPos[0], srcs);
      out.push(`<strong>Dipole fit:</strong> one dipole cannot explain two sources. It explains ${gof}% of the field ` +
        (n.d < 1.5 ? `by sitting on source ${n.k + 1} (${mm(n.d)} away) and ignoring the other.` : `from a place between them, ${mm(n.d)} from the nearer. Try fitting two.`));
    } else {
      const e = x.fitPos.map(p => nearestTo(p, srcs).d);
      out.push(`<strong>Two dipoles</strong> land ${listMM(e)} from the sources and explain ${gof}% of the field` +
        (d.kind === 'scenario' && d.rho > 0.6 ? '. A dipole fit does not mind that the time courses are correlated, but you had to know there were two.' : '.'));
    }
    // minimum norm
    const name = MNE_TEXT[R.method][0], P = x.pk.mne;
    if (P.pk.length) {
      const top = P.pk[0].pos, k = nearestTo(top, srcs).k, dz = MEG.depthOf(srcs[k].pos) - MEG.depthOf(top);
      const sp = I.spread(R.model, R.mne, 0.5);
      let s = P.contrast < FLAT ? `<strong>${name}:</strong> no clear peak, the map is nearly flat` : `<strong>${name}:</strong> nearest peaks ${listMM(P.near)} from the source${two ? 's' : ''}`;
      if (dz > 1) s += `; its largest peak is ${dz.toFixed(1)} cm shallower than the source${R.method === 'mne' ? ', because a shallow current explains the field with the least power' : ''}`;
      else if (dz < -1) s += `; its largest peak is ${(-dz).toFixed(1)} cm deeper than the source`;
      s += `. ${cm3(sp)} of the brain is above half its maximum: a blurred picture even when the peak is right.`;
      out.push(s);
    }
    // the beamformer
    const B = x.pk.bf, flat = B.contrast < FLAT, found = flat ? 0 : B.near.filter(v => v < 1.5).length;
    const bfSpread = I.spread(R.model, R.bf, 0.5);
    const flatText = `its map is nearly flat, ${cm3(bfSpread)} above half its maximum, so nothing stands out`;
    if (two && d.kind === 'scenario' && d.rho >= 0.6) out.push(`<strong>Beamformer:</strong> the two time courses are correlated (r = ${d.rho.toFixed(2)}), so the filter for each source cancels the other: ` + (flat ? `${flatText}.` : `${found} of the two stand${found === 1 ? 's' : ''} out within 15 mm.`));
    else if (two && d.kind === 'recording') out.push(`<strong>Beamformer:</strong> ` + (flat ? `${flatText}.` : `${found} of the ${srcs.length} sources stand${found === 1 ? 's' : ''} out within 15 mm.`) + ' In this recording sources that share a waveform, like the two auditory cortices, are correlated, and a beamformer suppresses correlated sources.');
    else if (flat) out.push(`<strong>Beamformer:</strong> ${flatText}.` + (R.trials < 25 ? ` With ${R.trials} trials the data covariance is poorly estimated, and the filters suffer for it.` : ''));
    else out.push(`<strong>Beamformer:</strong> nearest peaks ${listMM(B.near)} from the source${two ? 's' : ''}` + (R.trials < 25 ? `. With ${R.trials} trials the data covariance is poorly estimated, and the filters suffer for it.` : '.'));
    // depth, noise and coregistration
    const deep = srcs.some(s => MEG.depthOf(s.pos) > 4.5);
    if (deep) out.push('A deep source makes a weak, broad field: the same map can be explained in many places, and each method resolves that in its own way.');
    if (R.snr < 1.2) out.push('The signal is barely above the noise at this latency: try more trials, less noise or a stronger source.');
    const ce = M.errorAt(st.T, srcs[0].pos);
    if (ce > 0.3) out.push(`On the MRI every estimate is also shifted by the coregistration, ${mm(ce)} at the source: a perfect inverse solution would still be drawn in the wrong place.`);
    return out.map(s => `<p>${s}</p>`).join('');
  }

  /* ---------- rendering and events ---------- */
  // What the MRI is, at the head of the coregistration caption.
  function mriNote() {
    const el = $('coMriWhat'); if (!el) return;
    const shrink = Math.round((1 - MEG.TEMPLATE.scale) * 100);
    if (M.kind === 'template') el.textContent = `The MRI is the MNI ICBM152 template, the average T1-weighted scan of 152 young adults, shrunk ${shrink}% to this head model's size, with its regions named by the CerebrA atlas. Its coordinates are the template's own (MNI), tilted and shifted from the head frame.`;
    else if (M.status === 'failed') el.textContent = 'The template MRI could not be loaded here (a page opened from the disk cannot fetch it), so a synthetic head stands in: a T1-weighted image in the scanner\'s own coordinates, where the head is tilted and off centre.';
    else el.textContent = 'Loading the template MRI; a synthetic head stands in until it arrives.';
  }
  // A new MRI: new frame, new landmarks, new head shape; nothing drawn on the old one stands.
  M.onChange(() => {
    C0 = M.apply(M.TRUE, [0, 0, 0]); UP = v3.sub(M.apply(M.TRUE, [0, 0, 1]), C0);
    st.slices.clear(); st.digi = {}; st.marks = null;
    if (S.tab === 'estimation' && S.ds) render(); else MEG.app.dirty('estimation');
  });
  function render() {
    if (!S.ds) return;
    M.load();
    mriNote();
    if (!st.src) { applyPreset('aud1'); }
    syncScenario();
    $('invScenario').hidden = st.mode !== 'scenario';
    $('invRecording').hidden = st.mode !== 'recording';
    if (st.mode === 'recording') {
      ui.fill($('invCond'), S.ds.conditions.map((c, i) => ({ value: String(i), label: c })), $('invCond').value || '0');
      if (!S.truth) MEG.app.truth().then(() => { if (S.tab === 'estimation' && st.mode === 'recording') { if (st.data) attachTruth(st.data); dataRender(); } }).catch(e => console.error(e));
    }
    coregRender();
    dataRender();
    if (st.res && st.mode === 'recording' && st.res.data.key !== (st.data && st.data.key)) { st.stale = true; if (st.auto) st.needs = true; }
    rowsRender();
    if (st.needs && st.auto) estimate();
  }
  function hover(cv) {
    cv.addEventListener('mousemove', e => {
      const view = st.views.get(cv); if (!view) return;
      const r = cv.getBoundingClientRect(), m = pxToMRI(view, e.clientX - r.left, e.clientY - r.top);
      const p = M.apply(M.TRUE_INV, m);
      const where = M.coordName ? `<div style="color:var(--muted)">${M.coordName} (${m.map(x => Math.round(M.mm(x))).join(', ')}) mm</div>` : '';
      D.tip(e.clientX, e.clientY, `<div><b>${M.label(p)}</b></div><div style="color:var(--muted)">${M.tissue(p)}</div>` + where + (view.info ? view.info(m) : ''));
    });
    cv.addEventListener('mouseleave', () => D.tip(0, 0, null));
  }
  function dataChanged() { labels(); dataRender(); coregRender(); schedule(); }

  MEG.tabs.estimation = {
    init() {
      $('invRows').innerHTML = ROWS.map(r => `<div class="inv-row"><div class="who"><h3 id="ttl-${r.id}">${r.title}</h3><p id="desc-${r.id}"></p><div class="readouts" id="ro-${r.id}"></div><p class="lab" id="lab-${r.id}"></p></div>` +
        [0, 1, 2].map(k => `<canvas id="cv-${r.id}-${k}"></canvas>`).join('') + '</div>').join('');
      $('invRows').querySelectorAll('canvas').forEach(cv => { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', 'MRI slice with a source estimate'); hover(cv); });
      const places = MEG.PLACES.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      ['invAt1', 'invAt2'].forEach(id => ui.fill($(id), places));
      // coregistration
      const fidSeg = ui.seg($('coFid'), v => { st.fid = v; coregRender(); });
      st.fidSeg = fidSeg;
      ['cvMriAx', 'cvMriCor', 'cvMriSag'].forEach(id => {
        const cv = $(id);
        hover(cv);
        cv.style.cursor = 'crosshair';
        cv.addEventListener('click', e => {
          const view = st.views.get(cv); if (!view) return;
          const r = cv.getBoundingClientRect();
          st.marks[st.fid] = pxToMRI(view, e.clientX - r.left, e.clientY - r.top);
          coregChanged();
        });
      });
      $('coExact').addEventListener('click', () => { st.marks = exactMarks(); coregChanged(); });
      $('coCareless').addEventListener('click', () => {
        const rng = MEG.rng(9100 + (st.careless++));
        st.marks = exactMarks();
        FIDS.forEach(f => { const u = v3.unit([rng.gauss(), rng.gauss(), rng.gauss()]); st.marks[f] = v3.add(st.marks[f], v3.scale(u, rng.uniform(0.3, 0.7))); });
        coregChanged();
      });
      $('coNudge').addEventListener('click', () => { st.marks = st.marks || exactMarks(); st.marks.NAS = v3.add(trueFid('NAS'), v3.scale(UP, 0.5)); st.fid = 'NAS'; fidSeg.set('NAS'); coregChanged(); });
      ['coICP', 'coNose', 'coPoints'].forEach(id => $(id).addEventListener('change', coregChanged));
      $('coSlice').addEventListener('change', coregRender);
      // data
      ui.seg($('invData'), v => { st.mode = v; st.res = null; st.stale = false; if (v === 'recording') { const tr = S.truth; st.lat = tr && tr.ok ? peakLatency(tr) : 0.1; } render(); schedule(); });
      $('invPreset').addEventListener('change', () => { if ($('invPreset').value !== 'custom') applyPreset($('invPreset').value); else st.preset = 'custom'; syncScenario(); dataChanged(); });
      const custom = () => { st.preset = 'custom'; $('invPreset').value = 'custom'; };
      $('invAt1').addEventListener('change', () => { st.src.s[0] = { dir: MEG.ELEC[$('invAt1').value], depth: st.src.s[0].depth, ori: 'fwd' }; custom(); dataChanged(); });
      $('invAt2').addEventListener('change', () => { st.src.s[1] = { dir: MEG.ELEC[$('invAt2').value], depth: st.src.s[1].depth, ori: 'fwd' }; custom(); dataChanged(); });
      $('invTwo').addEventListener('change', () => { st.src.two = $('invTwo').checked; custom(); syncScenario(); dataChanged(); });
      const slider = (id, set) => { $(id).addEventListener('input', () => { set(parseFloat($(id).value)); labels(); dataRender(); coregRender(); }); $(id).addEventListener('change', schedule); };
      slider('invD1', v => { st.src.s[0].depth = v; });
      slider('invD2', v => { st.src.s[1].depth = v; });
      slider('invAmp', v => { st.src.amp = v; });
      slider('invCorr', v => { st.src.corr = v; });
      slider('invTrials', v => { st.src.trials = v; });
      slider('invNoise', v => { st.src.noise = v; });
      $('invCond').addEventListener('change', () => { st.res = null; dataChanged(); });
      $('invLat').addEventListener('input', () => { st.lat = parseFloat($('invLat').value) / 1000; labels(); dataRender(); });
      $('invLat').addEventListener('change', schedule);
      // inverse
      $('btnInverse').addEventListener('click', () => estimate());
      ['invMNE', 'invNDip'].forEach(id => $(id).addEventListener('change', () => { describe(); schedule(); }));
      $('invReg').addEventListener('input', labels);
      $('invReg').addEventListener('change', schedule);
      $('invThr').addEventListener('input', () => { labels(); rowsRender(); });
      $('invSlices').addEventListener('change', rowsRender);
    },
    onBuild() { st.data = null; st.stats = null; st.wh = null; st.fitC = null; st.lcmvC = null; if (st.mode === 'recording') { st.res = null; } st.needs = st.auto; },
    onArray() { st.models.clear(); st.data = null; st.stats = null; st.wh = null; st.fitC = null; st.lcmvC = null; st.res = null; st.needs = st.auto; },
    render
  };
  function peakLatency(tr) {
    let best = 0.1, bm = 0;
    tr.conds.forEach(c => { for (let t = 0; t < tr.nT; t++) { if (tr.times[t] <= 0) continue; let s = 0; for (let ch = 0; ch < tr.nCh; ch++) s += c.data[ch * tr.nT + t] ** 2; if (s > bm) { bm = s; best = tr.times[t]; } } });
    return best;
  }
})(typeof window !== 'undefined' ? window : globalThis);
