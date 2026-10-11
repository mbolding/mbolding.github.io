'use strict';
const { load, ok, near, summary } = require('./harness');
const MRI = load(['core']);
const U = MRI.util;

// Larmor frequency at 3 T
near(MRI.const.F0 / 1e6, 127.73, 0.01, 'F0 at 3 T in MHz');
near(MRI.const.FAT_HZ, -434.3, 1, 'fat shift at 3 T in Hz');

// FFT round trip and agreement with a direct DFT, for power-of-two and other sizes
for (const n of [8, 12, 64, 96, 100]) {
    const re = new Float64Array(n), im = new Float64Array(n);
    const rng = U.rng(n);
    for (let i = 0; i < n; i++) { re[i] = rng() - 0.5; im[i] = rng() - 0.5; }
    const r2 = Float64Array.from(re), i2 = Float64Array.from(im);
    U.fft(r2, i2, false);
    let err = 0;
    for (let k = 0; k < n; k++) {
        let sr = 0, si = 0;
        for (let j = 0; j < n; j++) {
            const a = -2 * Math.PI * j * k / n;
            sr += re[j] * Math.cos(a) - im[j] * Math.sin(a);
            si += re[j] * Math.sin(a) + im[j] * Math.cos(a);
        }
        err = Math.max(err, Math.abs(sr - r2[k]), Math.abs(si - i2[k]));
    }
    ok(err < 1e-9, 'fft matches DFT for n=' + n + ' (err ' + err + ')');
    U.fft(r2, i2, true);
    let rt = 0;
    for (let i = 0; i < n; i++) rt = Math.max(rt, Math.abs(r2[i] - re[i]), Math.abs(i2[i] - im[i]));
    ok(rt < 1e-9, 'fft round trip n=' + n);
}

// Centred 2D: a delta at the image centre has flat k-space; a delta at
// k-space centre is a flat image.
for (const [nx, ny] of [[8, 8], [6, 10], [7, 5]]) {
    const re = new Float64Array(nx * ny), im = new Float64Array(nx * ny);
    re[Math.floor(ny / 2) * nx + Math.floor(nx / 2)] = 1;
    const K = U.fft2c(re, im, nx, ny);
    let dev = 0;
    for (let i = 0; i < nx * ny; i++) dev = Math.max(dev, Math.abs(K.re[i] - 1), Math.abs(K.im[i]));
    ok(dev < 1e-9, 'centred delta -> flat k-space ' + nx + 'x' + ny);
    const X = U.ifft2c(K.re, K.im, nx, ny);
    let rt = 0;
    for (let i = 0; i < nx * ny; i++) rt = Math.max(rt, Math.abs(X.re[i] - re[i]), Math.abs(X.im[i]));
    ok(rt < 1e-9, 'fft2c/ifft2c round trip ' + nx + 'x' + ny);
}

// A shifted object gives the expected linear phase: x0 = +1 pixel => phase -2pi k/N
{
    const n = 16, re = new Float64Array(n * n), im = new Float64Array(n * n);
    re[(n / 2) * n + n / 2 + 1] = 1;
    const K = U.fft2c(re, im, n, n);
    const kIdx = n / 2 + 1;                    // kx = +1 cycle per FOV
    const ph = Math.atan2(K.im[(n / 2) * n + kIdx], K.re[(n / 2) * n + kIdx]);
    near(ph, -2 * Math.PI / n, 1e-9, 'shift theorem sign convention (s = sum m exp(-i2pi k x))');
}

// RNG reproducible and roughly normal
{
    const a = U.rng(42), b = U.rng(42);
    ok(a() === b() && a() === b(), 'rng reproducible');
    const r = U.rng(7); let s = 0, s2 = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const v = r.randn(); s += v; s2 += v * v; }
    near(s / N, 0, 0.03, 'randn mean'); near(s2 / N, 1, 0.05, 'randn variance');
}

// Formatting
ok(U.fmtTime(0.09) === '90 ms', 'fmtTime ms: ' + U.fmtTime(0.09));
ok(U.fmtTime(330) === '5:30 min', 'fmtTime min: ' + U.fmtTime(330));
ok(U.fmtFreq(127.73e6).indexOf('MHz') > 0, 'fmtFreq MHz');
ok(U.fmtNum(0.123456) === '0.123' && U.fmtNum(1234.5, 4) === '1235' && U.fmtLen(0.0025) === '2.5 mm' &&
   U.fmtLen(0.24) === '24 cm' && U.fmtGrad(0.0221) === '22.1 mT/m' && U.fmtFreq(434.3) === '434 Hz', 'formatters keep their output for numbers');

// Missing values never throw and never pretend to be zero (C1).
{
    const dash = '–';
    const fns = { fmtNum: U.fmtNum, fmtTime: U.fmtTime, fmtFreq: U.fmtFreq, fmtLen: U.fmtLen, fmtGrad: U.fmtGrad };
    for (const name of Object.keys(fns)) {
        for (const v of [null, undefined, NaN]) {
            let out, threw = false;
            try { out = fns[name](v, 3); } catch (e) { threw = true; }
            ok(!threw && out === dash, name + '(' + v + ') gives an en dash (got ' + out + ')');
        }
        let inf, threw = false;
        try { inf = fns[name](Infinity); } catch (e) { threw = true; }
        ok(!threw && /Infinity/.test(inf), name + '(Infinity) does not throw (' + inf + ')');
    }
    ok(U.fmtTime(0) === '0 ms', 'zero is still a number');
    ok(U.fmtNum('2.5') === '2.5', 'numeric strings are formatted');
}

// Percentile: identical to the original sort-everything implementation (C7).
{
    function percentileRef(arr, p) {
        const n = arr.length;
        if (!n) return 0;
        const step = Math.max(1, Math.floor(n / 20000));
        const tmp = [];
        for (let i = 0; i < n; i += step) { const v = arr[i]; if (isFinite(v)) tmp.push(v); }
        if (!tmp.length) return 0;
        tmp.sort((a, b) => a - b);
        const idx = Math.min(tmp.length - 1, Math.max(0, Math.round((p / 100) * (tmp.length - 1))));
        return tmp[idx];
    }
    const rng = U.rng(11);
    const cases = [];
    for (const n of [1, 2, 7, 1000, 19999, 20000, 39999, 40000, 65536, 262144]) {
        const a = new Float32Array(n);
        for (let i = 0; i < n; i++) a[i] = (rng() - 0.3) * 100;
        cases.push(a);
    }
    const holes = new Float64Array(5000);
    for (let i = 0; i < holes.length; i++) holes[i] = i % 7 === 0 ? NaN : (i % 11 === 0 ? Infinity : (i % 13 === 0 ? -Infinity : rng() * 3));
    cases.push(holes, [3, 1, 2, NaN, -5], new Float32Array(10).fill(NaN), new Float64Array(0));
    // Patterns that trouble naive quickselects: many ties, sorted, reversed, constant, two values.
    const ties = new Float32Array(50000), sorted = new Float32Array(30000), rev = new Float32Array(30000);
    const two = new Float32Array(25000), organ = new Float32Array(30001);
    for (let i = 0; i < ties.length; i++) ties[i] = Math.floor(rng() * 5);
    for (let i = 0; i < sorted.length; i++) { sorted[i] = i; rev[i] = -i; }
    for (let i = 0; i < two.length; i++) two[i] = i % 2 ? 1 : 0;
    for (let i = 0; i < organ.length; i++) organ[i] = Math.min(i, organ.length - 1 - i);
    cases.push(ties, sorted, rev, two, organ, new Float32Array(4096).fill(2.5), new Float32Array(1000).fill(0));
    let same = true, detail = '';
    for (const a of cases) {
        for (const p of [0, 0.5, 1, 25, 50, 99, 99.5, 100]) {
            const r1 = U.percentile(a, p), r2 = U.percentile(a, p), ref = percentileRef(a, p);
            if (r1 !== ref || r2 !== ref) { same = false; detail = 'n ' + a.length + ' p ' + p + ': ' + r1 + ' vs ' + ref; }
        }
    }
    ok(same, 'percentile matches the reference for every size, NaN and infinities ' + detail);
    // An array changed in place must not reuse the cached sort.
    const m = new Float32Array(3000);
    for (let i = 0; i < m.length; i++) m[i] = i;
    const before = U.percentile(m, 99.5);
    m[2990] = 1e6; m[5] = -50;
    ok(before === percentileRef(new Float32Array(Array.from({ length: 3000 }, (_, i) => i)), 99.5) &&
       U.percentile(m, 100) === 1e6 && U.percentile(m, 0) === -50, 'in-place changes are seen');
    // Speed: several times faster than the boxed-array sort with a comparator
    // on a 256 x 256 image, asked twice (0.5 and 99.5) as every display window does.
    const big = new Float32Array(256 * 256);
    for (let i = 0; i < big.length; i++) big[i] = rng();
    // Measured in Node's own realm: inside the vm sandbox every call to a
    // host global is slow, which would hide the difference a browser sees.
    const coreSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'js', 'core.js'), 'utf8');
    const realm = {}; new Function('window', coreSrc)(realm);
    const pct = realm.MRI.util.percentile;
    const time = (fn) => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
    let tNew = Infinity, tRef = Infinity;
    for (let k = 0; k < 7; k++) {
        const fresh = Float32Array.from(big);       // a new array each time: no cache hit across trials
        tNew = Math.min(tNew, time(() => { pct(fresh, 0.5); pct(fresh, 99.5); }));
        tRef = Math.min(tRef, time(() => { percentileRef(fresh, 0.5); percentileRef(fresh, 99.5); }));
    }
    console.log('    percentile pair on 256x256: ' + tNew.toFixed(2) + ' ms (reference ' + tRef.toFixed(2) + ' ms, ' + (tRef / tNew).toFixed(1) + 'x)');
    ok(tNew * 3 < tRef, 'percentile is much faster than the reference (' + (tRef / tNew).toFixed(1) + 'x)');
}

// scrollBehavior follows prefers-reduced-motion (UX14).
{
    ok(U.scrollBehavior() === 'smooth', 'no matchMedia: smooth');
    const fs = require('fs'), path = require('path'), vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
    for (const reduce of [true, false]) {
        const box = { Math, Float64Array, Float32Array, Uint8ClampedArray, WeakMap, Promise, setTimeout, isFinite, Number, String,
            matchMedia: (q) => ({ matches: reduce && /reduced-motion: reduce/.test(q) }) };
        box.window = box;
        vm.createContext(box);
        vm.runInContext(src, box);
        ok(box.MRI.util.scrollBehavior() === (reduce ? 'auto' : 'smooth'), 'reduced motion ' + reduce + ' gives ' + box.MRI.util.scrollBehavior());
    }
}

// yieldFrame: a timer in Node, a single MessageChannel in a browser (C8).
(async function () {
    let n = 0;
    await Promise.all([U.yieldFrame().then(() => n++), U.yieldFrame().then(() => n++)]);
    ok(n === 2, 'yieldFrame resolves without a document');
    const fs = require('fs'), path = require('path'), vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
    let channels = 0, made = null;
    const { MessageChannel } = require('worker_threads');
    const box = { Math, Float64Array, Float32Array, Uint8ClampedArray, WeakMap, Promise, isFinite, Number, String,
        setTimeout: () => { throw new Error('setTimeout must not be used when MessageChannel exists'); },
        document: {},
        MessageChannel: function () { channels++; made = new MessageChannel(); this.port1 = made.port1; this.port2 = made.port2; }
    };
    box.window = box;
    vm.createContext(box);
    vm.runInContext(src, box);
    const order = [];
    const ys = [0, 1, 2, 3].map(i => box.MRI.util.yieldFrame().then(() => order.push(i)));
    await Promise.all(ys);
    made.port1.close();                 // let Node exit
    ok(channels === 1 && order.join(',') === '0,1,2,3', 'one channel, waiters resolved in order (' + order.join(',') + ')');
    summary('core');
})();
