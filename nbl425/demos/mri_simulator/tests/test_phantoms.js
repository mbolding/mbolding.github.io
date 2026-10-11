/* Tests for tissues.js, phantoms.js and fields.js.
     node tests/test_phantoms.js */
'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core', 'tissues', 'phantoms', 'fields']);
const T = MRI.tissues, PH = MRI.phantoms, F = MRI.fields;

/* ---------- helpers ---------- */
function areas(ph) {                         // area of each tissue in mm^2
    const c = new Array(ph.tissues.length).fill(0);
    for (let i = 0; i < ph.label.length; i++) c[ph.label[i]]++;
    return c.map(v => v * ph.dx * ph.dx * 1e6);
}
function idx(ph, id) { return ph.tissues.findIndex(t => t.id === id); }
function labelAt(ph, x, y) {                 // x, y in metres, section 3 convention
    const h = Math.floor(ph.n / 2);
    const ix = Math.round(x / ph.dx) + h, iy = Math.round(y / ph.dx) + h;
    return ph.label[iy * ph.n + ix];
}
function tissueAt(ph, x, y) { return ph.tissues[labelAt(ph, x, y)].id; }
function landmark(ph, prefix) { return ph.landmarks.find(L => L.name.indexOf(prefix) === 0); }

/* ---------- tissue library ---------- */
{
    const table = {   // id: [pd, t1, t2, t2s, cs]  (ARCHITECTURE.md section 5)
        air: [0, 1, 0.001, 0.001, 0], wm: [0.70, 0.85, 0.075, 0.050, 0], gm: [0.80, 1.35, 0.095, 0.060, 0],
        csf: [1.00, 4.0, 1.8, 0.40, 0], fat: [0.90, 0.38, 0.068, 0.035, -3.4], marrow: [0.80, 0.42, 0.060, 0.020, -3.4],
        bone: [0.05, 0.25, 0.0006, 0.0004, 0], muscle: [0.75, 1.40, 0.032, 0.025, 0], vessel: [0.85, 1.65, 0.10, 0.040, 0],
        lesion: [0.85, 1.60, 0.18, 0.10, 0], water: [1.00, 1.00, 0.25, 0.15, 0], oil: [0.90, 0.28, 0.080, 0.040, -3.4],
        braino: [1.00, 1.50, 0.30, 0.15, 0], deepgm: [0.78, 1.15, 0.075, 0.045, 0]
    };
    for (const id in table) {
        const t = T.get(id), v = table[id];
        ok(t.pd === v[0] && t.t1 === v[1] && t.t2 === v[2] && t.t2s === v[3] && t.cs === v[4], 'tissue table values for ' + id);
        ok(/^#[0-9a-f]{6}$/i.test(t.color), 'tissue colour is a CSS hex for ' + id);
    }
    const vials = [[0.20, 0.020], [0.30, 0.040], [0.45, 0.060], [0.60, 0.080], [0.80, 0.100], [1.00, 0.150],
        [1.30, 0.200], [1.60, 0.300], [2.00, 0.400], [2.50, 0.600], [3.00, 1.00], [4.00, 2.00]];
    vials.forEach((v, i) => {
        const t = T.get('vial' + String(i + 1).padStart(2, '0'));
        ok(t.t1 === v[0] && t.t2 === v[1] && Math.abs(t.t2s - 0.6 * v[1]) < 1e-12 && t.pd === 1, 'vial ' + (i + 1) + ' values');
    });
    for (const id in T.library) {
        const t = T.library[id];
        ok(t.t2s <= t.t2, 't2s <= t2 for ' + id);
        ok(Math.abs(t.spectrum.water + t.spectrum.lipid - (id === 'air' ? 0 : 1)) < 1e-12, 'water + lipid fractions = 1 for ' + id);
    }
    ok(T.library.vessel.pulsatile && T.library.vessel.enhances && T.library.lesion.enhances, 'vessel pulsatile and enhancing, lesion enhancing');
    ok(!T.library.wm.enhances && !T.library.gm.enhances && !T.library.deepgm.enhances && !T.library.csf.enhances && !T.library.wm.pulsatile, 'brain tissue does not enhance');
    ok(T.library.deepgm.t1 > T.library.wm.t1 && T.library.deepgm.t1 < T.library.gm.t1, 'deep grey matter T1 lies between white matter and cortex');
    ok(JSON.stringify(T.library.deepgm.spectrum) === JSON.stringify(T.library.gm.spectrum), 'deep grey matter has the metabolites of grey matter');
    ok(T.library.marrow.spectrum.lipid === 0.8 && T.library.marrow.spectrum.water === 0.2, 'marrow is 80 percent lipid');
    const wm = T.library.wm.spectrum.metabolites;
    ok(wm.NAA === 9 && wm.Cr === 6 && wm.Cho === 2 && wm.mI === 5 && wm.Glu === 7 && wm.Gln === 2 && wm.Lac === 0.4, 'WM metabolites');
    const les = T.library.lesion.spectrum.metabolites;
    ok(les.NAA === 4 && les.Cr === 5 && les.Cho === 4 && les.mI === 6 && les.Lac === 5, 'lesion metabolites');
    ok(T.library.muscle.spectrum.metabolites.Cr === 25, 'muscle creatine');
    const br = T.library.braino.spectrum.metabolites;
    ok(br.NAA === 12.5 && br.Cr === 10 && br.Cho === 3 && br.mI === 7.5 && br.Glu === 12.5 && br.Lac === 5, 'braino metabolites');

    // get() returns a deep copy
    const g = T.get('wm'); g.t1 = 99; g.spectrum.metabolites.NAA = 0;
    ok(T.library.wm.t1 === 0.85 && T.library.wm.spectrum.metabolites.NAA === 9, 'get() returns a deep copy');
    let threw = false; try { T.get('nope'); } catch (e) { threw = true; }
    ok(threw, 'get() of an unknown tissue throws');

    // metabolites and lipids
    const M = T.metabolites;
    ok(['NAA', 'Cr', 'Cho', 'mI', 'Glu', 'Gln', 'Lac'].every(k => M[k] && M[k].id === k && M[k].lines.length), 'all metabolites present');
    ok(M.NAA.lines[0].ppm === 2.008 && M.NAA.lines[0].nH === 3, 'NAA singlet at 2.008 ppm, 3 H');
    ok(M.Cho.lines.length === 1 && M.Cho.lines[0].nH === 9, 'choline 9 H');
    ok(M.Lac.lines[0].mult === 'd' && M.Lac.lines[0].J === 6.93 && M.Lac.lines[1].mult === 'q', 'lactate doublet and quartet');
    ok(M.Cr.t1 === 1.30 && M.Cr.t2 === 0.15, 'creatine relaxation');
    near(T.lipidLines.reduce((s, l) => s + l.frac, 0), 1, 1e-12, 'lipid fractions sum to 1');
    ok(T.lipidLines.some(l => l.ppm === 1.30 && l.frac === 0.60), 'main lipid line 1.3 ppm, 60 percent');
    ok(T.lipid.t1 === 0.38 && T.lipid.t2 === 0.07, 'lipid relaxation');
    near(T.waterProtons(T.get('csf')), 111, 1e-9, 'CSF water proton concentration 111 M');
}

/* ---------- gadolinium ---------- */
{
    const les = T.withGad(T.get('lesion'), 1);
    near(les.t1, 1 / (1 / 1.6 + 4), 1e-12, 'lesion T1 with 1 mM Gd');
    near(les.t2, 1 / (1 / 0.18 + 5), 1e-12, 'lesion T2 with 1 mM Gd');
    near(les.t2s, 1 / (1 / 0.10 + 5), 1e-12, 'lesion T2* with 1 mM Gd (r2 term)');
    const ves = T.withGad(T.get('vessel'), 0.5);
    ok(ves.t1 < 1.65 && ves.t2 < 0.10, 'vessel enhances');
    for (const id of ['wm', 'gm', 'csf', 'fat', 'muscle', 'water']) {
        const t = T.withGad(T.get(id), 1);
        ok(t.t1 === T.library[id].t1 && t.t2 === T.library[id].t2 && t.t2s === T.library[id].t2s, 'no Gd effect on ' + id);
    }
    ok(T.withGad(T.get('lesion'), 0).t1 === 1.6, 'zero dose leaves T1 alone');
    ok(T.library.lesion.t1 === 1.6, 'withGad does not modify the library');
}

/* ---------- phantom list and basic structure ---------- */
const IDS = ['brain', 'shepp', 'resolution', 'relax', 'waterfat', 'braino'];
{
    const L = PH.list();
    ok(L.length === 6 && IDS.every(id => L.some(p => p.id === id)), 'list() has the six phantoms');
    ok(L.every(p => typeof p.name === 'string' && typeof p.description === 'string' && typeof p.hasSpectra === 'boolean'), 'list entries complete');
    ok(L.find(p => p.id === 'braino').hasSpectra && L.find(p => p.id === 'brain').hasSpectra, 'brain and braino offer spectra');
    let threw = false; try { PH.build('nope'); } catch (e) { threw = true; }
    ok(threw, 'unknown phantom throws');
}

for (const id of IDS) {
    const A = {};
    for (const n of [256, 512]) {
        const ph = PH.build(id, { n });
        ok(ph.id === id && ph.n === n && ph.fov === 0.28 && Math.abs(ph.dx - 0.28 / n) < 1e-15, id + ' ' + n + ': id, n, fov, dx');
        ok(ph.label instanceof Uint8Array && ph.label.length === n * n, id + ' ' + n + ': label is Uint8Array(n*n)');
        ok(ph.dB0 instanceof Float32Array && ph.dB0.length === n * n, id + ' ' + n + ': dB0 is Float32Array(n*n)');
        ok(ph.tissues[0].id === 'air', id + ' ' + n + ': tissues[0] is air');
        const used = new Array(ph.tissues.length).fill(0);
        let bad = 0;
        for (let i = 0; i < n * n; i++) { const l = ph.label[i]; if (l >= ph.tissues.length) bad++; else used[l]++; }
        ok(bad === 0, id + ' ' + n + ': every label indexes tissues');
        ok(used.every(c => c > 0), id + ' ' + n + ': every listed tissue is used (' + ph.tissues.map((t, i) => t.id + ':' + used[i]).join(' ') + ')');
        ok(used[0] > 0 && ph.label[0] === 0, id + ' ' + n + ': corner is air');
        let airField = 0;
        for (let i = 0; i < n * n; i++) if (!ph.label[i] && ph.dB0[i] !== 0) airField++;
        ok(airField === 0, id + ' ' + n + ': dB0 is zero in air');
        ok(Array.isArray(ph.landmarks) && ph.landmarks.length > 0 &&
            ph.landmarks.every(L => typeof L.name === 'string' && Math.abs(L.x) < 0.14 && Math.abs(L.y) < 0.14), id + ' ' + n + ': landmarks in metres inside the FOV');
        ok(typeof ph.notes === 'string' && ph.notes.length > 20, id + ' ' + n + ': notes');
        A[n] = areas(ph);
    }
    // Same analytic geometry at both raster sizes: tissue areas agree.
    const ph = PH.build(id, { n: 512 });
    ph.tissues.forEach((t, i) => {
        if (i === 0) return;
        const a = A[512][i], b = A[256][i];
        ok(Math.abs(a - b) <= Math.max(0.03 * a, 10), id + ': ' + t.id + ' area agrees at n=256 and 512 (' + b.toFixed(0) + ' vs ' + a.toFixed(0) + ' mm2)');
    });
}

/* ---------- the brain ---------- */
for (const n of [256, 512]) {
    const ph = PH.build('brain', { n });
    const a = areas(ph), A = id => a[idx(ph, id)];
    ok(ph.tissues.map(t => t.id).join(',') === 'air,fat,muscle,bone,marrow,csf,gm,wm,vessel,deepgm', 'brain tissue list and order');
    const intracranial = A('csf') + A('gm') + A('wm') + A('vessel') + A('deepgm');
    ok(A('deepgm') > 0.03 * intracranial && A('deepgm') < 0.15 * intracranial, n + ': deep grey matter (caudate, lentiform, thalamus) present (' + (A('deepgm') / intracranial).toFixed(3) + ')');
    ok(A('wm') > 0.35 * intracranial && A('gm') > 0.25 * intracranial, n + ': WM and GM both substantial (' + (A('wm') / intracranial).toFixed(2) + ', ' + (A('gm') / intracranial).toFixed(2) + ')');
    ok(A('csf') < A('gm') && A('csf') < A('wm') && A('csf') > 0.08 * intracranial, n + ': CSF present but less than GM and WM');
    ok(A('bone') > 800 && A('marrow') > 600 && A('fat') > 1200 && A('muscle') > 400 && A('vessel') > 20, n + ': skull, scalp, muscle and sinus present');

    // Head about 160 mm left-right by 200 mm front-back.
    let x0 = 1, x1 = -1, y0 = 1, y1 = -1;
    const h = n / 2;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) if (ph.label[iy * n + ix]) {
        const x = (ix - h) * ph.dx, y = (iy - h) * ph.dx;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    near((x1 - x0) * 1000, 160, 10, n + ': head width (mm)');
    near((y1 - y0) * 1000, 200, 12, n + ': head length (mm)');

    // Roughly left-right symmetric: mirror x -> -x (index ix <-> n - ix).
    let same = 0, head = 0;
    const left = new Array(ph.tissues.length).fill(0), right = new Array(ph.tissues.length).fill(0);
    for (let iy = 0; iy < n; iy++) for (let ix = 1; ix < n; ix++) {
        const l = ph.label[iy * n + ix], m = ph.label[iy * n + (n - ix)];
        if (l || m) { head++; if (l === m) same++; }
        if (ix < h) right[l]++; else if (ix > h) left[l]++;
    }
    ok(same / head > 0.75, n + ': labels mostly mirror-symmetric (' + (same / head).toFixed(3) + ')');
    for (const id of ['csf', 'gm', 'wm', 'deepgm', 'bone', 'marrow', 'fat', 'muscle']) {
        const i = idx(ph, id);
        ok(Math.abs(left[i] - right[i]) < 0.08 * (left[i] + right[i]) / 2, n + ': ' + id + ' area similar in both hemispheres');
    }

    // Anterior at negative y: the frontal sinus is at the top, the big SSS at the bottom.
    const fs = landmark(ph, 'Frontal sinus');
    ok(fs && fs.y < -0.08 && Math.abs(fs.x) < 0.015, n + ': frontal sinus landmark anterior (y < 0) near the midline');
    let sinusAir = 0;
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * ph.dx, y = (iy - h) * ph.dx;
        if (!ph.label[iy * n + ix] && Math.abs(x) < 0.02 && y < -0.08 && y > -0.1 && tissueAt(ph, x, y - 0.004) !== 'air') sinusAir++;
    }
    ok(sinusAir * ph.dx * ph.dx * 1e6 > 40, n + ': air cells inside the frontal bone (frontal sinus)');
    let vAnt = 0, vPost = 0;
    const iv = idx(ph, 'vessel');
    for (let i = 0; i < n * n; i++) if (ph.label[i] === iv) { if (Math.floor(i / n) < h) vAnt++; else vPost++; }
    ok(vPost > vAnt && vAnt > 0, n + ': superior sagittal sinus larger posteriorly');

    // Landmarks name the right tissue.
    const expect = {
        'Frontal sinus': 'air', 'Superior sagittal sinus': 'vessel', 'Scalp fat': 'fat', 'Diploë': 'marrow',
        'Outer table': 'bone', 'Right temporalis': 'muscle', 'Left temporalis': 'muscle', 'Subarachnoid': 'csf',
        'Genu': 'wm', 'Splenium': 'wm', 'Right lateral ventricle': 'csf', 'Left lateral ventricle': 'csf',
        'Right caudate': 'deepgm', 'Left caudate': 'deepgm', 'Right thalamus': 'deepgm', 'Left thalamus': 'deepgm', 'Third ventricle': 'csf',
        'Right internal capsule': 'wm', 'Left putamen': 'deepgm', 'Right insula': 'gm', 'Left Sylvian': 'csf',
        'Right atrium': 'csf', 'Left occipital horn': 'csf', 'Frontal white matter': 'wm', 'Interhemispheric': 'csf',
        'Septum pellucidum': 'wm'
    };
    for (const k in expect) {
        const L = landmark(ph, k);
        ok(L && tissueAt(ph, L.x, L.y) === expect[k], n + ': landmark "' + k + '" lies in ' + expect[k] + (L ? ' (got ' + tissueAt(ph, L.x, L.y) + ')' : ' (missing)'));
    }
    const lv = landmark(ph, 'Left lateral ventricle'), th = landmark(ph, 'Left thalamus');
    ok(lv.y < 0 && th.y > lv.y && lv.x > 0 && landmark(ph, 'Right lateral ventricle').x < 0, n + ': frontal horns anterior to thalami; patient right on image left');

    // Susceptibility field: positive lobe in the orbitofrontal brain behind the sinus.
    const ofc = landmark(ph, 'Orbitofrontal');
    let maxBrain = -1e9, peak = null;
    const brainIds = new Set(['csf', 'gm', 'wm', 'deepgm'].map(id => idx(ph, id)));
    for (let i = 0; i < n * n; i++) if (brainIds.has(ph.label[i]) && ph.dB0[i] > maxBrain) { maxBrain = ph.dB0[i]; peak = i; }
    near(maxBrain, 120, 25, n + ': peak brain off-resonance about +120 Hz');
    ok((Math.floor(peak / n) - h) * ph.dx < -0.07 && Math.abs((peak % n - h) * ph.dx) < 0.02, n + ': peak is at the anterior midline');
    const fAt = (x, y) => ph.dB0[(Math.round(y / ph.dx) + h) * n + Math.round(x / ph.dx) + h];
    const ySurf = ofc.y - 0.006;     // about the brain surface behind the sinus
    ok(fAt(0, ySurf) > 70 && fAt(0, ySurf + 0.010) > 0.3 * fAt(0, ySurf) && fAt(0, ySurf + 0.030) < 0.15 * fAt(0, ySurf),
        n + ': frontal lobe decays over 15 to 20 mm (' + [0, 10, 20, 30].map(d => fAt(0, ySurf + d / 1000).toFixed(0)).join(', ') + ' Hz)');
    ok(Math.abs(fAt(0, 0)) < 3 && Math.abs(fAt(0, 0.06)) < 3, n + ': small field deep in the brain');
    const lat = fAt(-0.064, 0.008);
    ok(lat > 15 && lat < 60 && Math.abs(fAt(0.064, 0.008) - lat) < 1, n + ': weaker lateral offset near the ears (' + lat.toFixed(1) + ' Hz)');
}
{
    // Lesions
    const p0 = PH.build('brain', { n: 256 }), p1 = PH.build('brain', { n: 256, lesion: true });
    ok(idx(p0, 'lesion') < 0 && idx(p1, 'lesion') === p1.tissues.length - 1, 'lesion tissue listed only with lesion: true');
    const la = areas(p1)[idx(p1, 'lesion')];
    ok(la > 130 && la < 260, 'lesion area plausible (' + la.toFixed(0) + ' mm2)');
    const big = landmark(p1, 'Lesion, 12 mm');
    ok(big && big.x < 0 && big.y < 0 && tissueAt(p1, big.x, big.y) === 'lesion', '12 mm lesion in the right (image left) frontal white matter');
    ok(tissueAt(p0, big.x, big.y) === 'wm', 'that site is white matter without the lesion');
    const plaques = p1.landmarks.filter(L => L.name.indexOf('Periventricular') === 0);
    ok(plaques.length === 3 && plaques.every(L => tissueAt(p1, L.x, L.y) === 'lesion'), 'three periventricular plaques');
    let differ = 0;
    for (let i = 0; i < p0.label.length; i++) if (p0.label[i] !== p1.label[i]) {
        differ++;
        if (p1.tissues[p1.label[i]].id !== 'lesion') differ += 1e6;
    }
    ok(differ > 0 && differ < 1e6, 'the lesion option only adds lesion pixels');
}

/* ---------- options: overrides, gadolinium, cache ---------- */
{
    const base = PH.build('brain', { n: 256 });
    const ov = PH.build('brain', { n: 256, overrides: { wm: { t1: 1.0, pd: 0.65 }, csf: { t2: 0.2 } } });
    const wm = ov.tissues[idx(ov, 'wm')], csf = ov.tissues[idx(ov, 'csf')];
    ok(wm.t1 === 1.0 && wm.pd === 0.65 && wm.t2 === 0.075, 'override sets WM T1 and PD only');
    ok(csf.t2 === 0.2 && csf.t2s === 0.2, 'override of CSF T2 below its T2* clamps T2* to T2');
    ok(base.tissues[idx(base, 'wm')].t1 === 0.85 && T.library.wm.t1 === 0.85, 'overrides do not leak into other phantoms or the library');
    ok(ov.label === base.label, 'overrides reuse the same geometry');

    const gd = PH.build('brain', { n: 256, lesion: true, gad: 0.5 });
    const ref = PH.build('brain', { n: 256, lesion: true });
    for (const t of gd.tissues) {
        const r = ref.tissues[idx(ref, t.id)];
        if (t.enhances) ok(t.t1 < r.t1 && t.t2 < r.t2, 'gadolinium shortens ' + t.id);
        else ok(t.t1 === r.t1 && t.t2 === r.t2 && t.t2s === r.t2s, 'gadolinium leaves ' + t.id + ' alone');
    }
    near(gd.tissues[idx(gd, 'lesion')].t1, 1 / (1 / 1.6 + 4 * 0.5), 1e-12, 'lesion T1 at 0.5 mM');
    // overrides are applied before gadolinium
    const both = PH.build('brain', { n: 256, lesion: true, gad: 0.5, overrides: { lesion: { t1: 2.0 } } });
    near(both.tissues[idx(both, 'lesion')].t1, 1 / (1 / 2.0 + 2), 1e-12, 'override then gadolinium');

    // cache
    const a = PH.build('brain', { n: 256 }), b = PH.build('brain', { n: 256 });
    ok(a === b, 'cache returns the same object');
    ok(PH.build('brain', { n: 256, lesion: false, gad: 0, overrides: {} }) === a, 'equivalent options share a cache entry');
    ok(PH.build('brain', {}) === a && PH.build('brain') === a, 'default n is 256');
    ok(PH.build('brain', { n: 256, gad: 0.2 }) !== a, 'different options give a different phantom');
    const s1 = PH.build('shepp', { n: 256, overrides: { csf: { t1: 3 }, wm: { t1: 1 } } });
    const s2 = PH.build('shepp', { n: 256, overrides: { wm: { t1: 1 }, csf: { t1: 3 } } });
    ok(s1 === s2, 'override key order does not matter');

    // relaxometry landmarks quote the vial values, including overrides
    const rx = PH.build('relax', { n: 256, overrides: { vial03: { t1: 0.5 } } });
    ok(rx.landmarks.length === 12, 'twelve vial landmarks');
    rx.landmarks.forEach((L, k) => {
        const t = rx.tissues[k + 1];
        ok(L.t1 === t.t1 && L.t2 === t.t2 && tissueAt(rx, L.x, L.y) === t.id && L.name.indexOf('T1') > 0, 'vial ' + (k + 1) + ' landmark');
    });
    ok(rx.landmarks[2].t1 === 0.5 && /T1 500 ms/.test(rx.landmarks[2].name), 'vial landmark shows an overridden T1');
}

/* ---------- other phantoms: geometry spot checks ---------- */
{
    const res = PH.build('resolution', { n: 512 });
    // count bar edges along a row through each vertical-bar group
    for (const w of [4, 3, 2, 1.5]) {
        const L = landmark(res, w + ' mm bars (vertical)');
        const n = res.n, h = n / 2, iy = Math.round(L.y / res.dx) + h;
        let edges = 0, prev = null;
        for (let ix = 0; ix < n; ix++) {
            const x = (ix - h) * res.dx;
            if (Math.abs(x - L.x) > 4.5 * w / 1000 + 0.002) continue;
            const v = res.label[iy * n + ix];
            if (prev !== null && v !== prev) edges++;
            prev = v;
        }
        ok(edges === 10, w + ' mm vertical bars: five bars resolved on the 512 raster (' + edges + ' edges)');
    }
    const hole = landmark(res, '30 mm');
    ok(tissueAt(res, hole.x, hole.y) === 'air' && tissueAt(res, hole.x + 0.02, hole.y) === 'water', 'air hole');
    const rel = PH.build('relax', { n: 512 }), ra = areas(rel);
    for (let k = 1; k <= 12; k++) near(ra[k], Math.PI * 12.5 * 12.5, 8, 'vial ' + k + ' area (25 mm)');
    const wf = PH.build('waterfat', { n: 512 });
    const wv = landmark(wf, 'Water vial'), ov = landmark(wf, 'Oil vial');
    ok(tissueAt(wf, wv.x, wv.y) === 'water' && tissueAt(wf, wv.x + 0.0235, wv.y) === 'oil', 'water vial sits in oil');
    ok(tissueAt(wf, ov.x, ov.y) === 'oil' && tissueAt(wf, ov.x + 0.025, ov.y) === 'water', 'oil vial sits in water');
    ok(tissueAt(wf, 0, 0) === 'water' && tissueAt(wf, 0.095, 0) === 'oil' && tissueAt(wf, 0.105, 0) === 'air', 'water disk inside the oil ring');
    const fx = x => wf.dB0[(wf.n / 2) * wf.n + Math.round(x / wf.dx) + wf.n / 2];
    near(fx(0.08), 24, 0.5, 'water-fat linear field +24 Hz at x = 80 mm');
    near(fx(-0.08), -24, 0.5, 'water-fat linear field -24 Hz at x = -80 mm');
    const bo = PH.build('braino', { n: 512 });
    near(areas(bo)[1], Math.PI * 80 * 80, 60, 'braino disk 160 mm');
    const sh = PH.build('shepp', { n: 512 });
    ok(tissueAt(sh, 0, -0.04) === 'gm' && tissueAt(sh, 0, 0.0666) === 'lesion', 'Shepp-Logan in the familiar orientation (big ellipse top, small ones bottom)');
}

/* ---------- fields ---------- */
{
    const shepp = PH.build('shepp', { n: 256 });
    const z = F.b0Map(shepp, { susceptibility: 1, shim: 0 });
    ok(z.every(v => v === 0), 'b0 zero for shepp with shim 0');
    const brain = PH.build('brain', { n: 256 });
    const b0 = F.b0Map(brain, { susceptibility: 1, shim: 0 });
    const fs = landmark(brain, 'Orbitofrontal');
    const h = 128, at = (m, x, y) => m[(Math.round(y / brain.dx) + h) * 256 + Math.round(x / brain.dx) + h];
    ok(at(b0, fs.x, fs.y - 0.006) > 70, 'b0 nonzero (> 70 Hz) behind the frontal sinus');
    ok(b0.every((v, i) => v === brain.dB0[i]), 'susceptibility 1, shim 0 returns dB0');
    const b2 = F.b0Map(brain, { susceptibility: 2 });
    ok(b2.every((v, i) => Math.abs(v - 2 * brain.dB0[i]) < 1e-3 * (1 + Math.abs(v))), 'susceptibility scales dB0');
    // Section 7.1: the un-shimmed residual is a sum of shim terms (Hz at 100 mm);
    // tests/test_shim.js covers it in detail.
    const bs = F.b0Map(brain, { susceptibility: 0, shim: 1 });
    const RC = F.residualCoeffs;
    const resid = (x, y) => RC.z0 + RC.x * x / 0.1 + RC.y * y / 0.1 + RC.xy * 2 * x * y / 0.01 +
        RC.x2y2 * (x * x - y * y) / 0.01 - RC.z2 * (x * x + y * y) / 0.01;
    let shimErr = 0, airNonZero = 0;
    for (let iy = 0; iy < 256; iy++) for (let ix = 0; ix < 256; ix++) {
        const i = iy * 256 + ix, x = (ix - h) * brain.dx, y = (iy - h) * brain.dx;
        if (brain.label[i]) shimErr = Math.max(shimErr, Math.abs(bs[i] - resid(x, y)));
        else if (bs[i] !== 0) airNonZero++;
    }
    ok(shimErr < 1e-3 && airNonZero === 0, 'shim residual is the sum of its shim terms; zero in air');
    near(F.shimResidual(0.1, 0), RC.z0 + RC.x + RC.x2y2 - RC.z2, 1e-9, 'shim residual at x = 100 mm');
    near(F.shimResidual(0, 0.1), RC.z0 + RC.y - RC.x2y2 - RC.z2, 1e-9, 'shim residual at y = 100 mm');
    ok(F.b0Map(brain).every((v, i) => v === brain.dB0[i]), 'b0 defaults to susceptibility 1, shim 0');

    // B1
    const flat = F.b1Map(brain, { amount: 0 });
    ok(flat.every(v => v === 1), 'b1 = 1 everywhere with amount 0');
    const b1 = F.b1Map(brain, { amount: 0.3 });
    let lo = 9, hi = -9;
    for (let i = 0; i < b1.length; i++) { lo = Math.min(lo, b1[i]); hi = Math.max(hi, b1[i]); }
    near(hi, 1.18, 1e-6, 'b1 centre 1 + 0.3 x 0.6');
    ok(lo >= 0.4 - 1e-7 && hi <= 1.6 + 1e-7, 'b1 within [0.4, 1.6]');
    near(at(b1, 0.09, 0), 1 - 0.3 * 0.4, 0.01, 'b1 at 90 mm');
    ok(at(b1, 0, 0) > at(b1, 0.05, 0) && at(b1, 0.05, 0) > at(b1, 0.08, 0), 'b1 falls from centre to periphery');
    const b1max = F.b1Map(brain, { amount: 0.5 });
    ok(Math.min.apply(null, Array.from(b1max)) === Math.fround(0.4), 'b1 clipped at 0.4 in the corners');

    // Coils
    const body = F.coilSet('body');
    ok(body.n === 1 && body.names.length === 1 && body.positions.length === 1, 'body coil set');
    const bm = F.coilMaps(body, 64, 48, 0.24, 0.18);
    ok(bm.re.length === 1 && bm.re[0].length === 64 * 48 && bm.re[0].every(v => v === 1) && bm.im[0].every(v => v === 0), 'body coil: sensitivity 1, phase 0');
    const cs = F.coilSet('head8');
    ok(cs.n === 8 && cs.names.length === 8 && cs.positions.length === 8 && cs.radius > 0, 'head8 coil set');
    ok(cs.positions.every(p => Math.abs((p.x / 0.105) ** 2 + (p.y / 0.125) ** 2 - 1) < 1e-9), 'head8 elements on the 105 x 125 mm ellipse');
    const maps = F.coilMaps(cs, 256, 256, 0.28, 0.28);
    ok(maps.re.length === 8 && maps.im.length === 8 && maps.re.every(a => a instanceof Float32Array && a.length === 256 * 256), 'head8 maps: 8 re/im Float32Arrays');
    const rss = F.rss(maps);
    let s = 0, c = 0;
    for (let iy = 0; iy < 256; iy++) for (let ix = 0; ix < 256; ix++) {
        const x = (ix - h) * 0.28 / 256, y = (iy - h) * 0.28 / 256;
        if (x * x + y * y < 0.07 * 0.07) { s += rss[iy * 256 + ix]; c++; }
    }
    near(s / c, 1, 0.01, 'head8 RSS averages 1 within 70 mm (256 grid)');
    {
        const m2 = F.coilMaps(cs, 128, 96, 0.24, 0.18), r2 = F.rss(m2);
        let s2 = 0, c2 = 0;
        for (let iy = 0; iy < 96; iy++) for (let ix = 0; ix < 128; ix++) {
            const x = (ix - 64) * 0.24 / 128, y = (iy - 48) * 0.18 / 96;
            if (x * x + y * y < 0.07 * 0.07) { s2 += r2[iy * 128 + ix]; c2++; }
        }
        near(s2 / c2, 1, 0.02, 'head8 RSS averages 1 within 70 mm (rectangular 128 x 96 grid)');
    }
    ok(rss[h * 256 + h] < 0.9 && at(rss, 0, -0.09) > 1.3, 'RSS lower in the centre than near the coils');
    // each element is most sensitive at its own position (centred index convention)
    let posOK = true;
    for (let k = 0; k < 8; k++) {
        let best = -1, bi = 0;
        for (let i = 0; i < 256 * 256; i++) { const m = Math.hypot(maps.re[k][i], maps.im[k][i]); if (m > best) { best = m; bi = i; } }
        const x = (bi % 256 - h) * 0.28 / 256, y = (Math.floor(bi / 256) - h) * 0.28 / 256;
        if (Math.hypot(x - cs.positions[k].x, y - cs.positions[k].y) > 0.28 / 256) posOK = false;
    }
    ok(posOK, 'each coil map peaks at its element position');
    // exact pixel-centre evaluation on a small odd grid
    {
        const m = F.coilMaps(cs, 5, 3, 0.05, 0.03), k = 2, p = cs.positions[k];
        const x = (4 - 2) * 0.01, y = (0 - 1) * 0.01;
        const d2 = (x - p.x) ** 2 + (y - p.y) ** 2, q = 1 + d2 / (cs.radius * cs.radius);
        const mag = cs.scale / (q * Math.sqrt(q));
        const ph = cs.phase0[k] + cs.phaseSlope * (cs.phaseDir[k].x * x + cs.phaseDir[k].y * y);
        near(m.re[k][0 * 5 + 4], mag * Math.cos(ph), 1e-6, 'coil map value at pixel (4, 0) of a 5 x 3 grid (re)');
        near(m.im[k][0 * 5 + 4], mag * Math.sin(ph), 1e-6, 'coil map value at pixel (4, 0) of a 5 x 3 grid (im)');
    }
    // phase varies smoothly, about 1 rad across the head
    {
        const k = 0, ph = i => Math.atan2(maps.im[k][i], maps.re[k][i]);
        const L = (h) * 256 + (h - 70), R = (h) * 256 + (h + 70), U = (h - 85) * 256 + h, D = (h + 85) * 256 + h;
        const dph = Math.max(Math.abs(ph(L) - ph(R)), Math.abs(ph(U) - ph(D)));
        ok(dph > 0.4 && dph < 1.6, 'coil phase changes by about 1 rad across the head (' + dph.toFixed(2) + ' rad)');
    }
    // copies: modifying a returned map does not change the next call
    maps.re[0][0] = 123;
    ok(F.coilMaps(cs, 256, 256, 0.28, 0.28).re[0][0] !== 123, 'coilMaps returns fresh copies');
    let threw = false; try { F.coilSet('xyz'); } catch (e) { threw = true; }
    ok(threw, 'unknown coil set throws');
}

/* ---------- timing ---------- */
{
    PH.clearCache();
    let t = Date.now();
    PH.build('brain', { n: 512 });
    const ms = Date.now() - t;
    ok(ms < 400, 'brain at n = 512 builds in under 400 ms (' + ms + ' ms)');
    t = Date.now();
    PH.build('brain', { n: 512 });
    ok(Date.now() - t < 5, 'cached build is instant');
    PH.clearCache();
    t = Date.now();
    for (const id of IDS) PH.build(id, { n: 256 });
    const all = Date.now() - t;
    ok(all < 400, 'all six phantoms at n = 256 in under 400 ms (' + all + ' ms)');
}

summary('phantoms');
