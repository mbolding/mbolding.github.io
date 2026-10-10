/* ============================================================
   PET Simulator, Guide tab
   The landing page: a short welcome (what the simulator is, how
   the tabs follow the concepts, how scanning works) and fifteen
   guided lessons. Each lesson has a goal, a "Set up" button that
   puts the simulator into a known state for it, numbered things to
   try (some with a "do it" button), questions to answer and a
   one-line takeaway.

   Setting up a lesson always starts from the same clean slate:
   default physics, default reconstruction, the lesson's preset (which
   brings its phantom), the default analysis regions and the first
   frame; only then are the lesson's own changes applied. So lessons
   never leak into each other, whatever students did before.

   Changes go through PET.actions only. Protocol statements that have
   no param (the isotope, the energy and coincidence windows, time of
   flight) are changed by rewriting that one line of the protocol
   source, keeping the rest of the student's text as it is.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;
    if (!PET || !PET.ui || typeof PET.ui.registerTab !== 'function' || !PET.util || !root.document) return;
    const U = PET.util;
    const doc = root.document;
    const el = function (tag, attrs, children) { return U.el(tag, attrs, children); };
    const w = function () { return PET.ui.w; };
    const STORE = 'petSim.lessonsDone';
    const MIN = 60, MBq = 1e6;
    const DEFAULT_ANALYSIS = { roi: 'cortex', target: 'cortex', reference: 'cereb_gm' };

    const CSS = `
#tab-lessons .ls-welcome { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px 28px; }
#tab-lessons .ls-welcome h2 { font-size: 1.2rem; margin-bottom: 8px; }
#tab-lessons .ls-lead { font-size: 0.95rem; line-height: 1.6; }
#tab-lessons .ls-how { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; font-size: 0.88rem; line-height: 1.5; }
#tab-lessons .ls-how li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; align-items: start; }
#tab-lessons .ls-ico {
    width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
    background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-border);
}
#tab-lessons .ls-ico svg { width: 13px; height: 13px; }
#tab-lessons .ls-map-title { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
#tab-lessons .ls-map { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; counter-reset: lsmap; }
#tab-lessons .ls-map button {
    appearance: none; -webkit-appearance: none; width: 100%; height: auto; text-align: left; font: inherit; color: var(--fg); cursor: pointer; white-space: normal;
    display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 2px 10px; align-items: baseline;
    padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--card-2);
}
#tab-lessons .ls-map button:hover { border-color: var(--accent-border); background: var(--accent-soft); }
#tab-lessons .ls-map button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
#tab-lessons .ls-map .ls-n { font: 700 0.72rem var(--font-mono); color: var(--accent); grid-row: span 2; padding-top: 2px; }
#tab-lessons .ls-map .ls-t { font-weight: 650; font-size: 0.86rem; }
#tab-lessons .ls-map .ls-d { font-size: 0.78rem; color: var(--muted); line-height: 1.4; }
#tab-lessons .ls-start { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 14px; }
#tab-lessons .ls-list-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 22px 0 10px; }
#tab-lessons .ls-list-head h2 { margin: 0; font-size: 1.1rem; }
#tab-lessons .ls-progress { font-size: 0.82rem; color: var(--muted); }
#tab-lessons .ls-bar { width: 120px; height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
#tab-lessons .ls-bar > div { height: 100%; background: var(--good); width: 0; transition: width 0.2s ease; }
#tab-lessons .ls-group { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
#tab-lessons .ls-lesson {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); margin: 0 0 10px;
    box-shadow: var(--shadow-1);
}
#tab-lessons .ls-lesson[open] { border-color: var(--accent-border); }
#tab-lessons .ls-sum {
    list-style: none; cursor: pointer; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 4px 12px; align-items: center;
    padding: 12px 40px 12px 14px; position: relative; border-radius: var(--radius);
}
#tab-lessons .ls-sum::-webkit-details-marker { display: none; }
#tab-lessons .ls-sum::after {
    content: ""; position: absolute; right: 16px; top: 50%; width: 7px; height: 7px; margin-top: -6px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s ease;
}
#tab-lessons .ls-lesson:not([open]) > .ls-sum::after { transform: rotate(-45deg); margin-top: -4px; }
#tab-lessons .ls-sum:hover { background: var(--hover); }
#tab-lessons .ls-num {
    width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font: 700 0.84rem var(--font-mono);
    background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-border);
}
#tab-lessons .ls-lesson.is-done .ls-num { background: var(--good-soft); color: var(--good); border-color: var(--good-border); }
#tab-lessons .ls-sum-main { min-width: 0; }
#tab-lessons .ls-title { font-weight: 650; font-size: 0.98rem; line-height: 1.3; }
#tab-lessons .ls-goal-short { font-size: 0.82rem; color: var(--muted); line-height: 1.4; margin-top: 2px; }
#tab-lessons .ls-sum .badge { justify-self: end; }
#tab-lessons .ls-body { padding: 4px 18px 16px 60px; }
#tab-lessons .ls-setup {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 12px; margin: 4px 0 14px;
    border-radius: 8px; background: var(--card-2); border: 1px solid var(--border);
}
#tab-lessons .ls-setup p { flex: 1 1 260px; margin: 0; font-size: 0.84rem; color: var(--muted); line-height: 1.45; }
#tab-lessons .ls-cols { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 14px 28px; }
#tab-lessons .ls-h { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
#tab-lessons .ls-steps, #tab-lessons .ls-qs { margin: 0; padding: 0; list-style: none; font-size: 0.88rem; line-height: 1.55; }
#tab-lessons .ls-steps { counter-reset: lsstep; }
#tab-lessons .ls-steps li { counter-increment: lsstep; position: relative; padding-left: 30px; margin-bottom: 9px; }
#tab-lessons .ls-steps li::before {
    content: counter(lsstep); position: absolute; left: 0; top: 1px; width: 20px; height: 20px; border-radius: 50%;
    display: grid; place-items: center; font-size: 0.7rem; font-weight: 700;
    background: var(--card); color: var(--accent); border: 1px solid var(--accent-border);
}
#tab-lessons .ls-steps .btn { margin-left: 4px; vertical-align: 1px; color: var(--accent); border-color: var(--accent-border); }
#tab-lessons .ls-steps .btn:hover { background: var(--accent-soft); border-color: var(--accent); }
#tab-lessons .ls-qs { counter-reset: lsq; }
#tab-lessons .ls-qs li { counter-increment: lsq; position: relative; padding-left: 30px; margin-bottom: 9px; }
#tab-lessons .ls-qs li::before {
    content: "Q" counter(lsq); position: absolute; left: 0; top: 2px; font: 700 0.72rem var(--font-mono); color: var(--warn);
}
#tab-lessons .ls-take { margin: 14px 0 0; }
#tab-lessons .ls-take strong { color: var(--good); }
#tab-lessons .ls-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 12px; }
#tab-lessons .ls-sub { font-size: 0.75em; }
@media (max-width: 860px) {
    #tab-lessons .ls-welcome { grid-template-columns: minmax(0, 1fr); }
    #tab-lessons .ls-cols { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
    #tab-lessons .ls-body { padding: 2px 12px 14px; }
    #tab-lessons .ls-sum { grid-template-columns: 30px minmax(0, 1fr); padding: 10px 34px 10px 10px; }
    #tab-lessons .ls-sum .badge { grid-column: 2; justify-self: start; }
    #tab-lessons .ls-num { width: 26px; height: 26px; font-size: 0.78rem; }
}
`;

    /* ---------- the tabs, one concept each ---------- */
    const TAB_MAP = [
        { id: 'scanner', title: 'Scanner', d: 'Decays, coincidences and lines of response; trues, scatters and randoms.' },
        { id: 'tracer', title: 'Isotopes & tracers', d: 'Half-life, positron range, the tracers and their input functions.' },
        { id: 'protocol', title: 'Protocol', d: 'The scan written in a small language: dose, timing, windows, TOF.' },
        { id: 'phantom', title: 'Phantom', d: 'Test objects, and a brain in health, Alzheimer\'s and Parkinson\'s disease.' },
        { id: 'sinogram', title: 'Sinogram', d: 'What the scanner records, before any image exists.' },
        { id: 'recon', title: 'Reconstruction', d: 'From sinogram to image: backprojection, FBP, OSEM, TOF.' },
        { id: 'corrections', title: 'Degradations & corrections', d: 'Every physical effect beside its correction, switch by switch.' },
        { id: 'kinetics', title: 'Dynamic & quantification', d: 'Compartment models, SUV and SUVR, Patlak and Logan.' }
    ];
    const TAB_TITLE = {};
    TAB_MAP.forEach(function (t) { TAB_TITLE[t.id] = t.title; });

    /* ---------- the lessons ----------
       setup: { preset, phantom, phantomOpts, edits: [[keyword, statement, comment]],
                params: {NAME: valueSI}, physics, recon, analysis, afterScan }
       step.run uses the same fields (applied on top of the current state),
       plus resetPhysics / resetRecon, and step.tab says where to look. */
    const LESSONS = [
        {
            id: 'decay', group: 'Physics of detection', title: 'From decay to coincidence', tab: 'scanner',
            goal: 'See how one radioactive decay becomes one recorded event, and why some recorded events are wrong.',
            setupText: 'Loads the standard FDG brain scan (185 MBq, 45 min uptake, 10 min, time of flight on) with default physics and reconstruction, and opens the Scanner tab.',
            setup: { preset: 'fdg_static' },
            steps: [
                { html: 'Watch the animation. A positron leaves the nucleus and annihilates, and two 511 keV photons fly off back to back. When both stop in crystals within the coincidence window, a line of response (LOR) is drawn. Press <strong>Step</strong> to follow one decay at a time.' },
                { html: 'Turn on <strong>Keep LORs</strong>: the head appears from lines alone, although no single line says where along it the decay happened.' },
                { html: 'Tell the coincidences apart by colour: <strong>trues</strong> (blue), <strong>scatters</strong> (orange: a photon changed direction on its way out) and <strong>randoms</strong> (magenta: two photons from two different decays). Read the scatter and randoms fractions in the counts table.' },
                { html: 'Look at the measured-energy histogram: the 511 keV photopeak and, below it, the Compton continuum of scattered photons. The energy window keeps 435 to 650 keV.' },
                { html: 'Look at the time-difference histogram: trues and scatters pile up near zero, randoms spread evenly across the whole coincidence window.' },
                { html: 'Click the parts of the detection chain (crystal block, SiPMs, front-end, coincidence processor, sorter) to read what each one does.' }
            ],
            questions: [
                'Why are the two photons emitted back to back, and why does each carry 511 keV?',
                'A scattered coincidence passes the timing test. Why? Which test can reject it, and how well can it work with an energy resolution of 11 %?',
                'Randoms spread evenly over the time-difference histogram. What does that suggest about how to estimate them?'
            ],
            takeaway: 'The scanner never sees a decay: it records pairs of photons in time coincidence and assumes the decay lies on the line between them, and some of those lines are wrong.'
        },
        {
            id: 'isotopes', group: 'Physics of detection', title: 'Isotopes: half-life and positron range', tab: 'tracer',
            goal: 'Compare ¹⁸F with ¹⁵O: how long each lasts, how far its positron travels, and what that does to an image.',
            setupText: 'Loads the hot-rod phantom filled with 40 MBq of ¹⁸F (10 min scan), default physics and reconstruction, and opens the Isotopes & tracers tab.',
            setup: { preset: 'rods_f18' },
            steps: [
                { html: 'On the decay plot, compare the three half-lives: 110 min for ¹⁸F, 20 min for ¹¹C, 2 min for ¹⁵O. The frames of the current protocol are shaded on it.' },
                { html: 'Compare the positron range profiles. ¹⁸F positrons (mean range 0.6 mm) stop within about a millimetre; ¹⁵O positrons start with almost three times the energy and travel several millimetres (mean 3 mm), with a long tail.' },
                { html: 'Look at the rods on the Reconstruction tab and note the smallest sector whose rods you can still separate with ¹⁸F.', label: 'Show the image', run: { tab: 'recon' } },
                { html: 'Switch the isotope to ¹⁵O. This rewrites the <code>isotope</code> line of the protocol and raises DOSE to 140 MBq, so the 10 min scan sees about as many decays as before despite the 2 min half-life.',
                    label: 'Switch to ¹⁵O', tab: 'recon', run: { edits: [['isotope', 'isotope O15', '# set by the Guide: oxygen-15, mean positron range 3 mm']], params: { DOSE: 140 * MBq } } },
                { html: 'Compare the rods: the small sectors blur together. The detectors did not change; the extra blur is positron range. On the Degradations & corrections tab, switching positron range off (or modelling it in the reconstruction) shows how much of the blur it causes.' },
                { html: 'Go back to ¹⁸F at 40 MBq.', label: 'Back to ¹⁸F', tab: 'recon',
                    run: { edits: [['isotope', 'isotope F18', '# change to O15 (or C11) to see positron range blur the rods']], params: { DOSE: 40 * MBq } } }
            ],
            questions: [
                'Both isotopes emit identical 511 keV photons. Why does ¹⁵O give a blurrier image?',
                'Why is the full width at half maximum of a range profile much smaller than its mean range? Which part of the profile does the most damage to small structures?',
                'Why can an ¹⁸F tracer be shipped to a hospital two hours away, while a ¹⁵O study needs a cyclotron next door?'
            ],
            takeaway: 'Half-life decides the logistics and how many counts you get; the positron\'s energy decides its range, a blur specific to the isotope that no detector can remove.'
        },
        {
            id: 'sinogram', group: 'From data to image', title: 'The sinogram', tab: 'sinogram',
            goal: 'Understand what the scanner actually stores: counts per line of response, sorted by angle and by distance from the centre.',
            setupText: 'Loads four ¹⁸F line sources in air (5 MBq, 2 min), default physics and reconstruction, and opens the Sinogram tab.',
            setup: { preset: 'point_res' },
            steps: [
                { html: 'Each point source traces a sinusoid, r(θ) = x cos θ + y sin θ. The source at the centre is a straight line at r = 0; the source at x = 100 mm swings 100 mm to either side.' },
                { html: 'Compare the source at (100, 0) mm with the one at (0, −100) mm: the same amplitude, shifted by a quarter of the angular range.' },
                { html: 'Hover over the sinogram to see the line of response of each bin on the ring (click to keep it), and click a point of the object in the ring panel to draw its sinusoid on the sinogram.' },
                { html: 'Put the sources in a 20 cm water cylinder: the sinusoids dim where their lines cross more water (attenuation), and a smooth haze of scatter appears, extending outside the object as <em>tails</em>.',
                    label: 'Sources in water', run: { phantomOpts: { medium: 'water' } } },
                { html: 'Read the counts table (trues, scatter, randoms, NEC and the scatter and randoms fractions) in air and in water.', label: 'Back to air', run: { phantomOpts: { medium: 'air' } } }
            ],
            questions: [
                'What sets the amplitude and the phase of a point\'s sinusoid?',
                'Why does a sinogram need only angles from 0 to 180 degrees?',
                'In the water version, what are the counts outside the object made of?'
            ],
            takeaway: 'The sinogram is the raw measurement: every point of the object traces its own sinusoid, and reconstruction has to untangle them all.'
        },
        {
            id: 'fbp', group: 'From data to image', title: 'Backprojection and filtering', tab: 'recon',
            goal: 'See why smearing the projections back gives a blurred image, and how the ramp filter and its window repair it.',
            setupText: 'Loads the hot and cold sphere phantom (¹⁸F, 50 MBq, 10 min) with default physics, sets plain backprojection without time of flight or post-filter, and opens the Reconstruction tab.',
            setup: { preset: 'spheres_iq', recon: { method: 'bp', tof: false, postFilter: 0 } },
            steps: [
                { html: 'Plain backprojection spreads every count evenly along its line. The spheres are there, but sit in a broad haze that falls off as 1/r around everything bright.' },
                { html: 'Switch to filtered backprojection with the pure <strong>ramp</strong> filter: the haze is gone and edges are sharp, but the image is noisy, because the ramp boosts high spatial frequencies and those are mostly noise.',
                    label: 'FBP, ramp', run: { recon: { method: 'fbp', filter: 'ramp', cutoff: 1, postFilter: 0 } } },
                { html: 'Use a <strong>Hann</strong> window: it rolls the ramp off towards the cutoff, so there is less noise and slightly softer edges. Compare the filter responses in the plot.',
                    label: 'FBP, Hann', run: { recon: { method: 'fbp', filter: 'hann', cutoff: 1, postFilter: 0 } } },
                { html: 'Lower the cutoff to half the Nyquist frequency: smoother still, but the small hot spheres lose contrast. Resolution has been traded for noise.',
                    label: 'Cutoff 0.5', run: { recon: { method: 'fbp', filter: 'hann', cutoff: 0.5, postFilter: 0 } } },
                { html: 'Try Shepp-Logan, Hamming and Butterworth yourself, and look for the radial streaks FBP leaves around hot objects.' }
            ],
            questions: [
                'Why does backprojection alone give a 1/r blur?',
                'The ramp filter is exact for perfect data. Why is it a poor choice for PET data on its own?',
                'What do you gain and what do you give up by lowering the cutoff frequency?'
            ],
            takeaway: 'FBP undoes the backprojection blur with a ramp filter and tames the noise with a window; the cutoff trades resolution against noise.'
        },
        {
            id: 'osem', group: 'From data to image', title: 'Iterative reconstruction and noise', tab: 'recon',
            goal: 'Watch OSEM converge: contrast comes first, noise follows, and someone has to decide when to stop.',
            setupText: 'Loads the sphere phantom with default physics, sets OSEM to 10 iterations of 12 subsets with no post-filter (every iteration is kept for the Iteration explorer), and opens the Reconstruction tab.',
            setup: { preset: 'spheres_iq', recon: { method: 'osem', iterations: 10, subsets: 12, postFilter: 0 } },
            steps: [
                { html: 'In the <strong>Iteration explorer</strong>, press Play or drag the Iteration slider: after one iteration the image is smooth; with each further iteration the small spheres sharpen and their contrast rises.' },
                { html: 'Watch the convergence plot beside it: the recovery levels off while the noise keeps growing.' },
                { html: 'Add a 4 mm Gaussian post-filter: the noise drops and a little resolution is lost, much as if you had stopped earlier.',
                    label: 'Post-filter 4 mm', run: { recon: { postFilter: 4 } } },
                { html: 'Compare with MLEM, which uses every angle in each update: it needs about as many iterations as OSEM has subsets times iterations to reach the same image.',
                    label: 'MLEM, 10 iterations', run: { recon: { method: 'mlem', iterations: 10, postFilter: 0 } } },
                { html: 'Go back to the defaults (OSEM, 4 iterations of 12 subsets, 3 mm post-filter).', label: 'Defaults', run: { resetRecon: true } }
            ],
            questions: [
                'Why does the noise keep growing with iterations after the mean has settled?',
                'Why do small spheres need more iterations to reach their final contrast than large ones?',
                'FBP subtracts the randoms and scatter estimates from the data. What does OSEM do with them instead, and why is that better for low counts?'
            ],
            takeaway: 'OSEM models the scanner and the Poisson statistics of the counts: more iterations bring both contrast and noise, so clinical images stop early or post-filter.'
        },
        {
            id: 'counts', group: 'From data to image', title: 'Counts and noise', tab: 'protocol',
            goal: 'Link image noise to the number of detected counts, and the counts to dose, scan time and decay.',
            setupText: 'Loads the standard FDG brain scan (185 MBq, 45 min uptake, 10 min) with default physics and reconstruction, and opens the Protocol tab, where the DOSE, UPTAKE and DUR sliders are.',
            setup: { preset: 'fdg_static' },
            steps: [
                { html: 'Note the number of trues in the summary under the scan bar (about 2 million) and look at the image on the Reconstruction tab, with its ROI statistics.' },
                { html: 'Lower the dose to 40 MBq: less than a quarter of the counts, so the noise (the coefficient of variation in an ROI) grows by about √4.6 ≈ 2.1.',
                    label: 'DOSE 40 MBq', tab: 'recon', run: { params: { DOSE: 40 * MBq } } },
                { html: 'Keep 185 MBq but scan for 2 min instead of 10: a fifth of the counts and about the same noise as the low dose. It is the counts that matter.',
                    label: 'DUR 2 min', tab: 'recon', run: { params: { DOSE: 185 * MBq, DUR: 2 * MIN } } },
                { html: 'Back to 185 MBq for 10 min.', label: 'Back to standard', run: { params: { DOSE: 185 * MBq, DUR: 10 * MIN } } },
                { html: 'Load the PiB protocol (carbon-11, half-life 20 min) and start the scan at 90 min instead of 50 min: two more half-lives, so a quarter of the counts. Watch the timeline on this tab.',
                    label: 'PiB at 90 min', run: { preset: 'pib_static', params: { UPTAKE: 90 * MIN } } },
                { html: 'Compare with PiB at its usual 50 min.', label: 'PiB at 50 min', run: { preset: 'pib_static', params: { UPTAKE: 50 * MIN } } }
            ],
            questions: [
                'If you halve the counts, by how much does the noise in an ROI change?',
                'A clinic wants to halve the injected dose. How much longer must it scan to keep the same image quality, ignoring decay during the scan?',
                'Why is a higher dose not always better? (Think about randoms: lesson 9.)'
            ],
            takeaway: 'Noise falls as 1/√counts, and the counts are proportional to the dose, the scan time and the fraction of the activity not yet decayed.'
        },
        {
            id: 'attenuation', group: 'Degradations and corrections', title: 'Attenuation and its correction', tab: 'corrections',
            goal: 'See what attenuation does to a uniform object, and what attenuation correction does when it is needed and when it is not.',
            setupText: 'Loads the uniform 20 cm cylinder (¹⁸F, 40 MBq, 10 min) with default physics and reconstruction, and opens the Degradations & corrections tab.',
            setup: { preset: 'cyl_uniform' },
            steps: [
                { html: 'With attenuation and its correction both on, the cylinder is flat at about 6.4 kBq/mL.' },
                { html: 'Switch attenuation correction off: the middle is too cold and every value is several times too low, because pairs from the middle cross the most water.',
                    label: 'Correction off', run: { recon: { corrections: { attenuation: false } } } },
                { html: 'Now the opposite: no attenuation in the physics, but the correction still on. Nothing was absorbed, yet every line is multiplied by e<sup>∫μ</sup>: the image is far too hot, most of all in the middle.',
                    label: 'Physics off, correction on', run: { physics: { attenuation: false }, recon: { corrections: { attenuation: true } } } },
                { html: 'Both back on.', label: 'Both on', run: { physics: { attenuation: true }, recon: { corrections: { attenuation: true } } } },
                { html: 'Try the brain without attenuation correction: deep structures look dim and the edge of the head bright.',
                    label: 'Brain, no correction', run: { preset: 'fdg_static', recon: { corrections: { attenuation: false } } } }
            ],
            questions: [
                'For a line through the centre of a 20 cm water cylinder (μ = 0.096 /cm), what fraction of photon pairs survives?',
                'Why does attenuation of a coincidence depend only on its line, not on where along the line the decay happened?',
                'Why does correcting for attenuation that is not there produce the opposite artifact?'
            ],
            takeaway: 'Attenuation depends on the whole line through the body, so it is corrected line by line from a mu map, and the correction is only as good as the mu map.'
        },
        {
            id: 'scatter', group: 'Degradations and corrections', title: 'Scatter and the energy window', tab: 'sinogram',
            goal: 'Measure how the lower energy threshold changes the amount of scatter, and why scatter correction is still needed.',
            setupText: 'Loads the hot and cold sphere phantom (¹⁸F, 50 MBq, 10 min) with default physics and reconstruction, and opens the Sinogram tab.',
            setup: { preset: 'spheres_iq' },
            steps: [
                { html: 'Read the scatter fraction in the counts table (energy window 435 to 650 keV), and find the scatter tails outside the object in the radial profile.' },
                { html: 'Lower the window\'s lower level to 350 keV: many more scattered photons pass, the scatter fraction rises, and the protocol warns you.',
                    label: 'Lower level 350 keV', run: { edits: [['energy', 'energy 350 keV .. 650 keV', '# set by the Guide']] } },
                { html: 'Raise it to 450 keV: fewer scatters, and slightly fewer trues, because with 11 % energy resolution the low side of the photopeak starts to be cut. Push the lower level higher in the Protocol tab and the loss of trues grows quickly.',
                    label: 'Lower level 450 keV', run: { edits: [['energy', 'energy 450 keV .. 650 keV', '# set by the Guide']] } },
                { html: 'Back to 435 keV.', label: '435 keV', run: { edits: [['energy', 'energy 435 keV .. 650 keV', '']] } },
                { html: 'Switch scatter correction off and look at the Reconstruction tab: the cold spheres and the lung insert fill in with a haze, and the hot spheres lose contrast.',
                    label: 'Scatter correction off', tab: 'recon', run: { recon: { corrections: { scatter: false } } } },
                { html: 'Switch it back on.', label: 'Correction on', tab: 'recon', run: { recon: { corrections: { scatter: true } } } }
            ],
            questions: [
                'A 511 keV photon that scatters through 30 degrees keeps how much energy? (Compton: E′ = 511 keV / (2 − cos θ).) Would a 450 keV threshold reject it?',
                'Why does raising the lower level also lose true events?',
                'The scatter estimate is scaled to fit the sinogram tails. Why the tails?'
            ],
            takeaway: 'The energy window is only a coarse scatter filter; the rest is removed by a scatter model scaled to the tails of the sinogram.'
        },
        {
            id: 'randoms', group: 'Degradations and corrections', title: 'Randoms and the timing window', tab: 'sinogram',
            goal: 'See how randoms grow with the activity and with the coincidence window, and compare two ways of estimating them.',
            setupText: 'Loads the FDG brain scan at its highest dose (400 MBq) with time of flight off (so the coincidence window alone decides which randoms are kept), default physics and reconstruction, and opens the Sinogram tab.',
            setup: { preset: 'fdg_static', params: { DOSE: 400 * MBq }, edits: [['tof', 'tof off', '# set by the Guide: without TOF the window alone limits randoms']] },
            steps: [
                { html: 'Read trues and randoms in the counts table and compare with the standard 185 MBq: trues roughly double, randoms grow more than four times, because a random needs two unrelated photons.',
                    label: '185 MBq', run: { params: { DOSE: 185 * MBq } } },
                { html: 'Back at 400 MBq, widen the coincidence window to 9 ns: randoms double again (they scale with the window), trues hardly change.',
                    label: '400 MBq, 9 ns', run: { params: { DOSE: 400 * MBq }, edits: [['coincidence', 'coincidence 9 ns', '# set by the Guide']] } },
                { html: 'Narrow it to 3 ns: fewer randoms, and still nearly every true, since in this ring the two photons of a pair arrive at most about 1 ns apart.',
                    label: '3 ns', run: { edits: [['coincidence', 'coincidence 3 ns', '# set by the Guide']] } },
                { html: 'Back to 4.5 ns with time of flight on (400 ps): the scanner keeps only randoms whose time difference fits inside its TOF bins (about ±1.1 ns), so roughly half of them are gone before any correction.',
                    label: '4.5 ns, TOF on', run: { edits: [['coincidence', 'coincidence 4.5 ns', ''], ['tof', 'tof on 400 ps', '']] } },
                { html: 'Reconstruct with FBP, which subtracts the delayed-window randoms estimate: that estimate is as noisy as the randoms themselves.',
                    label: 'FBP', tab: 'recon', run: { recon: { method: 'fbp' } } },
                { html: 'Use the smooth estimate from the singles rates instead: the same randoms are removed without adding their noise.',
                    label: 'Singles estimate', tab: 'recon', run: { recon: { method: 'fbp', corrections: { randomsMethod: 'singles' } } } },
                { html: 'Switch randoms correction off: a flat background covers the whole field of view, even outside the head.',
                    label: 'Randoms correction off', tab: 'recon', run: { recon: { corrections: { randoms: false } } } }
            ],
            questions: [
                'The randoms rate is about 2τS₁S₂. Doubling the dose doubles the singles. What happens to the randoms, and to the ratio of randoms to trues?',
                'Why can the coincidence window not be made much shorter than the largest time difference of a true pair plus the timing resolution?',
                'Why is the delayed-window estimate noisy, and why does that matter more for FBP than for OSEM?'
            ],
            takeaway: 'Randoms grow with the square of the activity and in proportion to the coincidence window; they are measured with a delayed window or computed from singles rates, and removed.'
        },
        {
            id: 'tof', group: 'Degradations and corrections', title: 'Time of flight', tab: 'recon',
            goal: 'See what the arrival-time difference adds, and how much depends on the timing resolution.',
            setupText: 'Loads the sphere phantom with time of flight on (coincidence timing resolution 400 ps) and default physics, sets OSEM to 2 iterations of 12 subsets so the speed of convergence shows, and opens the Reconstruction tab.',
            setup: { preset: 'spheres_iq', recon: { method: 'osem', iterations: 2, subsets: 12, tof: true } },
            steps: [
                { html: 'With TOF each event is placed along its line to within about 6 cm (FWHM) instead of anywhere on it. Note the contrast of the small hot spheres after 2 iterations.' },
                { html: 'Reconstruct the same data without its TOF information: at equal iterations the spheres are less sharp and the background noisier.',
                    label: 'Without TOF', run: { recon: { tof: false } } },
                { html: 'TOF back on.', label: 'With TOF', run: { recon: { tof: true } } },
                { html: 'Improve the timing resolution to 200 ps (rewrites the <code>tof</code> line): each event is localised to about 3 cm, so the image converges faster with less noise.',
                    label: 'CTR 200 ps', run: { edits: [['tof', 'tof on 200 ps', '# set by the Guide']] } },
                { html: 'Worsen it to 600 ps, then go back to 400 ps.', label: 'CTR 600 ps', run: { edits: [['tof', 'tof on 600 ps', '# set by the Guide']] } },
                { html: 'Back to 400 ps.', label: 'CTR 400 ps', run: { edits: [['tof', 'tof on 400 ps', '# TOF lifts small-sphere contrast at equal noise']] } }
            ],
            questions: [
                'A timing resolution of 400 ps localises the annihilation to Δx = cΔt/2. How far is that? Is it better or worse than the detector resolution?',
                'Why does TOF reduce noise more in a large patient than in a small one?',
                'Why does TOF not make a fully converged image sharper?'
            ],
            takeaway: 'Time of flight localises each event to a few centimetres along its line: images converge faster and with less noise, while the detectors still set the resolution.'
        },
        {
            id: 'pve', group: 'Quantification', title: 'Partial volume and resolution', tab: 'corrections',
            goal: 'See why small or thin structures read low, and what resolution modelling and partial-volume correction can recover.',
            setupText: 'Loads the sphere phantom (hot spheres at 4 : 1) with default physics and reconstruction, and opens the Degradations & corrections tab.',
            setup: { preset: 'spheres_iq' },
            steps: [
                { html: 'In the <strong>Detector resolution (partial volume)</strong> card, read the recovery coefficients of the hot spheres: the largest hot sphere recovers most of its contrast, the 10 mm sphere much less.' },
                { html: 'Model the detector resolution inside OSEM (PSF) and run 8 iterations: the small spheres recover more, and a slight overshoot appears at their edges.',
                    label: 'PSF, 8 iterations', run: { recon: { psf: true, iterations: 8 } } },
                { html: 'In the same card, compare the observed values with the geometric transfer matrix (GTM) corrected ones and the truth. GTM needs the anatomy (the regions) and the resolution.' },
                { html: 'The same effect in anatomy: on the brain, the 3 mm cortical ribbon reads well below its true SUV under Static quantification.',
                    label: 'Show the cortex', tab: 'kinetics', run: { preset: 'fdg_static', resetRecon: true, analysis: { target: 'cortex', reference: 'cereb_gm' } } }
            ],
            questions: [
                'A sphere smaller than two or three times the FWHM reads low even with perfect counts. Why?',
                'Why do the cold spheres read too warm?',
                'What does the GTM correction need to know, and what goes wrong if the anatomy is misregistered with the PET image?'
            ],
            takeaway: 'Finite resolution spreads activity out of small and thin structures and into cold ones; PSF modelling and partial-volume correction recover part of it.'
        },
        {
            id: 'motion', group: 'Quantification', title: 'Motion and a misaligned mu map', tab: 'corrections',
            goal: 'See how head motion and a mu map that does not match the emission data bias the image.',
            setupText: 'Loads the FDG brain scan, makes the head step 6 mm sideways halfway through the scan, keeps the default reconstruction, and opens the Degradations & corrections tab.',
            setup: { preset: 'fdg_static', physics: { motion: { on: true, kind: 'step', dx: 6, dy: 0, rot: 0, at: 0.5 } } },
            steps: [
                { html: 'With motion and no correction, edges are blurred or doubled sideways, and for half of the scan the attenuation correction (made at the starting position) no longer lines up.' },
                { html: 'Switch motion correction on: each event is moved back to the starting position using the (perfect) motion tracking, and the image is sharp again.',
                    label: 'Motion correction on', run: { recon: { corrections: { motion: true } } } },
                { html: 'No motion now, but the mu map used for correction is shifted 8 mm: one side of the head is over-corrected (too hot), the other under-corrected (too cold), most clearly near the skull.',
                    label: 'Mu map shifted 8 mm', run: { physics: { motion: { on: false }, muMap: { dx: 8, dy: 0, rot: 0, model: 'ct' } }, recon: { corrections: { motion: false } } } },
                { html: 'An MR-based mu map without bone: the skull is treated as soft tissue, as a simple MR attenuation map would. The cortex next to the skull reads low.',
                    label: 'Mu map without bone', run: { physics: { muMap: { dx: 0, dy: 0, rot: 0, model: 'nobone' } } } },
                { html: 'Put everything back.', label: 'Reset', run: { resetPhysics: true, resetRecon: true } }
            ],
            questions: [
                'Why does a shifted mu map make one side too hot and the other too cold?',
                'Ignoring bone lowers cortical values more than values in the middle of the brain. Why?',
                'Motion correction here uses perfect tracking. What limits it in practice?'
            ],
            takeaway: 'Emission and attenuation data must line up: motion and mu-map errors bias the numbers, not just the sharpness.'
        },
        {
            id: 'suv', group: 'Quantification', title: 'Static quantification: SUV and SUVR', tab: 'kinetics',
            goal: 'Measure SUV and SUVR on an FDG scan and find out what they depend on: uptake time, decay correction and the reference region.',
            setupText: 'Loads the FDG brain scan (185 MBq, 45 min uptake, 10 min) with default physics and reconstruction, takes the cortex as target and cerebellar gray matter as reference, and opens Dynamic & quantification.',
            setup: { preset: 'fdg_static', analysis: { target: 'cortex', reference: 'cereb_gm' } },
            steps: [
                { html: 'Under <strong>Static quantification</strong>, compare the cortex SUVmean measured on the image with the true value (about 6.9 for gray matter at 45 to 55 min). The measured value is lower: partial volume of the thin cortical ribbon.' },
                { html: 'Start the scan at 60 min instead of 45: FDG keeps accumulating, so SUV and SUVR both rise. An SUV depends on when it was measured.',
                    label: 'UPTAKE 60 min', run: { params: { UPTAKE: 60 * MIN } } },
                { html: 'Switch decay correction off: every SUV drops by the decay factor (about two thirds at this time: the activity left on average during the frame), but the SUVR does not change, because both regions decayed alike.',
                    label: 'Decay correction off', run: { recon: { corrections: { decay: false } } } },
                { html: 'Decay correction back on, uptake back to 45 min.', label: 'Back to standard', run: { recon: { corrections: { decay: true } }, params: { UPTAKE: 45 * MIN } } },
                { html: 'Take white matter as the reference: the ratio jumps to about 2.5, the gray to white matter contrast. An SUVR means nothing without its reference.',
                    label: 'Reference: white matter', run: { analysis: { reference: 'white_matter' } } },
                { html: 'Lower the dose to 100 MBq (reference back to the cerebellum): SUV hardly changes, because it divides by the dose; only the noise grows.',
                    label: 'DOSE 100 MBq', run: { params: { DOSE: 100 * MBq }, analysis: { reference: 'cereb_gm' } } }
            ],
            questions: [
                'Why does SUVR not care about decay correction, while SUV does?',
                'Why does the SUV of FDG keep rising with uptake time, and why do clinics fix the uptake time?',
                'What makes a good reference region? Why is the cerebellum the usual choice?'
            ],
            takeaway: 'SUV normalises for dose and body size, and SUVR also cancels global factors, but both depend on the timing, the reference region and partial volume.'
        },
        {
            id: 'dynamic', group: 'Quantification', title: 'Dynamic PET and compartment models', tab: 'kinetics',
            goal: 'Analyse a dynamic FDG study with a Patlak plot and connect the result to the rate constants of the compartment model.',
            setupText: 'Loads the dynamic FDG protocol (20 frames over 60 min) with default physics and reconstruction, takes the cortex as target and cerebellar gray matter as reference, opens Dynamic & quantification, and reconstructs every frame once the scan is done (a few seconds).',
            setup: { preset: 'fdg_dynamic', analysis: { target: 'cortex', reference: 'cereb_gm' }, afterScan: 'reconAll' },
            steps: [
                { html: 'In the <strong>compartment model explorer</strong> (FDG, frontal cortex) k₄ is 0: FDG-6-phosphate is trapped. Raise k₃ and watch the trapped pool and K<sub>i</sub> grow; halve K₁ to mimic reduced delivery.' },
                { html: 'Under <strong>Dynamic analysis</strong>, compare the time-activity curves measured on the frames (points) with the true frame means (dashed lines). The cortex reads low on the images: partial volume again.' },
                { html: 'Read the <strong>Patlak plot</strong>: after about 20 min the points fall on a line whose slope is K<sub>i</sub>. On the true curves it matches the true K<sub>i</sub> of the voxel, about 0.032 mL/min/mL.' },
                { html: 'Switch the input function to <strong>image-derived</strong>: the small venous sinus underestimates the blood curve, which pushes K<sub>i</sub> from the images up. Here that partly cancels the partial-volume loss of the cortex curve: two errors offsetting each other, not a correct measurement.' },
                { html: 'Move t* earlier and later: too early, and the fit includes the curved start of the plot.' },
                { html: 'Load the [¹⁵O]water study: for a freely diffusible tracer a one-tissue fit gives the cerebral blood flow K₁ (about 0.55 mL/min/mL in gray matter).',
                    label: 'Load [¹⁵O]water', run: { preset: 'water_dynamic', analysis: { target: 'cortex', reference: 'cereb_gm' }, afterScan: 'reconAll' } }
            ],
            questions: [
                'Why is the slope of the Patlak plot K<sub>i</sub> = K₁k₃/(k₂ + k₃)?',
                'Why do dynamic protocols use short frames at first and long frames later?',
                'An image-derived input spares the patient an arterial line. What does it cost, and how could it be corrected?'
            ],
            takeaway: 'A dynamic scan with an input function measures rates, not just amounts; Patlak turns the curves of a trapped tracer into K<sub>i</sub> with a straight line.'
        },
        {
            id: 'binding', group: 'Quantification', title: 'Amyloid and dopamine imaging: is SUVR the binding?', tab: 'kinetics',
            goal: 'Compare SUVR with the true binding for amyloid and dopamine-transporter tracers, and find out when and why they differ.',
            setupText: 'Loads the PiB amyloid scan (50 to 70 min) of an Alzheimer brain with default physics and reconstruction, takes frontal cortex as target and cerebellar gray matter as reference, and opens Dynamic & quantification.',
            setup: { preset: 'pib_static', analysis: { target: 'gm_frontal', reference: 'cereb_gm' } },
            steps: [
                { html: 'Under <strong>Static quantification</strong>, the noise-free SUVR of frontal cortex is about 2.8, but the true DVR is 2.5 (BP<sub>ND</sub> 1.5). Read how the difference splits into kinetic and imaging bias.' },
                { html: 'Under <strong>SUVR over time</strong>, the ratio passes the DVR at about 23 min, peaks near 40 min and stays above it: at 50 to 70 min it overshoots by about 11 % (transient equilibrium). Compare when specific binding peaks.' },
                { html: 'Look at a healthy brain: cortex SUVR falls to about 1.2, little amyloid. White matter stays bright from nonspecific retention.',
                    label: 'Healthy brain', run: { phantomOpts: { condition: 'normal' } } },
                { html: 'Back to Alzheimer\'s disease, now with frontal cortex as the reference and temporal cortex as the target: a reference full of plaques makes the ratio collapse towards 1, although the target is full of amyloid.',
                    label: 'Wrong reference', run: { phantomOpts: { condition: 'ad' }, analysis: { target: 'gm_temporal', reference: 'gm_frontal' } } },
                { html: 'Run the dynamic PiB study: once every frame is reconstructed, the Logan plot recovers the DVR (about 2.47 from the true curves) without the overshoot.',
                    label: 'Dynamic PiB, Logan', run: { preset: 'pib_dynamic', analysis: { target: 'gm_frontal', reference: 'cereb_gm' }, afterScan: 'reconAll' } },
                { html: 'Load FE-PE2I in Parkinson\'s disease and compare the left and right putamen as targets: the patient\'s left (the image\'s right) has lost more transporter, worst in the posterior putamen.',
                    label: 'FE-PE2I, Parkinson', run: { preset: 'fepe2i_static', analysis: { target: 'putamen_l', reference: 'cereb_gm' } } }
            ],
            questions: [
                'Why does a late static SUVR overestimate the DVR of a reversibly binding tracer?',
                'What makes a good reference region for amyloid imaging? Why not white matter?',
                'FE-PE2I peaks earlier than PE2I (about 26 vs 47 min in the putamen). Why does that make a short static scan at 20 to 40 min more trustworthy?'
            ],
            takeaway: 'SUVR approaches the binding (the DVR) only near equilibrium and with a reference free of the target; a dynamic scan with a Logan plot measures it.'
        }
    ];

    /* ---------- state ---------- */
    const T = { mounted: false, done: loadDone(), cards: {}, dom: {}, pendingAfter: null };

    function loadDone() {
        try {
            const raw = root.localStorage ? root.localStorage.getItem(STORE) : null;
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (e) { return new Set(); }
    }
    function saveDone() {
        try { if (root.localStorage) root.localStorage.setItem(STORE, JSON.stringify(Array.from(T.done))); } catch (e) { /* storage blocked */ }
    }
    function notify(msg, kind) { if (PET.app && PET.app.notify) PET.app.notify(msg, kind); }

    /* ---------- applying a lesson's settings ---------- */

    /* Replace the statement that starts with `keyword` (keeping its
       indentation; the comment is replaced when one is given), or append it. */
    function rewriteStatement(src, keyword, statement, comment) {
        const re = new RegExp('^([ \\t]*)' + keyword + '\\b([^#\\n]*)(#[^\\n]*)?$', 'm');
        const tail = function (old) {
            if (comment === '') return '';
            if (comment) return '   ' + comment;
            return old ? '   ' + old : '';
        };
        if (re.test(src)) return src.replace(re, function (m, ind, body, old) { return ind + statement + tail(old); });
        return src.replace(/\s*$/, '') + '\n' + statement + tail(null) + '\n';
    }

    function apply(p) {
        const A = PET.actions;
        if (!A) { notify('The simulator shell did not start, so lessons cannot change its settings.', 'bad'); return false; }
        let rescan = false;
        if (p.resetPhysics) { A.resetPhysics(); rescan = true; }
        if (p.resetRecon) A.resetRecon();
        if (p.preset) {
            if (A.loadPreset(p.preset) === false) return false;
            rescan = true;
        }
        if (p.phantom) { A.setPhantom(p.phantom, p.phantomOpts); rescan = true; }
        else if (p.phantomOpts) { A.setPhantomOpts(p.phantomOpts); rescan = true; }
        if (p.edits && p.edits.length) {
            let src = (PET.state && PET.state.source) || '';
            p.edits.forEach(function (e) { src = rewriteStatement(src, e[0], e[1], e[2]); });
            A.setSource(src);
            rescan = true;
            const prog = PET.state.program;
            if (prog && !prog.ok) notify('The protocol did not compile after that change: see the Protocol tab.', 'warn');
        }
        if (p.params) {
            Object.keys(p.params).forEach(function (name) {
                if (A.setParam(name, p.params[name]) === false) notify('This protocol has no ' + name + ' parameter.', 'warn');
            });
            rescan = true;
        }
        if (p.physics) { A.setPhysics(p.physics); rescan = true; }
        if (p.recon) A.setRecon(p.recon);
        if (p.analysis) A.setAnalysis(p.analysis);
        if (p.frame !== undefined) A.setFrame(p.frame);
        if (p.afterScan) watchScan(p.afterScan);
        // With Auto re-scan off nothing would happen until Acquire, so scan now.
        if (rescan && PET.state && !PET.state.autoRescan && A.runScan) A.runScan({ animate: false });
        return true;
    }

    /* After the scan the lesson needs, do one more thing (reconstruct every
       frame of a dynamic study). Waits for a scan of the current protocol. */
    function watchScan(what) {
        const bus = PET.bus;
        if (T.pendingAfter) { bus.off('scan:done', T.pendingAfter); T.pendingAfter = null; }
        const started = Date.now();
        const fn = function (e) {
            const acq = e && e.acq, st = PET.state;
            if (Date.now() - started > 120000) { bus.off('scan:done', fn); T.pendingAfter = null; return; }
            if (!acq || e.partial || acq.program !== st.program) return;
            bus.off('scan:done', fn);
            T.pendingAfter = null;
            if (what === 'reconAll' && acq.frames && acq.frames.length > 1 && PET.actions.reconstructAllFrames) {
                // let the frame shown be reconstructed first, then do them all
                setTimeout(function () { if (PET.state.acq === acq) PET.actions.reconstructAllFrames(); }, 300);
            }
        };
        T.pendingAfter = fn;
        bus.on('scan:done', fn);
    }

    function setUp(lesson) {
        const s = lesson.setup || {};
        const ok = apply(Object.assign({}, s, {
            resetPhysics: true, resetRecon: true,
            analysis: Object.assign({}, DEFAULT_ANALYSIS, s.analysis || {}),
            frame: 0
        }));
        if (!ok) return;
        if (PET.actions.showTab) PET.actions.showTab(lesson.tab);
        notify('Lesson ' + lesson.n + ' is set up: ' + lesson.title + '. The Guide tab has the steps.', 'good');
    }
    function runStep(lesson, step) {
        const r = step.run || {};
        const hasChange = Object.keys(r).some(function (k) { return k !== 'tab'; });
        if (hasChange && !apply(r)) return;
        const tab = r.tab || step.tab || lesson.tab;
        if (PET.actions && PET.actions.showTab) PET.actions.showTab(tab);
        if (hasChange) notify('Lesson ' + lesson.n + ', step: ' + step.label + '. ' + (PET.state.autoRescan ? 'The simulator re-scans by itself.' : 'Scanning now.'), 'info');
    }
    function startOver() {
        apply({ resetPhysics: true, resetRecon: true, preset: 'fdg_static', analysis: Object.assign({}, DEFAULT_ANALYSIS), frame: 0 });
        notify('Back to the default FDG brain scan, with default physics and reconstruction.', 'good');
    }

    /* ---------- building the tab ---------- */
    const ICONS = {
        play: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>',
        auto: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12.6 1.6v3.2H9.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        undo: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5H10a3.5 3.5 0 0 1 0 7H5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M7.5 2 5 4.5 7.5 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        book: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.2c2-.9 4-.9 5.5.4 1.5-1.3 3.5-1.3 5.5-.4v9.4c-2-.9-4-.9-5.5.4-1.5-1.3-3.5-1.3-5.5-.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 3.6v9.4" stroke="currentColor" stroke-width="1.5"/></svg>'
    };

    function buildWelcome() {
        const panel = el('section', { class: 'panel', 'aria-labelledby': 'ls-welcome-title' });
        const left = el('div', {}, [
            el('h2', { id: 'ls-welcome-title', text: 'Welcome to the PET simulator' }),
            el('p', { class: 'ls-lead', html: 'A teaching PET scanner that runs in your browser. You write a scan protocol (tracer, dose, timing, energy and coincidence windows, time of flight); the simulator injects it into a test phantom or a schematic brain, follows the tracer with compartment models, simulates the coincidences one detector ring records, with attenuation, scatter, randoms and noise, and reconstructs an image you can measure. It is one 4 mm slice on one ring: a model built to show mechanisms, not a clinical tool.' }),
            el('ul', { class: 'ls-how' }, [
                el('li', {}, [el('span', { class: 'ls-ico', html: ICONS.play }), el('span', { html: '<strong>Acquire</strong>, in the bar at the top, runs the protocol and plays the scan back, so you see counts accumulate and the image take shape. <strong>Speed</strong> sets how long that playback takes: Instant, Fast (about 3 s) or Slow (about 10 s).' })]),
                el('li', {}, [el('span', { class: 'ls-ico', html: ICONS.auto }), el('span', { html: '<strong>Auto re-scan</strong> (on by default) repeats the scan instantly whenever you change the protocol, the phantom or the physics, so every switch shows its effect within a second or two. Turn it off to change several things at once, then press Acquire. Reconstruction settings only re-run the reconstruction.' })]),
                el('li', {}, [el('span', { class: 'ls-ico', html: ICONS.undo }), el('span', { html: 'Every switch is reversible and nothing is saved anywhere. The Reconstruction and Degradations & corrections tabs have reset buttons, each lesson\'s <strong>Set up</strong> puts everything into a known state, and <strong>Start over</strong> below returns to the default FDG brain scan.' })]),
                el('li', {}, [el('span', { class: 'ls-ico', html: ICONS.book }), el('span', { html: 'Each tab opens with a <strong>concept card</strong>: the idea, the equation that matters, and experiments to try. The two thumbnails in the bar show the latest sinogram and image; click them to open their tabs.' })])
            ]),
            el('div', { class: 'ls-start' }, [
                w().button({ label: 'Start with lesson 1', kind: 'primary', onClick: function () { openLesson('decay'); } }),
                w().button({ label: 'Start over', title: 'Load the default FDG brain scan and reset physics, reconstruction and analysis regions', onClick: startOver })
            ])
        ]);
        const map = el('ol', { class: 'ls-map' });
        TAB_MAP.forEach(function (t, i) {
            const b = el('button', { type: 'button', class: 'ls-map-btn', title: 'Open the ' + t.title + ' tab' }, [
                el('span', { class: 'ls-n', text: String(i + 1) }), el('span', { class: 'ls-t', text: t.title }), el('span', { class: 'ls-d', text: t.d })
            ]);
            b.addEventListener('click', function () { if (PET.actions && PET.actions.showTab) PET.actions.showTab(t.id); });
            map.appendChild(el('li', {}, [b]));
        });
        const right = el('nav', { 'aria-label': 'The tabs, one concept each' }, [el('div', { class: 'ls-map-title', text: 'The tabs follow a scan, one concept each' }), map]);
        panel.appendChild(el('div', { class: 'ls-welcome' }, [left, right]));
        return panel;
    }

    function buildLesson(lesson) {
        const card = el('details', { class: 'ls-lesson', id: 'lesson-' + lesson.id });
        const tabName = TAB_TITLE[lesson.tab] || lesson.tab;
        card.appendChild(el('summary', { class: 'ls-sum' }, [
            el('span', { class: 'ls-num', 'aria-hidden': 'true', text: String(lesson.n) }),
            el('span', { class: 'ls-sum-main' }, [
                el('span', { class: 'ls-title' }, [el('span', { class: 'sr-only', text: 'Lesson ' + lesson.n + ': ' }), lesson.title]),
                el('div', { class: 'ls-goal-short', text: lesson.goal })
            ]),
            w().badge(tabName, 'muted')
        ]));
        const body = el('div', { class: 'ls-body' });
        body.appendChild(el('div', { class: 'ls-setup' }, [
            w().button({ label: 'Set up lesson ' + lesson.n, kind: 'primary', size: 'sm', onClick: function () { setUp(lesson); } }),
            el('p', { text: lesson.setupText }),
            w().button({ label: 'Open ' + tabName, size: 'sm', kind: 'ghost', title: 'Open the tab without changing any settings',
                onClick: function () { if (PET.actions && PET.actions.showTab) PET.actions.showTab(lesson.tab); } })
        ]));
        const steps = el('ol', { class: 'ls-steps' });
        lesson.steps.forEach(function (st) {
            const li = el('li', {}, [el('span', { html: st.html })]);
            if (st.run && st.label) {
                li.appendChild(doc.createTextNode(' '));
                li.appendChild(w().button({ label: st.label, size: 'xs', title: 'Apply this change and show the result', onClick: function () { runStep(lesson, st); } }));
            }
            steps.appendChild(li);
        });
        const qs = el('ol', { class: 'ls-qs' }, lesson.questions.map(function (q) { return el('li', { html: q }); }));
        body.appendChild(el('div', { class: 'ls-cols' }, [
            el('div', {}, [el('div', { class: 'ls-h', text: 'Things to try' }), steps]),
            el('div', {}, [el('div', { class: 'ls-h', text: 'Questions' }), qs])
        ]));
        body.appendChild(el('div', { class: 'callout callout-good ls-take', html: '<strong>Takeaway.</strong> ' + lesson.takeaway }));
        const doneT = w().toggle({ label: 'I have done this lesson', checked: T.done.has(lesson.id),
            onChange: function (b) { if (b) T.done.add(lesson.id); else T.done.delete(lesson.id); saveDone(); syncDone(); } });
        body.appendChild(el('div', { class: 'ls-foot' }, [doneT]));
        card.appendChild(body);
        T.cards[lesson.id] = { card: card, toggle: doneT };
        return card;
    }
    function syncDone() {
        LESSONS.forEach(function (l) {
            const c = T.cards[l.id];
            if (!c) return;
            const d = T.done.has(l.id);
            c.card.classList.toggle('is-done', d);
            c.toggle.set(d);
        });
        const n = LESSONS.filter(function (l) { return T.done.has(l.id); }).length;
        if (T.dom.progress) T.dom.progress.textContent = n + ' of ' + LESSONS.length + ' done';
        if (T.dom.bar) T.dom.bar.style.width = (100 * n / LESSONS.length).toFixed(1) + '%';
    }
    function openLesson(id) {
        const c = T.cards[id];
        if (!c) return;
        c.card.open = true;
        try { c.card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { c.card.scrollIntoView(); }
        const s = c.card.querySelector('summary');
        if (s) s.focus({ preventScroll: true });
    }

    function mount(panel) {
        PET.ui.addStyle(CSS);
        panel.textContent = '';
        LESSONS.forEach(function (l, i) { l.n = i + 1; });
        panel.appendChild(buildWelcome());
        T.dom.progress = el('span', { class: 'ls-progress' });
        T.dom.bar = el('div');
        const allOpen = function (b) { LESSONS.forEach(function (l) { if (T.cards[l.id]) T.cards[l.id].card.open = b; }); };
        panel.appendChild(el('div', { class: 'ls-list-head' }, [
            el('h2', { text: 'Lessons' }),
            el('div', { class: 'ls-bar', 'aria-hidden': 'true' }, [T.dom.bar]), T.dom.progress,
            el('span', { class: 'spacer' }),
            w().button({ label: 'Expand all', size: 'sm', kind: 'ghost', onClick: function () { allOpen(true); } }),
            w().button({ label: 'Collapse all', size: 'sm', kind: 'ghost', onClick: function () { allOpen(false); } })
        ]));
        let group = null;
        LESSONS.forEach(function (l) {
            if (l.group !== group) { group = l.group; panel.appendChild(el('h3', { class: 'ls-group', text: group })); }
            panel.appendChild(buildLesson(l));
        });
        panel.appendChild(el('p', { class: 'note mt-2', text: 'Each lesson takes 10 to 20 minutes. They build on each other but each one sets itself up, so you can start anywhere. Your ticks are kept in this browser only.' }));
        syncDone();
        T.mounted = true;
    }

    PET.ui.registerTab({
        id: 'lessons', title: 'Guide', order: 0,
        mount: mount,
        onShow: function () { if (T.mounted) syncDone(); },
        onHide: function () { /* nothing runs in the background */ }
    });

    // for tests: the lesson list and the line rewriter
    PET.ui.lessons = { list: LESSONS, rewriteStatement: rewriteStatement, setUp: setUp };

})(typeof window !== 'undefined' ? window : globalThis);
