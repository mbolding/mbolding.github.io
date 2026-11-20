'use strict';
const { load, ok, near, summary } = require('./harness');
const NIRS = load(['core', 'optics', 'hemo', 'probe', 'dsl', 'examples']);
const B = src => NIRS.dsl.build(src);
const fails = (src, re, msg) => {
  try { B(src); ok(false, msg + ' (no error)'); }
  catch (e) { ok(e instanceof NIRS.dsl.DSLError && re.test(e.message) && e.line >= 1, `${msg}: "${e.message}" at line ${e.line}`); }
};

// every example compiles, and survives a serialize-and-reparse round trip
NIRS.EXAMPLES.forEach(ex => {
  let cfg;
  try { cfg = B(ex.src); ok(true, ex.name); } catch (e) { ok(false, `${ex.name}: ${e.message} at ${e.line}:${e.col}`); return; }
  const again = B(NIRS.dsl.serialize(cfg));
  const key = c => JSON.stringify([c.recording, c.probe.sources, c.probe.detectors, c.probe.shorts.map(s => [s.of, s.dist, s.angle]), c.head,
    c.activations.map(a => [a.x, a.y, a.depth, a.radius, a.flow, a.n, a.dip, a.conditions]), c.pairs.map(p => [p.coupling, p.fluct, p.band, p.regions.map(r => [r.x, r.y, r.depth])]),
    c.timeline, c.physiology, Object.keys(c.artifacts).map(k => c.artifacts[k].on), c.analysis, c.geometry.channels.length],
    (k, v) => (typeof v === 'number' ? +v.toPrecision(9) : v));
  ok(key(cfg) === key(again), `${ex.name}: round trip`);
});

// defaults
const d = B('');
ok(d.recording.wavelengths.join() === '760,850' && d.recording.fs === 10, 'empty program: 760/850 nm at 10 Hz');
ok(d.geometry.channels.filter(c => !c.short).length === 10 && d.geometry.channels.filter(c => c.short).length === 4, 'default probe: 10 long and 4 short channels');
ok(d.physiology.cardiac.on && !d.physiology.taskbp.on, 'default physiology: on, without the task-evoked response');

// units decide meaning, in any order; a trailing unit applies to a run
const a1 = B('physiology { cardiac 70 bpm 1 uM }'), a2 = B('physiology { cardiac 1 uM 70 bpm }');
near(a1.physiology.cardiac.rate, 70 / 60, 1e-12, 'bpm');
ok(a1.physiology.cardiac.rate === a2.physiology.cardiac.rate && a1.physiology.cardiac.amp === a2.physiology.cardiac.amp, 'unit order does not matter');
const bp = B('analysis { bandpass 0.01 0.2 Hz }');
ok(bp.analysis.hp === 0.01 && bp.analysis.lp === 0.2, 'run of numbers takes the last unit');
near(B('artifacts { spikes 3 /min 40% }').artifacts.spikes.rate, 0.05, 1e-12, '/min is a rate');
near(B('head adult { skull 9 mm }').head.thick.skull, 0.9, 1e-12, 'mm converts to cm');
ok(!B('physiology { mayer off }').physiology.mayer.on, 'off switches a signal off');
ok(B('analysis { short nearest before }').analysis.shortMode === 'before', 'short regression mode');
ok(B('analysis { dpf 6.1 5.2 }').analysis.dpf.values.join() === '6.1,5.2', 'one DPF per wavelength');
ok(B('analysis { dpf age }').analysis.dpf.age === null, 'dpf age without a number uses the head');
// timeline
const tl = B('timeline { rest 10 s blocks 5 on 20 s off 15 s { condition a condition b order alternate } }').timeline.segments;
ok(tl[1].n === 5 && tl[1].on === 20 && tl[1].off === 15 && tl[1].order === 'alternate', 'blocks statement');
const tl2 = B('timeline { events 20 isi 15 s jitter 5 s duration 2 s }').timeline.segments[0];
ok(tl2.n === 20 && tl2.isi === 15 && tl2.jitter === 5 && tl2.dur === 2, 'events statement');
// probes
const pr = B('probe over Fpz { source A at 0 0 cm detector B at 3 0 cm short A 8 mm }');
ok(pr.probe.over === 'Fpz' && pr.geometry.channels.length === 2, 'custom probe with one long and one short channel');
const un = B('probe over C3 { layout motor } activation x { under S3 D1 }');
ok(Math.abs(un.activations[0].x + 1.5) < 1e-12 && Math.abs(un.activations[0].y) < 1e-12, 'under S3 D1 places a region at the channel midpoint (-1.5, 0)');

// errors point at the line and say what is wrong
fails('recording { wavelengths 760 }\nbanana { }', /unknown statement 'banana'/, 'unknown block');
fails('recording {\n  rate 10 nm\n}', /needs a frequency/, 'wrong unit');
fails('recording { rate 500 Hz }', /between 0.5 and 50/, 'out of range');
fails('recording { rate 10 Hz', /missing '}'/, 'missing brace');
fails('artifacts { poor D9 }', /no optode called D9/, 'unknown optode');
fails('probe over Q7 { }', /not a 10-20 position/, 'unknown 10-20 position');
fails('recording { wavelengths 760 760 nm }', /must differ/, 'repeated wavelength');
fails('activation a { under S9 D1 }', /not on the probe/, 'region under a missing channel');
fails('timeline { blocks x }', /whole number/, 'blocks without a count');
fails('analysis { dpf 6 5 4 }', /3 values but the recording has 2/, 'too many DPF values');
fails('timeline { rest 1800 s rest 1800 s }\nrecording { rate 50 Hz }', /million samples/, 'recording too large');
ok(B('recording { wavelengths 800 nm }').warnings.some(w => /single wavelength/.test(w.msg)), 'a single wavelength warns');
ok(B('recording { rate 1 Hz }').warnings.some(w => /alias/.test(w.msg)), 'slow sampling warns about cardiac aliasing');
ok(/tk-key/.test(NIRS.dsl.highlight('recording { rate 10 Hz }')) && /tk-unit/.test(NIRS.dsl.highlight('rate 10 Hz')), 'highlighter marks keywords and units');
summary('dsl');
