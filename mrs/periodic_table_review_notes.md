# Reviewer's notes: A Periodic Chart for Magnetic Resonance

Companion to `mrs/periodic_table.html`. Preprint, version 0.1.

This file records every value in the chart that the people who compiled it were not
fully confident of, in their own words, along with what they checked and what they
could not. It exists so that anyone fact-checking the chart can start where the
weaknesses actually are rather than sampling at random.

## How to read it

Each entry is a specific reservation about a specific value. They fall into a few kinds:

- a number taken from a secondary or remembered source that could not be re-verified;
- a number where two respectable sources disagree, and the choice between them is stated;
- a field deliberately left null because no defensible value was found;
- a figure derived by arithmetic rather than quoted, which is sound but inherits the
  assumptions behind it;
- a drawing hint in a spectrum, which is not a measurement at all.

Anything **not** listed here was either checked against a primary table or is computed
by the page from primitives that were. The whole isotope set was additionally checked
by program against Stone's IAEA compilation as distributed with EasySpin; that check
is described on the page itself and is not repeated here.

## A gap in these notes

These notes cover elements from Z = 43 upward, the two hardware and contrast dossiers,
and four of the seven shift tables. Elements Z = 1 to 42 and the first six dossiers and
three shift tables were compiled in an earlier run whose notes were lost when the run
was interrupted. Those entries went through the same programmatic cross-check and the
same independent review, but they carry no equivalent statement of reservations, so
**absence from this file does not mean a value in that range was verified more
thoroughly**. If anything, Z = 1 to 42 deserves the same treatment and has not had it.

## Independent review already applied

Four reviewers went over the page's physics, the dossiers, the shift tables and the
JavaScript after compilation. Thirty-one findings held up and were fixed before this
version; they are described in the git history. Two reviewer findings were accepted on
the reviewer's own reasoning rather than a fetched source, and remain open:

- the 17O indirect-detection linewidth at natural abundance was corrected to be
  consistent with the calibration quoted in the same entry, but the provenance of the
  original figure was never identified, so the corrected statement is an inference;
- the field at which Nb3Sn enters NMR magnet design, and the ceiling at which HTS
  inserts take over, were corrected from the reviewer's knowledge of magnet
  construction without a citation.

---

## Elements Z = 43 to 54 (Tc through Xe)

1. 99mTc: magnetic moment not in any recommended compilation I could reach, so mu, gamma, xi, q are null; only I = 1/2, 6.0072 h and the 140.5 keV gamma are asserted.

2. 99Tc: EasySpin/Stone mu = +5.6503 gives gamma = 9.57110 MHz/T, but the IUPAC Xi = 22.508326 implies 9.5835 MHz/T, 0.13% higher and in the wrong direction for a diamagnetic correction. Kept the EasySpin value per instruction and flagged both numbers in the isotope note.

3. 105Pd: EasySpin/Stone mu = -0.638 gives gamma = -1.94529; older NMR tables give -1.957 from mu = -0.642. 0.6% disagreement, noted in the file.

4. Quadrupole moments for 111In, 123I, 125I, 131I and 133Xe are set to null: values exist only on the pre-2018 scale (e.g. 111In 0.804 b, 125I -0.889 b, 131I -0.40 b, 133Xe 0.145 b) and no Pyykko-2018-scale revision is tabulated. 129I (-48.8 fm2) and 127I (-69.6 fm2) ARE on the 2018 scale and are given.

5. 124I: spin 2 is solid but the moment is not reliably tabulated, so mu/gamma are null (same convention slice_4 used for 68Ga and 90Y).

6. Chemical shift ranges are the softest numbers in the file. Confident: 125Te/123Te (-4100 to +1100, total span ~5000 ppm, search-confirmed), 99Ru/101Ru (>18000 ppm, search-confirmed), 129Xe/131Xe biomedical scale. Estimated: 99Tc (-2500 to +500), 103Rh (-1000 to +10000), 107/109Ag (-200 to +1200), 111/113Cd (-600 to +900), 113/115In (-200 to +500), Sn (-2200 to +2500). Left null where I had no defensible endpoints: 105Pd, 121Sb, 123Sb, 127I.

7. chiMolar values are the CRC element-table numbers. Iodine is quoted as -88.7, which is per mole of I2 in CRC, matching the convention slice_4 used for Br (-56.4); if the table wants per-mole-of-atoms, iodine should be -44.4 and bromine -28.2.

8. 115In shiftRange endpoints and the 107/109Ag range are the weakest single entries; both would benefit from a check against a Bruker/IUPAC shift compilation, which the egress proxy blocked (publications.iupac.org, Wikipedia, PMC, chemlin all refused).

## Elements Z = 55 to 70 (Cs through Yb)

9. Xi for 138La (13.194300) and 173Yb (4.821) are recalled IUPAC values I could not fetch directly (all IUPAC/PDF domains are blocked by the egress proxy). Both are corroborated indirectly: each reproduces its sister isotope's Stone moment ratio to 1e-5 and 2e-4 respectively, and the sister values 139La=14.125641, 171Yb=17.499306, 133Cs=13.116142, 135Ba=9.934457, 137Ba=11.112928 were all confirmed by search snippets.

10. Xi for 169Tm left null deliberately. Tabulated gamma for 169Tm is 3.531 MHz/T (chemlin/Bruker), which disagrees with the moment-derived 7.6225932*(-0.2310)/0.5 = -3.5216 MHz/T by 0.3%; IUPAC defines no reference sample for Tm, so I could not tell which convention a quoted Xi would follow. Noted in the isotope note.

11. chiMolar values are the CRC element table (10^-6 cm3/mol, ~293 K) from recall. Only Gd (+185000, explicitly at 350 K) and Er (+48000) were web-confirmed; every other value was cross-checked against Curie-Weiss chi = 0.12505*mu_eff^2/(T-theta) using literature mu_eff and paramagnetic Curie temperatures and agreed to 10-25%.

12. Pm chiMolar set null: no measurement exists for the metal. Search confirmed Pm2O3 at +2660e-6 cm3/mol vs a 5I4 free-ion prediction of +2960e-6; a widely circulated value of +980e-6 for Pm is inconsistent with both and was rejected.

13. 153Sm quadrupole moment set null (not in the EasySpin file and I could not verify it). Its mu = -0.00216 nuclear magnetons and I = 3/2 are web-confirmed, giving gamma = -0.011 MHz/T.

14. 133Cs shiftRange '-10 to +230' is a constructed window: solid CsCl at +223 ppm is confirmed, aqueous Cs+ salts sit within ~10 ppm of the CsNO3 reference. Cs metal's Knight shift lies far outside and is flagged in the note.

15. 137Ba/135Ba shiftRange left null: literature states the barium shift range is narrower than its own typical linewidth, so no useful window exists.

16. Quadrupole moments are Stone IAEA INDC(NDS)-650 (2013) via the EasySpin file, converted barn -> fm^2. Pyykko 2018 revises some lanthanide values (141Pr in particular); I did not substitute, and 141Pr's note names the source.

17. Receptivities for zero-abundance radionuclides (137Cs, 133Ba, 147Pm, 153Sm) are exactly 0.0 by the prescribed formula, not a missing value.

18. Group set null and block set 'f' for La through Yb, following the instruction that lanthanides take null group; note that La's configuration is [Xe]5d1 6s2, so a d-block assignment is defensible under the alternative convention.

## Elements Z = 71 to 83 (Lu through Bi)

19. Ir: IUPAC Xi 1.718/1.871 % imply gamma about 4 % below Stone's moments and are mutually inconsistent by 0.4 %; no Ir resonance has ever been observed in solution, so these frequency ratios are not experimentally anchored. Flagged in mrNotes.

20. Lu: Xi 11.404/8.131 % are mutually inconsistent with Stone's moments at the 0.4 % level; mu(175Lu)=+2.2257 gives gamma 0.17 % BELOW the Xi-implied value (wrong sign for shielding). The older moment +2.2327 reproduces Xi. Flagged in notes.

21. 187Os: Stone's mu = +0.0639 is only three significant figures, so the derived gamma carries roughly 0.2 % uncertainty; the Xi values for 187Os and 189Os imply absolute shieldings 8000 ppm apart.

22. Q(209Bi): used Stone 2013 / Pyykko 2018 value -51.6 fm2, but 2023 molecular and atomic determinations converge near -42 fm2, a 20 % revision. Both stated in mrNotes.

23. Quadrupole moments left null for 186Re, 188Re, 198Au and 203Hg: not verified from a primary table, so omitted rather than guessed.

24. Chemical shift ranges for 183W (-3500 to +8000), 195Pt (-6000 to +8000), 199Hg (-3000 to +1000) and 187Os (-5200 to -2000) are literature spans assembled from secondary sources, not authoritative tabulations; the 207Pb (-5000 to +11000) and 205Tl (-1750 to +5100) ranges are better anchored to specific published endpoints.

25. Tl reference compound: IUPAC prints Tl(NO3)3 in H2O, which is unstable in water; the scale is in practice anchored on aqueous TlNO3 at infinite dilution. Used the latter, with the discrepancy noted.

26. No IUPAC reference compound assigned (set null) for 175/176Lu, 177/179Hf, 191/193Ir and 197Au; a compound is tabulated for some of these but could not be confirmed.

27. chiMolar values are CRC molar susceptibilities recalled from memory; WebFetch was blocked by the egress proxy for every host tried, so they could not be re-verified against a primary table.

28. mu(186Re)=+1.728 and mu(188Re)=+1.777 come from a 1965 atomic-beam triple-resonance measurement (diamagnetically corrected); no modern re-determination was located.

29. Blurb/mrNote claims not independently verifiable from a primary source: LSO/LYSO intrinsic activity of roughly 300 Bq per cm3, cisplatin at about -2100 ppm, and the 500 uM 195Pt detection limit (the last from a single cited study).

## Elements Z = 84 to 118 (Po through Og)

30. Th chiMolar set to +132e-6 cm3/mol (older element-table value, consistent with the rest of this data set) although high-purity metal measurements give chi_g = +0.412e-6 cm3/g at 300 K, i.e. about +96e-6 cm3/mol; the discrepancy is stated in Th mrNotes.

31. U chiMolar +399e-6 and Pu chiMolar +534e-6 are element-table values; primary measurements scatter (alpha-U at 1.74e-6 cm3/g gives +414e-6; alpha-Pu is quoted near +5.3e-4 cm3/mol).

32. Np, Am, Ra, Ac, Pa, Po, At, Rn, Fr and all Z >= 96 have chiMolar null: no established bulk susceptibility found.

33. 209Po mu = +0.68 muN is tabulated to two significant figures, so its derived gamma carries about 1 percent uncertainty; half-life given as 124 y (older tables say 102 y).

34. 231Pa mu = 1.99 is the only entry in the EasySpin/Stone file printed without a sign, so the sign of the moment is not experimentally established; written as positive and flagged in notes.

35. 211At (I = 9/2) and 225Ac (I = 3/2) have established ground-state spins but no adopted magnetic moment, so mu, gamma and q are null and recH/recC are 0.0 (abundance 0), following the convention used for radionuclides in slices 5 and 6.

36. 223Ra mu = +0.2705 muN from ISOLDE collinear resonance ionization spectroscopy; its spectroscopic quadrupole moment was not confirmed, so q is null.

37. 229Th uses mu = +0.360(7) muN and Q = +311 fm2 from the 2013 reanalysis, superseding EasySpin's +0.46 muN and +4.3 barn; noted in the isotope record.

38. 227Th (spin not confirmed here) and 241Am are mentioned only in mrNotes, not listed as isotope records, to avoid quoting unverified spins or moments.

39. Magnetism for Z >= 100 is an inference from electron configuration or the period-6 homolog, never a measurement; each such element says so in its mrNotes. Category is 'unknown' for Z >= 109 and 'transition-metal' for Rf-Hs, whose group chemistry has been demonstrated.

40. Superheavy half-lives are described qualitatively (hours, seconds, tens of milliseconds) rather than with exact numbers, except 294Og at about 0.7 ms and 285Cn at about half a minute.

41. Po assigned category post-transition-metal and At metalloid; both labels vary between reference data sets.

42. No IUPAC Xi values, shift references or shift ranges exist for any nucleus in this slice, so all three fields are null throughout, and invivo is false for every isotope (none is detected by MR in vivo).

## Dossier: the scanner as a materials problem

43. Quench pipe bore diameter omitted: the vendor datasheet (euro-emc.co.uk) was blocked by the egress proxy and I would not quote a number I could not check.

44. MRI's share of world helium consumption omitted: commonly repeated as 20 percent but I found no primary source I would defend; helium spot price also omitted for the same reason.

45. The 1.4 nano-ohm persistent-circuit resistance is my own derivation from R = L(dI/dt)/I for 0.1 ppm/h on a 50 H, 500 A magnet, not a quoted vendor figure. It is arithmetically sound but the drift spec and inductance vary by magnet.

46. 5 gauss line distances: sources disagreed (one gave 2 to 3 m for actively shielded 1.5 T, another 4 to 6 m axial for unshielded). I widened the stated ranges to cover both rather than pick one.

47. NdFeB (BH)max upper bound of 470 kJ/m3 is near the laboratory/theoretical ceiling; routine commercial N52 is closer to 400 to 420 kJ/m3. The range as written spans both.

48. Mu-metal composition (77 Ni, 16 Fe, 5 Cu, 2 Mo) is nominal and varies by grade and vendor; saturation 0.74 to 0.8 T is well attested.

49. NbTi Tc is quoted as 9.2 K in most references but one source gave 9.8 K for a particular Nb-Ti ratio. I used 9.2 K as specified in the brief and as the majority value.

50. Gradient amplifier peak currents above 900 A are premium/research systems; the 1500 A figure came from a single high-power driver spec and is flagged as such in the text.

51. Aluminium RF screen thickness (0.5 to 1.5 mm) and copper foil (0.1 to 0.2 mm) are typical installed practice rather than a standardised spec; the 90 to 100+ dB attenuation requirement is well sourced.

## Dossier: contrast, susceptibility and implants

52. Cobalt-chromium (CoCrMo) volume susceptibility: no defensible ppm value found, so it is stated only comparatively (between titanium and 316L) rather than numerically.

53. Cortical bone susceptibility relative to water: literature spans about -0.3 ppm (1990s NMR methods) to -2 ppm and lower (modern UTE-QSM). Quoted as 1.4 to 2 ppm diamagnetic relative to water, which brackets the modern values only.

54. Rohrer 2005 per-agent 1.5 T values: secondary sources disagree on whether gadoterate or gadoteridol is higher (one Bayer brochure gives gadoterate 4.1 / gadoteridol 3.6, the opposite of the usual table). I therefore used the independently confirmed Szomolanyi 2019 human-plasma set and quoted only gadobenate 6.3 and gadodiamide 4.3 from the linear group.

55. Thermodynamic stability constants log K 25.6 / 22.1 / 16.9 (gadoterate / gadopentetate / gadodiamide) are standard-table values I could not re-confirm in an accessible source this session.

56. Gadoteridol acid dissociation half-life stated loosely as 'a few hours'; the Port 2008 figure is around 3.9 h at pH 1.2 but I could not verify it directly.

57. Eu3+ room-temperature effective moment of about 3.4 Bohr magnetons: the Van Vleck origin and 7F0 J=0 ground state are confirmed, the exact 3.4 figure is not.

58. Nitinol +230 to +250 ppm SI is derived by me from a measured mass susceptibility (2.87e-6 cgs cm3/g, electropolished austenite) times density 6.45 g/cm3 times 4 pi; surface oxide and martensite/R-phase shift it by more than 6 percent.

59. 316L range +3520 to +6700 ppm SI is attributed to Schenck 1996 via secondary sources only; the primary table was not reachable (publisher domains blocked).

60. Ferumoxytol particle size: hydrodynamic 17 to 31 nm is well supported, but reported core sizes vary widely by method (TEM about 7 nm, cryo-TEM about 2 nm), so core size is deliberately left vague.

61. The practice bullet saying r1 at 3 T is 'a few percent to 15 percent below' the 1.5 T value is a generalisation; gadobutrol actually rises slightly from 4.78 to 4.97 in human plasma.

## Shift table: deuterium

62. Glx is quoted as 2.35 ppm by de Feyter/de Graaf and as 2.4 ppm by several other groups; glutamate and glutamine are never resolved in vivo so the exact centre depends on the fitting basis set. Used 2.35.

63. Lactate is quoted as 1.3 ppm in the original DMI papers and as 1.4 ppm in some reviews, partly because the overlapping natural-abundance lipid CH2 pulls the fitted centre. Used 1.3.

64. Glucose appears as 3.8 ppm in most DMI work but as 3.9 ppm in at least one recent review. Used 3.8.

65. The water/HDO reference is set to 4.8 ppm in nearly all DMI papers, but a few write 4.7 ppm (same convention as some 1H MRS groups). Used 4.8.

66. rel heights are drawing hints only: they sketch a post-dose steady-state brain spectrum (HDO dominant, Glc about a fifth of it, Glx smaller, Lac small). Actual ratios depend on tissue, time after dose, and tumour vs normal brain.

## Shift table: hyperpolarized xenon

67. The brain RBC peak (217.0) and the lung RBC peak (218.2) are the same chemical species drawn as two stems 1.2 ppm apart, because the pulmonary value comes from a 3T multisite standardized cohort and the cerebral value from single-center 1.5T head CSI. If the chart looks cluttered there, the brain stem can be dropped and folded into the lung RBC note.

68. The alveolar gas sub-peak at -2.3 ppm is real but rests on one careful time-domain-fitting study (Duke, 1.5T) that assigned the airway gas component to 0 ppm. Most pipelines report a single gas peak at 0 ppm, and if the reference is taken as the whole gas peak rather than the airway component this offset shrinks.

69. Brain compartment values (188, 192, 196, 200) are single-center 1.5T numbers rounded to whole ppm; the literature spread is about 1 ppm (gray matter 196 to 196.5, white matter 192 to 193, plasma 197 to 200). They are well established as assignments but not standardized the way the lung values now are.

70. The membrane peak is genuinely two components about 5 ppm apart under three-peak time-domain fitting, but their absolute positions are not consistently reported, so only the single 197.6 ppm membrane peak is drawn and the splitting is described in its note.

71. The oxygenation dependence of the RBC shift is nonlinear and the in-vitro calibration is referenced to plasma at 20 C, giving an RBC-to-plasma separation of 20.4 ppm (deoxygenated) to 25.5 ppm (fully oxygenated). That is larger than the 20.6 ppm membrane-to-RBC gap of the standardized in-vivo values, so the stated 'about 1 ppm per 10 percent sO2' is a working slope near normal saturation, not a calibration curve.

72. Relative heights are drawing hints only. The true gas peak is roughly 100x any dissolved peak; the RBC:membrane ratio of about 0.49 is the one height relationship in the file that is quantitatively faithful.

## Shift table: fluorine

73. Isoflurane CF3 at -81.5 ppm and OCHF2 at -88.0 ppm: sources disagree. An in vivo mouse table referenced to CFCl3 gives -80.55 and -86.85 (JMRI, PMC5484368); an 11.7T phantom/in vivo study gives -82.9 and -89.9 with PFCE at -91.5 (PMC8760223); high-resolution solution chemistry would put the CF3 several ppm further downfield near -75. The 6 to 7 ppm CF3-to-OCHF2 separation is consistent across the in vivo work, so the pair was centred inside the reported in vivo range as the brief asks.

74. Desflurane at -85.0 ppm: no verified 19F assignment was found for desflurane in any accessible source. The value is inferred from the CF3-CHF-O-CHF2 structure by analogy (beta-fluorine shielding of the isoflurane CF3, plus the OCHF2 of the same ether), and the CF3 and OCHF2 lines are deliberately drawn as one stem. The lone CHF is stated in the note as beyond -140 ppm without a numeric stem because that value could not be confirmed.

75. Fluoxetine at -61.5 ppm: the in vivo MRS papers (Komoroski 1994 and later) were not retrievable in full text, so the position comes from the para-alkoxy aryl-CF3 family (benzotrifluoride -63.7, p-methoxy analogue near -61.7) rather than from a quoted in vivo number. Confident to about 1 ppm, not better.

76. 5-fluorouracil absolute position -169.3 ppm vs CFCl3: this is the standard literature value from memory, not confirmed from a retrievable source in this session. Every 5-FU metabolite stem here is pinned to it, so if 5-FU moves, FNuct, FUPA and FBAL all move with it. The relative offsets themselves ARE sourced: FUPA -17.3 and FBAL -18.6 ppm from 5-FU, anabolites +3.5 to +5.5 ppm (Br J Cancer, PMC2394413), which also fixes the direction: catabolites upfield of 5-FU, anabolites downfield.

77. PFOB internal CF2 components at -117.5, -122.0 and -126.6 ppm: taken from a published summary table whose other entries (perfluorodecalin, F-44E) are clearly mis-referenced, though the PFOB and PFCE rows agree with independent sources. The number of resolvable CF2 components and their relative heights are a drawing approximation.

78. Solid-state 19F of bone fluorapatite is mentioned in the fluoride note without a ppm value on purpose; its position (commonly quoted near -103 ppm) was not verified and it is invisible to liquid-state sequences anyway.

79. Network egress was blocked for every WebFetch target in this session, so verification relied on WebSearch result text plus PubMed Central full text via MCP. Confirmed from source: PFCE -91.8 / -91.5, PFOB CF2Br -63.7 and CF3 -81.82, aqueous NaF -121.5 and KF -125.3, TFA -76.55 (PMC5484368, doi 10.1002/jmri.25564); PFCE -91.5 with isoflurane offsets (PMC8760223, doi 10.1007/s11307-021-01653-6); sevoflurane -75.13 and -155.65 (PMC4518101, PMID 26330861); 5-FU metabolite offsets (PMC2394413, doi 10.1038/sj.bjc.6601345); hexafluorobenzene -164.9 from 19F reference-standard tables.

## Shift table: the single-line nuclei

80. All five peaks are placed at exactly 0.0 ppm, which is the honest answer: each nucleus is referenced to its own aqueous standard (NaCl, water, LiCl, NaCl chloride, KCl) and the in vivo line sits on that zero, so the stems will coincide at the origin. Nothing here is identified by position, so there is no sign to get backwards.

81. Shift-reagent direction: I state only the Dy(PPP)2 (7-) case (extracellular Na 10 to 20 ppm UPFIELD of intracellular Na at 0 ppm), which sources word explicitly as upfield. Sources for TmDOTP5- were ambiguous about direction (one says 'downshifted by 2.2 ppm' while also quoting the peak at about +2 ppm), so I deliberately omitted TmDOTP rather than risk a sign error.

82. 7Li brain concentration is given qualitatively ('a few tenths of a millimolar, well below serum') because reported brain/serum ratios vary by study; the 4.6 s human head T1 comes from a single older in vivo report.

83. 35Cl tissue level is quoted as physiology (about 100 to 110 mM plasma, a few mM intracellular) rather than as a measured 35Cl MRI tissue concentration, which I could not pin to a specific value.

84. 39K muscle concentration of roughly 100 mM is a round physiological figure, not a citation-exact 39K MRI value. The 200 Hz quadrupolar satellite figure (calf parallel to B0, 7T, Rosler 2016) is solid; the derived 'roughly 14 ppm at 7T' is my own arithmetic from gamma = 1.989 MHz/T.

85. The 'rel' heights (1.0, 0.6, 0.35, 0.25, 0.15) are a compressed readability ranking, not a ratio. True relative in vivo signal spans about two orders of magnitude (23Na 1.0, 17O ~0.16, 7Li ~0.05, 35Cl ~0.02, 39K ~0.01 on a concentration-times-receptivity estimate); I noted the compression inside the 23Na peak note.

---

*Generated from the compilation agents' own uncertainty reports. Corrections and
additions welcome; this file should shrink as the chart is checked.*
