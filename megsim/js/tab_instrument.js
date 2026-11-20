/* MEG simulator: the Instrument tab.  A clickable schematic of the whole
   system, SQUID or OPM, and seven interactive stages: pyramidal cells and
   their dipole, the head as a conductor, pickup coils and SQUIDs, the
   dewar, the shielded room, head position coils and the digitizer, and
   optically pumped magnetometers. */
(function (G) {
  'use strict';
  const MEG = G.MEG, D = MEG.draw, ui = MEG.ui, v3 = MEG.v3, S = MEG.S;
  const $ = ui.$;
  const st = { sys: 'squid', stage: 'neurons', hover: null, anim: null, coil: 'mag', plots: {}, scene: null };
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DEG = Math.PI / 180;
  let HM = null;
  const headModel = () => HM || (HM = MEG.headModel());
  const EEGSET = () => D.elecs(MEG.EEG64);
  const U64 = () => MEG.EEG64.map(l => MEG.ELEC[l]);

  // EEG potentials at the 64 electrodes, average reference
  function eegAvg(model, srcs) {
    const U = U64(), v = new Float64Array(U.length);
    srcs.forEach(s => { const f = MEG.forwardEEG(model, s.pos, s.q, U); for (let i = 0; i < v.length; i++) v[i] += f[i]; });
    const m = MEG.mean(v); for (let i = 0; i < v.length; i++) v[i] -= m;
    return v;
  }
  // Magnetometer readings at the 105 sites (centred head)
  function megMag(srcs, type) {
    const chans = MEG.getArray(type || 'mag').channels.filter(c => c.kind === (type === 'opm' ? 'opm' : 'mag'));
    const v = new Float64Array(chans.length);
    srcs.forEach(s => { const f = MEG.forwardMEG(chans, s.pos, s.q); for (let i = 0; i < v.length; i++) v[i] += f[i]; });
    return v;
  }
  const peakAbs = v => { let m = 0; v.forEach(x => { m = Math.max(m, Math.abs(x)); }); return m; };
  // 3.2, 45, 3 400, 2.1 million, 3 × 10^9
  function fmtBig(x) {
    if (x < 10) return x.toFixed(1);
    if (x < 1e6) return Math.round(x).toLocaleString('en-US').replace(/,/g, ' ');
    if (x < 1e9) return (x / 1e6).toFixed(1) + ' million';
    const e = Math.floor(Math.log10(x)); return (x / Math.pow(10, e)).toFixed(1) + ' × 10^' + e;
  }

  /* ===================== the system schematic ===================== */
  // Scene units: 1000 x 430.  Head at (300, 250), radius 46 (5 units per cm).
  const HC = [300, 250], HR = 46, UPC = 5, BUB = [548, 160, 52];
  const COIL_R = HR + 2.4 * UPC;
  const HELMET = [-150, 20];                // helmet span in degrees (math angles, y up): back-bottom to brow
  const hp = (a, r) => [HC[0] + r * Math.cos(a * DEG), HC[1] - r * Math.sin(a * DEG)];
  const HPI_ANG = [62, 22, 148, 196];
  function dewarPolygon() {
    const P = [[180, 62], [420, 62], [420, 160]];
    for (let a = 30; a >= HELMET[1]; a -= 2) P.push(hp(a, 74));
    for (let a = HELMET[1]; a <= 180 - HELMET[0]; a += 3) P.push(hp(a, 49));
    for (let a = 180 - HELMET[0]; a >= 150; a -= 2) P.push(hp(a, 74));
    P.push([180, 160]);
    return P;
  }
  function inPoly(P, x, y) {
    let inside = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, yi] = P[i], [xj, yj] = P[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hitTest(x, y) {
    const d = (a, b) => Math.hypot(x - a[0], y - b);
    if (Math.hypot(x - BUB[0], y - BUB[1]) < BUB[2] + 2) return 'neurons';
    const r = Math.hypot(x - HC[0], y - HC[1]);
    let ang = Math.atan2(HC[1] - y, x - HC[0]) / DEG; if (ang < -90) ang += 360;
    const inSpan = ang >= HELMET[1] - 4 && ang <= 180 - HELMET[0] + 4;
    if (HPI_ANG.some(a => { const p = hp(a, HR); return Math.hypot(x - p[0], y - p[1]) < 7; })) return 'hpi';
    if (x > 800 && x < 985 && y > 120 && y < 190) return 'hpi';
    if (st.sys === 'opm') {
      if (Math.abs(r - (HR + 5)) < 7 && inSpan) return 'opm';
      if ((x > 140 && x < 168 && y > 140 && y < 340) || (x > 432 && x < 460 && y > 140 && y < 340)) return 'opm';
    } else {
      if (Math.abs(r - COIL_R - 2) < 8 && inSpan) return 'coils';
      if (inPoly(dewarPolygon(), x, y)) return 'dewar';
    }
    if (r < HR) return 'head';
    if (x > 690 && x < 770 && y > 60 && y < 250) return st.sys === 'opm' ? 'opm' : 'coils';
    const inOuter = x > 20 && x < 640 && y > 10 && y < 420, inInner = x > 48 && x < 612 && y > 38 && y < 392;
    if (inOuter && !inInner) return 'room';
    void d;
    return null;
  }
  const CAPTION = {
    neurons: 'Pyramidal cells: synchronous currents in their apical dendrites add up to a current dipole of tens of nA·m.',
    head: 'The head: a conductor that smears the EEG but leaves the magnetic field of a spherical head untouched.',
    coils: 'Pickup coils in the helmet catch the field and carry it, through a superconducting flux transformer, to a SQUID that turns flux into voltage.',
    dewar: 'The dewar: a vacuum-insulated vessel of liquid helium that keeps the SQUIDs superconducting at 4.2 K, about 2 cm from the scalp.',
    room: 'The magnetically shielded room: mu-metal layers divert slow fields around the room, aluminium stops fast ones.',
    hpi: 'Head position coils on the scalp and a 3D digitizer tie the head to the sensors and, later, to the MRI.',
    opm: 'Optically pumped magnetometers sit on the scalp at room temperature; coils null the field around the head.'
  };

  function drawSystem() {
    const cv = $('cvSystem'), T = D.theme();
    const { ctx, w, h } = D.fit(cv, w => Math.min(560, w * 0.43));
    const s = Math.min(w / 1000, h / 430);
    const ox = (w - 1000 * s) / 2, oy = (h - 430 * s) / 2;
    st.scene = { s, ox, oy };
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
    const HL = part => st.hover === part || st.stage === part;
    const glow = (part, path) => {
      if (!HL(part)) return;
      ctx.save(); ctx.strokeStyle = D.alpha(T.accent, st.hover === part ? 0.95 : 0.6); ctx.lineWidth = 3.5 / Math.max(0.6, s) * 0.8; path(); ctx.stroke(); ctx.restore();
    };
    const fsz = 12.5 / Math.max(0.7, s) * 0.85;
    const label = (text, x, y, opts) => { D.label(ctx, text, x, y, Object.assign({ size: fsz, color: T.ink2 }, opts || {})); };
    const leader = (x0, y0, x1, y1) => { ctx.strokeStyle = D.alpha(T.muted, 0.8); ctx.lineWidth = 0.8 / s; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.fillStyle = T.muted; ctx.beginPath(); ctx.arc(x1, y1, 1.6, 0, 2 * Math.PI); ctx.fill(); };
    // ----- the room -----
    const wall = [[20, 10, 640, 420, T.mu], [27, 17, 633, 413, T.vac], [31, 21, 629, 409, T.mu], [37, 27, 623, 403, T.vac], [41, 31, 619, 399, T.alu], [48, 38, 612, 392, T.surface]];
    wall.forEach(([x0, y0, x1, y1, c]) => { ctx.fillStyle = c; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); });
    glow('room', () => { ctx.beginPath(); ctx.rect(20, 10, 620, 410); ctx.rect(48, 38, 564, 354); });
    // door, feed-through panel and waveguide on the right wall
    ctx.fillStyle = D.alpha(T.ink2, 0.25); ctx.fillRect(612, 270, 28, 3); ctx.fillRect(612, 372, 28, 3);
    ctx.fillStyle = T.ink2; ctx.fillRect(612, 52, 28, 12);
    ctx.fillStyle = T.surface; ctx.fillRect(612, 236, 28, 6);
    label('door', 626, 322, { align: 'center', size: fsz * 0.85, color: T.muted });
    label('Magnetically shielded room', 58, 352, { weight: 600 });
    label('mu-metal and aluminium walls', 58, 369, { color: T.muted });
    // floor
    ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(48, 392); ctx.lineTo(612, 392); ctx.stroke();
    // ----- stimulus: projector outside, screen inside -----
    ctx.fillStyle = D.alpha('#f5d76e', T.dark ? 0.18 : 0.35);
    ctx.beginPath(); ctx.moveTo(660, 239); ctx.lineTo(486, 196); ctx.lineTo(486, 300); ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.ink2; ctx.fillRect(660, 230, 34, 18); ctx.fillRect(694, 234, 6, 10);
    ctx.fillStyle = T.metal; ctx.fillRect(480, 192, 6, 112);
    label('screen', 483, 316, { align: 'center', color: T.muted });
    label('projector', 677, 262, { align: 'center', color: T.muted });
    // ----- the subject and the chair -----
    ctx.fillStyle = T.metal; ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
    ctx.fillRect(236, 356, 120, 8); ctx.fillRect(236, 286, 8, 76); ctx.fillRect(250, 364, 6, 28); ctx.fillRect(340, 364, 6, 28);
    ctx.fillStyle = T.skin; ctx.strokeStyle = T.skinLine; ctx.lineWidth = 1.2;
    const body = () => { ctx.beginPath(); ctx.moveTo(286, 292); ctx.lineTo(314, 292); ctx.lineTo(318, 304); ctx.quadraticCurveTo(352, 312, 352, 352); ctx.lineTo(420, 352); ctx.quadraticCurveTo(430, 352, 430, 362); ctx.lineTo(430, 388); ctx.lineTo(412, 388); ctx.lineTo(412, 366); ctx.lineTo(262, 366); ctx.quadraticCurveTo(250, 362, 252, 340); ctx.quadraticCurveTo(254, 308, 284, 304); ctx.closePath(); };
    body(); ctx.fill(); ctx.stroke();
    // head
    const headPath = () => { ctx.beginPath(); ctx.arc(HC[0], HC[1], HR, 0, 2 * Math.PI); };
    headPath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(HC[0] + HR * 0.97, HC[1] - 4); ctx.lineTo(HC[0] + HR + 8, HC[1] + 8); ctx.lineTo(HC[0] + HR * 0.96, HC[1] + 13); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.ink2; ctx.beginPath(); ctx.arc(HC[0] + 32, HC[1] - 6, 2, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = T.skinLine; ctx.beginPath(); ctx.ellipse(HC[0] - 4, HC[1] + 4, 5, 9, 0, 0, 2 * Math.PI); ctx.stroke();
    // a hint of brain inside
    ctx.strokeStyle = D.alpha(T.layers.line, 0.9); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(HC[0], HC[1], HR * 0.86, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    glow('head', headPath);
    if (st.sys === 'squid') {
      // ----- the dewar -----
      const P = dewarPolygon();
      const poly = Q => { ctx.beginPath(); Q.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); };
      poly(P); ctx.fillStyle = T.vac; ctx.fill(); ctx.strokeStyle = T.metal; ctx.lineWidth = 2; ctx.stroke();
      // neck and fill port
      ctx.fillStyle = T.vac; ctx.fillRect(290, 44, 20, 18); ctx.strokeRect(290, 44, 20, 18);
      // helium vessel: body and tail
      const He = [[192, 74], [408, 74], [408, 156]];
      for (let a = 30; a >= HELMET[1] + 2; a -= 2) He.push(hp(a, 68));
      for (let a = HELMET[1] + 2; a <= 180 - HELMET[0] - 2; a += 3) He.push(hp(a, 55));
      for (let a = 180 - HELMET[0] - 2; a >= 150; a -= 2) He.push(hp(a, 68));
      He.push([192, 156]);
      poly(He); ctx.fillStyle = T.helium; ctx.fill(); ctx.strokeStyle = D.alpha(T.cold, 0.6); ctx.lineWidth = 1; ctx.stroke();
      // gas above the liquid
      ctx.fillStyle = D.alpha(T.surface, 0.55); ctx.fillRect(193, 75, 214, 24);
      ctx.strokeStyle = D.alpha(T.cold, 0.7); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(193, 99); ctx.lineTo(407, 99); ctx.stroke(); ctx.setLineDash([]);
      // superinsulation in the vacuum space
      ctx.strokeStyle = D.alpha(T.metal, 0.7); ctx.lineWidth = 0.6;
      [184, 187].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 68); ctx.lineTo(x, 160); ctx.stroke(); });
      [413, 416].forEach(x => { ctx.beginPath(); ctx.moveTo(x, 68); ctx.lineTo(x, 160); ctx.stroke(); });
      // coils and SQUIDs along the helmet
      for (let a = HELMET[1] + 6; a <= 180 - HELMET[0] - 6; a += 13) {
        const [x1, y1] = hp(a, COIL_R), [x2, y2] = hp(a, 63);
        ctx.strokeStyle = T.coil; ctx.lineWidth = 0.9; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.save(); ctx.translate(x1, y1); ctx.rotate(-a * DEG + Math.PI / 2);
        ctx.fillStyle = T.coil; ctx.fillRect(-4, -1.6, 8, 3.2);
        ctx.restore();
        ctx.fillStyle = T.squid; ctx.fillRect(x2 - 2.2, y2 - 2.2, 4.4, 4.4);
      }
      glow('coils', () => { ctx.beginPath(); ctx.arc(HC[0], HC[1], COIL_R + 3, (-(180 - HELMET[0])) * DEG, -HELMET[1] * DEG); });
      glow('dewar', () => poly(P));
      // cable to the electronics
      ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(310, 50); ctx.lineTo(612, 50); ctx.moveTo(640, 58); ctx.lineTo(730, 58); ctx.lineTo(730, 64); ctx.stroke();
      label('Dewar: liquid helium, 4.2 K', 428, 72, { weight: 600 });
      label('vacuum and superinsulation', 428, 89, { color: T.muted });
      label('Pickup coils and SQUIDs', 60, 160, { weight: 600 });
      label('2 cm or more from the scalp', 60, 177, { color: T.muted });
      leader(160, 190, ...hp(160, COIL_R + 1));
    } else {
      // ----- OPMs on the head, nulling coils on both sides -----
      [[140, 168], [432, 460]].forEach(([x0, x1]) => {
        ctx.fillStyle = D.alpha(T.alu, 0.6); ctx.fillRect(x0, 140, x1 - x0, 200);
        ctx.strokeStyle = T.coil; ctx.lineWidth = 0.9;
        for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.rect(x0 + 3 + k * 2.5, 148 + k * 10, x1 - x0 - 6 - k * 5, 184 - k * 20); ctx.stroke(); }
      });
      glow('opm', () => { ctx.beginPath(); ctx.rect(140, 140, 28, 200); ctx.rect(432, 140, 28, 200); });
      const cables = [];
      for (let a = HELMET[1] + 4; a <= 180 - HELMET[0] - 4; a += 14) {
        const [x, y] = hp(a, HR + 5);
        ctx.save(); ctx.translate(x, y); ctx.rotate(-a * DEG + Math.PI / 2);
        ctx.fillStyle = T.coil; ctx.strokeStyle = T.card; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.rect(-4, -5, 8, 10); ctx.fill(); ctx.stroke();
        ctx.restore();
        cables.push([x, y]);
      }
      ctx.strokeStyle = D.alpha(T.ink2, 0.7); ctx.lineWidth = 0.8;
      cables.forEach(([x, y], i) => { const a = HELMET[1] + 4 + i * 14, c = hp(a, HR + 46); ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(c[0], Math.min(c[1], 150), 300 + (a < 90 ? 4 : -4), 96); ctx.stroke(); });
      ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(300, 96); ctx.lineTo(300, 50); ctx.lineTo(612, 50); ctx.moveTo(640, 58); ctx.lineTo(730, 58); ctx.lineTo(730, 64); ctx.stroke();
      glow('opm', () => { ctx.beginPath(); ctx.arc(HC[0], HC[1], HR + 6, (-(180 - HELMET[0])) * DEG, -HELMET[1] * DEG); });
      label('OPMs on the scalp', 60, 160, { weight: 600 });
      label('6 mm from the scalp', 60, 177, { color: T.muted });
      leader(160, 190, ...hp(158, HR + 6));
      label('Nulling coils', 430, 130, { weight: 600, align: 'center' });
    }
    // ----- HPI coils -----
    HPI_ANG.forEach(a => {
      const [x, y] = hp(a, HR);
      ctx.fillStyle = T.card; ctx.strokeStyle = T.series[2]; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      if (HL('hpi')) { ctx.strokeStyle = D.alpha(T.accent, 0.9); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke(); }
    });
    label('Head position coils', 60, 286, { weight: 600 });
    leader(150, 294, ...hp(196, HR));
    // ----- the neurons callout -----
    ctx.strokeStyle = D.alpha(T.muted, 0.8); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    const cpt = hp(54, HR * 0.78);
    const [bx, by, br] = BUB;
    ctx.beginPath(); ctx.moveTo(cpt[0], cpt[1]); ctx.lineTo(bx - br * 0.9, by + br * 0.42); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = T.card; ctx.strokeStyle = HL('neurons') ? T.accent : T.axis; ctx.lineWidth = HL('neurons') ? 2.5 : 1.2;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.arc(bx, by, br - 1, 0, 2 * Math.PI); ctx.clip();
    ctx.fillStyle = T.layers.brain; ctx.fillRect(bx - br, by - 24, 2 * br, 2 * br);
    ctx.fillStyle = T.layers.csf; ctx.fillRect(bx - br, by - br, 2 * br, br - 24);
    for (let k = 0; k < 6; k++) {
      const x = bx - 38 + k * 15.2;
      ctx.strokeStyle = T.series[0]; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x, by - 20); ctx.lineTo(x, by + 12); ctx.stroke();
      ctx.fillStyle = T.series[0]; ctx.beginPath(); ctx.moveTo(x, by + 8); ctx.lineTo(x - 5, by + 20); ctx.lineTo(x + 5, by + 20); ctx.closePath(); ctx.fill();
    }
    D.arrow(ctx, bx, by - 16, bx, by + 30, T.series[1], 3.2, 9);
    ctx.restore();
    label('pyramidal cells', bx, by + br + 12, { align: 'center', weight: 600 });
    label('a current dipole', bx, by + br + 28, { align: 'center', color: T.muted });
    // ----- outside the room -----
    ctx.fillStyle = T.vac; ctx.strokeStyle = T.axis; ctx.lineWidth = 1;
    ctx.fillRect(690, 64, 80, 186); ctx.strokeRect(690, 64, 80, 186);
    const rack = st.sys === 'squid' ? ['flux-locked', 'loops', 'filters', 'and ADC', 'HPI coil', 'drivers'] : ['sensor', 'control', 'filters', 'and ADC', 'nulling', 'coils'];
    for (let k = 0; k < 3; k++) { ctx.fillStyle = T.surface; ctx.fillRect(696, 74 + k * 56, 68, 48); ctx.strokeRect(696, 74 + k * 56, 68, 48); label(rack[2 * k], 730, 90 + k * 56, { align: 'center', size: fsz * 0.85 }); label(rack[2 * k + 1], 730, 105 + k * 56, { align: 'center', size: fsz * 0.85 }); }
    label('Electronics', 730, 266, { align: 'center', weight: 600 });
    // computer
    ctx.fillStyle = T.ink2; ctx.fillRect(828, 282, 112, 66); ctx.fillStyle = T.surface; ctx.fillRect(832, 286, 104, 58);
    ctx.strokeStyle = T.series[0]; ctx.lineWidth = 1;
    for (let k = 0; k < 5; k++) { ctx.beginPath(); for (let i = 0; i < 50; i++) { const x = 836 + i * 2, y = 296 + k * 10 + 3 * Math.sin(i * 0.7 + k * 1.7) * Math.sin(i * 0.13); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); }
    ctx.fillStyle = T.ink2; ctx.fillRect(878, 348, 12, 10); ctx.fillRect(850, 358, 70, 4);
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(770, 230); ctx.lineTo(810, 230); ctx.lineTo(810, 315); ctx.lineTo(828, 315); ctx.stroke();
    label('acquisition', 884, 378, { align: 'center', color: T.muted });
    // digitizer
    ctx.fillStyle = T.metal; ctx.fillRect(810, 176, 170, 6); ctx.fillRect(820, 182, 5, 20); ctx.fillRect(965, 182, 5, 20);
    ctx.fillStyle = T.ink2; ctx.fillRect(838, 150, 24, 24);
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(902, 170); ctx.lineTo(940, 146); ctx.stroke();
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(862, 165); ctx.quadraticCurveTo(880, 178, 904, 169); ctx.stroke();
    if (HL('hpi')) { ctx.strokeStyle = D.alpha(T.accent, 0.9); ctx.lineWidth = 2.5; ctx.strokeRect(806, 140, 178, 66); }
    label('3D digitizer', 895, 124, { align: 'center', weight: 600 });
    label('used before the recording', 895, 140, { align: 'center', color: T.muted });
    ctx.restore();
    $('sysCap').textContent = CAPTION[st.hover || st.stage] || '';
    $('sysNote').textContent = st.sys === 'squid' ? 'Superconducting sensors in a fixed helmet.' : 'Room-temperature sensors worn on the head.';
  }

  /* ===================== 1. neurons ===================== */
  const nrn = {};
  function cortexGeometry(w, h) {
    const t = Math.max(18, h * 0.085), top = h * 0.22, xc = w * 0.6, sig = t * 2.3, depth = h * 0.48;
    const ys = x => top + depth * Math.exp(-Math.pow((x - xc) / sig, 2)) + 6 * Math.sin(x / w * Math.PI * 2);
    const dys = x => (ys(x + 0.5) - ys(x - 0.5));
    const pts = [];
    for (let x = 0; x <= w; x += 1) pts.push([x, ys(x)]);
    const cells = [];
    let acc = 0, next = 6;
    const rnd = MEG.rng(5);
    for (let i = 1; i < pts.length; i++) {
      acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc >= next) {
        next += t * 0.62;
        const x = pts[i][0], y = pts[i][1], d = dys(x), L = Math.hypot(1, d);
        const n = [d / L, -1 / L];
        const region = Math.abs(d) < 0.35 ? (x < xc ? 'crownL' : 'crownR') : (x < xc ? 'wallL' : 'wallR');
        cells.push({ x, y, n, region, phase: rnd.next() * Math.PI * 2 });
      }
    }
    return { t, top, xc, sig, ys, pts, cells };
  }
  function activeCells(geo, patch) {
    return geo.cells.filter(c => patch === 'crown' ? (c.region === 'crownL' && c.x > geo.xc - geo.sig * 5 && c.x < geo.xc - geo.sig * 1.6)
      : patch === 'wall' ? c.region === 'wallL' : (c.region === 'wallL' || c.region === 'wallR'));
  }
  function drawNeurons(time) {
    const cv = $('cvNeurons'), T = D.theme();
    const { ctx, w, h } = D.fit(cv, w => Math.min(400, Math.max(270, w * 0.64)));
    if (!nrn.geo || nrn.geo.w !== w || nrn.geo.h !== h) { nrn.geo = cortexGeometry(w, h); nrn.geo.w = w; nrn.geo.h = h; }
    const geo = nrn.geo, patch = $('nrnPatch').value;
    ctx.fillStyle = T.layers.csf; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = T.layers.skull; ctx.fillRect(0, 0, w, Math.max(10, geo.top - 40));
    ctx.fillStyle = T.layers.brain;
    ctx.beginPath(); ctx.moveTo(0, h); geo.pts.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.dark ? '#2a2526' : '#f8f4f2';
    ctx.beginPath();
    let first = true;
    for (let x = 0; x <= w; x += 2) {
      const d = geo.ys(x + 0.5) - geo.ys(x - 0.5), L = Math.hypot(1, d);
      const px = x - d / L * geo.t * 1.8, py = geo.ys(x) + geo.t * 1.8 / L;
      if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
    }
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.muted; ctx.font = D.font(11); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('skull, scalp, and the sensors above', 8, 4);
    ctx.fillText('CSF', 8, Math.max(14, geo.top - 34));
    ctx.fillText('grey matter', 8, geo.ys(8) + geo.t * 1.35); ctx.fillText('white matter', 8, h - 18);
    ctx.textAlign = 'center'; ctx.fillText('sulcus', geo.xc, geo.ys(geo.xc) + 6);
    ctx.fillText('gyral crown', geo.xc - geo.sig * 3.4, geo.top - 18);
    const act = new Set(activeCells(geo, patch));
    const phase = time * 2 * Math.PI * 0.6;
    const amp = 0.55 + 0.45 * Math.sin(phase);
    geo.cells.forEach(c => {
      const on = act.has(c);
      const level = on ? amp : 0;
      const soma = [c.x - c.n[0] * geo.t * 1.25, c.y - c.n[1] * geo.t * 1.25];
      const tuft = [c.x - c.n[0] * geo.t * 0.12, c.y - c.n[1] * geo.t * 0.12];
      ctx.strokeStyle = on ? D.alpha(T.series[0], 0.35 + 0.65 * level) : T.layers.line;
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.beginPath(); ctx.moveTo(soma[0], soma[1]); ctx.lineTo(tuft[0], tuft[1]); ctx.stroke();
      const tx = -c.n[1], ty = c.n[0];
      ctx.beginPath(); ctx.moveTo(tuft[0], tuft[1]); ctx.lineTo(tuft[0] + tx * 4 + c.n[0] * 3, tuft[1] + ty * 4 + c.n[1] * 3);
      ctx.moveTo(tuft[0], tuft[1]); ctx.lineTo(tuft[0] - tx * 4 + c.n[0] * 3, tuft[1] - ty * 4 + c.n[1] * 3); ctx.stroke();
      const s = 4.5;
      ctx.fillStyle = on ? D.alpha(T.series[0], 0.55 + 0.45 * level) : T.layers.line;
      ctx.beginPath();
      ctx.moveTo(soma[0] + c.n[0] * s * 1.4, soma[1] + c.n[1] * s * 1.4);
      ctx.lineTo(soma[0] + tx * s - c.n[0] * s * 0.6, soma[1] + ty * s - c.n[1] * s * 0.6);
      ctx.lineTo(soma[0] - tx * s - c.n[0] * s * 0.6, soma[1] - ty * s - c.n[1] * s * 0.6);
      ctx.closePath(); ctx.fill();
      if (on && !reduced) {
        const f = (time * 0.9 + c.phase) % 1;
        const px = tuft[0] + (soma[0] - tuft[0]) * f, py = tuft[1] + (soma[1] - tuft[1]) * f;
        ctx.fillStyle = T.series[0]; ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 2 * Math.PI); ctx.fill();
      }
    });
    // the net dipole of each group, its return currents and its magnetic field
    const list = Array.from(act);
    const groups = patch === 'both' ? [list.filter(c => c.region === 'wallL'), list.filter(c => c.region === 'wallR')] : [list];
    groups.forEach(gr => {
      if (!gr.length) return;
      const mid = gr[Math.floor(gr.length / 2)];
      const nx = gr.reduce((a, c) => a + c.n[0], 0) / gr.length, ny = gr.reduce((a, c) => a + c.n[1], 0) / gr.length;
      const L = Math.hypot(nx, ny), n = [nx / L, ny / L], side = [-n[1], n[0]];
      const cx = mid.x - n[0] * geo.t * 0.7, cy = mid.y - n[1] * geo.t * 0.7;
      const sgn = patch === 'crown' ? 0 : (mid.region === 'wallL' ? -1 : 1);
      const ax = cx + side[0] * sgn * geo.t * 1.9, ay = cy + side[1] * sgn * geo.t * 1.9;
      const len = geo.t * 2.4 * amp;
      // return currents: two loops from the tip back to the tail through the tissue
      ctx.strokeStyle = D.alpha(T.muted, 0.75); ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      [-1, 1].forEach(k => {
        ctx.beginPath();
        ctx.moveTo(ax - n[0] * len / 2, ay - n[1] * len / 2);
        ctx.bezierCurveTo(ax - n[0] * len + side[0] * k * len * 1.3, ay - n[1] * len + side[1] * k * len * 1.3, ax + n[0] * len + side[0] * k * len * 1.3, ay + n[1] * len + side[1] * k * len * 1.3, ax + n[0] * len / 2, ay + n[1] * len / 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      // the dipole: inward, from the apical dendrites toward the somata
      D.arrow(ctx, ax + n[0] * len / 2, ay + n[1] * len / 2, ax - n[0] * len / 2, ay - n[1] * len / 2, T.series[1], 3, 9);
      // field circling the current: out of the page on one side, into it on the other
      [-1, 1].forEach(k => {
        const fx = ax + side[0] * k * geo.t * 1.15, fy = ay + side[1] * k * geo.t * 1.15;
        ctx.strokeStyle = T.series[6]; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(fx, fy, 5, 0, 2 * Math.PI); ctx.stroke();
        if (k > 0) { ctx.fillStyle = T.series[6]; ctx.beginPath(); ctx.arc(fx, fy, 1.6, 0, 2 * Math.PI); ctx.fill(); }
        else { ctx.beginPath(); ctx.moveTo(fx - 3, fy - 3); ctx.lineTo(fx + 3, fy + 3); ctx.moveTo(fx + 3, fy - 3); ctx.lineTo(fx - 3, fy + 3); ctx.stroke(); }
      });
    });
    ctx.fillStyle = T.ink2; ctx.font = D.font(11); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('orange: net current dipole · dashed: volume currents · green: magnetic field', w - 8, h - 6);
  }
  function neuronNumbers() {
    const patch = $('nrnPatch').value, A = parseFloat($('nrnArea').value), s = parseFloat($('nrnSync').value) / 100;
    $('nrnAreaV').textContent = A >= 100 ? (A / 100).toFixed(1) + ' cm²' : A.toFixed(0) + ' mm²';
    $('nrnSyncV').textContent = (s * 100).toFixed(2).replace(/0$/, '') + '%';
    const N = A * 1e5;                        // pyramidal cells under 1 mm^2 of cortex, order of magnitude
    const p = 5e-4;                           // nA*m per active cell, about 0.5 pA*m
    const qs = N * s * p, qa = Math.sqrt(N * Math.max(0, 1 - s)) * p;
    const srcs = [];
    if (patch === 'crown') { const pos = MEG.placeAt('C3', 1.6); srcs.push({ pos, q: v3.scale(MEG.orientation(pos, 180, 0), qs) }); }
    else if (patch === 'wall') { const pos = MEG.placeAt('C3', 2.2); srcs.push({ pos, q: v3.scale(MEG.orientation(pos, 90, 0), qs) }); }
    else {
      const pos = MEG.placeAt('C3', 2.2), t1 = MEG.tangentFrame(pos).t1;
      srcs.push({ pos: v3.add(pos, v3.scale(t1, 0.25)), q: v3.scale(t1, qs / 2) });
      srcs.push({ pos: v3.sub(pos, v3.scale(t1, 0.25)), q: v3.scale(t1, -qs / 2) });
    }
    const vm = megMag(srcs), ve = eegAvg(headModel(), srcs);
    const pm = peakAbs(vm), pe = peakAbs(ve);
    const vis = pm > 300 ? 'yes, in single trials' : pm > 100 ? 'barely, in single trials' : pm > 0.5 ? `after about ${Math.min(99999, Math.ceil(Math.pow(3 * 150 / pm, 2)))} trials` : 'never';
    ui.readouts($('nrnReadouts'), [
      ['Pyramidal cells', N.toExponential(1).replace('e+', ' × 10^')],
      ['Synchronous dipole', MEG.fmt(patch === 'both' ? qs / 2 : qs, qs < 10 ? 1 : 0) + ' nAm' + (patch === 'both' ? ' each' : '')],
      ['Same cells at random', MEG.fmt(qa, 2) + ' nAm'],
      ['Largest field', MEG.fmtB(pm), 'magnetometers 2 to 4 cm from the scalp'],
      ['Largest potential', MEG.fmt(pe, pe < 10 ? 2 : 1) + ' µV', 'average reference, 64 electrodes'],
      ['Visible above 150 fT of background?', vis]
    ]);
    D.topoCanvas($('cvNrnMEG'), D.sites(), vm, { unit: 'fT', maxH: 210, title: 'MEG, magnetometers', fmt: v => MEG.fmt(v, Math.abs(v) < 10 ? 1 : 0), range: pm || 1 });
    D.topoCanvas($('cvNrnEEG'), EEGSET(), ve, { unit: 'µV', maxH: 210, title: 'EEG, average reference', range: pe || 1, fmt: v => MEG.fmt(v, Math.abs(v) < 10 ? 2 : 1) });
  }

  /* ===================== 2. the head ===================== */
  function drawHeadStage() {
    const ratio = parseFloat($('hdRatio').value), tilt = parseFloat($('hdTilt').value);
    $('hdRatioV').textContent = '1 : ' + ratio;
    $('hdTiltV').textContent = tilt + '°';
    const sigma = MEG.HEAD.sigma.slice(); sigma[2] = sigma[0] / ratio;
    const pos = MEG.placeAt('C3', 2.5), q = v3.scale(MEG.orientation(pos, tilt, 0), 20);
    MEG.views.electricPlane($('cvHeadCur'), { r0: pos, q, sigma, height: w => Math.min(360, w * 0.8), lines: 14, label: `skull conductivity 1 : ${ratio}` });
    const model = MEG.headModel({ sigma });
    const ve = eegAvg(model, [{ pos, q }]), vm = megMag([{ pos, q }]);
    const ve40 = eegAvg(headModel(), [{ pos, q }]);
    const pm = peakAbs(vm), pe = peakAbs(ve), pe40 = peakAbs(ve40);
    D.topoCanvas($('cvHdMEG'), D.sites(), vm, { unit: 'fT', maxH: 220, title: 'MEG: field', range: pm || 1, fmt: v => MEG.fmt(v, 0) });
    D.topoCanvas($('cvHdEEG'), EEGSET(), ve, { unit: 'µV', maxH: 220, title: 'EEG: potential', range: pe || 1, fmt: v => MEG.fmt(v, 2) });
    // spread: distance between the EEG extrema
    const U = U64();
    let iMax = 0, iMin = 0; ve.forEach((x, i) => { if (x > ve[iMax]) iMax = i; if (x < ve[iMin]) iMin = i; });
    const sep = Math.acos(MEG.clamp(v3.dot(U[iMax], U[iMin]), -1, 1)) * MEG.HEAD.R;
    ui.readouts($('hdReadouts'), [
      ['MEG peak', MEG.fmtB(pm), 'the same for every skull conductivity'],
      ['EEG peak', MEG.fmt(pe, 2) + ' µV'],
      ['EEG peak at 1 : 40', MEG.fmt(pe40, 2) + ' µV'],
      ['EEG extrema apart', sep.toFixed(1) + ' cm', 'along the scalp; wider means more smearing']
    ]);
  }

  /* ===================== 3. coils and SQUIDs ===================== */
  const COIL = { magR: 0.9, axialBase: 5, planarBase: 1.68, planarR: 0.6, imbAxial: 1e-3, imbPlanar: 2e-4, gap: 2.4, noiseMoment: 500 };
  // flux-weighted mean of Bz over a horizontal disc (7-point rule)
  function discBz(fn, c, R) {
    const pts = [[0, 0, 0.25]];
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; pts.push([0.75 * R * Math.cos(a), 0.75 * R * Math.sin(a), 0.125]); }
    let s = 0; pts.forEach(([dx, dy, w]) => { s += w * fn([c[0] + dx, c[1] + dy, c[2]])[2]; });
    return s;
  }
  // The reading of one coil type for a field function, with the coil centred at (x, 0, z).
  function coilReading(type, fn, x, z) {
    if (type === 'mag') return discBz(fn, [x, 0, z], COIL.magR);
    if (type === 'axial') { const a = discBz(fn, [x, 0, z], COIL.magR), b = discBz(fn, [x, 0, z + COIL.axialBase], COIL.magR); return a - b * (1 + COIL.imbAxial); }
    const b2 = COIL.planarBase / 2;
    const a = discBz(fn, [x + b2, 0, z], COIL.planarR), b = discBz(fn, [x - b2, 0, z], COIL.planarR);
    return (a - b * (1 + COIL.imbPlanar)) / COIL.planarBase;
  }
  function coilNumbers() {
    const depth = parseFloat($('coilDepth').value), far = Math.pow(10, parseFloat($('coilFar').value));
    $('coilDepthV').textContent = depth.toFixed(1) + ' cm';
    $('coilFarV').textContent = far < 1 ? Math.round(far * 100) + ' cm' : far.toFixed(far < 10 ? 1 : 0) + ' m';
    const z = MEG.HEAD.R + COIL.gap, r0 = [0, 0, MEG.HEAD.R - depth], q = [0, 20, 0];
    const brain = p => MEG.sarvas(p, r0, q);
    const noise = p => MEG.magDipole(p, [far * 100, 0, z], [0, 0, COIL.noiseMoment]);
    const out = {};
    ['mag', 'axial', 'planar'].forEach(t => {
      let best = 0, bx = 0;
      for (let x = -9; x <= 9; x += 0.25) { const v = Math.abs(coilReading(t, brain, x, z)); if (v > best) { best = v; bx = x; } }
      out[t] = { brain: best, x: bx, noise: Math.abs(coilReading(t, noise, bx, z)) };
    });
    st.coilNums = out;
    const o = out[st.coil], unit = st.coil === 'planar' ? 'fT/cm' : 'fT';
    const ratio = o.brain / Math.max(o.noise, 1e-30);
    ui.readouts($('coilReadouts'), [
      ['Brain source, best placed coil', ui.fmtV(o.brain, unit), '20 nAm, tangential'],
      ['Noise source', ui.fmtV(o.noise, unit), `a magnetic dipole of ${COIL.noiseMoment} A·m², like a car, at this distance`],
      ['Brain : noise', ratio >= 1 ? fmtBig(ratio) + ' : 1' : '1 : ' + fmtBig(1 / ratio)],
      ['Field of the noise at the head', MEG.fmtB(Math.abs(MEG.magDipole([0, 0, z], [far * 100, 0, z], [0, 0, COIL.noiseMoment])[2]))]
    ]);
    return out;
  }
  function drawCoil() {
    const T = D.theme(), cv = $('cvCoil');
    const { ctx, w, h } = D.fit(cv, w => Math.min(330, w * 0.7));
    const depth = parseFloat($('coilDepth').value);
    const sc = Math.min(w * 0.55 / 22, h / 15);       // pixels per cm
    const cx = w * 0.32, scalpY = h - 1.2 * sc;
    const Y = zc => scalpY - zc * sc, X = xc => cx + xc * sc;
    // scalp arc (a slab of head) and the dewar's bottom
    ctx.fillStyle = T.layers.scalp; ctx.fillRect(0, scalpY, w * 0.62, h - scalpY);
    ctx.fillStyle = T.layers.brain; ctx.fillRect(0, scalpY + 1.2 * sc, w * 0.62, h);
    ctx.fillStyle = D.alpha(T.helium, 0.9); ctx.fillRect(0, 0, w * 0.62, Y(1.8));
    ctx.strokeStyle = T.metal; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, Y(1.8)); ctx.lineTo(w * 0.62, Y(1.8)); ctx.stroke();
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('liquid helium', 6, 4); ctx.fillText('scalp', 6, scalpY + 2);
    ctx.textBaseline = 'bottom'; ctx.fillText('dewar wall and vacuum', 6, Y(1.8) - 2 + 14);
    // brain source (into the page) and its field circles
    const dz = depth;
    const sxp = X(0), syp = scalpY + dz * sc * 0.55;
    ctx.strokeStyle = D.alpha(T.series[6], 0.55); ctx.lineWidth = 1;
    [0.8, 1.6, 2.6, 3.8].forEach(rr => { ctx.beginPath(); ctx.arc(sxp, syp, rr * sc, Math.PI, 2 * Math.PI); ctx.stroke(); });
    ctx.strokeStyle = T.series[1]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sxp, syp, 6, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sxp - 4, syp - 4); ctx.lineTo(sxp + 4, syp + 4); ctx.moveTo(sxp + 4, syp - 4); ctx.lineTo(sxp - 4, syp + 4); ctx.stroke();
    D.label(ctx, `brain source, ${depth.toFixed(1)} cm deep`, sxp + 10, syp, { size: 10 });
    // pickup coil(s)
    const nums = st.coilNums || coilNumbers();
    const t = st.coil, bx = nums[t].x;
    const zc = COIL.gap;
    const loop = (xc, zz, r, wind) => {
      const x = X(xc), y = Y(zz);
      ctx.strokeStyle = T.coil; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.ellipse(x, y, r * sc, r * sc * 0.28, 0, 0, 2 * Math.PI); ctx.stroke();
      // winding direction
      const ax = x + r * sc * (wind > 0 ? 0.3 : -0.3), ay = y + r * sc * 0.27;
      D.arrow(ctx, ax - wind * 6, ay, ax + wind * 6, ay, T.coil, 1.6, 5);
    };
    if (t === 'mag') loop(bx, zc, COIL.magR, 1);
    else if (t === 'axial') { loop(bx, zc, COIL.magR, 1); loop(bx, zc + COIL.axialBase, COIL.magR, -1); ctx.strokeStyle = T.coil; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(X(bx - COIL.magR), Y(zc)); ctx.lineTo(X(bx - COIL.magR), Y(zc + COIL.axialBase)); ctx.moveTo(X(bx + COIL.magR), Y(zc)); ctx.lineTo(X(bx + COIL.magR), Y(zc + COIL.axialBase)); ctx.stroke(); }
    else { loop(bx - COIL.planarBase / 2, zc, COIL.planarR, 1); loop(bx + COIL.planarBase / 2, zc, COIL.planarR, -1); }
    // flux transformer to the SQUID
    const top = t === 'axial' ? Y(zc + COIL.axialBase) : Y(zc);
    const sqx = w * 0.72, sqy = h * 0.32;
    ctx.strokeStyle = T.coil; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(X(bx) - 2, top - 4); ctx.lineTo(X(bx) - 2, 12); ctx.lineTo(sqx - 40, 12); ctx.lineTo(sqx - 40, sqy - 10);
    ctx.moveTo(X(bx) + 2, top - 4); ctx.lineTo(X(bx) + 2, 16); ctx.lineTo(sqx - 44, 16); ctx.lineTo(sqx - 44, sqy + 10); ctx.stroke();
    // input coil and SQUID washer
    ctx.strokeStyle = T.coil; ctx.lineWidth = 1.6;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.arc(sqx - 42, sqy - 9 + k * 6, 4, -Math.PI / 2, Math.PI / 2); ctx.stroke(); }
    ctx.strokeStyle = T.squid; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(sqx, sqy, 22, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = T.card; ctx.fillRect(sqx - 4, sqy - 26, 8, 8); ctx.fillRect(sqx - 4, sqy + 18, 8, 8);
    ctx.strokeStyle = T.ink; ctx.lineWidth = 1.6;
    [[sqx, sqy - 22], [sqx, sqy + 22]].forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke(); });
    D.label(ctx, 'SQUID', sqx, sqy, { align: 'center', size: 10, weight: 600 });
    D.label(ctx, 'two Josephson junctions', sqx, sqy + 40, { align: 'center', size: 10, color: T.muted });
    // flux-locked loop
    const fx = w * 0.72, fy = h * 0.72;
    ctx.fillStyle = T.surface; ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.fillRect(fx - 46, fy - 18, 92, 36); ctx.strokeRect(fx - 46, fy - 18, 92, 36);
    D.label(ctx, 'flux-locked loop', fx, fy - 4, { align: 'center', size: 10, weight: 600 });
    D.label(ctx, 'room temperature', fx, fy + 9, { align: 'center', size: 9, color: T.muted });
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(sqx + 22, sqy); ctx.lineTo(sqx + 50, sqy); ctx.lineTo(sqx + 50, fy); ctx.lineTo(fx + 46, fy); ctx.stroke();
    ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(fx - 46, fy); ctx.lineTo(sqx - 70, fy); ctx.lineTo(sqx - 70, sqy + 26); ctx.lineTo(sqx - 26, sqy + 26); ctx.stroke(); ctx.setLineDash([]);
    D.label(ctx, 'feedback', sqx - 66, fy - 10, { size: 9, color: T.muted });
    D.arrow(ctx, fx, fy + 18, fx, fy + 40, T.ink2, 1.4, 6);
    D.label(ctx, 'output voltage', fx, fy + 50, { align: 'center', size: 10 });
    // the distant source's field: nearly uniform vertical lines
    ctx.strokeStyle = D.alpha(T.series[7], 0.5); ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
    for (let k = 0; k < 5; k++) { const x = 14 + k * 9; ctx.beginPath(); ctx.moveTo(x, Y(1.8) - 6); ctx.lineTo(x, 30); ctx.stroke(); }
    ctx.setLineDash([]);
    D.label(ctx, 'distant noise: nearly uniform', 8, 40, { size: 9, color: T.series[7] });
  }
  function drawFalloff() {
    const T = D.theme();
    if (!st.plots.fall) st.plots.fall = new D.Plot($('cvCoilFalloff'), { height: 250 });
    const xs = [], ym = [], ya = [], yp = [];
    const resp = (t, r) => {
      const src = [0.3 * r, 0, -r];
      const fn = p => MEG.magDipole(p, src, [0, 0, 1]);
      return Math.abs(coilReading(t, fn, 0, 0));
    };
    const ref = { mag: resp('mag', 4), axial: resp('axial', 4), planar: resp('planar', 4) };
    for (let e = 0; e <= 4.0; e += 0.04) {
      const r = Math.pow(10, e);
      xs.push(r); ym.push(resp('mag', r) / ref.mag); ya.push(resp('axial', r) / ref.axial); yp.push(resp('planar', r) / ref.planar);
    }
    st.plots.fall.draw({
      x: xs, xLog: true, yLog: true, xRange: [1, 1e4], yRange: [1e-16, 30],
      xLabel: 'distance of the source (cm)', yLabel: 'response, relative to 4 cm',
      series: [{ y: ym, color: T.series[0], label: 'magnetometer' }, { y: ya, color: T.series[1], label: 'axial gradiometer' }, { y: yp, color: T.series[2], label: 'planar gradiometer' }],
      vlines: [{ x: 4, label: 'brain', color: T.muted, dash: [3, 3] }, { x: 35, label: 'heart', color: T.muted, dash: [3, 3] }, { x: 1500, label: 'elevator', color: T.muted, dash: [3, 3] }, { x: Math.pow(10, parseFloat($('coilFar').value)) * 100, label: 'noise source', color: T.series[7], row: 1 }],
      tipFmt: v => v.toExponential(1), tipX: x => `${x < 100 ? x.toFixed(1) + ' cm' : (x / 100).toFixed(1) + ' m'}`
    });
    ui.legend($('coilFalloffLegend'), [{ color: T.series[0], label: 'magnetometer' }, { color: T.series[1], label: 'axial gradiometer, 5 cm baseline' }, { color: T.series[2], label: 'planar gradiometer, 1.7 cm' }]);
  }
  function drawSquid() {
    const T = D.theme();
    if (!st.plots.squid) st.plots.squid = new D.Plot($('cvSquid'), { height: 230, noHover: false });
    const xs = [], ys = [];
    for (let f = -1.6; f <= 1.6; f += 0.005) { xs.push(f); ys.push(20 + 30 * (1 - Math.abs(Math.cos(Math.PI * f)))); }
    st.plots.squid.draw({
      x: xs, xRange: [-1.6, 1.6], yRange: [10, 60], xLabel: 'flux through the SQUID (flux quanta, Φ₀)', yLabel: 'voltage (µV)',
      series: [{ y: ys, color: T.squid, label: 'voltage' }],
      markers: [{ x: 0.25, y: 20 + 30 * (1 - Math.cos(Math.PI * 0.25)), color: T.series[1], label: 'working point, held by feedback', r: 5 }],
      vlines: [-1, 0, 1].map(x => ({ x, color: T.grid })),
      tipFmt: v => v.toFixed(1) + ' µV', tipX: x => `${x.toFixed(2)} Φ₀`
    });
  }
  function drawFLL() {
    const T = D.theme();
    const step = parseFloat($('fllStep').value), k = parseFloat($('fllSlew').value);
    $('fllStepV').textContent = step.toFixed(2) + ' Φ₀';
    $('fllSlewV').textContent = Math.round(k * 100) + '% per step';
    const n = 600, xs = [], fin = [], fout = [];
    let y = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n * 2;
      const ramp = MEG.clamp((t - 1) / 0.006, 0, 1);
      const inp = 0.3 * Math.sin(2 * Math.PI * 1.5 * t) + step * ramp;
      const err = inp - y, wrapped = err - Math.round(err);
      y += k * wrapped;
      xs.push(t); fin.push(inp); fout.push(y);
    }
    const off = fin[n - 1] - fout[n - 1];
    if (!st.plots.fll) st.plots.fll = new D.Plot($('cvFLL'), { height: 200 });
    st.plots.fll.draw({
      x: xs, xLabel: 'time (s)', yLabel: 'flux (Φ₀)',
      series: [{ y: fin, color: T.muted, label: 'flux from the pickup coil', dash: [5, 4] }, { y: fout, color: T.series[0], label: 'loop output' }],
      after: (ctx, m) => { if (Math.abs(off) > 0.5) D.label(ctx, `flux jump: the output is ${Math.round(off) > 0 ? '' : '+'}${-Math.round(off)} Φ₀ off for good`, m.X0 + 8, m.Y0 + 10, { color: T.crit, weight: 600 }); },
      tipFmt: v => v.toFixed(2) + ' Φ₀', tipX: x => x.toFixed(3) + ' s'
    });
    ui.legend($('fllLegend'), [{ color: T.muted, label: 'flux from the pickup coil', dash: true }, { color: T.series[0], label: 'flux-locked loop output' }]);
  }

  /* ===================== 4. the dewar ===================== */
  function drawDewar() {
    const T = D.theme(), cv = $('cvDewar');
    const { ctx, w, h } = D.fit(cv, w => Math.min(430, w * 0.8));
    const s = Math.min(w / 520, h / 430), ox = (w - 520 * s) / 2;
    ctx.save(); ctx.translate(ox, 0); ctx.scale(s, s);
    const gap = parseFloat($('dwGap').value);
    const cx = 260, hcY = 330, hr = 92, upc = hr / 9.2;
    const coilR = hr + gap * upc;
    const pt = (a, r) => [cx + r * Math.cos(a * DEG), hcY - r * Math.sin(a * DEG)];
    const shape = (rIn, rOut, top, half) => {
      ctx.beginPath(); ctx.moveTo(cx - half, top); ctx.lineTo(cx + half, top); ctx.lineTo(cx + half, 150);
      for (let a = 30; a >= 10; a -= 2) ctx.lineTo(...pt(a, rOut));
      for (let a = 10; a <= 170; a += 2) ctx.lineTo(...pt(a, rIn));
      for (let a = 170; a >= 150; a -= 2) ctx.lineTo(...pt(a, rOut));
      ctx.lineTo(cx - half, 150); ctx.closePath();
    };
    // outer vessel (room temperature), radiation shield, helium vessel
    const wallIn = Math.max(hr + 4, coilR - 0.9 * upc), heIn = coilR - 0.25 * upc;
    shape(wallIn, coilR + 3.4 * upc, 20, 200); ctx.fillStyle = T.vac; ctx.fill(); ctx.strokeStyle = T.metal; ctx.lineWidth = 2.5; ctx.stroke();
    shape(wallIn + (heIn - wallIn) * 0.45, coilR + 2.6 * upc, 34, 186); ctx.strokeStyle = D.alpha(T.metal, 0.7); ctx.lineWidth = 1; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    shape(heIn, coilR + 1.6 * upc, 50, 170); ctx.fillStyle = T.helium; ctx.fill(); ctx.strokeStyle = D.alpha(T.cold, 0.7); ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = D.alpha(T.surface, 0.6); ctx.fillRect(cx - 169, 51, 338, 40);
    ctx.strokeStyle = T.cold; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(cx - 169, 91); ctx.lineTo(cx + 169, 91); ctx.stroke(); ctx.setLineDash([]);
    // neck, baffles, fill port
    ctx.fillStyle = T.vac; ctx.strokeStyle = T.metal; ctx.lineWidth = 1.5; ctx.fillRect(cx - 18, 0, 36, 22); ctx.strokeRect(cx - 18, 0, 36, 22);
    // head
    ctx.fillStyle = T.skin; ctx.strokeStyle = T.skinLine; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, hcY, hr, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = D.alpha(T.layers.line, 0.8); ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(cx, hcY, hr * 0.86, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    // coils and SQUIDs
    for (let a = 16; a <= 164; a += 12) {
      const [x, y] = pt(a, coilR), [x2, y2] = pt(a, coilR + 0.9 * upc);
      ctx.save(); ctx.translate(x, y); ctx.rotate(-a * DEG + Math.PI / 2); ctx.fillStyle = T.coil; ctx.fillRect(-7, -2, 14, 4); ctx.restore();
      ctx.fillStyle = T.squid; ctx.fillRect(x2 - 3, y2 - 3, 6, 6);
    }
    // the gap
    const [gx0, gy0] = pt(70, hr), [gx1, gy1] = pt(70, coilR + 2.2 * upc);
    ctx.strokeStyle = T.series[1]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(gx0, gy0); ctx.lineTo(gx1, gy1); ctx.stroke();
    ctx.fillStyle = T.series[1]; ctx.beginPath(); ctx.arc(gx0, gy0, 2.5, 0, 2 * Math.PI); ctx.fill();
    const [cx1, cy1] = pt(70, coilR); ctx.beginPath(); ctx.arc(cx1, cy1, 2.5, 0, 2 * Math.PI); ctx.fill();
    D.label(ctx, `coil to scalp ${gap.toFixed(1)} cm`, gx1 + 4, gy1 - 6, { color: T.series[1], weight: 600, size: 13 });
    const lab = (t, x, y, o) => D.label(ctx, t, x, y, Object.assign({ size: 12 }, o || {}));
    lab('liquid helium, 4.2 K', cx, 120, { align: 'center', weight: 600 });
    lab('helium gas', cx, 72, { align: 'center', color: T.muted });
    lab('vacuum, superinsulation', cx - 196, 160, { color: T.muted });
    lab('room temperature outside', cx + 120, 12, { color: T.muted });
    lab('pickup coils', ...pt(178, coilR + 10), { align: 'right', color: T.coil, weight: 600 });
    lab('SQUIDs', ...pt(4, coilR + 1.4 * upc), { color: T.squid, weight: 600 });
    lab('scalp at 37 °C', cx, hcY + 30, { align: 'center', color: T.muted });
    ctx.restore();
  }
  // Largest radial field over a cap of positions at radius R above a tangential dipole.
  function peakAt(R, r0, q, normal) {
    let best = 0, iMax = null, iMin = null, vmax = -Infinity, vmin = Infinity;
    const dir = v3.unit(r0);
    MEG.fibonacciSphere(1500).forEach(u => {
      if (v3.dot(u, dir) < 0.5) return;
      const p = v3.scale(u, R), B = MEG.sarvas(p, r0, q), v = v3.dot(B, normal ? normal(u) : u);
      if (Math.abs(v) > best) best = Math.abs(v);
      if (v > vmax) { vmax = v; iMax = u; } if (v < vmin) { vmin = v; iMin = u; }
    });
    return { peak: best, sep: iMax && iMin ? Math.acos(MEG.clamp(v3.dot(iMax, iMin), -1, 1)) * R : 0 };
  }
  function drawDewarGap() {
    const T = D.theme();
    const gap = parseFloat($('dwGap').value), depth = parseFloat($('dwDepth').value);
    $('dwGapV').textContent = gap.toFixed(2) + ' cm';
    $('dwDepthV').textContent = depth.toFixed(1) + ' cm';
    const r0 = [0, 0, MEG.HEAD.R - depth], q = [0, 20, 0];
    const xs = [], ys = [];
    for (let g = 0.3; g <= 4.5001; g += 0.1) { xs.push(g); ys.push(peakAt(MEG.HEAD.R + g, r0, q).peak); }
    const here = peakAt(MEG.HEAD.R + gap, r0, q), opm = peakAt(MEG.HEAD.R + 0.6, r0, q), squid = peakAt(MEG.HEAD.R + 2.4, r0, q);
    if (!st.plots.gap) st.plots.gap = new D.Plot($('cvDewarGap'), { height: 230 });
    st.plots.gap.draw({
      x: xs, yLog: true, xLabel: 'distance from the scalp to the coil (cm)', yLabel: 'largest field (fT)',
      series: [{ y: ys, color: T.series[0], label: 'largest field, 20 nAm' }],
      markers: [{ x: 0.6, y: opm.peak, color: T.coil, label: 'OPM' }, { x: 2.4, y: squid.peak, color: T.squid, label: 'SQUID, top of the head' }],
      vlines: [{ x: gap, color: T.series[1] }],
      tipFmt: v => MEG.fmtB(v), tipX: x => x.toFixed(1) + ' cm'
    });
    ui.legend($('dwLegend'), [{ color: T.series[0], label: `radial field of a 20 nAm tangential dipole ${depth.toFixed(1)} cm deep` }]);
    ui.readouts($('dwReadouts'), [
      ['Field at this distance', MEG.fmtB(here.peak)],
      ['OPM at 6 mm', MEG.fmtB(opm.peak)],
      ['SQUID at 2.4 cm', MEG.fmtB(squid.peak)],
      ['Gain from 2.4 cm to 6 mm', MEG.fmt(opm.peak / squid.peak, 1) + '×'],
      ['Extrema apart', here.sep.toFixed(1) + ' cm', 'distance between the two field extrema; closer sensors see a tighter pattern']
    ]);
    drawDewar();
  }

  /* ===================== 5. the shielded room ===================== */
  function drawRoom() {
    const T = D.theme(), cv = $('cvRoom');
    const { ctx, w, h } = D.fit(cv, w => Math.min(360, w * 0.78));
    const s = Math.min(w / 460, h / 360), ox = (w - 460 * s) / 2, oy = (h - 360 * s) / 2;
    ctx.save(); ctx.translate(ox, oy); ctx.scale(s, s);
    // field lines bending into the walls
    ctx.strokeStyle = D.alpha(T.series[7], 0.55); ctx.lineWidth = 1.2;
    const x0 = 120, x1 = 380, y0 = 70, y1 = 300;
    [30, 50, 330, 350].forEach(y => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(460, y); ctx.stroke(); });
    [[100, 'top'], [140, 'top'], [180, 'top'], [220, 'bottom'], [260, 'bottom']].forEach(([y, side]) => {
      const yw = side === 'top' ? y0 + 6 : y1 - 6;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(x0 - 30, y); ctx.quadraticCurveTo(x0 - 2, y, x0 + 3, (y + yw) / 2); ctx.lineTo(x0 + 3, yw);
      ctx.lineTo(x1 - 3, yw); ctx.lineTo(x1 - 3, (y + yw) / 2); ctx.quadraticCurveTo(x1 + 2, y, x1 + 30, y); ctx.lineTo(460, y); ctx.stroke();
    });
    D.arrow(ctx, 10, 18, 70, 18, T.series[7], 1.6, 7);
    D.label(ctx, 'Earth’s field and the city, 50 µT', 76, 18, { size: 12, color: T.series[7] });
    // walls
    [[0, T.mu], [6, T.vac], [10, T.mu], [16, T.vac], [20, T.alu]].forEach(([d, c], k, all) => {
      const nd = k + 1 < all.length ? all[k + 1][0] : 26;
      ctx.fillStyle = c; ctx.beginPath(); ctx.rect(x0 + d, y0 + d, x1 - x0 - 2 * d, y1 - y0 - 2 * d); ctx.rect(x0 + nd, y0 + nd, x1 - x0 - 2 * nd, y1 - y0 - 2 * nd); ctx.fill('evenodd');
    });
    ctx.fillStyle = T.surface; ctx.fillRect(x0 + 26, y0 + 26, x1 - x0 - 52, y1 - y0 - 52);
    // door
    ctx.strokeStyle = T.ink2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x1 - 26, y1 - 90); ctx.lineTo(x1 - 26, y1 - 30); ctx.stroke();
    ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x1 - 26, y1 - 30, 60, -Math.PI / 2, -Math.PI / 2 + 0.5); ctx.stroke(); ctx.setLineDash([]);
    // dewar and chair from above
    ctx.fillStyle = T.vac; ctx.strokeStyle = T.metal; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(230, 180, 34, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.helium; ctx.beginPath(); ctx.arc(230, 180, 26, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = T.skin; ctx.beginPath(); ctx.arc(230, 180, 14, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = T.metal; ctx.fillRect(196, 172, 10, 16);
    // penetration panel and waveguide
    ctx.fillStyle = T.ink2; ctx.fillRect(x0 + 60, y0, 30, 26);
    ctx.fillStyle = T.surface; ctx.fillRect(x1 - 26, 170, 26, 8);
    ctx.fillStyle = D.alpha('#f5d76e', 0.6); ctx.beginPath(); ctx.moveTo(x1 + 30, 174); ctx.lineTo(x1 - 26, 174); ctx.lineTo(280, 150); ctx.lineTo(280, 200); ctx.closePath(); ctx.fill();
    const lab = (t, x, y, o) => D.label(ctx, t, x, y, Object.assign({ size: 11 }, o || {}));
    lab('mu-metal', x0 + 3, y1 + 18, { color: T.ink2 });
    lab('aluminium', x0 + 70, y1 + 18, { color: T.ink2 });
    lab('door', x1 - 30, y1 - 100, { align: 'right', color: T.muted });
    lab('filtered connectors', x0 + 75, y0 - 10, { align: 'center', color: T.muted });
    lab('light through a waveguide', x1 + 8, 196, { color: T.muted });
    lab('inside: tens of nT, nearly still', 230, 236, { align: 'center', color: T.ink2, weight: 600 });
    ctx.restore();
  }
  // Amplitude spectra of the environment and the mains at the top magnetometer, without and with the room.
  function roomSpectra() {
    const ds = S.ds, fs = ds.fs;
    const ch = MEG.getArray('mag').channels[0];
    const open = new Float64Array(ds.n), room = new Float64Array(ds.n);
    ds.gens.forEach(g => {
      if (g.group !== 'environment' && g.group !== 'line') return;
      const k = MEG.forwardMag([ch], g.pos, g.ori)[0];
      for (let i = 0; i < ds.n; i++) { open[i] += k * g.tcOpen[i]; room[i] += k * g.tcRoom[i]; }
    });
    const N = Math.min(MEG.nextPow2(fs * 32), 1 << Math.floor(Math.log2(ds.n)));
    const a = MEG.dsp.welch(open, fs, [[0, ds.n]], N), b = MEG.dsp.welch(room, fs, [[0, ds.n]], N);
    return { f: a.f, open: a.p.map(Math.sqrt), room: b.p.map(Math.sqrt), rmsOpen: MEG.rms(open), rmsRoom: MEG.rms(room) };
  }
  function drawRoomSF() {
    const T = D.theme();
    if (!$('cvRoomASD')) $('cvRoomSF').insertAdjacentHTML('afterend', '<canvas id="cvRoomASD" style="margin-top:8px"></canvas>');
    const fs = [], sf = [];
    for (let e = -2; e <= 3; e += 0.02) { const f = Math.pow(10, e); fs.push(f); sf.push(20 * Math.log10(MEG.shieldingFactor(f))); }
    if (!st.plots.sf) st.plots.sf = new D.Plot($('cvRoomSF'), { height: 170 });
    const mains = S.cfg ? S.cfg.recording.mains : 60;
    st.plots.sf.draw({ x: fs, xLog: true, yRange: [40, 110], xLabel: 'frequency (Hz)', yLabel: 'shielding (dB)', series: [{ y: sf, color: T.series[0], label: 'shielding factor' }], vlines: [{ x: mains, label: 'mains', color: T.muted, dash: [3, 3] }], tipFmt: v => `${v.toFixed(0)} dB (×${Math.round(Math.pow(10, v / 20)).toLocaleString()})`, tipX: x => x.toFixed(x < 1 ? 2 : 1) + ' Hz' });
    if (!S.ds) { D.message($('cvRoomASD'), 'Waiting for the recording.', 200); return; }
    const sp = st.roomSp && st.roomSp.ds === S.ds ? st.roomSp : (st.roomSp = Object.assign(roomSpectra(), { ds: S.ds }));
    if (!st.plots.asd) st.plots.asd = new D.Plot($('cvRoomASD'), { height: 230 });
    const floor = sp.f.map(() => 3);
    st.plots.asd.draw({
      x: sp.f, xLog: true, yLog: true, xRange: [0.03, Math.min(500, S.ds.fs / 2)], xLabel: 'frequency (Hz)', yLabel: 'field (fT/√Hz)',
      series: [{ y: sp.open, color: T.series[7], label: 'outside the room', width: 1.2 }, { y: sp.room, color: T.series[0], label: 'inside', width: 1.4 }, { y: floor, color: T.muted, label: 'SQUID noise floor', dash: [5, 4], width: 1.2 }],
      tipFmt: v => MEG.fmt(v, v < 10 ? 1 : 0) + ' fT/√Hz', tipX: x => x.toFixed(x < 1 ? 2 : 1) + ' Hz'
    });
    ui.legend($('roomLegend'), [{ color: T.series[0], label: 'shielding factor (top)' }, { color: T.series[7], label: 'environment and mains outside' }, { color: T.series[0], label: 'the same inside' }, { color: T.muted, label: 'SQUID noise, 3 fT/√Hz', dash: true }]);
    ui.readouts($('roomReadouts'), [
      ['At 0.1 Hz', `×${Math.round(MEG.shieldingFactor(0.1))}`],
      ['At 1 Hz', `×${Math.round(MEG.shieldingFactor(1))}`],
      [`At ${mains} Hz`, `×${Math.round(MEG.shieldingFactor(mains)).toLocaleString()}`],
      ['Environment, outside', MEG.fmtB(sp.rmsOpen), 'RMS at the top magnetometer, this recording'],
      ['Environment, inside', MEG.fmtB(sp.rmsRoom)],
      ['Static field inside', MEG.fmtB(v3.norm(MEG.RESIDUAL.uniform)), 'what is left of the Earth’s field after degaussing']
    ]);
  }

  /* ===================== 6. head position and digitizer ===================== */
  function drawHPI() {
    const T = D.theme(), cv = $('cvHPI');
    const { ctx, w, h } = D.fit(cv, w => Math.min(300, w * 0.52));
    const size = Math.min(w / 2, h);
    const digi = st.digi || (st.digi = MEG.mri.digitize(3));
    const coils = [MEG.sph(62, -42), MEG.sph(62, 42), MEG.sph(104, -112), MEG.sph(104, 112)].map(u => v3.scale(u, MEG.scalpR(u) + 0.1));
    ['top', 'side'].forEach((view, k) => {
      const hv = D.head(ctx, k * w / 2 + (w / 2 - size) / 2, 0, size, view, { labels: true, ext: 11.6 });
      const vis = p => view === 'top' ? p[2] > -1 : p[0] < 1;
      digi.pts.forEach(p => { if (!vis(p)) return; const [x, y] = hv.proj(p); ctx.fillStyle = D.alpha(T.series[0], 0.75); ctx.beginPath(); ctx.arc(x, y, 1.7, 0, 2 * Math.PI); ctx.fill(); });
      coils.forEach((p, i) => { if (!vis(p)) return; const [x, y] = hv.proj(p); ctx.fillStyle = T.card; ctx.strokeStyle = T.series[2]; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); D.label(ctx, 'HPI ' + (i + 1), x + 6, y - 7, { size: 9, color: T.series[2] }); });
      ['NAS', 'LPA', 'RPA'].forEach(f => {
        const p = MEG.mri.FID[f]; if (view === 'side' && f === 'RPA') return;
        const [x, y] = hv.proj(p);
        ctx.fillStyle = T.series[1]; ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 5, y + 4); ctx.lineTo(x + 5, y + 4); ctx.closePath(); ctx.fill();
        const left = (view === 'top' && f === 'LPA') || (view === 'side' && f === 'NAS');
        D.label(ctx, f === 'NAS' ? 'nasion' : f, x + (left ? -8 : 7), y + (view === 'top' && f === 'NAS' ? -10 : 8), { size: 9, color: T.series[1], align: left ? 'right' : 'left', weight: 600 });
      });
      // head frame axes
      const o = hv.proj([0, 0, 0]);
      const ax = view === 'top' ? [[[4, 0, 0], 'x'], [[0, 4, 0], 'y']] : [[[0, 4, 0], 'y'], [[0, 0, 4], 'z']];
      ax.forEach(([p, nm]) => { const e = hv.proj(p); D.arrow(ctx, o[0], o[1], e[0], e[1], T.ink2, 1.4, 6); D.label(ctx, nm, e[0] + 4, e[1] - 4, { size: 10, weight: 600 }); });
    });
  }
  function drawHeadPos() {
    const T = D.theme(), ds = S.ds;
    if (!ds) { D.message($('cvHeadPos'), 'Waiting for the recording.', 200); return; }
    const P = ds.pose, on = S.enabled.has('movement');
    const xs = [], tr = [[], [], []], tot = [];
    for (let k = 0; k < P.K - 1; k++) {
      xs.push(k / P.fs);
      const a = [0, 1, 2].map(d => (on ? P.tr[d][k] : 0) * 10);
      a.forEach((v, d) => tr[d].push(v));
      tot.push(Math.hypot(a[0], a[1], a[2]));
    }
    if (!st.plots.pos) st.plots.pos = new D.Plot($('cvHeadPos'), { height: 220 });
    st.plots.pos.draw({
      x: xs, xLabel: 'time (s)', yLabel: 'displacement (mm)', yRange: on ? undefined : [-2, 2],
      series: [{ y: tr[0], color: T.series[0], label: 'left-right (x)', width: 1.4 }, { y: tr[1], color: T.series[1], label: 'back-front (y)', width: 1.4 }, { y: tr[2], color: T.series[2], label: 'down-up (z)', width: 1.4 }, { y: tot, color: T.ink2, label: 'distance', width: 1, dash: [4, 3] }],
      after: (ctx, m) => { if (!on) D.label(ctx, 'Head movement is switched off: the head is still.', (m.X0 + m.X1) / 2, (m.Y0 + m.Y1) / 2 - 16, { align: 'center', color: T.muted }); },
      tipFmt: v => v.toFixed(1) + ' mm', tipX: x => ui.fmtT(x)
    });
    ui.legend($('headPosLegend'), [{ color: T.series[0], label: 'x, toward the right ear' }, { color: T.series[1], label: 'y, toward the nose' }, { color: T.series[2], label: 'z, up' }, { color: T.ink2, label: 'total', dash: true }]);
    const mx = Math.max(0, ...tot);
    ui.readouts($('hpiReadouts'), [
      ['Largest displacement', mx.toFixed(1) + ' mm'],
      ['At the end', tot[tot.length - 1].toFixed(1) + ' mm'],
      ['HPI coils', S.cfg.recording.hpi ? `on, at ${ds.hpiFreqs.join(', ')} Hz` : 'not driven in this recording', 'switch them on with hpi on in the recording block'],
      ['Head-shape points', String(st.digi ? st.digi.pts.length : 0)]
    ]);
  }

  /* ===================== OPMs ===================== */
  function drawOPM() {
    const T = D.theme(), cv = $('cvOPM');
    const { ctx, w, h } = D.fit(cv, w => Math.min(380, w * 0.82));
    const s = Math.min(w / 480, h / 380), ox = (w - 480 * s) / 2;
    ctx.save(); ctx.translate(ox, 0); ctx.scale(s, s);
    const lab = (t, x, y, o) => D.label(ctx, t, x, y, Object.assign({ size: 11 }, o || {}));
    // the optical path
    ctx.fillStyle = T.ink2; ctx.fillRect(20, 70, 50, 30); lab('laser 795 nm', 45, 112, { align: 'center' });
    ctx.fillStyle = D.alpha('#e34948', 0.35); ctx.fillRect(70, 80, 340, 10);
    ctx.fillStyle = T.metal; ctx.fillRect(110, 66, 8, 38); lab('λ/4: circular', 114, 52, { align: 'center', color: T.muted });
    // the cell with its coils and heater
    ctx.strokeStyle = T.coil; ctx.lineWidth = 1.4;
    for (let k = 0; k < 5; k++) { ctx.beginPath(); ctx.ellipse(220, 85, 58 + k * 2, 44 + k * 2, 0, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.fillStyle = D.alpha(T.helium, 0.95); ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.5; ctx.fillRect(180, 55, 80, 60); ctx.strokeRect(180, 55, 80, 60);
    const rnd = MEG.rng(9);
    for (let i = 0; i < 18; i++) { const x = 188 + rnd.next() * 64, y = 62 + rnd.next() * 46; D.arrow(ctx, x - 5, y, x + 5, y, T.squid, 1.2, 4); }
    lab('rubidium vapour, heated', 220, 136, { align: 'center', weight: 600 });
    lab('coils: null and modulate the field', 220, 152, { align: 'center', color: T.coil });
    ctx.fillStyle = T.ink2; ctx.fillRect(410, 70, 20, 30); lab('photodiode', 420, 112, { align: 'center' });
    // the field being measured
    D.arrow(ctx, 220, 30, 220, 50, T.series[6], 2, 7); lab('B from the brain', 228, 28, { color: T.series[6] });
    // resonance curve
    const X0 = 60, X1 = 440, Y0 = 200, Y1 = 350, sx = b => X0 + (b + 6) / 12 * (X1 - X0), sy = v => Y1 - v * (Y1 - Y0);
    ctx.strokeStyle = T.axis; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X0, Y1); ctx.lineTo(X1, Y1); ctx.moveTo(sx(0), Y0 - 6); ctx.lineTo(sx(0), Y1); ctx.stroke();
    ctx.fillStyle = D.alpha(T.series[2], 0.18); ctx.fillRect(sx(-1.5), Y0, sx(1.5) - sx(-1.5), Y1 - Y0);
    ctx.strokeStyle = T.series[0]; ctx.lineWidth = 2; ctx.beginPath();
    for (let b = -6; b <= 6; b += 0.05) { const v = 0.15 + 0.8 / (1 + (b / 1.2) * (b / 1.2)); b === -6 ? ctx.moveTo(sx(b), sy(v)) : ctx.lineTo(sx(b), sy(v)); }
    ctx.stroke();
    ctx.fillStyle = T.muted; ctx.font = D.font(10); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    [-6, -4, -2, 0, 2, 4, 6].forEach(b => ctx.fillText(String(b), sx(b), Y1 + 3));
    lab('field at the cell (nT)', (X0 + X1) / 2, Y1 + 24, { align: 'center', color: T.ink2 });
    lab('light through the cell', X0 - 4, Y0 - 12, { color: T.ink2 });
    lab('usable range: about ±1.5 nT', sx(0), Y0 + 12, { align: 'center', color: T.series[2], weight: 600 });
    ctx.restore();
    // maps: the same source with SQUIDs and OPMs
    const pos = MEG.placeAt('C3', 2.5), q = v3.scale(MEG.orientation(pos, 90, 0), 20);
    const vs = megMag([{ pos, q }], 'mag'), vo = megMag([{ pos, q }], 'opm');
    const ps = peakAbs(vs), po = peakAbs(vo), rng = Math.max(ps, po);
    D.topoCanvas($('cvOPMsq'), D.sites(), vs, { unit: 'fT', maxH: 200, title: 'SQUID magnetometers', range: rng, fmt: v => MEG.fmt(v, 0) });
    D.topoCanvas($('cvOPMop'), D.sites(), vo, { unit: 'fT', maxH: 200, title: 'OPMs on the scalp', range: rng, fmt: v => MEG.fmt(v, 0) });
    const nS = MEG.ARRAY.noise.mag, nO = MEG.ARRAY.noise.opm;
    ui.readouts($('opmReadouts'), [
      ['Peak, SQUIDs', MEG.fmtB(ps)], ['Peak, OPMs', MEG.fmtB(po)],
      ['Signal ratio', MEG.fmt(po / ps, 1) + '×', '20 nAm tangential dipole 2.5 cm under C3; same colour scale'],
      ['Noise ratio', MEG.fmt(nO / nS, 1) + '×', `${nO} vs ${nS} fT/√Hz`],
      ['Signal to noise, OPM vs SQUID', MEG.fmt(po / ps / (nO / nS), 2) + '×']
    ]);
  }

  /* ===================== tab plumbing ===================== */
  function drawStage() {
    $('instStages').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stage === st.stage)));
    ['neurons', 'head', 'coils', 'dewar', 'room', 'hpi', 'opm'].forEach(k => { $('stage-' + k).hidden = k !== st.stage; });
    if (st.stage === 'neurons') { neuronNumbers(); drawNeurons(performance.now() / 1000); startAnim(); }
    else if (st.stage === 'head') drawHeadStage();
    else if (st.stage === 'coils') { coilNumbers(); drawCoil(); drawFalloff(); drawSquid(); drawFLL(); }
    else if (st.stage === 'dewar') drawDewarGap();
    else if (st.stage === 'room') { drawRoom(); drawRoomSF(); }
    else if (st.stage === 'hpi') { drawHPI(); drawHeadPos(); MEG.mri.load(); }
    else if (st.stage === 'opm') drawOPM();
  }
  function animate(ts) {
    st.anim = null;
    if (S.tab !== 'instrument' || st.stage !== 'neurons' || document.hidden) return;
    drawNeurons(ts / 1000);
    if (!reduced) st.anim = requestAnimationFrame(animate);
  }
  function startAnim() { if (!st.anim && !reduced) st.anim = requestAnimationFrame(animate); }
  function selectStage(k, scroll) {
    st.stage = k;
    drawSystem(); drawStage();
    if (scroll) { const el = $('stage-' + k); const r = el.getBoundingClientRect(); if (r.top > window.innerHeight * 0.8 || r.top < 0) el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' }); }
  }
  function render() { drawSystem(); drawStage(); }
  // The template's head shape replaces the synthetic one when it arrives.
  MEG.mri.onChange(() => { st.digi = null; if (S.tab === 'instrument' && st.stage === 'hpi') drawHPI(); });

  MEG.tabs.instrument = {
    needsData: false,
    init() {
      ui.seg($('sysSeg'), v => { st.sys = v; if (v === 'opm') selectStage('opm'); else if (st.stage === 'opm') selectStage('coils'); else drawSystem(); });
      $('instStages').addEventListener('click', e => { const b = e.target.closest('button'); if (b) selectStage(b.dataset.stage); });
      const cv = $('cvSystem');
      const scenePt = e => { const r = cv.getBoundingClientRect(), sc = st.scene; return sc ? [(e.clientX - r.left - sc.ox) / sc.s, (e.clientY - r.top - sc.oy) / sc.s] : [0, 0]; };
      cv.addEventListener('mousemove', e => {
        const [x, y] = scenePt(e), hit = hitTest(x, y);
        cv.style.cursor = hit ? 'pointer' : 'default';
        if (hit !== st.hover) { st.hover = hit; drawSystem(); }
      });
      cv.addEventListener('mouseleave', () => { if (st.hover) { st.hover = null; drawSystem(); } });
      cv.addEventListener('click', e => { const [x, y] = scenePt(e), hit = hitTest(x, y); if (hit) { if (hit === 'opm' && st.sys !== 'opm') return; selectStage(hit, true); } });
      ['nrnPatch', 'nrnArea', 'nrnSync'].forEach(id => $(id).addEventListener('input', () => { neuronNumbers(); if (reduced) drawNeurons(0); }));
      ['hdRatio', 'hdTilt'].forEach(id => $(id).addEventListener('input', ui.debounce(drawHeadStage, 60)));
      ui.seg($('coilSeg'), v => { st.coil = v; coilNumbers(); drawCoil(); });
      ['coilDepth', 'coilFar'].forEach(id => $(id).addEventListener('input', () => { coilNumbers(); drawCoil(); drawFalloff(); }));
      ['fllStep', 'fllSlew'].forEach(id => $(id).addEventListener('input', drawFLL));
      ['dwGap', 'dwDepth'].forEach(id => $(id).addEventListener('input', ui.debounce(drawDewarGap, 40)));
      document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tab === 'instrument' && st.stage === 'neurons') startAnim(); });
    },
    onBuild() { st.roomSp = null; },
    render
  };
})(typeof window !== 'undefined' ? window : globalThis);
