/* ============================================================
   PET Simulator, phantoms
   The objects the scanner can image: a label raster (which region
   each pixel belongs to), the list of regions with their tissue,
   attenuation and, for test objects, relative activity, and the
   511 keV attenuation (mu) map that follows from the labels.

   Four test objects filled with a solution of the isotope (line
   sources, a uniform cylinder, NEMA-like hot and cold spheres, a
   Derenzo-style hot-rod phantom) and one schematic brain whose
   activity comes from the compartment models in kinetics.js.

   Everything lives on the same raster: 256 x 256 pixels of 1.25 mm
   over the 320 mm field of view, pixel (ix, iy) at
   x = (ix - 128) * 1.25 mm, y = (iy - 128) * 1.25 mm, x to the right
   and y DOWN the screen. The brain is shown in radiological
   convention: anterior at the top (negative y), the patient's right
   on the image left (negative x). Labels are hard (no anti-aliasing),
   so imaging at 2.5 mm shows partial volume, as a real scanner would.
   No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    // A local binding for Math: the per-pixel loops below call it often, and
    // a global lookup is slow in some hosts (Node's vm sandbox that runs the
    // tests resolves every global through an interceptor).
    const Math = root.Math;

    const N = 256, FOV = 320, DX = FOV / N, H = Math.floor(N / 2);

    /* Linear attenuation at 511 keV, 1/mm (ARCHITECTURE.md section 6). */
    const MU = { air: 0, water: 0.0096, soft: 0.0096, brain: 0.0099, blood: 0.0099, bone: 0.0151, lung: 0.0030, pmma: 0.0103 };

    function coord(i) { return (i - H) * DX; }

    function region(id, name, color, tissue, mu, rel, roi, extra) {
        return Object.assign({ id: id, name: name, color: color, mu: mu, tissue: tissue, rel: rel, pixels: 0, volume: 0, roi: !!roi }, extra || {});
    }

    /* Paint every pixel whose centre satisfies inside(x, y) with label v,
       scanning only the bounding box [x0, x1] x [y0, y1] (mm). */
    function paint(label, v, x0, x1, y0, y1, inside) {
        if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
        if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
        const i0 = Math.max(0, Math.floor(x0 / DX) + H - 1), i1 = Math.min(N - 1, Math.ceil(x1 / DX) + H + 1);
        const j0 = Math.max(0, Math.floor(y0 / DX) + H - 1), j1 = Math.min(N - 1, Math.ceil(y1 / DX) + H + 1);
        for (let iy = j0; iy <= j1; iy++) {
            const y = coord(iy);
            for (let ix = i0; ix <= i1; ix++) if (inside(coord(ix), y)) label[iy * N + ix] = v;
        }
    }
    function paintDisk(label, v, cx, cy, r) {
        const r2 = r * r;
        paint(label, v, cx - r, cx + r, cy - r, cy + r, function (x, y) { return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2; });
    }

    /* Count pixels, work out volumes (mL, the slice extruded over the
       object's axial length) and the mu map from the labels. Landmarks
       are 'structure' unless marked otherwise ('orientation' for the
       R, L, A, P letters of the brain). */
    function finish(ph) {
        ph.landmarks.forEach(function (l) { if (!l.kind) l.kind = 'structure'; });
        const counts = new Int32Array(ph.regions.length);
        for (let k = 0; k < ph.label.length; k++) counts[ph.label[k]]++;
        ph.regions.forEach(function (r, i) {
            r.index = i;
            r.pixels = counts[i];
            r.volume = counts[i] * DX * DX * ph.axialLength / 1000;
        });
        const mu = new Float32Array(N * N);
        for (let k = 0; k < mu.length; k++) mu[k] = ph.regions[ph.label[k]].mu;
        ph.mu = mu;
        return ph;
    }

    function base(def, opts, extra) {
        return Object.assign({
            id: def.id, name: def.name, description: def.description, kind: def.kind,
            n: N, fov: FOV, dx: DX,
            label: new Uint8Array(N * N), regions: [], mu: null,
            axialLength: 100, outsideFraction: 0, condition: null,
            landmarks: [], notes: '', opts: opts
        }, extra || {});
    }

    const AIR = function () { return region('air', 'Air', '#1c2128', 'air', MU.air, 0, false); };

    /* ---------- 1. line sources ----------
       Thin capillaries along the scanner axis; in one slice each is a
       single pixel, the PET equivalent of a point spread function
       measurement (NEMA NU 2 uses sources at 1, 10 and 20 cm). */
    function buildPoint(def, o) {
        const ph = base(def, o, { axialLength: 50 });
        ph.regions.push(AIR());
        if (o.medium === 'water') {
            ph.regions.push(region('water', 'Water cylinder (no activity)', '#5ba7e6', 'water', MU.water, 0, false));
            paintDisk(ph.label, 1, 0, 0, 100);
        }
        const SRC = [
            { id: 'src_0', name: 'Source at the centre', x: 0, y: 0, color: '#f2c440' },
            { id: 'src_50', name: 'Source at x = 50 mm', x: 50, y: 0, color: '#ef9636' },
            { id: 'src_100', name: 'Source at x = 100 mm', x: 100, y: 0, color: '#e8636f' },
            { id: 'src_top', name: 'Source at y = -100 mm', x: 0, y: -100, color: '#ad7bdc' }
        ];
        SRC.forEach(function (s) {
            const idx = ph.regions.length;
            ph.regions.push(region(s.id, s.name, s.color, 'water', MU.water, 1, true, { cx: s.x, cy: s.y }));
            ph.label[(Math.round(s.y / DX) + H) * N + Math.round(s.x / DX) + H] = idx;
            ph.landmarks.push({ name: s.name, x: s.x, y: s.y });
        });
        ph.notes = 'Four capillary line sources seen end on, each one 1.25 mm pixel. ' +
            (o.medium === 'water'
                ? 'They sit in a 200 mm water cylinder with no activity, so the photons are attenuated and scattered on the way out (the sources at 100 mm are at its edge).'
                : 'In air nothing attenuates or scatters, so the image shows the resolution of the scanner and the reconstruction alone.') +
            ' Resolution worsens away from the centre because of depth-of-interaction parallax.';
        return finish(ph);
    }

    /* ---------- 2. uniform cylinder ---------- */
    function buildCylinder(def, o) {
        const ph = base(def, o, { axialLength: 200 });
        ph.regions.push(AIR());
        ph.regions.push(region('wall', 'PMMA wall (3 mm)', '#cdbd8f', 'plastic', MU.pmma, 0, false));
        ph.regions.push(region('water', 'Uniform solution', '#5ba7e6', 'water', MU.water, 1, true));
        paintDisk(ph.label, 1, 0, 0, 103);
        paintDisk(ph.label, 2, 0, 0, 100);
        ph.landmarks.push({ name: 'Centre', x: 0, y: 0 }, { name: 'Wall', x: 101.5, y: 0 });
        ph.notes = 'A 200 mm cylinder of uniform activity in a 3 mm acrylic wall: the reference object for uniformity, ' +
            'calibration (6.28 L, so 40 MBq gives about 6.4 kBq/mL) and the cupping that uncorrected attenuation causes.';
        return finish(ph);
    }

    /* ---------- 3. hot and cold spheres (NEMA IEC-like) ---------- */
    const SPHERES = [
        { d: 10, kind: 'hot' }, { d: 13, kind: 'hot' }, { d: 17, kind: 'hot' },
        { d: 22, kind: 'hot' }, { d: 28, kind: 'cold' }, { d: 37, kind: 'cold' }
    ];
    function buildSpheres(def, o) {
        const ph = base(def, o, { axialLength: 180 });
        ph.regions.push(AIR());
        ph.regions.push(region('wall', 'PMMA wall (3 mm)', '#cdbd8f', 'plastic', MU.pmma, 0, false));
        ph.regions.push(region('background', 'Background', '#5ba7e6', 'water', MU.water, 1, true));
        paintDisk(ph.label, 1, 0, 0, 118);
        paintDisk(ph.label, 2, 0, 0, 115);
        if (o.lung) {
            const li = ph.regions.length;
            ph.regions.push(region('lung', 'Lung insert (51 mm, no activity)', '#a7b1bf', 'lung', MU.lung, 0, true, { diameter: 51, cx: 0, cy: 0 }));
            paintDisk(ph.label, li, 0, 0, 25.5);
            ph.landmarks.push({ name: 'Lung insert', x: 0, y: 0 });
        }
        const colors = { 10: '#f2c440', 13: '#ef9636', 17: '#e8636f', 22: '#f08cb6', 28: '#3e68d6', 37: '#8e95ea' };
        // Centred on a circle of 57.2 mm at 60 degree steps, smallest at the
        // upper right, going clockwise on screen to the largest at the upper left.
        SPHERES.forEach(function (s, k) {
            const ang = (-60 + 60 * k) * Math.PI / 180, cx = 57.2 * Math.cos(ang), cy = 57.2 * Math.sin(ang);
            const idx = ph.regions.length;
            ph.regions.push(region('sphere' + s.d, s.d + ' mm ' + s.kind + ' sphere', colors[s.d], 'water', MU.water,
                s.kind === 'hot' ? o.ratio : 0, true, { diameter: s.d, kind: s.kind, cx: cx, cy: cy }));
            paintDisk(ph.label, idx, cx, cy, s.d / 2);
            ph.landmarks.push({ name: s.d + ' mm', x: cx, y: cy });
        });
        ph.notes = 'NEMA IEC-like image quality phantom: hot spheres at ' + o.ratio + ':1 to the background and two cold ones. ' +
            'In a single slice through their centres the spheres act as rods of the same diameter, so recovery is a little ' +
            'better than for real spheres. Watch how the small hot spheres lose contrast (partial volume).';
        return finish(ph);
    }

    /* ---------- 4. hot rods (Derenzo-style) ----------
       Six 60 degree sectors, each a triangular lattice of rods whose
       spacing (centre to centre) is twice their diameter. The smallest
       rods you can still separate measure the system resolution. */
    const RODS = [3, 4, 5, 6, 8, 10];
    function buildRods(def, o) {
        const ph = base(def, o, { axialLength: 100 });
        ph.regions.push(AIR());
        ph.regions.push(region('wall', 'PMMA wall (3 mm)', '#cdbd8f', 'plastic', MU.pmma, 0, false));
        ph.regions.push(region('water', 'Water (no activity)', '#5ba7e6', 'water', MU.water, 0, false));
        paintDisk(ph.label, 1, 0, 0, 103);
        paintDisk(ph.label, 2, 0, 0, 100);
        const colors = ['#f2c440', '#ef9636', '#e8636f', '#f08cb6', '#ad7bdc', '#21a99a'];
        const rMax = 92;
        RODS.forEach(function (d, k) {
            const ang = (-90 + 60 * k) * Math.PI / 180, ux = Math.cos(ang), uy = Math.sin(ang), vx = -uy, vy = ux;
            const s = 2 * d, r0 = d + 6, idx = ph.regions.length, centres = [];
            for (let j = 0; ; j++) {
                const dist = r0 + j * s * Math.sqrt(3) / 2;
                if (dist + d / 2 > rMax) break;
                for (let i = 0; i <= j; i++) {
                    const off = (i - j / 2) * s, cx = dist * ux + off * vx, cy = dist * uy + off * vy;
                    if (Math.hypot(cx, cy) + d / 2 <= rMax) centres.push([cx, cy]);
                }
            }
            ph.regions.push(region('rods' + d, d + ' mm rods', colors[k], 'water', MU.water, 1, true,
                { diameter: d, spacing: s, centres: centres, angle: -90 + 60 * k }));
            centres.forEach(function (c) { paintDisk(ph.label, idx, c[0], c[1], d / 2); });
            ph.landmarks.push({ name: d + ' mm', x: (r0 + 0.5 * (rMax - r0)) * ux, y: (r0 + 0.5 * (rMax - r0)) * uy });
        });
        ph.notes = 'Hot rods of 3 to 10 mm in a cold water cylinder, spaced two diameters apart. With 18F the 4 mm rods ' +
            'separate; switch the isotope to 15O and the long positron range blurs the small sectors together.';
        return finish(ph);
    }

    /* ---------- 5. brain ---------- */
    // built in its own section below
    let brainGeom = null;

    function buildBrain(def, o) {
        if (!brainGeom) brainGeom = makeBrain();
        const ph = base(def, o, { axialLength: 150, outsideFraction: 0.3, condition: o.condition });
        ph.label = brainGeom.label;
        ph.regions = brainGeom.regions.map(function (r) { return Object.assign({}, r); });
        ph.landmarks = brainGeom.landmarks.map(function (l) { return Object.assign({}, l); });
        const cond = PET.kinetics && PET.kinetics.conditions ? PET.kinetics.conditions.find(function (c) { return c.id === o.condition; }) : null;
        ph.name = 'Brain' + (o.condition === 'normal' ? '' : ' (' + (cond ? cond.name : o.condition) + ')');
        ph.notes = 'A schematic oblique axial slice through the striatum, tilted so the cerebellum (the usual reference region) ' +
            'is in the same plane, as some PET protocols angle the slice. Shown in radiological convention: the patient\'s right ' +
            'is on the image left. Activity in every region comes from a compartment model and the tracer\'s input function. ' +
            'The anatomy is the same in every condition, only the kinetics change (no atrophy is modelled).';
        return finish(ph);
    }

    /* ---------- registry, options and cache ---------- */
    const LIST = [
        { id: 'point', name: 'Line sources', kind: 'solution', build: buildPoint,
            description: 'Four thin line sources seen end on, for measuring spatial resolution across the field of view.',
            options: [{ key: 'medium', label: 'Medium', type: 'select', default: 'air',
                values: [{ value: 'air', label: 'Air' }, { value: 'water', label: 'Water cylinder (200 mm)' }] }] },
        { id: 'cylinder', name: 'Uniform cylinder', kind: 'solution', build: buildCylinder,
            description: 'A 200 mm water cylinder of uniform activity: uniformity, calibration and attenuation.',
            options: [] },
        { id: 'spheres', name: 'Hot and cold spheres', kind: 'solution', build: buildSpheres,
            description: 'NEMA IEC-like phantom: six spheres of 10 to 37 mm and a lung insert in a warm background, for contrast recovery and partial volume.',
            options: [
                { key: 'ratio', label: 'Hot sphere to background', type: 'select', default: 4,
                    values: [{ value: 2, label: '2 : 1' }, { value: 4, label: '4 : 1' }, { value: 8, label: '8 : 1' }, { value: 16, label: '16 : 1' }] },
                { key: 'lung', label: 'Lung insert', type: 'bool', default: true }
            ] },
        { id: 'rods', name: 'Hot rods (Derenzo-style)', kind: 'solution', build: buildRods,
            description: 'Six sectors of hot rods from 3 to 10 mm in a cold cylinder: resolution and positron range at a glance.',
            options: [] },
        { id: 'brain', name: 'Brain', kind: 'brain', build: buildBrain,
            description: 'A schematic oblique axial slice through the striatum and cerebellum, with tracer kinetics for a healthy brain, Alzheimer\'s or Parkinson\'s disease.',
            options: [{ key: 'condition', label: 'Condition', type: 'select', default: 'normal',
                values: [{ value: 'normal', label: 'Normal' }, { value: 'ad', label: 'Alzheimer\'s disease' }, { value: 'pd', label: 'Parkinson\'s disease' }] }] }
    ];

    function def(id) {
        const d = LIST.find(function (p) { return p.id === id; });
        if (!d) throw new Error('Unknown phantom "' + id + '". Choose one of: ' + LIST.map(function (p) { return p.id; }).join(', ') + '.');
        return d;
    }

    /* Fill in defaults and check values, in a fixed key order so the
       cache key does not depend on how the caller wrote the object. */
    function resolveOptions(d, opts) {
        opts = opts || {};
        const out = {};
        d.options.forEach(function (od) {
            let v = opts[od.key];
            if (v === undefined || v === null || v === '') v = od.default;
            if (od.type === 'bool') v = v === true || v === 'true' || v === 1 || v === '1';
            else if (od.type === 'number') {
                v = Number(v);
                if (!isFinite(v)) throw new Error('Option "' + od.key + '" of the ' + d.name + ' phantom must be a number.');
                if (od.min !== undefined) v = Math.max(od.min, v);
                if (od.max !== undefined) v = Math.min(od.max, v);
            } else if (od.type === 'select') {
                const hit = od.values.find(function (x) { return String(x.value) === String(v); });
                if (!hit) throw new Error('Option "' + od.key + '" of the ' + d.name + ' phantom must be one of: ' +
                    od.values.map(function (x) { return x.value; }).join(', ') + ' (got "' + v + '").');
                v = hit.value;
            }
            out[od.key] = v;
        });
        return out;
    }

    const cache = new Map();
    function build(id, opts) {
        const d = def(id), o = resolveOptions(d, opts);
        const key = id + ':' + JSON.stringify(o);
        if (cache.has(key)) return cache.get(key);
        const ph = d.build(d, o);
        cache.set(key, ph);
        return ph;
    }

    function list() {
        return LIST.map(function (d) {
            return { id: d.id, name: d.name, description: d.description, kind: d.kind,
                options: d.options.map(function (o) { return Object.assign({}, o, o.values ? { values: o.values.slice() } : {}); }) };
        });
    }

    /* Index of a region by id, or -1. */
    function regionIndex(ph, id) {
        for (let i = 0; i < ph.regions.length; i++) if (ph.regions[i].id === id) return i;
        return -1;
    }

    PET.phantoms = {
        list: list, build: build,
        clearCache: function () { cache.clear(); brainGeom = null; },
        regionIndex: regionIndex,
        MU: MU, N: N, FOV: FOV, DX: DX
    };

    /* ============================================================
       The brain.
       A schematic oblique axial slice: through the heads of the caudate
       nuclei, the putamen and the thalami in front, tilted down at the
       back so that it passes under the tentorium through the upper
       cerebellum. Every outline is a smooth radius function (a
       superellipse modulated by a few sinusoids) or an ellipse, and the
       sulci are smooth curves. The cortex is the 3 mm of tissue next to
       any surface CSF, found with a distance transform, so it follows
       every sulcus the way a real cortical ribbon does.
       Distances in mm, angles about the head centre: phi = 0 anterior
       (up), +90 deg the image right (the patient's LEFT), +-180 posterior.
       ============================================================ */
    const BRAIN_REGIONS = [
        ['air', 'Air', '#1c2128', 'air', MU.air, false],
        ['scalp', 'Scalp', '#c58b6c', 'soft', MU.soft, false],
        ['skull', 'Skull', '#cdbd8f', 'bone', MU.bone, false],
        ['csf', 'CSF (sulci, fissures, cisterns)', '#5ba7e6', 'csf', MU.water, false],
        ['ventricles', 'Ventricles', '#3e68d6', 'csf', MU.water, false],
        ['wm', 'White matter', '#a7b1bf', 'wm', MU.brain, true],
        ['gm_frontal', 'Frontal cortex', '#e8636f', 'gm', MU.brain, true],
        ['gm_temporal', 'Temporal cortex', '#ef9636', 'gm', MU.brain, true],
        ['gm_occipital', 'Occipital cortex', '#ad7bdc', 'gm', MU.brain, true],
        ['caudate_r', 'Caudate, right', '#21a99a', 'gm', MU.brain, true],
        ['caudate_l', 'Caudate, left', '#5dbb63', 'gm', MU.brain, true],
        ['putamen_r_ant', 'Putamen, right anterior', '#f2c440', 'gm', MU.brain, true],
        ['putamen_r_post', 'Putamen, right posterior', '#bf9228', 'gm', MU.brain, true],
        ['putamen_l_ant', 'Putamen, left anterior', '#f08cb6', 'gm', MU.brain, true],
        ['putamen_l_post', 'Putamen, left posterior', '#c4547e', 'gm', MU.brain, true],
        ['thalamus', 'Thalamus', '#8e95ea', 'gm', MU.brain, true],
        ['cereb_gm', 'Cerebellar gray matter', '#b5d14a', 'gm', MU.brain, true],
        ['cereb_wm', 'Cerebellar white matter', '#7d8897', 'wm', MU.brain, true],
        ['sinus', 'Venous sinuses (blood)', '#b5212e', 'blood', MU.blood, true]
    ];
    // Region indices, written out so the object has a fixed shape (it is
    // read in every per-pixel loop); checked against the table at load.
    const B = { air: 0, scalp: 1, skull: 2, csf: 3, ventricles: 4, wm: 5, gm_frontal: 6, gm_temporal: 7, gm_occipital: 8,
        caudate_r: 9, caudate_l: 10, putamen_r_ant: 11, putamen_r_post: 12, putamen_l_ant: 13, putamen_l_post: 14,
        thalamus: 15, cereb_gm: 16, cereb_wm: 17, sinus: 18 };
    BRAIN_REGIONS.forEach(function (r, i) { if (B[r[0]] !== i) throw new Error('phantoms.js: brain region table out of order at ' + r[0]); });

    const D2R = Math.PI / 180;
    function superR(phi, a, b, p) {
        const s = Math.abs(Math.sin(phi)) / a, c = Math.abs(Math.cos(phi)) / b;
        return Math.pow(Math.pow(s, p) + Math.pow(c, p), -1 / p);
    }
    /* Inner table of the skull: a superellipse (flatter sides than an
       ellipse), a little narrower in front than behind (the head is egg
       shaped), with a gentle four-fold modulation. */
    function innerTableExact(phi) {
        const s = Math.sin(phi), c = Math.cos(phi);
        let r = superR(phi, 64, 82, 2.4);
        r *= 1 - 0.045 * c * s * s;
        r *= 1 + 0.008 * Math.cos(4 * phi);
        return r;
    }
    /* Bone 5 mm over the temporal squama to 7 mm front and back, thicker
       at the internal occipital protuberance; scalp 3 to 4 mm. */
    function skullExact(phi) {
        const dp = Math.PI - Math.abs(phi);
        return 6 + Math.cos(2 * phi) + 1.5 * Math.exp(-(dp / 0.16) * (dp / 0.16));
    }
    function scalpExact(phi) { return 3.5 + 0.5 * Math.cos(2 * phi); }
    /* The radius functions are tabulated every 0.25 degree, which keeps
       building the phantom fast. */
    const LUT_N = 1440, LUT = { it: null, sk: null, sc: null };
    function lutBuild() {
        if (LUT.it) return;
        LUT.it = new Float64Array(LUT_N + 1); LUT.sk = new Float64Array(LUT_N + 1); LUT.sc = new Float64Array(LUT_N + 1);
        for (let i = 0; i <= LUT_N; i++) {
            const phi = -Math.PI + 2 * Math.PI * i / LUT_N;
            LUT.it[i] = innerTableExact(phi); LUT.sk[i] = skullExact(phi); LUT.sc[i] = scalpExact(phi);
        }
    }
    function lut(arr, phi) {
        const f = (phi + Math.PI) / (2 * Math.PI) * LUT_N, i = Math.min(LUT_N - 1, Math.max(0, Math.floor(f))), g = f - i;
        return arr[i] * (1 - g) + arr[i + 1] * g;
    }
    function innerTable(phi) { lutBuild(); return lut(LUT.it, phi); }
    const CSF_SHELL = 2.7;                            // subarachnoid CSF over the convexity, mm
    function brainR(phi) { return innerTable(phi) - CSF_SHELL; }
    function onBrain(phi, extra) { const r = brainR(phi) + (extra || 0); return [r * Math.sin(phi), -r * Math.cos(phi)]; }
    function dirDeg(deg) { return [Math.sin(deg * D2R), -Math.cos(deg * D2R)]; }   // 0 = anterior, +90 = image right
    function at(x, y) { return (Math.round(y / DX) + H) * N + Math.round(x / DX) + H; }

    /* Paint a stroke along a polyline [[x, y], ...] with label v: every
       pixel whose centre lies within the half-width hw (mm) of the curve.
       hw is a number or a function of s, the fraction of the way along
       (0 at the first point, 1 at the last), so strokes can taper. Done
       by stamping discs every 0.25 mm along the curve. `only` restricts
       painting to pixels that currently hold one of those labels. */
    function stroke(label, v, pts, hw, only) {
        const hwf = typeof hw === 'function' ? hw : function () { return hw; };
        let total = 0;
        for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        total = total || 1;
        let done = 0;
        for (let k = 0; k + 1 < pts.length; k++) {
            const ax = pts[k][0], ay = pts[k][1], vx = pts[k + 1][0] - ax, vy = pts[k + 1][1] - ay, L = Math.hypot(vx, vy);
            const steps = Math.max(1, Math.ceil(L / 0.25));
            for (let q = (k === 0 ? 0 : 1); q <= steps; q++) {
                const t = q / steps, px = ax + vx * t, py = ay + vy * t, h = hwf((done + L * t) / total), h2 = h * h;
                const r = Math.ceil(h / DX), cx = Math.round(px / DX) + H, cy = Math.round(py / DX) + H;
                for (let iy = Math.max(0, cy - r); iy <= Math.min(N - 1, cy + r); iy++) {
                    const dy = coord(iy) - py;
                    for (let ix = Math.max(0, cx - r); ix <= Math.min(N - 1, cx + r); ix++) {
                        const dx = coord(ix) - px, kk = iy * N + ix;
                        if (dx * dx + dy * dy > h2 || label[kk] === v) continue;
                        if (only && only.indexOf(label[kk]) < 0) continue;
                        label[kk] = v;
                    }
                }
            }
            done += L;
        }
    }
    /* Rotated (super)ellipse: centre (cx, cy), semi-axis b along the unit
       vector (ux, uy) and a across it, exponent p (2 = ellipse). */
    function inEllipse(x, y, cx, cy, a, b, ux, uy, p) {
        const dx = x - cx, dy = y - cy, along = (dx * ux + dy * uy) / b, across = (-dx * uy + dy * ux) / a;
        if (!p || p === 2) return along * along + across * across <= 1;
        return Math.pow(Math.abs(along), p) + Math.pow(Math.abs(across), p) <= 1;
    }
    /* A smooth curve through control points (Catmull-Rom), sampled. */
    function smoothCurve(ctrl, perSeg) {
        const out = [], n = ctrl.length;
        for (let k = 0; k + 1 < n; k++) {
            const p0 = ctrl[Math.max(0, k - 1)], p1 = ctrl[k], p2 = ctrl[k + 1], p3 = ctrl[Math.min(n - 1, k + 2)];
            for (let q = 0; q < perSeg; q++) {
                const t = q / perSeg, t2 = t * t, t3 = t2 * t;
                out.push([0, 1].map(function (c) {
                    return 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3);
                }));
            }
        }
        out.push(ctrl[n - 1].slice());
        return out;
    }

    /* Squared Euclidean distance transform (Felzenszwalb and Huttenlocher
       2012): for every pixel, the squared distance in pixels to the
       nearest pixel where inside[] is 0. Two separable passes of the
       lower envelope of parabolas, exact and O(n^2). */
    function distanceTransform(inside, win) {
        const BIG = 1e12, f = new Float64Array(N), d = new Float64Array(N), v = new Int32Array(N), z = new Float64Array(N + 1);
        const out = new Float64Array(N * N);
        const i0 = win ? win[0] : 0, i1 = win ? win[1] : N - 1, j0 = win ? win[2] : 0, j1 = win ? win[3] : N - 1;
        function pass1d(n) {
            let k = 0; v[0] = 0; z[0] = -BIG; z[1] = BIG;
            for (let q = 1; q < n; q++) {
                let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
                while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
                k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
            }
            k = 0;
            for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
        }
        // Work inside the window (the mask must be empty outside it).
        const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
        for (let x = i0; x <= i1; x++) {
            for (let y = 0; y < ny; y++) f[y] = inside[(y + j0) * N + x] ? BIG : 0;
            pass1d(ny);
            for (let y = 0; y < ny; y++) out[(y + j0) * N + x] = d[y];
        }
        for (let y = j0; y <= j1; y++) {
            for (let x = 0; x < nx; x++) f[x] = out[y * N + x + i0];
            pass1d(nx);
            for (let x = 0; x < nx; x++) out[y * N + x + i0] = d[x];
        }
        return out;
    }

    function makeBrain() {
        lutBuild();
        const label = new Uint8Array(N * N);
        const rng = PET.util.rng(425);
        const landmarks = [];
        function mark(name, x, y) { landmarks.push({ name: name, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, kind: 'structure' }); }

        /* 1. Scalp, skull, and the CSF-filled cranial cavity. Everything
           happens inside a window around the head (W), which keeps the
           build fast; the rest of the raster stays air (label 0). */
        const W = [H - 66, H + 66, H - 84, H + 84];          // ix0, ix1, iy0, iy1
        const phiMap = new Float32Array(N * N);
        for (let iy = W[2]; iy <= W[3]; iy++) {
            const y = coord(iy);
            for (let ix = W[0]; ix <= W[1]; ix++) {
                const x = coord(ix), k = iy * N + ix, r = Math.sqrt(x * x + y * y);
                if (r > 112) { label[k] = B.air; continue; }
                const phi = Math.atan2(x, -y);
                phiMap[k] = phi;
                const f = (phi + Math.PI) / (2 * Math.PI) * LUT_N, i = Math.min(LUT_N - 1, Math.floor(f)), g = f - i;
                const ri = LUT.it[i] * (1 - g) + LUT.it[i + 1] * g;
                const rs = ri + LUT.sk[i] * (1 - g) + LUT.sk[i + 1] * g;
                const ro = rs + LUT.sc[i] * (1 - g) + LUT.sc[i + 1] * g;
                if (r > ro) label[k] = B.air;
                else if (r > rs) label[k] = B.scalp;
                else if (r > ri) label[k] = B.skull;
                else if (r > ri - CSF_SHELL) label[k] = B.csf;
                else label[k] = B.wm;                       // parenchyma for now, refined below
            }
        }

        /* 2. Tentorium and posterior fossa. The tentorium cerebelli is a
           tent of dura: in this tilted slice it shows as a V opening
           backwards, its apex at the incisura behind the midbrain, its
           limbs running back and out to the transverse sinuses on the
           inner table. Cerebellum inside the V, occipital lobes outside. */
        const apex = [0, 33], phiT = 154 * D2R, rT = innerTable(phiT);
        const tEnd = [rT * Math.sin(phiT), -rT * Math.cos(phiT)];
        const tentR = smoothCurve([apex, [12, 38.5], [24, 49], [tEnd[0] - 2.5, tEnd[1] - 7.5], tEnd], 6);
        const tentL = tentR.map(function (p) { return [-p[0], p[1]]; });
        function tentY(ax) {                      // y of the tentorium at |x| = ax
            if (ax <= 0) return apex[1];
            for (let k = 0; k + 1 < tentR.length; k++) {
                const a = tentR[k], b = tentR[k + 1];
                if (ax >= a[0] && ax <= b[0]) return a[1] + (b[1] - a[1]) * (ax - a[0]) / ((b[0] - a[0]) || 1);
            }
            return Infinity;
        }
        const inCereb = new Uint8Array(N * N);
        for (let ix = W[0]; ix <= W[1]; ix++) {
            const ax = Math.abs(coord(ix));
            if (ax > tEnd[0]) continue;
            const yt = tentY(ax);
            for (let iy = Math.max(W[2], Math.floor(yt / DX) + H); iy <= W[3]; iy++) {
                const k = iy * N + ix;
                if (label[k] === B.wm && coord(iy) > yt) inCereb[k] = 1;
            }
        }
        stroke(label, B.csf, tentR, 1.25, [B.wm]);
        stroke(label, B.csf, tentL, 1.25, [B.wm]);

        /* 3. Fissures and sulci of the cerebrum (CSF clefts). */
        // Interhemispheric fissure from the frontal pole back to the genu
        // of the corpus callosum (the falx runs down its middle).
        const yFront = -innerTable(0);
        stroke(label, B.csf, [[0, yFront], [0.5, -62], [0, -45]], function (s) { return s < 0.08 ? 1.6 : 1.05; }, [B.wm]);
        // Medial frontal sulci branching off the fissure.
        [[-1, -73, 10, 112], [-1, -57, 12, 126], [1, -68, 12, 116], [1, -53, 8, 132]].forEach(function (b) {
            const sd = b[0], y0 = b[1], L = b[2], d = dirDeg(sd * b[3]);
            stroke(label, B.csf, smoothCurve([[0, y0], [d[0] * 0.5 * L, y0 + d[1] * 0.5 * L - 1.2], [d[0] * L, y0 + d[1] * L]], 4), 0.95, [B.wm]);
        });
        // Sylvian fissures: a stem from the lateral surface to the insula,
        // then the circular sulcus running forwards and backwards along it.
        [-1, 1].forEach(function (sd) {
            const e = onBrain(sd * 72 * D2R, 2), ins = [sd * 41.5, -4];
            stroke(label, B.csf, smoothCurve([e, [sd * 53, -11], ins], 5), function (s) { return 2.4 - 1.0 * s; }, [B.wm]);
            stroke(label, B.csf, smoothCurve([ins, [sd * 40, -13], [sd * 36.5, -22]], 4), 1.0, [B.wm]);
            stroke(label, B.csf, smoothCurve([ins, [sd * 42.5, 5], [sd * 41.5, 14]], 4), 1.0, [B.wm]);
            mark('Sylvian fissure', sd * 55, -12);
            mark('Insula', sd * 38.5, -4);
        });
        // Convexity sulci: clefts 12 to 24 mm deep every 11 to 15 mm round
        // the surface, each bending and wandering a little, widening into a
        // notch at the surface so the gyral crowns come out rounded, and
        // about half with a side branch.
        [-1, 1].forEach(function (sd) {
            let deg = 7 + 2 * rng();
            while (deg < 149) {
                if (deg > 61 && deg < 81) { deg = 81 + 3 * rng(); continue; }       // the Sylvian fissure is there
                const phi = sd * deg * D2R;
                const p0 = onBrain(phi, 1.5), pa = onBrain(phi - 0.01, 0), pb = onBrain(phi + 0.01, 0);
                let tx = pb[0] - pa[0], ty = pb[1] - pa[1];
                const tl = Math.hypot(tx, ty); tx /= tl; ty /= tl;
                let nx = -ty, ny = tx;
                if (nx * p0[0] + ny * p0[1] > 0) { nx = -nx; ny = -ny; }          // inward
                const rr = Math.hypot(p0[0], p0[1]);
                nx = 0.7 * nx - 0.3 * p0[0] / rr; ny = 0.7 * ny - 0.3 * p0[1] / rr;
                const tilt = (rng() - 0.5) * 30 * D2R, ct = Math.cos(tilt), st = Math.sin(tilt);
                const rx = nx * ct - ny * st, ry = nx * st + ny * ct;
                const nl = Math.hypot(rx, ry); nx = rx / nl; ny = ry / nl;
                let depth = 12 + 12 * rng();
                if (deg > 128) depth *= 0.8;                                      // occipital pole
                const bend = (rng() - 0.5) * 12, wig = (rng() - 0.5) * 5;
                const ctrl = [];
                for (let q = 0; q <= 4; q++) {
                    const t = q / 4, w = Math.sin(Math.PI * t) * wig;
                    ctrl.push([p0[0] + nx * depth * t + tx * (bend * t * t + w), p0[1] + ny * depth * t + ty * (bend * t * t + w)]);
                }
                const pts = smoothCurve(ctrl, 4), mouth = 4.0 / (depth + 1.5);
                stroke(label, B.csf, pts, function (s) { return s < mouth ? 2.6 - 1.6 * s / mouth : 1.0; }, [B.wm]);
                if (rng() < 0.5) {
                    const from = pts[Math.round((pts.length - 1) * (0.45 + 0.25 * rng()))], sgn = rng() < 0.5 ? -1 : 1;
                    const ang = (40 + 25 * rng()) * D2R, L = 5 + 5 * rng();
                    const bx = nx * Math.cos(ang) + sgn * tx * Math.sin(ang), by = ny * Math.cos(ang) + sgn * ty * Math.sin(ang);
                    stroke(label, B.csf, smoothCurve([from, [from[0] + bx * L * 0.5 + nx * 1, from[1] + by * L * 0.5 + ny * 1], [from[0] + bx * L, from[1] + by * L]], 3), 0.9, [B.wm]);
                }
                deg += 9.5 + 3.5 * rng();
            }
        });

        /* 4. Cerebral cortex: the parenchyma within about 3 mm of CSF on
           the brain surface. Lobes by angle about the centre: frontal in
           front of the Sylvian fissure, temporal at the side, occipital
           behind, above the tentorium. */
        const cerebrum = new Uint8Array(N * N);
        for (let k = 0; k < N * N; k++) cerebrum[k] = label[k] === B.wm && !inCereb[k] ? 1 : 0;
        const dC = distanceTransform(cerebrum, W), RIB2 = Math.pow(3.6 / DX, 2);
        for (let k = 0; k < N * N; k++) {
            if (!cerebrum[k] || dC[k] > RIB2) continue;
            const deg = Math.abs(phiMap[k]) / D2R;
            label[k] = deg < 68 ? B.gm_frontal : (deg < 122 ? B.gm_temporal : B.gm_occipital);
        }
        mark('Frontal cortex', -30, -62);
        mark('Temporal cortex', 58, 12);
        mark('Occipital cortex', -48, 50);

        /* 5. Deep gray matter and ventricles, painted over white matter. */
        [-1, 1].forEach(function (sd) {
            const caud = sd < 0 ? B.caudate_r : B.caudate_l;
            const putA = sd < 0 ? B.putamen_r_ant : B.putamen_l_ant, putP = sd < 0 ? B.putamen_r_post : B.putamen_l_post;
            const side = sd < 0 ? 'R' : 'L';
            // Caudate head: an egg, broad in front where it bulges into the
            // frontal horn, tapering backwards along the ventricle.
            const cu = dirDeg(sd * 10), cc = [sd * 11.8, -19.5];
            paint(label, caud, sd * 3, sd * 22, -36, -4, function (x, y) {
                const along = (x - cc[0]) * cu[0] + (y - cc[1]) * cu[1];
                return label[at(x, y)] === B.wm && inEllipse(x, y, cc[0], cc[1], 5.4 * (1 + 0.22 * along / 10.5), 10.5, cu[0], cu[1]);
            });
            // Putamen: the outer, lens-shaped part of the lentiform nucleus,
            // lateral to the internal capsule, its front end tilted towards
            // the midline; split at its midpoint into anterior and posterior.
            const pu = dirDeg(-sd * 14), pc = [sd * 25.5, -6];
            paint(label, putA, pc[0] - 12, pc[0] + 12, -26, 14, function (x, y) {
                return inEllipse(x, y, pc[0], pc[1], 5.6, 15.5, pu[0], pu[1], 2.3) && (x - pc[0]) * pu[0] + (y - pc[1]) * pu[1] > 0;
            });
            paint(label, putP, pc[0] - 12, pc[0] + 12, -26, 14, function (x, y) {
                return inEllipse(x, y, pc[0], pc[1], 5.6, 15.5, pu[0], pu[1], 2.3) && (x - pc[0]) * pu[0] + (y - pc[1]) * pu[1] <= 0;
            });
            // Thalamus: an ovoid each side of the third ventricle, the back
            // ends (pulvinar) splaying outwards.
            const tu = dirDeg(-sd * 16), tc = [sd * 10.5, 9];
            paint(label, B.thalamus, sd * 1, sd * 24, -8, 28, function (x, y) {
                const along = (x - tc[0]) * tu[0] + (y - tc[1]) * tu[1];        // + towards the front
                return Math.abs(x) >= 1.9 && label[at(x, y)] === B.wm &&
                    inEllipse(x, y, tc[0], tc[1], 8.6 * (1 - 0.22 * along / 14), 14, tu[0], tu[1]);
            });
            // Frontal horn of the lateral ventricle: a teardrop whose tip
            // points forwards and outwards, its outer wall pushed in by the
            // caudate head, which gives the pair its butterfly shape.
            const hu = dirDeg(sd * 26), hc = [sd * 5.8, -25];
            paint(label, B.ventricles, sd * 0.5, sd * 18, -42, -8, function (x, y) {
                if (Math.abs(x) < 1.3) return false;                           // septum pellucidum
                const along = (x - hc[0]) * hu[0] + (y - hc[1]) * hu[1];
                return label[at(x, y)] === B.wm && inEllipse(x, y, hc[0], hc[1], 5.0 * (1 + 0.45 * along / 12.5), 12.5, hu[0], hu[1]);
            });
            mark('Caudate head (' + side + ')', cc[0], cc[1]);
            mark('Putamen (' + side + ')', pc[0], pc[1]);
            mark('Thalamus (' + side + ')', sd * 10.5, 9);
            mark('Frontal horn (' + side + ')', sd * 7, -27);
            mark('Internal capsule (' + side + ')', sd * 18.5, -4);
        });
        // Third ventricle: a midline slit between the thalami.
        paint(label, B.ventricles, -3, 3, -11, 24, function (x, y) {
            return Math.abs(x) < 1.9 * (1 - Math.pow(Math.abs(y - 6.5) / 17, 6));
        });
        // Quadrigeminal cistern behind the thalami at the tentorial incisura.
        paint(label, B.csf, -14, 14, 20, 34, function (x, y) {
            return label[at(x, y)] === B.wm && (inEllipse(x, y, 0, 28.5, 3.3, 11, 1, 0) || inEllipse(x, y, 0, 26, 2.2, 4, 0, 1));
        });
        mark('Third ventricle', 0, 6);
        mark('Interhemispheric fissure', 0, -62);
        mark('Genu of corpus callosum', 0, -40);

        /* 6. Cerebellum: two hemispheres and the vermis inside the
           tentorial V; gray-matter folia around a white-matter core whose
           branches reach out into them (the arbor vitae). */
        const yPost = brainR(Math.PI), yInner = innerTable(Math.PI);
        // Posterior cerebellar notch (falx cerebelli) at the midline.
        paint(label, B.csf, -9, 9, yPost - 18, yPost + 1, function (x, y) {
            const t = (y - (yPost - 15)) / 15;                     // 0 at the tip, 1 at the surface
            return inCereb[at(x, y)] && t > 0 && Math.abs(x) < 1.2 + 4.8 * t * t * t;
        });
        // Paravermian sulci between the vermis and the hemispheres.
        [-1, 1].forEach(function (sd) {
            stroke(label, B.csf, smoothCurve([[sd * 6, yPost - 3], [sd * 9.5, yPost - 12], [sd * 9, yPost - 22]], 4), 0.9, [B.wm]);
        });
        const cb = new Uint8Array(N * N);
        for (let k = 0; k < N * N; k++) cb[k] = inCereb[k] && label[k] === B.wm ? 1 : 0;
        const dB = distanceTransform(cb, W);
        // Folia: the cerebellar cortex is folded into thin leaves running
        // parallel to the surface. Draw the fissures between them as the
        // edges of the depth levels (every 3.75 mm, two deep), which gives
        // continuous curves following the tentorium and the occipital bone.
        const FOL = 3.75, lev = new Int8Array(N * N);
        for (let k = 0; k < N * N; k++) lev[k] = cb[k] ? Math.min(3, Math.floor(Math.sqrt(dB[k]) * DX / FOL)) : -1;
        for (let iy = W[2]; iy <= W[3]; iy++) for (let ix = W[0]; ix <= W[1]; ix++) {
            const k = iy * N + ix;
            if (!cb[k]) continue;
            label[k] = B.cereb_gm;
            const l = lev[k], x = coord(ix);
            if (l < 1 || l > 2 || Math.abs(x) < 7) continue;
            if (lev[k - 1] === l - 1 || lev[k + 1] === l - 1 || lev[k - N] === l - 1 || lev[k + N] === l - 1) label[k] = B.csf;
        }
        // Vermis: its folia run across the midline, seen as short
        // transverse fissures in the posterior half.
        for (let y = apex[1] + 19; y < yPost - 4; y += 4.4) {
            stroke(label, B.csf, [[-5, y + 0.8], [0, y], [5, y + 0.8]], 0.6, [B.cereb_gm]);
        }
        // White matter: the deep core of each hemisphere (corpus medullare
        // around the dentate nucleus) and branches running straight out
        // across the folia towards the surface (the arbor vitae), traced
        // down the gradient of the depth.
        const depthF = function (x, y) {               // bilinear depth below the cerebellar surface, mm
            const fx = x / DX + H, fy = y / DX + H, i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
            const g = function (ii, jj) { const k = jj * N + ii; return cb[k] ? Math.sqrt(dB[k]) * DX : 0; };
            return (g(i, j) * (1 - a) + g(i + 1, j) * a) * (1 - b) + (g(i, j + 1) * (1 - a) + g(i + 1, j + 1) * a) * b;
        };
        [-1, 1].forEach(function (sd) {
            const cc = [sd * 17.5, 61], cu = dirDeg(sd * 148), A = 3.6, Bl = 8.5;
            paint(label, B.cereb_wm, cc[0] - 12, cc[0] + 12, cc[1] - 12, cc[1] + 12, function (x, y) {
                return cb[at(x, y)] && inEllipse(x, y, cc[0], cc[1], A, Bl, cu[0], cu[1]);
            });
            // branches leave the rim of the core and run down the depth
            // gradient, across the folia, to within 2.4 mm of the surface
            for (let t = 0; t < 360; t += 40) {
                const ct = Math.cos(t * D2R), st = Math.sin(t * D2R);
                let x = cc[0] + 0.8 * (Bl * ct * cu[0] - A * st * cu[1]), y = cc[1] + 0.8 * (Bl * ct * cu[1] + A * st * cu[0]);
                if (!cb[at(x, y)] || (x - cc[0]) * sd < -1.5) continue;               // keep them off the vermis
                const pts = [cc.slice(), [x, y]];
                for (let q = 0; q < 40; q++) {
                    const gx = depthF(x + 0.7, y) - depthF(x - 0.7, y), gy = depthF(x, y + 0.7) - depthF(x, y - 0.7), gl = Math.hypot(gx, gy);
                    if (gl < 1e-6) break;
                    x -= 0.6 * gx / gl; y -= 0.6 * gy / gl;
                    if (depthF(x, y) < 2.4) break;
                    pts.push([x, y]);
                }
                if (pts.length > 4) stroke(label, B.cereb_wm, pts, function (s) { return 1.1 - 0.45 * s; }, [B.cereb_gm, B.csf]);
            }
            mark('Cerebellar white matter (' + (sd < 0 ? 'R' : 'L') + ')', cc[0], cc[1]);
        });
        mark('Tentorium', tentR[13][0] + 3, tentR[13][1] - 3);
        mark('Cerebellar hemisphere', -24, 60);
        mark('Vermis', 0, yPost - 20);

        /* 7. Venous sinuses: the confluence (torcular) at the back, where
           the straight, superior sagittal and transverse sinuses meet on
           the inner table, and the superior sagittal sinus in front. */
        const rS = 4.6, cS = [0, yInner - rS + 0.6];
        paint(label, B.sinus, -rS, rS, cS[1] - rS, cS[1] + rS, function (x, y) {
            return x * x + (y - cS[1]) * (y - cS[1]) <= rS * rS && label[at(x, y)] !== B.skull;
        });
        paint(label, B.sinus, -4, 4, yFront - 1, yFront + 6, function (x, y) {
            const l = label[at(x, y)];
            return l !== B.skull && l !== B.scalp && l !== B.air && y >= yFront - 0.5 && Math.abs(x) <= 3.4 * (1 - (y - yFront) / 5.5);
        });
        mark('Confluence of sinuses', 0, cS[1]);
        mark('Superior sagittal sinus', 0, yFront + 1.5);

        // Orientation markers (radiological convention).
        const side = innerTable(Math.PI / 2) + 20;
        landmarks.push({ name: 'R', x: -side, y: 0, kind: 'orientation' }, { name: 'L', x: side, y: 0, kind: 'orientation' },
            { name: 'A', x: 0, y: yFront - 20, kind: 'orientation' }, { name: 'P', x: 0, y: yInner + 20, kind: 'orientation' });

        const regions = BRAIN_REGIONS.map(function (r) { return region(r[0], r[1], r[2], r[3], r[4], null, r[5]); });
        return { label: label, regions: regions, landmarks: landmarks };
    }

})(typeof window !== 'undefined' ? window : globalThis);
