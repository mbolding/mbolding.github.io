/* fNIRS simulator: the Head and activation tab.  Move a cortical region
   under the probe, change the head, and see each channel's sensitivity to
   the region from the light model; then record with the changes. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { edit: null, sel: 0, map: null, drag: false, peakCache: {} };
  let ctl = {};

  function fromCfg() {
    const cfg = S.cfg;
    const regions = [];
    cfg.activations.forEach(a => regions.push({ kind: 'activation', ref: a, label: a.label, x: a.x, y: a.y, depth: a.depth, radius: a.radius, flow: a.flow }));
    cfg.pairs.forEach(p => p.regions.forEach((g, k) => regions.push({ kind: 'pair', ref: g, pair: p, label: `${p.label} ${g.name}`, x: g.x, y: g.y, depth: g.depth, radius: g.radius, flow: p.fluct })));
    st.edit = { head: cfg.head.model, hair: cfg.head.hair, regions, changed: false };
    st.sel = Math.min(st.sel, Math.max(0, regions.length - 1));
  }
  function layers() { return NIRS.headLayers(st.edit.head, { thick: st.edit.head === S.cfg.head.model ? S.cfg.head.thick : {} }); }
  function sol() { return NIRS.fluence(NIRS.opticalLayers(layers(), 850)); }
  function sens(region) {
    const geo = S.ds.geo, s0 = sol(), bt = NIRS.brainTop(layers());
    return geo.channels.map(c => {
      const s = geo.sources[c.src], d = geo.detectors[c.det];
      const L = NIRS.regionPath(s0, [s.x, s.y], [d.x, d.y], { x: region.x, y: region.y, z: region.depth, r: region.radius }, bt);
      const tot = NIRS.pathlengths(s0, c.rho).total;
      return { L, frac: L / tot, tot };
    });
  }
  function localPeak(flow) {
    const k = flow.toFixed(2);
    if (st.peakCache[k] === undefined) {
      const u = new Float64Array(400); for (let i = 20; i < 170; i++) u[i] = 1;
      const hb = NIRS.balloon(u, 0.1, flow);
      st.peakCache[k] = Math.max(...hb.hbo);
    }
    return st.peakCache[k];
  }

  function syncControls() {
    const r = st.edit.regions[st.sel];
    const has = !!r;
    ['hdX', 'hdY', 'hdDepth', 'hdRadius', 'hdFlow'].forEach(id => { $(id).disabled = !has; });
    if (!has) return;
    ctl.x.set(r.x); ctl.y.set(r.y); ctl.depth.set(r.depth); ctl.radius.set(r.radius); ctl.flow.set(r.flow);
    $('hdFlow').previousElementSibling.firstChild.textContent = r.kind === 'pair' ? 'Spontaneous flow fluctuation ' : 'Blood flow rise ';
  }

  function render() {
    if (!S.ds) return;
    if (!st.edit) fromCfg();
    const ds = S.ds, T = D.theme(), E = st.edit;
    const reg = E.regions[st.sel];
    const marks = E.regions.map((r, i) => ({ x: r.x, y: r.y, r: r.radius, color: r.kind === 'activation' ? T.hbo : T.series[6], label: i === st.sel ? r.label : '' }));
    const sv = reg ? sens(reg) : null;
    // head from above
    const g1 = D.fit($('cvHeadTop'), w => Math.min(300, w));
    const rr = Math.min(g1.w, g1.h) / 2 * 0.8;
    const cfgView = Object.assign({}, S.cfg, { head: Object.assign({}, S.cfg.head, { model: E.head }) });
    D.headTop(g1.ctx, g1.w / 2, g1.h / 2 + rr * 0.05, rr, cfgView, ds.geo, { regions: marks, selected: S.selCh });
    // probe with sensitivities
    const g2 = D.fit($('cvHeadProbe'), w => Math.min(300, w));
    const vals = sv ? sv.map((v, i) => (ds.chans[i].short ? NaN : v.L)) : null;
    let vmax = 0; if (vals) vals.forEach(v => { if (isFinite(v)) vmax = Math.max(vmax, v); });
    st.map = D.probeMap(g2.ctx, ds, { x: 4, y: 4, w: g2.w - 8, h: g2.h - 8 }, { regions: marks, values: vals, sequential: true, range: [0, vmax || 1], selected: S.selCh });
    ui.legend($('headLegend'), [{ color: D.seqColor(0.9), label: 'channel: more path inside the region' }, { color: D.seqColor(0.15), label: 'less' }, { color: T.hbo, label: 'activation', dash: true }].concat(E.regions.some(r => r.kind === 'pair') ? [{ color: T.series[6], label: 'connectivity region', dash: true }] : []));
    section(reg);
    // readouts
    const lay = layers(), bt = NIRS.brainTop(lay);
    const c = ds.chans[S.selCh];
    const dpf = c.per[ds.nL - 1].dpf;
    if (reg && sv) {
      const best = sv.map((v, i) => [v.L, i]).filter(([v, i]) => !ds.chans[i].short).sort((a, b) => b[0] - a[0])[0];
      const s = sv[S.selCh];
      const peak = reg.kind === 'activation' ? localPeak(reg.flow) : NaN;
      ui.readouts($('headReadouts'), [
        ['Brain begins at', (bt * 10).toFixed(1) + ' mm'], ['Region centre', (reg.depth * 10).toFixed(1) + ' mm deep'],
        [`${c.label}: path inside region`, (s.L * 10).toFixed(2) + ' mm'], [`${c.label}: share of its path`, (100 * s.frac).toFixed(2) + '%'],
        ['Most sensitive channel', ds.chans[best[1]].label],
        ['Local HbO peak (15 s block)', isFinite(peak) ? '+' + peak.toFixed(1) + ' µM' : '–'],
        [`${c.label}: expected Beer-Lambert peak`, isFinite(peak) ? '≈ +' + (peak * s.L / (c.rho * dpf)).toFixed(3) + ' µM' : '–', 'local peak × path inside the region / (d × DPF)']
      ]);
      bars(sv);
    } else {
      ui.readouts($('headReadouts'), [['Brain begins at', (bt * 10).toFixed(1) + ' mm'], ['Regions', 'none in this program']]);
      D.fit($('cvHeadSens'), 40);
    }
    $('btnHeadApply').disabled = !E.changed;
    $('headNote').textContent = E.changed ? 'Changed: press Apply to record with these settings (the program is rewritten to match).' : '';
  }

  function section(reg) {
    const ds = S.ds, T = D.theme(), c = ds.chans[S.selCh];
    const s = ds.geo.sources[c.src], d = ds.geo.detectors[c.det];
    const lay = layers(), s0 = sol();
    const ux = (d.x - s.x) / c.rho, uy = (d.y - s.y) / c.rho;
    const xr = [-1.5, c.rho + 1.5], zmax = 3;
    const cv = $('cvHeadSection');
    const wpx = cv.clientWidth || 500;
    const h = Math.max(170, Math.min(330, (wpx - 60) / (xr[1] - xr[0]) * zmax + 42));
    const g = D.fit(cv, h);
    const rect = { x: 50, y: 36, w: g.w - 60, h: g.h - 40 };
    const map = D.crossSection(g.ctx, rect, lay, xr, zmax, { labelSide: 'right' });
    const f = NIRS.sensitivityPlane(s0, c.rho, xr[0] - c.rho / 2, xr[1] - c.rho / 2, 160, zmax, 60);
    D.fieldImage(g.ctx, rect, f.data, 160, 60, T.photon, { decades: 3, maxAlpha: 170 });
    if (reg) {
      // project the region onto the plane of the channel
      const px = (reg.x - s.x) * ux + (reg.y - s.y) * uy, perp = Math.abs(-(reg.x - s.x) * uy + (reg.y - s.y) * ux);
      const re = perp < reg.radius ? Math.sqrt(reg.radius * reg.radius - perp * perp) : 0;
      const ctx = g.ctx;
      ctx.save(); ctx.beginPath(); ctx.rect(rect.x, map.sz(NIRS.brainTop(lay)), rect.w, rect.h); ctx.clip();
      if (re > 0) {
        ctx.fillStyle = D.alpha(reg.kind === 'activation' ? T.hbo : T.series[6], 0.35); ctx.strokeStyle = reg.kind === 'activation' ? T.hbo : T.series[6]; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.ellipse(map.sx(px), map.sz(reg.depth), Math.abs(map.sx(re) - map.sx(0)), Math.abs(map.sz(re) - map.sz(0)), 0, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      $('headSecHint').textContent = re > 0 ? `through ${c.label}'s banana, cutting the ${reg.label} region` : `through ${c.label}'s banana; the ${reg.label} region lies ${(perp * 10).toFixed(0)} mm off this plane`;
    } else $('headSecHint').textContent = `through ${c.label}'s banana`;
    D.optodeMarks(g.ctx, map, 0, c.rho, { srcLabel: c.s, detLabel: c.d });
  }

  function bars(sv) {
    const ds = S.ds, T = D.theme();
    const idx = ds.chans.filter(c => !c.short).map(c => c.index);
    const g = D.fit($('cvHeadSens'), 26 + idx.length * 18);
    const ctx = g.ctx, L0 = 64, R0 = g.w - 120;
    const max = Math.max(...idx.map(i => sv[i].L), 1e-6);
    idx.forEach((i, k) => {
      const y = 6 + k * 18, v = sv[i];
      ctx.fillStyle = i === S.selCh ? T.ink : T.ink2; ctx.font = D.font(10, i === S.selCh ? 700 : 400); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(ds.chans[i].label, L0 - 6, y + 6);
      ctx.fillStyle = T.hbo; ctx.fillRect(L0, y, Math.max(1, v.L / max * (R0 - L0)), 12);
      ctx.fillStyle = T.ink2; ctx.textAlign = 'left'; ctx.font = D.font(10);
      ctx.fillText(`${(v.L * 10).toFixed(2)} mm · ${(100 * v.frac).toFixed(2)}%`, L0 + Math.max(1, v.L / max * (R0 - L0)) + 5, y + 6);
    });
  }

  function edited(fn) {
    const r = st.edit.regions[st.sel];
    if (r) fn(r);
    st.edit.changed = true;
    render();
  }

  function apply() {
    const cfg = S.cfg, E = st.edit;
    cfg.head.model = E.head; cfg.head.hair = E.hair;
    if (E.head !== S.ds.cfg.head.model) cfg.head.thick = {};
    E.regions.forEach(r => {
      const g = r.ref;
      if (Math.abs(g.x - r.x) > 1e-9 || Math.abs(g.y - r.y) > 1e-9) g.under = null;
      g.x = r.x; g.y = r.y; g.depth = r.depth; g.radius = r.radius;
      if (r.kind === 'activation') g.flow = r.flow; else r.pair.fluct = r.flow;
    });
    st.edit = null;
    NIRS.app.rebuildFromCfg(true);
  }

  NIRS.tabs.head = {
    init() {
      ctl.x = ui.range('hdX', v => v.toFixed(1) + ' cm', v => edited(r => { r.x = v; }));
      ctl.y = ui.range('hdY', v => v.toFixed(1) + ' cm', v => edited(r => { r.y = v; }));
      ctl.depth = ui.range('hdDepth', v => (v * 10).toFixed(1) + ' mm', v => edited(r => { r.depth = v; }));
      ctl.radius = ui.range('hdRadius', v => (v * 10).toFixed(1) + ' mm', v => edited(r => { r.radius = v; }));
      ctl.flow = ui.range('hdFlow', v => Math.round(v * 100) + '%', v => edited(r => { r.flow = v; }));
      $('hdHead').addEventListener('change', () => { st.edit.head = $('hdHead').value; st.edit.changed = true; render(); });
      $('hdHair').addEventListener('change', () => { st.edit.hair = $('hdHair').value; st.edit.changed = true; render(); });
      $('hdRegion').addEventListener('change', () => { st.sel = +$('hdRegion').value; syncControls(); render(); });
      $('btnHeadApply').addEventListener('click', apply);
      $('btnHeadRevert').addEventListener('click', () => { fromCfg(); NIRS.tabs.head.onBuild(true); render(); });
      const cv = $('cvHeadProbe');
      const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      cv.addEventListener('pointerdown', e => {
        if (!st.map || !st.edit) return;
        const [px, py] = pos(e), [x, y] = st.map.fromPx(px, py);
        let hitR = -1;
        st.edit.regions.forEach((r, i) => { if (Math.hypot(x - r.x, y - r.y) < Math.max(r.radius, 0.6)) hitR = i; });
        if (hitR >= 0) { st.sel = hitR; $('hdRegion').value = String(hitR); syncControls(); st.drag = true; cv.setPointerCapture(e.pointerId); e.preventDefault(); return; }
        const ci = st.map.hit(px, py);
        if (ci >= 0) { S.selCh = ci; NIRS.app.markAll(); }
      });
      cv.addEventListener('pointermove', e => {
        if (!st.drag) return;
        const [px, py] = pos(e), [x, y] = st.map.fromPx(px, py);
        edited(r => { r.x = NIRS.clamp(Math.round(x * 10) / 10, -6, 6); r.y = NIRS.clamp(Math.round(y * 10) / 10, -4, 4); });
        ctl.x.set(st.edit.regions[st.sel].x); ctl.y.set(st.edit.regions[st.sel].y);
      });
      const end = () => { st.drag = false; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      cv.style.cursor = 'grab'; cv.style.touchAction = 'none';
    },
    onBuild(keepEdit) {
      if (!keepEdit) fromCfg();
      const E = st.edit;
      ui.fill($('hdRegion'), E.regions.length ? E.regions.map((r, i) => ({ value: String(i), label: r.label })) : [{ value: '0', label: 'no regions in this program' }], String(st.sel));
      $('hdHead').value = E.head; $('hdHair').value = E.hair;
      syncControls();
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
