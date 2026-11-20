'use strict';
/* ICA and its "Reveal": the components are checked against the generators
   through the same noise rejection and filters as the data the ICA saw. */
const { load, ok, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields', 'dsl', 'examples', 'dsp', 'sim', 'suppress', 'ica']);
const S = MEG.suppress, dsp = MEG.dsp;

const PROG = `recording { sensors magnetometers rate 250 Hz highpass 0.1 Hz lowpass 100 Hz background 150 fT seed 5 }
  shielding { room on references on }
  source auditory M100 { side both amp 30 nAm }
  timeline { block open 5 s  trials 60 isi 1 s jitter 0.2 s { condition tone 100% } }
  artifacts { environment 50 nT  line 100 nT  cardiac 72 bpm 4 pT  blinks 0.25 Hz 2.5 pT  saccades 0.15 Hz 1 pT }`;

(async () => {
  const t0 = Date.now();
  const ds = MEG.simulate(MEG.dsl.build(PROG));
  const enabled = new Set(ds.groups.filter(g => g.on).map(g => g.id));
  const rec = MEG.assemble(ds, { enabled, room: true });
  // the page's pipeline: references, then offline 1 to 40 Hz, then ICA on noise-scaled channels
  const W = S.refWeights(ds), sup = { W, U: [], sssModel: null };
  const chain = dsp.chain({ hp: 1, lp: 40, order: 4, phase: 'zero' }, ds.fs);
  const rows = S.applyRefs(rec.rows, rec.refs, W).map(r => chain.apply(Float32Array.from(r)));
  const sigma = Float64Array.from(ds.array.channels, ch => MEG.chanNoise(ds.array, ch, ds.cfg.recording.noise));
  const model = await MEG.ica.fit(rows.map((r, c) => Float32Array.from(r, x => x / sigma[c])), { k: 12, fs: ds.fs, seed: 5 });
  const matches = MEG.ica.identify(ds, model, { rows, sigma, sup, enabled, room: true, chain });
  console.log(`  ${model.k} components in ${Date.now() - t0} ms: ` + matches.slice(0, 6).map((m, i) => `IC${i + 1} ${m.text}${m.share !== null ? ' ' + Math.round(m.share * 100) + '%' : ''}`).join('; '));

  const named = g => matches.filter(m => m.group === g && m.text.startsWith('≈'));
  ok(named('cardiac').length === 1, 'with references on, Reveal names exactly one component the heart');
  ok(named('blinks').length === 1, 'and exactly one the blinks');
  ok(named('cardiac')[0] && named('cardiac')[0].share > 0.9, 'the heart makes over 90% of its component');

  // Independent check: the component Reveal calls the heart follows the heart's own time course
  const ci = matches.findIndex(m => m.group === 'cardiac' && m.text.startsWith('≈'));
  const act = MEG.ica.activations(model, rows.map((r, c) => Float32Array.from(r, x => x / sigma[c])), 0, ds.n)[ci];
  const heart = Float64Array.from(ds.gens.find(g => g.group === 'cardiac').tc);
  dsp.sosfilt([...dsp.butter('high', 1, 0.1, ds.fs), ...dsp.butter('low', 4, 100, ds.fs)], heart);
  chain.apply(heart);
  const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; } return ab / Math.sqrt(aa * bb); };
  const r = Math.abs(corr(act, heart));
  console.log(`  the heart component's activation vs the heart's time course: r = ${r.toFixed(3)}`);
  ok(r > 0.95, 'whose activation follows the heart (r > 0.95)');

  // A component that only looks like an artifact is not named after it
  ok(matches.every(m => m.group === null || m.group === 'single' || m.share >= 0.1), 'every named component gets at least 10% of its variance from what it is named after');
  summary('ica');
})();
