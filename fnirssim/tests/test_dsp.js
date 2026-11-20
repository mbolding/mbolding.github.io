'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'hemo', 'probe', 'dsl', 'sim', 'dsp', 'pipeline']);
const dsp = NIRS.dsp, fs = 10, n = 6000;
const sine = (f, a) => Float64Array.from({ length: n }, (_, i) => (a || 1) * Math.sin(2 * Math.PI * f * i / fs));
const amp = x => Math.sqrt(2) * NIRS.rms(x, 1000, n - 1000);

// Butterworth band-pass, zero phase
near(amp(dsp.bandpass(sine(0.05), fs, 0.01, 0.2)), 1, 0.02, '0.05 Hz passes a 0.01-0.2 Hz band-pass');
ok(amp(dsp.bandpass(sine(1.2), fs, 0.01, 0.2)) < 0.01, 'the heartbeat is removed');
ok(amp(dsp.bandpass(sine(0.002), fs, 0.01, 0.2)) < 0.05, 'slow drift is removed');
near(dsp.response(fs, 0.01, 0.2, 0.2), 0.5, 0.01, 'two-pass gain is one half at the cut-off');
// zero phase: a filtered sine is not delayed
const x = sine(0.05), y = dsp.bandpass(x, fs, 0.01, 0.2);
let lag = 0, bestc = -Infinity;
for (let L = -20; L <= 20; L++) { let c = 0; for (let i = 1000; i < 5000; i++) c += x[i] * y[i + L]; if (c > bestc) { bestc = c; lag = L; } }
ok(lag === 0, 'forward-backward filtering adds no delay');

// Welch finds a peak where it is
const w = dsp.welch(sine(1.2), fs, 100);
let pk = 0; for (let k = 1; k < w.p.length; k++) if (w.p[k] > w.p[pk]) pk = k;
near(w.f[pk], 1.2, w.df, 'Welch peak at 1.2 Hz');

// optical density
const od = dsp.od(Float64Array.from({ length: 10 }, (_, i) => (i < 5 ? 1 : 0.1) * 100));
near(od[9] - od[0], 1, 1e-12, 'a tenfold fall in light is 1 OD');

// motion correction removes a step and leaves a smooth signal alone
// a slow background (whatever changes inside an artifact is lost with it) plus a heartbeat
const base = Float64Array.from({ length: n }, (_, i) => 0.003 * Math.sin(2 * Math.PI * 0.02 * i / fs) + 0.0003 * Math.sin(2 * Math.PI * 1.1 * i / fs));
const step = Float64Array.from(base, (v, i) => v + (i > 3000 ? 0.05 : 0));
const jump = s => NIRS.mean(s, 3050, 3300) - NIRS.mean(s, 2700, 2950) - (NIRS.mean(base, 3050, 3300) - NIRS.mean(base, 2700, 2950));
const td = dsp.tddr(step, fs).y, spl = dsp.splineCorrect(step, fs, 5).y;
ok(Math.abs(jump(step)) > 0.04, 'the step is there');
ok(Math.abs(jump(td)) < 0.0075, `TDDR removes at least 85% of the step (residual ${jump(td).toFixed(4)})`);
ok(Math.abs(jump(spl)) < 0.0025, `spline correction removes at least 95% of the step (residual ${jump(spl).toFixed(4)})`);
ok(dsp.detectMotion(step, fs, 5).segs.length >= 1, 'the step is detected as an artifact');
ok(dsp.detectMotion(base, fs, 5).segs.length === 0, 'a clean signal has no artifacts');
const smooth = dsp.whittaker(Float64Array.from({ length: 200 }, (_, i) => i * 0.1), 100);
ok(Math.abs(smooth[100] - 10) < 1e-6, 'the Whittaker smoother keeps a straight line');

// Beer-Lambert conversion round trip
const lam = [760, 850], E = NIRS.mbllMatrix(lam, 3, [6, 5]);
const hb = Float64Array.from({ length: 100 }, (_, i) => 0.5 * Math.sin(i / 10));
const ods = [0, 1].map(l => Float64Array.from(hb, v => E[l][0] * v + E[l][1] * -0.3 * v));
const m = dsp.mbll(ods, lam, 3, [6, 5]);
ok(m.hbo.every((v, i) => Math.abs(v - hb[i]) < 1e-9) && m.hbr.every((v, i) => Math.abs(v + 0.3 * hb[i]) < 1e-9), 'Beer-Lambert conversion inverts the forward model');

// regression removes a scaled copy
const s1 = sine(0.1), y2 = Float64Array.from(s1, (v, i) => 2.5 * v + 0.1 * Math.cos(i));
const rr = dsp.regressOut(y2, s1);
near(rr.beta, 2.5, 0.01, 'regression weight');

// the GLM recovers a known response, and its t values behave under white noise
const ds = { n: 3000, fs: 10, conditions: ['a'], events: Array.from({ length: 10 }, (_, k) => ({ t: 20 + 28 * k, dur: 10, ci: 0 })) };
const P = { hrf: 'canonical', deriv: false };
const des = dsp.design(ds, P, { driftHz: 0.008 });
const r = NIRS.rng(4);
const truth = Float64Array.from(des.cols[0], v => 0.4 * v);
const f = dsp.glmFit(Float64Array.from(truth, v => v + 0.2 * r.gauss()), des.cols, { ar: false });
near(f.beta[0], 0.4, 0.03, 'GLM beta is the response size');
let fp = 0;
for (let k = 0; k < 200; k++) { const g = dsp.glmFit(Float64Array.from({ length: 3000 }, () => r.gauss()), des.cols, { ar: false }); if (NIRS.tToP(g.t[0], g.df) < 0.05) fp++; }
ok(fp >= 2 && fp <= 22, `OLS on white noise: ${fp} of 200 false positives at p < 0.05`);
// with autocorrelated noise, prewhitening tames the false positives OLS makes
const ar1 = () => { const z = new Float64Array(3000); let v = 0; for (let i = 0; i < 3000; i++) { v = 0.97 * v + r.gauss(); z[i] = v; } return z; };
let fo = 0, fa = 0;
for (let k = 0; k < 60; k++) { const z = ar1(); const go = dsp.glmFit(z, des.cols, { ar: false }), ga = dsp.glmFit(z, des.cols, { ar: true, order: 4 }); if (NIRS.tToP(go.t[0], go.df) < 0.05) fo++; if (NIRS.tToP(ga.t[0], ga.df) < 0.05) fa++; }
ok(fo > 2 * fa && fa <= 9, `serially correlated noise: OLS ${fo} vs AR ${fa} false positives in 60`);
summary('dsp');
