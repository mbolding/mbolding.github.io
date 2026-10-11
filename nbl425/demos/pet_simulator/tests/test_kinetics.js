'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner', 'kinetics', 'phantoms']);
const K = PET.kinetics;

// Helpers: a program as dsl.js would compile it, frame lists, region lookup.
function program(tracer, isotope, dose, frames, extra) {
    return Object.assign({ tracer, isotope, dose, weight: 70, frames, scanStart: frames[0].t0, scanEnd: frames[frames.length - 1].t1 }, extra || {});
}
function framing(spec) {                 // [[count, seconds], ...] from injection
    const out = []; let t = 0;
    spec.forEach(([n, d]) => { for (let i = 0; i < n; i++) { out.push({ t0: t, t1: t + d }); t += d; } });
    return out;
}
const mid = frames => Float64Array.from(frames.map(f => (f.t0 + f.t1) / 2));
const brain = cond => PET.phantoms.build('brain', { condition: cond });
const idx = (ph, id) => PET.phantoms.regionIndex(ph, id);
function windowMeans(ph, tracer, iso, dose, t0, t1) {
    const prog = program(tracer, iso, dose, [{ t0, t1 }]);
    const tacs = K.regionTACs(ph, prog, {});
    return { tacs, m: K.frameMeans(tacs, prog.frames)[0] };
}

// API surface and the lists the UI shows
{
    ['input', 'params', 'tissue', 'derived', 'regionTACs', 'frameMeans', 'patlak', 'logan', 'suv', 'suvr', 'ratioCurve'].forEach(f =>
        ok(typeof K[f] === 'function', 'kinetics.' + f + ' exists'));
    ok(K.table && K.table.FDG && K.table.PiB && K.table['FE-PE2I'], 'parameter table exported');
    const ids = K.conditions.map(c => c.id).join(',');
    ok(ids === 'normal,ad,pd', 'conditions normal, ad, pd (' + ids + ')');
    ok(K.conditions[1].name === "Alzheimer's disease" && K.conditions[2].name === "Parkinson's disease", 'condition names');
    ok(K.tableRows('PiB', 'ad').length > 5, 'tableRows gives rows for the UI');
}

// Input functions: zero before arrival, a bolus peak, the right shapes
{
    PET.tracers.list().forEach(tr => {
        const inp = K.input(tr.id);
        ok(inp.cp(0) === 0 && inp.cp(inp.delay) === 0, tr.id + ' input is zero until it arrives');
        ok(inp.peakTime > inp.delay && inp.peakTime < 60, tr.id + ' input peaks within a minute (' + inp.peakTime + ' s)');
        ok(typeof inp.description === 'string' && inp.description.length > 10, tr.id + ' input has a description');
    });
    const w = K.input('water');
    ok(w.peakTime >= 20 && w.peakTime <= 30, 'water bolus peaks at 20 to 30 s (' + w.peakTime + ' s)');
    ok(w.cp(180) / w.peak > 0.06 && w.cp(240) / w.cp(150) > 0.9, 'water falls to a plateau (' + (w.cp(240) / w.cp(150)).toFixed(3) + ')');
    const late = id => K.input(id).cp(600) / K.input(id).peak;
    ok(late('PiB') < late('FDG') / 3 && late('PE2I') < late('FDG') / 3, 'PiB and PE2I clear faster than FDG');
    let threw = false; try { K.input('none'); } catch (e) { threw = true; }
    ok(threw, 'input() of an unknown tracer throws');
}

// Exact convolution: the analytic 1TC response against a fine numerical
// ODE integration (RK4, 0.02 s steps) of the same input
{
    const inp = K.input('FDG'), m = { model: '1tc', K1: 0.3, k2: 0.25, vb: 0 };
    const dt = 2, n = 1801, t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i * dt;
    const res = K.tissue(m, inp.cp, t);
    const h = 0.02, f = (tt, c) => (m.K1 * inp.cp(tt) - m.k2 * c) / 60;
    let c = 0, tt = 0, maxErr = 0, peak = 0;
    for (let i = 1; i < n; i++) {
        while (tt < t[i] - 1e-9) {
            const a = f(tt, c), b = f(tt + h / 2, c + h / 2 * a), cc = f(tt + h / 2, c + h / 2 * b), d = f(tt + h, c + h * cc);
            c += h / 6 * (a + 2 * b + 2 * cc + d); tt += h;
        }
        maxErr = Math.max(maxErr, Math.abs(c - res.c1[i])); peak = Math.max(peak, c);
    }
    ok(maxErr / peak < 0.005, '1TC analytic response matches RK4 (max error ' + (100 * maxErr / peak).toFixed(3) + ' % of peak)');
    // and on a 0.5 s grid the residual (linear interpolation of the input) shrinks
    const t2 = new Float64Array(7201); for (let i = 0; i < t2.length; i++) t2[i] = i * 0.5;
    const r2 = K.tissue(m, inp.cp, t2);
    near(r2.c1[7200], res.c1[1800], 1e-3 * peak, '1TC result does not depend on the grid step');

    // 2TC reversible against RK4 as well
    const m2 = { model: '2tcr', K1: 0.25, k2: 0.125, k3: 0.2, k4: 0.1, vb: 0 };
    const r3 = K.tissue(m2, K.input('PiB').cp, t), cpf = K.input('PiB').cp;
    const g = (s, y) => [(m2.K1 * cpf(s) - (m2.k2 + m2.k3) * y[0] + m2.k4 * y[1]) / 60, (m2.k3 * y[0] - m2.k4 * y[1]) / 60];
    let y = [0, 0], s = 0, err2 = 0, pk2 = 0;
    for (let i = 1; i < n; i++) {
        while (s < t[i] - 1e-9) {
            const a = g(s, y), b = g(s + h / 2, [y[0] + h / 2 * a[0], y[1] + h / 2 * a[1]]);
            const cc = g(s + h / 2, [y[0] + h / 2 * b[0], y[1] + h / 2 * b[1]]), d = g(s + h, [y[0] + h * cc[0], y[1] + h * cc[1]]);
            y = [y[0] + h / 6 * (a[0] + 2 * b[0] + 2 * cc[0] + d[0]), y[1] + h / 6 * (a[1] + 2 * b[1] + 2 * cc[1] + d[1])]; s += h;
        }
        err2 = Math.max(err2, Math.abs(y[0] + y[1] - (r3.c1[i] + r3.c2[i]))); pk2 = Math.max(pk2, y[0] + y[1]);
    }
    ok(err2 / pk2 < 0.005, '2TC analytic response matches RK4 (max error ' + (100 * err2 / pk2).toFixed(3) + ' % of peak)');
    // FDG trapping: with k4 = 0, C2 is K1 k3 times the integral of C1
    const m3 = { model: '2tci', K1: 0.1, k2: 0.13, k3: 0.06, k4: 0, vb: 0.05 };
    const r4 = K.tissue(m3, inp.cp, t);
    let I = 0; for (let i = 1; i < n; i++) I += (r4.c1[i] + r4.c1[i - 1]) / 2 * dt / 60;
    near(r4.c2[n - 1], m3.k3 * I, 1e-3 * r4.c2[n - 1], 'irreversible C2 = k3 times the integral of C1');
    near(r4.ct[600], 0.95 * (r4.c1[600] + r4.c2[600]) + 0.05 * r4.cp[600], 1e-9, 'ct = (1 - vb)(C1 + C2) + vb Cp');
    const blood = K.tissue({ model: 'blood', vb: 1 }, inp.cp, t);
    near(blood.ct[100], inp.cp(200), 1e-12, 'blood model returns the plasma curve');
    ok(K.tissue(null, inp.cp, t).ct.every(v => v === 0), 'no model, no activity');
}

// Derived macroparameters
{
    const d = K.derived({ model: '2tcr', K1: 0.25, k2: 0.125, k3: 0.225, k4: 0.15, vb: 0.04 });
    near(d.VND, 2, 1e-12, 'VND = K1/k2'); near(d.BPND, 1.5, 1e-12, 'BPND = k3/k4');
    near(d.VT, 5, 1e-12, 'VT = VND (1 + BPND)'); near(d.DVR, 2.5, 1e-12, 'DVR = 1 + BPND');
    const f = K.derived(K.params('FDG', 'gm_frontal', 'normal'));
    near(f.Ki, 0.102 * 0.062 / (0.130 + 0.062), 1e-12, 'FDG Ki = K1 k3/(k2 + k3)');
    const w = K.derived(K.params('water', 'gm_frontal', 'normal'));
    near(w.flow, 0.55, 1e-12, 'water flow = K1'); near(w.VT, 0.9, 1e-12, 'water VT = partition coefficient');
}

// Regional parameter table: the contract's numbers
{
    const P = K.params;
    const g = P('FDG', 'gm_frontal', 'normal');
    ok(g.model === '2tci' && g.K1 === 0.102 && g.k2 === 0.130 && g.k3 === 0.062 && g.k4 === 0 && g.vb === 0.04, 'FDG gray matter parameters');
    const ta = P('FDG', 'gm_temporal', 'ad');
    near(ta.k3, 0.062 * 0.6, 1e-12, 'AD temporal FDG k3 x0.6'); near(ta.K1, 0.102 * 0.85, 1e-12, 'AD temporal FDG K1 x0.85');
    near(P('FDG', 'gm_occipital', 'ad').k3, 0.062 * 0.85, 1e-12, 'AD occipital FDG x0.85');
    near(P('FDG', 'gm_frontal', 'ad').k3, 0.062 * 0.9, 1e-12, 'AD frontal FDG x0.9');
    ok(P('FDG', 'gm_frontal', 'pd').k3 === 0.062, 'PD FDG about normal');
    ['csf', 'ventricles', 'skull', 'air', 'not_a_region'].forEach(id => ok(P('FDG', id, 'normal') === null, id + ' takes up nothing'));
    ok(P('none', 'gm_frontal', 'normal') === null, 'no tracer, no parameters');
    ok(P('FDG', 'sinus', 'normal').model === 'blood', 'the sinus is blood');
    const pc = P('PiB', 'gm_frontal', 'normal');
    near(pc.K1, 0.25, 1e-12, 'PiB cortex K1 0.25'); near(pc.K1 / pc.k2, 2, 1e-12, 'PiB cortex VND 2');
    near(K.derived(pc).BPND, 0.15, 1e-12, 'PiB normal cortex BPND 0.15');
    near(P('PiB', 'cereb_gm', 'ad').k3, 0, 1e-12, 'PiB reference region has no specific binding');
    near(K.derived(P('PiB', 'gm_frontal', 'ad')).BPND, 1.5, 1e-12, 'PiB AD frontal BPND 1.5');
    near(K.derived(P('PiB', 'gm_temporal', 'ad')).BPND, 1.5, 1e-12, 'PiB AD temporal BPND 1.5');
    near(K.derived(P('PiB', 'gm_occipital', 'ad')).BPND, 0.8, 1e-12, 'PiB AD occipital BPND 0.8');
    near(K.derived(P('PiB', 'putamen_l_ant', 'ad')).BPND, 1.0, 1e-12, 'PiB AD striatum BPND 1.0');
    near(K.derived(P('florbetaben', 'gm_frontal', 'ad')).BPND, 0.7, 1e-12, 'florbetaben AD cortex BPND 0.7');
    for (const [tr, bp] of [['PE2I', 4], ['FE-PE2I', 3.5]]) {
        ['putamen_r_ant', 'putamen_r_post', 'putamen_l_ant', 'putamen_l_post', 'caudate_r', 'caudate_l'].forEach(id =>
            near(K.derived(P(tr, id, 'normal')).BPND, bp, 1e-12, tr + ' ' + id + ' BPND ' + bp));
        near(K.derived(P(tr, 'thalamus', 'normal')).BPND, 0.3, 1e-12, tr + ' thalamus BPND 0.3');
        near(K.derived(P(tr, 'gm_frontal', 'normal')).BPND, 0.1, 1e-12, tr + ' cortex BPND 0.1');
        const f = { putamen_l_post: 0.2, putamen_l_ant: 0.45, putamen_r_post: 0.4, putamen_r_ant: 0.7, caudate_l: 0.7, caudate_r: 0.85 };
        Object.keys(f).forEach(id => near(K.derived(P(tr, id, 'pd')).BPND, bp * f[id], 1e-12, tr + ' PD ' + id + ' x' + f[id]));
        near(K.derived(P(tr, 'putamen_l_post', 'ad')).BPND, bp, 1e-12, tr + ' AD striatum normal');
    }
    const wg = P('water', 'gm_frontal', 'normal'), ww = P('water', 'wm', 'normal');
    near(wg.K1, 0.55, 1e-12, 'water GM K1 0.55'); near(ww.K1, 0.22, 1e-12, 'water WM K1 0.22');
    near(wg.K1 / wg.k2, 0.9, 1e-12, 'water GM partition 0.9'); near(ww.K1 / ww.k2, 0.8, 1e-12, 'water WM partition 0.8');
    near(P('water', 'gm_temporal', 'ad').K1, 0.44, 1e-12, 'AD temporal flow x0.8');
}

// The patient's LEFT is the image right: the PD deficit is at positive x
{
    const ph = brain('pd');
    const cx = id => { let s = 0, c = 0, i = idx(ph, id); for (let k = 0; k < ph.label.length; k++) if (ph.label[k] === i) { s += (k % ph.n - 128) * ph.dx; c++; } return s / c; };
    ok(cx('putamen_l_post') > 10 && cx('putamen_r_post') < -10, 'putamen_l on the image right, putamen_r on the image left');
    const { m } = windowMeans(ph, 'FE-PE2I', 'F18', 200e6, 1200, 2400);
    ok(m[idx(ph, 'putamen_l_post')] < m[idx(ph, 'putamen_r_post')] && m[idx(ph, 'putamen_r_post')] < m[idx(ph, 'putamen_r_ant')],
        'PD: left posterior putamen lowest, right anterior highest');
}

// Calibration targets (ARCHITECTURE.md section 5)
{
    // FDG: gray matter SUV 6 to 8 at 45 to 55 min, gray/white about 2.5
    const ph = brain('normal'), { tacs, m } = windowMeans(ph, 'FDG', 'F18', 185e6, 45 * 60, 55 * 60);
    const suv = id => K.suv(m[idx(ph, id)], 185e6, 70);
    ['gm_frontal', 'gm_temporal', 'gm_occipital'].forEach(id => ok(suv(id) >= 6 && suv(id) <= 8, 'FDG ' + id + ' SUV 45-55 min in 6..8 (' + suv(id).toFixed(2) + ')'));
    const gw = suv('gm_frontal') / suv('wm');
    ok(gw > 2.2 && gw < 2.8, 'FDG gray/white about 2.5 (' + gw.toFixed(2) + ')');
    ok(suv('scalp') < 1.5, 'FDG scalp low (' + suv('scalp').toFixed(2) + ')');
    near(tacs.suvScale, 185e6 / 70000, 1e-9, 'suvScale = dose / (weight x 1000)');
    const ad = windowMeans(brain('ad'), 'FDG', 'F18', 185e6, 45 * 60, 55 * 60).m;
    ok(ad[idx(ph, 'gm_temporal')] < 0.8 * m[idx(ph, 'gm_temporal')], 'AD: temporal hypometabolism on FDG');
    console.log('    FDG SUV 45-55 min: GM ' + suv('gm_frontal').toFixed(2) + ', WM ' + suv('wm').toFixed(2) + ', GM/WM ' + gw.toFixed(2));
}
{
    // PiB: SUVR to cerebellar gray matter over 50 to 70 min
    const cortexSUVR = (ph, m) => {
        let num = 0, den = 0;
        ['gm_frontal', 'gm_temporal', 'gm_occipital'].forEach(id => { const r = ph.regions[idx(ph, id)]; num += m[idx(ph, id)] * r.pixels; den += r.pixels; });
        return num / den / m[idx(ph, 'cereb_gm')];
    };
    const n = brain('normal'), mn = windowMeans(n, 'PiB', 'C11', 400e6, 3000, 4200).m;
    const a = brain('ad'), ma = windowMeans(a, 'PiB', 'C11', 400e6, 3000, 4200).m;
    const sn = cortexSUVR(n, mn), sa = cortexSUVR(a, ma), wm = mn[idx(n, 'wm')] / mn[idx(n, 'cereb_gm')];
    ok(sn >= 1.1 && sn <= 1.3, 'PiB normal cortex SUVR 1.1..1.3 (' + sn.toFixed(2) + ')');
    ok(sa >= 2.0 && sa <= 2.6, 'PiB AD cortex SUVR 2.0..2.6 (' + sa.toFixed(2) + ')');
    ok(wm > 1.45 && wm < 1.75, 'PiB white matter SUVR about 1.6 (' + wm.toFixed(2) + ')');
    const fr = ma[idx(a, 'gm_frontal')] / ma[idx(a, 'cereb_gm')];
    ok(fr > 2.3 && fr < 2.9, 'PiB AD frontal SUVR (' + fr.toFixed(2) + ')');
    console.log('    PiB SUVR 50-70 min: normal cortex ' + sn.toFixed(2) + ', AD cortex ' + sa.toFixed(2) + ' (frontal ' + fr.toFixed(2) + '), WM ' + wm.toFixed(2));
    // florbetaben read late: AD cortex well above normal but below PiB
    const fa = windowMeans(a, 'florbetaben', 'F18', 300e6, 5400, 6600).m, fn = windowMeans(n, 'florbetaben', 'F18', 300e6, 5400, 6600).m;
    const fbA = fa[idx(a, 'gm_frontal')] / fa[idx(a, 'cereb_gm')], fbN = fn[idx(n, 'gm_frontal')] / fn[idx(n, 'cereb_gm')];
    ok(fbN < 1.3 && fbA > 1.5 && fbA < fr, 'florbetaben SUVR: normal ' + fbN.toFixed(2) + ', AD ' + fbA.toFixed(2));
}
{
    // DAT: FE-PE2I reaches equilibrium faster than PE2I; SUVR near the
    // peak of specific binding is close to DVR
    const ph = brain('normal'), put = idx(ph, 'putamen_r_post'), ref = idx(ph, 'cereb_gm');
    const peak = tr => {
        const tacs = K.regionTACs(ph, program(tr, tr === 'PE2I' ? 'C11' : 'F18', 300e6, [{ t0: 0, t1: 5400 }]), {});
        let best = 0, tb = 0; tacs.regions[put].forEach((v, i) => { if (v > best) { best = v; tb = tacs.t[i]; } });
        return { tb, tacs };
    };
    const a = peak('PE2I'), b = peak('FE-PE2I');
    ok(b.tb < a.tb && b.tb > 900 && a.tb > 1800, 'FE-PE2I striatum peaks earlier (' + (b.tb / 60).toFixed(0) + ' min) than PE2I (' + (a.tb / 60).toFixed(0) + ' min)');
    const rA = K.ratioCurve(a.tacs, put, ref), rB = K.ratioCurve(b.tacs, put, ref);
    const i40 = 40 * 30, i60 = 60 * 30, i90 = 90 * 30;
    ok(Math.abs(rB[i40] / rB[i60] - 1) < Math.abs(rA[i40] / rA[i60] - 1), 'FE-PE2I SUVR(t) flatter than PE2I between 40 and 60 min');
    const sB = K.windowRatio(b.tacs, put, ref, 1200, 2400), sA = K.windowRatio(a.tacs, put, ref, 2400, 4200);
    ok(Math.abs(sB / 4.5 - 1) < 0.08, 'FE-PE2I SUVR 20-40 min close to DVR 4.5 (' + sB.toFixed(2) + ')');
    ok(Math.abs(sA / 5 - 1) < 0.1, 'PE2I SUVR 40-70 min close to DVR 5 (' + sA.toFixed(2) + ')');
    ok(rA[i90] > 5.5, 'PE2I SUVR keeps rising past DVR (' + rA[i90].toFixed(2) + ' at 90 min)');
    console.log('    DAT: PE2I putamen peak ' + (a.tb / 60).toFixed(0) + ' min, SUVR 40-70 ' + sA.toFixed(2) + '; FE-PE2I peak ' + (b.tb / 60).toFixed(0) + ' min, SUVR 20-40 ' + sB.toFixed(2));
}
{
    // Water: gray matter takes up and washes out faster than white matter
    const ph = brain('normal'), tacs = K.regionTACs(ph, program('water', 'O15', 700e6, framing([[12, 5], [6, 10], [4, 15]])), {});
    const g = tacs.regions[idx(ph, 'gm_frontal')], w = tacs.regions[idx(ph, 'wm')];
    let ig = 0, iw = 0; g.forEach((v, i) => { if (v > g[ig]) ig = i; }); w.forEach((v, i) => { if (v > w[iw]) iw = i; });
    ok(g[ig] > 1.5 * w[iw] && tacs.t[ig] < tacs.t[iw], 'water: GM peaks higher and earlier than WM');
}

// Transient equilibrium: SUVR(t) of a reversible tracer overshoots the true DVR late
{
    const ph = brain('ad'), tacs = K.regionTACs(ph, program('PiB', 'C11', 400e6, [{ t0: 0, t1: 5400 }]), {});
    const r = K.ratioCurve(tacs, idx(ph, 'gm_frontal'), idx(ph, 'cereb_gm'));
    const dvr = K.derived(K.params('PiB', 'gm_frontal', 'ad')).DVR;
    ok(r[60 * 30] > dvr * 1.03 && r[90 * 30] > dvr, 'PiB SUVR(t) above the true DVR at 60 and 90 min (' + r[60 * 30].toFixed(2) + ', ' + r[90 * 30].toFixed(2) + ' vs ' + dvr + ')');
    ok(r[0] === 0, 'SUVR(t) is 0 before the reference has any activity');
}

// Patlak recovers Ki of a 2TCi model from noise-free frame means
{
    const ph = brain('normal'), frames = framing([[6, 10], [3, 20], [2, 60], [5, 120], [4, 600]]);
    const tacs = K.regionTACs(ph, program('FDG', 'F18', 185e6, frames), {});
    const fm = K.frameMeans(tacs, frames), cp = K.framePlasma(tacs, frames), t = mid(frames);
    // a pure 2TCi model (no blood volume) against its Ki
    const dt = 2, n = 1801, tg = new Float64Array(n); for (let i = 0; i < n; i++) tg[i] = i * dt;
    for (const m of [{ model: '2tci', K1: 0.102, k2: 0.130, k3: 0.062, vb: 0 }, { model: '2tci', K1: 0.054, k2: 0.109, k3: 0.028, vb: 0 }]) {
        const r = K.tissue(m, K.input('FDG').cp, tg);
        const f2 = K.frameMeans({ t: tg, dt, isotope: 'F18', regions: [r.ct, r.cp] }, frames);
        const p = K.patlak(t, Float64Array.from(f2.map(v => v[0])), Float64Array.from(f2.map(v => v[1])), 20 * 60), Ki = K.derived(m).Ki;
        ok(Math.abs(p.Ki / Ki - 1) < 0.05, 'Patlak recovers Ki of a 2TCi model within 5 % (' + p.Ki.toFixed(4) + ' vs ' + Ki.toFixed(4) + ')');
        ok(p.r2 > 0.99 && p.x.length === p.y.length && p.fitFrom > 0 && p.fitFrom < p.x.length, 'Patlak plot points and fit');
    }
    // the phantom's regions carry blood volume: Patlak then recovers the
    // influx per mL of voxel, (1 - vb) Ki
    for (const id of ['gm_frontal', 'wm', 'gm_temporal']) {
        const ct = Float64Array.from(fm.map(v => v[idx(ph, id)]));
        const p = K.patlak(t, ct, cp, 20 * 60), d = K.derived(K.params('FDG', id, 'normal'));
        ok(Math.abs(p.Ki / d.KiVoxel - 1) < 0.05, 'Patlak Ki for ' + id + ' within 5 % of (1 - vb) Ki (' + p.Ki.toFixed(4) + ' vs ' + d.KiVoxel.toFixed(4) + ')');
    }
    // the input arrives 15 s after injection, so the first frame is skipped
    const p = K.patlak(t, Float64Array.from(fm.map(v => v[idx(ph, 'gm_frontal')])), cp, 1200);
    ok(p.t[0] > 0 && p.x.every(isFinite) && p.y.every(isFinite), 'Patlak skips frames with no plasma activity');
}

// Logan with a reference region recovers DVR
{
    const frames = framing([[4, 15], [8, 30], [9, 60], [2, 180], [10, 300]]), t = mid(frames);
    // a pure 2TC target against a pure 1TC reference with the same VND
    const dt = 2, n = Math.round(frames[frames.length - 1].t1 / dt) + 1, tg = new Float64Array(n);
    for (let i = 0; i < n; i++) tg[i] = i * dt;
    const cp = K.input('PiB').cp;
    for (const [k3, k4] of [[0.225, 0.15], [0.12, 0.08], [0.03, 0.15]]) {
        const tgt = K.tissue({ model: '2tcr', K1: 0.25, k2: 0.125, k3, k4, vb: 0 }, cp, tg).ct;
        const ref = K.tissue({ model: '1tc', K1: 0.25, k2: 0.125, vb: 0 }, cp, tg).ct;
        const fm = K.frameMeans({ t: tg, dt, isotope: 'C11', regions: [tgt, ref] }, frames);
        const L = K.logan(t, Float64Array.from(fm.map(v => v[0])), Float64Array.from(fm.map(v => v[1])), 0.125, 35 * 60);
        const dvr = 1 + k3 / k4;
        ok(Math.abs(L.DVR / dvr - 1) < 0.07, 'Logan DVR ' + L.DVR.toFixed(3) + ' vs true ' + dvr.toFixed(3) + ' (within 7 %)');
        ok(L.x.length === L.y.length && L.r2 > 0.99, 'Logan plot is linear after t*');
        near(L.BPND, L.DVR - 1, 1e-12, 'Logan BPND = DVR - 1');
    }
    // and on the phantom's own PiB curves (with blood volume), within 10 %
    const ph = brain('ad'), tacs = K.regionTACs(ph, program('PiB', 'C11', 400e6, frames), {});
    const fm = K.frameMeans(tacs, frames), col = id => Float64Array.from(fm.map(v => v[idx(ph, id)]));
    const L = K.logan(t, col('gm_frontal'), col('cereb_gm'), K.params('PiB', 'cereb_gm', 'ad').k2, 35 * 60);
    ok(Math.abs(L.DVR / 2.5 - 1) < 0.1, 'Logan DVR on the AD phantom ' + L.DVR.toFixed(3) + ' vs 2.5 (within 10 %)');
    const sr = K.windowRatio(tacs, idx(ph, 'gm_frontal'), idx(ph, 'cereb_gm'), 3000, 4200);
    ok(Math.abs(L.DVR - 2.5) < Math.abs(sr - 2.5), 'Logan is closer to the true DVR than SUVR (' + sr.toFixed(2) + ')');
}

// regionTACs: solution phantoms, the brain, grid and errors
{
    const cyl = PET.phantoms.build('cylinder'), prog = program(null, 'F18', 40e6, [{ t0: 0, t1: 600 }]);
    const tc = K.regionTACs(cyl, prog, {}), iw = idx(cyl, 'water');
    const V = cyl.regions[iw].volume;
    near(tc.regions[iw][0], 40e6 / V, 1e-6, 'cylinder concentration = dose / volume');
    near(tc.regions[iw][0], 6370, 60, 'cylinder about 6.4 kBq/mL for 40 MBq');
    ok(tc.regions[idx(cyl, 'wall')].every(v => v === 0) && tc.plasma.every(v => v === 0), 'no activity in the wall, no plasma');
    ok(tc.t[0] === 0 && tc.dt === 2 && tc.t[tc.t.length - 1] >= 600 && tc.t.length === 301, 'grid 0..scanEnd step 2 s');
    ok(K.regionTACs(cyl, program(null, 'F18', 1e6, [{ t0: 0, t1: 10 }]), { dt: 5 }).t.length === 13, 'grid runs to at least 60 s, step from opts');
    const sp = PET.phantoms.build('spheres', { ratio: 8 }), ts = K.regionTACs(sp, program(null, 'F18', 50e6, [{ t0: 0, t1: 600 }]), {});
    const bg = ts.regions[idx(sp, 'background')][10];
    near(ts.regions[idx(sp, 'sphere10')][10] / bg, 8, 1e-9, 'hot spheres at the chosen ratio');
    ok(ts.regions[idx(sp, 'sphere37')][10] === 0 && ts.regions[idx(sp, 'lung')][10] === 0, 'cold spheres and lung empty');
    let total = 0; sp.regions.forEach((r, i) => { total += ts.regions[i][10] * r.volume; });
    near(total / 50e6, 1, 1e-9, 'activity in the phantom adds up to the dose');

    const ph = brain('normal'), tb = K.regionTACs(ph, program('FDG', 'F18', 185e6, [{ t0: 2700, t1: 3300 }]), {});
    ok(tb.regions.length === ph.regions.length && tb.tracer === 'FDG' && tb.condition === 'normal', 'one TAC per region');
    const is = idx(ph, 'sinus');
    ok(tb.regions[is].every((v, i) => Math.abs(v - tb.plasma[i]) < 1e-9), 'the sinus curve is the plasma curve');
    ok(['csf', 'ventricles', 'skull', 'air'].every(id => tb.regions[idx(ph, id)].every(v => v === 0)), 'CSF, ventricles, skull and air stay empty');
    const tAD = K.regionTACs(ph, program('FDG', 'F18', 185e6, [{ t0: 2700, t1: 3300 }]), { condition: 'ad' });
    ok(tAD.condition === 'ad' && tAD.regions[idx(ph, 'gm_temporal')][1500] < tb.regions[idx(ph, 'gm_temporal')][1500], 'opts.condition overrides the phantom');
    let msg = '';
    try { K.regionTACs(ph, program(null, 'F18', 185e6, [{ t0: 0, t1: 600 }]), {}); } catch (e) { msg = e.message; }
    ok(msg === 'The brain phantom needs a tracer: add a tracer line such as tracer FDG', 'brain without a tracer throws a clear error');
    msg = ''; try { K.regionTACs(ph, program('none', 'F18', 185e6, [{ t0: 0, t1: 600 }]), {}); } catch (e) { msg = e.message; }
    ok(/needs a tracer/.test(msg), 'tracer none on the brain throws too');
}

// frameMeans: frames before injection, decay weighting
{
    const cyl = PET.phantoms.build('cylinder'), tc = K.regionTACs(cyl, program(null, 'O15', 1e6, [{ t0: -60, t1: 60 }]), {});
    const iw = idx(cyl, 'water'), c = tc.regions[iw][0];
    const plain = K.frameMeans(tc, [{ t0: -60, t1: 60 }], { decayWeighted: false })[0][iw];
    near(plain / c, 0.5, 1e-9, 'a frame half before injection averages half the concentration');
    const dw = K.frameMeans(tc, [{ t0: -60, t1: 60 }])[0][iw], I = PET.isotopes;
    near(dw / c, I.decayIntegral('O15', 0, 60) / I.decayIntegral('O15', -60, 60), 1e-4, 'decay-weighted mean, as a decay-corrected image shows');
    near(K.frameMeans(tc, [{ t0: 0, t1: 60 }])[0][iw] / c, 1, 1e-4, 'a constant curve averages to itself');
    ok(K.frameMeans(tc, [{ t0: -120, t1: -60 }])[0][iw] === 0, 'a frame before injection has nothing');
}

// SUV and SUVR helpers
{
    near(K.suv(185e6 / 70000, 185e6, 70), 1, 1e-12, 'SUV of dose/weight is 1');
    const a = K.suv(Float64Array.from([0, 2643]), 185e6, 70);
    ok(a.length === 2 && Math.abs(a[1] - 1) < 1e-3, 'SUV of an array');
    near(K.suvr(3, 2), 1.5, 1e-12, 'SUVR of numbers');
    const r = K.suvr(Float64Array.from([2, 4]), Float64Array.from([1, 0]));
    ok(r[0] === 2 && r[1] === 0, 'SUVR of arrays, 0 where the reference is empty');
}

summary('kinetics');
