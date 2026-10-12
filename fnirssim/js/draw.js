/* fNIRS simulator: drawing.
   Theme tokens read from CSS, colour maps interpolated in OKLab, a small
   line-plot class with a hover read-out, heat maps, and the pictures this
   simulator keeps coming back to: the probe with its channels, the head
   seen from above with the probe on it, and a cross-section through the
   tissue layers. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;
  const D = NIRS.draw = {};

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
      layers: { scalp: v('--layer-scalp'), skull: v('--layer-skull'), csf: v('--layer-csf'), gray: v('--layer-gray'), white: v('--layer-white'), line: v('--layer-line') },
      hbo: v('--hbo'), hbr: v('--hbr'), hbt: v('--hbt'), water: v('--water'), lam: [v('--l1'), v('--l2'), v('--l3')],
      src: v('--src'), det: v('--det'), photon: v('--photon'), bold: v('--bold'), border: v('--border-strong'),
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
  const toSrgb = c => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(NIRS.clamp(v, 0, 1) * 255); };
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
  D.divColor = function (t) { const L = D.theme().divLUT, i = Math.round((NIRS.clamp(t, -1, 1) + 1) * 127.5) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };
  D.seqColor = function (t) { const L = D.theme().seqLUT, i = Math.round(NIRS.clamp(t, 0, 1) * 255) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };

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
        rows.push(D.tipRow(se.color, se.label, (s.tipFmt || NIRS.fmt)(yv, se)));
      });
      const head = s.tipX ? s.tipX(xv) : `${s.xLabel || 'x'}: ${NIRS.fmt(xv, 2)}`;
      D.tip(e.clientX, e.clientY, `<div style="color:var(--muted);margin-bottom:2px">${head}</div>` + rows.join(''));
    }
  }
  D.Plot = Plot;

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
    const f = opts.fmt || (v => NIRS.fmt(v, Math.abs(hi) < 10 ? 1 : 0));
    ctx.textAlign = 'left'; ctx.fillText(f(lo), x, y + h + 2);
    ctx.textAlign = 'right'; ctx.fillText(f(hi) + (opts.unit ? ' ' + opts.unit : ''), x + w, y + h + 2);
    if (!opts.sequential) { ctx.textAlign = 'center'; ctx.fillText('0', x + w / 2, y + h + 2); }
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
    const k = Math.round(NIRS.clamp(sequential ? t : (t + 1) / 2, 0, 1) * 255) * 3;
    return [L[k], L[k + 1], L[k + 2]];
  };

  /* ---------- the probe ----------
     The probe patch seen from above (x right, y toward the nose), scaled
     to fit the rectangle.  Channels are drawn as bars between their source
     and detector, coloured by `values` when given (diverging around zero,
     or sequential with opts.sequential), short channels as short bars.
     Returns a hit test and the coordinate mapping. */
  D.probeMap = function (ctx, ds, rect, opts) {
    opts = opts || {};
    const T = D.theme(), geo = ds.geo || ds;
    const opt = geo.sources.concat(geo.detectors);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    opt.forEach(o => { x0 = Math.min(x0, o.x); x1 = Math.max(x1, o.x); y0 = Math.min(y0, o.y); y1 = Math.max(y1, o.y); });
    (opts.regions || []).forEach(g => { x0 = Math.min(x0, g.x - g.r); x1 = Math.max(x1, g.x + g.r); y0 = Math.min(y0, g.y - g.r); y1 = Math.max(y1, g.y + g.r); });
    const pad = opts.pad === undefined ? 1.1 : opts.pad;
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const sc = Math.min(rect.w / (x1 - x0), rect.h / (y1 - y0));
    const ox = rect.x + (rect.w - (x1 - x0) * sc) / 2, oy = rect.y + (rect.h - (y1 - y0) * sc) / 2;
    const toPx = (x, y) => [ox + (x - x0) * sc, oy + (y1 - y) * sc];
    const fromPx = (px, py) => [x0 + (px - ox) / sc, y1 - (py - oy) / sc];
    // patch
    ctx.fillStyle = T.surface; ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
    const [ax, ay] = toPx(x0 + 0.3, y1 - 0.3), [bx, by] = toPx(x1 - 0.3, y0 + 0.3);
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(ax, ay, bx - ax, by - ay, 10); else ctx.rect(ax, ay, bx - ax, by - ay);
    ctx.fill(); ctx.stroke();
    if (opts.grid !== false) {
      ctx.strokeStyle = T.grid; ctx.lineWidth = 0.6; ctx.setLineDash([2, 4]);
      for (let gx = Math.ceil(x0 + 0.3); gx <= x1 - 0.3; gx++) { const [px] = toPx(gx, 0); ctx.beginPath(); ctx.moveTo(px, ay); ctx.lineTo(px, by); ctx.stroke(); }
      for (let gy = Math.ceil(y0 + 0.3); gy <= y1 - 0.3; gy++) { const [, py] = toPx(0, gy); ctx.beginPath(); ctx.moveTo(ax, py); ctx.lineTo(bx, py); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (opts.under) opts.under(ctx, toPx, sc);
    // regions
    (opts.regions || []).forEach(g => {
      const [px, py] = toPx(g.x, g.y);
      ctx.fillStyle = D.alpha(g.color || T.hbo, 0.12); ctx.strokeStyle = g.color || T.hbo; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(px, py, g.r * sc, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      if (g.label) { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(g.label, px, py + g.r * sc + 2); }
    });
    const vals = opts.values, chans = geo.channels;
    let range = opts.range;
    if (vals && !range) { let m = 0; vals.forEach(v => { if (isFinite(v)) m = Math.max(m, Math.abs(v)); }); range = opts.sequential ? [0, m || 1] : (m || 1); }
    const colorOf = v => {
      if (!isFinite(v)) return T.muted;
      if (opts.colorOf) return opts.colorOf(v);
      // sequential starts a step above the lightest so small values stay visible on the surface
      return opts.sequential ? D.seqColor(0.12 + 0.88 * NIRS.clamp((v - range[0]) / (range[1] - range[0]), 0, 1)) : D.divColor(v / range);
    };
    const bw = opts.channelWidth || Math.max(5, Math.min(12, sc * 0.32));
    const segs = [];
    chans.forEach((c, ci) => {
      const s = geo.sources[c.src], d = geo.detectors[c.det];
      const [sx, sy] = toPx(s.x, s.y), [dx, dy] = toPx(d.x, d.y);
      const bad = opts.bad && opts.bad.has(ci);
      const col = vals ? colorOf(vals[ci]) : (c.short ? T.muted : T.axis);
      ctx.strokeStyle = bad ? D.alpha(T.muted, 0.35) : col; ctx.lineWidth = c.short ? bw * 0.7 : bw; ctx.lineCap = c.short ? 'round' : 'butt';
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(dx, dy); ctx.stroke();
      if (bad) {
        ctx.strokeStyle = T.crit; ctx.lineWidth = 1.5; const mx = (sx + dx) / 2, my = (sy + dy) / 2;
        ctx.beginPath(); ctx.moveTo(mx - 4, my - 4); ctx.lineTo(mx + 4, my + 4); ctx.moveTo(mx + 4, my - 4); ctx.lineTo(mx - 4, my + 4); ctx.stroke();
      }
      if (opts.selected === ci) {
        ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
        const ux = dx - sx, uy = dy - sy, L = Math.hypot(ux, uy) || 1, nx = -uy / L * (bw / 2 + 3), ny = ux / L * (bw / 2 + 3);
        ctx.beginPath(); ctx.moveTo(sx + nx, sy + ny); ctx.lineTo(dx + nx, dy + ny); ctx.moveTo(sx - nx, sy - ny); ctx.lineTo(dx - nx, dy - ny); ctx.stroke(); ctx.setLineDash([]);
      }
      segs.push({ ci, sx, sy, dx, dy });
    });
    ctx.lineCap = 'butt';
    if (opts.curves) chans.forEach((c, ci) => {
      if (!opts.curves[ci]) return;
      const sg = segs[ci];
      opts.curves[ci](ctx, (sg.sx + sg.dx) / 2, (sg.sy + sg.dy) / 2, sc);
    });
    // optodes
    const r = Math.max(6, Math.min(11, sc * 0.3));
    geo.sources.forEach(s => {
      const [px, py] = toPx(s.x, s.y);
      ctx.fillStyle = T.src; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(px - r, py - r, 2 * r, 2 * r); ctx.fill(); ctx.stroke();
      if (opts.highlight === s.name) { ctx.strokeStyle = T.crit; ctx.lineWidth = 2; ctx.strokeRect(px - r - 3, py - r - 3, 2 * r + 6, 2 * r + 6); }
      if (opts.labels !== false) { ctx.fillStyle = '#111'; ctx.font = D.font(Math.max(8, r * 0.95), 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.name, px, py + 0.5); }
    });
    geo.detectors.forEach(d => {
      const [px, py] = toPx(d.x, d.y);
      const rr = d.short ? r * 0.6 : r;
      ctx.fillStyle = T.det; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, rr, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (opts.highlight === d.name) { ctx.strokeStyle = T.crit; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(px, py, rr + 4, 0, 2 * Math.PI); ctx.stroke(); }
      if (opts.labels !== false && !d.short) { ctx.fillStyle = '#fff'; ctx.font = D.font(Math.max(8, r * 0.95), 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(d.name, px, py + 0.5); }
    });
    if (opts.scalebar !== false) {
      const [p0x, p0y] = toPx(x0 + 0.5, y0 + 0.45), L = sc;
      ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p0x, p0y); ctx.lineTo(p0x + L, p0y); ctx.stroke();
      ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('1 cm', p0x, p0y - 2);
    }
    const hit = (px, py) => {
      let best = -1, bd = Infinity;
      segs.forEach(sg => {
        const ux = sg.dx - sg.sx, uy = sg.dy - sg.sy, L2 = ux * ux + uy * uy || 1;
        const t = NIRS.clamp(((px - sg.sx) * ux + (py - sg.sy) * uy) / L2, 0, 1);
        const d = Math.hypot(px - (sg.sx + t * ux), py - (sg.sy + t * uy));
        if (d < bd) { bd = d; best = sg.ci; }
      });
      return bd < Math.max(10, bw) ? best : -1;
    };
    return { hit, toPx, fromPx, sc, range, segs };
  };

  /* Hover and click on a canvas showing a probe map.  getMap() returns
     what probeMap returned on the last draw. */
  D.bindProbe = function (cv, getMap, getDs, onPick, tipOf) {
    if (cv._bound) return;
    cv._bound = true;
    cv.style.cursor = 'pointer';
    cv.addEventListener('mousemove', e => {
      const m = getMap(), ds = getDs(); if (!m || !ds) return;
      const r = cv.getBoundingClientRect(), ci = m.hit(e.clientX - r.left, e.clientY - r.top);
      if (ci < 0) { D.tip(0, 0, null); return; }
      D.tip(e.clientX, e.clientY, tipOf ? tipOf(ci) : ds.chans[ci].label);
    });
    cv.addEventListener('mouseleave', () => D.tip(0, 0, null));
    cv.addEventListener('click', e => {
      const m = getMap(); if (!m) return;
      const r = cv.getBoundingClientRect(), ci = m.hit(e.clientX - r.left, e.clientY - r.top);
      if (ci >= 0 && onPick) onPick(ci);
    });
  };

  /* ---------- the head from above ----------
     Outline, nose and ears, the 10-20 landmarks, and the probe wrapped
     onto the head. */
  D.headTop = function (ctx, cx, cy, r, cfg, geo, opts) {
    opts = opts || {};
    const T = D.theme();
    ctx.fillStyle = T.surface; ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    const nw = r * 0.09;
    ctx.beginPath(); ctx.moveTo(cx - nw, cy - r * 0.995); ctx.lineTo(cx, cy - r * 1.09); ctx.lineTo(cx + nw, cy - r * 0.995); ctx.stroke();
    [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * r * 1.03, cy, r * 0.04, r * 0.14, 0, 0, 2 * Math.PI); ctx.stroke(); });
    const P = u => { const [x, y] = NIRS.topView(u); return [cx + x * r, cy - y * r]; };
    const names = ['Fpz', 'Fz', 'Cz', 'Pz', 'Oz', 'C3', 'C4', 'T7', 'T8', 'F7', 'F8', 'P7', 'P8'];
    ctx.font = D.font(Math.max(8, Math.min(10, r * 0.06)));
    Object.keys(NIRS.TEN20).forEach(k => {
      const [px, py] = P(NIRS.ten20Unit(k));
      ctx.fillStyle = T.muted; ctx.beginPath(); ctx.arc(px, py, Math.max(1.2, r * 0.012), 0, 2 * Math.PI); ctx.fill();
      if (names.includes(k) && r > 70 && opts.names !== false) { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(k, px, py - 2); }
    });
    if (!cfg) return { P };
    const head = NIRS.HEADS[cfg.head.model] || NIRS.HEADS.adult;
    const frame = NIRS.patchFrame(cfg.probe.over, cfg.probe.rotate);
    const at = (x, y) => P(NIRS.patchToHead(frame, x, y, head.radius));
    if (geo) {
      ctx.lineWidth = Math.max(1.5, r * 0.018);
      geo.channels.forEach((c, ci) => {
        const s = geo.sources[c.src], d = geo.detectors[c.det];
        const a = at(s.x, s.y), b = at(d.x, d.y);
        ctx.strokeStyle = opts.selected === ci ? T.ink : T.axis; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
      const rr = Math.max(2.2, r * 0.028);
      geo.sources.forEach(s => { const [px, py] = at(s.x, s.y); ctx.fillStyle = T.src; ctx.fillRect(px - rr, py - rr, 2 * rr, 2 * rr); });
      geo.detectors.forEach(d => { const [px, py] = at(d.x, d.y); ctx.fillStyle = T.det; ctx.beginPath(); ctx.arc(px, py, d.short ? rr * 0.6 : rr, 0, 2 * Math.PI); ctx.fill(); });
    }
    (opts.regions || []).forEach(g => {
      const [px, py] = at(g.x, g.y);
      ctx.strokeStyle = g.color || T.hbo; ctx.lineWidth = 1.5; ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.arc(px, py, Math.max(3, g.r / head.radius * r * 0.6), 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    });
    return { P, at };
  };

  /* ---------- tissue cross-section ----------
     Horizontal layer bands over x in xr (cm) and depth 0..zmax cm, drawn
     into rect.  Returns the mapping both ways. */
  D.crossSection = function (ctx, rect, layers, xr, zmax, opts) {
    opts = opts || {};
    const T = D.theme();
    const sx = x => rect.x + (x - xr[0]) / (xr[1] - xr[0]) * rect.w;
    const sz = z => rect.y + z / zmax * rect.h;
    const ix = px => xr[0] + (px - rect.x) / rect.w * (xr[1] - xr[0]);
    const iz = py => (py - rect.y) / rect.h * zmax;
    layers.forEach(L => {
      const a = sz(Math.min(zmax, L.z0)), b = sz(Math.min(zmax, L.z1));
      if (b <= a) return;
      ctx.fillStyle = T.layers[L.key] || T.surface;
      ctx.fillRect(rect.x, a, rect.w, b - a);
      if (L.z1 < zmax) { ctx.strokeStyle = T.layers.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(rect.x, Math.round(b) + 0.5); ctx.lineTo(rect.x + rect.w, Math.round(b) + 0.5); ctx.stroke(); }
    });
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(rect.x, rect.y + 0.5); ctx.lineTo(rect.x + rect.w, rect.y + 0.5); ctx.stroke();
    if (opts.labels !== false) {
      ctx.font = D.font(10); ctx.textBaseline = 'middle';
      layers.forEach(L => {
        const a = sz(Math.min(zmax, L.z0)), b = sz(Math.min(zmax, L.z1));
        if (b - a < 10) return;
        ctx.fillStyle = T.ink2; ctx.textAlign = opts.labelSide === 'right' ? 'right' : 'left';
        const txt = L.label + (isFinite(L.d) ? ` ${(L.d * 10).toFixed(L.d < 0.3 ? 1 : 0)} mm` : '');
        ctx.fillText(txt, opts.labelSide === 'right' ? rect.x + rect.w - 6 : rect.x + 6, (a + b) / 2);
      });
    }
    if (opts.depthAxis !== false) {
      ctx.fillStyle = T.muted; ctx.font = D.font(9); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      D.ticks(0, zmax, 5).forEach(z => { if (z <= 0) return; const y = sz(z); ctx.fillText((z * 10).toFixed(0) + ' mm', rect.x - 4, y); ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(rect.x - 2, y); ctx.lineTo(rect.x, y); ctx.stroke(); });
    }
    return { sx, sz, ix, iz };
  };

  // A source (square) and detectors (circles) sitting on the surface of a cross-section.
  D.optodeMarks = function (ctx, map, xs, xd, opts) {
    opts = opts || {};
    const T = D.theme(), y = map.sz(0);
    const draw = (x, kind, label) => {
      const px = map.sx(x);
      ctx.fillStyle = kind === 'src' ? T.src : T.det; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
      if (kind === 'src') { ctx.beginPath(); ctx.rect(px - 7, y - 16, 14, 14); ctx.fill(); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(px, y - 9, 7, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = kind === 'src' ? '#111' : '#fff'; ctx.font = D.font(9, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(kind === 'src' ? 'S' : 'D', px, y - 9);
      if (label) { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textBaseline = 'bottom'; ctx.fillText(label, px, y - 18); }
    };
    if (xs !== null && xs !== undefined) draw(xs, 'src', opts.srcLabel);
    if (xd !== null && xd !== undefined) [].concat(xd).forEach((x, i) => draw(x, 'det', opts.detLabels ? opts.detLabels[i] : opts.detLabel));
  };

  /* A scalar field (nz rows of nx) drawn as one colour whose opacity
     follows a log scale over `decades`, so the banana shows on top of the
     layers. */
  D.fieldImage = function (ctx, rect, field, nx, nz, colorHex, opts) {
    opts = opts || {};
    let mx = 0;
    for (let i = 0; i < field.length; i++) if (field[i] > mx) mx = field[i];
    const decades = opts.decades || 3, floor = mx * Math.pow(10, -decades);
    const off = document.createElement('canvas');
    off.width = nx; off.height = nz;
    const octx = off.getContext('2d'), img = octx.createImageData(nx, nz);
    const [r, g, b] = hexRgb(colorHex);
    const lf = Math.log10(floor || 1e-300);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const v = field[j * nx + i];
      const t = v > floor ? (Math.log10(v) - lf) / decades : 0;
      const q = (j * nx + i) * 4;
      img.data[q] = r; img.data[q + 1] = g; img.data[q + 2] = b; img.data[q + 3] = Math.round(NIRS.clamp(t, 0, 1) * (opts.maxAlpha || 230));
    }
    octx.putImageData(img, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, rect.x, rect.y, rect.w, rect.h); ctx.restore();
    return { max: mx, floor };
  };
  D.hexRgb = hexRgb;

  // Shaded task blocks and event ticks for time plots.
  D.taskBands = function (ds, t0, t1) {
    const T = D.theme();
    return ds.blocks.filter(b => b.kind === 'task' && b.t1 > t0 && b.t0 < t1).map(b => ({ x0: b.t0, x1: b.t1, fill: D.alpha(T.series[(b.ci || 0) % 8], T.dark ? 0.15 : 0.09) }));
  };
  D.eventLines = function (ds, t0, t1) {
    const T = D.theme();
    return ds.events.filter(e => e.dur < 3 && e.t >= t0 && e.t <= t1).map(e => ({ x: e.t, color: D.alpha(T.series[e.ci % 8], 0.55) }));
  };
})(typeof window !== 'undefined' ? window : globalThis);
