/* ============================================================
   MRI Simulator, Artifacts tab (ARCHITECTURE.md section 12.5)

   One card per artifact, grouped by where the artifact comes from:
     Signal and noise        noise and SNR, B1 (dielectric) shading, coil shading
     Sampling                aliasing, Gibbs ringing
     Off-resonance           chemical shift, B0 inhomogeneity and susceptibility
     Motion and flow         motion, pulsatile flow
     Hardware                EPI Nyquist ghost, RF spike, zipper
     Reconstruction, timing  partial Fourier and undersampling, echo-train
                             blurring, missing dummy scans

   Every card says what you see, why, where it lives in k-space and how
   to fix it, carries the controls that change it (artifact settings go
   through MRI.actions.setArtifacts; a few cards also expose the sequence
   parameter or reconstruction option that matters), and a "Show me"
   button that loads a demonstration and runs an animated scan.

   The artifacts are not painted on: each comes from its mechanism in
   the engine (section 9), so the controls interact with TR, bandwidth
   and phase-encode direction the way they do on a scanner.

   A card is marked when its artifact is switched on (amber) or is
   present in the current scan because of the sequence or the
   reconstruction (blue). A small live preview of the image and k-space
   sits beside the cards so students see the effect without switching
   tabs. Hidden, the tab only sets a dirty flag.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const FAT_HZ = Math.abs((MRI.const && MRI.const.FAT_HZ) || 434.3);
    const DEG = 180 / Math.PI;
    const STORE_KEY = 'mriSim.artifacts.groups';

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function W() { return MRI.ui.w; }
    function S() { return MRI.state; }
    function A() { return MRI.actions; }
    function fnum(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3) : '-'; }
    function storeGet() { try { return JSON.parse(root.localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } }
    function storeSet(v) { try { root.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
    function toast(msg, kind) { if (W() && W().toast) W().toast(msg, kind); }
    function terms() { return (MRI.ui && MRI.ui.terms) || {}; }
    function combineName(id) { const c = terms().combine; return (c && c[id]) || ({ sos: 'Root-sum-of-squares', roemer: 'Roemer', single: 'Single coil' })[id] || id; }
    function coilName(type) { const c = terms().coil; return (c && c[type]) || (type === 'body' ? 'Body coil' : '8-channel head coil'); }
    function scrollBehavior() { return U.scrollBehavior ? U.scrollBehavior() : 'auto'; }
    /* A demonstration's "Loads:" text; a function when it is computed from the sequences. */
    function loadsText(d) {
        try { return typeof d.loads === 'function' ? d.loads() : d.loads; } catch (e) { return ''; }
    }
    function frameThrottle(fn) {
        let pending = false;
        return function () {
            if (pending) return;
            pending = true;
            raf(function () { pending = false; fn(); });
        };
    }

    MRI.ui.addStyle(`
#tab-artifacts .af-layout { align-items: start; }
#tab-artifacts .af-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-artifacts .af-side { position: sticky; top: var(--af-top, 128px); align-self: start; min-width: 0; }
#tab-artifacts .af-side .panel { margin: 0; }
#tab-artifacts .af-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0; }
#tab-artifacts .af-summary { flex: 1 1 260px; min-width: 0; font-size: 0.86rem; line-height: 1.45; margin: 0; }
#tab-artifacts .af-summary .af-sum-label { font-weight: 650; }
#tab-artifacts .af-summary .af-none { color: var(--muted); }
#tab-artifacts .af-chip { display: inline-block; margin: 0 4px 2px 0; }
#tab-artifacts .af-group { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-1); min-width: 0; }
#tab-artifacts .af-group > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px;
    padding: 12px 16px 12px 38px; position: relative; border-radius: var(--radius);
}
#tab-artifacts .af-group > summary::-webkit-details-marker { display: none; }
#tab-artifacts .af-group > summary::before {
    content: ""; position: absolute; left: 17px; top: 19px; width: 7px; height: 7px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
    transform: rotate(-45deg); transition: transform 0.15s ease;
}
#tab-artifacts .af-group[open] > summary::before { transform: rotate(45deg); top: 16px; }
#tab-artifacts .af-group > summary:hover { background: var(--hover); }
#tab-artifacts .af-group-title { font-size: 1rem; font-weight: 650; margin: 0; line-height: 1.35; }
#tab-artifacts .af-more { margin: 2px 0 0; font-size: 0.875rem; }
#tab-artifacts .af-more > summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 0.84rem; width: fit-content; border-radius: 4px; padding: 2px 0; }
#tab-artifacts .af-more > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-artifacts .af-more[open] > summary { margin-bottom: 6px; }
#tab-artifacts .af-group-list { flex: 1 1 220px; min-width: 0; color: var(--muted); font-size: 0.82rem; }
#tab-artifacts .af-group-badges { display: inline-flex; gap: 6px; flex-wrap: wrap; }
#tab-artifacts .af-group-body { display: flex; flex-direction: column; gap: 12px; padding: 0 16px 16px; }
#tab-artifacts .af-card {
    container-type: inline-size; scroll-margin-top: calc(var(--af-top, 128px) + 8px);
    background: var(--card-2); border: 1px solid var(--border-subtle); border-left: 3px solid var(--border);
    border-radius: 8px; padding: 12px 16px 14px; min-width: 0;
}
#tab-artifacts .af-card.is-on { border-left-color: var(--warn); }
#tab-artifacts .af-card.is-present { border-left-color: var(--accent); }
#tab-artifacts .af-card-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin: 0 0 8px; }
#tab-artifacts .af-card-head h3 { font-size: 1rem; margin: 0; }
#tab-artifacts .af-card-body { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 12px 24px; }
@container (max-width: 620px) { #tab-artifacts .af-card-body { grid-template-columns: minmax(0, 1fr); } }
#tab-artifacts .af-facts { margin: 0; font-size: 0.875rem; line-height: 1.5; }
#tab-artifacts .af-facts dt {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 0 0 1px;
}
#tab-artifacts .af-facts dd { margin: 0 0 9px; }
#tab-artifacts .af-facts dd:last-child { margin-bottom: 0; }
#tab-artifacts .af-eq {
    font-family: var(--font-math); font-size: 1rem; background: var(--card); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 10px; margin: 6px 0 2px; overflow-x: auto; text-align: center;
}
#tab-artifacts .af-ctl { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
#tab-artifacts .af-live { font-size: 0.8rem; color: var(--muted); line-height: 1.45; margin: 0; }
#tab-artifacts .af-live b { color: var(--fg); font-weight: 600; }
#tab-artifacts .af-live.is-warn { color: var(--warn); }
#tab-artifacts .af-show { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px dashed var(--border); }
#tab-artifacts .af-show-btns { display: flex; flex-wrap: wrap; gap: 6px; }
#tab-artifacts .af-show svg { width: 11px; height: 11px; flex: none; }
#tab-artifacts .af-loads { font-size: 0.78rem; color: var(--muted); line-height: 1.4; margin: 0; }
#tab-artifacts .af-card .simplification { margin: 8px 0 0; }
#tab-artifacts .af-psf { margin-top: 2px; }
#tab-artifacts .af-prev-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; }
#tab-artifacts .af-prev-grid .well { padding: 8px; }
#tab-artifacts .af-prev-info { font-size: 0.8rem; color: var(--muted); margin: 8px 0 0; line-height: 1.4; }
#tab-artifacts .af-prev-links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
@media (max-width: 900px) {
    #tab-artifacts .af-side { position: static; order: -1; }
    #tab-artifacts .af-prev-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
    #tab-artifacts .af-group > summary { padding: 10px 12px 10px 32px; }
    #tab-artifacts .af-group > summary::before { left: 13px; top: 17px; }
    #tab-artifacts .af-group[open] > summary::before { top: 14px; }
    #tab-artifacts .af-group-body { padding: 0 10px 12px; }
    #tab-artifacts .af-card { padding: 10px 12px 12px; }
}
`);

    /* ============================================================
       Demonstrations
       A demonstration is a complete set-up: it resets the artifacts,
       loads a preset (optionally edited), sets parameters, the coil, the
       reconstruction options and the phantom, then switches on the
       artifact. Each one is independent of what the student did before.
       ============================================================ */

    /* Source edits, each a function source -> source (unchanged when the
       pattern is not found, so a later change of a preset degrades to
       "no edit" rather than to a broken sequence). */
    const EDIT = {
        dummies: function (k) {
            return function (src) {
                return src.replace(/^([ \t]*dummies[ \t]+)([^\s#]+)/m, function (m, a) { return a + k; });
            };
        },
        slice: function (mm) {
            return function (src) {
                return src.replace(/^([ \t]*slice[ \t]+)([^#\n]*?)([ \t]*(#.*)?)$/m, function (m, a, b, c) { return a + mm + ' mm' + (c || ''); });
            };
        },
        /* Spectral fat saturation before the excitation, as every clinical EPI has. */
        fatSat: function (src) {
            if (/rf\s+\S+\s+fat\b/.test(src)) return src;
            return src.replace(/^([ \t]*)(rf 90 slice as exc.*)$/m, function (m, ind, line) {
                return ind + 'rf 90 fat dur 8 ms                      # fat saturation, added by the demonstration\n' + ind + 'spoil\n' + ind + line;
            });
        },
        /* Turbo spin echo with centre-out ordering: echo 0 records the centre
           of k-space and later echoes alternate outwards, as in single-shot
           and proton-density TSE. Line = (ETL/2 + (-1)^e ceil(e/2)) shots + shot
           visits every segment once. */
        centreOut: function (src) {
            const L = '((ETL/2 + (-1)^e * ceil(e/2)) * shots + shot)';
            let out = src.replace(/gy encode e\*shots \+ shot/, 'gy encode ' + L)
                .replace(/gy rewind e\*shots \+ shot/, 'gy rewind ' + L);
            if (out === src) return src;
            out = out.replace(/^sequence "Turbo spin echo"/m, 'sequence "Turbo spin echo, centre-out ordering"\n# Edited by the demonstration: echo 0 records the centre of k-space, later\n# (weaker) echoes fill the edges, so short-T2 tissue blurs along y.')
                .replace(/^let TEeff = .*$/m, 'let TEeff = ESP                         # centre-out: the first echo records the k-space centre');
            return out;
        }
    };

    function reconDefaults() {
        const d = Object.assign({}, (MRI.recon && MRI.recon.defaults) || {});
        d.userMask = null;
        return d;
    }

    /* Apply a set-up. Returns {ok, message}. Order matters: the sequence
       first (it decides the phantom raster), then the phantom. */
    function applySetup(s) {
        const a = A(), st = S();
        a.resetArtifacts();
        if (s.preset && !a.loadPreset(s.preset)) return { ok: false, message: 'The preset "' + s.preset + '" is missing.' };
        (s.edits || []).forEach(function (fn) {
            const src = fn(st.source);
            if (src && src !== st.source) a.setSource(src);
        });
        Object.keys(s.params || {}).forEach(function (k) { a.setParam(k, s.params[k]); });
        a.setCoil(s.coil || 'head8');
        a.setRecon(Object.assign(reconDefaults(), s.recon || {}));
        a.setPhantom(s.phantom || 'brain', s.phantomOpts || {});
        if (s.artifacts) a.setArtifacts(s.artifacts);
        const p = st.program;
        if (!p || !p.ok) {
            const e = p && p.errors && p.errors[0];
            return { ok: false, message: 'The demonstration sequence does not compile' + (e ? ' (line ' + e.line + ': ' + e.msg + ')' : '') + '.' };
        }
        return { ok: true };
    }

    /* Run a demonstration: set up, open the tab, then an animated scan.
       The app re-scans instantly 250 ms after the last settings change
       (when Auto re-scan is on); starting the animated scan after that
       moment lets it replace the instant one instead of being cancelled
       by it. */
    let demoToken = 0;
    function runDemo(demo) {
        const r = applySetup(demo.setup);
        if (!r.ok) { toast(r.message, 'bad'); A().showTab('sequence', { focus: true }); return; }
        // keyboard focus moves to the start of the destination tab, not to <body>
        A().showTab(demo.setup.tab || 'image', { focus: true });
        const tok = ++demoToken;
        setTimeout(function () {
            if (tok !== demoToken) return;
            A().runScan({ animate: true });
        }, 320);
        if (demo.toast) toast(demo.toast, 'info');
    }

    /* ============================================================
       Reading the current scan
       ============================================================ */
    function program() {
        const st = S();
        return st.program && st.program.ok ? st.program : st.lastGoodProgram;
    }
    function paramProgram() {
        const st = S();
        return st.program && st.program.params && st.program.params.length ? st.program : st.lastGoodProgram;
    }
    function param(name) {
        const p = paramProgram();
        if (!p || !p.params) return null;
        for (let i = 0; i < p.params.length; i++) if (p.params[i].name === name) return p.params[i];
        return null;
    }
    function hasRange(p) { return !!p && isFinite(p.min) && isFinite(p.max) && p.max > p.min; }
    function isGradientEcho(p) { return !!p && !(p.rf || []).some(function (r) { return r.role === 'refocus'; }); }
    function readoutsPerPeriod(p) {
        if (!p || !p.adc) return 0;
        const per = {};
        let mx = 0;
        p.adc.forEach(function (a) { if (a.dummy) return; per[a.period] = (per[a.period] || 0) + 1; mx = Math.max(mx, per[a.period]); });
        return mx;
    }
    /* EPI-like: readout gradients of both signs within one repetition. */
    function hasBipolarReadouts(p) {
        if (!p || !p.grad || !p.image) return false;
        const ax = p.image.readoutAxis === 'y' ? 'y' : 'x';
        const per = {};
        return (p.grad[ax] || []).some(function (t) {
            if (t.tag !== 'readout' || !t.amp) return false;
            const k = t.block !== undefined && p.blocks && p.blocks[t.block] ? p.blocks[t.block].period : 'all';
            const q = per[k] || (per[k] = { pos: false, neg: false });
            if (t.amp > 0) q.pos = true; else q.neg = true;
            return q.pos && q.neg;
        });
    }
    function phaseAxis(p) { return p && p.image && p.image.readoutAxis === 'y' ? 'x' : 'y'; }
    function compileNote() {
        const st = S();
        if (st.program && !st.program.ok) {
            const e = st.program.errors && st.program.errors[0];
            return 'The sequence does not compile' + (e ? ': ' + e.msg + (e.hint ? ' ' + e.hint : '') : '.');
        }
        return '';
    }

    /* Extent of the object (non-air raster points) in metres along x and y,
       cached per phantom object. */
    const extentCache = new WeakMap();
    function objectExtent(ph) {
        if (!ph || !ph.label) return null;
        let e = extentCache.get(ph);
        if (e) return e;
        const n = ph.n;
        let x0 = n, x1 = -1, y0 = n, y1 = -1;
        for (let iy = 0; iy < n; iy++) {
            const o = iy * n;
            for (let ix = 0; ix < n; ix++) {
                if (!ph.label[o + ix]) continue;
                if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
                if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
            }
        }
        e = x1 < 0 ? { x: 0, y: 0 } : { x: (x1 - x0 + 1) * ph.dx, y: (y1 - y0 + 1) * ph.dx };
        extentCache.set(ph, e);
        return e;
    }
    function currentPhantom() {
        try { return A().getPhantom(); } catch (e) { return null; }
    }
    function hasFat(ph) { return !!(ph && ph.tissues && ph.tissues.some(function (t) { return t && t.cs; })); }

    /* ============================================================
       Control helpers
       ============================================================ */

    /* A slider bound to a sequence parameter. Display unit and scale are
       fixed here (FOV always in mm), the range comes from the program. */
    function paramSlider(name, label, unit, scale, defStep) {
        let dragging = false;
        const row = W().slider({
            label: label, min: 0, max: 1, value: 0, unit: unit, scale: scale,
            onInput: function () { dragging = true; },
            onChange: function (v) { dragging = false; if (param(name)) A().setParam(name, v); }
        });
        row.input.addEventListener('blur', function () { dragging = false; });
        const note = el('p', { class: 'af-live', hidden: true });
        const wrap = el('div', { class: 'stack stack-sm' }, [row, note]);
        wrap.update = function () {
            const p = param(name);
            if (!hasRange(p)) {
                row.hidden = true;
                note.hidden = false;
                note.textContent = label + ': this sequence has no ' + name + ' parameter to adjust.';
                return;
            }
            note.hidden = true;
            row.hidden = false;
            if (!dragging) {
                row.setRange(p.min, p.max, p.step > 0 ? p.step : defStep);
                row.set(p.value);
            }
        };
        return wrap;
    }

    function playIcon() {
        return '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>';
    }

    /* ============================================================
       The cards
       Each: id, group, title, list (short name for the group summary),
       see, why, kspace, fix (HTML), eq (optional formula), simpl
       (optional honest-simplification note), build(ctlBox) -> {sync()},
       status() -> null | {kind: 'on'|'present', text}, demos.
       ============================================================ */
    const GROUPS = [
        { id: 'signal', title: 'Signal and noise' },
        { id: 'sampling', title: 'Sampling' },
        { id: 'offres', title: 'Off-resonance' },
        { id: 'motion', title: 'Motion and flow' },
        { id: 'hardware', title: 'Hardware' },
        { id: 'recon', title: 'Reconstruction and timing' }
    ];

    const CARDS = [];

    /* ---------- Noise and SNR ---------- */
    CARDS.push({
        id: 'noise', group: 'signal', title: 'Noise and SNR', list: 'noise',
        see: 'A grainy texture over the whole image, in the air around the object as much as inside it. Fine detail and low-signal tissue disappear into it first.',
        why: 'Thermal noise from the patient\'s body and the receiver adds a random number to every sample. The signal grows with the number of protons in a voxel; the noise averages down only with the square root of the time spent sampling.',
        eq: 'SNR ∝ Δx·Δy·Δz · √(N<sub>phase</sub> · NEX / BW<sub>pixel</sub>)',
        kspace: 'Everywhere, evenly: white noise covers all of k-space, while the signal is concentrated at the centre, so the edges (fine detail) drown first.',
        fix: 'Bigger voxels (thicker slice, coarser matrix, larger FOV), more averages (NEX), a lower readout bandwidth, or coils closer to the tissue. Each one costs time, resolution or a larger fat shift.',
        build: function (box) {
            const sl = W().slider({ label: 'Receiver noise level', unit: '× normal', min: 0, max: 5, step: 0.1, value: 1,
                hint: '1 is this scanner\'s normal thermal noise; 0 is a noiseless receiver, which no real scanner has',
                onInput: function (v) { A().setArtifacts({ noise: v }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(sl);
            box.appendChild(live);
            return {
                sync: function () {
                    const a = S().artifacts, p = program();
                    sl.set(a.noise);
                    const parts = [];
                    if (p && p.image) {
                        const im = p.image;
                        parts.push('Voxel <b>' + fnum(im.fovX / im.nx * 1e3) + ' × ' + fnum(im.fovY / im.ny * 1e3) + ' × ' + fnum(im.thickness * 1e3) + ' mm</b>, ' +
                            '<b>' + fnum(im.bwPerPixel, 4) + ' Hz/px</b>, NEX <b>' + (im.averages || 1) + '</b>.');
                    }
                    parts.push(a.noise === 0 ? 'Noiseless: a check on the other artifacts, impossible on a real scanner.' : 'Measure the SNR in the Image tab (Place both).');
                    live.innerHTML = parts.join(' ');
                }
            };
        },
        status: function () {
            const n = S().artifacts.noise;
            if (n === 1) return null;
            return { kind: 'on', text: n === 0 ? 'Noiseless' : 'Noise × ' + fnum(n, 2) };
        },
        demos: [{
            label: 'Show me',
            loads: 'Spin echo on the brain with a 2 mm slice (instead of 5 mm) and 600 Hz/px (instead of 150): 2.5× fewer protons per voxel and √4 = 2× more noise, so the SNR falls about 5×. Then raise NEX to 4 in the Sequence tab.',
            setup: { phantom: 'brain', preset: 'se', edits: [EDIT.slice(2)], params: { BW: 600 } }
        }]
    });

    /* ---------- B1 (dielectric) shading ---------- */
    CARDS.push({
        id: 'b1', group: 'signal', title: 'B1 (dielectric) shading', list: 'B1 shading',
        see: 'A smooth brightness variation unrelated to anatomy: at 3 T usually a brighter centre and darker periphery of the head (or body).',
        why: 'At 127.7 MHz the RF wavelength in tissue is only about 25 to 30 cm, comparable to the head, so the transmit field B1 forms a standing-wave pattern: it is stronger in the middle and weaker at the edges. The flip angle, and with it the signal, follows that pattern.',
        kspace: 'Nowhere in particular: it multiplies the image by a smooth map, so it changes the low spatial frequencies at the centre of k-space (the contrast itself).',
        fix: 'High-permittivity dielectric pads around the head, multi-channel parallel transmit (B1 shimming), adiabatic pulses (insensitive to B1) for inversion, and sequences whose signal depends little on the flip angle.',
        simpl: 'Simplification: the simulator applies the pattern b1 = 1 + a(0.6 − (r/90 mm)²) to the transmit field only (tracked at 9 B1 values and interpolated between them, so the shading is smooth); on a real scanner the receive field adds its own pattern. With a spin echo, too large a flip loses signal just as too small a flip does, so the centre can turn darker instead.',
        build: function (box) {
            const sl = W().slider({ label: 'Dielectric effect a', unit: '', min: 0, max: 0.5, step: 0.01, value: 0,
                hint: 'Strength of the standing-wave pattern of the transmit field (0 = uniform)',
                onInput: function (v) { A().setArtifacts({ b1: { amount: v } }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(sl); box.appendChild(live);
            return {
                sync: function () {
                    const a = S().artifacts.b1.amount || 0;
                    sl.set(a);
                    const c = U.clamp(1 + 0.6 * a, 0.4, 1.6), e = U.clamp(1 - 0.4 * a, 0.4, 1.6), r = U.clamp(1 + a * (0.6 - Math.pow(100 / 90, 2)), 0.4, 1.6);
                    live.innerHTML = 'Flip angle × <b>' + c.toFixed(2) + '</b> at the centre, × <b>' + e.toFixed(2) + '</b> at 90 mm, × <b>' + r.toFixed(2) + '</b> at 100 mm. ' +
                        'See the map in the Phantom tab (Map: B1 transmit).';
                }
            };
        },
        status: function () {
            const a = S().artifacts.b1.amount || 0;
            return a > 0 ? { kind: 'on', text: 'a = ' + fnum(a, 2) } : null;
        },
        demos: [{
            label: 'Show me',
            loads: 'The uniform MRS phantom, T2*-weighted gradient echo (flip 20°, where signal rises with flip), body coil, dielectric effect 0.5: the centre gets about 26° and the edge about 18°.',
            setup: { phantom: 'braino', preset: 'gre_t2s', coil: 'body', artifacts: { b1: { amount: 0.5 } } }
        }]
    });

    /* ---------- Coil shading ---------- */
    CARDS.push({
        id: 'coil', group: 'signal', title: 'Receive coil shading', list: 'coil shading',
        see: 'With the 8-channel head coil combined by root-sum-of-squares, the tissue near the surface is much brighter than the middle of the head, although the object is uniform.',
        why: 'Each small loop sees mainly the tissue within about its own diameter. Root-sum-of-squares combination keeps that sensitivity profile in the image. The higher SNR near the coils is real; the brightness gradient is not anatomy. The array also picks up much less noise than the body coil (each loop hears only a small volume of the patient), so its SNR is higher everywhere in the head, most of all near the cortex.',
        kspace: 'Like B1 shading, a smooth multiplication of the image. Each coil\'s k-space is the object\'s k-space blurred by the small spectrum of its sensitivity map, so it stays near the centre.',
        fix: 'Combine the coils with their sensitivity maps (Roemer, the default here), or normalise with a body-coil reference scan (prescan normalise). Both even out the brightness without changing the SNR, which stays highest near the coils and, even in the middle of the head, above the body coil\'s.',
        build: function (box) {
            const coil = W().segmented({ label: 'Receive coil', size: 'sm', value: S().coilType,
                options: terms().coilOptions || [{ value: 'body', label: coilName('body') }, { value: 'head8', label: coilName('head8') }],
                onChange: function (v) { A().setCoil(v); } });
            const comb = W().segmented({ label: 'Coil combination', size: 'sm', value: S().recon.coilCombine === 'sos' ? 'sos' : 'roemer',
                options: [{ value: 'sos', label: combineName('sos') }, { value: 'roemer', label: combineName('roemer') }],
                onChange: function (v) { A().setRecon({ coilCombine: v }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(coil); box.appendChild(comb); box.appendChild(live);
            return {
                sync: function () {
                    const st = S(), cc = st.recon.coilCombine || 'roemer';
                    coil.set(st.coilType);
                    comb.set(cc === 'sos' ? 'sos' : 'roemer');
                    comb.setDisabled(st.coilType !== 'head8');
                    const r = st.reconResult;
                    live.textContent = st.coilType !== 'head8' ? 'The body coil: uniform, so no receive shading, but noisier than the head array (it picks up noise from the whole head, neck and shoulders), so the SNR is lower everywhere in the head.'
                        : r && r.gfactor ? 'SENSE is unfolding this scan and combines the coils itself.'
                        : cc === 'single' ? 'One coil element on its own (set in the Image tab).'
                        : cc === 'roemer' ? combineName('roemer') + ' (the default): weighted by the coil maps, so the brightness is even.' : combineName('sos') + ': bright near the coils.';
                }
            };
        },
        status: function () {
            const st = S(), r = st.reconResult;
            if (st.coilType === 'head8' && st.recon.coilCombine === 'sos' && !(r && r.gfactor)) return { kind: 'present', text: '8 coils, root-sum-of-squares' };
            return null;
        },
        demos: [{
            label: 'Show me',
            loads: 'The uniform MRS phantom, T1-weighted gradient echo, 8-channel head coil, combined by root-sum-of-squares (the default is Roemer): a bright rim. Then choose Roemer above.',
            setup: { phantom: 'braino', preset: 'gre_t1', coil: 'head8', recon: { coilCombine: 'sos' } }
        }]
    });

    /* ---------- Aliasing ---------- */
    CARDS.push({
        id: 'alias', group: 'sampling', title: 'Aliasing (wrap-around)', list: 'aliasing',
        see: 'Anatomy outside the field of view reappears folded in on the opposite side: here the back of the head lands on the forehead and the front on the back, along the phase-encode direction (y).',
        why: 'k-space is sampled every Δk = 1/FOV. Sampled that coarsely, a point at y and a point at y ± FOV give identical samples, so the reconstruction cannot tell them apart and places both inside the FOV.',
        eq: 'FOV = 1 / Δk',
        kspace: 'In the spacing of the samples, not in any one of them: Δk along phase is too large. Nothing looks wrong in k-space itself.',
        fix: 'A larger FOV; swapping phase and readout so the long axis runs along the readout (Sequence tab, "Swap gx and gy"); phase oversampling; saturation bands on tissue outside. Along the readout, sampling the ADC twice as fast (oversample 2, the default here) removes wrap at no cost in scan time.',
        build: function (box) {
            const fov = paramSlider('FOV', 'Field of view (FOV)', 'mm', 1000, 0.001);
            const crop = W().toggle({ label: 'Crop readout oversampling', checked: S().recon.cropOversampling !== false,
                hint: 'Untick to see the full 2× field of view the oversampled readout recorded',
                onChange: function (b) { A().setRecon({ cropOversampling: b }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(fov); box.appendChild(crop); box.appendChild(live);
            return {
                sync: function () {
                    fov.update();
                    crop.set(S().recon.cropOversampling !== false);
                    const p = program(), ph = currentPhantom(), ext = objectExtent(ph);
                    crop.setDisabled(!(p && p.image && p.image.oversample > 1));
                    if (!p || !p.image || !ext) { live.textContent = ''; return; }
                    const im = p.image, pa = phaseAxis(p);
                    const fovPe = pa === 'y' ? im.fovY : im.fovX, extPe = pa === 'y' ? ext.y : ext.x;
                    const fovRo = (pa === 'y' ? im.fovX : im.fovY) * (im.oversample || 1), extRo = pa === 'y' ? ext.x : ext.y;
                    let html = 'Object <b>' + fnum(extPe * 1e3) + ' mm</b> along phase (' + pa + '), FOV <b>' + fnum(fovPe * 1e3) + ' mm</b>: ' +
                        (extPe > fovPe + 1e-4 ? '<b>wraps</b>.' : 'fits.');
                    html += ' Readout records ' + fnum(fovRo * 1e3) + ' mm' + (im.oversample > 1 ? ' (oversampled ' + im.oversample + '×)' : '') + (extRo > fovRo + 1e-4 ? ': wraps too.' : '.');
                    const cn = compileNote();
                    live.innerHTML = cn ? '' : html;
                    if (cn) live.textContent = cn;
                    live.classList.toggle('is-warn', !!cn);
                }
            };
        },
        status: function () {
            const p = program(), ext = objectExtent(currentPhantom());
            if (!p || !p.image || !ext || p.image.readoutAxis === 'radial' || !p.image.readoutAxis) return null;
            const im = p.image, pa = phaseAxis(p);
            const fovPe = pa === 'y' ? im.fovY : im.fovX, extPe = pa === 'y' ? ext.y : ext.x;
            const fovRo = (pa === 'y' ? im.fovX : im.fovY) * (im.oversample || 1), extRo = pa === 'y' ? ext.x : ext.y;
            if (extPe > fovPe + 1e-4) return { kind: 'on', text: 'Wraps along ' + pa };
            if (extRo > fovRo + 1e-4) return { kind: 'on', text: 'Wraps along the readout' };
            return null;
        },
        demos: [{
            label: 'Show me',
            loads: 'T1-weighted gradient echo on the brain (200 mm front to back) with FOV 180 mm. The bright scalp fat makes the folded parts easy to see.',
            setup: { phantom: 'brain', preset: 'gre_t1', params: { FOV: 0.18 } }
        }]
    });

    /* ---------- Gibbs ringing ---------- */
    CARDS.push({
        id: 'gibbs', group: 'sampling', title: 'Gibbs ringing (truncation)', list: 'Gibbs ringing',
        see: 'Fine ripples running parallel to sharp edges (skull, CSF borders) that fade away from the edge. They are worst with coarse matrices.',
        why: 'A sharp edge contains every spatial frequency, but k-space stops at ±k<sub>max</sub>. Leaving the high frequencies out makes the edge overshoot by about 9 % of the step and ripple with a period of about two pixels, whatever the matrix.',
        kspace: 'At and beyond the edges of k-space, in what was never measured: the image is the true object convolved with the sinc-shaped transform of the rectangular k-space window.',
        fix: 'A larger matrix (the ripples get narrower and hug the edge), or a k-space filter (Hamming, Hann) that tapers the edge of k-space, at the cost of a little resolution.',
        build: function (box) {
            const N = paramSlider('N', 'Matrix N', 'px', 1, 32);
            const filt = W().select({ label: 'k-space filter (reconstruction)', value: S().recon.filter || 'none',
                options: [{ value: 'none', label: 'None' }, { value: 'hamming', label: 'Hamming' }, { value: 'hann', label: 'Hann' }, { value: 'tukey', label: 'Tukey' }, { value: 'fermi', label: 'Fermi' }],
                onChange: function (v) { A().setRecon({ filter: v }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(N); box.appendChild(filt); box.appendChild(live);
            return {
                sync: function () {
                    N.update();
                    filt.set(S().recon.filter || 'none');
                    const p = program();
                    if (p && p.image) {
                        const dy = p.image.fovY / p.image.ny * 1e3;
                        live.innerHTML = 'Pixel <b>' + fnum(dy) + ' mm</b>: ripples about <b>' + fnum(2 * dy, 2) + ' mm</b> apart.' +
                            (S().recon.zeroFill >= 2 ? ' Zero-fill ×2 is on: it shows the ripples smoothly but does not cause them.' : '');
                    } else live.textContent = '';
                }
            };
        },
        status: function () {
            const p = program(), f = S().recon.filter || 'none';
            if (p && p.image && f === 'none' && Math.min(p.image.nx, p.image.ny) <= 64) return { kind: 'present', text: 'Coarse matrix, no filter' };
            return null;
        },
        demos: [{
            label: 'Show me',
            loads: 'Shepp-Logan phantom, gradient echo at 64 × 64, body coil, zero-filled ×2 so the ripples are easy to see. Then try the Hamming filter or N = 128.',
            setup: { phantom: 'shepp', preset: 'gre_t1', coil: 'body', params: { N: 64 }, recon: { zeroFill: 2 } }
        }]
    });

    /* ---------- Chemical shift ---------- */
    CARDS.push({
        id: 'chem', group: 'offres', title: 'Chemical shift: fat displacement, in and out of phase', list: 'chemical shift',
        see: 'Displacement: fat is drawn shifted along the readout relative to water, with a bright band where they overlap and a dark gap on the other side. In and out of phase: in a gradient echo at TE ≈ 1.15, 3.45 or 5.75 ms every voxel holding both fat and water goes dark, outlining fat-water boundaries in black.',
        why: 'Fat protons are better shielded by their electrons and precess 3.4 ppm slower than water, about 434 Hz at 3 T. The readout gradient turns frequency into position, so fat lands 434 Hz / BW pixels away. In a gradient echo the two also drift apart in phase by 434 Hz × TE cycles: opposed at 1.15, 3.45, 5.75 ms, in phase at 2.3, 4.6 ms. A spin echo refocuses that phase at the echo.',
        eq: 'shift = 434 Hz / BW<sub>pixel</sub> pixels &nbsp;·&nbsp; phase = 434 Hz × TE cycles',
        kspace: 'Displacement: a phase ramp across each readout for the fat signal only (a shift in the image is a linear phase in k-space). Opposed phase: the fat and water contributions to every sample subtract.',
        fix: 'A higher bandwidth (smaller shift, more noise), fat suppression (fat saturation, STIR, water excitation), an in-phase TE such as 4.6 ms, or Dixon methods that use both phases to separate fat from water. In EPI the shift is along the phase-encode direction and huge, which is why EPI always uses fat suppression.',
        build: function (box) {
            const bw = paramSlider('BW', 'Readout bandwidth', 'Hz/px', 1, 10);
            const teRow = el('div', { class: 'stack stack-sm' });
            const teLabel = el('span', { class: 'ctl-label', text: 'Gradient-echo TE' });
            const b1 = W().button({ label: '3.45 ms (opposed)', size: 'sm', onClick: function () { A().setParam('TE', 0.00345); } });
            const b2 = W().button({ label: '4.6 ms (in phase)', size: 'sm', onClick: function () { A().setParam('TE', 0.0046); } });
            teRow.appendChild(teLabel);
            teRow.appendChild(el('div', { class: 'row', role: 'group', 'aria-label': 'Set the echo time' }, [b1, b2]));
            const live = el('p', { class: 'af-live' });
            box.appendChild(bw); box.appendChild(teRow); box.appendChild(live);
            return {
                sync: function () {
                    bw.update();
                    const p = program(), te = param('TE');
                    const gre = isGradientEcho(p);
                    const canTE = gre && hasRange(te) && te.min <= 0.00345 && te.max >= 0.0046;
                    b1.disabled = b2.disabled = !canTE;
                    const parts = [];
                    if (p && p.image) {
                        const shift = FAT_HZ / p.image.bwPerPixel, px = (p.image.readoutAxis === 'y' ? p.image.fovY / p.image.ny : p.image.fovX / p.image.nx) * 1e3;
                        parts.push('Fat shift along the readout: <b>' + fnum(shift) + ' px = ' + fnum(shift * px) + ' mm</b>.');
                        const acq = S().acq;
                        if (acq && acq.stats && acq.stats.fatShiftPx && Math.abs(acq.stats.fatShiftPx.phase || 0) >= 1) {
                            parts.push('Along phase (EPI): <b>' + fnum(Math.abs(acq.stats.fatShiftPx.phase)) + ' px</b>.');
                        }
                        const TE = p.stats && isFinite(p.stats.TE) ? p.stats.TE : (te ? te.value : NaN);
                        if (gre && isFinite(TE)) {
                            const cyc = FAT_HZ * TE, f = cyc - Math.floor(cyc);
                            const word = Math.abs(f - 0.5) < 0.15 ? 'opposed' : (f < 0.15 || f > 0.85 ? 'in phase' : 'partly opposed');
                            parts.push('At TE ' + fnum(TE * 1e3) + ' ms: 434 Hz × TE = <b>' + cyc.toFixed(2) + ' cycles, ' + word + '</b>.');
                        } else if (p) parts.push('Spin echo: fat and water are back in phase at the echo.');
                    }
                    if (!canTE) parts.push('<span class="muted">The TE buttons need a gradient echo whose TE range includes 3.45 and 4.6 ms (gre_t1, or Show me below).</span>');
                    const cn = compileNote();
                    live.innerHTML = parts.join(' ');
                    if (cn) { live.textContent = cn; }
                    live.classList.toggle('is-warn', !!cn);
                }
            };
        },
        status: function () {
            const p = program(), ph = currentPhantom();
            if (!p || !p.image || !hasFat(ph)) return null;
            const shift = FAT_HZ / p.image.bwPerPixel;
            const acq = S().acq;
            const pe = acq && acq.program === S().lastGoodProgram && acq.stats && acq.stats.fatShiftPx ? Math.abs(acq.stats.fatShiftPx.phase || 0) : 0;
            const TE = p.stats && isFinite(p.stats.TE) ? p.stats.TE : NaN;
            if (isGradientEcho(p) && isFinite(TE)) {
                const f = FAT_HZ * TE - Math.floor(FAT_HZ * TE);
                if (Math.abs(f - 0.5) < 0.15) return { kind: 'present', text: 'Opposed phase' };
            }
            if (pe >= 2) return { kind: 'present', text: 'Fat shift ' + fnum(pe, 2) + ' px (phase)' };
            if (shift >= 2) return { kind: 'present', text: 'Fat shift ' + fnum(shift, 2) + ' px' };
            return null;
        },
        demos: [{
            label: 'Show me: displacement',
            loads: 'The water-and-fat phantom, spin echo at 50 Hz/px (fat moves 8.7 pixels along x), body coil.',
            setup: { phantom: 'waterfat', preset: 'se', coil: 'body', params: { BW: 50 } }
        }, {
            label: 'Opposed phase',
            loads: 'The water-and-fat phantom, T1-weighted gradient echo at TE 3.45 ms (fat and water opposed), body coil. Then press 4.6 ms (in phase) above.',
            setup: { phantom: 'waterfat', preset: 'gre_t1', coil: 'body', params: { TE: 0.00345 } }
        }]
    });

    /* ---------- B0 inhomogeneity and susceptibility ---------- */
    CARDS.push({
        id: 'b0', group: 'offres', title: 'B0 inhomogeneity and susceptibility', list: 'susceptibility, distortion',
        see: 'Next to air (the frontal sinus, the ear canals) gradient-echo images lose signal, a dropout that grows with TE; EPI images are also stretched or squashed there along the phase-encode direction. A spin echo of the same slice looks normal.',
        why: 'Air and tissue are magnetised differently, so near the sinus the field is off by up to about 120 Hz. Spins within one voxel then precess at different rates and dephase during TE; the 180° pulse of a spin echo reverses that dephasing, so at the echo it is gone. Off-resonance also moves signal: Δf / BW pixels along the readout, and Δf × N × ESP pixels along phase in EPI, where the bandwidth per pixel along phase is only about 20 Hz.',
        kspace: 'In time order rather than in one place: the off-resonance phase 2π Δf t grows with the time since excitation, so it acts along each readout and, in EPI, from line to line across k-space.',
        fix: 'Shorter TE and thinner slices, spin echo instead of gradient echo, higher bandwidth, shimming (it removes smooth fields, not the sinus field), shorter echo spacing or parallel imaging in EPI, and field-map based correction.',
        simpl: 'Simplification: the object is a 2D slice, but a real susceptibility field also varies through the slice. The engine multiplies each point by sinc(G<sub>z</sub>·Δz·τ), taking G<sub>z</sub> as the in-plane field gradient there, so gradient-echo dropout grows with TE and slice thickness while spin echoes (τ = 0 at the echo) are immune.',
        build: function (box) {
            const sus = W().slider({ label: 'Susceptibility field', unit: '× phantom', min: 0, max: 3, step: 0.1, value: 1,
                hint: 'Scales the phantom\'s own susceptibility field (sinus, ears); 0 removes it',
                onInput: function (v) { A().setArtifacts({ b0: { susceptibility: v } }); } });
            const shim = W().slider({ label: 'Unshimmed residual field', unit: '×', min: 0, max: 1, step: 0.05, value: 0,
                hint: 'The smooth field a freshly positioned patient brings before shimming (1 = none of it shimmed away)',
                onInput: function (v) { A().setArtifacts({ b0: { shim: v } }); } });
            const open = W().button({ label: 'Open the Shim panel', size: 'sm', title: 'Shim by hand or auto-shim in the Spectroscopy tab',
                onClick: function () { MRI.bus.emit('shim:open', {}); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(sus); box.appendChild(shim);
            box.appendChild(el('div', { class: 'row' }, [open]));
            box.appendChild(live);
            return {
                sync: function () {
                    const b0 = S().artifacts.b0 || {}, c = b0.shimCoeffs || {};
                    sus.set(isFinite(b0.susceptibility) ? b0.susceptibility : 1);
                    shim.set(b0.shim || 0);
                    const anyShim = Object.keys(c).some(function (k) { return +c[k]; });
                    const p = program(), acq = S().acq;
                    const parts = [];
                    if (p && p.image) parts.push('120 Hz moves signal <b>' + fnum(120 / p.image.bwPerPixel, 2) + ' px</b> along the readout' +
                        (acq && acq.stats && acq.stats.peBandwidthPerPixel ? ' and <b>' + fnum(120 / acq.stats.peBandwidthPerPixel, 2) + ' px</b> along phase (EPI, ' + fnum(acq.stats.peBandwidthPerPixel, 3) + ' Hz/px)' : '') + '.');
                    if (anyShim) parts.push('Shim currents from the Shim panel are applied.');
                    live.innerHTML = parts.join(' ');
                }
            };
        },
        status: function () {
            const b0 = S().artifacts.b0 || {}, c = b0.shimCoeffs || {};
            const anyShim = Object.keys(c).some(function (k) { return +c[k]; });
            if ((isFinite(b0.susceptibility) && b0.susceptibility !== 1) || b0.shim || anyShim) return { kind: 'on', text: 'Field changed' };
            return null;
        },
        demos: [{
            label: 'Show me: gradient echo',
            loads: 'T2*-weighted gradient echo on the brain, TE 40 ms, susceptibility field ×2: dropout at the frontal sinus and the ears.',
            setup: { phantom: 'brain', preset: 'gre_t2s', params: { TE: 0.04 }, artifacts: { b0: { susceptibility: 2 } } }
        }, {
            label: 'Spin echo',
            loads: 'The same field and TE 40 ms with a spin echo: the 180° pulse refocuses it and the frontal lobe is back.',
            setup: { phantom: 'brain', preset: 'se', params: { TE: 0.04 }, artifacts: { b0: { susceptibility: 2 } } }
        }, {
            label: 'EPI distortion',
            loads: 'Gradient-echo EPI on the brain with a fat-saturation pulse added (as clinical EPI has): the frontal lobe is pulled out of shape along y, where the bandwidth per pixel is 19.5 Hz.',
            setup: { phantom: 'brain', preset: 'epi', edits: [EDIT.fatSat] }
        }]
    });

    /* ---------- Motion ---------- */
    CARDS.push({
        id: 'motion', group: 'motion', title: 'Motion', list: 'motion',
        see: 'Copies (ghosts) of the moving structure repeated along the phase-encode direction, or a smear along it, whichever way the head actually moved.',
        why: 'One readout takes a few milliseconds, so the object is frozen within a line, but successive lines are a TR apart. Motion between lines gives every line a slightly different phase or amplitude: a modulation of k-space along k<sub>y</sub>. Periodic motion of period T puts ghosts N·TR/T pixels apart (folded back into the FOV).',
        kspace: 'Along the phase-encode axis: line-to-line inconsistency. A sudden move splits k-space into a part from one position and a part from another.',
        fix: 'Immobilise and coach the patient, faster or single-shot sequences, respiratory or cardiac gating, navigator echoes, radial or PROPELLER sampling (which re-measure the centre, so motion blurs instead of ghosting), and swapping the phase direction to move ghosts off the region of interest.',
        build: function (box) {
            const st = S();
            let ampTrans = 0.004, ampNod = 3 / DEG;     // remembered per kind family
            const on = W().toggle({ label: 'Motion on', checked: !!st.artifacts.motion.on,
                onChange: function (b) { A().setArtifacts({ motion: { on: b } }); } });
            const kind = W().select({ label: 'Kind of motion', value: st.artifacts.motion.kind,
                options: [{ value: 'periodic', label: 'Periodic (like breathing)' }, { value: 'sudden', label: 'Sudden step' },
                    { value: 'random', label: 'Random jitter' }, { value: 'nod', label: 'Nodding (rotation)' }],
                onChange: function (v) {
                    const m = S().artifacts.motion, wasNod = m.kind === 'nod', isNod = v === 'nod';
                    if (wasNod) ampNod = m.amp; else ampTrans = m.amp;
                    const patch = { kind: v };
                    if (wasNod !== isNod) patch.amp = isNod ? ampNod : ampTrans;
                    A().setArtifacts({ motion: patch });
                } });
            const ampMm = W().slider({ label: 'Amplitude', unit: 'mm', scale: 1000, min: 0, max: 0.01, step: 0.0005, value: 0.004,
                onInput: function (v) { ampTrans = v; A().setArtifacts({ motion: { amp: v } }); } });
            const ampDeg = W().slider({ label: 'Amplitude', unit: '°', scale: DEG, min: 0, max: 10 / DEG, step: 0.5 / DEG, value: 3 / DEG,
                onInput: function (v) { ampNod = v; A().setArtifacts({ motion: { amp: v } }); } });
            const period = W().slider({ label: 'Period', unit: 's', min: 0.5, max: 10, step: 0.1, value: 4,
                onInput: function (v) { A().setArtifacts({ motion: { period: v } }); } });
            const at = W().slider({ label: 'Moves at', unit: '% of scan', scale: 100, min: 0, max: 1, step: 0.01, value: 0.5,
                onInput: function (v) { A().setArtifacts({ motion: { at: v } }); } });
            const axis = W().segmented({ label: 'Direction of motion', size: 'sm', value: st.artifacts.motion.axis,
                options: [{ value: 'x', label: 'Left-right (x)' }, { value: 'y', label: 'Front-back (y)' }],
                onChange: function (v) { A().setArtifacts({ motion: { axis: v } }); } });
            const live = el('p', { class: 'af-live' });
            [on, kind, ampMm, ampDeg, period, at, axis, live].forEach(function (n) { box.appendChild(n); });
            return {
                sync: function () {
                    const m = S().artifacts.motion, isNod = m.kind === 'nod';
                    on.set(!!m.on); kind.set(m.kind);
                    ampMm.hidden = isNod; ampDeg.hidden = !isNod;
                    if (isNod) ampDeg.set(m.amp); else ampMm.set(m.amp);
                    period.set(m.period); at.set(m.at); axis.set(m.axis === 'x' ? 'x' : 'y');
                    period.hidden = !(m.kind === 'periodic' || isNod);
                    at.hidden = m.kind !== 'sudden';
                    axis.hidden = isNod;
                    [kind, ampMm, ampDeg, period, at].forEach(function (c) { c.setDisabled(!m.on); });
                    axis.setDisabled(!m.on);
                    const p = program();
                    let html = '';
                    if (p && p.image && (m.kind === 'periodic' || isNod)) {
                        const npp = readoutsPerPeriod(p), TR = p.stats && p.stats.TR;
                        const ny = phaseAxis(p) === 'y' ? p.image.ny : p.image.nx;
                        if (npp === 1 && TR > 0 && m.period > 0) {
                            const f = TR / m.period - Math.floor(TR / m.period), sp = ny * Math.min(f, 1 - f);
                            html = sp < 0.5 ? 'TR is a whole number of motion periods: every line catches the head in the same place, so this timing hides the motion.'
                                : 'TR ' + fnum(TR * 1e3) + ' ms, period ' + fnum(m.period) + ' s: ghosts about <b>' + fnum(sp, 2) + ' px</b> apart along ' + phaseAxis(p) + ' (N·TR/T, folded into the FOV).';
                        } else if (npp > 1) html = 'This sequence records ' + npp + ' lines per TR, so the ghost pattern follows its own k-space order.';
                    } else if (m.kind === 'sudden') html = 'Lines before and after the move disagree: edges double and smear along phase.';
                    else if (m.kind === 'random') html = 'A different position for every line: a smear along phase rather than distinct ghosts.';
                    live.innerHTML = html;
                }
            };
        },
        status: function () {
            const m = S().artifacts.motion;
            if (!m.on || !m.amp) return null;
            const label = { periodic: 'Periodic', sudden: 'Sudden', random: 'Random', nod: 'Nodding' }[m.kind] || 'On';
            return { kind: 'on', text: label + ', ' + (m.kind === 'nod' ? fnum(m.amp * DEG, 2) + '°' : fnum(m.amp * 1e3, 2) + ' mm') };
        },
        demos: [{
            label: 'Show me',
            loads: 'Spin echo on the brain (TR 3 s) with periodic motion of 4 mm front to back every 4 s, like breathing: ghosts 32 pixels apart along y.',
            setup: { phantom: 'brain', preset: 'se', artifacts: { motion: { on: true, kind: 'periodic', amp: 0.004, period: 4, axis: 'y' } } }
        }]
    });

    /* ---------- Pulsatile flow ---------- */
    CARDS.push({
        id: 'flow', group: 'motion', title: 'Pulsatile flow', list: 'flow',
        see: 'A row of copies of a blood vessel (here the superior sagittal sinus) along the phase-encode direction, while the rest of the brain is clean.',
        why: 'Blood signal follows the cardiac cycle: inflow changes its magnitude and velocity along the gradients adds a phase. The heart rate has nothing to do with TR, so each phase-encode line catches the blood at a different moment: periodic motion, but confined to the vessel.',
        kspace: 'Along k<sub>y</sub>: the vessel\'s share of every line is modulated in magnitude and phase with the cardiac period, so the ghosts sit N·TR/T<sub>cardiac</sub> pixels apart (folded into the FOV).',
        fix: 'Cardiac gating (each line at the same moment of the cycle), flow compensation (gradient moment nulling), saturation bands upstream, and swapping the phase direction to move the ghosts off the anatomy.',
        simpl: 'Simplification: blood is treated as stationary tissue here: there is no flow void on spin echo (on a real scanner fast blood leaves the slice between the 90° and the 180° and the sinus looks dark) and no inflow enhancement on gradient echo. Only its pulsation is modelled: the vessel\'s signal is modulated as (1 + depth·sin 2πt/T)·e<sup>i·phase·sin 2πt/T</sup>. Real flow also displaces and blurs the vessel itself.',
        build: function (box) {
            const st = S();
            const on = W().toggle({ label: 'Pulsatile flow on', checked: !!st.artifacts.flow.on,
                onChange: function (b) { A().setArtifacts({ flow: { on: b } }); } });
            const depth = W().slider({ label: 'Signal modulation', unit: '%', scale: 100, min: 0, max: 1, step: 0.05, value: 0.6,
                onInput: function (v) { A().setArtifacts({ flow: { depth: v } }); } });
            const period = W().slider({ label: 'Cardiac period', unit: 's', min: 0.4, max: 2, step: 0.05, value: 0.9,
                onInput: function (v) { A().setArtifacts({ flow: { period: v } }); } });
            const phase = W().slider({ label: 'Velocity phase', unit: 'rad', min: 0, max: 3.1, step: 0.05, value: 1.5,
                hint: 'Peak phase that the moving blood picks up from the gradients',
                onInput: function (v) { A().setArtifacts({ flow: { phase: v } }); } });
            const live = el('p', { class: 'af-live' });
            [on, depth, period, phase, live].forEach(function (n) { box.appendChild(n); });
            return {
                sync: function () {
                    const f = S().artifacts.flow, ph = currentPhantom();
                    on.set(!!f.on); depth.set(f.depth); period.set(f.period); phase.set(f.phase);
                    [depth, period, phase].forEach(function (c) { c.setDisabled(!f.on); });
                    const vessels = !!(ph && ph.tissues && ph.tissues.some(function (t) { return t && t.pulsatile; }));
                    const p = program();
                    let html = 'Heart rate <b>' + fnum(60 / f.period, 3) + ' beats/min</b>.';
                    if (p && p.image && readoutsPerPeriod(p) === 1 && p.stats && p.stats.TR > 0) {
                        const r = p.stats.TR / f.period, fr = r - Math.floor(r), ny = phaseAxis(p) === 'y' ? p.image.ny : p.image.nx;
                        html += ' First ghosts about <b>' + fnum(ny * Math.min(fr, 1 - fr), 2) + ' px</b> from the vessel along ' + phaseAxis(p) + '.';
                    }
                    if (!vessels) html += ' <span class="warn">This phantom has no blood vessels: use the brain.</span>';
                    live.innerHTML = html;
                }
            };
        },
        status: function () { return S().artifacts.flow.on ? { kind: 'on', text: 'On' } : null; },
        demos: [{
            label: 'Show me',
            loads: 'T1-weighted gradient echo on the brain after 0.5 mM gadolinium (the sinus enhances and is bright), pulsatile flow with 80 % modulation: a string of sinus ghosts along y.',
            setup: { phantom: 'brain', phantomOpts: { gad: 0.5 }, preset: 'gre_t1', artifacts: { flow: { on: true, depth: 0.8, phase: 2.5 } } }
        }]
    });

    /* ---------- EPI Nyquist ghost ---------- */
    CARDS.push({
        id: 'ghost', group: 'hardware', title: 'EPI Nyquist (N/2) ghost', list: 'Nyquist ghost',
        see: 'A faint copy of the object shifted by half the field of view along the phase-encode direction, overlapping the background and the object itself.',
        why: 'EPI reads every other line with the readout gradient reversed. If the real gradient lags the nominal one by a few microseconds (amplifier delay, eddy currents), the echoes of odd lines move one way along k<sub>x</sub> and those of even lines the other way. A pattern that repeats every 2 lines puts part of the image FOV/2 away.',
        kspace: 'In the odd-even alternation: a shift of the echo along k<sub>x</sub> that flips sign from one line to the next.',
        fix: 'Reference (navigator) echoes that measure the odd-even phase difference and remove it (the Image tab\'s EPI ghost correction estimates it from the data), careful gradient timing calibration and eddy-current compensation.',
        build: function (box) {
            const d = W().slider({ label: 'Gradient delay', unit: 'µs', scale: 1e6, min: 0, max: 1e-5, step: 2.5e-7, value: 0,
                hint: 'How far the real gradients lag behind the nominal ones',
                onInput: function (v) { A().setArtifacts({ gradDelay: v }); } });
            const corr = W().toggle({ label: 'EPI ghost correction (reconstruction)', checked: !!S().recon.epiGhostCorr,
                onChange: function (b) { A().setRecon({ epiGhostCorr: b }); } });
            const live = el('p', { class: 'af-live' });
            box.appendChild(d); box.appendChild(corr); box.appendChild(live);
            return {
                sync: function () {
                    d.set(S().artifacts.gradDelay || 0);
                    corr.set(!!S().recon.epiGhostCorr);
                    const epi = hasBipolarReadouts(program());
                    live.innerHTML = epi ? 'Alternating readouts: a delay makes the N/2 ghost.'
                        : 'With every readout in the same direction a delay shifts all lines alike: a phase ramp across the image, invisible in the magnitude. Load EPI (Show me).';
                }
            };
        },
        status: function () {
            const d = S().artifacts.gradDelay || 0;
            return d ? { kind: 'on', text: 'Delay ' + fnum(d * 1e6, 2) + ' µs' } : null;
        },
        demos: [{
            label: 'Show me',
            loads: 'Gradient-echo EPI on the brain with fat saturation added, and a 3 µs gradient delay. Then switch on EPI ghost correction above.',
            setup: { phantom: 'brain', preset: 'epi', edits: [EDIT.fatSat], artifacts: { gradDelay: 3e-6 } }
        }]
    });

    /* ---------- RF spike ---------- */
    CARDS.push({
        id: 'spike', group: 'hardware', title: 'RF spike (herringbone)', list: 'spike',
        see: 'Fine parallel stripes over the whole image, at an angle and spacing set by where the spike landed in k-space.',
        why: 'A brief electrical discharge (static from clothing, a loose connection, a failing component) corrupts a sample. One wrong point in k-space is a single spatial frequency, and its transform is a stripe pattern across the entire image.',
        kspace: 'In one very bright point, easy to spot in the log-magnitude k-space (k-space tab); its distance from the centre sets the stripe spacing, its direction the stripe angle.',
        fix: 'Find and remove the source (static, loose connector, the service engineer). In the data: detect the outlier sample, replace it by its neighbours, and reconstruct again.',
        build: function (box) {
            const on = W().toggle({ label: 'Spike on', checked: !!S().artifacts.spike.on, onChange: function (b) { A().setArtifacts({ spike: { on: b } }); } });
            const amp = W().slider({ label: 'Spike size', unit: '× k-centre', min: 0.5, max: 20, step: 0.5, value: 4,
                hint: 'Size of the corrupt sample relative to the signal at the centre of k-space',
                onInput: function (v) { A().setArtifacts({ spike: { amp: v } }); } });
            const at = W().slider({ label: 'When', unit: '% of scan', scale: 100, min: 0, max: 1, step: 0.01, value: 0.37,
                hint: 'The moment of the spike; with line-by-line sequences this picks the k-space line',
                onInput: function (v) { A().setArtifacts({ spike: { at: v } }); } });
            const live = el('p', { class: 'af-live' });
            [on, amp, at, live].forEach(function (n) { box.appendChild(n); });
            return {
                sync: function () {
                    const s = S().artifacts.spike;
                    on.set(!!s.on); amp.set(s.amp); at.set(s.at);
                    amp.setDisabled(!s.on); at.setDisabled(!s.on);
                    const acq = S().acq, sp = acq && acq.stats && acq.stats.spike;
                    live.innerHTML = s.on && sp ? 'In the last scan: readout <b>' + (sp.readout + 1) + '</b> of ' + acq.readouts.length + ', sample ' + (sp.sample + 1) + '. Closer to the middle of the scan means closer to the centre of k-space for a line-by-line sequence: broader stripes.' : '';
                }
            };
        },
        status: function () { return S().artifacts.spike.on ? { kind: 'on', text: 'On' } : null; },
        demos: [{
            label: 'Show me',
            loads: 'Spin echo on the brain with one corrupt sample four times the k-space centre, 37 % of the way through the scan.',
            setup: { phantom: 'brain', preset: 'se', artifacts: { spike: { on: true, amp: 4, at: 0.37 } } }
        }]
    });

    /* ---------- Zipper ---------- */
    CARDS.push({
        id: 'zipper', group: 'hardware', title: 'Zipper (RF interference)', list: 'zipper',
        see: 'A line of noise ("zipper") running along the phase-encode direction at one fixed position along the readout.',
        why: 'A continuous radio signal near 127.7 MHz leaks into the receiver (the RF cage door left open, an electronic device brought into the room). It has one frequency, so the readout puts it at one position, offset / BW pixels from the centre. Its phase has nothing to do with the excitation and changes randomly from line to line, which smears it along phase.',
        kspace: 'In every sample: a constant tone along each readout, with a random phase from line to line.',
        fix: 'Close the door, remove the device, or find the leak in the RF shielding. The zipper\'s position gives the interfering frequency, which helps identify the source.',
        build: function (box) {
            const on = W().toggle({ label: 'Interference on', checked: !!S().artifacts.zipper.on, onChange: function (b) { A().setArtifacts({ zipper: { on: b } }); } });
            const off = W().slider({ label: 'Frequency offset from 127.73 MHz', unit: 'Hz', min: -20000, max: 20000, step: 100, value: 3000,
                onInput: function (v) { A().setArtifacts({ zipper: { offsetHz: v } }); } });
            const amp = W().slider({ label: 'Strength', unit: '% of k-centre', scale: 100, min: 0, max: 0.01, step: 0.0005, value: 0.002,
                onInput: function (v) { A().setArtifacts({ zipper: { amp: v } }); } });
            const live = el('p', { class: 'af-live' });
            [on, off, amp, live].forEach(function (n) { box.appendChild(n); });
            return {
                sync: function () {
                    const z = S().artifacts.zipper, p = program();
                    on.set(!!z.on); off.set(z.offsetHz); amp.set(z.amp);
                    off.setDisabled(!z.on); amp.setDisabled(!z.on);
                    if (p && p.image) {
                        const px = z.offsetHz / p.image.bwPerPixel, nro = p.image.readoutAxis === 'y' ? p.image.ny : p.image.nx;
                        live.innerHTML = 'Sits <b>' + fnum(Math.abs(px), 3) + ' px</b> from the centre along the readout (' + fnum(z.offsetHz, 4) + ' Hz ÷ ' + fnum(p.image.bwPerPixel, 4) + ' Hz/px)' +
                            (Math.abs(px) > nro / 2 ? ': outside the displayed FOV (it is in the cropped oversampled part, or folds back).' : '.');
                    } else live.textContent = '';
                }
            };
        },
        status: function () { return S().artifacts.zipper.on ? { kind: 'on', text: 'On' } : null; },
        demos: [{
            label: 'Show me',
            loads: 'Spin echo on the brain (150 Hz/px) with interference 3 kHz above the Larmor frequency: a zipper 20 pixels from the centre.',
            setup: { phantom: 'brain', preset: 'se', artifacts: { zipper: { on: true, offsetHz: 3000, amp: 0.002 } } }
        }]
    });

    /* ---------- Partial Fourier and undersampling ---------- */
    CARDS.push({
        id: 'under', group: 'recon', title: 'Partial Fourier and undersampling', list: 'partial Fourier, SENSE',
        see: 'Partial Fourier filled with zeros: blurring (and some ringing) along the phase direction. Undersampling by R without parallel imaging: the image folds over itself R times along phase. SENSE unfolds it, with more noise where the coils cannot tell the folded pixels apart.',
        why: 'Skipping lines saves time. A real object has conjugate-symmetric k-space, S(−k) = S*(k), so about half of it determines the rest if the image phase is smooth (partial Fourier). Recording every R-th line makes Δk R times larger, so the FOV shrinks R times (aliasing); several coils that see the folded pixels differently let SENSE solve for them.',
        eq: 'SNR<sub>SENSE</sub> = SNR<sub>full</sub> / (g · √R)',
        kspace: 'In the missing lines: one side of k<sub>y</sub> (partial Fourier) or every other line (R = 2).',
        fix: 'Homodyne (or POCS) reconstruction for partial Fourier; SENSE or GRAPPA for undersampling, with coils spread along the phase direction and a modest R (2 or 3 with this head coil).',
        build: function (box) {
            const pf = W().segmented({ label: 'Partial Fourier fill', size: 'sm', value: S().recon.partialFourier || 'homodyne',
                options: [{ value: 'zero', label: 'Zero' }, { value: 'conjugate', label: 'Conjugate' }, { value: 'homodyne', label: 'Homodyne' }],
                onChange: function (v) { A().setRecon({ partialFourier: v }); } });
            const par = W().segmented({ label: 'Parallel imaging', size: 'sm', value: S().recon.parallel || 'sense',
                options: [{ value: 'none', label: 'None' }, { value: 'sense', label: 'SENSE' }],
                onChange: function (v) { A().setRecon({ parallel: v }); } });
            const live = el('p', { class: 'af-live' });
            [pf, par, live].forEach(function (n) { box.appendChild(n); });
            return {
                sync: function () {
                    const st = S(), info = st.reconResult && st.reconResult.info || {};
                    pf.set(st.recon.partialFourier || 'homodyne');
                    par.set(st.recon.parallel || 'sense');
                    const parts = [];
                    if (info.partialFourier < 1) parts.push('This scan recorded <b>' + fnum(100 * info.partialFourier, 3) + ' %</b> of the phase-encode lines.');
                    if (info.undersampling > 1) parts.push('This scan recorded every <b>' + info.undersampling + (info.undersampling === 2 ? 'nd' : info.undersampling === 3 ? 'rd' : 'th') + '</b> line (R = ' + info.undersampling + ').' + (st.reconResult.gfactor ? ' The g-factor map is in the Image tab.' : ''));
                    if (!parts.length) parts.push('This scan has all its lines, so these settings have nothing to do. Use a Show me button.');
                    live.innerHTML = parts.join(' ');
                }
            };
        },
        status: function () {
            const info = S().reconResult && S().reconResult.info;
            if (!info) return null;
            if (info.undersampling > 1) return { kind: 'on', text: 'R = ' + info.undersampling + (S().reconResult.gfactor ? ', SENSE' : ', folded') };
            if (info.partialFourier < 1) return { kind: 'on', text: 'Partial Fourier ' + fnum(100 * info.partialFourier, 3) + ' %' };
            return null;
        },
        demos: [{
            label: 'Show me: partial Fourier',
            loads: 'Gradient echo recording 5/8 of k-space (gre_pf), missing lines left at zero: blurred along y. Then choose Homodyne above.',
            setup: { phantom: 'brain', preset: 'gre_pf', recon: { partialFourier: 'zero' } }
        }, {
            label: 'Undersampling R = 2',
            loads: 'Gradient echo with every other line (gre_r2), parallel imaging off: the head folds. Then choose SENSE above.',
            setup: { phantom: 'brain', preset: 'gre_r2', recon: { parallel: 'none' } }
        }]
    });

    /* ---------- Echo-train blurring ---------- */
    CARDS.push({
        id: 'train', group: 'recon', title: 'T2 blurring in TSE, T2* blurring in EPI', list: 'echo-train blurring',
        see: 'In a turbo spin echo with a long echo train, tissues with short T2 are smeared along the phase-encode direction while long-T2 fluid stays sharp. EPI does the same with T2*.',
        why: 'In an echo train each phase-encode line is recorded at a different time after the excitation, and the signal decays in between, by exp(−t/T2) for spin echoes or exp(−t/T2*) in gradient-echo EPI. k-space is multiplied by a decaying weight: a low-pass filter whose strength depends on each tissue\'s T2. The blur is of the order of the echo-train duration ÷ (π·T2) pixels, the same arithmetic as a spectral linewidth 1/(πT2) over the bandwidth per pixel along phase.',
        kspace: 'Along k<sub>y</sub>, in time order: the k-space tab\'s "Time since excitation" overlay shows the bands of each echo.',
        fix: 'Shorter echo trains or echo spacing, more shots, parallel imaging (fewer lines per train). In gradient-echo EPI the k-space centre must come at TE, at least half a train after the excitation, so tissue with T2* short enough to blur badly is also dark.',
        build: function (box) {
            const etl = paramSlider('ETL', 'Echo train length ETL', 'echoes', 1, 4);
            const esp = paramSlider('ESP', 'Echo spacing ESP', 'ms', 1000, 0.0001);
            const live = el('p', { class: 'af-live' });
            const plotHost = el('div', { class: 'af-psf' });
            const plot = W().plot(plotHost, { height: 170, xlabel: 'position along phase encode (pixels)', ylabel: 'PSF', title: 'Point-spread function along phase, per tissue' });
            plot.canvas.setAttribute('aria-label', 'Point-spread function along the phase-encode direction for several tissues, computed from the last scan\'s echo times');
            [etl, esp, live, plotHost].forEach(function (n) { box.appendChild(n); });
            let lastKey = null;
            return {
                sync: function (force) {
                    etl.update(); esp.update();
                    const acq = S().acq;
                    if (!force && acq === lastKey && lastKey !== null) return;
                    lastKey = acq;
                    const res = psfFor(acq);
                    if (!res.ok) { live.innerHTML = res.message; plotHost.hidden = true; return; }
                    plotHost.hidden = false;
                    live.innerHTML = res.message;
                    plot.draw(res.series, { xlim: [-6, 6], ylim: [0, 1.05], legend: true });
                },
                redraw: function () { if (!plotHost.hidden) plot.redraw(); }
            };
        },
        status: function () {
            const p = program();
            const n = readoutsPerPeriod(p);
            if (n > 1 && p && p.image && p.image.readoutAxis !== 'radial') return { kind: 'present', text: n + ' echoes per excitation' };
            return null;
        },
        demos: [{
            label: 'Show me: ETL 32',
            loads: 'Turbo spin echo on the brain with the echoes reordered centre-out (first echo at the k-space centre, TEeff 10 ms), ETL 32, ESP 10 ms: the late echoes fill the edges of k-space.',
            setup: { phantom: 'brain', preset: 'tse', edits: [EDIT.centreOut], params: { ETL: 32, ESP: 0.01 } }
        }, {
            label: 'Compare: ETL 4',
            loads: function () { return 'The same centre-out turbo spin echo with ETL 4: ' + etlCompareText() + ', and much less blurring.'; },
            setup: { phantom: 'brain', preset: 'tse', edits: [EDIT.centreOut], params: { ETL: 4, ESP: 0.01 } }
        }]
    });

    /* The scan-time ratio of the two echo-train demonstrations, read from the
       two compiled sequences (dummy repetitions included), so the text says
       what the scan bar will show. */
    let etlCompare = null;
    function etlCompareText() {
        if (etlCompare) return etlCompare;
        let txt = 'about seven times the scan time (32 shots instead of 4, plus a dummy repetition each)';
        try {
            const pr = MRI.presets.get('tse');
            const src = EDIT.centreOut(pr.source);
            const a = MRI.dsl.compile(src, { overrides: { ETL: 32, ESP: 0.01 } }), b = MRI.dsl.compile(src, { overrides: { ETL: 4, ESP: 0.01 } });
            if (a.ok && b.ok && a.scanTime > 0 && b.scanTime > 0) {
                const dum = (a.image && a.image.dummies) || 0;
                const shots = function (p) { return (p.periods || []).filter(function (q) { return !q.dummy; }).length; };
                txt = 'about ' + U.fmtNum(b.scanTime / a.scanTime, 2) + ' times the scan time (' + U.fmtTime(b.scanTime) + ' against ' + U.fmtTime(a.scanTime) +
                    ': ' + shots(b) + ' shots instead of ' + shots(a) + (dum ? ', plus ' + dum + ' dummy repetition' + (dum > 1 ? 's' : '') + ' each' : '') + ')';
            }
        } catch (e) { /* keep the round number */ }
        return (etlCompare = txt);
    }

    /* Point-spread functions along phase from the last scan's echo times.
       The weight of every phase-encode line is the decay its tissue has
       suffered at that line's time since excitation; the PSF is the
       magnitude of the transform of those weights. */
    function psfFor(acq) {
        if (!acq || !acq.readouts || !acq.readouts.length) return { ok: false, message: 'Run a scan first.' };
        const g = acq.grid, p = acq.program;
        if (g.readoutAxis !== 'x' && g.readoutAxis !== 'y') return { ok: false, message: 'Non-Cartesian scan: no phase-encode direction to blur along.' };
        const peKey = g.readoutAxis === 'x' ? 'ky' : 'kx';
        const nPe = g.readoutAxis === 'x' ? g.ny : g.nx, fovPe = g.readoutAxis === 'x' ? g.fovY : g.fovX;
        const dk = 1 / fovPe, h = Math.floor(nPe / 2);
        const sum = new Float64Array(nPe), cnt = new Float64Array(nPe);
        const perExc = new Map();
        let echoes = 0;
        acq.readouts.forEach(function (r) {
            const k = r[peKey][r.n >> 1], i = Math.round(k / dk) + h;
            if (i >= 0 && i < nPe) { sum[i] += r.te; cnt[i] += 1; }
            const c = (perExc.get(r.tExc) || 0) + 1;
            perExc.set(r.tExc, c);
            if (c > echoes) echoes = c;
        });
        if (echoes <= 1) return { ok: false, message: 'One echo per excitation: every line has the same TE, so there is no echo-train blurring. Load TSE or EPI (or Show me).' };
        const te = new Float64Array(nPe);
        let tMin = Infinity, tMax = -Infinity;
        for (let i = 0; i < nPe; i++) { te[i] = cnt[i] ? sum[i] / cnt[i] : NaN; if (cnt[i]) { tMin = Math.min(tMin, te[i]); tMax = Math.max(tMax, te[i]); } }
        const teC = isFinite(te[h]) ? te[h] : (acq.stats && acq.stats.teEff) || tMin;
        const nExc = (p.rf || []).filter(function (r) { return !r.dummy && r.role === 'excite'; }).length || 1;
        const nRef = (p.rf || []).filter(function (r) { return !r.dummy && r.role === 'refocus'; }).length;
        const refPerExc = nRef / nExc;
        const mode = refPerExc >= echoes - 0.5 ? 'se' : (refPerExc >= 0.5 ? 'seepi' : 'gre');
        let ph = null;
        try { ph = A().getPhantom(); } catch (e) { ph = null; }
        const tissues = pickTissues(ph, mode);
        if (!tissues.length) return { ok: false, message: 'No tissues to show.' };
        const xs = [];
        for (let x = -6; x <= 6.0001; x += 0.05) xs.push(x);
        const X = Float64Array.from(xs);
        function psf(wfn) {
            const out = new Float64Array(X.length);
            for (let j = 0; j < X.length; j++) {
                let re = 0, im = 0;
                for (let i = 0; i < nPe; i++) {
                    if (!cnt[i]) continue;
                    const w = wfn(te[i]), a = 2 * Math.PI * (i - h) * X[j] / nPe;
                    re += w * Math.cos(a); im += w * Math.sin(a);
                }
                out[j] = Math.hypot(re, im);
            }
            const peak = out[Math.floor(X.length / 2)] || 1;
            for (let j = 0; j < out.length; j++) out[j] /= peak;
            return out;
        }
        function fwhm(y) {
            const c = Math.floor(y.length / 2);
            let l = c, r = c;
            while (l > 0 && y[l] >= 0.5) l--;
            while (r < y.length - 1 && y[r] >= 0.5) r++;
            const xl = X[l] + (0.5 - y[l]) * (X[l + 1] - X[l]) / ((y[l + 1] - y[l]) || 1);
            const xr = X[r - 1] + (0.5 - y[r - 1]) * (X[r] - X[r - 1]) / ((y[r] - y[r - 1]) || 1);
            return xr - xl;
        }
        const series = [];
        const ideal = psf(function () { return 1; });
        series.push({ x: X, y: ideal, color: 'var(--muted)', dash: true, width: 1.2, label: 'No decay: ' + fwhm(ideal).toFixed(1) + ' px' });
        const dy = fovPe / nPe * 1e3;
        tissues.forEach(function (t, k) {
            const T2 = t.t2, T2s = Math.min(t.t2s, t.t2);
            const R2p = Math.max(0, 1 / T2s - 1 / T2);
            const wfn = mode === 'se' ? function (tt) { return Math.exp(-tt / T2); }
                : mode === 'seepi' ? function (tt) { return Math.exp(-tt / T2 - Math.abs(tt - teC) * R2p); }
                : function (tt) { return Math.exp(-tt / T2s); };
            const y = psf(wfn), f = fwhm(y);
            const tv = mode === 'gre' ? T2s : T2;
            series.push({ x: X, y: y, color: 'var(--c' + (k + 1) + ')', width: 1.8,
                label: t.name.replace(/ \(.*\)$/, '') + ' (' + (mode === 'gre' ? 'T2*' : 'T2') + ' ' + fnum(tv * 1e3, 3) + ' ms): ' + f.toFixed(1) + ' px' });
        });
        const what = mode === 'se' ? 'spin echoes, decay with T2' : mode === 'seepi' ? 'spin-echo EPI: T2 overall, plus T2′ away from the spin echo' : 'gradient echoes, decay with T2*';
        const msg = '<b>' + echoes + ' echoes</b> per excitation, lines recorded from <b>' + fnum(tMin * 1e3) + '</b> to <b>' + fnum(tMax * 1e3) + ' ms</b> after excitation, centre at ' + fnum(teC * 1e3) + ' ms (' + what + '). ' +
            'Full widths at half maximum below, in pixels of ' + fnum(dy) + ' mm.';
        return { ok: true, series: series, message: msg };
    }
    function pickTissues(ph, mode) {
        if (!ph || !ph.tissues) return [];
        const list = ph.tissues.filter(function (t) { return t && t.id !== 'air' && t.pd > 0.1; });
        const pref = ['csf', 'gm', 'wm', 'fat', 'muscle'];
        const byPref = pref.map(function (id) { return list.find(function (t) { return t.id === id; }); }).filter(Boolean);
        if (byPref.length >= 3) return byPref.slice(0, 4);
        const key = function (t) { return mode === 'gre' ? t.t2s : t.t2; };
        const sorted = list.slice().sort(function (a, b) { return key(a) - key(b); });
        if (sorted.length <= 4) return sorted;
        const out = [];
        for (let k = 0; k < 4; k++) out.push(sorted[Math.round(k * (sorted.length - 1) / 3)]);
        return out;
    }

    /* ---------- Missing dummy scans ---------- */
    function presetDummies() {
        const pr = MRI.presets && MRI.presets.get ? MRI.presets.get(S().presetId) : null;
        const m = pr && /^[ \t]*dummies[ \t]+(\d+)/m.exec(pr.source);
        return m ? +m[1] : 2;
    }
    CARDS.push({
        id: 'dummies', group: 'recon', title: 'Missing dummy scans', list: 'dummy scans',
        see: 'Ghosts or streaks along the phase-encode direction, or, in single-shot imaging, a first image whose contrast differs from the rest (bright CSF in the first fMRI volume).',
        why: 'With TR shorter than about 5·T1, Mz does not recover fully between excitations; it settles to a steady state over the first few TRs. Dummy scans play those TRs with the ADC off. Without them the first lines carry more signal than the rest, and long-T1 tissue (CSF) the most.',
        kspace: 'In the lines recorded first. A turbo spin echo\'s first shot fills every (N/ETL)-th line across all of k-space, so the excess repeats along k<sub>y</sub> and makes ghosts N ÷ (N/ETL) = ETL pixels apart. In a line-by-line sequence the first lines sit at the edge of k-space and the damage is small.',
        fix: 'Keep the dummy scans (the presets use 1 to 4), or discard the first volumes in a time series.',
        build: function (box) {
            const live = el('p', { class: 'af-live' });
            const rm = W().button({ label: 'Remove dummy scans', size: 'sm', onClick: function () {
                const src = EDIT.dummies(0)(S().source);
                if (src !== S().source) A().setSource(src);
            } });
            const back = W().button({ label: 'Restore', size: 'sm', onClick: function () {
                const src = EDIT.dummies(presetDummies())(S().source);
                if (src !== S().source) A().setSource(src);
            } });
            box.appendChild(el('div', { class: 'row', role: 'group', 'aria-label': 'Dummy scans in the current sequence' }, [rm, back]));
            box.appendChild(live);
            return {
                sync: function () {
                    const p = program(), has = /^[ \t]*dummies[ \t]+/m.test(S().source || '');
                    const n = p && p.image ? p.image.dummies || 0 : 0;
                    rm.disabled = !has || n === 0;
                    back.disabled = !has || n === presetDummies();
                    live.innerHTML = !has ? 'This sequence has no <code>dummies</code> line.'
                        : 'This sequence plays <b>' + n + '</b> dummy ' + (n === 1 ? 'repetition' : 'repetitions') + ' (the line <code>dummies ' + n + '</code> in the Sequence tab).';
                }
            };
        },
        status: function () {
            const p = program();
            if (p && p.image && p.image.hasImaging !== false && (p.image.dummies || 0) === 0 && (p.periods || []).length > 1) return { kind: 'on', text: 'No dummy scans' };
            return null;
        },
        demos: [{
            label: 'Show me',
            loads: 'Turbo spin echo on the brain (8 shots of ETL 16, TR 3 s) with its dummy repetition removed: the first shot, with fully relaxed CSF, makes ghosts 16 pixels apart along y.',
            setup: { phantom: 'brain', preset: 'tse', edits: [EDIT.dummies(0)] }
        }]
    });

    /* ============================================================
       Tab state and rendering
       ============================================================ */
    const T = { visible: false, dirty: true, previewDirty: true, built: false };
    const V = { cards: {}, groups: {} };

    function renderStatus() {
        const on = [], present = [];
        CARDS.forEach(function (c) {
            const ui = V.cards[c.id];
            let st = null;
            try { st = c.status(); } catch (e) { st = null; }
            ui.card.classList.toggle('is-on', !!st && st.kind === 'on');
            ui.card.classList.toggle('is-present', !!st && st.kind === 'present');
            ui.badge.hidden = !st;
            if (st) {
                ui.badge.className = 'badge ' + (st.kind === 'on' ? 'badge-warn' : 'badge-accent');
                ui.badge.textContent = (st.kind === 'on' ? 'Active: ' : 'In this scan: ') + st.text;
                (st.kind === 'on' ? on : present).push(c);
            }
            ui.status = st;
        });
        GROUPS.forEach(function (g) {
            const gu = V.groups[g.id];
            const cs = CARDS.filter(function (c) { return c.group === g.id; });
            const nOn = cs.filter(function (c) { return V.cards[c.id].status && V.cards[c.id].status.kind === 'on'; }).length;
            const nPr = cs.filter(function (c) { return V.cards[c.id].status && V.cards[c.id].status.kind === 'present'; }).length;
            gu.badgeOn.hidden = !nOn; gu.badgeOn.textContent = nOn + ' active';
            gu.badgePr.hidden = !nPr; gu.badgePr.textContent = nPr + ' in this scan';
        });
        const key = on.map(function (c) { return c.id; }).join(',') + '|' + present.map(function (c) { return c.id; }).join(',');
        V.resetBtn.disabled = !CARDS.some(function (c) { return V.cards[c.id].status && V.cards[c.id].status.kind === 'on' && isArtifactSetting(c.id); });
        if (key === V.summaryKey) return;
        V.summaryKey = key;
        const box = V.summary;
        box.textContent = '';
        const add = function (label, list, kind) {
            const line = el('div', {}, [el('span', { class: 'af-sum-label', text: label + ' ' })]);
            if (!list.length) line.appendChild(el('span', { class: 'af-none', text: kind === 'on' ? 'none, the scan is clean of switched-on artifacts.' : 'nothing notable.' }));
            list.forEach(function (c) {
                line.appendChild(el('button', { type: 'button', class: 'badge ' + (kind === 'on' ? 'badge-warn' : 'badge-accent') + ' af-chip', style: { cursor: 'pointer' },
                    title: 'Go to the ' + c.title + ' card', onclick: function () { reveal(c.id); } }, c.list.charAt(0).toUpperCase() + c.list.slice(1)));
            });
            box.appendChild(line);
        };
        add('Switched on:', on, 'on');
        add('Present in this scan:', present, 'present');
    }
    function isArtifactSetting(id) { return ['noise', 'b1', 'b0', 'ghost', 'motion', 'flow', 'spike', 'zipper'].indexOf(id) >= 0; }

    function syncCards(force) {
        CARDS.forEach(function (c) {
            const ui = V.cards[c.id];
            if (!ui.ctl) return;
            // Cards in closed groups are synced when their group opens.
            if (!V.groups[c.group].el.open) { ui.stale = true; return; }
            try { ui.ctl.sync(force); ui.stale = false; } catch (e) { if (root.console) root.console.error('[artifacts] ' + c.id + ' sync failed:', e); }
        });
    }

    function render() {
        if (!T.built) return;
        T.dirty = false;
        syncCards(false);
        renderStatus();
    }
    const requestRender = frameThrottle(function () { if (T.visible) render(); else T.dirty = true; });

    /* ---------- live preview ---------- */
    function drawPreview() {
        T.previewDirty = false;
        const r = S().reconResult;
        if (!r || !r.image || !r.image.mag || !r.image.nx) {
            const msg = S().scanning ? 'Scanning...' : 'No image yet: press Acquire.';
            V.prevImg.clear(msg); V.prevK.clear(msg);
            V.prevInfo.textContent = '';
            return;
        }
        const im = r.image;
        const hi = U.percentile(im.mag, 99.5);
        V.prevImg.setData(im.mag, im.nx, im.ny, { min: 0, max: hi > 0 ? hi : 1, fovX: im.fovX, fovY: im.fovY });
        const k = r.kspace;
        if (k && k.re && k.re.length && k.nx && k.ny) {
            const re = k.re[0], ki = k.im[0], N = k.nx * k.ny, lg = new Float32Array(N);
            let mx = -Infinity;
            for (let i = 0; i < N; i++) {
                const m = Math.sqrt(re[i] * re[i] + ki[i] * ki[i]);
                if (m > 0) { const v = Math.log10(m); lg[i] = v; if (v > mx) mx = v; } else lg[i] = NaN;
            }
            if (isFinite(mx)) V.prevK.setData(lg, k.nx, k.ny, { min: mx - 4.5, max: mx, aspect: 1 });
            else V.prevK.clear('No samples yet');
        }
        const s = A().currentSummary ? A().currentSummary() : null;
        V.prevInfo.textContent = s && s.name ? s.name + ' · ' + s.phantom + ' · ' + (s.nx && s.ny ? s.nx + ' × ' + s.ny : '') + (S().scanning ? ' · acquiring' : '') : '';
    }
    const requestPreview = frameThrottle(function () { if (T.visible) drawPreview(); else T.previewDirty = true; });

    /* Open one group and close the others (the groups are an accordion). */
    function openGroup(gid) {
        GROUPS.forEach(function (g) {
            const d = V.groups[g.id].el;
            if (g.id === gid) { if (!d.open) d.open = true; } else if (d.open) d.open = false;
        });
    }
    /* Open a card's group, scroll the card into view and put keyboard focus
       on its heading. Used by the summary chips and by artifacts:focus. */
    function reveal(id) {
        const c = CARDS.find(function (x) { return x.id === id; });
        if (!c) return false;
        openGroup(c.group);
        const card = V.cards[id].card;
        raf(function () {
            try { card.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); } catch (e) { card.scrollIntoView(); }
            const h = card.querySelector('h3');
            if (h) { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
        });
        return true;
    }

    function measureSticky() {
        const con = doc.getElementById('console');
        const top = (con && root.getComputedStyle(con).position === 'sticky' ? con.offsetHeight : 0) + 12;
        if (V.panel) V.panel.style.setProperty('--af-top', top + 'px');
    }

    /* ============================================================
       mount
       ============================================================ */
    function buildCard(c) {
        const titleId = 'af-title-' + c.id;
        const card = el('article', { class: 'af-card', id: 'af-card-' + c.id, 'aria-labelledby': titleId });
        const badge = el('span', { class: 'badge', hidden: true });
        card.appendChild(el('header', { class: 'af-card-head' }, [el('h3', { id: titleId, text: c.title }), badge]));
        const addFact = function (facts, label, html, extra) {
            facts.appendChild(el('dt', { text: label }));
            const dd = el('dd', { html: html });
            if (extra) dd.appendChild(extra);
            facts.appendChild(dd);
        };
        /* What you see stays in view with the controls and Show me; the
           explanation is one click away, so an open group is not a wall of text. */
        const facts = el('dl', { class: 'af-facts' });
        addFact(facts, 'What you see', c.see);
        const more = el('dl', { class: 'af-facts' });
        addFact(more, 'Why', c.why, c.eq ? el('div', { class: 'af-eq', html: c.eq }) : null);
        addFact(more, 'Where it lives in k-space', c.kspace);
        addFact(more, 'How to fix it', c.fix);
        const why = el('details', { class: 'af-more' }, [el('summary', { text: 'Why it happens and how to fix it' }), more]);
        const text = el('div', { class: 'af-text' }, [facts, why]);
        // The honest-simplification note stays visible: it is what keeps a careful student from being misled.
        if (c.simpl) text.appendChild(el('p', { class: 'simplification', html: c.simpl }));
        const ctlBox = el('div', { class: 'af-ctl', role: 'group', 'aria-label': 'Controls for ' + c.title });
        let ctl = null;
        try { ctl = c.build(ctlBox); } catch (e) {
            if (root.console) root.console.error('[artifacts] ' + c.id + ' controls failed:', e);
            ctlBox.appendChild(W().errorCard('These controls failed to start', e));
        }
        if (c.demos && c.demos.length) {
            const show = el('div', { class: 'af-show' });
            const btns = el('div', { class: 'af-show-btns' });
            const loads = el('p', { class: 'af-loads', id: 'af-loads-' + c.id });
            c.demos.forEach(function (d, i) {
                const b = el('button', { type: 'button', class: 'btn btn-sm ' + (i === 0 ? 'btn-primary' : ''),
                    'aria-describedby': 'af-loads-' + c.id, html: (i === 0 ? playIcon() : '') + d.label });
                // computed texts (the echo-train comparison compiles two sequences) are filled in on first use
                const show = function () { loads.textContent = 'Loads: ' + loadsText(d); };
                b.addEventListener('click', function () { runDemo(d); });
                b.addEventListener('mouseenter', function () { show(); if (!b.title) b.title = 'Loads: ' + loadsText(d).replace(/<[^>]+>/g, ''); });
                b.addEventListener('focus', show);
                if (typeof d.loads !== 'function') b.title = 'Loads: ' + d.loads.replace(/<[^>]+>/g, '');
                btns.appendChild(b);
            });
            loads.textContent = 'Loads: ' + loadsText(c.demos[0]);
            show.appendChild(btns);
            show.appendChild(loads);
            ctlBox.appendChild(show);
        }
        card.appendChild(el('div', { class: 'af-card-body' }, [text, ctlBox]));
        return { card: card, badge: badge, ctl: ctl, status: null, stale: true };
    }

    function mount(panel) {
        const Wd = W();
        V.panel = panel;
        panel.textContent = '';

        panel.appendChild(Wd.concept({
            title: 'Artifacts: when the scanner\'s assumptions fail',
            body: '<p>The reconstruction assumes that every sample was taken exactly at its nominal k, from an object that kept still, in a perfectly uniform field, with nothing added but thermal noise. Each artifact is one of those assumptions failing. Here each comes from its mechanism (a field offset, motion between lines, a gradient delay), so it responds the way it would on a scanner when you change TR, bandwidth or the phase-encode direction.</p>' +
                '<p>Ask two questions of any artifact: along which direction does it spread (readout or phase encode), and where in k-space did the damage happen?</p>',
            formula: 'S(<b>k</b>) = Σ<sub><b>r</b></sub> m(<b>r</b>) C(<b>r</b>) e<sup>−i2π[<b>k</b>·<b>r</b> + Δf(<b>r</b>) τ]</sup> &nbsp; + noise',
            tryThis: [
                { html: '<b>Wrap-around</b>: a 180 mm FOV on a 200 mm head folds the back of the head onto the forehead.', label: 'Show me', run: function () { runCardDemo('alias', 0); } },
                { html: '<b>Motion ghosts</b>: breathing-like motion copies the head along the phase-encode direction only, whichever way it moves.', label: 'Show me', run: function () { runCardDemo('motion', 0); } },
                { html: '<b>Fat shift</b>: at 50 Hz/px fat moves 434 / 50 = 8.7 pixels along the readout.', label: 'Show me', run: function () { runCardDemo('chem', 0); } },
                { html: '<b>Nyquist ghost</b>: a 3 µs gradient delay in EPI puts a ghost half a field of view away. EPI ghost correction removes it.', label: 'Show me', run: function () { runCardDemo('ghost', 0); } }
            ]
        }));

        const layout = el('div', { class: 'split af-layout' });
        const main = el('div', { class: 'af-main' });
        const side = el('div', { class: 'af-side', role: 'group', 'aria-label': 'Live preview of the current scan' });
        layout.appendChild(main); layout.appendChild(side);
        panel.appendChild(layout);

        // Toolbar: what is on, reset, expand/collapse.
        const bar = el('section', { class: 'panel', 'aria-label': 'Artifact summary' });
        V.summary = el('div', { class: 'af-summary', role: 'status', 'aria-live': 'polite' });
        V.resetBtn = Wd.button({ label: 'Reset all artifacts', kind: 'danger', size: 'sm',
            title: 'Switch off every artifact setting (noise, motion, flow, fields, delay, spike, zipper). The sequence, coil and reconstruction stay as they are.',
            onClick: function () { A().resetArtifacts(); toast('All artifact settings are back to the clean defaults.', 'good'); } });
        const collapse = Wd.button({ label: 'Close all', size: 'sm', kind: 'ghost', onClick: function () { setAllGroups(false); } });
        bar.appendChild(el('div', { class: 'af-toolbar' }, [V.summary, el('div', { class: 'row' }, [collapse, V.resetBtn])]));
        main.appendChild(bar);

        // Groups and cards. The groups are an accordion: opening one (by its
        // summary) closes the others, so the page never holds all fifteen cards.
        const saved = storeGet() || {};
        let firstOpen = null;
        GROUPS.forEach(function (g) { if (!firstOpen && saved[g.id]) firstOpen = g.id; });
        if (!firstOpen && !GROUPS.some(function (g) { return saved[g.id] === false; })) firstOpen = GROUPS[0].id;
        GROUPS.forEach(function (g) {
            const cs = CARDS.filter(function (c) { return c.group === g.id; });
            const det = el('details', { class: 'af-group', id: 'af-group-' + g.id });
            const badgeOn = el('span', { class: 'badge badge-warn', hidden: true });
            const badgePr = el('span', { class: 'badge badge-accent', hidden: true });
            const summary = el('summary', {}, [
                el('h2', { class: 'af-group-title', text: g.title }),
                el('span', { class: 'af-group-list', text: cs.map(function (c) { return c.list; }).join(', ') }),
                el('span', { class: 'af-group-badges' }, [badgeOn, badgePr])
            ]);
            det.appendChild(summary);
            const body = el('div', { class: 'af-group-body' });
            det.appendChild(body);
            cs.forEach(function (c) {
                const ui = buildCard(c);
                V.cards[c.id] = ui;
                body.appendChild(ui.card);
            });
            det.open = g.id === firstOpen;
            // a click on the summary (or Enter / Space on it) is the student opening this group
            let byUser = false;
            summary.addEventListener('click', function () { byUser = true; });
            det.addEventListener('toggle', function () {
                if (det.open && byUser) openGroup(g.id);
                byUser = false;
                const st = storeGet() || {};
                st[g.id] = det.open;
                storeSet(st);
                if (det.open && T.visible) {
                    cs.forEach(function (c) { const ui = V.cards[c.id]; if (ui.ctl && ui.stale) { try { ui.ctl.sync(true); ui.stale = false; } catch (e) { /* logged on next render */ } } });
                }
            });
            V.groups[g.id] = { el: det, badgeOn: badgeOn, badgePr: badgePr };
            main.appendChild(det);
        });

        // Live preview.
        const pv = el('section', { class: 'panel', 'aria-labelledby': 'af-prev-title' });
        pv.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'af-prev-title', text: 'The current scan' }),
            el('span', { class: 'panel-sub', text: 'updates as you change a setting' })
        ]));
        const grid = el('div', { class: 'af-prev-grid' });
        pv.appendChild(grid);
        V.prevImg = Wd.imageView(grid, { title: 'Image', maxHeight: 270, readout: false, empty: 'No image yet' });
        V.prevImg.canvas.setAttribute('aria-label', 'Reconstructed image of the current scan (magnitude)');
        V.prevK = Wd.imageView(grid, { title: 'k-space, coil 1 (log)', maxHeight: 190, readout: false, wl: false, empty: 'No data yet' });
        V.prevK.canvas.setAttribute('aria-label', 'Raw k-space of coil 1, log magnitude; samples not yet acquired are dark');
        V.prevInfo = el('p', { class: 'af-prev-info' });
        pv.appendChild(V.prevInfo);
        pv.appendChild(el('div', { class: 'af-prev-links' }, [
            Wd.button({ label: 'Open the Image tab', size: 'sm', onClick: function () { A().showTab('image', { focus: true }); } }),
            // one wording for every "go to a tab" button (scan bar, stale banners, Scanner links)
            Wd.button({ label: 'Open the k-space tab', size: 'sm', kind: 'ghost', onClick: function () { A().showTab('kspace', { focus: true }); } })
        ]));
        side.appendChild(pv);

        T.built = true;

        const bus = MRI.bus;
        ['artifacts:changed', 'program:compiled', 'coil:changed', 'phantom:changed', 'scan:done', 'recon:done'].forEach(function (evt) {
            bus.on(evt, function (e) {
                if (evt === 'recon:done' && e && e.partial) return;       // playback: only the preview follows every frame
                if (T.visible) requestRender(); else T.dirty = true;
            });
        });
        bus.on('recon:done', function () { requestPreview(); });
        bus.on('scan:start', function () { if (T.visible) requestRender(); });
        bus.on('scan:error', function () { requestPreview(); });
        bus.on('theme:changed', function () {
            if (!T.visible) return;
            const tr = V.cards.train && V.cards.train.ctl;
            if (tr && tr.redraw) tr.redraw();
        });
        /* artifacts:focus {id}: another tab (the Scanner's component panel)
           sends the student to one card: open its group, scroll to it and
           focus its heading. Card ids: noise, b1, coil, alias, gibbs, chem,
           b0, motion, flow, ghost, spike, zipper, under, train, dummies. */
        bus.on('artifacts:focus', function (e) {
            const id = e && e.id;
            if (!id || !V.cards[id]) return;
            if (MRI.app && MRI.app.activeTab && MRI.app.activeTab() !== 'artifacts') A().showTab('artifacts');
            reveal(id);
        });
    }

    function runCardDemo(id, i) {
        const c = CARDS.find(function (x) { return x.id === id; });
        if (c && c.demos && c.demos[i]) runDemo(c.demos[i]);
    }

    function setAllGroups(open) {
        GROUPS.forEach(function (g) { V.groups[g.id].el.open = open; });
    }

    function onShow() {
        T.visible = true;
        if (!T.built) return;
        measureSticky();
        render();
        const tr = V.cards.train && V.cards.train.ctl;
        if (tr && tr.redraw && V.groups.recon.el.open) tr.redraw();
        drawPreview();
    }
    function onHide() { T.visible = false; }

    MRI.ui.registerTab({ id: 'artifacts', title: 'Artifacts', order: 70, mount: mount, onShow: onShow, onHide: onHide });
})(typeof window !== 'undefined' ? window : globalThis);
