/* fNIRS simulator: example programs.  Each one sets up a lesson; the
   description says what to look for. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS;

  const PHYS = `physiology {
  cardiac 72 bpm 1.0 uM        # arterial pulse, mostly HbO
  respiration 15 bpm 0.35 uM
  mayer 0.1 Hz 0.6 uM          # blood-pressure waves near 0.1 Hz
  drift 0.8 uM                 # spontaneous low-frequency fluctuations
  taskbp 0.6 uM                # the scalp's blood flow rises with the task
}`;

  NIRS.EXAMPLES = [
    {
      name: 'Finger tapping, block design',
      desc: 'Ten 15 s blocks of right-hand tapping over left motor cortex (C3). The activation sits under channel S3-D1. Look for HbO rising and HbR falling there, and only there, on the Averaging tab. Then switch short-channel regression off on the Processing tab.',
      src: `# Finger tapping over the left motor cortex
recording {
  wavelengths 760 850 nm
  rate 10 Hz
  multiplex time               # sources take turns, with a dark slot
  source laser  power 10 mW
  detector apd
}

probe over C3 {
  layout motor                 # 4 sources, 4 detectors, 3 cm apart,
                               # and an 8 mm short channel at each source
}

head adult { }

activation hand {
  under S3 D1                  # centred below this channel's midpoint
  radius 8 mm
  flow 50%                     # peak rise in blood flow for a sustained block
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  quality sci 0.75 cv 15%
  motion none
  bandpass 0.01 0.2 Hz
  dpf age                      # Scholkmann and Wolf's formula for a 30-year-old
  short nearest glm
  epoch -5 25 s  baseline -5 0 s
  hrf canonical
}
`
    },
    {
      name: 'Scalp confound: a false activation',
      desc: 'No cortical activation at all, but the task raises blood pressure and scalp blood flow. Every long channel shows an "activation" with HbO up and HbR slightly down. Turn short-channel regression on (Processing tab) and watch it disappear on the Averaging tab.',
      src: `# A task with no brain response, only a scalp response
recording { wavelengths 760 850 nm  rate 10 Hz  multiplex time  detector apd }

probe over Fpz { layout motor }

head adult { }

timeline {
  rest 20 s
  blocks 12 on 20 s off 20 s jitter 4 s { condition task }
}

physiology {
  cardiac 72 bpm 1.0 uM
  respiration 15 bpm 0.35 uM
  mayer 0.1 Hz 0.6 uM
  drift 0.8 uM
  taskbp 1.5 uM                # a strong task-evoked scalp response
  heterogeneity 10%
}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short off                    # try: short nearest glm
  epoch -5 30 s  baseline -5 0 s
}
`
    },
    {
      name: 'Event-related: right vs left hand',
      desc: 'Brief (1 s) squeezes of either hand, 12 s apart with jitter. The probe is over the left hemisphere, so right-hand trials drive it strongly and left-hand trials barely. Responses overlap, so compare the block average with the GLM.',
      src: `# Event-related design with two conditions
recording { wavelengths 760 850 nm  rate 10 Hz }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 9 mm
  flow 60%
  condition right 1
  condition left 0.25          # weak ipsilateral response
}

timeline {
  rest 20 s
  events 60 isi 10 s jitter 6 s duration 1 s {
    condition right 50%
    condition left 50%
  }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.3 Hz
  dpf age
  short nearest glm
  epoch -3 18 s  baseline -3 0 s
  hrf canonical
  derivative on
}
`
    },
    {
      name: 'Infant: thin skull, short channels',
      desc: 'A six-month-old: scalp and skull 2 mm each, cortex 6 mm below the surface instead of 14 mm. Light reaches the brain at 2 cm, so the probe is smaller. Compare the brain fraction of the path on the Light tab with the adult.',
      src: `# Infant head, 2 cm channels over the temporal cortex
recording { wavelengths 760 850 nm  rate 10 Hz  power 5 mW }

probe over T7 {
  source S1 at -2 1 cm
  source S2 at 2 1 cm
  source S3 at 0 -1 cm
  detector D1 at 0 1 cm
  detector D2 at -2 -1 cm
  detector D3 at 2 -1 cm
  short S1 5 mm
  short S2 5 mm
  short S3 5 mm
  channels 3 cm
}

head infant { }

activation auditory {
  at 0 0 cm  radius 8 mm
  flow 40%
  condition sound 1
}

timeline {
  rest 20 s
  blocks 8 on 10 s off 20 s jitter 6 s { condition sound }
}

physiology {
  cardiac 130 bpm 1.0 uM       # infants have faster hearts and breathing
  respiration 35 bpm 0.4 uM
  mayer 0.1 Hz 0.4 uM
  drift 0.8 uM
  taskbp 0.4 uM
}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age 0.5
  short nearest glm
  epoch -5 25 s  baseline -5 0 s
}
`
    },
    {
      name: 'Adult with a thick skull',
      desc: 'The same tapping task through 11 mm of skull and 6 mm of scalp. Less light reaches the cortex and the brain share of the path falls, so the measured response shrinks even though the cortex does exactly the same thing.',
      src: `# Same task, thicker skull
recording { wavelengths 760 850 nm  rate 10 Hz  detector apd }

probe over C3 { layout motor }

head thick { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age 45
  short nearest glm
  epoch -5 25 s  baseline -5 0 s
}
`
    },
    {
      name: 'Dense, dark hair',
      desc: 'Hair between the optodes and the scalp blocks and absorbs light, more at 760 than at 850 nm. The long channels drop to a few hundred picowatts, the heartbeat sinks into the noise and the scalp coupling index fails everywhere. Change the detector to sipm, a more sensitive detector, and see which channels come back.',
      src: `# Hair under the optodes
recording { wavelengths 760 850 nm  rate 10 Hz  detector apd }   # try: detector sipm

probe over C3 { layout motor }

head adult { hair dark }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  quality sci 0.75 cv 15%
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'Motion artifacts',
      desc: 'Head movements jolt the optodes: spikes that recover, and shifts that do not. With no correction the averages are ruined. Try motion tddr and motion spline on the Processing tab and compare with the truth on the Averaging tab.',
      src: `# Spikes and baseline shifts
recording { wavelengths 760 850 nm  rate 10 Hz }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

artifacts {
  spikes 3 /min 60%
  shifts 4 40%
}

analysis {
  motion none                  # try tddr or spline
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'A loose optode and room light',
      desc: 'Detector D2 barely touches the scalp, and the room lights flicker at 120 Hz and are switched on part way through. Time multiplexing subtracts a dark slot; switch multiplex to none on the System tab to see what the lock-in or the dark slot was protecting you from.',
      src: `# Coupling and ambient light
recording { wavelengths 760 850 nm  rate 10 Hz  multiplex time  detector apd }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

artifacts {
  poor D2 2%                   # 2% of normal coupling
  ambient 3 nW flicker 120 Hz change 200 s
}

analysis {
  quality sci 0.75 cv 15%
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'Resting-state connectivity pair',
      desc: 'Eight minutes of rest. Two cortical regions, 6 cm apart, share slow spontaneous fluctuations. Systemic physiology correlates every channel with every other one; on the Averaging tab, open Connectivity and compare the matrix with and without short-channel regression.',
      src: `# Resting state with a coupled pair of regions
recording { wavelengths 760 850 nm  rate 10 Hz }

probe over C3 { layout motor }

head adult { }

pair network {
  region A { under S1 D1  radius 9 mm }
  region B { under S4 D4  radius 9 mm }
  coupling 0.8
  fluctuation 20%
  band 0.01 0.1 Hz
}

timeline { rest 480 s }

physiology {
  cardiac 72 bpm 1.0 uM
  respiration 15 bpm 0.35 uM
  mayer 0.1 Hz 0.8 uM
  drift 1.0 uM
}

analysis {
  motion none
  bandpass 0.01 0.1 Hz
  dpf age
  short off                    # try: short nearest before
}
`
    },
    {
      name: 'Wavelengths 830 and 850 nm',
      desc: 'Both wavelengths sit above the isosbestic point, so the extinction matrix is nearly singular: noise is amplified tens of times and HbO and HbR bleed into each other. Compare with 760 and 850 nm on the Wavelengths tab.',
      src: `# A poor pair of wavelengths
recording { wavelengths 830 850 nm  rate 10 Hz }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'Sampling too slowly: the heartbeat aliases',
      desc: 'At 1 Hz the cardiac pulse (1.2 Hz) is above the Nyquist frequency and folds down to 0.2 Hz, right in the band a hemodynamic analysis keeps. The scalp coupling index also needs the heartbeat, so it cannot be computed. See the Spectra panel on the Recording tab.',
      src: `# Under-sampling
recording { wavelengths 760 850 nm  rate 1 Hz }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'Deep (sulcal) activation',
      desc: 'The same response 25 mm below the scalp, as if it sat in the bank of a sulcus. Sensitivity falls steeply with depth: the response nearly vanishes from the 3 cm channels. On the Head and activation tab, drag the depth back up.',
      src: `# A deep activation
recording { wavelengths 760 850 nm  rate 10 Hz }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1
  depth 25 mm
  radius 8 mm
  flow 50%
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    },
    {
      name: 'LED sources and an initial dip',
      desc: 'LEDs emit over about 35 nm, not 2, so the extinction they see is not the textbook value at their peak, and the conversion slightly mixes HbO and HbR. The activation also has an initial dip: oxygen use rises before blood flow catches up. Look closely at the first two seconds of HbR on the fNIRS vs fMRI tab.',
      src: `# LED sources; an activation with an initial dip
recording { wavelengths 735 850 nm  rate 10 Hz  source led  power 10 mW  detector apd }

probe over C3 { layout motor }

head adult { }

activation hand {
  under S3 D1  radius 8 mm
  flow 50%
  dip
  condition tap 1
}

timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}

${PHYS}

analysis {
  motion none
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
}
`
    }
  ];
})(typeof window !== 'undefined' ? window : globalThis);
