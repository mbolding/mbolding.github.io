/* ============================================================
   MRI Simulator, Image tab (ARCHITECTURE.md section 12.5)

   Reconstruction is an inverse Fourier transform plus a handful of
   choices. This tab exposes every option of MRI.recon (section 10)
   as a labelled control with a one-line explanation, says which ones
   apply to the data at hand (from reconResult.info), and shows what
   each choice costs:

     - the reconstructed image (magnitude, phase, real, imaginary) with
       window/level, its physical aspect ratio and, for the brain,
       radiological orientation letters;
     - optionally the truth (the noise-free image of the same contrast,
       |acq.truth.data|) and the difference recon - truth;
     - a profile along any row (click the image), recon against truth;
     - ROI statistics and SNR = f mean(signal) / SD(background), with
       the factor f the background statistics of this image need (0.655
       for one coil or a complex combination, about 0.70 for a
       root-sum-of-squares of 8 coils) and, for Roemer, the noise scaled
       from the noise ROI to the signal ROI with the known coil maps;
     - the coil images and, when SENSE runs, the g-factor map;
     - the scan's voxel size, timing and the reconstruction's notes.

   Controls call MRI.actions.setRecon(patch), which re-runs only the
   reconstruction. During playback the partial reconstructions update
   the view at most once per animation frame. Hidden, the tab only
   notes that it is out of date. The truth, the coil names and the scan
   facts come from the acquisition the displayed reconstruction was
   made from, which can lag state.acq for a moment when a new scan
   starts.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const PI = Math.PI;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const RAYLEIGH = 0.655;      // SD of Rayleigh-distributed background magnitude / sigma of the complex noise
    const COARSE = (function () { try { return !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } })();

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function w() { return MRI.ui.w; }
    // the label of an in-place "try this" button, the same on every tab
    const TRY_IT = (MRI.ui.terms && MRI.ui.terms.tryIt) || 'Try it';
    function state() { return MRI.state; }
    function frameThrottle(fn) {
        let pending = false;
        return function () {
            if (pending) return;
            pending = true;
            raf(function () { pending = false; fn(); });
        };
    }
    function fnum(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3).replace('-', '−') : '-'; }
    function fsig(v) {
        if (!isFinite(v)) return '-';
        const a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2).replace('e-', 'e−').replace(/^-/, '−');
        return U.fmtNum(v, 3).replace('-', '−');
    }
    function nth(r) { return r === 2 ? '2nd' : r === 3 ? '3rd' : r + 'th'; }

    MRI.ui.addStyle(`
#tab-image .ir-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0 0 10px; }
#tab-image .ir-views { --min: 230px; }
#tab-image .ir-views > .well { align-self: stretch; }
#tab-image .iv-canvas.ir-roi-mode { touch-action: none; cursor: cell; }
#tab-image .ir-mode-note { margin: 0 0 10px; }
#tab-image .ir-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-image .ir-side { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
#tab-image .ir-group { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-image .ir-group > details.adv { margin-top: 0; }
@media (max-width: 900px) {
    /* one column: images, then the controls that change them, then the measurements */
    #tab-image .ir-split > .ir-main, #tab-image .ir-split > .ir-side { display: contents; }
    #tab-image .ir-o1 { order: 1; } #tab-image .ir-o2 { order: 2; } #tab-image .ir-o3 { order: 3; }
    #tab-image .ir-o4 { order: 4; } #tab-image .ir-o5 { order: 5; } #tab-image .ir-o6 { order: 6; } #tab-image .ir-o7 { order: 7; }
}
#tab-image .ir-controls { display: flex; flex-direction: column; gap: 14px; }
#tab-image .ir-ctl { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
#tab-image .ir-ctl .ctl-seg > .seg { justify-self: stretch; }
#tab-image .ir-note { font-size: 0.78rem; color: var(--muted); line-height: 1.4; margin: 0; }
#tab-image .ir-note.is-on { color: var(--fg); }
#tab-image .ir-note .ir-tag { display: inline-block; margin-right: 4px; font-weight: 650; color: var(--good); }
#tab-image .ir-note .ir-tag.na { color: var(--muted); }
#tab-image .ir-side h3, #tab-image .ir-main h3 { font-size: 0.92rem; margin: 0; }
#tab-image .ir-roi { display: flex; flex-direction: column; gap: 8px; }
#tab-image .ir-roi-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
#tab-image .ir-roi .stats { grid-template-columns: repeat(auto-fit, minmax(min(100%, 118px), 1fr)); }
#tab-image .ir-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
#tab-image .ir-notes { margin: 0; padding-left: 18px; }
#tab-image .ir-notes li { margin: 3px 0; }
#tab-image .ir-coils { --min: 118px; gap: 8px; }
#tab-image .ir-coils > .well { padding: 6px; align-self: stretch; }
#tab-image .ir-coils .well-title { font-size: 0.62rem; margin-bottom: 4px; }
#tab-image .ir-gwrap { max-width: 420px; }
#tab-image .ir-compare-line { font-size: 0.84rem; margin: 0; }
#tab-image .ir-edit-callout { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
#tab-image .ir-edit-callout > span { flex: 1 1 260px; }
#tab-image .ir-roi-empty { grid-column: 1 / -1; margin: 0; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 8px;
    font-size: 0.84rem; line-height: 1.45; color: var(--muted); }
#tab-image .ir-snr-how { margin: 0; }
#tab-image .ir-snr-how.is-warn { color: var(--warn); }
#tab-image details.adv > summary > .ir-sum-h { font: inherit; margin: 0; }
#tab-image .ir-sum-count { font-weight: 500; color: var(--muted); }
@media (max-width: 640px) {
    #tab-image .ir-toolbar { gap: 8px 12px; }
}
`);

    /* ---------- helpers on images ---------- */

    /* |truth| on the reconstruction's pixel grid. The truth is defined on
       the acquired matrix over the prescribed FOV; zero-filled or
       uncropped reconstructions have more pixels or a larger FOV, so each
       recon pixel takes the nearest truth pixel by position (section 3
       convention), and zero outside the prescribed FOV. */
    let truthCache = { key: null, data: null };
    function truthOnGrid(acq, nx, ny, fovX, fovY) {
        const t = acq && acq.truth;
        if (!t || !t.data || !t.nx || !t.ny) return null;
        const key = [acq.seed, t.data.length, nx, ny, fovX, fovY].join('|');
        if (truthCache.key === key && truthCache.src === t.data) return truthCache.data;
        const out = new Float32Array(nx * ny);
        const tdx = t.fovX / t.nx, tdy = t.fovY / t.ny, hx = Math.floor(t.nx / 2), hy = Math.floor(t.ny / 2);
        const cx = Math.floor(nx / 2), cy = Math.floor(ny / 2);
        for (let iy = 0; iy < ny; iy++) {
            const y = (iy - cy) * fovY / ny, jy = Math.round(y / tdy) + hy;
            if (jy < 0 || jy >= t.ny) continue;
            for (let ix = 0; ix < nx; ix++) {
                const x = (ix - cx) * fovX / nx, jx = Math.round(x / tdx) + hx;
                if (jx < 0 || jx >= t.nx) continue;
                out[iy * nx + ix] = Math.abs(t.data[jy * t.nx + jx]);
            }
        }
        truthCache = { key: key, src: t.data, data: out };
        return out;
    }

    let bipolarCache = { acq: null, v: false };
    function isBipolar(acq) {
        if (!acq || !acq.readouts) return false;
        if (bipolarCache.acq === acq) return bipolarCache.v;
        const ax = acq.grid && acq.grid.readoutAxis === 'y' ? 'ky' : 'kx';
        let pos = 0, neg = 0;
        for (const r of acq.readouts) {
            const a = r[ax], n = a ? a.length : 0;
            if (n < 2) continue;
            const d = a[n - 1] - a[0];
            if (d > 0) pos++; else if (d < 0) neg++;
            if (pos >= 2 && neg >= 2) break;
        }
        bipolarCache = { acq: acq, v: pos >= 2 && neg >= 2 };
        return bipolarCache.v;
    }

    /* Rectangle in fractions of the image (0..1) -> pixel bounds. */
    function rectPixels(r, nx, ny) {
        const x0 = U.clamp(Math.floor(Math.min(r.x0, r.x1) * nx), 0, nx - 1), x1 = U.clamp(Math.ceil(Math.max(r.x0, r.x1) * nx) - 1, 0, nx - 1);
        const y0 = U.clamp(Math.floor(Math.min(r.y0, r.y1) * ny), 0, ny - 1), y1 = U.clamp(Math.ceil(Math.max(r.y0, r.y1) * ny) - 1, 0, ny - 1);
        return { x0: x0, x1: Math.max(x0, x1), y0: y0, y1: Math.max(y0, y1) };
    }
    function roiStats(data, nx, ny, r) {
        const b = rectPixels(r, nx, ny);
        let s = 0, s2 = 0, n = 0;
        for (let iy = b.y0; iy <= b.y1; iy++) for (let ix = b.x0; ix <= b.x1; ix++) {
            const v = data[iy * nx + ix];
            if (!isFinite(v)) continue;
            s += v; s2 += v * v; n++;
        }
        if (!n) return null;
        const mean = s / n, sd = n > 1 ? Math.sqrt(Math.max(0, (s2 - n * mean * mean) / (n - 1))) : 0;
        return { mean: mean, sd: sd, n: n, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
    }

    /* ---------- tab state ---------- */
    const T = {
        visible: false, dirty: true,
        mode: 'mag', compare: false,
        // what a drag on the reconstruction does; on a touch screen it scrolls
        // the page by default, as a swipe does everywhere else
        drag: COARSE ? 'scroll' : 'wl',
        result: null, lastMode: null,
        row: 0.5,                      // profile row, fraction of the image height
        roi: { signal: null, noise: null },
        drawing: null,                 // ROI being dragged {kind, x0, y0, x1, y1}
        coilN: -1
    };
    let V = null;

    /* The acquisition each reconstruction was made from, recorded when
       recon:done announces it (app.js reconstructs state.acq, so that is
       the one at that moment; a payload that names its acq wins). The
       displayed result can belong to the previous scan for a moment after
       a new one starts, and its truth must not be paired with the new one. */
    const acqOfResult = typeof WeakMap === 'function' ? new WeakMap() : null;
    function noteResult(e) {
        if (acqOfResult && e && e.result && typeof e.result === 'object') acqOfResult.set(e.result, e.acq || state().acq);
    }
    function curAcq() {
        const r = state().reconResult;
        const a = r && acqOfResult ? acqOfResult.get(r) : null;
        return a || state().acq;
    }
    function combineMode() {
        const o = state().recon || {};
        return o.coilCombine || (MRI.recon && MRI.recon.defaults && MRI.recon.defaults.coilCombine) || 'roemer';
    }
    function combineName(v) {
        const t = MRI.ui.terms && MRI.ui.terms.combine;
        return (t && t[v]) || ({ sos: 'Root-sum-of-squares', roemer: 'Roemer', single: 'Single coil' })[v] || v;
    }
    function coilName(c, cs) {
        if (MRI.ui.terms && MRI.ui.terms.coilLabel) return MRI.ui.terms.coilLabel(c, cs);
        return 'Coil ' + (c + 1) + (cs && cs.names && cs.names[c] ? ' · ' + cs.names[c] : '');
    }
    function nCoilsOf(r) { return r && r.coilImages && r.coilImages.re ? r.coilImages.re.length : 0; }
    function senseActive(r) { return !!(r && r.gfactor); }
    function scanIfManual() { if (!state().autoRescan) MRI.actions.runScan({ animate: false }); }
    function hasParam(name) {
        const p = state().program && state().program.ok ? state().program : state().lastGoodProgram;
        return !!(p && p.params && p.params.some(function (q) { return q.name === name; }));
    }

    /* ---------- display data for the main view ---------- */
    function viewData(r, mode) {
        const im = r.image, N = im.nx * im.ny;
        if (mode === 'mag') {
            const hi = U.percentile(im.mag, 99.5);
            return { data: im.mag, min: 0, max: hi > 0 ? hi : 1, cmap: 'gray' };
        }
        if (mode === 'phase') {
            const ph = new Float32Array(N);
            for (let p = 0; p < N; p++) ph[p] = Math.atan2(im.im[p], im.re[p]);
            return { data: ph, min: -PI, max: PI, cmap: 'phase' };
        }
        const src = mode === 'real' ? im.re : im.im;
        const abs = new Float32Array(N);
        for (let p = 0; p < N; p++) abs[p] = Math.abs(src[p]);
        let a = U.percentile(abs, 99.5);
        if (!(a > 0)) a = U.percentile(im.mag, 99.5) || 1;
        return { data: src, min: -a, max: a, cmap: 'diverging' };
    }

    /* Overlay on every image view: profile row, ROIs, orientation letters. */
    function overlay(ctx, g) {
        const r = T.result;
        if (!r || !r.image) return;
        const font = U.cssVar('--font-sans', 'system-ui, sans-serif');
        // the profile row
        if (T.row !== null) {
            const iy = U.clamp(Math.floor(T.row * g.ny), 0, g.ny - 1);
            const y = Math.round((iy + 0.5) * g.sy) + 0.5;
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 209, 102, 0.85)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.w, y); ctx.stroke();
            ctx.restore();
        }
        const drawRect = function (rc, col, label) {
            if (!rc) return;
            const b = rectPixels(rc, g.nx, g.ny);
            const x = b.x0 * g.sx, y = b.y0 * g.sy, wd = (b.x1 - b.x0 + 1) * g.sx, ht = (b.y1 - b.y0 + 1) * g.sy;
            ctx.save();
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.strokeRect(x, y, wd, ht);
            ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.strokeRect(x, y, wd, ht);
            ctx.font = '700 11px ' + font; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
            const tx = x + 2, ty = y > 14 ? y - 2 : y + ht + 13;
            ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(tx - 2, ty - 12, ctx.measureText(label).width + 4, 13);
            ctx.fillStyle = col; ctx.fillText(label, tx, ty);
            ctx.restore();
        };
        drawRect(T.roi.signal, '#60a5fa', 'signal');
        drawRect(T.roi.noise, '#fbbf24', 'noise');
        if (T.drawing) drawRect(T.drawing, T.drawing.kind === 'signal' ? '#60a5fa' : '#fbbf24', T.drawing.kind);
        // radiological orientation for the head: anterior up, patient's right on the image left
        const acq = curAcq();
        if (acq && acq.phantomId === 'brain' && g.w > 90) {
            ctx.save();
            ctx.font = '700 ' + (g.w > 300 ? 13 : 11) + 'px ' + font;
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3;
            ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('A', g.w / 2, 4);
            ctx.textBaseline = 'bottom'; ctx.fillText('P', g.w / 2, g.h - 3);
            ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText('R', 5, g.h / 2);
            ctx.textAlign = 'right'; ctx.fillText('L', g.w - 5, g.h / 2);
            ctx.restore();
        }
    }

    /* ---------- rendering ---------- */
    function render() {
        if (!V) return;
        T.dirty = false;
        const r = state().reconResult;
        T.result = r;
        syncControls();
        updateEditCallout();
        if (!r || !r.image || !r.image.mag || !r.image.nx) {
            const msg = state().scanning ? 'Waiting for the first readouts...' : 'No image yet: press Acquire.';
            V.recon.clear(msg); V.truth.clear(msg); V.diff.clear(msg);
            V.profile.draw([]);
            V.compareLine.textContent = '';
            V.roemerBtn.hidden = true;
            V.roiStats.update(null, null, '');
            V.snrHow.hidden = true; V.roiSize.hidden = true; V.roiWarn.hidden = true;
            V.info.update([]); V.notes.textContent = ''; V.notesCount.textContent = '';
            V.coilPanel.hidden = true;
            return;
        }
        const im = r.image, acq = curAcq();
        const fov = { fovX: im.fovX, fovY: im.fovY };
        const modeChanged = T.lastMode !== T.mode;
        T.lastMode = T.mode;
        const vd = viewData(r, T.mode);
        V.recon.setData(vd.data, im.nx, im.ny, { min: vd.min, max: vd.max, cmap: vd.cmap, fovX: fov.fovX, fovY: fov.fovY, resetWindow: modeChanged });
        V.recon.setTitle(({ mag: 'Reconstruction, magnitude', phase: 'Reconstruction, phase (rad)', real: 'Reconstruction, real part', imag: 'Reconstruction, imaginary part' })[T.mode]);
        updateModeNote(r);

        // truth and difference
        const magHi = U.percentile(im.mag, 99.5) || 1;
        let truth = null;
        if (acq) truth = truthOnGrid(acq, im.nx, im.ny, im.fovX, im.fovY);
        V.truthWrap.hidden = V.diffWrap.hidden = !T.compare;
        if (T.compare) {
            if (truth) {
                V.truth.setData(truth, im.nx, im.ny, { min: 0, max: magHi, cmap: 'gray', fovX: fov.fovX, fovY: fov.fovY });
                const N = im.nx * im.ny, diff = new Float32Array(N);
                let tmax = 0;
                for (let p = 0; p < N; p++) { diff[p] = im.mag[p] - truth[p]; if (truth[p] > tmax) tmax = truth[p]; }
                const lim = 0.25 * magHi;
                V.diff.setData(diff, im.nx, im.ny, { min: -lim, max: lim, cmap: 'diverging', fovX: fov.fovX, fovY: fov.fovY });
                /* Inside the object: the median |difference| (robust: what most
                   pixels look like), the RMS (dominated by sharp edges, where the
                   ringing of a finite k-space and the partial volume of the truth
                   differ most) and the spread of recon / truth (a brightness
                   error that varies across the image, such as coil shading). */
                const ad = [], rat = [];
                let s2 = 0, st = 0;
                for (let p = 0; p < N; p++) if (truth[p] > 0.1 * tmax) { ad.push(Math.abs(diff[p])); rat.push(im.mag[p] / truth[p]); s2 += diff[p] * diff[p]; st += truth[p]; }
                const bits = [];
                let roemerHint = false;
                if (ad.length) {
                    ad.sort(function (x, y) { return x - y; }); rat.sort(function (x, y) { return x - y; });
                    const mt = st / ad.length, med = ad[ad.length >> 1];
                    const r10 = rat[Math.floor(0.1 * (rat.length - 1))], r90 = rat[Math.floor(0.9 * (rat.length - 1))];
                    bits.push('Inside the object: median |difference| ' + fnum(100 * med / mt, 2) + ' % and RMS difference ' + fnum(100 * Math.sqrt(s2 / ad.length) / mt, 2) +
                        ' % of the mean true signal (the RMS comes mostly from sharp edges, where truncation ringing and partial volume differ).');
                    const sos = nCoilsOf(r) > 1 && !senseActive(r) && combineMode() === 'sos';
                    if (sos && r90 / Math.max(1e-9, r10) > 1.15) {
                        bits.push('Root-sum-of-squares keeps the combined coil sensitivity: recon / truth runs from ' + fnum(r10, 2) + ' to ' + fnum(r90, 2) +
                            ' (10th to 90th percentile of the pixels), brighter near the coils, so most of this difference is coil shading. Roemer combination (the default) removes it.');
                        roemerHint = true;
                    }
                }
                if (acq.truth && (acq.truth.nx !== im.nx || acq.truth.ny !== im.ny)) bits.push('The truth is defined on the acquired ' + acq.truth.nx + ' \u00d7 ' + acq.truth.ny + ' matrix and enlarged to this grid.');
                V.roemerBtn.hidden = !roemerHint;
                V.compareLine.textContent = bits.join(' ');
            } else {
                V.truth.clear('No truth image for this scan'); V.diff.clear('No truth image');
                V.compareLine.textContent = '';
                V.roemerBtn.hidden = true;
            }
        } else { V.compareLine.textContent = ''; V.roemerBtn.hidden = true; }

        drawProfile(r, truth);
        updateRoiStats(r, truth);
        updateInfo(r, acq);
        renderCoils(r);
    }
    const requestRender = frameThrottle(function () { if (T.visible) render(); });

    function updateModeNote(r) {
        const sosLike = nCoilsOf(r) > 1 && !senseActive(r) && combineMode() === 'sos';
        let html = '';
        if (T.mode !== 'mag' && sosLike) {
            html = 'Root-sum-of-squares combination makes a <b>magnitude</b> image: its phase and imaginary part are zero everywhere. Choose Roemer (the default) or a single coil under Coil combination to see the complex image.';
        } else if (T.mode === 'phase') {
            html = 'Phase from −π to +π rad. In air it is random noise. Inside the object it varies smoothly with the coil phase and with off-resonance (Δφ = 2π Δf TE in a gradient echo); a spin echo refocuses the off-resonance part.';
        } else if (T.mode === 'real' || T.mode === 'imag') {
            html = 'Signed parts of the complex image. They depend on the receiver and coil phase, which is arbitrary, so clinical images show the magnitude.';
        }
        V.modeNote.innerHTML = html;
        V.modeNote.hidden = !html;
    }

    function drawProfile(r, truth) {
        const im = r.image;
        const iy = U.clamp(Math.floor(T.row * im.ny), 0, im.ny - 1);
        const x = new Float64Array(im.nx), y = new Float64Array(im.nx);
        const vd = T.mode === 'mag' ? im.mag : null;
        const cx = Math.floor(im.nx / 2);
        for (let ix = 0; ix < im.nx; ix++) {
            const p = iy * im.nx + ix;
            x[ix] = (ix - cx) * im.fovX / im.nx * 1e3;
            y[ix] = vd ? vd[p] : (T.mode === 'phase' ? Math.atan2(im.im[p], im.re[p]) : (T.mode === 'real' ? im.re[p] : im.im[p]));
        }
        const series = [{ x: x, y: y, color: 'var(--c1)', label: 'Reconstruction' }];
        if (T.mode === 'mag' && truth) {
            const t = new Float64Array(im.nx);
            for (let ix = 0; ix < im.nx; ix++) t[ix] = truth[iy * im.nx + ix];
            series.push({ x: x, y: t, color: 'var(--c2)', label: 'Truth', dash: true, width: 1.5 });
        }
        const yPos = (iy - Math.floor(im.ny / 2)) * im.fovY / im.ny * 1e3;
        const what = ({ mag: 'magnitude, a.u.', phase: 'phase, rad', real: 'real part, a.u.', imag: 'imaginary part, a.u.' })[T.mode];
        V.profile.setTitle('Row profile at y = ' + fnum(yPos, 3) + ' mm (' + what + '; click the image to choose a row)');
        V.profile.draw(series, { legend: series.length > 1, ylim: T.mode === 'phase' ? [-PI, PI] : undefined });
    }

    /* ---------- ROI statistics and SNR ---------- */

    /* What the background SD says about the noise. The SNR tool measures
       the noise where it is easy to see, in air, but a magnitude image
       does not keep Gaussian noise there:
       - One coil, or a complex combination of coils (Roemer, SENSE, a
         single coil shown on its own): the magnitude of complex Gaussian
         noise of SD sigma per part follows a Rayleigh distribution, whose
         SD is 0.655 sigma.
       - Root-sum-of-squares of n coils with independent noise of equal
         power: a chi distribution with 2n degrees of freedom, whose SD is
         sigma sqrt(2n - 2 (Gamma(n + 1/2) / Gamma(n))^2), 0.655 sigma for
         n = 1 and about 0.70 sigma for n = 8. It is the same everywhere.
       Inside the object the signal dominates, and there the noise has SD
       sigma in both cases, so SNR = factor x mean(signal) / SD(background).
       - Roemer divides by the summed sensitivity S = sum |C|^2, so its
         noise SD is sigma / sqrt(S) at each pixel: low near the coils and
         higher in the middle of the head. A noise ROI in a corner of air
         is close to the coils and understates the noise at a signal ROI
         in the middle, so the SNR is scaled by the ratio of the mean
         1/sqrt(S) over the two ROIs, from the known coil maps. */
    function chiFactor(n) {
        // Gamma(n + 1/2) / Gamma(n), by the recursion r(k + 1) = r(k) (k + 1/2) / k from r(1) = sqrt(pi) / 2
        let r = Math.sqrt(PI) / 2;
        for (let k = 1; k < n; k++) r *= (k + 0.5) / k;
        return Math.sqrt(Math.max(0, 2 * n - 2 * r * r));
    }
    /* 1 / sqrt(sum over coils of |C|^2) on the image grid, or null when the
       maps are not available (then recon.js combined by root-sum-of-squares). */
    let sensCache = { key: null, w: null };
    function noiseWeight(acq, im) {
        const cs = acq && acq.coilSet;
        if (!cs || !MRI.fields || typeof MRI.fields.coilMaps !== 'function') return null;
        const key = [typeof cs === 'string' ? cs : cs.type + ':' + cs.n + ':' + cs.scale, im.nx, im.ny, im.fovX, im.fovY].join('|');
        if (sensCache.key === key) return sensCache.w;
        let maps = null;
        try { maps = MRI.fields.coilMaps(cs, im.nx, im.ny, im.fovX, im.fovY); } catch (e) { maps = null; }
        if (!maps || !maps.re || !maps.re.length || maps.re[0].length !== im.nx * im.ny) return null;
        const N = im.nx * im.ny, nC = maps.re.length, wgt = new Float32Array(N);
        for (let p = 0; p < N; p++) {
            let ss = 0;
            for (let c = 0; c < nC; c++) ss += maps.re[c][p] * maps.re[c][p] + maps.im[c][p] * maps.im[c][p];
            wgt[p] = ss > 0 ? 1 / Math.sqrt(ss) : NaN;
        }
        sensCache = { key: key, w: wgt };
        return wgt;
    }
    /* {factor, scale, how, warn}: SNR = factor * scale * mean(signal) / SD(background). */
    function snrModel(r, acq, sigRc, noiRc) {
        const nC = nCoilsOf(r);
        const m = { factor: RAYLEIGH, scale: 1, how: '', warn: false };
        const pfNote = r.info && r.info.partialFourier < 1 ? ' Partial Fourier filling changes the noise as well, so treat the number as approximate.' : '';
        if (senseActive(r)) {
            m.warn = true;
            m.how = 'SNR = 0.655 × mean(signal) / SD(background) is only rough here: SENSE amplifies the noise by the g-factor, which varies across the image (see the map below), so no single background SD fits.' + pfNote;
            return m;
        }
        let mode = nC > 1 ? combineMode() : 'one';
        let wgt = null;
        if (mode === 'roemer') { wgt = noiseWeight(acq, r.image); if (!wgt) mode = 'sos'; }
        if (mode === 'sos') {
            m.factor = chiFactor(nC);
            m.how = 'SNR = ' + m.factor.toFixed(3) + ' × mean(signal) / SD(background). In a root-sum-of-squares of ' + nC + ' coils the air follows a chi distribution with ' +
                (2 * nC) + ' degrees of freedom, not the one-coil Rayleigh distribution (factor 0.655); the noise is the same everywhere.' + pfNote;
        } else if (mode === 'roemer') {
            const im = r.image;
            const a = sigRc ? roiStats(wgt, im.nx, im.ny, sigRc) : null, b = noiRc ? roiStats(wgt, im.nx, im.ny, noiRc) : null;
            if (a && b && a.mean > 0 && b.mean > 0) m.scale = b.mean / a.mean;
            m.how = 'SNR = 0.655 × mean(signal) / SD(background) × ' + fnum(m.scale, 3) + '. Roemer combination leaves less noise near the coils than in the middle of the head: ' +
                'from the coil maps, the noise at the signal ROI is ' + fnum(1 / m.scale, 3) + ' times that at the noise ROI.' + pfNote;
        } else {
            m.how = 'SNR = 0.655 × mean(signal) / SD(background): the air in a ' + (nC > 1 ? 'single coil’s' : 'one-coil') + ' magnitude image follows a Rayleigh distribution.' + pfNote;
        }
        m.warn = !!pfNote;
        return m;
    }

    /* Four stat tiles (signal mean, signal SD, background SD, SNR), each
       shown once the ROI it needs is placed; until then one line says
       how to place them. */
    function makeRoiTiles() {
        const tile = function (label, cls, hint) {
            const v = el('div', { class: 'stat-value' + (cls ? ' ' + cls : '') });
            const txt = doc.createTextNode('-'), u = el('span', { class: 'stat-unit' });
            v.appendChild(txt); v.appendChild(u);
            const t = el('div', { class: 'stat', title: hint || null }, [el('div', { class: 'stat-label', html: label }), v]);
            return { el: t, v: v, txt: txt, u: u };
        };
        const sw = function (c) { return '<span class="ir-swatch" style="background:' + c + '"></span>'; };
        const tiles = {
            sm: tile(sw('#60a5fa') + 'Signal mean', '', 'Mean magnitude inside the blue rectangle'),
            ss: tile(sw('#60a5fa') + 'Signal SD', '', 'Standard deviation inside the blue rectangle: noise plus real structure'),
            ns: tile(sw('#fbbf24') + 'Background SD', '', 'Standard deviation of the magnitude inside the amber rectangle (air)'),
            snr: tile('SNR', 'good', 'factor x mean(signal ROI) / SD(noise ROI); the line below the tiles gives the factor')
        };
        const empty = el('p', { class: 'ir-roi-empty' });
        const box = el('div', { class: 'stats', role: 'group', 'aria-label': 'ROI statistics' }, [empty, tiles.sm.el, tiles.ss.el, tiles.ns.el, tiles.snr.el]);
        const set = function (t, text, unit) { t.txt.nodeValue = text; t.u.textContent = unit || ''; };
        box.update = function (sig, noi, warn, model) {
            model = model || { factor: RAYLEIGH, scale: 1 };
            const snr = sig && noi && noi.sd > 0 ? model.factor * model.scale * sig.mean / noi.sd : NaN;
            tiles.sm.el.hidden = tiles.ss.el.hidden = !sig;
            tiles.ns.el.hidden = !noi;
            tiles.snr.el.hidden = !(sig && noi);
            empty.hidden = !!(sig && noi);
            empty.textContent = !sig && !noi ? 'Press Place both, or drag a Signal ROI and a Noise ROI on the image (pick them under "Drag on the image to"), to measure the SNR.'
                : !noi ? 'Now add a Noise ROI in the air outside the object (choose Noise ROI and drag a rectangle) to get the SNR.'
                : 'Now add a Signal ROI inside the object (choose Signal ROI and drag a rectangle) to get the SNR.';
            set(tiles.sm, sig ? fsig(sig.mean) : '-', sig ? 'a.u.' : '');
            set(tiles.ss, sig ? fsig(sig.sd) : '-', sig ? 'a.u.' : '');
            set(tiles.ns, noi ? fsig(noi.sd) : '-', noi ? 'a.u.' : '');
            tiles.ns.v.classList.toggle('warn', !!warn);
            set(tiles.snr, isFinite(snr) ? fnum(snr, 3) : '-', '');
            return box;
        };
        return box;
    }
    function updateRoiStats(r, truth) {
        const im = r.image;
        const sig = T.roi.signal ? roiStats(im.mag, im.nx, im.ny, T.roi.signal) : null;
        const noi = T.roi.noise ? roiStats(im.mag, im.nx, im.ny, T.roi.noise) : null;
        let warn = '';
        if (noi && truth) {
            const b = rectPixels(T.roi.noise, im.nx, im.ny);
            let tmax = 0, inside = 0;
            for (let p = 0; p < truth.length; p++) if (truth[p] > tmax) tmax = truth[p];
            for (let iy = b.y0; iy <= b.y1; iy++) for (let ix = b.x0; ix <= b.x1; ix++) if (truth[iy * im.nx + ix] > 0.03 * tmax) inside++;
            if (inside) warn = 'The noise ROI overlaps the object: move it into air, or the SD includes signal.';
        }
        const both = !!(sig && noi);
        const model = both ? snrModel(r, curAcq(), T.roi.signal, T.roi.noise) : null;
        V.roiStats.update(sig, noi, warn, model);
        V.snrHow.textContent = model ? model.how : '';
        V.snrHow.hidden = !(model && model.how);
        V.snrHow.classList.toggle('is-warn', !!(model && model.warn));
        V.roiWarn.textContent = warn;
        V.roiWarn.hidden = !warn;
        const parts = [];
        if (sig) parts.push('signal ROI ' + sig.w + ' × ' + sig.h + ' px');
        if (noi) parts.push('noise ROI ' + noi.w + ' × ' + noi.h + ' px');
        V.roiSize.textContent = parts.length ? parts.join(', ') + '.' : '';
        V.roiSize.hidden = !parts.length;
    }

    /* ---------- scan facts and reconstruction notes ---------- */
    function updateInfo(r, acq) {
        const im = r.image, prog = acq && acq.program, st = (acq && acq.stats) || {};
        const g = acq && acq.grid;
        const rows = [];
        if (g) {
            rows.push(['Acquired matrix', g.nx + ' × ' + g.ny + (g.oversample > 1 ? ' (readout oversampled ' + g.oversample + '×)' : '')]);
            rows.push(['Field of view', U.fmtNum(g.fovX * 1e3, 4) + ' × ' + U.fmtNum(g.fovY * 1e3, 4), 'mm']);
            const thick = prog && prog.image ? prog.image.thickness : null;
            rows.push(['Voxel size', U.fmtNum(g.fovX / g.nx * 1e3, 3) + ' × ' + U.fmtNum(g.fovY / g.ny * 1e3, 3) + (thick ? ' × ' + U.fmtNum(thick * 1e3, 3) : ''), 'mm']);
        }
        if (im.nx && g && (im.nx !== g.nx || im.ny !== g.ny)) {
            rows.push(['Displayed pixels', im.nx + ' × ' + im.ny + ', ' + U.fmtNum(im.fovX / im.nx * 1e3, 3) + ' × ' + U.fmtNum(im.fovY / im.ny * 1e3, 3), 'mm']);
        }
        const scanTime = prog && isFinite(prog.scanTime) ? prog.scanTime : st.scanTime;
        if (isFinite(scanTime)) rows.push(['Scan time', U.fmtTime(scanTime)]);
        if (isFinite(st.teEff)) rows.push(['Effective TE', U.fmtNum(st.teEff * 1e3, 3), 'ms']);
        if (isFinite(st.bwPerPixel)) rows.push(['Readout bandwidth', U.fmtNum(st.bwPerPixel, 4), 'Hz/px']);
        if (acq) {
            const type = acq.coilSet && (typeof acq.coilSet === 'string' ? acq.coilSet : acq.coilSet.type);
            const tc = MRI.ui.terms && MRI.ui.terms.coil;
            rows.push(['Receive coil', (tc && tc[type]) || (acq.nCoils + (acq.nCoils === 1 ? ' coil' : ' coils'))]);
        }
        if (isFinite(state().reconMs)) rows.push(['Reconstruction time', U.fmtNum(state().reconMs, 3), 'ms']);
        V.info.update(rows);
        V.notes.textContent = '';
        const notes = (r.info && r.info.notes) || [];
        notes.forEach(function (n) { V.notes.appendChild(el('li', { text: n })); });
        V.notesCount.textContent = notes.length ? ' (' + notes.length + ')' : '';
    }

    /* ---------- coils and g-factor ---------- */
    function rebuildCoilStrip(n) {
        V.coilGrid.textContent = '';
        V.coilViews = [];
        const cs = curAcq() && curAcq().coilSet;
        for (let c = 0; c < n; c++) {
            const label = coilName(c, cs);
            const v = w().imageView(V.coilGrid, { title: label, readout: false, maxHeight: 220, empty: '' });
            v.canvas.setAttribute('aria-label', 'Magnitude image of ' + label);
            v.el.title = label;
            V.coilViews.push(v);
        }
        T.coilN = n;
    }
    function renderCoils(r) {
        const n = nCoilsOf(r), ci = r.coilImages;
        const g = r.gfactor;
        V.coilPanel.hidden = !(n > 1 || g);
        if (n > 1) {
            if (T.coilN !== n) rebuildCoilStrip(n);
            V.coilWrap.hidden = false;
            let hi = 0;
            const mags = [];
            for (let c = 0; c < n; c++) {
                const re = ci.re[c], im = ci.im[c], N = ci.nx * ci.ny, m = new Float32Array(N);
                for (let p = 0; p < N; p++) m[p] = Math.hypot(re[p], im[p]);
                mags.push(m);
                hi = Math.max(hi, U.percentile(m, 99.5));
            }
            const aspect = r.image.fovY / r.image.fovX;
            mags.forEach(function (m, c) { V.coilViews[c].setData(m, ci.nx, ci.ny, { min: 0, max: hi || 1, aspect: aspect }); });
            V.coilNote.textContent = senseActive(r)
                ? 'Each coil image is folded (aliased), because only every ' + nth(r.info.undersampling) + ' line was recorded. SENSE untangles the overlapping pixels using how differently each coil sees them.'
                : 'Each coil sees the object weighted by its own sensitivity: bright near the coil, dark far from it. One window for all, so the coils can be compared.';
        } else if (V.coilWrap) { V.coilWrap.hidden = true; }
        if (g) {
            V.gWrap.hidden = false;
            const im = r.image, N = im.nx * im.ny, hiMag = U.percentile(im.mag, 99.5) || 1;
            // the object's support: from the truth when there is one (noise
            // amplified by SENSE in air must not count as object)
            const tr = truthOnGrid(curAcq(), im.nx, im.ny, im.fovX, im.fovY);
            let tmax = 0;
            if (tr) for (let p = 0; p < N; p++) if (tr[p] > tmax) tmax = tr[p];
            const gm = new Float32Array(N);
            let s = 0, cnt = 0, mx = 0;
            for (let p = 0; p < N; p++) {
                const inside = (tr && tmax > 0 ? tr[p] > 0.05 * tmax : im.mag[p] > 0.1 * hiMag) && isFinite(g[p]);
                gm[p] = inside ? g[p] : NaN;
                if (inside) { s += g[p]; cnt++; if (g[p] > mx) mx = g[p]; }
            }
            V.gView.setData(gm, im.nx, im.ny, { min: 1, max: Math.max(1.1, mx), cmap: 'hot', fovX: im.fovX, fovY: im.fovY });
            const R = r.info.undersampling || 1;
            V.gNote.textContent = cnt
                ? 'Within the object: mean g = ' + fnum(s / cnt, 3) + ', max g = ' + fnum(mx, 3) + '. Noise in the SENSE image is g × √R = ' +
                  fnum((s / cnt) * Math.sqrt(R), 3) + ' (mean) times that of the full scan with R = ' + R + '. It is worst where the coils see the folded pixels alike.'
                : '';
        } else V.gWrap.hidden = true;
    }

    /* ---------- controls ---------- */
    function syncControls() {
        const s = state(), o = s.recon || {}, r = state().reconResult, acq = curAcq();
        const info = (r && r.info) || {};
        const C = V.ctl;
        C.filter.set(o.filter || 'none');
        const fp = o.filter === 'tukey' || o.filter === 'fermi';
        C.fparamWrap.hidden = !fp;
        // not while the student is dragging it: a reconstruction triggered by the
        // drag would otherwise pull the thumb back to a slightly older value
        if (doc.activeElement !== C.fparam.input) C.fparam.set(isFinite(o.filterParam) ? o.filterParam : 0.5);
        const p = isFinite(o.filterParam) ? U.clamp(o.filterParam, 0, 1) : 0.5;
        C.filterNote.textContent = ({
            none: 'No filter: the sharpest image, with Gibbs ringing at sharp edges and the full noise.',
            hamming: 'Hamming: tapers k-space to 0.08 at the edge. Ringing almost gone, about 1.5× wider point-spread function.',
            hann: 'Hann: tapers k-space to zero at the edge. The smoothest image, the most blur.',
            tukey: 'Tukey: flat over the inner ' + Math.round(100 * (1 - p)) + ' % of k-space, cosine taper over the outer ' + Math.round(100 * p) + ' %.',
            fermi: 'Fermi: a smooth circular step, half-way at ' + Math.round(100 * (1 - p / 2)) + ' % of k-space radius.'
        })[o.filter || 'none'] || '';
        C.zf.set(o.zeroFill >= 2 ? 2 : 1);

        // partial Fourier
        C.pf.set(o.partialFourier || 'homodyne');
        const pfOn = info.partialFourier < 1;
        C.pf.setDisabled(!pfOn);
        setNote(C.pfNote, pfOn,
            pfOn ? 'Detected: ' + fnum(100 * info.partialFourier, 3) + ' % of the phase-encode lines recorded. ' +
                ({ zero: 'Zero: missing lines stay zero, so the image blurs along the phase direction.',
                   conjugate: 'Conjugate: fills them from S(−k) = S*(k), assuming one overall phase.',
                   homodyne: 'Homodyne: removes the slowly varying image phase first, then uses conjugate symmetry.' })[o.partialFourier || 'homodyne']
                : 'Applies when one side of k-space was skipped (gre_pf preset, or Keep half in the k-space tab).');

        // parallel imaging
        C.par.set(o.parallel || 'sense');
        const R = info.undersampling || 1;
        C.par.setDisabled(!(R > 1));
        setNote(C.parNote, R > 1,
            R > 1 ? 'Every ' + nth(R) + ' phase-encode line recorded (R = ' + R + '), so the FOV along phase is 1/' + R + ' and the image folds. ' +
                ((o.parallel || 'sense') === 'sense' ? (senseActive(r) ? 'SENSE unfolds it with the coil maps (known exactly here; a scanner measures them in a short calibration scan).' : 'SENSE needs at least R coils.') : 'Choose SENSE to unfold it.')
                : 'Applies to regularly undersampled data (gre_r2 preset).');

        // coil combination
        const nC = acq ? acq.nCoils : nCoilsOf(r);
        const comb = combineMode();
        C.comb.set(comb);
        const combOn = nC > 1 && !senseActive(r);
        C.comb.setDisabled(!combOn);
        if (V.coilOptsN !== nC) {
            const cs = acq && acq.coilSet, opts = [];
            for (let c = 0; c < Math.max(1, nC); c++) opts.push({ value: c, label: coilName(c, cs) });
            C.coil.setOptions(opts, Math.min(o.coil || 0, Math.max(0, nC - 1)));
            V.coilOptsN = nC;
        }
        C.coil.set(Math.min(o.coil || 0, Math.max(0, nC - 1)));
        C.coilWrap.hidden = comb !== 'single' || !combOn;
        setNote(C.combNote, combOn, !(nC > 1) ? 'One receive coil: nothing to combine.'
            : senseActive(r) ? 'SENSE combines the coils itself while unfolding, so this setting does not apply.'
            : ({ sos: combineName('sos') + ': needs no coil maps; a magnitude image, brighter near the coils. Its noise is the same everywhere.',
                 roemer: combineName('roemer') + ' (the default): weights each coil by its sensitivity. Best SNR, no coil shading, keeps the phase; needs the coil maps (a scanner measures them in a short calibration scan). Its noise is lowest near the coils.',
                 single: 'One coil on its own: see how a single element sees the head.' })[comb]);

        // advanced
        const cart = info.cartesian !== false;
        C.dcf.set(o.densityComp !== false);
        C.dcf.setDisabled(cart);
        setNote(C.dcfNote, !cart, cart ? 'Non-Cartesian data only (radial preset): Cartesian samples are evenly spaced already.'
            : 'Weights each sample by the k-space area it represents; radial spokes crowd the centre, so without it the image is blurred.');
        const bip = isBipolar(acq);
        C.epi.set(!!o.epiGhostCorr);
        C.epi.setDisabled(!bip);
        setNote(C.epiNote, bip, bip ? 'Removes the phase difference between odd and even echoes (estimated from the data) that makes the N/2 ghost. Raise the gradient delay in Artifacts to see it work.'
            : 'EPI only: needs readouts that alternate in direction.');
        const os = acq && acq.grid ? acq.grid.oversample || 1 : 1;
        C.crop.set(o.cropOversampling !== false);
        C.crop.setDisabled(!(os > 1));
        setNote(C.cropNote, os > 1, os > 1 ? 'The ADC sampled the readout ' + os + '\u00d7 faster than the FOV needs (\u0394k = 1/(' + os + ' FOV)), so the raw image is ' + os + '\u00d7 wider along the readout and the outer part is cropped. Untick to see the full width: nothing outside it folds back along the readout.'
            : 'This scan was not oversampled along the readout.');
    }
    function setNote(node, applies, text) {
        node.textContent = '';
        node.appendChild(el('span', { class: 'ir-tag' + (applies ? '' : ' na'), text: applies ? 'Applies.' : 'Not used here.' }));
        node.appendChild(doc.createTextNode(' ' + text));
        node.classList.toggle('is-on', !!applies);
    }

    function updateEditCallout() {
        const on = !!(state().recon && state().recon.userMask);
        V.editCallout.hidden = !on;
    }

    /* ---------- ROI drawing on the reconstruction ---------- */
    function wireRoiDrawing(view) {
        const cv = view.canvas;
        function frac(ev) {
            const rect = cv.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            return { x: U.clamp((ev.clientX - rect.left) / rect.width, 0, 1), y: U.clamp((ev.clientY - rect.top) / rect.height, 0, 1) };
        }
        cv.addEventListener('pointerdown', function (ev) {
            if ((T.drag !== 'signal' && T.drag !== 'noise') || ev.button !== 0 || !T.result) return;
            const f = frac(ev);
            if (!f) return;
            T.drawing = { kind: T.drag, x0: f.x, y0: f.y, x1: f.x, y1: f.y, id: ev.pointerId };
            ev.preventDefault();
        });
        cv.addEventListener('pointermove', function (ev) {
            if (!T.drawing) return;
            const f = frac(ev);
            if (!f) return;
            T.drawing.x1 = f.x; T.drawing.y1 = f.y;
            redrawViews();
        });
        const finish = function (ev, cancel) {
            if (!T.drawing) return;
            const d = T.drawing;
            T.drawing = null;
            const rect = cv.getBoundingClientRect();
            const big = Math.abs(d.x1 - d.x0) * rect.width >= 4 && Math.abs(d.y1 - d.y0) * rect.height >= 4;
            if (!cancel && big) {
                T.roi[d.kind] = { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) };
                const im = T.result && T.result.image;
                if (im) updateRoiStats(T.result, truthOnGrid(curAcq(), im.nx, im.ny, im.fovX, im.fovY));
            }
            redrawViews();
        };
        cv.addEventListener('pointerup', function (ev) { finish(ev, false); });
        cv.addEventListener('pointercancel', function (ev) { finish(ev, true); });
    }
    const redrawViews = frameThrottle(function () {
        if (!V) return;
        V.recon.redraw();
        if (T.compare) { V.truth.redraw(); V.diff.redraw(); }
    });

    /* Signal ROI in the middle, noise ROI in the first corner that is air. */
    function placeRois() {
        const r = T.result, acq = curAcq();
        if (!r || !r.image) { w().toast('Run a scan first.', 'warn'); return; }
        const im = r.image;
        const truth = truthOnGrid(acq, im.nx, im.ny, im.fovX, im.fovY);
        // Signal ROI: the most uniform bright patch of the truth, so its SD is
        // noise rather than anatomy (falls back to the middle of the image).
        T.roi.signal = { x0: 0.45, y0: 0.45, x1: 0.55, y1: 0.55 };
        if (truth) {
            let tmax = 0;
            for (let p = 0; p < truth.length; p++) if (truth[p] > tmax) tmax = truth[p];
            let best = -Infinity;
            const sz = 0.08;
            for (let gy = 0; gy <= 12; gy++) for (let gx = 0; gx <= 12; gx++) {
                const rc = { x0: 0.2 + 0.6 * gx / 12 - sz / 2, y0: 0.2 + 0.6 * gy / 12 - sz / 2 };
                rc.x1 = rc.x0 + sz; rc.y1 = rc.y0 + sz;
                const st = roiStats(truth, im.nx, im.ny, rc);
                if (!st || st.mean < 0.3 * tmax) continue;
                const score = st.mean / (st.sd + 0.02 * tmax);
                if (score > best) { best = score; T.roi.signal = rc; }
            }
        }
        const corners = [[0.02, 0.02], [0.86, 0.02], [0.02, 0.86], [0.86, 0.86]];
        let pick = corners[0];
        if (truth) {
            let tmax = 0;
            for (let p = 0; p < truth.length; p++) if (truth[p] > tmax) tmax = truth[p];
            for (const c of corners) {
                const b = rectPixels({ x0: c[0], y0: c[1], x1: c[0] + 0.12, y1: c[1] + 0.12 }, im.nx, im.ny);
                let any = false;
                for (let iy = b.y0; iy <= b.y1 && !any; iy++) for (let ix = b.x0; ix <= b.x1; ix++) if (truth[iy * im.nx + ix] > 0.01 * tmax) { any = true; break; }
                if (!any) { pick = c; break; }
            }
        }
        T.roi.noise = { x0: pick[0], y0: pick[1], x1: pick[0] + 0.12, y1: pick[1] + 0.12 };
        render();
    }

    /* ============================================================
       mount
       ============================================================ */
    function mount(panel) {
        const A = MRI.actions, Wd = w(), s = state();
        panel.textContent = '';

        panel.appendChild(Wd.concept({
            title: 'Reconstruction: an inverse Fourier transform, plus choices',
            body: '<p>Once k-space is filled, the image is its inverse Fourier transform: every sample adds its stripe pattern, weighted by its complex value. Around that one step a scanner makes choices: how to taper the edge of k-space, whether to interpolate, how to fill what was never measured, how to unfold an undersampled scan and how to combine the coils.</p>' +
                '<p>Every choice trades resolution, noise and artifacts. Switch on <b>Truth and difference</b> to see what each one costs against the noise-free image of the same contrast.</p>',
            formula: 'ρ(x, y) = Σ<sub>k<sub>x</sub>, k<sub>y</sub></sub> S(k<sub>x</sub>, k<sub>y</sub>) e<sup>+i2π(k<sub>x</sub>x + k<sub>y</sub>y)</sup> Δk<sub>x</sub> Δk<sub>y</sub>',
            tryThis: [
                { html: '<b>Hamming filter on a 64 matrix</b>: the ringing next to the skull fades and edges soften. Compare the row profiles with the filter off and on.', label: TRY_IT, run: function () {
                    if (!hasParam('N')) A.loadPreset('se');
                    A.setParam('N', 64);
                    A.setRecon({ filter: 'hamming', zeroFill: 1 });
                    setCompare(true); scanIfManual();
                } },
                { html: '<b>Zero-fill ×2</b>: smaller pixels and smoother edges, but no new detail (the profile gains points, not sharpness).', label: TRY_IT, run: function () { A.setRecon({ zeroFill: 2 }); } },
                { html: '<b>Partial Fourier</b> on gre_pf: Zero blurs along y; Homodyne restores the sharpness from 62.5 % of the lines.', label: TRY_IT, run: function () {
                    A.loadPreset('gre_pf'); A.setRecon({ partialFourier: 'zero', zeroFill: 1, filter: 'none' }); setCompare(true); scanIfManual();
                } },
                { html: '<b>SENSE</b> on gre_r2: with parallel imaging off the head folds over; SENSE unfolds it, and the g-factor map shows where the noise grows.', label: TRY_IT, run: function () {
                    A.loadPreset('gre_r2'); A.setRecon({ parallel: 'none', zeroFill: 1, filter: 'none' }); scanIfManual();
                } }
            ]
        }));

        const editCallout = el('div', { class: 'callout callout-warn ir-edit-callout', hidden: true, role: 'status' }, [
            el('span', { html: '<b>Edited k-space.</b> This image is reconstructed from the samples you kept in the k-space tab.' }),
            Wd.button({ label: 'Use all data', size: 'sm', onClick: function () { A.setRecon({ userMask: null, userMaskGrid: null }); } }),
            // same wording as the scan bar, the stale banners and the Scanner links ("Open the ... tab")
            Wd.button({ label: 'Open the k-space tab', size: 'sm', kind: 'ghost', onClick: function () { A.showTab('kspace', { focus: true }); } })
        ]);
        panel.appendChild(editCallout);
        // While the sequence does not compile, say that this is the last scan's image.
        if (Wd.staleBanner) Wd.staleBanner(panel, { what: 'image', before: editCallout });

        // ---------- main panel ----------
        const main = el('section', { class: 'panel', 'aria-labelledby': 'ir-title' });
        main.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ir-title', text: 'Reconstructed image' }),
            el('span', { class: 'panel-sub', text: COARSE
                ? 'Tap an image to read a value and pick the profile row. "Drag on the image to" (below) sets what a drag does.'
                : 'Drag on an image to change the window, double-click to reset; click to pick the profile row.' })
        ]));
        const split = el('div', { class: 'split ir-split' });
        const mainCol = el('div', { class: 'ir-main' }), side = el('div', { class: 'ir-side' });
        // groups that a narrow screen re-orders (controls straight after the images)
        const gTop = el('div', { class: 'ir-group ir-o1' }), gCtl = el('div', { class: 'ir-group ir-o4' }), gInfo = el('div', { class: 'ir-group ir-o7' });
        split.appendChild(mainCol); split.appendChild(side);
        main.appendChild(split);
        panel.appendChild(main);

        const toolbar = el('div', { class: 'ir-toolbar' });
        const modeSeg = Wd.segmented({ ariaLabel: 'Image display', size: 'sm', value: T.mode,
            options: (MRI.ui.terms && MRI.ui.terms.displayOptions) || [{ value: 'mag', label: 'Magnitude' }, { value: 'phase', label: 'Phase' }, { value: 'real', label: 'Real' }, { value: 'imag', label: 'Imaginary' }],
            onChange: function (v) { T.mode = v; requestRender(); } });
        const cmpTog = Wd.toggle({ label: 'Truth and difference', checked: T.compare, hint: 'Show the noise-free image of the same contrast and the difference |recon| - |truth|',
            onChange: function (b) { T.compare = b; requestRender(); } });
        toolbar.appendChild(el('div', { class: 'ctl-inline' }, [el('span', { class: 'ctl-label', text: 'Show' }), modeSeg]));
        toolbar.appendChild(cmpTog);
        mainCol.appendChild(gTop);
        gTop.appendChild(toolbar);
        const modeNote = el('p', { class: 'note ir-mode-note', hidden: true });
        gTop.appendChild(modeNote);

        const views = el('div', { class: 'image-grid ir-views ir-o2' });
        mainCol.appendChild(views);
        const recon = Wd.imageView(views, { title: 'Reconstruction, magnitude', colorbar: true, empty: 'No image yet: press Acquire.' });
        const truth = Wd.imageView(views, { title: 'Truth |m|, noise-free', colorbar: true, empty: '' });
        const diff = Wd.imageView(views, { title: 'Difference |recon| − |truth|', cmap: 'diverging', colorbar: true, empty: '' });
        [recon, truth, diff].forEach(function (v) {
            v.setOverlay(overlay);
            v.onClick(function (p) { T.row = (p.iy + 0.5) / p.ny; requestRender(); });
        });
        wireRoiDrawing(recon);
        const compareLine = el('p', { class: 'ir-compare-line note', 'aria-live': 'polite' });
        const roemerBtn = Wd.button({ label: 'Use Roemer combination', size: 'xs', onClick: function () { A.setRecon({ coilCombine: 'roemer' }); } });
        roemerBtn.hidden = true;
        mainCol.appendChild(el('div', { class: 'stack stack-sm ir-o3' }, [compareLine, el('div', {}, [roemerBtn])]));

        // ROI tools and statistics
        const roiBox = el('div', { class: 'ir-roi ir-o5' });
        // On a touch screen a drag scrolls the page unless the student picks
        // another mode (window/level then needs a long press, as everywhere).
        const dragOpts = [{ value: 'wl', label: 'Window/level' }, { value: 'signal', label: 'Signal ROI' }, { value: 'noise', label: 'Noise ROI' }];
        if (COARSE) dragOpts.unshift({ value: 'scroll', label: 'Scroll', title: 'Swipe to scroll the page; tap to read a value' });
        const applyDrag = function (v) {
            T.drag = v;
            recon.setWL(v === 'wl');
            recon.canvas.classList.toggle('ir-roi-mode', v === 'signal' || v === 'noise');
        };
        const dragLabel = el('span', { class: 'ctl-label', id: 'ir-drag-label', text: 'Drag on the image to' });
        const dragSeg = Wd.segmented({ size: 'sm', value: T.drag, options: dragOpts, onChange: applyDrag });
        dragSeg.setAttribute('aria-labelledby', 'ir-drag-label');
        applyDrag(T.drag);
        roiBox.appendChild(el('h3', { text: 'Signal-to-noise ratio' }));
        roiBox.appendChild(el('div', { class: 'ir-roi-row' }, [
            dragLabel, dragSeg,
            Wd.button({ label: 'Place both', size: 'sm', onClick: placeRois, title: 'Put a signal ROI in the middle and a noise ROI in a corner of air' }),
            Wd.button({ label: 'Clear', size: 'sm', kind: 'ghost', onClick: function () { T.roi.signal = T.roi.noise = null; requestRender(); } })
        ]));
        const roiStats = makeRoiTiles();
        roiBox.appendChild(roiStats);
        const snrHow = el('p', { class: 'ir-note ir-snr-how', hidden: true });
        roiBox.appendChild(snrHow);
        const roiSize = el('p', { class: 'ir-note', hidden: true });
        roiBox.appendChild(roiSize);
        const roiWarn = el('p', { class: 'callout callout-warn', hidden: true, role: 'status' });
        roiBox.appendChild(roiWarn);
        roiBox.appendChild(el('p', { class: 'ir-note', html:
            'Noise in a magnitude image is not Gaussian. In air, the magnitude of one coil (or of a complex combination such as Roemer) follows a Rayleigh distribution whose SD is 0.655 σ of the underlying complex noise, so <b>SNR = 0.655 × mean(signal ROI) / SD(noise ROI)</b>. ' +
            'A root-sum-of-squares of 8 coils follows a chi distribution instead (factor about 0.70), and Roemer and SENSE make the noise vary across the image; the line under the tiles says which correction this image gets.' }));
        mainCol.appendChild(roiBox);

        const profHost = el('div', { class: 'ir-o6' });
        mainCol.appendChild(profHost);
        const profile = Wd.plot(profHost, { height: 190, xlabel: 'x (mm)', framed: true, title: 'Row profile' });

        // ---------- side: reconstruction controls ----------
        side.appendChild(gCtl);
        side.appendChild(gInfo);
        gCtl.appendChild(el('h3', { text: 'Reconstruction' }));
        const ctlBox = el('div', { class: 'ir-controls' });
        gCtl.appendChild(ctlBox);
        const C = {};
        const note = function () { return el('p', { class: 'ir-note' }); };
        const wrap = function (children) { const d = el('div', { class: 'ir-ctl' }); children.forEach(function (c) { if (c) d.appendChild(c); }); ctlBox.appendChild(d); return d; };

        C.filter = Wd.select({ label: 'k-space filter', value: s.recon.filter || 'none',
            options: [{ value: 'none', label: 'None' }, { value: 'hamming', label: 'Hamming' }, { value: 'hann', label: 'Hann' }, { value: 'tukey', label: 'Tukey (adjustable)' }, { value: 'fermi', label: 'Fermi (adjustable)' }],
            hint: 'A window that multiplies k-space and falls towards its edge',
            onChange: function (v) { A.setRecon({ filter: v }); } });
        C.filterNote = note();
        C.fparam = Wd.slider({ label: 'Tapered part of k-space', unit: '% of radius', scale: 100, min: 0.05, max: 1, step: 0.05, value: s.recon.filterParam || 0.5,
            hint: 'How much of the edge of k-space the Tukey or Fermi filter gives up',
            // live while dragging only when a reconstruction is quick (large matrices update on release)
            onInput: U.debounce(function (v) { if (!(state().reconMs > 120)) A.setRecon({ filterParam: v }); }, 160),
            onChange: function (v) { A.setRecon({ filterParam: v }); } });
        C.fparamWrap = el('div', {}, [C.fparam]);
        wrap([C.filter, C.fparamWrap, C.filterNote]);

        C.zf = Wd.segmented({ label: 'Zero-fill', size: 'sm', value: s.recon.zeroFill >= 2 ? 2 : 1,
            options: [{ value: 1, label: '×1 (none)' }, { value: 2, label: '×2' }],
            onChange: function (v) { A.setRecon({ zeroFill: v }); } });
        wrap([C.zf, el('p', { class: 'ir-note', text: 'Pads k-space with zeros before the transform: a finer pixel grid by sinc interpolation, but no new detail.' })]);

        C.pf = Wd.segmented({ label: 'Partial Fourier', size: 'sm', value: s.recon.partialFourier || 'homodyne',
            options: [{ value: 'zero', label: 'Zero' }, { value: 'conjugate', label: 'Conjugate' }, { value: 'homodyne', label: 'Homodyne' }],
            onChange: function (v) { A.setRecon({ partialFourier: v }); } });
        C.pfNote = note();
        wrap([C.pf, C.pfNote]);

        C.par = Wd.segmented({ label: 'Parallel imaging', size: 'sm', value: s.recon.parallel || 'sense',
            options: [{ value: 'none', label: 'None' }, { value: 'sense', label: 'SENSE' }],
            onChange: function (v) { A.setRecon({ parallel: v }); } });
        C.parNote = note();
        wrap([C.par, C.parNote]);

        C.comb = Wd.select({ label: 'Coil combination', value: combineMode(),
            options: (MRI.ui.terms && MRI.ui.terms.combineOptions) || [{ value: 'sos', label: 'Root-sum-of-squares' }, { value: 'roemer', label: 'Roemer' }, { value: 'single', label: 'Single coil' }],
            onChange: function (v) { A.setRecon({ coilCombine: v }); } });
        C.coil = Wd.select({ label: 'Coil shown', value: s.recon.coil || 0, options: [{ value: 0, label: 'Coil 1' }],
            onChange: function (v) { A.setRecon({ coil: +v || 0 }); } });
        C.coilWrap = el('div', { hidden: true }, [C.coil]);
        C.combNote = note();
        wrap([C.comb, C.coilWrap, C.combNote]);

        const adv = el('details', { class: 'adv' }, [el('summary', { text: 'Advanced' })]);
        const advBody = el('div', { class: 'ir-controls' });
        adv.appendChild(advBody);
        gCtl.appendChild(adv);
        const awrap = function (children) { const d = el('div', { class: 'ir-ctl' }); children.forEach(function (c) { d.appendChild(c); }); advBody.appendChild(d); };
        C.dcf = Wd.toggle({ label: 'Density compensation', checked: s.recon.densityComp !== false, onChange: function (b) { A.setRecon({ densityComp: b }); } });
        C.dcfNote = note();
        awrap([C.dcf, C.dcfNote]);
        C.epi = Wd.toggle({ label: 'EPI ghost correction', checked: !!s.recon.epiGhostCorr, onChange: function (b) { A.setRecon({ epiGhostCorr: b }); } });
        C.epiNote = note();
        awrap([C.epi, C.epiNote]);
        C.crop = Wd.toggle({ label: 'Crop readout oversampling', checked: s.recon.cropOversampling !== false, onChange: function (b) { A.setRecon({ cropOversampling: b }); } });
        C.cropNote = note();
        awrap([C.crop, C.cropNote]);

        gCtl.appendChild(el('div', { class: 'row' }, [
            Wd.button({ label: 'Reset reconstruction', size: 'sm', title: 'Back to the default reconstruction (keeps any k-space edit)', onClick: function () {
                const d = Object.assign({}, MRI.recon.defaults);
                delete d.userMask;
                delete d.userMaskGrid;
                A.setRecon(d);
            } })
        ]));

        // Secondary numbers, one click away (ARCHITECTURE.md principle 4).
        const infoDet = el('details', { class: 'adv' }, [el('summary', {}, [el('h3', { class: 'ir-sum-h', text: 'This scan' })])]);
        const info = Wd.statTable([], { compact: true });
        infoDet.appendChild(info);
        gInfo.appendChild(infoDet);
        const notesCount = el('span', { class: 'ir-sum-count' });
        const notesDet = el('details', { class: 'adv' }, [el('summary', {}, [el('h3', { class: 'ir-sum-h', text: 'What the reconstruction did' }), notesCount])]);
        const notes = el('ul', { class: 'note ir-notes' });
        notesDet.appendChild(notes);
        gInfo.appendChild(notesDet);

        // ---------- coils and g-factor ----------
        const coilPanel = el('section', { class: 'panel', hidden: true, 'aria-labelledby': 'ir-coil-title' });
        coilPanel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'ir-coil-title', text: 'Receive coils' })]));
        const coilWrap = el('div', { class: 'stack' });
        const coilNote = el('p', { class: 'note mt-0' });
        const coilGrid = el('div', { class: 'image-grid ir-coils' });
        coilWrap.appendChild(coilNote); coilWrap.appendChild(coilGrid);
        coilPanel.appendChild(coilWrap);
        const gWrap = el('div', { class: 'stack mt-2 ir-gwrap', hidden: true });
        const gView = Wd.imageView(gWrap, { title: 'g-factor (noise amplification by SENSE)', cmap: 'hot', colorbar: true, maxHeight: 380 });
        gView.canvas.setAttribute('aria-label', 'g-factor map of the SENSE reconstruction');
        const gNote = el('p', { class: 'note mt-0' });
        gWrap.appendChild(gNote);
        coilPanel.appendChild(gWrap);
        panel.appendChild(coilPanel);

        V = { recon: recon, truth: truth, diff: diff, truthWrap: truth.el, diffWrap: diff.el, modeSeg: modeSeg, cmpTog: cmpTog, modeNote: modeNote,
            compareLine: compareLine, roemerBtn: roemerBtn, dragSeg: dragSeg, roiStats: roiStats, roiSize: roiSize, roiWarn: roiWarn, snrHow: snrHow, profile: profile,
            info: info, notes: notes, notesCount: notesCount, coilPanel: coilPanel, coilWrap: coilWrap, coilNote: coilNote, coilGrid: coilGrid, coilViews: [],
            gWrap: gWrap, gView: gView, gNote: gNote, ctl: C, coilOptsN: -1, editCallout: editCallout };
        truth.el.hidden = diff.el.hidden = true;

        const bus = MRI.bus;
        bus.on('recon:done', function (e) { noteResult(e); if (T.visible) requestRender(); else T.dirty = true; });
        bus.on('scan:start', function () { if (!T.visible) T.dirty = true; });
        bus.on('scan:error', function () { if (T.visible) requestRender(); else T.dirty = true; });
    }

    function setCompare(b) {
        T.compare = !!b;
        if (V) V.cmpTog.set(T.compare);
        requestRender();
    }

    function onShow() {
        T.visible = true;
        if (!V) return;
        render();
    }
    function onHide() {
        T.visible = false;
        T.drawing = null;
    }

    MRI.ui.registerTab({ id: 'image', title: 'Image', order: 60, mount: mount, onShow: onShow, onHide: onHide });
})(typeof window !== 'undefined' ? window : globalThis);
