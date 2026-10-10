/* ============================================================
   PET Simulator, reconstruction
   Turns an acquisition (AcqData, ARCHITECTURE.md 8.3) into an image
   in Bq/mL, four ways:
     bp    plain backprojection (TOF-weighted if TOF is used)
     fbp   filtered backprojection with a choice of apodising window
     mlem  maximum-likelihood expectation maximisation
     osem  the same with ordered subsets of angles
   Every correction (normalisation, attenuation, scatter, randoms,
   decay, motion) has its own switch, so students can see what each
   one does by leaving it out. FBP applies the corrections to the
   data before inverting; MLEM and OSEM put them inside the model of
   the data instead (the way clinical scanners do), so the noisy
   counts are never subtracted or divided.

   Data model for LOR bin i (and TOF bin t):
       y_it ~ Poisson( n_i a_i kappa (H x)_it + s_it + r_it )
   n = LOR efficiency (normalisation), a = 1/acf (attenuation),
   kappa = counts per (decay-corrected Bq/mL x mm of line integral),
   s = scatter estimate, r = randoms estimate, and H = the projector,
   followed by the radial detector blur (psf) and preceded by the
   positron range kernel (rangeCorrection) when those are modelled.

   Builds on PET.scanner: projector() (with TOF and angle subsets),
   blurMatrix() (the same matrix blurRadial() uses), subsets(),
   sumTOF(). Projectors and sensitivity images are cached so that
   re-running with other settings (iterations, filter, post-filter)
   is fast. No DOM; long work yields with PET.util.yieldFrame().
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;
    const S = PET.scanner;
    const G = S.geom;
    const nA = G.nA, nR = G.nR, NLOR = G.nA * G.nR;

    /* ---------- defaults ----------
       A getter hands out a fresh deep copy, so code that spreads the
       defaults into its own state and then edits corrections in place
       cannot change them for everyone else. */
    function defaults() {
        return {
            method: 'osem',
            filter: 'hann', cutoff: 1.0, order: 4,
            iterations: 4, subsets: 12,
            tof: true, psf: false, rangeCorrection: false,
            matrix: 128, postFilter: 3, frame: 0,
            corrections: {
                normalization: true, attenuation: true, scatter: true, randoms: true,
                randomsMethod: 'delayed', decay: true, motion: false
            },
            keepIterations: true
        };
    }
    function mergeOpts(opts) {
        const o = defaults();
        opts = opts || {};
        Object.keys(opts).forEach(function (k) {
            if (k === 'corrections') return;
            if (opts[k] !== undefined) o[k] = opts[k];
        });
        const c = opts.corrections || {};
        Object.keys(c).forEach(function (k) { if (c[k] !== undefined) o.corrections[k] = c[k]; });
        if (['bp', 'fbp', 'mlem', 'osem'].indexOf(o.method) < 0) throw new Error('Unknown reconstruction method "' + o.method + '". Use bp, fbp, mlem or osem.');
        o.matrix = Math.max(16, Math.round(+o.matrix || 128));
        o.iterations = Math.max(1, Math.round(+o.iterations || 1));
        o.subsets = U.clamp(Math.round(+o.subsets || 1), 1, nA);
        o.cutoff = U.clamp(+o.cutoff || 1, 0.05, 1);
        o.order = Math.max(1, +o.order || 4);
        o.postFilter = Math.max(0, +o.postFilter || 0);
        return o;
    }

    /* ---------- FBP filters ----------
       The ramp |f| undoes the 1/r blur of backprojection, but it boosts
       high spatial frequencies, which in PET are mostly noise. So it is
       multiplied by a window that rolls off towards the cutoff frequency
       (a fraction of the Nyquist frequency of the 2 mm radial bins,
       0.25 cycles/mm). Lower cutoff = smoother image, worse resolution. */
    const FILTERS = [
        { id: 'ramp', name: 'Ramp (Ram-Lak)', description: 'The pure ramp, cut off sharply: the best resolution and the most noise.' },
        { id: 'shepp', name: 'Shepp-Logan', description: 'The ramp times a sinc: it rolls off gently near the cutoff, slightly less noise than the ramp.' },
        { id: 'cosine', name: 'Cosine', description: 'The ramp times a quarter cosine: smoother than Shepp-Logan.' },
        { id: 'hamming', name: 'Hamming', description: 'A raised cosine that keeps 8 % at the cutoff: smooth, a common clinical choice.' },
        { id: 'hann', name: 'Hann', description: 'A raised cosine that reaches zero at the cutoff: the smoothest of the cosine family.' },
        { id: 'butterworth', name: 'Butterworth', description: 'A smooth low-pass with no hard edge; the order sets how steeply it falls at the cutoff.' }
    ];
    const FILTER_IDS = FILTERS.map(function (f) { return f.id; });

    /* Window value at frequency u (a fraction of Nyquist, 0..1). Every
       window except Butterworth is zero above the cutoff. Butterworth uses
       the amplitude form 1/sqrt(1 + (u/c)^(2 order)), so it is 0.707 at
       the cutoff, as nuclear-medicine software defines it. */
    function windowValue(name, u, cutoff, order) {
        const c = U.clamp(cutoff === undefined ? 1 : cutoff, 0.01, 1);
        u = Math.abs(u);
        if (name === 'butterworth') return 1 / Math.sqrt(1 + Math.pow(u / c, 2 * Math.max(1, order || 4)));
        if (u > c) return 0;
        const x = u / c;
        switch (name) {
            case 'ramp': return 1;
            case 'shepp': return U.sinc(x / 2);                       // sin(pi x/2) / (pi x/2)
            case 'cosine': return Math.cos(Math.PI * x / 2);
            case 'hamming': return 0.54 + 0.46 * Math.cos(Math.PI * x);
            case 'hann': return 0.5 + 0.5 * Math.cos(Math.PI * x);
            default: throw new Error('Unknown filter "' + name + '". Use ' + FILTER_IDS.join(', ') + '.');
        }
    }

    /* Response for plotting: frequency axis u (fraction of Nyquist) and
       f (cycles/mm), the window, the ramp (normalised to 1 at Nyquist)
       and their product, which is what multiplies each projection's
       spectrum. */
    function filterResponse(name, cutoff, order, nFreq) {
        nFreq = Math.max(2, nFreq || 101);
        const nyq = 1 / (2 * G.dr);
        const u = new Float64Array(nFreq), f = new Float64Array(nFreq), w = new Float64Array(nFreq),
            ramp = new Float64Array(nFreq), resp = new Float64Array(nFreq);
        for (let k = 0; k < nFreq; k++) {
            u[k] = k / (nFreq - 1); f[k] = u[k] * nyq;
            w[k] = windowValue(name, u[k], cutoff, order);
            ramp[k] = u[k]; resp[k] = u[k] * w[k];
        }
        return { u: u, freq: f, window: w, ramp: ramp, response: resp, nyquist: nyq };
    }

    /* The ramp on the sampled grid. Sampling |f| directly in frequency
       sets its value at f = 0 to zero, which shifts the whole image by a
       constant (the classic DC error). Instead take the DFT of the
       band-limited ramp's exact spatial samples (Kak and Slaney, ch. 3):
         h(0) = 1/(4 dr^2), h(k odd) = -1/(k pi dr)^2, h(k even) = 0,
       times dr so that it acts as a convolution integral. Real and even. */
    const rampCache = {};
    function rampSpectrum(np) {
        if (rampCache[np]) return rampCache[np];
        const dr = G.dr, re = new Float64Array(np), im = new Float64Array(np);
        re[0] = 1 / (4 * dr * dr);
        for (let k = 1; k < np / 2; k += 2) {
            const v = -1 / (k * k * Math.PI * Math.PI * dr * dr);
            re[k] = v; re[np - k] = v;
        }
        U.fft(re, im, false);
        const H = new Float64Array(np);
        for (let k = 0; k < np; k++) H[k] = re[k] * dr;
        return (rampCache[np] = H);
    }
    function filterSpectrum(name, cutoff, order, np) {
        const H = Float64Array.from(rampSpectrum(np)), half = np / 2;
        for (let k = 0; k < np; k++) H[k] *= windowValue(name, Math.min(k, np - k) / half, cutoff, order);
        return H;
    }

    /* Filter every projection (row) of a non-TOF sinogram along r. Rows
       are zero-padded to at least twice their length so the circular
       FFT convolution does not wrap one edge onto the other. Because the
       filter is real and even, two real rows go through one complex FFT
       (one as the real part, one as the imaginary part). */
    function filterSinogram(p, name, cutoff, order) {
        const np = U.nextPow2(2 * nR), H = filterSpectrum(name, cutoff, order, np);
        const out = new Float32Array(NLOR), re = new Float64Array(np), im = new Float64Array(np);
        for (let a = 0; a < nA; a += 2) {
            re.fill(0); im.fill(0);
            const o1 = a * nR, two = a + 1 < nA, o2 = o1 + nR;
            for (let i = 0; i < nR; i++) { re[i] = p[o1 + i]; if (two) im[i] = p[o2 + i]; }
            U.fft(re, im, false);
            for (let k = 0; k < np; k++) { re[k] *= H[k]; im[k] *= H[k]; }
            U.fft(re, im, true);
            for (let i = 0; i < nR; i++) { out[o1 + i] = re[i]; if (two) out[o2 + i] = im[i]; }
        }
        return out;
    }

    /* ---------- projectors, masks and caches ----------
       One projector per (matrix, TOF sigma), kept for the session: a TOF
       projector precomputes its TOF weights, which takes longer than a
       projection. Each entry also carries the FOV mask, the per-row pixel
       spans inside it (for the pixel-driven FBP backprojector), and the
       backprojection scale (computed when first needed). */
    const projCache = {};
    function getProjector(n, sigma) {
        const key = n + ':' + (sigma > 0 ? sigma.toFixed(3) : '0');
        let e = projCache[key];
        if (e) return e;
        const P = sigma > 0 ? S.projector({ n: n, tof: { sigma: sigma } }) : S.projector({ n: n });
        const mask = P.fovMask();
        const x0 = new Int32Array(n), x1 = new Int32Array(n);
        for (let iy = 0; iy < n; iy++) {
            let lo = n, hi = -1;
            for (let ix = 0; ix < n; ix++) if (mask[iy * n + ix]) { if (ix < lo) lo = ix; hi = ix; }
            x0[iy] = lo; x1[iy] = hi;
        }
        e = projCache[key] = { key: key, P: P, n: n, dx: P.dx, sigma: sigma > 0 ? sigma : 0, mask: mask, rowLo: x0, rowHi: x1, bpScale: 0 };
        return e;
    }
    function allAngles() { const a = new Int32Array(nA); for (let k = 0; k < nA; k++) a[k] = k; return a; }
    const ALL = allAngles();
    /* A full projection at 256 x 256 with TOF takes a few hundred ms. To
       keep the page responsive, long angle lists (MLEM uses all 192 in
       one update) are processed in chunks with a chance to yield between
       them; the arithmetic is the same as one call. */
    const CHUNK = 24;
    function chunksOf(angles) {
        if (angles.length <= CHUNK) return [angles];
        const k = Math.ceil(angles.length / CHUNK), out = [];
        for (let c = 0; c < k; c++) out.push(angles.subarray(Math.floor(c * angles.length / k), Math.floor((c + 1) * angles.length / k)));
        return out;
    }
    async function backChunked(P, sino, angles, out, tick) {
        out = out || new Float32Array(P.n * P.n);
        const ch = chunksOf(angles);
        for (let c = 0; c < ch.length; c++) { P.back(sino, ch[c], out); await tick(); }
        return out;
    }
    async function forwardChunked(P, img, angles, out, tick) {
        out = out || new Float32Array(P.size);
        const ch = chunksOf(angles);
        for (let c = 0; c < ch.length; c++) { P.forward(img, ch[c], out); await tick(); }
        return out;
    }

    /* Sensitivity images depend on the LOR weights (normalisation and
       attenuation, which every frame of an acquisition shares), the
       projector, the system-model options and the subsets, but not on
       the counts or on kappa (which cancels from the update). Cache them
       per acq.corrections object: the playback shell builds a new acq for
       every partial reconstruction but keeps the same corrections. Only
       the few most recently used settings are kept (a TOF set at 256 x 256
       is several MB). */
    const sensCache = new WeakMap(), SENS_KEEP = 6;

    /* ---------- detector blur and positron range in the model ----------
       The radial blur is S.blurRadial restricted to some angle rows. The
       blur never mixes angles, so for an OSEM subset only that subset's
       rows need blurring; this does exactly what blurRadial does on them,
       with the same matrix (S.blurMatrix with the scanner's defaults). */
    let blurM = null;
    function blurRows(src, dst, angles, nT, transpose) {
        const M = blurM || (blurM = S.blurMatrix(G.detRadialFwhm0, G.parallaxFwhm));
        for (let q = 0; q < angles.length; q++) {
            const rb = angles[q] * nR;
            if (!transpose) for (let k = rb * nT, e = (rb + nR) * nT; k < e; k++) dst[k] = 0;
            for (let j = 0; j < nR; j++) {
                const ww = M.w[j], i0 = rb + M.lo[j], L = ww.length;
                if (!transpose) {
                    for (let t = 0; t < nT; t++) {
                        const v = src[(rb + j) * nT + t];
                        if (v === 0) continue;
                        for (let k = 0; k < L; k++) dst[(i0 + k) * nT + t] += v * ww[k];
                    }
                } else {
                    for (let t = 0; t < nT; t++) {
                        let s = 0;
                        for (let k = 0; k < L; k++) s += src[(i0 + k) * nT + t] * ww[k];
                        dst[(rb + j) * nT + t] = s;
                    }
                }
            }
        }
        return dst;
    }

    /* Positron range as a convolution in image space. The kernel from
       PET.isotopes.rangeKernel is point-symmetric, so this gather form
       equals the scatter form PET.util.convolve2D uses, and the operator
       is its own adjoint (zero outside the image in both directions). */
    function convolveSym(img, n, K, size, out) {
        const h = (size - 1) >> 1;
        out = out || new Float32Array(n * n);
        for (let y = 0; y < n; y++) {
            const ky0 = y < h ? -y : -h, ky1 = n - 1 - y < h ? n - 1 - y : h;
            for (let x = 0; x < n; x++) {
                const kx0 = x < h ? -x : -h, kx1 = n - 1 - x < h ? n - 1 - x : h;
                let s = 0;
                for (let ky = ky0; ky <= ky1; ky++) {
                    const ro = (y + ky) * n + x, kr = (ky + h) * size + h;
                    for (let kx = kx0; kx <= kx1; kx++) s += img[ro + kx] * K[kr + kx];
                }
                out[y * n + x] = s;
            }
        }
        return out;
    }

    /* ---------- pixel-driven backprojection (FBP) ----------
       For FBP each pixel picks up, at every angle, the filtered
       projection at its own r = x cos t + y sin t (linear interpolation
       between the 2 mm bins). Unlike the projector's ray-driven adjoint
       it leaves no gaps when pixels are smaller than the bins (256 x 256),
       and it is several times faster. Result: sum over angles x pi/nA,
       the discrete form of the integral over [0, pi) in the inversion
       formula, so the image comes out in the units of the data. */
    const trig = (function () {
        const c = new Float64Array(nA), s = new Float64Array(nA);
        for (let a = 0; a < nA; a++) { c[a] = Math.cos(G.angle(a)); s[a] = Math.sin(G.angle(a)); }
        return { c: c, s: s };
    })();
    function backprojectPixel(q, pe) {
        const n = pe.n, dx = pe.dx, h0 = Math.floor(n / 2), out = new Float32Array(n * n);
        const invDr = 1 / G.dr, half = nR / 2, last = nR - 1;
        for (let a = 0; a < nA; a++) {
            const c = trig.c[a], s = trig.s[a], row = a * nR, step = dx * c * invDr;
            for (let iy = 0; iy < n; iy++) {
                const lo = pe.rowLo[iy], hi = pe.rowHi[iy];
                if (hi < lo) continue;
                const y = (iy - h0) * dx, o = iy * n;
                let fi = ((lo - h0) * dx * c + y * s) * invDr + half;
                for (let ix = lo; ix <= hi; ix++, fi += step) {
                    // fi > 0 everywhere inside the FOV mask, so truncation is floor
                    // (and avoids a Math call in the innermost loop)
                    const i0 = fi | 0, f = fi - i0;
                    if (fi < 0 || i0 >= last) continue;             // never inside the mask; kept as a guard
                    out[o + ix] += q[row + i0] + f * (q[row + i0 + 1] - q[row + i0]);
                }
            }
        }
        const sc = Math.PI / nA;
        for (let k = 0; k < out.length; k++) out[k] *= sc;
        return out;
    }

    /* Plain backprojection is not an inverse, so it has no natural scale.
       Scale it so a uniform 200 mm cylinder (the reference phantom) gets
       its true mean back: project a disk of value 1 with this projector,
       backproject, and take 1 / (mean inside the disk). Done once per
       projector; TOF backprojection is far less spread out, so it gets
       its own number. */
    async function bpScale(pe, tick) {
        if (pe.bpScale > 0) return pe.bpScale;
        const n = pe.n, dx = pe.dx, h0 = Math.floor(n / 2), R = 100, disk = new Float32Array(n * n);
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            let f = 0;
            for (let q = 0; q < 16; q++) {
                const x = (ix - h0 + ((q & 3) + 0.5) / 4 - 0.5) * dx, y = (iy - h0 + ((q >> 2) + 0.5) / 4 - 0.5) * dx;
                if (x * x + y * y <= R * R) f++;
            }
            disk[iy * n + ix] = f / 16;
        }
        const b = await backChunked(pe.P, await forwardChunked(pe.P, disk, ALL, null, tick), ALL, null, tick);
        let s = 0, w = 0;
        for (let k = 0; k < disk.length; k++) { s += disk[k] * b[k]; w += disk[k]; }
        pe.bpScale = w > 0 && s > 0 ? w / s : 1;
        return pe.bpScale;
    }

    /* ---------- data preparation ---------- */
    function sumArrays(a, b) {
        if (!a) return b; if (!b) return a;
        const out = new Float32Array(a.length);
        for (let k = 0; k < a.length; k++) out[k] = a[k] + b[k];
        return out;
    }
    /* Everything one frame contributes: counts y, additive background b
       = s + r (each only if its correction is on), and kappa. TOF arrays
       are summed when TOF is not used. */
    function frameData(acq, f, o, useTof, nTdata) {
        const F = acq.frames[f], c = o.corrections;
        let y = F.prompts, usedMC = false;
        if (c.motion && F.promptsMC) { y = F.promptsMC; usedMC = true; }
        let r = null;
        if (c.randoms) r = c.randomsMethod === 'singles' ? (F.randomsSingles || F.delayed) : (F.delayed || F.randomsSingles);
        const s = c.scatter ? F.scatterEst : null;
        const kappa = c.decay ? F.kappa : (F.kappaNoDecay !== undefined ? F.kappaNoDecay : F.kappa);
        const sum = function (arr) { return (!arr || useTof || nTdata === 1) ? arr : S.sumTOF(arr, nTdata); };
        y = sum(y); r = sum(r);
        const sc = sum(s);
        return { frame: f, y: y, r: r, s: sc, b: sumArrays(sc, r), kappa: kappa > 0 ? kappa : 0, usedMC: usedMC, F: F };
    }
    /* Per-LOR multiplicative weights w = n a (without kappa). With
       normalisation off the reconstruction assumes every LOR is equally
       efficient; with attenuation off it assumes nothing is attenuated. */
    function lorWeights(acq, c) {
        const corr = acq.corrections || {}, w = new Float32Array(NLOR);
        const norm = c.normalization && corr.norm ? corr.norm : null, acf = c.attenuation && corr.acf ? corr.acf : null;
        for (let k = 0; k < NLOR; k++) {
            let v = norm ? norm[k] : 1;
            if (acf) v /= (acf[k] > 0 ? acf[k] : 1);
            w[k] = v > 0 ? v : 0;
        }
        return w;
    }

    /* The corrected sinogram FBP inverts (and the bp/display sinogram):
         p = (y - r - s) / n * acf / kappa
       in Bq/mL x mm of line integral. LORs whose efficiency is zero (a
       dead block) carry no information, so they are set to zero, which
       FBP shows as streaks. nT = 1 gives the non-TOF sinogram; with nT > 1
       each TOF bin is corrected the same way. */
    function correctSinogram(d, acq, c, nT) {
        const corr = acq.corrections || {};
        const norm = c.normalization && corr.norm ? corr.norm : null, acf = c.attenuation && corr.acf ? corr.acf : null;
        const out = new Float32Array(NLOR * nT), y = d.y, b = d.b;
        if (!(d.kappa > 0)) return out;
        const ik = 1 / d.kappa;
        for (let k = 0; k < NLOR; k++) {
            const nk = norm ? norm[k] : 1;
            if (!(nk > 0)) continue;
            const g = (acf ? acf[k] : 1) * ik / nk, base = k * nT;
            for (let t = 0; t < nT; t++) out[base + t] = (y[base + t] - (b ? b[base + t] : 0)) * g;
        }
        return out;
    }

    /* ---------- the iterative reconstruction ---------- */
    async function sensitivities(acq, pe, o, subsetList, nT, w, range, tick) {
        let byCorr = sensCache.get(acq.corrections || acq);
        if (!byCorr) { byCorr = new Map(); sensCache.set(acq.corrections || acq, byCorr); }
        const c = o.corrections;
        const key = [pe.key, o.method === 'mlem' ? 1 : o.subsets, o.psf ? 1 : 0, range ? range.key : '-',
            c.normalization ? 1 : 0, c.attenuation ? 1 : 0].join('|');
        const hit = byCorr.get(key);
        if (hit) { byCorr.delete(key); byCorr.set(key, hit); return hit; }       // most recently used last
        // H^T (w), w repeated over the TOF bins of each LOR
        let wT = w;
        if (nT > 1) { wT = new Float32Array(NLOR * nT); for (let k = 0; k < NLOR; k++) for (let t = 0; t < nT; t++) wT[k * nT + t] = w[k]; }
        if (o.psf) wT = blurRows(wT, new Float32Array(wT.length), ALL, nT, true);
        const sens = [], total = new Float32Array(pe.n * pe.n);
        for (let q = 0; q < subsetList.length; q++) {
            let img = await backChunked(pe.P, wT, subsetList[q], null, tick);
            if (range) img = convolveSym(img, pe.n, range.kernel, range.size);
            sens.push(img);
            for (let j = 0; j < img.length; j++) total[j] += img[j];
        }
        const out = { sens: sens, total: total };
        byCorr.set(key, out);
        while (byCorr.size > SENS_KEEP) byCorr.delete(byCorr.keys().next().value);
        return out;
    }

    function postProcess(x, pe, o) {
        const n = pe.n;
        const img = o.postFilter > 0 ? U.gaussBlur2D(x, n, n, o.postFilter / pe.dx) : Float32Array.from(x);
        const m = pe.mask;
        for (let k = 0; k < img.length; k++) if (!m[k]) img[k] = 0;
        return img;
    }

    async function iterative(job, d, tick, progBase, progSpan) {
        const pe = job.pe, P = pe.P, n = pe.n, nT = job.nT, o = job.o, mask = pe.mask, w = job.w, kappa = d.kappa;
        const subsetList = job.subsetList, nSub = subsetList.length, range = job.range;
        const iters = [];
        if (!(kappa > 0)) {
            const z = new Float32Array(n * n);
            return { image: z, iterations: o.keepIterations ? [] : null, done: 0 };
        }
        const SN = job.sens, y = d.y, b = d.b;

        // Start from a uniform image inside the FOV whose forward projection
        // holds the right number of (background-subtracted) counts.
        let net = 0, tot = 0;
        for (let k = 0; k < y.length; k++) { net += y[k] - (b ? b[k] : 0); tot += y[k]; }
        let sMask = 0;
        for (let j = 0; j < n * n; j++) if (mask[j]) sMask += SN.total[j];
        let x0 = sMask > 0 ? Math.max(net, 0.01 * tot) / (kappa * sMask) : 0;
        if (!(x0 > 0)) x0 = 1e-6;
        const x = new Float32Array(n * n);
        for (let j = 0; j < n * n; j++) x[j] = mask[j] ? x0 : 0;

        const size = P.size, fwd = new Float32Array(size), ratio = new Float32Array(size);
        const fwdB = o.psf ? new Float32Array(size) : null, ratioB = o.psf ? new Float32Array(size) : null;
        const bimg = new Float32Array(n * n), xr = range ? new Float32Array(n * n) : null;
        const thr = new Float64Array(nSub);
        for (let q = 0; q < nSub; q++) { let mx = 0; const sq = SN.sens[q]; for (let j = 0; j < sq.length; j++) if (sq[j] > mx) mx = sq[j]; thr[q] = 1e-6 * mx; }
        const EPS = 1e-9;
        let done = 0;
        for (let it = 1; it <= o.iterations; it++) {
            for (let qi = 0; qi < nSub; qi++) {
                const src = range ? convolveSym(x, n, range.kernel, range.size, xr) : x;
                const chunks = chunksOf(subsetList[qi]);
                bimg.fill(0);
                for (let ci = 0; ci < chunks.length; ci++) {
                    const angles = chunks[ci];
                    // forward model of these rows: blur(P(range(x)))
                    P.forward(src, angles, fwd);
                    const hx = o.psf ? blurRows(fwd, fwdB, angles, nT, false) : fwd;
                    // ratio of measured to modelled counts, weighted by n a
                    for (let q = 0; q < angles.length; q++) {
                        const a = angles[q];
                        for (let i = 0; i < nR; i++) {
                            const lor = a * nR + i, wk = w[lor], base = lor * nT;
                            if (!(wk > 0)) { for (let t = 0; t < nT; t++) ratio[base + t] = 0; continue; }
                            const kw = kappa * wk;
                            for (let t = 0; t < nT; t++) {
                                const yv = y[base + t];
                                if (yv > 0) {
                                    let yb = kw * hx[base + t] + (b ? b[base + t] : 0);
                                    if (yb < EPS) yb = EPS;
                                    ratio[base + t] = wk * yv / yb;
                                } else ratio[base + t] = 0;
                            }
                        }
                    }
                    const rb = o.psf ? blurRows(ratio, ratioB, angles, nT, true) : ratio;
                    P.back(rb, angles, bimg);
                    if (chunks.length > 1) await tick();
                }
                const corr = range ? convolveSym(bimg, n, range.kernel, range.size) : bimg;
                const sq = SN.sens[qi], th = thr[qi];
                for (let j = 0; j < x.length; j++) {
                    if (!mask[j] || !(sq[j] > th)) { x[j] = 0; continue; }
                    x[j] *= corr[j] / sq[j];
                }
                await tick(progBase + progSpan * ((it - 1) * nSub + qi + 1) / (o.iterations * nSub));
            }
            done = it;
            const want = o.keepIterations || job.onIteration;
            if (want) {
                const img = postProcess(x, pe, o);
                if (o.keepIterations) iters.push(img);
                if (job.onIteration) job.onIteration(it, img, d.frame);
            }
        }
        const image = (o.keepIterations && iters.length) ? iters[iters.length - 1] : postProcess(x, pe, o);
        return { image: image, iterations: o.keepIterations ? iters : null, done: done };
    }

    /* ---------- notes for students ----------
       One plain sentence each, only for things that change what the
       image means. acq.physics (what was simulated) is compared with the
       corrections (what the reconstruction assumes) so that a correction
       applied to an effect that is not there gets explained too. */
    function buildNotes(acq, o, ctx) {
        const notes = [], c = o.corrections, ph = acq.physics || {}, m = o.method;
        const iterative = m === 'mlem' || m === 'osem';
        if (ctx.dataTof && m === 'fbp') notes.push('FBP ignores time of flight: the TOF bins were summed.');
        else if (ctx.dataTof && !o.tof) notes.push('Time of flight was switched off for this reconstruction: the TOF bins were summed.');
        else if (!ctx.dataTof && o.tof && m !== 'fbp') notes.push('This scan has no time-of-flight data (TOF was off in the protocol), so the reconstruction is non-TOF.');
        if (ctx.useTof) notes.push('Time of flight places each event along its line to within about ' + Math.round(ctx.sigma * U.FWHM_PER_SIGMA) + ' mm (FWHM), so ' +
            (m === 'bp' ? 'the backprojection is much less smeared.' : 'the reconstruction converges in fewer iterations and is less noisy.'));
        if (m === 'mlem' && o.subsets > 1) notes.push('MLEM uses every angle in each update, so the subsets setting is ignored and it needs many more iterations than OSEM.');
        if (!iterative && o.psf) notes.push('Resolution modelling (PSF) only works inside MLEM and OSEM; ' + (m === 'fbp' ? 'FBP' : 'backprojection') + ' ignores it.');
        if (!iterative && o.rangeCorrection) notes.push('Positron range correction only works inside MLEM and OSEM; ' + (m === 'fbp' ? 'FBP' : 'backprojection') + ' ignores it.');
        if (iterative && o.psf) notes.push('Resolution modelling sharpens edges but can overshoot them (Gibbs ringing) as the iterations go on.');
        if (m === 'bp') notes.push('Backprojection alone is not an inverse: every point is smeared along its lines (the 1/r blur). Values are scaled so a uniform 200 mm cylinder has the right mean.');
        if (ctx.deadLors > 0 && c.normalization) {
            notes.push(iterative
                ? ctx.deadLors + ' lines of response have no data (a dead detector block); MLEM and OSEM simply leave them out of the model and fill in from the other angles.'
                : ctx.deadLors + ' lines of response have no data (a dead detector block); they were set to zero, which shows as streaks.');
        }
        if (!c.normalization) {
            const det = ph.detector || {};
            notes.push(det.variation === 0 && !(det.deadBlock >= 0)
                ? 'Normalisation is off, but every crystal is equally efficient in this simulation, so it makes no difference.'
                : 'Normalisation is off, so the differences in crystal efficiency show up as streaks and a fine pattern in the image.');
        }
        if (!c.attenuation) {
            if (ph.attenuation !== false) notes.push('Attenuation correction is off: the middle of the object looks too cold, the edges too bright, and all values far too low.');
        } else {
            if (ph.attenuation === false) notes.push('Attenuation correction is on although the simulated photons were not attenuated, so the image is over-corrected (too hot in the middle).');
            const mm = ph.muMap || {};
            if (mm.dx || mm.dy || mm.rot || mm.model === 'nobone') notes.push('The mu map used for attenuation correction does not match the object (' +
                (mm.model === 'nobone' && !(mm.dx || mm.dy || mm.rot) ? 'bone is missing from it' : 'it is shifted or rotated') + '), so attenuation and scatter are corrected wrongly where they disagree.');
        }
        if (!c.scatter && ph.scatter !== false) notes.push('Scatter correction is off: scattered events add a smooth haze that fills in cold regions and lowers contrast.');
        if (!c.randoms && ph.randoms !== false) notes.push('Randoms correction is off: random coincidences add a flat background over the whole field of view.');
        if (c.randoms && c.randomsMethod !== 'singles' && !iterative && ph.randoms !== false) notes.push('Randoms were estimated from the delayed window, which is as noisy as the randoms themselves, so subtracting it adds noise.');
        if (!c.decay) notes.push('Decay correction is off: values are the average activity during the frame, not the activity at injection' + (acq.frames.length > 1 ? ', so later frames look too low.' : '.'));
        const motionOn = ph.motion && ph.motion.on;
        if (c.motion) {
            if (ctx.usedMC) notes.push('Motion correction is on: each event was moved back to the starting position using the (perfect) motion tracking.');
            else notes.push('Motion correction is on, but there was no motion to correct in this scan.');
        } else if (motionOn) notes.push('The object moved during the scan and motion correction is off, so edges are blurred or doubled, and attenuation correction no longer lines up.');
        if (ctx.emptyFrames > 0) notes.push(ctx.emptyFrames === 1 && !ctx.all ? 'This frame was acquired before the injection (or holds no counts), so there is nothing to reconstruct.' : ctx.emptyFrames + ' frames hold no counts and were left empty.');
        if (ctx.all) notes.push('All ' + ctx.nFrames + ' frames were reconstructed; the image shown is their duration-weighted average.');
        return notes;
    }

    /* ---------- run ---------- */
    async function run(acq, opts, hooks) {
        const t0 = Date.now();
        hooks = hooks || {};
        if (!acq || !acq.frames || !acq.frames.length) throw new Error('There is no acquisition to reconstruct yet.');
        const o = mergeOpts(opts);
        const nTdata = Math.max(1, Math.round(acq.frames[0].prompts.length / NLOR));
        const dataTof = nTdata > 1;
        const useTof = dataTof && nTdata === G.nT && !!o.tof && o.method !== 'fbp';
        const sigma = useTof ? ((acq.geom && acq.geom.sigmaTOF > 0) ? acq.geom.sigmaTOF : S.timing.sigmaPos((acq.geom && acq.geom.ctr) || G.ctrDefault)) : 0;
        const nT = useTof ? nTdata : 1;
        const all = o.frame === 'all';
        let frameList;
        if (all) frameList = acq.frames.map(function (F, k) { return k; });
        else {
            const f = Math.round(+o.frame || 0);
            if (f < 0 || f >= acq.frames.length) throw new Error('Frame ' + o.frame + ' does not exist: this scan has ' + acq.frames.length + ' frame(s).');
            frameList = [f];
        }

        let lastYield = Date.now();
        const abort = typeof hooks.shouldAbort === 'function' ? hooks.shouldAbort : null;
        const progress = typeof hooks.onProgress === 'function' ? hooks.onProgress : null;
        async function tick(frac) {
            if (abort && abort()) throw new Error('aborted');
            if (progress && frac !== undefined) progress(Math.min(1, frac));
            if (Date.now() - lastYield >= 30) {
                await U.yieldFrame();
                lastYield = Date.now();
                if (abort && abort()) throw new Error('aborted');
            }
        }
        await tick(0);

        const pe = getProjector(o.matrix, sigma);
        const n = pe.n, c = o.corrections;
        const iterativeM = o.method === 'mlem' || o.method === 'osem';
        const w = lorWeights(acq, c);
        const norm = acq.corrections && acq.corrections.norm;
        let deadLors = 0;
        if (norm) for (let k = 0; k < NLOR; k++) if (!(norm[k] > 0)) deadLors++;

        const job = { pe: pe, o: o, nT: nT, w: w, range: null, subsetList: null, sens: null,
            onIteration: typeof hooks.onIteration === 'function' ? hooks.onIteration : null };
        if (iterativeM) {
            // Image-space part of the system model: the isotropic detector
            // response (with psf) and the positron range kernel (with
            // rangeCorrection), combined into one symmetric kernel.
            let ik = null, ikey = '';
            if (o.psf) { ik = S.isoKernel(pe.dx); ikey += 'psf'; }
            if (o.rangeCorrection && acq.isotope) {
                const rk = PET.isotopes.rangeKernel(acq.isotope, pe.dx);
                ik = ik ? S.combineKernels(ik, rk) : rk;
                ikey += ':' + PET.isotopes.get(acq.isotope).id;
            }
            if (ik) job.range = { kernel: ik.kernel, size: ik.size, key: ikey + ':' + pe.dx };
            job.subsetList = o.method === 'mlem' ? [ALL] : S.subsets(o.subsets);
            job.sens = await sensitivities(acq, pe, o, job.subsetList, nT, w, job.range, tick);
            await tick(0.02);
        }

        const images = [], iterLists = [];
        let corrected = null, usedMC = false, emptyFrames = 0, done = 0;
        for (let fi = 0; fi < frameList.length; fi++) {
            const f = frameList[fi], base = 0.02 + 0.98 * fi / frameList.length, span = 0.98 / frameList.length;
            const d = frameData(acq, f, o, useTof, nTdata);
            usedMC = usedMC || d.usedMC;
            if (!(d.kappa > 0)) emptyFrames++;
            // the corrected non-TOF sinogram, for FBP and for display
            const dNon = useTof ? frameData(acq, f, o, false, nTdata) : d;
            const pc = correctSinogram(dNon, acq, c, 1);
            if (fi === frameList.length - 1) corrected = pc;
            let img, its = null;
            if (o.method === 'fbp') {
                const q = filterSinogram(pc, o.filter, o.cutoff, o.order);
                img = postProcess(backprojectPixel(q, pe), pe, o);
            } else if (o.method === 'bp') {
                const pT = useTof ? correctSinogram(d, acq, c, nT) : pc;
                const raw = await backChunked(pe.P, pT, ALL, null, tick), sc = await bpScale(pe, tick);
                for (let k = 0; k < raw.length; k++) raw[k] *= sc;
                img = postProcess(raw, pe, o);
            } else {
                const r = await iterative(job, d, tick, base, span);
                img = r.image; its = r.iterations; done = r.done;
            }
            images.push(img);
            iterLists.push(its);
            await tick(base + span);
        }

        let image;
        if (all) {
            // Duration-weighted mean of the frames that hold data: the
            // "summed image" usually used to draw regions on.
            image = new Float32Array(n * n);
            let wsum = 0;
            frameList.forEach(function (f, k) {
                const F = acq.frames[f], dur = F.dur !== undefined ? F.dur : (F.t1 - F.t0);
                if (!((c.decay ? F.kappa : F.kappaNoDecay) > 0) || !(dur > 0)) return;
                const im = images[k];
                for (let j = 0; j < im.length; j++) image[j] += dur * im[j];
                wsum += dur;
            });
            if (wsum > 0) for (let j = 0; j < image.length; j++) image[j] /= wsum;
        } else image = images[0];

        if (progress) progress(1);
        const notes = buildNotes(acq, o, { dataTof: dataTof, useTof: useTof, sigma: sigma, deadLors: deadLors, usedMC: usedMC, emptyFrames: emptyFrames, all: all, nFrames: frameList.length });
        return {
            n: n, fov: G.fov, dx: pe.dx, method: o.method, frame: all ? 'all' : frameList[0],
            image: image,
            frames: all ? images : null,
            iterations: (!all && iterativeM && o.keepIterations) ? iterLists[0] : null,
            corrected: corrected,
            info: {
                timeMs: Date.now() - t0, notes: notes, tofUsed: useTof, iterationsDone: iterativeM ? done : 0,
                subsets: o.method === 'osem' ? job.subsetList.length : (o.method === 'mlem' ? 1 : 0),
                sigmaTOF: sigma, psf: iterativeM && !!o.psf, rangeCorrection: iterativeM && !!o.rangeCorrection && !!acq.isotope,
                filter: o.method === 'fbp' ? o.filter : null, options: o
            }
        };
    }

    function clearCache() {
        Object.keys(projCache).forEach(function (k) { delete projCache[k]; });
    }

    PET.recon = {
        run: run,
        filters: {
            list: FILTERS.slice(), ids: FILTER_IDS.slice(),
            window: windowValue,
            response: filterResponse,
            nyquist: 1 / (2 * G.dr)
        },
        clearCache: clearCache,
        // internals exposed for tests (not part of the UI contract)
        _internal: { blurRows: blurRows, convolveSym: convolveSym, filterSinogram: filterSinogram, backprojectPixel: backprojectPixel,
            getProjector: getProjector, rampSpectrum: rampSpectrum, mergeOpts: mergeOpts }
    };
    Object.defineProperty(PET.recon, 'defaults', { get: defaults, enumerable: true });

})(typeof window !== 'undefined' ? window : globalThis);
