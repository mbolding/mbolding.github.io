/* ============================================================
   PET Simulator, isotopes and tracers
   The three positron emitters the simulator offers (18F, 11C, 15O):
   half-life, positron yield and energy, and the positron range
   (how far the positron travels before it annihilates), plus the
   catalogue of tracers that the protocol language can name.

   Kinetic parameters of each tracer in each brain region live in
   kinetics.js; this file only says what a tracer is and which
   isotope carries it. No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;

    /* Positron range. The distribution of annihilation points around the
       decaying nucleus, projected onto one axis, is well described by a
       sum of two exponentials (a sharp cusp plus a long tail):
           p(x) = C k1/2 exp(-k1 |x|) + (1 - C) k2/2 exp(-k2 |x|)
       Values are approximate fits in water after Levin and Hoffman
       (Phys Med Biol 1999). rangeMean / rangeMax are the usual 3D mean
       and maximum ranges quoted in textbooks. */
    const ISOTOPES = {
        F18: {
            id: 'F18', label: '¹⁸F', name: 'Fluorine-18',
            halfLife: 109.77 * 60, betaPlus: 0.9673,
            eMax: 633.5, eMean: 249.8,                      // keV, positron kinetic energy
            rangeMean: 0.6, rangeMax: 2.4,                  // mm in water
            range1D: { C: 0.516, k1: 37.9, k2: 3.10 },      // 1/mm
            production: '18O(p,n)18F in a cyclotron',
            color: '#2a78d6'
        },
        C11: {
            id: 'C11', label: '¹¹C', name: 'Carbon-11',
            halfLife: 20.36 * 60, betaPlus: 0.9976,
            eMax: 960.4, eMean: 385.7,
            rangeMean: 1.2, rangeMax: 4.2,
            range1D: { C: 0.488, k1: 23.8, k2: 1.80 },
            production: '14N(p,α)11C in a cyclotron; labelling must happen on site within minutes',
            color: '#1baf7a'
        },
        O15: {
            id: 'O15', label: '¹⁵O', name: 'Oxygen-15',
            halfLife: 122.24, betaPlus: 0.9989,
            eMax: 1732, eMean: 735.3,
            rangeMean: 3.0, rangeMax: 8.2,
            range1D: { C: 0.379, k1: 18.1, k2: 0.83 },
            production: '14N(d,n)15O or 15N(p,n)15O; delivered by line from the cyclotron to the scanner',
            color: '#eb6834'
        }
    };
    /* The fitted shapes are kept, but each profile is rescaled so its mean
       |x| equals rangeMean / 2, which is what an isotropic 3D mean range
       projects to on one axis. That ties the model to the textbook mean
       ranges students will see quoted. */
    Object.keys(ISOTOPES).forEach(function (k) {
        const I = ISOTOPES[k], r = I.range1D;
        const mean1 = r.C / r.k1 + (1 - r.C) / r.k2, f = (I.rangeMean / 2) / mean1;
        I.range1D = { C: r.C, k1: r.k1 / f, k2: r.k2 / f };
    });
    const ALIASES = {
        F18: 'F18', '18F': 'F18', 'F-18': 'F18', FLUORINE18: 'F18',
        C11: 'C11', '11C': 'C11', 'C-11': 'C11', CARBON11: 'C11',
        O15: 'O15', '15O': 'O15', 'O-15': 'O15', OXYGEN15: 'O15'
    };

    function normalizeId(text) {
        if (!text) return null;
        const k = String(text).replace(/[\s_]/g, '').toUpperCase();
        return ALIASES[k] || null;
    }
    function get(id) {
        const k = normalizeId(id) || id;
        const iso = ISOTOPES[k];
        if (!iso) throw new Error('Unknown isotope "' + id + '". Use F18, C11 or O15.');
        return iso;
    }
    function lambda(iso) { return Math.LN2 / get(iso.id || iso).halfLife; }
    /* Fraction of the activity left after t seconds. */
    function decay(iso, t) { return Math.exp(-lambda(iso) * t); }
    /* Integral of exp(-lambda t) from t0 to t1 (seconds). Multiplying a
       decay-corrected concentration by this gives decays per mL. */
    function decayIntegral(iso, t0, t1) {
        const l = lambda(iso);
        if (l * (t1 - t0) < 1e-9) return (t1 - t0) * Math.exp(-l * t0);
        return (Math.exp(-l * t0) - Math.exp(-l * t1)) / l;
    }
    /* Factor that turns the mean measured activity over [t0, t1] into
       the activity at injection (t = 0): duration / decayIntegral. */
    function decayCorrection(iso, t0, t1) { return (t1 - t0) / decayIntegral(iso, t0, t1); }

    /* ---------- positron range ---------- */

    /* One in-plane displacement (mm) of the annihilation point from the
       nucleus. A 2D isotropic vector whose projection on any axis has the
       double-exponential profile above: a Gaussian whose variance is
       itself exponentially distributed has Laplace marginals, so draw
       V ~ Exp(mean 2/k^2) and return sqrt(V) * (n1, n2). */
    function sampleRange(iso, rng) {
        const r = get(iso.id || iso).range1D;
        const k = rng() < r.C ? r.k1 : r.k2;
        let u = rng(); if (u < 1e-12) u = 1e-12;
        const s = Math.sqrt(-Math.log(u) * 2 / (k * k));
        return [s * rng.randn(), s * rng.randn()];
    }

    /* The 1D projected profile (what a line-source measurement shows),
       evaluated on x (mm). Unit area. */
    function rangeProfile(iso, x) {
        const r = get(iso.id || iso).range1D, a = Math.abs(x);
        return r.C * r.k1 / 2 * Math.exp(-r.k1 * a) + (1 - r.C) * r.k2 / 2 * Math.exp(-r.k2 * a);
    }
    /* FWHM and FWTM of the 1D profile, found numerically. */
    function rangeWidths(iso) {
        const peak = rangeProfile(iso, 0);
        const width = function (frac) {
            let lo = 0, hi = 30;
            for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (rangeProfile(iso, m) > frac * peak) lo = m; else hi = m; }
            return 2 * lo;
        };
        return { fwhm: width(0.5), fwtm: width(0.1) };
    }

    /* Summary numbers of the 1D profile: mean |x| and RMS (mm). */
    function rangeStats(iso) {
        const r = get(iso.id || iso).range1D;
        return {
            mean1D: r.C / r.k1 + (1 - r.C) / r.k2,
            rms1D: Math.sqrt(2 * r.C / (r.k1 * r.k1) + 2 * (1 - r.C) / (r.k2 * r.k2))
        };
    }

    /* Pixel kernel for blurring an activity image with pixel size dx (mm)
       by positron range: K[j] = probability that a decay uniformly placed
       in the centre pixel annihilates in pixel j. Built once per (isotope,
       dx) by seeded Monte Carlo, so it is reproducible, sums to 1, and is
       exact for a piecewise-constant image. Returns {kernel, size, dx}. */
    const kernelCache = {};
    function rangeKernel(iso, dx) {
        const I = get(iso.id || iso), key = I.id + ':' + dx.toFixed(4);
        if (kernelCache[key]) return kernelCache[key];
        const reach = Math.min(12, 6 / I.range1D.k2);         // mm
        const h = Math.max(1, Math.ceil(reach / dx)), size = 2 * h + 1;
        const k = new Float64Array(size * size), rng = U.rng(1511 + size), N = 300000;
        let kept = 0;
        for (let i = 0; i < N; i++) {
            const d = sampleRange(I, rng);
            const fx = (rng() - 0.5) + d[0] / dx, fy = (rng() - 0.5) + d[1] / dx;
            const ix = Math.round(fx), iy = Math.round(fy);
            if (ix < -h || ix > h || iy < -h || iy > h) continue;
            k[(iy + h) * size + ix + h]++; kept++;
        }
        const out = new Float32Array(size * size);
        for (let i = 0; i < k.length; i++) out[i] = k[i] / kept;
        // Symmetrise (the Monte Carlo is isotropic in expectation), so
        // the kernel is its own adjoint in reconstruction.
        const sym = new Float32Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const xs = size - 1 - x, ys = size - 1 - y;
            sym[y * size + x] = (out[y * size + x] + out[y * size + xs] + out[ys * size + x] + out[ys * size + xs] +
                out[x * size + y] + out[x * size + ys] + out[xs * size + y] + out[xs * size + ys]) / 8;
        }
        return (kernelCache[key] = { kernel: sym, size: size, dx: dx });
    }

    /* ---------- tracers ----------
       model: '1tc'  one tissue compartment (freely diffusible, e.g. water)
              '2tci' two tissue, irreversible trapping (k4 = 0, e.g. FDG)
              '2tcr' two tissue, reversible binding (amyloid, DAT)
       reference: region the protocol would normally use for SUVR, by id
       (see the brain phantom in phantoms.js). Typical values are what a
       clinic would use and become the defaults of the presets. */
    const TRACERS = [
        {
            id: 'FDG', label: '[¹⁸F]FDG', name: 'Fluorodeoxyglucose', isotope: 'F18',
            target: 'Glucose metabolism (transport by GLUT1, phosphorylation by hexokinase, then trapped)',
            model: '2tci', reference: 'cereb_gm', outcome: 'Ki (influx rate) and SUV',
            typicalDose: 185e6, typicalUptake: 45 * 60, typicalDuration: 10 * 60
        },
        {
            id: 'PiB', label: '[¹¹C]PiB', name: 'Pittsburgh compound B', isotope: 'C11',
            target: 'Fibrillar beta-amyloid plaques',
            model: '2tcr', reference: 'cereb_gm', outcome: 'BPND (DVR - 1) or SUVR',
            typicalDose: 400e6, typicalUptake: 50 * 60, typicalDuration: 20 * 60
        },
        {
            id: 'florbetaben', label: '[¹⁸F]florbetaben', name: 'Florbetaben', isotope: 'F18',
            target: 'Fibrillar beta-amyloid plaques (an 18F tracer, so it can be shipped to clinics without a cyclotron)',
            model: '2tcr', reference: 'cereb_gm', outcome: 'SUVR',
            typicalDose: 300e6, typicalUptake: 90 * 60, typicalDuration: 20 * 60
        },
        {
            id: 'PE2I', label: '[¹¹C]PE2I', name: 'PE2I', isotope: 'C11',
            target: 'Dopamine transporter (DAT) on presynaptic dopaminergic terminals',
            model: '2tcr', reference: 'cereb_gm', outcome: 'BPND',
            typicalDose: 350e6, typicalUptake: 0, typicalDuration: 70 * 60
        },
        {
            id: 'FE-PE2I', label: '[¹⁸F]FE-PE2I', name: 'FE-PE2I', isotope: 'F18',
            target: 'Dopamine transporter (DAT); the PET relative of the SPECT agent DaTscan',
            model: '2tcr', reference: 'cereb_gm', outcome: 'BPND or SUVR',
            typicalDose: 200e6, typicalUptake: 20 * 60, typicalDuration: 20 * 60
        },
        {
            id: 'water', label: '[¹⁵O]water', name: 'Oxygen-15 water', isotope: 'O15',
            target: 'Cerebral blood flow (freely diffusible, not trapped)',
            model: '1tc', reference: null, outcome: 'CBF = K1 (mL/min/mL)',
            typicalDose: 700e6, typicalUptake: 0, typicalDuration: 3 * 60
        }
    ];
    const TRACER_ALIASES = {};
    TRACERS.forEach(function (t) {
        TRACER_ALIASES[t.id.toUpperCase()] = t.id;
        TRACER_ALIASES[t.id.replace(/-/g, '').toUpperCase()] = t.id;
    });
    TRACER_ALIASES.H2O = 'water'; TRACER_ALIASES.WATER = 'water'; TRACER_ALIASES.FBB = 'florbetaben';

    function tracerId(text) {
        if (!text) return null;
        return TRACER_ALIASES[String(text).replace(/[\s_]/g, '').toUpperCase()] || null;
    }
    function tracer(id) {
        const k = tracerId(id);
        const t = k && TRACERS.find(function (x) { return x.id === k; });
        if (!t) throw new Error('Unknown tracer "' + id + '".');
        return t;
    }

    PET.isotopes = {
        list: function () { return ['F18', 'C11', 'O15'].map(function (k) { return ISOTOPES[k]; }); },
        get: get, normalizeId: normalizeId,
        lambda: lambda, decay: decay, decayIntegral: decayIntegral, decayCorrection: decayCorrection,
        sampleRange: sampleRange, rangeProfile: rangeProfile, rangeWidths: rangeWidths, rangeStats: rangeStats, rangeKernel: rangeKernel
    };
    PET.tracers = {
        list: function () { return TRACERS.slice(); },
        get: tracer, normalizeId: tracerId
    };

})(typeof window !== 'undefined' ? window : globalThis);
