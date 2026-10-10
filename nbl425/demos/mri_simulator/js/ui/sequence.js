/* ============================================================
   MRI Simulator, the Sequence tab

   Where students read and write pulse sequences. From top to bottom:
     - the concept card (a sequence is a score for three instruments);
     - the editor: preset picker, a syntax-highlighted DSL editor with
       line numbers and error marks, compile errors with clickable
       line numbers, and the language reference;
     - parameter sliders generated from the program's `param` lines;
       moving one rewrites that line of the source (and it flashes);
     - the timing diagram of one repetition (MRI.ui.timing), with a
       repetition selector and a cursor that follows playback;
     - the k-space trajectory of that repetition, the "spin phase"
       pattern the gradients have wound across the FOV at the cursor,
       and a table of the numbers that follow from the sequence.

   While the source does not compile, every panel keeps showing the
   last program that did (state.lastGoodProgram) and says so.
   Work done while the tab is hidden is limited to bookkeeping; the
   panels catch up in onShow.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || !MRI.util) return;
    const U = MRI.util;
    const doc = root.document;
    const GB = MRI.const.GAMMA_BAR;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };

    /* ---------- small helpers ---------- */
    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function fmtMs(s, sig) { return U.fmtNum(s * 1e3, sig || 4); }
    function firstGE(a, t) {
        let lo = 0, hi = a.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t) lo = m + 1; else hi = m; }
        return lo;
    }
    // k in cycles/m shown in 1/mm; float noise below 5e-5 /mm prints as 0
    function fmtK(v) { return Math.abs(v) < 0.05 ? '0' : U.fmtNum(v / 1e3, 3); }
    function niceStep(raw) {
        if (!(raw > 0)) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const f = raw / mag;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    }
    function isMac() { return /Mac|iPhone|iPad|iPod/.test((root.navigator && (root.navigator.platform || root.navigator.userAgent)) || ''); }
    function toast(msg, kind, opts) { if (MRI.ui.w && MRI.ui.w.toast) return MRI.ui.w.toast(msg, kind, opts); return null; }
    function imagingPresets() {
        const P = MRI.presets;
        return Array.isArray(P) ? P.filter(function (p) { return p.group === 'imaging'; }) : [];
    }
    function getPreset(id) { return MRI.presets && MRI.presets.get ? MRI.presets.get(id) : null; }

    /* ============================================================
       Styles (all scoped under #tab-sequence)
       ============================================================ */
    const CSS = `
#tab-sequence {
    --ed-fs: 13px; --ed-lh: 20px; --ed-pad-y: 10px; --ed-pad-x: 12px;
    --syn-ev-rf: #b23a0a; --syn-ev-gx: #1d4ed8; --syn-ev-gy: #046c4c; --syn-ev-gz: #6d28d9; --syn-ev-adc: #8a5805;
    --syn-opt: #0b6a82; --syn-unit: #9c4508; --syn-str: #57534e; --syn-com: #5e6672; --syn-label: #be123c; --syn-fn: #4b5563;
}
@media (pointer: coarse) { #tab-sequence { --ed-fs: 16px; --ed-lh: 24px; } }
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) #tab-sequence {
        --syn-ev-rf: #fb923c; --syn-ev-gx: #7cb4f8; --syn-ev-gy: #4ade9f; --syn-ev-gz: #b4a6f8; --syn-ev-adc: #facc15;
        --syn-opt: #5fd4e8; --syn-unit: #fbbf6b; --syn-str: #b8b2aa; --syn-com: #8b98ab; --syn-label: #fda4af; --syn-fn: #c3cad6;
    }
}
:root[data-theme="dark"] #tab-sequence {
    --syn-ev-rf: #fb923c; --syn-ev-gx: #7cb4f8; --syn-ev-gy: #4ade9f; --syn-ev-gz: #b4a6f8; --syn-ev-adc: #facc15;
    --syn-opt: #5fd4e8; --syn-unit: #fbbf6b; --syn-str: #b8b2aa; --syn-com: #8b98ab; --syn-label: #fda4af; --syn-fn: #c3cad6;
}

#tab-sequence .seq-top { align-items: start; }
#tab-sequence .seq-presetrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 6px; }
#tab-sequence .seq-presetrow .ctl { min-width: 0; flex: 1 1 260px; max-width: 420px; }
#tab-sequence .seq-presetrow .ctl-inline > select { width: 100%; min-width: 0; }
#tab-sequence .seq-presetrow .ctl-inline { display: grid; grid-template-columns: auto minmax(0, 1fr); }
#tab-sequence .seq-summary { font-size: 0.86rem; color: var(--muted); margin: 0 0 10px; }
#tab-sequence .seq-edtools { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* the editor: a transparent textarea exactly over a highlighted <pre> */
#tab-sequence .seq-editor {
    position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr);
    height: clamp(260px, 46vh, 520px); border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
    background: var(--card); overflow: hidden;
}
#tab-sequence .seq-editor:focus-within { border-color: var(--focus); box-shadow: 0 0 0 3px var(--focus-ring); }
#tab-sequence .ed-gutter {
    position: relative; overflow: hidden; background: var(--card-2); border-right: 1px solid var(--border);
    color: var(--muted); -webkit-user-select: none; user-select: none; text-align: right;
    font-family: var(--font-mono); font-size: calc(var(--ed-fs) - 1px); line-height: var(--ed-lh);
}
#tab-sequence .ed-gutter-inner { padding: var(--ed-pad-y) 8px var(--ed-pad-y) 10px; min-width: 3.4em; will-change: transform; }
#tab-sequence .ed-gutter-inner > span { display: block; height: var(--ed-lh); }
#tab-sequence .ed-gutter-inner > .is-err { color: var(--bad); font-weight: 700; }
#tab-sequence .ed-main { position: relative; overflow: hidden; min-width: 0; }
#tab-sequence .ed-hl, #tab-sequence textarea.ed-ta {
    font-family: var(--font-mono); font-size: var(--ed-fs); line-height: var(--ed-lh);
    font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0; letter-spacing: 0; tab-size: 4; -moz-tab-size: 4;
    padding: var(--ed-pad-y) var(--ed-pad-x); margin: 0; border: 0; white-space: pre; word-wrap: normal; overflow-wrap: normal;
    text-rendering: optimizeSpeed;
}
#tab-sequence .ed-hl {
    position: absolute; top: 0; left: 0; min-width: 100%; width: max-content; background: transparent; color: var(--fg);
    pointer-events: none; border-radius: 0; overflow: visible; will-change: transform;
}
#tab-sequence textarea.ed-ta {
    position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; resize: none; display: block;
    background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--fg);
    overflow: auto; border-radius: 0; box-shadow: none; outline: none;
}
#tab-sequence textarea.ed-ta:focus, #tab-sequence textarea.ed-ta:focus-visible { box-shadow: none; outline: none; border: 0; }
#tab-sequence textarea.ed-ta::selection { background: rgba(37, 99, 235, 0.30); -webkit-text-fill-color: transparent; }
#tab-sequence .ed-line { display: block; min-height: var(--ed-lh); margin: 0 calc(-1 * var(--ed-pad-x)); padding: 0 var(--ed-pad-x); }
#tab-sequence .ed-line.is-err { background: var(--bad-soft); box-shadow: inset 3px 0 0 var(--bad); }
#tab-sequence .ed-line.is-flash { background: var(--warn-soft); box-shadow: inset 3px 0 0 var(--warn); }
#tab-sequence .tk-kw { font-weight: 700; }
#tab-sequence .tk-ev { font-weight: 700; }
#tab-sequence .tk-ev-rf { color: var(--syn-ev-rf); }
#tab-sequence .tk-ev-gx { color: var(--syn-ev-gx); }
#tab-sequence .tk-ev-gy { color: var(--syn-ev-gy); }
#tab-sequence .tk-ev-gz { color: var(--syn-ev-gz); }
#tab-sequence .tk-ev-adc { color: var(--syn-ev-adc); }
#tab-sequence .tk-opt { color: var(--syn-opt); }
#tab-sequence .tk-unit { color: var(--syn-unit); }
#tab-sequence .tk-str { color: var(--syn-str); }
#tab-sequence .tk-com { color: var(--syn-com); font-style: italic; }
#tab-sequence .tk-label { color: var(--syn-label); }
#tab-sequence .tk-fn { color: var(--syn-fn); font-style: italic; }
#tab-sequence .tk-err, #tab-sequence .tk-errpos { text-decoration: underline wavy var(--bad); text-decoration-skip-ink: none; text-underline-offset: 3px; }
#tab-sequence .seq-edfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 8px; font-size: 0.78rem; color: var(--muted); }
#tab-sequence .seq-edfoot .spacer { flex: 1; }

#tab-sequence .seq-msgs { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
#tab-sequence .seq-msg {
    display: block; width: 100%; text-align: left; padding: 8px 10px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--bad-border); background: var(--bad-soft); color: var(--fg); font: 0.86rem/1.45 var(--font-sans);
}
#tab-sequence .seq-msg.is-warn { border-color: var(--warn-border); background: var(--warn-soft); }
#tab-sequence .seq-msg:hover { border-color: var(--bad); }
#tab-sequence .seq-msg.is-warn:hover { border-color: var(--warn); }
#tab-sequence .seq-msg:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-sequence .seq-msg-where { font: 600 0.78rem var(--font-mono); color: var(--bad); margin-right: 6px; }
#tab-sequence .seq-msg.is-warn .seq-msg-where { color: var(--warn); }
#tab-sequence .seq-msg-hint { display: block; color: var(--muted); font-size: 0.82rem; margin-top: 2px; }
#tab-sequence .seq-stale { margin: 10px 0 0; }

#tab-sequence .seq-params .controls { --min: 220px; }
#tab-sequence .seq-pname { font: 600 0.8rem var(--font-mono); color: var(--fg); }
#tab-sequence .seq-pdesc { color: var(--muted); }
#tab-sequence .seq-numrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 8px; }
#tab-sequence .seq-numrow input { width: 8.5em; text-align: right; font-family: var(--font-mono); }
#tab-sequence .seq-numrow .ctl-unit { margin-left: 4px; }
#tab-sequence .ctl.is-bad .ctl-value { color: var(--bad); }

#tab-sequence .seq-periodbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 0 0 10px; }
#tab-sequence .seq-periodbar input[type=range] { flex: 1 1 160px; min-width: 120px; width: auto; }
#tab-sequence .seq-plabel { font: 600 0.84rem var(--font-sans); font-variant-numeric: tabular-nums; min-width: 9em; }
#tab-sequence .seq-pvars { font: 0.8rem var(--font-mono); color: var(--muted); }

#tab-sequence .seq-figure { margin: 0; }
#tab-sequence .seq-canvas { display: block; width: 100%; border-radius: 6px; }
#tab-sequence .seq-canvas.is-scope { background: var(--scope-bg); }
#tab-sequence .seq-readout { margin-top: 8px; font: 0.78rem/1.45 var(--font-mono); color: var(--muted); font-variant-numeric: tabular-nums; min-height: 2.9em; }
#tab-sequence .seq-readout strong { color: var(--fg); font-weight: 650; }
#tab-sequence .seq-legend { margin-top: 8px; }
#tab-sequence .seq-meter { display: inline-block; width: 64px; height: 6px; border-radius: 3px; background: var(--track); vertical-align: middle; margin-right: 8px; overflow: hidden; }
#tab-sequence .seq-meter > span { display: block; height: 100%; background: var(--accent); }
#tab-sequence .seq-meter.is-high > span { background: var(--warn); }

#tab-sequence .dsl-ref { font-size: 0.86rem; }
#tab-sequence .dsl-ref h4 { margin: 14px 0 6px; }
#tab-sequence .dsl-ref table { width: 100%; border-collapse: collapse; margin: 0 0 8px; }
#tab-sequence .dsl-ref td { padding: 5px 8px 5px 0; vertical-align: top; border-top: 1px solid var(--border-subtle); overflow-wrap: anywhere; }
#tab-sequence .dsl-ref td:first-child { width: 42%; }
#tab-sequence .dsl-ref pre { white-space: pre; }
@media (max-width: 640px) {
    #tab-sequence .dsl-ref tr, #tab-sequence .dsl-ref td { display: block; width: auto !important; }
    #tab-sequence .dsl-ref td:first-child { border-top: 1px solid var(--border-subtle); padding-bottom: 0; }
    #tab-sequence .dsl-ref td + td { border-top: 0; padding-top: 2px; }
    #tab-sequence .seq-plabel { min-width: 0; }
}
`;

    /* ============================================================
       Syntax highlighting from MRI.dsl.tokenize
       ============================================================ */
    const EVENTS = { rf: 'rf', gx: 'gx', gy: 'gy', gz: 'gz', adc: 'adc' };
    function highlight(src, errs, flashLine) {
        const kw = (MRI.dsl && MRI.dsl.keywords) || { options: [], functions: [], constants: [] };
        const optSet = new Set(kw.options || []);
        const fnSet = new Set((kw.functions || []).concat(kw.constants || []));
        let toks = [];
        try { toks = MRI.dsl.tokenize(src); } catch (e) { toks = []; }
        // labels: identifiers named after "as"
        const labels = new Set();
        for (let i = 0; i + 1 < toks.length; i++) {
            if (toks[i].type === 'keyword' && toks[i].text === 'as' && toks[i + 1].type === 'ident') labels.add(toks[i + 1].text);
        }
        const errLines = new Set(), errPos = new Set();
        (errs || []).forEach(function (e) { if (e && e.line) { errLines.add(e.line); errPos.add(e.line + ':' + (e.col || 0)); } });
        const lines = [''];
        let pos = 0, firstOnLine = true;
        const put = function (text) {
            // text may contain newlines only for gaps (never inside tokens)
            const parts = text.split('\n');
            for (let i = 0; i < parts.length; i++) {
                if (i > 0) { lines.push(''); firstOnLine = true; }
                lines[lines.length - 1] += esc(parts[i]);
            }
        };
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.start > pos) put(src.slice(pos, t.start));
            if (t.type === 'newline') { put('\n'); pos = t.end; continue; }
            let cls = '';
            const errHere = errPos.has(t.line + ':' + t.col) ? ' tk-errpos' : '';
            switch (t.type) {
                case 'comment': cls = 'tk-com'; break;
                case 'string': cls = 'tk-str'; break;
                case 'error': cls = 'tk-err'; break;
                case 'number': {
                    if (t.unit && t.unitStart > t.start) {
                        lines[lines.length - 1] += '<span class="tk-num' + errHere + '">' + esc(src.slice(t.start, t.unitStart)) +
                            '</span><span class="tk-unit">' + esc(src.slice(t.unitStart, t.end)) + '</span>';
                        pos = t.end; firstOnLine = false;
                        continue;
                    }
                    cls = 'tk-num'; break;
                }
                case 'keyword':
                    if (EVENTS[t.text]) cls = 'tk-ev tk-ev-' + EVENTS[t.text];
                    else if (t.text === 'spoil' || t.text === 'wait') cls = 'tk-ev';
                    else if (!firstOnLine && optSet.has(t.text) && t.text !== 'for') cls = 'tk-opt';
                    else if (!firstOnLine && t.text === 'for' && i > 0 && toks[i - 1].type === 'number') cls = 'tk-opt';
                    else cls = 'tk-kw';
                    break;
                case 'ident':
                    cls = labels.has(t.text) ? 'tk-label' : (fnSet.has(t.text) ? 'tk-fn' : '');
                    break;
                default: cls = '';
            }
            const text = esc(src.slice(t.start, t.end));
            cls += errHere;
            lines[lines.length - 1] += cls ? '<span class="' + cls.trim() + '">' + text + '</span>' : text;
            pos = t.end;
            if (t.type !== 'comment') firstOnLine = false;
        }
        if (pos < src.length) put(src.slice(pos));
        let html = '';
        for (let i = 0; i < lines.length; i++) {
            const n = i + 1;
            const c = 'ed-line' + (errLines.has(n) ? ' is-err' : '') + (flashLine === n ? ' is-flash' : '');
            html += '<span class="' + c + '">' + lines[i] + '</span>';
        }
        return { html: html, nLines: lines.length, errLines: errLines };
    }

    /* ============================================================
       k-space geometry of a program (nominal, section 9.1)
       ============================================================ */
    const trajCache = new WeakMap();
    function progCache(p) {
        let c = trajCache.get(p);
        if (!c) { c = { periods: new Map(), all: null }; trajCache.set(p, c); }
        return c;
    }
    function kAt(p, t) { return MRI.ui.timing ? MRI.ui.timing.kAt(p, t) : null; }

    /* The trajectory of one repetition from its first excitation: pieces
       of polyline (k in cycles/m with the time of each point), the jumps
       made by refocusing pulses (k -> -k), and the ADC windows. */
    function trajectory(p, pi) {
        const cache = progCache(p);
        if (cache.periods.has(pi)) return cache.periods.get(pi);
        const ix = MRI.ui.timing._index(p);
        const per = ix.periods[pi], P0 = per.t0, P1 = per.t0 + per.dur;
        const out = { pieces: [], jumps: [], adcs: [], tStart: null, maxK: 0 };
        let e0 = firstGE(ix.excT, P0 - 1e-9);
        const hasExc = e0 < ix.exc.length && ix.exc[e0].t < P1;
        const tStart = hasExc ? ix.exc[e0].t : null;
        out.tStart = tStart;
        // ADC windows of the period
        for (let i = firstGE(ix.adcT0, P0 - 1e-9); i < ix.adc.length && ix.adc[i].t0 < P1; i++) {
            const a = ix.adc[i], tEnd = a.t0 + Math.max(0, a.n - 1) * a.dwell;
            const m = Math.min(a.n, 24), pts = [];
            for (let j = 0; j <= m; j++) {
                const t = a.t0 + (tEnd - a.t0) * j / m;
                const k = kAt(p, t);
                if (k && !k.spoiled) pts.push([k.kx, k.ky, t]);
            }
            if (pts.length) out.adcs.push({ pts: pts, dummy: !!a.dummy, t0: a.t0, t1: a.t0 + a.n * a.dwell });
        }
        if (!hasExc) { cache.periods.set(pi, out); return out; }
        // events that break the polyline
        const evts = [];
        for (let i = e0 + 1; i < ix.exc.length && ix.exc[i].t < P1; i++) evts.push({ t: ix.exc[i].t, type: 'exc' });
        for (let i = firstGE(ix.refT, tStart + 1e-12); i < ix.refT.length && ix.refT[i] < P1; i++) evts.push({ t: ix.refT[i], type: 'ref' });
        for (let i = firstGE(ix.spoilT, tStart + 1e-12); i < ix.spoilT.length && ix.spoilT[i] <= P1; i++) evts.push({ t: ix.spoilT[i], type: 'spoil' });
        const spoilStarts = new Set();
        ['x', 'y', 'z'].forEach(function (a) {
            const list = ix.grad[a];
            for (let i = firstGE(ix.gT0[a], tStart); i < list.length && list[i].t0 < P1; i++) {
                // only spoilers end the coherent path; crushers keep the echo pathway (they are drawn as normal path)
                if (list[i].tag === 'spoil') spoilStarts.add(list[i].t0);
            }
        });
        spoilStarts.forEach(function (t) { evts.push({ t: t, type: 'spoilStart' }); });
        const ORDER = { spoilStart: 0, ref: 1, spoil: 2, exc: 3 };
        evts.sort(function (a, b) { return a.t - b.t || ORDER[a.type] - ORDER[b.type]; });
        // breakpoints of the in-plane gradients (k is quadratic on ramps: sample them)
        const bps = [];
        ['x', 'y'].forEach(function (a) {
            const list = ix.grad[a];
            for (let i = Math.max(0, firstGE(ix.gT0[a], tStart) - 1); i < list.length && list[i].t0 < P1; i++) {
                const tr = list[i], t1 = tr.t0 + tr.rise, t2 = t1 + tr.flat;
                for (let q = 0; q <= 4; q++) { bps.push(tr.t0 + tr.rise * q / 4); bps.push(t2 + tr.fall * q / 4); }
                bps.push(t1 + tr.flat / 2);
            }
        });
        out.adcs.forEach(function (a) { bps.push(a.t0); bps.push(a.t1); });
        bps.push(P1 - 1e-9);
        bps.sort(function (a, b) { return a - b; });
        let cur = { pts: [[0, 0, tStart]], kind: 'main' }, active = true, ei = 0;
        const push = function (k, t) { if (cur && k) cur.pts.push([k.kx, k.ky, t]); };
        const close = function () { if (cur && cur.pts.length > 1) out.pieces.push(cur); cur = null; };
        const handle = function (ev) {
            if (ev.type === 'exc') { close(); cur = { pts: [[0, 0, ev.t]], kind: 'main' }; active = true; return; }
            if (!active || !cur) return;
            if (ev.type === 'ref') {
                const kb = kAt(p, ev.t - 1e-9), ka = kAt(p, ev.t);
                if (!kb || !ka) return;
                push(kb, ev.t);
                const kind = cur.kind;
                close();
                out.jumps.push({ from: [kb.kx, kb.ky], to: [ka.kx, ka.ky], t: ev.t });
                cur = { pts: [[ka.kx, ka.ky, ev.t]], kind: kind };
            } else if (ev.type === 'spoilStart') {
                const k = kAt(p, ev.t);
                if (!k || k.spoiled) return;
                push(k, ev.t);
                close();
                cur = { pts: [[k.kx, k.ky, ev.t]], kind: 'spoil' };
            } else if (ev.type === 'spoil') {
                push(kAt(p, ev.t - 1e-9), ev.t);
                close();
                active = false;
            }
        };
        for (let b = 0; b < bps.length; b++) {
            const t = bps[b];
            if (t <= tStart || t >= P1) continue;
            while (ei < evts.length && evts[ei].t <= t) handle(evts[ei++]);
            if (active && cur) {
                const k = kAt(p, t);
                if (k && !k.spoiled) push(k, t);
            }
        }
        while (ei < evts.length) handle(evts[ei++]);
        close();
        out.pieces.forEach(function (pc) {
            if (pc.kind !== 'main') return;
            pc.pts.forEach(function (q) { out.maxK = Math.max(out.maxK, Math.abs(q[0]), Math.abs(q[1])); });
        });
        out.adcs.forEach(function (a) { a.pts.forEach(function (q) { out.maxK = Math.max(out.maxK, Math.abs(q[0]), Math.abs(q[1])); }); });
        cache.periods.set(pi, out);
        return out;
    }

    /* The repetition that records the readout nearest k = 0 (the one that
       sets the contrast): the tab opens on it, cursor on its echo. */
    function centrePeriod(p) {
        const c = progCache(p);
        if (c.centre !== undefined) return c.centre;
        let best = Infinity, bi = -1;
        const adc = p.adc || [];
        for (let i = 0; i < adc.length; i++) {
            const a = adc[i];
            if (a.dummy || a.anchor !== 'center' || !(a.period >= 0)) continue;
            const k = kAt(p, a.tc);
            if (!k) continue;
            const k2 = k.kx * k.kx + k.ky * k.ky;
            if (k2 < best * (1 - 1e-9) - 1e-12) { best = k2; bi = a.period; }
        }
        c.centre = bi >= 0 ? bi : firstReal(p);
        return c.centre;
    }

    /* Every recorded readout of the program, as a straight line in k-space
       (start and end sample), for the faint background. */
    function allReadouts(p) {
        const cache = progCache(p);
        if (cache.all) return cache.all;
        const list = (p.adc || []).filter(function (a) { return !a.dummy; });
        const out = new Float64Array(list.length * 4);
        let n = 0, maxK = 0;
        for (let i = 0; i < list.length; i++) {
            const a = list[i];
            const k0 = kAt(p, a.t0), k1 = kAt(p, a.t0 + Math.max(0, a.n - 1) * a.dwell);
            if (!k0 || !k1) continue;
            out[4 * n] = k0.kx; out[4 * n + 1] = k0.ky; out[4 * n + 2] = k1.kx; out[4 * n + 3] = k1.ky;
            maxK = Math.max(maxK, Math.abs(k0.kx), Math.abs(k0.ky), Math.abs(k1.kx), Math.abs(k1.ky));
            n++;
        }
        cache.all = { lines: out, n: n, maxK: maxK };
        return cache.all;
    }

    /* ============================================================
       The tab
       ============================================================ */
    const W = MRI.ui.w;
    const S = {
        mounted: false, visible: false, panel: null,
        shown: null,              // program on display (state.program if ok, else the last good one)
        preview: null,            // program compiled with slider overrides while dragging
        period: 0, cursor: null, presetId: null,
        paramsKey: null, paramRows: {}, activeParam: null, overrides: {},
        typing: null, flashLine: 0, flashTimer: null,
        playing: false, tick: null, frame: 0,
        dirty: { editor: true, params: true, timing: true, k: true, phase: true, stats: true },
        kStatic: null, escTab: false
    };
    const E = {};      // DOM references

    function stateProgram() {
        const st = MRI.state;
        if (!st) return null;
        if (st.program && st.program.ok) return st.program;
        return st.lastGoodProgram || null;
    }
    function displayed() { return S.preview || S.shown; }
    function failing() { return !!(MRI.state && MRI.state.program && MRI.state.program.ok === false); }
    function firstReal(p) {
        if (!p || !p.periods || !p.periods.length) return 0;
        const i = p.periods.findIndex(function (q) { return !q.dummy; });
        return i < 0 ? 0 : i;
    }
    function periodsOf(p) { return p && p.periods && p.periods.length ? p.periods : [{ t0: 0, dur: p ? p.duration : 0, index: 0, vars: {}, dummy: false }]; }

    /* ---------- the concept card ---------- */
    function conceptCard() {
        return W.concept({
            title: 'A pulse sequence is a score for three instruments',
            body: '<p>The RF transmitter, the three gradient amplifiers and the receiver (ADC) play from one time line. ' +
                'Each gradient winds a phase pattern across the object, and the winding accumulated since the excitation is the position in ' +
                '<em>k-space</em>; every ADC sample records the signal at one k. The spacing of the samples sets the field of view and ' +
                'how far out they reach sets the resolution.</p>' +
                '<p><strong>TE</strong> runs from the centre of the excitation pulse to the echo, the moment the readout crosses k&nbsp;=&nbsp;0. ' +
                '<strong>TR</strong> is the time from one excitation to the next.</p>',
            formula: 'k(t) = γ̄ ∫<sub>0</sub><sup>t</sup> G(t′) dt′ &nbsp;&nbsp;·&nbsp;&nbsp; FOV = 1/Δk &nbsp;&nbsp;·&nbsp;&nbsp; Δx = 1/(2 k<sub>max</sub>)' +
                '<div class="note mt-1" style="font-family: var(--font-sans); font-size: 0.8rem">γ̄ = 42.58 MHz/T for protons. k is in cycles per metre; a 10 mT/m gradient held for 1 ms moves it by 0.43 cycles/mm.</div>',
            tryThis: [
                { html: 'Change <strong>TE</strong> with its slider and watch the readout and its echo move in the timing diagram.' },
                { html: 'Swap <code>gx</code> and <code>gy</code>: the readout then runs along y and the phase-encode direction becomes x.', label: 'Swap gx and gy', run: swapAxes },
                { html: 'Add <code>step 2</code> to the loop: only every other line is recorded, Δk doubles and the FOV along the phase direction halves (the Image tab shows the fold, or SENSE unfolding it).', label: 'Add step 2', run: addStep2 },
                { html: 'Break the timing on purpose (a TE too short for the readout) and read the error: it names the minimum.', label: 'Break it', run: breakTiming }
            ]
        });
    }

    /* ---------- source edits from tools (concept buttons, reset) ---------- */
    function applySource(newSrc, message, kind) {
        flushTyping();
        const prev = MRI.state.source;
        if (newSrc === prev) return;
        MRI.actions.setSource(newSrc);
        const undo = el('button', { type: 'button', class: 'linklike', style: { marginLeft: '8px', color: '#93c5fd' },
            onclick: function () { flushTyping(); MRI.actions.setSource(prev); if (t && t.dismiss) t.dismiss(); } }, 'Undo');
        const t = toast(el('span', {}, [message, undo]), kind || 'info', { timeout: 6000 });
    }
    function swapAxes() {
        flushTyping();                      // include what was typed in the last 400 ms
        const src = MRI.state.source;
        let toks;
        try { toks = MRI.dsl.tokenize(src); } catch (e) { return; }
        let out = '', pos = 0, n = 0;
        toks.forEach(function (t) {
            if (t.type === 'keyword' && (t.text === 'gx' || t.text === 'gy')) {
                out += src.slice(pos, t.start) + (t.text === 'gx' ? 'gy' : 'gx');
                pos = t.end; n++;
            }
        });
        out += src.slice(pos);
        if (!n) { toast('This sequence has no gx or gy events to swap.', 'warn'); return; }
        applySource(out, 'Swapped gx and gy (' + n + ' places).');
    }
    function addStep2() {
        flushTyping();
        const src = MRI.state.source;
        let toks;
        try { toks = MRI.dsl.tokenize(src); } catch (e) { return; }
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            if (t.type !== 'keyword' || t.text !== 'for') continue;
            if (i > 0 && toks[i - 1].type !== 'newline') continue;          // the loop keyword starts a statement
            let every = null, step = false;
            for (let j = i + 1; j < toks.length && toks[j].type !== 'newline'; j++) {
                if (toks[j].type === 'keyword' && toks[j].text === 'every') every = toks[j];
                if (toks[j].type === 'keyword' && toks[j].text === 'step') step = true;
            }
            if (!every) continue;
            if (step) { toast('The loop on line ' + t.line + ' already has a step. Edit it in the source.', 'warn'); return; }
            applySource(src.slice(0, every.start) + 'step 2 ' + src.slice(every.start), 'Added "step 2" to the loop on line ' + t.line + '.');
            return;
        }
        toast('This sequence has no "for ... every" loop to add a step to.', 'warn');
    }
    function breakTiming() {
        flushTyping();
        const p = MRI.state.program && MRI.state.program.params && MRI.state.program.params.length ? MRI.state.program : MRI.state.lastGoodProgram;
        const has = function (n) { return !!(p && p.params && p.params.some(function (q) { return q.name === n; })); };
        const before = MRI.state.source;
        let what = null;
        if (has('TE')) { MRI.actions.setParam('TE', 0.001); what = 'TE = 1 ms'; }
        else if (has('ESP')) { MRI.actions.setParam('ESP', 0.002); what = 'ESP = 2 ms'; }
        else if (has('TR')) { MRI.actions.setParam('TR', 0.001); what = 'TR = 1 ms'; }
        if (!what) { toast('This sequence has no TE, ESP or TR parameter to shorten.', 'warn'); return; }
        const undo = el('button', { type: 'button', class: 'linklike', style: { marginLeft: '8px', color: '#93c5fd' },
            onclick: function () { flushTyping(); MRI.actions.setSource(before); } }, 'Undo');
        toast(el('span', {}, ['Set ' + what + '. Read the error under the editor.', undo]), 'warn', { timeout: 6000 });
        if (E.msgs && E.msgs.firstChild) {
            try { E.msgs.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* old browsers */ }
        }
    }

    /* ============================================================
       Editor
       ============================================================ */
    function lineHeight() {
        const v = parseFloat(root.getComputedStyle(E.ta).lineHeight);
        return isFinite(v) && v > 0 ? v : 20;
    }
    function syncScroll() {
        const x = E.ta.scrollLeft, y = E.ta.scrollTop;
        E.hl.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
        E.gutterIn.style.transform = 'translateY(' + (-y) + 'px)';
    }
    let gutterCount = -1, gutterErrKey = '';
    function renderHighlight() {
        const errs = currentErrors();
        const h = highlight(E.ta.value, errs, S.flashLine);
        E.hl.innerHTML = h.html;
        const errKey = Array.from(h.errLines).join(',');
        if (h.nLines !== gutterCount || errKey !== gutterErrKey) {
            gutterCount = h.nLines; gutterErrKey = errKey;
            let g = '';
            for (let i = 1; i <= h.nLines; i++) g += '<span' + (h.errLines.has(i) ? ' class="is-err"' : '') + '>' + i + '</span>';
            E.gutterIn.innerHTML = g;
        }
        syncScroll();
    }
    /* Errors of the source shown in the editor. While the student is still
       typing they belong to the previous compile, which is fine: they
       update 400 ms after the pause. */
    function currentErrors() {
        const st = MRI.state;
        return st && st.program && st.program.ok === false ? (st.program.errors || []) : [];
    }
    function flushTyping() {
        if (S.typing) { clearTimeout(S.typing); S.typing = null; }
        if (E.ta && E.ta.value !== MRI.state.source) {
            MRI.actions.setSource(E.ta.value);
        }
    }
    function onTyping() {
        renderHighlight();
        setEdState('typing');
        if (S.typing) clearTimeout(S.typing);
        S.typing = setTimeout(function () {
            S.typing = null;
            if (E.ta.value !== MRI.state.source) MRI.actions.setSource(E.ta.value);
            else setEdState();
        }, 400);
    }
    function setEdState(mode) {
        if (!E.edState) return;
        const st = MRI.state;
        let text, kind;
        if (mode === 'typing') { text = 'Editing: compiles after a pause'; kind = 'muted'; }
        else if (st.program && st.program.ok) {
            const w = (st.program.warnings || []).length;
            text = w ? 'Compiled, ' + w + (w === 1 ? ' warning' : ' warnings') : 'Compiled';
            kind = w ? 'warn' : 'good';
        } else {
            const n = (st.program && st.program.errors ? st.program.errors.length : 0) || 1;
            text = n === 1 ? '1 error' : n + ' errors'; kind = 'bad';
        }
        E.edState.className = 'badge badge-' + kind;
        E.edState.textContent = text;
    }
    /* Adopt state.source (it changed elsewhere: a preset, a slider, a lesson). */
    function syncEditorFromState() {
        const src = MRI.state.source || '';
        if (E.ta.value !== src) {
            if (S.typing) { clearTimeout(S.typing); S.typing = null; }
            const a = E.ta.selectionStart, b = E.ta.selectionEnd, top = E.ta.scrollTop, left = E.ta.scrollLeft;
            const focused = doc.activeElement === E.ta;
            E.ta.value = src;
            if (focused) { try { E.ta.setSelectionRange(Math.min(a, src.length), Math.min(b, src.length)); } catch (e) { /* ignore */ } }
            E.ta.scrollTop = top; E.ta.scrollLeft = left;
        }
        renderHighlight();
        setEdState();
    }
    function gotoLine(line, col) {
        const lines = E.ta.value.split('\n');
        line = U.clamp(line | 0, 1, lines.length);
        let pos = 0;
        for (let i = 0; i < line - 1; i++) pos += lines[i].length + 1;
        pos += U.clamp((col || 1) - 1, 0, lines[line - 1].length);
        try { E.ta.focus({ preventScroll: true }); } catch (e) { E.ta.focus(); }
        E.ta.setSelectionRange(pos, pos);
        revealLine(line);
        try { E.editor.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    }
    function revealLine(line) {
        const lh = lineHeight(), top = (line - 1) * lh, h = E.ta.clientHeight;
        if (top < E.ta.scrollTop + lh || top > E.ta.scrollTop + h - 2 * lh) E.ta.scrollTop = Math.max(0, top - h / 3);
        syncScroll();
    }
    function flash(line) {
        if (!line) return;
        S.flashLine = line;
        if (S.flashTimer) clearTimeout(S.flashTimer);
        S.flashTimer = setTimeout(function () { S.flashLine = 0; S.flashTimer = null; if (S.visible) renderHighlight(); }, 1600);
        if (S.visible) { renderHighlight(); revealLine(line); }
    }
    /* Tab inserts four spaces (Shift+Tab removes them); Escape then Tab
       leaves the editor, so keyboard users are never trapped. */
    function onEditorKey(ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            flushTyping();
            const st = MRI.state;
            if (st.program && st.program.ok) MRI.actions.runScan({ animate: true });
            else toast('The sequence does not compile yet: fix the error shown under the editor first.', 'bad');
            return;
        }
        if (ev.key === 'Escape') { S.escTab = true; return; }
        if (ev.key !== 'Tab') { S.escTab = false; return; }
        if (S.escTab || ev.ctrlKey || ev.altKey || ev.metaKey) { S.escTab = false; return; }
        ev.preventDefault();
        const ta = E.ta, v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        const multi = v.slice(a, b).indexOf('\n') >= 0;
        if (!multi && !ev.shiftKey) { insertText('    '); return; }
        let le = v.indexOf('\n', b - (b > a && v[b - 1] === '\n' ? 1 : 0));
        if (le < 0) le = v.length;
        const block = v.slice(ls, le).split('\n');
        const changed = block.map(function (l) { return ev.shiftKey ? l.replace(/^ {1,4}|^\t/, '') : '    ' + l; }).join('\n');
        ta.setSelectionRange(ls, le);
        insertText(changed);
        ta.setSelectionRange(ls, ls + changed.length);
    }
    function insertText(text) {
        const ta = E.ta;
        let ok = false;
        try { ok = doc.execCommand && doc.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
            const a = ta.selectionStart, b = ta.selectionEnd;
            ta.setRangeText(text, a, b, 'end');
            onTyping();
        }
    }
    function copySource() {
        const text = E.ta.value;
        const done = function () { toast('Copied the sequence to the clipboard.', 'good'); };
        const fallback = function () {
            const a = E.ta.selectionStart, b = E.ta.selectionEnd;
            E.ta.focus(); E.ta.select();
            let ok = false;
            try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
            E.ta.setSelectionRange(a, b);
            if (ok) done(); else toast('Copying is blocked here: select the text and press ' + (isMac() ? 'Cmd' : 'Ctrl') + '+C.', 'warn');
        };
        if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
            root.navigator.clipboard.writeText(text).then(done, fallback);
        } else fallback();
    }

    function renderMessages() {
        const st = MRI.state;
        E.msgs.textContent = '';
        const add = function (m, warn) {
            const where = m.line ? 'Line ' + m.line + (m.col ? ', col ' + m.col : '') : '';
            const b = el('button', { type: 'button', class: 'seq-msg' + (warn ? ' is-warn' : ''),
                title: m.line ? 'Go to line ' + m.line : null,
                onclick: function () { if (m.line) gotoLine(m.line, m.col); } }, [
                where ? el('span', { class: 'seq-msg-where', text: where }) : null,
                el('span', { text: m.msg || String(m) }),
                m.hint ? el('span', { class: 'seq-msg-hint', text: m.hint }) : null
            ]);
            E.msgs.appendChild(el('li', {}, [b]));
        };
        if (st.program && st.program.ok === false) (st.program.errors || []).forEach(function (m) { add(m, false); });
        else if (st.program && st.program.warnings) st.program.warnings.forEach(function (m) { add(m, true); });
        // "showing the last good program" note
        const stale = failing() && !!st.lastGoodProgram;
        E.stale.hidden = !stale;
        if (stale) {
            E.stale.innerHTML = '<strong>This version does not compile.</strong> The diagrams below still show the last version that did' +
                (st.lastGoodProgram.name ? ' ("' + esc(st.lastGoodProgram.name) + '")' : '') + '. Fix the error to scan again: the scanner only runs a sequence that compiles.';
        }
        if (E.staleBadge) E.staleBadge.hidden = !stale;
    }

    function renderPresetPicker() {
        const st = MRI.state;
        const list = imagingPresets();
        const known = list.some(function (p) { return p.id === st.presetId; });
        const opts = list.map(function (p) { return { value: p.id, label: p.name }; });
        if (!known) opts.unshift({ value: '__custom', label: 'Custom sequence' });
        E.preset.setOptions(opts, known ? st.presetId : '__custom');
        const pr = getPreset(st.presetId);
        E.summary.textContent = known && pr ? pr.summary : 'A sequence that is not one of the presets.';
        const edited = known && pr && st.source !== pr.source;
        E.edited.hidden = !edited;
        E.btnReset.disabled = !known || !edited;
    }

    /* ============================================================
       Parameters
       ============================================================ */
    function paramsOf() {
        const st = MRI.state;
        if (st.program && st.program.params && st.program.params.length) return st.program.params;
        return st.lastGoodProgram && st.lastGoodProgram.params ? st.lastGoodProgram.params : [];
    }
    function hasRange(p) { return p.min !== null && p.min !== undefined && p.max !== null && p.max !== undefined && isFinite(p.min) && isFinite(p.max) && p.max > p.min; }
    function stepFor(p) {
        if (p.step > 0) return p.step;
        const sc = p.scale || 1;
        const lo = p.min / sc, hi = p.max / sc, v = p.value / sc;
        if (p.kind === 'none' && Number.isInteger(lo) && Number.isInteger(hi) && Number.isInteger(v)) return 1;
        let s = niceStep((hi - lo) / 300);
        if (hi - lo >= 30 && s < 1) s = 1;
        return s * sc;
    }
    function keyOf(params) {
        return params.map(function (p) { return [p.name, p.unit, p.kind, p.min, p.max, p.step].join('|'); }).join(';');
    }
    function buildParams() {
        const params = paramsOf();
        const key = keyOf(params);
        if (key === S.paramsKey) { updateParamValues(params); return; }
        S.paramsKey = key;
        S.paramRows = {};
        E.params.textContent = '';
        if (!params.length) {
            E.params.appendChild(el('p', { class: 'note', text: 'This sequence declares no param lines. Add one, for example: param TE = 20 ms range 5 ms .. 80 ms "echo time"' }));
            return;
        }
        params.forEach(function (p) {
            const desc = p.description || '';
            let row;
            if (hasRange(p)) {
                row = W.slider({
                    label: p.name, min: p.min, max: p.max, step: stepFor(p), value: p.value,
                    unit: p.unit || '', siPerUnit: p.scale || 1, hint: desc,
                    onInput: function (v) { previewParam(p.name, v); },
                    onChange: function (v) { commitParam(p.name, v); }
                });
                row.input.addEventListener('pointerdown', function () { S.activeParam = p.name; });
                const lab = row.querySelector('.ctl-label');
                if (lab) {
                    lab.textContent = '';
                    lab.appendChild(el('span', { class: 'seq-pname', text: p.name }));
                    if (desc) { lab.appendChild(doc.createTextNode(' ')); lab.appendChild(el('span', { class: 'seq-pdesc', text: desc })); }
                    lab.title = p.name + (desc ? ': ' + desc : '') + (p.unit ? ' (' + p.unit + ')' : '');
                }
            } else {
                const id = 'seq-num-' + p.name;
                const input = el('input', { type: 'number', step: 'any', id: id, class: 'input', 'aria-label': p.name + (p.unit ? ' in ' + p.unit : '') });
                input.value = String(Number((p.value / (p.scale || 1)).toPrecision(6)));
                input.addEventListener('change', function () {
                    const d = parseFloat(input.value);
                    if (isFinite(d)) commitParam(p.name, d * (p.scale || 1));
                });
                row = el('div', { class: 'ctl seq-numrow' }, [
                    el('label', { class: 'ctl-label', for: id, title: desc || null }, [el('span', { class: 'seq-pname', text: p.name }), desc ? ' ' : null, desc ? el('span', { class: 'seq-pdesc', text: desc }) : null]),
                    el('span', {}, [input, p.unit ? el('span', { class: 'ctl-unit', text: p.unit }) : null])
                ]);
                row.numInput = input;
            }
            row.dataset.param = p.name;
            markRange(row, p);
            S.paramRows[p.name] = row;
            E.params.appendChild(row);
        });
    }
    function updateParamValues(params) {
        params.forEach(function (p) {
            const row = S.paramRows[p.name];
            if (!row || S.activeParam === p.name) return;
            if (row.set) row.set(p.value);
            else if (row.numInput && doc.activeElement !== row.numInput) row.numInput.value = String(Number((p.value / (p.scale || 1)).toPrecision(6)));
            markRange(row, p);
        });
    }
    /* A slider cannot show a value outside its range (it clamps), so say
       when the source holds one, for example after "Break it". */
    function markRange(row, p) {
        const out = hasRange(p) && (p.value < p.min - 1e-12 || p.value > p.max + 1e-12);
        row.classList.toggle('is-bad', out);
        const val = MRI.dsl && MRI.dsl.formatParam ? MRI.dsl.formatParam(p) : String(p.value);
        row.title = out ? 'The source sets ' + p.name + ' = ' + val + ', outside this slider\'s range' : '';
    }
    // pointer released anywhere: the drag is over
    function endDrag() { S.activeParam = null; }

    /* Live preview while dragging: recompile with an override (not
       touching the source), at most once per frame, slower if compiling
       is slow, so the page never stalls. */
    let previewTimer = null, previewCost = 0;
    function previewParam(name, v) {
        S.overrides[name] = v;
        if (previewTimer) return;
        const delay = Math.max(16, Math.min(300, previewCost * 1.5));
        previewTimer = setTimeout(function () {
            previewTimer = null;
            if (!Object.keys(S.overrides).length || !MRI.dsl) return;
            const t0 = root.performance ? root.performance.now() : Date.now();
            let prog = null;
            try { prog = MRI.dsl.compile(MRI.state.source, { overrides: Object.assign({}, S.overrides) }); } catch (e) { prog = null; }
            previewCost = (root.performance ? root.performance.now() : Date.now()) - t0;
            const row = S.paramRows[name];
            if (prog && prog.ok) {
                if (row) { row.classList.remove('is-bad'); row.title = ''; }
                S.preview = prog;
                programChanged(false);
            } else if (row) {
                row.classList.add('is-bad');
                row.title = prog && prog.errors && prog.errors[0] ? prog.errors[0].msg : '';
            }
        }, delay);
    }
    function commitParam(name, v) {
        S.activeParam = null;
        S.overrides = {};
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        S.preview = null;
        flushTyping();
        const p = paramsOf().find(function (q) { return q.name === name; });
        MRI.actions.setParam(name, v);
        if (p) flash(p.line);
    }

    /* ============================================================
       Timing diagram and period selector
       ============================================================ */
    function periodLabel(p, i) {
        const pers = periodsOf(p);
        const per = pers[U.clamp(i | 0, 0, pers.length - 1)];
        const hasEvery = !!(p && p.stats && p.stats.TR > 0);
        if (!hasEvery) return { text: 'Whole sequence (no every loop)', dummy: false, vars: '' };
        const real = pers.filter(function (q) { return !q.dummy; }).length;
        const nd = pers.length - real;
        let text;
        if (per.dummy) {
            let k = 0;
            for (let j = 0; j <= i; j++) if (pers[j].dummy) k++;
            text = 'Dummy ' + k + ' of ' + nd + ' (ADC off)';
        } else {
            let k = 0;
            for (let j = 0; j <= i; j++) if (!pers[j].dummy) k++;
            text = 'TR ' + k + ' of ' + real;
        }
        const vars = per.vars ? Object.keys(per.vars).map(function (k) { return k + ' = ' + per.vars[k]; }).join(', ') : '';
        return { text: text, dummy: !!per.dummy, vars: vars };
    }
    function renderPeriodBar() {
        const p = displayed();
        const pers = periodsOf(p);
        const n = pers.length;
        E.pRange.max = String(Math.max(0, n - 1));
        E.pRange.value = String(S.period);
        E.pRange.style.setProperty('--fill', (n > 1 ? 100 * S.period / (n - 1) : 0).toFixed(1) + '%');
        const lab = periodLabel(p, S.period);
        E.pLabel.textContent = lab.text;
        E.pRange.setAttribute('aria-valuetext', lab.text + (lab.vars ? ', ' + lab.vars : ''));
        E.pVars.textContent = lab.vars;
        E.pDummy.hidden = !lab.dummy;
        E.pCentre.hidden = !p || lab.dummy || !(p.stats && p.stats.TR > 0) || centrePeriod(p) !== S.period;
        const single = n <= 1;
        E.pRange.disabled = single; E.pPrev.disabled = single || S.period <= 0; E.pNext.disabled = single || S.period >= n - 1;
    }
    function defaultCursor(p, i) {
        const T = MRI.ui.timing;
        const e = T.periodEcho(p, i);
        if (e.tEcho !== null) return e.tEcho;
        const per = periodsOf(p)[i];
        const a = (p.adc || []).find(function (q) { return q.t0 >= per.t0 && q.t0 < per.t0 + per.dur; });
        if (a) return a.t0 + a.n * a.dwell * 0.25;
        return per.t0 + per.dur * 0.1;
    }
    function setPeriod(i, keepCursor) {
        const p = displayed();
        if (!p) return;
        const pers = periodsOf(p);
        i = U.clamp(Math.round(+i) || 0, 0, pers.length - 1);
        const old = pers[S.period] || pers[0];
        if (keepCursor !== false && S.cursor !== null && i !== S.period) S.cursor = pers[i].t0 + (S.cursor - old.t0);
        S.period = i;
        if (S.timing) { S.timing.setPeriod(i); S.timing.setCursor(S.cursor); }
        renderPeriodBar();
        S.dirty.k = true; S.dirty.phase = true;
        scheduleFrame();
    }

    /* ============================================================
       k-space trajectory plot
       ============================================================ */
    function kGeometry(w) {
        const pad = { l: 46, r: 10, t: 10, b: 38 };
        const side = Math.max(120, Math.min(w - pad.l - pad.r, 440));
        return { pad: pad, side: side, w: w, h: side + pad.t + pad.b, x0: pad.l + Math.max(0, (w - pad.l - pad.r - side) / 2) };
    }
    let colorCache = null;          // theme colours, re-read on theme:changed (not on every playback frame)
    function colors() {
        if (colorCache) return colorCache;
        const v = U.cssVar;
        return colorCache = {
            fg: v('--fg', '#161b22'), muted: v('--muted', '#586170'), faint: v('--faint', '#8a93a2'), grid: v('--grid', '#e8ebf0'),
            axis: v('--axis', '#a9b1bd'), card: v('--card', '#fff'), accent: v('--accent', '#2563eb'), rf: v('--seq-rf', '#d9541e'),
            adc: v('--seq-adc', '#b7791f'), bad: v('--bad', '#b91c1c'), sans: v('--font-sans', 'sans-serif'),
            scopeBg: v('--scope-bg', '#0b0f17'), scopeFg: v('--scope-fg', '#d6dde8'), scopeMuted: v('--scope-muted', '#8794a8')
        };
    }
    function arrowHead(ctx, x, y, ang, size) {
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * size, y + Math.sin(ang) * size);
        ctx.lineTo(x + Math.cos(ang + 2.5) * size, y + Math.sin(ang + 2.5) * size);
        ctx.lineTo(x + Math.cos(ang - 2.5) * size, y + Math.sin(ang - 2.5) * size);
        ctx.closePath();
        ctx.fill();
    }
    function drawKStatic() {
        const p = displayed();
        const box = E.kWrap;
        const w = Math.floor(box.clientWidth);
        if (!w || !p) return null;
        const G = kGeometry(w);
        const C = colors();
        const dpr = root.devicePixelRatio || 1;
        const off = S.kStatic && S.kStatic.canvas ? S.kStatic.canvas : doc.createElement('canvas');
        off.width = Math.round(G.w * dpr); off.height = Math.round(G.h * dpr);
        const ctx = off.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, G.w, G.h);
        const img = p.image || {};
        const ex = (img.nx || 128) / (2 * (img.fovX || 0.24)), ey = (img.ny || 128) / (2 * (img.fovY || 0.24));
        const tr = trajectory(p, S.period);
        const all = allReadouts(p);
        let R = Math.max(ex, ey) * 1.18;
        R = Math.max(R, Math.min(4 * Math.max(ex, ey), Math.max(tr.maxK, all.maxK) * 1.08));
        const sc = G.side / (2 * R);
        const cx = G.x0 + G.side / 2, cy = G.pad.t + G.side / 2;
        // Section 3 convention: ky increases downward on screen, as image rows (and k-space grid rows) do.
        const X = function (k) { return cx + k * sc; }, Y = function (k) { return cy + k * sc; };
        // frame, grid and ticks (1/mm)
        ctx.fillStyle = C.card;
        ctx.fillRect(G.x0, G.pad.t, G.side, G.side);
        const step = niceStep((2 * R / 1e3) / 6) * 1e3;
        ctx.font = '10.5px ' + C.sans;
        ctx.lineWidth = 1;
        const dec = Math.max(0, -Math.floor(Math.log10(step / 1e3) + 1e-9));
        for (let k = Math.ceil(-R / step) * step; k <= R + 1e-9; k += step) {
            const xx = Math.round(X(k)) + 0.5, yy = Math.round(Y(k)) + 0.5;
            ctx.strokeStyle = Math.abs(k) < step * 1e-6 ? C.axis : C.grid;
            ctx.beginPath(); ctx.moveTo(xx, G.pad.t); ctx.lineTo(xx, G.pad.t + G.side); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(G.x0, yy); ctx.lineTo(G.x0 + G.side, yy); ctx.stroke();
            const lab = Math.abs(k) < step * 1e-6 ? '0' : (k / 1e3).toFixed(dec);
            ctx.fillStyle = C.muted;
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(lab, xx, G.pad.t + G.side + 4);
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(lab, G.x0 - 5, yy);
        }
        ctx.strokeStyle = C.axis;
        ctx.strokeRect(G.x0 + 0.5, G.pad.t + 0.5, G.side - 1, G.side - 1);
        ctx.fillStyle = C.muted;
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText('kx (1/mm)', G.x0 + G.side / 2, G.h - 4);
        ctx.save();
        ctx.translate(11, G.pad.t + G.side / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('ky (1/mm)', 0, 0);
        ctx.restore();

        ctx.save();
        ctx.beginPath(); ctx.rect(G.x0, G.pad.t, G.side, G.side); ctx.clip();
        // the k-space extent of the image, +-1/(2 dx)
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = C.muted;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(X(-ex), Y(-ey), 2 * ex * sc, 2 * ey * sc);
        ctx.setLineDash([]);
        // every other readout, faintly
        ctx.strokeStyle = C.adc;
        ctx.globalAlpha = all.n > 64 ? 0.15 : 0.3;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < all.n; i++) {
            const l = all.lines;
            ctx.moveTo(X(l[4 * i]), Y(l[4 * i + 1]));
            ctx.lineTo(X(l[4 * i + 2]) + (l[4 * i] === l[4 * i + 2] && l[4 * i + 1] === l[4 * i + 3] ? 1 : 0), Y(l[4 * i + 3]));
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        // refocusing jumps: k -> -k
        ctx.strokeStyle = C.rf;
        ctx.fillStyle = C.rf;
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1.2;
        tr.jumps.forEach(function (j, n) {
            ctx.beginPath(); ctx.moveTo(X(j.from[0]), Y(j.from[1])); ctx.lineTo(X(j.to[0]), Y(j.to[1])); ctx.stroke();
            if (n === 0 && Math.hypot(j.from[0] - j.to[0], j.from[1] - j.to[1]) * sc > 40) {
                ctx.setLineDash([]);
                ctx.font = '600 10.5px ' + C.sans;
                ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
                const lab = '180°: k → −k', tw = ctx.measureText(lab).width;
                // a third of the way from the start of the jump, kept inside the plot
                const mx = U.clamp(X(j.from[0]) * 0.67 + X(j.to[0]) * 0.33 + 6, G.x0 + 4, G.x0 + G.side - tw - 4);
                const my = U.clamp(Y(j.from[1]) * 0.67 + Y(j.to[1]) * 0.33 - 3, G.pad.t + 14, G.pad.t + G.side - 4);
                ctx.lineWidth = 3; ctx.strokeStyle = C.card;
                ctx.strokeText(lab, mx, my);
                ctx.fillText(lab, mx, my);
                ctx.strokeStyle = C.rf; ctx.lineWidth = 1.2;
                ctx.setLineDash([2, 3]);
            }
        });
        ctx.setLineDash([]);
        // the trajectory of this repetition, with arrows where the ADC is off
        const inAdc = function (t) { return tr.adcs.some(function (a) { return t > a.t0 + 1e-9 && t < a.t1 - 1e-9; }); };
        const arrows = [];          // candidate arrows on the stretches where the ADC is off: {x, y, ang, len}
        tr.pieces.forEach(function (pc) {
            ctx.strokeStyle = pc.kind === 'spoil' ? C.faint : C.fg;
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = pc.kind === 'spoil' ? 1 : 1.5;
            if (pc.kind === 'spoil') ctx.setLineDash([4, 3]);
            ctx.beginPath();
            pc.pts.forEach(function (q, i) { if (i) ctx.lineTo(X(q[0]), Y(q[1])); else ctx.moveTo(X(q[0]), Y(q[1])); });
            ctx.stroke();
            ctx.setLineDash([]);
            if (pc.kind === 'spoil') return;
            // one arrow in the middle of each stretch outside the ADC
            let run = [];
            const flush = function () {
                if (run.length > 1) {
                    let len = 0;
                    for (let i = 1; i < run.length; i++) len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
                    if (len > Math.max(30, G.side * 0.15)) {
                        let acc = 0;
                        for (let i = 1; i < run.length; i++) {
                            const d = Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
                            if (acc + d >= len / 2 && d > 0) {
                                const f = (len / 2 - acc) / d;
                                arrows.push({ x: run[i - 1][0] + f * (run[i][0] - run[i - 1][0]), y: run[i - 1][1] + f * (run[i][1] - run[i - 1][1]),
                                    ang: Math.atan2(run[i][1] - run[i - 1][1], run[i][0] - run[i - 1][0]), len: len });
                                break;
                            }
                            acc += d;
                        }
                    }
                }
                run = [];
            };
            pc.pts.forEach(function (q) {
                if (inAdc(q[2])) { flush(); return; }
                run.push([X(q[0]), Y(q[1])]);
            });
            flush();
        });
        // the longest stretches get an arrow (at most 14, so an EPI train stays readable)
        ctx.fillStyle = C.fg;
        arrows.sort(function (a, b) { return b.len - a.len; }).slice(0, 14).forEach(function (a) { arrowHead(ctx, a.x, a.y, a.ang, 5); });
        // ADC portions of this repetition, emphasised, with their direction;
        // thinner lines and fewer arrows when a repetition has many readouts
        const nA = tr.adcs.length, every = nA > 16 ? Math.ceil(nA / 10) : 1;
        tr.adcs.forEach(function (a, ai) {
            ctx.strokeStyle = C.adc;
            ctx.fillStyle = C.adc;
            ctx.lineWidth = a.dummy ? 1.5 : (nA > 16 ? 1.6 : 3);
            if (a.dummy) ctx.setLineDash([4, 3]);
            ctx.beginPath();
            a.pts.forEach(function (q, i) { if (i) ctx.lineTo(X(q[0]), Y(q[1])); else ctx.moveTo(X(q[0]), Y(q[1])); });
            ctx.stroke();
            ctx.setLineDash([]);
            const n = a.pts.length;
            if (n >= 2) {
                const m = Math.floor(n / 2), q0 = a.pts[Math.max(0, m - 1)], q1 = a.pts[Math.min(n - 1, m + 1)];
                const dx = X(q1[0]) - X(q0[0]), dy = Y(q1[1]) - Y(q0[1]);
                if (ai % every === 0 && Math.hypot(dx, dy) > 0.5 && Math.hypot(X(a.pts[n - 1][0]) - X(a.pts[0][0]), Y(a.pts[n - 1][1]) - Y(a.pts[0][1])) > 14) {
                    ctx.fillStyle = C.fg;
                    arrowHead(ctx, X(a.pts[m][0]), Y(a.pts[m][1]), Math.atan2(dy, dx), 5.5);
                }
            }
        });
        // where the excitation leaves k: the origin
        if (tr.tStart !== null) {
            ctx.fillStyle = C.fg;
            ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI); ctx.fill();
        }
        ctx.restore();
        S.kStatic = { canvas: off, G: G, X: X, Y: Y, sc: sc, w: G.w, h: G.h, prog: p, period: S.period, R: R, ex: ex, ey: ey };
        return S.kStatic;
    }
    function drawK() {
        const p = displayed();
        if (!p || !E.kCanvas) return;
        if (!S.kStatic || S.kStatic.prog !== p || S.kStatic.period !== S.period || S.kStatic.w !== Math.floor(E.kWrap.clientWidth) || S.kStaticDirty) {
            S.kStaticDirty = false;
            if (!drawKStatic()) return;
        }
        const K = S.kStatic;
        const r = U.setupCanvas(E.kCanvas, K.w, K.h);
        const ctx = r.ctx;
        ctx.clearRect(0, 0, K.w, K.h);
        ctx.drawImage(K.canvas, 0, 0, K.w, K.h);
        const C = colors();
        const k = S.cursor !== null ? kAt(p, S.cursor) : null;
        let text;
        if (S.cursor === null) text = 'Place the cursor on the timing diagram to see where k is.';
        else if (!k) text = 'Cursor before the excitation: no transverse magnetisation, so no k yet.';
        else if (k.spoiled) text = 'Cursor after the spoiler: the transverse magnetisation has been destroyed.';
        else {
            const x = K.X(k.kx), y = K.Y(k.ky);
            ctx.save();
            ctx.beginPath(); ctx.rect(K.G.x0, K.G.pad.t, K.G.side, K.G.side); ctx.clip();
            ctx.fillStyle = C.accent;
            ctx.strokeStyle = C.card;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
            ctx.restore();
            const mag = Math.hypot(k.kx, k.ky);
            text = '<strong>Cursor</strong>: k = (' + fmtK(k.kx) + ', ' + fmtK(k.ky) + ') /mm, |k| = ' + fmtK(mag) + ' /mm' +
                (mag < 0.05 ? ': the echo, where every spin is back in phase' : '');
            if (Math.abs(k.kx) > K.ex * 1.02 || Math.abs(k.ky) > K.ey * 1.02) text += ' (outside the image extent)';
        }
        E.kReadout.innerHTML = text;
    }

    /* ============================================================
       Spin phase across the FOV
       ============================================================ */
    let phaseImg = null;
    function drawPhase() {
        const p = displayed();
        if (!p || !E.phCanvas) return;
        const w = Math.min(Math.floor(E.phWrap.clientWidth), 440);
        if (!w) return;
        const img = p.image || {};
        const fx = img.fovX || 0.24, fy = img.fovY || 0.24;
        const h = Math.max(60, Math.round(w * fy / fx));
        const r = U.setupCanvas(E.phCanvas, w, h);
        const ctx = r.ctx;
        const C = colors();
        const k = S.cursor !== null ? kAt(p, S.cursor) : null;
        const live = k && !k.spoiled;
        const kx = live ? k.kx : 0, ky = live ? k.ky : 0;
        // Background: cos(phase) on the scope, shading the wavefronts.
        // phase(x, y) = -2 pi (kx x + ky y): separable, so only W + H trig calls.
        const bw = Math.max(1, Math.round(w)), bh = Math.max(1, Math.round(h));
        if (!phaseImg || phaseImg.width !== bw || phaseImg.height !== bh) phaseImg = ctx.createImageData(bw, bh);
        const ca = new Float64Array(bw), sa = new Float64Array(bw), cb = new Float64Array(bh), sb = new Float64Array(bh);
        for (let i = 0; i < bw; i++) { const x = ((i + 0.5) / bw - 0.5) * fx; const a = -2 * Math.PI * kx * x; ca[i] = Math.cos(a); sa[i] = Math.sin(a); }
        for (let j = 0; j < bh; j++) { const y = ((j + 0.5) / bh - 0.5) * fy; const b = -2 * Math.PI * ky * y; cb[j] = Math.cos(b); sb[j] = Math.sin(b); }
        const d = phaseImg.data;
        // dark scope blue-grey: from #0b0f17 (cos = -1) to #41557a (cos = +1)
        const c0 = [11, 15, 23], c1 = live ? [65, 85, 122] : [30, 38, 52];
        for (let j = 0; j < bh; j++) {
            for (let i = 0; i < bw; i++) {
                const c = ca[i] * cb[j] - sa[i] * sb[j];
                const t = 0.5 + 0.5 * c, o = 4 * (j * bw + i);
                d[o] = c0[0] + (c1[0] - c0[0]) * t; d[o + 1] = c0[1] + (c1[1] - c0[1]) * t; d[o + 2] = c0[2] + (c1[2] - c0[2]) * t; d[o + 3] = 255;
            }
        }
        // put at device resolution through a scratch canvas
        if (!S.phScratch) S.phScratch = doc.createElement('canvas');
        S.phScratch.width = bw; S.phScratch.height = bh;
        S.phScratch.getContext('2d').putImageData(phaseImg, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(S.phScratch, 0, 0, w, h);
        // 11 x 11 arrows across the FOV, at x = -FOV/2 .. +FOV/2
        const N = 11, cell = Math.min(w, h) / N;
        const len = cell * 0.36;
        ctx.strokeStyle = live ? '#e8edf5' : 'rgba(232, 237, 245, 0.35)';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 1.5;
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const xm = (i / (N - 1) - 0.5) * fx, ym = (j / (N - 1) - 0.5) * fy;
                const ph = -2 * Math.PI * (kx * xm + ky * ym);
                const px = (i + 0.5) * w / N, py = (j + 0.5) * h / N;
                // complex-plane convention: real to the right, imaginary up
                const dx = Math.cos(ph) * len, dy = -Math.sin(ph) * len;
                ctx.beginPath(); ctx.moveTo(px - dx * 0.6, py - dy * 0.6); ctx.lineTo(px + dx, py + dy); ctx.stroke();
                arrowHead(ctx, px + dx, py + dy, Math.atan2(dy, dx), 3.6);
            }
        }
        // the direction of k, as a small vector in the corner
        const kmag = Math.hypot(kx, ky);
        if (live && kmag >= 0.05) {
            const ox = w - 30, oy = 30, L = 18;
            ctx.fillStyle = 'rgba(11, 15, 23, 0.75)';
            ctx.beginPath(); ctx.arc(ox, oy, 24, 0, 2 * Math.PI); ctx.fill();
            // y runs down on the image and in the k-space plot alike, so (kx, ky) is drawn as is
            const ux = kx / kmag, uy = ky / kmag;
            ctx.strokeStyle = '#fbbf6b'; ctx.fillStyle = '#fbbf6b'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(ox - ux * L * 0.7, oy - uy * L * 0.7); ctx.lineTo(ox + ux * L, oy + uy * L); ctx.stroke();
            arrowHead(ctx, ox + ux * L, oy + uy * L, Math.atan2(uy, ux), 5);
            ctx.font = '600 10px ' + C.sans; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText('k', ox, oy + 12);
        }
        if (!live) {
            ctx.fillStyle = 'rgba(11, 15, 23, 0.72)';
            ctx.fillRect(0, h / 2 - 16, w, 32);
            ctx.fillStyle = C.scopeFg;
            ctx.font = '600 12px ' + C.sans; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(S.cursor === null ? 'No cursor' : (k ? 'Spoiled: no coherent phase left' : 'Before the excitation: nothing to wind'), w / 2, h / 2);
        }
        // readout text
        const dx = Math.min(fx / (img.nx || 128), fy / (img.ny || 128));
        let text;
        if (!live) text = k ? 'The spoiler has wound the phase so tightly across the slice that no signal is left.' : 'Move the cursor after the excitation.';
        else if (kmag < 0.05) text = '<strong>|k| = 0</strong>: every spin points the same way. This is the echo: all the signal adds up.';
        else {
            const lam = 1 / kmag;
            text = '<strong>|k| = ' + fmtK(kmag) + ' /mm</strong>, wavelength 1/|k| = <strong>' + U.fmtNum(lam * 1e3, 3) + ' mm</strong> (' +
                U.fmtNum(lam / dx, 3) + ' voxels of ' + U.fmtNum(dx * 1e3, 3) + ' mm)';
            if (lam < 2.4 * fx / w) text += '. Finer than this display can draw.';
            else if (lam < 2 * fx / (N - 1)) text += '. The 11 × 11 arrows are too sparse to follow it (they alias); the shading shows it.';
        }
        E.phReadout.innerHTML = text;
    }

    /* ============================================================
       Numbers
       ============================================================ */
    function gradientEchoTrain(p) {
        // Two or more readouts after one excitation with no refocusing pulse between them: EPI-like.
        const pers = periodsOf(p), per = pers[firstReal(p)];
        const rf = (p.rf || []).filter(function (r) { return r.t0 >= per.t0 && r.t0 < per.t0 + per.dur; });
        const adc = (p.adc || []).filter(function (a) { return a.t0 >= per.t0 && a.t0 < per.t0 + per.dur && a.anchor === 'center'; });
        for (let i = 1; i < adc.length; i++) {
            const between = rf.some(function (r) { return r.t > adc[i - 1].tc && r.t < adc[i].tc; });
            if (!between) return true;
        }
        return false;
    }
    function renderStats() {
        const p = displayed();
        if (!p) { E.stats.update([]); return; }
        const st = p.stats || {}, img = p.image || {};
        const acqOk = !!(MRI.state.acq && MRI.state.acq.program === p);
        const ast = acqOk ? (MRI.state.acq.stats || {}) : null;
        const ms = function (s) { return s === null || s === undefined || !isFinite(s) ? null : fmtMs(s, 4); };
        const rows = [];
        rows.push({ label: 'TR', value: st.TR > 0 ? ms(st.TR) : 'single shot', unit: st.TR > 0 ? 'ms' : '', hint: 'repetition time: the period of the outermost every loop' });
        rows.push({ label: 'TE (measured)', value: st.TE !== null && st.TE !== undefined ? ms(st.TE) : 'n/a', unit: st.TE !== null && st.TE !== undefined ? 'ms' : '', hint: 'excitation centre to the echo of the readout nearest k = 0' });
        if (st.TI) rows.push({ label: 'TI', value: ms(st.TI), unit: 'ms', hint: 'inversion to excitation' });
        // flip angles of the first real repetition
        const per = periodsOf(p)[firstReal(p)];
        const flips = {};
        (p.rf || []).forEach(function (r) {
            if (r.t0 < per.t0 || r.t0 >= per.t0 + per.dur) return;
            const k = Math.abs(r.flip) + '° ' + ({ excite: 'exc', refocus: 'ref', invert: 'inv', saturate: 'sat' }[r.role] || '');
            flips[k] = (flips[k] || 0) + 1;
        });
        const fl = Object.keys(flips).map(function (k) { return k + (flips[k] > 1 ? ' ×' + flips[k] : ''); }).join(', ');
        rows.push({ label: 'Flip angles', value: fl || 'none', hint: 'RF pulses in one repetition' });
        if (img.hasImaging !== false) {
            rows.push({ label: 'Matrix', value: img.nx + ' × ' + img.ny });
            rows.push({ label: 'FOV', value: U.fmtNum(img.fovX * 1e3, 4) + ' × ' + U.fmtNum(img.fovY * 1e3, 4), unit: 'mm' });
            rows.push({ label: 'Voxel', value: U.fmtNum(img.fovX / img.nx * 1e3, 3) + ' × ' + U.fmtNum(img.fovY / img.ny * 1e3, 3) + ' × ' + U.fmtNum(img.thickness * 1e3, 3), unit: 'mm', hint: 'FOV / matrix in plane, times the slice thickness' });
            rows.push({ label: 'Slice thickness', value: U.fmtNum(img.thickness * 1e3, 3), unit: 'mm' });
            rows.push({ label: 'BW / pixel', value: U.fmtNum(img.bwPerPixel, 4), unit: 'Hz/px', hint: 'receiver bandwidth per pixel along the readout; total ' + U.fmtFreq(img.bwPerPixel * img.nx * (img.oversample || 1), 3) });
        }
        if (st.readoutDuration) rows.push({ label: 'Readout duration', value: ms(st.readoutDuration), unit: 'ms', hint: 'ADC window of one readout = 1 / (BW per pixel), with oversampling included' });
        if (st.echoSpacing) rows.push({ label: 'Echo spacing', value: ms(st.echoSpacing), unit: 'ms' });
        let peBw = ast && ast.peBandwidthPerPixel ? ast.peBandwidthPerPixel : null;
        if (!peBw && st.echoSpacing && img.ny && gradientEchoTrain(p)) peBw = 1 / (img.ny * st.echoSpacing);
        if (peBw) rows.push({ label: 'Phase-encode BW / pixel', value: U.fmtNum(peBw, 3), unit: 'Hz/px', kind: 'warn', hint: '1 / (N × echo spacing): why EPI distorts near air' });
        if (ast && ast.fatShiftPx) {
            const f = ast.fatShiftPx;
            rows.push({ label: 'Fat shift', value: U.fmtNum(Math.abs(f.readout || 0), 3) + ' (read)' + (f.phase ? ', ' + U.fmtNum(Math.abs(f.phase), 3) + ' (phase)' : ''), unit: 'px', hint: 'fat (434 Hz below water at 3 T) appears this many pixels away; from the last scan' });
        } else if (img.hasImaging !== false) {
            rows.push({ label: 'Fat shift', value: 'run a scan', kind: 'muted', hint: 'measured from the last scan of this sequence' });
        }
        rows.push({ label: 'Averages', value: String(img.averages || 1) });
        rows.push({ label: 'Scan time', value: U.fmtTime(p.scanTime || 0) });
        const gm = MRI.const.GMAX, used = st.gmaxUsed || 0, frac = used / gm;
        rows.push({ label: 'Peak gradient', kind: frac > 0.95 ? 'warn' : null,
            value: { html: '<span class="seq-meter' + (frac > 0.95 ? ' is-high' : '') + '" aria-hidden="true"><span style="width:' + (100 * U.clamp(frac, 0, 1)).toFixed(0) + '%"></span></span>' +
                U.fmtNum(used * 1e3, 3) + ' of ' + U.fmtNum(gm * 1e3, 3) },
            unit: 'mT/m', hint: 'largest gradient amplitude used (spoilers often run at the limit)' });
        const nd = (p.adc || []).filter(function (a) { return a.dummy; }).length;
        rows.push({ label: 'Readouts', value: String(st.nAdc || 0) + (nd ? ' (+' + nd + ' dummy)' : ''), hint: 'ADC windows recorded' });
        E.stats.update(rows);
    }

    /* ============================================================
       Refresh logic
       ============================================================ */
    function programChanged(fromCompile) {
        const p = displayed();
        if (!p) return;
        const pers = periodsOf(p);
        const presetChanged = MRI.state.presetId !== S.presetId;
        if (fromCompile && presetChanged) {
            S.presetId = MRI.state.presetId;
            S.period = centrePeriod(p);
            S.cursor = null;
        }
        if (S.period >= pers.length) { S.period = centrePeriod(p); S.cursor = null; }
        if (S.timing) {
            const prevCursor = S.cursor;
            S.timing.setProgram(p);
            S.timing.setPeriod(S.period);
            // the component keeps the cursor's place in its repetition
            S.cursor = S.timing.getCursor();
            if (S.cursor === null || prevCursor === null) S.cursor = defaultCursor(p, S.period);
            S.timing.setCursor(S.cursor);
        }
        renderPeriodBar();
        S.dirty.k = S.dirty.phase = S.dirty.stats = true;
        scheduleFrame();
    }
    function onCompiled() {
        S.shown = stateProgram();
        if (!S.activeParam) { S.preview = null; S.overrides = {}; }
        if (!S.visible) { S.dirty.editor = S.dirty.params = S.dirty.timing = S.dirty.k = S.dirty.phase = S.dirty.stats = true; return; }
        syncEditorFromState();
        renderMessages();
        renderPresetPicker();
        buildParams();
        programChanged(true);
    }

    function scheduleFrame() {
        if (S.frame || !S.visible) return;
        S.frame = raf(function () {
            S.frame = 0;
            if (!S.visible) return;
            if (S.tick && S.playing) applyTick(S.tick);
            if (S.dirty.k || S.dirtyCursor) { S.dirty.k = false; drawK(); }
            if (S.dirty.phase || S.dirtyCursor) { S.dirty.phase = false; drawPhase(); }
            if (S.dirty.stats) { S.dirty.stats = false; renderStats(); }
            S.dirtyCursor = false;
        });
    }
    function applyTick(tick) {
        const p = displayed();
        if (!p || !MRI.state.acq || MRI.state.acq.program !== p) return;
        const pers = periodsOf(p);
        const pi = U.clamp(tick.period | 0, 0, pers.length - 1);
        if (pi !== S.period) {
            S.period = pi;
            if (S.timing) S.timing.setPeriod(pi);
            renderPeriodBar();
            S.dirty.k = true;
        }
        S.cursor = tick.t;
        if (S.timing) S.timing.setCursor(tick.t);
        S.dirtyCursor = true;
        S.tick = null;
    }

    function onShow() {
        S.visible = true;
        if (S.dirty.editor) { S.dirty.editor = false; syncEditorFromState(); renderMessages(); renderPresetPicker(); }
        if (S.dirty.params) { S.dirty.params = false; buildParams(); }
        if (S.dirty.timing) { S.dirty.timing = false; S.shown = stateProgram(); programChanged(true); }
        S.kStaticDirty = true;
        S.dirty.k = S.dirty.phase = S.dirty.stats = true;
        if (S.timing) S.timing.redraw();
        syncScroll();
        scheduleFrame();
    }
    function onHide() {
        S.visible = false;
        flushTyping();
    }

    /* ============================================================
       Mount
       ============================================================ */
    function mount(panel) {
        S.panel = panel;
        MRI.ui.addStyle(CSS);
        panel.textContent = '';
        if (!W) { panel.appendChild(el('div', { class: 'error-card', text: 'The shared widgets (js/ui/widgets.js) did not load.' })); return; }
        panel.appendChild(conceptCard());

        /* ----- editor panel ----- */
        E.preset = W.select({ label: 'Preset', inline: true, options: [], onChange: function (id) {
            if (id === '__custom') return;
            flushTyping();
            const prev = MRI.state.source, prevPreset = getPreset(MRI.state.presetId);
            const wasEdited = !prevPreset || prev !== prevPreset.source;
            MRI.actions.loadPreset(id);
            if (wasEdited && prev.trim()) {
                const undo = el('button', { type: 'button', class: 'linklike', style: { marginLeft: '8px', color: '#93c5fd' },
                    onclick: function () { flushTyping(); MRI.actions.setSource(prev); } }, 'Undo');
                toast(el('span', {}, ['Loaded "' + (getPreset(id) || {}).name + '". Your edited version was replaced.', undo]), 'info', { timeout: 7000 });
            }
        } });
        E.edited = W.badge('edited', 'accent');
        E.edited.hidden = true;
        E.edited.title = 'The source differs from the preset';
        E.btnReset = W.button({ label: 'Reset to preset', size: 'sm', title: 'Replace the source with the preset as shipped',
            onClick: function () {
                const pr = getPreset(MRI.state.presetId);
                if (pr) applySource(pr.source, 'Reset to the preset "' + pr.name + '".');
            } });
        E.btnCopy = W.button({ label: 'Copy', size: 'sm', title: 'Copy the sequence source to the clipboard', onClick: copySource });
        E.summary = el('p', { class: 'seq-summary' });

        E.gutterIn = el('div', { class: 'ed-gutter-inner' });
        E.hl = el('pre', { class: 'ed-hl', 'aria-hidden': 'true' });
        E.ta = el('textarea', { class: 'ed-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
            wrap: 'off', 'aria-label': 'Pulse sequence source', 'aria-describedby': 'seq-ed-help', 'data-gramm': 'false' });
        E.editor = el('div', { class: 'seq-editor' }, [
            el('div', { class: 'ed-gutter', 'aria-hidden': 'true' }, [E.gutterIn]),
            el('div', { class: 'ed-main' }, [E.hl, E.ta])
        ]);
        E.ta.addEventListener('input', onTyping);
        E.ta.addEventListener('scroll', syncScroll, { passive: true });
        E.ta.addEventListener('keydown', onEditorKey);
        E.ta.addEventListener('blur', function () { S.escTab = false; });

        E.edState = el('span', { class: 'badge badge-good', role: 'status', 'aria-live': 'polite' }, 'Compiled');
        const mod = isMac() ? 'Cmd' : 'Ctrl';
        const foot = el('div', { class: 'seq-edfoot' }, [
            E.edState,
            el('span', { id: 'seq-ed-help' }, [el('kbd', { text: mod + '+Enter' }), ' compile and scan · ', el('kbd', { text: 'Tab' }), ' indent · ',
                el('kbd', { text: 'Esc' }), ' then ', el('kbd', { text: 'Tab' }), ' leave the editor']),
            el('span', { class: 'spacer' })
        ]);
        E.stale = el('div', { class: 'callout callout-warn seq-stale', role: 'status', hidden: true });
        E.msgs = el('ul', { class: 'seq-msgs', 'aria-label': 'Compile errors and warnings' });
        const ref = el('details', { class: 'adv' }, [el('summary', { text: 'Language reference' }),
            el('div', { html: (MRI.dsl && MRI.dsl.reference) || '<p>The language reference is not available.</p>' })]);
        const specNote = el('p', { class: 'note mt-2 mb-0' }, ['Spectroscopy sequences (pulse-acquire FID, water suppression) live in the ',
            el('button', { type: 'button', class: 'linklike', onclick: function () { MRI.actions.showTab('spectro'); } }, 'Spectroscopy tab'), '.']);

        const edPanel = el('section', { class: 'panel', 'aria-labelledby': 'seq-ed-title' }, [
            el('div', { class: 'panel-head' }, [
                el('h2', { class: 'panel-title', id: 'seq-ed-title', text: 'Pulse sequence' }),
                el('span', { class: 'panel-sub', text: 'written in the simulator\'s sequence language' }),
                el('span', { class: 'spacer' }),
                el('span', { class: 'seq-edtools' }, [E.btnReset, E.btnCopy])
            ]),
            el('div', { class: 'seq-presetrow' }, [E.preset, E.edited]),
            E.summary,
            E.editor,
            foot,
            E.stale,
            E.msgs,
            ref,
            specNote
        ]);

        /* ----- parameters panel ----- */
        E.params = el('div', { class: 'controls stack' });
        const parPanel = el('section', { class: 'panel seq-params', 'aria-labelledby': 'seq-par-title' }, [
            el('div', { class: 'panel-head' }, [
                el('h2', { class: 'panel-title', id: 'seq-par-title', text: 'Parameters' }),
                el('span', { class: 'panel-sub', text: 'from the param lines; a change rewrites that line of the source' })
            ]),
            E.params,
            el('p', { class: 'note mt-2 mb-0', text: 'Some corners of a range do not compile on purpose (a TE too short for the readout, say): the error says what the minimum is.' })
        ]);
        root.addEventListener('pointerup', endDrag);
        root.addEventListener('pointercancel', endDrag);

        panel.appendChild(el('div', { class: 'split seq-top' }, [edPanel, parPanel]));

        /* ----- timing panel ----- */
        E.pPrev = W.button({ label: '‹ Prev', size: 'sm', title: 'Previous repetition', onClick: function () { setPeriod(S.period - 1); } });
        E.pNext = W.button({ label: 'Next ›', size: 'sm', title: 'Next repetition', onClick: function () { setPeriod(S.period + 1); } });
        E.pRange = el('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Repetition shown' });
        E.pRange.addEventListener('input', function () { setPeriod(+E.pRange.value); });
        E.pLabel = el('span', { class: 'seq-plabel' });
        E.pVars = el('span', { class: 'seq-pvars' });
        E.pDummy = W.badge('dummy: no data recorded', 'warn');
        E.pDummy.hidden = true;
        E.pCentre = W.badge('records the k-space centre', 'accent');
        E.pCentre.hidden = true;
        E.pCentre.title = 'This repetition records the readout nearest k = 0, which sets the image contrast and defines TE';
        E.staleBadge = W.badge('last version that compiled', 'warn');
        E.staleBadge.hidden = true;
        const timingHost = el('div');
        const tPanel = el('section', { class: 'panel', 'aria-labelledby': 'seq-td-title' }, [
            el('div', { class: 'panel-head' }, [
                el('h2', { class: 'panel-title', id: 'seq-td-title', text: 'Timing diagram' }),
                el('span', { class: 'panel-sub', text: 'one repetition; faint lines are the phase-encode lobes of all the others' }),
                E.staleBadge
            ]),
            el('div', { class: 'seq-periodbar' }, [E.pPrev, E.pRange, E.pNext, E.pLabel, E.pVars, E.pDummy, E.pCentre]),
            timingHost,
            el('p', { class: 'simplification mb-0', text: 'Pulse shapes are drawn as a scanner plays them, but the simulator applies each pulse as an instant rotation at its centre with an ideal slice profile. Gradient heights are compressed (weak lobes enlarged) unless True amplitudes is on; the hover box gives every exact value.' })
        ]);
        panel.appendChild(tPanel);
        if (MRI.ui.timing && MRI.ui.timing.create) {
            S.timing = MRI.ui.timing.create(timingHost, { ariaLabel: 'Pulse-sequence timing diagram' });
            S.timing.onCursor(function (t) {
                S.cursor = t;
                S.dirtyCursor = true;
                scheduleFrame();
            });
        } else {
            timingHost.appendChild(W.errorCard('The timing diagram is unavailable', { message: 'js/ui/timing.js did not load.' }));
        }

        /* ----- k-space, spin phase, numbers ----- */
        E.kWrap = el('div', { class: 'seq-figure' });
        E.kCanvas = el('canvas', { class: 'seq-canvas', role: 'img', 'aria-label': 'k-space trajectory of the repetition shown, with all other readouts faint behind it' });
        E.kWrap.appendChild(E.kCanvas);
        E.kReadout = el('div', { class: 'seq-readout', 'aria-live': 'off' });
        const kPanel = el('section', { class: 'panel', 'aria-labelledby': 'seq-k-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'seq-k-title', text: 'k-space trajectory' })]),
            E.kWrap,
            W.legend([
                { label: 'path of this repetition', color: 'var(--fg)', line: true },
                { label: 'ADC on', color: 'var(--seq-adc)' },
                { label: '180° flips k to −k', color: 'var(--seq-rf)', dash: true },
                { label: 'image extent ±1/(2Δx)', color: 'var(--muted)', dash: true }
            ]),
            E.kReadout,
            el('p', { class: 'simplification mb-0', text: 'Nominal k from the gradient areas: each excitation resets k to 0 and each refocusing pulse mirrors it (k → −k), following the single echo pathway the simulator models. ky increases downward, like image rows.' })
        ]);
        E.phWrap = el('div', { class: 'seq-figure' });
        E.phCanvas = el('canvas', { class: 'seq-canvas is-scope', role: 'img', 'aria-label': 'Phase of the transverse magnetisation across the field of view at the cursor time' });
        E.phWrap.appendChild(E.phCanvas);
        E.phReadout = el('div', { class: 'seq-readout', 'aria-live': 'off' });
        const phPanel = el('section', { class: 'panel', 'aria-labelledby': 'seq-ph-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'seq-ph-title', text: 'Spin phase across the FOV' })]),
            E.phWrap,
            E.phReadout,
            el('p', { class: 'simplification mb-0', text: 'Each arrow is the phase −2π k·r that the gradients have wound into the spins at its position, at the cursor time: a helix whose wavelength is 1/|k|. Off-resonance, relaxation and the slice direction are left out.' })
        ]);
        E.stats = W.statTable([]);
        const stPanel = el('section', { class: 'panel', 'aria-labelledby': 'seq-st-title' }, [
            el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'seq-st-title', text: 'Numbers' })]),
            E.stats
        ]);
        panel.appendChild(el('div', { class: 'grid-3' }, [kPanel, phPanel, stPanel]));

        // Redraw the two figures when their width changes (also when the tab is shown).
        if (root.ResizeObserver) {
            const ro = new root.ResizeObserver(function () {
                if (!S.visible) return;
                S.kStaticDirty = true; S.dirty.k = true; S.dirty.phase = true;
                scheduleFrame();
            });
            ro.observe(E.kWrap); ro.observe(E.phWrap);
        }

        /* ----- bus ----- */
        const bus = MRI.bus;
        bus.on('program:compiled', onCompiled);
        bus.on('scan:start', function (e) { S.playing = !!(e && e.animate); });
        bus.on('playback:tick', function (tick) {
            if (!tick) return;
            S.tick = tick;                       // bookkeeping only while hidden
            if (S.visible) scheduleFrame();
        });
        bus.on('scan:done', function () {
            S.playing = false; S.tick = null;
            S.dirty.stats = true;
            if (S.visible) scheduleFrame();
        });
        bus.on('scan:error', function () { S.playing = false; S.tick = null; });
        bus.on('theme:changed', function () {
            colorCache = null;
            S.kStaticDirty = true; S.dirty.k = true; S.dirty.phase = true;
            if (S.visible) scheduleFrame();
        });

        // Initial content from the state (program:compiled follows at boot as well).
        S.mounted = true;
        S.presetId = null;
        S.shown = stateProgram();
        E.ta.value = MRI.state.source || '';
        S.dirty.editor = S.dirty.params = S.dirty.timing = true;
    }

    MRI.ui.registerTab({ id: 'sequence', title: 'Sequence', order: 30, mount: mount, onShow: onShow, onHide: onHide });

})(typeof window !== 'undefined' ? window : globalThis);
