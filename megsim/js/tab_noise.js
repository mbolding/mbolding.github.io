/* MEG simulator: the Noise & shielding tab.  Every step of noise rejection
   with a switch, a ladder of field strengths from the Earth's field to the
   sensor noise, a budget of what each signal contributes before and after
   the rejection, and one sensor's trace before and after. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, S = MEG.S, SUP = MEG.suppress;
  const $ = ui.$;
  const st = { t0: null, plots: {}, kind: null, segs: {} };

  /* ---------- controls ---------- */
  function syncControls() {
    const sh = S.shield, arr = S.ds.array;
    $('nzRoom').checked = sh.room;
    st.segs.sens.set(arr.type);
    $('nzSensNote').textContent = MEG.SENSOR_INFO[arr.type].desc;
    $('nzNullRow').hidden = arr.type !== 'opm';
    $('nzNulling').checked = sh.nulling;
    $('nzRefs').checked = sh.refs;
    const can = SUP.sssAvailable(arr);
    st.segs.sss.set(sh.sss);
    st.segs.sss.btns.forEach(b => { b.disabled = !can && b.dataset.v !== 'off'; });
    $('nzSSSRow').classList.toggle('off', !can);
    $('nzSSSNote').textContent = can ? 'Keep only the part of the field that comes from inside the helmet. Temporal SSS also removes sources just outside the brain, whose time courses leak into both parts.'
      : SUP.SSS_WHY[arr.type];
    $('nzComp').checked = !!sh.comp;
    $('nzComp').disabled = !can;
    $('nzSSP').value = String(sh.ssp || 0);
    $('nzSSPecg').checked = !!sh.sspEcg; $('nzSSPeog').checked = !!sh.sspEog;
    const sup = S.sup, notes = (sup && sup.notes) || [];
    const info = sup && sup.info;
    const parts = [];
    if (S.rec && S.rec.saturated) parts.push('Every OPM is saturated: without the shielded room the field at the head is tens of microtesla, a thousand times their range.');
    if (info) parts.push(`SSS: ${info.nin} inside and ${info.nout} outside terms (orders ${info.order.join(' and ')})${info.windows ? `; temporal SSS removed ${info.removed} time courses in ${info.windows} ten-second windows` : ''}.`);
    if (sup && sup.ssp && sup.ssp.length) parts.push(`SSP: ${sup.ssp.map(v => v.label.toLowerCase()).join(', ')}.`);
    $('nzStatus').textContent = parts.concat(notes).join(' ');
  }

  /* ---------- the budget ---------- */
  const SKIP = g => (g.id === 'movement' && S.ds.array.type !== 'opm') || (g.id === 'bad' && S.cfg.artifacts.bad.mode !== 'jumpy');
  async function computeBudget() {
    const ds = S.ds, arr = ds.array, fs = ds.fs, nch = arr.nch, nref = arr.refs.length, ntot = nch + nref;
    if (S.rec.saturated) return { saturated: true, version: S.version };
    const win = Math.min(10, ds.dur);
    if (st.t0 === null) { const b = ds.blocks.find(x => x.task) || ds.blocks[0]; st.t0 = Math.min(Math.max(0, b.t0 + 2), Math.max(0, ds.dur - win)); }
    const t0 = MEG.clamp(st.t0, 0, Math.max(0, ds.dur - win));
    const i0 = Math.round(t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(win * fs));
    const stride = Math.max(1, Math.floor((i1 - i0) / 2500));
    const sub = rows => rows.map(r => { const m = Math.floor(r.length / stride), o = new Float32Array(m); for (let i = 0; i < m; i++) o[i] = r[i * stride]; return o; });
    const opt = Object.assign(MEG.app.sumOpts(), { range: [i0, i1] });
    const A = S.cfg.artifacts, badChans = S.enabled.has('bad') && A.bad.mode === 'noisy' && ds.badSite >= 0 ? arr.siteChannels[ds.badSite] : [];
    const groups = ds.groups.filter(g => S.enabled.has(g.id) && !SKIP(g));
    const parts = [];
    for (const g of groups) {
      let rows;
      if (g.id === 'sensor') {
        rows = [];
        for (let c = 0; c < ntot; c++) { const u = MEG.sensorNoise(ds, c), gain = badChans.includes(c) ? 15 : 1; const o = new Float32Array(i1 - i0); for (let i = 0; i < o.length; i++) o[i] = gain * u[i0 + i]; rows.push(o); }
      } else if (g.id === 'jumps' || g.id === 'bad') {
        const zero = Array.from({ length: ntot }, () => new Float32Array(i1 - i0));
        const f = MEG.finish(ds, zero, { enabled: new Set([g.id]), range: [i0, i1], room: S.shield.room });
        rows = f.rows.concat(f.refs);
      } else rows = MEG.sumGroups(ds, new Set([g.id]), opt);
      rows = sub(rows);
      parts.push({ g, rows: rows.slice(0, nch), refs: rows.slice(nch) });
      await MEG.app.frame();
    }
    const sup = S.sup;
    const after = sup.steps.length ? SUP.decompose(ds, parts, { W: sup.W, sss: sup.sss ? { order: sup.sss.order, tsss: sup.sss.tsss, compensate: sup.sss.comp, moving: sup.sss.moving, t: (i0 + i1) / 2 / fs } : null, U: sup.U }) : parts.map(p => p.rows);
    const kinds = arr.type === 'planar' ? ['planar', 'mag'] : [arr.type];
    const idx = {}; kinds.forEach(k => { idx[k] = ui.chans(k); });
    const rmsOf = (rows, k) => {
      let s = 0, n = 0;
      idx[k].forEach(c => { const r = rows[c], m = MEG.mean(r); for (let i = 0; i < r.length; i++) { const d = r[i] - m; s += d * d; } n += r.length; });
      return Math.sqrt(s / Math.max(1, n));
    };
    const peakOf = (rows, k) => {
      let p = 0;
      idx[k].forEach(c => { const r = rows[c], m = MEG.mean(r); for (let i = 0; i < r.length; i++) { const d = Math.abs(r[i] - m); if (d > p) p = d; } });
      return p;
    };
    const L = parts[0] ? parts[0].rows[0].length : 0;
    const sumRows = list => Array.from({ length: nch }, (_, c) => { const o = new Float32Array(L); list.forEach(rows => { const r = rows[c]; for (let i = 0; i < L; i++) o[i] += r[i]; }); return o; });
    const totalB = sumRows(parts.map(p => p.rows)), totalA = sumRows(after);
    const res = { version: S.version, t0, win, kinds, parts: [], total: {} };
    parts.forEach((p, k) => {
      const e = { id: p.g.id, label: p.g.label, kind: p.g.kind, color: ui.groupColor(p.g.id), before: {}, after: {}, peakB: {}, peakA: {} };
      kinds.forEach(kk => { e.before[kk] = rmsOf(p.rows, kk); e.after[kk] = rmsOf(after[k], kk); e.peakB[kk] = peakOf(p.rows, kk); e.peakA[kk] = peakOf(after[k], kk); });
      res.parts.push(e);
    });
    kinds.forEach(kk => { res.total[kk] = { before: rmsOf(totalB, kk), after: rmsOf(totalA, kk), peakB: peakOf(totalB, kk), peakA: peakOf(totalA, kk) }; });
    return res;
  }
  let budgetPending = null;
  function budget() {
    if (S.budget && S.budget.version === S.version) return Promise.resolve(S.budget);
    if (budgetPending && budgetPending.version === S.version) return budgetPending.p;
    const version = S.version;
    const p = computeBudget().then(b => { if (b.version === S.version) S.budget = b; return b; });
    budgetPending = { version, p };
    return p;
  }

  function drawBudget(b) {
    const T = D.theme(), arr = S.ds.array;
    const cv = $('cvBudget');
    if (!b) { D.message(cv, 'Computing the noise budget…', 120); return; }
    if (b.saturated) { D.message(cv, 'Every OPM is saturated without the shielded room: there is no signal to budget.', 120); $('budgetLegend').innerHTML = ''; return; }
    const kind = st.kind && b.kinds.includes(st.kind) ? st.kind : b.kinds[0];
    const unit = ui.unitOf(kind);
    $('budgetHint').textContent = `RMS over the ${MEG.KIND_LABEL[kind]}, ${ui.fmtT(b.t0)} to ${ui.fmtT(b.t0 + b.win)}`;
    const order = { source: 0, background: 1, artifact: 2, sensor: 3 };
    const rows = b.parts.slice().sort((x, y) => order[x.kind] - order[y.kind] || (x.kind === 'artifact' ? y.before[kind] - x.before[kind] : 0));
    rows.unshift({ id: 'total', label: 'Everything together', color: T.ink, before: { [kind]: b.total[kind].before }, after: { [kind]: b.total[kind].after }, total: true });
    let lo = Infinity, hi = 0;
    rows.forEach(r => { [r.before[kind], r.after[kind]].forEach(v => { if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    lo = Math.pow(10, Math.floor(Math.log10(Math.max(lo, 1e-3)))); hi = Math.pow(10, Math.ceil(Math.log10(Math.max(hi, lo * 10))));
    const rh = 26, top = 26, left = 210, right = 120;
    const { ctx, w, h } = D.fit(cv, top + rh * rows.length + 34);
    const X0 = left, X1 = w - right;
    const sx = v => X0 + (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (X1 - X0);
    ctx.font = D.font(10); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (let e = Math.log10(lo); e <= Math.log10(hi) + 1e-9; e++) {
      const v = Math.pow(10, e), x = Math.round(sx(v)) + 0.5;
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, top - 6); ctx.lineTo(x, top + rh * rows.length); ctx.stroke();
      ctx.fillStyle = T.muted; ctx.fillText(ui.fmtV(v, unit, 0), x, top + rh * rows.length + 4);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = T.ink2; ctx.fillText('before', X1 + 8, 6); ctx.fillText('after', X1 + 64, 6);
    rows.forEach((r, i) => {
      const y = top + i * rh + rh / 2, b0 = r.before[kind], a0 = r.after[kind];
      if (i % 2 === 0) { ctx.fillStyle = T.band; ctx.fillRect(0, y - rh / 2, w, rh); }
      ctx.fillStyle = r.total ? T.ink : T.ink2; ctx.font = D.font(11, r.total ? 650 : 400); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(r.label, left - 14, y);
      ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(left - 6, y, 3.5, 0, 2 * Math.PI); ctx.fill();
      const xb = sx(b0), xa = sx(a0);
      ctx.strokeStyle = D.alpha(r.color, 0.5); ctx.lineWidth = 6; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(Math.max(xb, xa), y); ctx.stroke(); ctx.lineCap = 'butt';
      if (Math.abs(xb - xa) > 8) D.arrow(ctx, xb, y, xa + (xa < xb ? 4 : -4), y, r.color, 2, 7);
      ctx.fillStyle = T.card; ctx.strokeStyle = r.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(xb, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(xa, y, 4.5, 0, 2 * Math.PI); ctx.fill();
      ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.fillStyle = T.ink2;
      ctx.fillText(ui.fmtV(b0, unit), X1 + 8, y); ctx.fillStyle = a0 < 0.5 * b0 ? T.good || T.ink : a0 > 1.5 * b0 ? T.crit : T.ink2; ctx.fillText(ui.fmtV(a0, unit), X1 + 64, y);
    });
    const T2 = D.theme();
    ui.legend($('budgetLegend'), [{ color: T2.ink2, label: 'open circle: before noise rejection (what reaches the sensors)', dot: true }, { color: T2.ink, label: 'filled circle: after the steps chosen above', dot: true }]
      .concat(arr.type === 'planar' ? [] : []));
  }

  /* ---------- the ladder ---------- */
  const TYPICAL = [
    ['Earth’s static field', 5e10], ['Field changes in a city', 1e7, 1e9], ['A car passing 20 m away', 1.2e7], ['Mains wiring in a lab', 3e7, 3e8],
    ['The world, inside a shielded room', 1e4, 3e5], ['Heart, at the chest', 5e4, 1e5], ['Heart, at the head', 1e3, 5e3], ['Eye blink, front of the head', 1e3, 3e3],
    ['Alpha rhythm', 5e2, 2e3], ['Evoked field (M100)', 1e2, 5e2], ['Spontaneous brain activity', 1e2, 3e2], ['Brainstem responses', 5, 20],
    ['SQUID noise, 40 Hz band', 20], ['SQUID noise per √Hz', 3], ['OPM noise per √Hz', 15]
  ];
  function drawLadder(b) {
    const T = D.theme(), cv = $('cvLadder');
    const { ctx, w, h } = D.fit(cv, 600);
    const e0 = -0.3, e1 = 11, Y0 = 14, Y1 = h - 14;
    const sy = v => Y1 - (Math.log10(v) - e0) / (e1 - e0) * (Y1 - Y0);
    const ax = Math.round(w * 0.47) + 0.5;
    // decades and their names
    ctx.font = D.font(10); ctx.textBaseline = 'middle';
    const names = { 0: '1 fT', 3: '1 pT', 6: '1 nT', 9: '1 µT' };
    for (let e = 0; e <= 11; e++) {
      const y = Math.round(sy(Math.pow(10, e))) + 0.5;
      ctx.strokeStyle = names[e] !== undefined ? T.axis : T.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(w - 8, y); ctx.stroke();
      ctx.fillStyle = names[e] !== undefined ? T.ink2 : T.muted; ctx.textAlign = 'center';
      const lab = names[e] !== undefined ? names[e] : MEG.fmtB(Math.pow(10, e), 0);
      ctx.fillStyle = T.card; const tw = ctx.measureText(lab).width + 8; ctx.fillRect(ax - tw / 2, y - 7, tw, 14);
      ctx.fillStyle = names[e] !== undefined ? T.ink : T.muted; ctx.font = D.font(10, names[e] !== undefined ? 650 : 400); ctx.fillText(lab, ax, y); ctx.font = D.font(10);
    }
    // typical values on the left
    const items = TYPICAL.map(([label, a, bb]) => ({ label, a, b: bb || a, y: sy(Math.sqrt(a * (bb || a))) }));
    spread(items, 13, Y0, Y1);
    items.forEach(it => {
      const x = ax - 34;
      ctx.strokeStyle = D.alpha(T.muted, 0.8); ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, sy(it.a)); ctx.lineTo(x, sy(it.b) - (it.a === it.b ? 1 : 0)); ctx.stroke();
      ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(x - 4, sy(Math.sqrt(it.a * it.b))); ctx.lineTo(x - 12, it.ly); ctx.stroke();
      ctx.fillStyle = T.ink2; ctx.textAlign = 'right'; ctx.fillText(it.label, x - 14, it.ly);
    });
    ctx.fillStyle = T.muted; ctx.textAlign = 'right'; ctx.font = D.font(10, 600); ctx.fillText('typical', ax - 34, Y0 - 2);
    // this recording on the right
    ctx.textAlign = 'left'; ctx.fillText('this recording', ax + 34, Y0 - 2); ctx.font = D.font(10);
    if (!b || b.saturated) { ctx.fillStyle = T.muted; ctx.fillText(b ? 'all sensors saturated' : 'computing…', ax + 34, Y0 + 14); return; }
    const kind = b.kinds.includes('mag') ? 'mag' : b.kinds[0];
    const meas = b.parts.filter(p => p.peakB[kind] > 0).map(p => ({ label: p.label, color: p.color, a: p.peakA[kind], b0: p.peakB[kind] }));
    meas.push({ label: 'everything', color: T.ink, a: b.total[kind].peakA, b0: b.total[kind].peakB, bold: true });
    meas.forEach(m => { m.y = sy(Math.max(m.b0, 0.6)); });
    spread(meas, 13, Y0, Y1);
    meas.forEach((m, i) => {
      const x = ax + 26 + (i % 2) * 8;
      const yb = sy(Math.max(m.b0, 0.6)), ya = sy(Math.max(m.a, 0.6));
      ctx.strokeStyle = D.alpha(m.color, 0.6); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, yb); ctx.lineTo(x, ya); ctx.stroke();
      ctx.fillStyle = T.card; ctx.strokeStyle = m.color; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(x, yb, 3.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = m.color; ctx.beginPath(); ctx.arc(x, ya, 3.2, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = D.alpha(T.muted, 0.6); ctx.lineWidth = 0.7; ctx.beginPath(); ctx.moveTo(x + 5, yb); ctx.lineTo(ax + 50, m.ly); ctx.stroke();
      ctx.fillStyle = T.ink; ctx.font = D.font(10, m.bold ? 650 : 400); ctx.fillText(m.label, ax + 54, m.ly);
    });
  }
  // Nudge label positions apart, keeping order.
  function spread(items, gap, lo, hi) {
    items.sort((a, b) => b.y - a.y);
    items.forEach(it => { it.ly = it.y; });
    for (let pass = 0; pass < 60; pass++) {
      let moved = false;
      for (let i = 1; i < items.length; i++) {
        const d = items[i - 1].ly - items[i].ly;
        if (d < gap) { const m = (gap - d) / 2; items[i - 1].ly += m; items[i].ly -= m; moved = true; }
      }
      items.forEach(it => { it.ly = MEG.clamp(it.ly, lo + 8, hi - 4); });
      if (!moved) break;
    }
  }

  /* ---------- one sensor before and after ---------- */
  function drawTraces() {
    const T = D.theme(), ds = S.ds, fs = ds.fs, arr = ds.array;
    const k = parseInt($('nzCh').value, 10); if (!(k >= 0)) return;
    const t0 = parseFloat($('nzT').value), i0 = Math.round(t0 * fs), i1 = Math.min(ds.n, i0 + Math.round(10 * fs));
    $('nzTV').textContent = ui.fmtT(t0);
    const tt = Float64Array.from({ length: i1 - i0 }, (_, i) => (i0 + i) / fs);
    const unit = arr.channels[k].unit;
    const before = S.rec.rows[k].subarray(i0, i1), after = S.sup.rows[k].subarray(i0, i1);
    const mean = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
    const mb = mean(before), ma = mean(after);
    const yb = Float32Array.from(before, x => x - mb), ya = Float32Array.from(after, x => x - ma);
    const ev = ds.events.filter(e => e.t >= t0 && e.t <= t0 + 10).map(e => ({ x: e.t, color: D.alpha(ui.condColor(e.ci), 0.5), dash: [2, 3] }));
    if (!st.plots.b) st.plots.b = new D.Plot($('cvNzBefore'), { height: 170 });
    if (!st.plots.a) st.plots.a = new D.Plot($('cvNzAfter'), { height: 170 });
    st.plots.b.draw({ x: tt, title: `${arr.channels[k].name} as recorded (mean removed): ${ui.fmtV(MEG.rms(yb), unit)} RMS`, series: [{ y: yb, color: T.muted, label: 'as recorded', width: 1 }], vlines: ev, yLabel: unit, tipX: x => ui.fmtT(x), tipFmt: v => ui.fmtV(v, unit) });
    st.plots.a.draw({ x: tt, title: `after noise rejection: ${ui.fmtV(MEG.rms(ya), unit)} RMS`, series: [{ y: ya, color: T.series[0], label: 'after rejection', width: 1 }], vlines: ev, xLabel: 'time (s)', yLabel: unit, tipX: x => ui.fmtT(x), tipFmt: v => ui.fmtV(v, unit) });
  }

  function render() {
    if (!S.ds) return;
    syncControls();
    ui.layers($('nzLayers'));
    const arr = S.ds.array;
    const cur = $('nzCh').value;
    const opts = arr.channels.map((c, i) => ({ value: String(i), label: c.name }));
    ui.fill($('nzCh'), opts, opts.some(o => o.value === cur) && st.arrType === arr.type ? cur : String(ui.bestChannel()));
    st.arrType = arr.type;
    $('nzT').max = Math.max(0, S.ds.dur - 10).toFixed(1);
    drawTraces();
    $('budgetKind').hidden = arr.type !== 'planar';
    if (S.budget && S.budget.version === S.version) { drawBudget(S.budget); drawLadder(S.budget); return; }
    drawBudget(null); drawLadder(null);
    const v = S.version;
    budget().then(b => { if (b.version === v && S.version === v && S.tab === 'noise') { drawBudget(b); drawLadder(b); } }).catch(e => console.error(e));
  }

  MEG.tabs.noise = {
    init() {
      $('nzRoom').addEventListener('change', () => MEG.app.setRoom($('nzRoom').checked));
      st.segs.sens = ui.seg($('nzSensors'), v => {
        const n = S.ds.n, rows = (v === 'planar' ? 3 : 1) * MEG.SITES.length + 9;
        if (n * rows > 1.4e7) {
          st.segs.sens.set(S.ds.array.type);
          $('nzSensNote').innerHTML = `<strong>This recording is too long for the ${v === 'planar' ? '315-channel array' : 'array'}:</strong> ${(n * rows / 1e6).toFixed(0)} million samples, and this page holds up to 14 million. Shorten the timeline or lower the rate on the Experiment tab, or load an example written for planar gradiometers.`;
          return;
        }
        MEG.app.setSensors(v);
      });
      $('nzNulling').addEventListener('change', () => MEG.app.setNulling($('nzNulling').checked));
      $('nzRefs').addEventListener('change', () => MEG.app.setShield({ refs: $('nzRefs').checked }));
      st.segs.sss = ui.seg($('nzSSS'), v => MEG.app.setShield({ sss: v }));
      $('nzComp').addEventListener('change', () => MEG.app.setShield({ comp: $('nzComp').checked }));
      $('nzSSP').addEventListener('change', () => MEG.app.setShield({ ssp: parseInt($('nzSSP').value, 10) }));
      $('nzSSPecg').addEventListener('change', () => MEG.app.setShield({ sspEcg: $('nzSSPecg').checked }));
      $('nzSSPeog').addEventListener('change', () => MEG.app.setShield({ sspEog: $('nzSSPeog').checked }));
      $('nzCh').addEventListener('change', drawTraces);
      $('nzT').addEventListener('input', ui.debounce(drawTraces, 60));
      $('cvBudget').insertAdjacentHTML('beforebegin', '<div class="btnrow" id="budgetKind" style="margin-bottom:6px" hidden><span class="lbl" style="margin:0">Measured on</span><div class="seg" id="budgetSeg"><button data-k="planar" aria-pressed="true">Planar gradiometers</button><button data-k="mag" aria-pressed="false">Magnetometers</button></div></div>');
      ui.seg($('budgetSeg'), v => { st.kind = v; if (S.budget) drawBudget(S.budget); });
    },
    onBuild(keep) { if (!keep) st.t0 = null; S.budget = null; $('nzT').value = 0; },
    onArray() { st.kind = null; },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
