/* ============================================================
   MRI Simulator, Phantom tab (ARCHITECTURE.md section 12.5)

   The object being imaged, shown the way the scanner "sees" it: not
   as anatomy, but as a few physical numbers at every point (proton
   density, T1, T2, T2*, and the frequency at which the protons
   resonate). The tab offers

     - a picker of the six phantoms (cards with a thumbnail of their
       tissue labels), calling MRI.actions.setPhantom;
     - the phantom options: lesions (brain only) and a gadolinium
       concentration in enhancing tissue (setPhantomOpts);
     - a map viewer: tissue labels with a legend, PD, T1, T2, T2*, the
       off-resonance in Hz with the current B0 settings (optionally
       with chemical shift, so fat sits near -434 Hz), the B1 transmit
       scale, each receive coil's sensitivity and their RSS, with a
       hover probe that names the tissue and its values, and an
       optional landmark overlay;
     - a tissue table whose PD, T1, T2 and T2* can be edited (written
       to phantomOpts.overrides, validated, with per-row and global
       reset).

   Everything is computed from MRI.actions.getPhantom() (the raster the
   scans use) and MRI.actions.getFields(), so what the maps show is
   exactly what the engine images. While hidden the tab only notes that
   it is out of date and catches up in onShow.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function w() { return MRI.ui.w; }
    function state() { return MRI.state; }
    const TERMS = MRI.ui.terms || {};
    const TRY_IT = TERMS.tryIt || 'Try it', SHOW_ME = TERMS.showMe || 'Show me';
    function combineName(id) { return (TERMS.combine && TERMS.combine[id]) || ({ sos: 'Root-sum-of-squares', roemer: 'Roemer' })[id] || id; }
    /* Blood is stationary tissue in this model (said wherever vessels appear). */
    const BLOOD_NOTE = 'Blood is treated as stationary tissue here: there is no flow void on spin echo and no inflow enhancement on ' +
        'gradient echo. Only its pulsation is modelled (Artifacts tab, Pulsatile flow).';
    function hexToRgb(hex) {
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
        return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [160, 160, 160];
    }
    // Numbers for students: a true minus sign, no binary noise.
    function fnum(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3).replace('-', '−') : '-'; }
    function fms(sec, sig) { return isFinite(sec) ? U.fmtNum(sec * 1000, sig || 4) : '-'; }
    function fsigned(v, sig) {
        if (!isFinite(v)) return '-';
        const s = U.fmtNum(v, sig || 3);
        return (v > 0 ? '+' : '') + s.replace('-', '−');
    }
    function fmm(m) { return (m * 1000).toFixed(1).replace('-', '−'); }

    const PPM_HZ = (MRI.const && MRI.const.PPM_HZ) || 127.73;

    MRI.ui.addStyle(`
#tab-phantom .pt-cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
#tab-phantom .pt-card {
    display: flex; align-items: center; gap: 12px; min-width: 0; width: 100%; margin: 0;
    padding: 8px 12px 8px 8px; text-align: left; cursor: pointer;
    font: inherit; color: var(--fg); background: var(--card);
    border: 1px solid var(--border); border-radius: var(--radius);
    transition: border-color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
}
#tab-phantom .pt-card:hover { border-color: var(--axis); background: var(--card-2); }
#tab-phantom .pt-card[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
#tab-phantom .pt-card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-phantom .pt-thumb { width: 64px; height: 64px; flex: none; border-radius: 7px; background: var(--scope-bg); display: block; }
#tab-phantom .pt-card-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
#tab-phantom .pt-card-name { font-weight: 650; font-size: 0.9rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
#tab-phantom .pt-card-desc {
    font-size: 0.78rem; line-height: 1.35; color: var(--muted);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
#tab-phantom .pt-card .badge { height: 18px; font-size: 0.66rem; }
#tab-phantom .pt-card:not([aria-pressed="true"]) .pt-inuse { display: none; }
#tab-phantom .pt-notes { margin: 12px 0 0; }
#tab-phantom .pt-map-tools { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; margin: 0 0 10px; }
#tab-phantom .pt-map-tools .ctl-select { min-width: 210px; }
#tab-phantom .pt-map-tools .pt-coilsel { min-width: 150px; }
#tab-phantom .pt-map-tools .toggle { min-height: var(--ctl-h); }
#tab-phantom .pt-view.is-labels .iv-cbar { display: none; }
#tab-phantom .pt-view .iv-stage { max-width: 640px; margin: 0 auto; }
#tab-phantom .pt-caption { font-size: 0.84rem; color: var(--muted); line-height: 1.5; margin: 10px 0 0; }
#tab-phantom .pt-caption strong { color: var(--fg); }
#tab-phantom .pt-legend { margin: 10px 0 0; }
#tab-phantom .pt-legend .legend-item { color: var(--fg); }
#tab-phantom .pt-probe {
    margin: 10px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--card-2);
    border: 1px solid var(--border-subtle); font-size: 0.82rem; min-height: 64px;
}
#tab-phantom .pt-probe-head { display: flex; align-items: center; gap: 8px; font-weight: 650; margin-bottom: 6px; flex-wrap: wrap; }
#tab-phantom .pt-probe-head .swatch { width: 12px; height: 12px; border: 1px solid var(--border-strong); }
#tab-phantom .pt-probe-pos { font: 0.74rem var(--font-mono); color: var(--muted); font-weight: 400; margin-left: auto; }
#tab-phantom .pt-probe-lm { color: var(--accent); font-weight: 600; }
#tab-phantom .pt-probe-grid { display: grid; gap: 4px 14px; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); }
#tab-phantom .pt-probe-grid > div { display: flex; justify-content: space-between; gap: 6px; min-width: 0; }
#tab-phantom .pt-probe-grid .k { color: var(--muted); }
#tab-phantom .pt-probe-grid .v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
#tab-phantom .pt-probe-empty { color: var(--muted); }
#tab-phantom .pt-lm-list { margin: 10px 0 0; padding-left: 26px; columns: 2 220px; column-gap: 24px; font-size: 0.8rem; color: var(--muted); }
#tab-phantom .pt-lm-list li { break-inside: avoid; margin: 0 0 2px; }
#tab-phantom .pt-lm-list li::marker { color: var(--fg); font-weight: 650; font-variant-numeric: tabular-nums; }
#tab-phantom .pt-side { display: flex; flex-direction: column; gap: 0; min-width: 0; }
#tab-phantom .pt-opt { display: flex; flex-direction: column; gap: 8px; }
#tab-phantom .pt-opt + .pt-opt { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
#tab-phantom .pt-opt .note { margin: 0; }
#tab-phantom .pt-gd-effect { margin: 2px 0 0; }
#tab-phantom .pt-gd-effect td { white-space: nowrap; }
#tab-phantom .pt-table-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 10px; }
#tab-phantom .pt-table-tools .note { margin: 0; flex: 1 1 280px; }
#tab-phantom .pt-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
#tab-phantom .pt-table th { text-align: left; font-weight: 600; font-size: 0.76rem; color: var(--muted); padding: 4px 8px 6px; white-space: nowrap; border-bottom: 1px solid var(--border); }
#tab-phantom .pt-table th.num, #tab-phantom .pt-table td.num { text-align: right; }
#tab-phantom .pt-table td { padding: 6px 8px; vertical-align: top; border-top: 1px solid var(--border-subtle); }
#tab-phantom .pt-table tbody tr:first-child td { border-top: 0; }
#tab-phantom .pt-table tr.is-edited td.pt-name { box-shadow: inset 3px 0 0 var(--accent); }
#tab-phantom .pt-name-wrap { display: flex; align-items: center; gap: 8px; min-height: 28px; flex-wrap: wrap; }
#tab-phantom .pt-name-wrap .swatch { width: 12px; height: 12px; border: 1px solid var(--border-strong); }
#tab-phantom .pt-name-wrap .badge { height: 18px; font-size: 0.66rem; }
#tab-phantom .pt-in {
    width: 8ch; height: 28px; padding: 0 6px; text-align: right;
    font: 0.82rem var(--font-mono); font-variant-numeric: tabular-nums;
}
#tab-phantom .pt-in.is-edited { border-color: var(--accent); background: var(--accent-soft); }
#tab-phantom .pt-in[aria-invalid="true"] { border-color: var(--bad); box-shadow: 0 0 0 2px var(--bad-soft); }
#tab-phantom .pt-sub { display: block; font-size: 0.7rem; line-height: 1.3; color: var(--muted); margin-top: 2px; white-space: nowrap; }
#tab-phantom .pt-sub.gd { color: var(--accent); }
#tab-phantom .pt-cs { font-family: var(--font-mono); padding-top: 11px; }
#tab-phantom .pt-msg { min-height: 1.4em; margin: 8px 0 0; font-size: 0.84rem; }
#tab-phantom .pt-msg.bad { color: var(--bad); font-weight: 600; }
#tab-phantom .pt-msg.good { color: var(--good); }
@media (max-width: 640px) {
    #tab-phantom .pt-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    #tab-phantom .pt-card { flex-direction: column; align-items: stretch; gap: 5px; padding: 6px; }
    #tab-phantom .pt-card-name { font-size: 0.78rem; gap: 4px; }
    #tab-phantom .pt-card .badge { display: none; }
    #tab-phantom .pt-thumb { width: 100%; height: auto; aspect-ratio: 1 / 1; }
    #tab-phantom .pt-card-desc { display: none; }
    #tab-phantom .pt-map-tools .ctl-select { min-width: 0; flex: 1 1 100%; }
    #tab-phantom .pt-table thead { display: none; }
    #tab-phantom .pt-table, #tab-phantom .pt-table tbody { display: block; }
    #tab-phantom .pt-table tr { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px 8px; padding: 10px 0; border-top: 1px solid var(--border-subtle); }
    #tab-phantom .pt-table tbody tr:first-child { border-top: 0; }
    #tab-phantom .pt-table td { display: block; padding: 0; border: 0; min-width: 0; }
    #tab-phantom .pt-table td.pt-name { grid-column: span 2; order: 0; align-self: center; }
    #tab-phantom .pt-table td.pt-cs { order: 1; }
    #tab-phantom .pt-table td.pt-act { order: 2; }
    #tab-phantom .pt-table td.num:not(.pt-cs) { order: 3; }
    #tab-phantom .pt-table tr.is-edited td.pt-name { box-shadow: none; }
    #tab-phantom .pt-table td[data-label]::before { content: attr(data-label); display: block; font: 0.7rem var(--font-sans); color: var(--muted); margin-bottom: 2px; text-align: left; }
    #tab-phantom .pt-table td.num { text-align: left; }
    #tab-phantom .pt-table td.pt-cs { padding-top: 0; font-size: 0.8rem; }
    #tab-phantom .pt-table td.pt-act { display: flex; align-items: center; justify-content: flex-end; }
    #tab-phantom .pt-in { width: 100%; text-align: left; }
}
`);

    /* ---------- maps ---------- */
    const MAPS = [
        { value: 'labels', label: 'Tissue labels' },
        { value: 'pd', label: 'Proton density (PD)' },
        { value: 't1', label: 'T1 (ms)' },
        { value: 't2', label: 'T2 (ms)' },
        { value: 't2s', label: 'T2* (ms)' },
        { value: 'df', label: 'Off-resonance (Hz)' },
        { value: 'b1', label: 'B1 transmit (× nominal)' },
        { value: 'coil', label: 'Receive coil sensitivity' },
        { value: 'rss', label: 'Receive coils, root-sum-of-squares' }
    ];
    const RELAX_NAME = { t1: 'T1', t2: 'T2', t2s: 'T2*' };

    // Stable identity numbers for objects used in cache keys.
    const ids = new WeakMap();
    let idCounter = 0;
    function idOf(o) { if (!o) return 0; let k = ids.get(o); if (!k) { k = ++idCounter; ids.set(o, k); } return k; }

    /* A label image in tissue colours, n x n, air transparent. Cached by
       the label array (shared between phantoms of the same geometry) and
       the colours. */
    const labelCanvasCache = new Map();
    function labelCanvas(ph) {
        const colors = ph.tissues.map(function (t) { return t.color; }).join(',');
        const key = idOf(ph.label) + '|' + colors;
        let c = labelCanvasCache.get(key);
        if (c) return c;
        const n = ph.n;
        c = doc.createElement('canvas');
        c.width = n; c.height = n;
        const ctx = c.getContext('2d'), img = ctx.createImageData(n, n), px = img.data;
        const rgb = ph.tissues.map(function (t, i) { return i === 0 ? null : hexToRgb(t.color); });
        const label = ph.label;
        for (let i = 0, N = n * n; i < N; i++) {
            const c3 = rgb[label[i]];
            if (!c3) continue;
            const j = 4 * i;
            px[j] = c3[0]; px[j + 1] = c3[1]; px[j + 2] = c3[2]; px[j + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        labelCanvasCache.set(key, c);
        while (labelCanvasCache.size > 10) labelCanvasCache.delete(labelCanvasCache.keys().next().value);
        return c;
    }

    /* The outline of the object (non-air pixels next to air), for the coil
       maps, which cover the whole field of view including the air. */
    const outlineCache = new Map();
    function outlineCanvas(ph) {
        const key = idOf(ph.label);
        let c = outlineCache.get(key);
        if (c) return c;
        const n = ph.n, L = ph.label;
        c = doc.createElement('canvas');
        c.width = n; c.height = n;
        const ctx = c.getContext('2d'), img = ctx.createImageData(n, n), px = img.data;
        for (let iy = 1; iy < n - 1; iy++) {
            for (let ix = 1; ix < n - 1; ix++) {
                const i = iy * n + ix;
                if (!L[i]) continue;
                if (L[i - 1] && L[i + 1] && L[i - n] && L[i + n]) continue;
                const j = 4 * i;
                px[j] = 255; px[j + 1] = 255; px[j + 2] = 255; px[j + 3] = 200;
            }
        }
        ctx.putImageData(img, 0, 0);
        outlineCache.set(key, c);
        while (outlineCache.size > 6) outlineCache.delete(outlineCache.keys().next().value);
        return c;
    }

    let rssCache = { maps: null, data: null };
    function rssOf(maps) {
        if (!maps || !maps.re || !maps.re.length) return null;
        if (rssCache.maps === maps) return rssCache.data;
        let data;
        if (MRI.fields && typeof MRI.fields.rss === 'function') data = MRI.fields.rss(maps);
        else {
            const N = maps.re[0].length; data = new Float32Array(N);
            for (let i = 0; i < N; i++) {
                let s = 0;
                for (let k = 0; k < maps.re.length; k++) s += maps.re[k][i] * maps.re[k][i] + maps.im[k][i] * maps.im[k][i];
                data[i] = Math.sqrt(s);
            }
        }
        rssCache = { maps: maps, data: data };
        return data;
    }

    /* Default display window for a relaxation map. CSF's T2 (1800 ms) is
       twenty times that of brain tissue; on a linear scale it would leave
       grey and white matter the same colour. When the longest value is an
       outlier (more than 3x the next), the window stops at twice the next
       value and the outlier saturates (hover still reads it exactly). */
    function relaxWindow(ph, key) {
        const vals = [];
        ph.tissues.forEach(function (t, i) { if (i > 0 && isFinite(t[key])) vals.push(t[key] * 1000); });
        vals.sort(function (a, b) { return b - a; });
        if (!vals.length) return { min: 0, max: 1, clipped: null };
        let hi = vals[0], clipped = null;
        if (vals.length > 1 && vals[0] > 3 * vals[1] && vals[1] > 0) {
            hi = 2 * vals[1];
            const t = ph.tissues.find(function (x, i) { return i > 0 && Math.abs(x[key] * 1000 - vals[0]) < 1e-9; });
            clipped = { name: t ? t.name : 'the longest', value: vals[0] };
        }
        return { min: 0, max: niceCeil(hi), clipped: clipped };
    }
    function niceCeil(v) {
        if (!(v > 0)) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const f = v / mag;
        const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 4.5, 5, 6, 8, 10];
        let s = 10;
        for (let i = 0; i < steps.length; i++) if (f <= steps[i] + 1e-9) { s = steps[i]; break; }
        return s * mag;
    }

    /* ---------- the tab ---------- */
    const T = {
        mounted: false, visible: false,
        dirty: { map: true, thumbs: true, all: true },
        mapId: 'labels', coil: 0, withCS: false, landmarks: false,
        ph: null, fields: null,
        lastKey: null, lastMapId: null, lastPhId: null,
        thumbsDone: {}, thumbBusy: false,
        tableKey: null, rows: {},
        hover: null
    };
    const ui = {};

    function currentPhantom() {
        try { return MRI.actions.getPhantom(); }
        catch (e) { if (root.console) root.console.error('[phantom tab] getPhantom failed:', e); return null; }
    }
    function currentFields(ph) {
        if (!ph) return null;
        try { return MRI.actions.getFields(ph); }
        catch (e) { if (root.console) root.console.error('[phantom tab] getFields failed:', e); return null; }
    }
    function phantomList() {
        try { return MRI.phantoms.list(); } catch (e) { return []; }
    }

    /* ----- concept card ----- */
    function ensureBrain() {
        if (state().phantomId !== 'brain') MRI.actions.setPhantom('brain');
    }
    function scrollToMap() {
        if (ui.mapPanel && ui.mapPanel.scrollIntoView) {
            try { ui.mapPanel.scrollIntoView({ block: 'start', behavior: U.scrollBehavior ? U.scrollBehavior() : 'auto' }); } catch (e) { ui.mapPanel.scrollIntoView(); }
        }
    }
    function showMap(id, opts) {
        opts = opts || {};
        T.mapId = id;
        if (ui.mapSel) ui.mapSel.set(id);
        if (opts.landmarks !== undefined) { T.landmarks = !!opts.landmarks; if (ui.lmToggle) ui.lmToggle.set(T.landmarks); }
        syncMapTools();
        refreshMap();
        if (opts.scroll) scrollToMap();
    }
    function buildConcept() {
        const lib = (MRI.tissues && MRI.tissues.library) || {};
        const v = function (id, k) { return lib[id] ? fms(lib[id][k]) : '?'; };
        return w().concept({
            title: 'The scanner sees numbers, not anatomy',
            body: '<p>The scanner never sees anatomy. At each point it meets only a handful of physical properties: ' +
                'how many mobile protons there are (<strong>proton density</strong>), how fast their magnetisation recovers ' +
                '(<strong>T1</strong>) and decays (<strong>T2</strong>, and <strong>T2*</strong> in a gradient echo), and the ' +
                'exact <strong>frequency</strong> at which they resonate. An image is a map of these numbers, weighted by the sequence.</p>' +
                '<p class="note">Typical 3 T values used here: T1 of white matter ' + v('wm', 't1') + ' ms, cortex ' + v('gm', 't1') +
                ' ms, deep grey matter ' + v('deepgm', 't1') + ' ms, CSF ' + v('csf', 't1') + ' ms; T2 ' + v('wm', 't2') + ', ' +
                v('gm', 't2') + ' and ' + v('csf', 't2') + ' ms. Fat has a short T1 (' + v('fat', 't1') +
                ' ms) and resonates 3.4 ppm (about 434 Hz) below water.</p>',
            formula: 'S(<b>r</b>) &prop; PD(<b>r</b>) &middot; f<sub>sequence</sub>(T1, T2, T2*) &nbsp; at &nbsp; f<sub>0</sub> + &Delta;f(<b>r</b>)',
            tryThis: [
                { html: 'Show the <strong>T1 map</strong> and hover over white matter and cortex. White matter recovers faster (shorter T1), ' +
                    'which is why it is brighter on a T1-weighted image.', label: TRY_IT,
                    run: function () { showMap('t1', { scroll: true }); } },
                { html: 'Turn on the <strong>lesion</strong> and some <strong>gadolinium</strong>, then run the T1-weighted gradient echo ' +
                    '(<code>gre_t1</code>): the enhancing lesion lights up.', label: SHOW_ME,
                    run: function () {
                        const s = state();
                        MRI.actions.setPhantom('brain', { lesion: true, gad: 0.3, overrides: s.phantomOpts.overrides || {} });
                        MRI.actions.loadPreset('gre_t1');
                        if (!s.autoRescan) MRI.actions.runScan({ animate: false });
                        MRI.actions.showTab('image', { focus: true });
                    } },
                { html: 'Look at the <strong>field map</strong> near the frontal sinus: air in the sinus raises the field in the ' +
                    'orbitofrontal cortex behind it by up to about +120 Hz at 3 T.', label: TRY_IT,
                    run: function () { ensureBrain(); T.withCS = false; if (ui.csToggle) ui.csToggle.set(false); showMap('df', { landmarks: true, scroll: true }); } },
                { html: 'In the tissue table give white matter the T1 of cortex (' + v('gm', 't1') + ' ms) and compare them in the ' +
                    'Contrast tab on a T1-weighted sequence. Reset the row afterwards (Edit tissue values, below).', label: SHOW_ME,
                    run: function () {
                        ensureBrain();
                        const ov = Object.assign({}, state().phantomOpts.overrides || {});
                        ov.wm = Object.assign({}, ov.wm || {}, { t1: lib.gm ? lib.gm.t1 : 1.35 });
                        MRI.actions.setPhantomOpts({ overrides: ov });
                        // the edited row is waiting in the tissue table when the student comes back
                        if (ui.tableDet) ui.tableDet.open = true;
                        MRI.actions.showTab('contrast', { focus: true });
                    } }
            ]
        });
    }

    /* ----- picker ----- */
    function buildPicker() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'pt-pick-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pt-pick-title', text: 'Choose a phantom' }),
            el('span', { class: 'panel-sub', text: 'The object in the scanner. Picking one re-scans with the current sequence.' })
        ]));
        const grid = el('div', { class: 'pt-cards', role: 'group', 'aria-label': 'Phantoms' });
        ui.cards = {};
        phantomList().forEach(function (p) {
            const canvas = el('canvas', { class: 'pt-thumb', 'aria-hidden': 'true' });
            const btn = el('button', { type: 'button', class: 'pt-card', 'aria-pressed': 'false', 'data-id': p.id }, [
                canvas,
                el('span', { class: 'pt-card-text' }, [
                    el('span', { class: 'pt-card-name' }, [p.name, el('span', { class: 'badge badge-accent pt-inuse', text: 'in use' })]),
                    el('span', { class: 'pt-card-desc', text: p.description })
                ])
            ]);
            btn.addEventListener('click', function () {
                if (state().phantomId !== p.id) MRI.actions.setPhantom(p.id);
            });
            ui.cards[p.id] = { btn: btn, canvas: canvas };
            grid.appendChild(btn);
        });
        panel.appendChild(grid);
        ui.notes = el('p', { class: 'note pt-notes' });
        panel.appendChild(ui.notes);
        return panel;
    }
    function syncPicker() {
        const id = state().phantomId;
        Object.keys(ui.cards || {}).forEach(function (k) {
            ui.cards[k].btn.setAttribute('aria-pressed', k === id ? 'true' : 'false');
        });
        const ph = T.ph;
        ui.notes.textContent = ph && ph.notes ? ph.notes : '';
    }
    /* Thumbnails: each phantom's labels at n = 256 with default options,
       built one per frame on the first visit (the brain is usually cached
       already; the others take a few milliseconds each). */
    async function buildThumbs() {
        if (T.thumbBusy) return;
        T.thumbBusy = true;
        try {
            const list = phantomList();
            for (let i = 0; i < list.length; i++) {
                const id = list[i].id, card = ui.cards[id];
                if (!card || T.thumbsDone[id]) continue;
                if (!T.visible) break;
                let ph = null;
                try { ph = MRI.phantoms.build(id, { n: 256 }); } catch (e) { ph = null; }
                if (ph) drawThumb(card.canvas, ph);
                T.thumbsDone[id] = !!ph;
                await new Promise(function (res) { raf(function () { setTimeout(res, 0); }); });
            }
        } finally { T.thumbBusy = false; }
    }
    function drawThumb(canvas, ph) {
        const cw = canvas.clientWidth || 64, ch = canvas.clientHeight || cw;
        if (!cw) return;
        const r = U.setupCanvas(canvas, null, null);
        const ctx = r.ctx;
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = U.cssVar('--scope-bg', '#0b0f17');
        ctx.fillRect(0, 0, cw, ch);
        const src = labelCanvas(ph);
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        // crop the empty margin a little: the objects span about 0.2 of the 0.28 m raster
        const m = Math.round(ph.n * 0.08);
        ctx.drawImage(src, m, m, ph.n - 2 * m, ph.n - 2 * m, 0, 0, cw, ch);
        ctx.restore();
        canvas.dataset.drawn = '1';
    }
    function redrawThumbs() {
        Object.keys(ui.cards || {}).forEach(function (id) {
            if (!T.thumbsDone[id]) return;
            let ph = null;
            try { ph = MRI.phantoms.build(id, { n: 256 }); } catch (e) { return; }
            drawThumb(ui.cards[id].canvas, ph);
        });
    }

    /* ----- options ----- */
    function buildOptions() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'pt-opt-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'pt-opt-title', text: 'Options' })]));

        const lesion = el('div', { class: 'pt-opt' });
        ui.lesion = w().toggle({
            label: 'Lesions', checked: !!state().phantomOpts.lesion,
            hint: 'One 12 mm lesion in the right frontal white matter and three periventricular plaques (brain phantom only)',
            onChange: function (on) { MRI.actions.setPhantomOpts({ lesion: !!on }); }
        });
        lesion.appendChild(ui.lesion);
        ui.lesionNote = el('p', { class: 'note' });
        lesion.appendChild(ui.lesionNote);
        panel.appendChild(lesion);

        const gd = el('div', { class: 'pt-opt' });
        const commitGad = function (v) { if (Math.abs((state().phantomOpts.gad || 0) - v) > 1e-9) MRI.actions.setPhantomOpts({ gad: v }); };
        const debGad = U.debounce(commitGad, 220);
        ui.gad = w().slider({
            label: 'Gadolinium in enhancing tissue', min: 0, max: 0.5, step: 0.01, value: state().phantomOpts.gad || 0,
            unit: 'mM', hint: 'Concentration of the contrast agent in tissue that takes it up',
            onInput: debGad, onChange: commitGad
        });
        gd.appendChild(ui.gad);
        gd.appendChild(el('p', { class: 'note', html:
            'Gadolinium is paramagnetic: water that brushes past it relaxes faster. It shortens <strong>T1</strong> (and T2) ' +
            'of tissue that takes it up, <span class="nowrap">1/T1 = 1/T1<sub>0</sub> + r<sub>1</sub>C</span> with ' +
            'r<sub>1</sub> &asymp; 4 mM<sup>&minus;1</sup>s<sup>&minus;1</sup> at 3 T. Here only blood and the lesion (a leaky ' +
            'blood-brain barrier) enhance. Then try the T1-weighted gradient echo.' }));
        ui.gdEffect = el('div', { class: 'pt-gd-effect' });
        gd.appendChild(ui.gdEffect);
        ui.gdTry = w().button({ label: 'Load the T1-weighted gradient echo', size: 'sm', onClick: function () {
            MRI.actions.loadPreset('gre_t1');
            if (!state().autoRescan) MRI.actions.runScan({ animate: false });
            MRI.actions.showTab('image', { focus: true });
        } });
        gd.appendChild(el('div', {}, [ui.gdTry]));
        panel.appendChild(gd);
        return panel;
    }
    function syncOptions() {
        const s = state(), ph = T.ph, brain = s.phantomId === 'brain';
        ui.lesion.set(!!s.phantomOpts.lesion);
        ui.lesion.setDisabled(!brain);
        ui.lesionNote.textContent = brain
            ? 'One 12 mm lesion in the right frontal white matter (image left) and three periventricular plaques. Lesions have long T1 and T2 and take up gadolinium.'
            : (s.phantomId === 'shepp' ? 'Lesions belong to the brain phantom. The Shepp-Logan phantom always has its three small "tumours".'
                : 'Lesions belong to the brain phantom.');
        ui.gad.set(s.phantomOpts.gad || 0);
        // the effect of the dose on the tissues that enhance
        ui.gdEffect.textContent = '';
        if (!ph || !MRI.tissues) return;
        const rows = [];
        ph.tissues.forEach(function (t, i) {
            if (i === 0 || !t.enhances) return;
            const base = intrinsic(t.id);
            rows.push({ label: t.name + ' T1', value: (s.phantomOpts.gad > 0 ? fms(base.t1) + ' → ' : '') + fms(t.t1), unit: 'ms' });
        });
        if (!rows.length) {
            ui.gdEffect.appendChild(el('p', { class: 'note', text: 'No tissue in this phantom takes up gadolinium.' }));
            ui.gdTry.disabled = true;
        } else {
            ui.gdEffect.appendChild(w().statTable(rows, { compact: true }));
            ui.gdTry.disabled = false;
        }
    }

    /* ----- map viewer ----- */
    function buildMapPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'pt-map-title' });
        ui.mapPanel = panel;
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pt-map-title', text: 'What the scanner sees at each point' })
        ]));
        const tools = el('div', { class: 'pt-map-tools' });
        ui.mapSel = w().select({ label: 'Map', options: MAPS, value: T.mapId, onChange: function (v) { T.mapId = v; syncMapTools(); refreshMap(); } });
        tools.appendChild(ui.mapSel);
        ui.coilSel = w().select({ label: 'Coil element', options: [{ value: 0, label: 'Coil 1' }], value: 0,
            onChange: function (v) { T.coil = +v || 0; refreshMap(); } });
        ui.coilSel.classList.add('pt-coilsel');
        tools.appendChild(ui.coilSel);
        ui.csToggle = w().toggle({ label: 'Add chemical shift (fat −434 Hz)', checked: T.withCS,
            hint: 'Include each tissue\'s chemical shift: fat resonates 3.4 ppm below water',
            onChange: function (on) { T.withCS = !!on; refreshMap(); } });
        tools.appendChild(ui.csToggle);
        ui.lmToggle = w().toggle({ label: 'Landmarks', checked: T.landmarks,
            onChange: function (on) { T.landmarks = !!on; syncMapTools(); view.redraw(); } });
        tools.appendChild(ui.lmToggle);
        panel.appendChild(tools);

        const view = ui.view = w().imageView(panel, { title: 'Tissue labels', cmap: 'gray', colorbar: true, wl: true,
            empty: 'Building the phantom…', readoutFormat: readoutText });
        view.el.classList.add('pt-view');
        view.setOverlay(drawOverlay);
        view.onHover(frameThrottleArg(onHover));
        // The well's idle hint talks about window/level, which the label map does not use.
        ui.readout = view.el.querySelector('.well-readout');
        // A touch or pen lifting off the image also "leaves" it, right after a tap has
        // pinned a readout (before the frame-throttled hover arrives): keep that readout.
        view.canvas.addEventListener('pointerleave', function (ev) {
            if (ev && (ev.pointerType === 'touch' || ev.pointerType === 'pen')) return;
            idleHint();
        });

        ui.legend = el('div', { class: 'pt-legend' });
        panel.appendChild(ui.legend);
        ui.caption = el('p', { class: 'pt-caption' });
        panel.appendChild(ui.caption);
        ui.probe = el('div', { class: 'pt-probe' });
        panel.appendChild(ui.probe);
        ui.lmList = el('ol', { class: 'pt-lm-list', hidden: true, 'aria-label': 'Landmarks' });
        panel.appendChild(ui.lmList);
        panel.appendChild(el('p', { class: 'simplification', text:
            'The phantom is a single 2D slice with hard labels: one tissue per raster pixel (0.28 m / ' +
            'n pixels). Partial volume appears only when the image matrix is coarser than this raster. Real tissue also varies ' +
            'by 10 to 20 percent from person to person, so do not read the third digit. ' + BLOOD_NOTE }));
        renderProbe(null);
        return panel;
    }
    function frameThrottleArg(fn) {
        let pending = false, last = null;
        return function (p) {
            last = p;
            if (pending) return;
            pending = true;
            raf(function () { pending = false; fn(last); });
        };
    }

    function needsFields(id) { return id === 'df' || id === 'b1' || id === 'coil' || id === 'rss'; }
    const coilNameCache = {};
    function coilNames() {
        const type = state().coilType || 'body';
        if (!coilNameCache[type]) {
            try { coilNameCache[type] = MRI.fields.coilSet(type).names.slice(); } catch (e) { coilNameCache[type] = ['Coil 1']; }
        }
        return coilNameCache[type];
    }
    function syncMapTools() {
        const id = T.mapId;
        const isCoil = id === 'coil';
        ui.coilSel.hidden = !isCoil;
        ui.csToggle.hidden = id !== 'df';
        ui.view.el.classList.toggle('is-labels', id === 'labels');
        const lms = T.ph && T.ph.landmarks ? T.ph.landmarks : [];
        ui.lmList.hidden = !(T.landmarks && lms.length);
        // coil choices follow the coil set
        const names = coilNames();
        const key = names.join('|');
        if (ui.coilSel.dataset.key !== key) {
            ui.coilSel.dataset.key = key;
            if (T.coil >= names.length) T.coil = 0;
            ui.coilSel.setOptions(names.map(function (nm, i) {
                return { value: i, label: TERMS.coilLabel ? TERMS.coilLabel(i, { names: names }) : 'Coil ' + (i + 1) + ' · ' + nm };
            }), T.coil);
        }
    }

    function syncLandmarkList() {
        const lms = T.ph && T.ph.landmarks ? T.ph.landmarks : [];
        const key = lms.map(function (l) { return l.name; }).join('|');
        if (ui.lmList.dataset.key === key) return;
        ui.lmList.dataset.key = key;
        ui.lmList.textContent = '';
        lms.forEach(function (l) { ui.lmList.appendChild(el('li', { text: l.name })); });
    }

    /* Compute the data for the current map. Returns
       {data, min, max, cmap, title, unit, caption, wl} or null. */
    function mapData(ph, f) {
        const n = ph.n, N = n * n, label = ph.label, tissues = ph.tissues;
        const id = T.mapId, s = state();
        if (id === 'labels') {
            const data = new Float32Array(N);
            for (let i = 0; i < N; i++) data[i] = label[i];
            return { data: data, min: 0, max: Math.max(1, tissues.length - 1), cmap: 'gray', title: 'Tissue labels', wl: false,
                caption: 'Each raster pixel holds exactly one tissue. The colours are only labels: what the scanner measures are the numbers in the other maps.' };
        }
        if (id === 'pd') {
            const lut = tissues.map(function (t) { return t.pd; }), data = new Float32Array(N);
            for (let i = 0; i < N; i++) data[i] = label[i] ? lut[label[i]] : 0;
            return { data: data, min: 0, max: 1, cmap: 'gray', title: 'Proton density (relative to water)', wl: true,
                caption: '<strong>Proton density</strong>: mobile protons per volume relative to pure water (1). It scales every signal: ' +
                    'a proton-density-weighted image (long TR, short TE) is close to this map. Cortical bone holds almost none.' };
        }
        if (id === 't1' || id === 't2' || id === 't2s') {
            const lut = tissues.map(function (t) { return t[id] * 1000; }), data = new Float32Array(N);
            for (let i = 0; i < N; i++) data[i] = label[i] ? lut[label[i]] : NaN;
            const win = relaxWindow(ph, id);
            const nm = RELAX_NAME[id];
            let cap = id === 't1'
                ? '<strong>T1</strong>: the time constant of longitudinal recovery after a pulse. Short-T1 tissue (fat, white matter) recovers ' +
                    'quickly and is bright on T1-weighted images; CSF, with a very long T1, stays dark.'
                : id === 't2'
                    ? '<strong>T2</strong>: decay of transverse magnetisation through spin-spin interactions, the part a spin echo cannot refocus. ' +
                        'Long-T2 tissue (CSF, lesions) is bright on T2-weighted images.'
                    : '<strong>T2*</strong>: what a gradient echo sees, T2 decay plus dephasing from field variations inside the voxel: ' +
                        '1/T2* = 1/T2 + 1/T2′. Always shorter than T2.';
            if (win.clipped) cap += ' ' + win.clipped.name + ' (' + fnum(win.clipped.value, 4) + ' ms) is above this window and shows at the top colour; drag on the image to change the window.';
            if (s.phantomOpts.gad > 0 && tissues.some(function (t) { return t.enhances; })) cap += ' Values include ' + fnum(s.phantomOpts.gad, 2) + ' mM gadolinium in enhancing tissue.';
            return { data: data, min: win.min, max: win.max, cmap: 'viridis', title: nm + ' map (ms)', unit: 'ms', wl: true, caption: cap };
        }
        if (id === 'df') {
            if (!f || !f.b0Map) return null;
            const b0 = f.b0Map, data = new Float32Array(N);
            const cs = tissues.map(function (t) { return (t.cs || 0) * PPM_HZ; });
            let mx = 0;
            for (let i = 0; i < N; i++) {
                const l = label[i];
                if (!l) { data[i] = NaN; continue; }
                const v = b0[i] + (T.withCS ? cs[l] : 0);
                data[i] = v;
                const a = Math.abs(v); if (a > mx) mx = a;
            }
            // window: the 99.5th percentile of |df|, so the few pixels right at the sinus wall do not wash out the rest
            const absd = new Float32Array(N);
            for (let i = 0; i < N; i++) absd[i] = Math.abs(data[i]);
            const lim = niceCeil(Math.max(20, Math.min(mx, U.percentile(absd, 99.5) * 1.1)));
            const a = s.artifacts || {}, b0s = a.b0 || {};
            const susc = b0s.susceptibility === undefined ? 1 : b0s.susceptibility, shim = b0s.shim || 0;
            let cap = '<strong>Off-resonance</strong> &Delta;f at 3 T with the current B0 settings (susceptibility &times;' + fnum(susc, 2) +
                ', shim residual ' + fnum(shim, 2) + '; change them on the Artifacts tab). Red is above the scanner frequency, blue below. ' +
                'Air in the frontal sinus and ear canals bends the field in nearby tissue; off-resonant spins shift along the readout and ' +
                'dephase in gradient echoes.';
            if (T.withCS) cap += ' With chemical shift, fat sits near −434 Hz (3.4 ppm at 127.7 MHz).';
            else if (tissues.some(function (t) { return t.cs; })) cap += ' Chemical shift is not included: switch it on to see fat at −434 Hz.';
            return { data: data, min: -lim, max: lim, cmap: 'diverging', title: 'Off-resonance (Hz)', unit: 'Hz', wl: true, caption: cap };
        }
        if (id === 'b1') {
            if (!f || !f.b1Map) return null;
            const b1 = f.b1Map, data = new Float32Array(N);
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < N; i++) {
                if (!label[i]) { data[i] = NaN; continue; }
                const v = b1[i]; data[i] = v;
                if (v < lo) lo = v; if (v > hi) hi = v;
            }
            const amount = (s.artifacts && s.artifacts.b1 && s.artifacts.b1.amount) || 0;
            let cap = '<strong>Transmit field</strong> B1 relative to nominal: 1 (white) gives the flip angle you asked for, red more, blue less. ' +
                'At 3 T the RF wavelength in tissue (about 12 cm) is close to the size of the head, so the centre gets more and the edge less ' +
                '(the dielectric effect).';
            cap += amount > 0
                ? ' Currently ' + fnum(lo, 3) + ' to ' + fnum(hi, 3) + ' (dielectric effect ' + fnum(amount, 2) + ', set on the Artifacts tab).'
                : ' At the moment it is uniform: the dielectric effect is off (turn it on in the Artifacts tab).';
            return { data: data, min: 0.4, max: 1.6, cmap: 'diverging', title: 'B1 transmit scale (× nominal)', wl: true, caption: cap };
        }
        if (id === 'coil' || id === 'rss') {
            if (!f || !f.coilMaps || !f.coilMaps.re || !f.coilMaps.re.length) return null;
            const maps = f.coilMaps, nC = maps.re.length, cs = f.coilSet || {};
            let data;
            if (id === 'coil') {
                const k = Math.min(T.coil, nC - 1), re = maps.re[k], im = maps.im[k];
                data = new Float32Array(N);
                for (let i = 0; i < N; i++) data[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
            } else data = rssOf(maps);
            let mx = 0, mxIn = 0;
            for (let i = 0; i < N; i++) { if (data[i] > mx) mx = data[i]; if (label[i] && data[i] > mxIn) mxIn = data[i]; }
            const body = cs.type === 'body' || nC === 1;
            const h = Math.floor(n / 2), centre = data[h * n + h];
            /* The body coil's own noise, relative to one element of the array
               (fields.js noiseFactor), for the SNR comparison in the captions. */
            let bodyNoise = 2.4;
            try { const nf = MRI.fields.coilSet('body').noiseFactor; if (nf > 0) bodyNoise = nf; } catch (e) { /* keep 2.4 */ }
            let cap;
            if (body) {
                cap = 'The <strong>body coil</strong> (the large birdcage in the bore) is taken as perfectly uniform: sensitivity 1 everywhere. ' +
                    'Uniform is not the same as good: it picks up thermal noise from the whole head, neck and shoulders, about ' + fnum(bodyNoise, 2) +
                    ' times the noise of one head-coil element, so its SNR is lower than the head array\'s everywhere in the head. ' +
                    'Choose the 8-channel head coil on the Scanner tab to see loop-coil sensitivities.';
            } else if (id === 'coil') {
                cap = '<strong>Receive sensitivity</strong> |C| of element ' + (Math.min(T.coil, nC - 1) + 1) + ' of ' + nC + ' (marked). A small loop ' +
                    'sees tissue close to it strongly and the far side of the head weakly (the white line is the outline of the object). The simulator knows these maps exactly; a real ' +
                    'scanner measures them in a short calibration scan, needed for SENSE and for the ' + combineName('roemer') + ' combination (the default here).';
            } else {
                cap = '<strong>' + combineName('sos') + '</strong> of the ' + nC + ' element sensitivities: about ' + fnum(centre, 2) + ' at the centre of the head, ' +
                    'rising to about ' + fnum(mxIn, 2) + ' next to the coils. This is the relative sensitivity: the shading a root-sum-of-squares combination ' +
                    'leaves in the image (the default ' + combineName('roemer') + ' combination divides it out). It is not the SNR. Each small loop also picks up far ' +
                    'less noise than the body coil (about ' + fnum(bodyNoise, 2) + ' times less), so the array has the higher SNR everywhere in the head: about ' +
                    fnum(bodyNoise * centre, 2) + ' times the body coil\'s at the centre and most near the cortex.';
            }
            return { data: data, min: 0, max: body ? 1.2 : niceCeil(mx), cmap: 'hot',
                title: id === 'coil' ? (body ? 'Body coil sensitivity' : 'Coil ' + (Math.min(T.coil, nC - 1) + 1) + ' sensitivity |C|') : 'Coil RSS',
                wl: true, caption: cap };
        }
        return null;
    }

    function refreshMap() {
        if (!T.mounted) return;
        if (!T.visible) { T.dirty.map = true; return; }
        T.dirty.map = false;
        const ph = currentPhantom();
        T.ph = ph;
        if (!ph) { ui.view.clear('The phantom could not be built.'); ui.caption.textContent = ''; return; }
        // Field maps (and the eight coil maps) only when this map needs them; the hover probe fetches them on demand.
        const f = needsFields(T.mapId) ? currentFields(ph) : null;
        T.fields = f;
        syncMapTools();
        syncLandmarkList();
        renderLegend();
        const key = [T.mapId, idOf(ph), f ? idOf(f.b0Map) : 0, f ? idOf(f.b1Map) : 0, f ? idOf(f.coilMaps) : 0, T.coil, T.withCS].join('|');
        if (key === T.lastKey) { ui.view.redraw(); return; }
        const d = mapData(ph, f);
        if (!d) {
            ui.view.clear('This map is not available (the field module did not load).');
            ui.caption.textContent = '';
            T.lastKey = null;
            return;
        }
        const reset = T.lastMapId !== T.mapId || T.lastPhId !== ph.id || T.mapId === 'coil';
        T.lastKey = key; T.lastMapId = T.mapId; T.lastPhId = ph.id;
        ui.view.setWL(d.wl !== false);
        ui.view.setTitle(d.title);
        ui.view.canvas.setAttribute('aria-label', d.title + ' of the ' + ph.name + ' phantom. ' + (coarsePointer() ? 'Tap' : 'Hover') + ' to read values; the tissue table below lists them.');
        ui.view.setData(d.data, ph.n, ph.n, { min: d.min, max: d.max, cmap: d.cmap, fovX: ph.fov, fovY: ph.fov, resetWindow: reset });
        ui.caption.innerHTML = d.caption || '';
        idleHint();
        if (T.hover) onHover(T.hover);
    }
    function coarsePointer() {
        try { return !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
    }
    function idleHint() {
        if (!ui.readout || T.hover) return;
        const touch = coarsePointer();
        ui.readout.textContent = T.mapId === 'labels'
            ? (touch ? 'Tap the image to name a tissue' : 'Hover over the image to name a tissue')
            : (touch ? 'Tap: read a value \u00b7 hold, then drag: window/level' : 'Drag: window/level \u00b7 double-click: reset');
    }

    function renderLegend() {
        const ph = T.ph;
        ui.legend.textContent = '';
        ui.legend.hidden = T.mapId !== 'labels' || !ph;
        if (!ph || T.mapId !== 'labels') return;
        ui.legend.appendChild(w().legend(ph.tissues.slice(1).map(function (t) { return { label: t.name, color: t.color }; })));
    }

    /* Overlay: the tissue colours (labels map), the coil elements (coil
       maps) and the numbered landmarks. Runs after every draw. */
    function drawOverlay(ctx, g) {
        const ph = T.ph;
        if (!ph || g.nx !== ph.n) return;
        const h = Math.floor(ph.n / 2), dx = ph.dx;
        const toC = function (xm, ym) { return g.toCanvas(xm / dx + h, ym / dx + h); };
        if (T.mapId === 'labels') {
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(labelCanvas(ph), 0, 0, ph.n, ph.n, 0, 0, g.w, g.h);
        }
        if (T.mapId === 'coil' || T.mapId === 'rss') {
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = 0.7;
            ctx.drawImage(outlineCanvas(ph), 0, 0, ph.n, ph.n, 0, 0, g.w, g.h);
            ctx.globalAlpha = 1;
        }
        if ((T.mapId === 'coil' || T.mapId === 'rss') && T.fields && T.fields.coilSet && T.fields.coilSet.type !== 'body') {
            const pos = T.fields.coilSet.positions || [];
            ctx.font = '600 10px ' + U.cssVar('--font-sans', 'sans-serif');
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            pos.forEach(function (p, k) {
                const c = toC(p.x, p.y), sel = T.mapId === 'coil' && k === T.coil;
                ctx.beginPath(); ctx.arc(c.x, c.y, sel ? 9 : 7, 0, 2 * Math.PI);
                ctx.fillStyle = sel ? 'rgba(96, 165, 250, 0.95)' : 'rgba(0, 0, 0, 0.65)'; ctx.fill();
                ctx.lineWidth = 1.5; ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255, 255, 255, 0.8)'; ctx.stroke();
                ctx.fillStyle = sel ? '#0b0f17' : '#ffffff';
                ctx.fillText(String(k + 1), c.x, c.y + 0.5);
            });
        }
        if (T.landmarks && ph.landmarks && ph.landmarks.length) {
            const r = g.w < 360 ? 6 : 7.5;
            ctx.font = '700 ' + (g.w < 360 ? 8 : 9.5) + 'px ' + U.cssVar('--font-sans', 'sans-serif');
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ph.landmarks.forEach(function (L, k) {
                const c = toC(L.x, L.y);
                ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = 'rgba(11, 15, 23, 0.78)'; ctx.fill();
                ctx.lineWidth = 1.25; ctx.strokeStyle = '#f0b429'; ctx.stroke();
                ctx.fillStyle = '#ffffff';
                ctx.fillText(String(k + 1), c.x, c.y + 0.5);
            });
        }
    }

    /* ----- hover probe ----- */
    function readoutText(ix, iy, value) {
        const ph = T.ph;
        if (!ph) return '';
        const h = Math.floor(ph.n / 2);
        const pos = 'x ' + fmm((ix - h) * ph.dx) + ' mm, y ' + fmm((iy - h) * ph.dx) + ' mm';
        const id = T.mapId;
        let v;
        if (id === 'labels') { const t = ph.tissues[value | 0]; v = t ? t.name : '-'; }
        else if (!isFinite(value)) v = 'air (no signal)';
        else if (id === 'pd') v = 'PD ' + fnum(value, 3);
        else if (id === 't1' || id === 't2' || id === 't2s') v = RELAX_NAME[id] + ' ' + fnum(value, 4) + ' ms';
        else if (id === 'df') v = fsigned(value, 3) + ' Hz';
        else if (id === 'b1') v = fnum(value, 3) + ' × nominal';
        else v = fnum(value, 3);
        return pos + ': ' + v;
    }
    function onHover(p) {
        T.hover = p;
        renderProbe(p);
        if (!p) idleHint();
    }
    function nearLandmark(p) {
        const ph = T.ph;
        if (!p || !p.event || !T.landmarks || !ph || !ph.landmarks) return null;
        const rect = ui.view.canvas.getBoundingClientRect(), g = ui.view.geometry();
        if (!rect.width || !g || g.nx !== ph.n) return null;
        const mx = p.event.clientX - rect.left, my = p.event.clientY - rect.top, h = Math.floor(ph.n / 2);
        let best = null, bd = 11;
        ph.landmarks.forEach(function (L, k) {
            const c = g.toCanvas(L.x / ph.dx + h, L.y / ph.dx + h), d = Math.hypot(c.x - mx, c.y - my);
            if (d < bd) { bd = d; best = { k: k, name: L.name }; }
        });
        return best;
    }
    function renderProbe(p) {
        const box = ui.probe;
        if (!box) return;
        box.textContent = '';
        const ph = T.ph;
        if (!p || !ph || p.nx !== ph.n) {
            box.appendChild(el('div', { class: 'pt-probe-empty', text: 'Hover over the map to read the tissue and all its values at that point.' }));
            return;
        }
        const n = ph.n, i = p.iy * n + p.ix, l = ph.label[i], t = ph.tissues[l], h = Math.floor(n / 2);
        if (!T.fields) T.fields = currentFields(ph);        // cached by the app after the first call
        const f = T.fields;
        const head = el('div', { class: 'pt-probe-head' }, [
            el('span', { class: 'swatch', style: { background: l ? t.color : 'transparent' }, 'aria-hidden': 'true' }),
            el('span', { text: l ? t.name : 'Air (outside the object): no protons, no signal' })
        ]);
        const lm = nearLandmark(p);
        if (lm) head.appendChild(el('span', { class: 'pt-probe-lm', text: (lm.k + 1) + '. ' + lm.name }));
        head.appendChild(el('span', { class: 'pt-probe-pos', text: 'x ' + fmm((p.ix - h) * ph.dx) + ', y ' + fmm((p.iy - h) * ph.dx) + ' mm' }));
        box.appendChild(head);
        if (!l) return;
        const items = [
            ['PD', fnum(t.pd, 3)],
            ['T1', fnum(t.t1 * 1000, 4) + ' ms'],
            ['T2', fnum(t.t2 * 1000, 4) + ' ms'],
            ['T2*', fnum(t.t2s * 1000, 4) + ' ms'],
            ['Shift', (t.cs ? fnum(t.cs, 3) : '0') + ' ppm']
        ];
        if (f && f.b0Map) {
            const df = f.b0Map[i];
            items.push(['Δf (field)', fsigned(df, 3) + ' Hz']);
            if (t.cs) items.push(['Δf + shift', fsigned(df + t.cs * PPM_HZ, 3) + ' Hz']);
        }
        if (f && f.b1Map) items.push(['B1', fnum(f.b1Map[i], 3) + ' ×']);
        if (f && f.coilMaps && f.coilSet && f.coilSet.type !== 'body') {
            const r = rssOf(f.coilMaps);
            if (r) items.push(['Coil RSS', fnum(r[i], 3)]);
            if (T.mapId === 'coil') {
                const k = Math.min(T.coil, f.coilMaps.re.length - 1);
                items.push(['|C' + (k + 1) + '|', fnum(Math.hypot(f.coilMaps.re[k][i], f.coilMaps.im[k][i]), 3)]);
            }
        }
        const grid = el('div', { class: 'pt-probe-grid' });
        items.forEach(function (it) { grid.appendChild(el('div', {}, [el('span', { class: 'k', text: it[0] }), el('span', { class: 'v', text: it[1] })])); });
        box.appendChild(grid);
        if (t.pulsatile) box.appendChild(el('p', { class: 'note mt-1 mb-0', text: BLOOD_NOTE }));
    }

    /* ----- tissue table ----- */
    const PROPS = [
        { key: 'pd', label: 'PD', unit: '', head: 'PD', toUI: function (v) { return fnum(v, 3); }, fromUI: function (x) { return x; } },
        { key: 't1', label: 'T1', unit: 'ms', head: 'T1 (ms)', toUI: function (v) { return fms(v); }, fromUI: function (x) { return x / 1000; } },
        { key: 't2', label: 'T2', unit: 'ms', head: 'T2 (ms)', toUI: function (v) { return fms(v); }, fromUI: function (x) { return x / 1000; } },
        { key: 't2s', label: 'T2*', unit: 'ms', head: 'T2* (ms)', toUI: function (v) { return fms(v); }, fromUI: function (x) { return x / 1000; } }
    ];
    function libTissue(id) { return MRI.tissues && MRI.tissues.library ? MRI.tissues.library[id] : null; }
    /* Intrinsic properties (library value, or the student's override),
       i.e. before gadolinium. These are what the inputs show and edit. */
    function intrinsic(id) {
        const lib = libTissue(id) || {};
        const ov = (state().phantomOpts.overrides || {})[id] || {};
        const out = {};
        PROPS.forEach(function (p) { out[p.key] = ov[p.key] !== undefined && isFinite(ov[p.key]) ? +ov[p.key] : lib[p.key]; });
        return out;
    }
    function isEdited(id, key) {
        const lib = libTissue(id), ov = (state().phantomOpts.overrides || {})[id];
        if (!lib || !ov || ov[key] === undefined) return false;
        return Math.abs(ov[key] - lib[key]) > 1e-12 * Math.max(1, Math.abs(lib[key]));
    }

    function buildTablePanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'pt-tab-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pt-tab-title', text: 'Tissue properties' }),
            el('span', { class: 'panel-sub', text: 'PD, T1, T2 and T2* of every tissue in this phantom at 3 T (hover the map to read them at a point)' })
        ]));
        /* The 36 inputs stay one click away: most visits only read the maps. */
        const det = ui.tableDet = el('details', { class: 'adv pt-edit' }, [el('summary', { text: 'Edit tissue values' })]);
        panel.appendChild(det);
        const body = el('div', { class: 'adv-body' });
        det.appendChild(body);
        const tools = el('div', { class: 'pt-table-tools' });
        tools.appendChild(el('p', { class: 'note', html:
            'Edit a value and press Enter. PD is relative to pure water; times are in milliseconds. These are the <strong>intrinsic</strong> values (before gadolinium); ' +
            'the value with gadolinium is shown underneath for tissue that enhances. Rules every tissue obeys: T2* &le; T2 &le; T1. ' +
            'Leave a box empty to restore the default.' }));
        ui.resetAll = w().button({ label: 'Reset all tissues', size: 'sm', onClick: function () {
            MRI.actions.setPhantomOpts({ overrides: {} });
            setMsg('All tissues are back to their library values.', 'good');
        } });
        tools.appendChild(ui.resetAll);
        body.appendChild(tools);
        const table = el('table', { class: 'pt-table' });
        const thead = el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', text: 'Tissue' }),
            el('th', { scope: 'col', class: 'num', text: 'PD' }),
            el('th', { scope: 'col', class: 'num', text: 'T1 (ms)' }),
            el('th', { scope: 'col', class: 'num', text: 'T2 (ms)' }),
            el('th', { scope: 'col', class: 'num', text: 'T2* (ms)' }),
            el('th', { scope: 'col', class: 'num', text: 'Shift (ppm)' }),
            el('th', { scope: 'col', html: '<span class="sr-only">Reset</span>' })
        ])]);
        ui.tbody = el('tbody');
        table.appendChild(thead);
        table.appendChild(ui.tbody);
        body.appendChild(el('div', { class: 'pt-table-wrap' }, [table]));
        ui.msg = el('p', { class: 'pt-msg', role: 'status', 'aria-live': 'polite' });
        body.appendChild(ui.msg);
        return panel;
    }
    let msgTimer = null;
    function setMsg(text, kind) {
        ui.msg.textContent = text || '';
        ui.msg.className = 'pt-msg' + (kind ? ' ' + kind : '');
        if (msgTimer) clearTimeout(msgTimer);
        if (kind === 'good') msgTimer = setTimeout(function () { if (ui.msg.className.indexOf('good') >= 0) setMsg(''); }, 4000);
    }

    /* Rows are built once per tissue list and updated in place, so a
       commit (which rebuilds the phantom and emits phantom:changed) never
       steals focus from the box the student tabs into next. */
    function syncTable() {
        const ph = T.ph;
        if (!ph) { ui.tbody.textContent = ''; T.tableKey = null; return; }
        const list = ph.tissues.slice(1);
        const key = list.map(function (t) { return t.id; }).join(',');
        if (key !== T.tableKey) {
            T.tableKey = key;
            T.rows = {};
            ui.tbody.textContent = '';
            list.forEach(function (t) { ui.tbody.appendChild(buildRow(t)); });
        }
        const s = state(), gad = s.phantomOpts.gad || 0;
        let anyEdited = Object.keys(s.phantomOpts.overrides || {}).length > 0;
        list.forEach(function (t) {
            const r = T.rows[t.id];
            if (!r) return;
            const cur = intrinsic(t.id), lib = libTissue(t.id) || {};
            let rowEdited = false;
            PROPS.forEach(function (p) {
                const inp = r.inputs[p.key], ed = isEdited(t.id, p.key);
                rowEdited = rowEdited || ed;
                if (doc.activeElement !== inp && inp.getAttribute('aria-invalid') !== 'true') inp.value = p.toUI(cur[p.key]);
                inp.classList.toggle('is-edited', ed);
                inp.title = 'Default ' + p.toUI(lib[p.key]) + (p.unit ? ' ' + p.unit : '');
                // a second line: the default when edited, the value with gadolinium when it differs
                const sub = r.subs[p.key];
                let text = '', cls = 'pt-sub';
                if (p.key !== 'pd' && gad > 0 && t.enhances && Math.abs(t[p.key] - cur[p.key]) > 1e-12) { text = 'with Gd ' + p.toUI(t[p.key]); cls += ' gd'; }
                else if (ed) text = 'default ' + p.toUI(lib[p.key]);
                sub.textContent = text;
                sub.className = cls;
                sub.hidden = !text;
            });
            r.tr.classList.toggle('is-edited', rowEdited);
            r.badge.hidden = !rowEdited;
            r.reset.disabled = !rowEdited && !(s.phantomOpts.overrides || {})[t.id];
        });
        ui.resetAll.disabled = !anyEdited;
    }
    function buildRow(t) {
        const r = { inputs: {}, subs: {} };
        const tr = el('tr', { 'data-id': t.id });
        r.tr = tr;
        r.badge = el('span', { class: 'badge badge-accent', text: 'edited', hidden: true });
        tr.appendChild(el('td', { class: 'pt-name' }, [el('span', { class: 'pt-name-wrap' }, [
            el('span', { class: 'swatch', style: { background: t.color }, 'aria-hidden': 'true' }),
            el('span', { text: t.name }), r.badge
        ])]));
        PROPS.forEach(function (p) {
            const inp = el('input', { type: 'text', class: 'input pt-in', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
                'aria-label': p.label + ' of ' + t.name + (p.unit ? ' in ' + p.unit : ' (relative to water)') });
            inp.addEventListener('change', function () { commitRow(t.id); });
            inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commitRow(t.id); }
                else if (e.key === 'Escape') { inp.removeAttribute('aria-invalid'); setMsg(''); inp.blur(); syncTable(); }
            });
            r.inputs[p.key] = inp;
            r.subs[p.key] = el('span', { class: 'pt-sub', hidden: true });
            tr.appendChild(el('td', { class: 'num', 'data-label': p.head }, [inp, r.subs[p.key]]));
        });
        tr.appendChild(el('td', { class: 'num pt-cs', 'data-label': 'Shift (ppm)', text: t.cs ? fnum(t.cs, 3) : '0' }));
        r.reset = w().button({ label: 'Reset', size: 'xs', title: 'Restore the library values of ' + t.name, onClick: function () {
            const ov = Object.assign({}, state().phantomOpts.overrides || {});
            delete ov[t.id];
            PROPS.forEach(function (p) { r.inputs[p.key].removeAttribute('aria-invalid'); });
            MRI.actions.setPhantomOpts({ overrides: ov });
            setMsg(t.name + ' is back to its library values.', 'good');
        } });
        r.reset.setAttribute('aria-label', 'Reset ' + t.name);
        tr.appendChild(el('td', { class: 'pt-act' }, [r.reset]));
        T.rows[t.id] = r;
        return tr;
    }

    function commitRow(id) {
        const r = T.rows[id], lib = libTissue(id);
        if (!r || !lib) return;
        const name = lib.name;
        const vals = {};
        let bad = null;
        PROPS.forEach(function (p) { r.inputs[p.key].removeAttribute('aria-invalid'); });
        PROPS.forEach(function (p) {
            if (bad) return;
            const raw = String(r.inputs[p.key].value).trim().replace(',', '.').replace('−', '-');
            if (raw === '') { vals[p.key] = lib[p.key]; return; }        // empty box: the default
            const x = Number(raw);
            if (!isFinite(x)) { bad = { key: p.key, msg: p.label + ' of ' + name + ': "' + raw + '" is not a number.' }; return; }
            vals[p.key] = p.fromUI(x);
        });
        if (!bad) {
            if (!(vals.pd >= 0 && vals.pd <= 1)) bad = { key: 'pd', msg: 'Proton density must be between 0 and 1 (1 is pure water).' };
            else if (!(vals.t1 > 0) || !(vals.t2 > 0) || !(vals.t2s > 0)) {
                const k = !(vals.t1 > 0) ? 't1' : (!(vals.t2 > 0) ? 't2' : 't2s');
                bad = { key: k, msg: RELAX_NAME[k] + ' must be a positive time in milliseconds.' };
            } else if (vals.t1 > 20) bad = { key: 't1', msg: 'T1 above 20 000 ms is longer than in any tissue or liquid at 3 T.' };
            else if (vals.t2 > vals.t1 * (1 + 1e-9)) {
                bad = { key: 't2', msg: 'T2 (' + fms(vals.t2) + ' ms) cannot be longer than T1 (' + fms(vals.t1) + ' ms): in tissue, ' +
                    'transverse magnetisation always decays at least as fast as longitudinal magnetisation recovers.' };
            } else if (vals.t2s > vals.t2 * (1 + 1e-9)) {
                bad = { key: 't2s', msg: 'T2* (' + fms(vals.t2s) + ' ms) cannot be longer than T2 (' + fms(vals.t2) + ' ms): T2* is T2 decay ' +
                    'plus extra dephasing from field variations inside the voxel, so it is always the shorter of the two.' };
            }
        }
        if (bad) {
            r.inputs[bad.key].setAttribute('aria-invalid', 'true');
            setMsg(bad.msg, 'bad');
            return;
        }
        // store only what differs from the library, so "edited" means edited
        const o = {};
        PROPS.forEach(function (p) {
            if (Math.abs(vals[p.key] - lib[p.key]) > 1e-12 * Math.max(1, Math.abs(lib[p.key]))) o[p.key] = vals[p.key];
        });
        const prev = (state().phantomOpts.overrides || {})[id] || {};
        const same = JSON.stringify(o) === JSON.stringify(prev) || (!Object.keys(o).length && !Object.keys(prev).length);
        setMsg('');
        if (same) { syncTable(); return; }
        const ov = Object.assign({}, state().phantomOpts.overrides || {});
        if (Object.keys(o).length) ov[id] = o; else delete ov[id];
        MRI.actions.setPhantomOpts({ overrides: ov });
        setMsg(Object.keys(o).length ? name + ' updated; the scan uses the new values.' : name + ' is back to its library values.', 'good');
    }

    /* ----- updates ----- */
    function refreshAll() {
        if (!T.mounted) return;
        if (!T.visible) { T.dirty.all = true; T.dirty.map = true; return; }
        T.dirty.all = false;
        T.ph = currentPhantom();
        syncPicker();
        syncOptions();
        syncTable();
        refreshMap();
    }

    MRI.ui.registerTab({
        id: 'phantom', title: 'Phantom', order: 20,
        mount: function (panel) {
            panel.textContent = '';
            panel.appendChild(buildConcept());
            panel.appendChild(buildPicker());
            const split = el('div', { class: 'split' });
            split.appendChild(buildMapPanel());
            const side = el('div', { class: 'pt-side' }, [buildOptions()]);
            split.appendChild(side);
            panel.appendChild(split);
            panel.appendChild(buildTablePanel());
            T.mounted = true;
            syncMapTools();

            MRI.bus.on('phantom:changed', function () { T.lastKey = null; refreshAll(); });
            MRI.bus.on('artifacts:changed', function () { refreshMap(); });
            MRI.bus.on('coil:changed', function () { refreshMap(); });
            // The raster follows the matrix size (256 or 512), so a new program may mean a new phantom object.
            MRI.bus.on('program:compiled', function () { refreshMap(); });
            MRI.bus.on('theme:changed', function () { if (T.visible) redrawThumbs(); });
        },
        onShow: function () {
            T.visible = true;
            refreshAll();
            if (ui.view) ui.view.redraw();
            redrawThumbs();
            buildThumbs();
        },
        onHide: function () { T.visible = false; T.hover = null; }
    });

})(typeof window !== 'undefined' ? window : globalThis);
