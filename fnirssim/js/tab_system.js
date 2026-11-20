/* fNIRS simulator: the System tab.  A schematic of a continuous-wave
   instrument that names its parts, and one panel per part: the sources'
   spectra, the optodes and hair, the tissue, the detectors' dynamic range,
   multiplexing (animated), and the three ways of measuring (CW, FD, TD). */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, D = NIRS.draw, ui = NIRS.ui, S = NIRS.S, $ = ui.$;
  const st = { stage: 'sources', part: 'sources', anim: null, t: 0, muxPlay: true, src: 'laser', hair: 'none', head: 'adult', det: 'apd', mux: 'time' };
  let ctl = {};

  const PARTS = {
    sources: { title: 'Light sources', html: `<p>Two (sometimes three or more) <strong>wavelengths</strong> in the near-infrared window, typically 760 and 850 nm, one on
      each side of the isosbestic point. Each source position on the head has both colours, either two laser diodes coupled into one fibre or a dual-wavelength
      LED on the scalp. A driver switches or modulates them so the detectors can tell them apart (multiplexing), and holds their power steady: a 0.1% drift in
      source power is a 0.1% change in every channel it feeds.</p>` },
    fibres: { title: 'Fibres', html: `<p>Optical fibres carry light from the sources to the head and back to the detectors. Large fibre-optic systems keep the lasers
      and detectors in a box; wearable systems skip the fibres and put LEDs and photodiodes straight on the scalp, which saves light and weight and allows
      movement. Fibre bundles a few millimetres across collect more light than a single fibre.</p>` },
    cap: { title: 'Cap and optodes', html: `<p>A stretchy <strong>cap</strong> holds the optodes in a fixed layout, registered to the 10-20 system so the same cortex is
      covered on every head. Each <strong>optode</strong> sits in a holder that presses it against the scalp. A <strong>channel</strong> is a source and a
      detector about 3 cm apart. <strong>Short-separation</strong> detectors, 8 mm from a source, see almost only the scalp and are used to remove it.
      Getting light through hair is the hardest practical part of fNIRS.</p>` },
    tissue: { title: 'The head', html: `<p>Between the optodes and the cortex are 5 mm of scalp, 7 mm of skull and 2 mm of cerebrospinal fluid in an adult, less than
      half of that in an infant. Light scatters through all of it and only the deep end of its path reaches the gray matter, which is why a channel's signal is
      always partly scalp.</p>` },
    detectors: { title: 'Detectors', html: `<p>Silicon <strong>photodiodes</strong>, <strong>avalanche photodiodes</strong> (APDs) or <strong>silicon photomultipliers</strong>
      (SiPMs) turn the returning light, picowatts to microwatts, into a current. Their noise floor sets how far apart a channel can be; their saturation sets
      how close.</p>` },
    electronics: { title: 'Amplifier, demultiplexer and ADC', html: `<p>A transimpedance amplifier turns photocurrent into voltage, with gain switched to suit the
      light level. The <strong>demultiplexer</strong> assigns each part of the signal to the source and wavelength that produced it, by timing (time multiplexing)
      or by a lock-in amplifier tuned to each source's modulation frequency (frequency multiplexing), and rejects room light in the process. An analogue-to-digital
      converter samples the result, usually 5 to 50 times a second.</p>` },
    computer: { title: 'The data', html: `<p>What comes out is one number per channel, per wavelength, per sample: the detected intensity. Everything else, optical density,
      haemoglobin, statistics, is computed from it. Continuous-wave intensity is relative: the absolute value depends on coupling and gain, so only changes are
      interpreted.</p>` }
  };

  /* ---------- the schematic ---------- */
  let hot = [];
  function drawSystem() {
    const cv = $('cvSystem');
    const { ctx, w, h } = D.fit(cv, w => Math.max(300, Math.min(400, w * 0.55)));
    const T = D.theme();
    hot = [];
    const box = (x, y, bw, bh, key, label, sub) => {
      const on = st.part === key;
      ctx.fillStyle = on ? D.alpha(T.accent, T.dark ? 0.22 : 0.12) : T.card; ctx.strokeStyle = on ? T.accent : T.border; ctx.lineWidth = on ? 2 : 1;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, 8); else ctx.rect(x, y, bw, bh); ctx.fill(); ctx.stroke();
      ctx.fillStyle = T.ink; ctx.font = D.font(11, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, x + bw / 2, y + 6);
      if (sub) { ctx.fillStyle = T.muted; ctx.font = D.font(9.5); ctx.fillText(sub, x + bw / 2, y + 21); }
      hot.push({ x, y, w: bw, h: bh, key });
    };
    const sc = w / 760;
    const X = v => v * sc, Y = v => v * (h / 400);
    // sources box
    box(X(14), Y(40), X(150), Y(150), 'sources', 'Light sources', 'driver and modulator');
    const lamC = [T.lam[0], T.lam[1]];
    const phase = (st.t * 1.2) % 4;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const x = X(34 + j * 64), y = Y(78 + i * 50), k = i * 2 + j;
      const on = Math.floor(phase) === k;
      ctx.fillStyle = on ? lamC[j] : D.alpha(lamC[j], 0.35); ctx.strokeStyle = T.surface; ctx.lineWidth = 2;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, X(48), Y(34), 6); else ctx.rect(x, y, X(48), Y(34)); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = D.font(9.5, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`S${i + 1} ${j ? '850' : '760'}`, x + X(24), y + Y(17));
    }
    // head and cap
    const hx = X(380), hy = Y(250), hr = Math.min(X(110), Y(120));
    hot.push({ x: hx - hr, y: hy - hr, w: 2 * hr, h: hr * 0.9, key: 'cap' });
    ctx.fillStyle = T.layers.scalp; ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(hx, hy, hr, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.layers.skull; ctx.beginPath(); ctx.arc(hx, hy, hr * 0.9, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = T.layers.gray; ctx.beginPath(); ctx.arc(hx, hy, hr * 0.8, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = T.layers.white; ctx.beginPath(); ctx.arc(hx, hy, hr * 0.68, 0, 2 * Math.PI); ctx.fill();
    // nose
    ctx.strokeStyle = T.ink2; ctx.beginPath(); ctx.moveTo(hx + hr * 0.97, hy - hr * 0.1); ctx.lineTo(hx + hr * 1.12, hy + hr * 0.08); ctx.lineTo(hx + hr * 0.98, hy + hr * 0.2); ctx.stroke();
    // cap arc
    const capOn = st.part === 'cap';
    ctx.strokeStyle = capOn ? T.accent : T.ink2; ctx.lineWidth = capOn ? 5 : 4;
    ctx.beginPath(); ctx.arc(hx, hy, hr * 1.04, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    const ang = [1.3, 1.42, 1.55, 1.68], kinds = ['S', 'D', 'S', 'D'];
    const optPos = ang.map(a => [hx + hr * 1.05 * Math.cos(a * Math.PI), hy + hr * 1.05 * Math.sin(a * Math.PI)]);
    // tissue inset with banana
    const ix = X(560), iy = Y(178), iw = X(186), ih = Y(130);
    hot.push({ x: ix, y: iy, w: iw, h: ih, key: 'tissue' });
    const layers = NIRS.headLayers('adult');
    D.crossSection(ctx, { x: ix, y: iy, w: iw, h: ih }, layers, [-1, 4], 2.4, { labels: true, depthAxis: false, labelSide: 'right' });
    ctx.strokeStyle = st.part === 'tissue' ? T.accent : T.border; ctx.lineWidth = st.part === 'tissue' ? 2 : 1; ctx.strokeRect(ix, iy, iw, ih);
    // banana outline
    const bx = v => ix + (v + 1) / 5 * iw, bz = v => iy + v / 2.4 * ih;
    ctx.fillStyle = D.alpha(T.photon, 0.45); ctx.beginPath();
    for (let k = 0; k <= 30; k++) { const x = k / 30 * 3; ctx.lineTo(bx(x), bz(Math.sin(Math.PI * x / 3) * 1.25 + 0.05)); }
    for (let k = 30; k >= 0; k--) { const x = k / 30 * 3; ctx.lineTo(bx(x), bz(Math.sin(Math.PI * x / 3) * 0.45)); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = T.ink2; ctx.font = D.font(9.5); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('a 3 cm channel, magnified', ix, iy - 3);
    // connector from the head to the inset
    ctx.strokeStyle = T.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(optPos[2][0], optPos[2][1]); ctx.lineTo(ix, iy); ctx.stroke(); ctx.setLineDash([]);
    // fibres: sources to S optodes, D optodes to detectors
    const detX = X(560), detY = Y(40);
    const fib = (x0, y0, x1, y1, col, pulse) => {
      ctx.strokeStyle = st.part === 'fibres' ? T.accent : col; ctx.lineWidth = 2;
      const cx1 = (x0 + x1) / 2, cy1 = Math.min(y0, y1) - Y(30);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx1, cy1, x1, y1); ctx.stroke();
      if (pulse !== null) {
        const t = pulse, qx = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx1 + t * t * x1, qy = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy1 + t * t * y1;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(qx, qy, 4, 0, 2 * Math.PI); ctx.fill();
      }
      hot.push({ x: Math.min(x0, x1), y: cy1 - 4, w: Math.abs(x1 - x0), h: 14, key: 'fibres' });
    };
    const active = Math.floor(phase), frac = phase - active;
    fib(X(164), Y(95), optPos[0][0], optPos[0][1], active < 2 ? lamC[active % 2] : T.axis, active < 2 ? frac : null);
    fib(X(164), Y(145), optPos[2][0], optPos[2][1], active >= 2 ? lamC[active % 2] : T.axis, active >= 2 ? frac : null);
    fib(optPos[1][0], optPos[1][1], detX, Y(80), T.det, (frac + 0.5) % 1);
    fib(optPos[3][0], optPos[3][1], detX, Y(110), T.det, (frac + 0.2) % 1);
    optPos.forEach(([x, y], i) => {
      if (kinds[i] === 'S') { ctx.fillStyle = T.src; ctx.fillRect(x - 6, y - 6, 12, 12); }
      else { ctx.fillStyle = T.det; ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fill(); }
    });
    // detectors, electronics, computer
    box(detX, detY, X(90), Y(110), 'detectors', 'Detectors', 'APD x 2');
    box(detX + X(100), detY, X(86), Y(110), 'electronics', 'Amplify', 'demux, ADC');
    ctx.strokeStyle = T.axis; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(detX + X(90), detY + Y(55)); ctx.lineTo(detX + X(100), detY + Y(55)); ctx.stroke();
    box(X(14), Y(250), X(200), Y(120), 'computer', 'The data', 'intensity, channel x wavelength');
    // a little trace inside the computer box
    ctx.strokeStyle = T.trace; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let k = 0; k <= 80; k++) {
      const tt = k / 80, x = X(28) + tt * X(172), y = Y(330) - Y(10) * Math.sin(2 * Math.PI * (tt * 6 + st.t * 1.2)) * 0.6 - Y(18) * Math.exp(-Math.pow((tt - 0.55) / 0.12, 2));
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = T.axis; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(detX + X(143), detY + Y(110)); ctx.lineTo(detX + X(143), Y(225)); ctx.lineTo(X(214), Y(300)); ctx.stroke(); ctx.setLineDash([]);
  }
  function partInfo() {
    const p = PARTS[st.part];
    $('sysInfo').innerHTML = `<h3>${p.title}</h3>${p.html}`;
  }

  /* ---------- 1. sources ---------- */
  function drawSources() {
    const T = D.theme();
    const l1 = ctl.l1.get(), l2 = ctl.l2.get(), fwhm = st.src === 'led' ? ctl.fwhm.get() : NIRS.LASER_FWHM;
    const nm = [], eo = [], er = [];
    for (let x = 650; x <= 950; x += 2) { nm.push(x); const e = NIRS.ext(x); eo.push(e[0]); er.push(e[1]); }
    const emis = l => nm.map(x => Math.exp(-0.5 * Math.pow((x - l) / (fwhm / 2.3548), 2)) * 3500);
    if (!st.pSrc) st.pSrc = new D.Plot($('cvSrcSpec'), { height: 260 });
    st.pSrc.draw({
      x: Float64Array.from(nm), xLabel: 'wavelength (nm)', yLabel: 'extinction (1/cm/M)', yRange: [0, 4000],
      series: [
        { y: emis(l1), fill: D.alpha(T.lam[0], 0.15), y2: new Float64Array(nm.length) },
        { y: emis(l2), fill: D.alpha(T.lam[1], 0.15), y2: new Float64Array(nm.length) },
        { y: emis(l1), color: T.lam[0], width: 1.2, label: `source ${l1} nm (relative)` },
        { y: emis(l2), color: T.lam[1], width: 1.2, label: `source ${l2} nm (relative)` },
        { y: Float64Array.from(eo), color: T.hbo, label: 'HbO' }, { y: Float64Array.from(er), color: T.hbr, label: 'HbR' }
      ],
      vlines: [{ x: NIRS.ISOSBESTIC, color: T.muted, dash: [3, 3], label: 'isosbestic' }],
      tipX: x => `${x.toFixed(0)} nm`, tipFmt: v => v.toFixed(0)
    });
    ui.legend($('srcSpecLegend'), [{ color: T.hbo, label: 'HbO extinction' }, { color: T.hbr, label: 'HbR extinction' }, { color: T.lam[0], label: `source ${l1} nm` }, { color: T.lam[1], label: `source ${l2} nm` }]);
    const nom = [NIRS.ext(l1), NIRS.ext(l2)], eff = [NIRS.effectiveExt(l1, fwhm), NIRS.effectiveExt(l2, fwhm)];
    const pct = (a, b) => ((a / b - 1) * 100).toFixed(1) + '%';
    // crosstalk: a pure HbO change measured with the effective coefficients, converted with the nominal
    const Ei = NIRS.mbllInverse(NIRS.mbllMatrix([l1, l2], 3, 6, nom));
    const E = NIRS.mbllMatrix([l1, l2], 3, 6, eff);
    let xt = NaN, xg = NaN;
    if (Ei) { const od = [E[0][0], E[1][0]]; const ro = Ei[0][0] * od[0] + Ei[0][1] * od[1], rr = Ei[1][0] * od[0] + Ei[1][1] * od[1]; xt = rr / ro; xg = ro; }
    ui.readouts($('srcReadouts'), [
      [`HbR coefficient at ${l1} nm, effective vs nominal`, pct(eff[0][1], nom[0][1])],
      [`HbO coefficient at ${l2} nm, effective vs nominal`, pct(eff[1][0], nom[1][0])],
      ['A pure HbO rise read as HbO', isFinite(xg) ? (xg * 100).toFixed(1) + '%' : '–'],
      ['…and appearing as HbR', isFinite(xt) ? (xt * 100).toFixed(1) + '% of it' : '–']
    ]);
  }

  /* ---------- 2. cap and coupling ---------- */
  function drawCap() {
    const T = D.theme();
    const g = D.fit($('cvCap'), w => Math.min(320, w));
    const r = Math.min(g.w, g.h) / 2 * 0.8;
    const cfg = S.cfg;
    D.headTop(g.ctx, g.w / 2, g.h / 2 + r * 0.05, r, cfg, S.ds ? S.ds.geo : null, { regions: NIRS.app.regionMarks() });
    // coupling picture: an optode tip over scalp with hair
    const c = D.fit($('cvCoupling'), 170);
    const ctx = c.ctx, w = c.w, h = c.h;
    const hair = NIRS.HAIR[st.hair];
    ctx.fillStyle = T.layers.scalp; ctx.fillRect(0, h * 0.62, w, h * 0.38);
    ctx.fillStyle = T.layers.skull; ctx.fillRect(0, h * 0.86, w, h * 0.14);
    const rr = NIRS.rng(11);
    const nHair = { none: 0, light: 40, dense: 140, dark: 160 }[st.hair];
    const hairCol = st.hair === 'dark' ? (T.dark ? '#d9d4c7' : '#2b2420') : (T.dark ? '#b89a6a' : '#8a6a3a');
    ctx.strokeStyle = hairCol; ctx.lineWidth = 1.3;
    for (let i = 0; i < nHair; i++) {
      const x = rr.next() * w, len = 20 + 40 * rr.next(), a = -Math.PI / 2 + (rr.next() - 0.5) * 1.6;
      ctx.beginPath(); ctx.moveTo(x, h * 0.62); ctx.quadraticCurveTo(x + Math.cos(a) * len * 0.6, h * 0.62 + Math.sin(a) * len * 0.5, x + Math.cos(a) * len, h * 0.62 + Math.sin(a) * len * 0.9); ctx.stroke();
    }
    [[w * 0.28, 'S', T.src], [w * 0.72, 'D', T.det]].forEach(([x, lab, col]) => {
      const tipY = h * 0.62 - (st.hair === 'none' ? 0 : st.hair === 'light' ? 3 : 7);
      ctx.fillStyle = T.card; ctx.strokeStyle = T.ink2; ctx.lineWidth = 1.2;
      ctx.fillRect(x - 14, 6, 28, tipY - 6); ctx.strokeRect(x - 14, 6, 28, tipY - 6);
      ctx.fillStyle = col; ctx.fillRect(x - 8, tipY - 10, 16, 10);
      ctx.fillStyle = T.ink; ctx.font = D.font(11, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(lab, x, 22);
    });
    ctx.fillStyle = D.alpha(T.photon, 0.35);
    ctx.beginPath(); ctx.moveTo(w * 0.28 - 8, h * 0.62); ctx.quadraticCurveTo(w * 0.5, h * 1.25, w * 0.72 + 8, h * 0.62); ctx.quadraticCurveTo(w * 0.5, h * 0.95, w * 0.28 - 8, h * 0.62); ctx.fill();
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(hair.label, 6, h * 0.66);
    // light through two optodes (source and detector), relative to bare skin
    const tr = nm => Math.pow(hair.couple * Math.exp(-hair.melanin * NIRS.melanin(nm)), 2) / Math.pow(NIRS.HAIR.none.couple, 2);
    const k = Math.exp(1.645 * Math.SQRT2 * hair.spread), pc = v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + '%';
    ui.readouts($('capReadouts'), [
      ['Light through, 760 nm', pc(tr(760))], ['Light through, 850 nm', pc(tr(850))],
      ['Most channels lie between', `${pc(tr(850) / k)} and ${pc(Math.min(1.2, tr(850) * k))}`]
    ]);
  }

  /* ---------- 3. tissue ---------- */
  function drawTissue() {
    const T = D.theme();
    const nm = +$('sysTissueNm').value;
    const layers = NIRS.headLayers(st.head);
    const g = D.fit($('cvSysTissue'), 260);
    const rect = { x: 40, y: 22, w: g.w - 50, h: g.h - 30 };
    const map = D.crossSection(g.ctx, rect, layers, [-1, 4], 3, { labels: true });
    const sol = NIRS.fluence(NIRS.opticalLayers(layers, nm));
    const f = NIRS.sensitivityPlane(sol, 3, -1 - 1.5, 4 - 1.5, 200, 3, 60);
    D.fieldImage(g.ctx, rect, f.data, f.nx, f.nz, T.photon, { decades: 3, maxAlpha: 200 });
    D.optodeMarks(g.ctx, map, 0, 3, {});
    const ol = NIRS.opticalLayers(layers, nm);
    $('tissueTable').innerHTML = '<tr><th>Layer</th><th>Thickness</th><th>HbO</th><th>HbR</th><th>Water</th><th>&mu;a (1/cm)</th><th>&mu;s&prime; (1/cm)</th></tr>' +
      layers.map((L, i) => `<tr><td><span class="swatch" style="background:${T.layers[L.key]}"></span>${L.label}</td><td>${isFinite(L.d) ? (L.d * 10).toFixed(1) + ' mm' : 'the rest'}</td>
        <td>${L.tissue.hbo} µM</td><td>${L.tissue.hbr} µM</td><td>${Math.round(L.tissue.water * 100)}%</td><td>${ol[i].mua.toFixed(3)}</td><td>${ol[i].musp.toFixed(1)}</td></tr>`).join('');
  }

  /* ---------- 4. detectors ---------- */
  function drawDetectors() {
    const T = D.theme();
    const P = Math.pow(10, ctl.power.get()), rho0 = ctl.rho.get();
    const sol = NIRS.fluence(NIRS.opticalLayers(NIRS.headLayers('adult'), 850));
    const xs = [], ys = [];
    for (let r = 0.5; r <= 5.5 + 1e-9; r += 0.05) { xs.push(r); ys.push(P * 1e6 * NIRS.reflectance(sol, r) * NIRS.DETECTOR_AREA * Math.pow(NIRS.HAIR.none.couple, 2)); }
    const bands = [];
    const keys = ['photodiode', 'apd', 'sipm'];
    const usable = k => {
      const d = NIRS.DETECTORS[k];
      // SNR 100 at 10 Hz: solve sqrt(floor^2 + shot*I + (drift I)^2) = I/100 approximately
      let lo = 1e-6; for (let I = 1e-6; I < 1e7; I *= 1.05) { const sd = Math.sqrt(d.floor * d.floor + d.shot * I + (d.drift * I) * (d.drift * I)); if (I / sd >= 100) { lo = I; break; } }
      return [lo, d.sat];
    };
    if (!st.pDyn) st.pDyn = new D.Plot($('cvDynRange'), { height: 280, margin: [12, 14, 36, 58] });
    const sel = NIRS.DETECTORS[st.det], [lo, hi] = usable(st.det);
    const I0 = P * 1e6 * NIRS.reflectance(sol, rho0) * NIRS.DETECTOR_AREA * Math.pow(NIRS.HAIR.none.couple, 2);
    st.pDyn.draw({
      x: Float64Array.from(xs), xLabel: 'source-detector separation (cm)', yLabel: 'detected power', yLog: true, yRange: [1e-4, 1e5],
      yFmt: v => NIRS.fmtPowerTick(v),
      series: [{ y: Float64Array.from(ys), color: T.accent, width: 2.5, label: 'detected' }],
      hlines: [{ y: sel.floor, color: T.crit, dash: [4, 3] }, { y: hi, color: T.serious, dash: [4, 3] }],
      bands: [],
      markers: [{ x: rho0, y: I0, color: T.ink }],
      after: (ctx, m) => {
        const y0 = m.sy(Math.min(hi, 1e5)), y1 = m.sy(Math.max(lo, 1e-4));
        ctx.fillStyle = D.alpha(T.good, 0.1); ctx.fillRect(m.X0, y0, m.X1 - m.X0, y1 - y0);
        ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText('noise floor', m.X1 - 4, m.sy(sel.floor) - 2); ctx.fillText('saturation', m.X1 - 4, m.sy(hi) - 2);
        ctx.textAlign = 'left'; ctx.fillText('usable', m.X0 + 4, (y0 + y1) / 2);
      },
      tipX: x => `${x.toFixed(2)} cm`, tipFmt: v => NIRS.fmtPower(v)
    });
    ui.legend($('dynLegend'), [{ color: T.accent, label: 'detected power' }, { color: T.crit, label: 'noise floor', dash: true }, { color: T.serious, label: 'saturation', dash: true }]);
    const sd = Math.sqrt(sel.floor * sel.floor + sel.shot * I0 + (sel.drift * I0) ** 2);
    ui.readouts($('detReadouts'), [
      ['Source power', (P).toFixed(P < 1 ? 2 : 1) + ' mW'], ['Detected at ' + rho0.toFixed(1) + ' cm', NIRS.fmtPower(I0)],
      ['Signal-to-noise per sample', I0 >= hi ? 'saturated' : (I0 / sd).toFixed(0)], [sel.label, sel.desc]
    ]);
  }

  /* ---------- 5. multiplexing ---------- */
  const EMIT = [{ s: 1, l: 0, g: 1.0 }, { s: 1, l: 1, g: 1.4 }, { s: 2, l: 0, g: 0.55 }, { s: 2, l: 1, g: 0.8 }];
  function muxSignals(mode, ambient, t0) {
    // a 20 ms window; slots of 0.5 ms in time mode; 1.5 to 4.5 kHz in frequency mode
    const n = 800, dt = 20e-3 / n, freqs = [1500, 2250, 3000, 4500];
    const drive = EMIT.map(() => new Float64Array(n)), raw = new Float64Array(n), times = new Float64Array(n);
    const amb = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * dt; times[i] = (i * dt) * 1e3;
      EMIT.forEach((e, k) => {
        let v;
        if (mode === 'time') { const slot = Math.floor(t / 0.5e-3) % 5; v = slot === k ? 1 : 0; }
        else if (mode === 'frequency') v = 0.5 + 0.5 * Math.sin(2 * Math.PI * freqs[k] * t);
        else v = 1;
        drive[k][i] = v;
        raw[i] += e.g * v;
      });
      amb[i] = ambient ? 0.9 * (1 + 0.3 * Math.sin(2 * Math.PI * 120 * t)) : 0;
      raw[i] += amb[i] + 0.03 * Math.sin(2 * Math.PI * 9000 * t + 1.3) * Math.sin(2 * Math.PI * 170 * t);
    }
    // demultiplex the window
    const rec = EMIT.map((e, k) => {
      if (mode === 'time') {
        let s = 0, c = 0, sd = 0, cd = 0;
        for (let i = 0; i < n; i++) { const slot = Math.floor((t0 + i * dt) / 0.5e-3) % 5; if (slot === k) { s += raw[i]; c++; } if (slot === 4) { sd += raw[i]; cd++; } }
        return (c ? s / c : 0) - (cd ? sd / cd : 0);
      }
      if (mode === 'frequency') {
        let s = 0; for (let i = 0; i < n; i++) s += raw[i] * Math.sin(2 * Math.PI * freqs[k] * (t0 + i * dt)); return 4 * s / n;
      }
      let s = 0; for (let i = 0; i < n; i++) s += raw[i]; return s / n;
    });
    return { drive, raw, times, rec, amb, freqs };
  }
  function drawMux() {
    const T = D.theme(), mode = st.mux, amb = $('muxAmbient').checked;
    const sig = muxSignals(mode, amb, st.t * 0.004);
    const g = D.fit($('cvMux'), 330);
    const ctx = g.ctx, w = g.w, h = g.h;
    const L = 74, R = w - 10, rowH = 30, gap = 6;
    const sx = i => L + i / (sig.times.length - 1) * (R - L);
    const row = (k, y, data, color, label, scale, fill) => {
      ctx.strokeStyle = T.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, y + rowH); ctx.lineTo(R, y + rowH); ctx.stroke();
      ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(label, L - 6, y + rowH / 2);
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
      for (let i = 0; i < data.length; i++) { const yy = y + rowH - data[i] / scale * rowH; i ? ctx.lineTo(sx(i), yy) : ctx.moveTo(sx(i), yy); }
      ctx.stroke();
      if (fill) { ctx.lineTo(sx(data.length - 1), y + rowH); ctx.lineTo(sx(0), y + rowH); ctx.closePath(); ctx.fillStyle = D.alpha(color, 0.12); ctx.fill(); }
    };
    EMIT.forEach((e, k) => row(k, 8 + k * (rowH + gap), sig.drive[k], T.lam[e.l], `S${e.s} ${e.l ? 850 : 760}`, 1.1, true));
    const yRaw = 8 + 4 * (rowH + gap) + 6;
    let mx = 0; for (const v of sig.raw) mx = Math.max(mx, v);
    const rawH = rowH * 1.8;
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText('detector', L - 6, yRaw + rawH / 2);
    ctx.strokeStyle = T.trace; ctx.lineWidth = 1.4; ctx.beginPath();
    for (let i = 0; i < sig.raw.length; i++) { const yy = yRaw + rawH - sig.raw[i] / (mx * 1.05) * rawH; i ? ctx.lineTo(sx(i), yy) : ctx.moveTo(sx(i), yy); }
    ctx.stroke();
    if (amb) {
      ctx.strokeStyle = T.serious; ctx.setLineDash([3, 3]); ctx.beginPath();
      for (let i = 0; i < sig.amb.length; i++) { const yy = yRaw + rawH - sig.amb[i] / (mx * 1.05) * rawH; i ? ctx.lineTo(sx(i), yy) : ctx.moveTo(sx(i), yy); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = T.muted; ctx.font = D.font(9); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(mode === 'time' ? '20 ms shown; every fifth slot is dark' : mode === 'frequency' ? '20 ms shown; 1.5, 2.25, 3 and 4.5 kHz' : '20 ms shown', R, yRaw + rawH + 2);
    // recovered bars
    const yb = yRaw + rawH + 22, bh = h - yb - 18;
    ctx.fillStyle = T.ink2; ctx.font = D.font(10); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('recovered (bar) against true (tick)', L, yb - 14);
    const bw = (R - L) / EMIT.length;
    const top = Math.max(2.5, ...sig.rec.map(Math.abs));
    EMIT.forEach((e, k) => {
      const x = L + k * bw + bw * 0.25, ww = bw * 0.5, v = sig.rec[k];
      const y0 = yb + bh, yv = yb + bh - Math.max(0, v) / top * bh;
      ctx.fillStyle = T.lam[e.l]; ctx.fillRect(x, yv, ww, y0 - yv);
      const yt = yb + bh - e.g / top * bh;
      ctx.strokeStyle = T.ink; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 4, yt); ctx.lineTo(x + ww + 4, yt); ctx.stroke();
      ctx.fillStyle = T.ink2; ctx.textAlign = 'center'; ctx.fillText(`S${e.s} ${e.l ? 850 : 760}`, x + ww / 2, y0 + 2);
    });
    const err = EMIT.map((e, k) => Math.abs(sig.rec[k] - e.g) / e.g);
    ui.readouts($('muxReadouts'), [
      ['Worst error in recovered light', (100 * Math.max(...err)).toFixed(mode === 'none' ? 0 : 1) + '%'],
      ['Sources a detector can tell apart', mode === 'none' ? 'none' : '4 of 4'],
      ['Room light rejected', amb ? (mode === 'frequency' ? 'yes, outside the lock-in band' : mode === 'time' ? 'steady part, by the dark slot' : 'no') : 'no room light']
    ]);
    $('muxInfo').innerHTML = {
      time: `<p><strong>Time multiplexing.</strong> The sources light one at a time, each in its own slot, plus a slot with every source off. The detector's reading in
        each slot belongs to that source, and subtracting the dark slot removes the room light, as long as it does not change between slots (fluorescent and
        LED room lights flicker at twice the mains frequency, and some of that gets through). The price: each source is on for only a fraction of the time, so
        there is less light per sample and more noise.</p>`,
      frequency: `<p><strong>Frequency multiplexing.</strong> Every source is on all the time, each modulated at its own frequency (kilohertz). The detector sees the
        sum. A lock-in amplifier multiplies the signal by each reference frequency and averages: everything not at that frequency, the other sources and the
        room light, averages away. Every source is on all the time (more light), but each detector sees all of them at once, so a bright channel's shot noise
        lands on a dim one.</p>`,
      none: `<p><strong>No multiplexing.</strong> Every source is on, steadily, so each detector reports the sum of all the light reaching it: channels that share a
        detector become identical, and room light adds straight in. Set the recording to <code>multiplex none</code> to see what this does to the data.</p>`
    }[mode];
  }

  /* ---------- 6. CW, FD, TD ---------- */
  function drawModes() {
    const T = D.theme();
    const mua = ctl.mdMua.get(), musp = ctl.mdMusp.get(), rho = ctl.mdRho.get(), f = ctl.mdFreq.get();
    const R0 = NIRS.homogCW(mua, musp, rho), ph0 = NIRS.homogFD(mua, musp, rho, f).phase;
    // iso-intensity and iso-phase curves in the (mua, mus') plane
    const muas = [], cwCurve = [], fdCurve = [];
    for (let a = 0.03; a <= 0.4001; a += 0.005) {
      muas.push(a);
      const solve = (fn, target) => {
        let lo = 3, hi = 30, flo = fn(lo) - target, fhi = fn(hi) - target;
        if (flo * fhi > 0) return NaN;
        for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2, fm = fn(m) - target; if (fm * flo <= 0) { hi = m; } else { lo = m; flo = fm; } }
        return (lo + hi) / 2;
      };
      cwCurve.push(solve(s => Math.log(NIRS.homogCW(a, s, rho)), Math.log(R0)));
      fdCurve.push(solve(s => NIRS.homogFD(a, s, rho, f).phase, ph0));
    }
    if (!st.pCW) st.pCW = new D.Plot($('cvCW'), { height: 230 });
    st.pCW.draw({
      x: Float64Array.from(muas), xLabel: 'absorption µa (1/cm)', yLabel: "scattering µs' (1/cm)", xRange: [0.03, 0.4], yRange: [3, 30],
      series: [{ y: Float64Array.from(cwCurve), color: T.accent, label: 'same CW intensity' }, { y: Float64Array.from(fdCurve), color: T.series[2], label: 'same FD phase', dash: [5, 3] }],
      markers: [{ x: mua, y: musp, color: T.ink, label: 'tissue' }],
      tipX: x => `µa ${x.toFixed(3)}/cm`, tipFmt: v => v.toFixed(1) + '/cm'
    });
    // FD phase vs separation
    const rr = [], p1 = [], p2 = [];
    for (let r = 1; r <= 5.001; r += 0.05) { rr.push(r); p1.push(NIRS.homogFD(mua, musp, r, f).phase * 180 / Math.PI); p2.push(NIRS.homogFD(mua * 1.5, musp, r, f).phase * 180 / Math.PI); }
    if (!st.pFD) st.pFD = new D.Plot($('cvFD'), { height: 230 });
    st.pFD.draw({
      x: Float64Array.from(rr), xLabel: 'separation (cm)', yLabel: 'phase shift (deg)', yZero: true,
      series: [{ y: Float64Array.from(p1), color: T.accent, label: 'this tissue' }, { y: Float64Array.from(p2), color: T.series[1], dash: [5, 3], label: 'absorption x 1.5' }],
      vlines: [{ x: rho, color: T.muted, dash: [3, 3] }], tipX: x => `${x.toFixed(2)} cm`, tipFmt: v => v.toFixed(1) + '°'
    });
    // TD
    const tt = [], d1 = [], d2 = [], d3 = [];
    for (let t = 0.02; t <= 6; t += 0.02) { tt.push(t); d1.push(NIRS.homogTD(mua, musp, rho, t)); d2.push(NIRS.homogTD(mua * 1.5, musp, rho, t)); d3.push(NIRS.homogTD(mua, musp * 1.5, rho, t)); }
    const norm = a => { const m = Math.max(...a); return Float64Array.from(a, v => Math.max(1e-6, v / m)); };
    if (!st.pTD) st.pTD = new D.Plot($('cvTD'), { height: 230 });
    st.pTD.draw({
      x: Float64Array.from(tt), xLabel: 'time after the pulse (ns)', yLabel: 'photons (relative)', yLog: true, yRange: [1e-3, 1.5],
      series: [{ y: norm(d1), color: T.accent, label: 'this tissue' }, { y: norm(d2), color: T.series[1], dash: [5, 3], label: 'absorption x 1.5' }, { y: norm(d3), color: T.series[2], dash: [2, 3], label: 'scattering x 1.5' }],
      tipX: x => `${x.toFixed(2)} ns`, tipFmt: v => v.toFixed(3)
    });
    ui.legend($('cwLegend'), [{ color: T.accent, label: 'same CW intensity' }, { color: T.series[2], label: 'same FD phase', dash: true }, { color: T.ink, label: 'this tissue', dot: true }]);
    ui.legend($('fdLegend'), [{ color: T.accent, label: 'this tissue' }, { color: T.series[1], label: 'absorption × 1.5', dash: true }]);
    ui.legend($('tdLegend'), [{ color: T.accent, label: 'this tissue' }, { color: T.series[1], label: 'absorption × 1.5', dash: true }, { color: T.series[2], label: 'scattering × 1.5', dash: true }]);
    const fd = NIRS.homogFD(mua, musp, rho, f);
    let s = 0, sw = 0; tt.forEach((t, i) => { s += t * d1[i]; sw += d1[i]; });
    ui.readouts($('modeReadouts'), [
      ['CW: intensity per unit power', NIRS.homogCW(mua, musp, rho).toExponential(2) + ' /cm²'],
      ['FD: phase at ' + f + ' MHz', (fd.phase * 180 / Math.PI).toFixed(1) + '°'], ['FD: AC / DC', fd.ac.toFixed(2)],
      ['TD: mean time of flight', (s / sw).toFixed(2) + ' ns'], ['Mean pathlength (diffusion)', (NIRS.homogDPF(mua, musp, rho) * rho).toFixed(1) + ' cm'],
      ['…so the DPF is', NIRS.homogDPF(mua, musp, rho).toFixed(2)]
    ]);
  }

  function stagePanels() {
    ['sources', 'cap', 'tissue', 'detectors', 'mux', 'modes'].forEach(k => { $('stage-' + k).hidden = k !== st.stage; });
    $('sysStages').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.stage === st.stage)));
  }
  function renderStage() {
    if (st.stage === 'sources') drawSources();
    else if (st.stage === 'cap') drawCap();
    else if (st.stage === 'tissue') drawTissue();
    else if (st.stage === 'detectors') drawDetectors();
    else if (st.stage === 'mux') drawMux();
    else if (st.stage === 'modes') drawModes();
  }

  function loop() {
    if (S.tab !== 'system') { st.anim = null; return; }
    st.t += 1 / 60;
    try { drawSystem(); if (st.stage === 'mux' && st.muxPlay) drawMux(); } catch (e) { console.error(e); }
    st.anim = requestAnimationFrame(loop);
  }

  NIRS.tabs.system = {
    init() {
      const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce) { st.muxPlay = false; $('muxPlay').textContent = 'Play'; }
      $('cvSystem').addEventListener('click', e => {
        const r = $('cvSystem').getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const hit = hot.slice().reverse().find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
        if (hit) {
          st.part = hit.key; partInfo();
          const map = { sources: 'sources', fibres: 'sources', cap: 'cap', tissue: 'tissue', detectors: 'detectors', electronics: 'mux', computer: 'modes' };
          st.stage = map[hit.key]; stagePanels(); renderStage(); drawSystem();
        }
      });
      $('cvSystem').style.cursor = 'pointer';
      $('sysStages').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        st.stage = b.dataset.stage;
        st.part = { sources: 'sources', cap: 'cap', tissue: 'tissue', detectors: 'detectors', mux: 'electronics', modes: 'computer' }[st.stage];
        partInfo(); stagePanels(); renderStage(); drawSystem();
      }));
      ctl.l1 = ui.range('srcL1', v => v + ' nm', drawSources);
      ctl.l2 = ui.range('srcL2', v => v + ' nm', drawSources);
      ctl.fwhm = ui.range('srcFwhm', v => v + ' nm', drawSources);
      ui.seg($('srcTypeSeg'), v => { st.src = v; drawSources(); });
      ui.seg($('hairSeg'), v => { st.hair = v; drawCap(); });
      ui.seg($('sysHeadSeg'), v => { st.head = v; drawTissue(); });
      $('sysTissueNm').addEventListener('change', drawTissue);
      ctl.power = ui.range('detPower', v => Math.pow(10, v).toFixed(Math.pow(10, v) < 1 ? 2 : 1) + ' mW', drawDetectors);
      ctl.rho = ui.range('detRho', v => v.toFixed(1) + ' cm', drawDetectors);
      ui.seg($('detSeg'), v => { st.det = v; drawDetectors(); });
      ctl.mux = ui.seg($('muxSeg'), v => { st.mux = v; drawMux(); });
      $('muxAmbient').addEventListener('change', drawMux);
      $('muxPlay').addEventListener('click', () => { st.muxPlay = !st.muxPlay; $('muxPlay').textContent = st.muxPlay ? 'Pause' : 'Play'; });
      $('btnUseMux').addEventListener('click', () => {
        NIRS.app.setRecordingOption('multiplex', 'multiplex ' + st.mux);
        $('useMuxNote').textContent = `Rebuilt with multiplex ${st.mux}. See the Recording tab.`;
      });
      ['mdMua', 'mdMusp', 'mdRho', 'mdFreq'].forEach(id => {
        const fmt = { mdMua: v => v.toFixed(3) + ' /cm', mdMusp: v => v.toFixed(1) + ' /cm', mdRho: v => v.toFixed(1) + ' cm', mdFreq: v => v + ' MHz' }[id];
        ctl[id] = ui.range(id, fmt, drawModes);
      });
      partInfo();
    },
    onBuild() {
      const R = S.cfg.recording;
      if (R.wavelengths.length >= 2) { ctl.l1.set(R.wavelengths[0]); ctl.l2.set(R.wavelengths[R.wavelengths.length - 1]); }
      st.src = R.source; $('srcTypeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.src)));
      st.det = R.detector; $('detSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.det)));
      st.mux = R.multiplex; ctl.mux.set(st.mux);
      st.hair = S.cfg.head.hair; $('hairSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.hair)));
      st.head = S.cfg.head.model; $('sysHeadSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.head)));
    },
    render() { stagePanels(); drawSystem(); renderStage(); },
    show() { if (!st.anim) st.anim = requestAnimationFrame(loop); },
    hide() { if (st.anim) cancelAnimationFrame(st.anim); st.anim = null; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
