/* ============================================================
   MRI Simulator, tissue and metabolite library (3 T)

   Every phantom is a map of labels, and every label points at one
   of the tissues below. A tissue carries what the scanner needs to
   know about it: how many protons it has (proton density), how fast
   they relax (T1, T2, T2*), whether they resonate at the water or the
   fat frequency, whether the tissue moves (blood) or takes up
   gadolinium, and, for the spectroscopy tab, what molecules the
   protons belong to.

   The values are round teaching numbers for 3 T taken from the
   literature (Stanisz 2005, Wansapura 1999, Bojorquez 2017 and the
   usual MRS references). Real tissue varies by 10 to 20 percent from
   person to person, so do not read the third digit.

   Units: seconds for relaxation times, ppm for chemical shift, mM
   for metabolite concentrations. See ARCHITECTURE.md section 5.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;

    /* Gadolinium relaxivities at 3 T, per mM per second. A typical
       gadolinium chelate shortens T1 and T2 by adding to the relaxation
       rate in proportion to its concentration:  1/T1' = 1/T1 + r1 C.
       T2* is shortened by the r2 term as well. */
    const R1_GD = 4;
    const R2_GD = 5;

    /* Pure water is 55.5 mol/L and each molecule has two protons, so
       the water proton concentration of pure water is 111 M. A tissue
       with proton density pd and water fraction w has 111 * pd * w M
       of water protons. Metabolites are a few mM, which is why they
       are about ten thousand times smaller than water in a spectrum. */
    const WATER_MOLAR = 55.5;
    const WATER_PROTON_MOLAR = 2 * WATER_MOLAR;

    /* Fat spectrum. A triglyceride has protons in several chemical
       groups; at 3 T the methylene (CH2)n peak at 1.3 ppm dominates and
       is the "fat" peak 3.4 ppm (about 434 Hz) below water that causes
       the chemical-shift artifact. The fractions are of all lipid
       protons and sum to 1. */
    const lipidLines = [
        { ppm: 0.90, frac: 0.09 },   // terminal methyl  -CH3
        { ppm: 1.30, frac: 0.60 },   // methylene  -(CH2)n-   (the main fat peak)
        { ppm: 1.59, frac: 0.06 },   // beta-carboxyl  -CO-CH2-CH2-
        { ppm: 2.02, frac: 0.08 },   // allylic  -CH2-CH=CH-
        { ppm: 2.24, frac: 0.06 },   // alpha-carboxyl  -CO-CH2-
        { ppm: 2.75, frac: 0.02 },   // diallylic  =CH-CH2-CH=
        { ppm: 4.20, frac: 0.04 },   // glycerol  -CH2-O-
        { ppm: 5.30, frac: 0.05 }    // olefinic  -CH=CH-
    ];
    const LIPID_T1 = 0.38;
    const LIPID_T2 = 0.07;

    /* Brain metabolites. Each line is one chemically distinct group of
       protons: ppm is its shift, nH how many protons the group holds
       (a methyl group has three), so the area of a line is
       concentration times nH. Lactate's methyl is split into a doublet
       by J coupling to its single methine proton, which in turn is
       split into a quartet. Coupling in the other metabolites is
       ignored (each multiplet is drawn as one line), which is the
       honest simplification of this model. */
    const metabolites = {
        NAA: { id: 'NAA', name: 'N-acetylaspartate', color: '#e4572e', t1: 1.40, t2: 0.25,
            lines: [{ ppm: 2.008, nH: 3 }, { ppm: 2.49, nH: 1 }, { ppm: 2.67, nH: 1 }, { ppm: 4.38, nH: 1 }] },
        Cr: { id: 'Cr', name: 'Creatine + phosphocreatine', color: '#2e86de', t1: 1.30, t2: 0.15,
            lines: [{ ppm: 3.027, nH: 3 }, { ppm: 3.913, nH: 2 }] },
        Cho: { id: 'Cho', name: 'Choline compounds', color: '#17a589', t1: 1.20, t2: 0.22,
            lines: [{ ppm: 3.20, nH: 9 }] },
        mI: { id: 'mI', name: 'myo-Inositol', color: '#a569bd', t1: 1.10, t2: 0.20,
            lines: [{ ppm: 3.52, nH: 2 }, { ppm: 3.61, nH: 2 }, { ppm: 4.05, nH: 1 }, { ppm: 3.27, nH: 1 }] },
        Glu: { id: 'Glu', name: 'Glutamate', color: '#d4ac0d', t1: 1.20, t2: 0.18,
            lines: [{ ppm: 2.04, nH: 1 }, { ppm: 2.12, nH: 1 }, { ppm: 2.34, nH: 2 }, { ppm: 3.74, nH: 1 }] },
        Gln: { id: 'Gln', name: 'Glutamine', color: '#ca6f1e', t1: 1.20, t2: 0.18,
            lines: [{ ppm: 2.11, nH: 2 }, { ppm: 2.44, nH: 2 }, { ppm: 3.76, nH: 1 }] },
        Lac: { id: 'Lac', name: 'Lactate', color: '#c0392b', t1: 1.50, t2: 0.24,
            lines: [{ ppm: 1.31, nH: 3, J: 6.93, mult: 'd' }, { ppm: 4.10, nH: 1, J: 6.93, mult: 'q' }] }
    };

    /* Spectral content of a tissue, as fractions of its proton density
       plus metabolite concentrations in mM. */
    function spec(water, lipid, mets) {
        return { water: water, lipid: lipid, metabolites: mets || {} };
    }

    /* One tissue entry. t2s is clamped to t2: T2* includes T2 decay plus
       dephasing from field inhomogeneity, so it can never be longer. */
    function tissue(id, name, color, pd, t1, t2, t2s, cs, flags, spectrum) {
        return {
            id: id, name: name, color: color,
            pd: pd, t1: t1, t2: t2, t2s: Math.min(t2s, t2), cs: cs,
            pulsatile: !!(flags && flags.pulsatile),
            enhances: !!(flags && flags.enhances),
            spectrum: spectrum
        };
    }

    const FAT_PPM = -3.4;
    const library = {};
    function add(t) { library[t.id] = t; }

    /* Brain and head. Grey matter has more water than white matter
       (higher PD) and longer T1 and T2, which is why GM is darker than
       WM on T1-weighted and brighter on T2-weighted images. CSF is
       almost pure water with very long T1 and T2. Fat and marrow have
       short T1 (bright on T1-weighted). Cortical bone holds almost no
       mobile protons and its T2 is well under a millisecond, so it is
       black on every conventional sequence. */
    add(tissue('air', 'Air', '#000000', 0, 1, 0.001, 0.001, 0, null, spec(0, 0)));
    add(tissue('wm', 'White matter', '#ece3cb', 0.70, 0.85, 0.075, 0.050, 0, null,
        spec(1, 0, { NAA: 9, Cr: 6, Cho: 2.0, mI: 5, Glu: 7, Gln: 2, Lac: 0.4 })));
    add(tissue('gm', 'Grey matter', '#a3796b', 0.80, 1.35, 0.095, 0.060, 0, null,
        spec(1, 0, { NAA: 11, Cr: 8.5, Cho: 1.5, mI: 6, Glu: 10, Gln: 3, Lac: 0.5 })));
    add(tissue('csf', 'CSF', '#3a7bd5', 1.00, 4.0, 1.8, 0.40, 0, null, spec(1, 0)));
    add(tissue('fat', 'Fat (scalp, orbit)', '#f2c94c', 0.90, 0.38, 0.068, 0.035, FAT_PPM, null, spec(0, 1)));
    add(tissue('marrow', 'Skull marrow (diploë)', '#e08e45', 0.80, 0.42, 0.060, 0.020, FAT_PPM, null, spec(0.2, 0.8)));
    add(tissue('bone', 'Cortical bone', '#6f6a60', 0.05, 0.25, 0.0006, 0.0004, 0, null, spec(1, 0)));
    add(tissue('muscle', 'Muscle', '#b4473e', 0.75, 1.40, 0.032, 0.025, 0, null,
        spec(1, 0, { Cr: 25, Cho: 2 })));
    add(tissue('vessel', 'Blood (sinus, arteries)', '#d81b60', 0.85, 1.65, 0.10, 0.040, 0,
        { pulsatile: true, enhances: true }, spec(1, 0)));
    add(tissue('lesion', 'Lesion (demyelination/tumour)', '#3cb44b', 0.85, 1.60, 0.18, 0.10, 0,
        { enhances: true }, spec(1, 0, { NAA: 4, Cr: 5, Cho: 4, mI: 6, Lac: 5 })));

    /* Test objects. "Doped" water has a paramagnetic salt added so that
       T1 is about a second instead of three, which makes phantom scans
       quicker and the contrast more brain-like. */
    add(tissue('water', 'Doped water', '#64a9e6', 1.00, 1.00, 0.25, 0.15, 0, null, spec(1, 0)));
    add(tissue('oil', 'Vegetable oil', '#e3b021', 0.90, 0.28, 0.080, 0.040, FAT_PPM, null, spec(0, 1)));
    add(tissue('braino', 'MRS phantom solution', '#6cc4a9', 1.00, 1.50, 0.30, 0.15, 0, null,
        spec(1, 0, { NAA: 12.5, Cr: 10, Cho: 3, mI: 7.5, Glu: 12.5, Lac: 5 })));

    /* Relaxometry vials: T1 and T2 both rise along the series, covering
       everything from strongly doped water to nearly pure water. T2* is
       taken as 0.6 T2 (a well-shimmed small vial). Colours run along a
       viridis ramp so the label map reads as an ordered series. */
    const VIALS = [
        [0.20, 0.020], [0.30, 0.040], [0.45, 0.060], [0.60, 0.080],
        [0.80, 0.100], [1.00, 0.150], [1.30, 0.200], [1.60, 0.300],
        [2.00, 0.400], [2.50, 0.600], [3.00, 1.00], [4.00, 2.00]
    ];
    function hex2(v) { const s = Math.round(v).toString(16); return s.length < 2 ? '0' + s : s; }
    VIALS.forEach(function (tv, i) {
        const id = 'vial' + (i < 9 ? '0' : '') + (i + 1);
        const c = MRI.util.colormaps.viridis(0.08 + 0.92 * i / (VIALS.length - 1));
        const color = '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
        const name = 'Vial ' + (i + 1) + ' (T1 ' + Math.round(tv[0] * 1000) + ' ms, T2 ' + Math.round(tv[1] * 1000) + ' ms)';
        add(tissue(id, name, color, 1.00, tv[0], tv[1], 0.6 * tv[1], 0, null, spec(1, 0)));
    });

    /* Deep copy, so callers can change a tissue without touching the
       library (phantom overrides rely on this). */
    function copyTissue(t) {
        const out = Object.assign({}, t);
        out.spectrum = {
            water: t.spectrum.water,
            lipid: t.spectrum.lipid,
            metabolites: Object.assign({}, t.spectrum.metabolites)
        };
        return out;
    }

    function get(id) {
        const t = library[id];
        if (!t) throw new Error('Unknown tissue "' + id + '"');
        return copyTissue(t);
    }

    /* Gadolinium: rates add. Only tissues whose blood-brain barrier is
       open (lesion) or that are blood (vessel) take it up; everything
       else is returned unchanged (as a copy). conc is in mM. */
    function withGad(t, conc) {
        const out = copyTissue(t);
        if (!t.enhances || !(conc > 0)) return out;
        out.t1 = 1 / (1 / t.t1 + R1_GD * conc);
        out.t2 = 1 / (1 / t.t2 + R2_GD * conc);
        out.t2s = Math.min(out.t2, 1 / (1 / t.t2s + R2_GD * conc));
        return out;
    }

    /* Water proton concentration of a tissue in mol/L (for the
       spectroscopy simulator, which puts water and metabolites on the
       same footing). */
    function waterProtons(t) { return WATER_PROTON_MOLAR * t.pd * t.spectrum.water; }

    MRI.tissues = {
        library: library,
        get: get,
        withGad: withGad,
        metabolites: metabolites,
        lipidLines: lipidLines,
        lipid: { t1: LIPID_T1, t2: LIPID_T2, lines: lipidLines },
        gadolinium: { r1: R1_GD, r2: R2_GD },
        WATER_MOLAR: WATER_MOLAR,
        WATER_PROTON_MOLAR: WATER_PROTON_MOLAR,
        waterProtons: waterProtons
    };

})(typeof window !== 'undefined' ? window : globalThis);
