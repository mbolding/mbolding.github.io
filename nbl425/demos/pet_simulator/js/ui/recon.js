/* ============================================================
   PET Simulator, Reconstruction tab
   How a sinogram becomes an image: plain backprojection, filtered
   backprojection with a choice of filter, and the iterative MLEM and
   OSEM, with time of flight and resolution modelling. The tab shows
   the reconstruction beside the truth and their difference, lets
   students scrub through the iterations while a convergence plot
   shows recovery rising and noise growing, and measures what the
   image says: line profiles, ROI statistics, and the measurement
   each test object exists for (resolution of the line sources, NEMA
   contrast recovery of the spheres, which rods separate).

   Everything the tab changes goes through PET.actions.setRecon (or
   setFrame / setAnalysis); it listens on the bus for scans and
   reconstructions and only redraws while it is visible.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.util || !PET.ui || typeof PET.ui.registerTab !== 'function') return;
    const U = PET.util;
    const el = U.el;
    const FOV = 320;
    const SUBSETS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];     // divisors of the 192 angles
    const METHODS = [
        { value: 'bp', label: 'Backprojection', title: 'Plain backprojection: smear each line back over the image' },
        { value: 'fbp', label: 'FBP', title: 'Filtered backprojection' },
        { value: 'mlem', label: 'MLEM', title: 'Maximum-likelihood expectation maximisation' },
        { value: 'osem', label: 'OSEM', title: 'Ordered-subsets expectation maximisation' }
    ];
    const METHOD_TEXT = {
        bp: 'Each line\'s counts are smeared back along it. Not an inverse: every point is blurred as 1/r, so this shows why reconstruction needs more than backprojection.',
        fbp: 'Each projection is filtered with a ramp (tamed by a window), then backprojected. One pass, linear and fast; noise appears as fine streaks.',
        mlem: 'Start from a flat image and repeat: forward-project it through the scanner model, compare with the measured counts, backproject the ratio. Every angle in every update, so it is slow.',
        osem: 'MLEM that updates the image after each subset of angles, so one iteration does as much as about "subsets" MLEM iterations. The clinical standard.'
    };

    /* A diverging map that is dark in the middle, so a difference image
       sits naturally in the near-black well: zero is black, too low is
       blue, too high is red to yellow. Added to the shared colour maps
       under its own name only if nothing else defined it. */
    if (U.colormaps && !U.colormaps.icefire) {
        const stops = [[175, 225, 255], [70, 150, 240], [30, 62, 150], [10, 12, 20], [150, 38, 38], [235, 95, 45], [255, 210, 120]];
        U.colormaps.icefire = function (t) {
            t = U.clamp(t, 0, 1) * (stops.length - 1);
            const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
            return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
        };
    }
    const DIFF_CMAP = U.colormaps && U.colormaps.icefire ? 'icefire' : 'diverging';

    /* ---------- small helpers ---------- */
    function W() { return PET.ui.w; }
    function st() { return PET.state || {}; }
    function curAcq() { return st().acq || null; }
    function curResult() { return st().reconResult || null; }
    function warn(msg, e) { if (root.console) root.console.warn('[recon tab] ' + msg, e || ''); }
    function safe(fn, what) {
        return function () {
            try { return fn.apply(this, arguments); }
            catch (e) { warn((what || 'update') + ' failed:', e); return undefined; }
        };
    }
    function act(name) {
        const a = PET.actions;
        if (!a || typeof a[name] !== 'function') return undefined;
        try { return a[name].apply(a, Array.prototype.slice.call(arguments, 1)); }
        catch (e) { warn('action ' + name + ' failed:', e); return undefined; }
    }
    function fmt(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3) : '-'; }
    function pct(v, d) { return isFinite(v) ? (100 * v).toFixed(d === undefined ? 0 : d) + ' %' : '-'; }
    function maxOf(a) { let m = -Infinity; for (let k = 0; k < a.length; k++) if (a[k] > m) m = a[k]; return m; }
    /* Top of a display window: a high percentile, or the maximum when the
       image is nearly empty (line sources), where a percentile is zero. */
    function robustMax(a) { const p = U.percentile(a, 99.8), m = maxOf(a); return p < 0.25 * m ? m : p; }
    function phantomOf(acq) {
        if (!acq || !PET.phantoms) return null;
        try { return PET.phantoms.build(acq.phantomId, acq.phantomOpts || {}); } catch (e) { return null; }
    }
    function kindOf(ph) {
        if (!ph) return null;
        if (PET.analysis && PET.analysis.phantomKind) { try { return PET.analysis.phantomKind(ph); } catch (e) { /* fall through */ } }
        return ph.kind === 'brain' ? 'brain' : ph.id;
    }
    function suvAvailable(acq) { return !!(acq && acq.tracer && acq.dose > 0 && acq.weight > 0); }
    function fmtMin(s) { return s === 0 ? '0' : U.fmtTime(s); }
    function td(text, cls) { return el('td', { class: cls || null }, text === undefined || text === null ? '-' : String(text)); }
    function th(text, attrs) { return el('th', Object.assign({ scope: 'col' }, attrs || {}), text); }
    function dataTable(head, rows, caption) {
        const t = el('table', { class: 'rc-table' });
        if (caption) t.appendChild(el('caption', { text: caption }));
        t.appendChild(el('thead', {}, el('tr', {}, head.map(function (h) { return th(h); }))));
        const b = el('tbody');
        rows.forEach(function (r) { b.appendChild(el('tr', {}, r)); });
        t.appendChild(b);
        return t;
    }

    /* ---------- styles (scoped to this tab) ---------- */
    const CSS = `
#tab-recon .rc-layout { display: grid; gap: 16px; grid-template-columns: minmax(270px, 330px) minmax(0, 1fr); align-items: start; }
#tab-recon .rc-layout > * { min-width: 0; }
@media (max-width: 960px) { #tab-recon .rc-layout { grid-template-columns: minmax(0, 1fr); } }
#tab-recon .rc-controls .panel-head { margin-bottom: 8px; }
#tab-recon .rc-method-text { font-size: 0.82rem; color: var(--muted); margin: 6px 0 0; line-height: 1.45; }
#tab-recon .rc-group { border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 12px; }
#tab-recon .rc-group-title { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
#tab-recon .rc-group .controls { --min: 220px; gap: 10px 16px; }
#tab-recon .rc-toggles { display: flex; flex-direction: column; gap: 8px; }
#tab-recon .rc-sub { font-size: 0.78rem; color: var(--muted); line-height: 1.4; margin: 2px 0 0 40px; }
#tab-recon .rc-equiv { font-size: 0.8rem; color: var(--muted); margin: 8px 0 0; }
#tab-recon .rc-equiv strong { color: var(--fg); font-variant-numeric: tabular-nums; }
#tab-recon .rc-progress { height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; margin: 8px 0 0; }
#tab-recon .rc-progress > div { height: 100%; width: 0; background: var(--accent); transition: width 0.12s linear; }
#tab-recon .rc-progress.is-idle { visibility: hidden; }
#tab-recon .rc-status { font-size: 0.8rem; color: var(--muted); margin-top: 6px; font-variant-numeric: tabular-nums; }
#tab-recon .rc-notes { margin: 10px 0 0; padding: 0; list-style: none; font-size: 0.8rem; color: var(--muted); }
#tab-recon .rc-notes li { position: relative; padding-left: 14px; margin-bottom: 4px; line-height: 1.45; }
#tab-recon .rc-notes li::before { content: ""; position: absolute; left: 2px; top: 0.6em; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
#tab-recon .rc-corr { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#tab-recon .rc-images .image-grid { --min: 150px; gap: 10px; }
#tab-recon .rc-images .well { padding: 8px; }
#tab-recon .rc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 10px; }
#tab-recon .rc-toolbar .ctl-inline .ctl-label { white-space: nowrap; }
#tab-recon .rc-frame { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
#tab-recon .rc-frame .ctl { flex: 1 1 200px; min-width: 0; }
#tab-recon .rc-frame-time { font-size: 0.82rem; color: var(--muted); font-variant-numeric: tabular-nums; }
#tab-recon .rc-explorer { display: grid; gap: 16px; grid-template-columns: minmax(180px, 280px) minmax(0, 1fr); align-items: start; }
#tab-recon .rc-explorer > * { min-width: 0; }
@media (max-width: 700px) { #tab-recon .rc-explorer { grid-template-columns: minmax(0, 1fr); } }
#tab-recon .rc-scrub { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
#tab-recon .rc-scrub .ctl { flex: 1; min-width: 0; }
#tab-recon .rc-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
#tab-recon .rc-table caption { text-align: left; font-weight: 650; font-size: 0.82rem; padding-bottom: 6px; }
#tab-recon .rc-table th { text-align: right; font-weight: 600; color: var(--muted); padding: 4px 0 4px 10px; font-size: 0.76rem; white-space: nowrap; }
#tab-recon .rc-table th:first-child, #tab-recon .rc-table td:first-child { text-align: left; padding-left: 0; }
#tab-recon .rc-table td { text-align: right; padding: 4px 0 4px 10px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 0.8rem; }
#tab-recon .rc-table td:first-child { font-family: var(--font-sans); }
#tab-recon .rc-table tbody tr > * { border-top: 1px solid var(--border-subtle); }
#tab-recon .rc-table td.good { color: var(--good); } #tab-recon .rc-table td.warn { color: var(--warn); } #tab-recon .rc-table td.bad { color: var(--bad); }
#tab-recon .rc-table-wrap { overflow-x: auto; }
#tab-recon .plot-legend .legend-item { white-space: normal; }
#tab-recon .rc-two { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); align-items: start; }
#tab-recon .rc-two > * { min-width: 0; }
#tab-recon .rc-howto ul { margin: 0 0 8px; padding-left: 18px; font-size: 0.86rem; line-height: 1.55; }
#tab-recon .rc-howto li { margin-bottom: 4px; }
#tab-recon .rc-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: 0; }
`;

    /* ---------- module state ---------- */
    const S = {
        panel: null, visible: false, mounted: false,
        unit: 'conc', cmap: 'pet', outline: false,
        prof: { orient: 'h', pos: 0, cross: null },
        hover: null,
        roiLocal: null,
        hot: null, uni: null,
        iterK: null, playTimer: null,
        lastResult: null, lastAcq: null,
        caches: { truth: null, conv: null, outline: null, special: null },
        ui: {}
    };

    /* ---------- cached derived data ---------- */
    function truthFor(acq, result) {
        if (!acq || !result || !PET.analysis) return null;
        const frame = result.frame === undefined ? 0 : result.frame, m = result.n;
        const c = S.caches.truth;
        if (c && c.acq === acq && c.frame === frame && c.m === m) return c.img;
        const ph = phantomOf(acq);
        if (!ph) return null;
        let img = null;
        try { img = PET.analysis.truthImage(acq, frame, m, ph); } catch (e) { warn('truth image failed', e); }
        S.caches.truth = { acq: acq, frame: frame, m: m, img: img };
        return img;
    }
    function displayScale(acq) {
        if (S.unit === 'suv' && suvAvailable(acq)) return { f: acq.weight * 1000 / acq.dose, unit: 'SUV', suv: true };
        return { f: 1e-3, unit: 'kBq/mL', suv: false };
    }
    function scaled(img, f) {
        if (!img) return null;
        const out = new Float32Array(img.length);
        for (let k = 0; k < img.length; k++) out[k] = img[k] * f;
        return out;
    }
    function roiList(ph) {
        if (!ph || !PET.analysis || !PET.analysis.roiDefs) return [];
        try { return PET.analysis.roiDefs(ph) || []; } catch (e) { return []; }
    }
    function roiMask(ph, m, id, opts) {
        try { return PET.analysis.roiMask(ph, m, id, opts); } catch (e) { return null; }
    }
    function defaultRoi(ph, defs) {
        const ids = defs.map(function (d) { return d.id; });
        const pref = { brain: ['cortex', 'striatum'], cylinder: ['centre'], spheres: ['sphere10', 'background'], rods: ['rods10'], point: ['src_0'] }[kindOf(ph)] || [];
        for (let i = 0; i < pref.length; i++) if (ids.indexOf(pref[i]) >= 0) return pref[i];
        return ids[0] || null;
    }
    function currentRoi(ph, defs) {
        const ids = defs.map(function (d) { return d.id; });
        const a = st().analysis || {};
        if (S.roiLocal && ids.indexOf(S.roiLocal) >= 0) return S.roiLocal;
        if (a.roi && ids.indexOf(a.roi) >= 0) return a.roi;
        return defaultRoi(ph, defs);
    }

    /* ---------- image views ---------- */
    function coordText(ix, iy, n) {
        const dx = FOV / n, h = Math.floor(n / 2);
        return 'x ' + ((ix - h) * dx).toFixed(1) + ', y ' + ((iy - h) * dx).toFixed(1) + ' mm';
    }
    function makeView(host, title, emptyMsg, withOutline) {
        const v = W().imageView(host, { title: title, cmap: S.cmap, colorbar: true, empty: emptyMsg,
            readoutFormat: function (ix, iy, val) {
                const ds = displayScale(curAcq());
                return coordText(ix, iy, S.n || 128) + ': ' + (isFinite(val) ? fmt(val, 3) + ' ' + ds.unit : 'no data');
            } });
        v.onHover(function (p) { S.hover = p ? { ix: p.ix, iy: p.iy } : null; linkReadouts(v, p); redrawOverlays(); });
        v.onClick(function (p) {
            if (!p) return;
            const n = p.nx, dx = FOV / n, h = Math.floor(n / 2);
            const x = (p.ix - h) * dx, y = (p.iy - h) * dx;
            S.prof.cross = { x: x, y: y };
            S.prof.pos = S.prof.orient === 'h' ? y : x;
            if (S.ui.profPos) S.ui.profPos.set(S.prof.pos);
            redrawOverlays();
            renderProfile();
        });
        v.setOverlay(function (ctx, g) { overlay(ctx, g, !!withOutline); });
        return v;
    }
    function overlay(ctx, g, withOutline) {
        if (!g || !g.nx) return;
        const n = g.nx, dx = FOV / n, h = Math.floor(n / 2);
        // profile line
        if (S.ui.profileOn !== false) {
            ctx.save();
            ctx.strokeStyle = 'rgba(245, 208, 97, 0.9)';
            ctx.lineWidth = 1.25;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            const f = S.prof.pos / dx + h;
            if (S.prof.orient === 'h') { const y = (f + 0.5) * g.sy; ctx.moveTo(0, y); ctx.lineTo(g.w, y); }
            else { const x = (f + 0.5) * g.sx; ctx.moveTo(x, 0); ctx.lineTo(x, g.h); }
            ctx.stroke();
            ctx.restore();
        }
        // ROI outline
        if (withOutline && S.outline && S.caches.outline && S.caches.outline.m === n) {
            const segs = S.caches.outline.segs;
            ctx.save();
            ctx.strokeStyle = 'rgba(94, 224, 210, 0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let k = 0; k < segs.length; k += 4) {
                ctx.moveTo(segs[k] * g.sx, segs[k + 1] * g.sy);
                ctx.lineTo(segs[k + 2] * g.sx, segs[k + 3] * g.sy);
            }
            ctx.stroke();
            ctx.restore();
        }
        // linked hover marker
        if (S.hover && S.hover.ix < n && S.hover.iy < n) {
            const p = g.toCanvas(S.hover.ix, S.hover.iy), r = Math.max(5, 1.5 * g.sx);
            ctx.save();
            ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.stroke();
            ctx.lineWidth = 1.25; ctx.strokeStyle = '#ffffff';
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.stroke();
            ctx.restore();
        }
    }
    /* Hovering one image shows the value at the same pixel in the other two. */
    function linkReadouts(src, p) {
        const views = [[S.ui.vRecon, 'recon'], [S.ui.vTruth, 'truth'], [S.ui.vDiff, 'diff']];
        const ds = displayScale(curAcq());
        views.forEach(function (pair) {
            const v = pair[0];
            if (!v || v === src) return;
            const ro = v.el.querySelector('.well-readout');
            if (!ro) return;
            const data = S.disp ? S.disp[pair[1]] : null;
            if (!p || !data || !S.disp || S.disp.n !== p.nx) { ro.textContent = 'Drag: window/level \u00b7 double-click: reset'; return; }
            const val = data[p.iy * p.nx + p.ix];
            ro.textContent = coordText(p.ix, p.iy, p.nx) + ': ' + (isFinite(val) ? fmt(val, 3) + ' ' + ds.unit : 'no data');
        });
    }
    function redrawOverlays() {
        ['vRecon', 'vTruth', 'vDiff', 'vIter'].forEach(function (k) { if (S.ui[k]) S.ui[k].redraw(); });
    }
    function outlineSegments(mask, m) {
        const segs = [];
        for (let iy = 0; iy < m; iy++) for (let ix = 0; ix < m; ix++) {
            if (!(mask[iy * m + ix] > 0)) continue;
            if (ix === 0 || !(mask[iy * m + ix - 1] > 0)) segs.push(ix, iy, ix, iy + 1);
            if (ix === m - 1 || !(mask[iy * m + ix + 1] > 0)) segs.push(ix + 1, iy, ix + 1, iy + 1);
            if (iy === 0 || !(mask[(iy - 1) * m + ix] > 0)) segs.push(ix, iy, ix + 1, iy);
            if (iy === m - 1 || !(mask[(iy + 1) * m + ix] > 0)) segs.push(ix, iy + 1, ix + 1, iy + 1);
        }
        return segs;
    }

    /* ---------- building the tab ---------- */
    function mount(panel) {
        S.panel = panel;
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        const w = W();
        if (!w) { panel.appendChild(el('div', { class: 'error-card' }, 'The shared widgets (js/ui/widgets.js) did not load, so this tab cannot be shown.')); return; }

        panel.appendChild(w.concept({
            title: 'From sinogram to image',
            body: '<p>Backprojection smears each line\'s counts back along the line, so a point comes out blurred as 1/r. ' +
                '<b>Filtered backprojection</b> first filters every projection with a ramp |&nu;| (tamed by a window that rolls off the noisy high frequencies). ' +
                '<b>MLEM</b> and <b>OSEM</b> instead iterate with a model of the scanner that contains the corrections, so the counts are never subtracted; OSEM updates after each subset of angles. ' +
                'With <b>time of flight</b> each event is placed along its line to within &sigma; = c&middot;CTR / (2 &times; 2.355), about 25 mm for 400 ps.</p>',
            formula: 'x<sup>(k+1)</sup> = <span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;border-bottom:1px solid currentColor;padding:0 3px">x<sup>(k)</sup></span><span style="display:block;padding:0 3px">H<sup>T</sup>1</span></span> &middot; H<sup>T</sup>( <span style="display:inline-block;vertical-align:middle;text-align:center"><span style="display:block;border-bottom:1px solid currentColor;padding:0 3px">y</span><span style="display:block;padding:0 3px">H x<sup>(k)</sup> + s + r</span></span> )',
            tryThis: [
                { html: 'Switch to <b>Backprojection</b>: the 1/r blur. Then FBP with the <b>Ramp</b> filter: sharp but noisy.', label: 'Backprojection',
                    run: function () { act('setRecon', { method: 'bp' }); } },
                { html: 'FBP with Hann: lower the <b>cutoff</b> to 0.5 and watch noise fall and edges blur.', label: 'FBP, cutoff 0.5',
                    run: function () { act('setRecon', { method: 'fbp', filter: 'hann', cutoff: 0.5 }); } },
                { html: 'OSEM with 12 iterations and no post-filter, then scrub the <b>iterations</b> below: recovery rises, and so does noise.', label: 'OSEM 12 x 12',
                    run: function () { act('setRecon', { method: 'osem', iterations: 12, subsets: 12, postFilter: 0 }); } },
                { html: 'Line sources without post-filter: read the FWHM table, then switch on <b>PSF</b> and watch the off-centre sources sharpen.', label: 'Line sources',
                    run: function () { act('loadPreset', 'point_res'); act('setRecon', { method: 'osem', iterations: 4, subsets: 12, matrix: 128, postFilter: 0, psf: false }); } }
            ]
        }));

        // frame bar (dynamic protocols)
        const frameBox = el('div', { class: 'panel rc-frame-panel', hidden: true });
        S.ui.frameBox = frameBox;
        panel.appendChild(frameBox);

        const layout = el('div', { class: 'rc-layout' });
        panel.appendChild(layout);
        layout.appendChild(buildControls());
        const main = el('div', { class: 'rc-main' });
        layout.appendChild(main);
        main.appendChild(buildImages());
        main.appendChild(buildExplorer());
        const two = el('div', { class: 'rc-two' });
        two.appendChild(buildProfile());
        two.appendChild(buildRoi());
        main.appendChild(two);
        main.appendChild(buildSpecial());
        main.appendChild(buildHowItWorks());

        wireBus();
        S.mounted = true;
        syncControls();
    }

    /* ----- controls ----- */
    function buildControls() {
        const w = W(), box = el('section', { class: 'panel rc-controls', 'aria-label': 'Reconstruction settings' });
        box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Settings' }), el('span', { class: 'spacer' }),
            w.button({ label: 'Reset', size: 'sm', kind: 'ghost', title: 'Back to the default reconstruction (OSEM 4 x 12, TOF, 128 x 128, 3 mm post-filter)',
                onClick: function () { act('resetRecon'); } })]));
        if (!PET.recon) box.appendChild(w.callout('The reconstruction module (js/recon.js) did not load, so these settings have no effect.', 'bad'));

        S.ui.method = w.segmented({ options: METHODS, value: 'osem', ariaLabel: 'Reconstruction method',
            onChange: function (v) { act('setRecon', { method: v }); } });
        box.appendChild(S.ui.method);
        S.ui.methodText = el('p', { class: 'rc-method-text' });
        box.appendChild(S.ui.methodText);

        // FBP group
        const fbp = el('div', { class: 'rc-group' });
        fbp.appendChild(el('div', { class: 'rc-group-title', text: 'Filter' }));
        const filters = PET.recon && PET.recon.filters ? PET.recon.filters.list : [];
        const ctlF = el('div', { class: 'controls' });
        S.ui.filter = w.select({ label: 'Window', options: filters.map(function (f) { return { value: f.id, label: f.name, title: f.description }; }), value: 'hann',
            onChange: function (v) { act('setRecon', { filter: v }); } });
        ctlF.appendChild(S.ui.filter);
        S.ui.cutoff = w.slider({ label: 'Cutoff', min: 0.1, max: 1, step: 0.05, value: 1,
            format: function (v) { return v.toFixed(2) + ' x Nyquist'; },
            hint: 'Frequency where the window reaches zero (Butterworth: 0.71), as a fraction of the Nyquist frequency 0.25 cycles/mm',
            onInput: function (v) { drawFilter(null, v); }, onChange: function (v) { act('setRecon', { cutoff: v }); } });
        ctlF.appendChild(S.ui.cutoff);
        S.ui.order = w.slider({ label: 'Butterworth order', min: 1, max: 10, step: 1, value: 4,
            onInput: function (v) { drawFilter(null, null, v); }, onChange: function (v) { act('setRecon', { order: v }); } });
        ctlF.appendChild(S.ui.order);
        fbp.appendChild(ctlF);
        S.ui.filterDesc = el('p', { class: 'rc-method-text' });
        fbp.appendChild(S.ui.filterDesc);
        S.ui.filterPlot = w.plot(fbp, { height: 140, xlabel: 'spatial frequency (cycles/mm)', title: 'Filter response', framed: false });
        S.ui.fbpGroup = fbp;
        box.appendChild(fbp);

        // iterative group
        const itg = el('div', { class: 'rc-group' });
        itg.appendChild(el('div', { class: 'rc-group-title', text: 'Iterations' }));
        const ctlI = el('div', { class: 'controls' });
        S.ui.iters = w.slider({ label: 'Iterations', min: 1, max: 20, step: 1, value: 4,
            onInput: function (v) { updateEquiv(v, null); }, onChange: function (v) { act('setRecon', { iterations: v }); } });
        ctlI.appendChild(S.ui.iters);
        S.ui.subsets = w.slider({ label: 'Subsets', min: 0, max: SUBSETS.length - 1, step: 1, value: 6,
            format: function (i) { return String(SUBSETS[Math.round(i)]) + ' (' + Math.round(192 / SUBSETS[Math.round(i)]) + ' angles each)'; },
            hint: 'The 192 angles are split into this many interleaved subsets',
            onInput: function (i) { updateEquiv(null, SUBSETS[Math.round(i)]); }, onChange: function (i) { act('setRecon', { subsets: SUBSETS[Math.round(i)] }); } });
        ctlI.appendChild(S.ui.subsets);
        itg.appendChild(ctlI);
        S.ui.equiv = el('p', { class: 'rc-equiv' });
        itg.appendChild(S.ui.equiv);
        S.ui.iterGroup = itg;
        box.appendChild(itg);

        // physics in the model
        const mg = el('div', { class: 'rc-group' });
        mg.appendChild(el('div', { class: 'rc-group-title', text: 'Model' }));
        const tg = el('div', { class: 'rc-toggles' });
        S.ui.tof = w.toggle({ label: 'Time of flight (TOF)', hint: 'Use the arrival-time difference to place each event along its line',
            onChange: function (b) { act('setRecon', { tof: b }); } });
        S.ui.tofNote = el('div', { class: 'rc-sub' });
        S.ui.psf = w.toggle({ label: 'Resolution modelling (PSF)', hint: 'Put the detector blur into the system model (MLEM and OSEM only)',
            onChange: function (b) { act('setRecon', { psf: b }); } });
        S.ui.psfNote = el('div', { class: 'rc-sub' });
        S.ui.range = w.toggle({ label: 'Positron range correction', hint: 'Put the isotope\'s positron range kernel into the system model (MLEM and OSEM only)',
            onChange: function (b) { act('setRecon', { rangeCorrection: b }); } });
        S.ui.rangeNote = el('div', { class: 'rc-sub' });
        [S.ui.tof, S.ui.tofNote, S.ui.psf, S.ui.psfNote, S.ui.range, S.ui.rangeNote].forEach(function (x) { tg.appendChild(x); });
        mg.appendChild(tg);
        box.appendChild(mg);

        // grid and smoothing
        const gg = el('div', { class: 'rc-group' });
        gg.appendChild(el('div', { class: 'rc-group-title', text: 'Image grid' }));
        const ctlG = el('div', { class: 'controls' });
        S.ui.matrix = w.select({ label: 'Matrix', value: 128,
            options: [{ value: 64, label: '64 x 64 (5 mm pixels)' }, { value: 128, label: '128 x 128 (2.5 mm pixels)' }, { value: 256, label: '256 x 256 (1.25 mm pixels)' }],
            onChange: function (v) { act('setRecon', { matrix: v }); } });
        ctlG.appendChild(S.ui.matrix);
        S.ui.post = w.slider({ label: 'Post-filter (Gaussian FWHM)', min: 0, max: 10, step: 0.5, value: 3,
            format: function (v) { return v > 0 ? fmt(v, 2) + ' mm' : 'off'; },
            onChange: function (v) { act('setRecon', { postFilter: v }); } });
        ctlG.appendChild(S.ui.post);
        gg.appendChild(ctlG);
        box.appendChild(gg);

        // corrections summary and status
        const cg = el('div', { class: 'rc-group' });
        cg.appendChild(el('div', { class: 'rc-group-title', text: 'Corrections used' }));
        S.ui.corr = el('div', { class: 'rc-corr' });
        cg.appendChild(S.ui.corr);
        cg.appendChild(el('p', { class: 'rc-method-text' }, [
            'Switch them in the ',
            el('button', { type: 'button', class: 'linklike', onclick: function () { act('showTab', 'corrections'); } }, 'Degradations & corrections'),
            ' tab.'
        ]));
        box.appendChild(cg);

        const sg = el('div', { class: 'rc-group', 'aria-live': 'polite' });
        S.ui.progress = el('div', { class: 'rc-progress is-idle', role: 'progressbar', 'aria-label': 'Reconstruction progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('div'));
        S.ui.status = el('div', { class: 'rc-status', text: 'Waiting for the first scan.' });
        S.ui.notes = el('ul', { class: 'rc-notes' });
        sg.appendChild(S.ui.status);
        sg.appendChild(S.ui.progress);
        sg.appendChild(S.ui.notes);
        box.appendChild(sg);
        return box;
    }

    function updateEquiv(iters, subsets) {
        const r = st().recon || {};
        const it = iters || r.iterations || 1, m = r.method;
        const ss = m === 'mlem' ? 1 : (subsets || r.subsets || 1);
        if (m === 'mlem') {
            S.ui.equiv.innerHTML = 'MLEM uses all 192 angles in every update: <strong>' + it + '</strong> image update' + (it === 1 ? '' : 's') + '. OSEM 4 x 12 does about as much as 48 MLEM iterations.';
        } else {
            S.ui.equiv.innerHTML = 'Equivalent MLEM iterations = iterations x subsets = <strong>' + it + ' x ' + ss + ' = ' + (it * ss) + '</strong>, for the cost of ' + it + '.';
        }
    }

    function drawFilter(name, cutoff, order) {
        const p = S.ui.filterPlot;
        if (!p || !PET.recon || !PET.recon.filters || typeof PET.recon.filters.response !== 'function') return;
        const r = st().recon || {};
        name = name || r.filter || 'hann';
        cutoff = cutoff || (S.ui.cutoff ? S.ui.cutoff.get() : r.cutoff) || 1;
        order = order || (S.ui.order ? S.ui.order.get() : r.order) || 4;
        let R;
        try { R = PET.recon.filters.response(name, cutoff, order, 101); } catch (e) { return; }
        p.draw([
            { x: R.freq, y: R.ramp, label: 'Ramp |ν|', color: 'var(--muted)', dash: true, width: 1.25 },
            { x: R.freq, y: R.window, label: 'Window', color: 'var(--c2)', width: 1.25 },
            { x: R.freq, y: R.response, label: 'Filter used', color: 'var(--c1)', fill: 0.12, width: 2 }
        ], { ylim: [0, 1.05], xfmt: function (v) { return U.fmtNum(v, 2); },
            markers: [{ x: cutoff * R.nyquist, label: 'cutoff', color: 'var(--c2)' }] });
    }

    function corrBadges() {
        const box = S.ui.corr;
        if (!box) return;
        const c = (st().recon || {}).corrections || {};
        box.textContent = '';
        [['normalization', 'Normalisation'], ['attenuation', 'Attenuation'], ['scatter', 'Scatter'], ['randoms', 'Randoms'], ['decay', 'Decay'], ['motion', 'Motion']].forEach(function (p) {
            const on = !!c[p[0]];
            const b = W().badge((on ? '' : 'no ') + p[1].toLowerCase(), on ? 'good' : (p[0] === 'motion' ? 'muted' : 'warn'));
            b.title = p[1] + ' correction is ' + (on ? 'on' : 'off');
            box.appendChild(b);
        });
    }

    const syncControls = safe(function () {
        if (!S.mounted) return;
        const r = st().recon || {}, acq = curAcq(), m = r.method || 'osem';
        const iterative = m === 'mlem' || m === 'osem';
        S.ui.method.set(m);
        S.ui.methodText.textContent = METHOD_TEXT[m] || '';
        S.ui.fbpGroup.hidden = m !== 'fbp';
        S.ui.iterGroup.hidden = !iterative;
        // filter
        S.ui.filter.set(r.filter || 'hann');
        S.ui.cutoff.set(r.cutoff || 1);
        S.ui.order.set(r.order || 4);
        S.ui.order.hidden = r.filter !== 'butterworth';
        const fdef = (PET.recon && PET.recon.filters ? PET.recon.filters.list : []).find(function (f) { return f.id === r.filter; });
        S.ui.filterDesc.textContent = fdef ? fdef.description : '';
        if (m === 'fbp') drawFilter();
        // iterations
        S.ui.iters.setRange(1, m === 'mlem' ? 60 : 20, 1);
        S.ui.iters.set(r.iterations || 4);
        let si = SUBSETS.indexOf(r.subsets);
        if (si < 0) { si = 0; SUBSETS.forEach(function (s, k) { if (Math.abs(s - r.subsets) < Math.abs(SUBSETS[si] - r.subsets)) si = k; }); }
        S.ui.subsets.set(si);
        S.ui.subsets.hidden = m !== 'osem';
        updateEquiv();
        // TOF
        const dataTof = acq && acq.geom ? !!acq.geom.tof : null;
        S.ui.tof.set(!!r.tof);
        S.ui.tof.setDisabled(dataTof === false);
        if (dataTof === false) S.ui.tofNote.textContent = 'This scan has no TOF data (the protocol says tof off), so the reconstruction is non-TOF.';
        else if (m === 'fbp') S.ui.tofNote.textContent = 'FBP has no use for TOF: it sums the TOF bins first. TOF applies to backprojection, MLEM and OSEM.';
        else if (acq && acq.geom && acq.geom.sigmaTOF) S.ui.tofNote.textContent = 'CTR ' + Math.round((acq.geom.ctr || 4e-10) * 1e12) + ' ps: each event is placed to within about ' + Math.round(acq.geom.sigmaTOF * U.FWHM_PER_SIGMA) + ' mm FWHM along its line.';
        else S.ui.tofNote.textContent = '';
        S.ui.psf.set(!!r.psf);
        S.ui.range.set(!!r.rangeCorrection);
        S.ui.psf.setDisabled(!iterative);
        S.ui.range.setDisabled(!iterative);
        S.ui.psfNote.textContent = iterative ? 'Models the detector blur (2.8 mm at the centre, growing off centre with parallax).' : 'Only MLEM and OSEM can put the blur in their model.';
        let rangeTxt = 'Only MLEM and OSEM can put positron range in their model.';
        if (iterative) {
            rangeTxt = 'Models the positron range of the isotope';
            if (acq && PET.isotopes) {
                try { const iso = PET.isotopes.get(acq.isotope), rs = PET.isotopes.rangeStats(iso); rangeTxt += ' (' + iso.label + ': mean range ' + fmt(iso.rangeMean, 2) + ' mm, RMS ' + fmt(rs.rms1D, 2) + ' mm along a line)'; } catch (e) { /* no isotope info */ }
            }
            rangeTxt += '.';
        }
        S.ui.rangeNote.textContent = rangeTxt;
        S.ui.matrix.set(r.matrix || 128);
        S.ui.post.set(r.postFilter === undefined ? 3 : r.postFilter);
        corrBadges();
    }, 'syncing controls');

    /* ----- frame bar ----- */
    const renderFrameBar = safe(function () {
        const box = S.ui.frameBox, acq = curAcq();
        if (!box) return;
        const nF = acq && acq.frames ? acq.frames.length : 0;
        box.hidden = nF <= 1;
        if (nF <= 1) return;
        const f = Math.min(st().frame || 0, nF - 1), F = acq.frames[f];
        if (!S.ui.frameSlider || S.ui.frameN !== nF) {
            box.textContent = '';
            const w = W();
            const row = el('div', { class: 'rc-frame' });
            const prev = w.button({ label: '‹ Prev', size: 'sm', title: 'Previous frame', onClick: function () { act('setFrame', (st().frame || 0) - 1); } });
            const next = w.button({ label: 'Next ›', size: 'sm', title: 'Next frame', onClick: function () { act('setFrame', (st().frame || 0) + 1); } });
            S.ui.frameSlider = w.slider({ label: 'Frame shown (dynamic protocol)', min: 0, max: nF - 1, step: 1, value: f,
                format: function (v) { return (Math.round(v) + 1) + ' of ' + nF; },
                onChange: function (v) { act('setFrame', Math.round(v)); } });
            S.ui.frameTime = el('span', { class: 'rc-frame-time' });
            row.appendChild(S.ui.frameSlider); row.appendChild(prev); row.appendChild(next); row.appendChild(S.ui.frameTime);
            box.appendChild(row);
            S.ui.frameN = nF;
        }
        S.ui.frameSlider.set(f);
        S.ui.frameTime.textContent = fmtMin(F.t0) + ' to ' + fmtMin(F.t1) + ' after injection (' + U.fmtTime(F.dur || (F.t1 - F.t0)) + ')';
    }, 'frame bar');

    /* ----- images ----- */
    function buildImages() {
        const w = W(), box = el('section', { class: 'panel rc-images', 'aria-label': 'Reconstructed image, truth and difference' });
        const head = el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Image, truth and difference' })]);
        S.ui.imgSub = el('span', { class: 'panel-sub' });
        head.appendChild(S.ui.imgSub);
        box.appendChild(head);
        const tb = el('div', { class: 'rc-toolbar' });
        S.ui.unitSeg = w.segmented({ options: [{ value: 'conc', label: 'kBq/mL' }, { value: 'suv', label: 'SUV', title: 'Standardised uptake value: concentration / (dose / body weight)' }],
            value: S.unit, ariaLabel: 'Units', size: 'sm', onChange: function (v) { S.unit = v; renderAll(); } });
        tb.appendChild(S.ui.unitSeg);
        S.ui.cmapSel = w.select({ label: 'Colours', inline: true, value: S.cmap,
            options: [{ value: 'pet', label: 'PET (hot metal)' }, { value: 'inferno', label: 'Inferno' }, { value: 'gray', label: 'Gray' }],
            onChange: function (v) { S.cmap = v; ['vRecon', 'vTruth', 'vIter'].forEach(function (k) { if (S.ui[k]) S.ui[k].setCmap(v); }); } });
        tb.appendChild(S.ui.cmapSel);
        S.ui.outlineTg = w.toggle({ label: 'ROI outline', checked: S.outline, onChange: function (b) { S.outline = b; redrawOverlays(); } });
        tb.appendChild(S.ui.outlineTg);
        box.appendChild(tb);
        const grid = el('div', { class: 'image-grid' });
        box.appendChild(grid);
        S.ui.vRecon = makeView(grid, 'Reconstruction', 'No scan yet: press Acquire', true);
        S.ui.vTruth = makeView(grid, 'Truth (same grid)', 'The truth appears with the first scan');
        S.ui.vDiff = makeView(grid, 'Difference (image minus truth)', 'Nothing to compare yet');
        S.ui.vDiff.setCmap(DIFF_CMAP);
        box.appendChild(el('p', { class: 'note mt-1 mb-0' }, 'Drag on an image to change its window and level, double-click to reset; hover to read values (the circle follows on all three); click to move the profile line. The truth is the phantom\'s true concentration averaged over each pixel, so it already shows the partial volume of the pixel grid.'));
        return box;
    }

    const renderImages = safe(function () {
        const acq = curAcq(), res = curResult();
        const vR = S.ui.vRecon, vT = S.ui.vTruth, vD = S.ui.vDiff;
        if (!vR) return;
        const suvOk = suvAvailable(acq);
        S.ui.unitSeg.setDisabled(false);
        if (!suvOk && S.unit === 'suv') { S.unit = 'conc'; S.ui.unitSeg.set('conc'); }
        if (S.ui.unitSeg.group) {
            const sb = S.ui.unitSeg.group.querySelectorAll('button')[1];
            if (sb) { sb.disabled = !suvOk; sb.title = suvOk ? 'Standardised uptake value: concentration / (dose / body weight)' : 'SUV needs a patient (a tracer, a dose and a body weight); phantoms are read in kBq/mL'; }
        }
        if (!acq || !res || !res.image) {
            const msg = st().scanning ? 'Scanning...' : (acq ? (PET.recon ? 'Reconstructing...' : 'The reconstruction module did not load') : 'No scan yet: press Acquire');
            vR.clear(msg); vT.clear(acq ? 'Waiting for the reconstruction' : 'The truth appears with the first scan'); vD.clear('Nothing to compare yet');
            S.ui.imgSub.textContent = '';
            return;
        }
        const n = res.n, ds = displayScale(acq);
        S.n = n;
        const img = scaled(res.image, ds.f);
        const truthRaw = truthFor(acq, res), truth = scaled(truthRaw, ds.f);
        S.disp = { n: n, recon: img, truth: truth, diff: null };
        const ph = phantomOf(acq), kind = kindOf(ph);
        // A shared window, so a reconstruction that reads low looks dim
        // next to the truth (the point sources are too small for that).
        let hi = robustMax(img);
        if (truth && kind !== 'point') hi = Math.max(hi, 1.2 * maxOf(truth));
        if (!(hi > 0)) hi = 1;
        const tHi = truth ? (kind === 'point' ? maxOf(truth) : hi) : hi;
        const it = res.info || {}, frameLbl = res.frame === 'all' ? 'all frames' : (acq.frames.length > 1 ? 'frame ' + (res.frame + 1) + ' of ' + acq.frames.length : '');
        const label = { bp: 'Backprojection', fbp: 'FBP', mlem: 'MLEM', osem: 'OSEM' }[res.method] || res.method;
        vR.setTitle('Reconstruction, ' + label + (frameLbl ? ', ' + frameLbl : '') + ' (' + ds.unit + ')');
        vR.setData(img, n, n, { min: 0, max: hi, cmap: S.cmap });
        if (truth) {
            vT.setTitle('Truth (' + ds.unit + ')');
            vT.setData(truth, n, n, { min: 0, max: tHi > 0 ? tHi : 1, cmap: S.cmap });
            const diff = new Float32Array(img.length);
            let mx = 0;
            for (let k = 0; k < img.length; k++) { diff[k] = img[k] - truth[k]; }
            const absd = new Float32Array(img.length);
            for (let k = 0; k < img.length; k++) absd[k] = Math.abs(diff[k]);
            mx = Math.max(robustMax(absd), 0.05 * hi);
            vD.setTitle('Difference, image minus truth (' + ds.unit + ')');
            vD.setData(diff, n, n, { min: -mx, max: mx, cmap: DIFF_CMAP });
            S.disp.diff = diff;
        } else {
            vT.clear(PET.analysis ? 'No truth for this scan' : 'The analysis module (js/analysis.js) did not load');
            vD.clear('Nothing to compare');
        }
        const tStr = st().reconMs && !res.partialFlag ? ' · ' + U.fmtTime(st().reconMs / 1000) : '';
        S.ui.imgSub.textContent = n + ' x ' + n + ', ' + fmt(FOV / n, 3) + ' mm pixels' + (it.tofUsed ? ' · TOF' : '') + (it.psf ? ' · PSF' : '') + tStr;
    }, 'images');

    /* ----- iteration explorer ----- */
    function buildExplorer() {
        const w = W(), box = el('section', { class: 'panel rc-explorer-panel', 'aria-label': 'Iteration explorer' });
        box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Iteration explorer' }),
            el('span', { class: 'panel-sub', text: 'bias falls, noise rises: where to stop is a choice' })]));
        S.ui.explEmpty = el('div', { class: 'empty', text: 'Choose MLEM or OSEM to watch the image converge iteration by iteration.' });
        box.appendChild(S.ui.explEmpty);
        const body = el('div', { class: 'rc-explorer' });
        const left = el('div');
        S.ui.vIter = makeView(left, 'Iteration', 'No iterations stored', true);
        const scrub = el('div', { class: 'rc-scrub' });
        S.ui.play = w.button({ label: 'Play', size: 'sm', title: 'Step through the iterations', onClick: togglePlay });
        S.ui.iterSlider = w.slider({ label: 'Iteration', min: 1, max: 2, step: 1, value: 1,
            onInput: function (v) { S.iterK = Math.round(v) - 1; stopPlay(); renderIterImage(); markConvergence(); } });
        scrub.appendChild(S.ui.play); scrub.appendChild(S.ui.iterSlider);
        left.appendChild(scrub);
        body.appendChild(left);
        const right = el('div');
        const sel = el('div', { class: 'controls', style: '--min: 170px; margin-bottom: 8px' });
        S.ui.hotSel = w.select({ label: 'Recovery in', options: [], onChange: function (v) { S.hot = v; renderConvergence(); } });
        S.ui.uniSel = w.select({ label: 'Noise in', options: [], onChange: function (v) { S.uni = v; renderConvergence(); } });
        sel.appendChild(S.ui.hotSel); sel.appendChild(S.ui.uniSel);
        right.appendChild(sel);
        S.ui.convPlot = w.plot(right, { height: 210, xlabel: 'iteration', ylabel: '%', title: 'Convergence', legend: true });
        S.ui.convNote = el('p', { class: 'note mt-1 mb-0' });
        right.appendChild(S.ui.convNote);
        body.appendChild(right);
        S.ui.explBody = body;
        box.appendChild(body);
        return box;
    }
    function stopPlay() {
        if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; }
        if (S.ui.play) S.ui.play.textContent = 'Play';
    }
    function togglePlay() {
        const res = curResult();
        if (S.playTimer) { stopPlay(); return; }
        if (!res || !res.iterations || !res.iterations.length) return;
        const K = res.iterations.length;
        if (S.iterK === null || S.iterK >= K - 1) S.iterK = -1;
        S.ui.play.textContent = 'Pause';
        S.playTimer = setInterval(function () {
            const r = curResult();
            if (!r || !r.iterations || !S.visible) { stopPlay(); return; }
            S.iterK = Math.min(r.iterations.length - 1, (S.iterK === null ? -1 : S.iterK) + 1);
            S.ui.iterSlider.set(S.iterK + 1);
            renderIterImage(); markConvergence();
            if (S.iterK >= r.iterations.length - 1) stopPlay();
        }, 450);
    }
    function explorerRois(ph, acq, frame) {
        const defs = roiList(ph), kind = kindOf(ph);
        const truth = acq && acq.frames && acq.frames[frame === 'all' ? 0 : frame] ? acq.frames[frame === 'all' ? 0 : frame].truth : null;
        const regIdx = {};
        if (ph) ph.regions.forEach(function (r, k) { regIdx[r.id] = k; });
        const meanTrue = function (d) {
            if (!truth || !truth.regionMean) return 0;
            let s = 0, v = 0;
            d.regions.forEach(function (id) { const k = regIdx[id]; if (k === undefined) return; const p = ph.regions[k].pixels || 0; s += p * (truth.regionMean[k] || 0); v += p; });
            return v > 0 ? s / v : 0;
        };
        const hot = defs.filter(function (d) { return meanTrue(d) > 0; });
        let hotDef = null, uniDef = null;
        const pick = function (list, ids) { for (let i = 0; i < ids.length; i++) { const d = list.find(function (x) { return x.id === ids[i]; }); if (d) return d.id; } return null; };
        if (kind === 'brain') {
            const c = hot.find(function (d) { return d.id === 'cortex'; }), s = hot.find(function (d) { return d.id === 'striatum'; });
            hotDef = c && s ? (meanTrue(s) > 1.2 * meanTrue(c) ? 'striatum' : 'cortex') : (c ? 'cortex' : (s ? 'striatum' : null));
            uniDef = pick(hot, ['white_matter', 'wm', 'cerebellum']);
        } else if (kind === 'cylinder') { hotDef = pick(hot, ['centre', 'whole']); uniDef = pick(hot, ['centre', 'whole']); }
        else if (kind === 'spheres') { hotDef = pick(hot, ['sphere10', 'sphere13', 'sphere22']); uniDef = pick(hot, ['background']); }
        else if (kind === 'rods') { hotDef = pick(hot, ['rods5', 'rods6', 'rods_5mm']); uniDef = pick(hot, ['rods10', 'rods_10mm']); }
        else if (kind === 'point') { hotDef = pick(hot, ['src_0']); uniDef = null; }
        if (!hotDef && hot.length) hotDef = hot[0].id;
        return { hot: hot, hotDef: hotDef, uniDef: uniDef, meanTrue: meanTrue };
    }
    const renderExplorer = safe(function () {
        const res = curResult(), acq = curAcq(), r = st().recon || {};
        const iterative = r.method === 'mlem' || r.method === 'osem';
        const have = !!(res && res.iterations && res.iterations.length && (res.method === 'mlem' || res.method === 'osem'));
        S.ui.explEmpty.hidden = have;
        S.ui.explBody.hidden = !have;
        if (!have) {
            stopPlay();
            S.ui.explEmpty.textContent = iterative ? (st().scanning ? 'The iterations appear when the scan has finished.' : 'Reconstructing: the iterations appear when it finishes.') :
                'Choose MLEM or OSEM to watch the image converge iteration by iteration. Backprojection and FBP are one-step methods.';
            return;
        }
        const K = res.iterations.length;
        if (S.lastResult !== res) { S.iterK = K - 1; }
        S.ui.iterSlider.setRange(1, Math.max(2, K), 1);
        S.ui.iterSlider.setDisabled(K < 2);
        S.ui.iterSlider.set((S.iterK === null ? K - 1 : Math.min(S.iterK, K - 1)) + 1);
        // ROI choices
        const ph = phantomOf(acq), info = explorerRois(ph, acq, res.frame);
        if (S.explPh !== ph) { S.explPh = ph; S.hot = null; S.uni = null; }
        const opts = info.hot.map(function (d) { return { value: d.id, label: d.name }; });
        if (!S.hot || !opts.some(function (o) { return o.value === S.hot; })) S.hot = info.hotDef;
        S.ui.hotSel.setOptions(opts, S.hot);
        const uopts = [{ value: '', label: 'none' }].concat(opts);
        if (S.uni === null || (S.uni && !opts.some(function (o) { return o.value === S.uni; }))) S.uni = info.uniDef || '';
        S.ui.uniSel.setOptions(uopts, S.uni);
        renderIterImage();
        renderConvergence();
    }, 'iteration explorer');
    function renderIterImage() {
        const res = curResult(), acq = curAcq(), v = S.ui.vIter;
        if (!v || !res || !res.iterations || !res.iterations.length) return;
        const K = res.iterations.length, k = U.clamp(S.iterK === null ? K - 1 : S.iterK, 0, K - 1);
        const ds = displayScale(acq), img = scaled(res.iterations[k], ds.f);
        const win = S.ui.vRecon ? S.ui.vRecon.getWindow() : null;
        const ss = res.method === 'osem' ? (res.info && res.info.subsets) || (st().recon || {}).subsets || 1 : 1;
        v.setTitle('Iteration ' + (k + 1) + ' of ' + K + (res.method === 'osem' ? ' (' + ((k + 1) * ss) + ' subset updates)' : ''));
        v.setData(img, res.n, res.n, win ? { min: win.min, max: win.max, cmap: S.cmap } : { cmap: S.cmap });
    }
    function convergenceData(res, acq) {
        const c = S.caches.conv;
        if (c && c.res === res && c.hot === S.hot && c.uni === S.uni && c.unit === S.unit) return c.data;
        const ph = phantomOf(acq), m = res.n, truth = truthFor(acq, res);
        const data = { x: [], rec: [], cov: [], hotName: '', uniName: '' };
        if (!ph || !truth) return data;
        const defs = roiList(ph);
        const hd = defs.find(function (d) { return d.id === S.hot; }), ud = defs.find(function (d) { return d.id === S.uni; });
        const hm = hd ? roiMask(ph, m, hd.id) : null;
        const um = ud ? (roiMask(ph, m, ud.id, { erode: kindOf(ph) === 'brain' ? 0 : 1 }) || roiMask(ph, m, ud.id)) : null;
        const tMean = hm ? PET.analysis.roiStats(truth, hm).mean : NaN;
        data.hotName = hd ? hd.name : ''; data.uniName = ud ? ud.name : '';
        res.iterations.forEach(function (im, k) {
            data.x.push(k + 1);
            data.rec.push(hm && tMean > 0 ? 100 * PET.analysis.roiStats(im, hm).mean / tMean : NaN);
            data.cov.push(um ? 100 * PET.analysis.roiStats(im, um).cov : NaN);
        });
        S.caches.conv = { res: res, hot: S.hot, uni: S.uni, unit: S.unit, data: data };
        return data;
    }
    function renderConvergence() {
        const res = curResult(), acq = curAcq();
        if (!res || !res.iterations || !res.iterations.length || !PET.analysis) return;
        const d = convergenceData(res, acq), K = res.iterations.length, k = S.iterK === null ? K - 1 : S.iterK;
        const series = [{ x: d.x, y: d.rec, label: 'Recovery (mean / true)', color: 'var(--c1)', points: K <= 30 ? 3 : false }];
        if (d.uniName) series.push({ x: d.x, y: d.cov, label: 'Noise (CoV)', color: 'var(--c2)', points: K <= 30 ? 3 : false });
        S.ui.convPlot.draw(series, { includeZero: true, xlim: [1, Math.max(2, K)], hlines: [{ y: 100, label: 'truth', color: 'var(--muted)' }],
            markers: [{ x: k + 1, label: 'shown', color: 'var(--fg)' }], xfmt: function (v) { return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : ''; },
            yfmt: function (v) { return U.fmtNum(v, 3); } });
        const r0 = d.rec[0], rK = d.rec[K - 1], c0 = d.cov[0], cK = d.cov[K - 1];
        let txt = '';
        if (isFinite(r0) && isFinite(rK)) txt += 'Recovery in ' + d.hotName + ' goes from ' + Math.round(r0) + ' % after one iteration to ' + Math.round(rK) + ' % after ' + K + '. ';
        if (isFinite(c0) && isFinite(cK)) txt += 'Noise (pixel-to-pixel coefficient of variation) in ' + d.uniName + ' goes from ' + fmt(c0, 2) + ' % to ' + fmt(cK, 2) + ' %. ';
        txt += 'Early stopping and post-filtering are both ways of trading resolution for noise.';
        S.ui.convNote.textContent = txt;
    }
    function markConvergence() { renderConvergence(); }

    /* ----- profile ----- */
    function buildProfile() {
        const w = W(), box = el('section', { class: 'panel', 'aria-label': 'Line profile' });
        box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Line profile' }),
            el('span', { class: 'panel-sub', text: 'click an image to move the line' })]));
        const row = el('div', { class: 'controls', style: '--min: 150px; margin-bottom: 8px' });
        S.ui.profOrient = w.segmented({ label: 'Direction', options: [{ value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }], value: 'h', size: 'sm',
            onChange: function (v) {
                S.prof.orient = v;
                if (S.prof.cross) { S.prof.pos = v === 'h' ? S.prof.cross.y : S.prof.cross.x; S.ui.profPos.set(S.prof.pos); }
                S.ui.profPos.setLabel(v === 'h' ? 'At y' : 'At x');
                redrawOverlays(); renderProfile();
            } });
        S.ui.profPos = w.slider({ label: 'At y', min: -150, max: 150, step: 1.25, value: 0, unit: 'mm',
            onInput: function (v) { S.prof.pos = v; S.prof.cross = null; redrawOverlays(); renderProfile(); } });
        row.appendChild(S.ui.profOrient); row.appendChild(S.ui.profPos);
        box.appendChild(row);
        S.ui.profPlot = w.plot(box, { height: 200, xlabel: 'position (mm)', title: '', legend: true });
        S.ui.profNote = el('p', { class: 'note mt-1 mb-0' });
        box.appendChild(S.ui.profNote);
        return box;
    }
    const renderProfile = safe(function () {
        const res = curResult(), acq = curAcq(), p = S.ui.profPlot;
        if (!p) return;
        if (!res || !res.image || !PET.analysis) { p.draw([]); S.ui.profNote.textContent = 'The profile appears with the first reconstruction.'; return; }
        const n = res.n, dx = FOV / n, h = Math.floor(n / 2), ds = displayScale(acq);
        const a = -h * dx, b = (n - 1 - h) * dx, pos = S.prof.pos;
        const ends = S.prof.orient === 'h' ? [a, pos, b, pos] : [pos, a, pos, b];
        const pr = PET.analysis.profile(res.image, n, FOV, ends[0], ends[1], ends[2], ends[3], n);
        const xs = new Float64Array(pr.s.length);
        for (let k = 0; k < xs.length; k++) xs[k] = a + pr.s[k];
        const series = [{ x: xs, y: Array.from(pr.v, function (v) { return v * ds.f; }), label: 'Reconstruction', color: 'var(--c1)', width: 1.75 }];
        const truth = truthFor(acq, res);
        if (truth) {
            const pt = PET.analysis.profile(truth, n, FOV, ends[0], ends[1], ends[2], ends[3], n);
            series.push({ x: xs, y: Array.from(pt.v, function (v) { return v * ds.f; }), label: 'Truth', color: 'var(--muted)', dash: true, width: 1.5 });
        }
        p.setTitle((S.prof.orient === 'h' ? 'Horizontal profile at y = ' : 'Vertical profile at x = ') + fmt(pos, 3) + ' mm (' + ds.unit + ')');
        p.draw(series, { includeZero: true, markers: S.prof.cross ? [{ x: S.prof.orient === 'h' ? S.prof.cross.x : S.prof.cross.y, color: 'var(--c3)' }] : [] });
        S.ui.profNote.textContent = 'Edges in the reconstruction are softer than in the truth (finite resolution); small hot objects read low and cold ones fill in. ' +
            (S.prof.orient === 'h' ? 'Left is the patient\'s right in brain images.' : 'Up is anterior in brain images.');
    }, 'profile');

    /* ----- ROI statistics ----- */
    function buildRoi() {
        const w = W(), box = el('section', { class: 'panel', 'aria-label': 'ROI statistics' });
        box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Region of interest' }),
            el('span', { class: 'panel-sub', text: 'drawn from the phantom\'s own labels' })]));
        S.ui.roiSel = w.select({ label: 'ROI', options: [], onChange: function (v) {
            S.roiLocal = v;
            act('setAnalysis', { roi: v });
            renderRoi(); redrawOverlays();
        } });
        box.appendChild(S.ui.roiSel);
        S.ui.roiTable = w.statTable([], { compact: false });
        S.ui.roiTable.classList.add('mt-1');
        box.appendChild(S.ui.roiTable);
        S.ui.roiNote = el('p', { class: 'note mt-1 mb-0' });
        box.appendChild(S.ui.roiNote);
        return box;
    }
    const renderRoi = safe(function () {
        const res = curResult(), acq = curAcq();
        const ph = phantomOf(acq), defs = roiList(ph);
        const id = currentRoi(ph, defs);
        S.ui.roiSel.setOptions(defs.map(function (d) { return { value: d.id, label: d.name + (d.reference ? ' (reference)' : '') }; }), id);
        if (!res || !res.image || !ph || !id || !PET.analysis) {
            S.ui.roiTable.update([]);
            S.ui.roiNote.textContent = ph ? 'Statistics appear with the first reconstruction.' : 'No phantom yet.';
            S.caches.outline = null;
            return;
        }
        const m = res.n, mask = roiMask(ph, m, id);
        if (!mask) { S.ui.roiTable.update([]); return; }
        if (!S.caches.outline || S.caches.outline.id !== id || S.caches.outline.m !== m || S.caches.outline.ph !== ph) {
            S.caches.outline = { id: id, m: m, ph: ph, segs: outlineSegments(mask, m) };
        }
        const ds = displayScale(acq), s = PET.analysis.roiStats(res.image, mask);
        const truth = truthFor(acq, res), tm = truth ? PET.analysis.roiStats(truth, mask).mean : NaN;
        const rec = tm > 0 ? s.mean / tm : NaN;
        const recKind = !isFinite(rec) ? null : (Math.abs(rec - 1) <= 0.1 ? 'good' : (Math.abs(rec - 1) <= 0.25 ? 'warn' : 'bad'));
        S.ui.roiTable.update([
            { label: 'Mean', value: fmt(s.mean * ds.f, 4), unit: ds.unit },
            { label: 'Standard deviation', value: fmt(s.sd * ds.f, 3), unit: ds.unit },
            { label: 'Coefficient of variation (noise)', value: pct(s.cov, 1), hint: 'SD / mean of the pixel values: noise plus any real non-uniformity inside the ROI' },
            { label: 'Maximum', value: fmt(s.max * ds.f, 4), unit: ds.unit },
            { label: 'True mean', value: isFinite(tm) ? fmt(tm * ds.f, 4) : '-', unit: ds.unit },
            { label: 'Recovery (mean / true)', value: tm > 0 ? pct(rec, 0) : (isFinite(tm) ? 'no activity' : '-'), kind: recKind,
                hint: 'Below 100 %: partial volume, missing corrections or too few iterations; above: spill-in or over-correction' },
            { label: 'Pixels', value: String(s.nPix) }
        ]);
        const d = defs.find(function (x) { return x.id === id; });
        S.ui.roiNote.textContent = (d && d.circle ? 'A ' + (2 * d.circle.r) + ' mm disk, away from the edges. ' : 'Pixels at least half inside the region. ') +
            (tm === 0 ? 'This region holds no activity: whatever it reads is spill-in, scatter or noise.' :
                'Small or thin regions read low: the blur spreads their counts into their surroundings (partial volume).');
    }, 'ROI statistics');

    /* ----- phantom-specific measurements ----- */
    function buildSpecial() {
        const box = el('section', { class: 'panel rc-special', 'aria-label': 'Measurements for this phantom' });
        S.ui.specTitle = el('h2', { class: 'panel-title', text: 'Measurements' });
        S.ui.specSub = el('span', { class: 'panel-sub' });
        box.appendChild(el('div', { class: 'panel-head' }, [S.ui.specTitle, S.ui.specSub]));
        S.ui.specBody = el('div');
        box.appendChild(S.ui.specBody);
        return box;
    }
    const renderSpecial = safe(function () {
        const res = curResult(), acq = curAcq(), body = S.ui.specBody;
        if (!body) return;
        const ph = phantomOf(acq), kind = kindOf(ph);
        if (!res || !res.image || !ph || !PET.analysis) {
            S.ui.specTitle.textContent = 'Measurements';
            S.ui.specSub.textContent = '';
            body.textContent = '';
            body.appendChild(W().empty('Phantom-specific measurements (resolution, contrast recovery, uniformity) appear with the first reconstruction.'));
            return;
        }
        if (res.partialFlag) return;           // keep the last full numbers during playback
        const key = res;
        if (S.caches.special && S.caches.special.key === key && S.caches.special.unit === S.unit) return;
        S.caches.special = { key: key, unit: S.unit };
        body.textContent = '';
        if (kind === 'point') specialPoint(res, ph, body);
        else if (kind === 'spheres') specialSpheres(res, ph, body);
        else if (kind === 'rods') specialRods(res, ph, body);
        else if (kind === 'cylinder') specialCylinder(res, acq, ph, body);
        else specialBrain(res, acq, ph, body);
    }, 'phantom measurements');

    function specialPoint(res, ph, body) {
        S.ui.specTitle.textContent = 'Spatial resolution';
        S.ui.specSub.textContent = 'FWHM of each line source (NEMA NU 2 style)';
        const rows = [];
        ph.regions.forEach(function (r) {
            if (!(r.rel > 0) || r.cx === undefined) return;
            const p = PET.analysis.pointResolution(res.image, res.n, FOV, r.cx, r.cy);
            const dist = Math.hypot(r.cx, r.cy);
            rows.push([td(r.name), td(fmt(dist, 3) + ' mm'), td(isFinite(p.radial) ? p.radial.toFixed(2) : '-'), td(isFinite(p.tangential) ? p.tangential.toFixed(2) : '-'),
                td(isFinite(p.radialFWTM) ? p.radialFWTM.toFixed(1) : '-')]);
        });
        const wrap = el('div', { class: 'rc-table-wrap' });
        wrap.appendChild(dataTable(['Source', 'From centre', 'Radial FWHM (mm)', 'Tangential FWHM (mm)', 'Radial FWTM (mm)'], rows));
        body.appendChild(wrap);
        const r = st().recon || {};
        body.appendChild(el('p', { class: 'note mt-1' }, 'Radial blur grows off centre while tangential blur does not: a photon from an off-centre source enters the 20 mm deep crystals at a slant, and where along the crystal it stops is unknown (depth-of-interaction parallax, 2.8 mm at the centre, about 9 mm extra at the ring). ' +
            'Resolution modelling (PSF) puts that blur in the model and recovers much of it.'));
        const tips = [], iterative = res.method === 'mlem' || res.method === 'osem';
        if (res.n < 128) tips.push('the ' + fmt(FOV / res.n, 2) + ' mm pixels are too coarse to measure a 3 mm FWHM (use 128 x 128)');
        if (r.postFilter > 0) tips.push('the ' + r.postFilter + ' mm post-filter adds blur (set it to off)');
        if (iterative && res.n >= 256) tips.push('at 256 x 256 the 1.25 mm pixels are finer than the 2 mm sinogram bins, so MLEM and OSEM can make an isolated point unrealistically sharp, with ripples beside it: measure at 128 x 128, or with FBP and a ramp filter');
        body.appendChild(el('p', { class: 'simplification' }, (tips.length ? 'For the scanner\'s own resolution: ' + tips.join('; ') + '. ' : '') +
            'MLEM and OSEM sharpen an isolated point in an empty background more than they sharpen real objects, so these numbers flatter them; FBP is linear and gives the same FWHM for any object.'));
    }

    function specialSpheres(res, ph, body) {
        S.ui.specTitle.textContent = 'Image quality (NEMA)';
        const q = PET.analysis.nemaIQ(res.image, res.n, FOV, ph);
        S.ui.specSub.textContent = 'contrast recovery of each sphere and background variability';
        if (!q || !q.spheres || !q.spheres.length) { body.appendChild(W().empty('No spheres found in this phantom.')); return; }
        const two = el('div', { class: 'rc-two' });
        const rows = q.spheres.map(function (s) {
            const k = s.recovery >= 0.8 ? 'good' : (s.recovery >= 0.5 ? 'warn' : 'bad');
            return [td(s.d + ' mm ' + s.kind), td(fmt(s.contrast, 3)), td(isFinite(s.trueContrast) ? fmt(s.trueContrast, 3) : '-'), td(pct(s.recovery), k), td(pct(s.variability, 1))];
        });
        const left = el('div', { class: 'rc-table-wrap' });
        left.appendChild(dataTable(['Sphere', 'Measured ratio', 'True ratio', 'Recovery', 'Bkg variability'], rows));
        const extra = [];
        extra.push('Background ' + fmt(q.bgMean * 1e-3, 3) + ' kBq/mL');
        if (q.lung) extra.push('lung insert residual ' + pct(q.lung.residual, 1) + ' of background (scatter and spill-in; ideally 0)');
        left.appendChild(el('p', { class: 'note mt-1 mb-0' }, extra.join('; ') + '.'));
        two.appendChild(left);
        const right = el('div');
        const pl = W().plot(right, { height: 190, xlabel: 'sphere diameter (mm)', ylabel: 'recovery (%)', title: 'Recovery vs diameter', legend: true });
        const hot = q.spheres.filter(function (s) { return s.kind === 'hot'; }), cold = q.spheres.filter(function (s) { return s.kind === 'cold'; });
        const ser = [];
        if (hot.length) ser.push({ x: hot.map(function (s) { return s.d; }), y: hot.map(function (s) { return 100 * s.recovery; }), label: 'Hot (contrast recovery)', color: 'var(--c1)', points: 4 });
        if (cold.length) ser.push({ x: cold.map(function (s) { return s.d; }), y: cold.map(function (s) { return 100 * s.recovery; }), label: 'Cold (1 - ratio)', color: 'var(--c7)', points: 4 });
        pl.draw(ser, { xlim: [8, 40], ylim: [0, 110], hlines: [{ y: 100, label: 'full recovery', color: 'var(--muted)' }] });
        two.appendChild(right);
        body.appendChild(two);
        body.appendChild(el('p', { class: 'note mt-1 mb-0' }, 'Hot spheres smaller than about three times the resolution lose contrast (partial volume); cold spheres fill in from scatter and spill-in. ' +
            'More iterations, PSF and TOF raise recovery; so does turning off the post-filter, at the price of background variability.'));
        body.appendChild(el('p', { class: 'simplification' }, 'NEMA averages five slices and twelve background ROIs; here there is one slice, and in one slice through their centres the spheres behave as rods, so recovery is a little better than for real spheres.'));
    }

    function specialRods(res, ph, body) {
        S.ui.specTitle.textContent = 'Which rods are resolved';
        S.ui.specSub.textContent = 'valley between neighbouring rods, relative to the rod peaks';
        const n = res.n, dx = FOV / n, h = Math.floor(n / 2);
        const at = function (x, y) { return U.bilinear(res.image, n, n, x / dx + h, y / dx + h); };
        const rows = [];
        let best = null;
        ph.regions.forEach(function (rg) {
            if (!rg.centres || !rg.centres.length) return;
            const C = rg.centres, s = rg.spacing || 2 * rg.diameter;
            let pk = 0, vl = 0, nv = 0;
            C.forEach(function (c) { pk += at(c[0], c[1]); });
            pk /= C.length;
            for (let i = 0; i < C.length; i++) for (let j = i + 1; j < C.length; j++) {
                const d = Math.hypot(C[i][0] - C[j][0], C[i][1] - C[j][1]);
                if (Math.abs(d - s) < 0.1 * s) { vl += at((C[i][0] + C[j][0]) / 2, (C[i][1] + C[j][1]) / 2); nv++; }
            }
            const vp = nv && pk > 0 ? vl / nv / pk : NaN;
            const verdict = !isFinite(vp) ? '-' : (vp <= 0.5 ? 'resolved' : (vp <= 0.8 ? 'partly resolved' : 'merged'));
            const k = verdict === 'resolved' ? 'good' : (verdict === 'partly resolved' ? 'warn' : 'bad');
            if (verdict === 'resolved' && (best === null || rg.diameter < best)) best = rg.diameter;
            rows.push([td(rg.diameter + ' mm rods'), td(fmt(s, 3) + ' mm'), td(pct(vp)), td(verdict, k)]);
        });
        const wrap = el('div', { class: 'rc-table-wrap' });
        wrap.appendChild(dataTable(['Group', 'Spacing', 'Valley / peak', 'Verdict'], rows));
        body.appendChild(wrap);
        let iso = null;
        try { iso = PET.isotopes.get(curAcq().isotope); } catch (e) { /* none */ }
        body.appendChild(el('p', { class: 'note mt-1' }, (best !== null ? 'The smallest rods clearly separated here are ' + best + ' mm. ' : 'No group is clearly separated. ') +
            'A valley below half the peak height separates the rods clearly; above about 80 % they have merged. ' +
            (iso ? 'This scan used ' + iso.label + ' (mean positron range ' + fmt(iso.rangeMean, 2) + ' mm). ' : '') +
            'Change the isotope to O15 in the Protocol tab to watch positron range blur the small rods together.'));
    }

    function specialCylinder(res, acq, ph, body) {
        S.ui.specTitle.textContent = 'Uniformity and calibration';
        S.ui.specSub.textContent = 'a uniform object should read the same everywhere';
        const m = res.n, A = PET.analysis, ds = displayScale(acq);
        const cen = A.circleMask(m, FOV, 0, 0, 30), mid = A.roiMask(ph, m, 'centre');
        const rim = A.circleMask(m, FOV, 0, 0, 90), inner = A.circleMask(m, FOV, 0, 0, 70);
        for (let k = 0; k < rim.length; k++) rim[k] = rim[k] > 0 && !(inner[k] > 0) ? 1 : 0;
        const truth = truthFor(acq, res);
        const sc = A.roiStats(res.image, cen), sr = A.roiStats(res.image, rim), sm = mid ? A.roiStats(res.image, mid) : sc;
        const tm = truth ? A.roiStats(truth, mid || cen).mean : NaN;
        const ratio = sc.mean / sr.mean;
        S.ui.specTable = W().statTable([
            { label: 'Mean, centre disk (radius 70 mm)', value: fmt(sm.mean * ds.f, 4), unit: ds.unit },
            { label: 'True concentration', value: fmt(tm * ds.f, 4), unit: ds.unit },
            { label: 'Calibration (measured / true)', value: pct(sm.mean / tm, 1), kind: Math.abs(sm.mean / tm - 1) < 0.05 ? 'good' : 'warn' },
            { label: 'Noise (CoV in the centre disk)', value: pct(sm.cov, 1) },
            { label: 'Centre (r < 30 mm) / rim (70 to 90 mm)', value: fmt(ratio, 3), kind: Math.abs(ratio - 1) < 0.05 ? 'good' : 'bad',
                hint: 'Below 1: a dip in the middle (attenuation not corrected); above 1: a hot middle (over-correction)' }
        ]);
        body.appendChild(S.ui.specTable);
        body.appendChild(el('p', { class: 'note mt-1 mb-0' }, 'Without attenuation correction the centre reads far lower than the rim, because photons from the middle cross the most water. ' +
            'Calibration off by much more than noise points to a missing correction (attenuation, scatter, decay) or a too-short reconstruction.'));
    }

    function specialBrain(res, acq, ph, body) {
        S.ui.specTitle.textContent = 'Regional values';
        S.ui.specSub.textContent = 'measured against the true concentration of each region';
        const m = res.n, A = PET.analysis, ds = displayScale(acq), truth = truthFor(acq, res);
        const defs = roiList(ph).filter(function (d) { return ['cortex', 'white_matter', 'striatum', 'putamen_l', 'putamen_r', 'caudate', 'cerebellum'].indexOf(d.id) >= 0; });
        const rows = [];
        const vals = {};
        defs.forEach(function (d) {
            const mk = roiMask(ph, m, d.id);
            if (!mk) return;
            const s = A.roiStats(res.image, mk), t = truth ? A.roiStats(truth, mk).mean : NaN;
            vals[d.id] = { m: s.mean, t: t };
            const rec = t > 0 ? s.mean / t : NaN;
            rows.push([td(d.name), td(fmt(s.mean * ds.f, 3)), td(fmt(t * ds.f, 3)), td(pct(rec), isFinite(rec) ? (Math.abs(rec - 1) <= 0.1 ? 'good' : (Math.abs(rec - 1) <= 0.25 ? 'warn' : 'bad')) : null)]);
        });
        const wrap = el('div', { class: 'rc-table-wrap' });
        wrap.appendChild(dataTable(['Region', 'Measured (' + ds.unit + ')', 'True (' + ds.unit + ')', 'Recovery'], rows));
        body.appendChild(wrap);
        const parts = [];
        if (vals.cortex && vals.white_matter && vals.white_matter.m > 0) {
            parts.push('Cortex to white matter: measured ' + fmt(vals.cortex.m / vals.white_matter.m, 3) + ', true ' + fmt(vals.cortex.t / vals.white_matter.t, 3) + '.');
        }
        if (vals.striatum && vals.cerebellum && vals.cerebellum.m > 0) {
            parts.push('Striatum to cerebellum: measured ' + fmt(vals.striatum.m / vals.cerebellum.m, 3) + ', true ' + fmt(vals.striatum.t / vals.cerebellum.t, 3) + '.');
        }
        parts.push('The cortical ribbon is about 3 mm thick, close to the resolution, so it reads low and white matter reads high (spill-in): partial volume, which GTM correction in the next tab can undo.');
        body.appendChild(el('p', { class: 'note mt-1 mb-0' }, parts.join(' ')));
    }

    /* ----- how it works ----- */
    function buildHowItWorks() {
        const d = W().details({ summary: 'How this reconstruction works, and what it leaves out',
            content: '<div class="rc-howto">' +
                '<ul>' +
                '<li><b>Data model.</b> For each line of response i: y<sub>i</sub> ~ Poisson( n<sub>i</sub> a<sub>i</sub> &kappa; (H x)<sub>i</sub> + s<sub>i</sub> + r<sub>i</sub> ), with n the detector efficiency (normalisation), a the attenuation, &kappa; the sensitivity and decay factor, s the scatter estimate and r the randoms estimate. Each correction switch adds its factor or term to the model.</li>' +
                '<li><b>FBP</b> instead corrects the sinogram first, ((y &minus; r &minus; s) / n) &times; ACF / &kappa;, sums the TOF bins, filters each angle along r with the ramp times the chosen window (zero-padded FFT), and backprojects pixel by pixel.</li>' +
                '<li><b>MLEM and OSEM</b> start from a uniform image inside the field of view and apply the multiplicative update; OSEM uses interleaved subsets of the 192 angles. Every full iteration is stored (after the post-filter) so you can scrub through them.</li>' +
                '<li><b>Time of flight</b> splits each line into 17 bins of 20 mm and weights each position by a Gaussian of &sigma; = c&middot;CTR / (2 &times; 2.355).</li>' +
                '<li><b>Resolution modelling (PSF)</b> adds the radial detector blur (including parallax) to H; <b>positron range correction</b> adds the isotope\'s range kernel in image space.</li>' +
                '<li><b>Units.</b> Images are in Bq/mL, decay corrected to the injection time when decay correction is on. SUV divides by dose per gram of body weight (tissue at 1 g/mL).</li>' +
                '</ul>' +
                '<p class="simplification">Honest simplifications: one 2D slice on one ring (no oblique planes, no axial blur); the same kind of projector simulates the data and models it in the reconstruction (real data come from physics, not from the reconstruction\'s own model, so this is kinder than reality); the detector blur is a Gaussian along r; scatter is a smooth single-scatter model and its estimate uses the true activity (real scanners iterate from a first image); no dead time, no pile-up; motion correction assumes perfect tracking.</p>' +
                '</div>' });
        d.classList.add('rc-howto-box');
        return d;
    }

    /* ---------- status, progress, notes ---------- */
    function setProgress(frac) {
        const p = S.ui.progress;
        if (!p) return;
        if (frac === null) { p.classList.add('is-idle'); p.firstChild.style.width = '0'; return; }
        p.classList.remove('is-idle');
        p.firstChild.style.width = (100 * U.clamp(frac, 0, 1)).toFixed(1) + '%';
        p.setAttribute('aria-valuenow', String(Math.round(100 * U.clamp(frac, 0, 1))));
    }
    const renderStatus = safe(function () {
        const res = curResult(), acq = curAcq(), s = st();
        if (!S.ui.status) return;
        if (!acq) { S.ui.status.textContent = s.scanning ? 'Scanning...' : 'Waiting for the first scan.'; S.ui.notes.textContent = ''; return; }
        if (s.scanning) S.ui.status.textContent = 'Scanning: the image fills in as counts arrive.';
        else if (s.reconstructing) S.ui.status.textContent = 'Reconstructing...';
        else if (res && res.info) {
            const it = res.info;
            const m = res.method, parts = [{ bp: 'Backprojection', fbp: 'FBP (' + (it.filter || '') + ')', mlem: 'MLEM', osem: 'OSEM' }[m] || m];
            if (m === 'mlem' || m === 'osem') parts.push(it.iterationsDone + ' iteration' + (it.iterationsDone === 1 ? '' : 's') + (m === 'osem' ? ' x ' + it.subsets + ' subsets' : ''));
            if (it.tofUsed) parts.push('TOF');
            if (it.psf) parts.push('PSF');
            if (it.rangeCorrection) parts.push('range corrected');
            const ms = s.reconMs !== null && s.reconMs !== undefined ? s.reconMs : it.timeMs;
            S.ui.status.textContent = parts.join(', ') + (isFinite(ms) ? ': ' + U.fmtTime(ms / 1000) : '');
        } else S.ui.status.textContent = PET.recon ? 'Waiting for the reconstruction.' : 'No image: the reconstruction module (js/recon.js) did not load.';
        S.ui.notes.textContent = '';
        ((res && res.info && res.info.notes) || []).forEach(function (n) { S.ui.notes.appendChild(el('li', { text: n })); });
    }, 'status');

    /* ---------- render orchestration ---------- */
    function renderAll() {
        if (!S.mounted || !S.visible) { S.dirty = true; return; }
        S.dirty = false;
        syncControls();
        renderFrameBar();
        renderStatus();
        renderRoi();               // first: it builds the outline the images draw
        renderImages();
        renderExplorer();
        renderProfile();
        renderSpecial();
        S.lastResult = curResult();
    }
    // Heavy panels are recomputed at most every 200 ms while results stream in.
    const renderLight = safe(function () {
        if (!S.visible) { S.dirty = true; return; }
        renderStatus(); renderRoi(); renderImages(); renderProfile();
    }, 'light render');

    function wireBus() {
        const bus = PET.bus;
        if (!bus) return;
        bus.on('reconopts:changed', function () { if (S.visible) { syncControls(); } else S.dirty = true; });
        bus.on('recon:start', function () { setProgress(0); if (S.visible) renderStatus(); });
        bus.on('recon:progress', function (e) { if (e && isFinite(e.frac)) setProgress(e.frac); });
        bus.on('recon:iteration', function (e) {
            if (!S.visible || !e || !e.image || !S.ui.vRecon) return;
            const res = curResult(), acq = curAcq();
            const n = Math.round(Math.sqrt(e.image.length));
            if (!acq || !n) return;
            const ds = displayScale(acq);
            const win = S.ui.vRecon.getWindow();
            S.ui.vRecon.setTitle('Reconstruction, iteration ' + e.k + ' (' + ds.unit + ')');
            S.ui.vRecon.setData(scaled(e.image, ds.f), n, n, res && res.n === n ? { min: win.min, max: win.max, cmap: S.cmap } : { cmap: S.cmap });
        });
        bus.on('recon:done', function (e) {
            if (!e || !e.result) return;
            if (e.partial) e.result.partialFlag = true;
            setProgress(null);
            if (!S.visible) { S.dirty = true; return; }
            if (e.partial) renderLight(); else renderAll();
            S.lastResult = e.result;
        });
        bus.on('scan:start', function () { if (S.visible) renderStatus(); });
        bus.on('scan:done', function () { S.caches.special = null; if (S.visible) { syncControls(); renderFrameBar(); renderStatus(); } else S.dirty = true; });
        bus.on('scan:error', function () { setProgress(null); if (S.visible) renderStatus(); });
        bus.on('frame:changed', function () { if (S.visible) renderFrameBar(); });
        bus.on('analysis:changed', function () { if (S.visible) { renderRoi(); redrawOverlays(); } });
        bus.on('theme:changed', function () { if (S.visible) { drawFilter(); renderConvergence(); } });
    }

    PET.ui.registerTab({
        id: 'recon', title: 'Reconstruction', order: 60,
        mount: mount,
        onShow: function () {
            S.visible = true;
            S.caches.special = null;
            renderAll();
        },
        onHide: function () { S.visible = false; stopPlay(); }
    });

})(typeof window !== 'undefined' ? window : globalThis);
