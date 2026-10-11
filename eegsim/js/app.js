/* EEG simulator: application state, the processing pipeline, tabs, and
   the Experiment tab.  Each other tab lives in its own file and registers
   itself in EEG.tabs with init(), render() and, optionally, onBuild(). */
(function (G) {
  'use strict';
  const EEG = G.EEG, D = EEG.draw;
  const $ = id => document.getElementById(id);

  /* ---------- shared state ---------- */
  const S = EEG.S = {
    src: '', exIndex: 0, cfg: null, ds: null, enabled: new Set(),
    rec: null,            // as recorded: cap channels then M1, M2, against the online reference
    proc: null,           // { reref, hp, lp, notch, notchWidth, harmonics, order, phase }
    filt: null,           // re-referenced and filtered: { labels, rows, unit, positions, mode }
    clean: null,          // rows after ICA removal (or filt.rows)
    ica: { model: null, rejected: new Set(), stale: false, labels: null, mode: null, changed: false },
    epoch: null,          // { t0, t1, baseline, reject }
    ep: null,             // epochs of the clean data with rejection flags
    truth: null,          // true ERPs per condition, filtered and not
    cursorT: 0, tab: 'chain', version: 0
  };
  const TABS = EEG.tabs = EEG.tabs || {};
  const dirty = {};

  /* ---------- small UI helpers ---------- */
  const ui = EEG.ui = {
    $,
    debounce(fn, ms) { let t = null; return function () { const a = arguments; clearTimeout(t); t = setTimeout(() => fn.apply(null, a), ms); }; },
    fill(sel, items, value) {
      sel.innerHTML = '';
      items.forEach(it => {
        const o = document.createElement('option');
        if (typeof it === 'string') { o.value = it; o.textContent = it; } else { o.value = it.value; o.textContent = it.label; }
        sel.appendChild(o);
      });
      if (value !== undefined && items.some(it => (typeof it === 'string' ? it : it.value) == value)) sel.value = value;
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
      const set = v => btns.forEach(b => b.setAttribute('aria-pressed', String(Object.values(b.dataset)[0] === String(v))));
      btns.forEach(b => b.addEventListener('click', () => { set(Object.values(b.dataset)[0]); cb(Object.values(b.dataset)[0]); }));
      return { set, get: () => { const b = btns.find(x => x.getAttribute('aria-pressed') === 'true'); return b ? Object.values(b.dataset)[0] : null; } };
    },
    legend(el, items) {
      el.innerHTML = items.map(it => `<span><span class="sw${it.dot ? ' dot' : ''}${it.dash ? ' dash' : ''}" style="${it.dash ? 'color:' : 'background:'}${it.color}"></span>${it.label}</span>`).join('');
    },
    readouts(el, pairs) {
      el.innerHTML = pairs.map(([k, v, title]) => `<div class="ro"${title ? ` title="${title}"` : ''}><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    },
    busy(on) { $('busy').classList.toggle('on', !!on); },
    groupColor(id) {
      const T = D.theme();
      const g = S.ds && S.ds.groups.find(x => x.id === id);
      if (!g) return T.muted;
      if (g.kind === 'source') return g.slot < 8 ? T.series[g.slot] : T.muted;
      if (g.kind === 'background') return T.ink2;
      if (g.kind === 'artifact') return T.series[7];
      return T.muted;
    },
    sourceColor(slot) { const T = D.theme(); return slot < 8 ? T.series[slot] : T.muted; },
    condColor(i) { const T = D.theme(); return T.series[i % 8]; },
    chOptions(labels) { return labels.map(l => ({ value: l, label: l })); },
    // A sensible default channel for a purpose, if present
    pick(labels, prefs) { for (const p of prefs) if (labels.includes(p)) return p; return labels[0]; },
    fmtT(t) { const m = Math.floor(t / 60), s = t - 60 * m; return m ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`; },
    hasPositions() { return S.filt && S.filt.positions; }
  };

  /* ---------- spline operators, cached per montage ---------- */
  const csdCache = new Map();
  const splineCache = {
    csd(labels) {
      const k = labels.join(',');
      if (!csdCache.has(k)) csdCache.set(k, EEG.makeSpline(labels.map(l => EEG.ELEC[l])).csdMatrix());
      return csdCache.get(k);
    }
  };
  EEG.splineCache = splineCache;

  /* ---------- the pipeline ----------
     Stages, in order: assemble -> process (re-reference and filter) ->
     ica (remove components) -> epoch.  run(stage) recomputes from that
     stage down and marks every tab for redrawing. */
  const STAGES = ['assemble', 'process', 'ica', 'epoch'];
  function run(stage) {
    if (!S.ds) return;
    const k = STAGES.indexOf(stage);
    if (k <= 0) S.rec = EEG.assemble(S.ds, { enabled: S.enabled });
    if (k <= 1) {
      const f = EEG.dsp.rereference(S.rec, S.proc.reref, splineCache);
      const ch = EEG.dsp.chain(S.proc, S.ds.fs);
      if (!ch.empty) f.rows.forEach(r => ch.apply(r));
      f.chain = ch;
      S.filt = f;
      const I = S.ica;
      if (I.model && (I.mode !== S.proc.reref || I.labels.join() !== f.labels.join())) I.stale = true;
    }
    if (k <= 2) {
      const I = S.ica;
      S.clean = (I.model && !I.stale && I.rejected.size) ? EEG.ica.clean(I.model, S.filt.rows, Array.from(I.rejected)) : S.filt.rows;
    }
    if (k <= 3) {
      const E = S.epoch, fs = S.ds.fs;
      const ep = EEG.dsp.epoch(S.clean, fs, S.ds.events, E.t0, E.t1, E.baseline);
      ep.list.forEach(e => {
        let m = 0;
        for (let i = 0; i < e.data.length; i++) { const v = Math.abs(e.data[i]); if (v > m) m = v; }
        e.maxAbs = m;
        e.rejected = !!(E.reject && S.filt.unit === 'µV' && m > E.reject);
      });
      S.ep = ep;
      S.truth = null;
    }
    S.version++;
    Object.keys(TABS).forEach(t => { dirty[t] = true; });
    status();
    render();
  }
  EEG.app = { run, render: () => render(), markAll: () => { Object.keys(TABS).forEach(t => { dirty[t] = true; }); render(); } };

  // Do something heavy after the busy indicator has painted.
  EEG.app.later = function (fn) {
    ui.busy(true);
    requestAnimationFrame(() => setTimeout(() => { try { fn(); } catch (e) { console.error(e); } ui.busy(false); }, 15));
  };

  /* The true ERP of every condition, through the same chain as the data
     (re-reference and offline filters, but no ICA) and, separately, with
     no filtering at all. */
  EEG.app.truth = function () {
    if (S.truth) return S.truth;
    const ds = S.ds;
    const erpIds = ds.groups.filter(g => g.kind === 'source' && (g.type === 'erp')).map(g => g.id).filter(id => S.enabled.has(id));
    const out = { filt: null, raw: null, ids: erpIds };
    if (!erpIds.length || !ds.events.length) { S.truth = out; return out; }
    const E = S.epoch, fs = ds.fs;
    const avgByCond = rows => {
      const ep = EEG.dsp.epoch(rows, fs, ds.events, E.t0, E.t1, E.baseline);
      return ds.conditions.map((c, ci) => {
        const sel = ep.list.filter(e => e.ev.ci === ci);
        const acc = new Float64Array(ep.nCh * ep.nT);
        sel.forEach(e => { for (let i = 0; i < acc.length; i++) acc[i] += e.data[i]; });
        if (sel.length) for (let i = 0; i < acc.length; i++) acc[i] /= sel.length;
        return { n: sel.length, data: acc, nT: ep.nT, nCh: ep.nCh, times: ep.times };
      });
    };
    const en = new Set(erpIds);
    const r1 = EEG.assemble(ds, { enabled: en, noise: false, quantize: false });
    const f1 = EEG.dsp.rereference(r1, S.proc.reref, splineCache);
    const ch = EEG.dsp.chain(S.proc, fs);
    if (!ch.empty) f1.rows.forEach(r => ch.apply(r));
    out.filt = avgByCond(f1.rows);
    const r2 = EEG.assemble(ds, { enabled: en, noise: false, quantize: false, filters: false });
    const f2 = EEG.dsp.rereference(r2, S.proc.reref, splineCache);
    out.raw = avgByCond(f2.rows);
    out.labels = f1.labels;
    S.truth = out;
    return out;
  };

  /* ---------- status line ---------- */
  function status() {
    const el = $('status');
    const busy = $('busy');
    if (!S.cfg) return;
    const R = S.cfg.recording, ds = S.ds, P = S.proc;
    const chips = [
      `<b>${R.cap}</b> channels`, `online ref <b>${R.reference}</b>`, `<b>${R.fs}</b> Hz`,
      `<b>${Math.round(ds.dur)}</b> s`, `<b>${ds.events.length}</b> trials`,
      `re-ref <b>${P.reref}</b>`,
      `filters <b>${[P.hp ? 'HP ' + EEG.fmt(P.hp, P.hp < 1 ? 2 : 1) : null, P.lp ? 'LP ' + P.lp : null, P.notch ? 'notch ' + P.notch : null].filter(Boolean).join(', ') || 'none'}</b>`,
      `ICA <b>${S.ica.model && !S.ica.stale ? S.ica.rejected.size + ' removed' : 'not run'}</b>`
    ];
    el.innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join('');
    el.appendChild(busy);
  }
  EEG.app.status = status;

  /* ---------- tabs ---------- */
  const tabNames = ['chain', 'experiment', 'sources', 'recording', 'spectra', 'processing', 'averaging', 'localization', 'guide'];
  function showTab(name, focus) {
    if (!tabNames.includes(name)) name = 'chain';
    S.tab = name;
    tabNames.forEach(t => {
      const b = $('t-' + t), p = $('tab-' + t);
      b.setAttribute('aria-selected', String(t === name));
      b.tabIndex = t === name ? 0 : -1;
      p.hidden = t !== name;
    });
    if (focus) $('t-' + name).focus();
    try { localStorage.setItem('eegsim-tab', name); } catch (e) {}
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    render();
  }
  function render() {
    const t = TABS[S.tab];
    if (!t || !t.render) return;
    if (!dirty[S.tab] && t.rendered) return;
    dirty[S.tab] = false;
    t.rendered = true;
    try { t.render(); } catch (e) { console.error(e); }
  }
  EEG.app.showTab = showTab;
  EEG.app.dirty = name => { dirty[name] = true; };

  /* ---------- building a recording ---------- */
  function build(src, opts) {
    opts = opts || {};
    let cfg;
    const box = $('errbox');
    try { cfg = EEG.dsl.build(src); } catch (e) {
      box.className = 'errbox err';
      box.textContent = e.line ? `Line ${e.line}, column ${e.col}: ${e.message}` : e.message;
      highlightError(e.line);
      return false;
    }
    S.cfg = cfg; S.src = src;
    const an = cfg.analysis;
    S.proc = { reref: an.reference, hp: an.hp, lp: an.lp, notch: an.notch, notchWidth: 2, harmonics: false, order: an.order, phase: an.phase };
    S.epoch = { t0: an.epoch[0], t1: an.epoch[1], baseline: an.baseline, reject: an.reject };
    S.icaK = an.ica || 20;
    EEG.app.later(() => {
      const t0 = performance.now();
      S.ds = EEG.simulate(cfg);
      S.enabled = new Set(S.ds.groups.filter(g => g.on).map(g => g.id));
      S.ica = { model: null, rejected: new Set(), stale: false, labels: null, mode: null, changed: false };
      S.cursorT = Math.min(S.cursorT, S.ds.dur);
      Object.values(TABS).forEach(t => { if (t.onBuild) { try { t.onBuild(); } catch (e) { console.error(e); } } });
      run('assemble');
      const ms = Math.round(performance.now() - t0);
      box.className = 'errbox ok';
      box.textContent = `Recorded ${Math.round(S.ds.dur)} s on ${cfg.recording.cap} channels at ${cfg.recording.fs} Hz` +
        (S.ds.events.length ? `, ${S.ds.events.length} trials` : '') + ` in ${ms} ms.`;
      warnings(cfg);
      experimentSummary();
    });
    return true;
  }
  EEG.app.build = build;
  EEG.app.rebuildFromCfg = function () {
    // Rebuild after the controls changed the configuration; keep the text in sync only on request
    EEG.app.later(() => {
      const keep = S.enabled;
      S.ds = EEG.simulate(S.cfg);
      const ids = new Set(S.ds.groups.map(g => g.id));
      S.enabled = new Set(Array.from(keep).filter(id => ids.has(id)));
      S.ds.groups.forEach(g => { if (g.kind === 'source' && !keep.has(g.id) && !S.enabled.has(g.id)) S.enabled.add(g.id); });
      S.ica.stale = !!S.ica.model;
      Object.values(TABS).forEach(t => { if (t.onBuild) { try { t.onBuild(true); } catch (e) { console.error(e); } } });
      run('assemble');
      experimentSummary();
    });
  };

  /* ---------- Experiment tab ---------- */
  const ed = $('editor'), hi = $('edHi');
  function syncHighlight() { hi.innerHTML = EEG.dsl.highlight(ed.value); hi.scrollTop = ed.scrollTop; hi.scrollLeft = ed.scrollLeft; }
  function highlightError(line) {
    if (!line) return;
    const lines = ed.value.split('\n');
    let pos = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus(); ed.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  }
  function warnings(cfg) {
    $('warnlist').innerHTML = cfg.warnings.map(w => `<li>${w.line ? 'Line ' + w.line + ': ' : ''}${w.msg}</li>`).join('');
  }

  function experimentSummary() {
    if (!S.cfg || !S.ds) return;
    const cfg = S.cfg, R = cfg.recording, T = D.theme(), ds = S.ds;
    // cap
    const cv = $('cvExpCap');
    const { ctx, w, h } = D.fit(cv, w => Math.min(300, w * 0.75));
    const r = Math.min(w, h) / 2 * 0.82;
    const marks = {}; marks[R.reference] = T.series[0]; marks[R.ground] = T.series[2];
    D.capMap(ctx, w / 2, h / 2 + r * 0.04, r, ds.capLabels, { marks, extra: ['M1', 'M2'].filter(l => l !== R.reference) });
    ui.legend($('expCapLegend'), [{ color: T.series[0], label: 'online reference ' + R.reference, dot: true }, { color: T.series[2], label: 'ground ' + R.ground, dot: true }, { color: T.muted, label: 'mastoids, recorded for re-referencing', dot: true }]);
    // text
    const src = cfg.sources.map((s, i) => {
      const what = {
        dipole: () => `${s.signal} ${s.signal !== 'pink' ? s.freq + ' Hz ' : ''}dipole`,
        pair: () => `two coupled ${s.freq} Hz dipoles (coupling ${s.coupling})`,
        alpha: () => `${s.freq} Hz occipital alpha`,
        erp: () => `evoked response, ${s.peaks.map(p => Math.round(p.latency * 1000) + ' ms').join(', ')}`,
        spike: () => `interictal spikes, ${s.rate} per second`
      }[s.type]();
      const where = s.type === 'pair' ? s.dipoles.map(d => d.at || 'custom').join(' and ') : s.type === 'alpha' ? 'O1 and O2' : (s.at ? `${s.depth.toFixed(1)} cm under ${s.at}` : 'custom position');
      return `<li><span class="sw dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ui.sourceColor(i)};margin-right:6px"></span><strong>${s.label}</strong>: ${what}, ${where}</li>`;
    }).join('');
    const arts = EEG.ARTIFACTS.filter(k => cfg.artifacts[k].on).map(k => EEG.ARTIFACT_INFO[k].label.toLowerCase());
    $('expSummary').innerHTML = `<p>${R.cap} channels sampled at ${R.fs} Hz against ${R.reference}, hardware filters
      ${R.hp ? R.hp + ' Hz' : 'DC'} to ${R.lp} Hz, ${R.bits}-bit digitizer (step ${EEG.fmt(2 * R.range / Math.pow(2, R.bits), 3)} µV).</p>
      <ul>${src || '<li>No brain sources declared.</li>'}${R.background ? `<li>Background EEG, ${R.background} µV RMS.</li>` : ''}</ul>
      <p>${arts.length ? 'Artifacts on: ' + arts.join(', ') + '.' : 'No artifacts switched on.'} Analysis starts with the ${cfg.analysis.reference} reference.</p>`;
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
  EEG.app.experimentSummary = experimentSummary;
  TABS.experiment = { render: experimentSummary };

  function loadExample(i, buildNow) {
    S.exIndex = i;
    const ex = EEG.EXAMPLES[i];
    ed.value = ex.src;
    $('exDesc').textContent = ex.desc;
    $('exSelect').value = String(i);
    syncHighlight();
    if (buildNow) build(ed.value);
  }

  /* ---------- start ---------- */
  EEG.app.start = function () {
    // tabs
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
    // theme
    $('btnTheme').addEventListener('click', () => {
      const isDark = D.theme().dark;
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      try { localStorage.setItem('eegsim-theme', isDark ? 'light' : 'dark'); } catch (e) {}
      D.resetTheme();
      EEG.app.markAll();
    });
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { D.resetTheme(); EEG.app.markAll(); });
    window.addEventListener('resize', ui.debounce(() => EEG.app.markAll(), 200));
    // editor
    ui.fill($('exSelect'), EEG.EXAMPLES.map((e, i) => ({ value: String(i), label: e.name })));
    $('exSelect').addEventListener('change', () => loadExample(+$('exSelect').value, true));
    ed.addEventListener('input', syncHighlight);
    ed.addEventListener('scroll', () => { hi.scrollTop = ed.scrollTop; hi.scrollLeft = ed.scrollLeft; });
    ed.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); build(ed.value); }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText('  ', s, ed.selectionEnd, 'end'); syncHighlight(); }
    });
    $('btnBuild').addEventListener('click', () => build(ed.value));
    $('btnRevert').addEventListener('click', () => loadExample(S.exIndex, true));
    Object.values(TABS).forEach(t => { if (t.init) { try { t.init(); } catch (e) { console.error(e); } } });
    // Every canvas is a figure: name it after the panel it sits in
    document.querySelectorAll('canvas').forEach(cv => {
      if (cv.hasAttribute('aria-label')) return;
      const panel = cv.closest('.panel'), h = panel && panel.querySelector('h2');
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', h ? h.childNodes[0].textContent.trim() : 'EEG simulator figure');
    });
    let first = 'chain';
    try { first = location.hash.slice(1) || localStorage.getItem('eegsim-tab') || 'chain'; } catch (e) {}
    showTab(tabNames.includes(first) ? first : 'chain');
    loadExample(0, true);
  };
})(typeof window !== 'undefined' ? window : globalThis);
