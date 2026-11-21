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

  // After temporal SSS: tSSS takes most of the dental work out, and Reveal must know it
  {
    const P2 = `recording { sensors planar rate 250 Hz highpass 0.1 Hz lowpass 100 Hz background 150 fT seed 3 }
      shielding { room on }
      source auditory M100 { side both amp 30 nAm }
      timeline { trials 40 isi 1 s jitter 0.2 s { condition tone 100% } }
      artifacts { environment 50 nT  dental 400 pT  cardiac 70 bpm 3 pT }`;
    const d2 = MEG.simulate(MEG.dsl.build(P2));
    const en2 = new Set(d2.groups.filter(g => g.on).map(g => g.id));
    const rec2 = MEG.assemble(d2, { enabled: en2, room: true });
    const out = await S.applySSS(d2, rec2.rows, { tsss: true });
    const sup2 = { W: null, U: [], sssModel: out.model, info: out.info };
    const ch2 = dsp.chain({ hp: 1, lp: 40, order: 4, phase: 'zero' }, d2.fs);
    const rows2 = out.rows.map(r => ch2.apply(Float32Array.from(r)));
    const sig2 = Float64Array.from(d2.array.channels, ch => MEG.chanNoise(d2.array, ch, d2.cfg.recording.noise));
    const m2 = await MEG.ica.fit(rows2.map((r, c) => Float32Array.from(r, x => x / sig2[c])), { k: 10, fs: d2.fs, seed: 3 });
    const id2 = MEG.ica.identify(d2, m2, { rows: rows2, sigma: sig2, sup: sup2, enabled: en2, room: true, chain: ch2 });
    // independently: the dental work alone through SSS, the same tSSS time courses and the filters, in each component
    const dent = MEG.assemble(d2, { enabled: new Set(['dental']), room: true, noise: false });
    const dRows = (await S.applySSS(d2, dent.rows, {})).rows;
    dRows.forEach(y => out.info.tsss.forEach(({ s, Q }) => Q.forEach(q => { let d = 0; for (let t = 0; t < q.length; t++) d += y[s + t] * q[t]; for (let t = 0; t < q.length; t++) y[s + t] -= d * q[t]; })));
    const dF = dRows.map(r => ch2.apply(Float32Array.from(r)));
    const proj = (c, rr) => { const w = Float64Array.from(c.unmix, (u, ch) => u / sig2[ch]), a = new Float64Array(d2.n); rr.forEach((r, ch) => { if (w[ch]) for (let i = 0; i < d2.n; i++) a[i] += w[ch] * r[i]; }); const mu = MEG.mean(a); return a.map(x => x - mu); };
    const dt = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / a.length;
    const truthShare = m2.comps.map(c => { const a = proj(c, rows2), dd = proj(c, dF), va = dt(a, a), vd = dt(dd, dd), cv = dt(a, dd); return vd > 0 ? Math.min(vd / va, cv * cv / (vd * va)) : 0; });
    const said = id2.filter(m => m.group === 'dental' && m.text.startsWith('≈')).length, truth = truthShare.filter(x => x >= 0.5).length;
    console.log(`  tSSS removed ${out.info.removed} time courses; Reveal names ${said} components dental work, the dental work makes half or more of ${truth}`);
    ok(said === truth, 'after tSSS, Reveal names as many components dental work as the dental work really dominates');
    ok(id2.every((m, i) => m.group !== 'dental' || Math.abs(m.share - truthShare[i]) < 0.05), 'and its dental shares match the dental work through tSSS within 5 points');
  }
  summary('ica');
})();
