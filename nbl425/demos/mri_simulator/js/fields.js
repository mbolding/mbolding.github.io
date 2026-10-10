/* ============================================================
   MRI Simulator, fields: B0 map, B1 map and receive coils

   Three spatial maps that sit between the object and the signal:

   - b0Map: how far each point is off resonance (Hz), from the
     phantom's own susceptibility pattern plus whatever the shim has
     failed to remove. Off-resonance shifts and distorts the image and
     dephases gradient echoes.
   - b1Map: how strongly the RF transmit field reaches each point,
     relative to nominal. At 3 T the RF wavelength in tissue (about
     12 cm) is comparable to the head, so the field is brighter in the
     centre and weaker at the edge (the "dielectric effect"), and the
     flip angle varies across the image.
   - coilMaps: the complex receive sensitivity of each coil element.
     A small loop coil sees tissue near it strongly and far tissue
     weakly; combining several loops gives SNR near the surface and
     the spatial information that parallel imaging (SENSE) exploits.

   All coordinates follow ARCHITECTURE.md section 3: pixel index i sits
   at (i - floor(n/2)) * spacing, x to the right, y down. Units are SI
   (metres, Hz). See section 7 for the contract.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;

    // Local names for Math functions used in the per-pixel loops.
    const { PI, cos, sin, floor, sqrt } = Math;

    /* ---------- B0 ---------- */

    /* The residual field a shim leaves behind, in Hz at (x, y) metres,
       for shim = 1. A real shim removes the first- and second-order
       spherical harmonics of the field as well as it can; when it is
       degraded what is left looks like a gentle tilt plus a bowl:
         25 Hz per 100 mm along x, -15 Hz per 100 mm along y,
         +40 Hz at 100 mm from the centre, growing as r^2. */
    function shimResidual(x, y) {
        return 250 * x - 150 * y + 40 * (x * x + y * y) / 0.01;
    }

    /* Off-resonance map in Hz on the phantom raster, excluding chemical
       shift (the engine adds that per tissue). b0 = {susceptibility,
       shim}: susceptibility scales the phantom's intrinsic pattern
       (0 removes it, 3 exaggerates it), shim scales the residual above.
       Air pixels are 0: with no spins there, the off-resonance has no
       meaning (and a measured field map would be masked there too). */
    function b0Map(phantom, b0) {
        b0 = b0 || {};
        const susc = b0.susceptibility === undefined ? 1 : (Number(b0.susceptibility) || 0);
        const shim = Number(b0.shim) || 0;
        const n = phantom.n, d = phantom.dx, h = floor(n / 2);
        const label = phantom.label, dB0 = phantom.dB0;
        const out = new Float32Array(n * n);
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * d;
            for (let ix = 0; ix < n; ix++) {
                const i = iy * n + ix;
                if (!label[i]) continue;
                let f = susc * dB0[i];
                if (shim) f += shim * shimResidual((ix - h) * d, y);
                out[i] = f;
            }
        }
        return out;
    }

    /* ---------- B1 (transmit) ---------- */

    /* Relative transmit field at radius r (metres) for a given amount
       of dielectric effect: 1 + amount (0.6 - (r / 90 mm)^2), clipped to
       [0.4, 1.6]. With amount 0.3 the centre gets 18 percent more flip
       angle than nominal, the map crosses 1 at r = 70 mm, and at 90 mm
       (the edge of the brain) the flip angle is 12 percent low. */
    function b1At(x, y, amount) {
        if (!amount) return 1;
        const q = (x * x + y * y) / (0.09 * 0.09);
        const v = 1 + amount * (0.6 - q);
        return v < 0.4 ? 0.4 : (v > 1.6 ? 1.6 : v);
    }

    /* Transmit scale on the phantom raster (1 = nominal flip angle).
       Evaluated everywhere, air included, because B1 is a property of
       the RF field rather than of the spins; display code may mask it
       with the label map. b1 = {amount}, 0 to 0.5. */
    function b1Map(phantom, b1) {
        const amount = (b1 && Number(b1.amount)) || 0;
        const n = phantom.n, d = phantom.dx, h = floor(n / 2);
        const out = new Float32Array(n * n);
        if (!amount) { out.fill(1); return out; }
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * d;
            for (let ix = 0; ix < n; ix++) out[iy * n + ix] = b1At((ix - h) * d, y, amount);
        }
        return out;
    }

    /* ---------- Receive coils ---------- */

    /* Eight-channel head coil. Loops sit evenly round an ellipse of
       105 mm by 125 mm semi-axes (wider front to back, like the head),
       offset by half a step so that no element sits exactly on the
       midline. Element k is at angle -90 + 22.5 + 45 k degrees, going
       clockwise on screen from the front; positive x is the patient's
       left (radiological convention). */
    const HEAD8 = {
        semiX: 0.105, semiY: 0.125,
        loopRadius: 0.06,              // a, the distance over which a loop's sensitivity falls off
        phaseSlope: 5,                 // rad/m: about 1 rad across a 0.2 m head
        // fixed per-element phase offsets (cable lengths, preamplifiers): arbitrary but reproducible
        phase0: [0.0, 1.9, -2.4, 0.7, 2.8, -1.1, 1.3, -2.9],
        names: ['Left anterior', 'Left anterolateral', 'Left posterolateral', 'Left posterior',
            'Right posterior', 'Right posterolateral', 'Right anterolateral', 'Right anterior']
    };

    /* Sensitivity magnitude of a loop at distance d from it, before
       normalisation: the on-axis field of a circular loop of radius a,
       proportional to 1 / (1 + (d/a)^2)^(3/2). By reciprocity the
       field a coil would make per unit current is its receive
       sensitivity. */
    function loopMag(d2, a2) {
        const q = 1 + d2 / a2;
        return 1 / (q * sqrt(q));
    }

    function coilSet(type) {
        type = type || 'body';
        if (type === 'body') {
            /* The body coil is the large birdcage built into the bore.
               Over a head it is close to uniform, and here exactly so:
               sensitivity 1, phase 0. */
            return { type: 'body', n: 1, names: ['Body coil'], positions: [{ x: 0, y: 0 }], radius: 0.30, scale: 1 };
        }
        if (type !== 'head8') throw new Error('Unknown coil set "' + type + '" (use "body" or "head8")');
        const positions = [], phase0 = [], phaseDir = [];
        for (let k = 0; k < 8; k++) {
            const phi = -PI / 2 + PI / 8 + k * PI / 4;
            positions.push({ x: HEAD8.semiX * cos(phi), y: HEAD8.semiY * sin(phi) });
            phase0.push(HEAD8.phase0[k]);
            // each element's phase ramps along its own direction (its local
            // tangent, turned a little), so no two elements share a pattern
            const psi = phi + PI / 2 + 0.4;
            phaseDir.push({ x: cos(psi), y: sin(psi) });
        }
        const cs = {
            type: 'head8', n: 8, names: HEAD8.names.slice(), positions: positions,
            radius: HEAD8.loopRadius,
            ellipse: { a: HEAD8.semiX, b: HEAD8.semiY },
            phase0: phase0, phaseDir: phaseDir, phaseSlope: HEAD8.phaseSlope,
            scale: 1
        };
        /* Normalise: the root-sum-of-squares of the eight magnitudes,
           averaged over a disk of 70 mm radius, is 1. The average is
           taken on a fixed 1 mm grid, independent of any image grid, so
           every caller sees the same maps. */
        const a2 = cs.radius * cs.radius;
        let sum = 0, count = 0;
        for (let iy = -70; iy <= 70; iy++) for (let ix = -70; ix <= 70; ix++) {
            if (ix * ix + iy * iy > 70 * 70) continue;
            const x = ix * 1e-3, y = iy * 1e-3;
            let ss = 0;
            for (let k = 0; k < 8; k++) {
                const dx = x - positions[k].x, dy = y - positions[k].y, m = loopMag(dx * dx + dy * dy, a2);
                ss += m * m;
            }
            sum += sqrt(ss); count++;
        }
        cs.scale = count / sum;
        return cs;
    }

    /* Complex sensitivity maps on an nx by ny grid covering fovX by fovY
       metres, evaluated at pixel centres (section 3 convention).
       Returns {re: [Float32Array per coil], im: [...]}. The maps are
       computed once per (coil set, grid) and cached; each call returns
       fresh copies, so callers may modify them. */
    const mapCache = new Map();
    const MAP_CACHE_MAX = 6;
    function coilKey(cs, nx, ny, fovX, fovY) {
        return [cs.type, cs.n, cs.scale, cs.radius, nx, ny, fovX, fovY,
            JSON.stringify(cs.positions), JSON.stringify(cs.phase0 || null), JSON.stringify(cs.phaseDir || null), cs.phaseSlope || 0].join('|');
    }
    function computeMaps(cs, nx, ny, fovX, fovY) {
        const re = [], im = [];
        const N = nx * ny;
        if (cs.type === 'body') {
            const r = new Float32Array(N); r.fill(1);
            re.push(r); im.push(new Float32Array(N));
            return { re: re, im: im };
        }
        const dxp = fovX / nx, dyp = fovY / ny, hx = floor(nx / 2), hy = floor(ny / 2);
        const a2 = cs.radius * cs.radius;
        for (let k = 0; k < cs.n; k++) {
            const r = new Float32Array(N), q = new Float32Array(N);
            const px = cs.positions[k].x, py = cs.positions[k].y;
            const p0 = cs.phase0 ? cs.phase0[k] : 0;
            const ux = cs.phaseDir ? cs.phaseDir[k].x * cs.phaseSlope : 0;
            const uy = cs.phaseDir ? cs.phaseDir[k].y * cs.phaseSlope : 0;
            // The phase p0 + ux x + uy y is linear, so exp(i phase) factors
            // into a row term times a column term: no trigonometry per pixel.
            const cx = new Float64Array(nx), sx = new Float64Array(nx);
            for (let ix = 0; ix < nx; ix++) { const a = p0 + ux * (ix - hx) * dxp; cx[ix] = cos(a); sx[ix] = sin(a); }
            for (let iy = 0; iy < ny; iy++) {
                const y = (iy - hy) * dyp, dy = y - py, cy = cos(uy * y), sy = sin(uy * y);
                for (let ix = 0; ix < nx; ix++) {
                    const dx = (ix - hx) * dxp - px;
                    const m = cs.scale * loopMag(dx * dx + dy * dy, a2);
                    const i = iy * nx + ix;
                    r[i] = m * (cx[ix] * cy - sx[ix] * sy);      // m cos(phase)
                    q[i] = m * (sx[ix] * cy + cx[ix] * sy);      // m sin(phase)
                }
            }
            re.push(r); im.push(q);
        }
        return { re: re, im: im };
    }
    function coilMaps(cs, nx, ny, fovX, fovY) {
        if (typeof cs === 'string') cs = coilSet(cs);
        ny = ny || nx;
        fovY = fovY || fovX;
        const key = coilKey(cs, nx, ny, fovX, fovY);
        let maps = mapCache.get(key);
        if (!maps) {
            maps = computeMaps(cs, nx, ny, fovX, fovY);
            mapCache.set(key, maps);
            while (mapCache.size > MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value);
        }
        return { re: maps.re.map(function (a) { return a.slice(); }), im: maps.im.map(function (a) { return a.slice(); }) };
    }

    /* Root-sum-of-squares of the coil magnitudes (a convenience for the
       phantom tab's "coil RSS" view and for tests). */
    function rss(maps) {
        const nC = maps.re.length, N = maps.re[0].length, out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let s = 0;
            for (let k = 0; k < nC; k++) s += maps.re[k][i] * maps.re[k][i] + maps.im[k][i] * maps.im[k][i];
            out[i] = sqrt(s);
        }
        return out;
    }

    MRI.fields = {
        b0Map: b0Map,
        b1Map: b1Map,
        coilSet: coilSet,
        coilMaps: coilMaps,
        rss: rss,
        shimResidual: shimResidual,
        b1At: b1At,
        defaults: { b0: { susceptibility: 1, shim: 0 }, b1: { amount: 0 } }
    };

})(typeof window !== 'undefined' ? window : globalThis);
