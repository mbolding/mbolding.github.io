/* ============================================================
   PET Simulator, acquisition engine
   Turns a compiled protocol, a phantom and its time-activity curves
   into the data a scanner records: for every frame, the prompt
   sinogram (trues + scatter + randoms with Poisson noise), the
   delayed-window randoms, and what the scanner needs to correct it
   (normalisation, attenuation correction factors from a mu map,
   a singles-based randoms estimate and a tail-fitted scatter
   estimate). See ARCHITECTURE.md section 8.

   Every degradation comes from its mechanism and has its own switch
   in ctx.physics: attenuation from line integrals of the true mu
   map, scatter from the photons attenuation removed, randoms from
   the singles rate and the coincidence window, noise from Poisson
   statistics of the expected counts, positron range from the
   isotope's range kernel, motion from moving the object (emission
   and mu map together) during the scan.

   Units: s, mm, Bq, Bq/mL, keV, 1/mm. No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;
    const SC = PET.scanner;
    const G = SC.geom;
    // A local binding: looking up a global on every call is slow in some
    // hosts (Node's vm sandbox used by the tests is ten times slower), and
    // the inner loops here call Math millions of times.
    const Math = root.Math;

    /* ---------- calibration ----------
       The physics fixes the shape of everything; these few numbers fix
       the scale. They were tuned on a synthetic head (150 x 190 mm
       ellipse, 6 mm skull, 10 kBq/mL in the brain, 18F, 185 MBq, 70 kg,
       frame 45 to 55 min, 435 to 650 keV, 4.5 ns, 3D) so that it gives
       about 2 M trues in the slice, a scatter fraction of about 0.33 and
       randoms/trues of about 0.25, as the fdg_static preset should.
       Achieved: head 2.0 M trues, SF 0.33, R/T 0.25 (0.13 with TOF);
       200 mm water cylinder SF 0.34; 2D mode SF 0.15, trues x 0.2,
       randoms x 0.16; line sources in air SF 0. The real brain phantom
       with the fdg_static preset gives about 1.9 M trues, SF 0.34,
       R/T 0.26. (SF is kept a little under 0.35 so that 2D, which only
       multiplies scatter by 0.35, lands at 0.15 or below.) */
    const CAL = {
        // Fraction of positron annihilations in the imaged slice that are
        // detected as a coincidence (both photons reach crystals and stop
        // in them), before the energy window and attenuation. It is the
        // axial solid-angle acceptance of a 3D scanner times the crystal
        // detection efficiency squared, a few per cent on a real scanner.
        SENS: 0.0275,
        // Scatter: once-scattered photons per attenuated photon pair that
        // still reach the ring, before the energy window (dimensionless).
        SCATTER: 0.62,
        SCATTER_SIGMA_R: 70,        // mm, radial width of the scatter kernel
        SCATTER_SIGMA_A: 2,         // angle bins (0.94 deg each), light smoothing across angles
        SCATTER_SIGMA_TOF: 80,      // mm, extra spread of scatter along the LOR (TOF)
        // Randoms: rate = RANDOMS * tau * A_s^2, with A_s the activity that
        // produces singles (Bq). Equivalent to 2 tau S1 S2 with the singles
        // efficiency and the share of randoms that fall in this slice
        // folded in (dimensionless).
        RANDOMS: 4.9e-5,
        // Singles pass the energy window as unscattered photons (photopeak
        // acceptance) or as photons that scattered in the body on the way
        // out (scatter acceptance); this weights the second kind. Used to
        // make randoms respond to the energy window, relative to 435 keV.
        SINGLES_SCATTER: 1.0,
        // 2D mode (septa in): fewer oblique LORs, much less scatter and far
        // fewer singles. sens multiplies trues, scatter multiplies scatter
        // relative to trues, singles multiplies the singles rate (so the
        // randoms rate falls by singles^2 = 0.16).
        MODE_2D: { sens: 0.2, scatter: 0.35, singles: 0.4 },
        TAIL_ACF: 1.03,             // LORs with acf below this miss the object (scatter tail fit)
        TAIL_MARGIN: 6,             // mm kept clear of the object edge, so blurred trues do not leak into the tails
        // Upper bound on the tail-fit scale. Above about 1 something other
        // than scatter sits in the tails (activity the mu map does not
        // cover, such as nearly transparent line sources in air, or a moved
        // patient); scanners cap the scale for the same reason.
        TAIL_SCALE_MAX: 3,
        DRIFT_PARTS: 8,             // drift motion: the scan is split into this many poses
        PERIODIC_BINS: 12,          // periodic motion: phase bins per cycle
        NORM_SEED: 4242,            // crystal efficiencies are a property of the scanner, not of the scan seed
        YIELD_MS: 30                // yield to the event loop about this often
    };
    const MODE_3D = { sens: 1, scatter: 1, singles: 1 };

    function physicsDefaults() {
        return {
            attenuation: true, scatter: true, randoms: true, noise: true,
            positronRange: true, detectorBlur: true,
            motion: { on: false, kind: 'step', dx: 6, dy: 0, rot: 0, at: 0.5, period: 5 },
            muMap: { dx: 0, dy: 0, rot: 0, model: 'ct' },
            detector: { variation: 0.06, deadBlock: -1 },
            seed: 1
        };
    }
    function mergeDeep(base, patch) {
        if (!patch || typeof patch !== 'object') return base;
        Object.keys(patch).forEach(function (k) {
            const v = patch[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') mergeDeep(base[k], v);
            else if (v !== undefined) base[k] = v;
        });
        return base;
    }

    /* ---------- time integrals of the curves ----------
       J_m(u) = integral from 0 to u of v^m exp(-mu v) dv, m = 0, 1, 2.
       A series for small mu*u avoids cancellation. */
    function expMoments(mu, u) {
        const x = mu * u;
        if (x < 0.02) {
            return [u * (1 - x / 2 + x * x / 6 - x * x * x / 24),
                u * u * (0.5 - x / 3 + x * x / 8 - x * x * x / 30),
                u * u * u * (1 / 3 - x / 4 + x * x / 10 - x * x * x / 36)];
        }
        const E = Math.exp(-x);
        return [(1 - E) / mu, (1 - E * (1 + x)) / (mu * mu), (2 - E * (x * x + 2 * x + 2)) / (mu * mu * mu)];
    }
    /* Exact integral of c(t)^p exp(-mu t) for a curve c sampled on the
       uniform grid tg and linear between samples (p = 1 or 2). The curve
       is zero before its first sample and before injection (t = 0), and
       holds its last value after the end. Returns fn(ta, tb). */
    function curveIntegrator(tg, values, mu, p) {
        const N = Math.min(tg.length, values.length);
        if (!N) return function () { return 0; };
        const t0 = tg[0], dt = N > 1 ? (tg[N - 1] - tg[0]) / (N - 1) : 1, tl = t0 + (N - 1) * dt;
        const cum = new Float64Array(N), J = expMoments(mu, dt);
        for (let k = 0; k < N - 1; k++) {
            const c = values[k], s = (values[k + 1] - c) / dt, e = Math.exp(-mu * (t0 + k * dt));
            cum[k + 1] = cum[k] + e * (p === 2 ? c * c * J[0] + 2 * c * s * J[1] + s * s * J[2] : c * J[0] + s * J[1]);
        }
        const cl = values[N - 1], el = Math.exp(-mu * tl);
        function F(t) {
            if (t <= t0) return 0;
            if (t >= tl) return cum[N - 1] + el * (p === 2 ? cl * cl : cl) * expMoments(mu, t - tl)[0];
            let k = Math.floor((t - t0) / dt); if (k > N - 2) k = N - 2;
            const tk = t0 + k * dt, c = values[k], s = (values[k + 1] - c) / dt, Jm = expMoments(mu, t - tk), e = Math.exp(-mu * tk);
            return cum[k] + e * (p === 2 ? c * c * Jm[0] + 2 * c * s * Jm[1] + s * s * Jm[2] : c * Jm[0] + s * Jm[1]);
        }
        return function (ta, tb) { return F(Math.max(tb, 0)) - F(Math.max(ta, 0)); };
    }

    /* ---------- emission components ----------
       Projection is the expensive step (50 to 110 ms for a 256 raster), so
       the engine projects as few rasters as it can. Regions whose curves
       are proportional (every region of a solution phantom; gray-matter
       lobes that share kinetic parameters) are merged into one component:
       a raster of relative weights with one time course. Every frame is
       then a weighted sum of component rasters, and because positron
       range, motion and projection are all linear, so is its sinogram. */
    function regionPixels(phantom) {
        const cnt = new Float64Array(phantom.regions.length), lab = phantom.label;
        for (let p = 0; p < lab.length; p++) if (lab[p] < cnt.length) cnt[lab[p]]++;
        return cnt;
    }
    function buildComponents(phantom, tacs, pix) {
        const R = phantom.regions.length, comp = new Int32Array(R).fill(-1), w = new Float64Array(R), groups = [];
        for (let r = 0; r < R; r++) {
            const c = tacs.regions[r];
            if (!c || !pix[r]) continue;
            let m = 0, km = 0;
            for (let k = 0; k < c.length; k++) if (Math.abs(c[k]) > m) { m = Math.abs(c[k]); km = k; }
            if (!(m > 0)) continue;
            let found = -1;
            for (let g = 0; g < groups.length && found < 0; g++) {
                const rep = groups[g].curve, f = c[groups[g].k] / rep[groups[g].k];
                if (!(f > 0) || rep.length !== c.length) continue;
                let same = true;
                for (let k = 0; k < c.length; k++) if (Math.abs(c[k] - f * rep[k]) > 1e-6 * m) { same = false; break; }
                if (same) { found = g; w[r] = f; }
            }
            if (found < 0) { groups.push({ curve: c, k: km, rep: r }); found = groups.length - 1; w[r] = 1; }
            comp[r] = found;
        }
        return { groups: groups, comp: comp, w: w };
    }
    /* The image-space part of the resolution: positron range (if on) and the
       isotropic part of the detector response (geom.detIsoFwhm; the radial
       remainder and parallax are applied in the sinogram). With the detector
       blur off, a one-raster-pixel blur still band-limits the raster so the
       2 mm radial bins do not alias it. */
    function imageKernel(phantom, iso, positronRange, detectorBlur) {
        const det = SC.isoKernel(phantom.dx, detectorBlur ? G.detIsoFwhm : phantom.dx);
        return positronRange ? SC.combineKernels(det, PET.isotopes.rangeKernel(iso, phantom.dx)) : det;
    }
    function componentRasters(phantom, C, iso, positronRange, detectorBlur) {
        const n = phantom.n, lab = phantom.label, out = [];
        const k = imageKernel(phantom, iso, positronRange, detectorBlur);
        for (let g = 0; g < C.groups.length; g++) {
            let img = new Float32Array(n * n);
            for (let p = 0; p < lab.length; p++) { const r = lab[p]; if (C.comp[r] === g) img[p] = C.w[r]; }
            img = U.convolve2D(img, n, n, k.kernel, k.size);
            out.push(img);
        }
        return out;
    }

    /* ---------- sinogram helpers ----------
       Each works on the angle rows [a0, a1) and writes into an output
       array the caller owns (fresh, zero-filled), so a long job can be cut
       into chunks with a yield to the event loop in between. */
    const NLOR = G.nA * G.nR;

    function boxPass(src, dst, L, h, inv) {
        let s = 0;
        for (let j = 0; j <= h && j < L; j++) s += src[j];
        for (let i = 0; i < L; i++) {
            dst[i] = s * inv;
            const add = i + h + 1, rem = i - h;
            if (add < L) s += src[add];
            if (rem >= 0) s -= src[rem];
        }
    }
    /* Smooth every (angle, TOF bin) row along r with a Gaussian of sigma
       sigmaBins, built from three box passes (a close and much cheaper
       approximation). The row is padded so nothing is clipped on the
       way: whatever spreads beyond the sinogram edge is lost, as scatter
       that misses the ring would be. */
    function smoothRadial(src, out, nT, sigmaBins, a0, a1) {
        const nR = G.nR;
        const h = Math.max(1, Math.round((Math.sqrt(4 * sigmaBins * sigmaBins + 1) - 1) / 2));
        const pad = 3 * h, L = nR + 2 * pad, inv = 1 / (2 * h + 1);
        const b1 = new Float64Array(L), b2 = new Float64Array(L);
        for (let a = a0; a < a1; a++) for (let t = 0; t < nT; t++) {
            const base = a * nR * nT + t;
            let any = false;
            for (let i = 0; i < nR; i++) { const v = src[base + i * nT]; b1[pad + i] = v; if (v !== 0) any = true; }
            if (!any) continue;
            for (let i = 0; i < pad; i++) { b1[i] = 0; b1[L - 1 - i] = 0; }
            boxPass(b1, b2, L, h, inv); boxPass(b2, b1, L, h, inv); boxPass(b1, b2, L, h, inv);
            for (let i = 0; i < nR; i++) out[base + i * nT] = b2[pad + i];
        }
    }
    /* Light Gaussian smoothing across angles. Angle row -1 is row nA-1
       seen from the other side: theta + pi is the same line with r -> -r
       (and s -> -s for TOF), so the wrap flips r and the TOF bins. Reads
       every row of src, writes rows [a0, a1) of out. */
    const angleKernels = {};
    function smoothAngles(src, out, nT, sigma, a0, a1) {
        const nA = G.nA, nR = G.nR, M = Math.ceil(3 * sigma);
        let g = angleKernels[sigma];
        if (!g) {
            g = new Float64Array(2 * M + 1);
            let sum = 0;
            for (let m = -M; m <= M; m++) { g[m + M] = Math.exp(-0.5 * (m / sigma) * (m / sigma)); sum += g[m + M]; }
            for (let m = 0; m < g.length; m++) g[m] /= sum;
            angleKernels[sigma] = g;
        }
        const row = nR * nT;
        for (let a = a0; a < a1; a++) {
            const ob = a * row;
            for (let m = -M; m <= M; m++) {
                let b = a + m, flip = false;
                if (b < 0) { b += nA; flip = true; } else if (b >= nA) { b -= nA; flip = true; }
                const w = g[m + M], sb = b * row;
                if (!flip) { for (let q = 0; q < row; q++) out[ob + q] += w * src[sb + q]; }
                else {
                    for (let i = 1; i < nR; i++) {
                        const oi = ob + i * nT, si = sb + (nR - i) * nT;
                        for (let t = 0; t < nT; t++) out[oi + t] += w * src[si + nT - 1 - t];
                    }
                }
            }
        }
    }
    /* Spread every LOR's TOF profile with a Gaussian along the LOR; each
       source bin's weights are renormalised over the bins that exist so
       the LOR's total is kept. */
    const tofConvCache = {};
    function convTOF(src, out, nT, sigmaBins, a0, a1) {
        const key = nT + ':' + sigmaBins;
        let W = tofConvCache[key];
        if (!W) {
            W = new Float64Array(nT * nT);
            for (let k = 0; k < nT; k++) {
                let s = 0;
                for (let q = 0; q < nT; q++) { const v = Math.exp(-0.5 * ((q - k) / sigmaBins) * ((q - k) / sigmaBins)); W[k * nT + q] = v; s += v; }
                for (let q = 0; q < nT; q++) W[k * nT + q] /= s;
            }
            tofConvCache[key] = W;
        }
        for (let l = a0 * G.nR; l < a1 * G.nR; l++) {
            const b = l * nT;
            for (let k = 0; k < nT; k++) {
                const v = src[b + k]; if (v === 0) continue;
                const wk = k * nT;
                for (let q = 0; q < nT; q++) out[b + q] += v * W[wk + q];
            }
        }
    }
    /* Detector blur of rows [a0, a1): the same Gaussian along r, with a
       FWHM that grows off centre (parallax), as PET.scanner.blurRadial,
       using its matrix so the two can never disagree. */
    function blurRows(src, out, nT, a0, a1) {
        const M = SC.blurMatrix(G.detRadialFwhm0, G.parallaxFwhm), nR = G.nR;
        for (let a = a0; a < a1; a++) {
            const rb = a * nR;
            for (let j = 0; j < nR; j++) {
                const ww = M.w[j], i0 = M.lo[j], sb = (rb + j) * nT;
                for (let t = 0; t < nT; t++) {
                    const v = src[sb + t];
                    if (v === 0) continue;
                    for (let q = 0; q < ww.length; q++) out[(rb + i0 + q) * nT + t] += v * ww[q];
                }
            }
        }
    }
    /* Add rows [a0, a1) of a (possibly TOF) sinogram, summed over TOF
       bins, into dst (nA*nR). */
    function addSumTOF(dst, src, nT, a0, a1) {
        const l0 = (a0 || 0) * G.nR, l1 = (a1 === undefined ? G.nA : a1) * G.nR;
        if (nT === 1) { for (let l = l0; l < l1; l++) dst[l] += src[l]; return; }
        for (let l = l0; l < l1; l++) { let s = 0; const b = l * nT; for (let t = 0; t < nT; t++) s += src[b + t]; dst[l] += s; }
    }

    /* Event-by-event LOR repositioning with perfect tracking, applied to
       a whole sinogram: an event recorded while the object sat at pose
       (dx, dy, rot) is moved to the LOR it would have had at the
       reference pose. The pose maps p_ref to R(rot) p_ref + d, so the
       reference LOR has theta' = theta - rot, r' = r - (dx cos theta +
       dy sin theta) and s' = s - (-dx sin theta + dy cos theta). Counts
       are split between the neighbouring bins by linear interpolation
       (angle, r and TOF), so they are conserved except at the edges.
       Moves the source rows [a0, a1) and accumulates into out. */
    function reposition(src, pose, nT, out, a0, a1) {
        const nA = G.nA, nR = G.nR, dA = Math.PI / nA, rot = pose.rot * Math.PI / 180, kMid = Math.floor(G.nT / 2);
        if (a0 === undefined) { a0 = 0; a1 = nA; }
        for (let a = a0; a < a1; a++) {
            const th = a * dA, c = Math.cos(th), s = Math.sin(th);
            const dr = pose.dx * c + pose.dy * s, dsL = -pose.dx * s + pose.dy * c;
            // theta' in [0, pi); each half turn swaps the ends of the line (r -> -r, s -> -s)
            let tp = th - rot;
            const m = Math.floor(tp / Math.PI);
            tp -= m * Math.PI;
            const f0 = (m % 2 === 0) ? 1 : -1;
            const fa = tp / dA, a0r = Math.min(nA - 1, Math.floor(fa)), wa = U.clamp(fa - a0r, 0, 1);
            // two target rows: a0r and a0r + 1 (row nA is row 0 seen from the other side)
            const rows = [a0r, a0r + 1], wRow = [1 - wa, wa], flips = [f0, f0];
            if (rows[1] >= nA) { rows[1] -= nA; flips[1] = -f0; }
            for (let q = 0; q < 2; q++) {
                const wq = wRow[q]; if (wq < 1e-9) continue;
                const ta = rows[q], fl = flips[q], tb = ta * nR;
                for (let i = 0; i < nR; i++) {
                    const sb = (a * nR + i) * nT;
                    const rr = fl * (G.radius(i) - dr);
                    const fi = rr / G.dr + nR / 2, i0 = Math.floor(fi), wi = fi - i0;
                    if (i0 < -1 || i0 >= nR) continue;
                    for (let t = 0; t < nT; t++) {
                        const v = src[sb + t]; if (v === 0) continue;
                        const vw = v * wq;
                        if (nT === 1) {
                            if (i0 >= 0) out[tb + i0] += vw * (1 - wi);
                            if (i0 + 1 < nR) out[tb + i0 + 1] += vw * wi;
                        } else {
                            const ss = fl * (G.tofCentre(t) - dsL), fk = ss / G.ds + kMid, k0 = Math.floor(fk), wk = fk - k0;
                            if (k0 < -1 || k0 >= nT) continue;
                            if (i0 >= 0) {
                                const o = (tb + i0) * nT;
                                if (k0 >= 0) out[o + k0] += vw * (1 - wi) * (1 - wk);
                                if (k0 + 1 < nT) out[o + k0 + 1] += vw * (1 - wi) * wk;
                            }
                            if (i0 + 1 < nR) {
                                const o = (tb + i0 + 1) * nT;
                                if (k0 >= 0) out[o + k0] += vw * wi * (1 - wk);
                                if (k0 + 1 < nT) out[o + k0 + 1] += vw * wi * wk;
                            }
                        }
                    }
                }
            }
        }
        return out;
    }

    /* ---------- caches shared between scans ----------
       Re-scans after a physics change usually keep the phantom, so its
       attenuation factors (per pose) and the projectors are reused. */
    const projCache = new Map();
    function emissionProjector(n, fov, tofOn, sigma, tau, ctr) {
        const key = [n, fov, tofOn ? sigma.toFixed(4) : 0, tau, ctr].join(':');
        let P = projCache.get(key);
        if (!P) {
            // sWeight: the chance that a true coincidence from position s
            // along the LOR arrives inside the coincidence window.
            P = SC.projector({ n: n, fov: fov, tof: tofOn ? { sigma: sigma } : null,
                sWeight: function (s) { return SC.timing.trueAcceptance(s, tau, ctr); } });
            if (projCache.size >= 6) projCache.delete(projCache.keys().next().value);
            projCache.set(key, P);
        }
        return P;
    }
    const attCache = new WeakMap();
    function muCacheFor(mu) {
        let m = attCache.get(mu);
        if (!m) { m = new Map(); attCache.set(mu, m); }
        if (m.size > 32) m.clear();
        return m;
    }
    const normCache = new Map();
    function normFor(variation, deadBlock) {
        const key = variation + ':' + deadBlock;
        let nm = normCache.get(key);
        if (!nm) {
            nm = SC.normalization({ variation: variation, deadBlock: deadBlock, seed: CAL.NORM_SEED });
            if (normCache.size > 8) normCache.clear();
            normCache.set(key, nm);
        }
        return nm;
    }
    const chunkCache = {};
    function angleChunks(per) {
        if (chunkCache[per]) return chunkCache[per];
        const out = [];
        for (let a0 = 0; a0 < G.nA; a0 += per) {
            const list = [];
            for (let a = a0; a < Math.min(G.nA, a0 + per); a++) list.push(a);
            out.push(Int32Array.from(list));
        }
        return (chunkCache[per] = out);
    }

    function poseKey(p) {
        return [p.dx, p.dy, p.rot].map(function (v) { const q = Math.round(v * 1e4); return q === 0 ? 0 : q; }).join(',');
    }
    const POSE0 = { dx: 0, dy: 0, rot: 0 };
    const KEY0 = poseKey(POSE0);
    function isPose0(p) { return poseKey(p) === KEY0; }

    /* Seeds for the independent noise streams of each frame and
       sub-interval, so changing one frame never reshuffles another. */
    function streamSeed(seed, a, b, c) {
        let h = (seed >>> 0) ^ 0x9e3779b9;
        h = Math.imul(h ^ (a + 0x632be5ab), 0x85ebca6b) >>> 0;
        h = Math.imul(h ^ (b + 0x1b873593), 0xc2b2ae35) >>> 0;
        h = Math.imul(h ^ (c + 0x7feb352d), 0x846ca68b) >>> 0;
        return (h ^ (h >>> 16)) >>> 0;
    }

    /* Seeded Poisson sampling over whole arrays: the mulberry32 generator
       of PET.util.rng, inlined because a TOF sinogram has half a million
       bins per frame. Means below 30 use inversion (walk up the cumulative
       distribution from 0, one uniform per sample); larger means a rounded
       normal, as PET.util.poisson does, which no image can tell apart. */
    function poissonSampler(seed) {
        let s = (seed >>> 0) || 0x9e3779b9;
        function next() {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
        return function (mean, out, k0, k1) {
            for (let k = k0; k < k1; k++) {
                const mu = mean[k];
                if (!(mu > 0)) { out[k] = 0; continue; }
                if (mu < 30) {
                    const u = next();
                    let p = Math.exp(-mu), F = p, x = 0;
                    while (u > F && x < 200) { x++; p *= mu / x; F += p; }
                    out[k] = x;
                } else {
                    let u1 = next(); if (u1 < 1e-12) u1 = 1e-12;
                    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * next());
                    const v = Math.round(mu + Math.sqrt(mu) * z);
                    out[k] = v < 0 ? 0 : v;
                }
            }
        };
    }

    /* Acceptance of the energy window for singles: unscattered photons
       plus photons that scattered in the body on the way out. */
    function singlesAcceptance(lo, hi) {
        return SC.energy.photopeakAcceptance(lo, hi) + CAL.SINGLES_SCATTER * SC.energy.scatterAcceptance(lo, hi);
    }

    /* ---------- motion ----------
       The object pose is a function of time over the whole scan; each
       frame is cut into sub-intervals over which it is (nearly) constant.
       A sub-interval is { pose, pieces: [[ta, tb]], share }: its decays
       are share times the decays in its pieces. */
    function motionPose(mo, frac) { return { dx: mo.dx * frac, dy: mo.dy * frac, rot: mo.rot * frac }; }
    function subIntervals(t0, t1, mo, motionOn, scanStart, scanEnd) {
        if (!motionOn) return [{ pose: POSE0, pieces: [[t0, t1]], share: 1 }];
        const span = scanEnd - scanStart;
        if (mo.kind === 'drift') {
            // The scan is cut into DRIFT_PARTS equal parts with the pose of
            // each part's middle, and every frame is split at those cuts.
            // (Per-scan parts rather than per-frame keep the number of
            // distinct poses, and so of projections, small.)
            const P = CAL.DRIFT_PARTS, out = [];
            for (let q = 0; q < P; q++) {
                // the first and last parts reach out to cover anything outside the scan
                const a = q === 0 ? -Infinity : scanStart + span * q / P;
                const b = q === P - 1 ? Infinity : scanStart + span * (q + 1) / P;
                const ta = Math.max(a, t0), tb = Math.min(b, t1);
                if (tb > ta) out.push({ pose: motionPose(mo, (q + 0.5) / P), pieces: [[ta, tb]], share: 1 });
            }
            return out;
        }
        if (mo.kind === 'periodic') {
            const period = mo.period > 0 ? mo.period : 5, B = CAL.PERIODIC_BINS, bins = [];
            for (let j = 0; j < B; j++) bins.push({ pose: motionPose(mo, Math.sin(2 * Math.PI * (j + 0.5) / B)), pieces: [], share: 1 });
            if ((t1 - t0) / period > 50) {
                // many cycles in the frame: every phase gets an equal share
                for (let j = 0; j < B; j++) { bins[j].pieces.push([t0, t1]); bins[j].share = 1 / B; }
            } else {
                let t = t0;
                while (t < t1) {
                    const ph = (t - scanStart) / period * B;
                    let j = Math.floor(ph + 1e-9);
                    const next = Math.min(t1, scanStart + (j + 1) * period / B);
                    j = ((j % B) + B) % B;
                    if (next > t) bins[j].pieces.push([t, next]);
                    t = next > t ? next : t1;
                }
            }
            // phase bins with the same pose (sin is symmetric) share one sub-interval
            const merged = new Map();
            bins.forEach(function (b) {
                if (!b.pieces.length) return;
                const k = poseKey(b.pose);
                const m = merged.get(k);
                if (!m) merged.set(k, { pose: b.pose, parts: [b] });
                else m.parts.push(b);
            });
            return Array.from(merged.values()).map(function (m) { return { pose: m.pose, parts: m.parts }; });
        }
        // step: the pose jumps from the reference to the full pose at fraction `at`
        const tj = scanStart + span * U.clamp(mo.at === undefined ? 0.5 : mo.at, 0, 1);
        const full = motionPose(mo, 1);
        if (tj <= t0) return [{ pose: full, pieces: [[t0, t1]], share: 1 }];
        if (tj >= t1) return [{ pose: POSE0, pieces: [[t0, t1]], share: 1 }];
        return [{ pose: POSE0, pieces: [[t0, tj]], share: 1 }, { pose: full, pieces: [[tj, t1]], share: 1 }];
    }
    /* Integrate fn over a sub-interval (pieces times share, or several parts). */
    function subIntegral(sub, fn) {
        const parts = sub.parts || [sub];
        let s = 0;
        for (let q = 0; q < parts.length; q++) {
            let v = 0;
            for (let k = 0; k < parts[q].pieces.length; k++) v += fn(parts[q].pieces[k][0], parts[q].pieces[k][1]);
            s += v * parts[q].share;
        }
        return s;
    }

    /* ---------- the simulation ---------- */
    async function simulate(program, phantom, tacs, ctx, opts) {
        const tStart = Date.now();
        opts = opts || {};
        if (!program || program.ok === false) throw new Error('The protocol has errors, so there is nothing to acquire.');
        if (!phantom || !phantom.label || !phantom.mu || !phantom.regions) throw new Error('No phantom to scan.');
        if (!tacs || !tacs.t || !tacs.regions) throw new Error('No time-activity curves for this phantom.');
        if (!program.frames || !program.frames.length) throw new Error('The protocol never acquires anything: add a static or frames line.');
        const physics = mergeDeep(physicsDefaults(), JSON.parse(JSON.stringify((ctx && ctx.physics) || {})));
        const warnings = [];

        // progress and yielding
        let lastYield = Date.now(), done = 0, total = 1;
        const shouldAbort = opts.shouldAbort, onProgress = opts.onProgress;
        async function tick(units) {
            done += units || 0;
            if (Date.now() - lastYield < CAL.YIELD_MS) return;
            if (onProgress) onProgress(Math.min(0.99, done / total));
            await U.yieldFrame();
            lastYield = Date.now();
            if (shouldAbort && shouldAbort()) throw new Error('aborted');
        }
        if (shouldAbort && shouldAbort()) throw new Error('aborted');

        // isotope, windows, geometry
        const iso = PET.isotopes.get(program.isotope || 'F18');
        const lambda = PET.isotopes.lambda(iso), betaPlus = iso.betaPlus;
        const n = phantom.n, fov = phantom.fov || G.fov, dx = phantom.dx || fov / n;
        const nA = G.nA, nR = G.nR;
        const tofOn = !!(program.tof && program.tof.on);
        const ctr = (program.tof && program.tof.ctr) || G.ctrDefault;
        const tau = program.coincidence || 4.5e-9;
        const nT = tofOn ? G.nT : 1, size = NLOR * nT;
        const sigmaTOF = SC.timing.sigmaPos(ctr);
        const lo = program.energy ? program.energy.lo : 435, hi = program.energy ? program.energy.hi : 650;
        const epsE = SC.energy.photopeakAcceptance(lo, hi), epsS = SC.energy.scatterAcceptance(lo, hi);
        const mode = program.acqMode === '2D' ? CAL.MODE_2D : MODE_3D;

        /* kappa0: expected trues per (decay per mL) x mm of line integral.
           A decay in the slice sends its photon pair along a random
           direction; the in-plane angle falls in one of nA angle bins
           (share 1/nA), and the decays that feed radial bin i are those in
           a strip dr wide and sliceThickness deep along the LOR, whose
           volume is dr * thickness * length / 1000 mL. CAL.SENS is the
           chance such a pair is detected, and both photons must pass the
           energy window (epsE squared). */
        const geomFactor = G.sliceThickness * G.dr / (1000 * nA);
        const kappa0 = CAL.SENS * mode.sens * epsE * epsE * geomFactor;
        // Scatter keeps one photopeak photon and one scattered photon.
        const cScatter = kappa0 * CAL.SCATTER * mode.scatter * (epsS / epsE);
        const eSingle = singlesAcceptance(lo, hi) / singlesAcceptance(435, 650);
        const cRandoms = CAL.RANDOMS * mode.singles * mode.singles * eSingle * eSingle * tau;
        const tofR = tofOn ? SC.timing.randomsTofFraction(tau, G.ds, G.nT) : { perBin: 1, inside: 1 };

        // the scanner
        const nm = normFor(physics.detector.variation, physics.detector.deadBlock);
        const norm = nm.bins;
        const P = emissionProjector(n, fov, tofOn, sigmaTOF, tau, ctr);
        const P0 = SC.plainProjector(n, fov);
        const projUnit = tofOn ? 2 : 1;

        // curves
        const R = phantom.regions.length, tg = tacs.t;
        if (tacs.regions.length !== R) warnings.push('The time-activity curves do not match the phantom regions; missing regions are taken as empty.');
        const pix = regionPixels(phantom);
        const integ = [];
        for (let r = 0; r < R; r++) integ.push(tacs.regions[r] ? curveIntegrator(tg, tacs.regions[r], lambda, 1) : null);
        // Singles-producing activity (decay corrected, Bq): every region over its
        // whole axial extent, plus the part of the dose elsewhere in the body.
        const vol = phantom.regions.map(function (rg, r) {
            return isFinite(rg.volume) ? rg.volume : pix[r] * dx * dx * (phantom.axialLength || 0) / 1000;
        });
        const Bvals = new Float64Array(tg.length);
        const outside = (phantom.outsideFraction || 0) * (program.dose || 0);
        for (let k = 0; k < tg.length; k++) {
            let s = outside;
            for (let r = 0; r < R; r++) { const c = tacs.regions[r]; if (c && vol[r]) s += vol[r] * c[k]; }
            Bvals[k] = s;
        }
        const singlesSq = curveIntegrator(tg, Bvals, 2 * lambda, 2);
        const lastT = tg.length ? tg[tg.length - 1] : 0;

        // components and their rasters (positron range applied once here)
        const C = buildComponents(phantom, tacs, pix), nC = C.groups.length;
        const compInteg = C.groups.map(function (g) { return integ[g.rep]; });
        const compRaster = componentRasters(phantom, C, iso, physics.positronRange, physics.detectorBlur !== false);
        await tick(0);

        // motion plan
        const mo = physics.motion || {};
        const scanStart = program.scanStart !== undefined ? program.scanStart : program.frames[0].t0;
        const scanEnd = program.scanEnd !== undefined ? program.scanEnd : program.frames[program.frames.length - 1].t1;
        const motionOn = !!(mo.on && scanEnd > scanStart && (mo.dx || mo.dy || mo.rot));

        // frames and the work items (one per sub-interval, plus a reference-pose
        // projection for the scatter estimate when the frame moved)
        const frames = [], acc = [], items = [];
        let beforeInjection = 0;
        program.frames.forEach(function (fr, f) {
            const t0 = fr.t0, t1 = fr.t1, dur = t1 - t0;
            const DI = PET.isotopes.decayIntegral(iso, t0, t1);
            if (t1 <= 0) beforeInjection++;
            const subs = subIntervals(t0, t1, mo, motionOn, scanStart, scanEnd);
            const fItems = subs.map(function (sb, j) {
                const d = new Float64Array(nC);
                for (let c = 0; c < nC; c++) d[c] = betaPlus * subIntegral(sb, compInteg[c]);
                return { f: f, j: j, sub: true, est: false, pose: sb.pose, key: poseKey(sb.pose), d: d,
                    rInt: subIntegral(sb, singlesSq) };
            });
            if (fItems.length === 1 && fItems[0].key === KEY0) fItems[0].est = true;
            else {
                const d = new Float64Array(nC);
                fItems.forEach(function (it) { for (let c = 0; c < nC; c++) d[c] += it.d[c]; });
                fItems.push({ f: f, j: -1, sub: false, est: true, pose: POSE0, key: KEY0, d: d, rInt: 0 });
            }
            fItems.forEach(function (it) { let s = 0; for (let c = 0; c < nC; c++) s += it.d[c]; it.dSum = s; items.push(it); });
            frames.push({ index: f, t0: t0, t1: t1, dur: dur, decayIntegral: DI,
                kappa: kappa0 * betaPlus * DI, kappaNoDecay: kappa0 * betaPlus * dur });
            acc.push({
                prompts: new Float32Array(size), promptsMC: motionOn ? new Float32Array(size) : null,
                expT: new Float32Array(NLOR), expS: new Float32Array(NLOR), expR: new Float32Array(NLOR),
                rInt: 0, estRaw: null,
                poses: motionOn ? fItems.filter(function (it) { return it.sub; }).map(function (it) {
                    return { dx: it.pose.dx, dy: it.pose.dy, rot: it.pose.rot, share: 0 };
                }) : null
            });
        });
        if (beforeInjection) warnings.push(beforeInjection === 1 ? 'One frame ends before the injection, so it records nothing.' :
            beforeInjection + ' frames end before the injection, so they record nothing.');
        if (scanEnd > lastT + 1e-6 && tg.length) warnings.push('The time-activity curves stop at ' + U.fmtTime(lastT) + '; later times hold the last value.');

        // group the work by pose: every pose needs its own attenuation
        // factors, and its own projections of the emission
        const groups = new Map();
        items.forEach(function (it) {
            let g = groups.get(it.key);
            if (!g) { g = { pose: it.pose, items: [] }; groups.set(it.key, g); }
            g.items.push(it);
        });
        const needAttTrue = physics.attenuation || physics.scatter;
        groups.forEach(function (g) {
            const m = g.items.filter(function (it) { return it.dSum > 0; }).length;
            g.useBasis = m > nC;
            g.nProj = (g.useBasis ? nC : m) * projUnit + (needAttTrue && g.items.some(function (it) { return it.sub; }) ? 1 : 0);
        });
        total = 2;                  // setup, and the correction mu map's projection
        groups.forEach(function (g) { total += g.nProj + g.items.length * 0.4 * projUnit; });
        total += frames.length * 0.3 * projUnit;

        // Everything below works on chunks of angle rows (projections, sinogram
        // arithmetic, smoothing, noise), yielding in between, so the page
        // never freezes even when a whole dynamic study is being computed.
        const chunks = angleChunks(tofOn ? 8 : 24), ROWS = tofOn ? 12 : 48;
        async function byRows(fn) {
            for (let a0 = 0; a0 < nA; a0 += ROWS) { fn(a0, Math.min(nA, a0 + ROWS)); await tick(0); }
        }
        async function forward(Pj, img, unit) {
            const out = new Float32Array(Pj.size);
            for (let q = 0; q < chunks.length; q++) {
                Pj.forward(img, chunks[q], out);
                await tick(unit / chunks.length);
            }
            return out;
        }
        async function attenuationOf(mu) {
            const li = await forward(P0, mu, 1);
            for (let k = 0; k < li.length; k++) li[k] = Math.exp(-li[k]);
            return li;
        }
        const muCache = muCacheFor(phantom.mu);
        async function attTrueFor(pose) {
            const key = 'true:' + n + ':' + poseKey(pose);
            if (muCache.has(key)) { await tick(1); return muCache.get(key); }
            const mu = isPose0(pose) ? phantom.mu : U.transformImage(phantom.mu, n, dx, pose.dx, pose.dy, pose.rot);
            const a = await attenuationOf(mu);
            muCache.set(key, a);
            return a;
        }

        // the correction mu map: the true map at the reference pose, moved by
        // physics.muMap, with bone replaced by soft tissue for 'nobone'
        const mm = physics.muMap || {};
        const noBone = mm.model === 'nobone';
        const corrKey = 'corr:' + n + ':' + poseKey({ dx: mm.dx || 0, dy: mm.dy || 0, rot: mm.rot || 0 }) + ':' + (noBone ? 'nobone' : 'ct');
        let corr = muCache.get(corrKey);
        if (!corr) {
            let mu0 = phantom.mu;
            if (noBone) {
                const isBone = phantom.regions.map(function (rg) { return rg.tissue === 'bone'; });
                mu0 = Float32Array.from(phantom.mu);
                for (let p = 0; p < mu0.length; p++) if (isBone[phantom.label[p]]) mu0[p] = PET.const.MU_WATER;
            }
            const muCorr = (mm.dx || mm.dy || mm.rot) ? U.transformImage(mu0, n, dx, mm.dx || 0, mm.dy || 0, mm.rot || 0) : Float32Array.from(mu0);
            const a = await attenuationOf(muCorr);
            const acf = new Float32Array(NLOR);
            for (let l = 0; l < NLOR; l++) acf[l] = 1 / a[l];
            corr = { muCorr: muCorr, a: a, acf: acf };
            muCache.set(corrKey, corr);
        }
        const aligned = !noBone && !(mm.dx || mm.dy || mm.rot);

        /* Scatter model: the photons that attenuation removed from each LOR,
           L = P(1 - a) (unattenuated projection times the attenuated
           fraction), reappear once scattered, spread over neighbouring
           LORs by a broad kernel. With TOF each LOR's scatter follows its
           own (smoothed) emission profile along the LOR, spread further by
           a broad Gaussian. Scattered photons hit crystals too, so the
           normalisation applies. */
        async function scatterModel(proj, att) {
            const L = new Float32Array(size), Lr = new Float32Array(size);
            await byRows(function (a0, a1) {
                for (let l = a0 * nR; l < a1 * nR; l++) {
                    const f = 1 - att[l], b = l * nT;
                    if (f <= 0) continue;
                    for (let t = 0; t < nT; t++) L[b + t] = proj[b + t] * f;
                }
                smoothRadial(L, Lr, nT, CAL.SCATTER_SIGMA_R / G.dr, a0, a1);
            });
            let out = Lr;
            if (CAL.SCATTER_SIGMA_A > 0) {
                const La = new Float32Array(size);
                await byRows(function (a0, a1) { smoothAngles(Lr, La, nT, CAL.SCATTER_SIGMA_A, a0, a1); });
                out = La;
            }
            if (tofOn) {
                const Lt = new Float32Array(size), src = out;
                await byRows(function (a0, a1) { convTOF(src, Lt, nT, CAL.SCATTER_SIGMA_TOF / G.ds, a0, a1); });
                out = Lt;
            }
            const res = out;
            await byRows(function (a0, a1) {
                for (let l = a0 * nR; l < a1 * nR; l++) {
                    const f = cScatter * norm[l], b = l * nT;
                    for (let t = 0; t < nT; t++) res[b + t] *= f;
                }
            });
            return res;
        }

        async function poissonInto(seed, mean, out) {
            const gen = poissonSampler(seed), step = 65536;
            for (let k0 = 0; k0 < mean.length; k0 += step) {
                gen(mean, out, k0, Math.min(mean.length, k0 + step));
                await tick(0);
            }
            return out;
        }

        /* One sub-interval: trues, scatter and randoms at its pose, then
           Poisson noise, added into its frame. */
        async function processSub(it, proj, att) {
            const A = acc[it.f];
            // Trues: the projection (coincidence-window weighted) times the
            // attenuation of each LOR and kappa0, blurred by the detector,
            // then seen through the crystal efficiencies.
            const T0 = new Float32Array(size), blur = proj && physics.detectorBlur;
            const T = blur ? new Float32Array(size) : T0;
            if (proj) {
                const aOn = physics.attenuation && att;
                await byRows(function (a0, a1) {
                    for (let l = a0 * nR; l < a1 * nR; l++) {
                        const f = kappa0 * (aOn ? att[l] : 1), b = l * nT;
                        for (let t = 0; t < nT; t++) T0[b + t] = proj[b + t] * f;
                    }
                    if (blur) blurRows(T0, T, nT, a0, a1);
                    for (let l = a0 * nR; l < a1 * nR; l++) { const f = norm[l], b = l * nT; for (let t = 0; t < nT; t++) T[b + t] *= f; }
                    addSumTOF(A.expT, T, nT, a0, a1);
                });
            }
            let Ssc = null;
            if (proj && physics.scatter && att) {
                Ssc = await scatterModel(proj, att);
                if (it.est && aligned) A.estRaw = Ssc;
            }
            // Randoms: uniform over the LORs, seen through the crystal
            // efficiencies; with TOF only those inside the TOF bins are kept.
            A.rInt += it.rInt;
            const rl = physics.randoms ? cRandoms * it.rInt / NLOR : 0;
            await byRows(function (a0, a1) {
                if (Ssc) addSumTOF(A.expS, Ssc, nT, a0, a1);
                for (let l = a0 * nR; l < a1 * nR; l++) {
                    const rr = rl * norm[l], b = l * nT, rb = rr * tofR.perBin;
                    A.expR[l] += rr * tofR.inside;
                    if (Ssc) { for (let t = 0; t < nT; t++) T[b + t] += Ssc[b + t] + rb; }
                    else if (rb) { for (let t = 0; t < nT; t++) T[b + t] += rb; }
                }
            });
            // T now holds the expected prompts of this sub-interval
            let noisy = T;
            if (physics.noise) noisy = await poissonInto(streamSeed(physics.seed, it.f, it.j, 1), T, new Float32Array(size));
            const pr = A.prompts, mc = A.promptsMC;
            await byRows(function (a0, a1) {
                for (let k = a0 * nR * nT; k < a1 * nR * nT; k++) pr[k] += noisy[k];
                if (mc) reposition(noisy, it.pose, nT, mc, a0, a1);
            });
            if (A.poses) { const ps = A.poses[it.j]; if (ps) ps.share = it.dSum; }
        }

        // ---- run every pose group ----
        for (const g of groups.values()) {
            const hasSub = g.items.some(function (it) { return it.sub; });
            const att = (hasSub && needAttTrue) ? await attTrueFor(g.pose) : null;
            const moved = !isPose0(g.pose);
            let basis = null;
            if (g.useBasis) {
                basis = [];
                for (let c = 0; c < nC; c++) {
                    const img = moved ? U.transformImage(compRaster[c], n, dx, g.pose.dx, g.pose.dy, g.pose.rot) : compRaster[c];
                    basis.push(await forward(P, img, projUnit));
                }
            }
            for (const it of g.items) {
                let proj = null;
                if (it.dSum > 0) {
                    if (basis) {
                        const pj = proj = new Float32Array(size);
                        await byRows(function (a0, a1) {
                            for (let c = 0; c < nC; c++) {
                                const w = it.d[c], bc = basis[c];
                                if (w) for (let k = a0 * nR * nT; k < a1 * nR * nT; k++) pj[k] += w * bc[k];
                            }
                        });
                    } else {
                        let img = new Float32Array(n * n);
                        for (let c = 0; c < nC; c++) {
                            const w = it.d[c], rc = compRaster[c];
                            if (w) for (let p = 0; p < img.length; p++) img[p] += w * rc[p];
                        }
                        if (moved) img = U.transformImage(img, n, dx, g.pose.dx, g.pose.dy, g.pose.rot);
                        proj = await forward(P, img, projUnit);
                    }
                }
                if (it.sub) await processSub(it, proj, att);
                if (it.est && !acc[it.f].estRaw && proj) acc[it.f].estRaw = await scatterModel(proj, corr.a);
                await tick(0.4 * projUnit);
            }
        }

        // ---- per-frame corrections and bookkeeping ----
        // Tails: LORs that miss the object in the correction mu map, a
        // margin clear of its edge, on working detectors.
        const tail = new Uint8Array(NLOR), marg = Math.round(CAL.TAIL_MARGIN / G.dr);
        let nTail = 0;
        for (let a = 0; a < nA; a++) {
            for (let i = 0; i < nR; i++) {
                const l = a * nR + i;
                if (!(norm[l] > 0)) continue;
                let clear = true;
                for (let q = Math.max(0, i - marg); q <= Math.min(nR - 1, i + marg) && clear; q++) if (corr.acf[a * nR + q] >= CAL.TAIL_ACF) clear = false;
                if (clear) { tail[l] = 1; nTail++; }
            }
        }
        if (!nTail) warnings.push('No sinogram tails outside the object to fit the scatter estimate to; it was left unscaled.');

        const totals = { prompts: 0, trues: 0, scatter: 0, randoms: 0, nec: 0 };
        let capped = 0;
        for (let f = 0; f < frames.length; f++) {
            const F = frames[f], A = acc[f];
            // the singles-based randoms estimate is the expected randoms; the
            // delayed window measures the same thing with its own noise
            const rl = physics.randoms ? cRandoms * A.rInt / NLOR : 0;
            const rs = new Float32Array(size);
            if (rl) await byRows(function (a0, a1) {
                for (let l = a0 * nR; l < a1 * nR; l++) { const v = rl * norm[l] * tofR.perBin, b = l * nT; for (let t = 0; t < nT; t++) rs[b + t] = v; }
            });
            const delayed = physics.noise ? await poissonInto(streamSeed(physics.seed, f, 0, 2), rs, new Float32Array(size)) : Float32Array.from(rs);
            // scatter estimate scaled to the tails of (prompts - delayed)
            const est = A.estRaw ? Float32Array.from(A.estRaw) : new Float32Array(size);
            let num = 0, den = 0;
            await byRows(function (a0, a1) {
                for (let l = a0 * nR; l < a1 * nR; l++) {
                    if (!tail[l]) continue;
                    const b = l * nT;
                    for (let t = 0; t < nT; t++) { num += A.prompts[b + t] - delayed[b + t]; den += est[b + t]; }
                }
            });
            let scale = !nTail ? 1 : (den > 0 ? Math.max(0, num / den) : 0);
            if (scale > CAL.TAIL_SCALE_MAX) scale = CAL.TAIL_SCALE_MAX;
            let estSum = 0;
            await byRows(function (a0, a1) { for (let k = a0 * nR * nT; k < a1 * nR * nT; k++) { est[k] *= scale; estSum += est[k]; } });
            if (scale === CAL.TAIL_SCALE_MAX && estSum > 0.02 * U.sum(A.prompts)) capped++;

            const Tn = U.sum(A.expT), Sn = U.sum(A.expS), Rn = U.sum(A.expR), Pn = U.sum(A.prompts);
            const all = Tn + Sn + Rn;
            const regionMean = new Float64Array(R);
            for (let r = 0; r < R; r++) regionMean[r] = integ[r] && F.decayIntegral > 0 ? integ[r](F.t0, F.t1) / F.decayIntegral : 0;
            F.prompts = A.prompts;
            F.promptsMC = A.promptsMC;
            F.delayed = delayed;
            F.randomsSingles = rs;
            F.scatterEst = est;
            F.scatterScale = scale;
            F.expected = { trues: A.expT, scatter: A.expS, randoms: A.expR };
            F.counts = { prompts: Pn, trues: Tn, scatter: Sn, randoms: Rn,
                nec: all > 0 ? Tn * Tn / all : 0, sf: Tn + Sn > 0 ? Sn / (Tn + Sn) : 0, rf: all > 0 ? Rn / all : 0,
                rt: Tn > 0 ? Rn / Tn : 0 };
            F.truth = { regionMean: regionMean };
            if (A.poses) {
                let s = 0; A.poses.forEach(function (p) { s += p.share; });
                F.poses = A.poses.map(function (p) { return { dx: p.dx, dy: p.dy, rot: p.rot, share: s > 0 ? p.share / s : 0 }; });
            }
            totals.prompts += Pn; totals.trues += Tn; totals.scatter += Sn; totals.randoms += Rn;
            await tick(0.3 * projUnit);
        }
        const all = totals.trues + totals.scatter + totals.randoms;
        totals.nec = all > 0 ? totals.trues * totals.trues / all : 0;

        // warnings a careful student would want
        if (capped) warnings.push('The sinogram tails hold more counts than scatter can explain (activity outside the mu map, or motion), so the scatter estimate was capped at ' +
            CAL.TAIL_SCALE_MAX + ' times the model' + (frames.length > 1 ? ' in ' + capped + ' of ' + frames.length + ' frames.' : '.'));
        if (physics.detector.deadBlock >= 0 && physics.detector.deadBlock < G.nBlocks)
            warnings.push('Detector block ' + physics.detector.deadBlock + ' is dead: its lines of response record nothing and show as gaps in the sinogram.');
        if (SC.timing.trueAcceptance(100, tau, ctr) < 0.9)
            warnings.push('The ' + U.fmtTime(tau) + ' coincidence window rejects true coincidences from more than about ' +
                Math.round(PET.const.C_MM_PER_S * tau / 4) + ' mm from the middle of each line of response, so the edge of the object loses counts.');
        if (totals.trues > 0 && totals.trues < 2e5)
            warnings.push('Only ' + U.fmtCounts(totals.trues) + ' true coincidences: expect a noisy image. Raise the dose or scan for longer.');

        if (onProgress) onProgress(1);
        return {
            program: program, phantomId: phantom.id, phantomOpts: phantom.opts || (ctx && ctx.phantomOpts) || null,
            physics: physics, seed: physics.seed,
            isotope: iso.id, tracer: program.tracer || null, dose: program.dose, weight: program.weight,
            geom: { nA: nA, nR: nR, nT: nT, tof: tofOn, ctr: ctr, sigmaTOF: sigmaTOF, ds: G.ds, dr: G.dr },
            frames: frames,
            corrections: { norm: Float32Array.from(norm), acf: Float32Array.from(corr.acf), muCorr: Float32Array.from(corr.muCorr) },
            muTrue: phantom.mu,
            totals: totals,
            stats: {
                computeMs: Date.now() - tStart,
                sliceThickness: G.sliceThickness,
                // true coincidences detected per positron annihilation in the
                // slice, without attenuation (energy window and mode included)
                sensitivity: CAL.SENS * mode.sens * epsE * epsE,
                kappa0: kappa0,
                scatterFraction: totals.trues + totals.scatter > 0 ? totals.scatter / (totals.trues + totals.scatter) : 0,
                randomsFraction: all > 0 ? totals.randoms / all : 0
            },
            warnings: warnings
        };
    }

    /* Decays per mL (betaPlus included) in each pixel over [t0, t1], at the
       reference pose, optionally blurred by positron range: the emission
       a frame starts from. For the event animation and phantom views. */
    function frameEmission(program, phantom, tacs, t0, t1, o) {
        const iso = PET.isotopes.get(program.isotope || 'F18'), lam = PET.isotopes.lambda(iso), R = phantom.regions.length;
        const d = new Float64Array(R);
        for (let r = 0; r < R; r++) if (tacs.regions[r]) d[r] = iso.betaPlus * curveIntegrator(tacs.t, tacs.regions[r], lam, 1)(t0, t1);
        let img = new Float32Array(phantom.n * phantom.n);
        for (let p = 0; p < img.length; p++) img[p] = d[phantom.label[p]] || 0;
        if (o && o.positronRange) { const k = PET.isotopes.rangeKernel(iso, phantom.dx); img = U.convolve2D(img, phantom.n, phantom.n, k.kernel, k.size); }
        return img;
    }

    PET.engine = {
        simulate: simulate,
        physicsDefaults: physicsDefaults,
        frameEmission: frameEmission,
        CAL: CAL,
        // exposed for tests and for the reconstruction author's reference
        _internal: { curveIntegrator: curveIntegrator, reposition: reposition, smoothRadial: smoothRadial, smoothAngles: smoothAngles }
    };

})(typeof window !== 'undefined' ? window : globalThis);
