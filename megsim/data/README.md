# The template head

The MEG simulator's structural MRI, atlas and head shape come from a template brain rather than a real participant.

## What is here

`mni152.bin.gz` holds three volumes in one gzip file, read by `js/mri_template.js`:

1. The T1-weighted image at 1.5 mm, 8 bits, stored as each voxel's difference from its neighbours (left plus above minus upper left, within its axial slice) so it compresses well.
2. A label for every voxel: the CerebrA atlas regions (codes 1 to 102), the white matter under each cortical region (128 plus the region's code), and the tissue outside the atlas: deep white matter, corpus callosum, CSF, dura and venous sinuses, skull, scalp, eyes, nose, sinuses, and the soft tissue of the face and neck.
3. The scalp's signed distance at 3 mm, for the digitizer and for ICP.

`../js/template.js` holds the numbers measured on the same head: the head frame, the fiducials, the 10-10 electrodes, the sites of the built-in generators, the eyes, the scalp's distance from the centre in every direction, the source grid's mask and the names of the labels.

## How it was made

`../tools/build_template.py` makes both files from the TemplateFlow copy of the template (`tpl-MNI152NLin2009cSym`, 1 mm: the T1w image, the GM, WM and CSF probability maps, and the CerebrA labels with their table, which TemplateFlow names `tpl-MNI152NLin2009cSym_atlas-CerebA_dseg.tsv`):

```
python3 tools/build_template.py <folder with the TemplateFlow files> megsim
```

It needs numpy and scipy. Along the way it:

- finds the skin on the smoothed T1, the nasion at the deepest point of the midline profile, and the preauricular points on the skin 6 mm in front of and above the ear canal;
- sets up the head frame from those landmarks (x through the preauricular points, y toward the nasion, z up) and fits a sphere to the scalp above them, leaving out the ears and face, as a lab fits one to the digitized head shape;
- shrinks the template by 0.952 so the sphere's radius is the simulator's 9.2 cm (the MNI template is larger than an average head), and puts the head frame's origin at the sphere's centre;
- places the 10-10 electrodes on the scalp by the proportional rules (the midline and the line between the preauricular points cut in tenths, the circumference 10% above the nasion, preauricular points and inion, and the rows between);
- puts the built-in generators on the atlas: the lateral half of Heschl's gyrus, the two walls of the central sulcus at the hand knob, and the cuneus where it lines the calcarine sulcus;
- marks the 6 mm source grid points that fall in grey or white matter.

## Sources and licences

**MNI ICBM152 2009c nonlinear symmetric template.** Fonov VS, Evans AC, McKinstry RC, Almli CR, Collins DL (2009). Unbiased nonlinear average age-appropriate brain templates from birth to adulthood. *NeuroImage* 47:S102. [doi:10.1016/S1053-8119(09)70884-5](https://doi.org/10.1016/S1053-8119(09)70884-5). Fonov V, Evans AC, Botteron K, Almli CR, McKinstry RC, Collins DL (2011). Unbiased average age-appropriate atlases for pediatric studies. *NeuroImage* 54:313–327. [doi:10.1016/j.neuroimage.2010.07.033](https://doi.org/10.1016/j.neuroimage.2010.07.033). It is used under this notice, which must accompany every copy:

> Copyright (C) 1993-2004 Louis Collins, McConnell Brain Imaging Centre, Montreal Neurological Institute, McGill University. Permission to use, copy, modify, and distribute this software and its documentation for any purpose and without fee is hereby granted, provided that the above copyright notice appear in all copies. The authors and McGill University make no representations about the suitability of this software for any purpose. It is provided "as is" without express or implied warranty. The authors are not responsible for any data loss, equipment damage, property loss, or injury to subjects or patients resulting from the use or misuse of this software package.

**CerebrA atlas.** Manera AL, Dadar M, Fonov V, Collins DL (2020). CerebrA, registration and manual label correction of Mindboggle-101 atlas for MNI-ICBM152 template. *Scientific Data* 7:237. [doi:10.1038/s41597-020-0557-9](https://doi.org/10.1038/s41597-020-0557-9). Its data release on G-Node ([doi:10.12751/g-node.be5e62](https://doi.org/10.12751/g-node.be5e62)) is listed under CC0 1.0. CerebrA was made from the Mindboggle-101 atlas (Klein A, Tourville J (2012). 101 labeled brain images and a consistent human cortical labeling protocol. *Frontiers in Neuroscience* 6:171. [doi:10.3389/fnins.2012.00171](https://doi.org/10.3389/fnins.2012.00171)), which is distributed under a Creative Commons Attribution-NonCommercial-ShareAlike licence. The label volume here derives from both, so it is shared with this attribution, for non-commercial teaching, on the same share-alike terms.

**TemplateFlow**, where both were obtained. Ciric R, Thompson WH, Lorenz R, et al. (2022). TemplateFlow: FAIR-sharing of multi-scale, multi-species brain models. *Nature Methods* 19:1568–1571. [doi:10.1038/s41592-022-01681-2](https://doi.org/10.1038/s41592-022-01681-2).
