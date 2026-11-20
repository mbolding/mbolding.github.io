# MEG simulator: to do

## Version 2 (done)

- [x] Replace the synthetic MRI with a real template head, the MNI ICBM152 2009c T1, so the coregistration and source estimation slices look like a real scan. The template can be redistributed with the MNI copyright notice (see `data/README.md`).
  - [x] Refit the head model to the template: the conductor sphere is fitted to its scalp above the ears and the template is shrunk 5% to the sphere's 9.2 cm; the nasion and preauricular points come from its face; the helmet moved 2 cm back so the coils clear its scalp, and its nape, by 1.7 cm or more.
  - [x] Place the built-in generators on the template's anatomy (the lateral half of Heschl's gyrus, the two walls of the central sulcus at the hand knob, the cuneus over the calcarine sulcus; the spike example's T9 lands in the inferior temporal gyrus), and the 10-10 electrodes on its scalp.
  - [x] Take the atlas labels from a published atlas in the same space: CerebrA, whose data release is listed under CC0; it derives from Mindboggle-101 (CC BY-NC-SA), so the labels are shared with attribution on those terms.
  - [x] Digitize the head shape from the template's scalp and run ICP against it.
  - [x] Restrict the source grid to the template's brain, so estimates cannot land in skull or CSF.
  - [x] Keep the download small: 1.5 mm voxels, 8 bits, compressed to 1.2 MB, loaded only when a tab that shows anatomy opens (Sources, Source estimation, and the head-position stage of Instrument).
  - [x] Keep the synthetic head as a fallback if the volume fails to load.

## Later

- [ ] Fit the inner shells to the template too. The brain, CSF and skull shells keep their version 1 radii, so the frontal and occipital poles reach past the brain shell: MEG does not mind, but the EEG model clamps sources there.
- [ ] A boundary element model from the template's inner skull and scalp, to set beside the sphere on the Fields tab.
