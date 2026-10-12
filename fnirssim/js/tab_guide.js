/* fNIRS simulator: the Guide tab.  Short lessons, each tied to an example
   program and a tab. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, ui = NIRS.ui, $ = ui.$;
  const ex = name => NIRS.EXAMPLES.findIndex(e => e.name === name);

  const LESSONS = [
    { t: 'The instrument', tab: 'system', steps: [
      'Click each part of the schematic and read what it does.',
      'Open <em>Multiplexing</em>. Switch between time, frequency and none, with and without room light. Which scheme loses light, which loses nothing, which cannot tell sources apart?',
      'Open <em>CW, FD, TD</em>. Move absorption and scattering so the continuous-wave intensity stays the same (along the solid curve). What changes in the frequency-domain phase and in the time-of-flight curve?'] },
    { t: 'The banana and the separation trade-off', tab: 'light', steps: [
      'Watch individual photons scatter. Most leave near the source; only a few reach the detector, and their paths form a banana.',
      'Move the separation from 1 to 5 cm. Read the detected power and the share of the path in the brain. Where would you put a detector, and why do most adult probes use 3 to 3.5 cm?',
      'Switch to the infant and the thick skull. How short could an infant channel be and still reach the brain?',
      'Tick "only late photons". Why does a time-domain system not need short channels?'] },
    { t: 'Why two wavelengths, and which two', tab: 'spectra', steps: [
      'Find the near-infrared window and the isosbestic point on the absorption plot.',
      'Try the presets. Watch the condition number and the noise gain, and the recovered curves in the bottom panel.',
      'Pick 830 and 850 nm, set the noise to zero and add a 10% error in the DPF ratio. Where does HbO end up?',
      'Click around the all-pairs map. Why is the whole top-right quarter bad?'] },
    { t: 'From light to haemoglobin', tab: 'mbll', steps: [
      'Follow one channel from intensity to optical density to concentration. Click a plot to move the cursor and check the arithmetic in the equation.',
      'Change the DPF at both wavelengths together, then only at one. Which change rescales the result, and which mixes HbO with HbR?',
      'Compare the true local change in the cortex with what the law reports, and read why they differ (partial volume).'] },
    { t: 'What the probe can see', example: 'Finger tapping, block design', tab: 'head', steps: [
      'Drag the activation across the probe and watch the channel sensitivities follow it.',
      'Push the depth from 15 to 30 mm. At what depth does it vanish from every channel?',
      'Switch to the thick skull, then press Apply and compare the averages with the adult.'] },
    { t: 'Physiology in the spectrum', example: 'Finger tapping, block design', tab: 'recording', steps: [
      'Find the heartbeat on the raw intensity, then the peaks for the heart, breathing and Mayer waves in the spectrum.',
      'Load "Sampling too slowly". Where does the heartbeat go, and why can the scalp coupling index not be computed?'] },
    { t: 'A false activation from the scalp', example: 'Scalp confound: a false activation', tab: 'averaging', steps: [
      'Every long channel shows HbO up and HbR down, time-locked to the task. The cortex did nothing (the dashed truth is flat).',
      'On the Confounds tab, look at "task-evoked blood pressure" alone, and at the short channels.',
      'On the Processing tab, switch short-channel regression to Nearest. Back on the Averaging tab, the activation is gone; the dotted lines show what was removed.',
      'Load "Finger tapping" and compare estimating the short channel\'s weight "with the task" and "before". Which one also removes some of the real response, and why?'] },
    { t: 'Is the optode on the head?', example: 'Dense, dark hair', tab: 'processing', steps: [
      'Read the quality table: light levels, coefficient of variation and the scalp coupling index. Why does the SCI fail where the heartbeat disappears?',
      'In the program change the detector to sipm and rebuild. Which channels come back, and what would a SiPM do to the short channels in a bald participant?',
      'Load "A loose optode and room light": find the loose optode on the channel maps.'] },
    { t: 'Motion', example: 'Motion artifacts', tab: 'processing', steps: [
      'Find the spikes and the steps in the optical density (the dashed lines mark the true motion events).',
      'Compare no correction, TDDR and spline here and on the Averaging tab against the truth. Which handles steps, which spikes, and what does each cost a clean response?'] },
    { t: 'The average emerging', example: 'Finger tapping, block design', tab: 'averaging', steps: [
      'Press "Play from one trial" and watch the canonical response appear: HbO up, HbR down by about a third, both back to baseline after the block.',
      'Read how the peak-to-standard-error ratio grows with the number of trials. Is it close to the square root?'] },
    { t: 'The GLM', example: 'Event-related: right vs left hand', tab: 'averaging', steps: [
      'Trials 10 s apart overlap, so block averages blur. Open the GLM view and compare the right- and left-hand betas on the statistic map.',
      'Switch the noise model from AR to OLS. Why do the t values inflate, and what does that do to false positives?'] },
    { t: 'Connectivity and the scalp', example: 'Resting-state connectivity pair', tab: 'averaging', steps: [
      'Open Connectivity. With short-channel regression off, every channel correlates with every other one.',
      'Switch regression on (Processing tab) and look again: the coupled pair stands out from the rest. What is the mean correlation among channels that see neither region, before and after?'] },
    { t: 'fNIRS and fMRI', tab: 'compare', steps: [
      'Compare −HbR with BOLD: almost the same shape. Why is BOLD closest to HbR rather than HbO?',
      'Lower the coupling ratio n toward 1.3 (oxygen use rising almost as much as flow). What happens to HbR and BOLD, and to HbO?',
      'Make the repetition time 3 s and the stimulus a 2 s event. How many fMRI samples describe the response?'] },
    { t: 'From channels to images', tab: 'dot', steps: [
      'With the high-density array, find the target in the top and depth views. Move it deeper.',
      'Switch to the sparse array, then to nearest neighbours only. What can each say about depth?',
      'Add a second target and move them together. How close can they be and still be told apart?'] }
  ];

  NIRS.tabs.guide = {
    init() {
      $('guideLessons').innerHTML = '<h2>Lessons</h2><p>Each lesson takes a few minutes. The buttons load the example it needs and open the tab.</p>' +
        LESSONS.map((L, i) => `<div class="lesson"><h3>${i + 1}. ${L.t}</h3><ol>${L.steps.map(s => `<li>${s}</li>`).join('')}</ol>
          <div class="btnrow go"><button class="ghost small" data-i="${i}">${L.example ? `Load "${L.example}" and open ${tabLabel(L.tab)}` : `Open ${tabLabel(L.tab)}`}</button></div></div>`).join('');
      $('guideLessons').querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => {
        const L = LESSONS[+b.dataset.i];
        if (L.example) { const k = ex(L.example); if (k >= 0) { NIRS.app.loadExample(k, true, L.tab); return; } }
        NIRS.app.showTab(L.tab);
        window.scrollTo({ top: 0 });
      }));
    },
    render() {}
  };
  function tabLabel(t) { const b = document.getElementById('t-' + t); return b ? b.textContent.replace(/^\d+/, '').trim() : t; }
})(typeof window !== 'undefined' ? window : globalThis);
