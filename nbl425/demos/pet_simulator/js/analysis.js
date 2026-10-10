/* ============================================================
   PET Simulator, image analysis
   What students measure on a reconstructed image: regions of
   interest drawn from the phantom's own labels (so an ROI always
   sits exactly on the anatomy), ROI statistics, the true image for
   comparison, line profiles and FWHM, NEMA NU 2 image-quality
   numbers on the sphere phantom, partial-volume correction with the
   geometric transfer matrix (GTM), time-activity curves from a
   series of frames, and SUV.

   Geometry: images are m x m over the 320 mm field of view (the
   reconstruction grid); phantoms are rasters of n x n (256) over the
   same field of view. Both put pixel (i, j) at
   x = (i - floor(n/2)) dx, y = (j - floor(n/2)) dx, in mm, y down.
   No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;
    const FOV = (PET.scanner && PET.scanner.geom && PET.scanner.geom.fov) || 320;

    /* ---------- region fractions ----------
       How much of each image pixel every phantom region fills. Each
       phantom pixel is a small square; it adds the area it shares with
       each image pixel, divided by the image pixel's area. Along one
       axis that is an overlap length, so the 2D weight is the product of
       two 1D overlaps. At 128 x 128 an image pixel holds four phantom
       pixels; at 256 it is one-to-one. The fractions of all regions add
       up to 1 in every pixel, and a region's fractions add up to its
       area. This is the partial-volume effect of the image grid itself,
       before any blurring. */
    const fracCache = new WeakMap();
    function axisOverlap(nF, dF, m, dC) {
        const out = [], hF = Math.floor(nF / 2), hC = Math.floor(m / 2);
        for (let i = 0; i < nF; i++) {
            const a = (i - hF) * dF - dF / 2, b = a + dF, list = [];
            const j0 = Math.floor((a + dC / 2) / dC) + hC, j1 = Math.floor((b + dC / 2) / dC) + hC;
            for (let j = j0; j <= j1; j++) {
                if (j < 0 || j >= m) continue;
                const ca = (j - hC) * dC - dC / 2, cb = ca + dC;
                const ov = Math.min(b, cb) - Math.max(a, ca);
                if (ov > 1e-9 * dF) list.push(j, ov / dC);
            }
            out.push(list);
        }
        return out;
    }
    function regionFractions(phantom, m) {
        let byM = fracCache.get(phantom);
        if (!byM) { byM = {}; fracCache.set(phantom, byM); }
        if (byM[m]) return byM[m];
        const n = phantom.n, nReg = phantom.regions.length, label = phantom.label;
        const dF = phantom.dx || (phantom.fov || FOV) / n, dC = FOV / m;
        const fr = [];
        for (let r = 0; r < nReg; r++) fr.push(new Float32Array(m * m));
        const W = axisOverlap(n, dF, m, dC);
        for (let iy = 0; iy < n; iy++) {
            const wy = W[iy];
            if (!wy.length) continue;
            for (let ix = 0; ix < n; ix++) {
                const lab = label[iy * n + ix];
                if (lab >= nReg) continue;
                const wx = W[ix], arr = fr[lab];
                for (let p = 0; p < wy.length; p += 2) {
                    const ro = wy[p] * m, fy = wy[p + 1];
                    for (let q = 0; q < wx.length; q += 2) arr[ro + wx[q]] += fy * wx[q + 1];
                }
            }
        }
        return (byM[m] = fr);
    }

    /* ---------- recognising the parts of a phantom ----------
       ROIs come from region ids where the contract fixes them (the brain)
       and from the regions' properties otherwise: the background is the
       largest water region, spheres and rods are recognised by name or as
       compact regions, their diameters from their area. */
    function regionIndex(ph) { const m = {}; ph.regions.forEach(function (r, k) { m[r.id] = k; }); return m; }
    function text(r) { return ((r.id || '') + ' ' + (r.name || '')).toLowerCase(); }
    function kindOf(ph) {
        const id = String(ph.id || '').toLowerCase();
        if (ph.kind === 'brain' || id === 'brain') return 'brain';
        if (['spheres', 'rods', 'point', 'cylinder'].indexOf(id) >= 0) return id;
        const all = ph.regions.map(text).join(' ');
        if (/sphere/.test(all)) return 'spheres';
        if (/rod/.test(all)) return 'rods';
        if (/point|source|line|capillar/.test(all)) return 'point';
        return 'cylinder';
    }
    function areaMm2(ph, r) { const dx = ph.dx || (ph.fov || FOV) / ph.n; return (r.pixels || 0) * dx * dx; }
    function backgroundIndex(ph) {
        let best = -1, score = -1;
        ph.regions.forEach(function (r, k) {
            if (k === 0 || r.tissue === 'air' || !(r.pixels > 0)) return;
            const t = text(r);
            if (/sphere|rod|source|point|insert|wall|lung/.test(t) && !/background/.test(t)) return;
            if (!(r.tissue === 'water' || r.tissue === 'soft' || /background|water|cylinder/.test(t))) return;
            const s = r.pixels * (/background/.test(t) ? 10 : 1);
            if (s > score) { score = s; best = k; }
        });
        return best;
    }
    /* Diameter of a compact region: the number in its name if it agrees
       with the area, otherwise the diameter of a disk of the same area. */
    function diameterOf(ph, r) {
        const dA = 2 * Math.sqrt(areaMm2(ph, r) / Math.PI);
        const m = /(\d+(?:\.\d+)?)\s*mm/.exec(r.name || '') || /(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/.exec(r.id || '');
        if (m) { const d = parseFloat(m[1]); if (d > 0 && Math.abs(d - dA) <= 0.25 * dA) return d; }
        return Math.round(dA * 10) / 10;
    }
    function groupDiameter(r) {
        const m = /(\d+(?:\.\d+)?)\s*mm/.exec(r.name || '') || /(\d+(?:\.\d+)?)/.exec(r.id || '');
        return m ? parseFloat(m[1]) : null;
    }
    function sphereIndices(ph, bg) {
        let list = [];
        ph.regions.forEach(function (r, k) { if (k > 0 && k !== bg && /sphere/.test(text(r)) && r.pixels > 0) list.push(k); });
        if (!list.length) {
            ph.regions.forEach(function (r, k) {
                if (k === 0 || k === bg || !(r.pixels > 0)) return;
                if (['lung', 'plastic', 'bone', 'air'].indexOf(r.tissue) >= 0) return;
                if (areaMm2(ph, r) < Math.PI * 30 * 30) list.push(k);
            });
        }
        return list;
    }
    function centroids(ph) {
        const n = ph.n, dx = ph.dx || (ph.fov || FOV) / n, h = Math.floor(n / 2), nReg = ph.regions.length;
        const sx = new Float64Array(nReg), sy = new Float64Array(nReg), c = new Float64Array(nReg);
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const l = ph.label[iy * n + ix];
            if (l >= nReg) continue;
            sx[l] += (ix - h) * dx; sy[l] += (iy - h) * dx; c[l]++;
        }
        return ph.regions.map(function (r, k) { return c[k] ? { x: sx[k] / c[k], y: sy[k] / c[k] } : { x: NaN, y: NaN }; });
    }

    /* ---------- ROI definitions ---------- */
    const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#c03fb0', '#d9a400', '#5b6cd6', '#e0443e', '#2fa5b8'];
    const BRAIN_COMPOSITES = [
        ['cortex', 'Cortex (frontal, temporal, occipital)', ['gm_frontal', 'gm_temporal', 'gm_occipital'], false],
        ['striatum', 'Striatum (caudate and putamen)', ['caudate_l', 'caudate_r', 'putamen_l_ant', 'putamen_l_post', 'putamen_r_ant', 'putamen_r_post'], false],
        ['putamen_l', 'Putamen (L)', ['putamen_l_ant', 'putamen_l_post'], false],
        ['putamen_r', 'Putamen (R)', ['putamen_r_ant', 'putamen_r_post'], false],
        ['caudate', 'Caudate (both)', ['caudate_l', 'caudate_r'], false],
        ['cerebellum', 'Cerebellum (gray matter)', ['cereb_gm'], true],
        ['white_matter', 'White matter', ['wm'], true]
    ];
    const REFERENCE_IDS = { cereb_gm: true, wm: true, gm_occipital: true };
    const defsCache = new WeakMap();
    function roiDefs(ph) {
        if (defsCache.has(ph)) return defsCache.get(ph);
        const idx = regionIndex(ph), defs = [], used = {};
        const kind = kindOf(ph), bg = backgroundIndex(ph);
        function add(d) {
            // the same id for the same regions (a composite that is just one
            // region the phantom also offers): keep one, merge the flags
            const same = defs.find(function (x) { return x.id === d.id && !x.circle && !d.circle && x.regions.join() === d.regions.join(); });
            if (same) { same.reference = same.reference || !!d.reference; return; }
            let id = d.id, k = 2;
            while (used[id]) id = d.id + '_' + (k++);
            used[id] = true;
            const first = d.regions.length ? ph.regions[idx[d.regions[0]]] : null;
            defs.push({ id: id, name: d.name, regions: d.regions.slice(), color: d.color || (first && first.color) || PALETTE[defs.length % PALETTE.length],
                reference: !!d.reference, kind: d.kind || 'composite', circle: d.circle || null });
        }
        const present = function (ids) { return ids.filter(function (id) { return idx[id] !== undefined && ph.regions[idx[id]].pixels > 0; }); };
        const isSingle = {};
        ph.regions.forEach(function (r, k) { if (k > 0 && r.roi && r.pixels > 0) isSingle[r.id] = true; });

        if (kind === 'brain') {
            BRAIN_COMPOSITES.forEach(function (c) { const ids = present(c[2]); if (ids.length) add({ id: c[0], name: c[1], regions: ids, reference: c[3] }); });
            const tissue = ph.regions.filter(function (r) { return (r.tissue === 'gm' || r.tissue === 'wm') && r.pixels > 0; }).map(function (r) { return r.id; });
            if (tissue.length) add({ id: 'whole_brain', name: 'Whole brain (gray and white matter)', regions: tissue, reference: true });
        } else if (bg >= 0) {
            const B = ph.regions[bg];
            if (kind === 'cylinder') {
                add({ id: 'centre', name: 'Centre disk (radius 70 mm)', regions: [B.id], circle: { x: 0, y: 0, r: 70 }, kind: 'circle', reference: true });
                add({ id: 'whole', name: 'Whole cylinder', regions: [B.id], reference: true });
            } else if (kind === 'spheres') {
                sphereIndices(ph, bg).forEach(function (k) {
                    const r = ph.regions[k];
                    if (!isSingle[r.id]) add({ id: r.id, name: r.name, regions: [r.id], kind: 'region' });
                });
                add({ id: 'background', name: 'Background', regions: [B.id], reference: true });
            } else if (kind === 'rods') {
                let rods = [];
                ph.regions.forEach(function (r, k) { if (k > 0 && k !== bg && /rod/.test(text(r)) && r.pixels > 0) rods.push(r); });
                if (!rods.length) rods = ph.regions.filter(function (r, k) { return k > 0 && k !== bg && r.rel > 0 && r.pixels > 0; });
                const groups = {}, order = [];
                rods.forEach(function (r) { const d = groupDiameter(r), key = d === null ? r.id : String(d); if (!groups[key]) { groups[key] = { d: d, ids: [] }; order.push(key); } groups[key].ids.push(r.id); });
                order.forEach(function (key) {
                    const g = groups[key];
                    if (g.ids.length > 1 || !isSingle[g.ids[0]])
                        add({ id: g.d === null ? key : 'rods_' + key + 'mm', name: g.d === null ? ph.regions[idx[g.ids[0]]].name : 'Rods ' + g.d + ' mm', regions: g.ids });
                });
                add({ id: 'background', name: 'Water (no activity)', regions: [B.id], reference: false });
            } else if (kind === 'point') {
                ph.regions.forEach(function (r, k) { if (k > 0 && k !== bg && r.rel > 0 && r.pixels > 0 && !isSingle[r.id]) add({ id: r.id, name: r.name, regions: [r.id], kind: 'region' }); });
            }
        } else if (kind === 'point') {
            ph.regions.forEach(function (r, k) { if (k > 0 && r.rel > 0 && r.pixels > 0 && !isSingle[r.id]) add({ id: r.id, name: r.name, regions: [r.id], kind: 'region' }); });
        }
        // every region the phantom offers as an ROI
        ph.regions.forEach(function (r, k) {
            if (!isSingle[r.id]) return;
            add({ id: r.id, name: r.name, regions: [r.id], kind: 'region',
                reference: !!REFERENCE_IDS[r.id] || (kind !== 'brain' && k === bg && kind !== 'rods' && kind !== 'point') });
        });
        defsCache.set(ph, defs);
        return defs;
    }
    function findDef(ph, roiId) {
        const d = roiDefs(ph).find(function (x) { return x.id === roiId; });
        if (d) return d;
        const r = ph.regions.find(function (x) { return x.id === roiId; });
        if (r) return { id: r.id, name: r.name, regions: [r.id], color: r.color, reference: false, kind: 'region', circle: null };
        if (Array.isArray(roiId)) return { id: roiId.join('+'), name: roiId.join(' + '), regions: roiId, reference: false, kind: 'composite', circle: null };
        throw new Error('Unknown ROI "' + roiId + '" for the ' + (ph.name || ph.id) + ' phantom.');
    }

    /* ---------- masks and statistics ---------- */
    function circleMask(m, fov, cx, cy, r, soft) {
        fov = fov || FOV;
        const dx = fov / m, h = Math.floor(m / 2), out = new Float32Array(m * m), r2 = r * r;
        for (let iy = 0; iy < m; iy++) {
            const y = (iy - h) * dx - cy;
            if (Math.abs(y) > r + dx) continue;
            for (let ix = 0; ix < m; ix++) {
                const x = (ix - h) * dx - cx;
                if (Math.abs(x) > r + dx) continue;
                if (!soft) { out[iy * m + ix] = x * x + y * y <= r2 ? 1 : 0; continue; }
                // area fraction by 5 x 5 supersampling, for small ROIs on coarse grids
                let c = 0;
                for (let q = 0; q < 25; q++) {
                    const xs = x + ((q % 5) + 0.5) / 5 * dx - dx / 2, ys = y + (Math.floor(q / 5) + 0.5) / 5 * dx - dx / 2;
                    if (xs * xs + ys * ys <= r2) c++;
                }
                out[iy * m + ix] = c / 25;
            }
        }
        return out;
    }
    /* Erode a 0/1 mask by `steps` pixels, alternating 4- and 8-neighbour
       steps (an octagon, close to a disk). Stops before it would remove
       the last pixel, so a tiny region keeps its core. */
    function erodeMask(mask, m, steps) {
        let cur = mask;
        for (let s = 0; s < steps; s++) {
            const eight = s % 2 === 1, next = new Float32Array(m * m);
            let any = false;
            for (let iy = 0; iy < m; iy++) for (let ix = 0; ix < m; ix++) {
                const k = iy * m + ix;
                if (!cur[k]) continue;
                if (ix === 0 || iy === 0 || ix === m - 1 || iy === m - 1) continue;
                if (!cur[k - 1] || !cur[k + 1] || !cur[k - m] || !cur[k + m]) continue;
                if (eight && (!cur[k - m - 1] || !cur[k - m + 1] || !cur[k + m - 1] || !cur[k + m + 1])) continue;
                next[k] = 1; any = true;
            }
            if (!any) break;
            cur = next;
        }
        return cur;
    }
    const maskCache = new WeakMap();
    function roiMask(ph, m, roiId, opts) {
        opts = opts || {};
        const threshold = opts.threshold === undefined ? 0.5 : opts.threshold, erode = Math.max(0, Math.round(opts.erode || 0));
        let byKey = maskCache.get(ph);
        if (!byKey) { byKey = new Map(); maskCache.set(ph, byKey); }
        const key = m + '|' + roiId + '|' + threshold + '|' + erode;
        if (byKey.has(key)) return byKey.get(key);
        const def = findDef(ph, roiId), idx = regionIndex(ph), F = regionFractions(ph, m);
        const frac = new Float32Array(m * m);
        def.regions.forEach(function (id) {
            const k = idx[id]; if (k === undefined) return;
            const f = F[k]; for (let j = 0; j < frac.length; j++) frac[j] += f[j];
        });
        const circ = def.circle ? circleMask(m, FOV, def.circle.x, def.circle.y, def.circle.r) : null;
        let mask = new Float32Array(m * m), count = 0, mx = 0;
        for (let j = 0; j < frac.length; j++) {
            if (circ && !circ[j]) continue;
            if (frac[j] > mx) mx = frac[j];
            if (frac[j] > 0 && frac[j] >= threshold - 1e-6) { mask[j] = 1; count++; }
        }
        // A region smaller than the threshold allows (a 3 mm rod on a 5 mm
        // grid) still gets its best pixels rather than an empty ROI.
        if (!count && mx > 0) for (let j = 0; j < frac.length; j++) if ((!circ || circ[j]) && frac[j] >= 0.5 * mx) mask[j] = 1;
        if (erode) mask = erodeMask(mask, m, erode);
        byKey.set(key, mask);
        return mask;
    }
    /* Weighted statistics of image over mask (0/1 or fractional weights;
       no mask = the whole image). sd is the weighted population SD of the
       pixel values, cov = sd / |mean|. */
    function roiStats(image, mask) {
        let sw = 0, s = 0, np = 0, mn = Infinity, mx = -Infinity;
        for (let k = 0; k < image.length; k++) {
            const w = mask ? mask[k] : 1;
            if (!(w > 0)) continue;
            const v = image[k];
            sw += w; s += w * v; np++;
            if (v < mn) mn = v; if (v > mx) mx = v;
        }
        if (!np) return { mean: NaN, sd: NaN, cov: NaN, min: NaN, max: NaN, nPix: 0 };
        const mean = s / sw;
        let v2 = 0;
        for (let k = 0; k < image.length; k++) { const w = mask ? mask[k] : 1; if (w > 0) v2 += w * (image[k] - mean) * (image[k] - mean); }
        const sd = Math.sqrt(v2 / sw);
        return { mean: mean, sd: sd, cov: mean !== 0 ? sd / Math.abs(mean) : NaN, min: mn, max: mx, nPix: np };
    }

    /* ---------- truth ----------
       The true decay-corrected concentration on the image grid: each
       region's mean (acq.frames[f].truth.regionMean) times its fraction
       of every pixel. frame 'all' gives the duration-weighted mean. The
       phantom is rebuilt from acq.phantomId/phantomOpts (cached by
       phantoms.js) unless it is passed in. */
    function truthImage(acq, frame, m, phantom) {
        const ph = phantom || (PET.phantoms && PET.phantoms.build ? PET.phantoms.build(acq.phantomId, acq.phantomOpts) : null);
        if (!ph) throw new Error('truthImage needs the phantom (PET.phantoms is not loaded).');
        const nReg = ph.regions.length, rm = new Float64Array(nReg);
        if (frame === 'all') {
            let ws = 0;
            acq.frames.forEach(function (F) {
                const d = F.dur !== undefined ? F.dur : F.t1 - F.t0;
                if (!(d > 0) || !F.truth) return;
                for (let r = 0; r < nReg; r++) rm[r] += d * (F.truth.regionMean[r] || 0);
                ws += d;
            });
            if (ws > 0) for (let r = 0; r < nReg; r++) rm[r] /= ws;
        } else {
            const F = acq.frames[frame || 0];
            if (!F || !F.truth) throw new Error('Frame ' + frame + ' has no truth.');
            for (let r = 0; r < nReg; r++) rm[r] = F.truth.regionMean[r] || 0;
        }
        const Fr = regionFractions(ph, m), out = new Float32Array(m * m);
        for (let r = 0; r < nReg; r++) {
            const v = rm[r]; if (!v) continue;
            const f = Fr[r]; for (let j = 0; j < out.length; j++) out[j] += v * f[j];
        }
        return out;
    }

    /* ---------- profiles and resolution ---------- */
    function profile(image, m, fov, x0, y0, x1, y1, nSamples) {
        fov = fov || FOV;
        const dx = fov / m, h = Math.floor(m / 2), L = Math.hypot(x1 - x0, y1 - y0);
        const nS = Math.max(2, nSamples || Math.ceil(L / (dx / 2)) + 1);
        const s = new Float64Array(nS), v = new Float64Array(nS), xs = new Float64Array(nS), ys = new Float64Array(nS);
        for (let k = 0; k < nS; k++) {
            const t = k / (nS - 1), x = x0 + t * (x1 - x0), y = y0 + t * (y1 - y0);
            s[k] = t * L; xs[k] = x; ys[k] = y;
            v[k] = U.bilinear(image, m, m, x / dx + h, y / dx + h);
        }
        return { s: s, v: v, x: xs, y: ys };
    }
    /* Full width at a fraction (default half) of the maximum. With evenly
       spaced samples the peak is refined by a parabola through the
       maximum and its two neighbours (as NEMA NU 2 does), and the two
       crossings are found by linear interpolation. NaN if the profile
       never drops below the level on one side. level 0.1 gives the FWTM. */
    function fwhm(s, v, level) {
        level = level || 0.5;
        const N = v.length;
        let im = 0;
        for (let k = 1; k < N; k++) if (v[k] > v[im]) im = k;
        let peak = v[im];
        if (!(peak > 0)) return NaN;
        if (im > 0 && im < N - 1) {
            const h1 = s[im] - s[im - 1], h2 = s[im + 1] - s[im], den = v[im - 1] - 2 * v[im] + v[im + 1];
            if (Math.abs(h1 - h2) < 0.01 * h1 && den < 0) {
                const p = peak - 0.125 * (v[im - 1] - v[im + 1]) * (v[im - 1] - v[im + 1]) / den;
                if (p >= peak && p < 1.5 * peak) peak = p;
            }
        }
        const lv = level * peak;
        let l = im; while (l > 0 && v[l] > lv) l--;
        let r = im; while (r < N - 1 && v[r] > lv) r++;
        if (v[l] > lv || v[r] > lv) return NaN;
        const sl = s[l] + (lv - v[l]) / (v[l + 1] - v[l]) * (s[l + 1] - s[l]);
        const sr = s[r - 1] + (v[r - 1] - lv) / (v[r - 1] - v[r]) * (s[r] - s[r - 1]);
        return sr - sl;
    }
    /* FWHM of the radial and tangential profiles through a point source.
       The peak is looked for within opts.search mm (default 6) of (x, y);
       profiles run through the brightest pixel, sampled once per pixel
       (so along x or y they are the pixel values, as NEMA prescribes),
       radial = along the line from the centre of the FOV through the
       point (x for a point at the centre), tangential = across it. */
    function pointResolution(image, m, fov, x, y, opts) {
        opts = opts || {};
        fov = fov || FOV;
        const dx = fov / m, h = Math.floor(m / 2), search = opts.search === undefined ? 6 : opts.search, half = opts.halfLength || 20;
        let best = -Infinity, bx = Math.round(x / dx) + h, by = Math.round(y / dx) + h;
        const R = Math.ceil(search / dx), cx = bx, cy = by;
        for (let iy = Math.max(0, cy - R); iy <= Math.min(m - 1, cy + R); iy++) for (let ix = Math.max(0, cx - R); ix <= Math.min(m - 1, cx + R); ix++) {
            const v = image[iy * m + ix];
            if (v > best) { best = v; bx = ix; by = iy; }
        }
        const px = (bx - h) * dx, py = (by - h) * dx, rr = Math.hypot(px, py);
        const ur = rr > dx ? [px / rr, py / rr] : [1, 0], ut = [-ur[1], ur[0]];
        const nS = 2 * Math.round(half / dx) + 1, L = (nS - 1) / 2 * dx;
        const pr = profile(image, m, fov, px - L * ur[0], py - L * ur[1], px + L * ur[0], py + L * ur[1], nS);
        const pt = profile(image, m, fov, px - L * ut[0], py - L * ut[1], px + L * ut[0], py + L * ut[1], nS);
        return {
            radial: fwhm(pr.s, pr.v), tangential: fwhm(pt.s, pt.v),
            radialFWTM: fwhm(pr.s, pr.v, 0.1), tangentialFWTM: fwhm(pt.s, pt.v, 0.1),
            x: px, y: py, peak: best, profiles: { radial: pr, tangential: pt }
        };
    }

    /* ---------- NEMA NU 2 image quality ----------
       ROIs of each sphere's own diameter at the sphere centres (from the
       phantom's labels), and 12 background ROIs of every sphere diameter,
       concentric, placed where the largest one lies wholly in the
       background, spread out as far as possible. For sphere size j:
         C_B,j = mean of its 12 background ROI means, SD_j their SD (K - 1),
         hot:  Q_H = (C_H / C_B - 1) / (a_H / a_B - 1)     (contrast recovery)
         cold: Q_C = 1 - C_C / C_B
         background variability N_j = SD_j / C_B,j.
       NEMA uses five slices; one slice here, so the variability is noisier.
       All fractions (0..1), not percent. */
    const bgPosCache = new WeakMap();
    function backgroundPositions(ph, bg, rad) {
        let byR = bgPosCache.get(ph);
        if (!byR) { byR = {}; bgPosCache.set(ph, byR); }
        const key = bg + ':' + rad.toFixed(2);
        if (byR[key]) return byR[key];
        const n = ph.n, dF = ph.dx || (ph.fov || FOV) / n, h = Math.floor(n / 2), lab = ph.label;
        const reach = Math.ceil(rad / dF) + 1, offs = [];
        for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) if ((dx * dx + dy * dy) * dF * dF <= rad * rad) offs.push(dy * n + dx);
        const cands = [], step = Math.max(1, Math.round(2.5 / dF));
        for (let iy = reach; iy < n - reach; iy += step) for (let ix = reach; ix < n - reach; ix += step) {
            const k0 = iy * n + ix;
            if (lab[k0] !== bg) continue;
            let okk = true;
            for (let q = 0; q < offs.length; q++) if (lab[k0 + offs[q]] !== bg) { okk = false; break; }
            if (okk) cands.push({ x: (ix - h) * dF, y: (iy - h) * dF });
        }
        const chosen = [];
        if (cands.length) {
            // farthest-point sampling, starting from the candidate farthest from the centroid
            let cx = 0, cy = 0; cands.forEach(function (c) { cx += c.x; cy += c.y; }); cx /= cands.length; cy /= cands.length;
            let first = 0, fd = -1;
            cands.forEach(function (c, k) { const d = Math.hypot(c.x - cx, c.y - cy); if (d > fd + 1e-9) { fd = d; first = k; } });
            const dmin = cands.map(function (c) { return Math.hypot(c.x - cands[first].x, c.y - cands[first].y); });
            chosen.push(cands[first]);
            while (chosen.length < 12 && chosen.length < cands.length) {
                let bi = -1, bd = -1;
                for (let k = 0; k < cands.length; k++) if (dmin[k] > bd) { bd = dmin[k]; bi = k; }
                if (bd <= 0) break;
                chosen.push(cands[bi]);
                for (let k = 0; k < cands.length; k++) dmin[k] = Math.min(dmin[k], Math.hypot(cands[k].x - cands[bi].x, cands[k].y - cands[bi].y));
            }
        }
        return (byR[key] = chosen);
    }
    function nemaIQ(image, m, fov, ph, opts) {
        opts = opts || {};
        fov = fov || FOV;
        const bg = backgroundIndex(ph), out = { spheres: [], bgMean: NaN, bgVariability: NaN, bgRois: [], lung: null };
        if (bg < 0 || kindOf(ph) !== 'spheres') return out;
        const sph = sphereIndices(ph, bg);
        if (!sph.length) return out;
        const cen = centroids(ph), B = ph.regions[bg], aB = B.rel;
        const ds = sph.map(function (k) { return diameterOf(ph, ph.regions[k]); });
        const dMax = Math.max.apply(null, ds);
        let pos = backgroundPositions(ph, bg, dMax / 2 + 2);
        if (!pos.length) pos = backgroundPositions(ph, bg, Math.min.apply(null, ds) / 2 + 1);
        out.bgRois = pos.map(function (p) { return { x: p.x, y: p.y }; });
        const mean = function (cx, cy, r) { return roiStats(image, circleMask(m, fov, cx, cy, r, true)).mean; };
        const bgBy = {};
        function bgFor(d) {
            if (bgBy[d]) return bgBy[d];
            const v = pos.map(function (p) { return mean(p.x, p.y, d / 2); });
            const K = v.length, mu = v.reduce(function (a, b) { return a + b; }, 0) / (K || 1);
            let ss = 0; v.forEach(function (x) { ss += (x - mu) * (x - mu); });
            const sd = K > 1 ? Math.sqrt(ss / (K - 1)) : NaN;
            return (bgBy[d] = { mean: K ? mu : NaN, sd: sd, variability: K > 1 && mu !== 0 ? sd / mu : NaN });
        }
        sph.forEach(function (k, q) {
            const r = ph.regions[k], d = ds[q], c = cen[k], b = bgFor(d);
            const C = mean(c.x, c.y, d / 2), aRatio = aB > 0 ? r.rel / aB : NaN;
            const hot = aRatio > 1 || (!(aB > 0) && r.rel > 0);
            const ratio = C / b.mean;
            out.spheres.push({
                id: r.id, name: r.name, d: d, kind: hot ? 'hot' : 'cold', x: c.x, y: c.y,
                mean: C, contrast: ratio, trueContrast: aRatio,
                recovery: hot ? (ratio - 1) / (aRatio - 1) : 1 - ratio,
                bgMean: b.mean, bgSD: b.sd, variability: b.variability
            });
        });
        out.spheres.sort(function (a, b) { return a.d - b.d; });
        const sizes = Object.keys(bgBy);
        out.bgMean = sizes.reduce(function (s, d) { return s + bgBy[d].mean; }, 0) / sizes.length;
        out.bgVariability = out.spheres.length ? bgFor(out.spheres[0].d).variability : NaN;
        // lung insert residual (NEMA: a 30 mm ROI in the insert, relative to the 37 mm background)
        const li = ph.regions.findIndex(function (r, k) { return k > 0 && r.tissue === 'lung' && r.pixels > 0; });
        if (li > 0) {
            const c = cen[li], rad = Math.min(15, 0.6 * diameterOf(ph, ph.regions[li]) / 2), Cl = mean(c.x, c.y, rad);
            out.lung = { mean: Cl, residual: Cl / bgFor(dMax).mean, x: c.x, y: c.y, r: rad };
        }
        return out;
    }

    /* ---------- partial-volume correction: geometric transfer matrix ----------
       (Rousset et al., J Nucl Med 1998.) If every region j had a uniform
       true value t_j, the image would be sum_j t_j B_j, where B_j is the
       region's fraction image blurred by the scanner's resolution. The
       mean of the image over ROI i is then sum_j G_ij t_j with
         G_ij = (mean of B_j over ROI i),
       so the true values follow from the observed ROI means by solving
       G t = observed. G_ii < 1 is the spill-out of region i; G_ij for
       j != i is the spill-in from region j. ROI i is region i's own mask
       (fraction >= 0.5). Composites are reported too: their corrected
       value is the volume-weighted mean of their regions' values.
       opts = { truth: Float64Array per region (e.g. frame.truth.regionMean) } */
    function solveLinear(A, b) {
        const N = b.length, M = A.map(function (row, i) { const r = Array.from(row); r.push(b[i]); return r; });
        let scale = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) scale = Math.max(scale, Math.abs(M[i][j]));
        for (let c = 0; c < N; c++) {
            let p = c;
            for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
            if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
            // a (near) singular system: regularise the pivot a little rather than fail
            if (Math.abs(M[c][c]) < 1e-12 * (scale || 1)) M[c][c] = 1e-12 * (scale || 1);
            for (let r = c + 1; r < N; r++) {
                const f = M[r][c] / M[c][c];
                if (f) for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
            }
        }
        const x = new Float64Array(N);
        for (let r = N - 1; r >= 0; r--) {
            let s = M[r][N];
            for (let k = r + 1; k < N; k++) s -= M[r][k] * x[k];
            x[r] = s / M[r][r];
        }
        return x;
    }
    function gtm(image, m, fov, ph, fwhmMm, opts) {
        opts = opts || {};
        fov = fov || FOV;
        const dx = fov / m, F = regionFractions(ph, m), truth = opts.truth || null;
        const J = [];
        ph.regions.forEach(function (r, k) { let s = 0; const f = F[k]; for (let j = 0; j < f.length; j++) s += f[j]; if (s > 1e-6) J.push(k); });
        const Bl = J.map(function (k) { return fwhmMm > 0 ? U.gaussBlur2D(F[k], m, m, fwhmMm / dx) : F[k]; });
        const masks = J.map(function (k) { return roiMask(ph, m, ph.regions[k].id); });
        const N = J.length, G = [], obs = new Float64Array(N), vol = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            const M = masks[i], row = new Float64Array(N);
            let w = 0, so = 0;
            for (let p = 0; p < M.length; p++) if (M[p] > 0) { w += M[p]; so += M[p] * image[p]; }
            for (let j = 0; j < N; j++) { const b = Bl[j]; let s = 0; for (let p = 0; p < M.length; p++) if (M[p] > 0) s += M[p] * b[p]; row[j] = w > 0 ? s / w : 0; }
            G.push(row);
            obs[i] = w > 0 ? so / w : 0;
            const f = F[J[i]]; let v = 0; for (let p = 0; p < f.length; p++) v += f[p]; vol[i] = v;
        }
        const t = solveLinear(G, obs);
        const pos = {}; J.forEach(function (k, i) { pos[ph.regions[k].id] = i; });
        const rois = [];
        J.forEach(function (k, i) {
            if (k === 0) return;                                   // air: solved for, not reported
            const r = ph.regions[k], e = { id: r.id, name: r.name, observed: obs[i], corrected: t[i], volume: vol[i] * dx * dx, roi: !!r.roi, composite: false };
            if (truth) e.truth = truth[k];
            rois.push(e);
        });
        roiDefs(ph).forEach(function (d) {
            if (d.circle || d.regions.length < 2) return;
            const members = d.regions.filter(function (id) { return pos[id] !== undefined; });
            if (!members.length) return;
            let vs = 0, cs = 0, ts = 0;
            members.forEach(function (id) { const i = pos[id]; vs += vol[i]; cs += vol[i] * t[i]; if (truth) ts += vol[i] * truth[J[i]]; });
            const e = { id: d.id, name: d.name, observed: roiStats(image, roiMask(ph, m, d.id)).mean, corrected: cs / vs, volume: vs * dx * dx, roi: true, composite: true };
            if (truth) e.truth = ts / vs;
            rois.push(e);
        });
        return { rois: rois, ids: J.map(function (k) { return ph.regions[k].id; }), matrix: G, fwhm: fwhmMm };
    }

    /* ---------- time-activity curves ---------- */
    function tacs(images, ph, m, roiIds, frames, opts) {
        const t = new Float64Array(images.length), values = {};
        for (let k = 0; k < images.length; k++) { const F = frames[k] || {}; t[k] = (F.t0 + F.t1) / 2; }
        (roiIds || []).forEach(function (id) {
            const mask = roiMask(ph, m, id, opts), v = new Float64Array(images.length);
            for (let k = 0; k < images.length; k++) v[k] = images[k] ? roiStats(images[k], mask).mean : NaN;
            values[id] = v;
        });
        return { t: t, values: values };
    }

    /* SUV = concentration / (injected dose per gram of body weight), with
       tissue at 1 g/mL. Meaningful for an image decay corrected to the
       injection time (the default reconstruction). */
    function suvImage(image, dose, weight) {
        const f = dose > 0 ? (weight * 1000 / PET.const.DENSITY) / dose : 0, out = new Float32Array(image.length);
        for (let k = 0; k < image.length; k++) out[k] = image[k] * f;
        return out;
    }

    PET.analysis = {
        regionFractions: regionFractions,
        roiDefs: roiDefs,
        roiMask: roiMask,
        roiStats: roiStats,
        truthImage: truthImage,
        circleMask: circleMask,
        profile: profile,
        fwhm: fwhm,
        pointResolution: pointResolution,
        nemaIQ: nemaIQ,
        gtm: gtm,
        tacs: tacs,
        suvImage: suvImage,
        // helpers the UI may find handy (not in the contract)
        phantomKind: kindOf,
        centroids: centroids,
        _internal: { solveLinear: solveLinear, backgroundIndex: backgroundIndex, sphereIndices: sphereIndices, diameterOf: diameterOf }
    };

})(typeof window !== 'undefined' ? window : globalThis);
