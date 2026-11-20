/* fNIRS simulator: application state, the processing pipeline, tabs, and
   the Experiment tab.  Each other tab lives in its own file and registers
   itself in NIRS.tabs with init(), render() and, optionally, onBuild(). */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw;
  const $ = id => document.getElementById(id);

  /* ---------- shared state ---------- */
  const S = NIRS.S = {
    src: '', exIndex: 0, cfg: null, ds: null, enabled: new Set(),
    rec: null,          // raw intensities as assembled
    P: null,            // analysis settings (start from the program's analysis block)
    res: null,          // pipeline output
    glm: null, truth: null,
    selCh: 0, tab: 'system', version: 0
  };
  const TABS = NIRS.tabs = NIRS.tabs || {};
  const dirty = {};

  /* ---------- small UI helpers ---------- */
  const ui = NIRS.ui = {
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
      const key = b => Object.values(b.dataset)[0];
      const set = v => btns.forEach(b => b.setAttribute('aria-pressed', String(key(b) === String(v))));
      btns.forEach(b => b.addEventListener('click', () => { set(key(b)); if (cb) cb(key(b)); }));
      return { set, get: () => { const b = btns.find(x => x.getAttribute('aria-pressed') === 'true'); return b ? key(b) : null; } };
    },
    legend(el, items) {
      el.innerHTML = items.map(it => `<span><span class="sw${it.dot ? ' dot' : ''}${it.dash ? ' dash' : ''}" style="${it.dash ? 'color:' : 'background:'}${it.color}"></span>${it.label}</span>`).join('');
    },
    readouts(el, pairs) {
      el.innerHTML = pairs.map(([k, v, title]) => `<div class="ro"${title ? ` title="${title}"` : ''}><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    },
    busy(on) { $('busy').classList.toggle('on', !!on); },
    // Channel picker shared by every tab: changing it anywhere changes S.selCh.
    chSelect(sel, opts) {
      opts = opts || {};
      const fillIt = () => {
        if (!S.ds) return;
        const items = S.ds.chans.filter(c => !opts.longOnly || !c.short).map(c => ({
          value: String(c.index),
          label: `${c.label}  (${c.rho.toFixed(1)} cm${c.short ? ', short' : ''}${S.res && S.res.bad.has(c.index) ? ', rejected' : ''})`
        }));
        ui.fill(sel, items, String(S.selCh));
        if (opts.longOnly && S.ds.chans[S.selCh] && S.ds.chans[S.selCh].short) sel.value = items[0] ? items[0].value : '';
      };
      if (!sel._bound) {
        sel._bound = true;
        sel.addEventListener('change', () => { S.selCh = +sel.value; NIRS.app.markAll(); });
      }
      fillIt();
      return +sel.value;
    },
    fmtT(t) { const m = Math.floor(t / 60), s = t - 60 * m; return m ? `${m}:${s.toFixed(0).padStart(2, '0')}` : `${s.toFixed(1)} s`; },
    lambdaColor(li) { return D.theme().lam[li] || D.theme().muted; },
    condColor(i) { return D.theme().series[i % 8]; },
    fmtUM: v => (isFinite(v) ? (Math.abs(v) < 0.1 ? v.toFixed(3) : v.toFixed(2)) + ' µM' : '–')
  };

  /* ---------- the pipeline ----------
     Stages, in order: assemble -> quality -> od -> motion -> filter ->
     conc -> short -> stats.  run(stage) recomputes from that stage down
     and marks every tab for redrawing. */
  function run(stage) {
    if (!S.ds) return;
    if (stage === 'assemble') S.rec = NIRS.assemble(S.ds, { enabled: S.enabled });
    S.res = NIRS.pipeline.run(S.ds, S.rec, S.P, stage === 'assemble' ? null : S.res, stage === 'assemble' ? 'quality' : stage);
    S.glm = null;
    S.truth = null;     // recomputed on demand; it depends on the filters and the DPF
    S.version++;
    Object.keys(TABS).forEach(t => { dirty[t] = true; });
    status();
    render();
  }
  NIRS.app = { run, render: () => render(), markAll: () => { Object.keys(TABS).forEach(t => { dirty[t] = true; }); render(); } };
  NIRS.app.later = function (fn) {
    ui.busy(true);
    requestAnimationFrame(() => setTimeout(() => { try { fn(); } catch (e) { console.error(e); } ui.busy(false); }, 15));
  };
  NIRS.app.truth = function () {
    if (!S.truth && S.ds) S.truth = NIRS.pipeline.truth(S.ds, S.P);
    return S.truth;
  };
  NIRS.app.glm = function () {
    if (!S.glm && S.ds && S.res && S.ds.conditions.length && S.P.hrf !== 'off') S.glm = NIRS.pipeline.glm(S.ds, S.res, S.P);
    return S.glm;
  };
  // The channel most sensitive to the first region, a sensible thing to show first.
  NIRS.app.bestChannel = function () {
    const ds = S.ds;
    if (!ds) return 0;
    let best = -1, bv = -1;
    if (ds.regions.length) ds.chans.forEach(c => { if (!c.short && c.per[ds.nL - 1].La[0] > bv) { bv = c.per[ds.nL - 1].La[0]; best = c.index; } });
    if (best < 0) best = ds.chans.findIndex(c => !c.short);
    return Math.max(0, best);
  };

  /* ---------- status line ---------- */
  function status() {
    const el = $('status'), busy = $('busy');
    if (!S.cfg || !S.ds) return;
    const R = S.cfg.recording, ds = S.ds, P = S.P;
    const nShort = ds.chans.filter(c => c.short).length;
    const bad = S.res ? S.res.bad.size : 0;
    const chips = [
      `<b>${R.wavelengths.join(' / ')}</b> nm`, `<b>${R.fs}</b> Hz`,
      `<b>${ds.chans.length - nShort}</b> long + <b>${nShort}</b> short channels${bad ? `, <b>${bad}</b> rejected` : ''}`,
      `<b>${Math.round(ds.dur)}</b> s`, `<b>${ds.events.length}</b> ${ds.events.some(e => e.dur >= 3) ? 'blocks' : 'trials'}`,
      `${NIRS.HEADS[S.cfg.head.model].label.toLowerCase()}${S.cfg.head.hair !== 'none' ? ', ' + S.cfg.head.hair + ' hair' : ''}`,
      `multiplex <b>${R.multiplex}</b>`,
      `motion <b>${P.motion}</b>`, `filter <b>${[P.hp ? P.hp + ' Hz' : 'DC', P.lp ? P.lp + ' Hz' : '∞'].join(' to ')}</b>`,
      `short <b>${P.short}${P.short !== 'off' ? ' (' + (P.shortMode === 'glm' ? 'with task' : 'before') + ')' : ''}</b>`
    ];
    el.innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join('');
    el.appendChild(busy);
  }
  NIRS.app.status = status;

  /* ---------- tabs ---------- */
  const tabNames = ['system', 'experiment', 'light', 'spectra', 'mbll', 'head', 'confounds', 'recording', 'processing', 'averaging', 'compare', 'dot', 'guide'];
  function showTab(name, focus) {
    if (!tabNames.includes(name)) name = 'system';
    const prev = S.tab;
    S.tab = name;
    tabNames.forEach(t => {
      const b = $('t-' + t), p = $('tab-' + t);
      b.setAttribute('aria-selected', String(t === name));
      b.tabIndex = t === name ? 0 : -1;
      p.hidden = t !== name;
    });
    if (prev !== name && TABS[prev] && TABS[prev].hide) { try { TABS[prev].hide(); } catch (e) { console.error(e); } }
    if (focus) $('t-' + name).focus();
    try { localStorage.setItem('fnirssim-tab', name); } catch (e) {}
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (TABS[name] && TABS[name].show) { try { TABS[name].show(); } catch (e) { console.error(e); } }
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
  NIRS.app.showTab = showTab;
  NIRS.app.dirty = name => { dirty[name] = true; };
  NIRS.app.tabNames = tabNames;

  /* ---------- building a recording ---------- */
  function build(src, opts) {
    opts = opts || {};
    let cfg;
    const box = $('errbox');
    try { cfg = NIRS.dsl.build(src); } catch (e) {
      box.className = 'errbox err';
      box.textContent = e.line ? `Line ${e.line}, column ${e.col}: ${e.message}` : e.message;
      highlightError(e.line);
      if (opts.thenTab) showTab('experiment');
      return false;
    }
    S.cfg = cfg; S.src = src;
    NIRS.app.later(() => {
      const t0 = performance.now();
      S.ds = NIRS.simulate(cfg);
      S.enabled = new Set(S.ds.groups.filter(g => g.on).map(g => g.id));
      S.P = NIRS.pipeline.defaults(cfg);
      S.selCh = NIRS.app.bestChannel();
      Object.values(TABS).forEach(t => { if (t.onBuild) { try { t.onBuild(); } catch (e) { console.error(e); } } });
      run('assemble');
      const ms = Math.round(performance.now() - t0);
      box.className = 'errbox ok';
      box.textContent = `Recorded ${Math.round(S.ds.dur)} s on ${S.ds.chans.length} channels at ${cfg.recording.fs} Hz and ${cfg.recording.wavelengths.length} wavelength${cfg.recording.wavelengths.length > 1 ? 's' : ''}` +
        (S.ds.events.length ? `, ${S.ds.events.length} ${S.ds.events.some(e => e.dur >= 3) ? 'blocks' : 'trials'}` : '') + ` in ${ms} ms.`;
      warnings(cfg);
      experimentSummary();
      if (opts.thenTab) showTab(opts.thenTab);
    });
    return true;
  }
  NIRS.app.build = build;
  // Rebuild from a modified configuration and, optionally, rewrite the program to match.
  NIRS.app.rebuildFromCfg = function (writeBack, note) {
    if (writeBack) {
      const title = (S.src.match(/^#\s*(.*)$/m) || [])[1];
      const txt = NIRS.dsl.serialize(S.cfg, title || null);
      ed.value = txt; syncHighlight();
      return build(txt);
    }
    return false;
  };

  /* ---------- Experiment tab ---------- */
  const ed = $('editor'), hi = $('edHi');
  function syncHighlight() { hi.innerHTML = NIRS.dsl.highlight(ed.value); hi.scrollTop = ed.scrollTop; hi.scrollLeft = ed.scrollLeft; }
  function highlightError(line) {
    if (!line) return;
    const lines = ed.value.split('\n');
    let pos = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    ed.focus(); ed.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
  }
  function warnings(cfg) {
    $('warnlist').innerHTML = cfg.warnings.map(w => `<li>${w.line ? 'Line ' + w.line + ': ' : ''}${w.msg}</li>`).join('');
  }
  NIRS.app.regionMarks = function () {
    const T = D.theme(), ds = S.ds;
    if (!ds) return [];
    return ds.regions.map((rg, i) => ({ x: rg.x, y: rg.y, r: rg.r, color: rg.kind === 'activation' ? T.hbo : T.series[6], label: rg.label }));
  };

  function experimentSummary() {
    if (!S.cfg || !S.ds) return;
    const cfg = S.cfg, R = cfg.recording, T = D.theme(), ds = S.ds;
    const g1 = D.fit($('cvExpHead'), w => Math.min(260, w));
    const r = Math.min(g1.w, g1.h) / 2 * 0.8;
    D.headTop(g1.ctx, g1.w / 2, g1.h / 2 + r * 0.05, r, cfg, ds.geo, { regions: NIRS.app.regionMarks() });
    const g2 = D.fit($('cvExpProbe'), w => Math.min(260, w));
    D.probeMap(g2.ctx, ds, { x: 4, y: 4, w: g2.w - 8, h: g2.h - 8 }, { regions: NIRS.app.regionMarks() });
    ui.legend($('expLegend'), [{ color: T.src, label: 'source', dot: true }, { color: T.det, label: 'detector (small: short-separation)', dot: true }, { color: T.hbo, label: 'cortical region', dash: true }]);
    const nShort = ds.chans.filter(c => c.short).length;
    const head = NIRS.HEADS[cfg.head.model];
    const regs = cfg.activations.map(a => `<li><strong>${a.label}</strong>: ${Math.round(a.flow * 100)}% blood-flow rise, ${(a.radius * 10).toFixed(0)} mm radius,
      ${(a.depth * 10).toFixed(0)} mm deep, at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}) cm${a.conditions.length ? ', responds to ' + a.conditions.map(c => c.name + (c.gain !== 1 ? ' &times;' + c.gain : '')).join(', ') : ''}${a.dip ? ', with an initial dip' : ''}</li>`).join('') +
      cfg.pairs.map(p => `<li><strong>${p.label}</strong>: two regions sharing ${Math.round(p.coupling * 100)}% of their spontaneous ${p.band[0]}-${p.band[1]} Hz fluctuations</li>`).join('');
    const ph = cfg.physiology, physOn = ['cardiac', 'respiration', 'mayer', 'drift', 'taskbp'].filter(k => ph[k].on).map(k => NIRS.SYSTEMIC[k].label.toLowerCase());
    const arts = ['spikes', 'shifts', 'poor', 'ambient'].filter(k => cfg.artifacts[k].on).map(k => ds.groups.find(g => g.id === k).label.toLowerCase());
    $('expSummary').innerHTML = `<p>${R.wavelengths.join(' and ')} nm ${R.source === 'led' ? 'LEDs' : 'lasers'} at ${R.power} mW, ${NIRS.DETECTORS[R.detector].label.toLowerCase()}s,
      sampled at ${R.fs} Hz with ${R.multiplex === 'none' ? 'no' : R.multiplex} multiplexing. ${ds.geo.sources.length} sources and ${ds.geo.detectors.length} detectors over
      ${cfg.probe.over}: ${ds.chans.length - nShort} long channels and ${nShort} short ones. ${head.label}, brain ${(ds.brainTop * 10).toFixed(1)} mm below the scalp${cfg.head.hair !== 'none' ? ', ' + NIRS.HAIR[cfg.head.hair].label.toLowerCase() : ''}.</p>
      <ul>${regs || '<li>No cortical activity declared.</li>'}</ul>
      <p>${physOn.length ? 'Physiology: ' + physOn.join(', ') + '.' : 'No systemic physiology.'} ${arts.length ? 'Artifacts: ' + arts.join(', ') + '.' : 'No artifacts.'}</p>`;
    // timeline
    const cvT = $('cvTimeline');
    const g = D.fit(cvT, 92);
    const X0 = 8, X1 = g.w - 8, dur = ds.dur, sx = t => X0 + t / dur * (X1 - X0);
    ds.blocks.forEach(b => {
      if (b.kind !== 'task') return;
      g.ctx.fillStyle = D.alpha(ui.condColor(b.ci), 0.25);
      g.ctx.fillRect(sx(b.t0), 12, Math.max(1, sx(b.t1) - sx(b.t0)), 40);
    });
    g.ctx.strokeStyle = T.grid; g.ctx.strokeRect(X0 + 0.5, 12.5, X1 - X0, 40);
    ds.events.forEach(ev => { if (ev.dur >= 3) return; g.ctx.strokeStyle = ui.condColor(ev.ci); g.ctx.lineWidth = 1.5; const x = Math.round(sx(ev.t)) + 0.5; g.ctx.beginPath(); g.ctx.moveTo(x, 18); g.ctx.lineTo(x, 48); g.ctx.stroke(); });
    g.ctx.fillStyle = T.muted; g.ctx.font = D.font(10); g.ctx.textBaseline = 'top';
    D.ticks(0, dur, 6).forEach(t => { g.ctx.textAlign = 'center'; g.ctx.fillText(Math.round(t) + ' s', sx(t), 60); });
    ui.legend($('tlLegend'), ds.conditions.map((c, i) => ({ color: ui.condColor(i), label: `${c} (${ds.events.filter(e => e.ci === i).length})` })));
  }
  NIRS.app.experimentSummary = experimentSummary;
  TABS.experiment = { render: experimentSummary };

  function loadExample(i, buildNow, thenTab) {
    S.exIndex = i;
    const ex = NIRS.EXAMPLES[i];
    ed.value = ex.src;
    $('exDesc').textContent = ex.desc;
    $('exSelect').value = String(i);
    syncHighlight();
    if (buildNow) build(ed.value, { thenTab });
  }
  NIRS.app.loadExample = loadExample;
  // Change one line of the program (or add it) and rebuild: used by the "use this in the recording" buttons.
  NIRS.app.setRecordingOption = function (kw, text) {
    let src = ed.value;
    const re = new RegExp('(recording\\s*\\{[^}]*?)\\b' + kw + '\\b[^\\n}]*', 'm');
    if (re.test(src)) src = src.replace(re, (m, pre) => pre + text);
    else if (/recording\s*\{/.test(src)) src = src.replace(/recording\s*\{/, m => m + '\n  ' + text);
    else src = `recording { ${text} }\n` + src;
    ed.value = src; syncHighlight();
    return build(src);
  };

  /* ---------- start ---------- */
  NIRS.app.start = function () {
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
      try { localStorage.setItem('fnirssim-theme', isDark ? 'light' : 'dark'); } catch (e) {}
      D.resetTheme();
      NIRS.app.markAll();
    });
    if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { D.resetTheme(); NIRS.app.markAll(); });
    window.addEventListener('resize', ui.debounce(() => NIRS.app.markAll(), 200));
    ui.fill($('exSelect'), NIRS.EXAMPLES.map((e, i) => ({ value: String(i), label: e.name })));
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
    document.querySelectorAll('canvas').forEach(cv => {
      if (cv.hasAttribute('aria-label')) return;
      const panel = cv.closest('.panel'), h = panel && panel.querySelector('h2');
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', h ? h.childNodes[0].textContent.trim() : 'fNIRS simulator figure');
    });
    let first = 'system';
    try { first = location.hash.slice(1) || localStorage.getItem('fnirssim-tab') || 'system'; } catch (e) {}
    showTab(tabNames.includes(first) ? first : 'system');
    loadExample(0, true);
  };
})(typeof window !== 'undefined' ? window : globalThis);
