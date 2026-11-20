/* EEG simulator: the Sources & head tab.  Where the sources are, what
   each one does to the scalp, what one electrode really records, and the
   mixing matrix that ties them together. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui, v3 = EEG.v3;
  const $ = ui.$, S = EEG.S;
  const st = { sel: 0, hits: [], decompPlot: null };

  /* Apply the current re-reference to one vector over the recorded rows
     (cap channels then M1, M2), by running the real re-referencing on a
     one-sample recording.  Returns values over the current montage. */
  EEG.refVector = function (v, mode) {
    const rec = { labels: S.ds.rowLabels, rows: Array.from(v, x => Float32Array.of(x)), nCap: S.ds.nCap };
    const out = EEG.dsp.rereference(rec, mode || S.proc.reref, EEG.splineCache);
    return { labels: out.labels, values: Float64Array.from(out.rows, r => r[0]), unit: out.unit, positions: out.positions };
  };

  // Every dipole the user can move, in program order.
  function editable() {
    const out = [];
    if (!S.cfg) return out;
    S.cfg.sources.forEach((s, si) => {
      if (s.dipoles) s.dipoles.forEach((d, k) => out.push({ si, k, s, g: d, label: `${s.label} · ${d.name}` }));
      else out.push({ si, k: null, s, g: s, label: s.label });
    });
    return out;
  }
  function genFor(item) {
    return S.ds.gens.find(g => g.kind === 'source' && g.group === item.s.name && (item.k === null || g.part === item.k));
  }

  /* ---------- head views ---------- */
  function drawHeads() {
    const cv = $('cvHeads'), T = D.theme();
    const { ctx, w } = D.fit(cv, w => Math.min(270, w / 3 + 14));
    const size = Math.min(w / 3, 256);
    const items = editable();
    st.hits = [];
    ['top', 'side', 'back'].forEach((view, i) => {
      const x = i * (w / 3) + (w / 3 - size) / 2;
      const hv = D.head(ctx, x, 0, size, view, { labels: true, electrodes: view === 'top' ? S.ds.capLabels : null, homogeneous: S.cfg.head.homogeneous });
      (S.ds.bgDipoles || []).forEach(b => D.dipole(ctx, hv, b.pos, b.ori, D.alpha(T.muted, 0.35), { len: 1.2, width: 1 }));
      const order = items.map((it, j) => j).sort((a, b) => hv.depthOf(items[a].g.pos) - hv.depthOf(items[b].g.pos));
      order.forEach(j => {
        const it = items[j];
        const p = D.dipole(ctx, hv, it.g.pos, it.g.ori, ui.sourceColor(it.si), { selected: j === st.sel, len: 2.4 });
        st.hits.push({ j, x: p[0], y: p[1] });
      });
    });
    ui.legend($('srcLegend'), S.cfg.sources.map((s, i) => ({ color: ui.sourceColor(i), label: s.label, dot: true }))
      .concat(S.ds.bgDipoles ? [{ color: T.muted, label: 'background EEG generators', dot: true }] : []));
  }

  /* ---------- editor ---------- */
  function syncEditor() {
    const items = editable();
    ui.fill($('srcSel'), items.map((it, j) => ({ value: String(j), label: it.label })), String(st.sel));
    const it = items[st.sel];
    const box = $('srcControls');
    Array.from(box.querySelectorAll('input,select')).forEach(e => { e.disabled = !it; });
    $('btnWriteBack').disabled = !it;
    if (!it) { $('srcNote').textContent = 'This program has no movable sources.'; return; }
    const g = it.g;
    const at = g.at || EEG.nearestElectrode(g.pos, Object.keys(EEG.ELEC).filter(k => !['M1', 'M2', 'Nz'].includes(k)));
    ui.fill($('srcAt'), EEG.DISPLAY_ORDER.filter(k => k !== 'M1' && k !== 'M2').map(k => ({ value: k, label: k })), at);
    const ang = EEG.orientationAngles(g.pos, g.ori);
    st.r.depth.set(EEG.depthOf(g.pos).toFixed(1));
    st.r.tilt.set(Math.round(ang.tilt));
    st.r.dir.set(Math.round(ang.dir));
    st.r.amp.set(Math.log10(Math.max(1, Math.abs(it.s.amp))));
    $('srcNote').textContent = it.s.type === 'pair' || it.s.type === 'alpha' ? 'Strength is shared by both dipoles of this source.' : '';
  }
  // Move the selected dipole and update its generator in place.
  const applyLater = ui.debounce(() => EEG.app.run('assemble'), 250);
  function applyEdit() {
    const items = editable(), it = items[st.sel];
    if (!it) return;
    const g = it.g, s = it.s;
    const at = $('srcAt').value, depth = st.r.depth.get(), tilt = st.r.tilt.get(), dir = st.r.dir.get();
    g.at = at; g.depth = depth; g.pos = EEG.placeDipole(at, depth); g.tilt = tilt; g.dir = dir; g.toward = null;
    g.ori = EEG.orientation(g.pos, tilt, dir, null);
    const newAmp = Math.round(Math.pow(10, st.r.amp.get())) * (s.amp < 0 ? -1 : 1);
    const ratio = s.amp ? newAmp / s.amp : 1;
    s.amp = newAmp;
    S.ds.gens.forEach(gen => {
      if (gen.kind !== 'source' || gen.group !== s.name) return;
      if (ratio !== 1) for (let i = 0; i < gen.tc.length; i++) gen.tc[i] *= ratio;
      if (it.k === null || gen.part === it.k) {
        gen.pos = g.pos; gen.ori = g.ori;
        const L = EEG.leadfield(S.ds.model, g.pos, S.ds.elecU);
        gen.topo = Float64Array.from(S.ds.elecU, (_, e) => L[3 * e] * g.ori[0] + L[3 * e + 1] * g.ori[1] + L[3 * e + 2] * g.ori[2]);
      }
    });
    if (s.type === 'alpha' && s.dipoles) s.depth = depth;
    S.truth = null;
    drawHeads(); drawTopo();
    $('srcNote').textContent = 'Changed by the controls; the program text is unchanged until you copy these settings into it.';
    applyLater();
  }

  /* ---------- the selected source's map ---------- */
  function drawTopo() {
    const items = editable(), it = items[st.sel];
    const cv = $('cvSrcTopo');
    if (!it) { D.fit(cv, 60); ui.readouts($('srcReadouts'), []); return; }
    const gen = genFor(it);
    const caps = S.ds.capLabels;
    const rv = EEG.rowTopo(S.ds, gen.topo).slice(0, S.ds.nCap);
    const m = EEG.mean(rv);
    const v = rv.map(x => (x - m) * 10);
    const out = D.topoCanvas(cv, caps, v, { unit: 'µV', maxH: 330, names: caps.length <= 32, title: `${it.label}, per 10 nAm` });
    let iMax = 0, iMin = 0; v.forEach((x, i) => { if (x > v[iMax]) iMax = i; if (x < v[iMin]) iMin = i; });
    const ang = EEG.orientationAngles(it.g.pos, it.g.ori);
    const kind = ang.tilt < 25 ? 'radial, pointing out' : ang.tilt > 155 ? 'radial, pointing in' : ang.tilt > 65 && ang.tilt < 115 ? 'tangential' : 'oblique';
    const total = Math.abs(it.s.amp);
    ui.readouts($('srcReadouts'), [
      ['Most positive', `${caps[iMax]} ${EEG.fmt(v[iMax], 2)} µV`],
      ['Most negative', `${caps[iMin]} ${EEG.fmt(v[iMin], 2)} µV`],
      ['Depth', EEG.depthOf(it.g.pos).toFixed(1) + ' cm'],
      ['Orientation', kind],
      ['At full strength', `${EEG.fmt(Math.max(Math.abs(v[iMax]), Math.abs(v[iMin])) * total / 10, 1)} µV`, `${total} nAm`]
    ]);
  }

  /* ---------- one electrode, many sources ---------- */
  function drawDecomp() {
    const T = D.theme(), ds = S.ds, fs = ds.fs;
    const labels = S.filt.labels;
    const ch = $('decompCh').value;
    const k = labels.indexOf(ch);
    if (k < 0) return;
    const t0 = parseFloat($('decompT').value), i0 = Math.round(t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(5 * fs));
    $('decompTV').textContent = ui.fmtT(t0);
    const groups = ds.groups.filter(g => S.enabled.has(g.id));
    const piece = en => {
      const rec = EEG.assemble(ds, { enabled: en, range: [i0, i1], quantize: false, filters: false });
      return EEG.dsp.rereference(rec, S.proc.reref, EEG.splineCache).rows[k];
    };
    const total = piece(new Set(groups.map(g => g.id)));
    const parts = groups.map(g => ({ g, y: piece(new Set([g.id])) }));
    let mx = 0; total.forEach(x => { mx = Math.max(mx, Math.abs(x)); });
    parts.forEach(p => p.y.forEach(x => { mx = Math.max(mx, Math.abs(x)); }));
    const rowsN = parts.length + 1, rh = 38;
    const cv = $('cvDecomp');
    const { ctx, w, h } = D.fit(cv, rowsN * rh + 24);
    const L = 150, X1 = w - 8, n = total.length;
    const draw = (y, row, color, label, sub) => {
      const ym = 8 + row * rh + rh / 2;
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, ym + 0.5); ctx.lineTo(X1, ym + 0.5); ctx.stroke();
      ctx.strokeStyle = color; ctx.lineWidth = row === 0 ? 1.6 : 1.3; ctx.beginPath();
      const step = Math.max(1, Math.floor(n / (X1 - L) / 2));
      for (let i = 0; i < n; i += step) { const x = L + i / (n - 1) * (X1 - L), yy = ym - y[i] / mx * rh * 0.9; i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }
      ctx.stroke();
      ctx.fillStyle = row === 0 ? T.ink : T.ink2; ctx.font = D.font(11, row === 0 ? 650 : 400); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, 4, ym - 6);
      ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.fillText(sub, 4, ym + 8);
    };
    draw(total, 0, T.trace, `${ch}, recorded`, `${EEG.fmt(EEG.rms(total), 1)} µV RMS`);
    parts.sort((a, b) => EEG.rms(b.y) - EEG.rms(a.y)).forEach((p, i) => draw(p.y, i + 1, ui.groupColor(p.g.id), p.g.label, `${EEG.fmt(EEG.rms(p.y), 2)} µV RMS`));
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`5 s · each row spans ±${EEG.fmt(mx / 0.9, 0)} ${S.filt.unit}`, X1, h - 2);
  }

  /* ---------- mixing matrix ---------- */
  function drawMixing() {
    const T = D.theme(), ds = S.ds;
    const cols = [];
    ds.gens.forEach(g => {
      if (!S.enabled.has(g.group)) return;
      cols.push({ label: g.label, color: ui.groupColor(g.group), v: EEG.refVector(EEG.rowTopo(ds, g.topo)).values, unit: g.kind === 'source' ? 'µV per nAm' : 'relative' });
    });
    if (S.enabled.has('line')) {
      const k = EEG.lineCoupling(ds, S.enabled.has('bad'));
      cols.push({ label: 'Line noise', color: T.series[7], v: EEG.refVector(k).values, unit: 'relative' });
    }
    const labels = S.filt.labels;
    const cv = $('cvMixing');
    if (!cols.length) { const g = D.fit(cv, 60); g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.fillText('No generators are switched on.', 10, 30); return; }
    const top = 110, left = 64, rowH = Math.max(6, Math.min(14, 520 / labels.length));
    const { ctx, w, h } = D.fit(cv, top + rowH * labels.length + 8);
    const cw = Math.min(46, (w - left - 8) / cols.length);
    const m = labels.map((_, r) => Float32Array.from(cols, c => { let mx = 0; c.v.forEach(x => { mx = Math.max(mx, Math.abs(x)); }); return c.v[r] / (mx || 1); }));
    D.heat(ctx, left, top, cw * cols.length, rowH * labels.length, m, v => D.lutRGB(v), false);
    ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
    for (let c = 1; c < cols.length; c++) { ctx.beginPath(); ctx.moveTo(left + c * cw, top); ctx.lineTo(left + c * cw, top + rowH * labels.length); ctx.stroke(); }
    ctx.fillStyle = T.ink2; ctx.font = D.font(Math.min(10, rowH)); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const every = rowH < 8 ? 2 : 1;
    labels.forEach((l, r) => { if (r % every === 0) ctx.fillText(l, left - 4, top + (r + 0.5) * rowH); });
    cols.forEach((c, i) => {
      ctx.save(); ctx.translate(left + (i + 0.5) * cw, top - 6); ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = c.color; ctx.fillRect(-2, -4, 8, 8);
      ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(c.label, 10, 0); ctx.restore();
    });
    st.mix = { left, top, cw, rowH, cols, labels };
  }

  function render() {
    if (!S.ds) return;
    drawHeads(); syncEditor(); drawTopo();
    const labels = S.filt.labels;
    const cur = $('decompCh').value;
    ui.fill($('decompCh'), ui.chOptions(labels), labels.includes(cur) ? cur : ui.pick(labels, ['Fp1', 'Fp1-F7', 'Pz', 'Cz']));
    $('decompT').max = Math.max(0, S.ds.dur - 5).toFixed(1);
    drawDecomp(); drawMixing();
  }

  EEG.tabs.sources = {
    init() {
      st.r = {
        depth: ui.range('srcDepth', v => v.toFixed(1) + ' cm', applyEdit),
        tilt: ui.range('srcTilt', v => v.toFixed(0) + '°', applyEdit),
        dir: ui.range('srcDir', v => v.toFixed(0) + '°', applyEdit),
        amp: ui.range('srcAmp', v => Math.round(Math.pow(10, v)) + ' nAm', applyEdit)
      };
      $('srcAt').addEventListener('change', applyEdit);
      $('srcSel').addEventListener('change', () => { st.sel = +$('srcSel').value; drawHeads(); syncEditor(); drawTopo(); });
      $('cvHeads').addEventListener('click', e => {
        const r = $('cvHeads').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        let best = null, bd = 18 * 18;
        st.hits.forEach(h => { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h.j; } });
        if (best !== null) { st.sel = best; drawHeads(); syncEditor(); drawTopo(); }
      });
      $('btnWriteBack').addEventListener('click', () => {
        const ed = $('editor');
        ed.value = EEG.dsl.serialize(S.cfg, (EEG.EXAMPLES[S.exIndex] || {}).name + ', edited on the Sources tab');
        ed.dispatchEvent(new Event('input'));
        S.src = ed.value;
        $('srcNote').textContent = 'The program on the Experiment tab now matches these settings (its comments were not kept).';
      });
      const skull = ui.range('skullRatio', v => '1 : ' + v, null);
      st.skull = skull;
      const rebuild = ui.debounce(() => {
        const s = S.cfg.head.sigma;
        s[2] = s[0] / skull.get();
        S.cfg.head.homogeneous = $('homog').checked;
        EEG.app.rebuildFromCfg();
      }, 400);
      skull.el.addEventListener('input', rebuild);
      $('homog').addEventListener('change', rebuild);
      $('decompCh').addEventListener('change', drawDecomp);
      $('decompT').addEventListener('input', ui.debounce(drawDecomp, 60));
      $('cvMixing').addEventListener('mousemove', e => {
        const m = st.mix; if (!m) return;
        const r = $('cvMixing').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const c = Math.floor((x - m.left) / m.cw), row = Math.floor((y - m.top) / m.rowH);
        if (c < 0 || c >= m.cols.length || row < 0 || row >= m.labels.length) { D.tip(0, 0, null); return; }
        const col = m.cols[c];
        D.tip(e.clientX, e.clientY, `<div style="color:var(--muted)">${m.labels[row]}</div>` + D.tipRow(col.color, col.label, `${EEG.fmt(col.v[row], 3)} ${col.unit}`));
      });
      $('cvMixing').addEventListener('mouseleave', () => D.tip(0, 0, null));
    },
    onBuild(keepSel) {
      if (!keepSel) {
        st.sel = 0;
        // start the decomposition where the most is happening: just before the first stimulus
        const ev = S.ds.events[0];
        $('decompT').max = Math.max(0, S.ds.dur - 5).toFixed(1);
        $('decompT').value = ev ? Math.max(0, ev.t - 0.5).toFixed(1) : 0;
      }
      const h = S.cfg.head;
      st.skull && st.skull.set(Math.round(h.sigma[0] / h.sigma[2]));
      $('homog').checked = h.homogeneous;
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
