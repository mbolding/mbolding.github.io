/* ============================================================
   MRI Simulator: sequence presets
   A library of pulse sequences written in the simulator's own
   language (see dsl.js and the language reference). They are the
   starting point for every lesson, so they are commented the way a
   careful instructor would comment a handout: one short note per
   line that is not obvious.

   The ids are referenced by the lessons, the artifact cards and the
   app, so keep them stable. Every imaging preset uses the parameter
   names TR TE FOV N BW (plus flip TI ETL ESP NEX spokes where they
   apply) so that a lesson can set "TE" whichever sequence is loaded.
   The turbo spin echo family has no TE parameter: its effective TE
   follows from the echo spacing and the echo train length, and is
   shown as the derived value TEeff.

   Nothing here touches the DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const MRI = root.MRI;

    const list = [];
    function add(id, name, group, summary, source) {
        list.push({ id, name, group, summary, source: source.replace(/^\n/, '') });
    }

    /* ---------- Gradient echo ---------- */

    add('first', 'Your first sequence', 'imaging',
        'A minimal spoiled gradient echo with every line explained. Start here.', `
# Your first sequence: a spoiled gradient echo.
# Each repetition (TR) excites one slice, encodes one line of k-space
# and records it. After N repetitions k-space is full and the image
# can be reconstructed.
sequence "Your first sequence"

param TR   = 100 ms    range 10 ms .. 500 ms      "repetition time: one k-space line per TR"
param TE   = 5 ms      range 4 ms .. 30 ms        "echo time: excitation to echo"
param flip = 30 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 64        range 32 .. 128 step 32    "matrix size (pixels along each side)"
param BW   = 250 Hz/px range 100 Hz/px .. 1000 Hz/px "receiver bandwidth per pixel"

fov FOV                 # the image covers FOV in x and in y
matrix N                # N x N pixels: N samples per line and N lines
slice 5 mm              # slice thickness, set by the slice-select gradient
bandwidth BW            # how fast the ADC samples, expressed per image pixel
dummies 4               # 4 unrecorded TRs first, so the signal has settled

for line in 0 .. N-1 every TR               # one phase-encode line per repetition
    rf flip slice as exc                    # tip the spins in one slice; this moment is "exc"
    gz rephase, gx prephase, gy encode line # undo the slice gradient's twist; go to the start of this line
    gx readout, adc at exc + TE             # sweep across k-space while recording; the echo is at TE
    gy rewind line                          # undo the phase encoding
    spoil                                   # destroy what is left of the transverse magnetisation
end
`);

    add('gre_t1', 'Gradient echo, T1-weighted', 'imaging',
        'Spoiled gradient echo with short TR, short TE and a large flip angle: T1 contrast.', `
# Spoiled gradient echo, T1-weighted.
# Short TR keeps tissues with long T1 from recovering between pulses, a
# large flip angle uses up their magnetisation, and a short TE keeps T2*
# out of it. Fat and white matter (short T1) are bright, CSF dark.
sequence "Gradient echo, T1-weighted"

param TR   = 250 ms    range 20 ms .. 1000 ms     "repetition time"
param TE   = 2.5 ms    range 2.5 ms .. 20 ms      "echo time"
param flip = 70 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 128       range 32 .. 256 step 32    "matrix size"
param BW   = 400 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"
param NEX  = 1         range 1 .. 8               "number of averages"

fov FOV
matrix N
slice 5 mm
bandwidth BW            # a high bandwidth gives a short readout, which a short TE needs
averages NEX
dummies 4               # reach the steady state before recording

for line in 0 .. N-1 every TR
    rf flip slice dur 1 ms as exc           # a short pulse leaves room for a short TE
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + TE
    gy rewind line
    spoil                                   # spoiling removes the leftover signal: no T2 build-up
end
`);

    add('gre_t2s', 'Gradient echo, T2*-weighted', 'imaging',
        'Spoiled gradient echo with long TE and a small flip angle: T2* and susceptibility contrast.', `
# Spoiled gradient echo, T2*-weighted.
# There is no refocusing pulse, so field inhomogeneity keeps dephasing
# the spins all the way to the echo. A long TE turns that into contrast:
# regions near air (sinuses) and veins go dark. A small flip angle
# with a moderate TR keeps T1 weighting low.
sequence "Gradient echo, T2*-weighted"

param TR   = 600 ms    range 50 ms .. 2000 ms     "repetition time"
param TE   = 20 ms     range 5 ms .. 60 ms        "echo time"
param flip = 20 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 128       range 32 .. 256 step 32    "matrix size"
param BW   = 150 Hz/px range 50 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"
param NEX  = 1         range 1 .. 8               "number of averages"

fov FOV
matrix N
slice 5 mm
bandwidth BW
averages NEX
dummies 4

for line in 0 .. N-1 every TR
    rf flip slice as exc
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + TE             # the long wait before the echo is where T2* acts
    gy rewind line
    spoil
end
`);

    /* ---------- Spin echo ---------- */

    add('se', 'Spin echo, T2-weighted', 'imaging',
        'The classic spin echo: a 90 and a 180 per line. Long TR and long TE give T2 contrast.', `
# Spin echo, T2-weighted.
# The 90 degree pulse tips the magnetisation into the transverse plane.
# Spins then dephase, both from field inhomogeneity and from the gradients
# we apply. The 180 degree pulse at TE/2 inverts every phase, so the
# dephasing undoes itself and an echo forms at TE, free of T2* effects.
# With a long TR all tissues recover (little T1 weighting); with a long
# TE the slowly decaying tissues (CSF) stay bright: T2 weighting.
sequence "Spin echo"

param TR  = 3000 ms   range 300 ms .. 6000 ms      "repetition time"
param TE  = 90 ms     range 12 ms .. 200 ms        "echo time"
param FOV = 240 mm    range 120 mm .. 320 mm       "field of view"
param N   = 128       range 32 .. 256 step 32      "matrix size"
param BW  = 150 Hz/px range 50 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"
param NEX = 1         range 1 .. 8                 "number of averages"

fov FOV
matrix N
slice 5 mm
bandwidth BW
averages NEX
dummies 2               # two unrecorded TRs first, so T1 recovery reaches a steady state

for line in 0 .. N-1 every TR
    rf 90 slice as exc                          # excitation; TE is measured from its centre
    gz rephase, gx -prephase, gy -encode line   # the 180 will invert both in-plane areas, so write them with the opposite sign
    rf 180 slice phase 90 at exc + TE/2         # refocusing pulse half way to the echo
    gx readout, adc at exc + TE                 # echo centred at TE
    spoil                                       # destroy what is left before the next TR
end
`);

    add('se_t1', 'Spin echo, T1-weighted', 'imaging',
        'Spin echo with short TR and short TE: T1 contrast.', `
# Spin echo, T1-weighted.
# Same sequence as the T2-weighted spin echo, different timing. A short
# TR lets only the short-T1 tissues (fat, white matter) recover between
# excitations, and a short TE leaves little time for T2 decay, so the
# image shows T1 differences.
sequence "Spin echo, T1-weighted"

param TR  = 500 ms    range 200 ms .. 1500 ms      "repetition time"
param TE  = 12 ms     range 10 ms .. 40 ms         "echo time"
param FOV = 240 mm    range 120 mm .. 320 mm       "field of view"
param N   = 128       range 32 .. 256 step 32      "matrix size"
param BW  = 150 Hz/px range 50 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"
param NEX = 1         range 1 .. 8                 "number of averages"

fov FOV
matrix N
slice 5 mm
bandwidth BW
averages NEX
dummies 2

for line in 0 .. N-1 every TR
    rf 90 slice as exc
    gz rephase, gx -prephase, gy -encode line   # opposite signs: the 180 inverts them
    rf 180 slice phase 90 at exc + TE/2
    gx readout, adc at exc + TE
    spoil
end
`);

    add('stir', 'STIR (inversion recovery, fat-nulling)', 'imaging',
        'Inversion recovery spin echo with a short TI that nulls fat.', `
# STIR: short-tau inversion recovery.
# A 180 degree pulse first turns every tissue's magnetisation upside down.
# Each then recovers with its own T1, passing through zero at about
# T1 x ln 2. Exciting at that moment (TI after the inversion) gives that
# tissue no signal. Fat has the shortest T1, so a short TI nulls fat.
sequence "STIR"

param TR  = 3000 ms   range 1000 ms .. 6000 ms     "repetition time"
param TI  = 230 ms    range 50 ms .. 1000 ms       "inversion time: inversion to excitation"
param TE  = 30 ms     range 12 ms .. 120 ms        "echo time"
param FOV = 240 mm    range 120 mm .. 320 mm       "field of view"
param N   = 128       range 32 .. 256 step 32      "matrix size"
param BW  = 150 Hz/px range 50 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 2

for line in 0 .. N-1 every TR
    rf 180 hard as inv                          # inversion: nothing excited yet in this TR, so this is "invert"
    spoil                                       # clean up any transverse signal an imperfect inversion leaves
    rf 90 slice at inv + TI as exc              # excite when fat's magnetisation crosses zero
    gz rephase, gx -prephase, gy -encode line
    rf 180 slice phase 90 at exc + TE/2         # after an excitation, a 180 is a refocusing pulse
    gx readout, adc at exc + TE
    spoil
end
`);

    /* ---------- Turbo spin echo ---------- */

    add('tse', 'Turbo spin echo', 'imaging',
        'One excitation, a train of 180s, a different k-space line for each echo. Linear ordering.', `
# Turbo (fast) spin echo.
# After one excitation a train of ETL refocusing pulses makes ETL echoes,
# and each echo gets its own phase encoding, so ETL lines are recorded
# per TR and the scan is ETL times shorter. The echoes have different
# TEs; the contrast is set by the echo that lands on the centre of
# k-space. With this linear ordering line L = e*shots + shot, so the
# centre line (N/2) is recorded by echo ETL/2 and the effective TE is
# (ETL/2 + 1) x ESP.
sequence "Turbo spin echo"

param TR  = 3000 ms   range 500 ms .. 6000 ms      "repetition time"
param ETL = 16        range 4 .. 32 step 4         "echo train length (must divide N)"
param ESP = 10 ms     range 8 ms .. 20 ms          "echo spacing"
param FOV = 240 mm    range 120 mm .. 320 mm       "field of view"
param N   = 128       range 32 .. 256 step 32      "matrix size"
param BW  = 200 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 1

let shots = N / ETL                     # excitations needed to fill k-space
let TEeff = (ETL/2 + 1) * ESP           # echo time of the k-space centre

for shot in 0 .. shots-1 every TR
    rf 90 slice as exc
    gz rephase, gx -prephase            # the first 180 inverts the prephaser
    for e in 0 .. ETL-1
        rf 180 slice phase 90 at exc + ESP/2 + e*ESP   # refocusing pulses half way between echoes
        gy encode e*shots + shot                       # each echo gets its own line
        gx readout, adc at exc + ESP + e*ESP           # echo e at (e + 1) x ESP
        gy rewind e*shots + shot                       # unwind before the next 180, so every echo starts from ky = 0
    end
    spoil
end
`);

    add('flair', 'FLAIR (inversion recovery TSE, CSF-nulling)', 'imaging',
        'Long-TI inversion recovery that nulls CSF, read out with a turbo spin echo train.', `
# FLAIR: fluid-attenuated inversion recovery.
# An inversion pulse, then a long wait (TI) until the magnetisation of
# CSF, which has a very long T1, passes through zero, then a turbo spin
# echo readout. CSF is dark while the rest of the image stays T2-weighted,
# so lesions next to the ventricles stand out.
sequence "FLAIR"

param TR  = 9000 ms   range 4000 ms .. 15000 ms    "repetition time"
param TI  = 2400 ms   range 500 ms .. 4000 ms      "inversion time: inversion to excitation"
param ETL = 16        range 4 .. 32 step 4         "echo train length (must divide N)"
param ESP = 10 ms     range 8 ms .. 20 ms          "echo spacing"
param FOV = 240 mm    range 120 mm .. 320 mm       "field of view"
param N   = 128       range 32 .. 256 step 32      "matrix size"
param BW  = 200 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 1

let shots = N / ETL
let TEeff = (ETL/2 + 1) * ESP

for shot in 0 .. shots-1 every TR
    rf 180 adiabatic as inv             # adiabatic: a complete inversion even where B1 is off
    spoil
    rf 90 slice at inv + TI as exc      # excite as CSF's magnetisation crosses zero
    gz rephase, gx -prephase
    for e in 0 .. ETL-1
        rf 180 slice phase 90 at exc + ESP/2 + e*ESP
        gy encode e*shots + shot
        gx readout, adc at exc + ESP + e*ESP
        gy rewind e*shots + shot
    end
    spoil
end
`);

    /* ---------- Echo planar imaging ---------- */

    add('epi', 'Gradient-echo EPI', 'imaging',
        'Single-shot echo planar imaging: the whole of k-space after one excitation.', `
# Single-shot gradient-echo EPI, the workhorse of fMRI.
# After one excitation the readout gradient swings back and forth, and
# a small blip on gy between echoes steps to the next line, so k-space
# is covered in a zigzag in a few tens of milliseconds. The echo that
# crosses the centre of k-space defines TE. Because each line takes ESP,
# the phase-encode direction has a tiny bandwidth (1/(N x ESP) per pixel),
# which is why EPI is so sensitive to off-resonance.
sequence "Gradient-echo EPI"

param TR  = 3000 ms    range 500 ms .. 6000 ms       "repetition time (one whole image per TR)"
param TE  = 30 ms      range 20 ms .. 80 ms          "echo time of the k-space centre"
param ESP = 0.8 ms     range 0.5 ms .. 2 ms          "echo spacing: time from one line to the next"
param FOV = 220 mm     range 160 mm .. 300 mm        "field of view"
param N   = 64         range 32 .. 128 step 32       "matrix size"
param BW  = 2000 Hz/px range 1000 Hz/px .. 4000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
oversample 1            # no readout oversampling: it would only lengthen every echo
dummies 2               # in fMRI the first volumes are discarded while the signal settles

repeat 1 every TR
    rf 90 slice as exc
    gz rephase, gx prephase, gy encode 0    # go to the start of the bottom line of k-space
    for line in 0 .. N-1
        gx readout * (-1)^line, adc at exc + TE + (line - N/2)*ESP   # odd lines run backwards
        gy blip                                                    # step up one line
    end
end
`);

    add('se_epi', 'Spin-echo EPI', 'imaging',
        'Single-shot EPI around a spin echo: T2 rather than T2* weighting, less signal loss near air.', `
# Single-shot spin-echo EPI (used for diffusion imaging).
# A 180 degree pulse at TE/2 refocuses static field inhomogeneity at the
# centre of k-space, so the image is T2-weighted and loses less signal
# near the sinuses. The geometric distortion of EPI remains, because
# off-resonance still accumulates from line to line.
sequence "Spin-echo EPI"

param TR  = 3000 ms    range 500 ms .. 6000 ms       "repetition time (one whole image per TR)"
param TE  = 60 ms      range 40 ms .. 120 ms         "echo time of the k-space centre"
param ESP = 0.8 ms     range 0.5 ms .. 2 ms          "echo spacing"
param FOV = 220 mm     range 160 mm .. 300 mm        "field of view"
param N   = 64         range 32 .. 128 step 32       "matrix size"
param BW  = 2000 Hz/px range 1000 Hz/px .. 4000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
oversample 1
dummies 2

repeat 1 every TR
    rf 90 slice as exc
    gz rephase
    rf 180 slice phase 90 at exc + TE/2     # refocusing pulse half way to the k-space centre
    gx prephase, gy encode 0                # after the 180, so no sign change is needed
    for line in 0 .. N-1
        gx readout * (-1)^line, adc at exc + TE + (line - N/2)*ESP
        gy blip
    end
end
`);

    /* ---------- Other k-space trajectories ---------- */

    add('radial', 'Radial gradient echo', 'imaging',
        'Spokes through the centre of k-space at evenly spaced angles instead of parallel lines.', `
# Radial spoiled gradient echo.
# Instead of parallel lines, each repetition records a spoke through the
# centre of k-space, rotated by pi/spokes from the last. Rotating the
# readout is done by sharing it between gx (cos) and gy (sin). Every spoke
# samples the centre, so motion blurs rather than ghosts; too few spokes
# leave streaks. About pi/2 x N spokes satisfy Nyquist at the edge of
# k-space.
sequence "Radial gradient echo"

param TR     = 100 ms    range 10 ms .. 500 ms      "repetition time"
param TE     = 5 ms      range 4 ms .. 30 ms        "echo time"
param flip   = 30 deg    range 5 deg .. 90 deg      "flip angle"
param FOV    = 240 mm    range 120 mm .. 320 mm     "field of view"
param N      = 128       range 32 .. 256 step 32    "matrix size (samples across a spoke)"
param BW     = 250 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"
param spokes = 128       range 16 .. 400 step 16    "number of spokes"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 4

for s in 0 .. spokes-1 every TR
    let angle = pi*s/spokes                 # spokes fan out over half a turn; each covers a full diameter
    rf flip slice as exc
    gz rephase, gx prephase * cos(angle), gy prephase * sin(angle)
    gx readout * cos(angle), gy readout * sin(angle), adc at exc + TE
    spoil
end
`);

    add('gre_pf', 'Gradient echo, partial Fourier (5/8)', 'imaging',
        'Records only 5/8 of the phase-encode lines and lets the reconstruction fill in the rest.', `
# Gradient echo with 5/8 partial Fourier.
# k-space of a real object is (nearly) conjugate symmetric, so one half
# almost determines the other. Here lines 3N/8 .. N-1 are recorded: all
# of the top half plus a band below the centre, which the reconstruction
# uses to correct the phase. The scan is 5/8 as long; the price is a
# little SNR and some blurring if the phase is not smooth.
sequence "Gradient echo, partial Fourier"

param TR   = 200 ms    range 20 ms .. 1000 ms     "repetition time"
param TE   = 4.6 ms    range 4 ms .. 30 ms        "echo time (4.6 ms: fat and water in phase at 3 T)"
param flip = 30 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 128       range 32 .. 256 step 32    "matrix size"
param BW   = 250 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 4

for line in 3*N/8 .. N-1 every TR           # skip the first 3/8 of the lines
    rf flip slice as exc
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + TE
    gy rewind line
    spoil
end
`);

    add('gre_r2', 'Gradient echo, every other line (R = 2)', 'imaging',
        'Skips every second phase-encode line: the image folds over unless SENSE unfolds it with the coil maps.', `
# Gradient echo, undersampled by 2 for parallel imaging.
# Recording every second line halves the scan time but doubles the
# k-space step, which halves the FOV in the phase direction: the image
# folds over on itself. With several receive coils, each seeing the
# object differently, SENSE can unfold it (at some cost in noise, the
# g-factor).
sequence "Gradient echo, R = 2"

param TR   = 200 ms    range 20 ms .. 1000 ms     "repetition time"
param TE   = 4.6 ms    range 4 ms .. 30 ms        "echo time"
param flip = 30 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 128       range 32 .. 256 step 32    "matrix size"
param BW   = 250 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 4

for line in 0 .. N-1 step 2 every TR        # lines 0, 2, 4, ...: half of k-space
    rf flip slice as exc
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + TE
    gy rewind line
    spoil
end
`);

    add('gre_fatsat', 'Gradient echo with fat saturation', 'imaging',
        'A spectrally selective pulse saturates fat before every excitation.', `
# Gradient echo with spectral fat saturation.
# Fat resonates about 434 Hz below water at 3 T. A long, narrow-band
# pulse centred on fat tips only fat into the transverse plane, and the
# spoiler destroys it, so a moment later fat has almost no longitudinal
# magnetisation left to give signal. It works only where the field is
# uniform: where B0 is off by a few hundred Hz the pulse misses fat,
# or hits water instead.
sequence "Gradient echo, fat saturation"

param TR   = 300 ms    range 50 ms .. 1000 ms     "repetition time"
param TE   = 4.6 ms    range 4 ms .. 30 ms        "echo time (4.6 ms: fat and water in phase at 3 T)"
param flip = 30 deg    range 5 deg .. 90 deg      "flip angle"
param FOV  = 240 mm    range 120 mm .. 320 mm     "field of view"
param N    = 128       range 32 .. 256 step 32    "matrix size"
param BW   = 250 Hz/px range 100 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 4

for line in 0 .. N-1 every TR
    rf 90 fat dur 8 ms                      # spectrally selective: about 200 Hz wide, centred on fat
    spoil                                   # dephase the tipped fat
    rf flip slice as exc                    # now excite the slice: water only
    gz rephase, gx prephase, gy encode line
    gx readout, adc at exc + TE
    gy rewind line
    spoil
end
`);

    /* ---------- Spectroscopy ---------- */

    add('fid', 'Pulse-acquire FID', 'spectroscopy',
        'A short non-selective pulse, then record the free induction decay. No gradients at all.', `
# Pulse-acquire: the simplest MR experiment.
# A short hard pulse tips all the spins in the coil, at every frequency,
# and the ADC records the free induction decay. Without gradients there
# is no spatial encoding: the Fourier transform of the FID is a spectrum,
# with one peak per chemical environment (water at 4.7 ppm, fat at
# 1.3 ppm, NAA at 2.0 ppm, ...).
#   spectral width = 1 / dwell       resolution = 1 / (NP x dwell)
sequence "Pulse-acquire FID"

param TR    = 3000 ms   range 500 ms .. 10000 ms     "repetition time"
param flip  = 90 deg    range 5 deg .. 90 deg        "flip angle"
param delay = 0.25 ms   range 0.1 ms .. 5 ms         "delay from the pulse centre to the first sample"
param SW    = 4000 Hz   range 1000 Hz .. 10000 Hz    "spectral width (1 / dwell)"
param NP    = 2048      range 256 .. 8192 step 256   "number of points"
param NA    = 16        range 1 .. 128               "number of transients averaged"

dummies 2               # let the magnetisation settle before averaging

repeat NA every TR
    rf flip hard dur 0.1 ms as exc          # short pulse: wide bandwidth, excites every resonance
    adc NP dwell 1/SW at exc + delay        # record the FID; first sample at delay after the pulse centre
end
`);

    add('fid_ws', 'FID with CHESS water suppression', 'spectroscopy',
        'Two water-selective saturation pulses before the excitation, so the small metabolite peaks become visible.', `
# Pulse-acquire with CHESS water suppression.
# Water is about 10 000 times more concentrated than the metabolites, so
# its peak swamps them. CHESS (chemical shift selective) saturation tips
# only water with a narrow-band pulse and spoils it; doing it twice, the
# second pulse a little stronger, also catches the water that regrew or
# saw a weaker B1 the first time. Then the hard pulse excites everything
# that is left: the metabolites.
sequence "FID with water suppression"

param TR    = 3000 ms   range 500 ms .. 10000 ms     "repetition time"
param flip  = 90 deg    range 5 deg .. 90 deg        "flip angle"
param delay = 0.25 ms   range 0.1 ms .. 5 ms         "delay from the pulse centre to the first sample"
param SW    = 4000 Hz   range 1000 Hz .. 10000 Hz    "spectral width (1 / dwell)"
param NP    = 2048      range 256 .. 8192 step 256   "number of points"
param NA    = 16        range 1 .. 128               "number of transients averaged"

dummies 2

repeat NA every TR
    rf 90 water dur 20 ms                   # CHESS 1: about 80 Hz wide, centred on water
    spoil
    rf 100 water dur 20 ms                  # CHESS 2: slightly larger flip
    spoil
    rf flip hard dur 0.1 ms as exc          # excite what is left
    adc NP dwell 1/SW at exc + delay
end
`);

    MRI.presets = list;
    MRI.presets.defaultId = 'se';
    MRI.presets.get = function (id) {
        for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    };

})(typeof window !== 'undefined' ? window : globalThis);
