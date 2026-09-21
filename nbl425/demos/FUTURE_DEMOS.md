# NBL 425/625: Interactive Demo Portfolio & Roadmap

This document catalogs the interactive simulations and educational tools developed for **NBL 425/625: Methods in Human Neuroimaging**. All demos are self-contained (HTML5 Canvas + vanilla JavaScript) matching the clean, responsive design language of the course.

---

## 1. Functional MRI & Experimental Design (Weeks 04 & 05)

### [COMPLETED] fMRI GLM Design Matrix & Convolution Studio
* **Target File**: `nbl425/demos/glm_studio.html`
* **Course Weeks**: Week 04 (fMRI) & Week 05 (fMRI Experimental Design)
* **Core Concepts**:
  * Block designs vs. rapid event-related designs.
  * Canonical double-gamma Hemodynamic Response Function (HRF) convolution.
  * General Linear Model ($Y = X\beta + \epsilon$) matrix construction.
  * Noise models: low-frequency scanner drift (<0.01 Hz) and thermal Gaussian noise.
  * Ordinary Least Squares (OLS) parameter estimation ($\hat{\beta} = (X^T X)^{-1} X^T Y$), contrast vectors ($c^T \beta$), and $t$-statistic maps.
  * Physiological noise: respiration at 0.25 Hz plus a cardiac term at 1.1 Hz that is undersampled at TR = 0.5 s and aliases to 0.9 Hz.
  * Temporal autocorrelation as an AR(1) process, and Cochrane-Orcutt prewhitening of $Y$ and every column of $X$ to restore honest standard errors.
* **Key Interaction**:
  * Click the timeline to place stimulus blocks or event impulses (Shift+Click for the second condition).
  * Toggle collinearity / jittering to observe how overlapping trials impact detection power vs. estimation efficiency.
  * Switch the estimator between OLS and prewhitened GLM, and inspect the residual power spectrum against the task regressor's own spectrum.
  * **Null false-positive audit**: re-runs the current design 500 times with both task effects set to zero and counts how often each estimator claims $p < 0.05$. At $\rho = 0.6$ plain OLS rejects roughly a third of pure-noise datasets where it claims 5%; prewhitening brings it back near nominal.

### [COMPLETED] EPI Geometric Distortion & Susceptibility Dropout Simulator
* **Target File**: `nbl425/demos/epi_distortion.html`
* **Course Weeks**: Week 03 (Structural MRI & Contrast) & Week 04 (fMRI)
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

### [COMPLETED] fMRI Preprocessing Pipeline Workbench
* **Target File**: `nbl425/demos/preprocessing_pipeline.html`
* **Course Weeks**: Week 04 (fMRI) & Week 05 (fMRI Experimental Design)
* **Core Concepts**:
  * Rigid-body realignment by minimising the sum of squared intensity differences against a reference volume. Parameters are genuinely estimated, not read back from the simulation, so residual registration error is visible and never reaches zero.
  * Task-correlated head motion, the artifact that manufactures false activation exactly where the model is looking, contrasted with slow drift and spikes.
  * Motion parameters as nuisance regressors, and why they cost real signal when the motion is correlated with the design.
  * Interleaved slice acquisition across the TR, corrected by Hann-windowed sinc interpolation. Linear interpolation is deliberately avoided: it is a temporal low-pass filter that inflates tSNR and leaves autocorrelation behind, so the subsequent $t$-test is no longer calibrated.
  * Gaussian spatial smoothing and the matched filter theorem, using two activation foci of different extent so that no single kernel is right for both.
  * Discrete cosine high-pass filtering applied to the data **and** to the design matrix, including the failure mode where the cutoff period falls below the block period.
  * A noise model with both a spatially white thermal component and a spatially correlated physiological component, because a simulation with only white noise systematically flatters every spatial filter tested in it.
* **Key Interaction**:
  * Toggle each pipeline stage independently and watch peak $t$, tSNR, false-positive count and the "foci resolved" readout respond.
  * Compare applied against estimated motion parameters over the run.
  * Scrub or play through the volumes to see the motion directly.

---

## 2. Statistical Inference (Weeks 04 & 05)

### [COMPLETED] Whole-Brain Thresholding & the Multiple Comparisons Problem
* **Target File**: `nbl425/demos/whole_brain_inference.html`
* **Course Weeks**: Week 05 (fMRI Experimental Design)
* **Core Concepts**:
  * A real voxelwise GLM over an entire slice, with sufficient statistics accumulated volume by volume so the 4D data never has to exist at once.
  * Four thresholds compared side by side on the same map: uncorrected $\alpha$, Bonferroni, Benjamini-Hochberg FDR, and cluster extent.
  * Spatial smoothness of the noise as the quantity that decides how many independent tests were really performed, and therefore how conservative Bonferroni is.
  * Cluster-extent thresholds calibrated by Monte Carlo (200 null analyses, 95th percentile of the largest cluster) rather than assumed from random field theory, following the reasoning of Eklund, Nichols & Knutsson (2016).
  * The dead salmon (Bennett et al.): with $m$ in the thousands and $\alpha = 0.001$, a plausible-looking blob appears in null data in roughly half of all analyses.
* **Key Interaction**:
  * Switch the ground truth between three real activations and a pure null, and look at the uncorrected panel.
  * The Benjamini-Hochberg ladder plot, showing sorted $p$-values against the line $iq/m$ and where it is last satisfied.
  * The Monte Carlo null distribution of the largest cluster, with the calibrated threshold marked.
  * **Family-wise error audit**: 200 complete analyses of data containing nothing. Measured FWER is roughly 45% uncorrected against 3-5% for each of the three valid corrections.

### [COMPLETED] Group-Level Inference: Fixed vs. Random Effects
* **Target File**: `nbl425/demos/group_analysis.html`
* **Course Weeks**: Week 05 (fMRI Experimental Design) & Week 14 (Final Projects)
* **Core Concepts**:
  * The two-level structure of a group fMRI analysis, and the difference between within-subject measurement precision ($\sigma_w$) and between-subject variability ($\sigma_b$).
  * Fixed effects as precision-weighted pooling, and exactly how wrong it is: its $t$ is too large by $\sqrt{1 + \sigma_b^2/\sigma_w^2}$, which is only about 1.7 in a typical scenario and is precisely why the mistake survives review. That factor takes the false-positive rate from a claimed 5% to roughly 28%.
  * Random effects as a one-sample $t$-test on the $N$ first-level estimates, with $N - 1$ degrees of freedom as the honest price of a population claim.
  * The variance decomposition $\sigma_b^2 / (\sigma_b^2 + \sigma_w^2)$: the fraction of group-level variance that no amount of extra scanner time can touch.
  * What the summary-statistics approach assumes, and when FLAME or ReML style mixed-effects modelling is needed instead.
* **Key Interaction**:
  * A forest plot of every participant's estimate with its interval, against the two second-level intervals drawn from the same numbers.
  * Monte Carlo power curves against $N$ at half, current and double scan duration. When between-subject variance dominates the three curves collapse together and recruiting is the only lever; when measurement noise dominates they separate sharply.
  * **Validity audit**: 2000 complete studies with the group effect set to exactly zero. Random effects holds at 5%; fixed effects rises to 28% at typical $\sigma_b$ and 55% when subjects vary a lot.

---

## 3. Diffusion Tensor Imaging & Connectomics (Week 06)

### [COMPLETED] DTI Tensor & Deterministic Tractography Explorer
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
  * Synthetic 2D slice with crossing white matter bundles (Corpus Callosum crossing Corticospinal Tract).
  * Interactive seed points: click anywhere on the slice to launch deterministic streamlines.
  * Sliders for FA stopping threshold and angular curvature turning limits.

### [COMPLETED] Structural Connectome Matrix & Graph Theory Studio
* **Target File**: `nbl425/demos/connectome_graph.html`
* **Course Week**: Week 06 (Diffusion Tensor Imaging & Connectomics)
* **Core Concepts**:
  * Whole-brain tractography streamline clustering into $N \times N$ adjacency matrix $A_{ij}$.
  * Topological metrics: Characteristic path length ($L$), clustering coefficient ($C$), and small-worldness ($\sigma = \frac{C/C_{\text{rand}}}{L/L_{\text{rand}}} > 1$).
  * Community detection, modularity, and rich-club hub organization.
  * Targeted attack vulnerability vs. random damage resilience.
* **Key Interaction**:
  * Dual-panel view: 2D axial anatomical brain network diagram synchronized with an interactive $N \times N$ matrix heatmap.
  * Interactive attack simulation: compare random node knockout (diffuse injury) against targeted rich-club hub attack (precuneus/thalamus).
  * Real-time metric readouts for $L, C, \sigma$, and global efficiency $E_{\text{glob}}$.

---

## 4. Positron Emission Tomography (Week 07)

### [COMPLETED] PET Pharmacokinetics & 2-Tissue Compartment Simulator
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
  * Sliders for $K_1, k_2, k_3, k_4$, plasma glucose, and vascular volume fraction $V_b$.
  * Side-by-side Time-Activity Curves and Patlak/Logan linearization plots.

### [COMPLETED] PET Sinogram & Tomographic Reconstruction Workbench
* **Target File**: `nbl425/demos/pet_reconstruction.html`
* **Course Week**: Week 07 (Positron Emission Tomography)
* **Core Concepts**:
  * 511 keV coincidence detection and Line of Response (LOR) formation.
  * Radon transform ($p(s, \theta)$) and sinogram structure.
  * Filtered Backprojection (FBP) with Ram-Lak ramp and Hann window filters.
  * Maximum Likelihood Expectation Maximization (MLEM) iterative reconstruction.
  * 511 keV tissue photon attenuation correction ($\mu$-map).
* **Key Interaction**:
  * Interactive brain phantom editor: click to add hot tumors or lesions.
  * Real-time 2D sinogram generating intersecting sinusoidal wave patterns.
  * Side-by-side reconstruction comparing Unfiltered $1/r$ blur, FBP, and MLEM iterations.

---

## 5. Electrophysiology: EEG & MEG (Weeks 08 & 09)

### [COMPLETED] EEG Forward Problem & Scalp Potential Mapper
* **Target File**: `nbl425/demos/eeg_forward_model.html`
* **Course Week**: Week 08 (Electroencephalography)
* **Core Concepts**:
  * Cortical pyramidal cell palisade and Equivalent Current Dipoles (ECD).
  * 3-shell concentric spherical head model:
    * Brain ($r_1 = 0.85$, conductivity $\sigma_1 = 0.33\text{ S/m}$)
    * Skull ($r_2 = 0.92$, conductivity $\sigma_2 \approx 0.0042\text{ S/m}$, high electrical resistivity $\approx 1:80$)
    * Scalp ($r_3 = 1.00$, conductivity $\sigma_3 = 0.33\text{ S/m}$)
  * Analytical Poisson forward solution for electrostatic potentials on the scalp surface.
  * Scalp isopotential topomap (red positive / blue negative lobes).
  * Spatial blurring caused by skull volume conduction.
  * The Inverse Problem: non-uniqueness and ill-posed source estimation.
* **Key Interaction**:
  * Interactive 2D head cross-section and 2D scalp surface map (10-20 system).
  * Click and drag to position and rotate a dipole in cortical gray matter.
  * Instantaneous rendering of the bipolar scalp potential map.
  * Slider for skull resistivity showing how high skull resistance blurs fine cortical dipole features.

### [COMPLETED] EEG vs. MEG: Radial vs. Tangential Dipole Sensitivity
* **Target File**: `nbl425/demos/eeg_vs_meg_dipoles.html`
* **Course Week**: Week 09 (Magnetoencephalography) & Week 08 (EEG)
* **Core Concepts**:
  * Tangential currents in sulcal banks vs. radial currents on gyral crests.
  * Biot-Savart Law and spherical conductor magnetic fields:
    * For a spherically symmetric volume conductor, a purely **radial current dipole produces zero external magnetic field** ($B_r = 0$).
    * Only tangential current components generate detectable external magnetic fields.
  * Electrical volume conduction vs. magnetic transparency of the skull.
* **Key Interaction**:
  * Anatomy cross-section showing a sulcus and adjacent gyral crowns.
  * Dipole orientation angle slider ($\theta: 0^\circ \text{ radial} \to 90^\circ \text{ tangential}$).
  * Dual meter: Electric potential ($V_{\text{scalp}}$) vs. Magnetic flux density ($B_{\text{ext}}$).
  * Demonstrates why MEG is blind to gyral crests while EEG detects both, and why combining EEG+MEG provides complementary source coverage.

### [COMPLETED] EEG Inverse Problem & Source Localization Studio
* **Target File**: `nbl425/demos/eeg_inverse_solution.html`
* **Course Week**: Week 08 (Electroencephalography)
* **Core Concepts**:
  * Discrete leadfield operator $V = L J + \epsilon$ and underdetermined nullspace.
  * Tikhonov regularized Minimum Norm Estimation (MNE).
  * Depth-weighted wMNE to cancel superficial cortical bias.
  * Linearly Constrained Minimum Variance (LCMV) spatial beamforming.
* **Key Interaction**:
  * Click to place ground truth dipoles in superficial gyral crowns vs. deep sulcal banks.
  * Compare unregularized pseudoinverse noise blow-up against regularized MNE and LCMV beamforming.
  * Real-time metrics: Localization error (mm), Point-Spread Function dispersion (mm), and $R^2$ goodness of fit.

---

## 6. Optical Imaging (Week 10)

### [COMPLETED] fNIRS Modified Beer-Lambert Chromophore Unmixer
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
  * Spectrum graph showing absorption curves and selectable laser wavelengths (760 nm and 850 nm).
  * Physiological stimulus trigger producing functional hyperemia ($\Delta[\text{HbO}] \uparrow$, $\Delta[\text{HbR}] \downarrow$).
  * Real-time $2 \times 2$ matrix inversion calculator displaying raw optical densities and final chromophore concentrations.

### [COMPLETED] fNIRS Photon Transport & Short-Channel Scalp Regression
* **Target File**: `nbl425/demos/fnirs_photon_transport.html`
* **Course Week**: Week 10 (Functional NIRS)
* **Core Concepts**:
  * Radiative transport equation and Monte Carlo random walk of photon packets.
  * Formation of the curved banana-shaped sensitivity profile ($z_{\text{mean}} \approx \frac{1}{2}\sqrt{d_{\text{SD}}}$).
  * Superficial extracerebral contamination (scalp Mayer waves ~0.1 Hz, respiration ~0.25 Hz).
  * Dual-distance optodes: short-separation (8 mm) reference vs. long-separation (30 mm) channel.
  * Adaptive GLM regression removing systemic scalp noise.
* **Key Interaction**:
  * Animated photon scattering random walks through layered tissue slab (scalp, skull, CSF, cortex).
  * Interactive long-separation optode distance slider (15 to 45 mm).
  * Rolling multi-channel strip chart demonstrating real-time decontaminated signal recovery.

---

## 7. Magnetic Resonance Spectroscopy (Week 11)

### [COMPLETED] MRS Metabolite Basis Set & LCModel Spectral Fitter
* **Target File**: `nbl425/demos/mrs_spectral_fitting.html`
* **Course Week**: Week 11 (Magnetic Resonance Spectroscopy)
* **Core Concepts**:
  * Chemical shift dispersion in ppm vs. frequency spread in Hz ($\Delta\nu = \gamma B_0 \Delta\delta$).
  * Metabolite basis sets (NAA, Creatine, Choline, Myo-inositol, Glx, Lactate doublet).
  * The Linear Combination Model: $S(\delta) = \sum_k c_k B_k(\delta) \otimes L(\Delta\nu) + \text{Baseline}(\delta)$.
  * Macromolecule baseline modeling with smooth polynomial splines.
  * Cramer-Rao Lower Bounds (CRLB %SD) for parameter uncertainty.
* **Key Interaction**:
  * Main field selector (1.5T, 3T, 7T) illustrating peak dispersion and resolution of J-multiplets.
  * Sliders for shim linewidth (FWHM in Hz), coil SNR, and phase offsets.
  * Clinical pathology presets: Healthy brain, High-grade glioma, Ischemic stroke, Alzheimer's disease.
  * Automatic least-squares spectral deconvolution into individual color-coded metabolite curves.

---

## 8. Multi-Modal Integration (Week 12)

### [COMPLETED] Simultaneous EEG-fMRI Artifact Decontamination Workbench
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
    1. Raw signal (completely obscured by 20 mV gradient bursts).
    2. Apply AAS gradient filter &rarr; reveals BCG heartbeat pulses.
    3. Apply OBS/PCA BCG filter &rarr; unmasks the continuous microvolt EEG stream.
    4. Epoch Averaging &rarr; reconstructs the clean Visual P100 evoked response waveform.

### [COMPLETED] Multi-Modal Fusion & Representational Similarity Analysis (RSA)
* **Target File**: `nbl425/demos/multimodal_fusion.html`
* **Course Week**: Week 12 (Multi-Modal Integration)
* **Core Concepts**:
  * Disparate spatiotemporal limits: fMRI (millimeter spatial, sluggish hemodynamic) vs. EEG (millisecond temporal, smeared spatial).
  * Second-order isomorphism: bridging modalities at the level of representational geometries without forced spatial constraints.
  * Condition-by-condition Representational Dissimilarity Matrices (RDMs).
  * Spatiotemporal fusion trajectory via time-resolved Spearman rank correlation ($\rho(t)$).
  * Hierarchical visual processing stages: V1 (low-level, ~85 ms) $\to$ LOC (shape, ~135 ms) $\to$ FFA (face category, ~170 ms).
* **Key Interaction**:
  * Post-stimulus latency scrubber ($-50\text{ ms}$ to $+450\text{ ms}$) with animated playback.
  * Synchronized view of dynamic EEG RDM vs. static fMRI regional RDMs (V1, LOC, FFA).
  * Anatomical brain schematic lighting up corresponding visual cortex structures as their representational pattern emerges.

---

## 9. Emerging Modalities (Week 13)

### [COMPLETED] Optically Pumped Magnetometers (OPM) & Wearable MEG Studio
* **Target File**: `nbl425/demos/opm_wearable_meg.html`
* **Course Week**: Week 13 (Emerging Modalities)
* **Core Concepts**:
  * SERF (Spin-Exchange Relaxation-Free) optical pumping in $^{87}\text{Rb}$ vapor cells.
  * Inverse square law ($B \propto 1/r^2$) standoff advantage: $4\text{ mm}$ scalp gap vs. $25-35\text{ mm}$ SQUID cryogenic dewar gap.
  * Pediatric brain imaging: conformal flexible caps scaling to any head size vs. small head sitting 50+ mm away from adult SQUID helmets.
  * Active triaxial field cancellation coils enabling head movement tolerance.
* **Key Interaction**:
  * SQUID vs. Wearable OPM toggle with animated head cross-section.
  * Adult vs. Child cranial anatomy selector.
  * Head movement tilt/nod simulator showing SQUID motion artifact disruption vs. OPM synchronized tracking.
  * Real-time auditory M100 evoked field recording in femtoteslas (fT).

---

## 10. Future Directions & Big Data Connectomics (Week 14)

### [COMPLETED] Brain-Wide Association Studies (BWAS) Power & Replication Simulator
* **Target File**: `nbl425/demos/bwas_power_replication.html`
* **Course Week**: Week 14 (Future & Final Projects)
* **Core Concepts**:
  * Big data population neuroimaging (UK Biobank, ABCD, HCP).
  * Realistic modest brain-behavior effect sizes ($|r_{\text{true}}| \approx 0.05 - 0.15$).
  * The Winner's Curse: severe effect size inflation in underpowered ($N = 25-50$) discovery cohorts.
  * Replication crisis: failure of inflated discovery associations to replicate in independent samples.
  * Sample size scaling ($N \ge 2,000$) required for honest effect sizes and $>80\%$ replication power.
* **Key Interaction**:
  * Sample size slider ($N = 20$ to $4,000$) and true effect slider ($r_{\text{true}} = 0.00$ to $0.30$).
  * Split-half Discovery vs. Replication scatter plots with real-time Pearson $r$ and $p$-values.
  * 1,000-study Monte Carlo engine generating histograms of statistically significant discoveries and true out-of-sample replication rates.
