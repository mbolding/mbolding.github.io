/* ============================================================
   PET Simulator, Protocol tab
   Where students write the scan in the protocol language: pick a
   preset, edit the text (syntax highlighted, errors marked on their
   lines), drag the sliders that the param lines create, and see what
   the protocol means: a timeline of the activity left in the body
   with the frames on it, the numbers that matter (decay at scan
   start, decay during the scan, the windows and, after a scan, the
   counts), and how the energy and coincidence windows decide which
   photons count.

   The editor is a transparent <textarea> laid exactly over a
   highlighted <pre> (same font, size, line height and padding), with
   the highlight layer and the line-number gutter moved by transforms
   when the textarea scrolls, so they never drift apart. Edits reach
   the app through PET.actions.setSource (debounced); everything shown
   here comes back through the bus (program:compiled, scan:done ...).
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !PET.util) return;
    const U = PET.util;
    const doc = root.document;

    const LH = 20;                // editor line height, px: textarea, highlight and gutter must agree
    const PAD_Y = 10;             // editor padding, px
    const INDENT = '  ';          // what Tab inserts
    const EDIT_DEBOUNCE = 300;    // ms from the last keystroke to setSource
    const PARAM_DEBOUNCE = 70;    // ms between slider moves and setParam while dragging
    const GROUPS = [
        { id: 'brain', label: 'Brain, static' },
        { id: 'dynamic', label: 'Dynamic' },
        { id: 'phantom', label: 'Phantoms' }
    ];

    const CSS = `
#tab-protocol {
    --pr-k: #6d28d9; --pr-n: #0f766e; --pr-u: #b45309; --pr-s: #15803d; --pr-t: #be185d;
    --pr-p: #1d4ed8; --pr-c: #687385; --pr-o: #64748b; --pr-sel: rgba(37, 99, 235, 0.22);
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) #tab-protocol {
        --pr-k: #c4b5fd; --pr-n: #5eead4; --pr-u: #fcd34d; --pr-s: #86efac; --pr-t: #f9a8d4;
        --pr-p: #93c5fd; --pr-c: #8b98ad; --pr-o: #9aa8bc; --pr-sel: rgba(96, 165, 250, 0.30);
    }
}
:root[data-theme="dark"] #tab-protocol {
    --pr-k: #c4b5fd; --pr-n: #5eead4; --pr-u: #fcd34d; --pr-s: #86efac; --pr-t: #f9a8d4;
    --pr-p: #93c5fd; --pr-c: #8b98ad; --pr-o: #9aa8bc; --pr-sel: rgba(96, 165, 250, 0.30);
}
#tab-protocol h2.panel-title { font-size: 0.98rem; }

/* presets */
#tab-protocol .pr-preset-grid {
    display: grid; gap: 8px; margin-top: 12px;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 236px), 1fr));
}
#tab-protocol .pr-preset {
    appearance: none; -webkit-appearance: none; text-align: left; font: inherit; color: var(--fg); cursor: pointer;
    display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 9px 11px 10px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--card-2);
    transition: border-color 0.12s ease, background-color 0.12s ease;
}
#tab-protocol .pr-preset:hover { border-color: var(--accent-border); background: var(--accent-soft); }
#tab-protocol .pr-preset:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-protocol .pr-preset[aria-current="true"] { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
#tab-protocol .pr-preset-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
#tab-protocol .pr-preset-name { font-weight: 650; font-size: 0.86rem; line-height: 1.3; min-width: 0; flex: 1; }
#tab-protocol .pr-preset-meta { font-size: 0.72rem; color: var(--muted); font-weight: 600; letter-spacing: 0.02em; }
#tab-protocol .pr-preset-sum {
    font-size: 0.78rem; color: var(--muted); line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
#tab-protocol .pr-preset .badge { height: 18px; font-size: 0.66rem; padding: 0 6px; flex: none; }

/* editor */
#tab-protocol .pr-ed {
    position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr);
    height: 320px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--card-2);
    overflow: hidden; scroll-margin-top: 170px;
}
#tab-protocol .pr-ed:focus-within { border-color: var(--focus); box-shadow: 0 0 0 3px var(--focus-ring); }
#tab-protocol .pr-gutter { position: relative; overflow: hidden; background: var(--card); border-right: 1px solid var(--border); min-width: 44px; }
#tab-protocol .pr-gutter-in { padding: ${PAD_Y}px 0; will-change: transform; }
#tab-protocol .pr-ln {
    position: relative; height: ${LH}px; padding: 0 9px 0 14px; text-align: right;
    font: 12px/${LH}px var(--font-mono); color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap;
}
#tab-protocol .pr-ln.is-cur { color: var(--fg); }
#tab-protocol .pr-ln.is-warn { color: var(--warn); font-weight: 700; }
#tab-protocol .pr-ln.is-err { color: var(--bad); font-weight: 700; }
#tab-protocol .pr-ln.is-err::before, #tab-protocol .pr-ln.is-warn::before {
    content: ""; position: absolute; left: 4px; top: 7px; width: 6px; height: 6px; border-radius: 50%; background: currentColor;
}
#tab-protocol .pr-code { position: relative; overflow: hidden; min-width: 0; }
#tab-protocol .pr-bars { position: absolute; left: 0; right: 0; top: 0; pointer-events: none; will-change: transform; }
#tab-protocol .pr-bar { position: absolute; left: 0; right: 0; height: ${LH}px; }
#tab-protocol .pr-bar.cur { background: var(--hover); }
#tab-protocol .pr-bar.warn { background: var(--warn-soft); box-shadow: inset 3px 0 0 var(--warn); }
#tab-protocol .pr-bar.err { background: var(--bad-soft); box-shadow: inset 3px 0 0 var(--bad); }
#tab-protocol .pr-hl, #tab-protocol .pr-ta {
    font-family: var(--font-mono); font-size: 13px; line-height: ${LH}px; letter-spacing: 0; font-weight: 400; font-style: normal;
    tab-size: 4; -moz-tab-size: 4; font-variant-ligatures: none; font-feature-settings: "liga" 0, "calt" 0;
    white-space: pre; word-wrap: normal; overflow-wrap: normal; text-transform: none; text-indent: 0;
}
#tab-protocol .pr-hl {
    position: absolute; inset: 0; margin: 0; padding: 0; border: 0; border-radius: 0;
    background: transparent; overflow: hidden; color: var(--fg); pointer-events: none;
}
#tab-protocol .pr-hl-in {
    display: block; width: max-content; min-width: 100%; margin: 0; padding: ${PAD_Y}px 14px;
    font: inherit; background: none; border-radius: 0; color: inherit; will-change: transform;
}
#tab-protocol .pr-ta {
    position: absolute; inset: 0; display: block; width: 100%; height: 100%; margin: 0; padding: ${PAD_Y}px 14px;
    border: 0; border-radius: 0; resize: none; overflow: auto; outline: none; box-shadow: none;
    background: transparent; color: transparent; -webkit-text-fill-color: transparent; caret-color: var(--fg);
}
#tab-protocol .pr-ta:focus, #tab-protocol .pr-ta:focus-visible { outline: none; box-shadow: none; border: 0; }
#tab-protocol .pr-ta::selection { background: var(--pr-sel); -webkit-text-fill-color: transparent; }
#tab-protocol .pr-k { color: var(--pr-k); }
#tab-protocol .pr-n { color: var(--pr-n); }
#tab-protocol .pr-u { color: var(--pr-u); }
#tab-protocol .pr-s { color: var(--pr-s); }
#tab-protocol .pr-t { color: var(--pr-t); }
#tab-protocol .pr-p { color: var(--pr-p); }
#tab-protocol .pr-c { color: var(--pr-c); }
#tab-protocol .pr-o { color: var(--pr-o); }
#tab-protocol .pr-e { color: var(--bad); }
#tab-protocol .pr-x, #tab-protocol .pr-e {
    text-decoration: underline wavy var(--bad); text-decoration-skip-ink: none; text-underline-offset: 3px;
}
#tab-protocol .pr-ed-foot {
    display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px;
    margin-top: 6px; font-size: 0.76rem; color: var(--muted);
}
#tab-protocol .pr-ed-pos { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

/* compile messages */
#tab-protocol .pr-msgs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
#tab-protocol .pr-msg {
    display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 2px 10px; align-items: start;
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--bad-border); background: var(--bad-soft);
    font-size: 0.85rem; line-height: 1.45;
}
#tab-protocol .pr-msg.is-warn { border-color: var(--warn-border); background: var(--warn-soft); }
#tab-protocol .pr-msg.is-ok { border-color: var(--good-border); background: var(--good-soft); grid-template-columns: minmax(0, 1fr); }
#tab-protocol .pr-msg.is-info { border-color: var(--border); background: var(--card-2); grid-template-columns: minmax(0, 1fr); color: var(--muted); }
#tab-protocol .pr-msg-line {
    appearance: none; -webkit-appearance: none; cursor: pointer; white-space: nowrap;
    font: 600 0.74rem/1.2 var(--font-mono); padding: 3px 7px; margin-top: 1px; border-radius: 5px;
    border: 1px solid var(--bad-border); background: var(--card); color: var(--bad);
}
#tab-protocol .pr-msg.is-warn .pr-msg-line { border-color: var(--warn-border); color: var(--warn); }
#tab-protocol .pr-msg-line:hover { border-color: currentColor; }
#tab-protocol .pr-msg-kind { font-weight: 700; margin-right: 4px; }
#tab-protocol .pr-msg:not(.is-warn) .pr-msg-kind { color: var(--bad); }
#tab-protocol .pr-msg.is-warn .pr-msg-kind { color: var(--warn); }
#tab-protocol .pr-msg.is-ok .pr-msg-kind { color: var(--good); }
#tab-protocol .pr-msg-hint { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }

/* parameters */
#tab-protocol .pr-params { display: flex; flex-direction: column; }
#tab-protocol .pr-param { padding: 10px 0; }
#tab-protocol .pr-param + .pr-param { border-top: 1px solid var(--border-subtle); }
#tab-protocol .pr-param:first-child { padding-top: 2px; }
#tab-protocol .pr-param .ctl-label { font: 650 0.8rem var(--font-mono); color: var(--fg); }
#tab-protocol .pr-param-desc { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-top: 3px; font-size: 0.78rem; color: var(--muted); }
#tab-protocol .pr-param-desc .linklike { font-size: 0.74rem; white-space: nowrap; }
#tab-protocol .pr-side .stat-table caption { padding-top: 2px; }
#tab-protocol .pr-side .stat-table td { overflow-wrap: normal; word-break: normal; }
#tab-protocol .pr-side .stat-table th[title] { text-decoration: underline dotted var(--border-strong); text-underline-offset: 3px; cursor: help; }
#tab-protocol .pr-side .stat-table + .stat-table, #tab-protocol .pr-side .pr-scan-note + .stat-table { margin-top: 14px; }
#tab-protocol .pr-scan-note { margin: 14px 0 0; }

/* timeline */
#tab-protocol .pr-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.78rem; color: var(--muted); }
#tab-protocol .pr-legend span { display: inline-flex; align-items: center; gap: 6px; }
#tab-protocol .pr-sw { width: 14px; height: 10px; border-radius: 2px; flex: none; }
#tab-protocol .pr-sw-band { background: var(--accent); opacity: 0.3; }
#tab-protocol .pr-sw-cur { background: var(--accent); opacity: 0.6; }
#tab-protocol .pr-sw-line { height: 0; border-top: 2px solid currentColor; }
#tab-protocol .pr-frames-line { font-size: 0.82rem; margin: 6px 0 2px; }
#tab-protocol .pr-frames-line code { font-size: 0.8rem; }
#tab-protocol .pr-counts-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; margin: 14px 0 4px; }
#tab-protocol .pr-counts-title { font-size: 0.82rem; font-weight: 650; }
#tab-protocol .pr-counts.is-stale { opacity: 0.45; transition: opacity 0.2s ease; }
#tab-protocol .plot-stage > canvas.pr-under { position: absolute; left: 0; top: 0; pointer-events: none; }
#tab-protocol .plot-stage > .plot-canvas { position: relative; }

/* how the scanner listens */
#tab-protocol .pr-listen .stats { margin-top: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
#tab-protocol .pr-listen .stat { padding: 7px 9px; }
#tab-protocol .pr-listen .stat-value { font-size: 1.02rem; }
#tab-protocol .pr-listen h3 { font-size: 0.9rem; margin: 0 0 4px; }
#tab-protocol .pr-listen .note { margin: 8px 0 0; }

/* reference */
#tab-protocol .pr-ref .stat-table td { text-align: left; white-space: normal; }
#tab-protocol .pr-ref .stat-table th { width: 48%; }
#tab-protocol .pr-ref h4 { margin: 14px 0 6px; }
#tab-protocol .pr-ref pre { white-space: pre; }
@media (max-width: 640px) {
    #tab-protocol .pr-ref .stat-table, #tab-protocol .pr-ref .stat-table tbody,
    #tab-protocol .pr-ref .stat-table tr, #tab-protocol .pr-ref .stat-table th, #tab-protocol .pr-ref .stat-table td { display: block; width: auto; }
    #tab-protocol .pr-ref .stat-table th { padding: 6px 0 0; }
    #tab-protocol .pr-ref .stat-table td { padding: 0 0 6px; }
    #tab-protocol .pr-ref .stat-table tr + tr > td { border-top: 0; }
}
`;

    /* ---------- small helpers ---------- */
    const el = function (tag, attrs, kids) { return U.el(tag, attrs, kids); };
    const W = function () { return PET.ui.w; };
    const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const st = function () { return PET.state || {}; };
    function goodProgram() {
        const s = st();
        return s.program && s.program.ok ? s.program : (s.lastGoodProgram || null);
    }
    function isotopeOf(prog) {
        if (!prog || !PET.isotopes) return null;
        try { return PET.isotopes.get(prog.isotope); } catch (e) { return null; }
    }
    function tracerOf(prog) {
        if (!prog || !prog.tracer || !PET.tracers) return null;
        try { return PET.tracers.get(prog.tracer); } catch (e) { return null; }
    }
    const ISO_COLOR = { F18: 'var(--c1)', C11: 'var(--c3)', O15: 'var(--c2)' };
    function presets() { return Array.isArray(PET.presets) ? PET.presets : []; }
    function presetById(id) { return presets().find(function (p) { return p.id === id; }) || null; }
    function minutes(s) { return String(Number((s / 60).toFixed(2))); }
    function fmtT(s) { return s === 0 ? '0 min' : U.fmtTime(s, 3); }
    function pct(x) { return isFinite(x) ? U.fmtNum(100 * x, 3) + ' %' : '-'; }
    function phantomLabel(id, opts) {
        let name = id;
        try { const l = PET.phantoms.list().find(function (p) { return p.id === id; }); if (l) name = l.name; } catch (e) { /* phantoms missing */ }
        if (id === 'brain' && opts && opts.condition && opts.condition !== 'normal') {
            name += opts.condition === 'ad' ? ' (AD)' : opts.condition === 'pd' ? ' (PD)' : ' (' + opts.condition + ')';
        }
        return name;
    }
    function nice(x) {
        const m = Math.pow(10, Math.floor(Math.log10(x))), f = x / m;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * m;
    }
    function linspace(a, b, n) { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = a + (b - a) * i / (n - 1); return out; }

    /* Consecutive frames of equal length, grouped as the protocol wrote them. */
    function frameGroups(frames) {
        const out = [];
        (frames || []).forEach(function (f) {
            const d = f.t1 - f.t0, last = out[out.length - 1];
            if (last && Math.abs(last.dur - d) < 1e-6 && Math.abs(last.t1 - f.t0) < 1e-6) { last.n++; last.t1 = f.t1; }
            else out.push({ n: 1, dur: d, t0: f.t0, t1: f.t1 });
        });
        return out;
    }

    /* Replace the arguments of the first line that starts with a statement
       keyword, keeping any comment on it, or append the statement. Used by
       the "try this" buttons (lower the energy window ...). */
    function rewriteStatement(src, kw, rest) {
        const re = new RegExp('^([ \\t]*' + kw + ')\\b[^#\\n]*?([ \\t]*#[^\\n]*)?$', 'm');
        if (re.test(src)) return src.replace(re, function (m, a, c) { return a + ' ' + rest + (c ? '  ' + c.trim() : ''); });
        return src.replace(/\s*$/, '') + '\n' + kw + ' ' + rest + '\n';
    }

    /* Map an offset in the old text to the new text after a single edit
       (common prefix and suffix), so the caret stays where the student
       left it when a slider rewrites a number elsewhere in the source. */
    function mapOffset(a, b, off) {
        const m = Math.min(a.length, b.length);
        let p = 0;
        while (p < m && a.charCodeAt(p) === b.charCodeAt(p)) p++;
        let s = 0;
        while (s < m - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
        if (off <= p) return off;
        if (off >= a.length - s) return off + (b.length - a.length);
        return Math.min(b.length - s, Math.max(p, off));
    }

    /* ---------- shaded bands under a PET.ui.w.plot ----------
       The plot widget draws lines; frames and windows are shaded on a
       second canvas behind it, mapped with the plot's own layout so they
       stay aligned through resizes and theme changes. */
    function bandLayer(plot) {
        const stage = plot.canvas.parentNode;
        const under = el('canvas', { class: 'pr-under', 'aria-hidden': 'true' });
        stage.insertBefore(under, plot.canvas);
        let spec = { bands: [] };
        function paint() {
            const w = plot.canvas.clientWidth, h = plot.canvas.clientHeight;
            if (!w || !h) return;
            const r = U.setupCanvas(under, w, h), ctx = r.ctx;
            ctx.clearRect(0, 0, w, h);
            const L = plot.layout ? plot.layout() : null;
            if (!L || !spec) return;
            ctx.save();
            ctx.beginPath(); ctx.rect(L.left, L.top, L.pw, L.ph); ctx.clip();
            (spec.bands || []).forEach(function (b) {
                const a = Math.max(Math.min(b.x0, b.x1), L.xlo), z = Math.min(Math.max(b.x0, b.x1), L.xhi);
                if (!(z >= a)) return;
                let x0 = L.X(a), x1 = L.X(z);
                if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
                if (x1 - x0 < 1.5) x1 = x0 + 1.5;              // a 10 s frame on an hour axis still shows
                ctx.globalAlpha = b.alpha !== undefined ? b.alpha : 0.15;
                ctx.fillStyle = color(b.color || 'var(--accent)');
                ctx.fillRect(x0, L.top, x1 - x0, L.ph);
                if (b.edge) {
                    ctx.globalAlpha = b.edgeAlpha !== undefined ? b.edgeAlpha : 0.55;
                    ctx.strokeStyle = color(b.edgeColor || b.color || 'var(--accent)');
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    const xe = Math.round(x0) + 0.5;
                    ctx.moveTo(xe, L.top); ctx.lineTo(xe, L.top + L.ph); ctx.stroke();
                }
            });
            ctx.restore();
            ctx.globalAlpha = 1;
            if (typeof spec.draw === 'function') {
                try { spec.draw(ctx, L); } catch (e) { if (root.console) root.console.error('[protocol] band overlay failed:', e); }
            }
        }
        const draw0 = plot.draw, redraw0 = plot.redraw;
        plot.draw = function (series, opts) { draw0(series, opts); paint(); return plot; };
        plot.redraw = function () { redraw0(); paint(); return plot; };
        if (root.ResizeObserver) new root.ResizeObserver(function () { raf(paint); }).observe(stage);
        if (PET.bus) PET.bus.on('theme:changed', function () { raf(paint); });
        return { set: function (s) { spec = s || { bands: [] }; paint(); }, paint: paint };
    }
    function color(c) {
        if (typeof c !== 'string') return '#888';
        const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(c.trim());
        return m ? U.cssVar(m[1], '#888') : c;
    }
    /* Text with a halo in the card colour, readable over grid lines and bands. */
    function haloText(ctx, text, x, y, fill, align) {
        ctx.save();
        ctx.font = '600 11px ' + U.cssVar('--font-sans', 'sans-serif');
        ctx.textAlign = align || 'center'; ctx.textBaseline = 'bottom';
        ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = U.cssVar('--card', '#fff');
        ctx.strokeText(text, x, y);
        ctx.fillStyle = fill; ctx.fillText(text, x, y);
        ctx.restore();
    }

    /* ============================================================
       The editor
       ============================================================ */
    function createEditor(onEdit) {
        const helpId = 'pr-ed-help';
        const wrap = el('div', { class: 'pr-ed' });
        const gutter = el('div', { class: 'pr-gutter', 'aria-hidden': 'true' });
        const gutterIn = el('div', { class: 'pr-gutter-in' });
        gutter.appendChild(gutterIn);
        const code = el('div', { class: 'pr-code' });
        const bars = el('div', { class: 'pr-bars', 'aria-hidden': 'true' });
        const pre = el('pre', { class: 'pr-hl', 'aria-hidden': 'true' });
        const hl = el('code', { class: 'pr-hl-in' });
        pre.appendChild(hl);
        const ta = el('textarea', {
            class: 'pr-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off',
            wrap: 'off', 'aria-label': 'Protocol source', 'aria-describedby': helpId, 'data-gramm': 'false'
        });
        code.appendChild(bars); code.appendChild(pre); code.appendChild(ta);
        wrap.appendChild(gutter); wrap.appendChild(code);
        const pos = el('span', { class: 'pr-ed-pos', 'aria-hidden': 'true' });
        const foot = el('div', { class: 'pr-ed-foot' }, [
            el('span', { id: helpId, text: 'Edits compile as you type. Tab indents; press Esc and then Tab to move on.' }), pos
        ]);

        const E = {
            el: wrap, foot: foot, ta: ta,
            pending: null,          // timer of an edit not yet sent to setSource
            marks: { errors: [], warnings: [], source: null },
            params: new Set(),
            lines: 0, escTab: false, curLine: 1
        };

        function lineStarts(text) {
            const out = [0];
            for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
            return out;
        }
        function cls(t) {
            switch (t.type) {
                case 'keyword': return 'pr-k';
                case 'number': return 'pr-n';
                case 'unit': return 'pr-u';
                case 'string': return 'pr-s';
                case 'comment': return 'pr-c';
                case 'op': return 'pr-o';
                case 'tracer': case 'isotope': return 'pr-t';
                case 'error': return 'pr-e';
                case 'ident': return E.params.has(t.text) ? 'pr-p' : '';
                default: return '';
            }
        }
        /* Highlighted HTML: tokens from the language's own lexer, with the
           text between them (spaces, line breaks) copied verbatim. */
        function highlight(text, errOffsets) {
            let toks = [];
            try { if (PET.dsl && typeof PET.dsl.tokenize === 'function') toks = PET.dsl.tokenize(text); } catch (e) { toks = []; }
            let out = '', p = 0;
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (!(t.start >= p) || !(t.end >= t.start)) continue;
                if (t.start > p) out += esc(text.slice(p, t.start));
                let c = cls(t);
                for (let j = 0; j < errOffsets.length; j++) {
                    const o = errOffsets[j];
                    if (o >= t.start && (o < t.end || (o === t.start && t.end === t.start))) { c += ' pr-x'; break; }
                }
                const s = esc(text.slice(t.start, t.end));
                out += c.trim() ? '<span class="' + c.trim() + '">' + s + '</span>' : s;
                p = t.end;
            }
            out += esc(text.slice(p));
            return out + '\n';
        }
        function markLines() {
            const text = ta.value;
            const valid = E.marks.source === text;
            const err = {}, warn = {};
            if (valid) {
                E.marks.errors.forEach(function (m) { err[m.line] = (err[m.line] ? err[m.line] + '\n' : '') + m.msg; });
                E.marks.warnings.forEach(function (m) { if (!err[m.line]) warn[m.line] = (warn[m.line] ? warn[m.line] + '\n' : '') + m.msg; });
            }
            return { err: err, warn: warn, valid: valid };
        }
        function render() {
            const text = ta.value;
            const starts = lineStarts(text);
            const n = starts.length;
            const mk = markLines();
            const errOff = [];
            if (mk.valid) {
                E.marks.errors.forEach(function (m) {
                    const ls = starts[Math.max(0, Math.min(n - 1, m.line - 1))];
                    errOff.push(ls + Math.max(0, (m.col || 1) - 1));
                });
            }
            hl.innerHTML = highlight(text, errOff);
            // gutter
            let g = '';
            for (let i = 1; i <= n; i++) {
                const c = mk.err[i] ? ' is-err' : (mk.warn[i] ? ' is-warn' : (i === E.curLine ? ' is-cur' : ''));
                g += '<div class="pr-ln' + c + '">' + i + '</div>';
            }
            gutterIn.innerHTML = g;
            // line bars (errors, warnings, the caret line)
            let b = '';
            const add = function (line, k) { b += '<div class="pr-bar ' + k + '" style="top:' + (PAD_Y + (line - 1) * LH) + 'px"></div>'; };
            if (doc.activeElement === ta && !mk.err[E.curLine] && !mk.warn[E.curLine]) add(E.curLine, 'cur');
            Object.keys(mk.warn).forEach(function (l) { add(+l, 'warn'); });
            Object.keys(mk.err).forEach(function (l) { add(+l, 'err'); });
            bars.innerHTML = b;
            if (n !== E.lines) { E.lines = n; fitHeight(); }
            sync();
        }
        function fitHeight() {
            const vh = root.innerHeight || 800;
            const maxH = Math.max(260, Math.min(620, Math.round(vh * 0.72)));
            const h = Math.max(200, Math.min(maxH, E.lines * LH + 2 * PAD_Y + 18));
            wrap.style.height = h + 'px';
        }
        function sync() {
            const x = ta.scrollLeft, y = ta.scrollTop;
            hl.style.transform = 'translate(' + (-x) + 'px,' + (-y) + 'px)';
            gutterIn.style.transform = 'translateY(' + (-y) + 'px)';
            bars.style.transform = 'translateY(' + (-y) + 'px)';
        }
        function caretInfo() {
            const text = ta.value, p = ta.selectionStart || 0;
            let line = 1, ls = 0;
            for (let i = 0; i < p; i++) if (text.charCodeAt(i) === 10) { line++; ls = i + 1; }
            return { line: line, col: p - ls + 1 };
        }
        function updateCaret() {
            const c = caretInfo();
            pos.textContent = 'Line ' + c.line + ', column ' + c.col;
            if (c.line !== E.curLine) { E.curLine = c.line; render(); }
        }

        /* Insert text at the selection through the browser's editing
           command when it exists, so Ctrl+Z still undoes it. */
        function insert(text, start, end) {
            ta.focus();
            if (start !== undefined) ta.setSelectionRange(start, end);
            let ok = false;
            try { ok = doc.execCommand && doc.execCommand('insertText', false, text); } catch (e) { ok = false; }
            if (!ok) {
                const s = ta.selectionStart, e2 = ta.selectionEnd;
                ta.setRangeText(text, s, e2, 'end');
                ta.dispatchEvent(new root.Event('input', { bubbles: true }));
            }
        }
        function indent(outdent) {
            const text = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
            const multi = text.slice(s, e).indexOf('\n') >= 0;
            if (!outdent && !multi) { insert(INDENT); return; }
            const ls = text.lastIndexOf('\n', s - 1) + 1;
            let le = text.indexOf('\n', e > s && text[e - 1] === '\n' ? e - 1 : e);
            if (le < 0) le = text.length;
            const block = text.slice(ls, le).split('\n');
            let firstDelta = 0, total = 0;
            const out = block.map(function (line, i) {
                if (!outdent) { if (i === 0) firstDelta = INDENT.length; total += INDENT.length; return INDENT + line; }
                const m = /^( {1,2}|\t)/.exec(line), k = m ? m[0].length : 0;
                if (i === 0) firstDelta = -k;
                total -= k;
                return line.slice(k);
            }).join('\n');
            if (out === text.slice(ls, le)) return;
            insert(out, ls, le);
            const ns = Math.max(ls, s + firstDelta), ne = Math.max(ns, e + total);
            ta.setSelectionRange(multi ? ns : ns, multi ? ne : ns);
        }

        ta.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { E.escTab = true; return; }
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                if (E.escTab) { E.escTab = false; return; }      // let focus move on
                e.preventDefault();
                indent(e.shiftKey);
                return;
            }
            E.escTab = false;
        });
        ta.addEventListener('input', function () {
            render();
            updateCaret();
            if (E.pending) clearTimeout(E.pending);
            E.pending = setTimeout(flush, EDIT_DEBOUNCE);
        });
        ta.addEventListener('scroll', sync);
        ta.addEventListener('keyup', updateCaret);
        ta.addEventListener('click', updateCaret);
        ta.addEventListener('focus', function () { updateCaret(); render(); });
        ta.addEventListener('blur', function () { flush(); render(); });
        ta.addEventListener('select', updateCaret);

        function flush() {
            if (!E.pending) return;
            clearTimeout(E.pending);
            E.pending = null;
            onEdit(ta.value);
        }

        return {
            el: wrap, foot: foot, ta: ta,
            render: render, fitHeight: fitHeight, flush: flush,
            hasPending: function () { return !!E.pending; },
            cancelPending: function () { if (E.pending) { clearTimeout(E.pending); E.pending = null; } },
            getText: function () { return ta.value; },
            /* Replace the text (from outside: a slider, a preset), keeping
               the caret and the scroll position where they were. */
            setText: function (text) {
                const old = ta.value;
                if (old === text) return;
                const s = ta.selectionStart || 0, e = ta.selectionEnd || 0, sl = ta.scrollLeft, sy = ta.scrollTop;
                const focused = doc.activeElement === ta;
                ta.value = text;
                const ns = mapOffset(old, text, s), ne = mapOffset(old, text, e);
                try { ta.setSelectionRange(Math.min(ns, text.length), Math.min(Math.max(ns, ne), text.length)); } catch (err) { /* detached */ }
                ta.scrollLeft = sl; ta.scrollTop = sy;
                if (!focused && doc.activeElement === ta) ta.blur();
                render();
                const c = caretInfo();
                pos.textContent = 'Line ' + c.line + ', column ' + c.col;
            },
            setMarks: function (source, errors, warnings, params) {
                E.marks = { source: source, errors: errors || [], warnings: warnings || [] };
                E.params = new Set((params || []).map(function (p) { return p.name; }));
                render();
            },
            /* Put the caret at (line, col), focus, and bring it into view. */
            focusAt: function (line, col) {
                const text = ta.value;
                let off = 0, l = 1;
                while (l < line) { const k = text.indexOf('\n', off); if (k < 0) break; off = k + 1; l++; }
                const le = text.indexOf('\n', off);
                off = Math.min(off + Math.max(0, (col || 1) - 1), le < 0 ? text.length : le);
                ta.focus({ preventScroll: true });
                ta.setSelectionRange(off, off);
                const y = PAD_Y + (line - 1) * LH, hgt = ta.clientHeight;
                if (y < ta.scrollTop + LH || y > ta.scrollTop + hgt - 2 * LH) ta.scrollTop = Math.max(0, y - hgt / 3);
                ta.scrollLeft = 0;
                try { wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { wrap.scrollIntoView(); }
                updateCaret(); render();
            }
        };
    }

    /* ============================================================
       The tab
       ============================================================ */
    const T = {
        panel: null, visible: false, dirty: true, frameReq: 0,
        group: 'brain', ed: null, sliders: {}, paramSig: '', dragging: null, paramTimer: null, paramQueue: null,
        spectrum: null
    };

    function mount(panel) {
        T.panel = panel;
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        if (!PET.ui.w) { panel.appendChild(el('div', { class: 'error-card', text: 'The shared widgets (js/ui/widgets.js) did not load, so the Protocol tab cannot be drawn.' })); return; }
        const w = W();

        // 1. concept
        panel.appendChild(w.concept({
            title: 'A protocol is a recipe for the scan',
            body: '<p>A protocol says what is injected (the <b>tracer</b>, which fixes the <b>isotope</b>), <b>how much</b> (the dose), ' +
                '<b>when</b> counting starts (the uptake time), <b>for how long</b> and in how many pieces (the frames), and ' +
                '<b>how the scanner listens</b>: which photon energies it accepts, how close in time two photons must arrive to count ' +
                'as a pair, and whether it uses their time of flight.</p>' +
                '<p>The clock starts at the injection and the isotope decays the whole time, so the uptake you choose decides how much ' +
                'activity is left to count, and a long scan counts a fading source.</p>',
            formula: 'A(t) = A<sub>0</sub> e<sup>&minus;&lambda;t</sup>, &nbsp; &lambda; = ln 2 / T<sub>&frac12;</sub>',
            tryThis: [
                { html: 'Drag <code>UPTAKE</code> from 45 to 90 min on the FDG protocol: the activity left at scan start falls from 75 % to 57 % and the trues fall with it.',
                    label: 'Set 90 min', run: function () { tryUptake(); } },
                { html: 'Type <code>45</code> instead of <code>45 min</code> on the UPTAKE line and read the error: units are part of the language.' },
                { html: 'Widen the energy window to <code>350 keV .. 650 keV</code> and watch the share of scattered photons accepted rise below.',
                    label: 'Use 350 keV', run: function () { tryRewrite('energy', '350 keV .. 650 keV'); } },
                { html: 'Load <b>FDG brain, dynamic</b>: twenty frames start at the injection, short ones first.',
                    label: 'Load it', run: function () { loadPreset('fdg_dynamic'); } }
            ]
        }));

        // 2. presets
        const presetPanel = el('section', { class: 'panel pr-presets', 'aria-labelledby': 'pr-presets-title' });
        T.groupSeg = w.segmented({
            ariaLabel: 'Preset group', size: 'sm', value: T.group,
            options: GROUPS.map(function (g) { return { value: g.id, label: g.label + ' (' + presets().filter(function (p) { return p.group === g.id; }).length + ')' }; }),
            onChange: function (v) { T.group = v; renderPresets(); }
        });
        presetPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pr-presets-title', text: 'Start from a preset' }),
            el('span', { class: 'panel-sub', text: 'Loading one also sets up its phantom.' }),
            el('span', { class: 'spacer' }), T.groupSeg
        ]));
        T.presetGrid = el('div', { class: 'pr-preset-grid' });
        presetPanel.appendChild(T.presetGrid);
        panel.appendChild(presetPanel);

        // 3. editor + side column
        const split = el('div', { class: 'split' });
        const edPanel = el('section', { class: 'panel pr-editor', 'aria-labelledby': 'pr-ed-title' });
        T.status = el('span', { class: 'badge badge-muted', role: 'status' });
        T.btnRevert = w.button({ label: 'Revert to preset', size: 'sm', kind: 'ghost', title: 'Reload the preset this protocol started from', onClick: function () { loadPreset(st().presetId); } });
        T.btnCopy = w.button({ label: 'Copy', size: 'sm', kind: 'ghost', title: 'Copy the protocol text to the clipboard', onClick: copySource });
        T.edName = el('span', { class: 'panel-sub' });
        edPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pr-ed-title', text: 'Protocol' }), T.edName,
            el('span', { class: 'spacer' }), T.status, T.btnRevert, T.btnCopy
        ]));
        T.ed = createEditor(function (text) { if (PET.actions) PET.actions.setSource(text); });
        edPanel.appendChild(T.ed.el);
        edPanel.appendChild(T.ed.foot);
        T.msgs = el('ul', { class: 'pr-msgs', 'aria-label': 'Compiler messages' });
        edPanel.appendChild(T.msgs);
        split.appendChild(edPanel);

        const side = el('div', { class: 'pr-side' });
        const parPanel = el('section', { class: 'panel', 'aria-labelledby': 'pr-par-title' });
        parPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pr-par-title', text: 'Parameters' }),
            el('span', { class: 'panel-sub', text: 'Each param line becomes a slider.' })
        ]));
        T.params = el('div', { class: 'pr-params' });
        parPanel.appendChild(T.params);
        side.appendChild(parPanel);
        const statPanel = el('section', { class: 'panel', 'aria-labelledby': 'pr-stat-title' });
        statPanel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'pr-stat-title', text: 'What this protocol does' })]));
        T.statProto = w.statTable([], { caption: 'Protocol', compact: true });
        T.scanNote = el('p', { class: 'note pr-scan-note' });
        T.statScan = w.statTable([], { caption: 'Last scan', compact: true });
        statPanel.appendChild(T.statProto);
        statPanel.appendChild(T.scanNote);
        statPanel.appendChild(T.statScan);
        side.appendChild(statPanel);
        split.appendChild(side);
        panel.appendChild(split);

        // 4. timeline
        const tl = el('section', { class: 'panel pr-timeline', 'aria-labelledby': 'pr-tl-title' });
        tl.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pr-tl-title', text: 'Timeline: activity left after the injection' }),
            el('span', { class: 'spacer' }),
            el('div', { class: 'pr-legend', 'aria-hidden': 'true' }, [
                T.legCurve = el('span', {}, [el('span', { class: 'pr-sw pr-sw-line' }), 'activity left']),
                el('span', {}, [el('span', { class: 'pr-sw pr-sw-band' }), 'frames (the scanner counts)']),
                T.legCur = el('span', {}, [el('span', { class: 'pr-sw pr-sw-cur' }), 'frame shown in the image tabs'])
            ])
        ]));
        T.tlEmpty = w.empty('Write a protocol that compiles to see its timeline.');
        tl.appendChild(T.tlEmpty);
        T.tlBox = el('div');
        T.tlPlot = w.plot(T.tlBox, { height: 230, xlabel: 'Time after injection (min)', ylabel: 'Activity left (% of dose)' });
        T.tlBands = bandLayer(T.tlPlot);
        T.framesLine = el('p', { class: 'note pr-frames-line' });
        T.tlBox.appendChild(T.framesLine);
        T.countMode = w.segmented({
            ariaLabel: 'Counts per frame or per second', size: 'sm', value: 'frame',
            options: [{ value: 'frame', label: 'Per frame' }, { value: 'rate', label: 'Per second' }],
            onChange: function () { renderTimeline(); }
        });
        T.countsTitle = el('span', { class: 'pr-counts-title', text: 'Coincidences recorded in each frame' });
        T.tlBox.appendChild(el('div', { class: 'pr-counts-head' }, [T.countsTitle, T.countMode]));
        T.countsBox = el('div', { class: 'pr-counts' });
        T.cntPlot = w.plot(T.countsBox, { height: 170, xlabel: 'Time after injection (min)', ylabel: 'Counts', yfmt: function (v) { return U.fmtCounts(v); } });
        T.cntBands = bandLayer(T.cntPlot);
        T.cntEmpty = w.empty('No scan of this protocol yet. Press Acquire, or wait for the automatic re-scan.');
        T.countsBox.appendChild(T.cntEmpty);
        T.tlBox.appendChild(T.countsBox);
        tl.appendChild(T.tlBox);
        panel.appendChild(tl);

        // 5. how the scanner listens
        const ls = el('section', { class: 'panel pr-listen', 'aria-labelledby': 'pr-ls-title' });
        ls.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'pr-ls-title', text: 'How the scanner listens' }),
            el('span', { class: 'panel-sub', text: 'The energy and coincidence windows decide which photons become counts.' })
        ]));
        const lg = el('div', { class: 'split-even' });
        const eBox = el('div');
        eBox.appendChild(el('h3', { text: 'Energy window' }));
        T.ePlot = w.plot(eBox, { height: 210, xlabel: 'Measured photon energy (keV)', ylabel: 'Share per keV (%)' });
        T.eBands = bandLayer(T.ePlot);
        T.eStats = el('div', { class: 'stats' });
        eBox.appendChild(T.eStats);
        T.eNote = el('p', { class: 'note' });
        eBox.appendChild(T.eNote);
        const tBox = el('div');
        tBox.appendChild(el('h3', { text: 'Coincidence window' }));
        T.tPlot = w.plot(tBox, { height: 210, xlabel: 'Position along the line, from its middle (mm)', ylabel: 'True events kept (%)' });
        T.tBands = bandLayer(T.tPlot);
        T.tStats = el('div', { class: 'stats' });
        tBox.appendChild(T.tStats);
        T.tNote = el('p', { class: 'note' });
        tBox.appendChild(T.tNote);
        lg.appendChild(eBox); lg.appendChild(tBox);
        ls.appendChild(lg);
        ls.appendChild(el('p', { class: 'simplification', text: 'Simplified: the spectrum shows photons that scattered once in the patient; real spectra also hold photons that scattered in the detector and multiple scatters. Each curve is drawn with unit area, so their heights are not the real ratio of scattered to unscattered photons.' }));
        panel.appendChild(ls);

        // 6. language reference
        const ref = el('details', { class: 'adv pr-ref' }, [el('summary', { text: 'Language reference' })]);
        const refBody = el('div', { class: 'pr-ref-body' });
        if (PET.dsl && PET.dsl.reference) refBody.innerHTML = PET.dsl.reference;
        else refBody.textContent = 'The protocol compiler (js/dsl.js) did not load, so its reference is not available.';
        ref.appendChild(refBody);
        panel.appendChild(el('section', { class: 'panel' }, [ref]));

        // bus
        const bus = PET.bus;
        bus.on('program:compiled', onCompiled);
        bus.on('preset:loaded', function (e) {
            const p = presetById(e && e.id);
            if (p && p.group && p.group !== T.group) { T.group = p.group; T.groupSeg.set(p.group); }
            renderPresets();
        });
        ['phantom:changed', 'scan:start', 'scan:done', 'scan:error', 'frame:changed'].forEach(function (evt) { bus.on(evt, invalidate); });

        const cur = presetById(st().presetId);
        if (cur && cur.group) { T.group = cur.group; T.groupSeg.set(cur.group); }
        renderPresets();
        onCompiled({ program: st().program });
    }

    /* ---------- actions used by the tab ---------- */
    function loadPreset(id) {
        if (!PET.actions || !id) return;
        const s = st();
        const before = { source: s.source, phantomId: s.phantomId, phantomOpts: JSON.parse(JSON.stringify(s.phantomOpts || {})) };
        const was = presetById(s.presetId);
        const edited = !was || was.source !== s.source;
        T.ed.cancelPending();
        if (!PET.actions.loadPreset(id)) return;
        if (edited && before.source && before.source !== st().source) {
            const p = presetById(id);
            const undo = el('button', { type: 'button', class: 'linklike', style: { color: '#93c5fd', marginLeft: '6px' } }, 'Undo');
            const msg = el('span', {}, ['Loaded ' + (p ? p.name : id) + '. Your edited protocol was replaced.', undo]);
            const t = W().toast(msg, 'info', { timeout: 8000 });
            undo.addEventListener('click', function () {
                PET.actions.setSource(before.source);
                PET.actions.setPhantom(before.phantomId, before.phantomOpts);
                if (t && t.dismiss) t.dismiss();
            });
        }
    }
    function tryUptake() {
        const prog = goodProgram();
        const has = prog && prog.params && prog.params.some(function (p) { return p.name === 'UPTAKE'; });
        if (!has || !prog.tracer || prog.tracer !== 'FDG') loadPreset('fdg_static');
        PET.actions.setParam('UPTAKE', 90 * 60);
    }
    function tryRewrite(kw, rest) {
        if (!PET.actions) return;
        T.ed.flush();
        PET.actions.setSource(rewriteStatement(st().source || '', kw, rest));
    }
    function copySource() {
        const text = T.ed.getText();
        const done = function () { W().toast('Protocol copied to the clipboard.', 'good'); };
        const fallback = function () {
            const ta = T.ed.ta;
            ta.focus(); ta.select();
            let ok = false;
            try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
            if (ok) done(); else W().toast('Copying is blocked here: select the text and press Ctrl+C (Cmd+C on a Mac).', 'warn');
        };
        try {
            if (root.navigator && root.navigator.clipboard && root.isSecureContext !== false) root.navigator.clipboard.writeText(text).then(done, fallback);
            else fallback();
        } catch (e) { fallback(); }
    }

    /* ---------- rendering ---------- */
    function invalidate() {
        T.dirty = true;
        if (!T.visible || T.frameReq) return;
        T.frameReq = raf(function () { T.frameReq = 0; if (T.visible && T.dirty) renderViews(); });
    }
    function renderViews() {
        T.dirty = false;
        renderStats();
        renderTimeline();
        renderListen();
    }

    function onCompiled(e) {
        const prog = (e && e.program) || st().program;
        if (!T.ed) return;
        const s = st();
        const src = prog ? prog.source : (s.source || '');
        if (src !== T.ed.getText()) {
            T.ed.cancelPending();         // a change from outside (slider, preset, lesson) wins
            T.ed.setText(src || '');
        }
        const good = goodProgram();
        T.ed.setMarks(src, prog && !prog.ok ? prog.errors : [], prog && prog.ok ? prog.warnings : [],
            (prog && prog.params && prog.params.length ? prog.params : (good && good.params) || []));
        renderMessages(prog);
        renderStatus(prog);
        renderParams();
        renderPresets();
        invalidate();
    }

    function renderStatus(prog) {
        const b = T.status;
        if (!prog) { b.className = 'badge badge-muted'; b.textContent = 'No protocol'; }
        else if (!prog.ok) {
            const n = (prog.errors || []).length;
            b.className = 'badge badge-bad'; b.textContent = n === 1 ? '1 error' : n + ' errors';
        } else if (prog.warnings && prog.warnings.length) {
            const n = prog.warnings.length;
            b.className = 'badge badge-warn'; b.textContent = 'Compiled, ' + (n === 1 ? '1 warning' : n + ' warnings');
        } else { b.className = 'badge badge-good'; b.textContent = 'Compiled'; }
        const good = goodProgram();
        T.edName.textContent = good && good.name ? good.name : '';
        const p = presetById(st().presetId);
        T.btnRevert.hidden = !(p && p.source !== st().source);
    }

    function renderMessages(prog) {
        const list = T.msgs;
        list.textContent = '';
        if (!prog) return;
        const item = function (kind, m) {
            const li = el('li', { class: 'pr-msg' + (kind === 'warn' ? ' is-warn' : '') });
            const btn = el('button', { type: 'button', class: 'pr-msg-line', title: 'Put the cursor on line ' + m.line,
                'aria-label': (kind === 'warn' ? 'Warning' : 'Error') + ' on line ' + m.line + ': go to the line' }, 'Line ' + m.line);
            btn.addEventListener('click', function () { T.ed.focusAt(m.line, m.col || 1); });
            li.appendChild(btn);
            li.appendChild(el('div', {}, [
                el('span', { class: 'pr-msg-kind', text: kind === 'warn' ? 'Warning.' : 'Error.' }),
                m.msg,
                m.hint ? el('div', { class: 'pr-msg-hint', text: m.hint }) : null
            ]));
            return li;
        };
        if (!prog.ok) {
            (prog.errors || []).forEach(function (m) { list.appendChild(item('err', m)); });
            if (st().lastGoodProgram) {
                list.appendChild(el('li', { class: 'pr-msg is-info', text: 'Until it compiles, the plots and numbers below show the last version that did, and nothing is re-scanned.' }));
            }
            return;
        }
        (prog.warnings || []).forEach(function (m) { list.appendChild(item('warn', m)); });
        if (!(prog.warnings || []).length) {
            const sum = prog.dynamic
                ? prog.frames.length + ' frames over ' + fmtT(prog.stats.scanDuration) + ', from ' + fmtT(prog.scanStart) + ' to ' + fmtT(prog.scanEnd) + ' after the injection.'
                : 'One ' + fmtT(prog.stats.scanDuration) + ' frame starting ' + fmtT(prog.scanStart) + ' after the injection.';
            list.appendChild(el('li', { class: 'pr-msg is-ok' }, [el('div', {}, [el('span', { class: 'pr-msg-kind', text: 'No problems.' }), sum])]));
        }
    }

    /* Cards are rebuilt only when the group changes; otherwise their
       state is updated in place, so a card keeps keyboard focus after
       Enter loads it. */
    function renderPresets() {
        if (!T.presetGrid) return;
        const s = st();
        if (T.presetGroupBuilt !== T.group) {
            T.presetGroupBuilt = T.group;
            T.presetCards = {};
            T.presetGrid.textContent = '';
            const list = presets().filter(function (p) { return p.group === T.group; });
            if (!list.length) { T.presetGrid.appendChild(W().empty(presets().length ? 'No presets in this group.' : 'The preset library (js/presets.js) did not load.')); return; }
            list.forEach(function (p) {
                const badge = W().badge('loaded', 'accent');
                const top = el('span', { class: 'pr-preset-top' }, [el('span', { class: 'pr-preset-name', text: p.name }), badge]);
                const b = el('button', { type: 'button', class: 'pr-preset' },
                    [top, el('span', { class: 'pr-preset-meta', text: phantomLabel(p.phantom, p.phantomOpts) }), el('span', { class: 'pr-preset-sum', text: p.summary || '' })]);
                b.addEventListener('click', function () { loadPreset(p.id); });
                T.presetGrid.appendChild(b);
                T.presetCards[p.id] = { btn: b, badge: badge, preset: p };
            });
        }
        Object.keys(T.presetCards || {}).forEach(function (id) {
            const c = T.presetCards[id], p = c.preset;
            const current = id === s.presetId, edited = current && p.source !== s.source;
            c.btn.setAttribute('aria-current', current ? 'true' : 'false');
            c.btn.title = current ? (edited ? 'Your protocol started from this preset and has been edited. Click to reload the original.' : 'This preset is loaded.') : 'Load this protocol and its phantom';
            c.badge.hidden = !current;
            c.badge.textContent = edited ? 'edited' : 'loaded';
            c.badge.className = 'badge ' + (edited ? 'badge-warn' : 'badge-accent');
        });
    }

    /* ---------- parameters ---------- */
    function paramRange(p) {
        let min = p.min, max = p.max;
        const v = p.value, sc = p.scale || 1;
        if (!(isFinite(min) && isFinite(max)) || min === null || max === null) {
            if (v > 0) { min = 0; max = 2 * v; } else if (v < 0) { min = 2 * v; max = 0; } else { min = 0; max = 10 * sc; }
        }
        min = Math.min(min, v); max = Math.max(max, v);
        if (!(max > min)) max = min + sc;
        return [min, max];
    }
    function paramStep(p, min, max) {
        if (p.step > 0) return p.step;
        const sc = p.scale || 1;
        let s = nice((max - min) / sc / 100) * sc;
        if (p.kind === 'none' && Number.isInteger(p.value) && Number.isInteger(min)) s = Math.max(1, Math.round(s));
        for (let k = 0; k < 2; k++) {
            const q = (p.value - min) / s;
            if (Math.abs(q - Math.round(q)) < 1e-6) return s;
            s /= 10;
        }
        return null;
    }
    /* The params to show. While the protocol fails to compile, a param
       whose own line has the error is missing from the failed program;
       keep its slider (from the last good program) but disable it, so
       the panel does not jump around while the student types. */
    function paramList() {
        const s = st(), prog = s.program, good = s.lastGoodProgram;
        if (prog && prog.ok) return prog.params || [];
        const cur = (prog && prog.params) || [], out = cur.slice();
        ((good && good.params) || []).forEach(function (g) {
            if (!cur.some(function (p) { return p.name === g.name; })) out.push(Object.assign({}, g, { broken: true }));
        });
        return out.sort(function (a, b) { return a.line - b.line; });
    }
    function renderParams() {
        const s = st(), prog = s.program;
        const params = paramList();
        const sig = params.map(function (p) { return [p.name, p.kind, p.unit, p.scale, p.min, p.max, p.step, p.description, !!p.broken].join('|'); }).join(';');
        if (sig !== T.paramSig) {
            T.paramSig = sig;
            T.sliders = {};
            T.params.textContent = '';
            if (!params.length) {
                T.params.appendChild(el('p', { class: 'note mb-0', html: 'This protocol has no <code>param</code> lines. Add one to get a slider, for example ' +
                    '<code>param DOSE = 185 MBq range 40 MBq .. 400 MBq "injected activity"</code>, and use <code>inject DOSE</code>.' }));
            }
            params.forEach(function (p) {
                const r = paramRange(p);
                const sl = W().slider({
                    label: p.name, min: r[0], max: r[1], step: paramStep(p, r[0], r[1]), value: p.value,
                    unit: p.unit || '', siPerUnit: p.scale || 1, hint: p.description || '',
                    onInput: function (v) { T.dragging = p.name; queueParam(p.name, v); },
                    onChange: function (v) { queueParam(p.name, v); flushParam(); T.dragging = null; }
                });
                const lineBtn = el('button', { type: 'button', class: 'linklike', title: 'Show this param line in the editor' }, 'line ' + p.line);
                lineBtn.addEventListener('click', function () { const q = currentParam(p.name); T.ed.focusAt(q ? q.line : p.line, 1); });
                if (p.broken) sl.setDisabled(true);
                const row = el('div', { class: 'pr-param' }, [sl, el('div', { class: 'pr-param-desc' }, [
                    el('span', { text: p.broken ? 'its line has an error' : (p.description || (p.kind === 'none' ? 'a plain number' : 'a ' + p.kind)) }), lineBtn])]);
                T.params.appendChild(row);
                T.sliders[p.name] = { slider: sl, line: lineBtn, range: r };
            });
        } else {
            params.forEach(function (p) {
                const o = T.sliders[p.name];
                if (!o) return;
                o.line.textContent = 'line ' + p.line;
                if (T.dragging === p.name) return;
                if (p.value < o.range[0] || p.value > o.range[1]) {
                    const r = paramRange(p); o.range = r; o.slider.setRange(r[0], r[1], paramStep(p, r[0], r[1]));
                }
                o.slider.set(p.value);
            });
        }
        const failing = prog && !prog.ok;
        T.params.classList.toggle('is-failing', !!failing);
    }
    function currentParam(name) {
        return paramList().find(function (p) { return p.name === name; }) || null;
    }
    function queueParam(name, v) {
        T.paramQueue = { name: name, v: v };
        if (!T.paramTimer) T.paramTimer = setTimeout(flushParam, PARAM_DEBOUNCE);
    }
    function flushParam() {
        if (T.paramTimer) { clearTimeout(T.paramTimer); T.paramTimer = null; }
        const q = T.paramQueue;
        T.paramQueue = null;
        if (!q || !PET.actions) return;
        T.ed.flush();
        PET.actions.setParam(q.name, q.v);
    }

    /* ---------- stats ---------- */
    function matchingAcq() {
        const s = st(), acq = s.acq, prog = s.program;
        if (!acq || !prog || !prog.ok || !acq.program) return null;
        if (acq.program !== prog && acq.program.source !== prog.source) return null;
        if (acq.phantomId && acq.phantomId !== s.phantomId) return null;
        return acq;
    }
    function renderStats() {
        const prog = goodProgram(), s = st();
        if (!prog) {
            T.statProto.update([['Protocol', 'none compiled yet']]);
            T.scanNote.textContent = '';
            T.statScan.hidden = true;
            return;
        }
        const iso = isotopeOf(prog), tr = tracerOf(prog), ps = prog.stats || {};
        const rows = [];
        rows.push({ label: 'Tracer', value: tr ? tr.label : 'none (solution)', hint: tr ? tr.name + ': ' + tr.target : 'A phantom filled with a solution of the isotope' });
        if (iso) rows.push({ label: 'Isotope, half-life', value: iso.label + ', ' + (iso.halfLife >= 600 ? U.fmtNum(iso.halfLife / 60, 4) + ' min' : U.fmtNum(iso.halfLife, 3) + ' s'), hint: iso.name + ': half of it decays in this time' });
        rows.push(['Injected dose', U.fmtActivity(prog.dose, 3) + ' (' + U.fmtNum(prog.dose / 37e6, 3) + ' mCi)']);
        rows.push(['Body weight', U.fmtNum(prog.weight, 4) + ' kg']);
        rows.push({ label: 'Uptake', hint: 'Injection to scan start', value: prog.scanStart > 0 ? fmtT(prog.scanStart) : (prog.scanStart === 0 ? 'none' : fmtT(prog.scanStart)) });
        rows.push(['Frames', prog.frames.length + (prog.dynamic ? ', dynamic' : ', static')]);
        rows.push(['Scan duration', fmtT(ps.scanDuration)]);
        rows.push({ label: 'Scan window', value: minutes(prog.scanStart) + ' to ' + minutes(prog.scanEnd) + ' min', hint: 'Minutes after the injection' });
        if (iso) {
            rows.push({ label: 'Left at scan start', value: pct(ps.decayAtStart) + ' (' + U.fmtActivity(prog.dose * ps.decayAtStart, 3) + ')',
                hint: 'Share of the injected activity not yet decayed when the first frame starts: exp(-lambda t)' });
            rows.push({ label: 'Decays during the scan', value: pct(ps.decayDuringScan), hint: 'Share of the activity present at scan start that decays before the scan ends' });
        }
        rows.push(['Energy window', U.fmtNum(prog.energy.lo, 4) + ' to ' + U.fmtNum(prog.energy.hi, 4) + ' keV']);
        rows.push({ label: 'Coincidence window', value: U.fmtTime(prog.coincidence, 3), hint: 'Total width of the timing window' });
        rows.push({ label: 'Time of flight', value: (prog.tof.on ? 'on, ' : 'off, ') + U.fmtTime(prog.tof.ctr, 3), hint: 'Coincidence timing resolution (FWHM)' });
        if (prog.tof.on) {
            const fwhm = PET.const.C_MM_PER_S * prog.tof.ctr / 2;
            rows.push({ label: 'TOF places events to', value: Math.round(fwhm) + ' mm FWHM', hint: 'Position uncertainty along the line = c x timing resolution / 2' });
        }
        rows.push(['Mode', prog.acqMode === '2D' ? '2D, septa in' : '3D, septa out']);
        T.statProto.update(rows);

        // last scan
        const acq = matchingAcq();
        T.statScan.hidden = false;
        if (s.scanning) {
            T.scanNote.textContent = 'Scanning this protocol now...';
            T.statScan.update(scanRows(null));
        } else if (acq && acq.totals) {
            const tot = acq.totals, stt = acq.stats || {};
            const sf = isFinite(stt.scatterFraction) ? stt.scatterFraction : (tot.trues + tot.scatter > 0 ? tot.scatter / (tot.trues + tot.scatter) : 0);
            const all = tot.trues + tot.scatter + tot.randoms;
            const rf = isFinite(stt.randomsFraction) ? stt.randomsFraction : (all > 0 ? tot.randoms / all : 0);
            T.scanNote.textContent = (s.stale ? 'From the last scan, before your latest change' : 'From the last scan') + ', of the ' + phantomLabel(acq.phantomId, acq.phantomOpts || s.phantomOpts) + ' phantom.';
            T.statScan.update(scanRows({ tot: tot, sf: sf, rf: rf }));
        } else {
            T.scanNote.textContent = s.program && !s.program.ok ? 'Fix the errors to scan this protocol.' : 'No scan of this protocol yet: press Acquire, or wait for the automatic re-scan.';
            T.statScan.hidden = true;
        }
    }
    function scanRows(d) {
        const v = function (f) { return d ? f() : '...'; };
        return [
            { label: 'Trues', value: v(function () { return U.fmtCounts(d.tot.trues); }), hint: 'Both photons from one annihilation, unscattered' },
            { label: 'Scatter', value: v(function () { return U.fmtCounts(d.tot.scatter); }), hint: 'At least one photon scattered on the way out' },
            { label: 'Randoms', value: v(function () { return U.fmtCounts(d.tot.randoms); }), hint: 'Two photons from different annihilations inside the coincidence window' },
            { label: 'NEC', value: v(function () { return U.fmtCounts(d.tot.nec); }), hint: 'Noise-equivalent counts: T squared / (T + S + R)' },
            { label: 'Scatter fraction', value: v(function () { return pct(d.sf); }), hint: 'S / (T + S)' },
            { label: 'Randoms fraction', value: v(function () { return pct(d.rf); }), hint: 'R / (T + S + R)' }
        ];
    }

    /* ---------- timeline ---------- */
    function renderTimeline() {
        const prog = goodProgram(), iso = isotopeOf(prog);
        const show = !!(prog && iso && prog.frames && prog.frames.length);
        T.tlEmpty.hidden = show;
        T.tlBox.hidden = !show;
        if (!show) return;
        const s = st();
        const lam = Math.LN2 / iso.halfLife;
        const s0 = prog.scanStart, s1 = prog.scanEnd;
        const lo = Math.min(0, s0), span = Math.max(1, s1 - lo);
        const pad = Math.max(span * 0.06, 10);
        const xlo = lo < 0 ? lo - pad : 0, xhi = s1 + pad;
        const N = 500, x = [], y = [];
        if (xlo < 0) { x.push(xlo / 60); y.push(NaN); }
        for (let i = 0; i < N; i++) { const t = xhi * i / (N - 1); x.push(t / 60); y.push(100 * Math.exp(-lam * t)); }
        const isoCol = ISO_COLOR[iso.id] || 'var(--c1)';
        T.legCurve.style.color = color(isoCol);
        const solution = !prog.tracer;
        const markers = [];
        if (Math.abs(s0) < 1e-9) markers.push({ x: 0, label: solution ? 'fill = scan start' : 'injection = scan start', color: 'var(--accent)' });
        else {
            markers.push({ x: 0, label: solution ? 'phantom filled' : 'injection' });
            markers.push({ x: s0 / 60, label: 'scan start', color: 'var(--accent)' });
        }
        markers.push({ x: s1 / 60, label: 'scan end', color: 'var(--accent)' });
        const left0 = Math.exp(-lam * Math.max(0, s0)), left1 = Math.exp(-lam * s1);
        const hlines = left0 < 0.995 ? [{ y: 100 * left0, label: U.fmtNum(100 * left0, 3) + ' % left at scan start', color: 'var(--muted)' }] : [];
        if (left0 - left1 > 0.08) hlines.push({ y: 100 * left1, label: U.fmtNum(100 * left1, 3) + ' % at scan end', color: 'var(--muted)' });
        T.tlPlot.setTitle('');
        T.tlPlot.draw([{ x: x, y: y, color: isoCol, label: iso.label + ' activity left', width: 2.25 }], {
            xlim: [xlo / 60, xhi / 60], ylim: [0, 105], markers: markers, hlines: hlines, legend: false,
            yfmt: function (v) { return U.fmtNum(v, 3) + ' %'; }
        });
        const acq = matchingAcq();
        const curFrame = prog.dynamic && acq ? Math.min(s.frame || 0, prog.frames.length - 1) : -1;
        T.legCur.hidden = curFrame < 0;
        const bands = prog.frames.map(function (f, i) {
            return { x0: f.t0 / 60, x1: f.t1 / 60, alpha: i === curFrame ? 0.42 : (prog.dynamic && i % 2 ? 0.26 : 0.15), edge: prog.dynamic && i > 0, edgeAlpha: 0.35 };
        });
        T.tlBands.set({
            bands: bands,
            draw: function (ctx, L) {
                if (!(s0 > 0)) return;
                const xa = L.X(0), xb = L.X(s0 / 60), yy = Math.round(L.top + L.ph - 14) + 0.5;
                const c = U.cssVar('--muted', '#666');
                ctx.save();
                ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.25;
                ctx.beginPath(); ctx.moveTo(xa + 1, yy); ctx.lineTo(xb - 1, yy); ctx.stroke();
                if (xb - xa > 14) {
                    ctx.beginPath(); ctx.moveTo(xa + 1, yy); ctx.lineTo(xa + 7, yy - 3.5); ctx.lineTo(xa + 7, yy + 3.5); ctx.closePath(); ctx.fill();
                    ctx.beginPath(); ctx.moveTo(xb - 1, yy); ctx.lineTo(xb - 7, yy - 3.5); ctx.lineTo(xb - 7, yy + 3.5); ctx.closePath(); ctx.fill();
                }
                ctx.restore();
                const label = 'uptake ' + fmtT(s0);
                ctx.font = '600 11px ' + U.cssVar('--font-sans', 'sans-serif');
                const tw = ctx.measureText(label).width;
                if (xb - xa > tw + 12) haloText(ctx, label, (xa + xb) / 2, yy - 4, c, 'center');
                else haloText(ctx, label, Math.max(xa, xb - tw - 4), yy - 4, c, 'left');
            }
        });

        // frames in words
        const groups = frameGroups(prog.frames);
        const words = groups.map(function (g) { return g.n > 1 ? g.n + ' x ' + U.fmtTime(g.dur, 3) : U.fmtTime(g.dur, 3); });
        T.framesLine.textContent = '';
        T.framesLine.appendChild(el('span', { text: (prog.dynamic ? prog.frames.length + ' frames: ' : 'One frame: ') }));
        T.framesLine.appendChild(el('code', { text: words.join(', ') }));
        T.framesLine.appendChild(el('span', { text: ', from ' + minutes(s0) + ' to ' + minutes(s1) + ' min after the ' + (solution ? 'fill' : 'injection') +
            '. The isotope decays by ' + pct(prog.stats.decayDuringScan) + ' while the scanner counts.' }));

        // counts per frame
        const rate = T.countMode.get() === 'rate';
        const ready = acq && !s.scanning && acq.frames && acq.frames.every(function (F) { return F.counts; });
        T.countsBox.classList.toggle('is-stale', !!(s.scanning && T.cntDrawn));
        if (!ready) {
            if (!s.scanning || !T.cntDrawn) { T.cntPlot.el.hidden = true; T.cntEmpty.hidden = false; T.cntDrawn = false; }
            if (s.scanning && !T.cntDrawn) T.cntEmpty.textContent = 'Scanning...';
            else T.cntEmpty.textContent = s.program && !s.program.ok ? 'Fix the errors in the protocol to scan it.' : 'No scan of this protocol yet. Press Acquire, or wait for the automatic re-scan.';
            return;
        }
        T.cntPlot.el.hidden = false; T.cntEmpty.hidden = true; T.cntDrawn = true;
        T.countsTitle.textContent = rate ? 'Coincidence rate in each frame' : 'Coincidences recorded in each frame';
        const kinds = [['trues', 'Trues', 'var(--ev-true)'], ['scatter', 'Scatter', 'var(--ev-scatter)'], ['randoms', 'Randoms', 'var(--ev-random)']];
        const series = kinds.map(function (k) {
            const xs = [], ys = [];
            acq.frames.forEach(function (F) {
                const v = (F.counts[k[0]] || 0) / (rate ? Math.max(1e-9, F.t1 - F.t0) : 1);
                xs.push(F.t0 / 60, F.t0 / 60, F.t1 / 60, F.t1 / 60); ys.push(0, v, v, 0);
            });
            return { x: xs, y: ys, label: k[1], color: k[2], width: 1.75, fill: 0.1 };
        });
        T.cntPlot.draw(series, {
            xlim: [xlo / 60, xhi / 60], includeZero: true, legend: true,
            yfmt: rate ? function (v) { return U.fmtCounts(v) + '/s'; } : function (v) { return U.fmtCounts(v); }
        });
        T.cntBands.set({ bands: prog.frames.map(function (f, i) { return { x0: f.t0 / 60, x1: f.t1 / 60, alpha: i === curFrame ? 0.3 : 0.07 }; }) });
    }

    /* ---------- how the scanner listens ---------- */
    function renderListen() {
        const prog = goodProgram(), SC = PET.scanner;
        if (!SC || !SC.energy || !SC.timing) {
            T.eNote.textContent = 'The scanner model (js/scanner.js) did not load.';
            return;
        }
        const lo = prog ? prog.energy.lo : 435, hi = prog ? prog.energy.hi : 650;
        if (!T.spectrum) {
            const E = linspace(150, 750, 301), pk = new Float64Array(E.length), sc = new Float64Array(E.length);
            for (let i = 0; i < E.length; i++) { const sp = SC.energy.spectrum(E[i]); pk[i] = 100 * sp.photopeak; sc[i] = 100 * sp.scatter; }
            T.spectrum = { E: E, pk: pk, sc: sc };
        }
        const sp = T.spectrum;
        T.ePlot.draw([
            { x: sp.E, y: sp.pk, label: 'Unscattered (photopeak)', color: 'var(--ev-true)', fill: 0.1 },
            { x: sp.E, y: sp.sc, label: 'Scattered once in the patient', color: 'var(--ev-scatter)', fill: 0.1 }
        ], {
            xlim: [150, 750], includeZero: true, legend: true,
            markers: [
                { x: lo, label: U.fmtNum(lo, 4) + ' keV', color: 'var(--accent)', dash: false },
                { x: hi, label: U.fmtNum(hi, 4) + ' keV', color: 'var(--accent)', dash: false },
                { x: 511, label: '511 keV' }
            ]
        });
        T.eBands.set({ bands: [{ x0: lo, x1: hi, alpha: 0.12 }] });
        const pa = SC.energy.photopeakAcceptance(lo, hi), sa = SC.energy.scatterAcceptance(lo, hi);
        T.eStats.textContent = '';
        tile(T.eStats, 'Photopeak kept', pct(pa), 'Share of unscattered 511 keV photons inside the window');
        tile(T.eStats, 'Scatter kept', pct(sa), 'Share of once-scattered photons inside the window');
        tile(T.eStats, 'True pairs kept', pct(pa * pa), 'Both photons of a pair inside the window: the photopeak share squared');
        const sigma = SC.energy.sigma(511) * U.FWHM_PER_SIGMA;
        T.eNote.textContent = 'The crystals measure 511 keV with about ' + Math.round(sigma) + ' keV FWHM, so the photopeak is a broad hump. ' +
            'A photon that scatters loses energy (down to 170 keV for a full backscatter), so the lower level of the window is what rejects scatter, ' +
            'but raising it also cuts into the photopeak. A coincidence needs both photons inside the window.';

        // coincidence window
        const tau = prog ? prog.coincidence : 4.5e-9, ctr = prog ? prog.tof.ctr : 400e-12;
        const s = linspace(-160, 160, 321);
        const acc = function (t) { const out = new Float64Array(s.length); for (let i = 0; i < s.length; i++) out[i] = 100 * SC.timing.trueAcceptance(s[i], t, ctr); return out; };
        const tauCmp = tau <= 2.5e-9 ? 4.5e-9 : 1.5e-9;
        const half = PET.const.C_MM_PER_S * tau / 4;
        const markers = [];
        if (half < 160) { markers.push({ x: -half, label: 'window edge', color: 'var(--accent)' }, { x: half, label: 'window edge', color: 'var(--accent)' }); }
        T.tPlot.draw([
            { x: s, y: acc(tau), label: 'This protocol, ' + U.fmtTime(tau, 3), color: 'var(--ev-true)', width: 2.25 },
            { x: s, y: acc(tauCmp), label: 'For comparison, ' + U.fmtTime(tauCmp, 3), color: 'var(--muted)', dash: true, width: 1.5 }
        ], { xlim: [-160, 160], ylim: [0, 105], markers: markers, legend: true, yfmt: function (v) { return U.fmtNum(v, 3) + ' %'; } });
        T.tBands.set({ bands: [] });
        T.tStats.textContent = '';
        tile(T.tStats, 'At the middle', pct(SC.timing.trueAcceptance(0, tau, ctr)), 'True events from the middle of the line kept by the window');
        tile(T.tStats, '100 mm out', pct(SC.timing.trueAcceptance(100, tau, ctr)), 'True events from 100 mm off the middle of the line kept by the window');
        tile(T.tStats, 'FOV edge', pct(SC.timing.trueAcceptance(160, tau, ctr)), 'True events from the edge of the field of view, 160 mm out, kept by the window');
        const cross = 2 * 160 / PET.const.C_MM_PER_S;
        T.tNote.textContent = 'An annihilation s mm from the middle of its line sends one photon 2s mm further than the other, so they arrive 2s/c apart: up to ' +
            U.fmtTime(cross, 3) + ' at the edge of the 320 mm field of view. A window (total width) narrower than about ' + U.fmtTime(2 * cross, 2) +
            ' therefore loses true events from the edge, softened by the ' + U.fmtTime(ctr, 3) + ' timing resolution. ' +
            (half >= 160 ? 'This window reaches ' + Math.round(half) + ' mm each way, beyond the field of view. ' : 'This window reaches only ' + Math.round(half) + ' mm each way. ') +
            'Randoms grow in proportion to the window width, so the window is a trade-off.';
    }
    function tile(host, label, value, hint) {
        host.appendChild(el('div', { class: 'stat', title: hint || null }, [el('div', { class: 'stat-label', text: label }), el('div', { class: 'stat-value', text: value })]));
    }

    PET.ui.registerTab({
        id: 'protocol', title: 'Protocol', order: 30,
        mount: mount,
        onShow: function () {
            T.visible = true;
            if (T.ed) { T.ed.fitHeight(); T.ed.render(); }
            renderViews();
        },
        onHide: function () {
            T.visible = false;
            if (T.ed) T.ed.flush();
            flushParam();
        }
    });

    // exposed for tests
    PET.ui._protocol = { rewriteStatement: rewriteStatement, mapOffset: mapOffset, frameGroups: frameGroups };

})(typeof window !== 'undefined' ? window : globalThis);
