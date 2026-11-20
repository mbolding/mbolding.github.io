/* ============================================================
   PET Simulator, event-by-event animation (a toy Monte Carlo)

   Feeds the Scanner tab's animation, nothing else: images never come
   from here (engine.js computes expected sinograms). It follows single
   decays through the object, one at a time, with just enough real
   physics that what students watch is honest:

     decay       sampled from the frame's emission raster (cumulative
                 distribution over its pixels)
     positron    flies a random distance (PET.isotopes.sampleRange)
                 before it annihilates
     photons     two 511 keV photons, back to back within about
                 ±0.25 degrees (the pair is not quite at rest)
     body        each photon's path is marched through the mu raster
                 and an interaction point is drawn from exp(-∫mu ds);
                 the first interaction is a Compton scatter (angle from
                 Klein-Nishina, energy from the Compton formula), a
                 second one absorbs the photon
     slice       real scatter is 3D, so a scattered photon usually
                 leaves the one slice we model; some unscattered photons
                 also leave it (an oblique pair), which is why singles
                 outnumber coincidences
     detector    the ring point and crystal it reaches, the LYSO
                 stopping probability, the measured energy blurred with
                 the energy resolution, the arrival time blurred with the
                 coincidence timing resolution (CTR)
     sorting     singles inside the energy window are sorted in time;
                 two singles within half the coincidence window form a
                 coincidence (same decay: true or scatter; different
                 decays: random), three or more are a multiple and are
                 discarded, a pair outside the transaxial field of view
                 is never formed

   Two clocks. Physics time (s) is real time: photon flights of about a
   nanosecond, windows of a few ns. Animation time (s) is what the tab
   shows. Photon flight is slowed by TIME_SCALE (about 1e9, light moves
   30 cm per animation second). The gaps BETWEEN decays are not slowed
   by the same factor (at a realistic count rate the next decay would be
   minutes away); instead a physics gap g, exponential with rate Lambda,
   maps to an animation gap Wmax (1 - exp(-Lambda g)), which is uniform
   on [0, Wmax]: a steady, readable cadence in which two decays that are
   nearly simultaneous in physics time also appear together on screen.
   Lambda (the physics decay rate) sets how often unrelated singles
   share a window, so it is chosen to make the randoms fraction match
   the latest scan; the probability that a scattered photon leaves the
   slice is chosen the same way for the scatter fraction.

   No DOM. ARCHITECTURE.md section 11 is the contract.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;

    const C_MM = PET.const.C_MM_PER_S;     // mm per second
    const E511 = PET.const.E511;
    const DEG = Math.PI / 180;

    /* The toy's constants, with the reasons for their values. */
    const CFG = {
        timeScale: 1e9,              // animation s per physics s: light moves 300 mm per animation second
        rate: 1.4,                   // default decays per animation second: two or three events on screen at once
        nonCollinearityFwhm: 0.5 * DEG,   // ±0.25 degrees, from the residual momentum of the annihilating pair
        lysoMu: 0.086,               // 1/mm at 511 keV: 20 mm of LYSO stops about 82 % of photons
        // Probability that one photon of an unscattered pair leaves the slice
        // axially (the pair was oblique), turning its partner into a single.
        loneProb: { '3D': 0.12, '2D': 0.10 },
        // Probability that a once-scattered photon leaves the slice. In 3D
        // most scatter goes out of plane; in 2D the septa absorb most of it.
        // Replaced by a calibrated value when the tab passes a target scatter fraction.
        scatterOut: { '3D': 0.3, '2D': 0.85 },
        // In 3D, photons that scattered in neighbouring slices also scatter
        // INTO this one, which an in-plane model cannot produce. When the
        // target scatter fraction is above what in-plane scatter gives, a
        // photon is made to interact in the body with this probability
        // (calibrated; 0 by default) to stand in for that scatter.
        forceMax: 0.9,
        // Physics decay rate (1/s) when no target randoms fraction is given:
        // a randoms fraction of about 0.15 in a 20 cm water cylinder at 4.5 ns.
        lambda: { '3D': 9e7, '2D': 3.5e7 },
        muEnergyExp: 0.4,            // mu(E) ≈ mu(511) (511/E)^0.4 in water between 200 and 511 keV (NIST)
        marchPixels: 128,            // the mu raster is box-averaged to at most this many pixels across for marching
        poolSize: 1600,              // decays simulated to calibrate the fractions
        lambdaRange: [3e4, 3e9]      // 1/s, search range for the calibrated rate
    };

    const DEFAULT_PROGRAM = {
        energy: { lo: 435, hi: 650 }, coincidence: 4.5e-9,
        tof: { on: false, ctr: 400e-12 }, acqMode: '3D', isotope: 'F18'
    };

    /* ---------- geometry helpers ---------- */

    /* Distance from (x, y) along the unit vector (ux, uy) to the ring. */
    function toRing(x, y, ux, uy, R) {
        const b = x * ux + y * uy, c = x * x + y * y - R * R;
        return -b + Math.sqrt(Math.max(0, b * b - c));
    }

    /* The part [s0, s1] of a ray from (x, y) along (ux, uy), 0 <= s <= L,
       that lies inside the raster (slab method), or null. */
    function clipToRaster(M, x, y, ux, uy, L) {
        const lo = (-M.h - 0.5) * M.dx, hi = (M.n - 1 - M.h + 0.5) * M.dx;
        let t0 = 0, t1 = L;
        if (Math.abs(ux) < 1e-12) { if (x < lo || x > hi) return null; }
        else { let a = (lo - x) / ux, b = (hi - x) / ux; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
        if (Math.abs(uy) < 1e-12) { if (y < lo || y > hi) return null; }
        else { let a = (lo - y) / uy, b = (hi - y) / uy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
        return t1 > t0 ? [t0, t1] : null;
    }

    /* Optical-depth march from (x, y) along (ux, uy) for at most L mm:
       return the distance at which the accumulated mu ds reaches `target`
       (an exponential draw), or -1 if the photon leaves the raster first.
       One step per (coarse) pixel, nearest-pixel mu. With target =
       Infinity it instead returns the total optical depth, as -1 - depth. */
    function march(M, x, y, ux, uy, L, target, scale) {
        const seg = clipToRaster(M, x, y, ux, uy, L);
        if (!seg) return target === Infinity ? -1 : -1;
        const n = M.n, nm = n - 1, mu = M.mu, step = M.dx, inv = 1 / M.dx, hh = M.h + 0.5;
        const end = seg[1];
        let s = seg[0], acc = 0;
        while (s < end) {
            const ds = end - s < step ? end - s : step, sm = s + 0.5 * ds;
            let ix = ((x + sm * ux) * inv + hh) | 0, iy = ((y + sm * uy) * inv + hh) | 0;
            if (ix > nm) ix = nm; if (iy > nm) iy = nm; if (ix < 0) ix = 0; if (iy < 0) iy = 0;
            const m = mu[iy * n + ix] * scale;
            if (m > 0) {
                const md = m * ds;
                if (acc + md >= target) return s + (target - acc) / m;
                acc += md;
            }
            s += ds;
        }
        return target === Infinity ? -1 - acc : -1;
    }
    function opticalDepth(M, x, y, ux, uy, L, scale) { return -1 - march(M, x, y, ux, uy, L, Infinity, scale); }

    /* The mu raster box-averaged to a coarser grid for marching: photons
       cross the object in about a hundred steps instead of several
       hundred, and 2.5 mm is far finer than any mean free path (100 mm). */
    const rasterCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function marchRaster(mu, n, dx) {
        const f = Math.max(1, Math.floor(n / CFG.marchPixels));
        if (f === 1) return { n: n, h: Math.floor(n / 2), dx: dx, mu: mu };
        const hit = rasterCache && rasterCache.get(mu);
        if (hit && hit.f === f && hit.dx0 === dx) return hit.M;
        const m = Math.floor(n / f), out = new Float32Array(m * m), w = 1 / (f * f);
        for (let iy = 0; iy < m * f; iy++) {
            const ro = ((iy / f) | 0) * m, ri = iy * n;
            for (let ix = 0; ix < m * f; ix++) out[ro + ((ix / f) | 0)] += mu[ri + ix] * w;
        }
        // Coarse pixel j covers fine pixels j*f .. j*f+f-1: its centre sits at
        // ((j + 0.5) f - 0.5 - floor(n/2)) dx; choose h so (j - h) * dxc matches.
        const M = { n: m, h: (Math.floor(n / 2) + 0.5 - 0.5 * f) / f, dx: dx * f, mu: out };
        if (rasterCache) rasterCache.set(mu, { f: f, dx0: dx, M: M });
        return M;
    }

    /* Cumulative distribution over the positive pixels of the emission
       raster, for sampling decay positions. */
    const samplerCache = typeof WeakMap === 'function' ? new WeakMap() : null;
    function buildSampler(emission, n) {
        const hit = samplerCache && samplerCache.get(emission);
        if (hit && hit.n === n) return hit;
        let count = 0;
        for (let k = 0; k < emission.length; k++) if (emission[k] > 0 && isFinite(emission[k])) count++;
        const idx = new Int32Array(count), cum = new Float64Array(count);
        let s = 0, j = 0;
        for (let k = 0; k < emission.length; k++) {
            const e = emission[k];
            if (e > 0 && isFinite(e)) { s += e; idx[j] = k; cum[j] = s; j++; }
        }
        const out = { idx: idx, cum: cum, total: s, count: count, n: n };
        if (samplerCache) samplerCache.set(emission, out);
        return out;
    }
    function sampleDecay(ctx, rng) {
        const S = ctx.sampler, u = rng() * S.total;
        let lo = 0, hi = S.count - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (S.cum[mid] < u) lo = mid + 1; else hi = mid; }
        const k = S.idx[lo], n = S.n, h = Math.floor(n / 2);
        const ix = k % n, iy = (k - ix) / n;
        // uniform within the pixel, so decays do not sit on a grid
        return { x: (ix - h + rng() - 0.5) * ctx.dx, y: (iy - h + rng() - 0.5) * ctx.dx };
    }

    /* A positron does not fly straight: it scatters off electrons as it
       slows. Draw a short tortuous track from the nucleus to the
       annihilation point (for display; the end points are the physics). */
    function positronTrack(d, a, rng) {
        const vx = a.x - d.x, vy = a.y - d.y, L = Math.hypot(vx, vy);
        if (L < 1e-4) return [{ x: d.x, y: d.y }, { x: a.x, y: a.y }];
        const nx = -vy / L, ny = vx / L, nseg = 7, pts = [{ x: d.x, y: d.y }];
        let w = 0;
        for (let k = 1; k < nseg; k++) {
            const f = k / nseg;
            w = 0.55 * w + 0.22 * L * rng.randn();
            const env = Math.sin(Math.PI * f);
            pts.push({ x: d.x + vx * f + nx * w * env, y: d.y + vy * f + ny * w * env });
        }
        pts.push({ x: a.x, y: a.y });
        return pts;
    }

    /* ---------- one photon ----------
       Follow a 511 keV photon from (x0, y0) along (ux, uy). `axial`: it
       leaves the slice without interacting in it (the oblique partner of a
       lone single). Returns the photon record; `uEsc` is the uniform that
       decided whether a scattered photon left the slice, kept so the
       calibration can re-weight outcomes for another escape probability. */
    function transport(ctx, rng, x0, y0, ux, uy, axial, forced) {
        const R = ctx.R, path = [{ x: x0, y: y0 }];
        const ph = { path: path, energy: E511, measured: null, crystal: -1, time: null, absorbed: false,
            fate: null, scattered: false, scatterAngle: 0, scatterAt: null, accepted: false, single: false,
            flight: 0, z: 0, uEsc: 1, forced: !!forced };
        let x = x0, y = y0, len = 0;
        if (axial) {
            // Draw it to the ring and a little past: it misses the detectors.
            const L = toRing(x, y, ux, uy, R) + 22;
            x += ux * L; y += uy * L; len += L; path.push({ x: x, y: y });
            ph.fate = 'axial';
        } else {
            let scale = 1;
            for (let leg = 0; leg < 2; leg++) {
                const L = toRing(x, y, ux, uy, R);
                let s = -1;
                if (ctx.attenuation && ctx.M) {
                    let u = rng(); if (u < 1e-12) u = 1e-12;
                    let target = -Math.log(u);
                    if (forced && leg === 0) {
                        // interaction forced inside the body: a truncated exponential
                        const tt = opticalDepth(ctx.M, x, y, ux, uy, L, scale);
                        if (tt > 1e-3) target = -Math.log(1 - (1 - u) * (1 - Math.exp(-tt)));
                    }
                    s = march(ctx.M, x, y, ux, uy, L, target, scale);
                }
                if (s < 0) { x += ux * L; y += uy * L; len += L; path.push({ x: x, y: y }); break; }
                x += ux * s; y += uy * s; len += s; path.push({ x: x, y: y });
                if (!ctx.scatter || ph.scattered) { ph.fate = 'absorbed'; ph.absorbed = true; break; }
                // Compton scatter, in the plane (the sign of the angle is a coin toss)
                const phi = PET.scanner.energy.sampleScatterAngle(rng);
                const sg = rng() < 0.5 ? -1 : 1, c = Math.cos(sg * phi), sn = Math.sin(sg * phi);
                const nx = ux * c - uy * sn, ny = ux * sn + uy * c;
                ux = nx; uy = ny;
                ph.scattered = true; ph.scatterAngle = phi; ph.scatterAt = { x: x, y: y };
                ph.energy = PET.scanner.energy.comptonEnergy(phi);
                ph.uEsc = rng();
                if (ph.uEsc < ctx.scatterOut) {
                    // deflected out of the slice: a short stub, then it is gone
                    const L2 = toRing(x, y, ux, uy, R), stub = Math.min(L2, 26 + 0.22 * L2);
                    x += ux * stub; y += uy * stub; len += stub; path.push({ x: x, y: y });
                    ph.fate = 'axial';
                    break;
                }
                // a lower-energy photon is attenuated more strongly
                scale = Math.pow(E511 / ph.energy, CFG.muEnergyExp);
            }
        }
        if (!ph.fate) {
            if (rng() > ctx.detEff) {
                // passes straight through the crystal without stopping
                const over = 26;
                x += ux * over; y += uy * over; len += over; path.push({ x: x, y: y });
                ph.fate = 'missed';
            } else {
                ph.fate = 'detected';
                ph.crystal = PET.scanner.crystalAt(Math.atan2(y, x));
                ph.measured = ph.energy + PET.scanner.energy.sigma(ph.energy) * rng.randn();
                ph.accepted = ph.measured >= ctx.lo && ph.measured <= ctx.hi;
                ph.z = rng.randn();              // timing noise, scaled by the single-photon sigma later
            }
        }
        ph.flight = len / C_MM;
        return ph;
    }

    /* ---------- one decay (no timing yet) ---------- */
    function simulateDecay(ctx, rng) {
        const d = sampleDecay(ctx, rng);
        let ax = d.x, ay = d.y;
        if (ctx.positronRange) { const r = PET.isotopes.sampleRange(ctx.iso, rng); ax += r[0]; ay += r[1]; }
        const a = { x: ax, y: ay };
        const track = positronTrack(d, a, rng);
        const th = rng() * 2 * Math.PI, ux = Math.cos(th), uy = Math.sin(th);
        const dl = rng.randn() * ctx.ncSigma, c = Math.cos(dl), s = Math.sin(dl);
        const vx = -(ux * c - uy * s), vy = -(ux * s + uy * c);
        let lone = -1;
        if (rng() < ctx.loneProb) lone = rng() < 0.5 ? 0 : 1;
        const dirs = [[ux, uy], [vx, vy]], photons = [];
        for (let k = 0; k < 2; k++) {
            const f = rng() < ctx.forceProb;
            const p = transport(ctx, rng, ax, ay, dirs[k][0], dirs[k][1], lone === k, f);
            if (ctx.pool && lone !== k && ctx.attenuation) {
                // calibration pool: also the outcome with a forced interaction
                p.alt = transport(ctx, rng, ax, ay, dirs[k][0], dirs[k][1], false, true);
                p.uForce = rng();
            }
            photons.push(p);
        }
        return { decay: d, annihilation: a, track: track, photons: photons, range: Math.hypot(ax - d.x, ay - d.y), lone: lone };
    }

    /* ---------- coincidence sorting ----------
       Non-paralysable window opened by each single that is not already
       part of a window: every single within halfTau after it joins. One
       other single: a coincidence (if the line between the two crystals
       crosses the field of view); none: a lone single; more: a multiple.
       Only windows that close before `horizon` are processed (later
       singles may still arrive). Returns the index of the first single
       not processed. */
    function sortSingles(singles, halfTau, horizon, fanOk, on) {
        let i = 0;
        const n = singles.length;
        while (i < n) {
            const A = singles[i];
            if (A.t + halfTau >= horizon) break;
            let j = i + 1;
            while (j < n && singles[j].t - A.t < halfTau) j++;
            const m = j - i;
            if (m === 1) on.lone(A);
            else if (m === 2) {
                const B = singles[i + 1];
                if (fanOk(A.crystal, B.crystal)) on.pair(A, B); else on.fan(A, B);
            } else on.multiple(singles.slice(i, j));
            i = j;
        }
        return i;
    }

    /* Whether a coincidence between two crystals can be formed: the
       processor only pairs detectors whose line of response crosses the
       transaxial field of view (the sinogram's radial range). Cached. */
    let fanCache = null;
    function fanOk(cA, cB) {
        const N = PET.scanner.geom.nCrystals;
        if (!fanCache) fanCache = new Uint8Array(N * N);
        if (cA === cB) return false;
        const key = cA * N + cB, v = fanCache[key];
        if (v) return v === 1;
        const a = PET.scanner.crystalPos(cA), b = PET.scanner.crystalPos(cB);
        const l = PET.scanner.lorFromPoints(a.x, a.y, b.x, b.y);
        const ok = PET.scanner.binOf(l.r, l.theta).inside;
        fanCache[key] = ok ? 1 : 2; fanCache[cB * N + cA] = ok ? 1 : 2;
        return ok;
    }

    /* LOR between two crystals, ordered by crystal index so that the sign
       of the time difference means the same thing for every event. */
    function makeLor(cA, cB) {
        const c1 = Math.min(cA, cB), c2 = Math.max(cA, cB);
        const p1 = PET.scanner.crystalPos(c1), p2 = PET.scanner.crystalPos(c2);
        const l = PET.scanner.lorFromPoints(p1.x, p1.y, p2.x, p2.y);
        const b = PET.scanner.binOf(l.r, l.theta);
        return { a: b.a, i: b.i, inside: b.inside, r: l.r, theta: l.theta,
            x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, cA: c1, cB: c2 };
    }

    /* ---------- calibration ----------
       Simulate a pool of decays once (with no scattered photon leaving
       the slice), then pick the escape probability p of scattered photons
       that gives the target scatter fraction (re-weighting the pool,
       exact and cheap), and the physics decay rate Lambda that gives the
       target randoms fraction (running the real sorter over the pool's
       singles with the same exponential gaps for every trial rate). */
    /* Expected trues and scatters of the pool for forcing probability q
       and escape probability p: each photon takes its forced outcome with
       probability q (when it has one), and a scattered photon then stays
       in the slice with probability 1 - p. */
    function poolPairs(pool, q, p) {
        let T = 0, S = 0;
        const add = function (A, B, w) {
            if (!w || !A.accepted || !B.accepted) return;
            const n = (A.scattered ? 1 : 0) + (B.scattered ? 1 : 0);
            if (n === 0) T += w; else S += w * (n === 1 ? 1 - p : (1 - p) * (1 - p));
        };
        for (let j = 0; j < pool.length; j++) {
            const P0 = pool[j].photons[0], P1 = pool[j].photons[1];
            const a0 = q > 0 && P0.alt ? P0.alt : null, a1 = q > 0 && P1.alt ? P1.alt : null;
            const w0 = a0 ? 1 - q : 1, w1 = a1 ? 1 - q : 1;
            add(P0, P1, w0 * w1);
            if (a0) add(a0, P1, q * w1);
            if (a1) add(P0, a1, w0 * q);
            if (a0 && a1) add(a0, a1, q * q);
        }
        return { T: T, S: S };
    }
    function poolSF(pool, q, p) { const c = poolPairs(pool, q, p); return c.T + c.S > 0 ? c.S / (c.T + c.S) : 0; }
    /* Choose (q, p) for a target scatter fraction: raise q if in-plane
       scatter alone gives too little, otherwise let scatter leave the slice. */
    function solveScatter(pool, target, pDefault) {
        const bisect = function (f, lo, hi, rising) {
            for (let it = 0; it < 30; it++) { const m = 0.5 * (lo + hi); if ((f(m) > target) === rising) hi = m; else lo = m; }
            return 0.5 * (lo + hi);
        };
        const base = poolSF(pool, 0, 0);
        if (target > base) {
            if (poolSF(pool, CFG.forceMax, 0) <= target) return { q: CFG.forceMax, p: 0 };
            return { q: bisect(function (q) { return poolSF(pool, q, 0); }, 0, CFG.forceMax, true), p: 0 };
        }
        if (poolSF(pool, 0, 0.97) >= target) return { q: 0, p: 0.97 };
        return { q: 0, p: bisect(function (p) { return poolSF(pool, 0, p); }, 0, 0.97, false) };
    }
    /* The pool's randoms fraction as a function of the physics decay rate,
       for fixed (q, p) and fixed exponential gaps, so it is a smooth
       function of the rate (common random numbers). */
    function poolRandoms(pool, q, p, sigma1, halfTau, gaps) {
        const offs = [], dec = [], cry = [];
        for (let j = 0; j < pool.length; j++) {
            for (let k = 0; k < 2; k++) {
                let ph = pool[j].photons[k];
                if (ph.alt && ph.uForce < q) ph = ph.alt;
                if (!ph.accepted || (ph.scattered && ph.uEsc < p)) continue;
                offs.push(ph.flight + ph.z * sigma1); dec.push(j); cry.push(ph.crystal);
            }
        }
        const T = new Float64Array(pool.length);
        const singles = offs.map(function (o, i) { return { t: 0, d: dec[i], o: o, crystal: cry[i] }; });
        const on = { lone: function () {}, fan: function () {}, multiple: function () {}, pair: null };
        return function (lambda) {
            let t = 0;
            for (let j = 0; j < pool.length; j++) { t += gaps[j] / lambda; T[j] = t; }
            for (let i = 0; i < singles.length; i++) singles[i].t = T[singles[i].d] + singles[i].o;
            singles.sort(function (a, b) { return a.t - b.t; });
            let same = 0, rnd = 0;
            on.pair = function (A, B) { if (A.d === B.d) same++; else rnd++; };
            sortSingles(singles, halfTau, Infinity, fanOk, on);
            return same + rnd > 0 ? rnd / (same + rnd) : 0;
        };
    }
    function solveLambda(rfAt, target) {
        const lo = Math.log(CFG.lambdaRange[0]), hi = Math.log(CFG.lambdaRange[1]), N = 14;
        let best = { L: Math.exp(lo), rf: rfAt(Math.exp(lo)) }, prev = best;
        if (prev.rf >= target) return prev;
        for (let q = 1; q <= N; q++) {
            const L = Math.exp(lo + (hi - lo) * q / N), rf = rfAt(L);
            if (rf > best.rf) best = { L: L, rf: rf };
            if (rf >= target) {
                // refine between the previous grid point and this one (log scale)
                let a = Math.log(prev.L), b = Math.log(L), out = { L: L, rf: rf };
                for (let it = 0; it < 10; it++) {
                    const m = 0.5 * (a + b), r = rfAt(Math.exp(m));
                    if (r >= target) { b = m; out = { L: Math.exp(m), rf: r }; } else a = m;
                }
                return out;
            }
            prev = { L: L, rf: rf };
        }
        return best;                       // target out of reach: the closest the sorter gets
    }

    /* ---------- the simulator ---------- */
    function create(scene, settings) {
        scene = scene || {};
        settings = settings || {};
        const prog = Object.assign({}, DEFAULT_PROGRAM, scene.program || {});
        const energy = Object.assign({}, DEFAULT_PROGRAM.energy, prog.energy || {});
        const tof = Object.assign({}, DEFAULT_PROGRAM.tof, prog.tof || {});
        const physics = Object.assign({ attenuation: true, scatter: true, randoms: true, positronRange: true }, scene.physics || {});
        const mode = prog.acqMode === '2D' ? '2D' : '3D';
        let iso;
        try { iso = PET.isotopes.get(scene.isotope && scene.isotope.id ? scene.isotope.id : (scene.isotope || prog.isotope || 'F18')); }
        catch (e) { iso = PET.isotopes.get('F18'); }

        const tau = prog.coincidence > 0 ? prog.coincidence : DEFAULT_PROGRAM.coincidence;
        const ctr = tof.ctr > 0 ? tof.ctr : DEFAULT_PROGRAM.tof.ctr;
        const sigma1 = ctr / U.FWHM_PER_SIGMA / Math.SQRT2;     // per photon, so the difference has FWHM = CTR
        const rate = settings.rate > 0 ? settings.rate : CFG.rate;
        const timeScale = settings.timeScale > 0 ? settings.timeScale : CFG.timeScale;
        const seed = (settings.seed === undefined ? 1 : settings.seed) >>> 0;
        const G = PET.scanner.geom;

        const ph = scene.phantom || null;
        const n = ph && ph.n ? ph.n : 0;
        const dx = ph ? (ph.dx || (ph.fov && n ? ph.fov / n : 0)) : 0;
        let emission = scene.emission || null;
        if (!emission && ph && ph.label && ph.regions) {
            // no emission given: fill each region with its relative concentration
            emission = new Float32Array(n * n);
            for (let k = 0; k < emission.length; k++) { const r = ph.regions[ph.label[k]]; emission[k] = r && r.rel > 0 ? r.rel : 0; }
        }
        const sampler = emission && n && dx ? buildSampler(emission, n) : null;
        const empty = !sampler || !(sampler.total > 0);
        const muOk = !!(ph && ph.mu && ph.mu.length === n * n);

        const ctx = {
            R: G.ringRadius, n: n, dx: dx, sampler: sampler, iso: iso,
            M: muOk ? marchRaster(ph.mu, n, dx) : null, forceProb: 0, pool: false,
            attenuation: !!physics.attenuation && muOk, scatter: !!physics.scatter, positronRange: !!physics.positronRange,
            ncSigma: CFG.nonCollinearityFwhm / U.FWHM_PER_SIGMA,
            loneProb: CFG.loneProb[mode], scatterOut: CFG.scatterOut[mode],
            detEff: 1 - Math.exp(-CFG.lysoMu * G.crystalDepth),
            lo: energy.lo, hi: energy.hi
        };
        const halfTau = tau / 2;
        const target = settings.targetFractions || null;
        let lambda = CFG.lambda[mode];
        const calib = { target: target ? { sf: target.sf, rf: target.rf } : null, sfPool: null, rfPool: null, ms: 0 };

        if (!empty) {
            const t0 = Date.now();
            const crng = U.rng((seed ^ 0x5bd1e995) >>> 0);
            const pool = [];
            const c0 = Object.assign({}, ctx, { scatterOut: 0, forceProb: 0, pool: true });
            for (let j = 0; j < CFG.poolSize; j++) pool.push(simulateDecay(c0, crng));
            if (target && isFinite(target.sf) && target.sf >= 0 && ctx.scatter && ctx.attenuation) {
                const sol = solveScatter(pool, target.sf, ctx.scatterOut);
                ctx.forceProb = sol.q; ctx.scatterOut = sol.p;
            }
            calib.sfPool = poolSF(pool, ctx.forceProb, ctx.scatterOut);
            const gaps = new Float64Array(pool.length);
            for (let j = 0; j < gaps.length; j++) { let u = crng(); if (u < 1e-12) u = 1e-12; gaps[j] = -Math.log(u); }
            const rfAt = poolRandoms(pool, ctx.forceProb, ctx.scatterOut, sigma1, halfTau, gaps);
            if (!physics.randoms) lambda = 100;                  // decays far apart: no accidental pairs
            else if (target && isFinite(target.rf) && target.rf >= 0) {
                if (target.rf < 1e-4) lambda = 100;
                else lambda = solveLambda(rfAt, Math.min(0.9, target.rf)).L;
            }
            calib.rfPool = rfAt(lambda);
            calib.ms = Date.now() - t0;
        }

        /* ---------- live stream ---------- */
        const rng = U.rng(seed);
        const Wmax = 2 / rate;
        const counts = { decays: 0, singles: 0, detected: 0, prompts: 0, trues: 0, scatters: 0, randoms: 0,
            rejectedEnergy: 0, rejectedTime: 0, multiples: 0 };
        const live = { T: 0, W: 0, now: 0, nextId: 1, queue: [], singles: [] };

        function insertSingle(s) {
            const a = live.singles;
            let i = a.length;
            while (i > 0 && a[i - 1].t > s.t) i--;
            a.splice(i, 0, s);
        }
        function genDecay() {
            let u = rng(); if (u < 1e-12) u = 1e-12;
            const E = -Math.log(u);
            live.T += E / lambda;
            live.W += Wmax * (1 - Math.exp(-E));
            const rec = simulateDecay(ctx, rng);
            rec.id = live.nextId++; rec.T = live.T; rec.W = live.W;
            rec.singles = []; rec.pending = 0; rec.event = null;
            for (let k = 0; k < 2; k++) {
                const p = rec.photons[k];
                if (p.fate !== 'detected') continue;
                p.time = rec.T + p.flight + p.z * sigma1;
                if (p.accepted) {
                    p.single = true;
                    const s = { t: p.time, rec: rec, k: k, crystal: p.crystal, fate: null, partner: null };
                    rec.singles.push(s); rec.pending++;
                    insertSingle(s);
                }
            }
            live.queue.push(rec);
            if (!rec.pending) classify(rec);
        }
        const handlers = {
            lone: function (A) { A.fate = 'lone'; },
            fan: function (A, B) { A.fate = 'fan'; B.fate = 'fan'; },
            multiple: function (list) { list.forEach(function (s) { s.fate = 'multiple'; }); list[0].opener = true; },
            pair: function (A, B) { A.fate = 'pair'; B.fate = 'pair'; A.partner = B; B.partner = A; A.opener = true; }
        };
        function process() {
            // No single of a decay not yet generated can arrive before this.
            const horizon = live.T - 6 * sigma1;
            const i = sortSingles(live.singles, halfTau, horizon, fanOk, handlers);
            if (!i) return;
            const done = live.singles.splice(0, i);
            for (let q = 0; q < done.length; q++) {
                const r = done[q].rec;
                if (--r.pending === 0) classify(r);
            }
        }

        function photonOut(p) {
            return { path: p.path, energy: p.energy, measured: p.measured, crystal: p.crystal, time: p.time,
                absorbed: p.absorbed, fate: p.fate, scattered: p.scattered, scatterAngle: p.scatterAngle,
                scatterAt: p.scatterAt, accepted: p.accepted, single: p.single, flight: p.flight };
        }
        /* TOF estimate of the annihilation point on an LOR from the two
           measured arrival times: Δx = c Δt / 2 from the midpoint, toward
           the crystal hit first. */
        function tofPoint(lor, dt) {
            const mx = 0.5 * (lor.x1 + lor.x2), my = 0.5 * (lor.y1 + lor.y2);
            const L = Math.hypot(lor.x2 - lor.x1, lor.y2 - lor.y1) || 1;
            const off = -C_MM * dt / 2;
            return { x: mx + off * (lor.x2 - lor.x1) / L, y: my + off * (lor.y2 - lor.y1) / L };
        }
        /* dt = time at the lor's second crystal minus time at its first. */
        function pairTiming(lor, sA, sB) {
            const tA = sA.crystal === lor.cA ? sA.t : sB.t, tB = sA.crystal === lor.cA ? sB.t : sA.t;
            return tB - tA;
        }

        function classify(rec) {
            const P = rec.photons, S = rec.singles;
            let kind = 'single', lor = null, dt = null, partner = null, primary = false, reason = null;
            // A decay can (rarely) take part in two random coincidences, one
            // single in each window. The event then shows the window it opened.
            const paired = S.filter(function (s) { return s.fate === 'pair'; });
            const bothDetected = P[0].fate === 'detected' && P[1].fate === 'detected';
            let randomPairs = 0;
            if (paired.length) {
                const opened = paired.filter(function (s) { return s.opener; });
                const s = opened.length ? opened[0] : paired[0], o = s.partner;
                lor = makeLor(s.crystal, o.crystal);
                dt = pairTiming(lor, s, o);
                if (o.rec === rec) {
                    kind = (P[0].scattered || P[1].scattered) ? 'scatter' : 'true';
                    primary = true;
                } else {
                    kind = 'random'; partner = o.rec.id; primary = opened.length > 0;
                    randomPairs = opened.filter(function (q) { return q.partner.rec !== rec; }).length;
                }
            } else if (S.some(function (s) { return s.fate === 'multiple'; })) {
                kind = 'multiple'; reason = 'multiple';
                primary = S.some(function (s) { return s.fate === 'multiple' && s.opener; });
            } else if (bothDetected && !(P[0].accepted && P[1].accepted)) {
                kind = 'rejected-energy'; reason = 'energy';
            } else if (bothDetected) {
                // both accepted, same decay, but not paired: the window was too
                // short for their time difference (or the line misses the FOV)
                if (S.length === 2 && S[0].fate === 'fan') { kind = 'single'; reason = 'fan'; }
                else { kind = 'rejected-time'; reason = 'window'; }
            } else {
                const lost = P.filter(function (p) { return p.fate !== 'detected'; })[0];
                reason = lost ? lost.fate : null;
            }
            if (!lor && bothDetected) {
                lor = makeLor(P[0].crystal, P[1].crystal);
                const t1 = P[0].crystal === lor.cA ? P[0].time : P[1].time, t2 = P[0].crystal === lor.cA ? P[1].time : P[0].time;
                dt = t2 - t1;
            }
            const isPrompt = kind === 'true' || kind === 'scatter' || kind === 'random';
            rec.event = {
                id: rec.id, kind: kind, t: rec.W, tPhys: rec.T, reason: reason,
                decay: { x: rec.decay.x, y: rec.decay.y }, annihilation: { x: rec.annihilation.x, y: rec.annihilation.y },
                positron: rec.track, range: rec.range,
                photons: [photonOut(P[0]), photonOut(P[1])],
                lor: lor, dt: dt,
                tofPos: tof.on && isPrompt && lor ? tofPoint(lor, dt) : null,
                partner: partner, primary: primary, randomPairs: randomPairs
            };
        }

        function allFinalUpTo(w) {
            const q = live.queue;
            for (let i = 0; i < q.length && q[i].W <= w; i++) if (!q[i].event) return false;
            return true;
        }
        function ensure(w) {
            let guard = 0;
            while (live.W <= w && guard++ < 1e6) { genDecay(); process(); }
            while (!allFinalUpTo(w) && guard++ < 1e6) { genDecay(); process(); }
        }
        function emit(rec) {
            const ev = rec.event;
            counts.decays++;
            ev.photons.forEach(function (p) { if (p.fate === 'detected') { counts.detected++; if (p.single) counts.singles++; } });
            if (ev.kind === 'true') counts.trues++;
            else if (ev.kind === 'scatter') counts.scatters++;
            else if (ev.kind === 'random') counts.randoms += ev.randomPairs;
            else if (ev.kind === 'rejected-energy') counts.rejectedEnergy++;
            else if (ev.kind === 'rejected-time') counts.rejectedTime++;
            else if (ev.kind === 'multiple' && ev.primary) counts.multiples++;
            counts.prompts = counts.trues + counts.scatters + counts.randoms;
            return ev;
        }
        function advanceTo(w) {
            if (empty) { live.now = Math.max(live.now, w); return []; }
            ensure(w);
            live.now = Math.max(live.now, w);
            const out = [];
            while (live.queue.length && live.queue[0].W <= live.now) out.push(emit(live.queue.shift()));
            return out;
        }

        const sim = {
            empty: empty,
            counts: counts,
            timeScale: timeScale,
            config: CFG,
            /* New events during dtWall seconds of animation time. */
            step: function (dtWall) {
                if (!(dtWall > 0)) return [];
                return advanceTo(live.now + dtWall);
            },
            /* The next decay, whenever it happens (for "step one event"),
               plus the other decay of a random pair if it comes later. */
            next: function () {
                if (empty) return [];
                if (!live.queue.length) { let g = 0; while (!live.queue.length && g++ < 1000) { genDecay(); process(); } }
                const out = advanceTo(live.queue[0].W);
                const want = out.filter(function (e) { return e.kind === 'random' && e.partner > e.id; }).map(function (e) { return e.partner; });
                want.forEach(function (id) {
                    const r = live.queue.find(function (q) { return q.id === id; });
                    if (r) Array.prototype.push.apply(out, advanceTo(r.W));
                });
                return out;
            },
            /* Running fractions: SF = S/(T+S), RF = R/prompts, singles per true. */
            fractions: function () {
                const c = counts, ts = c.trues + c.scatters;
                return { sf: ts > 0 ? c.scatters / ts : null, rf: c.prompts > 0 ? c.randoms / c.prompts : null,
                    singlesPerTrue: c.trues > 0 ? c.singles / c.trues : null };
            },
            params: {
                lambda: lambda, rho: lambda * tau, scatterOut: ctx.scatterOut, forceProb: ctx.forceProb, loneProb: ctx.loneProb,
                detEff: ctx.detEff, timeScale: timeScale, rate: rate, wMax: Wmax,
                tau: tau, ctr: ctr, sigma1: sigma1, tof: !!tof.on,
                sigmaTOF: PET.scanner.timing.sigmaPos(ctr), lo: energy.lo, hi: energy.hi, mode: mode,
                isotope: iso.id, physics: physics, calibration: calib
            }
        };
        Object.defineProperty(sim, 'now', { get: function () { return live.now; } });
        return sim;
    }

    PET.events = { create: create, config: CFG, _fanOk: fanOk, _sortSingles: sortSingles };

})(typeof window !== 'undefined' ? window : globalThis);
