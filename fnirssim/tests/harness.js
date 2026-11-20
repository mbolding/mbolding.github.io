/* Node harness: load the simulator's classic scripts the way a browser
   would, as plain scripts sharing one global, for the non-UI modules.

     const { load } = require('./harness');
     const NIRS = load(['core', 'optics']);   // js/<name>.js, in order

   Only modules that do not touch the DOM at load time can be tested this
   way: everything except draw.js, app.js and the tab_*.js files. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'js');

function load(names) {
  // Each test file runs in its own Node process, so the modules can share
  // the real global object (a vm sandbox would be much slower).
  globalThis.window = globalThis;
  for (const name of names) {
    const file = path.join(JS, name.endsWith('.js') ? name : name + '.js');
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.NIRS;
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
