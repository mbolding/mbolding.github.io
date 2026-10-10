/* ============================================================
   MRI Simulator, imaging engine

   Turns a compiled pulse sequence (a SeqProgram from dsl.js) and a
   phantom into the raw data a scanner records: one complex number per
   ADC sample per receive coil (AcqData, ARCHITECTURE.md section 9).

   The model, in the order the code runs:

   1. Spin classes. Every non-air point of the phantom raster belongs
      to a class: its tissue, the bin of the transmit field (B1) it
      sees and, only when the sequence has spectrally selective pulses,
      the bin of its total off-resonance. All points of a class share
      one magnetisation history, so the relaxation bookkeeping is done
      a few dozen times instead of a hundred thousand.
   2. One coherence pathway. Walking the RF, spoiler and ADC events in
      time order, each class keeps its longitudinal magnetisation Mz and
      the amplitude of the one transverse pathway the sequence is built
      to refocus. One global state follows where that pathway sits in
      k-space and its dephasing clock tau (how long off-resonance has
      been winding up phase): an excitation starts both at zero, a
      refocusing pulse negates both. This gives the right contrast and
      echo timing for spin echo, spoiled gradient echo, inversion
      recovery, turbo spin echo and EPI. It does not give stimulated
      echoes or balanced SSFP, which is the stated simplification.
   3. Signal synthesis. Each readout is the sum over phantom points of
          m(r) C(r) exp(-i 2 pi [k(t).r + df(r) tau(t)]) dA (dz / 5 mm)
      (section 3). When the gradients are constant during the ADC, as
      they are for every named readout, that sum is a 1D Fourier
      transform in disguise and an FFT computes it (the fast path).
      Otherwise the sum is evaluated sample by sample on a coarser
      raster (the general path).
   4. Imperfections act where they act in a real scanner: motion moves
      the object, flow modulates the blood signal, a gradient delay
      shifts where k-space really is, B0 and B1 come from their maps
      (B0 also dephases spins through the thickness of the slice, see
      throughPlaneGradient). The reconstruction only ever sees the
      nominal k positions, which is exactly why these become artifacts.
      Spikes, zipper interference and thermal noise are added to the
      recorded samples, because that is where they enter a real
      receiver.

   Pure computation, no DOM: tests/test_engine.js runs it in Node.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const C = MRI.const;
    const U = MRI.util;
    const { PI, abs, sqrt, sin, cos, exp, log, floor, ceil, round, min, max, hypot } = Math;

    const GB = C.GAMMA_BAR;            // Hz/T: gradients in T/m become k-space speeds in cycles/m/s
    const TWO_PI = 2 * PI;
    const REF_SLICE = 0.005;           // 5 mm: the slice in which an object with m = 1 reconstructs to 1.0
    const GAUSS_K = 4 * Math.LN2;      // a Gaussian of FWHM w is exp(-4 ln2 (f / w)^2)
    const YIELD_MS = 30;               // hand the event loop back this often
    const GENERAL_BUDGET = 2.5e8;      // entries x samples x coils for the direct-summation path

    // Event types on the timeline; the numbers also order events that share a time.
    const EV_SPOIL = 0, EV_RF = 1, EV_ADC = 2;

    /* Normalised sinc, sin(pi x)/(pi x), as MRI.util.sinc. Kept local
       because it runs once per phantom point per echo time, and a call
       into another script's closure is slower in some hosts (the Node test
       harness among them). Small arguments, the common case, use the
       Taylor series, accurate to 1e-7 for |x| < 0.1. */
    function sincn(x) {
        const ax = abs(x);
        if (ax < 0.1) { const q = PI * PI * x * x; return 1 - q / 6 + q * q / 120; }
        const px = PI * x;
        return sin(px) / px;
    }

    const now = function () {
        const p = root.performance;
        return p && typeof p.now === 'function' ? p.now() : Date.now();
    };

    /* ---------- Noise reference ----------
       Thermal noise enters every ADC sample of every coil as complex white
       Gaussian noise. Its standard deviation, separately for the real and
       the imaginary part, is
           sigma = NOISE_REF * noiseScale * sqrt(1 / dwell) / sqrt(averages).
       sqrt(1/dwell) is the square root of the receiver bandwidth: sampling
       faster lets in a wider slice of the noise spectrum. The
       reconstruction (section 3) makes each pixel dkx dky times a sum over
       all Nro x Npe samples, so the image noise is
           sigma_img = sigma * dkx * dky * sqrt(Nro * Npe).
       NOISE_REF is fixed by the reference scan of section 3 (128 x 128,
       FOV 240 mm, readout oversampling 2 so dkx = 1/(2 FOV) and Nro = 256,
       250 Hz/px, 5 mm slice, one uniform coil): there sigma_img must be
       0.01, an SNR of 100 for an object with m = 1. tests/test_engine.js
       checks the value by reconstructing pure noise. Every other scan gets
       its SNR from the same equation, so SNR follows voxel volume (through
       the image scaling), the square root of the sampling time and the
       square root of NEX with no special cases. */
    const NOISE_REF = (function () {
        const n = 128, fov = 0.240, os = 2, bw = 250;
        const dwell = 1 / (bw * n * os);
        const dkdk = (1 / (fov * os)) * (1 / fov);
        return 0.01 / (sqrt(1 / dwell) * dkdk * sqrt(n * os * n));
    })();

    /* ---------- Artifact settings (section 9.2) ---------- */
    const DEFAULTS = Object.freeze({
        noise: 1,
        motion: Object.freeze({ on: false, kind: 'periodic', amp: 0.004, period: 4.0, at: 0.5, axis: 'y' }),
        flow: Object.freeze({ on: false, depth: 0.6, period: 0.9, phase: 1.5 }),
        b0: Object.freeze({ susceptibility: 1, shim: 0 }),
        b1: Object.freeze({ amount: 0 }),
        gradDelay: 0,
        spike: Object.freeze({ on: false, amp: 4, at: 0.37 }),
        zipper: Object.freeze({ on: false, offsetHz: 3000, amp: 0.002 }),
        transient: false
    });

    function numOr(v, d) { v = Number(v); return isFinite(v) ? v : d; }

    /* Complete artifact settings from whatever the caller passed: missing
       fields take their defaults, nested objects are merged one level. */
    function mergeArtifacts(a) {
        a = a || {};
        const out = {};
        for (const k of Object.keys(DEFAULTS)) {
            const d = DEFAULTS[k], v = a[k];
            if (d && typeof d === 'object') out[k] = Object.assign({}, d, v && typeof v === 'object' ? v : {});
            else out[k] = v === undefined || v === null ? d : v;
        }
        out.noise = max(0, numOr(out.noise, 1));
        out.gradDelay = numOr(out.gradDelay, 0);
        return out;
    }

    /* Errors the app should show as they are. */
    function userError(msg) { const e = new Error(msg); e.userMessage = true; return e; }
    function abortError() { const e = new Error('Scan stopped.'); e.name = 'AbortError'; e.aborted = true; return e; }

    /* ============================================================
       Timeline and the coherence pathway
       ============================================================ */

    /* Every RF pulse (dummies included: they shape the magnetisation),
       every spoiler and every recorded ADC (at its centre sample), in time
       order. Dummy ADCs record nothing and are left out. */
    function buildTimeline(program) {
        const ev = [];
        const rf = program.rf || [], sp = program.spoil || [], adc = program.adc || [];
        for (let i = 0; i < rf.length; i++) ev.push({ t: rf[i].t, type: EV_RF, i });
        for (let i = 0; i < sp.length; i++) ev.push({ t: sp[i].t, type: EV_SPOIL, i });
        for (let i = 0; i < adc.length; i++) if (!adc[i].dummy) ev.push({ t: adc[i].tc, type: EV_ADC, i });
        ev.sort(function (a, b) { return (a.t - b.t) || (a.type - b.type) || (a.i - b.i); });
        return ev;
    }

    /* The amplitude of one gradient axis if it is constant over [tA, tB],
       else NaN. Trapezoids on an axis are sorted and do not overlap, so it
       is enough to find the one that holds tA (if any) and check that the
       window sits on its flat top, or, if tA falls in a gap, that the next
       trapezoid starts after tB. */
    function constantGradient(arr, tA, tB) {
        const EPS = 1e-9;
        if (!arr || !arr.length) return 0;
        let lo = 0, hi = arr.length - 1, j = -1;
        while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (arr[m].t0 <= tA + EPS) { j = m; lo = m + 1; } else hi = m - 1;
        }
        if (j >= 0) {
            const tr = arr[j];
            const flat0 = tr.t0 + tr.rise, flat1 = flat0 + tr.flat, end = flat1 + tr.fall;
            if (tA < end - EPS && tr.amp !== 0) {
                return tA >= flat0 - EPS && tB <= flat1 + EPS ? tr.amp : NaN;
            }
        }
        for (let q = j + 1; q < arr.length && arr[q].t0 < tB - EPS; q++) if (arr[q].amp !== 0) return NaN;
        return 0;
    }

    /* Follow the pathway's k-space position and dephasing clock through
       the sequence and describe every recorded readout:
         kc   nominal k at the centre sample (cycles/m)
         g    gamma-bar times the gradient during the ADC (cycles/m/s), when
              constant (then k(t) = kc + g (t - tc), a straight line)
         tau  the dephasing clock at the centre sample (s): off-resonance df
              has wound up phase -2 pi df tau there
         tRef, kRef, tauRef   the pathway state at its last RF event, from
              which k and tau anywhere in the readout follow.
       An excitation puts the pathway at k = 0 and tau = 0. A refocusing
       pulse turns phase phi into -phi for every spin, so it negates both:
       that is what makes a spin echo at the time tau returns to zero. */
    function walkPathway(program, ev) {
        const area = MRI.dsl.gradientArea;
        const reads = [];
        let tRef = 0, kx = 0, ky = 0, tau0 = 0, tExc = NaN;
        for (let q = 0; q < ev.length; q++) {
            const e = ev[q];
            if (e.type === EV_RF) {
                const r = program.rf[e.i];
                if (r.role === 'excite') { tRef = r.t; kx = 0; ky = 0; tau0 = 0; tExc = r.t; }
                else if (r.role === 'refocus') {
                    kx = -(kx + GB * area(program, 'x', tRef, r.t));
                    ky = -(ky + GB * area(program, 'y', tRef, r.t));
                    tau0 = -(tau0 + (r.t - tRef));
                    tRef = r.t;
                }
            } else if (e.type === EV_ADC) {
                const a = program.adc[e.i];
                const h = floor(a.n / 2), tc = a.t0 + h * a.dwell, tEnd = a.t0 + (a.n - 1) * a.dwell;
                const Gx = constantGradient(program.grad.x, a.t0, tEnd);
                const Gy = constantGradient(program.grad.y, a.t0, tEnd);
                reads.push({
                    adcIndex: e.i, adc: a, t0: a.t0, tc: tc, n: a.n, dwell: a.dwell, period: a.period,
                    tExc: tExc, tRef: tRef, kRefX: kx, kRefY: ky, tauRef: tau0,
                    kcx: kx + GB * area(program, 'x', tRef, tc),
                    kcy: ky + GB * area(program, 'y', tRef, tc),
                    tau: tau0 + (tc - tRef),
                    gx: GB * Gx, gy: GB * Gy,
                    constant: Gx === Gx && Gy === Gy            // false when either is NaN
                });
            }
        }
        return reads;
    }

    /* The readout nearest k = 0: it sets the image contrast (the truth
       image and the effective TE use it). Ties, as in radial imaging where
       every spoke crosses the centre, go to the one nearest the middle of
       the acquisition, which is safely in the steady state. */
    function centreReadout(reads) {
        let best = Infinity;
        for (const r of reads) best = min(best, r.kcx * r.kcx + r.kcy * r.kcy);
        const tol = best * 1e-6 + 1e-12;
        let pick = 0, dist = Infinity;
        const mid = (reads.length - 1) / 2;
        for (let i = 0; i < reads.length; i++) {
            const r = reads[i];
            if (r.kcx * r.kcx + r.kcy * r.kcy > best + tol) continue;
            if (abs(i - mid) < dist) { dist = abs(i - mid); pick = i; }
        }
        return pick;
    }

    /* ============================================================
       Spin classes and the magnetisation tracker
       ============================================================ */

    /* Relaxation constants per tissue for the tracker. T2' is the extra
       dephasing that makes T2* shorter than T2 (1/T2* = 1/T2 + 1/T2'):
       field variation inside a voxel on a scale the raster does not
       resolve. It decays with |tau|, so a spin echo (tau = 0) undoes it. */
    function tissueRates(tissues) {
        const nT = tissues.length;
        const R1 = new Float64Array(nT), R2 = new Float64Array(nT), R2p = new Float64Array(nT), pd = new Float64Array(nT);
        const pulsatile = new Uint8Array(nT);
        for (let k = 0; k < nT; k++) {
            const t = tissues[k];
            R1[k] = t.t1 > 0 ? 1 / t.t1 : 0;
            R2[k] = t.t2 > 0 ? 1 / t.t2 : 0;
            const t2s = t.t2s > 0 ? min(t.t2s, t.t2) : t.t2;
            R2p[k] = t2s > 0 ? max(0, 1 / t2s - R2[k]) : 0;
            pd[k] = t.pd > 0 ? t.pd : 0;
            pulsatile[k] = t.pulsatile ? 1 : 0;
        }
        return { R1, R2, R2p, pd, pulsatile };
    }

    /* Group the phantom's points into classes (tissue, B1 bin, df bin).
       B1: 9 equal bins over the range the object sees (1 when uniform).
       df: 16 bins of each tissue's own range of total off-resonance, but
       only when a spectrally selective pulse makes the magnetisation
       history depend on frequency; otherwise 1. Every class carries the
       mean B1 and df of its members. The exact df of every point is kept
       as well, because the signal phase uses it point by point.
       Points are listed in raster order (row by row), so rowStart[iy] ..
       rowStart[iy + 1] are the points of row iy. */
    function buildModel(phantom, b0Map, b1Map, spectral) {
        const n = phantom.n, NN = n * n, label = phantom.label, tissues = phantom.tissues;
        const nT = tissues.length;
        const csHz = tissues.map(function (t) { return (t.cs || 0) * C.PPM_HZ; });
        const use = tissues.map(function (t, i) { return i > 0 && t.pd > 0; });
        let P = 0, b1lo = Infinity, b1hi = -Infinity;
        const dlo = new Float64Array(nT).fill(Infinity), dhi = new Float64Array(nT).fill(-Infinity);
        for (let i = 0; i < NN; i++) {
            const L = label[i];
            if (!use[L]) continue;
            P++;
            const b = b1Map ? b1Map[i] : 1;
            if (b < b1lo) b1lo = b;
            if (b > b1hi) b1hi = b;
            const d = (b0Map ? b0Map[i] : 0) + csHz[L];
            if (d < dlo[L]) dlo[L] = d;
            if (d > dhi[L]) dhi[L] = d;
        }
        const nb1 = b1hi - b1lo > 1e-6 ? 9 : 1;
        const NDF = spectral ? 16 : 1;
        const nKeys = nT * nb1 * NDF;
        const keyOf = new Int32Array(P), count = new Int32Array(nKeys);
        const pix = new Int32Array(P), pxi = new Int32Array(P), pyi = new Int32Array(P), pdf = new Float64Array(P);
        const rowStart = new Int32Array(n + 1);
        let p = 0;
        for (let iy = 0; iy < n; iy++) {
            rowStart[iy] = p;
            for (let ix = 0; ix < n; ix++) {
                const i = iy * n + ix, L = label[i];
                if (!use[L]) continue;
                const b = b1Map ? b1Map[i] : 1;
                const d = (b0Map ? b0Map[i] : 0) + csHz[L];
                const ib = nb1 === 1 ? 0 : min(nb1 - 1, floor((b - b1lo) / (b1hi - b1lo) * nb1));
                const span = dhi[L] - dlo[L];
                const id = NDF === 1 || !(span > 1e-6) ? 0 : min(NDF - 1, floor((d - dlo[L]) / span * NDF));
                const key = (L * nb1 + ib) * NDF + id;
                keyOf[p] = key; count[key]++;
                pix[p] = i; pxi[p] = ix; pyi[p] = iy; pdf[p] = d;
                p++;
            }
        }
        rowStart[n] = p;
        // Compact class numbers in key order, which is tissue-major, so the
        // classes of one tissue are contiguous.
        const compact = new Int32Array(nKeys).fill(-1);
        let nCls = 0;
        for (let k = 0; k < nKeys; k++) if (count[k]) compact[k] = nCls++;
        const clsTissue = new Int32Array(nCls), clsB1 = new Float64Array(nCls), clsDf = new Float64Array(nCls), clsCount = new Int32Array(nCls);
        const pcls = new Int32Array(P);
        for (let q = 0; q < P; q++) {
            const c = compact[keyOf[q]];
            pcls[q] = c;
            clsTissue[c] = floor(keyOf[q] / (nb1 * NDF));
            clsB1[c] += b1Map ? b1Map[pix[q]] : 1;
            clsDf[c] += pdf[q];
            clsCount[c]++;
        }
        for (let c = 0; c < nCls; c++) { clsB1[c] /= clsCount[c]; clsDf[c] /= clsCount[c]; }
        const cStart = new Int32Array(nT), cEnd = new Int32Array(nT);
        for (let c = nCls - 1; c >= 0; c--) cStart[clsTissue[c]] = c;
        for (let c = 0; c < nCls; c++) cEnd[clsTissue[c]] = c + 1;
        const rates = tissueRates(tissues);
        return Object.assign({
            n: n, dx: phantom.dx, P: P, pix: pix, pxi: pxi, pyi: pyi, pdf: pdf, pcls: pcls, rowStart: rowStart,
            nT: nT, nCls: nCls, clsTissue: clsTissue, clsB1: clsB1, clsDf: clsDf, clsCount: clsCount,
            cStart: cStart, cEnd: cEnd, nb1: nb1, ndf: NDF
        }, rates);
    }

    /* The magnetisation tracker (section 9.1, item 2). Walks the timeline
       once. Between events every class relaxes:
           Mz <- 1 - (1 - Mz) exp(-dt/T1),   Mxy <- Mxy exp(-dt/T2).
       At an RF pulse the flip angle is scaled by the class's B1 (except for
       an adiabatic pulse, whose flip does not depend on B1) and, for a
       water or fat pulse, by its Gaussian spectral profile evaluated at
       the class's off-resonance. Then
           excite:            Mxy = Mz sin(a), Mz = Mz cos(a)
           refocus:           Mxy *= sin^2(a/2), Mz = Mz cos(a)
           invert, saturate:  Mz = Mz cos(a)
       and a spoiler sets Mxy = 0. At each recorded ADC the class amplitude
           a = pd * Mxy * exp(-|tau| / T2')
       is stored, a signed real number. Returns Float64Array(nReads * nCls).
       `sampling` (tissueEvolution only) asks for Mz and Mxy at extra times
       and around RF pulses. */
    function track(program, ev, model, reads, sampling) {
        const nCls = model.nCls, nT = model.nT;
        const R1 = model.R1, R2 = model.R2, R2p = model.R2p, pd = model.pd;
        const cStart = model.cStart, cEnd = model.cEnd, clsB1 = model.clsB1, clsDf = model.clsDf;
        const mz = new Float64Array(nCls).fill(1), mxy = new Float64Array(nCls);
        const amps = new Float64Array(reads.length * nCls);
        let tPrev = 0, ri = 0;

        function relaxTo(t) {
            const dt = t - tPrev;
            if (!(dt > 0)) return;
            for (let k = 0; k < nT; k++) {
                const c0 = cStart[k], c1 = cEnd[k];
                if (c1 <= c0) continue;
                const E1 = exp(-dt * R1[k]), E2 = exp(-dt * R2[k]);
                for (let c = c0; c < c1; c++) { mz[c] = 1 - (1 - mz[c]) * E1; mxy[c] *= E2; }
            }
            tPrev = t;
        }

        function applyRF(r) {
            const alpha = r.flip * PI / 180;
            const useB1 = r.shape !== 'sech';
            const spectral = r.select === 'water' || r.select === 'fat';
            const fRF = r.offsetHz || 0;
            const bw = r.bw > 0 ? r.bw : 1.6 / r.dur;
            const kq = GAUSS_K / (bw * bw);
            const role = r.role === 'excite' ? 0 : (r.role === 'refocus' ? 1 : 2);
            for (let c = 0; c < nCls; c++) {
                let a = alpha;
                if (useB1) a *= clsB1[c];
                if (spectral) { const d = clsDf[c] - fRF; a *= exp(-kq * d * d); }
                const ca = cos(a);
                if (role === 0) { mxy[c] = mz[c] * sin(a); mz[c] *= ca; }
                else if (role === 1) { const s = sin(a / 2); mxy[c] *= s * s; mz[c] *= ca; }
                else mz[c] *= ca;
            }
        }

        const st = sampling ? sampling.times : null;
        let si = 0;
        for (let q = 0; q < ev.length; q++) {
            const e = ev[q];
            if (st) while (si < st.length && st[si] <= e.t) { relaxTo(st[si]); sampling.record(st[si], mz, mxy); si++; }
            relaxTo(e.t);
            if (e.type === EV_RF) {
                const r = program.rf[e.i];
                const rec = sampling && sampling.inWindow(r.t);
                if (rec) sampling.record(r.t, mz, mxy);
                applyRF(r);
                if (rec) sampling.record(r.t, mz, mxy);
            } else if (e.type === EV_SPOIL) {
                const rec = sampling && sampling.inWindow(e.t);
                if (rec) sampling.record(e.t, mz, mxy);
                mxy.fill(0);
                if (rec) sampling.record(e.t, mz, mxy);
            } else {
                const tau = abs(reads[ri].tau), o = ri * nCls;
                for (let k = 0; k < nT; k++) {
                    const f = pd[k] * exp(-tau * R2p[k]);
                    for (let c = cStart[k]; c < cEnd[k]; c++) amps[o + c] = f * mxy[c];
                }
                ri++;
            }
        }
        if (st) while (si < st.length) { relaxTo(st[si]); sampling.record(st[si], mz, mxy); si++; }
        return amps;
    }

    /* ============================================================
       Signal synthesis: the fast path
       ============================================================

       During a readout with a constant gradient the pathway moves on a
       straight line, k(t) = kc + g (t - tc). Writing t_j - tc = (j - h) dwell
       for sample j (h = floor(n/2)), the phase of point r is
           k(t_j).r + df tau(t_j) = kc.r + df tauc + (j - h) dwell (g.r + df).
       So each point contributes
           c(r) exp(-i 2 pi nu(r) (j - h) dwell),    nu(r) = g.r + df(r),
       with c(r) = a C(r) exp(-i 2 pi kc.r) exp(-i 2 pi df tauc) dA (dz/5 mm).
       nu is simply the frequency at which the point precesses while the
       readout gradient is on: position along the gradient, plus its own
       off-resonance. That is the whole story of the chemical-shift and
       B0 displacement along the readout.
       The sum over points of c exp(-i 2 pi nu t) is a 1D Fourier
       transform. Spread ("splat") every c onto a grid of M frequency
       bins of width dnu = 1/(M dwell) with linear interpolation, wrapping
       modulo M (exact, because the samples cannot tell nu from
       nu + 1/dwell: that is readout aliasing), FFT, read off the n
       samples, and divide by the transform of the interpolation kernel,
       sinc^2((j - h)/M). In position units the bin width is
       1/(M dk) <= dx/2, half a phantom pixel. */

    function chooseM(n, dwell, gmag, dx) {
        let need = 4 * n;
        if (gmag > 0) need = max(need, 2 / (dwell * gmag * dx));
        need = min(need, 1 << 16);
        return max(64, U.nextPow2(ceil(need)));
    }

    /* A tiny least-recently-used cache; onEvict receives what falls out. */
    function lru(capacity, onEvict) {
        const m = new Map();
        return {
            get: function (k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
            set: function (k, v) {
                m.set(k, v);
                while (m.size > capacity) {
                    const k0 = m.keys().next().value, v0 = m.get(k0);
                    m.delete(k0);
                    if (onEvict) onEvict(v0);
                }
                return v;
            }
        };
    }

    /* Per-scan synthesis state: the model, the coil sensitivities gathered
       point by point (so the innermost loop reads them contiguously),
       raster coordinates and the caches. */
    function makeSynth(program, model, coilMaps, nC, delay, gz, thickness) {
        const n = model.n, P = model.P, h = floor(n / 2), dx = model.dx;
        const xs = new Float64Array(n);
        for (let i = 0; i < n; i++) xs[i] = (i - h) * dx;
        const pcr = new Float32Array(P * nC), pci = new Float32Array(P * nC), pool = [];
        for (let k = 0; k < nC; k++) {
            const R = coilMaps.re[k], I = coilMaps.im[k];
            for (let p = 0; p < P; p++) { const i = model.pix[p]; pcr[p * nC + k] = R[i]; pci[p * nC + k] = I[i]; }
        }
        return {
            program: program, model: model, nC: nC, n: n, dx: dx, xs: xs, pcr: pcr, pci: pci, delay: delay,
            gz: gz, thickness: thickness,
            exr: new Float64Array(n), exi: new Float64Array(n), eyr: new Float64Array(n), eyi: new Float64Array(n),
            splatCache: lru(4), tauCache: lru(4, function (v) { pool.push(v); }), stepCache: lru(2), lastPhase: null, phasorPool: pool,
            dapCache: new Map(), bufCache: new Map(),
            general: null
        };
    }

    // Bins and weights of every point for frequency nu = gx x + gy y + df.
    function splatPositions(S, gx, gy, dwell, M) {
        const key = M + '|' + dwell + '|' + gx + '|' + gy;
        let pos = S.splatCache.get(key);
        if (pos) return pos;
        const m = S.model, P = m.P, xs = S.xs, pxi = m.pxi, pyi = m.pyi, pdf = m.pdf, mask = M - 1;
        const bin = new Int32Array(P), frac = new Float32Array(P), sc = M * dwell;
        for (let p = 0; p < P; p++) {
            const q = (gx * xs[pxi[p]] + gy * xs[pyi[p]] + pdf[p]) * sc;
            const b = floor(q);
            bin[p] = b & mask;           // two's complement: also right for negative b
            frac[p] = q - b;
        }
        pos = { bin: bin, frac: frac };
        return S.splatCache.set(key, pos);
    }

    /* exp(-i 2 pi df(r) tau) for every point, times the through-plane
       dephasing sinc(Gz dz tau) (see throughPlaneGradient); null when
       tau = 0, the centre of a spin echo, where both are 1. tau is taken
       on the compiler's 1 us timing raster: echo centres sit on it only to
       within a fraction of a dwell, and the phase that leftover makes
       (under 0.002 rad at 500 Hz) is not worth a pass over every point
       for each echo of a turbo spin echo train.
       In EPI every line has its own tau, one echo spacing later than the
       last, so the pure phase factor is carried forward by one complex
       multiplication with exp(-i 2 pi df ESP) instead of a cosine and a
       sine per point. */
    function tauPhasor(S, tau) {
        tau = round(tau * 1e6) / 1e6;
        if (tau === 0) return null;
        const key = round(tau * 1e6);
        let ph = S.tauCache.get(key);
        if (ph) return ph;
        const m = S.model, P = m.P, pdf = m.pdf;
        // the pure phase exp(-i 2 pi df tau), from the previous one when possible
        const last = S.lastPhase;
        let eR, eI;
        if (last && last.tau !== key) {
            const dkey = key - last.tau;
            let st = S.stepCache.get(dkey);
            if (!st) {
                const dt = dkey * 1e-6, sR = new Float64Array(P), sI = new Float64Array(P);
                for (let p = 0; p < P; p++) { const a = -TWO_PI * pdf[p] * dt; sR[p] = cos(a); sI[p] = sin(a); }
                st = S.stepCache.set(dkey, { re: sR, im: sI });
            }
            eR = last.re; eI = last.im;
            const sR = st.re, sI = st.im;
            for (let p = 0; p < P; p++) { const r = eR[p], i = eI[p]; eR[p] = r * sR[p] - i * sI[p]; eI[p] = r * sI[p] + i * sR[p]; }
        } else {
            eR = last ? last.re : new Float64Array(P); eI = last ? last.im : new Float64Array(P);
            for (let p = 0; p < P; p++) { const a = -TWO_PI * pdf[p] * tau; eR[p] = cos(a); eI[p] = sin(a); }
        }
        S.lastPhase = { tau: key, re: eR, im: eI };
        // times the through-plane factor, into a recycled buffer
        const buf = S.phasorPool.pop() || { re: new Float64Array(P), im: new Float64Array(P) };
        const re = buf.re, im = buf.im, gz = S.gz, wt = S.thickness * tau;
        if (gz) {
            for (let p = 0; p < P; p++) { const w = sincn(gz[p] * wt); re[p] = w * eR[p]; im[p] = w * eI[p]; }
        } else { re.set(eR); im.set(eI); }
        ph = { re: re, im: im };
        return S.tauCache.set(key, ph);
    }

    /* Through-plane dephasing. A slice is dz thick, and a susceptibility
       field changes through it as well as within it. Spins at different
       depths in the slice then precess at different rates, and in a
       gradient echo their signals cancel: the familiar dropout above the
       sinuses, which grows with TE and with slice thickness and which a
       spin echo refocuses. For a uniform slice profile and a field that
       varies linearly through it by Gz (Hz per metre), the signal is
       multiplied by sinc(Gz dz tau). The phantoms are 2D and do not say how
       the field varies along z, so Gz is taken as the size of the in-plane
       gradient of the B0 map at each point: near a small air space the
       field falls off at much the same rate in every direction. The
       gradient uses only neighbours inside the object (the map is 0 in
       air, which is not a field). Chemical shift is uniform within a
       tissue and is not part of it. */
    function throughPlaneGradient(phantom, b0Map, model) {
        const n = phantom.n, label = phantom.label, dx = phantom.dx, P = model.P;
        const out = new Float64Array(P);
        let any = false;
        for (let p = 0; p < P; p++) {
            const ix = model.pxi[p], iy = model.pyi[p], i = model.pix[p], f0 = b0Map[i];
            const l = ix > 0 && label[i - 1], r = ix < n - 1 && label[i + 1];
            const u = iy > 0 && label[i - n], d = iy < n - 1 && label[i + n];
            const gx = l && r ? (b0Map[i + 1] - b0Map[i - 1]) / (2 * dx) : (r ? (b0Map[i + 1] - f0) / dx : (l ? (f0 - b0Map[i - 1]) / dx : 0));
            const gy = u && d ? (b0Map[i + n] - b0Map[i - n]) / (2 * dx) : (d ? (b0Map[i + n] - f0) / dx : (u ? (f0 - b0Map[i - n]) / dx : 0));
            const g = sqrt(gx * gx + gy * gy);
            out[p] = g;
            if (g > 0) any = true;
        }
        return any ? out : null;
    }

    // 1 / sinc^2((j - h)/M): undoes the linear-interpolation kernel.
    function deapodisation(S, n, M) {
        const key = n + '|' + M;
        let d = S.dapCache.get(key);
        if (d) return d;
        d = new Float64Array(n);
        const h = floor(n / 2);
        for (let j = 0; j < n; j++) { const s = sincn((j - h) / M); d[j] = 1 / (s * s); }
        S.dapCache.set(key, d);
        return d;
    }

    function buffers(S, M) {
        let b = S.bufCache.get(M);
        if (!b) { b = { gr: new Float64Array(M * S.nC), gi: new Float64Array(M * S.nC) }; S.bufCache.set(M, b); }
        return b;
    }

    /* One readout by the fast path. Ar, Ai: complex class amplitudes with
       dA (dz/5 mm) folded in. kcx, kcy, gx, gy: the TRUE centre k and k-speed
       in the object's own frame (after the gradient delay and any head
       rotation). Writes the n samples of every coil into outRe/outIm. */
    function synthFast(S, n, dwell, tau, kcx, kcy, gx, gy, Ar, Ai, outRe, outIm) {
        const m = S.model, nC = S.nC, nr = S.n, xs = S.xs;
        const M = chooseM(n, dwell, hypot(gx, gy), S.dx), mask = M - 1;
        const pos = splatPositions(S, gx, gy, dwell, M);
        const tph = tauPhasor(S, tau);
        const exr = S.exr, exi = S.exi, eyr = S.eyr, eyi = S.eyi;
        // exp(-i 2 pi kc.r) is a product of a row factor and a column factor.
        for (let i = 0; i < nr; i++) {
            const ax = -TWO_PI * kcx * xs[i], ay = -TWO_PI * kcy * xs[i];
            exr[i] = cos(ax); exi[i] = sin(ax); eyr[i] = cos(ay); eyi[i] = sin(ay);
        }
        const buf = buffers(S, M), gr = buf.gr, gi = buf.gi;
        gr.fill(0); gi.fill(0);
        const pxi = m.pxi, pcls = m.pcls, rs = m.rowStart, bin = pos.bin, frac = pos.frac;
        const pcr = S.pcr, pci = S.pci;
        const tr = tph ? tph.re : null, ti = tph ? tph.im : null;
        for (let iy = 0; iy < nr; iy++) {
            const p0 = rs[iy], p1 = rs[iy + 1];
            if (p0 === p1) continue;
            const yr = eyr[iy], yi = eyi[iy];
            for (let p = p0; p < p1; p++) {
                const ix = pxi[p], c = pcls[p];
                const xr = exr[ix], xi = exi[ix];
                let vr = xr * yr - xi * yi, vi = xr * yi + xi * yr;
                if (tr !== null) { const a = tr[p], b = ti[p], t = vr * a - vi * b; vi = vr * b + vi * a; vr = t; }
                const ar = Ar[c], ai = Ai[c];
                const ur = vr * ar - vi * ai, ui = vr * ai + vi * ar;
                const b0 = bin[p], b1 = (b0 + 1) & mask, f1 = frac[p], f0 = 1 - f1;
                for (let k = 0, o = p * nC, base = 0; k < nC; k++, o++, base += M) {
                    const cr = pcr[o], ci = pci[o];
                    const sr = ur * cr - ui * ci, si = ur * ci + ui * cr;
                    gr[base + b0] += f0 * sr; gi[base + b0] += f0 * si;
                    gr[base + b1] += f1 * sr; gi[base + b1] += f1 * si;
                }
            }
        }
        const dap = deapodisation(S, n, M), h = floor(n / 2);
        for (let k = 0; k < nC; k++) {
            const R = gr.subarray(k * M, (k + 1) * M), I = gi.subarray(k * M, (k + 1) * M);
            U.fft(R, I, false);
            const oR = outRe[k], oI = outIm[k];
            for (let j = 0; j < n; j++) { const q = (j - h) & mask; oR[j] = R[q] * dap[j]; oI[j] = I[q] * dap[j]; }
        }
        return M;
    }

    /* ============================================================
       Signal synthesis: the general path
       ============================================================

       For readouts whose gradients change during the ADC (sampling on a
       ramp, a curved trajectory) the straight-line trick does not apply,
       so the sum over points is evaluated directly for every sample. To
       keep that affordable the raster is reduced to cells of f x f points
       (at most 128 x 128 cells, coarser still for very long
       acquisitions).
       Inside a cell the points of one class are lumped into a few
       rectangles: each rectangle carries the summed coil sensitivity and
       the mean off-resonance of its points, sits at its true centre (on a
       half-pixel grid) and keeps its true extent through the factor
           D_L(k) = sin(pi k L dx) / (L sin(pi k dx)),
       which is exactly the average of exp(-i 2 pi k s) over L points spaced
       dx apart. So the sum is exact for anything uniform within a class
       (which the magnetisation of a class is); only the slow variation of
       coil sensitivity and B0 inside one cell is averaged.
       exp(-i 2 pi k.r) still factors into a row and a column term, each
       built by a complex recurrence along the half-pixel grid, and the
       off-resonance phase advances by a fixed step per sample, so the
       inner loop has no trigonometry. */
    function prepareGeneral(S, f) {
        const m = S.model, P = m.P, nC = S.nC, nCls = m.nCls, n = m.n;
        const nc = ceil(n / f);
        // Group the points by (cell, class), with a bit mask of occupied sub-points per sub-row.
        const groups = new Map();
        for (let p = 0; p < P; p++) {
            const ix = m.pxi[p], iy = m.pyi[p], cx = floor(ix / f), cy = floor(iy / f);
            const key = (cy * nc + cx) * nCls + m.pcls[p];
            let g = groups.get(key);
            if (!g) { g = { cx: cx, cy: cy, cls: m.pcls[p], rows: new Int32Array(f), pts: [] }; groups.set(key, g); }
            g.rows[iy - cy * f] |= 1 << (ix - cx * f);
            g.pts.push(p);
        }
        const ux = [], uy = [], lx = [], ly = [], ecls = [], dfSum = [], gzSum = [], cnt = [];
        const entryOf = new Int32Array(P);
        const rectOf = new Int32Array(f * f);
        groups.forEach(function (g) {
            // Runs of occupied sub-points in each sub-row, merged downwards
            // with identical runs of the row above into rectangles.
            let open = [];
            const rects = [];
            for (let sy = 0; sy < f; sy++) {
                const runs = [];
                for (let sx = 0; sx < f; sx++) {
                    if (!(g.rows[sy] & (1 << sx))) continue;
                    let s1 = sx;
                    while (s1 + 1 < f && (g.rows[sy] & (1 << (s1 + 1)))) s1++;
                    runs.push([sx, s1]);
                    sx = s1;
                }
                const next = [];
                for (const r of runs) {
                    let rect = null;
                    for (const o of open) if (o.s0 === r[0] && o.s1 === r[1]) { rect = o; break; }
                    if (rect) rect.r1 = sy;
                    else { rect = { s0: r[0], s1: r[1], r0: sy, r1: sy }; rects.push(rect); }
                    next.push(rect);
                    for (let sx = r[0]; sx <= r[1]; sx++) rectOf[sy * f + sx] = rects.indexOf(rect);
                }
                open = next;
            }
            const base = ux.length;
            for (const r of rects) {
                ux.push(2 * f * g.cx + r.s0 + r.s1); uy.push(2 * f * g.cy + r.r0 + r.r1);
                lx.push(r.s1 - r.s0 + 1); ly.push(r.r1 - r.r0 + 1);
                ecls.push(g.cls); dfSum.push(0); gzSum.push(0); cnt.push(0);
            }
            for (const p of g.pts) {
                const e = base + rectOf[(m.pyi[p] - g.cy * f) * f + (m.pxi[p] - g.cx * f)];
                entryOf[p] = e; dfSum[e] += m.pdf[p]; gzSum[e] += S.gz ? S.gz[p] : 0; cnt[e]++;
            }
        });
        const E = ux.length;
        const qr = new Float64Array(E * nC), qi = new Float64Array(E * nC);
        for (let p = 0; p < P; p++) {
            const o = entryOf[p] * nC, s = p * nC;
            for (let k = 0; k < nC; k++) { qr[o + k] += S.pcr[s + k]; qi[o + k] += S.pci[s + k]; }
        }
        const nh = 2 * n - 1;                 // half-pixel grid: index u at x = (u/2 - floor(n/2)) dx
        return {
            f: f, nc: nc, E: E, nh: nh,
            ux: Int32Array.from(ux), uy: Int32Array.from(uy), lx: Int32Array.from(lx), ly: Int32Array.from(ly),
            cls: Int32Array.from(ecls), df: Float64Array.from(dfSum.map(function (s, i) { return s / cnt[i]; })),
            gz: Float64Array.from(gzSum.map(function (s, i) { return s / cnt[i]; })),
            qr: qr, qi: qi,
            pr: new Float64Array(E), pi: new Float64Array(E), sr: new Float64Array(E), si: new Float64Array(E),
            exr: new Float64Array(nh), exi: new Float64Array(nh), eyr: new Float64Array(nh), eyi: new Float64Array(nh),
            dx: new Float64Array(f + 1), dy: new Float64Array(f + 1),
            accR: new Float64Array(nC), accI: new Float64Array(nC)
        };
    }

    // exp(-i 2 pi k (u/2 - h) dx) for u = 0 .. nh-1, by recurrence.
    function halfGridPhasor(k, h, dx, outR, outI) {
        const a0 = TWO_PI * k * h * dx, as = -PI * k * dx;
        let r = cos(a0), i = sin(a0);
        const sr = cos(as), si = sin(as);
        for (let u = 0; u < outR.length; u++) {
            outR[u] = r; outI[u] = i;
            const t = r * sr - i * si; i = r * si + i * sr; r = t;
        }
    }

    // D_L(k) for L = 1 .. f: the average phase factor of a run of L points.
    function runFactors(k, f, dx, out) {
        const d = sin(PI * k * dx);
        for (let L = 1; L <= f; L++) out[L] = abs(d) < 1e-12 ? 1 : sin(PI * k * L * dx) / (L * d);
    }

    /* One readout by direct summation. Writes the nominal k of every
       sample into kxOut/kyOut and the samples into outRe/outIm. mot is the
       head's rotation (c, s) and translation (dx, dy) at this readout, or
       null. */
    function synthGeneral(S, rd, Ar, Ai, mot, outRe, outIm, kxOut, kyOut) {
        const G = S.general, prog = S.program, area = MRI.dsl.gradientArea, gAt = MRI.dsl.gradientAt;
        const n = rd.n, h = floor(n / 2), dwell = rd.dwell, nC = S.nC, E = G.E, f = G.f, dx = S.dx, hr = floor(S.n / 2);
        const ux = G.ux, uy = G.uy, lx = G.lx, ly = G.ly, ecls = G.cls, edf = G.df, qr = G.qr, qi = G.qi;
        const pr = G.pr, pi = G.pi, sr = G.sr, si = G.si, Dx = G.dx, Dy = G.dy;
        const exr = G.exr, exi = G.exi, eyr = G.eyr, eyi = G.eyi, accR = G.accR, accI = G.accI;
        // Each entry starts at the tau of the first sample, with its class
        // amplitude and the through-plane dephasing at the echo folded in.
        const tau0 = rd.tau - h * dwell, egz = G.gz, wt = S.thickness * rd.tau;
        for (let e = 0; e < E; e++) {
            const a0 = -TWO_PI * edf[e] * tau0, c = ecls[e], w = S.gz ? sincn(egz[e] * wt) : 1;
            const cr = w * cos(a0), ci = w * sin(a0), ar = Ar[c], ai = Ai[c];
            pr[e] = cr * ar - ci * ai; pi[e] = cr * ai + ci * ar;
            const as = -TWO_PI * edf[e] * dwell;
            sr[e] = cos(as); si[e] = sin(as);
        }
        const delay = S.delay;
        for (let j = 0; j < n; j++) {
            const t = rd.t0 + j * dwell;
            let kx = rd.kRefX + GB * area(prog, 'x', rd.tRef, t);
            let ky = rd.kRefY + GB * area(prog, 'y', rd.tRef, t);
            kxOut[j] = kx; kyOut[j] = ky;
            if (delay) { kx -= GB * gAt(prog, 'x', t) * delay; ky -= GB * gAt(prog, 'y', t) * delay; }
            const kxl = kx, kyl = ky;                       // true k in the scanner frame
            if (mot && mot.rot) { const c = mot.c, s = mot.s; kx = c * kxl + s * kyl; ky = -s * kxl + c * kyl; }
            halfGridPhasor(kx, hr, dx, exr, exi);
            halfGridPhasor(ky, hr, dx, eyr, eyi);
            runFactors(kx, f, dx, Dx);
            runFactors(ky, f, dx, Dy);
            accR.fill(0); accI.fill(0);
            for (let e = 0; e < E; e++) {
                const a = ux[e], b = uy[e], d = Dx[lx[e]] * Dy[ly[e]];
                const xr = exr[a], xi = exi[a], yr = eyr[b], yi = eyi[b];
                const vr = (xr * yr - xi * yi) * d, vi = (xr * yi + xi * yr) * d;
                const ar = pr[e], ai = pi[e];
                const ur = vr * ar - vi * ai, ui = vr * ai + vi * ar;
                for (let k = 0, o = e * nC; k < nC; k++, o++) {
                    accR[k] += ur * qr[o] - ui * qi[o];
                    accI[k] += ur * qi[o] + ui * qr[o];
                }
                const t2 = ar * sr[e] - ai * si[e];
                pi[e] = ar * si[e] + ai * sr[e]; pr[e] = t2;
            }
            let wr = 1, wi = 0;
            if (mot && (mot.dx || mot.dy)) {
                const a = -TWO_PI * (kxl * mot.dx + kyl * mot.dy);
                wr = cos(a); wi = sin(a);
            }
            for (let k = 0; k < nC; k++) {
                outRe[k][j] = accR[k] * wr - accI[k] * wi;
                outIm[k][j] = accR[k] * wi + accI[k] * wr;
            }
        }
    }

    /* ============================================================
       Motion and flow
       ============================================================ */

    /* Rigid head position at absolute time t (section 9.2). Translations
       are in metres along `axis`, the nod is a rotation in radians about
       the centre of the FOV. tA..tB is the span of the acquisition, used by
       'sudden'; u is a uniform random number for 'random'. Returns null
       when the head is where it started. */
    function motionAt(mo, t, tA, tB, u) {
        const amp = numOr(mo.amp, 0), period = numOr(mo.period, 4) || 4;
        let d = 0, th = 0;
        switch (mo.kind) {
            case 'sudden': d = t >= tA + U.clamp(numOr(mo.at, 0.5), 0, 1) * (tB - tA) ? amp : 0; break;
            case 'random': d = amp * (2 * u - 1); break;
            case 'nod': th = amp * sin(TWO_PI * t / period); break;
            default: d = amp * sin(TWO_PI * t / period);
        }
        if (!d && !th) return null;
        const alongX = mo.axis === 'x';
        return { dx: alongX ? d : 0, dy: alongX ? 0 : d, rot: th !== 0, c: cos(th), s: sin(th), theta: th };
    }

    /* ============================================================
       The truth image
       ============================================================ */

    /* Area-weighted overlap of output pixels with raster pixels along one
       axis, both following the centred convention of section 3. */
    function overlapWeights(nOut, D, n, dx) {
        const H = floor(nOut / 2), h = floor(n / 2), lists = [];
        for (let o = 0; o < nOut; o++) {
            const a = (o - H - 0.5) * D, b = (o - H + 0.5) * D;
            const j0 = max(0, floor(a / dx + h - 0.5)), j1 = min(n - 1, ceil(b / dx + h + 0.5));
            const idx = [], w = [];
            for (let j = j0; j <= j1; j++) {
                const lo = (j - h - 0.5) * dx, hi = (j - h + 0.5) * dx;
                const ov = min(b, hi) - max(a, lo);
                if (ov > 1e-15) { idx.push(j); w.push(ov / D); }
            }
            lists.push({ idx: idx, w: w });
        }
        return lists;
    }

    /* Box-average an n x n raster (spacing dx) onto an nx x ny grid covering
       fovX x fovY; parts of the grid outside the raster count as empty. */
    function boxAverage(raster, n, dx, nx, ny, fovX, fovY) {
        const wx = overlapWeights(nx, fovX / nx, n, dx), wy = overlapWeights(ny, fovY / ny, n, dx);
        const tmp = new Float64Array(n * nx);
        for (let r = 0; r < n; r++) {
            const o = r * n;
            for (let x = 0; x < nx; x++) {
                const L = wx[x];
                let s = 0;
                for (let q = 0; q < L.idx.length; q++) s += L.w[q] * raster[o + L.idx[q]];
                tmp[r * nx + x] = s;
            }
        }
        const out = new Float32Array(nx * ny);
        for (let y = 0; y < ny; y++) {
            const L = wy[y];
            for (let x = 0; x < nx; x++) {
                let s = 0;
                for (let q = 0; q < L.idx.length; q++) s += L.w[q] * tmp[L.idx[q] * nx + x];
                out[y * nx + x] = s;
            }
        }
        return out;
    }

    /* ============================================================
       Inputs
       ============================================================ */

    function fieldInputs(phantom, ctx, art) {
        const n = phantom.n, NN = n * n, F = MRI.fields;
        let b0Map = ctx.b0Map, b1Map = ctx.b1Map, coilSet = ctx.coilSet, coilMaps = ctx.coilMaps;
        if (!b0Map || b0Map.length !== NN) b0Map = F ? F.b0Map(phantom, art.b0) : new Float32Array(NN);
        if (!b1Map || b1Map.length !== NN) {
            if (F) b1Map = F.b1Map(phantom, art.b1);
            else { b1Map = new Float32Array(NN); b1Map.fill(1); }
        }
        if (!coilSet) coilSet = F ? F.coilSet('body') : { type: 'body', n: 1, names: ['Body coil'], positions: [{ x: 0, y: 0 }], radius: 0.3 };
        if (typeof coilSet === 'string') coilSet = F.coilSet(coilSet);
        const nC = coilSet.n || 1;
        if (!coilMaps || !coilMaps.re || coilMaps.re.length !== nC || coilMaps.re[0].length !== NN) {
            if (F) coilMaps = F.coilMaps(coilSet, n, n, phantom.fov, phantom.fov);
            else {
                const r = new Float32Array(NN); r.fill(1);
                coilMaps = { re: [r], im: [new Float32Array(NN)] };
            }
        }
        return { b0Map: b0Map, b1Map: b1Map, coilSet: coilSet, coilMaps: coilMaps, nC: nC };
    }

    function checkProgram(program) {
        if (!program || !program.ok) throw userError('The sequence does not compile, so there is nothing to simulate.');
        if (!MRI.dsl || typeof MRI.dsl.gradientArea !== 'function') throw new Error('The sequence module (js/dsl.js) did not load.');
    }

    /* A sequence encodes space if some readout either moves through
       k-space or sits away from its centre. A pulse-acquire FID does
       neither: every sample is k = 0. */
    function hasEncoding(reads) {
        for (const r of reads) {
            if (!r.constant) return true;
            if (abs(r.gx) > 1e-6 || abs(r.gy) > 1e-6) return true;
            if (abs(r.kcx) > 1e-6 || abs(r.kcy) > 1e-6) return true;
        }
        return false;
    }

    /* ============================================================
       simulate
       ============================================================ */

    async function simulate(program, phantom, ctx, opts) {
        const tStart = now();
        ctx = ctx || {};
        opts = opts || {};
        checkProgram(program);
        if (!phantom || !phantom.label || !phantom.tissues) throw userError('There is no phantom to image.');
        const art = mergeArtifacts(ctx.artifacts);
        const seed = (numOr(opts.seed, 1) >>> 0) || 1;
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
        const shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : function () { return false; };
        const warnings = [];
        let lastYield = now();
        async function breathe(frac) {
            if (now() - lastYield < YIELD_MS) return;
            if (onProgress) onProgress(frac);
            await U.yieldFrame();
            lastYield = now();
            if (shouldAbort()) throw abortError();
        }
        if (shouldAbort()) throw abortError();

        const img = program.image;
        const fi = fieldInputs(phantom, ctx, art);
        const nC = fi.nC;

        // 1. The pathway and the readouts.
        const ev = buildTimeline(program);
        const reads = walkPathway(program, ev);
        if (!reads.length) throw userError('This sequence never switches the ADC on (outside the dummy scans), so it records nothing to image.');
        if (!hasEncoding(reads)) throw userError('This sequence has no spatial encoding. Use the Spectroscopy tab.');
        const nR = reads.length;

        // 2. Classes and the magnetisation history.
        const spectral = program.rf.some(function (r) { return r.select === 'water' || r.select === 'fat'; });
        const model = buildModel(phantom, fi.b0Map, fi.b1Map, spectral);
        const amps = track(program, ev, model, reads, null);
        const nCls = model.nCls;
        if (onProgress) onProgress(0.05);
        await breathe(0.05);

        // 3. Synthesis, readout by readout.
        const sliceFactor = (img.thickness > 0 ? img.thickness : REF_SLICE) / REF_SLICE;
        const scale = phantom.dx * phantom.dx * sliceFactor;
        const delay = art.gradDelay;
        const S = makeSynth(program, model, fi.coilMaps, nC, delay,
            throughPlaneGradient(phantom, fi.b0Map, model), img.thickness > 0 ? img.thickness : REF_SLICE);
        let nGeneral = 0;
        for (const r of reads) if (opts.forceGeneral || !r.constant) nGeneral++;
        if (nGeneral) {
            let totalSamples = 0;
            for (const r of reads) if (opts.forceGeneral || !r.constant) totalSamples += r.n;
            let f = max(1, ceil(model.n / 128));
            S.general = prepareGeneral(S, f);
            while (S.general.E * totalSamples * nC > GENERAL_BUDGET && model.n / (f + 1) >= 16) {
                f++;
                S.general = prepareGeneral(S, f);
            }
            warnings.push(nGeneral + ' of ' + nR + ' readouts sample while a gradient is changing (on a ramp or a curved ' +
                'trajectory), so they were computed by direct summation on a ' + S.general.nc + ' x ' + S.general.nc +
                ' raster: slower, and less exact than the FFT path.');
        }

        const mo = art.motion, fl = art.flow;
        const motionOn = !!(mo && mo.on && numOr(mo.amp, 0) !== 0);
        const flowOn = !!(fl && fl.on);
        const rngMotion = U.rng((seed * 2654435761 + 0x1b873593) >>> 0);
        const tFirst = reads[0].tc, tLast = reads[nR - 1].tc;
        const Ar = new Float64Array(nCls), Ai = new Float64Array(nCls);
        const out = [];
        let Mused = 0;

        for (let ri = 0; ri < nR; ri++) {
            const rd = reads[ri], n = rd.n, h = floor(n / 2);
            const re = [], im = [];
            for (let k = 0; k < nC; k++) { re.push(new Float32Array(n)); im.push(new Float32Array(n)); }
            const kx = new Float32Array(n), ky = new Float32Array(n);

            // Class amplitudes for this readout; pulsatile blood is modulated by the cardiac cycle.
            const o = ri * nCls;
            const fPhase = flowOn ? TWO_PI * rd.tc / (numOr(fl.period, 0.9) || 0.9) : 0;
            for (let c = 0; c < nCls; c++) {
                const a = amps[o + c] * scale;
                if (flowOn && model.pulsatile[model.clsTissue[c]]) {
                    const sp = sin(fPhase);
                    const g = 1 + numOr(fl.depth, 0) * sp, ph = numOr(fl.phase, 0) * sp;
                    Ar[c] = a * g * cos(ph); Ai[c] = a * g * sin(ph);
                } else { Ar[c] = a; Ai[c] = 0; }
            }
            const mot = motionOn ? motionAt(mo, rd.tc, tFirst, tLast, rngMotion()) : null;

            if (opts.forceGeneral || !rd.constant) {
                synthGeneral(S, rd, Ar, Ai, mot, re, im, kx, ky);
            } else {
                // True k: a gradient that lags by delay has covered g*delay less area at every sample.
                let kcx = rd.kcx - rd.gx * delay, kcy = rd.kcy - rd.gy * delay, gx = rd.gx, gy = rd.gy;
                const kcxLab = kcx, kcyLab = kcy;
                if (mot && mot.rot) {
                    // A head rotated by R is the original head seen with k turned by R^T.
                    const c = mot.c, s = mot.s;
                    kcx = c * kcxLab + s * kcyLab; kcy = -s * kcxLab + c * kcyLab;
                    const gx0 = gx; gx = c * gx0 + s * gy; gy = -s * gx0 + c * gy;
                }
                Mused = max(Mused, synthFast(S, n, rd.dwell, rd.tau, kcx, kcy, gx, gy, Ar, Ai, re, im));
                for (let j = 0; j < n; j++) { kx[j] = rd.kcx + rd.gx * (j - h) * rd.dwell; ky[j] = rd.kcy + rd.gy * (j - h) * rd.dwell; }
                if (mot && (mot.dx || mot.dy)) {
                    // A shifted object multiplies its signal by exp(-i 2 pi k.d), k the true k in the scanner frame.
                    for (let j = 0; j < n; j++) {
                        const kxl = kcxLab + rd.gx * (j - h) * rd.dwell, kyl = kcyLab + rd.gy * (j - h) * rd.dwell;
                        const a = -TWO_PI * (kxl * mot.dx + kyl * mot.dy), cr = cos(a), ci = sin(a);
                        for (let k = 0; k < nC; k++) {
                            const vr = re[k][j], vi = im[k][j];
                            re[k][j] = vr * cr - vi * ci; im[k][j] = vr * ci + vi * cr;
                        }
                    }
                }
            }
            out.push({ re: re, im: im, kx: kx, ky: ky });
            await breathe(0.05 + 0.9 * (ri + 1) / nR);
        }

        // 4. The receiver: reference level, spike, zipper and thermal noise.
        const ci = centreReadout(reads);
        const cRd = reads[ci], cOut = out[ci], ch = floor(cRd.n / 2);
        let refSq = 0;
        for (let k = 0; k < nC; k++) refSq += cOut.re[k][ch] * cOut.re[k][ch] + cOut.im[k][ch] * cOut.im[k][ch];
        const ref = sqrt(refSq / nC);           // "typical k-centre magnitude", RMS over coils

        const sp = art.spike;
        let spikeInfo = null;
        if (sp && sp.on && numOr(sp.amp, 0)) {
            const rng = U.rng((seed * 2246822519 + 0x27d4eb2f) >>> 0);
            const tS = tFirst + U.clamp(numOr(sp.at, 0.37), 0, 1) * (tLast - tFirst);
            let iS = 0;
            for (let i = 1; i < nR; i++) if (abs(reads[i].tc - tS) < abs(reads[iS].tc - tS)) iS = i;
            const jS = min(reads[iS].n - 1, floor(rng() * reads[iS].n)), ph = TWO_PI * rng();
            const A = numOr(sp.amp, 0) * ref;
            for (let k = 0; k < nC; k++) { out[iS].re[k][jS] += A * cos(ph); out[iS].im[k][jS] += A * sin(ph); }
            spikeInfo = { readout: iS, sample: jS };
        }

        /* Zipper: a continuous tone leaking into the receiver at f0 + offsetHz.
           Section 3's sign convention gives a spin precessing offsetHz above
           f0 the signal exp(-i 2 pi offsetHz t), so the tone uses the same
           sign and lands where such a spin would: offsetHz / BW pixels from the
           centre along the readout. Its phase is unrelated to the RF
           excitation, so it is random from one readout to the next, which is
           what smears it into a line along the phase-encode direction. */
        const zp = art.zipper;
        if (zp && zp.on && numOr(zp.amp, 0)) {
            const rng = U.rng((seed * 3266489917 + 0x165667b1) >>> 0);
            const A = numOr(zp.amp, 0) * ref, fz = numOr(zp.offsetHz, 0);
            for (let i = 0; i < nR; i++) {
                const rd = reads[i], phi = TWO_PI * rng();
                for (let j = 0; j < rd.n; j++) {
                    const a = -TWO_PI * fz * (rd.t0 + j * rd.dwell) + phi, zr = A * cos(a), zi = A * sin(a);
                    for (let k = 0; k < nC; k++) { out[i].re[k][j] += zr; out[i].im[k][j] += zi; }
                }
            }
        }

        /* Thermal noise, independent in every sample of every coil. Each
           complex sample takes one Box-Muller pair, m (cos a, sin a), from
           the seeded generator: exactly the pair that two calls of
           MRI.util.rng(seed).randn() would return, written out here because
           this loop runs millions of times. */
        const avg = max(1, numOr(img.averages, 1));
        if (art.noise > 0) {
            const rng = U.rng(seed);
            for (let i = 0; i < nR; i++) {
                const rd = reads[i], sigma = NOISE_REF * art.noise * sqrt(1 / rd.dwell) / sqrt(avg);
                for (let k = 0; k < nC; k++) {
                    const R = out[i].re[k], I = out[i].im[k];
                    for (let j = 0; j < rd.n; j++) {
                        let u = 0;
                        while (u <= 1e-12) u = rng();
                        const m = sigma * sqrt(-2 * log(u)), a = TWO_PI * rng();
                        R[j] += m * cos(a); I[j] += m * sin(a);
                    }
                }
            }
        }
        if (onProgress) onProgress(0.97);

        // 5. AcqData.
        const readouts = new Array(nR);
        for (let i = 0; i < nR; i++) {
            const rd = reads[i];
            readouts[i] = {
                index: i, adcIndex: rd.adcIndex, t0: rd.t0, tc: rd.tc, dwell: rd.dwell, n: rd.n, period: rd.period,
                tExc: rd.tExc, te: rd.tc - rd.tExc,
                kx: out[i].kx, ky: out[i].ky, re: out[i].re, im: out[i].im,
                vars: rd.adc.vars
            };
        }

        // Truth: the class amplitudes of the k-centre readout, on the raster, box-averaged.
        const raster = new Float64Array(model.n * model.n);
        for (let p = 0; p < model.P; p++) raster[model.pix[p]] = amps[ci * nCls + model.pcls[p]] * sliceFactor;
        const truth = { nx: img.nx, ny: img.ny, fovX: img.fovX, fovY: img.fovY,
            data: boxAverage(raster, model.n, model.dx, img.nx, img.ny, img.fovX, img.fovY) };

        const stats = acquisitionStats(program, reads, ci, img);
        stats.scanTime = program.scanTime;
        stats.nReadouts = nR;
        stats.signalScale = ref;
        stats.noiseSigma = art.noise > 0 ? NOISE_REF * art.noise * sqrt(1 / cRd.dwell) / sqrt(avg) : 0;
        stats.nClasses = nCls;
        stats.nPoints = model.P;
        stats.path = nGeneral === 0 ? 'fast' : (nGeneral === nR ? 'general' : 'mixed');
        stats.nFast = nR - nGeneral;
        stats.nGeneral = nGeneral;
        stats.fftBins = Mused || null;
        stats.generalCells = S.general ? S.general.nc : null;
        stats.centreIndex = ci;
        stats.spike = spikeInfo;
        stats.computeMs = now() - tStart;
        if (onProgress) onProgress(1);

        return {
            program: program, phantomId: phantom.id, coilSet: fi.coilSet, nCoils: nC, seed: seed,
            grid: { nx: img.nx, ny: img.ny, fovX: img.fovX, fovY: img.fovY, readoutAxis: img.readoutAxis, oversample: img.oversample },
            readouts: readouts,
            truth: truth,
            stats: stats,
            warnings: warnings
        };
    }

    /* Timing statistics that follow from the pathway.
       Chemical shift along the readout: a point at frequency df appears
       where a point at df/|g| further along the gradient would, so fat moves
       by FAT_HZ / BW pixels (BW = |g| times the pixel size).
       Along the phase-encode axis the shift is set by how the dephasing
       clock grows from one line to the next: if tau rises by s seconds per
       cycle/m of phase-encode k, a frequency df appears df * s metres away.
       In a conventional sequence every line has the same tau (s = 0, no
       shift). In EPI, s = ESP / dky, so the shift in pixels is df N ESP and
       the "bandwidth per pixel" along phase is 1 / (N ESP). */
    function acquisitionStats(program, reads, ci, img) {
        const c = reads[ci];
        const roAxis = img.readoutAxis;
        const stats = { teEff: c.tc - c.tExc, bwPerPixel: img.bwPerPixel, peBandwidthPerPixel: null,
            fatShiftPx: { readout: 0, phase: 0 } };
        const gmag = hypot(c.gx, c.gy);
        if (c.constant && gmag > 0) {
            const pix = roAxis === 'y' ? img.fovY / img.ny : img.fovX / img.nx;
            const bw = gmag * pix;
            const sign = roAxis === 'x' ? Math.sign(c.gx) : (roAxis === 'y' ? Math.sign(c.gy) : 1);
            stats.bwPerPixel = bw;
            stats.fatShiftPx.readout = C.FAT_HZ / bw * (sign || 1);
        }
        const pe = roAxis === 'x' ? 'y' : (roAxis === 'y' ? 'x' : null);
        if (pe) {
            // least-squares slope of tau against phase-encode k over the readouts of this excitation
            let sk = 0, st = 0, skk = 0, skt = 0, m = 0;
            for (const r of reads) {
                if (r.tExc !== c.tExc) continue;
                const k = pe === 'y' ? r.kcy : r.kcx;
                sk += k; st += r.tau; skk += k * k; skt += k * r.tau; m++;
            }
            const den = m * skk - sk * sk;
            if (m >= 2 && den > 0) {
                const s = (m * skt - sk * st) / den;                 // s per (cycle/m)
                const pix = pe === 'y' ? img.fovY / img.ny : img.fovX / img.nx;
                if (abs(s) * C.PPM_HZ > 1e-6 * pix) {
                    stats.peBandwidthPerPixel = abs(pix / s);
                    stats.fatShiftPx.phase = C.FAT_HZ * s / pix;
                }
            }
        }
        return stats;
    }

    /* ============================================================
       tissueEvolution (section 9.4)
       ============================================================

       The magnetisation history of each tissue on its own, at nominal B1
       and at its own chemical shift, for the Contrast tab. The curves cover
       the first `periods` repetitions (default 4: the approach to the
       steady state) and, when it comes later, the repetition that records
       the centre of k-space (the steady state that sets the contrast).
       Mz and the pathway's Mxy are sampled on a grid of about `points`
       times, plus just before and just after every RF pulse and spoiler in
       those windows so that every jump is drawn sharp. */
    function tissueEvolution(program, phantom, opts) {
        opts = opts || {};
        checkProgram(program);
        const nPer = max(1, round(numOr(opts.periods, 4)));
        const nPts = max(16, round(numOr(opts.points, 2000)));
        const all = phantom.tissues;
        const list = [];
        for (let i = 1; i < all.length; i++) list.push(all[i]);
        const nT = list.length;
        const rates = tissueRates(list);
        const cStart = new Int32Array(nT), cEnd = new Int32Array(nT), clsB1 = new Float64Array(nT), clsDf = new Float64Array(nT);
        for (let k = 0; k < nT; k++) { cStart[k] = k; cEnd[k] = k + 1; clsB1[k] = 1; clsDf[k] = (list[k].cs || 0) * C.PPM_HZ; }
        const model = Object.assign({ nT: nT, nCls: nT, cStart: cStart, cEnd: cEnd, clsB1: clsB1, clsDf: clsDf }, rates);

        const ev = buildTimeline(program);
        const reads = walkPathway(program, ev);
        const ci = reads.length ? centreReadout(reads) : -1;

        // Windows: the first nPer periods, and the period of the k-space centre.
        const per = program.periods && program.periods.length ? program.periods : [{ t0: 0, dur: program.duration, index: 0 }];
        const last = per[min(nPer, per.length) - 1];
        const windows = [{ t0: per[0].t0, t1: last.t0 + last.dur }];
        if (ci >= 0) {
            const pc = per.find(function (p) { return p.index === reads[ci].period; });
            if (pc && pc.t0 >= windows[0].t1 - 1e-9) windows.push({ t0: pc.t0, t1: pc.t0 + pc.dur });
        }
        const grid = [];
        windows.forEach(function (w, wi) {
            const m = wi === 0 ? nPts : max(16, round(nPts / 4));
            for (let i = 0; i < m; i++) grid.push(w.t0 + (w.t1 - w.t0) * i / (m - 1));
        });
        const inWindow = function (t) {
            for (const w of windows) if (t >= w.t0 - 1e-12 && t <= w.t1 + 1e-12) return true;
            return false;
        };
        const tOut = [], mzOut = [], mxyOut = [];
        for (let k = 0; k < nT; k++) { mzOut.push([]); mxyOut.push([]); }
        const sampling = {
            times: Float64Array.from(grid),
            inWindow: inWindow,
            record: function (t, mz, mxy) {
                tOut.push(t);
                for (let k = 0; k < nT; k++) { mzOut[k].push(mz[k]); mxyOut[k].push(mxy[k]); }
            }
        };
        const amps = track(program, ev, model, reads, sampling);

        const events = [];
        for (const e of ev) {
            if (!inWindow(e.t)) continue;
            if (e.type === EV_RF) { const r = program.rf[e.i]; events.push({ t: r.t, kind: 'rf', role: r.role, flip: r.flip, select: r.select, dummy: !!r.dummy }); }
            else if (e.type === EV_SPOIL) events.push({ t: e.t, kind: 'spoil' });
            else events.push({ t: e.t, kind: 'adc' });
        }
        const adc = reads.map(function (r, i) {
            return { t: r.tc, te: r.tc - r.tExc, amp: Float32Array.from(amps.subarray(i * nT, (i + 1) * nT)) };
        });
        // index ranges of the windows in t (the second window follows a gap in time)
        const segments = [];
        let i0 = 0;
        windows.forEach(function (w) {
            let i1 = i0;
            while (i1 < tOut.length && tOut[i1] <= w.t1 + 1e-12) i1++;
            segments.push({ t0: w.t0, t1: w.t1, i0: i0, i1: i1 });
            i0 = i1;
        });
        return {
            tissues: list.map(function (t) { return { id: t.id, name: t.name, color: t.color }; }),
            t: Float32Array.from(tOut),
            mz: mzOut.map(function (a) { return Float32Array.from(a); }),
            mxy: mxyOut.map(function (a) { return Float32Array.from(a); }),
            events: events,
            adc: adc,
            center: ci >= 0 ? { index: ci, te: adc[ci].te, amp: adc[ci].amp, t: adc[ci].t, period: reads[ci].period } : null,
            segments: segments
        };
    }

    MRI.engine = {
        simulate: simulate,
        tissueEvolution: tissueEvolution,
        NOISE_REF: NOISE_REF,
        defaults: DEFAULTS,
        // exposed for tests and curious readers
        _internal: { buildTimeline, walkPathway, constantGradient, centreReadout, buildModel, track, chooseM,
            boxAverage, motionAt, mergeArtifacts }
    };

})(typeof window !== 'undefined' ? window : globalThis);
