/* ============================================================
   MRI Simulator, Contrast tab (ARCHITECTURE.md section 12.5)

   Contrast is a difference in signal produced by differences in
   relaxation. This tab follows each tissue of the phantom through the
   current sequence on its own (MRI.engine.tissueEvolution: nominal B1,
   the tissue's own chemical shift, one coherence pathway) and shows

     - Mz and |Mxy| of every tissue over the first repetitions (the
       approach to steady state, dummy scans shaded) and over the
       repetition that records the centre of k-space, with the RF,
       spoiler and ADC events marked and a toggle per tissue;
     - each tissue's signal at the k-space centre as a sorted bar chart
       (the sign shows when Mz was still inverted, as in inversion
       recovery), and the contrast between common pairs of tissues as a
       difference, a ratio and an estimated contrast-to-noise ratio;
     - a sweep: any declared parameter run across its declared range by
         recompiling with MRI.dsl.compile(source, {overrides}), each
       tissue's centre signal plotted against it, the current value
       marked; a click (or arrow keys) sets the parameter;
     - the textbook equation of the detected family (spoiled gradient
       echo, spin echo, inversion recovery; turbo spin echo with the
       effective TE) with the current numbers, compared with the
       simulated value tissue by tissue, and the reasons they can differ.

   Recomputes (debounced) on program:compiled, phantom:changed and
   artifacts:changed while visible; while hidden it only notes that it
   is out of date. The sweep runs in small chunks between frames and is
   cancelled whenever its inputs change.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const now = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };
    const { exp, sin, cos, abs, max, min, PI, log, acos, sqrt } = Math;

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function w() { return MRI.ui.w; }
    function state() { return MRI.state; }
    function fnum(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3).replace('-', '−') : '-'; }
    function fsig3(v) {
        if (!isFinite(v)) return '-';
        const a = abs(v);
        if (a < 1e-6) return '0';
        const s = a >= 0.1 ? v.toFixed(3) : (a >= 0.001 ? v.toFixed(4) : (a === 0 ? '0' : v.toExponential(1)));
        return s.replace('-', '−');
    }
    function fms(sec) { return isFinite(sec) ? U.fmtNum(sec * 1000, 4) : '-'; }
    function fparamDisplay(p, vSI) {
        if (!p) return '-';
        const d = vSI / (p.scale || 1);
        return U.fmtNum(d, 4) + (p.unit ? ' ' + p.unit : '');
    }

    // Stable identity numbers for objects used in cache keys.
    const ids = new WeakMap();
    let idCounter = 0;
    function idOf(o) { if (!o) return 0; let k = ids.get(o); if (!k) { k = ++idCounter; ids.set(o, k); } return k; }

    /* Tissue colours are chosen for the label map; a few (vial 1 of the
       relaxometry series, cortical bone) are too dark to read as a line on
       the near-black scope. Lift those toward white until the relative
       luminance reaches a readable level. */
    const colorCache = {};
    function scopeColor(hex) {
        if (colorCache[hex]) return colorCache[hex];
        const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
        if (!m) return (colorCache[hex] = '#9aa8bc');
        let r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
        const lum = function (R, G, B) {
            const f = function (c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            return 0.2126 * f(R) + 0.7152 * f(G) + 0.0722 * f(B);
        };
        let k = 0;
        while (lum(r, g, b) < 0.16 && k < 12) {
            r = r + (255 - r) * 0.12; g = g + (255 - g) * 0.12; b = b + (255 - b) * 0.12; k++;
        }
        const hx = function (v) { const s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; };
        return (colorCache[hex] = '#' + hx(r) + hx(g) + hx(b));
    }

    MRI.ui.addStyle(`
#tab-contrast .ct-status { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 14px; font-size: 0.86rem; }
#tab-contrast .ct-status .ct-seqname { font-weight: 650; }
#tab-contrast .ct-chips { display: flex; flex-wrap: wrap; gap: 6px; }
#tab-contrast .ct-pchip { font: 600 0.76rem var(--font-mono); padding: 2px 8px; border-radius: 999px; background: var(--card-2); border: 1px solid var(--border); white-space: nowrap; }
#tab-contrast .ct-toggles { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0 0 10px; }
#tab-contrast .ct-toggles-label { font-size: 0.78rem; color: var(--muted); margin-right: 2px; }
#tab-contrast .ct-chip {
    display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 7px; margin: 0;
    border-radius: 999px; border: 1px solid var(--border-strong); background: var(--card); color: var(--fg);
    font: 600 0.76rem/1 var(--font-sans); cursor: pointer; white-space: nowrap;
}
#tab-contrast .ct-chip:hover { background: var(--card-2); border-color: var(--axis); }
#tab-contrast .ct-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-contrast .ct-chip .ct-dot { width: 11px; height: 11px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.35); flex: none; }
#tab-contrast .ct-chip[aria-pressed="false"] { color: var(--muted); border-style: dashed; background: transparent; }
#tab-contrast .ct-chip[aria-pressed="false"] .ct-dot { opacity: 0.25; }
#tab-contrast .ct-linkbtn { background: none; border: 0; padding: 0 4px; font: 600 0.76rem var(--font-sans); color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
#tab-contrast .ct-evo { position: relative; }
#tab-contrast .ct-evo canvas { display: block; width: 100%; touch-action: pan-y; }
#tab-contrast .ct-key { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 0.74rem; color: var(--scope-muted); }
#tab-contrast .ct-key span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
#tab-contrast .ct-key svg { width: 12px; height: 12px; flex: none; }
#tab-contrast .ct-evo-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 0 0 8px; }
#tab-contrast .ct-bars { display: flex; flex-direction: column; gap: 5px; }
#tab-contrast .ct-bar { display: grid; grid-template-columns: minmax(0, 10.5em) minmax(0, 1fr) 4.6em; align-items: center; gap: 8px; font-size: 0.78rem; }
#tab-contrast .ct-bar-name { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--scope-fg); }
#tab-contrast .ct-bar-name span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#tab-contrast .ct-bar-name .swatch { width: 10px; height: 10px; }
#tab-contrast .ct-bar-track { position: relative; height: 14px; background: var(--scope-grid); border-radius: 3px; overflow: hidden; }
#tab-contrast .ct-bar-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; min-width: 1px; }
#tab-contrast .ct-bar-fill.neg { background-image: repeating-linear-gradient(-45deg, rgba(5, 8, 15, 0.55) 0 3px, transparent 3px 7px); }
#tab-contrast .ct-bar-val { font: 0.76rem var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; color: var(--scope-fg); white-space: nowrap; }
#tab-contrast .ct-bar.is-off { opacity: 0.45; }
#tab-contrast .ct-bars-note { margin-top: 10px; font-size: 0.74rem; color: var(--scope-muted); line-height: 1.45; }
#tab-contrast .ct-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
#tab-contrast .ct-table th { text-align: left; font-weight: 600; font-size: 0.74rem; color: var(--muted); padding: 4px 8px 6px 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
#tab-contrast .ct-table td { padding: 6px 8px 6px 0; border-top: 1px solid var(--border-subtle); vertical-align: middle; }
#tab-contrast .ct-table tbody tr:first-child td { border-top: 0; }
#tab-contrast .ct-table td.num, #tab-contrast .ct-table th.num { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
#tab-contrast .ct-table th.num { font-family: var(--font-sans); }
#tab-contrast .ct-table .swatch { width: 10px; height: 10px; margin-right: 5px; vertical-align: -1px; border: 1px solid var(--border-strong); }
#tab-contrast .ct-table .good { color: var(--good); font-family: var(--font-sans); font-weight: 600; }
#tab-contrast .ct-table .warn { color: var(--warn); }
#tab-contrast .ct-pair-name { line-height: 1.5; }
#tab-contrast .ct-pair-name strong { font-weight: 650; }
#tab-contrast .ct-rel { color: var(--muted); font-family: var(--font-mono); white-space: pre; }
#tab-contrast .ct-mine { height: 17px; font-size: 0.64rem; margin-right: 6px; vertical-align: 1px; }
#tab-contrast .ct-custom { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 12px 0 0; font-size: 0.82rem; }
#tab-contrast .ct-custom select { max-width: 13em; }
#tab-contrast .ct-wrap { overflow-x: auto; }
#tab-contrast .ct-sweep-tools { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 18px; margin: 0 0 10px; }
#tab-contrast .ct-sweep-tools .ctl-select { min-width: 220px; }
#tab-contrast .ct-progress { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--muted); min-height: var(--ctl-h); flex: 1 1 200px; }
#tab-contrast .ct-progress-bar { flex: 0 0 120px; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
#tab-contrast .ct-progress-fill { height: 100%; width: 0; background: var(--accent); transition: width 0.1s linear; }
#tab-contrast .ct-sweep-plot .plot-canvas { cursor: crosshair; }
#tab-contrast .ct-sweep-plot .plot-canvas:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-contrast .ct-check { margin: 10px 0 0; font-size: 0.84rem; }
#tab-contrast .ct-check:empty { display: none; }
#tab-contrast .ct-eq {
    font-family: var(--font-math); font-size: 1.08rem; text-align: center; line-height: 1.6;
    background: var(--card-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; overflow-x: auto;
}
#tab-contrast .ct-eq sub, #tab-contrast .ct-eq sup { font-size: 0.72em; }
#tab-contrast .ct-family { font-weight: 650; }
#tab-contrast .ct-reasons { margin: 10px 0 0; padding-left: 18px; font-size: 0.84rem; line-height: 1.5; }
#tab-contrast .ct-reasons li { margin: 0 0 6px; }
#tab-contrast .ct-reasons li.is-on { color: var(--fg); }
#tab-contrast .ct-cols { display: grid; gap: 16px; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: start; }
@media (max-width: 900px) { #tab-contrast .ct-cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) {
    #tab-contrast .ct-bar { grid-template-columns: minmax(0, 8.2em) minmax(0, 1fr) 4.4em; gap: 6px; }
    #tab-contrast .ct-sweep-tools .ctl-select { min-width: 0; flex: 1 1 100%; }
    #tab-contrast .ct-table { font-size: 0.78rem; }
}
`);

    /* ---------- state of the tab ---------- */
    const C = {
        mounted: false, visible: false, dirty: true,
        prog: null, failed: null, ph: null, ev: null, err: null, info: null,
        hidden: {}, userToggled: {},
        pdScale: true,
        hoverX: null,
        evoView: null, evoWin: null,       // null: overview on wide screens, first repetitions on narrow ones
        sweep: { name: null, wanted: null, token: 0, running: false, cache: new Map(), result: null, signed: false, plotFor: null },
        pair: { a: null, b: null }
    };
    const ui = {};

    function currentPhantom() {
        try { return MRI.actions.getPhantom(); }
        catch (e) { if (root.console) root.console.error('[contrast tab] getPhantom failed:', e); return null; }
    }

    /* ---------- analysis of the program ---------- */

    /* The family of the sequence and the numbers the textbook equations
       need, read from the repetition that records the k-space centre:
       the excitation before the centre echo, an inversion before that,
       and how many refocusing pulses the repetition has. */
    function analyse(prog, ev) {
        const info = { family: 'none', TR: null, TE: null, TI: null, flip: null, refFlip: null, nRef: 0, sat: false, cp: null, nPrior: 0 };
        if (!ev || !ev.center) return info;
        const cp = ev.center.period, tc = ev.center.t;
        info.cp = cp;
        let rfs = (prog.rf || []).filter(function (r) { return r.period === cp; });
        if (!rfs.length) rfs = (prog.rf || []).filter(function (r) { return !r.dummy; });
        const exc = rfs.filter(function (r) { return r.role === 'excite' && r.t <= tc + 1e-9; }).pop() || null;
        if (!exc) return info;
        const inv = rfs.filter(function (r) { return r.role === 'invert' && r.t < exc.t; }).pop() || null;
        const refs = rfs.filter(function (r) { return r.role === 'refocus' && r.t > exc.t; });
        info.nRef = refs.length;
        info.refFlip = refs.length ? refs[0].flip : null;
        info.sat = rfs.some(function (r) { return r.role === 'saturate'; });
        info.flip = exc.flip;
        info.TE = ev.center.te;
        const per = prog.periods && prog.periods.length > 1 ? prog.periods.find(function (p) { return p.index === cp; }) : null;
        info.TR = (prog.stats && prog.stats.TR) || (per ? per.dur : null);
        info.TI = inv ? exc.t - inv.t : null;
        info.nPrior = per ? (prog.periods.indexOf(per)) : 0;
        if (inv && refs.length) info.family = refs.length > 1 ? 'ir-tse' : 'ir-se';
        else if (refs.length) info.family = refs.length > 1 ? 'tse' : 'se';
        else if (inv) info.family = 'ir-gre';
        else info.family = 'gre';
        if (!(info.TR > 0)) info.family = 'none';
        return info;
    }
    const FAMILY_NAME = {
        gre: 'Spoiled gradient echo', se: 'Spin echo', tse: 'Turbo spin echo (effective TE)',
        'ir-se': 'Inversion recovery (spin echo)', 'ir-tse': 'Inversion recovery (turbo spin echo, effective TE)',
        'ir-gre': 'Inversion recovery gradient echo', none: 'No readout'
    };

    /* Textbook steady-state signal of one tissue (fraction of M0). */
    function textbook(info, t) {
        const TR = info.TR, TE = info.TE, T1 = t.t1;
        if (!(T1 > 0) || !(TR > 0) || !isFinite(TE)) return NaN;
        switch (info.family) {
            case 'gre': {
                const a = info.flip * PI / 180, E1 = exp(-TR / T1);
                return t.pd * sin(a) * (1 - E1) / (1 - cos(a) * E1) * exp(-TE / t.t2s);
            }
            case 'se': case 'tse':
                return t.pd * (1 - 2 * exp(-(TR - TE / 2) / T1) + exp(-TR / T1)) * exp(-TE / t.t2);
            case 'ir-se': case 'ir-tse':
                return t.pd * (1 - 2 * exp(-info.TI / T1) + exp(-TR / T1)) * exp(-TE / t.t2);
            default: return NaN;
        }
    }
    function equationHTML(fam) {
        const E = function (x) { return 'e<sup>&minus;' + x + '</sup>'; };
        switch (fam) {
            case 'gre': return 'S = PD &middot; sin&thinsp;&alpha; &middot; (1 &minus; E<sub>1</sub>) / (1 &minus; cos&thinsp;&alpha; &middot; E<sub>1</sub>) &middot; ' + E('TE/T2*') +
                ',&ensp; E<sub>1</sub> = ' + E('TR/T1');
            case 'se': return 'S = PD &middot; (1 &minus; 2' + E('(TR &minus; TE/2)/T1') + ' + ' + E('TR/T1') + ') &middot; ' + E('TE/T2');
            case 'tse': return 'S = PD &middot; (1 &minus; 2' + E('(TR &minus; TE/2)/T1') + ' + ' + E('TR/T1') + ') &middot; ' + E('TE/T2') + ',&ensp; TE = TE<sub>eff</sub>';
            case 'ir-se': return 'S = PD &middot; (1 &minus; 2' + E('TI/T1') + ' + ' + E('TR/T1') + ') &middot; ' + E('TE/T2');
            case 'ir-tse': return 'S = PD &middot; (1 &minus; 2' + E('TI/T1') + ' + ' + E('TR/T1') + ') &middot; ' + E('TE/T2') + ',&ensp; TE = TE<sub>eff</sub>';
            default: return '';
        }
    }

    /* Image noise for this protocol (section 3 noise model), so a signal
       difference can be quoted as a contrast-to-noise ratio. Each pixel
       of a Cartesian reconstruction is dkx dky times a sum over all
       samples, so sigma_img = sigma dkx dky sqrt(Nsamples) with
       sigma = NOISE_REF noise sqrt(1/dwell) / sqrt(NEX). Only for fully
       sampled Cartesian scans; SENSE and partial Fourier change it. */
    function imageNoise(prog) {
        const im = prog && prog.image, E = MRI.engine;
        if (!im || !E || !(E.NOISE_REF > 0) || (im.readoutAxis !== 'x' && im.readoutAxis !== 'y')) return null;
        const adcs = (prog.adc || []).filter(function (a) { return !a.dummy; });
        if (!adcs.length) return null;
        const os = im.oversample || 1;
        let nS = 0;
        adcs.forEach(function (a) { nS += a.n; });
        if (abs(nS - os * im.nx * im.ny) > 0.01 * nS) return null;      // undersampled or partial: not this simple estimate
        const noise = (state().artifacts && isFinite(state().artifacts.noise)) ? state().artifacts.noise : 1;
        if (!(noise > 0)) return 0;
        const fovRO = im.readoutAxis === 'x' ? im.fovX : im.fovY, fovPE = im.readoutAxis === 'x' ? im.fovY : im.fovX;
        const sigma = E.NOISE_REF * noise * sqrt(1 / adcs[0].dwell) / sqrt(im.averages || 1);
        return sigma * (1 / (fovRO * os)) * (1 / fovPE) * sqrt(nS) / ((im.thickness || 0.005) / 0.005);
    }

    /* ---------- concept card ---------- */
    function setupSweep(presetId, param, alwaysPreset) {
        const s = state();
        const prog = s.program && s.program.ok ? s.program : null;
        const has = prog && prog.params && prog.params.some(function (p) { return p.name === param && isFinite(p.min) && isFinite(p.max); });
        C.sweep.wanted = param;
        if (!has || (alwaysPreset && s.presetId !== presetId)) MRI.actions.loadPreset(presetId);
        else { C.sweep.name = param; recomputeNow(); }
        if (ui.sweepPanel) {
            try { ui.sweepPanel.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { ui.sweepPanel.scrollIntoView(); }
        }
    }
    function buildConcept() {
        return w().concept({
            title: 'Contrast: differences in relaxation become differences in signal',
            body: '<p>Two tissues look different only when the sequence turns their different T1, T2 or proton density into ' +
                'different signal. <strong>TR</strong> sets how much T1 recovery is allowed between excitations (short TR: ' +
                'T1-weighting), <strong>TE</strong> how much T2 decay happens before the echo (long TE: T2-weighting), and an ' +
                'inversion pulse followed by a wait <strong>TI</strong> nulls one tissue by exciting it just as its Mz crosses zero.</p>',
            formula: 'S &asymp; PD &middot; (1 &minus; e<sup>&minus;TR/T1</sup>) &middot; e<sup>&minus;TE/T2</sup>' +
                '<div class="note" style="font-family: var(--font-sans); font-size: 0.8rem; margin-top: 4px">spin echo with TE &#8810; TR; ' +
                'an inversion nulls a tissue at TI = T1 ln 2 when TR &#8811; T1</div>',
            tryThis: [
                { html: 'Sweep <strong>TE</strong> on the spin echo (<code>se</code>): long-T2 CSF overtakes grey and white matter as TE grows.',
                    label: 'Set it up', run: function () { setupSweep('se', 'TE', true); } },
                { html: 'Sweep <strong>TR</strong>: at short TR the short-T1 tissues (fat, white matter) lead; at long TR proton density takes over.',
                    label: 'Sweep TR', run: function () { setupSweep('se', 'TR', false); } },
                { html: 'On <code>flair</code> sweep <strong>TI</strong> and find the CSF null (about 2.4 s with TR = 9 s).',
                    label: 'Set it up', run: function () { setupSweep('flair', 'TI', true); } },
                { html: 'On <code>gre_t1</code> sweep the <strong>flip angle</strong> and find the Ernst angle of white matter, the flip that ' +
                    'gives it the most signal.', label: 'Set it up', run: function () { setupSweep('gre_t1', 'flip', true); } }
            ]
        });
    }

    /* ---------- status line ---------- */
    function renderStatus() {
        const box = ui.status;
        box.textContent = '';
        const prog = C.prog, info = C.info;
        if (C.failed) {
            const e = (C.failed.errors && C.failed.errors[0]) || null;
            box.appendChild(w().callout('The sequence in the editor does not compile' + (e ? ' (line ' + e.line + ': ' + escapeHTML(e.msg) + ')' : '') +
                (prog ? '. Showing the last version that compiled.' : '.'), 'warn'));
        }
        if (!prog) return;
        const line = el('div', { class: 'ct-status', 'data-family': info ? info.family : '' });
        line.appendChild(el('span', { class: 'ct-seqname', text: prog.name || 'Untitled sequence' }));
        const fam = info ? (FAMILY_NAME[info.family] || info.family) : '';
        if (fam && fam.toLowerCase() !== String(prog.name || '').toLowerCase()) {
            line.appendChild(el('span', { class: 'badge badge-accent', title: 'Sequence family detected from the RF pulses', text: fam }));
        }
        const chips = el('span', { class: 'ct-chips' });
        if (info && info.TR) chips.appendChild(el('span', { class: 'ct-pchip', text: 'TR ' + fms(info.TR) + ' ms' }));
        if (info && info.TI) chips.appendChild(el('span', { class: 'ct-pchip', text: 'TI ' + fms(info.TI) + ' ms' }));
        if (info && isFinite(info.TE)) chips.appendChild(el('span', { class: 'ct-pchip', text: (info.nRef > 1 ? 'TEeff ' : 'TE ') + fms(info.TE) + ' ms' }));
        if (info && isFinite(info.flip)) chips.appendChild(el('span', { class: 'ct-pchip', text: 'α ' + fnum(info.flip, 3) + '°' }));
        line.appendChild(chips);
        if (C.ph) line.appendChild(el('span', { class: 'muted', text: 'on the ' + C.ph.name + ' phantom' }));
        box.appendChild(line);
    }
    function escapeHTML(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    /* ---------- tissue toggles ---------- */
    const KEY_BRAIN = { wm: 1, gm: 1, deepgm: 1, csf: 1, fat: 1, lesion: 1 };
    function defaultHidden(ev, phId) {
        const out = {};
        if (phId === 'brain') ev.tissues.forEach(function (t) { if (!KEY_BRAIN[t.id]) out[t.id] = true; });
        return out;
    }
    function isShown(id) { return !C.hidden[id]; }
    function renderToggles() {
        const box = ui.toggles;
        box.textContent = '';
        const ev = C.ev;
        if (!ev) return;
        box.appendChild(el('span', { class: 'ct-toggles-label', text: 'Tissues:' }));
        ev.tissues.forEach(function (t) {
            const b = el('button', { type: 'button', class: 'ct-chip', 'aria-pressed': isShown(t.id) ? 'true' : 'false',
                title: (isShown(t.id) ? 'Hide ' : 'Show ') + t.name }, [
                el('span', { class: 'ct-dot', style: { background: scopeColor(t.color) }, 'aria-hidden': 'true' }), t.name
            ]);
            b.addEventListener('click', function () {
                C.hidden[t.id] = isShown(t.id);
                C.userToggled[t.id] = true;
                b.setAttribute('aria-pressed', isShown(t.id) ? 'true' : 'false');
                b.title = (isShown(t.id) ? 'Hide ' : 'Show ') + t.name;
                drawEvolution(); renderBars(); drawSweep();
            });
            box.appendChild(b);
        });
        const all = el('button', { type: 'button', class: 'ct-linkbtn', text: 'show all' });
        all.addEventListener('click', function () {
            ev.tissues.forEach(function (t) { C.hidden[t.id] = false; C.userToggled[t.id] = true; });
            renderToggles(); drawEvolution(); renderBars(); drawSweep();
        });
        box.appendChild(all);
    }

    /* ---------- evolution plot (own canvas: two panels with a time break) ---------- */
    function scopeColors() {
        return {
            bg: U.cssVar('--scope-bg', '#0b0f17'), fg: U.cssVar('--scope-fg', '#d6dde8'), muted: U.cssVar('--scope-muted', '#8794a8'),
            grid: U.cssVar('--scope-grid', '#1c2536'), axis: U.cssVar('--scope-axis', '#3a4760'),
            rf: U.cssVar('--seq-rf', '#d9541e'), adc: U.cssVar('--seq-adc', '#b7791f'), inv: U.cssVar('--seq-gz', '#6250d6'),
            sat: U.cssVar('--sc4', '#c98500'), font: U.cssVar('--font-sans', 'sans-serif'), mono: U.cssVar('--font-mono', 'monospace')
        };
    }
    let evoBase = null;       // offscreen copy of the static plot, so the hover crosshair is cheap

    /* The windows the plot can show, from the evolution's segments:
         start   the first repetitions (approach to steady state, dummies)
         steady  the repetition that records the k-space centre, when it comes later
         echo    a zoom from just before the excitation to just after the
                 k-centre echo, where T2 (and, in a gradient echo, T2*)
                 decay happens; at full scale it is a few pixels wide. */
    function lowerBound(T, t, lo, hi) { while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; } return lo; }
    function evoWindows(ev) {
        const base = (ev.segments && ev.segments.length ? ev.segments : [{ t0: ev.t[0], t1: ev.t[ev.t.length - 1], i0: 0, i1: ev.t.length }])
            .filter(function (s) { return s.i1 > s.i0 && s.t1 > s.t0; })
            .map(function (s, k) { return Object.assign({ kind: k === 0 ? 'start' : 'steady' }, s); });
        if (!base.length) base.push({ kind: 'start', t0: ev.t[0], t1: max(ev.t[ev.t.length - 1], ev.t[0] + 1e-3), i0: 0, i1: ev.t.length });
        const out = { start: base[0], steady: base.length > 1 ? base[1] : null, echo: null };
        const cen = ev.center;
        if (cen && isFinite(cen.te) && cen.te > 0) {
            const tc = cen.t, tx = tc - cen.te;
            const parent = base.find(function (s) { return tc >= s.t0 - 1e-9 && tc <= s.t1 + 1e-9; });
            if (parent) {
                const a = max(parent.t0, tx - max(0.12 * cen.te, 3e-4)), b = min(parent.t1, tc + max(0.45 * cen.te, 1.5e-3));
                const i0 = lowerBound(ev.t, a - 1e-12, parent.i0, parent.i1), i1 = lowerBound(ev.t, b + 1e-12, parent.i0, parent.i1);
                if (i1 - i0 >= 3 && b > a) {
                    out.echo = { kind: 'echo', t0: a, t1: b, i0: i0, i1: i1, tRef: tx, small: (b - a) < 0.15 * (parent.t1 - parent.t0) };
                }
            }
        }
        return out;
    }
    const VIEW_LABEL = { all: 'Overview', start: 'Start', steady: 'k-centre TR', echo: 'Echo zoom' };
    const VIEW_TITLE = { all: 'The first repetitions, the repetition of the k-space centre and a zoom on its echo, side by side',
        start: 'The first repetitions: the approach to steady state', steady: 'The repetition that records the k-space centre',
        echo: 'From the excitation to the k-space centre echo' };
    function evoView(W) {
        const v = C.evoView || (W < 560 ? 'start' : 'all');
        const win = C.evoWin;
        if (!win) return 'all';
        if (v === 'steady' && !win.steady) return 'start';
        if (v === 'echo' && !win.echo) return 'all';
        return v;
    }
    function syncViewControl(W) {
        const win = C.evoWin, host = ui.viewHost;
        if (!host) return;
        const opts = ['all', 'start'];
        if (win && win.steady) opts.push('steady');
        if (win && win.echo) opts.push('echo');
        const key = opts.join(',');
        const cur = evoView(W);
        if (host.dataset.key !== key) {
            host.dataset.key = key;
            host.textContent = '';
            ui.viewSeg = w().segmented({ ariaLabel: 'Time window of the magnetisation plot', size: 'sm',
                options: opts.map(function (o) { return { value: o, label: VIEW_LABEL[o], title: VIEW_TITLE[o] }; }), value: cur,
                onChange: function (v) { C.evoView = v; drawEvolution(); } });
            host.appendChild(ui.viewSeg);
        } else if (ui.viewSeg && ui.viewSeg.get() !== cur) ui.viewSeg.set(cur);
    }

    function drawEvolution() {
        const cv = ui.evoCanvas, stage = ui.evoStage;
        if (!cv || !C.visible) return;
        const W = stage.clientWidth;
        if (!W) return;
        const narrow = W < 560;
        const mzH = narrow ? 112 : 136, mxyH = narrow ? 84 : 104;
        const top = 34, gapP = 22, bottom = 34, left = narrow ? 40 : 46, right = 10;
        const H = top + mzH + gapP + mxyH + bottom;
        const r = U.setupCanvas(cv, W, H), ctx = r.ctx;
        const c = scopeColors();
        ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
        const ev = C.ev;
        C.evoLayout = null;
        C.evoWin = ev && ev.t && ev.t.length ? evoWindows(ev) : null;
        syncViewControl(W);
        if (!ev || !ev.t || !ev.t.length) {
            ctx.fillStyle = c.muted; ctx.font = '13px ' + c.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(C.err ? 'No curves: ' + C.err : 'No sequence to follow yet.', W / 2, H / 2);
            snapshot(cv);
            return;
        }
        const win = C.evoWin, view = evoView(W);
        let segs;
        if (view === 'start') segs = [win.start];
        else if (view === 'steady') segs = [win.steady];
        else if (view === 'echo') segs = [win.echo];
        else {
            segs = [win.start];
            if (win.steady) segs.push(win.steady);
            if (win.echo && win.echo.small) segs.push(win.echo);
        }
        segs = segs.map(function (s) { return Object.assign({}, s); });
        const pw = W - left - right, BREAK = 26;
        const kinds = segs.map(function (s) { return s.kind; }).join(',');
        const fracs = { 'start': [1], 'steady': [1], 'echo': [1], 'start,steady': [0.78, 0.22], 'start,echo': [0.72, 0.28],
            'start,steady,echo': [0.56, 0.2, 0.24] }[kinds] || segs.map(function () { return 1 / segs.length; });
        let x = left;
        const avail = pw - BREAK * (segs.length - 1);
        segs.forEach(function (s, k) { s.x0 = x; s.x1 = x + fracs[k] * avail; x = s.x1 + BREAK; });
        const X = function (s, t) { return s.x0 + (t - s.t0) / (s.t1 - s.t0) * (s.x1 - s.x0); };
        const segsOf = function (t) { return segs.filter(function (s) { return t >= s.t0 - 1e-9 && t <= s.t1 + 1e-9; }); };
        const mzTop = top, mzBot = top + mzH, mxyTop = mzBot + gapP, mxyBot = mxyTop + mxyH;
        const Ymz = function (v) { return mzTop + (1 - v) / 2 * mzH; };
        const Ymxy = function (v) { return mxyTop + (1 - v) * mxyH; };
        const useS = ev.t[ev.t.length - 1] >= 2, tu = useS ? 1 : 1000;
        C.evoLayout = { segs: segs, left: left, right: right, W: W, H: H, mzTop: mzTop, mzBot: mzBot, mxyTop: mxyTop, mxyBot: mxyBot, X: X, Ymz: Ymz, Ymxy: Ymxy, useS: useS };

        const prog = C.prog;
        ctx.font = '11px ' + c.font;
        // dummy repetitions, shaded
        if (prog && prog.periods) {
            prog.periods.forEach(function (p) {
                if (!p.dummy) return;
                segs.forEach(function (s) {
                    const a = max(p.t0, s.t0), b = min(p.t0 + p.dur, s.t1);
                    if (b <= a) return;
                    const xa = X(s, a), xb = X(s, b);
                    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
                    ctx.fillRect(xa, mzTop, xb - xa, mxyBot - mzTop);
                    ctx.font = '10px ' + c.font;
                    if (xb - xa > ctx.measureText('dummy').width + 10) {
                        ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
                        ctx.fillText('dummy', (xa + xb) / 2, mzBot - 3);
                    }
                });
            });
        }
        // grids and axes
        ctx.lineWidth = 1;
        segs.forEach(function (s) {
            ctx.strokeStyle = c.grid; ctx.beginPath();
            [-1, -0.5, 0.5, 1].forEach(function (v) { const y = Math.round(Ymz(v)) + 0.5; ctx.moveTo(s.x0, y); ctx.lineTo(s.x1, y); });
            [0.5, 1].forEach(function (v) { const y = Math.round(Ymxy(v)) + 0.5; ctx.moveTo(s.x0, y); ctx.lineTo(s.x1, y); });
            ctx.stroke();
            ctx.strokeStyle = c.axis; ctx.beginPath();
            const y0 = Math.round(Ymz(0)) + 0.5; ctx.moveTo(s.x0, y0); ctx.lineTo(s.x1, y0);
            const y1 = Math.round(Ymxy(0)) + 0.5; ctx.moveTo(s.x0, y1); ctx.lineTo(s.x1, y1);
            ctx.stroke();
            if (s.kind === 'echo' && segs.length > 1) {          // frame the zoom so it reads as an inset
                ctx.strokeStyle = c.axis; ctx.setLineDash([2, 3]);
                ctx.strokeRect(Math.round(s.x0) + 0.5, mzTop - 0.5, Math.round(s.x1 - s.x0), mxyBot - mzTop + 1);
                ctx.setLineDash([]);
            }
        });
        ctx.strokeStyle = c.axis; ctx.beginPath();
        ctx.moveTo(left + 0.5, mzTop); ctx.lineTo(left + 0.5, mzBot);
        ctx.moveTo(left + 0.5, mxyTop); ctx.lineTo(left + 0.5, mxyBot);
        ctx.stroke();
        ctx.font = '11px ' + c.font;
        ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        [-1, 0, 1].forEach(function (v) { ctx.fillText(String(v).replace('-', '−'), left - 5, Ymz(v)); });
        [0, 1].forEach(function (v) { ctx.fillText(String(v), left - 5, Ymxy(v)); });
        ctx.save();
        ctx.fillStyle = c.fg; ctx.font = '600 11px ' + c.font; ctx.textAlign = 'center';
        ctx.translate(11, (mzTop + mzBot) / 2); ctx.rotate(-PI / 2); ctx.fillText(C.pdScale ? 'PD·Mz' : 'Mz / M0', 0, 0); ctx.restore();
        ctx.save();
        ctx.fillStyle = c.fg; ctx.font = '600 11px ' + c.font; ctx.textAlign = 'center';
        ctx.translate(11, (mxyTop + mxyBot) / 2); ctx.rotate(-PI / 2); ctx.fillText(C.pdScale ? 'PD·|Mxy|' : '|Mxy| / M0', 0, 0); ctx.restore();

        // time ticks per segment: scan time for the repetitions, ms after the excitation in the zoom
        ctx.font = '11px ' + c.font; ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const nice = w()._niceTicks, fmt = w()._fmtTick;
        segs.forEach(function (s) {
            const span = s.x1 - s.x0, zoom = s.kind === 'echo';
            const off = zoom ? s.tRef : 0, u = zoom ? 1000 : tu;
            const tk = nice((s.t0 - off) * u, (s.t1 - off) * u, max(1, Math.round(span / 64)));
            let lastR = -Infinity;
            ctx.strokeStyle = c.axis; ctx.beginPath();
            tk.ticks.forEach(function (v) {
                const t = v / u + off;
                if (t < s.t0 - 1e-9 || t > s.t1 + 1e-9) return;
                const xx = Math.round(X(s, t)) + 0.5;
                ctx.moveTo(xx, mxyBot); ctx.lineTo(xx, mxyBot + 4);
                const lab = fmt(v, tk.step).replace('-', '−'), tw = ctx.measureText(lab).width;
                const xc = U.clamp(xx, s.x0 + tw / 2, s.x1 - tw / 2);
                if (xc - tw / 2 > lastR + 6) { ctx.fillText(lab, xc, mxyBot + 6); lastR = xc + tw / 2; }
            });
            ctx.stroke();
        });
        ctx.textBaseline = 'bottom';
        const main = segs.filter(function (s) { return s.kind !== 'echo'; }), zs = segs.find(function (s) { return s.kind === 'echo'; });
        if (main.length) {
            const xa = main[0].x0, xb = main[main.length - 1].x1;
            ctx.fillText(fitText(ctx, 'time since the start of the scan (' + (useS ? 's' : 'ms') + ')', xb - xa), (xa + xb) / 2, H - 1);
        }
        if (zs) ctx.fillText(fitText(ctx, main.length ? 'ms after excitation' : 'time after the excitation (ms)', zs.x1 - zs.x0 + 8), (zs.x0 + zs.x1) / 2, H - 1);

        // breaks between the windows
        for (let k = 0; k + 1 < segs.length; k++) {
            const xb = (segs[k].x1 + segs[k + 1].x0) / 2;
            ctx.strokeStyle = c.muted; ctx.lineWidth = 1.25;
            [[mzTop, mzBot], [mxyTop, mxyBot]].forEach(function (pr) {
                ctx.beginPath();
                ctx.moveTo(xb - 5, pr[1] + 4); ctx.lineTo(xb - 1, pr[0] - 4);
                ctx.moveTo(xb + 1, pr[1] + 4); ctx.lineTo(xb + 5, pr[0] - 4);
                ctx.stroke();
            });
            ctx.lineWidth = 1;
        }
        // captions over the windows
        ctx.font = '600 11px ' + c.font; ctx.fillStyle = c.fg; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        const pc = ev.center ? ev.center.period : null;
        segs.forEach(function (s, k) {
            let cap;
            if (s.kind === 'start') cap = win.steady ? 'first ' + countPeriods(prog, s) + ' repetitions' : 'the scan from the start';
            else if (s.kind === 'steady') cap = 'repetition ' + (pc !== null && pc !== undefined ? pc + 1 : '') + ': k-space centre';
            else cap = segs.length > 1 ? 'zoom: excitation to echo' : 'repetition ' + (pc !== null && pc !== undefined ? pc + 1 : '') + ', excitation to the k = 0 echo';
            const room = (k + 1 < segs.length ? segs[k + 1].x0 - 4 : W - 2) - s.x0;
            ctx.fillText(fitText(ctx, cap, room), s.x0, 2);
        });

        // RF, spoil and ADC events in a strip above the Mz panel, with faint guides for excitations and inversions
        const ys = 26;
        (ev.events || []).forEach(function (e) {
            segsOf(e.t).forEach(function (s) {
                const xx = X(s, e.t);
                if (e.kind === 'rf' && (e.role === 'excite' || e.role === 'invert')) {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)'; ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, mzTop); ctx.lineTo(Math.round(xx) + 0.5, mxyBot); ctx.stroke();
                }
                drawEventGlyph(ctx, c, e, xx, ys);
            });
        });

        // the k-space centre echo
        if (ev.center) {
            segsOf(ev.center.t).forEach(function (s) {
                const xx = Math.round(X(s, ev.center.t)) + 0.5;
                ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = c.fg; ctx.globalAlpha = 0.7;
                ctx.beginPath(); ctx.moveTo(xx, mzTop); ctx.lineTo(xx, mxyBot); ctx.stroke(); ctx.restore();
                ctx.font = '600 10px ' + c.font; ctx.fillStyle = c.fg; ctx.textBaseline = 'top';
                const lab = s.kind === 'echo' ? 'TE' : 'k = 0 echo', tw = ctx.measureText(lab).width;
                const rightOk = xx + 4 + tw < (s === segs[segs.length - 1] ? W - 2 : s.x1 + 10);
                ctx.textAlign = rightOk ? 'left' : 'right';
                ctx.fillText(lab, rightOk ? xx + 4 : xx - 4, mxyTop + 2);
            });
        }

        // curves
        const pdOf = pdLookup();
        segs.forEach(function (s) {
            ctx.save();
            ctx.beginPath(); ctx.rect(s.x0, mzTop - 2, s.x1 - s.x0, mxyBot - mzTop + 4); ctx.clip();
            ev.tissues.forEach(function (t, k) {
                if (!isShown(t.id)) return;
                const f = C.pdScale ? pdOf(k) : 1;
                const col = scopeColor(t.color), tz = ev.mz[k], txy = ev.mxy[k];
                ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
                ctx.beginPath();
                for (let i = s.i0; i < s.i1; i++) { const xx = X(s, ev.t[i]), yy = Ymz(f * tz[i]); if (i === s.i0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }
                ctx.stroke();
                ctx.beginPath();
                for (let i = s.i0; i < s.i1; i++) { const xx = X(s, ev.t[i]), yy = Ymxy(f * abs(txy[i])); if (i === s.i0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); }
                ctx.stroke();
            });
            ctx.restore();
        });
        // detected signal at each readout: the dots (includes PD and, for gradient echoes, T2' dephasing)
        (ev.adc || []).forEach(function (a, j) {
            const centre = ev.center && j === ev.center.index;
            segsOf(a.t).forEach(function (s) {
                const xx = X(s, a.t);
                ev.tissues.forEach(function (t, k) {
                    if (!isShown(t.id)) return;
                    const pd = pdOf(k);
                    const v = C.pdScale ? abs(a.amp[k]) : (pd > 0 ? abs(a.amp[k]) / pd : NaN);
                    if (!isFinite(v)) return;
                    ctx.fillStyle = scopeColor(t.color);
                    ctx.beginPath(); ctx.arc(xx, Ymxy(min(1, v)), centre ? 3.4 : 2.2, 0, 2 * PI); ctx.fill();
                    if (centre) { ctx.strokeStyle = c.bg; ctx.lineWidth = 1; ctx.stroke(); }
                });
            });
        });
        snapshot(cv);
        if (C.hoverX !== null) paintHover();
    }
    function countPeriods(prog, s) {
        if (!prog || !prog.periods) return '';
        return prog.periods.filter(function (p) { return p.t0 >= s.t0 - 1e-9 && p.t0 < s.t1 - 1e-9; }).length;
    }
    function fitText(ctx, text, width) {
        if (ctx.measureText(text).width <= width) return text;
        let t = text;
        while (t.length > 3 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1);
        return t + '…';
    }
    function drawEventGlyph(ctx, c, e, x, y) {
        ctx.save();
        if (e.kind === 'adc') {
            ctx.fillStyle = c.adc; ctx.fillRect(x - 1, y - 3, 2.5, 6);
        } else if (e.kind === 'spoil') {
            ctx.strokeStyle = c.muted; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
        } else if (e.role === 'excite') {
            ctx.fillStyle = c.rf; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 4); ctx.lineTo(x - 4.5, y + 4); ctx.closePath(); ctx.fill();
        } else if (e.role === 'refocus') {
            ctx.strokeStyle = c.rf; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(x, y - 4.5); ctx.lineTo(x + 4, y + 3.5); ctx.lineTo(x - 4, y + 3.5); ctx.closePath(); ctx.stroke();
        } else if (e.role === 'invert') {
            ctx.fillStyle = c.inv; ctx.beginPath(); ctx.moveTo(x, y + 5); ctx.lineTo(x + 4.5, y - 4); ctx.lineTo(x - 4.5, y - 4); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.5; ctx.lineWidth = 0.8; ctx.stroke();
        } else {
            ctx.fillStyle = c.sat; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
        }
        ctx.restore();
    }
    function snapshot(cv) {
        if (!evoBase) evoBase = doc.createElement('canvas');
        evoBase.width = cv.width; evoBase.height = cv.height;
        evoBase.getContext('2d').drawImage(cv, 0, 0);
    }
    function pdLookup() {
        const ph = C.ph, ev = C.ev;
        const map = {};
        if (ph) ph.tissues.forEach(function (t) { map[t.id] = t.pd; });
        return function (k) { const id = ev.tissues[k].id; return map[id] !== undefined ? map[id] : 1; };
    }
    function evoIndexAt(s, t) {
        const T = C.ev.t;
        let lo = s.i0, hi = s.i1 - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] < t) lo = mid; else hi = mid; }
        return abs(T[lo] - t) <= abs(T[hi] - t) ? lo : hi;
    }
    function paintHover() {
        const cv = ui.evoCanvas, L = C.evoLayout, ev = C.ev;
        if (!cv || !L || !evoBase || !ev) return;
        const ctx = cv.getContext('2d');
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(evoBase, 0, 0); ctx.restore();
        const tip = ui.evoTip;
        if (C.hoverX === null) { tip.hidden = true; return; }
        const s = L.segs.find(function (q) { return C.hoverX >= q.x0 && C.hoverX <= q.x1; });
        if (!s) { tip.hidden = true; return; }
        const t = s.t0 + (C.hoverX - s.x0) / (s.x1 - s.x0) * (s.t1 - s.t0);
        const i = evoIndexAt(s, t), ti = ev.t[i], xx = Math.round(L.X(s, ti)) + 0.5;
        const c = scopeColors();
        ctx.strokeStyle = c.fg; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xx, L.mzTop); ctx.lineTo(xx, L.mxyBot); ctx.stroke(); ctx.globalAlpha = 1;
        const pdOf = pdLookup();
        const rows = [];
        ev.tissues.forEach(function (tt, k) {
            if (!isShown(tt.id)) return;
            const f = C.pdScale ? pdOf(k) : 1, mz = f * ev.mz[k][i], mxy = f * abs(ev.mxy[k][i]), col = scopeColor(tt.color);
            ctx.fillStyle = col;
            ctx.beginPath(); ctx.arc(L.X(s, ti), L.Ymz(mz), 3, 0, 2 * PI); ctx.fill();
            ctx.beginPath(); ctx.arc(L.X(s, ti), L.Ymxy(mxy), 3, 0, 2 * PI); ctx.fill();
            rows.push({ col: col, text: tt.name + ': Mz ' + fsig3(mz) + ', |Mxy| ' + fsig3(mxy) });
        });
        tip.textContent = '';
        const tlab = s.kind === 'echo' ? fnum((ti - s.tRef) * 1000, 4) + ' ms after the excitation' : 't = ' + (L.useS ? U.fmtNum(ti, 5) + ' s' : U.fmtNum(ti * 1000, 4) + ' ms');
        tip.appendChild(el('div', { class: 'plot-tip-x', text: tlab + (C.pdScale ? '  (× PD)' : '') }));
        rows.slice(0, 8).forEach(function (r) {
            tip.appendChild(el('div', {}, [el('span', { class: 'swatch', style: { background: r.col }, 'aria-hidden': 'true' }), r.text]));
        });
        if (rows.length > 8) tip.appendChild(el('div', { class: 'plot-tip-x', text: '+ ' + (rows.length - 8) + ' more' }));
        tip.hidden = false;
        const tw = tip.offsetWidth, sw = ui.evoStage.clientWidth;
        let tx = C.hoverX + 14;
        if (tx + tw > sw) tx = max(0, C.hoverX - 14 - tw);
        tip.style.left = tx + 'px';
        tip.style.top = (L.mzTop + 4) + 'px';
    }
    const paintHoverThrottled = (function () {
        let pending = false;
        return function () { if (pending) return; pending = true; raf(function () { pending = false; paintHover(); }); };
    })();

    /* ---------- bars and contrast table ---------- */
    function renderBars() {
        const box = ui.bars;
        if (!box) return;
        box.textContent = '';
        ui.barsHead.textContent = '';
        const ev = C.ev;
        if (!ev || !ev.center) {
            box.appendChild(el('p', { class: 'ct-bars-note', text: C.ev ? 'This sequence has no readout, so there is no echo to measure.' : 'Nothing to show yet.' }));
            return;
        }
        const amp = ev.center.amp;
        ui.barsHead.textContent = (C.info && C.info.nRef > 1 ? 'TEeff ' : 'TE ') + fms(ev.center.te) + ' ms, readout ' + (ev.center.index + 1) + ' of ' + ev.adc.length;
        let mx = 0;
        for (let k = 0; k < amp.length; k++) mx = max(mx, abs(amp[k]));
        const order = ev.tissues.map(function (t, k) { return k; }).sort(function (a, b) { return abs(amp[b]) - abs(amp[a]); });
        let anyNeg = false;
        const list = el('div', { class: 'ct-bars', role: 'list', 'aria-label': 'Signal of each tissue at the k-space centre, largest first' });
        order.forEach(function (k) {
            const t = ev.tissues[k], v = amp[k], neg = v < -1e-6;
            anyNeg = anyNeg || neg;
            const col = scopeColor(t.color);
            const pct = mx > 0 ? 100 * abs(v) / mx : 0;
            const row = el('div', { class: 'ct-bar' + (isShown(t.id) ? '' : ' is-off'), role: 'listitem',
                'aria-label': t.name + ': ' + fsig3(v) + (neg ? ' (negative: Mz was still inverted at the excitation)' : '') }, [
                el('span', { class: 'ct-bar-name', 'aria-hidden': 'true', title: t.name }, [el('span', { class: 'swatch', style: { background: col } }), el('span', { text: shortName(t.name) })]),
                el('span', { class: 'ct-bar-track', 'aria-hidden': 'true' }, [el('span', { class: 'ct-bar-fill' + (neg ? ' neg' : ''), style: { width: pct.toFixed(1) + '%', backgroundColor: col } })]),
                el('span', { class: 'ct-bar-val', 'aria-hidden': 'true', text: fsig3(v) })
            ]);
            list.appendChild(row);
        });
        box.appendChild(list);
        box.appendChild(el('p', { class: 'ct-bars-note', html:
            'Signal as a fraction of the magnetisation of fully relaxed pure water (M<sub>0</sub> = 1), before coil sensitivity and noise. ' +
            (anyNeg ? 'Striped bars are negative: that tissue\'s Mz was still inverted when it was excited. A magnitude image shows |S|, so a ' +
                'negative tissue looks just as bright as a positive one of the same size. ' : '') +
            'Faded rows are hidden in the plots.' }));
        renderPairs();
    }

    const PAIRS = [['gm', 'wm'], ['deepgm', 'wm'], ['wm', 'csf'], ['lesion', 'wm'], ['fat', 'wm'], ['oil', 'water']];
    function renderPairs() {
        const box = ui.pairs;
        box.textContent = '';
        const ev = C.ev;
        ui.pairPick.hidden = true;
        ui.pairNote.textContent = '';
        if (!ev || !ev.center) return;
        const idx = {};
        ev.tissues.forEach(function (t, k) { idx[t.id] = k; });
        const amp = ev.center.amp;
        const sigma = imageNoise(C.prog);
        const pairs = PAIRS.filter(function (p) { return idx[p[0]] !== undefined && idx[p[1]] !== undefined; });
        // the student's own pair: two persistent selects (rebuilt only when the tissues change, so focus stays)
        if (ev.tissues.length >= 2) {
            if (idx[C.pair.a] === undefined) C.pair.a = ev.tissues[0].id;
            if (idx[C.pair.b] === undefined) C.pair.b = ev.tissues[ev.tissues[1].id === C.pair.a ? 0 : 1].id;
            const key = ev.tissues.map(function (t) { return t.id; }).join(',');
            const opts = ev.tissues.map(function (t) { return { value: t.id, label: t.name }; });
            if (ui.pairPick.dataset.key !== key) {
                ui.pairPick.dataset.key = key;
                ui.pairA.setOptions(opts, C.pair.a);
                ui.pairB.setOptions(opts, C.pair.b);
            } else { ui.pairA.set(C.pair.a); ui.pairB.set(C.pair.b); }
            ui.pairPick.hidden = false;
        }
        const table = el('table', { class: 'ct-table' });
        table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', text: 'Brighter and darker' }),
            el('th', { scope: 'col', class: 'num', text: 'Difference' }),
            el('th', { scope: 'col', class: 'num', text: 'Ratio' }),
            el('th', { scope: 'col', class: 'num', html: '<abbr title="Contrast-to-noise ratio per voxel, estimated from the noise model">CNR</abbr>' })
        ])]));
        const tb = el('tbody');
        const row = function (a, b, mine) {
            const ka = idx[a], kb = idx[b];
            if (ka === undefined || kb === undefined || ka === kb) return;
            const sa = abs(amp[ka]), sb = abs(amp[kb]);
            const brightFirst = sa >= sb;
            const tHi = ev.tissues[brightFirst ? ka : kb], tLo = ev.tissues[brightFirst ? kb : ka];
            const top = max(sa, sb), lo = min(sa, sb), d = top - lo;
            const tie = d < 0.002 * max(top, 1e-6) || d < 1e-5;
            const ratio = lo > 1e-6 ? top / lo : Infinity;
            let cnr = '-';
            if (sigma === 0) cnr = 'no noise';
            else if (sigma > 0) cnr = fnum(d / sigma, 3);
            const name = el('td', { class: 'ct-pair-name' }, [
                mine ? el('span', { class: 'badge badge-muted ct-mine', text: 'yours' }) : null,
                el('span', { class: 'swatch', style: { background: tHi.color }, 'aria-hidden': 'true' }),
                el('strong', { text: shortName(tHi.name) }),
                el('span', { class: 'ct-rel', text: tie ? ' = ' : ' > ' }),
                el('span', { class: 'swatch', style: { background: tLo.color }, 'aria-hidden': 'true' }), shortName(tLo.name)
            ]);
            tb.appendChild(el('tr', {}, [
                name,
                el('td', { class: 'num', text: fsig3(d) }),
                el('td', { class: 'num', text: tie ? '1.00' : (isFinite(ratio) ? (ratio >= 100 ? '> 100' : ratio.toFixed(2)) + '×' : '∞') }),
                el('td', { class: 'num', text: cnr })
            ]));
        };
        pairs.forEach(function (p) { row(p[0], p[1]); });
        if (ev.tissues.length >= 2 && C.pair.a !== C.pair.b) row(C.pair.a, C.pair.b, true);
        table.appendChild(tb);
        if (ev.tissues.length < 2) {
            box.appendChild(el('p', { class: 'note', text: 'This phantom has a single tissue, so there is nothing to contrast.' }));
            return;
        }
        if (!tb.children.length) box.appendChild(el('p', { class: 'note', text: 'Pick two different tissues below to compare them.' }));
        else box.appendChild(el('div', { class: 'ct-wrap' }, [table]));
        const thick = C.prog && C.prog.image ? C.prog.image.thickness : 0.005;
        ui.pairNote.innerHTML = 'Each row names the brighter tissue first. Difference and ratio use |S|, as in a magnitude image. ' +
            (sigma > 0 ? 'CNR = difference / image noise, estimated for this voxel (' + voxelText(C.prog) + ', slice ' + U.fmtNum(thick * 1000, 3) +
                ' mm), bandwidth and NEX with a single uniform coil; the head coil gives about this in the middle of the head and more near the coils.'
                : (sigma === 0 ? 'Noise is switched off on the Artifacts tab.' : 'CNR is estimated only for fully sampled Cartesian scans (SENSE, partial Fourier and non-Cartesian trajectories change the noise).'));
    }
    function shortName(n) { return String(n).replace(/\s*\(.*\)\s*$/, ''); }
    function voxelText(prog) {
        const im = prog && prog.image;
        if (!im) return '';
        return U.fmtNum(im.fovX / im.nx * 1000, 3) + ' × ' + U.fmtNum(im.fovY / im.ny * 1000, 3) + ' mm';
    }

    /* ---------- the textbook equation ---------- */
    function renderEquation() {
        const box = ui.eq;
        box.textContent = '';
        const info = C.info, ev = C.ev, ph = C.ph;
        if (!info || !ev || !ev.center || info.family === 'none') {
            box.appendChild(el('p', { class: 'note', text: 'No equation: this sequence has no excitation followed by a readout.' }));
            return;
        }
        if (info.family === 'ir-gre') {
            box.appendChild(el('p', { class: 'note', text: 'Inversion-prepared gradient echoes have no single textbook formula: the result depends on the whole ' +
                'train of small flips after the inversion. Use the curves and the sweep instead.' }));
            return;
        }
        box.appendChild(el('p', { class: 'mb-1' }, [el('span', { class: 'ct-family', text: FAMILY_NAME[info.family] }), ', the textbook steady-state signal:']));
        box.appendChild(el('div', { class: 'ct-eq', html: equationHTML(info.family) }));
        const chips = el('div', { class: 'ct-chips mb-1' });
        chips.appendChild(el('span', { class: 'ct-pchip', text: 'TR = ' + fms(info.TR) + ' ms' }));
        if (info.TI) chips.appendChild(el('span', { class: 'ct-pchip', text: 'TI = ' + fms(info.TI) + ' ms' }));
        chips.appendChild(el('span', { class: 'ct-pchip', text: (info.nRef > 1 ? 'TEeff = ' : 'TE = ') + fms(info.TE) + ' ms' }));
        if (info.family === 'gre') chips.appendChild(el('span', { class: 'ct-pchip', text: 'α = ' + fnum(info.flip, 3) + '°' }));
        box.appendChild(chips);

        const tissues = {};
        if (ph) ph.tissues.forEach(function (t) { tissues[t.id] = t; });
        let maxS = 0;
        ev.tissues.forEach(function (t, k) { maxS = max(maxS, abs(ev.center.amp[k])); });
        // agree: within 2 % of the tissue's own signal, or a negligible fraction of the brightest
        const tolOf = function (S) { return max(5e-4, 0.02 * abs(S), 0.002 * maxS); };
        const table = el('table', { class: 'ct-table' });
        table.appendChild(el('thead', {}, [el('tr', {}, [
            el('th', { scope: 'col', text: 'Tissue' }),
            el('th', { scope: 'col', class: 'num', text: 'Textbook' }),
            el('th', { scope: 'col', class: 'num', text: 'Simulated' }),
            el('th', { scope: 'col', class: 'num', text: 'Difference' })
        ])]));
        const tb = el('tbody');
        let worst = 0, worstName = '';
        const mism = {};
        ev.tissues.forEach(function (t, k) {
            const T = tissues[t.id];
            if (!T) return;
            const S = textbook(info, T), sim = ev.center.amp[k], d = sim - S;
            const okk = isFinite(d) && abs(d) <= tolOf(S);
            if (isFinite(d) && abs(d) > worst) { worst = abs(d); worstName = t.name; }
            if (!okk) mism[t.id] = true;
            tb.appendChild(el('tr', {}, [
                el('td', {}, [el('span', { class: 'swatch', style: { background: t.color }, 'aria-hidden': 'true' }), t.name]),
                el('td', { class: 'num', text: fsig3(S) }),
                el('td', { class: 'num', text: fsig3(sim) }),
                okk ? el('td', { class: 'num' }, [el('span', { class: 'good', text: 'agrees' })]) : el('td', { class: 'num warn', text: (d > 0 ? '+' : '') + fsig3(d) })
            ]));
        });
        table.appendChild(tb);
        box.appendChild(el('div', { class: 'ct-wrap' }, [table]));

        // why they might differ
        const reasons = [];
        const anyMism = Object.keys(mism).length > 0;
        const nT = ev.tissues.length, nBad = Object.keys(mism).length;
        reasons.push({ on: !anyMism, html: anyMism
            ? (nT - nBad) + ' of ' + nT + ' tissues agree within 2 percent. The largest difference is ' + fsig3(worst) + ' (' + escapeHTML(worstName) +
                '); the reasons below explain it.'
            : 'The tissue tracker reproduces the textbook equation for this sequence (every tissue within 2 percent).' });
        if (info.family === 'tse' || info.family === 'ir-tse') {
            reasons.push({ on: true, html: '<strong>Echo train.</strong> Each of the ' + info.nRef + ' refocusing pulses flips Mz again, so after the train ' +
                'longitudinal recovery starts from about zero, not from the single inversion at TE/2 that the spin-echo formula assumes. ' +
                'Long-T1 tissue (CSF) recovers less than the formula predicts when TR is not much longer than T1.' });
        }
        if (info.family === 'ir-se' || info.family === 'ir-tse') {
            reasons.push({ on: true, html: '<strong>Refocusing after the excitation.</strong> The textbook inversion-recovery formula ignores that the ' +
                '180&deg; refocusing pulse(s) also invert Mz before the next inversion. The effect is small when TR &#8811; T1 and largest for CSF.' });
        }
        if ((info.family === 'se' || info.family === 'ir-se' || info.family === 'tse' || info.family === 'ir-tse') &&
            (abs(info.flip - 90) > 0.5 || (info.refFlip !== null && abs(info.refFlip - 180) > 0.5))) {
            reasons.push({ on: true, html: '<strong>Flip angles.</strong> The formula assumes a 90&deg; excitation and 180&deg; refocusing pulses; this sequence uses ' +
                fnum(info.flip, 3) + '&deg;' + (info.refFlip !== null ? ' and ' + fnum(info.refFlip, 3) + '&deg;' : '') + '.' });
        }
        if (info.sat) {
            reasons.push({ on: true, html: '<strong>Saturation pulse.</strong> A spectrally selective pulse (fat saturation) knocks down the magnetisation of ' +
                'tissue at its frequency before every excitation; the textbook equation leaves it out, so fat comes out far lower than the formula.' });
        }
        if (info.family === 'gre' && ph) {
            const a = info.flip * PI / 180;
            let worstQ = 0;
            ev.tissues.forEach(function (t) {
                const T = tissues[t.id];
                if (!T || !(T.pd > 0.05)) return;
                const q = Math.pow(abs(cos(a) * exp(-info.TR / T.t1)), info.nPrior);
                worstQ = max(worstQ, q);
            });
            if (worstQ > 0.003) {
                reasons.push({ on: true, html: '<strong>Not yet in steady state.</strong> The k-space centre is recorded in repetition ' + (info.cp + 1) +
                    '. A spoiled gradient echo settles as (cos&thinsp;&alpha;&middot;e<sup>&minus;TR/T1</sup>)<sup>n</sup>, so long-T1 tissue has not quite ' +
                    'reached the steady state the formula describes. More dummy scans would fix it.' });
            }
        }
        const b1 = state().artifacts && state().artifacts.b1 ? state().artifacts.b1.amount : 0;
        reasons.push({ on: b1 > 0, html: '<strong>B1.</strong> Both columns use the nominal flip angle. ' + (b1 > 0
            ? 'B1 shading is on (Artifacts tab), so in the image the actual flip varies across the head and pixel values differ from both columns.'
            : 'With B1 shading on (Artifacts tab) the image would also differ from place to place.') });
        reasons.push({ on: false, html: 'The tracker follows one coherence pathway with ideal spoiling and perfect slice profiles, so stimulated echoes ' +
            '(important in turbo spin echo trains with imperfect refocusing) and balanced steady-state free precession are outside the model.' });
        const ul = el('ul', { class: 'ct-reasons' });
        reasons.forEach(function (r) { ul.appendChild(el('li', { class: r.on ? 'is-on' : 'muted', html: r.html })); });
        box.appendChild(el('p', { class: 'mt-2 mb-0', html: '<strong>Why they might not agree</strong>' }));
        box.appendChild(ul);
    }

    /* ---------- the sweep ---------- */
    function sweepableParams(prog) {
        return (prog && prog.params ? prog.params : []).filter(function (p) { return isFinite(p.min) && isFinite(p.max) && p.max > p.min; });
    }
    const PREF = { gre: ['flip', 'TR', 'TE'], se: ['TE', 'TR'], tse: ['ESP', 'TR', 'ETL'], 'ir-se': ['TI', 'TR', 'TE'], 'ir-tse': ['TI', 'TR', 'ESP'], 'ir-gre': ['TI', 'flip', 'TR'] };
    function chooseParam(prog) {
        const list = sweepableParams(prog), names = list.map(function (p) { return p.name; });
        if (C.sweep.wanted && names.indexOf(C.sweep.wanted) >= 0) { C.sweep.name = C.sweep.wanted; C.sweep.wanted = null; return C.sweep.name; }
        if (C.sweep.name && names.indexOf(C.sweep.name) >= 0) return C.sweep.name;
        const pref = (C.info && PREF[C.info.family]) || ['TR', 'TE'];
        for (const n of pref) if (names.indexOf(n) >= 0) { C.sweep.name = n; return n; }
        C.sweep.name = names[0] || null;
        return C.sweep.name;
    }
    function sweepValues(p) {
        const out = [];
        const integerish = p.kind === 'none' && Number.isInteger(p.min) && Number.isInteger(p.max) && Number.isInteger(p.value);
        const N = 25;
        for (let j = 0; j < N; j++) {
            let v = p.min + (p.max - p.min) * j / (N - 1);
            if (p.step > 0) v = p.min + Math.round((v - p.min) / p.step) * p.step;
            else if (integerish) v = Math.round(v);
            else v = Number(v.toPrecision(6));
            v = U.clamp(v, p.min, p.max);
            if (!out.length || abs(out[out.length - 1] - v) > 1e-12 * max(1, abs(v))) out.push(v);
        }
        return out;
    }
    function sweepKey(prog, p, ph) {
        let norm = prog.source;
        try { norm = MRI.dsl.setParamInSource(prog.source, prog, p.name, p.min); } catch (e) { /* keep the source */ }
        return p.name + '|' + idOf(ph) + '|' + norm;
    }

    function renderSweepTools() {
        const prog = C.prog, list = sweepableParams(prog);
        const name = chooseParam(prog);
        ui.paramSel.setOptions(list.length ? list.map(function (p) {
            return { value: p.name, label: p.name + (p.unit ? ' (' + p.unit + ')' : '') + (p.description ? ': ' + p.description : '') };
        }) : [{ value: '', label: 'No parameter with a range' }], name || '');
        ui.paramSel.setDisabled(!list.length);
    }

    function startSweep() {
        const token = ++C.sweep.token;
        C.sweep.running = false;
        const prog = C.prog, ph = C.ph;
        const p = sweepableParams(prog).find(function (q) { return q.name === C.sweep.name; });
        if (!prog || !ph || !p || !MRI.dsl || !MRI.engine) { C.sweep.result = null; setProgress(null); drawSweep(); return; }
        const key = sweepKey(prog, p, ph);
        const hit = C.sweep.cache.get(key);
        if (hit) { C.sweep.result = Object.assign({}, hit, { param: p }); setProgress(null); drawSweep(); return; }
        const xs = sweepValues(p);
        const nT = ph.tissues.length - 1;
        const res = { key: key, param: p, xs: xs, ys: [], done: 0, failed: 0, firstError: null, ids: ph.tissues.slice(1).map(function (t) { return t.id; }) };
        for (let k = 0; k < nT; k++) res.ys.push(new Float64Array(xs.length).fill(NaN));
        C.sweep.result = res;
        C.sweep.running = true;
        setProgress(0, p);
        drawSweep();
        const src = prog.source;
        let j = 0;
        const step = function () {
            if (token !== C.sweep.token) return;              // superseded or cancelled
            const t0 = now();
            while (j < xs.length && now() - t0 < 24) {
                const ov = {}; ov[p.name] = xs[j];
                try {
                    const pr = MRI.dsl.compile(src, { overrides: ov });
                    if (pr && pr.ok) {
                        const e2 = MRI.engine.tissueEvolution(pr, ph, { periods: 1, points: 16 });
                        if (e2 && e2.center) {
                            const map = {};
                            e2.tissues.forEach(function (t, k) { map[t.id] = e2.center.amp[k]; });
                            res.ids.forEach(function (id, k) { if (map[id] !== undefined) res.ys[k][j] = map[id]; });
                        } else res.failed++;
                    } else {
                        res.failed++;
                        if (!res.firstError && pr && pr.errors && pr.errors[0]) res.firstError = pr.errors[0].msg;
                    }
                } catch (e) { res.failed++; if (!res.firstError) res.firstError = e && e.message ? e.message : String(e); }
                j++;
                res.done = j;
            }
            if (token !== C.sweep.token) return;
            if (j < xs.length) {
                setProgress(j / xs.length, p);
                drawSweep();
                setTimeout(function () { raf(step); }, 0);
            } else {
                C.sweep.running = false;
                C.sweep.cache.set(key, res);
                while (C.sweep.cache.size > 12) C.sweep.cache.delete(C.sweep.cache.keys().next().value);
                setProgress(null, p);
                drawSweep();
            }
        };
        raf(step);
    }
    function cancelSweep() { C.sweep.token++; C.sweep.running = false; }
    function setProgress(frac, p) {
        const box = ui.progress;
        if (!box) return;
        box.textContent = '';
        if (frac === null || frac === undefined) {
            const r = C.sweep.result;
            if (r && r.done === r.xs.length) {
                let msg = r.xs.length + ' values of ' + r.param.name + ' from ' + fparamDisplay(r.param, r.param.min) + ' to ' + fparamDisplay(r.param, r.param.max) + '.';
                if (r.failed) msg += ' ' + r.failed + ' did not compile (gaps)' + (r.firstError ? ', e.g. "' + r.firstError + '"' : '') + '.';
                box.appendChild(el('span', { text: msg }));
            }
            return;
        }
        box.appendChild(el('span', { text: 'Sweeping ' + (p ? p.name : '') + '…' }));
        const bar = el('span', { class: 'ct-progress-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(100 * frac)), 'aria-label': 'Sweep progress' },
            [el('span', { class: 'ct-progress-fill', style: { width: (100 * frac).toFixed(0) + '%' } })]);
        box.appendChild(bar);
    }

    function ensureSweepPlot(p) {
        const label = p ? p.name + (p.unit ? ' (' + p.unit + ')' : '') : 'parameter';
        if (ui.sweepPlot && C.sweep.plotFor === label) return ui.sweepPlot;
        if (ui.sweepPlot && ui.sweepPlot.el.parentNode) ui.sweepPlot.el.parentNode.removeChild(ui.sweepPlot.el);
        C.sweep.plotFor = label;
        const plot = w().plot(null, { height: 260, scope: true, xlabel: label, ylabel: 'signal (× M0)' });
        plot.el.classList.add('ct-sweep-plot');
        ui.sweepHost.appendChild(plot.el);
        const cv = plot.canvas;
        cv.tabIndex = 0;
        cv.addEventListener('click', function (ev) { onSweepClick(ev); });
        cv.addEventListener('keydown', onSweepKey);
        ui.sweepPlot = plot;
        return plot;
    }
    function currentParam() {
        const prog = C.prog;
        return sweepableParams(prog).find(function (q) { return q.name === C.sweep.name; }) || null;
    }
    function snapParam(p, v) {
        v = U.clamp(v, p.min, p.max);
        if (p.step > 0) v = p.min + Math.round((v - p.min) / p.step) * p.step;
        else if (p.kind === 'none' && Number.isInteger(p.min) && Number.isInteger(p.max) && Number.isInteger(p.value)) v = Math.round(v);
        else {
            // three significant figures in display units: 90.4 ms, 2410 ms, 47.3 deg
            const d = v / (p.scale || 1);
            v = Number(d.toPrecision(3)) * (p.scale || 1);
        }
        return U.clamp(v, p.min, p.max);
    }
    function setParamTo(p, v) {
        v = snapParam(p, v);
        if (abs(v - p.value) <= 1e-12 * max(1, abs(v))) return;
        MRI.actions.setParam(p.name, v);
    }
    function onSweepClick(ev) {
        const p = currentParam(), plot = ui.sweepPlot;
        if (!p || !plot) return;
        const L = plot.layout();
        if (!L) return;
        const rect = plot.canvas.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
        if (mx < L.left || mx > L.left + L.pw || my < L.top - 4 || my > L.top + L.ph + 4) return;
        const xv = L.xlo + (mx - L.left) / L.pw * (L.xhi - L.xlo);
        setParamTo(p, xv * (p.scale || 1));
    }
    function onSweepKey(e) {
        const p = currentParam(), r = C.sweep.result;
        if (!p || !r || !r.xs.length) return;
        let dir = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') dir = 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') dir = -1;
        else if (e.key === 'Home') { e.preventDefault(); setParamTo(p, r.xs[0]); return; }
        else if (e.key === 'End') { e.preventDefault(); setParamTo(p, r.xs[r.xs.length - 1]); return; }
        if (!dir) return;
        e.preventDefault();
        // the next sweep value above or below the current one that is still
        // different once rounded (2395.8 ms rounds back to 2400 ms)
        const tol = 1e-9 * max(1, abs(p.value));
        const order = dir > 0 ? r.xs : r.xs.slice().reverse();
        for (const x of order) {
            const s = snapParam(p, x);
            if ((dir > 0 && s > p.value + tol) || (dir < 0 && s < p.value - tol)) { setParamTo(p, s); return; }
        }
    }

    function drawSweep() {
        if (!C.visible || !ui.sweepHost) return;
        const r = C.sweep.result, p = currentParam();
        const plot = ensureSweepPlot(p || (r && r.param));
        ui.sweepCheck.textContent = '';
        if (!r || !p || r.param.name !== p.name) {
            plot.draw([], {});
            plot.canvas.setAttribute('aria-label', 'Sweep plot: no parameter to sweep.');
            return;
        }
        const scale = p.scale || 1, xs = r.xs.map(function (v) { return v / scale; });
        const ev = C.ev, ph = C.ph;
        const colorOf = {}, nameOf = {};
        if (ph) ph.tissues.forEach(function (t) { colorOf[t.id] = t.color; nameOf[t.id] = t.name; });
        const signed = C.sweep.signed;
        const series = [];
        r.ids.forEach(function (id, k) {
            if (!isShown(id) || !colorOf[id]) return;
            const ys = Array.from(r.ys[k], function (v) { return signed ? v : abs(v); });
            series.push({ x: xs, y: ys, color: scopeColor(colorOf[id]), label: shortName(nameOf[id]), width: 2, points: xs.length <= 9 ? 3 : false });
        });
        const cur = p.value / scale;
        plot.draw(series, {
            xlim: [p.min / scale, p.max / scale], includeZero: true,
            markers: [{ x: cur, label: 'now ' + U.fmtNum(cur, 4) + (p.unit ? ' ' + p.unit : ''), color: 'var(--scope-fg)' }],
            hlines: signed ? [{ y: 0, color: 'var(--scope-axis)', dash: false }] : []
        });
        plot.canvas.setAttribute('aria-label', 'Signal of each tissue against ' + p.name + ' from ' + fparamDisplay(p, p.min) + ' to ' + fparamDisplay(p, p.max) +
            '; the current value ' + fparamDisplay(p, p.value) + ' is marked. Click the plot, or use the arrow keys, to set ' + p.name + '.');
        if (r.done === r.xs.length) renderSweepCheck(p, r);
        void ev;
    }

    /* For a flip-angle sweep of a spoiled gradient echo, the Ernst angle;
       for a TI sweep of an inversion recovery, the textbook null points.
       Each next to the value the sweep found, so students can check. */
    function renderSweepCheck(p, r) {
        const info = C.info, ph = C.ph, box = ui.sweepCheck;
        if (!info || !ph) return;
        const tis = {};
        ph.tissues.forEach(function (t) { tis[t.id] = t; });
        // the tissues students compare first, then the rest, at most four
        const order = p.name === 'TI' ? ['csf', 'fat', 'wm', 'gm', 'lesion', 'oil', 'water'] : ['wm', 'gm', 'deepgm', 'csf', 'lesion', 'fat', 'oil', 'water'];
        const rank = function (id) { const i = order.indexOf(id); return i < 0 ? 99 : i; };
        const shown = r.ids.filter(function (id) { return isShown(id) && tis[id] && tis[id].pd > 0.05; })
            .sort(function (a, b) { return rank(a) - rank(b); }).slice(0, 4);
        const parts = [];
        if (p.name === 'flip' && info.family === 'gre') {
            shown.forEach(function (id) {
                const k = r.ids.indexOf(id), T = tis[id];
                const ae = acos(exp(-info.TR / T.t1)) * 180 / PI;
                let bj = -1, bv = -Infinity;
                r.ys[k].forEach(function (v, j) { if (isFinite(v) && abs(v) > bv) { bv = abs(v); bj = j; } });
                parts.push(shortName(T.name) + ' ' + fnum(ae, 3) + '°' + (bj >= 0 ? ' (sweep peak near ' + fnum(r.xs[bj] / (p.scale || 1), 3) + '°)' : ''));
            });
            if (parts.length) {
                box.innerHTML = '<strong>Check:</strong> the Ernst angle, the flip with the most signal, is cos&thinsp;&alpha;<sub>E</sub> = e<sup>&minus;TR/T1</sup>. ' +
                    'With TR = ' + fms(info.TR) + ' ms: ' + parts.map(escapeHTML).join(', ') + '.';
            }
        } else if (p.name === 'TI' && (info.family === 'ir-se' || info.family === 'ir-tse' || info.family === 'ir-gre')) {
            shown.forEach(function (id) {
                const k = r.ids.indexOf(id), T = tis[id];
                const tn = T.t1 * log(2 / (1 + exp(-info.TR / T.t1)));
                // the simulated null: where the signed signal crosses zero
                let zc = null;
                const ys = r.ys[k];
                for (let j = 0; j + 1 < ys.length; j++) {
                    if (isFinite(ys[j]) && isFinite(ys[j + 1]) && ys[j] <= 0 && ys[j + 1] > 0) { zc = r.xs[j] + (r.xs[j + 1] - r.xs[j]) * (-ys[j]) / (ys[j + 1] - ys[j]); break; }
                }
                const inRange = tn >= p.min && tn <= p.max;
                parts.push(shortName(T.name) + ' ' + fms(tn) + ' ms' + (zc !== null ? ' (sweep: ' + fms(zc) + ' ms)' : (inRange ? '' : ', outside the range')));
            });
            if (parts.length) {
                box.innerHTML = '<strong>Check:</strong> a tissue is nulled where its Mz crosses zero, TI = T1&middot;ln[2 / (1 + e<sup>&minus;TR/T1</sup>)] ' +
                    '(T1 ln 2 when TR &#8811; T1). With TR = ' + fms(info.TR) + ' ms: ' + parts.map(escapeHTML).join(', ') + '. ' +
                    'Switch on <em>Show sign</em> to see the curves cross zero.';
            }
        }
    }

    /* ---------- recompute ---------- */
    function recompute() {
        if (!C.mounted) return;
        if (!C.visible) { C.dirty = true; cancelSweep(); return; }
        C.dirty = false;
        const s = state();
        const cur = s.program;
        const prog = cur && cur.ok ? cur : s.lastGoodProgram;
        C.failed = cur && !cur.ok ? cur : null;
        C.prog = prog || null;
        C.err = null;
        C.ev = null;
        C.info = null;
        const ph = currentPhantom();
        const phChanged = !C.ph || !ph || C.ph.id !== ph.id;
        C.ph = ph;
        if (prog && ph && MRI.engine && typeof MRI.engine.tissueEvolution === 'function') {
            try {
                // 4000 points: the k-centre repetition gets 1000 of them, enough to draw the echo zoom smoothly
                C.ev = MRI.engine.tissueEvolution(prog, ph, { points: 4000 });
                C.info = analyse(prog, C.ev);
            } catch (e) {
                C.err = e && e.message ? e.message : String(e);
                if (root.console) root.console.warn('[contrast tab] tissueEvolution failed:', e);
            }
        } else if (!ph) C.err = 'the phantom could not be built';
        else if (!MRI.engine) C.err = 'the imaging engine did not load';
        // tissue toggles: sensible defaults for a new phantom, the student's choices kept otherwise
        if (C.ev && (phChanged || !C.togglesFor || C.togglesFor !== C.ev.tissues.map(function (t) { return t.id; }).join(','))) {
            const def = defaultHidden(C.ev, ph ? ph.id : null);
            C.ev.tissues.forEach(function (t) { if (!C.userToggled[t.id] || phChanged) C.hidden[t.id] = !!def[t.id]; });
            if (phChanged) C.userToggled = {};
            C.togglesFor = C.ev.tissues.map(function (t) { return t.id; }).join(',');
        }
        renderStatus();
        renderToggles();
        ui.evoCanvas.setAttribute('aria-label', C.ev
            ? 'Longitudinal (Mz) and transverse (|Mxy|) magnetisation of each tissue over the first repetitions and the repetition that records the k-space centre. ' +
              'The values at the k-space centre are listed in the bar chart below.'
            : 'No magnetisation curves.');
        drawEvolution();
        renderBars();
        renderEquation();
        if (C.prog) renderSweepTools();
        startSweep();
    }
    const scheduleRecompute = U.debounce(recompute, 120);
    function recomputeNow() { recompute(); }

    /* ---------- mount ---------- */
    function buildEvoPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ct-evo-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ct-evo-title', text: 'Magnetisation of each tissue' }),
            el('span', { class: 'panel-sub', text: 'from the start of the scan, then the repetition that records the k-space centre' })
        ]));
        const tools = el('div', { class: 'ct-evo-tools' });
        ui.toggles = el('div', { class: 'ct-toggles', role: 'group', 'aria-label': 'Tissues shown in the plots' });
        ui.pdToggle = w().toggle({ label: 'Scale by proton density', checked: C.pdScale,
            hint: 'On: PD times M, what the coil sees. Off: each tissue relative to its own M0.',
            onChange: function (on) { C.pdScale = !!on; drawEvolution(); } });
        ui.viewHost = el('div', { class: 'ct-viewhost' });
        tools.appendChild(ui.viewHost);
        tools.appendChild(ui.pdToggle);
        panel.appendChild(ui.toggles);
        panel.appendChild(tools);
        const fig = el('figure', { class: 'plot plot-scope' });
        ui.evoStage = el('div', { class: 'ct-evo' });
        ui.evoCanvas = el('canvas', { role: 'img', 'aria-label': 'Magnetisation curves' });
        ui.evoTip = el('div', { class: 'plot-tip', hidden: true });
        ui.evoStage.appendChild(ui.evoCanvas);
        ui.evoStage.appendChild(ui.evoTip);
        fig.appendChild(ui.evoStage);
        const svg = function (inner) { return '<svg viewBox="-6 -6 12 12" aria-hidden="true" focusable="false">' + inner + '</svg>'; };
        fig.appendChild(el('figcaption', { class: 'ct-key' }, [
            el('span', { html: svg('<path d="M0 -5 L4.5 4 L-4.5 4 Z" fill="var(--seq-rf)"/>') + 'excitation' }),
            el('span', { html: svg('<path d="M0 -4.5 L4 3.5 L-4 3.5 Z" fill="none" stroke="var(--seq-rf)" stroke-width="1.3"/>') + 'refocusing 180°' }),
            el('span', { html: svg('<path d="M0 5 L4.5 -4 L-4.5 -4 Z" fill="var(--seq-gz)"/>') + 'inversion' }),
            el('span', { html: svg('<path d="M0 -5 L4 0 L0 5 L-4 0 Z" fill="var(--sc4)"/>') + 'saturation' }),
            el('span', { html: svg('<path d="M-3 -3 L3 3 M3 -3 L-3 3" stroke="var(--scope-muted)" stroke-width="1.3"/>') + 'spoiler' }),
            el('span', { html: svg('<rect x="-1.2" y="-3.5" width="2.5" height="7" fill="var(--seq-adc)"/>') + 'readout (ADC)' }),
            el('span', { html: svg('<circle r="3" fill="var(--scope-fg)"/>') + 'dots: signal detected at each readout' })
        ]));
        panel.appendChild(fig);
        panel.appendChild(el('p', { class: 'simplification', html:
            'Each tissue is followed on its own at nominal B1, with ideal spoiling and one coherence pathway. |Mxy| is that pathway\'s ' +
            'amplitude and decays with T2; in a gradient echo the detected signal (the dots) is lower still, because field variation inside ' +
            'the voxel dephases it with T2′ (together T2*), which a 180° pulse refocuses at a spin echo.' }));
        const stage = ui.evoStage;
        stage.addEventListener('pointermove', function (e) {
            const rect = ui.evoCanvas.getBoundingClientRect();
            C.hoverX = e.clientX - rect.left;
            paintHoverThrottled();
        });
        stage.addEventListener('pointerleave', function () { C.hoverX = null; paintHoverThrottled(); });
        return panel;
    }
    function buildBarsPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ct-bars-title' });
        ui.barsHead = el('span', { class: 'panel-sub' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ct-bars-title', text: 'Signal at the k-space centre' }), ui.barsHead
        ]));
        const fig = el('div', { class: 'plot plot-scope' });
        ui.bars = el('div');
        fig.appendChild(ui.bars);
        panel.appendChild(fig);
        return panel;
    }
    function buildPairsPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ct-pairs-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ct-pairs-title', text: 'Contrast between tissues' })
        ]));
        ui.pairs = el('div');
        panel.appendChild(ui.pairs);
        ui.pairA = w().select({ ariaLabel: 'First tissue of your pair', options: [], onChange: function (v) { C.pair.a = v; renderPairs(); } });
        ui.pairB = w().select({ ariaLabel: 'Second tissue of your pair', options: [], onChange: function (v) { C.pair.b = v; renderPairs(); } });
        ui.pairA.select.classList.add('select-sm'); ui.pairB.select.classList.add('select-sm');
        ui.pairPick = el('div', { class: 'ct-custom', hidden: true }, [el('span', { text: 'Your pair:' }), ui.pairA, el('span', { text: 'and' }), ui.pairB]);
        panel.appendChild(ui.pairPick);
        ui.pairNote = el('p', { class: 'note mt-1' });
        panel.appendChild(ui.pairNote);
        return panel;
    }
    function buildSweepPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ct-sweep-title' });
        ui.sweepPanel = panel;
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ct-sweep-title', text: 'Sweep a parameter' }),
            el('span', { class: 'panel-sub', text: 'each tissue\'s signal at the k-space centre across the declared range; click the plot to set the value' })
        ]));
        const tools = el('div', { class: 'ct-sweep-tools' });
        ui.paramSel = w().select({ label: 'Parameter', options: [{ value: '', label: '-' }], value: '',
            onChange: function (v) { if (v) { C.sweep.name = v; C.sweep.wanted = null; startSweep(); } } });
        tools.appendChild(ui.paramSel);
        ui.signed = w().toggle({ label: 'Show sign', checked: C.sweep.signed,
            hint: 'Plot the signed signal: negative while Mz is still inverted (inversion recovery). Magnitude images show |S|.',
            onChange: function (on) { C.sweep.signed = !!on; drawSweep(); } });
        tools.appendChild(ui.signed);
        ui.progress = el('div', { class: 'ct-progress', 'aria-live': 'polite' });
        tools.appendChild(ui.progress);
        panel.appendChild(tools);
        ui.sweepHost = el('div');
        panel.appendChild(ui.sweepHost);
        ui.sweepCheck = el('p', { class: 'callout ct-check' });
        panel.appendChild(ui.sweepCheck);
        panel.appendChild(el('p', { class: 'note mt-1', text:
            'Each point recompiles the sequence with that one value changed and follows every tissue to the k-space centre, ' +
            'exactly as the scan would. Values that do not compile (for example a TE too short for the readout) leave a gap.' }));
        return panel;
    }
    function buildEqPanel() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ct-eq-title' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ct-eq-title', text: 'Textbook equation against the simulation' })
        ]));
        ui.eq = el('div');
        panel.appendChild(ui.eq);
        return panel;
    }

    MRI.ui.registerTab({
        id: 'contrast', title: 'Contrast', order: 40,
        mount: function (panel) {
            panel.textContent = '';
            panel.appendChild(buildConcept());
            ui.status = el('div');
            panel.appendChild(ui.status);
            panel.appendChild(buildEvoPanel());
            const cols = el('div', { class: 'ct-cols' }, [buildBarsPanel(), buildPairsPanel()]);
            panel.appendChild(cols);
            panel.appendChild(buildSweepPanel());
            panel.appendChild(buildEqPanel());
            C.mounted = true;

            ['program:compiled', 'phantom:changed', 'artifacts:changed'].forEach(function (evt) {
                MRI.bus.on(evt, function () {
                    if (!C.visible) { C.dirty = true; cancelSweep(); return; }
                    scheduleRecompute();
                });
            });
            MRI.bus.on('theme:changed', function () { if (C.visible) { drawEvolution(); } });
            if (root.ResizeObserver) {
                let lastW = -1;
                new root.ResizeObserver(function () {
                    const wNow = ui.evoStage.clientWidth;
                    if (!C.visible || !wNow || wNow === lastW) return;
                    lastW = wNow;
                    raf(drawEvolution);
                }).observe(ui.evoStage);
            }
        },
        onShow: function () {
            C.visible = true;
            if (C.dirty || !C.ev) recompute();
            else {
                drawEvolution(); drawSweep();
                const r = C.sweep.result;
                // a resize also calls onShow: let a running sweep finish rather than restart it
                if (!C.sweep.running && (!r || r.done < r.xs.length)) startSweep();
            }
        },
        onHide: function () {
            C.visible = false;
            C.hoverX = null;
            if (C.sweep.running) { cancelSweep(); C.dirty = true; }
        }
    });

})(typeof window !== 'undefined' ? window : globalThis);
