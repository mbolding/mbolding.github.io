/* ============================================================
   MRI Simulator, k-space tab (ARCHITECTURE.md section 12.5)

   What the scanner actually records: samples of the object's
   spatial-frequency spectrum. The tab shows

     - the gridded k-space of the last reconstruction (one coil at a
       time) as log magnitude, phase, real or imaginary part, with
       overlays for the sampled points, the nominal trajectory and the
       time since excitation of every sample;
     - a hover readout (k in 1/mm, |S|, phase, time, which readout);
     - a "one sample, one stripe pattern" panel: click a point and see
       the wave cos(2 pi (kx x + ky y) + phase) it adds to the image;
     - a profile of the ky = 0 line;
     - an editor: keep or remove the centre, keep one half, paint with
       a brush, invert, and watch a live reconstruction of what is
       left next to the image from all the data. "Apply" hands the
       edited mask to the Image tab (MRI.actions.setRecon({userMask})).

   The k-space grid is the one recon.js returns (section 10): index i
   sits at k = (i - floor(n/2)) dk, rows are ky (top row = most
   negative ky, the same top-to-bottom direction as image rows), and
   the readout direction may be oversampled (dk = 1/(os FOV)). The
   userMask lives on exactly that grid (section 14).

   All heavy work (display arrays, the preview reconstruction) happens
   only while the tab is visible; hidden, the tab just notes what is
   out of date and catches up in onShow.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const PI = Math.PI;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const now = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function w() { return MRI.ui.w; }
    function state() { return MRI.state; }

    /* Run fn at most once per animation frame, however often asked. */
    function frameThrottle(fn) {
        let pending = false;
        return function () {
            if (pending) return;
            pending = true;
            raf(function () { pending = false; fn(); });
        };
    }

    /* ---------- formatting ---------- */
    // k is stored in cycles/m; students read it in 1/mm (cycles per mm).
    function fk(k, d) {
        const v = k / 1000;
        return (Math.abs(v) < 5e-7 ? 0 : v).toFixed(d === undefined ? 3 : d).replace('-', '−');
    }
    function fsig(v) {
        if (!isFinite(v)) return '-';
        const a = Math.abs(v);
        if (a === 0) return '0';
        if (a < 1e-2 || a >= 1e5) return v.toExponential(2).replace('e-', 'e−').replace('-', '−');
        return U.fmtNum(v, 3).replace('-', '−');
    }
    function fms(s, sig) { return U.fmtNum(s * 1e3, sig || 3) + ' ms'; }
    function fmm(m, sig) { return U.fmtNum(m * 1e3, sig || 3) + ' mm'; }
    function signed(v, d) { const s = v.toFixed(d); return (Number(s) === 0 ? '0' : s).replace('-', '−'); }

    function gridKey(k) {
        return k ? k.nx + 'x' + k.ny + '|' + Number(k.dkx).toPrecision(6) + '|' + Number(k.dky).toPrecision(6) : '';
    }
    function upToOpts() {
        const s = state();
        return s.acqUpTo !== null && s.acqUpTo !== undefined ? { upTo: s.acqUpTo } : {};
    }
    function allOnes(m) { for (let i = 0; i < m.length; i++) if (!m[i]) return false; return true; }
    function sameMask(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!a[i] !== !b[i]) return false;
        return true;
    }

    /* ---------- styles (scoped to this tab) ---------- */
    MRI.ui.addStyle(`
#tab-kspace .ks-head-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#tab-kspace .ks-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0 0 12px; }
#tab-kspace .ks-toolbar .ctl-inline .ctl-label { white-space: nowrap; }
#tab-kspace .ks-overlays { display: flex; flex-wrap: wrap; gap: 8px 16px; }
#tab-kspace .kv, #tab-kspace .ks-wave-well { align-self: stretch; }
#tab-kspace .kv-stage { position: relative; min-height: 80px; }
#tab-kspace .kv-canvas { display: block; touch-action: manipulation; cursor: crosshair; border-radius: 4px; }
#tab-kspace .kv-canvas:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-kspace .kv-edit .kv-canvas { touch-action: none; }
#tab-kspace .kv-readout { white-space: normal; min-height: 2.7em; }
#tab-kspace .kv-cbar { flex-wrap: nowrap; }
#tab-kspace .kv-cbar-label { color: var(--scope-fg); white-space: nowrap; }
#tab-kspace .kv-title-right { font-weight: 600; letter-spacing: 0.02em; text-transform: none; }
#tab-kspace .ks-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-kspace .ks-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-kspace .ks-wave-canvas { display: block; width: 100%; border-radius: 3px; }
#tab-kspace .ks-picks { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#tab-kspace .ks-picks .ks-picks-label { font-size: 0.8rem; color: var(--muted); margin-right: 2px; }
#tab-kspace .ks-wave-say { font-size: 0.88rem; line-height: 1.5; margin: 0; }
#tab-kspace .ks-wave-empty { font-size: 0.86rem; color: var(--muted); margin: 0; }
#tab-kspace .ks-tools { display: flex; flex-direction: column; gap: 12px; }
#tab-kspace .ks-tool-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
#tab-kspace .ks-tool-label { font-size: 0.8rem; font-weight: 600; color: var(--muted); min-width: 6.5em; }
#tab-kspace .ks-derived { font-size: 0.8rem; color: var(--muted); margin-top: -6px; }
#tab-kspace .ks-pv-grid { --min: 200px; }
#tab-kspace .ks-edit-grid {
    display: grid; gap: 16px; align-items: start;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-areas: "canvas preview" "tools preview";
}
#tab-kspace .ks-edit-canvas { grid-area: canvas; min-width: 0; }
#tab-kspace .ks-edit-preview { grid-area: preview; min-width: 0; }
#tab-kspace .ks-edit-tools { grid-area: tools; min-width: 0; }
@media (max-width: 760px) {
    #tab-kspace .ks-edit-grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "canvas" "preview" "tools"; }
}
#tab-kspace .ks-pv-stats { font-size: 0.86rem; line-height: 1.5; margin: 0; }
#tab-kspace .ks-pv-notes { margin: 0; padding-left: 18px; }
#tab-kspace .ks-pv-notes li { margin: 2px 0; }
#tab-kspace .ks-apply-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
#tab-kspace .ks-apply-status { font-size: 0.82rem; color: var(--muted); }
#tab-kspace .ks-apply-status.is-on { color: var(--good); font-weight: 600; }
#tab-kspace .ks-pf { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
#tab-kspace .ks-hint { font-size: 0.8rem; color: var(--muted); margin: 0; }
@media (max-width: 640px) {
    #tab-kspace .ks-toolbar { gap: 8px 12px; }
    #tab-kspace .ks-tool-label { min-width: 0; width: 100%; }
}
`);

    /* ---------- display values for one coil of a k-space grid ----------
       Returns {data, lo, hi, cmap, label, fmt} or null when there is
       nothing to show. Points that were not sampled are NaN, which the
       painter leaves transparent: the dark well shows through. For
       gridded (non-Cartesian) data every grid point that received any
       signal counts, since the kernel spreads each sample over a few
       neighbours. */
    function kValues(k, coil, mode, cart) {
        if (!k || !k.re || !k.re.length) return null;
        const N = k.nx * k.ny, out = new Float32Array(N);
        const c = Math.min(Math.max(0, coil | 0), k.re.length - 1);
        const re = k.re[c], im = k.im[c], mask = k.mask;
        let hi = -Infinity, lo = Infinity, any = false;
        for (let p = 0; p < N; p++) {
            const r = re[p], i = im[p];
            const has = cart ? (mask && mask[p] === 1) : (r !== 0 || i !== 0);
            if (!has) { out[p] = NaN; continue; }
            let v;
            if (mode === 'time') v = k.tmap ? k.tmap[p] : NaN;
            else if (mode === 'log') { const m = Math.sqrt(r * r + i * i); v = m > 0 ? Math.log10(m) : NaN; }
            else if (mode === 'phase') v = Math.atan2(i, r);
            else if (mode === 'real') v = r;
            else v = i;
            out[p] = v;
            if (v === v && isFinite(v)) { any = true; if (v > hi) hi = v; if (v < lo) lo = v; }
        }
        if (!any) return null;
        if (mode === 'log') {
            // About four and a half decades: the noise floor at the edge of a
            // typical scan, without letting a single zero-ish point stretch it.
            lo = Math.max(U.percentile(out, 8), hi - 5);
            if (!(hi > lo)) lo = hi - 1;
            return { data: out, lo: lo, hi: hi, cmap: 'gray', label: 'log₁₀ |S| (a.u.)', fmt: function (v) { return signed(v, 1); } };
        }
        if (mode === 'phase') {
            return { data: out, lo: -PI, hi: PI, cmap: 'phase', label: 'phase', fmt: function (v) { return v < 0 ? '−π rad' : '+π rad'; } };
        }
        if (mode === 'time') {
            if (!(hi > lo)) { lo -= 5e-4; hi += 5e-4; }
            return { data: out, lo: lo, hi: hi, cmap: 'viridis', label: 'time since excitation', fmt: function (v) { return fms(v); } };
        }
        // Real and imaginary parts are signed: a diverging map with a
        // symmetric window. The centre of k-space is orders of magnitude
        // stronger than the rest, so the window is clipped at the 99th
        // percentile of |value| to keep the outer structure visible.
        const abs = new Float32Array(N);
        for (let p = 0; p < N; p++) abs[p] = Math.abs(out[p]);
        let a = U.percentile(abs, 99);
        if (!(a > 0)) a = Math.max(Math.abs(lo), Math.abs(hi)) || 1e-12;
        return { data: out, lo: -a, hi: a, cmap: 'diverging', label: (mode === 'real' ? 'Re S' : 'Im S') + ' (a.u., clipped)', fmt: fsig };
    }

    /* Paint a value array into an offscreen canvas at the matrix size
       (NaN stays transparent). */
    function paintOffscreen(off, data, nx, ny, lo, hi, cmap) {
        if (off.width !== nx) off.width = nx;
        if (off.height !== ny) off.height = ny;
        const c = off.getContext('2d');
        const img = c.createImageData(nx, ny), px = img.data;
        const lut = U.colormapLUT(cmap), span = (hi - lo) || 1;
        for (let i = 0, n = nx * ny; i < n; i++) {
            const v = data[i];
            if (!(v === v) || v === Infinity || v === -Infinity) continue;
            let t = (v - lo) / span;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const li = Math.round(t * 255) * 3, j = 4 * i;
            px[j] = lut[li]; px[j + 1] = lut[li + 1]; px[j + 2] = lut[li + 2]; px[j + 3] = 255;
        }
        c.putImageData(img, 0, 0);
    }
    /* A binary mask as a tint: rgba where mask[p] === on. */
    function paintMask(off, mask, nx, ny, on, rgba) {
        if (off.width !== nx) off.width = nx;
        if (off.height !== ny) off.height = ny;
        const c = off.getContext('2d');
        const img = c.createImageData(nx, ny), px = img.data;
        for (let i = 0, n = nx * ny; i < n; i++) {
            if ((mask[i] ? 1 : 0) !== on) continue;
            const j = 4 * i;
            px[j] = rgba[0]; px[j + 1] = rgba[1]; px[j + 2] = rgba[2]; px[j + 3] = rgba[3];
        }
        c.putImageData(img, 0, 0);
    }

    /* ---------- the k-space view (a dark well with a canvas) ----------
       createKView(host, {title, axes, focusable, paint, maxHeight(),
                          ariaLabel, empty})
       draws an offscreen image of the grid with the physical aspect
       ratio (k extent along y over k extent along x, so an oversampled
       readout does not stretch the picture), optional kx / ky axes in
       1/mm, a colour bar and a readout line. Overlays are callbacks
       fn(ctx, g) run after the image, clipped to it, where g maps
       between grid indices, k (cycles/m) and canvas pixels. */
    function createKView(host, o) {
        o = o || {};
        const fig = el('figure', { class: 'well kv' + (o.cls ? ' ' + o.cls : '') });
        const titleText = el('span', { class: 'kv-title-text', text: o.title || '' });
        const titleRight = el('span', { class: 'kv-title-right' });
        const title = el('figcaption', { class: 'well-title' }, [titleText, titleRight]);
        const stage = el('div', { class: 'kv-stage' });
        const canvas = el('canvas', { class: 'kv-canvas', role: 'img', 'aria-label': o.ariaLabel || o.title || 'k-space' });
        if (o.focusable) canvas.tabIndex = 0;
        const emptyEl = el('div', { class: 'iv-empty', text: o.empty || 'No k-space data yet' });
        stage.appendChild(canvas); stage.appendChild(emptyEl);
        const cbCanvas = el('canvas', { class: 'iv-cbar-canvas', width: 256, height: 1, 'aria-hidden': 'true' });
        const cbLabel = el('span', { class: 'kv-cbar-label' }), cbMin = el('span'), cbMax = el('span');
        const cbar = el('div', { class: 'iv-cbar kv-cbar' }, [cbLabel, cbMin, cbCanvas, cbMax]);
        const readout = el('div', { class: 'well-readout kv-readout' });
        fig.appendChild(title); fig.appendChild(stage);
        if (o.colorbar !== false) fig.appendChild(cbar);
        fig.appendChild(readout);
        host.appendChild(fig);

        const off = doc.createElement('canvas');
        const S = { k: null, has: false, overlays: [], geom: null, pointer: null, hint: '' };
        const hoverFns = [], clickFns = [], paintFns = [];

        function draw() {
            const Wd = stage.clientWidth;
            if (!Wd) return;                      // hidden: drawn again when shown
            const k = S.k;
            const m = o.axes ? (Wd < 420 ? { l: 44, r: 8, t: 8, b: 40 } : { l: 52, r: 14, t: 8, b: 40 }) : { l: 0, r: 0, t: 0, b: 0 };
            let aspect = 1;
            if (k) aspect = (k.ny * k.dky) / (k.nx * k.dkx);
            if (!(aspect > 0) || !isFinite(aspect)) aspect = 1;
            const maxH = o.maxHeight ? o.maxHeight() : 520;
            let pw = Math.max(40, Wd - m.l - m.r), ph = pw * aspect;
            if (ph > maxH) { ph = maxH; pw = ph / aspect; }
            pw = Math.floor(pw); ph = Math.floor(ph);
            const left = m.l + Math.floor((Wd - m.l - m.r - pw) / 2), top = m.t;
            const H = top + ph + m.b;
            const r = U.setupCanvas(canvas, Wd, H);
            const ctx = r.ctx;
            ctx.clearRect(0, 0, Wd, H);
            emptyEl.hidden = !!S.has;
            if (!k) { S.geom = null; return; }
            const nx = k.nx, ny = k.ny, cx = nx >> 1, cy = ny >> 1, sx = pw / nx, sy = ph / ny;
            const g = {
                left: left, top: top, pw: pw, ph: ph, nx: nx, ny: ny, cx: cx, cy: cy, sx: sx, sy: sy, dkx: k.dkx, dky: k.dky,
                ix2x: function (ix) { return left + (ix + 0.5) * sx; },
                iy2y: function (iy) { return top + (iy + 0.5) * sy; },
                kx2x: function (kx) { return left + (kx / k.dkx + cx + 0.5) * sx; },
                ky2y: function (ky) { return top + (ky / k.dky + cy + 0.5) * sy; }
            };
            S.geom = g;
            // the extent of the k-space grid, even where nothing was sampled yet
            ctx.fillStyle = '#000';
            ctx.fillRect(left, top, pw, ph);
            if (S.has) {
                ctx.save();
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(off, 0, 0, nx, ny, left, top, pw, ph);
                ctx.restore();
            }
            ctx.save();
            ctx.beginPath(); ctx.rect(left, top, pw, ph); ctx.clip();
            S.overlays.forEach(function (fn) {
                try { fn(ctx, g); } catch (e) { if (root.console) root.console.error('[k-space] overlay failed:', e); }
            });
            ctx.restore();
            if (o.axes) drawAxes(ctx, g, H);
        }

        function drawAxes(ctx, g, H) {
            const muted = U.cssVar('--scope-muted', '#8794a8'), axis = U.cssVar('--scope-axis', '#3a4760');
            const font = U.cssVar('--font-sans', 'system-ui, sans-serif');
            ctx.save();
            ctx.strokeStyle = axis; ctx.lineWidth = 1;
            ctx.strokeRect(g.left - 0.5, g.top - 0.5, g.pw + 1, g.ph + 1);
            ctx.font = '11px ' + font;
            ctx.fillStyle = muted;
            const tk = w()._niceTicks, ft = w()._fmtTick;
            // kx along the bottom
            const kxLo = (-0.5 - g.cx) * g.dkx / 1000, kxHi = (g.nx - 0.5 - g.cx) * g.dkx / 1000;
            const tx = tk(kxLo, kxHi, U.clamp(Math.round(g.pw / 85), 3, 8));
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.beginPath();
            tx.ticks.forEach(function (v) {
                const x = Math.round(g.kx2x(v * 1000) - 0.5 * g.sx) + 0.5;
                if (x < g.left - 1 || x > g.left + g.pw + 1) return;
                ctx.moveTo(x, g.top + g.ph); ctx.lineTo(x, g.top + g.ph + 5);
                ctx.fillText(ft(v, tx.step).replace('-', '−'), x, g.top + g.ph + 7);
            });
            // ky along the left (negative ky at the top, like image rows)
            const kyLo = (-0.5 - g.cy) * g.dky / 1000, kyHi = (g.ny - 0.5 - g.cy) * g.dky / 1000;
            const ty = tk(kyLo, kyHi, U.clamp(Math.round(g.ph / 70), 3, 8));
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ty.ticks.forEach(function (v) {
                const y = Math.round(g.ky2y(v * 1000) - 0.5 * g.sy) + 0.5;
                if (y < g.top - 1 || y > g.top + g.ph + 1) return;
                ctx.moveTo(g.left, y); ctx.lineTo(g.left - 5, y);
                ctx.fillText(ft(v, ty.step).replace('-', '−'), g.left - 7, y);
            });
            ctx.stroke();
            ctx.fillStyle = U.cssVar('--scope-fg', '#d6dde8');
            ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText('kx (1/mm)', g.left + g.pw / 2, H - 1);
            ctx.save();
            ctx.translate(11, g.top + g.ph / 2); ctx.rotate(-PI / 2);
            ctx.textBaseline = 'middle';
            ctx.fillText('ky (1/mm)', 0, 0);
            ctx.restore();
            ctx.restore();
        }

        /* Pointer: hover, click (a press that did not move) and paint
           (pointer captured while pressed). */
        function pick(ev) {
            const g = S.geom;
            if (!g || !S.k) return null;
            const rect = canvas.getBoundingClientRect();
            const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
            const fx = (x - g.left) / g.sx - 0.5, fy = (y - g.top) / g.sy - 0.5;     // fractional grid index
            const ix = Math.round(fx), iy = Math.round(fy);
            const inside = ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny &&
                x >= g.left && x < g.left + g.pw && y >= g.top && y < g.top + g.ph;
            return { ix: ix, iy: iy, fx: fx, fy: fy, x: x, y: y, inside: inside,
                kx: (fx - g.cx) * g.dkx, ky: (fy - g.cy) * g.dky };
        }
        function fire(list, a, b) { list.forEach(function (fn) { try { fn(a, b); } catch (e) { if (root.console) root.console.error('[k-space]', e); } }); }
        let down = null;
        canvas.addEventListener('pointerdown', function (ev) {
            if (ev.button !== 0 || !S.k) return;
            down = { x: ev.clientX, y: ev.clientY, moved: false };
            if (o.paint) {
                try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* unsupported */ }
                ev.preventDefault();
                const p = pick(ev);
                S.pointer = p;
                if (p) fire(paintFns, p, 'start');
            }
        });
        canvas.addEventListener('pointermove', function (ev) {
            const p = pick(ev);
            if (down && Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 4) down.moved = true;
            S.pointer = p;
            if (down && o.paint) { if (p) fire(paintFns, p, 'move'); }
            fire(hoverFns, p && p.inside ? p : null);
        });
        function end(ev, cancelled) {
            if (!down) return;
            const wasClick = !down.moved;
            down = null;
            if (o.paint) { fire(paintFns, pick(ev), 'end'); return; }
            if (!cancelled && wasClick) { const p = pick(ev); if (p && p.inside) fire(clickFns, p); }
        }
        canvas.addEventListener('pointerup', function (ev) { end(ev, false); });
        canvas.addEventListener('pointercancel', function (ev) { end(ev, true); });
        canvas.addEventListener('pointerleave', function () {
            if (down) return;
            S.pointer = null;
            fire(hoverFns, null);
        });

        if (root.ResizeObserver) {
            let lastW = -1;
            const redraw = frameThrottle(function () { lastW = stage.clientWidth; draw(); });
            new root.ResizeObserver(function () { if (stage.clientWidth !== lastW) redraw(); }).observe(stage);
        }

        const api = {
            el: fig, canvas: canvas, stage: stage,
            /* k: the k-space grid (nx, ny, dkx, dky); v: kValues() result or null */
            setImage: function (k, v) {
                S.k = k || null;
                S.has = !!(k && v);
                if (S.has) paintOffscreen(off, v.data, k.nx, k.ny, v.lo, v.hi, v.cmap);
                if (o.colorbar !== false) {
                    cbar.hidden = !S.has;
                    if (S.has) {
                        const lut = U.colormapLUT(v.cmap), cctx = cbCanvas.getContext('2d'), img = cctx.createImageData(256, 1);
                        for (let i = 0; i < 256; i++) {
                            img.data[4 * i] = lut[3 * i]; img.data[4 * i + 1] = lut[3 * i + 1]; img.data[4 * i + 2] = lut[3 * i + 2]; img.data[4 * i + 3] = 255;
                        }
                        cctx.putImageData(img, 0, 0);
                        cbLabel.textContent = v.label;
                        cbMin.textContent = v.fmt(v.lo);
                        cbMax.textContent = v.fmt(v.hi);
                    }
                }
                return api;
            },
            setEmptyText: function (t) { emptyEl.textContent = t; return api; },
            addOverlay: function (fn) { S.overlays.push(fn); return api; },
            draw: draw,
            geom: function () { return S.geom; },
            pointer: function () { return S.pointer; },
            setReadout: function (t) { readout.textContent = t || S.hint; return api; },
            setHint: function (t) { S.hint = t || ''; return api; },
            setTitle: function (t, right) { titleText.textContent = t || ''; titleRight.textContent = right || ''; return api; },
            setAria: function (t) { canvas.setAttribute('aria-label', t); return api; },
            onHover: function (fn) { hoverFns.push(fn); return api; },
            onClick: function (fn) { clickFns.push(fn); return api; },
            onPaint: function (fn) { paintFns.push(fn); return api; }
        };
        return api;
    }

    /* ---------- trajectory geometry, cached per acquisition ----------
       One entry per readout: its end points in k (cycles/m), a decimated
       polyline when it is not straight (ramp sampling, curved
       trajectories), and the excitation it belongs to (to join the
       echoes of one echo train, as in EPI). */
    let trajCache = { acq: null, segs: null };
    function trajSegments(acq) {
        if (trajCache.acq === acq) return trajCache.segs;
        const segs = [];
        (acq && acq.readouts || []).forEach(function (r) {
            const n = Math.min(r.kx ? r.kx.length : 0, r.ky ? r.ky.length : 0);
            if (n < 1) { segs.push(null); return; }
            const x0 = r.kx[0], y0 = r.ky[0], x1 = r.kx[n - 1], y1 = r.ky[n - 1];
            const L = Math.hypot(x1 - x0, y1 - y0);
            let pts = null;
            if (n > 2 && L > 0) {
                // straight if every sample lies within 0.2 % of the length of the chord
                let dev = 0;
                const step = Math.max(1, Math.floor(n / 16));
                for (let j = step; j < n - 1; j += step) {
                    const t = j / (n - 1), ex = x0 + (x1 - x0) * t, ey = y0 + (y1 - y0) * t;
                    dev = Math.max(dev, Math.hypot(r.kx[j] - ex, r.ky[j] - ey));
                }
                if (dev > 0.002 * L) {
                    pts = [];
                    const st = Math.max(1, Math.floor(n / 96));
                    for (let j = 0; j < n; j += st) pts.push(r.kx[j], r.ky[j]);
                    pts.push(x1, y1);
                }
            }
            segs.push({ x0: x0, y0: y0, x1: x1, y1: y1, pts: pts, tExc: r.tExc });
        });
        trajCache = { acq: acq, segs: segs };
        return segs;
    }

    /* ============================================================
       The tab
       ============================================================ */
    const T = {
        visible: false,
        mode: 'log', coil: 0, showMask: false, showTraj: false, showTime: false,
        result: null,            // the ReconResult on display (state.reconResult)
        disp: null,              // kValues() of the main view
        dirty: true,             // main display arrays need rebuilding
        sel: null,               // {dix, diy}: selected point, as offsets from k = 0
        hover: null,             // {ix, iy}
        playing: false, playDone: null,
        maskOff: null, maskFor: null,
        // editing
        edit: { key: '', nx: 0, ny: 0, mask: null, shape: null, painting: false, brushVal: 0, last: null },
        radius: 0, brush: 0,
        base: null, baseFor: null,      // unmasked ReconResult when the Image tab uses an edit
        preview: null, previewDirty: true,
        editDirty: true, removedOff: null, removedDirty: true,
        clearedKey: '',
        logWin: null             // log window of the last complete scan {key, lo, hi}
    };
    let V = null;            // DOM references, filled in mount

    function isCart(r) { return !!(r && r.info && r.info.cartesian !== false); }
    function coilCount(r) { return r && r.kspace && r.kspace.re ? r.kspace.re.length : 0; }

    /* ----- main view ----- */
    function rebuildMain() {
        const r = T.result;
        T.dirty = false;
        if (!r || !r.kspace) { T.disp = null; V.kv.setImage(null, null); V.kv.setEmptyText('No k-space yet: press Acquire.'); return; }
        const k = r.kspace;
        if (T.coil >= coilCount(r)) T.coil = 0;
        const mode = T.showTime ? 'time' : T.mode;
        T.disp = kValues(k, T.coil, mode, isCart(r));
        /* While a scan plays back, the centre of k-space may not have been
           recorded yet, and an automatic window would make the outer lines
           look as strong as the centre. Keep the log window of the last
           complete scan on this grid instead, so the picture fills in with
           its true proportions. */
        if (T.disp && mode === 'log') {
            const key = gridKey(k) + '|' + T.coil;
            if (state().scanning && T.logWin && T.logWin.key === key) { T.disp.lo = T.logWin.lo; T.disp.hi = T.logWin.hi; }
            else if (!state().scanning) T.logWin = { key: key, lo: T.disp.lo, hi: T.disp.hi };
        }
        V.kv.setEmptyText(state().scanning ? 'Waiting for the first readouts...' : 'No samples on the grid.');
        V.kv.setImage(k, T.disp);
        // the sampled-points tint
        if (!T.maskOff) T.maskOff = doc.createElement('canvas');
        if (T.maskFor !== k.mask && k.mask) { paintMask(T.maskOff, k.mask, k.nx, k.ny, 1, [56, 189, 248, 120]); T.maskFor = k.mask; }
        const nC = coilCount(r);
        const sub = (T.showTime ? 'time since excitation' : ({ log: 'log magnitude', phase: 'phase', real: 'real part', imag: 'imaginary part' })[T.mode]) +
            (nC > 1 ? ', coil ' + (T.coil + 1) + ' of ' + nC : '');
        V.kv.setTitle('k-space, ' + k.nx + ' × ' + k.ny + ' grid', sub);
        V.kv.setAria('k-space of ' + (nC > 1 ? 'coil ' + (T.coil + 1) : 'the receive coil') + ', ' + sub + ', ' + k.nx + ' by ' + k.ny +
            ' points. Hover for values, click a point to see its stripe pattern; arrow keys move the selected point.');
    }

    function drawMain() {
        if (!V) return;
        if (T.dirty) rebuildMain();
        V.kv.draw();
        drawProfile();
        updateReadout();
    }
    const requestMain = frameThrottle(function () { if (T.visible) drawMain(); });
    const requestOverlay = frameThrottle(function () { if (T.visible && V) { V.kv.draw(); } });

    function trajCount(r) {
        const acq = state().acq;
        if (!acq || !acq.readouts) return 0;
        if (T.playing && T.playDone !== null) return Math.min(T.playDone, acq.readouts.length);
        if (r && r.info && isFinite(r.info.nReadouts)) return Math.min(r.info.nReadouts, acq.readouts.length);
        return acq.readouts.length;
    }

    function overlayMain(ctx, g) {
        const r = T.result;
        if (!r || !r.kspace) return;
        const k = r.kspace;
        if (T.showMask && T.maskOff && T.maskFor === k.mask) {
            ctx.save(); ctx.imageSmoothingEnabled = false;
            ctx.drawImage(T.maskOff, 0, 0, k.nx, k.ny, g.left, g.top, g.pw, g.ph);
            ctx.restore();
        }
        const acq = state().acq;
        if (T.showTraj && acq) drawTrajectory(ctx, g, acq, trajCount(r));
        // the readout under the pointer, so the student sees which line a sample came from
        if (T.hover && T.hover.readout !== null && acq) {
            const segs = trajSegments(acq), s = segs[T.hover.readout];
            if (s) {
                ctx.save();
                ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
                ctx.beginPath(); traceSeg(ctx, g, s); ctx.stroke();
                ctx.restore();
            }
        }
        if (T.sel) {
            const p = selIndex(k);
            if (p) {
                const x = g.ix2x(p.ix), y = g.iy2y(p.iy), rad = Math.max(5, 0.8 * Math.max(g.sx, g.sy) + 3);
                const col = U.cssVar('--sc4', '#c98500');
                ctx.save();
                ctx.lineWidth = 2; ctx.strokeStyle = '#000';
                ctx.beginPath(); ctx.arc(x, y, rad + 1, 0, 2 * PI); ctx.stroke();
                ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.75;
                ctx.beginPath(); ctx.arc(x, y, rad, 0, 2 * PI); ctx.stroke();
                // the mirror partner at -k (conjugate symmetry for a real object)
                const mx = g.ix2x(2 * g.cx - p.ix), my = g.iy2y(2 * g.cy - p.iy);
                if (p.dix || p.diy) {
                    ctx.setLineDash([3, 3]); ctx.strokeStyle = col; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(mx, my, rad, 0, 2 * PI); ctx.stroke();
                }
                ctx.restore();
            }
        }
    }

    function traceSeg(ctx, g, s) {
        if (s.pts) {
            ctx.moveTo(g.kx2x(s.pts[0]), g.ky2y(s.pts[1]));
            for (let j = 2; j < s.pts.length; j += 2) ctx.lineTo(g.kx2x(s.pts[j]), g.ky2y(s.pts[j + 1]));
        } else {
            ctx.moveTo(g.kx2x(s.x0), g.ky2y(s.y0));
            ctx.lineTo(g.kx2x(s.x1), g.ky2y(s.y1));
        }
    }

    /* The nominal trajectory of the readouts acquired so far, coloured
       by acquisition order (blue first, yellow last), the echoes of one
       echo train joined by faint dashes (the blips of EPI, the refocusing
       of TSE), arrows for the readout direction when there is room, and
       the newest readout in white during playback. */
    function drawTrajectory(ctx, g, acq, n) {
        const segs = trajSegments(acq);
        n = Math.min(n, segs.length);
        if (!n) return;
        const lut = U.colormapLUT('viridis');
        const bins = Math.min(24, n);
        ctx.save();
        ctx.lineCap = 'round';
        // joins within an echo train
        ctx.strokeStyle = 'rgba(214,221,232,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath();
        for (let i = 1; i < n; i++) {
            const a = segs[i - 1], b = segs[i];
            if (!a || !b || !(a.tExc === b.tExc)) continue;
            ctx.moveTo(g.kx2x(a.x1), g.ky2y(a.y1)); ctx.lineTo(g.kx2x(b.x0), g.ky2y(b.y0));
        }
        ctx.stroke();
        ctx.setLineDash([]);
        const total = segs.length;
        // Typical distance on screen between one readout and the next (start to
        // start, or end to start for a back-and-forth echo train such as EPI).
        const gaps = [];
        for (let i = 1; i < Math.min(n, 97); i++) {
            const a = segs[i - 1], c = segs[i];
            if (!a || !c) continue;
            const sx0 = g.kx2x(c.x0), sy0 = g.ky2y(c.y0);
            gaps.push(Math.min(Math.hypot(sx0 - g.kx2x(a.x0), sy0 - g.ky2y(a.y0)), Math.hypot(sx0 - g.kx2x(a.x1), sy0 - g.ky2y(a.y1))));
        }
        gaps.sort(function (p, q) { return p - q; });
        const gap = gaps.length ? Math.max(0.5, gaps[gaps.length >> 1]) : 10;
        const dense = gap < 3;
        ctx.lineWidth = dense ? 0.8 : 1.2;
        ctx.globalAlpha = dense ? 0.55 : 0.85;
        for (let b = 0; b < bins; b++) {
            const i0 = Math.floor(b * n / bins), i1 = Math.floor((b + 1) * n / bins);
            if (i1 <= i0) continue;
            const t = 0.3 + 0.7 * ((i0 + i1) / 2) / Math.max(1, total - 1);
            const li = Math.round(U.clamp(t, 0, 1) * 255) * 3;
            ctx.strokeStyle = 'rgb(' + lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2] + ')';
            ctx.beginPath();
            for (let i = i0; i < i1; i++) if (segs[i]) traceSeg(ctx, g, segs[i]);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // Readout direction: arrowheads on every stride-th readout, at least
        // 16 px apart. The stride is odd so that alternating directions (EPI)
        // still show as alternating arrows.
        let stride = Math.max(1, Math.ceil(16 / gap));
        if (stride % 2 === 0) stride++;
        if (n / stride <= 160) {
            ctx.fillStyle = 'rgba(255,255,255,0.8)';
            for (let i = 0; i < n; i += stride) {
                const sg = segs[i];
                if (!sg) continue;
                const x0 = g.kx2x(sg.x0), y0 = g.ky2y(sg.y0), x1 = g.kx2x(sg.x1), y1 = g.ky2y(sg.y1);
                const L = Math.hypot(x1 - x0, y1 - y0);
                if (L < 24) continue;
                const ux = (x1 - x0) / L, uy = (y1 - y0) / L, f = 0.72 + 0.12 * ((i / stride) % 2), ax = x0 + ux * L * f, ay = y0 + uy * L * f;
                ctx.beginPath();
                ctx.moveTo(ax + ux * 4.5, ay + uy * 4.5);
                ctx.lineTo(ax - ux * 3 - uy * 3, ay - uy * 3 + ux * 3);
                ctx.lineTo(ax - ux * 3 + uy * 3, ay - uy * 3 - ux * 3);
                ctx.closePath(); ctx.fill();
            }
        }
        if (T.playing && n > 0 && segs[n - 1]) {
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.25;
            ctx.beginPath(); traceSeg(ctx, g, segs[n - 1]); ctx.stroke();
        }
        ctx.restore();
    }

    /* Selected point as grid indices on the current grid (clamped). */
    function selIndex(k) {
        if (!T.sel || !k) return null;
        const cx = k.nx >> 1, cy = k.ny >> 1;
        const ix = U.clamp(cx + T.sel.dix, 0, k.nx - 1), iy = U.clamp(cy + T.sel.diy, 0, k.ny - 1);
        return { ix: ix, iy: iy, dix: ix - cx, diy: iy - cy };
    }

    /* ----- hover readout ----- */
    function sampleInfo(r, ix, iy) {
        const k = r.kspace, p = iy * k.nx + ix, c = Math.min(T.coil, k.re.length - 1);
        const re = k.re[c][p], im = k.im[c][p];
        const cart = isCart(r);
        const acquired = cart ? k.mask[p] === 1 : (re !== 0 || im !== 0);
        const kx = (ix - (k.nx >> 1)) * k.dkx, ky = (iy - (k.ny >> 1)) * k.dky;
        let ro = null;
        if (k.order && isFinite(k.order[p])) ro = k.order[p] | 0;
        return { p: p, kx: kx, ky: ky, re: re, im: im, mag: Math.hypot(re, im), phase: Math.atan2(im, re),
            t: k.tmap ? k.tmap[p] : NaN, acquired: acquired, sampled: k.mask ? k.mask[p] === 1 : acquired, readout: ro };
    }
    function varsText(vars) {
        if (!vars) return '';
        const keys = Object.keys(vars);
        if (!keys.length) return '';
        return keys.map(function (kk) { return kk + ' = ' + vars[kk]; }).join(', ');
    }
    function updateReadout() {
        const r = T.result;
        if (!r || !r.kspace || !T.hover) { V.kv.setReadout(''); return; }
        const h = T.hover, s = sampleInfo(r, h.ix, h.iy);
        let t = 'kx ' + fk(s.kx) + ', ky ' + fk(s.ky) + ' 1/mm';
        if (!s.acquired) { V.kv.setReadout(t + ' · not acquired'); return; }
        t += ' · |S| ' + fsig(s.mag) + ' · phase ' + signed(s.phase, 2) + ' rad';
        if (isFinite(s.t)) t += ' · ' + fms(s.t) + ' after excitation';
        const acq = state().acq;
        if (s.readout !== null && acq && acq.readouts) {
            const ro = acq.readouts[s.readout];
            t += ' · ' + (isCart(r) ? '' : 'nearest sample from ') + 'readout ' + (s.readout + 1) + ' of ' + acq.readouts.length;
            const vt = ro ? varsText(ro.vars) : '';
            if (vt) t += ' (' + vt + ')';
        }
        V.kv.setReadout(t);
    }

    /* ----- profile of the ky = 0 line ----- */
    function drawProfile() {
        const r = T.result;
        if (!r || !r.kspace || !V.profile) { if (V.profile) V.profile.draw([]); return; }
        const k = r.kspace, cy = k.ny >> 1, cx = k.nx >> 1, c = Math.min(T.coil, k.re.length - 1);
        const x = new Float64Array(k.nx), y = new Float64Array(k.nx), cart = isCart(r);
        const re = k.re[c], im = k.im[c];
        for (let ix = 0; ix < k.nx; ix++) {
            const p = cy * k.nx + ix;
            x[ix] = (ix - cx) * k.dkx / 1000;
            const m = Math.hypot(re[p], im[p]);
            const has = cart ? k.mask[p] === 1 : m > 0;
            y[ix] = has && m > 0 ? Math.log10(m) : NaN;
        }
        const markers = [];
        if (T.sel) { const p = selIndex(k); if (p && p.diy === 0) markers.push({ x: (p.ix - cx) * k.dkx / 1000, color: '#ffd166', label: 'selected' }); }
        if (T.hover) markers.push({ x: (T.hover.ix - cx) * k.dkx / 1000, color: 'var(--sc7)' });
        V.profile.draw([{ x: x, y: y, color: 'var(--sc1)', label: 'coil ' + (c + 1) }], { markers: markers, legend: false });
        V.profile.setTitle('Profile along ky = 0' + (coilCount(r) > 1 ? ' (coil ' + (c + 1) + ')' : ''));
    }

    /* ----- one sample, one stripe pattern ----- */
    function selectPoint(dix, diy, focus) {
        T.sel = { dix: dix, diy: diy };
        requestOverlay();
        drawProfileSoon();
        renderWave();
        if (focus && V.kv) V.kv.canvas.focus();
    }
    const drawProfileSoon = frameThrottle(function () { if (T.visible && V) drawProfile(); });

    function renderWave() {
        if (!V) return;
        const r = T.result;
        const k = r && r.kspace;
        const p = selIndex(k);
        V.waveInfo.textContent = '';
        if (!k || !p) {
            V.waveWell.hidden = true;
            V.waveInfo.appendChild(el('p', { class: 'ks-wave-empty', text: k
                ? 'Click any point of k-space (or use the buttons) to see the stripe pattern that sample adds to the image.'
                : 'Run a scan, then click a point of k-space to see the stripe pattern it stands for.' }));
            return;
        }
        V.waveWell.hidden = false;
        const s = sampleInfo(r, p.ix, p.iy);
        const img = r.image || {};
        const fovX = img.fovX || (1 / k.dkx), fovY = img.fovY || (1 / k.dky);
        const nxI = img.nx || k.nx, nyI = img.ny || k.ny;
        const dxPix = fovX / nxI, dyPix = fovY / nyI;
        const kx = s.kx, ky = s.ky, kk = Math.hypot(kx, ky);
        const lam = kk > 0 ? 1 / kk : Infinity;
        const phase = s.acquired && s.mag > 0 ? s.phase : 0;
        drawWave(kx, ky, phase, fovX, fovY, lam);

        // How far out is it, relative to the edge of k-space in that direction?
        const kxmax = (k.nx >> 1) * k.dkx, kymax = (k.ny >> 1) * k.dky;
        const rho = Math.hypot(kx / kxmax, ky / kymax);
        const pix = Math.sqrt(dxPix * dyPix);
        const c0 = sampleInfo(r, k.nx >> 1, k.ny >> 1);
        const rows = [
            ['Position (1/mm)', 'kx ' + fk(kx) + ', ky ' + fk(ky)],
            ['Cycles across the FOV', signed(kx * fovX, Math.abs(kx * fovX - Math.round(kx * fovX)) > 1e-6 ? 1 : 0) + ' along x, ' +
                signed(ky * fovY, Math.abs(ky * fovY - Math.round(ky * fovY)) > 1e-6 ? 1 : 0) + ' along y'],
            ['Wavelength 1/|k|', kk > 0 ? U.fmtNum(lam * 1e3, 3) + ' mm (' + U.fmtNum(lam / pix, 3) + ' px)' : 'infinite (uniform)']
        ];
        if (kk > 0) {
            // on screen y runs down, so positive ky points down
            const ang = Math.round(Math.abs(Math.atan2(ky, kx)) * 180 / PI);
            let dir;
            if (Math.abs(ky) < 1e-9) dir = (kx > 0 ? '+x' : '\u2212x') + ': vertical stripes';
            else if (Math.abs(kx) < 1e-9) dir = (ky > 0 ? '+y (down)' : '\u2212y (up)') + ': horizontal stripes';
            else dir = ang + '\u00b0 ' + (ky > 0 ? 'below' : 'above') + ' +x';
            rows.push(['Direction of k', dir]);
        }
        if (s.acquired) {
            rows.push(['|S|', fsig(s.mag), 'a.u.']);
            if (c0.acquired && c0.mag > 0 && kk > 0) rows.push(['Relative to k = 0', U.fmtNum(100 * s.mag / c0.mag, 2), '%']);
            rows.push(['Phase', signed(s.phase, 2), 'rad']);
        } else rows.push(['This sample', 'not acquired']);
        V.waveInfo.appendChild(w().statTable(rows, { compact: true }));

        let say;
        const half = isFinite(lam) ? U.fmtNum(lam * 500, 2) + ' mm' : '';
        if (kk === 0) say = 'This is k = 0: no phase has been wound across the object, so every spin adds in phase and this one number is the total signal. It sets the overall brightness of the image and, with its close neighbours, the contrast between large regions.';
        else if (rho < 0.12) say = 'A low spatial frequency: smooth shading over a few centimetres. The few samples near the centre carry most of the signal energy and set the contrast between large structures.';
        else if (rho < 0.5) say = 'A middle frequency: it outlines structures about ' + half + ' across (half a wavelength). It shapes objects but adds little to their overall brightness.';
        else if (rho < 0.97) say = 'A high spatial frequency: fine detail and sharp edges on the scale of ' + half + '. Its signal is weak, but without it edges blur.';
        else say = 'At the edge of k-space: about one cycle every two pixels along ' + (Math.abs(kx / kxmax) > Math.abs(ky / kymax) ? 'x' : 'y') +
            ' (half a wavelength, ' + half + ', is the finest detail this matrix can show' + (Math.abs(kx / kxmax) > 0.97 && Math.abs(ky / kymax) > 0.97 ? '; the corner holds the finest diagonal detail' : '') + ').';
        V.waveInfo.appendChild(el('p', { class: 'ks-wave-say', text: say }));
        if (!s.acquired) V.waveInfo.appendChild(el('p', { class: 'ks-hint', text: 'This point was not acquired, so this wave is missing from the image.' }));
        if (kk > 0) V.waveInfo.appendChild(el('p', { class: 'ks-hint', text: 'The stripes run across k. Drawn with this sample’s phase, which slides the stripes sideways. Its mirror partner at −k (dashed ring) has the conjugate value for a real object, so the pair adds a real stripe pattern 2|S| cos(2π k·r + φ).' }));
        const roAxis = r.info && r.info.readoutAxis;
        if ((roAxis === 'x' && k.dkx < 0.75 / fovX) || (roAxis === 'y' && k.dky < 0.75 / fovY)) {
            V.waveInfo.appendChild(el('p', { class: 'ks-hint', text: 'Along the readout (' + roAxis + ') the samples are 1/(2 FOV) apart because the readout is oversampled: the raw data cover twice the field of view, and the reconstruction crops the outer half.' }));
        }
        V.waveCanvas.setAttribute('aria-label', kk > 0
            ? 'Stripe pattern for kx ' + fk(kx) + ' and ky ' + fk(ky) + ' per mm: wavelength ' + U.fmtNum(lam * 1e3, 3) + ' mm across the ' + fmm(fovX) + ' field of view.'
            : 'Uniform field: the k = 0 sample.');
    }

    /* cos(2 pi (kx x + ky y) + phase) over the field of view, in grey,
       computed per device pixel with the separable identity
       cos(a + b) = cos a cos b - sin a sin b, plus an arrow along k one
       wavelength long (or a fixed length when lambda is tiny). */
    function drawWave(kx, ky, phase, fovX, fovY, lam) {
        const cv = V.waveCanvas, host = V.waveStage;
        const Wd = host.clientWidth;
        if (!Wd) return;
        const aspect = fovY / fovX;
        let cw = Wd, ch = Math.round(Wd * aspect);
        if (ch > 360) { ch = 360; cw = Math.round(ch / aspect); }
        const rr = U.setupCanvas(cv, cw, ch), ctx = rr.ctx;
        const bw = cv.width, bh = cv.height;
        const ca = new Float64Array(bw), sa = new Float64Array(bw), cb = new Float64Array(bh), sb = new Float64Array(bh);
        for (let u = 0; u < bw; u++) { const x = ((u + 0.5) / bw - 0.5) * fovX, a = 2 * PI * kx * x + phase; ca[u] = Math.cos(a); sa[u] = Math.sin(a); }
        for (let v = 0; v < bh; v++) { const y = ((v + 0.5) / bh - 0.5) * fovY, b = 2 * PI * ky * y; cb[v] = Math.cos(b); sb[v] = Math.sin(b); }
        const img = ctx.createImageData(bw, bh), px = img.data;
        for (let v = 0; v < bh; v++) {
            const o = v * bw * 4, c2 = cb[v], s2 = sb[v];
            for (let u = 0; u < bw; u++) {
                const val = ca[u] * c2 - sa[u] * s2;              // cos(a + b)
                const g = Math.round(127.5 + 112 * val);
                const j = o + 4 * u;
                px[j] = g; px[j + 1] = g; px[j + 2] = Math.min(255, g + 6); px[j + 3] = 255;
            }
        }
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.putImageData(img, 0, 0);
        ctx.restore();
        // arrow along k from the centre
        const kk = Math.hypot(kx, ky);
        const cxp = cw / 2, cyp = ch / 2;
        ctx.save();
        ctx.font = '600 12px ' + U.cssVar('--font-sans', 'system-ui, sans-serif');
        if (kk > 0) {
            const ux = kx / kk, uy = ky / kk;                       // screen: +y runs down, as in the image
            const pxPerM = cw / fovX;
            let len = lam * pxPerM, labelled = true;
            if (len > 0.42 * Math.min(cw, ch)) { len = 0.42 * Math.min(cw, ch); labelled = false; }
            if (len < 26) { len = 26; labelled = false; }
            const ex = cxp + ux * len, ey = cyp + uy * len;
            ctx.lineCap = 'round';
            ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.moveTo(cxp, cyp); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.moveTo(cxp, cyp); ctx.lineTo(ex, ey); ctx.stroke();
            ctx.fillStyle = '#ffd166';
            ctx.beginPath();
            ctx.moveTo(ex + ux * 6, ey + uy * 6);
            ctx.lineTo(ex - ux * 5 - uy * 5, ey - uy * 5 + ux * 5);
            ctx.lineTo(ex - ux * 5 + uy * 5, ey - uy * 5 - ux * 5);
            ctx.closePath(); ctx.fill();
            // label next to the arrow, on the side away from the head
            const lab = labelled ? 'λ = ' + U.fmtNum(lam * 1e3, 3) + ' mm' : 'k';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const tw = ctx.measureText(lab).width;
            const lx = U.clamp(ex + ux * (tw / 2 + 12), tw / 2 + 6, cw - tw / 2 - 6), ly = U.clamp(ey + uy * 16, 12, ch - 12);
            ctx.fillStyle = 'rgba(5,8,15,0.78)';
            ctx.fillRect(lx - tw / 2 - 5, ly - 9, tw + 10, 18);
            ctx.fillStyle = '#ffd166';
            ctx.fillText(lab, lx, ly);
        } else {
            const lab = 'k = 0: uniform';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            const tw = ctx.measureText(lab).width;
            ctx.fillStyle = 'rgba(5,8,15,0.78)'; ctx.fillRect(cxp - tw / 2 - 6, cyp - 10, tw + 12, 20);
            ctx.fillStyle = '#ffd166'; ctx.fillText(lab, cxp, cyp);
        }
        ctx.restore();
    }

    /* ============================================================
       Editing k-space
       ============================================================ */
    /* The unedited reconstruction: the main result, or (when the Image
       tab already uses an edit) the same data reconstructed without it.
       That extra reconstruction is cached per result and skipped during
       playback. */
    function baseResult() {
        const s = state(), r = s.reconResult;
        if (!r) return null;
        if (!s.recon || !s.recon.userMask) return r;
        if (T.baseFor === r && T.base) return T.base;
        if (s.scanning || !s.acq || !MRI.recon) return r;
        T.base = MRI.recon.run(s.acq, Object.assign({}, s.recon, { userMask: null }), upToOpts());
        T.baseFor = r;
        return T.base;
    }

    function kExtent(k) {
        const kxm = (k.nx >> 1) * k.dkx, kym = (k.ny >> 1) * k.dky;
        return { kxm: kxm, kym: kym, kmin: Math.min(kxm, kym), kmax: Math.hypot(kxm, kym), dk: Math.max(k.dkx, k.dky) };
    }

    /* A fresh, all-keep mask whenever the grid changes. */
    function ensureEditMask(k) {
        const key = gridKey(k);
        if (!k || T.edit.key === key) return false;
        T.edit = { key: key, nx: k.nx, ny: k.ny, dkx: k.dkx, dky: k.dky, mask: new Uint8Array(k.nx * k.ny).fill(1), shape: null, painting: false, brushVal: 0, last: null };
        T.removedDirty = true;
        // Keep the radii in physical units across scans when they still fit.
        const e = kExtent(k);
        if (!(T.radius >= e.dk && T.radius <= e.kmax)) T.radius = 0.15 * e.kmin;
        if (!(T.brush >= e.dk && T.brush <= 0.3 * e.kmin)) T.brush = Math.min(4 * e.dk, 0.3 * e.kmin);
        if (V) {
            // steps of 0.001 1/mm (1 cycle/m) read cleanly in the number box
            V.radius.setRange(e.dk, e.kmax, 1); V.radius.set(T.radius); T.radius = V.radius.get();
            V.brush.setRange(e.dk, 0.3 * e.kmin, 1); V.brush.set(T.brush); T.brush = V.brush.get();
            updateDerived();
        }
        return true;
    }

    function applyCentre(keep) {
        const E = T.edit;
        if (!E.mask) return;
        const cx = E.nx >> 1, cy = E.ny >> 1, r2 = T.radius * T.radius;
        for (let iy = 0; iy < E.ny; iy++) {
            const ky = (iy - cy) * E.dky, o = iy * E.nx;
            for (let ix = 0; ix < E.nx; ix++) {
                const kx = (ix - cx) * E.dkx;
                const inside = kx * kx + ky * ky <= r2;
                E.mask[o + ix] = (inside === keep) ? 1 : 0;
            }
        }
        E.shape = { kind: keep ? 'keep' : 'remove' };
        editChanged(true);
    }
    /* Keep one half of k-space plus a few lines past the centre, like a
       real partial-Fourier scan, which always records a little more than
       half so that the image phase can be estimated (n/16 lines here). */
    function applyHalf(side) {
        const E = T.edit;
        if (!E.mask) return;
        const cx = E.nx >> 1, cy = E.ny >> 1;
        const ovy = Math.max(2, Math.round(E.ny / 16)), ovx = Math.max(2, Math.round(E.nx / 16));
        for (let iy = 0; iy < E.ny; iy++) {
            for (let ix = 0; ix < E.nx; ix++) {
                let keep;
                if (side === 'top') keep = iy <= cy + ovy;
                else if (side === 'bottom') keep = iy >= cy - ovy;
                else if (side === 'left') keep = ix <= cx + ovx;
                else keep = ix >= cx - ovx;
                E.mask[iy * E.nx + ix] = keep ? 1 : 0;
            }
        }
        E.shape = { kind: 'half', side: side };
        editChanged(true);
    }
    function invertMask() {
        const m = T.edit.mask;
        if (!m) return;
        for (let i = 0; i < m.length; i++) m[i] = m[i] ? 0 : 1;
        T.edit.shape = T.edit.shape && (T.edit.shape.kind === 'keep' || T.edit.shape.kind === 'remove')
            ? { kind: T.edit.shape.kind === 'keep' ? 'remove' : 'keep' } : { kind: 'custom' };
        editChanged(true);
    }
    function resetMask() {
        if (!T.edit.mask) return;
        T.edit.mask.fill(1);
        T.edit.shape = null;
        editChanged(true);
    }
    /* One brush stamp at k (cycles/m). */
    function stamp(kx, ky, val) {
        const E = T.edit, r = T.brush;
        const cx = E.nx >> 1, cy = E.ny >> 1;
        const ix0 = Math.max(0, Math.floor((kx - r) / E.dkx) + cx), ix1 = Math.min(E.nx - 1, Math.ceil((kx + r) / E.dkx) + cx);
        const iy0 = Math.max(0, Math.floor((ky - r) / E.dky) + cy), iy1 = Math.min(E.ny - 1, Math.ceil((ky + r) / E.dky) + cy);
        const r2 = r * r;
        for (let iy = iy0; iy <= iy1; iy++) {
            const dy = (iy - cy) * E.dky - ky;
            for (let ix = ix0; ix <= ix1; ix++) {
                const dx = (ix - cx) * E.dkx - kx;
                if (dx * dx + dy * dy <= r2) E.mask[iy * E.nx + ix] = val;
            }
        }
    }
    function onPaint(p, phase) {
        const E = T.edit;
        if (!E.mask || !T.result) return;
        if (phase === 'start') {
            if (!p) return;
            E.painting = true;
            E.brushVal = V.brushMode.get() === 'keep' ? 1 : 0;
            if (!E.shape || E.shape.kind !== 'custom') E.shape = { kind: 'custom' };
            stamp(p.kx, p.ky, E.brushVal);
            E.last = { kx: p.kx, ky: p.ky };
            editChanged(false);
            return;
        }
        if (phase === 'move' && E.painting && p) {
            // fill the gap since the last event so fast strokes stay continuous
            const a = E.last || { kx: p.kx, ky: p.ky };
            const d = Math.hypot(p.kx - a.kx, p.ky - a.ky), step = Math.max(T.brush * 0.4, 1e-9);
            const n = Math.min(200, Math.ceil(d / step));
            for (let i = 1; i <= n; i++) stamp(a.kx + (p.kx - a.kx) * i / n, a.ky + (p.ky - a.ky) * i / n, E.brushVal);
            if (!n) stamp(p.kx, p.ky, E.brushVal);
            E.last = { kx: p.kx, ky: p.ky };
            editChanged(false);
            return;
        }
        if (phase === 'end' && E.painting) {
            E.painting = false; E.last = null;
            editChanged(true);
        }
    }

    function editChanged(commit) {
        T.removedDirty = true;
        requestEditDraw();
        updateEditStats();
        schedulePreview(commit);
    }

    /* ----- edit view ----- */
    function rebuildEditImage() {
        const b = baseResult();
        T.editDirty = false;
        if (!b || !b.kspace) { V.ev.setImage(null, null); return; }
        ensureEditMask(b.kspace);
        const v = kValues(b.kspace, Math.min(T.coil, coilCount(b) - 1), 'log', isCart(b));
        V.ev.setImage(b.kspace, v);
        V.ev.setTitle('Edit on this copy', coilCount(b) > 1 ? 'log magnitude, coil ' + (Math.min(T.coil, coilCount(b) - 1) + 1) : 'log magnitude');
        T.removedDirty = true;
    }
    function overlayEdit(ctx, g) {
        const E = T.edit;
        if (!E.mask || E.nx !== g.nx || E.ny !== g.ny) return;
        if (!T.removedOff) T.removedOff = doc.createElement('canvas');
        if (T.removedDirty) { paintMask(T.removedOff, E.mask, E.nx, E.ny, 0, [60, 8, 14, 205]); T.removedDirty = false; }
        ctx.save(); ctx.imageSmoothingEnabled = false;
        ctx.drawImage(T.removedOff, 0, 0, E.nx, E.ny, g.left, g.top, g.pw, g.ph);
        ctx.restore();
        // the centre-radius circle while a centre tool is in use
        if (E.shape && (E.shape.kind === 'keep' || E.shape.kind === 'remove')) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,209,102,0.85)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.ellipse(g.kx2x(0), g.ky2y(0), T.radius / g.dkx * g.sx, T.radius / g.dky * g.sy, 0, 0, 2 * PI);
            ctx.stroke();
            ctx.restore();
        }
        // brush outline under the pointer
        const p = V.ev.pointer();
        if (p && (p.inside || E.painting)) {
            ctx.save();
            ctx.strokeStyle = V.brushMode.get() === 'keep' ? 'rgba(74,222,128,0.95)' : 'rgba(248,113,113,0.95)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, T.brush / g.dkx * g.sx, T.brush / g.dky * g.sy, 0, 0, 2 * PI);
            ctx.stroke();
            ctx.restore();
        }
    }
    function drawEdit() {
        if (!V) return;
        if (T.editDirty) rebuildEditImage();
        V.ev.draw();
    }
    const requestEditDraw = frameThrottle(function () { if (T.visible) drawEdit(); });

    function updateDerived() {
        if (!V) return;
        const r = T.radius;
        V.radiusNote.textContent = r > 0 ? 'Keeping |k| ≤ ' + fk(r) + ' 1/mm acts like a scan with kmax = ' + fk(r) +
            ' 1/mm: resolution about 1/(2 kmax) = ' + U.fmtNum(1 / (2 * r) * 1e3, 3) + ' mm.' : '';
    }

    function updateEditStats() {
        if (!V) return;
        const b = baseResult(), E = T.edit;
        if (!b || !b.kspace || !E.mask || E.nx !== b.kspace.nx || E.ny !== b.kspace.ny) { V.pvStats.textContent = ''; return; }
        const k = b.kspace, cart = isCart(b), N = k.nx * k.ny;
        let nAll = 0, nKeep = 0, eAll = 0, eKeep = 0;
        for (let p = 0; p < N; p++) {
            let e = 0;
            for (let c = 0; c < k.re.length; c++) e += k.re[c][p] * k.re[c][p] + k.im[c][p] * k.im[c][p];
            const has = cart ? k.mask[p] === 1 : e > 0;
            if (!has) continue;
            nAll++; eAll += e;
            if (E.mask[p]) { nKeep++; eKeep += e; }
        }
        const unit = cart ? 'samples' : 'grid points';
        V.pvStats.textContent = nAll
            ? 'Kept ' + nKeep.toLocaleString('en-US') + ' of ' + nAll.toLocaleString('en-US') + ' ' + unit + ' (' + U.fmtNum(100 * nKeep / nAll, 3) +
              ' %), holding ' + U.fmtNum(eAll > 0 ? 100 * eKeep / eAll : 0, 4) + ' % of the signal energy Σ|S|².'
            : 'No samples recorded yet.';
    }

    /* ----- preview reconstruction ----- */
    let pvTimer = null, pvLast = 0, pvCost = 30;
    const LIVE_MS = 120;     // reconstructions slower than this wait for the release of a drag
    function schedulePreview(urgent) {
        if (!T.visible) { T.previewDirty = true; return; }
        // While dragging (a slider, the brush), a large matrix would block the
        // page for each preview: then wait until the gesture ends.
        if (!urgent && pvCost > LIVE_MS) {
            T.previewDirty = true;
            if (V) V.pvEdit.setTitle('Edited k-space (updates when you release)');
            return;
        }
        const gap = Math.max(110, 2.2 * pvCost);
        const wait = urgent ? 0 : Math.max(0, gap - (now() - pvLast));
        if (pvTimer) {
            if (!urgent) return;          // the queued run will read the newest mask
            clearTimeout(pvTimer);
        }
        pvTimer = setTimeout(function () { pvTimer = null; runPreview(); }, wait);
    }
    function percentileWindow(mag) {
        const hi = U.percentile(mag, 99.5);
        return { min: 0, max: hi > 0 ? hi : 1 };
    }
    function runPreview() {
        if (!V) return;
        T.previewDirty = false;
        const s = state(), acq = s.acq;
        const b = baseResult();
        updateApplyUI();
        if (!b || !acq || !MRI.recon) {
            V.pvAll.clear('No scan yet'); V.pvEdit.clear('No scan yet');
            V.pvNotes.textContent = ''; V.pf.hidden = true;
            return;
        }
        if (s.scanning) {
            V.pvEdit.clear('The preview updates when the scan finishes.');
            T.previewDirty = true;
            return;
        }
        ensureEditMask(b.kspace);
        const E = T.edit;
        const t0 = now();
        let res;
        if (!E.mask || allOnes(E.mask)) res = b;
        else if (s.recon && s.recon.userMask && sameMask(s.recon.userMask, E.mask) && s.reconResult) res = s.reconResult;
        else res = MRI.recon.run(acq, Object.assign({}, s.recon, { userMask: E.mask }), upToOpts());
        pvCost = now() - t0;
        pvLast = now();
        T.preview = res;
        const im0 = b.image, im1 = res.image;
        const wv = percentileWindow(im0.mag);
        V.pvAll.setData(im0.mag, im0.nx, im0.ny, { min: wv.min, max: wv.max, fovX: im0.fovX, fovY: im0.fovY });
        V.pvEdit.setData(im1.mag, im1.nx, im1.ny, { min: wv.min, max: wv.max, fovX: im1.fovX, fovY: im1.fovY });
        V.pvEdit.setTitle(res === b ? 'Edited k-space (no edits yet)' : 'Edited k-space');
        // the notes that say something about the edit (skip the routine ones)
        const skip = /^(Cartesian:|Non-Cartesian:|Readout oversampling|Coils combined|Showing coil|Radial:)/;
        const notes = (res.info && res.info.notes || []).filter(function (n) { return !skip.test(n); });
        V.pvNotes.textContent = '';
        notes.slice(0, 4).forEach(function (n) { V.pvNotes.appendChild(el('li', { text: n })); });
        V.pvNotes.hidden = !notes.length;
        const pfOn = !!(res.info && res.info.partialFourier < 1);
        V.pf.hidden = !pfOn;
        if (pfOn) V.pfSeg.set(s.recon.partialFourier || 'homodyne');
        updateEditStats();
    }

    function updateApplyUI() {
        if (!V) return;
        const s = state(), applied = s.recon && s.recon.userMask;
        const E = T.edit;
        const editsExist = !!(E.mask && !allOnes(E.mask));
        let msg, on = false;
        if (applied && E.mask && sameMask(applied, E.mask)) { msg = 'Applied: the Image tab reconstructs from this edited k-space.'; on = true; }
        else if (applied) msg = 'The Image tab uses an earlier edit. Apply to replace it, or Clear.';
        else msg = editsExist ? 'Not applied: the Image tab still uses all the data.' : 'No edits yet. The Image tab uses all the data.';
        V.applyStatus.textContent = msg;
        V.applyStatus.classList.toggle('is-on', on);
        V.applyBtn.disabled = !s.reconResult || (!editsExist && !applied) || (on);
        V.clearBtn.disabled = !applied;
        V.appliedBadge.hidden = !applied;
    }

    function applyToImage() {
        const E = T.edit;
        if (!E.mask) return;
        const m = allOnes(E.mask) ? null : Uint8Array.from(E.mask);
        MRI.actions.setRecon({ userMask: m });
        w().toast(m ? 'The Image tab now reconstructs from your edited k-space.' : 'The Image tab uses all the data again.', 'good');
        updateApplyUI();
    }
    function clearApplied() {
        MRI.actions.setRecon({ userMask: null });
        w().toast('Edit cleared: the Image tab uses all the data again.', 'info');
        updateApplyUI();
    }

    /* ============================================================
       Bus events
       ============================================================ */
    function onReconDone(e) {
        if (!e || !e.result) return;
        const s = state();
        T.result = e.result;
        T.dirty = true;
        T.editDirty = true;
        const k = e.result.kspace;
        const changed = k ? (gridKey(k) !== T.edit.key) : false;
        // An applied mask from another grid is ignored by recon.js; clear it so
        // the state says what the images show. Do it outside this handler.
        if (k && s.recon && s.recon.userMask && s.recon.userMask.length !== k.nx * k.ny && T.clearedKey !== gridKey(k)) {
            T.clearedKey = gridKey(k);
            setTimeout(function () {
                const r = state().reconResult;
                if (state().recon.userMask && r && r.kspace && state().recon.userMask.length !== r.kspace.nx * r.kspace.ny) {
                    MRI.actions.setRecon({ userMask: null });
                    w().toast('k-space edits were cleared: the new scan has a different k-space grid.', 'info');
                }
            }, 0);
        }
        if (changed && k) {
            ensureEditMask(k);
            T.hover = null;
        }
        ensureSelection();
        if (!T.visible) { T.previewDirty = true; return; }
        refreshCoilSelect();
        V.cartNote.hidden = !(e.result.info && e.result.info.cartesian === false);
        requestMain();
        requestEditDraw();
        renderWaveSoon();
        if (!s.scanning) schedulePreview(true); else { T.previewDirty = true; updateApplyUI(); }
    }
    const renderWaveSoon = frameThrottle(function () { if (T.visible) renderWave(); });

    function refreshCoilSelect() {
        if (!V) return;
        const r = T.result, n = coilCount(r);
        const acq = state().acq, names = acq && acq.coilSet && acq.coilSet.names;
        if (n > 1) {
            if (V.coilN !== n) {
                const opts = [];
                for (let c = 0; c < n; c++) opts.push({ value: c, label: (c + 1) + (names && names[c] ? ' · ' + names[c] : '') });
                V.coilSel.setOptions(opts, Math.min(T.coil, n - 1));
                V.coilN = n;
            }
            V.coilSel.hidden = false;
        } else { V.coilSel.hidden = true; V.coilN = n; T.coil = 0; }
    }

    /* ============================================================
       mount
       ============================================================ */
    function mount(panel) {
        const s = state(), A = MRI.actions, Wd = w();
        panel.textContent = '';

        // ---- concept card ----
        panel.appendChild(Wd.concept({
            title: 'k-space: the spectrum of spatial frequencies',
            body: '<p>The scanner never records an image. Each ADC sample is the signal of the whole slice after the gradients have wound a phase 2π k·r across it, so it measures how much of one stripe pattern the object contains: one point of its two-dimensional Fourier transform. The centre of k-space (broad stripes) carries the signal and the contrast; the edges (fine stripes) carry edges and detail.</p>' +
                '<p>The spacing of the samples sets the field of view, FOV = 1/Δk, and the furthest sample sets the pixel size, Δx = 1/(2 k<sub>max</sub>).</p>',
            formula: 'S(k<sub>x</sub>, k<sub>y</sub>) = ∬ m(x, y) e<sup>−i2π(k<sub>x</sub>x + k<sub>y</sub>y)</sup> dx dy, &nbsp; k(t) = γ̅ ∫<sub>0</sub><sup>t</sup> G(t′) dt′',
            tryThis: [
                { html: '<b>Keep only the centre</b> (a disk of about 15 % of k<sub>max</sub>): the contrast survives, the edges blur.', label: 'Do it', run: function () { tryCentre(true); } },
                { html: '<b>Remove the centre</b>: most of the signal goes, and only edges and fine detail remain.', label: 'Do it', run: function () { tryCentre(false); } },
                { html: '<b>Keep one half</b> (plus a few lines past the centre): homodyne recovers the image because a real object’s k-space is conjugate symmetric, S(−k) = S*(k). Switch the fill to Zero to see what it repairs.', label: 'Do it', run: function () { tryHalf(); } },
                { html: '<b>Click a corner sample</b>: the finest diagonal stripes this matrix can hold.', label: 'Show me', run: function () { pickNamed('corner', true); } }
            ]
        }));

        // ---- main panel ----
        const main = el('section', { class: 'panel', 'aria-labelledby': 'ks-title' });
        const appliedBadge = el('span', { class: 'badge badge-warn', hidden: true, title: 'The Image tab reconstructs from an edited k-space mask, so this view shows the edited data.' }, 'Edited k-space applied');
        const headClear = Wd.button({ label: 'Use all data', size: 'xs', onClick: clearApplied, title: 'Clear the applied k-space edit' });
        const appliedWrap = el('span', { class: 'ks-head-badges', hidden: true }, [appliedBadge, headClear]);
        main.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ks-title', text: 'Raw data on the k-space grid' }),
            el('span', { class: 'panel-sub', text: 'Hover for values, click a point to see its wave.' }),
            el('span', { class: 'spacer' }), appliedWrap
        ]));

        const toolbar = el('div', { class: 'ks-toolbar' });
        const modeSeg = Wd.segmented({
            ariaLabel: 'k-space display', value: T.mode, size: 'sm',
            options: [
                { value: 'log', label: 'log |S|', title: 'Log magnitude: the only way to see the weak edges next to the strong centre' },
                { value: 'phase', label: 'Phase', title: 'Phase of each sample, -pi to +pi rad' },
                { value: 'real', label: 'Real', title: 'Real part (signed), window clipped at the 99th percentile' },
                { value: 'imag', label: 'Imag', title: 'Imaginary part (signed), window clipped at the 99th percentile' }
            ],
            onChange: function (v) { T.mode = v; if (T.showTime) { T.showTime = false; timeTog.set(false); } T.dirty = true; requestMain(); }
        });
        const coilSel = Wd.select({ label: 'Coil', inline: true, options: [{ value: 0, label: '1' }], value: 0,
            hint: 'Each receive coil records its own k-space',
            onChange: function (v) { T.coil = +v || 0; T.dirty = true; T.editDirty = true; requestMain(); requestEditDraw(); renderWave(); } });
        coilSel.hidden = true;
        const maskTog = Wd.toggle({ label: 'Sampled points', checked: T.showMask, hint: 'Tint every grid point that holds a recorded sample',
            onChange: function (b) { T.showMask = b; requestOverlay(); } });
        const trajTog = Wd.toggle({ label: 'Trajectory', checked: T.showTraj, hint: 'The nominal k-space path of each readout, coloured from first (blue) to last (yellow) acquired',
            onChange: function (b) { T.showTraj = b; requestOverlay(); } });
        const timeTog = Wd.toggle({ label: 'Time since excitation', checked: T.showTime, hint: 'Colour every sample by the time between its excitation and the moment it was recorded',
            onChange: function (b) { T.showTime = b; T.dirty = true; requestMain(); timeNote.hidden = !b; } });
        toolbar.appendChild(el('div', { class: 'ctl-inline' }, [el('span', { class: 'ctl-label', text: 'Show' }), modeSeg]));
        toolbar.appendChild(coilSel);
        toolbar.appendChild(el('div', { class: 'ks-overlays', role: 'group', 'aria-label': 'Overlays' }, [maskTog, trajTog, timeTog]));
        main.appendChild(toolbar);
        const timeNote = el('p', { class: 'note mt-0', hidden: !T.showTime, html:
            'Colour = time from the excitation to each sample. The samples at the centre of k-space set the contrast, so the time at which they were recorded is the <b>effective TE</b>. ' +
            'In a turbo spin echo the outer lines are recorded at other echo times, so the T2 weighting changes across k-space; in EPI all of k-space follows one excitation, line by line, so the time grows along ky.' });
        main.appendChild(timeNote);

        const split = el('div', { class: 'split' });
        const mainCol = el('div', { class: 'ks-main' });
        const side = el('aside', { class: 'ks-side', 'aria-label': 'One sample, one stripe pattern' });
        split.appendChild(mainCol); split.appendChild(side);
        main.appendChild(split);

        const kv = createKView(mainCol, {
            axes: true, focusable: true, title: 'k-space',
            maxHeight: function () { return Math.max(260, Math.min(560, (root.innerHeight || 900) * 0.66)); },
            empty: 'No k-space yet: press Acquire.'
        });
        kv.addOverlay(overlayMain);
        kv.setHint('Hover over k-space for kx, ky, |S|, phase and when the sample was recorded.');
        kv.setReadout('');
        kv.onHover(function (p) {
            const r = T.result;
            if (!p || !r || !r.kspace) { if (T.hover) { T.hover = null; requestOverlay(); drawProfileSoon(); } kv.setReadout(''); return; }
            const si = sampleInfo(r, p.ix, p.iy);
            const prev = T.hover;
            T.hover = { ix: p.ix, iy: p.iy, readout: si.acquired ? si.readout : null };
            updateReadout();
            if (!prev || prev.ix !== p.ix || prev.iy !== p.iy) { requestOverlay(); drawProfileSoon(); }
        });
        kv.onClick(function (p) {
            const k = T.result && T.result.kspace;
            if (!k) return;
            selectPoint(p.ix - (k.nx >> 1), p.iy - (k.ny >> 1), false);
        });
        kv.canvas.addEventListener('keydown', function (ev) {
            const k = T.result && T.result.kspace;
            if (!k) return;
            const step = ev.shiftKey ? 4 : 1;
            let p = selIndex(k) || { dix: 0, diy: 0 };
            let dix = p.dix, diy = p.diy;
            if (ev.key === 'ArrowLeft') dix -= step;
            else if (ev.key === 'ArrowRight') dix += step;
            else if (ev.key === 'ArrowUp') diy -= step;
            else if (ev.key === 'ArrowDown') diy += step;
            else if (ev.key === 'Home') { dix = 0; diy = 0; }
            else return;
            ev.preventDefault();
            const cx = k.nx >> 1, cy = k.ny >> 1;
            dix = U.clamp(dix, -cx, k.nx - 1 - cx); diy = U.clamp(diy, -cy, k.ny - 1 - cy);
            selectPoint(dix, diy, false);
            const si = sampleInfo(T.result, cx + dix, cy + diy);
            T.hover = { ix: cx + dix, iy: cy + diy, readout: si.acquired ? si.readout : null };
            updateReadout();
        });
        const cartNote = el('p', { class: 'simplification', hidden: true, text: 'Non-Cartesian data are shown after gridding: each sample was spread onto the grid with a smooth kernel, so this picture is slightly smoothed and the gaps between spokes are partly filled.' });
        mainCol.appendChild(cartNote);
        const profHost = el('div');
        mainCol.appendChild(profHost);
        const profile = Wd.plot(profHost, { height: 170, xlabel: 'kx (1/mm)', ylabel: 'log₁₀ |S|', scope: true, title: 'Profile along ky = 0' });

        // ---- side: one sample, one stripe pattern ----
        side.appendChild(el('h3', { class: 'panel-title', text: 'One sample, one stripe pattern' }));
        const picks = el('div', { class: 'ks-picks', role: 'group', 'aria-label': 'Choose a k-space point' }, [
            el('span', { class: 'ks-picks-label', text: 'Pick:' }),
            Wd.button({ label: 'k = 0', size: 'xs', onClick: function () { pickNamed('centre'); } }),
            Wd.button({ label: 'Low', size: 'xs', onClick: function () { pickNamed('low'); } }),
            Wd.button({ label: 'Middle', size: 'xs', onClick: function () { pickNamed('middle'); } }),
            Wd.button({ label: 'Edge', size: 'xs', onClick: function () { pickNamed('edge'); } }),
            Wd.button({ label: 'Corner', size: 'xs', onClick: function () { pickNamed('corner'); } })
        ]);
        side.appendChild(picks);
        const waveStage = el('div', { class: 'ks-wave-stage' });
        const waveCanvas = el('canvas', { class: 'ks-wave-canvas', role: 'img', 'aria-label': 'Stripe pattern of the selected k-space sample' });
        waveStage.appendChild(waveCanvas);
        const waveWell = el('figure', { class: 'well ks-wave-well', hidden: true }, [
            el('figcaption', { class: 'well-title' }, [el('span', { text: 'Its wave across the field of view' })]), waveStage
        ]);
        side.appendChild(waveWell);
        const waveInfo = el('div', { class: 'stack stack-sm', 'aria-live': 'polite' });
        side.appendChild(waveInfo);
        panel.appendChild(main);

        // ---- edit panel ----
        const ed = el('section', { class: 'panel', 'aria-labelledby': 'ks-edit-title' });
        ed.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ks-edit-title', text: 'Edit k-space, watch the image' }),
            el('span', { class: 'panel-sub', text: 'Throw samples away and see what the image loses. Nothing changes in the Image tab until you apply.' })
        ]));
        // canvas and tools on the left, previews on the right; on a phone the
        // previews come straight after the canvas so painting and its effect
        // stay on one screen
        const edSplit = el('div', { class: 'ks-edit-grid' });
        const edLeft = el('div', { class: 'stack ks-edit-canvas' }), edRight = el('div', { class: 'stack ks-edit-preview' });
        const edTools = el('div', { class: 'ks-edit-tools' });
        edSplit.appendChild(edLeft); edSplit.appendChild(edRight); edSplit.appendChild(edTools);
        ed.appendChild(edSplit);

        const ev = createKView(edLeft, {
            cls: 'kv-edit', paint: true, colorbar: false, title: 'Edit on this copy',
            maxHeight: function () { return Math.max(220, Math.min(420, (root.innerHeight || 900) * 0.5)); },
            ariaLabel: 'Editable copy of k-space. Dark red areas are removed. Drag to paint with the brush.',
            empty: 'No k-space yet'
        });
        ev.addOverlay(overlayEdit);
        ev.setHint('Drag to paint with the brush. Dark red = thrown away.');
        ev.setReadout('');
        ev.onPaint(onPaint);
        ev.onHover(function () { requestEditDraw(); });
        ev.canvas.addEventListener('pointerleave', function () { requestEditDraw(); });

        const tools = el('div', { class: 'ks-tools' });
        const radius = Wd.slider({ label: 'Centre radius', unit: '1/mm', scale: 0.001, min: 1, max: 300, step: 1, value: 40,
            hint: 'Radius of the disk around k = 0 used by Keep centre and Remove centre',
            onInput: function (v) { T.radius = v; updateDerived(); reapplyCentre(false); },
            onChange: function (v) { T.radius = v; updateDerived(); reapplyCentre(true); } });
        const radiusNote = el('p', { class: 'ks-derived' });
        tools.appendChild(el('div', { class: 'ks-tool-row' }, [
            el('span', { class: 'ks-tool-label', text: 'Centre' }),
            Wd.button({ label: 'Keep centre', size: 'sm', onClick: function () { applyCentre(true); }, title: 'Keep only the samples within the radius of k = 0' }),
            Wd.button({ label: 'Remove centre', size: 'sm', onClick: function () { applyCentre(false); }, title: 'Throw away the samples within the radius of k = 0' })
        ]));
        tools.appendChild(radius);
        tools.appendChild(radiusNote);
        const halfGroup = el('div', { class: 'btn-group', role: 'group', 'aria-label': 'Keep one half of k-space' }, ['top', 'bottom', 'left', 'right'].map(function (side2) {
            return Wd.button({ label: side2.charAt(0).toUpperCase() + side2.slice(1), size: 'sm',
                title: 'Keep the ' + side2 + ' half of k-space plus a few lines past the centre', onClick: function () { applyHalf(side2); } });
        }));
        tools.appendChild(el('div', { class: 'ks-tool-row' }, [el('span', { class: 'ks-tool-label', text: 'Keep half' }), halfGroup]));
        const brushMode = Wd.segmented({ ariaLabel: 'Brush action', size: 'sm', value: 'erase',
            options: [{ value: 'erase', label: 'Erase' }, { value: 'keep', label: 'Keep' }],
            onChange: function () { requestEditDraw(); } });
        tools.appendChild(el('div', { class: 'ks-tool-row' }, [el('span', { class: 'ks-tool-label', text: 'Brush' }), brushMode,
            el('span', { class: 'ks-hint', text: 'drag on the copy above' })]));
        const brush = Wd.slider({ label: 'Brush radius', unit: '1/mm', scale: 0.001, min: 1, max: 100, step: 1, value: 10,
            hint: 'Radius of the brush in k-space',
            onInput: function (v) { T.brush = v; requestEditDraw(); }, onChange: function (v) { T.brush = v; } });
        tools.appendChild(brush);
        tools.appendChild(el('div', { class: 'ks-tool-row' }, [
            Wd.button({ label: 'Invert', size: 'sm', onClick: invertMask, title: 'Keep what was removed and remove what was kept' }),
            Wd.button({ label: 'Reset', size: 'sm', kind: 'ghost', onClick: resetMask, title: 'Keep everything again' })
        ]));
        edTools.appendChild(tools);

        const pvGrid = el('div', { class: 'image-grid ks-pv-grid' });
        edRight.appendChild(pvGrid);
        const pvAll = Wd.imageView(pvGrid, { title: 'All data', empty: 'No scan yet' });
        const pvEdit = Wd.imageView(pvGrid, { title: 'Edited k-space', empty: 'No scan yet' });
        const pvStats = el('p', { class: 'ks-pv-stats', 'aria-live': 'polite' });
        edRight.appendChild(pvStats);
        edRight.appendChild(el('p', { class: 'ks-hint', text: 'Both images share one window, so a darker edited image really has less signal. Drag on an image to change the window; double-click to reset.' }));
        const pfSeg = Wd.segmented({ ariaLabel: 'Fill the missing part by', size: 'sm', value: s.recon.partialFourier || 'homodyne',
            options: [{ value: 'zero', label: 'Zero' }, { value: 'conjugate', label: 'Conjugate' }, { value: 'homodyne', label: 'Homodyne' }],
            onChange: function (v) { A.setRecon({ partialFourier: v }); } });
        const pf = el('div', { class: 'ks-pf', hidden: true }, [
            el('span', { class: 'ctl-label', text: 'Missing half filled by' }), pfSeg,
            el('span', { class: 'ks-hint', text: '(the Image tab’s partial-Fourier setting; it acts along the phase-encode direction only)' })
        ]);
        edRight.appendChild(pf);
        const pvNotes = el('ul', { class: 'note ks-pv-notes', hidden: true });
        edRight.appendChild(pvNotes);
        const applyBtn = Wd.button({ label: 'Apply to Image tab', kind: 'primary', size: 'sm', onClick: applyToImage });
        const clearBtn = Wd.button({ label: 'Clear', size: 'sm', onClick: clearApplied, title: 'Let the Image tab use all the data again' });
        const applyStatus = el('span', { class: 'ks-apply-status', 'aria-live': 'polite' });
        edRight.appendChild(el('div', { class: 'ks-apply-row' }, [applyBtn, clearBtn, applyStatus]));
        panel.appendChild(ed);

        V = { panel: panel, kv: kv, ev: ev, profile: profile, modeSeg: modeSeg, coilSel: coilSel, coilN: -1, maskTog: maskTog, trajTog: trajTog, timeTog: timeTog,
            timeNote: timeNote, cartNote: cartNote, waveWell: waveWell, waveStage: waveStage, waveCanvas: waveCanvas, waveInfo: waveInfo,
            radius: radius, radiusNote: radiusNote, brush: brush, brushMode: brushMode, pvAll: pvAll, pvEdit: pvEdit, pvStats: pvStats,
            pf: pf, pfSeg: pfSeg, pvNotes: pvNotes, applyBtn: applyBtn, clearBtn: clearBtn, applyStatus: applyStatus,
            appliedBadge: appliedWrap, edPanel: ed };

        // ---- bus ----
        const bus = MRI.bus;
        bus.on('recon:done', onReconDone);
        bus.on('scan:start', function (e) {
            T.playing = !!(e && e.animate);
            T.playDone = T.playing ? 0 : null;
            T.base = null; T.baseFor = null;
            if (T.visible) updateApplyUI();
        });
        bus.on('playback:tick', function (e) {
            if (!e) return;
            T.playing = true;
            T.playDone = e.readoutsDone;
            if (T.visible && T.showTraj) requestOverlay();
        });
        const endPlay = function () {
            T.playing = false; T.playDone = null;
            if (T.visible) { requestOverlay(); updateApplyUI(); }
            if (T.previewDirty) schedulePreview(true);
        };
        bus.on('scan:done', endPlay);
        bus.on('scan:error', endPlay);
        bus.on('theme:changed', function () {
            if (T.visible) { requestMain(); requestEditDraw(); renderWaveSoon(); }
        });
    }

    function reapplyCentre(commit) {
        const sh = T.edit.shape;
        if (sh && (sh.kind === 'keep' || sh.kind === 'remove')) applyCentreQuiet(sh.kind === 'keep', commit);
        else requestEditDraw();
    }
    function applyCentreQuiet(keep, commit) {
        const E = T.edit;
        if (!E.mask) return;
        const cx = E.nx >> 1, cy = E.ny >> 1, r2 = T.radius * T.radius;
        for (let iy = 0; iy < E.ny; iy++) {
            const ky = (iy - cy) * E.dky, o = iy * E.nx;
            for (let ix = 0; ix < E.nx; ix++) {
                const kx = (ix - cx) * E.dkx;
                E.mask[o + ix] = ((kx * kx + ky * ky <= r2) === keep) ? 1 : 0;
            }
        }
        editChanged(commit);
    }

    /* Named example points for the picker and the "try this" buttons. */
    function namedOffsets(name, r) {
        const k = r.kspace, cx = k.nx >> 1, cy = k.ny >> 1;
        const img = r.image || {};
        const fx = (img.fovX ? 1 / img.fovX : k.dkx) / k.dkx, fy = (img.fovY ? 1 / img.fovY : k.dky) / k.dky;   // grid steps per cycle across the FOV
        let dix = 0, diy = 0;
        if (name === 'low') { dix = Math.round(3 * fx); diy = Math.round(2 * fy); }
        else if (name === 'middle') { dix = Math.round(0.35 * cx); diy = -Math.round(0.2 * cy); }
        else if (name === 'edge') { dix = k.nx - 1 - cx; diy = 0; }
        else if (name === 'corner') { dix = k.nx - 1 - cx; diy = -cy; }
        return { dix: U.clamp(dix, -cx, k.nx - 1 - cx), diy: U.clamp(diy, -cy, k.ny - 1 - cy) };
    }
    /* Until the student picks a point, show a low frequency so the panel
       explains itself on first sight. */
    function ensureSelection() {
        if (T.sel || !T.result || !T.result.kspace) return;
        T.sel = namedOffsets('low', T.result);
    }
    function pickNamed(name, scroll) {
        const r = T.result, k = r && r.kspace;
        if (!k) { w().toast('Run a scan first: there is no k-space yet.', 'warn'); return; }
        const o = namedOffsets(name, r);
        selectPoint(o.dix, o.diy, false);
        if (scroll && V) V.waveWell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function scrollToEdit() {
        if (V && V.edPanel) { try { V.edPanel.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { V.edPanel.scrollIntoView(); } }
    }
    function ready() {
        const b = baseResult();
        if (!b || !b.kspace) { w().toast('Run a scan first: there is no k-space to edit yet.', 'warn'); return false; }
        ensureEditMask(b.kspace);
        return true;
    }
    function tryCentre(keep) {
        if (!ready()) return;
        const e = kExtent(baseResult().kspace);
        V.radius.set(U.clamp((keep ? 0.15 : 0.08) * e.kmin, e.dk, e.kmax));
        T.radius = V.radius.get();
        updateDerived();
        applyCentre(keep);
        scrollToEdit();
    }
    function tryHalf() {
        if (!ready()) return;
        const r = baseResult();
        // keep the half that leaves the phase-encode direction partial, where the repair acts
        const ro = r.info && r.info.readoutAxis;
        applyHalf(ro === 'y' ? 'left' : 'top');
        scrollToEdit();
    }

    function onShow() {
        T.visible = true;
        if (!V) return;
        if (state().reconResult !== T.result) { T.result = state().reconResult; T.dirty = true; T.editDirty = true; }
        const r = T.result;
        refreshCoilSelect();
        if (r && r.kspace) ensureEditMask(baseResult() ? baseResult().kspace : r.kspace);
        V.cartNote.hidden = !(r && r.info && r.info.cartesian === false);
        T.dirty = true; T.editDirty = true;
        ensureSelection();
        drawMain();
        drawEdit();
        renderWave();
        updateApplyUI();
        updateEditStats();
        if (T.previewDirty || !T.preview) schedulePreview(true);
    }
    function onHide() {
        T.visible = false;
        T.hover = null;
        if (pvTimer) { clearTimeout(pvTimer); pvTimer = null; T.previewDirty = true; }
    }

    MRI.ui.registerTab({ id: 'kspace', title: 'k-space', order: 50, mount: mount, onShow: onShow, onHide: onHide });
})(typeof window !== 'undefined' ? window : globalThis);
