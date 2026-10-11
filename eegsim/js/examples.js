/* EEG simulator: example programs.  The first one loads with the page. */
(function (G) {
  'use strict';
  const EEG = G.EEG;
  EEG.EXAMPLES = [
    {
      name: 'Teaching tour',
      desc: 'Eyes closed and open for the alpha rhythm, then a visual oddball for the P300, with the everyday artifacts switched on.',
      src: `# A short session that touches most of the course: eyes closed and
# open to show the alpha rhythm, then a visual oddball for the P300.
recording {
  cap 32
  reference Cz          # online reference, re-referenced later
  ground AFz
  rate 250 Hz
  highpass 0.1 Hz       # hardware filters, applied while recording
  lowpass 70 Hz
  impedance 5 kOhm
  mains 60 Hz
}

source alpha occipital {
  amp 100 nAm  freq 10 Hz
  closed 100%  open 25%   # Berger: opening the eyes blocks alpha
  erd 50%                 # and so does attending to a stimulus
}

source erp visual {
  at Oz depth 3 cm  orient radial  amp 20 nAm
  peak 100 ms 30 ms 1     # P1
  peak 170 ms 50 ms -1.4  # N1
}

source erp P3 {
  at Pz depth 4 cm  orient radial  amp 40 nAm
  latency 380 ms  width 220 ms  jitter 40 ms
  condition target 1
  condition standard 0.15
}

timeline {
  block closed 20 s
  block open 20 s
  block closed 20 s
  trials 160 isi 1.1 s jitter 0.3 s {
    condition standard 80%
    condition target 20%
  }
}

artifacts {
  blinks 0.2 Hz 150 uV
  cardiac 72 bpm
  line 50 mV
  drift 20 uV
}

analysis {
  reference average
  highpass 0.3 Hz  lowpass 30 Hz
  epoch -200 800 ms  baseline -200 0 ms
  reject 100 uV
}
`
    },
    {
      name: 'Eyes closed, eyes open',
      desc: 'Hans Berger’s observation: the posterior alpha rhythm appears when the eyes close and is blocked when they open. Nineteen channels, linked mastoids.',
      src: `# The Berger effect, on a clinical 19-channel cap.
recording {
  cap 19
  reference M1
  rate 250 Hz
  highpass 0.1 Hz
  lowpass 70 Hz
  mains 60 Hz
}

source alpha occipital {
  amp 110 nAm  freq 10 Hz  bandwidth 1.2 Hz
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
  blinks 0.3 Hz        # blinks only happen with the eyes open
  saccades 0.2 Hz
}

analysis { reference mastoids  highpass 0.5 Hz  lowpass 40 Hz }
`
    },
    {
      name: 'P300 oddball',
      desc: 'Rare targets among frequent standards. Watch the P300 emerge from the noise as trials accumulate, and see what latency jitter does to its peak.',
      src: `# Classic oddball. Targets are 20% of trials.
recording {
  cap 32
  reference Cz
  rate 250 Hz
  highpass 0.1 Hz
  lowpass 70 Hz
  background 10 uV
}

source erp visual {
  at Oz depth 3 cm  amp 20 nAm
  peak 100 ms 30 ms 1
  peak 170 ms 50 ms -1.4
}

source erp P3 {
  at Pz depth 4 cm  amp 45 nAm
  latency 380 ms  width 220 ms
  jitter 60 ms          # try 0 ms and compare the peak
  condition target 1
  condition standard 0.1
}

timeline {
  trials 250 isi 1 s jitter 0.4 s {
    condition standard 80%
    condition target 20%
  }
}

artifacts {
  blinks 0.15 Hz
  line 30 mV
}

analysis {
  reference mastoids
  highpass 0.1 Hz  lowpass 30 Hz
  epoch -200 900 ms  baseline -200 0 ms
  reject 100 uV
}
`
    },
    {
      name: 'Faces and houses: N170',
      desc: 'A face-selective negativity over right occipitotemporal cortex near 170 ms, with its positive counterpart at the vertex. 64 channels.',
      src: `# The N170 is larger for faces than for houses, and larger on the right.
recording {
  cap 64
  reference Cz
  rate 250 Hz
  highpass 0.1 Hz
  lowpass 70 Hz
}

source erp P1 {
  at Oz depth 3 cm  amp 15 nAm
  peak 100 ms 35 ms 1
}

source erp N170R {
  at P8 depth 3 cm  orient 140 deg toward Cz  amp 35 nAm
  peak 170 ms 45 ms 1
  condition face 1
  condition house 0.4
}

source erp N170L {
  at P7 depth 3 cm  orient 140 deg toward Cz  amp 25 nAm
  peak 175 ms 45 ms 1
  condition face 1
  condition house 0.4
}

timeline {
  trials 200 isi 1 s jitter 0.3 s {
    condition face 50%
    condition house 50%
  }
}

artifacts { blinks 0.15 Hz }

analysis {
  reference average
  highpass 0.1 Hz  lowpass 30 Hz
  epoch -200 600 ms  baseline -200 0 ms
  reject 100 uV
}
`
    },
    {
      name: 'One dipole',
      desc: 'A single oscillating dipole and nothing else. The place to start on volume conduction: move it, tilt it, push it deeper, and watch every electrode respond.',
      src: `# One source, no background, no artifacts: pure volume conduction.
recording {
  cap 32
  reference Cz
  rate 250 Hz
  highpass off
  lowpass 100 Hz
  background off
}

source dipole D {
  at C3 depth 2 cm  orient radial
  amp 20 nAm
  signal sine 6 Hz
}

timeline { block open 30 s }

analysis { reference average }
`
    },
    {
      name: 'Two dipoles: mixing and connectivity',
      desc: 'Two beta generators that are independent of each other. Volume conduction still makes nearby electrodes look coherent; the imaginary part of coherency does not fall for it.',
      src: `# Two independent 20 Hz generators over the motor strips. Coherence
# between C3 and its neighbours is high anyway: one source, two
# electrodes. Set coupling to 0.7 and lag to 15 ms to connect them.
recording {
  cap 32
  reference Cz
  rate 250 Hz
  highpass 0.1 Hz
  lowpass 70 Hz
  background 4 uV
}

source pair motor {
  dipole A { at C3 depth 2.2 cm  orient radial }
  dipole B { at C4 depth 2.2 cm  orient radial }
  rhythm 20 Hz  amp 30 nAm
  coupling 0  lag 0 ms
}

timeline { block open 60 s }

analysis { reference average  highpass 1 Hz  lowpass 45 Hz }
`
    },
    {
      name: 'Interictal spikes, left temporal',
      desc: 'Sharp, surface-negative spikes from a left temporal focus. In the longitudinal bipolar montage they reverse phase around T7, the way an electroencephalographer localizes them.',
      src: `# A left mid-temporal focus. Look at the bipolar chain Fp1-F7-T7-P7-O1.
recording {
  cap 19
  reference Cz
  rate 250 Hz
  highpass 0.5 Hz
  lowpass 70 Hz
  mains 60 Hz
}

source spike focus {
  at T7 depth 2.2 cm  orient inward
  amp 600 nAm  rate 0.25 Hz  width 70 ms  wave 60%
}

source alpha occipital { amp 70 nAm  closed 100%  open 40% }

timeline { block open 60 s  block closed 30 s }

artifacts {
  blinks 0.2 Hz
  muscle 0.03 Hz
  cardiac 66 bpm
}

analysis { reference bipolar  highpass 1 Hz  lowpass 70 Hz  notch 60 Hz }
`
    },
    {
      name: 'Artifact zoo for ICA',
      desc: 'Every artifact at once, plus a bad channel. Run ICA on the Processing tab and decide which components to throw away.',
      src: `# Everything that goes wrong in a real recording, all at once.
recording {
  cap 32
  reference Cz
  rate 250 Hz
  highpass 0.1 Hz
  lowpass 100 Hz
  mains 60 Hz
}

source alpha occipital { amp 90 nAm  closed 100%  open 30% }

source erp P3 {
  at Pz depth 4 cm  amp 40 nAm
  latency 380 ms  width 220 ms  jitter 30 ms
  condition target 1
  condition standard 0.15
}

timeline {
  block closed 20 s
  trials 160 isi 1.1 s jitter 0.3 s {
    condition standard 80%
    condition target 20%
  }
}

artifacts {
  blinks 0.3 Hz 180 uV
  saccades 0.15 Hz
  muscle 0.06 Hz
  cardiac 75 bpm 8 uV
  line 60 mV
  drift 30 uV
  pops 0.03 Hz
  bad T8 120 kOhm
}

analysis {
  reference average
  highpass 0.5 Hz  lowpass 40 Hz
  epoch -200 800 ms  baseline -200 0 ms
  ica 20
}
`
    }
  ];
})(typeof window !== 'undefined' ? window : globalThis);
