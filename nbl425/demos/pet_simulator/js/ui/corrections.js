/* ============================================================
   PET Simulator, Degradations & corrections tab
   Every way the image departs from the truth has a physical cause
   (a switch in the simulated physics) and a correction (a switch in
   the reconstruction). This tab puts each pair side by side in a
   switchboard, then gives every effect its own card: the controls
   that shape it, what it looks like, why it happens, how scanners
   correct it, a "Show me" demonstration, and where the correction
   can be judged without re-simulating, a before/after pair of quick
   reconstructions of the data already acquired.

   Physics changes go through PET.actions.setPhysics (they re-scan);
   corrections through PET.actions.setRecon (they only re-reconstruct).
   The before/after pairs call PET.recon.run directly on
   PET.state.acq, one pair at a time, only for cards on screen, and
   are cancelled when the data or the settings change.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.util || !PET.ui || typeof PET.ui.registerTab !== 'function') return;
    const U = PET.util;
    const el = U.el;
    const FOV = 320;

    /* ---------- helpers ---------- */
    function W() { return PET.ui.w; }
    function st() { return PET.state || {}; }
    function phys() { return st().physics || {}; }
    function rec() { return st().recon || {}; }
    function corr() { return rec().corrections || {}; }
    function curAcq() { return st().acq || null; }
    function warn(msg, e) { if (root.console) root.console.warn('[corrections tab] ' + msg, e || ''); }
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
    function clone(o) { return JSON.parse(JSON.stringify(o || {})); }
    function isPlain(o) { return Object.prototype.toString.call(o) === '[object Object]'; }
    function merged(a, b) {
        const out = clone(a);
        Object.keys(b || {}).forEach(function (k) { out[k] = isPlain(b[k]) && isPlain(out[k]) ? merged(out[k], b[k]) : clone({ v: b[k] }).v; });
        return out;
    }
    function fmtT(t) { return t === 0 ? '0' : U.fmtTime(t); }
    function fmt(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3) : '-'; }
    function pct(v, d) { return isFinite(v) ? (100 * v).toFixed(d === undefined ? 0 : d) + ' %' : '-'; }
    function maxOf(a) { let m = -Infinity; for (let k = 0; k < a.length; k++) if (a[k] > m) m = a[k]; return m; }
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
    function frameIndex(acq) { return acq && acq.frames ? Math.min(st().frame || 0, acq.frames.length - 1) : 0; }
    function curFrame(acq) { return acq && acq.frames ? acq.frames[frameIndex(acq)] : null; }
    function physDefaults() {
        try { if (PET.engine && PET.engine.physicsDefaults) return PET.engine.physicsDefaults(); } catch (e) { /* fallback */ }
        return { attenuation: true, scatter: true, randoms: true, noise: true, positronRange: true, detectorBlur: true,
            motion: { on: false, kind: 'step', dx: 6, dy: 0, rot: 0, at: 0.5, period: 5 }, muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' },
            detector: { variation: 0.06, deadBlock: -1 }, seed: 1 };
    }
    function reconDefaults() {
        try { if (PET.recon && PET.recon.defaults) return PET.recon.defaults; } catch (e) { /* fallback */ }
        return { method: 'osem', filter: 'hann', cutoff: 1, order: 4, iterations: 4, subsets: 12, tof: true, psf: false, rangeCorrection: false,
            matrix: 128, postFilter: 3, frame: 0, corrections: { normalization: true, attenuation: true, scatter: true, randoms: true, randomsMethod: 'delayed', decay: true, motion: false } };
    }
    function hasParam(name) {
        const p = st().program && st().program.ok ? st().program : st().lastGoodProgram;
        return p && p.params ? p.params.find(function (q) { return q.name === name; }) || null : null;
    }
    function td(text, cls) { return el('td', { class: cls || null }, text === undefined || text === null ? '-' : String(text)); }
    function dataTable(head, rows) {
        const t = el('table', { class: 'cc-table' });
        t.appendChild(el('thead', {}, el('tr', {}, head.map(function (h) { return el('th', { scope: 'col' }, h); }))));
        const b = el('tbody');
        rows.forEach(function (r) { b.appendChild(el('tr', {}, r)); });
        t.appendChild(b);
        return t;
    }
    function linkBtn(label, fn, title) { return el('button', { type: 'button', class: 'linklike', title: title || null, onclick: fn }, label); }

    /* ---------- styles ---------- */
    const CSS = `
#tab-corrections .cc-board { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
#tab-corrections .cc-board th { text-align: left; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: 0 8px 8px; white-space: nowrap; }
#tab-corrections .cc-board th.cc-c, #tab-corrections .cc-board td.cc-c { text-align: center; }
#tab-corrections .cc-board td { padding: 7px 8px; vertical-align: middle; border-top: 1px solid var(--border-subtle); }
#tab-corrections .cc-board td:first-child, #tab-corrections .cc-board th:first-child { padding-left: 0; }
#tab-corrections .cc-board .toggle { justify-content: center; }
#tab-corrections .cc-board .toggle-label { display: none; }
#tab-corrections .cc-name { font-weight: 600; text-align: left; background: none; border: 0; padding: 0; color: var(--fg); cursor: pointer; font: inherit; font-weight: 600; text-decoration: underline; text-decoration-color: var(--border-strong); text-underline-offset: 3px; }
#tab-corrections .cc-name:hover { color: var(--accent); text-decoration-color: currentColor; }
#tab-corrections .cc-st { display: block; font-size: 0.76rem; margin-top: 1px; color: var(--muted); }
#tab-corrections .cc-st.good { color: var(--good); } #tab-corrections .cc-st.warn { color: var(--warn); } #tab-corrections .cc-st.bad { color: var(--bad); }
#tab-corrections .cc-fixed { font-size: 0.76rem; color: var(--muted); }
#tab-corrections .cc-board .btn-xs { white-space: nowrap; }
#tab-corrections .cc-board-wrap { overflow-x: auto; }
#tab-corrections .plot-legend .legend-item { white-space: normal; }
#tab-corrections .cc-board td.cc-desc { color: var(--muted); font-size: 0.8rem; line-height: 1.4; width: 42%; }
#tab-corrections .cc-board th.cc-c, #tab-corrections .cc-board td.cc-c { width: 104px; }
#tab-corrections .cc-hs { display: none; }
@media (max-width: 760px) { #tab-corrections .cc-board .cc-desc { display: none; } #tab-corrections .cc-board th.cc-c, #tab-corrections .cc-board td.cc-c { width: 1%; padding-left: 6px; padding-right: 6px; } }
@media (max-width: 480px) { #tab-corrections .cc-hl { display: none; } #tab-corrections .cc-hs { display: inline; } }
#tab-corrections .cc-noise-img { max-width: 340px; margin-top: 8px; }
#tab-corrections .cc-statusline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 12px; font-size: 0.82rem; color: var(--muted); }
#tab-corrections .cc-live { font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
#tab-corrections .cc-live.busy { color: var(--accent); }
#tab-corrections .cc-card { scroll-margin-top: 150px; }
#tab-corrections .cc-card .panel-head { margin-bottom: 10px; }
#tab-corrections .cc-shows { display: flex; flex-wrap: wrap; gap: 6px; }
#tab-corrections .cc-body { display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); align-items: start; }
#tab-corrections .cc-body > * { min-width: 0; }
@media (max-width: 860px) { #tab-corrections .cc-body { grid-template-columns: minmax(0, 1fr); } }
#tab-corrections .cc-switches { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-bottom: 10px; }
#tab-corrections .cc-text h3 { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 12px 0 3px; }
#tab-corrections .cc-text h3:first-child { margin-top: 0; }
#tab-corrections .cc-text p { font-size: 0.87rem; line-height: 1.55; margin: 0; }
#tab-corrections .cc-ctl { margin-bottom: 12px; }
#tab-corrections .cc-ctl .controls { --min: 170px; gap: 10px 16px; }
#tab-corrections .cc-look { margin: 12px 0 0; }
#tab-corrections .cc-look .btn { margin-top: 6px; }
#tab-corrections .cc-cmp.is-stale .image-grid, #tab-corrections .cc-cmp.is-stale .plot, #tab-corrections .cc-cmp.is-stale .cc-tablewrap { opacity: 0.4; transition: opacity 0.2s ease; }
#tab-corrections .cc-cmp-title { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 0 0 6px; }
#tab-corrections .cc-cmp .image-grid { --min: 130px; gap: 8px; }
#tab-corrections .cc-cmp .well { padding: 6px; }
#tab-corrections .cc-cmp .well-title { font-size: 0.64rem; margin-bottom: 5px; }
#tab-corrections .cc-cmp .well-readout { font-size: 0.68rem; }
#tab-corrections .cc-cmp-status { font-size: 0.76rem; color: var(--muted); margin: 6px 0; min-height: 1.2em; }
#tab-corrections .cc-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 8px; }
#tab-corrections .cc-table th { text-align: right; font-weight: 600; color: var(--muted); padding: 3px 0 3px 8px; font-size: 0.74rem; white-space: nowrap; }
#tab-corrections .cc-table th:first-child, #tab-corrections .cc-table td:first-child { text-align: left; padding-left: 0; }
#tab-corrections .cc-table td { text-align: right; padding: 3px 0 3px 8px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 0.78rem; border-top: 1px solid var(--border-subtle); }
#tab-corrections .cc-table td:first-child { font-family: var(--font-sans); }
#tab-corrections .cc-table td.good { color: var(--good); } #tab-corrections .cc-table td.warn { color: var(--warn); } #tab-corrections .cc-table td.bad { color: var(--bad); }
#tab-corrections .cc-table tr.is-current td { font-weight: 700; }
#tab-corrections .cc-tablewrap { overflow-x: auto; }
#tab-corrections .cc-formula { font-family: var(--font-math); font-size: 1.02rem; text-align: center; background: var(--card-2); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; margin: 8px 0; }
#tab-corrections .cc-mini .image-grid { --min: 130px; gap: 8px; }
#tab-corrections .cc-mini .well { padding: 6px; }
#tab-corrections .cc-mini .well-title { font-size: 0.64rem; margin-bottom: 5px; }
#tab-corrections .cc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 8px 0; }
#tab-corrections .cc-frame { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
#tab-corrections .cc-frame .ctl { min-width: 180px; flex: 1 1 200px; }
`;

    /* ---------- module state ---------- */
    const S = {
        panel: null, visible: false, mounted: false,
        cards: {}, board: {}, cmp: {}, ui: {},
        lastMu: { dx: 8, dy: 0, rot: 0, model: 'ct' },
        lastDet: { variation: 0.06, deadBlock: -1 },
        gtm: { fwhm: null, user: false, cacheKey: null, result: null },
        acqIds: new WeakMap(), acqCounter: 0,
        acfTrue: new WeakMap()
    };
    function acqId(acq) {
        if (!acq) return 0;
        let id = S.acqIds.get(acq);
        if (!id) { id = ++S.acqCounter; S.acqIds.set(acq, id); }
        return id;
    }

    /* ---------- "Show me": set up a demonstration ----------
       Everything is reset to the defaults first, so a demonstration
       never inherits a switch left over from the previous one. */
    function demo(o) {
        if (o.preset) act('loadPreset', o.preset);
        if (o.edit) {
            const src = st().source || '', ns = o.edit(src);
            if (ns !== src) act('setSource', ns);
        }
        Object.keys(o.params || {}).forEach(function (k) { act('setParam', k, o.params[k]); });
        act('setPhysics', merged(physDefaults(), o.physics || {}));
        const rd = reconDefaults();
        const patch = merged(rd, o.recon || {});
        patch.corrections = merged(rd.corrections, o.corrections || {});
        delete patch.frame;
        delete patch.keepIterations;
        act('setRecon', patch);
        // a demonstration should run even with Auto re-scan switched off
        if (!st().autoRescan) setTimeout(function () { act('runScan', { animate: false }); }, 0);
        if (o.focus && S.cards[o.focus]) {
            const c = S.cards[o.focus];
            c.look.hidden = false;
            c.lookText.innerHTML = '<b>Look for:</b> ' + o.look;
        }
    }
    function isoEdit(to) {
        return function (src) { return src.replace(/^(\s*isotope\s+)(F18|18F|F-18|C11|11C|C-11|O15|15O|O-15)\b/mi, '$1' + to); };
    }

    /* ---------- the effects ----------
       Each one: physics switch (get/set), correction switch, a status
       line comparing the two, the explanation, its controls, its
       demonstrations and, where it helps, a before/after pair. */
    const EFFECTS = [
        {
            key: 'attenuation', title: 'Attenuation',
            phys: { get: function (p) { return p.attenuation !== false; }, set: function (b) { act('setPhysics', { attenuation: b }); } },
            corr: { get: function (c) { return !!c.attenuation; }, set: function (b) { act('setRecon', { corrections: { attenuation: b } }); }, label: 'Attenuation correction (AC)' },
            status: function (p, c) {
                const P = p.attenuation !== false, C = !!c.attenuation;
                if (P && C) return ['corrected', 'good', 'Attenuation is simulated and corrected with the mu map.'];
                if (P) return ['not corrected', 'bad', 'The middle of the object reads too low and every value is far too low.'];
                if (C) return ['over-corrected', 'bad', 'Correcting attenuation that never happened makes the middle far too hot.'];
                return ['off', 'muted', 'No attenuation and no correction: a physics-free ideal.'];
            },
            see: 'Without correction the middle of an object is too cold and its edges too bright, and every value is several times too low. A correction applied when nothing was attenuated does the opposite: a hot middle.',
            why: 'Both 511 keV photons must leave the body. The chance that both escape along a line is e<sup>&minus;&int;&mu; dl</sup> over the whole line, wherever the annihilation was on it: about 15 % across 20 cm of water. Lines through the middle cross the most tissue.',
            how: 'Measure &mu; (from a CT, or estimated from an MR image) and multiply each line by its attenuation correction factor ACF = e<sup>+&int;&mu; dl</sup>. Because the factor does not depend on where along the line the decay happened, the correction is exact when the mu map is right.',
            controls: function (box) {
                const t = W().statTable([]);
                box.appendChild(t);
                return function () {
                    const acq = curAcq();
                    if (!acq || !acq.corrections || !acq.corrections.acf) { t.update([{ label: 'Attenuation factors', value: 'after the first scan' }]); return; }
                    const acf = acq.corrections.acf, mx = maxOf(acf);
                    t.update([
                        { label: '&mu; of water at 511 keV', value: '0.096', unit: '1/cm' },
                        { label: 'Largest ACF in this mu map', value: fmt(mx, 3), hint: 'The line that crosses the most material' },
                        { label: 'Pairs that escape along that line', value: pct(1 / mx, 1) }
                    ].map(function (r) { r.label = r.label.replace('&mu;', 'μ'); return r; }));
                };
            },
            shows: [
                { label: 'No correction (cylinder)', run: function () { demo({ preset: 'cyl_uniform', corrections: { attenuation: false }, focus: 'attenuation',
                    look: 'the profile sags in the middle (the centre reads well below the rim) and all values are about 6 times too low. Switch attenuation correction on and the cylinder is flat at its true 6.4 kBq/mL.' }); } },
                { label: 'Correction without attenuation', run: function () { demo({ preset: 'cyl_uniform', physics: { attenuation: false }, focus: 'attenuation',
                    look: 'the opposite artifact: the middle of the cylinder is several times too hot, because lines that were never attenuated are multiplied by their large correction factors.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { attenuation: false } }, on: { corrections: { attenuation: true } }, offLabel: 'Without AC', onLabel: 'With AC' }
        },
        {
            key: 'scatter', title: 'Scatter',
            phys: { get: function (p) { return p.scatter !== false; }, set: function (b) { act('setPhysics', { scatter: b }); } },
            corr: { get: function (c) { return !!c.scatter; }, set: function (b) { act('setRecon', { corrections: { scatter: b } }); }, label: 'Scatter correction' },
            status: function (p, c) {
                const P = p.scatter !== false, C = !!c.scatter;
                if (P && C) return ['corrected', 'good', 'The scatter estimate is in the model.'];
                if (P) return ['not corrected', 'warn', 'A smooth haze lowers contrast and fills in cold regions.'];
                if (C) return ['harmless', 'muted', 'The tail fit finds no scatter, so the estimate is scaled to nothing.'];
                return ['off', 'muted', 'No scatter simulated, none corrected.'];
            },
            see: 'A smooth haze over the whole object, also outside it (the sinogram "tails"). Cold regions are no longer cold, hot spots lose contrast, and values read high.',
            why: 'A photon that scatters in the body changes direction and loses a little energy. If it still passes the energy window it forms a coincidence on the wrong line. The scanner\'s energy resolution (11 %) cannot reject photons scattered through small angles, which lose only a few tens of keV.',
            how: 'Model the scatter from the activity and the mu map (single-scatter simulation), scale it so it matches the measured counts in the tails outside the object, and add it to the model (or subtract it). Raising the lower energy level also rejects scatter, but costs true counts.',
            controls: function (box) {
                const t = W().statTable([]);
                box.appendChild(t);
                box.appendChild(el('p', { class: 'note mt-1 mb-0' }, ['The energy window is part of the protocol: ', linkBtn('open the Protocol tab', function () { act('showTab', 'protocol'); }), ' and raise the lower level (for example to 480 keV) to see the scatter fraction fall.']));
                box.appendChild(el('p', { class: 'simplification' }, 'The scatter estimate is the one place the simulator peeks at the truth: it runs the scatter model on the true activity. Real scanners start from a first reconstruction and iterate.'));
                return function () {
                    const acq = curAcq(), F = curFrame(acq);
                    if (!acq || !F) { t.update([{ label: 'Scatter fraction', value: 'after the first scan' }]); return; }
                    const e = acq.program && acq.program.energy ? acq.program.energy : { lo: 435, hi: 650 };
                    t.update([
                        { label: 'Energy window', value: fmt(e.lo, 3) + ' to ' + fmt(e.hi, 3), unit: 'keV' },
                        { label: 'Scatter fraction S / (T + S)', value: pct(F.counts ? F.counts.sf : NaN, 1) },
                        { label: 'Tail-fit scale of the estimate', value: isFinite(F.scatterScale) ? fmt(F.scatterScale, 3) : '-', hint: 'About 1 when the model explains the tails; 0 when there is no scatter' }
                    ]);
                };
            },
            shows: [
                { label: 'Spheres without correction', run: function () { demo({ preset: 'spheres_iq', corrections: { scatter: false }, focus: 'scatter',
                    look: 'the cold spheres and the lung insert fill in (the lung reads about a third of the background instead of nearly zero), and the background reads high. Switch scatter correction on to clear them.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { scatter: false } }, on: { corrections: { scatter: true } }, offLabel: 'Without scatter correction', onLabel: 'With' }
        },
        {
            key: 'randoms', title: 'Randoms',
            phys: { get: function (p) { return p.randoms !== false; }, set: function (b) { act('setPhysics', { randoms: b }); } },
            corr: { get: function (c) { return !!c.randoms; }, set: function (b) { act('setRecon', { corrections: { randoms: b } }); }, label: 'Randoms correction' },
            status: function (p, c) {
                const P = p.randoms !== false, C = !!c.randoms;
                if (P && C) return ['corrected', 'good', 'Randoms are estimated (' + (c.randomsMethod === 'singles' ? 'from the singles rates' : 'from the delayed window') + ') and put in the model.'];
                if (P) return ['not corrected', 'warn', 'A flat background lifts everything, even the air around the object.'];
                if (C) return ['harmless', 'muted', 'The delayed window is empty, so there is nothing to subtract.'];
                return ['off', 'muted', 'No randoms simulated, none corrected.'];
            },
            see: 'A nearly flat background over the whole field of view, including the air outside the object. It lowers contrast and biases values up, worst in cold and low-uptake regions.',
            why: 'Two photons from different decays that happen to arrive within the coincidence window τ are paired. Their rate is R = 2τ S<sub>1</sub>S<sub>2</sub>: it grows with the square of the activity (trues only grow linearly) and in proportion to the window.',
            how: 'Measure them in a delayed window (pairs offset in time can only be randoms; as noisy as the randoms themselves) or compute them from the singles rates (smooth), and add them to the model. TOF also rejects randoms whose time difference places them outside the object.',
            controls: function (box) {
                const t = W().statTable([]);
                box.appendChild(el('div', { class: 'cc-formula', html: 'R = 2 &tau; S<sub>1</sub> S<sub>2</sub>' }));
                box.appendChild(t);
                const seg = W().segmented({ label: 'Randoms estimate', size: 'sm', options: [{ value: 'delayed', label: 'Delayed window', title: 'Noisy, measured' }, { value: 'singles', label: 'From singles', title: 'Smooth, computed' }],
                    value: 'delayed', onChange: function (v) { act('setRecon', { corrections: { randomsMethod: v } }); } });
                seg.classList.add('mt-1');
                box.appendChild(seg);
                return function () {
                    seg.set(corr().randomsMethod === 'singles' ? 'singles' : 'delayed');
                    const acq = curAcq(), F = curFrame(acq);
                    if (!acq || !F) { t.update([{ label: 'Randoms fraction', value: 'after the first scan' }]); return; }
                    const pr = acq.program || {};
                    t.update([
                        { label: 'Coincidence window τ', value: fmt((pr.coincidence || 4.5e-9) * 1e9, 3), unit: 'ns' },
                        { label: 'Injected activity', value: U.fmtActivity(acq.dose || 0) },
                        { label: 'Time of flight', value: acq.geom && acq.geom.tof ? 'on (rejects far-off randoms)' : 'off' },
                        { label: 'Randoms fraction R / prompts', value: pct(F.counts ? F.counts.rf : NaN, 1) },
                        { label: 'Randoms to trues', value: fmt(F.counts ? F.counts.rt : NaN, 3) }
                    ]);
                };
            },
            shows: [
                { label: 'High dose, wide window', run: function () { demo({ preset: 'fdg_static', params: { DOSE: 400e6 },
                    edit: function (s) { return s.replace(/^(\s*coincidence\s+)[0-9.]+\s*ns/m, '$112 ns').replace(/^(\s*tof\s+)on(\s+[0-9.]+\s*ps)?/m, '$1off'); },
                    corrections: { randoms: false }, focus: 'randoms',
                    look: 'with 400 MBq, a 12 ns window and no TOF, randoms outnumber trues. Uncorrected, a flat haze lifts the whole head and the air around it, and white matter reads far above its true value. Then load "Back to the clinical protocol" and compare the randoms fraction.' }); } },
                { label: 'Back to the clinical protocol', run: function () { demo({ preset: 'fdg_static', focus: 'randoms',
                    look: '185 MBq, 4.5 ns and TOF on: randoms are about a tenth of the prompts, and TOF keeps only those whose timing places them near the head.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { randoms: false } }, on: { corrections: { randoms: true } }, offLabel: 'Without randoms correction', onLabel: 'With' }
        },
        {
            key: 'noise', title: 'Low-count noise',
            phys: { get: function (p) { return p.noise !== false; }, set: function (b) { act('setPhysics', { noise: b }); } },
            corr: { kind: 'link', label: 'More counts', title: 'Noise is not corrected: it is reduced by collecting more counts (dose and scan time)' },
            status: function (p) {
                if (p.noise === false) return ['noise-free', 'muted', 'Expected counts without Poisson noise: the image infinite counts would give.'];
                return ['set by the counts', 'muted', 'Poisson noise: the fewer the counts, the noisier the image.'];
            },
            see: 'Grainy, blotchy images; small or low-contrast structures disappear in the texture. Iterating further or filtering less makes it worse.',
            why: 'Decays are random: a line that expects N counts records N &plusmn; &radic;N. Relative noise falls only as 1 / &radic;counts, so halving the noise needs four times the counts. Scatter and randoms add counts but no signal, which the noise-equivalent count rate NEC = T<sup>2</sup> / (T + S + R) captures.',
            how: 'Not by a correction: by more counts (a higher dose, a longer scan, a more sensitive scanner, TOF), or by trading resolution for noise (post-filter, fewer iterations, regularised reconstruction).',
            controls: function (box) {
                const w = W(), sl = el('div', { class: 'controls' });
                box.appendChild(sl);
                const t = w.statTable([]);
                t.classList.add('mt-1');
                box.appendChild(t);
                const mini = el('div', { class: 'cc-mini cc-noise-img' });
                const grid = el('div', { class: 'image-grid' });
                mini.appendChild(grid);
                const view = w.imageView(grid, { title: 'Current reconstruction (kBq/mL)', cmap: 'pet', empty: 'No image yet', readout: false });
                S.ui.noiseSide = mini;
                let sliders = {};
                return function () {
                    ['DOSE', 'DUR'].forEach(function (name) {
                        const p = hasParam(name);
                        if (!p) { if (sliders[name]) { sliders[name].remove(); delete sliders[name]; } return; }
                        if (!sliders[name] || sliders[name].key !== p.min + ':' + p.max + ':' + p.unit) {
                            if (sliders[name]) sliders[name].remove();
                            const s = w.slider({ label: name === 'DOSE' ? 'Injected activity (DOSE)' : 'Scan duration (DUR)', min: p.min, max: p.max, step: p.step || null,
                                value: p.value, unit: p.unit, siPerUnit: p.scale, log: p.min > 0 && p.max / p.min > 20,
                                onChange: function (v) { act('setParam', name, v); } });
                            s.key = p.min + ':' + p.max + ':' + p.unit;
                            sliders[name] = s;
                            sl.appendChild(s);
                        }
                        sliders[name].set(p.value);
                    });
                    if (!sl.children.length) sl.appendChild(el('p', { class: 'note mb-0', text: 'This protocol has no DOSE or DUR parameter; edit it in the Protocol tab.' }));
                    else Array.prototype.slice.call(sl.querySelectorAll('p.note')).forEach(function (n) { n.remove(); });
                    const acq = curAcq(), F = curFrame(acq), res = st().reconResult;
                    if (!acq || !F) { t.update([{ label: 'Counts', value: 'after the first scan' }]); view.clear('No image yet'); return; }
                    const c = F.counts || {};
                    const rows = [
                        { label: 'Prompts (this frame)', value: U.fmtCounts(c.prompts || 0) },
                        { label: 'Trues', value: U.fmtCounts(c.trues || 0) },
                        { label: 'Noise-equivalent counts (NEC)', value: U.fmtCounts(c.nec || 0), hint: 'T² / (T + S + R)' }
                    ];
                    const ph = phantomOf(acq), uni = { brain: 'white_matter', cylinder: 'centre', spheres: 'background' }[kindOf(ph)];
                    if (res && res.image && uni && PET.analysis) {
                        try {
                            const s = PET.analysis.roiStats(res.image, PET.analysis.roiMask(ph, res.n, uni, { erode: 1 }));
                            rows.push({ label: 'Noise (CoV) in ' + (uni === 'white_matter' ? 'white matter' : uni === 'centre' ? 'the centre' : 'the background'), value: pct(s.cov, 1) });
                        } catch (e) { /* no ROI */ }
                    }
                    t.update(rows);
                    if (res && res.image) { const im = res.image.map(function (v) { return v * 1e-3; }); view.setData(im, res.n, res.n, { min: 0, max: robustMax(im) || 1, cmap: 'pet' }); }
                    else view.clear('No image yet');
                };
            },
            shows: [
                { label: 'Low counts (40 MBq, 2 min)', run: function () { demo({ preset: 'fdg_static', params: { DOSE: 40e6, DUR: 120 }, focus: 'noise',
                    look: 'about 80 k trues instead of about 2 M: the brain dissolves into blotches and the noise in white matter is several times higher (the table on the left). Then try the high-count version.' }); } },
                { label: 'High counts (400 MBq, 20 min)', run: function () { demo({ preset: 'fdg_static', params: { DOSE: 400e6, DUR: 1200 }, focus: 'noise',
                    look: 'about 100 times the counts of the low-count scan: a smooth image. Noise fell about ten-fold, as 1 / √counts predicts (randoms grow faster than trues at this dose, so NEC grows a little less).' }); } }
            ],
            cmp: null
        },
        {
            key: 'range', title: 'Positron range',
            phys: { get: function (p) { return p.positronRange !== false; }, set: function (b) { act('setPhysics', { positronRange: b }); } },
            corr: { get: function () { return !!rec().rangeCorrection; }, set: function (b) { act('setRecon', { rangeCorrection: b }); }, label: 'Range in the model (MLEM/OSEM)' },
            status: function (p) {
                const P = p.positronRange !== false, C = !!rec().rangeCorrection, it = rec().method === 'mlem' || rec().method === 'osem';
                if (C && !it) return ['not used', 'muted', 'Range correction only works inside MLEM and OSEM.'];
                if (P && C) return ['modelled', 'good', 'The range kernel is in the system model: edges sharpen slowly over the iterations.'];
                if (P) return ['blurred', 'warn', 'Every annihilation is displaced from its decay by up to a few mm.'];
                if (C) return ['over-corrected', 'bad', 'Deblurring a blur that is not there sharpens edges until they ring.'];
                return ['off', 'muted', 'Annihilations happen exactly where the nuclei decay.'];
            },
            see: 'An extra blur that depends on the isotope: negligible for <sup>18</sup>F, clear for <sup>15</sup>O, whose positrons travel 3 mm on average. Small hot rods merge.',
            why: 'A positron leaves the nucleus with up to 0.6 MeV (<sup>18</sup>F) or 1.7 MeV (<sup>15</sup>O) and slows down in tissue before it annihilates. The scanner sees where it annihilated, not where the nucleus was.',
            how: 'Put the range kernel in the system model of MLEM/OSEM, so the reconstruction looks for the image that, blurred by range, explains the data. It recovers rods larger than the range slowly and amplifies noise; nothing can restore detail far below the range.',
            controls: function (box) {
                const tw = el('div', { class: 'cc-tablewrap' });
                box.appendChild(tw);
                const row = el('div', { class: 'cc-row' });
                const b15 = W().button({ label: 'Switch the protocol to 15O', size: 'sm', onClick: function () { switchIsotope('O15'); } });
                const b18 = W().button({ label: 'Back to 18F', size: 'sm', onClick: function () { switchIsotope('F18'); } });
                row.appendChild(b15); row.appendChild(b18);
                box.appendChild(row);
                const note = el('p', { class: 'note mb-0' });
                box.appendChild(note);
                return function () {
                    const acq = curAcq(), cur = acq ? acq.isotope : (st().program && st().program.isotope);
                    tw.textContent = '';
                    if (PET.isotopes) {
                        const rows = PET.isotopes.list().map(function (iso) {
                            const rs = PET.isotopes.rangeStats(iso);
                            const tr = el('tr', { class: iso.id === cur ? 'is-current' : null }, [td(iso.label + ' (' + iso.name + ')'), td(fmt(iso.rangeMean, 2) + ' mm'), td(fmt(rs.rms1D, 2) + ' mm'), td(U.fmtTime(iso.halfLife))]);
                            return Array.prototype.slice.call(tr.children);
                        });
                        tw.appendChild(dataTable(['Isotope', 'Mean range (3D)', 'RMS along a line', 'Half-life'], rows));
                    }
                    const prog = st().program && st().program.ok ? st().program : st().lastGoodProgram;
                    const solution = prog && !prog.tracer;
                    b15.disabled = !solution; b18.disabled = !solution;
                    note.textContent = solution ? 'These buttons edit the isotope line of the protocol (a phantom filled with a solution can hold any isotope). With 15O also use a short scan: its half-life is 2 minutes.' :
                        'A tracer fixes its isotope ([18F]FDG cannot be made with 15O), so the isotope buttons work with the phantom protocols. Try "Rods with 15O".';
                };
            },
            shows: [
                { label: 'Rods with 15O', run: function () { demo({ preset: 'rods_f18', edit: isoEdit('O15'), params: { DUR: 120, DOSE: 200e6 }, focus: 'range',
                    look: 'every rod sector loses contrast. In the Reconstruction tab\'s rod table the valley between the 5 mm rods rises from about 40 % of the peaks with 18F to about 60 % (only partly resolved), and the 4 mm rods merge. Range in the model raises the larger rods a little over the iterations, but cannot restore the small ones.' }); } },
                { label: 'Rods with 18F', run: function () { demo({ preset: 'rods_f18', focus: 'range',
                    look: 'with 18F (mean range 0.6 mm) the detectors, not the positron, set the resolution: the 5 mm rods are resolved and the 4 mm rods partly.' }); } }
            ],
            cmp: { mode: 'model', off: { rangeCorrection: false }, on: { rangeCorrection: true }, offLabel: 'Range not modelled', onLabel: 'Range in the model' }
        },
        {
            key: 'pv', title: 'Detector resolution (partial volume)',
            phys: { get: function (p) { return p.detectorBlur !== false; }, set: function (b) { act('setPhysics', { detectorBlur: b }); } },
            corr: { get: function () { return !!rec().psf; }, set: function (b) { act('setRecon', { psf: b }); }, label: 'Resolution modelling (PSF)' },
            status: function (p) {
                const P = p.detectorBlur !== false, C = !!rec().psf, it = rec().method === 'mlem' || rec().method === 'osem';
                if (C && !it) return ['not used', 'muted', 'PSF modelling only works inside MLEM and OSEM.'];
                if (P && C) return ['modelled', 'good', 'The detector blur is in the system model; partial volume remains for objects near the resolution.'];
                if (P) return ['blurred', 'warn', 'Small structures read low and spill into their neighbours.'];
                if (C) return ['over-corrected', 'bad', 'Modelling a blur that is not there makes edges overshoot.'];
                return ['off', 'muted', 'Ideal detectors: only the pixel grid limits resolution.'];
            },
            see: 'Small hot structures read low and look larger; cold ones read warm. The thin cortical ribbon reads well below its true value, and white matter next to it reads high (spill-in).',
            why: 'The scanner blurs every point by its resolution (about 3 mm at the centre, worse off centre). Counts from a small region spread out (spill-out) and counts from neighbours spread in (spill-in). Any structure smaller than about three times the FWHM is affected.',
            how: 'Model the blur in the reconstruction (PSF), which sharpens but converges slowly and rings at edges; or correct the regional values afterwards with the geometric transfer matrix (GTM), which needs the anatomy (here the phantom labels; in patients an MR) and the right FWHM.',
            controls: function (box) { return pvControls(box); },
            shows: [
                { label: 'Small spheres', run: function () { demo({ preset: 'spheres_iq', focus: 'pv',
                    look: 'the 10 mm sphere reads well under its true 4 : 1 contrast, the 22 mm one much closer. The GTM table below brings them back; PSF in the reconstruction helps less than you might hope at 4 iterations.' }); } },
                { label: 'Cortical ribbon', run: function () { demo({ preset: 'fdg_static', focus: 'pv',
                    look: 'in the GTM table the thin cortex reads about two thirds of its true concentration and white matter about 120 % (spill-in from the cortex). GTM brings both to within a few per cent; this is why amyloid and FDG studies of atrophied brains are sometimes partial-volume corrected.' }); } }
            ],
            cmp: { mode: 'model', off: { psf: false }, on: { psf: true }, offLabel: 'No PSF', onLabel: 'PSF in the model' }
        },
        {
            key: 'motion', title: 'Motion',
            phys: { get: function (p) { return !!(p.motion && p.motion.on); }, set: function (b) { act('setPhysics', { motion: { on: b } }); } },
            corr: { get: function (c) { return !!c.motion; }, set: function (b) { act('setRecon', { corrections: { motion: b } }); }, label: 'Motion correction' },
            status: function (p, c) {
                const P = !!(p.motion && p.motion.on), C = !!c.motion;
                if (P && C) return ['corrected', 'good', 'Every event is moved back to the starting position (perfect tracking).'];
                if (P) return ['not corrected', 'bad', 'Edges blur or double, and attenuation correction no longer lines up.'];
                if (C) return ['nothing to correct', 'muted', 'The object did not move.'];
                return ['off', 'muted', 'The object stays still.'];
            },
            see: 'Blurred or doubled edges, small structures that read low, and attenuation-correction errors where the object moved away from where the mu map says it is.',
            why: 'A scan takes minutes and patients move: a step when they shift, a slow drift as they relax, periodic motion from breathing. Each event is recorded on the line where the object was at that moment.',
            how: 'Track the motion (a camera, markers, or from the data themselves) and move each event back to its line in a reference position before reconstruction, or reconstruct short frames and register them. The CT for attenuation correction must match too.',
            controls: function (box) {
                const w = W(), ctl = el('div', { class: 'controls' });
                box.appendChild(ctl);
                const set = function (patch) { act('setPhysics', { motion: patch }); };
                const kind = w.segmented({ label: 'Kind of motion', size: 'sm', options: [{ value: 'step', label: 'Step' }, { value: 'drift', label: 'Drift' }, { value: 'periodic', label: 'Periodic' }],
                    value: 'step', onChange: function (v) { set({ kind: v }); } });
                const dx = w.slider({ label: 'Shift x', min: -20, max: 20, step: 0.5, value: 6, unit: 'mm', onChange: function (v) { set({ dx: v }); } });
                const dy = w.slider({ label: 'Shift y', min: -20, max: 20, step: 0.5, value: 0, unit: 'mm', onChange: function (v) { set({ dy: v }); } });
                const rot = w.slider({ label: 'Rotation', min: -15, max: 15, step: 0.5, value: 0, unit: 'deg', onChange: function (v) { set({ rot: v }); } });
                const at = w.slider({ label: 'Step happens at', min: 0, max: 1, step: 0.05, value: 0.5, format: function (v) { return Math.round(100 * v) + ' % of the scan'; }, onChange: function (v) { set({ at: v }); } });
                const per = w.slider({ label: 'Period', min: 1, max: 30, step: 0.5, value: 5, unit: 's', onChange: function (v) { set({ period: v }); } });
                [kind, dx, dy, rot, at, per].forEach(function (c) { ctl.appendChild(c); });
                const note = el('p', { class: 'note mt-1 mb-0' });
                box.appendChild(note);
                return function () {
                    const m = phys().motion || {};
                    kind.set(m.kind || 'step'); dx.set(m.dx || 0); dy.set(m.dy || 0); rot.set(m.rot || 0); at.set(m.at === undefined ? 0.5 : m.at); per.set(m.period || 5);
                    at.hidden = (m.kind || 'step') !== 'step';
                    per.hidden = m.kind !== 'periodic';
                    note.textContent = m.on ? 'Motion is on: ' + ({ step: 'the object jumps to the full shift part way through the scan.', drift: 'the object drifts steadily to the full shift by the end of the scan.', periodic: 'the object swings back and forth by the shift, like breathing.' }[m.kind || 'step']) :
                        'Motion is off in the physics; these settings apply when you switch it on.';
                };
            },
            shows: [
                { label: 'A 6 mm step', run: function () { demo({ preset: 'fdg_static', physics: { motion: { on: true, kind: 'step', dx: 6, dy: 0, rot: 0, at: 0.5 } }, focus: 'motion',
                    look: 'half the counts come from a head 6 mm to the side: edges blur and double, and the cortex and striatum read lower than with motion correction. Switch motion correction on: the events are moved back and the image sharpens again.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { motion: false } }, on: { corrections: { motion: true } }, offLabel: 'Without motion correction', onLabel: 'With',
                available: function (acq) { const F = curFrame(acq); return F && F.promptsMC ? null : 'There was no motion in this scan. Switch motion on in the physics (or press "A 6 mm step") to compare.'; } }
        },
        {
            key: 'mumap', title: 'Mu map misalignment',
            phys: {
                get: function (p) { const m = p.muMap || {}; return !!(m.dx || m.dy || m.rot || m.model === 'nobone'); },
                set: function (b) {
                    const m = phys().muMap || {};
                    if (!b && (m.dx || m.dy || m.rot || m.model === 'nobone')) S.lastMu = clone(m);
                    act('setPhysics', { muMap: b ? clone(S.lastMu) : { dx: 0, dy: 0, rot: 0, model: 'ct' } });
                }
            },
            corr: { kind: 'button', label: 'Realign', title: 'Register the mu map to the emission data again (shift and rotation 0)',
                run: function () { const m = phys().muMap || {}; act('setPhysics', { muMap: { dx: 0, dy: 0, rot: 0, model: m.model || 'ct' } }); } },
            status: function (p, c) {
                const m = p.muMap || {}, bad = !!(m.dx || m.dy || m.rot || m.model === 'nobone');
                if (!bad) return ['aligned', 'good', 'The mu map matches the object.'];
                if (!c.attenuation) return ['not used', 'muted', 'Attenuation correction is off, so the mu map is not used.'];
                if (m.model === 'nobone' && !(m.dx || m.dy || m.rot)) return ['no bone', 'warn', 'The skull is treated as soft tissue: the cortex under it reads low.'];
                return ['misaligned', 'bad', 'Hot where the mu map has too much tissue, cold where it has too little; scatter correction suffers too.'];
            },
            see: 'An asymmetric error: the side the mu map moved toward reads too high (it is over-corrected), the side it moved away from too low. An MR-based mu map without bone makes the cortex under the skull read low.',
            why: 'Attenuation correction multiplies each line by a factor computed from the mu map. If the mu map is shifted, or misses the skull (MR does not see bone well), lines get the wrong factors. The scatter estimate uses the mu map too.',
            how: 'Register the CT (or MR) to the PET data before reconstruction, and use an MR-based method that models bone (atlas, ultrashort echo time, or deep learning).',
            controls: function (box) {
                const w = W(), ctl = el('div', { class: 'controls' });
                box.appendChild(ctl);
                const remember = function (patch) {
                    const m = merged(phys().muMap || {}, patch);
                    if (m.dx || m.dy || m.rot || m.model === 'nobone') S.lastMu = clone(m);
                    act('setPhysics', { muMap: patch });
                };
                const dx = w.slider({ label: 'Shift x', min: -20, max: 20, step: 0.5, value: 0, unit: 'mm', onChange: function (v) { remember({ dx: v }); } });
                const dy = w.slider({ label: 'Shift y', min: -20, max: 20, step: 0.5, value: 0, unit: 'mm', onChange: function (v) { remember({ dy: v }); } });
                const rot = w.slider({ label: 'Rotation', min: -15, max: 15, step: 0.5, value: 0, unit: 'deg', onChange: function (v) { remember({ rot: v }); } });
                const model = w.select({ label: 'Mu map from', options: [{ value: 'ct', label: 'CT (with bone)' }, { value: 'nobone', label: 'MR, no bone' }], value: 'ct',
                    onChange: function (v) { remember({ model: v }); } });
                [dx, dy, rot, model].forEach(function (c) { ctl.appendChild(c); });
                const mini = el('div', { class: 'cc-mini mt-1' }), grid = el('div', { class: 'image-grid' });
                mini.appendChild(grid);
                box.appendChild(mini);
                const vT = w.imageView(grid, { title: 'True mu map', cmap: 'gray', empty: 'After the first scan', readout: false });
                const vC = w.imageView(grid, { title: 'Mu map used for AC', cmap: 'gray', empty: 'After the first scan', readout: false });
                return function () {
                    const m = phys().muMap || {};
                    dx.set(m.dx || 0); dy.set(m.dy || 0); rot.set(m.rot || 0); model.set(m.model || 'ct');
                    const acq = curAcq();
                    if (acq && acq.muTrue && acq.corrections && acq.corrections.muCorr) {
                        const n = Math.round(Math.sqrt(acq.muTrue.length));
                        vT.setData(acq.muTrue, n, n, { min: 0, max: 0.016, cmap: 'gray' });
                        vC.setData(acq.corrections.muCorr, n, n, { min: 0, max: 0.016, cmap: 'gray' });
                    } else { vT.clear('After the first scan'); vC.clear('After the first scan'); }
                };
            },
            shows: [
                { label: 'Shifted 8 mm', run: function () { S.lastMu = { dx: 8, dy: 0, rot: 0, model: 'ct' }; demo({ preset: 'fdg_static', physics: { muMap: { dx: 8, dy: 0, rot: 0, model: 'ct' } }, focus: 'mumap',
                    look: 'the mu map sits 8 mm to the image right (the patient\'s left). That half of the brain is over-corrected and reads high, the other half under-corrected and low: compare the two halves in the table with a matching mu map.' }); } },
                { label: 'MR-based, no bone', run: function () { S.lastMu = { dx: 0, dy: 0, rot: 0, model: 'nobone' }; demo({ preset: 'fdg_static', physics: { muMap: { dx: 0, dy: 0, rot: 0, model: 'nobone' } }, focus: 'mumap',
                    look: 'with the skull treated as soft tissue, every line through bone is under-corrected: the cortex reads about 9 % lower than with the CT mu map, deeper regions a little less.' }); } }
            ],
            cmp: { mode: 'quick', off: {}, on: {}, offLabel: 'This mu map', onLabel: 'A matching mu map', truthAcf: true, halves: true,
                available: function () {
                    const m = phys().muMap || {}, acq = curAcq(), pm = acq && acq.physics ? acq.physics.muMap || {} : m;
                    if (!(pm.dx || pm.dy || pm.rot || pm.model === 'nobone')) return 'The mu map of this scan matches the object. Shift it, or choose the MR-based model, to compare.';
                    if (!corr().attenuation) return 'Attenuation correction is off, so the mu map is not used.';
                    return null;
                } }
        },
        {
            key: 'norm', title: 'Detector efficiencies (normalisation)',
            phys: {
                get: function (p) { const d = p.detector || {}; return (d.variation || 0) > 0 || d.deadBlock >= 0; },
                set: function (b) {
                    const d = phys().detector || {};
                    if (!b && (d.variation > 0 || d.deadBlock >= 0)) S.lastDet = clone(d);
                    act('setPhysics', { detector: b ? clone(S.lastDet.variation > 0 || S.lastDet.deadBlock >= 0 ? S.lastDet : { variation: 0.06, deadBlock: -1 }) : { variation: 0, deadBlock: -1 } });
                }
            },
            corr: { get: function (c) { return !!c.normalization; }, set: function (b) { act('setRecon', { corrections: { normalization: b } }); }, label: 'Normalisation' },
            status: function (p, c) {
                const d = p.detector || {}, P = (d.variation || 0) > 0 || d.deadBlock >= 0, C = !!c.normalization;
                if (P && C) return [d.deadBlock >= 0 ? 'corrected, block dead' : 'corrected', d.deadBlock >= 0 ? 'warn' : 'good', d.deadBlock >= 0 ? 'Efficiencies are corrected; the dead block\'s lines hold no data (streaks in FBP, MLEM copes).' : 'Each line is divided by its measured efficiency.'];
                if (P) return ['not corrected', 'bad', 'Streaks and fine patterns from uneven crystals.'];
                if (C) return ['harmless', 'muted', 'All crystals are equal, so normalisation divides by 1.'];
                return ['off', 'muted', 'Ideal, identical crystals.'];
            },
            see: 'Fine streaks and ring-like patterns where some crystals are more efficient than others; a dead detector block leaves a gap in the sinogram that FBP turns into streaks across the image.',
            why: 'Every crystal and photosensor differs a little in efficiency, and a line\'s efficiency is the product of its two crystals\'. A failed block records nothing at all.',
            how: 'Measure every line\'s efficiency with a rotating or uniform source (normalisation) and divide by it, or put it in the model. Lines with no data are simply left out of MLEM and OSEM, which fill in from the other angles; FBP cannot.',
            controls: function (box) {
                const w = W(), ctl = el('div', { class: 'controls' });
                box.appendChild(ctl);
                const remember = function (patch) {
                    const d = merged(phys().detector || {}, patch);
                    if (d.variation > 0 || d.deadBlock >= 0) S.lastDet = clone(d);
                    act('setPhysics', { detector: patch });
                };
                const v = w.slider({ label: 'Crystal efficiency variation (SD)', min: 0, max: 0.2, step: 0.01, value: 0.06, format: function (x) { return Math.round(100 * x) + ' %'; },
                    onChange: function (x) { remember({ variation: x }); } });
                const opts = [{ value: -1, label: 'None' }];
                for (let b = 0; b < 48; b++) opts.push({ value: b, label: 'Block ' + b + ' (at ' + Math.round((b + 0.5) * 7.5) + ' deg)' });
                const dead = w.select({ label: 'Dead block', options: opts, value: -1, onChange: function (x) { remember({ deadBlock: x }); } });
                ctl.appendChild(v); ctl.appendChild(dead);
                return function () {
                    const d = phys().detector || {};
                    v.set(d.variation || 0); dead.set(d.deadBlock === undefined ? -1 : d.deadBlock);
                };
            },
            shows: [
                { label: 'Dead block with FBP', run: function () { demo({ preset: 'cyl_uniform', physics: { noise: false, detector: { variation: 0.06, deadBlock: 5 } }, recon: { method: 'fbp' }, focus: 'norm',
                    look: 'noise is switched off for this demonstration so the pattern is not hidden in it. FBP draws streaks across the cylinder along the missing lines and reads a few per cent low; OSEM, beside it, is smooth and right, because MLEM and OSEM leave the missing lines out of the model. The non-uniformity row of the table says the same in numbers.' }); } },
                { label: 'Uneven crystals, no correction', run: function () { demo({ preset: 'cyl_uniform', physics: { noise: false, detector: { variation: 0.15, deadBlock: -1 } }, recon: { method: 'fbp' }, corrections: { normalization: false }, focus: 'norm',
                    look: 'with 15 % crystal-to-crystal variation and no normalisation, a fine pattern of rings and streaks covers the uniform cylinder (noise is off to show it clearly). Switch normalisation on and it is gone.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { normalization: false } }, on: { corrections: { normalization: true } }, offLabel: 'Without normalisation', onLabel: 'With',
                adapt: function (acq) {
                    const d = acq && acq.physics && acq.physics.detector;
                    if (!d || !(d.deadBlock >= 0)) return null;
                    // with a dead block the lesson is FBP against MLEM/OSEM, both normalised
                    return { off: { method: 'fbp', corrections: { normalization: true } }, on: { method: 'osem', iterations: 2, subsets: 12, corrections: { normalization: true } },
                        offLabel: 'FBP (dead block)', onLabel: 'OSEM (dead block)', desc: 'FBP and OSEM 2 x 12, both normalised' };
                } }
        },
        {
            key: 'decay', title: 'Radioactive decay',
            phys: null,
            corr: { get: function (c) { return !!c.decay; }, set: function (b) { act('setRecon', { corrections: { decay: b } }); }, label: 'Decay correction' },
            status: function (p, c) {
                if (c.decay) return ['corrected', 'good', 'Values are decay corrected to the injection time.'];
                return ['not corrected', 'warn', 'Values are the average activity during the frame: too low, and later frames lower still.'];
            },
            see: 'Without correction every value, and every SUV, is too low by the fraction of the tracer that has decayed since injection; in a dynamic scan, later frames read lower and lower.',
            why: 'Decay never stops: <sup>18</sup>F halves every 110 min, <sup>11</sup>C every 20 min, <sup>15</sup>O every 2 min. The counts in a frame reflect the activity left during that frame, not what was injected.',
            how: 'Multiply each frame by the ratio of its duration to &int;e<sup>&minus;&lambda;t</sup>dt over the frame, which refers the activity back to the injection (time zero). SUV divides by the injected dose, so it needs this correction.',
            controls: function (box) {
                const t = W().statTable([]);
                box.appendChild(t);
                return function () {
                    const acq = curAcq(), F = curFrame(acq);
                    if (!acq || !F || !PET.isotopes) { t.update([{ label: 'Decay during the frame', value: 'after the first scan' }]); return; }
                    let iso = null;
                    try { iso = PET.isotopes.get(acq.isotope); } catch (e) { /* none */ }
                    const f = F.kappaNoDecay > 0 ? F.kappa / F.kappaNoDecay : NaN;
                    t.update([
                        { label: 'Isotope', value: iso ? iso.label + ', half-life ' + U.fmtTime(iso.halfLife) : acq.isotope },
                        { label: 'Frame' + (acq.frames.length > 1 ? ' ' + (frameIndex(acq) + 1) : ''), value: fmtT(F.t0) + ' to ' + fmtT(F.t1) + ' after injection' },
                        { label: 'Activity left during the frame (average)', value: pct(f, 1), hint: '∫e^(-λt)dt over the frame divided by its duration' },
                        { label: 'Uncorrected values and SUV read', value: pct(f, 0) + ' of the truth', kind: f < 0.9 ? 'warn' : null }
                    ]);
                };
            },
            shows: [
                { label: 'PiB (11C) without correction', run: function () { demo({ preset: 'pib_static', corrections: { decay: false }, focus: 'decay',
                    look: 'by 50 to 70 min after injection only about 13 % of the carbon-11 is left, so the uncorrected image and its SUV read about 13 % of the truth. SUVR (a ratio of two regions) is not affected, which is one reason amyloid scans are read as SUVR.' }); } }
            ],
            cmp: { mode: 'quick', off: { corrections: { decay: false } }, on: { corrections: { decay: true } }, offLabel: 'Without decay correction', onLabel: 'With' }
        }
    ];
    const BY_KEY = {};
    EFFECTS.forEach(function (e) { BY_KEY[e.key] = e; });

    function switchIsotope(to) {
        const src = st().source || '';
        let ns = isoEdit(to)(src);
        if (ns === src && !/^\s*isotope\s/mi.test(src)) { PET.app && PET.app.notify && PET.app.notify('This protocol has no isotope line to change.', 'warn'); return; }
        if (ns !== src) act('setSource', ns);
        if (to === 'O15') { if (hasParam('DUR')) act('setParam', 'DUR', 120); }
    }

    /* ---------- partial volume: GTM ---------- */
    /* A FWHM for GTM that matches the reconstruction: measured on line
       sources and calibrated so default OSEM (3 mm post-filter) gives
       about 4.5 mm, OSEM without post-filter 4 mm, FBP with Hann about
       6 mm, plus the pixel size and the positron range. */
    function gtmDefault() {
        const r = rec(), p = phys(), pix = FOV / (r.matrix || 128), pf = r.postFilter || 0;
        let f2;
        if (r.method === 'fbp') {
            const k = { ramp: 0.5, shepp: 0.58, cosine: 0.93, hamming: 1.1, hann: 1.19, butterworth: 0.55 }[r.filter] || 1;
            f2 = 3.3 * 3.3 + Math.pow(k * 4 / (r.cutoff || 1), 2) + pf * pf;
        } else if (r.method === 'bp') f2 = 64 + pf * pf;
        else { const b = r.psf ? 3.2 : 4.0; f2 = b * b + Math.pow(0.7 * pf, 2); }
        if (p.detectorBlur === false) f2 = Math.max(f2 - 2.8 * 2.8, 4);
        if (pix > 2.5) f2 += 0.8 * (pix * pix - 6.25);
        const acq = curAcq();
        if (acq && p.positronRange !== false && !(r.rangeCorrection && (r.method === 'osem' || r.method === 'mlem')) && PET.isotopes) {
            try { const rs = PET.isotopes.rangeStats(PET.isotopes.get(acq.isotope)); f2 += Math.pow(0.8 * rs.rms1D, 2); } catch (e) { /* none */ }
        }
        return Math.round(2 * Math.sqrt(f2)) / 2;
    }
    function pvControls(box) {
        const w = W();
        box.appendChild(el('div', { class: 'cc-formula', html: 't = G<sup>&minus;1</sup> &middot; observed, &nbsp; G<sub>ij</sub> = spill of region j into ROI i' }));
        const row = el('div', { class: 'cc-row' });
        const sl = w.slider({ label: 'GTM resolution (FWHM)', min: 0, max: 12, step: 0.5, value: 4.5, unit: 'mm',
            onInput: U.debounce(function (v) { S.gtm.fwhm = v; S.gtm.user = true; renderGtm(); }, 150),
            onChange: function (v) { S.gtm.fwhm = v; S.gtm.user = true; renderGtm(); } });
        sl.style.flex = '1 1 220px';
        const match = w.button({ label: 'Match the reconstruction', size: 'sm', onClick: function () { S.gtm.user = false; S.gtm.fwhm = gtmDefault(); sl.set(S.gtm.fwhm); renderGtm(); } });
        row.appendChild(sl); row.appendChild(match);
        box.appendChild(row);
        S.ui.gtmSlider = sl;
        S.ui.gtmHint = el('p', { class: 'note mb-0' });
        box.appendChild(S.ui.gtmHint);
        S.ui.gtmTable = el('div', { class: 'cc-tablewrap' });
        box.appendChild(S.ui.gtmTable);
        S.ui.gtmPlotBox = el('div', { class: 'mt-1' });
        box.appendChild(S.ui.gtmPlotBox);
        S.ui.gtmPlot = w.plot(S.ui.gtmPlotBox, { height: 170, xlabel: 'sphere diameter (mm)', ylabel: 'recovery (%)', title: 'Recovery coefficients (hot spheres)', legend: true });
        return function () { renderGtm(); };
    }
    const renderGtm = safe(function () {
        const box = S.ui.gtmTable;
        if (!box) return;
        const acq = curAcq(), res = st().reconResult, def = gtmDefault();
        if (!S.gtm.user || S.gtm.fwhm === null) { S.gtm.fwhm = def; S.ui.gtmSlider.set(def); }
        S.ui.gtmHint.textContent = 'GTM is only right if this FWHM matches the image resolution: about ' + fmt(def, 2) + ' mm for the current reconstruction' +
            (S.gtm.user && Math.abs(S.gtm.fwhm - def) > 0.25 ? ' (you chose ' + fmt(S.gtm.fwhm, 2) + ' mm: too small under-corrects, too large over-corrects).' : '.');
        if (!acq || !res || !res.image || res.frame === 'all' || !PET.analysis || typeof PET.analysis.gtm !== 'function') {
            box.textContent = '';
            box.appendChild(W().empty(acq ? 'Waiting for the reconstruction.' : 'GTM correction appears after the first scan.'));
            S.ui.gtmPlotBox.hidden = true;
            return;
        }
        const ph = phantomOf(acq), F = acq.frames[res.frame] || acq.frames[0];
        if (!ph || !F || !F.truth) return;
        const key = acqId(acq) + '|' + res.n + '|' + S.gtm.fwhm;
        let g;
        if (S.gtm.cacheKey === key && S.gtm.res === res) g = S.gtm.result;
        else {
            try { g = PET.analysis.gtm(res.image, res.n, FOV, ph, S.gtm.fwhm, { truth: F.truth.regionMean }); }
            catch (e) { warn('GTM failed', e); box.textContent = ''; box.appendChild(W().empty('GTM could not be computed: ' + e.message)); return; }
            S.gtm.cacheKey = key; S.gtm.res = res; S.gtm.result = g;
        }
        const kind = kindOf(ph);
        let list = g.rois.filter(function (e) { return e.roi || e.composite; });
        if (kind === 'brain') {
            const want = ['cortex', 'striatum', 'putamen_l', 'putamen_r', 'caudate', 'wm', 'cereb_gm', 'thalamus', 'gm_frontal', 'gm_temporal', 'gm_occipital'];
            list = want.map(function (id) { return list.find(function (e) { return e.id === id; }); }).filter(Boolean);
        }
        const cls = function (v, t) { if (!(t > 0) || !isFinite(v)) return null; const r = v / t; return Math.abs(r - 1) <= 0.1 ? 'good' : (Math.abs(r - 1) <= 0.25 ? 'warn' : 'bad'); };
        const rows = list.map(function (e) {
            return [td(e.name), td(fmt(e.observed / 1000, 3), cls(e.observed, e.truth)), td(fmt(e.corrected / 1000, 3), cls(e.corrected, e.truth)), td(isFinite(e.truth) ? fmt(e.truth / 1000, 3) : '-'),
                td(e.truth > 0 ? pct(e.observed / e.truth) : '-'), td(e.truth > 0 ? pct(e.corrected / e.truth) : '-')];
        });
        box.textContent = '';
        box.appendChild(dataTable(['Region', 'Observed', 'GTM', 'True', 'Obs / true', 'GTM / true'], rows));
        box.appendChild(el('p', { class: 'note mt-1 mb-0' }, 'kBq/mL, from the image shown in the Reconstruction tab' + (acq.frames.length > 1 ? ' (frame ' + (res.frame + 1) + ')' : '') + '. "True" is the region\'s real concentration; the Reconstruction tab compares with the truth averaged over each pixel, which already contains the pixel grid\'s own partial volume, so its recoveries look better. Regions with no activity are solved for too: their GTM values show how far the correction can go wrong with noise or a wrong FWHM.'));
        // recovery coefficients of the hot spheres
        if (kind === 'spheres') {
            const sph = g.rois.filter(function (e) { return /^sphere/.test(e.id) && e.truth > 0; }).map(function (e) {
                const r = ph.regions.find(function (x) { return x.id === e.id; });
                return { d: r && r.diameter ? r.diameter : parseFloat(e.id.replace(/\D/g, '')), o: e.observed / e.truth, c: e.corrected / e.truth };
            }).sort(function (a, b) { return a.d - b.d; });
            S.ui.gtmPlotBox.hidden = !sph.length;
            if (sph.length) S.ui.gtmPlot.draw([
                { x: sph.map(function (s) { return s.d; }), y: sph.map(function (s) { return 100 * s.o; }), label: 'Observed', color: 'var(--c2)', points: 4 },
                { x: sph.map(function (s) { return s.d; }), y: sph.map(function (s) { return 100 * s.c; }), label: 'GTM corrected', color: 'var(--c1)', points: 4 }
            ], { xlim: [8, 25], hlines: [{ y: 100, label: 'true', color: 'var(--muted)' }], includeZero: true });
        } else S.ui.gtmPlotBox.hidden = true;
    }, 'GTM');

    /* ---------- before/after pairs ---------- */
    const LINES = { cylinder: ['h', 0], spheres: ['h', 0], brain: ['h', -6], rods: ['v', 50], point: ['h', 0] };
    const METRIC_ROIS = {
        spheres: ['sphere10', 'sphere22', 'sphere37', 'background', 'lung'],
        brain: ['cortex', 'white_matter', 'striatum', 'cerebellum'],
        rods: ['rods4', 'rods6', 'rods10', 'background'],
        point: ['src_0', 'src_100']
    };
    function cmpOptions(eff, acq) {
        const r = clone(rec());
        delete r.keepIterations;
        r.frame = frameIndex(acq);
        r.keepIterations = false;
        if (r.matrix > 128) r.matrix = 128;
        const it = r.method === 'mlem' || r.method === 'osem';
        let desc;
        if (eff.cmp.mode === 'model') {
            if (!it || r.method === 'mlem') { r.method = 'osem'; r.subsets = 12; }
            r.iterations = U.clamp(r.iterations || 4, 4, 8);
            desc = 'OSEM, ' + r.iterations + ' iterations x ' + r.subsets + ' subsets';
        } else if (it) {
            if (r.method === 'mlem') { r.method = 'osem'; r.subsets = 12; }
            r.iterations = Math.min(r.iterations || 2, 2);
            desc = 'OSEM, ' + r.iterations + ' iteration' + (r.iterations === 1 ? '' : 's') + ' x ' + r.subsets + ' subsets';
        } else desc = r.method === 'fbp' ? 'FBP (' + r.filter + ')' : 'backprojection';
        if (r.tof && acq.geom && acq.geom.tof && r.method !== 'fbp') desc += ', TOF';
        desc += ', ' + r.matrix + ' x ' + r.matrix;
        const ad = eff.cmp.adapt ? eff.cmp.adapt(acq) : null;
        if (ad) return { off: merged(r, ad.off), on: merged(r, ad.on), desc: ad.desc + ', ' + r.matrix + ' x ' + r.matrix, offLabel: ad.offLabel, onLabel: ad.onLabel };
        return { off: merged(r, eff.cmp.off), on: merged(r, eff.cmp.on), desc: desc, offLabel: eff.cmp.offLabel, onLabel: eff.cmp.onLabel };
    }
    function trueAcfAcq(acq) {
        let a = S.acfTrue.get(acq);
        if (a) return a;
        const n = Math.round(Math.sqrt(acq.muTrue.length));
        const att = PET.scanner.attenuationFactors(acq.muTrue, n, FOV), acf = new Float32Array(att.length);
        for (let k = 0; k < att.length; k++) acf[k] = att[k] > 0 ? 1 / att[k] : 1;
        a = Object.assign({}, acq, { corrections: Object.assign({}, acq.corrections, { acf: acf }) });
        S.acfTrue.set(acq, a);
        return a;
    }
    function buildCompare(eff, host) {
        const w = W(), box = el('div', { class: 'cc-cmp' });
        box.appendChild(el('div', { class: 'cc-cmp-title', text: 'Before and after, on the data you have' }));
        const grid = el('div', { class: 'image-grid' });
        box.appendChild(grid);
        const fmtRead = function (ix, iy, v) { return isFinite(v) ? fmt(v, 3) + ' kBq/mL' : 'no data'; };
        const vOff = w.imageView(grid, { title: eff.cmp.offLabel, cmap: 'pet', empty: 'Not computed yet', readoutFormat: fmtRead });
        const vOn = w.imageView(grid, { title: eff.cmp.onLabel, cmap: 'pet', empty: 'Not computed yet', readoutFormat: fmtRead });
        const status = el('div', { class: 'cc-cmp-status', 'aria-live': 'polite' });
        box.appendChild(status);
        const winSeg = w.segmented({ options: [{ value: 'shared', label: 'Same window', title: 'Both images on one scale: shows which reads too high or too low' },
            { value: 'own', label: 'Each its own', title: 'Each image scaled to itself: shows the shape of the artifact' }], value: 'shared', size: 'sm', ariaLabel: 'Display window of the pair',
            onChange: function (v) { C.win = v; renderCmp(C); } });
        winSeg.classList.add('mb-1');
        box.appendChild(winSeg);
        const plot = w.plot(box, { height: 160, xlabel: 'position (mm)', legend: true });
        plot.el.hidden = true;
        status.textContent = 'Computed when this card is on screen.';
        const table = el('div', { class: 'cc-tablewrap' });
        box.appendChild(table);
        host.appendChild(box);
        const C = { eff: eff, box: box, vOff: vOff, vOn: vOn, status: status, plot: plot, table: table, sig: null, results: null, inView: !root.IntersectionObserver, win: 'shared' };
        S.cmp[eff.key] = C;
        if (root.IntersectionObserver) {
            const io = new root.IntersectionObserver(function (entries) {
                entries.forEach(function (en) { C.inView = en.isIntersecting; });
                if (C.inView) scheduleCmp();
            }, { rootMargin: '200px 0px' });
            io.observe(box);
        }
        return C;
    }
    function planCompare(eff, acq) {
        const C = S.cmp[eff.key];
        const reason = eff.cmp.available ? eff.cmp.available(acq) : null;
        if (reason) return { ok: false, reason: reason, sig: 'na|' + acqId(acq) + '|' + reason };
        const o = cmpOptions(eff, acq);
        let acqOff = acq, acqOn = acq;
        if (eff.cmp.truthAcf) acqOn = trueAcfAcq(acq);
        const sig = acqId(acq) + '|' + JSON.stringify(o.off) + '|' + JSON.stringify(o.on) + '|' + (C ? '' : '');
        return { ok: true, off: o.off, on: o.on, desc: o.desc, acqOff: acqOff, acqOn: acqOn, sig: sig, offLabel: o.offLabel, onLabel: o.onLabel };
    }
    let cmpBusy = false, cmpToken = 0;
    const scheduleCmp = U.debounce(function () { runNextCmp(); }, 250);
    async function runNextCmp() {
        if (cmpBusy || !S.visible || !PET.recon || typeof PET.recon.run !== 'function') return;
        const acq = curAcq();
        if (!acq || !acq.frames || !acq.frames.length) return;
        if (st().scanning || st().reconstructing) return;          // wait for the shell's own work; recon:done reschedules
        for (let i = 0; i < EFFECTS.length; i++) {
            const eff = EFFECTS[i], C = S.cmp[eff.key];
            if (!C || !C.inView) continue;
            let plan;
            try { plan = planCompare(eff, acq); } catch (e) { warn('planning the comparison failed', e); continue; }
            if (C.sig === plan.sig) continue;
            if (!plan.ok) { C.sig = plan.sig; C.results = null; showCmpUnavailable(C, plan.reason); continue; }
            cmpBusy = true;
            const token = ++cmpToken;
            C.status.textContent = 'Reconstructing both versions (' + plan.desc + ')...';
            C.box.dataset.state = 'busy';
            const abort = function () { return token !== cmpToken || !S.visible || curAcq() !== acq; };
            try {
                const rOff = await PET.recon.run(plan.acqOff, plan.off, { shouldAbort: abort });
                const rOn = await PET.recon.run(plan.acqOn, plan.on, { shouldAbort: abort });
                if (!abort()) {
                    C.sig = plan.sig;
                    C.results = { off: rOff, on: rOn, acq: acq, desc: plan.desc, offLabel: plan.offLabel, onLabel: plan.onLabel };
                    renderCmp(C);
                }
            } catch (e) {
                if (!/aborted/.test(e && e.message)) { warn('comparison failed', e); C.status.textContent = 'The comparison failed: ' + (e && e.message); C.sig = plan.sig; }
            } finally { cmpBusy = false; }
            scheduleCmp();
            return;
        }
    }
    function showCmpUnavailable(C, reason) {
        C.box.classList.remove('is-stale');
        C.box.dataset.state = 'na';
        C.vOff.clear('-'); C.vOn.clear('-');
        C.status.textContent = reason;
        C.plot.el.hidden = true;
        C.table.textContent = '';
    }
    function cancelCmp() { cmpToken++; }
    /* The data changed: grey out every pair until it is recomputed. */
    function markCmpStale(msg) {
        Object.keys(S.cmp).forEach(function (k) {
            const C = S.cmp[k];
            if (!C.results && C.box.dataset.state !== 'na') return;
            C.box.classList.add('is-stale');
            C.box.dataset.state = 'stale';
            C.status.textContent = msg;
            C.sig = null;
        });
    }
    /* The ROIs a before/after table reports, per phantom (or the two
       halves of the object, for left/right errors such as a shifted mu map). */
    function metricMasks(eff, ph, kind, n, truth) {
        const A = PET.analysis, out = [];
        if (eff.cmp.halves && truth) {
            const mx = maxOf(truth), h = Math.floor(n / 2), dx = FOV / n;
            const L = new Float32Array(n * n), R = new Float32Array(n * n);
            for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
                const k = iy * n + ix;
                if (!(truth[k] > 0.15 * mx)) continue;
                const x = (ix - h) * dx;
                if (x < -10) L[k] = 1; else if (x > 10) R[k] = 1;
            }
            const br = kind === 'brain';
            out.push({ name: br ? 'Image left half (patient\'s right)' : 'Left half of the object', mask: L },
                { name: br ? 'Image right half (patient\'s left)' : 'Right half of the object', mask: R });
            return out;
        }
        if (kind === 'cylinder') {
            const cen = A.circleMask(n, FOV, 0, 0, 30), rim = A.circleMask(n, FOV, 0, 0, 90), inner = A.circleMask(n, FOV, 0, 0, 70);
            for (let k = 0; k < rim.length; k++) rim[k] = rim[k] > 0 && !(inner[k] > 0) ? 1 : 0;
            out.push({ name: 'Centre (r < 30 mm)', mask: cen }, { name: 'Rim (70 to 90 mm)', mask: rim },
                { name: 'Non-uniformity (CoV, r < 80 mm)', mask: A.circleMask(n, FOV, 0, 0, 80), cov: true });
            return out;
        }
        const defs = A.roiDefs(ph);
        (METRIC_ROIS[kind] || []).forEach(function (id) {
            const d = defs.find(function (x) { return x.id === id; });
            if (!d) return;
            try { out.push({ name: d.name, mask: A.roiMask(ph, n, id) }); } catch (e) { /* skip */ }
        });
        return out;
    }
    const renderCmp = safe(function (C) {
        const R = C.results;
        if (!R) return;
        const acq = R.acq, ph = phantomOf(acq), kind = kindOf(ph), n = R.on.n;
        const offLabel = R.offLabel || C.eff.cmp.offLabel, onLabel = R.onLabel || C.eff.cmp.onLabel;
        C.vOff.setTitle(offLabel); C.vOn.setTitle(onLabel);
        let truth = null;
        if (PET.analysis && ph) { try { truth = PET.analysis.truthImage(acq, R.on.frame, n, ph); } catch (e) { truth = null; } }
        const sc = function (a) { const o = new Float32Array(a.length); for (let k = 0; k < a.length; k++) o[k] = a[k] * 1e-3; return o; };
        const a = sc(R.off.image), b = sc(R.on.image), t = truth ? sc(truth) : null;
        let hi = Math.max(robustMax(a), robustMax(b));
        if (t && kind !== 'point') hi = Math.max(hi, 1.2 * maxOf(t));
        if (!(hi > 0)) hi = 1;
        const own = C.win === 'own';
        C.vOff.setData(a, n, n, { cmap: 'pet', min: 0, max: own ? (robustMax(a) || 1) : hi, resetWindow: true });
        C.vOn.setData(b, n, n, { cmap: 'pet', min: 0, max: own ? (robustMax(b) || 1) : hi, resetWindow: true });
        C.box.classList.remove('is-stale');
        C.box.dataset.state = 'done';
        C.status.textContent = 'Quick reconstructions (' + R.desc + '), kBq/mL' + (acq.frames.length > 1 ? ', frame ' + (R.on.frame + 1) : '') + '.';
        // profile
        const ln = LINES[kind] || ['h', 0], dx = FOV / n, h = Math.floor(n / 2), lo = -h * dx, hiX = (n - 1 - h) * dx;
        const ends = ln[0] === 'h' ? [lo, ln[1], hiX, ln[1]] : [ln[1], lo, ln[1], hiX];
        if (PET.analysis) {
            const prof = function (img) { return PET.analysis.profile(img, n, FOV, ends[0], ends[1], ends[2], ends[3], n); };
            const pa = prof(a), pb = prof(b), xs = Array.from(pa.s, function (s) { return lo + s; });
            const ser = [{ x: xs, y: pa.v, label: offLabel, color: 'var(--c2)' }, { x: xs, y: pb.v, label: onLabel, color: 'var(--c1)' }];
            if (t) ser.push({ x: xs, y: prof(t).v, label: 'Truth', color: 'var(--muted)', dash: true, width: 1.25 });
            C.plot.el.hidden = false;
            C.plot.setTitle((ln[0] === 'h' ? 'Profile at y = ' : 'Profile at x = ') + ln[1] + ' mm (kBq/mL)');
            C.plot.draw(ser, { includeZero: true });
        }
        // a few ROIs
        C.table.textContent = '';
        if (!PET.analysis || !ph) return;
        const rows = [];
        metricMasks(C.eff, ph, kind, n, truth).forEach(function (mk) {
            const A = PET.analysis, so = A.roiStats(R.off.image, mk.mask), sn = A.roiStats(R.on.image, mk.mask), st0 = truth ? A.roiStats(truth, mk.mask) : null;
            if (mk.cov) { rows.push([td(mk.name), td(pct(so.cov, 1)), td(pct(sn.cov, 1)), td(st0 ? pct(st0.cov, 1) : '-')]); return; }
            const tv = st0 ? st0.mean : NaN;
            const cl = function (v) { if (!(tv > 0)) return null; const r = v / tv; return Math.abs(r - 1) <= 0.1 ? 'good' : (Math.abs(r - 1) <= 0.25 ? 'warn' : 'bad'); };
            rows.push([td(mk.name), td(fmt(so.mean / 1000, 3), cl(so.mean)), td(fmt(sn.mean / 1000, 3), cl(sn.mean)), td(isFinite(tv) ? fmt(tv / 1000, 3) : '-')]);
        });
        if (rows.length) C.table.appendChild(dataTable(['ROI (kBq/mL)', offLabel, onLabel, 'True'], rows));
    }, 'comparison');

    /* ---------- building the tab ---------- */
    function mount(panel) {
        S.panel = panel;
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        const w = W();
        if (!w) { panel.appendChild(el('div', { class: 'error-card' }, 'The shared widgets (js/ui/widgets.js) did not load, so this tab cannot be shown.')); return; }
        panel.appendChild(w.concept({
            title: 'Every artifact has a cause and a cure',
            body: '<p>Each effect that degrades a PET image has a <b>physical cause</b>, switched on the left of the switchboard, and a <b>correction</b>, switched on the right. ' +
                'They are independent on purpose: leave a correction out and you see what the effect does; apply a correction when its effect is absent and you get the <b>opposite artifact</b>. ' +
                'Corrections are computed the way a scanner computes them, from a mu map, delayed coincidences, a scatter model fitted to the sinogram tails and a normalisation scan.</p>',
            formula: 'y<sub>i</sub> ~ Poisson( n<sub>i</sub> a<sub>i</sub> &kappa; (H x)<sub>i</sub> + s<sub>i</sub> + r<sub>i</sub> )',
            tryThis: [
                { html: 'Turn <b>attenuation correction</b> off on the uniform cylinder: the middle sags.', label: 'Show me', run: function () { BY_KEY.attenuation.shows[0].run(); scrollToCard('attenuation'); } },
                { html: 'Then turn <b>attenuation</b> off in the physics but keep the correction: the middle glows.', label: 'Show me', run: function () { BY_KEY.attenuation.shows[1].run(); scrollToCard('attenuation'); } },
                { html: 'Switch every effect off in the physics and every correction off: the reconstruction approaches the truth, limited only by the pixel grid.', label: 'All off',
                    run: function () { act('setPhysics', { attenuation: false, scatter: false, randoms: false, noise: false, positronRange: false, detectorBlur: false, motion: { on: false }, muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' }, detector: { variation: 0, deadBlock: -1 } });
                        act('setRecon', { corrections: { attenuation: false, scatter: false, randoms: false, normalization: false }, psf: false, rangeCorrection: false }); } },
                { html: 'Read the <b>Why</b> of each card, then predict what its "Show me" will do before you press it.' }
            ]
        }));
        panel.appendChild(buildBoard());
        EFFECTS.forEach(function (eff) { panel.appendChild(buildCard(eff)); });
        wireBus();
        S.mounted = true;
        syncAll();
    }

    function scrollToCard(key) {
        const c = S.cards[key];
        if (!c || !c.el) return;
        try { c.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { c.el.scrollIntoView(); }
    }

    /* ----- the switchboard ----- */
    function buildBoard() {
        const w = W(), box = el('section', { class: 'panel', 'aria-label': 'Switchboard of effects and corrections' });
        box.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Switchboard' }),
            el('span', { class: 'panel-sub', text: 'cause on the left, cure on the right' }), el('span', { class: 'spacer' }),
            el('div', { class: 'btn-group' }, [
                w.button({ label: 'Reset physics', size: 'sm', title: 'Every effect back to its default (on, no motion, aligned mu map, default crystals)', onClick: function () { act('resetPhysics'); } }),
                w.button({ label: 'Reset corrections', size: 'sm', title: 'Every correction back to its default', onClick: resetCorrections }),
                w.button({ label: 'Reset all', size: 'sm', kind: 'primary', onClick: function () { act('resetPhysics'); resetCorrections(); } })
            ])]));
        const wrap = el('div', { class: 'cc-board-wrap' });
        const table = el('table', { class: 'cc-board' });
        table.appendChild(el('thead', {}, el('tr', {}, [el('th', { scope: 'col', text: 'Effect' }), el('th', { scope: 'col', class: 'cc-c' }, [el('span', { class: 'cc-hl', text: 'In the physics' }), el('span', { class: 'cc-hs', text: 'Physics' })]),
            el('th', { scope: 'col', class: 'cc-c' }, [el('span', { class: 'cc-hl', text: 'Correction' }), el('span', { class: 'cc-hs', text: 'Fix' })]),
            el('th', { scope: 'col', class: 'cc-desc', text: 'What it does now' })])));
        const body = el('tbody');
        EFFECTS.forEach(function (eff) {
            const B = {};
            const name = el('button', { type: 'button', class: 'cc-name', title: 'Go to the ' + eff.title + ' card', onclick: function () { scrollToCard(eff.key); } }, eff.title);
            B.status = el('span', { class: 'cc-st' });
            const c1 = el('td', {}, [name, B.status]);
            let c2;
            if (eff.phys) {
                B.phys = w.toggle({ label: '', onChange: function (b) { eff.phys.set(b); } });
                B.phys.input.setAttribute('aria-label', eff.title + ' in the physics');
                c2 = el('td', { class: 'cc-c' }, B.phys);
            } else c2 = el('td', { class: 'cc-c' }, el('span', { class: 'cc-fixed', title: 'Radioactive decay cannot be switched off', text: 'always' }));
            let c3;
            if (eff.corr && eff.corr.get) {
                B.corr = w.toggle({ label: '', onChange: function (b) { eff.corr.set(b); } });
                B.corr.input.setAttribute('aria-label', eff.corr.label || (eff.title + ' correction'));
                c3 = el('td', { class: 'cc-c' }, B.corr);
            } else if (eff.corr && eff.corr.kind === 'button') {
                B.btn = w.button({ label: eff.corr.label, size: 'xs', title: eff.corr.title, onClick: function () { eff.corr.run(); } });
                c3 = el('td', { class: 'cc-c' }, B.btn);
            } else {
                c3 = el('td', { class: 'cc-c' }, w.button({ label: eff.corr.label, size: 'xs', title: eff.corr.title, onClick: function () { scrollToCard(eff.key); } }));
            }
            B.desc = el('td', { class: 'cc-desc' });
            body.appendChild(el('tr', {}, [c1, c2, c3, B.desc]));
            S.board[eff.key] = B;
        });
        table.appendChild(body);
        wrap.appendChild(table);
        box.appendChild(wrap);
        const line = el('div', { class: 'cc-statusline' });
        S.ui.live = el('span', { class: 'cc-live', 'aria-live': 'polite' });
        S.ui.liveNote = el('span');
        line.appendChild(S.ui.live);
        line.appendChild(S.ui.liveNote);
        box.appendChild(line);
        S.ui.frameBox = el('div', { class: 'cc-frame mt-1', hidden: true });
        box.appendChild(S.ui.frameBox);
        return box;
    }
    function resetCorrections() {
        const rd = reconDefaults();
        act('setRecon', { corrections: clone(rd.corrections), psf: !!rd.psf, rangeCorrection: !!rd.rangeCorrection });
    }

    /* ----- one card per effect ----- */
    function buildCard(eff) {
        const w = W(), card = el('section', { class: 'panel cc-card', id: 'corr-' + eff.key, 'aria-label': eff.title });
        const C = { el: card };
        const head = el('div', { class: 'panel-head' });
        head.appendChild(el('h2', { class: 'panel-title', text: eff.title }));
        C.badge = w.badge('', 'muted');
        head.appendChild(C.badge);
        head.appendChild(el('span', { class: 'spacer' }));
        const shows = el('div', { class: 'cc-shows' });
        (eff.shows || []).forEach(function (s) {
            shows.appendChild(w.button({ label: 'Show me: ' + s.label, size: 'sm', title: 'Set up this demonstration (loads a protocol and phantom, sets the physics and corrections, re-scans)', onClick: s.run }));
        });
        head.appendChild(shows);
        card.appendChild(head);

        const body = el('div', { class: 'cc-body' });
        const left = el('div');
        const sw = el('div', { class: 'cc-switches' });
        if (eff.phys) {
            C.phys = w.toggle({ label: 'In the physics', onChange: function (b) { eff.phys.set(b); } });
            C.phys.input.setAttribute('aria-label', eff.title + ' in the physics');
            sw.appendChild(C.phys);
        }
        if (eff.corr && eff.corr.get) {
            C.corr = w.toggle({ label: eff.corr.label || 'Correction', onChange: function (b) { eff.corr.set(b); } });
            sw.appendChild(C.corr);
        } else if (eff.corr && eff.corr.kind === 'button') {
            C.btn = w.button({ label: eff.corr.label + ' the mu map', size: 'sm', title: eff.corr.title, onClick: function () { eff.corr.run(); } });
            sw.appendChild(C.btn);
        }
        if (sw.children.length) left.appendChild(sw);
        const ctl = el('div', { class: 'cc-ctl' });
        left.appendChild(ctl);
        C.update = eff.controls ? eff.controls(ctl) : null;
        const text = el('div', { class: 'cc-text' }, [
            el('h3', { text: 'What you see' }), el('p', { html: eff.see }),
            el('h3', { text: 'Why' }), el('p', { html: eff.why }),
            el('h3', { text: 'How it is corrected' }), el('p', { html: eff.how })
        ]);
        left.appendChild(text);
        C.look = el('div', { class: 'callout callout-good cc-look', hidden: true, role: 'status' });
        C.lookText = el('div');
        C.look.appendChild(C.lookText);
        C.look.appendChild(w.button({ label: 'Open the Reconstruction tab', size: 'xs', onClick: function () { act('showTab', 'recon'); } }));
        left.appendChild(C.look);
        body.appendChild(left);
        const right = el('div');
        if (eff.cmp) buildCompare(eff, right);
        else {
            right.appendChild(el('p', { class: 'note' }, 'There is no before/after here: noise can only be changed by acquiring different data, so use the sliders (each change re-scans) and watch the image and its noise.'));
            if (eff.key === 'noise' && S.ui.noiseSide) right.appendChild(S.ui.noiseSide);
        }
        body.appendChild(right);
        card.appendChild(body);
        S.cards[eff.key] = C;
        return card;
    }

    /* ---------- syncing ---------- */
    const syncAll = safe(function () {
        if (!S.mounted) return;
        const p = phys(), c = corr();
        EFFECTS.forEach(function (eff) {
            const B = S.board[eff.key], C = S.cards[eff.key];
            const s = eff.status(p, c, curAcq()) || ['', 'muted', ''];
            if (B) {
                B.status.textContent = s[0];
                B.status.className = 'cc-st ' + (s[1] === 'muted' ? '' : s[1]);
                B.status.title = s[2];
                B.desc.textContent = s[2];
                if (B.phys) B.phys.set(eff.phys.get(p));
                if (B.corr) B.corr.set(eff.corr.get(c));
                if (B.btn) B.btn.disabled = !eff.phys.get(p) || !((p.muMap || {}).dx || (p.muMap || {}).dy || (p.muMap || {}).rot);
            }
            if (C) {
                C.badge.textContent = s[0];
                C.badge.className = 'badge badge-' + (s[1] === 'muted' ? 'muted' : s[1]);
                C.badge.title = s[2];
                if (C.phys) C.phys.set(eff.phys.get(p));
                if (C.corr) C.corr.set(eff.corr.get(c));
                if (C.btn) C.btn.disabled = !((p.muMap || {}).dx || (p.muMap || {}).dy || (p.muMap || {}).rot);
            }
        });
        renderLive();
    }, 'sync');
    const updateCards = safe(function () {
        EFFECTS.forEach(function (eff) {
            const C = S.cards[eff.key];
            if (C && C.update) { try { C.update(); } catch (e) { warn(eff.key + ' controls failed', e); } }
        });
    }, 'cards');
    const renderLive = safe(function () {
        const s = st(), live = S.ui.live;
        if (!live) return;
        let txt, busy = false;
        if (s.scanning) { txt = 'Re-scanning...'; busy = true; }
        else if (s.reconstructing) { txt = 'Reconstructing...'; busy = true; }
        else if (!s.acq) txt = 'No scan yet.';
        else if (s.stale && !s.autoRescan) txt = 'Physics changed: press Acquire (auto re-scan is off).';
        else txt = 'Up to date.';
        live.textContent = txt;
        live.classList.toggle('busy', busy);
        S.ui.liveNote.textContent = 'Physics switches change what the scanner records, so they re-scan; correction switches only reconstruct the same data again.';
        renderFrame();
    }, 'status');
    const renderFrame = safe(function () {
        const box = S.ui.frameBox, acq = curAcq();
        if (!box) return;
        const nF = acq && acq.frames ? acq.frames.length : 0;
        box.hidden = nF <= 1;
        if (nF <= 1) return;
        const f = frameIndex(acq), F = acq.frames[f];
        if (!S.ui.frameSlider || S.ui.frameN !== nF) {
            box.textContent = '';
            S.ui.frameSlider = W().slider({ label: 'Frame (dynamic protocol)', min: 0, max: nF - 1, step: 1, value: f,
                format: function (v) { return (Math.round(v) + 1) + ' of ' + nF; }, onChange: function (v) { act('setFrame', Math.round(v)); } });
            S.ui.frameTime = el('span', { class: 'note' });
            box.appendChild(S.ui.frameSlider);
            box.appendChild(S.ui.frameTime);
            S.ui.frameN = nF;
        }
        S.ui.frameSlider.set(f);
        S.ui.frameTime.textContent = fmtT(F.t0) + ' to ' + fmtT(F.t1) + ' after injection. The before/after pairs and the tables use this frame.';
    }, 'frame');

    function refresh() {
        if (!S.mounted) return;
        if (!S.visible) { S.dirty = true; return; }
        S.dirty = false;
        syncAll();
        updateCards();
        EFFECTS.forEach(function (eff) { const C = S.cmp[eff.key]; if (C && C.results) renderCmp(C); });
        scheduleCmp();
    }

    function wireBus() {
        const bus = PET.bus;
        if (!bus) return;
        bus.on('physics:changed', function () { if (S.visible) { syncAll(); updateCards(); } else S.dirty = true; });
        bus.on('reconopts:changed', function () { cancelCmp(); markCmpStale('The reconstruction settings changed: this pair will be recomputed.'); if (S.visible) { syncAll(); updateCards(); scheduleCmp(); } else S.dirty = true; });
        bus.on('scan:start', function () { cancelCmp(); markCmpStale('A new scan is on its way: this pair will be recomputed from it.'); if (S.visible) renderLive(); });
        bus.on('scan:done', function () { if (S.visible) { syncAll(); updateCards(); } else S.dirty = true; });
        bus.on('scan:error', function () { if (S.visible) renderLive(); });
        bus.on('recon:start', function () { if (S.visible) renderLive(); });
        bus.on('recon:done', function (e) {
            if (!S.visible) { S.dirty = true; return; }
            renderLive();
            if (e && e.partial) return;
            updateCards();
            scheduleCmp();
        });
        bus.on('frame:changed', function () { cancelCmp(); markCmpStale('Another frame was chosen: this pair will be recomputed.'); if (S.visible) { renderFrame(); updateCards(); scheduleCmp(); } });
        bus.on('program:compiled', function () { if (S.visible) updateCards(); });
        bus.on('theme:changed', function () { /* plots redraw themselves; wells sit on fixed dark backgrounds */ });
    }

    PET.ui.registerTab({
        id: 'corrections', title: 'Degradations & corrections', order: 70,
        mount: mount,
        onShow: function () { S.visible = true; refresh(); },
        onHide: function () { S.visible = false; cancelCmp(); }
    });

})(typeof window !== 'undefined' ? window : globalThis);
