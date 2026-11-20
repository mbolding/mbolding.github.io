/* ============================================================
   PET Simulator, scanner
   The one scanner geometry the simulator models: a single ring of
   LYSO crystals, the sinogram that lines of response (LORs) are
   binned into, the projector that turns an image into a sinogram
   (and back), the detector blur, crystal efficiencies
   (normalisation), attenuation factors, and the physics of the
   energy and coincidence timing windows.

   Coordinates (see ARCHITECTURE.md section 3): millimetres, x to
   the right, y DOWN the screen, origin at the centre of the ring.
   An LOR is the line { p : p.n = r } with normal n = (cos t, sin t),
   t in [0, pi). Position along it is s, measured along the direction
   d = (-sin t, cos t) from the foot point r n, so p = r n + s d.
   Sinograms are row-major with one row per angle: index a*nR + i,
   or (a*nR + i)*nT + k for time-of-flight data (TOF bin fastest).
   No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;
    const C = PET.const;

    /* ---------- geometry ---------- */
    const N_CRYSTALS = 384;
    const G = {
        name: 'Teaching ring (one slice of a LYSO/SiPM scanner)',
        ringRadius: 250,                 // mm, crystal front face
        nCrystals: N_CRYSTALS,
        crystalsPerBlock: 8,
        nBlocks: N_CRYSTALS / 8,
        crystalPitch: 2 * Math.PI * 250 / N_CRYSTALS,   // about 4.09 mm
        crystalWidth: 4.0,               // mm (the rest of the pitch is reflector)
        crystalDepth: 20,                // mm
        sliceThickness: 4,               // mm, the axial width of the one slice we image
        scintillator: 'LYSO',
        energyResolution: 0.11,          // FWHM / E at 511 keV
        ctrDefault: 400e-12,             // coincidence timing resolution (FWHM), s
        fov: 320,                        // mm: image field of view (square; recon inside the inscribed circle)
        nR: 160, dr: 2,                  // radial bins: r_i = (i - 80) * 2 mm, -160 .. 158 mm
        nA: 192,                         // angles over [0, pi): N_CRYSTALS / 2, one per crystal pair rotation
        nT: 17, ds: 20,                  // TOF bins along the LOR: s_k = (k - 8) * 20 mm
        detFwhm0: 2.8,                   // mm: crystal size, photon non-collinearity, decoding (at the centre)
        detIsoFwhm: 2.4,                 // mm of detFwhm0 that is isotropic (applied in image space)
        parallaxFwhm: 9                  // mm of extra radial blur at r = ringRadius (depth of interaction)
    };
    /* At the centre of the ring the detector response is the same in every
       direction (crystal width and non-collinearity blur tangentially as
       much as radially), so most of it is applied to the image as an
       isotropic Gaussian; only the remainder, and the parallax that grows
       off centre, is applied along r in the sinogram. The isotropic part
       also band-limits the 1.25 mm emission raster before it is sampled by
       the 2 mm radial bins, which keeps small sources from aliasing. */
    G.detRadialFwhm0 = Math.sqrt(G.detFwhm0 * G.detFwhm0 - G.detIsoFwhm * G.detIsoFwhm);
    G.angle = function (a) { return a * Math.PI / G.nA; };
    G.radius = function (i) { return (i - G.nR / 2) * G.dr; };
    G.tofCentre = function (k) { return (k - Math.floor(G.nT / 2)) * G.ds; };

    /* Crystal c is centred at angle (c + 0.5) * 2pi/N on the ring. */
    function crystalAngle(c) { return (c + 0.5) * 2 * Math.PI / N_CRYSTALS; }
    function crystalAt(phi) {
        const tw = 2 * Math.PI;
        phi = ((phi % tw) + tw) % tw;
        return Math.min(N_CRYSTALS - 1, Math.floor(phi / tw * N_CRYSTALS));
    }
    function crystalPos(c) { const p = crystalAngle(c); return { x: G.ringRadius * Math.cos(p), y: G.ringRadius * Math.sin(p) }; }

    /* The LOR through two points: angle t in [0, pi), signed r, and the
       s coordinates of the points. */
    function lorFromPoints(x1, y1, x2, y2) {
        let dxl = x2 - x1, dyl = y2 - y1;
        const len = Math.hypot(dxl, dyl) || 1;
        dxl /= len; dyl /= len;
        // direction d = (-sin t, cos t)  =>  t = atan2(-dx, dy)
        let t = Math.atan2(-dxl, dyl);
        if (t < 0) t += Math.PI;
        if (t >= Math.PI) t -= Math.PI;
        const c = Math.cos(t), s = Math.sin(t);
        const r = x1 * c + y1 * s;
        return { theta: t, r: r, s1: -x1 * s + y1 * c, s2: -x2 * s + y2 * c };
    }
    /* Nearest sinogram bin for (r, theta). Returns {a, i, inside}. */
    function binOf(r, theta) {
        let t = theta % Math.PI; if (t < 0) t += Math.PI;
        let a = Math.round(t / Math.PI * G.nA);
        if (a >= G.nA) { a -= G.nA; r = -r; }
        const i = Math.round(r / G.dr + G.nR / 2);
        return { a: a, i: i, inside: i >= 0 && i < G.nR };
    }
    /* End points of an LOR on the ring and the crystals they hit. */
    function lorEndpoints(a, i) {
        const t = G.angle(a), r = G.radius(i), c = Math.cos(t), s = Math.sin(t);
        const L = Math.sqrt(Math.max(0, G.ringRadius * G.ringRadius - r * r));
        const x1 = r * c + L * s, y1 = r * s - L * c;          // s = -L
        const x2 = r * c - L * s, y2 = r * s + L * c;          // s = +L
        return { x1: x1, y1: y1, x2: x2, y2: y2, cA: crystalAt(Math.atan2(y1, x1)), cB: crystalAt(Math.atan2(y2, x2)) };
    }
    /* A point (x, y) traces r(t) = x cos t + y sin t through the sinogram,
       which is why it is called a sinogram. */
    function pointSinusoid(x, y) {
        const out = new Float32Array(G.nA);
        for (let a = 0; a < G.nA; a++) { const t = G.angle(a); out[a] = x * Math.cos(t) + y * Math.sin(t); }
        return out;
    }

    /* ---------- timing ---------- */
    /* Position uncertainty along the LOR (standard deviation, mm) for a
       coincidence timing resolution ctr (FWHM, s): Delta s = c Delta t / 2. */
    function sigmaPos(ctr) { return C.C_MM_PER_S * (ctr / U.FWHM_PER_SIGMA) / 2; }
    /* Probability that a true coincidence from position s (mm from the LOR
       midpoint) lands inside a coincidence window of width tau (s, total,
       i.e. |dt| <= tau/2). The arrival-time difference is 2s/c plus timing
       noise; in position units the window is |s_meas| <= c tau / 4. */
    function trueAcceptance(s, tau, ctr) {
        const half = C.C_MM_PER_S * tau / 4, sg = Math.max(1e-6, sigmaPos(ctr));
        return U.normCdf((half - s) / sg) - U.normCdf((-half - s) / sg);
    }
    /* Fraction of random coincidences (dt uniform over the window) that
       fall in one TOF bin of width ds (mm), and inside all nT bins. */
    function randomsTofFraction(tau, ds, nT) {
        const perBin = Math.min(1, (2 * ds / C.C_MM_PER_S) / tau);
        return { perBin: perBin, inside: Math.min(1, perBin * nT) };
    }

    /* ---------- energy ---------- */
    const ME = 511;
    function energySigma(E) { return G.energyResolution * Math.sqrt(ME * E) / U.FWHM_PER_SIGMA; }  // resolution ~ 1/sqrt(E)
    function windowProb(E, lo, hi) {
        const sg = energySigma(E);
        return U.normCdf((hi - E) / sg) - U.normCdf((lo - E) / sg);
    }
    /* Energy of a 511 keV photon after Compton scattering by angle phi. */
    function comptonEnergy(phi) { return ME / (2 - Math.cos(phi)); }
    /* Klein-Nishina differential cross-section per solid angle (relative). */
    function kleinNishina(phi) {
        const P = 1 / (2 - Math.cos(phi)), s = Math.sin(phi);
        return P * P * (P + 1 / P - s * s);
    }
    /* Distribution of scattering angles of photons that scattered once:
       KN times the solid-angle factor sin(phi), tabulated on 360 steps. */
    const PHI_N = 360, phiPdf = new Float64Array(PHI_N);
    (function () {
        let s = 0;
        for (let j = 0; j < PHI_N; j++) { const p = (j + 0.5) * Math.PI / PHI_N; phiPdf[j] = kleinNishina(p) * Math.sin(p); s += phiPdf[j]; }
        for (let j = 0; j < PHI_N; j++) phiPdf[j] /= s;
    })();
    function sampleScatterAngle(rng) {
        let u = rng(), j = 0;
        while (j < PHI_N - 1 && u > phiPdf[j]) { u -= phiPdf[j]; j++; }
        return (j + rng()) * Math.PI / PHI_N;
    }
    /* Probability that an unscattered 511 keV photon is accepted. */
    function photopeakAcceptance(lo, hi) { return windowProb(ME, lo, hi); }
    /* Probability that a once-scattered photon is accepted, averaged over
       the scattering-angle distribution. A wider (lower) window lets more
       scatter in; raising the lower level rejects it but also cuts into
       the photopeak. */
    function scatterAcceptance(lo, hi) {
        let s = 0;
        for (let j = 0; j < PHI_N; j++) s += phiPdf[j] * windowProb(comptonEnergy((j + 0.5) * Math.PI / PHI_N), lo, hi);
        return s;
    }
    /* Measured-energy spectra for plotting (each integrates to 1 over keV):
       the photopeak of unscattered photons and the blurred Compton
       continuum of photons that scattered once in the patient. */
    function energySpectrum(E) {
        const sp = energySigma(ME);
        const peak = Math.exp(-0.5 * ((E - ME) / sp) * ((E - ME) / sp)) / (sp * Math.sqrt(2 * Math.PI));
        let sc = 0;
        for (let j = 0; j < PHI_N; j += 2) {
            const Ep = comptonEnergy((j + 0.5) * Math.PI / PHI_N), sg = energySigma(Ep);
            sc += 2 * phiPdf[j] * Math.exp(-0.5 * ((E - Ep) / sg) * ((E - Ep) / sg)) / (sg * Math.sqrt(2 * Math.PI));
        }
        return { photopeak: peak, scatter: sc };
    }

    /* ---------- projector ----------
       Ray-driven with bilinear interpolation (Joseph-style): each LOR is
       sampled at about one point per pixel inside the field of view and
       the image is interpolated there. forward() returns line integrals
       (image units x mm); back() is its exact adjoint, so the pair can be
       used in MLEM without bias.

       A radial bin is 2 mm wide. When pixels are finer than that (the
       1.25 mm phantom raster, a 256 recon matrix) one ray per bin would
       skip pixels between rays, so a point source's counts would depend on
       where it sits relative to the rays and MLEM would grow pixel-scale
       ripples. Each bin therefore averages `rays` parallel sub-rays spread
       across its width, enough that they are closer together than a pixel.

       opts = { n,                  image is n x n
                fov,                mm (default G.fov)
                tof: null | { sigma },   position sigma along the LOR, mm
                sWeight: null | fn(s) -> weight, a factor per position along
                         the LOR (the engine uses it for coincidence-window
                         losses; reconstruction leaves it out)
                rays: sub-rays per radial bin (default: enough to be denser than the pixels) }
       Because the sample positions along an LOR depend only on its radial
       position, every per-sample weight is precomputed once per sub-ray. */
    function projector(opts) {
        const n = opts.n, fov = opts.fov || G.fov, dx = fov / n, inv = 1 / dx, h0 = Math.floor(n / 2);
        const nA = G.nA, nR = G.nR, tof = !!(opts.tof && opts.tof.sigma > 0);
        const nT = tof ? G.nT : 1, ds = G.ds, kMid = Math.floor(G.nT / 2);
        const R = opts.rays || Math.max(1, Math.ceil(G.dr / dx - 0.2));
        const STEP = opts.step || 1;            // sample spacing along the ray, in pixels
        // Keep every sample at least one pixel inside the grid so the
        // bilinear footprint never needs a bounds check.
        const Rf = Math.min(fov / 2 - 1.01 * dx, G.nR / 2 * G.dr);
        const cosA = new Float64Array(nA), sinA = new Float64Array(nA);
        for (let a = 0; a < nA; a++) { cosA[a] = Math.cos(G.angle(a)); sinA[a] = Math.sin(G.angle(a)); }

        // Per sub-ray j = i*R + q: its radius, number of samples, first
        // sample s, step, and the weight of each sample (step length times
        // sWeight, divided by R so a bin is the mean of its sub-rays).
        const NS = nR * R;
        const rowRad = new Float64Array(NS), rowK = new Int32Array(NS), rowS0 = new Float64Array(NS), rowH = new Float64Array(NS), rowW = [];
        // TOF: for each sample, the first TOF bin it feeds and its weights.
        const rowT0 = [], rowTN = [], rowTW = [];
        let tofW = null;
        if (tof) {
            // Probability that an event at offset o from a bin centre is
            // measured in that bin: Phi((ds/2 - o)/sg) - Phi((-ds/2 - o)/sg).
            const sg = opts.tof.sigma;
            tofW = { reach: 4 * sg + ds / 2, sg: sg };
        }
        for (let j = 0; j < NS; j++) {
            const i = Math.floor(j / R), q = j - i * R;
            const r = G.radius(i) + ((q + 0.5) / R - 0.5) * G.dr;
            rowRad[j] = r;
            if (Math.abs(r) >= Rf) { rowK[j] = 0; rowW.push(new Float32Array(0)); rowT0.push(null); rowTN.push(null); rowTW.push(null); continue; }
            const smax = Math.sqrt(Rf * Rf - r * r), K = Math.max(1, Math.ceil(2 * smax / (dx * STEP))), h = 2 * smax / K;
            rowK[j] = K; rowS0[j] = -smax + h / 2; rowH[j] = h;
            const w = new Float32Array(K);
            for (let k = 0; k < K; k++) { const s = rowS0[j] + k * h; w[k] = h / R * (opts.sWeight ? opts.sWeight(s) : 1); }
            rowW.push(w);
            if (tof) {
                const t0 = new Int16Array(K), tn = new Int16Array(K), tw = [];
                for (let k = 0; k < K; k++) {
                    const s = rowS0[j] + k * h;
                    let first = Math.max(0, Math.ceil((s - tofW.reach) / ds) + kMid), last = Math.min(nT - 1, Math.floor((s + tofW.reach) / ds) + kMid);
                    if (last < first) { t0[k] = 0; tn[k] = 0; tw.push(new Float32Array(0)); continue; }
                    const ws = new Float32Array(last - first + 1);
                    for (let t = first; t <= last; t++) {
                        const o = s - (t - kMid) * ds;
                        ws[t - first] = U.normCdf((ds / 2 - o) / tofW.sg) - U.normCdf((-ds / 2 - o) / tofW.sg);
                    }
                    t0[k] = first; tn[k] = ws.length; tw.push(ws);
                }
                rowT0.push(t0); rowTN.push(tn); rowTW.push(tw);
            } else { rowT0.push(null); rowTN.push(null); rowTW.push(null); }
        }
        const size = nA * nR * nT;

        function anglesOf(angles) {
            if (angles) return angles;
            const all = new Int32Array(nA); for (let a = 0; a < nA; a++) all[a] = a; return all;
        }

        /* Line integrals of img. If `out` is given it is overwritten for
           the listed angles only; other rows are left untouched. */
        function forward(img, angles, out) {
            out = out || new Float32Array(size);
            const list = anglesOf(angles);
            for (let p = 0; p < list.length; p++) {
                const a = list[p], c = cosA[a], sn = sinA[a];
                for (let i = 0; i < nR; i++) {
                    const base = (a * nR + i) * nT;
                    if (tof) for (let t = 0; t < nT; t++) out[base + t] = 0;
                    let acc = 0;
                    for (let j = i * R, je = j + R; j < je; j++) {
                        const K = rowK[j];
                        if (!K) continue;
                        const r = rowRad[j], w = rowW[j], s0 = rowS0[j], h = rowH[j];
                        // pixel coordinates of the first sample and the per-sample step
                        let fx = (r * c - s0 * sn) * inv + h0, fy = (r * sn + s0 * c) * inv + h0;
                        const sx = -sn * h * inv, sy = c * h * inv;
                        const T0 = rowT0[j], TN = rowTN[j], TW = rowTW[j];
                        for (let k = 0; k < K; k++, fx += sx, fy += sy) {
                            const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy, o = iy * n + ix;
                            const v = ((img[o] * (1 - ax) + img[o + 1] * ax) * (1 - ay) + (img[o + n] * (1 - ax) + img[o + n + 1] * ax) * ay) * w[k];
                            if (!tof) acc += v;
                            else if (v !== 0) {
                                const tw = TW[k], t0 = base + T0[k];
                                for (let t = 0, tn = TN[k]; t < tn; t++) out[t0 + t] += v * tw[t];
                            }
                        }
                    }
                    if (!tof) out[base] = acc;
                }
            }
            return out;
        }

        /* Adjoint of forward: smear sinogram values back along their LORs.
           Accumulates into `out` if given (so subsets can share a buffer). */
        function back(sino, angles, out) {
            out = out || new Float32Array(n * n);
            const list = anglesOf(angles);
            for (let p = 0; p < list.length; p++) {
                const a = list[p], c = cosA[a], sn = sinA[a];
                for (let i = 0; i < nR; i++) {
                    const base = (a * nR + i) * nT;
                    let val = 0;
                    if (!tof) { val = sino[base]; if (val === 0) continue; }
                    for (let j = i * R, je = j + R; j < je; j++) {
                        const K = rowK[j];
                        if (!K) continue;
                        const r = rowRad[j], w = rowW[j], s0 = rowS0[j], h = rowH[j];
                        let fx = (r * c - s0 * sn) * inv + h0, fy = (r * sn + s0 * c) * inv + h0;
                        const sx = -sn * h * inv, sy = c * h * inv;
                        const T0 = rowT0[j], TN = rowTN[j], TW = rowTW[j];
                        for (let k = 0; k < K; k++, fx += sx, fy += sy) {
                            let v;
                            if (!tof) v = val * w[k];
                            else {
                                const tw = TW[k], t0 = base + T0[k];
                                let sum = 0;
                                for (let t = 0, tn = TN[k]; t < tn; t++) sum += sino[t0 + t] * tw[t];
                                if (sum === 0) continue;
                                v = sum * w[k];
                            }
                            const ix = fx | 0, iy = fy | 0, ax = fx - ix, ay = fy - iy, o = iy * n + ix;
                            out[o] += v * (1 - ax) * (1 - ay);
                            out[o + 1] += v * ax * (1 - ay);
                            out[o + n] += v * (1 - ax) * ay;
                            out[o + n + 1] += v * ax * ay;
                        }
                    }
                }
            }
            return out;
        }

        /* Mask of pixels the projector can see (inside the FOV circle). */
        function fovMask() {
            const m = new Uint8Array(n * n), R2 = (Rf - dx) * (Rf - dx);
            for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
                const x = (ix - h0) * dx, y = (iy - h0) * dx;
                m[iy * n + ix] = x * x + y * y <= R2 ? 1 : 0;
            }
            return m;
        }

        return { n: n, fov: fov, dx: dx, nA: nA, nR: nR, nT: nT, tof: tof, size: size, radius: Rf, rays: R,
            forward: forward, back: back, fovMask: fovMask };
    }

    /* Interleaved angle subsets for OSEM: subset q holds angles q, q+S, ... */
    function subsets(nSub) {
        const out = [];
        for (let q = 0; q < nSub; q++) {
            const list = [];
            for (let a = q; a < G.nA; a += nSub) list.push(a);
            out.push(Int32Array.from(list));
        }
        return out;
    }

    /* ---------- detector blur ----------
       Finite crystal width, photon non-collinearity and depth-of-interaction
       parallax blur each LOR radially. Parallax grows with |r|: an LOR far
       from the centre enters the crystals at a slant, so where along the
       crystal the photon stops matters. Modelled as a Gaussian along r
       whose FWHM depends on the TRUE radial position (source bin j):
           FWHM(r) = sqrt(detRadialFwhm0^2 + (parallaxFwhm * |r| / R)^2),
       on top of the isotropic part detIsoFwhm applied in image space
       (isoKernel), so the total at the centre is detFwhm0 in every direction.
       Each source bin's counts are spread over neighbouring bins (counts are
       conserved). blurRadial(sino, nT, false) applies it; true applies the
       transpose, which reconstruction needs for resolution modelling. */
    const blurCache = {};
    function blurMatrix(fwhm0, parallax) {
        const key = fwhm0 + ':' + parallax;
        if (blurCache[key]) return blurCache[key];
        const nR = G.nR, lo = new Int32Array(nR), w = [];
        for (let j = 0; j < nR; j++) {
            const r = G.radius(j), f = Math.sqrt(fwhm0 * fwhm0 + Math.pow(parallax * Math.abs(r) / G.ringRadius, 2));
            const sg = f / U.FWHM_PER_SIGMA / G.dr;            // in bins
            const half = Math.max(1, Math.ceil(3.5 * sg));
            const a = Math.max(0, j - half), b = Math.min(nR - 1, j + half);
            const ww = new Float32Array(b - a + 1);
            let s = 0;
            // integrate the Gaussian over each 2 mm bin rather than sampling it
            for (let i = a; i <= b; i++) {
                const d = i - j;
                ww[i - a] = U.normCdf((d + 0.5) / sg) - U.normCdf((d - 0.5) / sg); s += ww[i - a];
            }
            for (let q = 0; q < ww.length; q++) ww[q] /= s;
            lo[j] = a; w.push(ww);
        }
        return (blurCache[key] = { lo: lo, w: w });
    }
    function blurRadial(sino, nT, transpose, opts) {
        opts = opts || {};
        const M = blurMatrix(opts.fwhm0 !== undefined ? opts.fwhm0 : G.detRadialFwhm0, opts.parallax !== undefined ? opts.parallax : G.parallaxFwhm);
        const nA = G.nA, nR = G.nR, out = new Float32Array(sino.length);
        nT = nT || 1;
        for (let a = 0; a < nA; a++) {
            const rb = a * nR;
            for (let j = 0; j < nR; j++) {
                const ww = M.w[j], i0 = M.lo[j];
                for (let t = 0; t < nT; t++) {
                    if (!transpose) {
                        const v = sino[(rb + j) * nT + t];
                        if (v === 0) continue;
                        for (let q = 0; q < ww.length; q++) out[(rb + i0 + q) * nT + t] += v * ww[q];
                    } else {
                        let s = 0;
                        for (let q = 0; q < ww.length; q++) s += sino[(rb + i0 + q) * nT + t] * ww[q];
                        out[(rb + j) * nT + t] = s;
                    }
                }
            }
        }
        return out;
    }

    /* The isotropic part of the detector response as a square image-space
       kernel for pixel size dx (sums to 1, symmetric, so it is its own
       adjoint). fwhm defaults to geom.detIsoFwhm. Cached. */
    const isoCache = {};
    function isoKernel(dx, fwhm) {
        fwhm = fwhm === undefined ? G.detIsoFwhm : fwhm;
        const key = dx.toFixed(4) + ':' + fwhm;
        if (isoCache[key]) return isoCache[key];
        const k1 = U.gaussKernel(fwhm / dx), size = k1.length, k = new Float32Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) k[y * size + x] = k1[y] * k1[x];
        return (isoCache[key] = { kernel: k, size: size, dx: dx, fwhm: fwhm });
    }
    /* Full 2D convolution of two square kernels (to combine the detector
       and positron-range kernels into one). */
    function combineKernels(a, b) {
        const size = a.size + b.size - 1, out = new Float32Array(size * size);
        for (let ay = 0; ay < a.size; ay++) for (let ax = 0; ax < a.size; ax++) {
            const va = a.kernel[ay * a.size + ax]; if (va === 0) continue;
            for (let by = 0; by < b.size; by++) for (let bx = 0; bx < b.size; bx++)
                out[(ay + by) * size + ax + bx] += va * b.kernel[by * b.size + bx];
        }
        return { kernel: out, size: size };
    }

    /* ---------- normalisation ----------
       Every crystal has its own efficiency (light output, SiPM gain), so
       the same activity gives different counts on different LORs.
       Efficiency of an LOR = product of its two crystals' efficiencies.
       opts = { variation: SD of crystal efficiency (0..0.3, default 0.06),
                deadBlock: index of a failed block (0..47) or -1, seed } */
    const lorCache = {};
    function lorCrystalTable() {
        if (lorCache.t) return lorCache.t;
        const A = new Int16Array(G.nA * G.nR), B = new Int16Array(G.nA * G.nR);
        for (let a = 0; a < G.nA; a++) for (let i = 0; i < G.nR; i++) {
            const e = lorEndpoints(a, i);
            A[a * G.nR + i] = e.cA; B[a * G.nR + i] = e.cB;
        }
        return (lorCache.t = { A: A, B: B });
    }
    function normalization(opts) {
        opts = opts || {};
        const variation = opts.variation === undefined ? 0.06 : opts.variation;
        const dead = opts.deadBlock === undefined ? -1 : opts.deadBlock;
        const rng = U.rng(opts.seed || 4242), crystal = new Float32Array(N_CRYSTALS);
        // a block-level factor (shared photodetector) times a crystal-level one
        const blockF = new Float32Array(G.nBlocks);
        for (let b = 0; b < G.nBlocks; b++) blockF[b] = 1 + 0.5 * variation * rng.randn();
        for (let c = 0; c < N_CRYSTALS; c++) {
            const e = blockF[Math.floor(c / G.crystalsPerBlock)] * (1 + variation * rng.randn());
            crystal[c] = U.clamp(e, 0.4, 1.6);
        }
        if (dead >= 0 && dead < G.nBlocks) for (let q = 0; q < G.crystalsPerBlock; q++) crystal[dead * G.crystalsPerBlock + q] = 0;
        const t = lorCrystalTable(), bins = new Float32Array(G.nA * G.nR);
        for (let k = 0; k < bins.length; k++) bins[k] = crystal[t.A[k]] * crystal[t.B[k]];
        return { crystal: crystal, bins: bins };
    }

    /* ---------- attenuation ----------
       Survival probability of BOTH photons along each LOR,
       exp(-integral of mu along the whole line). It does not depend on
       where on the line the annihilation happened, which is why PET
       attenuation can be corrected exactly once mu is known.
       mu: Float32Array n x n in 1/mm over the FOV. */
    const projCache = {};
    function plainProjector(n, fov) {
        const key = n + ':' + (fov || G.fov);
        return projCache[key] || (projCache[key] = projector({ n: n, fov: fov }));
    }
    function attenuationFactors(mu, n, fov) {
        const P = plainProjector(n, fov), li = P.forward(mu), out = new Float32Array(li.length);
        for (let k = 0; k < li.length; k++) out[k] = Math.exp(-li[k]);
        return out;
    }

    /* Sum a TOF sinogram over its TOF bins. */
    function sumTOF(sino, nT) {
        if (!nT || nT === 1) return sino;
        const m = sino.length / nT, out = new Float32Array(m);
        for (let k = 0; k < m; k++) { let s = 0; for (let t = 0; t < nT; t++) s += sino[k * nT + t]; out[k] = s; }
        return out;
    }

    PET.scanner = {
        geom: G,
        crystalAngle: crystalAngle, crystalAt: crystalAt, crystalPos: crystalPos,
        lorFromPoints: lorFromPoints, binOf: binOf, lorEndpoints: lorEndpoints, pointSinusoid: pointSinusoid,
        lorCrystals: function (a, i) { const t = lorCrystalTable(); return [t.A[a * G.nR + i], t.B[a * G.nR + i]]; },
        projector: projector, plainProjector: plainProjector, subsets: subsets,
        blurRadial: blurRadial, blurMatrix: blurMatrix, isoKernel: isoKernel, combineKernels: combineKernels,
        normalization: normalization, attenuationFactors: attenuationFactors, sumTOF: sumTOF,
        timing: { sigmaPos: sigmaPos, trueAcceptance: trueAcceptance, randomsTofFraction: randomsTofFraction },
        energy: {
            sigma: energySigma, windowProb: windowProb, comptonEnergy: comptonEnergy, kleinNishina: kleinNishina,
            sampleScatterAngle: sampleScatterAngle, photopeakAcceptance: photopeakAcceptance,
            scatterAcceptance: scatterAcceptance, spectrum: energySpectrum
        }
    };

})(typeof window !== 'undefined' ? window : globalThis);
