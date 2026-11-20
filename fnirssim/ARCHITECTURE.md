# fNIRS Simulator: architecture and module contracts

A teaching fNIRS system for NBL 425/625 that runs in the browser, the sibling
of the MRI (`../nbl425/demos/mri_simulator/`), PET
(`../nbl425/demos/pet_simulator/`), EEG (`../eegsim/`) and MEG (`../megsim/`)
simulators. Students describe a recording in a small language (optodes,
wavelengths, sampling rate, head, cortical activation, stimulus timeline,
physiology, artifacts, analysis), shine near-infrared light through a
five-layer head, watch the banana form, pick wavelengths, convert intensity
to haemoglobin with the modified Beer-Lambert law, switch each confound on
and off, and run a standard pipeline (quality, motion correction, band-pass,
short-channel regression, block averaging, GLM) against a ground truth the
simulator always knows. Two further tabs compare fNIRS with BOLD fMRI and
show how a high-density array becomes tomography.

This file is the contract between the modules. If code and this file
disagree, fix one of them so they agree again.

---

## 1. Pedagogical principles

1. **Organise around concepts, not photon transport.** Each tab is one idea:
   the instrument, the experiment, light in tissue, wavelengths, the
   Beer-Lambert conversion, what a probe can see, confounds, the raw
   recording, processing, averaging and the GLM, fNIRS against fMRI, and
   tomography. Each opens with a collapsible concept card.
2. **Effects come from their mechanism.** Sensitivity is computed from a
   diffusion solution in the layered head, not drawn. The partial-volume
   shrinkage, the scalp's dominance at short separations, the loss of a
   deep or thick-skulled response, the noise gain of a poor wavelength pair
   and the bias from a wrong DPF all follow from the same model, so they
   respond correctly when a student changes something.
3. **Every confound is switchable without changing anything else.** Each
   contribution is stored separately as a change in log intensity, and the
   recording is reassembled from whichever are switched on. Switching one off
   removes exactly that one.
4. **Ground truth is always available.** `pipeline.truth` runs the cortex
   alone, noise-free, through the same filters and DPF as the analysis, so
   any average or beta can be compared with what the brain really did.
5. **Lessons are tested.** `tests/test_lessons.js` checks every claim the
   examples and the Guide make (a false scalp activation disappears with
   short-channel regression, TDDR shrinks a clean response a little, 830/850
   nm amplifies noise, HD-DOT localizes, and so on), so a change to the model
   cannot quietly break a lesson.

---

## 2. Files and load order

```
fnirssim/
  index.html           tabs, panels, concept cards, the language reference
  style.css            tokens (light, dark, data-theme), layout, components
  ARCHITECTURE.md      this file
  js/
    core.js            NIRS namespace, RNG, FFT, linear algebra, stats, formatting
    optics.js          extinction spectra, tissues, heads, hair, diffusion solver,
                       sensitivities, homogeneous CW/FD/TD formulas, MBLL matrices
    hemo.js            balloon model, HRFs, physiological generators, SYSTEMIC weights
    probe.js           10-20 positions, layouts, buildProbe
    dsl.js             lexer, parser, compiler, serializer, highlighter
    examples.js        13 example programs, each a lesson
    sim.js             simulate (all components) and assemble (one recording)
    dsp.js             filters, spectra, quality, motion correction, MBLL, regression,
                       epochs, design matrices, AR-prewhitened GLM
    pipeline.js        the staged analysis pipeline, GLM wrapper, ground truth
    mc.js              Monte Carlo photon walker for the Light tab
    dot.js             HD-DOT sensitivity matrix and Tikhonov reconstruction
    draw.js            canvas helpers: Plot, probe maps, cross-sections, colour maps
    app.js             shared state, UI helpers, build and run, tabs, Experiment tab
    tab_*.js           one file per tab, each registering NIRS.tabs[name]
  tests/
    harness.js         loads modules into Node's global context
    run_all.js         runs every test_*.js in its own process
    test_*.js          core, optics, hemo, dsl, sim, dsp, lessons
```

Scripts load in the order above (core to app, then the tabs), and the page
ends with `NIRS.app.start()`. Everything hangs off the global `NIRS`; there
are no build steps, modules or dependencies.

### Coding conventions

- Units: centimetres for geometry, cm⁻¹ for μa and μs′, µM for
  concentrations, seconds, Hz, watts for optical power (formatted with
  `NIRS.fmtPower`).
- Time series are `Float64Array`. Intensities are indexed `I[channel][λ][sample]`.
- Randomness only through `NIRS.rng(seed)` and named sub-streams, so the same
  program gives the same recording sample for sample.
- Colours from CSS tokens through `NIRS.draw.theme()`: HbO `--hbo`, HbR
  `--hbr`, water `--water`, the two wavelengths `--l1`/`--l2` (orange and
  violet, never shown beside HbO/HbR). Light and dark palettes were checked
  with the dataviz validator.

---

## 3. Optics (optics.js)

**Spectra.** Prahl's HbO and HbR molar extinction (600 to 1000 nm,
log-interpolated), Hale and Querry water absorption, a melanin power law for
hair. `NIRS.ISOSBESTIC` is found numerically (about 797 nm).
`effectiveExt(nm, fwhm)` averages the spectra over a source's bandwidth (LED
35 nm, laser 2 nm), which the analysis does not know about.

**Tissues and heads.** `TISSUES` gives each layer (scalp, skull, CSF, gray,
white) its HbO, HbR, water and background absorption and a reduced
scattering power law `μs′(λ) = μs′(800)·(λ/800)^-b`. `HEADS` sets layer
thicknesses (adult, thick skull, infant) and age; `HAIR` sets coupling,
spread and melanin. `headLayers(model, {thick})` returns layers with depths;
`opticalLayers(layers, nm)` adds μa and μs′.

**Diffusion solver.** `fluence(optLayers)` solves the diffusion equation for
a point source in a layered half-space on an axisymmetric r-z grid (`GRID`:
0.5 mm cells, 132 × 84). Finite volumes with harmonic-mean D on faces, the
partial-current boundary condition at the surface (Groenhuis R_eff for
n = 1.4), zero fluence on the far boundaries, banded Cholesky. Solutions are
cached by layer properties.

**Sensitivity.** By reciprocity the sensitivity of a source-detector pair to
absorption at x is `G(s,x)·G(x,d)/G(s,d)`. `pathlengths(sol, ρ)` integrates
it over each layer, giving partial pathlengths whose sum over the DPF is the
mean pathlength. `regionPath` gives the partial pathlength inside a
soft-edged spherical region; `sensitivityPlane` gives the banana image.

**Homogeneous formulas** for contrast and checks: `homogCW` (Farrell),
`homogDPF`, `homogFD` (complex wavenumber, amplitude and phase), `homogTD`
(Patterson DTOF).

**Beer-Lambert.** `mbllMatrix(λs, ρ, dpf)` builds E with rows
`[εHbO·ρ·DPF, εHbR·ρ·DPF]` (ln-based OD per µM); `mbllInverse` is the
least-squares inverse, `null` when singular. `extCond` and
`noiseGain(λs, ρ, dpf)` report how a wavelength pair amplifies noise.
`dpfAge(nm, age)` is Scholkmann and Wolf's formula.

---

## 4. Haemodynamics and physiology (hemo.js)

**Balloon model.** `balloon(u, dt, flow, opts)` drives a Friston-style
flow-inducing signal with a neurovascular delay, venous balloon (Grubb α),
CMRO2 coupled to flow by the ratio n, and an optional initial dip. It returns
flow, volume, deoxyhaemoglobin, oxygen use, ΔHbO, ΔHbR and ΔHbT (µM in the
active tissue) and BOLD (Buxton coefficients). `BALLOON` holds the defaults.

**HRFs.** `hrfCanonical` (double gamma), `hrfGamma`, and
`convolveHRF(x, fs, hrf, deriv)` for the GLM.

**Physiology.** `physio.cardiac` (pulse waveform with heart-rate variability
and respiratory sinus arrhythmia), `respiration`, `mayer` (band-limited near
0.1 Hz), `drift` (1/f to 0.5 Hz), `taskBP` (task-locked blood pressure through
a unit-area gamma kernel). `SYSTEMIC[id]` gives each component its HbR/HbO
ratio and its weight in each layer: the scalp carries most of it, the brain a
little, and task-evoked blood pressure barely reaches the brain at all.

---

## 5. Probe (probe.js)

`TEN20` positions place a probe patch on a 9 cm sphere (`patchFrame`,
`patchToHead`, `topView`). `LAYOUTS.motor` is 4 sources and 4 detectors on a
3 cm checkerboard with an 8 mm short channel beside each source;
`LAYOUTS.forehead` is 3 sources and 4 detectors; `LAYOUTS.hd(n, pitch)` is a
square high-density grid. `buildProbe(probe)` returns `{sources, detectors,
channels}`; each channel has its optode indices and names, ρ, `short`, a
midpoint, a label (`S3-D1`, `S1-SS1`) and its `nearestShort`.

---

## 6. The recording language (dsl.js)

### 6.1 What it looks like

```
recording {
  wavelengths 760 850 nm
  rate 10 Hz
  multiplex time
  source laser  power 10 mW
  detector apd
}
probe over C3 { layout motor }
head adult { hair dark }
activation hand { under S3 D1  radius 8 mm  flow 50%  condition tap 1 }
timeline {
  rest 20 s
  blocks 10 on 15 s off 20 s jitter 5 s { condition tap }
}
physiology { cardiac 72 bpm 1.0 uM  mayer 0.1 Hz 0.6 uM  taskbp 0.6 uM }
artifacts { spikes 2 /min 30%  poor D2 2% }
analysis {
  quality sci 0.75 cv 15%
  motion tddr
  bandpass 0.01 0.2 Hz
  dpf age
  short nearest glm
  epoch -5 25 s  baseline -5 0 s
  hrf canonical
}
```

### 6.2 Rules

- Blocks: `recording probe head activation pair timeline physiology
  artifacts analysis` (`NIRS.DSL_SCHEMA` lists the statements each accepts).
- **Units decide meaning**, so values can come in any order:
  `cardiac 70 bpm 1 uM` and `cardiac 1 uM 70 bpm` are the same. Units include
  nm, mm, cm, s, ms, Hz, bpm, /min, uM, mW, nW and %.
- A run of unitless numbers takes the unit of the number that ends it
  (`bandpass 0.01 0.2 Hz`, `epoch -5 25 s`).
- `#` starts a comment. Errors are `DSLError` with a line and column and say
  what was expected.
- `compile` checks against the probe (an unknown optode, a region under a
  missing channel), limits the recording to 4 million samples, and warns
  about a single wavelength or a sampling rate that aliases the heartbeat.

### 6.3 API

`NIRS.dsl = { lex, parse, compile, build, serialize, highlight, DSLError,
UNITS }`. `build(src)` returns a config with `recording`, `probe`,
`geometry` (from `buildProbe`), `head`, `activations`, `pairs`, `timeline`,
`physiology`, `artifacts`, `analysis` and `warnings`.
`serialize(cfg, title)` writes a config back as a program (used when the Head
tab or a "use this scheme" button changes the recording); a
serialize-and-reparse round trip is tested for every example.

### 6.4 Examples (examples.js)

Thirteen programs, each a lesson: finger tapping, a false scalp activation,
event-related left and right hands, an infant, a thick skull, dark hair,
motion artifacts, a loose optode with room light, a resting-state pair,
830/850 nm, sampling at 1 Hz, a deep activation, and LEDs with an initial
dip.

---

## 7. Simulation (sim.js)

`simulate(cfg)` does all the expensive work once:

1. Expands the timeline into blocks and events.
2. Per wavelength, solves the fluence and computes every channel's
   reflectance R, mean pathlength L, layer pathlengths, region pathlengths
   and DPF, and the detected power I0 from source power, detector area, hair
   coupling and the optode coupling.
3. Runs the balloon model for each region (activation or connectivity pair).
4. Generates each physiological series and a spatial scalp gain field shared
   by all components, so channels see correlated but not identical
   physiology, and short channels can predict their long neighbours.
5. Stores each component as a time series times a per-channel,
   per-wavelength coefficient of −Δln I, so the contributions add in log
   intensity.
6. Draws motion events (spikes and baseline shifts as coupling changes per
   optode), the poor optode, and ambient light (steady plus flicker).

It returns the dataset `ds` with `fs, n, t, lambdas, geo, chans[].per[λ] =
{R, L, Lk, dpf, La, I0}, layers, regions, regionHb, groups, events, blocks,
conditions` and the artifact series.

`assemble(ds, {enabled, noise})` builds one recording `{I}` from the enabled
groups: it sums the −Δln I terms, applies coupling, motion and the poor
optode, adds ambient light after the demodulator's rejection
(`AMBIENT_REJECTION`: lock-in, dark slot, none), then detector noise (floor,
shot noise including ambient photons, source drift, the time-multiplexing
duty-cycle penalty) and saturation (`DETECTORS`: photodiode, APD, SiPM).
Assembly is cheap, so the Confounds tab reassembles on every switch.

---

## 8. Analysis (dsp.js, pipeline.js)

`pipeline.run(ds, rec, P, prev, from)` runs the stages below and can restart
from any of them, reusing the earlier results in `prev`:

| Stage | What it does |
|---|---|
| quality | mean light, CV, saturation, SCI (Pollonini: cardiac-band correlation of the two wavelengths) and windowed SCI; rejects channels that fail |
| od | optical density from the mean intensity |
| motion | none, TDDR (Fishburn, as published) or spline correction of detected segments |
| filter | zero-phase Butterworth band-pass (high-pass and low-pass orders 3 and 5) |
| conc | modified Beer-Lambert with a fixed, age-based or model DPF |
| short | short-channel regression from the nearest or mean short channel, weight estimated before, or together with an FIR model of the task |
| stats | epochs, baseline correction and averages per condition |

`pipeline.glm(ds, res, P)` fits each channel's motion-corrected but
unfiltered concentrations with task regressors (canonical or gamma HRF,
optional derivative), DCT drift terms and a constant, after subtracting the
short channel with the weight from the processing stage. With `noise ar` it
prewhitens with an AR model of up to 4 s of lags (Yule-Walker, two
iterations), which keeps the t values honest; `noise ols` shows how serial
correlation inflates them.

`pipeline.truth(ds, P)` is the cortex alone, noise-free, through the same
filters and DPF, for comparison.

---

## 9. Monte Carlo (mc.js) and tomography (dot.js)

`new MC(layers, {rho, ...})` walks photons with isotropic scattering at μs′,
absorption weighting and Fresnel reflection at the surface. It records
detected paths (in an annulus at the detector and a short-channel ring), a
time-of-flight histogram and the density of detected paths, which forms the
banana. It is for pictures and as a check: the tests compare its layer
pathlengths with the diffusion solver at 1.5 cm.

`dotModel(head, nm, array)` builds the sensitivity matrix of a high-density
(`hd`), high-density nearest-neighbour (`hdshort`) or sparse array over a
voxel grid. `dotPrepare(M, γ)` caches the depth-compensated system;
`dotSolve`/`dotReconstruct` apply Tikhonov minimum-norm regularization with
λ relative to the largest eigenvalue; `dotPeak` finds the image peak.

---

## 10. User interface

`app.js` holds the shared state `NIRS.S` (`src, cfg, ds, enabled, rec, P,
res, glm, truth, selCh, tab`) and the UI helpers (`range`, `seg`, `legend`,
`readouts`, `chSelect`, `busy`). `build(src)` compiles, simulates, assembles
and runs the pipeline; `run(stage)` reruns from a stage when a setting
changes. The selected channel is shared by every tab.

Each tab registers `NIRS.tabs[name] = { init, render, onBuild, show, hide }`
and renders lazily when shown. The theme and current tab are kept in
`localStorage` (`fnirssim-theme`, `fnirssim-tab`), both optional.

| Tab | Content |
|---|---|
| System | clickable schematic; sources, cap and hair, tissue, detectors, multiplexing (time, frequency, none, with room light), CW against FD and TD |
| Experiment | the program editor with highlighting, examples, errors, a summary |
| Light in tissue | Monte Carlo photons, the banana, the separation trade-off, layer shares, depth profile, time of flight |
| Wavelengths | absorption and extinction spectra, the 2×2 matrix and its noise gain, all pairs, crosstalk |
| Beer-Lambert | intensity to OD to concentration at a cursor, DPF choices, partial volume |
| Head & activation | draggable region, live channel sensitivities, cross-section, apply to the recording |
| Confounds | switch cards, each alone and all together, where and at what frequency |
| Recording | raw intensity, unprocessed Hb, channel maps, spectrum, all channels |
| Processing | quality table and SCI, motion correction, band-pass, short-channel regression |
| Averaging & GLM | the average emerging trial by trial against the truth, GLM fit, design matrix and t map, connectivity |
| fNIRS vs fMRI | one balloon model, sampled by fNIRS and by BOLD, and where each one looks |
| Tomography | HD array, truth against image from above and in depth |
| Guide | 14 lessons, each loading an example and opening a tab |

---

## 11. Testing

```
node tests/run_all.js
```

Runs every `tests/test_*.js` in its own Node process (about 10 s). The tests
cover the numerics (FFT, linear algebra, the t distribution), the optics
(analytic against the solver, Monte Carlo against diffusion, DPF and
pathlength sanity), the balloon model, the language (every example compiles
and round-trips; errors point at the right line), the simulation
(determinism, exact removal of a component, ambient rejection, coupling),
the DSP (filters, motion correction, the GLM's false-positive rate with and
without prewhitening) and the lessons the page teaches.
