/* ==========================================================================
   plasticity.js — shared plumbing for the neural plasticity demos.

   Dependency-free on purpose: every figure in this directory has to open from
   a file:// path, from a laptop with no network, or from a lecture-hall
   machine that has never heard of npm. Keep it that way.
   ========================================================================== */

(function (global) {
    'use strict';

    var NPLib = {};

    var MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

    /* ---------------------------------------------------------------- theme */

    var themeCache = null;

    function readTheme() {
        var cs = getComputedStyle(document.documentElement);
        function v(name, fallback) {
            var s = cs.getPropertyValue(name).trim();
            return s || fallback;
        }
        themeCache = {
            bg: v('--bg', '#fff'),
            fg: v('--fg', '#111'),
            muted: v('--muted', '#666'),
            accent: v('--accent', '#0d9488'),
            border: v('--border', '#e0e0e0'),
            grid: v('--grid', '#e8e8e8'),
            panel: v('--panel', '#f5f5f5'),
            panel2: v('--panel-2', '#ececec'),
            canvasBg: v('--canvas-bg', '#fff'),
            pre: v('--c-pre', '#2563eb'),
            post: v('--c-post', '#d97706'),
            ltp: v('--c-ltp', '#0e9f6e'),
            ltd: v('--c-ltd', '#c026d3'),
            neuron: v('--c-neuron', '#64748b'),
            membrane: v('--c-membrane', '#1a1a1a'),
            thresh: v('--c-thresh', '#dc2626'),
            rate: v('--c-rate', '#6b7280'),
            theory: v('--c-theory', '#7c3aed')
        };
        return themeCache;
    }

    NPLib.theme = function () { return themeCache || readTheme(); };

    function announceTheme() {
        readTheme();
        global.dispatchEvent(new CustomEvent('np:theme'));
    }

    /* Applies the stored preference. Call from an inline <head> script so the
       page never flashes the wrong palette. */
    NPLib.applyStoredTheme = function () {
        try {
            var t = localStorage.getItem('np-theme');
            if (t === 'dark' || t === 'light') {
                document.documentElement.setAttribute('data-theme', t);
            }
        } catch (e) { /* private browsing: fall back to the media query */ }
    };

    function isDark() {
        var explicit = document.documentElement.getAttribute('data-theme');
        if (explicit) { return explicit === 'dark'; }
        return global.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    NPLib.wireThemeToggle = function () {
        var btn = document.querySelector('.theme-toggle');
        if (!btn) { return; }
        function label() {
            btn.textContent = isDark() ? 'Light' : 'Dark';
            btn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
        }
        btn.addEventListener('click', function () {
            var next = isDark() ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('np-theme', next); } catch (e) { /* ignore */ }
            label();
            announceTheme();
        });
        var mq = global.matchMedia('(prefers-color-scheme: dark)');
        var onMq = function () { label(); announceTheme(); };
        if (mq.addEventListener) { mq.addEventListener('change', onMq); }
        else if (mq.addListener) { mq.addListener(onMq); }
        label();
    };

    /* Redraw whenever the palette changes, so a paused figure does not sit
       there in the old theme's colours. */
    NPLib.onThemeChange = function (fn) {
        global.addEventListener('np:theme', fn);
    };

    NPLib.reducedMotion = function () {
        return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    };

    /* ---------------------------------------------------------------- canvas */

    /* Sizes a canvas to its CSS width at a fixed aspect ratio, honouring
       devicePixelRatio so 1px rules and spike ticks stay crisp. onResize runs
       after every refit, which is also the page's cue to redraw: a canvas
       loses its contents the moment its width attribute is assigned. */
    NPLib.fitCanvas = function (canvas, aspect, onResize) {
        var ctx = canvas.getContext('2d');
        var state = { ctx: ctx, canvas: canvas, w: 0, h: 0 };
        var lastW = -1, lastDpr = -1;

        function fit() {
            var dpr = Math.min(global.devicePixelRatio || 1, 2);
            var w = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
            if (w === lastW && dpr === lastDpr) { return; }
            lastW = w;
            lastDpr = dpr;
            var h = Math.round(w * aspect);
            canvas.style.height = h + 'px';
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            state.w = w;
            state.h = h;
            if (onResize) { onResize(w, h); }
        }

        if (global.ResizeObserver) {
            new ResizeObserver(fit).observe(canvas);
        } else {
            global.addEventListener('resize', fit);
        }
        fit();
        state.fit = fit;
        return state;
    };

    NPLib.clear = function (ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = NPLib.theme().canvasBg;
        ctx.fillRect(0, 0, w, h);
    };

    /* Pointer position in CSS pixels relative to the canvas. */
    NPLib.pointer = function (canvas, e) {
        var r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    /* ------------------------------------------------------------- plotting */

    /* Minimal x-y plot. box is {x,y,w,h} in CSS pixels. */
    NPLib.plot = function (ctx, box, spec) {
        var th = NPLib.theme();
        var xmin = spec.xmin, xmax = spec.xmax, ymin = spec.ymin, ymax = spec.ymax;
        var sx = function (x) { return box.x + ((x - xmin) / (xmax - xmin)) * box.w; };
        var sy = function (y) { return box.y + box.h - ((y - ymin) / (ymax - ymin)) * box.h; };

        ctx.save();

        /* frame */
        ctx.strokeStyle = th.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

        /* gridlines */
        var i, g;
        ctx.strokeStyle = th.grid;
        if (spec.xTicks) {
            for (i = 0; i < spec.xTicks.length; i++) {
                g = sx(spec.xTicks[i]);
                ctx.beginPath();
                ctx.moveTo(g, box.y);
                ctx.lineTo(g, box.y + box.h);
                ctx.stroke();
            }
        }
        if (spec.yTicks) {
            for (i = 0; i < spec.yTicks.length; i++) {
                g = sy(spec.yTicks[i]);
                ctx.beginPath();
                ctx.moveTo(box.x, g);
                ctx.lineTo(box.x + box.w, g);
                ctx.stroke();
            }
        }

        /* shaded bands, e.g. the LTP and LTD halves of an STDP window */
        var b;
        if (spec.bands) {
            for (i = 0; i < spec.bands.length; i++) {
                b = spec.bands[i];
                ctx.save();
                ctx.globalAlpha = b.alpha === undefined ? 0.07 : b.alpha;
                ctx.fillStyle = b.color || th.muted;
                ctx.fillRect(sx(b.x0), box.y, sx(b.x1) - sx(b.x0), box.h);
                ctx.restore();
            }
        }

        /* zero lines */
        if (ymin < 0 && ymax > 0) {
            ctx.strokeStyle = th.muted;
            ctx.beginPath();
            ctx.moveTo(box.x, sy(0));
            ctx.lineTo(box.x + box.w, sy(0));
            ctx.stroke();
        }
        if (xmin < 0 && xmax > 0 && spec.xZero) {
            ctx.strokeStyle = th.muted;
            ctx.beginPath();
            ctx.moveTo(sx(0), box.y);
            ctx.lineTo(sx(0), box.y + box.h);
            ctx.stroke();
        }

        /* vertical markers */
        var m, lastLabelX = -1e9, labelDy = 3;
        if (spec.marks) {
            for (i = 0; i < spec.marks.length; i++) {
                m = spec.marks[i];
                if (m.x < xmin || m.x > xmax) { continue; }
                ctx.save();
                ctx.strokeStyle = m.color || th.muted;
                ctx.lineWidth = m.width || 1;
                ctx.setLineDash(m.dash || [3, 3]);
                ctx.beginPath();
                ctx.moveTo(sx(m.x), box.y);
                ctx.lineTo(sx(m.x), box.y + box.h);
                ctx.stroke();
                ctx.restore();
                if (m.label) {
                    labelDy = Math.abs(sx(m.x) - lastLabelX) < 30 ? labelDy + 11 : 3;
                    if (labelDy > 25) { labelDy = 3; }
                    lastLabelX = sx(m.x);
                    ctx.fillStyle = m.color || th.muted;
                    ctx.font = '600 10px ' + MONO;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(m.label, sx(m.x), box.y + labelDy);
                }
            }
        }

        /* horizontal markers, e.g. a firing threshold */
        if (spec.hlines) {
            for (i = 0; i < spec.hlines.length; i++) {
                m = spec.hlines[i];
                if (m.y < ymin || m.y > ymax) { continue; }
                ctx.save();
                ctx.strokeStyle = m.color || th.muted;
                ctx.lineWidth = m.width || 1;
                ctx.setLineDash(m.dash || [4, 4]);
                ctx.beginPath();
                ctx.moveTo(box.x, sy(m.y));
                ctx.lineTo(box.x + box.w, sy(m.y));
                ctx.stroke();
                ctx.restore();
                if (m.label) {
                    ctx.fillStyle = m.color || th.muted;
                    ctx.font = '600 10px ' + MONO;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(m.label, box.x + 4, sy(m.y) - 2);
                }
            }
        }

        /* series */
        var s, pts, j, started;
        if (spec.series) {
            for (i = 0; i < spec.series.length; i++) {
                s = spec.series[i];
                pts = s.pts;
                if (!pts || pts.length < 2) { continue; }
                ctx.save();
                ctx.beginPath();
                ctx.rect(box.x, box.y, box.w, box.h);
                ctx.clip();
                ctx.strokeStyle = s.color || th.fg;
                ctx.lineWidth = s.width || 1.8;
                ctx.lineJoin = 'round';
                if (s.dash) { ctx.setLineDash(s.dash); }
                if (s.alpha !== undefined) { ctx.globalAlpha = s.alpha; }
                ctx.beginPath();
                started = false;
                for (j = 0; j < pts.length; j++) {
                    if (pts[j][0] < xmin || pts[j][0] > xmax) { started = false; continue; }
                    if (!started) { ctx.moveTo(sx(pts[j][0]), sy(pts[j][1])); started = true; }
                    else { ctx.lineTo(sx(pts[j][0]), sy(pts[j][1])); }
                }
                ctx.stroke();
                ctx.restore();
            }
        }

        /* scatter points */
        var pt;
        if (spec.points) {
            for (i = 0; i < spec.points.length; i++) {
                s = spec.points[i];
                if (!s.pts) { continue; }
                ctx.save();
                ctx.fillStyle = s.color || th.fg;
                if (s.alpha !== undefined) { ctx.globalAlpha = s.alpha; }
                for (j = 0; j < s.pts.length; j++) {
                    pt = s.pts[j];
                    if (pt[0] < xmin || pt[0] > xmax || pt[1] < ymin || pt[1] > ymax) { continue; }
                    ctx.beginPath();
                    ctx.arc(sx(pt[0]), sy(pt[1]), s.r || 3, 0, Math.PI * 2);
                    ctx.fill();
                    if (s.ring) {
                        ctx.strokeStyle = s.ring;
                        ctx.lineWidth = 1.5;
                        ctx.stroke();
                    }
                }
                ctx.restore();
            }
        }

        /* numeric tick labels, opt-in per axis */
        var labelX = spec.tickLabels || spec.tickLabelsX;
        var labelY = spec.tickLabels || spec.tickLabelsY;
        if (labelX || labelY) {
            ctx.fillStyle = th.muted;
            ctx.font = '10px ' + MONO;
            if (labelX && spec.xTicks) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                for (i = 0; i < spec.xTicks.length; i++) {
                    ctx.fillText(String(spec.xTicks[i]), sx(spec.xTicks[i]), box.y + box.h + 4);
                }
            }
            if (labelY && spec.yTicks) {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                for (i = 0; i < spec.yTicks.length; i++) {
                    ctx.fillText(String(spec.yTicks[i]), box.x - 5, sy(spec.yTicks[i]));
                }
            }
        }

        /* axis labels */
        ctx.fillStyle = th.muted;
        ctx.font = '11px ' + MONO;
        if (spec.xlabel) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText(spec.xlabel, box.x + box.w, box.y + box.h + (labelX ? 17 : 5));
        }
        if (spec.ylabel) {
            ctx.save();
            ctx.translate(Math.max(10, box.x - 30), box.y + box.h / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(spec.ylabel, 0, 0);
            ctx.restore();
        }

        ctx.restore();
        return { sx: sx, sy: sy };
    };

    /* Spike raster: one row of ticks per train. */
    NPLib.raster = function (ctx, box, trains, opts) {
        opts = opts || {};
        var th = NPLib.theme();
        var xmin = opts.xmin, xmax = opts.xmax;
        var rows = trains.length || 1;
        var rowH = box.h / rows;

        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.w, box.h);
        ctx.clip();

        for (var r = 0; r < trains.length; r++) {
            var t = trains[r];
            var cy = box.y + rowH * (r + 0.5);
            var half = Math.min(rowH * 0.36, 14);

            /* baseline */
            ctx.strokeStyle = th.grid;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(box.x, cy);
            ctx.lineTo(box.x + box.w, cy);
            ctx.stroke();

            ctx.strokeStyle = t.color || th.fg;
            ctx.lineWidth = t.width || 1.5;
            for (var i = 0; i < t.times.length; i++) {
                var x = box.x + ((t.times[i] - xmin) / (xmax - xmin)) * box.w;
                if (x < box.x || x > box.x + box.w) { continue; }
                ctx.beginPath();
                ctx.moveTo(x, cy - half);
                ctx.lineTo(x, cy + half);
                ctx.stroke();
            }

            if (t.label) {
                ctx.fillStyle = t.color || th.muted;
                ctx.font = '600 10px ' + MONO;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(t.label, box.x + 5, cy - half - 7);
            }
        }

        ctx.restore();
    };

    /* Rolling sample buffer for signal traces. Fixed-capacity ring, so a
       figure left running all afternoon does not grow without bound. */
    function Trace(max) {
        this.pts = [];
        this.max = max || 4000;
    }
    Trace.prototype.push = function (x, y) {
        this.pts.push([x, y]);
        if (this.pts.length > this.max) { this.pts.splice(0, this.pts.length - this.max); }
    };
    Trace.prototype.clear = function () { this.pts.length = 0; };
    Trace.prototype.last = function () { return this.pts[this.pts.length - 1]; };
    NPLib.Trace = Trace;

    /* ------------------------------------------------------------ animation */

    /* rAF loop with a clamped timestep, so tabbing away and back does not
       teleport the simulation. */
    function Loop(step) {
        this.step = step;
        this.running = false;
        this.last = 0;
        this.id = 0;
        var self = this;
        this.tick = function (ts) {
            if (!self.running) { return; }
            var dt = self.last ? (ts - self.last) / 1000 : 1 / 60;
            self.last = ts;
            self.step(Math.min(dt, 0.05));
            self.id = requestAnimationFrame(self.tick);
        };
    }
    Loop.prototype.start = function () {
        if (this.running) { return; }
        this.running = true;
        this.last = 0;
        this.id = requestAnimationFrame(this.tick);
    };
    Loop.prototype.stop = function () {
        this.running = false;
        cancelAnimationFrame(this.id);
    };
    Loop.prototype.toggle = function () {
        if (this.running) { this.stop(); } else { this.start(); }
        return this.running;
    };
    NPLib.Loop = Loop;

    /* ------------------------------------------------------------- controls */

    /* Wires <input id="foo"> to its <b id="fooVal"> readout. opts.scale maps
       the slider integer to a physical value; opts.fmt renders it. */
    NPLib.bind = function (id, opts) {
        opts = opts || {};
        var el = document.getElementById(id);
        if (!el) { throw new Error('bind: no element #' + id); }
        var out = document.getElementById(id + 'Val');
        var scale = opts.scale || function (v) { return v; };
        var fmt = opts.fmt || function (v) { return String(v); };

        var api = {
            el: el,
            value: 0,
            set: function (raw) {
                if (el.type === 'checkbox') { el.checked = !!raw; }
                else { el.value = raw; }
                api.refresh();
            },
            refresh: function () {
                if (el.type === 'checkbox') {
                    api.value = el.checked;
                } else if (el.tagName === 'SELECT') {
                    api.value = opts.numeric ? parseFloat(el.value) : el.value;
                } else {
                    api.value = scale(parseFloat(el.value));
                }
                if (out) { out.textContent = fmt(api.value); }
            }
        };

        el.addEventListener('input', function () {
            api.refresh();
            if (opts.on) { opts.on(api.value); }
        });
        if (el.tagName === 'SELECT' || el.type === 'checkbox') {
            el.addEventListener('change', function () {
                api.refresh();
                if (opts.on) { opts.on(api.value); }
            });
        }
        api.refresh();
        return api;
    };

    NPLib.on = function (id, fn) {
        var el = document.getElementById(id);
        if (el) { el.addEventListener('click', fn); }
        return el;
    };

    NPLib.set = function (id, text) {
        var el = document.getElementById(id);
        if (el) { el.textContent = text; }
    };

    /* Canvas tooltip. Positions a .tip inside the figure that holds the
       canvas; call show(x, y, text) from a pointermove handler. */
    NPLib.tooltip = function (canvas) {
        var host = canvas.closest('.fig') || canvas.parentNode;
        var el = host.querySelector('.tip');
        if (!el) {
            el = document.createElement('div');
            el.className = 'tip';
            host.appendChild(el);
        }
        return {
            show: function (x, y, text) {
                el.textContent = text;
                el.classList.add('on');
                /* keep the tip inside the figure */
                var maxX = host.clientWidth - el.offsetWidth - 6;
                el.style.left = Math.max(4, Math.min(x + 14, maxX)) + 'px';
                el.style.top = Math.max(4, y - el.offsetHeight - 10) + 'px';
            },
            hide: function () { el.classList.remove('on'); }
        };
    };

    /* ----------------------------------------------------------- small math */

    NPLib.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

    NPLib.fmt = function (v, d) {
        if (!isFinite(v)) { return '--'; }
        return v.toFixed(d === undefined ? 2 : d);
    };

    /* Box-Muller. One call, one deviate: the discarded half costs nothing we
       can measure and the cached-pair version is a known source of
       correlation bugs when the simulation is reset mid-pair. */
    NPLib.gauss = function () {
        var u = 0, v = 0;
        while (u === 0) { u = Math.random(); }
        while (v === 0) { v = Math.random(); }
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    /* Mean, standard deviation (population) and coefficient of variation of a
       sample. Shared by the LIF figure and its self-test. */
    NPLib.stats = function (xs) {
        var n = xs.length;
        if (n === 0) { return { n: 0, mean: NaN, variance: NaN, sd: NaN, cv: NaN }; }
        var i, mean = 0, variance = 0;
        for (i = 0; i < n; i++) { mean += xs[i]; }
        mean /= n;
        for (i = 0; i < n; i++) { variance += (xs[i] - mean) * (xs[i] - mean); }
        variance /= n;
        var sd = Math.sqrt(variance);
        return { n: n, mean: mean, variance: variance, sd: sd, cv: mean === 0 ? NaN : sd / mean };
    };

    /* Successive differences: spike times -> inter-spike intervals. */
    NPLib.diff = function (xs) {
        var out = [];
        for (var i = 1; i < xs.length; i++) { out.push(xs[i] - xs[i - 1]); }
        return out;
    };

    /* Interpolate between two hex colours. Used for weight ramps. */
    NPLib.mix = function (a, b, t) {
        function hex(c) {
            c = c.trim();
            if (c[0] === '#') { c = c.slice(1); }
            if (c.length === 3) { c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; }
            return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
        }
        var ca = hex(a), cb = hex(b);
        t = NPLib.clamp(t, 0, 1);
        return 'rgb(' + Math.round(ca[0] + (cb[0] - ca[0]) * t) + ',' +
            Math.round(ca[1] + (cb[1] - ca[1]) * t) + ',' +
            Math.round(ca[2] + (cb[2] - ca[2]) * t) + ')';
    };

    /* A hex colour at a given alpha, for glows and fills. */
    NPLib.alpha = function (c, a) {
        c = c.trim();
        if (c[0] !== '#') { return c; }
        c = c.slice(1);
        if (c.length === 3) { c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2]; }
        return 'rgba(' + parseInt(c.slice(0, 2), 16) + ',' + parseInt(c.slice(2, 4), 16) + ',' +
            parseInt(c.slice(4, 6), 16) + ',' + a + ')';
    };

    global.NPLib = NPLib;
}(window));
