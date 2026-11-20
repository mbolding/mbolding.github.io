'use strict';
/* Tests for js/events.js, the toy event-by-event Monte Carlo behind the
   Scanner tab's animation. The scene is built here (a phantom object as in
   ARCHITECTURE.md section 6), so the test does not depend on phantoms.js. */
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner', 'events']);
const S = PET.scanner, G = S.geom;

/* A 200 mm water cylinder filled with activity, plus a hot rod at (50, 0),
   on a 128 x 128 raster over 320 mm. */
function cylinderScene(opts) {
    opts = opts || {};
    const n = 128, fov = 320, dx = fov / n, h = n / 2;
    const label = new Uint8Array(n * n), mu = new Float32Array(n * n), emission = new Float32Array(n * n);
    for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
        const x = (ix - h) * dx, y = (iy - h) * dx, k = iy * n + ix;
        if (x * x + y * y <= 100 * 100) {
            label[k] = 1;
            mu[k] = opts.noMu ? 0 : 0.0096;
            emission[k] = (x - 50) * (x - 50) + y * y <= 64 ? 4 : 1;
        }
    }
    const phantom = {
        id: 'test_cylinder', name: 'Test cylinder', kind: 'solution', n: n, fov: fov, dx: dx,
        label: label, mu: mu, axialLength: 200, outsideFraction: 0, condition: null, landmarks: [], notes: '',
        regions: [
            { id: 'air', name: 'Air', mu: 0, tissue: 'air', rel: 0 },
            { id: 'water', name: 'Water', mu: 0.0096, tissue: 'water', rel: 1 }
        ]
    };
    const program = {
        energy: { lo: opts.lo || 435, hi: 650 },
        coincidence: opts.tau || 4.5e-9,
        tof: { on: opts.tof !== false, ctr: 400e-12 },
        acqMode: opts.mode || '3D', isotope: opts.isotope || 'F18'
    };
    const physics = Object.assign({ attenuation: true, scatter: true, randoms: true, positronRange: true }, opts.physics || {});
    return { phantom: phantom, emission: opts.noEmission ? new Float32Array(n * n) : emission,
        isotope: program.isotope, program: program, physics: physics };
}
function runFor(opts, settings, seconds) {
    const sim = PET.events.create(cylinderScene(opts), Object.assign({ seed: 11, rate: 20 }, settings || {}));
    const events = sim.step(seconds || 250);
    return { sim: sim, events: events, f: sim.fractions(), c: sim.counts };
}

const KINDS = ['true', 'scatter', 'random', 'single', 'rejected-energy', 'rejected-time', 'multiple'];

// Basic run: events have the contract's shape and the counters add up
const base = runFor({}, {});
{
    const ev = base.events, c = base.c;
    ok(ev.length > 3000, 'a run produces events (' + ev.length + ')');
    ok(ev.every(e => KINDS.indexOf(e.kind) >= 0), 'every event has a known kind');
    ok(ev.every(e => e.photons.length === 2 && e.photons.every(p => Array.isArray(p.path) && p.path.length >= 2)), 'two photons with paths');
    ok(ev.every((e, i) => i === 0 || e.t >= ev[i - 1].t), 'events come in time order');
    const count = k => ev.filter(e => e.kind === k).length;
    ok(c.trues === count('true') && c.scatters === count('scatter'), 'trues and scatters counted once each');
    ok(c.randoms === ev.reduce((s, e) => s + (e.kind === 'random' ? e.randomPairs : 0), 0), 'one random counted per random pair');
    ok(c.prompts === c.trues + c.scatters + c.randoms, 'prompts = T + S + R');
    ok(c.decays === ev.length, 'every decay counted');
    ok(c.singles > c.prompts, 'singles outnumber coincidences (' + c.singles + ' vs ' + c.prompts + ')');
    const spt = base.f.singlesPerTrue;
    ok(spt > 2 && spt < 15, 'singles per true is plausible for a 20 cm cylinder (' + spt.toFixed(2) + ')');
    console.log('    cylinder: SF ' + base.f.sf.toFixed(3) + ', RF ' + base.f.rf.toFixed(3) + ', singles/true ' + spt.toFixed(2) +
        ', calibration ' + base.sim.params.calibration.ms + ' ms');
}

// LOR end points lie on the ring and the sinogram bin matches the geometry
{
    let onRing = true, binOk = true, n = 0;
    base.events.forEach(e => {
        if (!e.lor) return;
        n++;
        const L = e.lor;
        if (Math.abs(Math.hypot(L.x1, L.y1) - G.ringRadius) > 1e-6 || Math.abs(Math.hypot(L.x2, L.y2) - G.ringRadius) > 1e-6) onRing = false;
        const l = S.lorFromPoints(L.x1, L.y1, L.x2, L.y2), b = S.binOf(l.r, l.theta);
        if (b.a !== L.a || b.i !== L.i) binOk = false;
        if (S.crystalAt(Math.atan2(L.y1, L.x1)) !== L.cA || S.crystalAt(Math.atan2(L.y2, L.x2)) !== L.cB) binOk = false;
    });
    ok(n > 500, 'many LORs (' + n + ')');
    ok(onRing, 'LOR end points lie on the ring (radius ' + G.ringRadius + ' mm)');
    ok(binOk, 'LOR sinogram bins and crystals agree with lorFromPoints / binOf / crystalAt');
    const prompts = base.events.filter(e => (e.kind === 'true' || e.kind === 'scatter' || e.kind === 'random') && (e.kind !== 'random' || e.primary));
    ok(prompts.every(e => e.lor.inside), 'every coincidence lies inside the sinogram field of view');
    // A true LOR passes (very nearly) through the annihilation point: non-collinearity and crystal size only
    let worst = 0;
    base.events.filter(e => e.kind === 'true').forEach(e => {
        const L = e.lor, a = e.annihilation;
        const d = Math.abs((L.x2 - L.x1) * (L.y1 - a.y) - (L.x1 - a.x) * (L.y2 - L.y1)) / Math.hypot(L.x2 - L.x1, L.y2 - L.y1);
        worst = Math.max(worst, d);
    });
    ok(worst < 4.5, 'true LORs pass within a crystal width of the annihilation (worst ' + worst.toFixed(2) + ' mm)');
    // Detected photons end on the ring in the crystal they name
    let hits = true;
    base.events.forEach(e => e.photons.forEach(p => {
        if (p.fate !== 'detected') return;
        const q = p.path[p.path.length - 1];
        if (Math.abs(Math.hypot(q.x, q.y) - G.ringRadius) > 1e-6 || S.crystalAt(Math.atan2(q.y, q.x)) !== p.crystal) hits = false;
    }));
    ok(hits, 'detected photons end on the ring at their crystal');
}

// Reproducible with a seed, whatever the step sizes
{
    const key = list => JSON.stringify(list.map(e => [e.id, e.kind, e.lor && e.lor.a, e.lor && e.lor.i, +e.t.toFixed(9),
        e.photons.map(p => [p.fate, p.crystal, p.measured === null ? null : +p.measured.toFixed(6)])]));
    const a = PET.events.create(cylinderScene({}), { seed: 5, rate: 8 }).step(40);
    const simB = PET.events.create(cylinderScene({}), { seed: 5, rate: 8 });
    let b = [];
    for (let k = 0; k < 400; k++) b = b.concat(simB.step(0.1));
    b = b.concat(simB.step(1e-9));
    ok(a.length > 200 && key(a) === key(b.filter(e => e.t <= 40)), 'same seed, same events, independent of step size');
    const c = PET.events.create(cylinderScene({}), { seed: 6, rate: 8 }).step(40);
    ok(key(a) !== key(c), 'another seed gives other events');
    // next() hands out events one decay at a time, in order
    const s3 = PET.events.create(cylinderScene({}), { seed: 5, rate: 8 });
    let got = [];
    for (let k = 0; k < 60; k++) got = got.concat(s3.next());
    const ids = got.map(e => e.id);
    ok(ids.every((id, i) => i === 0 || id > ids[i - 1]) && got.length >= 60, 'next() steps through decays in order');
    ok(key(got) === key(a.slice(0, got.length)), 'next() gives the same events as step()');
}

// Physics responds correctly
{
    const noMu = runFor({ noMu: true });
    ok(noMu.c.scatters === 0, 'no mu: no scatter (' + noMu.c.scatters + ')');
    ok(noMu.events.every(e => e.photons.every(p => !p.scattered && !p.absorbed)), 'no mu: no interactions in the object');
    const noAtt = runFor({ physics: { attenuation: false } });
    ok(noAtt.c.scatters === 0, 'attenuation off: no scatter');
    const noScat = runFor({ physics: { scatter: false } });
    ok(noScat.c.scatters === 0 && noScat.events.some(e => e.photons.some(p => p.absorbed)), 'scatter off: interacting photons are absorbed, none scatter');
    ok(noAtt.c.trues > 2 * base.c.trues, 'attenuation removes most trues of a 20 cm cylinder');

    const lo350 = runFor({ lo: 350 }), lo480 = runFor({ lo: 480 });
    ok(lo350.f.sf > base.f.sf && base.f.sf > lo480.f.sf,
        'higher energy threshold: less scatter (SF ' + lo350.f.sf.toFixed(3) + ' > ' + base.f.sf.toFixed(3) + ' > ' + lo480.f.sf.toFixed(3) + ')');
    const narrow = runFor({ tau: 3e-9 }), wide = runFor({ tau: 9e-9 });
    ok(wide.f.rf > base.f.rf && base.f.rf > narrow.f.rf,
        'wider coincidence window: more randoms (RF ' + narrow.f.rf.toFixed(3) + ' < ' + base.f.rf.toFixed(3) + ' < ' + wide.f.rf.toFixed(3) + ')');
    const tiny = runFor({ tau: 1e-9 });
    ok(tiny.c.rejectedTime > 20, 'a 1 ns window loses true pairs to the timing window (' + tiny.c.rejectedTime + ')');
    const noR = runFor({ physics: { randoms: false } });
    ok(noR.c.randoms === 0, 'randoms off: no random coincidences');
    const twoD = runFor({ mode: '2D' });
    ok(twoD.f.sf < 0.5 * base.f.sf, '2D (septa) cuts the scatter fraction (' + twoD.f.sf.toFixed(3) + ' vs ' + base.f.sf.toFixed(3) + ')');
}

// Calibration to the latest scan's fractions
for (const tgt of [{ sf: 0.35, rf: 0.15 }, { sf: 0.12, rf: 0.05 }, { sf: 0.4, rf: 0.35 }]) {
    const r = runFor({}, { targetFractions: tgt, rate: 20 }, 300);
    near(r.f.sf, tgt.sf, 0.06, 'scatter fraction follows the target ' + tgt.sf);
    near(r.f.rf, tgt.rf, 0.06, 'randoms fraction follows the target ' + tgt.rf);
}
{
    const r = runFor({}, { targetFractions: { sf: 0.3, rf: 0 } });
    ok(r.c.randoms <= 2, 'target RF 0 gives (almost) no randoms (' + r.c.randoms + ')');
}

// Randoms: pairs of decays that point at each other, inside the window
{
    const ev = base.events, byId = new Map(ev.map(e => [e.id, e]));
    const rnd = ev.filter(e => e.kind === 'random');
    ok(rnd.length > 20, 'some randoms (' + rnd.length + ')');
    // Partners are randoms and point back, unless one decay took part in two
    // random pairs (one single in each window), when it shows the one it opened.
    ok(rnd.every(e => { const o = byId.get(e.partner); return !o || (o.kind === 'random' && (o.partner === e.id || o.primary)); }),
        'random partners are randoms and point at each other');
    ok(rnd.every(e => e.primary === (e.randomPairs > 0)), 'a random is primary when it opened its window');
    const half = 4.5e-9 / 2;
    ok(ev.filter(e => e.kind === 'true' || e.kind === 'scatter' || e.kind === 'random').every(e => Math.abs(e.dt) < half),
        'every coincidence has |dt| < tau / 2');
    // trues bunch near dt = 0 (flight difference + CTR); randoms spread over the window
    const rms = list => Math.sqrt(list.reduce((s, e) => s + e.dt * e.dt, 0) / list.length);
    const tr = ev.filter(e => e.kind === 'true');
    ok(rms(tr) < 0.6e-9 && rms(rnd) > 0.9e-9, 'trues bunched (rms ' + (rms(tr) * 1e9).toFixed(2) + ' ns), randoms flat (rms ' + (rms(rnd) * 1e9).toFixed(2) + ' ns)');
}

// Time of flight: the TOF estimate scatters about the annihilation point along the LOR by sigmaPos(CTR)
{
    const tr = base.events.filter(e => e.kind === 'true');
    let s2 = 0;
    tr.forEach(e => { const dxp = e.tofPos.x - e.annihilation.x, dyp = e.tofPos.y - e.annihilation.y; s2 += dxp * dxp + dyp * dyp; });
    const sig = Math.sqrt(s2 / tr.length), exp = S.timing.sigmaPos(400e-12);
    near(sig / exp, 1, 0.15, 'TOF position spread matches c sigma_t / 2 = ' + exp.toFixed(1) + ' mm (got ' + sig.toFixed(1) + ' mm)');
    const off = runFor({ tof: false }, {}, 30);
    ok(off.events.every(e => e.tofPos === null), 'no TOF position when TOF is off');
}

// Energies: unscattered photons are measured around 511 keV with the energy resolution
{
    const m = [];
    base.events.forEach(e => e.photons.forEach(p => { if (p.fate === 'detected' && !p.scattered) m.push(p.measured); }));
    const mean = m.reduce((a, b) => a + b, 0) / m.length;
    const sd = Math.sqrt(m.reduce((a, b) => a + (b - mean) * (b - mean), 0) / m.length);
    near(mean, 511, 2, 'photopeak mean');
    near(sd, S.energy.sigma(511), 2, 'photopeak width = energy.sigma(511)');
    let compton = true;
    base.events.forEach(e => e.photons.forEach(p => { if (p.scattered && Math.abs(p.energy - S.energy.comptonEnergy(p.scatterAngle)) > 1e-9) compton = false; }));
    ok(compton, 'scattered photon energies follow the Compton formula');
}

// Positron range: 15O flies about five times farther than 18F; off means none
{
    const meanRange = r => r.events.reduce((s, e) => s + e.range, 0) / r.events.length;
    const f18 = meanRange(runFor({}, {}, 60)), o15 = meanRange(runFor({ isotope: 'O15' }, {}, 60));
    ok(o15 > 3 * f18, 'positron range: 15O (' + o15.toFixed(2) + ' mm) much longer than 18F (' + f18.toFixed(2) + ' mm)');
    const none = runFor({ physics: { positronRange: false } }, {}, 30);
    ok(none.events.every(e => e.range === 0), 'positron range off: annihilation at the decay');
}

// Decays follow the emission raster: the hot rod (4x, 8 mm radius) shows up
{
    const inRod = base.events.filter(e => (e.decay.x - 50) ** 2 + e.decay.y ** 2 <= 64).length / base.events.length;
    // expected fraction: 4 * area(rod) / (area(cyl) + 3 area(rod))
    const exp = 4 * 64 / (100 * 100 + 3 * 64);
    near(inRod, exp, 0.012, 'decays sampled from the emission raster (hot rod fraction)');
}

// Robustness: nothing to sample gives an empty simulator that never throws
{
    const e = PET.events.create(cylinderScene({ noEmission: true }), { seed: 1 });
    ok(e.empty === true && e.step(10).length === 0 && e.next().length === 0, 'empty emission: empty simulator');
    const e2 = PET.events.create({}, {});
    ok(e2.empty === true && e2.step(1).length === 0, 'no scene at all: empty simulator');
    // emission missing: falls back to region concentrations
    const sc = cylinderScene({}); delete sc.emission;
    const e3 = PET.events.create(sc, { seed: 2, rate: 10 });
    ok(!e3.empty && e3.step(5).length > 10, 'no emission raster: region concentrations are used');
}

summary('events');
