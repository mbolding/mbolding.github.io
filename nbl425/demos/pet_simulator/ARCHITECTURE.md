# PET Simulator: architecture and module contracts

A teaching PET scanner for NBL 425/625 that runs in the browser, the sibling
of the MRI simulator (`../mri_simulator/`). Students write a scan protocol in
a small language (tracer and isotope, injected dose, uptake delay, framing,
energy and coincidence windows, time of flight), image a choice of phantoms on
one schematic ring scanner, watch annihilations turn into lines of response,
look at the sinogram, reconstruct it several ways, switch each source of image
degradation and each correction on and off, and analyse dynamic data with
compartment models, SUV and SUVR.

This file is the contract between the modules. If code and this file
disagree, fix one of them so they agree again.

---

## 1. Pedagogical principles

The simulator exists to teach concepts, not to be a Monte Carlo physics
engine. Every design decision follows from that.

1. **Organise around fundamental concepts.** Each tab is one idea: the
   scanner and coincidence detection, isotopes and tracers, the protocol, the
   object, the sinogram, reconstruction, degradations and corrections, and
   dynamic PET with quantification. Each tab opens with a short concept card:
   the idea in two or three sentences, the one equation that matters, and
   "try this" experiments.
2. **Effects emerge from their mechanism.** Attenuation comes from line
   integrals of a real mu map, scatter from the photons that attenuation
   removed, randoms from singles rates and the timing window, noise from
   Poisson statistics of the actual expected counts, positron range from the
   isotope's range distribution, partial volume from the finite resolution,
   tracer distributions from compartment models driven by an input function.
   Then the effects respond correctly when students change dose, uptake,
   windows, isotope or object, which is the whole point.
3. **Every degradation has a physics switch and every correction has its
   own switch.** They are independent on purpose: a correction applied when
   the effect is absent produces the opposite artifact, and that is worth
   seeing. Corrections are computed the way a scanner computes them (from
   delayed coincidences, a mu map, a scatter model scaled to the sinogram
   tails), never by peeking at the simulator's ground truth, except where
   this file says so and the UI says so too.
4. **Honest simplifications, stated plainly.** One 2D slice, one ring,
   single-scatter physics in a smooth model, no dead time, plasma equal to
   whole blood, no metabolites. Say so in the UI where a careful student
   would otherwise be misled.
5. **Don't overwhelm.** Tabs, collapsible `<details>` for advanced controls,
   defaults that already make a good clinical-looking image, and no control
   without a reason to touch it.
6. **Units are part of the lesson.** The protocol language makes students
   write units (MBq, min, keV, ns), and the UI always shows them.

---

## 2. Files and load order

```
nbl425/demos/pet_simulator/
  index.html          page shell: header, scan bar, tab bar, tab panels, script tags
  style.css           design system shared by every tab (from the MRI simulator, event colours added)
  ARCHITECTURE.md     this file
  js/core.js          namespace, constants, FFT, RNG + Poisson, image helpers, bus, canvas helpers   (written)
  js/isotopes.js      isotopes (half-life, positron range) and the tracer catalogue                  (written)
  js/scanner.js       ring geometry, sinogram, projector, detector blur, normalisation,
                      attenuation factors, energy and timing window physics                         (written)
  js/kinetics.js      input functions, compartment models, regional time-activity curves,
                      Patlak, Logan, SUV, SUVR
  js/phantoms.js      phantom builders (labels, regions, mu map)
  js/dsl.js           protocol language: lexer, parser, compiler
  js/presets.js       library of protocols written in the language
  js/engine.js        acquisition simulator: expected trues, scatter, randoms; motion; noise
  js/recon.js         corrections, backprojection, FBP, MLEM/OSEM, TOF, resolution modelling
  js/analysis.js      region masks, ROI statistics, truth images, NEMA metrics, PVC (GTM), TACs
  js/events.js        toy event-by-event Monte Carlo that feeds the scanner animation
  js/ui/widgets.js    shared UI components (from the MRI simulator)                                 (written)
  js/ui/*.js          one file per tab (lessons, scanner, tracer, protocol, phantom,
                      sinogram, recon, corrections, kinetics)
  js/app.js           shell: state, actions, scan/playback loop, tab bar; boots the page
  tests/harness.js    loads classic scripts into Node for testing                                   (written)
  tests/test_*.js     one per module; `node tests/run_all.js` runs them all
```

`index.html` loads, in this order: `core, isotopes, scanner, kinetics,
phantoms, dsl, presets, engine, recon, analysis, events, ui/widgets,
ui/lessons, ui/scanner, ui/tracer, ui/protocol, ui/phantom, ui/sinogram,
ui/recon, ui/corrections, ui/kinetics, app`. All are classic `<script src>`
tags at the end of `<body>`, so the page works from `file://`. No external
libraries and no CDN. No web workers (they do not load from `file://`); long
computations are async and yield with `PET.util.yieldFrame()`.

### Coding conventions

- Each file is one IIFE: `(function (root) { 'use strict'; const PET = root.PET; ... })(typeof window !== 'undefined' ? window : globalThis);`
  Modern JS (const/let, arrow functions, classes, template strings) is fine.
- Non-UI modules (everything outside `js/ui/` and `app.js`) **must not touch
  the DOM at load or in their APIs**, so they run under `tests/harness.js` in
  Node.
- **Internal units:** time in seconds, length in millimetres, activity in Bq,
  concentration in Bq/mL, energy in keV, linear attenuation in 1/mm, mass in
  kg. Never store minutes, ns or MBq. The single exception is kinetic rate
  constants, stored per minute as in the literature (K1 mL/min/mL, k2..k4
  1/min); kinetics.js converts internally and its APIs still take time in s.
- Images are `Float32Array`, row-major, n × n, `index = iy * n + ix`. Pixel
  (ix, iy) sits at `x = (ix - floor(n/2)) * dx`, `y = (iy - floor(n/2)) * dx`.
- Match the comment density of `core.js` and `scanner.js`: explain *why*,
  especially the physics, in plain sentences. No banner art, no emoji.
- Use commas or parentheses rather than em dashes in any user-visible text.
- Every random process takes a seed (`PET.util.rng(seed)`) so the same
  settings reproduce the same image.

---

## 3. Coordinates, the scanner and the sinogram (scanner.js, written)

**Coordinates.** mm, x to the right, y DOWN the screen, origin at the ring
centre. Brain images use radiological convention: anterior at the top
(negative y), the patient's right on the image left (negative x).

**The scanner** (`PET.scanner.geom`, read it rather than hard-coding):
one ring of radius 250 mm, 384 LYSO crystals 4 × 4 × 20 mm in 48 blocks of 8
read out by SiPMs, energy resolution 11 % FWHM at 511 keV, default coincidence
timing resolution (CTR) 400 ps FWHM. We image one 4 mm slice. Image field of
view 320 mm square (the projector sees the inscribed circle).

**LORs and sinogram.** An LOR is `{p : p·n = r}`, `n = (cos θ, sin θ)`,
`θ ∈ [0, π)`; position along it is `s` along `d = (−sin θ, cos θ)`, so
`p = r n + s d`. Sinogram: `nA = 192` angles `θ_a = a π / 192`, `nR = 160`
radial bins of 2 mm, `r_i = (i − 80)·2 mm`. Row-major with one row per angle:
`index = a*nR + i`. TOF sinograms add `nT = 17` bins of 20 mm along s,
`s_k = (k − 8)·20 mm`, TOF bin fastest: `index = (a*nR + i)*nT + k`. A point
(x, y) traces `r(θ) = x cos θ + y sin θ`.

**API** (`PET.scanner`):

```js
geom                                   // constants above, plus angle(a), radius(i), tofCentre(k)
crystalAngle(c), crystalAt(phi), crystalPos(c) -> {x, y}
lorFromPoints(x1, y1, x2, y2) -> {theta, r, s1, s2}
binOf(r, theta) -> {a, i, inside}
lorEndpoints(a, i) -> {x1, y1, x2, y2, cA, cB}      // on the ring, and the crystals hit
lorCrystals(a, i) -> [cA, cB]
pointSinusoid(x, y) -> Float32Array(nA) of r
projector({n, fov?, tof?: {sigma}, sWeight?: fn(s)}) -> P
   P.forward(img, angles?, out?) -> Float32Array(nA*nR*nT)    // line integrals, image units × mm
   P.back(sino, angles?, out?)   -> Float32Array(n*n)          // exact adjoint; accumulates into out
   P.fovMask() -> Uint8Array(n*n); P.n, P.dx, P.nT, P.size, P.tof, P.radius
plainProjector(n, fov?)               // cached non-TOF projector
subsets(S) -> [Int32Array angles]      // interleaved: subset q = q, q+S, ...
blurRadial(sino, nT, transpose, {fwhm0?, parallax?})   // detector blur along r, and its adjoint
normalization({variation, deadBlock, seed}) -> {crystal: Float32Array(384), bins: Float32Array(nA*nR)}
attenuationFactors(mu, n, fov?) -> Float32Array(nA*nR)      // exp(-∫mu), 1 outside the object
sumTOF(sino, nT) -> non-TOF sinogram
timing.sigmaPos(ctr) -> mm        // c·σt/2 ; 400 ps gives 25.5 mm
timing.trueAcceptance(s, tau, ctr)   // P(true from position s survives a window of total width tau)
timing.randomsTofFraction(tau, ds, nT) -> {perBin, inside}
energy.sigma(E), windowProb(E, lo, hi), comptonEnergy(phi), kleinNishina(phi),
energy.sampleScatterAngle(rng), photopeakAcceptance(lo, hi), scatterAcceptance(lo, hi),
energy.spectrum(E) -> {photopeak, scatter}          // pdfs per keV, for plots
```

The projector samples each LOR about once per pixel with bilinear
interpolation; a 256² forward projection takes about 50 to 100 ms, TOF about
twice that. The **detector blur** is a Gaussian along r whose FWHM depends on
the true radial position: `sqrt(2.8² + (9·|r|/250)²)` mm (crystal size,
non-collinearity, and depth-of-interaction parallax that grows off centre).
**Normalisation**: each crystal's efficiency is a block factor times a crystal
factor (SD `variation`); an LOR's efficiency is the product of its two
crystals; a dead block zeroes its LORs.

---

## 4. Isotopes and tracers (isotopes.js, written)

```js
PET.isotopes = {
  list() -> [Isotope], get(id) -> Isotope,   // id accepts 'F18', '18F', 'F-18'
  normalizeId(text) -> 'F18'|'C11'|'O15'|null,
  lambda(iso) -> 1/s, decay(iso, t), decayIntegral(iso, t0, t1) -> s,
  decayCorrection(iso, t0, t1) -> (t1-t0)/decayIntegral,
  sampleRange(iso, rng) -> [dx, dy] mm, rangeProfile(iso, x) -> 1/mm,
  rangeStats(iso) -> {mean1D, rms1D}, rangeWidths(iso) -> {fwhm, fwtm},
  rangeKernel(iso, dx) -> {kernel: Float32Array(size²), size, dx}   // sums to 1, symmetric
};
Isotope = { id, label: '¹⁸F', name, halfLife (s), betaPlus (fraction of decays that emit a positron),
            eMax, eMean (keV), rangeMean, rangeMax (mm, 3D, textbook), range1D: {C, k1, k2}, production, color }
PET.tracers = { list() -> [Tracer], get(id) -> Tracer, normalizeId(text) -> id|null };
Tracer = { id, label, name, isotope, target, model: '1tc'|'2tci'|'2tcr', reference: regionId|null,
           outcome, typicalDose (Bq), typicalUptake (s), typicalDuration (s) }
```

Isotopes: F18 (109.77 min, mean range 0.6 mm), C11 (20.36 min, 1.2 mm), O15
(122 s, 3.0 mm). Tracers: `FDG` (F18, 2tci), `PiB` (C11, amyloid, 2tcr),
`florbetaben` (F18, amyloid, 2tcr), `PE2I` (C11, dopamine transporter, 2tcr),
`FE-PE2I` (F18, DAT, 2tcr), `water` (O15, blood flow, 1tc). Each tracer is
tied to its isotope: the language rejects `[11C]FDG`.

---

## 5. Kinetics (kinetics.js)

Tissue activity is not painted on: every brain region's concentration comes
from a compartment model driven by a plasma input function, so static images,
dynamic frames, SUV, SUVR and their biases all follow from the same model.

### 5.1 Units

Kinetic curves are computed in **SUV units, decay corrected** (concentration
divided by injected dose per gram of body weight), then scaled to Bq/mL with
`c = SUV · dose / (weight_kg · 1000)` (tissue density 1 g/mL). Rate
constants are per minute; API times are seconds.

### 5.2 API

```js
PET.kinetics = {
  // Plasma input of a tracer (parent compound, decay corrected, SUV units), t in s.
  input(tracerId) -> { cp(t) -> SUV, peakTime, description },
  // Parameters of one model; a Model is { model: '1tc'|'2tci'|'2tcr', K1, k2, k3, k4, vb }
  params(tracerId, regionId, condition) -> Model | null,   // null: region takes up no tracer
  // Tissue response of a model to an input sampled on tGrid (s, uniform step).
  // Returns SUV-unit, decay-corrected arrays: c1 (free/nondisplaceable), c2 (bound/trapped),
  // ct = (1 - vb)(c1 + c2) + vb·cp, and cp itself.
  tissue(model, cp /* fn(t) or Float64Array on tGrid */, tGrid) -> { ct, c1, c2, cp },
  derived(model) -> { VND, VT, BPND, DVR, Ki, flow },       // whichever apply; DVR = 1 + BPND
  // Concentration (Bq/mL, decay corrected) of every region of a phantom for a compiled
  // protocol, on a uniform grid with step dt (default 2 s) from 0 (injection) to the end of
  // the last frame. Solution phantoms give constant curves: c_r = dose·rel_r / Σ(rel_q·V_q).
  regionTACs(phantom, program, { dt, condition }) -> {
      t: Float64Array, dt, plasma: Float64Array (Bq/mL), suvScale /* Bq/mL per SUV */,
      regions: [ Float64Array per phantom region, index-aligned with phantom.regions ] },
  // Frame averages (decay corrected, Bq/mL) of a TAC set: one Float64Array per frame.
  frameMeans(tacs, frames) -> [Float64Array(nRegions)],
  // Graphical analyses on frame mid-times (s) and frame-mean concentrations.
  patlak(t, ct, cp, tStar)  -> { Ki /* 1/min */, V0, x, y, fitFrom, r2 },
  logan(t, ct, cref, k2ref /* 1/min */, tStar) -> { DVR, BPND, x, y, fitFrom, r2 },
  suv(conc, doseBq, weightKg), suvr(target, reference),
  // SUVR over a window of a pair of continuous curves, and the curve SUVR(t)
  ratioCurve(tacs, targetIndex, refIndex) -> Float64Array
};
```

**Models.** 1TC: `dC1/dt = K1·Cp − k2·C1`. 2TC: `dC1/dt = K1·Cp − (k2+k3)·C1 +
k4·C2`, `dC2/dt = k3·C1 − k4·C2`; irreversible when k4 = 0. Use the analytic
impulse response (sum of two exponentials) and an exact recursive convolution
for piecewise-linear input. Derived: `VND = K1/k2`, `BPND = k3/k4`,
`VT = VND·(1 + BPND)`, `Ki = K1·k3/(k2 + k3)`.

**Input functions.** A Feng-type shape per tracer, in SUV units, arrival
delay about 15 s: `Cp(τ) = (A1·τ − A2 − A3)·e^(−λ1 τ) + A2·e^(−λ2 τ) + A3·e^(−λ3 τ)`
for τ = t − delay ≥ 0. FDG: classic Feng parameters scaled so that the FDG
gray-matter SUV at 45 to 55 min is about 6 to 8 and gray/white contrast about
2.5. PiB and the DAT tracers clear faster. Water: a sharp bolus (peak at 20 to
30 s) that falls to a plateau. Tune amplitudes so the SUV values below come
out; document the numbers in the code.

**Regional parameters** (`params`), by tissue class with condition-specific
changes; tune to hit these targets and keep them in one readable table:

| tracer | regions | normal | `ad` | `pd` |
|---|---|---|---|---|
| FDG (2tci) | gray matter: K1 0.102, k2 0.130, k3 0.062, vb 0.04; white matter: K1 0.054, k2 0.109, k3 0.045, vb 0.02; scalp: low | GM SUV 6 to 8 at 50 min | temporal cortex k3 ×0.6, K1 ×0.85; occipital ×0.85; frontal ×0.9 (temporoparietal hypometabolism) | about normal |
| PiB (2tcr) | cerebellar GM is the reference (k3 = 0); cortex K1 about 0.25, VND about 2; WM: low K1, slow washout, nonspecific retention | cortex BPND 0.1 to 0.2; WM SUVR (to cerebellar GM) about 1.6 at 50 to 70 min | frontal, temporal BPND about 1.5, occipital 0.8, striatum 1.0 | normal |
| florbetaben (2tcr) | as PiB, slower | as PiB | cortex BPND about 0.7 (lower signal than PiB) | normal |
| PE2I, FE-PE2I (2tcr) | cerebellar GM reference; putamen and caudate BPND about 4 (PE2I) or 3.5 (FE-PE2I); thalamus 0.3; cortex 0.1 | as stated | normal | patient's LEFT side worse: putamen post L ×0.2, ant L ×0.45, post R ×0.4, ant R ×0.7, caudate L ×0.7, R ×0.85 |
| water (1tc) | GM K1 = CBF 0.55, WM 0.22, partition p = 0.9 / 0.8, k2 = K1/p | | temporal flow ×0.8 | normal |

CSF, ventricles and skull take up nothing (`params` returns null). The
`sinus` region is blood: its curve is the plasma curve (plasma = whole blood,
a stated simplification). FE-PE2I reaches equilibrium faster than PE2I.

**Graphical analysis.** Patlak: `y = Ct/Cp`, `x = ∫Cp/Cp` (minutes), linear
fit for t ≥ tStar; slope Ki. Logan with reference region (Logan 1996):
`y = ∫Ct / Ct`, `x = (∫Cref + Cref/k2') / Ct`, slope = DVR. Integrals by the
trapezoid rule on frame mid-times starting from (0, 0). Both return the
points so the UI can plot them.

---

## 6. Phantoms (phantoms.js)

```js
PET.phantoms = {
  list() -> [ { id, name, description, kind: 'solution'|'brain', options: [OptionDef] } ],
  build(id, opts) -> Phantom,        // cached by (id, JSON(opts))
  clearCache()
};
OptionDef = { key, label, type: 'select'|'bool'|'number', values?: [{value, label}], min?, max?, step?, default }
Phantom = {
  id, name, description, kind,
  n: 256, fov: 320, dx: 1.25,        // raster, mm
  label: Uint8Array(n*n),            // index into regions; 0 is air
  regions: [Region],                 // regions[0] is air
  mu: Float32Array(n*n),             // 511 keV attenuation, 1/mm
  axialLength,                       // mm: axial extent of the object (spreads dose axially, sets singles)
  outsideFraction,                   // fraction of the injected activity elsewhere in the body that still
                                     // reaches the detectors as singles (0 for phantoms, about 0.3 for the head)
  condition,                         // 'normal'|'ad'|'pd' for the brain, null otherwise
  landmarks: [ {name, x, y} ],       // mm, for annotation
  notes: string
}
Region = { id, name, color, mu /* 1/mm */, tissue /* 'gm'|'wm'|'csf'|'bone'|'soft'|'blood'|'water'|'air'|'lung'|'plastic' */,
           rel /* relative concentration, solution phantoms */, pixels /* count in the raster */,
           volume /* mL = pixels·dx²·axialLength/1000 */, roi: bool /* offer as an ROI */ }
```

mu at 511 keV (1/mm): air 0, water and soft tissue 0.0096, brain 0.0099,
bone (skull) 0.0151, lung 0.0030, PMMA 0.0103. Labels are hard (no
anti-aliasing); the 1.25 mm raster gives partial volume when imaged at
2.5 mm.

Phantoms (all on the 256 × 256, 320 mm raster):

1. **point** "Line sources": three 1-pixel sources (capillaries along the
   axis, which in one slice are points) at x = 0, 50 and 100 mm on y = 0,
   plus one at (0, −100). Option `medium`: `air` (default) or `water` (a
   200 mm water cylinder with no activity around them, so attenuation and
   scatter act on the sources). axialLength 50 mm.
2. **cylinder** "Uniform cylinder": 200 mm water cylinder, uniform activity,
   3 mm PMMA wall (no activity). axialLength 200 mm.
3. **spheres** "Hot and cold spheres" (NEMA IEC-like): 230 mm water cylinder
   background; six spheres in the slice through their centres, centred on a
   circle of radius 57.2 mm, diameters 10, 13, 17, 22 mm (hot) and 28, 37 mm
   (cold, no activity); a 51 mm central lung insert (mu lung, no activity).
   Options: `ratio` hot sphere to background 2, 4 (default), 8, 16; `lung`
   (default true). axialLength 180 mm. Note in `notes` that in one slice the
   spheres act as rods.
4. **rods** "Hot rods (Derenzo-style)": a 200 mm water cylinder without
   background activity, six sectors of hot rods of diameter 3, 4, 5, 6, 8 and
   10 mm, centre-to-centre spacing twice the diameter. axialLength 100 mm.
   This is the phantom where positron range is visible.
5. **brain** "Brain": `condition` `normal` (default), `ad` (Alzheimer's
   disease), `pd` (Parkinson's disease). A schematic oblique axial slice
   through the striatum, tilted so the cerebellum appears posteriorly (as
   some PET protocols angle the slice), so the usual reference region is in
   plane. Head about 150 × 190 mm. From outside in: scalp (3 to 4 mm), skull
   (5 to 7 mm bone), CSF (2 mm), a cortical gray-matter ribbon about 3 mm
   thick following a folded boundary (sulci with CSF), white matter, lateral
   ventricles (frontal horns, butterfly shape), caudate heads beside them,
   putamen (lentiform, lateral, split at its midpoint into anterior and
   posterior parts), thalamus, a posterior cerebellum (folia pattern of
   gray matter around a white-matter core, vermis in the middle, separated
   from the cerebrum by the tentorium), and the confluence of the venous
   sinuses (blood, 8 to 10 mm) at the posterior midline. Region ids (other
   modules use them): `air scalp skull csf ventricles wm gm_frontal
   gm_temporal gm_occipital caudate_r caudate_l putamen_r_ant putamen_r_post
   putamen_l_ant putamen_l_post thalamus cereb_gm cereb_wm sinus`. Cortex
   lobes are split by angle around the brain centre (frontal anterior,
   temporal lateral, occipital posterolateral above the tentorium).
   axialLength 150 mm, outsideFraction 0.3.

---

## 7. The protocol language (dsl.js)

### 7.1 What it looks like

```
# FDG brain scan, static
protocol "FDG brain, static"

param DOSE   = 185 MBq range 40 MBq .. 400 MBq   "injected activity"
param UPTAKE = 45 min  range 0 min .. 120 min    "uptake time before the scan starts"
param DUR    = 10 min  range 1 min .. 30 min     "scan duration"

tracer FDG            # [18F]fluorodeoxyglucose; the isotope follows from the tracer
isotope F18           # optional; must agree with the tracer
weight 70 kg          # for SUV
inject DOSE           # bolus at time 0
wait UPTAKE           # patient rests while the tracer is taken up
static DUR            # one frame

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
```

Dynamic framing replaces `wait`/`static` with frames that start at injection:

```
inject DOSE
frames 6 x 10 s
frames 4 x 30 s
frames 5 x 2 min
frames 5 x 10 min
```

### 7.2 Lexical rules

- One statement per line. `#` starts a comment. Blank lines ignored.
- Numbers: `12`, `0.5`, `1e-3`. A number may be followed, with or without a
  space, by a unit: time `s ms us µs ns ps min h`; activity `Bq kBq MBq GBq
  mCi uCi µCi`; energy `keV MeV`; mass `kg g`; length `mm cm`. Units attach
  only to number literals.
- Strings `"..."`. Identifiers `[A-Za-z_][A-Za-z0-9_-]*` (hyphen allowed so
  `FE-PE2I` is one word; a minus between two identifiers needs spaces).
- Operators `+ - * / ( ) , = ..` and `x` in `frames N x D` (both `6 x 10 s`
  and `6x10s` are accepted).
- Reserved words: `protocol param let range step tracer isotope inject at
  weight wait static frames energy coincidence tof on off mode` plus unit
  names.

### 7.3 Values and dimensions

Kinds: `none, time, activity, energy, mass, length`. `+ -` need equal kinds
("cannot add 10 min and 185 MBq"; "cannot add a time and a plain number; did
you forget a unit?"). `none·X = X`, `X/none = X`, `X/X = none`, other
products give an error naming the kinds. Functions `min max round floor ceil
abs` keep their argument's kind. Constants: `T_half` (time, the half-life of
the isotope declared so far, error if none yet). A plain number where a unit
is required is an error with a hint ("write 10 min").

### 7.4 Statements

| statement | meaning |
|---|---|
| `protocol "Title"` | name shown in the UI |
| `param NAME = expr [range lo .. hi] [step s] ["description"]` | tunable value; becomes a slider |
| `let NAME = expr` | derived constant |
| `tracer ID` | `FDG PiB florbetaben PE2I FE-PE2I water none` (case-insensitive); `none` means a phantom filled with a solution of the isotope |
| `isotope ID` | `F18 C11 O15` (also `18F` etc.); required when the tracer is `none` or absent, otherwise optional and must match |
| `inject A [at T]` | injected (or phantom fill) activity; time zero of the protocol clock is the injection unless `at` moves it |
| `weight W` | body weight for SUV, default 70 kg |
| `wait T` | advance the clock (uptake) |
| `static D` | one frame of duration D at the clock, then advance |
| `frames N x D` | N consecutive frames of duration D, then advance |
| `energy LO .. HI` | energy window, default 435 keV .. 650 keV |
| `coincidence T` | coincidence timing window (total width), default 4.5 ns |
| `tof on|off [R]` | time of flight; R = coincidence timing resolution FWHM (default 400 ps, also used for window losses when off) |
| `mode 3D|2D` | 3D (septa out, default) or 2D (septa in: lower sensitivity, much less scatter and randoms) |

Errors carry a line, a column and a hint, in plain words, for example:
"FDG is labelled with 18F, not 11C. Remove the isotope line or pick a carbon-11
tracer (PiB, PE2I)"; "the energy window must contain the 511 keV photopeak";
"add a `static` or `frames` line: the protocol never acquires anything".
Warnings (compile succeeds): lower level below 350 keV (lots of scatter);
coincidence window under 2.5 ns (true events at the edge of the field of view
are lost); scan starting more than 5 half-lives after injection; dose more
than twice the tracer's typical dose; more than 64 frames is an error.

### 7.5 Compile API and output

```js
PET.dsl = {
  compile(source, { overrides: {NAME: valueSI} }) -> Program,
  setParamInSource(source, program, name, valueSI) -> newSource,
  tokenize(source) -> [ {type, text, line, col, start, end} ],   // for syntax highlighting
  formatParam(param, valueSI) -> string,
  keywords: { statements, units, tracers, isotopes },
  reference: string                                              // short language reference (HTML)
};
Program (ok) = {
  ok: true, name, source,
  params: [ { name, value, kind, unit, scale, min, max, step, description, line, span: [start, end] } ],
     // value SI; unit = display unit as written; scale = SI per display unit
  lets: { NAME: value },
  tracer: id | null, isotope: 'F18'|'C11'|'O15', dose: Bq, weight: kg,
  frames: [ { t0, t1 } ],            // seconds RELATIVE TO INJECTION (negative = before injection)
  scanStart, scanEnd,                // first frame start, last frame end (relative to injection)
  dynamic: bool,                     // more than one frame
  energy: { lo, hi },                // keV
  coincidence: s,                    // total window width
  tof: { on: bool, ctr: s },
  acqMode: '3D'|'2D',
  warnings: [ { line, msg } ],
  stats: { nFrames, scanDuration, uptake /* = scanStart */, decayAtStart, decayDuringScan }
}
Program (failed) = { ok: false, source, errors: [ { line, col, msg, hint } ], params: [...as far as parsed] }
```

### 7.6 Presets (presets.js)

`PET.presets = [ { id, name, group: 'brain'|'phantom'|'dynamic', summary, phantom, phantomOpts, source } ]`
and `PET.presets.get(id)`. Choosing a preset in the UI also switches to its
phantom. Every preset uses the parameter names `DOSE`, and where they apply
`UPTAKE` and `DUR`, so lessons can set them. Comment them as a careful
instructor would.

| id | protocol | phantom |
|---|---|---|
| `first` | "Your first protocol": FDG static, every line commented | brain |
| `fdg_static` | FDG 185 MBq, 45 min uptake, 10 min static, TOF (default preset) | brain |
| `fdg_dynamic` | FDG 0 to 60 min dynamic: 6×10 s, 3×20 s, 2×60 s, 5×2 min, 4×10 min | brain |
| `pib_static` | PiB 400 MBq, 50 to 70 min | brain, ad |
| `pib_dynamic` | PiB 0 to 70 min dynamic (for Logan) | brain, ad |
| `fbb_static` | florbetaben 300 MBq, 90 to 110 min | brain, ad |
| `fepe2i_static` | FE-PE2I 200 MBq, 20 to 40 min | brain, pd |
| `pe2i_dynamic` | PE2I 350 MBq, 0 to 70 min dynamic | brain, pd |
| `water_dynamic` | [15O]water 700 MBq, 12×5 s, 6×10 s, 4×15 s | brain |
| `point_res` | 18F solution 5 MBq, 2 min, line sources | point |
| `cyl_uniform` | 18F solution 40 MBq, 10 min | cylinder |
| `spheres_iq` | 18F solution 50 MBq, 10 min | spheres |
| `rods_f18` | 18F solution 40 MBq, 10 min; comment says change F18 to O15 | rods |

---

## 8. Acquisition engine (engine.js)

```js
PET.engine = {
  simulate(program, phantom, tacs, ctx, opts) -> Promise<AcqData>,
  physicsDefaults() -> Physics,
  CAL                                  // calibration constants, exported for tests and the UI
};
ctx  = { physics: Physics }
opts = { onProgress(frac), shouldAbort() -> bool }
Physics = {
  attenuation: true, scatter: true, randoms: true, noise: true,
  positronRange: true, detectorBlur: true,
  motion: { on: false, kind: 'step'|'drift'|'periodic', dx: 6, dy: 0 /* mm */, rot: 0 /* deg */,
            at: 0.5 /* fraction of the scan, step */, period: 5 /* s, periodic */ },
  muMap:  { dx: 0, dy: 0 /* mm */, rot: 0 /* deg */, model: 'ct'|'nobone' },   // the mu map USED FOR CORRECTION
  detector: { variation: 0.06, deadBlock: -1 },
  seed: 1
}
```

### 8.1 Model

For each frame `[t0, t1]` (relative to injection):

1. **Decays.** For each region r, decays per mL in the frame
   `D_r = betaPlus · ∫ C_r(t) e^(−λt) dt` (C decay corrected, from `tacs`).
   The frame's emission raster is `Σ_r D_r · [label = r]`. Frames before
   injection have nothing.
2. **Positron range** (if on): convolve the raster with
   `PET.isotopes.rangeKernel(iso, dx)` (`PET.util.convolve2D`).
3. **Motion** (if on): the object pose (dx, dy, rot) is a function of time
   over the whole scan: `step` jumps from 0 to the full pose at fraction `at`
   of [scanStart, scanEnd]; `drift` ramps linearly; `periodic` is
   `pose·sin(2π t / period)`. Split each frame into sub-intervals over which
   the pose is nearly constant (step: split at the jump; drift: 8 parts;
   periodic: 12 phase bins), weight each by its share of the decays, and
   transform both the emission raster and the TRUE mu map for each
   (`PET.util.transformImage`). Pose 0 is the reference (the patient's
   position at scan start, where the CT was taken).
4. **Trues.** Forward project each sub-raster with `sWeight =
   timing.trueAcceptance(s, coincidence, ctr)` (TOF projector when
   `tof.on`), multiply by the attenuation factors of the matching mu map (if
   attenuation on), by `κ0 = CAL.SENS · (mode factor) · ε_E²` with
   `ε_E = energy.photopeakAcceptance(lo, hi)`, the slice thickness and the
   bin geometry, apply the detector blur (if on), then the normalisation
   (crystal efficiencies). Calibrate `CAL.SENS` so `fdg_static` on the
   normal brain gives about 1.5 to 2.5 M true counts in the slice.
5. **Scatter** (if on). Photons that attenuation removed reappear, once
   scattered, elsewhere in the sinogram:
   `L = P·(1 − a)` (unattenuated projection times the attenuated fraction),
   `S = κ0 · CAL.SCATTER · (ε_s/ε_E) · K ⊛ L`, with `ε_s =
   energy.scatterAcceptance(lo, hi)` and K a broad smooth kernel (Gaussian
   along r with σ about 60 to 80 mm plus a light smoothing across angles).
   This makes scatter grow with object size and density, extend outside the
   object (the "tails"), and shrink when the lower energy threshold rises.
   Calibrate so the scatter fraction `S/(T+S)` is about 0.30 to 0.40 for the
   head and the 200 mm cylinder in 3D at 435 keV, about 0 for line sources in
   air. TOF: spread each LOR's scatter over TOF bins following that LOR's
   trues profile convolved with a broad Gaussian (σ about 80 mm).
6. **Randoms** (if on). Singles come from all activity in or near the field
   of view, including the body outside the slice:
   `A_s(t) = Σ_r C_r(t)·V_r·e^(−λt) + outsideFraction·dose·e^(−λt)`. The
   randoms rate is `CAL.RANDOMS · τ · A_s(t)²` (two singles within τ), so
   integrate `A_s²` over the frame. Spread uniformly over the sinogram,
   times the normalisation (randoms see crystal efficiencies too) but no
   attenuation. TOF: only randoms whose time difference falls inside the TOF
   bins are kept, `timing.randomsTofFraction(τ, ds, nT)` per bin.
   Calibrate so `fdg_static` gives randoms/trues about 0.25 at 4.5 ns.
7. **2D mode** (septa in): sensitivity ×0.2, scatter ×0.35, singles ×0.4
   (randoms ×0.16). Put the factors in `CAL`.
8. **Noise.** `prompts = Poisson(T + S + R)` per bin (seeded,
   `PET.util.poisson`); `delayed = Poisson(R)` (the delayed-window randoms
   estimate, as noisy as the randoms themselves). With `noise: false` both
   are the expected values.
9. **Motion correction data.** With motion on, also produce `promptsMC`:
   each sub-interval's Poisson sinogram moved back to the reference pose
   before summing (event-by-event LOR repositioning with perfect tracking):
   a rotation shifts angle rows (wrapping θ + π to −r), a translation shifts
   r by `dx cos θ + dy sin θ` (and TOF position by `−dx sin θ + dy cos θ`),
   with linear interpolation. Same noise realisation as `prompts`.

### 8.2 What the scanner gives reconstruction (AcqData.corrections)

- `norm`: LOR efficiencies (the scanner measured these with a rotating
  source; the simulator's own values).
- `acf`: attenuation correction factors `1/a'` from the CORRECTION mu map:
  the true mu map at the reference pose, shifted and rotated by
  `physics.muMap`, with bone replaced by soft tissue when `model` is
  `nobone` (the classic MR-based AC error). Values ≥ 1.
- `randomsSingles` per frame: the smooth expected randoms (as estimated from
  singles rates; noiseless).
- `scatterEst` per frame: the scatter model run on the true emission at the
  reference pose with the CORRECTION mu map, then scaled by **tail fitting**:
  `scale = Σ_tails (prompts − delayed) / Σ_tails scatterEst` over LORs that
  miss the object (`acf < 1.03`). So a misaligned mu map corrupts scatter
  correction too, and correcting scatter that is not there does nothing.
  Running the model on the true emission is the one place the scanner peeks
  at the truth; the UI says so (real scanners iterate from a first
  reconstruction).

### 8.3 AcqData

```js
AcqData = {
  program, phantomId, phantomOpts, physics, seed,
  isotope, tracer, dose, weight,
  geom: { nA, nR, nT /* 1 or 17 */, tof: bool, ctr, sigmaTOF /* mm */, ds, dr },
  frames: [ {
     index, t0, t1, dur,
     decayIntegral,                 // ∫ e^(-λt) dt over the frame (s)
     kappa,                         // counts per (decay-corrected Bq/mL · mm of line integral):
                                    // κ0·betaPlus·decayIntegral. Expected unattenuated, unnormalised
                                    // trues = kappa · (P C)_i for a decay-corrected image C.
     kappaNoDecay,                  // κ0·betaPlus·dur: what you get if you forget decay correction
     prompts: Float32Array(nA*nR*nT),
     promptsMC: Float32Array | null,
     delayed: Float32Array(nA*nR*nT),
     randomsSingles: Float32Array(nA*nR*nT), scatterEst: Float32Array(nA*nR*nT),
     expected: { trues, scatter, randoms },     // non-TOF (summed) Float32Array(nA*nR), for display
     counts: { prompts, trues, scatter, randoms, nec, sf, rf },   // nec = T²/(T+S+R)
     truth: { regionMean: Float64Array(nRegions) }               // decay-corrected Bq/mL averages
  } ],
  corrections: { norm: Float32Array(nA*nR), acf: Float32Array(nA*nR), muCorr: Float32Array(n²) },
  muTrue: Float32Array(n²),
  totals: { prompts, trues, scatter, randoms, nec },
  stats: { computeMs, sliceThickness, sensitivity, scatterFraction, randomsFraction },
  warnings: [string]
}
```

Performance: `fdg_static` (non-TOF, no motion) under 0.6 s; with TOF under
1.5 s; `fdg_dynamic` (20 frames, non-TOF) under 4 s. Yield every ~30 ms and
report progress. Precompute what frames share (attenuation factors,
per-region projections if that is faster).

---

## 9. Reconstruction (recon.js)

```js
PET.recon = { run(acq, opts, hooks) -> Promise<ReconResult>, defaults, filters };
hooks = { onProgress(frac), onIteration(k, image), shouldAbort() }
opts = {
  method: 'bp'|'fbp'|'mlem'|'osem',
  filter: 'ramp'|'shepp'|'cosine'|'hamming'|'hann'|'butterworth', cutoff: 1.0 /* × Nyquist */, order: 4,
  iterations: 4, subsets: 12,       // subsets ignored by mlem
  tof: true,                        // use TOF if the data has it (bp, mlem, osem; FBP sums TOF bins)
  psf: false,                       // resolution modelling: detector blur in the system model
  rangeCorrection: false,           // positron range kernel in the system model
  matrix: 128,                      // 64 | 128 | 256 over the 320 mm FOV
  postFilter: 3,                    // Gaussian FWHM, mm (0 = none)
  frame: 0,                         // frame index, or 'all'
  corrections: { normalization: true, attenuation: true, scatter: true, randoms: true,
                 randomsMethod: 'delayed'|'singles', decay: true, motion: false },
  keepIterations: true
};
ReconResult = {
  n, fov, dx, method, frame,
  image: Float32Array(n*n),         // Bq/mL; decay corrected to injection when corrections.decay
  frames: [Float32Array] | null,    // when frame === 'all'
  iterations: [Float32Array] | null,// image after each (full) iteration
  corrected: Float32Array(nA*nR),   // the corrected, non-TOF sinogram FBP used (for display)
  info: { timeMs, notes: [string], tofUsed, iterationsDone }
}
```

**Data model.** For LOR bin i: `y_i ~ Poisson( n_i · a_i · κ · (H x)_i + s_i + r_i )`
with n = norm (if normalization), a = 1/acf (if attenuation), s = scatterEst
(if scatter), r = delayed or randomsSingles (if randoms), κ = kappa (or
kappaNoDecay if `decay` is false), H = P (+ blur and range kernel when psf /
rangeCorrection). With `motion` and promptsMC present, use promptsMC.

- **bp**: plain (TOF-weighted if tof) backprojection of the corrected data,
  scaled to have the right mean in a uniform cylinder. Shows the 1/r blur and
  what TOF localisation alone does.
- **fbp**: correct the sinogram (`(y − r − s)/n · acf / κ`, LORs with n = 0
  set to 0 so the gap shows as streaks), sum TOF bins, ramp-filter along r
  with zero padding using the chosen apodising window (ramp, Shepp-Logan,
  cosine, Hamming, Hann, Butterworth with order) and cutoff, backproject,
  scale so a uniform cylinder reconstructs to its concentration.
- **mlem / osem**: multiplicative update with the corrections in the model
  (`b = s + r` added to the forward projection, n·a·κ multiplying it), the
  sensitivity image `Hᵀ(n a κ)` per subset, start from a uniform image inside
  the FOV mask, guard divisions, store each full iteration. OSEM uses
  `PET.scanner.subsets(S)`.
- **TOF** in mlem/osem/bp uses a TOF projector with `sigma =
  timing.sigmaPos(ctr)`.
- **postFilter**: `PET.util.gaussBlur2D` with FWHM in pixels.
- `frame: 'all'`: reconstruct every frame (yield between them).

Units: images in Bq/mL, so that a 40 MBq / 6.28 L cylinder gives about
6.4 kBq/mL. Performance: OSEM 4×12, 128², non-TOF under 0.5 s; TOF under
2 s; FBP under 100 ms.

---

## 10. Analysis (analysis.js)

```js
PET.analysis = {
  regionFractions(phantom, m) -> [Float32Array(m*m)]    // per region, fraction of each image pixel; cached
  roiDefs(phantom) -> [ { id, name, regions: [regionId], color, reference: bool } ]
       // single regions plus composites: brain: cortex, striatum, putamen_l, putamen_r, caudate, cerebellum,
       // white matter; spheres: each sphere and the background; rods: each rod group; cylinder: centre disk
  roiMask(phantom, m, roiId, { threshold: 0.5, erode: 0 }) -> Float32Array(m*m)   // 0/1 weights
  roiStats(image, mask) -> { mean, sd, cov, min, max, nPix }
  truthImage(acq, frame, m) -> Float32Array        // Σ regionMean · fraction (decay corrected Bq/mL)
  circleMask(m, fov, cx, cy, r) -> Float32Array
  profile(image, m, fov, x0, y0, x1, y1, nSamples) -> { s: Float64Array, v: Float64Array }
  fwhm(s, v) -> mm                                  // half-maximum crossings, linear interpolation
  pointResolution(image, m, fov, x, y) -> { radial, tangential }   // FWHM of profiles through a point
  nemaIQ(image, m, fov, phantom) -> { spheres: [ {id, d, kind, mean, contrast, recovery} ], bgMean, bgVariability }
  gtm(image, m, fov, phantom, fwhmMm) -> { rois: [ {id, name, observed, corrected, truth?} ] }   // geometric transfer matrix
  tacs(images, phantom, m, roiIds, frames) -> { t /* mid times, s */, values: { roiId: Float64Array } }
  suvImage(image, dose, weight) -> Float32Array
};
```

---

## 11. Event animation (events.js)

A toy, event-by-event Monte Carlo for the Scanner tab only (images never come
from it). It samples decays from the current frame's emission raster and
follows them through the true mu map:

```js
PET.events.create(scene, settings) -> Sim
scene    = { phantom, emission /* Float32Array n², relative decays */, isotope, program, physics }
settings = { rate /* decays per second of animation time */, seed }
Sim.step(dtWall) -> [Event]       // new events during dtWall seconds of animation
Sim.counts -> { trues, scatters, randoms, rejectedEnergy, rejectedTime, singles }
Event = { id, kind: 'true'|'scatter'|'random'|'single'|'rejected-energy', t,
          decay: {x, y}, annihilation: {x, y},
          photons: [ { path: [{x, y}], energy /* keV, after any scatter */, measured /* keV */,
                       crystal /* index or -1 */, time /* s, arrival */, absorbed: bool } ],
          lor: { a, i, x1, y1, x2, y2 } | null, tofPos: {x, y} | null,
          partner: id | null    // for randoms: the other single's event id
        }
```

Physics: positron range from `isotopes.sampleRange`; back-to-back photons
with ±0.25° non-collinearity; in-plane travel; interaction along the path by
sampling `exp(−∫mu)`; at an interaction, Compton scatter with
`energy.sampleScatterAngle` (once; a second interaction absorbs); a photon
that leaves the slice axially (probability set so singles outnumber
coincidences as on a real scanner) becomes a single; measured energy blurred
with `energy.sigma`; energy window from the protocol; arrival times with the
CTR; two singles from different decays within the coincidence window form a
random. The animation slows time by about 10⁹ and scales the rate so the
fractions of trues, scatters and randoms roughly match the current
protocol's sinogram counts.

---

## 12. User interface

### 12.1 Layout (index.html + style.css + app.js)

- Header: "← Back to Course Home" (`../../index.html`), title "PET
  Simulator", subtitle "A teaching scanner: write a protocol, inject a
  tracer, watch coincidences become an image", a badge "LYSO ring · 511 keV",
  theme toggle (auto / light / dark, localStorage key `petSim.theme`, sets
  `data-theme` on `<html>`).
- **Scan bar** (sticky): Acquire (▶), Stop, speed (Instant, Fast ≈ 3 s, Slow
  ≈ 10 s), progress bar, a one-line summary ("FDG · Brain (normal) · 185 MBq
  · 45 min uptake · 10 min static · TOF 400 ps · 2.1 M trues"), "Auto
  re-scan" (default on), and two thumbnails (sinogram and image) that jump to
  their tabs.
- **Tab bar** from `PET.ui.tabs` sorted by `order`, `role=tablist`, arrow-key
  navigation, active tab remembered (localStorage + `#tab=<id>`).
- Design tokens as in the MRI simulator, plus the event colours `--ev-true
  --ev-scatter --ev-random --ev-rejected` (cards) and `--sev-*` (scopes, plus
  `--sev-photon --sev-positron`). Every view that shows trues, scatters or
  randoms uses them. Emission images default to the `pet` colour map
  (`inferno` and `gray` offered); mu maps and sinograms `gray`. Works down to
  360 px wide with a 16 px gutter and no horizontal page scroll (the tab bar
  may scroll).

Tabs (id, order, title): `lessons` 0 Guide · `scanner` 10 Scanner · `tracer`
20 Isotopes & tracers · `protocol` 30 Protocol · `phantom` 40 Phantom ·
`sinogram` 50 Sinogram · `recon` 60 Reconstruction · `corrections` 70
Degradations & corrections · `kinetics` 80 Dynamic & quantification. Default
tab on first visit: `lessons`.

### 12.2 Tab definition

```js
PET.ui.registerTab({ id, title, order, mount(panelEl), onShow(), onHide() });
```
`mount` runs once, after app.js has created state and actions. Each tab
injects its CSS with `PET.ui.addStyle()`, every rule scoped under
`#tab-<id>`. Tabs redraw on `onShow` and on window resize (debounced), and
listen on the bus for the events they display. Shared widgets:
`PET.ui.w` (see `js/ui/widgets.js` and its header comment: `concept, slider,
select, toggle, segmented, imageView, plot, statTable, toast, button, badge,
legend, details, callout, empty, errorCard`).

### 12.3 State and actions (app.js)

```js
PET.state = {
  phantomId: 'brain', phantomOpts: { condition: 'normal' },
  presetId: 'fdg_static', source, program, lastGoodProgram, compileErrors: [],
  physics: PET.engine.physicsDefaults(),
  recon: { ...PET.recon.defaults },
  acq: null, reconResult: null, tacs: null,
  scanning: false, autoRescan: true, speed: 'fast',
  frame: 0,                          // frame shown in Sinogram/Recon (dynamic protocols)
  analysis: { roi: 'cortex', reference: 'cereb_gm', target: 'cortex' }
};
PET.actions = {
  getPhantom() -> Phantom, getTACs() -> tacs (for the current phantom + program, cached),
  setPhantom(id, opts?), setPhantomOpts(patch),
  loadPreset(id), setSource(text), setParam(name, valueSI),
  setPhysics(patch /* deep merge */), resetPhysics(),
  setRecon(patch /* deep merge, corrections included */), reconstruct(),
  reconstructAllFrames() -> Promise<ReconResult>,      // for the kinetics tab
  setFrame(i), setAnalysis(patch),
  runScan({ animate }) -> Promise, stopScan(),
  showTab(id), setAutoRescan(bool), setSpeed(mode), currentSummary()
};
```

Changing phantom, source/params or physics triggers a debounced (300 ms)
instant re-scan when `autoRescan` is on and the program compiled. `setRecon`
only re-runs the reconstruction.

Bus events: `phantom:changed {phantom}` · `program:compiled {program, errors}`
· `physics:changed {physics}` · `scan:start {animate}` · `scan:progress {frac,
stage: 'compute'|'playback'}` · `playback:tick {frac, t /* protocol time, s */,
frame, counts}` · `scan:done {acq}` · `scan:error {message}` · `recon:start` ·
`recon:done {result, partial}` · `frame:changed {frame}` ·
`analysis:changed {analysis}` · `tab:shown {id}` · `theme:changed {dark}`.

**Playback.** After `engine.simulate` finishes, an animated scan reveals the
counts as they would accumulate: at progress f each frame's prompts are
thinned binomially (a fixed per-bin uniform so the thinning is monotone in
f), frames of a dynamic protocol fill in order, and a quick reconstruction
runs every ~250 ms (`recon:done` with `partial: true`), so the image visibly
goes from noise to picture. Instant skips to the end.

### 12.4 The tabs

- **Guide (lessons.js)**: a short welcome and lessons, each with a goal, a
  "Set up" button (preset, phantom, physics, recon, tab), numbered things to
  try and questions, and a one-line takeaway. Lessons: 1 From decay to
  coincidence (the scanner tab); 2 Isotopes: half-life and positron range;
  3 The sinogram; 4 Backprojection and filtering; 5 Iterative reconstruction
  and noise; 6 Counts and noise (dose, duration, decay); 7 Attenuation and its
  correction; 8 Scatter and the energy window; 9 Randoms and the timing
  window; 10 Time of flight; 11 Partial volume and resolution; 12 Motion and
  a misaligned mu map; 13 Static quantification: SUV and SUVR; 14 Dynamic
  PET and compartment models; 15 Amyloid and dopamine imaging: is SUVR the
  binding?
- **Scanner (scanner.js)**: an SVG/canvas schematic: the ring of 48 blocks
  (crystals visible on zoom), an inset of one block (LYSO crystals, light
  guide, SiPM array, front-end with energy integrator and timing
  discriminator), and the electronics chain (singles processor, coincidence
  processor with the timing window, energy discrimination, sorter into
  sinogram or list mode, reconstruction computer), each clickable for an
  explanation panel. The animation (`events.js`) shows decays, positron
  flights, back-to-back photons, scattering kinks, crystals flashing, and LORs
  coloured by type (true, scatter, random, rejected), with TOF position
  kernels when TOF is on, a running count table, a measured-energy histogram
  with the window marked, a time-difference histogram with the coincidence
  window marked, and a mini sinogram filling in. Controls: play/pause, step,
  speed, event types shown, 2D/3D septa shown.
- **Isotopes & tracers (tracer.js)**: isotope cards (half-life, positron
  energy, range), decay curves of the three isotopes on one plot with the
  current protocol's frames marked, positron range profiles and a 2D cloud
  of sampled annihilation points, the tracer table (target, isotope, model,
  reference region), and the current tracer's input function and regional
  TACs.
- **Protocol (protocol.js)**: preset picker, the editor (textarea over a
  highlighted `<pre>`, line numbers, error line marked, Tab inserts spaces),
  errors with clickable line numbers, parameter sliders, a timeline (activity
  in the body vs time from injection, frames shaded, uptake marked, decay
  annotated), a stats table (frames, scan time, decay during scan, expected
  counts from the last scan), the energy window over the spectrum, and the
  collapsible language reference.
- **Phantom (phantom.js)**: picker cards with thumbnails, options, map viewer
  (regions with legend, activity at the frame shown, mu map, true vs
  correction mu map), and a region table (volume, mu, concentration, SUV).
- **Sinogram (sinogram.js)**: the sinogram (prompts, trues, scatter,
  randoms, delayed, corrected, normalisation, ACF; TOF bin selector), hover
  to see the LOR on a ring diagram, click a pixel on a small image to see its
  sinusoid, a radial profile at one angle with the components stacked
  (tails visible), a counts table (trues, scatter, randoms, NEC, SF, RF).
- **Reconstruction (recon.js)**: method, filter and cutoff (with the filter
  response plotted), iterations and subsets, TOF, PSF, matrix, post-filter;
  image, truth and difference; iteration scrubber with a convergence plot
  (ROI mean and noise vs iteration); profiles; ROI statistics.
- **Degradations & corrections (corrections.js)**: a compact switchboard
  (each effect's physics switch beside its correction switch), then one card
  per effect: attenuation, scatter, randoms, low-count noise, positron range,
  detector resolution and partial volume (with GTM correction and recovery
  coefficients on the spheres), motion, misaligned mu map, normalisation and
  a dead block, decay correction. Each card: controls, "What you see",
  "Why", "How it is corrected", and "Show me" which sets up a demonstration
  and re-scans; a small before/after pair where it helps.
- **Dynamic & quantification (kinetics.js)**: a compartment-model explorer
  (diagram with K1..k4 arrows, sliders, input function, C1, C2, total tissue
  curves, derived VT, BPND, Ki), measured TACs from the reconstructed frames
  of a dynamic scan next to the true TACs, SUV and SUVR with a selectable
  target and reference region and window, SUVR over time against the true
  DVR, Patlak and Logan plots, and a comparison table of the true binding
  value against SUVR − 1, Logan and the measured values.

---

## 13. Testing

Node, no dependencies: `node tests/run_all.js`. Each non-UI module ships
`tests/test_<module>.js` using `tests/harness.js`. Browser testing uses the
globally installed Playwright (`require('/opt/node22/lib/node_modules/playwright')`,
Chromium at `/opt/pw-browsers`, do not run `playwright install`), loading the
page over `file://` or a local static server, failing on any console error,
and writing screenshots to the session scratchpad, not the repo.
