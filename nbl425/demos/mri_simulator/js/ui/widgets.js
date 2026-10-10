/* ============================================================
   MRI Simulator, shared UI widgets (MRI.ui.w)

   Small, dependency-free building blocks that every tab uses, so
   the simulator looks and behaves the same everywhere:

     concept     the "idea, equation, try this" card that opens each tab
     slider      labelled range input with a typed value readout and units
     select      labelled drop-down
     toggle      on/off switch
     segmented   a row of mutually exclusive buttons (radio group)
     imageView   an image in a dark well: HiDPI, physical aspect ratio,
                 window/level by dragging, hover readout, colour bar
     plot        a lightweight line plot with axes, ticks, legend,
                 markers and a hover crosshair, redrawn on theme change
     statTable   two-column table of labelled numbers
     toast       a transient message in the corner
   plus a few helpers (button, badge, legend, details, callout,
   errorCard, empty).

   Conventions shared by all of them:
   - Every factory returns a real DOM element (or, for imageView and
     plot, an object whose .el is the element), so tabs can place it
     wherever they like.
   - Values passed in and out of callbacks are in SI units. A slider
     shows them in display units: display = SI * scale, so a TE slider
     in milliseconds has scale 1000 (or siPerUnit 0.001, which is the
     form the DSL's program.params carry as `scale`).
   - Programmatic set() never fires the user callbacks, so a tab can
     sync a control to the state without creating a feedback loop.
   - Strings given as body / formula / tryThis / statTable values are
     inserted as HTML where noted. They come from our own source code,
     never from user input.
   - Styling lives in style.css (classes documented at its top). The
     widgets only use those classes, so they follow the theme.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const U = MRI.util;
    const doc = root.document;

    let uid = 0;
    function nextId(prefix) { uid += 1; return 'mri-' + prefix + '-' + uid; }

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }

    /* Turn a string (treated as trusted HTML) or a Node into a Node. */
    function htmlNode(content, tag, cls) {
        if (content === undefined || content === null || content === false) return null;
        if (content instanceof root.Node) return content;
        return el(tag || 'div', { class: cls, html: String(content) });
    }

    function call(fn) {
        if (typeof fn !== 'function') return undefined;
        try { return fn.apply(null, Array.prototype.slice.call(arguments, 1)); }
        catch (e) { if (root.console) root.console.error('[MRI.ui.w] callback failed:', e); return undefined; }
    }

    /* Normalise option lists: accept ['a', 'b'], [{value, label}], or
       [[value, label]]. Values keep their type (numbers stay numbers). */
    function normOptions(options) {
        return (options || []).map(function (o) {
            if (Array.isArray(o)) return { value: o[0], label: String(o[1] !== undefined ? o[1] : o[0]) };
            if (o !== null && typeof o === 'object') {
                return { value: o.value, label: String(o.label !== undefined ? o.label : o.value), title: o.title,
                    disabled: !!o.disabled, group: o.group };
            }
            return { value: o, label: String(o) };
        });
    }

    /* Observe size changes of an element and call fn once per animation
       frame at most. Canvases measured while their tab is hidden have
       zero width; the observer fires again when the tab is shown, so
       widgets re-fit themselves without the tab having to ask. */
    function watchSize(target, fn) {
        let pending = false, lastW = -1;
        // Only a change of width matters: the widgets set their own height,
        // and reacting to that would redraw twice for nothing.
        const run = function () {
            const wNow = target.clientWidth;
            if (pending || wNow === lastW) return;
            pending = true;
            (root.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () {
                pending = false; lastW = target.clientWidth; fn();
            });
        };
        if (root.ResizeObserver) {
            const ro = new root.ResizeObserver(run);
            ro.observe(target);
            return function () { ro.disconnect(); };
        }
        root.addEventListener('resize', run);
        return function () { root.removeEventListener('resize', run); };
    }

    /* Number of decimals needed to show a display step exactly
       (step 0.5 -> 1, step 10 -> 0, step 0.01 -> 2). */
    function decimalsFor(step) {
        if (!(step > 0) || !isFinite(step)) return null;
        let d = 0;
        while (d < 6 && Math.abs(Math.round(step * Math.pow(10, d)) - step * Math.pow(10, d)) > 1e-6 * Math.pow(10, d)) d++;
        return d;
    }

    // Round off binary noise from unit conversion (0.09 * 1000 = 90.00000000000001).
    function clean(x) { return isFinite(x) ? Number(x.toPrecision(12)) : x; }

    /* ---------- concept card ----------
       concept({title, body, formula, tryThis, open = true, eyebrow = 'Concept'})
       body, formula: HTML strings or Nodes. tryThis: array of HTML strings,
       Nodes, or {html, run, label} where run() is a "do it" action (for
       example, set TE to 20 ms) shown as a small button after the text.
       Returns a <details class="concept"> so students can fold it away
       once they have read it. */
    function concept(o) {
        o = o || {};
        const card = el('details', { class: 'concept' });
        if (o.open !== false) card.open = true;
        const summary = el('summary', { class: 'concept-head' }, [
            el('span', { class: 'concept-eyebrow', text: o.eyebrow || 'Concept' }),
            el('span', { class: 'concept-title', text: o.title || '' })
        ]);
        card.appendChild(summary);
        const main = el('div', { class: 'concept-main' });
        const body = htmlNode(o.body, 'div', 'concept-body');
        if (body) { if (!body.classList.contains('concept-body')) body.classList.add('concept-body'); main.appendChild(body); }
        const formula = htmlNode(o.formula, 'div', 'concept-formula');
        if (formula) { formula.classList.add('concept-formula'); main.appendChild(formula); }
        const content = el('div', { class: 'concept-content' }, [main]);
        const items = o.tryThis || [];
        if (items.length) {
            const list = el('ol', { class: 'concept-try-list' });
            items.forEach(function (it) {
                const li = el('li');
                if (it && typeof it === 'object' && !(it instanceof root.Node)) {
                    li.appendChild(el('span', { html: it.html || it.text || '' }));
                    if (typeof it.run === 'function') {
                        li.appendChild(doc.createTextNode(' '));
                        li.appendChild(el('button', { class: 'btn btn-xs concept-run', type: 'button',
                            onclick: function () { call(it.run); } }, it.label || 'Do it'));
                    }
                } else {
                    const n = htmlNode(it, 'span');
                    if (n) li.appendChild(n);
                }
                list.appendChild(li);
            });
            content.appendChild(el('div', { class: 'concept-try' }, [
                el('div', { class: 'concept-try-title', text: o.tryTitle || 'Try this' }), list
            ]));
        } else {
            content.classList.add('concept-content-single');
        }
        card.appendChild(content);
        return card;
    }

    /* ---------- slider ----------
       slider({label, min, max, step, value, unit, scale, siPerUnit, format,
               onInput, onChange, log, hint, id, disabled})
       min, max, step, value are SI. The track and the typed readout work
       in display units = SI * scale (scale = display units per SI unit;
       give siPerUnit instead to pass a DSL param's own `scale`). `format`
       (SI -> string) replaces the editable readout with a read-only one.
       `log: true` spaces the track logarithmically (for T1, T2 ranges).
       onInput fires while dragging, onChange when the value is committed
       (release, a keyboard step, or typing a number and pressing Enter).
       Returns the row element with get(), set(v), setRange(min, max, step),
       setDisabled(bool), and .input (the range input). */
    function slider(o) {
        o = o || {};
        const scale = o.siPerUnit ? 1 / o.siPerUnit : (o.scale || 1);
        const id = o.id || nextId('slider');
        let min = +o.min, max = +o.max, step = o.step > 0 ? +o.step : null;
        if (!isFinite(min)) min = 0;
        if (!isFinite(max) || max <= min) max = min + 1;
        const unit = o.unit || '';
        const useLog = !!o.log && min > 0;
        const LOGN = 1000;
        let cur = isFinite(o.value) ? +o.value : min;
        let editing = false;        // the student is typing in the number box: do not overwrite it

        const row = el('div', { class: 'ctl ctl-slider' });
        const label = el('label', { class: 'ctl-label', for: id, text: o.label || '' });
        if (o.hint) label.title = o.hint;
        const input = el('input', { type: 'range', class: 'range', id: id });
        let readout, numBox = null;
        if (typeof o.format === 'function') {
            readout = el('output', { class: 'ctl-value', for: id });
        } else {
            numBox = el('input', { type: 'text', class: 'ctl-num', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false',
                'aria-label': (o.label || 'value') + (unit ? ' in ' + unit : '') });
            readout = el('span', { class: 'ctl-value' }, [numBox, unit ? el('span', { class: 'ctl-unit', text: unit }) : null]);
        }
        row.appendChild(label);
        row.appendChild(readout);
        row.appendChild(input);

        function clampSnap(v) {
            v = U.clamp(v, min, max);
            if (step && !useLog) v = min + Math.round((v - min) / step) * step;
            else if (step && useLog) v = Math.round(v / step) * step;
            return clean(U.clamp(v, min, max));
        }
        function toTrack(v) {
            if (useLog) return Math.round(LOGN * Math.log(v / min) / Math.log(max / min));
            return clean(v * scale);
        }
        function fromTrack(x) {
            if (useLog) return min * Math.pow(max / min, x / LOGN);
            return x / scale;
        }
        let dec = decimalsFor(step ? step * scale : null);
        function displayNumber(v) {
            const d = clean(v * scale);
            if (dec !== null) return d.toFixed(dec);
            return U.fmtNum(d, 4);
        }
        function text(v) {
            return typeof o.format === 'function' ? String(o.format(v)) : displayNumber(v) + (unit ? ' ' + unit : '');
        }
        function configureTrack() {
            if (useLog) { input.min = 0; input.max = LOGN; input.step = 1; }
            else {
                input.min = clean(min * scale); input.max = clean(max * scale);
                input.step = step ? clean(step * scale) : 'any';
            }
        }
        function paint() {
            const pos = useLog ? Math.log(cur / min) / Math.log(max / min) : (cur - min) / (max - min);
            input.style.setProperty('--fill', (100 * U.clamp(pos, 0, 1)).toFixed(2) + '%');
            input.setAttribute('aria-valuetext', text(cur));
            if (numBox) { if (!editing) numBox.value = displayNumber(cur); }
            else readout.textContent = text(cur);
        }
        function sync() { input.value = toTrack(cur); paint(); }

        configureTrack();
        cur = clampSnap(cur);
        sync();

        input.addEventListener('input', function () {
            cur = clampSnap(fromTrack(+input.value));
            paint();
            call(o.onInput, cur);
        });
        input.addEventListener('change', function () {
            cur = clampSnap(fromTrack(+input.value));
            paint();
            call(o.onChange, cur);
        });
        if (numBox) {
            const commit = function () {
                const raw = String(numBox.value).trim().replace(',', '.');
                const d = parseFloat(raw);
                if (!isFinite(d)) { editing = false; numBox.value = displayNumber(cur); return; }
                const v = clampSnap(d / scale);
                const changed = v !== cur;
                editing = false;
                cur = v; sync();
                if (changed) { call(o.onInput, cur); call(o.onChange, cur); }
            };
            numBox.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); numBox.select(); }
                else if (e.key === 'Escape') { editing = false; numBox.value = displayNumber(cur); numBox.blur(); }
            });
            numBox.addEventListener('input', function () { editing = true; });
            numBox.addEventListener('blur', commit);
            numBox.addEventListener('focus', function () { numBox.select(); });
        }
        if (o.disabled) { input.disabled = true; if (numBox) numBox.disabled = true; row.classList.add('is-disabled'); }

        row.input = input;
        row.get = row.getValue = function () { return cur; };
        row.set = row.setValue = function (v) { if (isFinite(v)) { cur = clampSnap(+v); sync(); } return row; };
        row.setRange = function (lo, hi, st) {
            if (isFinite(lo)) min = +lo;
            if (isFinite(hi)) max = +hi;
            if (max <= min) max = min + 1;
            if (st !== undefined) { step = st > 0 ? +st : null; dec = decimalsFor(step ? step * scale : null); }
            configureTrack(); cur = clampSnap(cur); sync();
            return row;
        };
        row.setDisabled = function (b) {
            input.disabled = !!b; if (numBox) numBox.disabled = !!b;
            row.classList.toggle('is-disabled', !!b);
            return row;
        };
        row.setLabel = function (t) { label.textContent = t; return row; };
        return row;
    }

    /* ---------- select ----------
       select({label, options, value, onChange, id, hint, inline})
       options: strings, [value, label] pairs or {value, label, disabled, group}.
       onChange receives the option's value with its original type.
       Returns the wrapper with get(), set(v), setOptions(options, value),
       and .select. Without a label it is still labelled for screen
       readers via aria-label when `ariaLabel` is given. */
    function select(o) {
        o = o || {};
        const id = o.id || nextId('select');
        const sel = el('select', { class: 'select', id: id });
        if (!o.label && o.ariaLabel) sel.setAttribute('aria-label', o.ariaLabel);
        let opts = [];
        function fill(options, value) {
            opts = normOptions(options);
            sel.textContent = '';
            let group = null, groupName = null;
            opts.forEach(function (op, i) {
                const node = el('option', { value: String(i), text: op.label, title: op.title, disabled: op.disabled });
                if (op.group) {
                    if (op.group !== groupName) { group = el('optgroup', { label: op.group }); sel.appendChild(group); groupName = op.group; }
                    group.appendChild(node);
                } else { group = null; groupName = null; sel.appendChild(node); }
            });
            setVal(value);
        }
        function indexOf(v) {
            for (let i = 0; i < opts.length; i++) if (opts[i].value === v) return i;
            for (let i = 0; i < opts.length; i++) if (String(opts[i].value) === String(v)) return i;
            return -1;
        }
        function setVal(v) { const i = indexOf(v); sel.value = String(i >= 0 ? i : 0); }
        fill(o.options, o.value);
        sel.addEventListener('change', function () {
            const op = opts[+sel.value];
            if (op) call(o.onChange, op.value);
        });
        let wrap;
        if (o.label) {
            wrap = el('div', { class: 'ctl ctl-select' + (o.inline ? ' ctl-inline' : '') }, [
                el('label', { class: 'ctl-label', for: id, text: o.label, title: o.hint }), sel
            ]);
        } else {
            wrap = el('div', { class: 'ctl ctl-select ctl-bare' }, [sel]);
        }
        wrap.select = sel;
        wrap.get = wrap.getValue = function () { const op = opts[+sel.value]; return op ? op.value : undefined; };
        wrap.set = wrap.setValue = function (v) { setVal(v); return wrap; };
        wrap.setOptions = function (options, value) { fill(options, value === undefined ? wrap.get() : value); return wrap; };
        wrap.setDisabled = function (b) { sel.disabled = !!b; return wrap; };
        return wrap;
    }

    /* ---------- toggle (switch) ----------
       toggle({label, checked, onChange, hint, id}). A real checkbox with
       role="switch", so it is keyboard and screen-reader friendly.
       Returns the <label> with get(), set(bool), setDisabled(bool), .input. */
    function toggle(o) {
        o = o || {};
        const id = o.id || nextId('toggle');
        const input = el('input', { type: 'checkbox', id: id, role: 'switch' });
        input.checked = !!o.checked;
        const lab = el('label', { class: 'toggle', for: id, title: o.hint }, [
            input, el('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
            el('span', { class: 'toggle-label', text: o.label || '' })
        ]);
        input.addEventListener('change', function () { call(o.onChange, input.checked); });
        lab.input = input;
        lab.get = lab.getValue = function () { return input.checked; };
        lab.set = lab.setValue = function (b) { input.checked = !!b; return lab; };
        lab.setDisabled = function (b) { input.disabled = !!b; lab.classList.toggle('is-disabled', !!b); return lab; };
        return lab;
    }

    /* ---------- segmented control ----------
       segmented({options, value, onChange, label, ariaLabel, size: 'sm'})
       A radio group drawn as joined buttons. Arrow keys move the
       selection (and fire onChange), Home/End jump to the ends.
       With a visible `label` it is wrapped in a .ctl row.
       Returns the element with get(), set(v), setDisabled(bool). */
    function segmented(o) {
        o = o || {};
        const opts = normOptions(o.options);
        const group = el('div', { class: 'seg' + (o.size === 'sm' ? ' seg-sm' : ''), role: 'radiogroup' });
        let cur = o.value !== undefined ? o.value : (opts[0] && opts[0].value);
        const btns = opts.map(function (op, i) {
            const b = el('button', { type: 'button', role: 'radio', title: op.title, 'data-index': i, disabled: op.disabled }, op.label);
            b.addEventListener('click', function () { choose(i, true); });
            b.addEventListener('keydown', function (e) {
                let j = null;
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % opts.length;
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + opts.length) % opts.length;
                else if (e.key === 'Home') j = 0;
                else if (e.key === 'End') j = opts.length - 1;
                if (j === null) return;
                e.preventDefault();
                choose(j, true);
                btns[j].focus();
            });
            group.appendChild(b);
            return b;
        });
        function paint() {
            let any = false;
            btns.forEach(function (b, i) {
                const on = opts[i].value === cur;
                any = any || on;
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
            });
            if (!any && btns[0]) btns[0].tabIndex = 0;
        }
        function choose(i, fire) {
            const v = opts[i].value;
            const changed = v !== cur;
            cur = v; paint();
            if (fire && changed) call(o.onChange, v);
        }
        paint();
        let wrap = group;
        if (o.label) {
            const lid = nextId('seglabel');
            group.setAttribute('aria-labelledby', lid);
            wrap = el('div', { class: 'ctl ctl-seg' }, [el('span', { class: 'ctl-label', id: lid, text: o.label }), group]);
        } else if (o.ariaLabel) group.setAttribute('aria-label', o.ariaLabel);
        wrap.group = group;
        wrap.get = wrap.getValue = function () { return cur; };
        wrap.set = wrap.setValue = function (v) { cur = v; paint(); return wrap; };
        wrap.setDisabled = function (b) { btns.forEach(function (x) { x.disabled = !!b; }); return wrap; };
        return wrap;
    }

    /* ---------- image view ----------
       imageView(container, {title, cmap = 'gray', wl = true, colorbar = false,
                             unit, empty, maxHeight, readout = true,
                             readoutFormat(ix, iy, value) -> string, smooth})
       Appends a dark "well" to container and returns
         { el, canvas, setData(data, nx, ny, opts), onHover(fn), onClick(fn),
           setOverlay(fn), redraw(), resetWindow(), getWindow(), setWindow(min, max),
           setTitle(t), clear(message), info() }.
       setData(data, nx, ny, {min, max, cmap, aspect, resetWindow, fovX, fovY}):
         data is row-major (index iy*nx + ix); aspect is the PHYSICAL
         height/width (fovY/fovX), so a 256 x 128 matrix over a square
         FOV still shows as a square. Without aspect, pixels are square
         (or fovY/fovX is used when both are given). With fovX and fovY
         (metres) the hover readout and payload also give the position
         x, y in metres, pixel i at (i - floor(n/2)) * fov / n.
         min/max set the default window; otherwise it comes from the
         0.5 and 99.5 percentiles. NaN pixels are drawn transparent (the
         dark well shows through), which is how to mark "no data". A window the user has dragged is kept
         across setData calls (so it survives playback) until a
         double-click, resetWindow(), a colour-map change or a change of
         matrix size.
       Window/level: drag horizontally to change the width (right =
       wider, less contrast) and vertically to change the level (up =
       brighter). Double-click resets.
       onHover(fn): fn({ix, iy, value, nx, ny, x?, y?, event}) or fn(null) on leave.
       onClick(fn): same payload, fired on a click that did not drag.
       setOverlay(fn): fn(ctx, geom) runs after every draw, in CSS pixels,
         geom = {w, h, nx, ny, sx, sy, toCanvas(ix, iy) -> {x, y}} where
         (ix, iy) are pixel-centre coordinates in matrix units. */
    function imageView(container, o) {
        o = o || {};
        const wrap = el('figure', { class: 'well imageview' });
        const titleEl = el('figcaption', { class: 'well-title' }, [el('span', { class: 'iv-title-text', text: o.title || '' })]);
        if (!o.title) titleEl.hidden = true;
        const stage = el('div', { class: 'iv-stage' });
        const canvas = el('canvas', { class: 'iv-canvas', role: 'img', 'aria-label': o.title || 'Image' });
        const wlBadge = el('div', { class: 'iv-wl', hidden: true });
        const emptyEl = el('div', { class: 'iv-empty', text: o.empty || 'No data yet' });
        stage.appendChild(canvas); stage.appendChild(wlBadge); stage.appendChild(emptyEl);
        const readoutEl = el('div', { class: 'well-readout iv-readout' });
        let cbar = null, cbarCanvas = null, cbarMin = null, cbarMax = null;
        if (o.colorbar) {
            cbarCanvas = el('canvas', { class: 'iv-cbar-canvas', width: 256, height: 1, 'aria-hidden': 'true' });
            cbarMin = el('span', { class: 'iv-cbar-min' }); cbarMax = el('span', { class: 'iv-cbar-max' });
            cbar = el('div', { class: 'iv-cbar' }, [cbarMin, cbarCanvas, cbarMax]);
        }
        wrap.appendChild(titleEl); wrap.appendChild(stage);
        if (cbar) wrap.appendChild(cbar);
        if (o.readout !== false) wrap.appendChild(readoutEl);
        if (o.wl !== false) canvas.classList.add('wl');
        if (container) container.appendChild(wrap);

        const hint = o.wl !== false ? 'Drag: window/level · double-click: reset' : '';
        readoutEl.textContent = hint;

        const S = { data: null, nx: 0, ny: 0, aspect: null, cmap: o.cmap || 'gray', base: null, user: null,
            w: 0, h: 0, overlay: null, hover: [], click: [] };
        let wlEnabled = o.wl !== false;

        function autoWindow(data) {
            const lo = U.percentile(data, 0.5), hi = U.percentile(data, 99.5);
            const min = Math.min(0, lo);
            return { min: min, max: hi > min ? hi : min + 1 };
        }
        function win() { return S.user || S.base || { min: 0, max: 1 }; }

        function fit() {
            const avail = stage.clientWidth;
            if (!avail) return false;
            const aspect = S.aspect || (S.nx ? S.ny / S.nx : 1);
            const maxH = o.maxHeight || Math.max(160, Math.min(640, (root.innerHeight || 800) * 0.7));
            let w = avail, h = w * aspect;
            if (h > maxH) { h = maxH; w = h / aspect; }
            w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
            const r = U.setupCanvas(canvas, w, h);
            S.w = r.w; S.h = r.h;
            return r;
        }
        function geom() {
            const sx = S.w / (S.nx || 1), sy = S.h / (S.ny || 1);
            return { w: S.w, h: S.h, nx: S.nx, ny: S.ny, sx: sx, sy: sy,
                toCanvas: function (ix, iy) { return { x: (ix + 0.5) * sx, y: (iy + 0.5) * sy }; } };
        }
        function drawColorbar() {
            if (!cbar) return;
            const lut = U.colormapLUT(S.cmap);
            const cctx = cbarCanvas.getContext('2d');
            const img = cctx.createImageData(256, 1);
            for (let i = 0; i < 256; i++) {
                img.data[4 * i] = lut[3 * i]; img.data[4 * i + 1] = lut[3 * i + 1]; img.data[4 * i + 2] = lut[3 * i + 2]; img.data[4 * i + 3] = 255;
            }
            cctx.putImageData(img, 0, 0);
            const wv = win(), u = o.unit ? ' ' + o.unit : '';
            cbarMin.textContent = U.fmtNum(wv.min, 3) + u;
            cbarMax.textContent = U.fmtNum(wv.max, 3) + u;
        }
        /* Render through a per-view offscreen canvas at the matrix size,
           then scale up (nearest neighbour unless smooth). Unlike
           MRI.util.drawImage, a non-finite value (NaN) stays transparent, so
           "no data here" (for example k-space lines not acquired yet) shows
           the dark well rather than the colour of the lowest value. */
        let off = null;
        function paintPixels(ctx, wv) {
            const nx = S.nx, ny = S.ny, data = S.data;
            if (!off) off = doc.createElement('canvas');
            if (off.width !== nx) off.width = nx;
            if (off.height !== ny) off.height = ny;
            const octx = off.getContext('2d');
            const img = octx.createImageData(nx, ny), px = img.data;
            const lut = U.colormapLUT(S.cmap), lo = wv.min, span = (wv.max - wv.min) || 1;
            for (let i = 0, n = nx * ny; i < n; i++) {
                const v = data[i];
                if (!(v === v) || v === Infinity || v === -Infinity) continue;     // leave transparent
                let t = (v - lo) / span;
                t = t < 0 ? 0 : (t > 1 ? 1 : t);
                const li = Math.round(t * 255) * 3, j = 4 * i;
                px[j] = lut[li]; px[j + 1] = lut[li + 1]; px[j + 2] = lut[li + 2]; px[j + 3] = 255;
            }
            octx.putImageData(img, 0, 0);
            ctx.save();
            ctx.imageSmoothingEnabled = !!o.smooth;
            ctx.drawImage(off, 0, 0, nx, ny, 0, 0, S.w, S.h);
            ctx.restore();
        }
        function draw() {
            const r = fit();
            if (!r) return;
            const ctx = r.ctx;
            ctx.clearRect(0, 0, S.w, S.h);
            if (!S.data) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S.w, S.h); emptyEl.hidden = false; return; }
            emptyEl.hidden = true;
            const wv = win();
            paintPixels(ctx, wv);
            if (S.overlay) {
                ctx.save();
                try { S.overlay(ctx, geom()); }
                catch (e) { if (root.console) root.console.error('[imageView] overlay failed:', e); }
                ctx.restore();
            }
            drawColorbar();
        }
        function showWL() {
            if (!S.user) { wlBadge.hidden = true; return; }
            const wv = S.user;
            wlBadge.hidden = false;
            wlBadge.textContent = 'W ' + U.fmtNum(wv.max - wv.min, 3) + '  L ' + U.fmtNum((wv.max + wv.min) / 2, 3);
        }

        function setData(data, nx, ny, so) {
            so = so || {};
            if (!data || !nx || !ny) { S.data = null; draw(); return api; }
            const dimsChanged = nx !== S.nx || ny !== S.ny;
            const cmapChanged = so.cmap && so.cmap !== S.cmap;
            S.data = data; S.nx = nx; S.ny = ny;
            S.fovX = so.fovX > 0 ? so.fovX : null; S.fovY = so.fovY > 0 ? so.fovY : null;
            if (so.cmap) S.cmap = so.cmap;
            // Each call describes its own geometry: aspect, else fovY/fovX, else square pixels.
            S.aspect = so.aspect > 0 ? so.aspect : (S.fovX && S.fovY ? S.fovY / S.fovX : null);
            const auto = (so.min === undefined || so.max === undefined) ? autoWindow(data) : null;
            S.base = { min: so.min !== undefined ? so.min : auto.min, max: so.max !== undefined ? so.max : auto.max };
            if (!(S.base.max > S.base.min)) S.base.max = S.base.min + (Math.abs(S.base.min) || 1);
            if (so.resetWindow || dimsChanged || cmapChanged) S.user = null;
            showWL();
            draw();
            return api;
        }

        /* Pointer handling: one gesture is either a click or a
           window/level drag, decided by whether it moved more than 4 px. */
        function pixelAt(ev) {
            const rect = canvas.getBoundingClientRect();
            if (!S.data || !rect.width || !rect.height) return null;
            const fx = (ev.clientX - rect.left) / rect.width, fy = (ev.clientY - rect.top) / rect.height;
            if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) return null;
            const ix = Math.min(S.nx - 1, Math.floor(fx * S.nx)), iy = Math.min(S.ny - 1, Math.floor(fy * S.ny));
            const p = { ix: ix, iy: iy, value: S.data[iy * S.nx + ix], nx: S.nx, ny: S.ny, event: ev };
            // Section 3 convention: index i sits at (i - floor(n/2)) * (fov / n).
            if (S.fovX && S.fovY) {
                p.x = (ix - Math.floor(S.nx / 2)) * S.fovX / S.nx;
                p.y = (iy - Math.floor(S.ny / 2)) * S.fovY / S.ny;
            }
            return p;
        }
        function readoutText(p) {
            if (typeof o.readoutFormat === 'function') {
                try { return String(o.readoutFormat(p.ix, p.iy, p.value)); } catch (e) { /* fall through */ }
            }
            const val = isFinite(p.value) ? U.fmtNum(p.value, 4) + (o.unit ? ' ' + o.unit : '') : 'no data';
            if (p.x !== undefined) {
                return 'x ' + (p.x * 1e3).toFixed(1) + ' mm, y ' + (p.y * 1e3).toFixed(1) + ' mm [' + p.ix + ', ' + p.iy + ']: ' + val;
            }
            return 'x ' + p.ix + ', y ' + p.iy + ': ' + val;
        }
        let drag = null;
        canvas.addEventListener('pointerdown', function (ev) {
            if (ev.button !== 0 || !S.data) return;
            drag = { x: ev.clientX, y: ev.clientY, win: Object.assign({}, win()), moved: false, id: ev.pointerId };
            try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ }
        });
        canvas.addEventListener('pointermove', function (ev) {
            if (drag && wlEnabled) {
                const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
                if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                drag.moved = true;
                const range = (S.base.max - S.base.min) || 1;
                const k = range / 250;                     // one window-range per 250 px of drag
                const w0 = drag.win.max - drag.win.min, l0 = (drag.win.max + drag.win.min) / 2;
                const w = Math.max(range * 0.005, w0 + dx * k);
                const l = l0 + dy * k;                     // drag up (dy < 0) lowers the level: brighter
                S.user = { min: l - w / 2, max: l + w / 2 };
                showWL();
                draw();
                return;
            }
            if (drag) { if (Math.abs(ev.clientX - drag.x) + Math.abs(ev.clientY - drag.y) >= 4) drag.moved = true; }
            const p = pixelAt(ev);
            if (p) readoutEl.textContent = readoutText(p);
            else readoutEl.textContent = hint;
            S.hover.forEach(function (fn) { call(fn, p); });
        });
        function endDrag(ev) {
            if (!drag) return;
            const wasClick = !drag.moved;
            drag = null;
            if (wasClick && ev.type === 'pointerup') {
                const p = pixelAt(ev);
                if (p) S.click.forEach(function (fn) { call(fn, p); });
            }
        }
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('pointerleave', function () {
            if (drag) return;
            readoutEl.textContent = hint;
            S.hover.forEach(function (fn) { call(fn, null); });
        });
        canvas.addEventListener('dblclick', function (ev) {
            ev.preventDefault();
            if (!wlEnabled) return;
            S.user = null; showWL(); draw();
        });

        watchSize(stage, draw);
        draw();

        const api = {
            el: wrap, canvas: canvas,
            setData: setData,
            onHover: function (fn) { S.hover.push(fn); return api; },
            onClick: function (fn) { S.click.push(fn); return api; },
            setOverlay: function (fn) { S.overlay = fn || null; draw(); return api; },
            redraw: function () { draw(); return api; },
            resetWindow: function () { S.user = null; showWL(); draw(); return api; },
            getWindow: function () { return Object.assign({}, win()); },
            setWindow: function (min, max) { if (max > min) { S.user = { min: min, max: max }; showWL(); draw(); } return api; },
            setCmap: function (name) { if (name && name !== S.cmap) { S.cmap = name; S.user = null; showWL(); draw(); } return api; },
            setWL: function (b) { wlEnabled = !!b; canvas.classList.toggle('wl', wlEnabled); return api; },
            setTitle: function (t) { titleEl.firstChild.textContent = t || ''; titleEl.hidden = !t; canvas.setAttribute('aria-label', t || 'Image'); return api; },
            clear: function (msg) { S.data = null; if (msg !== undefined) emptyEl.textContent = msg; draw(); return api; },
            info: function () { return { nx: S.nx, ny: S.ny, w: S.w, h: S.h, aspect: S.aspect, cmap: S.cmap, window: win(), userWindow: !!S.user }; },
            geometry: geom
        };
        return api;
    }

    /* ---------- plot ----------
       plot(container, {height = 200, xlabel, ylabel, title, scope = false,
                        xfmt, yfmt, legend = true, framed})
       Returns { el, canvas, draw(series, opts), redraw(), onHover(fn), setTitle(t) }.
       draw(series = [{x, y, color, label, dash, width, fill, points}],
            {xlim, ylim, reverseX, markers: [{x, label, color, dash}],
             hlines: [{y, label, color}], legend, includeZero, xfmt, yfmt})
       x may be omitted (index is used). x arrays are assumed monotonic
       (increasing or decreasing), which every plot in the simulator is.
       With xlim set, the y range is fitted to the points inside it.
       reverseX puts large x on the left (ppm axes). `scope: true` draws
       on the near-black scope background. Colours come from CSS custom
       properties (--c1..--c8 on cards, --sc1..--sc8 on scopes), read at
       draw time, and every plot redraws on 'theme:changed'. */
    const livePlots = new Set();
    if (MRI.bus) {
        MRI.bus.on('theme:changed', function () {
            livePlots.forEach(function (p) {
                if (p.canvas.isConnected) p.redraw();
                else if (p.wasConnected) livePlots.delete(p);
            });
        });
    }

    function niceStep(range, count) {
        const raw = range / Math.max(1, count);
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const f = raw / mag;
        return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    }
    function niceTicks(lo, hi, count) {
        if (!(hi > lo)) return { ticks: [lo], step: 1 };
        const step = niceStep(hi - lo, count);
        const start = Math.ceil(lo / step - 1e-9);
        const out = [];
        for (let i = start; i * step <= hi + step * 1e-9; i++) {
            const v = i * step;
            out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
            if (out.length > 50) break;
        }
        return { ticks: out, step: step };
    }
    function fmtTick(v, step) {
        if (v === 0 || Math.abs(v) < step * 1e-6) return '0';
        const a = Math.max(Math.abs(v), step);
        if (a >= 1e5 || a < 1e-3) return v.toExponential(1).replace('e+', 'e');
        const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
        const s = v.toFixed(dec);
        return Number(s) === 0 ? '0' : s;          // never "-0" or "-0.0" from rounding noise
    }
    function nearestIndex(x, n, xv) {
        if (!x) return U.clamp(Math.round(xv), 0, n - 1);
        const inc = x[n - 1] >= x[0];
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if ((x[mid] < xv) === inc) lo = mid; else hi = mid;
        }
        return Math.abs(x[lo] - xv) <= Math.abs(x[hi] - xv) ? lo : hi;
    }

    function plot(container, o) {
        o = o || {};
        const height = o.height || 200;
        const wrap = el('figure', { class: 'plot' + (o.scope ? ' plot-scope' : '') + (o.framed ? ' plot-framed' : '') });
        const titleEl = el('span', { class: 'plot-title', text: o.title || '' });
        const legendEl = el('div', { class: 'legend plot-legend' });
        const head = el('figcaption', { class: 'plot-head' }, [titleEl, legendEl]);
        const stage = el('div', { class: 'plot-stage' });
        const canvas = el('canvas', { class: 'plot-canvas', role: 'img', 'aria-label': o.title || o.ylabel || 'Plot' });
        canvas.style.height = height + 'px';
        const tip = el('div', { class: 'plot-tip', hidden: true });
        stage.appendChild(canvas); stage.appendChild(tip);
        wrap.appendChild(head); wrap.appendChild(stage);
        if (container) container.appendChild(wrap);
        const hoverFns = [];

        const P = { series: [], opts: {}, hoverX: null, layout: null, legendKey: '', legendCount: 0 };

        function colors() {
            const sc = !!o.scope;
            return {
                text: U.cssVar(sc ? '--scope-muted' : '--muted', sc ? '#8794a8' : '#5b6472'),
                strong: U.cssVar(sc ? '--scope-fg' : '--fg', sc ? '#d6dde8' : '#1a1d23'),
                grid: U.cssVar(sc ? '--scope-grid' : '--grid', sc ? '#1c2638' : '#e6e9ee'),
                axis: U.cssVar(sc ? '--scope-axis' : '--axis', sc ? '#3a4760' : '#aab2bf'),
                series: function (i) {
                    const n = (i % 8) + 1;
                    const fallback = sc ? ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
                        : ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
                    return U.cssVar((sc ? '--sc' : '--c') + n, fallback[n - 1]);
                },
                font: U.cssVar('--font-sans', 'system-ui, sans-serif'),
                mono: U.cssVar('--font-mono', 'ui-monospace, monospace')
            };
        }
        function dashOf(d) { return d === true ? [5, 4] : (Array.isArray(d) ? d : []); }
        // Canvas cannot parse "var(--c3)", so resolve CSS custom properties here.
        function resolveColor(col, fallback) {
            if (typeof col !== 'string') return fallback;
            const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(col.trim());
            return m ? U.cssVar(m[1], m[2] || fallback) : col;
        }

        function updateLegend(series, c) {
            const show = P.opts.legend === true || (P.opts.legend !== false && o.legend !== false && series.filter(function (s) { return s.label; }).length >= 2);
            const items = show ? series.map(function (s, i) { return s.label ? { label: s.label, color: resolveColor(s.color, c.series(i)), dash: !!s.dash } : null; }).filter(Boolean) : [];
            const key = JSON.stringify(items);
            if (key === P.legendKey) return;
            P.legendKey = key;
            P.legendCount = items.length;
            legendEl.textContent = '';
            items.forEach(function (it) {
                legendEl.appendChild(el('span', { class: 'legend-item' }, [
                    el('span', { class: 'swatch swatch-line' + (it.dash ? ' swatch-dash' : ''), style: { borderTopColor: it.color }, 'aria-hidden': 'true' }),
                    it.label
                ]));
            });
            head.hidden = !titleEl.textContent && !items.length;
        }

        function render() {
            const avail = stage.clientWidth;
            if (!avail) return;
            P.wasConnected = true;
            const r = U.setupCanvas(canvas, avail, height);
            const ctx = r.ctx, W = r.w, H = r.h;
            const c = colors();
            const series = P.series || [], so = P.opts || {};
            const xfmt = so.xfmt || o.xfmt, yfmt = so.yfmt || o.yfmt;
            updateLegend(series, c);
            ctx.clearRect(0, 0, W, H);

            // Data ranges.
            let xlo = Infinity, xhi = -Infinity;
            series.forEach(function (s) {
                const n = s.y ? s.y.length : 0;
                if (!n) return;
                const a = s.x ? s.x[0] : 0, b = s.x ? s.x[n - 1] : n - 1;
                xlo = Math.min(xlo, a, b); xhi = Math.max(xhi, a, b);
            });
            if (so.xlim) { xlo = so.xlim[0]; xhi = so.xlim[1]; if (xlo > xhi) { const t = xlo; xlo = xhi; xhi = t; } }
            if (!isFinite(xlo) || !isFinite(xhi)) { xlo = 0; xhi = 1; }
            if (xhi === xlo) { xhi = xlo + 1; }
            let ylo = Infinity, yhi = -Infinity;
            if (so.ylim) { ylo = so.ylim[0]; yhi = so.ylim[1]; }
            else {
                series.forEach(function (s) {
                    const y = s.y, x = s.x, n = y ? y.length : 0;
                    for (let i = 0; i < n; i++) {
                        const xv = x ? x[i] : i;
                        if (xv < xlo || xv > xhi) continue;
                        const v = y[i];
                        if (isFinite(v)) { if (v < ylo) ylo = v; if (v > yhi) yhi = v; }
                    }
                });
                (so.hlines || []).forEach(function (h) { if (isFinite(h.y)) { ylo = Math.min(ylo, h.y); yhi = Math.max(yhi, h.y); } });
                if (so.includeZero) { ylo = Math.min(ylo, 0); yhi = Math.max(yhi, 0); }
                if (!isFinite(ylo) || !isFinite(yhi)) { ylo = 0; yhi = 1; }
                if (yhi === ylo) { const d = Math.abs(ylo) || 1; ylo -= d * 0.5; yhi += d * 0.5; }
                else { const pad = (yhi - ylo) * 0.06; if (!(so.includeZero && ylo === 0)) ylo -= pad; yhi += pad; }
            }

            // Layout: measure the y tick labels to size the left margin.
            ctx.font = '11px ' + c.font;
            const hasMarkerLabels = (so.markers || []).some(function (m) { return m.label; });
            const bottom = 20 + (o.xlabel ? 16 : 0);
            const plotHGuess = Math.max(20, H - (hasMarkerLabels ? 18 : 8) - bottom);
            const yt = niceTicks(ylo, yhi, U.clamp(Math.round(plotHGuess / 38), 2, 8));
            const ylabels = yt.ticks.map(function (v) { return yfmt ? yfmt(v) : fmtTick(v, yt.step); });
            let lw = 0;
            ylabels.forEach(function (s) { lw = Math.max(lw, ctx.measureText(s).width); });
            const left = Math.ceil(lw) + 10 + (o.ylabel ? 16 : 0);
            const right = 12;
            const pw = Math.max(10, W - left - right);
            const rev = !!so.reverseX;
            const X = function (v) { return rev ? left + (xhi - v) / (xhi - xlo) * pw : left + (v - xlo) / (xhi - xlo) * pw; };

            // Marker labels sit above the plot. Close markers (Cho at 3.20 ppm
            // next to Cr at 3.03 on a phone) go to a second row; a label that
            // fits in neither row is dropped (its line is still drawn).
            ctx.font = '600 11px ' + c.font;
            const markerLabels = [], rowsEnd = [-Infinity, -Infinity];
            (so.markers || []).map(function (m) { return m; })
                .filter(function (m) { return m.label && isFinite(m.x) && m.x >= xlo && m.x <= xhi; })
                .sort(function (a, b) { return X(a.x) - X(b.x); })
                .forEach(function (m) {
                    const tw = ctx.measureText(m.label).width;
                    const xc = U.clamp(X(m.x), left + tw / 2, left + pw - tw / 2);
                    for (let row = 0; row < 2; row++) {
                        if (xc - tw / 2 >= rowsEnd[row] + 4) { rowsEnd[row] = xc + tw / 2; markerLabels.push({ m: m, xc: xc, row: row }); return; }
                    }
                });
            ctx.font = '11px ' + c.font;
            const nRows = markerLabels.some(function (q) { return q.row === 1; }) ? 2 : (markerLabels.length ? 1 : 0);
            const top = 8 + 13 * nRows;
            const ph = Math.max(10, H - top - bottom);
            const Y = function (v) { return top + (yhi - v) / (yhi - ylo) * ph; };
            P.layout = { left: left, top: top, pw: pw, ph: ph, xlo: xlo, xhi: xhi, ylo: ylo, yhi: yhi, rev: rev, X: X, Y: Y };

            // Grid and ticks.
            const xt = niceTicks(xlo, xhi, U.clamp(Math.round(pw / 90), 2, 10));
            ctx.lineWidth = 1;
            ctx.strokeStyle = c.grid;
            ctx.beginPath();
            yt.ticks.forEach(function (v) { if (v >= ylo && v <= yhi) { const y = Math.round(Y(v)) + 0.5; ctx.moveTo(left, y); ctx.lineTo(left + pw, y); } });
            xt.ticks.forEach(function (v) { if (v >= xlo && v <= xhi) { const x = Math.round(X(v)) + 0.5; ctx.moveTo(x, top); ctx.lineTo(x, top + ph); } });
            ctx.stroke();
            if (ylo < 0 && yhi > 0) {
                ctx.strokeStyle = c.axis;
                ctx.beginPath(); const y0 = Math.round(Y(0)) + 0.5; ctx.moveTo(left, y0); ctx.lineTo(left + pw, y0); ctx.stroke();
            }
            ctx.strokeStyle = c.axis;
            ctx.beginPath();
            ctx.moveTo(left + 0.5, top); ctx.lineTo(left + 0.5, top + ph + 0.5); ctx.lineTo(left + pw, top + ph + 0.5);
            ctx.stroke();

            ctx.fillStyle = c.text;
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            yt.ticks.forEach(function (v, i) { if (v >= ylo && v <= yhi) ctx.fillText(ylabels[i], left - 6, Y(v)); });
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            let last = null;            // screen extent of the previous label drawn, to skip collisions
            xt.ticks.forEach(function (v) {
                if (v < xlo || v > xhi) return;
                const s = xfmt ? xfmt(v) : fmtTick(v, xt.step), tw = ctx.measureText(s).width;
                const xc = U.clamp(X(v), left + tw / 2, left + pw - tw / 2);
                const l = xc - tw / 2, r = xc + tw / 2;
                if (last && l < last.r + 6 && r > last.l - 6) return;
                ctx.fillText(s, xc, top + ph + 5);
                last = { l: l, r: r };
            });
            if (o.xlabel) { ctx.fillStyle = c.text; ctx.textBaseline = 'bottom'; ctx.fillText(o.xlabel, left + pw / 2, H - 1); }
            if (o.ylabel) {
                ctx.save(); ctx.translate(11, top + ph / 2); ctx.rotate(-Math.PI / 2);
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(o.ylabel, 0, 0); ctx.restore();
            }

            // Series, clipped to the plot area. Long series are reduced to
            // a min/max pair per pixel column, which looks identical and
            // keeps an 8k-point FID fast to redraw on hover.
            ctx.save();
            ctx.beginPath(); ctx.rect(left, top - 1, pw, ph + 2); ctx.clip();
            series.forEach(function (s, si) {
                const y = s.y, x = s.x, n = y ? y.length : 0;
                if (!n) return;
                const col = resolveColor(s.color, c.series(si));
                ctx.strokeStyle = col;
                ctx.lineWidth = s.width || 1.75;
                ctx.lineJoin = 'round';
                ctx.setLineDash(dashOf(s.dash));
                const decimate = n > 3 * pw;
                ctx.beginPath();
                let pen = false, col0 = null, cmin = 0, cmax = 0;
                for (let i = 0; i < n; i++) {
                    const v = y[i];
                    if (!isFinite(v)) { pen = false; continue; }
                    const px = X(x ? x[i] : i), py = Y(v);
                    if (decimate) {
                        const cc = Math.round(px);
                        if (cc === col0) { if (py < cmin) cmin = py; if (py > cmax) cmax = py; continue; }
                        if (col0 !== null && pen) { ctx.lineTo(col0, cmin); ctx.lineTo(col0, cmax); }
                        col0 = cc; cmin = cmax = py;
                    }
                    if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
                }
                if (decimate && col0 !== null && pen) { ctx.lineTo(col0, cmin); ctx.lineTo(col0, cmax); }
                ctx.stroke();
                if (s.fill) {
                    ctx.lineTo(X(x ? x[n - 1] : n - 1), Y(Math.max(ylo, Math.min(yhi, 0))));
                    ctx.lineTo(X(x ? x[0] : 0), Y(Math.max(ylo, Math.min(yhi, 0))));
                    ctx.closePath();
                    ctx.globalAlpha = typeof s.fill === 'number' ? s.fill : 0.14;
                    ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
                }
                ctx.setLineDash([]);
                if (s.points) {
                    ctx.fillStyle = col;
                    const rad = s.points === true ? 3.5 : s.points;
                    for (let i = 0; i < n; i++) {
                        if (!isFinite(y[i])) continue;
                        ctx.beginPath(); ctx.arc(X(x ? x[i] : i), Y(y[i]), rad, 0, 2 * Math.PI); ctx.fill();
                    }
                }
            });
            (so.hlines || []).forEach(function (h) {
                if (!isFinite(h.y)) return;
                const hc = resolveColor(h.color, c.axis);
                ctx.strokeStyle = hc; ctx.lineWidth = 1; ctx.setLineDash(h.dash === false ? [] : [4, 4]);
                ctx.beginPath(); const yy = Math.round(Y(h.y)) + 0.5; ctx.moveTo(left, yy); ctx.lineTo(left + pw, yy); ctx.stroke();
                ctx.setLineDash([]);
                if (h.label) { ctx.fillStyle = h.color ? hc : c.text; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(h.label, left + 4, yy - 2); }
            });
            ctx.restore();

            // Markers: vertical lines, with the labels placed above.
            (so.markers || []).forEach(function (m) {
                if (!isFinite(m.x) || m.x < xlo || m.x > xhi) return;
                const xx = Math.round(X(m.x)) + 0.5, mc = resolveColor(m.color, c.strong);
                ctx.strokeStyle = mc; ctx.lineWidth = 1; ctx.setLineDash(m.dash === false ? [] : [3, 3]);
                ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, top + ph); ctx.stroke(); ctx.setLineDash([]);
            });
            ctx.font = '600 11px ' + c.font; ctx.textBaseline = 'bottom'; ctx.textAlign = 'center';
            markerLabels.forEach(function (q) {
                ctx.fillStyle = resolveColor(q.m.color, c.strong);
                ctx.fillText(q.m.label, q.xc, top - 3 - 13 * q.row);   // row 0 sits just above the plot
            });
            ctx.font = '11px ' + c.font;

            // Hover crosshair.
            if (P.hoverX !== null && P.hoverX >= xlo && P.hoverX <= xhi) {
                const hx = Math.round(X(P.hoverX)) + 0.5;
                ctx.strokeStyle = c.strong; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(hx, top); ctx.lineTo(hx, top + ph); ctx.stroke(); ctx.globalAlpha = 1;
                series.forEach(function (s, si) {
                    const n = s.y ? s.y.length : 0; if (!n) return;
                    const i = nearestIndex(s.x, n, P.hoverX), v = s.y[i];
                    if (!isFinite(v) || v < ylo || v > yhi) return;
                    ctx.fillStyle = resolveColor(s.color, c.series(si));
                    ctx.beginPath(); ctx.arc(X(s.x ? s.x[i] : i), Y(v), 3.5, 0, 2 * Math.PI); ctx.fill();
                });
            }
        }

        function updateTip(ev) {
            const L = P.layout;
            if (!L || !P.series.length) { tip.hidden = true; return; }
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
            if (mx < L.left || mx > L.left + L.pw || my < L.top || my > L.top + L.ph) {
                if (P.hoverX !== null) { P.hoverX = null; render(); hoverFns.forEach(function (fn) { call(fn, null); }); }
                tip.hidden = true; return;
            }
            const f = (mx - L.left) / L.pw;
            const xv = L.rev ? L.xhi - f * (L.xhi - L.xlo) : L.xlo + f * (L.xhi - L.xlo);
            P.hoverX = xv;
            render();
            const xfmt = P.opts.xfmt || o.xfmt, yfmt = P.opts.yfmt || o.yfmt;
            const c = colors();
            const lines = [];
            let xShown = xv;
            P.series.slice(0, 6).forEach(function (s, si) {
                const n = s.y ? s.y.length : 0; if (!n) return;
                const i = nearestIndex(s.x, n, xv);
                if (si === 0) xShown = s.x ? s.x[i] : i;
                const v = s.y[i];
                lines.push({ color: resolveColor(s.color, c.series(si)), text: (s.label ? s.label + ': ' : '') + (isFinite(v) ? (yfmt ? yfmt(v) : U.fmtNum(v, 4)) : '-') });
            });
            tip.textContent = '';
            tip.appendChild(el('div', { class: 'plot-tip-x', text: (o.xlabel ? o.xlabel.replace(/\s*\(.*\)$/, '') + ' ' : 'x ') + (xfmt ? xfmt(xShown) : U.fmtNum(xShown, 4)) }));
            lines.forEach(function (ln) {
                tip.appendChild(el('div', {}, [el('span', { class: 'swatch', style: { background: ln.color }, 'aria-hidden': 'true' }), ln.text]));
            });
            tip.hidden = false;
            const tw = tip.offsetWidth, sw = stage.clientWidth;
            let tx = mx + 12;
            if (tx + tw > sw) tx = Math.max(0, mx - 12 - tw);
            tip.style.left = tx + 'px';
            tip.style.top = Math.max(0, Math.min(my - 10, height - tip.offsetHeight)) + 'px';
            hoverFns.forEach(function (fn) { call(fn, { x: xv, event: ev }); });
        }
        canvas.addEventListener('pointermove', updateTip);
        canvas.addEventListener('pointerleave', function () {
            tip.hidden = true;
            if (P.hoverX !== null) { P.hoverX = null; render(); }
            hoverFns.forEach(function (fn) { call(fn, null); });
        });

        watchSize(stage, render);
        const api = {
            el: wrap, canvas: canvas,
            draw: function (series, opts) {
                P.series = (series || []).filter(Boolean);
                P.opts = opts || {};
                render();
                return api;
            },
            redraw: function () { render(); return api; },
            onHover: function (fn) { hoverFns.push(fn); return api; },
            setTitle: function (t) { titleEl.textContent = t || ''; canvas.setAttribute('aria-label', t || 'Plot'); head.hidden = !t && !P.legendCount; return api; },
            layout: function () { return P.layout; }
        };
        Object.defineProperty(api, 'wasConnected', { get: function () { return !!P.wasConnected; } });
        livePlots.add(api);
        head.hidden = !o.title;
        return api;
    }

    /* ---------- stat table ----------
       statTable(rows) with rows as [[label, value, unit?], ...],
       [{label, value, unit, hint, kind: 'good'|'bad'|'warn'|'muted'}, ...]
       or a plain {label: value} object. Numbers are shown to 4
       significant figures; strings as text; Nodes as given; {html} as HTML.
       Returns the <table> with update(rows) to refresh it in place. */
    function normRows(rows) {
        if (!rows) return [];
        if (!Array.isArray(rows)) return Object.keys(rows).map(function (k) { return { label: k, value: rows[k] }; });
        return rows.filter(Boolean).map(function (r) {
            if (Array.isArray(r)) return { label: r[0], value: r[1], unit: r[2], hint: r[3] };
            return r;
        });
    }
    function statTable(rows, opts) {
        opts = opts || {};
        const table = el('table', { class: 'stat-table' + (opts.compact ? ' stat-table-compact' : '') });
        if (opts.caption) table.appendChild(el('caption', { text: opts.caption }));
        const body = el('tbody');
        table.appendChild(body);
        function fill(rs) {
            body.textContent = '';
            normRows(rs).forEach(function (r) {
                const td = el('td', { class: r.kind || null });
                const v = r.value;
                if (v instanceof root.Node) td.appendChild(v);
                else if (v && typeof v === 'object' && v.html !== undefined) td.innerHTML = v.html;
                else td.appendChild(doc.createTextNode(v === null || v === undefined ? '-' : (typeof v === 'number' ? U.fmtNum(v, 4) : String(v))));
                if (r.unit) td.appendChild(el('span', { class: 'unit', text: r.unit }));
                const th = el('th', { scope: 'row', title: r.hint || null, text: r.label === undefined ? '' : String(r.label) });
                body.appendChild(el('tr', {}, [th, td]));
            });
        }
        fill(rows);
        table.update = function (rs) { fill(rs); return table; };
        return table;
    }

    /* ---------- toast ----------
       toast(message, kind = 'info' | 'good' | 'warn' | 'bad', {timeout})
       A short message in the bottom corner that fades by itself; click
       or press its close button to dismiss early. Returns the element. */
    let toastHost = null;
    function toast(msg, kind, opts) {
        if (!doc || !doc.body) return null;
        opts = opts || {};
        kind = kind || 'info';
        if (!toastHost || !toastHost.isConnected) {
            toastHost = el('div', { class: 'toasts', 'aria-live': 'polite', role: 'status' });
            doc.body.appendChild(toastHost);
        }
        while (toastHost.children.length >= 4) toastHost.removeChild(toastHost.firstChild);
        const close = el('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss' }, '×');
        const t = el('div', { class: 'toast toast-' + kind, role: kind === 'bad' ? 'alert' : null }, [
            el('div', { class: 'toast-msg' }, msg instanceof root.Node ? msg : String(msg)), close
        ]);
        let timer = null;
        function dismiss() {
            if (timer) clearTimeout(timer);
            t.classList.add('toast-out');
            setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 200);
        }
        close.addEventListener('click', dismiss);
        toastHost.appendChild(t);
        const ms = opts.timeout !== undefined ? opts.timeout : (kind === 'bad' ? 7000 : kind === 'warn' ? 5000 : 3500);
        if (ms > 0) timer = setTimeout(dismiss, ms);
        t.dismiss = dismiss;
        return t;
    }

    /* ---------- small helpers ---------- */

    /* button({label, onClick, kind: 'primary'|'ghost'|'danger', size: 'sm'|'xs', title, icon}) */
    function button(o) {
        o = o || {};
        const cls = 'btn' + (o.kind ? ' btn-' + o.kind : '') + (o.size ? ' btn-' + o.size : '');
        const b = el('button', { type: 'button', class: cls, title: o.title, disabled: o.disabled }, [
            o.icon ? el('span', { class: 'btn-icon', 'aria-hidden': 'true', html: o.icon }) : null, o.label || ''
        ]);
        if (o.onClick) b.addEventListener('click', function (e) { call(o.onClick, e); });
        return b;
    }
    /* badge(text, kind: 'accent'|'good'|'warn'|'bad'|'muted') */
    function badge(text, kind) { return el('span', { class: 'badge' + (kind ? ' badge-' + kind : ''), text: text }); }
    /* legend([{label, color, line, dash}]) */
    function legend(items) {
        return el('div', { class: 'legend' }, (items || []).map(function (it) {
            return el('span', { class: 'legend-item' }, [
                el('span', { class: 'swatch' + (it.line || it.dash ? ' swatch-line' : '') + (it.dash ? ' swatch-dash' : ''),
                    style: it.line || it.dash ? { borderTopColor: it.color } : { background: it.color }, 'aria-hidden': 'true' }),
                it.label
            ]);
        }));
    }
    /* details({summary, content, open}): the collapsible "advanced" section. */
    function details(o) {
        o = o || {};
        const d = el('details', { class: 'adv' }, [el('summary', { text: o.summary || 'Advanced' })]);
        const body = htmlNode(o.content, 'div', 'adv-body');
        if (body) d.appendChild(body);
        if (o.open) d.open = true;
        return d;
    }
    /* callout(html, kind: 'info'|'warn'|'bad'|'good') */
    function callout(html, kind) {
        const n = htmlNode(html, 'div');
        const c = el('div', { class: 'callout' + (kind && kind !== 'info' ? ' callout-' + kind : '') });
        if (n) c.appendChild(n);
        return c;
    }
    /* empty(message): a dashed placeholder for "no data yet" states. */
    function empty(msg) { return el('div', { class: 'empty', text: msg || 'Nothing to show yet.' }); }
    /* errorCard(title, error): what a tab shows when something it depends on fails. */
    function errorCard(title, err) {
        const msg = err && err.message ? err.message : (err ? String(err) : '');
        const card = el('div', { class: 'error-card', role: 'alert' }, [
            el('div', { class: 'error-card-title', text: title || 'Something went wrong' }),
            msg ? el('div', { class: 'error-card-msg', text: msg }) : null
        ]);
        if (err && err.stack) {
            card.appendChild(el('details', { class: 'error-card-details' }, [
                el('summary', { text: 'Technical details' }), el('pre', { text: String(err.stack) })
            ]));
        }
        return card;
    }

    MRI.ui = MRI.ui || {};
    MRI.ui.w = {
        concept: concept, slider: slider, select: select, toggle: toggle, segmented: segmented,
        imageView: imageView, plot: plot, statTable: statTable, toast: toast,
        button: button, badge: badge, legend: legend, details: details, callout: callout,
        empty: empty, errorCard: errorCard,
        // exposed for tests and for tabs that draw their own axes
        _niceTicks: niceTicks, _fmtTick: fmtTick
    };

})(typeof window !== 'undefined' ? window : globalThis);
