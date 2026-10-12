/* MEG simulator: the Sources tab.  Where the recording's sources are, what
   each one does at the sensors, what one sensor really records, and the
   mixing matrix that ties them together. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, v3 = MEG.v3, S = MEG.S;
  const $ = ui.$;
  const st = { sel: 0, hits: [], plots: {}, mapMode: 'rms' };
  const FREE = ['dipole', 'spike', 'pair'];

  // Every dipole the user can select, in program order.
  function editable() {
    const out = [];
    if (!S.cfg) return out;
    S.cfg.sources.forEach((s, si) => {
      if (s.dipoles) s.dipoles.forEach((d, k) => out.push({ si, k, s, g: d, label: `${s.label} · ${d.name}`, free: s.type === 'pair' }));
      else out.push({ si, k: null, s, g: s, label: s.label, free: true });
    });
    return out;
  }
  const gensOf = (s, k) => S.ds.gens.map((g, i) => ({ g, i })).filter(x => x.g.kind === 'source' && x.g.group === s.name && (k === null || k === undefined || x.g.part === k));

  /* ---------- head views ---------- */
  function drawHeads() {
    const cv = $('cvHeads'), T = D.theme();
    const { ctx, w } = D.fit(cv, w => Math.min(280, w / 3 + 22));
    const size = Math.min(w / 3, 270);
    const items = editable();
    st.hits = [];
    ['top', 'side', 'back'].forEach((view, i) => {
      const x = i * (w / 3) + (w / 3 - size) / 2;
      const hv = D.head(ctx, x, 0, size, view, { labels: true, helmet: S.ds.array.type !== 'opm', opm: S.ds.array.type === 'opm' });
      S.ds.gens.filter(g => g.kind === 'background').forEach(b => D.dipole(ctx, hv, b.pos, b.ori, D.alpha(T.muted, 0.35), { len: 1.2, width: 1 }));
      const order = items.map((it, j) => j).sort((a, b) => hv.depthOf(items[a].g.pos) - hv.depthOf(items[b].g.pos));
      order.forEach(j => {
        const it = items[j];
        const p = D.dipole(ctx, hv, it.g.pos, it.g.ori, ui.sourceColor(it.si), { selected: j === st.sel, len: 2.4 });
        st.hits.push({ j, x: p[0], y: p[1] });
      });
    });
    ui.legend($('srcLegend'), S.cfg.sources.map((s, i) => ({ color: ui.sourceColor(i), label: s.label, dot: true }))
      .concat(S.ds.gens.some(g => g.kind === 'background') ? [{ color: T.muted, label: 'background brain activity', dot: true }] : [])
      .concat([{ color: T.coil, label: S.ds.array.type === 'opm' ? 'OPMs' : 'coils near each section' }]));
  }

  /* ---------- editor ---------- */
  function syncEditor() {
    const items = editable();
    if (st.sel >= items.length) st.sel = 0;
    ui.fill($('srcSel'), items.map((it, j) => ({ value: String(j), label: it.label })), String(st.sel));
    const it = items[st.sel];
    Array.from($('srcControls').querySelectorAll('input,select')).forEach(e => { e.disabled = !it; });
    $('btnWriteBack').disabled = !it;
    if (!it) { $('srcNote').textContent = 'This program has no brain sources to move.'; return; }
    const g = it.g;
    const at = g.at || MEG.nearestPlace(g.pos);
    ui.fill($('srcAt'), MEG.PLACES.slice().sort().map(k => ({ value: k, label: k })), at);
    const ang = MEG.orientationAngles(g.pos, g.ori);
    st.r.depth.set(MEG.depthOf(g.pos).toFixed(1));
    st.r.tilt.set(Math.round(ang.tilt));
    st.r.dir.set(Math.round(ang.dir));
    st.r.amp.set(Math.log10(Math.max(1, Math.abs(it.s.amp || 1))));
    ['srcAt', 'srcTilt', 'srcDir'].forEach(id => { $(id).disabled = !it.free; });
    $('srcNote').textContent = !it.free ? `The ${it.s.type} source's place is set by its type; move it deeper or shallower, or use a dipole source to put a source anywhere.`
      : it.s.type === 'pair' ? 'Strength is shared by both dipoles of the pair.' : '';
  }
  // Move the selected source.  The picture follows at once; the recording when the slider rests.
  let pending = null;
  function applyEdit() {
    const items = editable(), it = items[st.sel];
    if (!it) return;
    const s = it.s, depth = st.r.depth.get();
    if (it.free) {
      const g = it.g, at = $('srcAt').value, tilt = st.r.tilt.get(), dir = st.r.dir.get();
      g.at = at; g.depth = depth; g.pos = MEG.placeAt(at, depth); g.tilt = tilt; g.dir = dir; g.toward = null;
      g.ori = MEG.orientation(g.pos, tilt, dir, null);
    } else {
      s.depth = MEG.clamp(depth, 1.5, 6);
      s.dipoles = s.type === 'alpha' ? MEG.alphaDipoles(s.depth) : MEG.evokedDipoles(s);
    }
    s.amp = Math.round(Math.pow(10, st.r.amp.get())) * ((s.amp || 1) < 0 ? -1 : 1);
    pending = s;
    drawHeads(); drawTopo();
    $('srcNote').textContent = 'Changed by the controls; the program text is unchanged until you copy these settings into it.';
    commit();
  }
  const commit = ui.debounce(() => {
    const s = pending; pending = null; if (!s || !S.ds) return;
    const ds = S.ds, on = S.enabled.has(s.name), opt = MEG.app.sumOpts();
    if (on) MEG.sumGroups(ds, new Set([s.name]), Object.assign({}, opt, { into: S.sum, subtract: true }));
    gensOf(s).forEach(({ g, i }) => {
      const geo = s.dipoles ? s.dipoles[g.part] || s.dipoles[0] : s;
      g.pos = geo.pos; g.ori = geo.ori; g.geom = geo;
      // the strength control is the evoked or ongoing source's; a beta rhythm has its own amplitude
      if (!g.rhythm) {
        const amp0 = g.ampNow === undefined ? Math.abs(g.ampInit === undefined ? (g.ampInit = Math.abs(s.ampInit || s.amp)) : g.ampInit) : g.ampNow;
        const amp1 = Math.abs(s.amp), ratio = amp0 ? amp1 / amp0 : 1;
        if (ratio !== 1) { const tc = g.tc; for (let n = 0; n < tc.length; n++) tc[n] *= ratio; }
        g.ampNow = amp1;
      }
      MEG.refreshGen(ds, i);
    });
    if (on) MEG.sumGroups(ds, new Set([s.name]), Object.assign({}, opt, { into: S.sum }));
    if (S.ica.model) S.ica.changed = true;
    MEG.app.run('finish');
  }, 300);

  /* ---------- the selected source's map ---------- */
  function headChans() { return MEG.inverse.headChannels(S.ds); }
  function drawTopo() {
    const items = editable(), it = items[st.sel];
    const cv = $('cvSrcTopo'), arr = S.ds.array;
    if (!it) { D.message(cv, 'No source selected.'); ui.readouts($('srcReadouts'), []); return; }
    const v = MEG.forwardMEG(headChans(), it.g.pos, v3.scale(it.g.ori, 10));
    const planar = arr.type === 'planar', mode = planar ? st.mapMode : null;
    const sv = D.siteValues(arr, v, mode);
    const seq = planar && mode === 'rms';
    const unit = planar && mode !== 'mag' ? 'fT/cm' : 'fT';
    const kind = planar ? (mode === 'mag' ? 'mag' : 'planar') : arr.type;
    $('srcMapHint').textContent = planar ? (mode === 'mag' ? 'magnetometers of the triplets' : 'length of the planar gradient') : MEG.SENSOR_INFO[arr.type].label.toLowerCase();
    let peak = 0, at = 0; arr.channels.forEach((c, i) => { if (c.kind === kind && Math.abs(v[i]) > peak) { peak = Math.abs(v[i]); at = i; } });
    D.topoCanvas(cv, D.sites(), sv, { unit, maxH: 320, title: `${it.label}, per 10 nAm`, sequential: seq, range: seq ? [0, Math.max(...sv) || 1] : (peak || 1), fmt: x => MEG.fmt(x, Math.abs(x) < 10 ? 1 : 0), floor0: seq });
    const ang = MEG.orientationAngles(it.g.pos, it.g.ori);
    const kindTxt = ang.tilt < 25 ? 'radial, pointing out' : ang.tilt > 155 ? 'radial, pointing in' : ang.tilt > 65 && ang.tilt < 115 ? 'tangential' : 'oblique';
    const total = Math.abs(it.s.amp || 0);
    ui.readouts($('srcReadouts'), [
      ['Largest', `${arr.channels[at].name} ${ui.fmtV(peak, unit)}`, 'per 10 nAm'],
      ['At full strength', ui.fmtV(peak * total / 10, unit), `${total} nAm`],
      ['Depth', MEG.depthOf(it.g.pos).toFixed(1) + ' cm'],
      ['Orientation', kindTxt],
      ['Seen by MEG', Math.round(Math.sin(ang.tilt * Math.PI / 180) * 100) + '% of the moment', 'only the tangential part makes a field outside a spherical head'],
      ['Where', MEG.mri.label(it.g.pos).replace(/^(left|right|midline:) /, (m, a) => a === 'midline:' ? 'midline ' : a + ' ')]
    ]);
  }

  /* ---------- one sensor, many sources ---------- */
  function drawDecomp() {
    const T = D.theme(), ds = S.ds, fs = ds.fs, arr = ds.array;
    const k = parseInt($('decompCh').value, 10);
    if (!(k >= 0)) return;
    const t0 = parseFloat($('decompT').value), i0 = Math.round(t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(5 * fs));
    $('decompTV').textContent = ui.fmtT(t0);
    const opt = Object.assign(MEG.app.sumOpts(), { range: [i0, i1] });
    const groups = ds.groups.filter(g => S.enabled.has(g.id) && !(g.id === 'movement' && arr.type !== 'opm') && !(g.id === 'bad' && ds.cfg.artifacts.bad.mode !== 'jumpy'));
    const n = i1 - i0;
    const parts = groups.map(g => {
      let y;
      if (g.id === 'sensor') {
        const u = MEG.sensorNoise(ds, k), gain = S.enabled.has('bad') && ds.cfg.artifacts.bad.mode === 'noisy' && arr.siteChannels[ds.badSite] && arr.siteChannels[ds.badSite].includes(k) ? 15 : 1;
        y = Float32Array.from({ length: n }, (_, i) => gain * u[i0 + i]);
      } else if (g.id === 'jumps' || g.id === 'bad') {
        const zero = Array.from({ length: arr.nch + arr.refs.length }, () => new Float32Array(n));
        y = MEG.finish(ds, zero, { enabled: new Set([g.id]), range: [i0, i1], room: S.shield.room }).rows[k];
      } else y = MEG.sumGroups(ds, new Set([g.id]), opt)[k];
      return { g, y };
    });
    const total = new Float32Array(n); parts.forEach(p => { for (let i = 0; i < n; i++) total[i] += p.y[i]; });
    let mx = 0; total.forEach(x => { mx = Math.max(mx, Math.abs(x)); });
    parts.forEach(p => p.y.forEach(x => { mx = Math.max(mx, Math.abs(x)); }));
    const unit = arr.channels[k].unit, rowsN = parts.length + 1, rh = 36;
    const cv = $('cvDecomp');
    const { ctx, w, h } = D.fit(cv, rowsN * rh + 24);
    const L = 150, X1 = w - 8;
    const draw = (y, row, color, label, sub) => {
      const ym = 8 + row * rh + rh / 2;
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, ym + 0.5); ctx.lineTo(X1, ym + 0.5); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = row === 0 ? 1.5 : 1.2; ctx.beginPath();
      const px = X1 - L, per = n / px;
      for (let c = 0; c < px; c++) {
        const a = Math.floor(c * per), b = Math.max(a + 1, Math.floor((c + 1) * per));
        let lo = Infinity, hi = -Infinity; for (let i = a; i < Math.min(n, b); i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
        if (!isFinite(lo)) continue;
        const x = L + c + 0.5; if (c === 0) ctx.moveTo(x, ym - lo / mx * rh * 0.9); else ctx.lineTo(x, ym - lo / mx * rh * 0.9); ctx.lineTo(x, ym - hi / mx * rh * 0.9);
      }
      ctx.stroke();
      ctx.fillStyle = row === 0 ? T.ink : T.ink2; ctx.font = D.font(11, row === 0 ? 650 : 400); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label.length > 22 ? label.slice(0, 21) + '…' : label, 4, ym - 6);
      ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.fillText(sub, 4, ym + 8);
    };
    draw(total, 0, T.trace, `${arr.channels[k].name}, recorded`, `${ui.fmtV(MEG.rms(total), unit)} RMS`);
    parts.sort((a, b) => MEG.rms(b.y) - MEG.rms(a.y)).forEach((p, i) => draw(p.y, i + 1, ui.groupColor(p.g.id), p.g.label, `${ui.fmtV(MEG.rms(p.y), unit)} RMS`));
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`5 s · each row spans ±${ui.fmtV(mx / 0.9, unit, 0)}`, X1, h - 2);
  }

  /* ---------- mixing matrix ---------- */
  function columns() {
    const ds = S.ds, cols = [];
    ds.gens.forEach((g, gi) => {
      if (g.kind !== 'source' || !S.enabled.has(g.group)) return;
      cols.push({ label: g.label, color: ui.groupColor(g.group), v: MEG.genPattern(ds, g), unit: 'per nAm' });
    });
    // one column per artifact: its strongest generator
    ds.groups.filter(g => g.kind === 'artifact' && S.enabled.has(g.id)).forEach(grp => {
      let best = null, bv = 0;
      ds.gens.forEach(g => {
        if (g.group !== grp.id) return;
        const p = MEG.genPattern(ds, g), tc = g.tcRoom ? (S.shield.room ? g.tcRoom : g.tcOpen) : g.tc;
        let pn = 0; p.forEach(x => { pn += x * x; });
        const sc = Math.sqrt(pn) * MEG.rms(tc, 0, Math.min(tc.length, 20000));
        if (sc > bv) { bv = sc; best = g; }
      });
      if (best) cols.push({ label: grp.label, color: ui.groupColor(grp.id), v: MEG.genPattern(ds, best), unit: 'relative' });
    });
    return cols;
  }
  function drawMixing() {
    const T = D.theme(), ds = S.ds, arr = ds.array;
    const rowsIdx = ui.chans();
    const cols = columns();
    const cv = $('cvMixing');
    if (!cols.length) { D.message(cv, 'No sources or artifacts are switched on.'); D.fit($('cvOverlap'), 10); return; }
    const top = 110, left = 64, rowH = Math.max(1.6, Math.min(12, 520 / rowsIdx.length));
    const { ctx, w } = D.fit(cv, top + rowH * rowsIdx.length + 8);
    const cw = Math.min(46, (w - left - 8) / cols.length);
    const norm = cols.map(c => { let mx = 0; rowsIdx.forEach(r => { mx = Math.max(mx, Math.abs(c.v[r])); }); return mx || 1; });
    const m = rowsIdx.map(r => Float32Array.from(cols, (c, j) => c.v[r] / norm[j]));
    D.heat(ctx, left, top, cw * cols.length, rowH * rowsIdx.length, m, v => D.lutRGB(v), false);
    ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
    for (let c = 1; c < cols.length; c++) { ctx.beginPath(); ctx.moveTo(left + c * cw, top); ctx.lineTo(left + c * cw, top + rowH * rowsIdx.length); ctx.stroke(); }
    ctx.fillStyle = T.ink2; ctx.font = D.font(Math.min(10, Math.max(8, rowH))); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const every = Math.ceil(10 / rowH);
    rowsIdx.forEach((c, r) => { if (r % every === 0) ctx.fillText(arr.channels[c].name, left - 4, top + (r + 0.5) * rowH); });
    cols.forEach((c, i) => {
      ctx.save(); ctx.translate(left + (i + 0.5) * cw, top - 6); ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = c.color; ctx.fillRect(-2, -4, 8, 8);
      ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(c.label.length > 20 ? c.label.slice(0, 19) + '…' : c.label, 10, 0); ctx.restore();
    });
    st.mix = { left, top, cw, rowH, cols, rowsIdx };
    // overlap: |cos| between columns over all channels, each channel divided by its noise
    const sig = MEG.app.chanSigma();
    const V = cols.map(c => { const x = Float64Array.from(c.v, (y, i) => y / sig[i]); let s = 0; x.forEach(y => { s += y * y; }); s = Math.sqrt(s) || 1; return x.map(y => y / s); });
    const k = cols.length, M = V.map(a => Float32Array.from(V, b => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return Math.abs(s); }));
    const cvO = $('cvOverlap');
    const cell = Math.max(12, Math.min(34, (w - 150) / k));
    const g2 = D.fit(cvO, 120 + cell * k);
    const L2 = 140, T2 = 112;
    D.heat(g2.ctx, L2, T2, cell * k, cell * k, M, v => D.lutRGB(v, true), false);
    g2.ctx.font = D.font(10); g2.ctx.fillStyle = T.ink2;
    cols.forEach((c, i) => {
      g2.ctx.textAlign = 'right'; g2.ctx.textBaseline = 'middle'; g2.ctx.fillText(c.label.length > 22 ? c.label.slice(0, 21) + '…' : c.label, L2 - 6, T2 + (i + 0.5) * cell);
      g2.ctx.save(); g2.ctx.translate(L2 + (i + 0.5) * cell, T2 - 6); g2.ctx.rotate(-Math.PI / 3); g2.ctx.textAlign = 'left'; g2.ctx.fillText(c.label.length > 16 ? c.label.slice(0, 15) + '…' : c.label, 0, 0); g2.ctx.restore();
      if (cell >= 22) for (let j = 0; j < k; j++) { const v = M[i][j]; g2.ctx.fillStyle = v > 0.6 ? T.card : T.ink; g2.ctx.textAlign = 'center'; g2.ctx.fillText(v.toFixed(2).replace(/^0/, ''), L2 + (j + 0.5) * cell, T2 + (i + 0.5) * cell); g2.ctx.fillStyle = T.ink2; }
    });
    st.ov = { L2, T2, cell, cols, M };
  }

  function render() {
    if (!S.ds) return;
    const arr = S.ds.array;
    $('srcKindBox').hidden = arr.type !== 'planar';
    drawHeads(); syncEditor(); drawTopo();
    const cur = $('decompCh').value;
    const opts = arr.channels.map((c, i) => ({ value: String(i), label: c.name }));
    ui.fill($('decompCh'), opts, opts.some(o => o.value === cur) ? cur : String(ui.bestChannel()));
    $('decompT').max = Math.max(0, S.ds.dur - 5).toFixed(1);
    drawDecomp(); drawMixing();
  }

  MEG.tabs.sources = {
    init() {
      st.r = {
        depth: ui.range('srcDepth', v => v.toFixed(1) + ' cm', applyEdit),
        tilt: ui.range('srcTilt', v => v.toFixed(0) + '°', applyEdit),
        dir: ui.range('srcDir', v => v.toFixed(0) + '°', applyEdit),
        amp: ui.range('srcAmp', v => Math.round(Math.pow(10, v)) + ' nAm', applyEdit)
      };
      $('srcAt').addEventListener('change', applyEdit);
      $('srcSel').addEventListener('change', () => { st.sel = +$('srcSel').value; drawHeads(); syncEditor(); drawTopo(); });
      $('cvSrcTopo').insertAdjacentHTML('beforebegin', '<div class="btnrow" id="srcKindBox" style="margin-bottom:6px" hidden><span class="lbl" style="margin:0">Show</span><div class="seg" id="srcKind"><button data-m="rms" aria-pressed="true">Planar gradient</button><button data-m="mag" aria-pressed="false">Magnetometers</button></div></div>');
      ui.seg($('srcKind'), v => { st.mapMode = v; drawTopo(); });
      $('cvHeads').classList.add('click');
      $('cvHeads').addEventListener('click', e => {
        const r = $('cvHeads').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 18 * 18;
        st.hits.forEach(h => { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h.j; } });
        if (best !== null) { st.sel = best; drawHeads(); syncEditor(); drawTopo(); }
      });
      $('btnWriteBack').addEventListener('click', () => {
        MEG.app.setProgram(MEG.dsl.serialize(S.cfg, (MEG.EXAMPLES[S.exIndex] || {}).name + ', edited on the Sources tab'));
        $('srcNote').textContent = 'The program on the Experiment tab now matches these settings (its comments were not kept).';
      });
      $('decompCh').addEventListener('change', drawDecomp);
      $('decompT').addEventListener('input', ui.debounce(drawDecomp, 60));
      const tipMix = e => {
        const m = st.mix; if (!m) return;
        const r = $('cvMixing').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const c = Math.floor((x - m.left) / m.cw), row = Math.floor((y - m.top) / m.rowH);
        if (c < 0 || c >= m.cols.length || row < 0 || row >= m.rowsIdx.length) { D.tip(0, 0, null); return; }
        const col = m.cols[c], ch = m.rowsIdx[row], unit = S.ds.array.channels[ch].unit;
        D.tip(e.clientX, e.clientY, `<div style="color:var(--muted)">${S.ds.array.channels[ch].name}</div>` + D.tipRow(col.color, col.label, col.unit === 'per nAm' ? `${MEG.fmt(col.v[ch], 2)} ${unit} per nAm` : MEG.fmt(col.v[ch], 2)));
      };
      $('cvMixing').addEventListener('mousemove', tipMix);
      $('cvMixing').addEventListener('mouseleave', () => D.tip(0, 0, null));
      $('cvOverlap').addEventListener('mousemove', e => {
        const o = st.ov; if (!o) return;
        const r = $('cvOverlap').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const i = Math.floor((y - o.T2) / o.cell), j = Math.floor((x - o.L2) / o.cell);
        if (i < 0 || j < 0 || i >= o.cols.length || j >= o.cols.length) { D.tip(0, 0, null); return; }
        D.tip(e.clientX, e.clientY, `${o.cols[i].label} and ${o.cols[j].label}: <b>${o.M[i][j].toFixed(2)}</b>`);
      });
      $('cvOverlap').addEventListener('mouseleave', () => D.tip(0, 0, null));
    },
    onBuild(keepSel) {
      if (!keepSel) {
        st.sel = 0;
        const ev = S.ds.events[0];
        $('decompT').max = Math.max(0, S.ds.dur - 5).toFixed(1);
        $('decompT').value = ev ? Math.max(0, ev.t - 0.5).toFixed(1) : 0;
      }
      // the generators were just made at the present strengths
      S.cfg.sources.forEach(s => { s.ampInit = s.amp; });
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
