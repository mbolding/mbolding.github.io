/* ==========================================================================
   spin-lib.js — shared plumbing for the MRI spin-physics demos.

   Deliberately dependency-free: every figure in this directory opens from a
   file:// path, a laptop with no network, or a lecture-hall machine that has
   never heard of npm. Keep it that way.
   ========================================================================== */

(function (global) {
    'use strict';

    var SpinLib = {};

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
            accent: v('--accent', '#ff3300'),
            border: v('--border', '#e0e0e0'),
            grid: v('--grid', '#e8e8e8'),
            panel: v('--panel', '#f5f5f5'),
            canvasBg: v('--canvas-bg', '#fff'),
            mz: v('--c-mz', '#1d4ed8'),
            mxy: v('--c-mxy', '#0f9d58'),
            net: v('--c-net', '#ff3300'),
            spin: v('--c-spin', '#4a6fa5'),
            b0: v('--c-b0', '#8b5cf6'),
            b1: v('--c-b1', '#d97706'),
            env: v('--c-env', '#9ca3af'),
            up: v('--c-up', '#d92b2b'),
            down: v('--c-down', '#1f5fd0')
        };
        return themeCache;
    }

    SpinLib.theme = function () { return themeCache || readTheme(); };

    function announceTheme() {
        readTheme();
        global.dispatchEvent(new CustomEvent('spins:theme'));
    }

    /* Applies the stored preference. Call from an inline <head> script so the
       page never flashes the wrong palette. */
    SpinLib.applyStoredTheme = function () {
        try {
            var t = localStorage.getItem('spins-theme');
            if (t === 'dark' || t === 'light') {
                document.documentElement.setAttribute('data-theme', t);
            }
        } catch (e) { /* private browsing: fall back to the media query */ }
    };

    SpinLib.wireThemeToggle = function () {
        var btn = document.querySelector('.theme-toggle');
        if (!btn) { return; }
        function label() {
            var explicit = document.documentElement.getAttribute('data-theme');
            var dark = explicit
                ? explicit === 'dark'
                : global.matchMedia('(prefers-color-scheme: dark)').matches;
            btn.textContent = dark ? 'Light' : 'Dark';
            btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
        }
        btn.addEventListener('click', function () {
            var explicit = document.documentElement.getAttribute('data-theme');
            var dark = explicit
                ? explicit === 'dark'
                : global.matchMedia('(prefers-color-scheme: dark)').matches;
            var next = dark ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('spins-theme', next); } catch (e) { /* ignore */ }
            label();
            announceTheme();
        });
        var mq = global.matchMedia('(prefers-color-scheme: dark)');
        var onMq = function () { label(); announceTheme(); };
        if (mq.addEventListener) { mq.addEventListener('change', onMq); }
        else if (mq.addListener) { mq.addListener(onMq); }
        label();
    };

    /* ---------------------------------------------------------------- canvas */

    /* Sizes a canvas to its CSS width at a fixed aspect ratio, honouring
       devicePixelRatio so arrowheads and 1px rules stay crisp. */
    SpinLib.fitCanvas = function (canvas, aspect, onResize) {
        var ctx = canvas.getContext('2d');
        var state = { ctx: ctx, w: 0, h: 0 };

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

    SpinLib.clear = function (ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = SpinLib.theme().canvasBg;
        ctx.fillRect(0, 0, w, h);
    };

    /* ------------------------------------------------------------ 3D camera */

    function Camera(opts) {
        opts = opts || {};
        this.yaw = opts.yaw !== undefined ? opts.yaw : -0.62;
        this.pitch = opts.pitch !== undefined ? opts.pitch : 0.30;
        this.scale = opts.scale || 90;
        this.f = opts.f || 11;
        this.cx = 0;
        this.cy = 0;
    }

    /* World axes: z is B0 (up on screen at pitch 0), x and y span the
       transverse plane. Returns screen x/y, view depth and the perspective
       factor so callers can shrink distant spheres. */
    Camera.prototype.project = function (p) {
        var ca = Math.cos(this.yaw), sa = Math.sin(this.yaw);
        var x1 = p[0] * ca - p[1] * sa;
        var y1 = p[0] * sa + p[1] * ca;
        var z1 = p[2];
        var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
        var up = z1 * cp - y1 * sp;
        var depth = z1 * sp + y1 * cp;
        var k = this.f / (this.f + depth);
        return {
            x: this.cx + x1 * this.scale * k,
            y: this.cy - up * this.scale * k,
            d: depth,
            k: k
        };
    };

    SpinLib.Camera = Camera;

    /* Click-drag (or touch-drag) to orbit. */
    SpinLib.orbit = function (canvas, cam, onChange) {
        var dragging = false, lastX = 0, lastY = 0;

        canvas.style.cursor = 'grab';

        canvas.addEventListener('pointerdown', function (e) {
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            canvas.setPointerCapture(e.pointerId);
            canvas.style.cursor = 'grabbing';
        });

        canvas.addEventListener('pointermove', function (e) {
            if (!dragging) { return; }
            cam.yaw += (e.clientX - lastX) * 0.010;
            cam.pitch += (e.clientY - lastY) * 0.008;
            cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch));
            lastX = e.clientX;
            lastY = e.clientY;
            if (onChange) { onChange(); }
        });

        function end(e) {
            if (!dragging) { return; }
            dragging = false;
            try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            canvas.style.cursor = 'grab';
        }

        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
    };

    /* -------------------------------------------------------- draw helpers */

    SpinLib.arrow2 = function (ctx, x0, y0, x1, y1, opts) {
        opts = opts || {};
        var color = opts.color || SpinLib.theme().fg;
        var width = opts.width || 2;
        var head = opts.head !== undefined ? opts.head : Math.max(6, width * 3.2);
        var dx = x1 - x0, dy = y1 - y0;
        var len = Math.hypot(dx, dy);

        ctx.save();
        ctx.globalAlpha = opts.alpha !== undefined ? opts.alpha : 1;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        if (opts.dash) { ctx.setLineDash(opts.dash); }

        if (len < 0.6) {
            /* degenerate vector: a dot still shows the reader it is there */
            ctx.beginPath();
            ctx.arc(x0, y0, width * 0.9, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            return;
        }

        var ux = dx / len, uy = dy / len;
        var hl = Math.min(head, len * 0.45);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1 - ux * hl * 0.85, y1 - uy * hl * 0.85);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * hl - uy * hl * 0.42, y1 - uy * hl + ux * hl * 0.42);
        ctx.lineTo(x1 - ux * hl + uy * hl * 0.42, y1 - uy * hl - ux * hl * 0.42);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    };

    SpinLib.arrow3 = function (ctx, cam, from, to, opts) {
        opts = opts || {};
        var a = cam.project(from);
        var b = cam.project(to);
        var o = {
            color: opts.color,
            width: opts.width || 2.5,
            alpha: opts.alpha,
            dash: opts.dash,
            head: opts.head !== undefined ? opts.head : 9 * ((a.k + b.k) / 2)
        };
        SpinLib.arrow2(ctx, a.x, a.y, b.x, b.y, o);
        return b;
    };

    SpinLib.ball = function (ctx, cam, p, r, color, alpha) {
        var s = cam.project(p);
        var rad = Math.max(1.2, r * cam.scale * s.k);
        var g = ctx.createRadialGradient(
            s.x - rad * 0.35, s.y - rad * 0.4, rad * 0.1,
            s.x, s.y, rad
        );
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(0.45, color);
        g.addColorStop(1, 'rgba(0,0,0,0.25)');
        ctx.save();
        ctx.globalAlpha = alpha !== undefined ? alpha : 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return s;
    };

    SpinLib.label3 = function (ctx, cam, p, text, color, opts) {
        opts = opts || {};
        var s = cam.project(p);
        ctx.save();
        ctx.fillStyle = color || SpinLib.theme().muted;
        ctx.font = (opts.font || '600 12px "IBM Plex Mono", ui-monospace, monospace');
        ctx.textAlign = opts.align || 'center';
        ctx.textBaseline = opts.baseline || 'middle';
        ctx.fillText(text, s.x + (opts.dx || 0), s.y + (opts.dy || 0));
        ctx.restore();
    };

    /* A dashed circle of radius r in the transverse (x-y) plane at height z. */
    SpinLib.circle3 = function (ctx, cam, r, z, opts) {
        opts = opts || {};
        var th = SpinLib.theme();
        ctx.save();
        ctx.strokeStyle = opts.color || th.border;
        ctx.lineWidth = opts.width || 1;
        ctx.globalAlpha = opts.alpha !== undefined ? opts.alpha : 1;
        if (opts.dash !== null) { ctx.setLineDash(opts.dash || [4, 4]); }
        ctx.beginPath();
        for (var i = 0; i <= 72; i++) {
            var a = (i / 72) * Math.PI * 2;
            var s = cam.project([r * Math.cos(a), r * Math.sin(a), z]);
            if (i === 0) { ctx.moveTo(s.x, s.y); } else { ctx.lineTo(s.x, s.y); }
        }
        ctx.stroke();
        ctx.restore();
    };

    /* Standard x / y / z frame with labels. */
    SpinLib.axes3 = function (ctx, cam, len, opts) {
        opts = opts || {};
        var th = SpinLib.theme();
        var c = opts.color || th.border;
        var lc = opts.labelColor || th.muted;
        var names = opts.names || ["x'", "y'", 'z'];
        var axes = [
            [[len, 0, 0], names[0]],
            [[0, len, 0], names[1]],
            [[0, 0, len], names[2]]
        ];
        for (var i = 0; i < axes.length; i++) {
            var neg = [-axes[i][0][0], -axes[i][0][1], -axes[i][0][2]];
            var a = cam.project(neg);
            var b = cam.project(axes[i][0]);
            ctx.save();
            ctx.strokeStyle = c;
            ctx.lineWidth = 1;
            ctx.setLineDash(i === 2 ? [] : [3, 3]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.restore();
            SpinLib.label3(ctx, cam, [
                axes[i][0][0] * 1.16, axes[i][0][1] * 1.16, axes[i][0][2] * 1.16
            ], axes[i][1], lc);
        }
    };

    /* ------------------------------------------------------------- plotting */

    /* Minimal x-y plot. box is {x,y,w,h} in CSS pixels. */
    SpinLib.plot = function (ctx, box, spec) {
        var th = SpinLib.theme();
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

        /* zero line */
        if (ymin < 0 && ymax > 0) {
            ctx.strokeStyle = th.border;
            ctx.beginPath();
            ctx.moveTo(box.x, sy(0));
            ctx.lineTo(box.x + box.w, sy(0));
            ctx.stroke();
        }

        /* vertical markers, e.g. pulse times */
        var m, lastLabelX = -1e9, labelDy = 3;
        if (spec.marks) {
            for (i = 0; i < spec.marks.length; i++) {
                m = spec.marks[i];
                if (m.x < xmin || m.x > xmax) { continue; }
                ctx.save();
                ctx.strokeStyle = m.color || th.muted;
                ctx.setLineDash(m.dash || [3, 3]);
                ctx.beginPath();
                ctx.moveTo(sx(m.x), box.y);
                ctx.lineTo(sx(m.x), box.y + box.h);
                ctx.stroke();
                ctx.restore();
                if (m.label) {
                    labelDy = Math.abs(sx(m.x) - lastLabelX) < 26 ? labelDy + 11 : 3;
                    if (labelDy > 25) { labelDy = 3; }
                    lastLabelX = sx(m.x);
                    ctx.fillStyle = m.color || th.muted;
                    ctx.font = '600 10px "IBM Plex Mono", ui-monospace, monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillText(m.label, sx(m.x), box.y + labelDy);
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

        /* numeric tick labels, opt-in */
        if (spec.tickLabels) {
            ctx.fillStyle = th.muted;
            ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
            if (spec.xTicks) {
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                for (i = 0; i < spec.xTicks.length; i++) {
                    ctx.fillText(String(spec.xTicks[i]), sx(spec.xTicks[i]), box.y + box.h + 4);
                }
            }
            if (spec.yTicks) {
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                for (i = 0; i < spec.yTicks.length; i++) {
                    ctx.fillText(String(spec.yTicks[i]), box.x - 5, sy(spec.yTicks[i]));
                }
            }
        }

        /* scatter points, e.g. measured echo peaks */
        var pt;
        if (spec.points) {
            for (i = 0; i < spec.points.length; i++) {
                s = spec.points[i];
                if (!s.pts) { continue; }
                ctx.save();
                ctx.fillStyle = s.color || th.fg;
                for (j = 0; j < s.pts.length; j++) {
                    pt = s.pts[j];
                    if (pt[0] < xmin || pt[0] > xmax) { continue; }
                    ctx.beginPath();
                    ctx.arc(sx(pt[0]), sy(pt[1]), s.r || 3, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        }

        /* axis labels */
        ctx.fillStyle = th.muted;
        ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
        if (spec.xlabel) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'top';
            ctx.fillText(spec.xlabel, box.x + box.w, box.y + box.h + 5);
        }
        if (spec.ylabel) {
            ctx.save();
            ctx.translate(Math.max(10, box.x - 26), box.y + box.h / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(spec.ylabel, 0, 0);
            ctx.restore();
        }

        ctx.restore();
        return { sx: sx, sy: sy };
    };

    /* Rolling sample buffer for signal traces. */
    function Trace(max) {
        this.pts = [];
        this.max = max || 4000;
    }
    Trace.prototype.push = function (x, y) {
        this.pts.push([x, y]);
        if (this.pts.length > this.max) { this.pts.shift(); }
    };
    Trace.prototype.clear = function () { this.pts.length = 0; };
    SpinLib.Trace = Trace;

    /* ------------------------------------------------------------ animation */

    /* rAF loop with a clamped timestep, so tabbing away and back does not
       teleport the physics. */
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
    SpinLib.Loop = Loop;

    /* ------------------------------------------------------------- controls */

    /* Wires <input id="foo"> to its <b id="fooVal"> readout. opts.scale maps
       the slider integer to a physical value; opts.fmt renders it. */
    SpinLib.bind = function (id, opts) {
        opts = opts || {};
        var el = document.getElementById(id);
        var out = document.getElementById(id + 'Val');
        var scale = opts.scale || function (v) { return v; };
        var fmt = opts.fmt || function (v) { return String(v); };

        var api = {
            el: el,
            value: 0,
            set: function (raw) { el.value = raw; api.refresh(); },
            refresh: function () {
                if (el.type === 'checkbox') {
                    api.value = el.checked;
                } else if (el.tagName === 'SELECT') {
                    /* selects carry string values unless the caller says otherwise */
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

    SpinLib.on = function (id, fn) {
        var el = document.getElementById(id);
        if (el) { el.addEventListener('click', fn); }
        return el;
    };

    /* ----------------------------------------------------------- small math */

    SpinLib.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

    SpinLib.fmt = function (v, d) {
        if (!isFinite(v)) { return '--'; }
        return v.toFixed(d === undefined ? 2 : d);
    };

    /* Phase -> hue. Used everywhere a spin's phase is colour-coded, so the
       colour wheel means the same thing in every figure. */
    SpinLib.phaseColor = function (phase, light) {
        var deg = ((phase * 180 / Math.PI) % 360 + 360) % 360;
        return 'hsl(' + deg.toFixed(0) + ', 72%, ' + (light || 52) + '%)';
    };

    /* Box-Muller, for field maps that need a normal deviate. */
    SpinLib.gauss = function () {
        var u = 0, v = 0;
        while (u === 0) { u = Math.random(); }
        while (v === 0) { v = Math.random(); }
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };

    global.SpinLib = SpinLib;
}(window));
