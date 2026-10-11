/* ============================================================
   MRI Simulator, reconstruction

   Turns the raw signal the scanner recorded (AcqData, ARCHITECTURE.md
   section 9.3) into an image. The steps are the ones a real scanner's
   reconstruction computer performs, and each one can be switched so
   that students see what it does:

     1. Put every sample where it belongs in k-space. When the
        trajectory is Cartesian (every sample sits on a grid point)
        that is bookkeeping. Otherwise (radial, spiral) the samples are
        "gridded": each is weighted by the area of k-space it stands
        for (density compensation), spread onto a finer grid with a
        small smooth kernel, and the kernel's effect on the image is
        divided out afterwards (deapodisation).
     2. Repair what the acquisition skipped or got wrong: the missing
        part of a partial-Fourier acquisition, and the odd/even echo
        phase difference of EPI that makes the Nyquist ghost.
     3. Optionally filter k-space (less ringing and noise, less
        resolution) and zero-fill (a finer pixel grid, no new detail).
     4. Inverse Fourier transform, scaled so that the image is in the
        units of the object (section 3): a uniform object with m = 1
        and a uniform unit coil gives 1.0.
     5. Unfold the aliasing of a regularly undersampled acquisition
        with SENSE, using the coil sensitivities.
     6. Crop the readout oversampling and combine the coils.

   Conventions (section 3): on every axis index i sits at
   (i - floor(n/2)) * delta, the signal is s(k) = sum m(r) exp(-i 2 pi k.r) dA,
   and the image is ifft2c(k-space) * nx * ny * dkx * dky.

   Inside the Cartesian path the readout runs along the columns and the
   phase encoding along the rows, whichever physical axis each one is,
   and the results are transposed back at the end. Partial Fourier,
   SENSE and EPI correction are therefore each written once.

   Pure computation: no DOM, runs under tests/harness.js in Node.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const U = MRI.util;
    const { PI, abs, sqrt, cos, sin, exp, atan2, floor, ceil, round, min, max, hypot } = Math;

    /* Defaults make a good image from every preset (ARCHITECTURE.md
       section 1, principle 4): homodyne and SENSE act only when the
       acquisition is partial-Fourier or regularly undersampled, so they
       change nothing for a fully sampled scan. The lessons switch them off
       to show what they repair. The coils are combined with their
       sensitivities (Roemer): the image then has no coil shading and is in
       the units of the object, so the truth and difference panels compare
       like with like, and its noise is the same in every channel count.
       Root-sum-of-squares stays one click away to show coil shading. */
    const DEFAULTS = Object.freeze({
        filter: 'none',            // 'none' | 'hamming' | 'hann' | 'tukey' | 'fermi'
        filterParam: 0.5,          // tukey: fraction of k-space radius tapered; fermi: see filterWeights
        zeroFill: 1,               // 1 | 2
        partialFourier: 'homodyne',// 'zero' | 'conjugate' | 'homodyne'
        parallel: 'sense',         // 'none' | 'sense' (used only when regular undersampling is found)
        coilCombine: 'roemer',     // 'roemer' | 'sos' | 'single'
        coil: 0,                   // the coil shown by 'single'
        densityComp: true,         // non-Cartesian only
        epiGhostCorr: false,
        cropOversampling: true,
        userMask: null,            // Uint8Array(kspace.nx * kspace.ny), 0 = throw that point away
        userMaskGrid: null         // { nx, ny, dkx, dky } of the k-space grid the mask was drawn on
    });

    const GRID_TOL = 0.01;         // a sample is "on the grid" within 1 % of a grid step
    const CART_FRACTION = 0.99;    // ... and the trajectory is Cartesian when 99 % of samples are
    const MAX_N = 2048;            // refuse absurd matrix sizes rather than allocate gigabytes

    /* ---------- small helpers ---------- */

    const isNum = (v) => typeof v === 'number' && isFinite(v);
    function posInt(v, dflt) { v = floor(Number(v)); return v >= 1 ? min(v, MAX_N) : dflt; }
    function posNum(v, dflt) { v = Number(v); return v > 0 && isFinite(v) ? v : dflt; }
    function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
    function fmt(x, sig) { return U.fmtNum(x, sig || 3); }
    function nth(r) { return r === 2 ? '2nd' : (r === 3 ? '3rd' : r + 'th'); }

    /* New array (same type) with rows and columns swapped:
       out[c * rows + r] = a[r * cols + c]. */
    function transpose(a, rows, cols) {
        const out = new a.constructor(a.length);
        for (let r = 0; r < rows; r++) {
            const o = r * cols;
            for (let c = 0; c < cols; c++) out[c * rows + r] = a[o + c];
        }
        return out;
    }

    /* Centred 1D transform in place (index i <-> i - floor(n/2)), any
       length, using scratch arrays tr, ti of exactly that length. */
    function fft1c(re, im, inverse, tr, ti) {
        const n = tr.length, h = n >> 1;
        for (let u = 0; u < n; u++) { let i = u + h; if (i >= n) i -= n; tr[u] = re[i]; ti[u] = im[i]; }
        U.fft(tr, ti, inverse);
        for (let i = 0; i < n; i++) { let u = i - h; if (u < 0) u += n; re[i] = tr[u]; im[i] = ti[u]; }
    }

    /* ---------- the 2D inverse transform, in two halves ----------
       The image is ifft2c(k-space): an inverse transform along the
       readout, then one along the phase encoding. Doing them as two
       separate passes lets the reconstruction crop between them. The
       readout oversampling (and the 2x gridding grid) is thrown away
       after the transform anyway, so only the columns that are kept go
       through the second transform and everything after it: about half
       the work for an oversampled readout, with the same numbers.

       Pass 1 (per k-space row): the caller fills a line tr, ti of W
       points in transform order, i.e. the sample at readout index j of a
       row whose centre is c goes to slot (j - c) mod W, which places it
       in the middle of a zero-filled line and does the centring shift in
       one step. hybridRow transforms it and stores the Wc image columns
       from x0 onwards in column-major "hybrid" storage, hy[x * H + row]
       (x along the readout, still k along the phase encoding), so that
       pass 2 reads each column from contiguous memory.
       Pass 2 (per kept column): transform along the phase encoding and
       write image rows y0 .. y0 + Hc - 1, times `scale`, row-major. */
    function hybridRow(tr, ti, W, x0, Wc, hyRe, hyIm, H, row) {
        U.fft(tr, ti, true);
        gatherRow(tr, ti, W, x0, Wc, hyRe, hyIm, H, row);
    }
    function gatherRow(tr, ti, W, x0, Wc, hyRe, hyIm, H, row) {
        let u = x0 - (W >> 1);                 // image column x sits in slot (x - floor(W/2)) mod W
        if (u < 0) u += W;
        for (let x = 0, q = row; x < Wc; x++, q += H) {
            hyRe[q] = tr[u]; hyIm[q] = ti[u];
            if (++u === W) u = 0;
        }
    }
    function hybridCols(hyRe, hyIm, H, Wc, y0, Hc, scale, outRe, outIm, tr, ti) {
        const h = H >> 1;
        for (let x = 0; x < Wc; x++) {
            const b = x * H;
            let u = H - h;                     // row v (ky index v - h) goes to slot (v - h) mod H
            for (let v = 0; v < H; v++) {
                if (u === H) u = 0;
                tr[u] = hyRe[b + v]; ti[u] = hyIm[b + v];
                u++;
            }
            U.fft(tr, ti, true);
            u = y0 - h;
            if (u < 0) u += H;
            for (let i = 0, p = x; i < Hc; i++, p += Wc) {
                outRe[p] = tr[u] * scale; outIm[p] = ti[u] * scale;
                if (++u === H) u = 0;
            }
        }
    }

    /* Reusable work arrays. The reconstruction runs several times a
       second during playback and on every option change, so its per-coil
       scratch space is allocated once and reused across coils and calls,
       rather than allocated and collected each time. One array per name,
       at the size last asked for, so a large matrix does not keep its
       buffers alive after the next smaller scan. Nothing taken from here
       is ever part of a result. */
    const scratchStore = new Map();
    function scratch(name, Type, n) {
        let a = scratchStore.get(name);
        if (!a || a.length !== n || !(a instanceof Type)) {
            a = new Type(n);
            scratchStore.set(name, a);
        }
        return a;
    }

    /* ---------- k-space filters ----------
       A filter multiplies k-space by a window that falls towards the
       edge. The image is then the true image convolved with the
       window's transform: a wider point-spread function (less
       resolution), but with much smaller side lobes, so less Gibbs
       ringing at sharp edges and less high-frequency noise. Every window
       is 1 at k = 0, so the overall image intensity is unchanged.
       u = |k| / kmax is measured on the data grid, 0 at the centre and 1
       at the edge. Hamming, Hann and Tukey are applied separably along
       each axis; Fermi is the usual circular one. */
    function axisWeights(type, p, n) {
        const w = new Float64Array(n), c = n >> 1, half = n / 2;
        for (let i = 0; i < n; i++) {
            const u = min(1, abs(i - c) / half);
            let v;
            if (type === 'hamming') v = 0.54 + 0.46 * cos(PI * u);
            else if (type === 'hann') v = 0.5 + 0.5 * cos(PI * u);
            else if (type === 'tukey') {
                // flat over the inner (1 - p) of the radius, cosine taper over the outer p
                const flat = 1 - p;
                v = (p <= 0 || u <= flat) ? 1 : 0.5 + 0.5 * cos(PI * (u - flat) / p);
            } else return null;
            w[i] = v;
        }
        return w;
    }

    /* Weights for a grid of nA columns by nB rows, or null for no filter.
       filterParam p (0..1) is "how much of the edge of k-space to give
       up": Tukey tapers the outer fraction p of the radius; Fermi,
       1 / (1 + exp((u - r)/w)), uses a cut-off radius r = 1 - p/2 (the
       middle of the same band) and a transition width w = p/5, so it is
       about 0.08 at the edge of k-space whatever p is. A sharper Fermi
       edge would ring itself. Hamming and Hann have no parameter. */
    function filterWeights(type, p, nA, nB) {
        if (!type || type === 'none') return null;
        p = clamp(isNum(p) ? p : 0.5, 0, 1);
        const out = new Float64Array(nA * nB);
        if (type === 'fermi') {
            const r = 1 - p / 2, wd = max(0.01, p / 5), f0 = 1 / (1 + exp(-r / wd));
            const ca = nA >> 1, cb = nB >> 1;
            for (let i = 0; i < nB; i++) {
                const v = (i - cb) / (nB / 2);
                for (let j = 0; j < nA; j++) {
                    const u = (j - ca) / (nA / 2), q = sqrt(u * u + v * v);
                    out[i * nA + j] = 1 / (1 + exp((q - r) / wd)) / f0;
                }
            }
            return out;
        }
        const fa = axisWeights(type, p, nA), fb = axisWeights(type, p, nB);
        if (!fa || !fb) return null;
        for (let i = 0; i < nB; i++) for (let j = 0; j < nA; j++) out[i * nA + j] = fb[i] * fa[j];
        return out;
    }

    /* ---------- Kaiser-Bessel gridding kernel ----------
       Gridding convolves the scattered samples with a small kernel and
       samples the result on a grid. The kernel's transform multiplies
       the image (apodisation), so it must be smooth and compact in both
       domains; the Kaiser-Bessel window is the standard choice. Width 4
       cells on a grid oversampled by 2, with the beta of Beatty, Nishimura
       and Pauly (IEEE TMI 2005), keeps the aliasing of the kernel's
       transform below about 1e-3. */
    const KB_W = 4, KB_OS = 2;
    const KB_BETA = PI * sqrt((KB_W / KB_OS) * (KB_W / KB_OS) * (KB_OS - 0.5) * (KB_OS - 0.5) - 0.8);
    function besselI0(x) {
        let s = 1, t = 1;
        const q = x * x / 4;
        for (let k = 1; k < 100; k++) { t *= q / (k * k); s += t; if (t < 1e-17 * s) break; }
        return s;
    }
    const KB_LUT_N = 4096;
    const KB_LUT = (function () {
        const lut = new Float64Array(KB_LUT_N + 2), i0b = besselI0(KB_BETA), half = KB_W / 2;
        for (let i = 0; i <= KB_LUT_N + 1; i++) {
            const u = i / KB_LUT_N * half, a = 1 - (u / half) * (u / half);
            lut[i] = a >= 0 ? besselI0(KB_BETA * sqrt(a)) / i0b : 0;
        }
        return lut;
    })();
    /* Kernel value at u grid cells from its centre (1 at u = 0). */
    function kb(u) {
        u = abs(u);
        const half = KB_W / 2;
        if (u > half) return 0;
        const f = u / half * KB_LUT_N, i = floor(f), t = f - i;
        return KB_LUT[i] + (KB_LUT[i + 1] - KB_LUT[i]) * t;
    }
    /* Sum of the kernel over the grid points it touches (about its
       integral, in cells): converts gridded values back to k-space units
       and scales the Pipe-Menon weights. */
    const KB_SUM = (function () {
        let s = 0;
        const nf = 64;
        for (let f = 0; f < nf; f++) for (let m = -3; m <= 3; m++) s += kb(m - f / nf);
        return s / nf;
    })();
    const NTAP = 5;               // a width-4 kernel touches up to 5 grid points per axis

    /* ---------- coil sensitivities ---------- */

    /* Coil maps on an nx by ny image grid covering fovX by fovY, from
       fields.js (the simulator knows the true maps; a real scanner
       measures them in a short calibration scan). null when they cannot
       be had or do not match the data. A single coil without a coil set
       is taken to be the uniform body coil. */
    function getMaps(acq, nCoils, nx, ny, fovX, fovY) {
        const F = MRI.fields;
        let cs = acq.coilSet;
        if (!cs && nCoils === 1) cs = 'body';
        if (cs && F && typeof F.coilMaps === 'function') {
            try {
                const m = F.coilMaps(cs, nx, ny, fovX, fovY);
                if (m && m.re && m.im && m.re.length === nCoils && m.re[0].length === nx * ny) return m;
            } catch (e) { /* fall through */ }
        }
        if (nCoils === 1 && (!cs || cs === 'body' || cs.type === 'body')) {
            const r = new Float32Array(nx * ny); r.fill(1);
            return { re: [r], im: [new Float32Array(nx * ny)] };
        }
        return null;
    }

    /* ---------- the k-space tab's edit mask ----------
       The mask belongs to the k-space grid it was drawn on. When the
       caller says which grid that was (opts.userMaskGrid), the matrix and
       the k-space step must both match the grid being built (step within
       0.1 %), so that a mask from another sequence of the same size is
       not silently read in a different layout. Without that description
       only the length can be checked. */
    function maskFits(o, nx, ny, dkx, dky) {
        const m = o.userMask;
        if (!m || m.length !== nx * ny) return false;
        const g = o.userMaskGrid;
        if (!g || typeof g !== 'object') return true;
        const close = (a, b) => isNum(a) && abs(a - b) <= 1e-3 * abs(b);
        return g.nx === nx && g.ny === ny && close(g.dkx, dkx) && close(g.dky, dky);
    }
    const MASK_MISMATCH = 'The edited k-space mask does not match this k-space grid, so it was ignored.';

    /* ---------- the result for "nothing to show" ---------- */

    function emptyResult(acq, notes) {
        const g = (acq && acq.grid) || {};
        const nx = posInt(g.nx, 64), ny = posInt(g.ny, nx);
        const fovX = posNum(g.fovX, 0.24), fovY = posNum(g.fovY, fovX);
        const os = posInt(g.oversample, 1);
        let knx = nx, kny = ny, dkx = 1 / fovX, dky = 1 / fovY;
        if (g.readoutAxis === 'x') { knx = min(MAX_N, nx * os); dkx /= os; }
        else if (g.readoutAxis === 'y') { kny = min(MAX_N, ny * os); dky /= os; }
        else if (g.readoutAxis === 'radial') { knx = 2 * nx; kny = 2 * ny; dkx /= 2; dky /= 2; }
        let nC = acq && posInt(acq.nCoils, 0);
        if (!nC) nC = 1;
        nC = min(nC, 64);
        const zeros = (n) => new Float32Array(n);
        const nans = (n) => { const a = new Float32Array(n); a.fill(NaN); return a; };
        const coilRe = [], coilIm = [], kRe = [], kIm = [];
        for (let c = 0; c < nC; c++) { coilRe.push(zeros(nx * ny)); coilIm.push(zeros(nx * ny)); kRe.push(zeros(knx * kny)); kIm.push(zeros(knx * kny)); }
        return {
            kspace: { nx: knx, ny: kny, dkx, dky, re: kRe, im: kIm, mask: new Uint8Array(knx * kny), tmap: nans(knx * kny), order: nans(knx * kny) },
            coilImages: { nx, ny, re: coilRe, im: coilIm },
            image: { nx, ny, fovX, fovY, re: zeros(nx * ny), im: zeros(nx * ny), mag: zeros(nx * ny) },
            gfactor: null,
            info: { cartesian: g.readoutAxis === 'x' || g.readoutAxis === 'y', undersampling: 1, partialFourier: 1, notes: notes.slice(), nReadouts: 0 }
        };
    }

    /* ---------- trajectory analysis ---------- */

    function validReadout(r) {
        return r && r.kx && r.ky && r.re && r.im && r.re.length > 0 && r.re[0] &&
            min(r.kx.length, r.ky.length, r.re[0].length) > 0;
    }
    function readoutLength(r) { return min(r.kx.length, r.ky.length, r.re[0].length); }

    /* The readout axis from the trajectory itself: 'x' when every readout
       moves only in kx, 'y' when only in ky, else null. */
    function guessAxis(plan) {
        let xs = 0, ys = 0, other = 0;
        for (const r of plan) {
            const n = r.n;
            if (n < 2) continue;
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (let j = 0; j < n; j++) {
                const a = r.kx[j], b = r.ky[j];
                if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b;
            }
            const rx = x1 - x0, ry = y1 - y0;
            if (rx > 0 && ry <= 1e-6 * rx) xs++; else if (ry > 0 && rx <= 1e-6 * ry) ys++; else other++;
        }
        if (other || (xs && ys)) return null;
        return xs ? 'x' : (ys ? 'y' : null);
    }

    /* Try to place every sample on the nominal Cartesian grid: spacing
       1/(FOV*os) along the readout (the ADC samples os times faster than
       one cycle per FOV) and 1/FOV along the phase encoding. Returns the
       grid index of every sample (internal layout: row = phase-encode
       line, column = readout position), -1 where a sample is off the grid
       or outside it. A sample exactly at +n/2 (the far Nyquist edge,
       which reversed EPI lines reach) is the same grid point as -n/2 on
       the pixel grid, so it is wrapped there. */
    function placeCartesian(plan, axis, nx, ny, fovX, fovY, os) {
        const nRo = axis === 'x' ? nx : ny, nPe = axis === 'x' ? ny : nx;
        const nro = min(MAX_N, nRo * os), npe = nPe;
        const dro = 1 / ((axis === 'x' ? fovX : fovY) * os), dpe = 1 / (axis === 'x' ? fovY : fovX);
        const cro = nro >> 1, cpe = npe >> 1;
        let total = 0, onGrid = 0, outside = 0;
        const idx = new Array(plan.length);
        for (let r = 0; r < plan.length; r++) {
            const ro = plan[r], n = ro.n;
            const kro = axis === 'x' ? ro.kx : ro.ky, kpe = axis === 'x' ? ro.ky : ro.kx;
            const a = new Int32Array(n);
            for (let j = 0; j < n; j++) {
                total++;
                const fr = kro[j] / dro + cro, fp = kpe[j] / dpe + cpe;
                let ir = round(fr), ip = round(fp);
                if (!(abs(fr - ir) <= GRID_TOL && abs(fp - ip) <= GRID_TOL)) { a[j] = -1; continue; }
                onGrid++;
                if (ir === nro) ir = 0;
                if (ip === npe) ip = 0;
                if (ir < 0 || ir >= nro || ip < 0 || ip >= npe) { a[j] = -1; outside++; continue; }
                a[j] = ip * nro + ir;
            }
            idx[r] = a;
        }
        return {
            cartesian: total > 0 && onGrid >= CART_FRACTION * total,
            axis, nRo, nPe, nro, npe, dro, dpe, idx, total, onGrid, outside
        };
    }

    /* Which phase-encode lines does the full acquisition plan record?
       From that: regular undersampling (every R-th line, all gaps equal),
       partial Fourier (a block of lines missing on one side of k-space
       only), or a centre-only (low-resolution) acquisition. */
    function analyzeLines(rowAcq, n) {
        const rows = [];
        for (let i = 0; i < n; i++) if (rowAcq[i]) rows.push(i);
        const res = { nAcq: rows.length, R: 1, kappa0: 0, gaps: false, sparse: false, pf: null, lowRes: false, first: -1, last: -1 };
        if (!rows.length) return res;
        const c = n >> 1, a = rows[0], b = rows[rows.length - 1];
        res.first = a; res.last = b;
        if (rows.length >= 2) {
            const step = rows[1] - rows[0];
            let uniform = true;
            for (let k = 2; k < rows.length; k++) if (rows[k] - rows[k - 1] !== step) { uniform = false; break; }
            if (!uniform) res.gaps = true;
            else if (step >= 2 && step <= 8 && rows.length >= 4) {
                res.R = step;
                // all recorded lines share k index (i - c) modulo R; SENSE needs to know which residue
                res.kappa0 = (((a - c) % step) + step) % step;
            } else if (step >= 2) res.sparse = true;
        }
        const R = res.R, missLow = a, missHigh = n - 1 - b;
        const thr = max(2 * R, ceil(n / 16));
        if (missLow >= thr && missHigh <= R) res.pf = { side: 'low', missing: missLow, h: c - a };
        else if (missHigh >= thr && missLow <= R) res.pf = { side: 'high', missing: missHigh, h: b - c };
        else if (missLow >= thr && missHigh >= thr) res.lowRes = true;
        if (res.pf) res.pf.fraction = (n - res.pf.missing) / n;
        return res;
    }

    /* ---------- EPI odd/even echo correction ----------
       EPI records alternate lines with the readout gradient reversed. Any
       timing error between the nominal and the real gradient (eddy
       currents, a gradient delay) shifts the echoes of one polarity one
       way in k-space and the other polarity the other way. In hybrid
       space (Fourier transformed along the readout only) a k-space shift
       is a linear phase, so odd and even lines differ by a phase
       theta(x) = a + b x. That alternating difference modulates k-space
       at the Nyquist frequency, and the image gets a copy of itself
       shifted by half the field of view: the Nyquist ghost.
       Scanners measure theta with a few reference echoes; here it is
       estimated from the data. Near the centre of k-space neighbouring
       lines are nearly alike, so each line is compared with the average
       of its two neighbours (which have the other polarity; averaging
       the two also cancels the phase that phase encoding itself adds
       from line to line). The slope b comes from the phase advance
       between neighbouring pixels and a from what is left, with no
       phase unwrapping. Half the difference is then removed from each
       polarity. */
    function epiGhostCorrect(kre, kim, nro, npe, rowSign) {
        const nC = kre.length, cro = nro >> 1, cpe = npe >> 1;
        const tr = new Float64Array(nro), ti = new Float64Array(nro);
        const cache = new Map();
        function hybrid(c, i) {
            const key = c * npe + i;
            let h = cache.get(key);
            if (!h) {
                const o = i * nro;
                h = { re: Float64Array.from(kre[c].subarray(o, o + nro)), im: Float64Array.from(kim[c].subarray(o, o + nro)) };
                fft1c(h.re, h.im, true, tr, ti);
                cache.set(key, h);
            }
            return h;
        }
        const L = max(2, min(8, npe >> 3));
        const zr = new Float64Array(nro), zi = new Float64Array(nro);
        let used = 0;
        for (let i = max(1, cpe - L); i <= min(npe - 2, cpe + L); i++) {
            const s = rowSign[i];
            if (!s || rowSign[i - 1] !== -s || rowSign[i + 1] !== -s) continue;
            used++;
            for (let c = 0; c < nC; c++) {
                const P = hybrid(c, i), A = hybrid(c, i - 1), B = hybrid(c, i + 1);
                for (let x = 0; x < nro; x++) {
                    const nr = A.re[x] + B.re[x], ni = A.im[x] + B.im[x];
                    // P * conj(neighbours): phase of this line minus that of its neighbours
                    const pr = P.re[x] * nr + P.im[x] * ni;
                    let pi = P.im[x] * nr - P.re[x] * ni;
                    if (s > 0) pi = -pi;          // always (reversed lines) minus (forward lines)
                    zr[x] += pr; zi[x] += pi;
                }
            }
        }
        if (!used) return null;
        let sr = 0, si = 0;
        for (let x = 0; x + 1 < nro; x++) {
            sr += zr[x + 1] * zr[x] + zi[x + 1] * zi[x];
            si += zi[x + 1] * zr[x] - zr[x + 1] * zi[x];
        }
        const b = atan2(si, sr);
        let ar = 0, ai = 0;
        for (let x = 0; x < nro; x++) {
            const ang = -b * (x - cro), c = cos(ang), s = sin(ang);
            ar += zr[x] * c - zi[x] * s; ai += zr[x] * s + zi[x] * c;
        }
        const a = atan2(ai, ar);
        // reversed lines (sign -1) get exp(-i theta/2), forward lines exp(+i theta/2)
        const cr = new Float64Array(nro), ci = new Float64Array(nro);
        for (let x = 0; x < nro; x++) { const th = 0.5 * (a + b * (x - cro)); cr[x] = cos(th); ci[x] = sin(th); }
        const rr = new Float64Array(nro), ri = new Float64Array(nro);
        for (let i = 0; i < npe; i++) {
            const s = rowSign[i];
            if (!s) continue;
            const o = i * nro;
            for (let c = 0; c < nC; c++) {
                for (let x = 0; x < nro; x++) { rr[x] = kre[c][o + x]; ri[x] = kim[c][o + x]; }
                fft1c(rr, ri, true, tr, ti);
                for (let x = 0; x < nro; x++) {
                    const pr = cr[x], pi = s * ci[x], vr = rr[x], vi = ri[x];
                    rr[x] = vr * pr - vi * pi; ri[x] = vr * pi + vi * pr;
                }
                fft1c(rr, ri, false, tr, ti);
                for (let x = 0; x < nro; x++) { kre[c][o + x] = rr[x]; kim[c][o + x] = ri[x]; }
            }
        }
        return { phase0: a, slope: b, lines: used };
    }

    /* ---------- SENSE ----------
       With every R-th line recorded, the k-space step is R/FOV and each
       coil image folds: the pixel at row j holds the sum of the R pixels
       j, j + H/R, j + 2H/R ... of the full image (H rows). Each coil sees
       that sum through its own sensitivity, so for each group of R
       pixels there are nCoils equations in R unknowns:
           a_c(j) = sum_q  w_q C_c(j_q) rho(j_q),   j_q = j + q H/R
       w_q = exp(-i 2 pi q kappa0 / R) accounts for which residue of lines
       was recorded (kappa0 = 0 when the k = 0 line is among them). The
       least-squares solution rho = (E^H E)^-1 E^H a is SENSE (Pruessmann
       1999, white noise of equal power in every coil assumed). The
       g-factor, sqrt([(E^H E)^-1]_qq [E^H E]_qq) >= 1, is how much the
       unfolding amplifies the noise beyond the sqrt(R) lost by scanning
       less; it is large where the coils cannot tell the folded pixels
       apart. The images a_c are already scaled by R (see reconCartesian),
       so w_q has unit size. */
    function cinv(ar, ai, n, br, bi) {
        // Gauss-Jordan with partial pivoting on a small complex matrix; a is destroyed
        for (let i = 0; i < n * n; i++) { br[i] = 0; bi[i] = 0; }
        for (let i = 0; i < n; i++) br[i * n + i] = 1;
        for (let col = 0; col < n; col++) {
            let piv = col, best = -1;
            for (let r = col; r < n; r++) {
                const m = ar[r * n + col] * ar[r * n + col] + ai[r * n + col] * ai[r * n + col];
                if (m > best) { best = m; piv = r; }
            }
            if (!(best > 0)) return false;
            if (piv !== col) {
                for (let k = 0; k < n; k++) {
                    let t = ar[col * n + k]; ar[col * n + k] = ar[piv * n + k]; ar[piv * n + k] = t;
                    t = ai[col * n + k]; ai[col * n + k] = ai[piv * n + k]; ai[piv * n + k] = t;
                    t = br[col * n + k]; br[col * n + k] = br[piv * n + k]; br[piv * n + k] = t;
                    t = bi[col * n + k]; bi[col * n + k] = bi[piv * n + k]; bi[piv * n + k] = t;
                }
            }
            const pr = ar[col * n + col], pim = ai[col * n + col], d = pr * pr + pim * pim;
            const qr = pr / d, qi = -pim / d;
            for (let k = 0; k < n; k++) {
                let x = ar[col * n + k], y = ai[col * n + k];
                ar[col * n + k] = x * qr - y * qi; ai[col * n + k] = x * qi + y * qr;
                x = br[col * n + k]; y = bi[col * n + k];
                br[col * n + k] = x * qr - y * qi; bi[col * n + k] = x * qi + y * qr;
            }
            for (let r = 0; r < n; r++) {
                if (r === col) continue;
                const fr = ar[r * n + col], fi = ai[r * n + col];
                if (fr === 0 && fi === 0) continue;
                for (let k = 0; k < n; k++) {
                    const xr = ar[col * n + k], xi = ai[col * n + k];
                    ar[r * n + k] -= fr * xr - fi * xi; ai[r * n + k] -= fr * xi + fi * xr;
                    const yr = br[col * n + k], yi = bi[col * n + k];
                    br[r * n + k] -= fr * yr - fi * yi; bi[r * n + k] -= fr * yi + fi * yr;
                }
            }
        }
        return true;
    }

    function senseUnfold(imgRe, imgIm, mapRe, mapIm, W, Hs, R, kappa0) {
        const nC = imgRe.length, M = Hs / R, N = W * Hs;
        const rhoRe = new Float64Array(N), rhoIm = new Float64Array(N), g = new Float64Array(N);
        const wr = new Float64Array(R), wi = new Float64Array(R);
        for (let q = 0; q < R; q++) { const ph = -2 * PI * q * kappa0 / R; wr[q] = cos(ph); wi[q] = sin(ph); }
        const ER = new Float64Array(nC * R), EI = new Float64Array(nC * R);
        const AR = new Float64Array(R * R), AI = new Float64Array(R * R), A0 = new Float64Array(R);
        const BR = new Float64Array(R * R), BI = new Float64Array(R * R);
        const bR = new Float64Array(R), bI = new Float64Array(R);
        const pos = new Int32Array(R);
        let failed = 0;
        for (let j = 0; j < M; j++) {
            for (let x = 0; x < W; x++) {
                for (let q = 0; q < R; q++) pos[q] = (j + q * M) * W + x;
                for (let c = 0; c < nC; c++) {
                    const mr = mapRe[c], mi = mapIm[c];
                    for (let q = 0; q < R; q++) {
                        const p = pos[q], cr = mr[p], ci = mi[p];
                        ER[c * R + q] = wr[q] * cr - wi[q] * ci;
                        EI[c * R + q] = wr[q] * ci + wi[q] * cr;
                    }
                }
                // A = E^H E, b = E^H a
                let tr = 0;
                const p0 = j * W + x;
                for (let q = 0; q < R; q++) {
                    let sr = 0, si = 0;
                    for (let c = 0; c < nC; c++) {
                        const er = ER[c * R + q], ei = -EI[c * R + q], ar = imgRe[c][p0], ai = imgIm[c][p0];
                        sr += er * ar - ei * ai; si += er * ai + ei * ar;
                    }
                    bR[q] = sr; bI[q] = si;
                    for (let p = 0; p < R; p++) {
                        let mr = 0, mi = 0;
                        for (let c = 0; c < nC; c++) {
                            const er = ER[c * R + q], ei = -EI[c * R + q], fr = ER[c * R + p], fi = EI[c * R + p];
                            mr += er * fr - ei * fi; mi += er * fi + ei * fr;
                        }
                        AR[q * R + p] = mr; AI[q * R + p] = mi;
                    }
                    A0[q] = AR[q * R + q];
                    tr += A0[q];
                }
                if (!(tr > 0) || !cinv(AR, AI, R, BR, BI)) {
                    failed++;
                    for (let q = 0; q < R; q++) g[pos[q]] = NaN;
                    continue;
                }
                for (let q = 0; q < R; q++) {
                    let sr = 0, si = 0;
                    for (let p = 0; p < R; p++) {
                        const xr = BR[q * R + p], xi = BI[q * R + p];
                        sr += xr * bR[p] - xi * bI[p]; si += xr * bI[p] + xi * bR[p];
                    }
                    rhoRe[pos[q]] = sr; rhoIm[pos[q]] = si;
                    g[pos[q]] = sqrt(max(0, BR[q * R + q] * A0[q]));
                }
            }
        }
        return { re: rhoRe, im: rhoIm, g, failed };
    }

    /* Change the number of rows of a band-limited complex image (same
       field of view) by Fourier interpolation: transform each column,
       keep the central k-space rows, transform back. Used when SENSE had
       to pad the phase-encode grid to a multiple of R. */
    function resampleRows(re, im, W, Hin, Hout) {
        const oRe = new Float64Array(W * Hout), oIm = new Float64Array(W * Hout);
        const a = new Float64Array(Hin), b = new Float64Array(Hin), ta = new Float64Array(Hin), tb = new Float64Array(Hin);
        const c = new Float64Array(Hout), d = new Float64Array(Hout), tc = new Float64Array(Hout), td = new Float64Array(Hout);
        const off = (Hin >> 1) - (Hout >> 1), sc = Hout / Hin;
        for (let x = 0; x < W; x++) {
            for (let i = 0; i < Hin; i++) { a[i] = re[i * W + x]; b[i] = im[i * W + x]; }
            fft1c(a, b, false, ta, tb);
            for (let i = 0; i < Hout; i++) { const s = i + off; c[i] = s >= 0 && s < Hin ? a[s] : 0; d[i] = s >= 0 && s < Hin ? b[s] : 0; }
            fft1c(c, d, true, tc, td);
            for (let i = 0; i < Hout; i++) { oRe[i * W + x] = c[i] * sc; oIm[i * W + x] = d[i] * sc; }
        }
        return { re: oRe, im: oIm };
    }
    function resampleRowsNearest(a, W, Hin, Hout) {
        const out = new Float64Array(W * Hout), ci = Hin >> 1, co = Hout >> 1;
        for (let i = 0; i < Hout; i++) {
            const s = clamp(round((i - co) * Hin / Hout) + ci, 0, Hin - 1);
            for (let x = 0; x < W; x++) out[i * W + x] = a[s * W + x];
        }
        return out;
    }

    /* ---------- the Cartesian path ---------- */

    /* Fill one line of the first transform pass (see hybridRow) from a
       k-space row src[so .. so + n), each sample times w (and times the
       filter weight, when there is a filter). */
    function fillLine(tr, ti, sr, si, so, n, filt, w, W) {
        tr.fill(0); ti.fill(0);
        let u = W - (n >> 1);                 // sample j goes to slot (j - floor(n/2)) mod W
        for (let j = 0; j < n; j++) {
            if (u === W) u = 0;
            const f = filt ? w * filt[so + j] : w;
            tr[u] = sr[so + j] * f; ti[u] = si[so + j] * f;
            u++;
        }
    }
    function rowNonZero(sr, si, so, n) {
        for (let j = 0; j < n; j++) if (sr[so + j] !== 0 || si[so + j] !== 0) return true;
        return false;
    }

    /* Which phase-encode lines the whole acquisition records, and the
       polarity of every readout. Depends only on the acquisition plan (and
       the edit mask), so without a mask it is kept with the plan. */
    function planLines(plan, idx, axis, nro, npe, um) {
        const rowPlan = new Uint8Array(npe), colPlan = new Uint8Array(nro);
        const polarity = new Int8Array(plan.length);
        let nPos = 0, nNeg = 0;
        for (let r = 0; r < plan.length; r++) {
            const ro = plan[r], a = idx[r], n = a.length;
            const kro = axis === 'x' ? ro.kx : ro.ky;
            const d = n > 1 ? kro[n - 1] - kro[0] : 0;
            polarity[r] = d > 0 ? 1 : (d < 0 ? -1 : 0);
            if (d > 0) nPos++; else if (d < 0) nNeg++;
            for (let j = 0; j < n; j++) {
                const p = a[j];
                if (p < 0 || (um && !um[p])) continue;
                rowPlan[(p / nro) | 0] = 1; colPlan[p % nro] = 1;
            }
        }
        return { rowPlan, colPlan, polarity, bipolar: nPos >= 2 && nNeg >= 2, lines: analyzeLines(rowPlan, npe) };
    }

    function reconCartesian(acq, o, plan, nUse, nCoils, geo, notes) {
        const { axis, nRo, nro, npe, dro, dpe, idx } = geo;
        const NN = nro * npe, cpe = npe >> 1;
        const flip = axis === 'y';                       // internal layout is the transpose of the image
        const knx = flip ? npe : nro, kny = flip ? nro : npe;
        const kdx = flip ? dpe : dro, kdy = flip ? dro : dpe;
        const physRo = axis, physPe = axis === 'x' ? 'y' : 'x';

        // user mask (k-space tab edits), given in image orientation
        let um = null;
        if (o.userMask) {
            if (maskFits(o, knx, kny, kdx, kdy)) um = flip ? transpose(o.userMask, nro, npe) : o.userMask;
            else notes.push(MASK_MISMATCH);
        }

        // --- the plan: which lines the whole acquisition records, and readout polarity
        let pl = um ? null : geo.lineInfo;
        if (!pl) {
            pl = planLines(plan, idx, axis, nro, npe, um);
            if (!um) geo.lineInfo = pl;
        }
        const { colPlan, polarity, bipolar, lines } = pl;

        // --- grid the readouts recorded so far; repeats of one point are averaged
        const kre = [], kim = [];
        for (let c = 0; c < nCoils; c++) { kre.push(new Float32Array(NN)); kim.push(new Float32Array(NN)); }
        const cnt = new Float64Array(NN), tsum = new Float64Array(NN);
        const order = new Float32Array(NN); order.fill(NaN);
        const rowPos = new Int32Array(npe), rowNeg = new Int32Array(npe);
        for (let r = 0; r < nUse; r++) {
            const ro = plan[r], a = idx[r], n = a.length, h = n >> 1;
            const te = isNum(ro.te) ? ro.te : NaN, dw = isNum(ro.dwell) ? ro.dwell : 0;
            const id = isNum(ro.index) ? ro.index : r;
            let row = -1;
            for (let j = 0; j < n; j++) {
                const p = a[j];
                if (p < 0 || (um && !um[p])) continue;
                cnt[p]++; tsum[p] += te + (j - h) * dw; order[p] = id;
                row = (p / nro) | 0;
            }
            if (row < 0) continue;
            if (polarity[r] > 0) rowPos[row]++; else if (polarity[r] < 0) rowNeg[row]++;
            for (let c = 0; c < nCoils; c++) {
                const sr = ro.re[c], si = ro.im[c], dr = kre[c], di = kim[c];
                if (!sr || !si) continue;
                for (let j = 0; j < n; j++) {
                    const p = a[j];
                    if (p < 0 || (um && !um[p])) continue;
                    const vr = sr[j], vi = si[j];
                    if (vr === vr && vi === vi) { dr[p] += vr; di[p] += vi; }     // skip NaN
                }
            }
        }
        let nDup = 0;
        const mask = new Uint8Array(NN), tmap = new Float32Array(NN);
        for (let p = 0; p < NN; p++) {
            const k = cnt[p];
            if (!k) { tmap[p] = NaN; continue; }
            mask[p] = 1;
            tmap[p] = tsum[p] / k;
            if (k > 1) {
                nDup++;
                for (let c = 0; c < nCoils; c++) { kre[c][p] /= k; kim[c][p] /= k; }
            }
        }

        notes.push('Cartesian: samples placed on a ' + knx + ' × ' + kny + ' k-space grid (readout along ' + physRo +
            (geo.nro !== nRo ? ', oversampled ' + (nro / nRo) + '×' : '') + ').');
        if (geo.onGrid < geo.total) notes.push((geo.total - geo.onGrid) + ' samples were off the grid and were left out.');
        if (geo.outside) notes.push(geo.outside + ' samples fell outside the k-space grid and were left out.');
        if (nDup) notes.push('Some k-space points were recorded more than once; the repeats were averaged (' + nDup + ' points).');

        // --- EPI odd/even phase correction
        let epi = null;
        if (o.epiGhostCorr) {
            if (!bipolar) notes.push('EPI ghost correction applies only when the readout alternates in polarity; nothing to correct here.');
            else {
                const sign = new Int8Array(npe);
                for (let i = 0; i < npe; i++) sign[i] = rowPos[i] && !rowNeg[i] ? 1 : (rowNeg[i] && !rowPos[i] ? -1 : 0);
                epi = epiGhostCorrect(kre, kim, nro, npe, sign);
                if (epi) notes.push('EPI ghost correction: reversed and forward echoes differed in phase by ' + fmt(epi.phase0, 2) +
                    ' rad plus ' + fmt(epi.slope * nro, 2) + ' rad across the readout (estimated from ' + epi.lines +
                    ' central lines); half of that was removed from each polarity.');
                else notes.push('EPI ghost correction: no central lines of both polarities recorded yet, so nothing was corrected.');
            }
        } else if (bipolar) {
            notes.push('Readouts alternate in polarity (EPI). If the image has a ghost shifted by half the field of view, try EPI ghost correction.');
        }

        /* --- k-space for display: as gridded (after EPI correction), before
           any filtering. With the readout along x these are the gridding
           arrays themselves; nothing below writes to them. */
        const kspace = {
            nx: knx, ny: kny, dkx: kdx, dky: kdy,
            re: flip ? kre.map(a => transpose(a, npe, nro)) : kre.slice(),
            im: flip ? kim.map(a => transpose(a, npe, nro)) : kim.slice(),
            mask: flip ? transpose(mask, npe, nro) : mask,
            tmap: flip ? transpose(tmap, npe, nro) : tmap,
            order: flip ? transpose(order, npe, nro) : order
        };

        // --- what to do about missing lines
        const R = lines.R;
        let pfMethod = null;
        if (lines.pf) {
            pfMethod = o.partialFourier === 'conjugate' || o.partialFourier === 'homodyne' ? o.partialFourier : 'zero';
            const f = lines.pf;
            let msg = 'Partial Fourier along ' + physPe + ': ' + (npe - f.missing) + ' of ' + npe + ' phase-encode lines recorded (fraction ' + fmt(f.fraction, 3) + ').';
            if (f.h < 0) { pfMethod = 'zero'; msg += ' The centre of k-space was not recorded, so the image cannot be recovered; missing lines are zero.'; }
            else if (R > 1 && pfMethod !== 'zero') { pfMethod = 'zero'; msg += ' Combined with undersampling, the missing block is zero-filled.'; }
            else if (pfMethod === 'zero') msg += ' Missing lines are zero-filled: the image is blurred along ' + physPe + '.';
            else if (pfMethod === 'conjugate') msg += ' Missing lines filled from the opposite side by conjugate symmetry (assumes a real object apart from one overall phase).';
            else msg += ' Homodyne reconstruction: the image phase is estimated from the ' + (2 * f.h + 1) +
                ' symmetric central lines and removed, and conjugate symmetry stands in for the missing lines.';
            notes.push(msg);
        } else if (lines.lowRes) {
            if (lines.first <= cpe && lines.last >= cpe) notes.push('Only phase-encode lines ' + lines.first + ' to ' + lines.last + ' of 0 to ' + (npe - 1) +
                ' are present (the centre of k-space and its neighbours): missing lines are zero, so the image has low resolution along ' + physPe + '.');
            else notes.push('The centre of k-space (line ' + cpe + ') was not recorded, so the image has lost its contrast and most of its signal; missing lines are zero.');
        }
        {
            let lo = 0, hi = 0;
            while (lo < nro && !colPlan[lo]) lo++;
            while (hi < nro && !colPlan[nro - 1 - hi]) hi++;
            if (lo < nro && max(lo, hi) >= ceil(nro / 16) && min(lo, hi) <= 1) {
                notes.push('Partial echo: ' + max(lo, hi) + ' readout samples missing on one side of k-space; they are zero (partial Fourier methods act on the phase-encode direction only).');
            }
        }
        if (lines.gaps) notes.push('Some phase-encode lines are missing irregularly; they are zero, which smears the image along ' + physPe + '.');
        if (lines.sparse) notes.push('Only a few widely spaced lines were recorded; they are zero-filled.');

        /* --- the image grid. W x H is the full (zero-filled) grid; the
           readout oversampling is cropped to Wc columns between the two
           halves of the transform. Everything after the crop (homodyne,
           SENSE, coil combination) works along the phase encoding or
           pixel by pixel, so it gives the same numbers on the kept columns
           as it would on the full width. */
        const zf = o.zeroFill >= 2 ? 2 : 1;
        const W = nro * zf, H = npe * zf;
        const Wc = o.cropOversampling ? min(W, nRo * zf) : W;
        const x0 = (W >> 1) - (Wc >> 1);
        const roFov = (Wc / W) / dro;                    // field of view of the kept columns

        // --- parallel imaging decision
        let senseOn = false, senseMaps = null, Hs = H;
        if (R > 1) {
            if (o.parallel === 'sense') {
                if (nCoils < R) notes.push('Undersampled by R = ' + R + ' but SENSE needs at least R receive coils (there ' + (nCoils === 1 ? 'is 1' : 'are ' + nCoils) + '): showing the folded image.');
                else {
                    Hs = ceil(H / R) * R;
                    const mp = getMaps(acq, nCoils, flip ? Hs : Wc, flip ? Wc : Hs, flip ? 1 / dpe : roFov, flip ? roFov : 1 / dpe);
                    if (!mp) { notes.push('Undersampled by R = ' + R + ' but no coil sensitivity maps are available: showing the folded image.'); Hs = H; }
                    else {
                        senseOn = true;
                        senseMaps = flip ? { re: mp.re.map(a => transpose(a, Wc, Hs)), im: mp.im.map(a => transpose(a, Wc, Hs)) } : mp;
                    }
                }
            } else {
                notes.push('Undersampled: every ' + nth(R) + ' phase-encode line recorded (R = ' + R + '), so the field of view along ' + physPe +
                    ' is 1/' + R + ' of the full one and the image folds over. Choose SENSE to unfold it with the coil sensitivities.');
            }
        }

        // --- weights applied to k-space before the transform: filter, homodyne
        const filt = filterWeights(o.filter, o.filterParam, nro, npe);
        if (o.filter && o.filter !== 'none') {
            if (filt) notes.push('k-space filter: ' + o.filter + (o.filter === 'tukey' || o.filter === 'fermi' ? ' (parameter ' + fmt(clamp(isNum(o.filterParam) ? o.filterParam : 0.5, 0, 1), 2) + ')' : '') + '; less ringing and noise, a little less resolution.');
            else notes.push('Unknown filter "' + o.filter + '" ignored.');
        }
        let lpRow = null, hd = null;
        if (pfMethod === 'homodyne') {
            /* Homodyne (Noll, Nishimura and Macovski 1991). For a real
               object k-space is conjugate symmetric, S(-k) = conj S(k), so
               the recorded side can stand in for the missing one: weight the
               lines with H, where H(k) + H(-k) = 2 (2 on the side with no
               partner, 0 on the missing side, a ramp through the symmetric
               centre), transform, and the real part is the object. A
               measured image is never quite real (coil phase,
               off-resonance), so its slowly varying phase is first
               estimated from the symmetric centre alone (a low-resolution
               image) and removed before taking the real part. */
            const f = lines.pf;
            hd = { s: f.side === 'low' ? 1 : -1, h: f.h, shifts: [] };
            lpRow = new Float64Array(npe);
            for (let i = 0; i < npe; i++) lpRow[i] = abs(i - cpe) <= f.h ? 0.5 + 0.5 * cos(PI * (i - cpe) / (f.h + 1)) : 0;
        }

        // --- per coil: fill, weight, zero-fill, inverse FFT (cropping in between)
        const offPe = (Hs >> 1) - cpe, N = Wc * Hs;
        const scale = W * Hs * dro * dpe * R;    // section 3 scaling; R restores the intensity of a folded image
        const hyRe = scratch('hyRe', Float64Array, N), hyIm = scratch('hyIm', Float64Array, N);
        const tr = scratch('lineRe', Float64Array, W), ti = scratch('lineIm', Float64Array, W);
        const tc = scratch('colRe', Float64Array, Hs), tci = scratch('colIm', Float64Array, Hs);
        const imgRe = [], imgIm = [];
        for (let c = 0; c < nCoils; c++) {
            let sr = kre[c], si = kim[c];
            if (pfMethod === 'conjugate') {
                // filled on a copy: kre is also the k-space shown on the k-space tab
                sr = Float64Array.from(sr); si = Float64Array.from(si);
                conjugateFill(sr, si, nro, npe, lines.pf);
            }
            let hwRow = null, lr = null, li = null;
            if (hd) {
                // low-resolution image from the symmetric centre: its phase is the estimate
                lr = scratch('lowRe', Float64Array, N); li = scratch('lowIm', Float64Array, N);
                hyRe.fill(0); hyIm.fill(0);
                const es = echoStats(W, Hs);
                for (let i = 0; i < npe; i++) {
                    const w = lpRow[i];
                    if (!w || !rowNonZero(sr, si, i * nro, nro)) continue;
                    fillLine(tr, ti, sr, si, i * nro, nro, null, w, W);
                    U.fft(tr, ti, true);
                    echoAdd(es, i + offPe, tr, ti);
                    gatherRow(tr, ti, W, x0, Wc, hyRe, hyIm, Hs, i + offPe);
                }
                hybridCols(hyRe, hyIm, Hs, Wc, 0, Hs, 1, lr, li, tc, tci);
                const mc = echoCentre(es, hd.h);
                hd.shifts.push(mc);
                hwRow = homodyneWeights(npe, cpe, hd.s, hd.h, mc);
            }
            hyRe.fill(0); hyIm.fill(0);
            for (let i = 0; i < npe; i++) {
                const hw = hwRow ? hwRow[i] : 1;
                if (!hw || !rowNonZero(sr, si, i * nro, nro)) continue;
                fillLine(tr, ti, sr, si, i * nro, nro, filt, hw, W);
                hybridRow(tr, ti, W, x0, Wc, hyRe, hyIm, Hs, i + offPe);
            }
            const gr = new Float32Array(N), gi = new Float32Array(N);
            hybridCols(hyRe, hyIm, Hs, Wc, 0, Hs, scale, gr, gi, tc, tci);
            if (lr) {
                // keep Re(image e^-i phase) e^i phase: the real part in the frame of the estimated phase
                for (let p = 0; p < N; p++) {
                    const a = lr[p], b = li[p], m = sqrt(a * a + b * b);
                    const ur = m > 0 ? a / m : 1, ui = m > 0 ? b / m : 0;
                    const re = gr[p] * ur + gi[p] * ui;
                    gr[p] = re * ur; gi[p] = re * ui;
                }
            }
            imgRe.push(gr); imgIm.push(gi);
        }
        if (hd && hd.shifts.some(v => abs(v) >= 0.05)) {
            notes.push('Homodyne: the echo peak sat ' + hd.shifts.map(v => fmt(v, 2)).join(', ') +
                ' lines from the centre of k-space (a phase ramp across the image), so the weighting was centred on it.');
        }

        // --- SENSE unfolding
        let rho = null, gmap = null;
        if (senseOn) {
            const s = senseUnfold(imgRe, imgIm, senseMaps.re, senseMaps.im, Wc, Hs, R, lines.kappa0);
            rho = { re: s.re, im: s.im }; gmap = s.g;
            if (Hs !== H) {
                rho = resampleRows(rho.re, rho.im, Wc, Hs, H);
                gmap = resampleRowsNearest(gmap, Wc, Hs, H);
                for (let c = 0; c < nCoils; c++) {
                    const t = resampleRows(imgRe[c], imgIm[c], Wc, Hs, H);
                    imgRe[c] = t.re; imgIm[c] = t.im;
                }
            }
            const gs = gStats(gmap, rho.re, rho.im);
            notes.push('Undersampled by R = ' + R + ' (every ' + nth(R) + ' phase-encode line). SENSE unfolded the image along ' + physPe +
                ' with the coil sensitivities; g-factor ' + (gs.inObject ? 'within the object' : 'over the image') + ': mean ' + fmt(gs.mean, 3) + ', max ' + fmt(gs.max, 3) +
                '. SENSE combines the coils itself, so the coil-combination setting does not apply.' +
                (Hs !== H ? ' (The phase-encode grid was padded to a multiple of R for the unfolding.)' : ''));
            if (s.failed) notes.push('SENSE could not unfold ' + s.failed + ' pixel groups (the coils cannot tell them apart).');
        }

        // --- the readout oversampling was cropped above; back to image orientation
        if (Wc < W) notes.push('Readout oversampling cropped: ' + W + ' to ' + Wc + ' pixels along ' + physRo + '.');
        else if (nro > nRo) notes.push('Readout oversampling kept: the image shows ' + (nro / nRo) + '× the field of view along ' + physRo + '.');
        const toImage = (a) => {
            const f = a instanceof Float32Array ? a : Float32Array.from(a);
            return flip ? transpose(f, H, Wc) : f;
        };
        const cRe = imgRe.map(toImage), cIm = imgIm.map(toImage);
        const nxo = flip ? H : Wc, nyo = flip ? Wc : H;
        const peFov = 1 / dpe;
        const fovXo = flip ? peFov : roFov, fovYo = flip ? roFov : peFov;
        const sense = rho ? { re: toImage(rho.re), im: toImage(rho.im), g: toImage(gmap) } : null;

        const out = combineCoils(acq, o, cRe, cIm, nxo, nyo, fovXo, fovYo, sense, notes);
        if (zf > 1) notes.push('Zero-filled ×2: a finer pixel grid by interpolation, no new detail.');
        return {
            kspace,
            coilImages: { nx: nxo, ny: nyo, re: cRe, im: cIm },
            image: { nx: nxo, ny: nyo, fovX: fovXo, fovY: fovYo, re: out.re, im: out.im, mag: out.mag },
            gfactor: sense ? sense.g : null,
            info: {
                cartesian: true, undersampling: R, partialFourier: lines.pf ? lines.pf.fraction : 1, notes,
                readoutAxis: axis, nReadouts: nUse, epi: epi
            }
        };
    }

    /* The g-factor summary for the recon notes, over the map that is
       shown (after the crop) and within the object only: the pixels whose
       unfolded magnitude is above 10 % of its 99th percentile. Outside the
       object the g-factor is still defined, but it describes noise in
       empty space, and the oversampled margins would add values the
       displayed map does not contain. */
    function gStats(g, re, im) {
        const n = g.length, mag = new Float32Array(n);
        for (let p = 0; p < n; p++) mag[p] = sqrt(re[p] * re[p] + im[p] * im[p]);
        const sorted = Float32Array.from(mag).sort();
        const thr = 0.1 * (n ? sorted[floor(0.99 * (n - 1))] : 0);
        const inObject = thr > 0;
        let s = 0, k = 0, mx = 0;
        for (let p = 0; p < n; p++) {
            const v = g[p];
            if (!(v === v) || (inObject && !(mag[p] > thr))) continue;
            s += v; k++;
            if (v > mx) mx = v;
        }
        return { mean: s / max(1, k), max: mx, n: k, inObject };
    }

    /* Where along the phase-encode axis is the echo peak, in lines from
       k = 0? A phase ramp across the image, exp(i 2 pi k0 y), moves the
       whole of k-space by k0, and then the symmetry the homodyne weights
       rely on is about k0 rather than 0. Weighting about 0 regardless
       leaves an intensity error of about k0/h. The ramp is measured from
       the low-resolution image L as the average phase step from one row
       to the next, z = sum over rows i and columns x of
       L(i+1, x) conj L(i, x) (weighted by signal, no unwrapping needed):
       k0 in lines is arg(z) times the number of rows over 2 pi. Limited to
       half the symmetric band so that noise cannot push it anywhere silly.

       The sum runs over the full width of the low-resolution image,
       oversampled margins included, but the reconstruction only forms the
       columns it keeps. So z is accumulated from the readout-transformed
       rows G(m, x) instead (m the phase-encode line), before the crop. With
       L(i) = (1/H) sum_m G(m) exp(i 2 pi (m - c)(i - c) / H) the shift
       theorem gives, for the sum over every row pair including the
       wrap-around pair (last row, first row),
           sum_i L(i+1) conj L(i) = (1/H) sum_m |G(m)|^2 exp(i 2 pi (m - c) / H),
       and the wrap-around pair L(0) conj L(H-1), which is not one of the
       neighbours, is subtracted after evaluating those two rows directly
       from the few lines of the symmetric centre. */
    function echoStats(W, H) {
        return { W, H, zr: 0, zi: 0, f0r: new Float64Array(W), f0i: new Float64Array(W), f1r: new Float64Array(W), f1i: new Float64Array(W) };
    }
    function echoAdd(st, m, tr, ti) {                // tr, ti: line m after the readout transform (any column order)
        const W = st.W, H = st.H, c = H >> 1;
        let s = 0;
        for (let x = 0; x < W; x++) s += tr[x] * tr[x] + ti[x] * ti[x];
        const th = 2 * PI * (m - c) / H;
        st.zr += s * cos(th) / H; st.zi += s * sin(th) / H;
        const p0 = 2 * PI * (m - c) * (0 - c) / H, p1 = 2 * PI * (m - c) * (H - 1 - c) / H;
        const c0 = cos(p0) / H, s0 = sin(p0) / H, c1 = cos(p1) / H, s1 = sin(p1) / H;
        const f0r = st.f0r, f0i = st.f0i, f1r = st.f1r, f1i = st.f1i;
        for (let x = 0; x < W; x++) {
            const gr = tr[x], gi = ti[x];
            f0r[x] += gr * c0 - gi * s0; f0i[x] += gr * s0 + gi * c0;      // row 0 of L
            f1r[x] += gr * c1 - gi * s1; f1i[x] += gr * s1 + gi * c1;      // row H - 1 of L
        }
    }
    function echoCentre(st, h) {
        let wr = 0, wi = 0;
        for (let x = 0; x < st.W; x++) {
            wr += st.f0r[x] * st.f1r[x] + st.f0i[x] * st.f1i[x];
            wi += st.f0i[x] * st.f1r[x] - st.f0r[x] * st.f1i[x];
        }
        const zr = st.zr - wr, zi = st.zi - wi;
        if (!(zr * zr + zi * zi > 0)) return 0;
        return clamp(atan2(zi, zr) * st.H / (2 * PI), -h / 2, h / 2);
    }

    /* Homodyne weights per phase-encode row. In the coordinate m' = s(i - c)
       (positive towards the fully recorded side), centred on the echo at
       c' = s mc: 0 below -h', 2 above +h', a ramp 1 + q/(h' + 1) between,
       so that H(c' + q) + H(c' - q) = 2 for every q. h' = h + c' keeps every
       missing line at weight 0 and the last recorded one just above it. */
    function homodyneWeights(npe, cpe, s, h, mc) {
        const w = new Float64Array(npe), cs = s * mc, hh = h + cs;
        for (let i = 0; i < npe; i++) {
            const q = s * (i - cpe) - cs;
            w[i] = q < -hh ? 0 : (q > hh ? 2 : 1 + q / (hh + 1));
        }
        return w;
    }

    /* Conjugate synthesis: S(-k) = conj(S(k)) for a real object, so a
       missing point is filled from its mirror image through the centre.
       A real object only has one overall phase (from the coil, the
       receiver), measured here at k = 0 and allowed for:
       S(k) = conj(S(-k)) exp(2 i phi0). Any phase that varies across the
       object breaks the symmetry, which is why homodyne exists. */
    function conjugateFill(sr, si, nro, npe, pf) {
        const cro = nro >> 1, cpe = npe >> 1, c0 = cpe * nro + cro;
        const m = hypot(sr[c0], si[c0]);
        const ur = m > 0 ? sr[c0] / m : 1, ui = m > 0 ? si[c0] / m : 0;
        const er = ur * ur - ui * ui, ei = 2 * ur * ui;          // exp(2 i phi0)
        const i0 = pf.side === 'low' ? 0 : npe - pf.missing, i1 = pf.side === 'low' ? pf.missing : npe;
        for (let i = i0; i < i1; i++) {
            const im = 2 * cpe - i;
            if (im < 0 || im >= npe) continue;
            for (let j = 0; j < nro; j++) {
                const jm = 2 * cro - j;
                if (jm < 0 || jm >= nro) { sr[i * nro + j] = 0; si[i * nro + j] = 0; continue; }
                const ar = sr[im * nro + jm], ai = -si[im * nro + jm];
                sr[i * nro + j] = ar * er - ai * ei; si[i * nro + j] = ar * ei + ai * er;
            }
        }
    }

    /* ---------- coil combination (common to both paths) ----------
       Each coil sees the object multiplied by its own sensitivity.
       Root-sum-of-squares needs no maps and gives the magnitude
       weighted by the combined sensitivity (bright near the coils);
       Roemer's sensitivity-weighted sum, sum conj(C) I / sum |C|^2,
       with white noise of equal power in each coil, gives the best SNR
       and an unshaded, complex image, but needs the maps. */
    function combineCoils(acq, o, cRe, cIm, nx, ny, fovX, fovY, sense, notes) {
        const N = nx * ny, nC = cRe.length;
        const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N);
        let mode = o.coilCombine === 'roemer' || o.coilCombine === 'single' ? o.coilCombine : 'sos';
        let maps = null;
        if (sense) {
            for (let p = 0; p < N; p++) { re[p] = sense.re[p]; im[p] = sense.im[p]; }
            mode = 'sense';
        } else if (mode === 'roemer') {
            maps = getMaps(acq, nC, nx, ny, fovX, fovY);
            if (!maps) { mode = 'sos'; notes.push('No coil sensitivity maps for this coil, so coils were combined by root-sum-of-squares instead.'); }
        }
        if (mode === 'single') {
            const k = clamp(floor(Number(o.coil) || 0), 0, nC - 1);
            for (let p = 0; p < N; p++) { re[p] = cRe[k][p]; im[p] = cIm[k][p]; }
            notes.push('Showing coil ' + (k + 1) + ' of ' + nC + ' on its own.');
        } else if (mode === 'roemer') {
            for (let p = 0; p < N; p++) {
                let sr = 0, si = 0, ss = 0;
                for (let c = 0; c < nC; c++) {
                    const mr = maps.re[c][p], mi = maps.im[c][p], ar = cRe[c][p], ai = cIm[c][p];
                    sr += mr * ar + mi * ai; si += mr * ai - mi * ar; ss += mr * mr + mi * mi;
                }
                if (ss > 0) { re[p] = sr / ss; im[p] = si / ss; }
            }
            if (nC > 1) notes.push('Coils combined with their sensitivities (Roemer): complex, without coil shading.');
        } else if (mode === 'sos') {
            for (let p = 0; p < N; p++) {
                let s = 0;
                for (let c = 0; c < nC; c++) s += cRe[c][p] * cRe[c][p] + cIm[c][p] * cIm[c][p];
                re[p] = sqrt(s);
            }
            if (nC > 1) notes.push('Coils combined by root-sum-of-squares: a magnitude image, brighter near the coils.');
        }
        for (let p = 0; p < N; p++) mag[p] = sqrt(re[p] * re[p] + im[p] * im[p]);
        return { re, im, mag };
    }

    /* ---------- the non-Cartesian path: gridding ---------- */

    /* Density compensation for radial spokes. A spoke samples the line
       through the centre evenly, but neighbouring spokes are further apart
       the further out you go, so a sample at radius |k| stands for an
       arc of k-space |k| dtheta long and dk wide: weight |k| dk dtheta
       (the "ramp filter" of filtered back projection). dtheta is measured
       from the actual spoke directions (half the gap to each neighbour),
       so unevenly spread or repeated spokes are handled too.
       The samples at k = 0, one per spoke, share a total weight of
       pi dk^2 / 6. Not the area of the central disk (pi dk^2 / 4): the ring
       weights 2 pi i dk^2 summed over rings i = 1, 2, ... already overcount
       the integral of a smooth function f by pi dk^2 f(0) / 6 (the
       Euler-Maclaurin correction), and with the disk area on top the whole
       image would sit on a small uniform offset (a few tenths of a percent
       of the object's integral). Returns null when the trajectory is not
       made of straight, evenly sampled lines through the origin. */
    function radialDcf(rds, Ns) {
        let dk = 0;
        const halves = [], dirs = [];
        for (let r = 0; r < rds.length; r++) {
            const ro = rds[r], n = ro.n;
            if (n < 2) return null;
            const x0 = ro.kx[0], y0 = ro.ky[0], x1 = ro.kx[n - 1], y1 = ro.ky[n - 1];
            const L = hypot(x1 - x0, y1 - y0);
            if (!(L > 0)) return null;
            const ux = (x1 - x0) / L, uy = (y1 - y0) / L, d = L / (n - 1);
            if (!dk) dk = d; else if (abs(d - dk) > 0.02 * dk) return null;
            if (abs(x0 * uy - y0 * ux) > 0.1 * d) return null;               // misses the origin
            for (let j = 0; j < n; j++) {
                if (hypot(ro.kx[j] - (x0 + j * d * ux), ro.ky[j] - (y0 + j * d * uy)) > 0.05 * d) return null;
            }
            const t0 = x0 * ux + y0 * uy, t1 = x1 * ux + y1 * uy;
            dirs.push({ ux, uy });
            if (t1 >= 0.5 * d) halves.push({ th: atan2(uy, ux), r, s: 1 });
            if (t0 <= -0.5 * d) halves.push({ th: atan2(-uy, -ux), r, s: -1 });
        }
        if (!halves.length) return null;
        for (const h of halves) if (h.th < 0) h.th += 2 * PI;
        halves.sort((a, b) => a.th - b.th);
        const dthPos = new Float64Array(rds.length), dthNeg = new Float64Array(rds.length), nh = halves.length;
        for (let i = 0; i < nh; i++) {
            let dth = 2 * PI;
            if (nh > 1) {
                const prev = halves[i].th - halves[(i - 1 + nh) % nh].th + (i === 0 ? 2 * PI : 0);
                const next = halves[(i + 1) % nh].th - halves[i].th + (i === nh - 1 ? 2 * PI : 0);
                dth = 0.5 * (prev + next);
            }
            if (halves[i].s > 0) dthPos[halves[i].r] = dth; else dthNeg[halves[i].r] = dth;
        }
        const w = new Float64Array(Ns);
        let s = 0, nCentre = 0;
        const centre = [];
        for (let r = 0; r < rds.length; r++) {
            const ro = rds[r], n = ro.n, ux = dirs[r].ux, uy = dirs[r].uy;
            for (let j = 0; j < n; j++, s++) {
                const t = ro.kx[j] * ux + ro.ky[j] * uy;
                if (abs(t) < 0.5 * dk) { centre.push(s); nCentre++; continue; }
                w[s] = abs(t) * dk * (t > 0 ? dthPos[r] : dthNeg[r]);
            }
        }
        for (const i of centre) w[i] = PI * dk * dk / 6 / nCentre;
        const nSpokes = halves.length / 2;
        return { w, dk, nSpokes };
    }

    /* Pipe-Menon iterative density compensation (Pipe and Menon 1999):
       start with w = 1 and repeatedly divide each weight by the
       kernel-weighted sum of the weights around it, w <- w / (w * C), until
       that sum is the same everywhere. Works for any trajectory. The
       result is converted to k-space area (cycles^2/m^2) with the
       kernel's integral: for uniform samples it then equals the area per
       sample. */
    function pipeMenon(Ns, tx, ty, ix0, iy0, Gx, Gy, dgx, dgy, iters) {
        const w = new Float64Array(Ns); w.fill(1);
        const grid = new Float64Array(Gx * Gy);
        for (let it = 0; it < iters; it++) {
            grid.fill(0);
            for (let s = 0; s < Ns; s++) {
                const ws = w[s];
                for (let b = 0; b < NTAP; b++) {
                    const wyv = ty[s * NTAP + b];
                    if (!wyv) continue;
                    let yy = iy0[s] + b; yy = ((yy % Gy) + Gy) % Gy;
                    const row = yy * Gx, f = ws * wyv;
                    for (let a = 0; a < NTAP; a++) {
                        const wxv = tx[s * NTAP + a];
                        if (!wxv) continue;
                        let xx = ix0[s] + a; xx = ((xx % Gx) + Gx) % Gx;
                        grid[row + xx] += f * wxv;
                    }
                }
            }
            for (let s = 0; s < Ns; s++) {
                let d = 0;
                for (let b = 0; b < NTAP; b++) {
                    const wyv = ty[s * NTAP + b];
                    if (!wyv) continue;
                    let yy = iy0[s] + b; yy = ((yy % Gy) + Gy) % Gy;
                    const row = yy * Gx;
                    for (let a = 0; a < NTAP; a++) {
                        const wxv = tx[s * NTAP + a];
                        if (!wxv) continue;
                        let xx = ix0[s] + a; xx = ((xx % Gx) + Gx) % Gx;
                        d += grid[row + xx] * wyv * wxv;
                    }
                }
                if (d > 0) w[s] /= d;
            }
        }
        const k = dgx * dgy * KB_SUM * KB_SUM * KB_SUM * KB_SUM;
        for (let s = 0; s < Ns; s++) w[s] *= k;
        return w;
    }

    /* The image-domain effect of the gridding kernel along one axis of a
       grid of G points: grid a single unit sample at k = 0 exactly as the
       data were gridded, and transform it. Dividing the image by this
       undoes the kernel's apodisation, discretisation included. */
    function apodisation(G) {
        const re = new Float64Array(G), im = new Float64Array(G), c = G >> 1;
        for (let m = -2; m <= 2; m++) { const i = ((c + m) % G + G) % G; re[i] += kb(m); }
        fft1c(re, im, true, new Float64Array(G), new Float64Array(G));
        return re;
    }

    /* Everything about gridding that does not depend on the
       reconstruction options: for each sample its kernel taps, its
       nearest grid point, its time and readout index, and the density
       compensation; then, built on first use for each densityComp
       setting, the gridded k-space of every coil. It is kept with the
       acquisition (see planFor), so that changing a filter, zero filling
       or the coil combination does not grid again. */
    function buildGridding(used, nCoils, dims) {
        const { nx, ny, fovX, fovY } = dims;
        const Gx = KB_OS * nx, Gy = KB_OS * ny, dgx = 1 / (KB_OS * fovX), dgy = 1 / (KB_OS * fovY);
        const cgx = Gx >> 1, cgy = Gy >> 1, NG = Gx * Gy;
        let Ns = 0;
        for (const r of used) Ns += r.n;

        // flatten the samples and precompute the kernel taps (shared by every coil)
        const ix0 = new Int32Array(Ns), iy0 = new Int32Array(Ns);
        const tx = new Float64Array(Ns * NTAP), ty = new Float64Array(Ns * NTAP);
        const near = new Int32Array(Ns), tSample = new Float64Array(Ns), ordS = new Float64Array(Ns);
        let s = 0, dropped = 0;
        for (let r = 0; r < used.length; r++) {
            const ro = used[r], n = ro.n, h = n >> 1;
            const te = isNum(ro.te) ? ro.te : NaN, dw = isNum(ro.dwell) ? ro.dwell : 0;
            const id = isNum(ro.index) ? ro.index : r;
            for (let j = 0; j < n; j++, s++) {
                const gx = ro.kx[j] / dgx + cgx, gy = ro.ky[j] / dgy + cgy;
                /* The grid is periodic (it is about to be Fourier
                   transformed), so a sample at the very edge wraps to the
                   opposite edge, which is the same point on the pixel
                   grid. Samples beyond the edge would alias onto the wrong
                   frequencies, so they are left out. */
                if (!(gx >= 0 && gx <= Gx && gy >= 0 && gy <= Gy)) { dropped++; near[s] = -1; ix0[s] = 0; iy0[s] = 0; continue; }
                const bx = floor(gx) - 2, by = floor(gy) - 2;
                ix0[s] = bx; iy0[s] = by;
                for (let a = 0; a < NTAP; a++) { tx[s * NTAP + a] = kb(bx + a - gx); ty[s * NTAP + a] = kb(by + a - gy); }
                let nxI = round(gx), nyI = round(gy);
                if (nxI === Gx) nxI = 0;
                if (nyI === Gy) nyI = 0;
                near[s] = nyI * Gx + nxI;
                tSample[s] = te + (j - h) * dw; ordS[s] = id;
            }
        }

        // density compensation
        const rad = radialDcf(used, Ns);
        const wDcf = rad ? rad.w : pipeMenon(Ns, tx, ty, ix0, iy0, Gx, Gy, dgx, dgy, 12);

        // where the samples are, for the k-space display (nearest grid point)
        const mask = new Uint8Array(NG), tmap = new Float32Array(NG), order = new Float32Array(NG), tcnt = new Float64Array(NG), tsum = new Float64Array(NG);
        order.fill(NaN);
        for (let q = 0; q < Ns; q++) {
            const p = near[q];
            if (p < 0) continue;
            mask[p] = 1; tcnt[p]++; tsum[p] += tSample[q]; order[p] = ordS[q];
        }
        for (let p = 0; p < NG; p++) tmap[p] = tcnt[p] ? tsum[p] / tcnt[p] : NaN;

        return { nUse: used.length, nCoils, used, Gx, Gy, dgx, dgy, cgx, cgy, NG, Ns, ix0, iy0, tx, ty, near,
            dropped, rad, wDcf, wUni: null, mask, tmap, order, kspace: {} };
    }

    /* Without density compensation every sample gets the same weight. Its
       size is chosen so that the total weight around k = 0 (kernel
       weighted) is what the density compensation would have put there:
       the image keeps its overall intensity (its integral) and only the
       blur from over-weighting the crowded centre of k-space remains. */
    function uniformWeights(G) {
        const { Ns, ix0, iy0, tx, ty, cgx, cgy } = G, w = G.wDcf;
        let dcf = 0, uni = 0;
        for (let q = 0; q < Ns; q++) {
            let c = 0;
            for (let b = 0; b < NTAP; b++) {
                if (iy0[q] + b !== cgy) continue;
                for (let a = 0; a < NTAP; a++) if (ix0[q] + a === cgx) c = ty[q * NTAP + b] * tx[q * NTAP + a];
            }
            dcf += c * w[q]; uni += c;
        }
        let sum = 0;
        for (let q = 0; q < Ns; q++) sum += w[q];
        const wu = uni > 0 && dcf > 0 ? dcf / uni : sum / max(1, Ns);
        const out = new Float64Array(Ns); out.fill(wu);
        return out;
    }

    /* The gridded k-space of every coil for one densityComp setting:
       each sample, times its weight, spread over the grid points its
       kernel touches. Stored as Float32 to halve the memory it holds. */
    function griddedKspace(G, dc) {
        const key = dc ? 'dcf' : 'uniform';
        if (G.kspace[key]) return G.kspace[key];
        let w = G.wDcf;
        if (!dc) w = G.wUni || (G.wUni = uniformWeights(G));
        const { used, nCoils, Gx, Gy, NG, ix0, iy0, tx, ty, near } = G;
        const gr = new Float64Array(NG), gi = new Float64Array(NG);
        const outRe = [], outIm = [];
        for (let c = 0; c < nCoils; c++) {
            gr.fill(0); gi.fill(0);
            let q = 0;
            for (let r = 0; r < used.length; r++) {
                const ro = used[r], n = ro.n, ar = ro.re[c], ai = ro.im[c];
                for (let j = 0; j < n; j++, q++) {
                    if (near[q] < 0) continue;
                    let vr = ar ? ar[j] : 0, vi = ai ? ai[j] : 0;
                    if (vr !== vr) vr = 0;
                    if (vi !== vi) vi = 0;
                    const fr = vr * w[q], fi = vi * w[q];
                    if (!fr && !fi) continue;
                    // kernels near the edge wrap around (the grid is periodic); the rest need no modulo
                    const bx = ix0[q], by = iy0[q], wrap = bx < 0 || by < 0 || bx + NTAP > Gx || by + NTAP > Gy;
                    for (let b = 0; b < NTAP; b++) {
                        const wyv = ty[q * NTAP + b];
                        if (!wyv) continue;
                        let yy = by + b;
                        if (wrap) yy = ((yy % Gy) + Gy) % Gy;
                        const row = yy * Gx;
                        for (let a = 0; a < NTAP; a++) {
                            const k = wyv * tx[q * NTAP + a];
                            if (!k) continue;
                            let xx = bx + a;
                            if (wrap) xx = ((xx % Gx) + Gx) % Gx;
                            gr[row + xx] += k * fr; gi[row + xx] += k * fi;
                        }
                    }
                }
            }
            outRe.push(Float32Array.from(gr)); outIm.push(Float32Array.from(gi));
        }
        return (G.kspace[key] = { re: outRe, im: outIm });
    }

    function reconGridded(acq, o, used, nCoils, dims, notes, cache) {
        const { nx, ny, fovX, fovY, os } = dims;
        let G = cache && cache.gridding;
        if (!G || G.nUse !== used.length || G.nCoils !== nCoils || G.used[0] !== used[0]) {
            G = buildGridding(used, nCoils, dims);
            if (cache) cache.gridding = G;
        }
        const { Gx, Gy, dgx, dgy, cgx, cgy, NG, Ns, rad } = G;
        if (G.dropped) notes.push(G.dropped + ' samples lay beyond the edge of k-space for this matrix and field of view and were left out.');

        let dcfNote;
        if (rad) {
            dcfNote = 'density compensation by the |k| ramp of radial sampling';
            const need = PI / 2 * max(nx, ny);
            notes.push('Radial: ' + fmt(rad.nSpokes, 4) + ' spokes through the centre of k-space.' +
                (rad.nSpokes < 0.95 * need ? ' Full sampling at the edge of k-space needs about π/2 × N = ' + round(need) +
                    ' spokes; with fewer, expect streaks.' : ''));
        } else dcfNote = 'density compensation by Pipe-Menon iteration';
        if (!o.densityComp) dcfNote = 'NO density compensation (every sample weighted equally, so the densely sampled centre of k-space dominates and the image is blurred)';
        notes.push('Non-Cartesian: ' + Ns + ' samples gridded with a Kaiser-Bessel kernel (width 4) onto a ' + Gx + ' × ' + Gy +
            ' grid (2× oversampled), ' + dcfNote + ', then deapodised.');
        const gk = griddedKspace(G, !!o.densityComp);

        // the edit mask from the k-space tab removes grid points after gridding
        const mask = G.mask.slice();
        let um = null;
        if (o.userMask) {
            if (maskFits(o, Gx, Gy, dgx, dgy)) {
                um = o.userMask;
                for (let p = 0; p < NG; p++) if (!um[p]) mask[p] = 0;
            } else notes.push(MASK_MISMATCH);
        }

        // display copy in k-space units: divide out the kernel's area
        const ks = 1 / (dgx * dgy * KB_SUM * KB_SUM);
        const disp = (a) => {
            const b = new Float32Array(NG);
            for (let p = 0; p < NG; p++) b[p] = a[p] * ks;
            if (um) for (let p = 0; p < NG; p++) if (!um[p]) b[p] = 0;
            return b;
        };
        const kspace = { nx: Gx, ny: Gy, dkx: dgx, dky: dgy, re: gk.re.map(disp), im: gk.im.map(disp), mask, tmap: G.tmap.slice(), order: G.order.slice() };

        /* filter, zero-fill, transform, deapodise, crop. As in the
           Cartesian path the crop to the field of view happens between the
           two halves of the transform, along x first and then along y. */
        const filt = filterWeights(o.filter, o.filterParam, Gx, Gy);
        if (o.filter && o.filter !== 'none') notes.push(filt ? 'k-space filter: ' + o.filter + '.' : 'Unknown filter "' + o.filter + '" ignored.');
        const zf = o.zeroFill >= 2 ? 2 : 1;
        const Wz = Gx * zf, Hz = Gy * zf, offY = (Hz >> 1) - cgy;
        const ax = apodisation(Wz), ay = apodisation(Hz);
        const keep = o.cropOversampling ? 1 : clamp(os, 1, KB_OS);
        const Wc = nx * zf * keep, Hc = ny * zf * keep;
        if (o.cropOversampling && os > 1) notes.push('Readout oversampling cropped to the ' + fmt(fovX * 1e3) + ' mm field of view.');
        const x0 = (Wz >> 1) - (Wc >> 1), y0 = (Hz >> 1) - (Hc >> 1);
        const hyRe = scratch('hyRe', Float64Array, Wc * Hz), hyIm = scratch('hyIm', Float64Array, Wc * Hz);
        const tr = scratch('lineRe', Float64Array, Wz), ti = scratch('lineIm', Float64Array, Wz);
        const tc = scratch('colRe', Float64Array, Hz), tci = scratch('colIm', Float64Array, Hz);
        const zr = scratch('outRe', Float64Array, Wc * Hc), zi = scratch('outIm', Float64Array, Wc * Hc);
        const cRe = [], cIm = [];
        for (let c = 0; c < nCoils; c++) {
            const ga = gk.re[c], gb = gk.im[c];
            hyRe.fill(0); hyIm.fill(0);
            for (let i = 0; i < Gy; i++) {
                const so = i * Gx;
                let any = false;
                tr.fill(0); ti.fill(0);
                let u = Wz - cgx;                  // grid column j goes to slot (j - cgx) mod Wz
                for (let j = 0; j < Gx; j++, u++) {
                    if (u === Wz) u = 0;
                    const p = so + j, vr = ga[p], vi = gb[p];
                    if ((vr === 0 && vi === 0) || (um && !um[p])) continue;
                    const f = filt ? filt[p] : 1;
                    tr[u] = vr * f; ti[u] = vi * f; any = true;
                }
                if (any) hybridRow(tr, ti, Wz, x0, Wc, hyRe, hyIm, Hz, i + offY);
            }
            hybridCols(hyRe, hyIm, Hz, Wc, y0, Hc, 1, zr, zi, tc, tci);
            const or = new Float32Array(Wc * Hc), oi = new Float32Array(Wc * Hc);
            for (let i = 0; i < Hc; i++) {
                const ry = ay[i + y0];
                for (let j = 0; j < Wc; j++) {
                    const d = ry * ax[j + x0], p = i * Wc + j;
                    if (d !== 0) { or[p] = zr[p] / d; oi[p] = zi[p] / d; }
                }
            }
            cRe.push(or); cIm.push(oi);
        }
        if (zf > 1) notes.push('Zero-filled ×2: a finer pixel grid by interpolation, no new detail.');
        const fovXo = fovX * Wc / (nx * zf), fovYo = fovY * Hc / (ny * zf);
        if (o.epiGhostCorr) notes.push('EPI ghost correction applies to Cartesian EPI only.');
        const out = combineCoils(acq, o, cRe, cIm, Wc, Hc, fovXo, fovYo, null, notes);
        return {
            kspace,
            coilImages: { nx: Wc, ny: Hc, re: cRe, im: cIm },
            image: { nx: Wc, ny: Hc, fovX: fovXo, fovY: fovYo, re: out.re, im: out.im, mag: out.mag },
            gfactor: null,
            info: { cartesian: false, undersampling: 1, partialFourier: 1, notes, readoutAxis: dims.readoutAxis || 'radial', nReadouts: used.length,
                spokes: rad ? rad.nSpokes : null }
        };
    }

    /* ---------- per-acquisition cache ----------
       A change of reconstruction option re-runs run() on the same
       acquisition, and much of the work does not depend on the options:
       the list of usable readouts and their largest k, where every sample
       sits on the Cartesian grid and which lines the plan records, and for
       non-Cartesian data the whole gridding (above). These are kept here,
       keyed on the acquisition object (a WeakMap, so they go when the
       acquisition does); the gridding only for the latest number of
       readouts. An acquisition is not changed after the scan, but the
       cache checks its readout list and grid anyway. */
    const acqCache = new WeakMap();
    function planFor(acq) {
        const g = acq.grid, all = Array.isArray(acq.readouts) ? acq.readouts : [];
        const sig = [g.nx, g.ny, g.fovX, g.fovY, g.readoutAxis, g.oversample, acq.nCoils, all.length].join('|');
        let c = acqCache.get(acq);
        if (c && c.all === all && c.sig === sig) return c;
        // the plan: every usable readout; the ones recorded so far are a prefix of it
        const plan = [], src = [];
        let kmax = 0;
        for (let i = 0; i < all.length; i++) {
            const r = all[i];
            if (!validReadout(r)) continue;
            const n = readoutLength(r);
            plan.push({ kx: r.kx, ky: r.ky, re: r.re, im: r.im, n, te: r.te, dwell: r.dwell, index: isNum(r.index) ? r.index : i });
            src.push(i);
            for (let j = 0; j < n; j++) { const v = abs(r.kx[j]) + abs(r.ky[j]); if (v > kmax) kmax = v; }
        }
        c = { all, sig, plan, src, kmax, guess: undefined, geo: null, gridding: null };
        if (typeof acq === 'object') acqCache.set(acq, c);
        return c;
    }

    /* ---------- entry point ---------- */

    /* run(acq, opts, {upTo}) -> ReconResult. Synchronous. upTo limits
       the reconstruction to the first upTo readouts in acquisition order
       (the playback shows k-space filling). The shape of the acquisition
       (Cartesian or not, partial Fourier, undersampling, EPI) is judged
       from the whole plan, so it does not change as playback proceeds.
       Never throws: odd inputs give a zero image and a note. */
    function run(acq, opts, extra) {
        const o = Object.assign({}, DEFAULTS, opts || {});
        try {
            return runInner(acq, o, extra && extra.upTo);
        } catch (err) {
            return emptyResult(acq, ['Reconstruction failed: ' + ((err && err.message) || String(err))]);
        }
    }

    function runInner(acq, o, upTo) {
        if (!acq || !acq.grid) return emptyResult(acq, ['Nothing to reconstruct yet: run a scan first.']);
        const g = acq.grid;
        const nx = posInt(g.nx, 64), ny = posInt(g.ny, nx);
        const fovX = posNum(g.fovX, 0.24), fovY = posNum(g.fovY, fovX);
        const os = posInt(g.oversample, 1);
        const cache = planFor(acq), all = cache.all, plan = cache.plan;
        let nTake = all.length;
        if (upTo !== undefined && upTo !== null) nTake = isNum(Number(upTo)) ? clamp(floor(Number(upTo)), 0, all.length) : all.length;
        // the readouts recorded so far are a prefix of the plan
        let nUse = 0;
        while (nUse < plan.length && cache.src[nUse] < nTake) nUse++;
        if (!plan.length) return emptyResult(acq, ['This acquisition has no readouts to reconstruct.']);
        if (!(cache.kmax > 0)) return emptyResult(acq, ['Every sample was recorded at k = 0: these readouts have no spatial encoding, so there is no image to make. (A pulse-acquire FID belongs in the Spectroscopy tab.)']);
        if (!nUse) return emptyResult(acq, ['No readouts recorded yet.']);
        let nCoils = posInt(acq.nCoils, 0) || plan[0].re.length;
        nCoils = min(nCoils, plan[0].re.length, plan[0].im.length);
        const notes = [];
        if (nUse < plan.length) notes.push('Showing ' + nUse + ' of ' + plan.length + ' readouts.');

        let axis = g.readoutAxis === 'x' || g.readoutAxis === 'y' ? g.readoutAxis : null;
        if (!axis) {
            if (cache.guess === undefined) cache.guess = guessAxis(plan);
            axis = cache.guess;
        }
        if (axis) {
            if (!cache.geo) cache.geo = placeCartesian(plan, axis, nx, ny, fovX, fovY, os);
            const geo = cache.geo;
            if (geo.cartesian) return reconCartesian(acq, o, plan, nUse, nCoils, geo, notes);
            notes.push('Only ' + fmt(100 * geo.onGrid / max(1, geo.total), 3) + ' % of the samples lie on the Cartesian grid, so they were gridded.');
        }
        return reconGridded(acq, o, plan.slice(0, nUse), nCoils, { nx, ny, fovX, fovY, os, readoutAxis: g.readoutAxis }, notes, cache);
    }

    MRI.recon = {
        run,
        defaults: DEFAULTS,
        // exposed for the tests and for curious readers
        _internal: { filterWeights, analyzeLines, radialDcf, kb, KB_BETA, KB_SUM }
    };

})(typeof window !== 'undefined' ? window : globalThis);
