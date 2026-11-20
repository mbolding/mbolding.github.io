/* fNIRS simulator: a small language for describing a recording.

   A program is a handful of blocks:

     recording   { wavelengths 760 850 nm  rate 10 Hz  multiplex time ... }
     probe over C3 { source S1 at -3 1.5 cm  detector D1 at 0 1.5 cm  short S1 8 mm ... }
     head adult  { hair dense  skull 7 mm ... }
     activation <name> { at 0 0 cm  depth 15 mm  radius 8 mm  flow 50% ... }
     pair <name> { region A { at -3 0 cm }  region B { at 3 0 cm }  coupling 0.7 }
     timeline    { rest 20 s  blocks 10 on 20 s off 20 s { condition tap } ... }
     physiology  { cardiac 70 bpm 0.6 uM  mayer 0.1 Hz 0.5 uM  taskbp 1.5 uM ... }
     artifacts   { spikes 2 /min 40%  shifts 3  poor D3  ambient 2 nW ... }
     analysis    { motion tddr  bandpass 0.01 0.2 Hz  dpf age 30  short nearest glm  hrf canonical ... }

   Statements are a keyword followed by values.  A value is a number with
   an optional unit, a percentage, a name or a quoted string.  The unit
   decides what a number means, so `cardiac 70 bpm 0.6 uM` and
   `cardiac 0.6 uM 70 bpm` say the same thing.  Newlines are only
   whitespace: a statement ends where the next keyword of the same block
   begins, which is what lets a whole block sit on one line. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;

  class DSLError extends Error {
    constructor(msg, line, col) { super(msg); this.line = line; this.col = col; }
  }

  /* ---------- units ---------- */
  const UNITS = {
    Hz: ['freq', 1], kHz: ['freq', 1e3], MHz: ['freq', 1e6], bpm: ['freq', 1 / 60], '/min': ['freq', 1 / 60],
    s: ['time', 1], ms: ['time', 1e-3], min: ['time', 60],
    nm: ['wl', 1],
    cm: ['length', 1], mm: ['length', 0.1],
    uM: ['conc', 1], 'µM': ['conc', 1], mM: ['conc', 1e3], nM: ['conc', 1e-3],
    mW: ['power', 1e6], uW: ['power', 1e3], 'µW': ['power', 1e3], nW: ['power', 1], pW: ['power', 1e-3],
    deg: ['angle', 1]
  };
  const DIM_NAMES = {
    freq: 'a frequency (Hz, bpm or /min)', time: 'a time (s, ms or min)', wl: 'a wavelength (nm)', length: 'a length (cm or mm)',
    conc: 'a concentration (uM)', power: 'a power (mW, uW or nW)', angle: 'an angle (deg)'
  };

  /* ---------- lexer ---------- */
  function lex(src) {
    const toks = [];
    let i = 0, line = 1, col = 1;
    const adv = n => { for (let k = 0; k < n; k++) { if (src[i] === '\n') { line++; col = 1; } else col++; i++; } };
    while (i < src.length) {
      const c = src[i];
      if (c === '\n' || c === ' ' || c === '\t' || c === '\r' || c === ';') { adv(1); continue; }
      if (c === '#') { while (i < src.length && src[i] !== '\n') adv(1); continue; }
      const rest = src.slice(i, i + 64);
      let m;
      if (c === '"') {
        const j = src.indexOf('"', i + 1);
        if (j < 0) throw new DSLError('unterminated string', line, col);
        toks.push({ t: 'str', v: src.slice(i + 1, j), line, col });
        adv(j - i + 1); continue;
      }
      if ((m = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(rest)) && (c !== '+' && c !== '-' || /[\d.]/.test(src[i + 1] || ''))) {
        toks.push({ t: 'num', v: parseFloat(m[0]), raw: m[0], line, col });
        adv(m[0].length); continue;
      }
      if ((m = /^\/min\b/.exec(rest)) || (m = /^[A-Za-zµ_][A-Za-z0-9_µ]*/.exec(rest))) {
        toks.push({ t: 'id', v: m[0], line, col });
        adv(m[0].length); continue;
      }
      if ('{}%:,'.includes(c)) { toks.push({ t: 'sym', v: c, line, col }); adv(1); continue; }
      throw new DSLError(`unexpected character '${c}'`, line, col);
    }
    toks.push({ t: 'eof', line, col });
    return toks;
  }

  /* ---------- grammar ---------- */
  const REGION = ['at', 'under', 'depth', 'radius'];
  const SCHEMA = {
    top: ['recording', 'probe', 'head', 'activation', 'pair', 'timeline', 'physiology', 'artifacts', 'analysis'],
    recording: ['system', 'wavelengths', 'rate', 'multiplex', 'source', 'power', 'detector', 'seed'],
    probe: ['layout', 'source', 'detector', 'short', 'channels', 'channel', 'rotate'],
    head: ['hair', 'scalp', 'skull', 'csf', 'gray'],
    activation: REGION.concat(['flow', 'coupling', 'dip', 'condition', 'label']),
    pair: ['region', 'coupling', 'fluctuation', 'band', 'label'],
    'pair:region': REGION.slice(),
    timeline: ['rest', 'block', 'blocks', 'events'],
    'timeline:trials': ['condition', 'order'],
    physiology: ['cardiac', 'respiration', 'mayer', 'drift', 'taskbp', 'heterogeneity', 'brain'],
    artifacts: ['spikes', 'shifts', 'poor', 'ambient'],
    analysis: ['quality', 'motion', 'bandpass', 'highpass', 'lowpass', 'dpf', 'short', 'epoch', 'baseline', 'hrf', 'derivative', 'noise']
  };
  NIRS.DSL_SCHEMA = SCHEMA;

  function parse(src) {
    const toks = lex(src);
    let p = 0;
    const peek = () => toks[p];
    const err = (msg, tk) => { tk = tk || peek(); throw new DSLError(msg, tk.line, tk.col); };

    function value() {
      const tk = toks[p];
      if (tk.t === 'num') {
        p++;
        const v = { kind: 'num', v: tk.v, unit: null, line: tk.line, col: tk.col };
        const nx = toks[p];
        if (nx.t === 'sym' && nx.v === '%') { p++; v.kind = 'pct'; v.v = tk.v / 100; return v; }
        if (nx.t === 'id' && UNITS[nx.v]) { p++; v.unit = nx.v; }
        return v;
      }
      if (tk.t === 'id') {
        p++;
        if (UNITS[tk.v]) err(`a unit ('${tk.v}') needs a number in front of it`, tk);
        return { kind: 'id', v: tk.v, line: tk.line, col: tk.col };
      }
      if (tk.t === 'str') { p++; return { kind: 'str', v: tk.v, line: tk.line, col: tk.col }; }
      if (tk.t === 'sym' && tk.v === ',') { p++; return null; }
      err(`unexpected '${tk.v}'`);
    }

    // A unitless run of numbers takes the unit of the number that ends it:
    // `epoch -5 25 s` means two times in seconds.
    function propagateUnits(vals) {
      for (let i = vals.length - 1; i > 0; i--) {
        const a = vals[i - 1], b = vals[i];
        if (a.kind === 'num' && !a.unit && b.kind === 'num' && b.unit) a.unit = b.unit;
      }
      return vals;
    }

    function block(ctx) {
      const open = peek();
      if (!(open.t === 'sym' && open.v === '{')) err(`expected '{'`);
      p++;
      const stmts = [];
      while (true) {
        const tk = peek();
        if (tk.t === 'sym' && tk.v === '}') { p++; break; }
        if (tk.t === 'eof') err(`missing '}' to close the block opened on line ${open.line}`, open);
        stmts.push(statement(ctx));
      }
      return stmts;
    }

    function statement(ctx) {
      const kw = peek();
      const allowed = SCHEMA[ctx];
      if (kw.t !== 'id') err(kw.t === 'num' ? `a number cannot start a statement here; expected one of: ${allowed.join(', ')}`
        : `unexpected '${kw.v}'`);
      if (!allowed.includes(kw.v)) {
        const where = ctx === 'top' ? 'at the top level' : `inside ${ctx.replace(':', ' ')}`;
        err(`unknown statement '${kw.v}' ${where}; expected one of: ${allowed.join(', ')}`);
      }
      p++;
      const vals = [];
      while (true) {
        const tk = peek();
        if (tk.t === 'eof') break;
        if (tk.t === 'sym' && (tk.v === '}' || tk.v === '{')) break;
        if (tk.t === 'id' && allowed.includes(tk.v)) break;
        const v = value();
        if (v) vals.push(v);
      }
      const st = { kw: kw.v, vals: propagateUnits(vals), line: kw.line, col: kw.col, block: null };
      if (peek().t === 'sym' && peek().v === '{') {
        let sub = null;
        if (ctx === 'top') sub = kw.v;
        else if (ctx === 'timeline' && (kw.v === 'blocks' || kw.v === 'events')) sub = 'timeline:trials';
        else if (ctx === 'pair' && kw.v === 'region') sub = 'pair:region';
        if (!sub) err(`'${kw.v}' does not take a block`);
        st.block = block(sub);
      } else if (ctx === 'top') {
        err(`'${kw.v}' needs a block in braces: ${kw.v} { ... }`, kw);
      }
      return st;
    }

    const prog = [];
    while (peek().t !== 'eof') prog.push(statement('top'));
    return prog;
  }

  /* ---------- compiler ----------
     Turns the syntax tree into a plain configuration object, filling in
     defaults and checking every number against a sensible range.  The
     simulator never sees the text, only this object, and the serializer
     can write it back out. */
  const PHYSIO_DEFAULTS = {
    cardiac: { on: true, rate: 72 / 60, amp: 1.0 },
    respiration: { on: true, rate: 15 / 60, amp: 0.35 },
    mayer: { on: true, rate: 0.1, amp: 0.6 },
    drift: { on: true, amp: 0.8 },
    taskbp: { on: false, amp: 1.5, delay: 0 },
    heterogeneity: 0.15, brain: 1
  };
  const DEFAULTS = {
    recording: { system: 'cw', wavelengths: [760, 850], fs: 10, multiplex: 'time', source: 'laser', power: 10, detector: 'apd', seed: 1 },
    probe: { over: 'C3', rotate: 0, layout: 'motor', custom: false, sources: [], detectors: [], shorts: null, maxSep: 3.5, explicit: null },
    head: { model: 'adult', hair: 'none', thick: {} },
    artifacts: {
      spikes: { on: false, rate: 1.5 / 60, amp: 0.5 },
      shifts: { on: false, count: 3, amp: 0.3 },
      poor: { on: false, optode: 'D3', couple: 0.02 },
      ambient: { on: false, level: 2, flicker: 120, change: null }
    },
    analysis: {
      sci: 0.75, cv: 0.15, motion: 'none', hp: 0.01, lp: 0.2, dpf: { mode: 'age', age: null, values: null },
      short: 'off', shortMode: 'glm', epoch: [-5, 25], baseline: [-5, 0], hrf: 'canonical', deriv: false, noise: 'ar'
    }
  };
  NIRS.DSL_DEFAULTS = DEFAULTS;
  NIRS.PHYSIO_DEFAULTS = PHYSIO_DEFAULTS;
  const SYSTEMS = ['cw', 'fd', 'td'], MUX = ['time', 'frequency', 'none'], SOURCES = ['laser', 'led'],
    DETECTORS = ['photodiode', 'apd', 'sipm'], HEADS = ['adult', 'thick', 'infant'], HAIRS = ['none', 'light', 'dense', 'dark'],
    MOTION = ['none', 'tddr', 'spline'], SHORT = ['off', 'nearest', 'mean'], SHORT_MODE = ['glm', 'before'], HRF = ['canonical', 'gamma', 'off'],
    NOISE = ['ols', 'ar'];
  NIRS.DSL_ENUMS = { SYSTEMS, MUX, SOURCES, DETECTORS, HEADS, HAIRS, MOTION, SHORT, SHORT_MODE, HRF, NOISE };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function compile(prog) {
    const cfg = {
      recording: clone(DEFAULTS.recording), probe: clone(DEFAULTS.probe), head: clone(DEFAULTS.head),
      activations: [], pairs: [], timeline: null, physiology: null, artifacts: clone(DEFAULTS.artifacts),
      analysis: clone(DEFAULTS.analysis), warnings: [], declared: { artifacts: [], physiology: [] }
    };
    const fail = (msg, at) => { throw new DSLError(msg, at.line, at.col); };
    const warn = (msg, at) => cfg.warnings.push({ msg, line: at.line });
    const seen = {};

    function numIn(v, dim, st) {
      if (v.kind === 'pct') fail(`a percentage is not ${DIM_NAMES[dim] || 'allowed here'}`, v);
      if (v.kind !== 'num') return null;
      if (!v.unit) return v.v;
      const u = UNITS[v.unit];
      if (u[0] !== dim) fail(`'${v.v} ${v.unit}' is ${DIM_NAMES[u[0]]}, but ${st.kw} needs ${DIM_NAMES[dim]}`, v);
      return v.v * u[1];
    }
    function getNum(st, dim, opts) {
      opts = opts || {};
      const nums = st.vals.filter(v => v.kind === 'num' && (dim === null ? true : (!v.unit || UNITS[v.unit][0] === dim)));
      const v = nums[opts.index || 0];
      if (!v) {
        const wrong = dim && st.vals.find(x => x.kind === 'num' && x.unit && UNITS[x.unit][0] !== dim);
        if (wrong && opts.required) fail(`'${wrong.v} ${wrong.unit}' is ${DIM_NAMES[UNITS[wrong.unit][0]]}, but ${st.kw} needs ${DIM_NAMES[dim]}`, wrong);
        if (opts.required) fail(`${st.kw} needs ${dim ? DIM_NAMES[dim] : 'a number'}`, st);
        return opts.def;
      }
      const x = dim === null ? v.v : numIn(v, dim, st);
      if (opts.min !== undefined && x < opts.min || opts.max !== undefined && x > opts.max) {
        const sc = opts.scale || 1, unit = opts.unit || '';
        fail(`${st.kw} must be between ${+(opts.min / sc).toPrecision(4)} and ${+(opts.max / sc).toPrecision(4)}${unit ? ' ' + unit : ''}`, v);
      }
      return x;
    }
    function checkUnits(st, dims) {
      st.vals.forEach(v => {
        if (v.kind === 'num' && v.unit && !dims.includes(UNITS[v.unit][0]))
          fail(`'${v.v} ${v.unit}' is ${DIM_NAMES[UNITS[v.unit][0]]}, which ${st.kw} does not take`, v);
      });
    }
    function getId(st, opts) {
      opts = opts || {};
      const ids = st.vals.filter(v => v.kind === 'id' || (opts.str && v.kind === 'str'));
      const v = ids[opts.index || 0];
      if (!v) { if (opts.required) fail(`${st.kw} needs ${opts.oneOf ? 'one of: ' + opts.oneOf.join(', ') : 'a name'}`, st); return opts.def; }
      if (opts.oneOf) {
        const hit = opts.oneOf.find(o => o.toLowerCase() === v.v.toLowerCase());
        if (!hit) fail(`${st.kw} must be one of: ${opts.oneOf.join(', ')}`, v);
        return hit;
      }
      return v.v;
    }
    function frac(st, opts) {
      opts = opts || {};
      const v = st.vals.find(x => x.kind === 'pct' || (x.kind === 'num' && !x.unit));
      if (!v) { if (opts.required) fail(`${st.kw} needs a number or a percentage`, st); return opts.def; }
      const lo = opts.min !== undefined ? opts.min : 0, hi = opts.max !== undefined ? opts.max : 1;
      if (v.v < lo || v.v > hi) fail(`${st.kw} must be between ${lo} and ${hi} (or ${lo * 100}% to ${hi * 100}%)`, v);
      return v.v;
    }
    // the number after a named word: `on 20 s`, `isi 12 s`, `sci 0.75`
    function named(st, name, dim, opts) {
      opts = opts || {};
      const v = st.vals, i = v.findIndex(x => x.kind === 'id' && x.v.toLowerCase() === name);
      if (i < 0) return opts.def;
      const nx = v[i + 1];
      if (!nx || (nx.kind !== 'num' && nx.kind !== 'pct')) fail(`${name} needs a ${dim ? DIM_NAMES[dim].replace(/^an? /, '') : 'number'} after it`, v[i]);
      const x = nx.kind === 'pct' ? nx.v : (dim ? numIn(nx, dim, st) : nx.v);
      if (opts.min !== undefined && x < opts.min || opts.max !== undefined && x > opts.max)
        fail(`${name} must be between ${+(opts.min / (opts.scale || 1)).toPrecision(4)} and ${+(opts.max / (opts.scale || 1)).toPrecision(4)}${opts.unit ? ' ' + opts.unit : ''}`, nx);
      return x;
    }
    const isOff = st => st.vals.some(v => v.kind === 'id' && /^(off|none|no)$/i.test(v.v));
    const once = (ctx, st) => {
      const k = ctx + '.' + st.kw;
      if (seen[k]) warn(`${st.kw} appears twice in ${ctx}; the last one wins`, st);
      seen[k] = true;
    };
    const posPair = (st, what) => {
      const ns = st.vals.filter(v => v.kind === 'num');
      if (ns.length !== 2) fail(`${what || st.kw} needs two coordinates: x y cm (x to the right, y toward the nose)`, st);
      return ns.map(v => numIn(v, 'length', st));
    };

    function recording(stmts) {
      const r = cfg.recording;
      stmts.forEach(st => {
        once('recording', st);
        switch (st.kw) {
          case 'system': r.system = getId(st, { required: true, oneOf: SYSTEMS }); break;
          case 'wavelengths': {
            const ns = st.vals.filter(v => v.kind === 'num').map(v => numIn(v, 'wl', st));
            if (ns.length < 1 || ns.length > 3) fail('wavelengths takes one, two or three wavelengths in nm: wavelengths 760 850 nm', st);
            ns.forEach((x, i) => { if (x < 600 || x > 1000) fail('wavelengths must lie between 600 and 1000 nm', st.vals.filter(v => v.kind === 'num')[i]); });
            if (new Set(ns.map(Math.round)).size !== ns.length) fail('the wavelengths must differ', st);
            r.wavelengths = ns.slice().sort((a, b) => a - b);
            break;
          }
          case 'rate': r.fs = getNum(st, 'freq', { required: true, min: 0.5, max: 50, unit: 'Hz' }); break;
          case 'multiplex': r.multiplex = getId(st, { required: true, oneOf: MUX }); break;
          case 'source': r.source = getId(st, { required: true, oneOf: SOURCES }); break;
          case 'power': r.power = getNum(st, 'power', { required: true, min: 0.1e6, max: 100e6, scale: 1e6, unit: 'mW' }) / 1e6; break;
          case 'detector': r.detector = getId(st, { required: true, oneOf: DETECTORS }); break;
          case 'seed': r.seed = Math.round(getNum(st, null, { required: true })); break;
        }
      });
      if (r.wavelengths.length === 1) warn('a single wavelength cannot separate oxy- from deoxyhaemoglobin; the conversion will fail on purpose', { line: 0 });
    }

    function probe(st) {
      const P = cfg.probe;
      const ov = st.vals.findIndex(v => v.kind === 'id' && v.v.toLowerCase() === 'over');
      if (ov >= 0) {
        const nm = st.vals[ov + 1];
        if (!nm || nm.kind !== 'id') fail('probe over needs a 10-20 position, such as C3 or Fpz', st);
        const k = NIRS.resolve1020(nm.v);
        if (!k) fail(`'${nm.v}' is not a 10-20 position this simulator knows; try one of: ${Object.keys(NIRS.TEN20).join(', ')}`, nm);
        P.over = k;
      } else if (st.vals.length) fail("write the probe's position as: probe over C3 { ... }", st.vals[0]);
      const shorts = [];
      let shortOff = false;
      (st.block || []).forEach(s => {
        switch (s.kw) {
          case 'layout': P.layout = getId(s, { required: true, oneOf: NIRS.LAYOUT_NAMES }); break;
          case 'rotate': P.rotate = getNum(s, 'angle', { required: true, min: -180, max: 180, unit: 'deg' }); break;
          case 'channels': P.maxSep = getNum(s, 'length', { required: true, min: 1.5, max: 6, unit: 'cm' }); break;
          case 'source': case 'detector': {
            const nm = s.vals.find(v => v.kind === 'id' && !/^at$/i.test(v.v));
            if (!nm) fail(`${s.kw} needs a name and a position: ${s.kw} ${s.kw === 'source' ? 'S1' : 'D1'} at 0 0 cm`, s);
            const [x, y] = posPair(s);
            if (Math.hypot(x, y) > 8) fail('optodes must lie within 8 cm of the centre of the probe', s);
            const list = s.kw === 'source' ? P.sources : P.detectors;
            if (P.sources.concat(P.detectors).some(o => o.name === nm.v)) fail(`there is already an optode called ${nm.v}`, nm);
            list.push({ name: nm.v, x, y });
            P.custom = true; break;
          }
          case 'short': {
            if (isOff(s)) { shortOff = true; break; }
            const nm = s.vals.find(v => v.kind === 'id');
            if (!nm) fail('short needs the source it sits beside and a distance: short S1 8 mm', s);
            const d = getNum(s, 'length', { def: 0.8, min: 0.3, max: 1.5, unit: 'cm' });
            const ang = s.vals.find(v => v.kind === 'num' && v.unit === 'deg');
            shorts.push({ of: nm.v, dist: d, angle: ang ? ang.v : -45, line: s.line, col: s.col });
            break;
          }
          case 'channel': {
            const ids = s.vals.filter(v => v.kind === 'id');
            if (ids.length !== 2) fail('channel needs a source and a detector: channel S1 D1', s);
            (P.explicit = P.explicit || []).push([ids[0].v, ids[1].v]);
            break;
          }
        }
      });
      if (!P.custom) {
        const L = NIRS.LAYOUTS[P.layout]();
        P.sources = L.sources; P.detectors = L.detectors;
        P.shorts = shortOff ? [] : (shorts.length ? shorts : L.shorts);
      } else {
        if (!P.sources.length || !P.detectors.length) fail('a probe needs at least one source and one detector', st);
        P.shorts = shortOff ? [] : shorts;
      }
      P.shorts.forEach(sh => { if (!P.sources.some(s => s.name === sh.of)) fail(`short ${sh.of}: there is no source called ${sh.of}`, sh.line ? sh : st); });
      if (P.explicit) P.explicit.forEach(pr => {
        if (!P.sources.some(s => s.name === pr[0])) fail(`channel ${pr[0]} ${pr[1]}: there is no source called ${pr[0]}`, st);
        if (!P.detectors.some(d => d.name === pr[1])) fail(`channel ${pr[0]} ${pr[1]}: there is no detector called ${pr[1]}`, st);
      });
    }

    function head(st) {
      const h = cfg.head;
      const ty = st.vals.find(v => v.kind === 'id');
      if (ty) h.model = getId(st, { oneOf: HEADS });
      (st.block || []).forEach(s => {
        once('head', s);
        if (s.kw === 'hair') { h.hair = getId(s, { required: true, oneOf: HAIRS }); return; }
        const lim = { scalp: [0.1, 1.5], skull: [0.1, 2], csf: [0.05, 1], gray: [0.15, 1] }[s.kw];
        h.thick[s.kw] = getNum(s, 'length', { required: true, min: lim[0], max: lim[1], unit: 'cm' });
      });
    }

    // Position of a region: `at x y cm` or `under S1 D1` (the channel's midpoint)
    function regionGeom(stmts, defaults) {
      const g = Object.assign({ x: 0, y: 0, depth: null, radius: 0.8, under: null }, defaults || {});
      stmts.forEach(st => {
        switch (st.kw) {
          case 'at': { const [x, y] = posPair(st); g.x = x; g.y = y; g.under = null; break; }
          case 'under': {
            const ids = st.vals.filter(v => v.kind === 'id');
            if (ids.length !== 2) fail('under needs a source and a detector: under S1 D1', st);
            g.under = [ids[0].v, ids[1].v]; g.line = st.line; g.col = st.col; break;
          }
          case 'depth': g.depth = getNum(st, 'length', { required: true, min: 0.3, max: 4, unit: 'cm' }); break;
          case 'radius': g.radius = getNum(st, 'length', { required: true, min: 0.2, max: 3, unit: 'cm' }); break;
        }
      });
      return g;
    }

    function activation(st) {
      const nameV = st.vals.find(v => v.kind === 'id' || v.kind === 'str');
      const name = nameV ? nameV.v : 'region' + (cfg.activations.length + 1);
      if (cfg.activations.concat(cfg.pairs).some(a => a.name === name)) fail(`there is already a region called '${name}'`, st);
      const stmts = st.block || [];
      stmts.forEach(x => { if (x.kw !== 'condition') once('activation ' + name, x); });
      const a = Object.assign({ name, label: name }, regionGeom(stmts));
      const last = kw => { const l = stmts.filter(x => x.kw === kw); return l[l.length - 1]; };
      const fl = last('flow'); a.flow = fl ? frac(fl, { required: true, min: 0, max: 1.5 }) : 0.5;
      const cp = last('coupling'); a.n = cp ? getNum(cp, null, { required: true, min: 1.2, max: 6 }) : 2.5;
      const dp = last('dip'); a.dip = dp ? !isOff(dp) : false;
      const lb = last('label'); if (lb) a.label = getId(lb, { str: true }) || name;
      a.conditions = stmts.filter(x => x.kw === 'condition').map(c => {
        const nm = c.vals.find(v => v.kind === 'id' || v.kind === 'str');
        if (!nm) fail('condition needs a name and a gain: condition tap 1', c);
        const g = c.vals.find(v => v.kind === 'num' || v.kind === 'pct');
        return { name: nm.v, gain: g ? g.v : 1 };
      });
      cfg.activations.push(a);
    }

    function pair(st) {
      const nameV = st.vals.find(v => v.kind === 'id' || v.kind === 'str');
      const name = nameV ? nameV.v : 'pair' + (cfg.pairs.length + 1);
      if (cfg.activations.concat(cfg.pairs).some(a => a.name === name)) fail(`there is already a region called '${name}'`, st);
      const stmts = st.block || [];
      const regs = stmts.filter(x => x.kw === 'region');
      if (regs.length !== 2) fail('a pair needs exactly two regions: region A { at -3 0 cm } and region B { at 3 0 cm }', st);
      const p = { name, label: name };
      p.regions = regs.map((r, i) => {
        const nm = r.vals.find(v => v.kind === 'id' || v.kind === 'str');
        return Object.assign({ name: nm ? nm.v : 'AB'[i] }, regionGeom(r.block || [], { x: i ? 3 : -3 }));
      });
      const last = kw => { const l = stmts.filter(x => x.kw === kw); return l[l.length - 1]; };
      const cp = last('coupling'); p.coupling = cp ? frac(cp, { required: true }) : 0.7;
      const fl = last('fluctuation'); p.fluct = fl ? frac(fl, { required: true, max: 0.6 }) : 0.15;
      const bd = last('band');
      if (bd) {
        const f0 = getNum(bd, 'freq', { required: true, index: 0 }), f1 = getNum(bd, 'freq', { required: true, index: 1 });
        if (!(f0 > 0 && f1 > f0 && f1 <= 0.5)) fail('band needs a low and a high frequency below 0.5 Hz: band 0.01 0.1 Hz', bd);
        p.band = [f0, f1];
      } else p.band = [0.01, 0.1];
      const lb = last('label'); if (lb) p.label = getId(lb, { str: true }) || name;
      cfg.pairs.push(p);
    }

    function timeline(stmts) {
      const segs = [];
      stmts.forEach(st => {
        if (st.kw === 'rest') {
          segs.push({ kind: 'rest', dur: getNum(st, 'time', { required: true, min: 1, max: 1800, unit: 's' }) });
        } else if (st.kw === 'block') {
          const cond = getId(st, { str: true, def: 'task' });
          segs.push({ kind: 'block', cond, dur: getNum(st, 'time', { required: true, min: 1, max: 600, unit: 's' }) });
        } else {
          const v = st.vals, isBlocks = st.kw === 'blocks';
          const n = v[0] && v[0].kind === 'num' && !v[0].unit ? v[0].v : null;
          if (!n || n < 1 || n > 500 || n !== Math.round(n)) fail(`${st.kw} needs a whole number first, such as ${isBlocks ? 'blocks 10 on 20 s off 20 s' : 'events 30 isi 12 s'}`, st);
          const words = isBlocks ? ['on', 'off', 'jitter'] : ['isi', 'jitter', 'duration'];
          v.forEach(x => { if (x.kind === 'id' && !words.includes(x.v.toLowerCase())) fail(`${st.kw} does not understand '${x.v}'; use ${words.join(', ')}`, x); });
          const seg = { kind: st.kw, n };
          if (isBlocks) {
            const posT = v.filter((x, i) => i > 0 && x.kind === 'num' && !(v[i - 1].kind === 'id'));
            seg.on = named(st, 'on', 'time', { min: 1, max: 300, unit: 's', def: posT[0] ? numIn(posT[0], 'time', st) : 20 });
            seg.off = named(st, 'off', 'time', { min: 2, max: 300, unit: 's', def: posT[1] ? numIn(posT[1], 'time', st) : 20 });
            seg.jitter = named(st, 'jitter', 'time', { min: 0, max: 60, unit: 's', def: 0 });
          } else {
            seg.isi = named(st, 'isi', 'time', { min: 2, max: 120, unit: 's', def: 12 });
            seg.jitter = named(st, 'jitter', 'time', { min: 0, max: 60, unit: 's', def: 0 });
            seg.dur = named(st, 'duration', 'time', { min: 0.1, max: 20, unit: 's', def: 1 });
            if (seg.isi < 8) warn(`events ${seg.isi} s apart overlap: the haemodynamic response lasts 15 to 20 s, so averaging needs a GLM or long jitter`, st);
          }
          const conds = [];
          let order = 'random';
          (st.block || []).forEach(b => {
            if (b.kw === 'condition') {
              const nm = b.vals.find(x => x.kind === 'id' || x.kind === 'str');
              if (!nm) fail('condition needs a name and a share: condition left 50%', b);
              const w = b.vals.find(x => x.kind === 'pct' || x.kind === 'num');
              conds.push({ name: nm.v, p: w ? w.v : 1 });
            } else order = getId(b, { required: true, oneOf: ['random', 'alternate', 'sequence'] });
          });
          if (!conds.length) conds.push({ name: 'task', p: 1 });
          const tot = conds.reduce((a, c) => a + c.p, 0);
          if (tot <= 0) fail('condition shares must add up to more than zero', st);
          conds.forEach(c => { c.p /= tot; });
          seg.conditions = conds; seg.order = order;
          segs.push(seg);
        }
      });
      if (!segs.length) segs.push({ kind: 'rest', dur: 300 });
      cfg.timeline = { segments: segs };
    }

    function physiology(stmts) {
      const P = cfg.physiology = clone(PHYSIO_DEFAULTS);
      ['cardiac', 'respiration', 'mayer', 'drift', 'taskbp'].forEach(k => { P[k].on = false; });
      stmts.forEach(st => {
        once('physiology', st);
        const k = st.kw;
        if (k === 'heterogeneity') { P.heterogeneity = frac(st, { required: true }); return; }
        if (k === 'brain') { P.brain = frac(st, { required: true, max: 2 }); return; }
        cfg.declared.physiology.push(k);
        const A = P[k];
        A.on = !isOff(st);
        checkUnits(st, k === 'drift' ? ['conc'] : k === 'taskbp' ? ['conc', 'time'] : ['freq', 'conc']);
        st.vals.forEach(v => {
          if (v.kind !== 'num') return;
          if (!v.unit) fail(`give ${k} its numbers with units, such as ${k === 'cardiac' ? '70 bpm and 0.6 uM' : '0.5 uM'}`, v);
          const d = UNITS[v.unit][0], x = v.v * UNITS[v.unit][1];
          if (d === 'freq') {
            const lim = { cardiac: [0.5, 3.5, '30 and 210 bpm'], respiration: [0.05, 1, '3 and 60 per minute'], mayer: [0.04, 0.2, '0.04 and 0.2 Hz'] }[k];
            if (x < lim[0] || x > lim[1]) fail(`${k} rate must be between ${lim[2]}`, v);
            A.rate = x;
          } else if (d === 'conc') {
            if (x < 0 || x > 10) fail(`${k} amplitude must be between 0 and 10 uM`, v);
            A.amp = x;
          } else if (d === 'time') {
            if (x < -5 || x > 10) fail('taskbp delay must be between -5 and 10 s', v);
            A.delay = x;
          }
        });
      });
    }

    function artifacts(stmts) {
      const a = cfg.artifacts;
      stmts.forEach(st => {
        once('artifacts', st);
        const k = st.kw, A = a[k];
        cfg.declared.artifacts.push(k);
        A.on = !isOff(st);
        if (k === 'spikes') {
          checkUnits(st, ['freq']);
          A.rate = getNum(st, 'freq', { def: A.rate, min: 0.1 / 60, max: 20 / 60, scale: 1 / 60, unit: 'per minute' });
          A.amp = frac(st, { def: A.amp, min: 0.02, max: 3 });
        } else if (k === 'shifts') {
          checkUnits(st, []);
          const n = st.vals.find(v => v.kind === 'num');
          if (n) { if (n.v < 1 || n.v > 20 || n.v !== Math.round(n.v)) fail('shifts takes a whole number of baseline shifts, 1 to 20', n); A.count = n.v; }
          const pc = st.vals.find(v => v.kind === 'pct');
          if (pc) { if (pc.v < 0.02 || pc.v > 2) fail('the size of a baseline shift must be between 2% and 200%', pc); A.amp = pc.v; }
        } else if (k === 'poor') {
          checkUnits(st, []);
          const id = st.vals.find(v => v.kind === 'id' && !/^(on|off)$/i.test(v.v));
          if (id) A.optode = id.v;
          const pc = st.vals.find(v => v.kind === 'pct');
          if (pc) { if (pc.v <= 0 || pc.v > 0.5) fail('the coupling of a poor optode must be between 0% and 50% of normal', pc); A.couple = pc.v; }
        } else if (k === 'ambient') {
          checkUnits(st, ['power', 'freq', 'time']);
          const lv = st.vals.find((v, i) => v.kind === 'num' && v.unit && UNITS[v.unit][0] === 'power');
          if (lv) { const x = numIn(lv, 'power', st); if (x < 0 || x > 1e5) fail('ambient light at the detector must be between 0 and 100 uW', lv); A.level = x; }
          A.flicker = named(st, 'flicker', 'freq', { def: A.flicker, min: 0, max: 1000, unit: 'Hz' });
          const ch = named(st, 'change', 'time', { def: null, min: 1, max: 7200, unit: 's' });
          A.change = ch === undefined ? null : ch;
        }
      });
    }

    function analysis(stmts) {
      const an = cfg.analysis;
      stmts.forEach(st => {
        once('analysis', st);
        switch (st.kw) {
          case 'quality': {
            an.sci = named(st, 'sci', null, { def: an.sci, min: 0, max: 1 });
            an.cv = named(st, 'cv', null, { def: an.cv, min: 0.005, max: 1 });
            if (isOff(st)) { an.sci = 0; an.cv = 10; }
            break;
          }
          case 'motion': an.motion = getId(st, { required: true, oneOf: MOTION }); break;
          case 'bandpass': {
            if (isOff(st)) { an.hp = null; an.lp = null; break; }
            const f0 = getNum(st, 'freq', { required: true, index: 0 }), f1 = getNum(st, 'freq', { required: true, index: 1 });
            if (!(f0 > 0 && f1 > f0)) fail('bandpass needs a low and a higher high cut-off: bandpass 0.01 0.2 Hz', st);
            an.hp = f0; an.lp = f1; break;
          }
          case 'highpass': an.hp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.001, max: 0.5, unit: 'Hz' }); break;
          case 'lowpass': an.lp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.05, max: 10, unit: 'Hz' }); break;
          case 'dpf': {
            const id = st.vals.find(v => v.kind === 'id');
            if (id && /^age$/i.test(id.v)) {
              const hasNum = st.vals.some(v => v.kind === 'num');
              an.dpf = { mode: 'age', age: hasNum ? named(st, 'age', null, { min: 0, max: 90 }) : null, values: null }; break;
            }
            if (id && /^model$/i.test(id.v)) { an.dpf = { mode: 'model', age: null, values: null }; break; }
            if (id) fail('dpf takes a number for each wavelength, age <years>, or model', id);
            const ns = st.vals.filter(v => v.kind === 'num').map(v => v.v);
            if (!ns.length) fail('dpf needs a value: dpf 6, dpf 6.3 5.2, dpf age 30 or dpf model', st);
            ns.forEach(x => { if (x < 1 || x > 15) fail('a differential pathlength factor must be between 1 and 15', st); });
            an.dpf = { mode: 'fixed', age: null, values: ns }; break;
          }
          case 'short': {
            const ids = st.vals.filter(v => v.kind === 'id').map(v => v.v.toLowerCase());
            ids.forEach(w => { if (!SHORT.includes(w) && !SHORT_MODE.includes(w)) fail(`short takes ${SHORT.join(', ')} and optionally glm or before`, st); });
            const s = ids.find(w => SHORT.includes(w)); if (s) an.short = s;
            const m = ids.find(w => SHORT_MODE.includes(w)); if (m) an.shortMode = m;
            break;
          }
          case 'epoch': {
            const t0 = getNum(st, 'time', { required: true, index: 0 }), t1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(t0 < 0 && t1 > 0 && t1 - t0 <= 120)) fail('epoch needs a start before 0 and an end after 0: epoch -5 25 s', st);
            an.epoch = [t0, t1]; break;
          }
          case 'baseline': {
            if (isOff(st)) { an.baseline = null; break; }
            const b0 = getNum(st, 'time', { required: true, index: 0 }), b1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(b1 > b0)) fail('baseline needs a start and a later end: baseline -5 0 s', st);
            an.baseline = [b0, b1]; break;
          }
          case 'hrf': an.hrf = getId(st, { required: true, oneOf: HRF }); break;
          case 'derivative': an.deriv = !isOff(st); break;
          case 'noise': an.noise = getId(st, { required: true, oneOf: NOISE }); break;
        }
      });
    }

    prog.forEach(st => {
      if (st.kw === 'activation') { activation(st); return; }
      if (st.kw === 'pair') { pair(st); return; }
      if (seen['top.' + st.kw]) fail(`there can only be one ${st.kw} block`, st);
      seen['top.' + st.kw] = true;
      if (st.kw === 'probe') probe(st);
      else if (st.kw === 'head') head(st);
      else ({ recording, timeline, physiology, artifacts, analysis })[st.kw](st.block);
    });

    /* ---------- defaults and cross-checks ---------- */
    const P = cfg.probe;
    if (!seen['top.probe']) { const L = NIRS.LAYOUTS.motor(); P.sources = L.sources; P.detectors = L.detectors; P.shorts = L.shorts; }
    if (!cfg.timeline) cfg.timeline = { segments: [{ kind: 'rest', dur: 300 }] };
    if (!cfg.physiology) cfg.physiology = clone(PHYSIO_DEFAULTS);
    const geo = NIRS.buildProbe(P);
    if (!geo.channels.length) throw new DSLError(`no channels: no source and detector are between 1.5 and ${P.maxSep} cm apart`, 1, 1);
    const optodeNames = geo.sources.concat(geo.detectors).map(o => o.name);
    const brainTop = NIRS.brainTop(NIRS.headLayers(cfg.head.model, { thick: cfg.head.thick }));
    const fixRegion = (g, what) => {
      if (g.under) {
        const s = geo.sources.find(o => o.name === g.under[0]), d = geo.detectors.find(o => o.name === g.under[1]);
        if (!s || !d) throw new DSLError(`${what}: under ${g.under.join(' ')} names an optode that is not on the probe`, g.line || 1, g.col || 1);
        g.x = (s.x + d.x) / 2; g.y = (s.y + d.y) / 2;
      }
      if (g.depth === null) g.depth = brainTop + Math.min(0.3, g.radius * 0.5);
      if (g.depth < brainTop) cfg.warnings.push({ msg: `${what} is centred ${(g.depth * 10).toFixed(0)} mm deep, above the brain (which starts at ${(brainTop * 10).toFixed(1)} mm); only its part inside the brain counts`, line: 0 });
    };
    cfg.activations.forEach(a => fixRegion(a, 'activation ' + a.name));
    cfg.pairs.forEach(p => p.regions.forEach(r => fixRegion(r, `pair ${p.name}, region ${r.name}`)));
    const art = cfg.artifacts;
    if (art.poor.on && !optodeNames.includes(art.poor.optode))
      throw new DSLError(`poor ${art.poor.optode}: there is no optode called ${art.poor.optode} (the probe has ${optodeNames.join(', ')})`, 1, 1);
    const condNames = new Set();
    cfg.timeline.segments.forEach(s => { if (s.conditions) s.conditions.forEach(c => condNames.add(c.name)); if (s.kind === 'block') condNames.add(s.cond); });
    cfg.activations.forEach(a => {
      if (!condNames.size) cfg.warnings.push({ msg: `activation ${a.name} has no task to respond to; add blocks or events to the timeline`, line: 0 });
      a.conditions.forEach(c => { if (condNames.size && !condNames.has(c.name)) cfg.warnings.push({ msg: `activation ${a.name} responds to '${c.name}', which the timeline never presents`, line: 0 }); });
    });
    if (cfg.physiology.taskbp.on && !condNames.size) cfg.warnings.push({ msg: 'taskbp is on but the timeline has no task, so there is nothing to evoke it', line: 0 });
    if (cfg.analysis.short !== 'off' && !geo.channels.some(c => c.short))
      cfg.warnings.push({ msg: 'short-channel regression is on but the probe has no short-separation detectors', line: 0 });
    const r = cfg.recording;
    if (cfg.analysis.lp && cfg.analysis.lp >= r.fs / 2) cfg.analysis.lp = null;
    if (r.fs < 2.4 && cfg.physiology.cardiac.on) cfg.warnings.push({ msg: `at ${r.fs} Hz the cardiac pulse (${Math.round(cfg.physiology.cardiac.rate * 60)} bpm) is above the Nyquist frequency and will alias`, line: 0 });
    if (cfg.analysis.dpf.mode === 'fixed' && cfg.analysis.dpf.values.length !== 1 && cfg.analysis.dpf.values.length !== r.wavelengths.length)
      throw new DSLError(`dpf gives ${cfg.analysis.dpf.values.length} values but the recording has ${r.wavelengths.length} wavelengths`, 1, 1);
    const dur = NIRS.timelineDuration(cfg.timeline);
    const nch = geo.channels.length, size = dur * r.fs * nch * r.wavelengths.length;
    if (size > 4e6) throw new DSLError(`that recording is about ${Math.round(dur)} s at ${r.fs} Hz on ${nch} channels and ${r.wavelengths.length} wavelengths, ` +
      `${(size / 1e6).toFixed(1)} million samples; this page holds up to 4 million. Shorten the timeline or lower the rate.`, 1, 1);
    cfg.geometry = geo;
    return cfg;
  }

  // Expected length of a timeline (blocks and events use their mean jitter).
  NIRS.timelineDuration = function (tl) {
    return tl.segments.reduce((a, s) => a + (s.kind === 'blocks' ? s.n * (s.on + s.off + s.jitter / 2) :
      s.kind === 'events' ? s.n * (s.isi + s.jitter / 2) + 15 : s.dur), 0);
  };

  function build(src) { return compile(parse(src)); }

  /* ---------- serializer ----------
     Writes a configuration back out as a program, used when the controls
     on the Head and activation tab have moved things and the text should
     catch up.  Comments are not preserved. */
  function fmtNum(x, digits) {
    if (x === null || x === undefined) return 'off';
    return String(Number((+x).toPrecision(digits === undefined ? 4 : digits)));
  }
  const cm = x => fmtNum(x, 3) + ' cm', mm = x => fmtNum(x * 10, 3) + ' mm', pct = x => fmtNum(x * 100, 3) + '%';
  function regionText(g) {
    return (g.under ? `under ${g.under[0]} ${g.under[1]}` : `at ${fmtNum(g.x, 3)} ${fmtNum(g.y, 3)} cm`) + `  depth ${mm(g.depth)}  radius ${mm(g.radius)}`;
  }
  function serialize(cfg, title) {
    const L = [];
    if (title) L.push('# ' + title, '');
    const r = cfg.recording, D = DEFAULTS.recording;
    L.push('recording {', `  wavelengths ${r.wavelengths.map(x => fmtNum(x)).join(' ')} nm`, `  rate ${fmtNum(r.fs)} Hz`, `  multiplex ${r.multiplex}`);
    if (r.system !== D.system) L.push(`  system ${r.system}`);
    L.push(`  source ${r.source}  power ${fmtNum(r.power)} mW`, `  detector ${r.detector}`);
    if (r.seed !== D.seed) L.push(`  seed ${r.seed}`);
    L.push('}', '');
    const P = cfg.probe;
    L.push(`probe over ${P.over} {`);
    if (P.rotate) L.push(`  rotate ${fmtNum(P.rotate)} deg`);
    if (!P.custom) {
      L.push(`  layout ${P.layout}`);
      const def = NIRS.LAYOUTS[P.layout]().shorts;
      if (!P.shorts.length) L.push('  short off');
      else if (JSON.stringify(P.shorts.map(s => [s.of, s.dist, s.angle])) !== JSON.stringify(def.map(s => [s.of, s.dist, s.angle])))
        P.shorts.forEach(s => L.push(`  short ${s.of} ${mm(s.dist)}${s.angle !== -45 ? ' ' + fmtNum(s.angle) + ' deg' : ''}`));
    } else {
      P.sources.forEach(s => L.push(`  source ${s.name} at ${fmtNum(s.x, 3)} ${fmtNum(s.y, 3)} cm`));
      P.detectors.forEach(d => L.push(`  detector ${d.name} at ${fmtNum(d.x, 3)} ${fmtNum(d.y, 3)} cm`));
      P.shorts.forEach(s => L.push(`  short ${s.of} ${mm(s.dist)}${s.angle !== -45 ? ' ' + fmtNum(s.angle) + ' deg' : ''}`));
    }
    if (P.maxSep !== DEFAULTS.probe.maxSep) L.push(`  channels ${cm(P.maxSep)}`);
    (P.explicit || []).forEach(p => L.push(`  channel ${p[0]} ${p[1]}`));
    L.push('}', '');
    const h = cfg.head, th = Object.keys(h.thick);
    L.push(`head ${h.model} {${h.hair !== 'none' ? ' hair ' + h.hair : ''}${th.map(k => `  ${k} ${mm(h.thick[k])}`).join('')} }`, '');
    cfg.activations.forEach(a => {
      L.push(`activation ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.name) ? a.name : '"' + a.name + '"'} {`, '  ' + regionText(a));
      L.push(`  flow ${pct(a.flow)}${a.n !== 2.5 ? '  coupling ' + fmtNum(a.n, 3) : ''}${a.dip ? '  dip' : ''}`);
      a.conditions.forEach(c => L.push(`  condition ${c.name} ${fmtNum(c.gain)}`));
      L.push('}', '');
    });
    cfg.pairs.forEach(p => {
      L.push(`pair ${p.name} {`);
      p.regions.forEach(g => L.push(`  region ${g.name} { ${regionText(g)} }`));
      L.push(`  coupling ${fmtNum(p.coupling, 3)}  fluctuation ${pct(p.fluct)}  band ${fmtNum(p.band[0])} ${fmtNum(p.band[1])} Hz`, '}', '');
    });
    L.push('timeline {');
    cfg.timeline.segments.forEach(s => {
      if (s.kind === 'rest') L.push(`  rest ${fmtNum(s.dur)} s`);
      else if (s.kind === 'block') L.push(`  block ${s.cond} ${fmtNum(s.dur)} s`);
      else {
        const head = s.kind === 'blocks' ? `  blocks ${s.n} on ${fmtNum(s.on)} s off ${fmtNum(s.off)} s` : `  events ${s.n} isi ${fmtNum(s.isi)} s duration ${fmtNum(s.dur)} s`;
        L.push(`${head}${s.jitter ? ' jitter ' + fmtNum(s.jitter) + ' s' : ''} {`);
        s.conditions.forEach(c => L.push(`    condition ${c.name}${s.conditions.length > 1 ? ' ' + pct(c.p) : ''}`));
        if (s.order !== 'random') L.push(`    order ${s.order}`);
        L.push('  }');
      }
    });
    L.push('}', '');
    const ph = cfg.physiology, pl = [];
    ['cardiac', 'respiration', 'mayer', 'drift', 'taskbp'].forEach(k => {
      const A = ph[k];
      if (!A.on && !(cfg.declared.physiology || []).includes(k)) return;
      let s = '  ' + k;
      if (k === 'cardiac' || k === 'respiration') s += ` ${fmtNum(A.rate * 60, 3)} bpm`;
      if (k === 'mayer') s += ` ${fmtNum(A.rate, 3)} Hz`;
      s += ` ${fmtNum(A.amp, 3)} uM`;
      if (k === 'taskbp' && A.delay) s += ` ${fmtNum(A.delay)} s`;
      if (!A.on) s += ' off';
      pl.push(s);
    });
    if (ph.heterogeneity !== PHYSIO_DEFAULTS.heterogeneity) pl.push(`  heterogeneity ${pct(ph.heterogeneity)}`);
    if (ph.brain !== 1) pl.push(`  brain ${pct(ph.brain)}`);
    L.push('physiology {', ...pl, '}', '');
    const a = cfg.artifacts, al = [];
    Object.keys(a).forEach(k => {
      const A = a[k];
      if (!A.on && !cfg.declared.artifacts.includes(k)) return;
      let s = '  ' + k;
      if (k === 'spikes') s += ` ${fmtNum(A.rate * 60, 3)} /min ${pct(A.amp)}`;
      if (k === 'shifts') s += ` ${A.count} ${pct(A.amp)}`;
      if (k === 'poor') s += ` ${A.optode} ${pct(A.couple)}`;
      if (k === 'ambient') s += ` ${fmtNum(A.level, 3)} nW flicker ${fmtNum(A.flicker)} Hz${A.change ? ' change ' + fmtNum(A.change) + ' s' : ''}`;
      if (!A.on) s += ' off';
      al.push(s);
    });
    if (al.length) L.push('artifacts {', ...al, '}', '');
    const an = cfg.analysis, A0 = DEFAULTS.analysis, parts = [];
    if (an.sci !== A0.sci || an.cv !== A0.cv) parts.push(`quality sci ${fmtNum(an.sci, 3)} cv ${pct(an.cv)}`);
    parts.push(`motion ${an.motion}`);
    if (an.hp && an.lp) parts.push(`bandpass ${fmtNum(an.hp)} ${fmtNum(an.lp)} Hz`);
    else if (an.hp) parts.push(`highpass ${fmtNum(an.hp)} Hz`);
    else if (an.lp) parts.push(`lowpass ${fmtNum(an.lp)} Hz`);
    else parts.push('bandpass off');
    parts.push(an.dpf.mode === 'age' ? `dpf age${an.dpf.age !== null ? ' ' + fmtNum(an.dpf.age) : ''}` : an.dpf.mode === 'model' ? 'dpf model' : `dpf ${an.dpf.values.map(v => fmtNum(v, 3)).join(' ')}`);
    parts.push(`short ${an.short}${an.short !== 'off' ? ' ' + an.shortMode : ''}`);
    parts.push(`epoch ${fmtNum(an.epoch[0])} ${fmtNum(an.epoch[1])} s`, an.baseline ? `baseline ${fmtNum(an.baseline[0])} ${fmtNum(an.baseline[1])} s` : 'baseline off');
    parts.push(`hrf ${an.hrf}`);
    if (an.deriv) parts.push('derivative on');
    if (an.noise !== A0.noise) parts.push(`noise ${an.noise}`);
    L.push('analysis {', ...parts.map(p => '  ' + p), '}');
    return L.join('\n') + '\n';
  }

  /* ---------- syntax highlighting for the editor ---------- */
  const ALL_KW = new Set([].concat(...Object.values(SCHEMA)));
  const VALUE_WORDS = new Set(['off', 'on', 'over', 'cw', 'fd', 'td', 'time', 'frequency', 'none', 'laser', 'led', 'photodiode', 'apd', 'sipm',
    'motor', 'forehead', 'adult', 'thick', 'infant', 'light', 'dense', 'dark', 'isi', 'jitter', 'duration', 'random', 'alternate', 'sequence',
    'tddr', 'spline', 'nearest', 'mean', 'glm', 'before', 'canonical', 'gamma', 'ols', 'ar', 'age', 'model', 'sci', 'cv', 'flicker', 'change']);
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(src) {
    const re = /(#[^\n]*)|("[^"\n]*"?)|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?)|(\/min\b|[A-Za-zµ_][A-Za-z0-9_µ]*)|([{}])/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += escapeHtml(src.slice(last, m.index));
      const s = escapeHtml(m[0]);
      if (m[1]) out += `<span class="tk-com">${s}</span>`;
      else if (m[2]) out += `<span class="tk-str">${s}</span>`;
      else if (m[3]) out += `<span class="tk-num">${s}</span>`;
      else if (m[4]) {
        const w = m[4];
        if (UNITS[w]) out += `<span class="tk-unit">${s}</span>`;
        else if (ALL_KW.has(w)) out += `<span class="tk-key">${s}</span>`;
        else if (/^(S|D|SS)\d+$/.test(w) || NIRS.TEN20[w]) out += `<span class="tk-elec">${s}</span>`;
        else if (VALUE_WORDS.has(w)) out += `<span class="tk-val">${s}</span>`;
        else out += s;
      } else out += `<span class="tk-br">${s}</span>`;
      last = re.lastIndex;
    }
    return out + escapeHtml(src.slice(last)) + '\n';
  }

  NIRS.dsl = { lex, parse, compile, build, serialize, highlight, DSLError, UNITS };
})(typeof window !== 'undefined' ? window : globalThis);
