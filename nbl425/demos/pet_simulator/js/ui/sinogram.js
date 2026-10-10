/* ============================================================
   PET Simulator, Sinogram tab
   How a scanner organises its coincidences. Every line of response
   (LOR) is a point (r, theta) of the sinogram: theta the direction of
   its normal, r its signed distance from the centre. The tab shows
   the sinogram of the frame on view (the measured prompts, the
   expected trues, scatter and randoms, the delayed window, the
   corrected data and the correction factors), links each sinogram
   bin to its LOR on a drawing of the ring, draws the sinusoid any
   point of the object traces, plots a radial profile with the
   components stacked so the scatter and randoms tails outside the
   object are visible, and tabulates the counts.

   Everything shown comes from PET.state.acq (and, for the corrected
   sinogram, PET.state.reconResult). Derived sinograms are cached per
   frame object, so hovering and re-drawing never recompute them.
   While an animated scan plays back, the measured views fill in.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !PET.util) return;
    const U = PET.util;
    const doc = root.document;
    const el = function (tag, attrs, children) { return U.el(tag, attrs, children); };
    const W = function () { return PET.ui.w; };
    const st = function () { return PET.state || {}; };

    /* Geometry: read it from the scanner module, with the contract's
       values as a fallback so the tab still draws if scanner.js is missing. */
    const SG = PET.scanner && PET.scanner.geom;
    const G = SG || { nA: 192, nR: 160, dr: 2, nT: 17, ds: 20, ringRadius: 250, crystalDepth: 20, nCrystals: 384, crystalsPerBlock: 8, nBlocks: 48, fov: 320,
        angle: function (a) { return a * Math.PI / 192; }, radius: function (i) { return (i - 80) * 2; }, tofCentre: function (k) { return (k - 8) * 20; } };
    const nA = G.nA, nR = G.nR, NLOR = nA * nR;
    const TAIL_ACF = (PET.engine && PET.engine.CAL && PET.engine.CAL.TAIL_ACF) || 1.03;

    const VIEWS = [
        { value: 'prompts', label: 'Prompts (measured)', group: 'Measured', tof: true, unit: 'counts',
            about: 'Every coincidence the scanner recorded in this frame: trues, scatter and randoms together, with Poisson noise. Each bright sinusoidal band is a structure of the object.' },
        { value: 'delayed', label: 'Delayed window', group: 'Measured', tof: true, unit: 'counts',
            about: 'Coincidences between a photon and another delayed by far more than the window. They cannot come from one annihilation, so they count only randoms: a noisy, independent measurement of the randoms in the prompts.' },
        { value: 'pmd', label: 'Prompts minus delayed', group: 'Measured', tof: true, unit: 'counts',
            about: 'Randoms subtraction: what is left is trues plus scatter, noisier than the prompts because two noisy numbers were subtracted. Outside the object only scatter (and noise around zero) remains.' },
        { value: 'trues', label: 'Trues (expected)', group: 'Expected components (noiseless)', unit: 'counts',
            about: 'The unscattered coincidences, before noise: the attenuated projection of the activity, blurred by the detectors and seen through the crystal efficiencies. Nothing outside the object.' },
        { value: 'scatter', label: 'Scatter (expected)', group: 'Expected components (noiseless)', unit: 'counts',
            about: 'Coincidences in which one photon scattered in the body. The line of response is wrong, so scatter is smooth and spreads beyond the object: the tails that scatter correction is fitted to.' },
        { value: 'randoms', label: 'Randoms (expected)', group: 'Expected components (noiseless)', unit: 'counts',
            about: 'Two photons from different annihilations inside the timing window. They are almost uniform over the sinogram (shaped only by the crystal efficiencies) and cover it all, inside and outside the object.' },
        { value: 'corrected', label: 'Corrected (what FBP inverts)', group: 'After correction', unit: 'kBq/mL × mm',
            about: '(prompts − randoms − scatter) ÷ normalisation × attenuation correction factor ÷ κ, with the corrections chosen in the Reconstruction tab: the line integrals of the activity concentration, ready for filtered backprojection.' },
        { value: 'norm', label: 'Normalisation (LOR efficiency)', group: 'Correction factors', unit: '',
            about: 'The efficiency of each line of response, the product of its two crystals\' efficiencies. The diagonal pattern comes from individual crystals: a crystal traces a line across the sinogram. A dead block leaves a band of zeros.' },
        { value: 'acf', label: 'Attenuation correction factors', group: 'Correction factors', unit: '',
            about: 'e^(+∫μ) along every line of response, from the μ map used for correction: 1 for lines that miss the object, about 7 through the middle of a head or a 20 cm water cylinder. It does not depend on where on the line the annihilation happened.' }
    ];
    const VIEW = {};
    VIEWS.forEach(function (v) { VIEW[v.value] = v; });

    /* ---------- tab state ---------- */
    const S = {
        mounted: false, visible: false,
        view: 'prompts', tofBin: -1, cmap: 'gray', profA: 48, rows: 5, ringBg: 'object',
        hover: null, pinned: null,           // sinogram bins {a, i}
        point: null, hoverPoint: null,       // points of the object {x, y} in mm
        partial: null, acquiring: false, lastTick: 0, lastKey: ''
    };
    const E = {};
    let profileCache = null;

    /* ---------- helpers ---------- */
    function clock(s) {
        const neg = s < 0; s = Math.abs(s);
        let m = Math.floor(s / 60), r = Math.round(s - 60 * m);
        if (r === 60) { m++; r = 0; }
        return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }
    function frameText(F, i, n) {
        if (!F) return '';
        return (n > 1 ? 'Frame ' + (i + 1) + ' of ' + n + ', ' : '') + clock(F.t0) + ' to ' + clock(F.t1) + ' min after injection (' + U.fmtTime(F.t1 - F.t0) + ')';
    }
    function fmtS(v) { return (v > 0 ? '+' : (v < 0 ? '−' : '')) + Math.abs(v) + ' mm'; }
    function fmtR(v) { const a = Math.abs(v); return (v < 0 ? '−' : '') + (a % 1 ? a.toFixed(1) : a) + ' mm'; }
    function fmtVal(v, unit) {
        if (!isFinite(v)) return '-';
        if (unit === 'counts') return Math.abs(v) >= 100 || v === Math.round(v) ? String(Math.round(v)) : v.toFixed(1);
        return U.fmtNum(v, 3) + (unit ? ' ' + unit : '');
    }
    function nTof(acq) {
        if (acq.geom && acq.geom.nT) return acq.geom.nT;
        const p = acq.frames[0] && acq.frames[0].prompts;
        return p ? Math.max(1, Math.round(p.length / NLOR)) : 1;
    }
    function sumTOF(arr, nT) {
        if (!arr) return null;
        if (PET.scanner && PET.scanner.sumTOF) return PET.scanner.sumTOF(arr, nT);
        if (nT === 1) return arr;
        const out = new Float32Array(arr.length / nT);
        for (let k = 0; k < out.length; k++) { let s = 0; for (let t = 0; t < nT; t++) s += arr[k * nT + t]; out[k] = s; }
        return out;
    }
    function oneBin(arr, nT, k) {
        const out = new Float32Array(NLOR);
        for (let l = 0; l < NLOR; l++) out[l] = arr[l * nT + k];
        return out;
    }
    function errText(e) { return e && e.message ? e.message : String(e); }
    function report(e) { if (root.console) root.console.error('[PET sinogram tab]', e); }

    /* The acquisition and frame on view (a partial frame while playing back). */
    function current() {
        const acq = st().acq;
        if (!acq || !acq.frames || !acq.frames.length) return null;
        const fi = U.clamp(st().frame || 0, 0, acq.frames.length - 1);
        let F = acq.frames[fi], partial = false;
        if (S.partial && S.partial.acq === acq && S.partial.fi === fi) { F = S.partial.F; partial = true; }
        return { acq: acq, fi: fi, F: F, nT: nTof(acq), partial: partial };
    }

    /* Derived non-TOF sinograms, cached on the frame object. */
    const cache = new WeakMap();
    function cached(F, key, fn) {
        let m = cache.get(F);
        if (!m) { m = new Map(); cache.set(F, m); }
        if (!m.has(key)) m.set(key, fn());
        return m.get(key);
    }
    function measured(cur, which, bin) {
        const F = cur.F, nT = cur.nT, arr = F[which];
        if (!arr) return null;
        return cached(F, which + '|' + bin, function () { return bin >= 0 && nT > 1 ? oneBin(arr, nT, bin) : sumTOF(arr, nT); });
    }
    /* What the selected view shows: {data, unit, min?, max?} or {empty}. */
    function viewData(cur) {
        const v = S.view, F = cur.F, acq = cur.acq, bin = cur.nT > 1 && VIEW[v].tof ? S.tofBin : -1;
        const unit = VIEW[v].unit;
        switch (v) {
            case 'prompts': case 'delayed': {
                const d = measured(cur, v, bin);
                return d ? { data: d, unit: unit, min: 0 } : { empty: 'This frame has no ' + v + ' data.' };
            }
            case 'pmd': {
                const p = measured(cur, 'prompts', bin), d = measured(cur, 'delayed', bin);
                if (!p || !d) return { empty: 'This frame has no delayed-window data.' };
                return { data: cached(F, 'pmd|' + bin, function () { const o = new Float32Array(NLOR); for (let l = 0; l < NLOR; l++) o[l] = p[l] - d[l]; return o; }), unit: unit };
            }
            case 'trues': case 'scatter': case 'randoms': {
                const d = F.expected && F.expected[v];
                return d ? { data: d, unit: unit, min: 0 } : { empty: 'The engine did not report the expected ' + v + '.' };
            }
            case 'corrected': {
                const R = st().reconResult;
                if (!PET.recon) return { empty: 'The reconstruction module (js/recon.js) did not load.' };
                if (!R || !R.corrected) return { empty: st().reconstructing ? 'Reconstructing: the corrected sinogram comes with the image.' : 'No reconstruction yet: the corrected sinogram is made when the image is reconstructed.' };
                if (R.frame !== cur.fi && R.frame !== 'all') return { empty: 'The last reconstruction is of frame ' + (R.frame + 1) + '. Reconstructing this frame.' };
                // Bq/mL x mm of line integral, shown in kBq/mL x mm
                return { data: cached(R.corrected, 'kBq', function () { const o = new Float32Array(R.corrected.length); for (let l = 0; l < o.length; l++) o[l] = R.corrected[l] / 1000; return o; }), unit: unit };
            }
            case 'norm': {
                const n = acq.corrections && acq.corrections.norm;
                if (!n) return { empty: 'No normalisation data.' };
                return { data: n, unit: '', min: Math.min(0.6, U.percentile(n, 1)), max: Math.max(1.2, U.percentile(n, 99.5)) };
            }
            case 'acf': {
                const a = acq.corrections && acq.corrections.acf;
                if (!a) return { empty: 'No attenuation correction factors.' };
                let mx = 1;
                for (let l = 0; l < a.length; l++) if (a[l] > mx) mx = a[l];
                return { data: a, unit: '', min: 1, max: mx > 1.05 ? mx : 2 };
            }
        }
        return { empty: 'Unknown view.' };
    }

    /* ---------- styles ---------- */
    function addStyles() {
        PET.ui.addStyle([
            '#tab-sinogram .sg-toolbar { display: grid; gap: 10px 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr)); align-items: end; margin-bottom: 10px; }',
            '#tab-sinogram .sg-toolbar .ctl-select > select { width: 100%; }',
            '#tab-sinogram .sg-about { font-size: 0.84rem; color: var(--muted); line-height: 1.5; margin: 0 0 12px; min-height: 2.6em; }',
            '#tab-sinogram .sg-about strong { color: var(--fg); }',
            '#tab-sinogram .sg-frame { margin-bottom: 12px; }',
            '#tab-sinogram .sg-readout { margin-top: 8px; min-height: 2.9em; font: 0.76rem/1.45 var(--font-mono); color: var(--scope-muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }',
            '#tab-sinogram .sg-readout b { color: var(--scope-fg); font-weight: 600; }',
            '#tab-sinogram .sg-ring-stage { position: relative; display: flex; justify-content: center; }',
            '#tab-sinogram .sg-ring { display: block; cursor: crosshair; touch-action: manipulation; border-radius: 6px; }',
            '#tab-sinogram .sg-ring-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 8px; }',
            '#tab-sinogram .sg-ring-bar .seg { background: rgba(255,255,255,0.06); border-color: var(--scope-axis); }',
            '#tab-sinogram .sg-ring-bar .seg > button { color: var(--scope-muted); }',
            '#tab-sinogram .sg-ring-bar .seg > button[aria-checked="true"] { background: var(--scope-axis); color: var(--scope-fg); box-shadow: none; }',
            '#tab-sinogram .sg-ring-bar .btn { background: transparent; color: var(--scope-fg); border-color: var(--scope-axis); }',
            '#tab-sinogram .sg-ring-bar .btn:hover { background: rgba(255,255,255,0.08); }',
            '#tab-sinogram .sg-ring-bar .sg-lab { font-size: 0.72rem; color: var(--scope-muted); }',
            '#tab-sinogram .sg-axis-note { font-size: 0.78rem; color: var(--muted); text-align: center; margin: 6px 0 0; }',
            '#tab-sinogram .sg-prof-ctl { display: grid; gap: 10px 20px; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: end; margin-bottom: 8px; }',
            '@media (max-width: 640px) { #tab-sinogram .sg-prof-ctl { grid-template-columns: minmax(0, 1fr); } }',
            '#tab-sinogram .sg-prof-canvas { display: block; width: 100%; height: 260px; cursor: crosshair; }',
            '#tab-sinogram .sg-prof .legend { margin: 0; }',
            '#tab-sinogram .sg-tail-swatch { background: var(--hover) !important; border: 1px solid var(--border-strong); }',
            '#tab-sinogram table.sg-counts { border-collapse: collapse; width: 100%; font-size: 0.84rem; }',
            '#tab-sinogram table.sg-counts th, #tab-sinogram table.sg-counts td { padding: 7px 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; text-align: left; }',
            '#tab-sinogram table.sg-counts thead th { font-size: 0.74rem; color: var(--muted); font-weight: 650; }',
            '#tab-sinogram table.sg-counts td.n, #tab-sinogram table.sg-counts th.n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
            '#tab-sinogram table.sg-counts tbody th { font-weight: 600; }',
            '#tab-sinogram table.sg-counts .sg-expl { display: block; font-weight: 400; color: var(--muted); font-size: 0.78rem; line-height: 1.4; margin-top: 2px; }',
            '#tab-sinogram table.sg-counts .swatch { margin-right: 6px; vertical-align: 0; }',
            '#tab-sinogram .sg-warn ul { margin: 4px 0 0; padding-left: 18px; }',
            '#tab-sinogram .sg-scroll { overflow-x: auto; }'
        ].join('\n'));
    }

    /* ---------- building the tab ---------- */
    function mount(panel) {
        addStyles();
        panel.textContent = '';
        const w = W();
        if (!w) { panel.appendChild(el('div', { class: 'error-card', text: 'The shared widgets (js/ui/widgets.js) did not load.' })); return; }

        // 1. concept
        panel.appendChild(w.concept({
            title: 'The sinogram: every line of response is a point',
            body: '<p>Each coincidence defines a <strong>line of response</strong> (LOR) between two crystals. The scanner files it by the angle θ of the ' +
                'line\'s normal and its signed distance <i>r</i> from the centre, and counts events in that bin: the <strong>sinogram</strong>. ' +
                'A point at (<i>x</i>, <i>y</i>) lies on the lines with <i>r</i> = <i>x</i> cos θ + <i>y</i> sin θ, so it traces a sinusoid; ' +
                'the sinogram of an object is the sum of the sinusoids of all its points, the line integral (projection) of the activity <i>f</i>.</p>' +
                '<p>Attenuation multiplies each LOR by e<sup>−∫μ</sup> over the whole line, which does not depend on where along the line the ' +
                'annihilation happened. Scatter and randoms add counts on wrong lines, including lines that miss the object.</p>',
            formula: '<i>p</i>(<i>r</i>, θ) = ∫ <i>f</i>(<i>r</i> <b>n</b> + <i>s</i> <b>d</b>) d<i>s</i> &nbsp;·&nbsp; e<sup>−∫ μ d<i>s</i></sup>' +
                '<div style="font-size:0.9em;margin-top:4px"><b>n</b> = (cos θ, sin θ), <b>d</b> = (−sin θ, cos θ), a point traces <i>r</i> = <i>x</i> cos θ + <i>y</i> sin θ</div>',
            tryThis: [
                { html: 'Hover over the sinogram: the ring on the right shows the line of response of that bin and the two crystals it joins.' },
                { html: 'Load the line sources and click the source at x = 100 mm in the ring panel: its sinusoid has an amplitude of 100 mm.',
                    label: 'Show me', run: function () { if (PET.actions) PET.actions.loadPreset('point_res'); S.point = { x: 100, y: 0 }; S.view = 'prompts'; syncControls(); renderAll(); } },
                { html: 'Compare Trues, Scatter and Randoms, then look at the radial profile: only scatter and randoms reach outside the object.',
                    label: 'Show scatter', run: function () { setView('scatter'); } },
                { html: 'With TOF on, pick one TOF bin: only annihilations near that position along each line remain, so each bin sees a different strip of the object.',
                    label: 'One TOF bin', run: function () { setView('prompts'); S.tofBin = 10; syncControls(); renderAll(); } }
            ]
        }));

        // 2. sinogram and ring
        const main = el('section', { class: 'panel', 'aria-labelledby': 'sg-title' });
        E.headBadge = el('span', { class: 'badge badge-muted', hidden: true });
        E.stale = el('span', { class: 'badge badge-warn', hidden: true, text: 'settings changed since this scan' });
        main.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'sg-title', text: 'Sinogram and lines of response' }), E.headBadge, E.stale
        ]));
        E.viewSel = w.select({ label: 'Show', options: VIEWS, value: S.view, onChange: function (v) { setView(v); } });
        E.tofSel = w.select({ label: 'Time-of-flight bin', options: tofOptions(), value: S.tofBin,
            onChange: function (v) { S.tofBin = +v; renderAll(); } });
        E.cmapSel = w.select({ label: 'Colour map', options: [{ value: 'gray', label: 'Gray' }, { value: 'inferno', label: 'Inferno' }, { value: 'pet', label: 'PET (hot metal)' }],
            value: S.cmap, onChange: function (v) { S.cmap = v; renderSino(); } });
        E.resetBtn = w.button({ label: 'Reset window', size: 'sm', title: 'Back to the automatic window (or double-click the sinogram)',
            onClick: function () { if (E.iv) E.iv.resetWindow(); } });
        main.appendChild(el('div', { class: 'sg-toolbar' }, [E.viewSel, E.tofSel, E.cmapSel, el('div', { class: 'ctl ctl-bare' }, [E.resetBtn])]));
        E.frameSlider = w.slider({ label: 'Frame', min: 0, max: 1, step: 1, value: 0,
            format: function (v) { return frameSliderText(Math.round(v)); },
            onInput: function (v) { if (PET.actions) PET.actions.setFrame(Math.round(v)); } });
        E.frameRow = el('div', { class: 'sg-frame', hidden: true }, [E.frameSlider]);
        main.appendChild(E.frameRow);
        E.about = el('p', { class: 'sg-about' });
        main.appendChild(E.about);

        const split = el('div', { class: 'split-even' });
        const left = el('div');
        E.ivOpts = { title: 'Sinogram', cmap: S.cmap, colorbar: true, unit: 'counts', readout: false, maxHeight: 540, empty: 'No scan yet' };
        E.iv = w.imageView(left, E.ivOpts);
        E.sinoReadout = el('div', { class: 'sg-readout' });
        E.iv.el.appendChild(E.sinoReadout);
        E.iv.setOverlay(drawSinoOverlay);
        E.iv.onHover(function (p) { S.hover = p ? { a: p.iy, i: p.ix } : null; linkedRedraw(); });
        E.iv.onClick(function (p) {
            if (!p) return;
            const same = S.pinned && S.pinned.a === p.iy && S.pinned.i === p.ix;
            S.pinned = same ? null : { a: p.iy, i: p.ix };
            if (!same) { S.profA = p.iy; if (E.angle) E.angle.set(angleOf(p.iy)); renderProfile(); }
            linkedRedraw();
        });
        left.appendChild(el('p', { class: 'sg-axis-note', text: 'Horizontal: radial position r, −160 to +158 mm in 2 mm bins. Vertical: angle θ, 0° at the top to 180° at the bottom. Hover to see a line of response, click to keep it.' }));
        split.appendChild(left);

        const right = el('div');
        E.ring = el('figure', { class: 'well' });
        E.ring.appendChild(el('figcaption', { class: 'well-title' }, [el('span', { text: 'The ring and the line of response' })]));
        E.ringStage = el('div', { class: 'sg-ring-stage' });
        E.ringCanvas = el('canvas', { class: 'sg-ring', role: 'img', 'aria-label': 'Drawing of the detector ring with the selected line of response. Click inside the field of view to show that point\'s sinusoid on the sinogram.' });
        E.ringStage.appendChild(E.ringCanvas);
        E.ring.appendChild(E.ringStage);
        E.bgSeg = w.segmented({ options: [{ value: 'object', label: 'Object' }, { value: 'image', label: 'Image' }, { value: 'none', label: 'None' }],
            value: S.ringBg, size: 'sm', ariaLabel: 'Shown behind the ring', onChange: function (v) { S.ringBg = v; drawRing(); } });
        E.clearPt = w.button({ label: 'Clear point', size: 'xs', onClick: function () { S.point = null; linkedRedraw(); } });
        E.ring.appendChild(el('div', { class: 'sg-ring-bar' }, [el('span', { class: 'sg-lab', text: 'Behind:' }), E.bgSeg, el('span', { class: 'spacer' }), E.clearPt]));
        E.ringReadout = el('div', { class: 'sg-readout' });
        E.ring.appendChild(E.ringReadout);
        right.appendChild(E.ring);
        right.appendChild(el('p', { class: 'sg-axis-note', text: 'Click a point of the object to draw its sinusoid on the sinogram.' }));
        split.appendChild(right);
        main.appendChild(split);
        panel.appendChild(main);
        wireRing();

        // 3. radial profile
        const prof = el('section', { class: 'panel sg-prof', 'aria-labelledby': 'sg-prof-title' });
        prof.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'sg-prof-title', text: 'One row of the sinogram: a radial profile' }),
            el('span', { class: 'panel-sub', text: 'randoms, scatter and trues stacked (expected), measured prompts as a line' })
        ]));
        E.angle = w.slider({ label: 'Angle θ of the row', min: 0, max: angleOf(nA - 1), step: 180 / nA, value: angleOf(S.profA),
            format: function (v) { return v.toFixed(2) + '° (row ' + (Math.round(v / (180 / nA)) + 1) + ' of ' + nA + ')'; },
            onInput: function (v) { S.profA = U.clamp(Math.round(v / (180 / nA)), 0, nA - 1); renderProfile(); if (E.iv) E.iv.redraw(); } });
        E.rowsSeg = w.segmented({ label: 'Rows averaged', options: [{ value: 1, label: '1' }, { value: 5, label: '5' }, { value: 15, label: '15' }],
            value: S.rows, onChange: function (v) { S.rows = v; renderProfile(); if (E.iv) E.iv.redraw(); } });
        prof.appendChild(el('div', { class: 'sg-prof-ctl' }, [E.angle, E.rowsSeg]));
        const fig = el('figure', { class: 'plot plot-framed' });
        E.profLegend = w.legend([
            { label: 'trues', color: 'var(--ev-true)' }, { label: 'scatter', color: 'var(--ev-scatter)' }, { label: 'randoms', color: 'var(--ev-random)' },
            { label: 'prompts (measured)', color: 'var(--fg)', line: true }, { label: 'scanner\'s scatter + randoms estimate', color: 'var(--c3)', dash: true }
        ]);
        const tailItem = el('span', { class: 'legend-item' }, [el('span', { class: 'swatch sg-tail-swatch', 'aria-hidden': 'true' }), 'tails (lines that miss the object)']);
        E.profLegend.appendChild(tailItem);
        E.profTitle = el('span', { class: 'plot-title' });
        fig.appendChild(el('figcaption', { class: 'plot-head' }, [E.profTitle, E.profLegend]));
        E.profStage = el('div', { class: 'plot-stage' });
        E.profCanvas = el('canvas', { class: 'sg-prof-canvas', role: 'img', 'aria-label': 'Radial profile of the sinogram with trues, scatter and randoms stacked and the measured prompts' });
        E.profTip = el('div', { class: 'plot-tip', hidden: true });
        E.profStage.appendChild(E.profCanvas); E.profStage.appendChild(E.profTip);
        fig.appendChild(E.profStage);
        prof.appendChild(fig);
        E.profNote = el('p', { class: 'note mt-1' });
        prof.appendChild(E.profNote);
        panel.appendChild(prof);
        wireProfile();

        // 4. counts
        const cnt = el('section', { class: 'panel', 'aria-labelledby': 'sg-cnt-title' });
        E.cntSub = el('span', { class: 'panel-sub' });
        cnt.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'sg-cnt-title', text: 'Counts' }), E.cntSub]));
        E.counts = el('div', { class: 'sg-scroll' });
        cnt.appendChild(E.counts);
        E.warn = el('div', { class: 'sg-warn mt-1' });
        cnt.appendChild(E.warn);
        panel.appendChild(cnt);

        // 5. honest simplification
        panel.appendChild(el('div', { class: 'panel' }, [
            el('h2', { class: 'panel-title mb-1', text: 'A real scanner bins far more lines of response' }),
            el('p', { class: 'note', html: 'A clinical scanner has tens of thousands of crystals in several dozen rings. Every crystal pair is a line of response, filed by ' +
                '<i>r</i> and θ <em>and</em> by the two rings it joins: the direct planes (both photons in one ring) plus oblique planes between rings, ' +
                'grouped into segments by ring difference. Time of flight multiplies that again by the timing bins. That is hundreds of millions of bins, ' +
                'more than the counts in a scan, so many scanners store <strong>list mode</strong> (one record per event) and bin later.' }),
            el('p', { class: 'simplification mb-0', text: 'This simulator shows one direct plane of one ring: ' + nR + ' radial bins of ' + G.dr + ' mm by ' + nA +
                ' angles over 180°, times ' + G.nT + ' TOF bins of ' + G.ds + ' mm when time of flight is on.' })
        ]));

        if (PET.bus) {
            PET.bus.on('scan:start', function (e) { S.acquiring = !!(e && e.animate); S.partial = null; updateBadges(); });
            PET.bus.on('playback:tick', onTick);
            PET.bus.on('scan:done', function () { S.partial = null; S.acquiring = false; profileCache = null; invalidate(); });
            PET.bus.on('scan:error', function () { S.acquiring = false; updateBadges(); });
            PET.bus.on('frame:changed', function () { if (!S.acquiring) invalidate(); });
            PET.bus.on('recon:done', function (e) {
                if (!S.visible) return;
                if (S.view === 'corrected' && !(e && e.partial && S.acquiring)) renderSino();
                if (S.ringBg === 'image') drawRing();
            });
            ['phantom:changed', 'physics:changed', 'program:compiled'].forEach(function (evt) { PET.bus.on(evt, updateBadges); });
            PET.bus.on('theme:changed', function () { if (S.visible) { drawRing(); renderProfile(); } });
        }
        S.mounted = true;
    }

    function tofOptions() {
        const out = [{ value: -1, label: 'All bins (summed)' }];
        for (let k = 0; k < G.nT; k++) {
            const s = G.tofCentre ? G.tofCentre(k) : (k - 8) * 20;
            out.push({ value: k, label: 'Bin ' + (k + 1) + ' of ' + G.nT + ', s = ' + fmtS(s) + (s === 0 ? ' (middle)' : '') });
        }
        return out;
    }
    function angleOf(a) { return Math.round(a * 180 / nA * 10000) / 10000; }
    function frameSliderText(i) {
        const cur = current();
        if (!cur) return '';
        const F = cur.acq.frames[U.clamp(i, 0, cur.acq.frames.length - 1)];
        return (i + 1) + ' of ' + cur.acq.frames.length + ', ' + clock(F.t0) + ' to ' + clock(F.t1);
    }
    function setView(v) {
        if (!VIEW[v]) return;
        S.view = v;
        syncControls();
        if (S.mounted && S.visible) renderSino();
    }
    function syncControls() {
        if (!E.viewSel) return;
        E.viewSel.set(S.view);
        E.tofSel.set(S.tofBin);
        E.cmapSel.set(S.cmap);
        E.bgSeg.set(S.ringBg);
    }

    /* ---------- rendering ---------- */
    let timer = null;
    function invalidate() {
        if (!S.mounted) return;
        if (!S.visible) { S.dirty = true; return; }
        if (timer) return;
        timer = setTimeout(function () { timer = null; renderAll(); }, 30);
    }
    function renderAll() {
        S.dirty = false;
        try { renderSino(); } catch (e) { report(e); }
        try { drawRing(); } catch (e) { report(e); }
        try { renderProfile(); } catch (e) { report(e); }
        try { renderCounts(); } catch (e) { report(e); }
        updateBadges();
    }
    function updateBadges() {
        if (!E.stale) return;
        const cur = current();
        E.stale.hidden = !(cur && st().stale);
        if (S.partial) { E.headBadge.hidden = false; E.headBadge.className = 'badge badge-accent'; E.headBadge.textContent = 'acquiring, ' + Math.round(100 * S.partial.frac) + ' % of this frame'; }
        else if (cur) { E.headBadge.hidden = false; E.headBadge.className = 'badge badge-muted'; E.headBadge.textContent = frameText(cur.F, cur.fi, cur.acq.frames.length); }
        else E.headBadge.hidden = true;
    }

    function renderSino() {
        if (!E.iv) return;
        const cur = current();
        const vd = VIEW[S.view];
        const tofCapable = !!(cur && cur.nT > 1 && vd.tof);
        E.tofSel.setDisabled(!tofCapable);
        E.tofSel.select.title = !cur ? '' : (cur.nT === 1 ? 'This scan has no time of flight (add "tof on" to the protocol).' : (vd.tof ? '' : 'Only the measured sinograms keep their TOF bins; the expected components are stored summed.'));
        let about = vd.about;
        if (tofCapable && S.tofBin >= 0) {
            const s = G.tofCentre(S.tofBin);
            about += ' TOF bin ' + (S.tofBin + 1) + ' keeps only events whose arrival-time difference places them ' + fmtS(s) + ' from the middle of their line (± ' + (G.ds / 2) + ' mm, blurred by the timing resolution).';
        }
        E.about.textContent = about;
        syncFrame(cur);
        if (!cur) {
            S.data = null;
            E.iv.clear(!PET.engine ? 'The acquisition engine (js/engine.js) did not load, so there is no sinogram.'
                : (st().scanning ? 'Scanning' : 'No scan yet. Press Acquire, or wait for the automatic scan.'));
            E.sinoReadout.textContent = '';
            return;
        }
        const d = viewData(cur);
        S.data = d;
        if (d.empty) { E.iv.clear(d.empty); E.sinoReadout.textContent = ''; return; }
        const key = S.view + '|' + (tofCapable ? S.tofBin : -1);
        const reset = key !== S.lastKey;
        S.lastKey = key;
        E.ivOpts.unit = d.unit;
        E.iv.setData(d.data, nR, nA, { min: d.min, max: d.max, cmap: S.cmap, aspect: 1, resetWindow: reset });
        E.iv.setTitle(VIEW[S.view].label + (tofCapable && S.tofBin >= 0 ? ', TOF bin ' + (S.tofBin + 1) : ''));
        updateReadouts();
    }
    function syncFrame(cur) {
        const n = cur ? cur.acq.frames.length : 1;
        E.frameRow.hidden = n <= 1;
        if (n <= 1) return;
        E.frameSlider.setRange(0, n - 1, 1);
        E.frameSlider.set(cur.fi);
    }

    /* Sinogram overlay: axis ticks, the profile row, the hovered and
       pinned bins, and the sinusoids of the chosen points. */
    function drawSinoOverlay(ctx, g) {
        const sx = g.sx, sy = g.sy;
        const font = U.cssVar('--font-sans', 'sans-serif');
        // profile row band
        const h = (S.rows - 1) / 2;
        ctx.fillStyle = 'rgba(94, 224, 210, 0.10)';
        ctx.fillRect(0, (S.profA - h) * sy, g.w, S.rows * sy);
        ctx.strokeStyle = 'rgba(94, 224, 210, 0.75)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(0, (S.profA + 0.5) * sy); ctx.lineTo(g.w, (S.profA + 0.5) * sy); ctx.stroke();
        ctx.setLineDash([]);
        // sinusoids
        const sinus = function (pt, style) {
            const r = PET.scanner ? PET.scanner.pointSinusoid(pt.x, pt.y) : null;
            if (!r) return;
            ctx.save();
            ctx.strokeStyle = style.color; ctx.lineWidth = style.width; ctx.setLineDash(style.dash || []);
            ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
            ctx.beginPath();
            for (let a = 0; a < nA; a++) {
                const x = (r[a] / G.dr + nR / 2 + 0.5) * sx, y = (a + 0.5) * sy;
                if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
            ctx.restore();
        };
        if (S.hoverPoint) sinus(S.hoverPoint, { color: 'rgba(255,255,255,0.75)', width: 1.25, dash: [4, 3] });
        if (S.point) sinus(S.point, { color: '#5ee0d2', width: 2 });
        // bins
        const box = function (b, color, wdt) {
            ctx.strokeStyle = color; ctx.lineWidth = wdt;
            const x = b.i * sx, y = b.a * sy, s = Math.max(sx, sy);
            ctx.strokeRect(x - 2.5, y - 2.5, sx + 5, sy + 5);
            if (s < 6) {
                ctx.beginPath();
                ctx.moveTo(x + sx / 2, y - 9); ctx.lineTo(x + sx / 2, y - 4);
                ctx.moveTo(x + sx / 2, y + sy + 4); ctx.lineTo(x + sx / 2, y + sy + 9);
                ctx.moveTo(x - 9, y + sy / 2); ctx.lineTo(x - 4, y + sy / 2);
                ctx.moveTo(x + sx + 4, y + sy / 2); ctx.lineTo(x + sx + 9, y + sy / 2);
                ctx.stroke();
            }
        };
        if (S.pinned) box(S.pinned, '#f5d061', 1.5);
        if (S.hover && !(S.pinned && S.hover.a === S.pinned.a && S.hover.i === S.pinned.i)) box(S.hover, 'rgba(245, 208, 97, 0.8)', 1);
        // axes: r along the bottom, theta along the left
        ctx.font = '600 10px ' + font;
        ctx.lineWidth = 3; ctx.lineJoin = 'round';
        const label = function (t, x, y, align, base) {
            ctx.textAlign = align; ctx.textBaseline = base;
            ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(t, x, y);
            ctx.fillStyle = 'rgba(226, 232, 240, 0.92)'; ctx.fillText(t, x, y);
        };
        [-150, -100, -50, 0, 50, 100, 150].forEach(function (r) {
            const x = (r / G.dr + nR / 2 + 0.5) * sx;
            ctx.fillStyle = 'rgba(226,232,240,0.8)'; ctx.fillRect(x - 0.5, g.h - 5, 1, 5);
            if (g.w > 260 || r % 100 === 0) label(String(r), x, g.h - 6, 'center', 'bottom');
        });
        label('r (mm)', g.w - 4, g.h - 18, 'right', 'bottom');
        [0, 45, 90, 135].forEach(function (t) {
            const y = (t / 180 * nA + 0.5) * sy;
            label(t + '°', 4, t === 0 ? 3 : y, 'left', t === 0 ? 'top' : 'middle');
        });
        label('θ', 7, g.h - 18, 'left', 'bottom');
    }

    /* ---------- readouts ---------- */
    function binInfo(b) {
        const cur = current();
        if (!b || !cur) return null;
        const a = U.clamp(b.a, 0, nA - 1), i = U.clamp(b.i, 0, nR - 1), l = a * nR + i;
        const theta = a * 180 / nA, r = G.radius ? G.radius(i) : (i - nR / 2) * G.dr;
        let ends = null;
        try { ends = PET.scanner.lorEndpoints(a, i); } catch (e) { ends = null; }
        return { a: a, i: i, l: l, theta: theta, r: r, ends: ends, cur: cur };
    }
    function updateReadouts() {
        if (!E.sinoReadout) return;
        const b = binInfo(S.hover || S.pinned);
        if (!b) {
            E.sinoReadout.textContent = current() ? 'Hover over the sinogram to read a bin. Drag to change the window, double-click to reset.' : '';
            E.ringReadout.textContent = S.point ? pointText(S.point) : 'Hover over the sinogram to draw its line of response here.';
            return;
        }
        const F = b.cur.F, d = S.data && !S.data.empty ? S.data : null;
        const val = d ? d.data[b.l] : NaN;
        const ex = F.expected || {};
        const tsr = ex.trues ? 'expected trues ' + fmtVal(ex.trues[b.l], 'counts') + ', scatter ' + fmtVal(ex.scatter[b.l], 'counts') + ', randoms ' + fmtVal(ex.randoms[b.l], 'counts') : '';
        E.sinoReadout.textContent = '';
        E.sinoReadout.appendChild(el('div', {}, ['θ ' + b.theta.toFixed(2) + '°, r ' + fmtR(b.r) + ': ', el('b', { text: VIEW[S.view].label.replace(/ \(.*\)$/, '') + ' ' + fmtVal(val, d ? d.unit : '') })]));
        if (tsr) E.sinoReadout.appendChild(el('div', { text: tsr }));
        // ring readout
        E.ringReadout.textContent = '';
        const lines = [];
        if (b.ends) lines.push(el('div', {}, [el('b', { text: 'Crystals ' + b.ends.cA + ' and ' + b.ends.cB }), ' (block ' + Math.floor(b.ends.cA / G.crystalsPerBlock) + ' and ' + Math.floor(b.ends.cB / G.crystalsPerBlock) + ')']));
        lines.push(el('div', { text: 'θ ' + b.theta.toFixed(2) + '°, r ' + fmtR(b.r) + ', normal n = (' + Math.cos(b.theta * Math.PI / 180).toFixed(2) + ', ' + Math.sin(b.theta * Math.PI / 180).toFixed(2) + ')' }));
        const pr = measured(b.cur, 'prompts', -1);
        const nrm = b.cur.acq.corrections && b.cur.acq.corrections.norm, acf = b.cur.acq.corrections && b.cur.acq.corrections.acf;
        const extra = [];
        if (pr) extra.push('prompts ' + fmtVal(pr[b.l], 'counts'));
        if (nrm) extra.push('efficiency ' + U.fmtNum(nrm[b.l], 3));
        if (acf) extra.push('ACF ' + U.fmtNum(acf[b.l], 3));
        if (extra.length) lines.push(el('div', { text: extra.join(', ') }));
        if (S.point) lines.push(el('div', { text: pointText(S.point) }));
        lines.forEach(function (n) { E.ringReadout.appendChild(n); });
    }
    function pointText(p) {
        return 'Point (' + p.x.toFixed(0) + ', ' + p.y.toFixed(0) + ') mm traces r = ' + p.x.toFixed(0) + ' cos θ ' + (p.y < 0 ? '−' : '+') + ' ' + Math.abs(p.y).toFixed(0) + ' sin θ';
    }
    function linkedRedraw() {
        if (E.iv) E.iv.redraw();
        drawRing();
        updateReadouts();
    }

    /* ---------- the ring ---------- */
    const bgCache = new WeakMap();
    function lutCanvas(data, n, max) {
        const cv = doc.createElement('canvas');
        cv.width = n; cv.height = n;
        const c = cv.getContext('2d'), img = c.createImageData(n, n), px = img.data, lut = U.colormapLUT('pet');
        const inv = max > 0 ? 1 / max : 0;
        for (let k = 0; k < n * n; k++) {
            const t = U.clamp(data[k] * inv, 0, 1);
            if (t <= 0) continue;
            const li = Math.round(t * 255) * 3;
            px[4 * k] = lut[li]; px[4 * k + 1] = lut[li + 1]; px[4 * k + 2] = lut[li + 2]; px[4 * k + 3] = 255;
        }
        c.putImageData(img, 0, 0);
        return cv;
    }
    /* The true activity of the frame (from the scan's truth), or the
       reconstructed image, as a small canvas drawn behind the ring. */
    function background(cur) {
        if (S.ringBg === 'none' || !cur) return null;
        if (S.ringBg === 'image') {
            const R = st().reconResult;
            if (!R || !R.image || !R.n) return null;
            let c = bgCache.get(R.image);
            if (!c) { c = { cv: lutCanvas(R.image, R.n, U.percentile(R.image, 99.7)), fov: R.fov || G.fov }; bgCache.set(R.image, c); }
            return c;
        }
        const F = cur.acq.frames[cur.fi];
        let c = bgCache.get(F);
        if (c) return c;
        let ph = null;
        try { ph = PET.phantoms.build(cur.acq.phantomId, cur.acq.phantomOpts || {}); } catch (e) { return null; }
        const mean = F.truth && F.truth.regionMean;
        if (!ph || !mean) return null;
        const n = ph.n, img = new Float32Array(n * n);
        let mx = 0;
        for (let k = 0; k < img.length; k++) { const v = mean[ph.label[k]] || 0; img[k] = v; if (v > mx) mx = v; }
        // test objects with a single hot pixel stay visible: draw sources as dots later
        c = { cv: lutCanvas(img, n, mx), fov: ph.fov || G.fov, dots: ph.regions.filter(function (r) { return r.pixels > 0 && r.pixels <= 4 && r.cx !== undefined && (mean[r.index] || 0) > 0; }) };
        bgCache.set(F, c);
        return c;
    }
    function ringGeom() {
        const w = E.ringStage.clientWidth;
        if (!w) return null;
        const size = Math.max(200, Math.min(w, 540));
        const outer = G.ringRadius + (G.crystalDepth || 20);
        return { size: size, cx: size / 2, cy: size / 2, k: (size / 2 - 6) / (outer + 4) };
    }
    function drawRing() {
        if (!E.ringCanvas || !S.visible) return;
        const R = ringGeom();
        if (!R) return;
        const r0 = U.setupCanvas(E.ringCanvas, R.size, R.size), ctx = r0.ctx;
        const k = R.k, X = function (x) { return R.cx + x * k; }, Y = function (y) { return R.cy + y * k; };
        const font = U.cssVar('--font-sans', 'sans-serif');
        const photon = U.cssVar('--sev-photon', '#f5d061'), cyan = U.cssVar('--sev-positron', '#5ee0d2');
        ctx.fillStyle = U.cssVar('--scope-bg', '#0b0f17');
        ctx.fillRect(0, 0, R.size, R.size);
        const cur = current();
        const half = G.fov / 2;
        // the object or image, faintly, inside the field of view
        const bg = background(cur);
        if (bg) {
            ctx.save();
            ctx.beginPath(); ctx.arc(R.cx, R.cy, half * k, 0, 2 * Math.PI); ctx.clip();
            ctx.globalAlpha = 0.62;
            ctx.imageSmoothingEnabled = true;
            const hf = bg.fov / 2;
            ctx.drawImage(bg.cv, X(-hf), Y(-hf), bg.fov * k, bg.fov * k);
            ctx.globalAlpha = 1;
            (bg.dots || []).forEach(function (r) {
                ctx.fillStyle = '#ffd36a'; ctx.beginPath(); ctx.arc(X(r.cx), Y(r.cy), 3, 0, 2 * Math.PI); ctx.fill();
            });
            ctx.restore();
        }
        // field of view
        ctx.strokeStyle = 'rgba(135, 148, 168, 0.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.arc(R.cx, R.cy, half * k, 0, 2 * Math.PI); ctx.stroke();
        ctx.setLineDash([]);
        // axes through the centre
        ctx.strokeStyle = 'rgba(135, 148, 168, 0.25)';
        ctx.beginPath(); ctx.moveTo(X(-G.ringRadius), R.cy); ctx.lineTo(X(G.ringRadius), R.cy); ctx.moveTo(R.cx, Y(-G.ringRadius)); ctx.lineTo(R.cx, Y(G.ringRadius)); ctx.stroke();
        // the ring: blocks of crystals
        const Rin = G.ringRadius * k, Rout = (G.ringRadius + (G.crystalDepth || 20)) * k;
        const nC = G.nCrystals, per = G.crystalsPerBlock, dead = st().acq && st().acq.physics && st().acq.physics.detector ? st().acq.physics.detector.deadBlock : -1;
        const dphi = 2 * Math.PI / nC;
        for (let b = 0; b < G.nBlocks; b++) {
            const p0 = b * per * dphi + dphi * 0.15, p1 = (b + 1) * per * dphi - dphi * 0.15;
            ctx.fillStyle = b === dead ? '#7f1d1d' : '#22304a';
            ctx.beginPath(); ctx.arc(R.cx, R.cy, Rout, p0, p1); ctx.arc(R.cx, R.cy, Rin, p1, p0, true); ctx.closePath(); ctx.fill();
        }
        if (dphi * Rin > 3) {
            ctx.strokeStyle = 'rgba(11, 15, 23, 0.7)'; ctx.lineWidth = 0.6;
            ctx.beginPath();
            for (let c = 0; c < nC; c++) {
                if (c % per === 0) continue;
                const p = c * dphi;
                ctx.moveTo(R.cx + Rin * Math.cos(p), R.cy + Rin * Math.sin(p)); ctx.lineTo(R.cx + Rout * Math.cos(p), R.cy + Rout * Math.sin(p));
            }
            ctx.stroke();
        }
        ctx.font = '600 10.5px ' + font;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(135, 148, 168, 0.85)';
        ctx.fillText('field of view ' + G.fov + ' mm', 6, 6);
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText(nC + ' crystals, ring ' + 2 * G.ringRadius + ' mm', R.size - 6, R.size - 6);
        if (dead >= 0) { ctx.fillStyle = '#f87171'; ctx.textAlign = 'left'; ctx.fillText('dead block ' + dead, 6, R.size - 6); }

        // the line of response
        const b = binInfo(S.hover || S.pinned);
        if (b && b.ends) {
            const e = b.ends, th = b.theta * Math.PI / 180, nx = Math.cos(th), ny = Math.sin(th);
            // crystals hit
            [e.cA, e.cB].forEach(function (c) {
                const p0 = c * dphi - dphi * 0.6, p1 = (c + 1) * dphi + dphi * 0.6;
                ctx.fillStyle = photon;
                ctx.beginPath(); ctx.arc(R.cx, R.cy, Rout + 3, p0, p1); ctx.arc(R.cx, R.cy, Rin - 2, p1, p0, true); ctx.closePath(); ctx.fill();
            });
            ctx.save();
            ctx.strokeStyle = photon; ctx.lineWidth = 1.75; ctx.shadowColor = 'rgba(245, 208, 97, 0.6)'; ctx.shadowBlur = 6;
            ctx.beginPath(); ctx.moveTo(X(e.x1), Y(e.y1)); ctx.lineTo(X(e.x2), Y(e.y2)); ctx.stroke();
            ctx.restore();
            // normal from the centre to the foot point r n, and the angle
            const fx = b.r * nx, fy = b.r * ny;
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)'; ctx.lineWidth = 1.25; ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(R.cx, R.cy); ctx.lineTo(X(fx), Y(fy)); ctx.stroke();
            // the normal direction, drawn a little beyond when r is near zero
            const L = Math.max(40, Math.abs(b.r));
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
            ctx.beginPath(); ctx.moveTo(R.cx, R.cy); ctx.lineTo(X(L * nx), Y(L * ny)); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#e2e8f0';
            ctx.beginPath(); ctx.arc(X(fx), Y(fy), 3, 0, 2 * Math.PI); ctx.fill();
            // theta arc from +x, clockwise on screen because y points down
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.7)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(R.cx, R.cy, 22, 0, th, false); ctx.stroke();
            ctx.font = '600 11px ' + font; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
            haloText(ctx, 'θ ' + b.theta.toFixed(1) + '°', R.cx + 28 * Math.cos(th / 2) + 2, R.cy + 28 * Math.sin(th / 2) + 6, '#e2e8f0');
            haloText(ctx, 'r ' + fmtR(b.r), X(fx) + 6, Y(fy) - 10, '#e2e8f0');
            // crystal numbers just inside the ring, next to the crystals hit
            [[e.cA, e.x1, e.y1], [e.cB, e.x2, e.y2]].forEach(function (q) {
                const ang = Math.atan2(q[2], q[1]);
                ctx.textAlign = Math.cos(ang) > 0.3 ? 'right' : (Math.cos(ang) < -0.3 ? 'left' : 'center');
                haloText(ctx, String(q[0]), R.cx + (Rin - 12) * Math.cos(ang), R.cy + (Rin - 12) * Math.sin(ang), photon);
            });
            // a TOF bin: where along the line its events sit
            const cur2 = b.cur;
            if (cur2.nT > 1 && VIEW[S.view].tof && S.tofBin >= 0) {
                const s = G.tofCentre(S.tofBin), dx = -ny, dy = nx, sg = cur2.acq.geom && cur2.acq.geom.sigmaTOF ? cur2.acq.geom.sigmaTOF : 25;
                const cxp = fx + s * dx, cyp = fy + s * dy;
                ctx.save();
                ctx.strokeStyle = 'rgba(94, 224, 210, 0.35)'; ctx.lineWidth = 9; ctx.lineCap = 'round';
                ctx.beginPath(); ctx.moveTo(X(cxp - 2 * sg * dx), Y(cyp - 2 * sg * dy)); ctx.lineTo(X(cxp + 2 * sg * dx), Y(cyp + 2 * sg * dy)); ctx.stroke();
                ctx.strokeStyle = cyan; ctx.lineWidth = 4;
                ctx.beginPath(); ctx.moveTo(X(cxp - G.ds / 2 * dx), Y(cyp - G.ds / 2 * dy)); ctx.lineTo(X(cxp + G.ds / 2 * dx), Y(cyp + G.ds / 2 * dy)); ctx.stroke();
                ctx.restore();
                ctx.font = '600 10.5px ' + font; ctx.textAlign = 'left';
                haloText(ctx, 'TOF bin, s = ' + fmtS(s), X(cxp) + 8, Y(cyp) + 10, cyan);
            }
        }
        // points with sinusoids
        const mark = function (p, color, filled) {
            ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 5, 0, 2 * Math.PI);
            if (filled) ctx.fill(); else ctx.stroke();
            ctx.beginPath(); ctx.moveTo(X(p.x) - 9, Y(p.y)); ctx.lineTo(X(p.x) + 9, Y(p.y)); ctx.moveTo(X(p.x), Y(p.y) - 9); ctx.lineTo(X(p.x), Y(p.y) + 9); ctx.stroke();
        };
        if (S.hoverPoint) mark(S.hoverPoint, 'rgba(255,255,255,0.8)', false);
        if (S.point) {
            mark(S.point, cyan, false);
            ctx.font = '600 10.5px ' + font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            haloText(ctx, '(' + S.point.x.toFixed(0) + ', ' + S.point.y.toFixed(0) + ') mm', X(S.point.x) + 10, Y(S.point.y) - 10, cyan);
        }
        if (!cur) {
            ctx.font = '600 12px ' + font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            haloText(ctx, 'No scan yet', R.cx, R.cy, '#cbd5e1');
        }
    }
    function haloText(ctx, t, x, y, color) {
        ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.strokeText(t, x, y);
        ctx.fillStyle = color; ctx.fillText(t, x, y);
    }
    function wireRing() {
        const cv = E.ringCanvas;
        const toMm = function (ev) {
            const R = ringGeom(), rect = cv.getBoundingClientRect();
            if (!R || !rect.width) return null;
            const px = (ev.clientX - rect.left) * R.size / rect.width, py = (ev.clientY - rect.top) * R.size / rect.height;
            const x = (px - R.cx) / R.k, y = (py - R.cy) / R.k;
            return { x: Math.round(x), y: Math.round(y), inside: Math.hypot(x, y) <= G.fov / 2 };
        };
        let down = null;
        cv.addEventListener('pointermove', function (ev) {
            const p = toMm(ev);
            const hp = p && p.inside ? { x: p.x, y: p.y } : null;
            if (JSON.stringify(hp) === JSON.stringify(S.hoverPoint)) return;
            S.hoverPoint = hp;
            linkedRedraw();
        });
        cv.addEventListener('pointerleave', function () { if (S.hoverPoint) { S.hoverPoint = null; linkedRedraw(); } });
        cv.addEventListener('pointerdown', function (ev) { down = { x: ev.clientX, y: ev.clientY }; });
        cv.addEventListener('pointerup', function (ev) {
            if (!down || Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) > 6) { down = null; return; }
            down = null;
            const p = toMm(ev);
            if (!p) return;
            S.point = p.inside ? { x: p.x, y: p.y } : null;
            if (ev.pointerType !== 'mouse') S.hoverPoint = null;
            linkedRedraw();
        });
        if (root.ResizeObserver) {
            let lastW = -1;
            new root.ResizeObserver(function () {
                const w = E.ringStage.clientWidth;
                if (w === lastW) return;
                lastW = w;
                drawRing();
            }).observe(E.ringStage);
        }
    }

    /* ---------- the radial profile ---------- */
    /* Value of row b (which may run past either end: row -1 is row nA-1
       seen from the other side, so r flips sign) at radial bin i. */
    function rowVal(arr, b, i) {
        if (b < 0 || b >= nA) { b = (b + nA) % nA; i = nR - i; }
        if (i < 0 || i >= nR) return 0;
        return arr[b * nR + i];
    }
    function profileData() {
        const cur = current();
        if (!cur) return null;
        const F = cur.F, ex = F.expected || {};
        if (!ex.trues) return null;
        const key = [S.profA, S.rows].join(':');
        if (profileCache && profileCache.F === F && profileCache.key === key) return profileCache.data;
        const h = (S.rows - 1) / 2, a0 = S.profA;
        const pr = measured(cur, 'prompts', -1);
        const est = cached(F, 'estimate', function () {
            const s = sumTOF(F.scatterEst, cur.nT), r = sumTOF(F.randomsSingles || F.delayed, cur.nT);
            if (!s && !r) return null;
            const o = new Float32Array(NLOR);
            for (let l = 0; l < NLOR; l++) o[l] = (s ? s[l] : 0) + (r ? r[l] : 0);
            return o;
        });
        const avg = function (arr) {
            if (!arr) return null;
            const out = new Float64Array(nR);
            for (let i = 0; i < nR; i++) { let s = 0; for (let b = a0 - h; b <= a0 + h; b++) s += rowVal(arr, b, i); out[i] = s / S.rows; }
            return out;
        };
        const acf = cur.acq.corrections && cur.acq.corrections.acf;
        const tail = new Uint8Array(nR);
        if (acf) for (let i = 0; i < nR; i++) tail[i] = acf[a0 * nR + i] < TAIL_ACF ? 1 : 0;
        const r = new Float64Array(nR);
        for (let i = 0; i < nR; i++) r[i] = G.radius ? G.radius(i) : (i - nR / 2) * G.dr;
        const data = { r: r, T: avg(ex.trues), S: avg(ex.scatter), R: avg(ex.randoms), P: avg(pr), E: avg(est), tail: tail, hasAcf: !!acf, cur: cur };
        profileCache = { F: F, key: key, data: data };
        return data;
    }
    let profLayout = null, profHover = null;
    function renderProfile() {
        if (!E.profCanvas || !S.visible) return;
        const wpx = E.profStage.clientWidth;
        if (!wpx) return;
        const H = 260;
        const r0 = U.setupCanvas(E.profCanvas, wpx, H), ctx = r0.ctx;
        ctx.clearRect(0, 0, wpx, H);
        const col = {
            text: U.cssVar('--muted', '#586170'), fg: U.cssVar('--fg', '#161b22'), grid: U.cssVar('--grid', '#e8ebf0'), axis: U.cssVar('--axis', '#a9b1bd'),
            T: U.cssVar('--ev-true', '#2a78d6'), S: U.cssVar('--ev-scatter', '#d9541e'), R: U.cssVar('--ev-random', '#b5359f'),
            E: U.cssVar('--c3', '#1baf7a'), tail: U.cssVar('--hover', 'rgba(15,23,42,0.05)'), font: U.cssVar('--font-sans', 'sans-serif'), border: U.cssVar('--border-strong', '#c5ccd6')
        };
        const theta = angleOf(S.profA);
        E.profTitle.textContent = 'θ = ' + theta.toFixed(2) + '°' + (S.rows > 1 ? ', mean of ' + S.rows + ' rows' : '') + ', counts per 2 mm bin';
        const d = profileData();
        profLayout = null;
        if (!d) {
            ctx.fillStyle = col.text; ctx.font = '13px ' + col.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(current() ? 'This scan has no expected components to plot.' : 'No scan yet.', wpx / 2, H / 2);
            E.profNote.textContent = '';
            return;
        }
        const n = nR;
        const stackTop = new Float64Array(n);
        let ymax = 0;
        for (let i = 0; i < n; i++) {
            stackTop[i] = (d.T ? d.T[i] : 0) + (d.S ? d.S[i] : 0) + (d.R ? d.R[i] : 0);
            ymax = Math.max(ymax, stackTop[i], d.P ? d.P[i] : 0, d.E ? d.E[i] : 0);
        }
        if (!(ymax > 0)) ymax = 1;
        const ticksY = W()._niceTicks(0, ymax * 1.05, 5);
        const yTop = Math.max(ymax * 1.05, ticksY.ticks[ticksY.ticks.length - 1]);
        ctx.font = '11px ' + col.font;
        let lw = 0;
        ticksY.ticks.forEach(function (v) { lw = Math.max(lw, ctx.measureText(W()._fmtTick(v, ticksY.step)).width); });
        const left = Math.ceil(lw) + 26, right = 12, top = 12, bottom = 34;
        const pw = Math.max(10, wpx - left - right), ph = H - top - bottom;
        const xlo = d.r[0] - G.dr / 2, xhi = d.r[n - 1] + G.dr / 2;
        const X = function (v) { return left + (v - xlo) / (xhi - xlo) * pw; }, Y = function (v) { return top + (1 - v / yTop) * ph; };
        profLayout = { left: left, top: top, pw: pw, ph: ph, X: X, xlo: xlo, xhi: xhi, d: d };
        // tails
        if (d.hasAcf) {
            ctx.fillStyle = col.tail;
            let i = 0;
            while (i < n) {
                if (!d.tail[i]) { i++; continue; }
                let j = i;
                while (j + 1 < n && d.tail[j + 1]) j++;
                ctx.fillRect(X(d.r[i] - G.dr / 2), top, X(d.r[j] + G.dr / 2) - X(d.r[i] - G.dr / 2), ph);
                i = j + 1;
            }
        }
        // grid
        ctx.strokeStyle = col.grid; ctx.lineWidth = 1;
        ctx.beginPath();
        ticksY.ticks.forEach(function (v) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(left, y); ctx.lineTo(left + pw, y); });
        const ticksX = W()._niceTicks(-150, 150, Math.max(2, Math.min(7, Math.round(pw / 80))));
        ticksX.ticks.forEach(function (v) { const x = Math.round(X(v)) + 0.5; ctx.moveTo(x, top); ctx.lineTo(x, top + ph); });
        ctx.stroke();
        // stacked areas: trues at the bottom, scatter, then randoms
        const area = function (lo, hi, color) {
            ctx.beginPath();
            for (let i = 0; i < n; i++) { const x = X(d.r[i]), y = Y(hi[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
            for (let i = n - 1; i >= 0; i--) ctx.lineTo(X(d.r[i]), Y(lo ? lo[i] : 0));
            ctx.closePath();
            ctx.globalAlpha = 0.78; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
        };
        // Background at the bottom (randoms, then scatter) and trues on top,
        // so the scanner's estimate of the background can be compared
        // directly with the top of the scatter band, inside and outside the object.
        const zero = new Float64Array(n), cR = d.R || zero, cRS = new Float64Array(n);
        for (let i = 0; i < n; i++) cRS[i] = cR[i] + (d.S ? d.S[i] : 0);
        ctx.save(); ctx.beginPath(); ctx.rect(left, top - 1, pw, ph + 2); ctx.clip();
        area(null, cR, col.R);
        area(cR, cRS, col.S);
        area(cRS, stackTop, col.T);
        // estimate and prompts
        const line = function (arr, color, width, dash) {
            if (!arr) return;
            ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i = 0; i < n; i++) { const x = X(d.r[i]), y = Y(arr[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
            ctx.stroke(); ctx.setLineDash([]);
        };
        line(d.E, col.E, 2, [6, 4]);
        line(d.P, col.fg, 1.2);
        if (profHover !== null) {
            const i = profHover, x = Math.round(X(d.r[i])) + 0.5;
            ctx.strokeStyle = col.fg; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + ph); ctx.stroke(); ctx.globalAlpha = 1;
        }
        ctx.restore();
        // axes and labels
        ctx.strokeStyle = col.axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left + 0.5, top); ctx.lineTo(left + 0.5, top + ph + 0.5); ctx.lineTo(left + pw, top + ph + 0.5); ctx.stroke();
        ctx.fillStyle = col.text; ctx.font = '11px ' + col.font;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ticksY.ticks.forEach(function (v) { ctx.fillText(W()._fmtTick(v, ticksY.step), left - 6, Y(v)); });
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ticksX.ticks.forEach(function (v) { ctx.fillText(W()._fmtTick(v, ticksX.step), X(v), top + ph + 5); });
        ctx.textBaseline = 'bottom';
        ctx.fillText('radial position r (mm)', left + pw / 2, H - 1);
        ctx.save(); ctx.translate(10, top + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('counts', 0, 0); ctx.restore();
        if (d.hasAcf && d.tail.some(function (v) { return v; })) {
            ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillStyle = col.text; ctx.font = '600 10.5px ' + col.font;
            const firstObj = d.tail.indexOf(0);
            if (firstObj > 8) ctx.fillText('tail', X(d.r[0]) + 4, top + 3);
            let lastObj = -1; for (let i = n - 1; i >= 0; i--) if (!d.tail[i]) { lastObj = i; break; }
            if (lastObj >= 0 && lastObj < n - 8) { ctx.textAlign = 'right'; ctx.fillText('tail', X(d.r[n - 1]) - 4, top + 3); }
        }
        // what the tails hold
        let tS = 0, tR = 0, tT = 0;
        for (let i = 0; i < n; i++) {
            if (!d.tail[i]) continue;
            tS += d.S ? d.S[i] : 0; tR += d.R ? d.R[i] : 0; tT += d.T ? d.T[i] : 0;
        }
        const F = d.cur.F, sc = isFinite(F.scatterScale) ? F.scatterScale : null;
        const tailTot = tS + tR + tT;
        E.profNote.textContent = d.hasAcf && tailTot > 0
            ? 'In the shaded tails (lines whose attenuation factor is below ' + TAIL_ACF + ', which miss the object) there are almost no trues ' +
              '(' + U.fmtPct(tT / tailTot, 0) + ' of the tail counts), only scatter (' + U.fmtPct(tS / tailTot, 0) + ') and randoms (' + U.fmtPct(tR / tailTot, 0) + '). ' +
              'The scanner subtracts the delayed window and scales its scatter model until it matches the tails' + (sc !== null ? ' (scale ' + sc.toFixed(2) + ' in this frame)' : '') +
              '. The dashed line is that estimate of scatter + randoms: it should follow the top of the scatter band, also under the object where it cannot be measured.'
            : 'This row has no lines that miss the object, so there is no tail to fit here; try another angle.';
    }
    function wireProfile() {
        const cv = E.profCanvas;
        cv.addEventListener('pointermove', function (ev) {
            const L = profLayout;
            if (!L) return;
            const rect = cv.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
            if (mx < L.left || mx > L.left + L.pw || my < L.top || my > L.top + L.ph) { hideTip(); return; }
            const v = L.xlo + (mx - L.left) / L.pw * (L.xhi - L.xlo);
            const i = U.clamp(Math.round((v - L.d.r[0]) / G.dr), 0, nR - 1);
            profHover = i;
            renderProfile();
            const d = L.d, rows = [
                ['prompts (measured)', d.P, 'var(--fg)'], ['trues', d.T, 'var(--ev-true)'], ['scatter', d.S, 'var(--ev-scatter)'],
                ['randoms', d.R, 'var(--ev-random)'], ['estimate', d.E, 'var(--c3)']
            ];
            E.profTip.textContent = '';
            E.profTip.appendChild(el('div', { class: 'plot-tip-x', text: 'r ' + fmtR(d.r[i]) + (d.tail[i] ? ', tail' : '') }));
            rows.forEach(function (q) {
                if (!q[1]) return;
                E.profTip.appendChild(el('div', {}, [el('span', { class: 'swatch', style: { background: q[2] }, 'aria-hidden': 'true' }), q[0] + ': ' + U.fmtNum(q[1][i], 3)]));
            });
            E.profTip.hidden = false;
            const tw = E.profTip.offsetWidth, sw = E.profStage.clientWidth;
            let tx = mx + 12;
            if (tx + tw > sw) tx = Math.max(0, mx - 12 - tw);
            E.profTip.style.left = tx + 'px';
            E.profTip.style.top = Math.max(0, Math.min(my - 10, 260 - E.profTip.offsetHeight)) + 'px';
        });
        const hideTip = function () {
            E.profTip.hidden = true;
            if (profHover !== null) { profHover = null; renderProfile(); }
        };
        cv.addEventListener('pointerleave', hideTip);
        if (root.ResizeObserver) {
            let lastW = -1;
            new root.ResizeObserver(function () {
                const w = E.profStage.clientWidth;
                if (w === lastW) return;
                lastW = w;
                renderProfile();
            }).observe(E.profStage);
        }
    }

    /* ---------- counts ---------- */
    const delayedCache = new WeakMap();
    function delayedSum(F) {
        if (!F.delayed) return NaN;
        if (delayedCache.has(F)) return delayedCache.get(F);
        const s = U.sum(F.delayed);
        delayedCache.set(F, s);
        return s;
    }
    function renderCounts() {
        if (!E.counts) return;
        const cur = current(), w = W();
        E.counts.textContent = '';
        E.warn.textContent = '';
        if (!cur) { E.counts.appendChild(w.empty(st().scanning ? 'Scanning.' : 'No scan yet.')); E.cntSub.textContent = ''; return; }
        const acq = cur.acq, F = cur.F, c = F.counts || {}, dyn = acq.frames.length > 1;
        const tot = acq.totals || {};
        E.cntSub.textContent = frameText(F, cur.fi, acq.frames.length) + (cur.partial ? ', so far' : '');
        let dTot = 0;
        if (dyn) acq.frames.forEach(function (Fr) { const v = delayedSum(Fr); if (isFinite(v)) dTot += v; });
        const allTS = (tot.trues || 0) + (tot.scatter || 0), all = allTS + (tot.randoms || 0);
        const scales = acq.frames.map(function (Fr) { return Fr.scatterScale; }).filter(isFinite);
        const smin = scales.length ? Math.min.apply(null, scales) : NaN, smax = scales.length ? Math.max.apply(null, scales) : NaN;
        const cnt = function (v) { return isFinite(v) ? U.fmtCounts(v) : '-'; };
        const rows = [
            { name: 'Prompts', sw: 'var(--fg)', f: cnt(c.prompts), t: cnt(tot.prompts), ex: 'Every coincidence inside the timing window: trues + scatter + randoms, with Poisson noise. The only thing the scanner actually counts.' },
            { name: 'Trues (expected)', sw: 'var(--ev-true)', f: cnt(c.trues), t: cnt(tot.trues), ex: 'Both photons from one annihilation, neither scattered: the signal, on the right line of response.' },
            { name: 'Scatter (expected)', sw: 'var(--ev-scatter)', f: cnt(c.scatter), t: cnt(tot.scatter), ex: 'One photon Compton-scattered in the body but still passed the energy window: a wrong line of response.' },
            { name: 'Randoms (expected)', sw: 'var(--ev-random)', f: cnt(c.randoms), t: cnt(tot.randoms), ex: 'Two photons from different annihilations that arrived within the window. They grow with the square of the activity.' },
            { name: 'Delayed window', f: cnt(delayedSum(F)), t: dyn ? cnt(dTot) : cnt(delayedSum(F)), ex: 'Coincidences with one photon delayed by far more than the window: only randoms can do that, so this measures them (with their own noise).' },
            { name: 'NEC', f: cnt(c.nec), t: cnt(tot.nec), ex: 'Noise-equivalent counts T² / (T + S + R): how many trues alone would give the same noise after scatter and randoms are subtracted.' },
            { name: 'Scatter fraction', f: isFinite(c.sf) ? U.fmtPct(c.sf) : '-', t: allTS > 0 ? U.fmtPct(tot.scatter / allTS) : '-', ex: 'S / (T + S): about 30 to 40 % for a head or a 20 cm cylinder in 3D.' },
            { name: 'Randoms fraction', f: isFinite(c.rf) ? U.fmtPct(c.rf) : '-', t: all > 0 ? U.fmtPct(tot.randoms / all) : '-', ex: 'R / (T + S + R): rises with the dose and with the width of the timing window.' },
            { name: 'Tail-fit scatter scale', f: isFinite(F.scatterScale) ? F.scatterScale.toFixed(2) : '-',
                t: dyn ? (isFinite(smin) ? (smin.toFixed(2) + ' to ' + smax.toFixed(2)) : '-') : (isFinite(F.scatterScale) ? F.scatterScale.toFixed(2) : '-'),
                ex: 'The factor that made the scatter model match (prompts − delayed) in the tails outside the object. Near 1 when the model and the μ map are right.' }
        ];
        const table = el('table', { class: 'sg-counts' });
        table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', text: 'Quantity' }),
            el('th', { scope: 'col', class: 'n', text: dyn ? 'This frame' : 'This scan' }),
            dyn ? el('th', { scope: 'col', class: 'n', text: 'All frames' }) : null
        ])]));
        const body = el('tbody');
        rows.forEach(function (r) {
            const th = el('th', { scope: 'row' }, [
                r.sw ? el('span', { class: 'swatch', style: { background: r.sw }, 'aria-hidden': 'true' }) : null, r.name,
                el('span', { class: 'sg-expl', text: r.ex })
            ]);
            body.appendChild(el('tr', {}, [th, el('td', { class: 'n', text: r.f }), dyn ? el('td', { class: 'n', text: r.t }) : null]));
        });
        table.appendChild(body);
        E.counts.appendChild(table);
        if (cur.partial) E.counts.appendChild(el('p', { class: 'note mt-1', text: 'The scan is still playing back: counts so far in this frame; fractions and the scale are those of the whole frame.' }));
        const warns = (acq.warnings || []).filter(Boolean);
        if (warns.length) {
            E.warn.appendChild(w.callout(el('div', {}, [el('strong', { text: 'The engine reports:' }),
                el('ul', {}, warns.map(function (m) { return el('li', { text: m }); }))]), 'warn'));
        }
    }

    /* ---------- playback: watch the sinogram fill ---------- */
    function onTick(e) {
        if (!e || !S.visible || !S.mounted) return;
        const t = Date.now();
        if (t - S.lastTick < 220) return;
        S.lastTick = t;
        const acq = st().acq;
        if (!acq || !acq.frames || !PET.app || typeof PET.app._partialAcq !== 'function') return;
        const fi = U.clamp(st().frame || 0, 0, acq.frames.length - 1);
        const frac = fi < e.frame ? 1 : (fi === e.frame ? U.clamp(e.frameFrac, 0, 1) : 0);
        try {
            const part = PET.app._partialAcq(Object.assign({}, acq, { frames: [acq.frames[fi]] }), [frac]);
            S.partial = { acq: acq, fi: fi, F: part.frames[0], frac: frac };
        } catch (err) { S.partial = null; return; }
        profileCache = null;
        try { renderSino(); renderProfile(); renderCounts(); updateBadges(); } catch (err) { report(err); }
    }

    /* ---------- tab hooks ---------- */
    function onShow() {
        S.visible = true;
        if (!S.mounted) return;
        renderAll();
    }
    function onHide() { S.visible = false; S.hover = null; S.hoverPoint = null; }

    PET.ui.registerTab({ id: 'sinogram', title: 'Sinogram', order: 50, mount: mount, onShow: onShow, onHide: onHide });

})(typeof window !== 'undefined' ? window : globalThis);
