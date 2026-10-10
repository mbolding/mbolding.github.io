/* ============================================================
   MRI Simulator — core
   Namespace, physical constants, the shared FFT, a seeded RNG,
   the event bus, the tab registry and the canvas helpers every
   other module leans on.

   Classic script, no ES modules, so the page still works when it
   is opened straight from disk. Everything hangs off window.MRI.
   Nothing in this file touches the DOM at load time, so it can be
   loaded into Node for testing (see tests/harness.js).
   ============================================================ */
(function (root) {
    'use strict';

    var MRI = root.MRI = root.MRI || {};
    MRI.version = '1.0.0';

    /* ---------- Physical constants and the 3 T system ----------
       All internal quantities are SI: seconds, metres, tesla, T/m,
       hertz. Flip angles and RF phases are the one exception and
       stay in degrees, because that is how everyone talks about
       them. */
    var GAMMA_BAR = 42.577478e6;           // 1H gyromagnetic ratio / 2pi, Hz/T
    var B0 = 3.0;                          // T
    var F0 = GAMMA_BAR * B0;               // Larmor frequency, Hz (about 127.73 MHz)
    MRI.const = {
        GAMMA_BAR: GAMMA_BAR,
        GAMMA: 2 * Math.PI * GAMMA_BAR,    // rad/s/T
        B0: B0,
        F0: F0,
        GMAX: 0.045,                       // T/m   (45 mT/m, a typical clinical 3 T system)
        SLEW: 200,                         // T/m/s
        GRAD_RASTER: 10e-6,                // s
        RF_RASTER: 1e-6,                   // s
        WATER_PPM: 4.7,                    // water resonance, ppm (the receiver carrier sits here)
        FAT_PPM: -3.4,                     // main fat (CH2, 1.3 ppm) relative to water, ppm
        FAT_HZ: -3.4e-6 * F0,              // about -434 Hz at 3 T
        PPM_HZ: 1e-6 * F0                  // one ppm in Hz at 3 T (about 127.7 Hz)
    };

    /* ---------- Small numeric helpers ---------- */
    var U = MRI.util = {};

    U.clamp = function (x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); };
    U.lerp = function (a, b, t) { return a + (b - a) * t; };
    U.isPow2 = function (n) { return n > 0 && (n & (n - 1)) === 0; };
    U.nextPow2 = function (n) { var p = 1; while (p < n) p <<= 1; return p; };
    U.linspace = function (a, b, n) {
        var out = new Float64Array(n);
        for (var i = 0; i < n; i++) out[i] = n === 1 ? a : a + (b - a) * i / (n - 1);
        return out;
    };
    U.sinc = function (x) {            // normalised: sin(pi x)/(pi x)
        if (Math.abs(x) < 1e-8) return 1;
        var px = Math.PI * x;
        return Math.sin(px) / px;
    };

    /* Seeded PRNG (mulberry32). Every stochastic thing in the simulator
       takes a seed so that a scan is reproducible: the same settings give
       the same noise, which matters when you are comparing two images. */
    U.rng = function (seed) {
        var a = (seed >>> 0) || 0x9e3779b9;
        var spare = null;
        var r = function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        r.randn = function () {             // standard normal, Box-Muller with a spare
            if (spare !== null) { var s = spare; spare = null; return s; }
            var u = 0, v = 0;
            while (u <= 1e-12) u = r();
            v = r();
            var m = Math.sqrt(-2 * Math.log(u));
            spare = m * Math.sin(2 * Math.PI * v);
            return m * Math.cos(2 * Math.PI * v);
        };
        return r;
    };

    U.percentile = function (arr, p) {
        var n = arr.length;
        if (!n) return 0;
        // Sample for speed on big images; percentiles are only used for display windows.
        var step = Math.max(1, Math.floor(n / 20000));
        var tmp = [];
        for (var i = 0; i < n; i += step) { var v = arr[i]; if (isFinite(v)) tmp.push(v); }
        if (!tmp.length) return 0;
        tmp.sort(function (a, b) { return a - b; });
        var idx = U.clamp(Math.round((p / 100) * (tmp.length - 1)), 0, tmp.length - 1);
        return tmp[idx];
    };

    /* ---------- FFT ----------
       Complex data is always held as two separate arrays, re and im.
       2D arrays are row-major, index = iy * nx + ix.
       fft() works for any length: radix-2 when the length is a power of
       two, Bluestein's chirp-z otherwise (matrices like 96 or 192 are
       legitimate teaching choices). Forward is unnormalised; inverse
       divides by n. */
    var twiddleCache = {};
    function twiddles(n) {
        var t = twiddleCache[n];
        if (t) return t;
        t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
        for (var i = 0; i < n / 2; i++) {
            t.cos[i] = Math.cos(2 * Math.PI * i / n);
            t.sin[i] = Math.sin(2 * Math.PI * i / n);
        }
        twiddleCache[n] = t;
        return t;
    }

    function fftRadix2(re, im, inverse) {
        var n = re.length, i, j, k, len, half, step, tr, ti, ur, ui, wr, wi;
        for (i = 1, j = 0; i < n; i++) {
            var bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                tr = re[i]; re[i] = re[j]; re[j] = tr;
                tr = im[i]; im[i] = im[j]; im[j] = tr;
            }
        }
        var tw = twiddles(n), sgn = inverse ? 1 : -1;
        for (len = 2; len <= n; len <<= 1) {
            half = len >> 1;
            step = n / len;
            for (i = 0; i < n; i += len) {
                for (k = 0; k < half; k++) {
                    wr = tw.cos[k * step];
                    wi = sgn * tw.sin[k * step];
                    var a = i + k, b = a + half;
                    tr = re[b] * wr - im[b] * wi;
                    ti = re[b] * wi + im[b] * wr;
                    ur = re[a]; ui = im[a];
                    re[a] = ur + tr; im[a] = ui + ti;
                    re[b] = ur - tr; im[b] = ui - ti;
                }
            }
        }
    }

    var bluesteinCache = {};
    function fftBluestein(re, im, inverse) {
        var n = re.length, m = U.nextPow2(2 * n - 1), sgn = inverse ? 1 : -1, i;
        var key = n + (inverse ? 'i' : 'f');
        var c = bluesteinCache[key];
        if (!c) {
            c = { wr: new Float64Array(n), wi: new Float64Array(n), br: new Float64Array(m), bi: new Float64Array(m) };
            for (i = 0; i < n; i++) {
                var ang = sgn * Math.PI * ((i * i) % (2 * n)) / n;
                c.wr[i] = Math.cos(ang); c.wi[i] = Math.sin(ang);
            }
            c.br[0] = c.wr[0]; c.bi[0] = -c.wi[0];
            for (i = 1; i < n; i++) {
                c.br[i] = c.br[m - i] = c.wr[i];
                c.bi[i] = c.bi[m - i] = -c.wi[i];
            }
            fftRadix2(c.br, c.bi, false);
            bluesteinCache[key] = c;
        }
        var ar = new Float64Array(m), ai = new Float64Array(m);
        for (i = 0; i < n; i++) {
            ar[i] = re[i] * c.wr[i] - im[i] * c.wi[i];
            ai[i] = re[i] * c.wi[i] + im[i] * c.wr[i];
        }
        fftRadix2(ar, ai, false);
        for (i = 0; i < m; i++) {
            var xr = ar[i] * c.br[i] - ai[i] * c.bi[i];
            var xi = ar[i] * c.bi[i] + ai[i] * c.br[i];
            ar[i] = xr; ai[i] = xi;
        }
        fftRadix2(ar, ai, true);            // unnormalised inverse: divide by m below
        for (i = 0; i < n; i++) {
            var cr = ar[i] / m, ci = ai[i] / m;
            re[i] = cr * c.wr[i] - ci * c.wi[i];
            im[i] = cr * c.wi[i] + ci * c.wr[i];
        }
    }

    /* In-place 1D FFT on any typed or plain array pair. */
    U.fft = function (re, im, inverse) {
        var n = re.length, i;
        if (n <= 1) return;
        if (U.isPow2(n)) fftRadix2(re, im, inverse);
        else fftBluestein(re, im, inverse);
        if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };

    /* In-place 2D FFT (rows then columns), uncentred. */
    U.fft2 = function (re, im, nx, ny, inverse) {
        var x, y, rr = new Float64Array(nx), ri = new Float64Array(nx);
        for (y = 0; y < ny; y++) {
            var o = y * nx;
            for (x = 0; x < nx; x++) { rr[x] = re[o + x]; ri[x] = im[o + x]; }
            U.fft(rr, ri, inverse);
            for (x = 0; x < nx; x++) { re[o + x] = rr[x]; im[o + x] = ri[x]; }
        }
        var cr = new Float64Array(ny), ci = new Float64Array(ny);
        for (x = 0; x < nx; x++) {
            for (y = 0; y < ny; y++) { cr[y] = re[y * nx + x]; ci[y] = im[y * nx + x]; }
            U.fft(cr, ci, inverse);
            for (y = 0; y < ny; y++) { re[y * nx + x] = cr[y]; im[y * nx + x] = ci[y]; }
        }
    };

    /* fftshift / ifftshift for 2D arrays (handle odd sizes correctly).
       Returns new arrays of the same type. */
    function shift2(a, nx, ny, sx, sy) {
        var out = new a.constructor(a.length);
        for (var y = 0; y < ny; y++) {
            var yy = (y + sy) % ny;
            for (var x = 0; x < nx; x++) out[yy * nx + (x + sx) % nx] = a[y * nx + x];
        }
        return out;
    }
    U.fftshift2 = function (a, nx, ny) { return shift2(a, nx, ny, Math.floor(nx / 2), Math.floor(ny / 2)); };
    U.ifftshift2 = function (a, nx, ny) { return shift2(a, nx, ny, Math.ceil(nx / 2), Math.ceil(ny / 2)); };
    U.fftshift1 = function (a) {
        var n = a.length, s = Math.floor(n / 2), out = new a.constructor(n);
        for (var i = 0; i < n; i++) out[(i + s) % n] = a[i];
        return out;
    };

    /* Centred 2D transforms. Index convention, used everywhere in the
       simulator: array index i <-> coordinate (i - floor(n/2)) * delta,
       for image pixels and for k-space samples alike. So k = 0 sits at
       index floor(n/2), and so does x = 0.
         fft2c:  image  -> k-space   K = fftshift(fft(ifftshift(x)))
         ifft2c: k-space -> image    x = fftshift(ifft(ifftshift(K)))
       Both return {re, im} as new Float64Arrays; inputs are untouched.
       ifft2c includes the 1/(nx*ny) normalisation; fft2c does not. */
    U.fft2c = function (re, im, nx, ny) {
        var r = U.ifftshift2(Float64Array.from(re), nx, ny);
        var i = U.ifftshift2(Float64Array.from(im), nx, ny);
        U.fft2(r, i, nx, ny, false);
        return { re: U.fftshift2(r, nx, ny), im: U.fftshift2(i, nx, ny) };
    };
    U.ifft2c = function (re, im, nx, ny) {
        var r = U.ifftshift2(Float64Array.from(re), nx, ny);
        var i = U.ifftshift2(Float64Array.from(im), nx, ny);
        U.fft2(r, i, nx, ny, true);
        return { re: U.fftshift2(r, nx, ny), im: U.fftshift2(i, nx, ny) };
    };

    /* ---------- Formatting ----------
       Always pick a sensible unit; these strings are what students read. */
    function trim(x, sig) {
        if (!isFinite(x)) return String(x);
        var s = Number(x.toPrecision(sig || 3));
        return String(s);
    }
    U.fmtNum = trim;
    U.fmtTime = function (s, sig) {
        var a = Math.abs(s);
        if (a >= 60) { var m = Math.floor(s / 60), r = Math.round(s - 60 * m); if (r === 60) { m++; r = 0; } return m + ':' + (r < 10 ? '0' : '') + r + ' min'; }
        if (a >= 1) return trim(s, sig) + ' s';
        if (a >= 1e-3 || a === 0) return trim(s * 1e3, sig) + ' ms';
        return trim(s * 1e6, sig) + ' µs';
    };
    U.fmtFreq = function (hz, sig) {
        var a = Math.abs(hz);
        if (a >= 1e6) return trim(hz / 1e6, sig || 5) + ' MHz';
        if (a >= 1e3) return trim(hz / 1e3, sig) + ' kHz';
        return trim(hz, sig) + ' Hz';
    };
    U.fmtLen = function (m, sig) {
        var a = Math.abs(m);
        if (a >= 0.1) return trim(m * 100, sig) + ' cm';
        return trim(m * 1e3, sig) + ' mm';
    };
    U.fmtGrad = function (tpm, sig) { return trim(tpm * 1e3, sig) + ' mT/m'; };

    /* ---------- Colour maps ----------
       Each map takes t in [0,1] and returns [r,g,b] 0-255. */
    var CM = U.colormaps = {};
    CM.gray = function (t) { var v = Math.round(255 * U.clamp(t, 0, 1)); return [v, v, v]; };
    CM.hot = function (t) {
        t = U.clamp(t, 0, 1);
        return [Math.round(255 * U.clamp(3 * t, 0, 1)), Math.round(255 * U.clamp(3 * t - 1, 0, 1)), Math.round(255 * U.clamp(3 * t - 2, 0, 1))];
    };
    CM.phase = function (t) {      // cyclic, for phase images (t = (phi + pi) / 2pi)
        var h = U.clamp(t, 0, 1) * 6, i = Math.floor(h) % 6, f = h - Math.floor(h);
        var q = 1 - f, rgb = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][i];
        return [Math.round(235 * rgb[0] + 20), Math.round(235 * rgb[1] + 20), Math.round(235 * rgb[2] + 20)];
    };
    CM.diverging = function (t) {  // blue - white - red, for signed data and difference images
        t = U.clamp(t, 0, 1);
        if (t < 0.5) { var a = t / 0.5; return [Math.round(40 + 215 * a), Math.round(90 + 165 * a), 255]; }
        var b = (t - 0.5) / 0.5; return [255, Math.round(255 - 175 * b), Math.round(255 - 215 * b)];
    };
    CM.viridis = function (t) {
        var stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
        t = U.clamp(t, 0, 1) * (stops.length - 1);
        var i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
        return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
    };
    var lutCache = {};
    U.colormapLUT = function (name) {
        if (lutCache[name]) return lutCache[name];
        var f = CM[name] || CM.gray, lut = new Uint8ClampedArray(256 * 3);
        for (var i = 0; i < 256; i++) { var c = f(i / 255); lut[3 * i] = c[0]; lut[3 * i + 1] = c[1]; lut[3 * i + 2] = c[2]; }
        lutCache[name] = lut;
        return lut;
    };

    /* ---------- Canvas helpers (only called from UI code) ---------- */

    /* Size a canvas's backing store in device pixels for its current CSS
       size (or the size given) and scale the context, so that drawing code
       works in CSS pixels and stays sharp on HiDPI screens. Returns
       {ctx, w, h} in CSS pixels. */
    U.setupCanvas = function (canvas, cssW, cssH) {
        var dpr = (root.devicePixelRatio || 1);
        var w = cssW || canvas.clientWidth || canvas.width;
        var h = cssH || canvas.clientHeight || canvas.height;
        if (cssW) canvas.style.width = cssW + 'px';
        if (cssH) canvas.style.height = cssH + 'px';
        var bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== bw) canvas.width = bw;
        if (canvas.height !== bh) canvas.height = bh;
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, w: w, h: h };
    };

    /* Render a scalar image (row-major, nx by ny) into a canvas, scaled to
       fill it with nearest-neighbour sampling so pixels stay visible.
       opts: {min, max, cmap ('gray'|'hot'|'phase'|'diverging'|'viridis'),
              x, y, w, h (destination rect in CSS px; default whole canvas),
              smooth (bool)}
       Returns {min, max} actually used. */
    var scratchCanvas = null;
    U.drawImage = function (canvas, data, nx, ny, opts) {
        opts = opts || {};
        var min = opts.min, max = opts.max;
        if (min === undefined || max === undefined) {
            var lo = U.percentile(data, 0.5), hi = U.percentile(data, 99.5);
            if (min === undefined) min = Math.min(0, lo);
            if (max === undefined) max = hi > min ? hi : min + 1;
        }
        var lut = U.colormapLUT(opts.cmap || 'gray');
        if (!scratchCanvas) scratchCanvas = root.document.createElement('canvas');
        scratchCanvas.width = nx; scratchCanvas.height = ny;
        var sctx = scratchCanvas.getContext('2d');
        var img = sctx.createImageData(nx, ny), px = img.data, span = (max - min) || 1;
        for (var i = 0, n = nx * ny; i < n; i++) {
            var v = data[i];
            var t = isFinite(v) ? (v - min) / span : 0;
            var li = Math.round(U.clamp(t, 0, 1) * 255) * 3;
            px[4 * i] = lut[li]; px[4 * i + 1] = lut[li + 1]; px[4 * i + 2] = lut[li + 2]; px[4 * i + 3] = 255;
        }
        sctx.putImageData(img, 0, 0);
        var dpr = root.devicePixelRatio || 1;
        var ctx = canvas.getContext('2d');
        var cw = canvas.width / dpr, ch = canvas.height / dpr;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.imageSmoothingEnabled = !!opts.smooth;
        ctx.drawImage(scratchCanvas, 0, 0, nx, ny,
            opts.x || 0, opts.y || 0, opts.w || cw, opts.h || ch);
        ctx.restore();
        return { min: min, max: max };
    };

    /* Read a CSS custom property from :root (for theme-aware canvas drawing). */
    U.cssVar = function (name, fallback) {
        if (!root.getComputedStyle || !root.document) return fallback;
        var v = root.getComputedStyle(root.document.documentElement).getPropertyValue(name);
        return (v && v.trim()) || fallback;
    };

    /* Tiny DOM builder: U.el('div', {class: 'x', onclick: fn}, [children or text]) */
    U.el = function (tag, attrs, children) {
        var e = root.document.createElement(tag);
        if (attrs) for (var k in attrs) {
            if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
            var v = attrs[k];
            if (v === undefined || v === null || v === false) continue;
            if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
            else if (k === 'html') e.innerHTML = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') { for (var s in v) e.style[s] = v[s]; }
            else e.setAttribute(k, v === true ? '' : v);
        }
        if (children !== undefined && children !== null) {
            if (!Array.isArray(children)) children = [children];
            children.forEach(function (c) {
                if (c === null || c === undefined || c === false) return;
                e.appendChild(typeof c === 'string' || typeof c === 'number' ? root.document.createTextNode(String(c)) : c);
            });
        }
        return e;
    };

    /* Debounce: run fn at most once per `ms` after calls stop. */
    U.debounce = function (fn, ms) {
        var t = null;
        return function () {
            var args = arguments, self = this;
            if (t) clearTimeout(t);
            t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
        };
    };

    /* Yield to the event loop; long computations await this between chunks
       so the page stays responsive and progress can be drawn. */
    U.yieldFrame = function () {
        return new Promise(function (resolve) { setTimeout(resolve, 0); });
    };

    /* ---------- Event bus ----------
       MRI.bus.on('scan:done', fn) / off / emit. Handlers are called
       synchronously in registration order; an exception in one handler
       is logged and does not stop the others. */
    var handlers = {};
    MRI.bus = {
        on: function (evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return fn; },
        off: function (evt, fn) {
            var h = handlers[evt]; if (!h) return;
            var i = h.indexOf(fn); if (i >= 0) h.splice(i, 1);
        },
        emit: function (evt, payload) {
            var h = (handlers[evt] || []).slice();
            for (var i = 0; i < h.length; i++) {
                try { h[i](payload); }
                catch (e) { if (root.console) root.console.error('[MRI.bus] handler for "' + evt + '" failed:', e); }
            }
        }
    };

    /* ---------- UI registry ----------
       UI modules call MRI.ui.registerTab({...}) at load. The shell (app.js)
       builds the tab bar from these once the page has loaded, then calls
       each tab's mount(panelElement) exactly once. See ARCHITECTURE.md. */
    MRI.ui = MRI.ui || {};
    MRI.ui.tabs = MRI.ui.tabs || [];
    MRI.ui.registerTab = function (def) {
        if (!def || !def.id) throw new Error('registerTab needs an id');
        MRI.ui.tabs = MRI.ui.tabs.filter(function (t) { return t.id !== def.id; });
        MRI.ui.tabs.push(def);
    };
    var styleEl = null;
    MRI.ui.addStyle = function (css) {
        if (!root.document) return;
        if (!styleEl) {
            styleEl = root.document.createElement('style');
            styleEl.setAttribute('data-mri', 'modules');
            root.document.head.appendChild(styleEl);
        }
        styleEl.appendChild(root.document.createTextNode('\n' + css));
    };

})(typeof window !== 'undefined' ? window : globalThis);
