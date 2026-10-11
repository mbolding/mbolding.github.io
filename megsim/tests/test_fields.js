'use strict';
const { load, ok, near, summary } = require('./harness');
const MEG = load(['core', 'head', 'fields']);
const v3 = MEG.v3, F = MEG.fields;

const r0 = MEG.placeDipole('C3', 2.4), q = v3.scale(MEG.orientation(r0, 70, 30), 20);

// Interior potential: equals the scalp series at the surface; continuous across shells
{
  const m = F.interiorModel(), hm = MEG.headModel();
  let err = 0, mx = 0;
  MEG.fibonacciSphere(50).forEach(u => {
    const a = F.potential(m, r0, q, v3.scale(u, MEG.HEAD.R - 1e-7)), b = MEG.forwardEEG(hm, r0, q, [u])[0];
    err = Math.max(err, Math.abs(a - b)); mx = Math.max(mx, Math.abs(b));
  });
  ok(err < 1e-6 * mx, 'interior potential matches the scalp series at the surface (' + (err / mx).toExponential(1) + ')');
  let jump = 0, scale = 0;
  MEG.HEAD.radii.slice(0, 3).forEach(Rb => MEG.fibonacciSphere(30).forEach(u => {
    const a = F.potential(m, r0, q, v3.scale(u, Rb - 1e-6)), b = F.potential(m, r0, q, v3.scale(u, Rb + 1e-6));
    jump = Math.max(jump, Math.abs(a - b)); scale = Math.max(scale, Math.abs(a));
  }));
  ok(jump < 1e-4 * scale, 'potential is continuous across the shell boundaries (' + (jump / scale).toExponential(1) + ')');
  // normal current continuous at the skull, zero at the scalp
  const pl = F.planes(r0, q);
  let jn = 0, jscale = 0, outN = 0;
  [0.2, 0.5, 1.0, 1.4].forEach(ang => {
    const u = v3.unit(v3.add(v3.scale(pl.e2, Math.cos(ang)), v3.scale(pl.electric.e1, Math.sin(ang))));
    const Jat = rr => { const x = v3.scale(u, rr); const J = F.currentInPlane(m, r0, q, x, pl.electric.e1, pl.electric.e2); return J[0] * v3.dot(u, pl.electric.e1) + J[1] * v3.dot(u, pl.electric.e2); };
    const a = Jat(8.2 + 1e-5), b = Jat(8.2 - 1e-5);
    jn = Math.max(jn, Math.abs(a - b)); jscale = Math.max(jscale, Math.abs(a), Math.abs(b));
    outN = Math.max(outN, Math.abs(Jat(9.2 - 1e-5)) / (Math.abs(Jat(8.5)) + 1e-30));
  });
  ok(jn < 0.02 * jscale, 'normal current is continuous at the CSF-skull boundary (' + (jn / jscale).toFixed(4) + ')');
  ok(outN < 0.05, 'no current leaves through the scalp (' + outN.toFixed(4) + ')');
}

// The analytic gradient agrees with a centred difference of the potential, in every shell
{
  const m = F.interiorModel();
  let worst = 0;
  [[2, 1, 4], [3, 2, 6.9], [1, -1, 7.5], [0.5, 3, 7.9], [0, 0, 8.1], [1, 1, 8.5], [2, 3, 8.4], [3, 4, 7.6], [4, 2, 7.5]].forEach(p => {
    const pg = F.potentialGrad(m, r0, q, p), h = 1e-5;
    const fd = [0, 1, 2].map(k => { const a = p.slice(), b = p.slice(); a[k] += h; b[k] -= h; return (F.potential(m, r0, q, a) - F.potential(m, r0, q, b)) / (2 * h); });
    near(pg.V, F.potential(m, r0, q, p), 1e-9 * Math.abs(pg.V) + 1e-12, 'potentialGrad value at ' + p);
    worst = Math.max(worst, v3.norm(v3.sub(pg.g, fd)) / (v3.norm(fd) + 1e-12));
  });
  ok(worst < 1e-5, 'analytic gradient matches finite differences (' + worst.toExponential(1) + ')');
}

// Magnetic field: the numeric volume-current part agrees with Sarvas outside, and B is continuous at the scalp
{
  const mag = F.makeMagnetic(r0, q, { fine: true });
  [10.5, 9.8].forEach(rr => {
    let err = 0, mx = 0;
    MEG.fibonacciSphere(40).forEach(u => {
      const p = v3.scale(u, rr);
      const exact = v3.sub(MEG.sarvas(p, r0, q), MEG.biotSavart(p, r0, q));
      const num = mag.BvNumeric(p);
      err = Math.max(err, v3.norm(v3.sub(exact, num))); mx = Math.max(mx, v3.norm(MEG.sarvas(p, r0, q)));
    });
    ok(err < 0.03 * mx, `Geselowitz integral matches Sarvas at r = ${rr} cm (error ${(100 * err / mx).toFixed(2)}% of the field)`);
  });
  // B_r inside equals the primary current's B_r, so the volume part has no radial component
  let rad = 0, mx = 0;
  MEG.fibonacciSphere(40).forEach(u => { const p = v3.scale(u, 7.8); const b = mag.BvNumeric(p); rad = Math.max(rad, Math.abs(v3.dot(b, u))); mx = Math.max(mx, v3.norm(b)); });
  ok(rad < 0.05 * mx, 'volume currents add no radial field inside (' + (rad / mx).toFixed(3) + ')');
  let jumpB = 0, sc = 0;
  MEG.fibonacciSphere(40).forEach(u => {
    const a = mag.B(v3.scale(u, MEG.HEAD.R - 1e-4)), b = mag.B(v3.scale(u, MEG.HEAD.R + 1e-4));
    jumpB = Math.max(jumpB, v3.norm(v3.sub(a, b))); sc = Math.max(sc, v3.norm(b));
  });
  ok(jumpB < 0.01 * sc, 'total B is continuous at the scalp (' + (jumpB / sc).toExponential(1) + ')');
  // near the scalp inside, the blend should agree with the numeric integral where both are valid
  const coarse = F.makeMagnetic(r0, q);
  let e2 = 0, s2 = 0;
  MEG.fibonacciSphere(30).forEach(u => { const p = v3.scale(u, 8.4); const a = coarse.Bv(p), b = mag.BvNumeric(p); e2 = Math.max(e2, v3.norm(v3.sub(a, b))); s2 = Math.max(s2, v3.norm(MEG.biotSavart(p, r0, q))); });
  ok(e2 < 0.03 * s2, 'coarse and fine quadratures agree inside (' + (100 * e2 / s2).toFixed(2) + '% of B0)');
}

// A radial dipole: nothing outside, and nothing in the magnetic plane's own directions inside
{
  const rq = v3.scale(v3.unit(r0), 20);
  const mag = F.makeMagnetic(r0, rq);
  let out = 0; MEG.fibonacciSphere(30).forEach(u => { out = Math.max(out, v3.norm(mag.B(v3.scale(u, 11)))); });
  ok(out < 1e-9, 'radial dipole: no field outside');
}

// Timing and line tracing
{
  const pl = F.planes(r0, q);
  let t = Date.now();
  const mag = F.makeMagnetic(r0, v3.scale(pl.t, 20));
  const grid = F.magneticGrid(mag, pl.magnetic, 15, 61);
  const tg = Date.now() - t; t = Date.now();
  const lines = F.magneticLines(grid, pl.magnetic, [0, v3.norm(r0)], { lines: 16 });
  const tl = Date.now() - t;
  const closed = lines.filter(L => { const a = L[0], b = L[L.length - 1]; return Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9 && L.length > 10; }).length;
  console.log(`  magnetic grid ${tg} ms, ${lines.length} lines ${tl} ms, ${closed} closed`);
  ok(closed >= lines.length - 3, 'magnetic lines close around the dipole');
  const outside = lines.filter(L => L.some(p => Math.hypot(p[0], p[1]) > MEG.HEAD.R)).length;
  ok(outside >= 3, 'several magnetic lines leave the head (' + outside + ')');
  t = Date.now();
  const m = F.interiorModel();
  const cl = F.currentLines(m, r0, q, pl.electric, { lines: 16 });
  const tc = Date.now() - t;
  const ended = cl.filter(L => { const p = L[L.length - 1]; const c = [v3.dot(r0, pl.electric.e1), v3.dot(r0, pl.electric.e2)]; return Math.hypot(p[0] - c[0], p[1] - c[1]) < 0.5; }).length;
  console.log(`  ${cl.length} current lines in ${tc} ms, ${ended} return to the dipole, lengths ${cl.map(L => L.length).join(',')}`);
  ok(ended >= cl.length - 2, 'current lines return to the dipole');
}
summary('fields');
