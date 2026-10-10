/* ============================================================
   MRI Simulator, application shell

   Owns the shared state (MRI.state) and every action that changes it
   (MRI.actions), runs scans and plays them back, and builds the page
   chrome: the scan bar, the tab bar and the theme toggle. Tabs never
   talk to each other directly: they call actions and listen to the
   bus (ARCHITECTURE.md section 12.3 lists the events).

   The flow of one scan:
     settings change -> (250 ms debounce, if Auto re-scan is on) ->
     runScan -> engine.simulate (compute, with progress) ->
     [animated: playback, revealing readouts in time order and
      reconstructing what has been acquired so far every ~200 ms] ->
     scan:done -> recon.run -> recon:done.
   Only one scan runs at a time: a new request asks the running one to
   abort (the engine polls opts.shouldAbort) and waits for it to stop.

   State and actions are created when this file loads, so tab modules
   can use them in mount(). The DOM work (tab bar, scan bar, theme)
   happens on DOMContentLoaded. Without a document (Node tests) only
   the state and actions exist.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const doc = root.document || null;
    const log = root.console || { error: function () {}, warn: function () {}, info: function () {} };

    if (!MRI || !MRI.util || !MRI.bus) {
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
    const U = MRI.util;
    const bus = MRI.bus;
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

    /* How long an animated scan takes on screen, in seconds of wall time,
       for the whole sequence (including dummy scans). */
    const PLAYBACK = { fast: 4, slow: 15, warp: 0.5 };   // seconds of wall time; warp = share of playback paced by readouts

    /* ---------- small utilities ---------- */

    function storeGet(key) { try { return root.localStorage ? root.localStorage.getItem(key) : null; } catch (e) { return null; } }
    function storeSet(key, value) { try { if (root.localStorage) root.localStorage.setItem(key, value); } catch (e) { /* private mode or blocked storage */ } }

    // A plain {..} object (not an array, typed array or class instance). Checked
    // by tag rather than prototype so objects from another realm (Node tests) count.
    function isPlain(o) {
        return o !== null && typeof o === 'object' && !Array.isArray(o) && !ArrayBuffer.isView(o) &&
            Object.prototype.toString.call(o) === '[object Object]';
    }
    function deepClone(o) {
        if (Array.isArray(o)) return o.map(deepClone);
        if (!isPlain(o)) return o;           // numbers, strings, typed arrays (shared, read-only by convention)
        const out = {};
        Object.keys(o).forEach(function (k) { out[k] = deepClone(o[k]); });
        return out;
    }
    /* Merge a patch into a copy of base, recursing into plain objects.
       Returns a new object, so the previous state object is left intact
       (a tab may compare references to see that something changed). */
    function merged(base, patch) {
        const out = Object.assign({}, base);
        Object.keys(patch || {}).forEach(function (k) {
            const v = patch[k];
            if (isPlain(v) && isPlain(out[k])) out[k] = merged(out[k], v);
            else out[k] = deepClone(v);
        });
        return out;
    }
    function errMessage(e) { return e && e.message ? e.message : String(e); }
    function clamp01(x) { return isFinite(x) ? U.clamp(+x, 0, 1) : 0; }

    /* A tiny least-recently-used cache for field maps. */
    function lru(capacity) {
        const m = new Map();
        return {
            get: function (k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
            set: function (k, v) { m.set(k, v); while (m.size > capacity) m.delete(m.keys().next().value); return v; },
            clear: function () { m.clear(); }
        };
    }
    // Stable identity numbers for objects (phantoms) used in cache keys.
    const objIds = new WeakMap();
    let objCounter = 0;
    function objKey(o) { let k = objIds.get(o); if (!k) { k = ++objCounter; objIds.set(o, k); } return k; }

    /* ---------- defaults ---------- */

    /* Artifact settings (ARCHITECTURE.md 9.2, plus the shim currents of 7.1).
       Everything off: the default scan is a clean image. */
    function artifactDefaults() {
        return {
            noise: 1,
            motion: { on: false, kind: 'periodic', amp: 0.004, period: 4.0, at: 0.5, axis: 'y' },
            flow: { on: false, depth: 0.6, period: 0.9, phase: 1.5 },
            b0: { susceptibility: 1, shim: 0, shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } },
            b1: { amount: 0 },
            gradDelay: 0,
            spike: { on: false, amp: 4, at: 0.37 },
            zipper: { on: false, offsetHz: 3000, amp: 0.002 },
            transient: false
        };
    }
    // Used only if recon.js / spectro.js did not load; then the values never matter.
    const RECON_FALLBACK = {
        filter: 'none', filterParam: 0.5, zeroFill: 1, partialFourier: 'homodyne', parallel: 'sense',
        coilCombine: 'sos', coil: 0, densityComp: true, epiGhostCorr: false, cropOversampling: true, userMask: null
    };
    const SPECTRO_FALLBACK = { lb: 1, gb: 0, zf: 2, ph0: 0, ph1: 0, autoPhase: true, refPpm: 4.7, display: 'real' };
    function reconDefaults() { return Object.assign({}, RECON_FALLBACK, (MRI.recon && MRI.recon.defaults) || {}); }
    function spectroDefaults() { return Object.assign({}, SPECTRO_FALLBACK, (MRI.spectro && MRI.spectro.defaults) || {}); }
    const PHANTOM_OPTS_DEFAULT = { lesion: false, gad: 0, overrides: {} };

    /* ---------- state (ARCHITECTURE.md 12.3) ----------
       Besides the contract fields:
         lastGoodProgram   the most recent program that compiled (state.program
                           is the latest result, which may have ok: false)
         acqUpTo           null, or the number of readouts revealed when an
                           animated scan was stopped part way; reconstruct()
                           then uses only those, so every view stays consistent
         stale             settings changed since the last scan
         seed              noise seed passed to the engine (same settings, same image)
         reconMs           duration of the last full reconstruction, ms
         spectro.error     message of the last failed spectroscopy run, or null */
    const state = MRI.state = {
        phantomId: 'brain',
        phantomOpts: deepClone(PHANTOM_OPTS_DEFAULT),
        presetId: 'se', source: '', program: null, compileErrors: [],
        artifacts: artifactDefaults(),
        coilType: 'head8',
        recon: reconDefaults(),
        acq: null, reconResult: null, scanning: false, autoRescan: true, speed: 'fast',
        spectro: {
            presetId: 'fid', source: '', program: null, compileErrors: [], phantomId: 'braino',
            processing: spectroDefaults(), data: null, spectrum: null, error: null, stale: false
        },
        lastGoodProgram: null, acqUpTo: null, stale: false, seed: 1, reconMs: null
    };
    (function restoreSpeed() {
        const s = storeGet('mriSim.speed');
        if (s === 'instant' || s === 'fast' || s === 'slow') state.speed = s;
    })();

    /* ---------- messages to the user ---------- */
    function notify(msg, kind) {
        if (doc && MRI.ui && MRI.ui.w && MRI.ui.w.toast) { try { MRI.ui.w.toast(msg, kind || 'info'); return; } catch (e) { /* fall through */ } }
        (kind === 'bad' ? log.error : log.warn).call(log, '[MRI] ' + msg);
    }

    /* ---------- presets and compilation ---------- */
    function getPreset(id) {
        const P = MRI.presets;
        if (!P) return null;
        if (typeof P.get === 'function') return P.get(id) || null;
        return Array.isArray(P) ? (P.find(function (p) { return p.id === id; }) || null) : null;
    }
    function failedProgram(source, msg, hint) {
        return { ok: false, source: source, params: [], errors: [{ line: 1, col: 1, msg: msg, hint: hint || '' }] };
    }
    function compileSource(source) {
        if (!MRI.dsl || typeof MRI.dsl.compile !== 'function') {
            return failedProgram(source, 'The sequence compiler (js/dsl.js) did not load, so sequences cannot be compiled.');
        }
        try {
            const p = MRI.dsl.compile(source);
            return p || failedProgram(source, 'The sequence compiler returned nothing.');
        } catch (e) {
            log.error(e);
            return failedProgram(source, 'The sequence compiler failed: ' + errMessage(e), 'This is a bug in the simulator, not in your sequence.');
        }
    }
    function compileImaging() {
        const prog = compileSource(state.source);
        state.program = prog;
        state.compileErrors = prog.ok ? [] : (prog.errors || []);
        if (prog.ok) state.lastGoodProgram = prog;
        bus.emit('program:compiled', { program: prog, errors: state.compileErrors });
        return prog;
    }
    function compileSpectro() {
        const sp = state.spectro;
        const prog = compileSource(sp.source);
        sp.program = prog;
        sp.compileErrors = prog.ok ? [] : (prog.errors || []);
        bus.emit('spectro:compiled', { program: prog, errors: sp.compileErrors });
        return prog;
    }

    /* ---------- phantom and field maps ---------- */

    /* The phantom raster must be finer than the image so partial-volume
       edges look right: 256 for matrices up to 128, else 512. */
    function phantomRaster() {
        const p = state.program && state.program.ok ? state.program : state.lastGoodProgram;
        if (p && p.image) return Math.max(p.image.nx || 0, p.image.ny || 0) <= 128 ? 256 : 512;
        return 256;
    }
    const phantomCache = lru(4);
    function buildPhantom(id, n) {
        if (!MRI.phantoms || typeof MRI.phantoms.build !== 'function') throw new Error('The phantom library (js/phantoms.js) did not load.');
        const opts = Object.assign({}, state.phantomOpts, { n: n });
        const key = id + '|' + JSON.stringify(opts);
        return phantomCache.get(key) || phantomCache.set(key, MRI.phantoms.build(id, opts));
    }
    function getPhantom(n) { return buildPhantom(state.phantomId, n || phantomRaster()); }

    /* Field maps are cached by their inputs: the phantom (identity), the
       B0 / B1 settings, and the coil type and raster. The arrays are shared
       between callers, so treat them as read-only. */
    const b0Cache = lru(6), b1Cache = lru(4), coilCache = lru(4);
    function requireFields() { if (!MRI.fields) throw new Error('The field-map module (js/fields.js) did not load.'); }
    function b0MapFor(phantom) {
        requireFields();
        const b0 = state.artifacts.b0 || {};
        const key = objKey(phantom) + '|' + JSON.stringify(b0);
        return b0Cache.get(key) || b0Cache.set(key, MRI.fields.b0Map(phantom, b0));
    }
    function getFields(phantom) {
        phantom = phantom || getPhantom();
        requireFields();
        const b1 = state.artifacts.b1 || {};
        const k1 = objKey(phantom) + '|' + JSON.stringify(b1);
        const b1Map = b1Cache.get(k1) || b1Cache.set(k1, MRI.fields.b1Map(phantom, b1));
        const kc = state.coilType + '|' + phantom.n + '|' + phantom.fov;
        let coils = coilCache.get(kc);
        if (!coils) {
            const coilSet = MRI.fields.coilSet(state.coilType);
            coils = coilCache.set(kc, { coilSet: coilSet, coilMaps: MRI.fields.coilMaps(coilSet, phantom.n, phantom.n, phantom.fov, phantom.fov) });
        }
        return { b0Map: b0MapFor(phantom), b1Map: b1Map, coilSet: coils.coilSet, coilMaps: coils.coilMaps };
    }

    /* ---------- scanning ---------- */
    let scanSeq = 0;            // id of the newest scan request
    let inflight = null;        // promise of the scan running (or queued)
    let abortRequested = false;
    let userStopped = false;    // the abort came from the Stop button (report it) rather than a newer scan (stay quiet)
    let playing = false;        // an animated playback is revealing readouts

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
            if (id !== scanSeq) return null;        // an even newer request arrived while we waited
            abortRequested = false;
            userStopped = false;
            try { return await doScan(req, id); }
            catch (e) { return scanFailed(e); }     // a bug in this file; still never leave the UI busy
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
        scanSeq++;                  // also cancels a scan queued behind the running one
    }

    function scanFailed(err, extra) {
        const message = typeof err === 'string' ? err : errMessage(err);
        if (err && err.stack) log.error(err);
        state.scanning = false;
        playing = false;
        bus.emit('scan:error', Object.assign({ message: message }, extra || {}));
        return null;
    }

    function scanAborted(stage, readoutsDone, total) {
        state.scanning = false;
        playing = false;
        if (userStopped) {
            const message = stage === 'playback'
                ? 'Scan stopped after ' + readoutsDone + ' of ' + total + ' readouts.'
                : 'Scan stopped before any data were acquired.';
            bus.emit('scan:error', { message: message, aborted: true, stage: stage, readoutsDone: readoutsDone });
        }
        return null;
    }

    function compileErrorText(prog) {
        const e = (prog && prog.errors && prog.errors[0]) || null;
        return e ? 'line ' + e.line + ': ' + e.msg : 'the sequence has errors';
    }

    async function doScan(req, id) {
        const shouldAbort = function () { return abortRequested || id !== scanSeq; };
        const prog = state.program;
        if (!prog) return scanFailed('No sequence is loaded.', { stage: 'compile', tab: 'sequence' });
        if (!prog.ok) return scanFailed('The sequence does not compile (' + compileErrorText(prog) + '). Fix it in the Sequence tab.', { stage: 'compile', tab: 'sequence' });
        if (!MRI.engine || typeof MRI.engine.simulate !== 'function') {
            return scanFailed('The imaging engine (js/engine.js) is not available, so nothing can be acquired.', { stage: 'compute' });
        }
        const animate = req.animate && state.speed !== 'instant';
        state.scanning = true;
        state.stale = false;
        bus.emit('scan:start', { animate: animate });
        // Let the browser paint "Computing" before the synchronous phantom and
        // coil-map work below (a few hundred ms the first time at a 512 raster).
        await nextPaint();
        if (shouldAbort()) return scanAborted('compute', 0, 0);

        const t0 = now();
        let acq;
        try {
            const phantom = getPhantom();
            const f = getFields(phantom);
            const ctx = { b0Map: f.b0Map, b1Map: f.b1Map, coilSet: f.coilSet, coilMaps: f.coilMaps, artifacts: state.artifacts };
            acq = await MRI.engine.simulate(prog, phantom, ctx, {
                seed: state.seed,
                shouldAbort: shouldAbort,
                onProgress: function (frac) {
                    if (!shouldAbort()) bus.emit('scan:progress', { frac: clamp01(frac), stage: 'compute' });
                }
            });
        } catch (e) {
            if (shouldAbort()) return scanAborted('compute', 0, 0);
            return scanFailed(e, { stage: 'compute' });
        }
        if (shouldAbort()) return scanAborted('compute', 0, 0);
        if (!acq || !Array.isArray(acq.readouts)) return scanFailed('The imaging engine returned no data.', { stage: 'compute' });
        acq.stats = acq.stats || {};
        if (!isFinite(acq.stats.computeMs)) acq.stats.computeMs = now() - t0;

        if (animate && acq.readouts.length) {
            // The data exist already; playback reveals them in acquisition order.
            state.acq = acq;
            state.acqUpTo = 0;
            playing = true;
            const r = await playback(acq, prog, shouldAbort);
            playing = false;
            if (r.aborted) {
                // Keep what was revealed. When the student pressed Stop, show
                // exactly that much; when a newer scan took over, it will
                // replace everything anyway.
                state.acqUpTo = r.readoutsDone;
                if (userStopped && r.readoutsDone > 0 && r.readoutsDone !== r.reconned) partialRecon(acq, r.readoutsDone);
                return scanAborted('playback', r.readoutsDone, acq.readouts.length);
            }
        }
        state.acq = acq;
        state.acqUpTo = null;
        state.scanning = false;
        bus.emit('scan:done', { acq: acq });
        reconstruct();
        return acq;
    }

    /* ---------- playback ----------
       Sequence time is mapped linearly onto wall time, so the student sees
       the real proportions: a spin echo spends most of each TR waiting for
       T1 recovery, a single-shot EPI acquires the whole of k-space in one
       burst after its dummy scans. A whole scan lasts PLAYBACK.fast or
       .slow seconds.

       At these speeds one animation frame covers many milliseconds of
       sequence time (for a 6.5 min spin echo in 4 s, about 1.5 s per frame),
       so an instantaneous sample would almost never land on a 2 ms RF
       pulse. Each tick therefore reports what happened during the frame:
       the RF pulse active at t, or else the last one played in the frame;
       the gradient amplitude at t, or else the peak amplitude in the
       frame; and whether the ADC was on at any time in the frame. That
       keeps the scanner schematic's lights honest about activity. */
    function trapEnd(tr) { return tr.t0 + tr.rise + tr.flat + tr.fall; }
    function trapValue(tr, t) {
        const u = t - tr.t0;
        if (u <= 0 || u >= tr.rise + tr.flat + tr.fall) return 0;
        if (u < tr.rise) return tr.amp * u / tr.rise;
        if (u <= tr.rise + tr.flat) return tr.amp;
        return tr.amp * (tr.rise + tr.flat + tr.fall - u) / tr.fall;
    }

    /* Map playback progress (0..1 of wall time) onto sequence time.
       A purely linear map is faithful but hides the most instructive part
       of fast sequences: a single-shot EPI spends a few tens of ms filling
       all of k-space after seconds of dummy TRs, so it would appear in one
       frame. Instead, half of the wall time follows sequence time and half
       is shared out by readouts, so k-space always fills visibly. For an
       evenly spaced acquisition (spin echo, GRE) the two halves agree and
       the map stays linear. PLAYBACK.warp sets the readout share (0..1). */
    function buildWarp(reads, ends, T) {
        const nR = reads.length;
        const a = 1 - U.clamp(PLAYBACK.warp === undefined ? 0.5 : PLAYBACK.warp, 0, 1);
        if (!nR || a >= 1) return function (f) { return f * T; };
        const ts = [0], rs = [0];
        let last = 0;
        for (let i = 0; i < nR; i++) {
            const s0 = Math.max(last, reads[i].t0 || 0), e0 = Math.max(s0, ends[i]);
            ts.push(s0); rs.push(i);
            ts.push(e0); rs.push(i + 1);
            last = e0;
        }
        ts.push(Math.max(last, T)); rs.push(nR);
        const ws = ts.map(function (t, k) { return a * t / T + (1 - a) * rs[k] / nR; });
        return function (f) {
            if (f <= 0) return 0;
            if (f >= 1) return T;
            let lo = 0, hi = ws.length - 1;
            while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ws[mid] <= f) lo = mid; else hi = mid; }
            const dw = ws[hi] - ws[lo];
            return dw > 0 ? ts[lo] + (ts[hi] - ts[lo]) * (f - ws[lo]) / dw : ts[hi];
        };
    }

    function playback(acq, prog, shouldAbort) {
        return new Promise(function (resolve) {
            const reads = acq.readouts, nR = reads.length;
            const ends = new Float64Array(nR);
            for (let i = 0; i < nR; i++) {
                const r = reads[i];
                ends[i] = (r.t0 || 0) + (r.n || 0) * (r.dwell || 0);
                if (i && ends[i] < ends[i - 1]) ends[i] = ends[i - 1];     // acquisition order is time order; be safe
            }
            const T = Math.max(prog.duration || 0, nR ? ends[nR - 1] : 0) || 1;
            const wallMs = 1000 * (state.speed === 'slow' ? PLAYBACK.slow : PLAYBACK.fast);
            const warp = buildWarp(reads, ends, T);
            const byT0 = function (a, b) { return a.t0 - b.t0; };
            const rf = (prog.rf || []).slice().sort(byT0);
            const adc = (prog.adc || []).filter(function (a) { return !a.dummy; }).sort(byT0);
            const periods = prog.periods || [];
            const grad = prog.grad || {};
            const axes = ['x', 'y', 'z'];
            const gl = {}, gp = {};
            axes.forEach(function (a) { gl[a] = (grad[a] || []).slice().sort(byT0); gp[a] = 0; });
            const hasGradAt = MRI.dsl && typeof MRI.dsl.gradientAt === 'function';
            let pRf = 0, pAdc = 0, pPer = 0;
            let start = null, tPrev = 0, done = 0, lastRecon = -Infinity, reconned = 0;

            function rfInWindow(tA, t) {
                while (pRf < rf.length && rf[pRf].t0 + rf[pRf].dur < tA) pRf++;
                let active = null, held = null;
                for (let j = pRf; j < rf.length && rf[j].t0 <= t; j++) {
                    if (rf[j].t0 + rf[j].dur >= t) active = rf[j]; else held = rf[j];
                }
                return active || held;
            }
            function gradInWindow(a, tA, t) {
                const list = gl[a];
                let v = 0;
                if (hasGradAt) { try { v = MRI.dsl.gradientAt(prog, a, t); } catch (e) { v = 0; } }
                while (gp[a] < list.length && trapEnd(list[gp[a]]) < tA) gp[a]++;
                if (!hasGradAt) {
                    for (let j = gp[a]; j < list.length && list[j].t0 <= t; j++) { const x = trapValue(list[j], t); if (x) v = x; }
                }
                if (v) return v;
                let peak = 0;
                for (let j = gp[a]; j < list.length && list[j].t0 <= t; j++) {
                    if (Math.abs(list[j].amp) > Math.abs(peak)) peak = list[j].amp;
                }
                return peak;
            }
            function adcInWindow(tA, t) {
                while (pAdc < adc.length && adc[pAdc].t0 + adc[pAdc].n * adc[pAdc].dwell < tA) pAdc++;
                return pAdc < adc.length && adc[pAdc].t0 <= t;
            }
            function periodAt(t) {
                while (pPer + 1 < periods.length && periods[pPer + 1].t0 <= t) pPer++;
                if (!periods.length) return 0;
                const p = periods[pPer];
                return p && p.index !== undefined ? p.index : pPer;
            }

            let reconBroken = false;
            function frame() {
                const tNow = now();
                if (start === null) start = tNow;
                if (shouldAbort()) { resolve({ aborted: true, readoutsDone: done, reconned: reconned }); return; }
                const frac = Math.min(1, (tNow - start) / wallMs);
                const t = warp(frac);
                while (done < nR && ends[done] <= t + 1e-12) done++;
                const tick = {
                    t: t, frac: frac, readoutsDone: done,
                    rf: rfInWindow(tPrev, t),
                    grad: { x: gradInWindow('x', tPrev, t), y: gradInWindow('y', tPrev, t), z: gradInWindow('z', tPrev, t) },
                    adcOn: adcInWindow(tPrev, t),
                    period: periodAt(t),
                    // extensions: the sequence-time window this frame covers, and totals
                    t0: tPrev, duration: T, readouts: nR
                };
                bus.emit('playback:tick', tick);
                bus.emit('scan:progress', { frac: frac, stage: 'playback' });
                if (frac < 1 && done > reconned && tNow - lastRecon >= 200 && !reconBroken) {
                    if (!partialRecon(acq, done)) reconBroken = true;
                    lastRecon = now();
                    reconned = done;
                }
                tPrev = t;
                if (frac >= 1) resolve({ aborted: false, readoutsDone: nR, reconned: reconned });
                else raf(frame);
            }
            raf(frame);
        });
    }

    /* Reconstruct the first `upTo` readouts (playback, or a stopped scan). */
    function partialRecon(acq, upTo) {
        if (!MRI.recon || typeof MRI.recon.run !== 'function') return false;
        try {
            const result = MRI.recon.run(acq, state.recon, { upTo: upTo });
            state.reconResult = result;
            bus.emit('recon:done', { result: result, partial: true });
            return true;
        } catch (e) {
            log.error('[MRI] partial reconstruction failed:', e);
            return false;
        }
    }

    /* Full reconstruction of state.acq with state.recon. During playback it
       does nothing: the playback loop already uses the current options. */
    function reconstruct() {
        if (!state.acq || playing) return null;
        if (!MRI.recon || typeof MRI.recon.run !== 'function') {
            bus.emit('scan:error', { message: 'The reconstruction module (js/recon.js) is not available, so no image can be formed.', stage: 'recon' });
            return null;
        }
        const upTo = state.acqUpTo;
        try {
            const t0 = now();
            const result = MRI.recon.run(state.acq, state.recon, upTo !== null && upTo !== undefined ? { upTo: upTo } : {});
            state.reconMs = now() - t0;
            state.reconResult = result;
            bus.emit('recon:done', { result: result, partial: upTo !== null && upTo !== undefined });
            return result;
        } catch (e) {
            log.error(e);
            bus.emit('scan:error', { message: 'Reconstruction failed: ' + errMessage(e), stage: 'recon' });
            return null;
        }
    }

    /* Settings changed: re-scan instantly once the student pauses (250 ms).
       Actions set state.stale before they emit their event, so listeners
       (the scan bar summary) already see it, then call scheduleRescan. */
    const scheduleRescan = U.debounce(function () {
        if (state.autoRescan && state.program && state.program.ok) runScan({ animate: false });
    }, 250);

    /* ---------- spectroscopy ---------- */
    let spectroSeq = 0;
    let activeTab = null;
    const scheduleSpectro = U.debounce(function () {
        if (state.spectro.program && state.spectro.program.ok) runSpectro();
    }, 250);
    /* Phantom options and artifacts (B0, shim, noise) also change the
       spectrum. Re-run now if the Spectroscopy tab is open, otherwise
       when it is next shown. */
    function spectroInputsChanged() {
        const sp = state.spectro;
        if (!sp.program || !sp.program.ok) return;
        if (activeTab === 'spectro' || !doc) scheduleSpectro();
        else sp.stale = true;
    }

    async function runSpectro() {
        const sp = state.spectro;
        const id = ++spectroSeq;
        const fail = function (message, e) {
            if (e) log.error(e);
            sp.error = message;
            bus.emit('spectro:error', { message: message });
            return null;
        };
        if (!sp.program || !sp.program.ok) return fail('The spectroscopy sequence does not compile (' + compileErrorText(sp.program) + ').');
        if (!MRI.spectro || typeof MRI.spectro.simulate !== 'function') return fail('The spectroscopy simulator (js/spectro.js) is not available.');
        try {
            const phantom = buildPhantom(sp.phantomId, 256);
            const ctx = { b0Map: b0MapFor(phantom), artifacts: state.artifacts };
            let data = MRI.spectro.simulate(sp.program, phantom, ctx, { seed: state.seed });
            if (data && typeof data.then === 'function') data = await data;
            if (id !== spectroSeq) return null;               // a newer run has started
            if (!data) return fail('The spectroscopy simulator returned no data.');
            const spectrum = MRI.spectro.process(data, sp.processing);
            sp.data = data; sp.spectrum = spectrum; sp.error = null; sp.stale = false;
            bus.emit('spectro:done', { data: data, spectrum: spectrum });
            return { data: data, spectrum: spectrum };
        } catch (e) {
            if (id !== spectroSeq) return null;
            return fail('Spectroscopy failed: ' + errMessage(e), e);
        }
    }
    function reprocessSpectro() {
        const sp = state.spectro;
        if (!sp.data || !MRI.spectro || typeof MRI.spectro.process !== 'function') return null;
        try {
            sp.spectrum = MRI.spectro.process(sp.data, sp.processing);
            bus.emit('spectro:done', { data: sp.data, spectrum: sp.spectrum });
            return sp.spectrum;
        } catch (e) {
            log.error(e);
            sp.error = 'Spectral processing failed: ' + errMessage(e);
            bus.emit('spectro:error', { message: sp.error });
            return null;
        }
    }

    /* ---------- actions (ARCHITECTURE.md 12.3) ---------- */
    function phantomChanged() {
        let ph = null;
        state.stale = true;
        try { ph = getPhantom(); }
        catch (e) { log.error(e); notify('Could not build the phantom: ' + errMessage(e), 'bad'); }
        bus.emit('phantom:changed', { phantom: ph });
        scheduleRescan();
        spectroInputsChanged();
    }
    function knownPhantom(id) {
        try { return !MRI.phantoms || !MRI.phantoms.list || MRI.phantoms.list().some(function (p) { return p.id === id; }); }
        catch (e) { return true; }
    }
    function setSourceInternal(text) {
        state.source = text == null ? '' : String(text);
        state.stale = true;
        compileImaging();
        scheduleRescan();
    }
    function hasParam(prog, name) {
        return !!(prog && prog.params && prog.params.some(function (p) { return p.name === name; }));
    }

    const actions = MRI.actions = {
        getPhantom: getPhantom,
        getFields: getFields,

        /* Switch phantom. opts, if given, replaces the phantom options
           (missing keys take their defaults). */
        setPhantom: function (id, opts) {
            if (!knownPhantom(id)) { notify('There is no phantom called "' + id + '".', 'warn'); return false; }
            state.phantomId = id;
            if (opts) state.phantomOpts = merged(PHANTOM_OPTS_DEFAULT, opts);
            phantomChanged();
            return true;
        },
        /* Shallow merge: {lesion}, {gad} or {overrides}. overrides is replaced
           as a whole, so pass the complete object (an empty one resets it). */
        setPhantomOpts: function (patch) {
            state.phantomOpts = Object.assign({}, state.phantomOpts, patch || {});
            phantomChanged();
        },
        loadPreset: function (id) {
            const p = getPreset(id);
            if (!p) { notify('There is no preset called "' + id + '".', 'warn'); return false; }
            state.presetId = id;
            setSourceInternal(p.source);
            return true;
        },
        setSource: function (text) { setSourceInternal(text); },
        /* Write a new value (SI) for a declared param into the source, in the
           param's own unit, and recompile. Returns false if there is no such param. */
        setParam: function (name, valueSI) {
            if (!MRI.dsl || typeof MRI.dsl.setParamInSource !== 'function') return false;
            const prog = state.program && state.program.params && state.program.params.length ? state.program : state.lastGoodProgram;
            if (!hasParam(prog, name)) { log.warn('[MRI] setParam: the sequence has no param "' + name + '"'); return false; }
            const src = MRI.dsl.setParamInSource(state.source, prog, name, valueSI);
            if (src !== state.source) setSourceInternal(src);
            return true;
        },
        /* Deep merge into the artifact settings, e.g. setArtifacts({motion: {on: true}}). */
        setArtifacts: function (patch) {
            state.artifacts = merged(state.artifacts, patch || {});
            state.stale = true;
            bus.emit('artifacts:changed', { artifacts: state.artifacts });
            scheduleRescan();
            spectroInputsChanged();
        },
        resetArtifacts: function () {
            state.artifacts = artifactDefaults();
            state.stale = true;
            bus.emit('artifacts:changed', { artifacts: state.artifacts });
            scheduleRescan();
            spectroInputsChanged();
        },
        setCoil: function (type) {
            if (type !== 'body' && type !== 'head8') { notify('Unknown coil type "' + type + '".', 'warn'); return false; }
            state.coilType = type;
            state.stale = true;
            bus.emit('coil:changed', { coilType: type });
            scheduleRescan();
            return true;
        },
        /* Shallow merge into the recon options; only the reconstruction re-runs. */
        setRecon: function (patch) {
            state.recon = Object.assign({}, state.recon, patch || {});
            return reconstruct();
        },
        reconstruct: reconstruct,
        runScan: runScan,
        stopScan: stopScan,
        showTab: function (id) { return showTab(id); },

        /* Extensions used by the scan bar (and handy for lessons). */
        setAutoRescan: function (on) {
            state.autoRescan = !!on;
            syncScanControls();
            updateSummary();
            if (state.autoRescan && state.stale) scheduleRescan();
        },
        setSpeed: function (speed) {
            if (speed !== 'instant' && speed !== 'fast' && speed !== 'slow') return false;
            state.speed = speed;
            storeSet('mriSim.speed', speed);
            syncScanControls();
            return true;
        },
        /* {name, phantom, nx, ny, TR, TE, scanTime} for the current program
           (seconds), plus phantomId, TI, ok and errors. Falls back to the last
           program that compiled when the current source has errors. */
        currentSummary: function () {
            const ok = !!(state.program && state.program.ok);
            const p = ok ? state.program : state.lastGoodProgram;
            let phantomName = state.phantomId;
            try {
                const l = MRI.phantoms.list().find(function (x) { return x.id === state.phantomId; });
                if (l) phantomName = l.name;
            } catch (e) { /* phantoms missing: show the id */ }
            const param = function (name) {
                const q = p && p.params ? p.params.find(function (x) { return x.name === name; }) : null;
                return q ? q.value : null;
            };
            const st = (p && p.stats) || {};
            const preset = getPreset(state.presetId);
            return {
                name: p ? (p.name || (preset && preset.name) || 'Untitled sequence') : null,
                phantom: phantomName,
                phantomId: state.phantomId,
                nx: p && p.image ? p.image.nx : null,
                ny: p && p.image ? p.image.ny : null,
                TR: p ? (st.TR !== null && st.TR !== undefined ? st.TR : param('TR')) : null,
                TE: p ? (st.TE !== null && st.TE !== undefined ? st.TE : param('TE')) : null,
                TI: p ? (st.TI !== null && st.TI !== undefined ? st.TI : param('TI')) : null,
                scanTime: p ? p.scanTime : null,
                ok: ok,
                errors: state.compileErrors.length
            };
        },

        spectro: {
            loadPreset: function (id) {
                const p = getPreset(id);
                if (!p) { notify('There is no preset called "' + id + '".', 'warn'); return false; }
                state.spectro.presetId = id;
                state.spectro.source = p.source;
                compileSpectro();
                scheduleSpectro();
                return true;
            },
            setSource: function (text) {
                state.spectro.source = text == null ? '' : String(text);
                compileSpectro();
                scheduleSpectro();
            },
            setParam: function (name, valueSI) {
                const sp = state.spectro;
                if (!MRI.dsl || typeof MRI.dsl.setParamInSource !== 'function' || !hasParam(sp.program, name)) return false;
                const src = MRI.dsl.setParamInSource(sp.source, sp.program, name, valueSI);
                if (src !== sp.source) { sp.source = src; compileSpectro(); scheduleSpectro(); }
                return true;
            },
            setPhantom: function (id) {
                if (!knownPhantom(id)) { notify('There is no phantom called "' + id + '".', 'warn'); return false; }
                state.spectro.phantomId = id;
                scheduleSpectro();
                return true;
            },
            /* Shallow merge into the processing options; only re-processes. */
            setProcessing: function (patch) {
                state.spectro.processing = Object.assign({}, state.spectro.processing, patch || {});
                return reprocessSpectro();
            },
            run: function () { return runSpectro(); }
        }
    };

    /* ============================================================
       Page shell (DOM). Everything below runs only in a browser.
       ============================================================ */
    const $ = function (id) { return doc ? doc.getElementById(id) : null; };

    const KNOWN_TABS = [
        { id: 'lessons', order: 0, title: 'Guide', file: 'js/ui/lessons.js' },
        { id: 'scanner', order: 10, title: 'Scanner', file: 'js/ui/scanner.js' },
        { id: 'phantom', order: 20, title: 'Phantom', file: 'js/ui/phantom.js' },
        { id: 'sequence', order: 30, title: 'Sequence', file: 'js/ui/sequence.js' },
        { id: 'contrast', order: 40, title: 'Contrast', file: 'js/ui/contrast.js' },
        { id: 'kspace', order: 50, title: 'k-space', file: 'js/ui/kspace.js' },
        { id: 'image', order: 60, title: 'Image', file: 'js/ui/image.js' },
        { id: 'artifacts', order: 70, title: 'Artifacts', file: 'js/ui/artifacts.js' },
        { id: 'spectro', order: 80, title: 'Spectroscopy', file: 'js/ui/spectro.js' }
    ];
    const CORE_MODULES = [
        { file: 'js/tissues.js', name: 'tissue library', present: function () { return !!MRI.tissues; } },
        { file: 'js/phantoms.js', name: 'phantoms', present: function () { return !!MRI.phantoms; } },
        { file: 'js/fields.js', name: 'field maps and coils', present: function () { return !!MRI.fields; } },
        { file: 'js/dsl.js', name: 'sequence compiler', present: function () { return !!MRI.dsl; } },
        { file: 'js/presets.js', name: 'sequence presets', present: function () { return !!MRI.presets; } },
        { file: 'js/engine.js', name: 'imaging engine', present: function () { return !!MRI.engine; } },
        { file: 'js/recon.js', name: 'reconstruction', present: function () { return !!MRI.recon; } },
        { file: 'js/spectro.js', name: 'spectroscopy simulator', present: function () { return !!MRI.spectro; } },
        { file: 'js/ui/widgets.js', name: 'shared widgets', present: function () { return !!(MRI.ui && MRI.ui.w); } },
        { file: 'js/ui/timing.js', name: 'timing diagram', present: function () { return !!(MRI.ui && MRI.ui.timing); } }
    ];

    const problems = [];          // [{name, detail}] shown behind the "parts missing" badge
    let tabs = [];                // [{id, title, order, def, panel, button, missing, failed}]
    let booted = false;

    function bootErrorFor(file) {
        const list = MRI.bootErrors || [];
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
        if (action) {
            m.appendChild(U.el('button', { type: 'button', class: 'linklike', onclick: action.run }, action.label));
        }
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
    function fmtMs(s) { return U.fmtNum(s * 1e3, 4) + ' ms'; }
    function fmtClock(s, total) {
        if (total >= 60) { const m = Math.floor(s / 60), r = Math.floor(s - 60 * m); return m + ':' + (r < 10 ? '0' : '') + r; }
        return (total >= 10 ? s.toFixed(1) : s.toFixed(2)) + ' s';
    }
    function updateSummary() {
        const el = $('scanSummary');
        if (!el) return;
        const s = actions.currentSummary();
        el.textContent = '';
        const add = function (text, cls) { el.appendChild(cls ? U.el('span', { class: cls, text: text }) : doc.createTextNode(text)); };
        if (!s.name) {
            add(state.compileErrors.length ? 'The sequence has errors: ' + compileErrorText(state.program) : 'No sequence loaded', state.compileErrors.length ? 'sum-bad' : null);
        } else {
            add(s.name, 'sum-name');
            const parts = [s.phantom];
            if (s.nx && s.ny) parts.push(s.nx + '×' + s.ny);
            if (s.TR !== null && isFinite(s.TR)) parts.push('TR ' + fmtMs(s.TR));
            if (s.TI !== null && isFinite(s.TI) && s.TI > 0) parts.push('TI ' + fmtMs(s.TI));
            if (s.TE !== null && isFinite(s.TE)) parts.push('TE ' + fmtMs(s.TE));
            if (s.scanTime !== null && isFinite(s.scanTime)) parts.push('scan ' + U.fmtTime(s.scanTime));
            add(' · ' + parts.join(' · '));
            if (!s.ok) add(' · error, ' + compileErrorText(state.program), 'sum-bad');
            else if (state.stale && !state.autoRescan && state.acq) add(' · changed since the last scan', 'sum-stale');
        }
        el.title = el.textContent;
    }

    /* Thumbnails: coil-1 k-space (log magnitude, about 4.5 decades) and
       the magnitude image at its physical aspect ratio. */
    let lastThumbResult = null;
    function thumbCanvas(id) {
        const c = $(id);
        if (!c || !c.clientWidth) return null;           // hidden on narrow screens
        const r = U.setupCanvas(c);
        r.ctx.fillStyle = '#000';
        r.ctx.fillRect(0, 0, r.w, r.h);
        return { c: c, w: r.w, h: r.h };
    }
    function drawThumbs(result) {
        lastThumbResult = result;
        if (!result) return;
        try {
            const k = result.kspace, T = thumbCanvas('thumbKCanvas');
            if (T && k && k.re && k.re.length && k.nx && k.ny) {
                const re = k.re[0], im = k.im[0], N = k.nx * k.ny, lg = new Float32Array(N);
                let mx = -Infinity;
                for (let i = 0; i < N; i++) {
                    const m = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
                    if (m > 0) { const v = Math.log10(m); lg[i] = v; if (v > mx) mx = v; }
                    else lg[i] = NaN;                        // not acquired (yet): black
                }
                // k-space spans the same k range on both axes even when the readout is
                // oversampled, so stretching the grid to a square is physically right.
                if (isFinite(mx)) U.drawImage(T.c, lg, k.nx, k.ny, { min: mx - 4.5, max: mx, smooth: true });
            }
        } catch (e) { log.warn('[MRI] k-space thumbnail failed:', e); }
        try {
            const im = result.image, T = thumbCanvas('thumbImgCanvas');
            if (T && im && im.mag && im.nx && im.ny) {
                const aspect = im.fovX && im.fovY ? im.fovY / im.fovX : im.ny / im.nx;
                let w = T.w, h = T.w * aspect;
                if (h > T.h) { h = T.h; w = h / aspect; }
                const hi = U.percentile(im.mag, 99.5);
                U.drawImage(T.c, im.mag, im.nx, im.ny, { min: 0, max: hi > 0 ? hi : 1, smooth: true, x: (T.w - w) / 2, y: (T.h - h) / 2, w: w, h: h });
            }
        } catch (e) { log.warn('[MRI] image thumbnail failed:', e); }
    }
    function markThumbs(stale) {
        ['thumbK', 'thumbImg'].forEach(function (id) { const b = $(id); if (b) b.classList.toggle('stale', !!stale); });
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
        const tk = $('thumbK'), ti = $('thumbImg');
        if (tk) tk.addEventListener('click', function () { showTab('kspace'); });
        if (ti) ti.addEventListener('click', function () { showTab('image'); });
        syncScanControls();

        let scanAnimated = false;
        bus.on('scan:start', function (e) {
            scanAnimated = !!(e && e.animate);
            setBusy(true);
            setState('Computing', 'busy');
            setMessage('simulating the signal');
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
            setMessage(e.readoutsDone + ' of ' + e.readouts + ' readouts · ' + fmtClock(e.t, e.duration) + ' of ' + fmtClock(e.duration, e.duration));
        });
        bus.on('scan:done', function (e) {
            setBusy(false);
            setProgress(1, 'done');
            const acq = e && e.acq, st = (acq && acq.stats) || {};
            const n = acq && acq.readouts ? acq.readouts.length : 0;
            setState('Done', 'done');
            const warn = acq && acq.warnings && acq.warnings.length ? acq.warnings[0] : null;
            if (warn) setMessage(warn, 'warn');
            else setMessage(n + ' readouts' + (isFinite(st.computeMs) ? ' · computed in ' + U.fmtTime(st.computeMs / 1000) : '') + (scanAnimated ? '' : ' · instant'));
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
                setMessage(msg, 'bad', e && e.tab ? { label: 'Open the ' + (e.tab === 'sequence' ? 'Sequence' : e.tab) + ' tab', run: function () { showTab(e.tab); } } : null);
            }
            updateSummary();
        });
        bus.on('recon:done', function (e) {
            if (!e || !e.result) return;
            markThumbs(false);          // dimmed only while computing; during playback they fill visibly
            drawThumbs(e.result);
        });
        bus.on('spectro:error', function (e) {
            if (activeTab === 'spectro' && e && e.message) setMessage(e.message, 'bad');
        });
        ['program:compiled', 'phantom:changed', 'artifacts:changed', 'coil:changed'].forEach(function (evt) {
            bus.on(evt, updateSummary);
        });
    }

    /* ----- tab bar ----- */
    function panelFor(id) {
        let p = $('tab-' + id);
        if (!p) {
            p = U.el('section', { class: 'tab-panel', id: 'tab-' + id, role: 'tabpanel', 'aria-labelledby': 'tabbtn-' + id, hidden: true });
            const host = $('panels') || doc.body;
            host.appendChild(p);
        }
        return p;
    }
    function errorCard(title, err) {
        if (MRI.ui && MRI.ui.w && MRI.ui.w.errorCard) { try { return MRI.ui.w.errorCard(title, err); } catch (e) { /* fall back */ } }
        return U.el('div', { class: 'error-card', role: 'alert' }, [
            U.el('div', { class: 'error-card-title', text: title }),
            U.el('div', { class: 'error-card-msg', text: err ? errMessage(err) : '' })
        ]);
    }

    function buildTabs() {
        const byId = {};
        KNOWN_TABS.forEach(function (k) { byId[k.id] = Object.assign({ def: null }, k); });
        (MRI.ui.tabs || []).forEach(function (t) {
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
                // A plain {message} (no stack): the stack would point at app.js, not at the cause.
                t.panel.appendChild(errorCard('The ' + t.title + ' tab is unavailable',
                    { message: (t.file || 'Its script') + ': ' + why + '. The other tabs still work.' }));
                addProblem(t.title + ' tab', why);
                return;
            }
            if (typeof t.def.mount !== 'function') return;
            try {
                t.def.mount(t.panel);
            } catch (e) {
                log.error('[MRI] the ' + t.id + ' tab failed to mount:', e);
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
            log.error('[MRI] ' + t.id + '.' + hook + ' failed:', e);
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
        storeSet('mriSim.tab', t.id);
        writeHash(t.id);
        if (changed && !opts.initial) keepPanelInView();
        if (changed || opts.initial) {
            callTab(t, 'onShow');
            bus.emit('tab:shown', { id: t.id });
            if (t.id === 'spectro' && state.spectro.stale) scheduleSpectro();
        }
        return true;
    }
    /* After switching tabs, if the page was scrolled into the old tab, jump
       to the top of the new one rather than landing in its middle. */
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
        if (persist) storeSet('mriSim.theme', themeMode);
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
        const saved = storeGet('mriSim.theme');
        applyTheme(THEMES.indexOf(saved) >= 0 ? saved : 'auto', false);
        const b = $('themeToggle');
        if (b) b.addEventListener('click', function () {
            applyTheme(THEMES[(THEMES.indexOf(themeMode) + 1) % THEMES.length], true);
        });
        if (darkQuery) {
            const onChange = function () { if (themeMode === 'auto') bus.emit('theme:changed', { dark: isDark(), mode: themeMode }); };
            if (darkQuery.addEventListener) darkQuery.addEventListener('change', onChange);
            else if (darkQuery.addListener) darkQuery.addListener(onChange);
        }
    }

    /* ----- boot ----- */
    function initialContent() {
        // Load the default sequences without triggering the debounced re-scan;
        // boot runs one instant scan itself once the tabs are mounted.
        const se = getPreset((MRI.presets && MRI.presets.defaultId) || 'se') || getPreset('se');
        if (se) { state.presetId = se.id; state.source = se.source; }
        else if (MRI.presets) addProblem('Default sequence', 'the preset "se" is missing');
        compileImaging();
        const fid = getPreset('fid');
        if (fid) { state.spectro.presetId = fid.id; state.spectro.source = fid.source; compileSpectro(); }
    }

    function boot() {
        if (booted) return;
        booted = true;
        const step = function (name, fn) {
            try { fn(); }
            catch (e) { log.error('[MRI] boot step "' + name + '" failed:', e); addProblem('Start-up (' + name + ')', errMessage(e)); }
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

        // First tab: the URL hash, then the last one used, else the Guide.
        const fromHash = hashTab(), saved = storeGet('mriSim.tab');
        const first = (fromHash && tabById(fromHash)) ? fromHash : ((saved && tabById(saved)) ? saved : 'lessons');
        step('first tab', function () { showTab(first, { initial: true }); });

        // Tell the freshly mounted tabs about the initial state.
        step('initial events', function () {
            let ph = null;
            try { ph = getPhantom(); } catch (e) { addProblem('Phantom', errMessage(e)); }
            bus.emit('phantom:changed', { phantom: ph });
            bus.emit('program:compiled', { program: state.program, errors: state.compileErrors });
            if (state.spectro.program) bus.emit('spectro:compiled', { program: state.spectro.program, errors: state.spectro.compileErrors });
            bus.emit('artifacts:changed', { artifacts: state.artifacts });
            bus.emit('coil:changed', { coilType: state.coilType });
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
            if (lastThumbResult) drawThumbs(lastThumbResult);
        }, 150));
        // A last line of defence: surface unexpected errors instead of failing silently.
        root.addEventListener('error', function (e) {
            if (!e || (e.target && e.target !== root)) return;     // resource load errors are handled at boot
            if (/ResizeObserver loop/.test(e.message || '')) return;  // benign layout notice, not a failure
            setMessage('Unexpected error: ' + (e.message || 'see the browser console'), 'bad');
        });
        root.addEventListener('unhandledrejection', function (e) {
            setMessage('Unexpected error: ' + errMessage(e && e.reason), 'bad');
        });

        MRI.app.booted = true;
        // An instant scan so that every tab has data to show, then the FID.
        runScan({ animate: false }).then(function () {
            if (state.spectro.program && state.spectro.program.ok && MRI.spectro) return runSpectro();
            return null;
        });
    }

    MRI.app = {
        version: VERSION,
        booted: false,
        isDark: isDark,
        themeMode: function () { return themeMode; },
        activeTab: function () { return activeTab; },
        problems: problems,
        playbackSeconds: PLAYBACK,
        // exposed for tests
        _merged: merged,
        _fmtClock: fmtClock
    };

    if (doc) {
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
        else boot();
    }

})(typeof window !== 'undefined' ? window : globalThis);
