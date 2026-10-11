/* ============================================================
   MRI Simulator, Scanner tab (ARCHITECTURE.md section 12.5)

   The hardware of a 3 T scanner as one labelled schematic, the way a
   good textbook figure draws it:

     magnet room   a cut-away side view of the magnet (cryostat, liquid
                   helium and the superconducting coil, shims, gradient
                   coils, RF body coil, bore liner), the patient on the
                   table with the receive head coil, B0 along the bore,
                   an end-on inset that shows the eight coil elements,
                   the T/R switch and the preamplifiers;
     equipment     sequencer, gradient amplifiers, RF synthesiser and
                   power amplifier, demodulator and ADC, k-space, the
                   reconstruction computer and the helium compressor;
     control room  the operator console.

   Every part is a button (hover, click, or arrow keys and Enter) that
   opens an info panel: what it does, typical 3 T numbers, what goes
   wrong and which artifact that causes in this simulator. During an
   animated scan the parts light up from playback:tick (RF chain during
   pulses, one level bar per gradient amplifier, the receive chain while
   the ADC samples). Live states are CSS classes on the <svg> root, so a
   tick costs a handful of class and attribute changes, never a rebuild.

   Also here: a "follow the signal" stepper, a Larmor calculator
   (f = gamma-bar (B0 + G x)), the receive-coil selector and a compact
   hardware table.

   The figure is drawn as an SVG string in two hand-placed layouts: a
   wide one (rooms stacked, magnet room across the top) and a tall one
   for phones. The layout follows the width of the figure, and all
   events are delegated to its container, so a rebuild leaks nothing.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const KC = MRI.const || {};
    const GBAR = KC.GAMMA_BAR || 42.577478e6;       // Hz/T
    const B0 = KC.B0 || 3;
    const F0 = KC.F0 || GBAR * B0;
    const GMAX = KC.GMAX || 0.045;
    const SLEW = KC.SLEW || 200;
    const FAT_HZ = KC.FAT_HZ || -3.4e-6 * F0;
    const raf = root.requestAnimationFrame ? root.requestAnimationFrame.bind(root) : function (f) { return setTimeout(f, 16); };
    const now = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };
    const P_ = 'scnr';           // id prefix for SVG defs (markers, clip paths)

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function W() { return MRI.ui.w; }
    function S() { return MRI.state || {}; }
    function A() { return MRI.actions || {}; }
    function goodProgram() {
        const st = S();
        if (st.program && st.program.ok) return st.program;
        return st.lastGoodProgram && st.lastGoodProgram.ok ? st.lastGoodProgram : null;
    }
    function fmt(v, sig) { return isFinite(v) ? U.fmtNum(v, sig || 3) : '-'; }
    function signed(v, dec) {
        if (!isFinite(v)) return '-';
        const s = Math.abs(v).toFixed(dec);
        if (Number(s) === 0) return s;
        return (v < 0 ? '−' : '+') + s;
    }
    function clock(t, total) {
        if (!isFinite(t)) return '-';
        if ((total || t) >= 60) {
            const m = Math.floor(t / 60), sec = t - 60 * m;
            return m + ':' + (sec < 10 ? '0' : '') + sec.toFixed(1);
        }
        if ((total || t) >= 1) return t.toFixed(2) + ' s';
        return (t * 1e3).toFixed(1) + ' ms';
    }

    /* ============================================================
       Styles (all scoped under #tab-scanner)
       ============================================================ */
    const CSS = `
#tab-scanner {
    --sc-room: rgba(37, 99, 235, 0.035);
    --sc-room-2: var(--card-2);
    --sc-copper: #b8692f;
    --sc-copper-text: #995220;
    --sc-cover: #e7ebf1;
    --sc-cover-line: #b4bdca;
    --sc-steel: #cfd6df;
    --sc-steel-line: #8d98a8;
    --sc-lhe: #c8e1f8;
    --sc-lhe-line: #6d9fd1;
    --sc-gas: #e9f3fd;
    --sc-coil: #c4783c;
    --sc-coil-line: #8a4f22;
    --sc-shim: #9aa4b2;
    --sc-iron: #5a6474;
    --sc-liner: #f6f8fb;
    --sc-bore: #eef1f6;
    --sc-table: #c9d0da;
    --sc-table-line: #8e98a7;
    --sc-skin: #e9c2a2;
    --sc-skin-line: #9c6f4f;
    --sc-gown: #b8cbe0;
    --sc-gown-line: #6f86a3;
    --sc-brain: #d9d3cd;
    --sc-he: #0f8f9a;
    --sc-ctl: #6b7585;
    --sc-label: var(--fg);
    --sc-leader: #7c8696;
}
@media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) #tab-scanner {
        --sc-room: rgba(96, 165, 250, 0.04);
        --sc-copper: #d08a4f; --sc-copper-text: #dc9a62;
        --sc-cover: #1b2436; --sc-cover-line: #3b4862;
        --sc-steel: #2a3550; --sc-steel-line: #56647f;
        --sc-lhe: #1b3b5e; --sc-lhe-line: #4a7fb5; --sc-gas: #16293f;
        --sc-coil: #c47a40; --sc-coil-line: #e0a06a;
        --sc-shim: #4d5970; --sc-iron: #8794ab;
        --sc-liner: #141c2c; --sc-bore: #121a29;
        --sc-table: #3a465e; --sc-table-line: #6a7894;
        --sc-skin: #8a6a55; --sc-skin-line: #c39a7c;
        --sc-gown: #3d4c66; --sc-gown-line: #7486a6;
        --sc-brain: #5f5a57;
        --sc-he: #35c2cd;
        --sc-ctl: #93a0b4;
        --sc-leader: #8794a8;
    }
}
:root[data-theme="dark"] #tab-scanner {
    --sc-room: rgba(96, 165, 250, 0.04);
    --sc-copper: #d08a4f; --sc-copper-text: #dc9a62;
    --sc-cover: #1b2436; --sc-cover-line: #3b4862;
    --sc-steel: #2a3550; --sc-steel-line: #56647f;
    --sc-lhe: #1b3b5e; --sc-lhe-line: #4a7fb5; --sc-gas: #16293f;
    --sc-coil: #c47a40; --sc-coil-line: #e0a06a;
    --sc-shim: #4d5970; --sc-iron: #8794ab;
    --sc-liner: #141c2c; --sc-bore: #121a29;
    --sc-table: #3a465e; --sc-table-line: #6a7894;
    --sc-skin: #8a6a55; --sc-skin-line: #c39a7c;
    --sc-gown: #3d4c66; --sc-gown-line: #7486a6;
    --sc-brain: #5f5a57;
    --sc-he: #35c2cd;
    --sc-ctl: #93a0b4;
    --sc-leader: #8794a8;
}

/* ---- page layout ---- */
#tab-scanner .sc-top { grid-template-columns: minmax(0, 1fr) 320px; }
@media (max-width: 1099px) { #tab-scanner .sc-top { grid-template-columns: minmax(0, 1fr); } }
#tab-scanner .sc-figpanel { padding: 14px 12px 12px; }
#tab-scanner .sc-figpanel .panel-head { padding: 0 6px; }
#tab-scanner .sc-coilsel { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--muted); }
#tab-scanner .sc-fig { position: relative; width: 100%; margin: 0 auto; }
#tab-scanner .sc-fig.is-tall { max-width: 540px; }
#tab-scanner .sc-fig > svg { display: block; width: 100%; height: auto; overflow: visible; }
#tab-scanner .sc-under { padding: 8px 6px 0; display: grid; gap: 8px; }
#tab-scanner .sc-live {
    display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; min-height: 34px;
    padding: 6px 10px; border-radius: 8px; background: var(--card-2); border: 1px solid var(--border-subtle);
    font-size: 0.8rem; color: var(--muted); font-variant-numeric: tabular-nums;
}
#tab-scanner .sc-live b { color: var(--fg); font-weight: 600; }
#tab-scanner .sc-live .sc-live-state { display: inline-flex; align-items: center; gap: 7px; font-weight: 650; color: var(--fg); }
#tab-scanner .sc-live .sc-live-item { white-space: nowrap; }
#tab-scanner .sc-live .sc-live-rf b { color: var(--seq-rf); color: color-mix(in srgb, var(--seq-rf) 75%, var(--fg)); }
#tab-scanner .sc-live .sc-live-adc b { color: var(--seq-adc); color: color-mix(in srgb, var(--seq-adc) 70%, var(--fg)); }
#tab-scanner .sc-live[data-state="idle"] .sc-live-run { display: none; }
#tab-scanner .sc-live:not([data-state="idle"]) .sc-live-idle { display: none; }
#tab-scanner .sc-legend .swatch-line { border-top-width: 3px; }
#tab-scanner .sc-coilnote { margin: 0; }
#tab-scanner .sc-live-idle { flex: 1; min-width: 0; }
#tab-scanner .sc-svg.lay-tall .t-lab { font-size: 11px; }
#tab-scanner .sc-svg.lay-tall .bx-t { font-size: 12px; }
#tab-scanner .sc-svg.lay-tall .bx-s { font-size: 10.4px; }
#tab-scanner .sc-svg.lay-tall .t-small { font-size: 10.4px; }
@media (max-width: 640px) {
    #tab-scanner .sc-figpanel { padding: 12px 3px 10px; }
    #tab-scanner .sc-figpanel .panel-head { padding: 0 9px; }
    #tab-scanner .sc-under { padding: 8px 9px 0; }
}

/* ---- side column: stepper and info ---- */
#tab-scanner .sc-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
#tab-scanner .sc-side > .panel { margin: 0; }
#tab-scanner .sc-step-title { font-weight: 650; margin: 0 0 4px; font-size: 0.95rem; }
#tab-scanner .sc-step-text { font-size: 0.88rem; line-height: 1.55; margin: 0; min-height: 4.6em; }
#tab-scanner .sc-dots { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 10px; }
#tab-scanner .sc-dot {
    width: 26px; height: 26px; padding: 0; border-radius: 50%; border: 1px solid var(--border-strong);
    background: var(--card); color: var(--muted); font: 600 0.72rem/1 var(--font-sans); cursor: pointer;
    display: inline-grid; place-items: center;
}
#tab-scanner .sc-dot:hover { border-color: var(--accent); color: var(--accent); }
#tab-scanner .sc-dot[aria-current="step"] { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent); }
#tab-scanner .sc-dot.done { border-color: var(--accent-border); color: var(--accent); }
#tab-scanner .sc-dot:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-scanner .sc-info-eyebrow {
    font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin-bottom: 2px;
}
#tab-scanner .sc-info h3 { font-size: 1.02rem; margin: 0 0 8px; }
#tab-scanner .sc-info p { font-size: 0.86rem; line-height: 1.55; }
#tab-scanner .sc-info h4 {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 14px 0 6px;
}
#tab-scanner .sc-info .stat-table th { width: 48%; }
#tab-scanner .sc-info .stat-table td { text-align: left; font-family: var(--font-sans); font-size: 0.82rem; }
#tab-scanner .sc-info .stat-table tr.sc-live-row th, #tab-scanner .sc-info .stat-table tr.sc-live-row td { color: var(--accent); }
#tab-scanner .sc-info .sc-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
#tab-scanner .sc-info .callout { margin: 8px 0 0; }
#tab-scanner .sc-info-empty { color: var(--muted); font-size: 0.86rem; }
#tab-scanner .sc-info-empty p { margin: 0 0 8px; }

/* ---- Larmor calculator ---- */
#tab-scanner .sc-larmor .controls { --min: 220px; margin-bottom: 12px; }
#tab-scanner .sc-larmor .stats { grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); margin-bottom: 10px; }
#tab-scanner .sc-larmor .stat-value { font-size: 1rem; }
#tab-scanner .sc-eq {
    font-family: var(--font-math); font-size: 1rem; text-align: center; padding: 6px 10px; margin: 0 0 10px;
    background: var(--card-2); border: 1px solid var(--border-subtle); border-radius: 8px; overflow-x: auto;
}
#tab-scanner .sc-lplot { display: block; width: 100%; margin: 6px 0 8px; }
#tab-scanner .sc-lplot text { font-family: var(--font-sans); font-size: 10.5px; fill: var(--muted); }
#tab-scanner .sc-lplot .lp-grid { stroke: var(--grid); stroke-width: 1; }
#tab-scanner .sc-lplot .lp-axis { stroke: var(--axis); stroke-width: 1; }
#tab-scanner .sc-lplot .lp-head { fill: var(--sc-skin); opacity: 0.35; }
#tab-scanner .sc-lplot .lp-win { fill: var(--seq-adc); opacity: 0.14; }
#tab-scanner .sc-lplot .lp-winline { stroke: var(--seq-adc); stroke-width: 1; stroke-dasharray: 4 3; }
#tab-scanner .sc-lplot .lp-line { stroke: var(--seq-gx); stroke-width: 2.5; fill: none; }
#tab-scanner .sc-lplot .lp-guide { stroke: var(--seq-gx); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.7; }
#tab-scanner .sc-lplot .lp-dot { fill: var(--card); stroke: var(--seq-gx); stroke-width: 2.5; }
#tab-scanner .sc-lplot .lp-strong { fill: var(--fg); font-weight: 600; }
#tab-scanner .sc-lplot .lp-adc { fill: var(--warn); }
#tab-scanner .sc-specs .stat-table td { text-align: left; font-family: var(--font-sans); }
#tab-scanner .sc-specs .stat-table th { width: 46%; }

/* ---- the schematic ---- */
#tab-scanner .sc-svg { font-family: var(--font-sans); -webkit-user-select: none; user-select: none; }
#tab-scanner .sc-svg text { fill: var(--sc-label); font-size: 11.5px; }
#tab-scanner .sc-svg .t-room { font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em; fill: var(--muted); }
#tab-scanner .sc-svg .t-roomsub { font-size: 10px; fill: var(--muted); }
#tab-scanner .sc-svg .t-cage { fill: var(--sc-copper-text); font-weight: 600; }
#tab-scanner .sc-svg .t-small { font-size: 10px; fill: var(--muted); }
#tab-scanner .sc-svg .t-tiny { font-size: 9px; fill: var(--muted); }
#tab-scanner .sc-svg .t-lab { font-size: 11px; }
#tab-scanner .sc-svg .t-b0 { font-size: 13px; font-weight: 700; font-family: var(--font-math); }
#tab-scanner .sc-svg .t-axis { font-size: 12px; font-weight: 700; font-family: var(--font-math); }
#tab-scanner .sc-svg .t-gx { fill: var(--seq-gx); fill: color-mix(in srgb, var(--seq-gx) 75%, var(--fg)); font-weight: 700; }
#tab-scanner .sc-svg .t-gy { fill: var(--seq-gy); fill: color-mix(in srgb, var(--seq-gy) 75%, var(--fg)); font-weight: 700; }
#tab-scanner .sc-svg .t-gz { fill: var(--seq-gz); fill: color-mix(in srgb, var(--seq-gz) 75%, var(--fg)); font-weight: 700; }
#tab-scanner .sc-svg .t-rx { fill: var(--seq-adc); fill: color-mix(in srgb, var(--seq-adc) 70%, var(--fg)); font-weight: 650; }
#tab-scanner .sc-svg .t-rf { fill: var(--seq-rf); fill: color-mix(in srgb, var(--seq-rf) 75%, var(--fg)); font-weight: 650; }
#tab-scanner .sc-svg .t-lhe { font-size: 10px; fill: var(--sc-lhe-line); font-weight: 600; }
#tab-scanner .sc-svg .room { stroke: var(--border); stroke-width: 1; }
#tab-scanner .sc-svg .room-mag { fill: var(--sc-room); }
#tab-scanner .sc-svg .room-eq { fill: var(--sc-room-2); }
#tab-scanner .sc-svg .cage { fill: none; stroke: var(--sc-copper); stroke-width: 2.5; }
#tab-scanner .sc-svg .cage-hit { fill: none; stroke: #000; stroke-opacity: 0; stroke-width: 10; pointer-events: stroke; }
#tab-scanner .sc-svg .panelbar { fill: var(--sc-copper); opacity: 0.55; }
#tab-scanner .sc-svg .filter { fill: var(--card); stroke: var(--sc-copper); stroke-width: 1.2; }

/* magnet (drawn in local units, so keep strokes in screen pixels) */
#tab-scanner .sc-svg .mg * { vector-effect: non-scaling-stroke; }
#tab-scanner .sc-svg .m-cover { fill: var(--sc-cover); stroke: var(--sc-cover-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-ovc { fill: var(--sc-steel); stroke: var(--sc-steel-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-shield { fill: none; stroke: var(--sc-steel-line); stroke-width: 0.8; stroke-dasharray: 3 2; }
#tab-scanner .sc-svg .m-he { fill: var(--sc-lhe); stroke: var(--sc-lhe-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-gas { fill: var(--sc-gas); }
#tab-scanner .sc-svg .m-level { stroke: var(--sc-lhe-line); stroke-width: 1; stroke-dasharray: 2 2; }
#tab-scanner .sc-svg .m-coil { fill: var(--sc-coil); stroke: var(--sc-coil-line); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-coil2 { fill: var(--sc-coil); stroke: var(--sc-coil-line); stroke-width: 0.8; opacity: 0.75; }
#tab-scanner .sc-svg .m-shim { fill: var(--sc-shim); stroke: var(--sc-iron); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-iron { fill: var(--sc-iron); }
#tab-scanner .sc-svg .m-gx { fill: var(--seq-gx); fill-opacity: 0.32; stroke: var(--seq-gx); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-gy { fill: var(--seq-gy); fill-opacity: 0.32; stroke: var(--seq-gy); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-gz { fill: var(--seq-gz); fill-opacity: 0.32; stroke: var(--seq-gz); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-rf { fill: var(--seq-rf); fill-opacity: 0.14; stroke: var(--seq-rf); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-rfring { fill: var(--seq-rf); stroke: var(--seq-rf); stroke-width: 0.8; }
#tab-scanner .sc-svg .m-rung { stroke: var(--seq-rf); stroke-width: 1; opacity: 0.8; }
#tab-scanner .sc-svg .m-liner { fill: var(--sc-liner); stroke: var(--sc-cover-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-bore { fill: var(--sc-bore); stroke: none; }
#tab-scanner .sc-svg .m-table { fill: var(--sc-table); stroke: var(--sc-table-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-skin { fill: var(--sc-skin); stroke: var(--sc-skin-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-gown { fill: var(--sc-gown); stroke: var(--sc-gown-line); stroke-width: 1; }
#tab-scanner .sc-svg .m-brain { fill: var(--sc-brain); stroke: none; }
#tab-scanner .sc-svg .m-slice { fill: var(--seq-gz); fill-opacity: 0.45; }
#tab-scanner .sc-svg .m-hcoil { fill: var(--seq-adc); fill-opacity: 0.12; stroke: var(--seq-adc); stroke-width: 2.2; }
#tab-scanner .sc-svg .m-hloop { fill: none; stroke: var(--seq-adc); stroke-width: 1.6; }
#tab-scanner .sc-svg .m-b0 { stroke: var(--fg); stroke-width: 2.2; fill: none; }
#tab-scanner .sc-svg .m-b0head { fill: var(--fg); }
#tab-scanner .sc-svg .m-cold { fill: var(--sc-steel); stroke: var(--sc-steel-line); stroke-width: 1; }
#tab-scanner .sc-svg .leader { fill: none; stroke: var(--sc-leader); stroke-width: 0.9; }
#tab-scanner .sc-svg .leader-dot { fill: var(--sc-leader); }
#tab-scanner .sc-svg .hitbox { fill: #000; fill-opacity: 0; }

/* inset */
#tab-scanner .sc-svg .in-frame { fill: var(--card); stroke: var(--border-strong); stroke-width: 1; }
#tab-scanner .sc-svg .in-ring { fill: none; }
#tab-scanner .sc-svg .in-bore { fill: var(--sc-room); }
#tab-scanner .sc-svg .in-cryo { fill: var(--sc-steel); }
#tab-scanner .sc-svg .in-shim { fill: var(--sc-shim); }
#tab-scanner .sc-svg .in-rung { fill: var(--seq-rf); }
#tab-scanner .sc-svg .in-elem { fill: none; stroke: var(--seq-adc); stroke-width: 3; stroke-linecap: round; }
#tab-scanner .sc-svg .in-title { font-size: 10px; font-weight: 600; fill: var(--muted); }
#tab-scanner .sc-svg .in-titlebg { fill: var(--card); opacity: 0.85; }

/* equipment boxes */
#tab-scanner .sc-svg .bx { fill: var(--card); stroke: var(--border-strong); stroke-width: 1.2; transition: stroke 0.15s ease, fill 0.15s ease; }
#tab-scanner .sc-svg .bx-cab { fill: none; stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 4 3; }
#tab-scanner .sc-svg .bx-t { font-size: 11.5px; font-weight: 650; }
#tab-scanner .sc-svg .bx-s { font-size: 9.8px; fill: var(--muted); }
#tab-scanner .sc-svg .bx-v { font-size: 9.5px; fill: var(--muted); font-family: var(--font-mono); }
#tab-scanner .sc-svg .bx-tag { stroke: none; }
#tab-scanner .sc-svg .ic { fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
#tab-scanner .sc-svg .ic-fill { stroke: none; }
#tab-scanner .sc-svg .halo { fill: none; stroke-width: 7; opacity: 0; transition: opacity 0.12s ease; }
#tab-scanner .sc-svg .lvl-track { fill: var(--card-2); stroke: var(--border); stroke-width: 0.8; }
#tab-scanner .sc-svg .lvl-mid { stroke: var(--axis); stroke-width: 1; }
#tab-scanner .sc-svg .lvl-x { fill: var(--seq-gx); }
#tab-scanner .sc-svg .lvl-y { fill: var(--seq-gy); }
#tab-scanner .sc-svg .lvl-z { fill: var(--seq-gz); }
#tab-scanner .sc-svg .monitor { fill: var(--scope-bg); stroke: var(--border-strong); stroke-width: 1; }

/* chain colours */
#tab-scanner .sc-svg .c-rf { stroke: var(--seq-rf); fill: var(--seq-rf); }
#tab-scanner .sc-svg .c-gx { stroke: var(--seq-gx); fill: var(--seq-gx); }
#tab-scanner .sc-svg .c-gy { stroke: var(--seq-gy); fill: var(--seq-gy); }
#tab-scanner .sc-svg .c-gz { stroke: var(--seq-gz); fill: var(--seq-gz); }
#tab-scanner .sc-svg .c-rx { stroke: var(--seq-adc); fill: var(--seq-adc); }
#tab-scanner .sc-svg .c-ctl { stroke: var(--sc-ctl); fill: var(--sc-ctl); }
#tab-scanner .sc-svg .c-he { stroke: var(--sc-he); fill: var(--sc-he); }
#tab-scanner .sc-svg .c-cage { stroke: var(--sc-copper); fill: var(--sc-copper); }
#tab-scanner .sc-svg .ic.c-rf, #tab-scanner .sc-svg .ic.c-gx, #tab-scanner .sc-svg .ic.c-gy, #tab-scanner .sc-svg .ic.c-gz,
#tab-scanner .sc-svg .ic.c-rx, #tab-scanner .sc-svg .ic.c-ctl, #tab-scanner .sc-svg .ic.c-he { fill: none; }

/* wires */
#tab-scanner .sc-svg .wire { fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; transition: stroke-width 0.12s ease, opacity 0.2s ease; }
#tab-scanner .sc-svg .wire.dash { stroke-dasharray: 5 4; }
#tab-scanner .sc-svg .w-he-out { fill: none; stroke: var(--sc-he); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.85; }
#tab-scanner .sc-svg .w-he-in { fill: none; stroke: var(--card); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
#tab-scanner .sc-svg .mk { stroke: none; }
#tab-scanner .sc-svg .wlabel { font-size: 9.5px; fill: var(--muted); paint-order: stroke; stroke: var(--card-2); stroke-width: 3px; stroke-linejoin: round; }
#tab-scanner .sc-svg .wlabel.on-mag { stroke: var(--bg); }
#tab-scanner .sc-svg.coil-head8 .only-body { display: none; }
#tab-scanner .sc-svg.coil-body .only-head8 { display: none; }
#tab-scanner .sc-svg.coil-head8 .rx-unused { opacity: 0.35; }

/* interaction: hover, focus, selection, stepper spotlight */
#tab-scanner .sc-svg .sc-c { cursor: pointer; outline: none; }
#tab-scanner .sc-svg .sc-c.hl .bx, #tab-scanner .sc-svg .sc-c.sel .bx { stroke: var(--accent); stroke-width: 2; }
#tab-scanner .sc-svg .sc-c.hl .bx { fill: var(--accent-soft); }
#tab-scanner .sc-svg .sc-c.hl .sh, #tab-scanner .sc-svg .sc-c.sel .sh { stroke: var(--accent); stroke-width: 2; }
#tab-scanner .sc-svg .sc-c.hl .lab, #tab-scanner .sc-svg .sc-c.sel .lab { fill: var(--accent); font-weight: 650; }
#tab-scanner .sc-svg .sc-c.hl .leader, #tab-scanner .sc-svg .sc-c.sel .leader { stroke: var(--accent); stroke-width: 1.4; }
#tab-scanner .sc-svg .sc-c.hl .leader-dot, #tab-scanner .sc-svg .sc-c.sel .leader-dot { fill: var(--accent); }
#tab-scanner .sc-svg .sc-c.sel .bx { stroke-width: 2.6; }
#tab-scanner .sc-svg .sc-c .ring { fill: none; stroke: var(--focus); stroke-width: 2; stroke-dasharray: 4 3; opacity: 0; }
#tab-scanner .sc-svg .sc-c.focus .ring { opacity: 1; }
#tab-scanner .sc-svg .sc-c.focus .sh { stroke: var(--focus); stroke-width: 2.4; }
#tab-scanner .sc-svg .sc-c, #tab-scanner .sc-svg .wire, #tab-scanner .sc-svg .wgrp { transition: opacity 0.25s ease; }
#tab-scanner .sc-svg.stepping .sc-c:not(.stp), #tab-scanner .sc-svg.stepping .wgrp:not(.stp) { opacity: 0.26; }
#tab-scanner .sc-svg.stepping .sc-c.stp .bx, #tab-scanner .sc-svg.stepping .sc-c.stp .sh { stroke: var(--accent); stroke-width: 2.6; }
#tab-scanner .sc-svg.stepping .sc-c.stp .lab { fill: var(--accent); font-weight: 650; }
#tab-scanner .sc-svg.stepping .wgrp.stp .wire { stroke-width: 3; stroke-dasharray: 7 5; animation: scnr-flow 0.7s linear infinite; }

/* live activity during playback */
@keyframes scnr-flow { to { stroke-dashoffset: -12; } }
#tab-scanner .sc-svg.playing .sc-c.k-seq .bx { stroke: var(--sc-ctl); stroke-width: 2; }
#tab-scanner .sc-svg.live-rf .lv-rf .halo { opacity: 0.32; }
#tab-scanner .sc-svg.live-rf .lv-rf .bx { stroke: var(--seq-rf); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-rf .wgrp.lv-rf .wire { stroke-width: 3; stroke-dasharray: 7 5; animation: scnr-flow 0.5s linear infinite; }
#tab-scanner .sc-svg.live-rf .m-rf { fill-opacity: 0.7; }
#tab-scanner .sc-svg.live-rf .m-rung { stroke-width: 2.4; opacity: 1; }
#tab-scanner .sc-svg.live-rf .in-rung { r: 2.6px; }
#tab-scanner .sc-svg.live-gx .lv-gx .halo, #tab-scanner .sc-svg.live-gy .lv-gy .halo, #tab-scanner .sc-svg.live-gz .lv-gz .halo { opacity: 0.32; }
#tab-scanner .sc-svg.live-gx .lv-gx .bx { stroke: var(--seq-gx); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-gy .lv-gy .bx { stroke: var(--seq-gy); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-gz .lv-gz .bx { stroke: var(--seq-gz); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-gx .wgrp.lv-gx .wire, #tab-scanner .sc-svg.live-gy .wgrp.lv-gy .wire, #tab-scanner .sc-svg.live-gz .wgrp.lv-gz .wire {
    stroke-width: 3; stroke-dasharray: 7 5; animation: scnr-flow 0.5s linear infinite;
}
#tab-scanner .sc-svg.live-gx .m-gx, #tab-scanner .sc-svg.live-gy .m-gy, #tab-scanner .sc-svg.live-gz .m-gz { fill-opacity: 0.95; }
#tab-scanner .sc-svg.live-gz .m-slice { fill-opacity: 0.95; }
#tab-scanner .sc-svg.live-rx .lv-rx .halo { opacity: 0.32; }
#tab-scanner .sc-svg.live-rx .lv-rx .bx { stroke: var(--seq-adc); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-rx .wgrp.lv-rx .wire { stroke-width: 3; stroke-dasharray: 7 5; animation: scnr-flow 0.5s linear infinite; }
#tab-scanner .sc-svg.live-rx .m-hcoil { fill-opacity: 0.55; }
#tab-scanner .sc-svg.live-rx .in-elem { stroke-width: 4.5; }
#tab-scanner .sc-svg.live-rx.coil-body .lv-rxbody .halo { opacity: 0.32; stroke: var(--seq-adc); }
#tab-scanner .sc-svg.live-rx.coil-body .lv-rxbody .bx { stroke: var(--seq-adc); stroke-width: 2.2; }
#tab-scanner .sc-svg.live-rx.coil-body .wgrp.lv-rxbody .wire { stroke-width: 3; stroke-dasharray: 7 5; animation: scnr-flow 0.5s linear infinite reverse; }
#tab-scanner .sc-svg.live-rx.coil-body .m-rf { fill: var(--seq-adc); fill-opacity: 0.6; }
#tab-scanner .sc-svg.live-rx.coil-body .in-body { stroke: var(--seq-adc); }
@media (prefers-reduced-motion: reduce) {
    #tab-scanner .sc-svg .wire { animation: none !important; }
}
`;

    /* ============================================================
       Teaching content
       ============================================================ */

    /* Components of the schematic, in keyboard (arrow-key) order, which
       follows the signal from the console to the image. info: which entry
       of INFO opens. */
    const COMPS = [
        { id: 'console', info: 'console', name: 'Operator console' },
        { id: 'sequencer', info: 'sequencer', name: 'Sequencer (pulse program)' },
        { id: 'rfsynth', info: 'rfsynth', name: 'RF synthesiser and modulator' },
        { id: 'rfamp', info: 'rfamp', name: 'RF power amplifier' },
        { id: 'trsw', info: 'trsw', name: 'T/R switch' },
        { id: 'bodycoil', info: 'bodycoil', name: 'RF body coil' },
        { id: 'gradamp-x', info: 'gradamp', name: 'Gradient amplifier x' },
        { id: 'gradamp-y', info: 'gradamp', name: 'Gradient amplifier y' },
        { id: 'gradamp-z', info: 'gradamp', name: 'Gradient amplifier z' },
        { id: 'gradcoils', info: 'gradcoils', name: 'Gradient coils' },
        { id: 'patient', info: 'patient', name: "Patient's protons" },
        { id: 'headcoil', info: 'headcoil', name: '8-channel receive head coil' },
        { id: 'preamp', info: 'preamp', name: 'Preamplifiers' },
        { id: 'cage', info: 'cage', name: 'Faraday cage and penetration panel' },
        { id: 'demod', info: 'demod', name: 'Demodulator and ADC' },
        { id: 'kspace', info: 'kspace', name: 'Raw data, k-space' },
        { id: 'recon', info: 'recon', name: 'Reconstruction computer' },
        { id: 'magnet', info: 'magnet', name: 'Superconducting magnet' },
        { id: 'shim', info: 'shim', name: 'Shim coils' },
        { id: 'cryo', info: 'cryo', name: 'Liquid helium and cold head' },
        { id: 'compressor', info: 'cryo', name: 'Helium compressor' },
        { id: 'liner', info: 'liner', name: 'Bore and bore liner' }
    ];
    const COMP_BY_ID = {};
    COMPS.forEach(function (c) { COMP_BY_ID[c.id] = c; });

    /* A link to one card of the Artifacts tab (its id there): runLink opens
       the tab and emits artifacts:focus, which opens and scrolls to the card. */
    function art(id, what) {
        return { label: what ? 'See ' + what + ' in the Artifacts tab' : 'See it in the Artifacts tab', tab: 'artifacts', artifact: id };
    }

    /* Live rows: computed from the current (or last good) program when the
       panel is drawn, shown in the accent colour as "this scan". */
    function liveSequencer() {
        const p = goodProgram();
        if (!p) return [];
        const nGrad = ['x', 'y', 'z'].reduce(function (n, a) { return n + ((p.grad && p.grad[a]) || []).length; }, 0);
        return [
            ['This sequence', (p.name || 'untitled')],
            ['RF pulses', String((p.rf || []).length) + ' (including dummy scans)'],
            ['Gradient trapezoids', String(nGrad)],
            ['ADC windows', String((p.adc || []).filter(function (a) { return !a.dummy; }).length) + ' recorded'],
            ['Duration', U.fmtTime(p.duration || 0)]
        ];
    }
    function liveConsole() {
        const p = goodProgram();
        if (!p) return [];
        const rows = [['Protocol now', p.name || 'untitled']];
        if (p.image) rows.push(['Matrix and FOV', p.image.nx + ' × ' + p.image.ny + ', ' + fmt(p.image.fovX * 1e3, 3) + ' mm']);
        rows.push(['Scan time', U.fmtTime(p.scanTime || p.duration || 0)]);
        return rows;
    }
    const TAG_NAME = {
        readout: 'the readout', prephase: 'the readout prephaser', encode: 'phase encoding', rewind: 'a rewinder',
        slice: 'slice selection', rephase: 'the slice rephaser', crush: 'a crusher', spoil: 'the spoiler',
        blip: 'an EPI blip', manual: 'a gradient written by hand'
    };
    function liveGrad(axis) {
        const p = goodProgram();
        if (!p || !p.grad) return [];
        const list = (p.grad[axis] || []);
        let peak = null, ro = null;
        list.forEach(function (tr) {
            if (!peak || Math.abs(tr.amp) > Math.abs(peak.amp)) peak = tr;
            if (tr.tag === 'readout' && (!ro || Math.abs(tr.amp) > Math.abs(ro.amp))) ro = tr;
        });
        if (!peak) return [['This sequence', 'does not use the ' + axis + ' gradient']];
        const g = Math.abs(peak.amp);
        const rows = [['Peak on ' + axis + ' in this sequence', fmt(g * 1e3, 3) + ' mT/m (' + Math.round(100 * g / GMAX) + '% of Gmax), in ' + (TAG_NAME[peak.tag] || 'a gradient')]];
        if (ro && ro !== peak) rows.push(['Readout gradient on ' + axis, fmt(Math.abs(ro.amp) * 1e3, 3) + ' mT/m']);
        return rows;
    }
    function liveRfAmp() {
        const p = goodProgram();
        if (!p || !p.rf || !p.rf.length) return [];
        let maxFlip = 0;
        p.rf.forEach(function (r) { if (r.flip > maxFlip) maxFlip = r.flip; });
        const per = p.periods && p.periods.length ? p.rf.length / p.periods.length : p.rf.length;
        return [['Largest flip in this sequence', fmt(maxFlip, 3) + '°'], ['Pulses per period', fmt(per, 3)]];
    }
    function liveDemod() {
        const p = goodProgram();
        const a = p && p.adc ? p.adc.find(function (x) { return !x.dummy; }) || p.adc[0] : null;
        if (!a) return [];
        const rows = [
            ['Samples per readout', String(a.n) + (p.image && p.image.oversample > 1 ? ' (' + p.image.oversample + '× oversampled)' : '')],
            ['Dwell time', fmt(a.dwell * 1e6, 3) + ' µs'],
            ['Sampled bandwidth', '±' + fmt(0.5 / a.dwell / 1e3, 3) + ' kHz']
        ];
        if (p.image && isFinite(p.image.bwPerPixel)) rows.push(['Bandwidth per pixel', fmt(p.image.bwPerPixel, 4) + ' Hz/px']);
        return rows;
    }
    function liveKspace() {
        const p = goodProgram();
        if (!p || !p.image) return [];
        const nc = S().coilType === 'body' ? 1 : 8;
        const nAdc = (p.adc || []).filter(function (a) { return !a.dummy; });
        let ns = 0;
        nAdc.forEach(function (a) { ns += a.n; });
        return [
            ['Matrix', p.image.nx + ' × ' + p.image.ny],
            ['Readouts', String(nAdc.length)],
            ['Receive channels', String(nc)],
            ['Complex samples', String(ns * nc).replace(/\B(?=(\d{3})+(?!\d))/g, ',')]
        ];
    }
    function liveRecon() {
        const st = S();
        const rows = [];
        const r = st.reconResult;
        if (r && r.image) rows.push(['Image', r.image.nx + ' × ' + r.image.ny]);
        if (isFinite(st.reconMs)) rows.push(['Last reconstruction', fmt(st.reconMs, 2) + ' ms in your browser']);
        return rows;
    }

    const INFO = {
        console: {
            title: 'Operator console', chain: 'Control room',
            what: 'Where the operator registers the patient, plans the slices on quick localiser images and chooses the protocol: the sequence and its parameters. Before anything runs, the scanner checks the protocol against its hardware limits and predicts the SAR from the patient’s weight.',
            nums: [['Shows', 'protocols, localisers, the finished images']],
            live: liveConsole,
            wrong: 'Most problems that start here are human: the wrong protocol, the wrong slice position, or a wrong patient weight, which makes the SAR prediction wrong.',
            sim: 'The Sequence tab is this console. When a parameter is impossible, for example a TE too short for the gradients to fit, the compiler refuses it and names the minimum, as a scanner console does.',
            links: [{ label: 'Open the Sequence tab', tab: 'sequence', primary: true }, { label: 'Open the Image tab', tab: 'image' }]
        },
        sequencer: {
            title: 'Sequencer (pulse program)', chain: 'Control',
            what: 'A real-time computer that plays the compiled sequence: a timeline of RF pulses, gradient waveforms and ADC windows. It sends the waveforms to the gradient amplifiers and the RF synthesiser and tells the receiver exactly when to sample. The channels must stay in step to well under a microsecond.',
            nums: [['Gradient raster', '10 µs (this simulator, typical of scanners)'], ['RF raster', '1 µs']],
            live: liveSequencer,
            wrong: 'If the channels drift out of step, for example the ADC window opens a little before or after the echo, the echo moves off the centre of k-space. A constant lag between the programmed and the real gradients is the classic case.',
            sim: 'The gradient delay setting in the Artifacts tab (EPI Nyquist ghost) is this kind of timing error.',
            links: [{ label: 'Open the Sequence tab', tab: 'sequence', primary: true }, art('ghost', 'the EPI Nyquist ghost')]
        },
        gradamp: {
            title: 'Gradient amplifier', chain: 'Gradient chain',
            what: 'One power amplifier per axis turns the sequencer’s waveform into coil current. It must deliver hundreds of amperes, switch them in a fraction of a millisecond, and follow the requested waveform to well under one percent, because the current is the spatial encoding.',
            axisNote: {
                x: 'In most presets here x is the readout (frequency-encoding) axis.',
                y: 'In the presets here y is the phase-encoding axis.',
                z: 'z selects the slice: it is on during every slice-selective RF pulse.'
            },
            nums: [['Maximum gradient', '45 mT/m'], ['Slew rate', '200 T/m/s (0 to 45 mT/m in 225 µs)'], ['Output (typical)', 'several hundred amperes, up to about 2000 V']],
            live: liveGrad,
            wrong: 'If the current lags the request (limited amplifier bandwidth, eddy currents), the real k-space trajectory lags the nominal one. Echoes read with alternating gradient polarity, as in EPI, then shift back and forth, giving a ghost displaced by half the field of view (Nyquist ghost).',
            sim: 'EPI Nyquist ghost: add a gradient delay in the Artifacts tab and acquire with the epi preset.',
            links: [art('ghost', 'the EPI Nyquist ghost')]
        },
        gradcoils: {
            title: 'Gradient coils (x, y, z)', chain: 'Gradient chain',
            what: 'Three coil sets wound on a cylinder inside the magnet bore. Each adds a field along z, parallel to B0, whose strength changes linearly with position along x, y or z. A gradient does not tilt B0; it changes its strength from place to place, so the precession frequency marks position.',
            nums: [['Strength', 'up to 45 mT/m per axis'], ['At x = 100 mm and 45 mT/m', 'B rises by 4.5 mT, f by 192 kHz'], ['Acoustic noise', 'often above 100 dB(A); hearing protection is mandatory'], ['What limits switching', 'peripheral nerve stimulation (dB/dt)']],
            wrong: 'Switching induces eddy currents in the surrounding metal, which distort the waveforms (actively shielded coils reduce this). Far from the centre the gradient is no longer linear, which stretches the edges of a large field of view; scanners correct this in reconstruction.',
            sim: 'Delay and eddy-current errors appear as the EPI Nyquist ghost.',
            note: 'Here the gradients are perfectly linear and switch exactly as programmed unless you add a delay; nonlinearity and concomitant fields are not modelled.',
            links: [art('ghost', 'the EPI Nyquist ghost')]
        },
        shim: {
            title: 'Shim coils and shim iron', chain: 'Magnet',
            what: 'The patient’s head distorts B0 by a few ppm. Shimming measures a field map and sets currents in coils whose fields have simple shapes: the linear terms X, Y and Z (usually small offset currents in the gradient coils) and second-order terms such as Z2, XY and X²−Y². Together they cancel the smooth part of the error. Iron pieces placed at installation (passive shims) correct the empty magnet.',
            nums: [['Error before shimming', 'a few ppm over the head (1 ppm = 128 Hz)'], ['Water line after a good shim', 'about 5 to 10 Hz in a small spectroscopy voxel'], ['Terms in this simulator', 'Z0 (centre frequency), X, Y, XY, X²−Y², Z2']],
            wrong: 'A poor shim spreads the frequencies: fat saturation fails at the edges, EPI is distorted, gradient-echo images lose signal and spectral lines broaden. Fields that change over a few millimetres, such as the one next to the air in the frontal sinus, are too local for low-order shims to cancel.',
            sim: 'B0 inhomogeneity and susceptibility in the Artifacts tab, and the Shim panel in the Spectroscopy tab, where you can shim by hand, auto-shim and see what the shims cannot fix.',
            links: [{ label: 'Open the Shim panel', shim: true, primary: true }, art('b0', 'B0 inhomogeneity')]
        },
        magnet: {
            title: 'Superconducting magnet', chain: 'Magnet',
            what: 'Coils of niobium-titanium wire, cooled to 4.2 K in liquid helium so that they have no electrical resistance. Once the current has been ramped up the magnet runs in persistent mode, with no power supply: the field is always on, even when nobody is scanning. Outer shielding coils carry current the opposite way to shrink the stray field.',
            nums: [['B0', '3 T, so f0 = 127.73 MHz'], ['Current (typical)', 'a few hundred amperes, persistent'], ['Stored energy (typical)', 'several megajoules'], ['0.5 mT (5 gauss) line', 'a few metres from the centre'], ['Proton polarisation, 37 °C', 'about 1 in 100 000 (10 ppm)']],
            wrong: 'In a quench part of the wire stops superconducting, the stored energy heats it, and the field decays within about a minute while the helium boils off through the quench pipe. The everyday danger is the field itself: iron objects are pulled in as projectiles, and the field is never switched off.',
            sim: 'B0 is perfect here apart from the susceptibility and shim terms you control (B0 inhomogeneity in the Artifacts tab).',
            links: [art('b0', 'B0 inhomogeneity')]
        },
        cryo: {
            title: 'Liquid helium, cold head and compressor', chain: 'Cryogenics',
            what: 'About 1500 litres of liquid helium keep the coil at 4.2 K. A cold head on top of the cryostat, driven by a water-cooled helium compressor in the equipment room, recondenses the helium that evaporates, so a modern magnet loses almost none. The rhythmic chirp in a quiet magnet room is the cold head.',
            nums: [['Liquid helium (typical)', 'about 1500 L at 4.2 K (−269 °C)'], ['Expansion', '1 L of liquid gives about 750 L of gas'], ['Compressor', 'several kW, water cooled, runs day and night']],
            wrong: 'If the compressor or its cooling water stops, the helium slowly boils off. Left too long, the level falls until the coil is exposed and the magnet quenches, which is why helium level and compressor alarms are watched around the clock. The gas must leave through the quench pipe: released in the room it would displace the oxygen.',
            sim: 'No artifact: a magnet without its helium gives no image at all.',
            note: 'Some newer sealed magnets hold only a few litres of helium; the principle is the same.',
            links: []
        },
        bodycoil: {
            title: 'RF body coil', chain: 'RF transmit chain',
            what: 'A birdcage of copper rungs built into the bore. Driven in quadrature at 127.73 MHz, it makes a field B1 that rotates with the precessing spins and tips the magnetisation. Here it transmits for every scan; when you choose it as the receive coil it also listens, through the T/R switch.',
            nums: [['Frequency', '127.73 MHz'], ['Peak B1 (typical)', 'about 15 to 25 µT'], ['90° in 1 ms, rectangular pulse', 'B1 = 1 / (4 γ̄ · 1 ms) = 5.9 µT'], ['RF wavelength in tissue', 'about 25 to 30 cm']],
            wrong: 'At 3 T the RF wavelength in tissue is close to the size of the head, so B1 is stronger in the centre and weaker at the edges (the dielectric effect). Flip angles are then wrong away from the centre, which shades the image in a way that no receive-coil correction removes. In the abdomen it is worse.',
            sim: 'B1 (dielectric) shading in the Artifacts tab.',
            links: [art('b1', 'B1 shading')]
        },
        headcoil: {
            title: '8-channel receive head coil', chain: 'Receive chain',
            what: 'Eight small receive loops around the head. A small loop close to the tissue collects a strong signal and picks up noise from only a small volume, so SNR near the coil is high, and each element sees mainly the tissue nearest to it. While the body coil transmits, the elements are detuned (by PIN diodes) so that B1 does not drive currents in them.',
            nums: [['Channels', '8 here (clinical head coils have 20, 32 or 64)'], ['Combination', 'Roemer (the default) or root-sum-of-squares, in the Image tab'], ['SNR against the body coil', 'about 1.6× at the centre of the head, about 3× near the cortex'], ['Parallel imaging', 'SENSE with R = 2 or 3, using the coil sensitivities']],
            wrong: 'A root-sum-of-squares image is brighter near the elements than in the centre of the head (coil shading); Roemer combination with the measured sensitivities removes it. A failed element leaves a dark, noisy patch. Accelerating too far with SENSE amplifies noise where the coils cannot separate the folded pixels (g-factor).',
            sim: 'Coil shading, partial Fourier and undersampling with SENSE (Artifacts tab). The coil sensitivity maps are in the Phantom tab.',
            note: 'The simulator knows the true coil sensitivities; a scanner measures them in a short calibration scan.',
            links: [art('coil', 'coil shading'), art('under', 'SENSE'), { label: 'Coil maps in the Phantom tab', tab: 'phantom' }]
        },
        trsw: {
            title: 'T/R switch', chain: 'RF transmit chain',
            what: 'Sends the kilowatt transmit pulses to the body coil and, a few microseconds after each pulse, connects the coil to the receiver instead. During transmission it protects the preamplifiers, which are built to amplify microvolts. It sits in the magnet room, close to the coil.',
            nums: [['Transmit', 'kilowatts'], ['Received echo', 'microvolts'], ['Switching time (typical)', 'a few µs']],
            wrong: 'The receiver cannot record during the pulse and for a short dead time after it (coil ring-down, switching, filter delays). A pulse-acquire FID therefore starts a little late, which shows up in the spectrum as a phase that changes across frequency (first-order phase) and a baseline offset.',
            sim: 'In imaging the switch is ideal. In the Spectroscopy tab the acquisition delay produces exactly that first-order phase.',
            links: [{ label: 'Open the Spectroscopy tab', tab: 'spectro' }]
        },
        preamp: {
            title: 'Preamplifiers', chain: 'Receive chain',
            what: 'One low-noise amplifier per coil element, mounted close to the coil (in the coil housing or the patient table) so that the signal is amplified before cables can add noise. Their low input impedance also reduces the coupling between neighbouring array elements.',
            nums: [['Noise figure (typical)', 'about 0.5 dB'], ['Gain (typical)', 'about 25 to 30 dB'], ['Channels', 'one per coil element']],
            wrong: 'A failing preamplifier lowers the SNR of its channel or makes it oscillate. With good preamplifiers the noise at 3 T comes mainly from the patient’s own tissue, not from the electronics.',
            sim: 'Noise and SNR in the Artifacts tab: the noise level scales every channel together.',
            links: [art('noise', 'noise and SNR')]
        },
        demod: {
            title: 'Demodulator and ADC', chain: 'Receive chain',
            what: 'Mixes the amplified signal with the 127.73 MHz reference from the synthesiser, in two channels 90° apart that give the real and imaginary parts. This removes the carrier and leaves only the small offsets, kilohertz rather than megahertz, that encode position. The ADC samples the result once every dwell time. Modern receivers digitise first and demodulate digitally, with the same result.',
            nums: [['Reference', '127.73 MHz, from the synthesiser']],
            live: liveDemod,
            wrong: 'One corrupted sample (a spike from static discharge or arcing) puts a striped pattern across the whole image, because one point of k-space is one spatial frequency. Interference at one fixed frequency makes a zipper line instead.',
            sim: 'RF spike and zipper in the Artifacts tab.',
            links: [art('spike', 'the RF spike'), art('zipper', 'the zipper')]
        },
        kspace: {
            title: 'Raw data: k-space', chain: 'Receive chain',
            what: 'Each ADC window gives one line of complex samples per coil. The gradients decide where each sample lands, k(t) = γ̄ ∫ G dt, so the sequence chooses the order in which k-space fills. When every line has been measured, k-space holds the Fourier transform of the image.',
            nums: [],
            live: liveKspace,
            wrong: 'Anything that changes between lines (motion, flow, a drifting field) makes the lines inconsistent, which spreads ghosts along the phase-encoding direction.',
            sim: 'Motion and pulsatile flow in the Artifacts tab; watch k-space fill in the k-space tab.',
            links: [{ label: 'Open the k-space tab', tab: 'kspace', primary: true }, art('motion', 'motion')]
        },
        recon: {
            title: 'Reconstruction computer', chain: 'Data',
            what: 'Turns k-space into an image: an inverse 2D Fourier transform for each coil, removal of the readout oversampling, combination of the coil images and, when lines were skipped on purpose, SENSE unfolding with the coil sensitivities. It runs while the scan is still acquiring.',
            nums: [],
            live: liveRecon,
            wrong: 'Reconstruction makes artifacts of its own when its assumptions are wrong: coil sensitivities that do not match the data leave residual folding with SENSE, and filters trade ringing for blur.',
            sim: 'Try the filters, partial Fourier and SENSE options in the Image tab.',
            links: [{ label: 'Open the Image tab', tab: 'image', primary: true }]
        },
        rfsynth: {
            title: 'RF synthesiser and modulator', chain: 'RF transmit chain',
            what: 'Makes the 127.73 MHz carrier from a very stable reference oscillator and shapes it into pulses: the envelope (a sinc for slice selection), the phase, and a small frequency offset that moves the slice, Δf = γ̄ G<sub>z</sub> z<sub>0</sub>. The same reference later demodulates the received signal, so transmit and receive stay in step.',
            nums: [['Carrier', '127.73 MHz'], ['Slice 20 mm off centre at Gz = 10 mT/m', 'Δf = 8.5 kHz'], ['Fat relative to water', '−434 Hz (−3.4 ppm)']],
            wrong: 'If the transmitter is set off resonance the slice moves and spectrally selective pulses miss: fat saturation starts to saturate water instead. Phase that jitters from pulse to pulse produces ghosts.',
            sim: 'The Z0 term in the Shim panel is the centre-frequency setting; the chemical shift and fat suppression cards in the Artifacts tab show what a frequency error does.',
            links: [{ label: 'Open the Shim panel', shim: true }, art('chem', 'chemical shift')]
        },
        rfamp: {
            title: 'RF power amplifier', chain: 'RF transmit chain',
            what: 'Boosts the shaped pulses from milliwatts to kilowatts. The energy of a pulse grows with the square of B1, so doubling the flip angle in the same time quadruples it, and for the same pulse the tissue heating (SAR) at 3 T is about four times that at 1.5 T.',
            nums: [['Peak power (typical)', 'about 30 to 35 kW'], ['SAR limits, normal mode', '2 W/kg whole body, 3.2 W/kg head']],
            live: liveRfAmp,
            wrong: 'If the amplifier cannot deliver the requested power, every flip angle is too small: contrast changes and SNR falls. At 3 T many turbo spin echo protocols are limited by SAR rather than by the amplifier, so they need a longer TR, lower refocusing flip angles or fewer slices.',
            sim: 'Flip-angle errors appear as B1 (dielectric) shading in the Artifacts tab.',
            note: 'SAR is not modelled in this simulator.',
            links: [art('b1', 'B1 shading')]
        },
        patient: {
            title: 'The patient’s protons (spins)', chain: 'Signal source',
            what: 'Hydrogen nuclei in water and fat. In B0 a tiny excess of them, about 1 in 100 000 at 3 T, lines up with the field and gives a net magnetisation M0. Once tipped by B1, M0 precesses at 127.73 MHz and, by Faraday’s law, induces the MR signal in the receive coil. Relaxation (T1, T2) and proton density decide how much signal each tissue gives.',
            nums: [['Polarisation, 3 T, 37 °C', 'about 1 × 10⁻⁵'], ['Water protons', 'about 110 mol/L in pure water'], ['Fat frequency', '3.4 ppm (434 Hz) below water']],
            wrong: 'The patient is the most common source of artifacts: motion, breathing and swallowing, pulsatile flow, and the susceptibility differences between tissue, bone and air.',
            sim: 'Motion, flow and susceptibility in the Artifacts tab; the tissues and their T1, T2 and PD are in the Phantom tab.',
            note: 'The simulated object is one 2D slice; effects across the slice thickness are approximated.',
            links: [{ label: 'Open the Phantom tab', tab: 'phantom', primary: true }, art('motion', 'motion')]
        },
        liner: {
            title: 'Bore and bore liner', chain: 'Magnet',
            what: 'The 60 cm patient bore (70 cm on wide-bore systems). The liner is a plastic tube that covers the coils, damps some of the acoustic noise and keeps the patient a few centimetres from the body coil, where the local RF fields are strongest.',
            nums: [['Bore diameter', '60 cm (70 cm wide bore)'], ['Sound level inside', 'often above 100 dB(A)']],
            wrong: 'Here the risk is to the patient rather than to the image: skin touching the bore, or a loop formed by crossed arms or a cable, can concentrate RF currents and cause burns. Patients are padded and cables are kept straight and away from the skin.',
            sim: 'No artifact in this simulator.',
            links: []
        },
        cage: {
            title: 'Faraday cage and penetration panel', chain: 'RF shielding',
            what: 'The magnet room is lined with copper (or steel) sheet, a Faraday cage that keeps out broadcast radio, phones and electronic noise, because the receiver is listening for microvolt signals at 127.73 MHz. Every cable enters through a filter in the penetration panel; gases and optical fibres pass through waveguides.',
            nums: [['Shielding (typical)', 'about 100 dB at 128 MHz'], ['Door', 'part of the shield: it must be closed to scan']],
            wrong: 'A leak (a door not quite closed, a broken filter, an unfiltered device in the room) lets interference at one fixed frequency into every readout. It appears as a bright zipper line across the image along the phase-encoding direction, at the position that matches its frequency.',
            sim: 'Zipper in the Artifacts tab.',
            links: [art('zipper', 'the zipper')]
        }
    };

    /* The "follow the signal" walk. comps light up, wires animate. */
    function steps() {
        const body = S().coilType === 'body';
        return [
            { title: 'Protocol', comps: ['console'], wires: ['w-console-seq'],
                text: 'At the console the operator chooses a sequence and its parameters (TR, TE, field of view, matrix). The scanner checks them against its hardware and SAR limits and sends the compiled program to the sequencer.' },
            { title: 'Pulse program', comps: ['sequencer'], wires: ['w-seq-gx', 'w-seq-gy', 'w-seq-gz', 'w-seq-synth'],
                text: 'The sequencer plays the program in real time: gradient waveforms to the three gradient amplifiers, pulse shapes to the RF synthesiser, and the moments when the receiver must sample.' },
            { title: 'An RF pulse at 127.73 MHz', comps: ['rfsynth'], wires: ['w-synth-rfamp'],
                text: 'The synthesiser makes the 127.73 MHz carrier and shapes it into a pulse. A small frequency offset decides where the slice will be.' },
            { title: 'Power and switching', comps: ['rfamp', 'trsw', 'cage'], wires: ['w-rfamp-trsw'],
                text: 'The RF amplifier raises the pulse to kilowatts. The cable passes a filter in the penetration panel, and the T/R switch routes the power to the body coil.' },
            { title: 'B1 tips the spins', comps: ['bodycoil', 'patient'], wires: ['w-trsw-body'],
                text: 'The body coil turns the pulse into a field B1 that rotates at 127.73 MHz. Spins precessing at that frequency are tipped away from B0; spins at other frequencies are left alone.' },
            { title: 'Gradients encode position', comps: ['gradamp-x', 'gradamp-y', 'gradamp-z', 'gradcoils'], wires: ['w-gx-coil', 'w-gy-coil', 'w-gz-coil'],
                text: 'During the pulse Gz makes the frequency depend on z, so only one slice is on resonance. Afterwards Gy (phase encoding) and Gx (readout) make phase and frequency depend on position within the slice.' },
            { title: 'The spins answer', comps: ['patient'], wires: [],
                text: 'The tipped magnetisation precesses and induces a voltage of only microvolts in nearby coils (Faraday’s law). Its frequencies carry the position, its amplitude the tissue contrast.' },
            body
                ? { title: 'Receive coil', comps: ['bodycoil', 'trsw'], wires: ['w-trsw-body', 'w-trsw-pre'],
                    text: 'The body coil, switched to receive by the T/R switch, picks up the signal from the whole slice. (Choose the 8-channel head coil above to see the array instead.)' }
                : { title: 'Receive coil', comps: ['headcoil'], wires: ['w-head-pre'],
                    text: 'Each of the eight head-coil elements picks up the signal from the tissue nearest to it, so each channel carries its own view of the slice.' },
            { title: 'Preamplifiers', comps: ['preamp', 'cage'], wires: ['w-pre-demod'],
                text: 'Low-noise preamplifiers next to the coil boost the microvolt signal before cables can add noise. Then it leaves the Faraday cage through a filter.' },
            { title: 'Demodulation and sampling', comps: ['demod', 'rfsynth'], wires: ['w-synth-demod', 'w-demod-k'],
                text: 'The demodulator mixes the signal with the same 127.73 MHz reference, leaving only the kilohertz offsets that encode position, and the ADC samples it once every dwell time.' },
            { title: 'k-space', comps: ['kspace'], wires: ['w-k-recon'],
                text: 'Each readout fills one line of k-space. The gradients played before it decide which line, so the sequence decides the order in which k-space fills.' },
            { title: 'The image', comps: ['recon', 'console'], wires: ['w-recon-console'],
                text: 'The reconstruction computer inverse-Fourier-transforms k-space, combines the coils and sends the image back to the console.' }
        ];
    }
    const N_STEPS = 12;

    /* ============================================================
       SVG building blocks (strings)
       ============================================================ */
    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function r1(v) { return Math.round(v * 10) / 10; }
    function at(a) {
        let s = '';
        for (const k in a) {
            if (!Object.prototype.hasOwnProperty.call(a, k)) continue;
            const v = a[k];
            if (v === undefined || v === null || v === false) continue;
            s += ' ' + k + '="' + esc(v === true ? '' : (typeof v === 'number' ? r1(v) : v)) + '"';
        }
        return s;
    }
    function tag(name, a, inner) { return '<' + name + at(a || {}) + (inner === undefined ? '/>' : '>' + inner + '</' + name + '>'); }
    function rect(x, y, w, h, cls, extra) { return tag('rect', Object.assign({ x: x, y: y, width: w, height: h, class: cls }, extra || {})); }
    function path(d, cls, extra) { return tag('path', Object.assign({ d: d, class: cls }, extra || {})); }
    function text(x, y, str, cls, extra) { return tag('text', Object.assign({ x: x, y: y, class: cls }, extra || {}), str); }
    function poly(pts) { return pts.map(function (p, i) { return (i ? 'L' : 'M') + r1(p[0]) + ',' + r1(p[1]); }).join(' '); }
    function textWidth(str, size, bold) { return String(str).replace(/<[^>]+>/g, '').length * size * (bold ? 0.6 : 0.54); }

    /* A component group. Only the primary group of a component is
       focusable; secondary groups (labels, parts drawn elsewhere) share
       its data-c so hover and click work on them too. */
    function comp(id, inner, opts) {
        opts = opts || {};
        const c = COMP_BY_ID[id];
        const a = { class: 'sc-c' + (opts.cls ? ' ' + opts.cls : ''), 'data-c': id };
        if (opts.primary !== false) {
            a['data-primary'] = '1';
            a.tabindex = '-1';
            a.role = 'button';
            a['aria-label'] = (c ? c.name : id) + ': show details';
            a['aria-controls'] = 'scnr-info';
            a['aria-expanded'] = 'false';
        }
        return tag('g', a, inner);
    }

    /* ---------- icons (16 x 16, drawn at x, y) ---------- */
    function icon(kind, x, y, chain) {
        const t = 'translate(' + r1(x) + ',' + r1(y) + ')';
        const c = 'ic c-' + chain;
        let d = '';
        switch (kind) {
            case 'monitor': return tag('g', { transform: t }, path('M1,2 h14 v9 h-14 z M6,14 h4 M8,11 v3', c));
            case 'chip': return tag('g', { transform: t }, path('M1,4 h3 l1.5,-3 l1.5,6 l1.5,-6 l1.5,3 h6 M1,9 h4 v3 h4 v-3 h6 M1,14 h7 v-1.5 h3 v1.5 h4', c));
            case 'amp': return tag('g', { transform: t }, path('M3,2 L14,8 L3,14 Z M0,8 h3 M14,8 h2', c));
            case 'sine': d = 'M0,8'; for (let i = 0; i <= 16; i++) d += ' L' + i + ',' + r1(8 - 5.5 * Math.sin(i / 16 * 4 * Math.PI)); return tag('g', { transform: t }, path(d, c));
            case 'switch': return tag('g', { transform: t }, path('M0,8 h4 M4,8 L12,3 M12,3 h4 M12,13 h4 M4,8 m-1.2,0 a1.2,1.2 0 1,0 2.4,0 a1.2,1.2 0 1,0 -2.4,0', c));
            case 'mixer': return tag('g', { transform: t }, path('M8,8 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M4,4 L12,12 M12,4 L4,12', c));
            case 'grid': return tag('g', { transform: t }, path('M1,1 h14 v14 h-14 z M1,5.7 h14 M1,10.3 h14 M5.7,1 v14 M10.3,1 v14', c));
            case 'fft': return tag('g', { transform: t }, path('M1,1 h14 v14 h-14 z M4,11 c2,-8 6,-8 8,0', c));
            case 'snow': return tag('g', { transform: t }, path('M8,1 v14 M2,4.5 L14,11.5 M2,11.5 L14,4.5 M6,2.5 L8,4 L10,2.5 M6,13.5 L8,12 L10,13.5', c));
            case 'pre': return tag('g', { transform: t }, path('M4,3 L13,8 L4,13 Z M0,8 h4 M13,8 h3', c));
            default: return '';
        }
    }

    /* ---------- equipment box ---------- */
    const BOXES = {
        console: { title: 'Operator console', sub: 'protocol and images', icon: 'monitor', chain: 'ctl' },
        sequencer: { title: 'Sequencer', sub: 'plays the pulse program: RF, gradients, ADC', icon: 'chip', chain: 'ctl', cls: 'k-seq' },
        rfsynth: { title: 'RF synthesiser', sub: '127.73 MHz carrier', icon: 'sine', chain: 'rf', lv: 'lv-rf' },
        rfamp: { title: 'RF power amp', sub: 'about 35 kW peak', icon: 'amp', chain: 'rf', lv: 'lv-rf' },
        trsw: { title: 'T/R switch', sub: 'transmit or receive', icon: 'switch', chain: 'rf', lv: 'lv-rf lv-rxbody' },
        preamp: { title: 'Preamplifiers', sub: 'low noise, at the coil', icon: 'pre', chain: 'rx', lv: 'lv-rx' },
        demod: { title: 'Demodulator, ADC', sub: 'remove f0, sample', icon: 'mixer', chain: 'rx', lv: 'lv-rx' },
        kspace: { title: 'k-space', sub: 'raw data, one line per readout', icon: 'grid', chain: 'rx', lv: 'lv-rx' },
        recon: { title: 'Reconstruction', sub: 'inverse FFT, coil combination', icon: 'fft', chain: 'ctl' },
        compressor: { title: 'Compressor', sub: 'helium, drives the cold head', icon: 'snow', chain: 'he' }
    };
    const CHAIN_VAR = { rf: '--seq-rf', rx: '--seq-adc', ctl: '--sc-ctl', he: '--sc-he', gx: '--seq-gx', gy: '--seq-gy', gz: '--seq-gz' };

    function box(id, g) {
        const b = BOXES[id];
        const x = g.x, y = g.y, w = g.w, h = g.h;
        let inner = '';
        inner += rect(x - 3, y - 3, w + 6, h + 6, 'halo c-' + b.chain, { rx: 9, style: 'fill:none' });
        inner += rect(x, y, w, h, 'bx', { rx: 7 });
        inner += rect(x, y + 6, 3, h - 12, 'bx-tag c-' + b.chain, { rx: 1.5 });
        const compact = g.compact || w < 112;
        const ix = x + 10;
        const tx = compact ? x + 10 : x + 32;
        if (!compact && id !== 'console') inner += icon(b.icon, ix, y + (h - 16) / 2, b.chain);
        const sub = g.sub !== undefined ? g.sub : b.sub;
        const title = g.title || b.title;
        if (id === 'console' && w > 2.5 * h) {
            // wide and short: monitor on the left, text beside it
            const mh = h - 22, mw = mh / 0.62;
            const mx = x + 18, my = y + 8;
            inner += rect(mx, my, mw, mh, 'monitor', { rx: 3 });
            inner += tag('ellipse', { cx: mx + mw / 2, cy: my + mh / 2, rx: mh * 0.3, ry: mh * 0.37, style: 'fill:#9aa3ad' });
            inner += tag('ellipse', { cx: mx + mw / 2, cy: my + mh / 2, rx: mh * 0.22, ry: mh * 0.29, style: 'fill:#c9ced4' });
            inner += path('M' + r1(mx + mw / 2 - 6) + ',' + r1(my + mh + 6) + ' h12 M' + r1(mx + mw / 2) + ',' + r1(my + mh) + ' v6', 'ic c-ctl');
            inner += text(mx + mw + 16, y + h / 2 - 2, title, 'bx-t');
            inner += text(mx + mw + 16, y + h / 2 + 12, sub, 'bx-s');
        } else if (id === 'console') {
            // a small monitor with an image on it, then the text
            const mw = Math.min(70, w - 24), mh = mw * 0.62;
            const mx = x + (w - mw) / 2, my = y + 10;
            inner += rect(mx, my, mw, mh, 'monitor', { rx: 3 });
            inner += tag('ellipse', { cx: mx + mw / 2, cy: my + mh / 2, rx: mh * 0.3, ry: mh * 0.37, style: 'fill:#9aa3ad' });
            inner += tag('ellipse', { cx: mx + mw / 2, cy: my + mh / 2, rx: mh * 0.22, ry: mh * 0.29, style: 'fill:#c9ced4' });
            inner += path('M' + r1(mx + mw / 2 - 6) + ',' + r1(my + mh + 6) + ' h12 M' + r1(mx + mw / 2) + ',' + r1(my + mh) + ' v6', 'ic c-ctl');
            inner += text(x + w / 2, my + mh + 22, title, 'bx-t', { 'text-anchor': 'middle' });
            inner += text(x + w / 2, my + mh + 35, sub, 'bx-s', { 'text-anchor': 'middle' });
        } else {
            inner += text(tx, y + (sub ? h / 2 - 2 : h / 2 + 4), title, 'bx-t');
            if (sub) inner += text(tx, y + h / 2 + 11, sub, 'bx-s');
        }
        inner += rect(x - 4, y - 4, w + 8, h + 8, 'ring', { rx: 10 });
        return comp(id, inner, { cls: 'sc-box ' + (b.lv || '') + ' ' + (b.cls || '') + (g.cls ? ' ' + g.cls : '') });
    }

    /* Gradient amplifier: title, a signed level bar (centre = 0, ends =
       +/- Gmax) and the value in mT/m. */
    function gradAmp(axis, g) {
        const x = g.x, y = g.y, w = g.w, h = g.h;
        const chain = 'g' + axis;
        let inner = '';
        inner += rect(x - 3, y - 3, w + 6, h + 6, 'halo c-' + chain, { rx: 9, style: 'fill:none' });
        inner += rect(x, y, w, h, 'bx', { rx: 7 });
        inner += rect(x, y + 6, 3, h - 12, 'bx-tag c-' + chain, { rx: 1.5 });
        const narrow = w < 70;
        inner += text(x + w / 2, y + 15, (narrow ? 'G' : 'Gradient ') + '<tspan class="t-' + chain + '">' + axis + '</tspan>', 'bx-t', { 'text-anchor': 'middle' });
        const bw = w - 18, bx = x + 9, by = y + 21, bh = 7;
        inner += rect(bx, by, bw, bh, 'lvl-track', { rx: 2 });
        inner += rect(bx + bw / 2, by, 0, bh, 'lvl lvl-' + axis, { 'data-axis': axis, 'data-cx': r1(bx + bw / 2), 'data-half': r1(bw / 2) });
        inner += tag('line', { x1: bx + bw / 2, y1: by - 2, x2: bx + bw / 2, y2: by + bh + 2, class: 'lvl-mid' });
        if (narrow) {
            inner += text(x + w / 2, y + 40, '0.0', 'bx-v', { 'text-anchor': 'middle', 'data-gval': axis, 'data-unit': '0' });
            inner += text(x + w / 2, y + 50, 'mT/m', 'bx-s', { 'text-anchor': 'middle', style: 'font-size:9px' });
        } else {
            inner += text(x + w / 2, y + h - 6, '0 mT/m', 'bx-v', { 'text-anchor': 'middle', 'data-gval': axis, 'data-unit': '1' });
        }
        inner += rect(x - 4, y - 4, w + 8, h + 8, 'ring', { rx: 10 });
        return comp('gradamp-' + axis, inner, { cls: 'sc-box lv-' + chain });
    }

    /* ---------- wires ---------- */
    function markers() {
        let s = '';
        ['rf', 'gx', 'gy', 'gz', 'rx', 'ctl', 'he'].forEach(function (k) {
            s += tag('marker', { id: P_ + '-mk-' + k, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' },
                path('M0,1 L10,5 L0,9 z', 'mk c-' + k));
        });
        return s;
    }
    function wire(wd) {
        const chain = wd.chain;
        const a = { d: poly(wd.pts), class: 'wire c-' + chain + (wd.dash ? ' dash' : ''), style: 'fill:none' };
        if (wd.end !== false) a['marker-end'] = 'url(#' + P_ + '-mk-' + chain + ')';
        if (wd.start) a['marker-start'] = 'url(#' + P_ + '-mk-' + chain + ')';
        let inner = tag('path', a);
        if (wd.label) {
            inner += text(wd.label[0], wd.label[1], wd.label[2], 'wlabel' + (wd.label[4] ? ' ' + wd.label[4] : ''), { 'text-anchor': wd.label[3] || 'middle' });
        }
        return tag('g', { class: 'wgrp ' + (wd.lv || '') + (wd.cls ? ' ' + wd.cls : ''), 'data-w': wd.id }, inner);
    }
    function heLine(pts) {
        const d = poly(pts);
        return tag('g', { class: 'wgrp', 'data-w': 'w-he' }, path(d, 'w-he-out') + path(d, 'w-he-in'));
    }

    /* ---------- the magnet, in local units ----------
       Local frame: z along the bore (right), y down, origin at the
       isocentre. Radii are exaggerated for the thin inner layers (1 unit
       is about 6 mm for the bore, less outside) so every layer can be
       seen and clicked; the caption says it is not to scale. */
    const MG = {
        zc: 160, rOut: 178,                   // covers
        ovc: { z: 150, r0: 94, r1: 170 },       // outer vacuum chamber
        he: { z: 140, r0: 100, r1: 163 },       // helium vessel
        level: 154,                            // liquid level (radius) in the upper half
        main: [[-118, 30], [-68, 24], [-22, 20], [22, 20], [68, 24], [118, 30]], mainR: [107, 123],
        shieldC: [[-105, 34], [105, 34]], shieldR: [145, 158],
        shim: { z: 128, r0: 87, r1: 93 },
        grad: { z: 128, z0: 66, y0: 73, x0: 80, x1: 87 },  // stripes, from the axis out: z, y, x
        rf: { z: 62, r0: 55, r1: 64, ring: 6 },
        liner: { r0: 50, r1: 55 },
        cold: { z: 70 }
    };
    function bands(z0, z1, r0, r1, cls, extra) {
        return rect(z0, -r1, z1 - z0, r1 - r0, cls, extra) + rect(z0, r0, z1 - z0, r1 - r0, cls, extra);
    }
    function magnetSvg(m) {
        const tr = 'translate(' + r1(m.X0) + ',' + r1(m.Y0) + ') scale(' + m.s + ')';
        let s = '';
        // 1. covers, vacuum vessel, thermal shield (magnet)
        let mag1 = '';
        mag1 += rect(-MG.zc, -MG.rOut, 2 * MG.zc, MG.rOut - MG.liner.r0, 'm-cover sh', { rx: 16 });
        mag1 += rect(-MG.zc, MG.liner.r0, 2 * MG.zc, MG.rOut - MG.liner.r0, 'm-cover sh', { rx: 16 });
        mag1 += bands(-MG.ovc.z, MG.ovc.z, MG.ovc.r0, MG.ovc.r1, 'm-ovc sh', { rx: 6 });
        mag1 += bands(-MG.ovc.z + 4, MG.ovc.z - 4, MG.ovc.r0 + 3, MG.ovc.r1 - 3, 'm-shield', { rx: 4 });
        s += comp('magnet', mag1);
        // 2. helium vessel with liquid (cryo), the cold head turret
        let cryo = '';
        cryo += bands(-MG.he.z, MG.he.z, MG.he.r0, MG.he.r1, 'm-he sh', { rx: 5 });
        cryo += rect(-MG.he.z + 1, -MG.he.r1 + 1, 2 * MG.he.z - 2, MG.he.r1 - MG.level - 1, 'm-gas', { rx: 4 });
        cryo += tag('line', { x1: -MG.he.z + 3, y1: -MG.level, x2: MG.he.z - 3, y2: -MG.level, class: 'm-level' });
        const cz = MG.cold.z;
        cryo += rect(cz - 4, -MG.he.r1 - 8, 8, 12, 'm-cold');
        cryo += rect(cz - 12, -MG.rOut - 34, 24, 34, 'm-cold sh', { rx: 2 });
        cryo += rect(cz - 16, -MG.rOut - 42, 32, 9, 'm-cold sh', { rx: 2 });
        s += comp('cryo', cryo);
        // 3. main and shielding coils (magnet)
        let mag2 = '';
        MG.main.forEach(function (c) { mag2 += bands(c[0] - c[1] / 2, c[0] + c[1] / 2, MG.mainR[0], MG.mainR[1], 'm-coil sh', { rx: 1.5 }); });
        MG.shieldC.forEach(function (c) { mag2 += bands(c[0] - c[1] / 2, c[0] + c[1] / 2, MG.shieldR[0], MG.shieldR[1], 'm-coil2 sh', { rx: 1.5 }); });
        s += comp('magnet', mag2, { primary: false });
        // 4. shims
        let shim = bands(-MG.shim.z, MG.shim.z, MG.shim.r0, MG.shim.r1, 'm-shim sh');
        for (let z = -MG.shim.z + 10; z < MG.shim.z - 4; z += 22) {
            shim += rect(z, -MG.shim.r1 + 1.5, 7, 3, 'm-iron') + rect(z, MG.shim.r0 + 1.5, 7, 3, 'm-iron');
        }
        s += comp('shim', shim);
        // 5. gradient coils: three stripes, z innermost (each glows on its own)
        const gg = MG.grad;
        let grad = '';
        grad += tag('g', { class: 'lv-gz' }, bands(-gg.z, gg.z, gg.z0, gg.y0, 'm-gz sh'));
        grad += tag('g', { class: 'lv-gy' }, bands(-gg.z, gg.z, gg.y0, gg.x0, 'm-gy sh'));
        grad += tag('g', { class: 'lv-gx' }, bands(-gg.z, gg.z, gg.x0, gg.x1, 'm-gx sh'));
        s += comp('gradcoils', grad);
        // 6. RF body coil: band, end rings, rungs
        const rf = MG.rf;
        let body = bands(-rf.z, rf.z, rf.r0, rf.r1, 'm-rf sh');
        body += bands(-rf.z, -rf.z + rf.ring, rf.r0, rf.r1, 'm-rfring') + bands(rf.z - rf.ring, rf.z, rf.r0, rf.r1, 'm-rfring');
        [57.5, 59.5, 61.5].forEach(function (r) {
            body += tag('line', { x1: -rf.z + rf.ring, y1: -r, x2: rf.z - rf.ring, y2: -r, class: 'm-rung' });
            body += tag('line', { x1: -rf.z + rf.ring, y1: r, x2: rf.z - rf.ring, y2: r, class: 'm-rung' });
        });
        s += comp('bodycoil', body, { cls: 'lv-rf lv-rxbody' });
        // 7. bore liner, and the far wall of the bore seen through the cut
        s += comp('liner', rect(-MG.zc, -MG.liner.r0, 2 * MG.zc, 2 * MG.liner.r0, 'm-bore') + bands(-MG.zc, MG.zc, MG.liner.r0, MG.liner.r1, 'm-liner sh'));
        // 8. table (not a component)
        s += rect(-310, 25, 370, 6, 'm-table', { rx: 2 });
        s += path('M-282,31 L-250,31 L-255,180 L-277,180 Z', 'm-table');
        s += rect(-298, 178, 64, 6, 'm-table', { rx: 2 });
        // 9. patient: gown (body), skin (head, neck, feet), brain, slice
        let pt = '';
        pt += rect(-28, -7, 18, 21, 'm-skin sh', { rx: 4 });
        pt += path('M-22,-8 C-28,-13 -34,-17 -42,-19 C-60,-22 -86,-21 -100,-17 C-112,-14 -122,-15 -134,-15 ' +
            'C-160,-15 -180,-12 -196,-10 C-205,-9 -212,-11 -220,-10 C-235,-8 -248,-6 -258,-5 L-258,25 L-22,25 Z', 'm-gown sh');
        pt += path('M-258,-5 L-262,-7 L-269,-18 C-273,-21 -278,-19 -277,-15 L-275,25 L-258,25 Z', 'm-skin sh');
        pt += tag('ellipse', { cx: 1, cy: -1, rx: 19.5, ry: 16.5, class: 'm-skin sh' });
        pt += path('M-11,-16 C-12,-22 -8,-24 -5,-22 L-3,-17', 'm-skin sh');
        pt += tag('ellipse', { cx: 4, cy: -2, rx: 13, ry: 11, class: 'm-brain' });
        pt += rect(-1, -15, 2.4, 29, 'm-slice lv-gz');
        s += comp('patient', pt);
        // 10. head coil (receive), shown only with the head array
        let hc = '';
        hc += path('M-14,-25 L14,-25 Q30,-25 30,-9 L30,9 Q30,25 14,25 L-14,25 L-14,21 L13,21 Q26,21 26,9 L26,-9 Q26,-21 13,-21 L-14,-21 Z', 'm-hcoil sh');
        [[-6, -23], [8, -23], [-6, 23], [8, 23], [28, 0]].forEach(function (p) {
            hc += tag('ellipse', { cx: p[0], cy: p[1], rx: p[0] === 28 ? 2.4 : 5, ry: p[0] === 28 ? 6 : 2.4, class: 'm-hloop' });
        });
        s += comp('headcoil', hc, { cls: 'lv-rx only-head8' });
        // 11. B0 along the bore (belongs to the magnet)
        let b0 = path('M-150,-37 L142,-37', 'm-b0') + path('M152,-37 L139,-43 L139,-31 Z', 'm-b0head');
        s += comp('magnet', b0, { primary: false });
        return tag('g', { class: 'mg', transform: tr }, s);
    }
    function mapper(m) { return function (z, y) { return [m.X0 + m.s * z, m.Y0 + m.s * y]; }; }

    /* Leader labels for the magnet layers. */
    function labelSvg(lb, P, cot) {
        const a = P(lb.at[0], lb.at[1]);
        const x = lb.x, y = lb.y, anchor = lb.anchor || 'end';
        const w = textWidth(lb.text, 11);
        const tx0 = anchor === 'end' ? x - w : x;
        let inner = rect(tx0 - 3, y - 11, w + 6, 15, 'hitbox');
        inner += text(x, y, lb.html || esc(lb.text), 't-lab lab', { 'text-anchor': anchor });
        const sx = anchor === 'end' ? x + 4 : x - 4;
        const ly = y - 4;
        // With a common slope (cot), parallel diagonals cannot cross when
        // anchor.x - anchor.y * cot decreases down the label column.
        let bend = lb.bend;
        if (bend === undefined) bend = cot ? Math.max(sx + 4, a[0] - (a[1] - ly) * cot) : (anchor === 'end' ? a[0] - 10 : a[0] + 10);
        inner += path(poly([[sx, ly], [bend, ly], a]), 'leader');
        inner += tag('circle', { cx: a[0], cy: a[1], r: 2, class: 'leader-dot' });
        return comp(lb.comp, inner, { primary: false });
    }

    /* End-on view of the bore at the isocentre, seen from the feet like an
       axial image: patient's right on the left, anterior up. Shows the
       eight head-coil elements where fields.js puts them. */
    function insetSvg(L) {
        const f = L.inset;
        const cx = f.x + f.w / 2 + (f.dx || 0), cy = f.y + f.h / 2 + (f.dy || 0), k = f.k;   // k: units per mm
        const clip = P_ + '-inclip';
        let s = '';
        s += tag('clipPath', { id: clip }, rect(f.x, f.y, f.w, f.h, '', { rx: 8 }));
        s += rect(f.x, f.y, f.w, f.h, 'in-frame', { rx: 8 });
        let g = '';
        g += tag('circle', { cx: cx, cy: cy, r: 600 * k, class: 'in-cryo' });
        g += comp('shim', tag('circle', { cx: cx, cy: cy, r: 462 * k, class: 'sh', style: 'fill:none;stroke:var(--sc-shim);stroke-width:' + r1(12 * k) }), { primary: false });
        let gr = '';
        gr += tag('circle', { cx: cx, cy: cy, r: 445 * k, class: 'm-gx lv-gx', style: 'fill:none;stroke-width:' + r1(20 * k) });
        gr += tag('circle', { cx: cx, cy: cy, r: 420 * k, class: 'm-gy lv-gy', style: 'fill:none;stroke-width:' + r1(20 * k) });
        gr += tag('circle', { cx: cx, cy: cy, r: 395 * k, class: 'm-gz lv-gz', style: 'fill:none;stroke-width:' + r1(20 * k) });
        g += comp('gradcoils', gr, { primary: false });
        let bc = tag('circle', { cx: cx, cy: cy, r: 340 * k, class: 'in-body', style: 'fill:none;stroke:var(--seq-rf);stroke-width:' + r1(18 * k) + ';stroke-opacity:0.35' });
        for (let i = 0; i < 16; i++) {
            const ph = (i + 0.5) * Math.PI / 8;
            bc += tag('circle', { cx: cx + 340 * k * Math.cos(ph), cy: cy + 340 * k * Math.sin(ph), r: 1.8, class: 'in-rung' });
        }
        g += comp('bodycoil', bc, { primary: false, cls: 'lv-rf lv-rxbody' });
        g += comp('liner', tag('circle', { cx: cx, cy: cy, r: 312 * k, class: 'sh', style: 'fill:var(--sc-room);stroke:var(--sc-cover-line);stroke-width:' + r1(20 * k) }), { primary: false });
        // table, head, brain
        const ty = cy + 150 * k;
        const half = Math.sqrt(Math.max(0, 300 * 300 - 150 * 150)) * k;
        g += rect(cx - half, ty, 2 * half, 22 * k, 'm-table', { rx: 2 });
        let pt = tag('ellipse', { cx: cx, cy: cy, rx: 80 * k, ry: 100 * k, class: 'm-skin sh' });
        pt += tag('ellipse', { cx: cx, cy: cy + 3 * k, rx: 66 * k, ry: 84 * k, class: 'm-brain' });
        g += comp('patient', pt, { primary: false });
        // head coil elements: element k at angle -90 + 22.5 + 45 k degrees on a 105 x 125 mm ellipse
        let hc = '';
        for (let i = 0; i < 8; i++) {
            const ph = -Math.PI / 2 + Math.PI / 8 + i * Math.PI / 4;
            const pts = [];
            for (let j = -4; j <= 4; j++) {
                const q = ph + j * 0.06;
                pts.push([cx + 112 * k * Math.cos(q), cy + 133 * k * Math.sin(q)]);
            }
            hc += path(poly(pts), 'in-elem');
        }
        g += comp('headcoil', hc, { primary: false, cls: 'lv-rx only-head8' });
        // orientation letters and axes
        g += text(cx - 104 * k - 5, cy + 4, 'R', 't-tiny', { 'text-anchor': 'end' });
        g += text(cx + 104 * k + 5, cy + 4, 'L', 't-tiny');
        s += tag('g', { 'clip-path': 'url(#' + clip + ')' }, g);
        // title and axes on top of the clip
        const tw = textWidth(f.title, 10, true) + 10;
        s += rect(f.x + 5, f.y + 5, tw, 15, 'in-titlebg', { rx: 4 });
        s += text(f.x + 10, f.y + 16, f.title, 'in-title');
        [['8 receive elements', 't-rx only-head8'], ['body coil receives', 't-rf only-body']].forEach(function (c) {
            const cw = textWidth(c[0], 10, true) + 8;
            s += rect(f.x + f.w - 5 - cw, f.y + f.h - 20, cw, 15, 'in-titlebg ' + c[1].split(' ')[1], { rx: 4 });
            s += text(f.x + f.w - 9, f.y + f.h - 9, c[0], 't-small ' + c[1], { 'text-anchor': 'end' });
        });
        const ax = f.x + 14, ay = f.y + f.h - 30;
        s += path(poly([[ax, ay], [ax + 24, ay]]), 'wire c-ctl', { 'marker-end': 'url(#' + P_ + '-mk-ctl)', style: 'fill:none;stroke-width:1.4' });
        s += path(poly([[ax, ay], [ax, ay + 20]]), 'wire c-ctl', { 'marker-end': 'url(#' + P_ + '-mk-ctl)', style: 'fill:none;stroke-width:1.4' });
        s += text(ax + 28, ay + 4, 'x', 't-axis');
        s += text(ax + 6, ay + 24, 'y', 't-axis');
        return s;
    }

    /* Axes for the side view: z along B0, y down (posterior), x toward
       the viewer (the patient's left). Right-handed: x = y cross z. */
    function triadSvg(t) {
        const x = t.x, y = t.y, L = t.len || 46;
        let s = '';
        const st = 'fill:none;stroke-width:1.6';
        s += path(poly([[x, y], [x + L, y]]), 'wire c-ctl', { 'marker-end': 'url(#' + P_ + '-mk-ctl)', style: st });
        s += path(poly([[x, y], [x, y + L * 0.8]]), 'wire c-ctl', { 'marker-end': 'url(#' + P_ + '-mk-ctl)', style: st });
        s += tag('circle', { cx: x, cy: y, r: 6, style: 'fill:var(--card);stroke:var(--sc-ctl);stroke-width:1.6' });
        s += tag('circle', { cx: x, cy: y, r: 1.8, style: 'fill:var(--sc-ctl)' });
        s += text(x + L + 6, y + 4, 'z', 't-axis');
        s += text(x + L + 16, y + 4, '(along B0)', 't-small');
        s += text(x + 6, y + L * 0.8 + 9, 'y', 't-axis');
        s += text(x + 15, y + L * 0.8 + 9, '(down)', 't-small');
        s += text(x - 6, y - 12, '<tspan class="t-axis">x</tspan><tspan class="t-small"> (toward you)</tspan>', '', { 'text-anchor': 'start' });
        return s;
    }

    /* ============================================================
       The two layouts
       ============================================================ */
    const SHORT = {
        shield: 'Shielding coil', lhe: 'Liquid helium, 4.2 K', cryostat: 'Cryostat (vacuum vessel)', main: 'Main coil (NbTi)',
        shim: 'Shim coils', rf: 'RF body coil', liner: 'Bore liner, 60 cm bore', cold: 'Cold head'
    };
    const GRAD_LABEL = 'Gradient coils <tspan class="t-gx">x</tspan> <tspan class="t-gy">y</tspan> <tspan class="t-gz">z</tspan>';

    function wideLayout() {
        const m = { X0: 430, Y0: 214, s: 0.85 };
        const P = mapper(m);
        const gy = function (r) { return m.Y0 + m.s * r; };            // y of a radius in the lower half
        const back = P(MG.grad.z, 0)[0] + 1;                          // where the gradient cables end
        const rfY = gy(60), rxY = gy(40);
        const ringX = P(MG.rf.z, 0)[0] + 1;
        const B = {
            preamp: { x: 640, y: 190, w: 130, h: 34 },
            trsw: { x: 640, y: 246, w: 130, h: 34 },
            sequencer: { x: 290, y: 494, w: 256, h: 44 },
            rfsynth: { x: 580, y: 494, w: 140, h: 44 },
            rfamp: { x: 700, y: 418, w: 110, h: 46 },
            compressor: { x: 844, y: 418, w: 86, h: 46, sub: 'for cold head', compact: true },
            demod: { x: 790, y: 494, w: 140, h: 44 },
            kspace: { x: 790, y: 574, w: 140, h: 44, sub: 'raw data' },
            recon: { x: 600, y: 574, w: 140, h: 44, sub: 'inverse FFT, coils' },
            console: { x: 20, y: 432, w: 156, h: 112 }
        };
        const AMP = { x: { x: 290, y: 418, w: 80, h: 46 }, y: { x: 378, y: 418, w: 80, h: 46 }, z: { x: 466, y: 418, w: 80, h: 46 } };
        const hc0 = P(-4, 26), hc1 = P(-4, 40);
        const hy = P(0, -MG.rOut - 37.5)[1];
        const hx = P(MG.cold.z + 16, 0)[0];
        return {
            name: 'wide', W: 940, H: 640, mag: m, P: P,
            rooms: [
                { cls: 'room room-mag', x: 6, y: 6, w: 928, h: 380 },
                { cls: 'room room-eq', x: 6, y: 392, w: 182, h: 242 },
                { cls: 'room room-eq', x: 194, y: 392, w: 740, h: 242 }
            ],
            roomLabels: [
                { x: 18, y: 24, text: 'MAGNET ROOM', cls: 't-room' },
                { x: 18, y: 38, text: 'shielded by a Faraday cage', cls: 't-roomsub t-cage' },
                { x: 18, y: 410, text: 'CONTROL ROOM', cls: 't-room' },
                { x: 206, y: 410, text: 'EQUIPMENT ROOM', cls: 't-room' }
            ],
            cage: { x: 6, y: 6, w: 928, h: 380 },
            panel: { x: 568, y: 382, w: 364, h: 8, filters: [580, 594, 608, 790, 830, 918], label: { x: 640, y: 373, text: 'Penetration panel' } },
            leaderCot: 1.5,
            labels: [
                { comp: 'magnet', text: SHORT.shield, at: [-92, -151.5], x: 272, y: 56 },
                { comp: 'cryo', text: SHORT.lhe, at: [-90, -134], x: 272, y: 72 },
                { comp: 'magnet', text: SHORT.cryostat, at: [-142, -150], x: 272, y: 88 },
                { comp: 'magnet', text: SHORT.main, at: [-110, -115], x: 272, y: 104 },
                { comp: 'shim', text: SHORT.shim, at: [-100, -90], x: 272, y: 120 },
                { comp: 'gradcoils', text: 'Gradient coils x y z', html: GRAD_LABEL, at: [-86, -76.5], x: 272, y: 136 },
                { comp: 'bodycoil', text: SHORT.rf, at: [-59, -57], x: 272, y: 152 },
                { comp: 'liner', text: SHORT.liner, at: [-100, -52.5], x: 272, y: 168 },
                { comp: 'cryo', text: SHORT.cold, at: [82, -200], x: 512, y: 54, anchor: 'start', bend: 506 },
                { comp: 'patient', text: 'Patient on the table', at: [-190, 10], x: 160, y: 262, bend: 250 }
            ],
            b0: { x: 566, y: 186 },
            caption: { x: 296, y: 376, text: 'Cut-away side view; layers not to scale' },
            triad: { x: 112, y: 318, len: 44 },
            inset: { x: 744, y: 40, w: 162, h: 136, k: 0.17, title: 'Seen from the feet' },
            boxes: B, amps: AMP,
            heRaw: [[hx, hy], [918, hy], [918, 418]],
            heLabel: [700, hy - 6, 'helium gas lines to the compressor', 'middle', 'on-mag'],
            wires: [
                { id: 'w-console-seq', chain: 'ctl', pts: [[176, 516], [290, 516]], label: [233, 510, 'protocol'] },
                { id: 'w-seq-gx', chain: 'ctl', lv: 'lv-gx', pts: [[330, 494], [330, 464]] },
                { id: 'w-seq-gy', chain: 'ctl', lv: 'lv-gy', pts: [[418, 494], [418, 464]] },
                { id: 'w-seq-gz', chain: 'ctl', lv: 'lv-gz', pts: [[506, 494], [506, 464]] },
                { id: 'w-seq-synth', chain: 'ctl', lv: 'lv-rf', pts: [[546, 516], [580, 516]] },
                { id: 'w-synth-rfamp', chain: 'rf', lv: 'lv-rf', pts: [[710, 494], [710, 464]] },
                { id: 'w-rfamp-trsw', chain: 'rf', lv: 'lv-rf', pts: [[790, 418], [790, 271], [770, 271]] },
                { id: 'w-trsw-body', chain: 'rf', lv: 'lv-rf lv-rxbody', pts: [[640, rfY], [ringX, rfY]], label: [600, rfY - 4, 'B1 drive', 'middle', 'on-mag'] },
                { id: 'w-gx-coil', chain: 'gx', lv: 'lv-gx', pts: [[330, 418], [330, 400], [580, 400], [580, gy(83.5)], [back, gy(83.5)]] },
                { id: 'w-gy-coil', chain: 'gy', lv: 'lv-gy', pts: [[418, 418], [418, 406], [594, 406], [594, gy(76.5)], [back, gy(76.5)]] },
                { id: 'w-gz-coil', chain: 'gz', lv: 'lv-gz', pts: [[506, 418], [506, 412], [608, 412], [608, gy(69.5)], [back, gy(69.5)]] },
                { id: 'w-head-pre', chain: 'rx', lv: 'lv-rx', cls: 'only-head8', pts: [hc0, hc1, [620, rxY], [620, 207], [640, 207]] },
                { id: 'w-trsw-pre', chain: 'rx', lv: 'lv-rxbody', cls: 'rx-unused', pts: [[705, 246], [705, 224]] },
                { id: 'w-pre-demod', chain: 'rx', lv: 'lv-rx', pts: [[770, 207], [830, 207], [830, 494]] },
                { id: 'w-synth-demod', chain: 'rf', lv: 'lv-rx', dash: true, pts: [[720, 516], [790, 516]], label: [755, 510, 'f0 ref.'] },
                { id: 'w-demod-k', chain: 'rx', lv: 'lv-rx', pts: [[860, 538], [860, 574]] },
                { id: 'w-k-recon', chain: 'ctl', pts: [[790, 596], [740, 596]] },
                { id: 'w-recon-console', chain: 'ctl', pts: [[600, 596], [98, 596], [98, 544]], label: [350, 590, 'image'] }
            ]
        };
    }

    function tallLayout() {
        const m = { X0: 262, Y0: 212, s: 0.56 };
        const P = mapper(m);
        const gy = function (r) { return m.Y0 + m.s * r; };
        const back = P(MG.grad.z, 0)[0] + 1;
        const front = P(-MG.zc, 0)[0];
        const rfY = gy(60), rxY = gy(40);
        const ringX = P(-MG.rf.z, 0)[0] - 1;
        const hc0 = P(-4, 26), hc1 = P(-4, 40);
        const B = {
            trsw: { x: 176, y: 332, w: 154, h: 34 },
            preamp: { x: 176, y: 402, w: 154, h: 34 },
            rfamp: { x: 134, y: 644, w: 90, h: 44, title: 'RF amp', sub: 'about 35 kW', compact: true },
            demod: { x: 14, y: 716, w: 98, h: 44, title: 'Demod, ADC', sub: 'remove f0', compact: true },
            rfsynth: { x: 134, y: 716, w: 90, h: 44, title: 'RF synth', sub: '127.73 MHz', compact: true },
            sequencer: { x: 240, y: 716, w: 142, h: 44, sub: 'pulse program', compact: true },
            kspace: { x: 14, y: 784, w: 98, h: 44, sub: 'raw data', compact: true },
            recon: { x: 134, y: 784, w: 136, h: 44, sub: 'inverse FFT', compact: true },
            compressor: { x: 296, y: 784, w: 88, h: 44, sub: 'helium', compact: true },
            console: { x: 60, y: 874, w: 280, h: 76 }
        };
        const AMP = { x: { x: 232, y: 644, w: 46, h: 54 }, y: { x: 282, y: 644, w: 46, h: 54 }, z: { x: 332, y: 644, w: 46, h: 54 } };
        const hy = P(0, -MG.rOut - 37.5)[1];
        return {
            name: 'tall', W: 400, H: 960, mag: m, P: P,
            rooms: [
                { cls: 'room room-mag', x: 6, y: 6, w: 388, h: 584 },
                { cls: 'room room-eq', x: 6, y: 596, w: 388, h: 248 },
                { cls: 'room room-eq', x: 6, y: 850, w: 388, h: 104 }
            ],
            roomLabels: [
                { x: 16, y: 24, text: 'MAGNET ROOM', cls: 't-room' },
                { x: 16, y: 37, text: 'inside a Faraday cage', cls: 't-roomsub t-cage' },
                { x: 16, y: 612, text: 'EQUIPMENT ROOM', cls: 't-room' },
                { x: 16, y: 866, text: 'CONTROL ROOM', cls: 't-room' }
            ],
            cage: { x: 6, y: 6, w: 388, h: 584 },
            panel: { x: 290, y: 586, w: 104, h: 8, filters: [300, 345, 360, 370, 380, 392], label: { x: 284, y: 578, text: 'Penetration panel', anchor: 'end' } },
            leaderCot: 1.5,
            labels: [
                { comp: 'magnet', text: SHORT.shield, at: [-92, -151.5], x: 150, y: 94 },
                { comp: 'cryo', text: 'Liquid helium 4.2 K', at: [-90, -134], x: 150, y: 107 },
                { comp: 'magnet', text: 'Cryostat (vacuum)', at: [-145, -160], x: 150, y: 120 },
                { comp: 'magnet', text: SHORT.main, at: [-110, -115], x: 150, y: 133 },
                { comp: 'shim', text: SHORT.shim, at: [-100, -90], x: 150, y: 146 },
                { comp: 'gradcoils', text: 'Gradient coils x y z', html: GRAD_LABEL, at: [-86, -76.5], x: 150, y: 159 },
                { comp: 'bodycoil', text: SHORT.rf, at: [-59, -57], x: 150, y: 172 },
                { comp: 'liner', text: 'Bore liner', at: [-100, -52.5], x: 150, y: 185 },
                { comp: 'cryo', text: SHORT.cold, at: [70, -205], x: 318, y: 100, anchor: 'start', bend: 312 }
            ],
            b0: { x: 168, y: 200, anchor: 'end' },
            caption: { x: 176, y: 324, text: 'Cut-away view, not to scale' },
            triad: { x: 40, y: 360, len: 40 },
            inset: { x: 14, y: 456, w: 196, h: 118, k: 0.118, title: 'Seen from the feet', dx: 30 },
            boxes: B, amps: AMP,
            heRaw: [[P(MG.cold.z + 16, 0)[0], hy], [P(MG.cold.z + 16, 0)[0], 50], [392, 50], [392, 806], [384, 806]],
            heLabel: null,
            wires: [
                { id: 'w-console-seq', chain: 'ctl', pts: [[285, 874], [285, 760]] },
                { id: 'w-seq-gx', chain: 'ctl', lv: 'lv-gx', pts: [[255, 716], [255, 698]] },
                { id: 'w-seq-gy', chain: 'ctl', lv: 'lv-gy', pts: [[305, 716], [305, 698]] },
                { id: 'w-seq-gz', chain: 'ctl', lv: 'lv-gz', pts: [[355, 716], [355, 698]] },
                { id: 'w-seq-synth', chain: 'ctl', lv: 'lv-rf', pts: [[240, 738], [224, 738]] },
                { id: 'w-synth-rfamp', chain: 'rf', lv: 'lv-rf', pts: [[179, 716], [179, 688]] },
                { id: 'w-rfamp-trsw', chain: 'rf', lv: 'lv-rf', pts: [[179, 644], [179, 610], [345, 610], [345, 349], [330, 349]] },
                { id: 'w-trsw-body', chain: 'rf', lv: 'lv-rf lv-rxbody', pts: [[176, 349], [162, 349], [162, rfY], [ringX, rfY]] },
                { id: 'w-gx-coil', chain: 'gx', lv: 'lv-gx', pts: [[255, 644], [255, 616], [360, 616], [360, gy(83.5)], [back, gy(83.5)]] },
                { id: 'w-gy-coil', chain: 'gy', lv: 'lv-gy', pts: [[305, 644], [305, 622], [370, 622], [370, gy(76.5)], [back, gy(76.5)]] },
                { id: 'w-gz-coil', chain: 'gz', lv: 'lv-gz', pts: [[355, 644], [355, 628], [380, 628], [380, gy(69.5)], [back, gy(69.5)]] },
                { id: 'w-head-pre', chain: 'rx', lv: 'lv-rx', cls: 'only-head8', pts: [hc0, hc1, [150, rxY], [150, 419], [176, 419]] },
                { id: 'w-trsw-pre', chain: 'rx', lv: 'lv-rxbody', cls: 'rx-unused', pts: [[253, 366], [253, 402]] },
                { id: 'w-pre-demod', chain: 'rx', lv: 'lv-rx', pts: [[300, 436], [300, 604], [63, 604], [63, 716]] },
                { id: 'w-synth-demod', chain: 'rf', lv: 'lv-rx', dash: true, pts: [[134, 738], [112, 738]] },
                { id: 'w-demod-k', chain: 'rx', lv: 'lv-rx', pts: [[63, 760], [63, 784]] },
                { id: 'w-k-recon', chain: 'ctl', pts: [[112, 806], [134, 806]] },
                { id: 'w-recon-console', chain: 'ctl', pts: [[202, 828], [202, 874]] }
            ],
            front: front
        };
    }

    function buildSvg(L, coilType) {
        const P = L.P;
        let s = '';
        s += tag('defs', {}, markers());
        // rooms
        L.rooms.forEach(function (r) { s += rect(r.x, r.y, r.w, r.h, r.cls, { rx: 8 }); });
        L.roomLabels.forEach(function (t) { s += text(t.x, t.y, esc(t.text), t.cls); });
        // the magnet and its labels
        s += magnetSvg(L.mag);
        if (L.caption) s += text(L.caption.x, L.caption.y, esc(L.caption.text), 't-small');
        // B0 label after the arrow
        s += comp('magnet', text(L.b0.x, L.b0.y, 'B<tspan baseline-shift="sub" font-size="9">0</tspan> = 3 T', 't-b0', { 'text-anchor': L.b0.anchor || 'start' }), { primary: false });
        // inset and triad
        s += insetSvg(L);
        s += triadSvg(L.triad);
        // the Faraday cage (a component) and the penetration panel
        const cg = L.cage, pn = L.panel;
        let cage = rect(cg.x, cg.y, cg.w, cg.h, 'cage', { rx: 8 }) + rect(cg.x, cg.y, cg.w, cg.h, 'cage-hit', { rx: 8 });
        cage += rect(pn.x, pn.y, pn.w, pn.h, 'panelbar sh', { rx: 2 });
        pn.filters.forEach(function (fx) { cage += rect(fx - 4, pn.y - 2, 8, pn.h + 4, 'filter', { rx: 2 }); });
        cage += text(pn.label.x, pn.label.y, esc(pn.label.text), 't-small t-cage', { 'text-anchor': pn.label.anchor || 'start' });
        s += comp('cage', cage);
        // helium lines (drawn under the wires)
        s += heLine(L.heRaw);
        if (L.heLabel) s += text(L.heLabel[0], L.heLabel[1], esc(L.heLabel[2]), 'wlabel on-mag', { 'text-anchor': 'middle' });
        // wires
        L.wires.forEach(function (wd) { s += wire(wd); });
        // labels (after the wires so they stay readable)
        L.labels.forEach(function (lb) { s += labelSvg(lb, P, L.leaderCot); });
        // equipment
        Object.keys(L.boxes).forEach(function (id) { s += box(id, L.boxes[id]); });
        ['x', 'y', 'z'].forEach(function (a) { s += gradAmp(a, L.amps[a]); });
        const desc = 'Schematic of a 3 T MRI scanner. Magnet room: the superconducting magnet in a cut-away side view with its cryostat, ' +
            'liquid helium, shim coils, gradient coils and RF body coil, the patient on the table with the head coil, the T/R switch and preamplifiers. ' +
            'Equipment room: sequencer, gradient amplifiers, RF synthesiser and power amplifier, demodulator and ADC, k-space store, ' +
            'reconstruction computer and helium compressor. Control room: operator console. Arrows show the flow of signals.';
        return '<svg xmlns="http://www.w3.org/2000/svg" class="sc-svg lay-' + L.name + ' coil-' + esc(coilType) + '" viewBox="0 0 ' + L.W + ' ' + L.H +
            '" role="group" aria-roledescription="schematic" aria-label="' + esc(desc) + '">' + s + '</svg>';
    }

    /* ============================================================
       Tab state and DOM
       ============================================================ */
    const T = {
        mounted: false, visible: false, layout: null, svg: null, host: null,
        hover: null, focusId: null, selected: null, rove: 'console',
        step: -1,                 // -1: not stepping; 0..11 otherwise
        live: { rf: false, gx: false, gy: false, gz: false, rx: false, playing: false },
        lastOn: { rf: 0, gx: 0, gy: 0, gz: 0, rx: 0 },
        lastText: 0, lastRf: null, lvlEls: null, gvalEls: null, pendingTick: null, tickQueued: false
    };
    const R = {};     // DOM references

    /* ---------- figure: build, layout choice ---------- */
    function chooseLayout() {
        const w = R.figWrap ? R.figWrap.clientWidth : 0;
        if (!w) return null;
        return w >= 780 ? 'wide' : 'tall';    // below this the wide figure's text would fall under about 9 px
    }
    function buildFigure(force) {
        const want = chooseLayout();
        if (!want) return;
        if (!force && want === T.layout && T.svg) return;
        T.layout = want;
        const L = want === 'wide' ? wideLayout() : tallLayout();
        R.fig.classList.toggle('is-tall', want === 'tall');
        R.fig.innerHTML = buildSvg(L, S().coilType === 'body' ? 'body' : 'head8');
        T.svg = R.fig.querySelector('svg');
        T.lvlEls = {};
        T.gvalEls = {};
        T.svg.querySelectorAll('.lvl').forEach(function (n) { T.lvlEls[n.getAttribute('data-axis')] = n; });
        T.svg.querySelectorAll('[data-gval]').forEach(function (n) { T.gvalEls[n.getAttribute('data-gval')] = n; });
        T.hover = null;
        T.focusId = null;
        applyAll();
    }
    function compEls(id) { return T.svg ? T.svg.querySelectorAll('[data-c="' + id + '"]') : []; }
    function primaryEl(id) { return T.svg ? T.svg.querySelector('[data-c="' + id + '"][data-primary]') : null; }

    function visibleComps() {
        const body = S().coilType === 'body';
        return COMPS.filter(function (c) { return !(body && c.id === 'headcoil'); });
    }

    /* Re-apply every class that depends on state (after a rebuild). */
    function applyAll() {
        if (!T.svg) return;
        applyCoil();
        applyRove();
        applySelection();
        applyStep();
        applyLive(true);
        if (T.hover) setHover(T.hover);
    }
    function applyCoil() {
        const body = S().coilType === 'body';
        if (body && T.rove === 'headcoil') T.rove = 'bodycoil';
        if (body && T.selected === 'headcoil') { T.selected = null; renderInfo(); }
        if (!T.svg) return;
        T.svg.classList.toggle('coil-body', body);
        T.svg.classList.toggle('coil-head8', !body);
    }
    function applyRove() {
        if (!T.svg) return;
        T.svg.querySelectorAll('[data-primary]').forEach(function (n) { n.setAttribute('tabindex', '-1'); });
        let el0 = primaryEl(T.rove);
        if (!el0) { T.rove = visibleComps()[0].id; el0 = primaryEl(T.rove); }
        if (el0) el0.setAttribute('tabindex', '0');
    }
    function applySelection() {
        if (!T.svg) return;
        T.svg.querySelectorAll('.sc-c.sel').forEach(function (n) { n.classList.remove('sel'); });
        T.svg.querySelectorAll('[data-primary][aria-expanded="true"]').forEach(function (n) { n.setAttribute('aria-expanded', 'false'); });
        if (!T.selected) return;
        compEls(T.selected).forEach(function (n) { n.classList.add('sel'); });
        const p = primaryEl(T.selected);
        if (p) p.setAttribute('aria-expanded', 'true');
    }
    function setHover(id) {
        if (!T.svg) return;
        if (T.hover && T.hover !== id) compEls(T.hover).forEach(function (n) { n.classList.remove('hl'); });
        T.hover = id;
        if (id) compEls(id).forEach(function (n) { n.classList.add('hl'); });
    }
    function setFocusMark(id) {
        if (!T.svg) return;
        T.svg.querySelectorAll('.sc-c.focus').forEach(function (n) { n.classList.remove('focus'); });
        T.focusId = id;
        if (id) compEls(id).forEach(function (n) { n.classList.add('focus'); });
    }

    /* ---------- selection and the info panel ---------- */
    function select(id, opts) {
        opts = opts || {};
        if (id && !COMP_BY_ID[id]) return;
        T.selected = id || null;
        if (id) T.rove = id;
        applyRove();
        applySelection();
        renderInfo();
        if (id && opts.reveal) revealInfo();
    }
    /* On narrow screens the info panel sits below the figure: bring it
       into view after an explicit click or Enter, but not on hover. */
    function revealInfo() {
        if (!R.info) return;
        const rect = R.info.getBoundingClientRect();
        const vh = root.innerHeight || 800;
        if (rect.top >= 0 && rect.top < vh - 120) return;
        // html { scroll-padding-top } keeps the panel clear of the sticky console (--console-h).
        try { R.info.scrollIntoView({ block: 'start', behavior: U.scrollBehavior() }); } catch (e) { R.info.scrollIntoView(); }
    }

    function runLink(l) {
        const act = A();
        if (l.shim) {
            if (act.showTab) act.showTab('spectro');
            MRI.bus.emit('shim:open', {});
            return;
        }
        if (l.artifact) {
            // Open the tab first (its onShow lays the cards out), then ask it to open the card.
            if (act.showTab) act.showTab('artifacts', { focus: true });
            MRI.bus.emit('artifacts:focus', { id: l.artifact });
            return;
        }
        if (l.tab && act.showTab) act.showTab(l.tab, { focus: true });
    }

    function renderInfo() {
        const box0 = R.infoBody;
        if (!box0) return;
        box0.textContent = '';
        const id = T.selected;
        if (!id) {
            box0.appendChild(el('div', { class: 'sc-info-empty' }, [
                el('p', { html: 'Click any part of the scanner to see what it does, its typical values at 3 T, and what goes wrong when it fails.' }),
                el('p', { html: 'With the keyboard: focus the diagram with <kbd>Tab</kbd>, move with the arrow keys and press <kbd>Enter</kbd>.' })
            ]));
            R.infoStatus.textContent = '';
            return;
        }
        const c = COMP_BY_ID[id];
        const inf = INFO[c.info];
        let title = inf.title;
        let axis = null;
        if (c.info === 'gradamp') { axis = id.slice(-1); title = 'Gradient amplifier ' + axis; }
        box0.appendChild(el('div', { class: 'sc-info-eyebrow', text: inf.chain }));
        box0.appendChild(el('h3', { id: 'scnr-info-title', text: title }));
        box0.appendChild(el('p', { html: inf.what }));
        if (axis && inf.axisNote) box0.appendChild(el('p', { class: 'note', text: inf.axisNote[axis] }));
        const rows = (inf.nums || []).map(function (r) { return { label: r[0], value: r[1] }; });
        let live = [];
        try { live = inf.live ? inf.live(axis) : []; } catch (e) { live = []; }
        if (rows.length || live.length) {
            box0.appendChild(el('h4', { text: 'Typical values at 3 T' + (live.length ? ', and this scan' : '') }));
            const tb = W().statTable(rows.concat(live.map(function (r) { return { label: r[0], value: r[1] }; })), { compact: true });
            const trs = tb.querySelectorAll('tr');
            for (let i = rows.length; i < trs.length; i++) trs[i].classList.add('sc-live-row');
            box0.appendChild(tb);
        }
        box0.appendChild(el('h4', { text: 'When it misbehaves' }));
        box0.appendChild(el('p', { html: inf.wrong }));
        box0.appendChild(W().callout('<strong>In this simulator:</strong> ' + inf.sim));
        if (inf.note) box0.appendChild(el('p', { class: 'simplification', text: inf.note }));
        const links = (inf.links || []).slice();
        if (links.length) {
            const row = el('div', { class: 'sc-links' });
            links.forEach(function (l) {
                row.appendChild(W().button({ label: l.label, size: 'sm', kind: l.primary ? 'primary' : null, onClick: function () { runLink(l); } }));
            });
            box0.appendChild(row);
        }
        R.infoStatus.textContent = 'Showing details for ' + title + '.';
    }

    /* ---------- stepper ---------- */
    function applyStep() {
        if (!T.svg) return;
        T.svg.querySelectorAll('.stp').forEach(function (n) { n.classList.remove('stp'); });
        const on = T.step >= 0;
        T.svg.classList.toggle('stepping', on);
        if (!on) return;
        const st = steps()[T.step];
        st.comps.forEach(function (id) { compEls(id).forEach(function (n) { n.classList.add('stp'); }); });
        (st.wires || []).forEach(function (wid) {
            const n = T.svg.querySelector('[data-w="' + wid + '"]');
            if (n) n.classList.add('stp');
        });
    }
    function setStep(i) {
        T.step = i < 0 ? -1 : Math.min(N_STEPS - 1, i);
        applyStep();
        renderStepper();
    }
    function renderStepper() {
        if (!R.stepTitle) return;
        const on = T.step >= 0;
        R.stepBadge.textContent = on ? 'Step ' + (T.step + 1) + ' of ' + N_STEPS : N_STEPS + ' steps';
        if (on) {
            const st = steps()[T.step];
            R.stepTitle.textContent = (T.step + 1) + '. ' + st.title;
            R.stepText.textContent = st.text;
        } else {
            R.stepTitle.textContent = 'From the pulse program to the image';
            R.stepText.textContent = 'Walk through the scanner in order. Each step highlights the parts involved and dims the rest.';
        }
        R.prev.disabled = !on || T.step === 0;
        R.next.textContent = !on ? 'Start' : (T.step === N_STEPS - 1 ? 'Finish' : 'Next');
        R.exit.hidden = !on;
        R.dots.forEach(function (d, i) {
            d.classList.toggle('done', on && i < T.step);
            if (on && i === T.step) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
        });
    }

    /* ---------- live activity during playback ---------- */
    const HOLD_MS = 60;       // keep a light on for a few frames, so a short pulse is seen but a train still pulses at the TR
    function applyLive(force) {
        if (!T.svg) return;
        const L = T.live;
        const cl = T.svg.classList;
        if (force || cl.contains('playing') !== L.playing) cl.toggle('playing', L.playing);
        ['rf', 'gx', 'gy', 'gz', 'rx'].forEach(function (k) {
            if (force || cl.contains('live-' + k) !== L[k]) cl.toggle('live-' + k, L[k]);
        });
    }
    function setLevels(g) {
        if (!T.lvlEls) return;
        ['x', 'y', 'z'].forEach(function (a) {
            const n = T.lvlEls[a];
            if (!n) return;
            const v = g ? U.clamp((g[a] || 0) / GMAX, -1, 1) : 0;
            const cx = +n.getAttribute('data-cx'), half = +n.getAttribute('data-half');
            const w0 = Math.abs(v) * half;
            n.setAttribute('x', r1(v >= 0 ? cx : cx - w0));
            n.setAttribute('width', r1(w0));
            const tv = T.gvalEls[a];
            if (tv) {
                const num = g ? signed((g[a] || 0) * 1e3, 1) : '0.0';
                tv.textContent = tv.getAttribute('data-unit') === '0' ? num : num + ' mT/m';
            }
        });
    }
    function rfLabel(rf) {
        if (!rf) return '';
        let role = rf.role || 'pulse';
        if (rf.select === 'fat') role = 'fat saturation';
        else if (rf.select === 'water') role = 'water saturation';
        const shape = rf.shape === 'sech' ? ', adiabatic' : rf.select === 'slice' ? ', slice' : rf.select === 'none' ? ', hard' : '';
        return fmt(rf.flip, 3) + '° ' + role + shape;
    }
    function onTick(tk) {
        if (!T.visible || !T.svg || !tk) return;
        // coalesce: app.js emits one tick per frame already, but never do the
        // DOM work twice in one frame
        T.pendingTick = tk;
        if (T.tickQueued) return;
        T.tickQueued = true;
        raf(function () {
            T.tickQueued = false;
            const t = T.pendingTick;
            T.pendingTick = null;
            if (t && T.visible) renderTick(t);
        });
    }
    function renderTick(tk) {
        const tNow = now();
        const g = tk.grad || {};
        const thr = 0.01 * GMAX;
        const on = {
            rf: !!tk.rf && tk.rf.t0 + tk.rf.dur >= (tk.t0 || tk.t) - 1e-9,
            gx: Math.abs(g.x || 0) > thr, gy: Math.abs(g.y || 0) > thr, gz: Math.abs(g.z || 0) > thr,
            rx: !!tk.adcOn
        };
        if (on.rf) T.lastRf = tk.rf;
        Object.keys(on).forEach(function (k) {
            if (on[k]) T.lastOn[k] = tNow;
            T.live[k] = on[k] || (tNow - T.lastOn[k] < HOLD_MS);
        });
        T.live.playing = true;
        applyLive(false);
        setLevels(g);
        if (tNow - T.lastText > 90) {
            T.lastText = tNow;
            const p = goodProgram();
            const nPer = p && p.periods ? p.periods.length : 0;
            R.liveState.textContent = 'Acquiring';
            R.livePeriod.textContent = isFinite(tk.period) ? (tk.period + 1) + (nPer ? ' of ' + nPer : '') : '-';
            R.liveTime.textContent = clock(tk.t, tk.duration) + ' of ' + clock(tk.duration, tk.duration);
            R.liveLine.textContent = (tk.readoutsDone || 0) + ' of ' + (tk.readouts || 0);
            // the text follows the lights (which hold briefly), so they never disagree
            R.liveRf.textContent = T.live.rf && T.lastRf ? rfLabel(T.lastRf) : 'off';
            R.liveAdc.textContent = T.live.rx ? 'sampling' : 'off';
            R.live.setAttribute('data-state', 'run');
            R.liveLed.setAttribute('data-state', 'busy');
        }
    }
    function goIdle(msg) {
        T.pendingTick = null;     // a tick queued for the next frame must not light things up again
        T.live = { rf: false, gx: false, gy: false, gz: false, rx: false, playing: false };
        applyLive(true);
        setLevels(null);
        if (!R.live) return;
        R.live.setAttribute('data-state', 'idle');
        R.liveLed.setAttribute('data-state', S().scanning ? 'busy' : 'idle');
        R.liveIdle.textContent = msg || idleText();
    }
    function idleText() {
        const st = S();
        if (st.scanning) return 'Computing the scan…';
        const speed = st.speed;
        const how = speed === 'instant'
            ? 'Set the speed to Fast or Slow, then press Acquire to watch the hardware play the sequence.'
            : 'Press Acquire to watch the hardware play the sequence.';
        return 'Idle. ' + how;
    }

    /* ---------- Larmor calculator ---------- */
    const LC = { G: 0.010, x: 0.100 };
    function readoutGradient() {
        const p = goodProgram();
        if (!p || !p.image || !p.image.hasImaging) return null;
        const im = p.image;
        const alongY = im.readoutAxis === 'y';
        const n = alongY ? im.ny : im.nx, fov = alongY ? im.fovY : im.fovX;
        if (!(n > 0 && fov > 0 && im.bwPerPixel > 0)) return null;
        return { G: n * im.bwPerPixel / (GBAR * fov), win: n * im.bwPerPixel, fov: fov, n: n, bw: im.bwPerPixel, name: p.name };
    }
    function niceMax(v) {
        const e = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1e-9))));
        const m = v / e;
        const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
        return step * e;
    }
    function updateLarmor() {
        if (!R.lc) return;
        const G = LC.G, x = LC.x;
        const dB = G * x, B = B0 + dB, f = GBAR * B, df = GBAR * G * x;
        R.lc.B.textContent = B.toFixed(6);
        R.lc.Bsub.textContent = 'T (' + (Math.abs(dB) < 1e-3 ? signed(dB * 1e6, 1) + ' µT' : signed(dB * 1e3, 3) + ' mT') + ')';
        R.lc.f.textContent = (f / 1e6).toFixed(6);
        R.lc.df.textContent = signed(df / 1e3, 2);
        R.lc.perMm.textContent = fmt(GBAR * G * 1e-3, 4);
        R.lc.eq.innerHTML = 'f = γ̄ (B<sub>0</sub> + G·x) = 42.577 MHz/T × (3 T ' + (dB < 0 ? '− ' : '+ ') +
            fmt(Math.abs(G) * 1e3, 3) + ' mT/m × ' + fmt(Math.abs(x) * 1e3, 3) + ' mm) = ' + (f / 1e6).toFixed(4) + ' MHz';
        const spread = GBAR * G * 0.16;
        const ro = readoutGradient();
        let fatTxt;
        if (G > 1e-6) {
            const shift = FAT_HZ / (GBAR * G);
            fatTxt = 'Across a 160 mm wide head the frequencies span <b>' + fmt(spread / 1e3, 3) + ' kHz</b>. Fat precesses 434 Hz below water, so at this gradient it is drawn <b>' +
                fmt(Math.abs(shift) * 1e3, 3) + ' mm</b> towards −x (the chemical shift displacement grows as the gradient weakens).';
        } else {
            fatTxt = 'With no gradient every position precesses at f0: the frequency says nothing about where the signal came from.';
        }
        R.lc.note.innerHTML = fatTxt;
        if (ro) {
            R.lc.use.hidden = false;
            R.lc.use.title = 'Set G to the readout gradient of the current sequence, ' + fmt(ro.G * 1e3, 3) + ' mT/m, and x to the edge of its field of view';
            const match = Math.abs(G - ro.G) < 0.02e-3;
            R.lc.ro.innerHTML = match
                ? 'This is the readout gradient of <b>' + esc(ro.name || 'the current sequence') + '</b>: its receiver window of ±' + fmt(ro.win / 2e3, 3) +
                  ' kHz (N × BW/px = ' + ro.n + ' × ' + fmt(ro.bw, 4) + ' Hz) covers exactly the ' + fmt(ro.fov * 1e3, 3) + ' mm field of view, and each pixel spans ' + fmt(ro.bw, 4) + ' Hz.'
                : 'The shaded band is the receiver window of the current sequence (±' + fmt(ro.win / 2e3, 3) + ' kHz). Only positions whose frequency falls inside it are inside the field of view.';
        } else {
            R.lc.use.hidden = true;
            R.lc.ro.textContent = '';
        }
        drawLarmorPlot(ro);
    }
    function drawLarmorPlot(ro) {
        const svg = R.lc.plot;
        // Draw in CSS pixels of the actual box, so text stays at its real size.
        const W0 = Math.max(280, Math.round(svg.clientWidth || (svg.parentNode && svg.parentNode.clientWidth) || 520));
        const H0 = Math.round(U.clamp(W0 * 0.4, 180, 240));
        svg.setAttribute('viewBox', '0 0 ' + W0 + ' ' + H0);
        svg.setAttribute('height', H0);
        const x0 = 54, x1 = W0 - 10, y0 = 14, y1 = H0 - 34;
        const xmin = -0.15, xmax = 0.15;
        const G = LC.G;
        const fEdge = GBAR * Math.abs(G) * 0.15;
        const ymax = niceMax(Math.max(fEdge, ro ? ro.win / 2 : 0, 2000) * 1.08);
        const X = function (x) { return x0 + (x - xmin) / (xmax - xmin) * (x1 - x0); };
        const Y = function (f) { return (y0 + y1) / 2 - f / ymax * (y1 - y0) / 2; };
        let s = '';
        // receiver window of the current sequence, the head
        if (ro && ro.win / 2 < ymax) s += rect(x0, Y(ro.win / 2), x1 - x0, Y(-ro.win / 2) - Y(ro.win / 2), 'lp-win');
        s += rect(X(-0.08), y0, X(0.08) - X(-0.08), y1 - y0, 'lp-head');
        // grid and ticks
        [-0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15].forEach(function (v) {
            s += tag('line', { x1: X(v), y1: y0, x2: X(v), y2: y1, class: 'lp-grid' });
            s += text(X(v), y1 + 16, String(Math.round(v * 1e3)).replace('-', '\u2212'), '', { 'text-anchor': 'middle' });
        });
        [-1, -0.5, 0, 0.5, 1].forEach(function (q) {
            const f = q * ymax;
            s += tag('line', { x1: x0, y1: Y(f), x2: x1, y2: Y(f), class: q === 0 ? 'lp-axis' : 'lp-grid' });
            const lab = Math.abs(ymax) >= 2000 ? fmt(f / 1e3, 3) : fmt(f, 3);
            s += text(x0 - 5, Y(f) + 3.5, lab.replace('-', '−'), '', { 'text-anchor': 'end' });
        });
        s += tag('line', { x1: x0, y1: y0, x2: x0, y2: y1, class: 'lp-axis' });
        s += text((x0 + x1) / 2, H0 - 4, 'position x (mm)', '', { 'text-anchor': 'middle' });
        s += text(12, (y0 + y1) / 2, 'f − f0 (' + (ymax >= 2000 ? 'kHz' : 'Hz') + ')', '', { 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + r1((y0 + y1) / 2) + ')' });
        s += text(X(0), y0 + 11, 'head', 'lp-strong', { 'text-anchor': 'middle' });
        // the line f = gamma-bar G x, and the chosen point
        s += tag('line', { x1: X(xmin), y1: Y(GBAR * G * xmin), x2: X(xmax), y2: Y(GBAR * G * xmax), class: 'lp-line' });
        const px = X(LC.x), py = Y(GBAR * G * LC.x);
        s += tag('line', { x1: px, y1: py, x2: px, y2: Y(0), class: 'lp-guide' });
        s += tag('line', { x1: x0, y1: py, x2: px, y2: py, class: 'lp-guide' });
        s += tag('circle', { cx: px, cy: py, r: 4.5, class: 'lp-dot' });
        svg.innerHTML = s;
        svg.setAttribute('aria-label', 'Frequency offset against position for G = ' + fmt(G * 1e3, 3) + ' mT/m: a straight line through zero; at x = ' +
            fmt(LC.x * 1e3, 3) + ' mm the offset is ' + signed(GBAR * G * LC.x / 1e3, 2) + ' kHz.');
    }

    /* ---------- build the tab ---------- */
    function mount(panel) {
        MRI.ui.addStyle(CSS);
        const w = W();
        const act = A();

        // concept card
        panel.appendChild(w.concept({
            title: 'Three magnetic fields and a very sensitive radio',
            body: '<p>An MRI scanner is three magnetic fields plus a radio receiver. The static field <b>B0</b> (3 T) gives the protons a small net magnetisation and makes it precess at the Larmor frequency f0 = γ̄B0 = 127.73 MHz. The <b>gradient coils</b> add a field that grows linearly with position, so the precession frequency (and phase) depends on where the protons are. A brief radio-frequency field <b>B1</b> at f0 tips the magnetisation away from B0; as it precesses it induces a voltage of microvolts in the receive coil, which the receiver amplifies, demodulates and digitises.</p>',
            formula: 'f(x) = γ̄ (B<sub>0</sub> + G<sub>x</sub>·x) <div class="note" style="font-family:var(--font-sans);font-size:0.78rem;margin-top:4px">γ̄ = 42.58 MHz/T, B<sub>0</sub> = 3 T, so f0 = 127.73 MHz</div>',
            tryThis: [
                { html: 'Press <b>Acquire</b> (speed Fast or Slow) and watch the hardware: the RF chain lights up for each pulse, each gradient amplifier swings with its waveform, and the receive chain lights up while the ADC samples.',
                    label: 'Acquire', run: function () {
                        if (S().speed === 'instant' && act.setSpeed) act.setSpeed('fast');
                        if (act.runScan) act.runScan({ animate: true });
                        if (R.figPanel) { try { R.figPanel.scrollIntoView({ behavior: U.scrollBehavior(), block: 'start' }); } catch (e) { /* old browsers */ } }
                    } },
                { html: '<b>Follow the signal</b> in twelve steps, from the pulse program at the console to the image.',
                    label: 'Start', run: function () { setStep(0); if (R.stepPanel) { try { R.stepPanel.scrollIntoView({ behavior: U.scrollBehavior(), block: 'nearest' }); } catch (e) { /* ignore */ } } } },
                { html: 'In the <b>Larmor calculator</b>, set G = 10 mT/m: across a 160 mm head the frequency now spans about 68 kHz, 426 Hz per millimetre. That spread is what frequency encoding reads.',
                    label: 'Set 10 mT/m', run: function () {
                        LC.G = 0.010; LC.x = 0.080; if (R.lcG) R.lcG.set(LC.G); if (R.lcX) R.lcX.set(LC.x); updateLarmor();
                        if (R.lcPanel) { try { R.lcPanel.scrollIntoView({ behavior: U.scrollBehavior(), block: 'center' }); } catch (e) { /* ignore */ } }
                    } },
                { html: 'Switch the <b>receive coil</b> between the body coil and the 8-channel head coil, and measure the SNR each time (Image tab, <b>Place both</b>). The array’s small loops pick up far less noise than the big body coil, so its SNR is higher everywhere in the head: about 1.6 times at the centre and about three times near the cortex.',
                    label: 'Switch coil', run: function () { if (act.setCoil) act.setCoil(S().coilType === 'body' ? 'head8' : 'body'); } }
            ]
        }));

        // figure and side column
        const top = el('div', { class: 'split sc-top' });
        const figPanel = el('section', { class: 'panel sc-figpanel', 'aria-labelledby': 'scnr-fig-title' });
        R.figPanel = figPanel;
        const head = el('div', { class: 'panel-head' });
        head.appendChild(el('h2', { class: 'panel-title', id: 'scnr-fig-title', text: 'The 3 T scanner' }));
        head.appendChild(el('span', { class: 'panel-sub', text: 'Click a part for details' }));
        head.appendChild(el('span', { class: 'spacer' }));
        R.coilSeg = w.segmented({
            options: (MRI.ui.terms && MRI.ui.terms.coilOptions) || [{ value: 'body', label: 'Body coil' }, { value: 'head8', label: '8-channel head coil' }],
            value: S().coilType === 'body' ? 'body' : 'head8', ariaLabel: 'Receive coil', size: 'sm',
            onChange: function (v) { if (act.setCoil) act.setCoil(v); }
        });
        head.appendChild(el('span', { class: 'sc-coilsel' }, [el('span', { text: 'Receive coil' }), R.coilSeg]));
        figPanel.appendChild(head);

        R.figWrap = el('div', { class: 'sc-figwrap' });
        R.fig = el('div', { class: 'sc-fig' });
        R.figWrap.appendChild(R.fig);
        figPanel.appendChild(R.figWrap);

        const under = el('div', { class: 'sc-under' });
        R.live = el('div', { class: 'sc-live', 'data-state': 'idle', 'aria-live': 'off' });
        R.liveIdle = el('span', { class: 'sc-live-idle' });
        R.liveState = el('span', { text: 'Acquiring' });
        R.livePeriod = el('b', { text: '-' });
        R.liveTime = el('b', { text: '-' });
        R.liveLine = el('b', { text: '-' });
        R.liveRf = el('b', { text: '-' });
        R.liveAdc = el('b', { text: '-' });
        R.live.appendChild(el('span', { class: 'sc-live-state' }, [(R.liveLed = el('span', { class: 'led', 'data-state': 'idle', 'aria-hidden': 'true' })), el('span', { class: 'sc-live-run' }, [R.liveState])]));
        R.live.appendChild(R.liveIdle);
        R.live.appendChild(el('span', { class: 'sc-live-item sc-live-run' }, ['Period ', R.livePeriod]));
        R.live.appendChild(el('span', { class: 'sc-live-item sc-live-run' }, ['t = ', R.liveTime]));
        R.live.appendChild(el('span', { class: 'sc-live-item sc-live-run' }, ['readouts ', R.liveLine]));
        R.live.appendChild(el('span', { class: 'sc-live-item sc-live-run sc-live-rf' }, ['RF ', R.liveRf]));
        R.live.appendChild(el('span', { class: 'sc-live-item sc-live-run sc-live-adc' }, ['ADC ', R.liveAdc]));
        under.appendChild(R.live);
        under.appendChild(el('div', { class: 'sc-legend' }, [w.legend([
            { label: 'RF transmit', color: 'var(--seq-rf)', line: true },
            { label: 'Gradient x', color: 'var(--seq-gx)', line: true },
            { label: 'Gradient y', color: 'var(--seq-gy)', line: true },
            { label: 'Gradient z', color: 'var(--seq-gz)', line: true },
            { label: 'Receive', color: 'var(--seq-adc)', line: true },
            { label: 'Control and data', color: 'var(--sc-ctl)', line: true },
            { label: 'Helium', color: 'var(--sc-he)', line: true }
        ])]));
        R.coilNote = el('p', { class: 'note sc-coilnote' });
        under.appendChild(R.coilNote);
        figPanel.appendChild(under);
        top.appendChild(figPanel);

        const side = el('div', { class: 'sc-side' });
        // stepper
        const stepPanel = el('section', { class: 'panel sc-stepper', 'aria-labelledby': 'scnr-step-h' });
        R.stepPanel = stepPanel;
        R.stepBadge = el('span', { class: 'badge badge-accent' });
        stepPanel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'scnr-step-h', text: 'Follow the signal' }), el('span', { class: 'spacer' }), R.stepBadge]));
        const stepBody = el('div', { 'aria-live': 'polite' });
        R.stepTitle = el('div', { class: 'sc-step-title' });
        R.stepText = el('p', { class: 'sc-step-text' });
        stepBody.appendChild(R.stepTitle);
        stepBody.appendChild(R.stepText);
        stepPanel.appendChild(stepBody);
        const dots = el('div', { class: 'sc-dots', role: 'group', 'aria-label': 'Go to step' });
        R.dots = [];
        for (let i = 0; i < N_STEPS; i++) {
            const d = el('button', { type: 'button', class: 'sc-dot', 'aria-label': 'Step ' + (i + 1), text: String(i + 1) });
            d.addEventListener('click', function () { setStep(i); });
            R.dots.push(d);
            dots.appendChild(d);
        }
        stepPanel.appendChild(dots);
        R.prev = w.button({ label: 'Previous', size: 'sm', onClick: function () { if (T.step > 0) setStep(T.step - 1); } });
        R.next = w.button({ label: 'Start', size: 'sm', kind: 'primary', onClick: function () {
            if (T.step < 0) setStep(0);
            else if (T.step >= N_STEPS - 1) setStep(-1);
            else setStep(T.step + 1);
        } });
        R.exit = w.button({ label: 'Exit', size: 'sm', kind: 'ghost', onClick: function () { setStep(-1); } });
        stepPanel.appendChild(el('div', { class: 'row' }, [R.prev, R.next, el('span', { class: 'spacer' }), R.exit]));
        side.appendChild(stepPanel);

        // info panel
        R.info = el('section', { class: 'panel sc-info', id: 'scnr-info', 'aria-label': 'Component details' });
        R.infoStatus = el('div', { class: 'sr-only', 'aria-live': 'polite' });
        R.infoBody = el('div');
        const clearBtn = w.button({ label: 'Clear', size: 'xs', kind: 'ghost', title: 'Clear the selection', onClick: function () { select(null); } });
        R.info.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', text: 'Component details' }), el('span', { class: 'spacer' }), clearBtn]));
        R.info.appendChild(R.infoStatus);
        R.info.appendChild(R.infoBody);
        side.appendChild(R.info);
        top.appendChild(side);
        panel.appendChild(top);
        // While the sequence does not compile, the diagram, playback and calculator show the last one that did.
        if (w.staleBanner) w.staleBanner(panel, { what: 'scan', before: top });

        // Larmor calculator and the spec table
        const bottom = el('div', { class: 'split sc-bottom' });
        const lc = el('section', { class: 'panel sc-larmor', 'aria-labelledby': 'scnr-lc-h' });
        R.lcPanel = lc;
        lc.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'scnr-lc-h', text: 'Larmor calculator' }),
            el('span', { class: 'panel-sub', text: 'how a gradient turns position into frequency' })
        ]));
        const ctr = el('div', { class: 'controls' });
        // 0.01 mT/m steps, so the box can show a sequence's exact readout
        // gradient (1.88 mT/m for the spin echo) rather than snap to 2.0
        R.lcG = w.slider({ label: 'Gradient strength G', min: 0, max: GMAX, step: 0.00001, value: LC.G, unit: 'mT/m', scale: 1000,
            onInput: function (v) { LC.G = v; updateLarmor(); } });
        R.lcX = w.slider({ label: 'Position x', min: -0.15, max: 0.15, step: 0.001, value: LC.x, unit: 'mm', scale: 1000,
            onInput: function (v) { LC.x = v; updateLarmor(); } });
        ctr.appendChild(R.lcG);
        ctr.appendChild(R.lcX);
        lc.appendChild(ctr);
        R.lc = {};
        const stat = function (label, unit) {
            const v = el('span', { class: 'stat-value' });
            const u = el('span', { class: 'stat-unit', text: unit });
            const node = el('div', { class: 'stat' }, [el('div', { class: 'stat-label', text: label }), el('div', {}, [v, u])]);
            return { node: node, v: v, u: u };
        };
        const sB = stat('Field at x, B', 'T'), sF = stat('Larmor frequency', 'MHz'), sD = stat('Offset from f0', 'kHz'), sP = stat('Per millimetre', 'Hz/mm');
        R.lc.B = sB.v; R.lc.Bsub = sB.u; R.lc.f = sF.v; R.lc.df = sD.v; R.lc.perMm = sP.v;
        lc.appendChild(el('div', { class: 'stats' }, [sB.node, sF.node, sD.node, sP.node]));
        R.lc.eq = el('div', { class: 'sc-eq', 'aria-label': 'Worked equation' });
        lc.appendChild(R.lc.eq);
        R.lc.plot = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        R.lc.plot.setAttribute('class', 'sc-lplot');
        R.lc.plot.setAttribute('role', 'img');
        lc.appendChild(w.legend([
            { label: 'f \u2212 f0 = \u03b3\u0304 G x', color: 'var(--seq-gx)', line: true },
            { label: 'a 160 mm head', color: 'var(--sc-skin)' },
            { label: 'receiver window of the current sequence', color: 'var(--seq-adc)' }
        ]));
        lc.appendChild(R.lc.plot);
        lc.appendChild(el('p', { class: 'mb-1', html: 'This is <b>frequency encoding</b>: while the readout gradient is on, every position x precesses at its own frequency, so the echo is a sum of frequencies and its Fourier transform is the profile of the object along x.' }));
        R.lc.note = el('p', { class: 'note mb-1' });
        lc.appendChild(R.lc.note);
        R.lc.ro = el('p', { class: 'note mb-1' });
        lc.appendChild(R.lc.ro);
        R.lc.use = w.button({ label: 'Use this sequence’s gradient', size: 'sm', onClick: function () {
            const ro = readoutGradient();
            if (!ro) return;
            LC.G = U.clamp(ro.G, 0, GMAX);
            LC.x = U.clamp(ro.fov / 2, -0.15, 0.15);
            R.lcG.set(LC.G); R.lcX.set(LC.x);
            updateLarmor();
        } });
        lc.appendChild(el('div', { class: 'row' }, [R.lc.use]));
        bottom.appendChild(lc);

        const specs = el('section', { class: 'panel sc-specs', 'aria-labelledby': 'scnr-spec-h' });
        specs.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'scnr-spec-h', text: 'Hardware at a glance' })]));
        specs.appendChild(w.statTable([
            ['Main field B0', '3 T, superconducting, always on'],
            ['Larmor frequency f0', '127.73 MHz (γ̄ = 42.58 MHz/T)'],
            ['Patient bore', '60 cm (70 cm wide bore)'],
            ['B0 over the head, before shimming', 'a few ppm (1 ppm = 128 Hz)'],
            ['Gradient strength', '45 mT/m per axis'],
            ['Slew rate', '200 T/m/s (0 to 45 mT/m in 225 µs)'],
            ['Gradient raster (simulator)', '10 µs'],
            ['RF transmit', 'body coil, peak B1 about 15 to 25 µT'],
            ['RF amplifier', 'about 30 to 35 kW peak'],
            ['SAR limits, normal mode', '2 W/kg whole body, 3.2 W/kg head'],
            ['Receive', '8-channel head coil or the body coil'],
            ['Cryogen', 'about 1500 L liquid helium, 4.2 K'],
            ['Proton polarisation', 'about 1 in 100 000 at 3 T'],
            ['Acoustic noise', 'often above 100 dB(A)']
        ], { compact: true }));
        specs.appendChild(el('p', { class: 'note mt-1 mb-0', text: 'Typical values for a clinical 3 T scanner; individual systems differ. The simulator uses Gmax, the slew rate, the raster and f0 exactly as listed.' }));
        bottom.appendChild(specs);
        panel.appendChild(bottom);

        wireEvents();
        renderStepper();
        renderInfo();
        renderCoilNote();
        updateLarmor();
        goIdle();
        T.mounted = true;
    }

    function renderCoilNote() {
        if (!R.coilNote) return;
        const body = S().coilType === 'body';
        R.coilNote.innerHTML = body
            ? '<strong>Body coil receiving:</strong> one large birdcage with a uniform sensitivity, but it picks up thermal noise from the head, neck and shoulders, so the SNR is lower than with the 8-channel head coil everywhere in the head: about 1.6 times lower at the centre and about three times lower near the cortex.'
            : '<strong>8-channel head coil receiving:</strong> each small loop sits close to the head and picks up noise from only a small volume, so the SNR is higher than with the body coil everywhere in the head: about 1.6 times at the centre and about three times near the cortex. The array also makes SENSE possible. A root-sum-of-squares image is brighter near the elements than in the centre; Roemer combination (the default in the Image tab) removes that shading.';
    }

    /* ---------- events ---------- */
    function compOf(target) {
        const n = target && target.closest ? target.closest('[data-c]') : null;
        return n ? n.getAttribute('data-c') : null;
    }
    function moveRove(delta, abs) {
        const list = visibleComps();
        let i = list.findIndex(function (c) { return c.id === T.rove; });
        if (i < 0) i = 0;
        if (abs === 'first') i = 0;
        else if (abs === 'last') i = list.length - 1;
        else i = (i + delta + list.length) % list.length;
        T.rove = list[i].id;
        applyRove();
        const p = primaryEl(T.rove);
        if (p) { try { p.focus({ preventScroll: false }); } catch (e) { p.focus(); } }
    }
    function wireEvents() {
        const fig = R.fig;
        fig.addEventListener('pointerover', function (e) { setHover(compOf(e.target)); });
        fig.addEventListener('pointerleave', function () { setHover(T.focusId); });
        fig.addEventListener('click', function (e) {
            const id = compOf(e.target);
            if (!id) return;
            select(id, { reveal: true });
        });
        fig.addEventListener('focusin', function (e) {
            const id = compOf(e.target);
            if (!id) return;
            T.rove = id;
            applyRove();
            setFocusMark(id);
            setHover(id);
        });
        fig.addEventListener('focusout', function (e) {
            if (e.relatedTarget && fig.contains(e.relatedTarget)) return;
            setFocusMark(null);
            setHover(null);
        });
        fig.addEventListener('keydown', function (e) {
            const id = compOf(e.target);
            if (!id) return;
            switch (e.key) {
                case 'ArrowRight': case 'ArrowDown': e.preventDefault(); moveRove(1); break;
                case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); moveRove(-1); break;
                case 'Home': e.preventDefault(); moveRove(0, 'first'); break;
                case 'End': e.preventDefault(); moveRove(0, 'last'); break;
                case 'Enter': case ' ': e.preventDefault(); select(id, { reveal: true }); break;
                case 'Escape': if (T.selected) { e.preventDefault(); select(null); } break;
                default: break;
            }
        });

        // Rebuild the figure when its width crosses the layout breakpoint.
        if (root.ResizeObserver) {
            let pending = false;
            const ro = new root.ResizeObserver(function () {
                if (pending) return;
                pending = true;
                raf(function () { pending = false; if (T.visible) buildFigure(false); });
            });
            ro.observe(R.figWrap);
        }

        const bus = MRI.bus;
        bus.on('playback:tick', onTick);
        bus.on('scan:start', function (e) {
            if (!T.visible) return;
            goIdle(e && e.animate ? 'Computing the scan; playback starts in a moment…' : 'Computing the scan (instant, no playback)…');
        });
        bus.on('scan:done', function () { goIdle(); refreshLiveInfo(); });
        bus.on('scan:error', function (e) {
            if (e && e.stage === 'recon') return;
            goIdle(e && e.aborted ? 'Stopped. ' + idleText().replace(/^Idle\. /, '') : undefined);
        });
        bus.on('recon:done', function (e) { if (e && !e.partial) refreshLiveInfo(); });
        bus.on('coil:changed', function (e) {
            const type = e && e.coilType === 'body' ? 'body' : 'head8';
            if (R.coilSeg) R.coilSeg.set(type);
            applyCoil();
            applyRove();
            applySelection();
            if (T.step >= 0) { applyStep(); renderStepper(); }
            renderCoilNote();
            refreshLiveInfo();
        });
        bus.on('program:compiled', function () { refreshLiveInfo(); if (T.visible) updateLarmor(); else T.lcDirty = true; });
    }
    /* The info panel shows numbers of the current program; refresh it
       when they may have changed (cheap: one small table). */
    function refreshLiveInfo() {
        if (!T.visible) { T.infoDirty = true; return; }
        if (T.selected) {
            const c = COMP_BY_ID[T.selected];
            if (c && INFO[c.info] && INFO[c.info].live) renderInfo();
        }
    }

    function onShow() {
        T.visible = true;
        buildFigure(false);
        if (R.coilSeg) R.coilSeg.set(S().coilType === 'body' ? 'body' : 'head8');
        applyCoil();
        applyAll();
        renderCoilNote();
        if (T.infoDirty) { T.infoDirty = false; renderInfo(); }
        T.lcDirty = false;
        updateLarmor();          // also re-fits the plot to its width after a resize
        if (!S().scanning) goIdle();
        else if (R.live && R.live.getAttribute('data-state') === 'idle') R.liveIdle.textContent = 'Computing the scan…';
    }
    function onHide() {
        T.visible = false;
        T.pendingTick = null;
        goIdle();
    }

    MRI.ui.registerTab({ id: 'scanner', title: 'Scanner', order: 10, mount: mount, onShow: onShow, onHide: onHide });

    // exposed for the browser test
    MRI.ui._scanner = { T: T, steps: steps, INFO: INFO, COMPS: COMPS, layoutWide: wideLayout, layoutTall: tallLayout, renderTick: renderTick, goIdle: goIdle };
})(typeof window !== 'undefined' ? window : globalThis);
