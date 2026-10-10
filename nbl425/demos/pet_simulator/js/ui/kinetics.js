/* ============================================================
   PET Simulator, Dynamic & quantification tab
   What the numbers on a PET image mean, and when they mean what we
   hope. Four parts, after the concept card:

     1. A compartment-model explorer that needs no scan: the plasma
        input of a tracer drives one or two tissue compartments, the
        student drags K1..k4 and the blood volume, and the curves, the
        diagram and the derived values (VT, BPND, DVR, Ki) follow.
     2. Static quantification of the current scan: SUV and SUVR of a
        target against a reference region, measured on the
        reconstruction, next to the same ratio from the noise-free
        truth and the true binding from the model. The difference is
        split into the kinetic bias of a ratio taken at that time and
        the imaging bias (partial volume, noise, corrections).
     3. SUVR over time from the true curves, against the true DVR, with
        the scan window shaded: when (and whether) a ratio is the
        binding.
     4. Dynamic analysis: every frame reconstructed, time-activity
        curves measured on the images next to the true frame means, an
        arterial or image-derived input, and Patlak (trapped tracers),
        Logan with a reference region (reversible tracers) or a
        one-tissue fit (water), compared with the true values.

   Everything is computed from the shared state and modules; the tab
   only changes state through PET.actions (analysis target and
   reference, presets, reconstructing all frames). Heavy work (long
   curves, measured TACs) is cached on the objects it came from.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !PET.util || !root.document) return;
    const U = PET.util;
    const doc = root.document;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const el = function (tag, attrs, children) { return U.el(tag, attrs, children); };
    const w = function () { return PET.ui.w; };

    const MIN = 60;
    const EX_STEP = 5;                  // s, time step of the explorer's curves
    const EX_END = 120 * MIN;           // s, the explorer shows 0 to 120 min
    const EX_REGION = { FDG: 'gm_frontal', PiB: 'gm_frontal', florbetaben: 'gm_frontal', PE2I: 'putamen_r_ant', 'FE-PE2I': 'putamen_r_ant', water: 'gm_frontal' };
    const SUGGESTED_TARGET = { FDG: 'cortex', PiB: 'cortex', florbetaben: 'cortex', PE2I: 'striatum', 'FE-PE2I': 'striatum', water: 'cortex' };
    // ROI outlines on the dark image well: light versions of the plot colours, drawn over a dark halo.
    const WELL_TARGET = '#6fb2ff', WELL_REF = '#ffa45c';

    const CSS = `
#tab-kinetics .kn-head-badges { display: inline-flex; gap: 6px; flex-wrap: wrap; }
#tab-kinetics .kn-controls { --min: 180px; margin-bottom: 12px; }
#tab-kinetics .kn-model-row { margin-bottom: 14px; }
#tab-kinetics .kn-model-row .ctl-seg { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
#tab-kinetics .kn-diagram { margin: 0 0 10px; }
#tab-kinetics .kn-diagram svg { display: block; width: 100%; height: auto; max-height: 300px; }
#tab-kinetics .kn-diagram.is-vertical svg { max-height: none; max-width: 340px; margin: 0 auto; }
#tab-kinetics .kn-box-plasma { fill: var(--c8); fill-opacity: 0.10; stroke: var(--c8); stroke-width: 1.5; }
#tab-kinetics .kn-box-c1 { fill: var(--c1); fill-opacity: 0.10; stroke: var(--c1); stroke-width: 1.5; }
#tab-kinetics .kn-box-c2 { fill: var(--c2); fill-opacity: 0.10; stroke: var(--c2); stroke-width: 1.5; }
#tab-kinetics .kn-box-off { fill: var(--card-2); fill-opacity: 1; stroke: var(--border-strong); stroke-dasharray: 4 4; }
#tab-kinetics .kn-voxel { fill: none; stroke: var(--axis); stroke-width: 1.2; stroke-dasharray: 6 5; }
#tab-kinetics .kn-svg-title { fill: var(--fg); font: 650 14px var(--font-sans); }
#tab-kinetics .kn-svg-sym { fill: var(--fg); font: italic 600 17px var(--font-math); }
#tab-kinetics .kn-svg-sub { fill: var(--muted); font: 12px var(--font-sans); }
#tab-kinetics .kn-svg-note { fill: var(--muted); font: 12px var(--font-sans); }
#tab-kinetics .kn-svg-k { font: 600 13px var(--font-mono); }
#tab-kinetics .kn-svg-k.tr { fill: var(--c1); }
#tab-kinetics .kn-svg-k.bd { fill: var(--c2); }
#tab-kinetics .kn-svg-k.off { fill: var(--faint); font-weight: 500; }
#tab-kinetics .kn-arrow-tr { fill: var(--c1); stroke: var(--c1); }
#tab-kinetics .kn-arrow-bd { fill: var(--c2); stroke: var(--c2); }
#tab-kinetics .kn-arrow-zero { fill: none; stroke: var(--faint); stroke-dasharray: 3 4; stroke-width: 1.2; }
#tab-kinetics .kn-vb-tissue { fill: var(--track); }
#tab-kinetics .kn-vb-blood { fill: var(--c8); }
#tab-kinetics .kn-plot-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 8px 0 0; }
#tab-kinetics .kn-side { display: flex; flex-direction: column; gap: 14px; }
#tab-kinetics .kn-sliders { display: flex; flex-direction: column; gap: 10px; }
#tab-kinetics .kn-sliders .ctl-label { overflow: visible; white-space: normal; }
#tab-kinetics .kn-subhead {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px;
}
#tab-kinetics .kn-try { list-style: none; margin: 0; padding: 0; counter-reset: kntry; font-size: 0.84rem; line-height: 1.45; }
#tab-kinetics .kn-try li { counter-increment: kntry; position: relative; padding-left: 26px; margin-bottom: 8px; }
#tab-kinetics .kn-try li::before {
    content: counter(kntry); position: absolute; left: 0; top: 1px; width: 18px; height: 18px; border-radius: 50%;
    display: grid; place-items: center; font-size: 0.68rem; font-weight: 700;
    background: var(--card); color: var(--accent); border: 1px solid var(--accent-border);
}
#tab-kinetics .kn-try .btn { margin-left: 4px; vertical-align: 1px; }
#tab-kinetics .kn-table { width: 100%; }
#tab-kinetics .kn-table thead th {
    text-align: right; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--muted); padding: 0 0 6px 10px; vertical-align: bottom; line-height: 1.3;
}
#tab-kinetics .kn-table thead th:first-child { text-align: left; padding-left: 0; }
#tab-kinetics .kn-table tbody th { min-width: 9em; }
#tab-kinetics .kn-table tr.kn-sep > * { border-top: 2px solid var(--border); }
#tab-kinetics .kn-table td.kn-hi { font-weight: 700; }
#tab-kinetics .kn-table td { white-space: nowrap; overflow-wrap: normal; }
#tab-kinetics .kn-table td .kn-rel { display: block; font-size: 0.72rem; color: var(--muted); }
#tab-kinetics .kn-table-wrap { overflow-x: auto; }
#tab-kinetics .kn-interp { margin: 12px 0 0; }
#tab-kinetics .kn-interp ul { margin: 6px 0 0; padding-left: 18px; }
#tab-kinetics .kn-interp li { margin-bottom: 5px; }
#tab-kinetics .kn-interp li:last-child { margin-bottom: 0; }
#tab-kinetics .kn-interp .kn-lead { font-weight: 650; }
#tab-kinetics .kn-tiles { margin-top: 12px; }
#tab-kinetics .kn-tiles .stat-value { font-size: 1.02rem; }
#tab-kinetics .kn-well-legend { margin-top: 8px; }
#tab-kinetics .kn-well .well-readout { white-space: normal; }
#tab-kinetics .kn-progress { position: relative; height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; flex: 1; min-width: 80px; max-width: 260px; }
#tab-kinetics .kn-progress-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.15s linear; }
#tab-kinetics .kn-status { font-size: 0.82rem; color: var(--muted); min-width: 0; }
#tab-kinetics .kn-chips { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
#tab-kinetics .kn-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; cursor: pointer; }
#tab-kinetics .kn-chip input { margin: 0; width: 15px; height: 15px; }
#tab-kinetics .kn-chip .swatch { width: 12px; height: 3px; border-radius: 2px; }
#tab-kinetics .kn-dyn-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin-bottom: 12px; }
#tab-kinetics .kn-dyn-tools .ctl-inline .ctl-label { white-space: nowrap; }
#tab-kinetics .kn-fig-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; margin-bottom: 8px; }
#tab-kinetics .kn-fig-title { font-size: 0.88rem; font-weight: 650; }
#tab-kinetics .kn-figure { min-width: 0; }
#tab-kinetics .kn-presets { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); margin-top: 10px; }
#tab-kinetics .kn-preset {
    appearance: none; -webkit-appearance: none; text-align: left; font: inherit; color: var(--fg); cursor: pointer;
    display: flex; flex-direction: column; gap: 3px; padding: 9px 11px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--card-2);
}
#tab-kinetics .kn-preset:hover { border-color: var(--accent-border); background: var(--accent-soft); }
#tab-kinetics .kn-preset:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-kinetics .kn-preset strong { font-size: 0.86rem; }
#tab-kinetics .kn-preset span { font-size: 0.78rem; color: var(--muted); line-height: 1.4; }
#tab-kinetics .kn-formula-lines { display: grid; gap: 4px; }
#tab-kinetics .kn-formula-lines .kn-fl-small { font-size: 0.92rem; color: var(--muted); }
#tab-kinetics .kn-empty-act { margin-top: 10px; }
#tab-kinetics .kn-section-note { margin: 10px 0 0; }
#tab-kinetics .kn-gap { margin-top: 16px; }
#tab-kinetics .kn-results-note { margin-top: 10px; }
#tab-kinetics .kn-roi-row { --min: 200px; margin-bottom: 12px; }
#tab-kinetics .kn-frame-row { min-width: 0; align-self: end; }
@media (max-width: 640px) {
    #tab-kinetics .kn-table tbody th { min-width: 0; }
    #tab-kinetics .kn-table thead th { font-size: 0.62rem; letter-spacing: 0.02em; }
    #tab-kinetics .kn-table th, #tab-kinetics .kn-table td { font-size: 0.78rem; }
}
`;

    /* ---------- tab state ---------- */
    const T = {
        mounted: false, visible: false, dom: {},
        dirty: { explorer: true, statics: true, overtime: true, dynamic: true },
        ex: { tracer: 'FDG', region: 'gm_frontal', condition: 'normal', type: '2tci', p: { K1: 0.1, k2: 0.13, k3: 0.06, k4: 0, vb: 0.04 },
            loaded: null, logY: false, showRef: true, sliders: {}, raf: 0 },
        lastTracer: undefined, lastCondition: undefined,
        all: { busy: false, frac: 0, error: null, optsKey: null },
        dyn: { show: { target: true, reference: true, blood: false, extra: false }, units: 'conc', range: 'all', input: 'arterial',
            tStar: { patlak: 20 * MIN, logan: 30 * MIN }, useK2: true },
        cache: { long: null, meas: null, acqTacs: new WeakMap(), cp: {} },
        reconPending: false,
        roiSelects: [],
        renderQueued: false
    };

    /* ---------- small helpers ---------- */
    function K() { return PET.kinetics; }
    function A() { return PET.analysis; }
    function fmt(x, sig) { return isFinite(x) ? U.fmtNum(x, sig || 3) : '-'; }
    function fix(x, d) { return isFinite(x) ? x.toFixed(d) : '-'; }
    function pct(x) {
        if (!isFinite(x)) return '-';
        const v = 100 * x, a = Math.abs(v);
        const s = a < 9.95 ? a.toFixed(1) : a.toFixed(0);
        if (Number(s) === 0) return '0 %';
        return (v > 0 ? '+' : '−') + s + ' %';
    }
    function minutes(s) { return U.fmtNum(s / MIN, 3); }
    function span(t0, t1) {
        if (t1 <= 120) return U.fmtNum(Math.max(0, t0), 3) + ' to ' + U.fmtNum(t1, 3) + ' s';
        return minutes(Math.max(0, t0)) + ' to ' + minutes(t1) + ' min';
    }
    function currentProgram() {
        const s = PET.state || {};
        return s.program && s.program.ok ? s.program : (s.lastGoodProgram || null);
    }
    function phantomOf(acq) {
        if (!acq || !PET.phantoms) return null;
        try { return PET.phantoms.build(acq.phantomId, acq.phantomOpts); } catch (e) { return null; }
    }
    function currentPhantom() { try { return PET.actions.getPhantom(); } catch (e) { return null; } }
    function regionIndex(ph, id) {
        if (PET.phantoms && PET.phantoms.regionIndex) return PET.phantoms.regionIndex(ph, id);
        for (let i = 0; i < ph.regions.length; i++) if (ph.regions[i].id === id) return i;
        return -1;
    }
    function tracerInfo(id) { try { return id ? PET.tracers.get(id) : null; } catch (e) { return null; } }
    function tracerLabel(id) { const t = tracerInfo(id); return t ? t.label : (id || 'no tracer'); }
    function notify(msg, kind) { if (PET.app && PET.app.notify) PET.app.notify(msg, kind); }
    function svg(tag, attrs, children) {
        const e = doc.createElementNS(SVGNS, tag);
        Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]); });
        (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
        return e;
    }
    function trapz(t, v) { let s = 0; for (let i = 1; i < t.length; i++) s += (t[i] - t[i - 1]) * (v[i] + v[i - 1]) / 2; return s; }
    function maxOf(a) { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }

    /* ---------- ROI definitions ---------- */
    function roiDefs(ph) {
        if (!A() || !ph) return [];
        try { return A().roiDefs(ph); } catch (e) { return []; }
    }
    function findDef(ph, id) {
        const d = roiDefs(ph).find(function (x) { return x.id === id; });
        if (d) return d;
        const i = ph ? regionIndex(ph, id) : -1;
        return i >= 0 ? { id: id, name: ph.regions[i].name, regions: [id], reference: false } : null;
    }
    /* roiDefs offers some regions twice (the "Cerebellum" composite and the
       single "Cerebellar gray matter" region are the same pixels). Show one
       of each in the menus and map the other id onto it. */
    function uniqueDefs(ph) {
        const out = [], seen = {};
        roiDefs(ph).forEach(function (d) {
            const key = (d.circle ? 'c' + JSON.stringify(d.circle) : '') + d.regions.slice().sort().join('+');
            if (seen[key]) return;
            seen[key] = d.id;
            out.push(d);
        });
        return out;
    }
    function canonical(ph, id) {
        const d = findDef(ph, id);
        if (!d) return id;
        const key = (d.circle ? 'c' + JSON.stringify(d.circle) : '') + d.regions.slice().sort().join('+');
        const u = uniqueDefs(ph).find(function (x) { return ((x.circle ? 'c' + JSON.stringify(x.circle) : '') + x.regions.slice().sort().join('+')) === key; });
        return u ? u.id : id;
    }
    function defaultIds(ph) {
        const defs = roiDefs(ph), has = function (id) { return defs.some(function (d) { return d.id === id; }); };
        if (!defs.length) return { target: null, reference: null };
        if (ph.kind === 'brain') return { target: has('cortex') ? 'cortex' : defs[0].id, reference: has('cereb_gm') ? 'cereb_gm' : (has('cerebellum') ? 'cerebellum' : defs[0].id) };
        const kind = A().phantomKind ? A().phantomKind(ph) : ph.id;
        let target = null, reference = null;
        if (kind === 'spheres') {
            const bg = ph.regions[regionIndex(ph, 'background')], bgRel = bg ? bg.rel : 1;
            let best = null;
            defs.forEach(function (d) {
                const r = ph.regions[regionIndex(ph, d.regions[0])];
                if (r && d.regions.length === 1 && r.rel > bgRel && (!best || r.diameter > best.r.diameter)) best = { d: d, r: r };
            });
            target = best ? best.d.id : defs[0].id;
            reference = has('background') ? 'background' : null;
        } else if (kind === 'cylinder') { target = has('centre') ? 'centre' : defs[0].id; reference = has('whole') ? 'whole' : null; }
        else if (kind === 'rods') {
            const rods = defs.filter(function (d) { return /rod/i.test(d.id); });
            target = rods.length ? rods[rods.length - 1].id : defs[0].id;
            reference = has('background') ? 'background' : null;
        } else { target = defs[0].id; reference = defs.length > 1 ? defs[1].id : defs[0].id; }
        const ref = reference || (defs.find(function (d) { return d.reference && d.id !== target; }) || defs[defs.length - 1]).id;
        return { target: target, reference: ref };
    }
    function effectiveIds(ph) {
        const a = (PET.state && PET.state.analysis) || {}, defs = roiDefs(ph), dft = defaultIds(ph);
        const has = function (id) { return defs.some(function (d) { return d.id === id; }); };
        return { target: has(a.target) ? a.target : dft.target, reference: has(a.reference) ? a.reference : dft.reference };
    }
    /* Pixel-weighted mean of per-region values over an ROI's regions: the
       true mean an infinitely sharp, noise-free image would give. */
    function roiValue(ph, values, def) {
        if (!def || !values) return NaN;
        let s = 0, wsum = 0;
        def.regions.forEach(function (id) {
            const i = regionIndex(ph, id);
            if (i < 0) return;
            const p = ph.regions[i].pixels || 0;
            s += p * (values[i] || 0); wsum += p;
        });
        return wsum > 0 ? s / wsum : NaN;
    }
    function roiCurve(ph, tacs, def) {
        const n = tacs.t.length, out = new Float64Array(n);
        let wsum = 0;
        def.regions.forEach(function (id) {
            const i = regionIndex(ph, id);
            if (i < 0 || !tacs.regions[i]) return;
            const p = ph.regions[i].pixels || 0, c = tacs.regions[i];
            for (let k = 0; k < n; k++) out[k] += p * c[k];
            wsum += p;
        });
        if (wsum > 0) for (let k = 0; k < n; k++) out[k] /= wsum;
        return out;
    }
    /* Model quantities of an ROI, pixel-weighted over its regions.
       Concentrations add linearly, so the VT and Ki of a composite are
       the volume-weighted means of its parts; BPND is averaged the same
       way over the regions that have one. */
    function roiKinetics(tracer, cond, ph, def) {
        const out = { VT: NaN, VND: NaN, BPND: NaN, Ki: NaN, KiVoxel: NaN, flow: NaN, k2: NaN, model: null, blood: false, none: false };
        if (!K() || !def || !tracer) return out;
        let wAll = 0, vt = 0, wVt = 0, vnd = 0, wVnd = 0, bp = 0, wBp = 0, ki = 0, kiv = 0, wKi = 0, fl = 0, wFl = 0, k2 = 0, wK2 = 0;
        const models = {};
        def.regions.forEach(function (id) {
            const i = regionIndex(ph, id);
            if (i < 0) return;
            const r = ph.regions[i], p = r.pixels || 0;
            if (!p) return;
            wAll += p;
            let m = null;
            if (r.tissue === 'blood') { out.blood = true; vt += p; wVt += p; models.blood = (models.blood || 0) + p; return; }
            try { m = K().params(tracer, id, cond); } catch (e) { m = null; }
            if (!m) { out.none = true; wVt += p; models.none = (models.none || 0) + p; return; }
            models[m.model] = (models[m.model] || 0) + p;
            const d = K().derived(m);
            if (isFinite(d.VT)) { vt += p * d.VT; wVt += p; }
            else if (isFinite(d.Ki)) { /* trapped: no VT */ }
            if (isFinite(d.VND)) { vnd += p * d.VND; wVnd += p; }
            if (isFinite(d.BPND)) { bp += p * d.BPND; wBp += p; }
            if (isFinite(d.Ki)) { ki += p * d.Ki; kiv += p * d.KiVoxel; wKi += p; }
            if (isFinite(d.flow)) { fl += p * d.flow; wFl += p; }
            if (m.k2 > 0) { k2 += p * m.k2; wK2 += p; }
        });
        if (wVt > 0 && vt > 0) out.VT = vt / wVt;
        if (wVnd > 0) out.VND = vnd / wVnd;
        if (wBp > 0) out.BPND = bp / wBp;
        if (wKi > 0) { out.Ki = ki / wAll; out.KiVoxel = kiv / wAll; }
        if (wFl > 0) out.flow = fl / wFl;
        if (wK2 > 0) out.k2 = k2 / wK2;
        let best = null, bw = -1;
        Object.keys(models).forEach(function (k) { if (models[k] > bw) { bw = models[k]; best = k; } });
        out.model = best;
        return out;
    }

    /* Time (s) at which the specifically bound tracer of an ROI peaks, from
       the model on a fine grid up to tEnd. At that moment dC2/dt = 0, so
       C2/C1 = k3/k4 = BPND exactly: the "transient equilibrium" at which a
       ratio to a reference that tracks the free tracer equals the DVR.
       NaN when the ROI has no reversible binding. */
    const bindPeakCache = new Map();
    function bindingPeak(tracer, cond, ph, def, tEnd) {
        const key = [tracer, cond, ph.id, def.regions.join('+'), Math.round(tEnd)].join('|');
        if (bindPeakCache.has(key)) return bindPeakCache.get(key);
        let out = NaN;
        try {
            const inp = K().input(tracer), step = 5, n = Math.round(tEnd / step) + 1;
            const t = new Float64Array(n), cp = new Float64Array(n), c2 = new Float64Array(n);
            for (let i = 0; i < n; i++) { t[i] = i * step; cp[i] = inp.cp(t[i]); }
            let any = false;
            def.regions.forEach(function (id) {
                const i = regionIndex(ph, id);
                if (i < 0) return;
                const m = K().params(tracer, id, cond);
                if (!m || m.model !== '2tcr' || !(m.k3 > 0) || !(m.k4 > 0)) return;
                const r = K().tissue(m, cp, t), wgt = (ph.regions[i].pixels || 0) * (1 - (m.vb || 0));
                for (let k = 0; k < n; k++) c2[k] += wgt * r.c2[k];
                any = true;
            });
            if (any) {
                let ip = 0; for (let k = 1; k < n; k++) if (c2[k] > c2[ip]) ip = k;
                out = ip >= n - 2 ? Infinity : t[ip];
            }
        } catch (e) { out = NaN; }
        bindPeakCache.set(key, out);
        return out;
    }

    /* ---------- long true curves for SUVR over time ----------
       The protocol's own curves stop at the end of the scan; the ratio is
       more telling over two hours, so the same model is run further. */
    function longCurves(ph, prog) {
        const c = T.cache.long;
        if (c && c.ph === ph && c.prog === prog) return c.data;
        const water = /water/i.test(String(prog.tracer || ''));
        const end = water ? Math.max(6 * MIN, 1.5 * (prog.scanEnd || 0)) : Math.max(120 * MIN, (prog.scanEnd || 0) + 15 * MIN);
        const p2 = Object.assign({}, prog, { scanEnd: end, frames: (prog.frames || []).concat([{ t0: end - 1, t1: end }]) });
        const data = K().regionTACs(ph, p2, { dt: end > 1800 ? 5 : 1, condition: ph.condition || 'normal' });
        T.cache.long = { ph: ph, prog: prog, data: data };
        return data;
    }
    /* The window a static ratio is read over: the scan of a static
       protocol, or the late frames (about the last 20 min) of a dynamic one. */
    function scanWindow(prog) {
        const fr = prog.frames || [];
        if (!fr.length) return null;
        if (!prog.dynamic) return { t0: Math.max(0, prog.scanStart), t1: prog.scanEnd, label: 'scan window' };
        const end = fr[fr.length - 1].t1, need = Math.min(20 * MIN, (end - Math.max(0, fr[0].t0)) / 3);
        let k = fr.length - 1;
        while (k > 0 && end - fr[k].t0 < need - 1e-6) k--;
        return { t0: Math.max(0, fr[k].t0), t1: end, label: 'late frames', k0: k };
    }
    /* True curves of the acquisition's phantom and protocol (cached). */
    function acqTACs(acq, ph) {
        if (T.cache.acqTacs.has(acq)) return T.cache.acqTacs.get(acq);
        let tacs = null;
        try {
            const st = PET.state;
            if (acq.program === currentProgram() && st.phantomId === acq.phantomId && PET.actions.getPhantom() === ph) tacs = PET.actions.getTACs();
        } catch (e) { tacs = null; }
        if (!tacs) tacs = K().regionTACs(ph, acq.program, { dt: 2, condition: ph.condition || 'normal' });
        T.cache.acqTacs.set(acq, tacs);
        return tacs;
    }

    /* One-tissue model fit (water): for each k2 the model is linear in
       a = (1 - vb) K1 and vb, so solve those by least squares and search
       k2 on a log grid, then refine by golden section. The model curve is
       frame-averaged with decay weighting, like the decay-corrected
       frames it is compared with. */
    function fit1TC(frames, ct, input, isotope) {
        const n = frames.length;
        const fm = function (curve) { return K().frameMeans({ t: input.t, dt: input.dt, isotope: isotope, regions: [curve] }, frames).map(function (v) { return v[0]; }); };
        const cpF = fm(input.cp);
        function evalK2(k2) {
            const e = K().tissue({ model: '1tc', K1: 1, k2: k2, k3: 0, k4: 0, vb: 0 }, input.cp, input.t).c1;
            const eF = fm(e);
            let sxx = 0, sxy = 0, syy = 0, sxc = 0, syc = 0;
            for (let i = 0; i < n; i++) {
                if (!isFinite(ct[i])) continue;
                sxx += eF[i] * eF[i]; sxy += eF[i] * cpF[i]; syy += cpF[i] * cpF[i]; sxc += eF[i] * ct[i]; syc += cpF[i] * ct[i];
            }
            const det = sxx * syy - sxy * sxy;
            let a, b;
            if (Math.abs(det) < 1e-30 * (sxx * syy || 1)) { a = sxx > 0 ? sxc / sxx : 0; b = 0; }
            else { a = (sxc * syy - syc * sxy) / det; b = (sxx * syc - sxy * sxc) / det; }
            if (b < 0) { b = 0; a = sxx > 0 ? sxc / sxx : 0; }
            if (b > 0.9) b = 0.9;
            let sse = 0;
            for (let i = 0; i < n; i++) { if (!isFinite(ct[i])) continue; const r = ct[i] - a * eF[i] - b * cpF[i]; sse += r * r; }
            return { sse: sse, a: a, b: b, k2: k2 };
        }
        const R = 200, N = 48;
        let best = null;
        for (let i = 0; i <= N; i++) { const r = evalK2(0.02 * Math.pow(R, i / N)); if (!best || r.sse < best.sse) best = r; }
        let lo = best.k2 / Math.pow(R, 1 / N), hi = best.k2 * Math.pow(R, 1 / N);
        for (let it = 0; it < 30; it++) {
            const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
            if (evalK2(m1).sse < evalK2(m2).sse) hi = m2; else lo = m1;
        }
        const r = evalK2((lo + hi) / 2);
        const K1 = r.a / (1 - r.b);
        return { K1: K1, k2: r.k2, vb: r.b, VT: r.k2 > 0 ? K1 / r.k2 : NaN };
    }

    /* ============================================================
       1. Concept card
       ============================================================ */
    function buildConcept() {
        return w().concept({
            title: 'Tracer kinetics and what PET numbers mean',
            body: '<p>A PET image is a snapshot of a race between delivery, binding (or trapping) and washout. ' +
                'Compartment models describe it with a few rate constants: K<sub>1</sub> carries tracer from plasma into tissue, ' +
                'k<sub>2</sub> carries it back, k<sub>3</sub> binds or traps it, k<sub>4</sub> releases it. ' +
                'What we want to know are combinations of these: the distribution volume V<sub>T</sub> and binding potential ' +
                'BP<sub>ND</sub> of a reversible tracer, or the net influx K<sub>i</sub> of a trapped one such as FDG.</p>' +
                '<p>A single static frame gives SUV (concentration per injected dose per gram) and SUVR (target over a reference ' +
                'region with no specific binding). SUVR estimates the distribution volume ratio DVR = 1 + BP<sub>ND</sub> only when the ' +
                'tissue is at equilibrium with plasma, which a static scan never quite is. Dynamic imaging measures the whole curve ' +
                'and can recover the binding itself.</p>',
            formula: '<div class="kn-formula-lines">' +
                '<div>dC<sub>1</sub>/dt = K<sub>1</sub>C<sub>p</sub> − (k<sub>2</sub> + k<sub>3</sub>) C<sub>1</sub> + k<sub>4</sub>C<sub>2</sub></div>' +
                '<div>dC<sub>2</sub>/dt = k<sub>3</sub>C<sub>1</sub> − k<sub>4</sub>C<sub>2</sub></div>' +
                '<div class="kn-fl-small">V<sub>T</sub> = (K<sub>1</sub>/k<sub>2</sub>)(1 + k<sub>3</sub>/k<sub>4</sub>), ' +
                'BP<sub>ND</sub> = k<sub>3</sub>/k<sub>4</sub>, K<sub>i</sub> = K<sub>1</sub>k<sub>3</sub>/(k<sub>2</sub> + k<sub>3</sub>)</div>' +
                '<div class="kn-fl-small">SUV = C / (dose / weight), SUVR = C<sub>target</sub> / C<sub>reference</sub> ≈ DVR = 1 + BP<sub>ND</sub> (only at equilibrium)</div>' +
                '</div>',
            tryThis: [
                { html: 'Load the <strong>PiB scan of an Alzheimer brain</strong> and compare the frontal cortex SUVR with the true DVR of 2.5.',
                    label: 'Load PiB (AD)', run: function () { loadPresetWith('pib_static', { target: 'gm_frontal', reference: 'cereb_gm' }); } },
                { html: 'Pick <strong>frontal cortex as the reference</strong> region, a region full of plaques, and watch the ratio collapse.',
                    label: 'Wrong reference', run: function () { PET.actions.setAnalysis({ reference: 'gm_frontal' }); scrollTo('statics'); } },
                { html: 'Load the <strong>dynamic FDG</strong> study, reconstruct every frame and read K<sub>i</sub> off the Patlak plot.',
                    label: 'Load FDG dynamic', run: function () { loadPresetWith('fdg_dynamic', { target: 'cortex', reference: 'cereb_gm' }); scrollTo('dynamic'); } },
                { html: 'In the model explorer, <strong>set k<sub>4</sub> to 0</strong>: a reversible binder becomes a trap and K<sub>i</sub> replaces BP<sub>ND</sub>.',
                    label: 'k4 = 0', run: function () {
                        if (!(T.ex.type === '2tcr' && T.ex.p.k4 > 0)) { T.ex.tracer = 'PiB'; T.ex.region = 'gm_frontal'; T.ex.condition = 'ad'; exLoad(); }
                        exTry('k4'); scrollTo('explorer');
                    } }
            ]
        });
    }
    function loadPresetWith(id, analysis) {
        if (!PET.actions || !PET.actions.loadPreset) return;
        if (PET.actions.loadPreset(id) === false) return;
        if (analysis) PET.actions.setAnalysis(analysis);
    }
    function scrollTo(part) {
        const node = T.dom[part + 'Panel'];
        if (node && node.scrollIntoView) { try { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { node.scrollIntoView(); } }
    }

    /* ============================================================
       2. Compartment model explorer
       ============================================================ */
    const EX_SLIDERS = [
        { key: 'K1', label: 'K₁, influx', min: 0, max: 1, step: 0.001, unit: 'mL/min/mL', hint: 'Transport from plasma into tissue, per mL of tissue per minute' },
        { key: 'k2', label: 'k₂, efflux', min: 0, max: 1, step: 0.001, unit: '/min', hint: 'Fraction of the free tracer that returns to the blood each minute' },
        { key: 'k3', label: 'k₃, binding or trapping', min: 0, max: 0.6, step: 0.001, unit: '/min', hint: 'Rate at which free tracer binds its target (or is phosphorylated and trapped, for FDG)' },
        { key: 'k4', label: 'k₄, release', min: 0, max: 0.3, step: 0.001, unit: '/min', hint: 'Rate at which bound tracer comes off its target; 0 means trapped' },
        { key: 'vb', label: 'vb, blood volume', min: 0, max: 0.2, step: 0.005, unit: '%', scale: 100, hint: 'Fraction of each voxel that is blood (it carries the plasma concentration)' }
    ];
    const EX_TIME = (function () {
        const n = Math.round(EX_END / EX_STEP) + 1, t = new Float64Array(n);
        for (let i = 0; i < n; i++) t[i] = i * EX_STEP;
        return t;
    })();
    const EX_MIN = Float64Array.from(EX_TIME, function (v) { return v / MIN; });

    function brainRegionList() {
        try {
            const ph = PET.phantoms.build('brain', { condition: 'normal' });
            return ph.regions.filter(function (r) { return ['gm', 'wm', 'soft'].indexOf(r.tissue) >= 0; }).map(function (r) { return { id: r.id, name: r.name }; });
        } catch (e) {
            return Object.keys((K() && K().regionClass) || {}).filter(function (id) { return id !== 'sinus'; }).map(function (id) { return { id: id, name: id }; });
        }
    }
    function exRegionOptions() {
        return brainRegionList().filter(function (r) {
            try { const m = K().params(T.ex.tracer, r.id, T.ex.condition); return m && m.model !== 'blood'; } catch (e) { return false; }
        }).map(function (r) { return { value: r.id, label: r.name }; });
    }
    function exLoad() {
        let m = null;
        try { m = K().params(T.ex.tracer, T.ex.region, T.ex.condition); } catch (e) { m = null; }
        if (!m || m.model === 'blood') {
            const opts = exRegionOptions();
            if (opts.length) { T.ex.region = opts[0].value; m = K().params(T.ex.tracer, T.ex.region, T.ex.condition); }
        }
        if (!m) return;
        T.ex.type = m.model;
        T.ex.p = { K1: m.K1, k2: m.k2, k3: m.k3 || 0, k4: m.k4 || 0, vb: m.vb || 0 };
        T.ex.loaded = { type: m.model, p: Object.assign({}, T.ex.p) };
        exSyncControls();
    }
    function exModel() {
        const p = T.ex.p, ty = T.ex.type;
        return { model: ty, K1: p.K1, k2: p.k2, k3: ty === '1tc' ? 0 : p.k3, k4: ty === '2tcr' ? p.k4 : 0, vb: p.vb };
    }
    function exInput() {
        const id = T.ex.tracer;
        if (!T.cache.cp[id]) {
            const inp = K().input(id), cp = new Float64Array(EX_TIME.length);
            for (let i = 0; i < cp.length; i++) cp[i] = inp.cp(EX_TIME[i]);
            T.cache.cp[id] = cp;
        }
        return T.cache.cp[id];
    }
    function exSyncControls() {
        const D = T.dom;
        if (!D.exTracer) return;
        D.exTracer.set(T.ex.tracer);
        D.exRegion.setOptions(exRegionOptions(), T.ex.region);
        D.exCond.set(T.ex.condition);
        D.exType.set(T.ex.type);
        EX_SLIDERS.forEach(function (s) { const sl = T.ex.sliders[s.key]; if (sl) sl.set(T.ex.p[s.key]); });
        const ty = T.ex.type;
        T.ex.sliders.k3.setDisabled(ty === '1tc');
        T.ex.sliders.k4.setDisabled(ty !== '2tcr');
        exRenderTry();
    }
    function exSetType(ty) {
        T.ex.type = ty;
        const p = T.ex.p;
        if (ty !== '1tc' && !(p.k3 > 0)) p.k3 = T.ex.tracer === 'FDG' ? 0.06 : 0.1;
        if (ty === '2tcr' && !(p.k4 > 0)) p.k4 = T.ex.tracer === 'FDG' ? 0.007 : 0.05;
        exSyncControls();
        exSchedule();
    }
    function exTry(which) {
        const p = T.ex.p;
        if (which === 'k4') {
            if (T.ex.type === '2tcr' && p.k4 > 0) p.k4 = 0;
            else { T.ex.type = '2tcr'; if (!(p.k3 > 0)) p.k3 = 0.1; p.k4 = T.ex.tracer === 'FDG' ? 0.007 : 0.05; }
        } else if (which === 'k3') {
            if (T.ex.type === '1tc') T.ex.type = '2tci';
            p.k3 = Math.min(0.6, (p.k3 > 0 ? p.k3 : 0.05) * 2);
        } else if (which === 'K1') {
            p.K1 = p.K1 / 2;
        }
        exSyncControls();
        exSchedule();
    }
    /* The "try this" list follows the model: a reversible binder is offered
       k4 = 0, a trapped tracer a small k4 instead. */
    function exRenderTry() {
        const host = T.dom.exTry;
        if (!host) return;
        const ty = T.ex.type, p = T.ex.p, fdg = T.ex.tracer === 'FDG';
        const items = [];
        if (ty === '2tcr' && p.k4 > 0) items.push(['Set k₄ to 0: the bound pool becomes a trap, C₂ only rises, and K<sub>i</sub> replaces BP<sub>ND</sub> and DVR.', 'k4 = 0', 'k4']);
        else items.push([fdg ? 'Give FDG-6-phosphate a small k₄ (slow dephosphorylation, 0.007 /min): C₂ levels off late, and BP<sub>ND</sub> and V<sub>T</sub> become defined.'
            : 'Give the bound pool a release rate k₄: the trap becomes reversible binding, C₂ levels off, and BP<sub>ND</sub> and DVR replace K<sub>i</sub>.', fdg ? 'k4 = 0.007' : 'k4 = 0.05', 'k4']);
        items.push([ty === '2tcr' && p.k4 > 0 ? 'Double k₃ and watch the bound pool fill faster and further: BP<sub>ND</sub> and V<sub>T</sub> double, K₁ does not change.'
            : 'Double k₃: more tracer is trapped and K<sub>i</sub> = K₁k₃/(k₂ + k₃) rises, but by less than double, because delivery K₁ caps it.', 'k3 × 2', 'k3']);
        items.push([ty === '2tcr' && p.k4 > 0 ? 'Halve K₁ to mimic reduced delivery (less flow or a tighter blood-brain barrier): every curve drops, yet BP<sub>ND</sub> = k₃/k₄ stays the same.'
            : 'Halve K₁ to mimic reduced delivery: every curve drops and K<sub>i</sub> halves, because for a trapped tracer delivery is part of the measurement.', 'K1 ÷ 2', 'K1']);
        const key = items.map(function (it) { return it[1]; }).join('|') + ty;
        if (host.__key === key) return;
        host.__key = key;
        host.textContent = '';
        items.forEach(function (it) {
            host.appendChild(el('li', {}, [el('span', { html: it[0] }), ' ',
                w().button({ label: it[1], size: 'xs', onClick: function () { exTry(it[2]); } })]));
        });
    }
    function exReset() {
        if (!T.ex.loaded) return;
        T.ex.type = T.ex.loaded.type;
        T.ex.p = Object.assign({}, T.ex.loaded.p);
        exSyncControls();
        exSchedule();
    }
    function exSchedule() {
        if (T.ex.raf) return;
        T.ex.raf = (root.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { T.ex.raf = 0; exRender(); });
    }

    function buildExplorer() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'kn-ex-title' });
        T.dom.explorerPanel = panel;
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'kn-ex-title', text: 'Compartment model explorer' }),
            el('span', { class: 'panel-sub', text: 'no scan needed: drag a rate constant and watch the curves' })
        ]));
        if (!K()) { panel.appendChild(w().errorCard('The kinetics module (js/kinetics.js) did not load', null)); return panel; }

        const tracers = (PET.tracers ? PET.tracers.list() : []).filter(function (t) { return K().table && K().table[t.id]; });
        T.dom.exTracer = w().select({ label: 'Tracer', options: tracers.map(function (t) { return { value: t.id, label: t.label, title: t.name + ': ' + t.target }; }),
            value: T.ex.tracer, onChange: function (v) { T.ex.tracer = v; T.ex.region = EX_REGION[v] || T.ex.region; exLoad(); exSchedule(); } });
        T.dom.exRegion = w().select({ label: 'Load parameters of', options: exRegionOptions(), value: T.ex.region,
            onChange: function (v) { T.ex.region = v; exLoad(); exSchedule(); } });
        T.dom.exCond = w().select({ label: 'Condition', options: (K().conditions || []).map(function (c) { return { value: c.id, label: c.name }; }),
            value: T.ex.condition, onChange: function (v) { T.ex.condition = v; exLoad(); exSchedule(); } });
        T.dom.exType = w().segmented({ label: 'Model type', value: T.ex.type, size: 'sm',
            options: [{ value: '1tc', label: '1TC', title: 'One tissue compartment (K1, k2)' },
                { value: '2tci', label: '2TC irreversible', title: 'Two tissue compartments, trapping (k4 = 0)' },
                { value: '2tcr', label: '2TC reversible', title: 'Two tissue compartments, reversible binding' }],
            onChange: exSetType });
        panel.appendChild(el('div', { class: 'controls kn-controls' }, [T.dom.exTracer, T.dom.exRegion, T.dom.exCond]));
        panel.appendChild(el('div', { class: 'kn-model-row' }, [T.dom.exType]));

        const main = el('div', { class: 'kn-figure' });
        T.dom.exDiagram = el('div', { class: 'kn-diagram' });
        main.appendChild(T.dom.exDiagram);
        T.dom.exPlot = w().plot(main, { height: 270, xlabel: 'Time after injection (min)', ylabel: 'Concentration (SUV)', framed: true,
            title: 'Plasma, compartments and the voxel total' });
        const logT = w().toggle({ label: 'Log scale', checked: T.ex.logY, hint: 'A logarithmic concentration axis shows washout as straight lines',
            onChange: function (b) { T.ex.logY = b; exSchedule(); } });
        const refT = w().toggle({ label: 'Reference region curve', checked: T.ex.showRef,
            hint: 'The voxel curve of cerebellar gray matter for the same tracer and condition',
            onChange: function (b) { T.ex.showRef = b; exSchedule(); } });
        main.appendChild(el('div', { class: 'kn-plot-tools' }, [logT, refT,
            (T.dom.exNote = el('span', { class: 'note' }))]));

        const side = el('div', { class: 'kn-side' });
        const sl = el('div', { class: 'kn-sliders' });
        EX_SLIDERS.forEach(function (s) {
            const ctl = w().slider({ label: s.label, min: s.min, max: s.max, step: s.step, value: T.ex.p[s.key], unit: s.unit,
                scale: s.scale || 1, hint: s.hint,
                onInput: function (v) { T.ex.p[s.key] = v; exSchedule(); if (s.key === 'k4') exRenderTry(); } });
            T.ex.sliders[s.key] = ctl;
            sl.appendChild(ctl);
        });
        side.appendChild(sl);
        side.appendChild(el('div', { class: 'row' }, [
            w().button({ label: 'Reset to the loaded values', size: 'sm', onClick: exReset, title: 'Put the sliders back to the table values of the tracer, region and condition' })
        ]));
        side.appendChild(el('div', {}, [el('div', { class: 'kn-subhead', text: 'Derived values' }),
            (T.dom.exTable = w().statTable([], { compact: true }))]));
        T.dom.exTry = el('ol', { class: 'kn-try' });
        side.appendChild(el('div', {}, [el('div', { class: 'kn-subhead', text: 'Try this' }), T.dom.exTry]));

        panel.appendChild(el('div', { class: 'split' }, [main, side]));
        panel.appendChild(el('p', { class: 'simplification', text: 'Honest simplifications: the input is the parent tracer in plasma with no labelled metabolites, plasma equals whole blood, and every region is one well-mixed compartment pair. Parameters are rounded teaching values with literature-like orders of magnitude.' }));
        return panel;
    }

    function exRender() {
        if (!T.dom.exPlot || !K()) return;
        try {
            const m = exModel(), cp = exInput();
            const r = K().tissue(m, cp, EX_TIME);
            let ref = null;
            if (T.ex.showRef) {
                const mr = K().params(T.ex.tracer, 'cereb_gm', T.ex.condition);
                if (mr && !(T.ex.region === 'cereb_gm')) ref = K().tissue(mr, cp, EX_TIME).ct;
            }
            const fdg = T.ex.tracer === 'FDG';
            const c2Label = m.model === '1tc' ? null : (m.k4 > 0 ? 'C₂ bound' : (fdg ? 'C₂ trapped (FDG-6-phosphate)' : 'C₂ trapped'));
            const logY = T.ex.logY;
            let peak = 0;
            [r.cp, r.ct].forEach(function (a) { peak = Math.max(peak, maxOf(a)); });
            const floor = peak > 0 ? peak * 1e-4 : 1e-6;
            const tr = function (a) { if (!logY) return a; return Float64Array.from(a, function (v) { return v > floor ? Math.log10(v) : NaN; }); };
            const series = [
                { x: EX_MIN, y: tr(r.cp), color: 'var(--c8)', label: 'Cp plasma', width: 1.5 },
                { x: EX_MIN, y: tr(r.c1), color: 'var(--c1)', label: fdg ? 'C₁ free FDG' : 'C₁ free + nonspecific', width: 1.75 },
                c2Label ? { x: EX_MIN, y: tr(r.c2), color: 'var(--c2)', label: c2Label, width: 1.75 } : null,
                { x: EX_MIN, y: tr(r.ct), color: 'var(--fg)', label: 'Ct voxel total (what PET sees)', width: 2.6 },
                ref ? { x: EX_MIN, y: tr(ref), color: 'var(--c7)', label: 'Ct reference (cerebellar GM)', width: 1.75, dash: true } : null
            ].filter(Boolean);
            const opts = { xlim: [0, EX_END / MIN] };
            const prog = currentProgram();
            if (prog && prog.tracer && K().table && String(prog.tracer) === T.ex.tracer && prog.frames && prog.frames.length) {
                const win = scanWindow(prog);
                if (win) opts.markers = [{ x: win.t0 / MIN, label: 'scan', color: 'var(--muted)' }, { x: win.t1 / MIN, color: 'var(--muted)' }];
            }
            if (logY) {
                const top = Math.ceil(Math.log10(peak || 1) + 0.05);
                opts.ylim = [top - 3, top];
                opts.yfmt = function (v) { return U.fmtNum(Math.pow(10, v), 2); };
            } else {
                // Linear axis: scale to the tissue curves and let the plasma bolus run off the top,
                // otherwise a 20 SUV spike flattens everything else.
                let top = Math.max(maxOf(r.ct), maxOf(r.c1), maxOf(r.c2), ref ? maxOf(ref) : 0);
                for (let i = 0; i < r.cp.length; i++) if (EX_TIME[i] > 3 * MIN && r.cp[i] > top) top = r.cp[i];
                const cpPeak = maxOf(r.cp);
                opts.ylim = [0, top * 1.12 || 1];
                T.dom.exNote.textContent = cpPeak > top * 1.12 ? 'The plasma bolus (peak ' + fmt(cpPeak, 2) + ' SUV) runs off the top; the log scale shows all of it. ' : '';
            }
            if (logY) T.dom.exNote.textContent = '';
            T.dom.exNote.textContent += 'SUV units, decay corrected; C₁ and C₂ per mL of tissue.';
            T.dom.exPlot.draw(series, opts);
            exDrawDiagram(m);
            // derived values
            const d = K().derived(m);
            let ip = 0; for (let i = 1; i < r.ct.length; i++) if (r.ct[i] > r.ct[ip]) ip = i;
            const i60 = Math.round(60 * MIN / EX_STEP);
            const dash = { value: 'not defined', kind: 'muted' };
            const row = function (label, v, unit, hint, digits) { return isFinite(v) ? { label: label, value: fmt(v, digits || 3), unit: unit, hint: hint } : Object.assign({ label: label, hint: hint }, dash); };
            T.dom.exTable.update([
                row('VND = K₁/k₂', d.VND, 'mL/mL', 'Nondisplaceable distribution volume: free plus nonspecifically bound tracer per mL of plasma, at equilibrium'),
                row('BPND = k₃/k₄', d.BPND, '', 'Binding potential: specifically bound over nondisplaceable tracer at equilibrium (reversible models only)'),
                row('VT = VND (1 + BPND)', d.VT, 'mL/mL', 'Total distribution volume: tissue over plasma concentration at equilibrium'),
                row('DVR = 1 + BPND', d.DVR, '', 'Distribution volume ratio to a reference region with the same VND and no binding: what SUVR hopes to estimate'),
                row('Ki = K₁k₃/(k₂ + k₃)', d.Ki, 'mL/min/mL', 'Net influx rate of a trapped tracer, per mL of tissue', 3),
                row('Ki of the voxel, (1 − vb) Ki', d.KiVoxel, 'mL/min/mL', 'What a Patlak plot of image data measures: the blood in the voxel traps nothing', 3),
                row('Flow = K₁ (1TC, water)', d.flow, 'mL/min/mL', 'For a freely diffusible tracer such as water, K1 is the blood flow'),
                { label: 'Ct at 60 min', value: fmt(r.ct[i60], 3), unit: 'SUV', hint: 'Voxel concentration 60 min after injection' },
                { label: 'Ct peaks at', value: ip >= r.ct.length - 1 ? 'still rising at 120' : fmt(EX_TIME[ip] / MIN, 3), unit: 'min' }
            ]);
        } catch (e) {
            if (root.console) root.console.error('[kinetics tab] explorer failed:', e);
        }
    }

    /* The compartment diagram: plasma, C1 and C2, arrows whose width
       follows the rate constant, and the voxel with its blood fraction.
       Horizontal on wide screens, stacked on narrow ones. */
    function exDrawDiagram(m) {
        const host = T.dom.exDiagram;
        if (!host) return;
        const vertical = (host.clientWidth || 600) < 520;
        host.classList.toggle('is-vertical', vertical);
        const fdg = T.ex.tracer === 'FDG', water = T.ex.tracer === 'water';
        const has2 = m.model !== '1tc';
        const kw = function (v) { return v > 0 ? 1.4 + 10 * Math.sqrt(Math.min(v, 1)) : 0; };
        const boxW = 150, boxH = 92;
        let W, H, P, C1, C2, vox;
        if (!vertical) {
            W = 640; H = 262;
            P = { x: 14, y: 70 }; C1 = { x: 256, y: 70 }; C2 = { x: 476, y: 70 };
            vox = { x: 224, y: 16, w: 410, h: 236 };
        } else {
            W = 340; H = 566;
            P = { x: 95, y: 14 }; C1 = { x: 95, y: 236 }; C2 = { x: 95, y: 414 };
            vox = { x: 18, y: 200, w: 304, h: 356 };
        }
        const s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
            'aria-label': 'Compartment diagram: K1 ' + fix(m.K1, 3) + ', k2 ' + fix(m.k2, 3) + (has2 ? ', k3 ' + fix(m.k3, 3) + ', k4 ' + fix(m.k4, 3) : '') + ' per minute, blood volume ' + fix(100 * m.vb, 1) + ' percent' });
        s.appendChild(svg('rect', { class: 'kn-voxel', x: vox.x, y: vox.y, width: vox.w, height: vox.h, rx: 14 }));
        s.appendChild(svg('text', { class: 'kn-svg-note', x: vox.x + 12, y: vox.y + 18 }, [vertical ? 'one voxel' : 'one voxel of tissue']));

        function box(pos, cls, title, sym, sub, subsym) {
            const g = svg('g', {});
            g.appendChild(svg('rect', { class: cls, x: pos.x, y: pos.y, width: boxW, height: boxH, rx: 10 }));
            g.appendChild(svg('text', { class: 'kn-svg-title', x: pos.x + boxW / 2, y: pos.y + 24, 'text-anchor': 'middle' }, [title]));
            const t = svg('text', { class: 'kn-svg-sym', x: pos.x + boxW / 2, y: pos.y + 50, 'text-anchor': 'middle' }, [sym]);
            t.appendChild(svg('tspan', { 'font-size': '12', dy: '4' }, [subsym]));
            g.appendChild(t);
            g.appendChild(svg('text', { class: 'kn-svg-sub', x: pos.x + boxW / 2, y: pos.y + 72, 'text-anchor': 'middle' }, [sub]));
            s.appendChild(g);
        }
        box(P, 'kn-box-plasma', 'Plasma', 'C', 'arterial blood', 'p');
        box(C1, 'kn-box-c1', fdg ? 'Free FDG' : (water ? 'Tissue water' : 'Free + nonspecific'), 'C', fdg ? 'not yet phosphorylated' : 'nondisplaceable', '1');
        if (has2) box(C2, 'kn-box-c2', m.k4 > 0 ? 'Specifically bound' : (fdg ? 'Trapped' : 'Trapped (k₄ = 0)'), 'C', m.k4 > 0 ? (T.ex.tracer === 'FDG' ? 'slowly released' : 'on its target') : (fdg ? 'FDG-6-phosphate' : 'cannot leave'), '2');
        else box(C2, 'kn-box-off', 'No second pool', 'C', 'not in a 1TC model', '2');

        function arrow(x1, y1, x2, y2, width, cls) {
            if (!(width > 0)) {
                s.appendChild(svg('line', { class: 'kn-arrow-zero', x1: x1, y1: y1, x2: x2, y2: y2 }));
                return;
            }
            const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
            const hl = 9 + 1.3 * width, hw = 4.5 + 0.85 * width;
            const bx = x2 - ux * hl, by = y2 - uy * hl;
            s.appendChild(svg('line', { class: cls, x1: x1, y1: y1, x2: bx + ux * 0.5, y2: by + uy * 0.5, 'stroke-width': width, 'stroke-linecap': 'butt' }));
            s.appendChild(svg('path', { class: cls, d: 'M' + x2 + ',' + y2 + ' L' + (bx - uy * hw) + ',' + (by + ux * hw) + ' L' + (bx + uy * hw) + ',' + (by - ux * hw) + ' Z', 'stroke-width': 0.5 }));
        }
        function label(x, y, text, cls, anchor) {
            s.appendChild(svg('text', { class: 'kn-svg-k ' + cls, x: x, y: y, 'text-anchor': anchor || 'middle' }, [text]));
        }
        const kv = function (name, v) { return name + ' ' + (v > 0 ? fix(v, 3) : '0'); };
        if (!vertical) {
            // plasma <-> C1
            const xa = P.x + boxW + 6, xb = C1.x - 6;
            arrow(xa, P.y + 30, xb, P.y + 30, kw(m.K1), 'kn-arrow-tr');
            arrow(xb, P.y + 64, xa, P.y + 64, kw(m.k2), 'kn-arrow-tr');
            label((xa + xb) / 2, P.y + 30 - kw(m.K1) / 2 - 10, kv('K₁', m.K1), 'tr');
            label((xa + xb) / 2, P.y + 64 + kw(m.k2) / 2 + 20, kv('k₂', m.k2), 'tr');
            // C1 <-> C2
            const xc = C1.x + boxW + 6, xd = C2.x - 6;
            if (has2) {
                arrow(xc, C1.y + 30, xd, C1.y + 30, kw(m.k3), 'kn-arrow-bd');
                arrow(xd, C1.y + 64, xc, C1.y + 64, kw(m.k4), 'kn-arrow-bd');
                label((xc + xd) / 2, C1.y + 30 - kw(m.k3) / 2 - 10, kv('k₃', m.k3), 'bd');
                label((xc + xd) / 2, C1.y + 64 + kw(m.k4) / 2 + 20, kv('k₄', m.k4), m.k4 > 0 ? 'bd' : 'off');
            }
        } else {
            const ya = P.y + boxH + 6, yb = C1.y - 6;
            arrow(P.x + 50, ya, P.x + 50, yb, kw(m.K1), 'kn-arrow-tr');
            arrow(P.x + 100, yb, P.x + 100, ya, kw(m.k2), 'kn-arrow-tr');
            label(P.x + 50 - kw(m.K1) / 2 - 8, (ya + yb) / 2 + 4, kv('K₁', m.K1), 'tr', 'end');
            label(P.x + 100 + kw(m.k2) / 2 + 8, (ya + yb) / 2 + 4, kv('k₂', m.k2), 'tr', 'start');
            if (has2) {
                const yc = C1.y + boxH + 6, yd = C2.y - 6;
                arrow(C1.x + 50, yc, C1.x + 50, yd, kw(m.k3), 'kn-arrow-bd');
                arrow(C1.x + 100, yd, C1.x + 100, yc, kw(m.k4), 'kn-arrow-bd');
                label(C1.x + 50 - kw(m.k3) / 2 - 8, (yc + yd) / 2 + 4, kv('k₃', m.k3), 'bd', 'end');
                label(C1.x + 100 + kw(m.k4) / 2 + 8, (yc + yd) / 2 + 4, kv('k₄', m.k4), m.k4 > 0 ? 'bd' : 'off', 'start');
            }
        }
        // the voxel's make-up: (1 - vb) tissue and vb blood
        const barX = vox.x + 14, barW = vox.w - 28, barY = vox.y + vox.h - 22, barH = 8;
        const bw = Math.max(m.vb > 0 ? 2 : 0, barW * Math.min(1, m.vb));
        s.appendChild(svg('rect', { class: 'kn-vb-tissue', x: barX, y: barY, width: barW, height: barH, rx: 3 }));
        if (bw > 0) s.appendChild(svg('rect', { class: 'kn-vb-blood', x: barX, y: barY, width: bw, height: barH, rx: 2 }));
        s.appendChild(svg('text', { class: 'kn-svg-note', x: barX, y: barY - 6 }, [
            'voxel = ' + fix(100 * (1 - m.vb), 1) + ' % tissue + ' + fix(100 * m.vb, 1) + ' % blood (vb)']));
        host.textContent = '';
        host.appendChild(s);
    }

    /* ============================================================
       3. Static quantification
       ============================================================ */
    function makeRoiSelects() {
        const t = w().select({ label: 'Target region', options: [], onChange: function (v) { PET.actions.setAnalysis({ target: v }); } });
        const r = w().select({ label: 'Reference region', options: [], hint: 'A region without specific binding: the usual choice is cerebellar gray matter',
            onChange: function (v) { PET.actions.setAnalysis({ reference: v }); } });
        const pair = { t: t, r: r, key: null };
        T.roiSelects.push(pair);
        return pair;
    }
    function refreshRoiSelects(ph) {
        if (!ph) return;
        const defs = uniqueDefs(ph), brain = ph.kind === 'brain', ids = effectiveIds(ph);
        const key = ph.id + '|' + defs.map(function (d) { return d.id; }).join(',');
        const tOpts = defs.map(function (d) { return { value: d.id, label: d.name }; });
        const usual = defs.filter(function (d) { return d.reference; }), other = defs.filter(function (d) { return !d.reference; });
        const rOpts = usual.map(function (d) { return { value: d.id, label: d.name, group: brain ? 'Usual reference regions' : 'Reference regions' }; })
            .concat(other.map(function (d) { return { value: d.id, label: d.name, group: brain ? 'Other regions (try a wrong one)' : 'Other regions' }; }));
        T.roiSelects.forEach(function (p) {
            if (p.key !== key) { p.t.setOptions(tOpts); p.r.setOptions(rOpts); p.key = key; }
            p.t.set(canonical(ph, ids.target));
            p.r.set(canonical(ph, ids.reference));
        });
    }

    function buildStatic() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'kn-st-title' });
        T.dom.staticsPanel = panel;
        T.dom.stSub = el('span', { class: 'panel-sub' });
        T.dom.stBadges = el('span', { class: 'kn-head-badges' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'kn-st-title', text: 'Static quantification: SUV and SUVR' }), T.dom.stSub,
            el('span', { class: 'spacer' }), T.dom.stBadges
        ]));
        const sel = makeRoiSelects();
        // dynamic scans: which frame is measured (the same frame the Sinogram and Reconstruction tabs show)
        T.dom.stFrame = w().slider({ label: 'Frame measured', min: 0, max: 1, step: 1, value: 0,
            format: function (v) { return frameText(Math.round(v)); },
            onChange: function (v) { if (PET.actions && PET.actions.setFrame) PET.actions.setFrame(Math.round(v)); } });
        T.dom.stFrameRow = el('div', { class: 'kn-frame-row', hidden: true }, [T.dom.stFrame]);
        panel.appendChild(el('div', { class: 'controls kn-roi-row' }, [sel.t, sel.r, T.dom.stFrameRow]));
        T.dom.stBody = el('div');
        T.dom.stMain = el('div', { class: 'kn-figure' });
        const side = el('div');
        // The widget reads these options at every draw, so the unit and the
        // readout can follow the phantom (SUV for a patient, kBq/mL for a phantom).
        T.dom.stWellOpts = { title: 'ROIs on the image (SUV)', cmap: 'pet', colorbar: true, unit: 'SUV', maxHeight: 300, empty: 'No image yet',
            readoutFormat: function (ix, iy, v) {
                const M = T.wellMasks;
                const where = M ? (M.t[iy * M.nx + ix] > 0 ? ' · in the target ROI' : (M.r[iy * M.nx + ix] > 0 ? ' · in the reference ROI' : '')) : '';
                return (isFinite(v) ? U.fmtNum(v, 3) : '-') + ' ' + T.dom.stWellOpts.unit + where;
            } };
        T.dom.stWell = w().imageView(side, T.dom.stWellOpts);
        T.dom.stWell.el.classList.add('kn-well');
        T.dom.stLegend = w().legend([{ label: 'target', color: WELL_TARGET, line: true }, { label: 'reference', color: WELL_REF, line: true }]);
        T.dom.stLegend.classList.add('kn-well-legend');
        side.appendChild(T.dom.stLegend);
        T.dom.stSplit = el('div', { class: 'split' }, [T.dom.stMain, side]);
        T.dom.stEmpty = el('div');
        T.dom.stBody.appendChild(T.dom.stEmpty);
        T.dom.stBody.appendChild(T.dom.stSplit);
        panel.appendChild(T.dom.stBody);
        return panel;
    }

    function frameText(i) {
        const acq = PET.state && PET.state.acq;
        if (!acq || !acq.frames || !acq.frames[i]) return String(i + 1);
        const F = acq.frames[i];
        return (i + 1) + ' of ' + acq.frames.length + ' · ' + span(F.t0, F.t1);
    }
    function syncFrameSlider() {
        const acq = PET.state && PET.state.acq, n = acq && acq.frames ? acq.frames.length : 1;
        if (!T.dom.stFrameRow) return;
        T.dom.stFrameRow.hidden = !(n > 1);
        if (n > 1) { T.dom.stFrame.setRange(0, n - 1, 1); T.dom.stFrame.set(Math.min(PET.state.frame || 0, n - 1)); }
    }
    function emptyWithAction(msg, label, fn) {
        const box = el('div', { class: 'empty' }, [el('div', { text: msg })]);
        if (label) box.appendChild(el('div', { class: 'kn-empty-act' }, [w().button({ label: label, kind: 'primary', size: 'sm', onClick: fn })]));
        return box;
    }
    function acquireNow() { if (PET.actions && PET.actions.runScan) PET.actions.runScan({ animate: false }); }

    /* Everything section 3 shows, or {empty} when it cannot be computed. */
    function computeStatic() {
        const st = PET.state, acq = st.acq, res = st.reconResult;
        if (!A()) return { error: 'The image analysis module (js/analysis.js) did not load, so ROIs cannot be measured.' };
        if (!PET.engine) return { error: 'The acquisition engine (js/engine.js) did not load, so there is no scan to measure. The model explorer above still works.' };
        if (!PET.recon) return { error: 'The reconstruction module (js/recon.js) did not load, so there is no image to measure. The model explorer and SUVR over time still work.' };
        if (!acq) return { empty: st.scanning ? 'The first scan is running…' : 'No scan yet. Acquire one to measure SUV and SUVR on the image.', action: st.scanning ? null : 'Acquire' };
        if (!res || !res.image) return { empty: 'The image is being reconstructed…' };
        const ph = phantomOf(acq);
        if (!ph) return { error: 'The phantom of the last scan could not be rebuilt.' };
        const fi = typeof res.frame === 'number' ? Math.min(res.frame, acq.frames.length - 1) : Math.min(st.frame || 0, acq.frames.length - 1);
        const F = acq.frames[fi];
        const ids = effectiveIds(ph);
        const dT = findDef(ph, ids.target), dR = findDef(ph, ids.reference);
        if (!dT || !dR) return { empty: 'Pick a target and a reference region.' };
        const m = res.n;
        const mT = A().roiMask(ph, m, dT.id), mR = A().roiMask(ph, m, dR.id);
        const sT = A().roiStats(res.image, mT), sR = A().roiStats(res.image, mR);
        const rm = F.truth ? F.truth.regionMean : null;
        const tT = roiValue(ph, rm, dT), tR = roiValue(ph, rm, dR);
        const decayOn = !(st.recon && st.recon.corrections && st.recon.corrections.decay === false);
        const decayFactor = F.dur > 0 && F.decayIntegral > 0 ? F.decayIntegral / F.dur : 1;
        const suvK = acq.dose > 0 ? (acq.weight || 70) * 1000 / acq.dose : NaN;
        const prog = acq.program || {};
        const out = {
            acq: acq, res: res, ph: ph, frame: fi, F: F, nFrames: acq.frames.length, dT: dT, dR: dR, masks: { t: mT, r: mR }, m: m,
            meas: { t: sT.mean, r: sR.mean, covT: sT.cov, covR: sR.cov, nT: sT.nPix, nR: sR.nPix },
            truth: { t: tT, r: tR }, suvK: suvK, decayOn: decayOn, decayFactor: decayFactor,
            kind: ph.kind, tracer: prog.tracer || acq.tracer || null, condition: ph.condition || 'normal',
            partial: !!(acq.partial || st.scanning), stale: !!st.stale
        };
        out.ratioMeas = sR.mean > 0 ? sT.mean / sR.mean : NaN;
        out.ratioTrue = tR > 0 ? tT / tR : NaN;
        if (ph.kind === 'brain' && out.tracer && K()) {
            out.kt = roiKinetics(out.tracer, out.condition, ph, dT);
            out.kr = roiKinetics(out.tracer, out.condition, ph, dR);
            const tm = tracerInfo(out.tracer);
            out.tracerModel = tm ? tm.model : out.kt.model;
            // goal and equilibrium value
            if (out.tracerModel === '2tcr') {
                out.goal = isFinite(out.kt.BPND) ? 1 + out.kt.BPND : NaN;
                out.eq = out.kt.VT > 0 && out.kr.VT > 0 ? out.kt.VT / out.kr.VT : NaN;
            } else if (out.tracerModel === '2tci') {
                out.goal = out.kt.KiVoxel > 0 && out.kr.KiVoxel > 0 ? out.kt.KiVoxel / out.kr.KiVoxel : NaN;
                out.eq = out.goal;
            } else {
                out.goal = out.kt.VT > 0 && out.kr.VT > 0 ? out.kt.VT / out.kr.VT : NaN;
                out.eq = out.goal;
            }
            try {
                const tacs = acqTACs(acq, ph);
                const ct = roiCurve(ph, tacs, dT);
                let ip = 0; for (let i = 1; i < ct.length; i++) if (ct[i] > ct[ip]) ip = i;
                out.peakT = tacs.t[ip];
                out.peakAtEnd = ip >= ct.length - 2;
            } catch (e) { out.peakT = NaN; }
            if (out.tracerModel === '2tcr') out.bindPeak = bindingPeak(out.tracer, out.condition, ph, dT, Math.max(180 * MIN, F.t1 + 30 * MIN));
        } else if (ph.kind !== 'brain') {
            // solution phantoms: the true ratio is the one the phantom was filled with
            out.goal = out.ratioTrue;
        }
        return out;
    }

    function renderStatic() {
        if (!T.dom.stBody) return;
        let S;
        try { S = computeStatic(); } catch (e) { S = { error: e.message || String(e), err: e }; if (root.console) root.console.error('[kinetics tab] static quantification failed:', e); }
        const D = T.dom;
        syncFrameSlider();
        D.stBadges.textContent = '';
        D.stEmpty.textContent = '';
        if (S.error || S.empty) {
            D.stSplit.hidden = true;
            D.stSub.textContent = '';
            D.stEmpty.appendChild(S.error ? w().errorCard('Static quantification is unavailable', S.err || { message: S.error })
                : emptyWithAction(S.empty, S.action, acquireNow));
            return;
        }
        D.stSplit.hidden = false;
        const prog = S.acq.program || {};
        const F = S.F;
        D.stSub.textContent = (S.nFrames > 1 ? 'frame ' + (S.frame + 1) + ' of ' + S.nFrames + ', ' : '') + span(F.t0, F.t1) + ' after injection · ' +
            (S.kind === 'brain' ? tracerLabel(S.tracer) : (PET.isotopes ? PET.isotopes.get(S.acq.isotope).label + ' solution' : 'solution'));
        if (S.partial) D.stBadges.appendChild(w().badge('scan in progress', 'accent'));
        else if (T.reconPending) D.stBadges.appendChild(w().badge('updating', 'muted'));
        if (S.stale && !PET.state.autoRescan) D.stBadges.appendChild(w().badge('settings changed since this scan', 'warn'));
        if (!S.decayOn) D.stBadges.appendChild(w().badge('decay correction off', 'warn'));

        D.stMain.textContent = '';
        if (S.kind === 'brain') renderStaticBrain(S, D.stMain);
        else renderStaticSolution(S, D.stMain);
        drawStaticWell(S);
    }

    function table3(headers, rows) {
        const thead = el('thead', {}, [el('tr', {}, [el('th', { scope: 'col' }, headers[0] || '')].concat(headers.slice(1).map(function (h) { return el('th', { scope: 'col', text: h }); })))]);
        const tbody = el('tbody');
        rows.forEach(function (r) {
            if (!r) return;
            const th = el('th', { scope: 'row', title: r.hint || null }, [r.label]);
            if (r.unit) th.appendChild(el('span', { class: 'unit', text: r.unit }));
            const tr = el('tr', { class: r.sep ? 'kn-sep' : null }, [th].concat(r.cells.map(function (c) {
                const o = c && typeof c === 'object' ? c : { v: c };
                return el('td', { class: [o.kind || '', o.hi ? 'kn-hi' : ''].join(' ').trim() || null, title: o.title || null }, [o.v === undefined || o.v === null ? '-' : String(o.v),
                    o.sub ? el('span', { class: 'kn-rel', text: o.sub }) : null]);
            })));
            tbody.appendChild(tr);
        });
        return el('div', { class: 'kn-table-wrap' }, [el('table', { class: 'stat-table kn-table' }, [thead, tbody])]);
    }
    function tiles(items) {
        return el('div', { class: 'stats kn-tiles' }, items.filter(Boolean).map(function (it) {
            return el('div', { class: 'stat', title: it.hint || null }, [
                el('div', { class: 'stat-label', text: it.label }),
                el('div', { class: 'stat-value' + (it.kind ? ' ' + it.kind : '') }, [it.value, it.unit ? el('span', { class: 'stat-unit', text: it.unit }) : null])
            ]);
        }));
    }

    function renderStaticBrain(S, host) {
        const k = S.suvK, df = S.decayOn ? 1 : S.decayFactor;
        const nameT = S.dT.name, nameR = S.dR.name;
        const suvMT = S.meas.t * k, suvMR = S.meas.r * k, suvTT = S.truth.t * k, suvTR = S.truth.r * k;
        const model = S.tracerModel;
        host.appendChild(table3(['', 'Measured on the image', 'True (noise-free, infinitely sharp)'], [
            { label: 'SUVmean, target', unit: 'g/mL', hint: nameT, cells: [fix(suvMT, 2), fix(suvTT, 2)] },
            { label: 'SUVmean, reference', unit: 'g/mL', hint: nameR, cells: [fix(suvMR, 2), fix(suvTR, 2)] },
            { label: 'SUVR, target / reference', cells: [{ v: fix(S.ratioMeas, 2), hi: true }, { v: fix(S.ratioTrue, 2), hi: true }] },
            model === '2tcr' ? { label: 'SUVR − 1', hint: 'What a ratio offers as an estimate of BPND', cells: [fix(S.ratioMeas - 1, 2), fix(S.ratioTrue - 1, 2)] } : null
        ]));

        // binding from the model
        const items = [];
        if (model === '2tcr') {
            items.push({ label: 'True BPND, target', value: fix(S.kt.BPND, 2), hint: 'k3/k4 of the target region(s), from the model' });
            items.push({ label: 'True DVR = 1 + BPND', value: fix(S.goal, 2), hint: 'What SUVR is meant to estimate' });
            if (isFinite(S.eq) && Math.abs(S.eq / S.goal - 1) > 0.01) items.push({ label: 'Ratio at equilibrium', value: fix(S.eq, 2), hint: 'VT of the target over VT of this reference: the most any ratio with this reference can reach' });
            items.push({ label: 'SUVR − 1 vs BPND', value: fix(S.ratioMeas - 1, 2) + ' vs ' + fix(S.kt.BPND, 2), kind: Math.abs((S.ratioMeas - 1) - S.kt.BPND) > 0.1 * Math.max(0.2, S.kt.BPND) ? 'warn' : 'good' });
        } else if (model === '2tci') {
            items.push({ label: 'True Ki, target', value: fix(S.kt.KiVoxel, 4), unit: 'mL/min/mL', hint: 'Net influx per mL of voxel, (1 - vb) Ki' });
            items.push({ label: 'True Ki, reference', value: fix(S.kr.KiVoxel, 4), unit: 'mL/min/mL' });
            items.push({ label: 'Ki ratio', value: fix(S.goal, 2), hint: 'The value SUVR approaches as the free tracer clears: the ratio of the net influx rates' });
        } else if (model === '1tc') {
            items.push({ label: 'True flow, target', value: fix(S.kt.flow, 3), unit: 'mL/min/mL' });
            items.push({ label: 'True flow, reference', value: fix(S.kr.flow, 3), unit: 'mL/min/mL' });
            items.push({ label: 'VT ratio', value: fix(S.goal, 2), hint: 'At equilibrium, water distributes by its partition coefficients' });
        }
        host.appendChild(tiles(items));
        host.appendChild(interpretBrain(S, df));
    }

    function interpretBrain(S, df) {
        const box = el('div', { class: 'callout kn-interp' });
        const li = [];
        const model = S.tracerModel, win = span(S.F.t0, S.F.t1);
        const add = function (html) { li.push(el('li', { html: html })); };
        if (!(S.ratioMeas > 0) || !(S.ratioTrue > 0)) {
            box.appendChild(el('div', { text: 'The reference region holds no activity in this frame, so a ratio cannot be formed.' }));
            return box;
        }
        if (S.kt.blood || S.kt.none) {
            box.appendChild(el('div', { html: S.kt.blood ? 'The target is <strong>blood</strong> (venous sinus): its curve is the plasma input itself, so there is no binding to estimate. Pick a tissue region.'
                : 'The target holds no tracer in this model (CSF, ventricles or bone). Pick a tissue region.' }));
            return box;
        }
        let lead;
        if (model === '2tcr') lead = 'Measured SUVR ' + fix(S.ratioMeas, 2) + ' vs true DVR ' + fix(S.goal, 2) + ': <strong>' + pct(S.ratioMeas / S.goal - 1) + '</strong> in total.';
        else if (model === '2tci') lead = 'FDG is trapped, so there is no DVR. The ratio grows towards the ratio of net influx rates, K<sub>i</sub> ratio ' + fix(S.goal, 2) +
            ', which the measured SUVR ' + fix(S.ratioMeas, 2) + ' misses by <strong>' + pct(S.ratioMeas / S.goal - 1) + '</strong>.';
        else lead = 'Water is not bound: the ratio settles at the ratio of distribution volumes, ' + fix(S.goal, 2) + '; flow itself needs a dynamic scan.';
        box.appendChild(el('div', { class: 'kn-lead', html: lead }));

        // reference region
        if (model === '2tcr') {
            if (S.kr.BPND > 0.05) add('<strong>Reference region:</strong> ' + S.dR.name + ' has specific binding of its own (BP<sub>ND</sub> ' + fix(S.kr.BPND, 2) +
                '), so even at equilibrium the ratio would only reach V<sub>T</sub>/V<sub>T,ref</sub> = ' + fix(S.eq, 2) + ', not the DVR. A reference must be free of the target.');
            else if (S.kr.blood || S.kr.none) add('<strong>Reference region:</strong> ' + S.dR.name + ' is not tissue that behaves like the target without binding, so the ratio has no simple meaning.');
            else if (isFinite(S.kt.VND) && isFinite(S.kr.VND) && Math.abs(S.kt.VND / S.kr.VND - 1) > 0.02) add('<strong>Reference region:</strong> no specific binding, but its nondisplaceable uptake (V<sub>ND</sub> ' +
                fix(S.kr.VND, 2) + ') differs from the target\'s (' + fix(S.kt.VND, 2) + '), so at equilibrium the ratio would be ' + fix(S.eq, 2) + ' rather than ' + fix(S.goal, 2) + '.');
            else add('<strong>Reference region:</strong> no specific binding and the same nondisplaceable uptake (V<sub>ND</sub> ' + fix(S.kr.VND, 2) + '), so at true equilibrium the ratio would equal the DVR.');
        } else if (model === '2tci' && S.dR && /wm|white/i.test(S.dR.id)) {
            add('<strong>Reference region:</strong> white matter takes up much less FDG than gray matter, so the ratio is large and mostly reflects the reference.');
        }
        // (a) kinetic bias
        const kin = S.ratioTrue / S.eq - 1;
        let why = '';
        if (model === '2tcr') {
            const bp = S.bindPeak;
            if (kin > 0.02) why = (isFinite(bp) && bp < S.F.t0 ? 'Specific binding in the target peaked at ' + minutes(bp) + ' min. Since then the plasma has been falling, and bound tracer leaves the target more slowly than free tracer leaves the reference: ' : 'The plasma is falling faster than bound tracer can leave the target: ') +
                'a <em>transient equilibrium</em> in which the ratio overshoots the DVR.';
            else if (kin < -0.02) why = 'Binding has not reached equilibrium yet' + (bp === Infinity ? ' (the bound tracer is still accumulating)' : (isFinite(bp) && bp > S.F.t1 ? ' (specific binding peaks at ' + minutes(bp) + ' min)' : '')) + ', so the ratio is still below its equilibrium value.';
            else why = 'This window is close to equilibrium, so here a ratio is a fair estimate of the binding.';
        } else if (model === '2tci') {
            why = kin < -0.02 ? 'Part of the activity is still free FDG and blood, which are similar in both regions, so the ratio has not yet reached the K<sub>i</sub> ratio and keeps rising with time.'
                : 'By now trapped FDG dominates both regions.';
        } else why = kin < -0.02 || kin > 0.02 ? 'Water equilibrates within minutes, but not instantly.' : 'Water has equilibrated.';
        add('<strong>(a) Kinetic bias</strong> of a ratio taken at ' + win + ': the noise-free SUVR is ' + fix(S.ratioTrue, 2) + ', <strong>' + pct(kin) + '</strong> from the ' +
            (model === '2tcr' ? (Math.abs(S.eq / S.goal - 1) > 0.01 ? 'equilibrium ratio ' : 'DVR ') : (model === '2tci' ? 'K<sub>i</sub> ratio ' : 'equilibrium ratio ')) + fix(S.eq, 2) + '. ' + why);
        // (b) imaging bias
        const img = S.ratioMeas / S.ratioTrue - 1;
        const recT = S.meas.t / df / S.truth.t, recR = S.meas.r / df / S.truth.r;
        const causes = [];
        if (isFinite(recT) && isFinite(recR)) causes.push('the target reads ' + fmt(100 * recT, 3) + ' % and the reference ' + fmt(100 * recR, 3) + ' % of their true values' +
            (recT < 0.95 || recR < 0.95 ? ' (partial volume: at this resolution thin or small structures spill activity into their neighbours, and cold neighbours spill in)' : ''));
        if (S.meas.covT > 0.1) causes.push('noise: the target pixels vary by ' + fmt(100 * S.meas.covT, 2) + ' % (coefficient of variation over ' + S.meas.nT + ' pixels)');
        const off = correctionsOff();
        if (off.length) causes.push(off.join(', ') + ' (these bias the two regions differently)');
        add('<strong>(b) Imaging bias</strong>: measured ' + fix(S.ratioMeas, 2) + ' vs noise-free ' + fix(S.ratioTrue, 2) + ', <strong>' + pct(img) + '</strong>. ' +
            (causes.length ? 'Contributions: ' + causes.join('; ') + '.' : ''));
        if (S.nFrames > 1 && S.F.t1 < 0.5 * S.acq.frames[S.nFrames - 1].t1) add('This is an early frame of a dynamic scan. Static ratios are read late: move <strong>Frame measured</strong> to one of the last frames, or see SUVR of the late frames under Dynamic analysis.');
        if (!S.decayOn) add('<strong>Decay correction is off</strong>: every SUV is ' + fix(S.decayFactor, 2) + ' times its true value (the activity left on average during the frame), but both regions decay alike, so the SUVR does not change.');
        box.appendChild(el('ul', {}, li));
        return box;
    }
    function correctionsOff() {
        const st = PET.state, c = (st.recon && st.recon.corrections) || {}, ph = st.physics || {}, out = [];
        if (c.attenuation === false && ph.attenuation !== false) out.push('no attenuation correction');
        if (c.attenuation !== false && ph.attenuation === false) out.push('attenuation corrected although there was none');
        if (c.scatter === false && ph.scatter !== false) out.push('no scatter correction');
        if (c.randoms === false && ph.randoms !== false) out.push('no randoms correction');
        if (c.normalization === false) out.push('no normalisation');
        if (ph.motion && ph.motion.on && !c.motion) out.push('uncorrected motion');
        if (ph.muMap && (ph.muMap.dx || ph.muMap.dy || ph.muMap.rot || ph.muMap.model === 'nobone')) out.push('a mu map that does not match the head');
        return out;
    }

    function renderStaticSolution(S, host) {
        const kBq = function (v) { return isFinite(v) ? fmt(v / 1000, 3) : '-'; };
        const df = S.decayOn ? 1 : S.decayFactor;
        const recT = S.meas.t / df / S.truth.t;
        const hasRatio = S.truth.r > 0 && S.dR.id !== S.dT.id;
        host.appendChild(el('div', { class: 'callout', html: 'SUV and SUVR are for patients: they divide by the dose per gram of body weight and compare two tissues of one person. ' +
            'This phantom is filled with a solution, so here the same arithmetic gives a <strong>concentration ratio</strong> to compare with the ratio it was filled with. ' +
            'For SUVR, load a brain protocol.' }));
        host.appendChild(table3(['', 'Measured on the image', 'True'], [
            { label: 'Mean, ' + S.dT.name, unit: 'kBq/mL', cells: [kBq(S.meas.t), kBq(S.truth.t)] },
            { label: 'Mean, ' + S.dR.name, unit: 'kBq/mL', cells: [kBq(S.meas.r), kBq(S.truth.r)] },
            hasRatio ? { label: 'Concentration ratio', cells: [{ v: fix(S.ratioMeas, 2), hi: true }, { v: fix(S.ratioTrue, 2), hi: true }] } : null,
            { label: 'Recovery of the target', hint: 'Measured over true mean concentration (decay corrected)', cells: [fix(recT, 2), '1'] }
        ]));
        const li = [];
        if (hasRatio) li.push('Measured ratio ' + fix(S.ratioMeas, 2) + ' vs true ' + fix(S.ratioTrue, 2) + ': <strong>' + pct(S.ratioMeas / S.ratioTrue - 1) + '</strong>.');
        else li.push('The reference holds no activity, so only the target\'s recovery is meaningful here.');
        if (recT < 0.9) li.push('The target recovers ' + fmt(100 * recT, 3) + ' % of its true concentration: partial volume (an object a few times the resolution or smaller loses its peak), plus any mismatch of the corrections.');
        else if (recT > 1.1) li.push('The target reads high (' + fmt(100 * recT, 3) + ' %): spill-in from hotter surroundings, noise, or an over-correction.');
        else li.push('The target is within 10 % of its true concentration.');
        const off = correctionsOff();
        if (off.length) li.push('Switched off or mismatched: ' + off.join(', ') + '.');
        if (!S.decayOn) li.push('Decay correction is off: values are ' + fix(S.decayFactor, 2) + ' times the activity at the start (fill) time, the ratio is unaffected.');
        host.appendChild(el('div', { class: 'callout kn-interp' }, [el('ul', {}, li.map(function (h) { return el('li', { html: h }); }))]));
    }

    /* The image with the two ROIs outlined, cropped to the object. */
    function drawStaticWell(S) {
        const view = T.dom.stWell;
        if (!view) return;
        const m = S.m, ph = S.ph, img = S.res.image;
        // bounding box of the object (non-air labels) on the image grid
        const box = objectBox(ph, m);
        const nx = box.x1 - box.x0 + 1, ny = box.y1 - box.y0 + 1;
        const data = new Float32Array(nx * ny), mt = new Float32Array(nx * ny), mr = new Float32Array(nx * ny);
        const k = S.kind === 'brain' && isFinite(S.suvK) ? S.suvK : 1e-3;
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            const src = (y + box.y0) * m + x + box.x0, dst = y * nx + x;
            data[dst] = img[src] * k; mt[dst] = S.masks.t[src]; mr[dst] = S.masks.r[src];
        }
        T.dom.stWellOpts.unit = S.kind === 'brain' ? 'SUV' : 'kBq/mL';
        view.setTitle(S.kind === 'brain' ? 'ROIs on the image (SUV)' : 'ROIs on the image (kBq/mL)');
        T.wellMasks = { t: mt, r: mr, nx: nx };
        view.setOverlay(function (ctx, g) {
            outline(ctx, g, mr, nx, ny, WELL_REF);
            outline(ctx, g, mt, nx, ny, WELL_TARGET);
        });
        const hi = U.percentile(data, 99.5);
        view.setData(data, nx, ny, { min: 0, max: hi > 0 ? hi : 1, aspect: ny / nx });
    }
    const boxCache = new WeakMap();
    function objectBox(ph, m) {
        let byM = boxCache.get(ph);
        if (!byM) { byM = {}; boxCache.set(ph, byM); }
        if (byM[m]) return byM[m];
        const n = ph.n, f = m / n;
        let x0 = n, x1 = -1, y0 = n, y1 = -1;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            if (!ph.label[iy * n + ix]) continue;
            if (ix < x0) x0 = ix; if (ix > x1) x1 = ix; if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
        }
        if (x1 < 0) return (byM[m] = { x0: 0, x1: m - 1, y0: 0, y1: m - 1 });
        const pad = Math.round(8 / (ph.fov / m));
        // square box around the object's centre, so the well keeps its proportions
        const cx = (x0 + x1 + 1) / 2 * f, cy = (y0 + y1 + 1) / 2 * f, half = Math.max(x1 - x0 + 1, y1 - y0 + 1) / 2 * f + pad;
        const b = {
            x0: Math.max(0, Math.floor(cx - half)), x1: Math.min(m - 1, Math.ceil(cx + half) - 1),
            y0: Math.max(0, Math.floor(cy - half)), y1: Math.min(m - 1, Math.ceil(cy + half) - 1)
        };
        return (byM[m] = b);
    }
    function outline(ctx, g, mask, nx, ny, color) {
        const sx = g.w / nx, sy = g.h / ny;
        // a light tint inside, so a thin ribbon such as the cortex reads as a region
        ctx.save();
        ctx.globalAlpha = 0.22; ctx.fillStyle = color;
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (mask[y * nx + x] > 0) ctx.fillRect(x * sx, y * sy, sx, sy);
        ctx.restore();
        ctx.beginPath();
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
            if (!(mask[y * nx + x] > 0)) continue;
            const X = x * sx, Y = y * sy;
            if (x === 0 || !(mask[y * nx + x - 1] > 0)) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + sy); }
            if (x === nx - 1 || !(mask[y * nx + x + 1] > 0)) { ctx.moveTo(X + sx, Y); ctx.lineTo(X + sx, Y + sy); }
            if (y === 0 || !(mask[(y - 1) * nx + x] > 0)) { ctx.moveTo(X, Y); ctx.lineTo(X + sx, Y); }
            if (y === ny - 1 || !(mask[(y + 1) * nx + x] > 0)) { ctx.moveTo(X, Y + sy); ctx.lineTo(X + sx, Y + sy); }
        }
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; ctx.lineWidth = 2.6; ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
    }

    /* ============================================================
       4. SUVR over time
       ============================================================ */
    function buildOverTime() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'kn-ot-title' });
        T.dom.overtimePanel = panel;
        T.dom.otSub = el('span', { class: 'panel-sub' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'kn-ot-title', text: 'SUVR over time' }), T.dom.otSub
        ]));
        T.dom.otEmpty = el('div');
        panel.appendChild(T.dom.otEmpty);
        T.dom.otBody = el('div');
        T.dom.otPlot = w().plot(T.dom.otBody, { height: 260, xlabel: 'Time after injection (min)', ylabel: 'Target / reference', framed: true });
        T.dom.otStats = el('div');
        T.dom.otBody.appendChild(T.dom.otStats);
        T.dom.otNote = el('p', { class: 'note kn-section-note' });
        T.dom.otBody.appendChild(T.dom.otNote);
        panel.appendChild(T.dom.otBody);
        return panel;
    }
    function renderOverTime() {
        if (!T.dom.otBody) return;
        const D = T.dom;
        D.otEmpty.textContent = '';
        const fail = function (node) { D.otBody.hidden = true; D.otEmpty.appendChild(node); };
        try {
            const prog = currentProgram(), ph = currentPhantom();
            if (!K() || !A()) return fail(w().errorCard('SUVR over time is unavailable', { message: 'The kinetics or analysis module did not load.' }));
            if (!prog || !ph) return fail(w().empty('Load a protocol to see how the ratio changes with time.'));
            if (ph.kind !== 'brain' || !prog.tracer) return fail(w().empty('A phantom filled with a solution has no kinetics: its concentration ratio is the same at every time. Load a brain protocol to see how SUVR changes with time.'));
            D.otBody.hidden = false;
            const tacs = longCurves(ph, prog);
            const ids = effectiveIds(ph), dT = findDef(ph, ids.target), dR = findDef(ph, ids.reference);
            const ct = roiCurve(ph, tacs, dT), cr = roiCurve(ph, tacs, dR);
            const n = ct.length, tMin = Float64Array.from(tacs.t, function (v) { return v / MIN; }), ratio = new Float64Array(n);
            const crMax = maxOf(cr);
            for (let i = 0; i < n; i++) ratio[i] = cr[i] > 1e-3 * crMax ? ct[i] / cr[i] : NaN;
            const tm = tracerInfo(prog.tracer), model = tm ? tm.model : null;
            const kt = roiKinetics(prog.tracer, ph.condition, ph, dT), kr = roiKinetics(prog.tracer, ph.condition, ph, dR);
            let goal = NaN, goalLabel = '', eq = NaN;
            if (model === '2tcr') { goal = 1 + kt.BPND; goalLabel = 'true DVR ' + fix(goal, 2); eq = kt.VT / kr.VT; }
            else if (model === '2tci') { goal = kt.KiVoxel / kr.KiVoxel; goalLabel = 'Ki ratio ' + fix(goal, 2); eq = goal; }
            else { goal = kt.VT / kr.VT; goalLabel = 'VT ratio ' + fix(goal, 2); eq = goal; }
            const win = scanWindow(prog);
            let wr = NaN;
            if (win) {
                const fm = K().frameMeans(tacs, [{ t0: win.t0, t1: win.t1 }])[0];
                wr = roiValue(ph, fm, dR) > 0 ? roiValue(ph, fm, dT) / roiValue(ph, fm, dR) : NaN;
            }
            // y range: the curve after the first minute and the reference lines
            let ylo = Infinity, yhi = -Infinity;
            for (let i = 0; i < n; i++) if (tacs.t[i] >= 60 && isFinite(ratio[i])) { ylo = Math.min(ylo, ratio[i]); yhi = Math.max(yhi, ratio[i]); }
            [goal, eq, wr].forEach(function (v) { if (isFinite(v)) { ylo = Math.min(ylo, v); yhi = Math.max(yhi, v); } });
            if (!isFinite(ylo)) { ylo = 0; yhi = 2; }
            ylo = Math.min(0, ylo); yhi = yhi * 1.08 + 0.02;
            const series = [];
            if (win && isFinite(wr)) series.push({ x: [win.t0 / MIN, win.t1 / MIN], y: [wr, wr], color: 'var(--c4)', fill: 0.16, width: 2,
                label: (prog.dynamic ? 'SUVR of the late frames' : 'SUVR of the scan window') + ' (' + span(win.t0, win.t1) + ')' });
            series.push({ x: tMin, y: ratio, color: 'var(--c1)', width: 2.2, label: dT.name + ' / ' + dR.name });
            const hl = [];
            if (isFinite(goal)) hl.push({ y: goal, label: goalLabel, color: 'var(--c3)', dash: false });
            if (isFinite(eq) && Math.abs(eq / goal - 1) > 0.01) hl.push({ y: eq, label: 'equilibrium ratio with this reference ' + fix(eq, 2), color: 'var(--c7)' });
            // time the ratio first reaches the goal, and the target's peak
            let cross = NaN;
            if (isFinite(goal)) for (let i = 1; i < n; i++) {
                if (tacs.t[i] < 60 || !isFinite(ratio[i]) || !isFinite(ratio[i - 1])) continue;
                if ((ratio[i - 1] - goal) * (ratio[i] - goal) <= 0 && ratio[i] !== ratio[i - 1]) { cross = tacs.t[i - 1] + (goal - ratio[i - 1]) / (ratio[i] - ratio[i - 1]) * (tacs.t[i] - tacs.t[i - 1]); break; }
            }
            let ip = 0; for (let i = 1; i < n; i++) if (ct[i] > ct[ip]) ip = i;
            const peakT = tacs.t[ip], peakAtEnd = ip >= n - 2;
            const bindT = model === '2tcr' ? bindingPeak(prog.tracer, ph.condition, ph, dT, tacs.t[n - 1]) : NaN;
            const markers = [];
            if (!peakAtEnd && model !== '2tci') markers.push({ x: peakT / MIN, label: 'target peak', color: 'var(--muted)' });
            if (isFinite(bindT)) markers.push({ x: bindT / MIN, label: 'binding peak', color: 'var(--c2)' });
            D.otPlot.draw(series, { ylim: [ylo, yhi], hlines: hl, markers: markers, xlim: [0, tacs.t[n - 1] / MIN], legend: true });
            D.otSub.textContent = 'true curves of ' + tracerLabel(prog.tracer) + (ph.condition && ph.condition !== 'normal' ? ' (' + conditionName(ph.condition) + ')' : '') + ', no noise, no blur';
            D.otStats.textContent = '';
            D.otStats.appendChild(tiles([
                { label: win && prog.dynamic ? 'SUVR, late frames' : 'SUVR, scan window', value: fix(wr, 2), hint: win ? span(win.t0, win.t1) : '' },
                { label: model === '2tcr' ? 'True DVR' : (model === '2tci' ? 'Ki ratio' : 'VT ratio'), value: fix(goal, 2) },
                { label: 'Bias of the window', value: pct(wr / goal - 1), kind: Math.abs(wr / goal - 1) > 0.05 ? 'warn' : 'good' },
                { label: model === '2tci' ? 'Target still rising' : 'Target peaks at', value: peakAtEnd ? 'after ' + minutes(tacs.t[n - 1]) : minutes(peakT), unit: 'min' },
                model === '2tcr' ? { label: 'Specific binding peaks at', value: bindT === Infinity ? 'after ' + minutes(tacs.t[n - 1]) : minutes(bindT), unit: 'min',
                    hint: 'When bound tracer stops increasing, C2/C1 = k3/k4 = BPND exactly' } : null,
                isFinite(cross) ? { label: 'Ratio reaches it at', value: minutes(cross), unit: 'min' } : null
            ]));
            let note;
            if (model === '2tcr') note = 'For a reversibly binding tracer the ratio climbs from about 1 and passes the true DVR, near the time specific binding peaks if the reference tracks the target\'s free tracer well (at that moment bound over free is exactly k3/k4). Afterwards it overshoots: as the plasma falls, free tracer in the reference follows it, while bound tracer in the target lags behind (transient equilibrium). A late static SUVR therefore overestimates the binding, by an amount that depends on the tracer\'s speed and on the scan time.';
            else if (model === '2tci') note = 'FDG is trapped, so the ratio never settles: it keeps rising towards the ratio of the net influx rates as free tracer clears. SUV and SUVR of FDG depend on the uptake time, which is why clinics keep it fixed (about 60 min, or 30 to 60 min for the brain).';
            else note = 'Water is freely diffusible and is not bound, so the ratio settles within minutes at the ratio of distribution volumes. Blood flow is measured from the first minute of a dynamic scan, not from a ratio.';
            D.otNote.textContent = note + ' Target and reference are chosen under Static quantification.';
        } catch (e) {
            if (root.console) root.console.error('[kinetics tab] SUVR over time failed:', e);
            fail(w().errorCard('SUVR over time could not be computed', e));
        }
    }
    function conditionName(id) {
        const c = (K() && K().conditions || []).find(function (x) { return x.id === id; });
        return c ? c.name : id;
    }

    /* ============================================================
       5. Dynamic analysis
       ============================================================ */
    const DYN_PRESETS = [
        { id: 'fdg_dynamic', title: 'FDG, 0 to 60 min', text: 'Patlak plot: the net influx rate Ki of a trapped tracer.' },
        { id: 'pib_dynamic', title: 'PiB (Alzheimer), 0 to 70 min', text: 'Logan plot with the cerebellum: DVR of amyloid binding.' },
        { id: 'pe2i_dynamic', title: 'PE2I (Parkinson), 0 to 70 min', text: 'Logan plot of the dopamine transporter in the striatum.' },
        { id: 'water_dynamic', title: '[¹⁵O]water, 0 to 3 min', text: 'One-tissue fit: cerebral blood flow K1 in the first minutes.' }
    ];
    function buildDynamic() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'kn-dy-title' });
        T.dom.dynamicPanel = panel;
        T.dom.dySub = el('span', { class: 'panel-sub' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'kn-dy-title', text: 'Dynamic analysis' }), T.dom.dySub
        ]));
        T.dom.dyOther = el('div');
        panel.appendChild(T.dom.dyOther);

        const body = el('div');
        T.dom.dyBody = body;
        // toolbar: reconstruct all frames
        T.dom.dyBtn = w().button({ label: 'Reconstruct all frames', kind: 'primary', size: 'sm', onClick: reconAll,
            title: 'Reconstruct every frame with the current Reconstruction settings, to measure time-activity curves on the images' });
        T.dom.dyProg = el('div', { class: 'kn-progress', role: 'progressbar', 'aria-label': 'Reconstruction of all frames', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true },
            [T.dom.dyProgFill = el('div', { class: 'kn-progress-fill' })]);
        T.dom.dyStatus = el('span', { class: 'kn-status', 'aria-live': 'polite' });
        body.appendChild(el('div', { class: 'kn-dyn-tools' }, [T.dom.dyBtn, T.dom.dyProg, T.dom.dyStatus]));

        const sel = makeRoiSelects();
        body.appendChild(el('div', { class: 'controls kn-roi-row' }, [sel.t, sel.r]));

        // TACs and input function
        const tacFig = el('div', { class: 'kn-figure' });
        T.dom.dyChips = el('div', { class: 'kn-chips', role: 'group', 'aria-label': 'Regions shown' });
        T.dom.dyUnits = w().segmented({ ariaLabel: 'Units', size: 'sm', value: T.dyn.units,
            options: [{ value: 'conc', label: 'kBq/mL' }, { value: 'suv', label: 'SUV' }], onChange: function (v) { T.dyn.units = v; renderDynamic(); } });
        T.dom.dyRange = w().segmented({ ariaLabel: 'Time range', size: 'sm', value: T.dyn.range,
            options: [{ value: 'all', label: 'Whole scan' }, { value: 'early', label: 'Early' }], onChange: function (v) { T.dyn.range = v; renderDynamic(); } });
        tacFig.appendChild(el('div', { class: 'kn-fig-head' }, [el('span', { class: 'kn-fig-title', text: 'Time-activity curves' }), el('span', { class: 'row' }, [T.dom.dyUnits, T.dom.dyRange])]));
        tacFig.appendChild(T.dom.dyChips);
        // The plot widget reads its options object at every draw, so the
        // axis labels can follow the units and the method.
        T.dom.dyTacOpts = { height: 250, xlabel: 'Time after injection (min)', ylabel: 'Concentration (kBq/mL)', framed: true };
        T.dom.dyTacPlot = w().plot(tacFig, T.dom.dyTacOpts);
        tacFig.appendChild(el('p', { class: 'note mt-1', text: 'Points: measured on the reconstructed frames. Dashed lines: the true frame means (noise-free, infinitely sharp).' }));

        const inFig = el('div', { class: 'kn-figure' });
        T.dom.dyInput = w().segmented({ ariaLabel: 'Input function', size: 'sm', value: T.dyn.input,
            options: [{ value: 'arterial', label: 'Arterial sampling', title: 'The true plasma curve, as blood samples from an artery would give it' },
                { value: 'idif', label: 'Image-derived', title: 'The venous sinus ROI on the reconstructed frames' }],
            onChange: function (v) { T.dyn.input = v; renderDynamic(); } });
        inFig.appendChild(el('div', { class: 'kn-fig-head' }, [el('span', { class: 'kn-fig-title', text: 'Input function' }), T.dom.dyInput]));
        T.dom.dyInOpts = { height: 250, xlabel: 'Time after injection (min)', ylabel: 'Plasma (kBq/mL)', framed: true };
        T.dom.dyInPlot = w().plot(inFig, T.dom.dyInOpts);
        T.dom.dyInNote = el('p', { class: 'note mt-1' });
        inFig.appendChild(T.dom.dyInNote);
        body.appendChild(el('div', { class: 'grid-2' }, [tacFig, inFig]));

        // graphical analysis and results
        const gaFig = el('div', { class: 'kn-figure' });
        T.dom.dyGaTitle = el('span', { class: 'kn-fig-title' });
        T.dom.dyTStar = w().slider({ label: 'Fit from t*', min: 2 * MIN, max: 60 * MIN, step: MIN, value: 20 * MIN, scale: 1 / MIN, unit: 'min',
            hint: 'The fit uses frames whose mid-time is at least t*, when the plot has become a straight line',
            onChange: function (v) { const g = T.dyn.method; if (g) T.dyn.tStar[g] = v; renderDynamic(); } });
        T.dom.dyK2 = w().toggle({ label: 'Include k₂′ of the reference', checked: T.dyn.useK2,
            hint: 'The Logan reference method adds Cref/k2′ to the x axis; leaving it out is a common approximation',
            onChange: function (b) { T.dyn.useK2 = b; renderDynamic(); } });
        gaFig.appendChild(el('div', { class: 'kn-fig-head' }, [T.dom.dyGaTitle]));
        gaFig.appendChild(el('div', { class: 'row mb-1' }, [el('div', { style: { flex: '1 1 220px', minWidth: '0' } }, [T.dom.dyTStar]), T.dom.dyK2]));
        T.dom.dyGaOpts = { height: 260, framed: true, xlabel: '', ylabel: '' };
        T.dom.dyGaPlot = w().plot(gaFig, T.dom.dyGaOpts);
        T.dom.dyGaNote = el('p', { class: 'note mt-1' });
        gaFig.appendChild(T.dom.dyGaNote);
        const resFig = el('div', { class: 'kn-figure' });
        resFig.appendChild(el('div', { class: 'kn-fig-head' }, [el('span', { class: 'kn-fig-title', text: 'Results' })]));
        T.dom.dyResults = el('div');
        resFig.appendChild(T.dom.dyResults);
        body.appendChild(el('div', { class: 'split kn-gap' }, [gaFig, resFig]));
        body.appendChild(el('p', { class: 'simplification', text: 'Honest simplifications: the blood input is the parent tracer with no metabolites, plasma equals whole blood, the image-derived input comes from the confluence of the sinuses (about 9 mm across, so partial volume lowers its peak), and frames are reconstructed with the current Reconstruction settings.' }));
        panel.appendChild(body);
        return panel;
    }

    function reconAll() {
        if (!PET.actions || !PET.actions.reconstructAllFrames) return;
        const st = PET.state;
        if (!st.acq) { acquireNow(); return; }
        T.all.error = null;
        T.all.optsKey = JSON.stringify(st.recon);
        T.all.busy = true; T.all.frac = 0;
        syncAllStatus();
        PET.actions.reconstructAllFrames().then(function (r) {
            T.all.busy = false;
            if (!r && !T.all.error && PET.state.acq === st.acq) T.all.error = null;
            syncAllStatus();
            markDirty('dynamic');
        });
    }
    function syncAllStatus() {
        const D = T.dom;
        if (!D.dyBtn) return;
        const st = PET.state, have = st.reconAll && st.reconAll.frames && st.acq && st.reconAll.frames.length === st.acq.frames.length;
        D.dyProg.hidden = !T.all.busy;
        D.dyProgFill.style.width = (100 * U.clamp(T.all.frac || 0, 0, 1)).toFixed(1) + '%';
        D.dyProg.setAttribute('aria-valuenow', String(Math.round(100 * (T.all.frac || 0))));
        D.dyBtn.disabled = T.all.busy || !st.acq || !!st.scanning;
        const changed = have && T.all.optsKey && T.all.optsKey !== JSON.stringify(st.recon);
        D.dyBtn.textContent = have ? (changed ? 'Reconstruct again with the new settings' : 'Reconstruct all frames again') : 'Reconstruct all frames';
        if (have && !changed) D.dyBtn.classList.remove('btn-primary'); else D.dyBtn.classList.add('btn-primary');
        let msg;
        if (T.all.busy) msg = 'Reconstructing ' + (st.acq ? st.acq.frames.length + ' frames' : 'frames') + '… ' + Math.round(100 * (T.all.frac || 0)) + ' %';
        else if (T.all.error) msg = 'Failed: ' + T.all.error;
        else if (st.scanning) msg = 'Waiting for the scan to finish.';
        else if (have) msg = st.reconAll.frames.length + ' frames reconstructed (' + (st.reconAll.method || st.recon.method || '').toUpperCase() + ', ' + st.reconAll.n + ' × ' + st.reconAll.n + ')' + (changed ? '; the Reconstruction settings have changed since.' : '.');
        else msg = 'Only the true curves are shown until every frame is reconstructed (a few seconds).';
        D.dyStatus.textContent = msg;
    }

    function dynCompute() {
        const st = PET.state, prog = currentProgram();
        if (!K() || !A()) return { kind: 'error', message: 'The kinetics or analysis module did not load.' };
        if (!prog) return { kind: 'noprog' };
        if (!prog.dynamic) return { kind: 'static', prog: prog };
        const acq = st.acq;
        if (!acq || acq.program !== prog || !(acq.frames && acq.frames.length > 1)) return { kind: 'waiting', prog: prog };
        const ph = phantomOf(acq);
        if (!ph) return { kind: 'error', message: 'The phantom of the last scan could not be rebuilt.' };
        if (ph.kind !== 'brain' || !prog.tracer) return { kind: 'solution', prog: prog };
        const frames = acq.frames, nF = frames.length;
        const tacs = acqTACs(acq, ph);
        const t = Float64Array.from(frames, function (f) { return (f.t0 + f.t1) / 2; });
        const tMin = Float64Array.from(t, function (v) { return v / MIN; });
        const ids = effectiveIds(ph), dT = findDef(ph, ids.target), dR = findDef(ph, ids.reference);
        const sinusDef = findDef(ph, 'sinus'), wmDef = findDef(ph, 'white_matter') || findDef(ph, 'wm');
        const fm = K().frameMeans(tacs, frames);
        const trueOf = function (def) { return Float64Array.from(fm, function (v) { return roiValue(ph, v, def); }); };
        const cpArt = K().framePlasma(tacs, frames);
        const out = { kind: 'dynamic', prog: prog, acq: acq, ph: ph, frames: frames, t: t, tMin: tMin, tacs: tacs, dT: dT, dR: dR, sinusDef: sinusDef, wmDef: wmDef,
            trueT: trueOf(dT), trueR: trueOf(dR), trueWM: wmDef ? trueOf(wmDef) : null, cpArt: cpArt, suvK: acq.dose > 0 ? (acq.weight || 70) * 1000 / acq.dose : NaN };
        const tm = tracerInfo(prog.tracer);
        out.model = tm ? tm.model : null;
        out.method = out.model === '2tci' ? 'patlak' : (out.model === '2tcr' ? 'logan' : (out.model === '1tc' ? 'onetc' : null));
        out.kt = roiKinetics(prog.tracer, ph.condition, ph, dT);
        out.kr = roiKinetics(prog.tracer, ph.condition, ph, dR);
        // measured TACs from the frame images
        const all = st.reconAll;
        if (all && all.frames && all.frames.length === nF) {
            const ids2 = [dT.id, dR.id, sinusDef ? sinusDef.id : null, wmDef ? wmDef.id : null].filter(Boolean);
            const key = ids2.join('|');
            let meas = T.cache.meas;
            if (!meas || meas.res !== all || meas.ph !== ph || meas.key !== key) {
                const r = A().tacs(all.frames, ph, all.n, ids2, frames);
                meas = T.cache.meas = { res: all, ph: ph, key: key, values: r.values };
            }
            out.meas = {
                t: meas.values[dT.id], r: meas.values[dR.id],
                sinus: sinusDef ? meas.values[sinusDef.id] : null, wm: wmDef ? meas.values[wmDef.id] : null
            };
            const decayOn = !(st.recon && st.recon.corrections && st.recon.corrections.decay === false);
            out.decayOn = decayOn;
        }
        // input functions
        out.input = T.dyn.input === 'idif' && out.meas && out.meas.sinus ? 'idif' : 'arterial';
        const cpImg = out.input === 'idif' ? out.meas.sinus : cpArt;
        if (out.meas && out.meas.sinus) {
            out.idifPeak = maxOf(out.meas.sinus) / maxOf(cpArt);
            out.idifArea = trapz(t, out.meas.sinus) / trapz(t, cpArt);
        }
        // graphical analysis
        const lastMid = t[nF - 1];
        if (out.method === 'patlak' || out.method === 'logan') {
            const def = out.method === 'patlak' ? 20 * MIN : 30 * MIN;
            let ts = T.dyn.tStar[out.method];
            if (!isFinite(ts)) ts = def;
            const maxTs = Math.max(2 * MIN, t[Math.max(0, nF - 3)]);
            out.tStar = U.clamp(ts, 2 * MIN, maxTs);
            out.tStarMax = maxTs;
        }
        if (out.method === 'patlak') {
            out.gTrue = K().patlak(t, out.trueT, cpArt, out.tStar);
            if (out.meas) out.gImg = K().patlak(t, out.meas.t, cpImg, out.tStar);
            out.truth = out.kt.KiVoxel;
        } else if (out.method === 'logan') {
            out.k2ref = out.kr.k2;
            const k2 = T.dyn.useK2 ? out.k2ref : 0;
            out.gTrue = K().logan(t, out.trueT, out.trueR, k2, out.tStar);
            if (out.meas) out.gImg = K().logan(t, out.meas.t, out.meas.r, k2, out.tStar);
            out.truth = 1 + out.kt.BPND;
            out.eq = out.kt.VT / out.kr.VT;
        } else if (out.method === 'onetc') {
            const inpTrue = { t: tacs.t, dt: tacs.dt, cp: tacs.plasma };
            out.fTrue = fit1TC(frames, out.trueT, inpTrue, acq.isotope);
            if (out.meas) {
                let inp = inpTrue;
                if (out.input === 'idif') inp = interpInput(tacs, t, out.meas.sinus);
                out.fImg = fit1TC(frames, out.meas.t, inp, acq.isotope);
            }
            out.truth = out.kt.flow;
        }
        // SUVR of the late frames
        const win = scanWindow(prog);
        if (win) {
            out.win = win;
            const wm = K().frameMeans(tacs, [{ t0: win.t0, t1: win.t1 }])[0];
            out.suvrTrue = roiValue(ph, wm, dR) > 0 ? roiValue(ph, wm, dT) / roiValue(ph, wm, dR) : NaN;
            if (out.meas) {
                let st2 = 0, sr = 0;
                for (let k = win.k0 || 0; k < nF; k++) { const wgt = frames[k].decayIntegral || (frames[k].t1 - frames[k].t0); st2 += wgt * out.meas.t[k]; sr += wgt * out.meas.r[k]; }
                out.suvrImg = sr > 0 ? st2 / sr : NaN;
            }
        }
        return out;
    }
    /* A continuous input from frame values: linear between frame
       mid-times, from zero at injection, on the grid of the true curves. */
    function interpInput(tacs, tm, v) {
        const n = tacs.t.length, cp = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const tt = tacs.t[i];
            let val;
            if (tt <= 0) val = 0;
            else if (tt <= tm[0]) val = v[0] * tt / tm[0];
            else {
                let k = 0;
                while (k < tm.length - 1 && tm[k + 1] < tt) k++;
                val = k >= tm.length - 1 ? v[tm.length - 1] : v[k] + (v[k + 1] - v[k]) * (tt - tm[k]) / (tm[k + 1] - tm[k]);
            }
            cp[i] = Math.max(0, val);
        }
        return { t: tacs.t, dt: tacs.dt, cp: cp };
    }

    function renderDynamic() {
        if (!T.dom.dyBody) return;
        const D = T.dom;
        D.dyOther.textContent = '';
        let Z;
        try { Z = dynCompute(); } catch (e) { Z = { kind: 'error', message: e.message || String(e), err: e }; if (root.console) root.console.error('[kinetics tab] dynamic analysis failed:', e); }
        const showBody = Z.kind === 'dynamic';
        D.dyBody.hidden = !showBody;
        syncAllStatus();
        if (Z.kind === 'error') { D.dySub.textContent = ''; D.dyOther.appendChild(w().errorCard('Dynamic analysis is unavailable', Z.err || { message: Z.message })); return; }
        if (Z.kind === 'noprog') { D.dySub.textContent = ''; D.dyOther.appendChild(w().empty('Load a protocol first.')); return; }
        if (Z.kind === 'static' || Z.kind === 'solution') {
            D.dySub.textContent = Z.kind === 'static' ? 'the current protocol is static (one frame)' : 'needs a brain protocol';
            D.dyOther.appendChild(staticExplainer(Z.kind));
            return;
        }
        if (Z.kind === 'waiting') {
            D.dySub.textContent = '';
            const scanning = PET.state.scanning;
            D.dyOther.appendChild(emptyWithAction(scanning ? 'The dynamic scan is running…' : 'This dynamic protocol has not been scanned yet.', scanning ? null : 'Acquire', acquireNow));
            return;
        }
        D.dySub.textContent = Z.frames.length + ' frames, ' + span(Z.frames[0].t0, Z.frames[Z.frames.length - 1].t1) + ' · ' + tracerLabel(Z.prog.tracer);
        renderChips(Z);
        renderTacPlot(Z);
        renderInputPlot(Z);
        renderGraphical(Z);
        renderResults(Z);
    }

    function staticExplainer(kind) {
        const box = el('div');
        box.appendChild(el('p', { html: kind === 'static'
            ? 'A static scan is one snapshot: it measures how much tracer is there, not how it got there. A <strong>dynamic</strong> scan starts at the injection and records a series of frames, short ones while things change fast and long ones later, so every region gets a time-activity curve. With the input function (the tracer in arterial plasma) those curves give the rate constants, and graphical methods turn them into the quantities we want: K<sub>i</sub> of FDG from a Patlak plot, the DVR of amyloid or dopamine-transporter binding from a Logan plot with a reference region, cerebral blood flow from [¹⁵O]water. Load a dynamic protocol (the scan runs by itself):'
            : 'Dynamic analysis follows a tracer through a brain. Phantoms filled with a solution do not change with time. Load a dynamic brain protocol (the scan runs by itself):' }));
        const grid = el('div', { class: 'kn-presets' });
        DYN_PRESETS.forEach(function (p) {
            if (PET.presets && PET.presets.get && !PET.presets.get(p.id)) return;
            const b = el('button', { type: 'button', class: 'kn-preset' }, [el('strong', { text: p.title }), el('span', { text: p.text })]);
            b.addEventListener('click', function () {
                const analysis = p.id === 'pe2i_dynamic' ? { target: 'putamen_l', reference: 'cereb_gm' } : (p.id === 'pib_dynamic' ? { target: 'gm_frontal', reference: 'cereb_gm' } : { target: 'cortex', reference: 'cereb_gm' });
                loadPresetWith(p.id, analysis);
                notify('Loaded ' + p.title + '. When the scan is done, press Reconstruct all frames.', 'info');
            });
            grid.appendChild(b);
        });
        box.appendChild(grid);
        return box;
    }

    const ROI_STYLE = { target: { color: 'var(--c1)', name: 'target' }, reference: { color: 'var(--c2)', name: 'reference' },
        blood: { color: 'var(--c8)', name: 'blood (sinus)' }, extra: { color: 'var(--c4)', name: 'white matter' } };
    function renderChips(Z) {
        const host = T.dom.dyChips;
        const items = [['target', Z.dT.name], ['reference', Z.dR.name]];
        if (Z.sinusDef) items.push(['blood', 'Blood (venous sinus)']);
        if (Z.wmDef && Z.wmDef.id !== Z.dT.id && Z.wmDef.id !== Z.dR.id && canonical(Z.ph, Z.wmDef.id) !== canonical(Z.ph, Z.dT.id) && canonical(Z.ph, Z.wmDef.id) !== canonical(Z.ph, Z.dR.id)) items.push(['extra', Z.wmDef.name]);
        const key = items.map(function (i) { return i.join(':'); }).join('|');
        if (host.__key === key) return;
        host.__key = key;
        host.textContent = '';
        items.forEach(function (it) {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = !!T.dyn.show[it[0]];
            cb.addEventListener('change', function () { T.dyn.show[it[0]] = cb.checked; renderDynamic(); });
            host.appendChild(el('label', { class: 'kn-chip' }, [cb, el('span', { class: 'swatch', style: { background: resolveVar(ROI_STYLE[it[0]].color) }, 'aria-hidden': 'true' }), it[1]]));
        });
    }
    function resolveVar(v) { const m = /^var\((--[\w-]+)\)$/.exec(v); return m ? U.cssVar(m[1], '#888') : v; }

    function unitOf(Z) {
        if (T.dyn.units === 'suv' && isFinite(Z.suvK)) return { k: Z.suvK, label: 'SUV' };
        return { k: 1e-3, label: 'kBq/mL' };
    }
    function xRange(Z) {
        const end = Z.frames[Z.frames.length - 1].t1 / MIN;
        if (T.dyn.range === 'early') return [0, Math.min(5, end / 3)];
        return [0, end];
    }
    const sc = function (a, k) { return a ? Float64Array.from(a, function (v) { return v * k; }) : null; };
    const POINTS_ONLY = 0.001;
    function renderTacPlot(Z) {
        const u = unitOf(Z), S = [];
        const add = function (key, meas, tru) {
            if (!T.dyn.show[key]) return;
            const st = ROI_STYLE[key];
            if (meas) S.push({ x: Z.tMin, y: sc(meas, u.k), color: st.color, label: st.name + ', measured', width: 1.2, points: 3 });
            if (tru) S.push({ x: Z.tMin, y: sc(tru, u.k), color: st.color, label: st.name + ', true', width: 1.6, dash: true });
        };
        add('target', Z.meas && Z.meas.t, Z.trueT);
        add('reference', Z.meas && Z.meas.r, Z.trueR);
        add('blood', Z.meas && Z.meas.sinus, Z.cpArt);
        add('extra', Z.meas && Z.meas.wm, Z.trueWM);
        T.dom.dyTacOpts.ylabel = 'Concentration (' + u.label + ')';
        T.dom.dyTacPlot.draw(S, { xlim: xRange(Z), includeZero: true, legend: S.length > 1 });
        T.dom.dyTacPlot.canvas.setAttribute('aria-label', 'Time-activity curves in ' + u.label + ': measured points and true frame means');
    }
    function renderInputPlot(Z) {
        const u = unitOf(Z), S = [];
        const tC = Float64Array.from(Z.tacs.t, function (v) { return v / MIN; });
        S.push({ x: tC, y: sc(Z.tacs.plasma, u.k), color: 'var(--c8)', label: 'true plasma', width: 1.3 });
        S.push({ x: Z.tMin, y: sc(Z.cpArt, u.k), color: 'var(--c8)', label: 'arterial samples (frame means)', width: POINTS_ONLY, points: 3.5 });
        if (Z.meas && Z.meas.sinus) S.push({ x: Z.tMin, y: sc(Z.meas.sinus, u.k), color: 'var(--c7)', label: 'image-derived (sinus ROI)', width: 1.3, points: 3 });
        T.dom.dyInOpts.ylabel = 'Plasma (' + u.label + ')';
        T.dom.dyInPlot.draw(S, { xlim: xRange(Z), includeZero: true, legend: true });
        T.dom.dyInPlot.canvas.setAttribute('aria-label', 'Input function in ' + u.label);
        let note;
        if (Z.meas && Z.meas.sinus) {
            note = 'The image-derived curve reaches ' + fmt(100 * Z.idifPeak, 2) + ' % of the true peak and ' + fmt(100 * Z.idifArea, 2) +
                ' % of its area: the sinus is only a few pixels across, so partial volume and the short, noisy early frames flatten it. ' +
                (Z.method === 'logan' ? 'The Logan reference method needs no blood input, so this choice does not change it.' : 'Fits that use it inherit the error: an input that is too low makes K' + (Z.method === 'patlak' ? 'i' : '1') + ' too high.');
        } else note = 'Arterial sampling (the true plasma) is shown. Reconstruct all frames to measure the image-derived input on the venous sinus.';
        if (T.dyn.input === 'idif' && !(Z.meas && Z.meas.sinus)) note += ' Until then the analysis uses the arterial input.';
        T.dom.dyInNote.textContent = note;
    }
    function renderGraphical(Z) {
        const D = T.dom, P = D.dyGaPlot;
        D.dyTStar.hidden = !(Z.method === 'patlak' || Z.method === 'logan');
        D.dyK2.hidden = Z.method !== 'logan';
        T.dyn.method = Z.method;
        if (Z.method === 'patlak' || Z.method === 'logan') {
            D.dyTStar.setRange(2 * MIN, Math.max(3 * MIN, Z.tStarMax), MIN);
            D.dyTStar.set(Z.tStar);
        }
        const S = [];
        const fitLine = function (g, slopeKey, color, label, dash) {
            if (!g || !isFinite(g[slopeKey]) || g.fitFrom >= g.x.length) return null;
            const xs = g.x.slice(g.fitFrom), x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
            const b = g[slopeKey], a = slopeKey === 'Ki' ? g.V0 : g.intercept;
            return { x: [x0, x1], y: [a + b * x0, a + b * x1], color: color, label: label, width: 2, dash: dash };
        };
        let xlabel = '', ylabel = '', title = '', note = '';
        if (Z.method === 'patlak') {
            title = 'Patlak plot of ' + Z.dT.name + ' (FDG is trapped)';
            xlabel = '∫Cp dt / Cp (min)'; ylabel = 'Ct / Cp';
            S.push({ x: Z.gTrue.x, y: Z.gTrue.y, color: 'var(--c3)', label: 'true TACs', width: POINTS_ONLY, points: 3.5 });
            if (Z.gImg) S.push({ x: Z.gImg.x, y: Z.gImg.y, color: 'var(--c1)', label: 'image TACs', width: POINTS_ONLY, points: 3.5 });
            S.push(fitLine(Z.gTrue, 'Ki', 'var(--c3)', 'fit, true: Ki ' + fix(Z.gTrue.Ki, 3), false));
            if (Z.gImg) S.push(fitLine(Z.gImg, 'Ki', 'var(--c1)', 'fit, image: Ki ' + fix(Z.gImg.Ki, 3), true));
            note = 'Once free FDG in tissue has equilibrated with plasma, Ct/Cp grows linearly with "normalised time" ∫Cp/Cp: the slope is the net influx rate Ki and the intercept the free distribution volume plus blood. Points from t* = ' + minutes(Z.tStar) + ' min are fitted.';
        } else if (Z.method === 'logan') {
            title = 'Logan plot of ' + Z.dT.name + ', reference ' + Z.dR.name;
            xlabel = '(∫Cref dt + Cref/k₂′) / Ct (min)'; ylabel = '∫Ct dt / Ct (min)';
            S.push({ x: Z.gTrue.x, y: Z.gTrue.y, color: 'var(--c3)', label: 'true TACs', width: POINTS_ONLY, points: 3.5 });
            if (Z.gImg) S.push({ x: Z.gImg.x, y: Z.gImg.y, color: 'var(--c1)', label: 'image TACs', width: POINTS_ONLY, points: 3.5 });
            S.push(fitLine(Z.gTrue, 'DVR', 'var(--c3)', 'fit, true: DVR ' + fix(Z.gTrue.DVR, 3), false));
            if (Z.gImg) S.push(fitLine(Z.gImg, 'DVR', 'var(--c1)', 'fit, image: DVR ' + fix(Z.gImg.DVR, 3), true));
            note = 'After t* the Logan plot of a reversible tracer is a straight line whose slope is the DVR = V<sub>T</sub>/V<sub>T,ref</sub>, with no blood sampling: the reference region stands in for the plasma. ' +
                (T.dyn.useK2 ? 'k₂′ = ' + fix(Z.k2ref, 3) + ' /min of the reference, from its model.' : 'The Cref/k₂′ term is left out.') + ' Points from t* = ' + minutes(Z.tStar) + ' min are fitted.';
        } else if (Z.method === 'onetc') {
            title = 'One-tissue fit of ' + Z.dT.name + ' ([¹⁵O]water)';
            xlabel = 'Time after injection (min)'; ylabel = 'Concentration (kBq/mL)';
            const model = function (f, inpCp) {
                const r = K().tissue({ model: '1tc', K1: f.K1, k2: f.k2, vb: f.vb }, inpCp, Z.tacs.t);
                return K().frameMeans({ t: Z.tacs.t, dt: Z.tacs.dt, isotope: Z.acq.isotope, regions: [r.ct] }, Z.frames).map(function (v) { return v[0] * 1e-3; });
            };
            S.push({ x: Z.tMin, y: sc(Z.trueT, 1e-3), color: 'var(--c3)', label: 'true TAC', width: POINTS_ONLY, points: 3.5 });
            S.push({ x: Z.tMin, y: Float64Array.from(model(Z.fTrue, Z.tacs.plasma)), color: 'var(--c3)', label: 'fit, true: K1 ' + fix(Z.fTrue.K1, 3), width: 1.6 });
            if (Z.fImg && Z.meas) {
                const inp = Z.input === 'idif' ? interpInput(Z.tacs, Z.t, Z.meas.sinus).cp : Z.tacs.plasma;
                S.push({ x: Z.tMin, y: sc(Z.meas.t, 1e-3), color: 'var(--c1)', label: 'image TAC', width: POINTS_ONLY, points: 3.5 });
                S.push({ x: Z.tMin, y: Float64Array.from(model(Z.fImg, inp)), color: 'var(--c1)', label: 'fit, image: K1 ' + fix(Z.fImg.K1, 3), width: 1.6, dash: true });
            }
            note = 'Water crosses the blood-brain barrier freely, so the one-tissue model fits: K₁ is the blood flow and K₁/k₂ the partition coefficient. The fit solves for K₁, k₂ and the blood volume vb.';
        } else {
            title = 'No graphical method for this tracer';
        }
        D.dyGaTitle.textContent = title;
        const opts = { legend: true };
        if ((Z.method === 'patlak' || Z.method === 'logan') && Z.gTrue && Z.gTrue.fitFrom < Z.gTrue.x.length) opts.markers = [{ x: Z.gTrue.x[Z.gTrue.fitFrom], label: 't*', color: 'var(--muted)' }];
        if (Z.method === 'logan' || Z.method === 'patlak') {
            // keep the axes on the meaningful part: the late points, not the first frame's extreme values
            let xmax = 0;
            [Z.gTrue, Z.gImg].forEach(function (g) { if (!g) return; for (let i = 0; i < g.x.length; i++) if (isFinite(g.x[i]) && g.t[i] >= 2 * MIN) xmax = Math.max(xmax, g.x[i]); });
            if (xmax > 0) opts.xlim = [0, xmax * 1.04];
            opts.includeZero = true;
        } else if (Z.method === 'onetc') opts.includeZero = true;
        D.dyGaOpts.xlabel = xlabel; D.dyGaOpts.ylabel = ylabel;
        P.draw(S.filter(Boolean), opts);
        P.canvas.setAttribute('aria-label', title);
        D.dyGaNote.innerHTML = note;
    }
    function renderResults(Z) {
        const host = T.dom.dyResults;
        host.textContent = '';
        const inputName = Z.input === 'idif' ? 'image-derived input' : 'arterial input';
        const cols = ['', 'True', 'True TACs', 'Image TACs'];
        const rows = [];
        const rel = function (est, tru) { return isFinite(est) && isFinite(tru) && tru !== 0 ? pct(est / tru - 1) : ''; };
        const est = function (v, tru, d) { return isFinite(v) ? { v: fix(v, d), sub: rel(v, tru) } : '-'; };
        const notes = [];
        if (Z.method === 'patlak') {
            rows.push({ label: 'Ki, Patlak', unit: 'mL/min/mL', hint: 'True value: (1 - vb) Ki of the target, what a Patlak plot of voxel data measures',
                cells: [{ v: fix(Z.truth, 4), hi: true }, est(Z.gTrue.Ki, Z.truth, 4), Z.gImg ? est(Z.gImg.Ki, Z.truth, 4) : '-'] });
            rows.push({ label: 'r² of the fit', cells: ['', fix(Z.gTrue.r2, 4), Z.gImg ? fix(Z.gImg.r2, 4) : '-'] });
            if (isFinite(Z.suvrTrue)) rows.push({ label: 'SUVR, late frames', sep: true, hint: span(Z.win.t0, Z.win.t1) + '; the true column is the Ki ratio, which SUVR approaches as free FDG clears',
                cells: [{ v: fix(Z.kt.KiVoxel / Z.kr.KiVoxel, 2), title: 'Ki ratio, target / reference' }, est(Z.suvrTrue, Z.kt.KiVoxel / Z.kr.KiVoxel, 2), Z.meas ? est(Z.suvrImg, Z.kt.KiVoxel / Z.kr.KiVoxel, 2) : '-'] });
            notes.push('Image estimate with the ' + inputName + '.');
            if (Z.gImg && isFinite(Z.gImg.Ki)) {
                if (Z.input === 'idif' && Z.idifArea < 0.9) notes.push('The image-derived input is too low (area ' + fmt(100 * Z.idifArea, 2) + ' %), which inflates Ki; arterial sampling avoids that.');
                const recT = Z.meas && isFinite(Z.meas.t[Z.meas.t.length - 1]) ? Z.meas.t[Z.meas.t.length - 1] / Z.trueT[Z.trueT.length - 1] : NaN;
                if (isFinite(recT) && recT < 0.95) notes.push('The target curve on the images reads about ' + fmt(100 * recT, 2) + ' % of its true value in the last frame (partial volume), which lowers Ki by about as much.');
            }
        } else if (Z.method === 'logan') {
            rows.push({ label: 'DVR, Logan', hint: 'True value: 1 + BPND of the target', cells: [{ v: fix(Z.truth, 2), hi: true }, est(Z.gTrue.DVR, Z.truth, 2), Z.gImg ? est(Z.gImg.DVR, Z.truth, 2) : '-'] });
            rows.push({ label: 'BPND = DVR − 1', cells: [fix(Z.truth - 1, 2), est(Z.gTrue.DVR - 1, Z.truth - 1, 2), Z.gImg ? est(Z.gImg.DVR - 1, Z.truth - 1, 2) : '-'] });
            if (isFinite(Z.suvrTrue)) rows.push({ label: 'SUVR − 1, late frames', sep: true, hint: span(Z.win.t0, Z.win.t1) + ': what a static scan would report',
                cells: [fix(Z.truth - 1, 2), est(Z.suvrTrue - 1, Z.truth - 1, 2), Z.meas ? est(Z.suvrImg - 1, Z.truth - 1, 2) : '-'] });
            rows.push({ label: 'r² of the fit', cells: ['', fix(Z.gTrue.r2, 4), Z.gImg ? fix(Z.gImg.r2, 4) : '-'] });
            if (isFinite(Z.eq) && Math.abs(Z.eq / Z.truth - 1) > 0.015) notes.push('Logan measures V<sub>T</sub>/V<sub>T,ref</sub> = ' + fix(Z.eq, 3) + ' here, not 1 + BP<sub>ND</sub>: ' +
                (Z.kr.BPND > 0.05 ? 'the reference region has specific binding of its own.' : 'the target and the reference differ in nondisplaceable uptake (V<sub>ND</sub> ' + fix(Z.kt.VND, 2) + ' vs ' + fix(Z.kr.VND, 2) + ').'));
            if (isFinite(Z.suvrTrue) && Z.suvrTrue - 1 > 1.05 * (Z.truth - 1)) notes.push('The late SUVR overshoots the binding (transient equilibrium); the Logan slope does not.');
            if (Z.gTrue && isFinite(Z.gTrue.DVR) && Math.abs(Z.gTrue.DVR / Z.eq - 1) > 0.03) notes.push('Even on the true curves the Logan slope has not settled by the end of the scan: the tracer is slow to reach equilibrium, so a longer scan or a later t* helps.');
        } else if (Z.method === 'onetc') {
            rows.push({ label: 'Flow K₁', unit: 'mL/min/mL', cells: [{ v: fix(Z.truth, 3), hi: true }, est(Z.fTrue.K1, Z.truth, 3), Z.fImg ? est(Z.fImg.K1, Z.truth, 3) : '-'] });
            rows.push({ label: 'Partition K₁/k₂', unit: 'mL/mL', cells: [fix(Z.kt.VT, 2), est(Z.fTrue.VT, Z.kt.VT, 2), Z.fImg ? est(Z.fImg.VT, Z.kt.VT, 2) : '-'] });
            rows.push({ label: 'Blood volume vb', cells: ['', fmt(100 * Z.fTrue.vb, 2) + ' %', Z.fImg ? fmt(100 * Z.fImg.vb, 2) + ' %' : '-'] });
            notes.push('Image estimate with the ' + inputName + '.');
        } else {
            host.appendChild(w().empty('This tracer has no kinetic model for a graphical analysis.'));
            return;
        }
        host.appendChild(table3(cols, rows));
        if (!Z.meas) notes.unshift('Press <strong>Reconstruct all frames</strong> to add the estimates from the images.');
        if (Z.meas && Z.decayOn === false) notes.push('Decay correction is off, so later frames read too low and every estimate from the images is biased.');
        if (notes.length) host.appendChild(el('div', { class: 'callout kn-results-note' }, [el('ul', { style: { margin: 0, paddingLeft: '18px' } }, notes.map(function (n) { return el('li', { html: n }); }))]));
    }

    /* ============================================================
       wiring
       ============================================================ */
    function markDirty() {
        const parts = arguments.length ? Array.prototype.slice.call(arguments) : ['explorer', 'statics', 'overtime', 'dynamic'];
        parts.forEach(function (p) { T.dirty[p] = true; });
        if (T.visible) queueRender();
    }
    function queueRender() {
        if (T.renderQueued) return;
        T.renderQueued = true;
        setTimeout(function () { T.renderQueued = false; renderDirty(); }, 40);
    }
    function renderDirty() {
        if (!T.mounted || !T.visible) return;
        const ph = currentPhantom();
        try { refreshRoiSelects(ph); } catch (e) { /* menus keep their old options */ }
        if (T.dirty.explorer) { T.dirty.explorer = false; exRender(); }
        if (T.dirty.statics) { T.dirty.statics = false; renderStatic(); }
        if (T.dirty.overtime) { T.dirty.overtime = false; renderOverTime(); }
        if (T.dirty.dynamic) { T.dirty.dynamic = false; renderDynamic(); }
    }

    /* Follow the protocol: when the tracer changes, the explorer loads that
       tracer, and a target that was only the old tracer's suggestion moves
       to the new one's. */
    function onProgram() {
        const prog = currentProgram();
        const tr = prog && prog.tracer && K() && K().table && K().table[prog.tracer] ? prog.tracer : null;
        if (tr && tr !== T.lastTracer) {
            const prev = T.lastTracer;
            T.lastTracer = tr;
            T.ex.tracer = tr;
            T.ex.region = EX_REGION[tr] || T.ex.region;
            exLoad();
            const a = (PET.state && PET.state.analysis) || {};
            if (prev !== undefined && PET.state.phantomId === 'brain' && (a.target === SUGGESTED_TARGET[prev] || !a.target) && SUGGESTED_TARGET[tr] && a.target !== SUGGESTED_TARGET[tr]) {
                PET.actions.setAnalysis({ target: SUGGESTED_TARGET[tr] });
            }
        } else if (!tr && T.lastTracer === undefined) T.lastTracer = null;
        T.cache.long = null;
        markDirty();
    }
    function onPhantom() {
        const st = PET.state;
        if (st && st.phantomId === 'brain' && st.phantomOpts && st.phantomOpts.condition && st.phantomOpts.condition !== T.lastCondition) {
            T.lastCondition = st.phantomOpts.condition;
            T.ex.condition = st.phantomOpts.condition;
            exLoad();
        }
        T.cache.long = null;
        markDirty();
    }

    function mount(panel) {
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        panel.appendChild(buildConcept());
        const parts = [buildExplorer, buildStatic, buildOverTime, buildDynamic];
        parts.forEach(function (fn) {
            try { panel.appendChild(fn()); }
            catch (e) {
                if (root.console) root.console.error('[kinetics tab] a section failed to build:', e);
                panel.appendChild(w().errorCard('Part of this tab failed to start', e));
            }
        });
        T.mounted = true;
        // initial explorer state from the protocol and phantom
        const st = PET.state || {};
        if (st.phantomId === 'brain' && st.phantomOpts && st.phantomOpts.condition) { T.ex.condition = st.phantomOpts.condition; T.lastCondition = st.phantomOpts.condition; }
        const prog = currentProgram();
        if (prog && prog.tracer && K() && K().table && K().table[prog.tracer]) { T.ex.tracer = prog.tracer; T.ex.region = EX_REGION[prog.tracer] || T.ex.region; T.lastTracer = prog.tracer; }
        if (K()) exLoad();

        const bus = PET.bus;
        bus.on('program:compiled', onProgram);
        bus.on('phantom:changed', onPhantom);
        bus.on('preset:loaded', function () { markDirty(); });
        bus.on('scan:start', function () { T.all.error = null; markDirty('statics', 'dynamic'); });
        bus.on('scan:done', function () { T.reconPending = true; T.all.busy = false; markDirty('statics', 'dynamic'); });
        bus.on('scan:error', function () { markDirty('statics', 'dynamic'); });
        let lastPartial = 0;
        bus.on('recon:done', function (e) {
            if (e && e.partial) {
                const now = Date.now();
                if (now - lastPartial < 300) return;
                lastPartial = now;
            } else T.reconPending = false;
            markDirty('statics');
        });
        bus.on('recon:allstart', function () { T.all.busy = true; T.all.frac = 0; T.all.error = null; if (!T.all.optsKey) T.all.optsKey = JSON.stringify(PET.state.recon); syncAllStatus(); });
        bus.on('recon:allprogress', function (e) { T.all.frac = e && isFinite(e.frac) ? e.frac : T.all.frac; if (T.visible) syncAllStatus(); });
        bus.on('recon:alldone', function (e) {
            T.all.busy = false;
            T.all.error = e && e.error ? e.error : null;
            if (e && e.result) T.all.optsKey = JSON.stringify(PET.state.recon);
            syncAllStatus();
            markDirty('dynamic');
        });
        bus.on('reconopts:changed', function () { markDirty('statics', 'dynamic'); });
        bus.on('analysis:changed', function () { markDirty('statics', 'overtime', 'dynamic'); });
        bus.on('frame:changed', function () { markDirty('statics'); });
        bus.on('physics:changed', function () { markDirty('statics'); });
        bus.on('theme:changed', function () {
            if (!T.visible) { T.dirty.explorer = true; T.dirty.statics = true; T.dirty.dynamic = true; return; }
            exRender();
            if (T.dom.stWell) T.dom.stWell.redraw();
            const chips = T.dom.dyChips; if (chips) chips.__key = null;
            markDirty('dynamic');
        });
    }
    function onShow() {
        T.visible = true;
        // redraw everything: sizes may have changed while hidden (and on resize the shell calls onShow again)
        T.dirty.explorer = true; T.dirty.statics = true; T.dirty.overtime = true; T.dirty.dynamic = true;
        renderDirty();
    }
    function onHide() { T.visible = false; }

    PET.ui.registerTab({ id: 'kinetics', title: 'Dynamic & quantification', order: 80, mount: mount, onShow: onShow, onHide: onHide });

})(typeof window !== 'undefined' ? window : globalThis);
