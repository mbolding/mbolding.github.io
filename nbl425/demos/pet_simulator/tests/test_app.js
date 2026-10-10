'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner', 'app']);
const A = PET.app;

// Playback thinning: monotone in f, exact at f = 1, mean close to n f
{
    const rng = PET.util.rng(4), n = 5000, arr = new Float32Array(n);
    for (let k = 0; k < n; k++) arr[k] = PET.util.poisson(rng, k % 2 ? 3 : 200);
    let mono = true, prev = A._thin(arr, 0, 1);
    for (const f of [0.1, 0.3, 0.5, 0.8, 0.95]) {
        const t = A._thin(arr, f, 1);
        for (let k = 0; k < n; k++) if (t[k] < prev[k] - 1) { mono = false; break; }
        let s = 0, s0 = 0; for (let k = 0; k < n; k++) { s += t[k]; s0 += arr[k]; }
        near(s / s0, f, 0.02, 'thinned total at f=' + f);
        prev = t;
    }
    ok(mono, 'thinning only fills in (up to one count of rounding for large bins)');
    ok(A._thin(arr, 1, 1) === arr, 'f = 1 returns the data unchanged');
}
// State and actions exist without a document
ok(PET.state && PET.actions && typeof PET.actions.runScan === 'function', 'state and actions created');
ok(A._merged({ a: { b: 1, c: 2 } }, { a: { c: 3 } }).a.b === 1, 'deep merge keeps untouched keys');
summary('app');
