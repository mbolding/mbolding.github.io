/* MEG simulator: drawing.
   Theme tokens read from CSS, colour maps interpolated in OKLab, a small
   line-plot class with a hover read-out, field maps over the helmet by
   spherical-spline interpolation, head cross-sections with the helmet,
   heat maps and MRI slices. */
(function (G) {
  'use strict';
  const MEG = G.MEG, v3 = MEG.v3;
  const D = MEG.draw = {};

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
      helium: v('--helium'), vac: v('--vac'), metal: v('--metal'), mu: v('--mu'), alu: v('--alu'), skin: v('--skin'), skinLine: v('--skin-line'),
      coil: v('--coil'), squid: v('--squid'), cold: v('--cold'), hot: v('--hot'),
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
  const toSrgb = c => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(MEG.clamp(v, 0, 1) * 255); };
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
  D.lut = lut;
  D.alpha = function (hex, a) {
    if (!hex) return `rgba(0,0,0,${a})`;
    if (hex.startsWith('rgb')) return hex.replace(/rgba?\(([^)]+)\)/, (m, inner) => { const p = inner.split(',').slice(0, 3); return `rgba(${p.join(',')},${a})`; });
    const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`;
  };
  D.divColor = function (t) { const L = D.theme().divLUT, i = Math.round((MEG.clamp(t, -1, 1) + 1) * 127.5) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };
  D.seqColor = function (t) { const L = D.theme().seqLUT, i = Math.round(MEG.clamp(t, 0, 1) * 255) * 3; return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`; };
  D.lutRGB = function (t, sequential) {
    const L = sequential ? D.theme().seqLUT : D.theme().divLUT;
    const k = Math.round(MEG.clamp(sequential ? t : (t + 1) / 2, 0, 1) * 255) * 3;
    return [L[k], L[k + 1], L[k + 2]];
  };

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
  D.message = function (cv, text, h) {
    const g = D.fit(cv, h || 60), T = D.theme();
    g.ctx.fillStyle = T.muted; g.ctx.font = D.font(12); g.ctx.textAlign = 'center'; g.ctx.textBaseline = 'middle';
    String(text).split('\n').forEach((line, i, all) => g.ctx.fillText(line, g.w / 2, g.h / 2 + (i - (all.length - 1) / 2) * 16));
    return g;
  };

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
  D.logTicks = logTicks;
  D.fmtTick = function (v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e6) return v.toExponential(0).replace('e+', 'e');
    if (a >= 1000) return (v / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1).replace(/\.0$/, '');
    if (a >= 0.01) return v.toFixed(2).replace(/0$/, '');
    return v.toExponential(0);
  };

  /* ---------- line plot ----------
     spec: { series: [{ x?, y, color, width, dash, label, alpha, fill, y2 }],
             x, xRange, yRange, xLog, yLog, xLabel, yLabel, bands, vlines,
             hlines, markers, invertY, xFmt, yFmt, tipFmt, tipX, after } */
  class Plot {
    constructor(cv, opts) {
      this.cv = cv; this.o = Object.assign({ height: 220, margin: [12, 14, 36, 54] }, opts || {});
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
        if (!isFinite(a)) { a = 0; b = 1; }
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
      (spec.hlines || []).forEach(l => {
        ctx.strokeStyle = l.color || T.muted; ctx.setLineDash(l.dash || [4, 4]); ctx.lineWidth = l.width || 1; const y = sy(l.y); ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke();
        if (l.label) { ctx.setLineDash([]); ctx.fillStyle = l.color || T.muted; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(l.label, X1 - 4, y - 2); }
      });
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
        const valid = i => isFinite(ys[i]) && !(spec.yLog && ys[i] <= 0) && !(spec.xLog && xs[i] <= 0);
        if (n > 3 * (X1 - X0)) {
          // many points: one vertical stroke from the lowest to the highest value in each pixel column
          let col = null, lo = Infinity, hi = -Infinity, first = 0;
          const flush = () => { if (col === null) return; const X = col + 0.5; if (!pen) { ctx.moveTo(X, sy(first)); pen = true; } else ctx.lineTo(X, sy(first)); ctx.lineTo(X, sy(lo)); ctx.lineTo(X, sy(hi)); };
          for (let i = 0; i < n; i++) {
            if (!valid(i)) { flush(); col = null; pen = false; continue; }
            const c = Math.floor(sx(xs[i])), y = ys[i];
            if (c !== col) { flush(); col = c; lo = hi = first = y; } else { if (y < lo) lo = y; if (y > hi) hi = y; }
          }
          flush();
        } else {
          for (let i = 0; i < n; i++) {
            if (!valid(i)) { pen = false; continue; }
            const X = sx(xs[i]), Y = sy(ys[i]);
            if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
          }
        }
        ctx.stroke();
        ctx.globalAlpha = 1; ctx.setLineDash([]);
      });
      (spec.vlines || []).forEach(l => {
        if (l.x < xr[0] || l.x > xr[1]) return;
        ctx.strokeStyle = l.color || T.muted; ctx.setLineDash(l.dash || []); ctx.lineWidth = l.width || 1;
        const x = sx(l.x); ctx.beginPath(); ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); ctx.stroke(); ctx.setLineDash([]);
        if (l.label) { ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = x > X1 - 60 ? 'right' : 'left'; ctx.textBaseline = 'top'; ctx.fillText(l.label, x + (x > X1 - 60 ? -4 : 4), Y0 + 2 + (l.row || 0) * 12); }
      });
      (spec.markers || []).forEach(m => {
        if (!isFinite(m.y)) return;
        const x = sx(m.x), y = sy(m.y);
        ctx.fillStyle = m.color || T.accent; ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, m.r || 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        if (m.label) { ctx.fillStyle = T.ink; ctx.font = D.font(10, 600); ctx.textAlign = m.align || 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(m.label, x + (m.align === 'right' ? -6 : 6), y - 3); }
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
        rows.push(D.tipRow(se.color, se.label, (s.tipFmt || MEG.fmt)(yv, se)));
      });
      if (rows.length > 14) rows.splice(14, rows.length - 14, `<div class="row" style="color:var(--muted)">and ${rows.length - 14} more</div>`);
      const head = s.tipX ? s.tipX(xv) : `${s.xLabel || 'x'}: ${MEG.fmt(xv, 2)}`;
      D.tip(e.clientX, e.clientY, `<div style="color:var(--muted);margin-bottom:2px">${head}</div>` + rows.join(''));
    }
  }
  D.Plot = Plot;

  /* ---------- field maps ----------
     A map is drawn over a set of points on the sphere ({key, U}): the
     105 sensor sites, or a list of EEG electrodes.  The projection is
     azimuthal equidistant from the vertex with the rim 135 degrees down;
     the head's outline is drawn through the circumference electrodes
     (Fpz, T7, Oz, T8), about 96 degrees down on the template head. */
  const RIM_EQ = (MEG.RING_THETA || 90) / 135;          // the head's outline passes through the circumference electrodes
  D.RIM_EQ = RIM_EQ;
  let SITESET = null;
  D.sites = () => SITESET || (SITESET = { key: 'sites', U: MEG.SITES.map(s => s.u) });
  const ELSETS = new Map();
  D.elecs = labels => { const k = labels.join(','); if (!ELSETS.has(k)) ELSETS.set(k, { key: 'el:' + k, U: labels.map(l => MEG.ELEC[l]) }); return ELSETS.get(k); };
  const GRIDS = new Map();
  D.grid = res => { if (!GRIDS.has(res)) GRIDS.set(res, MEG.topoGrid(res)); return GRIDS.get(res); };
  const TOPO_CACHE = new Map();
  function topoInterp(set, res) {
    const key = set.key + '|' + res;
    let c = TOPO_CACHE.get(key);
    if (!c) {
      const grid = D.grid(res);
      const sp = MEG.makeSpline(set.U);
      c = { grid, W: sp.interpMatrix(grid.pts), n: set.U.length, xy: set.U.map(MEG.project) };
      if (TOPO_CACHE.size > 24) TOPO_CACHE.delete(TOPO_CACHE.keys().next().value);
      TOPO_CACHE.set(key, c);
    }
    return c;
  }
  D.topoInterp = topoInterp;

  /* Values on the grid of a map (one per grid point) to an image in the disc. */
  D.mapImage = function (ctx, cx, cy, r, grid, vals, opts) {
    opts = opts || {};
    const T = D.theme(), res = grid.res;
    let lo = Infinity, hi = -Infinity;
    for (let p = 0; p < vals.length; p++) { const s = vals[p]; if (s < lo) lo = s; if (s > hi) hi = s; }
    let range = opts.range;
    if (opts.sequential) { if (!range) range = [Math.min(lo, 0), hi || 1]; }
    else if (!range) range = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const off = D._off || (D._off = document.createElement('canvas'));
    off.width = res; off.height = res;
    const octx = off.getContext('2d');
    const img = octx.createImageData(res, res);
    const L = opts.lut || (opts.sequential ? T.seqLUT : T.divLUT);
    const full = new Float32Array(res * res).fill(NaN);
    for (let p = 0; p < grid.idx.length; p++) {
      const v = vals[p];
      full[grid.idx[p]] = v;
      const t = opts.sequential ? (v - range[0]) / (range[1] - range[0]) : (v / range + 1) / 2;
      const k = Math.round(MEG.clamp(t, 0, 1) * 255) * 3, q = grid.idx[p] * 4;
      img.data[q] = L[k]; img.data[q + 1] = L[k + 1]; img.data[q + 2] = L[k + 2]; img.data[q + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, cx - r, cy - r, 2 * r, 2 * r);
    if (opts.contours !== false && r > 30) contours(ctx, full, res, cx, cy, r, opts.sequential ? null : range, T, opts.contourColor);
    ctx.restore();
    return { range, lo, hi, full };
  };
  D.headOutline = function (ctx, cx, cy, r, opts) {
    opts = opts || {};
    const T = D.theme(), R = r * RIM_EQ;
    ctx.strokeStyle = opts.color || T.ink2; ctx.lineWidth = r > 60 ? 1.4 : 1;
    if (opts.rim !== false) { ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = D.alpha(T.muted, 0.7); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.restore(); }
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    const nw = R * 0.1;
    ctx.beginPath(); ctx.moveTo(cx - nw, cy - R * 0.995); ctx.lineTo(cx, cy - R * 1.1); ctx.lineTo(cx + nw, cy - R * 0.995); ctx.stroke();
    [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * R * 1.035, cy, R * 0.045, R * 0.15, 0, 0, 2 * Math.PI); ctx.stroke(); });
  };
  // Pixel position of a direction on a map drawn at (cx, cy, r).
  D.mapXY = (u, cx, cy, r) => { const [mx, my] = MEG.project(u); return [cx + mx * r, cy - my * r]; };

  /* Draw a map from values at the points of a set.
     opts: range (symmetric limit, or [lo, hi] when sequential), sequential,
     dots, names, marks {index: colour}, selected (index), contours. */
  D.topo = function (ctx, cx, cy, r, set, values, opts) {
    opts = opts || {};
    const T = D.theme();
    const res = opts.res || (r > 90 ? 96 : r > 45 ? 64 : 40);
    const c = topoInterp(set, res);
    const n = c.n, grid = c.grid, W = c.W;
    const vals = new Float32Array(grid.idx.length);
    for (let p = 0; p < grid.idx.length; p++) {
      let s = 0; const o = p * n;
      for (let j = 0; j < n; j++) s += W[o + j] * values[j];
      vals[p] = s;
    }
    if (opts.sequential && opts.floor0) for (let p = 0; p < vals.length; p++) if (vals[p] < 0) vals[p] = 0;
    const out = D.mapImage(ctx, cx, cy, r, grid, vals, opts);
    D.headOutline(ctx, cx, cy, r, { rim: opts.rim });
    if (opts.dots !== false) {
      const marks = opts.marks || {};
      c.xy.forEach(([mx, my], j) => {
        const x = cx + mx * r, y = cy - my * r;
        const mk = marks[j];
        ctx.fillStyle = mk || D.alpha(T.ink, 0.7); ctx.beginPath(); ctx.arc(x, y, mk ? Math.max(3, r * 0.035) : Math.max(0.9, r * 0.011), 0, 2 * Math.PI); ctx.fill();
        if (mk) { ctx.strokeStyle = T.surface; ctx.lineWidth = 1.5; ctx.stroke(); }
        if (opts.selected === j) { ctx.strokeStyle = T.ink; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, Math.max(5, r * 0.05), 0, 2 * Math.PI); ctx.stroke(); }
      });
    }
    out.xy = c.xy.map(([mx, my]) => [cx + mx * r, cy - my * r]);
    out.cx = cx; out.cy = cy; out.r = r;
    return out;
  };

  // Marching squares at evenly spaced levels; zero drawn dashed.
  function contours(ctx, f, res, cx, cy, r, range, T, color, levelsIn) {
    if (!range && !levelsIn) return;
    const levels = levelsIn || D.ticks(-range, range, 6).filter(v => Math.abs(v) < range * 0.999);
    const px = i => cx - r + (i + 0.5) / res * 2 * r, py = j => cy - r + (j + 0.5) / res * 2 * r;
    ctx.lineWidth = color ? 1.3 : 0.8;
    levels.forEach(lv => {
      ctx.strokeStyle = color ? (lv === 0 ? D.alpha(color, 0.9) : color) : D.alpha(T.dark ? '#ffffff' : '#000000', lv === 0 ? 0.45 : 0.22);
      ctx.setLineDash(lv === 0 ? [3, 3] : (color && lv < 0 ? [5, 3] : []));
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
  D.contours = function (ctx, full, res, cx, cy, r, levels, color) {
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
    contours(ctx, full, res, cx, cy, r, null, D.theme(), color, levels);
    ctx.restore();
  };

  // Horizontal colour bar with end labels.
  D.colorbar = function (ctx, x, y, w, h, range, opts) {
    opts = opts || {};
    const T = D.theme();
    for (let i = 0; i < w; i++) {
      const t = i / (w - 1);
      ctx.fillStyle = opts.sequential ? D.seqColor(t) : D.divColor(2 * t - 1);
      ctx.fillRect(x + i, y, 1.5, h);
    }
    ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textBaseline = 'top';
    const lo = opts.sequential ? range[0] : -range, hi = opts.sequential ? range[1] : range;
    const f = opts.fmt || (v => MEG.fmt(v, Math.abs(hi) < 10 ? 1 : 0));
    ctx.textAlign = 'left'; ctx.fillText(f(lo), x, y + h + 2);
    ctx.textAlign = 'right'; ctx.fillText(f(hi) + (opts.unit ? ' ' + opts.unit : ''), x + w, y + h + 2);
    if (!opts.sequential) { ctx.textAlign = 'center'; ctx.fillText('0', x + w / 2, y + h + 2); }
  };

  // A complete single map on its own canvas, with an optional colour bar and title.
  D.topoCanvas = function (cv, set, values, opts) {
    opts = opts || {};
    const size = opts.size || (w => Math.min(w, opts.maxH || 330) + (opts.colorbar === false ? 0 : 30) + (opts.title ? 18 : 0));
    const { ctx, w, h } = D.fit(cv, size);
    const T = D.theme();
    const top = opts.title ? 18 : 0, bar = opts.colorbar === false ? 0 : 30;
    const r = Math.min(w, h - top - bar) / 2 * 0.94;
    const cx = w / 2, cy = top + (h - top - bar) / 2;
    if (opts.title) { ctx.fillStyle = T.ink2; ctx.font = D.font(12, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(opts.title, w / 2, 2); }
    const out = D.topo(ctx, cx, cy, r, set, values, opts);
    if (bar) D.colorbar(ctx, w / 2 - Math.min(150, w * 0.35), h - 26, Math.min(300, w * 0.7), 9, out.range, { sequential: opts.sequential, unit: opts.unit, fmt: opts.fmt });
    out.ctx = ctx; out.w = w; out.h = h;
    return out;
  };
  // A map from values already on the grid (for fields computed point by point).
  D.gridCanvas = function (cv, grid, vals, opts) {
    opts = opts || {};
    const size = opts.size || (w => Math.min(w, opts.maxH || 330) + (opts.colorbar === false ? 0 : 30) + (opts.title ? 18 : 0));
    const { ctx, w, h } = D.fit(cv, size);
    const T = D.theme();
    const top = opts.title ? 18 : 0, bar = opts.colorbar === false ? 0 : 30;
    const r = Math.min(w, h - top - bar) / 2 * 0.94;
    const cx = w / 2, cy = top + (h - top - bar) / 2;
    if (opts.title) { ctx.fillStyle = T.ink2; ctx.font = D.font(12, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(opts.title, w / 2, 2); }
    const out = D.mapImage(ctx, cx, cy, r, grid, vals, opts);
    D.headOutline(ctx, cx, cy, r, { rim: opts.rim });
    if (bar) D.colorbar(ctx, w / 2 - Math.min(150, w * 0.35), h - 26, Math.min(300, w * 0.7), 9, out.range, { sequential: opts.sequential, unit: opts.unit, fmt: opts.fmt });
    Object.assign(out, { ctx, w, h, cx, cy, r });
    return out;
  };

  /* Values per sensor site from per-channel values.  For the triplet array
     `mode` picks the magnetometer, one gradiometer, or the length of the
     gradient (rms of the pair). */
  D.siteValues = function (arr, vals, mode) {
    if (arr.perSite === 1) return Float64Array.from(MEG.SITES, (_, si) => vals[arr.siteChannels[si][0]]);
    return Float64Array.from(MEG.SITES, (_, si) => {
      const [m, a, b] = arr.siteChannels[si];
      if (mode === 'mag') return vals[m];
      if (mode === 'a') return vals[a];
      if (mode === 'b') return vals[b];
      return Math.hypot(vals[a], vals[b]);
    });
  };
  // A sensor layout: sites, optionally names, marks and a selection.
  D.helmetMap = function (ctx, cx, cy, r, opts) {
    opts = opts || {};
    const T = D.theme();
    ctx.fillStyle = T.surface; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fill();
    D.headOutline(ctx, cx, cy, r);
    const pts = [];
    MEG.SITES.forEach((s, j) => {
      const [x, y] = D.mapXY(s.u, cx, cy, r);
      const mk = opts.marks && opts.marks[j];
      const rad = mk ? Math.max(3.5, r * 0.03) : Math.max(1.8, r * 0.018);
      ctx.fillStyle = mk || (opts.color ? opts.color(s, j) : T.ink2);
      if (opts.square) ctx.fillRect(x - rad, y - rad, 2 * rad, 2 * rad);
      else { ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * Math.PI); ctx.fill(); }
      if (opts.selected === j) { ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, rad + 3, 0, 2 * Math.PI); ctx.stroke(); }
      if (opts.names && r > 140) { ctx.fillStyle = T.muted; ctx.font = D.font(8); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(s.name, x, y - rad - 1); }
      pts.push({ j, x, y });
    });
    return pts;
  };
  // Nearest site to a pixel on a map; null if too far.
  D.pickSite = function (pts, x, y, maxD) {
    let best = null, bd = (maxD || 14) ** 2;
    pts.forEach(p => { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d < bd) { bd = d; best = p.j; } });
    return best;
  };

  /* ---------- head cross-sections ----------
     view: 'top' (nose up), 'side' (left side, nose right) or 'back'
     (from behind, left on the left).  opts.helmet draws the dewar's helmet
     surface and the sensor sites in that view. */
  D.head = function (ctx, x, y, size, view, opts) {
    opts = opts || {};
    const T = D.theme(), H = MEG.HEAD;
    const ext = opts.ext || (opts.helmet ? 15.6 : H.R * 1.12);
    const s = size / 2 / ext, cx = x + size / 2, cy = y + size / 2 + (opts.helmet && view !== 'top' ? size * 0.08 : 0);
    const proj = view === 'top' ? p => [cx + p[0] * s, cy - p[1] * s] : view === 'side' ? p => [cx + p[1] * s, cy - p[2] * s] : p => [cx + p[0] * s, cy - p[2] * s];
    const depthOf = view === 'top' ? p => p[2] : view === 'side' ? p => -p[0] : p => -p[1];
    if (opts.helmet) {
      // the dewar's helmet: a band between the coil surface and the outer wall
      const He = MEG.ARRAY.helmet, a = He.axes, c = He.centre, DEG = Math.PI / 180;
      const pt = (phi, grow) => view === 'top' ? proj([c[0] + (a[0] + grow) * Math.cos(phi), c[1] + (a[1] + grow) * Math.sin(phi), 0])
        : view === 'side' ? proj([0, c[1] + (a[1] + grow) * Math.cos(phi), c[2] + (a[2] + grow) * Math.sin(phi)])
          : proj([c[0] + (a[0] + grow) * Math.cos(phi), 0, c[2] + (a[2] + grow) * Math.sin(phi)]);
      const [p0, p1] = view === 'top' ? [0, 360] : view === 'side' ? [-8, 223] : [-24, 204];
      ctx.beginPath();
      for (let k = 0; k <= 60; k++) { const q = pt((p0 + (p1 - p0) * k / 60) * DEG, -0.4); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }
      for (let k = 60; k >= 0; k--) { const q = pt((p0 + (p1 - p0) * k / 60) * DEG, 2.2); ctx.lineTo(q[0], q[1]); }
      ctx.closePath();
      ctx.fillStyle = D.alpha(T.helium || T.surface, 0.8); ctx.fill();
      ctx.strokeStyle = T.metal || T.axis; ctx.lineWidth = 1; ctx.stroke();
    }
    /* The layers follow the head's own outline, cut through the centre in
       the plane of the view (the template's scalp; a circle without it),
       each shrunk in proportion to its radius in the head model. */
    const cols = [T.layers.scalp, T.layers.skull, T.layers.csf, T.layers.brain];
    const radii = opts.homogeneous ? [H.R] : [H.R, H.radii[2], H.radii[1], H.radii[0]];
    const dirAt = view === 'top' ? a => [Math.sin(a), Math.cos(a), 0] : view === 'side' ? a => [0, Math.cos(a), Math.sin(a)] : a => [Math.cos(a), 0, Math.sin(a)];
    // below the ears the template's field of view ends: round the outline off there
    const rimR = u => { const th = Math.acos(MEG.clamp(u[2], -1, 1)) * 180 / Math.PI, w = MEG.clamp((th - 122) / 18, 0, 1), sw = w * w * (3 - 2 * w); return MEG.scalpR(u) * (1 - sw) + 0.97 * H.R * sw; };
    const rim = Array.from({ length: 120 }, (_, k) => { const u = dirAt(2 * Math.PI * k / 120); return v3.scale(u, rimR(u)); });
    radii.forEach((rr, i) => {
      ctx.fillStyle = opts.homogeneous ? T.layers.brain : cols[i]; ctx.strokeStyle = T.layers.line; ctx.lineWidth = 1;
      ctx.beginPath();
      rim.forEach((p, k) => { const q = proj(v3.scale(p, rr / H.R)); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
      ctx.closePath(); ctx.fill(); ctx.stroke();
    });
    ctx.strokeStyle = T.layers.line; ctx.lineWidth = 1.2;
    if (view === 'top') {
      const R = MEG.scalpR([0, 1, 0]) * s, W = MEG.scalpR([1, 0, 0]) * s;
      ctx.beginPath(); ctx.moveTo(cx - W * 0.12, cy - R * 0.99); ctx.lineTo(cx, cy - R * 1.09); ctx.lineTo(cx + W * 0.12, cy - R * 0.99); ctx.stroke();
      [-1, 1].forEach(sd => { ctx.beginPath(); ctx.ellipse(cx + sd * W * 1.035, cy, W * 0.05, W * 0.16, 0, 0, 2 * Math.PI); ctx.stroke(); });
    } else if (view === 'side' && !MEG.TEMPLATE) {
      const R = H.R * s, a = 0.32;
      ctx.beginPath(); ctx.moveTo(cx + R * Math.cos(a), cy + R * Math.sin(a) * 0.2); ctx.lineTo(cx + R * 1.1, cy + R * 0.12); ctx.lineTo(cx + R * 0.97, cy + R * 0.25); ctx.stroke();
    }
    if ((opts.helmet || opts.opm) && opts.sensors !== false) {
      // sensor sites: all of them from above, those near the plane of the section otherwise
      MEG.SITES.forEach(si => {
        const p = opts.opm ? MEG.opmPoint(si.u) : MEG.helmetPoint(si.u).r;
        if (view === 'top' ? p[2] < -2 : Math.abs(depthOf(p)) > 3.2) return;
        const [px, py] = proj(p);
        ctx.fillStyle = T.coil || T.ink2; ctx.fillRect(px - 1.7, py - 1.7, 3.4, 3.4);
      });
    }
    if (opts.labels) {
      ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(view === 'top' ? 'top' : view === 'side' ? 'left side' : 'from behind', cx, y + size - 1);
    }
    return { proj, depthOf, s, cx, cy };
  };

  // A dipole drawn as an arrow in a head view.  When it points at or away
  // from the viewer it is drawn as a dot or a cross in a circle.
  D.dipole = function (ctx, hv, pos, ori, color, opts) {
    opts = opts || {};
    const T = D.theme();
    const len = (opts.len || 2.2);
    const a = hv.proj(v3.sub(pos, v3.scale(ori, len / 2))), b = hv.proj(v3.add(pos, v3.scale(ori, len / 2)));
    const [px, py] = hv.proj(pos);
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    ctx.lineWidth = opts.width || 2.5; ctx.strokeStyle = color; ctx.fillStyle = color;
    if (L < len * hv.s * 0.25) {
      ctx.beginPath(); ctx.arc(px, py, 5, 0, 2 * Math.PI); ctx.lineWidth = 1.8; ctx.stroke();
      const toward = hv.depthOf(ori) > 0;
      if (toward) { ctx.beginPath(); ctx.arc(px, py, 1.8, 0, 2 * Math.PI); ctx.fill(); }
      else { ctx.beginPath(); ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3); ctx.moveTo(px + 3, py - 3); ctx.lineTo(px - 3, py + 3); ctx.stroke(); }
    } else {
      D.arrow(ctx, a[0], a[1], b[0], b[1], color, opts.width || 2.5);
    }
    if (opts.selected) { ctx.strokeStyle = T.ink; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.arc(px, py, 11, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]); }
    if (opts.label) { ctx.fillStyle = T.ink; ctx.font = D.font(10, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(opts.label, px + 9, py - 9); }
    return [px, py];
  };
  D.arrow = function (ctx, x0, y0, x1, y1, color, width, head) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, hl = head || Math.min(9, L * 0.45);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width || 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hl * 0.6, y1 - uy * hl * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1 + ux * 1.5, y1 + uy * 1.5); ctx.lineTo(x1 - ux * hl - uy * hl * 0.55, y1 - uy * hl + ux * hl * 0.55); ctx.lineTo(x1 - ux * hl + uy * hl * 0.55, y1 - uy * hl - ux * hl * 0.55); ctx.closePath(); ctx.fill();
  };
  // Text with a halo, for labels over images.
  D.label = function (ctx, text, x, y, opts) {
    opts = opts || {};
    const T = D.theme();
    ctx.font = D.font(opts.size || 11, opts.weight || 500); ctx.textAlign = opts.align || 'left'; ctx.textBaseline = opts.base || 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = opts.halo || D.alpha(T.card, 0.85); ctx.strokeText(text, x, y);
    ctx.fillStyle = opts.color || T.ink; ctx.fillText(text, x, y);
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

  /* ---------- MRI slices ----------
     A grey-scale image (values 0..1, res x res), with an optional colour
     overlay ({vals, lo, hi}: an RGBA image of the same size). */
  D.slice = function (ctx, x, y, size, img, res, overlay) {
    const off = D._mri || (D._mri = document.createElement('canvas'));
    off.width = res; off.height = res;
    const octx = off.getContext('2d'), im = octx.createImageData(res, res);
    for (let i = 0; i < res * res; i++) {
      let g = Math.round(MEG.clamp(img[i], 0, 1) * 255), r = g, gg = g, b = g;
      if (overlay && overlay[4 * i + 3]) {
        const a = overlay[4 * i + 3] / 255;
        r = Math.round(r * (1 - a) + overlay[4 * i] * a); gg = Math.round(gg * (1 - a) + overlay[4 * i + 1] * a); b = Math.round(b * (1 - a) + overlay[4 * i + 2] * a);
      }
      im.data[4 * i] = r; im.data[4 * i + 1] = gg; im.data[4 * i + 2] = b; im.data[4 * i + 3] = 255;
    }
    octx.putImageData(im, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(off, x, y, size, size); ctx.restore();
  };
  // A heat colour map for overlays on grey: dark red to yellow to white.
  D.HOT = lut(['#7a0b0b', '#d7301f', '#fc8d59', '#fdd49e', '#ffffe0']);
})(typeof window !== 'undefined' ? window : globalThis);
