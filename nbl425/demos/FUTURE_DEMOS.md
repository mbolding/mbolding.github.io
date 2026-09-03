# NBL 425/625: Future Interactive Demo Roadmap

This document catalogs proposed interactive simulations and educational tools for **NBL 425/625: Methods in Human Neuroimaging**. These demos are designed to be self-contained (HTML5 Canvas + vanilla JavaScript) matching the clean, responsive design language of the existing course simulators.

---

## 1. Functional MRI & Experimental Design (Weeks 04 & 05)

### [COMPLETED] fMRI GLM Design Matrix & Convolution Studio
* **Target File**: `nbl425/demos/glm_studio.html`
* **Core Concepts**:
  * Block designs vs. rapid event-related designs.
  * Canonical double-gamma Hemodynamic Response Function (HRF) convolution.
  * General Linear Model ($Y = X\beta + \epsilon$) matrix construction.
  * Noise models: low-frequency scanner drift (<0.01 Hz), physiological oscillations (~0.2 Hz), and thermal Gaussian noise.
  * Ordinary Least Squares (OLS) parameter estimation ($\hat{\beta} = (X^T X)^{-1} X^T Y$), contrast vectors ($c^T \beta$), and $t$-statistic maps.
* **Key Interaction**:
  * Drag and place stimulus blocks or event impulses on an interactive timeline.
  * Toggle collinearity / jittering to observe how overlapping trials impact detection power vs. estimation efficiency.

### [COMPLETED] EPI Geometric Distortion & Susceptibility Dropout Simulator
* **Target File**: `nbl425/demos/epi_distortion.html`
* **Course Week**: Week 03 (Structural MRI & Contrast) & Week 04 (fMRI)
* **Core Concepts**:
  * Macroscopic magnetic field gradients ($\Delta B_0$) at air-tissue boundaries (paranasal sinuses and mastoid air cells/ear canals).
  * Low phase-encoding bandwidth in single-shot Echo Planar Imaging (EPI).
  * Directional pixel shifts: $\Delta y = \gamma \Delta B_0 / BW_{\text{PE}}$.
  * Spin-dephasing and intra-voxel signal dropout in orbitofrontal cortex and inferior temporal lobes.
* **Key Interaction**:
  * Cross-sectional head slice with adjustable sinus cavity size and $B_0$ field strength (1.5T, 3T, 7T).
  * Phase-encoding direction toggle: Anterior-to-Posterior (A&rarr;P) vs. Posterior-to-Anterior (P&rarr;A).
  * Bandwidth slider ($BW_{\text{PE}}$) showing geometric compression vs. stretching.
  * "Blip-up / Blip-down" TOPUP distortion correction tool unwarping the distorted EPI image.

---

## 2. Diffusion Tensor Imaging & Connectomics (Week 06)

### DTI Tensor & Deterministic Tractography Explorer
* **Target File**: `nbl425/demos/dti_tractography.html`
* **Course Week**: Week 06 (Diffusion Tensor Imaging)
* **Core Concepts**:
  * Stejskal-Tanner pulsed diffusion gradients applied across $\ge 6$ non-collinear directions.
  * Fitting the $3 \times 3$ symmetric diffusion tensor matrix:
    $$D = \begin{bmatrix} D_{xx} & D_{xy} & D_{xz} \\ D_{xy} & D_{yy} & D_{yz} \\ D_{xz} & D_{yz} & D_{zz} \end{bmatrix}$$
  * Eigenvalue decomposition ($\lambda_1 \ge \lambda_2 \ge \lambda_3$) and principal eigenvector orientation.
  * Fractional Anisotropy (FA) and Mean Diffusivity (MD).
  * Directional color sphere: Red = Left/Right, Green = Anterior/Posterior, Blue = Superior/Inferior.
  * Deterministic streamline propagation (Euler / Runge-Kutta).
  * **The Crossing Fiber Problem**: Oblate/planar tensors in intersection zones causing false tract termination.
* **Key Interaction**:
  * Rotatable 3D tensor ellipsoid responding to gradient measurements.
  * Synthetic 2D slice with crossing white matter bundles (e.g. Corpus Callosum crossing Corticospinal Tract).
  * Interactive seed points: click anywhere on the slice to launch deterministic streamlines.
  * Sliders for FA stopping threshold and angular curvature turning limits.

---

## 3. Positron Emission Tomography (Week 07)

### PET Pharmacokinetics & 2-Tissue Compartment Simulator
* **Target File**: `nbl425/demos/pet_compartment.html`
* **Course Week**: Week 07 (Positron Emission Tomography)
* **Core Concepts**:
  * Intravenous tracer bolus and Arterial Input Function (AIF, $C_p(t)$).
  * 1-tissue compartment model (perfusion / $^{15}\text{O}$-water) vs. 2-tissue compartment model ($^{18}\text{F}$-FDG or neuroreceptor binding).
  * Microscopic kinetic rate constants:
    * $K_1$: Delivery from plasma to free tissue compartment across BBB ($\text{mL} \cdot \text{g}^{-1} \cdot \text{min}^{-1}$)
    * $k_2$: Efflux clearance from tissue back to plasma ($\text{min}^{-1}$)
    * $k_3$: Metabolic phosphorylation (hexokinase) or receptor binding ($\text{min}^{-1}$)
    * $k_4$: Dephosphorylation or receptor dissociation ($\text{min}^{-1}$)
  * Time-Activity Curves (TACs) for free ($C_1(t)$), trapped/bound ($C_2(t)$), and total detected activity ($C_{\text{total}}(t)$).
  * Graphical analysis methods:
    * **Patlak plot** for irreversible tracers ($k_4 = 0$): slope $= K_i$ (net metabolic influx).
    * **Logan plot** for reversible receptor tracers: slope $= V_T$ (total distribution volume).
* **Key Interaction**:
  * Sliders for $K_1, k_2, k_3, k_4$ and injection bolus shape.
  * Real-time dynamic compartment animation showing tracer molecules moving between vessels, interstitial space, and intracellular enzyme/receptor pools.
  * Synchronized Patlak/Logan linearization plot demonstrating quantification of glucose metabolism or receptor availability.

---

## 4. Electrophysiology: EEG & MEG (Weeks 08 & 09)

### EEG Forward Problem & Scalp Potential Mapper
* **Target File**: `nbl425/demos/eeg_forward_model.html`
* **Course Week**: Week 08 (Electroencephalography)
* **Core Concepts**:
  * Cortical pyramidal cell palisade and equivalent current dipoles (ECD).
  * 3-shell concentric spherical head model:
    * Brain ($r_1, \sigma_{\text{brain}} \approx 0.33\text{ S/m}$)
    * Skull ($r_2, \sigma_{\text{skull}} \approx 0.0042\text{ S/m}$, high electrical resistivity $\approx 1:80$)
    * Scalp ($r_3, \sigma_{\text{scalp}} \approx 0.33\text{ S/m}$)
  * Analytical Poisson forward solution for electrostatic potentials on the scalp surface.
  * Scalp isopotential topomap (red positive / blue negative lobes).
  * Spatial blurring caused by skull volume conduction.
  * The Inverse Problem: non-uniqueness and ill-posed source estimation.
* **Key Interaction**:
  * Interactive 2D head cross-section and 2D scalp surface map (10-20 system).
  * Click to position and rotate a dipole in cortical gray matter.
  * Instantaneous rendering of the bipolar scalp potential map.
  * Slider for skull resistivity showing how high skull resistance blurs fine cortical dipole features.

### EEG vs. MEG: Radial vs. Tangential Dipole Sensitivity
* **Target File**: `nbl425/demos/eeg_vs_meg_dipoles.html`
* **Course Week**: Week 09 (Magnetoencephalography) & Week 08 (EEG)
* **Core Concepts**:
  * Tangential currents in sulcal banks vs. radial currents on gyral crests.
  * Biot-Savart Law and spherical conductor magnetic fields:
    * For a spherically symmetric volume conductor, a purely **radial current dipole produces zero external magnetic field** ($B_r = 0$).
    * Only tangential current components generate detectable external magnetic fields.
  * Electrical volume conduction vs. magnetic transparency of the skull.
* **Key Interaction**:
  * Anatomy cross-section showing a sulcus and adjacent gyrus.
  * Dipole orientation angle slider ($\theta: 0^\circ \text{ radial} \to 90^\circ \text{ tangential}$).
  * Dual meter: Electric potential ($V_{\text{scalp}}$) vs. Magnetic flux density ($B_{\text{ext}}$).
  * Demonstrates why MEG is blind to gyral crests while EEG detects both, and why combining EEG+MEG provides complementary source coverage.

---

## 5. Optical Imaging (Week 10)

### fNIRS Modified Beer-Lambert Chromophore Unmixer
* **Target File**: `nbl425/demos/fnirs_unmixing.html`
* **Course Week**: Week 10 (Functional NIRS)
* **Core Concepts**:
  * The Near-Infrared optical window (650–900 nm).
  * Molar extinction spectra for Oxyhemoglobin ($\epsilon_{\text{HbO}}$) and Deoxyhemoglobin ($\epsilon_{\text{HbR}}$).
  * Isosbestic wavelength (~805 nm) where extinction coefficients cross.
  * Modified Beer-Lambert Law incorporating high scattering:
    $$\Delta A(\lambda) = \left[ \epsilon_{\text{HbO}}(\lambda) \Delta[\text{HbO}] + \epsilon_{\text{HbR}}(\lambda) \Delta[\text{HbR}] \right] \cdot d \cdot \text{DPF}(\lambda)$$
  * Solving the $2 \times 2$ matrix system to decouple $\Delta[\text{HbO}]$ and $\Delta[\text{HbR}]$ from dual-wavelength attenuation changes.
* **Key Interaction**:
  * Spectrum graph showing absorption curves and selectable laser wavelengths (e.g. 760 nm and 850 nm).
  * Physiological stimulus trigger producing functional hyperemia ($\Delta[\text{HbO}] \uparrow$, $\Delta[\text{HbR}] \downarrow$).
  * Real-time $2 \times 2$ matrix inversion calculator displaying raw optical densities and final chromophore concentrations.

---

## 6. Multi-Modal Integration (Week 12)

### Simultaneous EEG-fMRI Artifact Decontamination Workbench
* **Target File**: `nbl425/demos/eeg_fmri_decontamination.html`
* **Course Week**: Week 12 (Multi-Modal Integration)
* **Core Concepts**:
  * Imaging gradient artifacts: rapidly switched magnetic field gradients ($G_x, G_y, G_z$) induce millivolt-scale electromotive spikes in EEG leads via Faraday induction ($10^4 \times$ larger than $\mu\text{V}$ brain signals).
  * Ballistocardiogram (BCG) artifacts: pulsatile blood flow in the aortic arch causing microscopic head rotation and pulsatile scalp expansion inside static $B_0$.
  * Average Artifact Subtraction (AAS): synchronization with MRI scanner clock to generate template waveforms for gradient removal.
  * Principal Component Analysis (PCA) / Optimal Basis Sets (OBS) for BCG removal.
* **Key Interaction**:
  * Raw multi-channel EEG trace showing raw corrupted signals (gradient bursts + heartbeat pulses).
  * Interactive step-by-step filter pipeline:
    1. Raw signal (completely obscured).
    2. Apply AAS gradient filter &rarr; reveals BCG heartbeat pulses.
    3. Apply OBS/PCA BCG filter &rarr; unmasks the underlying visual evoked potential (P100 / N170).
