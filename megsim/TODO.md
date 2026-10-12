# MEG simulator: to do

## Version 2

- [ ] Replace the synthetic MRI with a real template head, the MNI ICBM152 2009 T1, so the coregistration and source estimation slices look like a real scan. The synthetic head in version 1 is plausible but clearly synthetic. The template can be redistributed with the MNI copyright notice.
  - [ ] Refit the head model to the template: fit the conductor sphere to its inner skull and scalp, take the nasion and preauricular points from its face, and move the helmet so the sensors clear its scalp.
  - [ ] Place the built-in generators on the template's anatomy (Heschl's gyrus, the hand knob of the central sulcus, the calcarine and parieto-occipital cortex, the temporal lobe for the spikes), and the 10-10 electrodes on its scalp.
  - [ ] Take the atlas labels from a published atlas in the same space instead of the hand-built ones. CerebrA is one candidate; check that its license allows redistribution.
  - [ ] Digitize the head shape from the template's scalp and run ICP against it.
  - [ ] Restrict the source grid to the template's brain, so estimates cannot land in skull or CSF.
  - [ ] Keep the download small: 1.5 to 2 mm voxels, 8 bits, compressed, a few MB at most, loaded only when the Source estimation tab opens.
  - [ ] Keep the synthetic head as a fallback if the volume fails to load.
