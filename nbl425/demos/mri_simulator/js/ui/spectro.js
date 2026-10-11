/* ============================================================
   MRI Simulator, the Spectroscopy tab

   A non-localised proton FID and its spectrum, and the shim that
   decides how narrow the lines can be. From top to bottom:
     - the concept card (chemical shift, the FID, why water must be
       suppressed and why a head needs localisation);
     - the spectrum (ppm axis increasing to the left) beside the
       acquisition controls: preset, phantom and the sequence's own
       parameter sliders;
     - the FID with the apodisation window, beside the processing
       controls (line broadening, zero filling, phase, reference);
     - peaks and metrics (SNR, linewidth, NAA/Cr and Cho/Cr two ways),
       beside the sequence: its timing diagram and a compact editor;
     - the Shim panel (ARCHITECTURE.md section 7.1): one slider per shim
       term, auto-shim, a live field map, the field histogram and the
       water line, all updating while a slider moves.

   State lives in MRI.state.spectro and MRI.state.artifacts.b0; this
   file only calls MRI.actions and listens to the bus. Work done while
   the tab is hidden is limited to setting dirty flags; everything is
   drawn in onShow or on the next animation frame.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || !MRI.util || !MRI.ui.registerTab) return;
    const U = MRI.util;
    const doc = root.document;
    const C = MRI.const || {};
    const PPM_HZ = C.PPM_HZ || 127.73;
    const WATER_PPM = C.WATER_PPM || 4.7;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const now = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };

    const SHIM_IDS = ['z0', 'x', 'y', 'xy', 'x2y2', 'z2'];
    const CENTER_RADIUS = 0.06;            // m, the central auto-shim region
    const MAX_POINTS = 32768;              // NP x zero filling, so a processing change stays well under 100 ms

    /* ---------- small helpers ---------- */
    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function W() { return MRI.ui.w; }
    const TRY_IT = (MRI.ui.terms && MRI.ui.terms.tryIt) || 'Try it';
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function st() { return MRI.state; }
    function sp() { return MRI.state.spectro; }
    function num(v, sig) { return v === null || v === undefined || !isFinite(v) ? '–' : U.fmtNum(v, sig || 3); }
    function fixed(v, d) { return v === null || v === undefined || !isFinite(v) ? '–' : (Math.abs(v) < 0.5 * Math.pow(10, -d) ? (0).toFixed(d) : v.toFixed(d)); }
    function hz(v) { return !isFinite(v) ? '–' : (Math.abs(v) < 10 ? fixed(v, 2) : fixed(v, 1)); }
    function zeros() { const o = {}; SHIM_IDS.forEach(function (k) { o[k] = 0; }); return o; }
    function coeffsOf(b0) { const c = (b0 && b0.shimCoeffs) || {}, o = {}; SHIM_IDS.forEach(function (k) { o[k] = isFinite(+c[k]) ? +c[k] : 0; }); return o; }
    function toast(msg, kind) { if (W() && W().toast) W().toast(msg, kind); }
    function getPreset(id) { return MRI.presets && MRI.presets.get ? MRI.presets.get(id) : null; }
    function spectroPresets() {
        const P = MRI.presets;
        return Array.isArray(P) ? P.filter(function (p) { return p.group === 'spectroscopy'; }) : [];
    }
    function niceStep(raw) {
        if (!(raw > 0)) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const f = raw / mag;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    }
    function idxRange(ppm, lo, hi) {           // ppm ascends with index
        let a = 0, b = ppm.length - 1;
        while (a < ppm.length && ppm[a] < lo) a++;
        while (b >= 0 && ppm[b] > hi) b--;
        return [a, b];
    }
    function percentileOf(vals, q) {
        if (!vals.length) return NaN;
        const s = Float64Array.from(vals).sort();
        return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
    }

    /* Peaks of spectro.js (id, display label) and which species make them. */
    const PEAK_INFO = {
        water: { label: 'Water', needs: ['water'] },
        Cr2: { label: 'Cr', needs: ['Cr'] },
        mI: { label: 'mI', needs: ['mI'] },
        Cho: { label: 'Cho', needs: ['Cho'] },
        Cr: { label: 'Cr', needs: ['Cr'] },
        Glx: { label: 'Glx', needs: ['Glu', 'Gln'] },
        NAA: { label: 'NAA', needs: ['NAA'] },
        Lac: { label: 'Lac', needs: ['Lac'] },
        lipid13: { label: 'Lip 1.3', needs: ['lipid'] },
        lipid09: { label: 'Lip 0.9', needs: ['lipid'] }
    };
    function peakWindow(id) {
        const w = (MRI.spectro && MRI.spectro.peakWindows) || [];
        for (let i = 0; i < w.length; i++) if (w[i].id === id) return w[i];
        return null;
    }
    function nominalPpm(id) { const w = peakWindow(id); return w ? w.ppm : null; }
    function presentIds(spectrum) {
        const s = new Set();
        ((spectrum && spectrum.components) || []).forEach(function (c) { s.add(c.id); });
        return s;
    }
    function relevantPeaks(spectrum) {
        const have = presentIds(spectrum);
        return ((spectrum && spectrum.peaks) || []).filter(function (p) {
            const inf = PEAK_INFO[p.id];
            return inf && inf.needs.some(function (id) { return have.has(id); });
        });
    }

    const PHANTOM_TEXT = {
        braino: 'A 160 mm sphere of metabolite solution (NAA, Cr, Cho, mI, Glu, lactate) with no fat and no air: the standard MRS test object.',
        brain: 'An axial head slice: brain metabolites, but also scalp fat and skull marrow, and the field offset next to the frontal sinus.',
        waterfat: 'A water disk in an oil ring: water at 4.7 ppm and the lipid lines (main peak 1.3 ppm), 3.4 ppm (434 Hz) apart.'
    };
    const PHANTOM_IDS = ['braino', 'brain', 'waterfat'];

    /* ============================================================
       Styles (scoped under #tab-spectro)
       ============================================================ */
    const CSS = `
#tab-spectro {
    --syn-ev-rf: #b23a0a; --syn-ev-adc: #8a5805; --syn-ev-g: #1d4ed8;
    --syn-opt: #0b6a82; --syn-unit: #9c4508; --syn-str: #57534e; --syn-com: #5e6672; --syn-label: #be123c;
    --ed-fs: 12.5px; --ed-lh: 19px;
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) #tab-spectro {
        --syn-ev-rf: #fb923c; --syn-ev-adc: #facc15; --syn-ev-g: #7cb4f8;
        --syn-opt: #5fd4e8; --syn-unit: #fbbf6b; --syn-str: #b8b2aa; --syn-com: #8b98ab; --syn-label: #fda4af;
    }
}
:root[data-theme="dark"] #tab-spectro {
    --syn-ev-rf: #fb923c; --syn-ev-adc: #facc15; --syn-ev-g: #7cb4f8;
    --syn-opt: #5fd4e8; --syn-unit: #fbbf6b; --syn-str: #b8b2aa; --syn-com: #8b98ab; --syn-label: #fda4af;
}
@media (pointer: coarse) { #tab-spectro { --ed-fs: 16px; --ed-lh: 23px; } }

#tab-spectro .concept-formula .spec-rel { display: block; margin-top: 6px; font-size: 0.86rem; color: var(--muted); }
#tab-spectro .spec-body2 { font-size: 0.86rem; color: var(--muted); margin-top: 8px; }
#tab-spectro .panel-head .badge { flex: none; }
#tab-spectro .spec-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 16px; margin: 0 0 10px; }
#tab-spectro .spec-toolbar .ctl-seg { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
#tab-spectro .spec-toolbar .toggle { min-height: 26px; }
#tab-spectro .spec-toggles { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
#tab-spectro .spec-notes { display: grid; gap: 8px; margin-top: 12px; }
#tab-spectro .spec-notes .callout { margin: 0; }
#tab-spectro .spec-notes .callout .btn { margin: 6px 6px 0 0; }
#tab-spectro .spec-simpl { margin: 12px 0 0; }
#tab-spectro .spec-err { margin: 10px 0 0; }
#tab-spectro .spec-plotwrap { position: relative; }
#tab-spectro .spec-empty { margin-top: 0; }

#tab-spectro .spec-acq .stack { gap: 14px; }
#tab-spectro .spec-acq .seg { max-width: 100%; }
#tab-spectro .spec-desc { font-size: 0.82rem; color: var(--muted); line-height: 1.45; margin: 4px 0 0; }
#tab-spectro .spec-params .controls { --min: 220px; gap: 10px 18px; }
#tab-spectro .spec-msgs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
#tab-spectro .spec-msg {
    display: block; width: 100%; text-align: left; padding: 7px 9px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--bad-border); background: var(--bad-soft); color: var(--fg); font: 0.82rem/1.45 var(--font-sans);
}
#tab-spectro .spec-msg.is-warn { border-color: var(--warn-border); background: var(--warn-soft); }
#tab-spectro .spec-msg:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-spectro .spec-msg-where { font: 600 0.76rem var(--font-mono); color: var(--bad); margin-right: 6px; }
#tab-spectro .spec-msg.is-warn .spec-msg-where { color: var(--warn); }
#tab-spectro .spec-msg-hint { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 2px; }

#tab-spectro .spec-proc .controls { --min: 200px; gap: 10px 18px; }
#tab-spectro .spec-proc .row { margin-top: 12px; }
#tab-spectro .spec-auto-note { font-size: 0.78rem; color: var(--muted); margin-top: 4px; }

/* The peak table: a container, so columns drop by the width it actually
   has (not the viewport), and an edge shadow while columns lie beyond. */
#tab-spectro .spec-table-wrap {
    overflow-x: auto; margin: 0; container-type: inline-size; border-radius: 6px;
    background:
        linear-gradient(to right, var(--card), var(--card)) left / 18px 100% no-repeat local,
        linear-gradient(to left, var(--card), var(--card)) right / 18px 100% no-repeat local,
        radial-gradient(farthest-side at 0 50%, var(--shadow-edge, rgba(120, 130, 150, 0.45)), transparent) left / 10px 100% no-repeat scroll,
        radial-gradient(farthest-side at 100% 50%, var(--shadow-edge, rgba(120, 130, 150, 0.45)), transparent) right / 10px 100% no-repeat scroll;
}
#tab-spectro .spec-table-wrap:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-spectro .spec-table-wrap.is-overflow { box-shadow: inset -1px 0 0 var(--border); }
@container (max-width: 460px) {
    #tab-spectro .spec-table .col-exp { display: none; }
    #tab-spectro .spec-table th, #tab-spectro .spec-table td { padding: 5px 4px; }
    #tab-spectro .spec-table tbody th { white-space: normal; min-width: 5.5em; }
}
@container (max-width: 300px) { #tab-spectro .spec-table .col-ppm { display: none; } }
#tab-spectro .spec-table tr.is-unresolved td, #tab-spectro .spec-table tr.is-unresolved th { color: var(--muted); }
#tab-spectro .spec-nr { display: block; font: 500 0.7rem var(--font-sans); color: var(--muted); }
#tab-spectro .spec-table td.spec-foot-note { white-space: normal; text-align: left; font: 0.74rem/1.4 var(--font-sans); color: var(--muted); padding-top: 8px; }
#tab-spectro .spec-viewbar { margin-bottom: 6px; }
#tab-spectro .spec-acq-note { font-size: 0.8rem; }
#tab-spectro .spec-met-notes:empty { display: none; }
@media (max-width: 900px) { #tab-spectro .spec-row2 { grid-template-columns: minmax(0, 1fr); } }
#tab-spectro .spec-table { width: 100%; border-collapse: collapse; font-size: 0.84rem; }
#tab-spectro .spec-table caption { text-align: left; font-weight: 650; font-size: 0.82rem; padding-bottom: 6px; }
#tab-spectro .spec-table th, #tab-spectro .spec-table td { padding: 5px 8px; border-top: 1px solid var(--border-subtle); white-space: nowrap; }
#tab-spectro .spec-table thead th { border-top: 0; color: var(--muted); font-weight: 600; font-size: 0.76rem; text-align: right; }
#tab-spectro .spec-table thead th:first-child, #tab-spectro .spec-table tbody th { text-align: left; }
#tab-spectro .spec-table tbody th { font-weight: 550; }
#tab-spectro .spec-table td { text-align: right; font-family: var(--font-mono); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
#tab-spectro .spec-table .swatch { margin-right: 6px; vertical-align: 0; }
#tab-spectro .spec-table .muted { color: var(--muted); }
#tab-spectro .spec-metrics .stats { margin-bottom: 14px; }
#tab-spectro .stat-sub { font-size: 0.74rem; color: var(--muted); margin-top: 2px; line-height: 1.35; }
#tab-spectro .spec-metrics .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
#tab-spectro .spec-pname { font: 600 0.8rem var(--font-mono); color: var(--fg); margin-right: 6px; }
#tab-spectro .spec-pdesc { color: var(--muted); }

#tab-spectro .spec-timing-host { min-height: 60px; }
#tab-spectro .spec-ed {
    position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr);
    height: clamp(220px, 40vh, 400px); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    background: var(--card); overflow: hidden; margin-top: 4px;
}
#tab-spectro .spec-ed:focus-within { border-color: var(--focus); box-shadow: 0 0 0 3px var(--focus-ring); }
#tab-spectro .spec-ed-gutter {
    position: relative; overflow: hidden; background: var(--card-2); border-right: 1px solid var(--border);
    color: var(--muted); -webkit-user-select: none; user-select: none; text-align: right;
    font-family: var(--font-mono); font-size: calc(var(--ed-fs) - 1px); line-height: var(--ed-lh);
}
#tab-spectro .spec-ed-gutter-inner { padding: 8px 7px 8px 8px; min-width: 2.8em; }
#tab-spectro .spec-ed-gutter-inner > span { display: block; height: var(--ed-lh); }
#tab-spectro .spec-ed-gutter-inner > .is-err { color: var(--bad); font-weight: 700; }
#tab-spectro .spec-ed-main { position: relative; overflow: hidden; min-width: 0; }
#tab-spectro .spec-ed-hl, #tab-spectro textarea.spec-ed-ta {
    font-family: var(--font-mono); font-size: var(--ed-fs); line-height: var(--ed-lh);
    font-variant-ligatures: none; letter-spacing: 0; tab-size: 4; -moz-tab-size: 4;
    padding: 8px 10px; margin: 0; border: 0; white-space: pre; word-wrap: normal; overflow-wrap: normal;
}
#tab-spectro .spec-ed-hl {
    position: absolute; top: 0; left: 0; min-width: 100%; width: max-content; background: transparent; color: var(--fg);
    pointer-events: none; border-radius: 0; overflow: visible;
}
#tab-spectro textarea.spec-ed-ta {
    position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; resize: none; display: block;
    background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--fg);
    overflow: auto; border-radius: 0; box-shadow: none; outline: none;
}
#tab-spectro textarea.spec-ed-ta:focus, #tab-spectro textarea.spec-ed-ta:focus-visible { box-shadow: none; outline: none; border: 0; }
#tab-spectro textarea.spec-ed-ta::selection { background: rgba(37, 99, 235, 0.30); -webkit-text-fill-color: transparent; }
#tab-spectro .ed-line { display: block; min-height: var(--ed-lh); margin: 0 -10px; padding: 0 10px; }
#tab-spectro .ed-line.is-err { background: var(--bad-soft); box-shadow: inset 3px 0 0 var(--bad); }
#tab-spectro .tk-kw, #tab-spectro .tk-ev { font-weight: 700; }
#tab-spectro .tk-ev-rf { color: var(--syn-ev-rf); }
#tab-spectro .tk-ev-adc { color: var(--syn-ev-adc); }
#tab-spectro .tk-ev-g { color: var(--syn-ev-g); }
#tab-spectro .tk-opt { color: var(--syn-opt); }
#tab-spectro .tk-unit { color: var(--syn-unit); }
#tab-spectro .tk-str { color: var(--syn-str); }
#tab-spectro .tk-com { color: var(--syn-com); font-style: italic; }
#tab-spectro .tk-label { color: var(--syn-label); }
#tab-spectro .tk-err { text-decoration: underline wavy var(--bad); text-decoration-skip-ink: none; text-underline-offset: 3px; }
#tab-spectro .spec-edfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 8px 0; font-size: 0.78rem; color: var(--muted); }

/* Shim panel: a <details> styled as a panel, its summary as the panel head. */
#tab-spectro details.spec-shim { padding: 0; scroll-margin-top: 140px; }
#tab-spectro .spec-shim > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px;
    padding: 14px 44px 14px 18px; position: relative; border-radius: var(--radius);
}
#tab-spectro .spec-shim > summary::-webkit-details-marker { display: none; }
#tab-spectro .spec-shim > summary::after {
    content: ""; position: absolute; right: 20px; top: 50%; width: 8px; height: 8px; margin-top: -6px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s ease;
}
#tab-spectro .spec-shim:not([open]) > summary::after { transform: rotate(-45deg); margin-top: -4px; }
#tab-spectro .spec-shim > summary:hover { background: var(--hover); }
#tab-spectro .spec-shim[open] > summary { border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
#tab-spectro .spec-shim-body { padding: 14px 18px 18px; }
#tab-spectro .spec-shim-intro { font-size: 0.88rem; line-height: 1.55; margin: 0 0 12px; max-width: 72em; }
#tab-spectro .spec-shim .toolbar { gap: 8px 12px; }
#tab-spectro .spec-shim-result { font-size: 0.84rem; margin: 0 0 12px; min-height: 1.3em; }
#tab-spectro .spec-shim-grid { --min: 300px; align-items: start; }
#tab-spectro .spec-shim-sliders .controls { --min: 100%; gap: 10px; }
#tab-spectro .spec-shim-sliders .ctl-label { display: inline-flex; align-items: center; gap: 7px; }
#tab-spectro .spec-basis { width: 18px; height: 18px; border-radius: 50%; flex: none; display: inline-block; box-shadow: 0 0 0 1px var(--border-strong); }
#tab-spectro .spec-shim-status { font-size: 0.8rem; color: var(--muted); margin: 10px 0 0; }
#tab-spectro .spec-shim .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 12px; }
#tab-spectro .spec-shim .plot { margin-bottom: 12px; }
#tab-spectro .spec-outside { font-size: 0.78rem; color: var(--muted); margin: -6px 0 10px; min-height: 1.2em; }
#tab-spectro .spec-mapbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 8px 0 0; font-size: 0.8rem; color: var(--muted); }

@media (max-width: 640px) {
    #tab-spectro .spec-shim > summary { padding: 12px 40px 12px 12px; }
    #tab-spectro .spec-shim-body { padding: 12px; }
    #tab-spectro .spec-toolbar { gap: 8px 12px; }
}
`;

    /* ============================================================
       Tab state
       ============================================================ */
    const S = {
        mounted: false, visible: false, panel: null,
        dirty: { acq: true, spectrum: true, fid: true, proc: true, metrics: true, seq: true, editor: true, shim: true, notes: true },
        flushQueued: false,
        view: { plot: 'spectrum', range: 'metab', mode: 're', comps: false, labels: true, fidRe: true, fidIm: true, fidMag: false, fidWin: true },
        lastGood: null,                 // last spectroscopy program that compiled
        paramKey: '', sliders: {},      // acquisition sliders by param name
        procTimer: null,
        ed: { typing: null, value: '' },
        shim: {
            open: false, draft: zeros(), dragging: false, region: 'object', method: 'robust', win: 30,
            ui: {}, lastWL: 0, wlTimer: null, xr: null, ideal: new WeakMap(), result: null, disp: null,
            committedKey: '', committedLine: null, committedMean: null, liveMean: null, livePeak: null
        },
        refs: {}
    };
    const R = S.refs;

    function invalidate() {
        for (let i = 0; i < arguments.length; i++) S.dirty[arguments[i]] = true;
        if (S.visible) queueFlush();
    }
    function queueFlush() {
        if (S.flushQueued) return;
        S.flushQueued = true;
        raf(function () { S.flushQueued = false; if (S.visible) flush(); });
    }
    function flush() {
        const d = S.dirty;
        const run = function (key, fn) {
            if (!d[key]) return;
            d[key] = false;
            try { fn(); } catch (e) { if (root.console) root.console.error('[spectro tab] ' + key + ' failed:', e); }
        };
        run('acq', renderAcq);
        run('editor', renderEditor);
        run('seq', renderSequence);
        run('proc', renderProc);
        run('spectrum', renderSpectrum);
        run('notes', renderNotes);
        run('fid', renderFid);
        run('metrics', renderMetrics);
        run('shim', renderShimAll);
    }

    /* ============================================================
       Concept card
       ============================================================ */
    function conceptCard() {
        const A = MRI.actions;
        return W().concept({
            title: 'Spectroscopy: one peak for each chemical environment',
            body: '<p>Protons in different chemical groups are shielded slightly differently by their electrons, so they precess at slightly different frequencies. ' +
                'A short pulse with no gradients tips every spin in the coil, and the Fourier transform of the free induction decay (FID) is a spectrum: ' +
                'one peak per group, with an area proportional to its number of protons when fully relaxed. ' +
                'Shifts are quoted in ppm of the scanner frequency, so peak positions are the same at any field strength while their separation in Hz grows with B0: at 3 T, 1 ppm is 127.7 Hz.</p>' +
                '<p class="spec-body2">Water has about 3000 times more protons than the NAA methyl group, so it must be suppressed. ' +
                'A non-selective pulse on a head also excites scalp fat and skull marrow, whose lipid swamps the metabolites; ' +
                'that is why in vivo MRS localises to a voxel (PRESS, STEAM), which this simulator does not model.</p>',
            formula: 'δ = (f − f<sub>ref</sub>) / f<sub>ref</sub> × 10<sup>6</sup> ppm' +
                '<span class="spec-rel">spectral width = 1 / dwell &nbsp;·&nbsp; resolution = 1 / acquisition time &nbsp;·&nbsp; linewidth = 1 / (π T2*)</span>',
            tryThis: [
                { html: 'Look at <b>fid</b> on the MRS phantom: water dwarfs everything. Then load <b>fid_ws</b>: two CHESS pulses saturate water and NAA, Cr and Cho stand out.',
                    label: TRY_IT, run: function () { A.spectro.setPhantom('braino'); A.spectro.loadPreset('fid_ws'); } },
                { html: 'Switch to the <b>brain</b>: lipid from the scalp at 0.9 and 1.3 ppm swamps the metabolites, because the pulse excites the whole head.',
                    label: TRY_IT, run: function () { A.spectro.setPhantom('brain'); } },
                { html: 'Press <b>Start unshimmed</b> in the Shim panel, shim by hand with the sliders, then auto-shim, and watch the water line narrow.',
                    label: TRY_IT, run: function () { startUnshimmed(); openShim(true); } },
                { html: 'Shorten <b>TR</b> to 300 ms (NP 1024 first, so the acquisition still fits in TR): with T1 of 1.1 to 1.5 s each transient starts from partly recovered magnetisation, and every peak shrinks (T1 saturation).',
                    label: TRY_IT, run: function () { if (setParamChecked('NP', 1024)) setParamChecked('TR', 0.3); } },
                { html: 'Raise the acquisition <b>delay</b> to 2 ms with auto phase off: the phase now twists across the spectrum. Auto phase removes it with ph1 = −360° × delay × f.',
                    label: TRY_IT, run: function () {
                        setParamChecked('delay', 0.002);
                        A.spectro.setProcessing({ autoPhase: false, ph0: 0, ph1: 0 });
                    } }
            ]
        });
    }
    function setParamChecked(name, v) {
        const ok = MRI.actions.spectro.setParam(name, v);
        if (!ok) toast('The sequence has no parameter "' + name + '" right now (or it does not compile). Load a preset first.', 'warn');
        return ok;
    }

    /* ============================================================
       Layout
       The core loop comes first: choose (acquisition), acquire (the scan
       bar's Acquire runs this spectrum while the tab is open) and look
       (spectrum, peaks). Secondary numbers and expert processing sit in
       <details> one click away.
       ============================================================ */
    function terms() { return (MRI.ui && MRI.ui.terms) || {}; }
    function displayLabel(mode) {
        const d = terms().display || {};
        return mode === 'mag' ? (d.mag || 'Magnitude') : mode === 'im' ? (d.imag || 'Imaginary') : (d.real || 'Real');
    }
    function build(panel) {
        const w = W();
        panel.appendChild(conceptCard());

        /* ----- Row 1: spectrum (or FID) | acquisition ----- */
        const row1 = el('div', { class: 'split' });
        panel.appendChild(row1);

        // Spectrum, with the FID one click away in the same panel
        R.specSub = el('span', { class: 'panel-sub' });
        R.specBadge = el('span', { class: 'badge badge-muted', hidden: true });
        const specPanel = el('section', { class: 'panel spec-spectrum', 'aria-labelledby': 'spec-spectrum-title' }, [
            el('div', { class: 'panel-head' }, [
                R.specTitle = el('h2', { class: 'panel-title', id: 'spec-spectrum-title', text: 'Spectrum' }), R.specSub,
                el('span', { class: 'spacer' }), R.specBadge
            ])
        ]);
        R.segView = w.segmented({ label: 'Plot', size: 'sm', value: S.view.plot,
            options: [{ value: 'spectrum', label: 'Spectrum', title: 'The Fourier transform of the FID, on a ppm axis' },
                { value: 'fid', label: 'FID', title: 'The free induction decay as recorded: the time signal before the Fourier transform' }],
            onChange: function (v) { S.view.plot = v; syncPlotView(); invalidate('spectrum', 'fid'); } });
        R.segRange = w.segmented({ label: 'Range', size: 'sm', value: S.view.range,
            options: [{ value: 'metab', label: 'Metabolites 0.5–4.5 ppm' }, { value: 'water', label: 'Water' }, { value: 'full', label: 'Full spectral width' }],
            onChange: function (v) { S.view.range = v; invalidate('spectrum'); } });
        // complex display modes in the order every tab uses (Magnitude, Real, Imaginary; a spectrum has no phase display)
        R.segMode = w.segmented({ label: 'Display', size: 'sm', value: S.view.mode,
            options: [{ value: 'mag', label: displayLabel('mag'), title: 'Magnitude: no phasing needed, but broader feet' },
                { value: 're', label: displayLabel('re'), title: 'Real part: absorption lines, the usual display' },
                { value: 'im', label: displayLabel('im'), title: 'Imaginary part: dispersion lines' }],
            onChange: function (v) { S.view.mode = v; invalidate('spectrum'); } });
        R.tgComps = w.toggle({ label: 'Components', checked: S.view.comps, hint: 'Overlay each species (noise-free) in its own colour',
            onChange: function (b) { S.view.comps = b; invalidate('spectrum'); } });
        R.tgLabels = w.toggle({ label: 'Peak labels', checked: S.view.labels, hint: 'Mark the main resonances at their nominal positions',
            onChange: function (b) { S.view.labels = b; invalidate('spectrum'); } });
        R.specTools = el('div', { class: 'spec-toolbar' }, [R.segRange, R.segMode, el('div', { class: 'spec-toggles' }, [R.tgComps, R.tgLabels])]);
        const fidToggle = function (key, label, hint) {
            return w.toggle({ label: label, checked: S.view[key], hint: hint, onChange: function (b) { S.view[key] = b; invalidate('fid'); } });
        };
        R.fidTools = el('div', { class: 'spec-toolbar' }, [el('div', { class: 'spec-toggles' }, [
            fidToggle('fidMag', displayLabel('mag')), fidToggle('fidRe', displayLabel('re')), fidToggle('fidIm', displayLabel('im')),
            fidToggle('fidWin', 'Apodisation window', 'The weighting that line broadening applies to the FID before the Fourier transform')
        ])]);
        specPanel.appendChild(el('div', { class: 'spec-toolbar spec-viewbar' }, [R.segView]));
        specPanel.appendChild(R.specTools);
        specPanel.appendChild(R.fidTools);
        R.specWrap = el('div', { class: 'spec-plotwrap' });
        specPanel.appendChild(R.specWrap);
        const narrow = (root.innerWidth || 1280) < 640;
        R.plotSpec = w.plot(R.specWrap, { height: narrow ? 270 : 400, scope: true, xlabel: 'Chemical shift (ppm)', ylabel: 'Signal (a.u.)', title: '' });
        R.specEmpty = w.empty('Acquiring the FID...');
        R.specEmpty.classList.add('spec-empty');
        R.specWrap.appendChild(R.specEmpty);
        R.fidWrap = el('div', { class: 'spec-plotwrap' });
        R.plotFid = w.plot(R.fidWrap, { height: narrow ? 240 : 320, scope: true, xlabel: 'Time after the excitation (ms)', ylabel: 'Signal (a.u.)' });
        R.fidSub = el('p', { class: 'note mt-1 mb-0' });
        R.fidWrap.appendChild(R.fidSub);
        R.fidWrap.appendChild(el('p', { class: 'note mt-1 mb-0', html:
            'Real and imaginary are the two channels of the quadrature receiver. Each peak in the spectrum is a decaying oscillation here, at its offset from the receiver frequency; the envelope decays with T2*.' }));
        specPanel.appendChild(R.fidWrap);
        R.specErr = el('div', { class: 'spec-err', hidden: true });
        specPanel.appendChild(R.specErr);
        R.notes = el('div', { class: 'spec-notes', 'aria-live': 'polite' });
        specPanel.appendChild(R.notes);
        specPanel.appendChild(el('p', { class: 'simplification spec-simpl', text: 'Simplification: the simulated receiver has unlimited dynamic range, ' +
            'which is why NAA, creatine and choline are visible here even without water suppression. On a real scanner the receiver gain is set by water, ' +
            'thousands of times larger, and the analogue-to-digital converter would struggle to record the small peaks beside it.' }));
        row1.appendChild(specPanel);
        syncPlotView();

        // Acquisition
        const acq = el('section', { class: 'panel spec-acq', 'aria-labelledby': 'spec-acq-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'spec-acq-title', text: 'Acquisition' })])
        ]);
        const presets = spectroPresets();
        R.segPreset = w.segmented({ label: 'Sequence', value: sp().presetId,
            options: presets.map(function (p) { return { value: p.id, label: p.id === 'fid_ws' ? 'FID + water suppression' : (p.id === 'fid' ? 'Pulse-acquire FID' : p.name), title: p.name }; }),
            onChange: function (id) { MRI.actions.spectro.loadPreset(id); } });
        R.presetDesc = el('p', { class: 'spec-desc' });
        const names = {};
        try { MRI.phantoms.list().forEach(function (p) { names[p.id] = p.name; }); } catch (e) { /* phantoms missing */ }
        R.segPhantom = w.segmented({ label: 'Phantom', value: sp().phantomId,
            options: PHANTOM_IDS.map(function (id) { return { value: id, label: names[id] || id }; }),
            onChange: function (id) { MRI.actions.spectro.setPhantom(id); invalidate('acq', 'shim'); } });
        R.phantomDesc = el('p', { class: 'spec-desc' });
        R.params = el('div', { class: 'spec-params' });
        R.acqMsgs = el('div');
        R.derived = w.statTable([], { compact: true });
        acq.appendChild(el('div', { class: 'stack' }, [
            // said once: the scan bar's Acquire button runs the spectrum on this tab
            el('p', { class: 'note mt-0 mb-0 spec-acq-note', html: 'On this tab the scan bar\'s <b>Acquire spectrum</b> button runs this spectrum, ' +
                'and any change here acquires it again on its own.' }),
            el('div', {}, [R.segPreset, R.presetDesc]),
            el('div', {}, [R.segPhantom, R.phantomDesc]),
            R.params, R.acqMsgs,
            el('details', { class: 'adv' }, [el('summary', { text: 'Numbers' }), el('div', { class: 'adv-body' }, [R.derived])])
        ]));
        row1.appendChild(acq);

        /* ----- Row 2: peaks and metrics | processing ----- */
        const row2 = el('div', { class: 'split-even spec-row2' });
        panel.appendChild(row2);
        row2.appendChild(buildMetrics());
        row2.appendChild(buildProc());

        /* ----- Row 3: the sequence (both parts folded) ----- */
        panel.appendChild(buildSequence());

        /* ----- Shim ----- */
        panel.appendChild(buildShim());
    }
    /* Spectrum or FID in the one plot panel. */
    function syncPlotView() {
        const fid = S.view.plot === 'fid';
        R.specTools.hidden = fid; R.specWrap.hidden = fid;
        R.fidTools.hidden = !fid; R.fidWrap.hidden = !fid;
        if (R.specTitle) R.specTitle.textContent = fid ? 'FID' : 'Spectrum';
    }

    /* ---------- processing panel ---------- */
    function buildProc() {
        const w = W(), A = MRI.actions;
        const p = sp().processing || {};
        const box = el('section', { class: 'panel spec-proc', 'aria-labelledby': 'spec-proc-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'spec-proc-title', text: 'Processing' })])
        ]);
        // Slider drags re-process at most every 120 ms; release commits at once.
        const live = function (key) {
            return {
                onInput: function (v) {
                    if (S.procTimer) clearTimeout(S.procTimer);
                    S.procTimer = setTimeout(function () { S.procTimer = null; const q = {}; q[key] = v; A.spectro.setProcessing(q); }, 120);
                },
                onChange: function (v) {
                    if (S.procTimer) { clearTimeout(S.procTimer); S.procTimer = null; }
                    const q = {}; q[key] = v; A.spectro.setProcessing(q);
                }
            };
        };
        R.slLb = w.slider(Object.assign({ label: 'Line broadening lb', min: 0, max: 20, step: 0.5, value: p.lb || 0, unit: 'Hz',
            hint: 'Multiplies the FID by exp(−π lb t): every line gets lb Hz wider, and the noise smoother' }, live('lb')));
        R.slGb = w.slider(Object.assign({ label: 'Gaussian broadening gb', min: 0, max: 20, step: 0.5, value: p.gb || 0, unit: 'Hz',
            hint: 'Multiplies the FID by a Gaussian: convolves the spectrum with a Gaussian of FWHM gb Hz' }, live('gb')));
        R.segZf = w.segmented({ label: 'Zero filling', size: 'sm', value: p.zf || 1,
            options: [1, 2, 4, 8].map(function (z) { return { value: z, label: z + '×' }; }),
            onChange: function (z) { A.spectro.setProcessing({ zf: z }); } });
        R.zfWrap = el('div', {}, [R.segZf]);
        R.tgAuto = w.toggle({ label: 'Auto phase', checked: p.autoPhase !== false,
            hint: 'ph1 from the known delay (−360° × delay × f), then ph0 so that the tallest peak is absorptive',
            onChange: function (b) {
                const ph = sp().spectrum && sp().spectrum.phase;
                if (!b && ph) A.spectro.setProcessing({ autoPhase: false, ph0: Math.round(ph.ph0 * 10) / 10, ph1: Math.round(ph.ph1 * 10) / 10 });
                else A.spectro.setProcessing({ autoPhase: b });
            } });
        R.slPh0 = w.slider(Object.assign({ label: 'Zero-order phase ph0', min: -180, max: 180, step: 0.5, value: p.ph0 || 0, unit: 'deg',
            hint: 'The same phase for every frequency (receiver phase)' }, live('ph0')));
        R.slPh1 = w.slider(Object.assign({ label: 'First-order phase ph1', min: -2000, max: 2000, step: 1, value: p.ph1 || 0, unit: 'deg/kHz',
            hint: 'Phase that grows with frequency: ph0 + ph1 × f / 1 kHz. A delay before the first sample needs ph1 = −360° × delay × f' }, live('ph1')));
        R.slRef = w.slider(Object.assign({ label: 'Reference (receiver at)', min: 4.2, max: 5.2, step: 0.01, value: isFinite(p.refPpm) ? p.refPpm : WATER_PPM, unit: 'ppm',
            hint: 'The chemical shift assigned to the receiver frequency. 4.7 ppm puts water, which the scanner tunes to, at 4.7' }, live('refPpm')));
        R.autoNote = el('div', { class: 'spec-auto-note' });
        box.appendChild(el('div', { class: 'controls' }, [R.slLb, R.zfWrap, el('div', { class: 'ctl ctl-bare' }, [R.tgAuto, R.autoNote])]));
        // Phasing by hand and the rest: opens on its own when Auto phase is switched off.
        R.phaseDet = el('details', { class: 'adv' }, [el('summary', { text: 'Phasing and referencing' }), el('div', { class: 'adv-body' }, [
            el('div', { class: 'controls' }, [R.slPh0, R.slPh1, R.slGb, R.slRef]),
            el('div', { class: 'row' }, [
                w.button({ label: 'Zero the phases', size: 'sm', title: 'Auto phase off, ph0 = ph1 = 0: the raw phase of the data',
                    onClick: function () { A.spectro.setProcessing({ autoPhase: false, ph0: 0, ph1: 0 }); } }),
                w.button({ label: 'Default processing', size: 'sm', kind: 'ghost',
                    onClick: function () { A.spectro.setProcessing(Object.assign({}, MRI.spectro.defaults)); } })
            ])
        ])]);
        box.appendChild(R.phaseDet);
        box.appendChild(el('p', { class: 'note mt-1 mb-0', text: 'Zero filling interpolates the spectrum (smoother peaks) but adds no information: the resolution is still 1 / acquisition time.' }));
        return box;
    }

    /* ---------- metrics panel ---------- */
    function buildMetrics() {
        const box = el('section', { class: 'panel spec-metrics', 'aria-labelledby': 'spec-met-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'spec-met-title', text: 'Peaks and metrics' })])
        ]);
        const tile = function (label) {
            const v = el('div', { class: 'stat-value' }), sub = el('div', { class: 'stat-sub' });
            const t = el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: label }), v, sub]);
            t.set = function (value, unit, subText, kind) {
                v.textContent = value;
                if (unit) v.appendChild(el('span', { class: 'stat-unit', text: unit }));
                v.className = 'stat-value' + (kind ? ' ' + kind : '');
                sub.textContent = subText || '';
                sub.title = subText || '';
            };
            return t;
        };
        R.tSnr = tile('SNR'); R.tFwhm = tile('Linewidth'); R.tWs = tile('Water suppression'); R.tWl = tile('Water line (field)');
        box.appendChild(el('div', { class: 'stats' }, [R.tSnr, R.tFwhm, R.tWs, R.tWl]));
        // what keeps a number from being measured, and what the simulator separated for you
        R.metNotes = el('div', { class: 'spec-notes spec-met-notes' });
        box.appendChild(R.metNotes);
        /* The peak table scrolls sideways inside its own box when it must:
           a labelled, focusable region (arrow keys scroll it) with a shadow
           at the edge that still has columns beyond it. */
        R.peakBody = el('tbody');
        R.peakHead = el('thead');
        R.peakWrap = el('div', { class: 'spec-table-wrap mt-2', tabindex: '0', role: 'region', 'aria-label': 'Peak table: position, height, area and SNR of each peak' }, [
            el('table', { class: 'spec-table' }, [
                el('caption', { text: 'Peaks (height and area above the local baseline, arbitrary units)' }), R.peakHead, R.peakBody
            ])]);
        box.appendChild(R.peakWrap);
        R.ratioBody = el('tbody');
        R.ratioTable = el('div', { class: 'spec-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Metabolite ratios' }, [el('table', { class: 'spec-table' }, [
            el('caption', { text: 'Metabolite ratios' }),
            el('thead', {}, [el('tr', {}, [el('th', { scope: 'col', text: 'Ratio' }),
                el('th', { scope: 'col', text: 'Window integrals', title: 'Integrals of the measured spectrum over fixed ppm windows' }),
                el('th', { scope: 'col', text: 'Each metabolite alone', title: 'The same windows on each metabolite’s own noise-free spectrum (what a model fit would separate)' })])]),
            R.ratioBody
        ])]);
        R.ratioNotes = el('div', { class: 'spec-notes' });
        R.ratioDet = el('details', { class: 'adv mt-2' }, [el('summary', { text: 'Metabolite ratios' }), el('div', { class: 'adv-body' }, [R.ratioTable, R.ratioNotes])]);
        box.appendChild(R.ratioDet);
        if (root.ResizeObserver) new root.ResizeObserver(function () { syncOverflow(R.peakWrap); syncOverflow(R.ratioTable); }).observe(R.peakWrap);
        return box;
    }
    /* Mark a scroll box whose content is wider than it is, for the edge shadow. */
    function syncOverflow(box) {
        if (!box) return;
        box.classList.toggle('is-overflow', box.scrollWidth > box.clientWidth + 1);
    }

    /* ---------- sequence panel: timing diagram and editor ---------- */
    function buildSequence() {
        const w = W();
        const box = el('section', { class: 'panel spec-seq', 'aria-labelledby': 'spec-seq-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'spec-seq-title', text: 'Sequence' }),
                R.seqSub = el('span', { class: 'panel-sub' })])
        ]);
        // One RF pulse and one ADC: the diagram is there for those who want it.
        R.timingHost = el('div', { class: 'spec-timing-host' });
        R.timingDet = el('details', { class: 'adv' }, [el('summary', { text: 'Timing diagram' }), el('div', { class: 'adv-body' }, [R.timingHost])]);
        box.appendChild(R.timingDet);
        if (MRI.ui.timing && typeof MRI.ui.timing.create === 'function') {
            try { R.timing = MRI.ui.timing.create(R.timingHost, { ariaLabel: 'Timing diagram of one repetition of the spectroscopy sequence', compact: true }); }
            catch (e) { R.timing = null; if (root.console) root.console.error('[spectro tab] timing diagram failed:', e); }
        }
        if (!R.timing) R.timingHost.appendChild(w.empty('The timing diagram (js/ui/timing.js) is not available.'));
        // drawn while folded it has no width: draw it when it opens
        R.timingDet.addEventListener('toggle', function () {
            if (!R.timingDet.open) return;
            S.dirty.seq = true; queueFlush();
            raf(function () { if (R.timing && R.timing.redraw) R.timing.redraw(); });
        });

        // Compact editor
        R.edGutter = el('div', { class: 'spec-ed-gutter-inner', 'aria-hidden': 'true' });
        R.edHl = el('pre', { class: 'spec-ed-hl', 'aria-hidden': 'true' });
        R.edTa = el('textarea', { class: 'spec-ed-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off',
            'aria-label': 'Spectroscopy sequence source (pulse-sequence language)', 'aria-describedby': 'spec-ed-help' });
        const ed = el('div', { class: 'spec-ed' }, [
            el('div', { class: 'spec-ed-gutter' }, [R.edGutter]),
            el('div', { class: 'spec-ed-main' }, [R.edHl, R.edTa])
        ]);
        R.edTa.addEventListener('input', onTyping);
        R.edTa.addEventListener('scroll', syncEdScroll);
        R.edTa.addEventListener('blur', function () { if (S.ed.typing) { clearTimeout(S.ed.typing); S.ed.typing = null; commitSource(); } });
        R.edMsgs = el('ul', { class: 'spec-msgs' });
        R.edState = el('span');
        R.edDetails = el('details', { class: 'adv' }, [
            el('summary', { text: 'Edit the sequence' }),
            el('p', { class: 'note mt-0', id: 'spec-ed-help', html: 'Changes compile as you type and re-run the acquisition. The Sequence tab has the full language reference. ' +
                'A spectroscopy sequence needs an <code>adc NP dwell 1/SW</code> with no gradient during it.' }),
            ed,
            el('div', { class: 'spec-edfoot' }, [R.edState, el('span', { class: 'spacer' }),
                w.button({ label: 'Revert to the preset', size: 'xs', onClick: function () { MRI.actions.spectro.loadPreset(sp().presetId || 'fid'); } })]),
            R.edMsgs
        ]);
        R.edDetails.addEventListener('toggle', function () { if (R.edDetails.open) { S.dirty.editor = true; queueFlush(); } });
        box.appendChild(R.edDetails);
        return box;
    }

    /* ============================================================
       Acquisition panel
       ============================================================ */
    function shownProgram() {
        const p = sp().program;
        return p && p.ok ? p : S.lastGood;
    }
    /* Slider step for a param: its own step, else about 200 steps across
       its range in round display units, refined until the current value
       (and the slider minimum lo) sit on a step, so a value such as
       delay = 0.25 ms is shown exactly rather than snapped to 0.26 ms. */
    function stepFor(p, lo) {
        let st;
        if (p.step > 0) st = p.step;
        else if (p.kind === 'none') st = 1;
        else {
            const a = isFinite(p.min) ? p.min : 0, b = isFinite(p.max) ? p.max : p.value * 2 || 1;
            st = niceStep((b - a) / (p.scale || 1) / 200) * (p.scale || 1);
        }
        const on = function (step) { const q = (p.value - lo) / step; return Math.abs(q - Math.round(q)) < 1e-6; };
        const divs = [1, 2, 5, 10, 20, 50, 100, 1000];
        for (let i = 0; i < divs.length; i++) if (on(st / divs[i])) return st / divs[i];
        return p.kind === 'none' ? 1 : null;
    }
    function renderAcq() {
        const s = sp();
        R.segPreset.set(s.presetId);
        const pre = getPreset(s.presetId);
        const edited = pre && s.source !== pre.source;
        R.presetDesc.textContent = (pre ? pre.summary : '') + (edited ? ' (edited)' : '');
        R.segPhantom.set(s.phantomId);
        R.phantomDesc.textContent = PHANTOM_TEXT[s.phantomId] || '';

        const prog = shownProgram();
        const failing = !!(s.program && s.program.ok === false);
        const params = prog && prog.params ? prog.params : [];
        const key = params.map(function (p) { return [p.name, p.min, p.max, p.unit, p.scale, p.step, p.kind].join(':'); }).join('|');
        if (key !== S.paramKey) {
            S.paramKey = key;
            S.sliders = {};
            R.params.textContent = '';
            const grid = el('div', { class: 'controls' });
            params.forEach(function (p) {
                const hasRange = isFinite(p.min) && isFinite(p.max) && p.max > p.min;
                const lo = hasRange ? Math.min(p.min, p.value) : Math.min(0, p.value), hi = hasRange ? Math.max(p.max, p.value) : Math.max(1, 2 * p.value);
                const sl = W().slider({ label: p.name, hint: p.description || p.name, min: lo, max: hi, step: stepFor(p, lo), value: p.value,
                    unit: p.unit || '', siPerUnit: p.scale || 1,
                    onChange: function (v) { if (!MRI.actions.spectro.setParam(p.name, v)) toast('Fix the errors in the sequence first.', 'warn'); } });
                const lab = sl.querySelector('.ctl-label');
                if (lab && p.description) {
                    lab.textContent = '';
                    lab.appendChild(el('span', { class: 'spec-pname', text: p.name }));
                    lab.appendChild(el('span', { class: 'spec-pdesc', text: p.description.replace(/\s*\(.*\)\s*$/, '') }));
                }
                S.sliders[p.name] = sl;
                grid.appendChild(sl);
            });
            if (!params.length) R.params.appendChild(el('p', { class: 'note', text: 'This sequence declares no parameters. Edit it below, or load a preset.' }));
            else R.params.appendChild(grid);
        } else {
            params.forEach(function (p) {
                const sl = S.sliders[p.name];
                if (!sl) return;
                if (isFinite(p.min) && isFinite(p.max) && p.max > p.min) {
                    const lo = Math.min(p.min, p.value);
                    sl.setRange(lo, Math.max(p.max, p.value), stepFor(p, lo));
                }
                sl.set(p.value);
            });
        }
        Object.keys(S.sliders).forEach(function (k) { S.sliders[k].setDisabled(failing); });

        // Compile problems and warnings that matter here.
        R.acqMsgs.textContent = '';
        if (failing) {
            const e0 = (s.program.errors || [])[0] || {};
            R.acqMsgs.appendChild(W().callout('<strong>The sequence does not compile</strong> (line ' + esc(e0.line || '?') + ': ' + esc(e0.msg || 'error') +
                '). The panels show the last version that did. Fix it in the editor below or revert to the preset.', 'bad'));
        } else if (prog && prog.warnings && prog.warnings.length) {
            const list = el('ul', { class: 'spec-msgs' });
            prog.warnings.slice(0, 3).forEach(function (m) {
                list.appendChild(el('li', {}, [el('div', { class: 'spec-msg is-warn', style: { cursor: 'default' } }, [
                    el('span', { class: 'spec-msg-where', text: 'Line ' + m.line }), m.msg])]));
            });
            R.acqMsgs.appendChild(list);
        }

        // Numbers that follow from the parameters.
        const rows = [];
        const adc = prog && prog.adc ? prog.adc.find(function (a) { return !a.dummy; }) : null;
        if (adc) {
            const sw = 1 / adc.dwell, aq = adc.n * adc.dwell;
            rows.push({ label: 'Spectral width', value: U.fmtNum(sw, 4) + ' Hz = ' + U.fmtNum(sw / PPM_HZ, 3) + ' ppm', hint: '1 / dwell' });
            rows.push({ label: 'Dwell time', value: U.fmtTime(adc.dwell, 3) });
            rows.push({ label: 'Acquisition time', value: U.fmtTime(aq, 3), hint: 'NP x dwell' });
            rows.push({ label: 'Resolution', value: U.fmtNum(1 / aq, 3) + ' Hz = ' + U.fmtNum(1 / aq / PPM_HZ, 2) + ' ppm', hint: '1 / acquisition time' });
        }
        if (prog && prog.stats && isFinite(prog.stats.TR) && prog.stats.TR > 0) rows.push({ label: 'TR', value: U.fmtTime(prog.stats.TR) });
        if (prog && isFinite(prog.scanTime)) rows.push({ label: 'Scan time', value: U.fmtTime(prog.scanTime), hint: 'including dummy scans' });
        R.derived.update(rows);
    }

    /* ============================================================
       Spectrum
       ============================================================ */
    const compCache = new WeakMap();       // spectrum -> {mag: [Float64Array per component]}
    function compY(spec, c, mode) {
        if (mode === 're') return c.re;
        if (mode === 'im') return c.im;
        let e = compCache.get(spec);
        if (!e) { e = new Map(); compCache.set(spec, e); }
        let m = e.get(c.id);
        if (!m) { m = new Float64Array(c.re.length); for (let k = 0; k < m.length; k++) m[k] = Math.hypot(c.re[k], c.im[k]); e.set(c.id, m); }
        return m;
    }
    function waterPpmOf(spec) {
        const w = (spec.peaks || []).find(function (p) { return p.id === 'water'; });
        return w && isFinite(w.ppm) ? w.ppm : WATER_PPM;
    }
    function xlimFor(spec) {
        if (S.view.range === 'metab') return [0.5, 4.5];
        if (S.view.range === 'water') return [WATER_PPM - 0.8, WATER_PPM + 0.8];
        return [spec.ppm[0], spec.ppm[spec.ppm.length - 1]];
    }
    /* y range for a zoom window. Water (unsuppressed it is thousands of
       times taller) must not set the scale of the metabolite window: the
       range comes from the neighbourhood of each relevant peak in the
       window (which includes the baseline under it, the dead-time offset
       when water is not suppressed) and a low percentile of the data away
       from water. Peaks or tails that go beyond are clipped. */
    function yRangeFor(spec, y, xlim) {
        if (S.view.range === 'full') return null;
        const ppm = spec.ppm, lo = Math.min(xlim[0], xlim[1]), hi = Math.max(xlim[0], xlim[1]);
        const r = idxRange(ppm, lo, hi);
        if (r[1] - r[0] < 8) return null;
        const includeWater = S.view.range === 'water';
        const wp = waterPpmOf(spec);
        let top = -Infinity, bot = Infinity;
        // Each peak's search window, widened by the field spread: a poor shim
        // or a field gradient (the water-fat phantom) moves and splits lines.
        const info = sp().data && sp().data.info;
        const spread = Math.max(0.08, Math.min(0.8, 1.5 * ((info && info.linewidthHz) || 0) / PPM_HZ));
        relevantPeaks(spec).forEach(function (p) {
            if (p.id === 'water' && !includeWater) return;
            const w = peakWindow(p.id);
            if (!w || w.hi < lo || w.lo > hi) return;
            const rr = idxRange(ppm, Math.max(lo, w.lo - spread), Math.min(hi, w.hi + spread));
            for (let k = rr[0]; k <= rr[1]; k++) { const v = y[k]; if (v > top) top = v; if (v < bot) bot = v; }
        });
        const vals = [];
        const stride = Math.max(1, Math.floor((r[1] - r[0]) / 4000));
        for (let k = r[0]; k <= r[1]; k += stride) {
            if (!includeWater && Math.abs(ppm[k] - wp) < 0.35) continue;
            vals.push(y[k]);
        }
        if (vals.length > 10) {
            const p1 = percentileOf(vals, 0.01), p99 = percentileOf(vals, 0.995);
            bot = Math.min(bot, p1);
            if (!isFinite(top)) top = p99;
        }
        if (!isFinite(top) || !isFinite(bot) || !(top > bot)) return null;
        /* A broadened water line can leave a steep wing at the high-ppm edge
           of the window. Cap the range at a few times the tallest peak above
           its own baseline, anchored at the bottom, so that wing runs off the
           top, but only when the capped range still holds most of the window
           (a tail under the whole window, after a very poor shim, is the
           honest picture and is shown in full; the notes explain it). */
        if (!includeWater && S.view.mode !== 'im') {
            const sd = spec.metrics && spec.metrics.noiseSd > 0 ? spec.metrics.noiseSd : 0;
            let hmax = 0;
            relevantPeaks(spec).forEach(function (p) {
                if (p.id === 'water' || !isNum(p.height) || !isNum(p.ppm) || p.ppm < lo || p.ppm > hi) return;
                hmax = Math.max(hmax, p.height);
            });
            if (hmax > 5 * sd && top - bot > 8 * hmax) {
                const cap = bot + Math.max(8 * hmax, 20 * sd);
                let inside = 0;
                for (let k = r[0]; k <= r[1]; k++) if (y[k] <= cap) inside++;
                if (inside >= 0.75 * (r[1] - r[0] + 1)) top = cap;
            }
        }
        const span = top - bot;
        return [bot - 0.06 * span, top + 0.12 * span];
    }
    function markersFor(spec, xlim) {
        if (!S.view.labels) return [];
        const lo = Math.min(xlim[0], xlim[1]), hi = Math.max(xlim[0], xlim[1]);
        const out = [];
        const seen = new Set();
        relevantPeaks(spec).forEach(function (p) {
            const x = nominalPpm(p.id), inf = PEAK_INFO[p.id];
            if (!isFinite(x) || x < lo || x > hi || seen.has(p.id)) return;
            seen.add(p.id);
            out.push({ x: x, label: inf.label, color: 'var(--scope-muted)' });
        });
        return out;
    }
    function renderSpectrum() {
        const s = sp(), spec = s.spectrum, data = s.data;
        const prog = shownProgram();
        let phName = s.phantomId;
        try { const l = MRI.phantoms.list().find(function (p) { return p.id === s.phantomId; }); if (l) phName = l.name; } catch (e) { /* no phantoms */ }
        R.specSub.textContent = [prog ? prog.name : null, phName, data ? 'NA ' + data.nTransients : null, data ? U.fmtNum(data.sw, 4) + ' Hz' : null]
            .filter(Boolean).join(' · ');
        // error
        R.specErr.textContent = '';
        R.specErr.hidden = !s.error;
        if (s.error) R.specErr.appendChild(W().callout('<strong>Spectroscopy failed.</strong> ' + esc(s.error) + (spec ? ' The plot shows the last spectrum that worked.' : ''), 'bad'));
        R.specBadge.hidden = !s.stale;
        R.specBadge.textContent = s.stale ? 'out of date' : '';

        if (!spec) {
            R.specEmpty.hidden = false;
            R.specEmpty.textContent = s.error ? 'No spectrum: ' + s.error : 'Acquiring the FID...';
            R.plotSpec.el.hidden = true;
            return;
        }
        R.specEmpty.hidden = true;
        R.plotSpec.el.hidden = false;
        const mode = S.view.mode;
        const y = mode === 'im' ? spec.im : (mode === 'mag' ? spec.mag : spec.re);
        const xlim = xlimFor(spec);
        const series = [{ x: spec.ppm, y: y, color: 'var(--scope-fg)', label: 'Spectrum', width: 1.4 }];
        if (S.view.comps) {
            (spec.components || []).forEach(function (c) {
                const label = c.id === 'water' || c.id === 'lipid' ? c.name : c.id;
                series.push({ x: spec.ppm, y: compY(spec, c, mode), color: c.color, label: label, width: 1.2 });
            });
        }
        const ylim = yRangeFor(spec, y, xlim);
        R.plotSpec.draw(series, { xlim: xlim, ylim: ylim || undefined, reverseX: true, markers: markersFor(spec, xlim),
            legend: S.view.comps, xfmt: null, yfmt: function (v) { return U.fmtNum(v, 3); } });
        // A text alternative for the canvas.
        const tall = relevantPeaks(spec).filter(function (p) { return isNum(p.height) && isNum(p.ppm); })
            .sort(function (a, b) { return b.height - a.height; }).slice(0, 4)
            .map(function (p) { return PEAK_INFO[p.id].label + ' at ' + p.ppm.toFixed(2) + ' ppm'; });
        R.plotSpec.canvas.setAttribute('aria-label', 'Spectrum, ' + ({ re: 'real part', im: 'imaginary part', mag: 'magnitude' })[mode] +
            ', ' + Math.min(xlim[0], xlim[1]).toFixed(1) + ' to ' + Math.max(xlim[0], xlim[1]).toFixed(1) + ' ppm' +
            (tall.length ? '. Tallest peaks: ' + tall.join(', ') : '') + '.');
    }

    /* Notes under the spectrum: the simulator's own (data.info.notes),
       plus a centre-frequency check from the field the shims leave. */
    function renderNotes() {
        R.notes.textContent = '';
        const s = sp();
        let notes = (s.data && s.data.info && s.data.info.notes) || [];
        // (spectro.js judges T1 saturation from Mz before each pulse, with water
        // taken from the run without CHESS, so water suppression is never
        // reported as T1 saturation and needs no filtering here.)
        const info = s.data && s.data.info;
        // The "too broad to measure" note is shown with the peak table, where the dashes are.
        const broadNow = info && isNum(info.linewidthHz) && info.linewidthHz > BROAD_HZ;
        if (broadNow) notes = notes.filter(function (t) { return !/^Lines are too broad/.test(t); });
        notes.forEach(function (t) {
            const warn = /dominates|dominated|poor|outside the spectral|fold back|only noise|left out|truncated|too broad|not uniform/i.test(t);
            R.notes.appendChild(W().callout(esc(t), warn ? 'warn' : 'info'));
        });
        const line = committedWaterLine();
        const refNow = (s.processing && isFinite(s.processing.refPpm)) ? s.processing.refPpm : WATER_PPM;
        // Where water appears on the ppm axis: the receiver reference plus the field offset.
        if (line && s.data && Math.abs(refNow + line.peakHz / PPM_HZ - WATER_PPM) > 5 / PPM_HZ) {
            const off = line.peakHz, ppmNow = refNow + off / PPM_HZ;
            // The table moves its windows to follow this same water line
            // (metrics.waterOffsetPpm), up to MRI.spectro.followPpm: say which happened.
            const m = s.spectrum && s.spectrum.metrics;
            const followed = !!(m && isNum(m.waterOffsetPpm) && Math.abs(m.waterOffsetPpm) >= 0.02);
            const follow = isNum(MRI.spectro.followPpm) ? MRI.spectro.followPpm : 1;
            const tableTxt = followed ? ' (the peak table follows the shift; the labels on the plot do not). '
                : Math.abs(ppmNow - WATER_PPM) > follow ? ' and the peak windows, which follow water only up to ' + U.fmtNum(follow, 2) + ' ppm, miss them. '
                : ' (the peak table could not follow the water line, so its windows stay at the nominal ppm). ';
            // The Shim panel's Frequency offset tile shows the mean field; on a
            // lopsided (poorly shimmed) field the water line peaks elsewhere.
            const mean = S.shim.committedMean;
            const meanTxt = isNum(mean) && Math.abs(mean - off) >= 1
                ? ' (the mean field over the object, the Shim panel\'s Frequency offset tile, is ' + hz(mean) + ' Hz: the field is lopsided, so its mean and the water peak differ)'
                : '';
            const box = W().callout('The water line peaks at ' + ppmNow.toFixed(2) + ' ppm instead of 4.70' +
                (Math.abs(off) > 5 ? ': the receiver frequency is ' + hz(off) + ' Hz off the water peak' + meanTxt : ': the reference is set to ' + refNow.toFixed(2) + ' ppm') +
                ', so every peak sits off its nominal ppm' + tableTxt +
                (Math.abs(off) > 5 ? 'Set Z0 in the Shim panel (or auto-shim), or re-reference the spectrum.' : 'Re-reference the spectrum.'), 'warn');
            box.appendChild(el('div', {}, [
                Math.abs(off) <= 5 ? null : W().button({ label: 'Correct Z0', size: 'sm', onClick: function () {
                    const c = coeffsOf(st().artifacts.b0);
                    c.z0 = U.clamp(c.z0 - off, -limitOf('z0'), limitOf('z0'));
                    MRI.actions.setArtifacts({ b0: { shimCoeffs: c } });
                } }),
                W().button({ label: 'Re-reference the spectrum', size: 'sm', kind: 'ghost', onClick: function () {
                    const ref = refNow - (ppmNow - WATER_PPM);
                    MRI.actions.spectro.setProcessing({ refPpm: Math.round(ref * 1000) / 1000 });
                } })
            ]));
            R.notes.appendChild(box);
        }
    }

    /* ============================================================
       FID
       ============================================================ */
    const fidCache = new WeakMap();
    function renderFid() {
        const data = sp().data;
        if (!data) { R.plotFid.draw([], {}); R.fidSub.textContent = ''; return; }
        let c = fidCache.get(data);
        if (!c) {
            const n = data.n, t = new Float64Array(n), t0 = isFinite(data.te) ? data.te : (data.delay || 0);
            const mag = new Float64Array(n);
            let mx = 0;
            for (let j = 0; j < n; j++) {
                t[j] = (t0 + j * data.dwell) * 1e3;
                mag[j] = Math.hypot(data.fid.re[j], data.fid.im[j]);
                if (mag[j] > mx) mx = mag[j];
            }
            c = { t: t, mag: mag, max: mx, win: new Float64Array(n), winKey: '' };
            fidCache.set(data, c);
        }
        const p = sp().processing || {};
        const series = [];
        if (S.view.fidRe) series.push({ x: c.t, y: data.fid.re, color: 'var(--sc1)', label: 'Real', width: 1.2 });
        if (S.view.fidIm) series.push({ x: c.t, y: data.fid.im, color: 'var(--sc2)', label: 'Imaginary', width: 1.2 });
        if (S.view.fidMag) series.push({ x: c.t, y: c.mag, color: 'var(--scope-fg)', label: 'Magnitude', width: 1.2 });
        const lb = Number(p.lb) || 0, gb = Number(p.gb) || 0;
        if (S.view.fidWin && (lb > 0 || gb > 0)) {
            const key = lb + '|' + gb;
            if (c.winKey !== key) {
                const gq = (Math.PI * gb) * (Math.PI * gb) / (4 * Math.LN2);
                for (let j = 0; j < data.n; j++) { const tt = j * data.dwell; c.win[j] = c.max * Math.exp(-Math.PI * lb * tt - gq * tt * tt); }
                c.winKey = key;
            }
            series.push({ x: c.t, y: c.win, color: 'var(--sc4)', label: 'Window (lb ' + U.fmtNum(lb, 3) + ' Hz' + (gb ? ', gb ' + U.fmtNum(gb, 3) + ' Hz' : '') + ')', dash: true, width: 1.2 });
        }
        R.plotFid.draw(series, { legend: true, yfmt: function (v) { return U.fmtNum(v, 3); } });
        R.fidSub.textContent = data.n + ' points · dwell ' + U.fmtTime(data.dwell, 3) + ' · first sample ' + U.fmtTime(isFinite(data.te) ? data.te : data.delay, 3) + ' after the pulse centre';
        R.plotFid.canvas.setAttribute('aria-label', 'Free induction decay, ' + data.n + ' points over ' + U.fmtTime(data.n * data.dwell) + '.');
    }

    /* ============================================================
       Processing controls (sync from state)
       ============================================================ */
    function renderProc() {
        const s = sp(), p = s.processing || {};
        const busy = !!S.procTimer;
        // Never move a slider under the student's pointer or keyboard focus.
        const sync = function (sl, v) { if (!busy && doc.activeElement !== sl.input) sl.set(v); };
        sync(R.slLb, p.lb || 0); sync(R.slGb, p.gb || 0);
        sync(R.slRef, isFinite(p.refPpm) ? p.refPpm : WATER_PPM);
        const prog = shownProgram();
        const adc = prog && prog.adc ? prog.adc.find(function (a) { return !a.dummy; }) : null;
        const np = adc ? adc.n : 2048;
        // Rebuild the zero-filling choice when NP changes which factors are allowed.
        const allowed = [1, 2, 4, 8].map(function (z) { return np * z <= MAX_POINTS || z === 1; });
        const zkey = allowed.join(',');
        if (R.zfKey !== zkey) {
            R.zfKey = zkey;
            const seg = W().segmented({ label: 'Zero filling', size: 'sm', value: p.zf || 1,
                options: [1, 2, 4, 8].map(function (z, i) { return { value: z, label: z + '×', disabled: !allowed[i], title: allowed[i] ? null : 'More than ' + MAX_POINTS + ' points' }; }),
                onChange: function (z) { MRI.actions.spectro.setProcessing({ zf: z }); } });
            R.zfWrap.replaceChild(seg, R.segZf);
            R.segZf = seg;
        }
        R.segZf.set(p.zf || 1);
        const auto = p.autoPhase !== false;
        // switching Auto phase off (here or from a try-this) opens the manual phase controls
        if (S.lastAuto === true && !auto && R.phaseDet) R.phaseDet.open = true;
        S.lastAuto = auto;
        R.tgAuto.set(auto);
        const ph = s.spectrum && s.spectrum.phase;
        if (auto) { R.slPh0.set(ph ? ph.ph0 : 0); R.slPh1.set(ph ? ph.ph1 : 0); }
        else { sync(R.slPh0, p.ph0 || 0); sync(R.slPh1, p.ph1 || 0); }
        R.slPh0.setDisabled(auto); R.slPh1.setDisabled(auto);
        R.autoNote.textContent = auto && ph ? 'Auto: ph0 ' + fixed(ph.ph0, 1) + '°, ph1 ' + fixed(ph.ph1, 1) + '°/kHz (switch off to adjust by hand)' : 'Manual phase: drag ph0 and ph1';
    }

    /* ============================================================
       Peaks and metrics
       ============================================================ */
    const BROAD_HZ = 10;          // water FWHM above which spectro.js does not measure metabolites
    function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
    /* The SNR tile names the peak it measured (metrics.snrPeak). */
    function snrTile(m, data) {
        const peak = m.snrPeak || 'tallest';
        if (!isNum(m.snr)) {
            if (data && data.noiseSigma === 0) return { v: '–', sub: 'noise is off' };
            if (/too broad/.test(peak)) return { v: '–', sub: 'lines too broad to measure NAA: shim first' };
            if (/not resolved/.test(peak)) return { v: '–', sub: 'NAA not resolved above the noise' };
            return { v: '–', sub: 'not measurable' };
        }
        const v = U.fmtNum(m.snr, 3);
        if (peak === 'tallest') return { v: v, sub: 'tallest peak / noise SD' };
        if (peak === 'NAA') return { v: v, sub: 'NAA peak / noise SD' };
        // 'NAA (under lipid)' or 'NAA (under water)': the simulator's own NAA component
        return { v: v, sub: peak + ': NAA\'s own height / noise SD', kind: 'warn' };
    }
    function renderMetrics() {
        const s = sp(), spec = s.spectrum, data = s.data;
        R.ratioBody.textContent = ''; R.peakBody.textContent = ''; R.peakHead.textContent = ''; R.ratioNotes.textContent = ''; R.metNotes.textContent = '';
        if (!spec || !data) {
            [R.tSnr, R.tFwhm, R.tWs, R.tWl].forEach(function (t) { t.set('–', '', ''); });
            return;
        }
        const m = spec.metrics || {}, info = data.info || {};
        const st0 = snrTile(m, data);
        R.tSnr.set(st0.v, '', st0.sub, st0.kind);
        R.tFwhm.set(hz(m.fwhmHz), 'Hz', isNum(m.tallestPpm) ? 'FWHM of the tallest peak (' + m.tallestPpm.toFixed(2) + ' ppm)' : 'FWHM of the tallest peak');
        const ws = info.waterSuppression;
        R.tWs.set(ws === null || ws === undefined ? '–' : (ws <= 1.0001 ? 'none' : '×' + U.fmtNum(ws, 3)), '', ws > 1.0001 ? U.fmtNum(100 * Math.abs(info.waterResidual || 0), 2) + ' % of the water left' : 'no water suppression pulses');
        const broad = isNum(info.linewidthHz) && info.linewidthHz > BROAD_HZ;
        R.tWl.set(hz(info.linewidthHz), 'Hz', 'water FWHM from the B0 field and T2', broad ? 'warn' : null);
        if (broad && st0.v !== '–') R.tSnr.set(st0.v, '', st0.sub + ' (lines too broad: shim first)', 'warn');
        const have = presentIds(spec);
        const metab = ['NAA', 'Cr', 'Cho', 'mI', 'Glu', 'Gln', 'Lac'].some(function (id) { return have.has(id); });

        // Above the table: why numbers are missing, and what the simulator separated.
        if (broad && metab) {
            const c = W().callout('<strong>Lines are too broad to measure metabolites: shim first.</strong> The water line is ' + hz(info.linewidthHz) +
                ' Hz wide (more than ' + BROAD_HZ + ' Hz), so the metabolite peaks smear into each other and into the water tail.', 'warn');
            c.appendChild(el('div', {}, [W().button({ label: 'Open the Shim panel', size: 'sm', onClick: function () { openShim(true); } })]));
            R.metNotes.appendChild(c);
        }
        if (s.phantomId === 'brain' || (have.has('lipid') && have.has('NAA'))) {
            R.metNotes.appendChild(W().callout('<strong>Not quantitative here.</strong> The non-selective pulse also excites scalp fat and skull marrow, and their lipid ' +
                '(including a line at 2.02 ppm, under NAA) and broad wings fill the peak windows. ' +
                'Ratios and an NAA SNR need a localised voxel inside the brain.', 'warn'));
        }
        (spec.notes || []).forEach(function (t) { R.metNotes.appendChild(W().callout(esc(t), 'info')); });

        // Metabolite ratios: shown only where they could be measured.
        const rt = m.ratios || {}, rc = m.componentRatios || {};
        const cell = function (v, why) { return el('td', { text: isNum(v) ? v.toFixed(2) : '–', title: isNum(v) ? null : why }); };
        let anyRatio = false;
        const noWin = 'Not measured: the window integrals need resolved NAA, Cr and Cho peaks, clear of lipid and water, with the water line under ' + BROAD_HZ + ' Hz wide.';
        [['NAA/Cr', 'NAA_Cr'], ['Cho/Cr', 'Cho_Cr']].forEach(function (r) {
            if (!isNum(rt[r[1]]) && !isNum(rc[r[1]])) return;
            anyRatio = true;
            R.ratioBody.appendChild(el('tr', {}, [el('th', { scope: 'row', text: r[0] }), cell(rt[r[1]], noWin), cell(rc[r[1]], 'This phantom lacks one of the metabolites')]));
        });
        R.ratioTable.hidden = !anyRatio;
        if (!anyRatio) {
            R.ratioNotes.appendChild(el('p', { class: 'note mb-0', text: !(have.has('NAA') && have.has('Cr') && have.has('Cho'))
                ? 'No ratios: this phantom has no NAA, creatine and choline to compare.' : 'No ratios: ' + noWin.replace(/^Not measured: /, '') }));
        } else if (!isNum(rt.NAA_Cr) || !isNum(rt.Cho_Cr)) {
            R.ratioNotes.appendChild(el('p', { class: 'note mb-0', text: 'Window integrals: ' + noWin.replace(/^Not measured: /, '') }));
        }
        if (anyRatio && have.has('NAA') && (have.has('Glu') || have.has('Gln'))) {
            R.ratioNotes.appendChild(el('p', { class: 'note mb-0', html: 'The NAA window (1.9 to 2.1 ppm) also holds part of the glutamate and glutamine multiplets, ' +
                'so the window ratio reads higher than NAA alone. Fitting software (LCModel and similar) separates overlapping metabolites with a model spectrum of each.' }));
        }

        // Peak table: only the resonances this phantom contains.
        const peaks = relevantPeaks(spec);
        let hmax = 0, amax = 0;
        const scaleBy = peaks.some(function (p) { return p.id !== 'water'; }) ? peaks.filter(function (p) { return p.id !== 'water'; }) : peaks;
        scaleBy.forEach(function (p) { if (isNum(p.height)) hmax = Math.max(hmax, Math.abs(p.height)); if (isNum(p.area)) amax = Math.max(amax, Math.abs(p.area)); });
        // Scale so the largest peak other than water reads between 100 and 1000
        // (the units are arbitrary anyway); water then shows how much larger it is.
        const sc = function (mx) { return mx > 0 ? Math.pow(10, 3 - Math.ceil(Math.log10(mx) + 1e-9)) : 1; };
        const hs = sc(hmax), as = sc(amax);
        R.peakHead.appendChild(el('tr', {}, [el('th', { scope: 'col', text: 'Peak' }), el('th', { scope: 'col', class: 'col-exp', text: 'Expected ppm' }),
            el('th', { scope: 'col', class: 'col-ppm', text: 'ppm', title: 'Position found in the spectrum' }), el('th', { scope: 'col', text: 'Height' }),
            el('th', { scope: 'col', class: 'col-area', text: 'Area' }), el('th', { scope: 'col', text: 'SNR' })]));
        const colorOf = {};
        (spec.components || []).forEach(function (c) { colorOf[c.id] = c.color; });
        let anyUnresolved = false;
        peaks.forEach(function (p) {
            const inf = PEAK_INFO[p.id];
            const sw = colorOf[inf.needs.find(function (id) { return colorOf[id]; })] || null;
            const name = (p.name || inf.label) + (p.contaminatedBy ? ' (under ' + p.contaminatedBy + ')' : '');
            /* A peak spectro.js could not measure (no maximum in its window,
               not above the baseline, a negative area or under 3 noise SD)
               has null height, area and SNR: show a dash and say so, never a
               negative number. */
            const ok = p.resolved !== false && isNum(p.height);
            if (!ok) anyUnresolved = true;
            const why = p.reason ? 'Not resolved: ' + p.reason : 'Not resolved';
            R.peakBody.appendChild(el('tr', { class: ok ? null : 'is-unresolved', title: ok ? null : why }, [
                el('th', { scope: 'row' }, [sw ? el('span', { class: 'swatch', style: { background: sw }, 'aria-hidden': 'true' }) : null, name,
                    ok ? null : el('span', { class: 'spec-nr', text: 'not resolved' })]),
                el('td', { class: 'muted col-exp', text: fixed(nominalPpm(p.id), 2) }),
                el('td', { class: 'col-ppm' + (ok ? '' : ' muted'), text: ok ? fixed(p.ppm, 3) : '–' }),
                el('td', { text: isNum(p.height) ? num(p.height * hs, 3) : '–' }),
                el('td', { class: 'col-area', text: isNum(p.area) ? num(p.area * as, 3) : '–' }),
                el('td', { text: isNum(p.snr) ? U.fmtNum(p.snr, 3) : '–' })
            ]));
        });
        if (anyUnresolved) {
            R.peakBody.appendChild(el('tr', { class: 'spec-foot' }, [el('td', { colspan: '6', class: 'spec-foot-note', text:
                '– : not resolved. The window holds no peak above its local baseline (or one under 3 noise SD), only a baseline wiggle or the tail of a broad line.' })]));
        }
        raf(function () { syncOverflow(R.peakWrap); syncOverflow(R.ratioTable); });
    }

    /* ============================================================
       Sequence: timing diagram and editor
       ============================================================ */
    function renderSequence() {
        const prog = shownProgram();
        R.seqSub.textContent = prog ? (prog.name || '') + (prog.stats && prog.stats.TR ? ' · one repetition (TR ' + U.fmtTime(prog.stats.TR) + ')' : '') : '';
        if (!R.timing || !prog) return;
        try {
            R.timing.setProgram(prog);
            const per = prog.periods || [];
            let i = per.findIndex(function (q) { return !q.dummy; });
            if (i < 0) i = 0;
            R.timing.setPeriod(i);
        } catch (e) { if (root.console) root.console.error('[spectro tab] timing diagram:', e); }
    }

    const EVENTS = { rf: 'rf', adc: 'adc', gx: 'g', gy: 'g', gz: 'g' };
    function highlight(src, errs) {
        const kw = (MRI.dsl && MRI.dsl.keywords) || { options: [] };
        const optSet = new Set(kw.options || []);
        let toks = [];
        try { toks = MRI.dsl.tokenize(src); } catch (e) { toks = []; }
        const labels = new Set();
        for (let i = 0; i + 1 < toks.length; i++) if (toks[i].type === 'keyword' && toks[i].text === 'as' && toks[i + 1].type === 'ident') labels.add(toks[i + 1].text);
        const errLines = new Set();
        (errs || []).forEach(function (e) { if (e && e.line) errLines.add(e.line); });
        const lines = [''];
        let pos = 0, first = true;
        const put = function (text) {
            const parts = text.split('\n');
            for (let i = 0; i < parts.length; i++) { if (i > 0) { lines.push(''); first = true; } lines[lines.length - 1] += esc(parts[i]); }
        };
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.start > pos) put(src.slice(pos, t.start));
            if (t.type === 'newline') { put('\n'); pos = t.end; continue; }
            let cls = '';
            if (t.type === 'comment') cls = 'tk-com';
            else if (t.type === 'string') cls = 'tk-str';
            else if (t.type === 'error') cls = 'tk-err';
            else if (t.type === 'number' && t.unit && t.unitStart > t.start) {
                lines[lines.length - 1] += esc(src.slice(t.start, t.unitStart)) + '<span class="tk-unit">' + esc(src.slice(t.unitStart, t.end)) + '</span>';
                pos = t.end; first = false; continue;
            } else if (t.type === 'keyword') {
                if (EVENTS[t.text]) cls = 'tk-ev tk-ev-' + EVENTS[t.text];
                else if (t.text === 'spoil' || t.text === 'wait') cls = 'tk-ev';
                else if (!first && optSet.has(t.text)) cls = 'tk-opt';
                else cls = 'tk-kw';
            } else if (t.type === 'ident' && labels.has(t.text)) cls = 'tk-label';
            const text = esc(src.slice(t.start, t.end));
            lines[lines.length - 1] += cls ? '<span class="' + cls + '">' + text + '</span>' : text;
            pos = t.end;
            if (t.type !== 'comment') first = false;
        }
        if (pos < src.length) put(src.slice(pos));
        let html = '', gut = '';
        for (let i = 0; i < lines.length; i++) {
            const bad = errLines.has(i + 1);
            html += '<span class="ed-line' + (bad ? ' is-err' : '') + '">' + lines[i] + '</span>';
            gut += '<span' + (bad ? ' class="is-err"' : '') + '>' + (i + 1) + '</span>';
        }
        return { html: html, gutter: gut };
    }
    function syncEdScroll() {
        const x = R.edTa.scrollLeft, y = R.edTa.scrollTop;
        R.edHl.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
        R.edGutter.style.transform = 'translateY(' + (-y) + 'px)';
    }
    function paintEditor() {
        const p = sp().program;
        const errs = p && p.ok === false && R.edTa.value === sp().source ? p.errors : [];
        const h = highlight(R.edTa.value, errs);
        R.edHl.innerHTML = h.html + '\n';
        R.edGutter.innerHTML = h.gutter;
        syncEdScroll();
    }
    function onTyping() {
        paintEditor();
        R.edState.textContent = 'editing...';
        if (S.ed.typing) clearTimeout(S.ed.typing);
        S.ed.typing = setTimeout(function () { S.ed.typing = null; commitSource(); }, 450);
    }
    function commitSource() {
        const v = R.edTa.value;
        if (v !== sp().source) MRI.actions.spectro.setSource(v);
    }
    function gotoLine(line) {
        const ta = R.edTa, lines = ta.value.split('\n');
        let a = 0;
        for (let i = 0; i < Math.min(line - 1, lines.length); i++) a += lines[i].length + 1;
        const b = a + (lines[line - 1] || '').length;
        R.edDetails.open = true;
        ta.focus();
        try { ta.setSelectionRange(a, b); } catch (e) { /* old browsers */ }
        const lh = parseFloat(root.getComputedStyle(ta).lineHeight) || 19;
        ta.scrollTop = Math.max(0, (line - 3) * lh);
        syncEdScroll();
    }
    function renderEditor() {
        const s = sp();
        if (!S.ed.typing && doc.activeElement !== R.edTa && R.edTa.value !== s.source) R.edTa.value = s.source || '';
        else if (!S.ed.typing && doc.activeElement === R.edTa && R.edTa.value !== s.source && s.source !== S.ed.value) {
            // the source was changed from elsewhere (a slider) while the editor has focus: take it
            const pos = R.edTa.selectionStart;
            R.edTa.value = s.source || '';
            try { R.edTa.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
        }
        S.ed.value = s.source;
        if (R.edDetails.open) paintEditor();
        const p = s.program;
        R.edMsgs.textContent = '';
        const add = function (m, warn) {
            const b = el('button', { type: 'button', class: 'spec-msg' + (warn ? ' is-warn' : ''), onclick: function () { if (m.line) gotoLine(m.line); } }, [
                el('span', { class: 'spec-msg-where', text: 'Line ' + (m.line || '?') + (m.col ? ':' + m.col : '') }), m.msg || '',
                m.hint ? el('span', { class: 'spec-msg-hint', text: m.hint }) : null
            ]);
            R.edMsgs.appendChild(el('li', {}, [b]));
        };
        if (p && p.ok === false) (p.errors || []).forEach(function (m) { add(m, false); });
        else if (p && p.warnings) p.warnings.forEach(function (m) { add(m, true); });
        R.edState.textContent = !p ? '' : (p.ok ? 'Compiled: ' + (p.name || 'sequence') + (p.warnings && p.warnings.length ? ', ' + p.warnings.length + ' warning' + (p.warnings.length > 1 ? 's' : '') : '') :
            (p.errors || []).length + ' error' + ((p.errors || []).length === 1 ? '' : 's') + ': the last good version is still used');
        if (p && p.ok === false && !R.edDetails.open && S.ed.lastFail !== p) { S.ed.lastFail = p; R.edDetails.open = true; paintEditor(); }
    }

    /* ============================================================
       Shim panel
       ============================================================ */
    function limitOf(id) { const L = MRI.fields && MRI.fields.shimLimits; return L && L[id] ? L[id] : (id === 'z0' ? 100 : 150); }
    function shimAvailable() { return !!(MRI.fields && MRI.fields.b0Map && MRI.fields.fieldStats && MRI.fields.autoShim && MRI.fields.shimTerms); }
    function spectroPhantom() {
        if (!MRI.phantoms || !MRI.phantoms.build) return null;
        try { return MRI.phantoms.build(sp().phantomId || 'braino', Object.assign({}, st().phantomOpts || {}, { n: 256 })); }
        catch (e) { return null; }
    }
    function b0With(coeffs) {
        const b = st().artifacts.b0 || {};
        return { susceptibility: b.susceptibility === undefined ? 1 : b.susceptibility, shim: b.shim || 0, shimCoeffs: coeffs };
    }
    // The water line for the committed settings (cached per phantom and B0 settings).
    function committedWaterLine() {
        if (!shimAvailable() || !MRI.spectro || !MRI.spectro.waterLine) return null;
        const ph = spectroPhantom();
        if (!ph) return null;
        const b0 = st().artifacts.b0 || {};
        const key = ph.id + '|' + JSON.stringify(ph.opts || {}) + '|' + JSON.stringify(b0);
        if (S.shim.committedKey !== key) {
            S.shim.committedKey = key;
            S.shim.committedMean = null;
            try {
                const map = MRI.fields.b0Map(ph, b0);
                S.shim.committedLine = MRI.spectro.waterLine(ph, { b0Map: map, artifacts: st().artifacts });
                S.shim.committedMean = MRI.fields.fieldStats(ph, map, { region: 'object' }).mean;
            } catch (e) { S.shim.committedLine = null; }
        }
        return S.shim.committedLine;
    }
    function idealLine(ph) {
        let v = S.shim.ideal.get(ph);
        if (v === undefined) {
            try { v = MRI.spectro.waterLine(ph, { b0Map: new Float32Array(ph.n * ph.n), artifacts: {} }); } catch (e) { v = null; }
            S.shim.ideal.set(ph, v);
        }
        return v;
    }

    function buildShim() {
        const w = W(), U2 = U;
        const det = el('details', { class: 'panel spec-shim', id: 'spec-shim-panel' });
        R.shimBadge = el('span', { class: 'badge badge-muted' });
        R.shimSumSub = el('span', { class: 'panel-sub' });
        det.appendChild(el('summary', {}, [
            el('h2', { class: 'panel-title', text: 'Shim: make B0 uniform' }), R.shimSumSub, el('span', { class: 'spacer', style: { flex: '1' } }), R.shimBadge
        ]));
        R.shimDet = det;
        const body = el('div', { class: 'spec-shim-body' });
        det.appendChild(body);
        if (!shimAvailable()) {
            body.appendChild(w.empty('Interactive shimming needs the updated js/fields.js.'));
            return det;
        }
        body.appendChild(el('p', { class: 'spec-shim-intro', html:
            'Every spin precesses at the local field, so a field that varies across the object spreads one resonance over many Hz and broadens every line. ' +
            '<strong>Shim coils add smooth fields shaped like low-order spherical harmonics</strong> (a constant, the linear X and Y, and the second-order XY, X²−Y² and Z2), ' +
            'so they can cancel the smooth distortion a head causes in the magnet. <strong>They cannot cancel the steep local field next to an air space such as the frontal sinus</strong>, ' +
            'which changes over a few millimetres and would need far higher orders.' }));

        // Actions
        R.segRegion = w.segmented({ ariaLabel: 'Auto-shim region', size: 'sm', value: S.shim.region,
            options: [{ value: 'object', label: 'Whole object' }, { value: 'center', label: 'Centre, 60 mm radius' }],
            onChange: function (v) { S.shim.region = v; invalidate('shim'); } });
        R.btnAuto = w.button({ label: 'Auto-shim', kind: 'primary', title: 'Fit the six shim terms to the field over the chosen region, weighted by proton density',
            onClick: autoShim });
        R.segMethod = w.segmented({ ariaLabel: 'Auto-shim method', size: 'sm', value: S.shim.method,
            options: [{ value: 'robust', label: 'Robust', title: 'Ignores points far from the rest (the sinus field): the default' },
                { value: 'lsq', label: 'Least squares', title: 'Minimises the RMS field over the region' }],
            onChange: function (v) { S.shim.method = v; } });
        body.appendChild(el('div', { class: 'toolbar' }, [
            R.btnAuto, el('span', { class: 'muted', style: { fontSize: '0.8rem' }, text: 'over' }), R.segRegion,
            el('span', { class: 'muted', style: { fontSize: '0.8rem' }, text: 'by' }), R.segMethod,
            el('span', { class: 'spacer' }),
            w.button({ label: 'Reset shims', size: 'sm', title: 'All shim currents to zero', onClick: function () { commitShim(zeros(), 'Shim currents set to zero.'); } }),
            w.button({ label: 'Start unshimmed', size: 'sm', kind: 'danger', title: 'Load the field a freshly positioned patient brings (centre frequency 25 Hz off, plus tilts and a bowl) with all shims at zero',
                onClick: function () { startUnshimmed(); } })
        ]));
        body.appendChild(el('p', { class: 'note mt-0', text: 'Least squares minimises the RMS field, which the steep tail next to the sinus dominates; ' +
            'Robust ignores those outlying points and usually gives the narrower water line.' }));
        R.shimResult = el('p', { class: 'spec-shim-result', role: 'status', 'aria-live': 'polite' });
        body.appendChild(R.shimResult);

        const grid = el('div', { class: 'grid spec-shim-grid' });
        body.appendChild(grid);

        // Column 1: sliders
        const col1 = el('div', { class: 'spec-shim-sliders' });
        const ctl = el('div', { class: 'controls' });
        S.shim.ui = {};
        MRI.fields.shimTerms.forEach(function (t) {
            const lim = limitOf(t.id);
            const sl = w.slider({ label: t.label || t.name, min: -lim, max: lim, step: 0.5, value: 0, unit: 'Hz',
                hint: (t.id === 'z0' ? 'Constant offset: the centre frequency. ' : '') + 'Field shape ' + (t.formula || '') + ', in Hz at 100 mm from the centre',
                onInput: function (v) { S.shim.dragging = true; S.shim.lastInput = now(); S.shim.draft[t.id] = v; scheduleShimLive(); },
                onChange: function (v) {
                    S.shim.dragging = false; S.shim.draft[t.id] = v;
                    commitShim(Object.assign({}, S.shim.draft));
                } });
            const lab = sl.querySelector('.ctl-label');
            if (lab) lab.insertBefore(basisIcon(t), lab.firstChild);
            S.shim.ui[t.id] = sl;
            ctl.appendChild(sl);
        });
        col1.appendChild(ctl);
        col1.appendChild(el('p', { class: 'note mt-1 mb-0', html: 'Each value is the field that coil adds at 100 mm from the centre (Z0: everywhere). ' +
            'Z0 is applied by retuning the scanner frequency rather than with a coil.' }));
        col1.appendChild(el('p', { class: 'simplification', text: 'Simplification: the object is the single plane z = 0, so Z2 (2z² − x² − y²) acts as a bowl −r² and the shims that vary along z (Z, ZX, ZY) have nothing to act on.' }));
        R.shimStatus = el('p', { class: 'spec-shim-status' });
        col1.appendChild(R.shimStatus);
        grid.appendChild(col1);

        // Column 2: field map
        const col2 = el('div');
        R.ivField = w.imageView(col2, { title: 'Field map (Hz)', cmap: 'diverging', wl: false, colorbar: true, unit: 'Hz', empty: 'No phantom',
            readoutFormat: null });
        R.ivField.setOverlay(drawFieldOverlay);
        R.segWin = w.segmented({ ariaLabel: 'Field map colour window', size: 'sm', value: S.shim.win,
            options: [10, 30, 100, 300].map(function (v) { return { value: v, label: '±' + v + ' Hz' }; }),
            onChange: function (v) { S.shim.win = v; invalidate('shim'); } });
        col2.appendChild(el('div', { class: 'spec-mapbar' }, [el('span', { text: 'Colour window' }), R.segWin]));
        R.mapNote = el('p', { class: 'note mt-1 mb-0' });
        col2.appendChild(R.mapNote);
        grid.appendChild(col2);

        // Column 3: numbers, histogram, water line
        const col3 = el('div');
        const tile = function (label) {
            const v = el('div', { class: 'stat-value' }), sub = el('div', { class: 'stat-sub' });
            const t = el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: label }), v, sub]);
            t.set = function (value, unit, subText, kind) {
                v.textContent = value; if (unit) v.appendChild(el('span', { class: 'stat-unit', text: unit }));
                v.className = 'stat-value' + (kind ? ' ' + kind : ''); sub.textContent = subText || '';
            };
            return t;
        };
        R.sWater = tile('Water FWHM'); R.sField = tile('Field FWHM'); R.sSd = tile('Field SD'); R.sMean = tile('Frequency offset');
        col3.appendChild(el('div', { class: 'stats' }, [R.sWater, R.sField, R.sSd, R.sMean]));
        R.plotHist = w.plot(col3, { height: 150, scope: true, title: 'Field histogram (proton-weighted)', xlabel: 'Field offset (Hz)', legend: false });
        R.outside = el('p', { class: 'spec-outside' });
        col3.appendChild(R.outside);
        R.plotLine = w.plot(col3, { height: 170, scope: true, title: 'Water line', xlabel: 'Frequency offset from the receiver (Hz)' });
        col3.appendChild(el('p', { class: 'note mt-0 mb-0', text: 'The line is the field histogram of every tissue blurred by its own Lorentzian, 1 / (π T2) plus unresolved fine-scale broadening. Height is relative to a perfectly uniform field (dashed).' }));
        grid.appendChild(col3);

        det.addEventListener('toggle', function () {
            S.shim.open = det.open;
            if (det.open) { S.dirty.shim = true; queueFlush(); }
        });
        return det;
    }

    /* A small picture of a shim term's field over a disk, in the
       diverging colours of the field map. */
    function basisIcon(t) {
        const n = 18, dpr = Math.min(2, root.devicePixelRatio || 1), N = Math.round(n * dpr);
        const c = el('canvas', { class: 'spec-basis', width: N, height: N, 'aria-hidden': 'true', title: t.formula || '' });
        try {
            const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), lut = U.colormapLUT('diverging');
            for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
                const x = ((i + 0.5) / N * 2 - 1) * 0.1, y = ((j + 0.5) / N * 2 - 1) * 0.1;
                let v = t.fn(x, y);
                if (t.id === 'z0') v = 0.7;
                const k = Math.round(U.clamp(0.5 + 0.5 * v, 0, 1) * 255) * 3, o = 4 * (j * N + i);
                img.data[o] = lut[k]; img.data[o + 1] = lut[k + 1]; img.data[o + 2] = lut[k + 2]; img.data[o + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
        } catch (e) { /* no canvas: the label still says it */ }
        return c;
    }

    /* The smallest centred square that holds the object, plus a margin. */
    const cropCache = new WeakMap();
    function cropOf(ph) {
        let c = cropCache.get(ph);
        if (c) return c;
        const n = ph.n, h = Math.floor(n / 2), L = ph.label;
        let m = 0;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            if (L[iy * n + ix]) m = Math.max(m, Math.abs(ix - h), Math.abs(iy - h));
        }
        m = Math.min(h - 1, m + 4);
        c = { lo: h - m, n2: 2 * m + 1, m: m };
        cropCache.set(ph, c);
        return c;
    }
    function drawFieldOverlay(ctx, g) {
        const ph = S.shim.ph;
        if (!ph || !g.nx) return;
        const h = cropOf(ph).m, c = g.toCanvas(h, h);
        const r = CENTER_RADIUS / ph.dx * g.sx;
        const centre = S.shim.region === 'center';
        ctx.save();
        // a light halo under a dark line, so the circle shows on white, red and blue alike
        ctx.setLineDash(centre ? [] : [5, 4]);
        ctx.lineWidth = 3; ctx.strokeStyle = centre ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.45)';
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.lineWidth = 1.3; ctx.strokeStyle = centre ? 'rgba(15,23,42,0.95)' : 'rgba(15,23,42,0.55)';
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = '600 11px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const tag = function (text, x, y) {
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(0,0,0,0.62)';
            ctx.fillRect(x - tw / 2 - 3, y - 1, tw + 6, 15);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, x, y);
        };
        tag('60 mm', c.x, c.y + r + 3);
        const lm = (ph.landmarks || []).find(function (L) { return /Frontal sinus/i.test(L.name); });
        if (lm) {
            const p = g.toCanvas(lm.x / ph.dx + h, lm.y / ph.dx + h);
            tag('frontal sinus', p.x, Math.max(2, p.y - 24));
        }
        ctx.restore();
    }

    /* A drag that ends without a change event (released where it started)
       would leave the flag set: treat it as over after 1.5 s without input. */
    function isDragging() { return S.shim.dragging && now() - (S.shim.lastInput || 0) < 1500; }
    function setShimSliders(c) {
        SHIM_IDS.forEach(function (id) { if (S.shim.ui[id]) S.shim.ui[id].set(c[id]); });
    }
    function commitShim(c, message) {
        const out = {};
        let clipped = [];
        SHIM_IDS.forEach(function (id) {
            const L = limitOf(id), v = isFinite(+c[id]) ? +c[id] : 0;
            out[id] = U.clamp(v, -L, L);
            if (Math.abs(v) > L + 1e-9) clipped.push(id);
        });
        S.shim.draft = Object.assign({}, out);
        S.shim.dragging = false;
        if (message !== undefined) setShimResult(message);
        if (clipped.length) setShimResult((message ? message + ' ' : '') + 'Shim channel ' + clipped.join(', ') + ' hit its limit.', 'warn');
        MRI.actions.setArtifacts({ b0: { shimCoeffs: out } });
    }
    function startUnshimmed() {
        S.shim.draft = zeros();
        S.shim.dragging = false;
        setShimResult('Unshimmed: the field a freshly positioned patient brings, with every shim at zero. Shim it by hand, or press Auto-shim.');
        MRI.actions.setArtifacts({ b0: { shim: 1, shimCoeffs: zeros() } });
    }
    function setShimResult(text, kind) {
        if (!R.shimResult) return;
        R.shimResult.textContent = text || '';
        R.shimResult.className = 'spec-shim-result' + (kind ? ' ' + kind : '');
    }
    function autoShim() {
        const ph = spectroPhantom();
        if (!ph || !shimAvailable()) return;
        const region = S.shim.region;
        let r;
        try { r = MRI.fields.autoShim(ph, b0With(Object.assign({}, S.shim.draft)), { region: region, radius: CENTER_RADIUS, method: S.shim.method }); }
        catch (e) { toast('Auto-shim failed: ' + (e && e.message ? e.message : e), 'bad'); return; }
        const fw = function (c) {
            try { const L = MRI.spectro.waterLine(ph, { b0Map: MRI.fields.b0Map(ph, b0With(c)), artifacts: st().artifacts }); return L ? L.fwhmHz : NaN; }
            catch (e) { return NaN; }
        };
        const w0 = fw(Object.assign({}, S.shim.draft)), w1 = fw(r.total);
        const robust = S.shim.method !== 'lsq';
        let msg = 'Auto-shim (' + (robust ? 'robust' : 'least squares') + ') over ' + (region === 'center' ? 'the central disk (60 mm radius)' : 'the whole object') + ': RMS field there ' +
            hz(r.rmsBefore) + ' → ' + hz(r.rmsAfter) + ' Hz; water line of the whole object ' + hz(w0) + ' → ' + hz(w1) + ' Hz.';
        if (region === 'center' && r.rmsAfter < r.rmsBefore && w1 > 1.3 * (idealLine(ph) || { fwhmHz: w1 }).fwhmHz) {
            msg += ' The centre is flat now, but the shims ignored everything outside the circle, and a non-selective FID still sees all of it.';
        } else if (r.rmsAfter > 2) {
            msg += ph.id === 'brain'
                ? ' What is left is the local field next to the frontal sinus (and near the ears), which no low-order shim can follow. ' +
                    (robust ? 'The robust fit ignores it and centres the bulk of the brain, at the price of a larger RMS.'
                        : 'Least squares lets that large field pull the fit, so the bulk of the brain can end up slightly off: try Robust.')
                : ' What is left cannot be described by the six shim terms.';
        }
        commitShim(r.total, msg);
    }

    function scheduleShimLive() {
        if (!S.visible || !S.shim.open) return;
        if (S.shim.liveQueued) return;
        S.shim.liveQueued = true;
        raf(function () { S.shim.liveQueued = false; renderShimLive(); });
    }
    /* The per-frame part: field map, histogram and numbers for the draft
       shim currents; the water line (the costliest step, 10 to 30 ms) at
       most every 120 ms while dragging, and once more when it stops. */
    function renderShimLive() {
        const ph = spectroPhantom();
        S.shim.ph = ph;
        if (!ph) { R.ivField.clear('No phantom'); return; }
        const F = MRI.fields;
        const b0 = b0With(Object.assign({}, S.shim.draft));
        const map = F.b0Map(ph, b0);
        // Show the square around the object (centred, so x = 0 stays in the middle); air is NaN, drawn transparent.
        const cr = cropOf(ph), n2 = cr.n2;
        if (!S.shim.disp || S.shim.disp.length !== n2 * n2) S.shim.disp = new Float32Array(n2 * n2);
        const disp = S.shim.disp, label = ph.label;
        for (let j = 0; j < n2; j++) {
            const row = (cr.lo + j) * ph.n + cr.lo;
            for (let i = 0; i < n2; i++) disp[j * n2 + i] = label[row + i] ? map[row + i] : NaN;
        }
        const Wn = S.shim.win;
        R.ivField.setData(disp, n2, n2, { min: -Wn, max: Wn, fovX: n2 * ph.dx, fovY: n2 * ph.dx, cmap: 'diverging' });
        R.ivField.canvas.setAttribute('aria-label', 'Field map of the ' + ph.name + ' in Hz, colour window ±' + Wn + ' Hz');

        const region = { region: 'object' };
        const fs = F.fieldStats(ph, map, region);
        const fsc = S.shim.region === 'center' ? F.fieldStats(ph, map, { region: 'center', radius: CENTER_RADIUS }) : null;
        // Sticky x range shared by the histogram and the water line: it only
        // grows while a slider moves, and is refitted when it is released.
        const hist = fs.hist;
        let lo = fs.min, hi = fs.max;
        if (hist.counts.length > 2) {
            let c = 0, a = null, b = null;
            for (let k = 0; k < hist.counts.length; k++) {
                c += hist.counts[k];
                if (a === null && c >= 0.02) a = hist.centers[k];
                if (b === null && c >= 0.98) b = hist.centers[k];
            }
            lo = a === null ? lo : a; hi = b === null ? hi : b;
        }
        let xr = [Math.min(-15, lo - 8), Math.max(15, hi + 8)];
        if (isDragging() && S.shim.xr) xr = [Math.min(S.shim.xr[0], xr[0]), Math.max(S.shim.xr[1], xr[1])];
        S.shim.xr = xr;
        // Drawn as steps (fraction of the object per Hz), so a uniform field
        // shows as one narrow bar rather than a single invisible point.
        let outside = 0;
        const nb = hist.counts.length, bw = hist.binHz || 1;
        const hx = new Float64Array(2 * nb + 2), hy = new Float64Array(2 * nb + 2);
        for (let k = 0; k < nb; k++) {
            const d = hist.counts[k] / bw;
            hx[2 * k + 1] = hist.centers[k] - bw / 2; hy[2 * k + 1] = d;
            hx[2 * k + 2] = hist.centers[k] + bw / 2; hy[2 * k + 2] = d;
            if (hist.centers[k] < xr[0] || hist.centers[k] > xr[1]) outside += hist.counts[k];
        }
        if (nb) { hx[0] = hx[1]; hx[2 * nb + 1] = hx[2 * nb]; }
        R.plotHist.draw([{ x: hx, y: hy, color: 'var(--sc3)', fill: 0.25, width: 1.3, label: 'Field' }],
            { xlim: xr, legend: false, includeZero: true, yfmt: function (v) { return U.fmtNum(v, 2); } });
        R.plotHist.canvas.setAttribute('aria-label', 'Histogram of the field over the object: mean ' + hz(fs.mean) + ' Hz, SD ' + hz(fs.sd) + ' Hz.');
        R.outside.textContent = outside > 0.003 ? U.fmtNum(100 * outside, 2) + ' % of the object lies outside this range (from ' + hz(fs.min) + ' to ' + hz(fs.max) + ' Hz).' : '';

        R.sField.set(fs.fwhmHz < 0.1 ? '< 0.1' : hz(fs.fwhmHz), 'Hz', fsc ? 'centre: ' + (fsc.fwhmHz < 0.1 ? '< 0.1' : hz(fsc.fwhmHz)) + ' Hz' : 'spread of the field itself');
        R.sSd.set(hz(fs.sd), 'Hz', fsc ? 'centre: ' + hz(fsc.sd) + ' Hz' : 'proton-weighted');
        S.shim.liveMean = fs.mean;
        setOffsetTile();
        R.mapNote.textContent = (ph.id === 'brain' ? 'Red near the front is the frontal sinus field: watch it stay while the rest flattens. ' : '') +
            'Air is transparent. The ' + (S.shim.region === 'center' ? 'solid' : 'dashed') + ' circle is the central auto-shim region.';

        const t = now();
        if (!isDragging() || t - S.shim.lastWL > 120) {
            S.shim.lastWL = t;
            renderWaterLine(ph, map, xr);
        } else {
            if (S.shim.wlTimer) clearTimeout(S.shim.wlTimer);
            S.shim.wlTimer = setTimeout(function () { S.shim.wlTimer = null; scheduleShimLive(); }, 140);
        }
    }
    /* The centre-frequency error, two ways: the tile's value is the mean
       field over the object (what Z0 cancels on average), and its caption
       the peak of the water line, which the spectrum shows and the
       spectrum's own note quotes. On a lopsided field they differ. */
    function setOffsetTile() {
        const mean = S.shim.liveMean, peak = S.shim.livePeak;
        const hasPeak = isNum(peak);
        R.sMean.set(hz(mean), 'Hz', hasPeak ? 'mean field; water peak ' + hz(peak) + ' Hz' : 'mean field: centre-frequency error',
            Math.abs(mean) > 5 || (hasPeak && Math.abs(peak) > 5) ? 'warn' : null);
    }
    function renderWaterLine(ph, map, xr) {
        let line = null;
        try { line = MRI.spectro.waterLine(ph, { b0Map: map, artifacts: st().artifacts }); } catch (e) { line = null; }
        const ideal = idealLine(ph);
        let norm = null;
        if (ideal) { norm = 0; for (let k = 0; k < ideal.re.length; k++) if (ideal.re[k] > norm) norm = ideal.re[k]; }
        S.shim.livePeak = line ? line.peakHz : null;
        setOffsetTile();
        if (!line || !(norm > 0)) { R.plotLine.draw([], {}); R.sWater.set('–', '', ''); return; }
        const y = new Float64Array(line.re.length);
        for (let k = 0; k < y.length; k++) y[k] = line.re[k] / norm;
        const yi = new Float64Array(ideal.re.length);
        for (let k = 0; k < yi.length; k++) yi[k] = ideal.re[k] / norm;
        R.plotLine.draw([
            { x: ideal.hz, y: yi, color: 'var(--scope-muted)', dash: true, width: 1.2, label: 'Uniform field (' + hz(ideal.fwhmHz) + ' Hz)' },
            { x: line.hz, y: y, color: 'var(--sc1)', width: 1.8, fill: 0.18, label: 'This field (' + hz(line.fwhmHz) + ' Hz)' }
        ], { xlim: xr, ylim: [-0.04, 1.12], legend: true, yfmt: function (v) { return U.fmtNum(v, 2); } });
        R.plotLine.canvas.setAttribute('aria-label', 'Water line: full width at half maximum ' + hz(line.fwhmHz) + ' Hz, compared with ' + hz(ideal.fwhmHz) + ' Hz in a uniform field.');
        const ratio = line.fwhmHz / ideal.fwhmHz;
        R.sWater.set(hz(line.fwhmHz), 'Hz', 'uniform field: ' + hz(ideal.fwhmHz) + ' Hz', ratio < 1.3 ? 'good' : (ratio > 3 ? 'bad' : 'warn'));
    }

    // Everything in the shim panel that follows from the committed state.
    function renderShimSummary() {
        const b0 = st().artifacts.b0 || {};
        const line = committedWaterLine();
        R.shimBadge.textContent = line ? 'water FWHM ' + hz(line.fwhmHz) + ' Hz' : 'shim';
        const ph = spectroPhantom();
        const ideal = ph ? idealLine(ph) : null;
        const ratio = line && ideal ? line.fwhmHz / ideal.fwhmHz : 1;
        R.shimBadge.className = 'badge ' + (ratio < 1.3 ? 'badge-good' : (ratio > 3 ? 'badge-bad' : 'badge-warn'));
        const shim = Number(b0.shim) || 0;
        R.shimSumSub.textContent = (ph ? ph.name : '') + (shim ? ' · unshimmed residual field loaded' : ' · pre-shimmed scanner') +
            ' · applies to imaging as well';
        if (!R.shimStatus) return;
        R.shimStatus.textContent = '';
        R.shimStatus.appendChild(doc.createTextNode(shim
            ? 'The un-shimmed residual field is loaded' + (shim !== 1 ? ' (×' + U.fmtNum(shim, 3) + ')' : '') + '. '
            : 'No residual field: the scanner starts well shimmed (Start unshimmed loads one). '));
        if (shim || SHIM_IDS.some(function (id) { return coeffsOf(b0)[id] !== 0; })) {
            R.shimStatus.appendChild(el('button', { type: 'button', class: 'linklike', text: 'Back to the pre-shimmed default',
                onclick: function () { setShimResult('Back to the default: no residual field, all shims at zero.'); S.shim.draft = zeros(); S.shim.dragging = false; MRI.actions.setArtifacts({ b0: { shim: 0, shimCoeffs: zeros() } }); } }));
        }
        if ((b0.susceptibility !== undefined ? b0.susceptibility : 1) !== 1) {
            R.shimStatus.appendChild(doc.createTextNode(' Susceptibility fields are scaled ×' + U.fmtNum(b0.susceptibility, 3) + ' (Artifacts tab).'));
        }
    }
    function renderShimAll() {
        if (!R.shimDet || !shimAvailable()) return;
        S.shim.phId = sp().phantomId;
        renderShimSummary();
        if (!isDragging()) { S.shim.dragging = false; S.shim.draft = coeffsOf(st().artifacts.b0); setShimSliders(S.shim.draft); }
        if (S.shim.open) renderShimLive();
    }

    function openShim(scroll) {
        if (!R.shimDet) return;
        const go = function () {
            R.shimDet.open = true;
            S.shim.open = true;
            invalidate('shim');
            if (scroll) {
                raf(function () {
                    const con = doc.getElementById('console');
                    const top = R.shimDet.getBoundingClientRect().top + (root.pageYOffset || 0) - (con ? con.offsetHeight : 0) - 12;
                    try { root.scrollTo({ top: Math.max(0, top), behavior: U.scrollBehavior ? U.scrollBehavior() : 'auto' }); } catch (e) { root.scrollTo(0, Math.max(0, top)); }
                    const sum = R.shimDet.querySelector('summary');
                    if (sum) { try { sum.focus({ preventScroll: true }); } catch (e) { sum.focus(); } }
                });
            }
        };
        if (MRI.app && MRI.app.activeTab && MRI.app.activeTab() !== 'spectro' && MRI.actions.showTab) {
            MRI.actions.showTab('spectro');
            raf(go);
        } else go();
    }

    /* ============================================================
       Bus wiring
       ============================================================ */
    function wire() {
        const bus = MRI.bus;
        bus.on('spectro:compiled', function (e) {
            const p = e && e.program;
            if (p && p.ok) S.lastGood = p;
            invalidate('acq', 'seq', 'editor', 'proc');
        });
        bus.on('spectro:done', function () {
            invalidate('spectrum', 'notes', 'fid', 'metrics', 'proc', 'acq');
            // The shim panel follows the spectroscopy phantom, which another tab
            // (a lesson) may have switched without an event of its own.
            if (sp().phantomId !== S.shim.phId) invalidate('shim');
        });
        bus.on('spectro:error', function () { invalidate('spectrum', 'notes'); });
        bus.on('artifacts:changed', function () { invalidate('shim', 'notes'); });
        bus.on('phantom:changed', function () { invalidate('shim', 'notes'); });
        bus.on('shim:open', function () { openShim(true); });
    }

    /* ============================================================
       Tab definition
       ============================================================ */
    MRI.ui.registerTab({
        id: 'spectro', title: 'Spectroscopy', order: 80,
        mount: function (panel) {
            S.panel = panel;
            MRI.ui.addStyle(CSS);
            const p = sp().program;
            if (p && p.ok) S.lastGood = p;
            build(panel);
            wire();
            S.mounted = true;
            Object.keys(S.dirty).forEach(function (k) { S.dirty[k] = true; });
        },
        onShow: function () {
            S.visible = true;
            // The phantom may have been changed by another tab (lessons) without an event.
            Object.keys(S.dirty).forEach(function (k) { S.dirty[k] = true; });
            flush();
            if (R.timing && R.timing.redraw) R.timing.redraw();
        },
        onHide: function () {
            S.visible = false;
            if (S.shim.wlTimer) { clearTimeout(S.shim.wlTimer); S.shim.wlTimer = null; }
        }
    });

})(typeof window !== 'undefined' ? window : globalThis);
