/* EEG simulator: drawing.
   Theme tokens read from CSS, colour maps interpolated in OKLab, a small
   line-plot class with a hover read-out, scalp maps by spherical-spline
   interpolation, head cross-sections and heat maps. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  const D = EEG.draw = {};

  /* ---------- theme ---------- */
  let THEME = null;
  D.theme = function () {
    if (THEME) return THEME;
    const cs = getComputedStyle(document.documentElement);
    const v = k => cs.getPropertyValue(k).trim();
    THEME = {
      page: v('--page'), surface: v('--surface'), card: v('--card'), ink: v('--ink'), ink2: v('--ink2'), muted: v('--muted'),
      grid: v('--grid'), axis: v('--axis'), accent: v('--accent'), trace: v('--trace'), band: v('--band'), closed: v('--closed'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v('--s' + i)),
      divNeg: v('--div-neg'), divMid: v('--div-mid'), divPos: v('--div-pos'),
      seq: [0, 1, 2, 3, 4, 5].map(i => v('--seq-' + i)),
      good: v('--good'), warn: v('--warn'), serious: v('--serious'), crit: v('--crit'),
      layers: { brain: v('--layer-brain'), csf: v('--layer-csf'), skull: v('--layer-skull'), scalp: v('--layer-scalp'), line: v('--layer-line') },
      dark: document.documentElement.getAttribute('data-theme') === 'dark' ||
        (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
    };
    THEME.divLUT = lut([THEME.divNeg, THEME.divMid, THEME.divPos]);
    THEME.seqLUT = lut(THEME.seq);
    return THEME;
  };
  D.resetTheme = () => { THEME = null; };

  /* ---------- colour ---------- */
  function hexRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const toSrgb = c => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(EEG.clamp(v, 0, 1) * 255); };
  function oklab(rgb) {
    const [r, g, b] = rgb.map(toLin);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function fromOklab([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)];
  }
  function lut(stops) {
    const labs = stops.map(s => oklab(hexRgb(s)));
    const out = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255 * (labs.length - 1), k = Math.min(labs.length - 2, Math.floor(t)), f = t - k;
      const c = fromOklab(labs[k].map((x, j) => x + (labs[k + 1][j] - x) * f));
      out.set(c, i * 3);
    }
    return out;
  }
  D.alpha = function (hex, a) { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`; };
  D.divColor = function (t) { const L = D.theme().divLUT, i = Math.round((EEG.clamp(t, -1, 1) + 1) * 127.5) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };
  D.seqColor = function (t) { const L = D.theme().seqLUT, i = Math.round(EEG.clamp(t, 0, 1) * 255) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };

  /* ---------- canvas sizing ---------- */
  D.fit = function (cv, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(60, cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 300);
    if (h === undefined) h = cv._h || 200;
    if (typeof h === 'function') h = h(w);
    h = Math.round(h);
    cv._h = h;
    cv.style.height = h + 'px';
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  };
  D.font = (px, weight) => `${weight || 400} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  /* ---------- tooltip ---------- */
  let tipEl = null;
  D.tip = function (x, y, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; document.body.appendChild(tipEl); }
    if (html === null) { tipEl.style.display = 'none'; return; }
    tipEl.innerHTML = html;
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    tipEl.style.left = Math.max(4, left) + 'px';
    tipEl.style.top = Math.max(4, top) + 'px';
  };
  D.tipRow = (color, label, value) => `<div class="row">${color ? `<span class="sw" style="background:${color}"></span>` : ''}<span>${label}</span><b>${value}</b></div>`;

  /* ---------- ticks ---------- */
  function niceStep(range, count) {
    const raw = range / Math.max(1, count), p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  D.ticks = function (a, b, count) {
    if (!(b > a)) return [a];
    const s = niceStep(b - a, count || 5), out = [];
    for (let v = Math.ceil(a / s - 1e-9) * s; v <= b + s * 1e-9; v += s) out.push(Math.abs(v) < s * 1e-9 ? 0 : v);
    return out;
  };
  function logTicks(a, b) {
    const out = [];
    const d0 = Math.floor(Math.log10(a)), d1 = Math.ceil(Math.log10(b));
    const few = d1 - d0 <= 2;
    for (let d = d0; d <= d1; d++) [1, 2, 5].forEach(m => { const v = m * Math.pow(10, d); if (v >= a * 0.999 && v <= b * 1.001 && (m === 1 || few)) out.push(v); });
    return out;
  }
  D.fmtTick = function (v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1).replace(/\.0$/, '');
    if (a >= 0.01) return v.toFixed(2).replace(/0$/, '');
    return v.toExponential(0);
  };

  /* ---------- line plot ----------
     spec: { series: [{ x?, y, color, width, dash, label, alpha, fill }],
             x, xRange, yRange, xLog, yLog, xLabel, yLabel, bands, vlines,
             hlines, markers, invertY, xFmt, yFmt, tipFmt } */
  class Plot {
    constructor(cv, opts) {
      this.cv = cv; this.o = Object.assign({ height: 220, margin: [12, 14, 36, 50] }, opts || {});
      this.spec = null;
      cv.addEventListener('mousemove', e => this.hover(e));
      cv.addEventListener('mouseleave', () => { this.restore(); D.tip(0, 0, null); });
      cv.addEventListener('click', e => {
        if (!this.map || !this.o.onClick) return;
        const r = cv.getBoundingClientRect();
        this.o.onClick(this.map.invX(e.clientX - r.left), this.map.invY(e.clientY - r.top), e);
      });
    }
    draw(spec) {
      this.spec = spec;
      const T = D.theme();
      const { ctx, w, h } = D.fit(this.cv, spec.height || this.o.height);
      const [mt, mr, mb, ml] = spec.margin || this.o.margin;
      const X0 = ml, X1 = w - mr, Y0 = mt, Y1 = h - mb;
      const all = spec.series || [];
      let xr = spec.xRange, yr = spec.yRange;
      if (!xr) {
        let a = Infinity, b = -Infinity;
        all.forEach(s => { const xs = s.x || spec.x; if (!xs) return; for (let i = 0; i < xs.length; i++) { const v = xs[i]; if (isFinite(v) && (!spec.xLog || v > 0)) { if (v < a) a = v; if (v > b) b = v; } } });
        xr = [a, b];
      }
      if (!yr) {
        let a = Infinity, b = -Infinity;
        all.forEach(s => {
          const xs = s.x || spec.x;
          for (let i = 0; i < s.y.length; i++) {
            const v = s.y[i]; if (!isFinite(v) || (spec.yLog && v <= 0)) continue;
            if (xs && (xs[i] < xr[0] || xs[i] > xr[1])) continue;
            if (v < a) a = v; if (v > b) b = v;
          }
        });
        (spec.markers || []).forEach(m => { if (isFinite(m.y)) { a = Math.min(a, m.y); b = Math.max(b, m.y); } });
        if (!isFinite(a)) { a = 0; b = 1; }
        if (a === b) { a -= 1; b += 1; }
        if (spec.yLog) { yr = [a / 1.3, b * 1.3]; } else { const p = (b - a) * 0.06; yr = [a - p, b + p]; }
        if (spec.yZero && !spec.yLog) { yr[0] = Math.min(0, yr[0]); yr[1] = Math.max(0, yr[1]); }
      }
      const fx = spec.xLog ? v => (Math.log10(v) - Math.log10(xr[0])) / (Math.log10(xr[1]) - Math.log10(xr[0])) : v => (v - xr[0]) / (xr[1] - xr[0]);
      const fy = spec.yLog ? v => (Math.log10(v) - Math.log10(yr[0])) / (Math.log10(yr[1]) - Math.log10(yr[0])) : v => (v - yr[0]) / (yr[1] - yr[0]);
      const sx = v => X0 + fx(v) * (X1 - X0);
      const sy = spec.invertY ? v => Y0 + fy(v) * (Y1 - Y0) : v => Y1 - fy(v) * (Y1 - Y0);
      const invX = px => { const t = (px - X0) / (X1 - X0); return spec.xLog ? Math.pow(10, Math.log10(xr[0]) + t * (Math.log10(xr[1]) - Math.log10(xr[0]))) : xr[0] + t * (xr[1] - xr[0]); };
      const invY = py => { let t = (Y1 - py) / (Y1 - Y0); if (spec.invertY) t = 1 - t; return spec.yLog ? Math.pow(10, Math.log10(yr[0]) + t * (Math.log10(yr[1]) - Math.log10(yr[0]))) : yr[0] + t * (yr[1] - yr[0]); };
      this.map = { sx, sy, invX, invY, X0, X1, Y0, Y1, xr, yr };
      // grid and ticks
      ctx.font = D.font(11);
      ctx.lineWidth = 1;
      let xt = spec.xTicks || (spec.xLog ? logTicks(xr[0], xr[1]) : D.ticks(xr[0], xr[1], Math.max(3, Math.round((X1 - X0) / 80))));
      let yt = spec.yTicks || (spec.yLog ? logTicks(yr[0], yr[1]) : D.ticks(yr[0], yr[1], Math.max(3, Math.round((Y1 - Y0) / 45))));
      const thin = (ts, px, minGap) => { const k = Math.ceil(ts.length / Math.max(2, Math.floor(px / minGap))); return k > 1 ? ts.filter((_, i) => i % k === 0) : ts; };
      xt = thin(xt, X1 - X0, 46); yt = thin(yt, Y1 - Y0, 18);
      ctx.strokeStyle = T.grid; ctx.fillStyle = T.muted;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      xt.forEach(v => { const x = Math.round(sx(v)) + 0.5; if (x < X0 - 1 || x > X1 + 1) return; ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.fillText((spec.xFmt || D.fmtTick)(v), x, Y1 + 5); });
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      yt.forEach(v => { const y = Math.round(sy(v)) + 0.5; if (y < Y0 - 1 || y > Y1 + 1) return; ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke(); ctx.fillText((spec.yFmt || D.fmtTick)(v), X0 - 6, y); });
      ctx.strokeStyle = T.axis;
      ctx.beginPath(); ctx.moveTo(X0 + 0.5, Y0); ctx.lineTo(X0 + 0.5, Y1 + 0.5); ctx.lineTo(X1, Y1 + 0.5); ctx.stroke();
      if (!spec.yLog && yr[0] < 0 && yr[1] > 0) { ctx.strokeStyle = T.axis; const y = Math.round(sy(0)) + 0.5; ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke(); }
      ctx.fillStyle = T.ink2; ctx.font = D.font(11);
      if (spec.xLabel) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(spec.xLabel, (X0 + X1) / 2, h - 2); }
      if (spec.yLabel) { ctx.save(); ctx.translate(11, (Y0 + Y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spec.yLabel, 0, 0); ctx.restore(); }
      ctx.save();
      ctx.beginPath(); ctx.rect(X0, Y0 - 2, X1 - X0, Y1 - Y0 + 4); ctx.clip();
      (spec.bands || []).forEach(b => {
        const a = sx(Math.max(b.x0, xr[0])), c = sx(Math.min(b.x1, xr[1])); if (c <= a) return;
        ctx.fillStyle = b.fill || T.band; ctx.fillRect(a, Y0, c - a, Y1 - Y0);
        if (b.label) { ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(b.label, (a + c) / 2, Y0 + 2); }
      });
      (spec.hlines || []).forEach(l => { ctx.strokeStyle = l.color || T.muted; ctx.setLineDash(l.dash || [4, 4]); ctx.lineWidth = l.width || 1; const y = sy(l.y); ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke(); });
      ctx.setLineDash([]);
      all.forEach(s => {
        const xs = s.x || spec.x, ys = s.y, n = ys.length;
        if (s.fill !== undefined && s.y2) {
          ctx.fillStyle = s.fill; ctx.beginPath();
          for (let i = 0; i < n; i++) { const X = sx(xs[i]), Y = sy(ys[i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
          for (let i = n - 1; i >= 0; i--) ctx.lineTo(sx(xs[i]), sy(s.y2[i]));
          ctx.closePath(); ctx.fill();
          return;
        }
        ctx.strokeStyle = s.color || T.trace; ctx.lineWidth = s.width || 2; ctx.globalAlpha = s.alpha === undefined ? 1 : s.alpha;
        ctx.setLineDash(s.dash || []);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let pen = false;
        // decimate to pixel columns when there are many points
        const step = n > 4 * (X1 - X0) ? Math.floor(n / (2 * (X1 - X0))) : 1;
        for (let i = 0; i < n; i += step) {
          let y = ys[i];
          if (step > 1) { let lo = Infinity, hi = -Infinity; for (let k = i; k < Math.min(n, i + step); k++) { if (ys[k] < lo) lo = ys[k]; if (ys[k] > hi) hi = ys[k]; } const X = sx(xs[i]); if (isFinite(lo)) { if (!pen) { ctx.moveTo(X, sy(lo)); pen = true; } else ctx.lineTo(X, sy(lo)); ctx.lineTo(X, sy(hi)); } continue; }
          if (!isFinite(y) || (spec.yLog && y <= 0) || (spec.xLog && xs[i] <= 0)) { pen = false; continue; }
          const X = sx(xs[i]), Y = sy(y);
          if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
      });
      (spec.vlines || []).forEach(l => {
        if (l.x < xr[0] || l.x > xr[1]) return;
        ctx.strokeStyle = l.color || T.muted; ctx.setLineDash(l.dash || []); ctx.lineWidth = l.width || 1;
        const x = sx(l.x); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
        if (l.label) { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = x > X1 - 60 ? 'right' : 'left'; ctx.textBaseline = 'top'; ctx.fillText(l.label, x + (x > X1 - 60 ? -4 : 4), Y0 + 2); }
      });
      (spec.markers || []).forEach(m => {
        if (!isFinite(m.y)) return;
        const x = sx(m.x), y = sy(m.y);
        ctx.fillStyle = m.color || T.accent; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, m.r || 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        if (m.label) { ctx.fillStyle = T.ink; ctx.font = D.font(10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(m.label, x + 6, y - 3); }
      });
      ctx.restore();
      if (spec.title) { ctx.fillStyle = T.ink2; ctx.font = D.font(11, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(spec.title, X0 + 6, Y0 + 3); }
      if (spec.after) spec.after(ctx, this.map);
      this.snapshot();
    }
    snapshot() {
      if (!this.snap) this.snap = document.createElement('canvas');
      this.snap.width = this.cv.width; this.snap.height = this.cv.height;
      this.snap.getContext('2d').drawImage(this.cv, 0, 0);
    }
    restore() {
      if (!this.snap || !this.snap.width) return;
      const ctx = this.cv.getContext('2d');
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.cv.width, this.cv.height); ctx.drawImage(this.snap, 0, 0); ctx.restore();
    }
    hover(e) {
      const s = this.spec, m = this.map;
      if (!s || !m || this.o.noHover) return;
      const r = this.cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      this.restore();
      if (px < m.X0 || px > m.X1 || py < m.Y0 || py > m.Y1) { D.tip(0, 0, null); return; }
      const xv = m.invX(px), T = D.theme();
      const ctx = this.cv.getContext('2d');
      ctx.strokeStyle = T.muted; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px + 0.5, m.Y0); ctx.lineTo(px + 0.5, m.Y1); ctx.stroke(); ctx.setLineDash([]);
      const rows = [];
      (s.series || []).forEach(se => {
        if (!se.label || se.noTip) return;
        const xs = se.x || s.x; if (!xs || !xs.length) return;
        let lo = 0, hi = xs.length - 1;
        if (xs[hi] < xs[lo]) return;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < xv) lo = mid; else hi = mid; }
        const i = Math.abs(xs[lo] - xv) < Math.abs(xs[hi] - xv) ? lo : hi;
        const yv = se.y[i]; if (!isFinite(yv)) return;
        const X = m.sx(xs[i]), Y = m.sy(yv);
        if (Y >= m.Y0 && Y <= m.Y1) { ctx.fillStyle = se.color || T.trace; ctx.strokeStyle = T.surface; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); }
        rows.push(D.tipRow(se.color, se.label, (s.tipFmt || EEG.fmt)(yv, se)));
      });
      const head = s.tipX ? s.tipX(xv) : `${s.xLabel || 'x'}: ${EEG.fmt(xv, 2)}`;
      D.tip(e.clientX, e.clientY, `<div style="color:var(--muted);margin-bottom:2px">${head}</div>` + rows.join(''));
    }
  }
  D.Plot = Plot;

  /* ---------- scalp maps ---------- */
  const TOPO_CACHE = new Map();
  function topoInterp(labels, res) {
    const key = labels.join(',') + '|' + res;
    let c = TOPO_CACHE.get(key);
    if (!c) {
      const U = labels.map(l => EEG.ELEC[l]);
      const grid = EEG.topoGrid(res);
      const sp = EEG.makeSpline(U);
      c = { grid, W: sp.interpMatrix(grid.pts), n: U.length, xy: U.map(EEG.project) };
      if (TOPO_CACHE.size > 24) TOPO_CACHE.delete(TOPO_CACHE.keys().next().value);
      TOPO_CACHE.set(key, c);
    }
    return c;
  }
  D.topoInterp = topoInterp;

  /* Draw a map into ctx at (cx, cy) with radius r.
     opts: range (symmetric limit, or [lo, hi] when sequential), sequential,
     electrodes, names, contours, marks {label: colour}, unit, outline. */
  D.topo = function (ctx, cx, cy, r, labels, values, opts) {
    opts = opts || {};
    const T = D.theme();
    const res = opts.res || (r > 90 ? 96 : r > 45 ? 64 : 40);
    const c = topoInterp(labels, res);
    const n = c.n, grid = c.grid, W = c.W;
    const vals = new Float32Array(grid.idx.length);
    let lo = Infinity, hi = -Infinity;
    for (let p = 0; p < grid.idx.length; p++) {
      let s = 0; const o = p * n;
      for (let j = 0; j < n; j++) s += W[o + j] * values[j];
      vals[p] = s; if (s < lo) lo = s; if (s > hi) hi = s;
    }
    let range = opts.range;
    if (opts.sequential) { if (!range) range = [Math.min(lo, 0), hi || 1]; }
    else if (!range) range = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const off = D._off || (D._off = document.createElement('canvas'));
    off.width = res; off.height = res;
    const octx = off.getContext('2d');
    const img = octx.createImageData(res, res);
    const L = opts.sequential ? T.seqLUT : T.divLUT;
    const full = new Float32Array(res * res).fill(NaN);
    for (let p = 0; p < grid.idx.length; p++) {
      const v = vals[p];
      full[grid.idx[p]] = v;
      const t = opts.sequential ? (v - range[0]) / (range[1] - range[0]) : (v / range + 1) / 2;
      const k = Math.round(EEG.clamp(t, 0, 1) * 255) * 3, q = grid.idx[p] * 4;
      img.data[q] = L[k]; img.data[q + 1] = L[k + 1]; img.data[q + 2] = L[k + 2]; img.data[q + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, cx - r, cy - r, 2 * r, 2 * r);
    if (opts.contours !== false && r > 30) contours(ctx, full, res, cx, cy, r, opts.sequential ? null : range, T);
    ctx.restore();
    // head outline, nose and ears
    ctx.strokeStyle = T.ink2; ctx.lineWidth = r > 60 ? 1.5 : 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    const nw = r * 0.09;
    ctx.beginPath(); ctx.moveTo(cx - nw, cy - r * 0.995); ctx.lineTo(cx, cy - r * 1.09); ctx.lineTo(cx + nw, cy - r * 0.995); ctx.stroke();
    [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * r * 1.03, cy, r * 0.04, r * 0.14, 0, 0, 2 * Math.PI); ctx.stroke(); });
    if (opts.electrodes !== false) {
      const marks = opts.marks || {};
      labels.forEach((l, j) => {
        const [mx, my] = c.xy[j], x = cx + mx * r, y = cy - my * r;
        const mk = marks[l];
        ctx.fillStyle = mk || T.ink; ctx.beginPath(); ctx.arc(x, y, mk ? Math.max(3, r * 0.035) : Math.max(1.2, r * 0.016), 0, 2 * Math.PI); ctx.fill();
        if (mk) { ctx.strokeStyle = T.surface; ctx.lineWidth = 1.5; ctx.stroke(); }
        if (opts.names && r > 70) { ctx.fillStyle = T.ink; ctx.font = D.font(Math.max(8, Math.min(11, r * 0.055))); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(l, x, y - 3); }
      });
    }
    return { range, lo, hi, xy: c.xy.map(([mx, my]) => [cx + mx * r, cy - my * r]) };
  };

  // Marching squares at evenly spaced levels; zero drawn dashed.
  function contours(ctx, f, res, cx, cy, r, range, T) {
    if (!range) return;
    const step = D.ticks(-range, range, 6);
    const levels = step.filter(v => Math.abs(v) < range * 0.999);
    const px = i => cx - r + (i + 0.5) / res * 2 * r, py = j => cy - r + (j + 0.5) / res * 2 * r;
    ctx.lineWidth = 0.8;
    levels.forEach(lv => {
      ctx.strokeStyle = D.alpha(T.dark ? '#ffffff' : '#000000', lv === 0 ? 0.45 : 0.22);
      ctx.setLineDash(lv === 0 ? [3, 3] : []);
      ctx.beginPath();
      for (let j = 0; j < res - 1; j++) for (let i = 0; i < res - 1; i++) {
        const a = f[j * res + i], b = f[j * res + i + 1], c = f[(j + 1) * res + i + 1], d = f[(j + 1) * res + i];
        if (!(isFinite(a) && isFinite(b) && isFinite(c) && isFinite(d))) continue;
        const pts = [];
        const edge = (v1, v2, x1, y1, x2, y2) => { if ((v1 - lv) * (v2 - lv) < 0) { const t = (lv - v1) / (v2 - v1); pts.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]); } };
        edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(c, d, i + 1, j + 1, i, j + 1); edge(d, a, i, j + 1, i, j);
        for (let k = 0; k + 1 < pts.length; k += 2) { ctx.moveTo(px(pts[k][0]), py(pts[k][1])); ctx.lineTo(px(pts[k + 1][0]), py(pts[k + 1][1])); }
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  // Horizontal colour bar with end labels.
  D.colorbar = function (ctx, x, y, w, h, range, opts) {
    opts = opts || {};
    const T = D.theme();
    for (let i = 0; i < w; i++) {
      const t = i / (w - 1);
      ctx.fillStyle = opts.sequential ? D.seqColor(t) : D.divColor(2 * t - 1);
      ctx.fillRect(x + i, y, 1.5, h);
    }
    ctx.strokeStyle = T.border || T.axis; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textBaseline = 'top';
    const lo = opts.sequential ? range[0] : -range, hi = opts.sequential ? range[1] : range;
    const f = opts.fmt || (v => EEG.fmt(v, Math.abs(hi) < 10 ? 1 : 0));
    ctx.textAlign = 'left'; ctx.fillText(f(lo), x, y + h + 2);
    ctx.textAlign = 'right'; ctx.fillText(f(hi) + (opts.unit ? ' ' + opts.unit : ''), x + w, y + h + 2);
    if (!opts.sequential) { ctx.textAlign = 'center'; ctx.fillText('0', x + w / 2, y + h + 2); }
  };

  // A complete single map on its own canvas, with an optional colour bar and title.
  D.topoCanvas = function (cv, labels, values, opts) {
    opts = opts || {};
    const size = opts.size || ((w) => Math.min(w, opts.maxH || 340) + (opts.colorbar === false ? 0 : 30) + (opts.title ? 18 : 0));
    const { ctx, w, h } = D.fit(cv, size);
    const T = D.theme();
    const top = opts.title ? 18 : 0, bar = opts.colorbar === false ? 0 : 30;
    const r = Math.min(w, h - top - bar) / 2 * 0.86;
    const cx = w / 2, cy = top + (h - top - bar) / 2 + r * 0.04;
    if (opts.title) { ctx.fillStyle = T.ink2; ctx.font = D.font(12, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(opts.title, w / 2, 2); }
    const out = D.topo(ctx, cx, cy, r, labels, values, opts);
    if (bar) D.colorbar(ctx, w / 2 - Math.min(150, w * 0.35), h - 26, Math.min(300, w * 0.7), 9, out.range, { sequential: opts.sequential, unit: opts.unit, fmt: opts.fmt });
    out.cx = cx; out.cy = cy; out.r = r;
    return out;
  };

  // A plain cap drawing: outline, electrodes, names, marked electrodes.
  D.capMap = function (ctx, cx, cy, r, labels, opts) {
    opts = opts || {};
    const T = D.theme();
    ctx.fillStyle = T.surface; ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    const nw = r * 0.09;
    ctx.beginPath(); ctx.moveTo(cx - nw, cy - r * 0.995); ctx.lineTo(cx, cy - r * 1.09); ctx.lineTo(cx + nw, cy - r * 0.995); ctx.stroke();
    [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * r * 1.03, cy, r * 0.04, r * 0.14, 0, 0, 2 * Math.PI); ctx.stroke(); });
    const pts = [];
    const all = opts.extra ? labels.concat(opts.extra) : labels;
    all.forEach(l => {
      const [mx, my] = EEG.project(EEG.ELEC[l]);
      const x = cx + mx * r, y = cy - my * r;
      const mk = opts.marks && opts.marks[l];
      const sel = opts.selected === l;
      const extra = opts.extra && opts.extra.includes(l);
      const rad = mk || sel ? Math.max(4, r * 0.045) : Math.max(2.4, r * 0.026);
      ctx.fillStyle = mk || (extra ? T.muted : T.ink);
      ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill();
      if (sel) { ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, rad + 3, 0, 2 * Math.PI); ctx.stroke(); }
      if (opts.names !== false && r > 80) {
        ctx.fillStyle = extra ? T.muted : T.ink2; ctx.font = D.font(Math.max(8, Math.min(11, r * 0.05)), mk || sel ? 600 : 400);
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(l, x, y - rad - 1);
      }
      pts.push({ l, x, y });
    });
    return pts;
  };


  /* ---------- head cross-sections ----------
     view: 'top' (nose up), 'side' (left side, nose right) or 'back'
     (from behind, left on the left). Returns the mapping from head
     coordinates in cm to canvas pixels. */
  D.head = function (ctx, x, y, size, view, opts) {
    opts = opts || {};
    const T = D.theme(), H = EEG.HEAD;
    const s = size / 2 / (H.R * 1.12), cx = x + size / 2, cy = y + size / 2;
    const proj = view === 'top' ? p => [cx + p[0] * s, cy - p[1] * s] : view === 'side' ? p => [cx + p[1] * s, cy - p[2] * s] : p => [cx + p[0] * s, cy - p[2] * s];
    const depthOf = view === 'top' ? p => p[2] : view === 'side' ? p => -p[0] : p => -p[1];
    const cols = [T.layers.scalp, T.layers.skull, T.layers.csf, T.layers.brain];
    const radii = opts.homogeneous ? [H.R] : [H.R, H.radii[2], H.radii[1], H.radii[0]];
    radii.forEach((rr, i) => {
      ctx.fillStyle = opts.homogeneous ? T.layers.brain : cols[i]; ctx.strokeStyle = T.layers.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, rr * s, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    });
    ctx.strokeStyle = T.layers.line; ctx.lineWidth = 1.2;
    if (view === 'top') {
      const R = H.R * s;
      ctx.beginPath(); ctx.moveTo(cx - R * 0.12, cy - R * 0.99); ctx.lineTo(cx, cy - R * 1.1); ctx.lineTo(cx + R * 0.12, cy - R * 0.99); ctx.stroke();
      [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * R * 1.03, cy, R * 0.045, R * 0.15, 0, 0, 2 * Math.PI); ctx.stroke(); });
    } else if (view === 'side') {
      const R = H.R * s, a = 0.32;
      ctx.beginPath(); ctx.moveTo(cx + R * Math.cos(a), cy + R * Math.sin(a) * 0.2); ctx.lineTo(cx + R * 1.1, cy + R * 0.12); ctx.lineTo(cx + R * 0.97, cy + R * 0.25); ctx.stroke();
    }
    if (opts.labels) {
      ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(view === 'top' ? 'top' : view === 'side' ? 'left side' : 'from behind', cx, y + size - 1);
    }
    if (opts.electrodes) {
      opts.electrodes.forEach(l => {
        const u = EEG.ELEC[l], p = EEG.v3.scale(u, H.R);
        if (depthOf(p) < -0.5) return;
        const [px, py] = proj(p);
        const mk = opts.marks && opts.marks[l];
        ctx.fillStyle = mk || T.ink2; ctx.beginPath(); ctx.arc(px, py, mk ? 3 : 1.6, 0, 2 * Math.PI); ctx.fill();
      });
    }
    return { proj, depthOf, s, cx, cy };
  };

  // A dipole drawn as an arrow in a head view.  When it points at or away
  // from the viewer it is drawn as a dot or a cross in a circle.
  D.dipole = function (ctx, hv, pos, ori, color, opts) {
    opts = opts || {};
    const T = D.theme();
    const len = (opts.len || 2.2);
    const a = hv.proj(EEG.v3.sub(pos, EEG.v3.scale(ori, len / 2))), b = hv.proj(EEG.v3.add(pos, EEG.v3.scale(ori, len / 2)));
    const [px, py] = hv.proj(pos);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    ctx.lineWidth = opts.width || 2.5; ctx.strokeStyle = color; ctx.fillStyle = color;
    if (L < len * hv.s * 0.25) {
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.lineWidth = 1.8; ctx.stroke();
      const toward = hv.depthOf(ori) > 0;
      if (toward) { ctx.beginPath(); ctx.arc(px, py, 1.8, 0, 2 * Math.PI); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3); ctx.moveTo(px + 3, py - 3); ctx.lineTo(px - 3, py + 3); ctx.stroke(); }
    } else {
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const ux = dx / L, uy = dy / L, hl = Math.min(8, L * 0.45);
      ctx.beginPath(); ctx.moveTo(b[0] + ux * 2, b[1] + uy * 2); ctx.lineTo(b[0] - ux * hl - uy * hl * 0.6, b[1] - uy * hl + ux * hl * 0.6); ctx.lineTo(b[0] - ux * hl + uy * hl * 0.6, b[1] - uy * hl - ux * hl * 0.6); ctx.closePath(); ctx.fill();
    }
    if (opts.selected) { ctx.strokeStyle = T.ink; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(px, py, 11, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); }
    if (opts.label) { ctx.fillStyle = T.ink; ctx.font = D.font(10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(opts.label, px + 9, py - 9); }
    return [px, py];
  };

  /* ---------- heat map ----------
     m: array of rows (Float32Array), drawn into rect with colour f(v). */
  D.heat = function (ctx, x, y, w, h, m, colorOf, smooth) {
    const rows = m.length, cols = m[0].length;
    const off = D._heat || (D._heat = document.createElement('canvas'));
    off.width = cols; off.height = rows;
    const octx = off.getContext('2d'), img = octx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const rgb = colorOf(m[r][c]), q = (r * cols + c) * 4;
      img.data[q] = rgb[0]; img.data[q + 1] = rgb[1]; img.data[q + 2] = rgb[2]; img.data[q + 3] = rgb[3] === undefined ? 255 : rgb[3];
    }
    octx.putImageData(img, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = !!smooth; ctx.drawImage(off, x, y, w, h); ctx.restore();
  };
  D.lutRGB = function (t, sequential) {
    const L = sequential ? D.theme().seqLUT : D.theme().divLUT;
    const k = Math.round(EEG.clamp(sequential ? t : (t + 1) / 2, 0, 1) * 255) * 3;
    return [L[k], L[k + 1], L[k + 2]];
  };
})(typeof window !== 'undefined' ? window : globalThis);
