/* ============================================================
   MRI Simulator, proton spectroscopy (spectro.js)

   The simplest MR experiment of all: tip every spin in the coil
   with a short non-selective pulse and record the free induction
   decay (FID). With no gradients there is no spatial encoding, so
   the Fourier transform of the FID is a spectrum: one line per
   chemically distinct group of protons, at its chemical shift.
   See ARCHITECTURE.md section 11 for the contract.

   The model, in the order the code runs it:

   1. Species. Every tissue in the phantom contributes water (111 M
      of protons times pd times its water fraction), lipid (the eight
      fat lines of tissues.js) and metabolites (mM times the number of
      protons in each group). Each spin group is a "line" at
      (ppm - 4.7) * PPM_HZ Hz from the receiver, which sits on water.
   2. Field. The excitation is non-selective, so the coil sees the
      whole object. The off-resonance map is histogrammed per tissue
      into bins of about 0.5 Hz. A spread of fields across the object
      becomes a spread of frequencies, which is why a poor shim gives
      broad lines.
   3. Magnetisation. Mz is tracked per (line, field bin) through every
      RF pulse and spoiler of the program, with T1 recovery in between.
      The flip angle seen by a line depends on how far it is from the
      pulse frequency (a narrow Gaussian for the CHESS water pulses, a
      broad sinc for a short hard pulse). This is the whole mechanism
      of water suppression and of T1 saturation at short TR.
   4. Signal. Each ADC records, from the latest excitation, the sum of
      decaying complex exponentials exp(+i 2 pi f t) exp(-t/T2) with an
      extra Lorentzian broadening for field variation too fine to
      resolve (3 Hz in tissue, 1 Hz in test objects). Lactate's methyl
      doublet and methine quartet come from J coupling (6.93 Hz).
      Transients are averaged and complex white noise is added.

   Honest simplifications: one coherence pathway (an excitation
   assumes earlier transverse magnetisation was spoiled; refocusing
   pulses form a spin echo but never a stimulated echo); RF phases
   are ignored; the receive coil is uniform (the body coil); gradients
   other than the ideal "spoil" are not simulated; J coupling is weak
   (first order) and only lactate's is drawn, the other multiplets are
   single lines.

   Sign convention: the signal of a line at f Hz is exp(+i 2 pi f t),
   so the forward FFT puts it at +f and higher frequency is higher
   ppm. The imaging engine's demodulation uses the opposite sign
   (section 3); the two modules never exchange raw data, and this one
   follows section 11.

   Nothing here touches the DOM; tests/test_spectro.js runs it in Node.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const C = MRI.const;
    const U = MRI.util;

    // Local names for Math functions used in the inner loops.
    const { PI, abs, cos, sin, exp, sqrt, floor, ceil, round, max, min, atan2, log2 } = Math;
    const TWO_PI = 2 * PI;

    const WATER_PPM = C.WATER_PPM;           // 4.7 ppm, where the receiver frequency sits
    const PPM_HZ = C.PPM_HZ;                 // about 127.7 Hz per ppm at 3 T
    const BIN_HZ = 0.5;                      // target width of the field-histogram bins
    const CM2_PER_M2 = 1e4;

    /* Linewidth from field variation on a scale far below a pixel
       (microscopic susceptibility, the unresolved part of the shim).
       Test objects are homogeneous liquids, tissue is not. Expressed as
       the extra Lorentzian full width at half maximum, in Hz. */
    const BROADEN_TISSUE_HZ = 3;
    const BROADEN_TEST_HZ = 1;
    function broadeningHz(tissue) {
        const id = tissue.id || '';
        return (id === 'braino' || id === 'water' || id === 'oil' || id.slice(0, 4) === 'vial')
            ? BROADEN_TEST_HZ : BROADEN_TISSUE_HZ;
    }

    /* Noise. Signal amplitudes are in "molar protons times cm^2 of
       object" (the 2D phantom stands in for a slab of fixed thickness).
       Complex white noise of standard deviation NOISE_REF * sqrt(SW) is
       added to each sample of each transient, per real and imaginary
       part: white noise power grows with the bandwidth the receiver lets
       through, so a wider spectral width means more noise per sample.
       Averaging N transients divides it by sqrt(N). NOISE_REF is chosen
       (see tests/test_spectro.js) so that the MRS phantom with the fid
       preset (NA 16, 1 Hz line broadening) gives an NAA SNR of about 45. */
    const NOISE_REF = 0.15;

    /* Species groups: how the components are named and coloured. Water
       and lipid borrow the colours of the doped-water and fat tissues. */
    const WATER_META = { id: 'water', name: 'Water', color: '#64a9e6' };
    const LIPID_META = { id: 'lipid', name: 'Lipid', color: '#f2c94c' };
    function groupMeta(id) {
        if (id === 'water') return WATER_META;
        if (id === 'lipid') return LIPID_META;
        const m = MRI.tissues.metabolites[id];
        return { id: id, name: m ? m.name : id, color: m ? m.color : '#888888' };
    }
    function groupOrder() { return ['water', 'lipid'].concat(Object.keys(MRI.tissues.metabolites)); }

    /* Number of equivalent protons a J-coupled group is split by: a
       doublet sees one neighbour, a triplet two, a quartet three. Under
       weak coupling a group coupled to k equivalent protons evolves as
       cos(pi J t)^k: lactate's CH3 doublet as cos, its CH quartet as cos^3
       (whose expansion is exactly the 1:3:3:1 quartet). */
    const MULT_K = { d: 1, t: 2, q: 3 };

    /* ---------- Species lines of one tissue ---------- */
    function mkLine(group, ppm, conc, t1, t2) {
        return { group: group, ppm: ppm, fHz: (ppm - WATER_PPM) * PPM_HZ, conc: conc,
            t1: t1 > 0 ? t1 : 1e-6, t2: t2 > 0 ? t2 : 1e-6, J: 0, jk: 0 };
    }

    /* conc is the proton concentration in mol/L. Water relaxes with the
       tissue's own T1 and T2. Lipid in a fat tissue (one the imaging model
       shifts by -3.4 ppm) relaxes with that tissue's values, so oil and
       scalp fat differ and the Phantom tab's overrides carry through;
       otherwise the library lipid values apply. Metabolite relaxation
       belongs to the molecule, not the tissue. */
    function tissueLines(t) {
        const out = [];
        const sp = t.spectrum || {};
        const pd = Number(t.pd) || 0;
        const WP = MRI.tissues.WATER_PROTON_MOLAR;           // 111 M
        if (pd > 0 && sp.water > 0) out.push(mkLine('water', WATER_PPM, WP * pd * sp.water, t.t1, t.t2));
        if (pd > 0 && sp.lipid > 0) {
            const L = MRI.tissues.lipid;
            const fatTissue = (Number(t.cs) || 0) !== 0;
            const t1 = fatTissue ? t.t1 : L.t1, t2 = fatTissue ? t.t2 : L.t2;
            for (const ln of MRI.tissues.lipidLines) out.push(mkLine('lipid', ln.ppm, WP * pd * sp.lipid * ln.frac, t1, t2));
        }
        const mets = sp.metabolites || {};
        for (const id of Object.keys(MRI.tissues.metabolites)) {
            const mM = Number(mets[id]) || 0;
            if (!(mM > 0)) continue;
            const m = MRI.tissues.metabolites[id];
            for (const ln of m.lines) {
                const L = mkLine(id, ln.ppm, mM * 1e-3 * ln.nH, m.t1, m.t2);
                if (ln.J && MULT_K[ln.mult]) { L.J = ln.J; L.jk = MULT_K[ln.mult]; }
                out.push(L);
            }
        }
        return out;
    }

    /* ---------- Spin classes: tissue x B1 bin, each with a field histogram ----------
       The total off-resonance of every point is split between the two
       nearest bins of a grid of spacing delta Hz (linear interpolation,
       so the mean frequency of each class is exact). Bin m sits at
       m * delta Hz. Weights are object area in cm^2. */
    function buildClasses(phantom, b0Map, b1Map, delta, lineFilter) {
        const n = phantom.n, N = n * n, label = phantom.label, tissues = phantom.tissues;
        const dA = phantom.dx * phantom.dx * CM2_PER_M2;
        const tLines = tissues.map(function (t, i) {
            if (i === 0) return [];
            const ls = tissueLines(t);
            return lineFilter ? ls.filter(lineFilter) : ls;
        });

        /* B1 (dielectric effect at 3 T): flip angles scale with the local
           transmit field. Points are grouped into up to 9 bins of B1. */
        let nB1 = 1, b1lo = 1, b1step = 1;
        if (b1Map) {
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < N; i++) {
                const L = label[i];
                if (!L || !tLines[L].length) continue;
                const v = b1Map[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (hi - lo > 1e-3) { nB1 = 9; b1lo = lo; b1step = (hi - lo) / nB1; }
        }

        const nC = tissues.length * nB1;
        const cls = new Int32Array(N);
        const mLo = new Float64Array(nC).fill(Infinity), mHi = new Float64Array(nC).fill(-Infinity);
        const b1Sum = new Float64Array(nC), count = new Float64Array(nC);
        for (let i = 0; i < N; i++) {
            const L = label[i];
            if (!L || !tLines[L].length) { cls[i] = -1; continue; }
            let bb = 0;
            if (nB1 > 1) bb = min(nB1 - 1, max(0, floor((b1Map[i] - b1lo) / b1step)));
            const c = L * nB1 + bb;
            cls[i] = c;
            const f = b0Map ? b0Map[i] : 0;
            const m = (isFinite(f) ? f : 0) / delta;
            if (m < mLo[c]) mLo[c] = m;
            if (m > mHi[c]) mHi[c] = m;
            b1Sum[c] += b1Map ? b1Map[i] : 1;
            count[c]++;
        }
        const dense = new Array(nC), base = new Int32Array(nC);
        for (let c = 0; c < nC; c++) {
            if (!count[c]) continue;
            base[c] = floor(mLo[c]);
            dense[c] = new Float64Array(floor(mHi[c]) - base[c] + 2);
        }
        for (let i = 0; i < N; i++) {
            const c = cls[i];
            if (c < 0) continue;
            const f = b0Map ? b0Map[i] : 0;
            const m = (isFinite(f) ? f : 0) / delta;
            const m0 = floor(m), fr = m - m0, h = dense[c], k = m0 - base[c];
            h[k] += (1 - fr) * dA;
            h[k + 1] += fr * dA;
        }
        const classes = [];
        for (let c = 0; c < nC; c++) {
            if (!count[c]) continue;
            const h = dense[c];
            let nb = 0;
            for (let k = 0; k < h.length; k++) if (h[k] > 0) nb++;
            const m = new Int32Array(nb), w = new Float64Array(nb);
            let j = 0, area = 0;
            for (let k = 0; k < h.length; k++) if (h[k] > 0) { m[j] = base[c] + k; w[j] = h[k]; area += h[k]; j++; }
            const ti = floor(c / nB1), t = tissues[ti];
            classes.push({ tissueIndex: ti, tissue: t, lines: tLines[ti], b1: b1Map ? b1Sum[c] / count[c] : 1,
                m: m, w: w, area: area, broadenHz: broadeningHz(t) });
        }
        return classes;
    }

    /* ---------- Magnetisation trackers ----------
       One tracker per (class, line, field bin), laid out as contiguous
       segments, one segment per (class, line). Mz and the transverse
       amplitude are fractions of that tracker's equilibrium
       magnetisation. */
    function buildTrackers(classes, delta) {
        const segs = [];
        let T = 0;
        for (const c of classes) for (const ln of c.lines) {
            segs.push({ cls: c, line: ln, start: T, len: c.m.length });
            T += c.m.length;
        }
        const df = new Float64Array(T), b1 = new Float64Array(T);
        for (const s of segs) {
            for (let b = 0; b < s.len; b++) {
                df[s.start + b] = s.line.fHz + s.cls.m[b] * delta;     // Hz from the receiver frequency
                b1[s.start + b] = s.cls.b1;
            }
        }
        const mz = new Float64Array(T);
        mz.fill(1);
        return { segs: segs, T: T, df: df, b1: b1, mz: mz, mxy: new Float64Array(T), prof: new Map() };
    }

    /* Spectral profile of an RF pulse: the fraction of the nominal flip
       angle a spin x Hz away from the pulse frequency receives.
       - hard: a rectangular pulse of length dur has the frequency response
         sinc(x dur) (small-tip approximation), so a 0.1 ms pulse is flat
         to a few percent over the whole spectrum but a 0.5 ms one is not.
       - water / fat (Gaussian): FWHM bw around the pulse frequency.
       - adiabatic (sech): full effect inside its swept band, none outside.
       - slice: the slice-select gradient maps frequency onto position, and
         in this 2D model every spin lies in the slice, so the whole object
         gets the nominal flip. */
    function spectralProfile(rf, df) {
        const x = df - (rf.offsetHz || 0);
        switch (rf.shape) {
            case 'hard': return U.sinc(x * rf.dur);
            case 'gauss': { const r = x / (rf.bw || 1); return exp(-4 * Math.LN2 * r * r); }
            case 'sech': { const hw = 0.5 * (rf.bw || 1); return 0.5 * (1 - Math.tanh((abs(x) - hw) / (0.05 * hw))); }
            default: return 1;
        }
    }

    /* cos, sin and sin^2(a/2) of the effective flip of every tracker for
       one kind of pulse, cached because a sequence repeats the same few
       pulses many times. */
    function rfFactors(tr, rf) {
        const key = [rf.shape, rf.flip, rf.dur, rf.bw, rf.offsetHz].join('|');
        let P = tr.prof.get(key);
        if (P) return P;
        const T = tr.T, a0 = rf.flip * PI / 180, adiabatic = rf.shape === 'sech';
        P = { c: new Float64Array(T), s: new Float64Array(T), h: new Float64Array(T) };
        for (let k = 0; k < T; k++) {
            const p = spectralProfile(rf, tr.df[k]);
            const a = a0 * p * (adiabatic ? 1 : tr.b1[k]);     // adiabatic pulses are B1-insensitive
            const sh = sin(0.5 * a);
            P.c[k] = cos(a); P.s[k] = sin(a); P.h[k] = sh * sh;
        }
        tr.prof.set(key, P);
        return P;
    }

    /* Time-ordered events. Spoilers sort before an RF at the same instant,
       RF before an ADC. */
    function eventList(program, ref) {
        const ev = [];
        for (const r of program.rf) ev.push({ t: r.t, k: 1, rf: r });
        for (const s of program.spoil) ev.push({ t: s.t, k: 0 });
        for (const a of program.adc) {
            if (a.dummy) continue;
            ev.push({ t: a.t0, k: 2, adc: a, use: a.n === ref.n && abs(a.dwell - ref.dwell) <= 1e-12 * ref.dwell + 1e-15 });
        }
        ev.sort(function (a, b) { return (a.t - b.t) || (a.k - b.k); });
        return ev;
    }

    /* Walk the program once, tracking every Mz. At each recorded ADC the
       transverse amplitudes are added into a group keyed by the timing
       of that ADC relative to its excitation. Transients with the same
       timing differ only in amplitude, and the signal is linear in the
       amplitudes, so averaging the amplitudes and synthesising once is
       exactly the same as synthesising every transient and averaging.

       Pathway state, as in the imaging engine: tau is the dephasing clock
       (time over which chemical shift and field offsets have acted).
       An excitation sets it to 0, a refocusing pulse negates it, time
       advances it. tt is the time since the excitation, which governs T2
       decay and J evolution (a non-selective refocusing pulse flips both
       coupled partners, so J coupling is not refocused). */
    function walk(tr, events, skipSaturate) {
        const segs = tr.segs, mz = tr.mz, mxy = tr.mxy, T = tr.T;
        const groups = new Map(), order = [];
        let tPrev = 0, tau = 0, tExc = 0, excited = false, nUsed = 0, nEmpty = 0, nSkipped = 0, nExc = 0;
        for (const e of events) {
            const dt = e.t - tPrev;
            if (dt > 0) {
                // T1 recovery towards equilibrium: Mz = 1 - (1 - Mz) exp(-dt/T1)
                for (const s of segs) {
                    const E1 = exp(-dt / s.line.t1), end = s.start + s.len;
                    for (let k = s.start; k < end; k++) mz[k] = 1 - (1 - mz[k]) * E1;
                }
                tau += dt;
                tPrev = e.t;
            }
            if (e.k === 0) {                         // spoil: transverse magnetisation destroyed
                mxy.fill(0);
                excited = false;
            } else if (e.k === 1) {
                const rf = e.rf;
                if (skipSaturate && rf.role === 'saturate') continue;
                const P = rfFactors(tr, rf);
                if (rf.role === 'excite') {
                    // tip Mz into the transverse plane; earlier transverse magnetisation assumed spoiled
                    for (let k = 0; k < T; k++) { mxy[k] = mz[k] * P.s[k]; mz[k] *= P.c[k]; }
                    excited = true; tExc = e.t; tau = 0; nExc++;
                } else if (rf.role === 'refocus') {
                    // one pathway: the echo amplitude is sin^2(a/2), and the phase clock is mirrored
                    for (let k = 0; k < T; k++) { mxy[k] *= P.h[k]; mz[k] *= P.c[k]; }
                    tau = -tau;
                } else {
                    // invert / saturate act on Mz only (their own transverse part is assumed spoiled)
                    for (let k = 0; k < T; k++) mz[k] *= P.c[k];
                }
            } else {
                if (!e.use) { nSkipped++; continue; }
                nUsed++;
                const a = e.adc;
                const tt0 = excited ? a.t0 - tExc : 0, tau0 = excited ? tau : 0;
                const key = round(tau0 * 1e9) + '|' + round(tt0 * 1e9);
                let g = groups.get(key);
                if (!g) {
                    g = { tau0: tau0, tt0: tt0, count: 0, excited: excited, sum: new Float64Array(T) };
                    groups.set(key, g);
                    order.push(g);
                }
                g.count++;
                if (excited) { const sum = g.sum; for (let k = 0; k < T; k++) sum[k] += mxy[k]; }
                else nEmpty++;
            }
        }
        return { groups: order, nUsed: nUsed, nEmpty: nEmpty, nSkipped: nSkipped, nExc: nExc };
    }

    /* ---------- Signal synthesis ----------
       For one (class, line) segment, given the averaged transverse
       amplitude a_b of each field bin, add to out[] the samples

         s_j = J(tt_j) exp(-tt_j/T2) exp(-pi B |tau_j|) exp(i 2 pi f_line tau_j)
               * sum_b a_b exp(i 2 pi f_b tau_j),
         tau_j = tau0 + j dt,  tt_j = tt0 + j dt,  f_b = m_b delta,

       where B is the unresolved broadening (FWHM, Hz). The field sum H_j is
       evaluated either directly (a rotating phasor per bin) or, when there
       are many bins, with one FFT: delta is chosen as SW / L with L an
       integer, so exp(i 2 pi m delta j dt) = exp(i 2 pi m j / L) and the sum
       over bins is exactly an inverse DFT of length L (bins wrap modulo L,
       which is exact). Every oscillating factor is a complex recurrence,
       so there is no trigonometry per sample. */
    function makeSynth(n, dt, delta, L) {
        return {
            n: n, dt: dt, delta: delta, L: L,
            bufRe: new Float64Array(L), bufIm: new Float64Array(L),
            hRe: new Float64Array(n), hIm: new Float64Array(n),
            fftWork: 6 * L * log2(L),                       // rough flop counts used to pick a method
            lor: new Map()
        };
    }

    // exp(-pi B |tau_j|), cached per (broadening, tau0).
    function lorentzEnvelope(S, B, tau0) {
        const key = B + '|' + tau0;
        let e = S.lor.get(key);
        if (e) return e;
        e = new Float64Array(S.n);
        for (let j = 0; j < S.n; j++) e[j] = exp(-PI * B * abs(tau0 + j * S.dt));
        S.lor.set(key, e);
        return e;
    }

    function synthSegment(S, seg, amp, tau0, tt0, outRe, outIm) {
        const n = S.n, dt = S.dt, delta = S.delta, L = S.L;
        const m = seg.cls.m, nb = m.length;
        const hRe = S.hRe, hIm = S.hIm;
        if (nb * n * 8 <= S.fftWork) {
            hRe.fill(0); hIm.fill(0);
            for (let b = 0; b < nb; b++) {
                const a = amp[b];
                if (!a) continue;
                const fb = m[b] * delta;
                let pr = a * cos(TWO_PI * fb * tau0), pi = a * sin(TWO_PI * fb * tau0);
                const wr = cos(TWO_PI * fb * dt), wi = sin(TWO_PI * fb * dt);
                for (let j = 0; j < n; j++) {
                    hRe[j] += pr; hIm[j] += pi;
                    const t = pr * wr - pi * wi;
                    pi = pr * wi + pi * wr; pr = t;
                }
            }
        } else {
            const bRe = S.bufRe, bIm = S.bufIm;
            bRe.fill(0); bIm.fill(0);
            for (let b = 0; b < nb; b++) {
                const a = amp[b];
                if (!a) continue;
                const idx = ((m[b] % L) + L) % L, ph = TWO_PI * m[b] * delta * tau0;
                bRe[idx] += a * cos(ph); bIm[idx] += a * sin(ph);
            }
            U.fft(bRe, bIm, true);                       // (1/L) sum_m X_m exp(+i 2 pi m j / L)
            for (let j = 0; j < n; j++) { hRe[j] = bRe[j] * L; hIm[j] = bIm[j] * L; }
        }
        const ln = seg.line;
        const lor = lorentzEnvelope(S, seg.cls.broadenHz, tau0);
        // line frequency and T2 decay as one recurrence
        const r2 = exp(-dt / ln.t2), d0 = exp(-tt0 / ln.t2);
        const wr = cos(TWO_PI * ln.fHz * dt) * r2, wi = sin(TWO_PI * ln.fHz * dt) * r2;
        let pr = cos(TWO_PI * ln.fHz * tau0) * d0, pi = sin(TWO_PI * ln.fHz * tau0) * d0;
        if (ln.jk) {
            // J modulation cos(pi J tt)^k, cos taken from a unit phasor recurrence
            const jwr = cos(PI * ln.J * dt), jwi = sin(PI * ln.J * dt);
            let jr = cos(PI * ln.J * tt0), ji = sin(PI * ln.J * tt0);
            const k = ln.jk;
            for (let j = 0; j < n; j++) {
                let c = jr;
                if (k === 2) c = jr * jr; else if (k === 3) c = jr * jr * jr;
                const g = lor[j] * c, fr = pr * g, fi = pi * g, hr = hRe[j], hi = hIm[j];
                outRe[j] += hr * fr - hi * fi; outIm[j] += hr * fi + hi * fr;
                let t = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = t;
                t = jr * jwr - ji * jwi; ji = jr * jwi + ji * jwr; jr = t;
            }
        } else {
            for (let j = 0; j < n; j++) {
                const g = lor[j], fr = pr * g, fi = pi * g, hr = hRe[j], hi = hIm[j];
                outRe[j] += hr * fr - hi * fi; outIm[j] += hr * fi + hi * fr;
                const t = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = t;
            }
        }
    }

    /* B1 changes flip angles but not precession, so after the Mz walk the
       B1 classes of one tissue are merged again: one synthesis unit per
       tissue line, over the union of the field bins of its classes. Each
       unit looks like a segment to synthSegment ({cls: {m, broadenHz}, line}). */
    function synthUnits(tr) {
        const byLine = new Map();
        for (const s of tr.segs) {
            let u = byLine.get(s.line);
            if (!u) { u = { line: s.line, segs: [], broadenHz: s.cls.broadenHz }; byLine.set(s.line, u); }
            u.segs.push(s);
        }
        const units = [];
        for (const u of byLine.values()) {
            let lo = Infinity, hi = -Infinity;
            for (const s of u.segs) if (s.len) { lo = min(lo, s.cls.m[0]); hi = max(hi, s.cls.m[s.len - 1]); }
            if (!(hi >= lo)) continue;
            const used = new Uint8Array(hi - lo + 1);
            for (const s of u.segs) for (let b = 0; b < s.len; b++) used[s.cls.m[b] - lo] = 1;
            const index = new Int32Array(hi - lo + 1);
            let nb = 0;
            for (let k = 0; k < used.length; k++) if (used[k]) index[k] = nb++;
            const m = new Int32Array(nb);
            for (let k = 0; k < used.length; k++) if (used[k]) m[index[k]] = lo + k;
            const maps = u.segs.map(function (s) {
                const mp = new Int32Array(s.len);
                for (let b = 0; b < s.len; b++) mp[b] = index[s.cls.m[b] - lo];
                return mp;
            });
            units.push({ line: u.line, segs: u.segs, maps: maps, cls: { m: m, broadenHz: u.broadenHz }, amp: new Float64Array(nb) });
        }
        return units;
    }

    /* Grid for the field histogram: delta = SW / L with L a power of two,
       at least n (so the FFT window covers the whole acquisition) and
       large enough that delta is at most BIN_HZ. */
    function binGrid(sw, n) {
        const L = U.nextPow2(max(n, ceil(sw / BIN_HZ)));
        return { L: L, delta: sw / L };
    }

    /* ---------- Inputs ---------- */
    function fieldMaps(phantom, ctx) {
        ctx = ctx || {};
        const art = ctx.artifacts || {};
        const N = phantom.n * phantom.n;
        let b0 = ctx.b0Map || null;
        if (!b0 || b0.length !== N) {
            if (b0 && b0.length !== N && !(MRI.fields && MRI.fields.b0Map)) {
                throw new Error('The field map does not match the phantom raster (' + b0.length + ' points for a ' + phantom.n + ' x ' + phantom.n + ' phantom).');
            }
            b0 = MRI.fields && MRI.fields.b0Map ? MRI.fields.b0Map(phantom, art.b0 || {}) : null;
        }
        let b1 = ctx.b1Map && ctx.b1Map.length === N ? ctx.b1Map : null;
        if (!b1 && art.b1 && Number(art.b1.amount) > 0 && MRI.fields && MRI.fields.b1Map) b1 = MRI.fields.b1Map(phantom, art.b1);
        return { b0: b0, b1: b1 };
    }

    /* The spectroscopy simulator has no spatial encoding. A gradient that
       is on while the ADC samples means the program is an imaging
       sequence; say so rather than return a meaningless spectrum. */
    function checkNoReadoutGradient(program) {
        const adcs = program.adc.filter(function (a) { return !a.dummy; });
        for (const ax of ['x', 'y', 'z']) {
            const traps = (program.grad && program.grad[ax]) || [];
            let j = 0;
            for (const a of adcs) {
                const a1 = a.t0 + a.n * a.dwell;
                while (j < traps.length && traps[j].t0 + traps[j].rise + traps[j].flat + traps[j].fall <= a.t0) j++;
                for (let k = j; k < traps.length && traps[k].t0 < a1; k++) {
                    const g = traps[k];
                    if (g.amp && g.t0 + g.rise + g.flat + g.fall > a.t0) {
                        throw new Error('This sequence plays a gradient on g' + ax + ' while the ADC is sampling (line ' + g.line +
                            '), which encodes position. The Spectroscopy tab simulates unlocalised spectroscopy without gradients, ' +
                            'so run imaging sequences from the Sequence tab instead.');
                    }
                }
            }
        }
    }

    /* ---------- simulate ---------- */
    function simulate(program, phantom, ctx, opts) {
        const tStart = Date.now();
        ctx = ctx || {};
        opts = opts || {};
        if (!program || !program.ok) throw new Error('The spectroscopy sequence does not compile.');
        if (!phantom || !phantom.label) throw new Error('No phantom to measure.');
        const art = ctx.artifacts || {};
        const ref = program.adc.find(function (a) { return !a.dummy; });
        if (!ref) throw new Error('This sequence has no ADC outside the dummy scans, so nothing is recorded. Add a line such as: adc NP dwell 1/SW at exc + delay');
        checkNoReadoutGradient(program);

        const n = ref.n, dt = ref.dwell, sw = 1 / dt;
        const grid = binGrid(sw, n);
        const maps = fieldMaps(phantom, ctx);
        const classes = buildClasses(phantom, maps.b0, maps.b1, grid.delta, null);
        const tr = buildTrackers(classes, grid.delta);
        const events = eventList(program, ref);
        const W = walk(tr, events, false);

        const averages = max(1, round(Number(program.image && program.image.averages) || 1));
        const nTransients = W.nUsed * averages;

        // Synthesise the averaged, noise-free signal of every species group.
        const order = groupOrder();
        const comp = new Map();
        for (const s of tr.segs) if (!comp.has(s.line.group)) comp.set(s.line.group, { re: new Float64Array(n), im: new Float64Array(n) });
        const S = makeSynth(n, dt, grid.delta, grid.L);
        const units = synthUnits(tr);
        for (const g of W.groups) {
            for (const u of units) {
                const amp = u.amp;
                amp.fill(0);
                let any = false;
                for (let q = 0; q < u.segs.length; q++) {
                    const s = u.segs[q], map = u.maps[q], w = s.cls.w, conc = s.line.conc / W.nUsed;
                    for (let b = 0; b < s.len; b++) { const v = g.sum[s.start + b] * conc * w[b]; if (v) { amp[map[b]] += v; any = true; } }
                }
                if (!any) continue;
                const o = comp.get(u.line.group);
                synthSegment(S, u, amp, g.tau0, g.tt0, o.re, o.im);
            }
        }
        const components = order.filter(function (id) { return comp.has(id); }).map(function (id) {
            const meta = groupMeta(id), o = comp.get(id);
            return { id: id, name: meta.name, color: meta.color, re: o.re, im: o.im };
        });

        const fid = { re: new Float64Array(n), im: new Float64Array(n) };
        for (const c of components) for (let j = 0; j < n; j++) { fid.re[j] += c.re[j]; fid.im[j] += c.im[j]; }
        const clean0 = Math.hypot(fid.re[0], fid.im[0]);

        /* Noise: the sum of N independent Gaussian transients divided by N
           is Gaussian with 1/sqrt(N) of the single-transient SD, so the
           averaged noise is drawn directly. */
        const noiseScale = art.noise === undefined ? 1 : max(0, Number(art.noise) || 0);
        const sigma1 = NOISE_REF * noiseScale * sqrt(sw);
        const noiseSigma = nTransients > 0 ? sigma1 / sqrt(nTransients) : sigma1;
        const seed = opts.seed === undefined ? 1 : opts.seed;
        const rng = U.rng(((seed >>> 0) ^ 0x51ec7a0) >>> 0);
        if (noiseSigma > 0) for (let j = 0; j < n; j++) { fid.re[j] += noiseSigma * rng.randn(); fid.im[j] += noiseSigma * rng.randn(); }

        /* Hardware faults (section 9.2), as they would appear in a spectrum.
           A spike is one corrupt sample of one transient: after averaging it
           is 1/N as tall, and its Fourier transform is a ripple across the
           whole spectrum. Zipper interference at a fixed frequency arrives
           with a random phase in each transient, so it averages down like
           noise and shows as a narrow spurious line. */
        if (art.spike && art.spike.on && nTransients > 0) {
            const total = W.nUsed * n;
            const gidx = min(total - 1, max(0, floor((Number(art.spike.at) || 0) * total)));
            fid.re[gidx % n] += (Number(art.spike.amp) || 0) * clean0 / nTransients;
        }
        if (art.zipper && art.zipper.on && nTransients > 0) {
            const zr = U.rng(((seed >>> 0) ^ 0x2a7f00d) >>> 0);
            let cr = 0, ci = 0;
            for (let k = 0; k < nTransients; k++) { const ph = TWO_PI * zr(); cr += cos(ph); ci += sin(ph); }
            const A = (Number(art.zipper.amp) || 0) * clean0 / nTransients;
            const f = Number(art.zipper.offsetHz) || 0;
            const wr = cos(TWO_PI * f * dt), wi = sin(TWO_PI * f * dt);
            let pr = A * cr, pi = A * ci;
            for (let j = 0; j < n; j++) {
                fid.re[j] += pr; fid.im[j] += pi;
                const t = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = t;
            }
        }

        /* Relative signal of each species: the averaged transverse amplitude
           as a fraction of a fully relaxed 90 degree excitation (before T2
           decay). Below 1 because of T1 saturation, flip angle, spectral
           selectivity or water suppression. */
        function relativeSignal(Wk, trk) {
            const num = {}, den = {};
            for (const s of trk.segs) {
                const id = s.line.group, w = s.cls.w, conc = s.line.conc;
                let a = 0, d = 0;
                for (const g of Wk.groups) for (let b = 0; b < s.len; b++) a += g.sum[s.start + b] * w[b];
                for (let b = 0; b < s.len; b++) d += w[b];
                num[id] = (num[id] || 0) + a * conc / max(1, Wk.nUsed);
                den[id] = (den[id] || 0) + d * conc;
            }
            const out = {};
            for (const id of Object.keys(num)) out[id] = den[id] > 0 ? num[id] / den[id] : 0;
            return out;
        }
        const rel = relativeSignal(W, tr);

        /* Water suppression, from the Mz state alone: run the same program
           again, for the water lines only, without the saturation pulses,
           and compare the transverse water magnetisation at the ADC. */
        const hasSat = program.rf.some(function (r) { return r.role === 'saturate'; });
        let waterSuppression = null, waterResidual = null;
        if (rel.water !== undefined) {
            if (hasSat) {
                const wClasses = buildClasses(phantom, maps.b0, maps.b1, grid.delta, function (l) { return l.group === 'water'; });
                const wtr = buildTrackers(wClasses, grid.delta);
                const W0 = walk(wtr, events, true);
                const rel0 = relativeSignal(W0, wtr).water || 0;
                waterResidual = rel0 > 0 ? rel.water / rel0 : null;
                waterSuppression = waterResidual === null ? null : 1 / max(abs(waterResidual), 1e-9);
            } else {
                waterResidual = 1; waterSuppression = 1;
            }
        }

        const wl = rel.water !== undefined ? waterLineFrom(phantom, maps.b0) : null;
        const notes = buildNotes({ program: program, phantom: phantom, components: components, rel: rel, W: W, tr: tr,
            hasWaterSat: program.rf.some(function (r) { return r.role === 'saturate' && spectralProfile(r, 0) > 0.5; }),
            waterSuppression: waterSuppression, waterResidual: waterResidual, wl: wl, sw: sw, classes: classes,
            b1: maps.b1, art: art });

        const first = W.groups.find(function (g) { return g.excited; }) || { tau0: 0, tt0: 0 };
        return {
            n: n, dwell: dt, sw: sw,
            delay: first.tau0,                    // see note below
            te: first.tt0,
            nTransients: nTransients,
            fid: fid,
            components: components,
            noiseSigma: noiseSigma,
            info: {
                waterSuppression: waterSuppression,
                waterResidual: waterResidual,
                linewidthHz: wl ? wl.fwhmHz : null,
                relativeSignal: rel,
                tr: program.stats && program.stats.TR != null ? program.stats.TR : null,
                adcSkipped: W.nSkipped,
                timingGroups: W.groups.length,
                computeMs: Date.now() - tStart,
                notes: notes
            }
        };
        /* delay: the time over which chemical shift has evolved at the first
           sample. For a pulse-acquire FID this is exactly the time from the
           excitation centre to the first sample. After a refocusing pulse it
           is measured from the echo, which is what first-order phasing needs;
           te holds the time since the excitation. */
    }

    /* ---------- The water line on its own (for the shim panel) ----------
       The fully relaxed, unsuppressed water line of the whole object: the
       field histogram of every tissue, each bin a Lorentzian set by the
       tissue's T2 plus the unresolved broadening. Computed in the time
       domain from t = 0 (so it is a pure absorption line) on a grid fine
       enough (0.25 Hz) to measure a linewidth of a few Hz. */
    function waterLineFrom(phantom, b0Map, spanHz) {
        let fmax = 0;
        if (b0Map) for (let i = 0; i < b0Map.length; i++) if (phantom.label[i]) { const a = abs(b0Map[i]); if (a > fmax && isFinite(a)) fmax = a; }
        const sw = max(spanHz || 0, 2 * (fmax + 60), 512);
        const L = U.nextPow2(ceil(sw / 0.25));
        const delta = sw / L, dt = 1 / sw;
        const classes = buildClasses(phantom, b0Map, null, delta, function (l) { return l.group === 'water'; });
        if (!classes.length) return null;
        const tr = buildTrackers(classes, delta);
        const S = makeSynth(L, dt, delta, L);
        const re = new Float64Array(2 * L), im = new Float64Array(2 * L);
        let amp = new Float64Array(16);
        for (const s of tr.segs) {
            if (amp.length < s.len) amp = new Float64Array(s.len);
            for (let b = 0; b < s.len; b++) amp[b] = s.line.conc * s.cls.w[b];
            synthSegment(S, s, amp, 0, 0, re, im);
        }
        // Half the first point: the discrete transform of a decay that starts
        // at t = 0 then integrates like the continuous one (no DC offset).
        re[0] *= 0.5; im[0] *= 0.5;
        U.fft(re, im, false);
        const N = 2 * L, hz = new Float64Array(N), spec = new Float64Array(N);
        const sh = floor(N / 2);
        for (let k = 0; k < N; k++) {
            const src = (k - sh + N) % N;
            hz[k] = (k - sh) * sw / N;
            spec[k] = re[src] * dt;
        }
        let kmax = 0;
        for (let k = 1; k < N; k++) if (spec[k] > spec[kmax]) kmax = k;
        const fw = fwhmAt(spec, kmax, sw / N);
        return { hz: hz, re: spec, fwhmHz: fw, peakHz: hz[kmax], sw: sw };
    }

    function waterLine(phantom, ctx, opts) {
        const maps = fieldMaps(phantom, ctx);
        return waterLineFrom(phantom, maps.b0, opts && opts.spanHz);
    }

    /* ---------- Notes for the student ---------- */
    function buildNotes(o) {
        const notes = [];
        const amp0 = {};
        for (const c of o.components) amp0[c.id] = Math.hypot(c.re[0], c.im[0]);
        let metab = 0;
        for (const c of o.components) if (c.id !== 'water' && c.id !== 'lipid') metab += amp0[c.id];
        const lipid = amp0.lipid || 0, water = amp0.water || 0, naa = amp0.NAA || 0;

        if (metab > 0 && lipid > 5 * metab) {
            notes.push(o.phantom.id === 'brain'
                ? 'Scalp lipid dominates: non-selective excitation sees the whole head, scalp fat and skull marrow included, and their lipid signal is hundreds of times larger than the metabolites. This is why in vivo spectroscopy is localised to a voxel inside the brain (PRESS, STEAM).'
                : 'Lipid dominates the metabolite region: non-selective excitation sees every bit of fat in the coil, and its signal is far larger than the metabolites.');
        }
        if (!o.hasWaterSat && water > 0 && metab > 0 && water > 100 * (naa || metab)) {
            notes.push('Water is about ' + U.fmtNum(water / (naa || metab), 2) + ' times larger than ' + (naa ? 'NAA' : 'the metabolites') +
                ', so the metabolites sit on the tails of the water line. Water suppression (the CHESS preset) removes most of it.');
        }
        if (o.hasWaterSat && o.waterSuppression !== null) {
            const pct = abs(o.waterResidual) * 100;
            notes.push('Water suppressed ' + U.fmtNum(o.waterSuppression, 3) + ' times (' + U.fmtNum(pct, 2) + ' percent of the water signal left' +
                (o.waterResidual < 0 ? ', inverted' : '') + ').');
            if (o.waterSuppression < 20) {
                notes.push('Water suppression is poor. A CHESS pulse is only about 80 Hz wide, so water shifted off resonance by a poor shim, ' +
                    'or tipped by the wrong angle where B1 is weak or strong, escapes it.');
            }
        }
        const ref = o.rel.NAA !== undefined ? 'NAA' : (o.rel.water !== undefined ? 'water' : null);
        if (ref && o.rel[ref] > 0 && o.rel[ref] < 0.8 && o.W.nExc > 0) {
            const tr = o.program.stats && o.program.stats.TR;
            notes.push((tr ? 'TR ' + U.fmtTime(tr) + ' is short compared with T1, so ' : 'Peaks are T1-weighted: ') +
                'each transient starts from partly recovered magnetisation (' + ref + ' at ' + Math.round(o.rel[ref] * 100) +
                ' percent of its fully relaxed signal).');
        }
        if (o.wl && o.wl.fwhmHz > 2.5 * intrinsicWaterFwhm(o.classes)) {
            notes.push('The water line is ' + U.fmtNum(o.wl.fwhmHz, 2) + ' Hz wide: the field is not uniform across the object. ' +
                'Shimming narrows it, but shims remove smooth fields, not the local field next to air spaces such as the sinuses.');
        }
        // Resonances outside the spectral width fold back (alias) into it.
        let outside = false;
        for (const s of o.tr.segs) if (abs(s.line.fHz) > 0.5 * o.sw) { outside = true; break; }
        if (outside) notes.push('Some resonances lie outside the spectral width (' + U.fmtFreq(o.sw) + ' centred on water) and fold back into the spectrum at the wrong place.');

        const excRf = o.program.rf.filter(function (r) { return r.role === 'excite' && !r.dummy; });
        if (excRf.some(function (r) { return r.shape === 'hard' && r.dur > 0.25e-3; })) {
            const r = excRf.find(function (x) { return x.shape === 'hard' && x.dur > 0.25e-3; });
            notes.push('The ' + U.fmtTime(r.dur) + ' hard pulse is long: its excitation band (about ' + U.fmtFreq(1 / r.dur) +
                ' wide) does not tip every resonance equally, so peaks far from water are excited less.');
        }
        if (excRf.some(function (r) { return r.select === 'slice'; })) {
            notes.push('Slice-selective pulses are treated as exciting the whole 2D object, so they localise nothing here.');
        }
        if (o.W.nEmpty > 0) notes.push(o.W.nEmpty + ' ADC window' + (o.W.nEmpty > 1 ? 's' : '') + ' recorded only noise: nothing had been excited since the last spoil.');
        if (o.W.nSkipped > 0) notes.push(o.W.nSkipped + ' ADC window' + (o.W.nSkipped > 1 ? 's' : '') + ' with a different number of points or dwell time were left out of the average.');
        const g = o.program.grad || {};
        const otherGrad = ['x', 'y', 'z'].some(function (ax) { return (g[ax] || []).some(function (t) { return t.tag !== 'spoil' && t.tag !== 'slice'; }); });
        if (otherGrad) notes.push('Gradients other than spoil are not simulated in spectroscopy: crushers are assumed ideal and nothing is spatially encoded.');
        const hasRefocus = o.program.rf.some(function (r) { return r.role === 'refocus'; });
        if (hasRefocus && amp0.Lac !== undefined) {
            notes.push('In a spin echo the lactate doublet is J-modulated as cos(pi J TE): it is upright at TE 288 ms, inverted at TE 144 ms (1/J), ' +
                'and at TE 72 ms its two lines point in opposite directions and cancel when integrated.');
        }
        if (o.b1) notes.push('B1 is not uniform (dielectric effect), so flip angles, and with them water suppression, vary across the object.');
        return notes;
    }

    // Narrowest possible water line in this object (perfect field): 1/(pi T2) + unresolved broadening.
    function intrinsicWaterFwhm(classes) {
        let best = Infinity;
        for (const c of classes) for (const l of c.lines) if (l.group === 'water') best = min(best, 1 / (PI * l.t2) + c.broadenHz);
        return isFinite(best) ? best : 1;
    }

    /* ---------- Processing ---------- */
    const defaults = { lb: 1, gb: 0, zf: 2, ph0: 0, ph1: 0, autoPhase: true, refPpm: 4.7, display: 'real' };

    /* Peaks reported in the table: nominal position and the window that
       is searched for the maximum and integrated. */
    const PEAKS = [
        { id: 'water', name: 'Water', ppm: 4.70, lo: 4.40, hi: 5.00 },
        { id: 'Cr2', name: 'Cr (CH2)', ppm: 3.913, lo: 3.85, hi: 3.97 },
        { id: 'mI', name: 'mI', ppm: 3.56, lo: 3.45, hi: 3.70 },
        { id: 'Cho', name: 'Cho', ppm: 3.20, lo: 3.15, hi: 3.27 },
        { id: 'Cr', name: 'Cr (CH3)', ppm: 3.027, lo: 2.95, hi: 3.10 },
        { id: 'Glx', name: 'Glx', ppm: 2.25, lo: 2.10, hi: 2.45 },
        { id: 'NAA', name: 'NAA', ppm: 2.008, lo: 1.90, hi: 2.10 },
        { id: 'Lac', name: 'Lac', ppm: 1.31, lo: 1.22, hi: 1.40 },
        { id: 'lipid13', name: 'Lipid 1.3', ppm: 1.30, lo: 1.20, hi: 1.45 },
        { id: 'lipid09', name: 'Lipid 0.9', ppm: 0.90, lo: 0.80, hi: 1.00 }
    ];
    const RATIO_WIN = { NAA: [1.9, 2.1], Cr: [2.95, 3.1], Cho: [3.15, 3.27] };

    /* Apodise, zero-fill, FFT, centre, scale. The spectrum is multiplied by
       the dwell time so it approximates the continuous Fourier integral:
       peak heights do not change with the spectral width, the number of
       points or the zero filling. */
    function transform(re, im, win, N, dt) {
        const n = re.length, R = new Float64Array(N), I = new Float64Array(N);
        for (let j = 0; j < n; j++) { R[j] = re[j] * win[j]; I[j] = im[j] * win[j]; }
        U.fft(R, I, false);
        const oR = new Float64Array(N), oI = new Float64Array(N), sh = floor(N / 2);
        for (let k = 0; k < N; k++) {                     // fftshift: frequency 0 to index floor(N/2)
            const d = (k + sh) % N;
            oR[d] = R[k] * dt; oI[d] = I[k] * dt;
        }
        return { re: oR, im: oI };
    }

    function mag2(s, k) { return s.re[k] * s.re[k] + s.im[k] * s.im[k]; }

    /* The spectrum at any frequency f (Hz), by a direct Fourier sum of the
       apodised FID with the same scaling as transform(). On the FFT grid
       it equals the FFT value; between grid points it is what infinite zero
       filling would give. */
    function dftAt(re, im, win, dt, f) {
        const wr = cos(TWO_PI * f * dt), wi = -sin(TWO_PI * f * dt);
        let pr = 1, pi = 0, sr = 0, si = 0;
        for (let j = 0; j < re.length; j++) {
            const x = re[j] * win[j], y = im[j] * win[j];
            sr += x * pr - y * pi; si += x * pi + y * pr;
            const t = pr * wr - pi * wi; pi = pr * wi + pi * wr; pr = t;
        }
        return { re: sr * dt, im: si * dt };
    }

    // Multiply by exp(i (ph0 + ph1 f/1000) pi/180), in place.
    function applyPhase(s, hz, ph0, ph1) {
        for (let k = 0; k < hz.length; k++) {
            const a = (ph0 + ph1 * hz[k] / 1000) * PI / 180, c = cos(a), q = sin(a);
            const r = s.re[k], i = s.im[k];
            s.re[k] = r * c - i * q; s.im[k] = r * q + i * c;
        }
    }

    // Full width at half maximum of the peak at index k, by linear interpolation.
    function fwhmAt(y, k, step) {
        const h = y[k] / 2;
        if (!(y[k] > 0)) return null;
        let l = k, r = k;
        while (l > 0 && y[l] > h) l--;
        while (r < y.length - 1 && y[r] > h) r++;
        if (y[l] > h || y[r] > h) return null;
        const xl = l + (h - y[l]) / (y[l + 1] - y[l]);
        const xr = r - (h - y[r]) / (y[r - 1] - y[r]);
        return (xr - xl) * step;
    }

    // Index range [a, b] of points whose ppm lies in [lo, hi]; ppm ascends with index.
    function ppmRange(ppm, lo, hi) {
        let a = 0, b = ppm.length - 1;
        while (a < ppm.length && ppm[a] < lo) a++;
        while (b >= 0 && ppm[b] > hi) b--;
        return [a, b];
    }

    /* Local baseline under a window. Peaks are measured above the baseline,
       as a spectroscopist reads them, because the baseline is not always
       zero: with unsuppressed water, the first fraction of a millisecond
       of a huge FID is lost before sampling starts, and the Fourier
       transform of that missing piece is a broad offset under the whole
       spectrum (the dead-time baseline). The baseline is a straight line
       through the median of the real spectrum in a 0.1 ppm flank on each
       side of the window; a median ignores a neighbouring narrow peak. */
    const FLANK_PPM = 0.1;
    function median(y, a, b) {
        if (a > b) return null;
        const v = Array.prototype.slice.call(y, a, b + 1).sort(function (p, q) { return p - q; });
        const m = v.length >> 1;
        return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
    }
    function localBaseline(y, ppm, lo, hi) {
        const rl = ppmRange(ppm, lo - FLANK_PPM, lo), rr = ppmRange(ppm, hi, hi + FLANK_PPM);
        let yl = median(y, rl[0], rl[1]), yr = median(y, rr[0], rr[1]);
        if (yl === null && yr === null) { yl = 0; yr = 0; }
        else if (yl === null) yl = yr;
        else if (yr === null) yr = yl;
        const xl = lo - FLANK_PPM / 2, xr = hi + FLANK_PPM / 2;
        return function (p) { return yl + (yr - yl) * (p - xl) / (xr - xl); };
    }

    /* Peak in the window [lo, hi] ppm, above the local baseline: the tallest
       point refined by a parabola through it and its neighbours, and the
       integral (area, in signal units: the spectrum is in units x seconds,
       the frequency step in Hz). */
    function windowPeak(y, ppm, lo, hi, step) {
        const r = ppmRange(ppm, lo, hi);
        if (r[0] > r[1]) return null;
        const base = localBaseline(y, ppm, lo, hi);
        const v = function (k) { return y[k] - base(ppm[k]); };
        let k = r[0], area = 0;
        for (let i = r[0]; i <= r[1]; i++) { const x = v(i); area += x; if (x > v(k)) k = i; }
        let pos = ppm[k], height = v(k);
        if (k > 0 && k < y.length - 1) {
            const y0 = v(k - 1), y1 = v(k), y2 = v(k + 1), den = y0 - 2 * y1 + y2;
            if (den < 0) {
                const d = 0.5 * (y0 - y2) / den;
                if (abs(d) <= 1) {
                    height = y1 - 0.25 * (y0 - y2) * d;
                    pos = ppm[k] + d * (ppm[k + 1] - ppm[k]);
                }
            }
        }
        return { index: k, ppm: pos, height: height, area: area * step, baseline: base(pos) };
    }

    /* Noise SD of the real spectrum in the outermost 15 percent of the
       spectral width on the downfield (high-ppm, high-frequency) side,
       where there is no signal.
       - Only the points of the original frequency grid are used (every
         zf-th point). Zero filling interpolates between them and adds no
         noise, but it does reveal the sinc ripple of an FID that has not
         decayed by the end of the acquisition (truncation), which is not
         noise either.
       - A quadratic is fitted and removed, so the slow curve of a
         dead-time baseline is not counted as noise. */
    function noiseSd(y, zf) {
        const N = y.length, c0 = floor(N / 2), a = floor(0.85 * N);
        const xs = [];
        for (let k = a; k < N; k++) if ((k - c0) % zf === 0) xs.push(k);
        const m = xs.length;
        if (m < 6) return 0;
        // least squares in x = -1..1 with the normal equations of 1, x, x^2
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
        const X = new Float64Array(m);
        for (let i = 0; i < m; i++) {
            const x = X[i] = 2 * i / (m - 1) - 1, x2 = x * x, v = y[xs[i]];
            s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
            t0 += v; t1 += x * v; t2 += x2 * v;
        }
        const c = solve3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
        let ss = 0;
        for (let i = 0; i < m; i++) {
            const x = X[i], e = y[xs[i]] - (c[0] + c[1] * x + c[2] * x * x);
            ss += e * e;
        }
        return sqrt(ss / (m - 3));
    }
    // 3 x 3 linear solve by Cramer's rule (the system is small and well conditioned).
    function solve3(A, b) {
        const det = function (M) {
            return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
                M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
        };
        const D = det(A);
        if (!D) return [0, 0, 0];
        return [0, 1, 2].map(function (i) {
            const M = A.map(function (row, r) { return row.map(function (v, c) { return c === i ? b[r] : v; }); });
            return det(M) / D;
        });
    }

    function process(spec, p) {
        p = Object.assign({}, defaults, p || {});
        const n = spec.n, dt = spec.dwell, sw = 1 / dt;
        const zf = max(1, round(Number(p.zf) || 1));
        const N = n * zf, step = sw / N;
        const lb = Number(p.lb) || 0, gb = Number(p.gb) || 0;
        const refPpm = isFinite(Number(p.refPpm)) ? Number(p.refPpm) : WATER_PPM;

        /* Apodisation, t from the first sample. Exponential: exp(-pi lb t)
           adds lb Hz to every Lorentzian linewidth (less noise, broader
           lines). Gaussian: exp(-(pi gb t)^2 / (4 ln 2)) convolves the
           spectrum with a Gaussian of FWHM gb Hz. */
        const win = new Float64Array(n);
        const gq = (PI * gb) * (PI * gb) / (4 * Math.LN2);
        for (let j = 0; j < n; j++) { const t = j * dt; win[j] = exp(-PI * lb * t - gq * t * t); }

        const hz = new Float64Array(N), ppm = new Float64Array(N), sh = floor(N / 2);
        for (let k = 0; k < N; k++) { hz[k] = (k - sh) * step; ppm[k] = refPpm + hz[k] / PPM_HZ; }

        const total = transform(spec.fid.re, spec.fid.im, win, N, dt);
        const comps = (spec.components || []).map(function (c) {
            const t = transform(c.re, c.im, win, N, dt);
            return { id: c.id, name: c.name, color: c.color, re: t.re, im: t.im };
        });

        /* Phase. A delay between the excitation and the first sample lets
           every line precess by 2 pi f delay before sampling starts, a phase
           that grows linearly with frequency: first-order phase,
           ph1 = -360 deg x delay per Hz (times 1000 per kHz) removes it.
           Zero-order phase (receiver phase) is then set so the tallest peak
           is absorptive: the phase that maximises its real part. */
        let ph0 = Number(p.ph0) || 0, ph1 = Number(p.ph1) || 0;
        if (p.autoPhase) {
            ph1 = -360 * (spec.delay || 0) * 1000;
            /* The real part of a line is largest when its value at the exact
               line centre is real and positive. The centre rarely falls on a
               grid point, and a point beside it carries some dispersion, so
               find the magnitude maximum by evaluating the spectrum directly
               at finer and finer frequency steps, then take the phase there. */
            let k0 = 0;
            for (let k = 1; k < N; k++) if (mag2(total, k) > mag2(total, k0)) k0 = k;
            let fc = hz[k0], span = step;
            for (let level = 0; level < 3; level++) {
                let bestF = fc, bestM = -1;
                for (let i = -10; i <= 10; i++) {
                    const f = fc + i * span / 10, v = dftAt(spec.fid.re, spec.fid.im, win, dt, f), m = v.re * v.re + v.im * v.im;
                    if (m > bestM) { bestM = m; bestF = f; }
                }
                fc = bestF; span /= 10;
            }
            const v = dftAt(spec.fid.re, spec.fid.im, win, dt, fc);
            ph0 = -(atan2(v.im, v.re) * 180 / PI + ph1 * fc / 1000);
            ph0 = ((ph0 % 360) + 540) % 360 - 180;           // wrap to (-180, 180]
        }
        applyPhase(total, hz, ph0, ph1);
        for (const c of comps) applyPhase(c, hz, ph0, ph1);
        const mag = new Float64Array(N);
        for (let k = 0; k < N; k++) mag[k] = Math.hypot(total.re[k], total.im[k]);

        // Metrics on the real (absorption) spectrum.
        // With the noise switched off (and no spike or zipper) an SNR is meaningless: report null.
        const sd = noiseSd(total.re, zf);
        const noisy = sd > 0 && spec.noiseSigma !== 0;
        const peaks = PEAKS.map(function (P) {
            const pk = windowPeak(total.re, ppm, P.lo, P.hi, step);
            return { id: P.id, name: P.name, nominalPpm: P.ppm, ppm: pk ? pk.ppm : null, height: pk ? pk.height : null,
                area: pk ? pk.area : null, baseline: pk ? pk.baseline : null, snr: pk && noisy ? pk.height / sd : null };
        });
        const hasNAA = comps.some(function (c) { return c.id === 'NAA'; });
        let kTall = 0;
        for (let k = 1; k < N; k++) if (total.re[k] > total.re[kTall]) kTall = k;
        const naa = hasNAA ? windowPeak(total.re, ppm, RATIO_WIN.NAA[0], RATIO_WIN.NAA[1], step) : null;
        const sigHeight = naa ? naa.height : total.re[kTall];

        function ratios(get) {
            const iN = get('NAA'), iCr = get('Cr'), iCho = get('Cho');
            return { NAA_Cr: iCr > 0 ? iN / iCr : null, Cho_Cr: iCr > 0 ? iCho / iCr : null };
        }
        const winArea = function (y, id) { const w = windowPeak(y, ppm, RATIO_WIN[id][0], RATIO_WIN[id][1], step); return w ? w.area : 0; };
        const ratioTotal = ratios(function (id) { return winArea(total.re, id); });
        // The same integrals on each metabolite's own noise-free spectrum: what
        // the ratio would be without overlap (glutamate sits under NAA at 2.04).
        const byId = {};
        for (const c of comps) byId[c.id] = c;
        const ratioComp = ratios(function (id) { return byId[id] ? winArea(byId[id].re, id) : 0; });

        return {
            n: N, hz: hz, ppm: ppm,                // ascending frequency, so ppm ascends with index
            re: total.re, im: total.im, mag: mag,
            components: comps,
            peaks: peaks,
            metrics: {
                snr: noisy ? sigHeight / sd : null,
                snrPeak: naa ? 'NAA' : 'tallest',
                noiseSd: sd,
                fwhmHz: fwhmAt(total.re, kTall, step),
                tallestPpm: ppm[kTall],
                ratios: ratioTotal,
                componentRatios: ratioComp
            },
            phase: { ph0: ph0, ph1: ph1, auto: !!p.autoPhase },
            params: p
        };
    }

    MRI.spectro = {
        simulate: simulate,
        process: process,
        defaults: defaults,
        waterLine: waterLine,
        NOISE_REF: NOISE_REF,
        peakWindows: PEAKS.map(function (P) { return Object.assign({}, P); }),
        ratioWindows: JSON.parse(JSON.stringify(RATIO_WIN)),
        broadeningHz: broadeningHz
    };

})(typeof window !== 'undefined' ? window : globalThis);
