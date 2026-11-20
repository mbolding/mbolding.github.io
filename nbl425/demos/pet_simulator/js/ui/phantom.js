/* ============================================================
   PET Simulator, Phantom tab
   The object being imaged. Two maps describe it completely as far as
   the scanner is concerned: where the tracer is (set by biology, or by
   whoever filled the phantom) and how strongly each tissue attenuates
   511 keV photons (mu). This tab lets students pick an object, read
   both maps pixel by pixel, see the mu map that attenuation
   correction actually used (shifted, rotated or without bone), see
   how far positrons travel before they annihilate, and look up every
   region's size, mu, concentration, SUV and kinetic parameters.

   Data sources, in order of preference:
     activity      acq.frames[frame].truth.regionMean of the last scan
                   when that scan is of this phantom and this protocol,
                   otherwise the decay-weighted frame mean of the
                   kinetic model (PET.actions.getTACs), which is the
                   same number the scan will report;
     mu used       acq.corrections.muCorr (only the scan knows it);
     annihilations PET.engine.frameEmission with positron range.
   Everything is drawn on the central 260 mm of the 320 mm raster,
   where every phantom fits, so the object fills the view.
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

    /* ---------- constants ---------- */
    const CROP_FRACTION = 0.8125;              // 208 of 256 pixels: 260 mm of the 320 mm field of view
    const MU_MAX_CM = 0.16;                    // display window for mu maps, 1/cm (bone is 0.151)
    const DIFF_MAX_CM = 0.1;                   // window of the mu difference map, 1/cm
    const PRESET_FOR = { point: 'point_res', cylinder: 'cyl_uniform', spheres: 'spheres_iq', rods: 'rods_f18', brain: 'fdg_static' };
    const PROFILE_Y = { point: 0, cylinder: 0, spheres: 0, rods: -40, brain: -6 };   // mm, a row through something worth seeing
    const TISSUE = { gm: 'gray matter', wm: 'white matter', csf: 'CSF', bone: 'bone', soft: 'soft tissue', blood: 'blood',
        water: 'water', air: 'air', lung: 'lung', plastic: 'acrylic (PMMA)' };
    const VIEWS = [
        { value: 'regions', label: 'Regions', title: 'Which region each pixel belongs to' },
        { value: 'activity', label: 'Activity', title: 'Tracer concentration in the frame shown, decay corrected' },
        { value: 'mu', label: 'μ map', title: 'Linear attenuation coefficient at 511 keV' },
        { value: 'mucorr', label: 'μ for correction', title: 'The mu map the scanner used for attenuation correction' },
        { value: 'range', label: 'Positron range', title: 'Where the positrons annihilate, blurred by their range' }
    ];

    /* ---------- tab state ---------- */
    const S = {
        mounted: false, visible: false,
        view: 'regions', unit: 'conc', cmap: 'pet', landmarks: true,
        corrMode: 'overlay', rangeIso: null, profileY: null, profilePhantom: null,
        hoverRegion: -1, pinnedRegion: -1, hoverPix: null,
        thumbsDone: {}, thumbKey: {}
    };
    const E = {};                 // DOM elements and widgets
    let PC = null;                // per-phantom cache (crops, colour rasters)
    let lastCtx = null;           // context of the last render

    /* ---------- small helpers ---------- */
    function hexRgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return [128, 128, 128];
        const v = parseInt(m[1], 16);
        return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
    function clock(s) {
        const neg = s < 0; s = Math.abs(s);
        let m = Math.floor(s / 60), r = Math.round(s - 60 * m);
        if (r === 60) { m++; r = 0; }
        return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }
    function frameLabel(fr, i, n) {
        if (!fr) return '';
        const span = clock(fr.t0) + ' to ' + clock(fr.t1) + ' min after injection';
        return n > 1 ? 'Frame ' + (i + 1) + ' of ' + n + ', ' + span : span;
    }
    function muCm(muPerMm) { return (muPerMm * 10).toFixed(3) + ' /cm'; }
    function fmtSig(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3) : '-'; }
    function sameOpts(a, b) { try { return JSON.stringify(a || {}) === JSON.stringify(b || {}); } catch (e) { return false; } }
    function currentProgram() { const s = st(); return s.program && s.program.ok ? s.program : (s.lastGoodProgram || null); }
    function errText(e) { return e && e.message ? e.message : String(e); }
    function isoLabel(id) { try { return PET.isotopes.get(id).label; } catch (e) { return id; } }
    function tracerInfo(id) { try { return id && PET.tracers ? PET.tracers.get(id) : null; } catch (e) { return null; } }
    function listPhantoms() { try { return PET.phantoms ? PET.phantoms.list() : []; } catch (e) { return []; } }

    /* ---------- the data behind every view ----------
       One object describing the phantom, protocol, curves, the scan (if
       it belongs to them) and the frame shown. */
    const meanCache = new WeakMap();
    function meansFromTacs(tacs, frame, fi) {
        let byFrame = meanCache.get(tacs);
        if (!byFrame) { byFrame = new Map(); meanCache.set(tacs, byFrame); }
        const key = fi + ':' + frame.t0 + ':' + frame.t1;
        if (byFrame.has(key)) return byFrame.get(key);
        let m = null;
        try { m = PET.kinetics.frameMeans(tacs, [frame])[0]; }
        catch (e) {
            // fall back to the curves at mid-frame
            const tm = (frame.t0 + frame.t1) / 2, k = U.clamp(Math.round(tm / (tacs.dt || 2)), 0, tacs.t.length - 1);
            m = Float64Array.from(tacs.regions.map(function (c) { return c ? c[k] : 0; }));
        }
        byFrame.set(key, m);
        return m;
    }
    function getContext() {
        const s = st();
        const C = { phantom: null, error: null, program: currentProgram(), tacs: null, tacsError: null, acq: null,
            frames: [], fi: 0, frame: null, means: null, source: '', dose: null, weight: 70 };
        if (!PET.actions || !PET.phantoms) { C.error = new Error('The phantom module (js/phantoms.js) did not load.'); return C; }
        try { C.phantom = PET.actions.getPhantom(); } catch (e) { C.error = e; return C; }
        if (C.program && PET.kinetics) { try { C.tacs = PET.actions.getTACs(); } catch (e) { C.tacsError = e; } }
        const acq = s.acq;
        if (acq && acq.frames && acq.frames.length && acq.phantomId === C.phantom.id && sameOpts(acq.phantomOpts, C.phantom.opts) &&
            (!C.program || acq.program === C.program)) {
            const tr = acq.frames[0].truth;
            if (tr && tr.regionMean && tr.regionMean.length === C.phantom.regions.length) C.acq = acq;
        }
        C.frames = C.acq ? C.acq.frames : (C.program && C.program.frames ? C.program.frames : []);
        C.fi = C.frames.length ? U.clamp(s.frame || 0, 0, C.frames.length - 1) : 0;
        C.frame = C.frames[C.fi] || null;
        if (C.program) { C.dose = C.program.dose; C.weight = C.program.weight || 70; }
        if (C.acq) { C.means = C.acq.frames[C.fi].truth.regionMean; C.source = 'scan'; }
        else if (C.tacs && C.frame) { C.means = meansFromTacs(C.tacs, C.frame, C.fi); C.source = 'model'; }
        C.suvFactor = C.dose > 0 ? C.weight * 1000 / C.dose : NaN;          // SUV per (Bq/mL)
        return C;
    }

    /* ---------- per-phantom cache ---------- */
    function cropOf(src, scale) {
        const n = PC.n, c0 = PC.c0, m = PC.m, out = new Float32Array(m * m), f = scale || 1;
        for (let y = 0; y < m; y++) {
            const so = (y + c0) * n + c0, oo = y * m;
            for (let x = 0; x < m; x++) out[oo + x] = src[so + x] * f;
        }
        return out;
    }
    function ensurePC(ph) {
        if (PC && PC.ph === ph) return PC;
        const n = ph.n, m = Math.round(n * CROP_FRACTION / 2) * 2, c0 = (n - m) / 2;
        PC = { ph: ph, n: n, m: m, c0: c0, h: Math.floor(n / 2), dx: ph.dx || (ph.fov / n), rgb: ph.regions.map(function (r) { return hexRgb(r.color); }),
            canvases: {}, emission: new Map(), corr: null };
        PC.label = new Float32Array(m * m);
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) PC.label[y * m + x] = ph.label[(y + c0) * n + x + c0];
        PC.mu = cropOf(ph.mu, 10);
        // pixel counts inside the crop decide whether a region is drawn as a dot (line sources)
        PC.small = ph.regions.map(function (r) { return r.pixels > 0 && r.pixels <= 4; });
        PC.centroid = ph.regions.map(function () { return { x: 0, y: 0, n: 0 }; });
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const c = PC.centroid[ph.label[iy * n + ix]];
            c.x += ix; c.y += iy; c.n++;
        }
        PC.centroid.forEach(function (c) { if (c.n) { c.x /= c.n; c.y /= c.n; } });
        return PC;
    }
    /* Region colours as an RGBA raster (air transparent). With a
       highlighted region the others are dimmed and it gets an outline. */
    function regionCanvas(hl) {
        const key = 'regions:' + hl;
        if (PC.canvases[key]) return PC.canvases[key];
        const m = PC.m, cv = doc.createElement('canvas');
        cv.width = m; cv.height = m;
        const c = cv.getContext('2d'), img = c.createImageData(m, m), px = img.data, lab = PC.label;
        for (let k = 0; k < m * m; k++) {
            const r = lab[k];
            if (r === 0) continue;
            const col = PC.rgb[r], dim = hl >= 0 && r !== hl ? 0.28 : 1;
            px[4 * k] = col[0] * dim; px[4 * k + 1] = col[1] * dim; px[4 * k + 2] = col[2] * dim; px[4 * k + 3] = 255;
        }
        if (hl >= 0) outlineInto(px, m, hl, [255, 255, 255]);
        c.putImageData(img, 0, 0);
        if (Object.keys(PC.canvases).length > 12) PC.canvases = {};
        return (PC.canvases[key] = cv);
    }
    function outlineInto(px, m, region, col) {
        const lab = PC.label;
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
            const k = y * m + x;
            if (lab[k] !== region) continue;
            const edge = x === 0 || y === 0 || x === m - 1 || y === m - 1 ||
                lab[k - 1] !== region || lab[k + 1] !== region || lab[k - m] !== region || lab[k + m] !== region;
            if (!edge) continue;
            px[4 * k] = col[0]; px[4 * k + 1] = col[1]; px[4 * k + 2] = col[2]; px[4 * k + 3] = 255;
        }
    }
    function outlineCanvas(region) {
        const key = 'outline:' + region;
        if (PC.canvases[key]) return PC.canvases[key];
        const m = PC.m, cv = doc.createElement('canvas');
        cv.width = m; cv.height = m;
        const c = cv.getContext('2d'), img = c.createImageData(m, m);
        outlineInto(img.data, m, region, [94, 224, 210]);          // cyan reads on every colour map
        c.putImageData(img, 0, 0);
        return (PC.canvases[key] = cv);
    }

    /* ---------- thumbnails for the picker ---------- */
    function drawThumb(canvas, ph) {
        const css = canvas.clientWidth || 96;
        const r = U.setupCanvas(canvas, css, css), ctx = r.ctx;
        ctx.fillStyle = U.cssVar('--scope-bg', '#0b0f17');
        ctx.fillRect(0, 0, r.w, r.h);
        const n = ph.n, m = Math.round(n * CROP_FRACTION / 2) * 2, c0 = (n - m) / 2;
        const off = doc.createElement('canvas');
        off.width = m; off.height = m;
        const oc = off.getContext('2d'), img = oc.createImageData(m, m), px = img.data;
        const rgb = ph.regions.map(function (q) { return hexRgb(q.color); });
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
            const l = ph.label[(y + c0) * n + x + c0];
            if (!l) continue;
            const k = 4 * (y * m + x), c = rgb[l];
            px[k] = c[0]; px[k + 1] = c[1]; px[k + 2] = c[2]; px[k + 3] = 255;
        }
        oc.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, 0, 0, m, m, 0, 0, r.w, r.h);
        // single-pixel sources would vanish at this size: draw them as dots
        ph.regions.forEach(function (q, i) {
            if (!(q.pixels > 0 && q.pixels <= 4) || q.cx === undefined) return;
            const fx = (q.cx / ph.dx + Math.floor(n / 2) - c0 + 0.5) / m * r.w, fy = (q.cy / ph.dx + Math.floor(n / 2) - c0 + 0.5) / m * r.h;
            ctx.fillStyle = q.color;
            ctx.beginPath(); ctx.arc(fx, fy, Math.max(2, r.w / 40), 0, 2 * Math.PI); ctx.fill();
        });
    }
    function thumbOptsFor(id) {
        const s = st();
        if (id === s.phantomId) return s.phantomOpts || {};
        const d = listPhantoms().find(function (p) { return p.id === id; });
        const o = {};
        (d && d.options || []).forEach(function (od) { o[od.key] = od.default; });
        return o;
    }
    /* Build and draw the thumbnails one per animation frame so the tab
       appears at once even though building a phantom takes a moment. */
    let thumbTimer = null;
    function scheduleThumbs() {
        if (thumbTimer || !E.cards) return;
        const queue = E.cards.map(function (c) { return c.id; });
        const step = function () {
            thumbTimer = null;
            while (queue.length) {
                const id = queue.shift();
                const card = E.cards.find(function (c) { return c.id === id; });
                if (!card) continue;
                const opts = thumbOptsFor(id), key = JSON.stringify(opts);
                if (S.thumbKey[id] === key && card.canvas.dataset.drawn === String(card.canvas.clientWidth)) continue;
                try {
                    const ph = PET.phantoms.build(id, opts);
                    drawThumb(card.canvas, ph);
                    S.thumbKey[id] = key;
                    card.canvas.dataset.drawn = String(card.canvas.clientWidth);
                } catch (e) { /* the card still works without a picture */ }
                if (queue.length) { thumbTimer = setTimeout(step, 16); return; }
            }
        };
        thumbTimer = setTimeout(step, 0);
    }

    /* ---------- condition explanations (brain) ----------
       The numbers are read from the kinetic model, so the text cannot
       drift away from what the simulator actually does. */
    function kin(tr, reg, cond) {
        try { const m = PET.kinetics.params(tr, reg, cond); return m ? Object.assign({}, m, PET.kinetics.derived(m)) : null; }
        catch (e) { return null; }
    }
    function pct(a, b) { return a && b && isFinite(a / b) ? Math.round(100 * a / b) + ' %' : '?'; }
    function num(v, d) { return isFinite(v) ? Number(v).toFixed(d === undefined ? 1 : d) : '?'; }
    function conditionFacts() {
        if (!PET.kinetics || !PET.kinetics.params) return null;
        const f = {};
        const fN = kin('FDG', 'gm_temporal', 'normal'), fA = kin('FDG', 'gm_temporal', 'ad');
        const wmN = kin('FDG', 'wm', 'normal');
        f.fdgK3 = fN && fA ? pct(fA.k3, fN.k3) : '?';
        f.fdgK1 = fN && fA ? pct(fA.K1, fN.K1) : '?';
        f.fdgKi = fN && fA ? pct(fA.Ki, fN.Ki) : '?';
        f.fdgGW = fN && wmN ? num(fN.Ki / wmN.Ki, 1) : '?';
        const pN = kin('PiB', 'gm_frontal', 'normal'), pF = kin('PiB', 'gm_frontal', 'ad'), pO = kin('PiB', 'gm_occipital', 'ad'), pS = kin('PiB', 'putamen_l_ant', 'ad');
        const bF = kin('florbetaben', 'gm_frontal', 'ad');
        f.pibN = pN ? num(pN.BPND, 2) : '?'; f.pibF = pF ? num(pF.BPND, 1) : '?'; f.pibO = pO ? num(pO.BPND, 1) : '?';
        f.pibS = pS ? num(pS.BPND, 1) : '?'; f.fbbF = bF ? num(bF.BPND, 1) : '?';
        const dN = kin('PE2I', 'putamen_l_post', 'normal'), eN = kin('FE-PE2I', 'putamen_l_post', 'normal');
        f.pe2i = dN ? num(dN.BPND, 1) : '?'; f.fepe2i = eN ? num(eN.BPND, 1) : '?';
        const r = function (id) { const a = kin('PE2I', id, 'pd'), b = kin('PE2I', id, 'normal'); return a && b ? pct(a.BPND, b.BPND) : '?'; };
        f.lp = r('putamen_l_post'); f.la = r('putamen_l_ant'); f.rp = r('putamen_r_post'); f.ra = r('putamen_r_ant');
        f.cl = r('caudate_l'); f.cr = r('caudate_r');
        const wG = kin('water', 'gm_frontal', 'normal'), wW = kin('water', 'wm', 'normal'), wT = kin('water', 'gm_temporal', 'ad'), wTn = kin('water', 'gm_temporal', 'normal');
        f.cbfG = wG ? num(wG.K1, 2) : '?'; f.cbfW = wW ? num(wW.K1, 2) : '?'; f.cbfT = wT && wTn ? pct(wT.K1, wTn.K1) : '?';
        return f;
    }
    const FAMILIES = [
        { id: 'fdg', tracers: ['FDG'], name: 'FDG', target: 'glucose use' },
        { id: 'amyloid', tracers: ['PiB', 'florbetaben'], name: 'PiB, florbetaben', target: 'amyloid plaques' },
        { id: 'dat', tracers: ['PE2I', 'FE-PE2I'], name: 'PE2I, FE-PE2I', target: 'dopamine transporter' },
        { id: 'water', tracers: ['water'], name: '[¹⁵O]water', target: 'blood flow' }
    ];
    function conditionText(fam, cond, f) {
        f = f || {};
        const T = {
            fdg: {
                normal: 'Gray matter takes up about ' + f.fdgGW + ' times as much FDG per minute as white matter (Ki), so cortex, striatum and thalamus are bright.',
                ad: 'Temporoparietal hypometabolism: in temporal cortex hexokinase (k3) falls to ' + f.fdgK3 + ' and transport (K1) to ' + f.fdgK1 + ' of normal, so Ki falls to ' + f.fdgKi + '. Frontal and occipital cortex are mildly lower.',
                pd: 'About normal at this level of the brain.'
            },
            amyloid: {
                normal: 'Little cortical binding (BPND ' + f.pibN + ' with PiB). White matter is bright from nonspecific retention, so a negative scan shows white matter, not cortex.',
                ad: 'Plaques in the cortex: BPND ' + f.pibF + ' in frontal and temporal cortex with PiB (' + f.fbbF + ' with florbetaben), ' + f.pibO + ' in occipital cortex and ' + f.pibS + ' in the striatum. The cortex becomes as bright as white matter.',
                pd: 'Normal: no amyloid.'
            },
            dat: {
                normal: 'Caudate and putamen are bright: BPND about ' + f.pe2i + ' with PE2I and ' + f.fepe2i + ' with FE-PE2I against cerebellar gray matter, which has almost no transporter.',
                ad: 'Normal: the dopamine terminals are intact.',
                pd: 'Loss of the dopamine transporter, worst in the posterior putamen and on the patient\'s left (the image right). BPND is ' + f.lp + ' of normal in the left posterior putamen, ' + f.la + ' left anterior, ' + f.rp + ' right posterior, ' + f.ra + ' right anterior; caudate ' + f.cl + ' left, ' + f.cr + ' right.'
            },
            water: {
                normal: 'Blood flow (K1) ' + f.cbfG + ' mL/min/mL in gray matter and ' + f.cbfW + ' in white matter.',
                ad: 'Temporal blood flow falls to ' + f.cbfT + ' of normal, following metabolism.',
                pd: 'Normal.'
            }
        };
        return (T[fam] && T[fam][cond]) || '';
    }

    /* ---------- styles ---------- */
    function addStyles() {
        PET.ui.addStyle([
            '#tab-phantom .ph-cards { --min: 180px; --gap: 10px; }',
            '#tab-phantom .ph-card { display: flex; flex-direction: column; align-items: stretch; gap: 8px; text-align: left; width: 100%; min-width: 0;',
            '  padding: 8px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; font: inherit;',
            '  transition: border-color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease; }',
            '#tab-phantom .ph-card:hover { border-color: var(--axis); background: var(--card-2); }',
            '#tab-phantom .ph-card[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent) inset; }',
            '#tab-phantom .ph-card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }',
            '#tab-phantom .ph-thumb { display: block; width: 100%; aspect-ratio: 1 / 1; max-height: 150px; object-fit: contain; border-radius: 6px; background: var(--scope-bg); }',
            '#tab-phantom .ph-card-name { display: flex; align-items: center; gap: 6px; font-weight: 650; font-size: 0.9rem; }',
            '#tab-phantom .ph-card-desc { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 0.78rem; line-height: 1.4; color: var(--muted); margin-top: 2px; }',
            '#tab-phantom .ph-card .badge { height: 18px; font-size: 0.66rem; }',
            '@media (max-width: 560px) {',
            '  #tab-phantom .ph-cards { --min: 100%; }',
            '  #tab-phantom .ph-card { flex-direction: row; align-items: center; }',
            '  #tab-phantom .ph-thumb { width: 64px; height: 64px; flex: none; }',
            '  #tab-phantom .ph-card-desc { -webkit-line-clamp: 2; }',
            '}',
            '#tab-phantom .ph-options { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-subtle); }',
            '#tab-phantom .ph-options-title { font-size: 0.82rem; font-weight: 650; margin: 0 0 8px; }',
            '#tab-phantom .ph-cond-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }',
            '#tab-phantom .ph-cond-list li { display: grid; grid-template-columns: minmax(110px, 170px) minmax(0, 1fr); gap: 4px 12px; padding: 7px 10px;',
            '  border-radius: 8px; background: var(--card-2); border: 1px solid var(--border-subtle); font-size: 0.84rem; line-height: 1.45; }',
            '#tab-phantom .ph-cond-list li.is-current { border-color: var(--accent-border); background: var(--accent-soft); }',
            '#tab-phantom .ph-cond-tracer { font-weight: 650; }',
            '#tab-phantom .ph-cond-tracer small { display: block; font-weight: 500; color: var(--muted); font-size: 0.76rem; }',
            '@media (max-width: 560px) { #tab-phantom .ph-cond-list li { grid-template-columns: minmax(0, 1fr); } }',
            '#tab-phantom .ph-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }',
            '#tab-phantom table.ph-grid { border-collapse: collapse; width: 100%; font-size: 0.82rem; }',
            '#tab-phantom table.ph-grid th, #tab-phantom table.ph-grid td { padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; text-align: left; }',
            '#tab-phantom table.ph-grid thead th { font-size: 0.74rem; font-weight: 650; color: var(--muted); white-space: nowrap; background: var(--card); position: sticky; top: 0; }',
            '#tab-phantom table.ph-grid td.n, #tab-phantom table.ph-grid th.n { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }',
            '#tab-phantom table.ph-grid .ph-col-cur { background: var(--accent-soft); }',
            '#tab-phantom table.ph-grid td.nw { white-space: nowrap; }',
            '#tab-phantom table.ph-regions tbody tr { cursor: pointer; }',
            '#tab-phantom table.ph-regions tbody tr:hover, #tab-phantom table.ph-regions tbody tr.is-hl { background: var(--hover); }',
            '#tab-phantom table.ph-regions tbody tr.is-hl td:first-child { box-shadow: inset 3px 0 0 var(--accent); }',
            '#tab-phantom table.ph-regions td:first-child, #tab-phantom table.ph-regions th:first-child { position: sticky; left: 0; background: var(--card); z-index: 1; }',
            '#tab-phantom table.ph-regions tbody tr:hover td:first-child, #tab-phantom table.ph-regions tbody tr.is-hl td:first-child { background: var(--card-2); }',
            '#tab-phantom .ph-rname { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }',
            '#tab-phantom .ph-rname .swatch { width: 11px; height: 11px; border-radius: 3px; }',
            '#tab-phantom .ph-group-head { text-align: center !important; border-bottom: 2px solid var(--border) !important; }',
            '#tab-phantom .ph-viewbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 12px; }',
            '#tab-phantom .ph-viewbar .seg { max-width: 100%; }',
            '@media (max-width: 560px) { #tab-phantom .ph-viewbar .seg { flex-wrap: wrap; } }',
            '#tab-phantom .ph-readout { margin-top: 8px; min-height: 2.9em; font: 0.76rem/1.45 var(--font-mono); color: var(--scope-muted); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }',
            '#tab-phantom .ph-readout b { color: var(--scope-fg); font-weight: 600; }',
            '#tab-phantom .ph-map .iv-canvas { cursor: crosshair; }',
            '#tab-phantom .ph-map .well-title { text-transform: none; letter-spacing: 0.01em; font-size: 0.78rem; }',
            '#tab-phantom .ph-side h3 { font-size: 0.86rem; margin: 0 0 6px; }',
            '#tab-phantom .ph-side .note { margin: 0 0 8px; }',
            '#tab-phantom .ph-legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr)); gap: 2px 8px; max-height: 340px; overflow: auto; }',
            '#tab-phantom .ph-legend button { display: flex; align-items: center; justify-content: flex-start; gap: 7px; width: 100%; height: auto; border: 0; background: none; color: var(--fg); padding: 3px 4px; border-radius: 5px;',
            '  font: 0.8rem/1.3 var(--font-sans); text-align: left; cursor: pointer; }',
            '#tab-phantom .ph-legend button:hover, #tab-phantom .ph-legend button.is-hl { background: var(--hover); }',
            '#tab-phantom .ph-legend .swatch { width: 11px; height: 11px; border-radius: 3px; }',
            '#tab-phantom .ph-source { font-size: 0.8rem; color: var(--muted); margin: 6px 0 0; }',
            '#tab-phantom .ph-profile { margin-top: 12px; }',
            '#tab-phantom .ph-swatch-pair { display: inline-flex; gap: 2px; vertical-align: -1px; }',
            '#tab-phantom .ph-kv { width: 100%; }',
            '#tab-phantom .ph-head-actions { margin-left: auto; }'
        ].join('\n'));
    }

    /* ---------- building the tab ---------- */
    function mount(panel) {
        addStyles();
        E.panel = panel;
        panel.textContent = '';
        const w = W();
        if (!w) { panel.appendChild(el('div', { class: 'error-card', text: 'The shared widgets (js/ui/widgets.js) did not load.' })); return; }

        // 1. concept
        panel.appendChild(w.concept({
            title: 'The object: where the tracer goes, and what stops the photons',
            body: '<p>A PET scanner does not image anatomy. It images the <strong>distribution of the tracer</strong>, which biology sets: ' +
                'glucose use for FDG, amyloid plaques for PiB, dopamine transporters for PE2I, blood flow for water. ' +
                'The same head gives a different picture with every tracer, and a different one again in disease.</p>' +
                '<p>The photons also have to get out. The <strong>linear attenuation coefficient μ</strong> says what fraction of 511 keV photons ' +
                'each millimetre of tissue removes; along a line of response the survivors fall off exponentially. ' +
                'Bone (0.151 /cm) stops more than brain (0.099 /cm), and air nothing.</p>',
            formula: '<i>I</i> = <i>I</i><sub>0</sub> e<sup>−∫ μ d<i>l</i></sup>',
            tryThis: [
                { html: 'Switch the condition to Parkinson\'s disease and load the FE-PE2I protocol: the posterior putamen on the image right (the patient\'s left) fades.',
                    label: 'Load FE-PE2I', run: function () { if (PET.actions) PET.actions.loadPreset('fepe2i_static'); setView('activity'); } },
                { html: 'Look at the μ map and hover over the skull and the brain. Half of the photons are lost in about 7 cm of water or brain, and in 4.6 cm of bone.',
                    label: 'Show μ', run: function () { setView('mu'); } },
                { html: 'Load the hot rods with ¹⁸F and open Positron range: compare the profile for ¹⁸F, ¹¹C and ¹⁵O across the smallest rods.',
                    label: 'Show me', run: function () { if (PET.actions) PET.actions.loadPreset('rods_f18'); setView('range'); } },
                { html: 'Use an MR-based μ map without bone (μ for correction): the skull disappears from the map the correction uses.',
                    label: 'No bone', run: function () { if (PET.actions) PET.actions.setPhysics({ muMap: { model: 'nobone' } }); setView('mucorr'); } }
            ]
        }));

        // 2. picker
        const pick = el('section', { class: 'panel', 'aria-labelledby': 'ph-pick-title' });
        pick.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ph-pick-title', text: 'Choose the object' }),
            el('span', { class: 'panel-sub', text: 'Four test objects filled with a solution of the isotope, and a brain whose activity comes from tracer kinetics' })
        ]));
        E.cardGrid = el('div', { class: 'grid ph-cards', role: 'group', 'aria-label': 'Phantoms' });
        pick.appendChild(E.cardGrid);
        E.cards = listPhantoms().map(function (p) {
            const canvas = el('canvas', { class: 'ph-thumb', 'aria-hidden': 'true' });
            const nameEl = el('span', { class: 'ph-card-name' }, [p.name]);
            if (p.kind === 'brain') nameEl.appendChild(w.badge('kinetics', 'accent'));
            const btn = el('button', { type: 'button', class: 'ph-card', 'aria-pressed': 'false', title: p.description, 'data-id': p.id }, [
                canvas, el('span', { class: 'ph-card-text' }, [nameEl, el('span', { class: 'ph-card-desc', text: p.description })])
            ]);
            btn.addEventListener('click', function () {
                if (!PET.actions) return;
                if (st().phantomId !== p.id) PET.actions.setPhantom(p.id);
            });
            E.cardGrid.appendChild(btn);
            return { id: p.id, def: p, btn: btn, canvas: canvas };
        });
        if (!E.cards.length) E.cardGrid.appendChild(w.empty('No phantoms are available: js/phantoms.js did not load.'));
        E.options = el('div', { class: 'ph-options' });
        pick.appendChild(E.options);
        E.fit = el('div', { class: 'ph-fit mt-1' });
        pick.appendChild(E.fit);
        panel.appendChild(pick);

        // 3. map viewer
        const mapPanel = el('section', { class: 'panel', 'aria-labelledby': 'ph-map-title' });
        E.viewSeg = w.segmented({ options: VIEWS, value: S.view, ariaLabel: 'Map to show', onChange: function (v) { setView(v); } });
        E.mapBadge = el('span', { class: 'badge badge-muted', hidden: true });
        mapPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ph-map-title', text: 'Maps of the object' }),
            E.mapBadge
        ]));
        mapPanel.appendChild(el('div', { class: 'ph-viewbar' }, [E.viewSeg]));
        const split = el('div', { class: 'split' });
        const main = el('div', { class: 'ph-main' });
        E.ivOpts = { title: '', cmap: 'gray', colorbar: true, unit: '', readout: false, maxHeight: 580, empty: 'Loading the phantom' };
        E.iv = w.imageView(main, E.ivOpts);
        E.iv.el.classList.add('ph-map');
        E.readout = el('div', { class: 'ph-readout', 'aria-live': 'off' });
        E.iv.el.appendChild(E.readout);
        E.cbar = E.iv.el.querySelector('.iv-cbar');
        E.iv.setOverlay(drawOverlay);
        E.iv.onHover(onMapHover);
        E.iv.onClick(onMapClick);
        E.profileBox = el('div', { class: 'ph-profile', hidden: true });
        main.appendChild(E.profileBox);
        E.profile = w.plot(E.profileBox, { height: 200, xlabel: 'x (mm)', ylabel: 'kBq/mL', framed: true, title: 'Profile' });
        E.mainCaption = el('p', { class: 'caption', text: 'The central 260 mm of the 320 mm field of view.' });
        main.appendChild(E.mainCaption);
        split.appendChild(main);
        E.side = el('div', { class: 'ph-side stack' });
        split.appendChild(E.side);
        mapPanel.appendChild(split);
        panel.appendChild(mapPanel);
        buildSide();

        // 4. region table
        const tabPanel = el('section', { class: 'panel', 'aria-labelledby': 'ph-table-title' });
        E.tableSub = el('span', { class: 'panel-sub' });
        E.kinLink = w.button({ label: 'Open Dynamic & quantification', size: 'sm', title: 'Compartment models, SUV, SUVR, Patlak and Logan',
            onClick: function () { if (PET.actions) PET.actions.showTab('kinetics'); } });
        tabPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ph-table-title', text: 'Regions in the slice' }), E.tableSub,
            el('span', { class: 'spacer' }), E.kinLink
        ]));
        E.tableWrap = el('div', { class: 'ph-scroll' });
        tabPanel.appendChild(E.tableWrap);
        E.tableNote = el('p', { class: 'note mt-1' });
        tabPanel.appendChild(E.tableNote);
        tabPanel.appendChild(el('p', { class: 'simplification', text: 'One 4 mm slice is imaged. Volumes are the slice area extruded over the object\'s axial length, which is what sets the singles rate and so the randoms. Tissue density is taken as 1 g/mL for SUV.' }));
        panel.appendChild(tabPanel);

        // bus
        if (PET.bus) {
            PET.bus.on('phantom:changed', function () { S.pinnedRegion = -1; S.hoverRegion = -1; invalidate(); });
            PET.bus.on('program:compiled', invalidate);
            PET.bus.on('scan:done', invalidate);
            PET.bus.on('frame:changed', invalidate);
            PET.bus.on('physics:changed', function () { syncCorrControls(); if (S.visible && S.view === 'mucorr') invalidate(); });
            PET.bus.on('preset:loaded', invalidate);
            PET.bus.on('theme:changed', function () { S.thumbKey = {}; if (S.visible) { scheduleThumbs(); renderMap(); } });
        }
        S.mounted = true;
    }

    /* Side column: one section per view, shown or hidden as the view changes. */
    function buildSide() {
        const w = W(), side = E.side;
        // shared: frame slider and colour map
        E.frameSlider = w.slider({ label: 'Frame shown', min: 0, max: 1, step: 1, value: 0,
            format: function (v) { return frameSliderText(Math.round(v)); },
            onInput: function (v) { if (PET.actions) PET.actions.setFrame(Math.round(v)); } });
        E.frameRow = el('div', { class: 'ph-frame-row', hidden: true }, [E.frameSlider]);
        side.appendChild(E.frameRow);
        E.cmapSel = w.select({ label: 'Colour map', options: [{ value: 'pet', label: 'PET (hot metal)' }, { value: 'inferno', label: 'Inferno' }, { value: 'gray', label: 'Gray' }],
            value: S.cmap, inline: true, onChange: function (v) { S.cmap = v; renderMap(); } });
        E.cmapRow = el('div', { hidden: true }, [E.cmapSel]);
        side.appendChild(E.cmapRow);

        // regions
        E.secRegions = el('div', { class: 'stack stack-sm' });
        E.lmToggle = w.toggle({ label: 'Landmarks', checked: S.landmarks, hint: 'Label anatomical landmarks and test-object features',
            onChange: function (b) { S.landmarks = b; E.iv.redraw(); } });
        E.legend = el('ul', { class: 'ph-legend', 'aria-label': 'Regions (hover to highlight)' });
        E.notes = el('p', { class: 'note' });
        E.secRegions.appendChild(el('div', { class: 'row' }, [el('h3', { class: 'mb-0', text: 'Regions' }), el('span', { class: 'spacer' }), E.lmToggle]));
        E.secRegions.appendChild(E.legend);
        E.secRegions.appendChild(E.notes);
        side.appendChild(E.secRegions);

        // activity
        E.secActivity = el('div', { class: 'stack stack-sm', hidden: true });
        E.unitSeg = w.segmented({ label: 'Units', options: [{ value: 'conc', label: 'kBq/mL' }, { value: 'suv', label: 'SUV' }], value: S.unit,
            onChange: function (v) { S.unit = v; renderMap(); renderTable(); } });
        E.actSource = el('p', { class: 'ph-source' });
        E.secActivity.appendChild(E.unitSeg);
        E.secActivity.appendChild(E.actSource);
        E.secActivity.appendChild(el('p', { class: 'note', html: 'This is the truth the scanner tries to measure: the concentration of the tracer in each region, ' +
            '<strong>decay corrected</strong> to the time of injection and averaged over the frame. ' +
            'SUV divides it by the injected dose per gram of body weight, so 1 means the tracer is spread evenly through the body.' }));
        E.actWhy = el('p', { class: 'note' });
        E.secActivity.appendChild(E.actWhy);
        side.appendChild(E.secActivity);

        // mu
        E.secMu = el('div', { class: 'stack stack-sm', hidden: true });
        E.muTable = el('div');
        E.muLine = el('p', { class: 'note' });
        E.secMu.appendChild(el('h3', { text: 'Attenuation at 511 keV' }));
        E.secMu.appendChild(E.muTable);
        E.secMu.appendChild(E.muLine);
        E.secMu.appendChild(el('p', { class: 'note', html: 'Both photons of a pair travel the whole line, so the pair survives with e<sup>−∫μ</sup> over the full line of response, ' +
            'wherever on it the annihilation happened. That is why attenuation in PET can be corrected exactly once μ is known.' }));
        side.appendChild(E.secMu);

        // mu used for correction
        E.secCorr = el('div', { class: 'stack stack-sm', hidden: true });
        E.corrSeg = w.segmented({ label: 'Show', options: [{ value: 'overlay', label: 'Overlay' }, { value: 'diff', label: 'Difference' }, { value: 'used', label: 'Map used' }],
            value: S.corrMode, onChange: function (v) { S.corrMode = v; renderMap(); } });
        E.corrLegend = el('p', { class: 'note' });
        E.corrStatus = el('div', { class: 'callout' });
        E.corrModel = w.select({ label: 'μ map from', options: [{ value: 'ct', label: 'CT (with bone)' }, { value: 'nobone', label: 'MR, bone missing' }],
            value: 'ct', onChange: function (v) { if (PET.actions) PET.actions.setPhysics({ muMap: { model: v } }); } });
        E.corrDx = w.slider({ label: 'Shift right', min: -20, max: 20, step: 1, value: 0, unit: 'mm',
            onChange: function (v) { if (PET.actions) PET.actions.setPhysics({ muMap: { dx: v } }); } });
        E.corrDy = w.slider({ label: 'Shift down', min: -20, max: 20, step: 1, value: 0, unit: 'mm',
            onChange: function (v) { if (PET.actions) PET.actions.setPhysics({ muMap: { dy: v } }); } });
        E.corrRot = w.slider({ label: 'Rotation', min: -10, max: 10, step: 0.5, value: 0, unit: '°',
            onChange: function (v) { if (PET.actions) PET.actions.setPhysics({ muMap: { rot: v } }); } });
        E.corrReset = w.button({ label: 'Align and use CT', size: 'sm', onClick: function () {
            if (PET.actions) PET.actions.setPhysics({ muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' } });
        } });
        E.secCorr.appendChild(E.corrSeg);
        E.secCorr.appendChild(E.corrLegend);
        E.secCorr.appendChild(E.corrStatus);
        E.secCorr.appendChild(el('div', { class: 'controls', style: { '--min': '150px' } }, [E.corrModel, E.corrDx, E.corrDy, E.corrRot]));
        E.secCorr.appendChild(el('div', { class: 'row' }, [E.corrReset, el('span', { class: 'note mb-0', text: 'Changes re-scan automatically.' })]));
        E.secCorr.appendChild(el('p', { class: 'note', html: 'Attenuation correction multiplies every line of response by e<sup>+∫μ</sup> computed from <em>this</em> map, ' +
            'and the scatter estimate is built from it too. Where it disagrees with the real object, both corrections go wrong: ' +
            'too hot where the map has extra tissue, too cold where it is missing.' }));
        side.appendChild(E.secCorr);
        syncCorrControls();

        // positron range
        E.secRange = el('div', { class: 'stack stack-sm', hidden: true });
        E.isoSeg = w.segmented({ label: 'Isotope', options: [{ value: 'F18', label: '¹⁸F' }, { value: 'C11', label: '¹¹C' }, { value: 'O15', label: '¹⁵O' }],
            value: 'F18', onChange: function (v) { S.rangeIso = v; renderMap(); } });
        E.isoNote = el('p', { class: 'note' });
        E.isoTable = W().statTable([], { compact: true });
        E.secRange.appendChild(E.isoSeg);
        E.secRange.appendChild(E.isoNote);
        E.secRange.appendChild(E.isoTable);
        E.secRange.appendChild(el('p', { class: 'note', html: 'A positron travels a short, random path before it annihilates, so the scanner sees the annihilation, not the decay. ' +
            'The faster the positron (¹⁵O most of all), the further it goes and the more the image blurs. <strong>Click the map</strong> to move the profile line.' }));
        side.appendChild(E.secRange);
    }

    function syncCorrControls() {
        if (!E.corrModel) return;
        const mm = (st().physics && st().physics.muMap) || {};
        E.corrModel.set(mm.model === 'nobone' ? 'nobone' : 'ct');
        E.corrDx.set(mm.dx || 0); E.corrDy.set(mm.dy || 0); E.corrRot.set(mm.rot || 0);
    }

    function setView(v) {
        if (!VIEWS.some(function (x) { return x.value === v; })) return;
        S.view = v;
        if (E.viewSeg) E.viewSeg.set(v);
        if (S.mounted && S.visible) renderMap();
        else if (S.mounted) S.dirty = true;
    }

    /* ---------- render orchestration ---------- */
    let renderTimer = null;
    function invalidate() {
        if (!S.mounted) return;
        if (!S.visible) { S.dirty = true; return; }
        if (renderTimer) return;
        // events often come in bursts (phantom, program, scan): render once
        renderTimer = setTimeout(function () { renderTimer = null; renderAll(); }, 30);
    }
    function renderAll() {
        S.dirty = false;
        try { renderPicker(); } catch (e) { report(e); }
        try { renderMap(); } catch (e) { report(e); }
        try { renderTable(); } catch (e) { report(e); }
    }
    function report(e) { if (root.console) root.console.error('[PET phantom tab]', e); }

    /* ---------- picker and options ---------- */
    function renderPicker() {
        const s = st(), w = W();
        E.cards.forEach(function (c) { c.btn.setAttribute('aria-pressed', c.id === s.phantomId ? 'true' : 'false'); });
        scheduleThumbs();
        const def = listPhantoms().find(function (p) { return p.id === s.phantomId; });
        E.options.textContent = '';
        if (def) {
            const ctls = (def.options || []).map(function (od) {
                const cur = s.phantomOpts && s.phantomOpts[od.key] !== undefined ? s.phantomOpts[od.key] : od.default;
                const set = function (v) { const p = {}; p[od.key] = v; if (PET.actions) PET.actions.setPhantomOpts(p); };
                if (od.type === 'bool') return el('div', { class: 'ctl' }, [w.toggle({ label: od.label, checked: !!cur, onChange: set })]);
                if (od.type === 'number') return w.slider({ label: od.label, min: od.min, max: od.max, step: od.step, value: cur, onChange: set });
                return w.select({ label: od.label, options: od.values || [], value: cur, onChange: set });
            });
            E.options.appendChild(el('h3', { class: 'ph-options-title', text: def.name + (ctls.length ? ': options' : '') }));
            if (ctls.length) E.options.appendChild(el('div', { class: 'controls', style: { '--min': '220px' } }, ctls));
            else E.options.appendChild(el('p', { class: 'note mb-0', text: 'This object has no options.' }));
            if (def.kind === 'brain') E.options.appendChild(conditionBlock(s));
        }
        renderFit();
    }
    function conditionBlock(s) {
        const cond = (s.phantomOpts && s.phantomOpts.condition) || 'normal';
        const f = conditionFacts() || {};
        const prog = currentProgram(), tr = prog && prog.tracer ? String(prog.tracer) : null;
        const famNow = tr ? FAMILIES.find(function (F) { return F.tracers.some(function (t) { return t.toLowerCase() === tr.toLowerCase(); }); }) : null;
        const conds = (PET.kinetics && PET.kinetics.conditions) || [{ id: 'normal', name: 'Normal' }, { id: 'ad', name: 'Alzheimer\'s disease' }, { id: 'pd', name: 'Parkinson\'s disease' }];
        const cDef = conds.find(function (c) { return c.id === cond; }) || conds[0];
        const box = el('div', { class: 'mt-2' });
        box.appendChild(el('p', { class: 'note mb-0', html: '<strong>' + cDef.name + '.</strong> ' + (cDef.description || '') + ' What it changes, tracer by tracer' +
            (famNow ? ' (the current protocol uses ' + famNow.name.split(',')[0] + ', highlighted)' : '') + ':' }));
        const list = el('ul', { class: 'ph-cond-list' });
        FAMILIES.forEach(function (F) {
            list.appendChild(el('li', { class: famNow === F ? 'is-current' : null }, [
                el('span', { class: 'ph-cond-tracer' }, [F.name, el('small', { text: F.target })]),
                el('span', { text: conditionText(F.id, cond, f) })
            ]));
        });
        box.appendChild(list);
        // the full comparison, folded away
        const tbl = el('table', { class: 'ph-grid' });
        const head = el('tr', {}, [el('th', { scope: 'col', text: 'Tracer' })].concat(conds.map(function (c) {
            return el('th', { scope: 'col', class: c.id === cond ? 'ph-col-cur' : null, text: c.name });
        })));
        tbl.appendChild(el('thead', {}, [head]));
        const body = el('tbody');
        FAMILIES.forEach(function (F) {
            body.appendChild(el('tr', {}, [el('th', { scope: 'row' }, [F.name, el('div', { class: 'muted', style: { fontWeight: '500' }, text: F.target })])].concat(conds.map(function (c) {
                return el('td', { class: c.id === cond ? 'ph-col-cur' : null, text: conditionText(F.id, c.id, f) });
            }))));
        });
        tbl.appendChild(body);
        box.appendChild(W().details({ summary: 'Compare all three conditions', content: el('div', { class: 'ph-scroll' }, [tbl]) }));
        box.appendChild(el('p', { class: 'simplification', text: 'The anatomy is the same in every condition: only the kinetics change, and no atrophy is modelled.' }));
        return box;
    }
    /* Does the protocol suit the object? Test objects ignore the tracer
       line; the brain needs one. */
    function renderFit() {
        E.fit.textContent = '';
        const C = getContext(), w = W();
        if (C.error) { E.fit.appendChild(w.callout(errText(C.error), 'bad')); return; }
        const ph = C.phantom, prog = C.program;
        if (!prog) { E.fit.appendChild(w.callout('No protocol has compiled yet, so there is no activity to show. Fix the protocol in the Protocol tab.', 'warn')); return; }
        const presetId = PRESET_FOR[ph.id];
        const btn = presetId ? w.button({ label: 'Load the matching protocol', size: 'xs', onClick: function () { if (PET.actions) PET.actions.loadPreset(presetId); } }) : null;
        if (C.tacsError) {
            const c = w.callout(el('div', {}, [doc.createTextNode(errText(C.tacsError) + '. '), btn]), 'bad');
            E.fit.appendChild(c);
        } else if (ph.kind !== 'brain' && prog.tracer && String(prog.tracer).toLowerCase() !== 'none') {
            const ti = tracerInfo(prog.tracer);
            E.fit.appendChild(w.callout(el('div', {}, [
                doc.createTextNode('This object is filled with a uniform solution of ' + isoLabel(prog.isotope) +
                    ', so the protocol\'s tracer line (' + (ti ? ti.label : prog.tracer) + ') does not matter here: only the isotope, dose and timing do. '),
                btn
            ])));
        }
    }

    /* ---------- the map ---------- */
    function renderMap() {
        if (!E.iv) return;
        const C = lastCtx = getContext();
        const iv = E.iv;
        showSide();
        if (C.error || !C.phantom) { iv.clear(C.error ? errText(C.error) : 'No phantom'); E.readout.textContent = ''; return; }
        const ph = C.phantom;
        ensurePC(ph);
        if (S.profilePhantom !== ph.id) { S.profilePhantom = ph.id; S.profileY = PROFILE_Y[ph.id] !== undefined ? PROFILE_Y[ph.id] : 0; }
        const m = PC.m;
        let title = '', badge = null;
        // a window dragged on one map makes no sense on another: reset it when the map changes
        const wkey = [S.view, S.unit, S.corrMode, S.rangeIso || '', ph.id].join('|');
        S.resetWin = wkey !== S.lastWKey;
        S.lastWKey = wkey;
        E.profileBox.hidden = S.view !== 'range';
        E.cbar && (E.cbar.hidden = S.view === 'regions' || (S.view === 'mucorr' && S.corrMode === 'overlay'));
        iv.setWL(S.view !== 'regions' && !(S.view === 'mucorr' && S.corrMode === 'overlay'));

        if (S.view === 'regions') {
            title = ph.name + ': regions';
            E.ivOpts.unit = '';
            iv.setData(PC.label, m, m, { min: 0, max: Math.max(1, ph.regions.length - 1), cmap: 'gray', resetWindow: true });
            renderLegend(ph);
            E.notes.textContent = ph.notes || '';
        } else if (S.view === 'activity') {
            if (!C.means) { iv.clear(activityMissing(C)); title = 'Activity'; }
            else {
                const suv = S.unit === 'suv';
                const f = suv ? C.suvFactor : 1e-3;
                if (suv && !isFinite(f)) { iv.clear('SUV needs a dose: the protocol has none.'); }
                else {
                    const vals = Array.prototype.map.call(C.means, function (v) { return v * f; });
                    const img = new Float32Array(m * m);
                    let max = 0;
                    for (let k = 0; k < img.length; k++) { const v = vals[PC.label[k]] || 0; img[k] = v; if (v > max) max = v; }
                    E.ivOpts.unit = suv ? 'SUV' : 'kBq/mL';
                    iv.setData(img, m, m, { min: 0, max: max > 0 ? max * 1.15 : 1, cmap: S.cmap, resetWindow: S.resetWin });
                }
                title = 'Activity, ' + (suv ? 'SUV' : 'kBq/mL') + ', decay corrected';
            }
            E.actSource.textContent = sourceText(C);
            E.actWhy.textContent = activityWhy(C);
            badge = C.source === 'scan' ? 'from the last scan' : (C.source === 'model' ? 'from the kinetic model' : null);
        } else if (S.view === 'mu') {
            title = 'Linear attenuation μ at 511 keV (/cm)';
            E.ivOpts.unit = '/cm';
            iv.setData(PC.mu, m, m, { min: 0, max: MU_MAX_CM, cmap: 'gray', resetWindow: S.resetWin });
            renderMuSide(ph);
        } else if (S.view === 'mucorr') {
            title = renderCorr(C);
            badge = C.acq && st().stale ? 'settings changed since this scan' : null;
        } else if (S.view === 'range') {
            title = renderRange(C);
        }
        iv.setTitle(title);
        E.mapBadge.hidden = !badge;
        if (badge) E.mapBadge.textContent = badge;
        E.mainCaption.textContent = S.view === 'range' ? 'The central 260 mm of the 320 mm field of view. The dashed line marks the profile below.'
            : (ph.kind === 'brain' ? 'Radiological convention: anterior at the top, the patient\'s right on the image left. The central 260 mm of the 320 mm field of view.'
                : 'The central 260 mm of the 320 mm field of view. Click a region to keep it highlighted.');
        updateReadout();
        syncFrameSlider(C);
    }
    function activityMissing(C) {
        if (!PET.kinetics) return 'The kinetics module (js/kinetics.js) did not load, so there are no activity curves.';
        if (C.tacsError) return errText(C.tacsError);
        if (!C.program) return 'No protocol has compiled yet.';
        return 'No activity to show yet.';
    }
    function sourceText(C) {
        const fr = frameLabel(C.frame, C.fi, C.frames.length);
        if (C.source === 'scan') return 'From the last scan: ' + fr + '. Average over the frame, weighted by radioactive decay.';
        if (C.source === 'model') return 'From the kinetic model' + (st().acq ? ' (the last scan is of other settings)' : ' (no scan yet)') + ': ' + fr + '.';
        return '';
    }
    function activityWhy(C) {
        const ph = C.phantom;
        if (ph.kind !== 'brain') return 'A test object is filled with a solution of the isotope, so every compartment with activity has the same concentration (or a set ratio to the background) for the whole scan.';
        const tr = C.tacs && C.tacs.tracer ? tracerInfo(C.tacs.tracer) : null;
        if (!tr) return '';
        return tr.label + ' targets ' + String(tr.target || '').replace(/^./, function (c) { return c.toLowerCase(); }) +
            '. Each region\'s value comes from a compartment model driven by the input function, so it changes from frame to frame.';
    }
    function showSide() {
        const v = S.view;
        E.secRegions.hidden = v !== 'regions';
        E.secActivity.hidden = v !== 'activity';
        E.secMu.hidden = v !== 'mu';
        E.secCorr.hidden = v !== 'mucorr';
        E.secRange.hidden = v !== 'range';
        E.cmapRow.hidden = !(v === 'activity' || v === 'range');
        E.cmapSel.set(S.cmap);
    }
    function syncFrameSlider(C) {
        const n = C.frames.length;
        const show = n > 1 && (S.view === 'activity' || S.view === 'range');
        E.frameRow.hidden = !show;
        if (!show) return;
        E.frameSlider.setRange(0, n - 1, 1);
        E.frameSlider.set(C.fi);
        // only frames the scan acquired can be selected
        E.frameSlider.setDisabled(!C.acq);
        E.frameSlider.title = C.acq ? '' : 'Frames can be chosen once the dynamic scan has run.';
    }

    function frameSliderText(i) {
        const C = lastCtx;
        if (!C || !C.frames.length) return '';
        const F = C.frames[U.clamp(i, 0, C.frames.length - 1)];
        return (i + 1) + ' of ' + C.frames.length + ', ' + clock(F.t0) + ' to ' + clock(F.t1);
    }
    function renderLegend(ph) {
        const key = ph.id + ':' + ph.regions.length + ':' + ph.name;
        if (E.legend.dataset.key === key) { paintLegendHL(); return; }
        E.legend.dataset.key = key;
        E.legend.textContent = '';
        ph.regions.forEach(function (r, i) {
            if (i === 0 || !(r.pixels > 0)) return;
            const b = el('button', { type: 'button', class: 'ph-leg', 'data-r': i, title: r.name + ' (' + (TISSUE[r.tissue] || r.tissue) + ')' }, [
                el('span', { class: 'swatch', style: { background: r.color }, 'aria-hidden': 'true' }), r.name
            ]);
            b.addEventListener('mouseenter', function () { S.hoverRegion = i; hlChanged(); });
            b.addEventListener('mouseleave', function () { S.hoverRegion = -1; hlChanged(); });
            b.addEventListener('focus', function () { S.hoverRegion = i; hlChanged(); });
            b.addEventListener('blur', function () { S.hoverRegion = -1; hlChanged(); });
            b.addEventListener('click', function () { S.pinnedRegion = S.pinnedRegion === i ? -1 : i; hlChanged(); });
            E.legend.appendChild(el('li', {}, [b]));
        });
        paintLegendHL();
    }
    function highlight() { return S.hoverRegion >= 0 ? S.hoverRegion : S.pinnedRegion; }
    function paintLegendHL() {
        const hl = highlight();
        Array.prototype.forEach.call(E.legend.querySelectorAll('button'), function (b) { b.classList.toggle('is-hl', +b.dataset.r === hl); });
        if (E.rows) E.rows.forEach(function (r) { r.tr.classList.toggle('is-hl', r.index === hl); });
    }
    function hlChanged() { paintLegendHL(); if (E.iv) E.iv.redraw(); }

    function renderMuSide(ph) {
        // one row per tissue present, with its half-value layer
        const seen = {}, rows = [];
        ph.regions.forEach(function (r) {
            if (!(r.pixels > 0) || r.tissue === 'air') return;
            const k = r.tissue + ':' + r.mu;
            if (seen[k]) return;
            seen[k] = 1;
            rows.push({ label: (TISSUE[r.tissue] || r.tissue).replace(/^./, function (c) { return c.toUpperCase(); }),
                value: muCm(r.mu) + ', half lost in ' + U.fmtNum(Math.LN2 / r.mu / 10, 2) + ' cm', hint: r.name });
        });
        E.muTable.textContent = '';
        E.muTable.appendChild(W().statTable(rows, { compact: true }));
        // attenuation along the horizontal line through the centre
        const n = ph.n, h = Math.floor(n / 2);
        let li = 0;
        for (let ix = 0; ix < n; ix++) li += ph.mu[h * n + ix] * ph.dx;
        const a = Math.exp(-li);
        E.muLine.innerHTML = 'Along the horizontal line through the centre, ∫μ d<i>l</i> = ' + U.fmtNum(li, 3) +
            ', so only <strong>' + U.fmtPct(a, a < 0.1 ? 1 : 0) + '</strong> of the photon pairs from that line get out together ' +
            '(attenuation correction factor ' + U.fmtNum(1 / a, 3) + ').';
    }

    /* mu used for correction: overlay, difference or the map itself. */
    function renderCorr(C) {
        const iv = E.iv, m = PC.m;
        const mm = (st().physics && st().physics.muMap) || {};
        E.corrLegend.innerHTML = S.corrMode === 'overlay'
            ? '<span class="ph-swatch-pair"><span class="swatch" style="background:#e040e0"></span></span> true μ only, ' +
              '<span class="ph-swatch-pair"><span class="swatch" style="background:#40e040"></span></span> μ used only, ' +
              'gray where they agree.'
            : (S.corrMode === 'diff' ? 'Red: the map used has more attenuation than the object; blue: less.' : 'The map the scanner used, on the same scale as the true μ map.');
        if (!C.acq || !C.acq.corrections || !C.acq.corrections.muCorr) {
            PC.corr = null;
            iv.clear(st().scanning ? 'Scanning: the correction μ map comes with the scan.' : 'The correction μ map comes with the scan. Run a scan of this object.');
            E.corrStatus.textContent = 'No scan of this object yet.';
            return 'μ map used for attenuation correction';
        }
        const acq = C.acq, used = acq.corrections.muCorr, ph = C.phantom;
        if (!PC.corr || PC.corr.src !== used) {
            const u = cropOf(used, 10), t = PC.mu, d = new Float32Array(m * m);
            let sumAbs = 0, cnt = 0;
            for (let k = 0; k < d.length; k++) {
                // air in both maps has no difference to show: leave it transparent (NaN) so the well stays dark
                if (t[k] > 0 || u[k] > 0) { d[k] = u[k] - t[k]; sumAbs += Math.abs(d[k]); cnt++; } else d[k] = NaN;
            }
            const cv = doc.createElement('canvas');
            cv.width = m; cv.height = m;
            const c = cv.getContext('2d'), img = c.createImageData(m, m), px = img.data;
            for (let k = 0; k < d.length; k++) {
                const a = Math.min(1, t[k] / MU_MAX_CM), b = Math.min(1, u[k] / MU_MAX_CM);
                px[4 * k] = Math.round(235 * a); px[4 * k + 1] = Math.round(235 * b); px[4 * k + 2] = Math.round(235 * a); px[4 * k + 3] = 255;
            }
            c.putImageData(img, 0, 0);
            PC.corr = { src: used, used: u, diff: d, canvas: cv, meanAbs: cnt ? sumAbs / cnt : 0 };
        }
        if (S.corrMode === 'diff') {
            E.ivOpts.unit = '/cm';
            iv.setData(PC.corr.diff, m, m, { min: -DIFF_MAX_CM, max: DIFF_MAX_CM, cmap: 'diverging', resetWindow: S.resetWin });
        } else {
            E.ivOpts.unit = '/cm';
            iv.setData(PC.corr.used, m, m, { min: 0, max: MU_MAX_CM, cmap: 'gray', resetWindow: S.resetWin });
        }
        // what the scanner was told
        const ph2 = acq.physics && acq.physics.muMap ? acq.physics.muMap : mm;
        const parts = [];
        if (ph2.dx || ph2.dy) parts.push('shifted ' + [ph2.dx ? Math.abs(ph2.dx) + ' mm ' + (ph2.dx > 0 ? 'right' : 'left') : '', ph2.dy ? Math.abs(ph2.dy) + ' mm ' + (ph2.dy > 0 ? 'down' : 'up') : ''].filter(Boolean).join(' and '));
        if (ph2.rot) parts.push('rotated ' + ph2.rot + '°');
        if (ph2.model === 'nobone') parts.push(ph.regions.some(function (r) { return r.tissue === 'bone' && r.pixels > 0; }) ? 'bone replaced by soft tissue' : 'bone replaced by soft tissue (this object has no bone)');
        const ok = !parts.length;
        E.corrStatus.className = 'callout' + (ok ? ' callout-good' : ' callout-warn');
        E.corrStatus.textContent = ok ? 'The map used matches the object: attenuation and scatter are corrected correctly.'
            : 'The map used is ' + parts.join(', ') + '. Mean |difference| inside the object: ' + U.fmtNum(PC.corr.meanAbs, 2) + ' /cm.';
        return S.corrMode === 'diff' ? 'μ used minus true μ (/cm)' : (S.corrMode === 'overlay' ? 'True μ (magenta) and μ used (green)' : 'μ map used for attenuation correction (/cm)');
    }

    /* Annihilation rate with positron range, for the protocol isotope
       (PET.engine.frameEmission) or, for comparison, another isotope's
       range kernel applied to the same decays. */
    function emissionFor(C, iso) {
        const key = (C.tacs ? '' : 'x') + C.fi + ':' + iso;
        const cache = PC.emission;
        if (cache.tacs !== C.tacs) { cache.clear(); cache.tacs = C.tacs; }
        if (cache.has(key)) return cache.get(key);
        const ph = C.phantom, prog = C.program, fr = C.program.frames[Math.min(C.fi, C.program.frames.length - 1)];
        let out;
        if (iso === 'none' || iso === prog.isotope) {
            const img = PET.engine.frameEmission(prog, ph, C.tacs, fr.t0, fr.t1, { positronRange: iso !== 'none' });
            // decays per mL in the frame -> kBq/mL (annihilations per s per mL, frame average)
            const f = 1 / (Math.max(1e-9, fr.t1 - fr.t0) * 1000);
            out = new Float32Array(img.length);
            for (let i = 0; i < img.length; i++) out[i] = img[i] * f;
        } else {
            // the same decays (already in kBq/mL), spread by another isotope's range
            const base = emissionFor(C, 'none'), k = PET.isotopes.rangeKernel(iso, ph.dx);
            out = U.convolve2D(base, ph.n, ph.n, k.kernel, k.size);
        }
        cache.set(key, out);
        return out;
    }
    function renderRange(C) {
        const iv = E.iv, m = PC.m, ph = C.phantom;
        const prog = C.program;
        if (!prog || !C.tacs || !PET.engine || typeof PET.engine.frameEmission !== 'function') {
            iv.clear(C.tacsError ? errText(C.tacsError) : (!PET.engine ? 'The acquisition engine (js/engine.js) did not load.' : 'No protocol has compiled yet.'));
            E.profile.draw([]);
            return 'Annihilations with positron range';
        }
        const protoIso = prog.isotope || 'F18';
        const iso = S.rangeIso || protoIso;
        E.isoSeg.set(iso);
        let img, base;
        try { img = emissionFor(C, iso); base = emissionFor(C, 'none'); }
        catch (e) { report(e); iv.clear('Could not compute the emission: ' + errText(e)); return 'Annihilations with positron range'; }
        let max = 0;
        for (let k = 0; k < base.length; k++) if (base[k] > max) max = base[k];
        E.ivOpts.unit = 'kBq/mL';
        iv.setData(cropOf(img), m, m, { min: 0, max: max > 0 ? max * 1.15 : 1, cmap: S.cmap, resetWindow: S.resetWin });
        // isotope facts
        try {
            const I = PET.isotopes.get(iso), rs = PET.isotopes.rangeStats ? PET.isotopes.rangeStats(I) : null;
            E.isoTable.update([
                ['Half-life', U.fmtTime(I.halfLife)],
                ['Maximum positron energy', U.fmtNum(I.eMax, 4) + ' keV'],
                ['Mean range in water (3D)', U.fmtNum(I.rangeMean, 2) + ' mm'],
                ['Maximum range in water', U.fmtNum(I.rangeMax, 2) + ' mm'],
                rs ? ['RMS blur along one axis', U.fmtNum(rs.rms1D, 2) + ' mm'] : null
            ].filter(Boolean));
            E.isoNote.textContent = iso === protoIso
                ? 'The protocol\'s isotope. The image is the annihilation rate in the frame shown (not decay corrected).'
                : 'For comparison: the same decays as the protocol\'s ' + isoLabel(protoIso) + ', annihilating with the range of ' + I.label + '.';
        } catch (e) { /* facts are optional */ }
        // profiles along the chosen row, every isotope
        const n = ph.n, h = Math.floor(n / 2), row = U.clamp(Math.round(S.profileY / PC.dx) + h, 0, n - 1);
        const xs = new Float64Array(m);
        for (let x = 0; x < m; x++) xs[x] = (x + PC.c0 - h) * PC.dx;
        const rowOf = function (a) { const out = new Float64Array(m); for (let x = 0; x < m; x++) out[x] = a[row * n + x + PC.c0]; return out; };
        const series = [{ x: xs, y: rowOf(base), label: 'no range', color: 'var(--muted)', dash: true, width: 1.25 }];
        ['F18', 'C11', 'O15'].forEach(function (id) {
            let a;
            try { a = emissionFor(C, id); } catch (e) { return; }
            const I = PET.isotopes.get(id);
            series.push({ x: xs, y: rowOf(a), label: I.label + (id === protoIso ? ' (protocol)' : ''), color: I.color || null, width: id === iso ? 2.6 : 1.3 });
        });
        E.profile.setTitle('Annihilation rate along y = ' + U.fmtNum((row - h) * PC.dx, 3) + ' mm');
        E.profile.draw(series, { includeZero: true, xfmt: function (v) { return U.fmtNum(v, 3); } });
        return 'Annihilations, ' + isoLabel(iso) + ' positron range (kBq/mL)';
    }

    /* Everything drawn on top of the map, in CSS pixels. */
    function drawOverlay(ctx, g) {
        const C = lastCtx;
        if (!PC || !C || !C.phantom) return;
        const ph = C.phantom, m = PC.m;
        ctx.imageSmoothingEnabled = false;
        if (S.view === 'regions') {
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, g.w, g.h);
            ctx.drawImage(regionCanvas(highlight()), 0, 0, m, m, 0, 0, g.w, g.h);
            ph.regions.forEach(function (r, i) {
                if (!PC.small[i] || r.cx === undefined) return;
                const p = mmToCanvas(r.cx, r.cy, g);
                ctx.fillStyle = r.color; ctx.strokeStyle = highlight() === i ? '#fff' : 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, g.sx * 1.4), 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
            });
        } else if (S.view === 'mucorr' && S.corrMode === 'overlay' && PC.corr) {
            ctx.drawImage(PC.corr.canvas, 0, 0, m, m, 0, 0, g.w, g.h);
        }
        if (S.view !== 'regions') {
            ph.regions.forEach(function (r, i) {
                if (!PC.small[i] || r.cx === undefined) return;
                const p = mmToCanvas(r.cx, r.cy, g);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)'; ctx.lineWidth = 1.25;
                ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(5, g.sx * 3), 0, 2 * Math.PI); ctx.stroke();
            });
        }
        const hl = highlight();
        if (hl > 0 && S.view !== 'regions') {
            ctx.globalAlpha = 0.9;
            ctx.drawImage(outlineCanvas(hl), 0, 0, m, m, 0, 0, g.w, g.h);
            ctx.globalAlpha = 1;
        }
        if (S.view === 'range') {
            const y = mmToCanvas(0, S.profileY, g).y;
            ctx.save();
            ctx.strokeStyle = 'rgba(94, 224, 210, 0.95)'; ctx.lineWidth = 1.25; ctx.setLineDash([6, 4]);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.w, y); ctx.stroke();
            ctx.restore();
        }
        if (S.view === 'regions' && S.landmarks) drawLandmarks(ctx, g, ph);
        if (ph.kind === 'brain') drawOrientation(ctx, g, ph);
        drawScaleBar(ctx, g);
    }
    function mmToCanvas(x, y, g) {
        return { x: (x / PC.dx + PC.h - PC.c0 + 0.5) * g.sx, y: (y / PC.dx + PC.h - PC.c0 + 0.5) * g.sy };
    }
    function haloText(ctx, text, x, y, color) {
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'; ctx.lineJoin = 'round';
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color || '#f1f5f9';
        ctx.fillText(text, x, y);
    }
    function drawLandmarks(ctx, g, ph) {
        const fs = g.w < 300 ? 9.5 : 11;
        ctx.font = '600 ' + fs + 'px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textBaseline = 'middle';
        const boxes = [];
        (ph.landmarks || []).forEach(function (lm) {
            if (lm.kind === 'orientation') return;
            const p = mmToCanvas(lm.x, lm.y, g);
            if (p.x < 0 || p.y < 0 || p.x > g.w || p.y > g.h) return;
            const tw = ctx.measureText(lm.name).width;
            // put the label to the right of the dot, or to the left near the right edge
            const left = p.x + 6 + tw > g.w - 2;
            const bx = left ? p.x - 6 - tw : p.x + 6, box = { x0: bx - 2, x1: bx + tw + 2, y0: p.y - fs / 2 - 1, y1: p.y + fs / 2 + 1 };
            ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
            if (boxes.some(function (b) { return box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0; })) return;
            boxes.push(box);
            ctx.textAlign = 'left';
            haloText(ctx, lm.name, bx, p.y, '#f8fafc');
        });
    }
    function drawOrientation(ctx, g) {
        ctx.font = '700 13px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        const c = '#cbd5e1';
        haloText(ctx, 'A', g.w / 2, 11, c);
        haloText(ctx, 'P', g.w / 2, g.h - 11, c);
        haloText(ctx, 'R', 11, g.h / 2, c);
        haloText(ctx, 'L', g.w - 11, g.h / 2, c);
    }
    function drawScaleBar(ctx, g) {
        const len = 50 / PC.dx * g.sx, x1 = g.w - 12, x0 = x1 - len, y = g.h - 14;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.font = '600 10.5px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        haloText(ctx, '50 mm', (x0 + x1) / 2, y - 4, '#e2e8f0');
    }

    /* ---------- hover and click ---------- */
    function pixelInfo(p) {
        const C = lastCtx;
        if (!p || !C || !C.phantom || !PC) return null;
        const ph = C.phantom, ix = p.ix + PC.c0, iy = p.iy + PC.c0, k = iy * ph.n + ix;
        const ri = ph.label[k], r = ph.regions[ri];
        return { ix: ix, iy: iy, k: k, x: (ix - PC.h) * PC.dx, y: (iy - PC.h) * PC.dx, ri: ri, region: r, C: C };
    }
    function onMapHover(p) {
        S.hoverPix = p ? pixelInfo(p) : null;
        updateReadout();
    }
    function onMapClick(p) {
        const q = pixelInfo(p);
        if (!q) return;
        if (S.view === 'range') { S.profileY = Math.round(q.y / PC.dx) * PC.dx; renderMap(); return; }
        S.pinnedRegion = q.ri > 0 && S.pinnedRegion !== q.ri ? q.ri : -1;
        hlChanged();
    }
    function updateReadout() {
        if (!E.readout) return;
        const q = S.hoverPix;
        if (!q || !q.region) {
            E.readout.textContent = S.view === 'regions' ? 'Hover over the map to read a pixel; click a region to keep it highlighted.'
                : (S.view === 'range' ? 'Hover to read a pixel; click to move the profile line.' : 'Hover over the map to read region, μ, concentration and SUV. Drag to change the window.');
            return;
        }
        const C = q.C, r = q.region, brain = C.phantom.kind === 'brain';
        const side = brain && Math.abs(q.x) > 0.5 ? (q.x > 0 ? ' (patient\'s left)' : ' (patient\'s right)') : '';
        const l1 = 'x ' + q.x.toFixed(1) + ' mm' + side + ', y ' + q.y.toFixed(1) + ' mm';
        const parts = ['μ ' + muCm(C.phantom.mu[q.k])];
        if (S.view === 'mucorr' && PC.corr) {
            const used = PC.corr.used[(q.iy - PC.c0) * PC.m + q.ix - PC.c0];
            parts.push('μ used ' + used.toFixed(3) + ' /cm');
        }
        if (C.means) {
            const c = C.means[q.ri] || 0;
            parts.push(U.fmtConc(c, 3));
            if (isFinite(C.suvFactor)) parts.push('SUV ' + fmtSig(c * C.suvFactor, 3));
        }
        if (S.view === 'range') {
            try {
                const iso = S.rangeIso || (C.program && C.program.isotope) || 'F18', img = emissionFor(C, iso);
                parts.push('annihilations ' + fmtSig(img[q.k], 3) + ' kBq/mL');
            } catch (e) { /* no emission */ }
        }
        E.readout.innerHTML = '';
        E.readout.appendChild(el('div', {}, [el('b', { text: r.name }), ' (' + (TISSUE[r.tissue] || r.tissue) + '), ' + l1]));
        E.readout.appendChild(el('div', { text: parts.join(' · ') }));
    }

    /* ---------- region table ---------- */
    function renderTable() {
        if (!E.tableWrap) return;
        const C = getContext(), w = W();
        E.tableWrap.textContent = '';
        E.rows = [];
        if (C.error || !C.phantom) { E.tableWrap.appendChild(w.empty(C.error ? errText(C.error) : 'No phantom.')); return; }
        const ph = C.phantom, brain = ph.kind === 'brain';
        const tracer = brain && C.tacs && C.tacs.tracer ? C.tacs.tracer : null;
        const cond = ph.condition || 'normal';
        const tInfo = tracerInfo(tracer);
        const model = tracer && PET.kinetics && PET.kinetics.table && PET.kinetics.table[tracer] ? PET.kinetics.table[tracer].model : null;
        const showKin = !!(model && PET.kinetics.params);
        E.tableSub.textContent = (C.frame ? frameLabel(C.frame, C.fi, C.frames.length) + ', ' : '') + (C.source === 'scan' ? 'activity from the last scan' : (C.source === 'model' ? 'activity from the kinetic model' : 'no activity yet'));
        E.kinLink.hidden = !brain;

        const outcome = model === '2tci' ? { key: 'Ki', head: 'Ki', unit: 'mL/min/mL' } : (model === '1tc' ? { key: 'VT', head: 'VT', unit: 'mL/mL' } : { key: 'BPND', head: 'BPND', unit: '' });
        const table = el('table', { class: 'ph-grid ph-regions' });
        const h1 = el('tr', {}, [
            el('th', { scope: 'col', rowspan: showKin ? 2 : null, text: 'Region' }),
            el('th', { scope: 'col', rowspan: showKin ? 2 : null, text: 'Tissue' }),
            el('th', { scope: 'col', class: 'n', rowspan: showKin ? 2 : null, text: 'Area (cm²)' }),
            el('th', { scope: 'col', class: 'n', rowspan: showKin ? 2 : null, text: 'Volume (mL)' }),
            el('th', { scope: 'col', class: 'n', rowspan: showKin ? 2 : null, text: 'μ (/cm)' }),
            el('th', { scope: 'col', class: 'n', rowspan: showKin ? 2 : null, text: 'Conc. (kBq/mL)' }),
            el('th', { scope: 'col', class: 'n', rowspan: showKin ? 2 : null, text: 'SUV' })
        ]);
        const thead = el('thead', {}, [h1]);
        if (showKin) {
            h1.appendChild(el('th', { scope: 'colgroup', colspan: 5, class: 'ph-group-head', text: (tInfo ? tInfo.label : tracer) + ' model (' + model + ')' }));
            thead.appendChild(el('tr', {}, [
                el('th', { scope: 'col', class: 'n', title: 'Transport from plasma into tissue', text: 'K1 (mL/min/mL)' }),
                el('th', { scope: 'col', class: 'n', title: 'Transport back to plasma', text: 'k2 (/min)' }),
                el('th', { scope: 'col', class: 'n', title: 'Binding, or phosphorylation for FDG', text: 'k3 (/min)' }),
                el('th', { scope: 'col', class: 'n', title: 'Release from the bound compartment', text: 'k4 (/min)' }),
                el('th', { scope: 'col', class: 'n', text: outcome.head + (outcome.unit ? ' (' + outcome.unit + ')' : '') })
            ]));
        }
        table.appendChild(thead);
        const body = el('tbody');
        const dx = PC && PC.ph === ph ? PC.dx : (ph.dx || ph.fov / ph.n);
        ph.regions.forEach(function (r, i) {
            if (i === 0 || !(r.pixels > 0)) return;
            const conc = C.means ? C.means[i] : NaN;
            const name = el('span', { class: 'ph-rname' }, [el('span', { class: 'swatch', style: { background: r.color }, 'aria-hidden': 'true' }), r.name]);
            if (tInfo && tInfo.reference === r.id) name.appendChild(w.badge('reference', 'accent'));
            const cells = [
                el('td', {}, [name]),
                el('td', { class: 'nw', text: TISSUE[r.tissue] || r.tissue }),
                el('td', { class: 'n', text: fmtSig(r.pixels * dx * dx / 100, 3) }),
                el('td', { class: 'n', text: fmtSig(r.volume, 3) }),
                el('td', { class: 'n', text: (r.mu * 10).toFixed(3) }),
                el('td', { class: 'n', text: isFinite(conc) ? fmtSig(conc / 1000, 3) : '-' }),
                el('td', { class: 'n', text: isFinite(conc) && isFinite(C.suvFactor) ? fmtSig(conc * C.suvFactor, 3) : '-' })
            ];
            if (showKin) {
                let m = null;
                try { m = PET.kinetics.params(tracer, r.id, cond); } catch (e) { m = null; }
                if (m && m.model === 'blood') cells.push(el('td', { colspan: 5, class: 'muted', text: 'Blood: follows the plasma input (plasma taken equal to whole blood)' }));
                else if (!m) cells.push(el('td', { colspan: 5, class: 'muted', text: 'Takes up no tracer' }));
                else {
                    const d = PET.kinetics.derived(m) || {};
                    const k4 = model === '2tci' ? '0 (trapped)' : (model === '1tc' ? '-' : fmtSig(m.k4, 3));
                    cells.push(el('td', { class: 'n', text: fmtSig(m.K1, 3) }), el('td', { class: 'n', text: fmtSig(m.k2, 3) }),
                        el('td', { class: 'n', text: model === '1tc' ? '-' : fmtSig(m.k3, 3) }), el('td', { class: 'n', text: k4 }),
                        el('td', { class: 'n', text: fmtSig(d[outcome.key], 3) }));
                }
            }
            const tr = el('tr', { 'data-r': i }, cells);
            tr.addEventListener('mouseenter', function () { S.hoverRegion = i; hlChanged(); });
            tr.addEventListener('mouseleave', function () { S.hoverRegion = -1; hlChanged(); });
            tr.addEventListener('click', function () { S.pinnedRegion = S.pinnedRegion === i ? -1 : i; hlChanged(); });
            body.appendChild(tr);
            E.rows.push({ tr: tr, index: i });
        });
        table.appendChild(body);
        E.tableWrap.appendChild(table);
        paintLegendHL();
        const notes = [];
        if (showKin) {
            notes.push(model === '2tci' ? 'FDG is trapped once phosphorylated (k4 = 0); Ki = K1 k3 / (k2 + k3) is its net influx rate.'
                : (model === '1tc' ? 'Water is freely diffusible: K1 is the blood flow and VT = K1 / k2 the partition coefficient.'
                    : 'BPND = k3 / k4 is the binding potential relative to the nondisplaceable tissue; the reference region has BPND = 0.'));
            notes.push('Rate constants are per minute, as in the literature. Hover a row to find the region on the map.');
        } else if (!brain) notes.push('Test objects hold a solution: no kinetics, the same concentration all scan long. Hover a row to find the region on the map.');
        else if (C.tacsError) notes.push(errText(C.tacsError));
        if (isFinite(C.suvFactor) && !brain) notes.push('SUV for a test object uses the protocol\'s weight (' + U.fmtNum(C.weight, 3) + ' kg) and fill activity, so it is only a scale.');
        E.tableNote.textContent = notes.join(' ');
    }

    /* ---------- tab hooks ---------- */
    function onShow() {
        S.visible = true;
        if (!S.mounted) return;
        renderAll();
    }
    function onHide() { S.visible = false; S.hoverPix = null; }

    PET.ui.registerTab({ id: 'phantom', title: 'Phantom', order: 40, mount: mount, onShow: onShow, onHide: onHide });

})(typeof window !== 'undefined' ? window : globalThis);
