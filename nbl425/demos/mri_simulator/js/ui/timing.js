/* ============================================================
   MRI Simulator, pulse-sequence timing diagram (MRI.ui.timing)

   A self-contained canvas component that draws one repetition (or any
   time window) of a compiled SeqProgram the way a pulse-sequence
   diagram is drawn on a whiteboard: rows RF, Gz, Gy, Gx and ADC, with
   the RF pulses in their real shapes, gradients as filled trapezoids,
   ADC windows as boxes, a faint phase-encode ladder, and TE, TI and TR
   dimension lines. The Sequence and Spectroscopy tabs both use it, and
   the Sequence tab drives its cursor from playback ticks at frame rate,
   so everything here is cheap to redraw:

     - the program is indexed once (sorted start times, ladder groups,
       per-period annotations), cached per program object;
     - only events inside the visible window are visited (binary search),
       so a 256-line spin echo draws as fast as a 16-line one;
     - redraws requested by setCursor / setPeriod are coalesced into one
       per animation frame, and nothing is drawn while the canvas is
       hidden (zero width); a ResizeObserver redraws when it reappears.

   The default view of a repetition is a "broken" time axis: the long
   idle stretch at the end of a TR (or a long TI) is compressed into a
   break mark, the way textbooks draw it, so that a spin echo with
   TR 3000 ms and TE 90 ms is readable while TR is still annotated.
   Zooming or panning switches to a plain linear axis; double-click (or
   the Fit button, or the 0 key) goes back to the default view. Zoom
   with Ctrl or Cmd + wheel, a pinch, the + and - buttons or keys; a
   plain wheel scrolls the page. Zooming out and panning stop at the
   edges of the repetition.

     const td = MRI.ui.timing.create(container, opts);
     td.setProgram(program)    a compiled program (ok: true); a failed one is ignored
     td.setPeriod(i)           index into program.periods (dummies included); the cursor
                               keeps its time within the repetition
     td.setWindow(t0, t1)      absolute seconds, linear axis
     td.resetWindow()          back to the default view of the period
     td.setCursor(t)           absolute seconds, or null to hide the cursor
     td.onCursor(fn)           fn(t) when the user moves the cursor (not on setCursor)
     td.redraw(), td.destroy()
     td.getPeriod(), td.getCursor(), td.getWindow() -> {t0, t1}
     td.el, td.canvas

   opts: { ariaLabel, toolbar (default true), status (default true),
           ladder (default true), annotate (default true),
           trueScale (default false), compact (default false), emptyText }

   MRI.ui.timing.kAt(program, t) -> {kx, ky (cycles/m), tExc, exc,
   spoiled, nRef} | null is the nominal k-space position at time t
   (section 9.1: an excitation resets k, a refocusing pulse negates it,
   gradients advance it by gammaBar times their area). It is shared with
   the Sequence tab's k-space and spin-phase panels.
   MRI.ui.timing.periodEcho(program, i) -> {tExc, tEcho, te, tInv, ti,
   trStart, tr} gives the annotation times of period i.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.util) return;
    const U = MRI.util;
    const GB = MRI.const.GAMMA_BAR;
    const AXES = ['x', 'y', 'z'];
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const caf = root.cancelAnimationFrame ? root.cancelAnimationFrame.bind(root) : clearTimeout;

    /* ---------- binary searches on sorted Float64Arrays ---------- */
    function lastLE(a, t) {                 // largest i with a[i] <= t, or -1
        let lo = 0, hi = a.length - 1, j = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { j = m; lo = m + 1; } else hi = m - 1; }
        return j;
    }
    function firstGE(a, t) {                // smallest i with a[i] >= t, or a.length
        let lo = 0, hi = a.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
        return lo;
    }
    function firstGT(a, t) { return lastLE(a, t) + 1; }

    function times(list, key) {
        const out = new Float64Array(list.length);
        for (let i = 0; i < list.length; i++) out[i] = list[i][key];
        return out;
    }
    function sortedByT0(list) {
        for (let i = 1; i < list.length; i++) {
            if (list[i].t0 < list[i - 1].t0) return list.slice().sort(function (a, b) { return a.t0 - b.t0; });
        }
        return list;
    }
    function trapEnd(tr) { return tr.t0 + tr.rise + tr.flat + tr.fall; }
    function trapValue(tr, t) {
        const u = t - tr.t0;
        if (u <= 0 || u >= tr.rise + tr.flat + tr.fall) return 0;
        if (u < tr.rise) return tr.amp * u / tr.rise;
        if (u <= tr.rise + tr.flat) return tr.amp;
        return tr.amp * (tr.rise + tr.flat + tr.fall - u) / tr.fall;
    }

    /* Exact gradient area (T s / m) between tA and tB, through dsl.js when
       it is there (it caches prefix sums), else by direct summation. */
    function area(p, axis, tA, tB) {
        if (MRI.dsl && typeof MRI.dsl.gradientArea === 'function') return MRI.dsl.gradientArea(p, axis, tA, tB);
        const list = (p.grad && p.grad[axis]) || [];
        let s = 0;
        for (let i = 0; i < list.length; i++) {
            const tr = list[i];
            if (trapEnd(tr) <= tA || tr.t0 >= tB) continue;
            const n = 64, a = Math.max(tA, tr.t0), b = Math.min(tB, trapEnd(tr)), h = (b - a) / n;
            for (let j = 0; j < n; j++) s += trapValue(tr, a + (j + 0.5) * h) * h;
        }
        return s;
    }
    function gradAt(p, axis, t) {
        if (MRI.dsl && typeof MRI.dsl.gradientAt === 'function') return MRI.dsl.gradientAt(p, axis, t);
        const list = (p.grad && p.grad[axis]) || [];
        for (let i = 0; i < list.length; i++) { const v = trapValue(list[i], t); if (v) return v; }
        return 0;
    }

    /* ---------- program index (one per program object) ---------- */
    const indexCache = new WeakMap();
    function index(p) {
        let ix = indexCache.get(p);
        if (!ix) { ix = buildIndex(p); indexCache.set(p, ix); }
        return ix;
    }

    const ROLE_OF_TAG = { readout: 'read', encode: 'phase', rewind: 'phase', blip: 'phase', slice: 'slice', rephase: 'slice',
        crush: 'crush', spoil: 'spoil', prephase: null, manual: null };

    function buildIndex(p) {
        const rf = sortedByT0(p.rf || []), adc = sortedByT0(p.adc || []), blocks = sortedByT0(p.blocks || []);
        const periods = p.periods && p.periods.length ? p.periods : [{ t0: 0, dur: p.duration || 0, index: 0, vars: {}, dummy: false }];
        const ix = {
            p: p, rf: rf, adc: adc, blocks: blocks, periods: periods,
            rfT0: times(rf, 't0'), adcT0: times(adc, 't0'), blkT0: times(blocks, 't0'), perT0: times(periods, 't0'),
            grad: {}, gT0: {}, group: {}, role: {}, echo: new Map(), auto: new Map()
        };
        let gmax = 0;
        AXES.forEach(function (a) {
            const list = sortedByT0((p.grad && p.grad[a]) || []);
            ix.grad[a] = list;
            ix.gT0[a] = times(list, 't0');
            for (let i = 0; i < list.length; i++) gmax = Math.max(gmax, Math.abs(list[i].amp));
        });
        ix.gmax = gmax > 0 ? gmax : 0.01;
        let maxFlip = 0;
        for (let i = 0; i < rf.length; i++) maxFlip = Math.max(maxFlip, Math.abs(rf[i].flip));
        ix.maxFlip = maxFlip > 0 ? maxFlip : 90;

        // Pulses that move k: excitations reset it, refocusing pulses negate it.
        const exc = rf.filter(function (r) { return r.role === 'excite'; });
        const ref = rf.filter(function (r) { return r.role === 'refocus'; });
        ix.exc = exc; ix.excT = times(exc, 't');
        ix.refT = times(ref, 't');
        ix.spoilT = Float64Array.from((p.spoil || []).map(function (s) { return s.t; })).sort();

        // Row role labels from the tags on each axis ("Gy phase", "Gx read").
        AXES.forEach(function (a) {
            const seen = {};
            ix.grad[a].forEach(function (tr) { const r = ROLE_OF_TAG[tr.tag]; if (r) seen[r] = true; });
            const main = ['read', 'phase', 'slice'].filter(function (r) { return seen[r]; });
            ix.role[a] = main.length ? main.join(' + ') : (seen.crush ? 'crush' : (seen.spoil ? 'spoil' : ''));
        });

        /* Ladder groups: the "same" lobe in every period (same source line,
           tag and order within its period, on the same axis). When its
           amplitude changes from period to period (phase encoding, or the
           rotating readout of a radial scan), every amplitude is drawn
           faintly behind the current one. Heights are linear inside a
           group, so the rungs of the ladder are evenly spaced. */
        AXES.forEach(function (a) {
            const list = ix.grad[a], map = new Map(), of = new Array(list.length);
            let curPer = null, count = new Map();
            for (let i = 0; i < list.length; i++) {
                const tr = list[i];
                if (tr.period === undefined || tr.period < 0) { of[i] = null; continue; }
                if (tr.period !== curPer) { curPer = tr.period; count = new Map(); }
                const k0 = tr.line + '|' + tr.tag;
                const n = count.get(k0) || 0;
                count.set(k0, n + 1);
                const key = k0 + '|' + n;
                let g = map.get(key);
                if (!g) { g = { amps: [], max: 0 }; map.set(key, g); }
                g.amps.push(tr.amp);
                g.max = Math.max(g.max, Math.abs(tr.amp));
                of[i] = g;
            }
            map.forEach(function (g) {
                const s = g.amps.slice().sort(function (x, y) { return x - y; });
                const tol = 1e-6 * (g.max || 1);
                const u = [];
                for (let i = 0; i < s.length; i++) if (!u.length || s[i] - u[u.length - 1] > tol) u.push(s[i]);
                g.amps = u;
                g.ladder = u.length > 1;
            });
            ix.group[a] = of;
        });
        return ix;
    }

    function periodOf(ix, t) { return Math.max(0, lastLE(ix.perT0, t)); }

    /* ---------- nominal k(t) ---------- */
    function kState(p, t) {
        if (!p || p.ok === false) return null;
        const ix = index(p);
        const e = lastLE(ix.excT, t);
        if (e < 0) return null;
        const ex = ix.exc[e];
        let kx = 0, ky = 0, tp = ex.t, nRef = 0;
        for (let j = firstGT(ix.refT, ex.t); j < ix.refT.length && ix.refT[j] <= t; j++) {
            const tr = ix.refT[j];
            kx = -(kx + area(p, 'x', tp, tr));
            ky = -(ky + area(p, 'y', tp, tr));
            tp = tr; nRef++;
        }
        kx += area(p, 'x', tp, t);
        ky += area(p, 'y', tp, t);
        const s = firstGT(ix.spoilT, ex.t);
        const spoiled = s < ix.spoilT.length && ix.spoilT[s] <= t;
        return { kx: kx * GB, ky: ky * GB, tExc: ex.t, exc: ex, spoiled: spoiled, nRef: nRef };
    }

    /* Annotation times of one period: TE (excitation centre to the echo of
       the readout nearest k = 0 in this period), TI (inversion to that
       excitation) and TR (the period, measured from its first pulse). */
    function periodEcho(p, pi) {
        const ix = index(p);
        pi = U.clamp(pi | 0, 0, ix.periods.length - 1);
        if (ix.echo.has(pi)) return ix.echo.get(pi);
        const per = ix.periods[pi], P0 = per.t0, P1 = per.t0 + per.dur;
        const out = { tExc: null, tEcho: null, te: null, tInv: null, ti: null, trStart: null, tr: null };
        let best = Infinity;
        for (let i = firstGE(ix.adcT0, P0 - 1e-9); i < ix.adc.length && ix.adc[i].t0 < P1 - 1e-12; i++) {
            const a = ix.adc[i];
            if (a.anchor !== 'center') continue;
            const k = kState(p, a.tc);
            if (!k) continue;
            const k2 = k.kx * k.kx + k.ky * k.ky;
            if (k2 < best * (1 - 1e-9) - 1e-12) { best = k2; out.tExc = k.tExc; out.tEcho = a.tc; out.te = a.tc - k.tExc; }
        }
        if (out.tExc !== null) {
            // The inversion that prepares this excitation, in the same period.
            for (let j = lastLE(ix.rfT0, out.tExc) - 1; j >= 0 && ix.rf[j].t0 >= P0 - 1e-9; j--) {
                const r = ix.rf[j];
                if (r.role === 'invert') { out.tInv = r.t; out.ti = out.tExc - r.t; break; }
                if (r.role === 'excite') break;
            }
        }
        if (p.stats && p.stats.TR > 0 && p.periods && p.periods.length) {
            const j = firstGE(ix.rfT0, P0 - 1e-9);
            out.trStart = j < ix.rf.length && ix.rf[j].t0 < P1 ? ix.rf[j].t : P0;
            out.tr = per.dur;
        }
        ix.echo.set(pi, out);
        return out;
    }

    /* ---------- the default ("broken axis") view of a period ----------
       Returns [{t0, t1}] spans to show, left to right, separated by
       breaks. The busy parts of the period are always shown; an idle gap
       is compressed when it is much longer than everything else on show,
       except between the excitation and the last readout (TE must stay to
       scale). A short piece of the next period is appended so that its
       first pulse, where TR ends, is visible. */
    function autoSpans(ix, pi) {
        if (ix.auto.has(pi)) return ix.auto.get(pi);
        const per = ix.periods[pi], P0 = per.t0, P1 = per.t0 + per.dur;
        const hasNext = !!(ix.p.stats && ix.p.stats.TR > 0) && ix.p.periods && ix.p.periods.length > 0;
        const busy = [];
        for (let i = firstGE(ix.blkT0, P0 - 1e-9); i < ix.blocks.length && ix.blocks[i].t0 < P1 - 1e-12; i++) {
            const b = ix.blocks[i];
            if (b.kinds && b.kinds.length === 1 && b.kinds[0] === 'wait') continue;
            const s = b.t0, e = b.t0 + b.dur;
            if (busy.length && s <= busy[busy.length - 1][1] + 1e-9) busy[busy.length - 1][1] = Math.max(busy[busy.length - 1][1], e);
            else busy.push([s, e]);
        }
        let spans;
        if (!busy.length) spans = [{ t0: P0, t1: P1 }];
        else {
            // Protected stretch: first excitation to the end of the last readout.
            let prot0 = Infinity, prot1 = -Infinity;
            for (let j = firstGE(ix.rfT0, P0 - 1e-9); j < ix.rf.length && ix.rf[j].t0 < P1; j++) {
                if (ix.rf[j].role === 'excite') { prot0 = ix.rf[j].t0; break; }
            }
            for (let i = firstGE(ix.adcT0, P0 - 1e-9); i < ix.adc.length && ix.adc[i].t0 < P1; i++) {
                prot1 = Math.max(prot1, ix.adc[i].t0 + ix.adc[i].n * ix.adc[i].dwell);
            }
            if (!(prot0 < prot1)) { prot0 = busy[0][0]; prot1 = busy[busy.length - 1][1]; }
            const pieces = [[P0, P0]].concat(busy.map(function (b) { return b.slice(); }));
            if (hasNext) {
                // Show the next period up to the end of its first pulse.
                let lead = busy[0][1] - P0;
                const j = firstGE(ix.rfT0, P0 - 1e-9);
                if (j < ix.rf.length && ix.rf[j].t0 < P1) lead = ix.rf[j].t0 + ix.rf[j].dur - P0;
                lead = Math.min(Math.max(lead, 0), per.dur * 0.5);
                pieces.push([P1, P1 + lead]);
            } else if (pieces[pieces.length - 1][1] < P1) pieces.push([P1, P1]);
            const gaps = [];
            for (let i = 0; i + 1 < pieces.length; i++) {
                const g0 = pieces[i][1], g1 = pieces[i + 1][0];
                gaps.push({ i: i, len: Math.max(0, g1 - g0), fixed: g1 > prot0 + 1e-9 && g0 < prot1 - 1e-9, cut: false });
            }
            let shown = 0;
            pieces.forEach(function (pc) { shown += pc[1] - pc[0]; });
            gaps.forEach(function (g) { shown += g.len; });
            for (;;) {
                let big = null;
                gaps.forEach(function (g) { if (!g.fixed && !g.cut && (!big || g.len > big.len)) big = g; });
                if (!big || big.len < 5e-4 || big.len < 1.5 * (shown - big.len)) break;
                big.cut = true;
                shown -= big.len;
            }
            spans = [];
            let cur = { t0: pieces[0][0], t1: pieces[0][1] };
            for (let i = 0; i + 1 < pieces.length; i++) {
                if (gaps[i].cut) { spans.push(cur); cur = { t0: pieces[i + 1][0], t1: pieces[i + 1][1] }; }
                else cur.t1 = pieces[i + 1][1];
            }
            spans.push(cur);
            // Pads: a little air around each span, proportional to what is shown.
            const pad = Math.max(2e-5, 0.025 * shown);
            spans.forEach(function (s, k) {
                s.t0 -= k === 0 ? pad : pad * 0.6;
                s.t1 += k === spans.length - 1 ? pad : pad * 0.6;
            });
        }
        ix.auto.set(pi, spans);
        return spans;
    }

    /* ---------- RF envelopes, normalised to a peak of 1 ---------- */
    function rfShape(r, u) {
        switch (r.shape) {
            case 'sinc': {
                // Time-bandwidth product bw*dur (4 for the default slice pulse), Hann-windowed.
                const tbw = U.clamp(isFinite(r.bw * r.dur) ? r.bw * r.dur : 4, 2, 16);
                return U.sinc(tbw * (u - 0.5)) * (0.5 + 0.5 * Math.cos(2 * Math.PI * (u - 0.5)));
            }
            case 'gauss': {
                // Spectral FWHM bw <-> temporal FWHM 4 ln2 / (pi bw), as a fraction of the duration.
                const fw = U.clamp(0.8825 / ((r.bw > 0 ? r.bw : 1.6 / r.dur) * r.dur), 0.08, 1.2);
                const sd = fw / 2.3548;
                return Math.exp(-0.5 * Math.pow((u - 0.5) / sd, 2));
            }
            case 'sech': return 1 / Math.cosh(5.3 * (2 * u - 1));
            default: return 1;
        }
    }
    const ROLE_SHORT = { excite: 'exc', refocus: 'ref', invert: 'inv', saturate: 'sat' };
    const ROLE_LONG = { excite: 'excitation', refocus: 'refocusing', invert: 'inversion', saturate: 'saturation' };
    function rfLabel(r) {
        const f = Math.round(Math.abs(r.flip) * 10) / 10 + '°';
        if (r.select === 'water' || r.select === 'fat') return f + ' ' + r.select + ' sat';
        return f + ' ' + (ROLE_SHORT[r.role] || '');
    }
    const TAG_LABEL = { readout: 'readout', prephase: 'prephase', encode: 'encode', rewind: 'rewind', slice: 'slice',
        rephase: 'rephase', crush: 'crush', spoil: 'spoil', blip: 'blip', manual: '' };

    /* ---------- formatting ---------- */
    function fmtMs(s, sig) { return U.fmtNum(s * 1e3, sig || 4) + ' ms'; }
    function fmtDur(s) { return U.fmtTime(s, 3); }
    function niceStep(range, count) {
        const raw = range / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const f = raw / mag;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    }

    /* ---------- styles (scoped to the component root) ---------- */
    let styled = false;
    function ensureStyles() {
        if (styled || !MRI.ui || !MRI.ui.addStyle) return;
        styled = true;
        MRI.ui.addStyle([
            '.mri-timing { position: relative; min-width: 0; }',
            '.mri-timing .mt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 6px; }',
            '.mri-timing .mt-hint { font-size: 0.74rem; color: var(--muted); margin-right: auto; min-width: 0; }',
            '.mri-timing .mt-tools { display: inline-flex; gap: 6px; flex-wrap: wrap; }',
            '.mri-timing .mt-tools .btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }',
            '.mri-timing .mt-stage { position: relative; border-radius: 6px; touch-action: pan-y; -webkit-user-select: none; user-select: none; }',
            '.mri-timing .mt-stage:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }',
            '.mri-timing .mt-canvas { display: block; width: 100%; cursor: crosshair; }',
            '.mri-timing .mt-stage.is-panning .mt-canvas { cursor: grabbing; }',
            '.mri-timing .mt-stage.near-cursor .mt-canvas { cursor: ew-resize; }',
            '.mri-timing .mt-tip { position: absolute; z-index: 5; pointer-events: none; max-width: min(320px, 90%); padding: 6px 9px; border-radius: 6px;',
            '  background: var(--tip-bg); color: var(--tip-fg); border: 1px solid var(--border); box-shadow: var(--shadow-2);',
            '  font: 0.74rem/1.45 var(--font-sans); white-space: normal; }',
            '.mri-timing .mt-tip b { font-weight: 650; }',
            '.mri-timing .mt-wheelhint { position: absolute; z-index: 6; left: 50%; top: 10px; transform: translateX(-50%); pointer-events: none;',
            '  padding: 4px 10px; border-radius: 999px; background: var(--tip-bg); color: var(--tip-fg); border: 1px solid var(--border);',
            '  box-shadow: var(--shadow-2); font: 0.74rem/1.4 var(--font-sans); white-space: nowrap; opacity: 0; transition: opacity 0.15s ease; }',
            '.mri-timing .mt-wheelhint.is-on { opacity: 0.95; }',
            '.mri-timing .mt-status { margin-top: 6px; min-height: 1.45em; font: 0.74rem/1.45 var(--font-mono); color: var(--muted);',
            '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }',
            '@media (max-width: 640px) { .mri-timing .mt-hint { display: none; } .mri-timing .mt-status { white-space: normal; } }'
        ].join('\n'));
    }

    /* ============================================================
       The component
       ============================================================ */
    let uid = 0;
    function create(container, opts) {
        opts = opts || {};
        ensureStyles();
        const el = U.el;
        const id = 'mri-timing-' + (++uid);
        const rootEl = el('div', { class: 'mri-timing' });
        const S = {
            p: null, ix: null, period: 0, cursor: null,
            view: null,              // null = default view; {r0, r1} = linear window relative to the period start
            trueScale: !!opts.trueScale, ladder: opts.ladder !== false, annotate: opts.annotate !== false,
            colors: null, map: null, layout: null, pending: 0, dirty: true, destroyed: false,
            cursorFns: [], lastAria: '', rfLabels: []
        };

        // Toolbar: zoom out / in, fit, and the amplitude scale toggle.
        let btnScale = null;
        if (opts.toolbar !== false) {
            const mk = function (label, title, fn) {
                return el('button', { type: 'button', class: 'btn btn-xs', title: title, 'aria-label': title, onclick: fn }, label);
            };
            btnScale = el('button', { type: 'button', class: 'btn btn-xs', 'aria-pressed': S.trueScale ? 'true' : 'false',
                title: 'Draw gradient amplitudes to scale (otherwise weak lobes such as readouts are enlarged so they stay visible)',
                onclick: function () {
                    S.trueScale = !S.trueScale;
                    btnScale.setAttribute('aria-pressed', S.trueScale ? 'true' : 'false');
                    schedule();
                } }, 'True amplitudes');
            rootEl.appendChild(el('div', { class: 'mt-bar' }, [
                el('span', { class: 'mt-hint', text: 'Ctrl + scroll or pinch to zoom, drag to pan, double-click to fit. Drag the blue line to move the cursor.' }),
                el('span', { class: 'mt-tools' }, [
                    mk('−', 'Zoom out', function () { zoomBy(1 / 1.6, null); }),
                    mk('+', 'Zoom in', function () { zoomBy(1.6, null); }),
                    mk('Fit', 'Fit the view to the repetition', function () { resetView(); }),
                    btnScale
                ])
            ]));
        }
        const canvas = el('canvas', { class: 'mt-canvas', role: 'img', 'aria-label': opts.ariaLabel || 'Pulse-sequence timing diagram' });
        const tip = el('div', { class: 'mt-tip', hidden: true });
        // A brief note for a plain mouse wheel over the diagram, which scrolls the page.
        const wheelHint = el('div', { class: 'mt-wheelhint', 'aria-hidden': 'true' }, 'Ctrl + scroll to zoom');
        const status = el('div', { class: 'mt-status', id: id + '-status' });
        const stage = el('div', { class: 'mt-stage', tabindex: '0', role: 'group',
            'aria-roledescription': 'timing diagram',
            'aria-label': (opts.ariaLabel || 'Pulse-sequence timing diagram') + '. Left and right arrows move the cursor, plus and minus zoom, 0 fits the view.',
            'aria-describedby': id + '-status' }, [canvas, tip, wheelHint]);
        rootEl.appendChild(stage);
        if (opts.status !== false) rootEl.appendChild(status);
        if (container) container.appendChild(rootEl);

        /* ----- colours (read once, refreshed on theme change) ----- */
        function readColors() {
            const v = function (n, f) { return U.cssVar(n, f); };
            S.colors = {
                rf: v('--seq-rf', '#d9541e'), x: v('--seq-gx', '#2a78d6'), y: v('--seq-gy', '#0f9a6a'), z: v('--seq-gz', '#6250d6'),
                adc: v('--seq-adc', '#b7791f'), fg: v('--fg', '#161b22'), muted: v('--muted', '#586170'), faint: v('--faint', '#8a93a2'),
                grid: v('--grid', '#e8ebf0'), axis: v('--axis', '#a9b1bd'), border: v('--border', '#dde2e9'), card: v('--card', '#ffffff'),
                card2: v('--card-2', '#f7f8fa'), accent: v('--accent', '#2563eb'), warn: v('--warn', '#b45309'),
                sans: v('--font-sans', 'system-ui, sans-serif'), mono: v('--font-mono', 'ui-monospace, monospace')
            };
        }
        readColors();
        const onTheme = function () { readColors(); schedule(); };
        if (MRI.bus) MRI.bus.on('theme:changed', onTheme);

        /* ----- layout: rows top to bottom ----- */
        function layout(w) {
            const ix = S.ix;
            const compact = !!opts.compact;
            const narrow = w < 520;
            const L = { w: w, labelW: narrow ? 44 : 56, rows: [] };
            L.x0 = L.labelW + 4;
            L.x1 = w - 8;
            let y = S.annotate ? (compact ? 20 : 24) : 6;
            L.topLane = S.annotate ? { y0: 0, y1: y } : null;
            const add = function (key, h) { L.rows.push({ key: key, y0: y, y1: y + h, h: h }); y += h; };
            if (ix) {
                if (ix.rf.length) add('rf', compact ? 52 : 62);
                ['z', 'y', 'x'].forEach(function (a) { if (ix.grad[a].length) add(a, compact ? 42 : 50); });
                if (ix.adc.length) add('adc', compact ? 26 : 30);
            } else add('empty', 120);
            L.rowsBottom = y;
            const hasTR = S.annotate && ix && ix.p.stats && ix.p.stats.TR > 0;
            L.botLane = hasTR ? { y0: y, y1: y + (compact ? 20 : 22) } : null;
            if (hasTR) y += compact ? 20 : 22;
            L.axis = { y0: y, y1: y + 24 };
            y += 24;
            L.h = y;
            return L;
        }

        /* ----- time <-> x map over one or more spans ----- */
        const BREAK = 14;
        function currentSpans() {
            const ix = S.ix;
            const per = ix.periods[S.period];
            if (S.view) return [{ t0: per.t0 + S.view.r0, t1: per.t0 + S.view.r1 }];
            return autoSpans(ix, S.period).map(function (s) { return { t0: s.t0, t1: s.t1 }; });
        }
        function buildMap(L) {
            const spans = currentSpans();
            const total = spans.reduce(function (a, s) { return a + (s.t1 - s.t0); }, 0) || 1e-3;
            const avail = Math.max(20, (L.x1 - L.x0) - BREAK * (spans.length - 1));
            const s = avail / total;
            let x = L.x0;
            const segs = spans.map(function (sp, i) {
                const g = { t0: sp.t0, t1: sp.t1, x0: x, x1: x + (sp.t1 - sp.t0) * s, s: s };
                x = g.x1 + (i < spans.length - 1 ? BREAK : 0);
                return g;
            });
            return { segs: segs, s: s, x0: L.x0, x1: L.x1 };
        }
        function xOf(map, t) {
            const g = map.segs;
            if (t <= g[0].t1) return g[0].x0 + (t - g[0].t0) * g[0].s;
            for (let i = 1; i < g.length; i++) {
                if (t < g[i].t0) return (g[i - 1].x1 + g[i].x0) / 2;          // inside a break
                if (t <= g[i].t1) return g[i].x0 + (t - g[i].t0) * g[i].s;
            }
            const l = g[g.length - 1];
            return l.x0 + (t - l.t0) * l.s;
        }
        function tOf(map, x) {
            const g = map.segs;
            for (let i = 0; i < g.length; i++) {
                if (x <= g[i].x1 || i === g.length - 1) {
                    if (i > 0 && x < g[i].x0) return (x - g[i - 1].x1) < (g[i].x0 - x) ? g[i - 1].t1 : g[i].t0;
                    return g[i].t0 + (x - g[i].x0) / g[i].s;
                }
            }
            return g[0].t0;
        }
        function segAt(map, x) {
            const g = map.segs;
            for (let i = 0; i < g.length; i++) if (x >= g[i].x0 - 1 && x <= g[i].x1 + 1) return g[i];
            return null;
        }

        /* ----- amplitude to row height ----- */
        function gradNorm(axis, i, amp) {
            // Linear inside a ladder group; across groups a cube-root curve, so
            // a 2 mT/m readout next to a 45 mT/m spoiler stays visible.
            const A = S.ix.gmax;
            if (S.trueScale) return amp / A;
            const g = S.ix.group[axis][i];
            const gm = g && g.ladder ? g.max : Math.abs(amp);
            if (!(gm > 0)) return 0;
            return (amp / gm) * Math.cbrt(gm / A);
        }

        /* ============================================================
           Drawing
           ============================================================ */
        function schedule() {
            if (S.destroyed || S.pending) return;
            S.pending = raf(function () { S.pending = 0; draw(); });
        }
        function draw() {
            if (S.destroyed) return;
            const w = Math.floor(stage.clientWidth);
            if (!w) { S.dirty = true; return; }                  // hidden: draw when shown
            S.dirty = false;
            const L = layout(w);
            const r = U.setupCanvas(canvas, w, L.h);
            const ctx = r.ctx;
            const C = S.colors;
            ctx.clearRect(0, 0, w, L.h);
            S.layout = L;
            if (!S.ix) {
                S.map = null;
                ctx.fillStyle = C.muted;
                ctx.font = '13px ' + C.sans;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(opts.emptyText || 'No sequence to show yet.', w / 2, L.h / 2);
                status.textContent = '';
                return;
            }
            const map = buildMap(L);
            S.map = map;
            const per = S.ix.periods[S.period];
            const P0 = per.t0, P1 = per.t0 + per.dur;

            const ticks = drawGridAndAxis(ctx, L, map, P0);
            S.rfLabels = [];
            map.segs.forEach(function (g) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(g.x0, 0, g.x1 - g.x0, L.rowsBottom + 2);
                ctx.clip();
                L.rows.forEach(function (row) {
                    if (row.key === 'rf') drawRF(ctx, row, g, P0, P1);
                    else if (row.key === 'adc') drawADC(ctx, row, g, P0, P1);
                    else if (row.key === 'x' || row.key === 'y' || row.key === 'z') drawGrad(ctx, row, g, row.key, P0, P1);
                });
                ctx.restore();
            });
            drawBreaks(ctx, L, map);
            drawTickLabels(ctx, L, ticks);
            drawRFLabels(ctx, L);
            if (S.annotate) drawAnnotations(ctx, L, map);
            drawLabels(ctx, L);
            drawCursor(ctx, L, map);
            updateStatus();
            updateAria();
        }

        function drawGridAndAxis(ctx, L, map, P0) {
            const C = S.colors, labels = [];
            ctx.save();
            // baseline of the axis
            ctx.strokeStyle = C.axis;
            ctx.lineWidth = 1;
            map.segs.forEach(function (g) {
                ctx.beginPath();
                ctx.moveTo(g.x0, L.axis.y0 + 0.5);
                ctx.lineTo(g.x1, L.axis.y0 + 0.5);
                ctx.stroke();
                const span = g.t1 - g.t0;
                const nT = Math.max(1, Math.floor((g.x1 - g.x0) / 64));
                const step = niceStep(span * 1e3, nT) / 1e3;             // seconds
                if (!(step > 0)) return;
                const dec = Math.max(0, Math.min(4, -Math.floor(Math.log10(step * 1e3) + 1e-9)));
                for (let k = Math.ceil((g.t0 - P0) / step - 1e-9); ; k++) {
                    const tr = k * step, t = P0 + tr;
                    if (t > g.t1 + 1e-12) break;
                    const x = g.x0 + (t - g.t0) * g.s;
                    if (x < g.x0 - 0.5 || x > g.x1 + 0.5) continue;
                    ctx.strokeStyle = C.grid;
                    ctx.beginPath();
                    ctx.moveTo(Math.round(x) + 0.5, L.topLane ? L.topLane.y1 : 0);
                    ctx.lineTo(Math.round(x) + 0.5, L.rowsBottom);
                    ctx.stroke();
                    ctx.strokeStyle = C.axis;
                    ctx.beginPath();
                    ctx.moveTo(Math.round(x) + 0.5, L.axis.y0);
                    ctx.lineTo(Math.round(x) + 0.5, L.axis.y0 + 4);
                    ctx.stroke();
                    const v = tr * 1e3;
                    labels.push({ x: x, text: Math.abs(v) < 1e-9 ? '0' : v.toFixed(dec) });
                }
            });
            ctx.restore();
            return labels;
        }
        function drawTickLabels(ctx, L, labels) {
            const C = S.colors;
            ctx.save();
            ctx.font = '10.5px ' + C.sans;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'left';
            ctx.fillStyle = C.muted;
            let right = -Infinity;
            labels.forEach(function (l) {
                const tw = ctx.measureText(l.text).width;
                const x = Math.min(Math.max(l.x - tw / 2, L.x0 - 6), L.w - tw - 1);
                if (x < right + 6) return;                      // would overlap its neighbour
                ctx.fillText(l.text, x, L.axis.y0 + 6);
                right = x + tw;
            });
            ctx.restore();
        }
        /* RF labels are placed by importance (excitation first, then
           refocusing and inversion, then saturation; this repetition before
           its neighbours). A label that would overlap one already placed
           falls back to the flip angle alone, or is left out. */
        const RF_RANK = { excite: 0, refocus: 1, invert: 1, saturate: 2 };
        function drawRFLabels(ctx, L) {
            const C = S.colors;
            ctx.save();
            ctx.font = '600 10.5px ' + C.sans;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            const placed = [];
            const free = function (a, b) { return placed.every(function (q) { return b + 4 < q[0] || a > q[1] + 4; }); };
            S.rfLabels.slice().sort(function (a, b) { return (a.faint - b.faint) || (a.rank - b.rank) || (a.x - b.x); }).forEach(function (l) {
                [l.text, l.short].some(function (text) {
                    const tw = ctx.measureText(text).width;
                    const x = U.clamp(l.x - tw / 2, L.x0, Math.max(L.x0, L.x1 - tw));
                    if (!free(x, x + tw)) return false;
                    placed.push([x, x + tw]);
                    ctx.globalAlpha = l.faint ? 0.45 : 1;
                    ctx.fillStyle = C.fg;
                    ctx.fillText(text, x, l.y);
                    return true;
                });
            });
            ctx.restore();
        }

        function drawRF(ctx, row, g, P0, P1) {
            const C = S.colors, ix = S.ix;
            const base = row.y0 + row.h * 0.80, amp = row.h * 0.56;
            ctx.strokeStyle = C.axis;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(g.x0, Math.round(base) + 0.5);
            ctx.lineTo(g.x1, Math.round(base) + 0.5);
            ctx.stroke();
            const i0 = Math.max(0, lastLE(ix.rfT0, g.t0));
            for (let i = i0; i < ix.rf.length && ix.rf[i].t0 <= g.t1; i++) {
                const r = ix.rf[i];
                if (r.t0 + r.dur < g.t0) continue;
                const xa = g.x0 + (r.t0 - g.t0) * g.s, xb = g.x0 + (r.t0 + r.dur - g.t0) * g.s;
                const hgt = amp * Math.abs(r.flip) / ix.maxFlip;
                const faint = r.t0 < P0 - 1e-9 || r.t0 >= P1 - 1e-9;
                ctx.globalAlpha = faint ? 0.4 : 1;
                const wpx = xb - xa;
                ctx.beginPath();
                ctx.moveTo(xa, base);
                if (wpx < 1.5) {
                    ctx.lineTo(xa, base - hgt);
                } else {
                    const n = Math.max(12, Math.min(160, Math.round(wpx)));
                    for (let j = 0; j <= n; j++) {
                        const u = j / n;
                        ctx.lineTo(xa + u * wpx, base - hgt * rfShape(r, u));
                    }
                    ctx.lineTo(xb, base);
                }
                ctx.globalAlpha = faint ? 0.12 : 0.22;
                ctx.fillStyle = C.rf;
                ctx.fill();
                ctx.globalAlpha = faint ? 0.4 : 1;
                ctx.strokeStyle = C.rf;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                // label (flip and role), drawn after clipping so it is never cut
                const xc = U.clamp((xa + xb) / 2, g.x0, g.x1);
                S.rfLabels.push({ x: xc, y: row.y0 + 12, text: rfLabel(r), short: Math.round(Math.abs(r.flip) * 10) / 10 + '°',
                    faint: faint ? 1 : 0, rank: RF_RANK[r.role] === undefined ? 3 : RF_RANK[r.role] });
            }
            ctx.globalAlpha = 1;
        }

        function trapPath(ctx, x0, s, tr, base, half, h) {
            const xr = x0 + tr.rise * s, xf = xr + tr.flat * s, xe = xf + tr.fall * s;
            ctx.moveTo(x0, base);
            ctx.lineTo(xr, base - h * half);
            ctx.lineTo(xf, base - h * half);
            ctx.lineTo(xe, base);
        }

        function drawGrad(ctx, row, g, axis, P0, P1) {
            const C = S.colors, ix = S.ix, list = ix.grad[axis], T0 = ix.gT0[axis];
            const col = C[axis];
            const base = Math.round(row.y0 + row.h / 2) + 0.5, half = row.h / 2 - 5;
            ctx.strokeStyle = C.axis;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(g.x0, base);
            ctx.lineTo(g.x1, base);
            ctx.stroke();
            const i0 = Math.max(0, lastLE(T0, g.t0));
            ctx.font = '10px ' + C.sans;
            ctx.textAlign = 'center';
            for (let i = i0; i < list.length && list[i].t0 <= g.t1; i++) {
                const tr = list[i];
                if (trapEnd(tr) < g.t0) continue;
                const x0 = g.x0 + (tr.t0 - g.t0) * g.s;
                const wpx = (tr.rise + tr.flat + tr.fall) * g.s;
                const faint = tr.t0 < P0 - 1e-9 || tr.t0 >= P1 - 1e-9;
                const grp = ix.group[axis][i];
                // the phase-encode ladder: every amplitude of this lobe, faintly
                if (S.ladder && grp && grp.ladder && !faint && wpx >= 3) {
                    ctx.save();
                    ctx.globalAlpha = 0.32;
                    ctx.strokeStyle = col;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    const step = Math.max(1, Math.ceil(grp.amps.length / Math.max(8, half * 1.2)));
                    for (let k = 0; k < grp.amps.length; k += step) trapPath(ctx, x0, g.s, tr, base, half, gradNorm(axis, i, grp.amps[k]));
                    trapPath(ctx, x0, g.s, tr, base, half, gradNorm(axis, i, grp.amps[grp.amps.length - 1]));
                    ctx.stroke();
                    ctx.restore();
                }
                const h = gradNorm(axis, i, tr.amp);
                ctx.globalAlpha = faint ? 0.4 : 1;
                ctx.beginPath();
                if (wpx < 1.2) { ctx.moveTo(x0, base); ctx.lineTo(x0, base - h * half); }
                else { trapPath(ctx, x0, g.s, tr, base, half, h); ctx.closePath(); }
                ctx.globalAlpha = faint ? 0.12 : 0.28;
                ctx.fillStyle = col;
                ctx.fill();
                ctx.globalAlpha = faint ? 0.4 : 1;
                ctx.strokeStyle = col;
                ctx.lineWidth = 1.4;
                ctx.stroke();
                // a small tag label below (or above) the lobe when it is wide enough
                const lab = TAG_LABEL[tr.tag];
                if (lab && !faint) {
                    const tw = ctx.measureText(lab).width;
                    if (wpx > tw + 6 && Math.abs(h) > 0) {
                        ctx.globalAlpha = 1;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = C.card;
                        ctx.textBaseline = 'middle';
                        ctx.strokeText(lab, x0 + wpx / 2, h > 0 ? base + 8 : base - 8);
                        ctx.fillStyle = C.muted;
                        ctx.fillText(lab, x0 + wpx / 2, h > 0 ? base + 8 : base - 8);
                    }
                }
            }
            ctx.globalAlpha = 1;
        }

        function drawADC(ctx, row, g, P0, P1) {
            const C = S.colors, ix = S.ix;
            const yc = row.y0 + row.h / 2, bh = Math.min(16, row.h - 10);
            ctx.strokeStyle = C.axis;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(g.x0, Math.round(yc + bh / 2) + 0.5);
            ctx.lineTo(g.x1, Math.round(yc + bh / 2) + 0.5);
            ctx.stroke();
            const i0 = Math.max(0, lastLE(ix.adcT0, g.t0));
            ctx.font = '10px ' + C.sans;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (let i = i0; i < ix.adc.length && ix.adc[i].t0 <= g.t1; i++) {
                const a = ix.adc[i];
                const end = a.t0 + a.n * a.dwell;
                if (end < g.t0) continue;
                const xa = g.x0 + (a.t0 - g.t0) * g.s, xb = Math.max(xa + 1, g.x0 + (end - g.t0) * g.s);
                const faint = a.t0 < P0 - 1e-9 || a.t0 >= P1 - 1e-9;
                ctx.globalAlpha = faint ? 0.4 : 1;
                if (a.dummy) {
                    ctx.setLineDash([3, 3]);
                    ctx.strokeStyle = C.adc;
                    ctx.lineWidth = 1.2;
                    ctx.strokeRect(xa + 0.5, yc - bh / 2 + 0.5, xb - xa - 1, bh - 1);
                    ctx.setLineDash([]);
                    if (xb - xa > 26 && !faint) { ctx.fillStyle = C.muted; ctx.fillText('off', (xa + xb) / 2, yc); }
                } else {
                    ctx.globalAlpha = faint ? 0.15 : 0.35;
                    ctx.fillStyle = C.adc;
                    ctx.fillRect(xa, yc - bh / 2, xb - xa, bh);
                    ctx.globalAlpha = faint ? 0.4 : 1;
                    ctx.strokeStyle = C.adc;
                    ctx.lineWidth = 1.2;
                    ctx.strokeRect(xa + 0.5, yc - bh / 2 + 0.5, Math.max(0.5, xb - xa - 1), bh - 1);
                }
                if (a.anchor === 'center' && xb - xa > 5) {
                    const xc = g.x0 + (a.tc - g.t0) * g.s;
                    ctx.strokeStyle = C.adc;
                    ctx.lineWidth = 1.4;
                    ctx.beginPath();
                    ctx.moveTo(xc, yc - bh / 2 - 3);
                    ctx.lineTo(xc, yc + bh / 2 + 3);
                    ctx.stroke();
                }
            }
            ctx.globalAlpha = 1;
        }

        function drawBreaks(ctx, L, map) {
            const C = S.colors;
            for (let i = 0; i + 1 < map.segs.length; i++) {
                const xa = map.segs[i].x1, xb = map.segs[i + 1].x0, xm = (xa + xb) / 2;
                ctx.fillStyle = C.card;
                ctx.fillRect(xa + 1, 0, xb - xa - 2, L.axis.y0 + 5);
                ctx.strokeStyle = C.axis;
                ctx.lineWidth = 1.2;
                [-3, 3].forEach(function (d) {
                    ctx.beginPath();
                    for (let y = 0, k = 0; y <= L.axis.y0 + 6; y += 6, k++) {
                        const x = xm + d + (k % 2 ? 2 : -2);
                        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    }
                    ctx.stroke();
                });
            }
        }

        function dimension(ctx, x0, x1, y, label, map, L, ext) {
            const C = S.colors;
            if (!isFinite(x0) || !isFinite(x1)) return;
            const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
            ctx.save();
            ctx.strokeStyle = C.muted;
            ctx.fillStyle = C.muted;
            ctx.lineWidth = 1;
            // extension lines down to the events
            ctx.setLineDash([2, 3]);
            ext.forEach(function (e) {
                ctx.beginPath();
                ctx.moveTo(Math.round(e.x) + 0.5, y);
                ctx.lineTo(Math.round(e.x) + 0.5, e.y);
                ctx.stroke();
            });
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(lo, y + 0.5);
            ctx.lineTo(hi, y + 0.5);
            ctx.stroke();
            const ah = Math.min(5, (hi - lo) / 3);
            if (ah > 1) {
                ctx.beginPath();
                ctx.moveTo(lo, y + 0.5); ctx.lineTo(lo + ah, y - 2.5); ctx.lineTo(lo + ah, y + 3.5); ctx.closePath();
                ctx.moveTo(hi, y + 0.5); ctx.lineTo(hi - ah, y - 2.5); ctx.lineTo(hi - ah, y + 3.5); ctx.closePath();
                ctx.fill();
            }
            ctx.font = '600 11px ' + C.sans;
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(label).width;
            let xl = (lo + hi) / 2 - tw / 2;
            if (hi - lo < tw + 14) xl = hi + 5;                         // no room inside: put it after the arrow
            xl = U.clamp(xl, L.x0, Math.max(L.x0, L.x1 - tw));
            ctx.fillStyle = C.card;
            ctx.fillRect(xl - 3, y - 7, tw + 6, 14);
            ctx.fillStyle = C.fg;
            ctx.textAlign = 'left';
            ctx.fillText(label, xl, y + 0.5);
            ctx.restore();
        }

        function drawAnnotations(ctx, L, map) {
            const ix = S.ix, row = {};
            L.rows.forEach(function (r) { row[r.key] = r; });
            const e = periodEcho(ix.p, S.period);
            const xmin = map.segs[0].x0 - 2, xmax = map.segs[map.segs.length - 1].x1 + 2;
            const inView = function (x) { return x >= xmin && x <= xmax; };
            const yTop = L.topLane ? (L.topLane.y0 + L.topLane.y1) / 2 : 10;
            const rfY = row.rf ? row.rf.y0 + row.rf.h * 0.8 : L.rowsBottom;
            if (e.te !== null && L.topLane) {
                const xa = xOf(map, e.tExc), xb = xOf(map, e.tEcho);
                if (inView(xa) || inView(xb)) {
                    dimension(ctx, xa, xb, yTop, 'TE ' + fmtMs(e.te, 3), map, L,
                        [{ x: xa, y: rfY }, { x: xb, y: row.adc ? row.adc.y1 - 4 : L.rowsBottom }]);
                }
            }
            if (e.ti !== null && L.topLane) {
                const xa = xOf(map, e.tInv), xb = xOf(map, e.tExc);
                if (inView(xa) || inView(xb)) dimension(ctx, xa, xb, yTop, 'TI ' + fmtMs(e.ti, 3), map, L, [{ x: xa, y: rfY }]);
            }
            if (e.tr !== null && L.botLane) {
                const xa = xOf(map, e.trStart), xb = xOf(map, e.trStart + e.tr);
                const yb = (L.botLane.y0 + L.botLane.y1) / 2;
                if (inView(xa) || inView(xb)) {
                    dimension(ctx, xa, xb, yb, 'TR ' + fmtMs(e.tr, 4), map, L,
                        [{ x: xa, y: row.rf ? row.rf.y0 + 14 : L.rowsBottom }, { x: xb, y: row.rf ? row.rf.y0 + 14 : L.rowsBottom }]);
                }
            }
        }

        function drawLabels(ctx, L) {
            const C = S.colors, ix = S.ix;
            ctx.save();
            ctx.fillStyle = C.card;
            ctx.fillRect(0, 0, L.labelW, L.h);
            ctx.textAlign = 'left';
            const name = { rf: 'RF', x: 'Gx', y: 'Gy', z: 'Gz', adc: 'ADC' };
            L.rows.forEach(function (r) {
                if (!name[r.key]) return;
                const col = r.key === 'rf' ? C.rf : (r.key === 'adc' ? C.adc : C[r.key]);
                const role = (r.key === 'x' || r.key === 'y' || r.key === 'z') ? ix.role[r.key] : '';
                const yc = r.key === 'rf' ? r.y0 + r.h * 0.62 : r.y0 + r.h / 2;
                ctx.fillStyle = col;
                ctx.fillRect(0, yc - (role ? 13 : 7), 3, role ? 26 : 14);
                ctx.font = '700 12.5px ' + C.sans;
                ctx.textBaseline = 'middle';
                ctx.fillStyle = C.fg;
                ctx.fillText(name[r.key], 8, role ? yc - 6 : yc);
                if (role) {
                    ctx.font = '10.5px ' + C.sans;
                    ctx.fillStyle = C.muted;
                    let t = role;
                    while (t.length > 3 && ctx.measureText(t).width > L.labelW - 9) t = t.slice(0, -2) + '…';
                    ctx.fillText(t, 8, yc + 8);
                }
            });
            ctx.font = '10.5px ' + C.sans;
            ctx.fillStyle = C.muted;
            ctx.textBaseline = 'top';
            ctx.fillText('ms', 8, L.axis.y0 + 6);
            ctx.restore();
        }

        function drawCursor(ctx, L, map) {
            if (S.cursor === null || !isFinite(S.cursor)) return;
            const C = S.colors;
            const x = xOf(map, S.cursor);
            if (x < L.x0 - 1 || x > L.x1 + 1) return;
            ctx.save();
            ctx.strokeStyle = C.accent;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, 0);
            ctx.lineTo(Math.round(x) + 0.5, L.axis.y0);
            ctx.stroke();
            ctx.fillStyle = C.accent;
            ctx.beginPath();
            ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        /* ----- what is happening at the cursor (status line) ----- */
        function eventsAt(t) {
            const ix = S.ix, p = ix.p, out = { rf: null, adc: null, g: {} };
            const ri = lastLE(ix.rfT0, t);
            if (ri >= 0 && t <= ix.rf[ri].t0 + ix.rf[ri].dur) out.rf = ix.rf[ri];
            const ai = lastLE(ix.adcT0, t);
            if (ai >= 0 && t <= ix.adc[ai].t0 + ix.adc[ai].n * ix.adc[ai].dwell) out.adc = ix.adc[ai];
            AXES.forEach(function (a) {
                if (!ix.grad[a].length) return;
                const j = lastLE(ix.gT0[a], t);
                out.g[a] = { amp: gradAt(p, a, t), trap: j >= 0 && t <= trapEnd(ix.grad[a][j]) ? ix.grad[a][j] : null };
            });
            return out;
        }
        function updateStatus() {
            if (opts.status === false) return;
            if (!S.ix || S.cursor === null || !isFinite(S.cursor)) {
                status.textContent = S.ix ? 'Click the diagram to place the cursor.' : '';
                return;
            }
            const cur = S.ix.periods[S.period];
            const ev = eventsAt(S.cursor);
            const rel = S.cursor - cur.t0;
            let where;
            if (rel < -1e-9) where = 't = ' + fmtMs(rel, 4) + ' (before this repetition starts)';
            else if (rel > cur.dur + 1e-9) where = 't = ' + fmtMs(rel - cur.dur, 4) + ' into the next repetition';
            else where = 't = ' + fmtMs(rel, 4) + ' from the start of this repetition';
            const parts = [where];
            if (S.ix.rf.length) parts.push(ev.rf ? 'RF on (' + rfLabel(ev.rf) + ')' : 'RF off');
            AXES.slice().reverse().forEach(function (a) {
                if (!ev.g[a]) return;
                const v = ev.g[a].amp;
                parts.push('G' + a + ' ' + (Math.abs(v) < 1e-7 ? '0' : U.fmtNum(v * 1e3, 3)) + ' mT/m' + (ev.g[a].trap && Math.abs(v) >= 1e-7 && TAG_LABEL[ev.g[a].trap.tag] ? ' (' + TAG_LABEL[ev.g[a].trap.tag] + ')' : ''));
            });
            if (S.ix.adc.length) parts.push(ev.adc ? (ev.adc.dummy ? 'ADC off (dummy)' : 'ADC sampling') : 'ADC off');
            status.textContent = parts.join(' · ');
        }
        function updateAria() {
            const ix = S.ix;
            if (!ix) return;
            const e = periodEcho(ix.p, S.period);
            const per = ix.periods[S.period];
            const bits = [(ix.p.name ? ix.p.name + ': ' : '') + 'timing diagram'];
            const rfs = [];
            for (let i = firstGE(ix.rfT0, per.t0 - 1e-9); i < ix.rf.length && ix.rf[i].t0 < per.t0 + per.dur && rfs.length < 6; i++) {
                rfs.push(rfLabel(ix.rf[i]) + ' at ' + fmtMs(ix.rf[i].t - per.t0, 3));
            }
            if (rfs.length) bits.push('RF pulses ' + rfs.join(', '));
            if (e.te !== null) bits.push('TE ' + fmtMs(e.te, 3));
            if (e.ti !== null) bits.push('TI ' + fmtMs(e.ti, 3));
            if (e.tr !== null) bits.push('TR ' + fmtMs(e.tr, 4));
            const rows = ['z', 'y', 'x'].filter(function (a) { return ix.grad[a].length; }).map(function (a) { return 'G' + a + (ix.role[a] ? ' ' + ix.role[a] : ''); });
            if (rows.length) bits.push('gradient rows ' + rows.join(', '));
            const label = bits.join('; ') + '.';
            if (label !== S.lastAria) { S.lastAria = label; canvas.setAttribute('aria-label', label); }
        }

        /* ----- hover tooltip ----- */
        function rowAt(y) {
            const L = S.layout;
            if (!L) return null;
            for (let i = 0; i < L.rows.length; i++) if (y >= L.rows[i].y0 && y < L.rows[i].y1) return L.rows[i];
            return null;
        }
        function describe(x, y) {
            const ix = S.ix, map = S.map;
            if (!ix || !map) return null;
            const row = rowAt(y);
            if (!row || x < map.x0 || x > map.x1 || !segAt(map, x)) return null;
            const tol = 3 / map.s;
            const t = tOf(map, x);
            const per = ix.periods[periodOf(ix, t)];
            const rel = function (tt) { return fmtMs(tt - per.t0, 4); };
            if (row.key === 'rf') {
                const i = lastLE(ix.rfT0, t + tol);
                if (i < 0) return null;
                const r = ix.rf[i];
                if (t > r.t0 + r.dur + tol) return null;
                const shape = { sinc: 'sinc', hard: 'hard (rectangular)', gauss: 'Gaussian', sech: 'hyperbolic secant (adiabatic)' }[r.shape] || r.shape;
                const sel = r.select === 'slice' ? 'slice-selective' : (r.select === 'water' || r.select === 'fat' ? r.select + '-selective (spectral)' : 'non-selective');
                return '<b>RF ' + Math.abs(r.flip) + '° ' + (ROLE_LONG[r.role] || '') + ' pulse</b><br>' + shape + ', ' + fmtDur(r.dur) + ', ' + sel +
                    (r.phase ? ', phase ' + r.phase + '°' : '') + (r.offsetHz ? ', offset ' + U.fmtFreq(r.offsetHz, 4) : '') +
                    '<br>centre at ' + rel(r.t) + (r.dummy ? ' (dummy repetition)' : '');
            }
            if (row.key === 'adc') {
                const i = lastLE(ix.adcT0, t + tol);
                if (i < 0) return null;
                const a = ix.adc[i];
                if (t > a.t0 + a.n * a.dwell + tol) return null;
                return '<b>ADC' + (a.dummy ? ' (off: dummy repetition)' : '') + '</b><br>' + a.n + ' samples × ' + fmtDur(a.dwell) + ' = ' + fmtDur(a.n * a.dwell) +
                    '<br>' + (a.anchor === 'center' ? 'echo (centre sample) at ' + rel(a.tc) : 'first sample at ' + rel(a.t0));
            }
            const axis = row.key, list = ix.grad[axis];
            if (!list) return null;
            const j = lastLE(ix.gT0[axis], t + tol);
            if (j < 0) return null;
            const tr = list[j];
            if (t > trapEnd(tr) + tol) return null;
            const ar = tr.amp * (tr.rise / 2 + tr.flat + tr.fall / 2);
            const grp = ix.group[axis][j];
            return '<b>G' + axis + ' ' + (TAG_LABEL[tr.tag] || tr.tag) + '</b>: ' + U.fmtNum(tr.amp * 1e3, 3) + ' mT/m<br>ramps ' + fmtDur(tr.rise) +
                ', flat ' + fmtDur(tr.flat) + ', area ' + U.fmtNum(ar * 1e6, 3) + ' mT·ms/m (Δk ' + U.fmtNum(ar * GB / 1e3, 3) + ' /mm)' +
                (grp && grp.ladder ? '<br>one of ' + grp.amps.length + ' amplitudes of this lobe (faint ladder)' : '');
        }
        function showTip(ev) {
            const rect = canvas.getBoundingClientRect();
            const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
            const html = describe(x, y);
            if (!html) { tip.hidden = true; return; }
            tip.innerHTML = html;
            tip.hidden = false;
            const tw = tip.offsetWidth, th = tip.offsetHeight, W = stage.clientWidth;
            let left = x + 14, top = y + 14;
            if (left + tw > W) left = Math.max(0, x - tw - 10);
            if (top + th > stage.clientHeight) top = Math.max(0, y - th - 10);
            tip.style.left = left + 'px';
            tip.style.top = top + 'px';
        }

        /* ============================================================
           Interaction: cursor drag, pan, wheel and pinch zoom, keys
           ============================================================ */
        function emitCursor() {
            const t = S.cursor;
            S.cursorFns.forEach(function (fn) {
                try { fn(t); } catch (e) { if (root.console) root.console.error('[timing] onCursor failed:', e); }
            });
        }
        function moveCursorTo(t) {
            S.cursor = t;
            schedule();
            emitCursor();
        }
        function viewSpan() {
            const sp = currentSpans();
            return { t0: sp[0].t0, t1: sp[sp.length - 1].t1 };
        }
        /* The widest view, relative to the period start: the whole repetition
           as the default view frames it (a little air before the period, and
           the next period up to its first pulse, where TR ends). Zooming out
           and panning stop there, so the diagram never drifts into empty
           time before the sequence or into later repetitions. */
        function extent() {
            const sp = autoSpans(S.ix, S.period), P0 = S.ix.periods[S.period].t0;
            return { r0: sp[0].t0 - P0, r1: sp[sp.length - 1].t1 - P0 };
        }
        // Shift a linear window [r0, r0 + span] so that it lies inside the extent.
        function fitView(r0, span) {
            const ex = extent();
            span = Math.min(span, ex.r1 - ex.r0);
            if (r0 + span > ex.r1) r0 = ex.r1 - span;
            if (r0 < ex.r0) r0 = ex.r0;
            return { r0: r0, r1: r0 + span };
        }
        // Zoomed in: a linear window narrower than the whole repetition.
        function isZoomed() {
            if (!S.view || !S.ix) return false;
            const ex = extent();
            return S.view.r1 - S.view.r0 < (ex.r1 - ex.r0) * 0.999;
        }
        /* Switch to a linear window with `scale` px per second, keeping time
           tp under pixel x (as far as the extent allows). */
        function setLinear(tp, x, scale) {
            const ix = S.ix, L = S.layout;
            if (!ix || !L) return;
            const W = L.x1 - L.x0;
            const ex = extent();
            const span = U.clamp(W / scale, Math.min(2e-5, ex.r1 - ex.r0), ex.r1 - ex.r0);
            const t0 = tp - (x - L.x0) * span / W;
            const P0 = ix.periods[S.period].t0;
            S.view = fitView(t0 - P0, span);
            schedule();
        }
        function zoomBy(f, x) {
            const map = S.map, L = S.layout;
            if (!map || !L) return;
            if (x === null || x === undefined) {
                x = S.cursor !== null && isFinite(S.cursor) ? xOf(map, S.cursor) : (L.x0 + L.x1) / 2;
                if (x < L.x0 || x > L.x1) x = (L.x0 + L.x1) / 2;
            }
            const g = segAt(map, x) || map.segs[0];
            const tp = tOf(map, x);
            setLinear(tp, x, g.s * f);
        }
        function panBy(dx) {
            const map = S.map, L = S.layout;
            if (!map || !L) return;
            if (!S.view) {
                // Leave the broken view: keep the scale of the span under the middle.
                const xm = (L.x0 + L.x1) / 2, g = segAt(map, xm) || map.segs[0];
                setLinear(tOf(map, xm), xm, g.s);
                S.map = buildMap(L);
            }
            const s = S.map.s;
            S.view = fitView(S.view.r0 - dx / s, S.view.r1 - S.view.r0);
            schedule();
        }
        function resetView() { S.view = null; schedule(); }

        const ptrs = new Map();
        let drag = null;
        function localX(ev) { return ev.clientX - canvas.getBoundingClientRect().left; }
        function nearCursor(x) {
            if (!S.map || S.cursor === null || !isFinite(S.cursor)) return false;
            return Math.abs(xOf(S.map, S.cursor) - x) <= 7;
        }
        stage.addEventListener('pointerdown', function (ev) {
            if (!S.ix || !S.map) return;
            if (ev.pointerType === 'mouse' && ev.button !== 0) return;
            ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ }
            tip.hidden = true;
            if (ptrs.size === 2) {
                const a = Array.from(ptrs.values());
                drag = { mode: 'pinch', d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, lastF: 1 };
                return;
            }
            const x = localX(ev);
            drag = { mode: nearCursor(x) ? 'cursor' : 'maybe', x0: ev.clientX, lastX: ev.clientX, moved: false, id: ev.pointerId };
            if (drag.mode === 'cursor') stage.classList.add('near-cursor');
        });
        stage.addEventListener('pointermove', function (ev) {
            if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
            if (!drag) {
                if (ev.pointerType === 'mouse') {
                    stage.classList.toggle('near-cursor', nearCursor(localX(ev)));
                    showTip(ev);
                }
                return;
            }
            if (drag.mode === 'pinch' && ptrs.size >= 2) {
                const a = Array.from(ptrs.values());
                const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
                const f = d / drag.d0;
                if (Math.abs(f / drag.lastF - 1) > 0.02) {
                    const xm = (a[0].x + a[1].x) / 2 - canvas.getBoundingClientRect().left;
                    zoomBy(f / drag.lastF, xm);
                    drag.lastF = f;
                }
                return;
            }
            if (drag.id !== ev.pointerId) return;
            const dx = ev.clientX - drag.lastX;
            if (!drag.moved && Math.abs(ev.clientX - drag.x0) < 4) return;
            drag.moved = true;
            if (drag.mode === 'cursor') {
                const x = U.clamp(localX(ev), S.map.x0, S.map.x1);
                moveCursorTo(tOf(S.map, x));
            } else {
                if (drag.mode === 'maybe') { drag.mode = 'pan'; stage.classList.add('is-panning'); }
                panBy(dx);
            }
            drag.lastX = ev.clientX;
        });
        function endPointer(ev) {
            ptrs.delete(ev.pointerId);
            if (!drag) return;
            if (drag.mode === 'pinch') { if (ptrs.size < 2) drag = null; return; }
            if (drag.id !== ev.pointerId) return;
            if (!drag.moved && ev.type === 'pointerup' && S.map) {
                const x = localX(ev);
                if (x >= S.map.x0 && x <= S.map.x1) moveCursorTo(tOf(S.map, x));
            }
            drag = null;
            stage.classList.remove('is-panning');
            stage.classList.remove('near-cursor');
        }
        stage.addEventListener('pointerup', endPointer);
        stage.addEventListener('pointercancel', endPointer);
        stage.addEventListener('pointerleave', function () { if (!drag) tip.hidden = true; });
        stage.addEventListener('dblclick', function (ev) { ev.preventDefault(); resetView(); });
        /* The mouse wheel. A plain wheel scrolls the page as it does
           everywhere else (a diagram a third of the screen high must not trap
           the scroll); Ctrl or Cmd + wheel zooms, and so does a trackpad pinch,
           which the browser delivers as a wheel event with ctrlKey set. A
           sideways wheel or swipe pans, but only while zoomed in, when there
           is somewhere to pan to. */
        let wheelHintTimer = 0;
        function flashWheelHint() {
            wheelHint.classList.add('is-on');
            if (wheelHintTimer) clearTimeout(wheelHintTimer);
            wheelHintTimer = setTimeout(function () { wheelHintTimer = 0; wheelHint.classList.remove('is-on'); }, 1200);
        }
        stage.addEventListener('wheel', function (ev) {
            if (!S.map) return;
            const unit = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 400 : 1);
            const dx = ev.deltaX * unit, dy = ev.deltaY * unit;
            if (!(ev.ctrlKey || ev.metaKey)) {
                if (Math.abs(dx) > Math.abs(dy)) {
                    if (!isZoomed()) return;
                    ev.preventDefault();
                    tip.hidden = true;
                    panBy(-dx);
                } else if (dy) flashWheelHint();
                return;
            }
            ev.preventDefault();
            tip.hidden = true;
            const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
            if (d) zoomBy(Math.exp(-d * 0.0025), localX(ev));
        }, { passive: false });
        stage.addEventListener('keydown', function (ev) {
            if (!S.ix || !S.map) return;
            const L = S.layout;
            let handled = true;
            if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
                const dir = ev.key === 'ArrowLeft' ? -1 : 1;
                const px = ev.shiftKey ? 40 : 4;
                let x = S.cursor !== null && isFinite(S.cursor) ? xOf(S.map, S.cursor) : (L.x0 + L.x1) / 2;
                x = U.clamp(x + dir * px, S.map.x0, S.map.x1);
                moveCursorTo(tOf(S.map, x));
            } else if (ev.key === '+' || ev.key === '=') zoomBy(1.6, null);
            else if (ev.key === '-' || ev.key === '_') zoomBy(1 / 1.6, null);
            else if (ev.key === '0' || ev.key === 'Home') resetView();
            else handled = false;
            if (handled) ev.preventDefault();
        });

        /* Redraw when the width changes (also when a hidden tab is shown). */
        let ro = null, lastW = -1;
        const onResize = function () {
            const w = stage.clientWidth;
            if (w === lastW && !S.dirty) return;
            lastW = w;
            schedule();
        };
        if (root.ResizeObserver) { ro = new root.ResizeObserver(onResize); ro.observe(stage); }
        else root.addEventListener('resize', onResize);

        /* ----- public API ----- */
        const api = {
            el: rootEl, canvas: canvas,
            setProgram: function (p) {
                if (p && p.ok === false) return api;            // keep showing the last good program
                const prev = S.ix ? S.ix.periods[S.period] : null;
                S.p = p || null;
                S.ix = p ? index(p) : null;
                if (S.ix) {
                    const n = S.ix.periods.length;
                    if (S.period >= n) S.period = n - 1;
                    // Keep the cursor at the same time within its repetition.
                    if (prev && S.cursor !== null && isFinite(S.cursor)) S.cursor = S.ix.periods[S.period].t0 + (S.cursor - prev.t0);
                }
                schedule();
                return api;
            },
            setPeriod: function (i) {
                if (!S.ix) { S.period = Math.max(0, i | 0); return api; }
                const n = U.clamp(Math.round(+i) || 0, 0, S.ix.periods.length - 1);
                if (n === S.period) return api;
                // keep the cursor at the same time within the repetition
                if (S.cursor !== null && isFinite(S.cursor)) S.cursor += S.ix.periods[n].t0 - S.ix.periods[S.period].t0;
                S.period = n;
                schedule();
                return api;
            },
            getPeriod: function () { return S.period; },
            setWindow: function (t0, t1) {
                if (!S.ix || !(t1 > t0)) return api;
                const P0 = S.ix.periods[S.period].t0;
                S.view = { r0: t0 - P0, r1: t1 - P0 };
                schedule();
                return api;
            },
            resetWindow: function () { resetView(); return api; },
            getWindow: function () { return S.ix ? viewSpan() : null; },
            setCursor: function (t) {
                const v = t === null || t === undefined || !isFinite(t) ? null : +t;
                if (v === S.cursor) return api;
                S.cursor = v;
                schedule();
                return api;
            },
            getCursor: function () { return S.cursor; },
            onCursor: function (fn) { if (typeof fn === 'function') S.cursorFns.push(fn); return api; },
            setTrueScale: function (b) {
                S.trueScale = !!b;
                if (btnScale) btnScale.setAttribute('aria-pressed', S.trueScale ? 'true' : 'false');
                schedule();
                return api;
            },
            redraw: function () {
                if (S.pending) { caf(S.pending); S.pending = 0; }
                draw();
                return api;
            },
            destroy: function () {
                S.destroyed = true;
                if (S.pending) caf(S.pending);
                if (wheelHintTimer) clearTimeout(wheelHintTimer);
                if (MRI.bus) MRI.bus.off('theme:changed', onTheme);
                if (ro) ro.disconnect(); else root.removeEventListener('resize', onResize);
                S.cursorFns = [];
                if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
            }
        };
        draw();
        return api;
    }

    MRI.ui = MRI.ui || {};
    MRI.ui.timing = {
        create: create,
        kAt: kState,
        periodEcho: periodEcho,
        // exposed for the Sequence tab and for tests
        _index: index,
        _rfShape: rfShape,
        _autoSpans: function (p, i) { return autoSpans(index(p), i); }
    };

})(typeof window !== 'undefined' ? window : globalThis);
