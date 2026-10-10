/* Tests for recon.js.
     node tests/test_recon.js

   The imaging engine is a separate module, so every acquisition here is
   synthetic: the continuous Fourier transform of an analytic object
   (Gaussians, rectangles, discs, with known positions and phases) is
   sampled at the nominal k positions, with the signal convention of
   ARCHITECTURE.md section 3, s(k) = sum m(r) exp(-i 2 pi k.r) dA, and a
   5 mm slice (factor 1). Multi-coil data for SENSE are made on the
   image grid itself, so that the expected answer is exact. */
'use strict';
const fs = require('fs');
const path = require('path');
const { load, ok, near, summary } = require('./harness');

// RECON_STUB_FIELDS=1 forces the stand-in below, to check the tests do not depend on fields.js
const hasFields = !process.env.RECON_STUB_FIELDS && fs.existsSync(path.join(__dirname, '..', 'js', 'fields.js'));
const MRI = load(hasFields ? ['core', 'fields', 'recon'] : ['core', 'recon']);
if (!hasFields) installFieldsStub(MRI);
const U = MRI.util, RC = MRI.recon;
const { PI, sqrt, exp, cos, sin, abs, floor, hypot } = Math;

/* ---------- a stand-in for fields.js (only used if it is missing) ---------- */
function installFieldsStub(M) {
    function coilSet(type) {
        if (type === 'body') return { type: 'body', n: 1, names: ['Body'], positions: [{ x: 0, y: 0 }], radius: 0.3 };
        const pos = [];
        for (let k = 0; k < 8; k++) { const p = -PI / 2 + PI / 8 + k * PI / 4; pos.push({ x: 0.105 * cos(p), y: 0.125 * sin(p) }); }
        return { type: 'head8', n: 8, names: pos.map((_, k) => 'coil ' + k), positions: pos, radius: 0.06 };
    }
    function coilMaps(cs, nx, ny, fovX, fovY) {
        if (typeof cs === 'string') cs = coilSet(cs);
        const re = [], im = [];
        for (let c = 0; c < cs.n; c++) {
            const r = new Float32Array(nx * ny), q = new Float32Array(nx * ny);
            for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
                const x = (ix - floor(nx / 2)) * fovX / nx, y = (iy - floor(ny / 2)) * fovY / ny;
                let m = 1, ph = 0;
                if (cs.type !== 'body') {
                    const d2 = (x - cs.positions[c].x) ** 2 + (y - cs.positions[c].y) ** 2, qq = 1 + d2 / 0.0036;
                    m = 1 / (qq * sqrt(qq)); ph = c + 5 * (x * cos(c) + y * sin(c));
                }
                r[iy * nx + ix] = m * cos(ph); q[iy * nx + ix] = m * sin(ph);
            }
            re.push(r); im.push(q);
        }
        return { re, im };
    }
    M.fields = { coilSet, coilMaps };
}

/* ---------- analytic objects ---------- */

function besselJ1(x) {             // Numerical Recipes rational approximation, |error| < 1e-8
    const ax = abs(x);
    if (ax < 8) {
        const y = x * x;
        const a = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * (-30.16036606))))));
        const b = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
        return a / b;
    }
    const z = 8 / ax, y = z * z, xx = ax - 2.356194491;
    const a = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * (-0.240337019e-6))));
    const b = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
    const v = sqrt(0.636619772 / ax) * (cos(xx) * a - z * sin(xx) * b);
    return x < 0 ? -v : v;
}
const sincn = (x) => (abs(x) < 1e-12 ? 1 : sin(PI * x) / (PI * x));

/* An object is a list of shapes, each with a complex amplitude and a
   centre, times an optional overall linear phase exp(i 2 pi k0.r).
   ft(kx, ky) is its continuous Fourier transform with the section 3
   sign; value(x, y) the object itself. */
function makeObject(shapes, k0) {
    k0 = k0 || [0, 0];
    return {
        ft(kx, ky) {
            const qx = kx - k0[0], qy = ky - k0[1];
            let sr = 0, si = 0;
            for (const s of shapes) {
                let F;
                if (s.type === 'gauss') F = 2 * PI * s.sx * s.sy * exp(-2 * PI * PI * (s.sx * s.sx * qx * qx + s.sy * s.sy * qy * qy));
                else if (s.type === 'rect') F = s.wx * s.wy * sincn(qx * s.wx) * sincn(qy * s.wy);
                else { const q = hypot(qx, qy); F = q < 1e-9 ? PI * s.r * s.r : s.r * besselJ1(2 * PI * s.r * q) / q; }
                const ph = -2 * PI * (qx * s.x0 + qy * s.y0) + (s.ph || 0);
                sr += s.a * F * cos(ph); si += s.a * F * sin(ph);
            }
            return [sr, si];
        },
        value(x, y) {
            let vr = 0, vi = 0;
            for (const s of shapes) {
                const dx = x - s.x0, dy = y - s.y0;
                let f;
                if (s.type === 'gauss') f = exp(-dx * dx / (2 * s.sx * s.sx) - dy * dy / (2 * s.sy * s.sy));
                else if (s.type === 'rect') f = abs(dx) < s.wx / 2 && abs(dy) < s.wy / 2 ? 1 : 0;
                else f = hypot(dx, dy) < s.r ? 1 : 0;
                vr += s.a * f * cos(s.ph || 0); vi += s.a * f * sin(s.ph || 0);
            }
            const lp = 2 * PI * (k0[0] * x + k0[1] * y);
            return [vr * cos(lp) - vi * sin(lp), vr * sin(lp) + vi * cos(lp)];
        }
    };
}
const gauss = (a, sx, sy, x0, y0, ph) => ({ type: 'gauss', a, sx, sy, x0, y0, ph: ph || 0 });
const rect = (a, wx, wy, x0, y0, ph) => ({ type: 'rect', a, wx, wy, x0, y0, ph: ph || 0 });
const disc = (a, r, x0, y0, ph) => ({ type: 'disc', a, r, x0, y0, ph: ph || 0 });

/* ---------- synthetic acquisitions ---------- */

function acqShell(grid, readouts, nCoils, coilSet) {
    return { program: null, phantomId: 'test', coilSet: coilSet || MRI.fields.coilSet('body'), nCoils: nCoils || 1, seed: 1,
        grid, readouts, truth: null, stats: {}, warnings: [] };
}

/* Cartesian lines. sig(kx, ky, coil) -> [re, im] at the TRUE k;
   reverse(i) says whether readout i runs backwards (EPI);
   kshift(rev) is how far the true k lies from the nominal one along the
   readout (a gradient delay); extraPhase(rev) a constant phase error. */
function cartesian(o) {
    const { nx, ny, fovX, fovY, os, axis } = o;
    const nRo = axis === 'x' ? nx : ny, nPe = axis === 'x' ? ny : nx, n = o.n || nRo * os;
    const dro = 1 / ((axis === 'x' ? fovX : fovY) * os), dpe = 1 / (axis === 'x' ? fovY : fovX);
    const lines = o.lines || Array.from({ length: nPe }, (_, i) => i);
    const nC = o.nCoils || 1, dwell = 1 / (250 * n);
    const readouts = lines.map((L, i) => {
        const rev = o.reverse ? o.reverse(i) : false;
        const kx = new Float32Array(n), ky = new Float32Array(n);
        const re = [], im = [];
        for (let c = 0; c < nC; c++) { re.push(new Float32Array(n)); im.push(new Float32Array(n)); }
        const kpe = (L - floor(nPe / 2)) * dpe;
        const shift = o.kshift ? o.kshift(rev) : 0, eph = o.extraPhase ? o.extraPhase(rev) : 0;
        for (let j = 0; j < n; j++) {
            const kro = (rev ? -1 : 1) * (j - floor(n / 2)) * dro;
            const kt = kro - shift;
            const KX = axis === 'x' ? kro : kpe, KY = axis === 'x' ? kpe : kro;
            kx[j] = KX; ky[j] = KY;
            for (let c = 0; c < nC; c++) {
                const v = sig(o, axis === 'x' ? kt : kpe, axis === 'x' ? kpe : kt, c, L, j, rev);
                re[c][j] = v[0] * cos(eph) - v[1] * sin(eph); im[c][j] = v[0] * sin(eph) + v[1] * cos(eph);
            }
        }
        return { index: i, t0: i * 0.01, tc: i * 0.01 + floor(n / 2) * dwell, dwell, n, period: i, tExc: i * 0.01,
            te: o.te ? o.te(i) : 0.01, kx, ky, re, im, vars: { line: L } };
    });
    return acqShell({ nx, ny, fovX, fovY, readoutAxis: axis, oversample: os }, readouts, nC, o.coilSet);
}
function sig(o, kx, ky, c, L, j) {
    if (o.table) {                       // exact grid data (SENSE tests)
        const t = o.table[c];
        return o.axis === 'x' ? [t.re[L * t.W + j], t.im[L * t.W + j]] : [t.re[j * t.W + L], t.im[j * t.W + L]];
    }
    return o.obj.ft(kx, ky);
}

/* Expected image at pixel centres, including the periodic copies the
   discrete Fourier transform makes (period FOV along the phase encoding,
   os x FOV along the readout). */
function expected(obj, nx, ny, fovX, fovY, perX, perY) {
    const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        const x = (ix - floor(nx / 2)) * fovX / nx, y = (iy - floor(ny / 2)) * fovY / ny;
        let vr = 0, vi = 0;
        for (let a = perX ? -1 : 0; a <= (perX ? 1 : 0); a++) for (let b = perY ? -1 : 0; b <= (perY ? 1 : 0); b++) {
            const v = obj.value(x + a * perX, y + b * perY);
            vr += v[0]; vi += v[1];
        }
        re[iy * nx + ix] = vr; im[iy * nx + ix] = vi;
    }
    return { re, im };
}
function maxErr(img, ex) {
    let e = 0;
    for (let i = 0; i < ex.re.length; i++) e = Math.max(e, hypot(img.re[i] - ex.re[i], img.im[i] - ex.im[i]));
    return e;
}
function argmax(a) { let b = -Infinity, k = 0; for (let i = 0; i < a.length; i++) if (a[i] > b) { b = a[i]; k = i; } return k; }
function rms(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return sqrt(s / a.length); }
function hasNote(r, re) { return r.info.notes.some(n => re.test(n)); }
function noFailNote(r, label) { ok(!hasNote(r, /failed/i), label + ': no failure note (' + r.info.notes.filter(n => /failed/i.test(n)).join('; ') + ')'); }

const FOV = 0.24, N = 128, DX = FOV / N;

/* ---------- 1. Cartesian scale, position and orientation, both readout axes ---------- */
{
    // two Gaussians of different size, amplitude and phase: any flip or transpose shows
    const obj = makeObject([gauss(1, 0.02, 0.02, 0.030, -0.045), gauss(0.5, 0.010, 0.015, -0.050, 0.040, 0.7)]);
    for (const axis of ['x', 'y']) {
        const acq = cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis, obj });
        const r = RC.run(acq, { coilCombine: 'roemer' });
        noFailNote(r, 'cartesian ' + axis);
        ok(r.info.cartesian === true, axis + ' readout: detected as Cartesian');
        ok(r.image.nx === N && r.image.ny === N, axis + ' readout: oversampling cropped to ' + N + ' (got ' + r.image.nx + 'x' + r.image.ny + ')');
        near(r.image.fovX, FOV, 1e-12, axis + ' readout: image fovX'); near(r.image.fovY, FOV, 1e-12, axis + ' readout: image fovY');
        const perX = axis === 'x' ? 2 * FOV : FOV, perY = axis === 'x' ? FOV : 2 * FOV;
        const ex = expected(obj, N, N, FOV, FOV, perX, perY);
        const e = maxErr(r.image, ex);
        ok(e < 2e-4, axis + ' readout: image equals the object at pixel centres, scale 1 (max error ' + e.toExponential(2) + ')');
        const k = argmax(r.image.mag);
        ok(k % N === 64 + 16 && floor(k / N) === 64 - 24, axis + ' readout: peak at x = +30 mm, y = -45 mm (pixel ' + (k % N) + ', ' + floor(k / N) + ')');
        // the weaker Gaussian carries its phase of 0.7 rad
        const k2 = (64 + floor(0.040 / DX + 0.5)) * N + 64 - floor(0.050 / DX + 0.5);
        near(Math.atan2(r.image.im[k2], r.image.re[k2]), 0.7, 1e-3, axis + ' readout: phase of the second object');
        // k-space output
        const K = r.kspace;
        ok(K.nx === (axis === 'x' ? 2 * N : N) && K.ny === (axis === 'x' ? N : 2 * N), axis + ' readout: k-space grid includes the oversampling');
        near(axis === 'x' ? K.dkx : K.dky, 1 / (2 * FOV), 1e-9, axis + ' readout: dk along the readout = 1/(FOV os)');
        near(axis === 'x' ? K.dky : K.dkx, 1 / FOV, 1e-9, axis + ' readout: dk along the phase encoding = 1/FOV');
        let nm = 0; for (let i = 0; i < K.mask.length; i++) nm += K.mask[i];
        ok(nm === 2 * N * N, axis + ' readout: every grid point sampled once (' + nm + ')');
        // a particular sample lands where its k says, with its time and readout index
        const ro = acq.readouts[37], j = 200;
        const ix = Math.round(ro.kx[j] / K.dkx) + floor(K.nx / 2), iy = Math.round(ro.ky[j] / K.dky) + floor(K.ny / 2);
        const p = iy * K.nx + ix;
        near(K.re[0][p], ro.re[0][j], 1e-12, axis + ' readout: k-space sample placed at its (kx, ky)');
        near(K.order[p], 37, 0, axis + ' readout: order map holds the readout index');
        near(K.tmap[p], ro.te + (j - floor(ro.n / 2)) * ro.dwell, 1e-9, axis + ' readout: tmap holds the time since excitation');
        ok(r.info.undersampling === 1 && r.info.partialFourier === 1, axis + ' readout: fully sampled');
    }
}

/* ---------- 2. a uniform m = 1 object reconstructs to 1.0 ---------- */
{
    const obj = makeObject([rect(1, 0.12, 0.10, 0, 0)]);
    const r = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj }), {});
    let s = 0, n = 0;
    for (let iy = 54; iy < 74; iy++) for (let ix = 54; ix < 74; ix++) { s += r.image.mag[iy * N + ix]; n++; }
    near(s / n, 1, 0.01, 'uniform m = 1 object, 5 mm slice, body coil: centre of the image is 1.0');
}

/* ---------- 3. crop or keep the readout oversampling ---------- */
{
    const obj = makeObject([gauss(1, 0.02, 0.02, 0.030, -0.045)]);
    for (const axis of ['x', 'y']) {
        const r = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis, obj }), { cropOversampling: false, coilCombine: 'roemer' });
        const wide = axis === 'x' ? r.image.nx : r.image.ny, narrow = axis === 'x' ? r.image.ny : r.image.nx;
        ok(wide === 2 * N && narrow === N, axis + ' readout, no crop: ' + 2 * N + ' pixels along the readout');
        near(axis === 'x' ? r.image.fovX : r.image.fovY, 2 * FOV, 1e-12, axis + ' readout, no crop: field of view doubled along the readout');
        const k = argmax(r.image.mag), nxI = r.image.nx;
        const cx = floor(r.image.nx / 2), cy = floor(r.image.ny / 2);
        ok(k % nxI === cx + 16 && floor(k / nxI) === cy - 24, axis + ' readout, no crop: peak still at (+30, -45) mm');
        ok(hasNote(r, /oversampling kept/), axis + ' readout, no crop: note says so');
    }
}

/* ---------- 4. filters reduce Gibbs ringing ---------- */
{
    const obj = makeObject([rect(1, 0.12, 0.10, 0, 0)]);
    const acq = cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj });
    function overshoot(opts) {
        const r = RC.run(acq, opts);
        let m = 0;
        for (let ix = 0; ix < N; ix++) m = Math.max(m, r.image.mag[64 * N + ix]);   // row through the centre
        return { over: m - 1, centre: r.image.mag[64 * N + 64] };
    }
    const none = overshoot({});
    ok(none.over > 0.07, 'unfiltered edge overshoots by about 9 % (Gibbs): ' + none.over.toFixed(3));
    for (const [f, p] of [['hamming'], ['hann'], ['tukey', 0.5], ['fermi', 0.5]]) {
        const v = overshoot({ filter: f, filterParam: p });
        ok(v.over < 0.5 * none.over, f + ' filter reduces the overshoot to ' + v.over.toFixed(4));
        near(v.centre, 1, 0.02, f + ' filter keeps the plateau at 1');
    }
    const t0 = overshoot({ filter: 'tukey', filterParam: 0 });
    near(t0.over, none.over, 1e-6, 'tukey with parameter 0 is no filter');
    const w = RC._internal.filterWeights('hann', 0.5, 8, 8);
    near(w[4 * 8 + 4], 1, 1e-12, 'filters are 1 at k = 0');
}

/* ---------- 5. zero filling interpolates (exact for a band-limited object) ---------- */
{
    const obj = makeObject([gauss(1, 0.02, 0.02, 0.030, -0.045)]);
    const r = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj }), { zeroFill: 2, coilCombine: 'roemer' });
    ok(r.image.nx === 2 * N && r.image.ny === 2 * N, 'zero-fill x2 doubles the matrix');
    near(r.image.fovX, FOV, 1e-12, 'zero-fill keeps the field of view');
    const e = maxErr(r.image, expected(obj, 2 * N, 2 * N, FOV, FOV, 2 * FOV, FOV));
    ok(e < 2e-4, 'zero-filled image matches the object on the finer grid (max error ' + e.toExponential(2) + ')');
}

/* ---------- 5b. odd matrix sizes: centring by floor(n/2) everywhere ---------- */
{
    const obj = makeObject([gauss(1, 0.015, 0.02, 0.020, -0.030), gauss(0.5, 0.008, 0.008, -0.04, 0.035, 0.7)]);
    for (const [nx, ny, os, axis, zf] of [[45, 37, 2, 'x', 1], [45, 37, 2, 'y', 1], [45, 37, 1, 'x', 1], [37, 45, 1, 'y', 2], [45, 37, 2, 'x', 2]]) {
        const fx = 0.20, fy = 0.22;
        const r = RC.run(cartesian({ nx, ny, fovX: fx, fovY: fy, os, axis, obj }), { coilCombine: 'roemer', zeroFill: zf });
        const label = 'odd matrix ' + nx + ' x ' + ny + ', os ' + os + ', readout ' + axis + ', zero-fill ' + zf;
        noFailNote(r, label);
        ok(r.info.cartesian && r.image.nx === nx * zf && r.image.ny === ny * zf, label + ': Cartesian, cropped size');
        const ex = expected(obj, nx * zf, ny * zf, fx, fy, axis === 'x' ? os * fx : fx, axis === 'y' ? os * fy : fy);
        const e = maxErr(r.image, ex);
        ok(e < 1e-4, label + ': image matches the object (max error ' + e.toExponential(2) + ')');
    }
}

/* ---------- 6. partial Fourier ---------- */
{
    const shapes = (ph) => [rect(1, 0.12, 0.15, 0, 0, ph), rect(0.5, 0.04, 0.03, 0.02, -0.03, ph), gauss(0.6, 0.01, 0.01, -0.03, 0.04, ph), disc(-0.4, 0.015, 0.03, 0.04, ph)];
    const cases = {
        real: makeObject(shapes(0.7)),                           // one overall phase only
        phase: makeObject(shapes(0.7), [2.0, 3.0])               // plus a linear phase: 2.6 rad across the object along y
    };
    const pfLines = Array.from({ length: N * 5 / 8 }, (_, i) => i + N * 3 / 8);    // 3N/8 .. N-1, as the gre_pf preset
    for (const name of ['real', 'phase']) {
        const obj = cases[name];
        const full = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj }), {});
        const acq = cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj, lines: pfLines });
        const err = {};
        for (const m of ['zero', 'conjugate', 'homodyne']) {
            const r = RC.run(acq, { partialFourier: m });
            noFailNote(r, 'partial Fourier ' + m);
            const d = new Float64Array(N * N);
            for (let i = 0; i < d.length; i++) d[i] = r.image.mag[i] - full.image.mag[i];
            err[m] = rms(d) / rms(full.image.mag);
            if (m === 'zero') {
                near(r.info.partialFourier, 0.625, 1e-12, 'partial Fourier fraction 5/8 detected');
                ok(hasNote(r, /Partial Fourier/), 'partial Fourier note');
            }
        }
        console.log('    partial Fourier, ' + name + ' object: relative error zero ' + err.zero.toFixed(4) + ', conjugate ' + err.conjugate.toFixed(4) + ', homodyne ' + err.homodyne.toFixed(4));
        ok(err.homodyne < 0.5 * err.zero, name + ' object: homodyne clearly beats zero-filling');
        if (name === 'real') ok(err.conjugate < 0.1 * err.zero, 'real object: conjugate synthesis is nearly exact');
        else ok(err.conjugate > 2 * err.homodyne, 'object with smooth phase: conjugate synthesis fails, homodyne does not');
    }
    // the missing block on the other side, and readout along y
    const obj = cases.phase;
    const hiLines = Array.from({ length: N * 5 / 8 }, (_, i) => i);
    const full = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'y', obj }), {});
    const acq = cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'y', obj, lines: hiLines });
    const ez = RC.run(acq, { partialFourier: 'zero' }), eh = RC.run(acq, { partialFourier: 'homodyne' });
    const dz = new Float64Array(N * N), dh = new Float64Array(N * N);
    for (let i = 0; i < dz.length; i++) { dz[i] = ez.image.mag[i] - full.image.mag[i]; dh[i] = eh.image.mag[i] - full.image.mag[i]; }
    near(ez.info.partialFourier, 0.625, 1e-12, 'partial Fourier on the high side, readout along y: fraction detected');
    ok(rms(dh) < 0.5 * rms(dz), 'high-side partial Fourier, readout along y: homodyne beats zero-filling');
}

/* ---------- 7. SENSE ---------- */
{
    const cs = MRI.fields.coilSet('head8');
    // a pixel object on the image grid, with structure and phase
    function pixelObject(nx, ny, fovX, fovY) {
        const o = makeObject([disc(0.8, 0.08, 0, 0), rect(0.4, 0.05, 0.03, 0.02, -0.04, 1.0), disc(-0.5, 0.02, -0.03, 0.03), gauss(0.5, 0.01, 0.02, 0.05, 0.05, -0.6)]);
        const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
        for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
            const v = o.value((ix - floor(nx / 2)) * fovX / nx, (iy - floor(ny / 2)) * fovY / ny);
            re[iy * nx + ix] = v[0]; im[iy * nx + ix] = v[1];
        }
        return { re, im };
    }
    /* Exact multi-coil k-space: transform C_c m on the (oversampled)
       image grid; the recon's inverse transform then returns C_c m. */
    function senseAcq(n, axis, lines) {
        const os = 2, W = axis === 'x' ? os * n : n, H = axis === 'x' ? n : os * n;
        const fx = axis === 'x' ? os * FOV : FOV, fy = axis === 'x' ? FOV : os * FOV;
        const m = pixelObject(W, H, fx, fy), maps = MRI.fields.coilMaps(cs, W, H, fx, fy), dA = (fx / W) * (fy / H);
        const table = [];
        for (let c = 0; c < 8; c++) {
            const re = new Float64Array(W * H), im = new Float64Array(W * H);
            for (let i = 0; i < W * H; i++) {
                re[i] = m.re[i] * maps.re[c][i] - m.im[i] * maps.im[c][i];
                im[i] = m.re[i] * maps.im[c][i] + m.im[i] * maps.re[c][i];
            }
            const K = U.fft2c(re, im, W, H);
            for (let i = 0; i < W * H; i++) { K.re[i] *= dA; K.im[i] *= dA; }
            table.push({ re: K.re, im: K.im, W });
        }
        const acq = cartesian({ nx: n, ny: n, fovX: FOV, fovY: FOV, os, axis, lines, nCoils: 8, coilSet: cs, table });
        const truth = pixelObject(n, n, FOV, FOV);
        return { acq, truth };
    }
    function relErr(r, truth) {
        let e = 0, s = 0;
        for (let i = 0; i < truth.re.length; i++) {
            e = Math.max(e, hypot(r.image.re[i] - truth.re[i], r.image.im[i] - truth.im[i]));
            s = Math.max(s, hypot(truth.re[i], truth.im[i]));
        }
        return e / s;
    }
    {
        const { acq, truth } = senseAcq(N, 'x');
        const r = RC.run(acq, { coilCombine: 'roemer' });
        const e = relErr(r, truth);
        ok(e < 1e-4, 'full sampling, 8 coils, Roemer combination recovers the object exactly (' + e.toExponential(2) + ')');
        const sos = RC.run(acq, { coilCombine: 'sos' });
        ok(sos.image.mag[64 * N + 64] > 0 && abs(sos.image.im[64 * N + 64]) === 0, 'sum of squares gives a magnitude image');
        const single = RC.run(acq, { coilCombine: 'single', coil: 3 });
        let d = 0; for (let i = 0; i < N * N; i++) d = Math.max(d, abs(single.image.re[i] - single.coilImages.re[3][i]));
        ok(d === 0 && single.coilImages.re.length === 8, 'single coil shows that coil\'s image');
    }
    for (const [n, axis, R, start] of [[N, 'x', 2, 0], [N, 'x', 2, 1], [N, 'y', 2, 0], [96, 'x', 3, 0], [N, 'x', 4, 2], [N, 'x', 3, 0]]) {
        const lines = []; for (let L = start; L < n; L += R) lines.push(L);
        const { acq, truth } = senseAcq(n, axis, lines);
        const label = 'SENSE R = ' + R + ', N = ' + n + ', readout ' + axis + ', first line ' + start;
        const r = RC.run(acq, { parallel: 'sense' });
        noFailNote(r, label);
        ok(r.info.undersampling === R, label + ': undersampling detected (' + r.info.undersampling + ')');
        const e = relErr(r, truth);
        const tol = n % R === 0 ? 1e-4 : 0.03;      // N = 128, R = 3 needs a padded grid and interpolation
        ok(e < tol, label + ': unfolded image matches the object (max error ' + e.toExponential(2) + ' of the peak)');
        ok(r.gfactor && r.gfactor.length === n * n, label + ': g-factor map returned');
        let gmin = Infinity, gmax = 0, gsum = 0, gn = 0;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const x = (ix - n / 2) * FOV / n, y = (iy - n / 2) * FOV / n;
            const g = r.gfactor[iy * n + ix];
            gmin = Math.min(gmin, g); gmax = Math.max(gmax, g);
            if (x * x + y * y < 0.08 * 0.08) { gsum += g; gn++; }
        }
        console.log('    ' + label + ': g-factor min ' + gmin.toFixed(4) + ', mean in head ' + (gsum / gn).toFixed(3) + ', max ' + gmax.toFixed(3));
        ok(gmin >= 1 - 1e-6, label + ': g-factor >= 1');
        if (R === 2) ok(gsum / gn < 1.3 && gmax < 2, label + ': g-factor modest');
        else ok(Number.isFinite(gmax), label + ': g-factor finite (higher R costs more, as it should)');
        if (R === 2 && start === 0 && axis === 'x') {
            const none = RC.run(acq, { parallel: 'none', coilCombine: 'roemer' });
            ok(relErr(none, truth) > 0.2, 'R = 2 without SENSE: the image is folded');
            ok(none.gfactor === null && hasNote(none, /folds/), 'R = 2 without SENSE: no g-factor, a note about folding');
            /* Each folded coil image at row j is C m at row j plus C m at
               row j + N/2, at full intensity (k = 0 is among the recorded
               lines, so the two copies add with no phase between them). */
            const one = RC.run(acq, { parallel: 'none', coilCombine: 'single', coil: 0 });
            const mp = MRI.fields.coilMaps(cs, n, n, FOV, FOV);
            let e = 0, m = 0;
            for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
                let er = 0, ei = 0;
                for (const yy of [iy, (iy + n / 2) % n]) {
                    const p = yy * n + ix, cr = mp.re[0][p], ci = mp.im[0][p];
                    er += cr * truth.re[p] - ci * truth.im[p]; ei += cr * truth.im[p] + ci * truth.re[p];
                }
                const p = iy * n + ix;
                e = Math.max(e, hypot(one.image.re[p] - er, one.image.im[p] - ei)); m = Math.max(m, hypot(er, ei));
            }
            ok(e < 1e-4 * m, 'R = 2 folded coil image = C m(y) + C m(y + FOV/2) (max error ' + (e / m).toExponential(2) + ' of the peak)');
        }
    }
    {
        // SENSE on a zero-filled grid agrees with the fully sampled Roemer image on that grid
        const lines = []; for (let L = 0; L < N; L += 2) lines.push(L);
        const full = senseAcq(N, 'x').acq, under = senseAcq(N, 'x', lines).acq;
        const a = RC.run(full, { coilCombine: 'roemer', zeroFill: 2 }), b = RC.run(under, { parallel: 'sense', zeroFill: 2 });
        let e = 0, m = 0;
        for (let i = 0; i < a.image.mag.length; i++) { e = Math.max(e, hypot(a.image.re[i] - b.image.re[i], a.image.im[i] - b.image.im[i])); m = Math.max(m, a.image.mag[i]); }
        ok(b.image.nx === 2 * N && e < 0.03 * m, 'SENSE R = 2 with zero-fill x2 matches full sampling (max difference ' + (e / m).toExponential(2) + ' of the peak)');
    }
    {
        // SENSE impossible with a single coil
        const obj = makeObject([gauss(1, 0.02, 0.02, 0, 0)]);
        const lines = []; for (let L = 0; L < N; L += 2) lines.push(L);
        const r = RC.run(cartesian({ nx: N, ny: N, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj, lines }), { parallel: 'sense' });
        ok(r.gfactor === null && hasNote(r, /at least R receive coils/), 'SENSE with one coil: folded image and an explanation');
        /* With the body coil the folded image is exact to compute: the
           object plus its copy shifted by FOV/2, at full intensity. */
        const ex = expected(obj, N, N, FOV, FOV, 2 * FOV, FOV / 2);
        let e = 0; for (let i = 0; i < N * N; i++) e = Math.max(e, abs(r.image.mag[i] - hypot(ex.re[i], ex.im[i])));
        ok(e < 1e-3, 'R = 2 folded image = object + copy shifted by FOV/2, full intensity (max error ' + e.toExponential(2) + ')');
    }
}

/* ---------- 8. radial gridding ---------- */
{
    const n = 64, obj = makeObject([gauss(1, 0.015, 0.015, 0, 0), gauss(0.6, 0.008, 0.008, 0.04, -0.03, 0.5), gauss(0.8, 0.006, 0.012, -0.045, 0.035)]);
    const ex = expected(obj, n, n, FOV, FOV, 0, 0);
    function radialAcq(spokes, nSamp, os, angleFn) {
        const dk = 1 / (FOV * os), readouts = [];
        for (let s = 0; s < spokes; s++) {
            const th = angleFn ? angleFn(s) : PI * s / spokes;
            const kx = new Float32Array(nSamp), ky = new Float32Array(nSamp), re = new Float32Array(nSamp), im = new Float32Array(nSamp);
            for (let j = 0; j < nSamp; j++) {
                const k = (j - floor(nSamp / 2)) * dk, KX = k * cos(th), KY = k * sin(th);
                kx[j] = KX; ky[j] = KY;
                const v = obj.ft(KX, KY); re[j] = v[0]; im[j] = v[1];
            }
            readouts.push({ index: s, te: 0.005, dwell: 1e-5, n: nSamp, kx, ky, re: [re], im: [im] });
        }
        return acqShell({ nx: n, ny: n, fovX: FOV, fovY: FOV, readoutAxis: 'radial', oversample: os }, readouts, 1);
    }
    function relRms(r) {
        const d = new Float64Array(2 * n * n), t = new Float64Array(2 * n * n);
        for (let i = 0; i < n * n; i++) { d[2 * i] = r.image.re[i] - ex.re[i]; d[2 * i + 1] = r.image.im[i] - ex.im[i]; t[2 * i] = ex.re[i]; t[2 * i + 1] = ex.im[i]; }
        return rms(d) / rms(t);
    }
    const acq = radialAcq(101, 2 * n, 2);
    const withDcf = RC.run(acq, { coilCombine: 'roemer' });
    const noDcf = RC.run(acq, { coilCombine: 'roemer', densityComp: false });
    noFailNote(withDcf, 'radial');
    ok(withDcf.info.cartesian === false, 'radial: detected as non-Cartesian');
    ok(withDcf.image.nx === n && withDcf.image.ny === n, 'radial: image cropped to ' + n + ' x ' + n);
    ok(withDcf.kspace.nx === 2 * n && withDcf.kspace.ny === 2 * n, 'radial: k-space shown on the 2x oversampled grid');
    const eD = relRms(withDcf), eN = relRms(noDcf);
    console.log('    radial gridding relative RMS error: with density compensation ' + eD.toFixed(4) + ', without ' + eN.toFixed(4));
    ok(eD < 0.01, 'radial with |k| density compensation: small gridding error');
    ok(eN > 10 * eD, 'radial without density compensation: much larger error');
    // without DCF the low frequencies dominate: the image is blurred (a sharp peak is lower relative to the broad one)
    const kSmall = (64 / 2 + Math.round(0.035 / (FOV / n))) * n + 32 - Math.round(0.045 / (FOV / n));
    ok(noDcf.image.mag[kSmall] / noDcf.image.mag[32 * n + 32] < 0.8 * withDcf.image.mag[kSmall] / withDcf.image.mag[32 * n + 32], 'radial without DCF: small features are blurred relative to large ones');
    let sD = 0, sN = 0;
    for (let i = 0; i < n * n; i++) { sD += withDcf.image.re[i]; sN += noDcf.image.re[i]; }
    ok(sN > 0.8 * sD && sN < 1.2 * sD, 'radial without DCF keeps the overall intensity (integral ratio ' + (sN / sD).toFixed(3) + ')');
    let nm = 0; for (let i = 0; i < withDcf.kspace.mask.length; i++) nm += withDcf.kspace.mask[i];
    ok(nm > 0.5 * 101 * 2 * n * 0.5, 'radial: sample mask marks the trajectory');
    ok(hasNote(withDcf, /ramp/), 'radial: note names the ramp density compensation');
    // too few spokes: note about streaks
    const few = RC.run(radialAcq(32, 2 * n, 2), {});
    ok(hasNote(few, /streaks/), 'radial with 32 spokes for N = 64: note about streaks');
    // golden-angle spokes (uneven) still reconstruct well with measured angular weights
    const golden = RC.run(radialAcq(101, 2 * n, 2, (s) => s * PI * 0.6180339887), { coilCombine: 'roemer' });
    const eG = relRms(golden);
    console.log('    golden-angle radial relative RMS error ' + eG.toFixed(4));
    ok(eG < 0.03, 'golden-angle radial: small error');

    /* A spiral is not radial, so its density compensation comes from
       Pipe-Menon iterations. */
    const arms = 24, turns = 2, ns = 700, kmax = n / (2 * FOV), readouts = [];
    for (let l = 0; l < arms; l++) {
        const kx = new Float32Array(ns), ky = new Float32Array(ns), re = new Float32Array(ns), im = new Float32Array(ns);
        for (let j = 0; j < ns; j++) {
            const t = j / (ns - 1), k = kmax * t, th = 2 * PI * turns * t + 2 * PI * l / arms;
            kx[j] = k * cos(th); ky[j] = k * sin(th);
            const v = obj.ft(kx[j], ky[j]); re[j] = v[0]; im[j] = v[1];
        }
        readouts.push({ index: l, te: 0.002, dwell: 4e-6, n: ns, kx, ky, re: [re], im: [im] });
    }
    const spiral = RC.run(acqShell({ nx: n, ny: n, fovX: FOV, fovY: FOV, readoutAxis: 'radial', oversample: 1 }, readouts, 1), { coilCombine: 'roemer' });
    noFailNote(spiral, 'spiral');
    const eS = relRms(spiral);
    console.log('    spiral (Pipe-Menon) relative RMS error ' + eS.toFixed(4));
    ok(hasNote(spiral, /Pipe-Menon/), 'spiral: Pipe-Menon density compensation used');
    ok(eS < 0.03, 'spiral with Pipe-Menon density compensation: small error');
}

/* ---------- 9. EPI Nyquist ghost correction ---------- */
{
    const n = 64, fov = 0.22, dk = 1 / fov;
    const obj = makeObject([gauss(1, 0.02, 0.015, 0, 0), gauss(0.5, 0.008, 0.008, 0.03, -0.02), gauss(0.7, 0.012, 0.01, -0.035, 0.025, 0.4)]);
    function epi(shift, phase, axis) {
        return cartesian({ nx: n, ny: n, fovX: fov, fovY: fov, os: 1, axis: axis || 'x', obj,
            reverse: (i) => i % 2 === 1, kshift: (rev) => (rev ? -shift : shift), extraPhase: (rev) => (rev ? phase : 0),
            te: (i) => 0.03 + (i - n / 2) * 0.0008 });
    }
    function ghostFraction(r, axis) {
        let g = 0, t = 0;
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const v = r.image.mag[iy * n + ix] ** 2, pe = axis === 'y' ? ix : iy;
            t += v;
            if (abs(pe - n / 2) * fov / n >= 0.07) g += v;      // beyond the object, where the N/2 ghost lands
        }
        return g / t;
    }
    for (const axis of ['x', 'y']) {
        const clean = RC.run(epi(0, 0, axis), {});
        noFailNote(clean, 'EPI clean ' + axis);
        ok(clean.info.cartesian, 'EPI (' + axis + '): reversed lines still on the Cartesian grid');
        const g0 = ghostFraction(clean, axis);
        const bad = epi(0.3 * dk, 0.5, axis);                 // a gradient delay plus a constant phase error
        const rb = RC.run(bad, {}), rc = RC.run(bad, { epiGhostCorr: true });
        const gb = ghostFraction(rb, axis), gc = ghostFraction(rc, axis);
        console.log('    EPI (' + axis + ') ghost energy fraction: ideal ' + g0.toExponential(2) + ', with timing error ' + gb.toFixed(4) + ', corrected ' + gc.toExponential(2));
        ok(gb > 0.02, 'EPI (' + axis + ') with a timing error: a visible N/2 ghost');
        ok(gc < 0.05 * gb, 'EPI (' + axis + ') ghost correction removes most of the ghost energy');
        ok(rc.info.epi && abs(rc.info.epi.phase0 - 0.5) < 0.05, 'EPI (' + axis + '): constant phase error estimated (' + (rc.info.epi && rc.info.epi.phase0.toFixed(3)) + ' rad, true 0.5)');
        /* forward lines see M(k - s), reversed ones M(k + s): in hybrid space
           phases +2 pi s x and -2 pi s x, so reversed minus forward is
           -4 pi s x, per pixel -4 pi s dx */
        const trueSlope = -4 * PI * 0.3 * dk * fov / n;
        ok(rc.info.epi && abs(rc.info.epi.slope - trueSlope) < 0.1 * abs(trueSlope), 'EPI (' + axis + '): linear phase error estimated (' + (rc.info.epi && rc.info.epi.slope.toFixed(4)) + ' rad/pixel, true ' + trueSlope.toFixed(4) + ')');
        const rcClean = RC.run(epi(0, 0, axis), { epiGhostCorr: true });
        ok(ghostFraction(rcClean, axis) < 2 * g0 + 1e-6, 'EPI (' + axis + '): correction leaves clean data clean');
    }
    const se = RC.run(cartesian({ nx: 32, ny: 32, fovX: fov, fovY: fov, os: 2, axis: 'x', obj }), { epiGhostCorr: true });
    ok(hasNote(se, /only when the readout alternates/), 'EPI correction on a non-EPI scan: explains that there is nothing to do');
}

/* ---------- 10. playback (upTo), odd inputs ---------- */
{
    const obj = makeObject([gauss(1, 0.02, 0.02, 0, 0)]);
    const acq = cartesian({ nx: 64, ny: 64, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj });
    const r0 = RC.run(acq, {}, { upTo: 0 });
    ok(r0.image.mag.every(v => v === 0) && r0.info.notes.length > 0, 'upTo 0: zero image with a note');
    const rh = RC.run(acq, {}, { upTo: 32 });
    let nm = 0; for (let i = 0; i < rh.kspace.mask.length; i++) nm += rh.kspace.mask[i];
    ok(nm === 32 * 128, 'upTo 32: only the first 32 readouts placed in k-space (' + nm + ' samples)');
    ok(rh.info.partialFourier === 1 && rh.info.undersampling === 1, 'upTo: the acquisition plan, not the readouts so far, decides partial Fourier and R');
    ok(hasNote(rh, /32 of 64 readouts/), 'upTo: note says how many readouts are shown');
    const odd = [
        null, undefined, {}, { grid: null }, { grid: { nx: 64, ny: 64, fovX: 0.24, fovY: 0.24 }, readouts: [] },
        { grid: { nx: 64, ny: 64, fovX: 0.24, fovY: 0.24, readoutAxis: 'x', oversample: 2 }, readouts: [null, {}, { kx: new Float32Array(0), ky: new Float32Array(0), re: [], im: [] }] },
        { grid: { nx: 'a', ny: -3, fovX: NaN, fovY: 0, readoutAxis: 'x' }, readouts: [{ kx: new Float32Array([0, 1]), ky: new Float32Array([0, 0]), re: [new Float32Array([NaN, 1])], im: [new Float32Array(2)] }] }
    ];
    let threw = false, allOk = true;
    for (const a of odd) {
        try {
            const r = RC.run(a, {}, {});
            if (!r || !r.image || !(r.image.mag instanceof Float32Array) || !Array.isArray(r.info.notes) || !r.kspace) allOk = false;
        } catch (e) { threw = true; console.error(e); }
    }
    ok(!threw && allOk, 'odd inputs never throw and still return a complete result');
    const fid = { grid: { nx: 64, ny: 64, fovX: 0.24, fovY: 0.24, readoutAxis: null, oversample: 1 },
        readouts: [{ kx: new Float32Array(256), ky: new Float32Array(256), re: [new Float32Array(256).fill(1)], im: [new Float32Array(256)], n: 256 }] };
    const rf = RC.run(fid, {});
    ok(rf.image.mag.every(v => v === 0) && hasNote(rf, /no spatial encoding/), 'readouts without spatial encoding: zero image and a note');
    const um2 = new Uint8Array(128 * 64);
    for (let iy = 24; iy < 40; iy++) for (let ix = 0; ix < 128; ix++) um2[iy * 128 + ix] = 1;
    const rc = RC.run(acq, { userMask: um2 });
    ok(hasNote(rc, /low resolution/) && rc.info.partialFourier === 1, 'user mask keeping only the centre: low-resolution note, not partial Fourier');
    const rn = RC.run(acq, null, null);
    ok(rn.image.nx === 64, 'null opts and extra use the defaults');
    ok(RC.defaults.filter === 'none' && RC.defaults.zeroFill === 1 && RC.defaults.cropOversampling === true && RC.defaults.densityComp === true &&
        RC.defaults.epiGhostCorr === false && RC.defaults.userMask === null && RC.defaults.coil === 0 &&
        RC.defaults.partialFourier === 'homodyne' && RC.defaults.parallel === 'sense' && RC.defaults.coilCombine === 'sos', 'defaults');

    // repeated samples at one point are averaged
    const a2 = cartesian({ nx: 32, ny: 32, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj });
    const r16 = a2.readouts[16];
    const copy = { ...r16, index: 99, re: [r16.re[0].map(v => v + 1)], im: [r16.im[0].slice()] };
    a2.readouts.push(copy);
    const ra = RC.run(a2, {});
    const p = 16 * 64 + 40;
    near(ra.kspace.re[0][p], r16.re[0][40] + 0.5, 1e-6, 'a k-space point recorded twice holds the average');
    ok(hasNote(ra, /averaged/), 'note about averaged repeats');

    // user mask: keep the lower half of k-space -> partial Fourier
    const big = cartesian({ nx: 64, ny: 64, fovX: FOV, fovY: FOV, os: 2, axis: 'x', obj });
    const um = new Uint8Array(128 * 64);
    for (let iy = 26; iy < 64; iy++) for (let ix = 0; ix < 128; ix++) um[iy * 128 + ix] = 1;
    const ru = RC.run(big, { userMask: um, partialFourier: 'homodyne' });
    ok(abs(ru.info.partialFourier - 38 / 64) < 1e-12 && hasNote(ru, /Homodyne/), 'user mask removing lines on one side is treated as partial Fourier');
    ok(ru.kspace.mask[10 * 128 + 64] === 0 && ru.kspace.re[0][10 * 128 + 64] === 0, 'user mask clears the removed k-space');
    // the same with the readout along y: the mask is given in image orientation, so the phase-encode lines are columns
    const bigY = cartesian({ nx: 64, ny: 64, fovX: FOV, fovY: FOV, os: 2, axis: 'y', obj });
    const umY = new Uint8Array(64 * 128);
    for (let iy = 0; iy < 128; iy++) for (let ix = 26; ix < 64; ix++) umY[iy * 64 + ix] = 1;
    const ruY = RC.run(bigY, { userMask: umY, partialFourier: 'homodyne' });
    ok(ruY.kspace.nx === 64 && ruY.kspace.ny === 128 && abs(ruY.info.partialFourier - 38 / 64) < 1e-12 && hasNote(ruY, /along x/),
        'user mask with the readout along y: columns removed on one side are partial Fourier along x');
    ok(ruY.kspace.mask[64 * 64 + 10] === 0 && ruY.kspace.mask[64 * 64 + 40] === 1, 'user mask with the readout along y: applied in image orientation');
}

/* ---------- 11. speed ---------- */
{
    const cs = MRI.fields.coilSet('head8'), n = 128, os = 2, nro = n * os, rng = U.rng(5);
    const readouts = [];
    for (let L = 0; L < n; L++) {
        const kx = new Float32Array(nro), ky = new Float32Array(nro), re = [], im = [];
        for (let j = 0; j < nro; j++) { kx[j] = (j - nro / 2) / (FOV * os); ky[j] = (L - n / 2) / FOV; }
        for (let c = 0; c < 8; c++) {
            const a = new Float32Array(nro), b = new Float32Array(nro);
            for (let j = 0; j < nro; j++) { a[j] = rng.randn(); b[j] = rng.randn(); }
            re.push(a); im.push(b);
        }
        readouts.push({ index: L, te: 0.01, dwell: 1e-5, n: nro, kx, ky, re, im });
    }
    const acq = acqShell({ nx: n, ny: n, fovX: FOV, fovY: FOV, readoutAxis: 'x', oversample: os }, readouts, 8, cs);
    function timeIt(opts, extra) {
        const ts = [];
        for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); RC.run(acq, opts, extra); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
        ts.sort((a, b) => a - b);
        return ts[3];
    }
    const tDef = timeIt({}), tPlay = timeIt({}, { upTo: 64 }), tRoe = timeIt({ coilCombine: 'roemer', filter: 'hamming' }), tZf = timeIt({ zeroFill: 2 });
    console.log('    timing, 128 x 128, os 2, 8 coils (median of 7): default ' + tDef.toFixed(1) + ' ms, playback half ' + tPlay.toFixed(1) +
        ' ms, Roemer + Hamming ' + tRoe.toFixed(1) + ' ms, zero-fill x2 ' + tZf.toFixed(1) + ' ms');
    ok(tDef < 100, 'default reconstruction of 128 x 128 x 8 coils with os 2 under 100 ms (' + tDef.toFixed(1) + ' ms)');
    ok(tPlay < 100, 'playback reconstruction under 100 ms (' + tPlay.toFixed(1) + ' ms)');
    ok(tRoe < 150, 'Roemer + filter under 150 ms (' + tRoe.toFixed(1) + ' ms)');
}

summary('recon');
