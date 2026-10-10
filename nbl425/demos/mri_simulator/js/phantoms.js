/* ============================================================
   MRI Simulator, phantoms (the object being imaged)

   A phantom is a 2D map of tissue labels on an n by n raster that
   covers 0.28 m, plus an intrinsic field-offset map (dB0) from
   magnetic susceptibility differences, plus named landmarks for the
   UI. See ARCHITECTURE.md section 6.

   Every phantom is described analytically, as a function of position
   (x, y), and the raster is filled by evaluating that function at the
   pixel centres. So n = 256 and n = 512 show the same anatomy; the
   finer raster just samples it more densely. Labels are hard (each
   pixel is one tissue). Partial-volume blurring appears naturally
   when the imaging matrix is coarser than the raster, exactly as it
   does in a real scanner.

   Coordinates follow section 3 of ARCHITECTURE.md: raster index i sits
   at (i - floor(n/2)) * dx, x runs left to right and y top to bottom.
   In the brain, anterior is at the top (negative y) and the patient's
   right is on the image left (radiological convention).

   The anatomy constants below are written in millimetres, because that
   is how anatomy is measured and remembered, so the classifiers take
   pixel-centre coordinates in mm. Everything a phantom exports (fov,
   dx, landmarks) is in metres.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const U = MRI.util;

    /* Local names for the Math functions. The raster loops below run a
       few hundred thousand times per phantom, and a local name avoids a
       global lookup on every call (which is slow in some hosts, the
       Node test harness among them). */
    const { PI, abs, atan2, cos, exp, floor, hypot, max, min, pow, round, sin, sqrt } = Math;
    const INF = Infinity;

    const FOV = 0.28;               // m, every phantom
    const DEFAULT_N = 256;
    const TAU = 2 * PI;

    /* ---------- Small geometric helpers (all in mm) ---------- */

    /* Polynomial smooth minimum. Where a and b are within k of each
       other it returns a value a little below both, which rounds the
       corner where two distance fields meet. Used to give gyri rounded
       white-matter cores instead of square ones. */
    function smin(a, b, k) {
        const h = k - abs(a - b);
        return h > 0 ? min(a, b) - h * h / (4 * k) : min(a, b);
    }

    function angDiff(a, b) {          // a - b wrapped to (-pi, pi]
        let d = a - b;
        while (d > PI) d -= TAU;
        while (d <= -PI) d += TAU;
        return d;
    }

    /* Oriented ellipse: centre (cx, cy), semi-axis a along the unit
       vector (ux, uy) and b across it. */
    function ellipse(cx, cy, a, b, ux, uy) {
        const L = hypot(ux, uy);
        return { cx: cx, cy: cy, a: a, b: b, ux: ux / L, uy: uy / L };
    }
    function inEllipse(e, x, y) {
        const px = x - e.cx, py = y - e.cy;
        const s = (px * e.ux + py * e.uy) / e.a;
        const t = (-px * e.uy + py * e.ux) / e.b;
        return s * s + t * t < 1;
    }
    /* A "tube": a polyline whose half-width varies linearly along each
       segment. Returns the signed distance to its surface (negative
       inside). pts = [[x, y, halfWidth], ...]. */
    function tubeDist(pts, x, y) {
        let best = INF;
        for (let j = 0; j + 1 < pts.length; j++) {
            const a = pts[j], b = pts[j + 1];
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const L2 = dx * dx + dy * dy;
            let t = L2 > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / L2 : 0;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const d = hypot(a[0] + t * dx - x, a[1] + t * dy - y) - (a[2] + t * (b[2] - a[2]));
            if (d < best) best = d;
        }
        return best;
    }

    /* Fill an n by n raster by calling classify(xmm, ymm, dxmm) at
       every pixel centre (section 3 index convention). */
    function rasterize(n, classify) {
        const label = new Uint8Array(n * n);
        const dxmm = FOV / n * 1000, h = floor(n / 2);
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * dxmm, o = iy * n;
            for (let ix = 0; ix < n; ix++) label[o + ix] = classify((ix - h) * dxmm, y, dxmm);
        }
        return label;
    }

    function mm(v) { return v / 1000; }     // mm -> m for landmarks

    /* =============================================================
       BRAIN
       An axial slice through the lateral ventricles at the level of
       the basal ganglia (foramen of Monro, thalami, frontal horns and
       atria). From outside in: scalp fat, temporalis muscle (laterally),
       outer table, diploë, inner table, subarachnoid CSF, a folded
       cortical ribbon with CSF-filled sulci, white matter, and the deep
       structures.
       ============================================================= */
    const B = {                      // tissue codes = index into BRAIN_TISSUES (lesion last: it is optional)
        AIR: 0, FAT: 1, MUSCLE: 2, BONE: 3, MARROW: 4, CSF: 5, GM: 6, WM: 7, VESSEL: 8, DEEPGM: 9, LESION: 10
    };
    const BRAIN_TISSUES = ['air', 'fat', 'muscle', 'bone', 'marrow', 'csf', 'gm', 'wm', 'vessel', 'deepgm', 'lesion'];
    const ANT = -PI / 2, POST = PI / 2;   // directions of the anterior and posterior midline

    let brainModel = null;
    function getBrainModel() {
        if (!brainModel) brainModel = makeBrainModel();
        return brainModel;
    }

    function makeBrainModel() {
        /* ----- The skull and scalp as radial profiles -----
           Each layer boundary is a radius r(theta) about the origin.
           The layers are thin compared with the head, so a radial
           offset is a good stand-in for a true normal offset. The
           profiles are tabulated finely once and interpolated, which
           is fast and has nothing to do with the raster size. */
        const NA = 4096;

        /* Inner surface of the skull (the intracranial boundary): a
           slightly squared ellipse, fuller at the back than the front
           (the head is egg-shaped), with a small inward step behind the
           frontal sinus. */
        function icbAt(th) {
            const c = cos(th), s = sin(th), p = 2.25;
            let r = pow(pow(abs(c) / 68.5, p) + pow(abs(s) / 87.5, p), -1 / p);
            r *= 1 + 0.03 * s + 0.025 * s * c * c;
            r -= 2.0 * exp(-0.5 * pow(angDiff(th, ANT) / 0.2, 2));
            return r;
        }
        /* Subarachnoid CSF between the skull and the crowns of the gyri:
           1 to 2 mm, a little more over the frontal lobes. */
        function csfAt(th) {
            const s = sin(th);
            // the gyral crowns do not all reach the same height: a few
            // incommensurate ripples give an irregular, natural outline
            const ripple = 0.25 * sin(5 * th + 0.4) + 0.3 * sin(17 * th + 1.3)
                + 0.3 * sin(23 * th + 4.1) + 0.25 * sin(31 * th + 2.2);
            return max(0.7, 1.4 + 0.8 * pow(max(0, -s), 2) + ripple);
        }
        /* Temporalis muscle, under the scalp on each side, a lens about
           6 mm thick centred a little in front of the ear. */
        const TEMPORALIS = [-0.22, -PI + 0.22];
        function temporalisAt(th) {
            let m = 0;
            for (let k = 0; k < 2; k++) {
                const d = angDiff(th, TEMPORALIS[k]) / 0.85;
                if (abs(d) < 1) m = max(m, 6.5 * pow(1 - d * d, 1.5));
            }
            return m;
        }
        /* Skull: inner and outer tables of compact bone with marrow
           (diploë) between. Thick at the front and back, thin over the
           temporal squama, and thickest at the anterior midline where
           the frontal sinus sits inside the frontal bone. */
        function innerTableAt(th) { return 1.0 + 0.4 * abs(sin(th)); }
        function outerTableAt(th) { return 1.3 + 0.5 * abs(sin(th)); }
        function diploeAt(th) {
            const s = abs(sin(th));
            return 0.7 + 2.4 * pow(s, 1.6)
                + 7.2 * exp(-0.5 * pow(angDiff(th, ANT) / 0.17, 2))     // frontal sinus region
                + 1.8 * exp(-0.5 * pow(angDiff(th, POST) / 0.12, 2));   // occipital protuberance
        }
        /* Scalp: skin and subcutaneous fat, 3.5 to 5 mm, thicker over
           the occiput and thinner over the temporalis. */
        function scalpAt(th) {
            const s = sin(th);
            return 3.8 + 1.0 * max(0, s) + 0.4 * max(0, -s) - 0.1 * temporalisAt(th);
        }

        /* One interleaved table, 7 radii per angle, outermost last:
           gyral crowns, inner skull surface, inner table, diploë, outer
           table, temporalis, scalp. */
        const L_HULL = 0, L_ICB = 1, L_IT = 2, L_DIP = 3, L_OT = 4, L_MUS = 5, L_SC = 6, NL = 7;
        const RT = new Float64Array((NA + 1) * NL);
        for (let i = 0; i <= NA; i++) {
            const th = -PI + TAU * i / NA, o = i * NL;
            const icb = icbAt(th);
            RT[o + L_HULL] = icb - csfAt(th);
            RT[o + L_ICB] = icb;
            RT[o + L_IT] = RT[o + L_ICB] + innerTableAt(th);
            RT[o + L_DIP] = RT[o + L_IT] + diploeAt(th);
            RT[o + L_OT] = RT[o + L_DIP] + outerTableAt(th);
            RT[o + L_MUS] = RT[o + L_OT] + temporalisAt(th);
            RT[o + L_SC] = RT[o + L_MUS] + scalpAt(th);
        }
        function radius(layer, th) {
            const u = (th + PI) * (NA / TAU);
            let i = floor(u);
            if (i < 0) i = 0; else if (i >= NA) i = NA - 1;
            const f = u - i, o = i * NL + layer;
            return RT[o] + (RT[o + NL] - RT[o]) * f;
        }
        function hullPoint(th) { const r = radius(L_HULL, th); return [r * cos(th), r * sin(th)]; }

        /* ----- Pial surfaces: sulci and fissures as tubes -----
           The cortex is grey matter within about 2.5 to 3 mm of the
           pial surface. The pial surface is the outer envelope of the
           brain (the "hull", the crowns of the gyri) plus the walls of
           every sulcus and fissure. Each sulcus is a curved polyline
           running in from the surface; its half-width is the CSF in the
           sulcus and its grey-matter thickness lines both walls. Where
           two sulci run side by side the white matter between them is
           a thin finger, as in a real gyrus. Where pial surfaces meet,
           a smooth minimum rounds the grey/white boundary so the white
           matter fingers have rounded tips.

           The sulci are generated once from fixed seeds, so the brain
           is the same every time; each hemisphere gets its own draw so
           the two sides differ in detail, as real brains do. */
        const SMOOTH = 1.8;          // mm, rounding of the grey/white boundary where pial surfaces meet
        const CROWN_ROUND = 2.0;     // mm, rounding of the gyral crowns where a sulcus opens to the surface
        const G_CROWN = 2.7;         // mm, cortical thickness at the gyral crowns
        const G_FUNDUS = 2.3;        // mm, thinner at the depths of the sulci
        const curves = [];           // each: array of vertices [x, y, csfHalfWidth, gmThickness]
        function addCurve(pts, kind) { if (pts.length >= 2) curves.push({ pts: pts, kind: kind }); }

        /* Deep region the sulci must not enter (basal ganglia and
           ventricles). */
        function inDeepZone(x, y) { return (x / 41) * (x / 41) + ((y - 3) / 59) * ((y - 3) / 59) < 1; }
        function rot(v, a) { const c = cos(a), s = sin(a); return [c * v[0] - s * v[1], s * v[0] + c * v[1]]; }
        function unit(v) { const L = hypot(v[0], v[1]); return [v[0] / L, v[1] / L]; }

        /* March a curved sulcus in from a start point. Its curvature
           wanders (a smoothed random walk, amplitude `wiggle` in rad/mm)
           so sulci meander as real ones do. The CSF in it narrows from
           the mouth to the fundus, and so does the cortex lining it.
           Stops short of the deep structures and of the midline. */
        function marchSulcus(start, dir, length, nSeg, curvPerMm, wMouth, wFundus, g0, g1, wiggle, rng, fromMidline) {
            const pts = [[start[0], start[1], wMouth, g0]];
            let p = start, d = dir, k = curvPerMm;
            const step = length / nSeg;
            for (let j = 1; j <= nSeg; j++) {
                if (wiggle) k = 0.5 * k + 0.5 * curvPerMm + wiggle * (2 * rng() - 1);
                d = rot(d, k * step);
                const q = [p[0] + d[0] * step, p[1] + d[1] * step];
                if (inDeepZone(q[0], q[1]) || (!fromMidline && abs(q[0]) < 4.5)) break;
                const f = j / nSeg;
                pts.push([q[0], q[1], wFundus + (0.75 * wMouth - wFundus) * (1 - f), g0 + (g1 - g0) * f]);
                p = q;
            }
            return pts;
        }

        const sylvian = {};          // per side, for landmarks
        function generateHemisphere(side, seed) {
            const rng = U.rng(seed);
            const R = function (a, b) { return a + (b - a) * rng(); };
            const X = function (v) { return side * v; };

            // Arc length along the hull from the anterior midline (phi = 0)
            // round this side to the posterior midline (phi = pi).
            const M = 1440, Sarr = new Float64Array(M + 1), Th = new Float64Array(M + 1);
            let prev = hullPoint(ANT);
            Th[0] = ANT;
            for (let i = 1; i <= M; i++) {
                const th = ANT + side * PI * i / M, p = hullPoint(th);
                Th[i] = th;
                Sarr[i] = Sarr[i - 1] + hypot(p[0] - prev[0], p[1] - prev[1]);
                prev = p;
            }
            const Stot = Sarr[M];
            function thAtS(s) {
                s = U.clamp(s, 0, Stot);
                let lo = 0, hi = M;
                while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (Sarr[mid] < s) lo = mid; else hi = mid; }
                const f = (s - Sarr[lo]) / (Sarr[hi] - Sarr[lo] || 1);
                return Th[lo] + (Th[hi] - Th[lo]) * f;
            }
            /* Surface frame at arc position s: the point, the inward
               normal, and the tangent pointing toward the occiput. */
            function frame(s) {
                const p = hullPoint(thAtS(s));
                const t = unit((function (a, b) { return [b[0] - a[0], b[1] - a[1]]; })(hullPoint(thAtS(s - 0.6)), hullPoint(thAtS(s + 0.6))));
                let n = [-t[1], t[0]];
                if (n[0] * p[0] + n[1] * p[1] > 0) n = [-n[0], -n[1]];
                return { p: p, n: n, t: t };
            }

            /* Sylvian fissure: the deep lateral cleft. Its stem runs in
               from the lateral surface to the insula, where it opens
               into the insular cistern, a thin CSF sheet running front
               to back over the insular cortex. The insula and the
               frontal and temporal opercula that cover it are lined by
               cortex like any other pial surface. */
            const thM = atan2(-4, side * 66);
            let sylS = 0;
            for (let i = 0, bd = INF; i <= M; i++) { const d = abs(angDiff(Th[i], thM)); if (d < bd) { bd = d; sylS = Sarr[i]; } }
            const F = frame(sylS);
            addCurve([
                [F.p[0] - F.n[0] * 1.5, F.p[1] - F.n[1] * 1.5, 1.5, G_CROWN],
                [F.p[0] + F.n[0] * 3.0, F.p[1] + F.n[1] * 3.0, 1.1, G_CROWN],
                [X(53), -3.0, 1.0, 2.8],
                [X(46), -2.0, 0.95, 2.8],
                [X(40.6), -2.5, 0.95, 2.8]
            ], 'sylvian');
            addCurve([
                [X(37.2), -24, 0.5, 2.6],
                [X(39.2), -14, 0.85, 2.9],
                [X(40.6), -3, 1.05, 3.0],
                [X(39.8), 7, 0.85, 2.9],
                [X(37.6), 15, 0.5, 2.6]
            ], 'insula');
            sylvian[side] = { x: X(50), y: -2.5, insulaX: X(38.0), insulaY: -6 };

            /* Ordinary sulci round the convexity, 10 to 18 mm apart along
               the surface. Primary sulci are 10 to 24 mm deep (deepest in
               the frontal lobe); some branch or fork at the fundus, and a
               few shallow secondary sulci dimple the gyral crowns. Each
               leans and meanders. In the frontal lobe the superior and
               inferior frontal sulci run front to back, so in an axial cut
               they lean toward the occiput; elsewhere the lean wanders.
               The lean is a correlated random walk, so neighbouring sulci
               run roughly parallel rather than crossing. */
            function targetLean(f) {
                if (f < 0.10) return 0.1;
                if (f < 0.36) return 0.3;
                if (f < 0.74) return 0.0;
                return -0.1;
            }
            function depthFor(f) {
                if (f < 0.36) return R(14, 24);          // frontal lobe
                if (f < 0.74) return R(12, 20);          // around the Sylvian region and parietal lobe
                return R(10, 17);                        // occipital lobe
            }
            const prim = [];
            let S = R(8, 11);
            while (S < Stot - 9) {
                if (abs(S - sylS) < 11) { S = sylS + 11 + R(0, 3); continue; }
                prim.push(S);
                S += R(10, 18);
            }
            let lean = targetLean(prim[0] / Stot);
            function sulcusAt(s, D, ln, curv, wiggle, wMouth, wFundus, gTop, kind) {
                const fr = frame(s);
                const dir = unit([cos(ln) * fr.n[0] + sin(ln) * fr.t[0], cos(ln) * fr.n[1] + sin(ln) * fr.t[1]]);
                const start = [fr.p[0] - fr.n[0] * 1.2, fr.p[1] - fr.n[1] * 1.2];
                const nSeg = max(3, round((D + 1.2) / 2.6));
                const pts = marchSulcus(start, dir, D + 1.2, nSeg, curv, wMouth, wFundus, gTop, G_FUNDUS, wiggle, rng);
                addCurve(pts, kind);
                return pts;
            }
            for (let k = 0; k < prim.length; k++) {
                const s = prim[k], f = s / Stot;
                lean = U.clamp(0.5 * lean + 0.5 * targetLean(f) + R(-0.2, 0.2), -0.5, 0.5);
                // some sulci are tight, some a little open; cortex 2.5 to 3 mm
                const open = R(0, 1);
                const pts = sulcusAt(s, depthFor(f), lean, R(-0.04, 0.04), 0.09,
                    1.0 + 0.4 * open, 0.38 + 0.25 * open, R(2.5, 3.0), 'sulcus');
                // side branches: sometimes one from the middle, sometimes the
                // fundus forks in two
                const r = rng();
                if (r < 0.3 && pts.length >= 5) {
                    const j = 2 + floor(rng() * (pts.length - 3));
                    const a = pts[j - 1], c = pts[j];
                    const bdir = rot(unit([c[0] - a[0], c[1] - a[1]]), (rng() < 0.5 ? -1 : 1) * R(0.5, 0.95));
                    addCurve(marchSulcus([c[0], c[1]], bdir, R(5, 9), 3, 0, c[2] / 0.75, 0.38, c[3], G_FUNDUS, 0.08, rng), 'branch');
                } else if (r < 0.5 && pts.length >= 4) {
                    const a = pts[pts.length - 2], c = pts[pts.length - 1];
                    const d0 = unit([c[0] - a[0], c[1] - a[1]]), spread = R(0.4, 0.7);
                    addCurve(marchSulcus([c[0], c[1]], rot(d0, spread), R(3, 6), 2, 0, c[2] / 0.75, 0.36, c[3], G_FUNDUS, 0.06, rng), 'branch');
                    addCurve(marchSulcus([c[0], c[1]], rot(d0, -spread), R(3, 6), 2, 0, c[2] / 0.75, 0.36, c[3], G_FUNDUS, 0.06, rng), 'branch');
                }
                // a shallow secondary sulcus on the following gyrus
                if (k + 1 < prim.length && rng() < 0.3) {
                    const s2 = 0.5 * (s + prim[k + 1]) + R(-2, 2);
                    if (abs(s2 - sylS) > 8) sulcusAt(s2, R(4, 8), lean + R(-0.3, 0.3), 0, 0.06, 0.9, 0.4, G_CROWN, 'secondary');
                }
            }

            /* Where a sulcus dips out of the slice and back in, the cut
               shows an island: a short CSF cleft wrapped in cortex, lying
               in the white matter under a gyrus. */
            for (let k = 0; k < 5; k++) {
                const s = R(0.06, 0.94) * Stot;
                if (abs(s - sylS) < 14) continue;
                const fr = frame(s), dep = R(9, 17), ang = R(-1.2, 1.2);
                const c = [fr.p[0] + fr.n[0] * dep, fr.p[1] + fr.n[1] * dep];
                if (inDeepZone(c[0], c[1]) || abs(c[0]) < 8) continue;
                const d = rot(fr.n, ang), half = R(2, 4);
                addCurve([[c[0] - d[0] * half, c[1] - d[1] * half, 0.35, G_FUNDUS],
                    [c[0] + d[0] * half, c[1] + d[1] * half, 0.35, G_FUNDUS]], 'island');
            }

            /* Medial surface: sulci leave the interhemispheric fissure
               (cingulate and medial frontal sulci in front, the deep
               parieto-occipital sulcus behind). */
            // [y where it leaves the fissure (mm), angle from lateral (rad), depth (mm)]
            const medial = side > 0
                ? [[-82, 0.5, R(8, 11)], [-63, 0.65, R(11, 15)], [50, -0.8, R(15, 19)], [70, -0.4, R(8, 12)]]
                : [[-75, 0.55, R(9, 13)], [-56, 0.7, R(8, 11)], [46, -0.85, R(15, 19)], [63, -0.45, R(9, 13)], [80, -0.3, R(6, 9)]];
            for (const m of medial) {
                const y0 = m[0] + R(-2, 2), ang = m[1] + R(-0.12, 0.12);
                addCurve(marchSulcus([side * 0.3, y0], [side * cos(ang), sin(ang)], m[2], 4,
                    R(-0.03, 0.03) * side, 0.9, 0.4, 2.8, G_FUNDUS, 0.06, rng, true), 'medial');
            }
        }

        /* Interhemispheric fissure: a thin sheet of CSF (with the falx)
           between the two frontal lobes, from the frontal pole back to
           the genu of the corpus callosum, and between the occipital
           lobes from the splenium to the occipital pole. The medial
           cortex lines both sides. */
        (function () {
            const ant = [], post = [];
            for (let y = -91; y <= -41; y += 5) ant.push([0.45 * sin(y / 11), y, y < -80 ? 1.1 : 0.8, 2.8]);
            ant[ant.length - 1][2] = 0.6;
            for (let y = 34; y <= 95; y += 5.08) post.push([0.45 * sin(y / 13 + 1), y, y > 84 ? 1.1 : 0.8, 2.8]);
            post[0][2] = 0.6;
            addCurve(ant, 'fissure');
            addCurve(post, 'fissure');
        })();

        generateHemisphere(+1, 425);       // patient's left (image right)
        generateHemisphere(-1, 13);       // patient's right (image left)

        /* Flatten every curve into segments, and index the segments on
           a grid of 4 mm cells, so each pixel only measures the few
           segments that can reach it. A segment can change a pixel's
           label only within (CSF half-width + cortex + 1.25 x smoothing)
           of it, which sets the reach. */
        const nSegTot = curves.reduce(function (s, c) { return s + c.pts.length - 1; }, 0);
        const SEG = new Float64Array(nSegTot * 9), SEGC = new Int32Array(nSegTot);
        const CELL = 4, G0 = -112, NC = 56;
        const cellLists = new Array(NC * NC);
        for (let i = 0; i < cellLists.length; i++) cellLists[i] = [];
        let si = 0;
        curves.forEach(function (c, ci) {
            for (let j = 0; j + 1 < c.pts.length; j++, si++) {
                const a = c.pts[j], b = c.pts[j + 1], o = 9 * si;
                const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
                SEG[o] = a[0]; SEG[o + 1] = a[1]; SEG[o + 2] = dx; SEG[o + 3] = dy; SEG[o + 4] = L2 > 0 ? 1 / L2 : 0;
                SEG[o + 5] = a[2]; SEG[o + 6] = b[2] - a[2]; SEG[o + 7] = a[3]; SEG[o + 8] = b[3] - a[3];
                SEGC[si] = ci;
                const reach = max(a[2], b[2]) + max(a[3], b[3]) + 1.25 * SMOOTH;
                const cx0 = max(0, floor((min(a[0], b[0]) - reach - G0) / CELL));
                const cx1 = min(NC - 1, floor((max(a[0], b[0]) + reach - G0) / CELL));
                const cy0 = max(0, floor((min(a[1], b[1]) - reach - G0) / CELL));
                const cy1 = min(NC - 1, floor((max(a[1], b[1]) + reach - G0) / CELL));
                for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cellLists[cy * NC + cx].push(si);
            }
        });
        // segments were added curve by curve, so each list is already grouped by curve
        const cells = cellLists.map(function (l) { return Int32Array.from(l); });

        /* ----- Deep structures (defined for the patient's left, x > 0,
           and mirrored by using |x|) ----- */
        // Frontal horn of the lateral ventricle: an ellipse whose long
        // axis points to the anterolateral tip, cut straight on its
        // medial side by the septum pellucidum and hollowed on its
        // lateral side by the head of the caudate nucleus.
        const frontalHorn = ellipse(6.2, -20.0, 14.0, 6.3, 0.35, -0.94);
        const caudate = ellipse(12.8, -14.5, 8.8, 4.9, -0.30, 0.95);
        const thalamus = ellipse(10.4, 7.5, 12.2, 8.2, 0.33, 0.94);
        // Lentiform nucleus (putamen and globus pallidus): a wedge with a
        // convex lateral border and its apex pointing medially at the
        // genu of the internal capsule.
        const lentiformArc = ellipse(15.5, -4.5, 16.5, 16.0, 0, 1);
        const LENT_APEX = [19.5, -2.5], LENT_ANT = [27.5, -21.5], LENT_POST = [28.0, 12.5];
        function lateralOf(p, q, x, y) {           // is (x, y) on the lateral side of the line p -> q ?
            const cr = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
            const ref = (q[0] - p[0]) * (-4 - p[1]) - (q[1] - p[1]) * (40 - p[0]);
            return cr * ref > 0;
        }
        function inLentiform(X, y) {
            return inEllipse(lentiformArc, X, y) && lateralOf(LENT_APEX, LENT_ANT, X, y) && lateralOf(LENT_APEX, LENT_POST, X, y);
        }
        // Third ventricle: a thin midline slit between the thalami.
        const thirdVentricle = [[0, -5.5, 1.5], [0, 3.0, 1.75], [0, 12.0, 1.4], [0, 15.5, 0.6]];
        // Atrium (trigone) and occipital horn curving back round the pulvinar.
        const atrium = [[16.4, 17.0, 1.6], [21.4, 22.5, 3.8], [23.4, 30.0, 4.6], [21.0, 39.0, 3.4],
            [16.6, 47.0, 2.0], [13.0, 52.5, 0.9]];

        /* Superior sagittal sinus: the dural venous sinus seen end-on as
           a triangle at the midline, base on the inner table, apex
           pointing in along the falx. Large posteriorly, small in front. */
        const SSS = [{ dir: POST, base: 9.0, height: 7.0 }, { dir: ANT, base: 5.5, height: 4.5 }];

        /* Frontal sinus: two air cells (unequal, as they usually are)
           inside the frontal bone either side of a thin bony septum,
           in local coordinates s (arc length from the midline, + toward
           the patient's left) and t (depth into the diploë from its
           inner border). */
        const SINUS_LOBES = [
            { s: 5.9, t: 4.9, a: 5.3, b: 3.0 },
            { s: -6.7, t: 5.1, a: 6.1, b: 3.2 }
        ];
        const SINUS_WALL = 0.8;

        /* Lesions (with lesion: true): three periventricular plaques,
           ovoid and pointing away from the ventricle (Dawson's fingers),
           and one 12 mm lesion in the right frontal white matter (on the
           image left). These use true x, so they are not mirrored. */
        const LESIONS = [
            ellipse(-28.0, -44.0, 6.0, 6.0, 1, 0),
            ellipse(12.9, -35.6, 3.8, 2.0, 0.45, -0.89),       // at the tip of the left frontal horn
            ellipse(-31.0, 29.0, 4.0, 2.2, 1, -0.2),           // lateral to the right atrium
            ellipse(23.6, 45.6, 3.6, 1.9, 0.88, 0.48)          // lateral to the left occipital horn
        ];

        /* ----- The classifier: tissue code at (x, y) mm ----- */
        let rOuterMax = 0;
        for (let i = 0; i <= NA; i++) rOuterMax = max(rOuterMax, RT[i * NL + L_SC]);

        function classify(x, y, dx, lesion) {
            const rho = sqrt(x * x + y * y);
            if (rho > rOuterMax) return B.AIR;             // well outside the head: skip the trigonometry
            const th = atan2(y, x);
            const u = (th + PI) * (NA / TAU);
            let ti = floor(u);
            if (ti < 0) ti = 0; else if (ti >= NA) ti = NA - 1;
            const tf = u - ti, to = ti * NL, t1 = to + NL;
            // interpolated layer radii at this angle
            if (rho >= RT[to + L_SC] + (RT[t1 + L_SC] - RT[to + L_SC]) * tf) return B.AIR;
            if (rho >= RT[to + L_MUS] + (RT[t1 + L_MUS] - RT[to + L_MUS]) * tf) return B.FAT;
            if (rho >= RT[to + L_OT] + (RT[t1 + L_OT] - RT[to + L_OT]) * tf) return B.MUSCLE;
            if (rho >= RT[to + L_DIP] + (RT[t1 + L_DIP] - RT[to + L_DIP]) * tf) return B.BONE;
            const rIt = RT[to + L_IT] + (RT[t1 + L_IT] - RT[to + L_IT]) * tf;
            if (rho >= rIt) {
                // diploë, with the frontal sinus at the anterior midline
                const da = angDiff(th, ANT);
                if (abs(da) < 0.25) {
                    const s = da * rIt, t = rho - rIt;
                    let e = INF;
                    for (let k = 0; k < SINUS_LOBES.length; k++) {
                        const L = SINUS_LOBES[k];
                        e = min(e, (hypot((s - L.s) / L.a, (t - L.t) / L.b) - 1) * min(L.a, L.b));
                    }
                    if (e < 0) return B.AIR;
                    if (e < SINUS_WALL) return B.BONE;
                }
                return B.MARROW;
            }
            const rIcb = RT[to + L_ICB] + (RT[t1 + L_ICB] - RT[to + L_ICB]) * tf;
            if (rho >= rIcb) return B.BONE;

            // Inside the skull. Dural venous sinus first.
            const depthIcb = rIcb - rho;
            for (let k = 0; k < SSS.length; k++) {
                const S = SSS[k];
                if (depthIcb < S.height) {
                    const s = abs(angDiff(th, S.dir)) * rIcb;
                    if (s < 0.5 * S.base * (1 - depthIcb / S.height)) return B.VESSEL;
                }
            }

            const delta = RT[to + L_HULL] + (RT[t1 + L_HULL] - RT[to + L_HULL]) * tf - rho;   // depth below the gyral crowns
            let code;
            if (delta < 0) code = B.CSF;
            else {
                // Cortex and sulci. csfMin: signed distance to the nearest
                // sulcal CSF; gmS: smooth minimum over pial surfaces of
                // (distance - cortical thickness), negative in the cortex.
                const wMin = 0.5 * dx;          // keep sulci at least one raster pixel wide
                let csfMin = INF;
                let gmS = delta - G_CROWN;
                const cx = floor((x - G0) / CELL), cy = floor((y - G0) / CELL);
                if (cx >= 0 && cx < NC && cy >= 0 && cy < NC) {
                    const list = cells[cy * NC + cx];
                    let cur = -1, best = INF, bestG = 0;
                    for (let k = 0; k < list.length; k++) {
                        const s = list[k], c = SEGC[s];
                        if (c !== cur) {
                            if (cur >= 0) { if (best < csfMin) csfMin = best; gmS = smin(gmS, best - bestG, SMOOTH); }
                            cur = c; best = INF;
                        }
                        const o = 9 * s;
                        const ax = SEG[o], ay = SEG[o + 1], ddx = SEG[o + 2], ddy = SEG[o + 3];
                        let t = ((x - ax) * ddx + (y - ay) * ddy) * SEG[o + 4];
                        t = t < 0 ? 0 : (t > 1 ? 1 : t);
                        const qx = ax + t * ddx - x, qy = ay + t * ddy - y;
                        const w = SEG[o + 5] + t * SEG[o + 6];
                        const e = sqrt(qx * qx + qy * qy) - (w > wMin ? w : wMin);
                        if (e < best) { best = e; bestG = SEG[o + 7] + t * SEG[o + 8]; }
                    }
                    if (cur >= 0) { if (best < csfMin) csfMin = best; gmS = smin(gmS, best - bestG, SMOOTH); }
                }
                // CSF: inside a sulcus, or in the rounded corner where a sulcus
                // opens to the surface (which gives the gyral crowns their shape)
                const cs = smin(delta, csfMin, CROWN_ROUND);
                code = cs < 0 ? B.CSF : (gmS < 0 ? B.GM : B.WM);
            }

            // Deep grey matter (its own tissue: T1 between cortex and white
            // matter) and the ventricles.
            if (code !== B.CSF && y > -40 && y < 60 && x > -36 && x < 36) {
                const X = abs(x);
                if (inLentiform(X, y) || inEllipse(thalamus, X, y)) code = B.DEEPGM;
                const inCaudate = inEllipse(caudate, X, y);
                if (inCaudate) code = B.DEEPGM;
                const septumHalf = max(0.8, 0.5 * dx);
                if (!inCaudate && inEllipse(frontalHorn, X, y) && (X > septumHalf || y > -6)) code = B.CSF;
                if (X < 2 && y > -7.5 && y < 17 && tubeDist(thirdVentricle, X, y) < 0) code = B.CSF;
                if (X > 11 && X < 29 && y > 14 && y < 55 && tubeDist(atrium, X, y) < 0) code = B.CSF;
            }

            if (lesion && (code === B.WM || code === B.GM || code === B.DEEPGM)) {
                for (let k = 0; k < LESIONS.length; k++) if (inEllipse(LESIONS[k], x, y)) { code = B.LESION; break; }
            }
            return code;
        }

        /* ----- Susceptibility field (Hz at 3 T) -----
           Air is more paramagnetic than tissue by about 9.4 ppm, so air
           spaces bend the main field around them. B0 points along the
           body, through this axial slice, and a small air volume a
           distance h below the slice adds, in the slice, the z
           component of a dipole field:
               df = A (2 h^2 - r^2) / (r^2 + h^2)^(5/2),   A = dchi f0 V / (4 pi)
           with r the in-plane distance (dchi f0 = 9.4e-6 x 127.7 MHz,
           about 1200 Hz). It is positive directly above the air and
           turns slightly negative further out. The frontal sinus,
           ethmoid cells and orbits lie in front of and below the
           orbitofrontal cortex, which is why that cortex sees an offset
           of up to about +120 Hz at 3 T (and drops out on gradient-echo
           EPI). The ear canals and mastoid air give a weaker, broader
           offset over the temporal regions. The sources are placed by
           hand: this is a plausible pattern, not a solved
           susceptibility problem. A is in Hz mm^3. */
        const SOURCES = [
            // frontal sinus, and the ethmoid air cells below and behind it
            { x: 0, y: -89, h: 12, A: 1.5e5 },
            { x: -12, y: -82, h: 15, A: 0.8e5 },
            { x: 12, y: -82, h: 15, A: 0.8e5 },
            { x: 0, y: -72, h: 20, A: 3.0e5 },
            // ear canals and mastoid air cells, well below the slice
            { x: -75, y: 8, h: 30, A: 6.0e5 },
            { x: 75, y: 8, h: 30, A: 6.0e5 }
        ];
        const SRC = Float64Array.from([].concat.apply([], SOURCES.map(function (S) { return [S.x, S.y, S.h * S.h, S.A]; })));
        const NSRC = SOURCES.length;
        function field(x, y) {
            let f = 0;
            for (let k = 0, o = 0; k < NSRC; k++, o += 4) {
                const dx = x - SRC[o], dy = y - SRC[o + 1], r2 = dx * dx + dy * dy, h2 = SRC[o + 2];
                const q = r2 + h2;
                f += SRC[o + 3] * (2 * h2 - r2) / (q * q * sqrt(q));
            }
            return f;
        }

        /* ----- Landmarks (metres) ----- */
        function polar(name, th, rad) { return { name: name, x: mm(rad * cos(th)), y: mm(rad * sin(th)) }; }
        function between(name, l0, l1, th) { return polar(name, th, 0.5 * (radius(l0, th) + radius(l1, th))); }
        function lm(name, x, y) { return { name: name, x: mm(x), y: mm(y) }; }
        function landmarks(lesion) {
            const out = [
                // in the larger (right) air cell, not on the bony septum at the midline
                polar('Frontal sinus (air)', ANT + SINUS_LOBES[1].s / radius(L_IT, ANT), radius(L_IT, ANT) + SINUS_LOBES[1].t),
                polar('Superior sagittal sinus', POST, radius(L_ICB, POST) - 2.5),
                polar('Superior sagittal sinus (anterior)', ANT, radius(L_ICB, ANT) - 1.5),
                between('Scalp fat', L_MUS, L_SC, ANT - 0.55),
                between('Diploë (skull marrow)', L_IT, L_DIP, POST + 0.35),
                between('Outer table (cortical bone)', L_DIP, L_OT, POST - 0.6),
                between('Right temporalis muscle', L_OT, L_MUS, TEMPORALIS[1]),
                between('Left temporalis muscle', L_OT, L_MUS, TEMPORALIS[0]),
                between('Subarachnoid CSF', L_HULL, L_ICB, POST + 0.9),
                polar('Orbitofrontal cortex (field offset)', ANT, radius(L_HULL, ANT) - 6),
                lm('Interhemispheric fissure', 0.3, -66),
                lm('Genu of corpus callosum', 0, -34),
                lm('Splenium of corpus callosum', 0, 26),
                lm('Septum pellucidum', 0, -17),
                lm('Right lateral ventricle (frontal horn)', -5.5, -22),
                lm('Left lateral ventricle (frontal horn)', 5.5, -22),
                lm('Right caudate head', -14.5, -14),
                lm('Left caudate head', 14.5, -14),
                lm('Right thalamus', -11, 7),
                lm('Left thalamus', 11, 7),
                lm('Third ventricle', 0, 4),
                lm('Right internal capsule (anterior limb)', -21, -14),
                lm('Left putamen', 26, -4),
                lm('Right insula', sylvian[-1].insulaX, sylvian[-1].insulaY),
                lm('Left Sylvian fissure', sylvian[1].x, sylvian[1].y),
                lm('Right atrium of lateral ventricle', -23, 29),
                lm('Left occipital horn', 18.5, 44),
                lm('Frontal white matter', 22, -45)
            ];
            if (lesion) {
                out.push(lm('Lesion, 12 mm (right frontal)', LESIONS[0].cx, LESIONS[0].cy));
                for (let k = 1; k < LESIONS.length; k++) out.push(lm('Periventricular plaque', LESIONS[k].cx, LESIONS[k].cy));
            }
            return out;
        }

        return { classify: classify, field: field, landmarks: landmarks };
    }

    function buildBrain(n, opts) {
        const M = getBrainModel();
        const lesion = !!opts.lesion;
        const label = rasterize(n, function (x, y, dx) { return M.classify(x, y, dx, lesion); });
        const dB0 = new Float32Array(n * n);
        const dxmm = FOV / n * 1000, h = floor(n / 2);
        for (let iy = 0; iy < n; iy++) {
            const y = (iy - h) * dxmm;
            for (let ix = 0; ix < n; ix++) {
                const i = iy * n + ix;
                if (label[i] !== B.AIR) dB0[i] = M.field((ix - h) * dxmm, y);
            }
        }
        return {
            tissueIds: lesion ? BRAIN_TISSUES.slice() : BRAIN_TISSUES.slice(0, B.LESION),
            label: label, dB0: dB0,
            landmarks: M.landmarks(lesion),
            notes: 'Axial slice through the lateral ventricles at the level of the basal ganglia, anterior at the top. ' +
                'Radiological convention: the patient\'s right is on the image left. ' +
                'Labels are hard (one tissue per raster pixel); partial-volume blurring appears when the imaging matrix ' +
                'is coarser than the 0.28 m raster. The field offset is a plausible susceptibility pattern ' +
                '(frontal sinus and ear canals), not a solved field calculation.' +
                (lesion ? ' Lesions: one 12 mm lesion in the right frontal white matter and three periventricular plaques.' : '')
        };
    }

    /* =============================================================
       SHEPP-LOGAN
       The modified Shepp-Logan head (Toft 1996), the classic test
       object of tomography. The ellipses are given in the classic unit
       square with y pointing up, so they are flipped here to keep the
       familiar picture (the big ellipse at the top, the three small
       "tumours" at the bottom). Unit length = 0.11 m, so the head is
       about 150 mm by 200 mm like the brain phantom.
       ============================================================= */
    const SHEPP_TISSUES = ['air', 'marrow', 'wm', 'csf', 'gm', 'lesion'];
    const SHEPP = [
        // [x0, y0, a, b, angle (deg), tissue code into SHEPP_TISSUES]
        [0, 0, 0.69, 0.92, 0, 1],               // skull
        [0, -0.0184, 0.6624, 0.874, 0, 2],      // brain
        [0.22, 0, 0.11, 0.31, -18, 3],          // smaller "ventricle" (image right)
        [-0.22, 0, 0.16, 0.41, 18, 3],          // larger "ventricle" (image left)
        [0, 0.35, 0.21, 0.25, 0, 4],            // grey matter
        [0, 0.1, 0.046, 0.046, 0, 4],
        [0, -0.1, 0.046, 0.046, 0, 4],
        [-0.08, -0.605, 0.046, 0.023, 0, 5],    // the three small "tumours"
        [0, -0.605, 0.023, 0.023, 0, 5],
        [0.06, -0.605, 0.023, 0.046, 0, 5]
    ];
    const SHEPP_UNIT = 110;     // mm
    function buildShepp(n) {
        const E = SHEPP.map(function (e) {
            const a = e[4] * PI / 180;
            return { x0: e[0], y0: e[1], a: e[2], b: e[3], c: cos(a), s: sin(a), code: e[5] };
        });
        const label = rasterize(n, function (x, y) {
            const u = x / SHEPP_UNIT, v = -y / SHEPP_UNIT;       // classic coordinates, y up
            let code = 0;
            for (let k = 0; k < E.length; k++) {                   // later ellipses paint over earlier ones
                const e = E[k], px = u - e.x0, py = v - e.y0;
                const p = (px * e.c + py * e.s) / e.a, q = (-px * e.s + py * e.c) / e.b;
                if (p * p + q * q <= 1) code = e.code;
            }
            return code;
        });
        const L = function (name, u, v) { return { name: name, x: mm(u * SHEPP_UNIT), y: mm(-v * SHEPP_UNIT) }; };
        return {
            tissueIds: SHEPP_TISSUES.slice(), label: label, dB0: new Float32Array(n * n),
            landmarks: [L('Skull (marrow)', 0, 0.9), L('Brain (white matter)', 0.35, -0.35), L('Ventricle (CSF)', -0.22, 0),
                L('Ventricle (CSF)', 0.22, 0), L('Grey matter', 0, 0.42), L('Small lesions', 0, -0.605)],
            notes: 'Modified Shepp-Logan phantom with each ellipse mapped to a tissue. Edges are perfectly sharp, ' +
                'which makes it a good object for seeing Gibbs ringing and aliasing. No susceptibility field.'
        };
    }

    /* =============================================================
       RESOLUTION
       A 200 mm disk of doped water. Bar groups of 4, 3, 2 and 1.5 mm
       (five plastic bars per group, gaps equal to the bar width), once
       with vertical bars (resolved along x) and once with horizontal
       bars (resolved along y), a square grid of thin walls at 20 mm
       pitch for judging geometric distortion, and a 30 mm air hole.
       Plastic gives no signal, so it is labelled air.
       ============================================================= */
    const BAR_WIDTHS = [4, 3, 2, 1.5];
    function buildResolution(n) {
        // vertical-bar groups across the top row, horizontal-bar groups below them
        const groupsV = [], groupsH = [];
        let xv = -0.5 * (BAR_WIDTHS.reduce(function (s, w) { return s + 9 * w; }, 0) + 3 * 8);
        BAR_WIDTHS.forEach(function (w) { groupsV.push({ x0: xv, y0: -72, w: w, len: 16 }); xv += 9 * w + 8; });
        let xh = -0.5 * (4 * 16 + 3 * 10);
        BAR_WIDTHS.forEach(function (w) { groupsH.push({ x0: xh, y0: -47, w: w, len: 16 }); xh += 16 + 10; });
        const hole = { x: -42, y: 46, r: 15 };
        const GRID0 = 8;              // mm, corner of the distortion grid
        const label = rasterize(n, function (x, y, dx) {
            if (x * x + y * y > 100 * 100) return 0;
            for (const g of groupsV) {
                if (y >= g.y0 && y < g.y0 + g.len && x >= g.x0 && x < g.x0 + 9 * g.w) {
                    const k = floor((x - g.x0) / g.w);
                    if (k % 2 === 0) return 0;
                }
            }
            for (const g of groupsH) {
                if (x >= g.x0 && x < g.x0 + g.len && y >= g.y0 && y < g.y0 + 9 * g.w) {
                    const k = floor((y - g.y0) / g.w);
                    if (k % 2 === 0) return 0;
                }
            }
            if ((x - hole.x) * (x - hole.x) + (y - hole.y) * (y - hole.y) < hole.r * hole.r) return 0;
            // distortion grid in the lower right quadrant: a 60 mm square of
            // 20 mm cells, walls 1 mm thick (never thinner than one raster
            // pixel, so the walls cannot vanish at n = 256)
            const half = max(0.5, 0.5 * dx);
            if (x > GRID0 - half && x < GRID0 + 60 + half && y > GRID0 - half && y < GRID0 + 60 + half) {
                const fx = abs(x - GRID0 - 20 * round((x - GRID0) / 20)), fy = abs(y - GRID0 - 20 * round((y - GRID0) / 20));
                if (fx < half || fy < half) return 0;
            }
            return 1;
        });
        const lms = [];
        groupsV.forEach(function (g) { lms.push({ name: g.w + ' mm bars (vertical)', x: mm(g.x0 + 4.5 * g.w), y: mm(g.y0 + g.len / 2) }); });
        groupsH.forEach(function (g) { lms.push({ name: g.w + ' mm bars (horizontal)', x: mm(g.x0 + g.len / 2), y: mm(g.y0 + 4.5 * g.w) }); });
        lms.push({ name: 'Distortion grid (20 mm pitch)', x: mm(GRID0 + 30), y: mm(GRID0 + 30) });
        lms.push({ name: '30 mm air hole', x: mm(hole.x), y: mm(hole.y) });
        return {
            tissueIds: ['air', 'water'], label: label, dB0: new Float32Array(n * n), landmarks: lms,
            notes: 'Doped-water disk, 200 mm. Bars are plastic (no signal) with gaps equal to the bar width, so a group ' +
                'is resolved when the pixel is smaller than the bar width. The grid walls are 1 mm at 20 mm pitch.'
        };
    }

    /* =============================================================
       RELAXOMETRY
       Twelve 25 mm vials of doped water on a 4 by 3 grid, T1 and T2
       rising along the series. The plastic holder gives no signal.
       ============================================================= */
    function buildRelax(n) {
        const ids = ['air'];
        const centres = [];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
            const k = r * 4 + c;
            ids.push('vial' + (k < 9 ? '0' : '') + (k + 1));
            centres.push([-54 + 36 * c, -36 + 36 * r]);
        }
        const label = rasterize(n, function (x, y) {
            for (let k = 0; k < centres.length; k++) {
                const dx = x - centres[k][0], dy = y - centres[k][1];
                if (dx * dx + dy * dy < 12.5 * 12.5) return k + 1;
            }
            return 0;
        });
        return {
            tissueIds: ids, label: label, dB0: new Float32Array(n * n),
            landmarks: centres.map(function (c, k) {
                return { name: 'Vial ' + (k + 1), tissue: ids[k + 1], x: mm(c[0]), y: mm(c[1]) };
            }),
            notes: 'Twelve 25 mm vials in a plastic holder (no signal). T1 and T2 rise from vial 1 (top left) to vial 12 ' +
                '(bottom right), reading along the rows. Use it to measure relaxation curves and to see which ' +
                'vials a given TR and TE can tell apart.'
        };
    }

    /* =============================================================
       WATER-FAT
       A 180 mm doped-water disk inside a 10 mm ring of oil, an oil vial
       in the water and a water vial in a bulge of the oil ring, each
       vial with a 1 mm plastic wall. Fat resonates 3.4 ppm (about
       434 Hz at 3 T) below water, so in the image it is displaced along
       the readout: the oil ring and vials show a bright band on one
       side and a dark gap on the other. A weak linear field (plus or
       minus 30 Hz across the object) leaves one edge a little off
       resonance, so a spectral fat-saturation pulse fails there first.
       ============================================================= */
    function buildWaterFat(n) {
        const WV = { x: 67, y: 67, r: 20 };      // water vial in the oil bulge (lower right, inside a 240 mm FOV)
        const OV = { x: -40, y: -25, r: 20 };    // oil vial in the water
        const SLEEVE = 26;                        // oil around the water vial
        const label = rasterize(n, function (x, y, dx) {
            const r2 = x * x + y * y;
            const wall = max(1.0, dx);
            const dW = hypot(x - WV.x, y - WV.y), dO = hypot(x - OV.x, y - OV.y);
            if (dW < WV.r) return 1;                    // water vial
            if (dW < WV.r + wall) return 0;             // its wall
            if (dO < OV.r) return 2;                    // oil vial
            if (dO < OV.r + wall) return 0;
            if (dW < SLEEVE) return 2;                  // oil bulge round the water vial
            if (r2 < 90 * 90) return 1;                 // water
            if (r2 < 100 * 100) return 2;               // oil ring
            return 0;
        });
        const dB0 = new Float32Array(n * n);
        const dxmm = FOV / n * 1000, h = floor(n / 2);
        for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
            const i = iy * n + ix;
            if (label[i]) dB0[i] = 30 * ((ix - h) * dxmm) / 100;     // +-30 Hz over +-100 mm in x
        }
        return {
            tissueIds: ['air', 'water', 'oil'], label: label, dB0: dB0,
            landmarks: [
                { name: 'Doped water', x: mm(20), y: mm(-30) },
                { name: 'Oil ring', x: mm(-95 * 0.7071), y: mm(95 * 0.7071) },
                { name: 'Oil vial in water', x: mm(OV.x), y: mm(OV.y) },
                { name: 'Water vial in oil', x: mm(WV.x), y: mm(WV.y) },
                { name: 'Field offset +30 Hz edge', x: mm(95), y: 0 }
            ],
            notes: 'Doped water (4.7 ppm) and vegetable oil (main peak 1.3 ppm, 434 Hz lower at 3 T). The vials have ' +
                '1 mm plastic walls, which makes the chemical-shift displacement easy to judge. A linear field of ' +
                'plus or minus 30 Hz across the object (higher on the image right) is built in.'
        };
    }

    /* =============================================================
       BRAINO
       The usual MRS quality-control sphere: a solution of the main
       brain metabolites at roughly brain concentrations, in a 160 mm
       container (a section through the sphere).
       ============================================================= */
    function buildBraino(n) {
        const label = rasterize(n, function (x, y) { return x * x + y * y < 80 * 80 ? 1 : 0; });
        return {
            tissueIds: ['air', 'braino'], label: label, dB0: new Float32Array(n * n),
            landmarks: [{ name: 'MRS phantom solution', x: 0, y: 0 }],
            notes: 'Spectroscopy phantom: NAA 12.5 mM, creatine 10, choline 3, myo-inositol 7.5, glutamate 12.5 and ' +
                'lactate 5 mM in water. Well shimmed, no fat, so its spectrum shows the metabolites cleanly once the ' +
                'water is suppressed.'
        };
    }

    /* ---------- Registry ---------- */
    const DEFS = [
        { id: 'brain', name: 'Brain', hasSpectra: true, geometry: buildBrain,
            description: 'Axial head slice through the lateral ventricles: scalp, skull, folded cortex, white matter, ' +
                'ventricles and deep grey matter, with an optional set of lesions.' },
        { id: 'shepp', name: 'Shepp-Logan', hasSpectra: false, geometry: buildShepp,
            description: 'The classic modified Shepp-Logan head made of ellipses, with sharp edges for ringing and aliasing.' },
        { id: 'resolution', name: 'Resolution', hasSpectra: false, geometry: buildResolution,
            description: 'Water disk with 4, 3, 2 and 1.5 mm bar groups, a 20 mm distortion grid and an air hole.' },
        { id: 'relax', name: 'Relaxometry', hasSpectra: false, geometry: buildRelax,
            description: 'Twelve vials with T1 from 200 ms to 4 s and T2 from 20 ms to 2 s.' },
        { id: 'waterfat', name: 'Water and fat', hasSpectra: true, geometry: buildWaterFat,
            description: 'Water disk in an oil ring with an oil vial and a water vial, for chemical shift and fat suppression.' },
        { id: 'braino', name: 'MRS phantom', hasSpectra: true, geometry: buildBraino,
            description: 'A 160 mm sphere of metabolite solution, the standard spectroscopy test object.' }
    ];
    const BY_ID = {};
    DEFS.forEach(function (d) { BY_ID[d.id] = d; });

    /* ---------- Options, tissues and caching ---------- */

    /* Canonical form of the options, so that {n: 256} and
       {n: 256, lesion: false, gad: 0} share one cache entry. */
    const OVERRIDE_KEYS = ['pd', 't1', 't2', 't2s'];
    function normaliseOpts(id, opts) {
        opts = opts || {};
        let n = round(Number(opts.n) || DEFAULT_N);
        n = U.clamp(n, 16, 1024);
        const gad = max(0, Number(opts.gad) || 0);
        const lesion = id === 'brain' ? !!opts.lesion : false;
        const overrides = {};
        const src = opts.overrides || {};
        Object.keys(src).sort().forEach(function (tid) {
            if (!MRI.tissues.library[tid] || !src[tid]) return;
            const o = {};
            OVERRIDE_KEYS.forEach(function (k) {
                const v = Number(src[tid][k]);
                if (src[tid][k] !== undefined && src[tid][k] !== null && isFinite(v)) o[k] = v;
            });
            if (Object.keys(o).length) overrides[tid] = o;
        });
        return { n: n, lesion: lesion, gad: gad, overrides: overrides };
    }

    /* The phantom's tissue list: library copies with the user's
       overrides applied first (they edit intrinsic properties), then
       gadolinium (which only changes tissues that enhance). */
    function makeTissues(ids, o) {
        return ids.map(function (tid) {
            let t = MRI.tissues.get(tid);
            const ov = o.overrides[tid];
            if (ov) {
                if (ov.pd !== undefined) t.pd = max(0, ov.pd);
                ['t1', 't2', 't2s'].forEach(function (k) { if (ov[k] !== undefined && ov[k] > 0) t[k] = ov[k]; });
                t.t2s = min(t.t2s, t.t2);         // T2* can never exceed T2
                t.overridden = true;
            }
            if (o.gad > 0 && t.enhances) t = MRI.tissues.withGad(t, o.gad);
            return t;
        });
    }

    /* Two caches: the geometry (labels, field, landmarks) depends only
       on (id, n, lesion) and is the slow part; the finished phantom
       also depends on the tissue options. Both are small LRU maps. */
    function lru(capacity) {
        const m = new Map();
        return {
            get: function (k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
            set: function (k, v) { m.set(k, v); while (m.size > capacity) m.delete(m.keys().next().value); },
            clear: function () { m.clear(); }
        };
    }
    const geomCache = lru(16);       // room for every phantom at both raster sizes
    const phantomCache = lru(32);

    function build(id, opts) {
        const def = BY_ID[id];
        if (!def) throw new Error('Unknown phantom "' + id + '"');
        const o = normaliseOpts(id, opts);
        const key = id + '|' + JSON.stringify(o);
        const hit = phantomCache.get(key);
        if (hit) return hit;

        const gkey = id + '|' + o.n + '|' + (o.lesion ? 1 : 0);
        let g = geomCache.get(gkey);
        if (!g) {
            g = def.geometry(o.n, o);
            geomCache.set(gkey, g);
        }
        const tissues = makeTissues(g.tissueIds, o);
        // Landmarks are copied so relaxometry vials can quote their current T1 and T2.
        const landmarks = g.landmarks.map(function (L) {
            const c = Object.assign({}, L);
            if (L.tissue) {
                const t = tissues[g.tissueIds.indexOf(L.tissue)];
                c.t1 = t.t1; c.t2 = t.t2;
                c.name = L.name + ': T1 ' + U.fmtTime(t.t1) + ', T2 ' + U.fmtTime(t.t2);
            }
            return c;
        });
        const ph = {
            id: id, name: def.name, description: def.description, hasSpectra: def.hasSpectra,
            n: o.n, fov: FOV, dx: FOV / o.n,
            label: g.label,                 // shared between phantoms with the same geometry: treat as read-only
            tissues: tissues,
            dB0: g.dB0,                     // likewise read-only
            landmarks: landmarks,
            notes: g.notes,
            opts: o
        };
        phantomCache.set(key, ph);
        return ph;
    }

    MRI.phantoms = {
        list: function () {
            return DEFS.map(function (d) { return { id: d.id, name: d.name, description: d.description, hasSpectra: d.hasSpectra }; });
        },
        build: build,
        FOV: FOV,
        // Drop every cached phantom and the precomputed brain anatomy (tests use this to time a cold build).
        clearCache: function () { geomCache.clear(); phantomCache.clear(); brainModel = null; }
    };

})(typeof window !== 'undefined' ? window : globalThis);
