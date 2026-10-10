/* EEG simulator: a small language for describing a recording.

   A program is a handful of blocks:

     recording { cap 32  reference Cz  rate 250 Hz  highpass 0.1 Hz ... }
     head      { skull 0.0083 S/m ... }
     source <type> <name> { ... }        dipole, pair, alpha, erp, spike
     timeline  { block closed 20 s  trials 120 isi 1 s { condition ... } }
     artifacts { blinks 0.2 Hz  line 50 mV  bad T8 80 kOhm ... }
     analysis  { reference average  highpass 0.3 Hz  epoch -200 800 ms ... }

   Statements are a keyword followed by values.  A value is a number with
   an optional unit, a percentage, a name or a quoted string.  The unit
   decides what a number means, so `blinks 0.2 Hz 150 uV` is a rate and an
   amplitude in either order.  Newlines are only whitespace: a statement
   ends where the next keyword of the same block begins, which is what lets
   a whole block sit on one line. */
(function (G) {
  'use strict';
  const EEG = G.EEG;

  class DSLError extends Error {
    constructor(msg, line, col) { super(msg); this.line = line; this.col = col; }
  }

  /* ---------- units ---------- */
  const UNITS = {
    Hz: ['freq', 1], kHz: ['freq', 1000], bpm: ['freq', 1 / 60],
    s: ['time', 1], ms: ['time', 1e-3], us: ['time', 1e-6], min: ['time', 60],
    uV: ['volt', 1], 'µV': ['volt', 1], mV: ['volt', 1e3], V: ['volt', 1e6],
    nAm: ['moment', 1], uAm: ['moment', 1e3], 'µAm': ['moment', 1e3],
    Ohm: ['ohm', 1e-3], 'Ω': ['ohm', 1e-3], kOhm: ['ohm', 1], 'kΩ': ['ohm', 1], MOhm: ['ohm', 1e3], 'MΩ': ['ohm', 1e3],
    cm: ['length', 1], mm: ['length', 0.1],
    deg: ['angle', 1], rad: ['angle', 180 / Math.PI],
    'S/m': ['cond', 1],
    bit: ['bits', 1], bits: ['bits', 1],
    dB: ['db', 1]
  };
  const DIM_NAMES = {
    freq: 'a frequency (Hz)', time: 'a time (s or ms)', volt: 'a voltage (uV or mV)', moment: 'a dipole moment (nAm)',
    ohm: 'an impedance (kOhm)', length: 'a length (cm or mm)', angle: 'an angle (deg)', cond: 'a conductivity (S/m)',
    bits: 'a bit depth', db: 'a level in dB'
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
      if ((m = /^S\/m\b/.exec(rest)) || (m = /^[A-Za-zµΩ_][A-Za-z0-9_µΩ]*/.exec(rest))) {
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
  const GEOM = ['at', 'pos', 'depth', 'orient', 'toward', 'dir'];
  const SCHEMA = {
    top: ['recording', 'head', 'source', 'timeline', 'artifacts', 'analysis'],
    recording: ['cap', 'reference', 'ground', 'rate', 'highpass', 'lowpass', 'bits', 'range', 'impedance',
      'mains', 'cmrr', 'input', 'background', 'seed'],
    head: ['brain', 'csf', 'skull', 'scalp', 'homogeneous'],
    'source:dipole': GEOM.concat(['amp', 'signal', 'label']),
    'source:pair': ['dipole', 'rhythm', 'amp', 'coupling', 'lag', 'label'],
    'pair:dipole': GEOM.slice(),
    'source:alpha': ['amp', 'freq', 'closed', 'open', 'erd', 'depth', 'bandwidth', 'label'],
    'source:erp': GEOM.concat(['amp', 'latency', 'width', 'peak', 'jitter', 'condition', 'label']),
    'source:spike': GEOM.concat(['amp', 'rate', 'width', 'wave', 'label']),
    timeline: ['block', 'trials', 'rest'],
    'timeline:trials': ['condition', 'order'],
    artifacts: ['blinks', 'saccades', 'muscle', 'cardiac', 'line', 'drift', 'pops', 'bad'],
    analysis: ['reference', 'highpass', 'lowpass', 'notch', 'order', 'phase', 'epoch', 'baseline', 'reject', 'ica']
  };
  const SOURCE_TYPES = ['dipole', 'pair', 'alpha', 'erp', 'spike'];
  EEG.DSL_SCHEMA = SCHEMA;

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
      if (tk.t === 'id') { p++; return { kind: 'id', v: tk.v, line: tk.line, col: tk.col }; }
      if (tk.t === 'str') { p++; return { kind: 'str', v: tk.v, line: tk.line, col: tk.col }; }
      if (tk.t === 'sym' && tk.v === ',') { p++; return null; }
      err(`unexpected '${tk.v}'`);
    }

    // A unitless run of numbers takes the unit of the number that ends it:
    // `epoch -200 800 ms` means two times in milliseconds.
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
        if (ctx === 'top') {
          if (kw.v === 'source') {
            const ty = vals[0] && vals[0].kind === 'id' ? vals[0].v : null;
            if (!ty || !SOURCE_TYPES.includes(ty)) err(`source needs a type: one of ${SOURCE_TYPES.join(', ')}`, kw);
            sub = 'source:' + ty;
          } else sub = kw.v;
        } else if (ctx === 'timeline' && kw.v === 'trials') sub = 'timeline:trials';
        else if (ctx === 'source:pair' && kw.v === 'dipole') sub = 'pair:dipole';
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
  const DEFAULTS = {
    recording: { cap: 32, reference: 'Cz', ground: 'AFz', fs: 250, hp: 0.1, lp: null, bits: 16, range: 3276.8,
      impedance: 5, mains: 60, cmrr: 100, input: 100e3, background: 8, seed: 1 },
    head: { sigma: EEG.HEAD.sigma.slice(), homogeneous: false },
    artifacts: {
      blinks: { on: false, rate: 0.25, amp: 150 },
      saccades: { on: false, rate: 0.15, amp: 40 },
      muscle: { on: false, rate: 0.05, amp: 25 },
      cardiac: { on: false, rate: 70 / 60, amp: 6 },
      line: { on: false, amp: 50e3 },
      drift: { on: false, amp: 25 },
      pops: { on: false, rate: 0.02, amp: 200 },
      bad: { on: false, label: 'T8', impedance: 80 }
    },
    analysis: { reference: 'average', hp: null, lp: null, notch: null, order: 4, phase: 'zero',
      epoch: [-0.2, 0.8], baseline: [-0.2, 0], reject: null, ica: 20 }
  };
  EEG.DSL_DEFAULTS = DEFAULTS;
  const REFS = ['online', 'average', 'mastoids', 'Cz', 'bipolar', 'transverse', 'laplacian'];
  EEG.REFERENCES = REFS;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function compile(prog) {
    const cfg = {
      recording: clone(DEFAULTS.recording), head: clone(DEFAULTS.head), sources: [],
      timeline: null, artifacts: clone(DEFAULTS.artifacts), analysis: clone(DEFAULTS.analysis),
      warnings: [], declared: { artifacts: [] }
    };
    const fail = (msg, at) => { throw new DSLError(msg, at.line, at.col); };
    const warn = (msg, at) => cfg.warnings.push({ msg, line: at.line });
    const seen = {};

    // Value helpers. A unitless number is read in the dimension's base unit.
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
        if (wrong) fail(`'${wrong.v} ${wrong.unit}' is ${DIM_NAMES[UNITS[wrong.unit][0]]}, but ${st.kw} needs ${DIM_NAMES[dim]}`, wrong);
        if (opts.required) fail(`${st.kw} needs ${dim ? DIM_NAMES[dim] : 'a number'}`, st);
        return opts.def;
      }
      const x = dim === null ? v.v : numIn(v, dim, st);
      if (opts.min !== undefined && x < opts.min || opts.max !== undefined && x > opts.max) {
        const unit = opts.unit || '';
        fail(`${st.kw} must be between ${opts.min / (opts.scale || 1)} and ${opts.max / (opts.scale || 1)}${unit ? ' ' + unit : ''}`, v);
      }
      return x;
    }
    function unitNums(st) { return st.vals.filter(v => v.kind === 'num' && v.unit); }
    function checkUnits(st, dims) {
      st.vals.forEach(v => {
        if (v.kind === 'num' && v.unit && !dims.includes(UNITS[v.unit][0]))
          fail(`'${v.v} ${v.unit}' is ${DIM_NAMES[UNITS[v.unit][0]]}, which ${st.kw} does not take`, v);
      });
    }
    function getId(st, opts) {
      opts = opts || {};
      const ids = st.vals.filter(v => v.kind === 'id');
      const v = ids[opts.index || 0];
      if (!v) { if (opts.required) fail(`${st.kw} needs a name`, st); return opts.def; }
      if (opts.oneOf) {
        const hit = opts.oneOf.find(o => o.toLowerCase() === v.v.toLowerCase());
        if (!hit) fail(`${st.kw} must be one of: ${opts.oneOf.join(', ')}`, v);
        return hit;
      }
      return v.v;
    }
    function getElectrode(st, index) {
      const ids = st.vals.filter(v => v.kind === 'id');
      const v = ids[index || 0];
      if (!v) fail(`${st.kw} needs an electrode name, such as Cz or P3`, st);
      const lab = EEG.resolveLabel(v.v);
      if (!lab) fail(`'${v.v}' is not a 10-10 electrode name`, v);
      return lab;
    }
    function frac(st, opts) {
      const v = st.vals.find(x => x.kind === 'pct' || x.kind === 'num');
      if (!v) { if (opts && opts.required) fail(`${st.kw} needs a number or a percentage`, st); return opts ? opts.def : undefined; }
      const x = v.kind === 'pct' ? v.v : v.v;
      const lo = opts && opts.min !== undefined ? opts.min : 0, hi = opts && opts.max !== undefined ? opts.max : 1;
      if (x < lo || x > hi) fail(`${st.kw} must be between ${lo} and ${hi} (or ${lo * 100}% to ${hi * 100}%)`, v);
      return x;
    }
    const isOff = st => st.vals.some(v => v.kind === 'id' && /^(off|none|dc)$/i.test(v.v));
    const once = (ctx, st) => {
      const k = ctx + '.' + st.kw;
      if (seen[k]) warn(`${st.kw} appears twice in ${ctx}; the last one wins`, st);
      seen[k] = true;
    };

    function recording(stmts) {
      const r = cfg.recording;
      stmts.forEach(st => {
        once('recording', st);
        switch (st.kw) {
          case 'cap': {
            const n = getNum(st, null, { required: true });
            if (![19, 32, 64].includes(n)) fail('cap must be 19, 32 or 64 channels', st);
            r.cap = n; break;
          }
          case 'reference': r.reference = getElectrode(st); break;
          case 'ground': r.ground = getElectrode(st); break;
          case 'rate': r.fs = getNum(st, 'freq', { required: true, min: 100, max: 2000, unit: 'Hz' }); break;
          case 'highpass': r.hp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.01, max: 5, unit: 'Hz' }); break;
          case 'lowpass': r.lp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 5, max: 1000, unit: 'Hz' }); break;
          case 'bits': r.bits = getNum(st, 'bits', { required: true, min: 4, max: 24 }); break;
          case 'range': r.range = getNum(st, 'volt', { required: true, min: 50, max: 1e6, unit: 'uV' }); break;
          case 'impedance': r.impedance = getNum(st, 'ohm', { required: true, min: 0.5, max: 500, unit: 'kOhm' }); break;
          case 'mains': {
            const f = getNum(st, 'freq', { required: true });
            if (f !== 50 && f !== 60) fail('mains must be 50 Hz or 60 Hz', st);
            r.mains = f; break;
          }
          case 'cmrr': r.cmrr = getNum(st, 'db', { required: true, min: 40, max: 140, unit: 'dB' }); break;
          case 'input': r.input = getNum(st, 'ohm', { required: true, min: 1e3, max: 1e7, scale: 1e3, unit: 'MOhm' }); break;
          case 'background': r.background = isOff(st) ? 0 : getNum(st, 'volt', { required: true, min: 0, max: 60, unit: 'uV' }); break;
          case 'seed': r.seed = Math.round(getNum(st, null, { required: true })); break;
        }
      });
      if (r.lp === null) r.lp = Math.round(r.fs * 0.4);
    }

    function head(stmts) {
      const h = cfg.head, idx = { brain: 0, csf: 1, skull: 2, scalp: 3 };
      stmts.forEach(st => {
        once('head', st);
        if (st.kw === 'homogeneous') { h.homogeneous = !isOff(st); return; }
        h.sigma[idx[st.kw]] = getNum(st, 'cond', { required: true, min: 0.0005, max: 5, unit: 'S/m' });
      });
    }

    function geometry(stmts, src, defaults) {
      const g = Object.assign({ at: 'Cz', depth: 2, tilt: 0, dir: 0, toward: null, pos: null }, defaults || {});
      let posGiven = false;
      stmts.forEach(st => {
        switch (st.kw) {
          case 'at': g.at = getElectrode(st); break;
          case 'depth': g.depth = getNum(st, 'length', { required: true, min: 1.3, max: 9.2, unit: 'cm' }); break;
          case 'pos': {
            const ns = st.vals.filter(v => v.kind === 'num');
            if (ns.length !== 3) fail('pos needs three coordinates: x y z cm (x right, y forward, z up)', st);
            g.pos = ns.map(v => numIn(v, 'length', st));
            if (EEG.v3.norm(g.pos) > EEG.HEAD.maxSourceR) fail(`pos must lie inside the brain, within ${EEG.HEAD.maxSourceR} cm of the centre`, st);
            posGiven = true; break;
          }
          case 'orient': {
            const id = st.vals.find(v => v.kind === 'id');
            if (id) {
              const k = id.v.toLowerCase();
              if (k === 'radial' || k === 'outward') g.tilt = 0;
              else if (k === 'tangential') g.tilt = 90;
              else if (k === 'inward') g.tilt = 180;
              else fail(`orient takes radial, tangential, inward or an angle from radial in degrees`, id);
            } else g.tilt = getNum(st, 'angle', { required: true, min: 0, max: 180, unit: 'deg' });
            break;
          }
          case 'toward': g.toward = getElectrode(st); break;
          case 'dir': g.dir = getNum(st, 'angle', { required: true, min: -360, max: 360, unit: 'deg' }); g.toward = null; break;
        }
      });
      if (!posGiven) g.pos = EEG.placeDipole(g.at, g.depth);
      else { g.at = null; g.depth = EEG.depthOf(g.pos); }
      g.ori = EEG.orientation(g.pos, g.tilt, g.dir, g.toward);
      return g;
    }

    function source(st) {
      const type = st.vals[0].v;
      const nameV = st.vals.find((v, i) => i > 0 && (v.kind === 'id' || v.kind === 'str'));
      const name = nameV ? nameV.v : type + (cfg.sources.filter(s => s.type === type).length + 1);
      if (cfg.sources.some(s => s.name === name)) fail(`there is already a source called '${name}'`, st);
      const stmts = st.block;
      const s = { type, name, label: name };
      const get = kw => stmts.filter(x => x.kw === kw);
      const last = kw => { const a = get(kw); return a[a.length - 1]; };
      const lab = last('label'); if (lab) s.label = getId(lab) || (lab.vals[0] && lab.vals[0].v) || name;
      stmts.forEach(x => {
        const ctx = 'source ' + name;
        if (!['peak', 'condition', 'dipole'].includes(x.kw)) once(ctx, x);
      });
      const amp = last('amp');
      if (type === 'dipole') {
        Object.assign(s, geometry(stmts));
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -2000, max: 2000, unit: 'nAm' }) : 10;
        const sg = last('signal');
        s.signal = sg ? getId(sg, { oneOf: ['sine', 'burst', 'pink'] }) : 'sine';
        s.freq = sg ? getNum(sg, 'freq', { def: 10, min: 0.5, max: 200, unit: 'Hz' }) : 10;
      } else if (type === 'pair') {
        const ds = get('dipole');
        if (ds.length !== 2) fail('a pair needs exactly two dipole blocks: dipole A { ... } and dipole B { ... }', st);
        s.dipoles = ds.map((d, i) => {
          const nm = d.vals.find(v => v.kind === 'id' || v.kind === 'str');
          return Object.assign({ name: nm ? nm.v : 'AB'[i] }, geometry(d.block || []));
        });
        const rh = last('rhythm');
        s.freq = rh ? getNum(rh, 'freq', { required: true, min: 1, max: 80, unit: 'Hz' }) : 10;
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: 0, max: 2000, unit: 'nAm' }) : 10;
        const cp = last('coupling'); s.coupling = cp ? frac(cp, { required: true }) : 0.5;
        const lg = last('lag'); s.lag = lg ? getNum(lg, 'time', { required: true, min: -0.2, max: 0.2, scale: 1e-3, unit: 'ms' }) : 0;
      } else if (type === 'alpha') {
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: 0, max: 2000, unit: 'nAm' }) : 80;
        const f = last('freq'); s.freq = f ? getNum(f, 'freq', { required: true, min: 6, max: 14, unit: 'Hz' }) : 10;
        const bw = last('bandwidth'); s.bandwidth = bw ? getNum(bw, 'freq', { required: true, min: 0.2, max: 4, unit: 'Hz' }) : 1.5;
        const c = last('closed'); s.closed = c ? frac(c, { required: true, max: 2 }) : 1;
        const o = last('open'); s.open = o ? frac(o, { required: true, max: 2 }) : 0.2;
        const e = last('erd'); s.erd = e ? frac(e, { required: true }) : 0;
        const d = last('depth'); s.depth = d ? getNum(d, 'length', { required: true, min: 1.3, max: 6, unit: 'cm' }) : 2.5;
        s.dipoles = ['O1', 'O2'].map((k, i) => {
          const pos = EEG.placeDipole(k, s.depth);
          return { name: i ? 'right' : 'left', at: k, depth: s.depth, tilt: 20, dir: 0, toward: 'Cz', pos,
            ori: EEG.orientation(pos, 20, 0, 'Cz') };
        });
      } else if (type === 'erp') {
        Object.assign(s, geometry(stmts));
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -2000, max: 2000, unit: 'nAm' }) : 10;
        s.peaks = get('peak').map(pk => {
          const ns = pk.vals.filter(v => v.kind === 'num');
          if (ns.length < 2) fail('peak needs a latency, a width and optionally a gain: peak 170 ms 40 ms -1', pk);
          const lat = numIn(ns[0], 'time', pk), wid = numIn(ns[1], 'time', pk);
          if (lat < 0 || lat > 2) fail('peak latency must be between 0 and 2000 ms', ns[0]);
          if (wid < 0.005 || wid > 1) fail('peak width must be between 5 and 1000 ms', ns[1]);
          return { latency: lat, width: wid, gain: ns[2] ? ns[2].v : 1 };
        });
        const la = last('latency'), wi = last('width');
        if (la || wi || !s.peaks.length) {
          s.peaks.unshift({
            latency: la ? getNum(la, 'time', { required: true, min: 0, max: 2, scale: 1e-3, unit: 'ms' }) : 0.3,
            width: wi ? getNum(wi, 'time', { required: true, min: 0.005, max: 1, scale: 1e-3, unit: 'ms' }) : 0.1,
            gain: 1
          });
        }
        const j = last('jitter'); s.jitter = j ? getNum(j, 'time', { required: true, min: 0, max: 0.3, scale: 1e-3, unit: 'ms' }) : 0;
        s.conditions = get('condition').map(c => {
          const nm = c.vals.find(v => v.kind === 'id' || v.kind === 'str');
          if (!nm) fail('condition needs a name and a gain: condition target 1', c);
          const g = c.vals.find(v => v.kind === 'num' || v.kind === 'pct');
          return { name: nm.v, gain: g ? g.v : 1 };
        });
      } else if (type === 'spike') {
        Object.assign(s, geometry(stmts));
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -5000, max: 5000, unit: 'nAm' }) : 200;
        const r = last('rate'); s.rate = r ? getNum(r, 'freq', { required: true, min: 0.01, max: 3, unit: 'Hz' }) : 0.2;
        const w = last('width'); s.width = w ? getNum(w, 'time', { required: true, min: 0.02, max: 0.2, scale: 1e-3, unit: 'ms' }) : 0.07;
        const wv = last('wave'); s.wave = wv ? frac(wv, { required: true, max: 2 }) : 0.5;
      }
      cfg.sources.push(s);
    }

    function timeline(stmts) {
      const segs = [];
      stmts.forEach(st => {
        if (st.kw === 'block') {
          const state = getId(st, { required: true, oneOf: ['closed', 'open'] });
          segs.push({ kind: 'block', state, dur: getNum(st, 'time', { required: true, min: 1, max: 600, unit: 's' }) });
        } else if (st.kw === 'rest') {
          segs.push({ kind: 'block', state: 'open', dur: getNum(st, 'time', { required: true, min: 0.5, max: 600, unit: 's' }) });
        } else if (st.kw === 'trials') {
          const v = st.vals;
          const n = v[0] && v[0].kind === 'num' && !v[0].unit ? v[0].v : null;
          if (!n || n < 1 || n > 2000 || n !== Math.round(n)) fail('trials needs a whole number of trials first, such as trials 120 isi 1 s', st);
          const named = name => {
            const i = v.findIndex(x => x.kind === 'id' && x.v.toLowerCase() === name);
            if (i < 0) return null;
            const nx = v[i + 1];
            if (!nx || nx.kind !== 'num') fail(`${name} needs a time after it`, v[i]);
            return numIn(nx, 'time', st);
          };
          v.forEach(x => { if (x.kind === 'id' && !['isi', 'jitter', 'soa'].includes(x.v.toLowerCase())) fail(`trials does not understand '${x.v}'; use isi and jitter`, x); });
          const isi = named('isi') || named('soa') || 1;
          const jitter = named('jitter') || 0;
          if (isi < 0.2 || isi > 20) fail('isi must be between 0.2 and 20 s', st);
          if (jitter < 0 || jitter > 5) fail('jitter must be between 0 and 5 s', st);
          const conds = [], body = st.block || [];
          let order = 'random';
          body.forEach(b => {
            if (b.kw === 'condition') {
              const nm = b.vals.find(x => x.kind === 'id' || x.kind === 'str');
              if (!nm) fail('condition needs a name and a share: condition target 20%', b);
              const w = b.vals.find(x => x.kind === 'pct' || x.kind === 'num');
              conds.push({ name: nm.v, p: w ? w.v : 1 });
            } else order = getId(b, { required: true, oneOf: ['random', 'alternate', 'sequence'] });
          });
          if (!conds.length) conds.push({ name: 'stim', p: 1 });
          const tot = conds.reduce((a, c) => a + c.p, 0);
          if (tot <= 0) fail('condition shares must add up to more than zero', st);
          conds.forEach(c => { c.p /= tot; });
          segs.push({ kind: 'trials', n, isi, jitter, conditions: conds, order });
        }
      });
      cfg.timeline = { segments: segs };
    }

    function artifacts(stmts) {
      const a = cfg.artifacts;
      stmts.forEach(st => {
        once('artifacts', st);
        const k = st.kw, A = a[k];
        cfg.declared.artifacts.push(k);
        A.on = !isOff(st);
        if (k === 'bad') {
          if (st.vals.some(v => v.kind === 'id' && !/^(off|on)$/i.test(v.v))) A.label = getElectrode(st);
          checkUnits(st, ['ohm']);
          A.impedance = getNum(st, 'ohm', { def: A.impedance, min: 1, max: 5000, unit: 'kOhm' });
          return;
        }
        const dims = { blinks: ['freq', 'volt'], saccades: ['freq', 'volt'], muscle: ['freq', 'volt'], cardiac: ['freq', 'volt'],
          line: ['volt'], drift: ['volt'], pops: ['freq', 'volt'] }[k];
        checkUnits(st, dims);
        unitNums(st).forEach(v => {
          const d = UNITS[v.unit][0], x = v.v * UNITS[v.unit][1];
          if (d === 'freq') {
            const max = k === 'cardiac' ? 3.5 : 2;
            if (x <= 0 || x > max) fail(`${k} rate must be between 0 and ${k === 'cardiac' ? '210 bpm' : '2 Hz'}`, v);
            A.rate = x;
          } else if (d === 'volt') {
            if (x < 0 || x > (k === 'line' ? 1e6 : 5000)) fail(`${k} amplitude is out of range`, v);
            A.amp = x;
          }
        });
        if (st.vals.some(v => v.kind === 'num' && !v.unit)) fail(`give ${k} its numbers with units, such as 0.2 Hz or 100 uV`, st);
      });
    }

    function analysis(stmts) {
      const an = cfg.analysis;
      stmts.forEach(st => {
        once('analysis', st);
        switch (st.kw) {
          case 'reference': {
            const id = getId(st, { required: true });
            const k = id.toLowerCase();
            const map = { linked: 'mastoids', mastoid: 'mastoids', avg: 'average', car: 'average', cz: 'Cz', csd: 'laplacian', none: 'online', recorded: 'online' };
            const ref = REFS.find(r => r.toLowerCase() === k) || map[k];
            if (!ref) fail(`reference must be one of: ${REFS.join(', ')}`, st);
            an.reference = ref; break;
          }
          case 'highpass': an.hp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.01, max: 10, unit: 'Hz' }); break;
          case 'lowpass': an.lp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 1, max: 500, unit: 'Hz' }); break;
          case 'notch': an.notch = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 40, max: 70, unit: 'Hz' }); break;
          case 'order': an.order = Math.round(getNum(st, null, { required: true, min: 1, max: 8 })); break;
          case 'phase': an.phase = getId(st, { required: true, oneOf: ['zero', 'causal'] }); break;
          case 'epoch': {
            const t0 = getNum(st, 'time', { required: true, index: 0 }), t1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(t0 < 0 && t1 > 0 && t1 - t0 <= 4)) fail('epoch needs a start before 0 and an end after 0, at most 4 s apart: epoch -200 800 ms', st);
            an.epoch = [t0, t1]; break;
          }
          case 'baseline': {
            if (isOff(st)) { an.baseline = null; break; }
            const b0 = getNum(st, 'time', { required: true, index: 0 }), b1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(b1 > b0)) fail('baseline needs a start and a later end: baseline -200 0 ms', st);
            an.baseline = [b0, b1]; break;
          }
          case 'reject': an.reject = isOff(st) ? null : getNum(st, 'volt', { required: true, min: 5, max: 5000, unit: 'uV' }); break;
          case 'ica': an.ica = isOff(st) ? 0 : Math.round(getNum(st, null, { required: true, min: 2, max: 63 })); break;
        }
      });
    }

    prog.forEach(st => {
      if (st.kw === 'source') { source(st); return; }
      if (st.kw !== 'source') {
        if (seen['top.' + st.kw]) fail(`there can only be one ${st.kw} block`, st);
        seen['top.' + st.kw] = true;
      }
      ({ recording, head, timeline, artifacts, analysis })[st.kw](st.block);
    });

    // Cross-checks that need more than one block
    const r = cfg.recording;
    if (!cfg.timeline) cfg.timeline = { segments: [{ kind: 'block', state: 'open', dur: 60 }] };
    if (r.lp >= r.fs / 2) cfg.warnings.push({ msg: `the online low-pass (${r.lp} Hz) is at or above the Nyquist frequency (${r.fs / 2} Hz): nothing stops aliasing`, line: 0 });
    if (cfg.analysis.lp && cfg.analysis.lp >= r.fs / 2) cfg.analysis.lp = null;
    const bad = cfg.artifacts.bad;
    if (bad.on && !EEG.capLabels(r.cap).includes(bad.label) && !['M1', 'M2'].includes(bad.label) && bad.label !== r.reference)
      cfg.warnings.push({ msg: `bad electrode ${bad.label} is not on the ${r.cap}-channel cap`, line: 0 });
    const condNames = new Set();
    cfg.timeline.segments.forEach(s => { if (s.kind === 'trials') s.conditions.forEach(c => condNames.add(c.name)); });
    cfg.sources.forEach(s => {
      if (s.type === 'erp') {
        if (!condNames.size) cfg.warnings.push({ msg: `ERP source ${s.name} has no trials to respond to; add a trials block to the timeline`, line: 0 });
        s.conditions.forEach(c => { if (condNames.size && !condNames.has(c.name)) cfg.warnings.push({ msg: `ERP source ${s.name} responds to '${c.name}', which no trials block uses`, line: 0 }); });
      }
    });
    if (cfg.analysis.reference === 'Cz' && r.cap && !EEG.capLabels(r.cap).includes('Cz')) cfg.analysis.reference = 'average';
    // Size check: the page holds the whole recording in memory
    const dur = cfg.timeline.segments.reduce((a, s) => a + (s.kind === 'trials' ? 1.5 + s.n * (s.isi + s.jitter / 2) : s.dur), 0);
    const nrow = r.cap + 2;
    if (dur * r.fs * nrow > 1.2e7) throw new DSLError(`that recording is about ${Math.round(dur)} s at ${r.fs} Hz on ${r.cap} channels, ` +
      `${(dur * r.fs * nrow / 1e6).toFixed(1)} million samples; this page holds up to 12 million. Shorten the timeline, lower the rate or use fewer channels.`, 1, 1);
    return cfg;
  }

  function build(src) {
    return compile(parse(src));
  }

  /* ---------- serializer ----------
     Writes a configuration back out as a program.  Used when the controls
     on the Sources tab have moved things and the user wants the text to
     catch up.  Comments are not preserved. */
  function fmtNum(x, digits) {
    if (x === null || x === undefined) return 'off';
    const d = digits === undefined ? 4 : digits;
    return String(Number(x.toPrecision(d)));
  }
  function geomText(g, indent) {
    const out = [];
    const pos0 = g.at ? EEG.placeDipole(g.at, g.depth) : null;
    if (g.at && pos0 && EEG.v3.norm(EEG.v3.sub(pos0, g.pos)) < 0.05) out.push(`at ${g.at} depth ${fmtNum(g.depth, 3)} cm`);
    else out.push(`pos ${g.pos.map(x => fmtNum(x, 3)).join(' ')} cm`);
    const ang = EEG.orientationAngles(g.pos, g.ori);
    const tilt = Math.round(ang.tilt);
    if (tilt === 0) out.push('orient radial');
    else if (tilt === 180) out.push('orient inward');
    else if (g.toward && Math.abs(tilt - g.tilt) < 1) out.push(`orient ${tilt} deg toward ${g.toward}`);
    else out.push(`orient ${tilt} deg dir ${Math.round(ang.dir)} deg`);
    return indent + out.join('  ');
  }
  function serialize(cfg, title) {
    const L = [];
    if (title) L.push('# ' + title, '');
    const r = cfg.recording, D = DEFAULTS.recording;
    L.push('recording {');
    L.push(`  cap ${r.cap}`, `  reference ${r.reference}`, `  ground ${r.ground}`, `  rate ${fmtNum(r.fs)} Hz`);
    L.push(`  highpass ${r.hp === null ? 'off' : fmtNum(r.hp) + ' Hz'}`, `  lowpass ${r.lp === null ? 'off' : fmtNum(r.lp) + ' Hz'}`);
    if (r.bits !== D.bits) L.push(`  bits ${r.bits}`);
    if (r.range !== D.range) L.push(`  range ${fmtNum(r.range)} uV`);
    L.push(`  impedance ${fmtNum(r.impedance)} kOhm`, `  mains ${r.mains} Hz`);
    if (r.cmrr !== D.cmrr) L.push(`  cmrr ${fmtNum(r.cmrr)} dB`);
    if (r.input !== D.input) L.push(`  input ${fmtNum(r.input / 1e3)} MOhm`);
    if (r.background !== D.background) L.push(`  background ${r.background ? fmtNum(r.background) + ' uV' : 'off'}`);
    if (r.seed !== D.seed) L.push(`  seed ${r.seed}`);
    L.push('}', '');
    const h = cfg.head, HD = DEFAULTS.head;
    if (h.homogeneous || h.sigma.some((s, i) => Math.abs(s - HD.sigma[i]) > 1e-9)) {
      const parts = ['brain', 'csf', 'skull', 'scalp'].map((k, i) => `${k} ${fmtNum(h.sigma[i])} S/m`);
      L.push(`head { ${parts.join('  ')}${h.homogeneous ? '  homogeneous' : ''} }`, '');
    }
    cfg.sources.forEach(s => {
      const nm = /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name) ? s.name : `"${s.name}"`;
      L.push(`source ${s.type} ${nm} {`);
      if (s.type === 'dipole') {
        L.push(geomText(s, '  '), `  amp ${fmtNum(s.amp)} nAm`, `  signal ${s.signal}${s.signal !== 'pink' ? ' ' + fmtNum(s.freq) + ' Hz' : ''}`);
      } else if (s.type === 'pair') {
        s.dipoles.forEach(d => L.push(`  dipole ${d.name} { ${geomText(d, '').trim()} }`));
        L.push(`  rhythm ${fmtNum(s.freq)} Hz  amp ${fmtNum(s.amp)} nAm`, `  coupling ${fmtNum(s.coupling, 3)}  lag ${fmtNum(s.lag * 1000)} ms`);
      } else if (s.type === 'alpha') {
        L.push(`  amp ${fmtNum(s.amp)} nAm  freq ${fmtNum(s.freq)} Hz  bandwidth ${fmtNum(s.bandwidth)} Hz  depth ${fmtNum(s.depth, 3)} cm`);
        L.push(`  closed ${fmtNum(s.closed * 100)}%  open ${fmtNum(s.open * 100)}%${s.erd ? '  erd ' + fmtNum(s.erd * 100) + '%' : ''}`);
      } else if (s.type === 'erp') {
        L.push(geomText(s, '  '), `  amp ${fmtNum(s.amp)} nAm${s.jitter ? '  jitter ' + fmtNum(s.jitter * 1000) + ' ms' : ''}`);
        s.peaks.forEach(p => L.push(`  peak ${fmtNum(p.latency * 1000)} ms ${fmtNum(p.width * 1000)} ms ${fmtNum(p.gain)}`));
        s.conditions.forEach(c => L.push(`  condition ${c.name} ${fmtNum(c.gain)}`));
      } else if (s.type === 'spike') {
        L.push(geomText(s, '  '), `  amp ${fmtNum(s.amp)} nAm  rate ${fmtNum(s.rate)} Hz  width ${fmtNum(s.width * 1000)} ms  wave ${fmtNum(s.wave * 100)}%`);
      }
      L.push('}', '');
    });
    L.push('timeline {');
    cfg.timeline.segments.forEach(s => {
      if (s.kind === 'block') L.push(`  block ${s.state} ${fmtNum(s.dur)} s`);
      else {
        L.push(`  trials ${s.n} isi ${fmtNum(s.isi)} s${s.jitter ? ' jitter ' + fmtNum(s.jitter) + ' s' : ''} {`);
        s.conditions.forEach(c => L.push(`    condition ${c.name} ${fmtNum(c.p * 100, 3)}%`));
        if (s.order !== 'random') L.push(`    order ${s.order}`);
        L.push('  }');
      }
    });
    L.push('}', '');
    const a = cfg.artifacts, list = [];
    Object.keys(a).forEach(k => {
      const A = a[k], declared = cfg.declared && cfg.declared.artifacts.includes(k);
      if (!A.on && !declared) return;
      let s = '  ' + k;
      if (k === 'bad') s += ` ${A.label} ${fmtNum(A.impedance)} kOhm`;
      else {
        if (A.rate !== undefined) s += k === 'cardiac' ? ` ${fmtNum(A.rate * 60)} bpm` : ` ${fmtNum(A.rate)} Hz`;
        if (A.amp !== undefined) s += k === 'line' ? ` ${fmtNum(A.amp / 1e3)} mV` : ` ${fmtNum(A.amp)} uV`;
      }
      if (!A.on) s += ' off';
      list.push(s);
    });
    if (list.length) L.push('artifacts {', ...list, '}', '');
    const an = cfg.analysis;
    const parts = [`reference ${an.reference}`];
    if (an.hp) parts.push(`highpass ${fmtNum(an.hp)} Hz`);
    if (an.lp) parts.push(`lowpass ${fmtNum(an.lp)} Hz`);
    if (an.notch) parts.push(`notch ${fmtNum(an.notch)} Hz`);
    if (an.order !== 4) parts.push(`order ${an.order}`);
    if (an.phase !== 'zero') parts.push(`phase ${an.phase}`);
    parts.push(`epoch ${fmtNum(an.epoch[0] * 1000)} ${fmtNum(an.epoch[1] * 1000)} ms`);
    parts.push(an.baseline ? `baseline ${fmtNum(an.baseline[0] * 1000)} ${fmtNum(an.baseline[1] * 1000)} ms` : 'baseline off');
    if (an.reject) parts.push(`reject ${fmtNum(an.reject)} uV`);
    if (an.ica !== 20) parts.push(an.ica ? `ica ${an.ica}` : 'ica off');
    L.push('analysis {', ...parts.map(p => '  ' + p), '}');
    return L.join('\n') + '\n';
  }

  /* ---------- syntax highlighting for the editor ---------- */
  const ALL_KW = new Set([].concat(...Object.values(SCHEMA)));
  const VALUE_WORDS = new Set(['radial', 'tangential', 'inward', 'outward', 'closed', 'open', 'sine', 'burst', 'pink', 'off', 'on',
    'isi', 'jitter', 'random', 'alternate', 'sequence', 'zero', 'causal', 'average', 'mastoids', 'linked', 'online', 'bipolar',
    'transverse', 'laplacian', 'dipole', 'pair', 'alpha', 'erp', 'spike', 'homogeneous']);
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(src) {
    const re = /(#[^\n]*)|("[^"\n]*"?)|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?)|(S\/m\b|[A-Za-zµΩ_][A-Za-z0-9_µΩ]*)|([{}])/g;
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
        else if (EEG.ELEC[w] || EEG.ALIAS[w]) out += `<span class="tk-elec">${s}</span>`;
        else if (VALUE_WORDS.has(w)) out += `<span class="tk-val">${s}</span>`;
        else out += s;
      } else out += `<span class="tk-br">${s}</span>`;
      last = re.lastIndex;
    }
    return out + escapeHtml(src.slice(last)) + '\n';
  }

  EEG.dsl = { lex, parse, compile, build, serialize, highlight, DSLError, UNITS };
})(typeof window !== 'undefined' ? window : globalThis);
