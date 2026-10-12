/* MEG simulator: a small language for describing a recording.

   A program is a handful of blocks:

     recording { sensors planar  rate 500 Hz  highpass 0.1 Hz ... }
     shielding { room on  references off  ssp 3  sss tsss ... }
     head      { position 0 0 -1 cm }
     source <type> <name> { ... }   dipole, pair, auditory, somatosensory, alpha, spike
     timeline  { block closed 20 s  trials 120 isi 1 s { condition tone 100% } }
     artifacts { environment 50 nT  cardiac 70 bpm  dental 400 pT ... }
     analysis  { highpass 1 Hz  lowpass 40 Hz  epoch -100 400 ms ... }

   Statements are a keyword followed by values.  A value is a number with
   an optional unit, a percentage, a name or a quoted string.  The unit
   decides what a number means, so `blinks 0.2 Hz 2 pT` is a rate and an
   amplitude in either order.  Newlines are only whitespace: a statement
   ends where the next keyword of the same block begins. */
(function (G) {
  'use strict';
  const MEG = G.MEG;

  class DSLError extends Error {
    constructor(msg, line, col) { super(msg); this.line = line; this.col = col; }
  }

  /* ---------- units ---------- */
  const UNITS = {
    Hz: ['freq', 1], kHz: ['freq', 1000], bpm: ['freq', 1 / 60],
    s: ['time', 1], ms: ['time', 1e-3], us: ['time', 1e-6], min: ['time', 60],
    fT: ['field', 1], pT: ['field', 1e3], nT: ['field', 1e6], uT: ['field', 1e9], 'µT': ['field', 1e9], T: ['field', 1e15],
    'fT/cm': ['grad', 1], 'pT/cm': ['grad', 1e3],
    nAm: ['moment', 1], uAm: ['moment', 1e3], 'µAm': ['moment', 1e3],
    cm: ['length', 1], mm: ['length', 0.1], m: ['length', 100],
    deg: ['angle', 1], rad: ['angle', 180 / Math.PI]
  };
  const DIM_NAMES = {
    freq: 'a frequency (Hz)', time: 'a time (s or ms)', field: 'a magnetic field (fT, pT or nT)', grad: 'a field gradient (fT/cm)',
    moment: 'a dipole moment (nAm)', length: 'a length (cm or mm)', angle: 'an angle (deg)'
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
      if ((m = /^[fp]T\/cm\b/.exec(rest)) || (m = /^[A-Za-zµ_][A-Za-z0-9_µ]*/.exec(rest))) {
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
    top: ['recording', 'shielding', 'head', 'source', 'timeline', 'artifacts', 'analysis'],
    recording: ['sensors', 'rate', 'highpass', 'lowpass', 'mains', 'noise', 'background', 'hpi', 'seed'],
    shielding: ['room', 'references', 'ssp', 'sss', 'order', 'nulling'],
    head: ['position'],
    'source:dipole': GEOM.concat(['amp', 'signal', 'label']),
    'source:pair': ['dipole', 'rhythm', 'amp', 'coupling', 'lag', 'label'],
    'pair:dipole': GEOM.slice(),
    'source:auditory': ['side', 'amp', 'peak', 'latency', 'jitter', 'condition', 'depth', 'label'],
    'source:somatosensory': ['side', 'amp', 'peak', 'jitter', 'condition', 'beta', 'erd', 'rebound', 'depth', 'label'],
    'source:alpha': ['amp', 'freq', 'closed', 'open', 'erd', 'depth', 'bandwidth', 'label'],
    'source:spike': GEOM.concat(['amp', 'rate', 'width', 'wave', 'label']),
    timeline: ['block', 'trials', 'rest'],
    'timeline:trials': ['condition', 'order'],
    artifacts: ['environment', 'line', 'cardiac', 'blinks', 'saccades', 'muscle', 'dental', 'jumps', 'bad', 'movement'],
    analysis: ['highpass', 'lowpass', 'notch', 'order', 'phase', 'epoch', 'baseline', 'reject', 'ica', 'compensate']
  };
  const SOURCE_TYPES = ['dipole', 'pair', 'auditory', 'somatosensory', 'alpha', 'spike'];
  MEG.DSL_SCHEMA = SCHEMA;
  MEG.SOURCE_TYPES = SOURCE_TYPES;

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
    // `epoch -100 500 ms` means two times in milliseconds.
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
      if (kw.t !== 'id') err(kw.t === 'num' ? `a number cannot start a statement here; expected one of: ${allowed.join(', ')}` : `unexpected '${kw.v}'`);
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

  /* ---------- places on the head ----------
     A source can sit under a 10-10 electrode position (C3, T7, Oz) or
     under a sensor site (MLT31). */
  MEG.resolvePlace = function (name) {
    if (!name) return null;
    const lc = String(name).toLowerCase();
    const e = Object.keys(MEG.ELEC).find(k => k.toLowerCase() === lc);
    if (e) return { label: e, u: MEG.ELEC[e] };
    const al = Object.keys(MEG.ALIAS).find(k => k.toLowerCase() === lc);
    if (al) return { label: MEG.ALIAS[al], u: MEG.ELEC[MEG.ALIAS[al]] };
    const s = MEG.SITES.find(x => x.name.toLowerCase() === lc);
    if (s) return { label: s.name, u: s.u };
    return null;
  };
  MEG.placeAt = function (label, depthCm) {
    const pl = MEG.resolvePlace(label) || { u: MEG.ELEC.Cz };
    return MEG.v3.scale(pl.u, MEG.clamp(MEG.HEAD.R - depthCm, 0, MEG.HEAD.maxSourceR));
  };

  /* ---------- compiler ----------
     Turns the syntax tree into a plain configuration object, filling in
     defaults and checking every number against a sensible range.  The
     simulator never sees the text, only this object, and the serializer
     can write it back out. */
  const DEFAULTS = {
    recording: { sensors: 'mag', fs: 500, hp: 0.1, lp: null, mains: 60, noise: null, background: 150, hpi: false, seed: 1 },
    shielding: { room: true, refs: false, ssp: 0, sss: 'off', order: null, nulling: true },
    head: { position: [0, 0, 0] },
    artifacts: {
      environment: { on: false, amp: 50e6 },
      line: { on: false, amp: 100e6 },
      cardiac: { on: false, rate: 70 / 60, amp: 3000 },
      blinks: { on: false, rate: 0.2, amp: 2000 },
      saccades: { on: false, rate: 0.15, amp: 1000 },
      muscle: { on: false, rate: 0.05, amp: 1500 },
      dental: { on: false, amp: 400e3 },
      jumps: { on: false, rate: 0.02, amp: 8000 },
      bad: { on: false, label: 'MRT31', mode: 'noisy' },
      movement: { on: false, amp: 0.5 }
    },
    analysis: { hp: null, lp: null, notch: null, order: 4, phase: 'zero', epoch: [-0.1, 0.5], baseline: [-0.1, 0],
      reject: { field: null, grad: null }, ica: 20, compensate: false }
  };
  MEG.DSL_DEFAULTS = DEFAULTS;
  const SENSOR_WORDS = { mag: 'mag', mags: 'mag', magnetometer: 'mag', magnetometers: 'mag', axial: 'axial', planar: 'planar', opm: 'opm', opms: 'opm' };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function compile(prog) {
    const cfg = {
      recording: clone(DEFAULTS.recording), shielding: clone(DEFAULTS.shielding), head: clone(DEFAULTS.head), sources: [],
      timeline: null, artifacts: clone(DEFAULTS.artifacts), analysis: clone(DEFAULTS.analysis),
      warnings: [], declared: { artifacts: [], shielding: [] }
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
        if (wrong) fail(`'${wrong.v} ${wrong.unit}' is ${DIM_NAMES[UNITS[wrong.unit][0]]}, but ${st.kw} needs ${DIM_NAMES[dim]}`, wrong);
        if (opts.required) fail(`${st.kw} needs ${dim ? DIM_NAMES[dim] : 'a number'}`, st);
        return opts.def;
      }
      const x = dim === null ? v.v : numIn(v, dim, st);
      if (opts.min !== undefined && x < opts.min || opts.max !== undefined && x > opts.max) {
        const unit = opts.unit || '';
        fail(`${st.kw} must be between ${+(opts.min / (opts.scale || 1)).toPrecision(4)} and ${+(opts.max / (opts.scale || 1)).toPrecision(4)}${unit ? ' ' + unit : ''}`, v);
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
    function getPlace(st, index) {
      const ids = st.vals.filter(v => v.kind === 'id');
      const v = ids[index || 0];
      if (!v) fail(`${st.kw} needs a place on the head: a 10-10 position such as C3 or T7, or a sensor such as MLT31`, st);
      const pl = MEG.resolvePlace(v.v);
      if (!pl) fail(`'${v.v}' is not a 10-10 position or a sensor name`, v);
      return pl.label;
    }
    function frac(st, opts) {
      const v = st.vals.find(x => x.kind === 'pct' || x.kind === 'num');
      if (!v) { if (opts && opts.required) fail(`${st.kw} needs a number or a percentage`, st); return opts ? opts.def : undefined; }
      const x = v.v;
      const lo = opts && opts.min !== undefined ? opts.min : 0, hi = opts && opts.max !== undefined ? opts.max : 1;
      if (x < lo || x > hi) fail(`${st.kw} must be between ${lo} and ${hi} (or ${lo * 100}% to ${hi * 100}%)`, v);
      return x;
    }
    const isOff = st => st.vals.some(v => v.kind === 'id' && /^(off|none|no|false)$/i.test(v.v));
    const onOff = st => {
      const id = st.vals.find(v => v.kind === 'id');
      if (!id) return true;
      if (/^(off|none|no|false)$/i.test(id.v)) return false;
      if (/^(on|yes|true)$/i.test(id.v)) return true;
      fail(`${st.kw} takes on or off`, id);
    };
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
          case 'sensors': {
            const ids = st.vals.filter(v => v.kind === 'id').map(v => v.v.toLowerCase());
            if (!ids.length) fail('sensors needs a type: magnetometers, axial, planar or opm', st);
            const hit = ids.map(w => SENSOR_WORDS[w]).find(Boolean);
            if (!hit) {
              if (ids.includes('gradiometers') || ids.includes('gradiometer')) fail('say which gradiometers: axial or planar', st);
              fail('sensors must be magnetometers, axial, planar or opm', st);
            }
            r.sensors = hit; break;
          }
          case 'rate': r.fs = getNum(st, 'freq', { required: true, min: 200, max: 2000, unit: 'Hz' }); break;
          case 'highpass': r.hp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.01, max: 5, unit: 'Hz' }); break;
          case 'lowpass': r.lp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 20, max: 1000, unit: 'Hz' }); break;
          case 'mains': {
            const f = getNum(st, 'freq', { required: true });
            if (f !== 50 && f !== 60) fail('mains must be 50 Hz or 60 Hz', st);
            r.mains = f; break;
          }
          case 'noise': r.noise = getNum(st, 'field', { required: true, min: 0.3, max: 200, unit: 'fT (per root hertz)' }); break;
          case 'background': r.background = isOff(st) ? 0 : getNum(st, 'field', { required: true, min: 0, max: 3000, unit: 'fT' }); break;
          case 'hpi': r.hpi = onOff(st); break;
          case 'seed': r.seed = Math.round(getNum(st, null, { required: true })); break;
        }
      });
      if (r.lp === null) r.lp = Math.round(r.fs * 0.3);
    }

    function shielding(stmts) {
      const s = cfg.shielding;
      stmts.forEach(st => {
        once('shielding', st);
        cfg.declared.shielding.push(st.kw);
        switch (st.kw) {
          case 'room': s.room = onOff(st); break;
          case 'references': s.refs = onOff(st); break;
          case 'nulling': s.nulling = onOff(st); break;
          case 'ssp': s.ssp = isOff(st) ? 0 : Math.round(getNum(st, null, { required: true, min: 0, max: 8 })); break;
          case 'sss': {
            const id = st.vals.find(v => v.kind === 'id');
            if (!id) fail('sss takes on, off or tsss', st);
            const k = id.v.toLowerCase();
            if (k === 'on' || k === 'sss') s.sss = 'sss';
            else if (k === 'tsss' || k === 'temporal') s.sss = 'tsss';
            else if (/^(off|none|no)$/.test(k)) s.sss = 'off';
            else fail('sss takes on, off or tsss', id);
            break;
          }
          case 'order': {
            const a = getNum(st, null, { required: true, index: 0, min: 2, max: 11 }), b = getNum(st, null, { def: 3, index: 1, min: 1, max: 5 });
            s.order = [Math.round(a), Math.round(b)]; break;
          }
        }
      });
    }

    function head(stmts) {
      stmts.forEach(st => {
        once('head', st);
        const ns = st.vals.filter(v => v.kind === 'num');
        if (ns.length !== 3) fail('position needs three numbers: x y z cm (x right, y forward, z up)', st);
        const p = ns.map(v => numIn(v, 'length', st));
        if (MEG.v3.norm(p) > 2) fail('position can move the head at most 2 cm from the centre of the helmet', st);
        if (MEG.v3.norm(p) > 1.2) warn('the head is more than 1.2 cm off centre; real heads that far from the helmet lose a lot of signal', st);
        cfg.head.position = p;
      });
    }

    function geometry(stmts, defaults) {
      const g = Object.assign({ at: 'Cz', depth: 2, tilt: 90, dir: 0, toward: null, pos: null }, defaults || {});
      let posGiven = false;
      stmts.forEach(st => {
        switch (st.kw) {
          case 'at': g.at = getPlace(st); break;
          case 'depth': g.depth = getNum(st, 'length', { required: true, min: 1.3, max: 9.2, unit: 'cm' }); break;
          case 'pos': {
            const ns = st.vals.filter(v => v.kind === 'num');
            if (ns.length !== 3) fail('pos needs three coordinates: x y z cm (x right, y forward, z up)', st);
            g.pos = ns.map(v => numIn(v, 'length', st));
            if (MEG.v3.norm(g.pos) > MEG.HEAD.maxSourceR) fail(`pos must lie inside the brain, within ${MEG.HEAD.maxSourceR} cm of the centre`, st);
            posGiven = true; break;
          }
          case 'orient': {
            const id = st.vals.find(v => v.kind === 'id');
            if (id) {
              const k = id.v.toLowerCase();
              if (k === 'radial' || k === 'outward') g.tilt = 0;
              else if (k === 'tangential') g.tilt = 90;
              else if (k === 'inward') g.tilt = 180;
              else fail('orient takes radial, tangential, inward or an angle from radial in degrees', id);
            } else g.tilt = getNum(st, 'angle', { required: true, min: 0, max: 180, unit: 'deg' });
            break;
          }
          case 'toward': g.toward = getPlace(st); break;
          case 'dir': g.dir = getNum(st, 'angle', { required: true, min: -360, max: 360, unit: 'deg' }); g.toward = null; break;
        }
      });
      if (!posGiven) g.pos = MEG.placeAt(g.at, g.depth);
      else { g.at = null; g.depth = MEG.depthOf(g.pos); }
      const towardEl = g.toward && MEG.ELEC[g.toward] ? g.toward : null;
      if (g.toward && !towardEl) {
        // toward a sensor site: aim the tangential part at it
        const s = MEG.resolvePlace(g.toward), tf = MEG.tangentFrame(g.pos);
        const d = MEG.v3.sub(MEG.v3.scale(s.u, MEG.HEAD.R), g.pos);
        const tang = MEG.v3.sub(d, MEG.v3.scale(tf.rh, MEG.v3.dot(d, tf.rh)));
        g.dir = Math.atan2(MEG.v3.dot(tang, tf.t2), MEG.v3.dot(tang, tf.t1)) * 180 / Math.PI;
      }
      g.ori = MEG.orientation(g.pos, g.tilt, g.dir, towardEl);
      return g;
    }

    function peaksOf(stmts) {
      return stmts.filter(x => x.kw === 'peak').map(pk => {
        const ns = pk.vals.filter(v => v.kind === 'num');
        if (ns.length < 2) fail('peak needs a latency, a width and optionally a gain: peak 100 ms 35 ms 1', pk);
        const lat = numIn(ns[0], 'time', pk), wid = numIn(ns[1], 'time', pk);
        if (lat < 0 || lat > 2) fail('peak latency must be between 0 and 2000 ms', ns[0]);
        if (wid < 0.002 || wid > 1) fail('peak width must be between 2 and 1000 ms', ns[1]);
        return { latency: lat, width: wid, gain: ns[2] ? ns[2].v : 1 };
      });
    }
    function conditionsOf(stmts) {
      return stmts.filter(x => x.kw === 'condition').map(c => {
        const nm = c.vals.find(v => v.kind === 'id' || v.kind === 'str');
        if (!nm) fail('condition needs a name and a gain: condition tone 1', c);
        const g = c.vals.find(v => v.kind === 'num' || v.kind === 'pct');
        return { name: nm.v, gain: g ? g.v : 1 };
      });
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
      stmts.forEach(x => { if (!['peak', 'condition', 'dipole'].includes(x.kw)) once('source ' + name, x); });
      const amp = last('amp');
      if (type === 'dipole') {
        Object.assign(s, geometry(stmts));
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -2000, max: 2000, unit: 'nAm' }) : 20;
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
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: 0, max: 2000, unit: 'nAm' }) : 20;
        const cp = last('coupling'); s.coupling = cp ? frac(cp, { required: true }) : 0.5;
        const lg = last('lag'); s.lag = lg ? getNum(lg, 'time', { required: true, min: -0.2, max: 0.2, scale: 1e-3, unit: 'ms' }) : 0;
      } else if (type === 'auditory' || type === 'somatosensory') {
        const sd = last('side');
        const sides = type === 'auditory' ? ['both', 'left', 'right'] : ['left', 'right'];
        s.side = sd ? getId(sd, { required: true, oneOf: sides }) : sides[0];
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -2000, max: 2000, unit: 'nAm' }) : (type === 'auditory' ? 30 : 20);
        s.peaks = peaksOf(stmts);
        const defPeaks = type === 'auditory'
          ? [{ latency: 0.05, width: 0.025, gain: -0.35 }, { latency: 0.1, width: 0.035, gain: 1 }, { latency: 0.18, width: 0.06, gain: -0.45 }]
          : [{ latency: 0.02, width: 0.006, gain: 1 }, { latency: 0.032, width: 0.01, gain: -0.6 }, { latency: 0.06, width: 0.03, gain: 0.35 }];
        if (!s.peaks.length) s.peaks = defPeaks;
        const lat = last('latency');
        if (lat) {
          const L = getNum(lat, 'time', { required: true, min: 0.03, max: 0.4, scale: 1e-3, unit: 'ms' });
          const main = s.peaks.reduce((a, b) => (Math.abs(b.gain) > Math.abs(a.gain) ? b : a));
          const shift = L - main.latency;
          s.peaks = s.peaks.map(p => Object.assign({}, p, { latency: Math.max(0.005, p.latency + shift) }));
        }
        const j = last('jitter'); s.jitter = j ? getNum(j, 'time', { required: true, min: 0, max: 0.1, scale: 1e-3, unit: 'ms' }) : (type === 'auditory' ? 0.008 : 0.001);
        s.conditions = conditionsOf(stmts);
        const dp = last('depth'); s.depth = dp ? getNum(dp, 'length', { required: true, min: 1.5, max: 6, unit: 'cm' }) : MEG.GEN_DEPTH[type];
        if (type === 'somatosensory') {
          const b = last('beta');
          s.beta = null;
          if (b && !isOff(b)) {
            s.beta = { freq: getNum(b, 'freq', { def: 20, min: 12, max: 35, unit: 'Hz' }), amp: getNum(b, 'moment', { def: 15, min: 0, max: 500, unit: 'nAm' }) };
            const e = last('erd'); s.beta.erd = e ? frac(e, { required: true }) : 0.6;
            const rb = last('rebound'); s.beta.rebound = rb ? frac(rb, { required: true, max: 3 }) : 1.2;
          }
        }
        s.dipoles = MEG.evokedDipoles(s);
      } else if (type === 'alpha') {
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: 0, max: 2000, unit: 'nAm' }) : 40;
        const f = last('freq'); s.freq = f ? getNum(f, 'freq', { required: true, min: 6, max: 14, unit: 'Hz' }) : 10;
        const bw = last('bandwidth'); s.bandwidth = bw ? getNum(bw, 'freq', { required: true, min: 0.2, max: 4, unit: 'Hz' }) : 1.5;
        const c = last('closed'); s.closed = c ? frac(c, { required: true, max: 2 }) : 1;
        const o = last('open'); s.open = o ? frac(o, { required: true, max: 2 }) : 0.2;
        const e = last('erd'); s.erd = e ? frac(e, { required: true }) : 0;
        const d = last('depth'); s.depth = d ? getNum(d, 'length', { required: true, min: 1.5, max: 6, unit: 'cm' }) : MEG.GEN_DEPTH.alpha;
        s.dipoles = MEG.alphaDipoles(s.depth);
      } else if (type === 'spike') {
        Object.assign(s, geometry(stmts));
        s.amp = amp ? getNum(amp, 'moment', { required: true, min: -5000, max: 5000, unit: 'nAm' }) : 300;
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
          const state = getId(st, { required: true, oneOf: ['closed', 'open', 'rest'] });
          segs.push({ kind: 'block', state: state === 'rest' ? 'open' : state, dur: getNum(st, 'time', { required: true, min: 1, max: 600, unit: 's' }) });
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
              if (!nm) fail('condition needs a name and a share: condition deviant 20%', b);
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
      const limits = {
        environment: { field: [0, 5e9] }, line: { field: [0, 5e9] },
        cardiac: { freq: [0.5, 3.5], field: [0, 1e6] }, blinks: { freq: [0.01, 2], field: [0, 1e6] },
        saccades: { freq: [0.01, 2], field: [0, 1e6] }, muscle: { freq: [0.005, 2], field: [0, 1e6] },
        dental: { field: [0, 5e7] }, jumps: { freq: [0.001, 1], field: [0, 1e7] }
      };
      stmts.forEach(st => {
        once('artifacts', st);
        const k = st.kw, A = a[k];
        cfg.declared.artifacts.push(k);
        A.on = !isOff(st);
        if (k === 'bad') {
          const ids = st.vals.filter(v => v.kind === 'id' && !/^(off|on)$/i.test(v.v));
          ids.forEach(id => {
            const w = id.v.toLowerCase();
            if (['noisy', 'flat', 'jumpy'].includes(w)) A.mode = w;
            else {
              const s = MEG.SITES.find(x => x.name.toLowerCase() === w || x.name.toLowerCase() + 'a' === w || x.name.toLowerCase() + 'b' === w);
              if (!s) fail(`'${id.v}' is not a sensor name; sensors are named like MLT31 or MRF22`, id);
              A.label = s.name;
            }
          });
          checkUnits(st, []);
          return;
        }
        if (k === 'movement') {
          checkUnits(st, ['length']);
          A.amp = getNum(st, 'length', { def: A.amp, min: 0, max: 3, unit: 'cm' });
          return;
        }
        const lim = limits[k];
        checkUnits(st, Object.keys(lim));
        unitNums(st).forEach(v => {
          const d = UNITS[v.unit][0], x = v.v * UNITS[v.unit][1];
          const [lo, hi] = lim[d];
          if (x < lo || x > hi) fail(`${k} ${d === 'freq' ? 'rate' : 'amplitude'} is out of range`, v);
          if (d === 'freq') A.rate = x; else A.amp = x;
        });
        if (st.vals.some(v => v.kind === 'num' && !v.unit)) fail(`give ${k} its numbers with units, such as 0.2 Hz or 2 pT`, st);
      });
    }

    function analysis(stmts) {
      const an = cfg.analysis;
      stmts.forEach(st => {
        once('analysis', st);
        switch (st.kw) {
          case 'highpass': an.hp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 0.01, max: 20, unit: 'Hz' }); break;
          case 'lowpass': an.lp = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 1, max: 500, unit: 'Hz' }); break;
          case 'notch': an.notch = isOff(st) ? null : getNum(st, 'freq', { required: true, min: 40, max: 70, unit: 'Hz' }); break;
          case 'order': an.order = Math.round(getNum(st, null, { required: true, min: 1, max: 8 })); break;
          case 'phase': an.phase = getId(st, { required: true, oneOf: ['zero', 'causal'] }); break;
          case 'epoch': {
            const t0 = getNum(st, 'time', { required: true, index: 0 }), t1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(t0 < 0 && t1 > 0 && t1 - t0 <= 4)) fail('epoch needs a start before 0 and an end after 0, at most 4 s apart: epoch -100 500 ms', st);
            an.epoch = [t0, t1]; break;
          }
          case 'baseline': {
            if (isOff(st)) { an.baseline = null; break; }
            const b0 = getNum(st, 'time', { required: true, index: 0 }), b1 = getNum(st, 'time', { required: true, index: 1 });
            if (!(b1 > b0)) fail('baseline needs a start and a later end: baseline -100 0 ms', st);
            an.baseline = [b0, b1]; break;
          }
          case 'reject': {
            if (isOff(st)) { an.reject = { field: null, grad: null }; break; }
            checkUnits(st, ['field', 'grad']);
            const f = st.vals.find(v => v.kind === 'num' && v.unit && UNITS[v.unit][0] === 'field');
            const g = st.vals.find(v => v.kind === 'num' && v.unit && UNITS[v.unit][0] === 'grad');
            if (!f && !g) fail('reject needs a peak-to-peak threshold with a unit: reject 4 pT, or reject 1500 fT/cm for planar gradiometers', st);
            if (f) an.reject.field = f.v * UNITS[f.unit][1];
            if (g) an.reject.grad = g.v * UNITS[g.unit][1];
            break;
          }
          case 'ica': an.ica = isOff(st) ? 0 : Math.round(getNum(st, null, { required: true, min: 2, max: 80 })); break;
          case 'compensate': an.compensate = onOff(st); break;
        }
      });
    }

    prog.forEach(st => {
      if (st.kw === 'source') { source(st); return; }
      if (seen['top.' + st.kw]) fail(`there can only be one ${st.kw} block`, st);
      seen['top.' + st.kw] = true;
      ({ recording, shielding, head, timeline, artifacts, analysis })[st.kw](st.block);
    });

    // Cross-checks that need more than one block
    const r = cfg.recording, sh = cfg.shielding;
    if (!cfg.timeline) cfg.timeline = { segments: [{ kind: 'block', state: 'open', dur: 60 }] };
    if (r.lp && r.lp >= r.fs / 2) cfg.warnings.push({ msg: `the online low-pass (${r.lp} Hz) is at or above the Nyquist frequency (${r.fs / 2} Hz): nothing stops aliasing`, line: 0 });
    if (cfg.analysis.lp && cfg.analysis.lp >= r.fs / 2) cfg.analysis.lp = null;
    if (r.sensors === 'opm' && !sh.room) cfg.warnings.push({ msg: 'OPMs cannot work in the Earth’s field: without the shielded room every one of them saturates', line: 0 });
    if (r.sensors !== 'opm' && cfg.declared.shielding.includes('nulling')) cfg.warnings.push({ msg: 'nulling coils only matter for OPMs; SQUID sensors are fixed in the dewar', line: 0 });
    if (sh.sss !== 'off' && r.sensors !== 'planar') cfg.warnings.push({ msg: 'SSS needs the 306-style array (sensors planar), which measures the field and its gradient at every site; with this array inside and outside sources look alike, so SSS is skipped', line: 0 });
    if (sh.sss !== 'off' && sh.ssp) cfg.warnings.push({ msg: 'SSP after SSS is unusual: SSS already removes what the empty-room projectors would', line: 0 });
    if (cfg.analysis.compensate && r.sensors === 'opm') cfg.warnings.push({ msg: 'OPMs move with the head, so there is no head movement to compensate', line: 0 });
    else if (cfg.analysis.compensate && r.sensors !== 'planar') cfg.warnings.push({ msg: 'movement compensation works through SSS, which needs the 306-style array (sensors planar)', line: 0 });
    else if (cfg.analysis.compensate && sh.sss === 'off') cfg.warnings.push({ msg: 'movement compensation works through the SSS expansion, so it runs SSS as well', line: 0 });
    const condNames = new Set();
    cfg.timeline.segments.forEach(s => { if (s.kind === 'trials') s.conditions.forEach(c => condNames.add(c.name)); });
    cfg.sources.forEach(s => {
      if (s.type === 'auditory' || s.type === 'somatosensory') {
        if (!condNames.size) cfg.warnings.push({ msg: `${s.type} source ${s.name} has no stimuli to respond to; add a trials block to the timeline`, line: 0 });
        s.conditions.forEach(c => { if (condNames.size && !condNames.has(c.name)) cfg.warnings.push({ msg: `${s.type} source ${s.name} responds to '${c.name}', which no trials block uses`, line: 0 }); });
      }
    });
    // Size check: the page holds the whole recording in memory several times
    const dur = cfg.timeline.segments.reduce((a, s) => a + (s.kind === 'trials' ? 1.5 + s.n * (s.isi + s.jitter / 2) : s.dur), 0);
    const nrow = (r.sensors === 'planar' ? 3 : 1) * MEG.SITES.length + 9;
    if (dur * r.fs * nrow > 1.4e7) throw new DSLError(`that recording is about ${Math.round(dur)} s at ${r.fs} Hz on ${nrow} channels, ` +
      `${(dur * r.fs * nrow / 1e6).toFixed(1)} million samples; this page holds up to 14 million. Shorten the timeline, lower the rate or use an array with one sensor per site.`, 1, 1);
    return cfg;
  }

  function build(src) { return compile(parse(src)); }

  /* ---------- serializer ----------
     Writes a configuration back out as a program, for when the controls
     have moved things and the text should catch up.  Comments are lost. */
  function fmtNum(x, digits) {
    if (x === null || x === undefined) return 'off';
    const d = digits === undefined ? 4 : digits;
    return String(Number(Number(x).toPrecision(d)));
  }
  function fmtField(fT) {
    const a = Math.abs(fT);
    if (a >= 1e6) return fmtNum(fT / 1e6) + ' nT';
    if (a >= 1e3) return fmtNum(fT / 1e3) + ' pT';
    return fmtNum(fT) + ' fT';
  }
  function geomText(g, indent) {
    const out = [];
    const pos0 = g.at ? MEG.placeAt(g.at, g.depth) : null;
    if (g.at && pos0 && MEG.v3.norm(MEG.v3.sub(pos0, g.pos)) < 0.05) out.push(`at ${g.at} depth ${fmtNum(g.depth, 3)} cm`);
    else out.push(`pos ${g.pos.map(x => fmtNum(x, 3)).join(' ')} cm`);
    const ang = MEG.orientationAngles(g.pos, g.ori);
    const tilt = Math.round(ang.tilt);
    if (tilt === 0) out.push('orient radial');
    else if (tilt === 180) out.push('orient inward');
    else out.push(`orient ${tilt === 90 ? 'tangential' : tilt + ' deg'} dir ${Math.round(ang.dir)} deg`);
    return indent + out.join('  ');
  }
  const SENSOR_TEXT = { mag: 'magnetometers', axial: 'axial', planar: 'planar', opm: 'opm' };
  function serialize(cfg, title) {
    const L = [];
    if (title) L.push('# ' + title, '');
    const r = cfg.recording, D = DEFAULTS.recording;
    L.push('recording {', `  sensors ${SENSOR_TEXT[r.sensors]}`, `  rate ${fmtNum(r.fs)} Hz`);
    L.push(`  highpass ${r.hp === null ? 'off' : fmtNum(r.hp) + ' Hz'}`, `  lowpass ${r.lp === null ? 'off' : fmtNum(r.lp) + ' Hz'}`, `  mains ${r.mains} Hz`);
    if (r.noise !== null && r.noise !== D.noise) L.push(`  noise ${fmtNum(r.noise)} fT`);
    if (r.background !== D.background) L.push(`  background ${r.background ? fmtField(r.background) : 'off'}`);
    if (r.hpi) L.push('  hpi on');
    if (r.seed !== D.seed) L.push(`  seed ${r.seed}`);
    L.push('}', '');
    const s = cfg.shielding;
    const sp = [`room ${s.room ? 'on' : 'off'}`, `references ${s.refs ? 'on' : 'off'}`, `ssp ${s.ssp || 'off'}`, `sss ${s.sss === 'tsss' ? 'tsss' : s.sss === 'sss' ? 'on' : 'off'}`];
    if (s.order) sp.push(`order ${s.order[0]} ${s.order[1]}`);
    if (r.sensors === 'opm') sp.push(`nulling ${s.nulling ? 'on' : 'off'}`);
    L.push('shielding {', ...sp.map(x => '  ' + x), '}', '');
    const hp = cfg.head.position;
    if (hp.some(x => Math.abs(x) > 1e-9)) L.push(`head { position ${hp.map(x => fmtNum(x, 3)).join(' ')} cm }`, '');
    cfg.sources.forEach(src => {
      const nm = /^[A-Za-z_][A-Za-z0-9_]*$/.test(src.name) ? src.name : `"${src.name}"`;
      L.push(`source ${src.type} ${nm} {`);
      if (src.type === 'dipole') {
        L.push(geomText(src, '  '), `  amp ${fmtNum(src.amp)} nAm`, `  signal ${src.signal}${src.signal !== 'pink' ? ' ' + fmtNum(src.freq) + ' Hz' : ''}`);
      } else if (src.type === 'pair') {
        src.dipoles.forEach(d => L.push(`  dipole ${d.name} { ${geomText(d, '').trim()} }`));
        L.push(`  rhythm ${fmtNum(src.freq)} Hz  amp ${fmtNum(src.amp)} nAm`, `  coupling ${fmtNum(src.coupling, 3)}  lag ${fmtNum(src.lag * 1000)} ms`);
      } else if (src.type === 'auditory' || src.type === 'somatosensory') {
        L.push(`  side ${src.side}  amp ${fmtNum(src.amp)} nAm  depth ${fmtNum(src.depth, 3)} cm  jitter ${fmtNum(src.jitter * 1000)} ms`);
        src.peaks.forEach(p => L.push(`  peak ${fmtNum(p.latency * 1000)} ms ${fmtNum(p.width * 1000)} ms ${fmtNum(p.gain)}`));
        src.conditions.forEach(c => L.push(`  condition ${c.name} ${fmtNum(c.gain)}`));
        if (src.beta) L.push(`  beta ${fmtNum(src.beta.freq)} Hz ${fmtNum(src.beta.amp)} nAm  erd ${fmtNum(src.beta.erd * 100)}%  rebound ${fmtNum(src.beta.rebound * 100)}%`);
      } else if (src.type === 'alpha') {
        L.push(`  amp ${fmtNum(src.amp)} nAm  freq ${fmtNum(src.freq)} Hz  bandwidth ${fmtNum(src.bandwidth)} Hz  depth ${fmtNum(src.depth, 3)} cm`);
        L.push(`  closed ${fmtNum(src.closed * 100)}%  open ${fmtNum(src.open * 100)}%${src.erd ? '  erd ' + fmtNum(src.erd * 100) + '%' : ''}`);
      } else if (src.type === 'spike') {
        L.push(geomText(src, '  '), `  amp ${fmtNum(src.amp)} nAm  rate ${fmtNum(src.rate)} Hz  width ${fmtNum(src.width * 1000)} ms  wave ${fmtNum(src.wave * 100)}%`);
      }
      L.push('}', '');
    });
    L.push('timeline {');
    cfg.timeline.segments.forEach(seg => {
      if (seg.kind === 'block') L.push(`  block ${seg.state} ${fmtNum(seg.dur)} s`);
      else {
        L.push(`  trials ${seg.n} isi ${fmtNum(seg.isi)} s${seg.jitter ? ' jitter ' + fmtNum(seg.jitter) + ' s' : ''} {`);
        seg.conditions.forEach(c => L.push(`    condition ${c.name} ${fmtNum(c.p * 100, 3)}%`));
        if (seg.order !== 'random') L.push(`    order ${seg.order}`);
        L.push('  }');
      }
    });
    L.push('}', '');
    const a = cfg.artifacts, list = [];
    Object.keys(a).forEach(k => {
      const A = a[k], declared = cfg.declared && cfg.declared.artifacts.includes(k);
      if (!A.on && !declared) return;
      let t = '  ' + k;
      if (k === 'bad') t += ` ${A.label} ${A.mode}`;
      else if (k === 'movement') t += ` ${fmtNum(A.amp * 10)} mm`;
      else {
        if (A.rate !== undefined) t += k === 'cardiac' ? ` ${fmtNum(A.rate * 60)} bpm` : ` ${fmtNum(A.rate)} Hz`;
        if (A.amp !== undefined) t += ' ' + fmtField(A.amp);
      }
      if (!A.on) t += ' off';
      list.push(t);
    });
    if (list.length) L.push('artifacts {', ...list, '}', '');
    const an = cfg.analysis, parts = [];
    if (an.hp) parts.push(`highpass ${fmtNum(an.hp)} Hz`);
    if (an.lp) parts.push(`lowpass ${fmtNum(an.lp)} Hz`);
    if (an.notch) parts.push(`notch ${fmtNum(an.notch)} Hz`);
    if (an.order !== 4) parts.push(`order ${an.order}`);
    if (an.phase !== 'zero') parts.push(`phase ${an.phase}`);
    parts.push(`epoch ${fmtNum(an.epoch[0] * 1000)} ${fmtNum(an.epoch[1] * 1000)} ms`);
    parts.push(an.baseline ? `baseline ${fmtNum(an.baseline[0] * 1000)} ${fmtNum(an.baseline[1] * 1000)} ms` : 'baseline off');
    if (an.reject.field || an.reject.grad) parts.push(`reject${an.reject.field ? ' ' + fmtField(an.reject.field) : ''}${an.reject.grad ? ' ' + fmtNum(an.reject.grad) + ' fT/cm' : ''}`);
    if (an.ica !== 20) parts.push(an.ica ? `ica ${an.ica}` : 'ica off');
    if (an.compensate) parts.push('compensate on');
    L.push('analysis {', ...parts.map(p => '  ' + p), '}');
    return L.join('\n') + '\n';
  }

  /* ---------- syntax highlighting for the editor ---------- */
  const ALL_KW = new Set([].concat(...Object.values(SCHEMA)));
  const VALUE_WORDS = new Set(['radial', 'tangential', 'inward', 'outward', 'closed', 'open', 'rest', 'sine', 'burst', 'pink', 'off', 'on',
    'isi', 'jitter', 'random', 'alternate', 'sequence', 'zero', 'causal', 'both', 'left', 'right', 'tsss', 'noisy', 'flat', 'jumpy',
    'magnetometers', 'magnetometer', 'mag', 'axial', 'planar', 'opm', 'opms', 'gradiometers'].concat(SOURCE_TYPES));
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlight(src) {
    const re = /(#[^\n]*)|("[^"\n]*"?)|([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?)|([fp]T\/cm\b|[A-Za-zµ_][A-Za-z0-9_µ]*)|([{}])/g;
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
        else if (MEG.ELEC[w] || MEG.ALIAS[w] || /^M[LRZ][FCTPO]\d\d[ab]?$/.test(w)) out += `<span class="tk-elec">${s}</span>`;
        else if (VALUE_WORDS.has(w)) out += `<span class="tk-val">${s}</span>`;
        else out += s;
      } else out += `<span class="tk-br">${s}</span>`;
      last = re.lastIndex;
    }
    return out + escapeHtml(src.slice(last)) + '\n';
  }

  MEG.dsl = { lex, parse, compile, build, serialize, highlight, DSLError, UNITS, fmtField };
})(typeof window !== 'undefined' ? window : globalThis);
