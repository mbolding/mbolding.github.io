/* ============================================================
   MRI Simulator, Guide tab (ARCHITECTURE.md section 12.5)

   The landing tab. A short welcome (what the simulator is, how the
   tabs map onto concepts, what the scan bar does, and that it is a
   teaching model at 3 T rather than a physics engine), then thirteen
   lessons that walk through the course material:

      1 The scanner and the Larmor frequency
      2 From FID to echo: what one k-space line is
      3 k-space: centre is contrast, edges are detail
      4 FOV, matrix, resolution and aliasing
      5 T1, T2 and PD weighting with spin echo
      6 Inversion recovery: nulling CSF and fat
      7 Gradient echo, T2* and susceptibility
      8 Chemical shift and fat suppression
      9 Fast imaging: turbo spin echo and EPI
     10 Motion and flow
     11 Hardware faults: spikes, zipper and Nyquist ghosts
     12 Reconstruction choices: filtering, partial Fourier, SENSE
     13 Spectroscopy: chemical shift, water suppression, shimming

   Each lesson: the idea in a sentence or two, a goal, a Set up button
   (resets the artifacts, then loads phantom, preset, parameters,
   coil, reconstruction options and opens the right tab), numbered
   steps that name the controls students will find, questions with a
   collapsible "What you should see", and a one-line takeaway. Progress
   checkmarks are a per-browser convenience kept in localStorage.

   The tab only reads the state to know which tabs exist; it does no
   work while hidden.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;
    if (!MRI || !MRI.ui || typeof MRI.ui.registerTab !== 'function' || !root.document) return;
    const U = MRI.util;
    const doc = root.document;
    const DONE_KEY = 'mriSim.lessons.done';
    const OPEN_KEY = 'mriSim.lessons.open';

    function el(tag, attrs, children) { return U.el(tag, attrs, children); }
    function W() { return MRI.ui.w; }
    function S() { return MRI.state; }
    function A() { return MRI.actions; }
    function toast(msg, kind) { if (W() && W().toast) W().toast(msg, kind); }
    function terms() { return (MRI.ui && MRI.ui.terms) || {}; }
    function scrollBehavior() { return U.scrollBehavior ? U.scrollBehavior() : 'auto'; }
    function coilName(type) { const t = terms().coil; return (t && t[type]) || (type === 'body' ? 'Body coil' : '8-channel head coil'); }
    function readJSON(key, def) { try { const v = JSON.parse(root.localStorage.getItem(key) || 'null'); return v === null ? def : v; } catch (e) { return def; } }
    function writeJSON(key, v) { try { root.localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage blocked: progress lasts for this visit only */ } }

    MRI.ui.addStyle(`
#tab-lessons .ls-layout { align-items: start; }
#tab-lessons .ls-side { display: flex; flex-direction: column; gap: 0; min-width: 0; }
#tab-lessons .ls-tabs { --min: 220px; gap: 8px; }
#tab-lessons .ls-tile {
    display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; gap: 3px; text-align: left; height: auto; min-height: 0;
    padding: 10px 12px; white-space: normal; line-height: 1.4; font-weight: 400; width: 100%;
}
#tab-lessons .ls-tile-name { font-weight: 650; font-size: 0.9rem; color: var(--fg); }
#tab-lessons .ls-tile-desc { font-size: 0.8rem; color: var(--muted); }
#tab-lessons .ls-tile[disabled] .ls-tile-name::after { content: " (did not load)"; font-weight: 500; color: var(--warn); }
#tab-lessons .ls-bar-list { margin: 0; padding-left: 20px; font-size: 0.88rem; line-height: 1.55; }
#tab-lessons .ls-bar-list li { margin-bottom: 4px; }
#tab-lessons .ls-progress { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
#tab-lessons .ls-meter { flex: 1 1 160px; height: 8px; border-radius: 4px; background: var(--track); overflow: hidden; min-width: 120px; }
#tab-lessons .ls-meter > span { display: block; height: 100%; width: 0; background: var(--good); transition: width 0.2s ease; }
#tab-lessons .ls-lessons { display: flex; flex-direction: column; gap: 10px; }
#tab-lessons .ls-lesson { scroll-margin-top: var(--ls-top, 130px); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-1); }
#tab-lessons .ls-lesson > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 12px; padding: 12px 40px 12px 14px;
    position: relative; border-radius: var(--radius);
}
#tab-lessons .ls-lesson > summary::-webkit-details-marker { display: none; }
#tab-lessons .ls-lesson > summary::after {
    content: ""; position: absolute; right: 18px; top: 50%; width: 7px; height: 7px; margin-top: -6px;
    border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s ease;
}
#tab-lessons .ls-lesson[open] > summary::after { transform: rotate(-135deg); margin-top: -2px; }
#tab-lessons .ls-lesson > summary:hover { background: var(--hover); }
#tab-lessons .ls-num {
    flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    font: 700 0.85rem var(--font-sans); color: var(--accent); background: var(--accent-soft); border: 1px solid var(--accent-border);
}
#tab-lessons .ls-lesson.is-done .ls-num { background: var(--good-soft); border-color: var(--good-border); color: var(--good); }
#tab-lessons .ls-num svg { width: 14px; height: 14px; }
#tab-lessons .ls-head { display: flex; flex-direction: column; min-width: 0; gap: 1px; flex: 1; }
#tab-lessons .ls-title { font-weight: 650; font-size: 0.98rem; }
#tab-lessons .ls-meta { font-size: 0.78rem; color: var(--muted); }
#tab-lessons .ls-body { padding: 2px 18px 16px 56px; font-size: 0.9rem; line-height: 1.55; }
#tab-lessons .ls-body h3 { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 14px 0 6px; }
#tab-lessons .ls-concept { margin: 0 0 8px; }
#tab-lessons .ls-goal { margin: 0 0 10px; }
#tab-lessons .ls-setup { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 10px 12px; background: var(--card-2); border: 1px solid var(--border-subtle); border-radius: 8px; }
#tab-lessons .ls-setup .note { margin: 0; flex: 1 1 260px; }
#tab-lessons .ls-setup svg { width: 11px; height: 11px; }
#tab-lessons .ls-steps { margin: 0; padding-left: 22px; }
#tab-lessons .ls-steps li { margin-bottom: 6px; padding-left: 2px; }
#tab-lessons .ls-qs { display: flex; flex-direction: column; gap: 8px; }
#tab-lessons .ls-q { border-left: 2px solid var(--accent-border); padding: 2px 0 2px 10px; }
#tab-lessons .ls-q > p { margin: 0 0 4px; }
#tab-lessons .ls-q details > summary { cursor: pointer; color: var(--accent); font-size: 0.84rem; font-weight: 600; width: fit-content; border-radius: 4px; }
#tab-lessons .ls-q details > p { margin: 6px 0 2px; padding: 8px 10px; background: var(--good-soft); border: 1px solid var(--good-border); border-radius: 6px; font-size: 0.87rem; }
#tab-lessons .ls-take { margin: 14px 0 10px; padding: 8px 12px; border-radius: 8px; background: var(--accent-soft); border: 1px solid var(--accent-border); }
#tab-lessons .ls-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
#tab-lessons .ls-missing { margin: 8px 0 0; }
#tab-lessons .ls-body code { white-space: nowrap; }
@media (max-width: 640px) {
    #tab-lessons .ls-body { padding: 0 12px 14px 12px; }
    #tab-lessons .ls-lesson > summary { padding: 10px 36px 10px 10px; gap: 10px; }
}
`);

    /* ============================================================
       Set-ups (the same recipe as the Artifacts tab's demonstrations)
       ============================================================ */
    function reconDefaults() {
        const d = Object.assign({}, (MRI.recon && MRI.recon.defaults) || {});
        d.userMask = null;
        return d;
    }
    function applySetup(s) {
        const a = A(), st = S();
        a.resetArtifacts();
        if (s.preset) {
            if (!a.loadPreset(s.preset)) return { ok: false, message: 'The preset "' + s.preset + '" is missing.' };
            Object.keys(s.params || {}).forEach(function (k) { a.setParam(k, s.params[k]); });
            a.setCoil(s.coil || 'head8');
            a.setRecon(Object.assign(reconDefaults(), s.recon || {}));
            a.setPhantom(s.phantom || 'brain', s.phantomOpts || {});
        }
        if (s.artifacts) a.setArtifacts(s.artifacts);
        if (s.spectro && a.spectro) {
            a.spectro.setPhantom(s.spectro.phantom || 'braino');
            a.spectro.loadPreset(s.spectro.preset || 'fid');
            if (MRI.spectro && MRI.spectro.defaults) a.spectro.setProcessing(Object.assign({}, MRI.spectro.defaults));
        }
        if (s.preset && !(st.program && st.program.ok)) {
            const e = st.program && st.program.errors && st.program.errors[0];
            return { ok: false, message: 'The lesson\'s sequence does not compile' + (e ? ' (line ' + e.line + ': ' + e.msg + ')' : '') + '.' };
        }
        return { ok: true };
    }
    let setupToken = 0;
    let returnTo = null;           // lesson to open (without moving focus) the next time the Guide is shown
    /* Set a lesson up, switch to its tab with keyboard focus on the start of
       that tab's content, and put a lesson strip under the tab bar: "Lesson 3
       · k-space ... [Back to the steps] [x]". The strip stays (on every tab
       but the Guide) until it is closed or another lesson is set up, so the
       way back never times out. */
    function runSetup(L) {
        const s = L.setup;
        const r = applySetup(s);
        if (!r.ok) { toast(r.message, 'bad'); return; }
        A().showTab(s.tab, { focus: true });
        const tok = ++setupToken;
        if (s.preset) {
            if (s.animate) {
                // after the app's own 250 ms instant re-scan, so it replaces it
                setTimeout(function () { if (tok === setupToken) A().runScan({ animate: true }); }, 320);
            } else if (!S().autoRescan) A().runScan({ animate: false });
        }
        returnTo = L.n;
        const back = function () {
            returnTo = null;
            A().showTab('lessons');
            openLesson(L.n, 'steps');
        };
        if (MRI.ui.lessonStrip && MRI.ui.lessonStrip.show) {
            MRI.ui.lessonStrip.show({ title: 'Lesson ' + L.n + ' · ' + L.title, onBack: back, backLabel: 'Back to the steps' });
        } else if (W() && W().toast) {
            W().toast(el('span', {}, ['Lesson ' + L.n + ' is set up in the ' + (TAB_NAMES[s.tab] || s.tab) + ' tab. ',
                el('button', { type: 'button', class: 'linklike', onclick: back }, 'Back to the steps')]), 'good');
        }
    }

    /* ============================================================
       The lessons
       ============================================================ */
    const LESSONS = [
        {
            n: 1, id: 'larmor', title: 'The scanner and the Larmor frequency', tab: 'scanner', minutes: 5,
            concept: 'Protons precess at the Larmor frequency f = γ̄B, with γ̄ = 42.58 MHz per tesla: 127.73 MHz at 3 T. The gradient coils add a field that changes with position, so the frequency becomes a ruler.',
            goal: 'Name the main parts of the scanner, work out the Larmor frequency with and without a gradient, and follow the signal from the RF pulse to the image.',
            setup: { phantom: 'brain', preset: 'se', tab: 'scanner' },
            loads: 'the brain and the default spin echo, and opens the Scanner tab.',
            steps: [
                'In the <b>Scanner</b> tab, click parts of the schematic (the superconducting magnet, the gradient coils, the RF body coil) and read <b>Component details</b>: what each does, its 3 T numbers, and what goes wrong.',
                'In the <b>Larmor calculator</b>, with <b>Gradient strength G</b> at 0 every position precesses at 127.73 MHz. Set G to 10 mT/m and <b>Position x</b> to 100 mm.',
                'Set the scan bar\'s <b>Speed</b> to Slow and press <b>Acquire</b>. Watch which parts light up: the RF chain during each pulse, a gradient amplifier while its gradient plays, the receive chain while the ADC records.',
                'In <b>Follow the signal</b>, press <b>Start</b> and step with <b>Next</b>, from the operator console to the image.',
                'Switch the <b>Receive coil</b> (above the schematic) between ' + coilName('body') + ' and ' + coilName('head8') + ', and compare the image thumbnail (or the Image tab).'
            ],
            questions: [
                { q: 'What is the proton Larmor frequency at 1.5 T and at 7 T?', a: 'f = 42.58 MHz/T × B: 63.9 MHz at 1.5 T and 298 MHz at 7 T. The frequency is proportional to the field.' },
                { q: 'With a 10 mT/m gradient, how much higher is the frequency 100 mm from the centre?', a: 'Δf = γ̄·G·x = 42.58 MHz/T × 0.010 T/m × 0.100 m = 42.6 kHz. That is only 0.03 % of 127.73 MHz, but the receiver measures it easily, and it is what encodes position.' },
                { q: 'Why does the image change when you swap the body coil for the head coil?', a: 'The image gets less grainy. Most of the noise is thermal noise from the patient, and each small loop of the head coil sits close to the head and picks it up from only a small volume of tissue, so the array has a higher SNR than the body coil everywhere in the head: about 1.6 times in the centre and most near the cortex, where the loops are closest. Combined by root-sum-of-squares the array also leaves a brighter rim (coil shading); the default Roemer combination evens the brightness out. The body coil sees the head uniformly but picks up noise from the whole head, neck and shoulders, so it is noisier.' }
            ],
            takeaway: 'f = γ̄(B0 + G·x): the magnet sets the frequency, the gradients turn frequency into position, and the RF chain transmits and receives at 127.7 MHz.'
        },
        {
            n: 2, id: 'echo', title: 'From FID to echo: what one k-space line is', tab: 'sequence', minutes: 8,
            concept: 'After the excitation, a gradient winds the spins\' phase across the object, so at each moment the signal measures one spatial frequency, k = γ̄∫G dt. One readout sweeps k along a line; the echo is where that line crosses k = 0.',
            goal: 'Read a minimal gradient-echo sequence and see how the prephasing and readout gradients move through k-space, one line per TR.',
            setup: { phantom: 'brain', preset: 'first', tab: 'sequence' },
            loads: '"Your first sequence" (a commented 64 × 64 gradient echo) on the brain, and opens the Sequence tab.',
            steps: [
                'Read the source of <b>Your first sequence</b>: every line is commented. Find <code>rf</code>, <code>gz rephase</code>, <code>gx prephase</code>, <code>gy encode</code>, <code>gx readout</code>, <code>adc</code> and <code>spoil</code>.',
                'Click in the <b>Timing diagram</b> a few milliseconds after an RF pulse and drag the cursor through the repetition. In <b>k-space trajectory</b>, the prephaser (negative gx lobe) moves k to the left edge, the readout sweeps it to the right, and the gy lobe sets the height of the line.',
                'Watch <b>Spin phase across the FOV</b> as you move the cursor: the phase winds into a helix during the prephaser, is uniform at the echo (TE), and winds the other way after it.',
                'Use <b>‹ Prev</b> and <b>Next ›</b> above the diagram: each repetition encodes a different line (a different gy area).',
                'Set the scan bar\'s <b>Speed</b> to Slow, press <b>Acquire</b>, and open the <b>k-space</b> tab to watch the lines fill one per TR.'
            ],
            questions: [
                { q: 'At which moment of the readout is the signal largest, and why?', a: 'At the echo, the middle of the ADC window, TE after the excitation. There the net gradient area since the excitation is zero (k = 0): every spin is back in phase, so their signals add.' },
                { q: 'In Parameters, change N from 64 to 128. What happens to the scan time, and why?', a: 'It almost doubles (from 6.8 s to 13.2 s, including the 4 dummy TRs): every phase-encode line needs its own TR.' },
                { q: 'Increase TE with its slider. What moves in the timing diagram, and what stays?', a: 'The readout and the ADC slide later, so the echo stays centred at TE. The RF pulse, the prephaser and TR stay where they were (until the readout no longer fits in TR).' }
            ],
            takeaway: 'One readout records one line of k-space; the echo is where it crosses k = 0, and every TR adds another line.'
        },
        {
            n: 3, id: 'kspace', title: 'k-space: centre is contrast, edges are detail', tab: 'kspace', minutes: 8,
            concept: 'Each k-space sample says how much of one stripe pattern the object contains. Samples near the centre (broad stripes) carry most of the signal and the contrast; samples near the edges (fine stripes) carry edges and detail.',
            goal: 'Edit k-space and find out which part of the image each region holds.',
            setup: { phantom: 'brain', preset: 'se', tab: 'kspace' },
            loads: 'the default spin echo on the brain, and opens the k-space tab.',
            steps: [
                'Look at k-space shown as <b>log |S|</b>: a bright centre and weak edges. Hover to read k in 1/mm.',
                'Under <b>One sample, one stripe pattern</b>, press <b>Pick:</b> k = 0, then Low, Middle, Edge and Corner, and look at the wave each sample adds to the image.',
                'In <b>Edit k-space, watch the image</b>, press <b>Keep centre</b> and compare <b>Edited k-space</b> with <b>All data</b>. Move the <b>Centre radius</b> slider.',
                'Press <b>Reset</b>, then <b>Remove centre</b>.',
                'Press <b>Reset</b>, then <b>Keep half: Top</b>, and switch <b>Missing half filled by</b> between Zero and Homodyne.'
            ],
            questions: [
                { q: 'Keeping only the centre, what survives and what is lost?', a: 'The overall brightness and the contrast between tissues survive, because they are low spatial frequencies. Edges, the cortical ribbon and small structures blur away: it looks like a low-resolution image.' },
                { q: 'Removing the centre, why does the image go so dark, and what is left?', a: 'Most of the signal is concentrated at the centre of k-space, so removing it removes most of the signal. What remains are edges and fine detail: a high-pass filtered image.' },
                { q: 'Why can one half of k-space (plus a few lines past the centre) be enough?', a: 'A real-valued object has conjugate-symmetric k-space, S(−k) = S*(k). Homodyne estimates the slowly varying image phase from the central lines and then uses the symmetry to stand in for the missing half. Filling with zeros instead blurs the image along that direction.' }
            ],
            takeaway: 'The centre of k-space holds signal and contrast, the edges hold resolution: Δx = 1/(2 k<sub>max</sub>).'
        },
        {
            n: 4, id: 'fov', title: 'FOV, matrix, resolution and aliasing', tab: 'image', minutes: 8,
            concept: 'The spacing of the k-space samples sets the field of view (FOV = 1/Δk), and the matrix sets the pixel size (Δx = FOV/N). Anything outside the FOV along the phase-encode direction folds back in.',
            goal: 'Change FOV and matrix, predict pixel size, scan time and SNR, and make the head wrap.',
            setup: { phantom: 'brain', preset: 'gre_t1', tab: 'image' },
            loads: 'the T1-weighted gradient echo on the brain, and opens the Image tab.',
            steps: [
                'In the <b>Sequence</b> tab\'s Parameters (or the Artifacts tab\'s Aliasing card), set <b>FOV</b> to 180 mm. In the <b>Image</b> tab the back of the head folds onto the forehead and the front onto the back.',
                'Set FOV to 150 mm: the head (160 mm wide) is now wider than the FOV too, yet nothing wraps left to right. In the Image tab open <b>Advanced</b> and untick <b>Crop readout oversampling</b> to see the full width the ADC recorded.',
                'Set FOV back to 240 mm. Change <b>N</b> from 128 to 64 and then to 256; read the <b>Voxel size</b> in the Image tab\'s "This scan" table and the scan time in the scan bar.',
                'At N = 128 and again at N = 256, press <b>Place both</b> (Signal-to-noise ratio) and compare the SNR.'
            ],
            questions: [
                { q: 'Why does the head wrap top to bottom but not left to right?', a: 'y is the phase-encode direction, sampled at exactly Δk = 1/FOV. The readout (x) is sampled twice as finely (oversample 2), so its raw field of view is twice the FOV and the reconstruction crops it: wrap along x needs an object more than twice as wide as the FOV.' },
                { q: 'At FOV 240 mm, what pixel size do N = 64, 128 and 256 give, and how does the scan time change?', a: '3.75, 1.88 and 0.94 mm. The scan time grows in proportion to N (one TR per phase-encode line): 256 lines take four times as long as 64.' },
                { q: 'From N = 128 to 256 at the same FOV and bandwidth, how much does the SNR fall?', a: 'The voxel area falls 4×, while the total sampling time doubles (√2 more SNR), so the SNR falls by about 4/√2 ≈ 2.8×.' }
            ],
            takeaway: 'FOV = 1/Δk and Δx = FOV/N. Phase-encode lines cost time; readout oversampling is free.'
        },
        {
            n: 5, id: 'weighting', title: 'T1, T2 and PD weighting with spin echo', tab: 'contrast', minutes: 8,
            concept: 'TR controls how much longitudinal magnetisation recovers between excitations (T1 weighting); TE controls how much transverse magnetisation has decayed at the echo (T2 weighting). Long TR with short TE leaves mainly proton density.',
            goal: 'Make T2-, PD- and T1-weighted spin-echo images by choosing TR and TE, and explain each tissue\'s brightness.',
            setup: { phantom: 'brain', preset: 'se', tab: 'contrast' },
            loads: 'the spin echo (TR 3000 ms, TE 90 ms) on the brain, and opens the Contrast tab.',
            steps: [
                'The default spin echo is T2-weighted. Read the <b>Signal at the k-space centre</b> bars in the Contrast tab, then look at the image (thumbnail or Image tab).',
                'In the <b>Sequence</b> tab\'s Parameters, set <b>TE</b> to 12 ms and keep TR at 3000 ms: proton-density weighting.',
                'Now set <b>TR</b> to 500 ms, with TE still 12 ms: T1 weighting.',
                'In the Contrast tab, under <b>Sweep a parameter</b>, choose TE, then TR. Click the plot to set a value and watch every tissue\'s curve.'
            ],
            questions: [
                { q: 'Why is CSF the brightest tissue on the T2-weighted image?', a: 'CSF has by far the longest T2 (about 1.8 s against 75 to 95 ms for brain tissue), so at TE 90 ms it has lost little signal while grey and white matter have lost most of theirs.' },
                { q: 'On the T1-weighted image, why is white matter brighter than grey matter, and CSF dark?', a: 'At TR 500 ms the short-T1 tissues recover more between excitations: white matter (T1 ≈ 0.85 s) more than grey matter (1.35 s), and CSF (4 s) hardly at all.' },
                { q: 'What does proton-density weighting need, and why is TR 3000 / TE 12 ms not quite pure PD?', a: 'TR much longer than T1 and TE much shorter than T2. At TR 3000 ms CSF (T1 4 s) has not fully recovered, and TE 12 ms still costs a little T2 decay, so the image is mostly, not purely, PD-weighted.' }
            ],
            takeaway: 'TR sets T1 weighting, TE sets T2 weighting; long TR with short TE approaches proton density.'
        },
        {
            n: 6, id: 'ir', title: 'Inversion recovery: nulling CSF and fat', tab: 'contrast', minutes: 8,
            concept: 'An inversion pulse turns Mz to −M0, and each tissue recovers through zero at its own moment, about T1·ln 2 when TR ≫ T1. Exciting at that moment (TI) removes that tissue from the image.',
            goal: 'Null fat with STIR and CSF with FLAIR, find the null point yourself, and see why STIR is not used after gadolinium.',
            setup: { phantom: 'brain', preset: 'stir', tab: 'contrast' },
            loads: 'STIR (TI 260 ms) on the brain, and opens the Contrast tab.',
            steps: [
                'In <b>Magnetisation of each tissue</b>, each inversion flips Mz to minus whatever had recovered since the last repetition (−1 for fully relaxed tissue, only about −0.5 for CSF at TR 3000 ms), and Mz climbs back from there; fat crosses zero near TI. In the image the scalp fat is dark.',
                'Under <b>Sweep a parameter</b> choose <b>TI</b> and switch <b>Show sign</b> on: fat\'s signal changes sign at about 263 ms, right at the preset\'s TI of 260 ms. Switch Show sign off to see the magnitude, which is what the image shows.',
                'Load <b>FLAIR</b> (Sequence tab, Preset). TI 2400 ms nulls CSF and the ventricles go dark. In the <b>Phantom</b> tab switch on <b>Lesions</b>: the periventricular lesions stand out.',
                'Load STIR again. With Lesions on, set <b>Gadolinium in enhancing tissue</b> to 0.5 mM (Phantom tab). Then compare with the T1-weighted gradient echo (<code>gre_t1</code>).'
            ],
            questions: [
                { q: 'Why does a short TI null fat but a long TI null CSF?', a: 'The null comes at about T1·ln 2: fat\'s T1 of 0.38 s gives about 260 ms, CSF\'s T1 of 4 s about 2.8 s.' },
                { q: 'FLAIR uses TI 2400 ms, not 2.8 s. Why is the null earlier?', a: 'TR (9 s) is not much longer than CSF\'s T1, so CSF has not fully recovered when the next inversion comes; starting from less than +M0, it reaches zero sooner: TI ≈ T1·ln(2 / (1 + e<sup>−TR/T1</sup>)) ≈ 2.4 s.' },
                { q: 'After gadolinium, what happens to the enhancing lesions on STIR, and why?', a: 'They go dark, exactly where gre_t1 shows them bright. Gadolinium shortens their T1 to about that of fat (at 0.5 mM, 1/T1 ≈ 1/1.6 s + 4 × 0.5 ≈ 2.6 s⁻¹, so T1 ≈ 0.38 s), and STIR nulls everything with that T1. That is why fat is suppressed spectrally, not with STIR, after contrast.' }
            ],
            takeaway: 'TI picks which T1 to erase: about T1·ln 2, earlier when TR is not much longer than T1.'
        },
        {
            n: 7, id: 't2star', title: 'Gradient echo, T2* and susceptibility', tab: 'image', minutes: 7,
            concept: 'Without a refocusing pulse, field differences within a voxel keep dephasing the spins until the echo, so a gradient echo decays with T2*, shorter than T2. Next to air (the frontal sinus) the field varies steeply and the signal drops out.',
            goal: 'See susceptibility dropout grow with TE, and vanish with a spin echo.',
            setup: { phantom: 'brain', preset: 'gre_t2s', tab: 'image' },
            loads: 'the T2*-weighted gradient echo (TE 20 ms) on the brain, and opens the Image tab.',
            steps: [
                'Look at the front of the head, above the frontal sinus: the orbitofrontal region is dark.',
                'In the <b>Phantom</b> tab choose <b>Map: Off-resonance (Hz)</b>: up to about +120 Hz next to the sinus, smaller offsets near the ears.',
                'In the Sequence tab\'s Parameters set <b>TE</b> to 40 ms, then 60 ms. The dropout grows.',
                'Load the spin echo (<code>se</code>) and set TE to 40 ms: the frontal region is back.',
                'In the <b>Artifacts</b> tab\'s B0 card, raise <b>Susceptibility field</b> to 2 and repeat with both sequences.'
            ],
            questions: [
                { q: 'Why does the dropout grow with TE?', a: 'Spins in a voxel with a spread of frequencies Δf drift apart in phase by 2π·Δf·TE. The longer the TE, the more their signals cancel.' },
                { q: 'Why does the spin echo not show the dropout?', a: 'The 180° pulse at TE/2 reverses the phase every spin has gained, so static off-resonance has fully refocused at the echo. Only T2 decay remains.' },
                { q: 'Which relaxation time sets the gradient-echo signal, and how is it related to T2?', a: 'T2*, with 1/T2* = 1/T2 + 1/T2′, where T2′ comes from static field differences within the voxel. T2* ≤ T2; a spin echo recovers the T2′ part.' }
            ],
            simpl: 'The object is a 2D slice; the field\'s variation through the slice is modelled as a sinc(G<sub>z</sub>·Δz·τ) loss, so the dropout also grows with slice thickness.',
            takeaway: 'Gradient echoes see T2* and lose signal next to air; spin echoes refocus static field differences.'
        },
        {
            n: 8, id: 'fat', title: 'Chemical shift and fat suppression', tab: 'image', minutes: 8,
            concept: 'Fat precesses 3.4 ppm (about 434 Hz at 3 T) slower than water. Along the readout that becomes a shift of 434 Hz ÷ BW pixels; in a gradient echo it is also a phase difference of 434 Hz × TE cycles.',
            goal: 'Measure the fat shift, see in-phase and opposed-phase echoes, and suppress fat.',
            setup: { phantom: 'waterfat', preset: 'se', coil: 'body', tab: 'image' },
            loads: 'the water-and-fat phantom with the spin echo and the body coil, and opens the Image tab.',
            steps: [
                'Spin echo at 150 Hz/px: the oil ring and the oil vial sit shifted along x relative to the water. The Sequence tab\'s <b>Numbers</b> table lists the <b>Fat shift</b>.',
                'Set <b>BW</b> to 50 Hz/px: an 8.7-pixel shift. Then 600 Hz/px: under one pixel, but a noisier image.',
                'Load <code>gre_t1</code> (Preset) and set <b>TE</b> to 3.45 ms, then 4.6 ms (or use the TE buttons in the Artifacts tab\'s Chemical shift card). Watch the boundary between water and the oil ring.',
                'Load <code>gre_fatsat</code>: the oil goes dark. In the Artifacts tab\'s B0 card set <b>Susceptibility field</b> to 3 and <b>Unshimmed residual field</b> to 1: fat saturation fails along one edge.'
            ],
            questions: [
                { q: 'Why does fat shift along the readout but not along the phase-encode direction?', a: 'The readout encodes position by frequency while the echo is recorded, so a frequency offset becomes a position offset. Phase encoding uses the same TE for every line, so fat\'s extra phase is the same in every line and moves nothing (EPI, which spreads phase encoding over time, is the exception).' },
                { q: 'Why does the water-oil boundary turn black at TE 3.45 ms but not at 4.6 ms?', a: '434 Hz × 3.45 ms = 1.5 cycles: in voxels holding both, fat and water point in opposite directions and cancel. At 4.6 ms (2.0 cycles) they add again.' },
                { q: 'Why does fat saturation fail where the field is off?', a: 'The saturation pulse covers a narrow band (about 200 Hz) centred 434 Hz below water. Where B0 moves the fat resonance out of that band the fat is not saturated, and where it moves water into the band the water would be.' }
            ],
            takeaway: 'Fat shift = 434 Hz ÷ BW per pixel; opposed phase at 1.15, 3.45, 5.75 ms; spectral fat suppression needs a good shim.'
        },
        {
            n: 9, id: 'fast', title: 'Fast imaging: turbo spin echo and EPI', tab: 'kspace', minutes: 8,
            concept: 'Recording several k-space lines per excitation shortens the scan: a turbo spin echo uses a train of 180° pulses, EPI a train of gradient echoes. Each line then has its own echo time, and the line at the centre of k-space sets the contrast.',
            goal: 'Compare scan times, see the echo-time ordering in k-space, and see why EPI is so sensitive to off-resonance.',
            setup: { phantom: 'brain', preset: 'tse', tab: 'kspace' },
            loads: 'the turbo spin echo (ETL 16, ESP 10 ms) on the brain, and opens the k-space tab.',
            steps: [
                'Read the scan time in the scan bar, then load the spin echo (<code>se</code>, same TR of 3000 ms) and compare. Load <code>tse</code> again.',
                'In the k-space tab switch on <b>Time since excitation</b>: 16 horizontal bands, one per echo. The centre band is at TEeff = (ETL/2 + 1) × ESP = 90 ms.',
                'In the Sequence tab\'s Parameters set <b>ETL</b> to 32 and <b>ESP</b> to 8 ms. Note the scan time and the new TEeff.',
                'Load <code>epi</code>: one excitation, 64 lines in 51 ms. In the Sequence tab\'s <b>Numbers</b>, read <b>Phase-encode BW / pixel</b>, then look at the front of the head in the image.',
                'Back in the k-space tab, with Time since excitation on, the EPI time runs continuously from one edge of k-space to the other.'
            ],
            questions: [
                { q: 'How much faster is the TSE with ETL 16 than the spin echo, and what limits the echo train?', a: '16 times fewer TRs: 27 s against 6.5 min here. Longer trains blur short-T2 tissue, push the effective TE around and deposit more RF power (the SAR limit, which the simulator does not model).' },
                { q: 'What is the effective TE of the default TSE, and why is it not ESP?', a: 'With this linear ordering the centre of k-space is recorded by echo number ETL/2, at (ETL/2 + 1) × ESP = 90 ms. The contrast is set by whichever echo fills the centre.' },
                { q: 'Why is EPI so sensitive to off-resonance along the phase-encode direction?', a: 'Successive lines are 0.8 ms apart, so the phase direction spans 51 ms: the bandwidth per pixel along phase is 1/(64 × 0.8 ms) ≈ 20 Hz. The 120 Hz next to the sinus moves signal about 6 pixels, and fat (434 Hz) would move 22, which is why EPI uses fat suppression.' }
            ],
            takeaway: 'More lines per excitation means faster scans, at the price of echo-time differences across k-space: effective TE, blurring and, in EPI, distortion.'
        },
        {
            n: 10, id: 'motion', title: 'Motion and flow', tab: 'image', minutes: 8,
            concept: 'A readout lasts milliseconds but successive lines are a TR apart, so motion between lines makes the lines disagree. The disagreement is along k<sub>y</sub>, so the artifact spreads along the phase-encode direction, whichever way the object moves.',
            goal: 'Make motion and flow ghosts, predict their spacing, and see radial sampling blur instead of ghosting.',
            setup: { phantom: 'brain', preset: 'se', tab: 'image', artifacts: { motion: { on: true, kind: 'periodic', amp: 0.004, period: 4, axis: 'y' } } },
            loads: 'the spin echo on the brain with periodic motion (4 mm front to back every 4 s), and opens the Image tab.',
            steps: [
                'Look at the ghosts of the head along y (the phase-encode direction).',
                'In the <b>Artifacts</b> tab\'s Motion card, set <b>Direction of motion</b> to Left-right (x). The ghosts still run along y.',
                'Change the <b>Period</b> from 4 s to 5 s, read the predicted ghost spacing under the controls, and check it in the image.',
                'Try <b>Kind of motion</b>: Sudden step, then Random jitter.',
                'With motion still on, load the <code>radial</code> preset (Sequence tab): streaks and blur instead of discrete ghosts.',
                'In the Artifacts tab\'s Pulsatile flow card, press <b>Show me</b>: copies of the enhancing superior sagittal sinus along y.'
            ],
            questions: [
                { q: 'Why are the ghosts always along the phase-encode direction?', a: 'Within one readout (a few ms) the head is effectively still, so each line is self-consistent along k<sub>x</sub>. Motion changes the data from one line to the next, a modulation along k<sub>y</sub>, and a modulation along k<sub>y</sub> spreads signal along y.' },
                { q: 'With TR 3 s and a 4 s period, how far apart are the ghosts? And with a 5 s period?', a: 'With 4 s each line advances 3/4 of a motion cycle, which looks the same as 1/4 of a cycle: ghosts N × 0.25 = 32 pixels apart. With 5 s each line advances 3/5 of a cycle, which looks like 2/5: about N × 0.4 = 51 pixels. (A period of exactly 2 TR would sample the motion at the same two points every time, and where they fall on the cycle decides how strong that N/2 ghost is.)' },
                { q: 'Why does radial sampling blur rather than ghost?', a: 'Every spoke passes through the centre of k-space, so the errors are spread over all angles instead of forming a periodic pattern along one axis; they average into blur and streaks.' }
            ],
            takeaway: 'Motion and flow between lines make ghosts along the phase-encode direction, N × TR ÷ period pixels apart (folded into the FOV).'
        },
        {
            n: 11, id: 'hardware', title: 'Hardware faults: spikes, zipper and Nyquist ghosts', tab: 'image', minutes: 7,
            concept: 'Some artifacts come from the equipment, not the patient: a burst of noise corrupts one sample (spike), a radio signal leaks into the receiver (zipper), or the gradients lag their commands (the EPI Nyquist ghost).',
            goal: 'Recognise each fault in the image and find it in k-space.',
            setup: { phantom: 'brain', preset: 'se', tab: 'image', artifacts: { spike: { on: true, amp: 4, at: 0.37 } } },
            loads: 'the spin echo on the brain with one corrupt sample (an RF spike), and opens the Image tab.',
            steps: [
                'Fine stripes cover the whole image. In the <b>k-space</b> tab (log |S|), find the single bright dot.',
                'In the <b>Artifacts</b> tab\'s Spike card, move <b>When</b>: the stripes change spacing and angle. Then switch the spike off.',
                'Switch on <b>Interference</b> (Zipper card): a line along y, 20 pixels from the centre. Change the <b>Frequency offset</b>, then the sequence\'s <b>BW</b>, and watch the line move by offset ÷ BW pixels.',
                'In the EPI ghost card press <b>Show me</b> (EPI with a 3 µs gradient delay). Then, in the Image tab\'s <b>Advanced</b> section, switch on <b>EPI ghost correction</b>.'
            ],
            questions: [
                { q: 'Why does one bad sample affect the whole image?', a: 'Every k-space sample is one spatial frequency, a stripe pattern spread over the whole image. A wrong sample adds its pattern everywhere.' },
                { q: 'Why is the zipper a line along phase, at a fixed position along the readout?', a: 'A fixed interference frequency lands at one readout position (offset ÷ BW pixels from the centre). Its phase is random from line to line, so along the phase direction it looks like noise.' },
                { q: 'Why is the EPI ghost shifted by exactly half the field of view?', a: 'The delay shifts odd and even echoes in opposite directions: a pattern that repeats every 2 lines. A modulation with period 2Δk along k<sub>y</sub> moves part of the signal by 1/(2Δk) = FOV/2.' }
            ],
            takeaway: 'Spikes are points in k-space, zippers are frequencies, Nyquist ghosts are odd-even inconsistencies: k-space tells you which fault you have.'
        },
        {
            n: 12, id: 'recon', title: 'Reconstruction choices: filtering, partial Fourier, SENSE', tab: 'image', minutes: 8,
            concept: 'The image is the inverse Fourier transform of k-space, plus choices: how to taper the edge of k-space (filtering), how to fill what was skipped (partial Fourier) and how to unfold undersampled data (SENSE). Each trades resolution, noise and artifacts.',
            goal: 'Use the Image tab\'s reconstruction controls and judge each one against the noise-free truth.',
            setup: { phantom: 'brain', preset: 'gre_pf', tab: 'image', recon: { partialFourier: 'zero' } },
            loads: 'the 5/8 partial-Fourier gradient echo on the brain, missing lines filled with zeros, and opens the Image tab.',
            steps: [
                '<code>gre_pf</code> records 5/8 of the lines. Under <b>Partial Fourier</b>, Zero blurs along y; switch to Conjugate, then Homodyne.',
                'Switch on <b>Truth and difference</b> to see what each choice costs against the noise-free image.',
                'Load <code>gre_r2</code> (every other line) and set <b>Parallel imaging</b> to None: the head folds. Choose SENSE: it unfolds, and the <b>Receive coils</b> panel shows the g-factor map.',
                'Load <code>gre_t1</code>, set <b>N</b> to 64 in the Sequence tab, and choose the <b>k-space filter</b> Hamming: the ringing at the skull fades and edges soften. Compare the <b>Row profile</b>.',
                'Try <b>Zero-fill</b> ×2: smaller pixels and a smoother look, but no new detail.'
            ],
            questions: [
                { q: 'Why does homodyne recover the sharpness that zero filling loses?', a: 'For a real-valued object S(−k) = S*(k). Homodyne removes the smooth image phase (measured from the central lines), then conjugate symmetry stands in for the missing lines, so the high spatial frequencies along y come back.' },
                { q: 'Where is the SENSE g-factor largest, and why?', a: 'Where the pixels that fold onto each other are seen almost equally by every coil, typically in the middle of the head along the phase direction. There the unfolding equations are nearly singular and amplify the noise.' },
                { q: 'What does the Hamming filter cost?', a: 'It tapers the edge of k-space, so ringing and noise drop, but the point-spread function widens by about half: a little resolution for a cleaner image.' }
            ],
            takeaway: 'Reconstruction choices trade resolution, noise and artifacts; the truth image shows the price of each.'
        },
        {
            n: 13, id: 'mrs', title: 'Spectroscopy: chemical shift, water suppression, shimming', tab: 'spectro', minutes: 10,
            concept: 'Without gradients the Fourier transform of the FID is a spectrum: one peak per chemical environment, at a shift measured in ppm. Water has to be suppressed to see the metabolites, and the field has to be uniform (shimmed) for the lines to be narrow.',
            goal: 'Acquire a spectrum, suppress water, and shim the magnet by hand and automatically, including the part no shim can fix.',
            setup: { tab: 'spectro', spectro: { phantom: 'braino', preset: 'fid' } },
            loads: 'the pulse-acquire FID on the MRS phantom with default processing and a well-shimmed magnet, and opens the Spectroscopy tab.',
            steps: [
                'The <b>Pulse-acquire FID</b> on the <b>MRS phantom</b>. Set <b>Range</b> to Water, then Full spectral width: the water peak at 4.7 ppm dwarfs everything else.',
                'Choose <b>FID + water suppression</b>: NAA (2.0 ppm), creatine (3.0 ppm) and choline (3.2 ppm) appear. Read <b>Peaks and metrics</b>.',
                'Open the <b>Shim: make B0 uniform</b> panel and press <b>Start unshimmed</b>: the water line broadens and the metabolite peaks smear.',
                'Shim by hand: <b>Z0</b> first (centre the line), then <b>X</b> and <b>Y</b>, then the second-order terms, watching the <b>Field map</b>, the <b>Field histogram</b> and the <b>Water line</b>. Then press <b>Auto-shim</b>.',
                'Switch the <b>Phantom</b> to Brain, press Start unshimmed, then Auto-shim over <b>Whole object</b> and over <b>Centre, 60 mm radius</b>. Look at the frontal sinus in the field map. Compare the two auto-shim methods: <b>Least squares</b> lets the large sinus field pull the fit, <b>Robust</b> (the default) ignores it.'
            ],
            questions: [
                { q: 'Why are spectra labelled in ppm rather than Hz?', a: 'Chemical shifts scale with B0. In ppm (shift ÷ scanner frequency × 10⁶) the positions are the same at any field: NAA is at 2.0 ppm at 1.5 T and at 3 T, although its 2.7 ppm distance from water is 345 Hz at 3 T and half that at 1.5 T.' },
                { q: 'How is the linewidth related to the field?', a: 'Linewidth ≈ 1/(π T2*). A spread of field across the object adds directly, in Hz, to the width of every line; shimming narrows the field histogram and with it the lines.' },
                { q: 'Why can auto-shim not remove the field next to the frontal sinus?', a: 'Shim coils make smooth, low-order fields (a constant, linear and quadratic terms). The sinus field changes over a few millimetres, which would need much higher orders. Shimming a smaller central region helps the centre but leaves the sinus field.' }
            ],
            takeaway: 'δ (ppm) = (f − f<sub>ref</sub>) / f<sub>ref</sub> × 10⁶. Suppress water, shim for narrow lines: shims fix smooth fields, not local susceptibility.'
        }
    ];

    /* ============================================================
       Rendering
       ============================================================ */
    const TAB_INFO = [
        { id: 'scanner', name: 'Scanner', desc: 'The hardware at 3 T: magnet, gradients, RF chain, receive coils; the Larmor frequency.' },
        { id: 'phantom', name: 'Phantom', desc: 'The object: proton density, T1, T2, T2* and field offset at every point.' },
        { id: 'sequence', name: 'Sequence', desc: 'Write or edit the pulse sequence; timing diagram, k-space trajectory, numbers.' },
        { id: 'contrast', name: 'Contrast', desc: 'How relaxation becomes signal: magnetisation curves, contrast, parameter sweeps.' },
        { id: 'kspace', name: 'k-space', desc: 'The raw data: what each sample means, and what removing some of it does.' },
        { id: 'image', name: 'Image', desc: 'Reconstruction choices, truth and difference, SNR, coils and g-factor.' },
        { id: 'artifacts', name: 'Artifacts', desc: 'What goes wrong and why, with a Show me for each artifact.' },
        { id: 'spectro', name: 'Spectroscopy', desc: 'FID and spectrum, water suppression, and shimming the magnet.' }
    ];

    const V = { lessons: {} };
    let done = {};

    function tabExists(id) { return (MRI.ui.tabs || []).some(function (t) { return t && t.id === id; }); }
    function checkIcon() { return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
    function playIcon() { return '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M2.5 1.2v9.6L10.6 6z" fill="currentColor"/></svg>'; }
    const TAB_NAMES = { scanner: 'Scanner', phantom: 'Phantom', sequence: 'Sequence', contrast: 'Contrast', kspace: 'k-space', image: 'Image', artifacts: 'Artifacts', spectro: 'Spectroscopy' };

    function renderProgress() {
        const n = LESSONS.filter(function (L) { return done[L.id]; }).length;
        V.progText.textContent = n + ' of ' + LESSONS.length + ' lessons done';
        V.progBar.style.width = (100 * n / LESSONS.length).toFixed(1) + '%';
        V.progMeter.setAttribute('aria-valuenow', String(n));
        V.clearBtn.disabled = n === 0;
        LESSONS.forEach(function (L) {
            const ui = V.lessons[L.id];
            const d = !!done[L.id];
            ui.el.classList.toggle('is-done', d);
            ui.num.innerHTML = d ? checkIcon() : String(L.n);
            ui.num.setAttribute('aria-label', d ? 'Lesson ' + L.n + ', done' : 'Lesson ' + L.n);
            ui.check.checked = d;
        });
    }
    function setDone(id, b) {
        if (b) done[id] = true; else delete done[id];
        writeJSON(DONE_KEY, done);
        renderProgress();
    }

    function buildLesson(L) {
        const det = el('details', { class: 'ls-lesson', id: 'lesson-' + L.n });
        const num = el('span', { class: 'ls-num', role: 'img', 'aria-label': 'Lesson ' + L.n, text: String(L.n) });
        det.appendChild(el('summary', {}, [
            num,
            el('span', { class: 'ls-head' }, [
                el('span', { class: 'ls-title', text: L.title }),
                el('span', { class: 'ls-meta', text: 'Lesson ' + L.n + ' · about ' + L.minutes + ' min · ' + (TAB_NAMES[L.tab] || L.tab) + ' tab' })
            ])
        ]));
        const body = el('div', { class: 'ls-body' });
        body.appendChild(el('p', { class: 'ls-concept', html: L.concept }));
        body.appendChild(el('p', { class: 'ls-goal', html: '<b>Goal:</b> ' + L.goal }));
        const btn = el('button', { type: 'button', class: 'btn btn-primary btn-sm', html: playIcon() + 'Set up lesson ' + L.n,
            'aria-describedby': 'ls-loads-' + L.n });
        btn.addEventListener('click', function () { runSetup(L); });
        body.appendChild(el('div', { class: 'ls-setup' }, [btn, el('p', { class: 'note', id: 'ls-loads-' + L.n, text: 'Resets the artifacts, loads ' + L.loads })]));
        const missing = el('p', { class: 'callout callout-warn ls-missing', hidden: true });
        body.appendChild(missing);
        body.appendChild(el('h3', { class: 'ls-h-steps', text: 'Steps' }));
        body.appendChild(el('ol', { class: 'ls-steps' }, L.steps.map(function (s) { return el('li', { html: s }); })));
        body.appendChild(el('h3', { text: 'Questions' }));
        body.appendChild(el('div', { class: 'ls-qs' }, L.questions.map(function (q) {
            return el('div', { class: 'ls-q' }, [
                el('p', { html: q.q }),
                el('details', {}, [el('summary', { text: 'What you should see' }), el('p', { html: q.a })])
            ]);
        })));
        if (L.simpl) body.appendChild(el('p', { class: 'simplification', html: 'Simplification: ' + L.simpl }));
        body.appendChild(el('p', { class: 'ls-take', html: '<b>Takeaway:</b> ' + L.takeaway }));
        const check = el('input', { type: 'checkbox', id: 'ls-done-' + L.n });
        check.addEventListener('change', function () { setDone(L.id, check.checked); });
        const next = LESSONS[L.n] ? W().button({ label: 'Next: lesson ' + (L.n + 1), size: 'sm', kind: 'ghost', onClick: function () { openLesson(L.n + 1, true); } }) : null;
        body.appendChild(el('div', { class: 'ls-foot' }, [
            el('label', { class: 'check', for: 'ls-done-' + L.n }, [check, 'I have done this lesson']),
            next
        ]));
        det.appendChild(body);
        det.addEventListener('toggle', function () {
            if (det.open) writeJSON(OPEN_KEY, L.n);
        });
        return { el: det, num: num, check: check, missing: missing };
    }

    /* Open lesson n. scroll: true scrolls to it and focuses its summary;
       'steps' scrolls to its Steps heading and focuses that (the lesson
       strip's "Back to the steps"); 'view' scrolls without moving focus. */
    function openLesson(n, scroll) {
        const L = LESSONS[n - 1];
        if (!L) return;
        const ui = V.lessons[L.id];
        ui.el.open = true;
        if (scroll) {
            const run = function () {
                const target = scroll === 'steps' ? (ui.el.querySelector('.ls-h-steps') || ui.el) : ui.el;
                try { target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' }); } catch (e) { target.scrollIntoView(); }
                if (scroll === 'view') return;
                const f = scroll === 'steps' ? target : ui.el.querySelector('summary');
                if (!f) return;
                if (f !== ui.el && !f.hasAttribute('tabindex') && f.tagName !== 'SUMMARY') f.setAttribute('tabindex', '-1');
                try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
            };
            (root.requestAnimationFrame || setTimeout)(run);
        }
    }

    function checkMissingTabs() {
        LESSONS.forEach(function (L) {
            const ui = V.lessons[L.id];
            const miss = !tabExists(L.tab);
            ui.missing.hidden = !miss;
            if (miss) ui.missing.textContent = 'The ' + (TAB_NAMES[L.tab] || L.tab) + ' tab did not load, so the steps that use it cannot be done. The questions still apply.';
        });
        V.tiles.forEach(function (t) { t.btn.disabled = !tabExists(t.id); });
    }

    function mount(panel) {
        const Wd = W();
        panel.textContent = '';
        V.panel = panel;
        done = readJSON(DONE_KEY, {}) || {};
        if (typeof done !== 'object' || Array.isArray(done)) done = {};
        panel.appendChild(Wd.concept({
            main: true,                 // the Guide's own content: open on the first visit even on a short screen
            eyebrow: 'Welcome',
            title: 'A teaching MRI scanner at 3 T',
            body: '<p>This is a simulated 3 T scanner for NBL 425/625. You pick or write a pulse sequence, image a phantom, watch k-space fill and the image form, switch artifacts on and off, and record a proton spectrum. Every tab is one idea, and the lessons below walk through them in order.</p>' +
                '<p>It is a <b>teaching model, not a physics engine</b>: one 2D slice, one echo pathway per sequence, ideal spoiling and round-number tissue values from the literature. Where a simplification could mislead a careful student, the tab says so.</p>',
            formula: 'f = γ̄ (B<sub>0</sub> + <b>G</b>·<b>r</b>), &nbsp; γ̄ = 42.58 MHz/T, &nbsp; f<sub>0</sub> = 127.73 MHz at 3 T',
            tryTitle: 'Start here',
            tryThis: [
                { html: 'Press <b>Acquire</b> in the scan bar and watch the k-space and image thumbnails fill as the sequence plays.', label: terms().tryIt || 'Try it', run: function () { A().runScan({ animate: true }); } },
                { html: 'Work through <b>Lesson 1</b> below: the scanner and the Larmor frequency.', label: 'Open lesson 1', run: function () { openLesson(1, true); } },
                { html: 'Or jump to the <b>Artifacts</b> tab and press any <b>Show me</b>.', label: terms().showMe || 'Show me', run: function () { A().showTab('artifacts', { focus: true }); } }
            ]
        }));

        // How the tabs map onto concepts.
        const tabsPanel = el('section', { class: 'panel', 'aria-labelledby': 'ls-tabs-title' });
        tabsPanel.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ls-tabs-title', text: 'One tab, one idea' }),
            el('span', { class: 'panel-sub', text: 'from the hardware to the image, then what goes wrong, then spectroscopy' })
        ]));
        const grid = el('div', { class: 'grid ls-tabs' });
        V.tiles = TAB_INFO.map(function (t) {
            const b = el('button', { type: 'button', class: 'btn ls-tile', 'aria-label': 'Open the ' + t.name + ' tab: ' + t.desc }, [
                el('span', { class: 'ls-tile-name', text: t.name }), el('span', { class: 'ls-tile-desc', text: t.desc })
            ]);
            b.addEventListener('click', function () { A().showTab(t.id, { focus: true }); });
            grid.appendChild(b);
            return { id: t.id, btn: b };
        });
        tabsPanel.appendChild(grid);
        const layout = el('div', { class: 'split ls-layout' });
        const main = el('div', { class: 'ls-main' }), side = el('div', { class: 'ls-side', role: 'group', 'aria-label': 'How the simulator is organised' });
        layout.appendChild(main); layout.appendChild(side);
        panel.appendChild(layout);
        side.appendChild(tabsPanel);

        // The scan bar.
        const barPanel = el('section', { class: 'panel', 'aria-labelledby': 'ls-bar-title' });
        barPanel.appendChild(el('div', { class: 'panel-head' }, [el('h2', { class: 'panel-title', id: 'ls-bar-title', text: 'The scan bar' })]));
        barPanel.appendChild(el('ul', { class: 'ls-bar-list' }, [
            el('li', { html: '<b>Acquire</b> runs the sequence on the phantom and plays it back: k-space fills line by line and the image builds up. <b>Stop</b> keeps what has been acquired so far.' }),
            el('li', { html: '<b>Speed</b>: Instant skips the playback; Fast plays the whole scan in about 4 s and Slow in about 15 s, whatever its real length (the summary line gives the real scan time).' }),
            el('li', { html: '<b>Auto re-scan</b> (on by default) re-scans instantly a moment after you change the phantom, the sequence, an artifact or the coil, so every tab stays up to date. Switch it off to change several things first, then press Acquire.' }),
            el('li', { html: 'The summary line names the sequence, phantom, matrix, TR, TE and scan time; the two <b>thumbnails</b> (k-space and image) open their tabs.' })
        ]));
        barPanel.appendChild(el('p', { class: 'simplification mb-0', text: 'Everything here is computed from a model at 3 T only: tissue relaxation times, the field offsets near air, the coil sensitivities and the noise level are teaching values chosen to behave like a real scanner, not measurements.' }));
        side.appendChild(barPanel);

        // Lessons.
        const lp = el('section', { class: 'panel', 'aria-labelledby': 'ls-lessons-title' });
        V.progText = el('span', { class: 'panel-sub' });
        V.progBar = el('span');
        V.progMeter = el('div', { class: 'ls-meter', role: 'progressbar', 'aria-label': 'Lessons done', 'aria-valuemin': '0', 'aria-valuemax': String(LESSONS.length), 'aria-valuenow': '0' }, [V.progBar]);
        V.clearBtn = Wd.button({ label: 'Clear progress', size: 'xs', kind: 'ghost', title: 'Untick every lesson (stored only in this browser)', onClick: function () {
            done = {}; writeJSON(DONE_KEY, done); renderProgress();
        } });
        lp.appendChild(el('div', { class: 'panel-head' }, [
            el('h2', { class: 'panel-title', id: 'ls-lessons-title', text: 'Lessons' }),
            el('span', { class: 'spacer' })
        ]));
        lp.appendChild(el('div', { class: 'ls-progress mb-2' }, [V.progMeter, V.progText, V.clearBtn]));
        lp.appendChild(el('p', { class: 'note', text: 'Each takes 5 to 10 minutes. Set up resets the artifacts and loads everything the lesson needs, so the lessons do not depend on one another. Your ticks are kept in this browser only.' }));
        const list = el('div', { class: 'ls-lessons' });
        LESSONS.forEach(function (L) {
            const ui = buildLesson(L);
            V.lessons[L.id] = ui;
            list.appendChild(ui.el);
        });
        lp.appendChild(list);
        main.appendChild(lp);

        const lastOpen = readJSON(OPEN_KEY, null);
        if (lastOpen && LESSONS[lastOpen - 1]) V.lessons[LESSONS[lastOpen - 1].id].el.open = true;
        renderProgress();
        checkMissingTabs();
    }

    function onShow() {
        if (!V.tiles) return;
        const con = doc.getElementById('console');
        const top = (con && root.getComputedStyle(con).position === 'sticky' ? con.offsetHeight : 0) + 12;
        if (V.panel) V.panel.style.setProperty('--ls-top', top + 'px');
        checkMissingTabs();
        // Back on the Guide after a set-up: open that lesson and bring it into
        // view, but leave focus where the student put it (the tab bar).
        if (returnTo) { const n = returnTo; returnTo = null; openLesson(n, 'view'); }
    }
    function onHide() {}

    MRI.ui.registerTab({ id: 'lessons', title: 'Guide', order: 0, mount: mount, onShow: onShow, onHide: onHide });
})(typeof window !== 'undefined' ? window : globalThis);
