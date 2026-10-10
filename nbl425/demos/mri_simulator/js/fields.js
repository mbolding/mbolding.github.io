/* ============================================================
   MRI Simulator, fields: B0 map, B1 map and receive coils

   Three spatial maps that sit between the object and the signal:

   - b0Map: how far each point is off resonance (Hz), from the
     phantom's own susceptibility pattern plus whatever the shim has
     failed to remove. Off-resonance shifts and distorts the image and
     dephases gradient echoes.
   - b1Map: how strongly the RF transmit field reaches each point,
     relative to nominal. At 3 T the RF wavelength in tissue (about
     12 cm) is comparable to the head, so the field is brighter in the
     centre and weaker at the edge (the "dielectric effect"), and the
     flip angle varies across the image.
   - coilMaps: the complex receive sensitivity of each coil element.
     A small loop coil sees tissue near it strongly and far tissue
     weakly; combining several loops gives SNR near the surface and
     the spatial information that parallel imaging (SENSE) exploits.

   All coordinates follow ARCHITECTURE.md section 3: pixel index i sits
   at (i - floor(n/2)) * spacing, x to the right, y down. Units are SI
   (metres, Hz). See section 7 for the contract.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;

    // Local names for Math functions used in the per-pixel loops.
    const { PI, cos, sin, floor, sqrt } = Math;

    /* ---------- B0 ---------- */

    /* Shim terms (ARCHITECTURE.md section 7.1). A shim coil makes a field
       shaped like one low-order spherical harmonic. The simulator's object
       is the axial plane z = 0, so each term is written in-plane and
       normalised to its value at the reference radius R = 100 mm: a
       coefficient of 10 Hz on X means "10 Hz at x = 100 mm". Z2 is
       2z^2 - x^2 - y^2, which at z = 0 is the bowl -(x^2 + y^2); the
       z-dependent terms (Z, ZX, ZY) do nothing in this plane and are left
       out. Z0 is the constant: on a scanner it is applied by retuning the
       centre frequency rather than with a coil. */
    const SHIM_R = 0.1;
    const SHIM_TERMS = [
        { id: 'z0', name: 'Z0', label: 'Z0 (centre frequency)', order: 0, formula: '1',
            fn: function (x, y) { return 1; } },
        { id: 'x', name: 'X', label: 'X', order: 1, formula: 'x / R',
            fn: function (x, y) { return x / SHIM_R; } },
        { id: 'y', name: 'Y', label: 'Y', order: 1, formula: 'y / R',
            fn: function (x, y) { return y / SHIM_R; } },
        { id: 'xy', name: 'XY', label: 'XY', order: 2, formula: '2xy / R²',
            fn: function (x, y) { return 2 * x * y / (SHIM_R * SHIM_R); } },
        { id: 'x2y2', name: 'X²−Y²', label: 'X²−Y²', order: 2, formula: '(x² − y²) / R²',
            fn: function (x, y) { return (x * x - y * y) / (SHIM_R * SHIM_R); } },
        { id: 'z2', name: 'Z2', label: 'Z2', order: 2, formula: '−(x² + y²) / R²  (z = 0)',
            fn: function (x, y) { return -(x * x + y * y) / (SHIM_R * SHIM_R); } }
    ];
    const SHIM_IDS = SHIM_TERMS.map(function (t) { return t.id; });

    /* The field left over after the patient is loaded and before anyone
       shims (for shim = 1), as coefficients of the terms above, in Hz at
       100 mm: the centre frequency is 25 Hz off, plus a tilt and a gentle
       saddle and bowl, a few tens of Hz across a head. Because it is built
       only from shim terms, a perfect set of shim currents (minus these
       numbers) cancels it exactly, while the local sinus field in
       phantom.dB0 stays: shims remove smooth fields, not local ones. */
    const RESIDUAL = Object.freeze({ z0: 25, x: 25, y: -15, xy: 10, x2y2: 12, z2: -30 });

    /* Range of each shim channel in the UI (Hz at 100 mm), like the
       current limit of a shim supply. */
    const SHIM_LIMITS = Object.freeze({ z0: 100, x: 150, y: 150, xy: 150, x2y2: 150, z2: 150 });

    function coeffOf(c, id) { const v = c ? Number(c[id]) : 0; return isFinite(v) ? v : 0; }

    /* Collapse a set of shim coefficients into the plain polynomial
       c0 + cx x + cy y + cxx x^2 + cyy y^2 + cxy x y (x, y in metres). */
    function polyOf(c) {
        const R2 = SHIM_R * SHIM_R;
        const z2 = coeffOf(c, 'z2'), x2y2 = coeffOf(c, 'x2y2');
        return {
            c0: coeffOf(c, 'z0'),
            cx: coeffOf(c, 'x') / SHIM_R,
            cy: coeffOf(c, 'y') / SHIM_R,
            cxy: 2 * coeffOf(c, 'xy') / R2,
            cxx: (x2y2 - z2) / R2,
            cyy: (-x2y2 - z2) / R2
        };
    }

    /* Field in Hz at (x, y) metres from a set of shim coefficients. */
    function shimField(c, x, y) {
        const p = polyOf(c);
        return p.c0 + p.cx * x + p.cy * y + p.cxy * x * y + p.cxx * x * x + p.cyy * y * y;
    }

    /* The un-shimmed residual field in Hz at (x, y), for shim = 1. */
    function shimResidual(x, y) { return shimField(RESIDUAL, x, y); }

    /* Net shim coefficients that b0Map applies: shim x residual plus the
       shim currents. Adding coefficients before evaluating means that
       currents equal to minus the residual cancel it exactly (to the bit). */
    function netCoeffs(b0) {
        const shim = Number(b0.shim) || 0, sc = b0.shimCoeffs || {};
        const out = {};
        for (const id of SHIM_IDS) out[id] = shim * RESIDUAL[id] + coeffOf(sc, id);
        return out;
    }

    /* Off-resonance map in Hz on the phantom raster, excluding chemical
       shift (the engine adds that per tissue).
         b0 = { susceptibility, shim, shimCoeffs: {z0, x, y, xy, x2y2, z2} }
       susceptibility scales the phantom's intrinsic pattern (0 removes it,
       3 exaggerates it), shim scales the un-shimmed residual above, and
       shimCoeffs are the shim currents, in Hz at 100 mm (section 7.1):
         b0(r) = susceptibility dB0(r) + shim residual(r) + sum_i c_i basis_i(r)
       Air pixels are exactly 0: with no spins there, the off-resonance has
       no meaning (and a measured field map would be masked there too). */
    function b0Map(phantom, b0) {
        b0 = b0 || {};
        const susc = b0.susceptibility === undefined ? 1 : (Number(b0.susceptibility) || 0);
        const p = polyOf(netCoeffs(b0));
        const smooth = p.c0 || p.cx || p.cy || p.cxy || p.cxx || p.cyy;
        const n = phantom.n, d = phantom.dx, h = floor(n / 2);
        const label = phantom.label, dB0 = phantom.dB0;
        const out = new Float32Array(n * n);
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * d;
            // the polynomial in x for this row: a0 + a1 x + a2 x^2
            const a0 = p.c0 + p.cy * y + p.cyy * y * y, a1 = p.cx + p.cxy * y, a2 = p.cxx;
            for (let ix = 0; ix < n; ix++) {
                const i = iy * n + ix;
                if (!label[i]) continue;
                let f = susc * dB0[i];
                if (smooth) { const x = (ix - h) * d; f += a0 + (a1 + a2 * x) * x; }
                out[i] = f;
            }
        }
        return out;
    }

    /* ---------- Shimming: field statistics and the auto-shim ---------- */

    /* Points that take part: non-air pixels with a positive proton
       density, inside the region. region 'object' is the whole object,
       'center' a disk of `radius` metres (default 60 mm) around the
       isocentre. Weights are proton density, because the spectrum (and
       the scanner's own shim routine) sees the field where the signal is. */
    function regionOf(opts) {
        opts = opts || {};
        return { center: opts.region === 'center', radius: opts.radius > 0 ? Number(opts.radius) : 0.06 };
    }
    function forEachPoint(phantom, opts, fn) {
        const reg = regionOf(opts);
        const n = phantom.n, d = phantom.dx, h = floor(n / 2), label = phantom.label, tissues = phantom.tissues;
        const pd = tissues.map(function (t, k) { return k === 0 || !t ? 0 : Math.max(0, Number(t.pd) || 0); });
        const r2max = reg.radius * reg.radius;
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * d;
            for (let ix = 0; ix < n; ix++) {
                const i = iy * n + ix, L = label[i];
                if (!L) continue;
                const w = pd[L];
                if (!(w > 0)) continue;
                const x = (ix - h) * d;
                if (reg.center && x * x + y * y > r2max) continue;
                fn(i, x, y, w);
            }
        }
        return reg;
    }

    /* Solve the small dense system A a = b (row-major K x K) by Gaussian
       elimination with partial pivoting. A is symmetric positive
       semi-definite (normal equations); a tiny ridge keeps it solvable if
       the region is too small to determine every term. */
    function solveDense(A, b, K) {
        const M = new Float64Array(K * (K + 1));
        let tr = 0;
        for (let i = 0; i < K; i++) tr += A[i * K + i];
        const ridge = 1e-12 * (tr / K || 1);
        for (let i = 0; i < K; i++) {
            for (let j = 0; j < K; j++) M[i * (K + 1) + j] = A[i * K + j] + (i === j ? ridge : 0);
            M[i * (K + 1) + K] = b[i];
        }
        for (let c = 0; c < K; c++) {
            let p = c;
            for (let r = c + 1; r < K; r++) if (Math.abs(M[r * (K + 1) + c]) > Math.abs(M[p * (K + 1) + c])) p = r;
            if (p !== c) for (let j = 0; j <= K; j++) { const t = M[c * (K + 1) + j]; M[c * (K + 1) + j] = M[p * (K + 1) + j]; M[p * (K + 1) + j] = t; }
            const piv = M[c * (K + 1) + c];
            if (!piv) continue;
            for (let r = c + 1; r < K; r++) {
                const f = M[r * (K + 1) + c] / piv;
                if (!f) continue;
                for (let j = c; j <= K; j++) M[r * (K + 1) + j] -= f * M[c * (K + 1) + j];
            }
        }
        const x = new Float64Array(K);
        for (let r = K - 1; r >= 0; r--) {
            let s = M[r * (K + 1) + K];
            for (let j = r + 1; j < K; j++) s -= M[r * (K + 1) + j] * x[j];
            const piv = M[r * (K + 1) + r];
            x[r] = piv ? s / piv : 0;
        }
        return x;
    }

    /* Auto-shim: the shim currents that make the field as uniform as
       possible, by proton-density weighted least squares over the region.
       The field is fitted with the six terms (Z0 included, so the centre
       frequency is set too); minus the fit is what the shims must add.
         autoShim(phantom, b0, {region: 'object'|'center', radius, b0Map})
           -> { shimCoeffs,   the coefficients to ADD to b0.shimCoeffs (Hz at 100 mm)
                total,        b0.shimCoeffs plus those: the new settings
                rmsBefore, rmsAfter,   pd-weighted RMS field (about 0 Hz) in the region
                sdBefore, sdAfter, meanBefore, meanAfter, nPoints, region, radius }
       A precomputed map for these b0 settings may be passed as opts.b0Map.
       What remains afterwards is whatever the six terms cannot describe:
       the local field next to the sinus, and, for the central region, the
       field outside it. */
    function autoShim(phantom, b0, opts) {
        opts = opts || {};
        b0 = b0 || {};
        const N = phantom.n * phantom.n;
        const map = opts.b0Map && opts.b0Map.length === N ? opts.b0Map : b0Map(phantom, b0);
        const K = SHIM_TERMS.length, fns = SHIM_TERMS.map(function (t) { return t.fn; });
        const A = new Float64Array(K * K), rhs = new Float64Array(K), phi = new Float64Array(K);
        let W = 0, S1 = 0, S2 = 0, count = 0;
        const reg = forEachPoint(phantom, opts, function (i, x, y, w) {
            const f = map[i];
            for (let k = 0; k < K; k++) phi[k] = fns[k](x, y);
            for (let j = 0; j < K; j++) {
                const wj = w * phi[j];
                rhs[j] += wj * f;
                for (let k = j; k < K; k++) A[j * K + k] += wj * phi[k];
            }
            W += w; S1 += w * f; S2 += w * f * f; count++;
        });
        const existing = b0.shimCoeffs || {};
        const zero = {}, totalZero = {};
        SHIM_IDS.forEach(function (id) { zero[id] = 0; totalZero[id] = coeffOf(existing, id); });
        if (!(W > 0)) {
            return { shimCoeffs: zero, total: totalZero, rmsBefore: 0, rmsAfter: 0, sdBefore: 0, sdAfter: 0,
                meanBefore: 0, meanAfter: 0, nPoints: 0, region: reg.center ? 'center' : 'object', radius: reg.radius };
        }
        for (let j = 0; j < K; j++) for (let k = 0; k < j; k++) A[j * K + k] = A[k * K + j];
        const a = solveDense(A, rhs, K);
        // Field after shimming, f - fit, accumulated in a second pass.
        let T1 = 0, T2 = 0;
        forEachPoint(phantom, opts, function (i, x, y, w) {
            let fit = 0;
            for (let k = 0; k < K; k++) fit += a[k] * fns[k](x, y);
            const g = map[i] - fit;
            T1 += w * g; T2 += w * g * g;
        });
        const delta = {}, total = {};
        SHIM_IDS.forEach(function (id, k) { delta[id] = -a[k]; total[id] = coeffOf(existing, id) - a[k]; });
        const m0 = S1 / W, m1 = T1 / W;
        return {
            shimCoeffs: delta, total: total,
            rmsBefore: sqrt(S2 / W), rmsAfter: sqrt(Math.max(0, T2 / W)),
            sdBefore: sqrt(Math.max(0, S2 / W - m0 * m0)), sdAfter: sqrt(Math.max(0, T2 / W - m1 * m1)),
            meanBefore: m0, meanAfter: m1,
            nPoints: count, region: reg.center ? 'center' : 'object', radius: reg.radius
        };
    }

    /* Statistics of a field map over the object (or a central disk),
       weighted by proton density:
         fieldStats(phantom, b0Map, {region, radius, bins})
           -> { mean, sd, rms, min, max, fwhmHz, nPoints,
                hist: { centers: Float32Array, counts: Float32Array, binHz } }
       counts are the fraction of the (pd-weighted) object in each bin,
       summing to 1, over the whole range min..max (about `bins` bins,
       default 120). fwhmHz is the full width at half maximum of the field
       distribution, from a histogram whose bins are matched to its spread
       and lightly smoothed: the spread of frequencies the field alone puts
       into a spectral line (one bin, at most 0.05 Hz, when uniform). */
    /* Region points of a phantom as flat arrays (pixel index, weight),
       cached per phantom and region: the shim panel asks for statistics
       every animation frame while a slider moves. */
    const pointCache = new WeakMap();
    function regionPoints(phantom, opts) {
        const reg = regionOf(opts), key = (reg.center ? 'c' : 'o') + reg.radius;
        let per = pointCache.get(phantom);
        if (!per) { per = new Map(); pointCache.set(phantom, per); }
        let P = per.get(key);
        if (!P) {
            const idx = [], wts = [];
            forEachPoint(phantom, opts, function (i, x, y, w) { idx.push(i); wts.push(w); });
            P = { idx: Int32Array.from(idx), w: Float64Array.from(wts) };
            per.set(key, P);
        }
        return P;
    }

    function fieldStats(phantom, map, opts) {
        opts = opts || {};
        const P = regionPoints(phantom, opts), idx = P.idx, wt = P.w, np = idx.length;
        let W = 0, S1 = 0, S2 = 0, lo = Infinity, hi = -Infinity, count = 0;
        for (let p = 0; p < np; p++) {
            const f = map[idx[p]];
            if (f - f !== 0) continue;          // NaN or infinite (cheaper than isFinite in a hot loop)
            const w = wt[p];
            W += w; S1 += w * f; S2 += w * f * f; count++;
            if (f < lo) lo = f;
            if (f > hi) hi = f;
        }
        const empty = { centers: new Float32Array(0), counts: new Float32Array(0), binHz: 0 };
        if (!(W > 0)) return { mean: 0, sd: 0, rms: 0, min: 0, max: 0, fwhmHz: 0, nPoints: 0, hist: empty };
        const mean = S1 / W, sd = sqrt(Math.max(0, S2 / W - mean * mean)), rms = sqrt(S2 / W);

        /* A fine histogram (up to 4096 bins) gives percentiles; it is then
           re-binned for the FWHM and for display. */
        const span = hi - lo;
        const NF = span > 0 ? 4096 : 1, fb = span > 0 ? span / NF : 1;
        const fine = new Float64Array(NF);
        for (let p = 0; p < np; p++) {
            const f = map[idx[p]];
            if (f - f !== 0) continue;
            fine[Math.min(NF - 1, floor((f - lo) / fb))] += wt[p] / W;
        }
        function pct(q) {
            let c = 0;
            for (let k = 0; k < NF; k++) { c += fine[k]; if (c >= q) return lo + (k + 0.5) * fb; }
            return hi;
        }
        function rebin(width, start, stop) {
            const nb = Math.max(1, Math.min(4096, Math.ceil((stop - start) / width - 1e-9) + 1));
            const cen = new Float32Array(nb), cnt = new Float32Array(nb);
            for (let k = 0; k < nb; k++) cen[k] = start + k * width;
            for (let k = 0; k < NF; k++) {
                if (!fine[k]) continue;
                const f = lo + (k + 0.5) * fb, j = Math.round((f - start) / width);
                cnt[Math.max(0, Math.min(nb - 1, j))] += fine[k];
            }
            return { centers: cen, counts: cnt, binHz: width };
        }

        let fwhm = 0;
        if (span > 0) {
            // Bin width from the robust spread (16th to 84th percentile), so a
            // narrow core is resolved even when a long tail stretches the range.
            const sdR = 0.5 * (pct(0.84) - pct(0.16));
            const bw = Math.max(fb, Math.min(2, Math.max(0.05, sdR / 6)));
            const H = rebin(bw, lo, hi), c = H.counts, m = c.length;
            const s = new Float64Array(m);
            for (let k = 0; k < m; k++) s[k] = 0.25 * (k > 0 ? c[k - 1] : 0) + 0.5 * c[k] + 0.25 * (k < m - 1 ? c[k + 1] : 0);
            let km = 0;
            for (let k = 1; k < m; k++) if (s[k] > s[km]) km = k;
            const half = s[km] / 2;
            let l = km, r = km;
            while (l > 0 && s[l] > half) l--;
            while (r < m - 1 && s[r] > half) r++;
            const xl = s[l] > half ? l - 0.5 : l + (half - s[l]) / (s[l + 1] - s[l]);
            const xr = s[r] > half ? r + 0.5 : r - (half - s[r]) / (s[r - 1] - s[r]);
            // The [1 2 1] smoothing widens a single-bin spike to about one bin;
            // never report less than the true spread can be.
            fwhm = Math.max(0, (xr - xl) * bw);
        }

        const nbDisp = Math.max(8, Math.min(1024, Math.round(opts.bins || 120)));
        const dispW = span > 0 ? Math.max(0.05, span / nbDisp) : 0.5;
        const hist = span > 0 ? rebin(dispW, lo, hi)
            : { centers: Float32Array.of(lo), counts: Float32Array.of(1), binHz: dispW };
        return { mean: mean, sd: sd, rms: rms, min: lo, max: hi, fwhmHz: fwhm, nPoints: count, hist: hist };
    }

    /* ---------- B1 (transmit) ---------- */

    /* Relative transmit field at radius r (metres) for a given amount
       of dielectric effect: 1 + amount (0.6 - (r / 90 mm)^2), clipped to
       [0.4, 1.6]. With amount 0.3 the centre gets 18 percent more flip
       angle than nominal, the map crosses 1 at r = 70 mm, and at 90 mm
       (the edge of the brain) the flip angle is 12 percent low. */
    function b1At(x, y, amount) {
        if (!amount) return 1;
        const q = (x * x + y * y) / (0.09 * 0.09);
        const v = 1 + amount * (0.6 - q);
        return v < 0.4 ? 0.4 : (v > 1.6 ? 1.6 : v);
    }

    /* Transmit scale on the phantom raster (1 = nominal flip angle).
       Evaluated everywhere, air included, because B1 is a property of
       the RF field rather than of the spins; display code may mask it
       with the label map. b1 = {amount}, 0 to 0.5. */
    function b1Map(phantom, b1) {
        const amount = (b1 && Number(b1.amount)) || 0;
        const n = phantom.n, d = phantom.dx, h = floor(n / 2);
        const out = new Float32Array(n * n);
        if (!amount) { out.fill(1); return out; }
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * d;
            for (let ix = 0; ix < n; ix++) out[iy * n + ix] = b1At((ix - h) * d, y, amount);
        }
        return out;
    }

    /* ---------- Receive coils ---------- */

    /* Eight-channel head coil. Loops sit evenly round an ellipse of
       105 mm by 125 mm semi-axes (wider front to back, like the head),
       offset by half a step so that no element sits exactly on the
       midline. Element k is at angle -90 + 22.5 + 45 k degrees, going
       clockwise on screen from the front; positive x is the patient's
       left (radiological convention). */
    const HEAD8 = {
        semiX: 0.105, semiY: 0.125,
        loopRadius: 0.06,              // a, the distance over which a loop's sensitivity falls off
        phaseSlope: 5,                 // rad/m: about 1 rad across a 0.2 m head
        // fixed per-element phase offsets (cable lengths, preamplifiers): arbitrary but reproducible
        phase0: [0.0, 1.9, -2.4, 0.7, 2.8, -1.1, 1.3, -2.9],
        names: ['Left anterior', 'Left anterolateral', 'Left posterolateral', 'Left posterior',
            'Right posterior', 'Right posterolateral', 'Right anterolateral', 'Right anterior']
    };

    /* Sensitivity magnitude of a loop at distance d from it, before
       normalisation: the on-axis field of a circular loop of radius a,
       proportional to 1 / (1 + (d/a)^2)^(3/2). By reciprocity the
       field a coil would make per unit current is its receive
       sensitivity. */
    function loopMag(d2, a2) {
        const q = 1 + d2 / a2;
        return 1 / (q * sqrt(q));
    }

    function coilSet(type) {
        type = type || 'body';
        if (type === 'body') {
            /* The body coil is the large birdcage built into the bore.
               Over a head it is close to uniform, and here exactly so:
               sensitivity 1, phase 0. */
            return { type: 'body', n: 1, names: ['Body coil'], positions: [{ x: 0, y: 0 }], radius: 0.30, scale: 1 };
        }
        if (type !== 'head8') throw new Error('Unknown coil set "' + type + '" (use "body" or "head8")');
        const positions = [], phase0 = [], phaseDir = [];
        for (let k = 0; k < 8; k++) {
            const phi = -PI / 2 + PI / 8 + k * PI / 4;
            positions.push({ x: HEAD8.semiX * cos(phi), y: HEAD8.semiY * sin(phi) });
            phase0.push(HEAD8.phase0[k]);
            // each element's phase ramps along its own direction (its local
            // tangent, turned a little), so no two elements share a pattern
            const psi = phi + PI / 2 + 0.4;
            phaseDir.push({ x: cos(psi), y: sin(psi) });
        }
        const cs = {
            type: 'head8', n: 8, names: HEAD8.names.slice(), positions: positions,
            radius: HEAD8.loopRadius,
            ellipse: { a: HEAD8.semiX, b: HEAD8.semiY },
            phase0: phase0, phaseDir: phaseDir, phaseSlope: HEAD8.phaseSlope,
            scale: 1
        };
        /* Normalise: the root-sum-of-squares of the eight magnitudes,
           averaged over a disk of 70 mm radius, is 1. The average is
           taken on a fixed 1 mm grid, independent of any image grid, so
           every caller sees the same maps. */
        const a2 = cs.radius * cs.radius;
        let sum = 0, count = 0;
        for (let iy = -70; iy <= 70; iy++) for (let ix = -70; ix <= 70; ix++) {
            if (ix * ix + iy * iy > 70 * 70) continue;
            const x = ix * 1e-3, y = iy * 1e-3;
            let ss = 0;
            for (let k = 0; k < 8; k++) {
                const dx = x - positions[k].x, dy = y - positions[k].y, m = loopMag(dx * dx + dy * dy, a2);
                ss += m * m;
            }
            sum += sqrt(ss); count++;
        }
        cs.scale = count / sum;
        return cs;
    }

    /* Complex sensitivity maps on an nx by ny grid covering fovX by fovY
       metres, evaluated at pixel centres (section 3 convention).
       Returns {re: [Float32Array per coil], im: [...]}. The maps are
       computed once per (coil set, grid) and cached; each call returns
       fresh copies, so callers may modify them. */
    const mapCache = new Map();
    const MAP_CACHE_MAX = 6;
    function coilKey(cs, nx, ny, fovX, fovY) {
        return [cs.type, cs.n, cs.scale, cs.radius, nx, ny, fovX, fovY,
            JSON.stringify(cs.positions), JSON.stringify(cs.phase0 || null), JSON.stringify(cs.phaseDir || null), cs.phaseSlope || 0].join('|');
    }
    function computeMaps(cs, nx, ny, fovX, fovY) {
        const re = [], im = [];
        const N = nx * ny;
        if (cs.type === 'body') {
            const r = new Float32Array(N); r.fill(1);
            re.push(r); im.push(new Float32Array(N));
            return { re: re, im: im };
        }
        const dxp = fovX / nx, dyp = fovY / ny, hx = floor(nx / 2), hy = floor(ny / 2);
        const a2 = cs.radius * cs.radius;
        for (let k = 0; k < cs.n; k++) {
            const r = new Float32Array(N), q = new Float32Array(N);
            const px = cs.positions[k].x, py = cs.positions[k].y;
            const p0 = cs.phase0 ? cs.phase0[k] : 0;
            const ux = cs.phaseDir ? cs.phaseDir[k].x * cs.phaseSlope : 0;
            const uy = cs.phaseDir ? cs.phaseDir[k].y * cs.phaseSlope : 0;
            // The phase p0 + ux x + uy y is linear, so exp(i phase) factors
            // into a row term times a column term: no trigonometry per pixel.
            const cx = new Float64Array(nx), sx = new Float64Array(nx);
            for (let ix = 0; ix < nx; ix++) { const a = p0 + ux * (ix - hx) * dxp; cx[ix] = cos(a); sx[ix] = sin(a); }
            for (let iy = 0; iy < ny; iy++) {
                const y = (iy - hy) * dyp, dy = y - py, cy = cos(uy * y), sy = sin(uy * y);
                for (let ix = 0; ix < nx; ix++) {
                    const dx = (ix - hx) * dxp - px;
                    const m = cs.scale * loopMag(dx * dx + dy * dy, a2);
                    const i = iy * nx + ix;
                    r[i] = m * (cx[ix] * cy - sx[ix] * sy);      // m cos(phase)
                    q[i] = m * (sx[ix] * cy + cx[ix] * sy);      // m sin(phase)
                }
            }
            re.push(r); im.push(q);
        }
        return { re: re, im: im };
    }
    function coilMaps(cs, nx, ny, fovX, fovY) {
        if (typeof cs === 'string') cs = coilSet(cs);
        ny = ny || nx;
        fovY = fovY || fovX;
        const key = coilKey(cs, nx, ny, fovX, fovY);
        let maps = mapCache.get(key);
        if (!maps) {
            maps = computeMaps(cs, nx, ny, fovX, fovY);
            mapCache.set(key, maps);
            while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value);
        }
        return { re: maps.re.map(function (a) { return a.slice(); }), im: maps.im.map(function (a) { return a.slice(); }) };
    }

    /* Root-sum-of-squares of the coil magnitudes (a convenience for the
       phantom tab's "coil RSS" view and for tests). */
    function rss(maps) {
        const nC = maps.re.length, N = maps.re[0].length, out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let s = 0;
            for (let k = 0; k < nC; k++) s += maps.re[k][i] * maps.re[k][i] + maps.im[k][i] * maps.im[k][i];
            out[i] = sqrt(s);
        }
        return out;
    }

    MRI.fields = {
        b0Map: b0Map,
        b1Map: b1Map,
        coilSet: coilSet,
        coilMaps: coilMaps,
        rss: rss,
        shimResidual: shimResidual,
        b1At: b1At,
        // interactive shimming (section 7.1)
        shimTerms: SHIM_TERMS,
        shimRadius: SHIM_R,
        shimLimits: SHIM_LIMITS,
        residualCoeffs: RESIDUAL,
        shimField: shimField,
        autoShim: autoShim,
        fieldStats: fieldStats,
        defaults: { b0: { susceptibility: 1, shim: 0, shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } }, b1: { amount: 0 } }
    };

})(typeof window !== 'undefined' ? window : globalThis);
