/* MEG simulator: example programs.  The first one loads with the page. */
(function (G) {
  'use strict';
  const MEG = G.MEG;
  MEG.EXAMPLES = [
    {
      name: 'Teaching tour',
      desc: 'Eyes closed and open for alpha, then an auditory oddball for the M100, on SQUID magnetometers in a shielded room with the everyday artifacts.',
      src: `# A short session that touches most of the course: alpha with the
# eyes closed and open, then tones for the auditory M100.
recording {
  sensors magnetometers   # 105 SQUID magnetometers in a helmet
  rate 500 Hz
  highpass 0.1 Hz         # online filters, applied while recording
  lowpass 150 Hz
  mains 60 Hz
  background 150 fT       # spontaneous brain activity
}

shielding {
  room on                 # magnetically shielded room
  references on           # reference-array gradient compensation
  ssp off
  sss off
}

source alpha occipital {
  amp 45 nAm  freq 10 Hz
  closed 100%  open 25%   # opening the eyes blocks alpha
}

source auditory M100 {
  side both               # both auditory cortices, same waveform
  amp 30 nAm  latency 100 ms  jitter 8 ms
  condition standard 1
  condition deviant 1.4
}

timeline {
  block closed 20 s
  block open 20 s
  trials 150 isi 0.9 s jitter 0.2 s {
    condition standard 85%
    condition deviant 15%
  }
}

artifacts {
  environment 50 nT       # elevators and traffic, before the room
  line 100 nT
  cardiac 70 bpm 3 pT
  blinks 0.2 Hz 2 pT
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
  reject 4 pT
}
`
    },
    {
      name: 'One dipole: MEG and EEG',
      desc: 'A single oscillating current dipole and nothing else. The place to start: rotate it from tangential to radial, push it deeper, and compare the MEG field map with the EEG potential map.',
      src: `# One source, no background, no artifacts: pure field geometry.
recording {
  sensors magnetometers
  rate 500 Hz
  highpass off
  lowpass 150 Hz
  background off
}

source dipole D {
  at C3 depth 2.5 cm
  orient tangential dir 0 deg   # current flowing toward the nose
  amp 20 nAm
  signal sine 8 Hz
}

timeline { block open 30 s }
`
    },
    {
      name: 'Auditory M100, planar gradiometers',
      desc: 'Tones on a Vectorview-style array of planar gradiometers with SSS. Watch the M100 emerge from the noise, and see why a beamformer struggles with two perfectly correlated auditory cortices.',
      src: `# Binaural tones: both auditory cortices respond together.
recording {
  sensors planar          # two gradiometers and a magnetometer per site: 315 channels
  rate 400 Hz
  highpass 0.1 Hz
  lowpass 120 Hz
  background 180 fT
}

shielding { room on  sss on }

source auditory M100 {
  side both  amp 35 nAm  latency 100 ms  jitter 10 ms
}

timeline {
  trials 90 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 50 nT
  line 100 nT
  cardiac 72 bpm 3 pT
  blinks 0.15 Hz 2 pT
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
}
`
    },
    {
      name: 'Somatosensory: median nerve',
      desc: 'Right median nerve stimulation on CTF-style axial gradiometers with reference compensation: the N20m from area 3b, and the beta rhythm of motor cortex dropping and then rebounding after each stimulus.',
      src: `# Electrical stimulation of the right wrist reaches the left hand area
# of primary somatosensory cortex about 20 ms later.
recording {
  sensors axial           # axial gradiometers, 5 cm baseline
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 150 fT
}

shielding { room on  references on }

source somatosensory SEF {
  side left               # the hemisphere: contralateral to the hand
  amp 22 nAm  jitter 1 ms
  beta 20 Hz 18 nAm  erd 60%  rebound 120%
}

timeline {
  trials 120 isi 1.5 s jitter 0.3 s { condition median 100% }
}

artifacts {
  environment 50 nT
  line 100 nT
  cardiac 64 bpm 3 pT
  muscle 0.03 Hz 2 pT
}

analysis {
  highpass 1 Hz  lowpass 150 Hz
  epoch -50 150 ms  baseline -50 -5 ms
}
`
    },
    {
      name: 'Eyes closed, eyes open',
      desc: 'Berger’s alpha on magnetometers: the parieto-occipital rhythm grows tenfold when the eyes close. Compare the spectra and the band maps, and see where MEG puts it.',
      src: `# Alternating blocks of eyes closed and eyes open.
recording {
  sensors magnetometers
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 150 fT
}

shielding { room on  references on }

source alpha occipital {
  amp 55 nAm  freq 10 Hz  bandwidth 1.2 Hz
  closed 100%  open 15%
}

timeline {
  block closed 15 s
  block open 15 s
  block closed 15 s
  block open 15 s
  block closed 15 s
  block open 15 s
}

artifacts {
  cardiac 70 bpm 3 pT
  blinks 0.3 Hz 2 pT     # blinks only happen with the eyes open
  saccades 0.2 Hz 1 pT
}

analysis { highpass 0.5 Hz  lowpass 40 Hz }
`
    },
    {
      name: 'Two dipoles: mixing and leakage',
      desc: 'Two beta generators 3 cm apart in one hemisphere. Their fields overlap at the sensors, and their source estimates leak into each other. Set coupling to 0.7 and lag to 10 ms to connect them.',
      src: `# Two nearby, independent 20 Hz generators.
recording {
  sensors planar
  rate 400 Hz
  highpass 0.1 Hz
  lowpass 120 Hz
  background 100 fT
}

shielding { room on  sss on }

source pair motor {
  dipole A { at C3 depth 2.5 cm  orient tangential dir 0 deg }
  dipole B { at C5 depth 2.5 cm  orient tangential dir 60 deg }
  rhythm 20 Hz  amp 25 nAm
  coupling 0  lag 0 ms
}

timeline { block open 60 s }

analysis { highpass 1 Hz  lowpass 45 Hz }
`
    },
    {
      name: 'Interictal spikes, left temporal',
      desc: 'A left temporal epileptiform focus, as in clinical MEG for epilepsy surgery. Spikes stand out on the left temporal sensors; fit a dipole to each one and see how tightly they cluster.',
      src: `# A left mid-temporal focus on the superior temporal gyrus, below T7.
recording {
  sensors magnetometers
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 200 fT
}

shielding { room on  references on }

source spike focus {
  at T9 depth 2.8 cm  orient tangential dir 20 deg
  amp 250 nAm  rate 0.25 Hz  width 70 ms  wave 60%
}

source alpha occipital { amp 40 nAm  closed 100%  open 30% }

timeline { block open 60 s  block closed 30 s }

artifacts {
  cardiac 66 bpm 3 pT
  blinks 0.2 Hz 2 pT
  muscle 0.03 Hz 2 pT
}

analysis { highpass 1 Hz  lowpass 70 Hz  notch 60 Hz }
`
    },
    {
      name: 'Noise zoo',
      desc: 'Every source of trouble at once: environment, line, heart, eyes, muscle, dental work, flux jumps, a noisy channel and a moving head. Switch the noise rejection on step by step on the Noise tab, then run ICA.',
      src: `# Everything that goes wrong, with all noise rejection switched off.
recording {
  sensors magnetometers
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 150 fT
}

shielding {
  room on
  references off
  ssp off
  sss off
}

source auditory M100 { side both  amp 30 nAm }

timeline {
  block open 10 s
  trials 120 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 60 nT
  line 120 nT
  cardiac 72 bpm 4 pT
  blinks 0.25 Hz 2.5 pT
  saccades 0.15 Hz 1 pT
  muscle 0.05 Hz 2 pT
  dental 300 pT
  jumps 0.03 Hz 6 pT
  bad MRT31 noisy
  movement 5 mm
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
  ica 25
}
`
    },
    {
      name: 'No shielded room',
      desc: 'The same brain recorded with the shielded room switched off. The environment is a million times larger than the M100; compare magnetometers with gradiometers, then switch the room back on.',
      src: `# Recording in an ordinary laboratory, without the shielded room.
recording {
  sensors magnetometers
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 150 fT
}

shielding { room off }

source auditory M100 { side both  amp 30 nAm }

timeline {
  trials 100 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 50 nT
  line 100 nT
  cardiac 70 bpm 3 pT
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
}
`
    },
    {
      name: 'OPMs: wearable MEG',
      desc: 'Optically pumped magnetometers on the scalp. The brain signal is larger because the sensors are closer, but the noise floor is higher, and when the head moves the sensors move through the room’s residual field.',
      src: `# A helmet of on-scalp OPMs. The head moves; the sensors move with it.
recording {
  sensors opm
  rate 500 Hz
  highpass 0.1 Hz
  lowpass 150 Hz
  background 150 fT
}

shielding {
  room on
  nulling on              # coils that null the residual field around the head
}

source auditory M100 { side both  amp 30 nAm }

timeline {
  trials 120 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 50 nT
  line 100 nT
  cardiac 70 bpm 3 pT
  movement 1 cm
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
}
`
    },
    {
      name: 'Dental work and tSSS',
      desc: 'A participant with magnetized dental work. SSS removes the environment but keeps the dental artifact, because it sits inside the helmet; temporal SSS removes it.',
      src: `# Braces, chewing and swallowing during an auditory experiment.
recording {
  sensors planar
  rate 400 Hz
  highpass 0.1 Hz
  lowpass 120 Hz
  background 150 fT
}

shielding { room on  sss on }

source auditory M100 { side both  amp 35 nAm }

timeline {
  trials 90 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 50 nT
  dental 400 pT
  cardiac 70 bpm 3 pT
}

analysis {
  highpass 0.5 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
}
`
    },
    {
      name: 'Head movement and compensation',
      desc: 'The head shifts by up to a centimetre during the session. The averaged field blurs; movement compensation through the SSS expansion puts it back.',
      src: `# A restless participant on a SQUID system.
recording {
  sensors planar
  rate 400 Hz
  highpass 0.1 Hz
  lowpass 120 Hz
  background 150 fT
  hpi on                  # coils that let the system track the head
}

shielding { room on  sss on }

source auditory M100 { side both  amp 35 nAm  jitter 5 ms }

timeline {
  trials 90 isi 1 s jitter 0.2 s { condition tone 100% }
}

artifacts {
  environment 50 nT
  cardiac 70 bpm 3 pT
  movement 8 mm
}

analysis {
  highpass 1 Hz  lowpass 40 Hz
  epoch -100 400 ms  baseline -100 0 ms
  compensate on
}
`
    }
  ];
})(typeof window !== 'undefined' ? window : globalThis);
