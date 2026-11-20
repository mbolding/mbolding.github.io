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

/* Out-of-date results and carried-over settings, with the protocol
   compiler loaded but no acquisition engine (so a re-scan fails). */
(async function () {
    const P = load(['core', 'isotopes', 'scanner', 'kinetics', 'phantoms', 'dsl', 'presets', 'app']);
    const S = P.state, Ac = P.actions, App = P.app;
    const events = [];
    P.bus.on('results:outdated', function (e) { events.push(e); });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    ok(Ac.loadPreset('fdg_static') && S.program && S.program.ok, 'preset compiles');
    await wait(350);                                  // the debounced re-scan fails: no engine
    S.acq = { frames: [{}], totals: {} };             // pretend an earlier scan is on screen
    S.stale = false;
    ok(!App.resultsOutdated(), 'a fresh scan is not out of date');
    // a change with Auto re-scan on: a re-scan is pending, so not yet out of date
    Ac.setParam('DOSE', 300e6);
    ok(S.stale && !App.resultsOutdated(), 'pending re-scan: stale but not reported out of date');
    await wait(350);
    ok(App.resultsOutdated() && /failed/.test(App.outdatedReason()), 're-scan failed: out of date (' + App.outdatedReason() + ')');
    // Auto re-scan off
    Ac.setAutoRescan(false);
    Ac.setParam('DOSE', 200e6);
    ok(App.resultsOutdated() && /Auto re-scan is off/.test(App.outdatedReason()), 'Auto re-scan off: out of date at once');
    // a protocol that does not compile
    Ac.setAutoRescan(true);
    Ac.setSource(S.source.replace(/^static.*$/m, 'static 10'));
    ok(!S.program.ok && App.resultsOutdated() && /protocol has errors/.test(App.outdatedReason()), 'compile error: out of date');
    ok(events.length > 0 && events[events.length - 1].outdated === true, 'results:outdated event emitted');
    // fixing the protocol with Auto re-scan off: still out of date, for another reason, and the tabs hear of it
    Ac.setAutoRescan(false);
    const before = events.length;
    Ac.setSource(S.source.replace(/^static.*$/m, 'static DUR'));
    ok(S.program.ok && App.resultsOutdated() && /Auto re-scan is off/.test(App.outdatedReason()), 'protocol fixed, Auto re-scan off: still out of date');
    ok(events.length > before && /Auto re-scan is off/.test(events[events.length - 1].reason), 'results:outdated carries the new reason');
    Ac.setAutoRescan(true);
    ok(!App.resultsOutdated(), 'Auto re-scan on again: a re-scan is pending, so not out of date');
    await wait(350);
    // carried-over settings
    ok(App.changedSettings().physics.length === 0 && App.changedSettings().recon.length === 0, 'defaults: nothing carried over');
    Ac.setPhysics({ attenuation: false, muMap: { dx: 8 } });
    Ac.setRecon({ iterations: 8, corrections: { scatter: false } });
    const c = App.changedSettings();
    ok(c.physics.indexOf('attenuation') >= 0 && c.physics.indexOf('mu map used for correction') >= 0, 'physics changes listed (' + c.physics.join(', ') + ')');
    ok(c.recon.indexOf('iterations') >= 0 && c.recon.indexOf('scatter correction') >= 0, 'recon changes listed (' + c.recon.join(', ') + ')');
    Ac.loadPreset('cyl_uniform');
    ok(App.changedSettings().physics.length === 2, 'loadPreset keeps physics changes (and the Protocol tab says so)');
    Ac.resetPhysics(); Ac.resetRecon();
    ok(App.changedSettings().physics.length === 0 && App.changedSettings().recon.length === 0, 'reset clears them');
    await wait(350);
    summary('app');
})();
