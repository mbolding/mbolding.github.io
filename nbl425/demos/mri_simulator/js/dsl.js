/* ============================================================
   MRI Simulator: the pulse-sequence language
   A small language in which students write pulse sequences, and
   the compiler that turns a program into an absolute-time list of
   RF pulses, gradient trapezoids and ADC windows (a SeqProgram,
   see ARCHITECTURE.md section 8).

   The pipeline is the classic one:
     lex      source text -> tokens (numbers carry their units)
     parse    tokens -> a syntax tree, once
     execute  walk the tree, unrolling loops, placing every block
              on the time axis and checking the hardware limits
   Loop bodies are parsed once and executed many times, which is
   what keeps a 256-line spin echo well under a millisecond per TR.

   Every value carries a physical kind (time, length, frequency...)
   so that "TE/2 + 1" is caught with a helpful message instead of
   silently meaning one second. Units are part of the lesson.

   Nothing here touches the DOM; tests/test_dsl.js runs it in Node.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    const C = MRI.const;
    const U = MRI.util;

    const GB = C.GAMMA_BAR;            // Hz/T
    const GMAX = C.GMAX;               // T/m
    const SLEW = C.SLEW;               // T/m/s
    const RINV = Math.round(1 / C.GRAD_RASTER);   // gradient raster steps per second (1e5)
    const MAX_BLOCKS = 20000;
    const MAX_ADC = 8192;
    const MAX_ITER = 2000000;          // loop passes, guards loops with empty bodies

    /* ---------- Kinds (physical dimensions) ----------
       Kinds are small integers internally and strings in the output. */
    const NONE = 0, TIME = 1, LENGTH = 2, ANGLE = 3, FREQ = 4, GRAD = 5, SLEWK = 6, PPM = 7, MIXED = 8;
    const KIND_NAME = ['none', 'time', 'length', 'angle', 'freq', 'grad', 'slew', 'ppm', 'mixed'];
    const KIND_PHRASE = ['a plain number', 'a time', 'a length', 'an angle', 'a frequency',
        'a gradient strength', 'a slew rate', 'a ppm value', 'a mixed-unit value'];
    // Display unit used when an expression has no unit literal of its own.
    const KIND_UNIT = [{ u: '', s: 1 }, { u: 'ms', s: 1e-3 }, { u: 'mm', s: 1e-3 }, { u: 'deg', s: 1 },
        { u: 'Hz', s: 1 }, { u: 'mT/m', s: 1e-3 }, { u: 'T/m/s', s: 1 }, { u: 'ppm', s: 1 }, { u: '', s: 1 }];

    /* Units: [kind, SI per unit]. Angles are stored in degrees (the one
       non-SI internal unit, as everywhere in the simulator), so rad
       converts to degrees. Hz/px is just Hz; the "per pixel" is a
       reminder of what the bandwidth statement means. */
    const UNITS = {
        's': [TIME, 1], 'ms': [TIME, 1e-3], 'us': [TIME, 1e-6], 'µs': [TIME, 1e-6], 'μs': [TIME, 1e-6],
        'mm': [LENGTH, 1e-3], 'cm': [LENGTH, 1e-2],
        'deg': [ANGLE, 1], 'rad': [ANGLE, 180 / Math.PI],
        'Hz': [FREQ, 1], 'kHz': [FREQ, 1e3], 'MHz': [FREQ, 1e6], 'Hz/px': [FREQ, 1],
        'mT/m': [GRAD, 1e-3], 'T/m': [GRAD, 1],
        'T/m/s': [SLEWK, 1],
        'ppm': [PPM, 1]
    };

    const RESERVED = new Set(('sequence param let fov matrix slice bandwidth oversample averages dummies ' +
        'for in repeat every step end wait spoil rf gx gy gz adc at as range dur phase bw offset dwell ' +
        'hard sinc water fat adiabatic excite refocus invert saturate readout prephase encode rewind ' +
        'rephase crush blip').split(' '));
    const SHAPES = new Set(['hard', 'slice', 'sinc', 'water', 'fat', 'adiabatic']);
    const ROLES = new Set(['excite', 'refocus', 'invert', 'saturate']);
    const RF_OPTS = new Set(['dur', 'phase', 'bw', 'offset']);
    const SPECS = new Set(['readout', 'prephase', 'encode', 'rewind', 'rephase', 'crush', 'blip']);
    const SETTINGS = new Set(['fov', 'matrix', 'slice', 'bandwidth', 'oversample', 'averages', 'dummies']);
    const STATEMENT_WORDS = ['sequence', 'param', 'let', 'fov', 'matrix', 'slice', 'bandwidth', 'oversample',
        'averages', 'dummies', 'for', 'repeat', 'end', 'wait', 'spoil', 'rf', 'gx', 'gy', 'gz', 'adc'];
    const FUNCS = { sin: 1, cos: 1, tan: 1, sqrt: 1, abs: 1, floor: 1, ceil: 1, round: 1,
        exp: 1, log: 1, min: -1, max: -1, mod: 2 };

    /* ---------- Small helpers ---------- */
    // Times are quantised to 1 us; gradient ramps and plateaus to the 10 us raster.
    const q1 = t => Math.round(t * 1e6) / 1e6;
    const ceil1 = t => Math.ceil(t * 1e6 - 1e-6) / 1e6;
    const ceilR = t => (t <= 0 ? 0 : Math.ceil(t * RINV - 1e-6) / RINV);
    const roundR = t => Math.round(t * RINV) / RINV;
    const num = (x, sig) => String(Number(x.toPrecision(sig || 4)));
    const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

    function fmtVal(v, k) {
        switch (k) {
            case TIME: return U.fmtTime(v, 3);
            case LENGTH: return num(v * 1e3) + ' mm';
            case ANGLE: return num(v) + ' deg';
            case FREQ: return U.fmtFreq(v, 4);
            case GRAD: return num(v * 1e3, 3) + ' mT/m';
            case SLEWK: return num(v) + ' T/m/s';
            case PPM: return num(v) + ' ppm';
            case MIXED: return num(v) + ' (mixed units)';
            default: return num(v);
        }
    }
    // Times inside "too short" messages, relative to the period start.
    function fmtMs(t) {
        const ms = t * 1e3, a = Math.abs(ms);
        return (a < 10 ? ms.toFixed(2) : a < 1000 ? ms.toFixed(1) : ms.toFixed(0)) + ' ms';
    }
    // Round x up to `sig` significant figures (for "minimum TE about ...").
    function ceilSig(x, sig) {
        if (!(x > 0)) return num(x, sig);
        const f = Math.pow(10, Math.floor(Math.log10(x)) - (sig - 1));
        return String(Number((Math.ceil(x / f - 1e-9) * f).toPrecision(sig)));
    }
    function fmtParamValue(p, v) {
        const x = v / (p.scale || 1);
        let s = String(Number(x.toPrecision(6)));
        if (s === '-0') s = '0';
        return p.unit ? s + ' ' + p.unit : s;
    }

    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        let prev = new Array(n + 1), cur = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            cur[0] = i;
            for (let j = 1; j <= n; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            const t = prev; prev = cur; cur = t;
        }
        return prev[n];
    }
    // "Did you mean ...?" for typos: case differences count as a match.
    function suggest(word, cands) {
        const lw = word.toLowerCase();
        let best = null, bd = Infinity;
        for (const c of cands) {
            const d = levenshtein(lw, c.toLowerCase());
            if (d < bd) { bd = d; best = c; }
        }
        const lim = word.length <= 3 ? 1 : 2;
        return best !== null && best !== word && bd <= lim ? best : null;
    }

    /* Errors carry a source position and a hint. They are thrown inside the
       compiler and always caught by compile(), which never throws. */
    class DslError {
        constructor(msg, pos, hint, meta) {
            this.msg = msg;
            this.line = (pos && pos.line) || 1;
            this.col = (pos && pos.col) || 1;
            this.hint = hint || null;
            this.meta = meta || null;
        }
    }
    const fail = (msg, pos, hint, meta) => { throw new DslError(msg, pos, hint, meta); };

    /* ============================================================
       Lexer
       Tokens: number (with value in SI, kind and unit), string, ident,
       keyword, op, comment, newline, error. Every token records
       line, col (both 1-based), start and end (character offsets).
       A unit is recognised only straight after a number literal, with
       or without spaces, so "pi*s/spokes" still reads s as a name.
       ============================================================ */
    const NUM_RE = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    const UNIT_RE = /(T\/m\/s|mT\/m|T\/m|Hz\/px|kHz|MHz|Hz|ms|us|µs|μs|s|mm|cm|deg|rad|ppm)(?![A-Za-z0-9_])/y;
    const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
    const OPS1 = '+-*/^(),=';

    function lex(src) {
        const toks = [], n = src.length;
        let i = 0, line = 1, ls = 0;
        const push = (type, start, end, extra) => {
            const t = { type, text: src.slice(start, end), line, col: start - ls + 1, start, end };
            if (extra) Object.assign(t, extra);
            toks.push(t);
            return t;
        };
        while (i < n) {
            const c = src[i];
            if (c === '\n') { push('newline', i, i + 1); i++; line++; ls = i; continue; }
            if (c === ' ' || c === '\t' || c === '\r' || c === ' ' || c === '\f' || c === '\v') { i++; continue; }
            if (c === '#') {
                let j = i; while (j < n && src[j] !== '\n') j++;
                push('comment', i, j); i = j; continue;
            }
            if (c >= '0' && c <= '9') {
                NUM_RE.lastIndex = i;
                const m = NUM_RE.exec(src);
                const j = i + m[0].length, raw = parseFloat(m[0]);
                let k = j;
                while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
                UNIT_RE.lastIndex = k;
                const u = UNIT_RE.exec(src);
                if (u) {
                    const def = UNITS[u[1]];
                    push('number', i, k + u[0].length, { num: raw, value: raw * def[1], kind: def[0], unit: u[1], unitStart: k });
                    i = k + u[0].length;
                } else {
                    push('number', i, j, { num: raw, value: raw, kind: NONE, unit: '' });
                    i = j;
                }
                continue;
            }
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
                IDENT_RE.lastIndex = i;
                const w = IDENT_RE.exec(src)[0];
                push(RESERVED.has(w) ? 'keyword' : 'ident', i, i + w.length);
                i += w.length; continue;
            }
            if (c === '"') {
                let j = i + 1;
                while (j < n && src[j] !== '"' && src[j] !== '\n') j++;
                if (src[j] === '"') { push('string', i, j + 1, { value: src.slice(i + 1, j) }); i = j + 1; }
                else { push('error', i, j, { msg: 'This string has no closing double quote.' }); i = j; }
                continue;
            }
            if (c === '.') {
                if (src[i + 1] === '.') { push('op', i, i + 2, { op: '..' }); i += 2; continue; }
                if (src[i + 1] >= '0' && src[i + 1] <= '9') {
                    push('error', i, i + 1, { msg: 'A number cannot start with a decimal point; write 0.5, not .5.' });
                    i++; continue;
                }
            }
            if (OPS1.indexOf(c) >= 0) { push('op', i, i + 1, { op: c }); i++; continue; }
            // Typographic minus signs and the multiplication sign, as pasted from documents.
            if (c === '−' || c === '–') { push('op', i, i + 1, { op: '-' }); i++; continue; }
            if (c === '×') { push('op', i, i + 1, { op: '*' }); i++; continue; }
            push('error', i, i + 1, { msg: 'The character "' + c + '" is not part of the language.' });
            i++;
        }
        return toks;
    }

    /* ============================================================
       Parser: recursive descent, one statement per line, with
       precedence climbing for expressions. Syntax errors are collected
       per line (the parser skips to the next line and carries on) so a
       student sees all of them at once.
       ============================================================ */
    const BINPREC = { '+': 1, '-': 1, '*': 2, '/': 2 };

    class Parser {
        constructor(src) {
            this.src = src;
            this.toks = lex(src).filter(t => t.type !== 'comment');
            const lines = src.split('\n');
            this.toks.push({ type: 'eof', text: '', line: lines.length, col: lines[lines.length - 1].length + 1, start: src.length, end: src.length });
            this.i = 0;
            this.errors = [];
            this.labels = new Map();       // label name -> line of the block that defines it
        }
        peek(o) { return this.toks[Math.min(this.i + (o || 0), this.toks.length - 1)]; }
        next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
        prevEnd() { return this.toks[Math.max(0, this.i - 1)].end; }
        isOp(t, op) { return t.type === 'op' && t.op === op; }
        isKw(t, kw) { return t.type === 'keyword' && t.text === kw; }
        atEOL() { const t = this.peek(); return t.type === 'newline' || t.type === 'eof'; }
        atEventEnd() {
            const t = this.peek();
            return t.type === 'newline' || t.type === 'eof' || this.isOp(t, ',') || this.isKw(t, 'at') || this.isKw(t, 'as');
        }
        skipLine() { while (!this.atEOL()) this.i++; }
        eol() {
            if (this.atEOL()) return;
            const t = this.peek();
            let hint = null;
            const prev = this.toks[this.i - 1];
            if (t.type === 'keyword' && /^(rf|gx|gy|gz|adc)$/.test(t.text)) hint = 'Separate the events of a block with commas: gz rephase, gx prephase.';
            else if (t.type === 'ident' && prev && prev.type === 'number') {
                hint = 'If "' + t.text + '" is meant as a unit, the known units are ' + Object.keys(UNITS).join(', ') + '.';
            }
            if (t.type === 'error') fail(t.msg, t);
            fail('Unexpected "' + t.text + '" here.', t, hint);
        }
        expectOp(op, hint) {
            const t = this.next();
            if (!this.isOp(t, op)) fail('Expected "' + op + '" but found ' + (t.type === 'newline' || t.type === 'eof' ? 'the end of the line' : '"' + t.text + '"') + '.', t, hint);
            return t;
        }
        expectKw(kw, hint) {
            const t = this.next();
            if (!this.isKw(t, kw)) fail('Expected "' + kw + '" but found ' + (t.type === 'newline' || t.type === 'eof' ? 'the end of the line' : '"' + t.text + '"') + '.', t, hint);
            return t;
        }
        expectName(what) {
            const t = this.next();
            if (t.type === 'ident') return t;
            if (t.type === 'keyword') fail('"' + t.text + '" is a reserved word and cannot be used as a ' + what + ' name.', t, 'Choose another name, for example ' + t.text + '1 or my_' + t.text + '.');
            fail('Expected a ' + what + ' name here.', t, 'Names start with a letter and may contain letters, digits and _.');
        }
        topLevel(t, depth) {
            if (depth > 0) fail('"' + t.text + '" must be at the top level, not inside a loop.', t, 'Move this line above the first loop.');
        }

        parseProgram() {
            const body = this.parseBody(null, 0);
            return { body, errors: this.errors, labels: this.labels };
        }

        parseBody(opener, depth) {
            const stmts = [];
            for (;;) {
                if (this.errors.length >= 40) { this.i = this.toks.length - 1; return stmts; }
                const t = this.peek();
                if (t.type === 'newline') { this.i++; continue; }
                if (t.type === 'eof') {
                    if (opener) this.errors.push(new DslError('This "' + opener.text + '" loop is never closed with "end".', opener, 'Add a line with end after the loop body.'));
                    return stmts;
                }
                if (this.isKw(t, 'end')) {
                    this.next();
                    if (!opener) {
                        this.errors.push(new DslError('"end" without a matching for or repeat.', t, 'Remove this line, or check the loop above it.'));
                        this.skipLine(); continue;
                    }
                    if (!this.atEOL()) { this.errors.push(new DslError('Unexpected "' + this.peek().text + '" after end.', this.peek())); this.skipLine(); }
                    return stmts;
                }
                try {
                    const s = this.parseStatement(depth);
                    if (s) stmts.push(s);
                } catch (e) {
                    if (!(e instanceof DslError)) throw e;
                    this.errors.push(e);
                    this.skipLine();
                }
            }
        }

        parseStatement(depth) {
            const t = this.peek();
            if (t.type === 'error') fail(t.msg, t);
            if (t.type === 'keyword') {
                const w = t.text;
                if (w === 'sequence') {
                    this.topLevel(t, depth); this.next();
                    const s = this.next();
                    if (s.type !== 'string') fail('sequence needs a title in double quotes.', s, 'For example: sequence "Spin echo"');
                    this.eol();
                    return { t: 'sequence', title: s.value, line: t.line, col: t.col };
                }
                if (w === 'param') return this.parseParam(depth);
                if (w === 'let') {
                    this.next();
                    const nameTok = this.expectName('variable');
                    this.expectOp('=', 'Write: let NAME = value');
                    const expr = this.parseExpr();
                    this.eol();
                    return { t: 'let', name: nameTok.text, nameTok, expr, line: t.line, col: t.col };
                }
                if (SETTINGS.has(w)) {
                    this.topLevel(t, depth); this.next();
                    if (this.atEOL()) fail('"' + w + '" needs a value.', t, settingExample(w));
                    const args = [this.parseExpr()];
                    if ((w === 'fov' || w === 'matrix') && !this.atEOL()) {
                        if (this.isOp(this.peek(), ',')) this.next();
                        args.push(this.parseExpr());
                    }
                    this.eol();
                    return { t: 'setting', kw: w, args, line: t.line, col: t.col };
                }
                if (w === 'for') return this.parseFor(depth);
                if (w === 'repeat') return this.parseRepeat(depth);
                if (w === 'spoil' || w === 'wait' || w === 'rf' || w === 'gx' || w === 'gy' || w === 'gz' || w === 'adc') return this.parseBlock();
                let hint = null;
                if (SPECS.has(w)) hint = '"' + w + '" is a gradient shape; write it after an axis, e.g. gx ' + w + (w === 'encode' || w === 'rewind' ? ' line' : '') + '.';
                else if (SHAPES.has(w) || ROLES.has(w) || RF_OPTS.has(w)) hint = '"' + w + '" belongs after the flip angle of an rf event, e.g. rf 90 ' + (RF_OPTS.has(w) ? w + ' ...' : w) + '.';
                else if (w === 'dwell') hint = 'dwell belongs to an adc event, e.g. adc 2048 dwell 250 us.';
                else if (w === 'at' || w === 'as') hint = '"' + w + '" goes at the end of a block line, e.g. adc at exc + TE.';
                fail('A line cannot start with "' + w + '".', t, hint);
            }
            if (t.type === 'ident') {
                let hint;
                const sug = suggest(t.text, STATEMENT_WORDS);
                if (this.isOp(this.peek(1), '=')) hint = 'To declare a value write: param ' + t.text + ' = ... (or let ' + t.text + ' = ...).';
                else if (sug) hint = 'Did you mean ' + sug + '?';
                else hint = 'A line starts with a statement such as param, let, for, repeat, rf, gx, adc, spoil or wait.';
                fail('Unknown statement "' + t.text + '".', t, hint);
            }
            fail('A line cannot start with "' + t.text + '".', t, 'A line starts with a statement such as param, let, for, repeat, rf, gx, adc, spoil or wait.');
        }

        parseParam(depth) {
            const t = this.next();
            this.topLevel(t, depth);
            const nameTok = this.expectName('parameter');
            this.expectOp('=', 'Write: param ' + nameTok.text + ' = 90 ms');
            const first = this.peek();
            if (first.type === 'newline' || first.type === 'eof') fail('param ' + nameTok.text + ' needs a value after "=".', first);
            const expr = this.parseExpr();
            const span = [first.start, this.prevEnd()];
            let range = null, step = null, desc = null;
            while (!this.atEOL()) {
                const o = this.next();
                if (this.isKw(o, 'range') && !range) {
                    const lo = this.parseExpr();
                    this.expectOp('..', 'Write the range with two dots: range 10 ms .. 100 ms');
                    range = [lo, this.parseExpr()];
                } else if (this.isKw(o, 'step') && !step) step = this.parseExpr();
                else if (o.type === 'string' && desc === null) desc = o.value;
                else if (o.type === 'error') fail(o.msg, o);
                else fail('Unexpected "' + o.text + '" in the param line.', o, 'After the value you may add range LO .. HI, step S and a "description".');
            }
            return { t: 'param', name: nameTok.text, nameTok, expr, range, step, desc, span, line: t.line, col: t.col };
        }

        parseFor(depth) {
            const t = this.next();
            let hdr = null;
            try {
                const nameTok = this.expectName('loop variable');
                this.expectKw('in', 'Write the loop as: for line in 0 .. N-1');
                const from = this.parseExpr();
                this.expectOp('..', 'Write the range with two dots: for line in 0 .. N-1');
                const to = this.parseExpr();
                let step = null, every = null;
                while (!this.atEOL()) {
                    const o = this.next();
                    if (this.isKw(o, 'step') && !step) step = this.parseExpr();
                    else if (this.isKw(o, 'every') && !every) every = this.parseExpr();
                    else fail('Unexpected "' + o.text + '" in the loop line.', o, 'After the range you may add step S and every T.');
                }
                hdr = { name: nameTok.text, nameTok, from, to, step, every };
            } catch (e) {
                if (!(e instanceof DslError)) throw e;
                this.errors.push(e);
                this.skipLine();
            }
            const body = this.parseBody(t, depth + 1);
            return Object.assign({ t: 'for', body, line: t.line, col: t.col, bad: !hdr }, hdr || {});
        }

        parseRepeat(depth) {
            const t = this.next();
            let count = null, every = null, ok = false;
            try {
                if (this.atEOL()) fail('repeat needs a count, e.g. repeat 16 every TR.', t);
                count = this.parseExpr();
                while (!this.atEOL()) {
                    const o = this.next();
                    if (this.isKw(o, 'every') && !every) every = this.parseExpr();
                    else fail('Unexpected "' + o.text + '" in the repeat line.', o, 'Write: repeat K or repeat K every T');
                }
                ok = true;
            } catch (e) {
                if (!(e instanceof DslError)) throw e;
                this.errors.push(e);
                this.skipLine();
            }
            const body = this.parseBody(t, depth + 1);
            return { t: 'repeat', count, every, body, line: t.line, col: t.col, bad: !ok };
        }

        parseBlock() {
            const first = this.peek();
            const events = [];
            if (this.isKw(first, 'spoil') || this.isKw(first, 'wait')) {
                this.next();
                if (first.text === 'wait') {
                    if (this.atEventEnd()) fail('wait needs a duration, e.g. wait 10 ms.', first);
                    events.push({ e: 'wait', dur: this.parseExpr(), line: first.line, col: first.col });
                } else events.push({ e: 'spoil', line: first.line, col: first.col });
                if (this.isOp(this.peek(), ',')) fail('"' + first.text + '" is a block of its own; put the other events on another line.', this.peek());
            } else {
                events.push(this.parseEvent());
                while (this.isOp(this.peek(), ',')) { this.next(); events.push(this.parseEvent()); }
            }
            let at = null, as = null, asTok = null;
            while (this.isKw(this.peek(), 'at') || this.isKw(this.peek(), 'as')) {
                const o = this.next();
                if (o.text === 'at') {
                    if (at) fail('This block has two "at" times.', o);
                    if (this.atEOL()) fail('"at" needs a time, e.g. at exc + TE.', o);
                    at = this.parseExpr();
                } else {
                    if (as) fail('This block has two labels.', o);
                    asTok = this.expectName('label');
                    as = asTok.text;
                }
            }
            this.eol();
            if (as) {
                if (this.labels.has(as)) fail('The label "' + as + '" is already used on line ' + this.labels.get(as) + '.', asTok, 'Each label names one block; choose another name.');
                this.labels.set(as, first.line);
            }
            return { t: 'block', events, at, as, asTok, line: first.line, col: first.col };
        }

        parseEvent() {
            const t = this.next();
            if (t.type === 'keyword') {
                if (t.text === 'rf') return this.parseRF(t);
                if (t.text === 'gx' || t.text === 'gy' || t.text === 'gz') return this.parseGrad(t);
                if (t.text === 'adc') return this.parseADC(t);
                if (t.text === 'spoil' || t.text === 'wait') fail('"' + t.text + '" is a block of its own; put it on its own line.', t);
            }
            if (t.type === 'error') fail(t.msg, t);
            const sug = t.type === 'ident' ? suggest(t.text, ['rf', 'gx', 'gy', 'gz', 'adc']) : null;
            fail('Expected an event (rf, gx, gy, gz or adc) but found ' + (t.type === 'newline' || t.type === 'eof' ? 'the end of the line' : '"' + t.text + '"') + '.', t,
                sug ? 'Did you mean ' + sug + '?' : null);
        }

        parseRF(t) {
            const ev = { e: 'rf', flip: null, shape: null, role: null, dur: null, phase: null, bw: null, offset: null, line: t.line, col: t.col };
            const f = this.peek();
            if (this.atEventEnd() || (f.type === 'keyword' && (SHAPES.has(f.text) || ROLES.has(f.text) || RF_OPTS.has(f.text)))) {
                fail('rf needs a flip angle first, e.g. rf 90 slice.', f.type === 'newline' || f.type === 'eof' ? t : f);
            }
            ev.flip = this.parseExpr();
            while (!this.atEventEnd()) {
                const o = this.next();
                if (o.type === 'keyword') {
                    if (SHAPES.has(o.text)) {
                        if (ev.shape) fail('This rf event has two shapes ("' + ev.shapeWord + '" and "' + o.text + '").', o);
                        ev.shape = o.text === 'sinc' ? 'slice' : o.text; ev.shapeWord = o.text; continue;
                    }
                    if (ROLES.has(o.text)) {
                        if (ev.role) fail('This rf event has two roles.', o);
                        ev.role = o.text; continue;
                    }
                    if (RF_OPTS.has(o.text)) {
                        if (ev[o.text]) fail('"' + o.text + '" is given twice.', o);
                        if (this.atEventEnd()) fail('"' + o.text + '" needs a value.', o, rfOptionExample(o.text));
                        ev[o.text] = this.parseExpr(); continue;
                    }
                }
                if (o.type === 'error') fail(o.msg, o);
                const all = Array.from(SHAPES).concat(Array.from(ROLES), Array.from(RF_OPTS));
                const sug = suggest(o.text, all);
                let hint = sug ? 'Did you mean ' + sug + '?' : 'After the flip angle come a shape (hard, slice, water, fat, adiabatic), a role (excite, refocus, invert, saturate) and options (dur, phase, bw, offset).';
                if (o.type === 'keyword' && /^(gx|gy|gz|adc|rf)$/.test(o.text)) hint = 'Separate the events of a block with commas.';
                fail('"' + o.text + '" is not an rf option.', o, hint);
            }
            return ev;
        }

        parseGrad(t) {
            const ev = { e: 'grad', axis: t.text[1], neg: false, spec: null, arg: null, amp: null, dur: null, scale: null, line: t.line, col: t.col };
            let s = this.peek();
            if (this.isOp(s, '-') && this.peek(1).type === 'keyword' && SPECS.has(this.peek(1).text)) {
                this.next(); ev.neg = true; s = this.peek();
            }
            if (s.type === 'keyword' && SPECS.has(s.text)) {
                this.next();
                ev.spec = s.text;
                ev.specTok = s;
                if (s.text === 'encode' || s.text === 'rewind') {
                    if (this.atEventEnd()) fail('"' + s.text + '" needs a line number, e.g. ' + t.text + ' ' + s.text + ' line.', s);
                    ev.arg = this.parseExpr();
                } else if (this.isOp(this.peek(), '*')) {
                    this.next();
                    ev.scale = this.parseExpr();
                }
            } else if (s.type === 'keyword' && s.text !== 'at' && s.text !== 'as') {
                const sug = suggest(s.text, Array.from(SPECS));
                fail('"' + s.text + '" is not a gradient shape.', s,
                    (sug ? 'Did you mean ' + sug + '? ' : '') + 'Shapes: readout, prephase, encode L, rewind L, rephase, crush, blip, or AMP for DUR.');
            } else {
                if (this.atEventEnd()) fail(t.text + ' needs a shape, e.g. ' + t.text + ' readout or ' + t.text + ' 10 mT/m for 2 ms.', t);
                ev.spec = 'manual';
                ev.amp = this.parseExpr();
                if (!this.isKw(this.peek(), 'for')) {
                    // A lone misspelt word ("gx redout") is far more likely than a
                    // forgotten "for", so suggest the shape it resembles.
                    const sug = ev.amp.t === 'var' ? suggest(ev.amp.name, Array.from(SPECS)) : null;
                    if (sug) fail('"' + ev.amp.name + '" is not a gradient shape.', ev.amp, 'Did you mean ' + sug + '?');
                    fail('Write an explicit gradient as AMP for DUR, e.g. ' + t.text + ' 10 mT/m for 2 ms.', this.peek().type === 'newline' || this.peek().type === 'eof' ? t : this.peek(),
                        'Or use a named shape: readout, prephase, encode L, rewind L, rephase, crush, blip.');
                }
                this.next();
                if (this.atEventEnd()) fail('"for" needs a duration, e.g. for 2 ms.', this.peek().type === 'newline' ? t : this.peek());
                ev.dur = this.parseExpr();
            }
            return ev;
        }

        parseADC(t) {
            const ev = { e: 'adc', n: null, dwell: null, line: t.line, col: t.col };
            if (!this.atEventEnd() && !this.isKw(this.peek(), 'dwell')) ev.n = this.parseExpr();
            while (!this.atEventEnd()) {
                const o = this.next();
                if (this.isKw(o, 'dwell') && !ev.dwell) {
                    if (this.atEventEnd()) fail('"dwell" needs a time, e.g. dwell 250 us.', o);
                    ev.dwell = this.parseExpr();
                } else fail('"' + o.text + '" is not an adc option.', o, 'Write adc on its own next to a readout, or adc N dwell D, e.g. adc 2048 dwell 250 us.');
            }
            return ev;
        }

        /* Expressions. Precedence, loosest first: + -, then * /, then unary
           minus, then ^ (right associative, so -2^2 = -4 and 2^3^2 = 512). */
        parseExpr() { return this.parseBinary(1); }
        parseBinary(minPrec) {
            let left = this.parseUnary();
            for (;;) {
                const t = this.peek();
                if (t.type !== 'op') break;
                const prec = BINPREC[t.op];
                if (!prec || prec < minPrec) break;
                this.next();
                const right = this.parseBinary(prec + 1);
                left = { t: 'bin', op: t.op, a: left, b: right, line: t.line, col: t.col, start: left.start, end: right.end };
            }
            return left;
        }
        parseUnary() {
            const t = this.peek();
            if (t.type === 'op' && (t.op === '-' || t.op === '+')) {
                this.next();
                const a = this.parseUnary();
                return t.op === '-' ? { t: 'neg', a, line: t.line, col: t.col, start: t.start, end: a.end } : a;
            }
            return this.parsePower();
        }
        parsePower() {
            const base = this.parsePrimary();
            const t = this.peek();
            if (this.isOp(t, '^')) {
                this.next();
                const e = this.parseUnary();
                return { t: 'bin', op: '^', a: base, b: e, line: t.line, col: t.col, start: base.start, end: e.end };
            }
            return base;
        }
        parsePrimary() {
            const t = this.next();
            if (t.type === 'number') return { t: 'num', v: t.value, k: t.kind, unit: t.unit, line: t.line, col: t.col, start: t.start, end: t.end };
            if (t.type === 'ident') {
                if (this.isOp(this.peek(), '(')) {
                    this.next();
                    const args = [];
                    if (!this.isOp(this.peek(), ')')) {
                        args.push(this.parseExpr());
                        while (this.isOp(this.peek(), ',')) { this.next(); args.push(this.parseExpr()); }
                    }
                    const close = this.expectOp(')', 'Close the function call with ")".');
                    return { t: 'call', name: t.text, args, line: t.line, col: t.col, start: t.start, end: close.end };
                }
                return { t: 'var', name: t.text, line: t.line, col: t.col, start: t.start, end: t.end };
            }
            if (this.isOp(t, '(')) {
                const e = this.parseExpr();
                this.expectOp(')', 'Every "(" needs a matching ")".');
                return e;
            }
            if (t.type === 'error') fail(t.msg, t);
            if (t.type === 'newline' || t.type === 'eof') fail('The line ends where a value was expected.', t);
            if (t.type === 'keyword') fail('Expected a value but found the keyword "' + t.text + '".', t,
                RESERVED.has(t.text) ? '"' + t.text + '" is a reserved word, so it cannot be used as a name.' : null);
            fail('Expected a value but found "' + t.text + '".', t);
        }
    }

    function settingExample(w) {
        return { fov: 'For example: fov 240 mm', matrix: 'For example: matrix 128', slice: 'For example: slice 5 mm',
            bandwidth: 'For example: bandwidth 250 Hz/px', oversample: 'For example: oversample 2',
            averages: 'For example: averages 2', dummies: 'For example: dummies 2' }[w];
    }
    function rfOptionExample(w) {
        return { dur: 'For example: dur 2 ms', phase: 'For example: phase 90', bw: 'For example: bw 2 kHz', offset: 'For example: offset 1.5 ppm' }[w];
    }

    /* ============================================================
       Execution: walk the syntax tree and lay the sequence out in time.
       ============================================================ */
    const RF_DEFAULT_DUR = { hard: 0.5e-3, slice: 2e-3, water: 20e-3, fat: 20e-3, adiabatic: 10e-3 };
    const RF_SHAPE_OUT = { hard: 'hard', slice: 'sinc', water: 'gauss', fat: 'gauss', adiabatic: 'sech' };
    const RF_SELECT_OUT = { hard: 'none', slice: 'slice', water: 'water', fat: 'fat', adiabatic: 'none' };
    const ROLE_WORD = { excite: 'excitation pulse', refocus: 'refocusing pulse', invert: 'inversion pulse', saturate: 'saturation pulse' };

    const AXES = ['x', 'y', 'z'];

    // One gradient per axis per block; `used` maps an axis to the event that took it.
    function claimAxis(used, axis, ev) {
        if (used[axis]) {
            const what = e => (e.e === 'rf' ? 'the slice-select gradient of rf ... slice'
                : 'g' + e.axis + ' ' + (e.neg ? '-' : '') + (e.spec === 'manual' ? 'AMP for DUR' : e.spec));
            fail('Two gradients on g' + axis + ' in one block (' + what(used[axis]) + ' and ' + what(ev) + ').', ev,
                'The events of a block all start together, so each axis can carry only one gradient per block. Put one of them on its own line.');
        }
        used[axis] = ev;
    }

    function dAdd(a, b, s) {
        const r = {};
        for (const k in a) r[k] = a[k];
        for (const k in b) r[k] = (r[k] || 0) + s * b[k];
        return r;
    }
    function dScale(a, s) { const r = {}; for (const k in a) r[k] = a[k] * s; return r; }

    class Exec {
        constructor(ast, source, opts) {
            this.ast = ast;
            this.source = source;
            this.opts = opts || {};
            this.overrides = this.opts.overrides || {};
            this.maxBlocks = this.opts.maxEvents > 0 ? this.opts.maxEvents : MAX_BLOCKS;
            this.labelLines = ast.labels;
            this.vars = Object.create(null);
            this.vars.pi = { v: Math.PI, k: NONE, type: 'const' };
            this.vars.f0 = { v: C.F0, k: FREQ, type: 'const' };
            this.params = [];
            this.lets = {};
            this.warnings = [];
            this.name = 'Untitled sequence';
            this.img = { fovX: 0.24, fovY: 0.24, nx: 128, ny: 128, thickness: 0.005, bw: 250, oversample: 2, averages: 1, dummies: 0 };
            this.settingLine = {};
            this.locked = false;
            this.cursor = 0;               // end of the last block (absolute s)
            this.chain = null;             // the at-expression that fixed the cursor (for hints)
            this.periodStart = 0;          // innermost every-iteration start
            this.periodIdx = -1;           // index into periods (outermost every-loops)
            this.everyDepth = 0;
            this.dummy = false;
            this.dummiesUsed = false;
            this.TR = null;
            this.loopDepth = 0;
            // Loop variables as one object per loop pass. It is replaced, never
            // modified, so ADCs, periods and timing hints can share it without copying.
            this.loopVals = {};
            this.iterations = 0;
            this.excited = false;          // an excitation since the last spoil in this period
            this.lastSliceExc = null;      // slice-select gradient of the latest slice-selective excitation
            this.roCache = {};
            this.encCache = {};
            this.rf = []; this.grad = { x: [], y: [], z: [] }; this.adc = []; this.spoil = [];
            this.blocks = []; this.periods = [];
            this.nAdcReal = 0;
        }

        run() {
            this.execList(this.ast.body);
            return this.finish();
        }

        execList(list) { for (let i = 0; i < list.length; i++) this.exec(list[i]); }

        exec(s) {
            switch (s.t) {
                case 'sequence': this.name = s.title; break;
                case 'param': this.execParam(s); break;
                case 'let': this.execLet(s); break;
                case 'setting': this.execSetting(s); break;
                case 'for': this.execFor(s); break;
                case 'repeat': this.execRepeat(s); break;
                case 'block': this.execBlock(s); break;
            }
        }

        /* ---------- Expression evaluation ----------
           A value is any object with fields v (SI number) and k (kind).
           Number nodes and variable entries already have that shape, so
           most lookups allocate nothing. */
        eval(n) {
            switch (n.t) {
                case 'num': return n;
                case 'var': {
                    const e = this.vars[n.name];
                    if (e === undefined) this.unknownName(n);
                    if (e.type === 'label') return { v: e.t - this.periodStart, k: TIME };
                    return e;
                }
                case 'neg': { const a = this.eval(n.a); return { v: -a.v, k: a.k }; }
                case 'bin': return this.binop(n);
                case 'call': return this.call(n);
            }
            fail('Internal error: unknown expression node.', n);
        }

        binop(n) {
            const a = this.eval(n.a), b = this.eval(n.b);
            let v, k;
            switch (n.op) {
                case '+': case '-':
                    if (a.k !== b.k) this.addError(n, a, b);
                    v = n.op === '+' ? a.v + b.v : a.v - b.v;
                    k = a.k;
                    break;
                case '*':
                    v = a.v * b.v;
                    if (a.k === NONE) k = b.k;
                    else if (b.k === NONE) k = a.k;
                    else if ((a.k === TIME && b.k === FREQ) || (a.k === FREQ && b.k === TIME)) k = NONE;
                    else k = MIXED;
                    break;
                case '/':
                    if (b.v === 0) fail('Division by zero.', n);
                    v = a.v / b.v;
                    if (b.k === NONE) k = a.k;
                    else if (a.k === NONE) k = b.k === TIME ? FREQ : b.k === FREQ ? TIME : MIXED;
                    else if (a.k === b.k && a.k !== MIXED) k = NONE;      // a ratio of like quantities
                    else k = MIXED;
                    break;
                case '^':
                    if (b.k !== NONE) fail('An exponent must be a plain number, not ' + KIND_PHRASE[b.k] + '.', n);
                    v = Math.pow(a.v, b.v);
                    k = a.k === NONE ? NONE : (b.v === 1 ? a.k : MIXED);
                    break;
            }
            if (!isFinite(v)) fail('This calculation does not give a finite number.', n,
                n.op === '^' ? 'A negative number can only be raised to a whole power; write (-1)^line.' : null);
            return { v, k };
        }

        addError(n, a, b) {
            const verb = n.op === '+' ? 'add' : 'subtract';
            const pair = (x, y) => (n.op === '+' ? x + ' and ' + y : y + ' from ' + x);
            if (a.k === NONE || b.k === NONE) {
                const other = a.k === NONE ? b : a, plain = a.k === NONE ? a : b;
                const msg = 'Cannot ' + verb + ' ' + pair(a.k === NONE ? 'a plain number' : KIND_PHRASE[a.k], b.k === NONE ? 'a plain number' : KIND_PHRASE[b.k]) +
                    '; did you forget a unit?';
                const unit = KIND_UNIT[other.k].u;
                fail(msg, n, unit ? 'Write ' + num(plain.v) + ' ' + unit + ' (or whichever unit you meant).' : null);
            }
            fail('Cannot ' + verb + ' ' + pair(fmtVal(a.v, a.k), fmtVal(b.v, b.k)) + '.', n,
                KIND_PHRASE[a.k].replace(/^an? /, m => m[0].toUpperCase() + m.slice(1)) + ' and ' + KIND_PHRASE[b.k] + ' have different units, so they cannot be combined with ' + n.op + '.');
        }

        call(n) {
            const ar = FUNCS[n.name];
            if (ar === undefined) {
                const sug = suggest(n.name, Object.keys(FUNCS));
                fail('Unknown function "' + n.name + '".', n, sug ? 'Did you mean ' + sug + '?' : 'Functions: ' + Object.keys(FUNCS).join(', ') + '.');
            }
            if (ar > 0 && n.args.length !== ar) fail(n.name + ' takes ' + ar + ' argument' + (ar > 1 ? 's' : '') + '.', n);
            if (ar < 0 && n.args.length < 1) fail(n.name + ' needs at least one argument.', n);
            const a = n.args.map(x => this.eval(x));
            const x = a[0];
            let v, k = NONE;
            switch (n.name) {
                case 'sin': case 'cos': case 'tan': {
                    // A plain number is radians; an angle (stored in degrees) is converted.
                    if (x.k !== NONE && x.k !== ANGLE) fail(n.name + ' needs an angle or a plain number (radians), not ' + KIND_PHRASE[x.k] + '.', n);
                    const r = x.k === ANGLE ? x.v * Math.PI / 180 : x.v;
                    v = Math[n.name](r);
                    break;
                }
                case 'sqrt': case 'exp': case 'log':
                    if (x.k !== NONE) fail(n.name + ' needs a plain number, not ' + KIND_PHRASE[x.k] + '.', n);
                    v = Math[n.name](x.v);
                    break;
                case 'abs': case 'floor': case 'ceil': case 'round':
                    v = Math[n.name](x.v); k = x.k; break;
                case 'min': case 'max':
                    for (const y of a) if (y.k !== x.k) fail(n.name + ' needs all its arguments in the same units.', n);
                    v = Math[n.name].apply(null, a.map(y => y.v)); k = x.k; break;
                case 'mod': {
                    const y = a[1];
                    if (y.k !== x.k) fail('mod needs both arguments in the same units.', n);
                    if (y.v === 0) fail('mod by zero.', n);
                    v = x.v - y.v * Math.floor(x.v / y.v); k = x.k; break;
                }
            }
            if (!isFinite(v)) fail('This calculation does not give a finite number.', n);
            return { v, k };
        }

        unknownName(n) {
            const name = n.name;
            if (this.labelLines.has(name)) {
                fail('The label "' + name + '" is used before the block that defines it (line ' + this.labelLines.get(name) + ') has run.', n,
                    'A label takes its value when its block runs, so refer to it only in later blocks.');
            }
            const cands = Object.keys(this.vars).concat(Array.from(this.labelLines.keys()));
            const sug = suggest(name, cands);
            fail('Unknown name "' + name + '".', n, sug ? 'Did you mean ' + sug + '?' : 'Declare it first with param or let, or check the spelling.');
        }

        /* Check that a value has the expected kind and return its number. A
           plain number where a unit is required gets the "write 20 ms" hint. */
        expect(val, kind, what, node) {
            if (val.k === kind) return val.v;
            if (val.k === NONE && KIND_UNIT[kind].u) {
                let unit = KIND_UNIT[kind].u;
                if (kind === FREQ && /bandwidth/.test(what)) unit = 'Hz/px';
                else if (kind === TIME && /dwell/.test(what)) unit = 'us';
                fail(what + ' needs ' + KIND_PHRASE[kind] + ', but ' + num(val.v) + ' is a plain number.', node, 'Write ' + num(val.v) + ' ' + unit + '.');
            }
            fail(what + ' needs ' + KIND_PHRASE[kind] + ', but this is ' + KIND_PHRASE[val.k] + ' (' + fmtVal(val.v, val.k) + ').', node);
        }
        evalKind(node, kind, what) { return this.expect(this.eval(node), kind, what, node); }
        evalAngle(node, what) {
            const val = this.eval(node);
            if (val.k === ANGLE || val.k === NONE) return val.v;
            fail(what + ' needs an angle (degrees by default), but this is ' + KIND_PHRASE[val.k] + ' (' + fmtVal(val.v, val.k) + ').', node);
        }
        evalInt(node, what) {
            const val = this.eval(node);
            if (val.k !== NONE) fail(what + ' must be a plain whole number, not ' + KIND_PHRASE[val.k] + ' (' + fmtVal(val.v, val.k) + ').', node);
            const r = Math.round(val.v);
            if (Math.abs(val.v - r) > 1e-9 * Math.max(1, Math.abs(val.v))) {
                const deps = this.paramOrder(node, [], 0);
                fail(what + ' must be a whole number, but it is ' + num(val.v, 6) + '.', node,
                    deps.length ? 'It depends on ' + deps.join(', ') + ': choose values that make it a whole number.' : null);
            }
            return r;
        }

        /* ---------- Names ---------- */
        checkNewName(name, tok, what) {
            const e = this.vars[name];
            if (e) {
                const desc = { param: 'a parameter', let: 'a variable', loop: 'a loop variable', const: 'a built-in constant', label: 'a block label' }[e.type];
                fail('"' + name + '" is already ' + desc + (e.line ? ' (line ' + e.line + ')' : '') + '.', tok, 'Choose another name.');
            }
            if (FUNCS[name] !== undefined) fail('"' + name + '" is a built-in function, so it cannot be used as a name.', tok, 'Choose another name.');
            if (UNITS[name] && what !== 'loop variable') fail('"' + name + '" is a unit name, so it cannot be used as a ' + what + ' name.', tok, 'Choose another name.');
            if (this.labelLines.has(name)) fail('"' + name + '" is used as a block label on line ' + this.labelLines.get(name) + '.', tok, 'Choose another name.');
        }

        snapshotVars() { return this.loopVals; }
        setLoopVar(name, entry, outerVals, v) {
            entry.v = v;
            const o = Object.assign({}, outerVals);
            o[name] = v;
            this.loopVals = o;
        }

        /* ---------- Statements ---------- */
        execParam(s) {
            this.checkNewName(s.name, s.nameTok, 'parameter');
            const val = this.eval(s.expr);
            const du = displayUnit(s.expr, val.k);
            let v = val.v;
            if (hasOwn(this.overrides, s.name)) {
                const o = Number(this.overrides[s.name]);
                if (isFinite(o)) v = o;
            }
            const sameKind = (x) => x.k === val.k || (x.k === NONE && val.k === ANGLE) || (x.k === ANGLE && val.k === NONE);
            let min = null, max = null, step = null;
            if (s.range) {
                const lo = this.eval(s.range[0]), hi = this.eval(s.range[1]);
                if (!sameKind(lo)) fail('The range of ' + s.name + ' must be in the same units as its value (' + KIND_PHRASE[val.k] + '), but it starts at ' + fmtVal(lo.v, lo.k) + '.', s.range[0], 'For example: range 10 ms .. 100 ms');
                if (!sameKind(hi)) fail('The range of ' + s.name + ' must be in the same units as its value (' + KIND_PHRASE[val.k] + '), but it ends at ' + fmtVal(hi.v, hi.k) + '.', s.range[1], 'For example: range 10 ms .. 100 ms');
                min = Math.min(lo.v, hi.v); max = Math.max(lo.v, hi.v);
            }
            if (s.step) {
                const st = this.eval(s.step);
                if (!sameKind(st)) fail('The step of ' + s.name + ' must be in the same units as its value.', s.step);
                step = Math.abs(st.v);
            }
            const p = { name: s.name, value: v, kind: KIND_NAME[val.k], unit: du.u, scale: du.s, min, max, step,
                description: s.desc || '', line: s.line, span: s.span.slice() };
            this.params.push(p);
            this.vars[s.name] = { v, k: val.k, type: 'param', line: s.line, param: p };
            if (min !== null && (v < min - 1e-12 * Math.abs(min) || v > max + 1e-12 * Math.abs(max))) {
                this.warnings.push({ line: s.line, msg: s.name + ' = ' + fmtParamValue(p, v) + ' is outside its range ' + fmtParamValue(p, min) + ' .. ' + fmtParamValue(p, max) + '.' });
            }
        }

        execLet(s) {
            const e = this.vars[s.name];
            if (!(e && e.type === 'let' && e.stmt === s)) this.checkNewName(s.name, s.nameTok, 'variable');
            const val = this.eval(s.expr);
            this.vars[s.name] = { v: val.v, k: val.k, type: 'let', ast: s.expr, stmt: s, line: s.line };
            if (this.loopDepth === 0) this.lets[s.name] = val.v;
        }

        execSetting(s) {
            const w = s.kw;
            if (this.locked) fail('Put "' + w + '" before the first event: the image settings must be fixed before the sequence starts.', s, 'Move this line above the first loop or block.');
            if (this.settingLine[w]) fail('"' + w + '" is already set on line ' + this.settingLine[w] + '.', s);
            this.settingLine[w] = s.line;
            const img = this.img, a = s.args;
            const positive = (v, node, what) => { if (!(v > 0)) fail(what + ' must be greater than zero.', node); return v; };
            switch (w) {
                case 'fov':
                    img.fovX = positive(this.evalKind(a[0], LENGTH, 'fov'), a[0], 'The field of view');
                    img.fovY = a[1] ? positive(this.evalKind(a[1], LENGTH, 'fov'), a[1], 'The field of view') : img.fovX;
                    break;
                case 'matrix': {
                    const chk = (node) => {
                        const m = this.evalInt(node, 'The matrix size');
                        if (m < 2 || m > 1024) fail('The matrix size must be between 2 and 1024 (got ' + m + ').', node);
                        return m;
                    };
                    img.nx = chk(a[0]);
                    img.ny = a[1] ? chk(a[1]) : img.nx;
                    if (this.vars.Nx || this.vars.Ny) fail('Nx and Ny are defined by matrix, so they cannot be used as other names.', s);
                    this.vars.Nx = { v: img.nx, k: NONE, type: 'const' };
                    this.vars.Ny = { v: img.ny, k: NONE, type: 'const' };
                    break;
                }
                case 'slice': img.thickness = positive(this.evalKind(a[0], LENGTH, 'slice'), a[0], 'The slice thickness'); break;
                case 'bandwidth': img.bw = positive(this.evalKind(a[0], FREQ, 'bandwidth'), a[0], 'The bandwidth'); break;
                case 'oversample': {
                    const k = this.evalInt(a[0], 'oversample');
                    if (k !== 1 && k !== 2) fail('oversample must be 1 or 2 (got ' + k + ').', a[0]);
                    img.oversample = k; break;
                }
                case 'averages': {
                    const k = this.evalInt(a[0], 'averages');
                    if (k < 1) fail('averages must be at least 1.', a[0]);
                    img.averages = k; break;
                }
                case 'dummies': {
                    const k = this.evalInt(a[0], 'dummies');
                    if (k < 0) fail('dummies cannot be negative.', a[0]);
                    img.dummies = k; break;
                }
            }
        }

        tick(s) {
            if (++this.iterations > MAX_ITER) fail('This loop runs too many times (more than ' + MAX_ITER + ' passes in all).', s, 'Check the loop bounds.');
        }

        execFor(s) {
            const a = this.evalInt(s.from, 'The loop start');
            const b = this.evalInt(s.to, 'The loop end');
            const st = s.step ? this.evalInt(s.step, 'The loop step') : 1;
            if (st === 0) fail('The loop step cannot be zero.', s.step);
            const count = st > 0 ? (b >= a ? Math.floor((b - a) / st) + 1 : 0) : (a >= b ? Math.floor((a - b) / -st) + 1 : 0);
            this.checkNewName(s.name, s.nameTok, 'loop variable');
            const entry = { v: a, k: NONE, type: 'loop', line: s.line };
            this.vars[s.name] = entry;
            const outerVals = this.loopVals;
            this.loopDepth++;
            try {
                this.runLoop(s, count, a, st, entry, outerVals);
            } finally {
                this.loopDepth--;
                this.loopVals = outerVals;
                delete this.vars[s.name];
            }
        }

        execRepeat(s) {
            const count = this.evalInt(s.count, 'The repeat count');
            if (count < 0) fail('The repeat count cannot be negative.', s.count);
            this.loopDepth++;
            try { this.runLoop(s, count, 0, 0, null, this.loopVals); }
            finally { this.loopDepth--; }
        }

        /* Loops. Without "every" the passes simply follow each other. With
           "every T" pass k starts at loopStart + k*T: each pass is a period
           (a TR), and the "at" times inside it are measured from its start.
           The first every-loop that is not inside another one is the one
           whose passes become program.periods, and the one that gets the
           dummy passes. */
        runLoop(s, count, a, st, entry, outerVals) {
            if (!s.every) {
                for (let i = 0; i < count; i++) {
                    if (entry) this.setLoopVar(s.name, entry, outerVals, a + i * st);
                    this.tick(s);
                    this.execList(s.body);
                }
                return;
            }
            const T = this.evalKind(s.every, TIME, 'every');
            if (!(T > 0)) fail('The time after "every" must be greater than zero.', s.every);
            const outer = this.everyDepth === 0;
            let nD = 0;
            if (outer && !this.dummiesUsed && count > 0) { nD = this.img.dummies; this.dummiesUsed = true; }
            if (outer && this.TR === null) this.TR = T;
            const loopStart = this.cursor;
            const saved = { ps: this.periodStart, dummy: this.dummy, excited: this.excited, pidx: this.periodIdx };
            this.everyDepth++;
            for (let it = 0; it < nD + count; it++) {
                const isDummy = it < nD;
                if (entry) this.setLoopVar(s.name, entry, outerVals, a + (isDummy ? 0 : it - nD) * st);
                this.tick(s);
                const ps = q1(loopStart + it * T);
                this.cursor = ps;
                this.periodStart = ps;
                this.chain = null;
                this.excited = false;
                this.dummy = saved.dummy || isDummy;
                if (outer) {
                    this.periodIdx = this.periods.length;
                    this.periods.push({ t0: ps, dur: T, index: this.periodIdx, vars: this.snapshotVars(), dummy: this.dummy });
                }
                this.execList(s.body);
                if (this.cursor > ps + T + 1e-9) this.trTooShort(s, T, this.cursor - ps);
            }
            this.everyDepth--;
            this.periodStart = saved.ps;
            this.dummy = saved.dummy;
            this.excited = saved.excited;
            this.periodIdx = saved.pidx;
            this.cursor = q1(loopStart + (nD + count) * T);
            this.chain = null;
        }

        /* ---------- Blocks ---------- */
        execBlock(s) {
            if (this.blocks.length >= this.maxBlocks) {
                fail('This sequence has more than ' + this.maxBlocks + ' blocks, the limit of the simulator.', s, 'Reduce the number of loop passes (for example the matrix size or the number of repetitions).');
            }
            this.locked = true;
            const used = { x: null, y: null, z: null };
            let rfE = null, adcN = null, isSpoil = false, extent = 0, ro = null, roAxes = '';
            const traps = [], kinds = [];
            for (const ev of s.events) {
                switch (ev.e) {
                    case 'rf':
                        if (rfE) fail('Only one rf pulse per block.', ev, 'Put the second pulse on its own line.');
                        rfE = this.buildRF(ev);
                        kinds.push('rf');
                        if (rfE.trap) { claimAxis(used, 'z', ev); traps.push(rfE.trap); kinds.push('gz'); }
                        extent = Math.max(extent, rfE.extent);
                        break;
                    case 'grad': {
                        claimAxis(used, ev.axis, ev);
                        const tr = this.buildGrad(ev);
                        traps.push(tr);
                        kinds.push('g' + ev.axis);
                        if (ev.spec === 'readout') {
                            if (ro && (Math.abs(ro.rise - tr.rise) > 1e-12 || Math.abs(ro.flat - tr.flat) > 1e-12 || ro.ro.n !== tr.ro.n)) {
                                fail('Readouts on two axes in one block need the same timing: use the same FOV and matrix on x and y.', ev);
                            }
                            if (!ro) ro = tr;
                            roAxes += ev.axis;
                        }
                        extent = Math.max(extent, tr.rise + tr.flat + tr.fall);
                        break;
                    }
                    case 'adc':
                        if (adcN) fail('Only one adc per block.', ev);
                        adcN = ev; kinds.push('adc');
                        break;
                    case 'spoil': {
                        isSpoil = true;
                        kinds.push('spoil', 'gx', 'gy', 'gz');
                        const t = this.shortest(4 / (GB * this.img.thickness));
                        for (const ax of AXES) traps.push({ axis: ax, off: 0, rise: t.rise, flat: t.flat, fall: t.fall, amp: t.amp, tag: 'spoil', line: ev.line });
                        extent = Math.max(extent, t.rise + t.flat + t.fall);
                        break;
                    }
                    case 'wait': {
                        const d = this.evalKind(ev.dur, TIME, 'wait');
                        if (d < 0) fail('wait cannot be negative.', ev.dur);
                        kinds.push('wait');
                        extent = Math.max(extent, d);
                        break;
                    }
                }
            }

            // The ADC: on the flat top of a readout, or on its own at the block start.
            let adc = null;
            if (adcN) {
                if (ro) {
                    const r = ro.ro;
                    const n = adcN.n ? this.evalInt(adcN.n, 'The number of ADC samples') : r.n;
                    const dwell = adcN.dwell ? this.evalKind(adcN.dwell, TIME, 'dwell') : r.dwell;
                    if (n < 1) fail('The ADC needs at least one sample.', adcN);
                    if (!(dwell > 0)) fail('dwell must be greater than zero.', adcN.dwell);
                    if (n * dwell > r.flat * (1 + 1e-9)) this.warnings.push({ line: s.line, msg: 'The ADC (' + fmtMs(n * dwell) + ') is longer than the readout flat top (' + fmtMs(r.flat) + ').' });
                    adc = { off: ro.rise, n, dwell, anchor: 'center', axis: roAxes.length > 1 ? 'radial' : roAxes };
                } else {
                    if (!adcN.n || !adcN.dwell) fail('An adc without a readout gradient needs a number of samples and a dwell time.', adcN, 'For example: adc 2048 dwell 250 us');
                    const n = this.evalInt(adcN.n, 'The number of ADC samples');
                    const dwell = this.evalKind(adcN.dwell, TIME, 'dwell');
                    if (n < 1) fail('The ADC needs at least one sample.', adcN);
                    if (!(dwell > 0)) fail('dwell must be greater than zero.', adcN.dwell);
                    adc = { off: 0, n, dwell, anchor: 'start', axis: null };
                }
                extent = Math.max(extent, adc.off + adc.n * adc.dwell);
            }

            // Role inference, before placement so messages can name the pulse.
            if (rfE && !rfE.role) {
                if (rfE.select === 'water' || rfE.select === 'fat') rfE.role = 'saturate';
                else if (Math.abs(rfE.flip) >= 135) rfE.role = this.excited ? 'refocus' : 'invert';
                else rfE.role = 'excite';
            }

            // The anchor: RF centre, else echo of a readout ADC, else first sample, else block start.
            let anchorOff = 0;
            if (rfE) anchorOff = rfE.off + rfE.dur / 2;
            else if (adc) anchorOff = adc.anchor === 'center' ? adc.off + Math.floor(adc.n / 2) * adc.dwell : adc.off;
            const dur = ceil1(extent);

            let start, chain;
            if (s.at) {
                const atV = this.evalKind(s.at, TIME, 'The time after "at"');
                start = q1(this.periodStart + atV - anchorOff);
                if (start < this.cursor - 1e-9) this.tooShort(s, start, rfE, adc);
                chain = { ast: s.at, vals: this.snapshotVars() };
            } else {
                start = this.cursor;
                chain = this.chain;
            }

            // Emit.
            const bi = this.blocks.length, per = this.periodIdx, dm = this.dummy;
            if (rfE) {
                const t0 = q1(start + rfE.off);
                this.rf.push({ t: q1(t0 + rfE.dur / 2), t0, dur: rfE.dur, flip: rfE.flip, phase: rfE.phase, shape: rfE.shape,
                    select: rfE.select, role: rfE.role, bw: rfE.bw, offsetHz: rfE.offsetHz, label: s.as || null,
                    block: bi, line: s.line, period: per, dummy: dm });
            }
            for (const tr of traps) {
                this.grad[tr.axis].push({ t0: q1(start + tr.off), rise: tr.rise, flat: tr.flat, fall: tr.fall, amp: tr.amp,
                    tag: tr.tag, block: bi, line: tr.line, period: per });
            }
            if (adc) {
                const t0 = q1(start + adc.off);
                if (!dm && ++this.nAdcReal > MAX_ADC) fail('This sequence records more than ' + MAX_ADC + ' ADC windows, the limit of the simulator.', s, 'Reduce the matrix size or the number of repetitions.');
                this.adc.push({ t0, n: adc.n, dwell: adc.dwell, tc: t0 + Math.floor(adc.n / 2) * adc.dwell, anchor: adc.anchor,
                    dummy: dm, block: bi, line: s.line, period: per, vars: this.snapshotVars(), axis: adc.axis });
            }
            if (isSpoil) this.spoil.push({ t: q1(start + dur), block: bi, line: s.line, period: per, dummy: dm });
            const anchorT = start + anchorOff;
            this.blocks.push({ t0: start, dur, anchorT, label: s.as || null, line: s.line, kinds, period: per, dummy: dm });

            if (s.as) {
                const e = this.vars[s.as];
                if (e && e.type !== 'label') fail('"' + s.as + '" is already used as a name, so it cannot label a block.', s.asTok, 'Choose another label.');
                this.vars[s.as] = { type: 'label', t: anchorT, chain, line: s.line, k: TIME };
            }
            this.cursor = q1(start + dur);
            this.chain = chain;
            if (rfE && rfE.role === 'excite') {
                this.excited = true;
                if (rfE.trap) this.lastSliceExc = { amp: rfE.trap.amp, flat: rfE.trap.flat, fall: rfE.trap.fall };
            }
            if (isSpoil) this.excited = false;
        }

        buildRF(ev) {
            const flip = this.evalAngle(ev.flip, 'The flip angle');
            const shape = ev.shape || 'hard';
            let dur = ev.dur ? this.evalKind(ev.dur, TIME, 'The rf duration (dur)') : RF_DEFAULT_DUR[shape];
            if (!(dur > 0)) fail('The rf duration must be greater than zero.', ev.dur || ev);
            // Pulse lengths sit on the gradient raster so the slice-select plateau matches them exactly.
            dur = Math.max(1 / RINV, roundR(dur));
            const phase = ev.phase ? this.evalAngle(ev.phase, 'The rf phase') : 0;
            let bw;
            if (ev.bw) {
                bw = this.evalKind(ev.bw, FREQ, 'The rf bandwidth (bw)');
                if (!(bw > 0)) fail('The rf bandwidth must be greater than zero.', ev.bw);
            } else {
                // Defaults: sinc time-bandwidth 4; Gaussian FWHM 1.6/dur; rectangle main lobe ~1/dur;
                // the hyperbolic secant sweeps about 10/dur (1 kHz for 10 ms), covering water and fat.
                bw = { hard: 1, slice: 4, water: 1.6, fat: 1.6, adiabatic: 10 }[shape] / dur;
            }
            let off = 0;
            if (ev.offset) {
                const o = this.eval(ev.offset);
                if (o.k === FREQ) off = o.v;
                else if (o.k === PPM) off = o.v * C.PPM_HZ;
                else fail('The rf offset needs a frequency or a ppm value.', ev.offset, 'For example: offset 100 Hz or offset -3.4 ppm');
            }
            const r = {
                flip, dur, phase, bw, offsetHz: (shape === 'fat' ? C.FAT_HZ : 0) + off,
                shape: RF_SHAPE_OUT[shape], select: RF_SELECT_OUT[shape], role: ev.role, off: 0, extent: dur, trap: null
            };
            if (shape === 'slice') {
                // The slice-select gradient maps the pulse bandwidth onto the slice:
                // G = bw / (gammaBar * thickness). It ramps up first, then holds for the pulse.
                const G = bw / (GB * this.img.thickness);
                if (G > GMAX * (1 + 1e-9)) {
                    fail('This slice-selective pulse needs a ' + num(G * 1e3, 3) + ' mT/m slice-select gradient, above the 45 mT/m limit: the slice is too thin or the pulse too short.', ev,
                        'Use a longer pulse (dur) or a thicker slice.');
                }
                const rise = ceilR(G / SLEW);
                r.trap = { axis: 'z', off: 0, rise, flat: dur, fall: rise, amp: G, tag: 'slice', line: ev.line };
                r.off = rise;
                r.extent = 2 * rise + dur;
            }
            return r;
        }

        /* Shortest trapezoid with area A (T s/m) under the GMAX and SLEW limits:
           a triangle when |A| <= GMAX^2/SLEW, else a plateau at GMAX. Ramp and
           plateau are rounded UP to the 10 us raster and the amplitude is then
           recomputed so that the area stays exact. */
        shortest(A) {
            const a = Math.abs(A);
            if (a < 1e-15) return { rise: 0, flat: 0, fall: 0, amp: 0 };
            let rise, flat;
            if (a <= GMAX * GMAX / SLEW) { rise = ceilR(Math.sqrt(a / SLEW)); flat = 0; }
            else { rise = ceilR(GMAX / SLEW); flat = ceilR(a / GMAX - rise); }
            return { rise, flat, fall: rise, amp: Math.sign(A) * a / (rise + flat) };
        }

        inPlane(ev) {
            if (ev.axis === 'z') {
                fail('"' + ev.spec + '" works on the in-plane axes gx and gy, which have a FOV and matrix.', ev,
                    'Use gx or gy. For gz there are rephase, crush and AMP for DUR.');
            }
        }

        /* Readout on one axis: N samples per FOV at BW per pixel means a
           k-space step 1/(os*FOV) per dwell 1/(BW*N*os), so the gradient is
           G = N*BW/(gammaBar*FOV) whatever the oversampling. */
        readoutFor(ax, ev) {
            const c = this.roCache[ax];
            if (c) return c;
            const img = this.img;
            const N = ax === 'x' ? img.nx : img.ny, fov = ax === 'x' ? img.fovX : img.fovY;
            const G = N * img.bw / (GB * fov);
            if (G > GMAX * (1 + 1e-9)) {
                const bwMax = GMAX * GB * fov / N, fovMin = N * img.bw / (GB * GMAX);
                fail('The readout gradient on g' + ax + ' would need ' + num(G * 1e3, 3) + ' mT/m but the scanner\'s maximum is ' + num(GMAX * 1e3) +
                    ' mT/m: the bandwidth per pixel is too high or the FOV too small.', ev,
                    'G = N × BW / (γ̄ × FOV). With N = ' + N + ' and FOV = ' + num(fov * 1e3) + ' mm keep the bandwidth below ' + Math.floor(bwMax) +
                    ' Hz/px, or with ' + num(img.bw) + ' Hz/px make the FOV at least ' + Math.ceil(fovMin * 1e3) + ' mm.');
            }
            const n = N * img.oversample, dwell = 1 / (img.bw * n);
            const r = { G, rise: ceilR(G / SLEW), flat: n * dwell, n, dwell, N, fov };
            this.roCache[ax] = r;
            return r;
        }

        // Phase encoding: every encode on an axis uses the timing of the largest step.
        encodeFor(ax) {
            const c = this.encCache[ax];
            if (c) return c;
            const img = this.img;
            const N = ax === 'x' ? img.nx : img.ny, fov = ax === 'x' ? img.fovX : img.fovY;
            const dk = 1 / fov;
            const t = this.shortest(Math.floor(N / 2) * dk / GB);
            const r = { N, dk, rise: t.rise, flat: t.flat };
            this.encCache[ax] = r;
            return r;
        }

        buildGrad(ev) {
            const ax = ev.axis, sign = ev.neg ? -1 : 1;
            let scale = 1;
            if (ev.scale) {
                const sv = this.eval(ev.scale);
                if (sv.k !== NONE) fail('The scale after "*" must be a plain number, not ' + KIND_PHRASE[sv.k] + '.', ev.scale);
                scale = sv.v;
            }
            let tr;
            switch (ev.spec) {
                case 'readout': {
                    this.inPlane(ev);
                    const r = this.readoutFor(ax, ev);
                    tr = { rise: r.rise, flat: r.flat, fall: r.rise, amp: r.G, ro: r };
                    break;
                }
                case 'prephase': {
                    // Area from the start of the readout's ramp to its centre sample
                    // (index floor(n/2), with sample j at flat-top start + j*dwell).
                    this.inPlane(ev);
                    const r = this.readoutFor(ax, ev);
                    tr = this.shortest(-(r.G * r.rise / 2 + r.G * Math.floor(r.n / 2) * r.dwell));
                    break;
                }
                case 'encode': case 'rewind': {
                    this.inPlane(ev);
                    const e = this.encodeFor(ax);
                    const L = this.evalInt(ev.arg, 'The phase-encode line');
                    if (L < 0 || L > e.N - 1) {
                        fail('Phase-encode line ' + L + ' is outside 0 .. ' + (e.N - 1) + ' for a matrix of ' + e.N + ' on ' + ax + '.', ev.arg,
                            'Line L lands at ky = (L - N/2)/FOV, so L runs from 0 to N-1.');
                    }
                    const A = (L - Math.floor(e.N / 2)) * e.dk / GB * (ev.spec === 'rewind' ? -1 : 1);
                    tr = { rise: e.rise, flat: e.flat, fall: e.rise, amp: (e.rise + e.flat) > 0 ? A / (e.rise + e.flat) : 0 };
                    break;
                }
                case 'blip': {
                    this.inPlane(ev);
                    const e = this.encodeFor(ax);
                    tr = this.shortest(e.dk / GB);
                    break;
                }
                case 'crush':
                    tr = this.shortest(2 / (GB * this.img.thickness));
                    break;
                case 'rephase': {
                    if (ax !== 'z') fail('rephase undoes the slice-select gradient, which is on gz.', ev, 'Write gz rephase.');
                    const se = this.lastSliceExc;
                    if (!se) fail('rephase needs an earlier slice-selective excitation (rf ... slice) to undo.', ev, 'Put rf 90 slice (or rf flip slice) before it.');
                    // Spins are tipped at the pulse centre; what follows (half the
                    // plateau and the ramp down) dephases them across the slice.
                    tr = this.shortest(-(se.amp * se.flat / 2 + se.amp * se.fall / 2));
                    break;
                }
                case 'manual': {
                    const amp = this.evalKind(ev.amp, GRAD, 'The gradient amplitude');
                    const d = this.evalKind(ev.dur, TIME, 'The gradient duration');
                    if (d < 0) fail('The gradient duration cannot be negative.', ev.dur);
                    if (Math.abs(amp) > GMAX * (1 + 1e-9)) fail('g' + ax + ' ' + num(amp * 1e3, 3) + ' mT/m is above the scanner\'s 45 mT/m limit.', ev.amp, 'Use a smaller amplitude and a longer duration.');
                    const rise = ceilR(Math.abs(amp) / SLEW);
                    tr = { rise, flat: q1(d), fall: rise, amp };
                    break;
                }
            }
            tr.amp *= sign * scale;
            if (Math.abs(tr.amp) > GMAX * (1 + 1e-9)) {
                fail('Scaled by ' + num(scale) + ', this gradient needs ' + num(Math.abs(tr.amp) * 1e3, 3) + ' mT/m, above the 45 mT/m limit.', ev.scale || ev, 'Keep the scale between -1 and 1.');
            }
            if (tr.rise > 0 && Math.abs(tr.amp) / tr.rise > SLEW * (1 + 1e-6)) {
                fail('Scaled by ' + num(scale) + ', this gradient would ramp faster than the 200 T/m/s slew-rate limit.', ev.scale || ev, 'Keep the scale between -1 and 1.');
            }
            tr.axis = ax;
            tr.off = 0;
            tr.tag = ev.spec;
            tr.line = ev.line;
            return tr;
        }

        /* ---------- Timing errors with useful hints ----------
           The hint names the parameter to change and by how much. It uses
           forward-mode differentiation of the at-expressions: the gap between
           this block's anchor and the end of the previous block changes with
           a parameter P at the rate d(anchor)/dP minus d(previous chain)/dP,
           where the previous chain is the at-expression that last fixed the
           cursor (durations are treated as constant). So for a spin-echo
           readout at exc + TE after a 180 at exc + TE/2 the rate is 1/2 and the
           hint asks for twice the missing time. */
        sens(n, vals, depth) {
            if (!n || depth > 40) return { v: NaN, d: {} };
            switch (n.t) {
                case 'num': return { v: n.v, d: {} };
                case 'var': {
                    if (vals && hasOwn(vals, n.name)) return { v: vals[n.name], d: {} };
                    const e = this.vars[n.name];
                    if (!e) return { v: NaN, d: {} };
                    if (e.type === 'param') { const d = {}; d[n.name] = 1; return { v: e.v, d }; }
                    if (e.type === 'let') return { v: e.v, d: this.sens(e.ast, vals, depth + 1).d };
                    if (e.type === 'label') return { v: e.t - this.periodStart, d: e.chain ? this.sens(e.chain.ast, e.chain.vals, depth + 1).d : {} };
                    return { v: e.v, d: {} };
                }
                case 'neg': { const a = this.sens(n.a, vals, depth); return { v: -a.v, d: dScale(a.d, -1) }; }
                case 'bin': {
                    const a = this.sens(n.a, vals, depth), b = this.sens(n.b, vals, depth);
                    switch (n.op) {
                        case '+': return { v: a.v + b.v, d: dAdd(a.d, b.d, 1) };
                        case '-': return { v: a.v - b.v, d: dAdd(a.d, b.d, -1) };
                        case '*': return { v: a.v * b.v, d: dAdd(dScale(a.d, b.v), dScale(b.d, a.v), 1) };
                        case '/': return { v: a.v / b.v, d: dAdd(dScale(a.d, 1 / b.v), dScale(b.d, -a.v / (b.v * b.v)), 1) };
                        case '^': return { v: Math.pow(a.v, b.v), d: dScale(a.d, b.v * Math.pow(a.v, b.v - 1)) };
                    }
                    break;
                }
                case 'call': {
                    const a = n.args.map(x => this.sens(x, vals, depth));
                    if ((n.name === 'min' || n.name === 'max') && a.length) {
                        let best = a[0];
                        for (const y of a) if (n.name === 'min' ? y.v < best.v : y.v > best.v) best = y;
                        return best;
                    }
                    if (n.name === 'abs' && a.length) return { v: Math.abs(a[0].v), d: dScale(a[0].d, Math.sign(a[0].v)) };
                    return { v: NaN, d: {} };
                }
            }
            return { v: NaN, d: {} };
        }

        // Parameters an expression depends on, in the order they appear.
        paramOrder(n, out, depth) {
            if (!n || depth > 40) return out;
            switch (n.t) {
                case 'var': {
                    const e = this.vars[n.name];
                    if (!e) break;
                    if (e.type === 'param') { if (out.indexOf(n.name) < 0) out.push(n.name); }
                    else if (e.type === 'let') this.paramOrder(e.ast, out, depth + 1);
                    else if (e.type === 'label' && e.chain) this.paramOrder(e.chain.ast, out, depth + 1);
                    break;
                }
                case 'neg': this.paramOrder(n.a, out, depth); break;
                case 'bin': this.paramOrder(n.a, out, depth); this.paramOrder(n.b, out, depth); break;
                case 'call': for (const x of n.args) this.paramOrder(x, out, depth); break;
            }
            return out;
        }

        // Parameters that, increased, would close a gap of `short` seconds.
        blame(d, ast, short) {
            const order = this.paramOrder(ast, [], 0);
            const names = Object.keys(d).filter(k => d[k] > 1e-9 && this.vars[k] && this.vars[k].type === 'param');
            names.sort((a, b) => {
                const ia = order.indexOf(a), ib = order.indexOf(b);
                return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
            });
            return names.map(name => {
                const p = this.vars[name].param;
                return { name, p, d: d[name], min: p.value + short / d[name] };
            });
        }

        tooShort(s, start, rfE, adc) {
            const ps = this.periodStart, short = this.cursor - start;
            let what = 'block';
            if (rfE) what = ROLE_WORD[rfE.role] || 'rf pulse';
            else if (adc) what = adc.anchor === 'center' ? 'readout' : 'acquisition';
            const cur = this.sens(s.at, this.snapshotVars(), 0);
            const prev = this.chain ? this.sens(this.chain.ast, this.chain.vals, 0) : { d: {} };
            const cands = this.blame(dAdd(cur.d, prev.d, -1), s.at, short);
            const startS = fmtMs(start - ps), endS = fmtMs(this.cursor - ps);
            if (!cands.length) {
                fail('This ' + what + ' is placed too early: it must start at ' + startS + ' but the previous block ends at ' + endS +
                    ' (' + fmtMs(short) + ' too early).', s, 'Place it later with "at", or shorten the blocks before it.');
            }
            const c = cands[0];
            fail(c.name + ' = ' + fmtParamValue(c.p, c.p.value) + ' is too short: this ' + what + ' must start at ' + startS +
                ' but the previous block ends at ' + endS + '.', s, hintFor(cands),
                { kind: 'tooShort', param: c.name, min: c.min, cands });
        }

        trTooShort(s, T, need) {
            const cur = this.sens(s.every, this.snapshotVars(), 0);
            const cands = this.blame(cur.d, s.every, need - T);
            if (!cands.length) {
                fail('The loop period (every ' + fmtMs(T) + ') is too short: each repetition needs ' + ceilSig(need * 1e3, 3) + ' ms.', s.every,
                    'Make the time after "every" at least ' + ceilSig(need * 1e3, 3) + ' ms.');
            }
            const c = cands[0];
            fail(c.name + ' = ' + fmtParamValue(c.p, c.p.value) + ' is too short: each repetition needs ' + ceilSig(need * 1e3, 3) + ' ms.', s.every, hintFor(cands),
                { kind: 'tooShort', param: c.name, min: c.min, cands });
        }

        /* ---------- Final program ---------- */
        finish() {
            const img = this.img;
            const duration = this.cursor;
            if (!this.periods.length) {
                this.periods.push({ t0: 0, dur: duration, index: 0, vars: {}, dummy: false });
                const all = [this.rf, this.adc, this.spoil, this.blocks, this.grad.x, this.grad.y, this.grad.z];
                for (const arr of all) for (const e of arr) e.period = 0;
            }
            if (img.dummies > 0 && !this.dummiesUsed) this.warnings.push({ line: this.settingLine.dummies || 1, msg: 'dummies has no effect: there is no "every" loop to repeat.' });
            if (!this.adc.length) this.warnings.push({ line: 1, msg: 'This sequence never switches the ADC on, so it records nothing.' });

            let axes = '';
            for (const a of this.adc) if (a.axis && axes.indexOf(a.axis) < 0) axes += a.axis + ',';
            let readoutAxis = null;
            if (axes === 'x,') readoutAxis = 'x';
            else if (axes === 'y,') readoutAxis = 'y';
            else if (axes) readoutAxis = 'radial';

            const prog = {
                ok: true, name: this.name, source: this.source,
                params: this.params, lets: this.lets,
                image: { fovX: img.fovX, fovY: img.fovY, nx: img.nx, ny: img.ny, thickness: img.thickness, bwPerPixel: img.bw,
                    oversample: img.oversample, readoutAxis, averages: img.averages, dummies: img.dummies, hasImaging: readoutAxis !== null },
                system: { B0: C.B0, gammaBar: GB, f0: C.F0, gmax: GMAX, slew: SLEW },
                rf: this.rf, grad: this.grad, adc: this.adc, spoil: this.spoil, blocks: this.blocks, periods: this.periods,
                duration, scanTime: duration * img.averages,
                stats: null,
                warnings: this.warnings
            };
            prog.stats = computeStats(prog, this.TR);
            return prog;
        }
    }

    /* "Increase TE by at least 3.79 ms (minimum TE about 8.79 ms)." The
       minimum is rounded up to 3 significant figures in the parameter's own
       unit, and the increase is worked out from that rounded value so the
       two numbers agree. */
    function hintFor(cands) {
        return cands.map(c => {
            const p = c.p, u = p.unit ? ' ' + p.unit : '';
            const cur = p.value / p.scale, minD = c.min / p.scale;
            const minS = p.unit ? ceilSig(minD, 3) : String(Math.ceil(minD - 1e-9));
            const incS = String(Number((Number(minS) - cur).toPrecision(6)));
            return 'Increase ' + c.name + ' by at least ' + incS + u + ' (minimum ' + c.name + ' about ' + minS + u + ')';
        }).join(', or ') + '.';
    }

    // The display unit of a param: its first unit literal if that unit has
    // the right kind, else the default unit for its kind.
    function displayUnit(expr, k) {
        let found = null;
        (function walk(n) {
            if (!n || found) return;
            if (n.t === 'num' && n.unit) { found = n.unit; return; }
            if (n.t === 'neg') walk(n.a);
            else if (n.t === 'bin') { walk(n.a); walk(n.b); }
            else if (n.t === 'call') n.args.forEach(walk);
        })(expr);
        if (found && UNITS[found][0] === k) return { u: found, s: UNITS[found][1] };
        return KIND_UNIT[k];
    }

    /* ---------- Waveform helpers ----------
       Each axis is a list of non-overlapping trapezoids sorted by start
       time. For speed every program gets, per axis, an array of start
       times and the prefix sums of whole-trapezoid areas (cached on the
       trapezoid array itself), so a waveform value or an exact area is
       a binary search plus a little algebra. */
    const axisCache = new WeakMap();
    function axisIndex(arr) {
        let c = axisCache.get(arr);
        if (c && c.n === arr.length) return c;
        const n = arr.length, t0 = new Float64Array(n), cum = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
            const tr = arr[i];
            t0[i] = tr.t0;
            cum[i + 1] = cum[i] + tr.amp * (tr.rise / 2 + tr.flat + tr.fall / 2);
        }
        c = { n, t0, cum };
        axisCache.set(arr, c);
        return c;
    }
    function lastStartBefore(t0, t) {      // largest j with t0[j] <= t, or -1
        let lo = 0, hi = t0.length - 1, j = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (t0[mid] <= t) { j = mid; lo = mid + 1; } else hi = mid - 1;
        }
        return j;
    }
    function trapValue(tr, tau) {
        if (tau < 0) return 0;
        if (tau < tr.rise) return tr.amp * tau / tr.rise;
        if (tau <= tr.rise + tr.flat) return tr.amp;
        const u = tau - tr.rise - tr.flat;
        return u < tr.fall ? tr.amp * (1 - u / tr.fall) : 0;
    }
    function trapPartial(tr, tau) {        // integral of the trapezoid from its start to start + tau
        if (tau <= 0) return 0;
        const r = tr.rise, f = tr.flat, d = tr.fall, a = tr.amp;
        if (tau < r) return a * tau * tau / (2 * r);
        if (tau < r + f) return a * (r / 2 + tau - r);
        if (tau < r + f + d) { const u = tau - r - f; return a * (r / 2 + f + u - u * u / (2 * d)); }
        return a * (r / 2 + f + d / 2);
    }
    function axisArray(program, axis) {
        return program && program.grad && program.grad[axis] ? program.grad[axis] : null;
    }
    function gradientAt(program, axis, t) {
        const arr = axisArray(program, axis);
        if (!arr || !arr.length) return 0;
        const c = axisIndex(arr), j = lastStartBefore(c.t0, t);
        return j < 0 ? 0 : trapValue(arr[j], t - c.t0[j]);
    }
    function areaTo(arr, c, t) {
        const j = lastStartBefore(c.t0, t);
        return j < 0 ? 0 : c.cum[j] + trapPartial(arr[j], t - c.t0[j]);
    }
    function gradientArea(program, axis, tA, tB) {
        const arr = axisArray(program, axis);
        if (!arr || !arr.length) return 0;
        const c = axisIndex(arr);
        return areaTo(arr, c, tB) - areaTo(arr, c, tA);
    }

    /* Program statistics. TE is measured on the ADC whose centre sample
       lies nearest k = 0 (the effective TE), using the same one-pathway
       rule as the engine: an excitation resets k, a refocusing pulse
       negates it. TI is the time from the latest inversion before that
       excitation, in the same period. */
    function computeStats(prog, TR) {
        const real = prog.adc.filter(a => !a.dummy);
        let nSamples = 0;
        for (const a of real) nSamples += a.n;
        let gmaxUsed = 0;
        for (const ax of ['x', 'y', 'z']) for (const tr of prog.grad[ax]) gmaxUsed = Math.max(gmaxUsed, Math.abs(tr.amp));
        const stats = { TR, nAdc: real.length, nSamples, gmaxUsed, readoutDuration: real.length ? real[0].n * real[0].dwell : 0,
            echoSpacing: null, TE: null, TI: null };
        const rf = prog.rf;
        let ri = -1, exc = -1, lastExcForSpacing = -2, lastTc = 0;
        let best = Infinity, bestTE = null, bestExc = -1;
        for (const a of prog.adc) {
            while (ri + 1 < rf.length && rf[ri + 1].t <= a.tc) { ri++; if (rf[ri].role === 'excite') exc = ri; }
            if (a.dummy || exc < 0) continue;
            if (stats.echoSpacing === null && exc === lastExcForSpacing) stats.echoSpacing = a.tc - lastTc;
            lastExcForSpacing = exc; lastTc = a.tc;
            if (a.anchor !== 'center') continue;
            let kx = 0, ky = 0, tPrev = rf[exc].t;
            for (let j = exc + 1; j <= ri; j++) {
                if (rf[j].role !== 'refocus') continue;
                kx = -(kx + gradientArea(prog, 'x', tPrev, rf[j].t));
                ky = -(ky + gradientArea(prog, 'y', tPrev, rf[j].t));
                tPrev = rf[j].t;
            }
            kx += gradientArea(prog, 'x', tPrev, a.tc);
            ky += gradientArea(prog, 'y', tPrev, a.tc);
            const k2 = kx * kx + ky * ky;
            if (k2 < best * (1 - 1e-9)) { best = k2; bestTE = a.tc - rf[exc].t; bestExc = exc; }
        }
        if (bestTE !== null) {
            stats.TE = bestTE;
            for (let j = bestExc - 1; j >= 0 && rf[j].period === rf[bestExc].period; j--) {
                if (rf[j].role === 'invert') { stats.TI = rf[bestExc].t - rf[j].t; break; }
                if (rf[j].role === 'excite') break;
            }
        }
        return stats;
    }

    /* ============================================================
       Public API
       ============================================================ */
    function parse(source) {
        const p = new Parser(source);
        return p.parseProgram();
    }

    // Parameters that can be evaluated even when the rest of the program
    // has errors, so the UI can keep showing its sliders.
    function paramsOnly(ast, source, opts) {
        const ex = new Exec(ast, source, opts);
        for (const s of ast.body) {
            if (s.t !== 'param' && s.t !== 'let') continue;
            try { ex.exec(s); } catch (e) { if (!(e instanceof DslError)) throw e; }
        }
        return ex.params;
    }

    function errorOut(e) { return { line: e.line, col: e.col, msg: e.msg, hint: e.hint || null }; }
    function failed(source, errs, params) {
        errs = errs.slice().sort((a, b) => a.line - b.line || a.col - b.col);
        return { ok: false, source, errors: errs.map(errorOut), params: params || [] };
    }

    /* One compile attempt. Returns {out} (a program, or a failed result for
       syntax errors) or {err, params} for an error found while executing. */
    function compileRaw(source, opts) {
        const ast = parse(source);
        if (ast.errors.length) {
            let params = [];
            try { params = paramsOnly(ast, source, opts); } catch (e) { params = []; }
            return { out: failed(source, ast.errors, params) };
        }
        const ex = new Exec(ast, source, opts);
        try {
            return { out: ex.run() };
        } catch (e) {
            if (!(e instanceof DslError)) throw e;
            return { err: e, params: ex.params };
        }
    }

    /* A "too short" estimate looks at one gap only. Fixing it can expose the
       next one (a spin echo whose 180 fits but whose readout then does not),
       so recompile with the suggested value a few times and report the value
       that actually works, or the best estimate so far. */
    function refineMinimum(source, opts, err) {
        const c0 = err.meta.cands[0], name = c0.name;
        // One extra microsecond of the gap so the trial value clears the 1 us quantisation.
        let val = c0.min + 1e-6 / c0.d, okVal = null;
        for (let tries = 0; tries < 8; tries++) {
            const ov = Object.assign({}, opts.overrides || {});
            ov[name] = val;
            const r = compileRaw(source, { overrides: ov, maxEvents: opts.maxEvents });
            if (r.out && r.out.ok) { okVal = val; break; }
            const m = r.err && r.err.meta;
            if (m && m.kind === 'tooShort' && m.param === name && m.min > val - 1e-12) val = m.min + 1e-6 / m.cands[0].d;
            else break;
        }
        const cands = err.meta.cands.slice();
        cands[0] = Object.assign({}, c0, { min: okVal !== null ? okVal : val });
        err.hint = hintFor(cands);
    }

    function compile(source, opts) {
        opts = opts || {};
        source = source == null ? '' : String(source);
        try {
            const r = compileRaw(source, opts);
            if (r.out) return r.out;
            if (r.err.meta && r.err.meta.kind === 'tooShort') refineMinimum(source, opts, r.err);
            return failed(source, [r.err], r.params);
        } catch (e) {
            return { ok: false, source, params: [], errors: [{ line: 1, col: 1,
                msg: 'Internal error in the sequence compiler: ' + (e && e.message ? e.message : String(e)),
                hint: 'This is a bug in the simulator, not in your sequence.' }] };
        }
    }

    /* Replace the value of a param in the source, written in the param's
       own display unit ("35 ms", "0.8 ms", "128", "2000 Hz/px"). The given
       source is re-parsed to find the param, so this works even if it has
       been edited since `program` was compiled. */
    function setParamInSource(source, program, name, valueSI) {
        source = source == null ? '' : String(source);
        let ast;
        try { ast = parse(source); } catch (e) { return source; }
        const stmt = ast.body.find(s => s.t === 'param' && s.name === name);
        if (!stmt || !isFinite(valueSI)) return source;
        const known = program && program.params ? program.params.find(p => p.name === name) : null;
        let unit = null, scale = 1;
        (function walk(n) {
            if (!n || unit !== null) return;
            if (n.t === 'num' && n.unit) { unit = n.unit; scale = UNITS[n.unit][1]; return; }
            if (n.t === 'neg') walk(n.a);
            else if (n.t === 'bin') { walk(n.a); walk(n.b); }
            else if (n.t === 'call') n.args.forEach(walk);
        })(stmt.expr);
        if (known && (unit === null || UNITS[unit][0] !== KIND_NAME.indexOf(known.kind))) { unit = known.unit; scale = known.scale; }
        if (unit === null) { unit = ''; scale = 1; }
        const text = fmtParamValue({ unit, scale }, valueSI);
        return source.slice(0, stmt.span[0]) + text + source.slice(stmt.span[1]);
    }

    /* Tokens for syntax highlighting. A number token's text includes its
       unit ("90 ms"); unit and unitStart say where the unit begins, so a
       highlighter can colour it separately. */
    function tokenize(source) {
        return lex(source == null ? '' : String(source)).map(t =>
            (t.type === 'number' ? Object.assign({}, t, { kind: KIND_NAME[t.kind] }) : t));
    }

    const keywords = {
        statements: ['sequence', 'param', 'let', 'fov', 'matrix', 'slice', 'bandwidth', 'oversample', 'averages', 'dummies',
            'for', 'in', 'repeat', 'every', 'step', 'end', 'range', 'at', 'as'],
        events: ['rf', 'gx', 'gy', 'gz', 'adc', 'spoil', 'wait'],
        options: ['dur', 'phase', 'bw', 'offset', 'dwell', 'hard', 'slice', 'sinc', 'water', 'fat', 'adiabatic',
            'excite', 'refocus', 'invert', 'saturate', 'readout', 'prephase', 'encode', 'rewind', 'rephase', 'crush', 'blip', 'for'],
        units: Object.keys(UNITS),
        functions: Object.keys(FUNCS),
        constants: ['pi', 'f0', 'Nx', 'Ny']
    };

    const reference = [
        '<div class="dsl-ref">',
        '<p>One statement per line. <code>#</code> starts a comment. Loops close with <code>end</code>. ',
        'Times, lengths, frequencies and gradients always need a unit: write <code>20 ms</code>, not <code>20</code>.</p>',
        '<h4>Setting up</h4>',
        '<table>',
        '<tr><td><code>sequence "Spin echo"</code></td><td>the name shown in the simulator</td></tr>',
        '<tr><td><code>param TE = 90 ms range 12 ms .. 200 ms "echo time"</code></td><td>a value with a slider; range, step and description are optional</td></tr>',
        '<tr><td><code>let half = TE/2</code></td><td>a value worked out from others</td></tr>',
        '<tr><td><code>fov 240 mm</code> <code>matrix 128</code></td><td>field of view and image matrix (give two values for x and y)</td></tr>',
        '<tr><td><code>slice 5 mm</code> <code>bandwidth 250 Hz/px</code></td><td>slice thickness; receiver bandwidth per pixel</td></tr>',
        '<tr><td><code>oversample 2</code> <code>averages 1</code> <code>dummies 2</code></td><td>readout oversampling (1 or 2); NEX; repetitions run first without recording, to reach a steady state</td></tr>',
        '</table>',
        '<h4>Loops</h4>',
        '<table>',
        '<tr><td><code>for line in 0 .. N-1 every TR</code> &hellip; <code>end</code></td><td>whole numbers from 0 to N-1 inclusive; add <code>step 2</code> to skip; <code>every TR</code> starts each pass TR after the previous one</td></tr>',
        '<tr><td><code>repeat NA every TR</code> &hellip; <code>end</code></td><td>a loop without a variable</td></tr>',
        '</table>',
        '<h4>Blocks and events</h4>',
        '<p>One line of events separated by commas is a <em>block</em>. Its events start together, and the next block starts when the longest one has finished.</p>',
        '<table>',
        '<tr><td><code>rf 90 slice</code></td><td>RF pulse: the flip angle (degrees), then a shape: <code>hard</code> (non-selective, 0.5 ms), <code>slice</code> (sinc with its own slice-select gradient, 2 ms), <code>water</code> or <code>fat</code> (spectrally selective, 20 ms), <code>adiabatic</code> (inversion, 10 ms). Options <code>dur</code>, <code>phase</code>, <code>bw</code>, <code>offset</code>. A role <code>excite</code>, <code>refocus</code>, <code>invert</code> or <code>saturate</code> is normally worked out for you</td></tr>',
        '<tr><td><code>gx readout</code></td><td>a gradient on <code>gx</code>, <code>gy</code> or <code>gz</code> (shapes below)</td></tr>',
        '<tr><td><code>adc</code></td><td>record the signal. Next to a <code>readout</code> it sits on the flat top; on its own write <code>adc 2048 dwell 250 us</code></td></tr>',
        '<tr><td><code>spoil</code></td><td>spoiler gradients on all three axes: no transverse magnetisation survives</td></tr>',
        '<tr><td><code>wait 10 ms</code></td><td>a pause</td></tr>',
        '</table>',
        '<h4>Gradient shapes</h4>',
        '<table>',
        '<tr><td><code>readout</code></td><td>constant gradient while the ADC samples, G = N &times; BW / (&gamma;&#772; &times; FOV)</td></tr>',
        '<tr><td><code>prephase</code></td><td>moves k to the start of the line, so the middle sample lands on k = 0</td></tr>',
        '<tr><td><code>encode L</code>, <code>rewind L</code></td><td>phase encoding to line L (0 to N-1, ky = (L - N/2)/FOV) and its undoing</td></tr>',
        '<tr><td><code>rephase</code></td><td>on gz: refocuses the dephasing left by the last slice-selective excitation</td></tr>',
        '<tr><td><code>crush</code>, <code>blip</code></td><td>a crusher (2 cycles across the slice); a one-line step in k-space (EPI)</td></tr>',
        '<tr><td><code>10 mT/m for 2 ms</code></td><td>an explicit trapezoid (ramps are added at the slew limit)</td></tr>',
        '</table>',
        '<p>A minus in front flips the sign (<code>gx -prephase</code>). <code>* expr</code> scales the amplitude and keeps the timing (<code>gx readout * cos(a)</code>, <code>gx readout * (-1)^line</code>).</p>',
        '<h4>Timing with at and as</h4>',
        '<p><code>rf 90 slice as exc</code> names the block&#39;s anchor <code>exc</code>. <code>gx readout, adc at exc + TE</code> places a block so that its anchor falls at that time, measured from the start of the current repetition. ',
        'The anchor is the RF centre; or, for a readout, the echo (the middle ADC sample); or the first sample of a bare ADC; otherwise the block start. ',
        'If a block would have to start before the previous one ends, the error says which parameter to increase and by how much.</p>',
        '<h4>Units and maths</h4>',
        '<p>time <code>s ms us</code>; length <code>mm cm</code>; angle <code>deg rad</code>; frequency <code>Hz kHz MHz Hz/px</code>; gradient <code>mT/m T/m</code>; slew <code>T/m/s</code>; <code>ppm</code>. ',
        'Operators <code>+ - * / ^</code> (write <code>(-1)^line</code>). Functions <code>sin cos tan sqrt abs floor ceil round min max mod exp log</code>. Constants <code>pi</code>, <code>f0</code>, and <code>Nx</code>, <code>Ny</code> after <code>matrix</code>. ',
        'Adding a time to a length, or to a plain number, is an error: that is how missing units are caught.</p>',
        '<h4>Example: spoiled gradient echo</h4>',
        '<pre>param TR = 100 ms\nparam TE = 5 ms\nmatrix 64\nfor line in 0 .. 63 every TR\n    rf 30 slice as exc\n    gz rephase, gx prephase, gy encode line\n    gx readout, adc at exc + TE\n    spoil\nend</pre>',
        '<h4>Example: pulse-acquire FID</h4>',
        '<pre>repeat 8 every 3 s\n    rf 90 hard dur 0.1 ms as exc\n    adc 2048 dwell 250 us at exc + 0.25 ms\nend</pre>',
        '</div>'
    ].join('\n');

    MRI.dsl = {
        compile,
        setParamInSource,
        tokenize,
        keywords,
        gradientAt,
        gradientArea,
        reference,
        formatParam: (p, valueSI) => fmtParamValue(p, valueSI === undefined ? p.value : valueSI)
    };

})(typeof window !== 'undefined' ? window : globalThis);
