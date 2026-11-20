'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'hemo']);

const fs = 10, n = 600;
const stim = dur => { const u = new Float64Array(n); for (let i = 50; i < 50 + dur * fs; i++) u[i] = 1; return u; };
const peak = (a, sign) => { let m = 0, im = 0; for (let i = 0; i < a.length; i++) if (sign * a[i] > sign * m) { m = a[i]; im = i; } return [m, (im - 50) / fs]; };

// a brief event: HbO up, HbR down, BOLD up, with plausible timing
const ev = NIRS.balloon(stim(1), 1 / fs, 0.5);
const [po, to] = peak(ev.hbo, 1), [pr, tr] = peak(ev.hbr, -1), [pb, tb] = peak(ev.bold, 1);
ok(po > 0 && pr < 0 && pb > 0, 'event: HbO rises, HbR falls, BOLD rises');
ok(to > 3 && to < 8, `HbO peaks ${to.toFixed(1)} s after a 1 s event`);
ok(tb > 4 && tb < 9, `BOLD peaks ${tb.toFixed(1)} s after a 1 s event`);
ok(tr >= to, 'HbR peaks no earlier than HbO');
// a sustained block
const bl = NIRS.balloon(stim(20), 1 / fs, 0.5);
const f20 = bl.f[50 + 19 * fs] - 1;
near(f20, 0.5, 0.06, 'a sustained block settles near the requested flow rise');
const ratio = peak(bl.hbo, 1)[0] / -peak(bl.hbr, -1)[0];
ok(ratio > 2 && ratio < 6, `HbO : HbR about ${ratio.toFixed(1)} : 1`);
const bpk = peak(bl.bold, 1)[0];
ok(bpk > 0.01 && bpk < 0.04, `block BOLD ${(100 * bpk).toFixed(2)}%`);
ok(peak(bl.bold.subarray(250), -1)[0] < 0, 'BOLD has a post-stimulus undershoot');
// HbO = HbT - HbR by construction
let maxd = 0; for (let i = 0; i < n; i++) maxd = Math.max(maxd, Math.abs(bl.hbo[i] - (bl.hbt[i] - bl.hbr[i])));
ok(maxd < 1e-12, 'HbO is HbT minus HbR');
// tighter oxygen coupling (smaller n) gives a smaller HbR fall
const tight = NIRS.balloon(stim(20), 1 / fs, 0.5, { n: 1.5 });
ok(-peak(tight.hbr, -1)[0] < -peak(bl.hbr, -1)[0], 'more oxygen use per unit flow, smaller HbR fall');
// the initial dip
const dip = NIRS.balloon(stim(20), 1 / fs, 0.5, { dip: true });
let early = 0; for (let i = 50; i < 70; i++) early = Math.max(early, dip.hbr[i]);
ok(early > 0, 'with a dip, HbR rises in the first two seconds');

// response functions
const box = new Float64Array(400); for (let i = 10; i < 20; i++) box[i] = 1;
const h = NIRS.convolveHRF(box, 10, NIRS.hrfCanonical);
let hm = 0, hi = 0; h.forEach((v, i) => { if (v > hm) { hm = v; hi = i; } });
near(hm, 1, 0.05, 'a 1 s boxcar through the canonical HRF peaks near 1');
ok((hi - 10) / 10 > 4 && (hi - 10) / 10 < 7, 'canonical HRF peaks 4 to 7 s after onset');

// physiology generators
const r = NIRS.rng(2);
const c = NIRS.physio.cardiac(3000, 10, 1.2, 0.25, r);
near(Math.max(...c) - Math.min(...c), 1, 1e-9, 'cardiac waveform is unit peak to peak');
const sp = (x, f0) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(2 * Math.PI * f0 * i / 10); im += x[i] * Math.sin(2 * Math.PI * f0 * i / 10); } return Math.hypot(re, im); };
ok(sp(c, 1.2) > 5 * sp(c, 0.5), 'cardiac power sits at the heart rate');
const m = NIRS.physio.mayer(6000, 10, 0.1, r);
ok(sp(m, 0.1) > 3 * sp(m, 0.3), 'Mayer waves sit near 0.1 Hz');
const tb2 = NIRS.physio.taskBP(1200, 10, [{ t: 10, dur: 30 }], r, { variability: 0 });
near(tb2[350], 1, 0.05, 'task-evoked blood pressure plateaus at its amplitude');
ok(NIRS.SYSTEMIC.taskbp.layers.gray < 0.2 * NIRS.SYSTEMIC.taskbp.layers.scalp, 'the brain sees little of the task-evoked blood pressure');
summary('hemo');
