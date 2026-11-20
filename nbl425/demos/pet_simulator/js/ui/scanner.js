/* ============================================================
   PET Simulator, Scanner tab
   The students' first look at how PET works: an animated ring in
   which single decays become lines of response (LORs), with true,
   scattered and random coincidences told apart by colour, next to a
   clickable schematic of the detection chain, a side view of the
   ring stack for 2D and 3D acquisition, and live readouts (counts,
   the measured-energy spectrum, the coincidence time differences and
   a sinogram filling in dot by dot).

   The events come from PET.events (js/events.js), a toy Monte Carlo
   that follows each decay through the current phantom's mu map with
   the current protocol's windows. It is calibrated to the latest
   scan's scatter and randoms fractions, so what the animation shows
   agrees with the Sinogram tab's numbers.

   Animation discipline: one requestAnimationFrame loop, running only
   while this tab is visible, the page is visible and the animation is
   playing (or playing out one stepped event). Static layers (the
   ring, the phantom, accumulated LORs) are drawn once into offscreen
   canvases and composited each frame.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !root.document) return;
    const U = PET.util;
    const doc = root.document;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const el = function (tag, attrs, children) { return U.el(tag, attrs, children); };

    /* ---------- constants ---------- */
    const SPEED = { slow: 0.35, medium: 1, fast: 4 };       // animation seconds per wall second
    const RATE = 3.2;                 // decays per animation second
    const T_POS = 0.32;               // animation s: the positron's flight (stylised)
    const T_FLASH = 0.5;              // crystal flash
    const LIFE_LOR = 2.3, LIFE_REJ = 1.3, LIFE_SINGLE = 0.9;
    const WORLD = 296;                // mm from the ring centre to the edge of the drawing
    const MAX_DOTS = 6000;
    const E_BINS = { lo: 150, hi: 750, w: 10 };
    const T_NBINS = 48;
    const PROMPT = { true: 1, scatter: 1, random: 1 };
    const GROUP = { true: 'true', scatter: 'scatter', random: 'random',
        'rejected-energy': 'rejected', 'rejected-time': 'rejected', multiple: 'rejected', single: 'rejected' };
    const KIND_LABEL = { true: 'True', scatter: 'Scatter', random: 'Random', 'rejected-energy': 'Rejected (energy)',
        'rejected-time': 'Rejected (timing)', multiple: 'Multiple', single: 'Single' };

    /* ---------- tab state ---------- */
    const S = {
        mounted: false, shown: false, needsRebuild: true,
        playing: true, speed: 'medium', stepping: false, stepUntil: 0,
        show: { true: true, scatter: true, random: true, rejected: true },
        keep: false, zoom: false,
        sim: null, scene: null, sceneKey: '', info: null, error: null,
        active: [], byId: new Map(), clock: 0, raf: 0, last: 0,
        latest: null, captionFor: null, selected: null,
        tally: null, eU: null, eS: null, tSame: null, tRand: null, tRej: null, tRange: 3e-9,
        dots: [], pulses: [], partGlow: [],
        dirty: { table: true, plots: true, sino: true }, lastSlow: 0,
        geo: { size: 0, cx: 0, cy: 0, k: 1 }, layers: { ring: null, phantom: null, keep: null, sinoBg: null },
        colors: null, dom: {}, chainCols: 0, partSel: 0, sideMode: null, sideModeAuto: true
    };

    function prefersReducedMotion() {
        try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
    }
    function notify(msg, kind) {
        if (PET.app && PET.app.notify) PET.app.notify(msg, kind);
        else if (PET.ui.w && PET.ui.w.toast) PET.ui.w.toast(msg, kind);
    }
    function fmt(x, d) { return isFinite(x) ? x.toFixed(d === undefined ? 1 : d) : '-'; }
    function pct(x) { return isFinite(x) && x !== null ? (x === 0 ? '0' : (100 * x).toFixed(x < 0.1 ? 1 : 0)) + ' %' : '-'; }

    /* ============================================================
       Scene: phantom, activity, protocol, physics, target fractions
       ============================================================ */
    const FALLBACK_PROGRAM = {
        ok: true, isotope: 'F18', tracer: 'FDG', energy: { lo: 435, hi: 650 }, coincidence: 4.5e-9,
        tof: { on: true, ctr: 400e-12 }, acqMode: '3D', frames: [{ t0: 2700, t1: 3300 }]
    };
    function currentProgram() {
        const st = PET.state;
        const p = st && (st.program && st.program.ok ? st.program : st.lastGoodProgram);
        return p && p.energy ? { program: p, fallback: false } : { program: FALLBACK_PROGRAM, fallback: true };
    }
    let fallbackPhantom = null;
    /* Stand-in when the phantom module is missing: a 200 mm water cylinder. */
    function standInPhantom() {
        if (fallbackPhantom) return fallbackPhantom;
        const n = 128, fov = 320, dx = fov / n, h = n / 2;
        const label = new Uint8Array(n * n), mu = new Float32Array(n * n);
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const x = (ix - h) * dx, y = (iy - h) * dx;
            if (x * x + y * y <= 100 * 100) { label[iy * n + ix] = 1; mu[iy * n + ix] = PET.const.MU_WATER; }
        }
        fallbackPhantom = { id: 'standin', name: 'Water cylinder (stand-in)', kind: 'solution', n: n, fov: fov, dx: dx,
            label: label, mu: mu, regions: [{ id: 'air', name: 'Air', mu: 0, tissue: 'air', rel: 0 },
                { id: 'water', name: 'Water', mu: PET.const.MU_WATER, tissue: 'water', rel: 1 }] };
        return fallbackPhantom;
    }
    function currentPhantom() {
        try {
            if (PET.actions && PET.actions.getPhantom && PET.phantoms) {
                const p = PET.actions.getPhantom();
                if (p && p.n && p.label && p.mu) return { phantom: p, fallback: false };
            }
        } catch (e) { /* fall through to the stand-in */ }
        return { phantom: standInPhantom(), fallback: true };
    }
    /* Relative activity by tissue, used before the first scan of a brain. */
    const TISSUE_GUESS = { gm: 1, wm: 0.32, blood: 0.55, soft: 0.12, csf: 0.02, bone: 0.05, water: 1, plastic: 0, air: 0, lung: 0 };
    function acqMatches(acq, ph) {
        if (!acq || !Array.isArray(acq.frames) || !acq.frames.length) return false;
        if (acq.phantomId && ph.id && acq.phantomId !== ph.id) return false;
        const F = acq.frames[0];
        return !!(F && F.truth && F.truth.regionMean && F.truth.regionMean.length === ph.regions.length);
    }
    function frameActivity(F) {
        let s = 0; const m = F.truth.regionMean;
        for (let r = 0; r < m.length; r++) if (m[r] > 0) s += m[r];
        return s;
    }
    /* The activity raster of the frame shown, from the scan's regional
       means; the frame with the most activity if that one is empty (a
       dynamic scan before the bolus arrives). */
    function emissionFor(ph) {
        const st = PET.state || {}, acq = st.acq, n = ph.n, out = new Float32Array(n * n);
        let values = null, source = 'approx', frame = null;
        if (acqMatches(acq, ph)) {
            let f = U.clamp(st.frame || 0, 0, acq.frames.length - 1);
            if (!(frameActivity(acq.frames[f]) > 0)) {
                let best = -1;
                acq.frames.forEach(function (F, j) { const a = frameActivity(F); if (a > best) { best = a; f = j; } });
            }
            if (frameActivity(acq.frames[f]) > 0) { values = acq.frames[f].truth.regionMean; source = 'scan'; frame = f; }
        }
        if (!values) {
            values = ph.regions.map(function (r) {
                if (r.rel > 0) return r.rel;
                if (ph.kind === 'brain') return TISSUE_GUESS[r.tissue] || 0;
                return 0;
            });
        }
        for (let k = 0; k < out.length; k++) { const v = values[ph.label[k]]; out[k] = v > 0 ? v : 0; }
        return { emission: out, source: source, frame: frame, values: values };
    }
    function targetsFor(ph, frame) {
        const st = PET.state || {}, acq = st.acq;
        if (!acqMatches(acq, ph)) return null;
        const F = acq.frames[frame === null ? U.clamp(st.frame || 0, 0, acq.frames.length - 1) : frame];
        const c = F && F.counts;
        if (!c || !(c.trues + c.scatter > 0)) return null;
        const sf = isFinite(c.sf) ? c.sf : c.scatter / (c.trues + c.scatter);
        const all = c.trues + c.scatter + c.randoms;
        const rf = isFinite(c.rf) ? c.rf : (all > 0 ? c.randoms / all : 0);
        return { sf: sf, rf: rf };
    }
    function buildScene() {
        const P = currentProgram(), Ph = currentPhantom(), ph = Ph.phantom;
        const em = emissionFor(ph);
        const physics = Object.assign({ attenuation: true, scatter: true, randoms: true, positronRange: true },
            (PET.state && PET.state.physics) || {});
        const tg = targetsFor(ph, em.frame);
        const prog = P.program;
        const scene = { phantom: ph, emission: em.emission, isotope: prog.isotope || 'F18', program: prog, physics: physics };
        const sig = em.values ? Array.prototype.map.call(em.values, function (v) { return Number((+v).toPrecision(4)); }).join(',') : '';
        const key = JSON.stringify([ph.id, (PET.state && PET.state.phantomOpts) || null, Ph.fallback, em.source, sig,
            prog.isotope, prog.energy, prog.coincidence, prog.tof, prog.acqMode,
            physics.attenuation, physics.scatter, physics.randoms, physics.positronRange, physics.seed,
            tg ? [tg.sf.toFixed(3), tg.rf.toFixed(3)] : null]);
        return { scene: scene, key: key, targets: tg,
            info: { programFallback: P.fallback, phantomFallback: Ph.fallback, source: em.source, frame: em.frame } };
    }

    /* (Re)create the simulator when something it depends on changed.
       Expensive-ish (about 0.1 s of calibration), so it is skipped while
       the tab is hidden and done on the next show. */
    function rebuild(force) {
        if (!S.mounted) return;
        if (!S.shown) { S.needsRebuild = true; return; }
        S.needsRebuild = false;
        if (!PET.events || !PET.scanner || !PET.isotopes) {
            S.sim = null;
            S.error = !PET.events ? 'The event animation (js/events.js) did not load, so there is nothing to animate.'
                : 'The scanner model did not load, so there is nothing to animate.';
            showEmpty(S.error);
            return;
        }
        let B;
        try { B = buildScene(); }
        catch (e) { if (root.console) root.console.warn('[scanner tab] scene', e); S.sim = null; showEmpty('The scene could not be built: ' + (e.message || e)); return; }
        if (!force && B.key === S.sceneKey && S.sim) { updateStaticTexts(); return; }
        S.sceneKey = B.key; S.scene = B.scene; S.info = B.info; S.targets = B.targets;
        try {
            const seed = ((PET.state && PET.state.physics && PET.state.physics.seed) || 1) * 7919 + 13;
            S.sim = PET.events.create(B.scene, { rate: RATE, seed: seed, targetFractions: B.targets });
        } catch (e) {
            if (root.console) root.console.warn('[scanner tab] events.create', e);
            S.sim = null; showEmpty('The event simulator failed: ' + (e.message || e)); return;
        }
        S.error = null;
        if (S.sim.empty) showEmpty('There is no activity in this object to animate. Fill the phantom or choose another one in the Phantom tab.');
        else showEmpty(null);
        resetReadouts();
        buildPhantomLayer();
        buildSinoBackground();
        clearKeepLayer();
        updateStaticTexts();
        drawOnce();
    }
    const scheduleRebuild = U.debounce(function () { rebuild(false); }, 80);

    /* ============================================================
       Readout accumulators
       ============================================================ */
    function resetReadouts() {
        S.tally = { decays: 0, singles: 0, prompts: 0, trues: 0, scatters: 0, randoms: 0, rejectedEnergy: 0, rejectedTime: 0, multiples: 0 };
        const nE = Math.round((E_BINS.hi - E_BINS.lo) / E_BINS.w);
        S.eU = new Float64Array(nE); S.eS = new Float64Array(nE);
        const tau = S.sim ? S.sim.params.tau : 4.5e-9;
        S.tRange = Math.max(0.75 * tau, tau / 2 + 0.8e-9);
        S.tSame = new Float64Array(T_NBINS); S.tRand = new Float64Array(T_NBINS); S.tRej = new Float64Array(T_NBINS);
        S.dots = [];
        S.selected = null;
        S.insetW = null;
        S.dirty.table = S.dirty.plots = S.dirty.sino = true;
    }
    function tallyEvent(w) {
        const ev = w.ev, T = S.tally;
        T.decays++;
        ev.photons.forEach(function (p) {
            if (p.fate !== 'detected') return;
            if (p.single) T.singles++;
            const b = Math.floor((p.measured - E_BINS.lo) / E_BINS.w);
            if (b >= 0 && b < S.eU.length) (p.scattered ? S.eS : S.eU)[b]++;
        });
        const k = ev.kind;
        if (k === 'true') T.trues++;
        else if (k === 'scatter') T.scatters++;
        else if (k === 'random') T.randoms += ev.randomPairs || 0;
        else if (k === 'rejected-energy') T.rejectedEnergy++;
        else if (k === 'rejected-time') T.rejectedTime++;
        else if (k === 'multiple' && ev.primary) T.multiples++;
        T.prompts = T.trues + T.scatters + T.randoms;
        if (ev.dt !== null && isFinite(ev.dt) && (ev.primary || k === 'rejected-time')) {
            const b = Math.floor((ev.dt + S.tRange) / (2 * S.tRange) * T_NBINS);
            if (b >= 0 && b < T_NBINS) {
                if (k === 'true' || k === 'scatter') S.tSame[b]++;
                else if (k === 'random') S.tRand[b]++;
                else if (k === 'rejected-time') S.tRej[b]++;
            }
        }
        if (PROMPT[k] && ev.primary && ev.lor && ev.lor.inside) {
            S.dots.push({ a: ev.lor.a, i: ev.lor.i, kind: k, lor: ev.lor, id: ev.id });
            if (S.dots.length > MAX_DOTS) S.dots.splice(0, S.dots.length - MAX_DOTS);
            S.dirty.sino = true;
        }
        S.dirty.table = S.dirty.plots = true;
    }

    /* ============================================================
       DOM
       ============================================================ */
    function mount(panel) {
        S.dom.panel = panel;
        injectStyle();
        S.playing = !prefersReducedMotion();
        panel.appendChild(buildConcept());

        const top = el('div', { class: 'split sc-top' });
        top.appendChild(buildAnimPanel());
        const side = el('div', { class: 'stack sc-side-col' });
        side.appendChild(buildCountsPanel());
        side.appendChild(buildSinoPanel());
        top.appendChild(side);
        panel.appendChild(top);

        const mid = el('div', { class: 'split-even sc-mid' });
        mid.appendChild(buildChainPanel());
        mid.appendChild(buildSidePanel());
        panel.appendChild(mid);

        panel.appendChild(buildPlotPanels());
        panel.appendChild(el('p', { class: 'simplification sc-simpl', html:
            '<strong>Honest simplifications.</strong> One slice through one ring, and every photon stays in that plane: ' +
            'a photon that would leave it is drawn fading out and counted as lost (in 3D, photons that scattered in ' +
            'neighbouring slices also scatter into this one; the toy stands in for them with extra in-plane scatter). ' +
            'At most one Compton scatter per photon (a second interaction absorbs it); no scatter inside the crystals; no dead time. ' +
            'Time is slowed about a billion times, so light crosses 30 cm in one second on screen, and the decay rate is ' +
            'rescaled so that the scatter and randoms fractions match your last scan.' }));

        resetReadouts();
        S.mounted = true;

        PET.bus.on('program:compiled', function (e) {
            if (e && e.program && e.program.ok) scheduleRebuild();
            if (S.sideModeAuto) S.sideMode = null;
            renderSide(); updateChainLabels(); renderPartInfo();
        });
        PET.bus.on('phantom:changed', scheduleRebuild);
        PET.bus.on('scan:done', scheduleRebuild);
        PET.bus.on('frame:changed', scheduleRebuild);
        PET.bus.on('physics:changed', scheduleRebuild);
        PET.bus.on('theme:changed', function () {
            S.colors = null;
            if (!S.shown) return;
            layout(true); drawOnce(); renderSino(); pulseColorsReset(); renderSide();
        });
        doc.addEventListener('visibilitychange', function () {
            if (doc.hidden) stopLoop();
            else if (S.shown) startLoop();
        });
        if (root.ResizeObserver) {
            let lastW = -1;
            const ro = new root.ResizeObserver(function () {
                const w = S.dom.stage ? S.dom.stage.clientWidth : 0;
                if (!S.shown || w === lastW) return;
                lastW = w;
                layout(false); drawOnce(); layoutChain(); renderSino();
            });
            ro.observe(S.dom.stage);
            ro.observe(S.dom.chainHost);
        }
    }

    function injectStyle() {
        PET.ui.addStyle([
            '#tab-scanner .sc-top { grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); }',
            '@media (max-width: 900px) { #tab-scanner .sc-top { grid-template-columns: minmax(0, 1fr); } }',
            '#tab-scanner .sc-top > .panel, #tab-scanner .sc-side-col > .panel { margin-bottom: 0; }',
            '#tab-scanner .sc-top { margin-bottom: 16px; }',
            '#tab-scanner .sc-side-col { gap: 16px; }',
            '#tab-scanner .sc-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 12px; }',
            '#tab-scanner .sc-toolbar .btn svg { width: 12px; height: 12px; flex: none; }',
            '#tab-scanner .sc-toolbar .spacer { flex: 1; }',
            '#tab-scanner .sc-well { padding: 10px; }',
            '#tab-scanner .sc-stage { position: relative; display: flex; justify-content: center; }',
            '#tab-scanner .sc-canvas { display: block; border-radius: 6px; cursor: crosshair; touch-action: manipulation; }',
            '#tab-scanner .sc-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 18% 22%; text-align: center;',
            '  color: var(--scope-fg); font-size: 0.9rem; line-height: 1.5; pointer-events: none; }',
            '#tab-scanner .sc-empty[hidden] { display: none; }',
            '#tab-scanner .sc-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 10px;',
            '  font-size: 0.8rem; color: var(--scope-fg); }',
            '#tab-scanner .sc-chk { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; white-space: nowrap; }',
            '#tab-scanner .sc-chk input { margin: 0; width: 14px; height: 14px; accent-color: #4f9cf5; }',
            '#tab-scanner .sc-key { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--scope-muted); }',
            '#tab-scanner .sc-sw { display: inline-block; width: 18px; height: 0; border-top: 3px solid currentColor; border-radius: 2px; flex: none; }',
            '#tab-scanner .sc-sw-dash { border-top-style: dashed; border-top-width: 2px; }',
            '#tab-scanner .sc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: currentColor; box-shadow: 0 0 6px currentColor; }',
            '#tab-scanner .sc-blob { display: inline-block; width: 18px; height: 7px; border-radius: 50%; flex: none; background: radial-gradient(closest-side, rgba(79,156,245,0.9), rgba(79,156,245,0)); }',
            '#tab-scanner .sc-filters .sc-sep { width: 1px; height: 14px; background: var(--scope-axis); }',
            '#tab-scanner .sc-caption { display: flex; gap: 10px; align-items: flex-start; margin-top: 12px; min-height: 3.4em;',
            '  font-size: 0.86rem; line-height: 1.5; }',
            '#tab-scanner .sc-caption .badge { flex: none; margin-top: 1px; }',
            '#tab-scanner .sc-badge-true { color: var(--ev-true); border-color: var(--ev-true); background: transparent; }',
            '#tab-scanner .sc-badge-scatter { color: var(--ev-scatter); border-color: var(--ev-scatter); background: transparent; }',
            '#tab-scanner .sc-badge-random { color: var(--ev-random); border-color: var(--ev-random); background: transparent; }',
            '#tab-scanner .sc-badge-rejected { color: var(--muted); border-style: dashed; background: transparent; }',
            '#tab-scanner .sc-k { font-weight: 650; }',
            '#tab-scanner .sc-k-true { color: var(--ev-true); } #tab-scanner .sc-k-scatter { color: var(--ev-scatter); }',
            '#tab-scanner .sc-k-random { color: var(--ev-random); } #tab-scanner .sc-k-rejected { color: var(--ev-rejected); }',
            '#tab-scanner .sc-formula { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 26px; }',
            '#tab-scanner .sc-formula span { white-space: nowrap; }',
            '#tab-scanner .sc-counts th .sc-sw { width: 14px; margin-right: 7px; vertical-align: 3px; }',
            '#tab-scanner .sc-counts tr.sc-sub th { padding-left: 10px; }',
            '#tab-scanner .sc-counts tr.sc-strong th, #tab-scanner .sc-counts tr.sc-strong td { color: var(--fg); font-weight: 650; }',
            '#tab-scanner .sc-counts tr.sc-frac td { font-weight: 650; white-space: nowrap; }',
            '#tab-scanner .sc-cmp { margin-top: 10px; }',
            '#tab-scanner .sc-cmp th, #tab-scanner .sc-cmp td { padding: 4px 8px; }',
            '#tab-scanner .sc-cmp thead th { color: var(--fg); font-weight: 650; text-align: right; }',
            '#tab-scanner .sc-cmp thead th:first-child { text-align: left; }',
            '#tab-scanner .sc-cmp td.sc-on { color: var(--accent); font-weight: 650; }',
            '#tab-scanner .sc-counts .sc-scan { color: var(--muted); font-weight: 400; font-family: var(--font-sans); font-size: 0.76rem; margin-left: 6px; }',
            '#tab-scanner .sc-sino-wrap { display: flex; justify-content: center; }',
            '#tab-scanner .sc-sino { display: block; border-radius: 6px; cursor: crosshair; background: var(--scope-bg); }',
            '#tab-scanner .sc-sino-axes { display: flex; justify-content: space-between; font: 0.72rem var(--font-mono); color: var(--muted); margin: 4px auto 0; }',
            '#tab-scanner .sc-sel { font-size: 0.8rem; line-height: 1.45; color: var(--muted); margin: 8px 0 10px; min-height: 2.9em; }',
            '#tab-scanner .sc-sel .mono { font-size: 0.76rem; }',
            '#tab-scanner .sc-sel strong { color: var(--fg); font-family: var(--font-sans); }',
            '#tab-scanner .sc-chain-host svg { display: block; width: 100%; height: auto; overflow: visible; }',
            '#tab-scanner .sc-part { cursor: pointer; outline: none; }',
            '#tab-scanner .sc-part .sc-box { fill: var(--card-2); stroke: var(--border-strong); stroke-width: 1.2; transition: stroke 0.12s ease; }',
            '#tab-scanner .sc-part:hover .sc-box { stroke: var(--accent); }',
            '#tab-scanner .sc-part[aria-pressed="true"] .sc-box { stroke: var(--accent); stroke-width: 2.2; fill: var(--accent-soft); }',
            '#tab-scanner .sc-part:focus-visible .sc-box { stroke: var(--focus); stroke-width: 3; }',
            '#tab-scanner .sc-part .sc-glow { pointer-events: none; }',
            '#tab-scanner .sc-label { fill: var(--fg); font: 650 12.5px var(--font-sans); letter-spacing: -0.01em; }',
            '#tab-scanner .sc-subl { fill: var(--muted); font: 10.5px var(--font-mono); }',
            '#tab-scanner .sc-num { fill: var(--muted); font: 700 9.5px var(--font-sans); }',
            '#tab-scanner .sc-ic { fill: none; stroke: var(--muted); stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }',
            '#tab-scanner .sc-ic-f { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.1; }',
            '#tab-scanner .sc-ic-a { fill: var(--accent); stroke: none; }',
            '#tab-scanner .sc-arrow { fill: none; stroke: var(--axis); stroke-width: 1.6; }',
            '#tab-scanner .sc-arrowhead { fill: var(--axis); }',
            '#tab-scanner .sc-info { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 12px; }',
            '#tab-scanner .sc-info-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 8px; }',
            '#tab-scanner .sc-info-head h3 { margin: 0; font-size: 0.95rem; }',
            '#tab-scanner .sc-info-grid { display: grid; gap: 10px 18px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); }',
            '#tab-scanner .sc-info-grid h4 { font-size: 0.68rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 0 0 3px; }',
            '#tab-scanner .sc-info-grid p { font-size: 0.84rem; line-height: 1.5; margin: 0; }',
            '#tab-scanner .sc-side-host svg { display: block; width: 100%; height: auto; }',
            '#tab-scanner .sc-side-host text { font-family: var(--font-sans); }',
            '#tab-scanner .sc-plots { margin-top: 16px; }',
            '#tab-scanner .sc-plots > .panel { margin-bottom: 0; }',
            '#tab-scanner .sc-mid > .panel { margin-bottom: 0; }',
            '#tab-scanner .sc-mid { margin-bottom: 0; }',
            '#tab-scanner .sc-simpl { margin-top: 16px; }',
            '#tab-scanner .panel-head .badge { font-family: var(--font-mono); }',
            '@media (max-width: 640px) { #tab-scanner .sc-well { padding: 6px; } #tab-scanner .sc-filters { gap: 6px 12px; } #tab-scanner .sc-toolbar .spacer { display: none; } }'
        ].join('\n'));
    }

    /* ---------- concept card ---------- */
    function buildConcept() {
        return PET.ui.w.concept({
            title: 'From decay to coincidence',
            body: '<p>A tracer molecule carries a positron emitter. When the nucleus decays, the positron zig-zags a short ' +
                'distance (its <em>range</em>: well under a millimetre for ¹⁸F, a few millimetres for ¹⁵O), meets an electron, ' +
                'and the two annihilate. Their mass becomes two 511 keV photons that fly apart almost exactly back to back.</p>' +
                '<p>The scanner never sees the annihilation, only two crystals lighting up at nearly the same time. If both ' +
                'photons arrive within the coincidence window, it records a <strong>coincidence</strong> and assumes the ' +
                'annihilation lies somewhere on the <strong>line of response</strong> (LOR) joining the crystals. Usually that ' +
                'is right (a <span class="sc-k sc-k-true">true</span>), but a photon may have scattered on its way out ' +
                '(<span class="sc-k sc-k-scatter">scatter</span>), or the two photons may come from two different decays ' +
                '(<span class="sc-k sc-k-random">random</span>).</p>',
            formula: '<div class="sc-formula"><span>E = m<sub>e</sub>c² = 511 keV</span>' +
                '<span>coincidence if |t<sub>A</sub> − t<sub>B</sub>| &lt; τ/2</span>' +
                '<span>time of flight: Δx = c·Δt / 2</span></div>',
            tryThis: [
                { html: 'Switch to <strong>¹⁵O</strong> and watch the 10× zoom: its positrons fly about five times farther than those of ¹⁸F, which blurs the image.',
                    label: 'Load [¹⁵O]water', run: function () { tryOxygen(); } },
                { html: 'Raise the energy window\'s <strong>lower level</strong> from 435 to 480 keV: fewer scattered photons pass, so orange LORs get rarer (and about a fifth of the trues are lost too, as the window starts to cut the photopeak).',
                    label: 'Toggle 435 / 480 keV', run: function () { toggleLLD(); } },
                { html: 'Toggle <strong>time of flight</strong> (on in most protocols): with it on, every true LOR gets a blob where the arrival-time difference places the annihilation, about 6 cm long for a 400 ps CTR. With it off, the randoms about double, because TOF also rejects randoms whose time difference does not fit its bins.',
                    label: 'Toggle TOF', run: function () { toggleTOF(); } },
                { html: 'With TOF off, <strong>widen the coincidence window</strong> from 4.5 to 9 ns: more unrelated singles share a window, so randoms (magenta) double and the flat floor of the time-difference histogram rises. With TOF on the wider window changes the randoms little, since only those that fit the TOF bins are kept.',
                    label: 'Toggle 4.5 / 9 ns', run: function () { toggleWindow(); } },
                { html: 'Compare <strong>2D and 3D</strong>: septa between the rings block oblique and scattered photons. Watch the side view and the counts.',
                    label: 'Toggle 2D / 3D', run: function () { toggleMode(); } }
            ]
        });
    }

    /* Edit one statement of the protocol source (replace the line that
       starts with the keyword, or append one), then let the app compile
       and re-scan as it does for any other edit. */
    function editStatement(keyword, statement) {
        const st = PET.state;
        if (!st || !PET.actions || typeof PET.actions.setSource !== 'function' || !PET.dsl) {
            notify('The protocol cannot be changed here because the protocol compiler is not available.', 'warn');
            return false;
        }
        const src = st.source || '';
        const re = new RegExp('^([ \\t]*)' + keyword + '\\b([^#\\n]*)(#[^\\n]*)?$', 'm');
        const next = re.test(src)
            ? src.replace(re, function (m, ind, body, comment) { return ind + statement + (comment ? '   ' + comment : ''); })
            : src.replace(/\s*$/, '') + '\n' + statement + '\n';
        PET.actions.setSource(next);
        const prog = st.program;
        if (prog && !prog.ok) notify('The protocol did not compile after that change. See the Protocol tab.', 'warn');
        else notify('Protocol changed to "' + statement + '". ' + (st.autoRescan ? 'It re-scans by itself.' : 'Press Acquire to re-scan.'), 'info');
        return true;
    }
    function progNow() { return currentProgram().program; }
    function toggleLLD() { const p = progNow(); editStatement('energy', 'energy ' + (p.energy.lo < 470 ? 480 : 435) + ' keV .. ' + Math.round(p.energy.hi) + ' keV'); }
    function toggleWindow() { const p = progNow(); editStatement('coincidence', 'coincidence ' + (p.coincidence < 6.5e-9 ? '9 ns' : '4.5 ns')); }
    function toggleTOF() {
        const p = progNow();
        editStatement('tof', p.tof && p.tof.on ? 'tof off' : 'tof on ' + Math.round(((p.tof && p.tof.ctr) || 400e-12) * 1e12) + ' ps');
    }
    function toggleMode() { const p = progNow(); editStatement('mode', 'mode ' + (p.acqMode === '2D' ? '3D' : '2D')); }
    function tryOxygen() {
        let ok = false;
        try {
            const has = PET.presets && (typeof PET.presets.get === 'function' ? PET.presets.get('water_dynamic') : null);
            if (has && PET.actions && PET.actions.loadPreset) ok = PET.actions.loadPreset('water_dynamic') !== false;
        } catch (e) { ok = false; }
        if (!ok) { notify('The [¹⁵O]water preset is not available.', 'warn'); return; }
        setZoom(true);
        notify('Loaded the [¹⁵O]water protocol, and turned on the 10× zoom.', 'info');
    }

    /* ---------- animation panel ---------- */
    const ICON_PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><rect x="2" y="1.5" width="2.8" height="9" rx="0.6" fill="currentColor"/><rect x="7.2" y="1.5" width="2.8" height="9" rx="0.6" fill="currentColor"/></svg>';
    const ICON_STEP = '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M1.8 1.5v9L8 6z" fill="currentColor"/><rect x="8.6" y="1.5" width="1.8" height="9" rx="0.5" fill="currentColor"/></svg>';

    function buildAnimPanel() {
        const panel = el('section', { class: 'panel sc-anim', 'aria-label': 'Coincidence animation' });
        S.dom.modeBadge = el('span', { class: 'badge badge-muted' });
        panel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', text: 'Coincidences, one decay at a time' }),
            el('span', { class: 'panel-sub', text: 'click an LOR to find it in the sinogram' }),
            el('span', { class: 'spacer' }), S.dom.modeBadge
        ]));

        const playBtn = el('button', { type: 'button', class: 'btn btn-sm btn-primary sc-play' });
        playBtn.addEventListener('click', function () { setPlaying(!S.playing); });
        const stepBtn = el('button', { type: 'button', class: 'btn btn-sm', html: ICON_STEP + '<span>Step</span>',
            title: 'Pause and play the next decay only', 'aria-label': 'Step: play the next decay' });
        stepBtn.addEventListener('click', stepOne);
        const speed = PET.ui.w.segmented({
            options: [{ value: 'slow', label: 'Slow' }, { value: 'medium', label: 'Medium' }, { value: 'fast', label: 'Fast' }],
            value: S.speed, ariaLabel: 'Animation speed', size: 'sm',
            onChange: function (v) { S.speed = v; drawOnce(); }
        });
        const keep = PET.ui.w.toggle({ label: 'Keep LORs', checked: S.keep, hint: 'Accumulate a faint line for every coincidence, so the object builds up',
            onChange: function (b) { S.keep = b; if (!b) clearKeepLayer(); drawOnce(); } });
        const zoom = PET.ui.w.toggle({ label: 'Zoom 10×', checked: S.zoom, hint: 'A magnified view of the latest annihilation: positron range is sub-millimetre for 18F',
            onChange: function (b) { S.zoom = b; drawOnce(); } });
        const clear = el('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Clear', title: 'Reset the counts, histograms, sinogram and kept LORs' });
        clear.addEventListener('click', function () { resetReadouts(); clearKeepLayer(); renderAllReadouts(); drawOnce(); });
        S.dom.playBtn = playBtn; S.dom.zoomToggle = zoom;
        panel.appendChild(el('div', { class: 'sc-toolbar' }, [playBtn, stepBtn, speed, el('span', { class: 'spacer' }), keep, zoom, clear]));
        syncPlayButton();

        const well = el('figure', { class: 'well sc-well' });
        const stage = el('div', { class: 'sc-stage' });
        const canvas = el('canvas', { class: 'sc-canvas', role: 'img',
            'aria-label': 'Animated PET ring: decays inside the object send pairs of photons to the detectors, and each coincidence is drawn as a line of response coloured by type' });
        const empty = el('div', { class: 'sc-empty', hidden: true });
        stage.appendChild(canvas); stage.appendChild(empty);
        well.appendChild(stage);
        canvas.addEventListener('click', onCanvasClick);
        S.dom.stage = stage; S.dom.canvas = canvas; S.dom.empty = empty;

        const filters = el('div', { class: 'sc-filters', role: 'group', 'aria-label': 'Event types shown' });
        [['true', 'Trues', 'var(--sev-true)', false], ['scatter', 'Scatters', 'var(--sev-scatter)', false], ['random', 'Randoms', 'var(--sev-random)', false],
            ['rejected', 'Rejected', 'var(--sev-rejected)', true]].forEach(function (f) {
            const cb = el('input', { type: 'checkbox' });
            cb.checked = S.show[f[0]];
            cb.addEventListener('change', function () { S.show[f[0]] = cb.checked; drawOnce(); });
            const lab = el('label', { class: 'sc-chk', title: f[0] === 'rejected'
                ? 'Events that make no coincidence: outside the energy window, outside the timing window, a multiple, or a single whose partner was lost'
                : 'Show ' + f[1].toLowerCase() }, [cb, el('span', { class: 'sc-sw' + (f[3] ? ' sc-sw-dash' : ''), style: { color: f[2] }, 'aria-hidden': 'true' }), f[1]]);
            filters.appendChild(lab);
        });
        filters.appendChild(el('span', { class: 'sc-sep', 'aria-hidden': 'true' }));
        filters.appendChild(el('span', { class: 'sc-key' }, [el('span', { class: 'sc-dot', style: { color: 'var(--sev-photon)' }, 'aria-hidden': 'true' }), '511 keV photon']));
        filters.appendChild(el('span', { class: 'sc-key' }, [el('span', { class: 'sc-dot', style: { color: 'var(--sev-scatter)' }, 'aria-hidden': 'true' }), 'scattered photon']));
        filters.appendChild(el('span', { class: 'sc-key' }, [el('span', { class: 'sc-dot', style: { color: 'var(--sev-positron)' }, 'aria-hidden': 'true' }), 'positron']));
        S.dom.tofKey = el('span', { class: 'sc-key', hidden: true }, [el('span', { class: 'sc-blob', 'aria-hidden': 'true' }), 'TOF position']);
        filters.appendChild(S.dom.tofKey);
        well.appendChild(filters);
        panel.appendChild(well);

        S.dom.caption = el('div', { class: 'sc-caption', 'aria-live': 'off' });
        panel.appendChild(S.dom.caption);
        setCaption(null);
        return panel;
    }
    function syncPlayButton() {
        const b = S.dom.playBtn;
        if (!b) return;
        b.innerHTML = (S.playing ? ICON_PAUSE : ICON_PLAY) + '<span>' + (S.playing ? 'Pause' : 'Play') + '</span>';
        b.setAttribute('aria-label', S.playing ? 'Pause the animation' : 'Play the animation');
        b.classList.toggle('btn-primary', !S.playing);
    }
    function setPlaying(b) {
        S.playing = !!b;
        if (S.playing) S.stepping = false;
        syncPlayButton();
        if (S.dom.caption) S.dom.caption.setAttribute('aria-live', S.playing ? 'off' : 'polite');
        if (S.playing) startLoop(); else { stopLoop(); drawOnce(); }
    }
    function setZoom(b) {
        S.zoom = !!b;
        if (S.dom.zoomToggle) S.dom.zoomToggle.set(S.zoom);
        drawOnce();
    }
    function showEmpty(msg) {
        if (!S.dom.empty) return;
        S.dom.empty.hidden = !msg;
        S.dom.empty.textContent = msg || '';
        if (msg) setCaption(null);
    }

    /* ---------- counts panel ---------- */
    const COUNT_ROWS = [
        { key: 'decays', label: 'Decays shown', cls: '' },
        { key: 'singles', label: 'Singles in the window', cls: '', hint: 'Photons detected with an energy inside the window. Each true uses two.' },
        { key: 'prompts', label: 'Prompts (coincidences)', cls: 'sc-strong', hint: 'Trues + scatters + randoms: what the scanner records' },
        { key: 'trues', label: 'Trues', sw: '--ev-true', cls: 'sc-sub' },
        { key: 'scatters', label: 'Scatters', sw: '--ev-scatter', cls: 'sc-sub' },
        { key: 'randoms', label: 'Randoms', sw: '--ev-random', cls: 'sc-sub' },
        { key: 'rejectedEnergy', label: 'Rejected: energy', sw: '--ev-rejected', dash: true, cls: '', hint: 'Both photons detected, but at least one outside the energy window' },
        { key: 'rejectedTime', label: 'Rejected: timing', sw: '--ev-rejected', dash: true, cls: '', hint: 'Both photons accepted, but further apart in time than half the coincidence window' },
        { key: 'multiples', label: 'Multiples', sw: '--ev-rejected', dash: true, cls: '', hint: 'Three or more singles in one coincidence window: all discarded' },
        { key: 'sf', label: 'Scatter fraction', cls: 'sc-frac', hint: 'S / (T + S)' },
        { key: 'rf', label: 'Randoms fraction', cls: 'sc-frac', hint: 'R / prompts' }
    ];
    function buildCountsPanel() {
        const panel = el('section', { class: 'panel sc-counts-panel', 'aria-label': 'Live counts' });
        panel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Live counts' }),
            el('span', { class: 'panel-sub', text: 'since the last change' })]));
        const table = el('table', { class: 'stat-table stat-table-compact sc-counts' });
        const body = el('tbody');
        S.dom.countCells = {};
        COUNT_ROWS.forEach(function (r) {
            const th = el('th', { scope: 'row', title: r.hint || null });
            if (r.sw) th.appendChild(el('span', { class: 'sc-sw' + (r.dash ? ' sc-sw-dash' : ''), style: { color: 'var(' + r.sw + ')' }, 'aria-hidden': 'true' }));
            th.appendChild(doc.createTextNode(r.label));
            const td = el('td', { text: '0' });
            S.dom.countCells[r.key] = td;
            body.appendChild(el('tr', { class: r.cls || null }, [th, td]));
        });
        table.appendChild(body);
        panel.appendChild(table);
        S.dom.countNote = el('p', { class: 'note mb-0 mt-1' });
        panel.appendChild(S.dom.countNote);
        return panel;
    }
    function renderTable() {
        if (!S.dom.countCells || !S.tally) return;
        const T = S.tally, c = S.dom.countCells;
        ['decays', 'singles', 'prompts', 'trues', 'scatters', 'randoms', 'rejectedEnergy', 'rejectedTime', 'multiples'].forEach(function (k) {
            c[k].textContent = U.fmtCounts(T[k]);
        });
        const ts = T.trues + T.scatters;
        const sf = ts > 0 ? T.scatters / ts : null, rf = T.prompts > 0 ? T.randoms / T.prompts : null;
        const tg = S.targets;
        const fill = function (td, v, t) {
            td.textContent = v === null ? '-' : pct(v);
            if (t !== null && t !== undefined && isFinite(t)) td.appendChild(el('span', { class: 'sc-scan', text: 'scan ' + pct(t) }));
        };
        fill(c.sf, sf, tg ? tg.sf : null);
        fill(c.rf, rf, tg ? tg.rf : null);
        const n = S.dom.countNote;
        if (!n) return;
        let txt;
        if (!S.info) txt = '';
        else if (S.info.phantomFallback) txt = 'The phantom module is not available, so a 20 cm water cylinder stands in for the object.';
        else if (S.info.source !== 'scan') txt = 'No scan yet, so the activity is approximate and the fractions come from the physics alone. Press Acquire for a scan to compare with.';
        else txt = 'Small numbers fluctuate. "scan" is the same fraction in your last acquisition' +
            (S.info.frame !== null && PET.state.acq && PET.state.acq.frames.length > 1 ? ' (frame ' + (S.info.frame + 1) + ')' : '') + '.';
        if (T.trues > 4) txt += ' Singles per true: ' + fmt(T.singles / T.trues, 1) + '.';
        n.textContent = txt;
    }

    /* ---------- mini sinogram panel ---------- */
    function buildSinoPanel() {
        const panel = el('section', { class: 'panel sc-sino-panel', 'aria-label': 'Sinogram filling in' });
        panel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'The sinogram, dot by dot' })]));
        panel.appendChild(el('p', { class: 'note', html: 'Each coincidence is one dot: its <strong>column</strong> is the distance r of the LOR from the centre, its <strong>row</strong> the angle θ. Click a dot to see its LOR on the ring.' }));
        const wrap = el('div', { class: 'sc-sino-wrap' });
        const c = el('canvas', { class: 'sc-sino', role: 'img', 'aria-label': 'Mini sinogram: one dot per coincidence, column r, row angle' });
        c.addEventListener('click', onSinoClick);
        wrap.appendChild(c);
        panel.appendChild(wrap);
        S.dom.sinoAxes = el('div', { class: 'sc-sino-axes' }, [el('span', { text: '−160 mm' }), el('span', { text: 'r →' }), el('span', { text: '+160 mm' })]);
        panel.appendChild(S.dom.sinoAxes);
        S.dom.sel = el('div', { class: 'sc-sel', 'aria-live': 'polite' });
        panel.appendChild(S.dom.sel);
        const link = el('button', { type: 'button', class: 'btn btn-sm btn-block', text: 'Open the full sinogram' });
        link.addEventListener('click', function () { if (PET.actions && PET.actions.showTab) PET.actions.showTab('sinogram'); });
        panel.appendChild(link);
        S.dom.sino = c;
        renderSelection();
        return panel;
    }

    /* ---------- detection chain panel ---------- */
    function lohi() { const p = progNow(); return { lo: Math.round(p.energy.lo), hi: Math.round(p.energy.hi) }; }
    function tauText() { return U.fmtTime(progNow().coincidence || 4.5e-9); }
    function ctrText() { const p = progNow(); return U.fmtTime((p.tof && p.tof.ctr) || 400e-12); }
    const PARTS = [
        { id: 'crystal', title: 'LYSO crystal block', sub: function () { return '4 × 4 × 20 mm'; },
            what: 'Stops the 511 keV photon and turns its energy into a brief flash of light (scintillation). Dense, bright, fast crystals make good PET detectors.',
            numbers: 'Crystals 4 × 4 × 20 mm, 8 per block on this ring (real blocks hold 8 × 8 or more). LYSO (7.1 g/cm³) stops about 80 % of 511 keV photons in 20 mm, gives about 30 000 light photons per MeV, and its flash decays in about 40 ns. Its lutetium-176 is itself radioactive: about 300 background counts per second per cm³.',
            fails: 'A cracked, loose or badly wrapped crystal gives less light, so its events are lost or assigned to a neighbour.',
            artifact: 'Every LOR through that crystal has lower sensitivity: streaks or a ring pattern, unless normalisation corrects it.',
            tab: 'corrections', tabLabel: 'See normalisation' },
        { id: 'sipm', title: 'Light guide and SiPMs', sub: function () { return 'light to charge'; },
            what: 'Silicon photomultipliers (SiPMs) turn the light into a charge pulse. With one-to-one coupling each crystal has its own SiPM; with light sharing, a light guide spreads each flash over several SiPMs and Anger logic (the light-weighted centroid) decides which crystal fired. Some designs also estimate the depth of interaction (DOI).',
            numbers: 'SiPM pixels 3 to 4 mm, gain about a million, 40 to 50 % of light photons detected. The gain drifts with temperature, so detectors are cooled and recalibrated.',
            fails: 'A dead SiPM, or one whose gain drifts, mispositions events (Anger logic picks the wrong crystal) and shifts their measured energy.',
            artifact: 'A dead block leaves a wedge-shaped gap in the sinogram and streaks in the image. Without DOI, resolution worsens towards the edge of the field (parallax).',
            tab: 'corrections', tabLabel: 'Try a dead block' },
        { id: 'asic', title: 'Front-end ASIC', sub: function () { return 'energy + time stamp'; },
            what: 'A chip next to the SiPMs integrates each pulse to measure the energy, and a fast timing discriminator with a time-to-digital converter (TDC) stamps its arrival time.',
            numbers: function () { return 'Energy resolution about 11 % FWHM at 511 keV. Time stamps in steps of a few tens of picoseconds. Coincidence timing resolution (CTR) ' + ctrText() + ' FWHM in this protocol; the best current scanners reach about 200 ps.'; },
            fails: 'Worse timing widens the spread of the time differences of trues; a drifting energy calibration moves the photopeak relative to the window.',
            artifact: 'Less benefit from time of flight (noisier images), or lost trues and a wrong scatter estimate if the photopeak drifts out of the window.' },
        { id: 'singles', title: 'Singles processor', sub: function () { return 'crystal ID, sorting'; },
            what: 'Collects the time-stamped singles from every block, identifies the crystal, applies the energy and timing calibrations, and hands one time-ordered stream of singles on. Its singles rate per detector also gives a randoms estimate, R = τ·S<sub>1</sub>·S<sub>2</sub>.',
            numbers: function () {
                const T = S.tally;
                return 'Tens of millions of singles per second in a 3D whole-body scan, many times the coincidence rate.' +
                    (T && T.trues > 4 ? ' In this animation: ' + fmt(T.singles / T.trues, 1) + ' singles per true.' : '');
            },
            fails: 'At high activity, pulses overlap (pile-up) and the electronics are busy while they handle one (dead time).',
            artifact: 'Count losses at high activity, so SUVs come out too low unless dead time is corrected; pile-up distorts energies and positions.' },
        { id: 'energy', title: 'Energy window', sub: function () { const w = lohi(); return w.lo + ' to ' + w.hi + ' keV'; },
            what: 'Keeps a single only if its measured energy lies inside the window. A photon that scattered in the patient has lost energy, so the lower level rejects most of them. (Most scanners apply it to each single, before coincidence sorting, as drawn here.)',
            numbers: function () { const w = lohi(); return 'This protocol: ' + w.lo + ' to ' + w.hi + ' keV; clinical LYSO scanners use about 435 to 650 keV. A photon scattered by 30° still has 451 keV and passes: the window cannot reject small-angle scatter.'; },
            fails: 'A lower level set too low accepts more scatter; one set too high (or a drifting calibration) cuts into the photopeak and loses trues.',
            artifact: 'More scatter: a low-contrast haze and filled-in cold regions if scatter is not corrected. Fewer trues: noisier images.',
            tab: 'corrections', tabLabel: 'Scatter and its correction' },
        { id: 'coinc', title: 'Coincidence processor', sub: function () { return 'τ = ' + tauText(); },
            what: 'Pairs singles whose time stamps differ by less than half the window, |t<sub>A</sub> − t<sub>B</sub>| &lt; τ/2, between detectors whose LOR crosses the field of view. Three or more in one window (a multiple) are discarded. A second, delayed window, shifted far beyond τ, can only catch accidental pairs: its count estimates the randoms among the prompts.',
            numbers: function () { return 'This protocol: τ = ' + tauText() + '; modern LYSO scanners use 4 to 5 ns. The window must cover the flight-time difference across the field of view (up to about 1 ns each way for 32 cm) plus timing jitter.'; },
            fails: 'A wider window lets in more randoms; one narrower than the flight-time differences across the object loses trues from its edges.',
            artifact: 'Randoms add a smooth background (positive bias, less contrast) unless subtracted; too narrow a window darkens the edge of the object.',
            tab: 'corrections', tabLabel: 'Randoms and their correction' },
        { id: 'sorter', title: 'Sorter / histogrammer', sub: function () { return 'sinogram or list mode'; },
            what: 'Turns each accepted coincidence into an LOR (θ, r) and adds one count to that sinogram bin, or writes the event with its time stamp to a list-mode file. With time of flight, the time difference also picks a bin along the LOR.',
            numbers: 'Here: 192 angles × 160 radial bins of 2 mm, and with TOF 17 bins of 20 mm along each LOR. List mode keeps every event (gigabytes for a dynamic scan), so frames can be chosen after the scan.',
            fails: 'A wrong crystal map or dropped data put counts in the wrong bins or lose them.',
            artifact: 'Missing angles give streaks; a wrong map blurs or distorts the image.',
            tab: 'sinogram', tabLabel: 'Open the Sinogram tab' },
        { id: 'recon', title: 'Reconstruction', sub: function () { return 'corrections + OSEM'; },
            what: 'Applies the corrections (normalisation, attenuation, scatter, randoms, decay, dead time) and reconstructs the image with filtered backprojection or iterative OSEM, often with time of flight and resolution modelling.',
            numbers: 'A few OSEM iterations of 10 to 30 subsets; seconds to minutes per bed position.',
            fails: 'A misaligned attenuation map, a wrong scatter scaling, or too many or too few iterations.',
            artifact: 'Bright or dark edges where the mu map is shifted, noise that grows with iterations, or blur if stopped too early.',
            tab: 'recon', tabLabel: 'Open the Reconstruction tab' }
    ];
    function txt(v) { return typeof v === 'function' ? v() : v; }

    function buildChainPanel() {
        const panel = el('section', { class: 'panel sc-chain', 'aria-label': 'Detection chain' });
        panel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'The detection chain' }),
            el('span', { class: 'panel-sub', text: 'click a part; it lights up as events pass' })]));
        S.dom.chainHost = el('div', { class: 'sc-chain-host' });
        panel.appendChild(S.dom.chainHost);
        S.dom.info = el('div', { class: 'sc-info', 'aria-live': 'polite' });
        panel.appendChild(S.dom.info);
        return panel;
    }
    function svg(tag, attrs, parent) {
        const e = doc.createElementNS(SVGNS, tag);
        if (attrs) for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(e);
        return e;
    }
    function drawIcon(g, id, cx, cy) {
        const ic = function (tag, a) { return svg(tag, Object.assign({ class: 'sc-ic' }, a), g); };
        const f = function (tag, a) { return svg(tag, Object.assign({ class: 'sc-ic sc-ic-f' }, a), g); };
        if (id === 'crystal') {
            for (let q = 0; q < 8; q++) f('rect', { x: cx - 30 + q * 7.6, y: cy - 12, width: 6, height: 24, rx: 1 });
            ic('path', { d: 'M' + (cx + 6) + ' ' + (cy - 26) + ' L' + (cx + 4) + ' ' + (cy - 6) });
            svg('circle', { class: 'sc-ic-a', cx: cx + 4, cy: cy - 6, r: 2.6 }, g);
        } else if (id === 'sipm') {
            f('rect', { x: cx - 30, y: cy - 14, width: 60, height: 8, rx: 1.5 });
            for (let q = 0; q < 4; q++) ic('rect', { x: cx - 30 + q * 15.5, y: cy - 2, width: 13, height: 13, rx: 2 });
            ic('path', { d: 'M' + (cx - 22) + ' ' + (cy + 11) + ' v6 M' + (cx - 6) + ' ' + (cy + 11) + ' v6 M' + (cx + 9) + ' ' + (cy + 11) + ' v6 M' + (cx + 24) + ' ' + (cy + 11) + ' v6' });
        } else if (id === 'asic') {
            f('rect', { x: cx - 17, y: cy - 13, width: 34, height: 26, rx: 3 });
            let d = '';
            for (let q = 0; q < 4; q++) { const x = cx - 12 + q * 8; d += 'M' + x + ' ' + (cy - 13) + ' v-6 M' + x + ' ' + (cy + 13) + ' v6 '; }
            ic('path', { d: d });
            ic('path', { d: 'M' + (cx - 11) + ' ' + (cy + 5) + ' l5 -10 l4 8 l4 -4 l3 6 l6 0' });
        } else if (id === 'singles') {
            ic('path', { d: 'M' + (cx - 32) + ' ' + (cy + 10) + ' H' + (cx + 32) });
            [-26, -15, -11, 2, 14, 25].forEach(function (o, q) { svg('rect', { class: 'sc-ic-a', x: cx + o - 1.4, y: cy - 10 + (q % 2) * 4, width: 2.8, height: 20 - (q % 2) * 4, rx: 1 }, g); });
        } else if (id === 'energy') {
            f('rect', { x: cx - 2, y: cy - 16, width: 24, height: 30, rx: 2 });
            ic('path', { d: 'M' + (cx - 32) + ' ' + (cy + 14) + ' C' + (cx - 20) + ' ' + (cy + 4) + ' ' + (cx - 12) + ' ' + (cy + 6) + ' ' + (cx - 4) + ' ' + (cy + 8) +
                ' C' + (cx + 2) + ' ' + (cy + 9) + ' ' + (cx + 6) + ' ' + (cy - 16) + ' ' + (cx + 11) + ' ' + (cy - 16) +
                ' C' + (cx + 16) + ' ' + (cy - 16) + ' ' + (cx + 19) + ' ' + (cy + 14) + ' ' + (cx + 32) + ' ' + (cy + 14) });
        } else if (id === 'coinc') {
            ic('path', { d: 'M' + (cx - 32) + ' ' + (cy - 6) + ' H' + (cx - 10) + ' v-10 h4 v10 H' + (cx + 32) });
            ic('path', { d: 'M' + (cx - 32) + ' ' + (cy + 14) + ' H' + (cx - 3) + ' v-10 h4 v10 H' + (cx + 32) });
            f('rect', { x: cx - 16, y: cy - 21, width: 24, height: 39, rx: 2 });
        } else if (id === 'sorter') {
            for (let r = 0; r < 4; r++) for (let q = 0; q < 6; q++) {
                const on = Math.abs(Math.round(2.5 + 2.4 * Math.sin((r + 0.5) * 0.9)) - q) < 1;
                svg('rect', { class: on ? 'sc-ic sc-ic-f' : 'sc-ic', x: cx - 27 + q * 9, y: cy - 17 + r * 9, width: 7.5, height: 7.5, rx: 1 }, g);
            }
        } else if (id === 'recon') {
            ic('rect', { x: cx - 26, y: cy - 18, width: 52, height: 32, rx: 3 });
            ic('path', { d: 'M' + (cx - 8) + ' ' + (cy + 20) + ' h16' });
            f('ellipse', { cx: cx, cy: cy - 2, rx: 11, ry: 13 });
            svg('circle', { class: 'sc-ic-a', cx: cx - 3, cy: cy - 5, r: 3 }, g);
        }
    }
    /* Lay the chain out as a snake: 4 parts per row on wide screens, 2 on
       narrow ones, so the text stays readable at 360 px. */
    function layoutChain() {
        const host = S.dom.chainHost;
        if (!host) return;
        const hw = host.clientWidth || 600;
        const cols = hw < 470 ? 2 : (hw < 800 ? 3 : 4);
        if (cols === S.chainCols && host.firstChild) return;
        S.chainCols = cols;
        const bw = 156, bh = 98, gx = 22, gy = 34, m = 6;
        const rows = Math.ceil(PARTS.length / cols);
        const W = 2 * m + cols * bw + (cols - 1) * gx, H = 2 * m + rows * bh + (rows - 1) * gy;
        const root_ = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'group', 'aria-label': 'Detection chain, from crystal to reconstruction' });
        const defs = svg('defs', null, root_);
        const mk = svg('marker', { id: 'sc-ah', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
        svg('path', { d: 'M0 0 L10 5 L0 10 z', class: 'sc-arrowhead' }, mk);
        const pos = PARTS.map(function (p, i) {
            const r = Math.floor(i / cols), c0 = i % cols, c = r % 2 === 0 ? c0 : cols - 1 - c0;
            return { x: m + c * (bw + gx), y: m + r * (bh + gy), r: r };
        });
        // arrows first, under the boxes
        for (let i = 0; i < PARTS.length - 1; i++) {
            const a = pos[i], b = pos[i + 1];
            let d;
            if (a.r === b.r) {
                const dir = b.x > a.x ? 1 : -1;
                const x1 = dir > 0 ? a.x + bw : a.x, x2 = dir > 0 ? b.x : b.x + bw, y = a.y + bh / 2;
                d = 'M' + (x1 + 2 * dir) + ' ' + y + ' H' + (x2 - 3 * dir);
            } else {
                const x = a.x + bw / 2;
                d = 'M' + x + ' ' + (a.y + bh + 2) + ' V' + (b.y - 3);
            }
            svg('path', { d: d, class: 'sc-arrow', 'marker-end': 'url(#sc-ah)' }, root_);
        }
        S.dom.parts = [];
        PARTS.forEach(function (p, i) {
            const P = pos[i];
            const g = svg('g', { class: 'sc-part', tabindex: '0', role: 'button', 'aria-pressed': String(i === S.partSel),
                'aria-label': p.title + ': show what it does' }, root_);
            svg('rect', { class: 'sc-box', x: P.x, y: P.y, width: bw, height: bh, rx: 10 }, g);
            const glow = svg('rect', { class: 'sc-glow', x: P.x, y: P.y, width: bw, height: bh, rx: 10, fill: 'transparent', 'fill-opacity': 0, stroke: 'transparent', 'stroke-width': 2.5 }, g);
            svg('text', { class: 'sc-num', x: P.x + 9, y: P.y + 15 }, g).textContent = String(i + 1);
            drawIcon(g, p.id, P.x + bw / 2, P.y + 33);
            const t = svg('text', { class: 'sc-label', x: P.x + bw / 2, y: P.y + 72, 'text-anchor': 'middle' }, g);
            t.textContent = p.title;
            const s = svg('text', { class: 'sc-subl', x: P.x + bw / 2, y: P.y + 88, 'text-anchor': 'middle' }, g);
            s.textContent = txt(p.sub);
            const choose = function () { selectPart(i); };
            g.addEventListener('click', choose);
            g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
            S.dom.parts.push({ g: g, glow: glow, sub: s, level: 0, color: '' });
        });
        host.textContent = '';
        host.appendChild(root_);
        renderPartInfo();
    }
    function updateChainLabels() {
        if (!S.dom.parts) return;
        PARTS.forEach(function (p, i) { if (S.dom.parts[i]) S.dom.parts[i].sub.textContent = txt(p.sub); });
    }
    function selectPart(i) {
        S.partSel = i;
        (S.dom.parts || []).forEach(function (P, j) { P.g.setAttribute('aria-pressed', String(j === i)); });
        renderPartInfo();
    }
    function renderPartInfo() {
        const box = S.dom.info;
        if (!box) return;
        const p = PARTS[S.partSel];
        box.textContent = '';
        const head = el('div', { class: 'sc-info-head' }, [el('h3', { text: (S.partSel + 1) + '. ' + p.title }),
            el('span', { class: 'note', text: txt(p.sub) })]);
        if (p.tab && PET.actions && PET.actions.showTab) {
            const b = el('button', { type: 'button', class: 'btn btn-xs', text: p.tabLabel || 'Open' });
            b.addEventListener('click', function () { PET.actions.showTab(p.tab); });
            head.appendChild(el('span', { class: 'spacer', style: { flex: '1' } }));
            head.appendChild(b);
        }
        box.appendChild(head);
        box.appendChild(el('div', { class: 'sc-info-grid' }, [
            el('div', {}, [el('h4', { text: 'What it does' }), el('p', { html: txt(p.what) })]),
            el('div', {}, [el('h4', { text: 'Typical numbers' }), el('p', { html: txt(p.numbers) })]),
            el('div', {}, [el('h4', { text: 'When it goes wrong' }), el('p', { html: txt(p.fails) })]),
            el('div', {}, [el('h4', { text: 'What you see in the image' }), el('p', { html: txt(p.artifact) })])
        ]));
    }
    /* Light up the chain, stage by stage, in the colour of an event. */
    const STOP = { true: 7, scatter: 7, random: 7, 'rejected-energy': 4, 'rejected-time': 5, multiple: 5, single: 5 };
    function pulseChain(w) {
        const ev = w.ev;
        const anyDetected = ev.photons.some(function (p) { return p.fate === 'detected'; });
        if (!anyDetected) return;
        let stop = STOP[ev.kind];
        if (ev.kind === 'single' && !ev.photons.some(function (p) { return p.single; })) stop = 4;
        const color = cardColor(ev.kind);
        for (let j = 0; j <= stop; j++) S.pulses.push({ part: j, at: S.clock + j * 0.085 / Math.max(0.35, SPEED[S.speed]), color: color, reject: j === stop && stop < 7 });
        if (S.pulses.length > 200) S.pulses.splice(0, S.pulses.length - 200);
    }
    function pulseColorsReset() { (S.dom.parts || []).forEach(function (P) { P.color = ''; }); }
    function updateChain() {
        const parts = S.dom.parts;
        if (!parts) return;
        const lv = parts.map(function () { return { v: 0, c: '' }; });
        const keep = [];
        S.pulses.forEach(function (p) {
            const age = (S.clock - p.at) / Math.max(0.35, SPEED[S.speed]);
            if (age < 0) { keep.push(p); return; }
            const v = Math.exp(-age / 0.28);
            if (v < 0.02) return;
            keep.push(p);
            if (v > lv[p.part].v) lv[p.part] = { v: v, c: p.color };
        });
        S.pulses = keep;
        parts.forEach(function (P, j) {
            const L = lv[j];
            if (Math.abs(L.v - P.level) < 0.015 && (L.c === P.color || !L.v)) return;
            P.level = L.v;
            if (L.c && L.c !== P.color) { P.color = L.c; P.glow.setAttribute('fill', L.c); P.glow.setAttribute('stroke', L.c); }
            P.glow.setAttribute('fill-opacity', (0.28 * L.v).toFixed(3));
            P.glow.setAttribute('stroke-opacity', L.v.toFixed(3));
        });
    }

    /* ---------- side view (2D / 3D) ---------- */
    function buildSidePanel() {
        const panel = el('section', { class: 'panel sc-sidepanel', 'aria-label': '2D and 3D acquisition, side view' });
        const seg = PET.ui.w.segmented({ options: [{ value: '2D', label: '2D' }, { value: '3D', label: '3D' }], value: '3D', size: 'sm',
            ariaLabel: 'Show the side view in 2D or 3D mode',
            onChange: function (v) { S.sideMode = v; S.sideModeAuto = false; renderSide(); } });
        S.dom.sideSeg = seg;
        S.dom.sideBadge = el('span', { class: 'badge badge-muted' });
        panel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Side view: 2D and 3D' }),
            el('span', { class: 'spacer' }), S.dom.sideBadge, seg]));
        S.dom.sideHost = el('div', { class: 'sc-side-host' });
        panel.appendChild(S.dom.sideHost);
        S.dom.sideCap = el('p', { class: 'note mt-1 mb-0' });
        panel.appendChild(S.dom.sideCap);
        S.dom.sideTable = el('div');
        panel.appendChild(S.dom.sideTable);
        renderSide();
        return panel;
    }
    function renderSide() {
        const host = S.dom.sideHost;
        if (!host) return;
        const progMode = progNow().acqMode === '2D' ? '2D' : '3D';
        const mode = S.sideMode || progMode;
        if (S.dom.sideSeg) S.dom.sideSeg.set(mode);
        S.dom.sideBadge.textContent = 'protocol: ' + progMode;
        const W = 420, H = 262;
        const sv = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img',
            'aria-label': mode === '2D' ? 'Side view in 2D mode: septa between the rings block oblique and scattered photons'
                : 'Side view in 3D mode: no septa, oblique and scattered photons reach other rings' });
        const cv = function (n, fb) { return U.cssVar(n, fb); };
        const fg = cv('--fg', '#161b22'), muted = cv('--muted', '#586170'), faint = cv('--faint', '#8a93a2'), border = cv('--border-strong', '#c5ccd6');
        const cTrue = cv('--ev-true', '#2a78d6'), cSc = cv('--ev-scatter', '#d9541e'), cRej = cv('--ev-rejected', '#8a93a2'), acc = cv('--accent', '#2563eb');
        const nR = 7, rw = 34, x0 = 91, topY = 34, botY = 206, cd = 22, sept = 46;
        const ringX = function (j) { return x0 + j * rw; };
        // gantry plates
        svg('rect', { x: x0 - 6, y: topY - 10, width: nR * rw + 12, height: 8, rx: 2, fill: border }, sv);
        svg('rect', { x: x0 - 6, y: botY + cd + 2, width: nR * rw + 12, height: 8, rx: 2, fill: border }, sv);
        for (let j = 0; j < nR; j++) {
            const hl = j === 3;
            [topY, botY].forEach(function (y) {
                svg('rect', { x: ringX(j) + 1.5, y: y, width: rw - 3, height: cd, rx: 2, fill: hl ? acc : faint, 'fill-opacity': hl ? 0.55 : 0.35,
                    stroke: hl ? acc : 'none', 'stroke-width': 1.2 }, sv);
            });
        }
        // patient
        svg('rect', { x: 18, y: 108, width: 384, height: 48, rx: 24, fill: cv('--accent-soft', 'rgba(37,99,235,0.08)'), stroke: border, 'stroke-width': 1 }, sv);
        const label = function (x, y, t, o) {
            const e = svg('text', Object.assign({ x: x, y: y, fill: muted, 'font-size': 12 }, o || {}), sv); e.textContent = t; return e;
        };
        label(28, 136, 'patient');
        label(ringX(3) + rw / 2, 17, 'our slice', { 'text-anchor': 'middle', fill: acc, 'font-weight': 650, 'font-size': 12.5 });
        // septa
        const septa = [];
        if (mode === '2D') {
            for (let j = 0; j <= nR; j++) {
                const x = ringX(j) - 1;
                svg('rect', { x: x, y: topY + cd, width: 2.4, height: sept, fill: muted }, sv);
                svg('rect', { x: x, y: botY - sept, width: 2.4, height: sept, fill: muted }, sv);
                septa.push({ x: x + 1.2, y0: topY + cd, y1: topY + cd + sept }, { x: x + 1.2, y0: botY - sept, y1: botY });
            }
            label(x0 + nR * rw + 8, topY + cd + 20, 'tungsten', { 'font-size': 11.5 });
            label(x0 + nR * rw + 8, topY + cd + 34, 'septa', { 'font-size': 11.5 });
        }
        // a ray from P towards E: in 2D it stops at the first septum it meets
        const blockAt = function (P, E) {
            if (mode !== '2D') return null;
            let best = null;
            septa.forEach(function (s) {
                if ((s.x - P.x) * (s.x - E.x) > 0 || Math.abs(E.x - P.x) < 1e-9) return;
                const t = (s.x - P.x) / (E.x - P.x), y = P.y + t * (E.y - P.y);
                if (y >= s.y0 && y <= s.y1 && t > 0 && t < 1 && (!best || t < best.t)) best = { t: t, x: s.x, y: y };
            });
            return best;
        };
        const drawRay = function (P, E, color) {
            const b = blockAt(P, E);
            const end = b ? { x: b.x, y: b.y } : E;
            svg('line', { x1: P.x, y1: P.y, x2: end.x, y2: end.y, stroke: b ? cRej : color, 'stroke-width': 2, 'stroke-dasharray': b ? '4 3' : null, 'stroke-linecap': 'round' }, sv);
            if (b) svg('path', { d: 'M' + (b.x - 4) + ' ' + (b.y - 4) + ' l8 8 M' + (b.x + 4) + ' ' + (b.y - 4) + ' l-8 8', stroke: cv('--bad', '#b91c1c'), 'stroke-width': 2 }, sv);
            else svg('circle', { cx: E.x, cy: E.y, r: 3.2, fill: color }, sv);
            return !b;
        };
        const yT = topY + cd, yB = botY;
        // 1. a direct LOR, within our ring: accepted in both modes
        const P1 = { x: ringX(3) + rw / 2, y: 130 };
        drawRay(P1, { x: P1.x, y: yT }, cTrue); drawRay(P1, { x: P1.x, y: yB }, cTrue);
        svg('circle', { cx: P1.x, cy: P1.y, r: 4, fill: fg }, sv);
        // 2. an oblique LOR, from ring 6 at the top to ring 4 at the bottom
        const top2 = { x: ringX(6) + 10, y: yT }, slope = -0.45;
        const at2 = function (y) { return top2.x + slope * (top2.y - y) * -1; };
        const P2 = { x: at2(136), y: 136 };
        drawRay(P2, top2, cTrue); drawRay(P2, { x: at2(yB), y: yB }, cTrue);
        svg('circle', { cx: P2.x, cy: P2.y, r: 4, fill: fg }, sv);
        // 3. scatter: one photon goes straight up in ring 1, the other scatters in the body towards ring 0
        const P3 = { x: ringX(1) + rw / 2, y: 118 }, K3 = { x: ringX(1) + rw / 2 + 4, y: 146 };
        drawRay(P3, { x: P3.x, y: yT }, cSc);
        svg('line', { x1: P3.x, y1: P3.y, x2: K3.x, y2: K3.y, stroke: cSc, 'stroke-width': 2, 'stroke-linecap': 'round' }, sv);
        drawRay(K3, { x: ringX(0) + 9, y: yB }, cSc);
        svg('circle', { cx: P3.x, cy: P3.y, r: 4, fill: fg }, sv);
        svg('circle', { cx: K3.x, cy: K3.y, r: 3, fill: 'none', stroke: cSc, 'stroke-width': 1.6 }, sv);
        // annotations under the lower bank
        const ann = function (x, y, t, anchor) { const e = svg('text', { x: x, y: y, fill: muted, 'font-size': 11.5, 'text-anchor': anchor || 'middle' }, sv); e.textContent = t; };
        ann(P1.x - 4, 254, 'direct', 'end');
        ann(at2(yB) + 2, 254, 'oblique', 'start');
        ann(ringX(0) + 9, 254, 'scattered', 'middle');
        ann(W - 6, 254, 'axial →', 'end');
        host.textContent = '';
        host.appendChild(sv);
        const f2 = mode2D();
        S.dom.sideCap.innerHTML = mode === '2D'
            ? '<strong>2D:</strong> tungsten septa between the rings absorb photons that travel obliquely, so only (nearly) in-plane LORs count, ' +
              'and they stop most scattered photons too. The price is sensitivity: about ' + frac(f2.sens) + ' of the trues of 3D.'
            : '<strong>3D:</strong> no septa, so every ring sees every other ring: about ' + Math.round(1 / f2.sens) + ' times the sensitivity of 2D, ' +
              'but scattered photons and singles from outside the slice get in too, so the scatter and randoms per true count rise.';
        const row = function (label, v2, hint) {
            return el('tr', {}, [el('th', { scope: 'row', title: hint || null, text: label }),
                el('td', { class: mode === '2D' ? 'sc-on' : null, text: v2 }), el('td', { class: mode === '3D' ? 'sc-on' : null, text: '1' })]);
        };
        S.dom.sideTable.textContent = '';
        S.dom.sideTable.appendChild(el('table', { class: 'stat-table stat-table-compact sc-cmp' }, [
            el('thead', {}, [el('tr', {}, [el('th', { text: 'relative to 3D' }), el('th', { text: '2D' }), el('th', { text: '3D' })])]),
            el('tbody', {}, [
                row('Trues (sensitivity)', '× ' + U.fmtNum(f2.sens, 2)),
                row('Scatter per true', '× ' + U.fmtNum(f2.scatter, 2), 'The scatter-to-true ratio'),
                row('Singles', '× ' + U.fmtNum(f2.singles, 2)),
                row('Randoms (∝ singles²)', '× ' + U.fmtNum(f2.singles * f2.singles, 2))
            ])
        ]));
        S.dom.sideTable.appendChild(el('p', { class: 'note mt-1 mb-0', text: 'Factors used by this simulator\'s acquisition engine, typical of real scanners.' }));
    }

    /* The engine's 2D factors (relative to 3D), or typical values. */
    function mode2D() {
        const m = PET.engine && PET.engine.CAL && PET.engine.CAL.MODE_2D;
        return { sens: m && m.sens > 0 ? m.sens : 0.2, scatter: m && m.scatter > 0 ? m.scatter : 0.35, singles: m && m.singles > 0 ? m.singles : 0.4 };
    }
    function frac(x) {
        const n = Math.round(1 / x);
        return Math.abs(1 / n - x) < 0.03 ? 'one ' + ({ 2: 'half', 3: 'third', 4: 'quarter', 5: 'fifth', 6: 'sixth', 8: 'eighth', 10: 'tenth' }[n] || ('in ' + n)) : U.fmtNum(100 * x, 2) + ' %';
    }

    /* ---------- plots ---------- */
    function buildPlotPanels() {
        const grid = el('div', { class: 'grid sc-plots', style: { '--min': '300px' } });
        const pe = el('section', { class: 'panel', 'aria-label': 'Measured energy histogram' });
        pe.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Measured energy of detected photons' })]));
        S.dom.ePlot = PET.ui.w.plot(pe, { height: 200, xlabel: 'Measured energy (keV)', ylabel: 'Photons', legend: true });
        pe.appendChild(el('p', { class: 'note mt-1 mb-0', html: 'Unscattered photons form the <strong>photopeak</strong> at 511 keV, blurred by the 11 % energy resolution. ' +
            'Photons that scattered in the body lost energy and spread into the lower <strong>Compton continuum</strong>. The dashed lines are the energy window.' }));
        const pt = el('section', { class: 'panel', 'aria-label': 'Coincidence time difference histogram' });
        pt.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Arrival-time differences' })]));
        S.dom.tPlot = PET.ui.w.plot(pt, { height: 200, xlabel: 't₂ − t₁ (ns)', ylabel: 'Pairs', legend: true });
        pt.appendChild(el('p', { class: 'note mt-1 mb-0', html: 'Trues bunch near zero: their spread is the difference in flight time across the object (that is the time-of-flight information) ' +
            'blurred by the timing resolution. Randoms are spread evenly across the window τ. 1 ns is 15 cm along the LOR.' }));
        grid.appendChild(pe); grid.appendChild(pt);
        return grid;
    }
    function stepSeries(edges, values) {
        const x = [], y = [];
        for (let b = 0; b < values.length; b++) { x.push(edges(b), edges(b + 1)); y.push(values[b], values[b]); }
        return { x: x, y: y };
    }
    function renderPlots() {
        if (!S.dom.ePlot || !S.eU) return;
        const p = progNow(), lo = p.energy.lo, hi = p.energy.hi;
        const eEdge = function (b) { return E_BINS.lo + b * E_BINS.w; };
        const u = stepSeries(eEdge, S.eU), s = stepSeries(eEdge, S.eS);
        const any = S.eU.some(function (v) { return v > 0; }) || S.eS.some(function (v) { return v > 0; });
        S.dom.ePlot.draw([
            { x: u.x, y: u.y, color: 'var(--ev-true)', label: 'photopeak (unscattered)', fill: 0.18, width: 1.5 },
            { x: s.x, y: s.y, color: 'var(--ev-scatter)', label: 'Compton continuum (scattered)', fill: 0.18, width: 1.5 }
        ], { xlim: [E_BINS.lo, E_BINS.hi], ylim: any ? undefined : [0, 1], includeZero: true,
            markers: [{ x: lo, label: Math.round(lo) + ' keV', color: 'var(--accent)' }, { x: hi, label: Math.round(hi) + ' keV', color: 'var(--accent)' }] });
        const R = S.tRange, tEdge = function (b) { return (-R + 2 * R * b / T_NBINS) * 1e9; };
        const a = stepSeries(tEdge, S.tSame), r = stepSeries(tEdge, S.tRand), j = stepSeries(tEdge, S.tRej);
        const tau = S.sim ? S.sim.params.tau : (p.coincidence || 4.5e-9);
        const hasRej = S.tRej.some(function (v) { return v > 0; });
        const anyT = hasRej || S.tSame.some(function (v) { return v > 0; }) || S.tRand.some(function (v) { return v > 0; });
        S.dom.tPlot.draw([
            { x: a.x, y: a.y, color: 'var(--ev-true)', label: 'trues and scatters', fill: 0.18, width: 1.5 },
            { x: r.x, y: r.y, color: 'var(--ev-random)', label: 'randoms', fill: 0.18, width: 1.5 },
            hasRej ? { x: j.x, y: j.y, color: 'var(--ev-rejected)', label: 'outside the window', dash: true, width: 1.5 } : null
        ], { xlim: [-R * 1e9, R * 1e9], ylim: anyT ? undefined : [0, 1], includeZero: true,
            xfmt: function (v) { return U.fmtNum(v, 2); },
            markers: [{ x: -tau / 2 * 1e9, label: '−τ/2', color: 'var(--accent)' }, { x: tau / 2 * 1e9, label: '+τ/2', color: 'var(--accent)' }] });
    }

    /* ============================================================
       Canvas: layout, static layers, colours
       ============================================================ */
    function colors() {
        if (S.colors) return S.colors;
        const v = function (n, f) { return U.cssVar(n, f); };
        S.colors = {
            bg: v('--scope-bg', '#0b0f17'), fg: v('--scope-fg', '#d6dde8'), muted: v('--scope-muted', '#8794a8'),
            grid: v('--scope-grid', '#1c2536'), axis: v('--scope-axis', '#3a4760'),
            true: v('--sev-true', '#4f9cf5'), scatter: v('--sev-scatter', '#f08a3c'), random: v('--sev-random', '#e05ad0'),
            rejected: v('--sev-rejected', '#5b6578'), photon: v('--sev-photon', '#f5d061'), positron: v('--sev-positron', '#5ee0d2'),
            font: v('--font-sans', 'system-ui, sans-serif'), mono: v('--font-mono', 'ui-monospace, monospace')
        };
        return S.colors;
    }
    function scopeColor(kind) {
        const c = colors();
        if (kind === 'true') return c.true;
        if (kind === 'scatter') return c.scatter;
        if (kind === 'random') return c.random;
        return c.rejected;
    }
    function cardColor(kind) {
        const n = kind === 'true' ? '--ev-true' : kind === 'scatter' ? '--ev-scatter' : kind === 'random' ? '--ev-random' : '--ev-rejected';
        return U.cssVar(n, '#8a93a2');
    }
    function makeLayer(size) {
        const c = doc.createElement('canvas'), dpr = root.devicePixelRatio || 1;
        c.width = Math.max(1, Math.round(size * dpr)); c.height = Math.max(1, Math.round(size * dpr));
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { canvas: c, ctx: ctx, size: size, dpr: dpr };
    }
    /* Size the square canvas to the space available: the full width of
       the well, but never taller than the window can show. */
    function layout(forceLayers) {
        const stage = S.dom.stage, canvas = S.dom.canvas;
        if (!stage || !canvas) return false;
        const avail = stage.clientWidth;
        if (!avail) return false;
        const vh = root.innerHeight || 800;
        const size = Math.max(220, Math.floor(Math.min(avail, Math.max(320, vh - 170), 820)));
        const dpr = root.devicePixelRatio || 1;
        const changed = size !== S.geo.size || dpr !== S.geo.dpr;
        if (changed) U.setupCanvas(canvas, size, size);
        S.geo = { size: size, cx: size / 2, cy: size / 2, k: (size / 2) / WORLD, dpr: dpr };
        if (changed || forceLayers || !S.layers.ring) {
            buildRingLayer();
            const old = S.layers.keep;
            S.layers.keep = makeLayer(size);
            if (old && S.keep) S.layers.keep.ctx.drawImage(old.canvas, 0, 0, size, size);
        }
        // the mini sinogram follows the side column's width
        sizeSino();
        return true;
    }
    function X(x) { return S.geo.cx + x * S.geo.k; }
    function Y(y) { return S.geo.cy + y * S.geo.k; }
    function crystalPath(ctx, c, r0, r1) {
        const G = PET.scanner.geom, phi = PET.scanner.crystalAngle(c), co = Math.cos(phi), si = Math.sin(phi);
        const hw = G.crystalWidth / 2, tx = -si * hw, ty = co * hw;
        ctx.moveTo(X(r0 * co + tx), Y(r0 * si + ty));
        ctx.lineTo(X(r1 * co + tx), Y(r1 * si + ty));
        ctx.lineTo(X(r1 * co - tx), Y(r1 * si - ty));
        ctx.lineTo(X(r0 * co - tx), Y(r0 * si - ty));
        ctx.closePath();
    }
    function buildRingLayer() {
        if (!PET.scanner) return;
        const size = S.geo.size, L = makeLayer(size), ctx = L.ctx, c = colors(), G = PET.scanner.geom, k = S.geo.k;
        const R = G.ringRadius, D = G.crystalDepth;
        // gantry housing
        ctx.beginPath(); ctx.arc(X(0), Y(0), (R + D + 16) * k, 0, 2 * Math.PI); ctx.arc(X(0), Y(0), (R - 4) * k, 0, 2 * Math.PI, true);
        ctx.fillStyle = 'rgba(120, 140, 175, 0.07)'; ctx.fill();
        // electronics band (SiPMs, light guides, ASICs) behind the crystals
        ctx.beginPath(); ctx.arc(X(0), Y(0), (R + D + 9) * k, 0, 2 * Math.PI); ctx.arc(X(0), Y(0), (R + D + 1) * k, 0, 2 * Math.PI, true);
        ctx.fillStyle = 'rgba(94, 224, 210, 0.13)'; ctx.fill();
        // crystals
        ctx.beginPath();
        for (let q = 0; q < G.nCrystals; q++) crystalPath(ctx, q, R, R + D);
        ctx.fillStyle = 'rgba(150, 175, 220, 0.30)'; ctx.fill();
        // block boundaries
        ctx.strokeStyle = c.bg; ctx.lineWidth = Math.max(1, 1.6 * k);
        ctx.beginPath();
        for (let b = 0; b < G.nBlocks; b++) {
            const phi = b * 2 * Math.PI / G.nBlocks, co = Math.cos(phi), si = Math.sin(phi);
            ctx.moveTo(X((R - 2) * co), Y((R - 2) * si)); ctx.lineTo(X((R + D + 10) * co), Y((R + D + 10) * si));
        }
        ctx.stroke();
        // outer edge
        ctx.strokeStyle = 'rgba(140, 160, 200, 0.25)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(X(0), Y(0), (R + D + 16) * k, 0, 2 * Math.PI); ctx.stroke();
        // image field of view
        ctx.setLineDash([3, 5]); ctx.strokeStyle = c.axis; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(X(0), Y(0), 160 * k, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
        if (size >= 340) {
            ctx.fillStyle = c.muted; ctx.globalAlpha = 0.8; ctx.font = '10px ' + c.font; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.fillText('field of view', X(0), Y(-160) - 3);
            ctx.globalAlpha = 1;
        }
        S.layers.ring = L;
    }
    /* The object, faintly: activity in the 'pet' colour map plus outlines
       wherever the attenuation changes. */
    function buildPhantomLayer() {
        S.layers.phantom = null;
        const sc = S.scene;
        if (!sc || !sc.phantom || !sc.emission) return;
        const ph = sc.phantom, n = ph.n, em = sc.emission, mu = ph.mu;
        const c = doc.createElement('canvas'); c.width = n; c.height = n;
        const ctx = c.getContext('2d'), img = ctx.createImageData(n, n), px = img.data;
        let mx = 0;
        for (let k = 0; k < em.length; k++) if (em[k] > mx) mx = em[k];
        const lut = U.colormapLUT('pet');
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const k = iy * n + ix, j = 4 * k;
            const t = mx > 0 ? em[k] / mx : 0;
            let edge = false;
            if (mu) {
                const m = mu[k];
                if ((ix + 1 < n && Math.abs(mu[k + 1] - m) > 5e-4) || (iy + 1 < n && Math.abs(mu[k + n] - m) > 5e-4) ||
                    (ix > 0 && Math.abs(mu[k - 1] - m) > 5e-4) || (iy > 0 && Math.abs(mu[k - n] - m) > 5e-4)) edge = true;
            }
            if (t > 0.002) {
                const li = Math.round(U.clamp(0.28 + 0.5 * Math.pow(t, 0.8), 0, 1) * 255) * 3;
                px[j] = lut[li]; px[j + 1] = lut[li + 1]; px[j + 2] = lut[li + 2]; px[j + 3] = Math.round(255 * (0.10 + 0.26 * t));
            }
            if (edge) {
                px[j] = 150; px[j + 1] = 170; px[j + 2] = 205;
                px[j + 3] = Math.max(px[j + 3], 95);
            }
        }
        ctx.putImageData(img, 0, 0);
        S.layers.phantom = { canvas: c, n: n, dx: ph.dx || (ph.fov / n) };
    }
    function clearKeepLayer() {
        const L = S.layers.keep;
        if (L) { L.ctx.save(); L.ctx.setTransform(1, 0, 0, 1, 0, 0); L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height); L.ctx.restore(); }
    }

    /* ============================================================
       Animation loop
       ============================================================ */
    function canAnimate() { return S.shown && !doc.hidden && !!S.sim && (S.playing || S.stepping); }
    function startLoop() {
        if (S.raf || !canAnimate()) return;
        S.last = 0;
        S.raf = root.requestAnimationFrame(frame);
    }
    function stopLoop() {
        if (S.raf) { root.cancelAnimationFrame(S.raf); S.raf = 0; }
    }
    function frame(ts) {
        S.raf = 0;
        if (!canAnimate()) return;
        const dt = S.last ? Math.min(0.1, Math.max(0, (ts - S.last) / 1000)) : 1 / 60;
        S.last = ts;
        try {
            advance(dt);
            draw();
            updateChain();
            slowUpdates(ts);
        } catch (e) {
            if (root.console) root.console.warn('[scanner tab] animation stopped:', e);
            S.playing = false; S.stepping = false; syncPlayButton();
            return;
        }
        if (canAnimate()) S.raf = root.requestAnimationFrame(frame);
        else { drawOnce(); renderAllReadouts(); }
    }
    function slowUpdates(ts) {
        if (ts - S.lastSlow < 250) return;
        S.lastSlow = ts;
        renderAllReadouts();
    }
    function renderAllReadouts() {
        if (S.dirty.table) { renderTable(); S.dirty.table = false; }
        if (S.dirty.plots) { renderPlots(); S.dirty.plots = false; }
        if (S.dirty.sino) { renderSino(); S.dirty.sino = false; }
    }
    function advance(dt) {
        const k = dt * SPEED[S.speed];
        S.clock += k;
        if (S.playing && S.sim) {
            const evs = S.sim.step(k), now = S.sim.now;
            evs.forEach(function (ev) { addEvent(ev, S.clock - (now - ev.t)); });
        } else if (S.stepping && S.clock >= S.stepUntil) {
            S.stepping = false;
        }
        // tally landings, retire finished events
        const keep = [];
        for (let i = 0; i < S.active.length; i++) {
            const w = S.active[i], age = S.clock - w.start;
            if (!w.tallied && age >= w.lorAt) {
                w.tallied = true;
                tallyEvent(w);
                if (w.visible) {
                    pulseChain(w);
                    if (S.keep && w.ev.lor && PROMPT[w.ev.kind] && w.ev.primary) keepLor(w);
                    // the partner of a random is described by the random itself
                    if (!(w.ev.kind === 'random' && !w.ev.primary && w.partner) &&
                        (!S.pendingCaption || PROMPT[w.ev.kind] || !PROMPT[S.pendingCaption.ev.kind])) S.pendingCaption = w;
                }
            }
            if (age < w.end || !w.tallied) keep.push(w);
            else S.byId.delete(w.ev.id);
        }
        S.active = keep;
        // Captions: the stepped event as soon as it lands; while playing, the
        // latest event that landed, but each caption stays up long enough to read.
        const nowMs = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
        if (S.captionFor && !S.captionShown && S.clock - S.captionFor.start >= S.captionFor.lorAt) {
            S.captionShown = true; setCaption(S.captionFor); S.captionWall = nowMs; S.pendingCaption = null;
        } else if (S.playing && S.pendingCaption) {
            const since = nowMs - (S.captionWall || 0), prompt = !!PROMPT[S.pendingCaption.ev.kind];
            if (since > (prompt ? 2600 : 6500)) { setCaption(S.pendingCaption); S.captionWall = nowMs; S.pendingCaption = null; }
        }
    }
    function isVisible(ev) { return !!S.show[GROUP[ev.kind]]; }
    /* Wrap an event for drawing: per-photon path lengths and the times
       (animation s after the decay) at which things happen. */
    function addEvent(ev, start) {
        const K = S.sim.timeScale;
        const ph = ev.photons.map(function (p) {
            const cum = [0];
            for (let j = 1; j < p.path.length; j++) cum.push(cum[j - 1] + Math.hypot(p.path[j].x - p.path[j - 1].x, p.path[j].y - p.path[j - 1].y));
            const total = cum[cum.length - 1];
            return { p: p, cum: cum, total: total, tEnd: T_POS + K * total / PET.const.C_MM_PER_S };
        });
        const land = Math.max(ph[0].tEnd, ph[1].tEnd);
        const w = { ev: ev, start: start, ph: ph, land: land, lorAt: land, end: 0, tallied: false, visible: isVisible(ev), partner: null };
        // a random's LOR appears when both singles (from two decays) have landed
        if (ev.kind === 'random') {
            const o = S.byId.get(ev.partner);
            if (o) linkRandom(w, o);
        }
        setLife(w);
        S.byId.set(ev.id, w);
        S.active.push(w);
        if (w.visible) S.latest = w;
        return w;
    }
    function pairedIndex(ev, lor) {
        for (let k = 0; k < 2; k++) { const p = ev.photons[k]; if (p.single && (p.crystal === lor.cA || p.crystal === lor.cB)) return k; }
        return ev.photons[0].single ? 0 : 1;
    }
    function linkRandom(a, b) {
        const P = a.ev.primary ? a : (b.ev.primary ? b : a), Q = P === a ? b : a;
        if (!P.ev.lor) return;
        P.partner = Q; Q.partner = P;
        if (P.tallied) return;          // already drawn: do not move its LOR
        const kp = pairedIndex(P.ev, P.ev.lor), kq = pairedIndex(Q.ev, P.ev.lor);
        const tP = P.start + P.ph[kp].tEnd, tQ = Q.start + Q.ph[kq].tEnd;
        P.lorAt = Math.max(tP, tQ) - P.start;
        P.lorAt = Math.max(P.lorAt, P.land);
        setLife(P);
    }
    function setLife(w) {
        const ev = w.ev;
        let life;
        if (PROMPT[ev.kind] && ev.lor && ev.primary) life = LIFE_LOR;
        else if (ev.lor && !PROMPT[ev.kind]) life = LIFE_REJ;
        else life = LIFE_SINGLE;
        w.end = w.lorAt + life;
    }
    function keepLor(w) {
        const L = S.layers.keep;
        if (!L) return;
        const ev = w.ev, l = ev.lor, ctx = L.ctx;
        ctx.save();
        ctx.globalAlpha = 0.09;
        ctx.strokeStyle = scopeColor(ev.kind);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
        ctx.restore();
    }

    /* Pause and play out the next decay (and a random's partner). Events
       of hidden kinds on the way are counted but not drawn. */
    function stepOne() {
        if (!S.sim || S.sim.empty) return;
        if (S.playing) setPlaying(false);
        let guard = 0, shown = null;
        while (!shown && guard++ < 400) {
            const evs = S.sim.next();
            if (!evs.length) break;
            const t0 = evs[0].t;
            evs.forEach(function (ev) {
                const w = addEvent(ev, S.clock + (ev.t - t0));
                if (!w.visible) { w.start = S.clock - w.end - 1; }      // already over: tallied on the next frame
                else if (!shown) shown = w;
            });
        }
        if (shown) {
            let until = shown.start + shown.lorAt + 0.9;
            if (shown.partner) until = Math.max(until, shown.partner.start + shown.partner.lorAt + 0.9);
            S.stepUntil = until;
            S.stepping = true;
            S.captionFor = shown; S.captionShown = false;
            startLoop();
        } else {
            advance(0); drawOnce(); renderAllReadouts();
        }
    }

    /* ============================================================
       Drawing
       ============================================================ */
    function drawOnce() {
        if (!S.shown || !S.dom.canvas) return;
        if (!S.geo.size && !layout(false)) return;
        try { draw(); } catch (e) { if (root.console) root.console.warn('[scanner tab] draw', e); }
    }
    function pointAt(P, d) {
        const path = P.p.path, cum = P.cum;
        if (d <= 0) return { x: path[0].x, y: path[0].y, j: 0 };
        for (let j = 1; j < cum.length; j++) {
            if (d <= cum[j]) {
                const f = (d - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
                return { x: path[j - 1].x + f * (path[j].x - path[j - 1].x), y: path[j - 1].y + f * (path[j].y - path[j - 1].y), j: j - 1 };
            }
        }
        const e = path[path.length - 1];
        return { x: e.x, y: e.y, j: path.length - 2 };
    }
    function draw() {
        const canvas = S.dom.canvas;
        if (!canvas || !S.geo.size) return;
        const ctx = canvas.getContext('2d'), size = S.geo.size, c = colors(), dpr = S.geo.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, size, size);
        // object
        const PL = S.layers.phantom;
        if (PL) {
            const half = PL.n / 2 * PL.dx;
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.globalAlpha = 1;
            ctx.drawImage(PL.canvas, X(-half - 0.5 * PL.dx), Y(-half - 0.5 * PL.dx), PL.n * PL.dx * S.geo.k, PL.n * PL.dx * S.geo.k);
            ctx.restore();
        }
        if (S.layers.ring) ctx.drawImage(S.layers.ring.canvas, 0, 0, size, size);
        if (S.keep && S.layers.keep) ctx.drawImage(S.layers.keep.canvas, 0, 0, size, size);
        const list = S.active.filter(function (w) { return w.visible; });
        list.forEach(function (w) { drawLor(ctx, w); });
        list.forEach(function (w) { drawEventBody(ctx, w); });
        drawSelection(ctx);
        if (S.zoom) drawInset(ctx);
        drawHud(ctx);
    }
    function ease(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t; }
    function drawLor(ctx, w) {
        const ev = w.ev, age = S.clock - w.start;
        if (!ev.lor || age < w.lorAt) return;
        if (ev.kind === 'random' && !ev.primary) return;
        if (ev.kind === 'single') return;
        const life = w.end - w.lorAt, t = (age - w.lorAt) / life;
        if (t >= 1) return;
        const prompt = !!PROMPT[ev.kind];
        const fadeIn = ease((age - w.lorAt) / 0.12);
        const a = fadeIn * (1 - t) * (1 - t * 0.3);
        const l = ev.lor, col = scopeColor(ev.kind);
        ctx.save();
        if (prompt) {
            // soft glow under a crisp line
            ctx.globalAlpha = 0.22 * a; ctx.strokeStyle = col; ctx.lineWidth = 6; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
            ctx.globalAlpha = a; ctx.lineWidth = 1.8;
            ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
            // time-of-flight kernel on trues
            if (ev.kind === 'true' && ev.tofPos && S.sim.params.tof) {
                const sig = S.sim.params.sigmaTOF, ang = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
                ctx.translate(X(ev.tofPos.x), Y(ev.tofPos.y));
                ctx.rotate(ang);
                ctx.scale(Math.max(2, sig * S.geo.k), Math.max(1.5, 3.2 * S.geo.k));
                const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 2.4);
                g.addColorStop(0, 'rgba(160, 205, 255, 0.95)'); g.addColorStop(0.35, 'rgba(79, 156, 245, 0.55)'); g.addColorStop(1, 'rgba(79, 156, 245, 0)');
                ctx.globalAlpha = a; ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, 2 * Math.PI); ctx.fill();
            }
        } else {
            ctx.globalAlpha = a; ctx.strokeStyle = colors().rejected; ctx.lineWidth = 1.7; ctx.setLineDash([6, 5]);
            ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
        }
        ctx.restore();
    }
    function drawEventBody(ctx, w) {
        const ev = w.ev, age = S.clock - w.start, c = colors(), k = S.geo.k;
        const dim = PROMPT[ev.kind] ? 1 : 0.75;
        // decay and positron
        const fadeDecay = 1 - ease((age - T_POS - 0.6) / 0.8);
        if (fadeDecay > 0) {
            ctx.save();
            const tr = ev.positron, f = ease(age / T_POS);
            if (tr && tr.length > 1) {
                ctx.globalAlpha = fadeDecay * 0.95; ctx.strokeStyle = c.positron; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
                ctx.beginPath(); ctx.moveTo(X(tr[0].x), Y(tr[0].y));
                const nseg = tr.length - 1, upto = f * nseg;
                for (let j = 1; j <= nseg; j++) {
                    if (j <= upto) ctx.lineTo(X(tr[j].x), Y(tr[j].y));
                    else { const g = upto - (j - 1); if (g > 0) ctx.lineTo(X(tr[j - 1].x + g * (tr[j].x - tr[j - 1].x)), Y(tr[j - 1].y + g * (tr[j].y - tr[j - 1].y))); break; }
                }
                ctx.stroke();
            }
            // the nucleus
            ctx.globalAlpha = fadeDecay;
            ctx.fillStyle = c.positron;
            ctx.beginPath(); ctx.arc(X(ev.decay.x), Y(ev.decay.y), age < 0.15 ? 3.2 : 2, 0, 2 * Math.PI); ctx.fill();
            ctx.restore();
        }
        // annihilation flash
        const fa = (age - T_POS) / 0.4;
        if (fa >= 0 && fa < 1) {
            const x = X(ev.annihilation.x), y = Y(ev.annihilation.y), r = 4 + 12 * fa;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, 'rgba(255, 255, 255, ' + (0.95 * (1 - fa)) + ')');
            g.addColorStop(0.4, 'rgba(245, 208, 97, ' + (0.7 * (1 - fa)) + ')');
            g.addColorStop(1, 'rgba(245, 208, 97, 0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
        }
        if (age < T_POS) return;
        const v = PET.const.C_MM_PER_S / S.sim.timeScale;     // mm per animation second: light, slowed
        for (let q = 0; q < 2; q++) {
            const P = w.ph[q], p = P.p;
            const d = (age - T_POS) * v;
            const dd = Math.min(d, P.total), done = d >= P.total;
            const afterEnd = done ? (age - P.tEnd) : 0;
            let trailA = done ? 0.55 * (1 - ease(afterEnd / 0.9)) : 0.55;
            if (trailA <= 0.01 && done && p.fate !== 'detected') continue;
            // fading for photons that leave the slice or pass through the crystal
            const leaving = p.fate === 'axial' || p.fate === 'missed';
            const fl = leaving ? 1 - ease((dd / P.total - 0.55) / 0.45) : 1;
            ctx.save();
            ctx.lineCap = 'round';
            // trail
            if (trailA > 0.01) {
                for (let j = 0; j < P.cum.length - 1; j++) {
                    if (P.cum[j] >= dd) break;
                    const a = p.path[j], bEnd = P.cum[j + 1] <= dd ? p.path[j + 1] : pointAt(P, dd);
                    ctx.strokeStyle = p.scattered && j >= 1 ? c.scatter : c.photon;
                    ctx.globalAlpha = trailA * dim * (leaving ? Math.max(0.15, fl) : 1) * 0.6;
                    ctx.lineWidth = 1.1;
                    ctx.beginPath(); ctx.moveTo(X(a.x), Y(a.y)); ctx.lineTo(X(bEnd.x), Y(bEnd.y)); ctx.stroke();
                }
            }
            // scatter kink marker
            if (p.scattered && p.scatterAt && dd >= P.cum[1]) {
                const since = (dd - P.cum[1]) / v;
                const ka = 1 - ease(since / 1.2);
                if (ka > 0) {
                    ctx.globalAlpha = ka; ctx.strokeStyle = c.scatter; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.arc(X(p.scatterAt.x), Y(p.scatterAt.y), 4 + 5 * (1 - ka), 0, 2 * Math.PI); ctx.stroke();
                }
            }
            // head
            if (!done) {
                const h = pointAt(P, dd), col = p.scattered && h.j >= 1 ? c.scatter : c.photon;
                const tail = pointAt(P, Math.max(0, dd - 26));
                const hx = X(h.x), hy = Y(h.y);
                const g = ctx.createLinearGradient(X(tail.x), Y(tail.y), hx, hy);
                g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, col);
                ctx.globalAlpha = fl * dim; ctx.strokeStyle = g; ctx.lineWidth = 2.4;
                ctx.beginPath(); ctx.moveTo(X(tail.x), Y(tail.y)); ctx.lineTo(hx, hy); ctx.stroke();
                const rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 7);
                rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.globalAlpha = 0.6 * fl * dim; ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(hx, hy, 7, 0, 2 * Math.PI); ctx.fill();
                ctx.globalAlpha = fl; ctx.fillStyle = '#fffbe8'; ctx.beginPath(); ctx.arc(hx, hy, 1.7, 0, 2 * Math.PI); ctx.fill();
            } else if (p.fate === 'absorbed') {
                const t = afterEnd / 0.7;
                if (t < 1) {
                    const e = p.path[p.path.length - 1];
                    ctx.globalAlpha = 1 - t; ctx.strokeStyle = p.scattered ? c.scatter : c.photon; ctx.lineWidth = 1.4;
                    const s = 3;
                    ctx.beginPath(); ctx.moveTo(X(e.x) - s, Y(e.y) - s); ctx.lineTo(X(e.x) + s, Y(e.y) + s);
                    ctx.moveTo(X(e.x) + s, Y(e.y) - s); ctx.lineTo(X(e.x) - s, Y(e.y) + s); ctx.stroke();
                }
            } else if (p.fate === 'detected') {
                const t = afterEnd / T_FLASH;
                if (t < 1) {
                    const col = p.scattered ? c.scatter : c.photon;
                    const G = PET.scanner.geom, R = G.ringRadius;
                    ctx.globalAlpha = (1 - t);
                    ctx.fillStyle = col;
                    ctx.beginPath(); crystalPath(ctx, p.crystal, R, R + G.crystalDepth); ctx.fill();
                    const phi = PET.scanner.crystalAngle(p.crystal), cx = X((R + 10) * Math.cos(phi)), cy = Y((R + 10) * Math.sin(phi));
                    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 16 * Math.max(0.6, k * 1.4));
                    rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.globalAlpha = 0.55 * (1 - t); ctx.fillStyle = rg;
                    ctx.beginPath(); ctx.arc(cx, cy, 16 * Math.max(0.6, k * 1.4), 0, 2 * Math.PI); ctx.fill();
                    if (!p.accepted) {
                        // measured outside the energy window: a small red tick on the crystal
                        ctx.globalAlpha = 1 - t; ctx.strokeStyle = '#f87171'; ctx.lineWidth = 1.6;
                        const ox = X((R + G.crystalDepth + 12) * Math.cos(phi)), oy = Y((R + G.crystalDepth + 12) * Math.sin(phi));
                        ctx.beginPath(); ctx.moveTo(ox - 3, oy - 3); ctx.lineTo(ox + 3, oy + 3); ctx.moveTo(ox + 3, oy - 3); ctx.lineTo(ox - 3, oy + 3); ctx.stroke();
                    }
                }
            }
            ctx.restore();
        }
    }
    function drawSelection(ctx) {
        const s = S.selected;
        if (!s) return;
        const l = s.lor, col = scopeColor(s.kind);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.35; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
        ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1)); ctx.lineTo(X(l.x2), Y(l.y2)); ctx.stroke();
        [[l.x1, l.y1], [l.x2, l.y2]].forEach(function (p) {
            ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 3.5, 0, 2 * Math.PI); ctx.fill();
        });
        // the foot of the perpendicular from the centre: |r| and θ, the sinogram coordinates
        const th = l.theta, r = l.r, fx = r * Math.cos(th), fy = r * Math.sin(th);
        ctx.setLineDash([3, 3]); ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(fx), Y(fy)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(X(0), Y(0), 2.5, 0, 2 * Math.PI); ctx.fill();
        if (S.geo.size >= 300) {
            ctx.font = '11px ' + colors().mono; ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.9;
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText('r = ' + fmt(r, 1) + ' mm', X(fx / 2) + 6, Y(fy / 2) - 8);
        }
        ctx.restore();
    }
    /* A 10x magnified view of the latest annihilation. Each event is held
       long enough to watch its positron fly and its photons leave before
       the inset moves on to the newest decay. */
    const INSET_HOLD = 2.0;
    function insetEvent() {
        const cur = S.insetW;
        if (cur && S.clock - cur.start < INSET_HOLD && S.clock >= cur.start) return cur;
        if (S.latest && S.latest !== cur && S.clock >= S.latest.start) S.insetW = S.latest;
        return S.insetW || null;
    }
    function drawInset(ctx) {
        const w = insetEvent(), size = S.geo.size;
        const box = Math.round(U.clamp(size * 0.3, 104, 210)), m = 8, bx = size - box - m, by = m;
        const zk = 10 * S.geo.k, c = colors();
        ctx.save();
        // inset frame
        ctx.fillStyle = '#060a12'; ctx.strokeStyle = 'rgba(170, 190, 220, 0.45)'; ctx.lineWidth = 1;
        roundRect(ctx, bx, by, box, box, 7); ctx.fill(); ctx.stroke();
        if (!w) {
            ctx.fillStyle = c.muted; ctx.font = '11px ' + c.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('10× zoom', bx + box / 2, by + box / 2 - 7); ctx.fillText('waiting for a decay', bx + box / 2, by + box / 2 + 9);
            ctx.restore(); return;
        }
        const ev = w.ev, age = S.clock - w.start, ax = ev.annihilation.x, ay = ev.annihilation.y;
        const ccx = (ev.decay.x + ax) / 2, ccy = (ev.decay.y + ay) / 2;
        const IX = function (x) { return bx + box / 2 + (x - ccx) * zk; }, IY = function (y) { return by + box / 2 + (y - ccy) * zk; };
        ctx.save();
        roundRect(ctx, bx, by, box, box, 7); ctx.clip();
        // the object under the event, magnified
        const PL = S.layers.phantom;
        if (PL) {
            const half = PL.n / 2 * PL.dx;
            ctx.globalAlpha = 0.35; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(PL.canvas, IX(-half - 0.5 * PL.dx), IY(-half - 0.5 * PL.dx), PL.n * PL.dx * zk, PL.n * PL.dx * zk);
            ctx.globalAlpha = 1;
        }
        // 1 mm grid
        ctx.strokeStyle = 'rgba(160, 180, 210, 0.10)'; ctx.lineWidth = 1;
        ctx.beginPath();
        const half = box / zk / 2;
        for (let g = Math.ceil(ccx - half); g <= ccx + half; g++) { ctx.moveTo(Math.round(IX(g)) + 0.5, by); ctx.lineTo(Math.round(IX(g)) + 0.5, by + box); }
        for (let g = Math.ceil(ccy - half); g <= ccy + half; g++) { ctx.moveTo(bx, Math.round(IY(g)) + 0.5); ctx.lineTo(bx + box, Math.round(IY(g)) + 0.5); }
        ctx.stroke();
        // photons leaving
        if (age >= T_POS) {
            const fa = 1 - ease((age - T_POS - 0.8) / 1.0);
            if (fa > 0) {
                ctx.globalAlpha = 0.85 * fa; ctx.lineWidth = 2; ctx.strokeStyle = c.photon; ctx.lineCap = 'round';
                const grow = ease((age - T_POS) / 0.25);
                ev.photons.forEach(function (p) {
                    const a = p.path[0], b = p.path[1], L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
                    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, len = grow * box / zk;
                    ctx.beginPath(); ctx.moveTo(IX(ax), IY(ay)); ctx.lineTo(IX(ax + ux * len), IY(ay + uy * len)); ctx.stroke();
                });
            }
        }
        // positron track
        const tr = ev.positron;
        if (tr && tr.length > 1) {
            const f = ease(age / T_POS), nseg = tr.length - 1, upto = f * nseg;
            ctx.globalAlpha = 1; ctx.strokeStyle = c.positron; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(IX(tr[0].x), IY(tr[0].y));
            for (let j = 1; j <= nseg; j++) {
                if (j <= upto) ctx.lineTo(IX(tr[j].x), IY(tr[j].y));
                else { const g = upto - (j - 1); if (g > 0) ctx.lineTo(IX(tr[j - 1].x + g * (tr[j].x - tr[j - 1].x)), IY(tr[j - 1].y + g * (tr[j].y - tr[j - 1].y))); break; }
            }
            ctx.stroke();
        }
        // nucleus
        ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(IX(ev.decay.x), IY(ev.decay.y), 2.6, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = c.positron; ctx.lineWidth = 1; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.arc(IX(ev.decay.x), IY(ev.decay.y), 4.4, 0, 2 * Math.PI); ctx.stroke();
        ctx.globalAlpha = 1;
        // annihilation point
        const fa2 = (age - T_POS) / 0.6;
        if (age >= T_POS) {
            const x = IX(ax), y = IY(ay), r = fa2 < 1 ? 5 + 14 * fa2 : 4;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            const al = fa2 < 1 ? 1 - 0.6 * fa2 : 0.4;
            g.addColorStop(0, 'rgba(255,255,255,' + al + ')'); g.addColorStop(0.5, 'rgba(245,208,97,' + (0.7 * al) + ')'); g.addColorStop(1, 'rgba(245,208,97,0)');
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
        }
        ctx.restore();
        // labels and scale bar
        ctx.font = '600 10.5px ' + c.font; ctx.fillStyle = c.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('10× zoom', bx + 7, by + 6);
        ctx.font = '10px ' + c.mono; ctx.fillStyle = c.positron; ctx.textAlign = 'right';
        ctx.fillText('range ' + fmt(ev.range, 2) + ' mm', bx + box - 7, by + 6);
        const sb = zk;      // 1 mm
        ctx.strokeStyle = c.fg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(bx + 8, by + box - 10); ctx.lineTo(bx + 8 + sb, by + box - 10); ctx.stroke();
        ctx.font = '10px ' + c.mono; ctx.fillStyle = c.fg; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('1 mm', bx + 12 + sb, by + box - 5);
        ctx.restore();
        // mark the magnified spot on the ring view
        const fx = X(ccx), fy = Y(ccy), hs = Math.max(4, box / 20);
        ctx.save();
        ctx.strokeStyle = 'rgba(200, 215, 240, 0.6)'; ctx.lineWidth = 1;
        ctx.strokeRect(fx - hs, fy - hs, 2 * hs, 2 * hs);
        ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.moveTo(fx + hs, fy - hs); ctx.lineTo(bx, by + box); ctx.stroke();
        ctx.restore();
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }
    function drawHud(ctx) {
        const c = colors(), size = S.geo.size, small = size < 560;
        const p = S.sim ? S.sim.params : null;
        if (size < 470) return;          // no room in the corners: the panel badge says it instead
        ctx.save();
        ctx.font = (small ? '10px ' : '11px ') + c.mono; ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        if (p) {
            let iso = p.isotope;
            try { iso = PET.isotopes.get(p.isotope).label; } catch (e) { /* keep the id */ }
            ctx.fillText(iso + ' · ' + Math.round(p.lo) + ' to ' + Math.round(p.hi) + ' keV', 10, 9);
            ctx.fillText('τ ' + U.fmtTime(p.tau) + ' · ' + (p.tof ? 'TOF ' + U.fmtTime(p.ctr) : 'no TOF') + ' · ' + p.mode, 10, small ? 22 : 24);
        }
        ctx.textBaseline = 'bottom';
        const cmPerS = 30 * SPEED[S.speed];
        ctx.fillText((S.playing ? '' : (S.stepping ? 'step · ' : 'paused · ')) + 'light: ' + U.fmtNum(cmPerS, 2) + ' cm per second', 10, size - 8);
        if (S.info && S.info.source !== 'scan') {
            ctx.textAlign = 'right';
            ctx.fillText(S.info.phantomFallback ? 'stand-in cylinder' : 'approximate activity', size - 10, size - 8);
        }
        ctx.restore();
    }

    /* ---------- captions ---------- */
    function nsText(dt) { const v = Math.abs(dt) * 1e9; return (v < 1 ? v.toFixed(2) : U.fmtNum(v, 3)) + ' ns'; }
    function lostWhy(p) {
        if (p.fate === 'axial') return p.scattered ? 'scattered out of the slice' : 'left the slice at an angle (it would hit another ring, or none)';
        if (p.fate === 'absorbed') return p.scattered ? 'scattered and was then absorbed in the body' : 'was absorbed in the body';
        if (p.fate === 'missed') return 'passed through the crystal without stopping';
        return 'was lost';
    }
    function describe(w) {
        const ev = w.ev, P = ev.photons, sp = S.sim ? S.sim.params : { lo: 435, hi: 650, tau: 4.5e-9 };
        const half = sp.tau / 2;
        const rng = ' Positron range ' + fmt(ev.range, 2) + ' mm.';
        switch (ev.kind) {
            case 'true':
                return 'Both 511 keV photons left the body without scattering and arrived ' + nsText(ev.dt) + ' apart, inside the ±' + nsText(half) +
                    ' window. The LOR passes through the annihilation point.' + (sp.tof ? ' Time of flight puts it within a few cm along the line (blue blob).' : '') + rng;
            case 'scatter': {
                const s = P.filter(function (p) { return p.scattered; });
                const l = ev.lor, a = ev.annihilation;
                const miss = Math.abs((l.x2 - l.x1) * (l.y1 - a.y) - (l.x1 - a.x) * (l.y2 - l.y1)) / Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
                const one = s[0];
                return (s.length > 1 ? 'Both photons Compton scattered; one' : 'One photon Compton scattered') + ' by ' + Math.round(one.scatterAngle * 180 / Math.PI) +
                    '° and kept ' + Math.round(one.energy) + ' keV (measured ' + Math.round(one.measured) + ' keV, inside the ' + Math.round(sp.lo) + ' to ' + Math.round(sp.hi) +
                    ' keV window), so the LOR misses the annihilation point by ' + fmt(miss, 0) + ' mm.' + rng;
            }
            case 'random':
                return 'Two different decays each lost a photon; their surviving photons arrived ' + nsText(ev.dt) + ' apart, inside the window, so the scanner joined two unrelated crystals. This LOR carries no information about either decay.';
            case 'rejected-energy': {
                const bad = P.filter(function (p) { return p.fate === 'detected' && !p.accepted; })[0];
                const below = bad && bad.measured < sp.lo;
                return 'A photon was measured at ' + (bad ? Math.round(bad.measured) : '?') + ' keV, ' + (below ? 'below the lower level (' + Math.round(sp.lo) + ' keV)' : 'above the upper level (' + Math.round(sp.hi) + ' keV)') +
                    (bad && bad.scattered ? ' after scattering by ' + Math.round(bad.scatterAngle * 180 / Math.PI) + '°' : '') + ', so the energy window rejected it. No coincidence.' + rng;
            }
            case 'rejected-time':
                return 'Both photons were detected, but ' + nsText(ev.dt) + ' apart: more than τ/2 = ' + nsText(half) + '. The coincidence window is too short for this pair, so it is lost.' + rng;
            case 'multiple':
                return 'Three or more singles fell into one coincidence window. The scanner cannot tell which two belong together, so it discards them all.';
            default: {
                const det = P.filter(function (p) { return p.fate === 'detected'; });
                if (ev.reason === 'fan') return 'Both photons were detected, but the line between the two crystals misses the field of view (one photon scattered a long way), so no coincidence is formed.';
                if (!det.length) {
                    const a = lostWhy(P[0]), b = lostWhy(P[1]);
                    return 'Neither photon reached a detector: ' + (a === b ? 'each ' + a : 'one ' + a + ', the other ' + b) +
                        '. Most decays in a patient end like this, which is why PET needs so many of them.' + rng;
                }
                const lost = P.filter(function (p) { return p.fate !== 'detected'; })[0];
                return 'Only one photon was detected' + (det[0].single ? '' : ' (and it was outside the energy window)') + ': the other ' + (lost ? lostWhy(lost) : 'was lost') +
                    '. A single on its own makes no LOR, but it still counts towards randoms and dead time.' + rng;
            }
        }
    }
    function setCaption(w) {
        const box = S.dom.caption;
        if (!box) return;
        box.textContent = '';
        if (!w) {
            box.appendChild(el('span', { class: 'muted', text: S.playing || S.stepping
                ? 'Watch a decay: the positron (teal) flies a short way, annihilates, and two photons (gold) race to the ring.'
                : 'Paused. Press Step to follow one decay from start to finish, or Play to let them run.' }));
            return;
        }
        const g = GROUP[w.ev.kind];
        box.appendChild(el('span', { class: 'badge sc-badge-' + g, text: KIND_LABEL[w.ev.kind] }));
        box.appendChild(el('span', { text: describe(w) }));
    }

    /* ---------- selection: LOR <-> sinogram ---------- */
    function onCanvasClick(e) {
        if (!S.geo.size) return;
        const rect = S.dom.canvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (S.geo.size / rect.width), my = (e.clientY - rect.top) * (S.geo.size / rect.height);
        const wx = (mx - S.geo.cx) / S.geo.k, wy = (my - S.geo.cy) / S.geo.k;
        let best = null, bd = 7 / S.geo.k;
        const consider = function (lor, kind, id) {
            const d = Math.abs((lor.x2 - lor.x1) * (lor.y1 - wy) - (lor.x1 - wx) * (lor.y2 - lor.y1)) / Math.hypot(lor.x2 - lor.x1, lor.y2 - lor.y1);
            if (d < bd) { bd = d; best = { lor: lor, kind: kind, id: id }; }
        };
        S.active.forEach(function (w) {
            const ev = w.ev, age = S.clock - w.start;
            if (w.visible && ev.lor && PROMPT[ev.kind] && ev.primary && age >= w.lorAt && age < w.end) consider(ev.lor, ev.kind, ev.id);
        });
        if (!best && (S.keep || !S.active.length)) {
            for (let q = S.dots.length - 1; q >= 0; q--) { const d = S.dots[q]; if (S.show[GROUP[d.kind]]) consider(d.lor, d.kind, d.id); }
        }
        if (!best) for (let q = S.dots.length - 1; q >= Math.max(0, S.dots.length - 40); q--) { const d = S.dots[q]; if (S.show[GROUP[d.kind]]) consider(d.lor, d.kind, d.id); }
        S.selected = best;
        renderSelection(); renderSino(); drawOnce();
    }
    function sinoGeom() {
        const c = S.dom.sino;
        if (!c) return null;
        const G = PET.scanner.geom;
        return { w: S.sinoW || 0, h: S.sinoH || 0, nR: G.nR, nA: G.nA };
    }
    function onSinoClick(e) {
        const g = sinoGeom();
        if (!g || !g.w) return;
        const rect = S.dom.sino.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (g.w / rect.width), my = (e.clientY - rect.top) * (g.h / rect.height);
        let best = null, bd = 9;
        for (let q = S.dots.length - 1; q >= 0; q--) {
            const d = S.dots[q];
            if (!S.show[GROUP[d.kind]]) continue;
            const x = (d.i + 0.5) / g.nR * g.w, y = (d.a + 0.5) / g.nA * g.h, dist = Math.hypot(x - mx, y - my);
            if (dist < bd) { bd = dist; best = d; }
        }
        S.selected = best ? { lor: best.lor, kind: best.kind, id: best.id } : null;
        renderSelection(); renderSino(); drawOnce();
    }
    function renderSelection() {
        const box = S.dom.sel;
        if (!box) return;
        const s = S.selected;
        box.textContent = '';
        if (!s) { box.appendChild(doc.createTextNode('Click an LOR on the ring or a dot here: both views show the same coincidence.')); return; }
        const l = s.lor;
        box.appendChild(el('strong', { class: 'sc-k sc-k-' + GROUP[s.kind], text: KIND_LABEL[s.kind] + ' coincidence' }));
        box.appendChild(el('br'));
        box.appendChild(el('span', { class: 'mono', text: 'θ = ' + fmt(l.theta * 180 / Math.PI, 1) + '°, r = ' + fmt(l.r, 1) + ' mm → row ' + l.a + ', column ' + l.i }));
        box.appendChild(el('br'));
        box.appendChild(doc.createTextNode('between crystals ' + l.cA + ' and ' + l.cB));
    }
    function sizeSino() {
        const c = S.dom.sino;
        if (!c || !PET.scanner) return;
        const host = c.parentNode, avail = host ? host.clientWidth : 0;
        if (!avail) return;
        const G = PET.scanner.geom;
        const w = Math.floor(Math.min(avail, 264)), h = Math.round(w * G.nA / G.nR);
        if (w !== S.sinoW || h !== S.sinoH) {
            U.setupCanvas(c, w, h); S.sinoW = w; S.sinoH = h;
            if (S.dom.sinoAxes) S.dom.sinoAxes.style.width = w + 'px';
        }
    }
    /* The scan's own prompts sinogram, faint, as a backdrop for the dots. */
    function buildSinoBackground() {
        S.layers.sinoBg = null;
        const st = PET.state || {}, acq = st.acq;
        if (!S.scene || !PET.scanner || !acqMatches(acq, S.scene.phantom)) return;
        const f = S.info && S.info.frame !== null ? S.info.frame : U.clamp(st.frame || 0, 0, acq.frames.length - 1);
        const F = acq.frames[f];
        if (!F || !F.prompts) return;
        const G = PET.scanner.geom, s = PET.scanner.sumTOF(F.prompts, (acq.geom && acq.geom.nT) || 1);
        if (s.length !== G.nA * G.nR) return;
        const hi = U.percentile(s, 99.5) || 1;
        const c = doc.createElement('canvas'); c.width = G.nR; c.height = G.nA;
        const ctx = c.getContext('2d'), img = ctx.createImageData(G.nR, G.nA);
        for (let k = 0; k < s.length; k++) {
            const v = Math.round(255 * U.clamp(s[k] / hi, 0, 1));
            img.data[4 * k] = 120; img.data[4 * k + 1] = 140; img.data[4 * k + 2] = 175; img.data[4 * k + 3] = Math.round(v * 0.42);
        }
        ctx.putImageData(img, 0, 0);
        S.layers.sinoBg = c;
    }
    function renderSino() {
        const cv = S.dom.sino;
        if (!cv || !S.shown || !PET.scanner) return;
        sizeSino();
        const w = S.sinoW, h = S.sinoH;
        if (!w || !h) return;
        const ctx = cv.getContext('2d'), c = colors(), G = PET.scanner.geom, dpr = root.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = c.bg; ctx.fillRect(0, 0, w, h);
        if (S.layers.sinoBg) { ctx.imageSmoothingEnabled = true; ctx.drawImage(S.layers.sinoBg, 0, 0, w, h); }
        // centre line r = 0
        ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(w / 2) + 0.5, 0); ctx.lineTo(Math.round(w / 2) + 0.5, h); ctx.stroke();
        const sx = w / G.nR, sy = h / G.nA, dsz = Math.max(2.4, Math.min(sx, sy) * 1.6);
        const groups = { true: [], scatter: [], random: [] };
        S.dots.forEach(function (d) { if (S.show[GROUP[d.kind]] && groups[d.kind]) groups[d.kind].push(d); });
        ['random', 'scatter', 'true'].forEach(function (k) {
            ctx.fillStyle = scopeColor(k); ctx.globalAlpha = 0.9;
            groups[k].forEach(function (d) { ctx.fillRect((d.i + 0.5) * sx - dsz / 2, (d.a + 0.5) * sy - dsz / 2, dsz, dsz); });
        });
        ctx.globalAlpha = 1;
        if (S.selected) {
            const l = S.selected.lor, x = (l.i + 0.5) * sx, y = (l.a + 0.5) * sy;
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke();
            ctx.globalAlpha = 0.35; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
            ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
        // axis hints
        ctx.font = '10px ' + c.mono; ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('θ = 0°', 4, 3);
        ctx.textBaseline = 'bottom'; ctx.fillText('θ = 180°', 4, h - 3);
        if (!S.dots.length) {
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = c.fg; ctx.globalAlpha = 0.8;
            ctx.fillText('waiting for coincidences', w / 2, h / 2);
            ctx.globalAlpha = 1;
        }
    }

    function updateStaticTexts() {
        const p = S.sim ? S.sim.params : null;
        if (S.dom.modeBadge) {
            let iso = p ? p.isotope : '';
            try { if (p) iso = PET.isotopes.get(p.isotope).label; } catch (e) { /* id */ }
            S.dom.modeBadge.textContent = p ? iso + ' · ' + p.mode : '';
            S.dom.modeBadge.hidden = !p;
        }
        if (S.dom.tofKey) S.dom.tofKey.hidden = !(p && p.tof);
        updateChainLabels();
        renderPartInfo();
        renderSide();
        S.dirty.table = S.dirty.plots = S.dirty.sino = true;
        renderAllReadouts();
    }

    /* ============================================================
       Tab hooks
       ============================================================ */
    function onShow() {
        if (!S.mounted) return;
        S.shown = true;
        S.colors = null;
        layout(true);
        layoutChain();
        if (S.needsRebuild || !S.sim) rebuild(false);
        renderSide();
        drawOnce();
        S.dirty.table = S.dirty.plots = S.dirty.sino = true;
        renderAllReadouts();
        startLoop();
    }
    function onHide() {
        S.shown = false;
        stopLoop();
    }

    PET.ui.registerTab({ id: 'scanner', title: 'Scanner', order: 10, mount: mount, onShow: onShow, onHide: onHide });

})(typeof window !== 'undefined' ? window : globalThis);
