/* Node harness: load the simulator's classic scripts into a sandbox that
   looks enough like a browser window for the non-UI modules.

     const { load } = require('./harness');
     const MRI = load(['core', 'dsl', 'presets']);   // js/<name>.js, in order

   Only modules that do not touch the DOM at load time can be tested this
   way, which is every module outside js/ui/ plus app.js's pure helpers. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'js');

function load(names) {
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, Math, Date, JSON,
        Float32Array, Float64Array, Int32Array, Uint8Array, Uint16Array, Uint32Array,
        Int8Array, Int16Array, Uint8ClampedArray, ArrayBuffer, Map, Set, Error, isFinite,
        devicePixelRatio: 1
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const name of names) {
        const file = path.join(JS, name.endsWith('.js') ? name : name + '.js');
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    }
    return sandbox.MRI;
}

/* Minimal assertion helpers so the tests need no dependencies. */
let failures = 0, passes = 0;
function ok(cond, msg) {
    if (cond) { passes++; }
    else { failures++; console.error('  FAIL: ' + msg); }
}
function near(a, b, tol, msg) {
    ok(Math.abs(a - b) <= tol, msg + ' (got ' + a + ', expected ' + b + ' ± ' + tol + ')');
}
function summary(name) {
    console.log((failures ? 'FAILED ' : 'ok     ') + name + ': ' + passes + ' passed, ' + failures + ' failed');
    if (failures) process.exitCode = 1;
}

module.exports = { load, ok, near, summary };
