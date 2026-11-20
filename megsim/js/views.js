/* MEG simulator: the two cross-sections through a dipole.

   The electric view lies in the plane that contains the dipole and the
   radius through it: colour is the potential, lines are the volume
   currents.  The magnetic view lies in the plane across the current:
   colour is the strength of the field, lines follow its direction, and
   the helmet's coils (or OPMs) that sit near the plane are drawn where
   they are.  Both planes pass through the centre of the head, with the
   radius through the dipole pointing up. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, v3 = MEG.v3, F = MEG.fields;
  const V = MEG.views = {};

  function frame(cv, opts, L) {
    const { ctx, w, h } = D.fit(cv, opts.height || (w => Math.min(380, w * 0.85)));
    const sc = Math.min(w, h) / (2 * L), cx = w / 2, cy = h / 2;
    return { ctx, w, h, sc, cx, cy, X: a => cx + a * sc, Y: b => cy - b * sc };
  }
  function shells(ctx, f, T, homogeneous) {
    const radii = homogeneous ? [MEG.HEAD.R] : MEG.HEAD.radii;
    ctx.strokeStyle = D.alpha(T.ink2, 0.55); ctx.lineWidth = 1;
    radii.forEach(r => { ctx.beginPath(); ctx.arc(f.cx, f.cy, r * f.sc, 0, 2 * Math.PI); ctx.stroke(); });
  }
  function polyline(ctx, f, pts, arrowAt) {
    ctx.beginPath();
    pts.forEach(([a, b], i) => i ? ctx.lineTo(f.X(a), f.Y(b)) : ctx.moveTo(f.X(a), f.Y(b)));
    ctx.stroke();
    if (arrowAt && pts.length > 6) {
      const k = Math.floor(pts.length * arrowAt), p = pts[k], q = pts[Math.min(pts.length - 1, k + 2)];
      const x0 = f.X(p[0]), y0 = f.Y(p[1]), x1 = f.X(q[0]), y1 = f.Y(q[1]);
      const L = Math.hypot(x1 - x0, y1 - y0); if (L < 0.5) return;
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L, s = 4.5;
      ctx.beginPath(); ctx.moveTo(x1 + ux * s, y1 + uy * s); ctx.lineTo(x1 - uy * s * 0.8, y1 + ux * s * 0.8); ctx.lineTo(x1 + uy * s * 0.8, y1 - ux * s * 0.8); ctx.closePath(); ctx.fill();
    }
  }
  const modelCache = new Map();
  function interior(sigma, homogeneous) {
    const key = homogeneous ? 'h' : sigma.map(x => x.toPrecision(4)).join(',');
    if (!modelCache.has(key)) modelCache.set(key, F.interiorModel(homogeneous ? { homogeneous: true } : { sigma }));
    return modelCache.get(key);
  }

  /* opts: { r0, q, sigma, homogeneous, dirHint, lines, height, label } */
  V.electricPlane = function (cv, opts) {
    const T = D.theme(), L = 10.2;
    const f = frame(cv, opts, L), ctx = f.ctx;
    const m = interior(opts.sigma || MEG.HEAD.sigma, opts.homogeneous);
    const pl = F.planes(opts.r0, opts.q, opts.dirHint).electric, e1 = pl.e1, e2 = pl.e2;
    const toWorld = (a, b) => v3.add(v3.scale(e1, a), v3.scale(e2, b));
    // reference: the largest potential on the scalp in this plane
    let vref = 0;
    for (let k = 0; k < 180; k++) { const t = k / 180 * 2 * Math.PI; const v = F.potential(m, opts.r0, opts.q, toWorld(9.15 * Math.cos(t), 9.15 * Math.sin(t))); if (isFinite(v)) vref = Math.max(vref, Math.abs(v)); }
    vref = vref || 1;
    const res = 120, off = document.createElement('canvas');
    off.width = res; off.height = res;
    const octx = off.getContext('2d'), img = octx.createImageData(res, res), LUT = T.divLUT;
    const v0 = vref / 4, vmax = vref * 30, den = Math.log10(1 + vmax / v0);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const a = -L + (i + 0.5) / res * 2 * L, b = L - (j + 0.5) / res * 2 * L;
      if (a * a + b * b > MEG.HEAD.R * MEG.HEAD.R) continue;
      const v = F.potential(m, opts.r0, opts.q, toWorld(a, b));
      if (!isFinite(v)) continue;
      const t = Math.sign(v) * Math.min(1, Math.log10(1 + Math.abs(v) / v0) / den);
      const k = Math.round((t + 1) * 127.5) * 3, p = (j * res + i) * 4;
      img.data[p] = LUT[k]; img.data[p + 1] = LUT[k + 1]; img.data[p + 2] = LUT[k + 2]; img.data[p + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.arc(f.cx, f.cy, MEG.HEAD.R * f.sc, 0, 2 * Math.PI); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.drawImage(off, f.cx - L * f.sc, f.cy - L * f.sc, 2 * L * f.sc, 2 * L * f.sc);
    ctx.restore();
    shells(ctx, f, T, opts.homogeneous);
    // volume currents
    const lines = F.currentLines(m, opts.r0, opts.q, pl, { lines: opts.lines || 16 });
    ctx.strokeStyle = D.alpha(T.dark ? '#ffffff' : '#222222', 0.55); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1;
    lines.forEach(pts => polyline(ctx, f, pts, 0.5));
    // the dipole
    const ca = v3.dot(opts.r0, e1), cb = v3.dot(opts.r0, e2), qa = v3.dot(opts.q, e1), qb = v3.dot(opts.q, e2), qn = Math.hypot(qa, qb) || 1;
    const len = 1.4;
    D.arrow(ctx, f.X(ca - qa / qn * len / 2), f.Y(cb - qb / qn * len / 2), f.X(ca + qa / qn * len / 2), f.Y(cb + qb / qn * len / 2), T.series[1], 3, 9);
    const lab = (t, x, y, o) => D.label(ctx, t, x, y, Object.assign({ size: 10, color: T.ink2 }, o || {}));
    lab('scalp', f.X(0), f.Y(MEG.HEAD.R) - 8, { align: 'center' });
    if (!opts.homogeneous) { lab('skull', f.X(-6.25), f.Y(6.25), { align: 'center', size: 9 }); }
    lab('outward', f.X(0), f.Y(L) + 8, { align: 'center', color: T.muted });
    if (opts.label) lab(opts.label, 8, f.h - 10, { color: T.muted });
    return { vref };
  };

  // Where a ray from the head's centre leaves the helmet ellipsoid.
  function helmetRay(d) {
    const H = MEG.ARRAY.helmet, a = H.axes, c = H.centre;
    let A = 0, B = 0, C = -1;
    for (let i = 0; i < 3; i++) { A += d[i] * d[i] / (a[i] * a[i]); B += -2 * d[i] * c[i] / (a[i] * a[i]); C += c[i] * c[i] / (a[i] * a[i]); }
    return (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A);
  }
  /* opts: { r0, q, dirHint, primary, lines, helmet, opm, height } */
  V.magneticPlane = function (cv, opts) {
    const T = D.theme(), L = 14.2;
    const f = frame(cv, opts, L), ctx = f.ctx;
    const pl = F.planes(opts.r0, opts.q, opts.dirHint).magnetic, e1 = pl.e1, e2 = pl.e2;
    const toWorld = (a, b) => v3.add(v3.scale(e1, a), v3.scale(e2, b));
    let grid;
    if (opts.primary) grid = { L, fieldAt: (a, b) => MEG.biotSavart(toWorld(a, b), opts.r0, opts.q) };
    else grid = F.magneticGrid(F.makeMagnetic(opts.r0, opts.q), pl, L, 56);
    const res = 140, vals = new Float32Array(res * res);
    let all = [];
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const a = -L + (i + 0.5) / res * 2 * L, b = L - (j + 0.5) / res * 2 * L;
      const B = grid.fieldAt(a, b), m = B ? v3.norm(B) : 0;
      vals[j * res + i] = m;
      if (m > 0 && (i + j) % 3 === 0) all.push(m);
    }
    all.sort((x, y) => x - y);
    const hi = Math.max(10, all[Math.floor(all.length * 0.97)] || 10), lo = Math.max(0.3, Math.min(hi / 30, all[Math.floor(all.length * 0.03)] || 1));
    const off = document.createElement('canvas'); off.width = res; off.height = res;
    const octx = off.getContext('2d'), img = octx.createImageData(res, res), LUT = T.seqLUT;
    for (let p = 0; p < res * res; p++) {
      const m = vals[p]; if (!(m > 0)) continue;
      const t = MEG.clamp((Math.log10(m) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1);
      const k = Math.round(t * 255) * 3;
      img.data[4 * p] = LUT[k]; img.data[4 * p + 1] = LUT[k + 1]; img.data[4 * p + 2] = LUT[k + 2]; img.data[4 * p + 3] = Math.round(255 * Math.min(1, 0.25 + t));
    }
    octx.putImageData(img, 0, 0);
    ctx.save(); ctx.beginPath(); ctx.arc(f.cx, f.cy, L * f.sc, 0, 2 * Math.PI); ctx.clip();
    ctx.imageSmoothingEnabled = true; ctx.drawImage(off, f.cx - L * f.sc, f.cy - L * f.sc, 2 * L * f.sc, 2 * L * f.sc);
    ctx.restore();
    shells(ctx, f, T, false);
    // helmet or OPMs near this plane
    if (opts.helmet !== false) {
      const near = u => Math.abs(v3.dot(u, pl.normal));
      if (opts.opm) {
        // the OPMs' surface: the scalp in this plane, plus their gap
        ctx.strokeStyle = D.alpha(T.coil, 0.5); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let k = 0; k <= 180; k++) { const t = k / 180 * 2 * Math.PI, p = MEG.opmPoint(v3.unit(toWorld(Math.cos(t), Math.sin(t)))); const x = f.X(v3.dot(p, e1)), y = f.Y(v3.dot(p, e2)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
        MEG.SITES.forEach(s => { const p = MEG.opmPoint(s.u); if (Math.abs(v3.dot(p, pl.normal)) > 1.2) return; ctx.fillStyle = T.coil; ctx.fillRect(f.X(v3.dot(p, e1)) - 3, f.Y(v3.dot(p, e2)) - 3, 6, 6); });
      } else {
        ctx.strokeStyle = D.alpha(T.cold, 0.55); ctx.lineWidth = 5; ctx.beginPath();
        let pen = false;
        for (let k = 0; k <= 240; k++) {
          const t = k / 240 * 2 * Math.PI, d = v3.unit(toWorld(Math.cos(t), Math.sin(t)));
          if (d[2] < -0.62 || (d[1] > 0.6 && d[2] < 0.2)) { pen = false; continue; }
          const s = helmetRay(d) + 0.6, x = f.X(v3.dot(d, e1) * s), y = f.Y(v3.dot(d, e2) * s);
          if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
        }
        ctx.stroke();
        MEG.SITES.forEach(s => { const p = MEG.helmetPoint(s.u).r; if (Math.abs(v3.dot(p, pl.normal)) > 1.2) return; ctx.fillStyle = T.coil; ctx.fillRect(f.X(v3.dot(p, e1)) - 3, f.Y(v3.dot(p, e2)) - 3, 6, 6); });
        void near;
      }
    }
    // field lines
    const dip = [v3.dot(opts.r0, e1), v3.dot(opts.r0, e2)];
    if (opts.lines !== false && v3.norm(v3.sub(opts.q, v3.scale(e2, v3.dot(opts.q, e2)))) > 1e-6 * (v3.norm(opts.q) || 1)) {
      const lines = F.magneticLines(grid, pl, dip, { lines: 20, below: true });
      ctx.strokeStyle = D.alpha(T.dark ? '#ffffff' : '#1a1a1a', 0.6); ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1;
      lines.forEach(pts => polyline(ctx, f, pts, 0.25));
    }
    // the dipole: its tangential part comes out of the page
    const x0 = f.X(dip[0]), y0 = f.Y(dip[1]);
    const qn = v3.dot(opts.q, pl.normal), qr = v3.dot(opts.q, e2), qq = v3.norm(opts.q) || 1;
    if (Math.abs(qr) > 0.05 * qq) D.arrow(ctx, x0, y0 + Math.sign(qr) * 9 * Math.abs(qr) / qq, x0, y0 - Math.sign(qr) * 14 * Math.abs(qr) / qq - Math.sign(qr) * 4, T.series[1], 2.5, 7);
    ctx.fillStyle = T.card; ctx.strokeStyle = T.series[1]; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.arc(x0, y0, 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    if (Math.abs(qn) > 0.05 * qq) {
      ctx.fillStyle = T.series[1];
      if (qn > 0) { ctx.beginPath(); ctx.arc(x0, y0, 2.2, 0, 2 * Math.PI); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(x0 - 3.5, y0 - 3.5); ctx.lineTo(x0 + 3.5, y0 + 3.5); ctx.moveTo(x0 + 3.5, y0 - 3.5); ctx.lineTo(x0 - 3.5, y0 + 3.5); ctx.stroke(); }
    }
    // colour scale
    const bw = Math.min(160, f.w * 0.4), bx = f.w - bw - 10, by = f.h - 22;
    for (let i = 0; i < bw; i++) { ctx.fillStyle = D.seqColor(i / (bw - 1)); ctx.fillRect(bx + i, by, 1.5, 8); }
    ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 7);
    D.label(ctx, MEG.fmtB(lo, 1), bx, by - 7, { size: 9, color: T.ink2 });
    D.label(ctx, MEG.fmtB(hi, 0), bx + bw, by - 7, { size: 9, color: T.ink2, align: 'right' });
    D.label(ctx, 'outward', f.X(0), f.Y(L) + 8, { align: 'center', size: 10, color: T.muted });
    return { lo, hi };
  };
})(typeof window !== 'undefined' ? window : globalThis);
