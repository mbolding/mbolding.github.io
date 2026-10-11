/* ============================================================
   PET Simulator, application shell

   Owns the shared state (PET.state) and every action that changes it
   (PET.actions), runs scans and plays them back, and builds the page
   chrome: the scan bar, the tab bar and the theme toggle. Tabs never
   talk to each other directly: they call actions and listen to the
   bus (ARCHITECTURE.md section 12.3 lists the events).

   The flow of one scan:
     settings change -> (300 ms debounce, if Auto re-scan is on) ->
     runScan -> kinetics.regionTACs -> engine.simulate (with progress) ->
     [animated: playback, revealing the counts as they accumulate and
      reconstructing what has been acquired so far every ~250 ms] ->
     scan:done -> recon.run -> recon:done.
   Only one scan runs at a time: a new request asks the running one to
   abort (the engine polls opts.shouldAbort) and waits for it to stop.
   Reconstruction is asynchronous too; a newer request cancels an older
   one the same way.

   State and actions are created when this file loads, so tab modules
   can use them in mount(). The DOM work (tab bar, scan bar, theme)
   happens on DOMContentLoaded. Without a document (Node tests) only
   the state and actions exist.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const doc = root.document || null;
    const log = root.console || { error: function () {}, warn: function () {}, info: function () {} };

    if (!PET || !PET.util || !PET.bus) {
        // core.js is the one file nothing can do without.
        if (doc) {
            const fail = function () {
                const box = doc.getElementById('bootMsg');
                if (box) { box.className = 'boot-msg is-error'; box.textContent = 'The simulator could not start: js/core.js did not load. Check that all files are present, then reload.'; }
            };
            if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fail); else fail();
        }
        return;
    }
    const U = PET.util;
    const bus = PET.bus;
    const VERSION = '1.0.0';

    const now = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (fn) { return setTimeout(function () { fn(now()); }, 16); };

    /* Resolve after the next paint, or after 50 ms when no frame comes
       (a background tab does not paint, but an instant scan must not wait). */
    function nextPaint() {
        return new Promise(function (resolve) {
            let fired = false;
            const go = function () { if (!fired) { fired = true; setTimeout(resolve, 0); } };
            raf(go);
            setTimeout(go, 50);
        });
    }

    /* How long an animated scan takes on screen, in seconds of wall time. */
    const PLAYBACK = { fast: 3, slow: 10 };

    /* ---------- small utilities ---------- */
    function storeGet(key) { try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (e) { return null; } }
    function storeSet(key, value) { try { if (root.localStorage) root.localStorage.setItem(key, value); } catch (e) { /* private mode or blocked storage */ } }

    function isPlain(o) { return Object.prototype.toString.call(o) === '[object Object]'; }
    function deepClone(o) {
        if (Array.isArray(o)) return o.map(deepClone);
        if (!isPlain(o)) return o;
        const out = {};
        Object.keys(o).forEach(function (k) { out[k] = deepClone(o[k]); });
        return out;
    }
    /* Merge a patch into a copy of base, recursing into plain objects. */
    function merged(base, patch) {
        const out = deepClone(base || {});
        Object.keys(patch || {}).forEach(function (k) {
            const v = patch[k];
            out[k] = isPlain(v) && isPlain(out[k]) ? merged(out[k], v) : deepClone(v);
        });
        return out;
    }
    function errMessage(e) { return e && e.message ? e.message : String(e); }
    function clamp01(x) { return isFinite(x) ? U.clamp(+x, 0, 1) : 0; }
    function isAbort(e) { return e && /aborted/.test(errMessage(e)); }

    /* ---------- defaults ---------- */
    const PHYSICS_FALLBACK = {
        attenuation: true, scatter: true, randoms: true, noise: true, positronRange: true, detectorBlur: true,
        motion: { on: false, kind: 'step', dx: 6, dy: 0, rot: 0, at: 0.5, period: 5 },
        muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' },
        detector: { variation: 0.06, deadBlock: -1 },
        seed: 1
    };
    const RECON_FALLBACK = {
        method: 'osem', filter: 'hann', cutoff: 1, order: 4, iterations: 4, subsets: 12, tof: true, psf: false,
        rangeCorrection: false, matrix: 128, postFilter: 3, frame: 0,
        corrections: { normalization: true, attenuation: true, scatter: true, randoms: true, randomsMethod: 'delayed', decay: true, motion: false },
        keepIterations: true
    };
    function physicsDefaults() {
        try { if (PET.engine && PET.engine.physicsDefaults) return merged(PHYSICS_FALLBACK, PET.engine.physicsDefaults()); } catch (e) { /* use fallback */ }
        return deepClone(PHYSICS_FALLBACK);
    }
    function reconDefaults() { return merged(RECON_FALLBACK, (PET.recon && PET.recon.defaults) || {}); }

    /* ---------- state (ARCHITECTURE.md 12.3) ----------
       Besides the contract fields:
         lastGoodProgram   the most recent program that compiled
         stale             settings changed since the last scan
         reconMs           duration of the last full reconstruction, ms
         reconAll          result of reconstructing every frame (dynamic), or null */
    const state = PET.state = {
        phantomId: 'brain', phantomOpts: { condition: 'normal' },
        presetId: 'fdg_static', source: '', program: null, lastGoodProgram: null, compileErrors: [],
        physics: physicsDefaults(),
        recon: reconDefaults(),
        acq: null, reconResult: null, reconAll: null, tacs: null,
        scanning: false, reconstructing: false, autoRescan: true, speed: 'fast',
        frame: 0,
        analysis: { roi: 'cortex', reference: 'cereb_gm', target: 'cortex' },
        stale: false, reconMs: null
    };
    (function restoreSpeed() {
        const s = storeGet('petSim.speed');
        if (s === 'instant' || s === 'fast' || s === 'slow') state.speed = s;
    })();

    /* ---------- messages to the user ---------- */
    function notify(msg, kind) {
        if (doc && PET.ui && PET.ui.w && PET.ui.w.toast) { try { PET.ui.w.toast(msg, kind || 'info'); return; } catch (e) { /* fall through */ } }
        (kind === 'bad' ? log.error : log.warn).call(log, '[PET] ' + (msg && msg.textContent !== undefined ? msg.textContent : msg));
    }

    /* ---------- presets and compilation ---------- */
    function getPreset(id) {
        const P = PET.presets;
        if (!P) return null;
        if (typeof P.get === 'function') { try { return P.get(id) || null; } catch (e) { return null; } }
        return Array.isArray(P) ? (P.find(function (p) { return p.id === id; }) || null) : null;
    }
    function failedProgram(source, msg, hint) {
        return { ok: false, source: source, errors: [{ line: 1, col: 1, msg: msg, hint: hint || '' }], params: [] };
    }
    function compileSource(source) {
        if (!PET.dsl || typeof PET.dsl.compile !== 'function') return failedProgram(source, 'The protocol compiler (js/dsl.js) did not load.');
        try { return PET.dsl.compile(source, {}); }
        catch (e) { log.error(e); return failedProgram(source, 'The compiler crashed: ' + errMessage(e)); }
    }
    function compile() {
        const prog = compileSource(state.source);
        state.program = prog;
        state.compileErrors = prog.ok ? [] : (prog.errors || []);
        if (prog.ok) state.lastGoodProgram = prog;
        state.tacs = null;
        bus.emit('program:compiled', { program: prog, errors: state.compileErrors });
        return prog;
    }

    /* ---------- phantom and kinetics ---------- */
    function getPhantom() {
        if (!PET.phantoms) throw new Error('The phantom module (js/phantoms.js) did not load.');
        return PET.phantoms.build(state.phantomId, state.phantomOpts);
    }
    /* Region time-activity curves for the current phantom and protocol,
       cached on (phantom object, program object). */
    let tacKey = null;
    function getTACs() {
        const prog = state.program && state.program.ok ? state.program : state.lastGoodProgram;
        if (!prog) return null;
        if (!PET.kinetics) throw new Error('The kinetics module (js/kinetics.js) did not load.');
        const ph = getPhantom();
        if (state.tacs && tacKey && tacKey.ph === ph && tacKey.prog === prog) return state.tacs;
        state.tacs = PET.kinetics.regionTACs(ph, prog, { dt: 2, condition: state.phantomOpts.condition });
        tacKey = { ph: ph, prog: prog };
        return state.tacs;
    }

    /* ---------- scanning ---------- */
    let scanSeq = 0;            // id of the newest scan request
    let inflight = null;        // promise of the scan running (or queued)
    let abortRequested = false;
    let userStopped = false;    // the abort came from the Stop button (report it) rather than a newer scan (stay quiet)
    let playing = false;        // an animated playback is revealing counts

    /* runScan({animate}) -> Promise<AcqData | null>. Resolves to null when
       the scan was stopped, superseded by a newer one, or failed (the
       failure is reported with scan:error). Never rejects. */
    function runScan(opts) {
        const req = { animate: !!(opts && opts.animate) };
        const id = ++scanSeq;
        const prev = inflight;
        if (prev) abortRequested = true;
        const p = (async function () {
            if (prev) { try { await prev; } catch (e) { /* reported by that scan */ } }
            if (id !== scanSeq) return null;
            abortRequested = false;
            userStopped = false;
            try { return await doScan(req, id); }
            catch (e) { return scanFailed(e); }
        })();
        inflight = p;
        const clear = function () { if (inflight === p) inflight = null; };
        p.then(clear, clear);
        return p;
    }
    function stopScan() {
        if (!inflight && !state.scanning) return;
        userStopped = true;
        abortRequested = true;
        scanSeq++;
    }
    function scanFailed(err, extra) {
        const message = typeof err === 'string' ? err : errMessage(err);
        if (err && err.stack) log.error(err);
        state.scanning = false;
        playing = false;
        bus.emit('scan:error', Object.assign({ message: message }, extra || {}));
        return null;
    }
    function scanAborted(stage) {
        state.scanning = false;
        playing = false;
        if (userStopped) {
            bus.emit('scan:error', {
                message: stage === 'playback' ? 'Scan stopped part way: the image shows the counts collected so far.' : 'Scan stopped before any data were acquired.',
                aborted: true, stage: stage
            });
        }
        return null;
    }
    function compileErrorText(prog) {
        const e = (prog && prog.errors && prog.errors[0]) || null;
        return e ? 'line ' + e.line + ': ' + e.msg : 'the protocol has errors';
    }

    async function doScan(req, id) {
        const shouldAbort = function () { return abortRequested || id !== scanSeq; };
        const prog = state.program;
        if (!prog) return scanFailed('No protocol is loaded.', { stage: 'compile', tab: 'protocol' });
        if (!prog.ok) return scanFailed('The protocol does not compile (' + compileErrorText(prog) + '). Fix it in the Protocol tab.', { stage: 'compile', tab: 'protocol' });
        if (!PET.engine || typeof PET.engine.simulate !== 'function') {
            return scanFailed('The acquisition engine (js/engine.js) is not available, so nothing can be acquired.', { stage: 'compute' });
        }
        // An expected student mistake, not a bug: report it plainly, without a stack trace.
        try {
            const l = PET.phantoms && PET.phantoms.list().find(function (x) { return x.id === state.phantomId; });
            if (l && l.kind === 'brain' && !prog.tracer) {
                return scanFailed('The brain needs a tracer: a solution of ' + (prog.isotope || 'an isotope') +
                    ' has no biology to follow. Add a tracer line (for example "tracer FDG") or choose a phantom.', { stage: 'compile', tab: 'protocol' });
            }
        } catch (e) { /* phantom list unavailable: the engine will report it */ }
        const animate = req.animate && state.speed !== 'instant';
        state.scanning = true;
        state.stale = false;
        bus.emit('scan:start', { animate: animate });
        await nextPaint();
        if (shouldAbort()) return scanAborted('compute');

        const t0 = now();
        let acq;
        try {
            const phantom = getPhantom();
            const tacs = getTACs();
            acq = await PET.engine.simulate(prog, phantom, tacs, { physics: state.physics }, {
                shouldAbort: shouldAbort,
                onProgress: function (frac) { if (!shouldAbort()) bus.emit('scan:progress', { frac: clamp01(frac), stage: 'compute' }); }
            });
        } catch (e) {
            if (shouldAbort() || isAbort(e)) return scanAborted('compute');
            return scanFailed(e, { stage: 'compute', tab: /tracer/i.test(errMessage(e)) ? 'protocol' : null });
        }
        if (shouldAbort()) return scanAborted('compute');
        if (!acq || !Array.isArray(acq.frames) || !acq.frames.length) return scanFailed('The acquisition engine returned no data.', { stage: 'compute' });
        acq.stats = acq.stats || {};
        if (!isFinite(acq.stats.computeMs)) acq.stats.computeMs = now() - t0;
        state.reconAll = null;
        // A new framing (another protocol) starts on its last frame: in a dynamic
        // scan that is the one with the settled tracer distribution and the most
        // counts. Re-scans of the same framing keep the frame the student chose.
        const prevFrames = state.acq ? state.acq.frames.length : 0, prevFrame = state.frame;
        if (acq.frames.length !== prevFrames) state.frame = acq.frames.length - 1;
        else if (state.frame >= acq.frames.length) state.frame = acq.frames.length - 1;
        const frameMoved = state.frame !== prevFrame;

        if (animate) {
            state.acq = acq;
            playing = true;
            const r = await playback(acq, shouldAbort);
            playing = false;
            if (r.aborted) {
                if (userStopped && r.partial) {
                    state.acq = r.partial;
                    state.scanning = false;
                    bus.emit('scan:done', { acq: r.partial, partial: true });
                    reconstruct();
                }
                return scanAborted('playback');
            }
        }
        state.acq = acq;
        state.scanning = false;
        bus.emit('scan:done', { acq: acq });
        if (frameMoved || state.frame !== prevFrame) bus.emit('frame:changed', { frame: state.frame });
        reconstruct();
        return acq;
    }

    /* ---------- playback ----------
       The engine has already produced the whole data set. Playback shows
       how it accumulates: at fraction f of a frame, each sinogram bin
       holds a binomial thinning of its final count, Binomial(n, f). The
       thinning is made monotone in f by giving every count a fixed random
       arrival time (bins with few counts) or a fixed normal quantile
       (bins with many), so the sinogram only ever fills in. */
    function hash32(a) {
        a = (a ^ 61) ^ (a >>> 16); a = a + (a << 3); a = a ^ (a >>> 4);
        a = Math.imul(a, 0x27d4eb2d); a = a ^ (a >>> 15);
        return (a >>> 0) / 4294967296;
    }
    function normInv(p) {          // Acklam's rational approximation
        const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
        const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
        const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
        const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
        p = U.clamp(p, 1e-9, 1 - 1e-9);
        if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
        if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
        const q = p - 0.5, r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    }
    function thin(arr, f, salt) {
        if (!arr) return arr;
        if (f >= 1) return arr;
        const out = new Float32Array(arr.length);
        if (f <= 0) return out;
        for (let k = 0; k < arr.length; k++) {
            const n = arr[k];
            if (!(n > 0)) continue;
            if (n !== Math.round(n)) { out[k] = n * f; continue; }          // expected values (noise off)
            if (n <= 24) {
                let c = 0;
                for (let j = 0; j < n; j++) if (hash32((k * 31 + j) * 2654435761 + salt) < f) c++;
                out[k] = c;
            } else {
                const z = normInv(hash32(k * 2654435761 + salt + 17)), m = n * f;
                out[k] = U.clamp(Math.round(m + z * Math.sqrt(m * (1 - f))), 0, n);
            }
        }
        return out;
    }
    function scaleArr(arr, f) {
        if (!arr || f === 1) return arr;
        const out = new Float32Array(arr.length);
        for (let k = 0; k < arr.length; k++) out[k] = arr[k] * f;
        return out;
    }
    /* A copy of acq in which frame j has acquired fraction fr[j] of its counts. */
    function partialAcq(acq, fr) {
        const frames = acq.frames.map(function (F, j) {
            const f = fr[j];
            if (f >= 1) return F;
            const c = F.counts || {};
            const counts = {};
            Object.keys(c).forEach(function (k) { counts[k] = (k === 'sf' || k === 'rf') ? c[k] : c[k] * f; });
            if (isFinite(c.nec)) counts.nec = c.nec * f;
            const ex = F.expected || {};
            return Object.assign({}, F, {
                prompts: thin(F.prompts, f, 101 + j), promptsMC: thin(F.promptsMC, f, 101 + j),
                delayed: thin(F.delayed, f, 707 + j),
                randomsSingles: scaleArr(F.randomsSingles, f), scatterEst: scaleArr(F.scatterEst, f),
                expected: { trues: scaleArr(ex.trues, f), scatter: scaleArr(ex.scatter, f), randoms: scaleArr(ex.randoms, f) },
                kappa: F.kappa * f, kappaNoDecay: F.kappaNoDecay * f, counts: counts, fraction: f
            });
        });
        return Object.assign({}, acq, { frames: frames, partial: true });
    }

    function playback(acq, shouldAbort) {
        return new Promise(function (resolve) {
            const nF = acq.frames.length, T = (PLAYBACK[state.speed] || PLAYBACK.fast) * 1000;
            // Every frame gets an equal share of the wall time (a dynamic scan's
            // first 10 s frames would otherwise flash past), linear within a frame.
            const share = T / nF;
            const start = now();
            let lastRecon = 0, reconBusy = false, lastPartial = null;
            function fractions(el) {
                const fr = new Float64Array(nF);
                for (let j = 0; j < nF; j++) fr[j] = clamp01((el - j * share) / share);
                return fr;
            }
            function frame() {
                if (shouldAbort()) { resolve({ aborted: true, partial: lastPartial }); return; }
                const el = now() - start, done = el >= T;
                const fr = fractions(done ? T : el);
                let cur = Math.min(nF - 1, Math.floor((done ? T - 1 : el) / share));
                const F = acq.frames[cur], fc = fr[cur];
                const tProt = F.t0 + fc * (F.t1 - F.t0);
                let promptsSoFar = 0;
                for (let j = 0; j < nF; j++) promptsSoFar += ((acq.frames[j].counts || {}).prompts || 0) * fr[j];
                bus.emit('scan:progress', { frac: clamp01(el / T), stage: 'playback' });
                bus.emit('playback:tick', { frac: clamp01(el / T), t: tProt, frame: cur, nFrames: nF, frameFrac: fc, counts: { prompts: promptsSoFar } });
                if (done) { resolve({ aborted: false }); return; }
                if (!reconBusy && now() - lastRecon > 250) {
                    lastRecon = now();
                    const part = partialAcq(acq, fr);
                    lastPartial = part;
                    if (nF > 1 && state.frame !== cur) setFrameInternal(cur, false);
                    reconBusy = true;
                    quickRecon(part, cur).then(function () { reconBusy = false; }, function () { reconBusy = false; });
                }
                raf(frame);
            }
            raf(frame);
        });
    }

    /* A fast reconstruction for playback: the chosen method, but at most two
       iterations and without TOF or resolution modelling, so it keeps up. */
    async function quickRecon(acq, frame) {
        if (!PET.recon || typeof PET.recon.run !== 'function') return;
        const o = merged(state.recon, { frame: frame, keepIterations: false });
        if (o.method === 'mlem' || o.method === 'osem') { o.iterations = Math.min(o.iterations, 2); o.tof = false; o.psf = false; o.rangeCorrection = false; }
        try {
            const result = await PET.recon.run(acq, o, {});
            if (!playing) return;
            state.reconResult = result;
            bus.emit('recon:done', { result: result, partial: true });
        } catch (e) { if (!isAbort(e)) log.warn('[PET] playback reconstruction failed:', e); }
    }

    /* ---------- reconstruction ---------- */
    let reconSeq = 0;
    /* Full reconstruction of the frame shown, with state.recon. Returns a
       promise of the result (null if superseded or failed). */
    function reconstruct() {
        if (!state.acq || playing) return Promise.resolve(null);
        if (!PET.recon || typeof PET.recon.run !== 'function') {
            bus.emit('scan:error', { message: 'The reconstruction module (js/recon.js) is not available, so no image can be formed.', stage: 'recon' });
            return Promise.resolve(null);
        }
        const id = ++reconSeq, acq = state.acq;
        const opts = merged(state.recon, { frame: Math.min(state.frame, acq.frames.length - 1) });
        state.reconstructing = true;
        bus.emit('recon:start', { opts: opts });
        const t0 = now();
        return PET.recon.run(acq, opts, {
            shouldAbort: function () { return id !== reconSeq || acq !== state.acq; },
            onProgress: function (frac) { if (id === reconSeq) bus.emit('recon:progress', { frac: frac }); },
            onIteration: function (k, image) { if (id === reconSeq) bus.emit('recon:iteration', { k: k, image: image }); }
        }).then(function (result) {
            if (id !== reconSeq) return null;
            state.reconstructing = false;
            state.reconMs = now() - t0;
            state.reconResult = result;
            bus.emit('recon:done', { result: result, partial: !!acq.partial });
            return result;
        }, function (e) {
            if (id === reconSeq) state.reconstructing = false;
            if (isAbort(e) || id !== reconSeq) return null;
            log.error(e);
            bus.emit('scan:error', { message: 'Reconstruction failed: ' + errMessage(e), stage: 'recon' });
            return null;
        });
    }
    /* Reconstruct every frame (dynamic protocols) with the current options.
       Cached until the data or the reconstruction options change. */
    let allSeq = 0, allKey = null;
    function reconstructAllFrames() {
        if (!state.acq) return Promise.resolve(null);
        if (!PET.recon || typeof PET.recon.run !== 'function') return Promise.resolve(null);
        const key = JSON.stringify(state.recon);
        if (state.reconAll && allKey && allKey.acq === state.acq && allKey.opts === key) return Promise.resolve(state.reconAll);
        const id = ++allSeq, acq = state.acq;
        bus.emit('recon:allstart', {});
        return PET.recon.run(acq, merged(state.recon, { frame: 'all', keepIterations: false }), {
            shouldAbort: function () { return id !== allSeq || acq !== state.acq; },
            onProgress: function (frac) { if (id === allSeq) bus.emit('recon:allprogress', { frac: frac }); }
        }).then(function (result) {
            if (id !== allSeq) return null;
            state.reconAll = result;
            allKey = { acq: acq, opts: key };
            bus.emit('recon:alldone', { result: result });
            return result;
        }, function (e) {
            if (isAbort(e) || id !== allSeq) return null;
            log.error(e);
            notify('Reconstructing all frames failed: ' + errMessage(e), 'bad');
            bus.emit('recon:alldone', { result: null, error: errMessage(e) });
            return null;
        });
    }

    /* Settings changed: re-scan instantly once the student pauses. */
    const scheduleRescan = U.debounce(function () {
        if (state.autoRescan && state.program && state.program.ok) runScan({ animate: false });
    }, 300);
    const scheduleRecon = U.debounce(function () { reconstruct(); }, 120);

    function markStale() { state.stale = true; }
    function phantomChanged() {
        state.tacs = null;
        markStale();
        let ph = null;
        try { ph = getPhantom(); } catch (e) { notify(errMessage(e), 'bad'); }
        bus.emit('phantom:changed', { phantom: ph });
        scheduleRescan();
    }
    function knownPhantom(id) {
        try { return !PET.phantoms || PET.phantoms.list().some(function (p) { return p.id === id; }); }
        catch (e) { return true; }
    }
    function hasParam(prog, name) { return !!(prog && prog.params && prog.params.some(function (p) { return p.name === name; })); }
    function setFrameInternal(i, quiet) {
        const n = state.acq ? state.acq.frames.length : 1;
        const f = U.clamp(Math.round(i) || 0, 0, Math.max(0, n - 1));
        if (f === state.frame) return false;
        state.frame = f;
        if (!quiet) bus.emit('frame:changed', { frame: f });
        return true;
    }

    /* ---------- actions (ARCHITECTURE.md 12.3) ---------- */
    const actions = PET.actions = {
        getPhantom: getPhantom,
        getTACs: getTACs,
        setPhantom: function (id, opts) {
            if (!knownPhantom(id)) { notify('There is no phantom called "' + id + '".', 'warn'); return false; }
            state.phantomId = id;
            if (opts) state.phantomOpts = deepClone(opts);
            else {
                // keep options that the new phantom understands, fill the rest with its defaults
                const def = {};
                try {
                    const l = PET.phantoms.list().find(function (p) { return p.id === id; });
                    (l && l.options || []).forEach(function (o) { def[o.key] = state.phantomOpts[o.key] !== undefined ? state.phantomOpts[o.key] : o.default; });
                } catch (e) { /* no list */ }
                state.phantomOpts = def;
            }
            phantomChanged();
            return true;
        },
        setPhantomOpts: function (patch) {
            state.phantomOpts = Object.assign({}, state.phantomOpts, patch || {});
            phantomChanged();
        },
        loadPreset: function (id) {
            const p = getPreset(id);
            if (!p) { notify('There is no preset called "' + id + '".', 'warn'); return false; }
            state.presetId = id;
            state.source = p.source;
            markStale();
            compile();
            if (p.phantom && knownPhantom(p.phantom)) {
                state.phantomId = p.phantom;
                state.phantomOpts = deepClone(p.phantomOpts || {});
                const l = PET.phantoms ? PET.phantoms.list().find(function (x) { return x.id === p.phantom; }) : null;
                (l && l.options || []).forEach(function (o) { if (state.phantomOpts[o.key] === undefined) state.phantomOpts[o.key] = o.default; });
                state.tacs = null;
                let ph = null;
                try { ph = getPhantom(); } catch (e) { notify(errMessage(e), 'bad'); }
                bus.emit('phantom:changed', { phantom: ph });
            }
            bus.emit('preset:loaded', { id: id });
            scheduleRescan();
            return true;
        },
        setSource: function (text) {
            state.source = text == null ? '' : String(text);
            markStale();
            compile();
            scheduleRescan();
        },
        setParam: function (name, valueSI) {
            if (!PET.dsl || typeof PET.dsl.setParamInSource !== 'function') return false;
            const prog = state.program && state.program.ok ? state.program : state.lastGoodProgram;
            if (!hasParam(prog, name)) return false;
            const src = PET.dsl.setParamInSource(state.source, prog, name, valueSI);
            if (src !== state.source) { state.source = src; markStale(); compile(); scheduleRescan(); }
            return true;
        },
        setPhysics: function (patch) {
            state.physics = merged(state.physics, patch);
            markStale();
            bus.emit('physics:changed', { physics: state.physics });
            scheduleRescan();
        },
        resetPhysics: function () {
            state.physics = physicsDefaults();
            markStale();
            bus.emit('physics:changed', { physics: state.physics });
            scheduleRescan();
        },
        setRecon: function (patch) {
            state.recon = merged(state.recon, patch);
            bus.emit('reconopts:changed', { recon: state.recon });
            scheduleRecon();
        },
        resetRecon: function () {
            state.recon = reconDefaults();
            bus.emit('reconopts:changed', { recon: state.recon });
            scheduleRecon();
        },
        reconstruct: reconstruct,
        reconstructAllFrames: reconstructAllFrames,
        setFrame: function (i) {
            if (setFrameInternal(i, false)) scheduleRecon();
        },
        setAnalysis: function (patch) {
            state.analysis = Object.assign({}, state.analysis, patch || {});
            bus.emit('analysis:changed', { analysis: state.analysis });
        },
        runScan: runScan,
        stopScan: stopScan,
        showTab: function (id) { return showTab(id); },
        setAutoRescan: function (on) {
            state.autoRescan = !!on;
            syncScanControls();
            if (state.autoRescan && state.stale) scheduleRescan();
            updateSummary();
        },
        setSpeed: function (speed) {
            if (speed !== 'instant' && speed !== 'fast' && speed !== 'slow') return;
            state.speed = speed;
            storeSet('petSim.speed', speed);
            syncScanControls();
        },
        /* Everything a status line needs about the current protocol. */
        currentSummary: function () {
            const ok = !!(state.program && state.program.ok);
            const p = ok ? state.program : state.lastGoodProgram;
            let phantomName = state.phantomId, phantomKind = null;
            try {
                const l = PET.phantoms.list().find(function (x) { return x.id === state.phantomId; });
                if (l) { phantomName = l.name; phantomKind = l.kind; }
            } catch (e) { /* phantoms missing: show the id */ }
            let condition = null;
            if (phantomKind === 'brain' && state.phantomOpts.condition) {
                try {
                    const c = (PET.kinetics && PET.kinetics.conditions || []).find(function (x) { return x.id === state.phantomOpts.condition; });
                    condition = c ? c.name : state.phantomOpts.condition;
                } catch (e) { condition = state.phantomOpts.condition; }
            }
            let tracer = null;
            if (p && p.tracer) { try { tracer = PET.tracers.get(p.tracer).label; } catch (e) { tracer = p.tracer; } }
            else if (p && p.isotope) { try { tracer = PET.isotopes.get(p.isotope).label + ' solution'; } catch (e) { tracer = p.isotope; } }
            const acq = state.acq;
            return {
                name: p ? (p.name || 'Untitled protocol') : null,
                tracer: tracer, phantom: phantomName, condition: condition,
                dose: p ? p.dose : null, uptake: p ? p.scanStart : null,
                duration: p && p.stats ? p.stats.scanDuration : null,
                nFrames: p ? p.frames.length : 0, dynamic: !!(p && p.dynamic),
                tof: p ? p.tof : null, mode: p ? p.acqMode : null,
                trues: acq && acq.totals ? acq.totals.trues : null,
                ok: ok, errors: state.compileErrors.length
            };
        }
    };

    /* ============================================================
       Page shell (DOM). Everything below runs only in a browser.
       ============================================================ */
    const $ = function (id) { return doc ? doc.getElementById(id) : null; };
    let activeTab = null;

    const KNOWN_TABS = [
        { id: 'lessons', order: 0, title: 'Guide', file: 'js/ui/lessons.js' },
        { id: 'scanner', order: 10, title: 'Scanner', file: 'js/ui/scanner.js' },
        { id: 'tracer', order: 20, title: 'Isotopes & tracers', file: 'js/ui/tracer.js' },
        { id: 'protocol', order: 30, title: 'Protocol', file: 'js/ui/protocol.js' },
        { id: 'phantom', order: 40, title: 'Phantom', file: 'js/ui/phantom.js' },
        { id: 'sinogram', order: 50, title: 'Sinogram', file: 'js/ui/sinogram.js' },
        { id: 'recon', order: 60, title: 'Reconstruction', file: 'js/ui/recon.js' },
        { id: 'corrections', order: 70, title: 'Degradations & corrections', file: 'js/ui/corrections.js' },
        { id: 'kinetics', order: 80, title: 'Dynamic & quantification', file: 'js/ui/kinetics.js' }
    ];
    const CORE_MODULES = [
        { file: 'js/isotopes.js', name: 'isotopes and tracers', present: function () { return !!PET.isotopes; } },
        { file: 'js/scanner.js', name: 'scanner geometry', present: function () { return !!PET.scanner; } },
        { file: 'js/kinetics.js', name: 'tracer kinetics', present: function () { return !!PET.kinetics; } },
        { file: 'js/phantoms.js', name: 'phantoms', present: function () { return !!PET.phantoms; } },
        { file: 'js/dsl.js', name: 'protocol compiler', present: function () { return !!PET.dsl; } },
        { file: 'js/presets.js', name: 'protocol presets', present: function () { return !!PET.presets; } },
        { file: 'js/engine.js', name: 'acquisition engine', present: function () { return !!PET.engine; } },
        { file: 'js/recon.js', name: 'reconstruction', present: function () { return !!PET.recon; } },
        { file: 'js/analysis.js', name: 'image analysis', present: function () { return !!PET.analysis; } },
        { file: 'js/events.js', name: 'event animation', present: function () { return !!PET.events; } },
        { file: 'js/ui/widgets.js', name: 'shared widgets', present: function () { return !!(PET.ui && PET.ui.w); } }
    ];

    const problems = [];
    let tabs = [];
    let booted = false;

    function bootErrorFor(file) {
        const list = PET.bootErrors || [];
        for (let i = 0; i < list.length; i++) {
            const b = list[i];
            if (b.src && b.src.indexOf(file) >= 0) return b.kind === 'load' ? 'the file did not load' : 'it threw an error while loading: ' + b.message;
        }
        return null;
    }
    function addProblem(name, detail) {
        problems.push({ name: name, detail: detail });
        renderProblems();
    }

    /* ----- scan bar ----- */
    function setState(text, led) {
        const s = $('scanState'), l = $('scanLed');
        if (s) s.textContent = text;
        if (l) l.setAttribute('data-state', led || 'idle');
    }
    function setMessage(text, kind, action) {
        const m = $('scanMsg');
        if (!m) return;
        m.textContent = text || '';
        m.title = text || '';
        if (kind) m.setAttribute('data-kind', kind); else m.removeAttribute('data-kind');
        if (action) m.appendChild(U.el('button', { type: 'button', class: 'linklike', onclick: action.run }, action.label));
    }
    function setProgress(frac, stage) {
        const bar = $('scanProgress'), fill = $('scanProgressFill');
        if (!bar || !fill) return;
        bar.setAttribute('data-stage', stage || '');
        fill.style.width = (100 * clamp01(frac)).toFixed(1) + '%';
        bar.setAttribute('aria-valuenow', String(Math.round(100 * clamp01(frac))));
    }
    function setBusy(busy) {
        const a = $('btnAcquire'), s = $('btnStop');
        if (a) a.disabled = !!busy;
        if (s) s.disabled = !busy;
    }
    function syncScanControls() {
        const sel = $('selSpeed'), chk = $('chkAuto');
        if (sel && sel.value !== state.speed) sel.value = state.speed;
        if (chk) chk.checked = !!state.autoRescan;
    }
    function fmtClock(s) {
        const neg = s < 0; s = Math.abs(s);
        const m = Math.floor(s / 60), r = Math.floor(s - 60 * m);
        return (neg ? '-' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }
    function updateSummary() {
        const el = $('scanSummary');
        if (!el) return;
        const s = actions.currentSummary();
        el.textContent = '';
        const add = function (text, cls) { el.appendChild(cls ? U.el('span', { class: cls, text: text }) : doc.createTextNode(text)); };
        if (!s.name) {
            add(state.compileErrors.length ? 'The protocol has errors: ' + compileErrorText(state.program) : 'No protocol loaded', state.compileErrors.length ? 'sum-bad' : null);
        } else {
            add(s.tracer || s.name, 'sum-name');
            const parts = [s.phantom + (s.condition ? ' (' + s.condition + ')' : '')];
            if (s.dose) parts.push(U.fmtActivity(s.dose));
            if (!s.dynamic && s.uptake !== null && isFinite(s.uptake)) parts.push(U.fmtTime(s.uptake) + ' uptake');
            if (s.duration) parts.push(s.dynamic ? s.nFrames + ' frames over ' + U.fmtTime(s.duration) : U.fmtTime(s.duration) + ' static');
            if (s.tof) parts.push(s.tof.on ? 'TOF ' + U.fmtTime(s.tof.ctr) : 'no TOF');
            if (s.mode === '2D') parts.push('2D');
            if (s.trues !== null && isFinite(s.trues) && !state.stale) parts.push(U.fmtCounts(s.trues) + ' trues');
            add(' · ' + parts.join(' · '));
            if (!s.ok) add(' · error, ' + compileErrorText(state.program), 'sum-bad');
            else if (state.stale && !state.autoRescan && state.acq) add(' · changed since the last scan', 'sum-stale');
        }
        el.title = el.textContent;
    }

    /* Thumbnails: the prompts sinogram of the frame shown and the image. */
    let lastThumb = { acq: null, result: null };
    function thumbCanvas(id) {
        const c = $(id);
        if (!c || !c.clientWidth) return null;
        const r = U.setupCanvas(c);
        r.ctx.fillStyle = '#000';
        r.ctx.fillRect(0, 0, r.w, r.h);
        return { c: c, w: r.w, h: r.h };
    }
    function drawSinoThumb(acq) {
        lastThumb.acq = acq;
        if (!acq || !PET.scanner) return;
        try {
            const T = thumbCanvas('thumbSinoCanvas'), G = PET.scanner.geom;
            const F = acq.frames[Math.min(state.frame, acq.frames.length - 1)];
            if (T && F && F.prompts) {
                const s = PET.scanner.sumTOF(F.prompts, acq.geom ? acq.geom.nT : 1);
                const hi = U.percentile(s, 99.5);
                U.drawImage(T.c, s, G.nR, G.nA, { min: 0, max: hi > 0 ? hi : 1, smooth: true });
            }
        } catch (e) { log.warn('[PET] sinogram thumbnail failed:', e); }
    }
    function drawImgThumb(result) {
        lastThumb.result = result;
        if (!result) return;
        try {
            const T = thumbCanvas('thumbImgCanvas');
            if (T && result.image && result.n) {
                const s = Math.min(T.w, T.h), hi = U.percentile(result.image, 99.5);
                U.drawImage(T.c, result.image, result.n, result.n, { min: 0, max: hi > 0 ? hi : 1, cmap: 'pet', smooth: true, x: (T.w - s) / 2, y: (T.h - s) / 2, w: s, h: s });
            }
        } catch (e) { log.warn('[PET] image thumbnail failed:', e); }
    }
    function markThumbs(stale) {
        ['thumbSino', 'thumbImg'].forEach(function (id) { const b = $(id); if (b) b.classList.toggle('stale', !!stale); });
    }

    function renderProblems() {
        if (!doc) return;
        const line = doc.querySelector('.scan-line');
        if (!line) return;
        let badge = $('scanProblems');
        if (!problems.length) { if (badge) badge.hidden = true; return; }
        if (!badge) {
            badge = U.el('button', { type: 'button', id: 'scanProblems', class: 'badge badge-warn', style: { cursor: 'pointer', flex: 'none' },
                onclick: function () {
                    notify(U.el('div', {}, [U.el('strong', { text: 'Some parts of the simulator are unavailable:' }),
                        U.el('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, problems.map(function (p) {
                            return U.el('li', { text: p.name + (p.detail ? ': ' + p.detail : '') });
                        }))]), 'warn');
                } });
            line.appendChild(badge);
        }
        badge.hidden = false;
        badge.textContent = problems.length === 1 ? '1 part unavailable' : problems.length + ' parts unavailable';
        badge.title = problems.map(function (p) { return p.name + (p.detail ? ': ' + p.detail : ''); }).join('\n');
    }

    function wireScanBar() {
        const a = $('btnAcquire'), s = $('btnStop'), sel = $('selSpeed'), chk = $('chkAuto');
        if (a) a.addEventListener('click', function () { runScan({ animate: true }); });
        if (s) s.addEventListener('click', stopScan);
        if (sel) sel.addEventListener('change', function () { actions.setSpeed(sel.value); });
        if (chk) chk.addEventListener('change', function () { actions.setAutoRescan(chk.checked); });
        const ts = $('thumbSino'), ti = $('thumbImg');
        if (ts) ts.addEventListener('click', function () { showTab('sinogram'); });
        if (ti) ti.addEventListener('click', function () { showTab('recon'); });
        syncScanControls();

        let scanAnimated = false;
        bus.on('scan:start', function (e) {
            scanAnimated = !!(e && e.animate);
            setBusy(true);
            setState('Computing', 'busy');
            setMessage('simulating decays, coincidences and counts');
            setProgress(0, 'compute');
            markThumbs(true);
            updateSummary();
        });
        bus.on('scan:progress', function (e) {
            if (!e) return;
            if (e.stage === 'compute') {
                setState('Computing ' + Math.round(100 * clamp01(e.frac)) + '%', 'busy');
                setProgress(e.frac, 'compute');
            } else setProgress(e.frac, 'playback');
        });
        bus.on('playback:tick', function (e) {
            if (!e) return;
            setState('Acquiring', 'busy');
            markThumbs(false);
            const fr = e.nFrames > 1 ? 'frame ' + (e.frame + 1) + ' of ' + e.nFrames + ' · ' : '';
            setMessage(fr + fmtClock(e.t) + ' min after injection · ' + U.fmtCounts(e.counts.prompts) + ' prompts');
            if (state.acq) {
                // a cheap live sinogram thumbnail from the partial data, a few times a second
                const t = now();
                if (!drawSinoThumb.last || t - drawSinoThumb.last > 200) {
                    drawSinoThumb.last = t;
                    const fr2 = state.acq.frames.map(function (F, j) { return j < e.frame ? 1 : (j === e.frame ? e.frameFrac : 0); });
                    const part = partialAcq(state.acq, fr2);
                    drawSinoThumb(part);
                    lastThumb.acq = state.acq;
                }
            }
        });
        bus.on('scan:done', function (e) {
            setBusy(false);
            setProgress(1, 'done');
            const acq = e && e.acq, st = (acq && acq.stats) || {}, tot = (acq && acq.totals) || {};
            setState(e && e.partial ? 'Stopped' : 'Done', e && e.partial ? 'warn' : 'done');
            const warn = acq && acq.warnings && acq.warnings.length ? acq.warnings[0] : null;
            if (warn) setMessage(warn, 'warn');
            else setMessage((isFinite(tot.prompts) ? U.fmtCounts(tot.prompts) + ' prompts · ' : '') + (isFinite(st.computeMs) ? 'computed in ' + U.fmtTime(st.computeMs / 1000) : '') + (scanAnimated ? '' : ' · instant'));
            drawSinoThumb(acq);
            updateSummary();
        });
        bus.on('scan:error', function (e) {
            const msg = (e && e.message) || 'The scan failed.';
            if (e && e.stage === 'recon') {
                setState('Recon error', 'error');
                setMessage(msg, 'bad');
                markThumbs(false);
                return;
            }
            setBusy(false);
            setProgress(0, 'done');
            markThumbs(false);
            if (e && e.aborted) { setState('Stopped', 'warn'); setMessage(msg, 'warn'); }
            else {
                setState('Error', 'error');
                const tabT = e && e.tab ? tabById(e.tab) : null;
                setMessage(msg, 'bad', tabT ? { label: 'Open the ' + tabT.title + ' tab', run: function () { showTab(e.tab); } } : null);
            }
            updateSummary();
        });
        bus.on('recon:start', function () { if (!playing && !state.scanning) setState('Reconstructing', 'busy'); });
        bus.on('recon:done', function (e) {
            if (!e || !e.result) return;
            markThumbs(false);
            drawImgThumb(e.result);
            if (!e.partial && !state.scanning) {
                setState('Done', 'done');
                if (state.acq && state.reconMs !== null) {
                    const tot = state.acq.totals || {};
                    setMessage((isFinite(tot.prompts) ? U.fmtCounts(tot.prompts) + ' prompts · ' : '') + 'reconstructed in ' + U.fmtTime(state.reconMs / 1000));
                }
            }
        });
        bus.on('frame:changed', function () { if (state.acq && !playing) drawSinoThumb(state.acq); });
        ['program:compiled', 'phantom:changed', 'physics:changed', 'scan:done'].forEach(function (evt) { bus.on(evt, updateSummary); });
    }

    /* ----- tab bar ----- */
    function panelFor(id) {
        let p = $('tab-' + id);
        if (!p) {
            p = U.el('section', { class: 'tab-panel', id: 'tab-' + id, role: 'tabpanel', 'aria-labelledby': 'tabbtn-' + id, hidden: true });
            ($('panels') || doc.body).appendChild(p);
        }
        return p;
    }
    function errorCard(title, err) {
        if (PET.ui && PET.ui.w && PET.ui.w.errorCard) { try { return PET.ui.w.errorCard(title, err); } catch (e) { /* fall back */ } }
        return U.el('div', { class: 'error-card', role: 'alert' }, [
            U.el('div', { class: 'error-card-title', text: title }),
            U.el('div', { class: 'error-card-msg', text: err ? errMessage(err) : '' })
        ]);
    }
    function buildTabs() {
        const byId = {};
        KNOWN_TABS.forEach(function (k) { byId[k.id] = Object.assign({ def: null }, k); });
        (PET.ui.tabs || []).forEach(function (t) {
            if (!t || !t.id) return;
            const k = byId[t.id] || {};
            byId[t.id] = Object.assign({}, k, {
                id: t.id, def: t,
                title: t.title || k.title || t.id,
                order: typeof t.order === 'number' ? t.order : (typeof k.order === 'number' ? k.order : 1000)
            });
        });
        tabs = Object.keys(byId).map(function (id) { return byId[id]; })
            .sort(function (a, b) { return (a.order - b.order) || (a.id < b.id ? -1 : 1); });
        const list = $('tablist');
        if (list) list.textContent = '';
        tabs.forEach(function (t) {
            t.panel = panelFor(t.id);
            t.panel.hidden = true;
            t.missing = !t.def;
            const btn = U.el('button', {
                type: 'button', class: 'tab', role: 'tab', id: 'tabbtn-' + t.id,
                'aria-controls': 'tab-' + t.id, 'aria-selected': 'false', tabindex: '-1', 'data-tab': t.id
            }, [t.title]);
            if (t.missing) {
                btn.appendChild(U.el('span', { class: 'tab-flag', 'aria-hidden': 'true' }));
                btn.title = 'This part of the simulator did not load';
            }
            btn.addEventListener('click', function () { showTab(t.id); });
            t.button = btn;
            if (list) list.appendChild(btn);
        });
        if (list) {
            list.addEventListener('keydown', function (e) {
                const btns = tabs.map(function (t) { return t.button; });
                const i = btns.indexOf(doc.activeElement);
                if (i < 0) return;
                let j = null;
                if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
                else if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
                else if (e.key === 'Home') j = 0;
                else if (e.key === 'End') j = btns.length - 1;
                if (j === null) return;
                e.preventDefault();
                showTab(tabs[j].id, { focus: true });
            });
        }
    }
    function mountTabs() {
        tabs.forEach(function (t) {
            if (t.missing) {
                const why = (t.file && bootErrorFor(t.file)) || 'the file is missing or did not register its tab';
                t.panel.textContent = '';
                t.panel.appendChild(errorCard('The ' + t.title + ' tab is unavailable',
                    { message: (t.file || 'Its script') + ': ' + why + '. The other tabs still work.' }));
                addProblem(t.title + ' tab', why);
                return;
            }
            if (typeof t.def.mount !== 'function') return;
            try { t.def.mount(t.panel); }
            catch (e) {
                log.error('[PET] the ' + t.id + ' tab failed to mount:', e);
                t.failed = e;
                t.panel.textContent = '';
                t.panel.appendChild(errorCard('The ' + t.title + ' tab failed to start', e));
                addProblem(t.title + ' tab', 'failed to start: ' + errMessage(e));
            }
        });
    }
    function callTab(t, hook) {
        if (!t || !t.def || t.failed || typeof t.def[hook] !== 'function') return;
        try { t.def[hook](); }
        catch (e) {
            log.error('[PET] ' + t.id + '.' + hook + ' failed:', e);
            if (!t.warned) { t.warned = true; notify('The ' + t.title + ' tab had a problem: ' + errMessage(e), 'bad'); }
        }
    }
    function tabById(id) { for (let i = 0; i < tabs.length; i++) if (tabs[i].id === id) return tabs[i]; return null; }
    function hashTab() {
        const h = (root.location && root.location.hash) || '';
        const m = /(?:^#|&)tab=([A-Za-z0-9_-]+)/.exec(h);
        return m ? m[1] : null;
    }
    function writeHash(id) {
        if (!root.location) return;
        const parts = (root.location.hash || '').replace(/^#/, '').split('&')
            .filter(function (p) { return p && p.indexOf('=') > 0 && p.indexOf('tab=') !== 0; });
        parts.unshift('tab=' + id);
        const nh = '#' + parts.join('&');
        if (root.location.hash === nh) return;
        try { root.history.replaceState(root.history.state, '', nh); }
        catch (e) { try { root.location.hash = nh; } catch (e2) { /* ignore */ } }
    }
    /* Show a tab: hide the old one (onHide), show the new one (onShow after
       it is visible, so canvases measure their real size), remember it,
       and emit tab:shown. Unknown ids fall back to the Guide. */
    function showTab(id, opts) {
        opts = opts || {};
        if (!doc || !tabs.length) return false;
        let t = tabById(id);
        if (!t) t = tabById('lessons') || tabs[0];
        const prev = tabById(activeTab);
        const changed = !prev || prev !== t;
        if (prev && changed) {
            prev.panel.hidden = true;
            prev.button.setAttribute('aria-selected', 'false');
            prev.button.tabIndex = -1;
            callTab(prev, 'onHide');
        }
        activeTab = t.id;
        t.panel.hidden = false;
        t.button.setAttribute('aria-selected', 'true');
        t.button.tabIndex = 0;
        if (opts.focus) t.button.focus();
        try { t.button.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* old browsers */ }
        storeSet('petSim.tab', t.id);
        writeHash(t.id);
        if (changed && !opts.initial) keepPanelInView();
        if (changed || opts.initial) {
            callTab(t, 'onShow');
            bus.emit('tab:shown', { id: t.id });
        }
        return true;
    }
    function keepPanelInView() {
        const panels = $('panels'), con = $('console');
        if (!panels || !root.scrollTo) return;
        const top = panels.getBoundingClientRect().top + (root.pageYOffset || 0) - (con ? con.offsetHeight : 0);
        if ((root.pageYOffset || 0) > top) root.scrollTo(0, Math.max(0, top));
    }

    /* ----- theme ----- */
    const THEMES = ['auto', 'light', 'dark'];
    const THEME_LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };
    let themeMode = 'auto';
    let darkQuery = null;
    function isDark() { return themeMode === 'dark' || (themeMode === 'auto' && !!(darkQuery && darkQuery.matches)); }
    function applyTheme(mode, persist) {
        themeMode = THEMES.indexOf(mode) >= 0 ? mode : 'auto';
        const html = doc.documentElement;
        if (themeMode === 'auto') html.removeAttribute('data-theme'); else html.setAttribute('data-theme', themeMode);
        if (persist) storeSet('petSim.theme', themeMode);
        const b = $('themeToggle');
        if (b) {
            const next = THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length];
            b.setAttribute('data-mode', themeMode);
            const lab = b.querySelector('.theme-label');
            if (lab) lab.textContent = THEME_LABEL[themeMode];
            const desc = 'Theme: ' + THEME_LABEL[themeMode] + (themeMode === 'auto' ? ' (follows your system)' : '') + '. Switch to ' + THEME_LABEL[next] + '.';
            b.setAttribute('aria-label', desc);
            b.title = desc;
        }
        bus.emit('theme:changed', { dark: isDark(), mode: themeMode });
    }
    function initTheme() {
        darkQuery = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
        const saved = storeGet('petSim.theme');
        applyTheme(THEMES.indexOf(saved) >= 0 ? saved : 'auto', false);
        const b = $('themeToggle');
        if (b) b.addEventListener('click', function () { applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length], true); });
        if (darkQuery) {
            const onChange = function () { if (themeMode === 'auto') bus.emit('theme:changed', { dark: isDark(), mode: themeMode }); };
            if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange);
            else if (darkQuery.addListener) darkQuery.addListener(onChange);
        }
    }

    /* ----- boot ----- */
    function initialContent() {
        // Load the default protocol without triggering the debounced re-scan;
        // boot runs one instant scan itself once the tabs are mounted.
        const p = getPreset('fdg_static') || (Array.isArray(PET.presets) && PET.presets[0]) || null;
        if (p) {
            state.presetId = p.id; state.source = p.source;
            if (p.phantom) { state.phantomId = p.phantom; state.phantomOpts = deepClone(p.phantomOpts || { condition: 'normal' }); }
        } else if (PET.presets) addProblem('Default protocol', 'the preset "fdg_static" is missing');
        compile();
    }

    function boot() {
        if (booted) return;
        booted = true;
        const step = function (name, fn) {
            try { fn(); }
            catch (e) { log.error('[PET] boot step "' + name + '" failed:', e); addProblem('Start-up (' + name + ')', errMessage(e)); }
        };
        step('theme', initTheme);
        step('scan bar', wireScanBar);
        CORE_MODULES.forEach(function (m) {
            if (!m.present()) addProblem(m.name + ' (' + m.file + ')', bootErrorFor(m.file) || 'not loaded');
        });
        step('tab bar', buildTabs);
        step('presets', initialContent);
        step('tabs', mountTabs);
        const box = $('bootMsg');
        if (box) box.hidden = true;

        const fromHash = hashTab(), saved = storeGet('petSim.tab');
        const first = (fromHash && tabById(fromHash)) ? fromHash : ((saved && tabById(saved)) ? saved : 'lessons');
        step('first tab', function () { showTab(first, { initial: true }); });

        step('initial events', function () {
            let ph = null;
            try { ph = getPhantom(); } catch (e) { addProblem('Phantom', errMessage(e)); }
            bus.emit('phantom:changed', { phantom: ph });
            bus.emit('program:compiled', { program: state.program, errors: state.compileErrors });
            bus.emit('physics:changed', { physics: state.physics });
            bus.emit('reconopts:changed', { recon: state.recon });
            bus.emit('theme:changed', { dark: isDark(), mode: themeMode });
        });
        updateSummary();
        setState('Ready', 'idle');

        root.addEventListener('hashchange', function () {
            const id = hashTab();
            if (id && id !== activeTab && tabById(id)) showTab(id);
        });
        root.addEventListener('resize', U.debounce(function () {
            callTab(tabById(activeTab), 'onShow');
            if (lastThumb.acq) drawSinoThumb(lastThumb.acq);
            if (lastThumb.result) drawImgThumb(lastThumb.result);
        }, 150));
        root.addEventListener('error', function (e) {
            if (!e || (e.target && e.target !== root)) return;
            if (/ResizeObserver loop/.test(e.message || '')) return;
            setMessage('Unexpected error: ' + (e.message || 'see the browser console'), 'bad');
        });
        root.addEventListener('unhandledrejection', function (e) {
            setMessage('Unexpected error: ' + errMessage(e && e.reason), 'bad');
        });

        PET.app.booted = true;
        runScan({ animate: false });
    }

    PET.app = {
        version: VERSION,
        booted: false,
        isDark: isDark,
        themeMode: function () { return themeMode; },
        activeTab: function () { return activeTab; },
        problems: problems,
        playbackSeconds: PLAYBACK,
        notify: notify,
        // exposed for tests
        _merged: merged,
        _thin: thin,
        _partialAcq: partialAcq
    };

    if (doc) {
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

})(typeof window !== 'undefined' ? window : globalThis);
