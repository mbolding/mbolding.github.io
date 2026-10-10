/* Tests for the pure helpers in js/ui/widgets.js (axis ticks and tick
   labels). The widgets themselves need a browser; they are exercised
   with Playwright (see the report of the shell module).
     node tests/test_widgets.js */
'use strict';
const { load, ok, summary } = require('./harness');
const MRI = load(['core', 'ui/widgets']);
const w = MRI.ui && MRI.ui.w;

ok(w && ['concept', 'slider', 'select', 'toggle', 'segmented', 'imageView', 'plot', 'statTable', 'toast']
    .every(n => typeof w[n] === 'function'), 'MRI.ui.w has every widget of section 12.4');
ok(w.toast('hello') === null, 'toast without a document is a harmless no-op');

const t1 = w._niceTicks(0, 1, 5);
ok(t1.step === 0.2 && t1.ticks.length === 6 && t1.ticks[0] === 0 && Math.abs(t1.ticks[5] - 1) < 1e-12, 'ticks 0..1 in steps of 0.2');
const t2 = w._niceTicks(-3.7, 12.2, 6);
ok(t2.step === 2 || t2.step === 5, 'a nice step for -3.7..12.2 (' + t2.step + ')');
ok(t2.ticks.every(v => v >= -3.7 && v <= 12.2), 'ticks stay inside the range');
ok(t2.ticks.every(v => Math.abs(v / t2.step - Math.round(v / t2.step)) < 1e-9), 'ticks are multiples of the step');
const t3 = w._niceTicks(0.0012, 0.0019, 4);
ok(t3.ticks.length >= 3 && t3.ticks.length <= 9, 'small ranges get a sensible number of ticks');
ok(t3.ticks.indexOf(0) < 0, 'no spurious zero tick');
const t4 = w._niceTicks(-5, 5, 4);
ok(t4.ticks.indexOf(0) >= 0 && !t4.ticks.some(v => Object.is(v, -0)), 'zero is a tick and is never -0');
const t5 = w._niceTicks(2, 2, 5);
ok(t5.ticks.length === 1, 'degenerate range');

ok(w._fmtTick(0, 0.2) === '0', 'zero label');
ok(w._fmtTick(0.4, 0.2) === '0.4', 'one decimal for a 0.2 step');
ok(w._fmtTick(-1e-17, 0.5) === '0', 'no "-0.0" labels from rounding noise');
ok(w._fmtTick(250, 50) === '250', 'integers for large steps');
ok(w._fmtTick(0.0015, 0.0005) === '0.0015', 'four decimals for a 0.0005 step');
ok(/e/.test(w._fmtTick(2e-6, 1e-6)), 'exponent for tiny values');
ok(/e/.test(w._fmtTick(3e5, 1e5)), 'exponent for huge values');

summary('widgets');
