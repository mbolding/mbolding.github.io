/* ============================================================
   PET Simulator, the protocol language
   A small language in which students write a scan protocol (the
   tracer, the injected dose, the uptake time, the framing, the
   energy and coincidence windows, time of flight), and the
   compiler that turns it into a Program: frames measured from the
   injection, windows in internal units, and the numbers the UI
   shows (see ARCHITECTURE.md section 7).

   The pipeline is the one the MRI simulator's pulse-sequence
   language uses, much shortened because a protocol has no loops
   or timing blocks:
     lex      source text -> tokens (numbers carry their units)
     parse    tokens -> one syntax node per line
     execute  run the lines in order on the protocol clock, checking
              units and limits, then the whole-protocol checks (is
              anything injected? is anything acquired?)

   Every value carries a physical kind (time, activity, energy,
   mass, length), so "UPTAKE + 5" is caught with a helpful message
   instead of silently meaning five seconds. Units are part of the
   lesson.

   Errors are collected, not fatal: each line is checked on its own,
   and a name whose definition failed is quietly skipped where it is
   used later, so a student sees every real mistake at once without
   a cascade of follow-on errors. compile() never throws.

   Internal units: s, Bq, keV, kg, mm. No DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    const U = PET.util;

    /* ---------- Defaults and limits ----------
       Values outside LIMITS are errors (the simulator cannot model
       them sensibly). The WARN thresholds only produce warnings,
       because seeing what goes wrong there is the point of a lesson. */
    const DEFAULTS = {
        weight: 70,                          // kg
        energy: { lo: 435, hi: 650 },        // keV, a typical LYSO window
        coincidence: 4.5e-9,                 // s, total width of the window
        tof: { on: true, ctr: 400e-12 },     // s, CTR FWHM (scanner.geom.ctrDefault)
        acqMode: '3D'
    };
    const LIMITS = {
        dose: 2e9,                           // Bq: 0 < A <= 2 GBq
        weight: [20, 200],                   // kg
        lld: [250, 510],                     // keV, lower level: below the photopeak
        uld: [520, 800],                     // keV, upper level: above the photopeak
        coincidence: [0.5e-9, 20e-9],        // s
        ctr: [100e-12, 1000e-12],            // s
        maxFrames: 64,
        maxEnd: 6 * 3600                     // s after the injection
    };
    const WARN = {
        lld: 350,                            // keV: below this a lot of scatter gets in
        coincidence: 2.5e-9,                 // s: below this trues at the FOV edge are lost
        halfLives: 5,                        // scan start, in half-lives after the injection
        doseFactor: 2                        // times the tracer's typical dose
    };
    const MAX_ERRORS = 40;

    /* ---------- Kinds (physical dimensions) ----------
       Small integers internally, strings in the output. KIND_UNIT is
       the display unit of a param written without a unit literal of
       its own (param LATE = 2 * T_half shows in min). */
    const NONE = 0, TIME = 1, ACT = 2, ENERGY = 3, MASS = 4, LENGTH = 5;
    const KIND_NAME = ['none', 'time', 'activity', 'energy', 'mass', 'length'];
    const KIND_PHRASE = ['a plain number', 'a time', 'an activity', 'an energy', 'a mass', 'a length'];
    const KIND_UNIT = [{ u: '', s: 1 }, { u: 'min', s: 60 }, { u: 'MBq', s: 1e6 },
        { u: 'keV', s: 1 }, { u: 'kg', s: 1 }, { u: 'mm', s: 1 }];

    /* Units: [kind, internal units per unit]. Both micro signs are
       accepted (U+00B5 from a keyboard, U+03BC from pasted text). */
    const UNITS = {
        s: [TIME, 1], ms: [TIME, 1e-3], us: [TIME, 1e-6], 'µs': [TIME, 1e-6], 'μs': [TIME, 1e-6],
        ns: [TIME, 1e-9], ps: [TIME, 1e-12], min: [TIME, 60], h: [TIME, 3600],
        Bq: [ACT, 1], kBq: [ACT, 1e3], MBq: [ACT, 1e6], GBq: [ACT, 1e9],
        mCi: [ACT, 37e6], uCi: [ACT, 37e3], 'µCi': [ACT, 37e3], 'μCi': [ACT, 37e3],
        keV: [ENERGY, 1], MeV: [ENERGY, 1e3],
        kg: [MASS, 1], g: [MASS, 1e-3],
        mm: [LENGTH, 1], cm: [LENGTH, 10]
    };
    // Longest first, and never followed by a letter or digit, so "min" is
    // not read as "m" + "in" and "mins" is not a unit at all.
    const UNIT_RE = new RegExp('(' + Object.keys(UNITS).sort((a, b) => b.length - a.length).join('|') + ')(?![A-Za-z0-9_])', 'y');
    // Spellings students reach for, mapped to the unit they meant.
    const UNIT_TYPOS = {
        sec: 's', secs: 's', second: 's', seconds: 's', mins: 'min', minute: 'min', minutes: 'min',
        hr: 'h', hrs: 'h', hour: 'h', hours: 'h', nsec: 'ns', psec: 'ps', msec: 'ms', kilogram: 'kg', kilograms: 'kg'
    };

    const STATEMENTS = ['protocol', 'param', 'let', 'tracer', 'isotope', 'inject', 'weight', 'wait', 'static',
        'frames', 'energy', 'coincidence', 'tof', 'mode'];
    const OPTIONS = ['range', 'step', 'at', 'on', 'off'];
    const RESERVED = new Set(STATEMENTS.concat(OPTIONS));
    // Functions keep their argument's kind. They work on internal units,
    // so round(UPTAKE) rounds to whole seconds; round(UPTAKE / 1 min) * 1 min
    // rounds to whole minutes.
    const FUNCS = { min: -1, max: -1, round: 1, floor: 1, ceil: 1, abs: 1 };
    // Words students try as statements, mapped to the statement that does that job.
    const SYNONYMS = {
        scan: 'static', acquire: 'static', acquisition: 'static', frame: 'frames', dynamic: 'frames',
        dose: 'inject', injection: 'inject', activity: 'inject', delay: 'wait', uptake: 'wait', pause: 'wait',
        window: 'energy', timing: 'coincidence', septa: 'mode', nuclide: 'isotope', radionuclide: 'isotope',
        radiotracer: 'tracer', title: 'protocol', name: 'protocol', set: 'let', var: 'let', const: 'let', mass: 'weight'
    };
    const EXAMPLE = {
        protocol: 'protocol "FDG brain, static"', param: 'param UPTAKE = 45 min range 0 min .. 120 min "uptake time"',
        let: 'let LATE = UPTAKE + 20 min', tracer: 'tracer FDG', isotope: 'isotope F18', inject: 'inject 185 MBq',
        weight: 'weight 70 kg', wait: 'wait 45 min', static: 'static 10 min', frames: 'frames 6 x 10 s',
        energy: 'energy 435 keV .. 650 keV', coincidence: 'coincidence 4.5 ns', tof: 'tof on 400 ps', mode: 'mode 3D'
    };

    /* ---------- Small helpers ---------- */
    const num = (x, sig) => String(Number(x.toPrecision(sig || 4)));
    const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
    const isDigit = c => c >= '0' && c <= '9';
    const isLetter = c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
    // F18 -> 18F, the way the mass number is usually written in prose.
    const massFirst = id => String(id).replace(/^([A-Z][a-z]?)(\d+)$/, '$2$1');
    const article = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;

    function fmtVal(v, k) {
        switch (k) {
            case TIME: return v === 0 ? '0 s' : U.fmtTime(v, 3);
            case ACT: return U.fmtActivity(v, 3);
            case ENERGY: return num(v) + ' keV';
            case MASS: return num(v) + ' kg';
            case LENGTH: return U.fmtLen(v, 3);
            default: return num(v);
        }
    }
    // A param value in its own display unit: "45 min", "185 MBq", "6".
    function fmtParamValue(p, v) {
        const x = v / (p.scale || 1);
        let s = String(Number(x.toPrecision(6)));
        if (s === '-0') s = '0';
        return p.unit ? s + ' ' + p.unit : s;
    }

    // Edit distance in which swapping two neighbouring letters counts as one
    // edit (optimal string alignment), so FGD is one step from FDG.
    function editDistance(a, b) {
        const m = a.length, n = b.length, d = [];
        for (let i = 0; i <= m; i++) { d.push(new Array(n + 1)); d[i][0] = i; }
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
            }
        }
        return d[m][n];
    }
    // "Did you mean ...?" for typos: case differences count as a match.
    function suggest(word, cands) {
        const lw = word.toLowerCase();
        let best = null, bd = Infinity;
        for (const c of cands) {
            const d = editDistance(lw, c.toLowerCase());
            if (d < bd) { bd = d; best = c; }
        }
        const lim = word.length <= 3 ? 1 : 2;
        return best !== null && best !== word && bd <= lim ? best : null;
    }
    // The unit a misspelt unit word most likely meant, or null.
    function unitFor(word) {
        if (!word) return null;
        if (UNIT_TYPOS[word.toLowerCase()]) return UNIT_TYPOS[word.toLowerCase()];
        for (const u in UNITS) if (u.toLowerCase() === word.toLowerCase()) return u;
        return null;
    }
    const UNIT_LIST = 'time s ms us ns ps min h; activity Bq kBq MBq GBq mCi uCi; energy keV MeV; mass kg g; length mm cm';
    function unitHint(word) {
        if (word === 'm') return 'For minutes write min, for millimetres mm.';
        const u = unitFor(word);
        return u ? 'Did you mean ' + u + '?' : 'The units are: ' + UNIT_LIST + '.';
    }
    const tracerIds = () => PET.tracers.list().map(t => t.id);
    const tracersOf = iso => PET.tracers.list().filter(t => t.isotope === iso).map(t => t.id);

    /* Errors carry a source position and a hint. They are thrown inside the
       compiler and always caught by compile(). POISON is thrown when a value
       depends on a line that already failed: that line has its error, so the
       one that uses it is skipped without a second, confusing message. */
    class DslError {
        constructor(msg, pos, hint, global) {
            this.msg = msg;
            this.line = (pos && pos.line) || 1;
            this.col = (pos && pos.col) || 1;
            this.hint = hint || null;
            this.global = !!global;        // about the whole protocol, not this line
        }
    }
    const fail = (msg, pos, hint) => { throw new DslError(msg, pos, hint); };
    const POISON = { poison: true };

    /* ============================================================
       Lexer
       Tokens: number (value in internal units, kind and unit), string,
       ident, keyword, op, comment, newline, error. Every token records
       line, col (both 1-based), start and end (character offsets).
       A unit is recognised only straight after a number literal, with
       or without a space. Letters glued to a number that are not a
       unit make one word ("18F", "3D"), which the isotope and mode
       statements read. "x" between a count and a duration is the
       frames operator, so "6x10s" reads as 6, x, 10 s.
       ============================================================ */
    const NUM_RE = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    // A hyphen may join two parts of a name (FE-PE2I) but never ends one,
    // so "DOSE- 1 MBq" still subtracts.
    const IDENT_RE = /[A-Za-z_](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_]))*/y;
    const WORD_RE = /[A-Za-z0-9_]+/y;
    const OPS1 = '+-*/(),=';

    function lex(src) {
        const toks = [], n = src.length;
        let i = 0, line = 1, ls = 0;
        const push = (type, start, end, extra) => {
            const t = { type, text: src.slice(start, end), line, col: start - ls + 1, start, end };
            if (extra) Object.assign(t, extra);
            toks.push(t);
            return t;
        };
        const afterNumber = () => { const p = toks[toks.length - 1]; return !!p && p.type === 'number' && p.line === line; };
        const xFollows = j => j >= n || /[\d\s(]/.test(src[j]);
        while (i < n) {
            const c = src[i];
            if (c === '\n') { push('newline', i, i + 1); i++; line++; ls = i; continue; }
            if (c === ' ' || c === '\t' || c === '\r' || c === ' ' || c === '\f' || c === '\v') { i++; continue; }
            if (c === '#') {
                let j = i; while (j < n && src[j] !== '\n') j++;
                push('comment', i, j); i = j; continue;
            }
            if (isDigit(c)) {
                NUM_RE.lastIndex = i;
                const m = NUM_RE.exec(src);
                const j = i + m[0].length, raw = parseFloat(m[0]);
                if ((src[j] === 'x' || src[j] === 'X') && xFollows(j + 1)) {
                    push('number', i, j, { num: raw, value: raw, kind: NONE, unit: '' });
                    push('op', j, j + 1, { op: 'x' });
                    i = j + 1; continue;
                }
                let k = j;
                while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
                UNIT_RE.lastIndex = k;
                const u = UNIT_RE.exec(src);
                if (u) {
                    const def = UNITS[u[1]];
                    push('number', i, k + u[0].length, { num: raw, value: raw * def[1], kind: def[0], unit: u[1], unitStart: k, numEnd: j });
                    i = k + u[0].length; continue;
                }
                if (j < n && isLetter(src[j])) {
                    WORD_RE.lastIndex = j;
                    const w = WORD_RE.exec(src)[0];
                    push('ident', i, j + w.length, { numWord: true });
                    i = j + w.length; continue;
                }
                push('number', i, j, { num: raw, value: raw, kind: NONE, unit: '' });
                i = j; continue;
            }
            if (isLetter(c)) {
                if ((c === 'x' || c === 'X') && afterNumber() && xFollows(i + 1)) { push('op', i, i + 1, { op: 'x' }); i++; continue; }
                IDENT_RE.lastIndex = i;
                const w = IDENT_RE.exec(src)[0];
                if (w === 'x') push('op', i, i + 1, { op: 'x' });
                else push(RESERVED.has(w) ? 'keyword' : 'ident', i, i + w.length);
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
                if (isDigit(src[i + 1] || '')) {
                    push('error', i, i + 1, { msg: 'A number cannot start with a decimal point; write 0.5, not .5.' });
                    i++; continue;
                }
            }
            if (OPS1.indexOf(c) >= 0) { push('op', i, i + 1, { op: c }); i++; continue; }
            // Typographic signs, as pasted from documents.
            if (c === '−' || c === '–') { push('op', i, i + 1, { op: '-' }); i++; continue; }
            if (c === '×') { push('op', i, i + 1, { op: 'x' }); i++; continue; }
            if (c === '…') { push('op', i, i + 1, { op: '..' }); i++; continue; }
            if (c === '[' || c === ']') {
                push('error', i, i + 1, { msg: 'Square brackets are not part of the language.',
                    hint: 'Write the tracer name alone, for example tracer PiB: the isotope follows from the tracer.' });
                i++; continue;
            }
            push('error', i, i + 1, { msg: 'The character "' + c + '" is not part of the language.' });
            i++;
        }
        return toks;
    }

    /* ============================================================
       Parser: recursive descent, one statement per line, precedence
       climbing for expressions. A line with a syntax error is
       recorded and skipped; `failed` remembers which statements those
       lines were (so the whole-protocol checks do not also say "no
       inject line") and `badNames` which names they would have
       defined (so later uses are skipped quietly).
       ============================================================ */
    const BINPREC = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const endText = t => (t.type === 'newline' || t.type === 'eof' ? 'the end of the line' : '"' + t.text + '"');

    class Parser {
        constructor(src) {
            this.toks = lex(src).filter(t => t.type !== 'comment');
            const lines = src.split('\n');
            this.toks.push({ type: 'eof', text: '', line: lines.length, col: lines[lines.length - 1].length + 1, start: src.length, end: src.length });
            this.i = 0;
            this.errors = [];
            this.failed = new Map();       // statement word -> line, for lines that did not parse
            this.badNames = new Set();
            this.lastLine = 1;
        }
        peek(o) { return this.toks[Math.min(this.i + (o || 0), this.toks.length - 1)]; }
        // Never steps past a line break, so a statement that fails cannot eat the next line.
        next() { const t = this.toks[this.i]; if (t.type !== 'newline' && t.type !== 'eof') this.i++; return t; }
        prevEnd() { return this.toks[Math.max(0, this.i - 1)].end; }
        isOp(t, op) { return t.type === 'op' && t.op === op; }
        isKw(t, kw) { return t.type === 'keyword' && t.text === kw; }
        atEOL() { const t = this.peek(); return t.type === 'newline' || t.type === 'eof'; }
        skipLine() { while (!this.atEOL()) this.i++; }
        eol() {
            if (this.atEOL()) return;
            const t = this.peek(), prev = this.toks[this.i - 1];
            if (t.type === 'error') fail(t.msg, t, t.hint);
            let hint = null;
            if (t.type === 'ident' && prev && prev.type === 'number' && !prev.unit && unitFor(t.text)) {
                const u = unitFor(t.text);
                fail('"' + t.text + '" is not a unit.', t, 'Did you mean ' + prev.text + ' ' + u + '?' + (u.toLowerCase() === t.text.toLowerCase() ? ' Units are case-sensitive.' : ''));
            }
            if (t.type === 'keyword' && STATEMENTS.indexOf(t.text) >= 0) hint = 'One statement per line: start a new line for ' + t.text + '.';
            else if (prev && prev.type === 'ident' && prev.text.indexOf('-') > 0 && !PET.tracers.normalizeId(prev.text)) {
                hint = 'To subtract, put spaces around the minus sign: ' + prev.text.replace('-', ' - ') + (UNITS[t.text] ? ' ' + t.text : '') + '.';
            }
            else if (t.type === 'ident' && prev && prev.type === 'number' && !prev.unit) hint = 'If "' + t.text + '" is meant as a unit: ' + unitHint(t.text);
            else if (this.isOp(t, 'x')) hint = 'x only separates the count from the duration in frames N x D; to multiply, use *.';
            fail('Unexpected ' + endText(t) + ' here.', t, hint);
        }
        expectOp(op, hint) {
            const t = this.next();
            if (t.type === 'error') fail(t.msg, t, t.hint);
            if (!this.isOp(t, op)) fail('Expected "' + op + '" but found ' + endText(t) + '.', t, hint);
            return t;
        }
        expectName(what) {
            const t = this.next();
            if (t.type === 'ident' && !t.numWord) return t;
            if (t.type === 'keyword') fail('"' + t.text + '" is a reserved word and cannot be used as a ' + what + ' name.', t, 'Choose another name, for example my_' + t.text + '.');
            if (this.isOp(t, 'x')) fail('"x" is the frames operator (frames 6 x 10 s), so it cannot be a ' + what + ' name.', t, 'Choose another name.');
            fail('Expected a ' + what + ' name here.', t, 'Names start with a letter and may contain letters, digits and _.');
        }

        parseProgram() {
            const body = [];
            for (;;) {
                if (this.errors.length >= MAX_ERRORS) break;
                const t = this.peek();
                if (t.type === 'newline') { this.i++; continue; }
                if (t.type === 'eof') break;
                const start = this.i;
                this.lastLine = t.line;
                try {
                    const s = this.parseStatement();
                    if (s) body.push(s);
                } catch (e) {
                    if (!(e instanceof DslError)) throw e;
                    this.errors.push(e);
                    // What the line was meant to be: a misspelt "Tracer" or "scan" still
                    // counts as a tracer or static line for the whole-protocol checks.
                    const first = this.toks[start], second = this.toks[start + 1];
                    let word = null;
                    if (first.type === 'keyword') word = first.text;
                    else if (first.type === 'ident' && !this.isOp(second, '=')) {
                        const low = first.text.toLowerCase();
                        word = STATEMENTS.indexOf(low) >= 0 ? low : (suggest(first.text, STATEMENTS) || SYNONYMS[low] || null);
                    }
                    if (word && !this.failed.has(word)) this.failed.set(word, first.line);
                    if ((first.text === 'param' || first.text === 'let') && second.type === 'ident') this.badNames.add(second.text);
                    if (first.type === 'ident' && this.isOp(second, '=')) this.badNames.add(first.text);
                    this.skipLine();
                }
            }
            return { body, errors: this.errors, failed: this.failed, badNames: this.badNames, lastLine: this.lastLine };
        }

        parseStatement() {
            const t = this.peek();
            if (t.type === 'error') fail(t.msg, t, t.hint);
            if (t.type === 'keyword') {
                switch (t.text) {
                    case 'protocol': {
                        this.next();
                        const s = this.next();
                        if (s.type === 'error') fail(s.msg, s, s.hint);
                        if (s.type !== 'string') fail('protocol needs a title in double quotes.', s.type === 'newline' || s.type === 'eof' ? t : s, 'For example: ' + EXAMPLE.protocol);
                        this.eol();
                        return { t: 'protocol', title: s.value, line: t.line, col: t.col };
                    }
                    case 'param': return this.parseParam();
                    case 'let': {
                        this.next();
                        const nameTok = this.expectName('variable');
                        this.expectOp('=', 'Write: let ' + nameTok.text + ' = UPTAKE + 20 min');
                        if (this.atEOL()) fail('let ' + nameTok.text + ' needs a value after "=".', this.peek());
                        const expr = this.parseExpr();
                        this.eol();
                        return { t: 'let', name: nameTok.text, nameTok, expr, line: t.line, col: t.col };
                    }
                    case 'tracer': case 'isotope': return this.parseWordStatement(t);
                    case 'inject': {
                        this.next();
                        if (this.atEOL()) fail('inject needs an activity, for example inject 185 MBq.', t);
                        const dose = this.parseExpr();
                        let at = null;
                        if (this.isKw(this.peek(), 'at')) {
                            const a = this.next();
                            if (this.atEOL()) fail('"at" needs a time on the protocol clock, for example inject DOSE at 2 min.', a);
                            at = this.parseExpr();
                        }
                        this.eol();
                        return { t: 'inject', dose, at, line: t.line, col: t.col };
                    }
                    case 'weight': case 'wait': case 'static': case 'coincidence': {
                        this.next();
                        if (this.atEOL()) fail(t.text + ' needs a value.', t, 'For example: ' + EXAMPLE[t.text]);
                        const expr = this.parseExpr();
                        this.eol();
                        return { t: t.text, expr, line: t.line, col: t.col };
                    }
                    case 'frames': return this.parseFrames(t);
                    case 'energy': {
                        this.next();
                        if (this.atEOL()) fail('energy needs a window, lower level .. upper level.', t, 'For example: ' + EXAMPLE.energy);
                        const lo = this.parseExpr();
                        this.expectOp('..', 'Write the window with two dots: ' + EXAMPLE.energy);
                        const hi = this.parseExpr();
                        this.eol();
                        return { t: 'energy', lo, hi, line: t.line, col: t.col };
                    }
                    case 'tof': {
                        this.next();
                        const o = this.next();
                        if (!this.isKw(o, 'on') && !this.isKw(o, 'off')) {
                            fail('tof is followed by on or off.', o.type === 'newline' || o.type === 'eof' ? t : o, 'For example: tof on 400 ps, or tof off.');
                        }
                        const ctr = this.atEOL() ? null : this.parseExpr();
                        this.eol();
                        return { t: 'tof', on: o.text === 'on', ctr, line: t.line, col: t.col };
                    }
                    case 'mode': {
                        this.next();
                        const o = this.next();
                        if (!(o.type === 'ident' && /^[23]d$/i.test(o.text))) {
                            fail('mode is 3D (septa out) or 2D (septa in).', o.type === 'newline' || o.type === 'eof' ? t : o, 'For example: mode 3D');
                        }
                        this.eol();
                        return { t: 'mode', mode: o.text.toUpperCase(), line: t.line, col: t.col };
                    }
                }
                const hints = {
                    range: 'range belongs to a param line: ' + EXAMPLE.param,
                    step: 'step belongs to a param line: param DOSE = 185 MBq range 40 MBq .. 400 MBq step 5 MBq',
                    at: '"at" belongs to an inject line: inject DOSE at 2 min',
                    on: 'on belongs to a tof line: tof on 400 ps', off: 'off belongs to a tof line: tof off'
                };
                fail('A line cannot start with "' + t.text + '".', t, hints[t.text]);
            }
            if (t.type === 'ident') {
                const low = t.text.toLowerCase(), syn = SYNONYMS[low], sug = suggest(t.text, STATEMENTS);
                let hint;
                if (this.isOp(this.peek(1), '=')) hint = 'To declare a value write: param ' + t.text + ' = ... (with a slider) or let ' + t.text + ' = ...';
                else if (STATEMENTS.indexOf(low) >= 0) hint = 'Statements are written in lower case: ' + low + '.';
                else if (sug) hint = 'Did you mean ' + sug + '?';
                else if (syn) hint = 'Did you mean ' + syn + '? For example: ' + EXAMPLE[syn];
                else if (PET.tracers.normalizeId(t.text)) hint = 'To name the tracer write: tracer ' + t.text;
                else if (PET.isotopes.normalizeId(t.text)) hint = 'To name the isotope write: isotope ' + t.text;
                else hint = 'A line starts with a statement: ' + STATEMENTS.join(', ') + '.';
                fail('Unknown statement "' + t.text + '".', t, hint);
            }
            fail('A line cannot start with ' + endText(t) + '.', t, 'A line starts with a statement such as tracer, inject, wait, static or frames.');
        }

        // tracer ID / isotope ID: a bare word (FDG, FE-PE2I, 18F) or a string.
        parseWordStatement(t) {
            this.next();
            const o = this.next();
            if (o.type === 'newline' || o.type === 'eof') fail(t.text + ' needs a name.', t, 'For example: ' + EXAMPLE[t.text]);
            if (o.type === 'error') fail(o.msg, o, o.hint);
            if (o.type === 'number') {
                const p = this.peek();
                const glued = p.type === 'ident' ? o.text + p.text : null;
                fail('Expected ' + (t.text === 'tracer' ? 'a tracer' : 'an isotope') + ' name but found the number ' + o.text + '.', o,
                    glued && PET.isotopes.normalizeId(glued) ? 'Write it without a space: isotope ' + glued + '.' : 'For example: ' + EXAMPLE[t.text]);
            }
            if (o.type !== 'ident' && o.type !== 'string' && o.type !== 'keyword') fail('Expected ' + (t.text === 'tracer' ? 'a tracer' : 'an isotope') + ' name but found ' + endText(o) + '.', o, 'For example: ' + EXAMPLE[t.text]);
            if (t.text === 'tracer' && !this.atEOL()) {
                // "tracer 18F-FDG": the isotope glued to the name.
                let j = this.i, cand = null;
                for (; this.toks[j].type !== 'newline' && this.toks[j].type !== 'eof'; j++) {
                    if (!cand && PET.tracers.normalizeId(this.toks[j].text)) cand = PET.tracers.normalizeId(this.toks[j].text);
                }
                if (cand) fail('Write the tracer name alone.', o, 'For example: tracer ' + cand + '; the isotope follows from the tracer.');
            }
            this.eol();
            return { t: t.text, word: o.type === 'string' ? o.value : o.text, tok: o, line: t.line, col: t.col };
        }

        parseParam() {
            const t = this.next();
            const nameTok = this.expectName('parameter');
            this.expectOp('=', 'Write: param ' + nameTok.text + ' = 45 min');
            const first = this.peek();
            if (first.type === 'newline' || first.type === 'eof') fail('param ' + nameTok.text + ' needs a value after "=".', first);
            const expr = this.parseExpr();
            const span = [first.start, this.prevEnd()];
            let range = null, step = null, desc = null;
            while (!this.atEOL()) {
                const o = this.next();
                if (this.isKw(o, 'range') && !range) {
                    const lo = this.parseExpr();
                    this.expectOp('..', 'Write the range with two dots: range 0 min .. 120 min');
                    range = [lo, this.parseExpr()];
                } else if (this.isKw(o, 'step') && !step) step = this.parseExpr();
                else if (o.type === 'string' && desc === null) desc = o.value;
                else if (o.type === 'error') fail(o.msg, o, o.hint);
                else fail('Unexpected "' + o.text + '" in the param line.', o, 'After the value you may add range LO .. HI, step S and a "description".');
            }
            return { t: 'param', name: nameTok.text, nameTok, expr, range, step, desc, span, line: t.line, col: t.col };
        }

        parseFrames(t) {
            this.next();
            const example = 'Write the number of frames, x, then the duration of each: ' + EXAMPLE.frames + '.';
            if (this.atEOL()) fail('frames needs a count and a duration.', t, example);
            const count = this.parseExpr();
            if (!this.isOp(this.peek(), 'x')) {
                const p = this.peek();
                if (p.type === 'error') fail(p.msg, p, p.hint);
                if (count.t === 'bin' && count.op === '*') fail('Use x, not *, between the number of frames and their duration.', count, example);
                if (this.atEOL()) fail('frames needs a count and a duration.', count, example);
                fail('Expected "x" between the number of frames and their duration but found ' + endText(p) + '.', p, example);
            }
            const x = this.next();
            if (this.atEOL()) fail('frames needs a duration after "x".', x, example);
            const dur = this.parseExpr();
            this.eol();
            return { t: 'frames', count, dur, line: t.line, col: t.col };
        }

        /* Expressions. Precedence, loosest first: + -, then * /, then unary
           minus. A node records its position for error messages. */
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
            return this.parsePrimary();
        }
        parsePrimary() {
            const t = this.next();
            if (t.type === 'number') return { t: 'num', v: t.value, k: t.kind, unit: t.unit, line: t.line, col: t.col, start: t.start, end: t.end };
            if (t.type === 'ident') {
                if (t.numWord) {
                    if (PET.isotopes.normalizeId(t.text)) fail('"' + t.text + '" is an isotope, not a value.', t, 'Name it on its own line: isotope ' + t.text);
                    const m = /^([\d.]+(?:[eE][+-]?\d+)?)(.*)$/.exec(t.text);
                    const u = m && unitFor(m[2]);
                    fail('"' + t.text + '" is not a number followed by a known unit.', t, u ? 'Did you mean ' + m[1] + ' ' + u + '?' : unitHint(m ? m[2] : ''));
                }
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
            if (t.type === 'error') fail(t.msg, t, t.hint);
            if (t.type === 'newline' || t.type === 'eof') fail('The line ends where a value was expected.', t);
            if (t.type === 'keyword') fail('Expected a value but found the keyword "' + t.text + '".', t, '"' + t.text + '" is a reserved word, so it cannot be used as a name.');
            if (t.type === 'string') fail('Expected a value but found the text ' + t.text + '.', t, 'Text in double quotes is only for the protocol title and param descriptions.');
            fail('Expected a value but found "' + t.text + '".', t);
        }
    }

    /* ============================================================
       Execution: run the lines in order on the protocol clock.
       The clock starts at 0 at the top of the protocol; wait, static
       and frames move it forward. The injection happens at the clock
       time of the inject line, or at "at T". Frames are stored in
       clock time while running and converted to times relative to the
       injection at the end, so a frame written before the injection
       has a negative start.
       ============================================================ */
    class Exec {
        constructor(ast, source, opts) {
            this.ast = ast;
            this.source = source;
            this.overrides = (opts && opts.overrides) || {};
            this.vars = Object.create(null);
            ast.badNames.forEach(nm => { this.vars[nm] = { poison: true }; });
            this.params = [];
            this.lets = {};
            this.warnings = [];
            this.errors = [];
            this.name = 'Untitled protocol';
            this.seen = Object.create(null);           // statement word -> line of its first appearance
            ast.failed.forEach((ln, w) => { this.seen[w] = ln; });
            this.setLine = Object.create(null);        // one-off settings -> line, to catch duplicates
            this.isoPoison = ast.failed.has('tracer') || ast.failed.has('isotope');
            this.clock = 0;                            // s since the start of the protocol
            this.tracer = undefined;                   // undefined: no tracer line; null: tracer none
            this.tracerStmt = null;
            this.isotope = null;
            this.isoStmt = null;
            this.dose = null;
            this.injectAt = null;
            this.injectLine = 0;
            this.weight = DEFAULTS.weight;
            this.energy = { lo: DEFAULTS.energy.lo, hi: DEFAULTS.energy.hi };
            this.coincidence = DEFAULTS.coincidence;
            this.tof = { on: DEFAULTS.tof.on, ctr: DEFAULTS.tof.ctr };
            this.acqMode = DEFAULTS.acqMode;
            this.frames = [];                          // {t0, t1, line} in clock time
        }

        run() {
            for (const s of this.ast.body) {
                if (this.errors.length + this.ast.errors.length >= MAX_ERRORS) break;
                try { this.exec(s); }
                catch (e) {
                    if (e !== POISON) {
                        if (!(e instanceof DslError)) throw e;
                        this.errors.push(e);
                    }
                    if ((s.t === 'param' || s.t === 'let') && !this.vars[s.name]) this.vars[s.name] = { poison: true };
                    if ((s.t === 'tracer' || s.t === 'isotope') && !this.isotope) this.isoPoison = true;
                }
            }
            return this.finish();
        }

        exec(s) {
            if (!(s.t in this.seen)) this.seen[s.t] = s.line;
            switch (s.t) {
                case 'protocol': this.once(s); this.name = s.title; break;
                case 'param': this.execParam(s); break;
                case 'let': this.execLet(s); break;
                case 'tracer': this.execTracer(s); break;
                case 'isotope': this.execIsotope(s); break;
                case 'inject': this.execInject(s); break;
                case 'weight': this.execWeight(s); break;
                case 'wait': {
                    const T = this.evalKind(s.expr, TIME, 'wait', 'min');
                    if (T < 0) fail('wait cannot go back in time (got ' + fmtVal(T, TIME) + ').', s.expr,
                        'To start the scan before the injection, put the frames first and use inject ... at T.');
                    this.clock += T;
                    break;
                }
                case 'static': {
                    const D = this.evalKind(s.expr, TIME, 'static', 'min');
                    if (!(D > 0)) fail('A frame must last longer than zero (got ' + fmtVal(D, TIME) + ').', s.expr, 'For example: ' + EXAMPLE.static);
                    this.addFrames(1, D, s);
                    break;
                }
                case 'frames': this.execFrames(s); break;
                case 'energy': this.execEnergy(s); break;
                case 'coincidence': this.execCoincidence(s); break;
                case 'tof': this.execTof(s); break;
                case 'mode': this.once(s); this.acqMode = s.mode; break;
            }
        }

        // Settings that may appear only once.
        once(s) {
            if (this.setLine[s.t]) fail('"' + s.t + '" is already set on line ' + this.setLine[s.t] + '.', s, 'Remove one of the two lines.');
            this.setLine[s.t] = s.line;
        }
        warn(line, msg) { this.warnings.push({ line, msg }); }

        /* ---------- Expression evaluation ----------
           A value is any object with fields v (internal units) and k
           (kind). Number nodes already have that shape. */
        eval(n) {
            switch (n.t) {
                case 'num': return n;
                case 'var': {
                    if (n.name === 'T_half') return this.halfLifeValue(n);
                    const e = this.vars[n.name];
                    if (e === undefined) this.unknownName(n);
                    if (e.poison) throw POISON;
                    return e;
                }
                case 'neg': { const a = this.eval(n.a); return { v: -a.v, k: a.k }; }
                case 'bin': return this.binop(n);
                case 'call': return this.call(n);
            }
            fail('Internal error: unknown expression node.', n);
        }

        halfLifeValue(n) {
            if (this.isotope) return { v: PET.isotopes.get(this.isotope).halfLife, k: TIME };
            if (this.isoPoison) throw POISON;
            fail('T_half is not known yet: it is the half-life of the isotope, and no tracer or isotope is named above this line.', n,
                'Move the tracer (or isotope) line above the first line that uses T_half.');
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
                    if (a.k !== NONE && b.k !== NONE) {
                        fail('Cannot multiply ' + KIND_PHRASE[a.k] + ' by ' + KIND_PHRASE[b.k] + ' (' + fmtVal(a.v, a.k) + ' * ' + fmtVal(b.v, b.k) + ').', n,
                            'Only a plain number can scale a value, as in 2 * DOSE or DUR / 2.');
                    }
                    v = a.v * b.v;
                    k = a.k === NONE ? b.k : a.k;
                    break;
                case '/':
                    if (b.v === 0) fail('Division by zero.', n);
                    if (b.k === NONE) k = a.k;
                    else if (a.k === b.k) k = NONE;              // a ratio of like quantities
                    else if (a.k === NONE) fail('Cannot divide a plain number by ' + KIND_PHRASE[b.k] + ': the language has no unit for the result.', n,
                        'Divide like by like instead, for example DUR / 1 min is a plain number.');
                    else fail('Cannot divide ' + KIND_PHRASE[a.k] + ' by ' + KIND_PHRASE[b.k] + ' (' + fmtVal(a.v, a.k) + ' / ' + fmtVal(b.v, b.k) + ').', n,
                        'Two values can be divided only when they have the same kind: DUR / 1 min is a plain number.');
                    v = a.v / b.v;
                    break;
            }
            if (!isFinite(v)) fail('This calculation does not give a finite number.', n);
            return { v, k };
        }

        addError(n, a, b) {
            const verb = n.op === '+' ? 'add' : 'subtract';
            const pair = (x, y) => (n.op === '+' ? x + ' and ' + y : y + ' from ' + x);
            if (a.k === NONE || b.k === NONE) {
                const other = a.k === NONE ? b : a, plain = a.k === NONE ? a : b;
                fail('Cannot ' + verb + ' ' + pair(KIND_PHRASE[a.k], KIND_PHRASE[b.k]) + '; did you forget a unit?', n,
                    'Write ' + num(plain.v) + ' ' + KIND_UNIT[other.k].u + ' (or whichever unit you meant).');
            }
            const cap = s => s.replace(/^an? /, '').replace(/^./, m => m.toUpperCase());
            fail('Cannot ' + verb + ' ' + pair(fmtVal(a.v, a.k), fmtVal(b.v, b.k)) + '.', n,
                cap(KIND_PHRASE[a.k]) + ' and ' + KIND_PHRASE[b.k].replace(/^an? /, '') + ' have different units, so they cannot be combined with ' + n.op + '.');
        }

        call(n) {
            const ar = FUNCS[n.name];
            if (ar === undefined) {
                const sug = suggest(n.name, Object.keys(FUNCS));
                fail('Unknown function "' + n.name + '".', n, sug ? 'Did you mean ' + sug + '?' : 'The functions are ' + Object.keys(FUNCS).join(', ') + '.');
            }
            if (ar > 0 && n.args.length !== ar) fail(n.name + ' takes ' + ar + ' argument' + (ar > 1 ? 's' : '') + '.', n);
            if (ar < 0 && n.args.length < 1) fail(n.name + ' needs at least one argument.', n);
            const a = n.args.map(x => this.eval(x));
            const x = a[0];
            let v;
            if (n.name === 'min' || n.name === 'max') {
                for (const y of a) if (y.k !== x.k) fail(n.name + ' needs all its arguments in the same kind of unit.', n);
                v = Math[n.name].apply(null, a.map(y => y.v));
            } else v = Math[n.name](x.v);
            return { v, k: x.k };
        }

        unknownName(n) {
            const name = n.name;
            if (UNITS[name]) fail('"' + name + '" is a unit, so it must follow a number.', n, 'For example: 10 ' + name + '.');
            const dash = name.indexOf('-');
            if (dash > 0 && (this.vars[name.slice(0, dash)] || name.slice(0, dash) === 'T_half')) {
                fail('Unknown name "' + name + '".', n, 'To subtract, put spaces around the minus sign: ' + name.slice(0, dash) + ' - ' + name.slice(dash + 1) + '.');
            }
            if (PET.tracers.normalizeId(name)) fail('"' + name + '" is a tracer, not a value.', n, 'Name it on its own line: tracer ' + name);
            if (PET.isotopes.normalizeId(name)) fail('"' + name + '" is an isotope, not a value.', n, 'Name it on its own line: isotope ' + name);
            const sug = suggest(name, Object.keys(this.vars).concat(['T_half']));
            fail('Unknown name "' + name + '".', n, sug ? 'Did you mean ' + sug + '?' : 'Declare it first with param or let, or check the spelling.');
        }

        /* Check that a value has the expected kind and return its number.
           A plain number where a unit is required gets the "write 45 min"
           hint, pointed at the declaration when it came from a name. */
        evalKind(node, kind, what, unit) {
            const val = this.eval(node);
            if (val.k === kind) return val.v;
            const u = unit || KIND_UNIT[kind].u;
            if (val.k === NONE) {
                const e = node.t === 'var' ? this.vars[node.name] : null;
                if (e && (e.type === 'param' || e.type === 'let')) {
                    fail(what + ' needs ' + KIND_PHRASE[kind] + ', but ' + node.name + ' = ' + num(val.v) + ' is a plain number.', node,
                        'Give ' + node.name + ' a unit where it is declared on line ' + e.line + ', for example ' + num(val.v) + ' ' + u + '.');
                }
                fail(what + ' needs ' + KIND_PHRASE[kind] + ', but ' + num(val.v) + ' is a plain number.', node, 'Write ' + num(val.v) + ' ' + u + '.');
            }
            fail(what + ' needs ' + KIND_PHRASE[kind] + ', but this is ' + KIND_PHRASE[val.k] + ' (' + fmtVal(val.v, val.k) + ').', node,
                EXAMPLE[what] ? 'For example: ' + EXAMPLE[what] : null);
        }
        evalInt(node, what) {
            const val = this.eval(node);
            if (val.k !== NONE) fail(what + ' must be a plain whole number, not ' + KIND_PHRASE[val.k] + ' (' + fmtVal(val.v, val.k) + ').', node,
                'Write the count first, then x, then the duration: ' + EXAMPLE.frames + '.');
            const r = Math.round(val.v);
            if (Math.abs(val.v - r) > 1e-9 * Math.max(1, Math.abs(val.v))) {
                const deps = this.paramsIn(node, [], 0);
                fail(what + ' must be a whole number, but it is ' + num(val.v, 6) + '.', node,
                    deps.length ? 'It depends on ' + deps.join(', ') + ': choose values that make it a whole number.' : null);
            }
            return r;
        }
        // Parameters an expression depends on, through lets, in order of appearance.
        paramsIn(n, out, depth) {
            if (!n || depth > 40) return out;
            if (n.t === 'var') {
                const e = this.vars[n.name];
                if (e && e.type === 'param' && out.indexOf(n.name) < 0) out.push(n.name);
                else if (e && e.type === 'let') this.paramsIn(e.ast, out, depth + 1);
            } else if (n.t === 'neg') this.paramsIn(n.a, out, depth);
            else if (n.t === 'bin') { this.paramsIn(n.a, out, depth); this.paramsIn(n.b, out, depth); }
            else if (n.t === 'call') for (const x of n.args) this.paramsIn(x, out, depth);
            return out;
        }

        /* ---------- Names ---------- */
        checkNewName(name, tok, what) {
            const e = this.vars[name];
            if (e && !e.poison) {
                fail('"' + name + '" is already ' + (e.type === 'param' ? 'a parameter' : 'a variable') + ' (line ' + e.line + ').', tok, 'Choose another name.');
            }
            if (name === 'T_half') fail('"T_half" is a built-in constant (the half-life of the isotope), so it cannot be used as a name.', tok, 'Choose another name.');
            if (FUNCS[name] !== undefined) fail('"' + name + '" is a built-in function, so it cannot be used as a name.', tok, 'Choose another name.');
            if (UNITS[name]) fail('"' + name + '" is a unit name, so it cannot be used as a ' + what + ' name.', tok, 'Choose another name.');
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
            let min = null, max = null, step = null;
            if (s.range) {
                const lo = this.eval(s.range[0]), hi = this.eval(s.range[1]);
                for (const [x, node, end] of [[lo, s.range[0], 'starts'], [hi, s.range[1], 'ends']]) {
                    if (x.k !== val.k) fail('The range of ' + s.name + ' must be in the same units as its value (' + KIND_PHRASE[val.k] + '), but it ' + end + ' at ' + fmtVal(x.v, x.k) + '.', node,
                        'For example: range 0 min .. 120 min');
                }
                min = Math.min(lo.v, hi.v); max = Math.max(lo.v, hi.v);
            }
            if (s.step) {
                const st = this.eval(s.step);
                if (st.k !== val.k) fail('The step of ' + s.name + ' must be in the same units as its value (' + KIND_PHRASE[val.k] + ').', s.step);
                step = Math.abs(st.v);
            }
            const p = { name: s.name, value: v, kind: KIND_NAME[val.k], unit: du.u, scale: du.s, min, max, step,
                description: s.desc || '', line: s.line, span: s.span.slice() };
            this.params.push(p);
            this.vars[s.name] = { v, k: val.k, type: 'param', line: s.line, param: p };
            if (min !== null && (v < min - 1e-9 * Math.abs(min) || v > max + 1e-9 * Math.abs(max))) {
                this.warn(s.line, s.name + ' = ' + fmtParamValue(p, v) + ' is outside its range ' + fmtParamValue(p, min) + ' .. ' + fmtParamValue(p, max) + '.');
            }
        }

        execLet(s) {
            this.checkNewName(s.name, s.nameTok, 'variable');
            const val = this.eval(s.expr);
            this.vars[s.name] = { v: val.v, k: val.k, type: 'let', ast: s.expr, line: s.line };
            this.lets[s.name] = val.v;
        }

        execTracer(s) {
            this.once(s);
            this.tracerStmt = s;
            if (/^none$/i.test(s.word)) { this.tracer = null; return; }
            const id = PET.tracers.normalizeId(s.word);
            if (!id) {
                const iso = PET.isotopes.normalizeId(s.word);
                const sug = suggest(s.word, tracerIds());
                fail('Unknown tracer "' + s.word + '".', s.tok, iso
                    ? s.word + ' is an isotope. For a phantom filled with a solution write tracer none and isotope ' + iso + '.'
                    : (sug ? 'Did you mean ' + sug + '? ' : '') + 'The tracers are ' + tracerIds().join(', ') + ', or none for a phantom filled with a solution of an isotope.');
            }
            const tr = PET.tracers.get(id);
            this.tracer = id;
            // An isotope named on an earlier line must agree; the error points at it.
            if (this.isotope && this.isotope !== tr.isotope) this.mismatch(tr, this.isotope, this.isoStmt);
            this.isotope = tr.isotope;
        }

        execIsotope(s) {
            this.once(s);
            this.isoStmt = s;
            const iso = PET.isotopes.normalizeId(s.word);
            if (!iso) {
                const tr = PET.tracers.normalizeId(s.word);
                const sug = suggest(s.word, ['F18', 'C11', 'O15', '18F', '11C', '15O']);
                fail('Unknown isotope "' + s.word + '".', s.tok, tr
                    ? s.word + ' is a tracer: write tracer ' + s.word + ' (its isotope follows from it).'
                    : (sug ? 'Did you mean ' + sug + '? ' : '') + 'The isotopes are F18, C11 and O15 (also written 18F, 11C, 15O).');
            }
            if (this.tracer) {
                const tr = PET.tracers.get(this.tracer);
                if (tr.isotope !== iso) this.mismatch(tr, iso, s);
            }
            this.isotope = iso;
        }

        // "FDG is labelled with 18F, not 11C." with the tracers that do use 11C.
        mismatch(tr, iso, isoStmt) {
            const users = tracersOf(iso), name = PET.isotopes.get(iso).name.toLowerCase();
            fail(tr.id + ' is labelled with ' + massFirst(tr.isotope) + ', not ' + massFirst(iso) + '.', isoStmt.tok,
                'Remove the isotope line (the tracer sets it) or pick ' + article(name) + ' tracer (' + users.join(', ') + ').');
        }

        execInject(s) {
            if (this.injectLine) fail('This protocol already injects on line ' + this.injectLine + '.', s,
                'The simulator models one bolus injection: remove one of the inject lines.');
            this.injectLine = s.line;
            const A = this.evalKind(s.dose, ACT, 'inject', 'MBq');
            if (!(A > 0)) fail('The injected activity must be greater than zero (got ' + fmtVal(A, ACT) + ').', s.dose, 'For example: ' + EXAMPLE.inject);
            if (A > LIMITS.dose) fail(fmtVal(A, ACT) + ' is more than the simulator allows for one injection (' + fmtVal(LIMITS.dose, ACT) + ').', s.dose,
                'Clinical doses run from about 185 MBq (FDG) to 700 MBq ([15O]water).');
            let at = this.clock;
            if (s.at) {
                at = this.evalKind(s.at, TIME, 'at', 'min');
                if (at < 0) fail('The injection time must be 0 or later on the protocol clock (got ' + fmtVal(at, TIME) + ').', s.at,
                    'The clock starts at 0 at the top of the protocol: inject DOSE at 2 min injects two minutes after it starts.');
            }
            this.dose = A;
            this.injectAt = at;
        }

        execWeight(s) {
            this.once(s);
            const w = this.evalKind(s.expr, MASS, 'weight', 'kg');
            if (w < LIMITS.weight[0] || w > LIMITS.weight[1]) {
                fail('A body weight of ' + fmtVal(w, MASS) + ' is outside what the simulator allows (' + LIMITS.weight[0] + ' kg to ' + LIMITS.weight[1] + ' kg).', s.expr,
                    'Weight only enters SUV; 70 kg is the default.');
            }
            this.weight = w;
        }

        execFrames(s) {
            const N = this.evalInt(s.count, 'The number of frames');
            if (N < 1) fail('frames needs at least one frame (got ' + N + ').', s.count, 'For example: ' + EXAMPLE.frames);
            const D = this.evalKind(s.dur, TIME, 'The frame duration', 's');
            if (!(D > 0)) fail('A frame must last longer than zero (got ' + fmtVal(D, TIME) + ').', s.dur, 'For example: ' + EXAMPLE.frames);
            this.addFrames(N, D, s);
        }

        // N back-to-back frames of duration D from the clock; the clock moves on.
        addFrames(N, D, s) {
            const total = this.frames.length + N;
            if (total > LIMITS.maxFrames) {
                fail('This line brings the protocol to ' + total + ' frames; the simulator allows at most ' + LIMITS.maxFrames + '.', s,
                    'Use fewer, longer frames: late in a scan the tracer changes slowly, so frames of 5 to 10 min lose little.');
            }
            const t0 = this.clock;
            for (let i = 0; i < N; i++) this.frames.push({ t0: t0 + i * D, t1: t0 + (i + 1) * D, line: s.line });
            this.clock = t0 + N * D;
        }

        execEnergy(s) {
            this.once(s);
            const lo = this.evalKind(s.lo, ENERGY, 'The lower level of the energy window', 'keV');
            const hi = this.evalKind(s.hi, ENERGY, 'The upper level of the energy window', 'keV');
            const E = PET.const.E511;
            if (hi <= lo) fail('The upper level (' + num(hi) + ' keV) must be above the lower level (' + num(lo) + ' keV).', s.hi,
                'Write the lower level first: ' + EXAMPLE.energy + '.');
            const contain = 'The energy window must contain the 511 keV photopeak, or it rejects the annihilation photons themselves.';
            if (lo < LIMITS.lld[0] || lo > LIMITS.lld[1]) {
                fail('The lower level of the energy window must be between ' + LIMITS.lld[0] + ' keV and ' + LIMITS.lld[1] + ' keV (got ' + num(lo) + ' keV).', s.lo,
                    lo >= E ? contain : lo > LIMITS.lld[1]
                        ? 'So close to 511 keV the window would cut away half the photopeak: the detector spreads the measured energies by about 11 %.'
                        : 'Below about 250 keV almost every scattered photon is accepted. 435 keV is typical for LYSO.');
            }
            if (hi < LIMITS.uld[0] || hi > LIMITS.uld[1]) {
                fail('The upper level of the energy window must be between ' + LIMITS.uld[0] + ' keV and ' + LIMITS.uld[1] + ' keV (got ' + num(hi) + ' keV).', s.hi,
                    hi <= E ? contain : hi < LIMITS.uld[0]
                        ? 'So close to 511 keV the window would cut away half the photopeak: the detector spreads the measured energies by about 11 %.'
                        : '650 keV is typical; a higher upper level gains almost nothing.');
            }
            if (lo < WARN.lld) {
                // A photon that Compton scatters by angle phi keeps 511 / (2 - cos phi) keV.
                const phi = Math.acos(Math.max(-1, Math.min(1, 2 - E / lo))) * 180 / Math.PI;
                this.warn(s.line, 'A lower level of ' + num(lo) + ' keV also accepts photons that scattered by up to about ' + Math.round(phi) +
                    ' degrees, so expect much more scatter in the image.');
            }
            this.energy = { lo, hi };
        }

        execCoincidence(s) {
            this.once(s);
            const tau = this.evalKind(s.expr, TIME, 'coincidence', 'ns');
            if (tau < LIMITS.coincidence[0] - 1e-21 || tau > LIMITS.coincidence[1] + 1e-21) {
                fail('A coincidence window of ' + fmtVal(tau, TIME) + ' is outside what the simulator allows (0.5 ns to 20 ns).', s.expr,
                    'Windows of 4 to 6 ns are typical; this scanner uses 4.5 ns.');
            }
            if (tau < WARN.coincidence - 1e-21) {
                this.warn(s.line, 'A ' + fmtVal(tau, TIME) + ' coincidence window is narrow: photons from the edge of the 320 mm field of view arrive up to about 1.1 ns apart, ' +
                    'so true events near the edge start to be lost.');
            }
            this.coincidence = tau;
        }

        execTof(s) {
            this.once(s);
            this.tof.on = s.on;
            if (s.ctr) {
                const ctr = this.evalKind(s.ctr, TIME, 'The timing resolution', 'ps');
                if (ctr < LIMITS.ctr[0] - 1e-21 || ctr > LIMITS.ctr[1] + 1e-21) {
                    fail('A timing resolution of ' + fmtVal(ctr, TIME) + ' is outside what the simulator allows (100 ps to 1000 ps).', s.ctr,
                        'Current LYSO and SiPM scanners reach about 200 to 400 ps; older ones about 500 to 600 ps.');
                }
                this.tof.ctr = ctr;
            }
        }

        /* ---------- Whole-protocol checks and the Program ---------- */
        finish() {
            const seen = this.seen, body = this.ast.body;
            const firstLine = body.length ? body[0].line : 1, lastLine = this.ast.lastLine || 1;
            const at = line => ({ line, col: 1 });
            const missing = (msg, pos, hint) => this.errors.push(new DslError(msg, pos, hint, true));
            if (!('tracer' in seen) && !('isotope' in seen)) {
                missing('The protocol does not say what is injected: name a tracer.', at(firstLine),
                    'Add a line such as tracer FDG; for a phantom filled with a solution, write tracer none and an isotope line such as isotope F18.');
            } else if (this.tracer === null && !('isotope' in seen)) {
                missing('tracer none means a phantom filled with a solution of an isotope, so the protocol needs an isotope line.',
                    this.tracerStmt.tok, 'Add a line such as isotope F18.');
            }
            if (!('inject' in seen)) {
                const acqLine = Math.min(seen.static || Infinity, seen.frames || Infinity);
                missing('The protocol never injects anything.', at(isFinite(acqLine) ? acqLine : lastLine),
                    'Add an inject line, such as inject 185 MBq, above the wait, static or frames lines.');
            }
            if (!('static' in seen) && !('frames' in seen)) {
                missing('The protocol never acquires anything: add a static or frames line.', at(lastLine),
                    'For example: wait 45 min, then static 10 min (or frames 6 x 10 s for a dynamic scan).');
            }
            if (this.errors.length || this.ast.errors.length) return null;

            const inj = this.injectAt;
            const frames = this.frames.map(f => ({ t0: f.t0 - inj, t1: f.t1 - inj, line: f.line }));
            const first = frames[0], last = frames[frames.length - 1];
            const scanStart = first.t0, scanEnd = last.t1;
            if (scanEnd <= 0) {
                this.errors.push(new DslError('Every frame ends before the injection, so the scan records nothing.', at(this.injectLine),
                    'Put the inject line above the frames, or inject at an earlier time on the clock (inject DOSE at 0 min).'));
                return null;
            }
            if (scanEnd > LIMITS.maxEnd + 1e-6) {
                this.errors.push(new DslError('The scan ends ' + U.fmtTime(scanEnd) + ' after the injection; the simulator follows the tracer for at most 6 hours.',
                    at(last.line), 'Shorten the uptake time or the frames.'));
                return null;
            }

            const iso = PET.isotopes.get(this.isotope), lam = Math.LN2 / iso.halfLife;
            if (scanStart > WARN.halfLives * iso.halfLife) {
                this.warn(first.line, 'The scan starts ' + U.fmtTime(scanStart) + ' after the injection, ' + num(scanStart / iso.halfLife, 2) + ' half-lives of ' +
                    massFirst(iso.id) + ': only ' + U.fmtPct(Math.exp(-lam * scanStart), 1) + ' of the activity is left, so expect very few counts.');
            }
            if (this.tracer) {
                const td = PET.tracers.get(this.tracer).typicalDose;
                if (this.dose > WARN.doseFactor * td * (1 + 1e-9)) {
                    this.warn(this.injectLine, fmtVal(this.dose, ACT) + ' is more than twice the usual ' + this.tracer + ' dose (' + fmtVal(td, ACT) + '): ' +
                        'the radiation dose to the patient rises in proportion, and randoms rise faster than trues.');
                }
            }

            // Decay over the scan. A scan that starts before the injection is
            // measured from the injection, since nothing decays before it.
            const s0 = Math.max(0, scanStart);
            let scanDuration = 0;
            for (const f of frames) scanDuration += f.t1 - f.t0;
            const stats = {
                nFrames: frames.length,
                scanDuration,                                        // s, the sum of the frame durations
                uptake: scanStart,                                   // s from injection to the first frame
                decayAtStart: Math.exp(-lam * s0),                   // fraction of the dose left at scan start
                decayDuringScan: 1 - Math.exp(-lam * (scanEnd - s0)) // fraction of that which decays before the scan ends
            };
            this.warnings.sort((a, b) => a.line - b.line);
            return {
                ok: true, name: this.name, source: this.source,
                params: this.params, lets: this.lets,
                tracer: this.tracer || null, isotope: this.isotope, dose: this.dose, weight: this.weight,
                frames, scanStart, scanEnd, dynamic: frames.length > 1,
                injectAt: inj,                                       // s on the protocol clock
                energy: { lo: this.energy.lo, hi: this.energy.hi },
                coincidence: this.coincidence,
                tof: { on: this.tof.on, ctr: this.tof.ctr },
                acqMode: this.acqMode,
                warnings: this.warnings,
                stats
            };
        }
    }

    // The display unit of a param: its first unit literal if that unit has
    // the right kind, else the default unit for its kind.
    function firstUnit(expr) {
        let found = null;
        (function walk(n) {
            if (!n || found) return;
            if (n.t === 'num' && n.unit) { found = n.unit; return; }
            if (n.t === 'neg') walk(n.a);
            else if (n.t === 'bin') { walk(n.a); walk(n.b); }
            else if (n.t === 'call') n.args.forEach(walk);
        })(expr);
        return found;
    }
    function displayUnit(expr, k) {
        const u = firstUnit(expr);
        if (u && UNITS[u][0] === k) return { u, s: UNITS[u][1] };
        return KIND_UNIT[k];
    }

    /* ============================================================
       Public API
       ============================================================ */
    function parse(source) { return new Parser(source).parseProgram(); }

    function errorOut(e) { return { line: e.line, col: e.col, msg: e.msg, hint: e.hint || null }; }

    function compile(source, opts) {
        source = source == null ? '' : String(source);
        try {
            const ast = parse(source);
            const ex = new Exec(ast, source, opts || {});
            const prog = ex.run();
            const errs = ast.errors.concat(ex.errors);
            if (!errs.length && prog) return prog;
            errs.sort((a, b) => a.line - b.line || a.global - b.global || a.col - b.col);
            return { ok: false, source, errors: errs.slice(0, MAX_ERRORS).map(errorOut), params: ex.params };
        } catch (e) {
            return { ok: false, source, params: [], errors: [{ line: 1, col: 1,
                msg: 'Internal error in the protocol compiler: ' + (e && e.message ? e.message : String(e)),
                hint: 'This is a bug in the simulator, not in your protocol.' }] };
        }
    }

    /* Replace the value of a param in the source, written in the param's
       own display unit ("60 min", "250 MBq", "6"). The given source is
       re-parsed to find the param, so this works even if it has been
       edited since `program` was compiled. */
    function setParamInSource(source, program, name, valueSI) {
        source = source == null ? '' : String(source);
        let ast;
        try { ast = parse(source); } catch (e) { return source; }
        const stmt = ast.body.find(s => s.t === 'param' && s.name === name);
        if (!stmt || !isFinite(valueSI)) return source;
        const known = program && program.params ? program.params.find(p => p.name === name) : null;
        let unit = firstUnit(stmt.expr), scale = unit ? UNITS[unit][1] : 1;
        if (known && (unit === null || UNITS[unit][0] !== KIND_NAME.indexOf(known.kind))) { unit = known.unit; scale = known.scale; }
        if (unit === null) { unit = ''; scale = 1; }
        const text = fmtParamValue({ unit, scale }, valueSI);
        return source.slice(0, stmt.span[0]) + text + source.slice(stmt.span[1]);
    }

    /* Tokens for syntax highlighting, in source order. Whitespace and line
       breaks are not tokens: copy the text between tokens as it is. A
       number with a unit becomes two tokens, 'number' (its value in
       internal units, kind and unit ride along) and 'unit'. The word
       after `tracer` is typed 'tracer' and the one after `isotope`
       'isotope' when they name one; 3D/2D after `mode` are keywords.
       Other types: keyword, ident, op, string, comment, error. */
    function tokenize(source) {
        const src = source == null ? '' : String(source);
        const out = [];
        let stmt = null, idx = 0;
        for (const t of lex(src)) {
            if (t.type === 'newline') { stmt = null; idx = 0; continue; }
            const base = { type: t.type, text: t.text, line: t.line, col: t.col, start: t.start, end: t.end };
            if (t.type === 'comment') { out.push(base); continue; }
            if (idx === 0 && t.type === 'keyword') stmt = t.text;
            if (t.type === 'number') {
                const numEnd = t.unit ? t.numEnd : t.end;
                out.push(Object.assign(base, { text: src.slice(t.start, numEnd), end: numEnd, num: t.num, value: t.value, kind: KIND_NAME[t.kind], unit: t.unit }));
                if (t.unit) {
                    out.push({ type: 'unit', text: t.unit, line: t.line, col: t.col + (t.unitStart - t.start), start: t.unitStart, end: t.end,
                        kind: KIND_NAME[t.kind], scale: UNITS[t.unit][1] });
                }
            } else {
                if (idx === 1 && (t.type === 'ident' || t.type === 'string')) {
                    const w = t.type === 'string' ? t.value : t.text;
                    if (stmt === 'tracer' && (PET.tracers.normalizeId(w) || /^none$/i.test(w))) base.type = 'tracer';
                    else if (stmt === 'isotope' && PET.isotopes.normalizeId(w)) base.type = 'isotope';
                    else if (stmt === 'mode' && /^[23]d$/i.test(w)) base.type = 'keyword';
                }
                if (t.type === 'op') base.op = t.op;
                if (t.type === 'error') base.msg = t.msg;
                out.push(base);
            }
            idx++;
        }
        return out;
    }

    const keywords = {
        statements: STATEMENTS.slice(),
        options: OPTIONS.concat(['x', '3D', '2D', 'none']),
        units: Object.keys(UNITS),
        tracers: PET.tracers.list().map(t => t.id).concat(['none']),
        isotopes: PET.isotopes.list().map(i => i.id),
        functions: Object.keys(FUNCS),
        constants: ['T_half']
    };

    /* ---------- The language reference (HTML) ----------
       Plain tags plus the shared stylesheet's stat-table, mono and note
       classes. In a stat-table the label (th) sits on the left and the
       value (td) on the right in the monospaced face, so each row reads
       "what it does ... how to write it". */
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const row = (label, code) => '<tr><th>' + label + '</th><td>' + esc(code) + '</td></tr>';
    const shortTarget = t => t.target.split(/\s*[(;]/)[0];
    const reference = [
        '<div>',
        '<p class="note">One statement per line; <code>#</code> starts a comment. Times, activities, energies and weights always carry a unit: ',
        'write <code>45 min</code>, not <code>45</code>.</p>',
        '<h4>Statements</h4>',
        '<table class="stat-table">',
        row('Name shown in the simulator', 'protocol "FDG brain"'),
        row('A value with a slider (range, step and description are optional)', 'param DOSE = 185 MBq range 40 MBq .. 400 MBq "injected activity"'),
        row('A value worked out from others', 'let LATE = UPTAKE + 20 min'),
        row('The tracer; it sets the isotope', 'tracer FDG'),
        row('The isotope: needed with tracer none, otherwise optional and must match', 'isotope F18'),
        row('Inject; the injection is time zero of the frames', 'inject 185 MBq'),
        row('Inject at a time on the protocol clock', 'inject DOSE at 2 min'),
        row('Body weight, for SUV (default 70 kg)', 'weight 70 kg'),
        row('Let time pass (uptake)', 'wait 45 min'),
        row('One frame, then the clock moves on', 'static 10 min'),
        row('N frames back to back', 'frames 6 x 10 s'),
        row('Energy window (default)', 'energy 435 keV .. 650 keV'),
        row('Coincidence window, total width (default)', 'coincidence 4.5 ns'),
        row('Time of flight and timing resolution (default)', 'tof on 400 ps'),
        row('Septa out, 3D (default), or in, 2D', 'mode 3D'),
        '</table>',
        '<p class="note">The clock starts at 0 at the top of the protocol; only <code>wait</code>, <code>static</code> and <code>frames</code> move it. ',
        'Frame times are counted from the injection, so frames written before <code>inject DOSE at 2 min</code> start at negative times. ',
        'For a dynamic scan, put the <code>frames</code> lines straight after <code>inject</code>. <code>tof off 600 ps</code> turns TOF off but keeps the ',
        'timing resolution, which still decides how many true events a narrow coincidence window loses.</p>',
        '<p class="note">Limits: dose up to 2 GBq; weight 20 to 200 kg; energy window lower level 250 to 510 keV, upper level 520 to 800 keV; ',
        'coincidence window 0.5 to 20 ns; timing resolution 100 to 1000 ps; at most 64 frames, ending within 6 h of the injection. ',
        'Warnings, not errors: a lower level under 350 keV, a coincidence window under 2.5 ns, a scan starting more than 5 half-lives after the injection, ',
        'and a dose over twice the usual one.</p>',
        '<h4>Tracers</h4>',
        '<table class="stat-table">',
        PET.tracers.list().map(t => row(esc(t.name) + ', ' + esc(shortTarget(t).replace(/^./, c => c.toLowerCase())),
            'tracer ' + t.id + ' (' + t.isotope + ')')).join('\n'),
        row('A phantom filled with a solution of the isotope', 'tracer none, isotope F18'),
        '</table>',
        '<h4>Isotopes</h4>',
        '<table class="stat-table">',
        PET.isotopes.list().map(i => row(esc(i.name) + ', half-life ' + (i.halfLife >= 600 ? num(i.halfLife / 60) + ' min' : num(i.halfLife, 3) + ' s') +
            ', mean positron range ' + i.rangeMean + ' mm', 'isotope ' + i.id + ' (or ' + massFirst(i.id) + ')')).join('\n'),
        '</table>',
        '<h4>Units and arithmetic</h4>',
        '<table class="stat-table">',
        row('time', 's ms us ns ps min h'),
        row('activity', 'Bq kBq MBq GBq mCi uCi'),
        row('energy', 'keV MeV'),
        row('mass', 'kg g'),
        row('length', 'mm cm'),
        '</table>',
        '<p class="note">Operators <span class="mono">+ - * /</span> and parentheses. Adding needs the same kind of unit ',
        '(10 min + 185 MBq is an error, and so is UPTAKE + 5: did you forget a unit?). A plain number scales anything (<code>2 * DOSE</code>), ',
        'and like divided by like is a plain number (<code>DUR / 1 min</code>). Functions <span class="mono">min max round floor ceil abs</span> ',
        'work in base units (s, Bq, keV, kg, mm). <code>T_half</code> is the half-life of the isotope named above it, ',
        'so <code>wait 3 * T_half</code> leaves an eighth of the activity.</p>',
        '<h4>Examples</h4>',
        '<pre>tracer FDG\ninject 185 MBq\nwait 45 min\nstatic 10 min</pre>',
        '<pre>tracer PiB\ninject 400 MBq\nframes 6 x 20 s\nframes 4 x 1 min\nframes 4 x 5 min\nframes 4 x 10 min</pre>',
        '</div>'
    ].join('\n');

    PET.dsl = {
        compile,
        setParamInSource,
        tokenize,
        keywords,
        reference,
        formatParam: (p, valueSI) => fmtParamValue(p, valueSI === undefined ? p.value : valueSI),
        defaults: DEFAULTS,
        limits: LIMITS
    };

})(typeof window !== 'undefined' ? window : globalThis);
