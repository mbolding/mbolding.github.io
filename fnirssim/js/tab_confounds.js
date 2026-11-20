/* fNIRS simulator: the Confounds tab.  Every contribution to the
   recording as a switch, its fingerprint alone and in company, where on
   the probe it is strong, and at what frequency. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { sel: null, as: 'hb', cache: {}, cacheV: -1 };
  let ctl = {};

  const INFO = {
    cardiac: ['Physiology', 'The arterial pulse: every heartbeat swells the arteries of scalp and brain with oxygenated blood, so it shows mostly in HbO, at about 1 Hz and its harmonics. Not a problem but a gift: its presence proves the light went through living tissue, which is what the scalp coupling index tests. A low-pass filter below 0.5 Hz removes it.'],
    respiration: ['Physiology', 'Breathing changes the pressure in the chest and the venous return from the head, and with it the blood volume, at 0.2 to 0.3 Hz in adults and faster in infants. It affects HbO and HbR alike, because it moves venous blood.'],
    mayer: ['Physiology', 'Mayer waves are slow oscillations of arterial blood pressure, near 0.1 Hz (a 10 s period). They are strong in the scalp, weaker in the brain, and they sit right where a block design with 20 s blocks has its energy, so filtering cannot remove them without removing the response too. Short channels can.'],
    drift: ['Physiology', 'Spontaneous slow fluctuations of blood volume and oxygenation (vasomotion, slow drifts) with a 1/f spectrum. They make the baseline wander, which is why every analysis high-pass filters or models drift.'],
    taskbp: ['Physiology, time-locked', 'Doing a task raises heart rate and blood pressure, and the scalp, which has no autoregulation, blushes: its blood flow rises with every block. The result is HbO up and HbR slightly down, time-locked to the stimulus, in every channel: it looks exactly like activation and averaging only makes it cleaner. The brain barely shows it. Short-separation channels see it alone, which is how it is removed.'],
    spikes: ['Instrument', 'Head and jaw movements shift an optode against the skin and change how much light gets in or out. The coupling recovers within seconds: a spike, on both wavelengths at once, in every channel that uses that optode.'],
    shifts: ['Instrument', 'An optode slips or a hair moves under it and the coupling changes for good: a step in intensity that never comes back. It ruins the baseline of everything after it.'],
    poor: ['Instrument', 'An optode resting on hair rather than skin sends or receives very little light that has been through tissue. Its channels sit near the detector\'s noise floor, the heartbeat disappears, and the scalp coupling index drops. Such channels are rejected, not corrected.'],
    ambient: ['Instrument', 'Room light leaks under the cap. Whatever the multiplexing does not reject adds to the signal: a steady offset, a step when the lights are switched on, and the 120 Hz flicker of the mains, which sampling at 10 Hz folds down (aliases) to slow beats that look like physiology. Ambient photons also add shot noise even when their mean is removed.'],
    noise: ['Instrument', 'Detector noise (a floor set by the electronics, plus shot noise that grows with the light) and slow instability of the sources. It is white, so it is spread over all frequencies, and averaging trials shrinks it.'],
    brain: ['Cortex', 'What the experiment is about: the haemodynamic response of the active cortex, seen through the small part of each channel\'s path that reaches it.']
  };
  const infoOf = g => INFO[g.id] || INFO[g.kind] || ['', ''];

  function cards() {
    const ds = S.ds;
    const order = ['brain', 'physio', 'artifact', 'noise'];
    const groups = ds.groups.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    $('confToggles').innerHTML = groups.map(g => {
      const [kind, txt] = infoOf(g);
      const first = txt.split('. ')[0] + '.';
      return `<label class="toggle${st.sel === g.id ? ' sel' : ''}" data-id="${g.id}"><input type="checkbox" data-id="${g.id}" ${S.enabled.has(g.id) ? 'checked' : ''}>
        <span class="t">${g.label}</span><small><span class="kind">${kind}</span> · ${first}</small></label>`;
    }).join('');
    $('confToggles').querySelectorAll('input').forEach(inp => inp.addEventListener('change', e => {
      e.stopPropagation();
      const id = inp.dataset.id;
      if (inp.checked) S.enabled.add(id); else S.enabled.delete(id);
      st.cache = {};
      NIRS.app.run('assemble');
    }));
    $('confToggles').querySelectorAll('.toggle').forEach(el => el.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      st.sel = el.dataset.id;
      render();
    }));
  }

  function alone(id) {
    if (st.cacheV !== S.version) { st.cache = {}; st.cacheV = S.version; }
    if (st.cache[id]) return st.cache[id];
    const ds = S.ds;
    const set = new Set([id]);
    if (id === 'poor' || id === 'ambient') set.add('noise');
    const rec = NIRS.assemble(ds, { enabled: set, noise: set.has('noise') });
    const conc = NIRS.pipeline.quickConc(ds, rec, S.P);
    st.cache[id] = { rec, conc };
    return st.cache[id];
  }
  function allNow() {
    if (st.cacheV !== S.version) { st.cache = {}; st.cacheV = S.version; }
    if (!st.cache.__all) st.cache.__all = { rec: S.rec, conc: NIRS.pipeline.quickConc(S.ds, S.rec, S.P) };
    return st.cache.__all;
  }

  function render() {
    if (!S.ds) return;
    const ds = S.ds, T = D.theme();
    if (!st.sel || !ds.groups.some(g => g.id === st.sel)) st.sel = (ds.groups.find(g => g.id === 'taskbp' && g.on) || ds.groups.find(g => g.kind === 'physio') || ds.groups[0]).id;
    cards();
    const ch = ui.chSelect($('confCh'));
    const g = ds.groups.find(x => x.id === st.sel);
    $('confTitle').textContent = `${g.label}: its fingerprint`;
    const win = ctl.win.get();
    $('confT').max = String(Math.max(0, Math.floor(ds.dur - win)));
    const t0 = Math.min(ctl.t.get(), Math.max(0, ds.dur - win)), t1 = t0 + win;
    const i0 = Math.max(0, Math.floor(t0 * ds.fs)), i1 = Math.min(ds.n, Math.ceil(t1 * ds.fs));
    const t = ds.t.subarray(i0, i1);
    const A = alone(st.sel), B = allNow();
    const bands = D.taskBands(ds, t0, t1), ev = D.eventLines(ds, t0, t1);
    const ser = (R) => st.as === 'hb'
      ? [{ y: R.conc[ch].hbo.subarray(i0, i1), color: T.hbo, label: 'HbO' }, { y: R.conc[ch].hbr.subarray(i0, i1), color: T.hbr, label: 'HbR' }]
      : ds.lambdas.map((l, li) => { const x = R.rec.I[ch][li], m = NIRS.mean(x); return { y: Float64Array.from(x.subarray(i0, i1), v => 100 * (v / m - 1)), color: ui.lambdaColor(li), label: l + ' nm' }; });
    const yl = st.as === 'hb' ? 'Δ concentration (µM)' : 'intensity (% of mean)';
    const fmt = st.as === 'hb' ? v => v.toFixed(3) + ' µM' : v => v.toFixed(2) + '%';
    if (!st.pA) st.pA = new D.Plot($('cvConfAlone'), { height: 190 });
    st.pA.draw({ x: t, xLabel: '', yLabel: yl, series: ser(A), bands, vlines: ev, title: `${g.label} alone${S.enabled.has(st.sel) ? '' : ' (switched off in the recording)'}`, tipX: x => ui.fmtT(x), tipFmt: fmt });
    if (!st.pB) st.pB = new D.Plot($('cvConfAll'), { height: 190 });
    st.pB.draw({ x: t, xLabel: 'time (s)', yLabel: yl, series: ser(B), bands, vlines: ev, title: 'everything switched on', tipX: x => ui.fmtT(x), tipFmt: fmt });
    ui.legend($('confLegend'), (st.as === 'hb' ? [{ color: T.hbo, label: 'HbO' }, { color: T.hbr, label: 'HbR' }] : ds.lambdas.map((l, li) => ({ color: ui.lambdaColor(li), label: l + ' nm' }))).concat(ds.events.length ? [{ color: D.alpha(T.series[0], 0.4), label: 'task' }] : []));
    // map: size of the component in each channel
    const size = ds.chans.map((c, i) => st.as === 'hb' ? NIRS.std(A.conc[i].hbo) : NIRS.std(A.rec.I[i][ds.nL - 1]) / NIRS.mean(A.rec.I[i][ds.nL - 1]) * 100);
    const gm = D.fit($('cvConfMap'), w => Math.min(280, w * 0.62));
    let mx = 0; size.forEach(v => { if (isFinite(v)) mx = Math.max(mx, v); });
    st.map = D.probeMap(gm.ctx, ds, { x: 4, y: 18, w: gm.w - 8, h: gm.h - 22 }, { values: size, sequential: true, range: [0, mx || 1], selected: ch, highlight: st.sel === 'poor' ? S.cfg.artifacts.poor.optode : null });
    gm.ctx.fillStyle = T.ink2; gm.ctx.font = D.font(10); gm.ctx.textAlign = 'left'; gm.ctx.textBaseline = 'top';
    gm.ctx.fillText(`size in each channel (${st.as === 'hb' ? 'SD of HbO, max ' + mx.toFixed(3) + ' µM' : 'SD of intensity, max ' + mx.toFixed(2) + '%'})`, 6, 2);
    st.size = size; st.unit = st.as === 'hb' ? ' µM' : '%';
    D.bindProbe($('cvConfMap'), () => st.map, () => S.ds, ci => { S.selCh = ci; NIRS.app.markAll(); }, ci => `${S.ds.chans[ci].label}: ${st.size[ci].toFixed(3)}${st.unit}`);
    // spectrum
    const wa = NIRS.dsp.welch(B.conc[ch].hbo, ds.fs, 100), wb = NIRS.dsp.welch(A.conc[ch].hbo, ds.fs, 100);
    const k0 = 1;
    const f = wa.f.subarray(k0), pa = wa.p.subarray(k0), pb = wb.p.subarray(k0);
    const ph = S.cfg.physiology;
    const vl = [];
    if (ph.cardiac.on) vl.push({ x: ph.cardiac.rate, color: T.muted, dash: [2, 3], label: 'heart' });
    if (ph.respiration.on) vl.push({ x: ph.respiration.rate, color: T.muted, dash: [2, 3], label: 'breath' });
    if (ph.mayer.on) vl.push({ x: ph.mayer.rate, color: T.muted, dash: [2, 3], label: 'Mayer' });
    const task = taskFreq(ds); if (task) vl.push({ x: task, color: T.accent, dash: [4, 3], label: 'task' });
    if (!st.pS) st.pS = new D.Plot($('cvConfSpec'), { height: 200 });
    let pmax = 0; for (let i = 0; i < pa.length; i++) pmax = Math.max(pmax, pa[i], pb[i]);
    st.pS.draw({
      x: f, xLog: true, yLog: true, xLabel: 'frequency (Hz)', yLabel: 'HbO power (µM²/Hz)', yRange: [pmax * 1e-7, pmax * 3],
      series: [{ y: pa, color: T.trace, label: 'everything', width: 1.5 }, { y: pb, color: T.hbo, label: g.label + ' alone', width: 1.5 }],
      vlines: vl.filter(v => v.x > f[0] && v.x < f[f.length - 1]), tipX: x => `${x.toFixed(3)} Hz`, tipFmt: v => v.toExponential(1)
    });
    const [kind, txt] = infoOf(g);
    $('confInfo').innerHTML = `<p><strong>${g.label}</strong> <span class="badge">${kind}</span></p><p>${txt}</p>`;
  }
  function taskFreq(ds) {
    const tasks = ds.events;
    if (tasks.length < 2) return null;
    const per = (tasks[tasks.length - 1].t - tasks[0].t) / (tasks.length - 1);
    return 1 / per;
  }
  NIRS.taskFreq = taskFreq;

  NIRS.tabs.confounds = {
    init() {
      ctl.t = ui.range('confT', v => ui.fmtT(v), render);
      ctl.win = ui.range('confWin', v => v + ' s', render);
      ui.seg($('confAsSeg'), v => { st.as = v; render(); });
    },
    onBuild() { st.cache = {}; },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
