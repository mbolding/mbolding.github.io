/* MEG simulator: the Recording tab.  Scrolling multichannel traces as
   recorded, after noise rejection or fully processed; the field map at a
   cursor; the reference channels; and a switch for every signal. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S;
  const $ = ui.$;
  const st = { view: 'raw', t0: 0, playing: false, raf: null, layout: null, scaleKey: '' };
  const REGION_ORDER = ['F', 'C', 'T', 'P', 'O'];

  // Channel subsets: a sample across the head, or one region.
  function chanList() {
    const arr = S.ds.array, sel = $('recChans').value;
    const kind = arr.type === 'planar' ? $('recKind').value : arr.type;
    let idx = arr.channels.map((c, i) => (c.kind === kind ? i : -1)).filter(i => i >= 0);
    const site = c => MEG.SITES[arr.channels[c].site];
    if (sel === 'sample') idx = idx.filter((c, k) => k % 3 === 0);
    else if (sel !== 'all') {
      const [side, lobe] = sel.split(':');
      idx = idx.filter(c => site(c).lobe === lobe && (side === '*' || site(c).side === side || site(c).side === 'Z'));
    }
    return { idx, kind, unit: ui.unitOf(kind) };
  }
  function rowsOf() {
    if (st.view === 'raw') return { rows: S.rec.rows, title: 'as recorded' };
    if (st.view === 'sup') return { rows: S.sup.rows, title: S.sup.steps.length ? 'after ' + S.sup.steps.join(', ') : 'no noise rejection chosen' };
    const P = S.proc, f = [P.hp ? P.hp + ' Hz high-pass' : null, P.lp ? P.lp + ' Hz low-pass' : null, P.notch ? P.notch + ' Hz notch' : null].filter(Boolean);
    return { rows: S.clean, title: `processed: ${S.sup.steps.length ? S.sup.steps.join(', ') + ', ' : ''}${f.join(', ') || 'no filters'}${S.ica.model && !S.ica.stale && S.ica.rejected.size ? `, ${S.ica.rejected.size} ICA components removed` : ''}` };
  }
  // A scale that suits the data on screen: about four RMS per row.
  const SCALES = [10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8];
  function autoScale(rows, idx, i0, i1) {
    let s = 0, n = 0;
    idx.forEach(c => { const r = rows[c]; let m = 0; const step = Math.max(1, Math.floor((i1 - i0) / 400)); let cnt = 0; for (let i = i0; i < i1; i += step) { m += r[i]; cnt++; } m /= cnt || 1; for (let i = i0; i < i1; i += step) { s += (r[i] - m) * (r[i] - m); n++; } });
    const rms = Math.sqrt(s / Math.max(1, n));
    return SCALES.find(v => v >= rms * 3) || SCALES[SCALES.length - 1];
  }

  // The highlighted signal's own contribution over the window, through the same steps as the view.
  function highlightRows(id, i0, i1) {
    const ds = S.ds, arr = ds.array, opt = Object.assign(MEG.app.sumOpts(), { range: [i0, i1] });
    let rows, refs;
    if (id === 'sensor' || id === 'jumps' || id === 'bad') {
      const zero = Array.from({ length: arr.nch + arr.refs.length }, () => new Float32Array(i1 - i0));
      const f = MEG.finish(ds, zero, { enabled: new Set([id === 'bad' ? 'bad' : id, ...(id === 'sensor' || (id === 'bad' && S.cfg.artifacts.bad.mode === 'noisy') ? ['sensor'] : [])]), range: [i0, i1], room: S.shield.room });
      rows = f.rows; refs = f.refs;
    } else { const all = MEG.sumGroups(ds, new Set([id]), opt); rows = all.slice(0, arr.nch); refs = all.slice(arr.nch); }
    if (st.view === 'raw') return { rows, refs };
    const sup = S.sup;
    const after = sup.steps.length ? MEG.suppress.decompose(ds, [{ rows, refs }], { W: sup.W, sss: sup.sss ? { order: sup.sss.order, tsss: false, compensate: sup.sss.comp, moving: sup.sss.moving, t: (i0 + i1) / 2 / ds.fs } : null, U: sup.U })[0] : rows;
    if (st.view === 'sup') return { rows: after, refs };
    const ch = S.filt.chain;
    return { rows: ch.empty ? after : after.map(r => ch.apply(Float32Array.from(r))), refs };
  }

  function drawTraces() {
    const T = D.theme(), ds = S.ds, fs = ds.fs, arr = ds.array;
    const { idx, unit } = chanList();
    const src = rowsOf();
    const showRefs = $('recRefs').checked;
    const win = parseFloat($('recWin').value);
    st.t0 = MEG.clamp(st.t0, 0, Math.max(0, ds.dur - win));
    $('recTime').max = Math.max(0, ds.dur - win).toFixed(1);
    $('recTime').value = st.t0;
    const i0 = Math.round(st.t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(win * fs));
    let scale = parseFloat($('recScale').value);
    if (!scale) scale = autoScale(src.rows, idx, i0, i1);
    const refScale = showRefs ? autoScale(S.rec.refs, S.rec.refs.map((_, i) => i), i0, i1) : 1;
    const butterfly = $('recButterfly').checked;
    const nCh = idx.length + (showRefs ? S.rec.refs.length : 0);
    const rowH = butterfly ? 0 : MEG.clamp(Math.floor(620 / Math.max(1, nCh)), 6, 26);
    const plotH = butterfly ? 340 : rowH * nCh;
    const cv = $('cvTraces');
    const { ctx, w } = D.fit(cv, plotH + 44);
    const L = 64, R = w - 34, Y0 = 6, Y1 = Y0 + plotH;
    const sx = t => L + (t - st.t0) / win * (R - L);
    st.layout = { L, R, Y0, Y1, rowH, butterfly, i0, i1, win, idx, scale, unit, src, showRefs, refScale };
    ds.blocks.forEach(b => {
      if (b.state !== 'closed' || b.t1 < st.t0 || b.t0 > st.t0 + win) return;
      ctx.fillStyle = T.closed; ctx.fillRect(Math.max(L, sx(b.t0)), Y0, Math.min(R, sx(b.t1)) - Math.max(L, sx(b.t0)), plotH);
    });
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = win <= 5 ? 0.5 : win <= 10 ? 1 : win <= 20 ? 2 : 5;
    for (let t = Math.ceil(st.t0 / step) * step; t <= st.t0 + win + 1e-9; t += step) {
      const x = Math.round(sx(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke();
      ctx.fillText(ui.fmtT(t), x, Y1 + 22);
    }
    ds.events.forEach(ev => {
      if (ev.t < st.t0 || ev.t > st.t0 + win) return;
      const x = Math.round(sx(ev.t)) + 0.5, col = ui.condColor(ev.ci);
      ctx.strokeStyle = D.alpha(col, 0.5); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, Y1 + 2); ctx.lineTo(x - 4, Y1 + 10); ctx.lineTo(x + 4, Y1 + 10); ctx.closePath(); ctx.fill();
    });
    const hid = $('recHighlight').value;
    const hl = hid ? highlightRows(hid, i0, i1) : null;
    const hcol = hid ? ui.groupColor(hid) : null;
    const n = i1 - i0;
    const half = butterfly ? plotH / 2 / 4 : rowH * 0.5;
    const traceOf = (y, ym, color, width, offset, sc, center) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      let m = 0;
      if (center) { const stp = Math.max(1, Math.floor(n / 300)); let cnt = 0; for (let i = 0; i < n; i += stp) { m += y[offset + i]; cnt++; } m /= cnt || 1; }
      const px = R - L, per = n / px;
      if (per > 2) {
        for (let c = 0; c < px; c++) {
          const a = Math.floor(c * per), b = Math.min(n, Math.floor((c + 1) * per));
          let lo = Infinity, hi = -Infinity;
          for (let i = a; i < b; i++) { const v = y[offset + i]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const x = L + c + 0.5;
          if (c === 0) ctx.moveTo(x, ym - (lo - m) / sc * half * 2); else ctx.lineTo(x, ym - (lo - m) / sc * half * 2);
          ctx.lineTo(x, ym - (hi - m) / sc * half * 2);
        }
      } else {
        for (let i = 0; i < n; i++) { const x = L + i / Math.max(1, n - 1) * (R - L), yy = ym - (y[offset + i] - m) / sc * half * 2; i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }
      }
      ctx.stroke();
      return m;
    };
    ctx.save(); ctx.beginPath(); ctx.rect(L, Y0, R - L, plotH); ctx.clip();
    idx.forEach((c, r) => {
      const ym = butterfly ? Y0 + plotH / 2 : Y0 + (r + 0.5) * rowH;
      const bad = S.enabled.has('bad') && ds.badSite >= 0 && arr.channels[c].site === ds.badSite;
      const m = traceOf(src.rows[c], ym, butterfly ? D.alpha(T.trace, 0.4) : (bad ? T.crit : T.trace), butterfly ? 0.8 : 1, i0, scale, true);
      if (hl) traceOf(hl.rows[c], ym, hcol, 1.5, 0, scale, true);
      void m;
    });
    if (showRefs && !butterfly) S.rec.refs.forEach((r, k) => {
      const ym = Y0 + (idx.length + k + 0.5) * rowH;
      traceOf(r, ym, T.series[6], 1, i0, refScale, true);
    });
    ctx.restore();
    // channel labels
    ctx.font = D.font(Math.min(11, Math.max(8, rowH - 1))); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    if (!butterfly) {
      const every = rowH >= 10 ? 1 : rowH >= 7 ? 2 : 3;
      idx.forEach((c, r) => { if (r % every) return; ctx.fillStyle = S.enabled.has('bad') && arr.channels[c].site === ds.badSite ? T.crit : T.ink2; ctx.fillText(arr.channels[c].name, L - 6, Y0 + (r + 0.5) * rowH); });
      if (showRefs) S.rec.refLabels.forEach((l, k) => { if (k % every) return; ctx.fillStyle = T.series[6]; ctx.fillText(l, L - 6, Y0 + (idx.length + k + 0.5) * rowH); });
    } else { ctx.fillStyle = T.ink2; ctx.fillText(`${idx.length} ${MEG.KIND_LABEL[arr.channels[idx[0]].kind]}`, L - 6, Y0 + plotH / 2); }
    // scale bar
    const bar = half * 2;
    ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(R + 12, Y1 - 4); ctx.lineTo(R + 12, Y1 - 4 - bar); ctx.stroke();
    ctx.save(); ctx.translate(R + 24, Y1 - 4 - bar / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'center';
    ctx.fillText(ui.fmtV(scale, unit, 0), 0, 0); ctx.restore();
    if (S.cursorT >= st.t0 && S.cursorT <= st.t0 + win) {
      const x = Math.round(sx(S.cursorT)) + 0.5;
      ctx.strokeStyle = T.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke();
    }
    const legend = [{ color: T.closed.replace(/[\d.]+\)$/, '0.6)'), label: 'eyes closed' }];
    ds.conditions.forEach((c, i) => legend.push({ color: ui.condColor(i), label: c }));
    if (hid) legend.push({ color: hcol, label: (ds.groups.find(g => g.id === hid) || {}).label + ', its own contribution' });
    if (showRefs) legend.push({ color: T.series[6], label: `reference sensors, ${ui.fmtV(refScale, 'fT', 0)} per row` });
    if (S.rec.saturated && st.view !== 'proc') legend.push({ color: T.crit, label: 'every OPM saturated: no shielded room' });
    ui.legend($('recLegend'), legend);
    $('recLegend').insertAdjacentHTML('afterbegin', `<span><b>${src.title}</b></span>`);
  }

  function drawCursorTopo() {
    const arr = S.ds.array, fs = S.ds.fs, src = rowsOf();
    const i = MEG.clamp(Math.round(S.cursorT * fs), 0, S.ds.n - 1);
    $('cursorTime').textContent = ui.fmtT(S.cursorT);
    const { kind, unit } = chanList();
    const v = Float64Array.from(arr.channels, (_, c) => src.rows[c][i]);
    // remove the mean of the map's channels so a slow drift does not hide the pattern
    const idx = ui.chans(kind); let m = 0; idx.forEach(c => { m += v[c]; }); m /= idx.length;
    if (kind !== 'planar') idx.forEach(c => { v[c] -= m; });
    const mode = arr.type === 'planar' ? (kind === 'planar' ? 'rms' : 'mag') : null;
    const sv = D.siteValues(arr, v, mode);
    const seq = mode === 'rms';
    const marks = {}; if (S.enabled.has('bad') && S.ds.badSite >= 0) marks[S.ds.badSite] = D.theme().crit;
    D.topoCanvas($('cvCursorTopo'), D.sites(), sv, { unit, maxH: 270, sequential: seq, range: seq ? [0, Math.max(...sv) || 1] : undefined, fmt: x => ui.fmtV(x, unit, 0).replace(/ \S+$/, ''), marks, floor0: seq });
  }

  function render() {
    if (!S.ds) return;
    const arr = S.ds.array;
    $('recKind').hidden = arr.type !== 'planar';
    const cur = $('recChans').value;
    const opts = [{ value: 'sample', label: 'A third, across the head' }, { value: 'all', label: 'All' }];
    REGION_ORDER.forEach(l => ['L', 'R'].forEach(sd => opts.push({ value: `${sd}:${l}`, label: `${MEG.SIDE_NAMES[sd]} ${MEG.REGION_NAMES[l]}` })));
    ui.fill($('recChans'), opts, cur || 'sample');
    const sc = $('recScale').value;
    const kind = arr.type === 'planar' ? $('recKind').value : arr.type, unit = ui.unitOf(kind);
    ui.fill($('recScale'), [{ value: '0', label: 'Auto scale' }].concat(SCALES.map(v => ({ value: String(v), label: ui.fmtV(v, unit, 0) }))), st.scaleKey === unit ? sc : '0');
    st.scaleKey = unit;
    ui.layers($('layers'));
    const opts2 = [{ value: '', label: 'Highlight: none' }].concat(S.ds.groups.filter(g => S.enabled.has(g.id) && g.id !== 'movement' && g.id !== 'bad').map(g => ({ value: g.id, label: 'Highlight: ' + g.label })));
    const hc = $('recHighlight').value;
    ui.fill($('recHighlight'), opts2, opts2.some(o => o.value === hc) ? hc : '');
    drawTraces(); drawCursorTopo();
  }

  function play(ts) {
    if (!st.playing || S.tab !== 'recording') { st.playing = false; $('recPlay').textContent = 'Play'; return; }
    if (st.last) {
      const dt = Math.min(0.1, (ts - st.last) / 1000);
      st.t0 += dt;
      const win = parseFloat($('recWin').value);
      if (st.t0 > S.ds.dur - win) st.t0 = 0;
      S.cursorT = st.t0 + win * 0.98;
      drawTraces();
      if (!st.lastMap || ts - st.lastMap > 150) { drawCursorTopo(); st.lastMap = ts; }
    }
    st.last = ts;
    st.raf = requestAnimationFrame(play);
  }

  MEG.tabs.recording = {
    init() {
      ui.seg($('recView'), v => { st.view = v; drawTraces(); drawCursorTopo(); });
      ['recWin', 'recScale', 'recHighlight', 'recButterfly', 'recRefs', 'recChans'].forEach(id => $(id).addEventListener('change', () => { drawTraces(); }));
      $('recKind').addEventListener('change', () => { MEG.app.dirty('recording'); render(); });
      $('recTime').addEventListener('input', () => { st.t0 = parseFloat($('recTime').value); drawTraces(); });
      $('recPrev').addEventListener('click', () => { st.t0 -= parseFloat($('recWin').value); drawTraces(); });
      $('recNext').addEventListener('click', () => { st.t0 += parseFloat($('recWin').value); drawTraces(); });
      $('recPlay').addEventListener('click', () => {
        st.playing = !st.playing; $('recPlay').textContent = st.playing ? 'Pause' : 'Play';
        st.last = null; if (st.playing) st.raf = requestAnimationFrame(play);
      });
      const cv = $('cvTraces');
      cv.addEventListener('click', e => {
        const Lo = st.layout; if (!Lo) return;
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left;
        if (x < Lo.L || x > Lo.R) return;
        S.cursorT = st.t0 + (x - Lo.L) / (Lo.R - Lo.L) * Lo.win;
        drawTraces(); drawCursorTopo();
      });
      cv.addEventListener('mousemove', e => {
        const Lo = st.layout; if (!Lo) return;
        const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        if (x < Lo.L || x > Lo.R || y < Lo.Y0 || y > Lo.Y1) { D.tip(0, 0, null); return; }
        const t = st.t0 + (x - Lo.L) / (Lo.R - Lo.L) * Lo.win, i = Math.round(t * S.ds.fs);
        if (Lo.butterfly) { D.tip(e.clientX, e.clientY, ui.fmtT(t)); return; }
        const row = Math.floor((y - Lo.Y0) / Lo.rowH);
        if (row < Lo.idx.length) {
          const c = Lo.idx[row]; if (c === undefined) return;
          D.tip(e.clientX, e.clientY, `<div style="color:var(--muted)">${ui.fmtT(t)}</div>` + D.tipRow(null, S.ds.array.channels[c].name, ui.fmtV(Lo.src.rows[c][i], Lo.unit)));
        } else if (Lo.showRefs) {
          const k = row - Lo.idx.length; if (k < 0 || k >= S.rec.refs.length) return;
          D.tip(e.clientX, e.clientY, `<div style="color:var(--muted)">${ui.fmtT(t)}</div>` + D.tipRow(null, 'reference ' + S.rec.refLabels[k], MEG.fmtB(S.rec.refs[k][i])));
        }
      });
      cv.addEventListener('mouseleave', () => D.tip(0, 0, null));
    },
    onBuild(keep) { if (!keep) { st.t0 = 0; S.cursorT = 1; } },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
