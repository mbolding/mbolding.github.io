/* Tests for js/dsl.js and js/presets.js.
     node tests/test_dsl.js

   The k-space checks integrate the compiled gradient waveforms with
   MRI.dsl.gradientArea, independently of the imaging engine: k is reset
   to zero at the centre of each excitation, negated at the centre of
   each refocusing pulse, and otherwise advances by gammaBar * integral G dt. */
'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core', 'dsl', 'presets']);
const D = MRI.dsl, P = MRI.presets, K = MRI.const;
const GB = K.GAMMA_BAR;
const US = 1e-6;

/* ---------- helpers ---------- */
function compile(src, opts) { return D.compile(src, opts); }
function compileOk(src, opts, label) {
    const r = D.compile(src, opts);
    ok(r.ok, (label || 'program') + ' compiles' + (r.ok ? '' : ': ' + JSON.stringify(r.errors)));
    return r;
}
function param(prog, name) { const p = prog.params.find(q => q.name === name); return p ? p.value : undefined; }
function lineOf(src, needle) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(needle) >= 0) return i + 1;
    return -1;
}
// Nominal k (cycles/m) at time t with the one-pathway rule.
function kAt(prog, t) {
    let exc = -1;
    for (let i = 0; i < prog.rf.length && prog.rf[i].t <= t; i++) if (prog.rf[i].role === 'excite') exc = i;
    if (exc < 0) return null;
    const k = { x: 0, y: 0, z: 0 };
    let tPrev = prog.rf[exc].t;
    for (let i = exc + 1; i < prog.rf.length && prog.rf[i].t < t; i++) {
        if (prog.rf[i].role !== 'refocus') continue;
        for (const ax of 'xyz') k[ax] = -(k[ax] + GB * D.gradientArea(prog, ax, tPrev, prog.rf[i].t));
        tPrev = prog.rf[i].t;
    }
    for (const ax of 'xyz') k[ax] += GB * D.gradientArea(prog, ax, tPrev, t);
    return { k, exc: prog.rf[exc] };
}
function firstError(r) { return r.ok ? null : r.errors[0]; }

/* ---------- 1. Every preset compiles, and quickly ---------- */
const expectedIds = ['first', 'gre_t1', 'gre_t2s', 'se', 'se_t1', 'stir', 'flair', 'tse', 'epi', 'se_epi',
    'radial', 'gre_pf', 'gre_r2', 'gre_fatsat', 'fid', 'fid_ws'];
ok(Array.isArray(P) && typeof P.get === 'function', 'MRI.presets is an array with get()');
ok(P.defaultId === 'se' && P.get('se') && P.get('se').id === 'se', 'default preset is se');
ok(P.get('nonexistent') === null, 'presets.get returns null for an unknown id');
for (const id of expectedIds) ok(!!P.get(id), 'preset ' + id + ' exists');
const compiled = {};
const timing = [];
for (const p of P) {
    ok(p.group === 'imaging' || p.group === 'spectroscopy', p.id + ' has a group');
    ok(typeof p.name === 'string' && p.name && typeof p.summary === 'string' && p.summary, p.id + ' has a name and summary');
    ok(p.source.indexOf('\u2014') < 0, p.id + ' source has no em dash');
    // First (cold) compile time is reported; the assertion uses the better of
    // a cold and a warm run so a busy machine does not make the test flaky.
    let t0 = process.hrtime.bigint();
    const r = D.compile(p.source);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    D.compile(p.source);
    const ms2 = Number(process.hrtime.bigint() - t0) / 1e6;
    timing.push(p.id + ' ' + ms.toFixed(1) + '/' + ms2.toFixed(1) + ' ms');
    ok(r.ok, 'preset ' + p.id + ' compiles' + (r.ok ? '' : ': ' + JSON.stringify(r.errors)));
    ok(Math.min(ms, ms2) < 50, 'preset ' + p.id + ' compiles in under 50 ms (' + ms.toFixed(1) + ' ms cold, ' + ms2.toFixed(1) + ' ms warm)');
    compiled[p.id] = r;
    if (r.ok && p.group === 'imaging') {
        for (const name of ['TR', 'FOV', 'N', 'BW']) ok(param(r, name) !== undefined, p.id + ' declares ' + name);
        if (p.id !== 'tse' && p.id !== 'flair') ok(param(r, 'TE') !== undefined, p.id + ' declares TE');
        for (const q of r.params) ok(q.min !== null && q.max !== null && q.description, p.id + ': ' + q.name + ' has a range and a description');
    }
}
console.log('  compile times (cold/warm): ' + timing.join(', '));
{
    // The 256-line spin echo, warm, best of three.
    const src = P.get('se').source;
    D.compile(src, { overrides: { N: 256 } });
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
        const t0 = process.hrtime.bigint();
        const r = D.compile(src, { overrides: { N: 256 } });
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
        ok(r.ok && r.stats.nAdc === 256, '256-line spin echo compiles with 256 ADCs');
    }
    console.log('  256-line spin echo: ' + best.toFixed(1) + ' ms');
    ok(best < 50, '256-line spin echo compiles in under 50 ms (' + best.toFixed(1) + ' ms)');
}

/* ---------- 2. Cartesian imaging presets: TE, k-space coverage, periods ---------- */
function checkCartesian(id, o) {
    const prog = compiled[id];
    if (!prog || !prog.ok) { ok(false, id + ' not compiled'); return; }
    const N = param(prog, 'N'), FOV = param(prog, 'FOV'), TR = param(prog, 'TR');
    const real = prog.adc.filter(a => !a.dummy);
    ok(real.length === o.lines.length, id + ': ' + o.lines.length + ' non-dummy ADCs (got ' + real.length + ')');
    const seen = new Map();
    let maxKx = 0, maxKz = 0, maxTeErr = 0, maxLineErr = 0, varsMatch = true, centreTE = null;
    for (const a of real) {
        const r = kAt(prog, a.tc);
        maxKx = Math.max(maxKx, Math.abs(r.k.x * FOV));
        maxKz = Math.max(maxKz, Math.abs(r.k.z * prog.image.thickness));
        const Lf = r.k.y * FOV + Math.floor(N / 2);
        const L = Math.round(Lf);
        maxLineErr = Math.max(maxLineErr, Math.abs(Lf - L));
        seen.set(L, (seen.get(L) || 0) + 1);
        const te = a.tc - r.exc.t;
        if (o.teAll !== undefined) maxTeErr = Math.max(maxTeErr, Math.abs(te - o.teAll));
        if (L === Math.floor(N / 2)) centreTE = te;
        if (o.lineVar && a.vars[o.lineVar] !== L) varsMatch = false;
        if (o.lineOf && o.lineOf(a.vars) !== L) varsMatch = false;
    }
    ok(maxKx < 1e-6, id + ': kx = 0 at every centre sample (max |kx|*FOV ' + maxKx.toExponential(2) + ')');
    ok(maxKz < 1e-6, id + ': kz = 0 at every centre sample, the slice gradient is rephased (max ' + maxKz.toExponential(2) + ')');
    ok(maxLineErr < 1e-6, id + ': ky at centre samples is a whole number of steps (max error ' + maxLineErr.toExponential(2) + ')');
    const want = new Set(o.lines);
    let setOk = seen.size === want.size;
    for (const [L, c] of seen) if (!want.has(L) || c !== 1) setOk = false;
    ok(setOk, id + ': ky values are exactly (line - N/2)/FOV for the expected lines, each once');
    if (o.lineVar || o.lineOf) ok(varsMatch, id + ': each ADC lands on the line its loop variables say');
    if (o.teAll !== undefined) ok(maxTeErr <= 1 * US, id + ': echo time equals ' + (o.teAll * 1e3) + ' ms within 1 us (max error ' + (maxTeErr / US).toFixed(3) + ' us)');
    if (o.teCentre !== undefined) near(centreTE, o.teCentre, 1 * US, id + ': echo time of the centre line');
    if (TR !== undefined && o.periods !== undefined) {
        ok(prog.periods.length === o.periods, id + ': ' + o.periods + ' periods (got ' + prog.periods.length + ')');
        let maxSp = 0;
        for (let i = 1; i < prog.periods.length; i++) maxSp = Math.max(maxSp, Math.abs(prog.periods[i].t0 - prog.periods[i - 1].t0 - TR));
        ok(maxSp <= 1 * US, id + ': periods are spaced by TR (max error ' + (maxSp / US).toFixed(3) + ' us)');
        const nd = prog.image.dummies;
        ok(prog.periods.slice(0, nd).every(p => p.dummy) && prog.periods.slice(nd).every(p => !p.dummy), id + ': the first ' + nd + ' periods are dummies');
        near(prog.stats.TR, TR, 1e-12, id + ': stats.TR');
    }
    ok(near0(prog.stats.TE - (o.teAll !== undefined ? o.teAll : o.teCentre), 1 * US), id + ': stats.TE is the echo time of the k-space centre');
    return prog;
}
function near0(x, tol) { return Math.abs(x) <= tol; }
const range = (a, b, s) => { const out = []; for (let i = a; i <= b; i += (s || 1)) out.push(i); return out; };

{
    const se = compiled.se, N = param(se, 'N');
    checkCartesian('se', { lines: range(0, N - 1), teAll: param(se, 'TE'), periods: N + 2, lineVar: 'line' });
    checkCartesian('se_t1', { lines: range(0, 127), teAll: param(compiled.se_t1, 'TE'), periods: 130, lineVar: 'line' });
    checkCartesian('gre_t1', { lines: range(0, 127), teAll: param(compiled.gre_t1, 'TE'), periods: 132, lineVar: 'line' });
    checkCartesian('gre_t2s', { lines: range(0, 127), teAll: param(compiled.gre_t2s, 'TE'), periods: 132, lineVar: 'line' });
    checkCartesian('first', { lines: range(0, 63), teAll: param(compiled.first, 'TE'), periods: 68, lineVar: 'line' });
    checkCartesian('gre_fatsat', { lines: range(0, 127), teAll: param(compiled.gre_fatsat, 'TE'), periods: 132, lineVar: 'line' });
    checkCartesian('stir', { lines: range(0, 127), teAll: param(compiled.stir, 'TE'), periods: 130, lineVar: 'line' });
    // Partial Fourier: lines 3N/8 .. N-1, 5/8 of them. R = 2: every other line.
    checkCartesian('gre_pf', { lines: range(48, 127), teAll: param(compiled.gre_pf, 'TE'), periods: 84, lineVar: 'line' });
    ok(compiled.gre_pf.stats.nAdc === 128 * 5 / 8, 'gre_pf records 5/8 of the lines');
    checkCartesian('gre_r2', { lines: range(0, 126, 2), teAll: param(compiled.gre_r2, 'TE'), periods: 68, lineVar: 'line' });
    // Turbo spin echo with linear ordering: line = e*shots + shot, centre line at (ETL/2 + 1) * ESP.
    for (const id of ['tse', 'flair']) {
        const p = compiled[id], ETL = param(p, 'ETL'), ESP = param(p, 'ESP'), shots = 128 / ETL;
        checkCartesian(id, { lines: range(0, 127), teCentre: (ETL / 2 + 1) * ESP, periods: shots + 1, lineOf: v => v.e * shots + v.shot });
        near(p.lets.TEeff, (ETL / 2 + 1) * ESP, 1e-12, id + ': TEeff let');
        // every echo of a train at (e + 1) * ESP
        let maxErr = 0;
        for (const a of p.adc.filter(x => !x.dummy)) maxErr = Math.max(maxErr, Math.abs(a.tc - kAt(p, a.tc).exc.t - (a.vars.e + 1) * ESP));
        ok(maxErr <= US, id + ': echo e at (e + 1) * ESP');
        near(p.stats.echoSpacing, ESP, US, id + ': stats.echoSpacing');
    }
    near(compiled.flair.stats.TI, param(compiled.flair, 'TI'), US, 'flair: stats.TI');
    near(compiled.stir.stats.TI, param(compiled.stir, 'TI'), US, 'stir: stats.TI');
}

/* ---------- 3. EPI ---------- */
for (const id of ['epi', 'se_epi']) {
    const p = compiled[id], N = param(p, 'N'), ESP = param(p, 'ESP'), TE = param(p, 'TE');
    checkCartesian(id, { lines: range(0, N - 1), teCentre: TE, periods: 1 + 2, lineVar: 'line' });
    const real = p.adc.filter(a => !a.dummy);
    let polOk = true, espErr = 0;
    real.forEach((a, i) => {
        const g = D.gradientAt(p, 'x', a.tc);
        if (Math.sign(g) !== (i % 2 ? -1 : 1)) polOk = false;
        if (i) espErr = Math.max(espErr, Math.abs(a.tc - real[i - 1].tc - ESP));
    });
    ok(polOk, id + ': readout polarity alternates, line 0 positive');
    ok(espErr <= US, id + ': echoes are ESP apart');
    ok(real.every(a => a.n === N && Math.abs(a.n * a.dwell - 1 / param(p, 'BW')) < 1e-12), id + ': no oversampling, n = N and n*dwell = 1/BW');
    // One excitation for the whole of k-space.
    const excs = new Set(real.map(a => kAt(p, a.tc).exc.t));
    ok(excs.size === 1, id + ': single shot');
    // On a reversed line the samples run from +kmax to -kmax: sample j of line 1 at -(j - N/2) steps.
    const a1 = real[1], dk = 1 / param(p, 'FOV');
    let revOk = true;
    for (const j of [0, 5, N / 2, N - 1]) {
        const kx = kAt(p, a1.t0 + j * a1.dwell).k.x;
        if (Math.abs(kx / dk + (j - N / 2)) > 1e-6) revOk = false;
    }
    ok(revOk, id + ': odd lines traverse kx backwards with the same sample positions');
}
{
    const src = P.get('epi').source;
    const r = compile(src, { overrides: { ESP: 0.3e-3 } });
    const e = firstError(r);
    ok(!r.ok && e && /ESP = 0\.3 ms is too short/.test(e.msg), 'epi: ESP 0.3 ms is too short (' + (e && e.msg) + ')');
    ok(e && /Increase ESP by at least/.test(e.hint), 'epi: the hint says to increase ESP (' + (e && e.hint) + ')');
    ok(e && e.line === lineOf(src, 'gx readout * (-1)^line'), 'epi: the ESP error points at the readout line');
    const m = e && /minimum ESP about ([\d.]+) ms/.exec(e.hint);
    ok(m && compile(src, { overrides: { ESP: Number(m[1]) * 1e-3 } }).ok, 'epi: the suggested minimum ESP compiles');
    ok(m && !compile(src, { overrides: { ESP: Number(m[1]) * 1e-3 - 0.01e-3 } }).ok, 'epi: 10 us less than the suggested ESP does not');
}

/* ---------- 4. Radial ---------- */
{
    const p = compiled.radial, spokes = param(p, 'spokes'), FOV = param(p, 'FOV'), os = p.image.oversample;
    ok(p.image.readoutAxis === 'radial', 'radial: readoutAxis is radial');
    const real = p.adc.filter(a => !a.dummy);
    ok(real.length === spokes, 'radial: one ADC per spoke');
    let k0 = 0, dirErr = 0, magErr = 0;
    for (const a of real) {
        const th = Math.PI * a.vars.s / spokes;
        const c = kAt(p, a.tc).k;
        k0 = Math.max(k0, Math.hypot(c.x, c.y) * FOV);
        const k = kAt(p, a.tc + 10 * a.dwell).k;
        const m = Math.hypot(k.x, k.y);
        dirErr = Math.max(dirErr, Math.abs(k.x / m - Math.cos(th)), Math.abs(k.y / m - Math.sin(th)));
        magErr = Math.max(magErr, Math.abs(m - 10 / (os * FOV)) * FOV);
    }
    ok(k0 < 1e-6, 'radial: every spoke passes through k = 0 at its centre sample');
    ok(dirErr < 1e-9, 'radial: each spoke points at angle pi*s/spokes');
    ok(magErr < 1e-6, 'radial: sample spacing along a spoke is 1/(os*FOV)');
    near(p.stats.TE, param(p, 'TE'), US, 'radial: TE');
}

/* ---------- 5. Spectroscopy ---------- */
for (const id of ['fid', 'fid_ws']) {
    const p = compiled[id];
    const delay = param(p, 'delay'), SW = param(p, 'SW'), NP = param(p, 'NP'), NA = param(p, 'NA');
    ok(p.image.readoutAxis === null && p.image.hasImaging === false, id + ': no imaging');
    ok(p.stats.nAdc === NA, id + ': NA transients recorded');
    ok(p.adc.filter(a => a.dummy).length === 2, id + ': two dummy transients');
    let anchorOk = true, delayErr = 0, gradOk = true;
    for (const a of p.adc) {
        if (a.anchor !== 'start' || a.n !== NP || Math.abs(a.dwell - 1 / SW) > 1e-15) anchorOk = false;
        const exc = kAt(p, a.t0).exc;
        delayErr = Math.max(delayErr, Math.abs(a.t0 - exc.t - delay));
        const t1 = a.t0 + a.n * a.dwell;
        for (const ax of 'xyz') {
            if (D.gradientArea(p, ax, a.t0, t1) !== 0) gradOk = false;
            for (let i = 0; i <= 20; i++) if (D.gradientAt(p, ax, a.t0 + (t1 - a.t0) * i / 20) !== 0) gradOk = false;
        }
    }
    ok(anchorOk, id + ': ADC anchor is start, with NP points at dwell 1/SW');
    ok(delayErr <= US, id + ': first sample at delay after the pulse centre (max error ' + (delayErr / US).toFixed(3) + ' us)');
    ok(gradOk, id + ': no gradients during the ADC');
    const exc = p.rf.filter(r => r.role === 'excite');
    ok(exc.length === NA + 2 && exc.every(r => r.shape === 'hard' && r.select === 'none' && Math.abs(r.dur - 0.1e-3) < 1e-12), id + ': hard 0.1 ms excitation every TR');
}
{
    const p = compiled.fid_ws;
    const w = p.rf.filter(r => r.select === 'water');
    ok(w.length === 2 * 18 && w.every(r => r.role === 'saturate' && r.shape === 'gauss' && r.offsetHz === 0), 'fid_ws: water pulses are saturation pulses centred on water');
    near(w[0].bw, 1.6 / 20e-3, 1e-9, 'fid_ws: CHESS bandwidth defaults to 1.6/dur');
    ok(w[0].flip === 90 && w[1].flip === 100, 'fid_ws: CHESS flips 90 then 100');
    ok(p.spoil.length === 2 * 18, 'fid_ws: a spoiler after each CHESS pulse');
}

/* ---------- 6. Role inference and RF fields ---------- */
{
    const stir = compiled.stir.rf.filter(r => !r.dummy);
    ok(stir[0].role === 'invert' && stir[0].flip === 180 && stir[0].label === 'inv', 'stir: the first 180 is an inversion');
    ok(stir[1].role === 'excite' && stir[2].role === 'refocus', 'stir: then excitation and refocusing');
    const se = compiled.se.rf;
    ok(se[0].role === 'excite' && se[1].role === 'refocus' && se[1].phase === 90 && se[1].shape === 'sinc' && se[1].select === 'slice', 'se: the 180 is a refocusing pulse with phase 90');
    const fl = compiled.flair.rf.filter(r => !r.dummy);
    ok(fl[0].shape === 'sech' && fl[0].role === 'invert', 'flair: adiabatic inversion');
    ok(fl.slice(2, 18).every(r => r.role === 'refocus'), 'flair: the echo train is refocusing pulses');
    const fs = compiled.gre_fatsat.rf.find(r => r.select === 'fat');
    ok(fs && fs.role === 'saturate' && Math.abs(fs.offsetHz - K.FAT_HZ) < 1e-9 && Math.abs(fs.bw - 200) < 1e-9, 'gre_fatsat: fat pulse saturates at the fat frequency, 200 Hz wide');
    // A 180 after a spoil, with no excitation since, is an inversion again.
    const r = compileOk('rf 90 hard\nrf 180 hard\nspoil\nrf 180 hard\nrf 150 hard excite\nrf 60 water', {}, 'role program');
    ok(r.rf.map(x => x.role).join() === 'excite,refocus,invert,excite,saturate', 'role inference after spoil and explicit roles: ' + r.rf.map(x => x.role).join());
    // Slice-select: amplitude (4/dur)/(gammaBar*thickness), flat = RF duration, RF starts after the ramp.
    const g = compiled.se.grad.z.find(t => t.tag === 'slice'), rf0 = compiled.se.rf[0];
    near(g.amp, (4 / 2e-3) / (GB * 5e-3), 1e-12, 'slice-select amplitude');
    near(g.flat, rf0.dur, 1e-12, 'slice-select flat top equals the RF duration');
    near(rf0.t0, g.t0 + g.rise, 1e-12, 'the RF starts when the ramp ends');
    near(rf0.t, rf0.t0 + rf0.dur / 2, 1e-12, 'rf.t is the pulse centre');
    near(g.rise, Math.ceil(g.amp / K.SLEW / 1e-5) * 1e-5, 1e-12, 'the slice-select ramp is at the slew limit, on the raster');
}

/* ---------- 7. Waveform rules for every preset ---------- */
for (const id of expectedIds) {
    const p = compiled[id];
    if (!p || !p.ok) continue;
    let gOk = true, sOk = true, rOk = true, order = true, q = true;
    for (const ax of 'xyz') {
        const arr = p.grad[ax];
        for (let i = 0; i < arr.length; i++) {
            const t = arr[i];
            if (Math.abs(t.amp) > K.GMAX * (1 + 1e-9)) gOk = false;
            if (t.rise > 0 && Math.abs(t.amp) / t.rise > K.SLEW * (1 + 1e-6)) sOk = false;
            if (Math.abs(t.rise * 1e5 - Math.round(t.rise * 1e5)) > 1e-6 || t.rise !== t.fall) rOk = false;
            if (Math.abs(t.t0 * 1e6 - Math.round(t.t0 * 1e6)) > 1e-6) q = false;
            if (i && arr[i - 1].t0 + arr[i - 1].rise + arr[i - 1].flat + arr[i - 1].fall > t.t0 + 1e-12) order = false;
        }
    }
    for (const b of p.blocks) if (Math.abs(b.t0 * 1e6 - Math.round(b.t0 * 1e6)) > 1e-6) q = false;
    for (const r of p.rf) if (Math.abs(r.t0 * 1e6 - Math.round(r.t0 * 1e6)) > 1e-6) q = false;
    for (const a of p.adc) if (Math.abs(a.t0 * 1e6 - Math.round(a.t0 * 1e6)) > 1e-6) q = false;
    ok(gOk, id + ': every gradient within GMAX');
    ok(sOk, id + ': every ramp within the slew limit');
    ok(rOk, id + ': ramps on the 10 us raster, rise = fall');
    ok(order, id + ': trapezoids sorted and non-overlapping on each axis');
    ok(q, id + ': start times quantised to 1 us');
    ok(p.blocks.every((b, i) => i === 0 || b.t0 >= p.blocks[i - 1].t0 + p.blocks[i - 1].dur - 1e-12), id + ': blocks do not overlap');
    ok(p.adc.every(a => Math.abs(a.tc - (a.t0 + Math.floor(a.n / 2) * a.dwell)) < 1e-15), id + ': adc.tc = t0 + floor(n/2)*dwell');
    near(p.scanTime, p.duration * p.image.averages, 1e-9, id + ': scanTime = duration * averages');
}

/* ---------- 8. gradientArea is exact, gradientAt is consistent ---------- */
{
    const p = compiled.se;
    const T = p.periods[3].t0, T1 = T + 0.1;
    for (const ax of 'xyz') {
        const n = 400000, h = (T1 - T) / n;
        let s = 0;
        for (let i = 0; i < n; i++) s += D.gradientAt(p, ax, T + (i + 0.5) * h) * h;   // midpoint rule
        const exact = D.gradientArea(p, ax, T, T1);
        ok(Math.abs(s - exact) < 2e-9 * 1e-3 + 1e-4 * Math.abs(exact), 'gradientArea matches numerical integration on g' + ax + ' (' + exact.toExponential(4) + ' vs ' + s.toExponential(4) + ')');
        near(D.gradientArea(p, ax, T1, T), -exact, 1e-18, 'gradientArea is antisymmetric on g' + ax);
        const mid = T + 0.0377;
        near(D.gradientArea(p, ax, T, mid) + D.gradientArea(p, ax, mid, T1), exact, 1e-15, 'gradientArea is additive on g' + ax);
    }
    // Shapes of the named trapezoids.
    const thk = p.image.thickness, FOV = param(p, 'FOV');
    const sp = p.grad.x.find(t => t.tag === 'spoil');
    near(sp.amp * (sp.rise + sp.flat), 4 / (GB * thk), 1e-15, 'spoil area is 4/(gammaBar*thickness)');
    ok(sp.flat > 0 && sp.amp <= K.GMAX, 'spoil is a plateau trapezoid at or below GMAX (its area exceeds GMAX^2/SLEW)');
    const pre = p.grad.x.find(t => t.tag === 'prephase');
    ok(pre.flat === 0, 'the readout prephaser is a triangle (its area is below GMAX^2/SLEW)');
    const ro = p.grad.x.find(t => t.tag === 'readout'), a0 = p.adc[0];
    near(pre.amp * pre.rise, ro.amp * ro.rise / 2 + ro.amp * Math.floor(a0.n / 2) * a0.dwell, 1e-15, 'prephase area: ramp-up area plus G*floor(n/2)*dwell (sign flipped by the 180)');
    near(ro.amp, 128 * 150 / (GB * FOV), 1e-12, 'readout amplitude N*BW/(gammaBar*FOV)');
    near(ro.flat, a0.n * a0.dwell, 1e-15, 'readout flat top equals the ADC duration');
    near(a0.t0, ro.t0 + ro.rise, 1e-12, 'the ADC starts on the flat top');
    const rp = p.grad.z.find(t => t.tag === 'rephase'), sl = p.grad.z.find(t => t.tag === 'slice');
    near(rp.amp * (rp.rise + rp.flat), -(sl.amp * sl.flat / 2 + sl.amp * sl.fall / 2), 1e-15, 'rephase area');
    const enc = p.grad.y.filter(t => t.tag === 'encode' && t.period < 10);
    ok(enc.length > 3 && enc.every(t => t.rise === enc[0].rise && t.flat === enc[0].flat), 'every encode on an axis has the same timing');
    const bl = compiled.epi.grad.y.find(t => t.tag === 'blip');
    near(bl.amp * (bl.rise + bl.flat), 1 / (param(compiled.epi, 'FOV') * GB), 1e-18, 'blip area is 1/(FOV*gammaBar)');
    // Explicit trapezoid and crusher.
    const r = compileOk('gx 10 mT/m for 2 ms\ngz crush\nfor i in 0 .. 1\n    gy -5 mT/m for 1 ms\nend', {}, 'explicit gradients');
    const gx = r.grad.x[0];
    ok(gx.rise === 5e-5 && gx.flat === 2e-3 && gx.amp === 0.01 && gx.tag === 'manual', 'gx 10 mT/m for 2 ms: 50 us ramps, 2 ms flat');
    ok(r.grad.y.length === 2 && r.grad.y[0].amp === -0.005, '"for" works both as a loop and as AMP for DUR');
    const cr = r.grad.z[0];
    near(cr.amp * (cr.rise + cr.flat), 2 / (GB * 5e-3), 1e-15, 'crush area is 2/(gammaBar*thickness)');
    near(D.gradientAt(r, 'x', gx.t0 + gx.rise / 2), 0.005, 1e-15, 'gradientAt on the ramp');
    near(D.gradientAt(r, 'x', gx.t0 + 1e-3), 0.01, 1e-15, 'gradientAt on the plateau');
    ok(D.gradientAt(r, 'x', -1) === 0 && D.gradientAt(r, 'x', 10) === 0, 'gradientAt is zero outside the waveform');
}

/* ---------- 9. Dummies, labels, periods ---------- */
{
    const p = compiled.se;
    const dm = p.adc.filter(a => a.dummy);
    ok(dm.length === 2 && dm.every(a => a.vars.line === 0), 'se: two dummy ADCs using the first iteration\'s line');
    ok(p.rf.filter(r => r.dummy).length === 4 && p.blocks.filter(b => b.dummy).length === 10, 'se: dummy RF and blocks flagged');
    ok(p.periods[2].vars.line === 0 && p.periods[3].vars.line === 1, 'periods carry the loop variables');
    ok(p.adc.every(a => p.periods[a.period].t0 <= a.t0 && a.t0 < p.periods[a.period].t0 + p.periods[a.period].dur), 'every ADC lies in its period');
    // Labels are times measured from the period start.
    const r = compileOk('param TR = 100 ms\nrepeat 3 every TR\n    wait 7 ms\n    rf 90 hard as a\n    adc 8 dwell 10 us at a + 5 ms\nend', {}, 'label program');
    ok(r.adc.length === 3 && r.adc.every((x, i) => Math.abs(x.t0 - (i * 0.1 + 0.00725 + 0.005)) < 1e-9), 'labels are relative to the current period');
    ok(r.periods.length === 3 && r.periods.every((x, i) => x.index === i && Math.abs(x.dur - 0.1) < 1e-12), 'one period per every-loop pass');
    near(r.duration, 0.3, 1e-12, 'after an every-loop the time moves to the end of the last period');
    const one = compileOk('rf 90 hard as x\nadc 100 dwell 10 us', {}, 'program without a loop');
    ok(one.periods.length === 1 && one.periods[0].t0 === 0 && Math.abs(one.periods[0].dur - one.duration) < 1e-15 && one.adc[0].period === 0, 'a single pseudo-period without every-loops');
    const w = compileOk('dummies 2\nrf 90 hard\nadc 10 dwell 10 us', {}, 'dummies without a loop');
    ok(w.warnings.some(x => /dummies/.test(x.msg)), 'dummies without an every-loop gives a warning');
}

/* ---------- 10. Errors, with line numbers ---------- */
const base = [
    'param TE = 20 ms',
    'param TR = 100 ms',
    'matrix 32',
    'for line in 0 .. 31 every TR',
    '    rf 30 slice as exc',
    '    gz rephase, gx prephase, gy encode line',
    '    gx readout, adc at exc + TE',
    '    spoil',
    'end'
];
compileOk(base.join('\n'), {}, 'base error-test program');
function withLine(i, text) { const b = base.slice(); b[i - 1] = text; return b.join('\n'); }
function expectError(src, line, re, label, hintRe, opts) {
    const r = compile(src, opts);
    const e = firstError(r);
    ok(!r.ok && e, label + ': compile fails');
    if (!e) return null;
    ok(e.line === line, label + ': error on line ' + line + ' (got ' + e.line + ': ' + e.msg + ')');
    ok(re.test(e.msg), label + ': message ' + JSON.stringify(e.msg));
    if (hintRe) ok(hintRe.test(e.hint || ''), label + ': hint ' + JSON.stringify(e.hint));
    ok(typeof e.col === 'number' && e.col >= 1, label + ': has a column');
    return e;
}
expectError(withLine(7, '    gx readout, adc at exc + TEE'), 7, /Unknown name "TEE"/, 'undefined variable', /Did you mean TE\?/);
expectError(withLine(7, '    gx readout, adc at exc + TE/2 + 1'), 7, /Cannot add a time and a plain number; did you forget a unit\?/, 'unit mismatch TE/2 + 1', /Write 1 ms/);
expectError(withLine(7, '    gx readout, adc at TE + 5 mm'), 7, /Cannot add 20 ms and 5 mm/, 'time plus length');
expectError(withLine(8, '    wait 20'), 8, /needs a time, but 20 is a plain number/, 'missing unit for a time', /Write 20 ms\./);
expectError(withLine(1, 'param TE = 20'), 7, /Cannot add a time and a plain number; did you forget a unit\?/, 'param without a unit used with a time', /Write 20 ms/);
expectError(withLine(7, '    gx readout, adc at 20'), 7, /needs a time, but 20 is a plain number/, 'plain number after at', /Write 20 ms\./);
expectError(withLine(5, '    rff 30 slice as exc'), 5, /Unknown statement "rff"/, 'unknown keyword', /Did you mean rf\?/);
expectError(withLine(5, '    rf 30 slise as exc'), 5, /"slise" is not an rf option/, 'unknown rf word', /Did you mean slice\?/);
expectError(withLine(6, '    gz rephase, gx prephase, gx encode line'), 6, /Two gradients on gx in one block/, 'two gradients on one axis');
expectError(withLine(5, '    rf 30 slice, gz crush as exc'), 5, /Two gradients on gz/, 'slice-select occupies gz');
expectError(withLine(6, '    gz rephase, gx prephase gy encode line'), 6, /Unexpected "gy"/, 'missing comma', /commas/);
expectError(withLine(3, 'matrix 32\nbandwidth 50000 Hz/px'), 7, /bandwidth per pixel is too high or the FOV too small/, 'gradient over GMAX', /Hz\/px/);
expectError(withLine(5, '    rf 30 hard as exc\n    gz rephase'), 6, /rephase needs an earlier slice-selective excitation/, 'rephase without a slice excitation');
expectError(withLine(6, '    gz rephase, gx prephase, gy encode line + 40'), 6, /outside 0 \.\. 31/, 'encode line out of range');
expectError(withLine(9, ''), 4, /never closed with "end"/, 'missing end');
expectError(withLine(4, 'for line in 0 .. 31 evry TR'), 4, /Unexpected "evry"/, 'bad loop header');
expectError(withLine(7, '    gx readout * 3, adc at exc + TE'), 7, /slew-rate limit|45 mT\/m/, 'scaled readout beyond the limits');
expectError(withLine(5, '    rf 30 slice dur 0.1 ms as exc'), 5, /slice-select gradient, above the 45 mT\/m limit/, 'slice-select over GMAX', /longer pulse/);
expectError(withLine(2, 'param TR = 100 ms\nlet pi = 3'), 3, /already a built-in constant/, 'redefining pi');
expectError(withLine(2, 'param TR = 100 ms\nlet ms = 3'), 3, /unit name/, 'a unit name as a variable');
expectError(withLine(2, 'param TR = 100 ms\nlet x = (-2)^0.5'), 3, /finite/, 'non-finite result', /\(-1\)\^line/);
expectError('rf 90 hard\nmatrix 64', 2, /before the first event/, 'settings after the first event');
expectError('adc 100', 1, /needs a number of samples and a dwell/, 'bare adc without dwell', /adc 2048 dwell 250 us/);
expectError('rf 90 hard as a\nrf 90 hard as a', 2, /already used on line 1/, 'duplicate label');
expectError('param N = 64\nlet shots = N / 12\nfor s in 0 .. shots - 1\n  wait 1 ms\nend', 3, /must be a whole number, but it is 4\.33333/, 'non-integer loop bound', /It depends on N/);
{
    // Several syntax errors are reported at once, in line order.
    const r = compile('rff 90\nparam = 3\ngx readout redout\nfor\nend');
    ok(!r.ok && r.errors.length >= 3 && r.errors.every((e, i) => !i || e.line >= r.errors[i - 1].line), 'several syntax errors reported in line order: ' + r.errors.map(e => e.line).join(','));
    ok(r.errors.every(e => 'line' in e && 'col' in e && 'msg' in e && 'hint' in e), 'errors have line, col, msg and hint');
}
{
    // TE too short in the spin echo: the hint names TE and its minimum really is the minimum.
    const src = P.get('se').source;
    const e = expectError(src, lineOf(src, 'rf 180 slice phase 90'), /^TE = 5 ms is too short: this refocusing pulse must start at/, 'TE too short', /Increase TE by at least/, { overrides: { TE: 5e-3 } });
    const m = e && /minimum TE about ([\d.]+) ms/.exec(e.hint);
    ok(!!m, 'TE hint gives an estimated minimum');
    if (m) {
        const tmin = Number(m[1]) * 1e-3;
        ok(compile(src, { overrides: { TE: tmin } }).ok, 'se compiles at the suggested minimum TE (' + m[1] + ' ms)');
        ok(!compile(src, { overrides: { TE: tmin - 0.02e-3 } }).ok, 'se does not compile 20 us below it');
    }
    expectError(src, lineOf(src, 'for line in'), /^TR = 20 ms is too short: each repetition needs [\d.]+ ms\./, 'TR too short', /Increase TR by at least/, { overrides: { TR: 20e-3 } });
    expectError(src, lineOf(src, 'gx -prephase'), /readout gradient on gx would need .* mT\/m/, 'BW 50000 Hz/px over GMAX', /bandwidth below/, { overrides: { BW: 50000 } });
    const g = expectError(P.get('gre_t1').source, lineOf(P.get('gre_t1').source, 'gx readout, adc'), /^TE = 2 ms is too short: this readout must start at/, 'GRE TE too short', /Increase TE/, { overrides: { TE: 2e-3 } });
    const tsrc = P.get('tse').source;
    expectError(tsrc, lineOf(tsrc, 'rf 180 slice phase 90'), /^ESP = 5 ms is too short/, 'TSE ESP too short', /Increase ESP/, { overrides: { ESP: 5e-3 } });
    expectError(P.get('stir').source, lineOf(P.get('stir').source, 'at inv + TI'), /^TI = 1 ms is too short: this excitation pulse/, 'STIR TI too short', /Increase TI/, { overrides: { TI: 1e-3 } });
    expectError(tsrc, lineOf(tsrc, 'for shot in'), /whole number/, 'TSE with ETL that does not divide N', /N, ETL/, { overrides: { ETL: 12 } });
}
{
    // Runaway guards.
    const r1 = compile('for i in 0 .. 100000 every 1 ms\n    wait 0.5 ms\nend');
    ok(!r1.ok && /more than 20000 blocks/.test(r1.errors[0].msg), 'block limit');
    const r2 = compile('for i in 0 .. 9000 every 10 ms\n    adc 16 dwell 10 us\nend');
    ok(!r2.ok && /more than 8192 ADC/.test(r2.errors[0].msg), 'ADC limit');
    const r3 = compile('for i in 0 .. 1e9\n    let x = i\nend');
    ok(!r3.ok && /too many times/.test(r3.errors[0].msg), 'loop pass limit');
    const r4 = compile('for i in 0 .. 100000 every 1 ms\n    wait 0.5 ms\nend', { maxEvents: 100 });
    ok(!r4.ok && /more than 100 blocks/.test(r4.errors[0].msg), 'maxEvents option');
    // compile never throws
    let threw = false;
    try {
        for (const s of [null, undefined, 42, '', '\u0000ÿ', '((((', 'rf', 'gx', 'for for for', 'param x = ', '"unterminated', '.5 ms', 'end end']) {
            const r = D.compile(s);
            if (typeof r.ok !== 'boolean') threw = true;
        }
    } catch (e) { threw = true; }
    ok(!threw, 'compile never throws');
    ok(D.compile('').ok && D.compile('').warnings.length > 0, 'an empty program compiles (with a warning that nothing is recorded)');
}
{
    // On failure the params parsed so far are still returned.
    const r = compile('param TE = 20 ms range 1 ms .. 50 ms\nparam N = 64\nrff 90');
    ok(!r.ok && r.params.length === 2 && r.params[0].name === 'TE', 'failed compile still returns params');
}

/* ---------- 11. Expressions and kinds ---------- */
{
    const r = compileOk([
        'let a = -2^2', 'let b = 2^3^2', 'let c = (-1)^3', 'let d = 1/2*4', 'let e = 2 + 3*4 - 1',
        'let f = 1/(2 ms)', 'let g = 1/(250 Hz)', 'let h = 10 ms * 2 kHz', 'let i = 1 rad', 'let j = cos(60 deg)',
        'let k = max(2 ms, 3 ms)', 'let l = mod(-7, 3)', 'let m = 2 cm + 5 mm', 'let n = 90 ms / 10 ms', 'let o = 1.5e-3 s',
        'let p = 3 ppm', 'let q = f0', 'let r = 10mT/m', 'let sl = 200 T/m/s', 'let t = 4 kHz', 'let u = 150 Hz/px', 'let v = 0.5 us',
        'let w = floor(7/2)', 'let x = sqrt(16)', 'let y = abs(-3 ms)', 'let z = sin(pi/2)'
    ].join('\n'), {}, 'expression program');
    const L = r.lets || {};
    const expect = { a: -4, b: 512, c: -1, d: 2, e: 13, f: 500, g: 0.004, h: 20, i: 180 / Math.PI, j: 0.5, k: 0.003, l: 2, m: 0.025,
        n: 9, o: 0.0015, p: 3, q: K.F0, r: 0.01, sl: 200, t: 4000, u: 150, v: 5e-7, w: 3, x: 4, y: 0.003, z: 1 };
    for (const name in expect) near(L[name], expect[name], 1e-9 * Math.max(1, Math.abs(expect[name])), 'let ' + name);
    // Kinds: a frequency used as a time is an error, a ratio of times is plain.
    expectError('let f = 1/(2 ms)\nwait f', 2, /needs a time, but this is a frequency/, 'freq where a time is needed');
    compileOk('param ESP = 10 ms\nlet n = 90 ms / ESP\nfor i in 0 .. n - 1\n    wait 1 ms\nend', {}, 'ratio of times is a plain count');
    expectError('let x = 2 ms * 3 mm\nwait x', 2, /mixed-unit/, 'product of time and length is mixed');
    expectError('let x = 2 ^ (1 ms)', 1, /exponent must be a plain number/, 'exponent with a unit');
}

/* ---------- 12. Lexer ---------- */
{
    const toks = D.tokenize('rf 90 slice as exc  # tip\n  gx 10mT/m for 2 ms\nlet a = pi*s/spokes\nfor l in 0..N-1');
    const types = toks.map(t => t.type);
    ok(types.indexOf('comment') > 0 && types.filter(t => t === 'newline').length === 3, 'tokenize keeps comments and newlines');
    const n90 = toks[1];
    ok(n90.type === 'number' && n90.value === 90 && n90.unit === '' && n90.line === 1 && n90.col === 4 && n90.start === 3 && n90.end === 5, 'number token position');
    ok(toks[2].type === 'keyword' && toks[2].text === 'slice', 'keywords are typed');
    const g = toks.find(t => t.type === 'number' && t.unit === 'mT/m');
    ok(g && Math.abs(g.value - 0.01) < 1e-15 && g.text === '10mT/m' && g.line === 2 && g.col === 6, 'unit attached without a space');
    const two = toks.find(t => t.type === 'number' && t.unit === 'ms');
    ok(two && two.text === '2 ms' && Math.abs(two.value - 0.002) < 1e-15, 'unit attached after a space');
    const sTok = toks.filter(t => t.text === 's');
    ok(sTok.length === 1 && sTok[0].type === 'ident', 's after an operator is a name, not a unit');
    const dots = toks.filter(t => t.type === 'op' && t.op === '..');
    ok(dots.length === 1 && toks[toks.indexOf(dots[0]) - 1].text === '0', '0..N lexes as 0, .., N');
    ok(toks.every(t => typeof t.line === 'number' && typeof t.col === 'number' && t.end >= t.start), 'every token has line, col, start, end');
    const src = 'x = "abc"\nµ';
    const t2 = D.tokenize(src);
    ok(t2.some(t => t.type === 'string' && t.text === '"abc"') && t2.some(t => t.type === 'error'), 'strings and error tokens');
    ok(Math.abs(D.tokenize('2.5 µs')[0].value - 2.5e-6) < 1e-18 && D.tokenize('2.5 µs')[0].unit === 'µs' && Math.abs(D.tokenize('3 rad')[0].value - 540 / Math.PI) < 1e-12, 'micro sign, and rad converts to degrees');
    ok(Array.isArray(D.keywords.statements) && D.keywords.units.indexOf('Hz/px') >= 0 && D.keywords.events.indexOf('rf') >= 0 && D.keywords.options.indexOf('readout') >= 0, 'keywords lists');
    ok(typeof D.reference === 'string' && D.reference.length > 1000 && D.reference.indexOf('\u2014') < 0 && /<table>/.test(D.reference), 'reference is HTML without em dashes');
}

/* ---------- 13. Overrides and setParamInSource ---------- */
{
    const src = P.get('se').source;
    const r1 = compileOk(src, { overrides: { TE: 0.05, N: 64 } }, 'se with overrides');
    ok(param(r1, 'TE') === 0.05 && r1.image.nx === 64 && r1.stats.nAdc === 64 && r1.source === src, 'overrides change values, not the source');
    const r2 = compileOk(src, { overrides: { TE: 0.25 } }, 'se with TE outside its range');
    ok(r2.warnings.some(w => /outside its range/.test(w.msg)), 'a value outside its range gives a warning');

    const prog = compiled.se;
    const te = prog.params.find(p => p.name === 'TE');
    ok(te.unit === 'ms' && te.scale === 1e-3 && te.kind === 'time' && te.min === 0.012 && te.max === 0.2 && te.description === 'echo time', 'TE param record');
    ok(src.slice(te.span[0], te.span[1]) === '90 ms', 'param span covers the value expression');
    const s2 = D.setParamInSource(src, prog, 'TE', 0.035);
    const p2 = compileOk(s2, {}, 'se after setParamInSource');
    near(param(p2, 'TE'), 0.035, 1e-15, 'TE is 35 ms after setParamInSource');
    ok(/^param TE  = 35 ms /m.test(s2), 'the source line reads "35 ms"');
    ok(s2.split('\n').length === src.split('\n').length && s2.replace('35 ms', '90 ms') === src, 'nothing else in the source changed');
    ok(/^param N   = 256 /m.test(D.setParamInSource(src, prog, 'N', 256)), 'N written as a plain count');
    ok(/^param BW  = 2000 Hz\/px /m.test(D.setParamInSource(src, prog, 'BW', 2000)), 'BW written in Hz/px');
    const esrc = P.get('epi').source;
    ok(/^param ESP = 0\.8 ms /m.test(D.setParamInSource(esrc, compiled.epi, 'ESP', 0.0008)), 'ESP 0.8 ms');
    ok(/^param FOV = 25\.5 mm /m.test(D.setParamInSource(src, prog, 'FOV', 0.0255)), 'FOV 25.5 mm');
    ok(D.setParamInSource(src, prog, 'NOPE', 1) === src, 'unknown param leaves the source alone');
    ok(/^param TR  = 4 s/m.test(D.setParamInSource(src.replace('3000 ms', '3 s'), prog, 'TR', 4)), 'unit as written in the given source (s)');
    ok(D.formatParam(te, 0.035) === '35 ms', 'formatParam');
}

/* ---------- 14. Readout axis and image block ---------- */
{
    const y = compileOk('matrix 64 32\nfov 240 mm 120 mm\nfor l in 0 .. 63 every 50 ms\n    rf 30 slice as exc\n    gz rephase, gy prephase, gx encode l\n    gy readout, adc at exc + 6 ms\n    spoil\nend', {}, 'y readout');
    ok(y.image.readoutAxis === 'y' && y.adc[0].n === 64 && y.image.nx === 64 && y.image.ny === 32 && y.image.fovY === 0.12, 'readout on gy uses ny, fovY');
    const kc = kAt(y, y.adc[0].tc).k;
    ok(Math.abs(kc.y) * 0.12 < 1e-6 && Math.abs(kc.x * 0.24 + 32) < 1e-6, 'y readout: ky = 0 at the echo, kx from encode on x');
    ok(compiled.se.image.readoutAxis === 'x' && compiled.se.image.hasImaging === true && compiled.se.image.oversample === 2, 'se image block');
    ok(compiled.epi.image.oversample === 1 && compiled.epi.image.fovX === 0.22 && compiled.epi.image.nx === 64, 'epi image block');
    const s = compiled.se.system;
    ok(s.B0 === 3 && s.gammaBar === GB && s.gmax === K.GMAX && s.slew === K.SLEW && Math.abs(s.f0 - K.F0) < 1e-6, 'system block');
}

summary('dsl');
