'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head']);
const v3 = MEG.v3;

// Site layout
ok(MEG.SITES.length > 95 && MEG.SITES.length < 115, 'about a hundred sites: ' + MEG.SITES.length);
ok(new Set(MEG.SITES.map(s => s.name)).size === MEG.SITES.length, 'site names are unique');
const arr = { mag: MEG.getArray('mag'), axial: MEG.getArray('axial'), planar: MEG.getArray('planar'), opm: MEG.getArray('opm') };
ok(arr.planar.nch === 3 * MEG.SITES.length && arr.mag.nch === MEG.SITES.length && arr.planar.channels.filter(c => c.kind === 'planar').length === 2 * MEG.SITES.length, 'the 306-style array has a magnetometer and two planar gradiometers per site');
ok(arr.mag.refs.length === 9, 'nine reference channels');

// Sarvas: a radial dipole and a dipole at the centre make no field outside
{
  const r0 = v3.scale(v3.unit([0.3, 0.2, 1]), 7);
  const q = v3.scale(v3.unit(r0), 20);
  const B = MEG.forwardMEG(arr.mag.channels, r0, q);
  let m = 0; B.forEach(x => { m = Math.max(m, Math.abs(x)); });
  ok(m < 1e-9, 'radial dipole gives zero field (max ' + m + ')');
  const B0 = MEG.forwardMEG(arr.mag.channels, [0, 0, 0], [10, 0, 0]);
  let m0 = 0; B0.forEach(x => { m0 = Math.max(m0, Math.abs(x)); });
  ok(m0 < 1e-9, 'dipole at the centre gives zero field');
}
// The radial component of B outside a sphere equals that of the primary current alone
{
  const r0 = [1.5, 2, 6.2], q = [12, -5, 3];
  let err = 0, mx = 0;
  MEG.fibonacciSphere(60).forEach(u => {
    const r = v3.scale(u, 11);
    const B = MEG.sarvas(r, r0, q), B0 = MEG.biotSavart(r, r0, q);
    err = Math.max(err, Math.abs(v3.dot(B, u) - v3.dot(B0, u))); mx = Math.max(mx, Math.abs(v3.dot(B0, u)));
  });
  ok(err < 1e-9 * mx, 'B_r(Sarvas) = B_r(Biot-Savart) outside (' + err + ')');
}
// Outside the head the field is curl-free and divergence-free
{
  const r0 = [1, -2, 6.5], q = [5, 9, -2], h = 1e-4;
  const f = r => MEG.sarvas(r, r0, q);
  [[0, 0, 11], [6, 5, 7], [-9, 0, 3]].forEach(p => {
    const d = k => { const a = p.slice(), b = p.slice(); a[k] += h; b[k] -= h; const fa = f(a), fb = f(b); return [0, 1, 2].map(i => (fa[i] - fb[i]) / (2 * h)); };
    const J = [d(0), d(1), d(2)];   // J[k][i] = dB_i/dx_k
    const div = J[0][0] + J[1][1] + J[2][2];
    const curl = [J[1][2] - J[2][1], J[2][0] - J[0][2], J[0][1] - J[1][0]];
    const scale = Math.max(...J.flat().map(Math.abs));
    ok(Math.abs(div) < 1e-6 * scale && v3.norm(curl) < 1e-6 * scale, `field is harmonic outside at ${p} (div ${div.toExponential(1)}, curl ${v3.norm(curl).toExponential(1)})`);
  });
}
// Size: 10 nAm tangential, 3 cm below the scalp, seen by SQUID magnetometers, OPMs and gradiometers
{
  const pos = MEG.placeDipole('C3', 3), ori = MEG.orientation(pos, 90, 0);
  const peak = t => { const ch = arr[t].channels.filter(c => c.kind === (t === 'mag' ? 'mag' : t)); const v = MEG.forwardMEG(ch, pos, v3.scale(ori, 10)); let m = 0; v.forEach(x => { m = Math.max(m, Math.abs(x)); }); return m; };
  const pm = peak('mag'), po = peak('opm'), pa = peak('axial'), pp = peak('planar');
  console.log(`  10 nAm at 3 cm: magnetometer ${pm.toFixed(0)} fT, axial ${pa.toFixed(0)} fT, planar ${pp.toFixed(1)} fT/cm, OPM ${po.toFixed(0)} fT`);
  ok(pm > 60 && pm < 400, 'magnetometer peak is in the textbook range (' + pm.toFixed(0) + ' fT)');
  ok(po > 2 * pm, 'OPMs on the scalp see at least twice the SQUID field (' + (po / pm).toFixed(2) + 'x)');
  ok(pa < pm && pa > 0.4 * pm, 'axial gradiometers see somewhat less than magnetometers for a brain source');
}
// Tangential vs radial: MEG falls as sin(tilt), EEG does not vanish
{
  const pos = MEG.placeDipole('C3', 2.5);
  const meg = tilt => { const v = MEG.forwardMEG(arr.mag.channels, pos, v3.scale(MEG.orientation(pos, tilt, 90), 10)); return Math.sqrt(v.reduce((a, x) => a + x * x, 0)); };
  near(meg(30) / meg(90), Math.sin(30 * Math.PI / 180), 1e-9, 'MEG scales with the tangential component');
  const model = MEG.headModel(), U = MEG.EEG64.map(l => MEG.ELEC[l]);
  const eeg = tilt => { const v = MEG.forwardEEG(model, pos, v3.scale(MEG.orientation(pos, tilt, 90), 10), U); const m = MEG.mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0)); };
  ok(eeg(0) > 0.3 * eeg(90), 'EEG still sees a radial dipole');
}
// EEG series: no net current leaves the head
{
  const model = MEG.headModel({ homogeneous: true });
  const r0 = [1, 2, 5], q = [3, -2, 7];
  let mx = 0;
  MEG.fibonacciSphere(40).forEach(u => { mx = Math.max(mx, Math.abs(MEG.forwardEEG(model, r0, q, [u])[0])); });
  ok(mx > 0, 'EEG series runs');
  // Potential at the surface integrates to zero over the sphere (no net current)
  let s = 0; const pts = MEG.fibonacciSphere(4000);
  pts.forEach(u => { s += MEG.forwardEEG(model, r0, q, [u])[0]; });
  near(s / pts.length / mx, 0, 2e-3, 'surface potential averages to zero');
}
summary('head');
