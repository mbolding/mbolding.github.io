/* ==========================================================================
   spin-ensemble.js — the engine behind the four "spheres and arrows" figures.

   One lattice of magnetic moments, each precessing at its own Larmor
   frequency, plus the vector sum that is the only thing a receive coil ever
   sees. Each page mounts it with a different preset so the same physics can
   be pointed at from four angles.
   ========================================================================== */

(function (global) {
    'use strict';

    var S = global.SpinLib;

    /* ------------------------------------------------------- control specs */

    var DEFS = {
        mode: {
            type: 'select',
            label: 'Ensemble state',
            options: [
                ['equilibrium', 'Thermal equilibrium (random phase)'],
                ['coherent', 'Coherent, identical fields'],
                ['dephasing', 'Coherent, spread of fields']
            ],
            hint: 'Resets the spins into the chosen starting state.'
        },
        n: {
            type: 'range', min: 2, max: 8, step: 1, value: 4,
            label: 'Lattice size',
            fmt: function (v) { return v + ' × ' + v + ' spins'; },
            hint: 'More spins average more smoothly, at the cost of clutter.'
        },
        spread: {
            type: 'range', min: 0, max: 20, step: 0.5, value: 2,
            label: 'Field inhomogeneity',
            fmt: function (v) { return '±' + v.toFixed(1) + ' Hz'; },
            hint: 'Spread of Larmor frequencies across the sample: the cause of T2*.'
        },
        t2: {
            type: 'range', min: 20, max: 2000, step: 20, value: 800,
            label: 'T₂ (irreversible)',
            fmt: function (v) { return v + ' ms'; },
            hint: 'True spin-spin decay. A 180° pulse cannot undo this part.'
        },
        t1: {
            type: 'range', min: 200, max: 4000, step: 100, value: 2500,
            label: 'T₁',
            fmt: function (v) { return v + ' ms'; },
            hint: 'Longitudinal recovery back to equilibrium.'
        },
        cone: {
            type: 'range', min: 0, max: 90, step: 1, value: 54,
            label: 'Equilibrium cone angle',
            fmt: function (v) { return v + '°'; },
            hint: 'Tilt of each individual moment off B₀ in the classical cartoon.'
        },
        speed: {
            type: 'range', min: 20, max: 1200, step: 10, value: 200,
            label: 'Playback speed',
            fmt: function (v) { return v + ' ms/s'; },
            hint: 'Simulated milliseconds per second of wall-clock time.'
        }
    };

    var BUTTONS = {
        play: { label: 'Pause', cls: 'primary' },
        p90: { label: '90°<sub>x</sub> pulse' },
        p180: { label: '180°<sub>x</sub> pulse' },
        echo: { label: 'Run a spin echo' },
        reset: { label: 'Reset' }
    };

    /* ------------------------------------------------------------- markup */

    function controlMarkup(key, def, value) {
        var id = 'ec_' + key;
        var out = '<div class="control">';
        if (def.type === 'select') {
            out += '<label for="' + id + '"><span>' + def.label + '</span></label>';
            out += '<select id="' + id + '">';
            for (var i = 0; i < def.options.length; i++) {
                var o = def.options[i];
                out += '<option value="' + o[0] + '"' + (o[0] === value ? ' selected' : '') + '>' + o[1] + '</option>';
            }
            out += '</select>';
        } else {
            out += '<label for="' + id + '"><span>' + def.label + '</span> <b id="' + id + 'Val"></b></label>';
            out += '<input type="range" id="' + id + '" min="' + def.min + '" max="' + def.max +
                '" step="' + def.step + '" value="' + value + '">';
        }
        if (def.hint) { out += '<span class="hint">' + def.hint + '</span>'; }
        return out + '</div>';
    }

    function build(host, cfg) {
        var html = '';

        html += '<div class="status" id="ec_status"></div>';

        html += '<div class="toolbar">';
        for (var i = 0; i < cfg.buttons.length; i++) {
            var key = cfg.buttons[i];
            var b = BUTTONS[key];
            if (!b) { continue; }
            html += '<button type="button" id="ec_' + key + '"' +
                (b.cls ? ' class="' + b.cls + '"' : '') + '>' + b.label + '</button>';
        }
        html += '</div>';

        html += '<div class="figs two">';
        html += '  <div class="fig">';
        html += '    <canvas id="ec_lattice" aria-label="Lattice of precessing magnetic moments"></canvas>';
        html += '    <p class="cap">Every sphere is a packet of spins at one place in the sample. Drag to rotate. ' +
            'Arrow colour encodes transverse phase.</p>';
        html += '  </div>';
        html += '  <div class="fig">';
        html += '    <canvas id="ec_net" aria-label="Net magnetisation vector"></canvas>';
        html += '    <p class="cap">The vector sum &mdash; the <em>only</em> thing the receive coil detects.</p>';
        if (cfg.showTrace) {
            html += '    <canvas id="ec_trace" style="margin-top:10px" aria-label="Transverse signal against time"></canvas>';
            html += '    <div class="legend"><span><i style="background:var(--c-mxy)"></i>|M<sub>xy</sub>| of the sum</span>' +
                '<span><i style="background:var(--c-env)"></i>T<sub>2</sub> envelope</span></div>';
        }
        html += '  </div>';
        html += '</div>';

        html += '<div class="panel"><h3>Parameters</h3><div class="controls">';
        for (i = 0; i < cfg.controls.length; i++) {
            var k = cfg.controls[i];
            if (!DEFS[k]) { continue; }
            var v = cfg.values && cfg.values[k] !== undefined ? cfg.values[k] : DEFS[k].value;
            html += controlMarkup(k, DEFS[k], v);
        }
        html += '</div>';
        html += '<div class="checkrow" style="margin-top:16px">' +
            '<label><input type="checkbox" id="ec_showNet" checked> <span>Draw the sum on the lattice</span></label>' +
            '<label><input type="checkbox" id="ec_showField" ' + (cfg.showField ? 'checked' : '') +
            '> <span>Shade spheres by field offset</span></label>' +
            '<label><input type="checkbox" id="ec_relax" ' + (cfg.relax === false ? '' : 'checked') +
            '> <span>Relaxation on</span></label>' +
            '</div>';
        html += '<div class="readouts">' +
            '<div class="readout"><span>|M<sub>xy</sub>| of sum</span><b id="ec_rMxy">0.000</b></div>' +
            '<div class="readout"><span>M<sub>z</sub> of sum</span><b id="ec_rMz">1.000</b></div>' +
            '<div class="readout"><span>spins</span><b id="ec_rN">16</b></div>' +
            '<div class="readout"><span>t</span><b id="ec_rT">0 ms</b></div>' +
            '</div>';
        html += '</div>';

        host.innerHTML = html;
    }

    /* ------------------------------------------------------------- physics */

    function rotX(m, a) {
        var c = Math.cos(a), s = Math.sin(a);
        return [m[0], m[1] * c - m[2] * s, m[2] * c + m[1] * s];
    }

    function rotY(m, a) {
        var c = Math.cos(a), s = Math.sin(a);
        return [m[0] * c + m[2] * s, m[1], m[2] * c - m[0] * s];
    }

    /* ---------------------------------------------------------------- mount */

    var SpinEnsemble = {};

    SpinEnsemble.mount = function (selector, cfg) {
        var host = document.querySelector(selector);
        if (!host) { return null; }

        cfg = cfg || {};
        cfg.controls = cfg.controls || ['mode', 'n', 'spread', 't2', 'speed'];
        cfg.buttons = cfg.buttons || ['play', 'p90', 'p180', 'reset'];
        cfg.values = cfg.values || {};
        cfg.showTrace = cfg.showTrace !== false;

        build(host, cfg);

        var mode = cfg.values.mode || cfg.mode || 'dephasing';
        var spins = [];
        var t = 0;
        var trace = new S.Trace(4000);
        var envelope = new S.Trace(4000);
        var marks = [];
        var lastExcite = 0;
        var pending = null;
        var WINDOW = 2000;
        var statusEl = document.getElementById('ec_status');

        function ctl(key, opts) {
            return document.getElementById('ec_' + key) ? S.bind('ec_' + key, opts) : null;
        }

        function val(key, fallback) {
            var c = controls[key];
            return c ? c.value : (cfg.values[key] !== undefined ? cfg.values[key] : fallback);
        }

        var controls = {};
        var rebuildKeys = { n: 1, mode: 1, cone: 1 };

        ['mode', 'n', 'spread', 't2', 't1', 'cone', 'speed'].forEach(function (key) {
            if (cfg.controls.indexOf(key) < 0) { return; }
            controls[key] = ctl(key, {
                fmt: DEFS[key].fmt,
                on: function (v) {
                    if (key === 'mode') {
                        mode = v;
                        /* keep the inhomogeneity slider honest about the mode */
                        if (controls.spread) {
                            if (v === 'coherent') { controls.spread.set(0); }
                            else if (controls.spread.value === 0) { controls.spread.set(2); }
                        }
                    }
                    if (rebuildKeys[key]) { init(); }
                }
            });
        });

        var showNet = ctl('showNet', {});
        var showField = ctl('showField', {});
        var relax = ctl('relax', {});

        /* ------------------------------------------------------ the spins */

        function init() {
            var n = Math.round(val('n', 4));
            var cone = val('cone', 54) * Math.PI / 180;
            spins = [];
            var spacing = 1.25;
            for (var i = 0; i < n; i++) {
                for (var j = 0; j < n; j++) {
                    /* fixed, unitless field weight in [-1, 1]: a linear ramp
                       across the sample plus a little local disorder, frozen
                       at creation so moving the spread slider rescales rather
                       than reshuffles */
                    var ramp = n > 1 ? (2 * i / (n - 1) - 1) : 0;
                    var w = S.clamp(0.62 * ramp + 0.38 * S.gauss() * 0.5, -1, 1);
                    var m;
                    if (mode === 'equilibrium') {
                        var az = Math.random() * Math.PI * 2;
                        m = [Math.sin(cone) * Math.cos(az), Math.sin(cone) * Math.sin(az), Math.cos(cone)];
                    } else {
                        m = [0, 0, 1];
                    }
                    spins.push({
                        pos: [(i - (n - 1) / 2) * spacing, (j - (n - 1) / 2) * spacing, 0],
                        w: w,
                        m: m
                    });
                }
            }
            t = 0;
            lastExcite = 0;
            pending = null;
            trace.clear();
            envelope.clear();
            marks.length = 0;

            if (mode === 'coherent') {
                applyPulse(90, 'x', true);
                status('After a 90° pulse. With a uniform field every spin keeps the same phase, ' +
                    'so the sum stays at full length and only T₂ shortens it.');
            } else if (mode === 'dephasing') {
                applyPulse(90, 'x', true);
                status('After a 90° pulse. The spins see different fields, so the phase fan opens and ' +
                    'the sum collapses at T₂*. Apply a 180° to bring it back.');
            } else {
                status('Thermal equilibrium: every moment precesses, but the phases are random, so the ' +
                    'transverse parts cancel and the coil sees nothing.');
            }
            layout();
            draw();
        }

        function applyPulse(deg, axis, quiet) {
            var a = deg * Math.PI / 180;
            for (var i = 0; i < spins.length; i++) {
                spins[i].m = axis === 'y' ? rotY(spins[i].m, a) : rotX(spins[i].m, a);
            }
            marks.push({ x: t, color: S.theme().b1, label: deg + '°' });
            if (marks.length > 30) { marks.shift(); }
            if (deg === 90) { lastExcite = t; }
            if (!quiet) {
                if (deg === 180) {
                    status('180° pulse: the phase fan is mirrored. Spins that ran ahead are now behind, ' +
                        'so they walk back into step and the sum grows again.');
                } else {
                    status('90° pulse: all the magnetisation is now transverse and in phase.');
                }
            }
        }

        function status(html) { if (statusEl) { statusEl.innerHTML = html; } }

        function step(dtMs) {
            var spread = val('spread', 25);
            var t2 = val('t2', 800);
            var t1 = val('t1', 2500);
            var doRelax = relax ? relax.value : true;
            var e2 = Math.exp(-dtMs / t2);
            var e1 = Math.exp(-dtMs / t1);

            for (var i = 0; i < spins.length; i++) {
                var sp = spins[i];
                var dphi = 2 * Math.PI * (spread * sp.w) * dtMs / 1000;
                var c = Math.cos(dphi), s = Math.sin(dphi);
                var mx = sp.m[0] * c - sp.m[1] * s;
                var my = sp.m[0] * s + sp.m[1] * c;
                sp.m[0] = mx;
                sp.m[1] = my;
                if (doRelax) {
                    sp.m[0] *= e2;
                    sp.m[1] *= e2;
                    sp.m[2] = 1 + (sp.m[2] - 1) * e1;
                }
            }

            t += dtMs;

            if (pending && t >= pending.at) {
                applyPulse(pending.deg, 'x');
                pending = null;
            }

            var net = netVector();
            trace.push(t, Math.hypot(net[0], net[1]));
            envelope.push(t, doRelax ? Math.exp(-(t - lastExcite) / t2) : 1);
        }

        function netVector() {
            var x = 0, y = 0, z = 0;
            for (var i = 0; i < spins.length; i++) {
                x += spins[i].m[0];
                y += spins[i].m[1];
                z += spins[i].m[2];
            }
            var n = spins.length || 1;
            return [x / n, y / n, z / n];
        }

        /* ------------------------------------------------------- rendering */

        var latticeCanvas = document.getElementById('ec_lattice');
        var netCanvas = document.getElementById('ec_net');
        var traceCanvas = document.getElementById('ec_trace');

        var camL = new S.Camera({ yaw: -0.65, pitch: 0.42 });
        var camN = new S.Camera({ yaw: -0.65, pitch: 0.30 });

        var vL = S.fitCanvas(latticeCanvas, 0.66, layout);
        var vN = S.fitCanvas(netCanvas, 0.82, function (w, h) {
            camN.cx = w / 2;
            camN.cy = h / 2;
            camN.scale = Math.min(w, h) * 0.33;
        });
        var vT = traceCanvas ? S.fitCanvas(traceCanvas, 0.42) : null;

        /* fitCanvas calls this during its first fit, before vL has been
           assigned, so take the size from the arguments when they are there */
        function layout(w, h) {
            w = w || (vL && vL.w);
            h = h || (vL && vL.h);
            if (!w || !h) { return; }
            var n = Math.round(val('n', 4));
            var half = 1.25 * (n - 1) / 2;
            var radius = half + 2.0;
            camL.cx = w / 2;
            camL.cy = h / 2;
            camL.scale = Math.min(w, h) * 0.52 / radius;
            camL.f = radius * 4.5;
        }

        S.orbit(latticeCanvas, camL, function () { if (!loop.running) { draw(); } });
        S.orbit(netCanvas, camN, function () { if (!loop.running) { draw(); } });

        function drawLattice() {
            var ctx = vL.ctx, th = S.theme();
            S.clear(ctx, vL.w, vL.h);

            /* B0 marker */
            var n = Math.round(val('n', 4));
            var half = 1.25 * (n - 1) / 2;
            S.arrow3(ctx, camL, [-half - 0.8, -half - 0.8, -0.6], [-half - 0.8, -half - 0.8, 1.4],
                { color: th.b0, width: 2, alpha: 0.7 });
            S.label3(ctx, camL, [-half - 0.8, -half - 0.8, 1.6], 'B0', th.b0);

            /* lattice guide lines: without them an obliquely viewed grid of
               spheres reads as a random scatter */
            var side = Math.round(Math.sqrt(spins.length));
            ctx.save();
            ctx.strokeStyle = th.grid;
            ctx.lineWidth = 1;
            for (var gi = 0; gi < side; gi++) {
                var p0 = camL.project([(gi - (side - 1) / 2) * 1.25, -half, 0]);
                var p1 = camL.project([(gi - (side - 1) / 2) * 1.25, half, 0]);
                var q0 = camL.project([-half, (gi - (side - 1) / 2) * 1.25, 0]);
                var q1 = camL.project([half, (gi - (side - 1) / 2) * 1.25, 0]);
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.moveTo(q0.x, q0.y);
                ctx.lineTo(q1.x, q1.y);
                ctx.stroke();
            }
            ctx.restore();

            /* depth sort so near spheres occlude far ones */
            var items = spins.slice().sort(function (a, b) {
                return camL.project(b.pos).d - camL.project(a.pos).d;
            });

            var spread = val('spread', 25);
            var useField = showField && showField.value;

            for (var i = 0; i < items.length; i++) {
                var sp = items[i];
                var m = sp.m;
                var mxy = Math.hypot(m[0], m[1]);
                var colour = mxy > 0.03 ? S.phaseColor(Math.atan2(m[1], m[0])) : th.spin;
                var ballColour = th.spin;
                if (useField) {
                    var f = (sp.w + 1) / 2;
                    var d = Math.abs(f - 0.5) * 2;
                    ballColour = 'hsl(' + (f < 0.5 ? 214 : 4) + ', ' +
                        (18 + d * 62).toFixed(0) + '%, ' + (66 - d * 18).toFixed(0) + '%)';
                }
                S.ball(ctx, camL, sp.pos, 0.17, ballColour, useField ? 0.9 : 0.55);
                S.arrow3(ctx, camL, sp.pos,
                    [sp.pos[0] + m[0] * 0.85, sp.pos[1] + m[1] * 0.85, sp.pos[2] + m[2] * 0.85],
                    { color: colour, width: 2.2 });
            }

            if (showNet && showNet.value) {
                var net = netVector();
                var origin = [0, 0, -1.95];
                ctx.save();
                ctx.setLineDash([3, 4]);
                ctx.strokeStyle = th.border;
                ctx.lineWidth = 1;
                var a = camL.project([0, 0, 0]);
                var b = camL.project(origin);
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.stroke();
                ctx.restore();
                S.arrow3(ctx, camL, origin,
                    [origin[0] + net[0] * 1.6, origin[1] + net[1] * 1.6, origin[2] + net[2] * 1.6],
                    { color: th.net, width: 4 });
                S.label3(ctx, camL, [0, 0, -2.25], 'vector sum', th.net);
            }

            if (spread === 0) {
                ctx.save();
                ctx.fillStyle = th.muted;
                ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText('uniform field — no dephasing', 10, 10);
                ctx.restore();
            }
        }

        function drawNet() {
            var ctx = vN.ctx, th = S.theme();
            S.clear(ctx, vN.w, vN.h);
            S.circle3(ctx, camN, 1, 0, { color: th.border });
            S.axes3(ctx, camN, 1.2);

            var net = netVector();
            /* faint ghosts of the individual moments, all drawn from one origin:
               the classic phase fan */
            ctx.save();
            for (var i = 0; i < spins.length; i++) {
                S.arrow3(ctx, camN, [0, 0, 0], spins[i].m, { color: th.spin, width: 1, alpha: 0.3 });
            }
            ctx.restore();

            S.arrow3(ctx, camN, [0, 0, 0], net, { color: th.net, width: 3.6 });
            S.label3(ctx, camN, [net[0] * 1.2, net[1] * 1.2, net[2] * 1.2 + 0.08], 'M', th.net);
        }

        function drawTrace() {
            if (!vT) { return; }
            var ctx = vT.ctx, th = S.theme();
            S.clear(ctx, vT.w, vT.h);
            var box = { x: 36, y: 12, w: vT.w - 50, h: vT.h - 38 };
            var xmax = Math.max(t, WINDOW * 0.3);
            S.plot(ctx, box, {
                xmin: xmax - WINDOW, xmax: xmax, ymin: 0, ymax: 1.05,
                yTicks: [0.5, 1],
                marks: marks,
                series: [
                    { pts: envelope.pts, color: th.env, width: 1.4, dash: [4, 4] },
                    { pts: trace.pts, color: th.mxy, width: 2.2 }
                ],
                xlabel: 'time (ms)',
                ylabel: '|Mxy|'
            });
        }

        var rMxy = document.getElementById('ec_rMxy');
        var rMz = document.getElementById('ec_rMz');
        var rN = document.getElementById('ec_rN');
        var rT = document.getElementById('ec_rT');

        function draw() {
            drawLattice();
            drawNet();
            drawTrace();
            var net = netVector();
            rMxy.textContent = S.fmt(Math.hypot(net[0], net[1]), 3);
            rMz.textContent = S.fmt(net[2], 3);
            rN.textContent = String(spins.length);
            rT.textContent = S.fmt(t, 0) + ' ms';
        }

        /* ---------------------------------------------------------- loop */

        var loop = new S.Loop(function (dt) {
            var simMs = dt * val('speed', 200);
            var steps = Math.max(1, Math.ceil(simMs / 4));
            for (var i = 0; i < steps; i++) { step(simMs / steps); }
            draw();
        });

        var playBtn = document.getElementById('ec_play');
        if (playBtn) {
            playBtn.addEventListener('click', function () {
                playBtn.textContent = loop.toggle() ? 'Pause' : 'Play';
            });
        }

        S.on('ec_p90', function () { applyPulse(90, 'x'); draw(); });
        S.on('ec_p180', function () { applyPulse(180, 'x'); draw(); });
        S.on('ec_reset', function () { init(); });

        S.on('ec_echo', function () {
            /* 90 now, 180 one tau later; the echo forms at 2 tau */
            init();
            var tau = 400;
            status('Spin echo running: 90°, then a 180° pulse at ' + tau +
                ' ms. Watch the sum collapse, then rebuild at ' + (2 * tau) + ' ms.');
            loop.start();
            if (playBtn) { playBtn.textContent = 'Pause'; }
            pending = { at: t + tau, deg: 180 };
        });

        window.addEventListener('spins:theme', draw);

        init();
        if (cfg.autoplay !== false) {
            loop.start();
        } else if (playBtn) {
            playBtn.textContent = 'Play';
        }

        return { loop: loop, init: init, draw: draw };
    };

    global.SpinEnsemble = SpinEnsemble;
}(window));
