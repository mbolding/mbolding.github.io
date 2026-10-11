/* ============================================================
   PET Simulator, kinetics
   Where the tracer goes and when. A plasma input function per
   tracer, the compartment models that turn it into tissue
   concentration region by region, the regional time-activity
   curves (TACs) of a phantom for a compiled protocol, and the
   quantities clinicians and researchers read off them: SUV, SUVR,
   Patlak Ki and Logan DVR.

   Tissue activity is never painted on. Every brain region's curve
   comes from a compartment model driven by the input function, so a
   static image, a dynamic series, SUV, SUVR and their biases all
   follow from the same few rate constants (ARCHITECTURE.md section 5).

   Units. Curves are computed in SUV units, decay corrected
   (concentration divided by injected dose per gram of body weight),
   then scaled to Bq/mL by suvScale = dose / (weight_kg * 1000).
   Rate constants are per minute, as in the literature (K1 in
   mL/min/mL, k2..k4 in 1/min); every API time is in seconds and the
   conversion happens inside this file. No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;

    /* ---------- input functions ----------
       Feng-type plasma curve (Feng, Huang and Wang, Int J Biomed Comput
       1993), in SUV units, tau = t - delay in minutes:
           Cp(tau) = (A1 tau - A2 - A3) exp(-l1 tau) + A2 exp(-l2 tau) + A3 exp(-l3 tau)
       It rises from zero at the arrival time, peaks within a minute
       (the bolus passing through the heart and lungs), falls quickly
       while the tracer distributes through the body, then clears
       slowly. A1 is in SUV per minute, A2 and A3 in SUV, l1..l3 in
       1/min, delay in seconds.

       These are teaching curves, not population averages. The shapes
       follow the published kinds of curve, and the amplitudes and the
       slow tails were tuned together with the parameter table below so
       the numbers the course quotes come out (FDG gray matter SUV about 7
       at 50 min; PiB cortex SUVR about 1.2 normal and 2.6 in AD at 50 to
       70 min; the DAT striatum peaking at about 47 min for PE2I and
       26 min for FE-PE2I). The slower the plasma tail falls compared with
       how fast a high-binding region can follow it, the more a late SUVR
       overshoots the true DVR (transient equilibrium). All are curves of
       the PARENT tracer: real amyloid and DAT tracers are metabolised
       quickly and an analysis must correct the measured plasma for
       labelled metabolites, which the simulator leaves out. */
    const INPUTS = {
        // Feng's classic FDG parameters (A1 851 uCi/mL/min, A2 21.9 and
        // A3 20.8 uCi/mL, l 4.13, 0.104, 0.0165 /min) with all three
        // amplitudes multiplied by 0.202 to put the curve in SUV.
        FDG: { A1: 172, A2: 4.42, A3: 4.20, l1: 4.134, l2: 0.1045, l3: 0.0165, delay: 15,
            description: 'Feng-type FDG curve: a sharp peak about 30 s after injection, then slow clearance by the kidneys and uptake into tissue throughout the body' },
        // PiB is lipophilic and is cleared and metabolised fast: the parent
        // compound falls by more than 90 % within a few minutes and then
        // declines slowly (half-life of the tail about 3 h).
        PiB: { A1: 300, A2: 5.0, A3: 0.34, l1: 5.5, l2: 1.2, l3: 0.004, delay: 15,
            description: 'Fast-clearing parent [11C]PiB: a tall peak, more than 90 % gone within 5 minutes, then a slow tail (metabolites not modelled)' },
        // Florbetaben: the same kind of curve with a slightly fuller tail.
        florbetaben: { A1: 260, A2: 4.0, A3: 0.40, l1: 5.0, l2: 1.0, l3: 0.005, delay: 15,
            description: 'Parent [18F]florbetaben: fast early clearance, then a slow tail (metabolites not modelled)' },
        // The two DAT tracers are close relatives and get the same parent
        // plasma curve, so the difference students see between them comes
        // from the tissue rate constants alone. Relative to the bolus the
        // tail is fuller than for PiB, which is what lets the striatum keep
        // filling for half an hour or more.
        PE2I: { A1: 150, A2: 2.0, A3: 0.60, l1: 5.0, l2: 0.8, l3: 0.010, delay: 15,
            description: 'Parent [11C]PE2I: a bolus that clears within minutes, then a slow tail (metabolites not modelled)' },
        'FE-PE2I': { A1: 150, A2: 2.0, A3: 0.60, l1: 5.0, l2: 0.8, l3: 0.010, delay: 15,
            description: 'Parent [18F]FE-PE2I: the same curve as PE2I (metabolites not modelled)' },
        // Water is freely diffusible and spreads through the whole body
        // water space: a sharp first pass, then a plateau that hardly falls
        // over a 3 minute scan.
        water: { A1: 200, A2: 6.0, A3: 1.30, l1: 7.0, l2: 2.4, l3: 0.010, delay: 12,
            description: 'Sharp [15O]water bolus peaking about 20 s after injection, then a plateau as the water mixes with total body water' }
    };

    function fengSUV(p, tSec) {
        const tau = (tSec - p.delay) / 60;
        if (tau <= 0) return 0;
        const v = (p.A1 * tau - p.A2 - p.A3) * Math.exp(-p.l1 * tau) + p.A2 * Math.exp(-p.l2 * tau) + p.A3 * Math.exp(-p.l3 * tau);
        return v > 0 ? v : 0;
    }

    /* ---------- regional parameters ----------
       One table per tracer. Rate constants per minute; vb is the blood
       volume fraction of the region (the scanner sees vb of blood plus
       1 - vb of tissue in every voxel). For reversible tracers a region
       is given by K1, k2, k4 and its BPND, and k3 = BPND * k4 is worked
       out, because BPND is the number the course talks about.

       Region classes: the brain phantom's region ids map onto these
       (see CLASS_OF below). A region id listed directly in a table wins
       over its class. CSF, ventricles, skull and air take up nothing
       (params returns null); the sinus is blood and its curve is the
       plasma curve.

       Sources. Literature-typical values rounded for teaching: FDG gray
       and white matter from Phelps et al. (Ann Neurol 1979) and Huang
       et al. (Am J Physiol 1980); PiB from Price et al. (J Cereb Blood
       Flow Metab 2005) and Lopresti et al. (J Nucl Med 2005); florbetaben
       from Becker et al. (J Nucl Med 2013); PE2I from Jucaite et al.
       (Eur J Nucl Med Mol Imaging 2006); FE-PE2I from Sasaki et al.
       (J Nucl Med 2012); water from the classic Kety-Schmidt and Raichle
       values. Numbers were then adjusted so the targets in
       ARCHITECTURE.md section 5 come out; treat them as round numbers
       with the right orders of magnitude, not as reference data. */
    const TABLE = {
        FDG: {
            model: '2tci',
            note: 'Glucose analogue. Transported in by GLUT1 (K1), back out (k2), phosphorylated by hexokinase (k3) and then trapped, because FDG-6-phosphate is not metabolised further (k4 = 0).',
            regions: {
                cortex:   { K1: 0.102, k2: 0.130, k3: 0.062, vb: 0.04 },   // Phelps 1979 gray matter
                caudate:  { K1: 0.100, k2: 0.130, k3: 0.060, vb: 0.04 },
                putamen:  { K1: 0.105, k2: 0.130, k3: 0.064, vb: 0.04 },
                thalamus: { K1: 0.095, k2: 0.130, k3: 0.056, vb: 0.04 },
                cereb_gm: { K1: 0.090, k2: 0.130, k3: 0.048, vb: 0.04 },   // cerebellum is a little below cortex on FDG
                // White matter: Phelps' K1 and k2 with k3 lowered from 0.045
                // to 0.028, so the gray to white contrast at 50 min is the
                // 2.5 or so seen on real FDG images rather than 2.
                wm:       { K1: 0.054, k2: 0.109, k3: 0.028, vb: 0.02 },
                cereb_wm: { K1: 0.054, k2: 0.109, k3: 0.030, vb: 0.02 },
                scalp:    { K1: 0.030, k2: 0.150, k3: 0.010, vb: 0.02 }    // skin and muscle: low uptake at rest
            },
            conditions: {
                // Temporoparietal hypometabolism. The angular split of the
                // phantom puts parietal cortex in the "temporal" and
                // "occipital" sectors, so those carry the deficit.
                ad: {
                    gm_temporal:  { mul: { K1: 0.85, k3: 0.6 } },
                    gm_occipital: { mul: { k3: 0.85 } },
                    gm_frontal:   { mul: { k3: 0.9 } }
                },
                pd: {}          // glucose metabolism about normal at this level
            }
        },
        PiB: {
            model: '2tcr',
            note: 'Binds fibrillar beta-amyloid. Cerebellar gray matter has almost no plaques and is the reference region (BPND = 0). White matter retains PiB nonspecifically, so it is bright even in a healthy brain.',
            regions: {
                // k4 = 0.15 /min is on the fast side of published fits; it
                // keeps the AD cortex SUVR at 50 to 70 min about 10 % above
                // the true DVR, the size of bias seen in practice.
                cortex:   { K1: 0.25, k2: 0.125, k4: 0.15, BPND: 0.15, vb: 0.04 },    // VND = 2
                caudate:  { K1: 0.24, k2: 0.125, k4: 0.15, BPND: 0.10, vb: 0.04 },
                putamen:  { K1: 0.24, k2: 0.125, k4: 0.15, BPND: 0.10, vb: 0.04 },
                thalamus: { K1: 0.24, k2: 0.125, k4: 0.15, BPND: 0.15, vb: 0.04 },
                cereb_gm: { K1: 0.25, k2: 0.125, k4: 0.15, BPND: 0, vb: 0.04 },       // reference region
                // Nonspecific white-matter retention: low delivery and slow
                // exchange with a slowly releasing pool (here k3 and k4 stand
                // for lipophilic retention in myelin, not plaques).
                wm:       { K1: 0.10, k2: 0.050, k4: 0.020, BPND: 0.6, vb: 0.02 },
                cereb_wm: { K1: 0.10, k2: 0.050, k4: 0.020, BPND: 0.6, vb: 0.02 },
                scalp:    { K1: 0.04, k2: 0.060, k4: 0.15, BPND: 0, vb: 0.02 }
            },
            conditions: {
                ad: {
                    gm_frontal:   { set: { BPND: 1.5 } },
                    gm_temporal:  { set: { BPND: 1.5 } },
                    gm_occipital: { set: { BPND: 0.8 } },
                    caudate:      { set: { BPND: 1.0 } },
                    putamen:      { set: { BPND: 1.0 } },
                    thalamus:     { set: { BPND: 0.4 } }
                },
                pd: {}
            }
        },
        florbetaben: {
            model: '2tcr',
            note: 'An 18F amyloid tracer: like PiB but slower, with more nonspecific binding and a smaller specific signal, so it is read late (90 to 110 min).',
            regions: {
                cortex:   { K1: 0.20, k2: 0.080, k4: 0.050, BPND: 0.10, vb: 0.04 },   // VND = 2.5
                caudate:  { K1: 0.19, k2: 0.080, k4: 0.050, BPND: 0.08, vb: 0.04 },
                putamen:  { K1: 0.19, k2: 0.080, k4: 0.050, BPND: 0.08, vb: 0.04 },
                thalamus: { K1: 0.19, k2: 0.080, k4: 0.050, BPND: 0.10, vb: 0.04 },
                cereb_gm: { K1: 0.20, k2: 0.080, k4: 0.050, BPND: 0, vb: 0.04 },
                wm:       { K1: 0.08, k2: 0.035, k4: 0.015, BPND: 0.9, vb: 0.02 },
                cereb_wm: { K1: 0.08, k2: 0.035, k4: 0.015, BPND: 0.9, vb: 0.02 },
                scalp:    { K1: 0.04, k2: 0.050, k4: 0.050, BPND: 0, vb: 0.02 }
            },
            conditions: {
                ad: {
                    gm_frontal:   { set: { BPND: 0.7 } },
                    gm_temporal:  { set: { BPND: 0.7 } },
                    gm_occipital: { set: { BPND: 0.4 } },
                    caudate:      { set: { BPND: 0.5 } },
                    putamen:      { set: { BPND: 0.5 } },
                    thalamus:     { set: { BPND: 0.3 } }
                },
                pd: {}
            }
        },
        PE2I: {
            model: '2tcr',
            note: 'Binds the dopamine transporter on the terminals of nigrostriatal neurons, so the striatum lights up. Cerebellar gray matter has almost no DAT and is the reference. Binding is slow to reach equilibrium.',
            regions: {
                // k4 = 0.05 /min: the putamen peaks at about 47 min, and its
                // SUVR passes through the true DVR near that peak.
                cortex:   { K1: 0.40, k2: 0.20, k4: 0.05, BPND: 0.1, vb: 0.04 },      // VND = 2
                caudate:  { K1: 0.42, k2: 0.20, k4: 0.05, BPND: 4.0, vb: 0.04 },
                putamen:  { K1: 0.42, k2: 0.20, k4: 0.05, BPND: 4.0, vb: 0.04 },
                thalamus: { K1: 0.40, k2: 0.20, k4: 0.05, BPND: 0.3, vb: 0.04 },
                cereb_gm: { K1: 0.40, k2: 0.20, k4: 0.05, BPND: 0, vb: 0.04 },        // reference region
                wm:       { K1: 0.20, k2: 0.14, k4: 0.05, BPND: 0, vb: 0.02 },
                cereb_wm: { K1: 0.20, k2: 0.14, k4: 0.05, BPND: 0, vb: 0.02 },
                scalp:    { K1: 0.05, k2: 0.08, k4: 0.05, BPND: 0, vb: 0.02 }
            },
            conditions: {
                ad: {},
                pd: DAT_LOSS()
            }
        },
        'FE-PE2I': {
            model: '2tcr',
            note: 'The fluorinated PE2I: the same target, a little less specific binding, and faster kinetics (larger k3 and k4), so the striatum reaches equilibrium sooner and a short static scan at 20 to 40 min works.',
            regions: {
                // k2 and k4 larger than for PE2I: the putamen peaks at about
                // 26 min, so a 20 to 40 min static scan sits at equilibrium.
                cortex:   { K1: 0.45, k2: 0.30, k4: 0.10, BPND: 0.1, vb: 0.04 },      // VND = 1.5
                caudate:  { K1: 0.47, k2: 0.30, k4: 0.10, BPND: 3.5, vb: 0.04 },
                putamen:  { K1: 0.47, k2: 0.30, k4: 0.10, BPND: 3.5, vb: 0.04 },
                thalamus: { K1: 0.45, k2: 0.30, k4: 0.10, BPND: 0.3, vb: 0.04 },
                cereb_gm: { K1: 0.45, k2: 0.30, k4: 0.10, BPND: 0, vb: 0.04 },        // reference region
                wm:       { K1: 0.22, k2: 0.20, k4: 0.10, BPND: 0, vb: 0.02 },
                cereb_wm: { K1: 0.22, k2: 0.20, k4: 0.10, BPND: 0, vb: 0.02 },
                scalp:    { K1: 0.05, k2: 0.08, k4: 0.10, BPND: 0, vb: 0.02 }
            },
            conditions: {
                ad: {},
                pd: DAT_LOSS()
            }
        },
        water: {
            model: '1tc',
            note: 'Freely diffusible: extraction is nearly complete, so K1 is the blood flow (mL/min/mL) and k2 = K1 / p, where p is the tissue to blood partition coefficient of water.',
            regions: {
                cortex:   { K1: 0.55, p: 0.90, vb: 0.04 },
                caudate:  { K1: 0.50, p: 0.90, vb: 0.04 },
                putamen:  { K1: 0.52, p: 0.90, vb: 0.04 },
                thalamus: { K1: 0.50, p: 0.90, vb: 0.04 },
                cereb_gm: { K1: 0.55, p: 0.90, vb: 0.04 },
                wm:       { K1: 0.22, p: 0.80, vb: 0.02 },
                cereb_wm: { K1: 0.22, p: 0.80, vb: 0.02 },
                scalp:    { K1: 0.08, p: 0.85, vb: 0.02 }
            },
            conditions: {
                ad: { gm_temporal: { mul: { K1: 0.8 } } },   // flow follows metabolism down
                pd: {}
            }
        }
    };

    /* Parkinson's disease on a DAT tracer: dopaminergic terminals are lost
       first in the posterior putamen, and on the side opposite the
       symptoms; here the patient's LEFT striatum (the image's right,
       positive x) is the worse one. Factors multiply BPND. */
    function DAT_LOSS() {
        return {
            putamen_l_post: { mul: { BPND: 0.20 } },
            putamen_l_ant:  { mul: { BPND: 0.45 } },
            putamen_r_post: { mul: { BPND: 0.40 } },
            putamen_r_ant:  { mul: { BPND: 0.70 } },
            caudate_l:      { mul: { BPND: 0.70 } },
            caudate_r:      { mul: { BPND: 0.85 } }
        };
    }

    /* Which row of the table a brain region uses. Regions not listed take
       up nothing. */
    const CLASS_OF = {
        gm_frontal: 'cortex', gm_temporal: 'cortex', gm_occipital: 'cortex',
        caudate_r: 'caudate', caudate_l: 'caudate',
        putamen_r_ant: 'putamen', putamen_r_post: 'putamen', putamen_l_ant: 'putamen', putamen_l_post: 'putamen',
        thalamus: 'thalamus', cereb_gm: 'cereb_gm', wm: 'wm', cereb_wm: 'cereb_wm', scalp: 'scalp',
        sinus: 'blood'
    };

    const CONDITIONS = [
        { id: 'normal', name: 'Normal', description: 'A healthy adult brain.' },
        { id: 'ad', name: "Alzheimer's disease",
            description: 'Amyloid plaques in frontal and temporal cortex (and less in occipital cortex and striatum), with temporoparietal hypometabolism and reduced temporal blood flow.' },
        { id: 'pd', name: "Parkinson's disease",
            description: "Loss of dopamine transporter in the striatum, worst in the posterior putamen and on the patient's left side (the image's right). Glucose metabolism, flow and amyloid about normal." }
    ];

    function tracerKey(id) {
        if (!id) return null;
        const k = PET.tracers.normalizeId(id);
        return k && TABLE[k] ? k : null;
    }

    function input(tracerId) {
        const k = tracerKey(tracerId);
        if (!k) throw new Error('No input function for tracer "' + tracerId + '".');
        const p = INPUTS[k];
        // peak time found numerically on a fine grid (s)
        let best = 0, tPeak = 0;
        for (let t = 0; t <= 300; t += 0.25) { const v = fengSUV(p, t); if (v > best) { best = v; tPeak = t; } }
        return {
            tracer: k,
            cp: function (t) { return fengSUV(p, t); },
            peakTime: tPeak, peak: best,
            delay: p.delay,
            coefficients: { A1: p.A1, A2: p.A2, A3: p.A3, l1: p.l1, l2: p.l2, l3: p.l3 },
            description: p.description
        };
    }

    function normCondition(c) { return c === 'ad' || c === 'pd' ? c : 'normal'; }

    /* Model of one region: { model, K1, k2, k3, k4, vb } (per minute), or
       null when the region takes up no tracer. The sinus is blood:
       { model: 'blood', vb: 1 }, whose tissue curve is the plasma. */
    function params(tracerId, regionId, condition) {
        const k = tracerKey(tracerId);
        if (!k) return null;
        const T = TABLE[k], cls = CLASS_OF[regionId];
        if (!cls) return null;
        if (cls === 'blood') return { model: 'blood', K1: 0, k2: 0, k3: 0, k4: 0, vb: 1 };
        const base = T.regions[regionId] || T.regions[cls];
        if (!base) return null;
        const p = Object.assign({}, base);
        const cond = T.conditions[normCondition(condition)] || {};
        const mod = cond[regionId] || cond[cls];
        if (mod) {
            if (mod.set) Object.keys(mod.set).forEach(function (key) { p[key] = mod.set[key]; });
            if (mod.mul) Object.keys(mod.mul).forEach(function (key) { p[key] = p[key] * mod.mul[key]; });
        }
        const m = { model: T.model, K1: p.K1, k2: 0, k3: 0, k4: 0, vb: p.vb || 0 };
        if (T.model === '1tc') {
            m.k2 = p.k2 !== undefined ? p.k2 : p.K1 / p.p;
        } else if (T.model === '2tci') {
            m.k2 = p.k2; m.k3 = p.k3; m.k4 = 0;
        } else {
            m.k2 = p.k2; m.k4 = p.k4;
            m.k3 = p.k3 !== undefined && p.BPND === undefined ? p.k3 : p.BPND * p.k4;
        }
        return m;
    }

    /* Derived macroparameters. VND = K1/k2 (free plus nonspecific
       distribution volume), BPND = k3/k4, VT = VND (1 + BPND), DVR = 1 +
       BPND (the ratio of VT to a reference region with the same VND),
       Ki = K1 k3 / (k2 + k3) (net influx of an irreversible tracer, per mL
       of tissue), flow = K1 for a freely diffusible tracer.
       KiVoxel = (1 - vb) Ki is the influx per mL of VOXEL, which is what a
       Patlak plot of image data recovers: the blood that fills a fraction
       vb of the voxel traps nothing. */
    function derived(m) {
        if (!m) return {};
        if (m.model === 'blood') return { blood: true };
        const out = {};
        if (m.k2 > 0) out.VND = m.K1 / m.k2;
        if (m.model === '1tc') {
            out.VT = out.VND;
            out.flow = m.K1;
        } else if (m.model === '2tci' || !(m.k4 > 0)) {
            out.Ki = m.K1 * m.k3 / (m.k2 + m.k3);
            out.KiVoxel = (1 - (m.vb || 0)) * out.Ki;
        } else {
            out.BPND = m.k3 / m.k4;
            out.VT = out.VND * (1 + out.BPND);
            out.DVR = 1 + out.BPND;
        }
        return out;
    }

    /* ---------- exact convolution ----------
       Every model's impulse response is a sum of exponentials
       a_i exp(-b_i t). For an input that is piecewise linear between grid
       points, the convolution with one exponential obeys an exact
       recursion over each step h (no discretisation error beyond the
       linear interpolation of the input itself):
           y[n+1] = e^(-bh) y[n] + w0 cp[n] + w1 cp[n+1]
           w0 = (1 - e^(-bh)(1 + bh)) / (b^2 h),   w1 = (1 - e^(-bh)) / b - w0
       With b = 0 (the trapped compartment of FDG) w0 = w1 = h/2, the
       trapezoid rule, which is exact for a linear input. Small bh uses
       the series to avoid cancellation. h and b are in minutes here. */
    function convExp(cp, b, hMin) {
        const n = cp.length, y = new Float64Array(n);
        const z = b * hMin;
        let E, w0, w1;
        if (z < 1e-4) {
            E = 1 - z + z * z / 2;
            w0 = hMin * (0.5 - z / 3 + z * z / 8);
            w1 = hMin * (0.5 - z / 6 + z * z / 24);
        } else {
            E = Math.exp(-z);
            w0 = (1 - E * (1 + z)) / (b * z);
            w1 = (1 - E) / b - w0;
        }
        for (let i = 1; i < n; i++) y[i] = E * y[i - 1] + w0 * cp[i - 1] + w1 * cp[i];
        return y;
    }

    /* Tissue response of a model to an input sampled on a uniform grid
       tGrid (s). The tissue is taken to be empty at tGrid[0].
       1TC:  C1 = K1 e^(-k2 t) * Cp.
       2TC:  the rates of the two exponentials are the eigenvalues
             a1, a2 = ((k2+k3+k4) -/+ sqrt((k2+k3+k4)^2 - 4 k2 k4)) / 2 and
             C1 = K1/(a2-a1) [ (k4-a1) e^(-a1 t) + (a2-k4) e^(-a2 t) ] * Cp
             C2 = K1 k3/(a2-a1) [ e^(-a1 t) - e^(-a2 t) ] * Cp.
             For the irreversible model k4 = 0, so a1 = 0 (nothing leaves
             C2) and a2 = k2 + k3.
       ct = (1 - vb)(C1 + C2) + vb Cp is what a voxel holds. */
    function tissue(m, cp, tGrid) {
        const n = tGrid.length;
        const h = n > 1 ? (tGrid[1] - tGrid[0]) / 60 : 1;
        let cpa;
        if (typeof cp === 'function') { cpa = new Float64Array(n); for (let i = 0; i < n; i++) cpa[i] = cp(tGrid[i]); }
        else cpa = cp instanceof Float64Array ? cp : Float64Array.from(cp);
        const c1 = new Float64Array(n), c2 = new Float64Array(n), ct = new Float64Array(n);
        if (!m) return { ct: ct, c1: c1, c2: c2, cp: cpa };
        const vb = m.vb || 0;
        if (m.model === 'blood') {
            for (let i = 0; i < n; i++) ct[i] = cpa[i];
            return { ct: ct, c1: c1, c2: c2, cp: cpa };
        }
        const K1 = m.K1, k2 = m.k2, k3 = m.model === '1tc' ? 0 : (m.k3 || 0), k4 = m.model === '2tci' ? 0 : (m.k4 || 0);
        if (k3 === 0) {
            const e = convExp(cpa, k2, h);
            for (let i = 0; i < n; i++) c1[i] = K1 * e[i];
        } else {
            const s = k2 + k3 + k4, disc = Math.sqrt(Math.max(0, s * s - 4 * k2 * k4));
            const a1 = (s - disc) / 2, a2 = (s + disc) / 2, d = a2 - a1;
            const e1 = convExp(cpa, a1, h), e2 = convExp(cpa, a2, h);
            for (let i = 0; i < n; i++) {
                c1[i] = K1 / d * ((k4 - a1) * e1[i] + (a2 - k4) * e2[i]);
                c2[i] = K1 * k3 / d * (e1[i] - e2[i]);
            }
        }
        for (let i = 0; i < n; i++) ct[i] = (1 - vb) * (c1[i] + c2[i]) + vb * cpa[i];
        return { ct: ct, c1: c1, c2: c2, cp: cpa };
    }

    /* ---------- regional TACs of a phantom for a protocol ---------- */
    function regionTACs(phantom, program, opts) {
        opts = opts || {};
        const dt = opts.dt > 0 ? opts.dt : 2;
        let tEnd = Math.max(60, program.scanEnd || 0);
        (program.frames || []).forEach(function (f) { if (f.t1 > tEnd) tEnd = f.t1; });
        const nT = Math.ceil(tEnd / dt - 1e-9) + 1;
        const t = new Float64Array(nT);
        for (let i = 0; i < nT; i++) t[i] = i * dt;
        const dose = program.dose || 0, weight = program.weight || 70;
        const suvScale = dose / (weight * 1000);
        const nReg = phantom.regions.length;
        const regions = [], plasma = new Float64Array(nT);
        const out = {
            t: t, dt: dt, plasma: plasma, suvScale: suvScale, regions: regions,
            kind: phantom.kind, tracer: null, isotope: program.isotope || null,
            condition: null, dose: dose, weight: weight,
            models: []                         // the Model used for each region (null if none)
        };

        if (phantom.kind !== 'brain') {
            // A phantom filled with a solution of the isotope: the activity
            // mixes instantly and stays put, so each compartment's
            // concentration is the dose shared out by relative concentration
            // and volume.
            let denom = 0;
            phantom.regions.forEach(function (r) { if (r.rel > 0) denom += r.rel * r.volume; });
            phantom.regions.forEach(function (r) {
                const c = new Float64Array(nT);
                if (r.rel > 0 && denom > 0) c.fill(dose * r.rel / denom);
                regions.push(c); out.models.push(null);
            });
            return out;
        }

        const tracer = program.tracer && String(program.tracer).toLowerCase() !== 'none' ? tracerKey(program.tracer) : null;
        if (!tracer) {
            throw new Error(program.tracer && String(program.tracer).toLowerCase() !== 'none'
                ? 'The brain phantom has no kinetic model for the tracer "' + program.tracer + '". Use FDG, PiB, florbetaben, PE2I, FE-PE2I or water.'
                : 'The brain phantom needs a tracer: add a tracer line such as tracer FDG');
        }
        const condition = normCondition(opts.condition || phantom.condition);
        out.tracer = tracer; out.condition = condition;
        const inp = input(tracer);
        const cpSUV = new Float64Array(nT);
        for (let i = 0; i < nT; i++) { cpSUV[i] = inp.cp(t[i]); plasma[i] = cpSUV[i] * suvScale; }
        for (let r = 0; r < nReg; r++) {
            const reg = phantom.regions[r];
            const m = reg.tissue === 'blood' ? { model: 'blood', K1: 0, k2: 0, k3: 0, k4: 0, vb: 1 } : params(tracer, reg.id, condition);
            out.models.push(m);
            const c = new Float64Array(nT);
            if (m) {
                const res = tissue(m, cpSUV, t);
                for (let i = 0; i < nT; i++) c[i] = res.ct[i] * suvScale;
            }
            regions.push(c);
        }
        return out;
    }

    /* Integral of a piecewise-linear curve (samples y on the uniform grid
       t0 + i dt) times a weight w(t), from a to b, by the trapezoid rule
       on the grid plus the two partial end intervals. Outside the grid
       the curve is held at its end values. */
    function integrate(y, t0, dt, a, b, w) {
        const n = y.length;
        if (!(b > a)) return 0;
        const val = function (tt) {
            const f = (tt - t0) / dt;
            if (f <= 0) return y[0];
            if (f >= n - 1) return y[n - 1];
            const i = Math.floor(f), g = f - i;
            return y[i] * (1 - g) + y[i + 1] * g;
        };
        let s = 0, prevT = a, prevV = val(a) * w(a);
        const iStart = Math.max(0, Math.floor((a - t0) / dt) + 1);
        for (let i = iStart; i < n; i++) {
            const ti = t0 + i * dt;
            if (ti >= b) break;
            const v = y[i] * w(ti);
            s += (ti - prevT) * (v + prevV) / 2;
            prevT = ti; prevV = v;
        }
        const vb = val(b) * w(b);
        s += (b - prevT) * (vb + prevV) / 2;
        return s;
    }

    /* Frame averages of every region's curve. By default the average is
       weighted by radioactive decay, exp(-lambda t), which is exactly what
       a decay-corrected reconstruction of the frame measures: the counts
       come in as the integral of C(t) exp(-lambda t) and the scanner
       multiplies by duration / integral of exp(-lambda t). Frames that
       start before injection count no activity for that part.
       opts.decayWeighted = false gives the plain time average. */
    function frameMeans(tacs, frames, opts) {
        opts = opts || {};
        let lam = 0;
        if (opts.decayWeighted !== false && tacs.isotope) {
            try { lam = PET.isotopes.lambda(PET.isotopes.get(tacs.isotope)); } catch (e) { lam = 0; }
        }
        const w = lam > 0 ? function (tt) { return Math.exp(-lam * tt); } : function () { return 1; };
        const t0g = tacs.t[0], dt = tacs.dt;
        return frames.map(function (f) {
            const out = new Float64Array(tacs.regions.length);
            const a = Math.max(0, f.t0), b = f.t1;
            if (!(b > f.t0)) return out;
            const den = lam > 0 ? PET.isotopes.decayIntegral(tacs.isotope, f.t0, f.t1) : (f.t1 - f.t0);
            if (b <= a) return out;
            for (let r = 0; r < tacs.regions.length; r++) out[r] = integrate(tacs.regions[r], t0g, dt, a, b, w) / den;
            return out;
        });
    }
    /* The same for the plasma curve (Bq/mL), handy for Patlak. */
    function framePlasma(tacs, frames, opts) {
        const tmp = { t: tacs.t, dt: tacs.dt, isotope: tacs.isotope, regions: [tacs.plasma] };
        return Float64Array.from(frameMeans(tmp, frames, opts).map(function (v) { return v[0]; }));
    }

    /* ---------- graphical analysis ---------- */
    function linfit(x, y, from) {
        let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
        for (let i = from; i < x.length; i++) {
            n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; syy += y[i] * y[i];
        }
        if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN, n: n };
        const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
        const slope = vx > 0 ? cxy / vx : NaN, intercept = (sy - slope * sx) / n;
        const r2 = vx > 0 && vy > 0 ? cxy * cxy / (vx * vy) : 1;
        return { slope: slope, intercept: intercept, r2: r2, n: n };
    }

    /* Running trapezoid integral (value x minutes) on the points (t[i] s,
       v[i]), starting from (0, 0). */
    function cumTrapz(t, v) {
        const out = new Float64Array(t.length);
        let s = 0, pt = 0, pv = 0;
        for (let i = 0; i < t.length; i++) {
            s += (t[i] - pt) / 60 * (v[i] + pv) / 2;
            out[i] = s; pt = t[i]; pv = v[i];
        }
        return out;
    }

    /* Patlak plot for an irreversible tracer: y = Ct/Cp against
       x = integral of Cp / Cp (minutes, "normalised time"). Once the free
       compartment has equilibrated with plasma the points fall on a line
       whose slope is Ki (1/min) and whose intercept V0 is the free
       distribution volume plus blood. Fitted for frame mid-times >= tStar
       (s, default 20 min). x, y, t list the plotted points (frames where
       Cp is still zero are skipped); fitFrom is the index of the first
       fitted point. */
    function patlak(t, ct, cp, tStar) {
        if (tStar === undefined || tStar === null) tStar = 1200;
        const I = cumTrapz(t, cp);
        let peak = 0; for (let i = 0; i < cp.length; i++) if (cp[i] > peak) peak = cp[i];
        const x = [], y = [], tp = [];
        for (let i = 0; i < t.length; i++) {
            if (!(cp[i] > 1e-6 * peak)) continue;
            x.push(I[i] / cp[i]); y.push(ct[i] / cp[i]); tp.push(t[i]);
        }
        let fitFrom = tp.findIndex(function (v) { return v >= tStar; });
        if (fitFrom < 0) fitFrom = tp.length;
        const f = linfit(x, y, fitFrom);
        return { Ki: f.slope, V0: f.intercept, x: x, y: y, t: tp, fitFrom: fitFrom, r2: f.r2, nFit: f.n };
    }

    /* Logan plot with a reference region (Logan et al., J Cereb Blood Flow
       Metab 1996): y = integral of Ct / Ct against
       x = (integral of Cref + Cref / k2') / Ct, both in minutes. After t*
       the plot is linear with slope DVR = VT / VT(reference), so
       BPND = DVR - 1, without any blood sampling. k2' is the reference
       region's efflux rate (1/min); leaving it out drops the term, a
       common approximation that biases DVR a little. */
    function logan(t, ct, cref, k2ref, tStar) {
        if (tStar === undefined || tStar === null) tStar = 1800;
        const It = cumTrapz(t, ct), Ir = cumTrapz(t, cref);
        let peak = 0; for (let i = 0; i < ct.length; i++) if (ct[i] > peak) peak = ct[i];
        const x = [], y = [], tp = [];
        for (let i = 0; i < t.length; i++) {
            if (!(ct[i] > 1e-6 * peak)) continue;
            x.push((Ir[i] + (k2ref > 0 ? cref[i] / k2ref : 0)) / ct[i]);
            y.push(It[i] / ct[i]); tp.push(t[i]);
        }
        let fitFrom = tp.findIndex(function (v) { return v >= tStar; });
        if (fitFrom < 0) fitFrom = tp.length;
        const f = linfit(x, y, fitFrom);
        return { DVR: f.slope, BPND: f.slope - 1, intercept: f.intercept, x: x, y: y, t: tp, fitFrom: fitFrom, r2: f.r2, nFit: f.n };
    }

    /* ---------- SUV and SUVR ----------
       SUV = concentration / (dose / body weight), with tissue density
       1 g/mL. Both accept a number or an array. */
    function mapOrScalar(a, f) {
        if (typeof a === 'number') return f(a, 0);
        const out = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = f(a[i], i);
        return out;
    }
    function suv(conc, doseBq, weightKg) {
        const s = (weightKg || 70) * 1000 / doseBq;
        return mapOrScalar(conc, function (v) { return v * s; });
    }
    function suvr(target, reference) {
        if (typeof target === 'number') return reference > 0 ? target / reference : NaN;
        return mapOrScalar(target, function (v, i) {
            const r = typeof reference === 'number' ? reference : reference[i];
            return r > 0 ? v / r : 0;
        });
    }
    /* SUVR(t) = C_target(t) / C_reference(t) on the TAC grid. For a
       reversible tracer it rises through the true DVR and keeps rising
       while the plasma falls (transient equilibrium), which is why a
       late static SUVR overestimates the binding. 0 where the
       reference is still empty. */
    function ratioCurve(tacs, targetIndex, refIndex) {
        const a = tacs.regions[targetIndex], b = tacs.regions[refIndex], out = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = b[i] > 0 ? a[i] / b[i] : 0;
        return out;
    }
    /* SUVR over a time window [t0, t1] (s): the ratio of the two regions'
       decay-weighted means, as a static scan over that window gives. */
    function windowRatio(tacs, targetIndex, refIndex, t0, t1) {
        const m = frameMeans(tacs, [{ t0: t0, t1: t1 }])[0];
        return m[refIndex] > 0 ? m[targetIndex] / m[refIndex] : NaN;
    }

    /* Flattened, readable parameter table for the UI: one row per region
       class (and per region where a condition changes it). */
    function tableRows(tracerId, condition) {
        const k = tracerKey(tracerId);
        if (!k) return [];
        const T = TABLE[k], cond = normCondition(condition);
        const ids = Object.keys(CLASS_OF).filter(function (id) { return id !== 'sinus'; });
        return ids.map(function (id) {
            const m = params(k, id, cond);
            return Object.assign({ region: id, cls: CLASS_OF[id] }, m, derived(m));
        }).concat([{ region: 'sinus', cls: 'blood', model: 'blood', note: 'plasma curve (plasma = whole blood)' }]).map(function (r) { r.tracer = k; r.tracerModel = T.model; return r; });
    }

    PET.kinetics = {
        input: input, params: params, tissue: tissue, derived: derived,
        regionTACs: regionTACs, frameMeans: frameMeans, framePlasma: framePlasma,
        patlak: patlak, logan: logan, suv: suv, suvr: suvr,
        ratioCurve: ratioCurve, windowRatio: windowRatio,
        table: TABLE, inputs: INPUTS, regionClass: CLASS_OF, tableRows: tableRows,
        conditions: CONDITIONS,
        convExp: convExp            // exposed for tests
    };

})(typeof window !== 'undefined' ? window : globalThis);
