# Sources for the MR periodic chart

`../periodic_table.html` is generated, in one respect only: its three
`<script type="application/json">` blocks are written by `build.py` from the files in
`data/`. Everything else in that page, the markup, the stylesheet and the code, is
written and edited by hand.

So there is one rule:

> **Edit `data/*.json`, then run `build.py`. Never hand-edit the JSON blocks inside the
> HTML.** They will be overwritten on the next build, and the change will be lost without
> a word.

## Regenerating the page

```sh
python3 build.py        # data/ -> ../periodic_table.html, with schema checks
python3 crosscheck.py   # data/ -> an independent reference table, and prose vs numbers
```

`build.py` prints `PROBLEMS` for anything that would put a wrong or malformed value on the
page, and `warnings` for things that are deliberate but worth seeing. **It exits non-zero
when there are problems**, so it can go in a check. Read the whole of its output; the one
data error that reached a published commit got there because a problem was reported and
the output was being piped through `head`.

## What is in `data/`

| files | what they carry |
| --- | --- |
| `slice_1.json` … `slice_8.json` | the 118 elements and their NMR-active isotopes, split by atomic number |
| `dossier_*.json` | ten quantitative topic dossiers, attached to elements by symbol |
| `shifts_*.json` | seven in-vivo chemical shift tables, drawn as stem spectra |

The slices are joined and sorted by Z; the split is only so that they could be compiled
and reviewed in parallel, and the boundaries carry no meaning. `build.py` documents the
exact schema it enforces, and will tell you which key is missing or wrong rather than
producing a broken page.

### The primitives

Each isotope stores spin, magnetic moment, natural abundance, quadrupole moment, and where
the NMR literature has settled on one, a tabulated gyromagnetic ratio and IUPAC frequency
ratio. **The receptivities and every field-dependent quantity are computed in the browser**,
not stored, so a value shown on the page cannot drift from the primitive behind it. Any
`recH` and `recC` left in the data are ignored and recomputed.

## The reference table

`crosscheck.py` checks every spin, moment, abundance and quadrupole moment against the
EasySpin nuclear isotope database, which compiles:

- N. J. Stone, *Table of Recommended Nuclear Magnetic Dipole Moments*, IAEA INDC(NDS)-0915
- N. Stone, *Table of Nuclear Quadrupole Moments*, IAEA INDC(NDS)-650

That file is **not** redistributed here. It is fetched on first run from the EasySpin
repository and cached as `.isotopedata.cache.txt`, which is gitignored. If the fetch fails
the script tells you the URL to save it from by hand.

Seven differences between this data and that reference survive on purpose, and are listed in
`crosscheck.py` with the reason: three quadrupole moments where this chart keeps a value the
reference does not (<sup>43</sup>Ca, <sup>51</sup>V, <sup>67</sup>Zn), the 2013 reanalysis of
<sup>229</sup>Th, and <sup>209</sup>Bi's 2023 redetermination. Anything else it finds is a
finding.

The second pass compares every gyromagnetic ratio and Larmor frequency quoted in the *prose*
of the dossiers and shift tables against the table the page computes from, so that the words
and the numbers cannot drift apart. It carries its own short allowlist for the one case where
they legitimately differ, xenon, where the gas-phase and reference-compound frequencies are
0.7 per cent apart.

## Status, and what needs doing

The chart is a preprint. `../periodic_table_review_notes.md` records every value its
compilers and auditors were not confident of, and the page's own *Where this is still soft*
section names the weakest columns. Version 0.2 closed the gap that used to be the largest
open item, the absence of notes for Z = 1 to 42; every slice, dossier and shift table now
has them.
