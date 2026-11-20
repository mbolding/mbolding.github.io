'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'hemo', 'probe', 'dsl', 'sim', 'dsp', 'pipeline', 'examples']);
const ex = name => NIRS.EXAMPLES.find(e => e.name === name).src;

const cfg = NIRS.dsl.build(ex('Finger tapping, block design'));
const ds = NIRS.simulate(cfg), ds2 = NIRS.simulate(NIRS.dsl.build(ex('Finger tapping, block design')));
const rec = NIRS.assemble(ds), rec2 = NIRS.assemble(ds2);
ok(rec.I.every((row, c) => row.every((x, l) => x.every((v, i) => v === rec2.I[c][l][i]))), 'same program, same recording, sample for sample');
ok(ds.events.length === 10 && ds.conditions.join() === 'tap', 'ten tapping blocks');
// the timeline respects the program
const on = ds.blocks.filter(b => b.kind === 'task');
ok(on.every(b => Math.abs(b.t1 - b.t0 - 15) < 1e-9), 'every block lasts 15 s');
ok(on.slice(1).every((b, i) => b.t0 - on[i].t1 >= 20 - 1e-9 && b.t0 - on[i].t1 <= 25 + 1e-9), 'rest between blocks is 20 to 25 s');

// switching one component off leaves every other one untouched
const all = new Set(ds.groups.filter(g => g.on).map(g => g.id));
const noMayer = new Set(all); noMayer.delete('mayer');
const a = NIRS.assemble(ds, { enabled: all, noise: false }), b = NIRS.assemble(ds, { enabled: noMayer, noise: false });
const mayerOnly = NIRS.assemble(ds, { enabled: new Set(['mayer']), noise: false });
// in log intensity the contributions add exactly
let err = 0;
for (let i = 0; i < ds.n; i += 7) err = Math.max(err, Math.abs(Math.log(a.I[0][1][i]) - Math.log(b.I[0][1][i]) - (Math.log(mayerOnly.I[0][1][i]) - Math.log(ds.chans[0].per[1].I0))));
ok(err < 1e-9, 'contributions add in log intensity, so one can be removed exactly');

// the cortex reaches the channel above it, through the partial pathlength
const best = NIRS.app ? 0 : ds.chans.reduce((bi, c, i) => (c.per[1].La[0] > ds.chans[bi].per[1].La[0] ? i : bi), 0);
ok(ds.chans[best].label === 'S3-D1', 'the region is seen best by the channel it sits under');
ok(ds.chans.filter(c => c.short).every(c => c.per[1].La[0] < 1e-3), 'short channels do not see the cortex');
// intensities are in a sensible range and short channels are brighter
ds.chans.forEach(c => {
  const I = c.per[1].I0;
  if (c.short) ok(I > 1e3 && I < 5e4, `${c.label}: ${NIRS.fmtPower(I)} on a short channel`);
  else ok(I > 0.5 && I < 30, `${c.label}: ${NIRS.fmtPower(I)} on a 3 cm channel`);
});

// a poorly coupled optode dims only its own channels
const cfgP = NIRS.dsl.build(ex('A loose optode and room light'));
const dsP = NIRS.simulate(cfgP);
const withPoor = NIRS.assemble(dsP, { enabled: new Set(['poor']), noise: false }), without = NIRS.assemble(dsP, { enabled: new Set(), noise: false });
const hit = NIRS.channelsOfOptode(dsP, 'D2');
ok(hit.length === 2, 'D2 serves two channels');
dsP.chans.forEach((c, i) => {
  const ratio = withPoor.I[i][1][0] / without.I[i][1][0];
  if (hit.includes(i)) near(ratio, 0.02, 1e-6, `${c.label} is dimmed to 2%`); else near(ratio, 1, 1e-9, `${c.label} is unaffected`);
});
// ambient light: lock-in rejects it best, no multiplexing not at all
const amb = mux => {
  const c2 = NIRS.dsl.build(ex('A loose optode and room light').replace('multiplex time', 'multiplex ' + mux));
  const d2 = NIRS.simulate(c2);
  const x = NIRS.assemble(d2, { enabled: new Set(['ambient']), noise: false }), y = NIRS.assemble(d2, { enabled: new Set(), noise: false });
  return NIRS.mean(x.I[0][1]) - NIRS.mean(y.I[0][1]);
};
const aF = amb('frequency'), aT = amb('time'), aN = amb('none');
ok(aF < aT && aT < aN, `ambient light that survives: lock-in ${NIRS.fmtPower(aF)} < dark slot ${NIRS.fmtPower(aT)} < none ${NIRS.fmtPower(aN)}`);
// without multiplexing, channels that share a detector see the same light
const cN = NIRS.dsl.build(ex('Finger tapping, block design').replace('multiplex time', 'multiplex none'));
const dN = NIRS.simulate(cN), rN = NIRS.assemble(dN, { noise: false });
const pair = dN.chans.filter(c => c.d === 'D1');
ok(pair.length >= 2 && pair.every(c => Math.abs(rN.I[c.index][1][100] / rN.I[pair[0].index][1][100] - 1) < 1e-12), 'without multiplexing, every channel on D1 reads the same');
// motion artifacts are common to both wavelengths
const cm = NIRS.dsl.build(ex('Motion artifacts')), dm = NIRS.simulate(cm);
const sp = NIRS.assemble(dm, { enabled: new Set(['spikes']), noise: false });
const ln = (li, i) => Math.log(sp.I[0][li][i] / dm.chans[0].per[li].I0);
let mx = 0, ix = 0; for (let i = 0; i < dm.n; i++) if (Math.abs(ln(1, i)) > mx) { mx = Math.abs(ln(1, i)); ix = i; }
ok(mx > 0.05, 'motion spikes change the coupling');
ok(Math.abs(ln(0, ix) / ln(1, ix) - 1) < 0.2, 'a spike is nearly the same at both wavelengths');
// hair costs light, more at the shorter wavelength
const ch = NIRS.simulate(NIRS.dsl.build(ex('Dense, dark hair')));
const lossS = ds.chans[0].per[0].I0 / ch.chans[0].per[0].I0, lossL = ds.chans[0].per[1].I0 / ch.chans[0].per[1].I0;
ok(lossS > 3 && lossS > lossL, `dark hair costs ${lossS.toFixed(0)}x light at 760 nm and ${lossL.toFixed(0)}x at 850 nm`);
summary('sim');
