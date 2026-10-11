/* MEG simulator: application state, the processing pipeline, tabs, and
   the Experiment tab.  Each other tab lives in its own file and registers
   itself in MEG.tabs with init(), render() and, optionally, onBuild()
   and onArray() (called when the sensor array changes). */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, SUP = MEG.suppress, dsp = MEG.dsp;
  const $ = id => document.getElementById(id);

  /* ---------- shared state ---------- */
  const S = MEG.S = {
    src: '', exIndex: 0, cfg: null, ds: null, enabled: new Set(),
    shield: null,         // { room, nulling, refs, sss: off|sss|tsss, comp, ssp, sspEcg, sspEog, order }
    sum: null,            // running sum of the enabled generators on every channel and reference
    rec: null,            // as recorded: MEG.finish output
    sup: null,            // after noise rejection: { rows, steps, W, U, ssp, sss, info }
    proc: null,           // offline filters { hp, lp, notch, notchWidth, harmonics, order, phase }
    filt: null,           // { rows, chain }
    clean: null,          // rows after ICA removal (or filt.rows)
    ica: null,            // { model, sigma, rejected, stale, changed, type }
    epoch: null,          // { t0, t1, baseline, rejectOn, rejField, rejGrad, ignoreBad }
    ep: null,             // epochs of the clean data with rejection flags
    truth: null,          // true evoked fields per condition, through the same chain
    cache: {},            // reference weights, empty-room projectors, SSS models
    cursorT: 0, tab: 'instrument', version: 0
  };
  const TABS = MEG.tabs = MEG.tabs || {};
  const dirty = {};
  const freshICA = () => ({ model: null, sigma: null, rejected: new Set(), stale: false, changed: false, type: null });

  /* ---------- small UI helpers ---------- */
  const ui = MEG.ui = {
    $,
    debounce(fn, ms) { let t = null; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; },
    fill(sel, items, value) {
      sel.innerHTML = '';
      items.forEach(it => {
        const o = document.createElement('option');
        if (typeof it === 'string') { o.value = it; o.textContent = it; } else { o.value = it.value; o.textContent = it.label; }
        sel.appendChild(o);
      });
      if (value !== undefined && items.some(it => String(typeof it === 'string' ? it : it.value) === String(value))) sel.value = value;
    },
    range(id, fmt, cb) {
      const el = $(id), out = $(id + 'V');
      const show = () => { if (out) out.textContent = fmt(parseFloat(el.value)); };
      el.addEventListener('input', () => { show(); if (cb) cb(parseFloat(el.value)); });
      show();
      return { el, show, get: () => parseFloat(el.value), set: v => { el.value = v; show(); } };
    },
    seg(el, cb) {
      const btns = Array.from(el.querySelectorAll('button'));
      const val = b => Object.values(b.dataset)[0];
      const set = v => btns.forEach(b => b.setAttribute('aria-pressed', String(val(b) === String(v))));
      btns.forEach(b => b.addEventListener('click', () => { if (b.disabled) return; set(val(b)); cb(val(b)); }));
      return { set, get: () => { const b = btns.find(x => x.getAttribute('aria-pressed') === 'true'); return b ? val(b) : null; }, btns };
    },
    legend(el, items) {
      el.innerHTML = items.map(it => `<span><span class="sw${it.dot ? ' dot' : ''}${it.dash ? ' dash' : ''}" style="${it.dash ? 'color:' : 'background:'}${it.color}"></span>${it.label}</span>`).join('');
    },
    readouts(el, pairs) {
      el.innerHTML = pairs.map(([k, v, title]) => `<div class="ro"${title ? ` title="${String(title).replace(/"/g, '&quot;')}"` : ''}><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    },
    busy(on) { $('busy').classList.toggle('on', !!on); },
    progress(id, f) { const el = $(id); if (el) el.firstElementChild.style.width = Math.round(MEG.clamp(f, 0, 1) * 100) + '%'; },
    groupColor(id) {
      const T = D.theme();
      const g = S.ds && S.ds.groups.find(x => x.id === id);
      if (!g) return T.muted;
      if (g.kind === 'source') return g.slot < 6 ? T.series[g.slot] : T.muted;
      if (g.kind === 'background') return T.ink2;
      if (g.kind === 'sensor') return T.muted;
      const k = ['environment', 'line', 'cardiac', 'blinks', 'saccades', 'muscle', 'dental', 'jumps', 'bad', 'movement', 'hpi'].indexOf(id);
      return [T.series[7], T.series[3], T.series[7], T.series[4], T.series[4], T.series[1], T.series[6], T.series[5], T.series[7], T.series[2], T.series[6]][k] || T.series[7];
    },
    sourceColor(slot) { const T = D.theme(); return slot < 6 ? T.series[slot] : T.muted; },
    condColor(i) { const T = D.theme(); return T.series[i % 8]; },
    fmtT(t) { const m = Math.floor(t / 60), s = t - 60 * m; return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`; },
    // field or gradient with a sensible prefix
    fmtV(v, unit, digits) {
      if (unit !== 'fT/cm') return MEG.fmtB(v, digits);
      const a = Math.abs(v), u = a >= 0.9995e6 ? [1e6, 'nT/cm'] : a >= 999.5 ? [1e3, 'pT/cm'] : [1, 'fT/cm'];
      const x = v / u[0], d = digits === undefined ? (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2) : digits;
      return `${x.toFixed(d)} ${u[1]}`;
    },
    unitOf(kind) { return kind === 'planar' ? 'fT/cm' : 'fT'; },
    arr() { return S.ds.array; },
    kindLabel(kind) { return MEG.KIND_LABEL[kind] || kind; },
    // channel indices of one kind (default: the array's main kind)
    chans(kind) { const arr = S.ds.array, k = kind || arr.main; return arr.channels.map((c, i) => c.kind === k ? i : -1).filter(i => i >= 0); },
    chanOptions(kind) { return ui.chans(kind).map(c => ({ value: String(c), label: S.ds.array.channels[c].name })); },
    // The channel of a kind where the brain's sources (the evoked ones first) are largest.
    bestChannel(kind) {
      const ds = S.ds, list = ui.chans(kind);
      const srcGens = ds.gens.filter(g => g.kind === 'source');
      const ev = srcGens.filter(g => g.evoked);
      const use = ev.length ? ev : srcGens;
      if (!use.length) return list[0];
      let best = list[0], bv = -1;
      list.forEach(c => { let s = 0; use.forEach(g => { s += Math.abs(MEG.genPattern(ds, g)[c]); }); if (s > bv) { bv = s; best = c; } });
      return best;
    },
    hasSSS() { return SUP.sssAvailable(S.ds.array); },
    /* The list of every signal in the recording, each with a switch.  Shared
       by the Noise and Recording tabs; both lists stay in step. */
    layers(box) {
      const ds = S.ds, A = S.cfg.artifacts, R = S.cfg.recording, arr = ds.array;
      const fB = x => MEG.fmtB(x);
      const detail = g => {
        if (g.kind === 'source') { const s = S.cfg.sources.find(x => x.name === g.id); return { dipole: 'a current dipole', pair: 'two coupled dipoles', auditory: 'auditory evoked fields', somatosensory: 'somatosensory evoked fields', alpha: 'parieto-occipital alpha', spike: 'interictal spikes' }[s.type]; }
        if (g.kind === 'background') return `${fB(R.background)} RMS of 1/f cortical activity`;
        if (g.kind === 'sensor') return `${MEG.chanNoise(arr, arr.channels[0], R.noise)} ${arr.type === 'planar' ? 'fT/cm and 3 fT' : 'fT'} per √Hz, white with a 1/f rise`;
        return {
          environment: `${fB(A.environment.amp)} without the room`, line: `${R.mains} Hz, ${fB(A.line.amp)} without the room`,
          cardiac: `${Math.round(A.cardiac.rate * 60)} beats per min, ${fB(A.cardiac.amp)}`, blinks: `${A.blinks.rate} per s, ${fB(A.blinks.amp)}, eyes open only`,
          saccades: `${A.saccades.rate} per s, ${fB(A.saccades.amp)}`, muscle: `bursts, ${A.muscle.rate} per s`, dental: `a magnet in the mouth, ${fB(A.dental.amp)} as the jaw moves`,
          jumps: arr.type === 'opm' ? 'none: OPMs have no flux jumps' : `${A.jumps.rate} per s, steps of up to ${fB(A.jumps.amp * 1.5)}`, bad: `${A.bad.label}, ${A.bad.mode}`,
          movement: `up to ${Math.round(A.movement.amp * 10)} mm`, hpi: `${(ds.hpiFreqs || []).length} coils at ${(ds.hpiFreqs || []).join(', ')} Hz`
        }[g.id] || '';
      };
      const sections = [['Brain', g => g.kind === 'source' || g.kind === 'background'], ['Artifacts', g => g.kind === 'artifact'], ['Sensors', g => g.kind === 'sensor']];
      box.innerHTML = sections.map(([title, f]) => {
        const gs = ds.groups.filter(f);
        if (!gs.length) return '';
        return `<h4>${title}</h4>` + gs.map(g => {
          const info = g.kind === 'artifact' ? MEG.ARTIFACT_INFO[g.id].desc : '';
          return `<label class="layer" title="${info.replace(/"/g, '&quot;')}"><input type="checkbox" data-g="${g.id}" ${S.enabled.has(g.id) ? 'checked' : ''}>
            <span class="chip" style="background:${ui.groupColor(g.id)}"></span><span>${g.label}<small>${detail(g)}</small></span></label>`;
        }).join('');
      }).join('');
      if (!box._bound) {
        box._bound = true;
        box.addEventListener('change', e => { const id = e.target.dataset.g; if (id) MEG.app.setGroup(id, e.target.checked); });
      }
    }
  };

  /* ---------- the pipeline ----------
     Stages, in order: sum (mix the enabled generators) -> finish (sensor
     noise, jumps, bad channel, online filters) -> suppress (references,
     SSS, SSP) -> filter (offline) -> ica (remove components) -> epoch.
     run(stage) recomputes from that stage down, then marks every tab for
     redrawing.  A newer run supersedes an older one still in progress. */
  const STAGES = ['sum', 'finish', 'suppress', 'filter', 'ica', 'epoch'];
  let runGen = 0;
  const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const SUPERSEDED = { superseded: true };
  function sumOpts() { return { room: S.shield.room, nulling: S.shield.nulling, moving: S.enabled.has('movement') }; }
  MEG.app = { frame, sumOpts };
  async function run(stage) {
    if (!S.ds) return;
    const gen = ++runGen;
    ui.busy(true);
    await frame();
    if (gen !== runGen) return;
    try {
      const k = STAGES.indexOf(stage);
      if (k <= 0) S.sum = MEG.sumGroups(S.ds, S.enabled, sumOpts());
      if (k <= 1) S.rec = MEG.finish(S.ds, S.sum, { enabled: S.enabled, room: S.shield.room });
      if (k <= 2) await suppressStage(gen);
      if (k <= 3) filterStage();
      if (k <= 4) icaStage();
      if (k <= 5) epochStage();
      S.version++;
      S.truth = null; S.budget = null;
      Object.keys(TABS).forEach(t => { dirty[t] = true; });
      status();
      render();
    } catch (e) {
      if (e !== SUPERSEDED) { console.error(e); $('status').insertAdjacentHTML('beforeend', `<span class="chip" style="color:var(--crit-ink)">error: ${e.message}</span>`); }
    } finally {
      if (gen === runGen) { ui.busy(false); ui.progress('nzProgress', 0); }
    }
  }
  MEG.app.run = run;
  MEG.app.render = () => render();
  MEG.app.markAll = () => { Object.keys(TABS).forEach(t => { dirty[t] = true; }); render(); };
  MEG.app.dirty = name => { dirty[name] = true; };
  // Do something heavy after the busy indicator has painted.
  MEG.app.later = function (fn) {
    ui.busy(true);
    requestAnimationFrame(() => setTimeout(() => { try { fn(); } catch (e) { console.error(e); } ui.busy(false); }, 15));
  };

  async function suppressStage(gen) {
    const ds = S.ds, arr = ds.array, sh = S.shield, rec = S.rec;
    const sup = { rows: rec.rows, steps: [], W: null, U: [], ssp: [], sss: null, info: null, notes: [] };
    S.sup = sup;
    if (rec.saturated) { sup.notes.push('Every OPM is saturated without the shielded room; nothing can be recovered.'); return; }
    let rows = rec.rows;
    if (sh.refs) {
      const key = arr.type;
      if (!S.cache.W || S.cache.W.key !== key) S.cache.W = { key, W: SUP.refWeights(ds) };
      rows = SUP.applyRefs(rows, rec.refs, S.cache.W.W);
      sup.W = S.cache.W.W; sup.steps.push('references');
    }
    if (sh.sss !== 'off') {
      if (!SUP.sssAvailable(arr)) sup.notes.push('SSS skipped: ' + SUP.SSS_WHY[arr.type]);
      else {
        const moving = S.enabled.has('movement'), comp = !!sh.comp && moving;
        if (!S.cache.sss || S.cache.sss.key !== arr.type) S.cache.sss = { key: arr.type, map: new Map() };
        ui.progress('nzProgress', 0.02);
        const out = await SUP.applySSS(ds, rows, { order: sh.order || undefined, tsss: sh.sss === 'tsss', compensate: comp, moving, cache: S.cache.sss.map }, async f => {
          ui.progress('nzProgress', f);
          const st = $('nzStatus'); if (st) st.textContent = `${sh.sss === 'tsss' ? 'Temporal SSS' : 'SSS'}${comp ? ' with movement compensation' : ''}: ${Math.round(f * 100)}%`;
          await frame();
          if (gen !== runGen) throw SUPERSEDED;
        });
        rows = out.rows; sup.info = out.info;
        sup.sss = { order: out.info.order, tsss: sh.sss === 'tsss', comp, moving };
        sup.steps.push(sh.sss === 'tsss' ? 'tSSS' : 'SSS');
        if (comp) sup.steps.push('movement compensation');
        else if (sh.comp && !moving) sup.notes.push('Movement compensation has nothing to do: head movement is switched off.');
      }
    } else if (sh.comp) sup.notes.push('Movement compensation works through SSS; switch SSS on.');
    // SSP last: empty-room vectors, then heartbeat and blink projectors from the data so far
    const vecs = [];
    if (sh.ssp > 0) {
      const key = arr.type + ':' + sh.room;
      if (!S.cache.er || S.cache.er.key !== key) S.cache.er = { key, list: SUP.sspEmptyRoom(ds, 8, { room: sh.room }) };
      S.cache.er.list.slice(0, sh.ssp).forEach(v => vecs.push(v));
    }
    const fromEvents = (group, win, label, kind) => {
      const g = ds.gens.find(x => x.group === group);
      if (!S.enabled.has(group) || !g || !g.events || g.events.length < 3) { sup.notes.push(`No ${label.toLowerCase()} projector: the ${MEG.ARTIFACT_INFO[group].label.toLowerCase()} artifact is off.`); return; }
      const p = SUP.sspFromEvents(rows, ds.fs, g.events, win, label, kind);
      if (p) vecs.push(p);
    };
    if (sh.sspEcg) fromEvents('cardiac', [-0.08, 0.12], 'Heartbeat', 'ecg');
    if (sh.sspEog) fromEvents('blinks', [0, 0.45], 'Blink', 'eog');
    if (vecs.length) {
      const U = SUP.orthonormal(vecs.map(v => v.v));
      rows = SUP.applySSP(rows, U);
      sup.U = U; sup.ssp = vecs; sup.steps.push('SSP (' + vecs.length + ')');
    }
    sup.rows = rows;
  }

  function filterStage() {
    const ch = dsp.chain(S.proc, S.ds.fs);
    S.filt = { chain: ch, rows: ch.empty ? S.sup.rows : S.sup.rows.map(r => ch.apply(Float32Array.from(r))) };
  }
  function icaStage() {
    const I = S.ica;
    if (I.model && I.type !== S.ds.array.type) I.stale = true;
    S.clean = (I.model && !I.stale && I.rejected.size) ? MEG.app.icaClean(I.model, S.filt.rows, Array.from(I.rejected), I.sigma) : S.filt.rows;
  }
  // Subtract rejected components; the model was fitted on channels divided by sigma.
  MEG.app.icaClean = function (model, rows, rejected, sigma) {
    const out = rows.map(r => Float32Array.from(r)), n = rows[0].length, nch = rows.length;
    rejected.forEach(ci => {
      const c = model.comps[ci]; if (!c) return;
      const s = new Float64Array(n);
      let off = 0;
      for (let ch = 0; ch < nch; ch++) {
        const w = c.unmix[ch] / sigma[ch], r = rows[ch]; if (w === 0) continue;
        off += c.unmix[ch] * model.mean[ch];
        for (let i = 0; i < n; i++) s[i] += w * r[i];
      }
      for (let ch = 0; ch < nch; ch++) { const a = c.topo[ch] * sigma[ch], o = out[ch]; if (a === 0) continue; for (let i = 0; i < n; i++) o[i] -= a * (s[i] - off); }
    });
    return out;
  };
  // Activations of components over [i0, i1) of channel data, on the scaled channels.
  MEG.app.icaActivation = function (model, comp, rows, sigma, i0, i1) {
    const len = i1 - i0, s = new Float32Array(len);
    for (let ch = 0; ch < rows.length; ch++) {
      const w = comp.unmix[ch], r = rows[ch], mu = model.mean[ch], sg = sigma[ch]; if (w === 0) continue;
      for (let i = 0; i < len; i++) s[i] += w * (r[i0 + i] / sg - mu);
    }
    return s;
  };
  // Noise of every channel, used to put magnetometers and gradiometers on one scale.
  MEG.app.chanSigma = function () {
    const arr = S.ds.array, R = S.cfg.recording;
    return Float64Array.from(arr.channels, ch => MEG.chanNoise(arr, ch, R.noise));
  };

  function epochStage() {
    const E = S.epoch, ds = S.ds, arr = ds.array;
    const ep = dsp.epoch(S.clean, ds.fs, ds.events, E.t0, E.t1, E.baseline);
    const ignore = new Set(E.ignoreBad && S.enabled.has('bad') && ds.badSite >= 0 ? arr.siteChannels[ds.badSite] : []);
    ep.list.forEach(e => {
      let worst = 0, at = -1;
      for (let c = 0; c < arr.nch; c++) {
        if (ignore.has(c)) continue;
        const thr = arr.channels[c].kind === 'planar' ? E.rejGrad : E.rejField;
        const r = e.p2p[c] / thr; if (r > worst) { worst = r; at = c; }
      }
      e.worst = worst; e.worstCh = at;
      e.rejected = !!E.rejectOn && worst > 1;
    });
    ep.ignored = ignore;
    S.ep = ep;
  }
  MEG.app.reepoch = () => run('epoch');

  /* The true evoked field of every condition: only the evoked generators,
     no noise, through the same online filters, noise rejection (tSSS's
     temporal step aside) and offline filters as the data. */
  let truthPending = null;
  MEG.app.truth = function () {
    if (S.truth) return Promise.resolve(S.truth);
    if (truthPending) return truthPending;
    const version = S.version;
    truthPending = (async () => {
      const ds = S.ds;
      const ids = new Set(ds.groups.filter(g => g.kind === 'source' && S.enabled.has(g.id)).map(g => g.id));
      const gens = ds.gens.filter(g => g.evoked && ids.has(g.group));
      const out = { conds: null, times: null, ok: false };
      if (!gens.length || !ds.events.length) return out;
      const sum = MEG.sumGroups(ds, ids, Object.assign(sumOpts(), { genFilter: g => !!g.evoked }));
      const rec = MEG.finish(ds, sum, { enabled: new Set(), room: S.shield.room, noise: false });
      let rows = rec.rows;
      const sup = S.sup;
      if (sup.W) rows = SUP.applyRefs(rows, rec.refs, sup.W);
      if (sup.sss) rows = (await SUP.applySSS(ds, rows, { order: sup.sss.order, tsss: false, compensate: sup.sss.comp, moving: sup.sss.moving, cache: S.cache.sss && S.cache.sss.map })).rows;
      if (sup.U && sup.U.length) rows = SUP.applySSP(rows, sup.U);
      const E = S.epoch;
      const average = rr => {
        const ep = dsp.epoch(rr, ds.fs, ds.events, E.t0, E.t1, E.baseline);
        out.times = ep.times; out.nT = ep.nT; out.nCh = ep.nCh;
        return ds.conditions.map((c, ci) => {
          const sel = ep.list.filter(e => e.ev.ci === ci);
          const acc = new Float64Array(ep.nCh * ep.nT);
          sel.forEach(e => { for (let i = 0; i < acc.length; i++) acc[i] += e.data[i]; });
          if (sel.length) for (let i = 0; i < acc.length; i++) acc[i] /= sel.length;
          return { n: sel.length, data: acc };
        });
      };
      out.rawConds = average(rows);         // before the offline filters
      const ch = S.filt.chain;
      if (!ch.empty) rows = rows.map(r => ch.apply(Float32Array.from(r)));
      out.conds = ch.empty ? out.rawConds : average(rows);
      out.ok = true;
      out.gens = gens;
      if (S.version === version) S.truth = out;
      return out;
    })();
    truthPending.then(() => { truthPending = null; }, () => { truthPending = null; });
    return truthPending;
  };

  /* ---------- switching things ---------- */
  MEG.app.setGroup = function (id, on) {
    if (on === S.enabled.has(id)) return Promise.resolve();
    if (on) S.enabled.add(id); else S.enabled.delete(id);
    if (S.ica.model) S.ica.changed = true;
    if (id === 'movement') return run('sum');
    if (['sensor', 'jumps', 'bad'].includes(id)) return run('finish');
    MEG.sumGroups(S.ds, new Set([id]), Object.assign(sumOpts(), { into: S.sum, subtract: !on }));
    return run('finish');
  };
  MEG.app.setRoom = function (on) {
    if (on === S.shield.room) return Promise.resolve();
    const outside = new Set(['environment', 'line'].filter(g => S.enabled.has(g)));
    if (outside.size) MEG.sumGroups(S.ds, outside, Object.assign(sumOpts(), { into: S.sum, subtract: true }));
    S.shield.room = on;
    if (outside.size) MEG.sumGroups(S.ds, outside, Object.assign(sumOpts(), { into: S.sum }));
    return run('finish');
  };
  MEG.app.setNulling = function (on) {
    if (on === S.shield.nulling) return Promise.resolve();
    const mv = new Set(['movement']);
    const affects = S.enabled.has('movement') && S.ds.array.type === 'opm';
    if (affects) MEG.sumGroups(S.ds, mv, Object.assign(sumOpts(), { into: S.sum, subtract: true }));
    S.shield.nulling = on;
    if (affects) { MEG.sumGroups(S.ds, mv, Object.assign(sumOpts(), { into: S.sum })); return run('finish'); }
    status(); MEG.app.markAll();
    return Promise.resolve();
  };
  MEG.app.setSensors = function (type) {
    if (!S.ds || type === S.ds.array.type) return Promise.resolve();
    MEG.setArray(S.ds, type);
    S.ica = freshICA();
    Object.values(TABS).forEach(t => { if (t.onArray) { try { t.onArray(); } catch (e) { console.error(e); } } });
    return run('sum');
  };
  MEG.app.setShield = function (patch) {
    Object.assign(S.shield, patch);
    return run('suppress');
  };
  MEG.app.setProc = function (patch) { Object.assign(S.proc, patch); return run('filter'); };

  /* ---------- status line ---------- */
  function status() {
    const el = $('status'), busy = $('busy');
    if (!S.cfg || !S.ds) return;
    const ds = S.ds, arr = ds.array, P = S.proc, sh = S.shield;
    const filt = [P.hp ? 'HP ' + MEG.fmt(P.hp, P.hp < 1 ? 2 : 1).replace(/\.?0+$/, '') : null, P.lp ? 'LP ' + P.lp : null, P.notch ? 'notch ' + P.notch : null].filter(Boolean).join(', ');
    const chips = [
      `<b>${arr.nch}</b> ${arr.type === 'planar' ? 'channels (planar + mag)' : MEG.KIND_LABEL[arr.type]}`, `<b>${ds.fs}</b> Hz`,
      `<b>${Math.round(ds.dur)}</b> s`, `<b>${ds.events.length}</b> trials`,
      `room <b>${sh.room ? 'on' : 'off'}</b>`,
      `rejection <b>${S.sup && S.sup.steps.length ? S.sup.steps.join(', ') : 'none'}</b>`,
      `filters <b>${filt || 'none'}</b>`,
      `ICA <b>${S.ica.model && !S.ica.stale ? S.ica.rejected.size + ' removed' : 'not run'}</b>`
    ];
    el.innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join('');
    el.appendChild(busy);
  }
  MEG.app.status = status;

  /* ---------- tabs ---------- */
  const tabNames = ['instrument', 'experiment', 'fields', 'sources', 'noise', 'recording', 'spectra', 'processing', 'averaging', 'estimation', 'guide'];
  function showTab(name, focus) {
    if (!tabNames.includes(name)) name = 'instrument';
    S.tab = name;
    tabNames.forEach(t => {
      const b = $('t-' + t), p = $('tab-' + t);
      b.setAttribute('aria-selected', String(t === name));
      b.tabIndex = t === name ? 0 : -1;
      p.hidden = t !== name;
    });
    if (focus) $('t-' + name).focus();
    try { localStorage.setItem('megsim-tab', name); } catch (e) {}
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    render();
  }
  function render() {
    const t = TABS[S.tab];
    if (!t || !t.render) return;
    if (!dirty[S.tab] && t.rendered) return;
    if (t.needsData !== false && !S.ds) return;
    dirty[S.tab] = false;
    t.rendered = true;
    try { t.render(); } catch (e) { console.error(e); }
  }
  MEG.app.showTab = showTab;

  /* ---------- building a recording ---------- */
  function build(src) {
    let cfg;
    const box = $('errbox');
    try { cfg = MEG.dsl.build(src); } catch (e) {
      box.className = 'errbox err';
      box.textContent = e.line ? `Line ${e.line}, column ${e.col}: ${e.message}` : e.message;
      highlightError(e.line);
      return false;
    }
    S.cfg = cfg; S.src = src;
    const an = cfg.analysis, sh = cfg.shielding;
    S.proc = { hp: an.hp, lp: an.lp, notch: an.notch, notchWidth: 2, harmonics: false, order: an.order, phase: an.phase };
    S.epoch = {
      t0: an.epoch[0], t1: an.epoch[1], baseline: an.baseline,
      rejectOn: !!(an.reject.field || an.reject.grad), rejField: an.reject.field || 4000, rejGrad: an.reject.grad || (an.reject.field || 4000), ignoreBad: true
    };
    S.shield = { room: sh.room, nulling: sh.nulling, refs: sh.refs, sss: sh.sss, comp: an.compensate, ssp: sh.ssp, sspEcg: false, sspEog: false, order: sh.order };
    S.icaK = an.ica || 20;
    MEG.app.later(() => {
      const t0 = performance.now();
      S.ds = MEG.simulate(cfg);
      S.enabled = new Set(S.ds.groups.filter(g => g.on).map(g => g.id));
      S.ica = freshICA();
      S.cache = {};
      S.cursorT = Math.min(S.cursorT, S.ds.dur);
      Object.values(TABS).forEach(t => { if (t.onBuild) { try { t.onBuild(); } catch (e) { console.error(e); } } });
      run('sum').then(() => {
        const ms = Math.round(performance.now() - t0);
        box.className = 'errbox ok';
        box.textContent = `Recorded ${Math.round(S.ds.dur)} s on ${S.ds.array.nch} channels at ${cfg.recording.fs} Hz` +
          (S.ds.events.length ? `, ${S.ds.events.length} trials` : '') + ` in ${ms} ms.`;
      });
      warnings(cfg);
      experimentSummary();
    });
    return true;
  }
  MEG.app.build = build;
  // Re-simulate after the controls changed the configuration, keeping switches and the array.
  MEG.app.rebuildFromCfg = function () {
    MEG.app.later(() => {
      const keep = S.enabled, type = S.ds.array.type;
      S.ds = MEG.simulate(S.cfg);
      if (S.ds.array.type !== type) MEG.setArray(S.ds, type);
      const ids = new Set(S.ds.groups.map(g => g.id));
      S.enabled = new Set(Array.from(keep).filter(id => ids.has(id)));
      S.ds.groups.forEach(g => { if (g.kind === 'source' && !keep.has(g.id)) S.enabled.add(g.id); });
      if (S.ica.model) S.ica.changed = true;
      S.cache = {};
      Object.values(TABS).forEach(t => { if (t.onBuild) { try { t.onBuild(true); } catch (e) { console.error(e); } } });
      run('sum');
      experimentSummary();
    });
  };

  /* ---------- Experiment tab ---------- */
  const ed = $('editor'), hi = $('edHi');
  function syncHighlight() { hi.innerHTML = MEG.dsl.highlight(ed.value); hi.scrollTop = ed.scrollTop; hi.scrollLeft = ed.scrollLeft; }
  function highlightError(line) {
    if (!line) return;
    const lines = ed.value.split('\n');
    let pos = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus(); ed.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  }
  function warnings(cfg) {
    $('warnlist').innerHTML = cfg.warnings.map(w => `<li>${w.line ? 'Line ' + w.line + ': ' : ''}${w.msg}</li>`).join('');
  }
  const SOURCE_TEXT = {
    dipole: s => `a ${s.signal} ${s.signal !== 'pink' ? s.freq + ' Hz ' : ''}dipole of ${s.amp} nAm, ${s.depth.toFixed(1)} cm under ${s.at || 'a custom position'}, ${Math.round(s.tilt)}° from radial`,
    pair: s => `two ${s.freq} Hz dipoles under ${s.dipoles.map(d => d.at || 'a custom position').join(' and ')} (coupling ${s.coupling}, lag ${Math.round(s.lag * 1000)} ms)`,
    auditory: s => `auditory evoked fields from ${s.side === 'both' ? 'both auditory cortices' : 'the ' + s.side + ' auditory cortex'}, ${s.amp} nAm at ${Math.round(s.peaks.reduce((a, b) => (Math.abs(b.gain) > Math.abs(a.gain) ? b : a)).latency * 1000)} ms`,
    somatosensory: s => `somatosensory evoked fields from the ${s.side} hand area, ${s.amp} nAm${s.beta ? `, with a ${s.beta.freq} Hz beta rhythm` : ''}`,
    alpha: s => `${s.freq} Hz parieto-occipital alpha, ${s.amp} nAm, ${Math.round(s.closed * 100)}% eyes closed and ${Math.round(s.open * 100)}% open`,
    spike: s => `interictal spikes of ${s.amp} nAm, ${s.depth.toFixed(1)} cm under ${s.at || 'a custom position'}, ${s.rate} per second`
  };
  function experimentSummary() {
    if (!S.cfg || !S.ds) return;
    const cfg = S.cfg, R = cfg.recording, sh = S.shield, T = D.theme(), ds = S.ds, arr = ds.array;
    // the helmet seen from above, with the sources under it
    const cv = $('cvExpHelmet');
    const { ctx, w, h } = D.fit(cv, w => Math.min(320, w * 0.8));
    const r = Math.min(w, h) / 2 * 0.92, cx = w / 2, cy = h / 2;
    const marks = {};
    if (S.enabled.has('bad') && ds.badSite >= 0) marks[ds.badSite] = T.crit;
    D.helmetMap(ctx, cx, cy, r, { marks, square: arr.type !== 'opm' });
    const seen = new Set();
    ds.gens.filter(g => g.kind === 'source').forEach(g => {
      const [x, y] = D.mapXY(g.pos, cx, cy, r);
      ctx.fillStyle = ui.sourceColor(g.slot); ctx.strokeStyle = T.card; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (!seen.has(g.group)) { D.label(ctx, g.group, x + 8, y - 8, { size: 10, weight: 600 }); seen.add(g.group); }
    });
    const leg = [{ color: T.ink2, label: `${arr.nch} ${arr.type === 'planar' ? 'channels at 105 sites' : MEG.KIND_LABEL[arr.type]}`, dot: true }];
    if (marks[ds.badSite]) leg.push({ color: T.crit, label: `bad sensor ${MEG.SITES[ds.badSite].name}`, dot: true });
    cfg.sources.forEach((s, i) => leg.push({ color: ui.sourceColor(i), label: s.label, dot: true }));
    ui.legend($('expLegend'), leg);
    const src = cfg.sources.map((s, i) => `<li><span class="sw dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ui.sourceColor(i)};margin-right:6px"></span><strong>${s.label}</strong>: ${SOURCE_TEXT[s.type](s)}.</li>`).join('');
    const arts = MEG.ARTIFACTS.filter(k => cfg.artifacts[k].on).map(k => MEG.ARTIFACT_INFO[k].label.toLowerCase());
    const rej = [sh.refs ? 'reference compensation' : null, sh.sss !== 'off' ? (sh.sss === 'tsss' ? 'temporal SSS' : 'SSS') : null, sh.ssp ? `SSP with ${sh.ssp} empty-room vector${sh.ssp > 1 ? 's' : ''}` : null, sh.comp ? 'movement compensation' : null].filter(Boolean);
    const an = cfg.analysis;
    $('expSummary').innerHTML = `<p>${MEG.SENSOR_INFO[R.sensors].desc} Sampled at ${R.fs} Hz with online filters ${R.hp ? R.hp + ' Hz' : 'DC'} to ${R.lp} Hz.</p>
      <ul>${src || '<li>No brain sources declared.</li>'}${R.background ? `<li>Spontaneous brain activity, ${MEG.fmtB(R.background)} RMS on the magnetometers.</li>` : ''}</ul>
      <p>${sh.room ? 'In the shielded room' : '<strong>Without a shielded room</strong>'}${rej.length ? ', with ' + rej.join(', ') : ', with no software noise rejection'}.
      ${arts.length ? 'Artifacts: ' + arts.join(', ') + '.' : 'No artifacts switched on.'}
      Analysis starts with ${an.hp || an.lp ? `a ${an.hp ? an.hp + ' Hz high-pass' : ''}${an.hp && an.lp ? ' and ' : ''}${an.lp ? an.lp + ' Hz low-pass' : ''} filter` : 'no offline filter'} and epochs from ${Math.round(an.epoch[0] * 1000)} to ${Math.round(an.epoch[1] * 1000)} ms.</p>`;
    // timeline
    const cvT = $('cvTimeline');
    const g = D.fit(cvT, 92);
    const X0 = 8, X1 = g.w - 8, dur = ds.dur, sx = t => X0 + t / dur * (X1 - X0);
    ds.blocks.forEach(b => {
      g.ctx.fillStyle = b.state === 'closed' ? T.closed : (b.task ? T.band : 'transparent');
      g.ctx.fillRect(sx(b.t0), 10, sx(b.t1) - sx(b.t0), 44);
      g.ctx.strokeStyle = T.grid; g.ctx.strokeRect(sx(b.t0) + 0.5, 10.5, sx(b.t1) - sx(b.t0), 44);
      g.ctx.fillStyle = T.ink2; g.ctx.font = D.font(10); g.ctx.textAlign = 'left'; g.ctx.textBaseline = 'top';
      const lab = b.task ? 'trials' : 'eyes ' + b.state;
      if (sx(b.t1) - sx(b.t0) > g.ctx.measureText(lab).width + 6) g.ctx.fillText(lab, sx(b.t0) + 3, 13);
    });
    ds.events.forEach(ev => { g.ctx.strokeStyle = ui.condColor(ev.ci); g.ctx.lineWidth = 1; const x = Math.round(sx(ev.t)) + 0.5; g.ctx.beginPath(); g.ctx.moveTo(x, 28); g.ctx.lineTo(x, 52); g.ctx.stroke(); });
    g.ctx.fillStyle = T.muted; g.ctx.font = D.font(10); g.ctx.textBaseline = 'top';
    D.ticks(0, dur, 6).forEach(t => { g.ctx.textAlign = 'center'; g.ctx.fillText(Math.round(t) + ' s', sx(t), 60); });
    ui.legend($('tlLegend'), [{ color: T.closed.replace(/[\d.]+\)$/, '0.6)'), label: 'eyes closed' }].concat(ds.conditions.map((c, i) => ({ color: ui.condColor(i), label: `${c} (${ds.events.filter(e => e.ci === i).length})` }))));
  }
  MEG.app.experimentSummary = experimentSummary;
  TABS.experiment = { render: experimentSummary };
  TABS.guide = { render() {}, needsData: false };

  function loadExample(i, buildNow) {
    S.exIndex = i;
    const ex = MEG.EXAMPLES[i];
    ed.value = ex.src;
    $('exDesc').textContent = ex.desc;
    $('exSelect').value = String(i);
    syncHighlight();
    if (buildNow) build(ed.value);
  }
  MEG.app.loadExample = loadExample;
  // Put new text in the editor (from the controls) without rebuilding.
  MEG.app.setProgram = function (text) { ed.value = text; S.src = text; syncHighlight(); };

  /* ---------- start ---------- */
  MEG.app.start = function () {
    tabNames.forEach((t, i) => {
      const b = $('t-' + t);
      b.addEventListener('click', () => showTab(t));
      b.addEventListener('keydown', e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          showTab(tabNames[(i + (e.key === 'ArrowRight' ? 1 : tabNames.length - 1)) % tabNames.length], true);
        }
      });
    });
    window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
    $('btnTheme').addEventListener('click', () => {
      const isDark = D.theme().dark;
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      try { localStorage.setItem('megsim-theme', isDark ? 'light' : 'dark'); } catch (e) {}
      D.resetTheme();
      MEG.app.markAll();
    });
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { D.resetTheme(); MEG.app.markAll(); });
    let lastW = window.innerWidth;
    window.addEventListener('resize', ui.debounce(() => { if (Math.abs(window.innerWidth - lastW) < 2) return; lastW = window.innerWidth; MEG.app.markAll(); }, 200));
    ui.fill($('exSelect'), MEG.EXAMPLES.map((e, i) => ({ value: String(i), label: e.name })));
    $('exSelect').addEventListener('change', () => loadExample(+$('exSelect').value, true));
    ed.addEventListener('input', syncHighlight);
    ed.addEventListener('scroll', () => { hi.scrollTop = ed.scrollTop; hi.scrollLeft = ed.scrollLeft; });
    ed.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); build(ed.value); }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText('  ', s, ed.selectionEnd, 'end'); syncHighlight(); }
    });
    $('btnBuild').addEventListener('click', () => build(ed.value));
    $('btnRevert').addEventListener('click', () => loadExample(S.exIndex, true));
    S.ica = freshICA();
    Object.values(TABS).forEach(t => { if (t.init) { try { t.init(); } catch (e) { console.error(e); } } });
    // Every canvas is a figure: name it after the panel it sits in
    document.querySelectorAll('canvas').forEach(cv => {
      if (cv.hasAttribute('aria-label')) return;
      const panel = cv.closest('.panel'), h = panel && panel.querySelector('h2');
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', h ? h.childNodes[0].textContent.trim() : 'MEG simulator figure');
    });
    let first = 'instrument';
    try { first = location.hash.slice(1) || localStorage.getItem('megsim-tab') || 'instrument'; } catch (e) {}
    showTab(tabNames.includes(first) ? first : 'instrument');
    loadExample(0, true);
  };
})(typeof window !== 'undefined' ? window : globalThis);
