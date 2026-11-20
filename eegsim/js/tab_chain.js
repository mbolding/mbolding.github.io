/* EEG simulator: the Signal chain tab.  Five schematic, interactive
   stages: pyramidal cells and their dipole, the layered head, the 10-20
   cap, the differential amplifier and the digitizer. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui, v3 = EEG.v3;
  const $ = ui.$;
  const st = { stage: 'neurons', anim: null, t0: 0, cap: 32, selElec: 'Cz' };
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const model64 = () => EEG.capLabels(64);

  /* ===== 1. neurons ===== */
  const nrn = {};
  function cortexGeometry(w, h) {
    // a crown on each side of one deep sulcus
    const t = Math.max(18, h * 0.085), top = h * 0.2, xc = w * 0.6, sig = t * 2.3, depth = h * 0.5;
    const ys = x => top + depth * Math.exp(-Math.pow((x - xc) / sig, 2)) + 6 * Math.sin(x / w * Math.PI * 2);
    const dys = x => (ys(x + 0.5) - ys(x - 0.5));
    const pts = [];
    for (let x = 0; x <= w; x += 1) pts.push([x, ys(x)]);
    // cells spaced along arc length
    const cells = [];
    let acc = 0, next = 6;
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc >= next) {
        next += t * 0.62;
        const x = pts[i][0], y = pts[i][1], d = dys(x), L = Math.hypot(1, d);
        const n = [d / L, -1 / L];                        // outward normal (up on screen)
        const region = Math.abs(d) < 0.35 ? (x < xc ? 'crownL' : 'crownR') : (x < xc ? 'wallL' : 'wallR');
        cells.push({ x, y, n, region, phase: Math.random() * Math.PI * 2 });
      }
    }
    return { t, top, xc, sig, ys, pts, cells };
  }
  function activeCells(geo, patch) {
    return geo.cells.filter(c => patch === 'crown' ? (c.region === 'crownL' && c.x > geo.xc - geo.sig * 5 && c.x < geo.xc - geo.sig * 1.6)
      : patch === 'wall' ? c.region === 'wallL' : (c.region === 'wallL' || c.region === 'wallR'));
  }
  function drawNeurons(time) {
    const cv = $('cvNeurons'), T = D.theme();
    const { ctx, w, h } = D.fit(cv, w => Math.min(380, Math.max(260, w * 0.62)));
    if (!nrn.geo || nrn.geo.w !== w || nrn.geo.h !== h) { nrn.geo = cortexGeometry(w, h); nrn.geo.w = w; nrn.geo.h = h; }
    const geo = nrn.geo, patch = $('nrnPatch').value, sync = parseFloat($('nrnSync').value) / 100;
    // CSF / pia above, white matter below
    ctx.fillStyle = T.layers.csf; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = T.layers.brain;
    ctx.beginPath(); ctx.moveTo(0, h); geo.pts.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    // white matter: the surface pushed inward by the cortical thickness
    ctx.fillStyle = T.dark ? '#2a2526' : '#f8f4f2';
    ctx.beginPath();
    let first = true;
    for (let x = 0; x <= w; x += 2) {
      const d = geo.ys(x + 0.5) - geo.ys(x - 0.5), L = Math.hypot(1, d);
      const px = x - d / L * geo.t * 1.8, py = geo.ys(x) + geo.t * 1.8 / L;
      if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.muted; ctx.font = D.font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('CSF', 8, 6); ctx.fillText('grey matter', 8, geo.ys(8) + geo.t * 1.35); ctx.fillText('white matter', 8, h - 18);
    ctx.textAlign = 'center'; ctx.fillText('sulcus', geo.xc, geo.ys(geo.xc) + 6);
    ctx.fillText('gyral crown', geo.xc - geo.sig * 3.4, geo.top - 18);
    const act = new Set(activeCells(geo, patch));
    const phase = time * 2 * Math.PI * 0.6;
    // cells
    geo.cells.forEach(c => {
      const on = act.has(c);
      const syncCell = on && (c.phase / (2 * Math.PI)) < Math.max(sync * 4, 0.05);  // shown share exaggerated for visibility
      const level = on ? 0.5 + 0.5 * Math.sin(syncCell ? phase : phase * 1.3 + c.phase * 3) : 0;
      const soma = [c.x - c.n[0] * geo.t * 1.25, c.y - c.n[1] * geo.t * 1.25];
      const tuft = [c.x - c.n[0] * geo.t * 0.12, c.y - c.n[1] * geo.t * 0.12];
      ctx.strokeStyle = on ? D.alpha(T.series[0], 0.35 + 0.65 * level) : T.layers.line;
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.beginPath(); ctx.moveTo(soma[0], soma[1]); ctx.lineTo(tuft[0], tuft[1]); ctx.stroke();
      // apical tuft
      const tx = -c.n[1], ty = c.n[0];
      ctx.beginPath(); ctx.moveTo(tuft[0], tuft[1]); ctx.lineTo(tuft[0] + tx * 4 + c.n[0] * 3, tuft[1] + ty * 4 + c.n[1] * 3);
      ctx.moveTo(tuft[0], tuft[1]); ctx.lineTo(tuft[0] - tx * 4 + c.n[0] * 3, tuft[1] - ty * 4 + c.n[1] * 3); ctx.stroke();
      // soma triangle pointing outward
      const s = 4.5;
      ctx.fillStyle = on ? D.alpha(T.series[0], 0.55 + 0.45 * level) : T.layers.line;
      ctx.beginPath();
      ctx.moveTo(soma[0] + c.n[0] * s * 1.4, soma[1] + c.n[1] * s * 1.4);
      ctx.lineTo(soma[0] + tx * s - c.n[0] * s * 0.6, soma[1] + ty * s - c.n[1] * s * 0.6);
      ctx.lineTo(soma[0] - tx * s - c.n[0] * s * 0.6, soma[1] - ty * s - c.n[1] * s * 0.6);
      ctx.closePath(); ctx.fill();
      if (on && syncCell && !reduced) {
        // intracellular current running down the dendrite
        const f = (time * 0.9 + c.phase) % 1;
        const px = tuft[0] + (soma[0] - tuft[0]) * f, py = tuft[1] + (soma[1] - tuft[1]) * f;
        ctx.fillStyle = T.series[1]; ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 2 * Math.PI); ctx.fill();
      }
    });
    // sink and source labels plus the net dipole of the patch
    const list = Array.from(act);
    const groups = patch === 'both' ? [list.filter(c => c.region === 'wallL'), list.filter(c => c.region === 'wallR')] : [list];
    groups.forEach(gr => {
      if (!gr.length) return;
      const mid = gr[Math.floor(gr.length / 2)];
      const nx = gr.reduce((a, c) => a + c.n[0], 0) / gr.length, ny = gr.reduce((a, c) => a + c.n[1], 0) / gr.length;
      const L = Math.hypot(nx, ny), n = [nx / L, ny / L];
      const cx = mid.x - n[0] * geo.t * 0.7, cy = mid.y - n[1] * geo.t * 0.7;
      const off = geo.t * 1.9, side = [-n[1], n[0]];
      const sx = side[0] * (patch === 'crown' ? 0 : (mid.region === 'wallL' ? -1 : 1)) * off, sy = side[1] * (patch === 'crown' ? 0 : (mid.region === 'wallL' ? -1 : 1)) * off;
      const ax = cx + (patch === 'crown' ? 0 : sx), ay = cy + (patch === 'crown' ? 0 : sy);
      const amp = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(phase));
      const len = geo.t * 2.2 * amp;
      // current dipole: from the sink (apical) toward the source (soma), i.e. inward
      const a = [ax + n[0] * len / 2, ay + n[1] * len / 2], b = [ax - n[0] * len / 2, ay - n[1] * len / 2];
      ctx.strokeStyle = T.series[1]; ctx.fillStyle = T.series[1]; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const hl = 8; ctx.beginPath(); ctx.moveTo(b[0] - n[0] * 3, b[1] - n[1] * 3); ctx.lineTo(b[0] + n[0] * hl + n[1] * hl * 0.6, b[1] + n[1] * hl - n[0] * hl * 0.6); ctx.lineTo(b[0] + n[0] * hl - n[1] * hl * 0.6, b[1] + n[1] * hl + n[0] * hl * 0.6); ctx.closePath(); ctx.fill();
      ctx.font = D.font(13, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = T.divNeg; ctx.fillText('−', a[0] + n[0] * 10, a[1] + n[1] * 10);
      ctx.fillStyle = T.divPos; ctx.fillText('+', b[0] - n[0] * 10, b[1] - n[1] * 10);
    });
    ctx.fillStyle = T.ink2; ctx.font = D.font(11); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('orange arrow: net current dipole of the active patch', w - 8, h - 6);
  }
  function neuronNumbers() {
    const patch = $('nrnPatch').value, A = parseFloat($('nrnArea').value), s = parseFloat($('nrnSync').value) / 100;
    $('nrnAreaV').textContent = A.toFixed(1) + ' cm²';
    $('nrnSyncV').textContent = (s * 100).toFixed(1) + '%';
    const N = A * 8e6;                       // pyramidal cells under 1 cm^2 of cortex, order of magnitude
    const p = 2e-4;                          // nA*m per active cell, about 0.2 pA*m
    const qs = N * s * p, qa = Math.sqrt(N * Math.max(0, 1 - s)) * p;
    const model = EEG.headModel(), labels = model64(), U = labels.map(l => EEG.ELEC[l]);
    let v = new Float64Array(U.length);
    const add = (pos, ori, q) => { const f = EEG.forward(model, pos, v3.scale(ori, q), U); for (let i = 0; i < v.length; i++) v[i] += f[i]; };
    const base = EEG.placeDipole('Cz', 1.45);
    if (patch === 'crown') add(base, v3.scale(v3.unit(base), -1), qs);
    else if (patch === 'wall') { const pos = EEG.placeDipole('Cz', 2.2); add(pos, [1, 0, 0], qs); }
    else { const pos = EEG.placeDipole('Cz', 2.2); add(v3.add(pos, [-0.25, 0, 0]), [1, 0, 0], qs / 2); add(v3.add(pos, [0.25, 0, 0]), [-1, 0, 0], qs / 2); }
    const m = EEG.mean(v); v = v.map(x => x - m);
    let peak = 0; v.forEach(x => { if (Math.abs(x) > Math.abs(peak)) peak = x; });
    ui.readouts($('nrnReadouts'), [
      ['Pyramidal cells', N.toExponential(1).replace('e+', ' × 10^')],
      ['Synchronous dipole', EEG.fmt(patch === 'both' ? qs / 2 : qs, 0) + ' nAm'],
      ['Same cells at random', EEG.fmt(qa, 2) + ' nAm'],
      ['Largest scalp value', EEG.fmt(peak, 1) + ' µV', 'average reference, 64-channel cap'],
      ['Visible over 10 µV background?', Math.abs(peak) > 10 ? 'yes' : Math.abs(peak) > 3 ? 'barely' : 'no']
    ]);
    D.topoCanvas($('cvNeuronTopo'), labels, v, { unit: 'µV', maxH: 230, names: false });
  }

  /* ===== 2. layers ===== */
  function layerModel(ratio, csf) { const s = EEG.HEAD.sigma.slice(); s[2] = s[0] / ratio; if (!csf) s[1] = s[0]; return EEG.headModel({ sigma: s }); }
  function drawLayers() {
    const ratio = parseFloat($('lyrRatio').value), depth = parseFloat($('lyrDepth').value), csf = $('lyrCSF').checked;
    $('lyrRatioV').textContent = '1 : ' + ratio;
    $('lyrDepthV').textContent = depth.toFixed(1) + ' cm';
    const T = D.theme(), H = EEG.HEAD;
    const lm = layerModel(ratio, csf), hm = EEG.headModel({ homogeneous: true });
    const pos = [0, 0, H.R - depth], q = [0, 0, 1];
    const angs = [], pl = [], ph = [], dist = [];
    for (let a = -100; a <= 100; a += 1) {
      const t = a * Math.PI / 180, e = [Math.sin(t), 0, Math.cos(t)];
      angs.push(t); dist.push(H.R * t);
      pl.push(EEG.forward(lm, pos, q, [e])[0]); ph.push(EEG.forward(hm, pos, q, [e])[0]);
    }
    // the slice
    const cv = $('cvLayers');
    const { ctx, w, h } = D.fit(cv, w => Math.min(340, w * 0.72));
    const s = Math.min(w / 2 / (H.R * 1.08), (h - 20) / (H.R * 1.1));
    const cx = w / 2, cy = h - 10;
    const names = [['scalp', H.radii[3], T.layers.scalp, H.sigma[3]], ['skull', H.radii[2], T.layers.skull, lm.sigma[2]], ['CSF', H.radii[1], T.layers.csf, lm.sigma[1]], ['brain', H.radii[0], T.layers.brain, H.sigma[0]]];
    names.forEach(([nm, r, col]) => { ctx.fillStyle = col; ctx.strokeStyle = T.layers.line; ctx.beginPath(); ctx.arc(cx, cy, r * s, Math.PI, 2 * Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke(); });
    // potential band on the scalp
    const mx = Math.max(...pl.map(Math.abs));
    for (let i = 0; i < angs.length - 1; i++) {
      ctx.strokeStyle = D.divColor(pl[i] / mx); ctx.lineWidth = 9;
      const a0 = -Math.PI / 2 + angs[i], a1 = -Math.PI / 2 + angs[i + 1];
      ctx.beginPath(); ctx.arc(cx, cy, H.R * s + 6, a0, a1 + 0.01); ctx.stroke();
    }
    // dipole
    const dy = cy - pos[2] * s;
    ctx.strokeStyle = T.series[1]; ctx.fillStyle = T.series[1]; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, dy + 12); ctx.lineTo(cx, dy - 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, dy - 16); ctx.lineTo(cx - 6, dy - 7); ctx.lineTo(cx + 6, dy - 7); ctx.closePath(); ctx.fill();
    // a key in the top corner: thickness and conductivity of each shell
    ctx.font = D.font(11); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    names.forEach(([nm, r, col, sig], i) => {
      const inner = i < 3 ? names[i + 1][1] : 0, y = 12 + i * 17;
      ctx.fillStyle = col; ctx.strokeStyle = T.layers.line; ctx.fillRect(6, y - 6, 12, 12); ctx.strokeRect(6.5, y - 5.5, 11, 11);
      ctx.fillStyle = T.ink;
      ctx.fillText(`${nm}${i < 3 ? ' ' + ((r - inner) * 10).toFixed(0) + ' mm' : ''}, ${sig < 0.01 ? sig.toFixed(4) : sig.toFixed(2)} S/m`, 24, y);
    });
    // the profile
    if (!st.profile) st.profile = new D.Plot($('cvProfile'), { height: 230 });
    const nl = pl.map(v => v / Math.max(...pl)), nh = ph.map(v => v / Math.max(...ph));
    st.profile.draw({
      x: dist, xLabel: 'distance along the scalp from above the source (cm)', yLabel: 'potential, % of its peak',
      series: [{ y: nh.map(v => v * 100), color: T.muted, label: 'No skull (homogeneous)', dash: [5, 4] }, { y: nl.map(v => v * 100), color: T.series[0], label: 'Four-shell head' }],
      xRange: [-14, 14], tipFmt: v => v.toFixed(0) + '%', tipX: x => `${x.toFixed(1)} cm from the peak`
    });
    ui.legend($('profileLegend'), [{ color: T.series[0], label: 'Four-shell head' }, { color: T.muted, label: 'No skull (homogeneous)', dash: true }]);
    const halfWidth = (arr) => { let i = arr.indexOf(Math.max(...arr)), j = i; while (j < arr.length - 1 && arr[j] > 0.5 * arr[i]) j++; return 2 * (dist[j] - dist[i]); };
    ui.readouts($('lyrReadouts'), [
      ['Peak, four shells', EEG.fmt(Math.max(...pl) * 10, 2) + ' µV', 'per 10 nAm, radial'],
      ['Peak, no skull', EEG.fmt(Math.max(...ph) * 10, 2) + ' µV'],
      ['Attenuation', '× ' + (Math.max(...ph) / Math.max(...pl)).toFixed(1)],
      ['Width at half max', halfWidth(nl).toFixed(1) + ' cm', 'four shells'],
      ['Width, no skull', halfWidth(nh).toFixed(1) + ' cm']
    ]);
  }

  /* ===== 3. electrodes ===== */
  const REGION = { Fp: 'frontopolar', AF: 'between frontopolar and frontal', F: 'frontal', FT: 'between frontal and temporal', FC: 'between frontal and central', T: 'temporal', TP: 'between temporal and parietal', C: 'central', CP: 'between central and parietal', P: 'parietal', PO: 'between parietal and occipital', O: 'occipital', I: 'inion', N: 'nasion', M: 'mastoid' };
  function describe(l) {
    const m = /^(Fp|AF|FT|FC|TP|CP|PO|F|T|C|P|O|I|N|M)(z|\d+)$/.exec(l);
    if (!m) return '';
    const num = m[2];
    const side = num === 'z' ? 'on the midline' : (+num % 2 ? 'left hemisphere' : 'right hemisphere');
    const caps = EEG.CAP_SIZES.filter(n => EEG.capLabels(n).includes(l));
    const u = EEG.ELEC[l], th = Math.acos(u[2]) * 180 / Math.PI, az = Math.atan2(u[0], u[1]) * 180 / Math.PI;
    const old = Object.keys(EEG.ALIAS).filter(k => EEG.ALIAS[k] === l);
    const R = EEG.S.cfg && EEG.S.cfg.recording;
    const role = R ? (R.reference === l ? ' It is the online reference of the current program.' : R.ground === l ? ' It is the ground of the current program.' : '') : '';
    return `<p><strong>${l}</strong>${old.length ? ` (older name ${old.join(', ')})` : ''}: ${REGION[m[1]]}, ${side}${num !== 'z' ? `, ${Math.ceil(+num / 2)} step${Math.ceil(+num / 2) > 1 ? 's' : ''} from the midline` : ''}.
      ${th < 1 ? 'At the vertex.' : `${th.toFixed(0)}&deg; from the vertex, ${Math.abs(az).toFixed(0)}&deg; ${az >= 0 ? 'right' : 'left'} of straight ahead.`}
      ${caps.length ? 'On the ' + caps.join(', ') + '-channel caps.' : 'Not on these caps; used as a reference.'}${role}</p>`;
  }
  function drawCap() {
    const T = D.theme(), R = EEG.S.cfg ? EEG.S.cfg.recording : null;
    const labels = EEG.capLabels(st.cap);
    const cv = $('cvCap');
    const { ctx, w, h } = D.fit(cv, w => Math.min(520, w));
    const r = Math.min(w, h) / 2 * 0.86, cx = w / 2, cy = h / 2 + r * 0.04;
    const marks = {};
    if (R) { marks[R.reference] = T.series[0]; marks[R.ground] = T.series[2]; }
    st.capPts = D.capMap(ctx, cx, cy, r, labels, { marks, selected: st.selElec, extra: ['M1', 'M2'] });
    // the midline and ear-to-ear percentages
    ctx.strokeStyle = D.alpha(T.series[0], 0.35); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cx, cy - r * 108 / 110); ctx.lineTo(cx, cy + r * 108 / 110); ctx.moveTo(cx - r * 108 / 110, cy); ctx.lineTo(cx + r * 108 / 110, cy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('nasion', cx + 6, cy - r * 1.0); ctx.fillText('inion', cx + 6, cy + r * 1.0);
    $('capInfo').innerHTML = describe(st.selElec) +
      (R ? `<p class="note"><span style="color:${T.series[0]}">&#9679;</span> online reference ${R.reference} &nbsp; <span style="color:${T.series[2]}">&#9679;</span> ground ${R.ground} &nbsp; grey: mastoids</p>` : '');
    drawCapSide();
  }
  function drawCapSide() {
    const T = D.theme(), cv = $('cvCapSide');
    const { ctx, w, h } = D.fit(cv, w => Math.min(250, w * 0.62));
    const r = Math.min(w * 0.36, h * 0.62), cx = w / 2, cy = h * 0.78;
    ctx.fillStyle = T.layers.scalp; ctx.strokeStyle = T.layers.line;
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 1.0 - 0.32, Math.PI * 2 + 0.32); ctx.fill(); ctx.stroke();
    const pt = th => { const t = th * Math.PI / 180; return [cx + Math.sin(t) * r, cy - Math.cos(t) * r]; };
    const marks = [['Nz', 108], ['Fpz', 90], ['Fz', 54], ['Cz', 0], ['Pz', -54], ['Oz', -90], ['Iz', -108]];
    ctx.strokeStyle = T.series[0]; ctx.lineWidth = 2;
    ctx.beginPath(); for (let a = 108; a >= -108; a -= 2) { const [x, y] = pt(a); a === 108 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } ctx.stroke();
    const pct = ['10%', '20%', '20%', '20%', '20%', '10%'];
    marks.forEach(([l, a], i) => {
      const [x, y] = pt(a);
      ctx.fillStyle = T.ink; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 2 * Math.PI); ctx.fill();
      ctx.font = D.font(11, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const [lx, ly] = [cx + Math.sin(a * Math.PI / 180) * (r + 16), cy - Math.cos(a * Math.PI / 180) * (r + 14)];
      ctx.fillText(l, lx, ly);
      if (i < marks.length - 1) {
        const am = (a + marks[i + 1][1]) / 2, [px, py] = [cx + Math.sin(am * Math.PI / 180) * (r - 16), cy - Math.cos(am * Math.PI / 180) * (r - 14)];
        ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.fillText(pct[i], px, py);
      }
    });
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center';
    ctx.fillText('nose', cx + r * 1.12, cy - r * 0.12); ctx.fillText('midline, seen from the left', cx, h - 8);
  }

  /* ===== 4. amplifier ===== */
  function ampValues() {
    const Za = Math.pow(10, parseFloat($('ampZa').value)), Zr = Math.pow(10, parseFloat($('ampZr').value));
    const Zin = Math.pow(10, parseFloat($('ampZin').value)) * 1e3;    // kOhm
    const cmrr = parseFloat($('ampCMRR').value), Vcm = parseFloat($('ampVcm').value) * 1e3, sig = parseFloat($('ampSig').value);
    $('ampZaV').textContent = EEG.fmt(Za, Za < 10 ? 1 : 0) + ' kΩ'; $('ampZrV').textContent = EEG.fmt(Zr, Zr < 10 ? 1 : 0) + ' kΩ';
    const zinM = Zin / 1e3; $('ampZinV').textContent = zinM >= 1000 ? EEG.fmt(zinM / 1000, 1) + ' GΩ' : EEG.fmt(zinM, 0) + ' MΩ';
    $('ampCMRRV').textContent = cmrr + ' dB'; $('ampVcmV').textContent = (Vcm / 1e3).toFixed(0) + ' mV'; $('ampSigV').textContent = sig + ' µV';
    const ga = Zin / (Zin + Za), gr = Zin / (Zin + Zr), leak = Math.pow(10, -cmrr / 20);
    return { Za, Zr, Zin, cmrr, Vcm, sig, ga, gr, leak, mism: Vcm * (ga - gr), cm: Vcm * leak };
  }
  function drawAmp() {
    const a = ampValues(), T = D.theme();
    const cv = $('cvAmp');
    const { ctx, w, h } = D.fit(cv, w => Math.min(330, Math.max(250, w * 0.62)));
    const u = Math.min(w / 10, h / 6.6);
    ctx.lineWidth = 1.6; ctx.strokeStyle = T.ink2; ctx.fillStyle = T.ink; ctx.font = D.font(Math.max(10, u * 0.3)); ctx.textBaseline = 'middle';
    // head
    const hx = u * 1.7, hy = h * 0.5, hr = u * 1.35;
    ctx.fillStyle = T.layers.scalp; ctx.beginPath(); ctx.arc(hx, hy, hr, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.fillText('head', hx, hy);
    const eA = [hx + hr * 0.5, hy - hr * 0.87], eR = [hx + hr * 0.95, hy + hr * 0.3], eG = [hx - hr * 0.3, hy + hr * 0.95];
    const dot = (p, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p[0], p[1], 5, 0, 2 * Math.PI); ctx.fill(); };
    dot(eA, T.series[0]); dot(eR, T.series[1]); dot(eG, T.series[2]);
    // mains coupling
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left';
    ctx.fillText(`~ ${(a.Vcm / 1e3).toFixed(0)} mV common mode`, u * 0.2, u * 0.45);
    ctx.strokeStyle = T.muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(u * 1.2, u * 0.65); ctx.lineTo(hx - hr * 0.3, hy - hr * 0.9); ctx.stroke(); ctx.setLineDash([]);
    // resistor helper
    const resistor = (x0, y0, x1, y1, label) => {
      const n = 6, dx = (x1 - x0), dy = (y1 - y0), L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
      const a0 = 0.3, a1 = 0.7;
      ctx.strokeStyle = T.ink2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx * a0, y0 + dy * a0);
      for (let i = 0; i <= n; i++) { const t = a0 + (a1 - a0) * i / n, s = i === 0 || i === n ? 0 : (i % 2 ? 1 : -1) * u * 0.14; ctx.lineTo(x0 + dx * t + nx * s, y0 + dy * t + ny * s); }
      ctx.lineTo(x1, y1); ctx.stroke();
      if (label) { ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.fillText(label, x0 + dx * 0.5 + nx * u * 0.42, y0 + dy * 0.5 + ny * u * 0.42); }
    };
    const ampX = u * 6.6, ampTop = h * 0.5 - u * 1.2, ampBot = h * 0.5 + u * 1.2;
    const inP = [ampX, h * 0.5 - u * 0.6], inM = [ampX, h * 0.5 + u * 0.6];
    resistor(eA[0], eA[1], inP[0] - u * 1.4, inP[1], `Za ${EEG.fmt(a.Za, a.Za < 10 ? 1 : 0)} kΩ`);
    ctx.beginPath(); ctx.moveTo(inP[0] - u * 1.4, inP[1]); ctx.lineTo(inP[0], inP[1]); ctx.stroke();
    resistor(eR[0], eR[1], inM[0] - u * 1.4, inM[1], '');
    ctx.fillStyle = T.ink; ctx.textAlign = 'center'; ctx.fillText(`Zr ${EEG.fmt(a.Zr, a.Zr < 10 ? 1 : 0)} kΩ`, (eR[0] + inM[0] - u * 1.4) / 2, inM[1] - u * 0.42);
    ctx.beginPath(); ctx.moveTo(inM[0] - u * 1.4, inM[1]); ctx.lineTo(inM[0], inM[1]); ctx.stroke();
    // input impedances to the common point
    const gy = h - u * 0.4;
    [inP, inM].forEach((p, i) => { const x = p[0] - u * (i ? 0.6 : 1.0); resistor(x, p[1], x, gy, ''); });
    ctx.fillStyle = T.ink; ctx.textAlign = 'left'; ctx.fillText(`Zin ${a.Zin >= 1e6 ? EEG.fmt(a.Zin / 1e6, 1) + ' GΩ' : EEG.fmt(a.Zin / 1e3, 0) + ' MΩ'} each`, inM[0] - u * 0.45, (inM[1] + gy) / 2 + u * 0.35);
    ctx.strokeStyle = T.ink2; ctx.beginPath(); ctx.moveTo(eG[0], eG[1]); ctx.lineTo(eG[0], gy); ctx.lineTo(inP[0] - u * 0.4, gy); ctx.stroke();
    ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.fillText('ground (common point)', eG[0] + 6, gy - u * 0.25);
    // amplifier triangle
    ctx.fillStyle = T.surface; ctx.strokeStyle = T.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ampX, ampTop); ctx.lineTo(ampX, ampBot); ctx.lineTo(ampX + u * 2, h * 0.5); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.ink; ctx.font = D.font(Math.max(12, u * 0.42), 700); ctx.textAlign = 'center';
    ctx.fillText('+', ampX + u * 0.3, inP[1]); ctx.fillText('−', ampX + u * 0.3, inM[1]);
    ctx.font = D.font(Math.max(10, u * 0.3)); ctx.fillText(`CMRR ${a.cmrr} dB`, ampX + u * 0.7, ampBot + u * 0.32);
    ctx.lineWidth = 1.6; ctx.strokeStyle = T.ink2; ctx.beginPath(); ctx.moveTo(ampX + u * 2, h * 0.5); ctx.lineTo(w - u * 0.3, h * 0.5); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText('to the digitizer', w - u * 0.2, h * 0.5 - u * 0.3);
    ctx.textAlign = 'left'; ctx.fillStyle = T.series[0]; ctx.fillText('active', eA[0] + 8, eA[1] - 8);
    ctx.fillStyle = T.series[1]; ctx.textAlign = 'right'; ctx.fillText('reference', eR[0] - 8, eR[1] + 14);
    // traces
    const cvT = $('cvAmpTraces');
    const g = D.fit(cvT, 210);
    const rows = [['active (+) input, mV', t => (a.Vcm * Math.sin(2 * Math.PI * 60 * t) + a.sig * Math.sin(2 * Math.PI * 10 * t)) * a.ga / 1e3, T.series[0]],
      ['reference (−) input, mV', t => a.Vcm * Math.sin(2 * Math.PI * 60 * t) * a.gr / 1e3, T.series[1]],
      ['output, µV', t => a.sig * a.ga * Math.sin(2 * Math.PI * 10 * t) + (a.mism + a.cm) * Math.sin(2 * Math.PI * 60 * t), T.ink]];
    const rh = (g.h - 10) / 3;
    rows.forEach(([lab, f, col], i) => {
      const y0 = 4 + i * rh, ym = y0 + rh / 2;
      let mx = 0; for (let k = 0; k < 400; k++) mx = Math.max(mx, Math.abs(f(k / 400 * 0.2)));
      g.ctx.strokeStyle = T.grid; g.ctx.beginPath(); g.ctx.moveTo(116, ym); g.ctx.lineTo(g.w - 4, ym); g.ctx.stroke();
      g.ctx.strokeStyle = col; g.ctx.lineWidth = 1.6; g.ctx.beginPath();
      for (let k = 0; k <= 600; k++) { const t = k / 600 * 0.2, x = 116 + k / 600 * (g.w - 120), y = ym - f(t) / (mx || 1) * rh * 0.42; k ? g.ctx.lineTo(x, y) : g.ctx.moveTo(x, y); }
      g.ctx.stroke();
      g.ctx.fillStyle = T.ink2; g.ctx.font = D.font(10); g.ctx.textAlign = 'left'; g.ctx.textBaseline = 'middle';
      g.ctx.fillText(lab.split(', ')[0], 2, ym - 13); g.ctx.fillText(lab.split(', ')[1], 2, ym); g.ctx.fillStyle = T.muted; g.ctx.fillText('±' + EEG.fmt(mx, mx < 10 ? 2 : 0), 2, ym + 13);
    });
    const line = Math.abs(a.mism + a.cm);
    ui.readouts($('ampReadouts'), [
      ['From the mismatch', EEG.fmt(Math.abs(a.mism), 2) + ' µV'],
      ['Through the CMRR', EEG.fmt(a.cm, 2) + ' µV'],
      ['60 Hz at the output', EEG.fmt(line, 2) + ' µV'],
      ['Brain : hum', (a.sig / (line || 1e-9)).toFixed(a.sig / line < 10 ? 1 : 0) + ' : 1']
    ]);
  }

  /* ===== 5. digitizer ===== */
  function drawDig() {
    const T = D.theme();
    const f = parseFloat($('digFreq').value), A = parseFloat($('digAmp').value), fs = parseFloat($('digFs').value);
    const bits = parseInt($('digBits').value, 10), range = parseFloat($('digRange').value), aa = $('digAA').checked;
    $('digFreqV').textContent = f + ' Hz'; $('digAmpV').textContent = A + ' µV'; $('digFsV').textContent = fs + ' Hz';
    $('digBitsV').textContent = bits; $('digRangeV').textContent = range + ' µV';
    const H = aa ? EEG.analogButter(4, f / (fs / 3)) : { mag: 1, phase: 0 };
    const sig = t => A * H.mag * Math.sin(2 * Math.PI * f * t + H.phase);
    const step = 2 * range / Math.pow(2, bits);
    const q = v => EEG.clamp(Math.round(v / step) * step, -range, range - step);
    const dur = 0.25, N = 2000;
    const tc = [], yc = []; for (let i = 0; i <= N; i++) { tc.push(i / N * dur * 1000); yc.push(sig(i / N * dur)); }
    const ts = [], ys = [], hold = [], tHold = [];
    for (let k = 0; k / fs <= dur; k++) { const t = k / fs; ts.push(t * 1000); ys.push(q(sig(t))); }
    ts.forEach((t, i) => { tHold.push(t, i + 1 < ts.length ? ts[i + 1] : dur * 1000); hold.push(ys[i], ys[i]); });
    const nyq = fs / 2, falias = Math.abs(f - fs * Math.round(f / fs));
    const series = [{ x: tc, y: yc, color: T.muted, width: 1.2, label: 'continuous signal' }, { x: tHold, y: hold, color: T.series[0], width: 2, label: 'digitized (held)' }];
    if (f > nyq) {
      // sin(2 pi f t) and sin(2 pi (f - k fs) t) agree at every sample time k / fs
      const fa = f - Math.round(f / fs) * fs;
      const ya = tc.map(t => A * H.mag * Math.sin(2 * Math.PI * fa * t / 1000 + H.phase));
      series.push({ x: tc, y: ya, color: T.series[1], width: 1.5, dash: [5, 4], label: `alias at ${falias.toFixed(1)} Hz` });
    }
    if (!st.dig) st.dig = new D.Plot($('cvDig'), { height: 280 });
    st.dig.draw({
      series, xLabel: 'time (ms)', yLabel: 'µV', yRange: [-Math.max(range, A) * 1.08, Math.max(range, A) * 1.08],
      hlines: [{ y: range, color: T.crit, dash: [2, 3] }, { y: -range, color: T.crit, dash: [2, 3] }],
      markers: ts.map((t, i) => ({ x: t, y: ys[i], color: T.series[0], r: fs > 400 ? 2 : 3 })),
      tipX: x => `${x.toFixed(1)} ms`
    });
    ui.legend($('digLegend'), [{ color: T.muted, label: 'continuous signal' }, { color: T.series[0], label: 'digitized samples, held' }]
      .concat(f > nyq ? [{ color: T.series[1], label: `apparent ${falias.toFixed(1)} Hz`, dash: true }] : [])
      .concat([{ color: T.crit, label: 'input range', dash: true }]));
    ui.readouts($('digReadouts'), [
      ['Nyquist', nyq + ' Hz'],
      ['Appears at', (f > nyq ? falias.toFixed(1) : f) + ' Hz', f > nyq ? 'aliased' : 'faithful'],
      ['Step size', EEG.fmt(step, step < 1 ? 3 : 1) + ' µV'],
      ['Dynamic range', (6.02 * bits).toFixed(0) + ' dB'],
      ['Filter gain', aa ? (H.mag * 100).toFixed(0) + '%' : 'no filter'],
      ['Clipping', A * H.mag > range ? 'yes' : 'no']
    ]);
  }

  /* ===== stage switching and animation ===== */
  function showStage(s) {
    st.stage = s;
    ['neurons', 'layers', 'electrodes', 'amplifier', 'digitizer'].forEach(k => { $('stage-' + k).hidden = k !== s; });
    Array.from($('chainStages').querySelectorAll('button')).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stage === s)));
    render();
  }
  function loop(ts) {
    if (EEG.S.tab !== 'chain' || st.stage !== 'neurons' || document.hidden) { st.anim = null; return; }
    drawNeurons(ts / 1000);
    st.anim = requestAnimationFrame(loop);
  }
  function render() {
    if (st.stage === 'neurons') {
      neuronNumbers();
      if (reduced) drawNeurons(0.3);
      else if (!st.anim) st.anim = requestAnimationFrame(loop);
    } else if (st.stage === 'layers') drawLayers();
    else if (st.stage === 'electrodes') drawCap();
    else if (st.stage === 'amplifier') drawAmp();
    else drawDig();
  }

  EEG.tabs.chain = {
    init() {
      $('chainStages').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showStage(b.dataset.stage); });
      ['nrnPatch', 'nrnArea', 'nrnSync'].forEach(id => $(id).addEventListener('input', () => { neuronNumbers(); if (reduced) drawNeurons(0.3); }));
      ['lyrRatio', 'lyrDepth', 'lyrCSF'].forEach(id => $(id).addEventListener('input', drawLayers));
      $('btnUseSkull').addEventListener('click', () => {
        if (!EEG.S.cfg) return;
        const ratio = parseFloat($('lyrRatio').value), s = EEG.S.cfg.head.sigma;
        s[2] = s[0] / ratio; s[1] = $('lyrCSF').checked ? EEG.HEAD.sigma[1] : s[0];
        EEG.S.cfg.head.homogeneous = false;
        $('useSkullNote').textContent = `Rebuilt with a 1 : ${ratio} skull${$('lyrCSF').checked ? '' : ' and no CSF'}.`;
        EEG.app.rebuildFromCfg();
      });
      const seg = ui.seg($('capSeg'), n => { st.cap = +n; drawCap(); });
      st.capSeg = seg;
      $('cvCap').addEventListener('click', e => {
        const r = $('cvCap').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 400;
        (st.capPts || []).forEach(p => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p.l; } });
        if (best) { st.selElec = best; drawCap(); }
      });
      ['ampZa', 'ampZr', 'ampZin', 'ampCMRR', 'ampVcm', 'ampSig'].forEach(id => $(id).addEventListener('input', drawAmp));
      ['digFreq', 'digAmp', 'digFs', 'digBits', 'digRange', 'digAA'].forEach(id => $(id).addEventListener('input', drawDig));
      document.addEventListener('visibilitychange', () => { if (!document.hidden && EEG.S.tab === 'chain') render(); });
    },
    onBuild() {
      const R = EEG.S.cfg.recording;
      st.cap = R.cap; if (st.capSeg) st.capSeg.set(R.cap);
      st.selElec = R.reference;
      const ratio = Math.round(EEG.S.cfg.head.sigma[0] / EEG.S.cfg.head.sigma[2]);
      $('lyrRatio').value = EEG.clamp(ratio, 5, 120);
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
