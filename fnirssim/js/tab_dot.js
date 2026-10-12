/* fNIRS simulator: the Tomography tab.  A high-density array, its
   sensitivity matrix over a voxel grid, and a regularized reconstruction
   of one or two absorbers, against sparse topography. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { arr: 'hd', models: {}, preps: {} };
  let ctl = {};

  function model(cb) {
    if (st.models[st.arr]) return cb(st.models[st.arr]);
    NIRS.app.later(() => { st.models[st.arr] = NIRS.dotModel('adult', 850, st.arr); cb(st.models[st.arr]); });
  }
  function prep(M) {
    const k = st.arr + '|' + ctl.gamma.get().toFixed(2);
    if (!st.preps[k]) st.preps[k] = NIRS.dotPrepare(M, ctl.gamma.get());
    return st.preps[k];
  }
  function targets() {
    const t = [{ x: ctl.x.get(), y: ctl.y.get(), z: ctl.z.get(), r: ctl.r.get(), dmua: 0.02 }];
    if ($('dotTwo').checked) t.push({ x: ctl.x.get() + ctl.sep.get(), y: ctl.y.get(), z: ctl.z.get(), r: ctl.r.get(), dmua: 0.02 });
    return t;
  }

  function render() {
    model(M => {
      const T = D.theme(), tg = targets();
      const x = NIRS.dotTarget(M, tg);
      const y0 = NIRS.dotForward(M, x, 0);
      const ymax = Math.max(...y0.map(Math.abs)) || 1;
      const y = NIRS.dotForward(M, x, ymax * ctl.noise.get() / 100, 11);
      const P = prep(M);
      const xr = NIRS.dotSolve(M, P, y, Math.pow(10, ctl.lam.get()));
      draw(M, x, xr, tg);
    });
  }

  function slice(M, img, k, iy) {
    // returns rows (top first) of a horizontal slice at depth index k, or an x-z slice at row iy
    const n = M.nxy, rows = [];
    if (k !== null) { for (let j = n - 1; j >= 0; j--) rows.push(Float32Array.from({ length: n }, (_, i) => img[k * n * n + j * n + i])); }
    else { for (let kk = 0; kk < M.zs.length; kk++) rows.push(Float32Array.from({ length: n }, (_, i) => img[kk * n * n + iy * n + i])); }
    return rows;
  }
  function maxOf(rows) { let m = 0; rows.forEach(r => r.forEach(v => { m = Math.max(m, Math.abs(v)); })); return m || 1; }

  function draw(M, xt, xr, tg) {
    const T = D.theme(), n = M.nxy;
    const near = (arr, v) => { let b = 0; for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i] - v) < Math.abs(arr[b] - v)) b = i; return b; };
    const k0 = near(M.zs, tg[0].z), iy0 = near(M.xs, tg[0].y);
    const pkR = NIRS.dotPeak(M, xr);
    // array
    const g0 = D.fit($('cvDotArray'), w => Math.min(320, w));
    D.probeMap(g0.ctx, M.geo, { x: 4, y: 18, w: g0.w - 8, h: g0.h - 22 }, { regions: tg.map(t => ({ x: t.x, y: t.y, r: t.r, color: T.hbo })), labels: false, grid: true, channelWidth: 1 });
    g0.ctx.fillStyle = T.ink2; g0.ctx.font = D.font(10); g0.ctx.textAlign = 'left'; g0.ctx.textBaseline = 'top';
    g0.ctx.fillText(`${M.geo.sources.length} sources, ${M.geo.detectors.length} detectors, ${M.nc} channels; red: the target`, 6, 2);
    // top view: truth | image
    const g1 = D.fit($('cvDotTop'), w => Math.min(360, w / 2 + 40));
    const half = (g1.w - 12) / 2, side = Math.min(half, g1.h - 40);
    const heat = (ctx, rows, x0, y0, w, h, title, mark) => {
      const m = maxOf(rows);
      D.heat(ctx, x0, y0, w, h, rows, v => D.lutRGB(v / m, false), true);
      ctx.strokeStyle = T.axis; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
      ctx.fillStyle = T.ink2; ctx.font = D.font(10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(title, x0, y0 - 3);
      if (mark) mark(ctx);
    };
    const ext = M.xs[n - 1] + M.h / 2;
    const tx = (x0, w) => v => x0 + (v + ext) / (2 * ext) * w, ty = (y0, h) => v => y0 + (ext - v) / (2 * ext) * h;
    const cross = (ctx, X, Y, col) => { ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X - 6, Y); ctx.lineTo(X + 6, Y); ctx.moveTo(X, Y - 6); ctx.lineTo(X, Y + 6); ctx.stroke(); };
    heat(g1.ctx, slice(M, xt, k0, null), 4, 18, side, side, `truth at ${(M.zs[k0] * 10).toFixed(0)} mm`);
    heat(g1.ctx, slice(M, xr, k0, null), 8 + half, 18, side, side, 'image, same depth', ctx => {
      const X = tx(8 + half, side), Y = ty(18, side);
      tg.forEach(t => { ctx.strokeStyle = T.ink; ctx.setLineDash([3, 2]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(X(t.x), Y(t.y), t.r / (2 * ext) * side, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); });
      cross(ctx, X(pkR.x), Y(pkR.y), T.ink);
    });
    g1.ctx.fillStyle = T.muted; g1.ctx.font = D.font(10); g1.ctx.textAlign = 'left'; g1.ctx.textBaseline = 'top';
    g1.ctx.fillText(`${(2 * ext).toFixed(1)} cm square; dashed: true target; cross: image peak`, 4, 22 + side);
    // depth view: truth over image
    const zext = M.zs[M.zs.length - 1] + (M.zs[1] - M.zs[0]) / 2;
    const g2 = D.fit($('cvDotSide'), w => Math.min(420, 2 * (w - 8) * zext / (2 * ext) + 70));
    const wd = g2.w - 50, hd = wd * zext / (2 * ext);
    const lay = M.layers;
    const zmap = (y0) => z => y0 + z / zext * hd;
    const drawSide = (rows, y0, title, mark) => {
      heat(g2.ctx, rows, 46, y0, wd, hd, title, mark);
      const Z = zmap(y0);
      g2.ctx.strokeStyle = D.alpha(T.ink, 0.35); g2.ctx.setLineDash([2, 3]);
      lay.forEach(L => { if (isFinite(L.z1) && L.z1 < zext) { g2.ctx.beginPath(); g2.ctx.moveTo(46, Z(L.z1)); g2.ctx.lineTo(46 + wd, Z(L.z1)); g2.ctx.stroke(); } });
      g2.ctx.setLineDash([]);
      g2.ctx.fillStyle = T.muted; g2.ctx.font = D.font(9); g2.ctx.textAlign = 'right'; g2.ctx.textBaseline = 'middle';
      [0.5, 1, 1.5, 2, 2.5].forEach(z => { if (z < zext) g2.ctx.fillText((z * 10) + ' mm', 42, Z(z)); });
    };
    drawSide(slice(M, xt, null, iy0), 16, `truth, depth slice at y = ${M.xs[iy0].toFixed(1)} cm`);
    drawSide(slice(M, xr, null, iy0), 36 + hd, 'image', ctx => {
      const X = tx(46, wd), Z = zmap(36 + hd);
      tg.forEach(t => { ctx.strokeStyle = T.ink; ctx.setLineDash([3, 2]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(X(t.x), Z(t.z), t.r / (2 * ext) * wd, t.r / zext * hd, 0, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); });
      cross(ctx, X(pkR.x), Z(pkR.z), T.ink);
    });
    // numbers
    const err = Math.hypot(pkR.x - tg[0].x, pkR.y - tg[0].y, pkR.z - tg[0].z);
    const ptrue = Math.max(...xt);
    const seps = Array.from(new Set(M.geo.channels.map(c => c.rho.toFixed(1)))).sort((a, b) => a - b);
    let resolved = '–';
    if (tg.length === 2) {
      // is there a dip between the two targets along x at the depth of the image peak?
      const kk = near(M.zs, pkR.z), row = Array.from({ length: n }, (_, i) => xr[kk * n * n + iy0 * n + i]);
      const ia = near(M.xs, tg[0].x), ib = near(M.xs, tg[1].x), im = near(M.xs, (tg[0].x + tg[1].x) / 2);
      resolved = Math.min(row[ia], row[ib]) > 0 && row[im] < 0.85 * Math.min(row[ia], row[ib]) ? 'yes, a dip between them' : 'no, they merge';
    }
    ui.readouts($('dotReadouts'), [
      ['Channels', M.nc + ' at ' + seps.join(', ') + ' cm'], ['Voxels', M.nv.toLocaleString()],
      ['Image peak', `(${pkR.x.toFixed(1)}, ${pkR.y.toFixed(1)}) cm, ${(pkR.z * 10).toFixed(0)} mm deep`],
      ['Distance from the true centre', (err * 10).toFixed(0) + ' mm'], ['Peak recovered', (100 * pkR.v / ptrue).toFixed(0) + '% of the true change'],
      ['Two targets resolved', tg.length === 2 ? resolved : 'one target']
    ]);
    const txt = {
      hd: 'With overlapping channels at three separations, every voxel is seen by many bananas of different depths. The image finds the target sideways to within a few millimetres; depth is harder, because sensitivity falls so steeply with depth that a deep, strong absorber and a shallower, weaker one look alike. Depth compensation counteracts the pull toward the surface, and regularization trades noise for blur.',
      hdshort: 'Only the 1.5 cm nearest-neighbour channels: dense coverage but one depth. The image can say where across the head, but puts everything at the surface, where those channels are most sensitive.',
      sparse: 'A sparse 3 cm grid with no overlap: each channel is one blurry number. This is topography, a map at best. The image is a smear centred near the nearest channel, at no meaningful depth, and two targets closer than the channel spacing cannot be told apart.'
    }[st.arr];
    $('dotText').innerHTML = `<p class="cap">${txt} Absorption change 0.02 /cm at 850 nm in an adult head; noise is a percentage of the largest channel's change. λ is relative to the largest eigenvalue of the sensitivity matrix.</p>`;
  }

  NIRS.tabs.dot = {
    init() {
      ui.fill($('dotArray'), Object.keys(NIRS.DOT_ARRAYS).map(k => ({ value: k, label: NIRS.DOT_ARRAYS[k].label })), 'hd');
      $('dotArray').addEventListener('change', () => { st.arr = $('dotArray').value; render(); });
      const soon = ui.debounce(render, 60);
      ctl.x = ui.range('dotX', v => v.toFixed(1) + ' cm', soon);
      ctl.y = ui.range('dotY', v => v.toFixed(1) + ' cm', soon);
      ctl.z = ui.range('dotZ', v => (v * 10).toFixed(0) + ' mm', soon);
      ctl.r = ui.range('dotR', v => (v * 10).toFixed(0) + ' mm', soon);
      ctl.sep = ui.range('dotSep', v => (v * 10).toFixed(0) + ' mm', soon);
      ctl.noise = ui.range('dotNoise', v => v.toFixed(1) + '%', soon);
      ctl.lam = ui.range('dotLam', v => '10^' + v.toFixed(1), soon);
      ctl.gamma = ui.range('dotGamma', v => v.toFixed(2), ui.debounce(() => NIRS.app.later(render), 200));
      $('dotTwo').addEventListener('change', render);
    },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
