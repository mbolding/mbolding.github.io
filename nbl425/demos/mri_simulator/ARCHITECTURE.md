# MRI Simulator: architecture and module contracts

A teaching MRI scanner for NBL 425/625 that runs in the browser. Students
write pulse sequences in a small language, image a choice of phantoms on a
schematic 3 T scanner, watch k-space fill, reconstruct it several ways, switch
common artifacts on and off, and acquire a non-localised proton FID for
spectroscopy.

This file is the contract between the modules. If code and this file
disagree, fix one of them so they agree again.

---

## 1. Pedagogical principles

The simulator exists to teach concepts, not to be a physics engine. Every
design decision follows from that.

1. **Organise around fundamental concepts.** Each tab is one idea: the
   hardware, the object, the sequence, contrast, k-space, reconstruction,
   artifacts, spectroscopy. Each opens with a short concept card: the idea in
   two or three sentences, the one equation that matters, and "try this"
   experiments.
2. **Artifacts must emerge from their mechanism.** Wherever possible an
   artifact appears because the cause is simulated (a field offset, motion
   between phase-encode lines, a gradient delay), not because a picture was
   pasted on. Then the artifact behaves correctly when students change TR,
   bandwidth, phase-encode direction or k-space ordering, which is the whole
   point. The only injected artifacts are hardware faults that have no
   upstream cause in the model (spike, zipper).
3. **Honest simplifications, stated plainly.** Where the model is simplified
   (one coherence pathway, ideal spoiling, 2D object), say so in the UI where a
   careful student would otherwise be misled. Never claim more than the model
   does.
4. **Don't overwhelm.** Tabs, collapsible `<details>` for advanced controls,
   sensible defaults that already make a good image, and no control without a
   reason to touch it.
5. **One field strength: 3 T.** Larmor frequency 127.73 MHz. Fat-water shift
   3.4 ppm, about 434 Hz.
6. **Units are part of the lesson.** The DSL makes students write units, and
   the UI always shows them.

---

## 2. Files and load order

```
nbl425/demos/mri_simulator/
  index.html          page shell: header, scan bar, tab bar, tab panels, script tags
  style.css           design system shared by every tab
  ARCHITECTURE.md     this file
  js/core.js          namespace, constants, FFT, RNG, bus, canvas helpers   (written)
  js/tissues.js       3 T tissue and metabolite library
  js/phantoms.js      phantom builders
  js/fields.js        B0 field map, B1 map, receive coil sensitivities
  js/dsl.js           pulse-sequence language: lexer, parser, compiler, waveform helpers
  js/presets.js       library of sequences written in the DSL
  js/engine.js        imaging acquisition simulator
  js/recon.js         reconstruction
  js/spectro.js       spectroscopy simulator and processing
  js/ui/widgets.js    shared UI components (sliders, plots, image views, concept cards)
  js/ui/timing.js     pulse-sequence timing diagram component
  js/ui/*.js          one file per tab (scanner, phantom, sequence, contrast,
                      kspace, image, artifacts, spectro, lessons)
  js/app.js           shell: state, actions, scan/playback loop, tab bar; boots the page
  tests/harness.js    loads classic scripts into Node for testing    (written)
  tests/test_*.js     one per module; `node tests/run_all.js` runs them all
```

`index.html` loads, in this order: `core, tissues, phantoms, fields, dsl,
presets, engine, recon, spectro, ui/widgets, ui/timing, ui/scanner,
ui/phantom, ui/sequence, ui/contrast, ui/kspace, ui/image, ui/artifacts,
ui/spectro, ui/lessons, app`. All are classic `<script src>` tags (no
`type="module"`, no `defer` needed since they sit at the end of `<body>`), so
the page works from `file://`. No external libraries and no CDN.

### Coding conventions

- Each file is one IIFE: `(function (root) { 'use strict'; const MRI = root.MRI; ... })(typeof window !== 'undefined' ? window : globalThis);`
  Modern JS (const/let, arrow functions, classes, template strings) is fine.
- Non-UI modules (`tissues` through `spectro`) **must not touch the DOM at load
  or in their APIs**, so they run under `tests/harness.js` in Node. Only
  `js/ui/*` and `app.js` touch the DOM.
- Internal units are SI: s, m, T, T/m, T/m/s, Hz. Flip angles and RF phases are
  degrees. Chemical shift is ppm. Never store milliseconds.
- Complex data is always two separate arrays `re`, `im` (Float32Array or
  Float64Array). 2D arrays are row-major, `index = iy * nx + ix`.
- Match the comment density of `core.js`: explain *why*, especially the
  physics, in plain sentences. No banner art, no emoji.
- Use commas or parentheses rather than em dashes in any user-visible text.
- Every random process takes a seed (`MRI.util.rng(seed)`) so the same
  settings reproduce the same image.

---

## 3. Constants, coordinates and the signal equation

`MRI.const` (in core.js): `GAMMA_BAR` 42.577478e6 Hz/T, `B0` 3 T, `F0`
127.73 MHz, `GMAX` 0.045 T/m, `SLEW` 200 T/m/s, `GRAD_RASTER` 10 us,
`WATER_PPM` 4.7, `FAT_PPM` -3.4 (fat relative to water), `FAT_HZ` about
-434 Hz, `PPM_HZ` about 127.7 Hz.

**Coordinates.** x runs left to right on screen, y runs top to bottom (same
direction as image rows). For any sampled axis of n points with spacing d,
index i sits at coordinate `(i - floor(n/2)) * d`. This holds for phantom
rasters, reconstructed images and k-space grids alike, so k = 0 is at index
floor(n/2). `MRI.util.fft2c / ifft2c` implement exactly this convention.
In the brain phantom anterior is at the top (small y, negative y) and the
patient's right is on the image left (radiological convention).

**Signal equation.** With phantom points r, transverse magnetisation m(r)
(complex, already contrast weighted), off-resonance Δf(r) in Hz and the
coherence-pathway state k(t) (cycles/m) and dephasing clock τ(t) (s):

    s(t) = Σ_r  m(r) · C_c(r) · exp(-i 2π [ k(t)·r + Δf(r) τ(t) ]) · dA · (Δz / 5 mm)

C_c is the receive sensitivity of coil c, dA the phantom pixel area, Δz the
slice thickness. `MRI.util.fft2c` uses the same sign, so an object shifted by
+x gives phase −2π k x.

**Image scaling.** Reconstruction multiplies the inverse FFT by
`nx·ny·Δkx·Δky` (equivalently divides by the grid FOV area), so a uniform
object with m = 1 imaged with a 5 mm slice and a uniform unit coil
reconstructs to 1.0. Truth images and reconstructions therefore share units
and can be subtracted.

**Noise.** Complex white Gaussian noise is added to every ADC sample of every
coil with standard deviation `σ = NOISE_REF · noiseScale · sqrt(1/dwell) /
sqrt(averages)`. `NOISE_REF` is calibrated (engine test) so that a
128×128, 240 mm, 5 mm, 250 Hz/px, readout-oversampled acquisition of a uniform
m = 1 object with a single uniform coil gives image noise σ = 0.01 (SNR 100).
SNR then scales correctly with voxel volume, √(sampling time) and √NEX
without any special-casing.

---

## 4. core.js (written)

`MRI.const`, `MRI.util` (clamp, lerp, linspace, sinc, isPow2, nextPow2,
`rng(seed)` with `.randn()`, percentile, `fft(re, im, inverse)` any length,
`fft2`, `fftshift2/ifftshift2/fftshift1`, `fft2c/ifft2c` centred 2D returning
`{re, im}` Float64Arrays, `fmtNum/fmtTime/fmtFreq/fmtLen/fmtGrad`,
`colormaps` + `colormapLUT(name)` for gray, hot, phase, diverging, viridis,
`setupCanvas(canvas, cssW?, cssH?)`, `drawImage(canvas, data, nx, ny, opts)`,
`cssVar(name, fallback)`, `el(tag, attrs, children)`, `debounce`,
`yieldFrame()`), `MRI.bus` (`on/off/emit`), `MRI.ui.registerTab(def)`,
`MRI.ui.tabs`, `MRI.ui.addStyle(css)`.

---

## 5. tissues.js

```js
MRI.tissues = {
  library: { <id>: Tissue, ... },   // every tissue any phantom uses
  get(id) -> Tissue (a copy),
  metabolites: { <id>: Metabolite, ... },
  lipidLines: [ {ppm, frac} ... ]    // fat spectrum, fractions sum to 1
};
Tissue = {
  id, name, color,                // color: CSS hex used in label maps and plots
  pd,                             // proton density relative to pure water = 1
  t1, t2, t2s,                    // seconds; t2s <= t2 always
  cs,                             // imaging chemical shift, ppm relative to water (fat: -3.4, else 0)
  pulsatile: bool,                // flows/pulsates (vessels)
  enhances: bool,                 // takes up gadolinium (lesion, vessel)
  spectrum: {                     // for the spectroscopy simulator
    water: fraction of pd that is water (1 for most, 0 for pure fat),
    lipid: fraction of pd that is lipid (fat tissue 1, else 0),
    metabolites: { NAA: mM, Cr: mM, ... }
  }
}
Metabolite = { id, name, color, t1, t2, lines: [ {ppm, nH, J?: Hz, mult?: 'd'|'q'} ] }
```

Values at 3 T (seconds). These are teaching values from the literature; round
numbers are fine.

| id | name | pd | t1 | t2 | t2s | cs | notes |
|---|---|---|---|---|---|---|---|
| air | Air | 0 | 1 | 0.001 | 0.001 | 0 | no signal; label 0 everywhere |
| wm | White matter | 0.70 | 0.85 | 0.075 | 0.050 | 0 | NAA 9, Cr 6, Cho 2.0, mI 5, Glu 7, Gln 2, Lac 0.4 mM |
| gm | Grey matter | 0.80 | 1.35 | 0.095 | 0.060 | 0 | NAA 11, Cr 8.5, Cho 1.5, mI 6, Glu 10, Gln 3, Lac 0.5 |
| csf | CSF | 1.00 | 4.0 | 1.8 | 0.40 | 0 | water only |
| fat | Fat (scalp, orbit) | 0.90 | 0.38 | 0.068 | 0.035 | -3.4 | lipid only |
| marrow | Skull marrow (diploë) | 0.80 | 0.42 | 0.060 | 0.020 | -3.4 | lipid 0.8, water 0.2 |
| bone | Cortical bone | 0.05 | 0.25 | 0.0006 | 0.0004 | 0 | effectively black |
| muscle | Muscle | 0.75 | 1.40 | 0.032 | 0.025 | 0 | Cr 25, Cho 2 |
| vessel | Blood (sinus, arteries) | 0.85 | 1.65 | 0.10 | 0.040 | 0 | pulsatile, enhances |
| lesion | Lesion (demyelination/tumour) | 0.85 | 1.60 | 0.18 | 0.10 | 0 | enhances; NAA 4, Cr 5, Cho 4, mI 6, Lac 5 |
| water | Doped water | 1.00 | 1.00 | 0.25 | 0.15 | 0 | phantom fill |
| oil | Vegetable oil | 0.90 | 0.28 | 0.080 | 0.040 | -3.4 | lipid only |
| braino | MRS phantom solution | 1.00 | 1.50 | 0.30 | 0.15 | 0 | NAA 12.5, Cr 10, Cho 3, mI 7.5, Glu 12.5, Lac 5 |
| vial01..vial12 | Relaxometry vials | 1.00 | see below | see below | 0.6·t2 | 0 | water only |

Vials (t1 / t2, s): 0.20/0.020, 0.30/0.040, 0.45/0.060, 0.60/0.080,
0.80/0.100, 1.00/0.150, 1.30/0.200, 1.60/0.300, 2.00/0.400, 2.50/0.600,
3.00/1.00, 4.00/2.00.

Metabolites (3 T; ppm; nH = protons in that group):

| id | lines | t1 | t2 |
|---|---|---|---|
| NAA | 2.008 (3), 2.49 (1), 2.67 (1), 4.38 (1) | 1.40 | 0.25 |
| Cr | 3.027 (3), 3.913 (2) | 1.30 | 0.15 |
| Cho | 3.20 (9) | 1.20 | 0.22 |
| mI | 3.52 (2), 3.61 (2), 4.05 (1), 3.27 (1) | 1.10 | 0.20 |
| Glu | 2.04 (1), 2.12 (1), 2.34 (2), 3.74 (1) | 1.20 | 0.18 |
| Gln | 2.11 (2), 2.44 (2), 3.76 (1) | 1.20 | 0.18 |
| Lac | 1.31 (3, doublet J 6.93 Hz), 4.10 (1, quartet J 6.93 Hz) | 1.50 | 0.24 |

Lipid lines (fraction of lipid protons): 0.90 (0.09), 1.30 (0.60), 1.59
(0.06), 2.02 (0.08), 2.24 (0.06), 2.75 (0.02), 4.20 (0.04), 5.30 (0.05).
Lipid t1 0.38 s, t2 0.07 s. Water protons: 2 per molecule, pure water
55.5 M, so water proton concentration = 111 M × pd × water fraction.

Gadolinium: `MRI.tissues.withGad(tissue, conc)` returns a copy whose relaxation
rates are increased by r1 = 4, r2 = 5 per mM per s when `enhances` is true:
`1/T1' = 1/T1 + r1·C`, likewise T2 and T2* (T2* gets the r2 term).

---

## 6. phantoms.js

```js
MRI.phantoms = {
  list() -> [ {id, name, description, hasSpectra: bool} ],
  build(id, opts) -> Phantom,          // cached by (id, JSON(opts))
};
opts = { n: 256 | 512, lesion: bool, gad: mM (0..1), overrides: { <tissueId>: {pd?, t1?, t2?, t2s?} } }
Phantom = {
  id, name, description,
  n,                     // raster is n × n
  fov,                   // physical width of the raster, metres (0.28 for all phantoms)
  dx,                    // fov / n
  label: Uint8Array(n*n),// index into tissues[]; 0 is air
  tissues: [Tissue],     // tissues[0] is air; overrides and gadolinium already applied
  dB0: Float32Array(n*n),// intrinsic susceptibility field offset in Hz (scaled by the
                         // B0 settings later); 0 where label is air is fine
  landmarks: [ {name, x, y} ],   // metres, for UI annotation (e.g. "frontal sinus")
  notes: string
}
```

Phantoms (all on a 0.28 m raster; build both n = 256 and n = 512 from the
same analytic geometry so they agree, and anti-alias nothing: labels are hard,
the fine raster provides partial volume when imaged):

1. **brain**: axial slice through the lateral ventricles. Head outline about
   160 mm (L-R) × 200 mm (A-P). From outside in: scalp fat (3-5 mm), thin
   muscle (temporalis, laterally), outer table of bone, marrow (diploë), inner
   table, CSF in the subarachnoid space, cortical grey matter as a ribbon
   2.5-3 mm thick following a folded boundary (radius modulated by a sum of
   sinusoids so there are sulci with CSF in them), white matter, lateral
   ventricles (two crescent/butterfly CSF shapes), caudate heads and thalami
   (grey matter), the superior sagittal sinus (vessel, posterior midline, and
   a smaller one anterior), and the frontal sinus (air) in the frontal bone at
   the anterior midline. With `lesion: true` add three periventricular plaques
   and one 12 mm lesion in the right frontal white matter. `dB0`: the frontal
   sinus produces a dipole-like field up to about +120 Hz in the adjacent
   orbitofrontal tissue, decaying over 15-20 mm, plus a weaker
   offset near the ears laterally (about ±40 Hz). Zero elsewhere.
2. **shepp**: modified Shepp-Logan head (the classic ellipses), with each
   ellipse mapped to a tissue: outer ellipse marrow/fat skull, brain wm, the
   ellipses grey matter / csf / lesion. dB0 zero.
3. **resolution**: 200 mm water disk (doped water) containing four bar groups
   (bar widths 4, 3, 2, 1.5 mm; five bars each, gaps equal to bar width), a
   square grid of thin 1 mm walls (air) at 20 mm pitch in one quadrant for
   geometric distortion, and a 30 mm air hole. dB0 zero.
4. **relax**: twelve 25 mm vials (vial01..vial12) on a 4 × 3 grid inside a thin
   plastic (air) holder, labelled with their T1/T2 in `landmarks`. dB0 zero.
5. **waterfat**: 180 mm doped-water disk with a 10 mm fat (oil) ring around it,
   one 40 mm oil vial inside the water and one 40 mm water vial embedded in
   the oil ring region (a small bulge), for chemical shift and fat
   suppression. A weak linear dB0 (±30 Hz across the object) so fat
   saturation is visibly imperfect at one edge when the shim is degraded.
6. **braino**: 160 mm sphere-section disk of `braino` solution (MRS phantom),
   `hasSpectra: true`. dB0 zero.

Every phantom has `hasSpectra: true` in the sense that the spectroscopy
simulator can use it (water, lipid and metabolites come from the tissue
library), but `braino` and `brain` are the two the Spectroscopy tab offers by
default.

---

## 7. fields.js

```js
MRI.fields = {
  b0Map(phantom, b0) -> Float32Array(n*n) Hz      // excludes chemical shift
  b1Map(phantom, b1) -> Float32Array(n*n)         // transmit scale, 1 = nominal
  coilSet(type) -> CoilSet
  coilMaps(coilSet, nx, ny, fovX, fovY) -> { re: [Float32Array], im: [Float32Array] }
};
b0 = { susceptibility: 1, shim: 0 }   // susceptibility scales phantom.dB0 (0..3);
                                      // shim adds a residual first+second order field:
                                      //   shim * (25 Hz per 100 mm in x, -15 Hz per 100 mm in y,
                                      //           +40 Hz * (r/100 mm)^2 quadratic) - make it look plausible
b1 = { amount: 0 }                    // 3 T dielectric effect: b1 = 1 + amount*(0.6 - (r/90mm)^2) clipped
                                      // to [0.4, 1.6]; centre bright, periphery dark. amount 0..0.5
CoilSet = { type: 'body'|'head8', n, names: [..], positions: [{x, y}], radius }
```

- `body`: one coil, sensitivity 1 everywhere, phase 0.
- `head8`: eight loops evenly spaced on an ellipse of semi-axes 105 × 125 mm
  around the head. Magnitude like a loop coil, |C| ∝ 1 / (1 + (d/a)²)^1.5
  with d the distance to the loop and a ≈ 60 mm, plus a smooth phase that
  varies across the FOV (a linear phase of about 1 rad across the head, a
  different direction per coil). Normalise all maps together so that the
  root-sum-of-squares over coils averages 1.0 within a 70 mm radius of the
  centre.
- `coilMaps` evaluates at pixel centres using the section 3 convention. The
  engine calls it on the phantom raster; recon calls it on the image grid for
  SENSE and Roemer combination (the simulator knows the true maps; the UI says
  that a real scanner measures them in a short calibration scan).

### 7.1 Interactive shimming (round 2 extension of fields.js)

Students shim the magnet themselves. The field the engine and the
spectroscopy simulator see is

    b0(r) = susceptibility · phantom.dB0(r) + shim · residual(r) + Σ_i shimCoeffs_i · basis_i(r)

`residual(r)` is the un-shimmed field after the patient is loaded: a fixed
pattern of low-order terms (a constant frequency offset of about +25 Hz, X, Y,
XY, X²−Y² and Z2, tens of Hz across the head), so a perfect set of shim
currents can cancel it exactly while the local sinus field in `dB0` stays.
That is the lesson: shims remove smooth fields, not local susceptibility
fields.

```js
b0 = { susceptibility: 1, shim: 0,
       shimCoeffs: { z0: 0, x: 0, y: 0, xy: 0, x2y2: 0, z2: 0 } }   // Hz at the 100 mm reference radius
MRI.fields.shimTerms -> [ { id, name, order, fn(x, y) } ]     // in-plane (z = 0) basis, R = 0.1 m:
    // z0: 1 (the centre-frequency adjustment), x: x/R, y: y/R, xy: 2xy/R², x2y2: (x²−y²)/R², z2: −(x²+y²)/R²
MRI.fields.autoShim(phantom, b0, { region: 'object'|'center', radius: 0.06 }) ->
    { shimCoeffs, rmsBefore, rmsAfter }     // least squares over non-air points in the region,
                                            // weighted by pd; returns the coefficients that ADD to the
                                            // existing ones to minimise the field variance
MRI.fields.fieldStats(phantom, b0Map, { region, radius }) ->
    { mean, sd, fwhmHz, hist: { centers: Float32Array, counts: Float32Array } }   // pd-weighted
```

Defaults keep `shim: 0` and zero coefficients (a well-shimmed scanner). The
"Start unshimmed" button sets `shim: 1` and zeroes the coefficients. Any
cache keyed on the B0 settings must include `shimCoeffs`. The Shim panel
lives in the Spectroscopy tab (sliders per term, Auto-shim with region
choice, Reset, a live field map, a field histogram, an estimated water FWHM
and the water line itself, updating as the sliders move), and the shim coils
in the Scanner schematic link to it.

---

## 8. The pulse-sequence language (dsl.js)

### 8.1 What it looks like

```
# Spin echo
sequence "Spin echo"

param TR  = 3000 ms  range 300 ms .. 6000 ms   "repetition time"
param TE  = 90 ms    range 12 ms .. 200 ms     "echo time"
param FOV = 240 mm   range 120 mm .. 320 mm    "field of view"
param N   = 128      range 32 .. 256 step 32   "matrix size"
param BW  = 150 Hz/px range 50 Hz/px .. 1000 Hz/px "readout bandwidth per pixel"

fov FOV
matrix N
slice 5 mm
bandwidth BW
dummies 2

for line in 0 .. N-1 every TR
    rf 90 slice as exc                        # excitation, defines time zero for TE
    gz rephase, gx -prephase, gy -encode line  # before the 180 both lobes take the opposite sign: the 180 flips them
    rf 180 slice phase 90 at exc + TE/2       # refocusing pulse half way to the echo
    gx readout, adc at exc + TE               # echo centred at TE
    spoil
end
```

### 8.2 Lexical rules

- One statement per line. `#` starts a comment. Blank lines ignored.
  Indentation is cosmetic (blocks close with `end`).
- Numbers: `12`, `0.5`, `1e-3` (no leading `.`). A number may be followed,
  with or without a space, by a unit: time `s ms us µs`; length `mm cm`;
  angle `deg rad` (rad converts to degrees); frequency `Hz kHz MHz Hz/px`;
  gradient `mT/m T/m`; slew `T/m/s`; `ppm`. Units attach only to number
  literals, so `pi*s/spokes` uses a variable `s`. Unit names are reserved
  for `param` and `let` names but allowed as loop variables.
- Strings: `"..."`. Identifiers: `[A-Za-z_][A-Za-z0-9_]*`.
- Operators: `+ - * / ^ ( ) , = ..`. `^` is power (right associative, binds
  tighter than unary minus: `-2^2 = -4`, write `(-1)^line`).
- Reserved words (cannot be variable names): `sequence param let fov matrix
  slice bandwidth oversample averages dummies for in repeat every step end
  wait spoil rf gx gy gz adc at as range for dur phase bw offset dwell hard
  sinc water fat adiabatic excite refocus invert saturate readout prephase
  encode rewind rephase crush blip` plus all unit names. (`for` is both the
  loop keyword and the `<amp> for <dur>` gradient form; the parser knows
  which from position.)

### 8.3 Values and dimensions

Every value carries a number in SI and a kind: `none, time, length, angle,
freq, grad, slew, ppm, mixed`. Arithmetic rules: `+ -` need equal kinds
(else error "cannot add 20 ms and 5 mm" / "cannot add a time and a plain
number; did you forget a unit?"); `none*X = X`, `X/none = X`, `none/time =
freq`, `none/freq = time`, `time*freq = none`, other products and quotients of
two non-none kinds give `mixed`. Functions `sin cos tan sqrt abs floor ceil
round min max mod exp log` take and return `none` (min/max/abs/round/floor/
ceil/mod keep the kind of their argument). Constants: `pi`, `f0` (freq,
127.73 MHz). After `matrix`, `Nx` and `Ny` are defined (none).

Where a statement expects a kind it accepts that kind, or `none` only where a
default unit is natural: flip angles and RF phases (degrees), counts. A plain
number where a time is required is an error with the hint "write 20 ms".

### 8.4 Statements

| statement | meaning |
|---|---|
| `sequence "Title"` | name shown in the UI |
| `param NAME = expr [range lo .. hi] [step s] ["description"]` | tunable value; becomes a slider. Range/step in the same units. Without range, the UI offers a number box |
| `let NAME = expr` | derived constant |
| `fov X [Y]` | field of view along x and y (length). Default 240 mm square |
| `matrix NX [NY]` | image matrix. Default 128 square |
| `slice T` | slice thickness (length). Default 5 mm |
| `bandwidth B` | readout bandwidth per pixel (freq, Hz/px). Default 250 Hz/px |
| `oversample K` | readout oversampling factor (1 or 2, default 2). The recon crops it |
| `averages K` | NEX; scales noise by 1/√K and scan time by K |
| `dummies K` | run the first iteration of the outermost `every` loop K extra times first, with the ADC off, to reach steady state |
| `for v in A .. B [step S] [every T]` … `end` | loop, inclusive bounds, integer values. `every T` starts iteration k at loopStart + k·T (a "period", i.e. a TR) |
| `repeat K [every T]` … `end` | loop without a variable |
| a **block** | one line of events that start together, see below |
| `wait D` | a block that is only a delay |

**Blocks.** A block is one or more events separated by commas, with optional
suffixes `at T` and `as LABEL` (in either order) at the end of the line:

```
gz rephase, gx prephase, gy encode line
gx readout, adc at exc + TE
rf 90 slice as exc
```

Events in a block start at the block's start time, except that an ADC that
shares a block with a `readout` gradient is aligned to that gradient's flat
top, and an RF `slice` pulse's own slice-select gradient ramps up before the
pulse. Block duration is the longest event. Two events on the same gradient
axis in one block is an error (`rf … slice` occupies gz).

**Timing.** Without `at`, a block starts when the previous block ends. With
`at T`, the block's **anchor** is placed at time T measured from the start of
the current period (the innermost enclosing `every` iteration, or the start of
the sequence). The anchor is: the RF centre if the block has an RF pulse;
otherwise the echo (centre sample, index floor(n/2)) if it has an ADC riding
a `readout` gradient; otherwise the first sample if it has a bare ADC;
otherwise the block start. If an anchored block would start before the
previous block ends, that is an error that names how much time is missing and
which parameter to change, e.g. "TE = 8 ms is too short: this readout must
start at 4.10 ms but the previous block ends at 5.32 ms. Increase TE by at
least 1.22 ms (minimum TE about 9.2 ms)." Use the parameter names that appear
in the `at` expression in the hint.

**Labels.** `as exc` names the block's anchor. In expressions a label
evaluates to that anchor time, as a `time`, measured from the start of the
current period. Labels are reassigned every iteration.

**Periods.** For an `every T` loop, if an iteration's last block ends after
the next period would start, error: "TR = 20 ms is too short: each repetition
needs 27.4 ms." After the loop the cursor moves to the end of the last
period.

### 8.5 Events

**RF.** `rf FLIP [shape/selectivity] [role] [dur D] [phase P] [bw B] [offset F]`

- `FLIP` is an angle (deg default). Shapes and selectivity:
  `hard` (rectangular, non-selective, default dur 0.5 ms),
  `slice` (sinc, time-bandwidth product 4, default dur 2 ms; adds a
  slice-select gradient on gz: amplitude = (4/dur) / (γ̄ · thickness), flat for
  the pulse duration, ramps outside it),
  `water` / `fat` (Gaussian spectrally selective pulse centred on water (0 Hz)
  or fat (FAT_HZ), default dur 20 ms, bw (FWHM) default 1.6/dur, no gradient),
  `adiabatic` (non-selective hyperbolic secant inversion, default dur 10 ms,
  B1-insensitive). `sinc` is an alias of `slice`.
- `offset F` shifts the RF frequency (Hz or ppm) from the default centre.
- Role: `excite | refocus | invert | saturate`. If omitted it is inferred:
  `water`/`fat` shapes are `saturate`; flip ≥ 135° is `refocus` when an
  excitation has happened earlier in the current period with no `spoil`
  since, else `invert`; everything else is `excite`.

**Gradients.** `gx|gy|gz SPEC [* expr]`, or with a leading minus, `gx -readout`.

| SPEC | area / shape |
|---|---|
| `AMP for DUR` | explicit trapezoid: flat amplitude AMP (grad), flat duration DUR; ramps added at the slew limit |
| `readout` | flat top = ADC duration n·dwell; amplitude G = N·BW/(γ̄·FOV) for that axis; error if > GMAX |
| `prephase` | −(ramp-up area + G·floor(n/2)·dwell) of the readout on that axis, so the centre sample is at k = 0 |
| `encode L` | (L − floor(N/2))·Δk/γ̄ for that axis, Δk = 1/FOV; every `encode` on an axis uses the same timing (shortest trapezoid for the largest area) and scales amplitude |
| `rewind L` | minus `encode L` |
| `rephase` | minus the slice-select area after the RF centre (half the flat area plus the ramp-down area) |
| `crush` | area for 2 cycles across the slice: 2/(γ̄·thickness) |
| `blip` | Δk/γ̄ for that axis (EPI) |

`* expr` scales the amplitude and keeps the timing of the unscaled spec, so
`gx readout * cos(th), gy readout * sin(th)` is a straight radial spoke and
`gx readout * (-1)^line` keeps every EPI echo the same length. Shortest
trapezoids: triangle when |A| ≤ GMAX²/SLEW, else trapezoid at GMAX. Round
rise/flat up to the 10 us gradient raster and recompute amplitude to keep the
area exact.

**ADC.** `adc [N] [dwell D]`. In a block with a `readout` gradient the
defaults are n = N·oversample along the readout axis and dwell =
1/(BW·N·oversample), and the ADC sits on the flat top. Without a readout
(spectroscopy) `N` and `dwell` are required and the ADC starts at block start.

**Spoil.** `spoil` is a block (alone on its line): trapezoids of area
4/(γ̄·thickness) on gx, gy and gz, and an ideal-spoiling instant at its end
(all transverse magnetisation destroyed).

### 8.6 Compile API and output

```js
MRI.dsl = {
  compile(source, opts) -> SeqProgram,  // opts: { overrides: {NAME: valueSI}, maxEvents }
  setParamInSource(source, program, name, valueSI) -> newSource,
  tokenize(source) -> [ {type, text, line, col, start, end} ],   // for syntax highlighting
  keywords: { statements: [...], events: [...], options: [...], units: [...] },
  gradientAt(program, axis, t) -> T/m,           // nominal waveform
  gradientArea(program, axis, tA, tB) -> T·s/m,  // exact integral of trapezoids
  reference: string                              // short language reference (markdown-ish HTML)
};
SeqProgram (ok) = {
  ok: true, name, source,
  params: [ { name, value, kind, unit, scale, min, max, step, description, line, span: [start, end] } ],
     // value SI; unit = display unit as written (e.g. 'ms'); scale = SI per display unit
     // span = character offsets of the value expression in source (setParamInSource replaces it)
  lets: { NAME: value },
  image: { fovX, fovY, nx, ny, thickness, bwPerPixel, oversample, readoutAxis: 'x'|'y'|'radial'|null,
           averages, dummies, hasImaging },
  system: { B0, gammaBar, f0, gmax, slew },
  rf:   [ { t, t0, dur, flip, phase, shape: 'hard'|'sinc'|'gauss'|'sech', select: 'slice'|'none'|'water'|'fat',
            role: 'excite'|'refocus'|'invert'|'saturate', bw, offsetHz, label, block, line, period, dummy } ],
  grad: { x: [Trap], y: [Trap], z: [Trap] },     // each axis sorted by t0, non-overlapping
     // Trap = { t0, rise, flat, fall, amp (T/m, signed), tag, block, line }
     // tag: 'readout'|'prephase'|'encode'|'rewind'|'slice'|'rephase'|'crush'|'spoil'|'blip'|'manual'
  adc:  [ { t0, n, dwell, tc, anchor: 'center'|'start', dummy, block, line, period, vars: {..loop vars} } ],
     // sample j at t0 + j*dwell; tc = t0 + floor(n/2)*dwell
  spoil: [ { t } ],
  blocks: [ { t0, dur, anchorT, label, line, kinds: ['rf','gx',..], period, dummy } ],
  periods: [ { t0, dur, index, vars, dummy } ],    // outermost every-loop iterations; one
                                                   // pseudo-period [0, duration] if there is none
  duration, scanTime,                               // scanTime = duration * averages
  stats: { TR, nAdc, nSamples, gmaxUsed, readoutDuration, echoSpacing },
  warnings: [ { line, msg } ]
}
SeqProgram (failed) = { ok: false, source, errors: [ { line, col, msg, hint } ], params: [...as far as parsed] }
```

All times are absolute seconds from the start of the sequence, quantised to
1 us. Limits: at most 20 000 blocks and 8 192 non-dummy ADCs (error past
that). `compile` must be fast: a 256-line spin echo in well under 50 ms.

### 8.7 Presets (presets.js)

`MRI.presets = [ { id, name, group: 'imaging'|'spectroscopy', summary, source } ]`
and `MRI.presets.get(id)`. The ids below are referenced by other modules and
the lessons, so keep them. Every imaging preset uses the parameter names
`TR TE FOV N BW` (plus `flip TI ETL ESP NEX spokes` where they apply) so
lessons and artifact cards can set them.

| id | sequence | defaults |
|---|---|---|
| `first` | "Your first sequence": minimal spoiled GRE, every line commented | 64², TR 100 ms, TE 5 ms, flip 30° |
| `gre_t1` | spoiled gradient echo, T1-weighted | TR 250 ms, TE 2.5 ms, flip 70°, 128² |
| `gre_t2s` | spoiled gradient echo, T2*-weighted | TR 600 ms, TE 20 ms, flip 20° |
| `se` | spin echo (default preset, T2-weighted) | TR 3000, TE 90 |
| `se_t1` | spin echo, T1-weighted | TR 500, TE 12 |
| `stir` | inversion-recovery spin echo, fat-nulling | TR 3000, TI 230, TE 30 |
| `flair` | inversion-recovery turbo spin echo, CSF-nulling | TR 9000, TI 2400, ETL 16, ESP 10 ms |
| `tse` | turbo spin echo, linear ordering | TR 3000, ETL 16, ESP 10 ms (TEeff about 90 ms) |
| `epi` | single-shot gradient-echo EPI | 64², FOV 220 mm, BW 2000 Hz/px, ESP 0.8 ms, TE 30 ms |
| `se_epi` | single-shot spin-echo EPI | as epi, TE 60 ms |
| `radial` | radial spoiled GRE | 128 spokes |
| `gre_pf` | GRE with 5/8 partial Fourier | lines 3N/8 .. N−1 |
| `gre_r2` | GRE, every other line (R = 2) for SENSE | step 2 |
| `gre_fatsat` | GRE with a spectral fat-saturation pulse | |
| `fid` | pulse-acquire FID, hard pulse, no gradients | TR 3000, delay 0.25 ms, SW 4000 Hz, NP 2048, NA 16 |
| `fid_ws` | CHESS water suppression then pulse-acquire | as fid |

Presets are part of the teaching: comment them as a careful instructor would,
one short comment per non-obvious line.

---

## 9. Imaging engine (engine.js)

```js
MRI.engine = {
  simulate(program, phantom, ctx, opts) -> Promise<AcqData>,
  tissueEvolution(program, phantom, opts) -> Evolution,
  NOISE_REF
};
ctx  = { b0Map, b1Map, coilSet, coilMaps /* on the phantom raster */, artifacts }
opts = { onProgress(frac), shouldAbort() -> bool, seed }
```

### 9.1 Model

1. **Spin classes.** Points are grouped into classes = (tissue, B1 bin, Δf
   bin). B1 bins: 9 bins of the B1 map (1 bin when the map is uniform). Δf
   bins: only when the program contains spectrally selective RF; 16 bins of
   the total off-resonance (B0 + chemical shift); else 1 bin.
2. **Magnetisation tracker.** Walk the time-ordered RF, spoil and ADC events
   once. Per class keep Mz (M0 = 1) and the amplitude Mxy of the single
   coherence pathway that the sequence is designed to refocus. Between events:
   `Mz = 1 − (1 − Mz)·exp(−dt/T1)`, `Mxy *= exp(−dt/T2)`. At an RF pulse with
   flip α scaled by the class B1 (not for `adiabatic`) and by the spectral
   profile for `water`/`fat` (Gaussian of the given FWHM around the pulse
   frequency): `excite`: Mxy = Mz·sin α, Mz = Mz·cos α (previous transverse
   magnetisation assumed spoiled); `refocus`: Mxy *= sin²(α/2), Mz = Mz·cos α;
   `invert` and `saturate`: Mz = Mz·cos α. `spoil`: Mxy = 0. Global pathway
   state: k (nominal and true) and the dephasing clock τ; `excite` resets both
   to 0, `refocus` negates both, time advances τ and gradients advance k by
   γ̄∫G dt. This one-pathway model is the stated simplification: it gives
   correct SE, GRE, IR, TSE and EPI contrast and echo timing, but not
   stimulated echoes or balanced SSFP.
3. **Class amplitude at each ADC centre:** `a = pd · Mxy · exp(−|τ|/T2')`,
   with `1/T2' = max(0, 1/T2* − 1/T2)`. Signed real, made complex only by flow
   modulation.
4. **Signal synthesis per readout.** Fast path when every gradient is constant
   over the ADC window (all named readouts): the k-trajectory is a straight
   line k = k_c + g·(t − t_c), g = γ̄G, and off-resonance becomes a shift
   along the readout, u(r) = ĝ·r + Δf(r)/|g|. Per readout and coil, form
   `c(r) = a_class · C(r) · exp(−i2π k_c·r) · exp(−i2π Δf(r) τ_c)`, splat it
   with linear interpolation onto a 1D grid of M bins (power of 2, bin width
   δu = 1/(M·Δκ) ≤ dx/2, wrapped modulo M, which is exact for the sampled
   κ_j = (j − floor(n/2))·Δκ), FFT, pick the n samples and divide by
   sinc²(κ_j δu) to undo the interpolation kernel. Precompute separable
   exp(−i2π k_c·r) factors per readout and cache the off-resonance phasor per
   distinct τ_c. General path otherwise (ADC on ramps, curved trajectories):
   direct summation per sample on a raster reduced to at most 128²; warn
   that it is slower. A no-gradient ADC (spectroscopy sequence) is an error
   for the imaging engine: "This sequence has no spatial encoding. Use the
   Spectroscopy tab."
5. **Off-resonance** Δf(r) = b0Map + tissue.cs·PPM_HZ.
6. **Through-plane dephasing.** The object is 2D, but real susceptibility
   fields also vary across the slice. Each point's signal is multiplied by
   sinc(Gz·Δz·τ), with Gz taken as the magnitude of the in-plane gradient of
   the B0 map (non-air neighbours, chemical shift excluded). That is what
   makes gradient-echo dropout near the sinus grow with TE and slice
   thickness while spin echoes (τ = 0 at the echo) are immune.
7. **Recon sees nominal k only.** AcqData carries the nominal trajectory (what
   the scanner believes). Physical imperfections change the signal, never the
   nominal k, which is exactly why they cause artifacts.

### 9.2 Artifacts (ctx.artifacts)

```js
artifacts = {
  noise: 1,                                  // multiplies NOISE_REF; 0 = noiseless
  motion: { on: false, kind: 'periodic'|'sudden'|'random'|'nod', amp: 0.004 /* m or rad*/,
            period: 4.0 /* s */, at: 0.5 /* fraction of scan for 'sudden' */, axis: 'y'|'x' },
  flow:   { on: false, depth: 0.6, period: 0.9 /* s, cardiac */, phase: 1.5 /* rad, velocity phase */ },
  b0:     { susceptibility: 1, shim: 0 },    // passed to fields.b0Map
  b1:     { amount: 0 },                     // passed to fields.b1Map
  gradDelay: 0,                              // s; true gradients lag nominal ones (EPI Nyquist ghost)
  spike:  { on: false, amp: 4, at: 0.37 },   // one corrupt sample, fraction of scan
  zipper: { on: false, offsetHz: 3000, amp: 0.002 }, // RF interference at f0 + offset
  transient: false                           // reserved
}
```

- Motion: rigid transform per readout from the ADC's absolute time.
  `periodic`: translation amp·sin(2πt/period) along `axis`; `sudden`: step of
  amp at fraction `at` of the scan; `random`: seeded jitter of amplitude amp per
  readout; `nod`: rotation amp (radians, e.g. 0.05) · sin(2πt/period) about the
  centre. Implement as k_c ← Rᵀk_c, ĝ ← Rᵀĝ and multiply samples by
  exp(−i2π k_j·d).
- Flow: classes of `pulsatile` tissues are multiplied by
  (1 + depth·sin 2πt/period)·exp(i·phase·sin 2πt/period).
- Gradient delay δ: true k_c = nominal k_c − g·δ for each readout.
- Spike: add amp × (typical k-centre magnitude) to one sample of every coil.
- Zipper: add amp × (k-centre magnitude) × exp(−i2π·offsetHz·t + iφ_line) to
  every sample, φ_line random per readout (seeded).
- Noise as section 3.

### 9.3 AcqData

```js
AcqData = {
  program, phantomId, coilSet, nCoils, seed,
  grid: { nx, ny, fovX, fovY, readoutAxis, oversample },    // from program.image
  readouts: [ {
      index, t0, tc, dwell, n, period,
      tExc,                         // time of the excitation this readout belongs to
      te,                           // tc - tExc
      kx, ky: Float32Array(n),      // NOMINAL k, cycles/m
      re: [Float32Array(n) per coil], im: [Float32Array(n) per coil],
      vars                          // loop variables of the ADC
  } ],
  truth: { nx, ny, fovX, fovY, data: Float32Array },   // ideal image: class amplitudes of the
          // readout nearest k = 0, rendered on the phantom raster and box-averaged to the image grid
  stats: { scanTime, computeMs, teEff, nReadouts, fatShiftPx: {readout, phase}, bwPerPixel,
           peBandwidthPerPixel (EPI), signalScale },
  warnings: [string]
}
```

`readouts` excludes dummies and is in acquisition order.

### 9.4 tissueEvolution

For the Contrast tab: run the tracker for each tissue of the phantom at
nominal B1 and the tissue's own chemical shift, recording on a time grid
(≈ 2000 points across the first `periods` periods, default 4, plus the
steady-state period containing the k-centre readout) and at every ADC:

```js
Evolution = { tissues: [{id, name, color}], t: Float32Array, mz: [Float32Array], mxy: [Float32Array],
              events: [ {t, kind: 'rf'|'adc'|'spoil', role?, flip?} ],
              adc: [ {t, te, amp: Float32Array(nTissues)} ],    // signed class amplitude a
              center: { index, te, amp: Float32Array(nTissues) } }   // readout nearest k = 0
```

### 9.5 Performance targets

`se` 128² with the 8-channel coil on a 256² phantom: under 1.5 s on a laptop;
`epi` 64²: under 0.5 s. Yield (`await MRI.util.yieldFrame()`) every ~30 ms
and report progress. Choose phantom raster n = 256 when max(nx, ny) ≤ 128,
else 512 (the app passes the right phantom).

---

## 10. Reconstruction (recon.js)

```js
MRI.recon = { run(acq, opts, { upTo }) -> ReconResult, defaults };
opts = {
  filter: 'none'|'hamming'|'hann'|'tukey'|'fermi', filterParam: 0.5,
  zeroFill: 1|2,
  partialFourier: 'zero'|'conjugate'|'homodyne',
  parallel: 'none'|'sense',               // SENSE applied only when regular undersampling is detected
  coilCombine: 'sos'|'roemer'|'single', coil: 0,
  densityComp: true,                      // non-Cartesian only
  epiGhostCorr: false,
  cropOversampling: true,
  userMask: null                          // optional Uint8Array on the k-space grid (k-space tab edits)
};
ReconResult = {
  kspace: { nx, ny, dkx, dky, re: [Float32Array per coil], im: [...], mask: Uint8Array,
            tmap: Float32Array /* te of each sample, NaN if empty */, order: Float32Array /* readout index */ },
  coilImages: { nx, ny, re: [..], im: [..] },     // after crop
  image: { nx, ny, fovX, fovY, re, im, mag: Float32Array },
  gfactor: Float32Array | null,
  info: { cartesian, undersampling: R, partialFourier: fraction, notes: [string] }
}
```

Pipeline: place samples on the nominal Cartesian grid (Δk = 1/(FOV·os) along
the readout axis) when ≥ 99 % of samples fall on grid points, otherwise grid
with a Kaiser-Bessel kernel (width 4, 2× oversampled grid) plus density
compensation (analytic |k| for radial, else a few Pipe-Menon iterations),
then deapodise. Detect partial Fourier (a contiguous block of missing ky
lines on one side) and regular undersampling (every R-th line). Apply
partial-Fourier handling, k-space filter, zero-fill, inverse FFT
(`MRI.util.ifft2c`) with the scaling of section 3, SENSE unfolding along the
phase axis with the true coil maps (Cartesian only; also return the g-factor
map), crop the readout oversampling, combine coils. EPI ghost correction
(when `epiGhostCorr` and the readouts alternate polarity) estimates the
constant and linear phase difference between odd and even echoes from the
data and removes it. `upTo` reconstructs from only the first `upTo` readouts
(used during playback). `run` is synchronous and must take under 100 ms for
128² × 8 coils.

---

## 11. Spectroscopy (spectro.js)

```js
MRI.spectro = {
  simulate(program, phantom, ctx, opts) -> SpecData,     // ctx: { b0Map, artifacts } ; opts: { seed }
  process(spec, p) -> Spectrum,
  defaults: { lb: 1, gb: 0, zf: 2, ph0: 0, ph1: 0, autoPhase: true, refPpm: 4.7, display: 'real' }
};
SpecData = { n, dwell, sw, delay /* first sample after excitation centre */, nTransients,
             fid: { re, im },                          // averaged over transients, with noise
             components: [ { id, name, color, re, im } ], // noise-free per species group (water, lipid, NAA, ...)
             noiseSigma, info: { waterSuppression, linewidthHz, notes: [] } }
Spectrum  = { n, hz: Float64Array, ppm: Float64Array, re, im, mag,
              components: [ { id, name, color, re } ],
              peaks: [ { id, name, ppm, height, area } ], metrics: { snr, fwhmHz, ratios: {NAA_Cr, Cho_Cr} } }
```

Model: non-selective excitation covers the whole phantom. For each tissue,
histogram the total off-resonance (b0Map) of its points into bins of ≈ 0.5 Hz
weighted by area. Species are water, lipid lines and metabolite lines with
proton concentrations from section 5, each line at
`(ppm − 4.7)·PPM_HZ` relative to the carrier. Track Mz per (species, bin)
through every RF event of the program with T1 recovery, flip scaled by the
spectral profile (Gaussian for `water`/`fat` pulses, essentially flat for a
0.1 ms hard pulse), `spoil` destroying transverse magnetisation. Each
non-dummy ADC records a transient
`Σ amplitude · exp(+i2π f t) · exp(−t/T2)` from the excitation centre, with an
extra Lorentzian broadening of 3 Hz in tissue (1 Hz in braino) for
unresolved susceptibility, plus noise; transients are averaged. Lactate is a
doublet (and its quartet) with J = 6.93 Hz. Processing: exponential (lb, Hz)
and Gaussian (gb) apodisation, zero-fill ×zf, FFT, fftshift, phase
`ph0 + ph1·(f/1000)` degrees with f in Hz (ph1 in deg/kHz), autoPhase that
sets ph1 from the known acquisition delay (−360°·delay·f) and ph0 by
maximising the real part of the tallest peak. ppm axis = 4.7 + f/PPM_HZ,
displayed with ppm increasing to the left. Report SNR (height of the NAA
peak, or of the tallest peak when there is no NAA, over the noise SD of the
real spectrum measured in the outermost 15 % of the spectral width on the
downfield side, which holds no signal), FWHM of the tallest peak, and
NAA/Cr and Cho/Cr from integrals over 1.9-2.1, 2.95-3.1 and 3.15-3.27 ppm.

---

## 12. User interface

### 12.1 Layout (index.html + style.css + app.js)

- Header: "← Back to Course Home" (`../../index.html`), title "MRI Simulator",
  subtitle "A teaching scanner at 3 T — write a sequence, image a phantom,
  watch k-space fill", a theme toggle (auto / light / dark; stored in
  localStorage inside try/catch; sets `data-theme` on `<html>`).
- **Scan bar** (sticky under the header): Acquire button (▶), Stop, speed
  select (Instant, Fast ≈ 4 s, Slow ≈ 15 s), a progress bar, a one-line
  summary ("Spin echo · Brain · 128×128 · TR 3000 ms · TE 90 ms · scan
  6:24 min"), an "Auto re-scan" checkbox (default on), and two small
  thumbnails (k-space and image) that jump to their tabs.
- **Tab bar** built from `MRI.ui.tabs` sorted by `order`, with `role=tablist`,
  arrow-key navigation, and the active tab remembered (localStorage + URL
  hash `#tab=<id>`).
- Design tokens follow the other NBL 425 demos: `--bg --fg --muted --accent
  --card --border` plus `--scope-bg --good --bad --warn`, light and dark via
  `prefers-color-scheme` with a `[data-theme]` override. System sans-serif.
  Images and scopes sit on near-black whatever the theme. Max width about
  1280 px; works down to 360 px wide with a 16 px gutter and no horizontal
  page scroll (tab bar may scroll horizontally).

Tabs (id, order, title):
`lessons` 0 Guide · `scanner` 10 Scanner · `phantom` 20 Phantom · `sequence`
30 Sequence · `contrast` 40 Contrast · `kspace` 50 k-space · `image` 60
Image · `artifacts` 70 Artifacts · `spectro` 80 Spectroscopy.
Default tab on first visit: `lessons`.

### 12.2 Tab definition

```js
MRI.ui.registerTab({ id, title, order, mount(panelEl), onShow(), onHide() });
```
`mount` runs once, after app.js has created state and actions. Each tab
injects its own CSS with `MRI.ui.addStyle()`, every rule scoped under
`#tab-<id>`. Tabs redraw on `onShow` (canvases sized while hidden have zero
width) and on window resize.

### 12.3 State and actions (app.js)

```js
MRI.state = {
  phantomId: 'brain', phantomOpts: { lesion: false, gad: 0, overrides: {} },
  presetId: 'se', source, program, compileErrors: [],
  artifacts: { ...defaults of 9.2 },
  coilType: 'head8',
  recon: { ...MRI.recon.defaults },
  acq: null, reconResult: null, scanning: false, autoRescan: true, speed: 'fast',
  spectro: { presetId: 'fid', source, program, compileErrors, phantomId: 'braino',
             processing: { ...MRI.spectro.defaults }, data: null, spectrum: null }
};
MRI.actions = {
  getPhantom(n?) -> Phantom,         // built for the current phantom/options at raster n
                                     // (default: 256 or 512 from the current program's matrix)
  getFields(phantom) -> { b0Map, b1Map, coilSet, coilMaps },
  setPhantom(id, opts?), setPhantomOpts(patch),
  loadPreset(id), setSource(text), setParam(name, valueSI),
  setArtifacts(patch /* deep merge */), resetArtifacts(), setCoil(type),
  setRecon(patch), reconstruct(),
  runScan({ animate }) -> Promise, stopScan(),
  showTab(id),
  spectro: { loadPreset(id), setSource(text), setParam(name, v), setPhantom(id), setProcessing(patch), run() }
};
```

Changing phantom, source/params, artifacts or coil triggers a debounced
(250 ms) instant re-scan when `autoRescan` is on and the program compiled.
`setRecon` only re-runs the reconstruction.

Bus events (payloads in braces):
`phantom:changed {phantom}` · `program:compiled {program, errors}` ·
`artifacts:changed {artifacts}` · `coil:changed {coilType}` ·
`scan:start {animate}` · `scan:progress {frac, stage: 'compute'|'playback'}` ·
`playback:tick {t, frac, readoutsDone, rf, grad: {x, y, z}, adcOn, period}` ·
`scan:done {acq}` · `scan:error {message}` · `recon:done {result, partial}` ·
`tab:shown {id}` · `spectro:compiled {program, errors}` · `spectro:done {data, spectrum}` ·
`theme:changed {dark}`.

**Playback.** After `engine.simulate` finishes, an animated scan maps sequence
time onto wall time (Fast: whole scan in about 4 s; Slow: about 15 s), emits
`playback:tick` every animation frame, reveals readouts in acquisition order,
and re-runs the reconstruction on the readouts so far every ~200 ms
(`recon:done` with `partial: true`), so the image visibly builds up as k-space
fills. Instant skips straight to the end.

### 12.4 Shared widgets (ui/widgets.js)

`MRI.ui.w = { concept({title, body, formula, tryThis: [..]}) -> element,
slider({label, min, max, step, value, unit, scale, format, onInput, onChange}),
select({label, options: [{value, label}], value, onChange}),
toggle({label, checked, onChange}), segmented({options, value, onChange}),
imageView(container, {title, cmap, wl: true}) -> {setData(data, nx, ny, opts), canvas, onHover(fn)},
plot(container, {height, xlabel, ylabel}) -> {draw(series, opts)},
statTable(rows) -> element, toast(msg, kind) }`.
`plot.draw(series=[{x, y, color, label, dash, width}], {xlim, ylim, reverseX,
markers: [{x, label, color}], legend: true})`. `imageView` supports window
and level by dragging (horizontal = width, vertical = level), double-click to
reset, and a hover readout.

### 12.5 The tabs

- **Guide (lessons.js)**: a short welcome ("how to use this simulator"), then
  lessons, each with a goal, a "Set up" button that configures phantom, preset,
  parameters, artifacts and recon options and switches to the right tab, a
  numbered list of things to try and questions to answer, and a one-line
  takeaway. Lessons: 1 The scanner and the Larmor frequency; 2 From FID to
  echo: what one k-space line is; 3 k-space: centre is contrast, edges are
  detail; 4 FOV, matrix, resolution and aliasing; 5 T1, T2 and PD weighting
  with spin echo; 6 Inversion recovery: nulling CSF and fat; 7 Gradient echo,
  T2* and susceptibility; 8 Chemical shift and fat suppression; 9 Fast
  imaging: turbo spin echo and EPI; 10 Motion and flow; 11 Hardware faults:
  spikes, zipper and Nyquist ghosts; 12 Reconstruction choices: filtering,
  partial Fourier, SENSE; 13 Spectroscopy: chemical shift, water suppression,
  shimming (start unshimmed, shim by hand, then auto-shim, and see what the
  shims cannot fix).
- **Scanner (scanner.js)**: an SVG schematic of the 3 T system: magnet room
  (Faraday cage) with the cryostat and superconducting coil, shim coils,
  gradient coils, RF body coil, bore, patient table and receive head coil;
  equipment room with the sequencer (pulse program), gradient amplifiers
  (x, y, z), RF synthesiser and modulator, RF power amplifier, T/R switch,
  preamplifiers, demodulator and ADC, reconstruction computer and operator
  console; signal-flow arrows. Hover highlights, click shows a panel (what it
  does, 3 T numbers, what goes wrong when it fails, which artifact it
  causes). During playback, components light up from `playback:tick` (RF
  chain during RF, the right gradient amplifier with a level bar, the receive
  chain while the ADC is on). A Larmor calculator (f = γ̄(B0 + G·x)) and a
  receive-coil selector (body / 8-channel head) that calls `setCoil`. Clicking
  the shim coils offers a link to the Shim panel (section 7.1). A "follow
  the signal" stepper that walks the chain in order.
- **Phantom (phantom.js)**: phantom picker cards with thumbnails, options
  (lesion, gadolinium dose), a map viewer (tissue labels with legend, PD, T1,
  T2, T2*, total off-resonance in Hz with current B0 settings, B1, coil
  sensitivity per coil, coil RSS), a tissue table with editable T1/T2/T2*/PD
  (writes `phantomOpts.overrides`, with reset).
- **Sequence (sequence.js + timing.js)**: preset picker (imaging presets), the
  DSL editor (textarea over a highlighted `<pre>`, line numbers, error line
  marked, Tab inserts spaces), compile errors with clickable line numbers,
  auto-generated parameter sliders, the timing diagram (rows RF, Gz, Gy, Gx,
  ADC with role labels, a faint phase-encode ladder, TE/TR/TI annotations,
  a period selector and a draggable cursor), the k-space trajectory for the
  shown period with all periods faint behind it, a "spin phase" grid that
  shows the phase each gradient has wound across the FOV at the cursor time
  (k·r), a stats table (TR, TE measured, TI, voxel size, BW/px, readout
  duration, echo spacing, scan time, peak gradient used), and a collapsible
  language reference. `MRI.ui.timing.create(container, opts)` returns
  `{setProgram(p), setPeriod(i), setWindow(t0, t1), setCursor(t), onCursor(fn)}`
  and is reused by the Spectroscopy tab and the playback cursor.
- **Contrast (contrast.js)**: Mz and |Mxy| curves per tissue across the first
  periods (from `tissueEvolution`), the steady-state signal of each tissue at
  the k-centre readout as a bar chart, contrast-to-noise between chosen
  tissues, and a sweep plot: pick any declared parameter, sweep it over its
  range by recompiling with `overrides`, plot each tissue's signal, mark the
  current value. The textbook equation for the detected family (spoiled GRE,
  SE, IR) shown next to the simulated values.
- **k-space (kspace.js)**: the gridded k-space (log magnitude, phase, real,
  imaginary) per coil, acquired-sample mask, trajectory overlay, a "time since
  excitation" map (shows effective TE, TSE T2 weighting and EPI time
  ordering), hover readout (kx, ky in 1/mm, TE, readout index), click a point to
  see its spatial-frequency wave, editing tools (keep centre, remove centre,
  keep one half, brush) with a live preview reconstruction and reset, and a
  profile of the ky = 0 line. Fills progressively during playback.
- **Image (image.js)**: reconstruction controls (all of `MRI.recon.defaults`
  as labelled controls; advanced ones in `<details>`), the reconstructed image
  with window/level, display mode (magnitude, phase, real, imaginary), truth
  and difference panels, coil images, g-factor map when SENSE runs, a profile
  through a chosen row, ROI statistics and SNR (signal ROI / background SD),
  and recon notes.
- **Artifacts (artifacts.js)**: one card per artifact: noise and SNR, aliasing,
  Gibbs ringing, chemical shift (displacement and in/out of phase), B0
  inhomogeneity and susceptibility (distortion, dropout, SE vs GRE), EPI
  Nyquist ghost, motion, pulsatile flow, RF spike, zipper, B1 (dielectric)
  shading, coil shading, partial Fourier and undersampling, T2 and T2*
  blurring in echo trains, missing dummy scans. Each card: controls (if it has
  any), "What you see", "Why", "Where it lives in k-space", "How to fix", and a
  "Show me" button that sets up a demonstration and re-scans.
- **Spectroscopy (spectro.js)**: its own preset picker (`fid`, `fid_ws`) and
  compact DSL editor with parameter sliders and timing diagram, phantom picker
  (braino, brain, waterfat), FID plot (real/imag/magnitude), spectrum plot
  (ppm axis reversed, 0-5 ppm default with a full-width option, component
  overlay), processing controls, peak table and metrics, and a concept card on
  chemical shift (δ = (f − f_ref)/f_ref × 10⁶), spectral width = 1/dwell,
  resolution = 1/acquisition time, linewidth = 1/(πT2*), why water must be
  suppressed, and why non-selective excitation of a head is dominated by scalp
  lipid (the reason localisation exists).
  Also the Shim panel of section 7.1.

---

## 13. Testing

Node, no dependencies: `node tests/run_all.js`. Each non-UI module ships
`tests/test_<module>.js` using `tests/harness.js`. Browser testing uses the
globally installed Playwright (`require('/opt/node22/lib/node_modules/playwright')`,
Chromium at `/opt/pw-browsers`, do not run `playwright install`), serving the
repo with `npx http-server` or loading `file://` directly, failing on any
console error, and writing screenshots to the session scratchpad, not the
repo.

---

## 14. Implementation notes (round 1)

Agreed details that the first round of modules added to the contract. Tab
authors in particular need these.

- **Slider scale.** `MRI.ui.w.slider({scale})` means *display units per SI
  unit* (1000 for a TE slider in ms), with min/max/step/value in SI. The DSL's
  `program.params[i].scale` is the opposite (SI per display unit). Build a
  slider from a DSL parameter with `siPerUnit: p.scale`, never `scale: p.scale`.
- **Programs that fail.** `state.program` is the latest compile result and can
  have `ok: false`; `state.lastGoodProgram` is the most recent one that
  compiled. Tabs check `program.ok`.
- **Merges.** `setArtifacts` deep-merges; `setPhantomOpts`, `setRecon` and
  `spectro.setProcessing` are shallow (pass `overrides` whole).
- **Extra actions and events.** `setAutoRescan(bool)`, `setSpeed(mode)`,
  `MRI.app.{isDark(), activeTab(), playbackSeconds}`. `scan:error` carries
  `{message, stage, aborted?, tab?}`; `spectro:error {message}` exists.
  `playback:tick` also carries `t0, duration, readouts`; within a frame `rf`
  is the pulse active at `t` or the last one played, `grad` the signed peak.
- **Presets.** Spin-echo presets write `gy -encode line` before the 180.
  `tse` and `flair` have no `TE` parameter: their effective TE is
  `(ETL/2 + 1)·ESP`, available as `program.stats.TE`; set `ESP` to change it.
  ETL must divide N. Some slider corners do not compile on purpose; the error
  names the minimum, and the UI keeps the last good program.
- **Program extras.** `adc.axis`, `stats.TE` (echo time of the readout nearest
  k = 0), `stats.TI`, `MRI.dsl.formatParam(param, valueSI)`. Events outside any
  `every` loop have `period: -1` when the program also has `every` loops.
- **Phantoms.** `list()` marks `hasSpectra` true for brain, braino and
  waterfat. `b0Map` is 0 in air; `b1Map` is not masked (mask by label for
  display). Shepp-Logan always contains lesion ellipses. Extras:
  `MRI.fields.rss`, `MRI.tissues.waterProtons`, `MRI.phantoms.clearCache`.
- **Engine.** `truth.data` is signed (negative where Mz was still inverted):
  compare `|truth|` with magnitude images. `tissueEvolution` omits air, adds
  `segments` and `center.t`; `mxy` is signed, plot its absolute value.
  `stats.fatShiftPx` is signed; `stats.path` is 'fast', 'general' or 'mixed'.
- **Recon.** Defaults are `partialFourier: 'homodyne'` and `parallel:
  'sense'` (both only act when partial Fourier or undersampling is detected).
  `kspace.tmap` is per-sample time since excitation. With SENSE the combined
  image is the unfolded solution and `coilImages` stay folded. With
  undersampling and `parallel: 'none'` the folded image is scaled by R. SENSE
  at R = 4 with the head8 model has a large g-factor (mean about 3), so
  lessons use R = 2 or 3.
- **Spectroscopy.** `SpecData.delay` is the chemical-shift evolution time at
  the first sample; `SpecData.te` is excitation centre to first sample.
  `info.linewidthHz` is the FWHM of fully relaxed, unsuppressed whole-object
  water, also available live as `MRI.spectro.waterLine(phantom, ctx)` for the
  Shim panel. `metrics.ratios` integrate fixed windows (the 1.9-2.1 ppm window
  also catches Glu at 2.04 ppm); `metrics.componentRatios` are per-metabolite
  and should be shown alongside. The unsuppressed spectrum carries a real
  dead-time baseline offset; use the peaks' `baseline` when zooming.
  `process` ignores `p.display`; the UI picks re, im or mag.
