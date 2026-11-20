'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'examples']);
const build = src => MEG.dsl.build(src);
const err = src => { try { build(src); return null; } catch (e) { return e; } };

// Every example compiles without warnings
MEG.EXAMPLES.forEach(ex => {
  let cfg = null, e = null;
  try { cfg = build(ex.src); } catch (x) { e = x; }
  ok(cfg && !e, `example "${ex.name}" compiles` + (e ? ': ' + e.message + ' at ' + e.line + ':' + e.col : ''));
  if (cfg) ok(cfg.warnings.length === 0, `example "${ex.name}" has no warnings: ${cfg.warnings.map(w => w.msg).join('; ')}`);
});

// Units decide meaning, in either order
{
  const a = build('artifacts { blinks 0.2 Hz 2 pT }'), b = build('artifacts { blinks 2 pT 0.2 Hz }');
  ok(a.artifacts.blinks.rate === 0.2 && a.artifacts.blinks.amp === 2000 && b.artifacts.blinks.amp === 2000, 'blinks rate and amplitude in either order');
  const c = build('analysis { epoch -100 500 ms }');
  ok(Math.abs(c.analysis.epoch[0] + 0.1) < 1e-12 && Math.abs(c.analysis.epoch[1] - 0.5) < 1e-12, 'a run of numbers takes the last unit');
  const d = build('artifacts { environment 0.05 uT  dental 0.4 nT }');
  near(d.artifacts.environment.amp, 5e7, 1e-3, 'microtesla converted to femtotesla');
  near(d.artifacts.dental.amp, 4e5, 1e-6, 'nanotesla converted to femtotesla');
}
// Sensors, shielding, head
{
  ok(build('recording { sensors axial gradiometers }').recording.sensors === 'axial', 'sensors axial gradiometers');
  ok(build('recording { sensors OPMs }').recording.sensors === 'opm', 'sensors opm, any case');
  ok(/axial or planar/.test(err('recording { sensors gradiometers }').message), 'bare "gradiometers" asks which kind');
  const s = build('shielding { room off references on ssp 3 sss tsss order 7 2 }').shielding;
  ok(!s.room && s.refs && s.ssp === 3 && s.sss === 'tsss' && s.order[0] === 7 && s.order[1] === 2, 'shielding block');
  ok(build('head { position 0 0 -1 cm }').head.position[2] === -1, 'head position');
  ok(/at most 2 cm/.test(err('head { position 0 0 -3 cm }').message), 'head cannot leave the helmet');
  ok(build('recording { sensors opm } shielding { room off }').warnings.some(w => /saturates/.test(w.msg)), 'OPMs without the room warn');
}
// Sources
{
  const cfg = build(`source dipole D { at T7 depth 3 cm orient 30 deg dir 90 deg amp 15 nAm }
    source auditory A { side left latency 110 ms }
    source somatosensory S { side right beta 22 Hz 10 nAm }
    source alpha P { depth 3 cm }
    source spike X { at MLT31 depth 2.5 cm }
    timeline { trials 10 isi 1 s { condition tone 100% } }`);
  const D = cfg.sources[0];
  near(MEG.depthOf(D.pos), 3, 1e-9, 'dipole depth');
  near(MEG.orientationAngles(D.pos, D.ori).tilt, 30, 1e-6, 'dipole tilt');
  const A = cfg.sources[1];
  ok(A.dipoles.length === 1 && A.dipoles[0].name === 'left', 'auditory left only');
  near(A.peaks.find(p => p.gain === 1).latency, 0.11, 1e-9, 'latency moves the M100');
  ok(A.dipoles[0].pos[0] < 0, 'left auditory cortex is on the left');
  near(MEG.orientationAngles(A.dipoles[0].pos, A.dipoles[0].ori).tilt, 90, 1e-6, 'auditory dipole is tangential');
  const S = cfg.sources[2];
  ok(S.dipoles.length === 2 && S.dipoles[0].pos[0] > 0 && S.beta.freq === 22, 'somatosensory right hemisphere with a beta generator');
  ok(cfg.sources[3].dipoles.length === 2, 'alpha has two generators');
  ok(Math.abs(MEG.depthOf(cfg.sources[4].pos) - 2.5) < 1e-9, 'a source can sit under a sensor site');
}
// Errors point at the right place
{
  let e = err('recording {\n  rate 50 Hz\n}');
  ok(e && e.line === 2 && /between 200 and 2000/.test(e.message), 'rate range error on line 2: ' + (e && e.message));
  e = err('source dipole D { at Q9 }');
  ok(e && /not a 10-10 position or a sensor name/.test(e.message), 'unknown place');
  e = err('artifacts { cardiac 70 bpm 3 nAm }');
  ok(e && /does not take/.test(e.message), 'wrong unit for an artifact');
  e = err('recording { sensors planar rate 2000 Hz } timeline { block open 600 s }');
  ok(e && /million samples/.test(e.message), 'too big a recording is refused');
  e = err('timeline { trials 10 isi 1 s { condition a 50% } ');
  ok(e && /missing '}'/.test(e.message), 'unclosed block');
}
// The serializer round-trips every example
MEG.EXAMPLES.forEach(ex => {
  const a = build(ex.src), txt = MEG.dsl.serialize(a, ex.name);
  let b = null; try { b = build(txt); } catch (x) { ok(false, `serialized "${ex.name}" compiles: ${x.message} at ${x.line}\n${txt}`); return; }
  const strip = c => JSON.stringify({ r: c.recording, s: c.shielding, h: c.head, src: c.sources.map(s => ({ type: s.type, amp: s.amp, pos: (s.pos || []).map(x => +x.toFixed(3)) })), t: c.timeline, a: c.artifacts, an: c.analysis });
  ok(strip(a) === strip(b), `serialized "${ex.name}" means the same thing`);
});
ok(/tk-key/.test(MEG.dsl.highlight('recording { rate 500 Hz }')) && /tk-elec/.test(MEG.dsl.highlight('at MLT31')), 'highlighter marks keywords and sensor names');
summary('dsl');
