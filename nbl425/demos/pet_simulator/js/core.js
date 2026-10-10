/* ============================================================
   PET Simulator, core
   Namespace, physical constants, the shared FFT, a seeded RNG with
   Poisson sampling, small image-processing helpers, the event bus,
   the tab registry and the canvas helpers every other module leans on.

   Classic script, no ES modules, so the page still works when it
   is opened straight from disk. Everything hangs off window.PET.
   Nothing in this file touches the DOM at load time, so it can be
   loaded into Node for testing (see tests/harness.js).
   ============================================================ */
(function (root) {
    'use strict';

    var PET = root.PET = root.PET || {};
    PET.version = '1.0.0';

    /* ---------- Physical constants ----------
       Internal units: seconds, millimetres, becquerels, Bq/mL for
       concentration, keV for energy, 1/mm for linear attenuation.
       Kinetic rate constants are the one exception (per minute, as in
       the literature); see kinetics.js. Never store minutes or ns. */
    PET.const = {
        C_MM_PER_S: 2.99792458e11,          // speed of light, mm/s
        E511: 511,                          // annihilation photon energy, keV
        LN2: Math.LN2,
        MCI: 37e6,                          // 1 mCi in Bq
        MU_WATER: 0.0096,                   // water at 511 keV, 1/mm (0.096 /cm)
        // Body weight is in kg and tissue density is taken as 1 g/mL,
        // so SUV = (Bq/mL) / (Bq / g) = (Bq/mL) * weight_g / dose.
        DENSITY: 1.0
    };

    /* ---------- Small numeric helpers ---------- */
    var U = PET.util = {};

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
        if (a >= 3600) { var h = Math.floor(a / 3600), mm = Math.round((a - 3600 * h) / 60); if (mm === 60) { h++; mm = 0; } return (s < 0 ? '-' : '') + h + ' h ' + mm + ' min'; }
        if (a >= 60) { var m = Math.floor(a / 60), r = Math.round(a - 60 * m); if (r === 60) { m++; r = 0; } return (s < 0 ? '-' : '') + (r ? m + ' min ' + r + ' s' : m + ' min'); }
        if (a >= 1) return trim(s, sig) + ' s';
        if (a >= 1e-3 || a === 0) return trim(s * 1e3, sig) + ' ms';
        if (a >= 1e-6) return trim(s * 1e6, sig) + ' µs';
        if (a >= 1e-9) return trim(s * 1e9, sig) + ' ns';
        return trim(s * 1e12, sig) + ' ps';
    };
    U.fmtLen = function (mm, sig) {            // lengths are stored in mm
        var a = Math.abs(mm);
        if (a >= 1000) return trim(mm / 1000, sig) + ' m';
        if (a >= 100) return trim(mm / 10, sig) + ' cm';
        return trim(mm, sig) + ' mm';
    };
    U.fmtActivity = function (bq, sig) {
        var a = Math.abs(bq);
        if (a >= 1e9) return trim(bq / 1e9, sig) + ' GBq';
        if (a >= 1e6) return trim(bq / 1e6, sig) + ' MBq';
        if (a >= 1e3) return trim(bq / 1e3, sig) + ' kBq';
        return trim(bq, sig) + ' Bq';
    };
    U.fmtConc = function (bqPerMl, sig) {      // concentration, Bq/mL
        var a = Math.abs(bqPerMl);
        if (a >= 1e6) return trim(bqPerMl / 1e6, sig) + ' MBq/mL';
        if (a >= 1e3) return trim(bqPerMl / 1e3, sig) + ' kBq/mL';
        return trim(bqPerMl, sig) + ' Bq/mL';
    };
    U.fmtCounts = function (n, sig) {
        var a = Math.abs(n);
        if (a >= 1e9) return trim(n / 1e9, sig) + ' G';
        if (a >= 1e6) return trim(n / 1e6, sig) + ' M';
        if (a >= 1e4) return trim(n / 1e3, sig) + ' k';
        return String(Math.round(n));
    };
    U.fmtPct = function (x, digits) { return (100 * x).toFixed(digits === undefined ? 1 : digits) + ' %'; };

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

    /* Two more maps used for emission images: 'inferno' (perceptually
       uniform, black to yellow) and 'pet', the classic black-blue-red-
       yellow-white "hot metal" scale many PET workstations default to. */
    function stopsMap(stops) {
        return function (t) {
            t = U.clamp(t, 0, 1) * (stops.length - 1);
            var i = Math.min(stops.length - 2, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
            return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
        };
    }
    CM.inferno = stopsMap([[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]]);
    CM.pet = stopsMap([[0, 0, 0], [20, 10, 90], [80, 20, 160], [180, 30, 110], [235, 70, 30], [250, 160, 20], [255, 230, 90], [255, 255, 255]]);

    /* ---------- Statistics helpers ---------- */

    /* Error function (Abramowitz and Stegun 7.1.26, |error| < 1.5e-7),
       and the standard normal CDF built on it. Used for energy and
       timing windows and for time-of-flight bin probabilities. */
    U.erf = function (x) {
        var s = x < 0 ? -1 : 1; x = Math.abs(x);
        var t = 1 / (1 + 0.3275911 * x);
        var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return s * y;
    };
    U.normCdf = function (z) { return 0.5 * (1 + U.erf(z / Math.SQRT2)); };
    U.FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);       // 2.3548

    /* Poisson sample with mean mu from a seeded rng (U.rng). Exact
       (Knuth's product method) for small means, a rounded normal
       approximation with continuity correction above 40, which is far
       inside what any image or plot can distinguish. Counts are never
       negative. */
    U.poisson = function (rng, mu) {
        if (!(mu > 0)) return 0;
        if (mu < 40) {
            var L = Math.exp(-mu), k = 0, p = 1;
            do { k++; p *= rng(); } while (p > L);
            return k - 1;
        }
        var v = Math.round(mu + Math.sqrt(mu) * rng.randn());
        return v < 0 ? 0 : v;
    };
    /* Poisson-sample a whole array of means into a new Float32Array. */
    U.poissonArray = function (rng, means) {
        var out = new Float32Array(means.length);
        for (var i = 0; i < means.length; i++) out[i] = U.poisson(rng, means[i]);
        return out;
    };

    /* Sum and mean of a typed array, optionally weighted (weights same length). */
    U.sum = function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; };

    /* ---------- Small image-processing helpers ----------
       Images are Float32Array, row-major, n x n unless stated (nx, ny).
       Pixel (ix, iy) sits at x = (ix - floor(n/2)) * dx, y = (iy - floor(n/2)) * dx,
       x to the right and y DOWN the screen (the same as image rows). */

    /* 1D Gaussian kernel (normalised to sum 1) for a FWHM given in pixels. */
    U.gaussKernel = function (fwhmPx) {
        var sigma = fwhmPx / U.FWHM_PER_SIGMA;
        if (!(sigma > 0.05)) return new Float64Array([1]);
        var half = Math.max(1, Math.ceil(3.5 * sigma)), k = new Float64Array(2 * half + 1), s = 0;
        for (var i = -half; i <= half; i++) { var v = Math.exp(-0.5 * (i / sigma) * (i / sigma)); k[i + half] = v; s += v; }
        for (i = 0; i < k.length; i++) k[i] /= s;
        return k;
    };

    /* Separable Gaussian blur, FWHM in pixels. Edges are handled by
       renormalising the kernel over the pixels that exist, so a uniform
       image stays uniform up to its border and nothing leaks out. */
    U.gaussBlur2D = function (img, nx, ny, fwhmPx) {
        var k = U.gaussKernel(fwhmPx);
        if (k.length === 1) return Float32Array.from(img);
        var h = (k.length - 1) / 2, tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny), x, y, j;
        for (y = 0; y < ny; y++) {
            var o = y * nx;
            for (x = 0; x < nx; x++) {
                var s = 0, w = 0;
                for (j = -h; j <= h; j++) { var xx = x + j; if (xx < 0 || xx >= nx) continue; s += img[o + xx] * k[j + h]; w += k[j + h]; }
                tmp[o + x] = s / w;
            }
        }
        for (x = 0; x < nx; x++) {
            for (y = 0; y < ny; y++) {
                var s2 = 0, w2 = 0;
                for (j = -h; j <= h; j++) { var yy = y + j; if (yy < 0 || yy >= ny) continue; s2 += tmp[yy * nx + x] * k[j + h]; w2 += k[j + h]; }
                out[y * nx + x] = s2 / w2;
            }
        }
        return out;
    };

    /* 2D convolution with a small square kernel (odd size, row-major,
       centred), zero outside the image, so total activity is conserved
       except what spills off the edge. Used for positron range. */
    U.convolve2D = function (img, nx, ny, kernel, ksize) {
        var h = (ksize - 1) >> 1, out = new Float32Array(nx * ny);
        for (var y = 0; y < ny; y++) {
            for (var x = 0; x < nx; x++) {
                var v = img[y * nx + x];
                if (v === 0) continue;
                // scatter form: each source pixel spreads into its neighbours
                for (var ky = -h; ky <= h; ky++) {
                    var yy = y + ky; if (yy < 0 || yy >= ny) continue;
                    var ro = yy * nx, kr = (ky + h) * ksize + h;
                    for (var kx = -h; kx <= h; kx++) {
                        var xx = x + kx; if (xx < 0 || xx >= nx) continue;
                        out[ro + xx] += v * kernel[kr + kx];
                    }
                }
            }
        }
        return out;
    };

    /* Bilinear sample of image at fractional pixel coordinates (fx, fy);
       0 outside. */
    U.bilinear = function (img, nx, ny, fx, fy) {
        var x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
        if (x0 < -1 || y0 < -1 || x0 >= nx || y0 >= ny) return 0;
        var v00 = (x0 >= 0 && y0 >= 0) ? img[y0 * nx + x0] : 0;
        var v10 = (x0 + 1 < nx && y0 >= 0) ? img[y0 * nx + x0 + 1] : 0;
        var v01 = (x0 >= 0 && y0 + 1 < ny) ? img[(y0 + 1) * nx + x0] : 0;
        var v11 = (x0 + 1 < nx && y0 + 1 < ny) ? img[(y0 + 1) * nx + x0 + 1] : 0;
        return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
    };

    /* Rigid transform of an n x n image with pixel size dx (mm): the
       object is rotated by rotDeg about the FOV centre (positive turns +x
       towards +y, i.e. clockwise on screen) and then shifted by (sx, sy)
       mm. Implemented by pulling each output pixel back through the
       inverse transform with bilinear interpolation. nearest: true keeps
       label-like values (no interpolation). */
    U.transformImage = function (img, n, dx, sx, sy, rotDeg, nearest) {
        if (!sx && !sy && !rotDeg) return Float32Array.from(img);
        var out = new Float32Array(n * n), c = Math.cos(rotDeg * Math.PI / 180), s = Math.sin(rotDeg * Math.PI / 180), h = Math.floor(n / 2);
        for (var iy = 0; iy < n; iy++) {
            var y = (iy - h) * dx - sy;
            for (var ix = 0; ix < n; ix++) {
                var x = (ix - h) * dx - sx;
                // inverse rotation
                var xs = c * x + s * y, ys = -s * x + c * y;
                var fx = xs / dx + h, fy = ys / dx + h;
                if (nearest) {
                    var rx = Math.round(fx), ry = Math.round(fy);
                    out[iy * n + ix] = (rx >= 0 && ry >= 0 && rx < n && ry < n) ? img[ry * n + rx] : 0;
                } else out[iy * n + ix] = U.bilinear(img, n, n, fx, fy);
            }
        }
        return out;
    };

    /* Box-average an n x n image down (or nearest-sample up) to m x m over
       the same FOV. Downsampling by an integer factor averages exactly;
       otherwise each output pixel averages the input pixels whose centres
       fall inside it. Used to put the fine phantom truth on the image grid. */
    U.resample = function (img, n, m) {
        if (n === m) return Float32Array.from(img);
        var out = new Float32Array(m * m);
        if (n > m) {
            var cnt = new Float32Array(m * m), r = m / n;
            for (var iy = 0; iy < n; iy++) {
                var oy = Math.min(m - 1, Math.floor((iy + 0.5) * r));
                for (var ix = 0; ix < n; ix++) {
                    var o = oy * m + Math.min(m - 1, Math.floor((ix + 0.5) * r));
                    out[o] += img[iy * n + ix]; cnt[o]++;
                }
            }
            for (var i = 0; i < m * m; i++) out[i] = cnt[i] ? out[i] / cnt[i] : 0;
        } else {
            var q = n / m;
            for (var jy = 0; jy < m; jy++) for (var jx = 0; jx < m; jx++)
                out[jy * m + jx] = img[Math.min(n - 1, Math.floor((jy + 0.5) * q)) * n + Math.min(n - 1, Math.floor((jx + 0.5) * q))];
        }
        return out;
    };

    /* Pixel-centre coordinate (mm) of index i on an axis of n pixels of size d. */
    U.coord = function (i, n, d) { return (i - Math.floor(n / 2)) * d; };

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
       PET.bus.on('scan:done', fn) / off / emit. Handlers are called
       synchronously in registration order; an exception in one handler
       is logged and does not stop the others. */
    var handlers = {};
    PET.bus = {
        on: function (evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return fn; },
        off: function (evt, fn) {
            var h = handlers[evt]; if (!h) return;
            var i = h.indexOf(fn); if (i >= 0) h.splice(i, 1);
        },
        emit: function (evt, payload) {
            var h = (handlers[evt] || []).slice();
            for (var i = 0; i < h.length; i++) {
                try { h[i](payload); }
                catch (e) { if (root.console) root.console.error('[PET.bus] handler for "' + evt + '" failed:', e); }
            }
        }
    };

    /* ---------- UI registry ----------
       UI modules call PET.ui.registerTab({...}) at load. The shell (app.js)
       builds the tab bar from these once the page has loaded, then calls
       each tab's mount(panelElement) exactly once. See ARCHITECTURE.md. */
    PET.ui = PET.ui || {};
    PET.ui.tabs = PET.ui.tabs || [];
    PET.ui.registerTab = function (def) {
        if (!def || !def.id) throw new Error('registerTab needs an id');
        PET.ui.tabs = PET.ui.tabs.filter(function (t) { return t.id !== def.id; });
        PET.ui.tabs.push(def);
    };
    var styleEl = null;
    PET.ui.addStyle = function (css) {
        if (!root.document) return;
        if (!styleEl) {
            styleEl = root.document.createElement('style');
            styleEl.setAttribute('data-pet', 'modules');
            root.document.head.appendChild(styleEl);
        }
        styleEl.appendChild(root.document.createTextNode('\n' + css));
    };

})(typeof window !== 'undefined' ? window : globalThis);
