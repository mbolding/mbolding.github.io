/* ============================================================
   PET Simulator, Isotopes & tracers tab
   The physics and biology that come before any scanner: the three
   positron emitters (how fast they decay, how far their positrons
   travel before annihilating), the tracer catalogue (what each one
   follows in the body and which compartment model describes it),
   and, for the protocol that is loaded, the tracer's plasma input
   function and the time-activity curves of the phantom's regions.

   Everything is read from isotopes.js, kinetics.js and the current
   program and phantom; nothing here changes the simulation except
   the "load a preset" buttons, which go through PET.actions.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !PET.util) return;
    const U = PET.util;

    const CLOUD_N = 4000;         // annihilation points in the cloud
    const CLOUD_HALF = 10;        // mm, half-width of the cloud's field
    const PIXEL = 2.5;            // mm, the reconstructed image pixel (128 over 320 mm)
    const CRYSTAL = 4;            // mm, crystal width (scanner.geom.crystalWidth)
    const ISO_COLOR = { F18: 'var(--c1)', C11: 'var(--c3)', O15: 'var(--c2)' };
    /* Regions plotted for the brain: the ones every lesson talks about. */
    const KEY_REGIONS = ['gm_frontal', 'gm_temporal', 'gm_occipital', 'wm', 'putamen_r_post', 'putamen_l_post', 'cereb_gm', 'sinus'];
    const MODEL_WORDS = {
        '1tc': { short: '1 tissue', long: 'One tissue compartment: diffuses in and out freely, no binding (K1, k2).' },
        '2tci': { short: '2 tissue, irreversible', long: 'Two tissue compartments, irreversible: taken up and then trapped, so it accumulates (K1, k2, k3; k4 = 0).' },
        '2tcr': { short: '2 tissue, reversible', long: 'Two tissue compartments, reversible: binds its target and lets go again, so the signal depends on when you look (K1 to k4).' }
    };
    const REGION_NAMES = { cereb_gm: 'Cerebellar gray matter' };

    const CSS = `
#tab-tracer h2.panel-title { font-size: 0.98rem; }
#tab-tracer .plot-stage > canvas.tr-under { position: absolute; left: 0; top: 0; pointer-events: none; }
#tab-tracer .plot-stage > .plot-canvas { position: relative; }
#tab-tracer .tr-h3 { font-size: 0.9rem; margin: 0 0 4px; }

/* isotope cards */
#tab-tracer .tr-isos { --min: 250px; }
#tab-tracer .tr-iso {
    position: relative; min-width: 0; padding: 12px 14px 12px; border-radius: 9px;
    border: 1px solid var(--border); border-top: 3px solid var(--tr-iso, var(--accent)); background: var(--card-2);
}
#tab-tracer .tr-iso.is-current { background: var(--accent-soft); border-color: var(--accent-border); border-top-color: var(--tr-iso, var(--accent)); box-shadow: 0 0 0 1px var(--accent-border); }
#tab-tracer .tr-iso-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; min-width: 0; }
#tab-tracer .tr-iso-sym { font: 750 1.65rem/1 var(--font-sans); letter-spacing: -0.02em; color: var(--tr-iso, var(--fg)); min-width: 2.4ch; }
#tab-tracer .tr-iso-name { font-weight: 650; font-size: 0.95rem; line-height: 1.25; }
#tab-tracer .tr-iso-sub { font-size: 0.78rem; color: var(--muted); }
#tab-tracer .tr-iso-head .badge { margin-left: auto; flex: none; }
#tab-tracer .tr-iso .stat-table td { overflow-wrap: normal; }
#tab-tracer .tr-iso .note { margin: 8px 0 0; font-size: 0.78rem; }

/* decay */
#tab-tracer .tr-left { font-size: 0.82rem; margin: 8px 0 0; }
#tab-tracer .tr-left .num { font-family: var(--font-mono); font-weight: 600; }
#tab-tracer .tr-left .tr-left-iso + .tr-left-iso::before { content: " · "; color: var(--faint); }

/* positron range */
#tab-tracer .tr-cmp { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 10px; }
#tab-tracer .tr-cmp th, #tab-tracer .tr-cmp td { padding: 4px 6px; text-align: right; border-top: 1px solid var(--border-subtle); font-variant-numeric: tabular-nums; }
#tab-tracer .tr-cmp td { font-family: var(--font-mono); }
#tab-tracer .tr-cmp th:first-child { text-align: left; font-weight: 500; color: var(--muted); }
#tab-tracer .tr-cmp thead th { border-top: 0; font-weight: 650; }
#tab-tracer .tr-cloud-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
#tab-tracer .tr-cloud-well { padding: 8px; }
#tab-tracer .tr-cloud-stage { display: flex; justify-content: center; }
#tab-tracer .tr-cloud-canvas { display: block; border-radius: 4px; }
#tab-tracer .tr-range .stats { margin-top: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
#tab-tracer .tr-range .stat { padding: 7px 9px; }
#tab-tracer .tr-range .stat-value { font-size: 1rem; }

/* tracer table */
#tab-tracer .tr-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
#tab-tracer .tr-table th, #tab-tracer .tr-table td { text-align: left; padding: 8px 8px; vertical-align: top; border-top: 1px solid var(--border-subtle); }
#tab-tracer .tr-table thead th { border-top: 0; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); padding-top: 0; }
#tab-tracer .tr-table td.num { font-family: var(--font-mono); font-size: 0.8rem; white-space: nowrap; }
#tab-tracer .tr-row { cursor: pointer; }
#tab-tracer .tr-row:hover > td { background: var(--hover); }
#tab-tracer .tr-row.is-current > td { background: var(--accent-soft); }
#tab-tracer .tr-row.is-current > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
#tab-tracer .tr-name-btn {
    appearance: none; -webkit-appearance: none; border: 0; background: none; padding: 0; margin: 0; cursor: pointer;
    font: inherit; color: var(--fg); text-align: left; display: inline-flex; align-items: baseline; gap: 6px;
}
#tab-tracer .tr-name-btn::before {
    content: ""; width: 6px; height: 6px; flex: none; position: relative; top: -2px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform 0.15s ease;
}
#tab-tracer .tr-name-btn[aria-expanded="true"]::before { transform: rotate(45deg); }
#tab-tracer .tr-name-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
#tab-tracer .tr-tname { font-weight: 650; }
#tab-tracer .tr-tsub { display: block; font-size: 0.76rem; color: var(--muted); margin-left: 12px; }
#tab-tracer .tr-row .badge { margin-left: 12px; margin-top: 4px; }
#tab-tracer .tr-detail > td { background: var(--card-2); border-top: 0; padding: 4px 12px 12px 22px; }
#tab-tracer .tr-detail p { margin: 6px 0; font-size: 0.84rem; }
#tab-tracer .tr-detail .row { margin-top: 8px; }
#tab-tracer .tr-detail .row > span { font-size: 0.82rem; color: var(--muted); }
@media (max-width: 860px) {
    #tab-tracer .tr-table thead { display: none; }
    #tab-tracer .tr-table, #tab-tracer .tr-table tbody, #tab-tracer .tr-table tr, #tab-tracer .tr-table td { display: block; width: auto; }
    #tab-tracer .tr-table tr.tr-row { border: 1px solid var(--border); border-radius: 8px; margin-top: 8px; padding: 6px 0; }
    #tab-tracer .tr-table tr.tr-row > td { border-top: 0; padding: 3px 12px; background: none; }
    #tab-tracer .tr-table tr.tr-row.is-current { border-color: var(--accent-border); background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent); }
    #tab-tracer .tr-table tr.tr-row.is-current > td:first-child { box-shadow: none; }
    #tab-tracer .tr-table tr.tr-row > td[data-label]::before {
        content: attr(data-label); display: inline-block; min-width: 9.5em; margin-right: 6px;
        font: 600 0.72rem var(--font-sans); letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted);
    }
    #tab-tracer .tr-table td.num { white-space: normal; }
    #tab-tracer .tr-table tr.tr-detail { border: 1px solid var(--border); border-top: 0; border-radius: 0 0 8px 8px; margin-top: -4px; }
    #tab-tracer .tr-detail > td { padding: 6px 12px 10px; }
}

/* current tracer */
#tab-tracer .tr-cur-tools { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 10px; }
#tab-tracer .tr-cur-tools .ctl-label { margin-right: 6px; }
#tab-tracer .tr-cur .note { margin: 8px 0 0; }
#tab-tracer .tr-fig-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; }
#tab-tracer .tr-fig-head .tr-h3 { margin: 0; }
`;

    /* ---------- helpers ---------- */
    const el = function (tag, attrs, kids) { return U.el(tag, attrs, kids); };
    const W = function () { return PET.ui.w; };
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const st = function () { return PET.state || {}; };
    function goodProgram() { const s = st(); return s.program && s.program.ok ? s.program : (s.lastGoodProgram || null); }
    function isotopes() { try { return PET.isotopes ? PET.isotopes.list() : []; } catch (e) { return []; } }
    function tracers() { try { return PET.tracers ? PET.tracers.list() : []; } catch (e) { return []; } }
    function tracerById(id) { try { return id && PET.tracers ? PET.tracers.get(id) : null; } catch (e) { return null; } }
    function pct(x) { return !isFinite(x) ? '-' : (x > 0 && x < 0.001 ? '< 0.1 %' : U.fmtNum(100 * x, 3) + ' %'); }
    function halfLifeText(iso) { return iso.halfLife >= 600 ? U.fmtNum(iso.halfLife / 60, 4) + ' min' : U.fmtNum(iso.halfLife, 3) + ' s'; }
    function color(c) {
        if (typeof c !== 'string') return '#888';
        const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(c.trim());
        return m ? U.cssVar(m[1], '#888') : c;
    }
    function log10fmt(v) {
        const x = Math.pow(10, v);
        if (x >= 1) return U.fmtNum(x, 3);
        if (x >= 1e-3) return String(Number(x.toPrecision(2)));
        return x.toExponential(0).replace('e-', 'e-');
    }
    function presetTracers() {
        if (presetTracers.cache) return presetTracers.cache;
        const out = {};
        (Array.isArray(PET.presets) ? PET.presets : []).forEach(function (p) {
            let id = null;
            try { const prog = PET.dsl ? PET.dsl.compile(p.source, {}) : null; id = prog && prog.ok ? prog.tracer : null; } catch (e) { id = null; }
            if (!id) { const m = /^\s*tracer\s+([A-Za-z0-9_-]+)/m.exec(p.source || ''); id = m && PET.tracers ? PET.tracers.normalizeId(m[1]) : null; }
            if (id) (out[id] = out[id] || []).push(p);
        });
        return (presetTracers.cache = out);
    }
    function regionName(id) {
        if (!id) return null;
        try {
            const ph = PET.actions && PET.actions.getPhantom ? PET.actions.getPhantom() : null;
            const r = ph && ph.regions ? ph.regions.find(function (x) { return x.id === id; }) : null;
            if (r) return r.name;
        } catch (e) { /* phantom unavailable */ }
        return REGION_NAMES[id] || id;
    }

    /* Shaded bands behind a PET.ui.w.plot (frames, the crystal width),
       mapped through the plot's own layout. Same helper as the Protocol
       tab, kept local so each tab stands on its own. */
    function bandLayer(plot) {
        const stage = plot.canvas.parentNode;
        const under = el('canvas', { class: 'tr-under', 'aria-hidden': 'true' });
        stage.insertBefore(under, plot.canvas);
        let spec = { bands: [] };
        function paint() {
            const w = plot.canvas.clientWidth, h = plot.canvas.clientHeight;
            if (!w || !h) return;
            const r = U.setupCanvas(under, w, h), ctx = r.ctx;
            ctx.clearRect(0, 0, w, h);
            const L = plot.layout ? plot.layout() : null;
            if (!L || !spec) return;
            ctx.save();
            ctx.beginPath(); ctx.rect(L.left, L.top, L.pw, L.ph); ctx.clip();
            (spec.bands || []).forEach(function (b) {
                const a = Math.max(Math.min(b.x0, b.x1), L.xlo), z = Math.min(Math.max(b.x0, b.x1), L.xhi);
                if (!(z >= a)) return;
                let x0 = L.X(a), x1 = L.X(z);
                if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
                if (x1 - x0 < 1.5) x1 = x0 + 1.5;
                ctx.globalAlpha = b.alpha !== undefined ? b.alpha : 0.15;
                ctx.fillStyle = color(b.color || 'var(--accent)');
                ctx.fillRect(x0, L.top, x1 - x0, L.ph);
                if (b.label) {
                    ctx.globalAlpha = 1;
                    ctx.font = '600 11px ' + U.cssVar('--font-sans', 'sans-serif');
                    ctx.fillStyle = U.cssVar('--muted', '#666'); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
                    ctx.fillText(b.label, (x0 + x1) / 2, L.top + L.ph - 4);
                }
            });
            ctx.restore();
            ctx.globalAlpha = 1;
        }
        const draw0 = plot.draw, redraw0 = plot.redraw;
        plot.draw = function (series, opts) { draw0(series, opts); paint(); return plot; };
        plot.redraw = function () { redraw0(); paint(); return plot; };
        if (root.ResizeObserver) new root.ResizeObserver(function () { raf(paint); }).observe(stage);
        if (PET.bus) PET.bus.on('theme:changed', function () { raf(paint); });
        return { set: function (s) { spec = s || { bands: [] }; paint(); } };
    }
    /* A static frame is one clear band; the many frames of a dynamic
       scan cover the whole axis, so they alternate between two light
       shades that only mark where one frame ends and the next begins. */
    function frameBands(prog, alpha) {
        if (!prog || !prog.frames) return [];
        const a = alpha || 0.14;
        return prog.frames.map(function (f, i) { return { x0: f.t0 / 60, x1: f.t1 / 60, alpha: prog.dynamic ? (i % 2 ? 0.5 * a : 0.15 * a) : a }; });
    }

    /* ============================================================
       The tab
       ============================================================ */
    const T = {
        visible: false, dirty: true, frameReq: 0,
        logDecay: false, cloudIso: null, cloudSeed: 1, samples: {},
        units: 'kBq', physical: false, open: null
    };

    function mount(panel) {
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        if (!PET.ui.w) { panel.appendChild(el('div', { class: 'error-card', text: 'The shared widgets (js/ui/widgets.js) did not load, so this tab cannot be drawn.' })); return; }
        const w = W();

        // 1. concept
        panel.appendChild(w.concept({
            title: 'Isotopes decay; tracers follow biology',
            body: '<p>A positron emitter decays at a fixed rate: after one <b>half-life</b> half of it is left, whatever you do. Each positron ' +
                'travels a short way (its <b>range</b>: under a millimetre for <sup>18</sup>F, a few for <sup>15</sup>O) before it meets an electron ' +
                'and the two annihilate into two 511 keV photons, so the scanner sees where the positron stopped, not the molecule that emitted it.</p>' +
                '<p>The <b>tracer principle</b>: a trace amount of a labelled molecule, far too little to change anything, follows the same pathway ' +
                'as the natural one. Some tracers are <b>trapped</b> where the process happens (FDG after phosphorylation) and accumulate; others ' +
                '<b>bind reversibly</b> and wash out again (amyloid and transporter ligands), so their images depend on when you look.</p>',
            formula: 'A(t) = A<sub>0</sub> &middot; 2<sup>&minus;t / T<sub>&frac12;</sub></sup>',
            tryThis: [
                { html: 'Read the decay plot at 60 min: <sup>11</sup>C is down to 13 % and <sup>18</sup>F to 68 %. Which one could a hospital two hours from the cyclotron use?' },
                { html: 'Show <sup>15</sup>O in the positron-range cloud and compare its spread with one 4 mm crystal.',
                    label: 'Show 15O', run: function () { setCloudIso('O15'); scrollTo(T.rangePanel); } },
                { html: 'Switch the regional curves to <b>physical</b>: that is what the scanner counts. Decay correction gives back the biology.',
                    label: 'Physical', run: function () { T.physical = true; T.decaySeg.set('phys'); renderCurrent(); scrollTo(T.curPanel); } },
                { html: 'Load the FE-PE2I preset (Parkinson\'s disease) and compare the left and right posterior putamen curves.',
                    label: 'Load it', run: function () { if (PET.actions) PET.actions.loadPreset('fepe2i_static'); scrollTo(T.curPanel); } }
            ]
        }));

        // 2. isotope cards
        const isoPanel = el('section', { class: 'panel', 'aria-labelledby': 'tr-iso-title' });
        isoPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'tr-iso-title', text: 'Three positron emitters' }),
            el('span', { class: 'panel-sub', text: 'Highlighted: the isotope of the protocol that is loaded.' })
        ]));
        T.isoGrid = el('div', { class: 'grid tr-isos' });
        isoPanel.appendChild(T.isoGrid);
        if (!isotopes().length) T.isoGrid.appendChild(w.empty('The isotope table (js/isotopes.js) did not load.'));
        T.isoCards = {};
        isotopes().forEach(function (iso) {
            const card = el('article', { class: 'tr-iso', style: { '--tr-iso': color(ISO_COLOR[iso.id] || iso.color) }, 'aria-label': iso.name });
            T.isoCards[iso.id] = card;
            const badge = w.badge('your protocol', 'accent');
            badge.hidden = true;
            card._badge = badge;
            card.appendChild(el('div', { class: 'tr-iso-head' }, [
                el('span', { class: 'tr-iso-sym', text: iso.label, 'aria-hidden': 'true' }),
                el('div', {}, [el('div', { class: 'tr-iso-name', text: iso.name }), el('div', { class: 'tr-iso-sub', text: pct(Math.exp(-Math.LN2 * 3600 / iso.halfLife)) + ' left after 1 hour' })]),
                badge
            ]));
            const users = tracers().filter(function (t) { return t.isotope === iso.id; }).map(function (t) { return t.id; });
            card.appendChild(w.statTable([
                { label: 'Half-life', value: halfLifeText(iso), hint: 'Time for half of the nuclei to decay' },
                { label: 'Positron yield', value: pct(iso.betaPlus), hint: 'Share of decays that emit a positron (the rest decay by electron capture and are invisible to PET)' },
                { label: 'Positron energy', value: 'max ' + Math.round(iso.eMax) + ', mean ' + Math.round(iso.eMean) + ' keV', hint: 'Kinetic energy of the emitted positron: a spectrum up to the maximum' },
                { label: 'Range in water', value: 'mean ' + iso.rangeMean + ', max ' + iso.rangeMax + ' mm', hint: 'How far the positron travels before it annihilates (3D, textbook values)' },
                { label: 'Tracers here', value: users.length ? users.join(', ') : 'none' }
            ], { compact: true }));
            card.appendChild(el('p', { class: 'note', html: '<strong>Made by</strong> ' + nuclides(iso.production) + '.' }));
            T.isoGrid.appendChild(card);
        });
        panel.appendChild(isoPanel);

        // 3. decay
        const decPanel = el('section', { class: 'panel', 'aria-labelledby': 'tr-dec-title' });
        T.decSeg = w.segmented({
            ariaLabel: 'Vertical axis', size: 'sm', value: 'lin',
            options: [{ value: 'lin', label: 'Linear' }, { value: 'log', label: 'Log' }],
            onChange: function (v) { T.logDecay = v === 'log'; renderDecay(); }
        });
        decPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'tr-dec-title', text: 'Radioactive decay' }),
            el('span', { class: 'panel-sub', text: 'Shaded: the frames of your protocol.' }),
            el('span', { class: 'spacer' }), T.decSeg
        ]));
        T.decPlot = w.plot(decPanel, { height: 250, xlabel: 'Time after injection (min)', ylabel: 'Activity left' });
        T.decBands = bandLayer(T.decPlot);
        T.decLeft = el('p', { class: 'note tr-left' });
        decPanel.appendChild(T.decLeft);
        panel.appendChild(decPanel);

        // 4. positron range
        const rp = T.rangePanel = el('section', { class: 'panel tr-range', 'aria-labelledby': 'tr-rng-title' });
        rp.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'tr-rng-title', text: 'Positron range: where the annihilation happens' }),
            el('span', { class: 'panel-sub', text: 'In water (soft tissue is close to water).' })
        ]));
        const rs = el('div', { class: 'split-even' });
        const left = el('div');
        left.appendChild(el('h3', { class: 'tr-h3', text: 'Profile across a line source' }));
        T.rngPlot = w.plot(left, { height: 250, xlabel: 'Distance from the decay (mm)', ylabel: 'Probability per mm' });
        T.rngBands = bandLayer(T.rngPlot);
        T.cmp = el('table', { class: 'tr-cmp' });
        left.appendChild(T.cmp);
        left.appendChild(el('p', { class: 'note', text: 'The profile has a sharp cusp (most positrons stop close by, so the FWHM is small) and a long tail ' +
            '(a few travel several millimetres), so the full width at a tenth of the maximum grows much faster than the FWHM. The log axis shows the tail.' }));
        const right = el('div');
        right.appendChild(el('h3', { class: 'tr-h3', text: 'Where ' + CLOUD_N.toLocaleString('en-US') + ' positrons annihilate' }));
        T.cloudSeg = w.segmented({
            ariaLabel: 'Isotope shown in the cloud', size: 'sm', value: 'F18',
            options: isotopes().map(function (i) { return { value: i.id, label: i.label }; }),
            onChange: function (v) { T.cloudIso = v; renderCloud(); }
        });
        T.cloudIso = null;
        const resample = w.button({ label: 'New sample', size: 'sm', title: 'Draw a fresh set of positron flights', onClick: function () { T.cloudSeed++; renderCloud(); } });
        right.appendChild(el('div', { class: 'tr-cloud-tools' }, [T.cloudSeg, resample]));
        const well = el('figure', { class: 'well tr-cloud-well' });
        T.cloudStage = el('div', { class: 'tr-cloud-stage' });
        T.cloud = el('canvas', { class: 'tr-cloud-canvas', role: 'img', 'aria-label': 'Annihilation points around a decay at the centre' });
        T.cloudStage.appendChild(T.cloud);
        well.appendChild(T.cloudStage);
        T.cloudCap = el('figcaption', { class: 'well-readout' });
        well.appendChild(T.cloudCap);
        right.appendChild(well);
        T.cloudStats = el('div', { class: 'stats' });
        right.appendChild(T.cloudStats);
        right.appendChild(el('p', { class: 'note', text: 'The nucleus sits at the centre of a 2.5 mm image pixel (outlined); the shaded column is one 4 mm crystal. ' +
            'Range blur adds to the detector blur, which is why small hot rods filled with 15O merge (load the Hot rods preset and change F18 to O15).' }));
        rs.appendChild(left); rs.appendChild(right);
        rp.appendChild(rs);
        rp.appendChild(el('p', { class: 'simplification', text: 'Simplified: one in-plane displacement per decay from a two-exponential fit in water; real ranges also depend on the tissue (longer in lung, shorter in bone).' }));
        panel.appendChild(rp);
        if (root.ResizeObserver) new root.ResizeObserver(function () { if (T.visible) raf(renderCloud); }).observe(T.cloudStage);

        // 5. tracer table
        const tp = el('section', { class: 'panel', 'aria-labelledby': 'tr-tab-title' });
        tp.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'tr-tab-title', text: 'The tracers' }),
            el('span', { class: 'panel-sub', text: 'Click a tracer to load a protocol that uses it.' })
        ]));
        T.tbody = el('tbody');
        const head = el('thead', {}, [el('tr', {}, ['Tracer', 'Follows', 'Isotope', 'Model', 'Reference region', 'Typical dose', 'Uptake', 'Duration'].map(function (h) { return el('th', { scope: 'col', text: h }); }))]);
        const table = el('table', { class: 'tr-table' }, [head, T.tbody]);
        tp.appendChild(table);
        if (!tracers().length) tp.appendChild(w.empty('The tracer catalogue (js/isotopes.js) did not load.'));
        tp.appendChild(el('p', { class: 'simplification', text: 'Simplified: the plasma curves are of the parent tracer only. Real amyloid and transporter tracers are metabolised quickly, and an analysis has to correct the measured plasma for labelled metabolites.' }));
        panel.appendChild(tp);

        // 6. current tracer
        const cp = T.curPanel = el('section', { class: 'panel tr-cur', 'aria-labelledby': 'tr-cur-title' });
        T.curTitle = el('h2', { class: 'panel-title', id: 'tr-cur-title', text: 'Your protocol\'s tracer' });
        T.curSub = el('span', { class: 'panel-sub' });
        cp.appendChild(el('div', { class: 'panel-head' }, [T.curTitle, T.curSub]));
        T.unitSeg = w.segmented({
            ariaLabel: 'Concentration units', size: 'sm', value: 'kBq',
            options: [{ value: 'kBq', label: 'kBq/mL' }, { value: 'suv', label: 'SUV' }],
            onChange: function (v) { T.units = v; renderCurrent(); }
        });
        T.decaySeg = w.segmented({
            ariaLabel: 'Decay correction', size: 'sm', value: 'corr',
            options: [{ value: 'corr', label: 'Decay corrected', title: 'Concentration as if the isotope did not decay: the biology' },
                { value: 'phys', label: 'Physical', title: 'Activity actually present, decaying: what the scanner counts' }],
            onChange: function (v) { T.physical = v === 'phys'; renderCurrent(); }
        });
        cp.appendChild(el('div', { class: 'tr-cur-tools' }, [T.unitSeg, T.decaySeg]));
        T.curMsg = el('div');
        cp.appendChild(T.curMsg);
        T.curBody = el('div', { class: 'split-even' });
        const pBox = el('div'), tBox = el('div');
        T.cpLogSeg = w.segmented({
            ariaLabel: 'Plasma axis', size: 'sm', value: 'lin',
            options: [{ value: 'lin', label: 'Linear' }, { value: 'log', label: 'Log', title: 'A log axis shows the bolus and the slow tail together' }],
            onChange: function (v) { T.cpLog = v === 'log'; renderCurrent(); }
        });
        pBox.appendChild(el('div', { class: 'tr-fig-head' }, [el('h3', { class: 'tr-h3', text: 'Plasma input function' }), T.cpLogSeg]));
        T.cpPlot = w.plot(pBox, { height: 250, xlabel: 'Time after injection (min)', ylabel: 'Plasma' });
        T.cpBands = bandLayer(T.cpPlot);
        T.cpEmpty = w.empty('');
        T.cpEmpty.hidden = true;
        pBox.appendChild(T.cpEmpty);
        T.cpNote = el('p', { class: 'note' });
        pBox.appendChild(T.cpNote);
        T.tacTitle = el('h3', { class: 'tr-h3', text: 'Regional time-activity curves' });
        tBox.appendChild(T.tacTitle);
        T.tacPlot = w.plot(tBox, { height: 250, xlabel: 'Time after injection (min)', ylabel: 'Tissue' });
        T.tacBands = bandLayer(T.tacPlot);
        T.tacEmpty = w.empty('');
        T.tacEmpty.hidden = true;
        tBox.appendChild(T.tacEmpty);
        T.tacNote = el('p', { class: 'note' });
        tBox.appendChild(T.tacNote);
        T.curBody.appendChild(pBox); T.curBody.appendChild(tBox);
        cp.appendChild(T.curBody);
        cp.appendChild(el('p', { class: 'simplification', text: 'Simplified: plasma is taken to equal whole blood (the sinus curve is the plasma curve), there are no labelled metabolites, and every curve is the model\'s exact value, without noise.' }));
        panel.appendChild(cp);

        // bus
        PET.bus.on('program:compiled', invalidate);
        PET.bus.on('phantom:changed', invalidate);
        PET.bus.on('preset:loaded', invalidate);
        PET.bus.on('theme:changed', function () { if (T.visible) raf(renderCloud); renderIsoColors(); });
        T.dirty = true;
    }

    function scrollTo(node) {
        if (!node) return;
        try { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { node.scrollIntoView(); }
    }
    function setCloudIso(id) { T.cloudIso = id; T.cloudSeg.set(id); renderCloud(); }

    function invalidate() {
        T.dirty = true;
        if (!T.visible || T.frameReq) return;
        T.frameReq = raf(function () { T.frameReq = 0; if (T.visible && T.dirty) renderAll(); });
    }
    function renderAll() {
        T.dirty = false;
        const steps = [renderIsoCards, renderDecay, renderRange, renderCloud, renderTable, renderCurrent];
        steps.forEach(function (f) {
            try { f(); } catch (e) { if (root.console) root.console.error('[tracer tab] ' + f.name + ' failed:', e); }
        });
    }

    /* ---------- isotope cards ---------- */
    function renderIsoColors() {
        isotopes().forEach(function (iso) { const c = T.isoCards && T.isoCards[iso.id]; if (c) c.style.setProperty('--tr-iso', color(ISO_COLOR[iso.id] || iso.color)); });
    }
    function renderIsoCards() {
        const prog = goodProgram(), cur = prog ? prog.isotope : null;
        renderIsoColors();
        Object.keys(T.isoCards || {}).forEach(function (id) {
            const c = T.isoCards[id], on = id === cur;
            c.classList.toggle('is-current', on);
            c._badge.hidden = !on;
        });
    }

    /* ---------- decay curves ---------- */
    function renderDecay() {
        const prog = goodProgram(), list = isotopes();
        if (!list.length) return;
        const tEnd = Math.max(180 * 60, prog ? prog.scanEnd * 1.05 : 0);
        const N = 721, x = new Float64Array(N);
        for (let i = 0; i < N; i++) x[i] = tEnd * i / (N - 1) / 60;
        const log = T.logDecay;
        const series = list.map(function (iso) {
            const lam = Math.LN2 / iso.halfLife, y = new Float64Array(N);
            for (let i = 0; i < N; i++) {
                const f = Math.exp(-lam * x[i] * 60);
                y[i] = log ? (f > 0 ? Math.max(-12, Math.log10(f)) : -12) : 100 * f;
            }
            const mine = prog && prog.isotope === iso.id;
            return { x: x, y: y, label: iso.label + ' (' + halfLifeText(iso) + ')', color: ISO_COLOR[iso.id] || iso.color, width: mine ? 2.75 : 1.6 };
        });
        const markers = list.map(function (iso) { return { x: iso.halfLife / 60, label: 'T½ ' + iso.label, color: ISO_COLOR[iso.id] || iso.color }; });
        const half = log ? Math.log10(0.5) : 50;
        T.decPlot.draw(series, {
            xlim: [0, tEnd / 60], ylim: log ? [-4, 0.15] : [0, 105], legend: true, markers: markers,
            hlines: [{ y: half, label: 'half left', color: 'var(--muted)' }],
            yfmt: log ? function (v) { return log10fmt(v + 2) + ' %'; } : function (v) { return U.fmtNum(v, 3) + ' %'; }
        });
        T.decBands.set({ bands: frameBands(prog) });
        T.decLeft.textContent = '';
        if (prog && prog.frames && prog.frames.length) {
            const t0 = Math.max(0, prog.scanStart);
            T.decLeft.appendChild(el('span', { text: 'Left when your scan starts (' + U.fmtNum(t0 / 60, 3) + ' min after injection): ' }));
            list.forEach(function (iso) {
                const f = Math.exp(-Math.LN2 / iso.halfLife * t0);
                T.decLeft.appendChild(el('span', { class: 'tr-left-iso' }, [iso.label + ' ', el('span', { class: 'num', text: pct(f) })]));
            });
        } else T.decLeft.textContent = 'Write a protocol that compiles to see its frames on the decay curves.';
    }

    /* ---------- positron range ---------- */
    function renderRange() {
        const list = isotopes();
        if (!list.length || !PET.isotopes.rangeProfile) return;
        const N = 401, x = new Float64Array(N);
        for (let i = 0; i < N; i++) x[i] = -CLOUD_HALF + 2 * CLOUD_HALF * i / (N - 1);
        const prog = goodProgram();
        const series = list.map(function (iso) {
            const y = new Float64Array(N);
            for (let i = 0; i < N; i++) { const p = PET.isotopes.rangeProfile(iso, x[i]); y[i] = p > 0 ? Math.max(-6, Math.log10(p)) : -6; }
            return { x: x, y: y, label: iso.label, color: ISO_COLOR[iso.id] || iso.color, width: prog && prog.isotope === iso.id ? 2.5 : 1.6 };
        });
        T.rngPlot.draw(series, { xlim: [-CLOUD_HALF, CLOUD_HALF], ylim: [-5, 1.2], legend: true, yfmt: function (v) { return log10fmt(v); } });
        T.rngBands.set({ bands: [{ x0: -CRYSTAL / 2, x1: CRYSTAL / 2, alpha: 0.1, label: '4 mm crystal' }] });
        // comparison table
        T.cmp.textContent = '';
        T.cmp.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: '1D profile' })].concat(list.map(function (i) { return el('th', { scope: 'col', text: i.label }); })))]));
        const body = el('tbody');
        const rows = [
            ['FWHM', function (i) { return PET.isotopes.rangeWidths(i).fwhm; }],
            ['FWTM (tenth max)', function (i) { return PET.isotopes.rangeWidths(i).fwtm; }],
            ['Mean distance', function (i) { return PET.isotopes.rangeStats(i).mean1D; }],
            ['RMS', function (i) { return PET.isotopes.rangeStats(i).rms1D; }]
        ];
        rows.forEach(function (r) {
            body.appendChild(el('tr', {}, [el('th', { scope: 'row', text: r[0] })].concat(list.map(function (i) {
                let v = NaN; try { v = r[1](i); } catch (e) { v = NaN; }
                return el('td', { text: isFinite(v) ? U.fmtNum(v, 2) + ' mm' : '-' });
            }))));
        });
        T.cmp.appendChild(body);
    }

    function samplesFor(isoId) {
        const key = isoId + ':' + T.cloudSeed;
        if (T.samples[key]) return T.samples[key];
        const iso = PET.isotopes.get(isoId), rng = U.rng(7919 * T.cloudSeed + isoId.charCodeAt(0));
        const pts = new Float32Array(2 * CLOUD_N);
        for (let i = 0; i < CLOUD_N; i++) { const d = PET.isotopes.sampleRange(iso, rng); pts[2 * i] = d[0]; pts[2 * i + 1] = d[1]; }
        T.samples = {};
        return (T.samples[key] = pts);
    }
    function renderCloud() {
        if (!PET.isotopes || !PET.isotopes.sampleRange || !T.cloud) return;
        const prog = goodProgram();
        if (!T.cloudIso) { T.cloudIso = prog && prog.isotope ? prog.isotope : 'F18'; T.cloudSeg.set(T.cloudIso); }
        const avail = T.cloudStage.clientWidth;
        if (!avail) return;
        const size = Math.max(200, Math.min(avail, 440));
        const r = U.setupCanvas(T.cloud, size, size), ctx = r.ctx;
        const S = size / (2 * CLOUD_HALF), c0 = size / 2;
        const X = function (mm) { return c0 + mm * S; };
        const iso = PET.isotopes.get(T.cloudIso);
        const bg = U.cssVar('--scope-bg', '#05080f'), grid = U.cssVar('--scope-grid', '#1c2536');
        const fg = U.cssVar('--scope-muted', '#8794a8'), photon = U.cssVar('--sev-photon', '#f5d061'), pos = U.cssVar('--sev-positron', '#5ee0d2');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);
        // one crystal width
        ctx.fillStyle = photon; ctx.globalAlpha = 0.08;
        ctx.fillRect(X(-CRYSTAL / 2), 0, CRYSTAL * S, size);
        ctx.globalAlpha = 0.5; ctx.strokeStyle = photon; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(X(-CRYSTAL / 2)) + 0.5, 0); ctx.lineTo(Math.round(X(-CRYSTAL / 2)) + 0.5, size);
        ctx.moveTo(Math.round(X(CRYSTAL / 2)) + 0.5, 0); ctx.lineTo(Math.round(X(CRYSTAL / 2)) + 0.5, size); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        // pixel grid
        ctx.strokeStyle = grid; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let g = -CLOUD_HALF + PIXEL / 2; g <= CLOUD_HALF; g += PIXEL) {
            const p = Math.round(X(g)) + 0.5;
            ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.moveTo(0, p); ctx.lineTo(size, p);
        }
        ctx.stroke();
        // points
        const pts = samplesFor(iso.id);
        let inPix = 0, inCrystal = 0, beyond5 = 0, outside = 0;
        ctx.fillStyle = pos; ctx.globalAlpha = 0.55;
        const dot = Math.max(1.4, size / 260);
        for (let i = 0; i < CLOUD_N; i++) {
            const dx = pts[2 * i], dy = pts[2 * i + 1];
            if (Math.abs(dx) <= PIXEL / 2 && Math.abs(dy) <= PIXEL / 2) inPix++;
            if (Math.abs(dx) <= CRYSTAL / 2) inCrystal++;
            if (Math.hypot(dx, dy) > 5) beyond5++;
            if (Math.abs(dx) > CLOUD_HALF || Math.abs(dy) > CLOUD_HALF) { outside++; continue; }
            ctx.fillRect(X(dx) - dot / 2, X(dy) - dot / 2, dot, dot);
        }
        ctx.globalAlpha = 1;
        // the pixel holding the nucleus, and the nucleus
        ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.25;
        ctx.strokeRect(X(-PIXEL / 2), X(-PIXEL / 2), PIXEL * S, PIXEL * S);
        ctx.globalAlpha = 1;
        ctx.fillStyle = photon; ctx.beginPath(); ctx.arc(c0, c0, Math.max(2.5, size / 110), 0, 2 * Math.PI); ctx.fill();
        // labels
        ctx.font = '600 11px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.fillStyle = photon;
        ctx.fillText('4 mm crystal', c0, 6);
        ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('−10 mm', 4, size - 4);
        ctx.textAlign = 'right'; ctx.fillText('+10 mm', size - 4, size - 4);
        ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = color(ISO_COLOR[iso.id]) || fg;
        ctx.font = '700 13px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.fillText(iso.label, 6, 6);
        T.cloud.setAttribute('aria-label', CLOUD_N + ' annihilation points of ' + iso.name + ' around a decay at the centre; ' +
            pct(inPix / CLOUD_N) + ' stay in the same 2.5 mm pixel.');
        T.cloudCap.textContent = 'Field ±10 mm, grid 2.5 mm (an image pixel)' + (outside ? '; ' + outside + ' points fall outside it' : '');
        T.cloudStats.textContent = '';
        tile(T.cloudStats, 'Same 2.5 mm pixel', pct(inPix / CLOUD_N), 'Annihilations inside the pixel that holds the decay');
        tile(T.cloudStats, 'Within the crystal', pct(inCrystal / CLOUD_N), 'Annihilations within 2 mm sideways, the width of one crystal');
        tile(T.cloudStats, 'Over 5 mm away', pct(beyond5 / CLOUD_N), 'Annihilations more than 5 mm from the decay, in the plane');
    }
    function tile(host, label, value, hint) {
        host.appendChild(el('div', { class: 'stat', title: hint || null }, [el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value', text: value })]));
    }

    /* ---------- tracer table ---------- */
    function renderTable() {
        const list = tracers(), prog = goodProgram(), cur = prog ? prog.tracer : null;
        const byTracer = presetTracers();
        T.tbody.textContent = '';
        list.forEach(function (t) {
            let iso = null; try { iso = PET.isotopes.get(t.isotope); } catch (e) { iso = null; }
            const open = T.open === t.id, mine = cur === t.id;
            const detailId = 'tr-detail-' + t.id.replace(/[^A-Za-z0-9]/g, '');
            const btn = el('button', { type: 'button', class: 'tr-name-btn', 'aria-expanded': open ? 'true' : 'false', 'aria-controls': detailId },
                [el('span', { class: 'tr-tname', text: t.label })]);
            const first = el('td', { 'data-label': null }, [btn, el('span', { class: 'tr-tsub', text: t.name })]);
            if (mine) first.appendChild(W().badge('your protocol', 'accent'));
            const mw = MODEL_WORDS[t.model] || { short: t.model, long: '' };
            const row = el('tr', { class: 'tr-row' + (mine ? ' is-current' : '') }, [
                first,
                el('td', { 'data-label': 'Follows', text: t.target.split(/\s*[(;]/)[0] }),
                el('td', { 'data-label': 'Isotope', text: iso ? iso.label : t.isotope }),
                el('td', { 'data-label': 'Model', text: mw.short, title: mw.long }),
                el('td', { 'data-label': 'Reference', text: t.reference ? regionName(t.reference) : 'none (blood input)' }),
                el('td', { 'data-label': 'Typical dose', class: 'num', text: U.fmtActivity(t.typicalDose, 3) }),
                el('td', { 'data-label': 'Uptake', class: 'num', text: t.typicalUptake > 0 ? U.fmtTime(t.typicalUptake, 3) : 'from injection' }),
                el('td', { 'data-label': 'Duration', class: 'num', text: U.fmtTime(t.typicalDuration, 3) })
            ]);
            row.addEventListener('click', function (e) {
                if (e.target.closest && e.target.closest('.tr-detail')) return;
                T.open = T.open === t.id ? null : t.id;
                renderTable();
                const b = T.tbody.querySelector('#' + detailId);
                if (b && T.open) { const nb = T.tbody.querySelector('[aria-controls="' + detailId + '"]'); if (nb) nb.focus({ preventScroll: true }); }
            });
            T.tbody.appendChild(row);
            if (open) {
                const ps = byTracer[t.id] || [];
                const actions = el('div', { class: 'row' }, [el('span', { text: ps.length ? 'Load a protocol with ' + t.label + ':' : 'No preset uses this tracer yet: write one in the Protocol tab.' })]);
                ps.forEach(function (p) {
                    actions.appendChild(W().button({ label: p.name, size: 'sm', kind: p.id === st().presetId ? 'primary' : null,
                        title: p.summary, onClick: function () { if (PET.actions) PET.actions.loadPreset(p.id); } }));
                });
                const td = el('td', { colspan: '8' }, [
                    el('p', { html: '<strong>Target.</strong> ' + esc(t.target) + '.' }),
                    el('p', { html: '<strong>Model.</strong> ' + esc(mw.long) + ' <strong>Usually reported as</strong> ' + esc(t.outcome) + '.' }),
                    actions
                ]);
                T.tbody.appendChild(el('tr', { class: 'tr-detail', id: detailId }, [td]));
            }
        });
    }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    /* '14N(p,a)11C' -> mass numbers as superscripts, the way nuclides are written. */
    function nuclides(text) { return esc(text).replace(/\b(\d{1,3})([A-Z][a-z]?)\b/g, '<sup>$1</sup>$2'); }

    /* ---------- the current tracer ---------- */
    function showPlot(plot, emptyEl, msg) {
        plot.el.hidden = !!msg;
        emptyEl.hidden = !msg;
        if (msg) emptyEl.textContent = msg;
    }
    function renderCurrent() {
        const prog = goodProgram(), s = st();
        T.curMsg.textContent = '';
        T.cpNote.textContent = ''; T.tacNote.textContent = '';
        if (!prog) {
            T.curTitle.textContent = 'Your protocol\'s tracer';
            T.curSub.textContent = '';
            showPlot(T.cpPlot, T.cpEmpty, 'Write a protocol that compiles to see its tracer here.');
            showPlot(T.tacPlot, T.tacEmpty, 'No protocol yet.');
            return;
        }
        const tr = tracerById(prog.tracer);
        let iso = null; try { iso = PET.isotopes.get(prog.isotope); } catch (e) { iso = null; }
        let phantom = null; try { phantom = PET.actions.getPhantom(); } catch (e) { phantom = null; }
        T.curTitle.textContent = tr ? 'Your protocol\'s tracer: ' + tr.label : 'Your protocol: no tracer, a ' + (iso ? iso.label : '') + ' solution';
        T.curSub.textContent = phantom ? 'in the ' + phantom.name + ' phantom' : '';
        if (s.program && !s.program.ok) T.curMsg.appendChild(W().callout('The protocol has errors; these curves are for the last version that compiled.', 'warn'));

        const lam = iso ? Math.LN2 / iso.halfLife : 0;
        const tEndS = Math.max(60, prog.scanEnd || 0);
        const suvScale = prog.dose / (Math.max(1e-9, prog.weight) * 1000);       // Bq/mL per SUV
        // SUV divides by dose per body weight: meaningless for a phantom.
        const bodyLess = !!(phantom && phantom.kind !== 'brain');
        T.unitSeg.setDisabled(bodyLess);
        T.unitSeg.title = bodyLess ? 'SUV needs a body weight; a phantom is shown in kBq/mL' : '';
        const suv = T.units === 'suv' && !bodyLess;
        const conv = function (bqml, tS) { const v = suv ? bqml / suvScale : bqml / 1000; return T.physical ? v * Math.exp(-lam * tS) : v; };
        const unit = suv ? 'SUV' : 'kBq/mL';
        const yfmt = function (v) { return U.fmtNum(v, 3) + ' ' + unit; };
        const xlim = [0, tEndS / 60];

        // plasma input
        let inp = null;
        if (tr && PET.kinetics && typeof PET.kinetics.input === 'function') { try { inp = PET.kinetics.input(tr.id); } catch (e) { inp = null; } }
        if (!tr) showPlot(T.cpPlot, T.cpEmpty, 'No tracer, so no blood curve: a phantom filled with a solution has no circulation.');
        else if (!inp) showPlot(T.cpPlot, T.cpEmpty, PET.kinetics ? 'No input function is defined for ' + tr.label + '.' : 'The kinetics module (js/kinetics.js) did not load.');
        else {
            showPlot(T.cpPlot, T.cpEmpty, null);
            const N = Math.min(2400, Math.max(400, Math.round(tEndS / 1.5)));
            const x = new Float64Array(N), y = new Float64Array(N);
            let top = 0;
            for (let i = 0; i < N; i++) { const t = tEndS * i / (N - 1); x[i] = t / 60; y[i] = conv(inp.cp(t) * suvScale, t); if (y[i] > top) top = y[i]; }
            const opts = { xlim: xlim, legend: false, markers: [{ x: inp.peakTime / 60, label: 'peak ' + U.fmtTime(inp.peakTime, 2) }] };
            if (T.cpLog && top > 0) {
                // log axis: three and a half decades below the peak
                const hi = Math.log10(top), lo = hi - 3.5;
                for (let i = 0; i < N; i++) y[i] = y[i] > 0 ? Math.max(lo - 1, Math.log10(y[i])) : NaN;
                opts.ylim = [lo, hi + 0.15];
                opts.yfmt = function (v) { return log10fmt(v) + ' ' + unit; };
            } else { opts.includeZero = true; opts.yfmt = yfmt; }
            T.cpPlot.draw([{ x: x, y: y, label: 'Plasma, ' + tr.label, color: 'var(--ev-random)', width: 2, fill: T.cpLog ? 0 : 0.08 }], opts);
            T.cpBands.set({ bands: frameBands(prog, 0.12) });
            T.cpNote.textContent = (inp.description ? inp.description + '. ' : '') + 'Peak about ' + U.fmtNum(inp.peak, 3) + ' SUV, ' +
                U.fmtTime(inp.peakTime, 2) + ' after the injection; at the end of the scan ' + U.fmtNum(inp.cp(tEndS), 2) + ' SUV (decay corrected).';
        }

        // regional TACs
        let tacs = null, err = null;
        if (!PET.kinetics) err = 'The kinetics module (js/kinetics.js) did not load, so there are no tissue curves.';
        else if (!phantom) err = 'The phantom could not be built, so there are no tissue curves.';
        else { try { tacs = PET.actions.getTACs(); } catch (e) { err = e && e.message ? e.message : String(e); } }
        if (!tacs) {
            T.tacTitle.textContent = 'Regional time-activity curves';
            const noTracer = !!(err && phantom && phantom.kind === 'brain' && !tr);
            showPlot(T.tacPlot, T.tacEmpty, noTracer ? 'No tissue curves without a tracer.' : (err || 'No curves for this protocol.'));
            if (noTracer) {
                T.curMsg.appendChild(W().callout('The brain phantom needs a tracer: tissue curves come from a compartment model of a tracer (add a line such as <code>tracer FDG</code>). ' +
                    '<code>tracer none</code> is for the phantoms, which are filled with a solution of the isotope.', 'warn'));
            }
            return;
        }
        const solution = phantom.kind !== 'brain';
        let idx = [];
        const group = {};               // regions that share one curve (the four hot spheres) are drawn once
        if (solution) {
            phantom.regions.forEach(function (r, i) {
                if (!(r.rel > 0) || !tacs.regions[i]) return;
                const k = String(r.rel);
                if (group[k]) { group[k].push(i); return; }
                group[k] = [i];
                idx.push(i);
            });
            idx = idx.slice(0, 8);
        } else {
            KEY_REGIONS.forEach(function (id) { const i = phantom.regions.findIndex(function (r) { return r.id === id; }); if (i >= 0 && tacs.regions[i]) idx.push(i); });
        }
        if (!idx.length) { showPlot(T.tacPlot, T.tacEmpty, 'No region of this phantom holds any activity.'); return; }
        showPlot(T.tacPlot, T.tacEmpty, null);
        T.tacTitle.textContent = solution ? 'Concentration in the phantom' : 'Regional time-activity curves';
        const n = tacs.t.length, step = Math.max(1, Math.floor(n / 1500));
        const xs = [];
        for (let i = 0; i < n; i += step) xs.push(tacs.t[i] / 60);
        const xArr = Float64Array.from(xs);
        let ymax = 0;
        const peakCut = Math.max(120, 4 * (inp ? inp.peakTime : 30));
        const series = idx.map(function (ri) {
            const reg = phantom.regions[ri], src = tacs.regions[ri], y = new Float64Array(xArr.length);
            const blood = reg.tissue === 'blood';
            for (let k = 0, i = 0; i < n; i += step, k++) {
                const v = conv(src[i], tacs.t[i]);
                y[k] = v;
                if (!blood || tacs.t[i] > peakCut) ymax = Math.max(ymax, v);
            }
            const same = solution ? (group[String(reg.rel)] || [ri]) : [ri];
            const name = same.length > 1 ? reg.name + ' and ' + (same.length - 1) + ' more like it' : reg.name;
            return { x: xArr, y: y, label: name + (blood ? ', first pass off scale' : ''), color: reg.color, width: 1.9 };
        });
        if (!(ymax > 0)) ymax = 1;
        T.tacPlot.draw(series, { xlim: xlim, ylim: [0, ymax * 1.1], legend: true, yfmt: yfmt });
        T.tacBands.set({ bands: frameBands(prog, 0.12) });
        if (solution) {
            T.tacNote.textContent = 'The ' + phantom.name + ' phantom is filled with a solution of ' + (iso ? iso.label : 'the isotope') +
                ': it mixes at once and stays where it is, so the decay-corrected concentration is constant. Switch to physical and the only change is decay' +
                (iso ? ', halving every ' + halfLifeText(iso) : '') + '.';
            if (tr) T.curMsg.appendChild(W().callout('This phantom holds a solution, so ' + tr.label + '\'s biology does not apply here: its blood curve on the left is what a patient would show.', 'info'));
        } else {
            const ref = tr && tr.reference ? regionName(tr.reference) : null;
            T.tacNote.textContent = (tr ? (MODEL_WORDS[tr.model] ? MODEL_WORDS[tr.model].long + ' ' : '') : '') +
                (ref ? 'The usual reference region is ' + ref.toLowerCase() + '. ' : '') +
                (T.physical ? 'Physical: the activity actually present, falling with decay; this is what each frame counts.' :
                    'Decay corrected: the concentration as if the isotope did not decay, which is what a corrected image reports.');
        }
    }

    PET.ui.registerTab({
        id: 'tracer', title: 'Isotopes & tracers', order: 20,
        mount: mount,
        onShow: function () { T.visible = true; renderAll(); },
        onHide: function () { T.visible = false; }
    });

})(typeof window !== 'undefined' ? window : globalThis);
