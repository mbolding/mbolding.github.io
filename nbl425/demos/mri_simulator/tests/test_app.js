/* Tests for js/app.js: state, actions, the scan controller and playback.
     node tests/test_app.js

   app.js only builds the page when a document exists, so in Node it
   creates MRI.state and MRI.actions and nothing else. The real tissue,
   phantom, field, DSL and preset modules are used; the engine, recon and
   spectroscopy modules are replaced by small mocks that record how they
   were called, so these tests check the shell's logic (event order,
   aborting, caching, debouncing) and not the physics. */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, ok, near, summary } = require('./harness');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* Build a fresh simulator: real modules + mocks + app.js. */
function makeSim(opts) {
    opts = opts || {};
    const MRI = load(['core', 'tissues', 'phantoms', 'fields', 'dsl', 'presets']);
    const calls = { simulate: 0, recon: [], spectroSim: 0, spectroProc: 0, concurrent: 0, maxConcurrent: 0, aborts: 0 };

    if (!opts.noEngine) MRI.engine = {
        NOISE_REF: 1,
        // A fake acquisition: one readout per non-dummy ADC of the program,
        // computed in a few awaited chunks so that aborts can land mid-way.
        simulate: async function (program, phantom, ctx, o) {
            calls.simulate++;
            calls.concurrent++;
            calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
            calls.lastCtx = ctx; calls.lastPhantom = phantom; calls.lastOpts = o;
            try {
                if (opts.engineThrows) throw new Error('engine exploded');
                if (opts.engineUserError) { const e = new Error('This sequence has no spatial encoding. Use the Spectroscopy tab.'); e.userMessage = true; throw e; }
                const chunks = opts.chunks || 4;
                for (let i = 0; i < chunks; i++) {
                    await sleep(opts.chunkMs || 5);
                    if (o.shouldAbort && o.shouldAbort()) { calls.aborts++; throw new Error('aborted'); }
                    if (o.onProgress) o.onProgress((i + 1) / chunks);
                }
                const adcs = program.adc.filter(a => !a.dummy);
                return {
                    program, phantomId: phantom.id, nCoils: ctx.coilSet.n, seed: o.seed,
                    grid: { nx: program.image.nx, ny: program.image.ny },
                    readouts: adcs.map((a, i) => ({ index: i, t0: a.t0, tc: a.tc, dwell: a.dwell, n: a.n, period: a.period,
                        kx: new Float32Array(a.n), ky: new Float32Array(a.n), re: [new Float32Array(a.n)], im: [new Float32Array(a.n)] })),
                    stats: { computeMs: 12 }, warnings: []
                };
            } finally { calls.concurrent--; }
        }
    };
    if (!opts.noRecon) MRI.recon = {
        defaults: { filter: 'none', filterParam: 0.5, zeroFill: 1, partialFourier: 'homodyne', parallel: 'sense',
            coilCombine: 'sos', coil: 0, densityComp: true, epiGhostCorr: false, cropOversampling: true, userMask: null },
        run: function (acq, o, extra) {
            calls.recon.push({ upTo: extra && extra.upTo, filter: o.filter, zeroFill: o.zeroFill, t: performance.now() });
            if (opts.reconMs) { const t0 = performance.now(); while (performance.now() - t0 < opts.reconMs) { /* a slow reconstruction */ } }
            const nx = acq.grid.nx, ny = acq.grid.ny;
            return { kspace: { nx, ny, re: [new Float32Array(nx * ny)], im: [new Float32Array(nx * ny)] },
                image: { nx, ny, fovX: 0.24, fovY: 0.24, mag: new Float32Array(nx * ny) },
                info: { upTo: extra && extra.upTo, acq: acq } };
        }
    };
    if (!opts.noSpectro) MRI.spectro = {
        defaults: { lb: 1, gb: 0, zf: 2, ph0: 0, ph1: 0, autoPhase: true, refPpm: 4.7, display: 'real' },
        simulate: function (program, phantom, ctx, o) {
            calls.spectroSim++; calls.spectroCtx = ctx; calls.spectroPhantom = phantom;
            return { n: 8, dwell: 1e-3, fid: { re: new Float32Array(8), im: new Float32Array(8) }, components: [] };
        },
        process: function (spec, p) { calls.spectroProc++; calls.lastProc = p; return { n: 8, lb: p.lb }; }
    };

    // Record every bus event in order.
    const events = [];
    ['phantom:changed', 'program:compiled', 'artifacts:changed', 'coil:changed', 'scan:start', 'scan:progress',
        'playback:tick', 'scan:done', 'scan:error', 'recon:done', 'tab:shown', 'spectro:compiled', 'spectro:done',
        'spectro:error', 'theme:changed', 'scan:skipped'].forEach(evt => MRI.bus.on(evt, p => events.push({ evt, p })));

    // Run app.js with a window that has no document (state and actions only).
    // Expected warnings (unknown preset, engine failure, ...) are collected
    // rather than printed, so the test output stays readable.
    const quiet = { log: console.log, info: () => {}, warn: (...a) => calls.logs.push(a), error: (...a) => calls.logs.push(a) };
    calls.logs = [];
    const win = { MRI, console: quiet, setTimeout, clearTimeout, Date, Promise, Math, JSON, performance };
    win.window = win;
    new Function('window', 'globalThis', APP_SRC)(win, win);
    return { MRI, calls, events, win };
}
const names = (events, filter) => events.filter(e => !filter || filter(e)).map(e => e.evt);
const hasNex = (prog) => !!(prog && prog.params && prog.params.some(p => p.name === 'NEX'));

(async function main() {
    /* ---------- state and actions exist with the contract's defaults ---------- */
    {
        const { MRI } = makeSim();
        const S = MRI.state;
        ok(S && MRI.actions && MRI.app, 'MRI.state, MRI.actions and MRI.app are created at load');
        ok(S.phantomId === 'brain' && S.presetId === 'se' && S.coilType === 'head8', 'default phantom, preset and coil');
        ok(S.autoRescan === true && S.speed === 'fast' && S.scanning === false, 'default autoRescan, speed, scanning');
        ok(S.phantomOpts.lesion === false && S.phantomOpts.gad === 0 && Object.keys(S.phantomOpts.overrides).length === 0, 'default phantom options');
        ok(S.artifacts.noise === 1 && S.artifacts.motion.on === false && S.artifacts.motion.kind === 'periodic' &&
           S.artifacts.motion.amp === 0.004 && S.artifacts.flow.period === 0.9 && S.artifacts.b0.susceptibility === 1 &&
           S.artifacts.b0.shim === 0 && S.artifacts.b1.amount === 0 && S.artifacts.gradDelay === 0 &&
           S.artifacts.spike.at === 0.37 && S.artifacts.zipper.offsetHz === 3000 && S.artifacts.transient === false,
           'artifact defaults follow section 9.2');
        ok(S.artifacts.b0.shimCoeffs && S.artifacts.b0.shimCoeffs.z2 === 0, 'shim coefficients default to zero (7.1)');
        ok(S.recon.filter === 'none' && S.recon.zeroFill === 1 && S.recon !== MRI.recon.defaults, 'recon options copied from MRI.recon.defaults');
        ok(S.spectro.presetId === 'fid' && S.spectro.phantomId === 'braino' && S.spectro.processing.lb === 1 &&
           S.spectro.processing !== MRI.spectro.defaults, 'spectro defaults');
        const A = MRI.actions;
        ['getPhantom', 'getFields', 'setPhantom', 'setPhantomOpts', 'loadPreset', 'setSource', 'setParam', 'setArtifacts',
         'resetArtifacts', 'setCoil', 'setRecon', 'reconstruct', 'runScan', 'stopScan', 'showTab', 'currentSummary']
            .forEach(n => ok(typeof A[n] === 'function', 'action ' + n));
        ['loadPreset', 'setSource', 'setParam', 'setPhantom', 'setProcessing', 'run']
            .forEach(n => ok(typeof A.spectro[n] === 'function', 'spectro action ' + n));
        ok(typeof MRI.app.version === 'string', 'MRI.app.version');
    }

    /* ---------- compile, summary, phantom raster, field caching ---------- */
    {
        const { MRI, events } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;                       // keep this block free of scans
        ok(A.loadPreset('se') === true && S.program.ok, 'loadPreset compiles the spin echo');
        const pc = events.filter(e => e.evt === 'program:compiled').pop();
        ok(pc && pc.p.program === S.program && Array.isArray(pc.p.errors) && pc.p.errors.length === 0, 'program:compiled carries the program and no errors');
        const sum = A.currentSummary();
        ok(sum.name === 'Spin echo' && sum.phantom === 'Brain' && sum.nx === 128 && sum.ny === 128, 'summary name, phantom, matrix');
        near(sum.TR, 3, 1e-9, 'summary TR in seconds');
        near(sum.TE, 0.09, 1e-5, 'summary TE in seconds');
        near(sum.scanTime, 390, 1e-6, 'summary scan time includes the dummies');
        ok(A.loadPreset('nonexistent') === false, 'unknown preset is refused');

        const ph = A.getPhantom();
        ok(ph.n === 256 && ph.id === 'brain', 'phantom raster 256 for a 128 matrix');
        ok(A.getPhantom() === ph, 'getPhantom is cached');
        ok(A.setParam('N', 256) === true && S.program.ok && S.program.image.nx === 256, 'setParam rewrites the matrix');
        ok(/param N\s*=\s*256/.test(S.source), 'setParam writes the value into the source');
        ok(A.getPhantom().n === 512, 'phantom raster 512 for a 256 matrix');
        ok(A.getPhantom(256).n === 256, 'explicit raster size is honoured');
        ok(A.setParam('NoSuchParam', 1) === false, 'setParam on an unknown name returns false');
        A.setParam('N', 128);
        A.setParam('TE', 0.03);
        near(A.currentSummary().TE, 0.03, 1e-5, 'setParam TE in SI (30 ms)');

        const f1 = A.getFields(ph), f2 = A.getFields(ph);
        ok(f1.b0Map === f2.b0Map && f1.b1Map === f2.b1Map && f1.coilMaps === f2.coilMaps, 'getFields is cached');
        ok(f1.b0Map.length === ph.n * ph.n && f1.coilSet.n === 8 && f1.coilMaps.re.length === 8, 'field maps on the phantom raster, 8 coils');
        A.setArtifacts({ b0: { shim: 1 } });
        const f3 = A.getFields(ph);
        ok(f3.b0Map !== f1.b0Map && f3.b1Map === f1.b1Map && f3.coilMaps === f1.coilMaps, 'changing B0 recomputes only the B0 map');
        A.setCoil('body');
        const f4 = A.getFields(ph);
        ok(f4.coilSet.n === 1 && f4.coilMaps !== f1.coilMaps, 'changing the coil recomputes the coil maps');
        ok(A.setCoil('nope') === false && S.coilType === 'body', 'unknown coil type is refused');

        // Deep merge of artifacts keeps untouched fields, and makes new objects.
        const before = S.artifacts;
        A.setArtifacts({ motion: { on: true } });
        ok(S.artifacts.motion.on === true && S.artifacts.motion.kind === 'periodic' && S.artifacts.motion.amp === 0.004, 'setArtifacts deep-merges');
        ok(S.artifacts !== before && before.motion.on === false, 'setArtifacts does not mutate the previous object');
        ok(S.artifacts.b0.shim === 1 && S.artifacts.b0.susceptibility === 1, 'nested merge keeps siblings');
        const ac = events.filter(e => e.evt === 'artifacts:changed').pop();
        ok(ac && ac.p.artifacts === S.artifacts, 'artifacts:changed payload');
        A.resetArtifacts();
        ok(S.artifacts.motion.on === false && S.artifacts.b0.shim === 0, 'resetArtifacts');

        // Phantom actions.
        ok(A.setPhantom('relax') === true && S.phantomId === 'relax', 'setPhantom');
        const pch = events.filter(e => e.evt === 'phantom:changed').pop();
        ok(pch && pch.p.phantom && pch.p.phantom.id === 'relax', 'phantom:changed carries the built phantom');
        ok(A.setPhantom('unicorn') === false && S.phantomId === 'relax', 'unknown phantom refused');
        A.setPhantom('brain', { lesion: true });
        ok(S.phantomOpts.lesion === true && S.phantomOpts.gad === 0 && S.phantomOpts.overrides, 'setPhantom with opts fills defaults');
        A.setPhantomOpts({ overrides: { wm: { t1: 1.0 } } });
        ok(S.phantomOpts.lesion === true && S.phantomOpts.overrides.wm.t1 === 1.0, 'setPhantomOpts merges shallowly');
        ok(A.getPhantom().opts.lesion === true, 'phantom built with the options');

        // A broken source: errors reported, last good program kept.
        A.setSource('sequence "broken"\nfov 24 mm\nfrobnicate');
        ok(S.program.ok === false && S.compileErrors.length === 1 && S.compileErrors[0].line === 3, 'compile errors reported with line numbers');
        ok(S.lastGoodProgram && S.lastGoodProgram.ok, 'lastGoodProgram is kept');
        const cs = A.currentSummary();
        ok(cs.ok === false && cs.errors === 1 && cs.name === 'Spin echo', 'summary falls back to the last good program');
        const r = await A.runScan({ animate: false });
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(r === null && err && /[Ll]ine 3/.test(err.p.message) && err.p.tab === 'sequence', 'scanning a broken program reports the error and points at the Sequence tab');
        const hintAt = err.p.message.indexOf(S.compileErrors[0].hint), msgAt = err.p.message.indexOf(S.compileErrors[0].msg);
        ok(S.compileErrors[0].hint && hintAt > 0 && msgAt > hintAt, 'the compiler hint comes before the message: ' + err.p.message);
    }

    /* ---------- instant scan: event order and results ---------- */
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        events.length = 0;
        const acq = await A.runScan({ animate: false });
        ok(acq && acq.readouts.length === 128, 'instant scan returns the acquisition');
        const seq = names(events, e => e.evt !== 'scan:progress');
        ok(JSON.stringify(seq) === JSON.stringify(['scan:start', 'scan:done', 'recon:done']), 'instant scan event order: ' + seq.join(','));
        ok(events[0].p.animate === false, 'scan:start reports animate false');
        const prog = events.filter(e => e.evt === 'scan:progress');
        ok(prog.length === 4 && prog.every(e => e.p.stage === 'compute') && prog[3].p.frac === 1, 'compute progress events');
        const rd = events.filter(e => e.evt === 'recon:done').pop();
        ok(rd.p.partial === false && rd.p.result === S.reconResult && S.acq === acq, 'final recon is not partial and state is updated');
        ok(S.scanning === false && S.acqUpTo === null, 'scanning cleared');
        ok(calls.lastCtx.b0Map && calls.lastCtx.b1Map && calls.lastCtx.coilSet && calls.lastCtx.coilMaps && calls.lastCtx.artifacts === S.artifacts, 'engine ctx has every field');
        ok(calls.lastPhantom.n === 256 && typeof calls.lastOpts.shouldAbort === 'function' && calls.lastOpts.seed === S.seed, 'engine gets the phantom, shouldAbort and seed');
        ok(calls.recon.length === 1 && calls.recon[0].upTo === undefined, 'one full reconstruction');

        // Animated with speed 'instant' is instant.
        S.speed = 'instant';
        events.length = 0;
        await A.runScan({ animate: true });
        ok(events[0].evt === 'scan:start' && events[0].p.animate === false && !events.some(e => e.evt === 'playback:tick'), 'speed instant skips playback');
        S.speed = 'fast';

        // setRecon re-runs only the reconstruction.
        const nSim = calls.simulate;
        events.length = 0;
        const pr = A.setRecon({ filter: 'hann' });
        ok(pr && typeof pr.then === 'function' && S.recon.filter === 'hann', 'setRecon returns a promise and updates state.recon at once');
        const res = await pr;
        ok(res && res === S.reconResult && calls.simulate === nSim && calls.recon.pop().filter === 'hann', 'setRecon reconstructs with the new options without re-scanning');
        ok(JSON.stringify(names(events)) === JSON.stringify(['recon:done']) && events[0].p.partial === false, 'setRecon emits recon:done only');
        ok(S.recon.filter === 'hann' && S.recon.zeroFill === 1, 'setRecon merges');

        // A burst of setRecon calls costs one reconstruction with the final options (E2E-3).
        events.length = 0;
        const nRecon = calls.recon.length;
        const p1 = A.setRecon({ filter: 'hamming' }), p2 = A.setRecon({ zeroFill: 2 }), p3 = A.setRecon({ filter: 'tukey' });
        ok(calls.recon.length === nRecon, 'setRecon does not reconstruct synchronously');
        const [q1, q2, q3] = await Promise.all([p1, p2, p3]);
        ok(calls.recon.length === nRecon + 1 && calls.recon[nRecon].filter === 'tukey' && calls.recon[nRecon].zeroFill === 2,
            'three quick setRecon calls give one reconstruction with the last options (' + (calls.recon.length - nRecon) + ')');
        ok(q1 === q2 && q2 === q3 && q3 === S.reconResult, 'every caller gets the same result');
        ok(names(events).filter(n => n === 'recon:done').length === 1, 'one recon:done for the burst');
        // A scan that already reconstructed the same inputs is not repeated.
        const p4 = A.setRecon({ filter: 'none' });
        await A.runScan({ animate: false });
        const before = calls.recon.length;
        await p4;
        ok(calls.recon.length === before, 'a queued setRecon after a scan that used the same options does not reconstruct again');
        S.recon = Object.assign({}, S.recon, { zeroFill: 1 });
    }

    /* ---------- the debounced auto re-scan ---------- */
    {
        const { MRI, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        A.loadPreset('se');
        A.setArtifacts({ noise: 2 });
        A.setArtifacts({ noise: 3 });
        A.setCoil('body');
        ok(calls.simulate === 0, 'no scan before the debounce delay');
        await sleep(400);
        ok(calls.simulate === 1, 'one instant scan after a burst of changes (got ' + calls.simulate + ')');
        ok(calls.lastCtx.artifacts.noise === 3 && calls.lastCtx.coilSet.n === 1, 'the scan used the latest settings');
        await sleep(50);
        S.autoRescan = false;
        A.setArtifacts({ noise: 1 });
        await sleep(350);
        ok(calls.simulate === 1 && S.stale === true, 'no auto re-scan when autoRescan is off; state marked stale');
        A.setAutoRescan(true);
        await sleep(350);
        ok(calls.simulate === 2 && S.stale === false, 'turning auto re-scan on catches up');
        A.setSource('frobnicate');
        await sleep(350);
        ok(calls.simulate === 2, 'no auto re-scan of a program that does not compile');
    }

    /* ---------- never two scans at once ---------- */
    {
        const { MRI, events, calls } = makeSim({ chunks: 10, chunkMs: 10 });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        events.length = 0;
        const p1 = A.runScan({ animate: false });
        await sleep(25);
        const p2 = A.runScan({ animate: false });
        const p3 = A.runScan({ animate: false });
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        ok(r1 === null && r2 === null && r3 && r3.readouts, 'only the newest request completes');
        ok(calls.maxConcurrent === 1, 'the engine never runs twice at once');
        ok(calls.aborts === 1 && calls.simulate === 2, 'the running scan was aborted and the middle request skipped');
        ok(names(events).filter(n => n === 'scan:done').length === 1, 'one scan:done');
        ok(!events.some(e => e.evt === 'scan:error'), 'a superseded scan is not reported as an error');

        // Stop during compute.
        events.length = 0;
        const p4 = A.runScan({ animate: false });
        await sleep(25);
        A.stopScan();
        const r4 = await p4;
        const e4 = events.filter(e => e.evt === 'scan:error').pop();
        ok(r4 === null && e4 && e4.p.aborted === true && e4.p.stage === 'compute', 'Stop during compute reports an aborted scan');
        ok(!events.some(e => e.evt === 'scan:done') && S.scanning === false, 'no scan:done after Stop');

        // Stop also cancels a queued request.
        events.length = 0;
        const p5 = A.runScan({ animate: false });
        await sleep(15);
        const p6 = A.runScan({ animate: false });
        A.stopScan();
        const [r5, r6] = await Promise.all([p5, p6]);
        ok(r5 === null && r6 === null && !events.some(e => e.evt === 'scan:done'), 'Stop cancels the running and the queued scan');
    }

    /* ---------- animated playback ---------- */
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        MRI.app.playbackSeconds.fast = 0.5;
        A.loadPreset('se');
        events.length = 0;
        const acq = await A.runScan({ animate: true });
        ok(acq && S.acq === acq && S.acqUpTo === null, 'animated scan completes');
        const seq = names(events, e => e.evt !== 'scan:progress');
        ok(seq[0] === 'scan:start' && events[0].p.animate === true, 'scan:start animate true');
        const iDone = seq.indexOf('scan:done'), lastTick = seq.lastIndexOf('playback:tick');
        ok(lastTick > 0 && iDone > lastTick && seq[seq.length - 1] === 'recon:done' && iDone === seq.length - 2, 'ticks, then scan:done, then the final recon');
        const ticks = events.filter(e => e.evt === 'playback:tick').map(e => e.p);
        ok(ticks.length >= 10, 'many playback ticks (' + ticks.length + ')');
        let mono = true;
        for (let i = 1; i < ticks.length; i++) if (ticks[i].t < ticks[i - 1].t || ticks[i].readoutsDone < ticks[i - 1].readoutsDone) mono = false;
        ok(mono, 'tick time and readout count never go backwards');
        const tl = ticks[ticks.length - 1];
        ok(tl.frac === 1 && tl.readoutsDone === 128, 'the last tick is the end of the scan with every readout');
        near(tl.t, S.program.duration, 1e-9, 'the last tick is at the end of the sequence');
        ok(ticks.every(k => 'rf' in k && k.grad && 'x' in k.grad && 'y' in k.grad && 'z' in k.grad && typeof k.adcOn === 'boolean' && typeof k.period === 'number'), 'tick payload has rf, grad, adcOn, period');
        ok(ticks.some(k => k.rf && k.rf.flip) && ticks.some(k => k.adcOn) && ticks.some(k => k.grad.x !== 0), 'RF, ADC and gradients appear during playback');
        ok(ticks.every(k => k.period >= 0 && k.period < 130), 'period index in range');
        const partials = events.filter(e => e.evt === 'recon:done' && e.p.partial === true);
        ok(partials.length >= 1, 'partial reconstructions during playback (' + partials.length + ')');
        const ups = calls.recon.filter(r => r.upTo !== undefined).map(r => r.upTo);
        ok(ups[0] === 0, 'playback starts by clearing the views with an empty (0 readout) reconstruction');
        ok(ups.slice(1).every((u, i, a) => u > 0 && u <= 128 && (i === 0 || u > a[i - 1])), 'partial recons use a growing upTo: ' + ups.join(','));
        const firstPartial = events.find(e => e.evt === 'recon:done');
        ok(firstPartial && firstPartial.p.partial === true && firstPartial.p.result.info.upTo === 0 &&
           events.indexOf(firstPartial) < events.findIndex(e => e.evt === 'playback:tick'), 'the empty reconstruction comes before the first tick');
        const pp = events.filter(e => e.evt === 'scan:progress' && e.p.stage === 'playback');
        ok(pp.length === ticks.length && pp[pp.length - 1].p.frac === 1, 'playback progress events');

        // Stop during playback keeps what was revealed.
        events.length = 0; calls.recon.length = 0;
        MRI.app.playbackSeconds.fast = 2;
        const p = A.runScan({ animate: true });
        await sleep(600);
        A.stopScan();
        const r = await p;
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(r === null && err && err.p.aborted === true && err.p.stage === 'playback', 'Stop during playback is reported');
        ok(!events.some(e => e.evt === 'scan:done'), 'no scan:done after a stopped playback');
        ok(S.acqUpTo > 0 && S.acqUpTo < 128 && err.p.readoutsDone === S.acqUpTo, 'acqUpTo records the readouts revealed (' + S.acqUpTo + ')');
        const last = calls.recon[calls.recon.length - 1];
        ok(last && last.upTo === S.acqUpTo, 'the stopped state is reconstructed from exactly those readouts');
        events.length = 0;
        await A.setRecon({ filter: 'hamming' });
        const rd = events.filter(e => e.evt === 'recon:done').pop();
        ok(rd && rd.p.partial === true && calls.recon.pop().upTo === S.acqUpTo, 'later recon changes keep the partial data');
        await A.runScan({ animate: false });
        ok(S.acqUpTo === null && calls.recon.pop().upTo === undefined, 'a new scan clears the partial state');

        // A new request during playback takes over quietly.
        events.length = 0;
        const q1 = A.runScan({ animate: true });
        await sleep(300);
        const q2 = A.runScan({ animate: false });
        const [s1, s2] = await Promise.all([q1, q2]);
        ok(s1 === null && s2 && !events.some(e => e.evt === 'scan:error'), 'a new scan supersedes playback without an error');
        ok(S.acqUpTo === null && S.acq === s2, 'state holds the new scan');
        MRI.app.playbackSeconds.fast = 4;
    }

    /* ---------- failures never leave the shell busy ---------- */
    {
        const { MRI, events } = makeSim({ engineThrows: true });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        const r = await A.runScan({ animate: true });
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(r === null && err && /engine exploded/.test(err.p.message) && S.scanning === false, 'an engine exception becomes scan:error');
    }
    {
        const { MRI, events } = makeSim({ noEngine: true, noRecon: true, noSpectro: true });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        const r = await A.runScan({ animate: false });
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(r === null && err && /engine/.test(err.p.message), 'a missing engine is reported, not thrown');
        ok(A.reconstruct() === null, 'reconstruct without data is a no-op');
        A.spectro.loadPreset('fid');
        const sr = await A.spectro.run();
        const se = events.filter(e => e.evt === 'spectro:error').pop();
        ok(sr === null && se && /spectro/.test(se.p.message), 'a missing spectroscopy module is reported');
        ok(S.recon.filter === 'none' && S.spectro.processing.zf === 2, 'fallback defaults when recon/spectro are missing');
    }
    {
        const { MRI, events } = makeSim({ noRecon: true });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        const r = await A.runScan({ animate: false });
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(r && S.acq === r && err && err.p.stage === 'recon', 'a missing recon module still keeps the acquisition and reports the recon stage');
    }

    /* ---------- spectroscopy actions ---------- */
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        ok(A.spectro.loadPreset('fid') === true && S.spectro.program.ok && S.spectro.presetId === 'fid', 'spectro preset compiles');
        const sc = events.filter(e => e.evt === 'spectro:compiled').pop();
        ok(sc && sc.p.program === S.spectro.program && sc.p.errors.length === 0, 'spectro:compiled payload');
        const res = await A.spectro.run();
        ok(res && res.data && res.spectrum && S.spectro.data === res.data && S.spectro.spectrum === res.spectrum, 'spectro run stores data and spectrum');
        ok(calls.spectroPhantom.id === 'braino' && calls.spectroPhantom.n === 256, 'spectro uses its own phantom at n = 256');
        ok(calls.spectroCtx.b0Map && calls.spectroCtx.b0Map.length === 256 * 256 && calls.spectroCtx.artifacts === S.artifacts, 'spectro ctx has the B0 map and artifacts');
        const sd = events.filter(e => e.evt === 'spectro:done').pop();
        ok(sd && sd.p.data === res.data && sd.p.spectrum === res.spectrum, 'spectro:done payload');
        const nSim = calls.spectroSim;
        A.spectro.setProcessing({ lb: 5 });
        ok(calls.spectroSim === nSim && calls.lastProc.lb === 5 && S.spectro.processing.zf === 2 && S.spectro.spectrum.lb === 5, 'setProcessing only re-processes');
        // Debounced re-run on its own changes.
        A.spectro.setParam('NA', 32);
        A.spectro.setPhantom('brain');
        await sleep(350);
        ok(calls.spectroSim === nSim + 1 && calls.spectroPhantom.id === 'brain', 'spectro re-runs once, debounced, after param and phantom changes');
        ok(/param NA\s*=\s*32/.test(S.spectro.source), 'spectro setParam writes the source');
        A.setArtifacts({ b0: { shim: 1 } });
        await sleep(350);
        ok(calls.spectroSim === nSim + 2, 'artifact changes re-run the spectrum');
        A.spectro.setSource('frobnicate');
        ok(S.spectro.program.ok === false && S.spectro.compileErrors.length === 1, 'spectro compile errors');
        const bad = await A.spectro.run();
        ok(bad === null && events.filter(e => e.evt === 'spectro:error').length >= 1, 'running a broken spectro program reports an error');
    }

    /* ---------- Stop before the first readout clears every view (C2) ---------- */
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        await A.runScan({ animate: false });
        const oldResult = S.reconResult;
        // Slow playback: the 2 dummy TRs (6 s of 390 s) take over 100 ms of wall time.
        MRI.app.playbackSeconds.slow = 15;
        S.speed = 'slow';
        events.length = 0; calls.recon.length = 0;
        const p = A.runScan({ animate: true });
        await sleep(40);
        A.stopScan();
        await p;
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(err && err.p.aborted && err.p.readoutsDone === 0 && S.acqUpTo === 0, 'stopped with 0 readouts (' + (err && err.p.readoutsDone) + ')');
        ok(S.reconResult !== oldResult && S.reconResult.info.acq === S.acq && S.reconResult.info.upTo === 0,
            'the views show the new, empty acquisition, not the previous image');
        await A.setRecon({ filter: 'hann' });
        ok(S.reconResult.info.acq === S.acq && S.reconResult.info.upTo === 0, 'later recon changes stay on the empty acquisition');
        S.speed = 'fast';
    }

    /* ---------- playback reconstructs less often when recon is slow (K3) ---------- */
    {
        const { MRI, calls } = makeSim({ reconMs: 80 });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        MRI.app.playbackSeconds.fast = 1.5;
        A.loadPreset('se');
        calls.recon.length = 0;
        await A.runScan({ animate: true });
        const partial = calls.recon.filter(r => r.upTo !== undefined && r.upTo > 0);
        const gaps = partial.slice(1).map((r, i) => r.t - partial[i].t);
        const minGap = gaps.length ? Math.min.apply(null, gaps) : Infinity;
        // 3 x 80 ms = 240 ms between starts at least (allow timer jitter).
        ok(partial.length >= 2 && minGap >= 230, 'partial recons are spaced by 3x their cost: ' + partial.length + ' recons, min gap ' + minGap.toFixed(0) + ' ms');
        ok(partial.length <= 8, 'a slow recon is not repeated every 200 ms (' + partial.length + ' in 1.5 s)');
        MRI.app.playbackSeconds.fast = 4;
    }

    /* ---------- very large scans are not re-scanned automatically (C6) ---------- */
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        A.loadPreset('gre_t1');
        await sleep(350);
        const n0 = calls.simulate;
        ok(n0 === 1 && A.currentSummary().large === false, 'a 128 matrix re-scans automatically');
        A.setParam('N', 256);
        await sleep(350);
        ok(calls.simulate === n0 + 1, '256 x 256 still re-scans automatically');
        A.setParam('TE', 0.012);                    // a 512 readout needs a longer TE
        A.setParam('N', 512);
        ok(S.program.ok && S.program.image.nx === 512 && A.currentSummary().large === true, 'N = 512 compiles and is marked large');
        events.length = 0;
        await sleep(350);
        const sk = events.filter(e => e.evt === 'scan:skipped').pop();
        ok(calls.simulate === n0 + 1 && sk && sk.p.reason === 'large' && /Large scan: press Acquire/.test(sk.p.message) && S.stale === true,
            'N = 512 is not re-scanned automatically; scan:skipped says why');
        const acq = await A.runScan({ animate: false });
        ok(acq && calls.simulate === n0 + 2 && S.stale === false, 'Acquire still runs the large scan');
        A.setParam('N', 128);
        A.setCoil('body');
        ok(A.currentSummary().coil === '8-channel head coil' || A.currentSummary().coil === 'Body coil', 'summary names the coil');
        ok(A.currentSummary().coil === 'Body coil' && A.currentSummary().coilType === 'body', 'coil name follows setCoil');
    }

    /* ---------- NEX: playback says it shows one average (C9) ---------- */
    {
        const { MRI, events } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        MRI.app.playbackSeconds.fast = 0.3;
        A.loadPreset('gre_t1');
        ok(hasNex(S.program), 'gre_t1 declares NEX');
        A.setParam('NEX', 4);
        ok(S.program.image.averages === 4 && A.currentSummary().averages === 4, 'NEX 4 compiles to 4 averages');
        events.length = 0;
        await A.runScan({ animate: true });
        const tk = events.filter(e => e.evt === 'playback:tick');
        ok(tk.length && tk.every(e => e.p.averages === 4), 'playback:tick carries averages');
        near(tk[tk.length - 1].p.duration, S.program.duration, 1e-9, 'playback covers one average (the scan time counts all of them)');
        MRI.app.playbackSeconds.fast = 4;
    }

    /* ---------- the student's mistakes are not console errors (C10, E2E-10) ---------- */
    {
        const { MRI, events, calls } = makeSim({ engineUserError: true });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        calls.logs.length = 0;
        await A.runScan({ animate: false });
        const err = events.filter(e => e.evt === 'scan:error').pop();
        ok(err && /no spatial encoding/.test(err.p.message) && calls.logs.length === 0, 'a user error is reported in the UI only (logs: ' + calls.logs.length + ')');
    }
    {
        const { MRI, calls } = makeSim({ engineThrows: true });
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.loadPreset('se');
        calls.logs.length = 0;
        await A.runScan({ animate: false });
        ok(calls.logs.length === 1, 'a real failure is still logged for the developer');
    }
    {
        const { MRI, events, calls } = makeSim();
        const A = MRI.actions, S = MRI.state;
        S.autoRescan = false;
        A.spectro.loadPreset('fid');
        MRI.spectro.simulate = function () { const e = new Error('This sequence plays a gradient on gx while the ADC is sampling.'); e.userMessage = true; throw e; };
        calls.logs.length = 0;
        await A.spectro.run();
        const se = events.filter(e => e.evt === 'spectro:error').pop();
        ok(se && se.p.message === 'This sequence plays a gradient on gx while the ADC is sampling.' && S.spectro.error === se.p.message,
            'spectro errors carry the message without a "Spectroscopy failed" prefix');
        ok(calls.logs.length === 0, 'a spectro user error is not logged');
        const sum = A.spectro.currentSummary();
        ok(sum.ok && sum.name === 'Pulse-acquire FID' && sum.phantomId === 'braino' && sum.NA === 16 && sum.TR === 3 && sum.scanTime === 54,
            'spectro summary: ' + JSON.stringify(sum));
        A.spectro.setSource('frobnicate');
        const bad = A.spectro.currentSummary();
        ok(bad.ok === false && bad.name === null && bad.errors === 1, 'spectro summary of a broken program');
    }

    /* ---------- shell extensions exist without a document ---------- */
    {
        const { MRI } = makeSim();
        ok(MRI.ui.lessonStrip && typeof MRI.ui.lessonStrip.show === 'function' && typeof MRI.ui.lessonStrip.hide === 'function',
            'MRI.ui.lessonStrip.show / hide exist');
        ok(MRI.ui.lessonStrip.show({ title: 'Lesson 3' }) === null && MRI.ui.lessonStrip.isShown() === false, 'lessonStrip is a no-op without a page');
        ok(MRI.actions.showTab('image', { focus: true }) === false, 'showTab with options is harmless without a page');
    }

    /* ---------- helpers ---------- */
    {
        const { MRI } = makeSim();
        const m = MRI.app._merged({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 5 }, e: [1, 2] });
        ok(m.a === 1 && m.b.c === 5 && m.b.d === 3 && m.e.length === 2, 'merged deep-merges plain objects');
        const mask = new Uint8Array(4);
        ok(MRI.app._merged({}, { userMask: mask }).userMask === mask, 'typed arrays are passed by reference, not cloned');
        ok(MRI.app._fmtClock(156, 390) === '2:36' && MRI.app._fmtClock(4.5, 9) === '4.50 s', 'playback clock format');
    }

    summary('app');
})().catch(e => { console.error(e); process.exitCode = 1; });
