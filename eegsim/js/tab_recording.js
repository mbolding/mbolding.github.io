/* EEG simulator: the Recording tab.  Scrolling multichannel traces, the
   scalp map at a cursor, and a switch for every signal in the recording. */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw, ui = EEG.ui;
  const $ = ui.$, S = EEG.S;
  const st = { view: 'raw', t0: 0, playing: false, raf: null, layout: null };

  function data() {
    if (st.view === 'raw') {
      const nCap = S.rec.nCap;
      return { labels: S.rec.labels.slice(0, nCap), rows: S.rec.rows.slice(0, nCap), unit: 'µV', positions: true, ref: S.cfg.recording.reference, title: `as recorded, against ${S.cfg.recording.reference}` };
    }
    return { labels: S.filt.labels, rows: S.clean, unit: S.filt.unit, positions: S.filt.positions, ref: null, title: `processed: ${S.proc.reref} reference` };
  }

  // The highlighted signal's own contribution over the window, in the displayed montage.
  function highlightRows(id, i0, i1) {
    const rec = EEG.assemble(S.ds, { enabled: new Set([id]), range: [i0, i1], quantize: false, filters: false });
    if (st.view === 'raw') return rec.rows.slice(0, rec.nCap);
    const f = EEG.dsp.rereference(rec, S.proc.reref, EEG.splineCache);
    if (S.filt.chain && !S.filt.chain.empty) f.rows.forEach(r => S.filt.chain.apply(r));
    return f.rows;
  }

  function drawTraces() {
    const T = D.theme(), ds = S.ds, fs = ds.fs, d = data();
    const win = parseFloat($('recWin').value), scale = parseFloat($('recScale').value) * (d.unit === 'µV' ? 1 : 0.02) * ($('recNeg').checked ? -1 : 1);
    st.t0 = EEG.clamp(st.t0, 0, Math.max(0, ds.dur - win));
    $('recTime').max = Math.max(0, ds.dur - win).toFixed(1);
    $('recTime').value = st.t0;
    const i0 = Math.round(st.t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(win * fs));
    const butterfly = $('recButterfly').checked;
    const nCh = d.labels.length;
    const rowH = butterfly ? 0 : EEG.clamp(Math.floor(560 / nCh), 11, 26);
    const plotH = butterfly ? 320 : rowH * nCh;
    const cv = $('cvTraces');
    const { ctx, w, h } = D.fit(cv, plotH + 44);
    const L = 58, R = w - 30, Y0 = 6, Y1 = Y0 + plotH;
    const sx = t => L + (t - st.t0) / win * (R - L);
    st.layout = { L, R, Y0, Y1, rowH, butterfly, i0, i1, win, nCh, d, scale };
    // eyes-closed blocks and the time grid
    ds.blocks.forEach(b => {
      if (b.state !== 'closed' || b.t1 < st.t0 || b.t0 > st.t0 + win) return;
      ctx.fillStyle = T.closed; ctx.fillRect(Math.max(L, sx(b.t0)), Y0, Math.min(R, sx(b.t1)) - Math.max(L, sx(b.t0)), plotH);
    });
    ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = win <= 5 ? 0.5 : win <= 10 ? 1 : win <= 20 ? 2 : 5;
    for (let t = Math.ceil(st.t0 / step) * step; t <= st.t0 + win + 1e-9; t += step) {
      const x = Math.round(sx(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke();
      ctx.fillText(t.toFixed(step < 1 ? 1 : 0) + ' s', x, Y1 + 22);
    }
    // events
    ds.events.forEach(ev => {
      if (ev.t < st.t0 || ev.t > st.t0 + win) return;
      const x = Math.round(sx(ev.t)) + 0.5, col = ui.condColor(ev.ci);
      ctx.strokeStyle = D.alpha(col, 0.5); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, Y1 + 2); ctx.lineTo(x - 4, Y1 + 10); ctx.lineTo(x + 4, Y1 + 10); ctx.closePath(); ctx.fill();
    });
    // highlighted signal
    const hid = $('recHighlight').value;
    const hrows = hid ? highlightRows(hid, i0, i1) : null;
    const hcol = hid ? ui.groupColor(hid) : null;
    const n = i1 - i0;
    const traceOf = (y, ym, color, width, offset) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
      const px = R - L, per = n / px;
      if (per > 2) {
        for (let c = 0; c < px; c++) {
          const a = Math.floor(c * per), b = Math.min(n, Math.floor((c + 1) * per));
          let lo = Infinity, hi = -Infinity;
          for (let i = a; i < b; i++) { const v = y[offset + i]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const x = L + c + 0.5;
          if (c === 0) ctx.moveTo(x, ym - lo / scale * rowHalf()); else ctx.lineTo(x, ym - lo / scale * rowHalf());
          ctx.lineTo(x, ym - hi / scale * rowHalf());
        }
      } else {
        for (let i = 0; i < n; i++) { const x = L + i / Math.max(1, n - 1) * (R - L), yy = ym - y[offset + i] / scale * rowHalf(); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); }
      }
      ctx.stroke();
    };
    const rowHalf = () => butterfly ? plotH / 2 / 4 : rowH;
    ctx.save(); ctx.beginPath(); ctx.rect(L, Y0, R - L, plotH); ctx.clip();
    d.rows.forEach((y, c) => {
      const ym = butterfly ? Y0 + plotH / 2 : Y0 + (c + 0.5) * rowH;
      traceOf(y, ym, butterfly ? D.alpha(T.trace, 0.45) : T.trace, 1, i0);
      if (hrows) traceOf(hrows[c], ym, hcol, 1.6, 0);
    });
    ctx.restore();
    // channel labels
    ctx.font = D.font(Math.min(11, Math.max(8, rowH - 2))); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    if (!butterfly) d.labels.forEach((l, c) => {
      const isRef = d.ref === l;
      ctx.fillStyle = isRef ? T.muted : T.ink2;
      if (rowH >= 11 || c % 2 === 0) ctx.fillText(isRef ? l + ' (ref)' : l, L - 6, Y0 + (c + 0.5) * rowH);
    });
    else { ctx.fillStyle = T.ink2; ctx.fillText('all', L - 6, Y0 + plotH / 2); }
    // scale bar
    const bar = butterfly ? plotH / 2 / 4 : rowH;
    ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(R + 12, Y1 - 4); ctx.lineTo(R + 12, Y1 - 4 - bar); ctx.stroke();
    ctx.save(); ctx.translate(R + 22, Y1 - 4 - bar / 2); ctx.rotate(-Math.PI / 2); ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'center';
    ctx.fillText(`${EEG.fmt(Math.abs(scale), Math.abs(scale) < 1 ? 2 : 0)} ${d.unit}${scale < 0 ? ', − up' : ''}`, 0, 0); ctx.restore();
    // cursor
    if (S.cursorT >= st.t0 && S.cursorT <= st.t0 + win) {
      const x = Math.round(sx(S.cursorT)) + 0.5;
      ctx.strokeStyle = T.accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke();
    }
    const legend = [{ color: T.closed.replace(/[\d.]+\)$/, '0.6)'), label: 'eyes closed' }];
    ds.conditions.forEach((c, i) => legend.push({ color: ui.condColor(i), label: c }));
    if (hid) legend.push({ color: hcol, label: (S.ds.groups.find(g => g.id === hid) || {}).label + ', its own contribution' });
    ui.legend($('recLegend'), legend);
    $('recLegend').insertAdjacentHTML('afterbegin', `<span><b>${d.title}</b></span>`);
  }

  function drawCursorTopo() {
    const d = data(), fs = S.ds.fs;
    const i = EEG.clamp(Math.round(S.cursorT * fs), 0, S.ds.n - 1);
    $('cursorTime').textContent = ui.fmtT(S.cursorT);
    const cv = $('cvCursorTopo');
    if (!d.positions) {
      const g = D.fit(cv, 80); g.ctx.fillStyle = D.theme().muted; g.ctx.font = D.font(12); g.ctx.textAlign = 'center';
      g.ctx.fillText('Maps need a referential montage,', g.w / 2, 30); g.ctx.fillText('not a bipolar one.', g.w / 2, 48);
      return;
    }
    const v = d.rows.map(r => r[i]);
    D.topoCanvas(cv, d.labels, v, { unit: d.unit, maxH: 270, names: false });
  }

  function layers() {
    const box = $('layers'), ds = S.ds;
    const A = S.cfg.artifacts, R = S.cfg.recording;
    const detail = g => {
      if (g.kind === 'source') { const s = S.cfg.sources.find(x => x.name === g.id); return { dipole: 'dipole', pair: 'coupled pair', alpha: 'occipital alpha', erp: 'evoked response', spike: 'interictal spikes' }[s.type]; }
      if (g.kind === 'background') return `${R.background} µV RMS of 1/f activity`;
      if (g.kind === 'sensor') return 'thermal noise, scales with impedance';
      const k = g.id;
      return {
        blinks: `${A.blinks.rate} per s, ${A.blinks.amp} µV`, saccades: `${A.saccades.rate} per s`, muscle: `bursts, ${A.muscle.rate} per s`,
        cardiac: `${Math.round(A.cardiac.rate * 60)} beats per min`, line: `${R.mains} Hz, ${A.line.amp / 1e3} mV common mode`,
        drift: `${A.drift.amp} µV`, pops: `${A.pops.rate} per s`, bad: `${A.bad.label} at ${A.bad.impedance} kΩ`
      }[k];
    };
    const sections = [['Brain', g => g.kind === 'source' || g.kind === 'background'], ['Artifacts', g => g.kind === 'artifact'], ['Recording', g => g.kind === 'sensor']];
    box.innerHTML = sections.map(([title, f]) => {
      const gs = ds.groups.filter(f);
      if (!gs.length) return '';
      return `<h4>${title}</h4>` + gs.map(g => {
        const info = g.kind === 'artifact' ? EEG.ARTIFACT_INFO[g.id].desc : '';
        return `<label class="layer" title="${info.replace(/"/g, '&quot;')}"><input type="checkbox" data-g="${g.id}" ${S.enabled.has(g.id) ? 'checked' : ''}>
          <span class="chip" style="background:${ui.groupColor(g.id)}"></span><span>${g.label}<small>${detail(g)}</small></span></label>`;
      }).join('');
    }).join('');
    const opts = [{ value: '', label: 'Highlight: none' }].concat(ds.groups.filter(g => S.enabled.has(g.id) && g.kind !== 'sensor').map(g => ({ value: g.id, label: 'Highlight: ' + g.label })));
    const cur = $('recHighlight').value;
    ui.fill($('recHighlight'), opts, opts.some(o => o.value === cur) ? cur : '');
  }

  function render() {
    if (!S.ds) return;
    layers(); drawTraces(); drawCursorTopo();
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
      if (!st.lastMap || ts - st.lastMap > 120) { drawCursorTopo(); st.lastMap = ts; }
    }
    st.last = ts;
    st.raf = requestAnimationFrame(play);
  }

  EEG.tabs.recording = {
    init() {
      ui.seg($('recView'), v => { st.view = v; render(); });
      ['recWin', 'recScale', 'recHighlight', 'recButterfly', 'recNeg'].forEach(id => $(id).addEventListener('change', drawTraces));
      $('recTime').addEventListener('input', () => { st.t0 = parseFloat($('recTime').value); drawTraces(); });
      $('recPrev').addEventListener('click', () => { st.t0 -= parseFloat($('recWin').value); drawTraces(); });
      $('recNext').addEventListener('click', () => { st.t0 += parseFloat($('recWin').value); drawTraces(); });
      $('recPlay').addEventListener('click', () => {
        st.playing = !st.playing; $('recPlay').textContent = st.playing ? 'Pause' : 'Play';
        st.last = null; if (st.playing) st.raf = requestAnimationFrame(play);
      });
      $('layers').addEventListener('change', e => {
        const id = e.target.dataset.g; if (!id) return;
        if (e.target.checked) S.enabled.add(id); else S.enabled.delete(id);
        if (S.ica.model) S.ica.changed = true;
        EEG.app.later(() => EEG.app.run('assemble'));
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
        if (Lo.butterfly) { D.tip(e.clientX, e.clientY, `${ui.fmtT(t)}`); return; }
        const c = Math.floor((y - Lo.Y0) / Lo.rowH);
        if (c < 0 || c >= Lo.nCh) return;
        const v = Lo.d.rows[c][i];
        D.tip(e.clientX, e.clientY, `<div style="color:var(--muted)">${ui.fmtT(t)}</div>` + D.tipRow(null, Lo.d.labels[c], `${EEG.fmt(v, 1)} ${Lo.d.unit}`));
      });
      cv.addEventListener('mouseleave', () => D.tip(0, 0, null));
    },
    onBuild(keep) { if (!keep) { st.t0 = 0; S.cursorT = 1; } },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
