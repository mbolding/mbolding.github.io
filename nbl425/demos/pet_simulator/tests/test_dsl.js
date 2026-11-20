/* Tests for js/dsl.js (the protocol language) and js/presets.js.
     node tests/test_dsl.js

   Frame times are checked against hand arithmetic, decay statistics
   against PET.isotopes, and every error test checks the line the
   message points at as well as the words a student will read. */
'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'dsl', 'presets']);
const D = PET.dsl, P = PET.presets;
const MIN = 60, MBQ = 1e6;
const EM_DASH = '\u2014';

/* ---------- helpers ---------- */
function compileOk(src, opts, label) {
    const r = D.compile(src, opts);
    ok(r.ok, (label || 'program') + ' compiles' + (r.ok ? '' : ': ' + JSON.stringify(r.errors)));
    return r;
}
function param(prog, name) { return prog.params.find(q => q.name === name); }
function lineOf(src, needle) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(needle) >= 0) return i + 1;
    return -1;
}
const allMessages = [];
function expectError(src, line, re, label, hintRe, opts) {
    const r = D.compile(src, opts);
    const e = r.ok ? null : r.errors[0];
    ok(!r.ok && e, label + ': compile fails');
    if (!e) return null;
    allMessages.push(e.msg, e.hint || '');
    ok(e.line === line, label + ': error on line ' + line + ' (got ' + e.line + ': ' + e.msg + ')');
    ok(re.test(e.msg), label + ': message ' + JSON.stringify(e.msg));
    if (hintRe) ok(hintRe.test(e.hint || ''), label + ': hint ' + JSON.stringify(e.hint));
    ok(typeof e.col === 'number' && e.col >= 1, label + ': has a column');
    return e;
}
function expectWarning(src, line, re, label) {
    const r = compileOk(src, {}, label);
    if (!r.ok) return;
    const w = r.warnings.find(x => re.test(x.msg));
    ok(!!w, label + ': warning ' + re + ' (got ' + JSON.stringify(r.warnings) + ')');
    if (w) { ok(w.line === line, label + ': warning on line ' + line + ' (got ' + w.line + ')'); allMessages.push(w.msg); }
}
const lines = arr => arr.join('\n');
const frameList = prog => prog.frames.map(f => [f.t0, f.t1]);
const sameFrames = (a, b) => a.length === b.length && a.every((f, i) => Math.abs(f[0] - b[i][0]) < 1e-9 && Math.abs(f[1] - b[i][1]) < 1e-9);
const lam = iso => Math.LN2 / PET.isotopes.get(iso).halfLife;

/* ---------- 1. Presets ---------- */
const EXPECT = {
    first:         { group: 'brain',   phantom: 'brain',    opts: { condition: 'normal' }, tracer: 'FDG', iso: 'F18', dose: 185, frames: [[45, 55]], tof: true },
    fdg_static:    { group: 'brain',   phantom: 'brain',    opts: { condition: 'normal' }, tracer: 'FDG', iso: 'F18', dose: 185, frames: [[45, 55]], tof: true },
    fdg_dynamic:   { group: 'dynamic', phantom: 'brain',    opts: { condition: 'normal' }, tracer: 'FDG', iso: 'F18', dose: 185, nFrames: 20, end: 60 },
    pib_static:    { group: 'brain',   phantom: 'brain',    opts: { condition: 'ad' }, tracer: 'PiB', iso: 'C11', dose: 400, frames: [[50, 70]], tof: true },
    pib_dynamic:   { group: 'dynamic', phantom: 'brain',    opts: { condition: 'ad' }, tracer: 'PiB', iso: 'C11', dose: 400, end: 70 },
    fbb_static:    { group: 'brain',   phantom: 'brain',    opts: { condition: 'ad' }, tracer: 'florbetaben', iso: 'F18', dose: 300, frames: [[90, 110]], tof: true },
    fepe2i_static: { group: 'brain',   phantom: 'brain',    opts: { condition: 'pd' }, tracer: 'FE-PE2I', iso: 'F18', dose: 200, frames: [[20, 40]], tof: true },
    pe2i_dynamic:  { group: 'dynamic', phantom: 'brain',    opts: { condition: 'pd' }, tracer: 'PE2I', iso: 'C11', dose: 350, end: 70 },
    water_dynamic: { group: 'dynamic', phantom: 'brain',    opts: { condition: 'normal' }, tracer: 'water', iso: 'O15', dose: 700, nFrames: 22, end: 3 },
    point_res:     { group: 'phantom', phantom: 'point',    opts: { medium: 'air' }, tracer: null, iso: 'F18', dose: 5, frames: [[0, 2]], tof: true },
    cyl_uniform:   { group: 'phantom', phantom: 'cylinder', opts: {}, tracer: null, iso: 'F18', dose: 40, frames: [[0, 10]], tof: true },
    spheres_iq:    { group: 'phantom', phantom: 'spheres',  opts: { ratio: 4, lung: true }, tracer: null, iso: 'F18', dose: 50, frames: [[0, 10]], tof: true },
    rods_f18:      { group: 'phantom', phantom: 'rods',     opts: {}, tracer: null, iso: 'F18', dose: 40, frames: [[0, 10]], tof: true }
};
ok(Array.isArray(P) && typeof P.get === 'function', 'PET.presets is an array with get()');
ok(P.length === 13 && Object.keys(EXPECT).every(id => P.get(id) && P.get(id).id === id), 'exactly the 13 contract presets: ' + P.map(p => p.id).join(', '));
ok(P.get('nope') === null, 'presets.get returns null for an unknown id');
ok(P.defaultId === 'fdg_static' && P.get(P.defaultId), 'default preset is fdg_static');
const compiled = {};
const timing = [];
for (const p of P) {
    const x = EXPECT[p.id];
    if (!x) { ok(false, 'unexpected preset ' + p.id); continue; }
    ok(p.group === x.group, p.id + ': group ' + x.group + ' (got ' + p.group + ')');
    ok(p.phantom === x.phantom && JSON.stringify(p.phantomOpts) === JSON.stringify(x.opts), p.id + ': phantom ' + x.phantom + ' ' + JSON.stringify(x.opts));
    ok(typeof p.name === 'string' && p.name && typeof p.summary === 'string' && p.summary.length > 20, p.id + ': has a name and a summary');
    ok([p.source, p.name, p.summary].every(s => s.indexOf(EM_DASH) < 0), p.id + ': no em dash');
    ok(p.source.split('\n').every(l => l.length <= 84), p.id + ': source lines fit the editor (84 characters)');
    ok(p.source.split('\n').filter(l => /^\s*#/.test(l)).length >= 3, p.id + ': opens with an explanatory comment');
    // Best of a cold and a warm compile, so a busy machine does not make this flaky.
    let t0 = process.hrtime.bigint();
    const r = D.compile(p.source);
    const cold = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    D.compile(p.source);
    const warm = Number(process.hrtime.bigint() - t0) / 1e6;
    timing.push(p.id + ' ' + cold.toFixed(2) + '/' + warm.toFixed(2));
    ok(Math.min(cold, warm) < 10, p.id + ': compiles in under 10 ms (' + cold.toFixed(2) + ' cold, ' + warm.toFixed(2) + ' warm)');
    ok(r.ok, p.id + ': compiles' + (r.ok ? '' : ': ' + JSON.stringify(r.errors)));
    if (!r.ok) continue;
    compiled[p.id] = r;
    ok(r.warnings.length === 0, p.id + ': no warnings at the defaults ' + JSON.stringify(r.warnings));
    ok(r.tracer === x.tracer && r.isotope === x.iso, p.id + ': tracer ' + x.tracer + ', isotope ' + x.iso + ' (got ' + r.tracer + ', ' + r.isotope + ')');
    near(r.dose, x.dose * MBQ, 1e-3, p.id + ': dose');
    ok(r.weight === 70 && r.energy.lo === 435 && r.energy.hi === 650 && Math.abs(r.coincidence - 4.5e-9) < 1e-21 && r.acqMode === '3D', p.id + ': standard windows and mode');
    const names = r.params.map(q => q.name);
    ok(names.indexOf('DOSE') >= 0, p.id + ': declares DOSE');
    for (const q of r.params) {
        ok(q.min !== null && q.max !== null && q.min < q.max && q.value >= q.min && q.value <= q.max && q.description, p.id + ': ' + q.name + ' has a range around its value and a description');
        ok(q.unit && q.scale > 0, p.id + ': ' + q.name + ' has a display unit (' + q.unit + ')');
    }
    if (x.group === 'dynamic') {
        ok(names.indexOf('UPTAKE') < 0 && names.indexOf('DUR') < 0, p.id + ': a dynamic protocol has no UPTAKE or DUR');
        ok(r.dynamic && r.frames[0].t0 === 0 && r.scanStart === 0, p.id + ': frames start at the injection');
        ok(r.frames.every((f, i) => f.t1 > f.t0 && (i === 0 || f.t0 === r.frames[i - 1].t1)), p.id + ': frames are contiguous');
        ok(r.tof.on === false, p.id + ': TOF off (simulation speed)');
        near(r.scanEnd, x.end * MIN, 1e-9, p.id + ': ends at ' + x.end + ' min');
        near(r.stats.scanDuration, x.end * MIN, 1e-9, p.id + ': scan duration ' + x.end + ' min');
        if (x.nFrames) ok(r.frames.length === x.nFrames, p.id + ': ' + x.nFrames + ' frames (got ' + r.frames.length + ')');
    } else {
        ok(names.indexOf('UPTAKE') >= 0 && names.indexOf('DUR') >= 0, p.id + ': declares UPTAKE and DUR');
        ok(sameFrames(frameList(r), x.frames.map(f => [f[0] * MIN, f[1] * MIN])), p.id + ': frames ' + JSON.stringify(x.frames) + ' min (got ' + JSON.stringify(frameList(r)) + ' s)');
        ok(!r.dynamic && r.tof.on === x.tof && Math.abs(r.tof.ctr - 400e-12) < 1e-21, p.id + ': static, TOF 400 ps');
        ok(param(r, 'UPTAKE').unit === 'min' && param(r, 'DUR').unit === 'min' && param(r, 'DOSE').unit === 'MBq', p.id + ': UPTAKE and DUR in min, DOSE in MBq');
    }
    // Every slider end compiles, alone and all together.
    for (const q of r.params) {
        for (const v of [q.min, q.max]) {
            const o = {}; o[q.name] = v;
            const rr = D.compile(p.source, { overrides: o });
            ok(rr.ok, p.id + ': ' + q.name + ' = ' + D.formatParam(q, v) + ' compiles' + (rr.ok ? '' : ': ' + JSON.stringify(rr.errors)));
        }
    }
    for (const end of ['min', 'max']) {
        const o = {}; for (const q of r.params) o[q.name] = q[end];
        ok(D.compile(p.source, { overrides: o }).ok, p.id + ': every param at its ' + end + ' compiles');
    }
}
console.log('  compile times, ms (cold/warm): ' + timing.join(', '));
{
    // fdg_dynamic: the contract's framing re-balanced to total 60 min in 20 frames.
    const r = compiled.fdg_dynamic;
    const durs = r.frames.map(f => f.t1 - f.t0);
    const want = [].concat(Array(6).fill(10), Array(3).fill(20), Array(2).fill(90), Array(5).fill(180), Array(4).fill(600));
    ok(JSON.stringify(durs) === JSON.stringify(want), 'fdg_dynamic: 6 x 10 s, 3 x 20 s, 2 x 90 s, 5 x 3 min, 4 x 10 min');
    ok(durs.reduce((a, b) => a + b, 0) === 3600, 'fdg_dynamic: totals exactly 3600 s');
    const w = compiled.water_dynamic.frames.map(f => f.t1 - f.t0);
    ok(JSON.stringify(w) === JSON.stringify([].concat(Array(12).fill(5), Array(6).fill(10), Array(4).fill(15))), 'water_dynamic: 12 x 5 s, 6 x 10 s, 4 x 15 s');
    // The first protocol explains every statement line.
    const src = P.get('first').source;
    const bare = src.split('\n').filter(l => l.trim() && !/^\s*#/.test(l) && l.indexOf('#') < 0 && !/^param .*"[^"]+"\s*$/.test(l));
    ok(bare.length === 0, 'first: every statement line has a comment (params their description): ' + JSON.stringify(bare));
    ok(/isotope F18/.test(src), 'first: shows the optional isotope line');
    ok(/O15/.test(P.get('rods_f18').source) && /change/i.test(P.get('rods_f18').source), 'rods_f18: the comments say to change F18 to O15');
    // The rods exercise from the comment actually works.
    const o15 = D.compile(P.get('rods_f18').source.replace('isotope F18', 'isotope O15'));
    ok(o15.ok && o15.isotope === 'O15', 'rods_f18 with O15 compiles');
}

/* ---------- 2. Overrides and setParamInSource ---------- */
{
    const src = P.get('fdg_static').source;
    const prog = compiled.fdg_static;
    const up = param(prog, 'UPTAKE');
    ok(up.kind === 'time' && up.unit === 'min' && up.scale === 60 && up.value === 2700 && up.min === 0 && up.max === 7200 && up.description, 'UPTAKE param record');
    ok(src.slice(up.span[0], up.span[1]) === '45 min' && up.line === lineOf(src, 'param UPTAKE'), 'UPTAKE span covers "45 min" on its line');
    const dose = param(prog, 'DOSE');
    ok(dose.kind === 'activity' && dose.unit === 'MBq' && dose.scale === 1e6 && dose.value === 185e6, 'DOSE param record');

    const r1 = compileOk(src, { overrides: { UPTAKE: 3600, DUR: 300, DOSE: 250e6 } }, 'fdg_static with overrides');
    ok(sameFrames(frameList(r1), [[3600, 3900]]) && r1.dose === 250e6 && r1.source === src, 'overrides move the frame and the dose, not the source');
    ok(r1.stats.uptake === 3600 && r1.stats.scanDuration === 300, 'stats follow the overrides');
    const r2 = compileOk(src, { overrides: { UPTAKE: 200 * MIN } }, 'UPTAKE outside its range');
    ok(r2.warnings.some(w => /UPTAKE = 200 min is outside its range 0 min \.\. 120 min/.test(w.msg) && w.line === up.line), 'a value outside its range gives a warning on the param line');
    expectError(src, lineOf(src, 'inject DOSE'), /more than the simulator allows/, 'DOSE override above 2 GBq', null, { overrides: { DOSE: 3e9 } });

    // Round trip: set UPTAKE to 60 min in the source, recompile, and read it back.
    const s2 = D.setParamInSource(src, prog, 'UPTAKE', 3600);
    ok(/^param UPTAKE = 60 min /m.test(s2), 'the UPTAKE line now reads "60 min"');
    ok(s2.replace('= 60 min ', '= 45 min ') === src && s2.split('\n').length === src.split('\n').length, 'nothing else in the source changed');
    const p2 = compileOk(s2, {}, 'fdg_static after setParamInSource');
    ok(param(p2, 'UPTAKE').value === 3600 && p2.frames[0].t0 === 3600 && p2.scanStart === 3600, 'UPTAKE is 60 min after recompiling, and the frame moved with it');
    ok(/^param DOSE   = 250 MBq /m.test(D.setParamInSource(src, prog, 'DOSE', 250e6)), 'DOSE written as 250 MBq');
    ok(/^param DUR    = 7\.5 min /m.test(D.setParamInSource(src, prog, 'DUR', 450)), 'DUR written as 7.5 min');
    ok(D.setParamInSource(src, prog, 'NOPE', 1) === src, 'an unknown param leaves the source alone');
    ok(D.setParamInSource(src, prog, 'UPTAKE', NaN) === src, 'a non-finite value leaves the source alone');
    ok(/^param UPTAKE = 1 h /m.test(D.setParamInSource(src.replace('= 45 min ', '= 0.75 h '), prog, 'UPTAKE', 3600)), 'the unit as written in the given source (h) is kept');
    const ns = 'param N = 6 range 1 .. 20\ntracer FDG\ninject 100 MBq\nframes N x 1 min';
    const np = compileOk(ns, {}, 'plain-number param');
    ok(/^param N = 8 range/.test(D.setParamInSource(ns, np, 'N', 8)) && compileOk(D.setParamInSource(ns, np, 'N', 8)).frames.length === 8, 'a plain count is written without a unit');
    ok(D.formatParam(up, 5400) === '90 min' && D.formatParam(up) === '45 min' && D.formatParam(dose, 1.5e9) === '1500 MBq', 'formatParam');
    // A param written as an expression gets its display unit from its kind.
    const ex = compileOk('tracer PiB\nparam LATE = 2 * T_half range 0 min .. 120 min\ninject 400 MBq\nwait LATE\nstatic 10 min', {}, 'expression param');
    const late = param(ex, 'LATE');
    near(late.value, 2 * PET.isotopes.get('C11').halfLife, 1e-9, 'LATE = 2 * T_half');
    ok(late.unit === 'min' && late.scale === 60, 'an expression param without a unit literal shows in min');
}

/* ---------- 3. Units and kinds ---------- */
const base = ['param UPTAKE = 45 min', 'param DOSE = 185 MBq', 'tracer FDG', 'inject DOSE', 'wait UPTAKE', 'static 10 min'];
compileOk(lines(base), {}, 'base error-test program');
function withLine(i, text) { const b = base.slice(); b[i - 1] = text; return lines(b); }
expectError(withLine(5, 'wait UPTAKE + 5'), 5, /^Cannot add a time and a plain number; did you forget a unit\?$/, 'time plus a plain number', /^Write 5 min/);
expectError(withLine(4, 'inject DOSE + 10 min'), 4, /^Cannot add 185 MBq and 10 min\.$/, 'activity plus time', /different units/);
expectError(withLine(4, 'inject DOSE - 10 min'), 4, /^Cannot subtract 10 min from 185 MBq\.$/, 'activity minus time');
expectError(withLine(5, 'wait 45'), 5, /^wait needs a time, but 45 is a plain number\.$/, 'wait without a unit', /^Write 45 min\.$/);
expectError(withLine(4, 'inject 185'), 4, /^inject needs an activity, but 185 is a plain number\.$/, 'inject without a unit', /^Write 185 MBq\.$/);
expectError(withLine(6, 'static 10'), 6, /static needs a time/, 'static without a unit', /^Write 10 min\.$/);
expectError(withLine(6, 'frames 6 x 10'), 6, /The frame duration needs a time/, 'frame duration without a unit', /^Write 10 s\.$/);
expectError(withLine(6, 'energy 435 .. 650 keV\nstatic 1 min'), 6, /lower level of the energy window needs an energy, but 435 is a plain number/, 'energy without a unit', /Write 435 keV/);
expectError(withLine(6, 'coincidence 4.5\nstatic 1 min'), 6, /coincidence needs a time/, 'coincidence without a unit', /Write 4\.5 ns/);
expectError(withLine(6, 'tof on 400\nstatic 1 min'), 6, /timing resolution needs a time/, 'TOF resolution without a unit', /Write 400 ps/);
expectError(withLine(6, 'weight 70\nstatic 1 min'), 6, /weight needs a mass/, 'weight without a unit', /Write 70 kg/);
expectError(withLine(1, 'param UPTAKE = 45'), 5, /^wait needs a time, but UPTAKE = 45 is a plain number\.$/, 'a param declared without a unit', /Give UPTAKE a unit where it is declared on line 1/);
expectError(withLine(5, 'wait DOSE'), 5, /^wait needs a time, but this is an activity \(185 MBq\)\.$/, 'an activity where a time is needed');
expectError(withLine(5, 'wait 2 min * 3 min'), 5, /^Cannot multiply a time by a time/, 'product of two times', /plain number can scale/);
expectError(withLine(4, 'inject DOSE * 1 kg'), 4, /^Cannot multiply an activity by a mass/, 'product of kinds names them');
expectError(withLine(5, 'wait 1 / (2 min)'), 5, /^Cannot divide a plain number by a time/, 'plain number over a time');
expectError(withLine(5, 'wait DOSE / (2 min)'), 5, /^Cannot divide an activity by a time/, 'activity over time');
expectError(withLine(5, 'wait UPTAKE / 0'), 5, /^Division by zero\.$/, 'division by zero');
expectError(withLine(5, 'wait 45 mins'), 5, /^"mins" is not a unit\.$/, 'misspelt unit', /Did you mean 45 min\?/);
expectError(withLine(5, 'wait 45mins'), 5, /not a number followed by a known unit/, 'misspelt unit glued to the number', /Did you mean 45 min\?/);
expectError(withLine(4, 'inject 185 mbq'), 4, /^"mbq" is not a unit\.$/, 'unit in the wrong case', /185 MBq\? Units are case-sensitive/);
expectError(withLine(5, 'wait min'), 5, /"min" is a unit, so it must follow a number/, 'a unit on its own');
expectError(withLine(4, 'inject DOSE-1 MBq'), 4, /Unexpected "MBq"/, 'minus without spaces', /put spaces around the minus sign: DOSE - 1 MBq/);
expectError(withLine(5, 'wait UPTAK'), 5, /^Unknown name "UPTAK"\.$/, 'misspelt name', /Did you mean UPTAKE\?/);
expectError(withLine(5, 'wait FDG'), 5, /"FDG" is a tracer, not a value/, 'a tracer used as a value');
expectError(withLine(5, 'wait average(UPTAKE)'), 5, /Unknown function "average"/, 'unknown function', /min, max, round, floor, ceil, abs/);
expectError(withLine(5, 'wait maks(UPTAKE, 1 min)'), 5, /Unknown function "maks"/, 'misspelt function', /Did you mean max\?/);
expectError(withLine(5, 'wait max(UPTAKE, 3 MBq)'), 5, /max needs all its arguments in the same kind of unit/, 'max with mixed kinds');
expectError(withLine(1, 'param UPTAKE = 45 min range 0 .. 2 h'), 1, /range of UPTAKE must be in the same units/, 'range in other units');
expectError(withLine(1, 'param min = 45 min'), 1, /built-in function/, 'a function name as a param');
expectError(withLine(1, 'param s = 45 min\nlet T_half = 3 min'), 1, /unit name/, 'a unit name as a param');
expectError(withLine(1, 'let x = 3'), 1, /frames operator/, 'x as a name');
expectError(withLine(2, 'param UPTAKE = 5 min'), 2, /"UPTAKE" is already a parameter \(line 1\)/, 'a name declared twice');

/* ---------- 4. Tracer and isotope ---------- */
{
    const tail = ['inject 185 MBq', 'wait 45 min', 'static 10 min'];
    const e1 = expectError(lines(['tracer FDG', 'isotope C11'].concat(tail)), 2, /^FDG is labelled with 18F, not 11C\.$/, 'FDG with an 11C isotope line',
        /^Remove the isotope line \(the tracer sets it\) or pick a carbon-11 tracer \(PiB, PE2I\)\.$/);
    ok(e1 && e1.col === 9, 'the mismatch points at the isotope word (col 9)');
    expectError(lines(['isotope C11', 'tracer FDG'].concat(tail)), 1, /^FDG is labelled with 18F, not 11C\.$/, 'isotope line before the tracer: error on the isotope line', /PiB, PE2I/);
    expectError(lines(['tracer water', 'isotope 18F'].concat(tail)), 2, /^water is labelled with 15O, not 18F\.$/, 'water with 18F', /a fluorine-18 tracer \(FDG, florbetaben, FE-PE2I\)/);
    expectError(lines(['tracer PiB', 'isotope O15'].concat(tail)), 2, /PiB is labelled with 11C, not 15O/, 'PiB with 15O', /an oxygen-15 tracer \(water\)/);
    expectError(lines(['tracer none'].concat(tail)), 1, /tracer none means a phantom filled with a solution/, 'tracer none needs an isotope', /isotope F18/);
    expectError(lines(tail), 1, /does not say what is injected/, 'no tracer and no isotope', /tracer FDG/);
    expectError(lines(['tracer FGD'].concat(tail)), 1, /^Unknown tracer "FGD"\.$/, 'misspelt tracer', /Did you mean FDG\?/);
    expectError(lines(['tracer F18'].concat(tail)), 1, /Unknown tracer "F18"/, 'an isotope as the tracer', /tracer none and isotope F18/);
    expectError(lines(['isotope FDG'].concat(tail)), 1, /Unknown isotope "FDG"/, 'a tracer as the isotope', /write tracer FDG/);
    expectError(lines(['isotope F19'].concat(tail)), 1, /Unknown isotope "F19"/, 'unknown isotope', /F18, C11 and O15/);
    expectError(lines(['tracer [18F]FDG'].concat(tail)), 1, /Square brackets/, 'tracer with the label in brackets', /tracer PiB/);
    expectError(lines(['tracer 18F-FDG'].concat(tail)), 1, /Write the tracer name alone/, 'tracer with the isotope glued on', /tracer FDG/);
    expectError(lines(['tracer FDG', 'tracer PiB'].concat(tail)), 2, /"tracer" is already set on line 1/, 'two tracer lines');

    const ok1 = compileOk(lines(['isotope 18F'].concat(tail)), {}, 'isotope alone');
    ok(ok1.tracer === null && ok1.isotope === 'F18', 'an isotope line without a tracer is a solution: tracer null');
    const ok2 = compileOk(lines(['tracer none', 'isotope C-11'].concat(tail)), {}, 'tracer none with C-11');
    ok(ok2.tracer === null && ok2.isotope === 'C11', 'tracer none + isotope C-11');
    for (const [word, id, iso] of [['fdg', 'FDG', 'F18'], ['PIB', 'PiB', 'C11'], ['Florbetaben', 'florbetaben', 'F18'], ['fe-pe2i', 'FE-PE2I', 'F18'],
        ['FEPE2I', 'FE-PE2I', 'F18'], ['pe2i', 'PE2I', 'C11'], ['H2O', 'water', 'O15'], ['"FDG"', 'FDG', 'F18'], ['NONE', null, 'O15']]) {
        const extra = id ? [] : ['isotope 15O'];
        const r = D.compile(lines(['tracer ' + word].concat(extra, tail)));
        ok(r.ok && r.tracer === id && r.isotope === iso, 'tracer ' + word + ' -> ' + id + ' (' + iso + ')' + (r.ok ? '' : ' ' + JSON.stringify(r.errors)));
    }
    for (const order of [['tracer PE2I', 'isotope 11C'], ['isotope C11', 'tracer PE2I']]) {
        const r = D.compile(lines(order.concat(tail)));
        ok(r.ok && r.tracer === 'PE2I' && r.isotope === 'C11', 'a matching isotope line works before or after the tracer: ' + order.join(' / '));
    }
    // T_half follows whichever line names the isotope first.
    const th = compileOk(lines(['tracer FDG', 'let A = 2 * T_half', 'isotope F18', 'let B = T_half'].concat(tail)), {}, 'T_half after the tracer');
    near(th.lets.A, 2 * PET.isotopes.get('F18').halfLife, 1e-9, 'T_half is the 18F half-life');
    const th2 = compileOk(lines(['isotope O15', 'let B = T_half / 2'].concat(tail)), {}, 'T_half after the isotope line');
    near(th2.lets.B, 122.24 / 2, 1e-9, 'T_half from an isotope line (15O)');
    expectError(lines(['let A = 2 * T_half', 'tracer FDG'].concat(tail)), 1, /T_half is not known yet/, 'T_half before any isotope', /Move the tracer \(or isotope\) line above/);
    const w3 = compileOk(lines(['tracer water', 'inject 700 MBq', 'wait 3 * T_half', 'static 1 min']), {}, 'wait 3 half-lives');
    near(w3.stats.decayAtStart, 0.125, 1e-12, 'three half-lives leave an eighth');
    // A failed tracer line does not cascade into T_half or "no tracer" errors.
    const casc = D.compile(lines(['tracer FGD', 'let A = T_half', 'inject 185 MBq', 'wait A', 'static 10 min']));
    ok(!casc.ok && casc.errors.length === 1 && casc.errors[0].line === 1, 'a bad tracer line gives one error, not a cascade: ' + JSON.stringify(casc.errors.map(e => e.msg)));
}

/* ---------- 5. Frames and the protocol clock ---------- */
{
    const r = compileOk(lines(['tracer FDG', 'inject 185 MBq', 'frames 6 x 10 s', 'frames 4 x 30 s', 'frames 2 x 5 min']), {}, 'three frame lines');
    const want = [];
    for (let i = 0; i < 6; i++) want.push([10 * i, 10 * i + 10]);
    for (let i = 0; i < 4; i++) want.push([60 + 30 * i, 90 + 30 * i]);
    for (let i = 0; i < 2; i++) want.push([180 + 300 * i, 480 + 300 * i]);
    ok(sameFrames(frameList(r), want), 'frames 6 x 10 s, 4 x 30 s, 2 x 5 min are back to back from 0: ' + JSON.stringify(frameList(r)));
    ok(r.dynamic && r.stats.nFrames === 12 && r.scanStart === 0 && r.scanEnd === 780 && r.stats.scanDuration === 780, 'twelve frames over 13 min');
    ok(r.frames.every(f => typeof f.line === 'number') && r.frames[0].line === 3 && r.frames[11].line === 5, 'each frame records the line that made it');
    const compact = compileOk(lines(['tracer FDG', 'inject 185 MBq', 'frames 6x10s', 'frames 4 × 30 s', 'frames 2 x5min']), {}, 'compact frames syntax');
    ok(sameFrames(frameList(compact), want), '6x10s, 4 × 30 s and 2 x5min mean the same');
    const pc = compileOk(lines(['param N = 4', 'param DUR = 20 min', 'tracer FDG', 'inject 185 MBq', 'frames N x DUR / N']), {}, 'frames from params');
    ok(sameFrames(frameList(pc), [[0, 300], [300, 600], [600, 900], [900, 1200]]), 'frames N x DUR / N splits DUR into N frames');

    // Static scans with a gap between them: duration excludes the gap, decay spans it.
    const g = compileOk(lines(['tracer FDG', 'inject 185 MBq', 'wait 10 min', 'static 10 min', 'wait 10 min', 'static 10 min']), {}, 'two statics with a gap');
    ok(sameFrames(frameList(g), [[600, 1200], [1800, 2400]]) && g.dynamic, 'two statics with a gap');
    ok(g.scanStart === 600 && g.scanEnd === 2400 && g.stats.scanDuration === 1200 && g.stats.uptake === 600, 'scan duration is the sum of the frames; uptake is the first frame start');
    near(g.stats.decayAtStart, Math.exp(-lam('F18') * 600), 1e-12, 'decayAtStart');
    near(g.stats.decayDuringScan, 1 - Math.exp(-lam('F18') * 1800), 1e-12, 'decayDuringScan covers the whole span, gap included');
    const fs = compiled.fdg_static;
    near(fs.stats.decayAtStart, PET.isotopes.decay('F18', 2700), 1e-12, 'fdg_static: 75 % left at 45 min');
    near(fs.stats.decayDuringScan, 1 - PET.isotopes.decay('F18', 600), 1e-12, 'fdg_static: 6 % decays during the 10 min frame');
    ok(Math.abs(fs.stats.decayAtStart - 0.7527) < 1e-4, 'fdg_static decayAtStart is about 0.753');

    // The injection happens at the clock time of its line.
    const late = compileOk(lines(['tracer FDG', 'wait 5 min', 'inject 185 MBq', 'static 10 min']), {}, 'inject after a wait');
    ok(late.injectAt === 300 && sameFrames(frameList(late), [[0, 600]]), 'frames are measured from the injection, not from the clock start');
    // Limits on the number of frames and the length of the study.
    compileOk(lines(['tracer FDG', 'inject 185 MBq', 'frames 60 x 10 s', 'frames 4 x 1 min']), {}, 'exactly 64 frames');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 60 x 10 s', 'frames 5 x 1 min']), 4, /brings the protocol to 65 frames; the simulator allows at most 64/, '65 frames');
    compileOk(lines(['tracer FDG', 'inject 185 MBq', 'wait 5 h', 'static 1 h']), {}, 'a scan ending exactly 6 h after injection');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'wait 5 h', 'static 61 min']), 4, /ends 6 h 1 min after the injection; the simulator follows the tracer for at most 6 hours/, 'scan beyond 6 h');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 6 * 10 s']), 3, /Use x, not \*/, 'frames with * instead of x', /frames 6 x 10 s/);
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 10 s']), 3, /frames needs a count and a duration/, 'frames without a count');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 6 10 s']), 3, /Expected "x" between the number of frames and their duration/, 'frames without x');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 0 x 10 s']), 3, /at least one frame/, 'zero frames');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 2.5 x 10 s']), 3, /whole number, but it is 2\.5/, 'fractional frame count');
    expectError(lines(['param N = 7', 'let K = N / 2', 'tracer FDG', 'inject 185 MBq', 'frames K x 1 min']), 5, /whole number, but it is 3\.5/, 'fractional count from a param', /It depends on N/);
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 10 min x 6']), 3, /number of frames must be a plain whole number, not a time/, 'count and duration swapped', /count first/);
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'static 0 s']), 3, /A frame must last longer than zero \(got 0 s\)/, 'zero-length static');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'frames 3 x -1 min']), 3, /A frame must last longer than zero/, 'negative frame duration');
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'wait -5 min', 'static 1 min']), 3, /wait cannot go back in time/, 'negative wait', /inject \.\.\. at T/);
    expectError(lines(['tracer FDG', 'inject 185 MBq']), 2, /never acquires anything: add a static or frames line/, 'no frames');
    expectError(lines(['tracer FDG', 'wait 45 min', 'static 10 min']), 3, /never injects anything/, 'no inject line', /inject 185 MBq/);
    expectError(lines(['tracer FDG', 'inject 185 MBq', 'static 1 min', 'inject 10 MBq']), 4, /already injects on line 2/, 'two injections');
}

/* ---------- 6. Injecting after the scan starts: negative frame times ---------- */
{
    const r = compileOk(lines(['tracer FDG', 'frames 10 x 1 min', 'inject 100 MBq at 2 min']), {}, 'inject at 2 min into the frames');
    const want = []; for (let i = 0; i < 10; i++) want.push([60 * i - 120, 60 * i - 60]);
    ok(sameFrames(frameList(r), want), 'frames run from -2 min to 8 min relative to the injection: ' + JSON.stringify(frameList(r)));
    ok(r.injectAt === 120 && r.scanStart === -120 && r.scanEnd === 480 && r.stats.uptake === -120, 'scanStart and uptake are negative');
    ok(r.stats.decayAtStart === 1, 'nothing has decayed at the start of a scan that starts before the injection');
    near(r.stats.decayDuringScan, 1 - Math.exp(-lam('F18') * 480), 1e-12, 'decay during the scan counts from the injection');
    ok(r.stats.scanDuration === 600, 'the pre-injection frames still count towards the scan duration');
    // "at" works from above the frames too, and the injection may sit inside a frame.
    const r2 = compileOk(lines(['tracer water', 'inject 700 MBq at 30 s', 'frames 12 x 5 s', 'frames 6 x 10 s']), {}, 'inject at 30 s, frames from 0');
    ok(r2.frames[0].t0 === -30 && r2.frames[5].t1 === 0 && r2.frames[6].t0 === 0 && r2.scanEnd === 90, 'six 5 s frames before the injection, the rest after');
    const r3 = compileOk(lines(['tracer FDG', 'static 2 min', 'inject 185 MBq at 1 min', 'static 2 min']), {}, 'injection inside a frame');
    ok(sameFrames(frameList(r3), [[-60, 60], [60, 180]]), 'a frame can straddle the injection');
    expectError(lines(['tracer FDG', 'frames 10 x 1 min', 'inject 185 MBq']), 3, /Every frame ends before the injection/, 'all frames before the injection', /inject DOSE at 0 min/);
    expectError(lines(['tracer FDG', 'inject 185 MBq at -1 min', 'static 1 min']), 2, /injection time must be 0 or later/, 'injection before the clock starts');
}

/* ---------- 7. Warnings ---------- */
{
    expectWarning(lines(['tracer FDG', 'inject 185 MBq', 'energy 300 keV .. 650 keV', 'static 10 min']), 3, /lower level of 300 keV also accepts photons that scattered by up to about 73 degrees/, 'low energy threshold');
    expectWarning(lines(['tracer FDG', 'inject 185 MBq', 'coincidence 2 ns', 'static 10 min']), 3, /2 ns coincidence window is narrow.*edge/, 'narrow coincidence window');
    expectWarning(lines(['tracer PiB', 'inject 400 MBq', 'wait 110 min', 'static 10 min']), 4, /starts 1 h 50 min after the injection, 5\.4 half-lives of 11C: only 2\.4 % of the activity is left/, 'late start, 11C');
    expectWarning(lines(['tracer water', 'inject 700 MBq', 'wait 11 min', 'static 1 min']), 4, /half-lives of 15O/, 'late start, 15O');
    expectWarning(lines(['tracer FDG', 'inject 400 MBq', 'wait 45 min', 'static 10 min']), 2, /400 MBq is more than twice the usual FDG dose \(185 MBq\)/, 'dose over twice the typical');
    const at2 = compileOk(lines(['tracer FDG', 'inject 370 MBq', 'energy 350 keV .. 650 keV', 'coincidence 2.5 ns', 'static 10 min']), {}, 'thresholds exactly');
    ok(at2.warnings.length === 0, 'exactly twice the dose, 350 keV and 2.5 ns are not warned about: ' + JSON.stringify(at2.warnings));
    const sol = compileOk(lines(['tracer none', 'isotope F18', 'inject 1.5 GBq', 'static 10 min']), {}, 'a hot phantom');
    ok(sol.warnings.length === 0, 'a phantom has no typical dose to warn about');
    const many = compileOk(lines(['tracer PiB', 'inject 900 MBq', 'energy 300 keV .. 650 keV', 'coincidence 2 ns', 'wait 2 h', 'static 10 min']), {}, 'several warnings');
    ok(many.warnings.length === 4 && many.warnings.every((w, i) => !i || w.line >= many.warnings[i - 1].line), 'four warnings, in line order');
    // The preset sliders reach warnings on purpose (2 x 185 MBq is inside the FDG range).
    const hi = D.compile(P.get('fdg_static').source, { overrides: { DOSE: 400e6 } });
    ok(hi.ok && hi.warnings.some(w => /more than twice/.test(w.msg)), 'fdg_static at its top dose warns');
}

/* ---------- 8. Limits ---------- */
{
    const L = (s, ln, re, label, hint) => expectError(lines(['tracer FDG', 'inject 185 MBq'].concat(s, ['static 10 min'])), ln, re, label, hint);
    L(['energy 200 keV .. 650 keV'], 3, /lower level of the energy window must be between 250 keV and 510 keV \(got 200 keV\)/, 'lower level too low', /435 keV is typical/);
    L(['energy 520 keV .. 650 keV'], 3, /lower level of the energy window must be between 250 keV and 510 keV \(got 520 keV\)/, 'lower level above the photopeak', /must contain the 511 keV photopeak/);
    L(['energy 510.5 keV .. 650 keV'], 3, /lower level/, 'lower level just under 511', /cut away half the photopeak/);
    L(['energy 435 keV .. 500 keV'], 3, /upper level of the energy window must be between 520 keV and 800 keV \(got 500 keV\)/, 'upper level below the photopeak', /511 keV photopeak/);
    L(['energy 435 keV .. 900 keV'], 3, /upper level .* \(got 900 keV\)/, 'upper level too high');
    L(['energy 650 keV .. 435 keV'], 3, /upper level \(435 keV\) must be above the lower level \(650 keV\)/, 'levels swapped', /lower level first/);
    L(['energy 0.435 MeV .. 0.65 MeV\ncoincidence 0.4 ns'], 4, /coincidence window of 400 ps is outside .* \(0\.5 ns to 20 ns\)/, 'MeV accepted; coincidence too short');
    L(['coincidence 25 ns'], 3, /coincidence window of 25 ns is outside/, 'coincidence too long', /4\.5 ns/);
    L(['tof on 50 ps'], 3, /timing resolution of 50 ps is outside .* \(100 ps to 1000 ps\)/, 'CTR too good');
    L(['tof off 1.5 ns'], 3, /timing resolution of 1\.5 ns is outside/, 'CTR too poor (checked with TOF off too)');
    L(['weight 10 kg'], 3, /body weight of 10 kg is outside .* \(20 kg to 200 kg\)/, 'weight too low');
    L(['weight 250000 g'], 3, /body weight of 250 kg/, 'weight in grams, too high');
    L(['mode 4D'], 3, /mode is 3D \(septa out\) or 2D \(septa in\)/, 'bad mode');
    L(['tof yes'], 3, /tof is followed by on or off/, 'bad tof');
    L(['energy 435 keV .. 650 keV', 'energy 400 keV .. 650 keV'], 4, /"energy" is already set on line 3/, 'two energy lines');
    expectError(lines(['tracer FDG', 'inject 0 MBq', 'static 1 min']), 2, /injected activity must be greater than zero/, 'zero dose');
    expectError(lines(['tracer FDG', 'inject 2.1 GBq', 'static 1 min']), 2, /2\.1 GBq is more than the simulator allows for one injection \(2 GBq\)/, 'dose above 2 GBq');
    compileOk(lines(['tracer FDG', 'inject 2 GBq', 'weight 20 kg', 'energy 250 keV .. 800 keV', 'coincidence 20 ns', 'tof on 1000 ps', 'static 10 min']), {}, 'every limit at its edge');
    compileOk(lines(['tracer FDG', 'inject 54 mCi', 'energy 510 keV .. 520 keV', 'coincidence 500 ps', 'tof off 100 ps', 'weight 200 kg', 'static 10 min']), {}, 'every limit at its other edge');
    const mci = compileOk(lines(['tracer FDG', 'inject 5 mCi', 'weight 154000 g', 'mode 2D', 'tof off', 'static 10 min']), {}, 'mCi and grams');
    ok(mci.dose === 185e6 && mci.weight === 154 && mci.acqMode === '2D' && mci.tof.on === false && Math.abs(mci.tof.ctr - 400e-12) < 1e-21, '5 mCi is 185 MBq; 2D; tof off keeps 400 ps');
    const d = compileOk(lines(['tracer FDG', 'inject 185 MBq', 'static 10 min']), {}, 'defaults');
    ok(d.weight === 70 && d.energy.lo === 435 && d.energy.hi === 650 && d.coincidence === 4.5e-9 && d.tof.on === true && d.tof.ctr === 400e-12 && d.acqMode === '3D' && d.name === 'Untitled protocol',
        'defaults: 70 kg, 435 .. 650 keV, 4.5 ns, TOF on 400 ps, 3D');
    ok(D.defaults.weight === 70 && D.limits.maxFrames === 64, 'defaults and limits are exported');
}

/* ---------- 9. Expressions ---------- */
{
    const r = compileOk(lines([
        'let a = 2 + 3 * 4 - 1', 'let b = (2 + 3) * 4', 'let c = -2 * -3', 'let d = 90 min / 10 min', 'let e = 1.5e-3 s',
        'let f = max(10 min, 20 min, 15 min)', 'let gg = min(1 GBq, 300 MBq)', 'let hh = round(2.6)', 'let i = floor(-2.5)', 'let j = ceil(2.1)',
        'let k = abs(-3 min)', 'let l = 2 h + 30 min', 'let m = 400 ps', 'let n = 1 MeV', 'let o = 2 cm + 5 mm', 'let p = 70 kg / 2', 'let q = 10 uCi',
        'let r = 3 µs', 'let s1 = 3 μCi', 'tracer FDG', 'inject 1 MBq', 'static 1 s'
    ]), {}, 'expression program');
    const E = r.lets || {};
    const want = { a: 13, b: 20, c: 6, d: 9, e: 0.0015, f: 1200, gg: 300e6, hh: 3, i: -3, j: 3, k: 180, l: 9000, m: 4e-10, n: 1000, o: 25, p: 35, q: 370e3, r: 3e-6, s1: 111e3 };
    for (const name in want) near(E[name], want[name], 1e-9 * Math.max(1, Math.abs(want[name])), 'let ' + name);
    // A kind survives a let, so a ratio of times is a plain count.
    compileOk(lines(['param DUR = 30 min', 'let N = DUR / 5 min', 'tracer FDG', 'inject 185 MBq', 'frames N x 5 min']), {}, 'a ratio of times as a frame count');
    expectError(lines(['let x2 = 2 ms * 3 ms']), 1, /Cannot multiply a time by a time/, 'kinds are checked inside let; the line error comes before the whole-protocol ones');
    expectError(lines(['let g = 3 kg', 'tracer FDG', 'inject 1 MBq', 'static 1 s']), 1, /"g" is a unit name/, 'a unit name as a let');
    expectError(lines(['let a = (1 + 2', 'tracer FDG', 'inject 1 MBq', 'static 1 s']), 1, /Expected "\)"/, 'unclosed parenthesis');
}

/* ---------- 10. Syntax errors, several at once, and robustness ---------- */
{
    expectError('Tracer FDG\ninject 185 MBq\nstatic 10 min', 1, /Unknown statement "Tracer"/, 'statement in capitals', /lower case: tracer/);
    expectError('tracer FDG\ninject 185 MBq\nwiat 45 min\nstatic 10 min', 3, /Unknown statement "wiat"/, 'misspelt statement', /Did you mean wait\?/);
    expectError('tracer FDG\ninject 185 MBq\nscan 10 min', 3, /Unknown statement "scan"/, 'a synonym', /Did you mean static\?/);
    expectError('DOSE = 185 MBq\ntracer FDG\ninject DOSE\nstatic 10 min', 1, /Unknown statement "DOSE"/, 'assignment without param', /param DOSE = /);
    expectError('tracer FDG isotope F18\ninject 185 MBq\nstatic 10 min', 1, /Unexpected "isotope"/, 'two statements on one line', /One statement per line/);
    expectError('protocol\ntracer FDG\ninject 185 MBq\nstatic 10 min', 1, /protocol needs a title in double quotes/, 'protocol without a title');
    expectError('protocol "A\ntracer FDG\ninject 185 MBq\nstatic 10 min', 1, /no closing double quote/, 'unterminated string');
    expectError('tracer FDG\ninject .5 GBq\nstatic 10 min', 2, /cannot start with a decimal point/, 'leading decimal point');
    expectError('tracer FDG\ninject 185 MBq\nstatic 10 min x 2', 3, /Unexpected "x"/, 'x outside frames', /to multiply, use \*/);
    expectError('tracer FDG\ninject 185 MBq at\nstatic 10 min', 2, /"at" needs a time/, 'at without a time');
    expectError('range 1 .. 2', 1, /A line cannot start with "range"/, 'option word at line start', /param line/);
    expectError('isotope 18 F\ninject 1 MBq\nstatic 1 min', 1, /found the number 18/, 'isotope with a space', /isotope 18F/);
    {
        // Each mistake is reported once, in line order, with no follow-on errors.
        const r = D.compile(lines(['Tracer FDG', 'param UPTAKE = 45', 'inject 185', 'wait UPTAKE', 'static 10 mins', 'energy 650 keV .. 435 keV', 'mode 4D']));
        ok(!r.ok && r.errors.length === 6, 'six independent mistakes give six errors: ' + JSON.stringify(r.errors.map(e => e.line + ' ' + e.msg)));
        ok(r.errors.map(e => e.line).join(',') === '1,3,4,5,6,7', 'errors in line order: ' + r.errors.map(e => e.line).join(','));
        ok(r.errors.every(e => 'line' in e && 'col' in e && 'msg' in e && 'hint' in e), 'errors have line, col, msg and hint');
        const r2 = D.compile(lines(['param DOSE = 185 MBq range 40 MBq .. 400 MBq "dose"', 'param UPTAKE = 45 min', 'tracer FDG', 'inject DOSE', 'wait UPTAKE', 'stattic 10 min']));
        ok(!r2.ok && r2.params.length === 2 && r2.params[0].name === 'DOSE' && r2.params[0].min === 40e6, 'a failed compile still returns the params, for the sliders');
        const r3 = D.compile(lines(['param D = 45 mins', 'tracer FDG', 'inject 1 MBq', 'wait D', 'static D']));
        ok(!r3.ok && r3.errors.length === 1 && r3.errors[0].line === 1, 'a param that fails is not reported again where it is used');
    }
    const empty = D.compile('');
    ok(!empty.ok && empty.errors.length === 3 && /does not say what is injected/.test(empty.errors[0].msg), 'an empty protocol fails with the three missing pieces');
    let threw = false;
    try {
        for (const s of [null, undefined, 42, '', '\u0000ÿ', '((((', 'tracer', 'frames', 'frames x', 'param x = ', '"unterminated', '.5 ms', 'inject inject',
            'tracer FDG\ninject 1 MBq\nframes 1e9 x 1 s', 'tracer FDG\ninject 1e400 MBq\nstatic 1 s', 'let a = 1e308 * 1e308', 'wait\n\n\n', '#only a comment', '\r\n\r\n',
            'tracer FDG\r\ninject 185 MBq\r\nstatic 10 min\r\n', 'energy .. ..', 'tof on on', 'mode', 'isotope', 'x x x', '6x', 'frames 6x', '× × ×']) {
            const r = D.compile(s);
            if (typeof r.ok !== 'boolean' || (!r.ok && !(r.errors.length && r.errors.every(e => typeof e.msg === 'string' && e.line >= 1)))) threw = true;
            if (!r.ok) for (const e of r.errors) allMessages.push(e.msg, e.hint || '');
        }
    } catch (e) { threw = true; console.error(e); }
    ok(!threw, 'compile never throws and always reports errors with a message and a line');
    ok(D.compile('tracer FDG\r\ninject 185 MBq\r\nstatic 10 min\r\n').ok, 'Windows line endings are fine');
    const big = D.compile('tracer FDG\ninject 1e400 MBq\nstatic 1 s');
    ok(!big.ok && /more than the simulator allows/.test(big.errors[0].msg), 'an infinite dose is caught');
}

/* ---------- 11. tokenize, keywords, reference ---------- */
{
    const src = 'protocol "T"  # title\ntracer FE-PE2I\nisotope 18F\ninject 185MBq at 2 min\nframes 6x10s\nframes 4 × 30 s\nmode 3D\ntof on 400 ps\nwait (UPTAKE - 1 min) / 2 µs ?';
    const toks = D.tokenize(src);
    const covers = (s, ts) => {
        let pos = 0;
        for (const t of ts) {
            if (t.start < pos || s.slice(pos, t.start).trim() !== '' || s.slice(t.start, t.end) !== t.text) return false;
            pos = t.end;
        }
        return s.slice(pos).trim() === '';
    };
    ok(covers(src, toks), 'tokens cover every non-blank character of the source, in order, without overlap');
    for (const p of P) ok(covers(p.source, D.tokenize(p.source)), p.id + ': tokens cover the source');
    ok(toks.every(t => typeof t.line === 'number' && typeof t.col === 'number' && t.end > t.start), 'every token has line, col, start and end');
    ok(!toks.some(t => t.type === 'newline'), 'line breaks are not tokens');
    const T = (text, i) => toks.filter(t => t.text === text)[i || 0];
    ok(T('protocol').type === 'keyword' && T('"T"').type === 'string' && T('# title').type === 'comment', 'keyword, string and comment tokens');
    ok(T('FE-PE2I').type === 'tracer' && T('18F').type === 'isotope', 'tracer and isotope names are typed for colouring');
    ok(T('3D').type === 'keyword' && T('at').type === 'keyword' && T('on').type === 'keyword', 'mode values and option words are keywords');
    const n185 = T('185');
    ok(n185.type === 'number' && n185.value === 185e6 && n185.unit === 'MBq' && n185.kind === 'activity' && n185.line === 4 && n185.col === 8, 'number token carries its value and unit');
    const mbq = T('MBq');
    ok(mbq.type === 'unit' && mbq.start === n185.end && mbq.col === 11 && mbq.kind === 'activity', 'a glued unit is its own token right after the number');
    const min2 = toks.filter(t => t.type === 'unit' && t.text === 'min')[0];
    ok(min2 && min2.col === 20 && T('2').end === min2.start - 1, 'a spaced unit is its own token');
    ok(T('6').type === 'number' && T('x').type === 'op' && T('10').type === 'number' && T('s').type === 'unit', '6x10s splits into number, op, number, unit');
    ok(T('×').type === 'op' && T('×').op === 'x', 'the multiplication sign is the frames operator');
    ok(T('UPTAKE').type === 'ident' && T('-').type === 'op' && T('µs').type === 'unit' && Math.abs(T('2', 1).value - 2e-6) < 1e-18, 'idents, ops and the micro sign');
    ok(T('?').type === 'error', 'a stray character is an error token');
    ok(D.tokenize(null).length === 0 && D.tokenize('').length === 0, 'tokenize of nothing is empty');

    const K = D.keywords;
    ok(['protocol', 'param', 'let', 'tracer', 'isotope', 'inject', 'weight', 'wait', 'static', 'frames', 'energy', 'coincidence', 'tof', 'mode'].every(w => K.statements.indexOf(w) >= 0), 'keywords.statements');
    ok(['s', 'ms', 'us', 'µs', 'ns', 'ps', 'min', 'h', 'Bq', 'kBq', 'MBq', 'GBq', 'mCi', 'uCi', 'µCi', 'keV', 'MeV', 'kg', 'g', 'mm', 'cm'].every(u => K.units.indexOf(u) >= 0), 'keywords.units');
    ok(['FDG', 'PiB', 'florbetaben', 'PE2I', 'FE-PE2I', 'water', 'none'].every(t => K.tracers.indexOf(t) >= 0), 'keywords.tracers');
    ok(JSON.stringify(K.isotopes) === '["F18","C11","O15"]', 'keywords.isotopes');
    ok(K.functions.indexOf('round') >= 0 && K.constants.indexOf('T_half') >= 0 && K.options.indexOf('at') >= 0, 'functions, constants, options');

    const R = D.reference;
    ok(typeof R === 'string' && R.length > 2000, 'reference is a substantial HTML string');
    ok(R.indexOf(EM_DASH) < 0, 'reference has no em dash');
    ok(/<table class="stat-table">/.test(R) && /class="note"/.test(R) && /class="mono"/.test(R), 'reference uses stat-table, note and mono');
    const classes = (R.match(/class="[^"]*"/g) || []).map(c => c.slice(7, -1)).join(' ').split(/\s+/);
    ok(classes.every(c => ['stat-table', 'mono', 'note'].indexOf(c) >= 0), 'reference uses no other classes: ' + Array.from(new Set(classes)).join(' '));
    ok(!/style=|<script/i.test(R), 'reference has no inline styles or scripts');
    ok(PET.tracers.list().every(t => R.indexOf('tracer ' + t.id + ' (' + t.isotope + ')') >= 0), 'reference lists every tracer with its isotope');
    ok(['F18', 'C11', 'O15', 'frames 6 x 10 s', 'inject DOSE at 2 min', 'T_half', 'energy 435 keV .. 650 keV', 'tof on 400 ps', 'mode 3D'].every(s => R.indexOf(s) >= 0), 'reference covers isotopes, frames, at, T_half and the settings');
    const opens = (R.match(/<(table|tr|th|td|p|h4|pre|div|code|span)\b/g) || []).length, closes = (R.match(/<\/(table|tr|th|td|p|h4|pre|div|code|span)>/g) || []).length;
    ok(opens === closes, 'reference tags are balanced (' + opens + ' / ' + closes + ')');
}

/* ---------- 12. Plain language ---------- */
ok(allMessages.length > 100, 'collected ' + allMessages.length + ' messages and hints');
ok(allMessages.every(m => m.indexOf(EM_DASH) < 0), 'no em dash in any message or hint');
ok(allMessages.every(m => !/undefined|NaN|\[object/.test(m)), 'no message shows undefined, NaN or [object]: ' + allMessages.filter(m => /undefined|NaN|\[object/.test(m)).join(' | '));

summary('dsl');
