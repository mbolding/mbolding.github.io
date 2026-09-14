#!/usr/bin/env python3
"""Check this repository's element data against an independent reference table.

Usage:  python3 crosscheck.py

Two passes:
  1. Every spin, magnetic moment, natural abundance and quadrupole moment in data/slice_*.json
     is compared against the EasySpin nuclear isotope database, which compiles Stone's IAEA
     recommended moments. Differences that are deliberate are listed in EXPLAINED below with
     the reason; anything else is reported as a disagreement.
  2. Every gyromagnetic ratio and Larmor frequency quoted in the prose of data/dossier_*.json
     and data/shifts_*.json is compared against the table the page actually computes from, so
     that the words and the numbers cannot drift apart.

The reference table is fetched on first run and cached; it is not part of this repository.
"""
import json, glob, os, sys, re

HERE = os.path.dirname(os.path.abspath(__file__))
DIR  = os.path.join(HERE, "data")

# Reference table of nuclear moments, used only to check this repository's own data.
# It is not redistributed here: it is fetched on first run and cached (gitignored).
REF_URL = "https://raw.githubusercontent.com/StollLab/EasySpin/main/easyspin/private/isotopedata.txt"
REF = os.path.join(HERE, ".isotopedata.cache.txt")


def ensure_reference():
    """Fetch the EasySpin/Stone isotope table once and cache it beside this script."""
    if os.path.exists(REF) and os.path.getsize(REF) > 10000:
        return
    import urllib.request
    try:
        sys.stderr.write("fetching the reference isotope table ...\n")
        with urllib.request.urlopen(REF_URL, timeout=60) as r:
            body = r.read()
        if len(body) < 10000:
            raise ValueError("response too short to be the isotope table")
        with open(REF, "wb") as f:
            f.write(body)
    except Exception as e:
        sys.exit(
            "Could not fetch the reference isotope table (%s).\n"
            "Download it by hand and save it as:\n    %s\nfrom\n    %s\n" % (e, REF, REF_URL))


ensure_reference()
MUN_H = 7.6225932

def spin(s):
    s = str(s).strip()
    if "/" in s:
        a, b = s.split("/"); return float(a)/float(b)
    return float(s)

ref = {}
with open(REF) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("%"): continue
        p = line.split()
        if len(p) < 9: continue
        try:
            z, a = int(p[0]), int(p[1])
            sym = p[3]
            I = float(p[5]); mu = float(p[6]); ab = float(p[7])
            q = p[8]
            q = None if q.lower() == "nan" else float(q)
        except (ValueError, IndexError):
            continue
        ref["%d%s" % (a, sym)] = {"z": z, "I": I, "mu": mu, "ab": ab,
                                  "q_fm2": None if q is None else q * 100.0,
                                  "radio": p[2] == "*"}

mine = []
for p in sorted(glob.glob(os.path.join(DIR, "slice_*.json"))):
    mine.extend(json.load(open(p)))

# Differences from the reference that are deliberate and documented in the data,
# with the reason. Anything not listed here is a finding.
EXPLAINED = {
    "43Ca": "Q: Pyykko 2018 (-4.44 fm2) rather than the older Stone value (-4.08)",
    "51V":  "Q: -5.2 fm2 is kept here; the reference table gives -4.3 and a third compilation -4.8. "
            "Which value belongs to which compilation is unresolved, see the review notes",
    "67Zn": "Q: Pyykko 2018 (12.2 fm2) rather than the older Stone value (15.0)",
    "229Th": "mu and Q: 2013 reanalysis of the laser spectroscopy, 0.360 muN and 311 fm2, "
             "superseding 0.46 muN and 430 fm2",
    "209Bi": "Q: -42.2 fm2 from Dognon and Pyykko 2023, superseding the -51.6 fm2 of Stone 2013 "
             "and of Pyykko's own 2017 table; the world average of modern determinations is "
             "-42.0(1.7) fm2",
}

hard, soft, unknown, explained = [], [], [], []
checked = 0
for e in mine:
    sym = e["symbol"]
    for iso in e.get("isotopes") or []:
        if iso.get("label"):      # a metastable isomer; the reference lists ground states only
            continue
        key = "%d%s" % (iso["a"], sym)
        r = ref.get(key)
        if r is None:
            unknown.append(key + " (not in the reference table)")
            continue
        checked += 1
        I = spin(iso["spin"])
        if abs(I - r["I"]) > 1e-9:
            hard.append("%-7s spin %s vs reference %g" % (key, iso["spin"], r["I"]))
        mu = iso.get("mu")
        if mu is not None and r["mu"]:
            d = abs(mu - r["mu"]) / abs(r["mu"])
            if d > 0.01:   hard.append("%-7s mu %.6f vs %.6f (%.2f%%)" % (key, mu, r["mu"], 100*d))
            elif d > 0.002: soft.append("%-7s mu %.6f vs %.6f (%.2f%%)" % (key, mu, r["mu"], 100*d))
        g = iso.get("gamma")
        if g is not None and r["mu"] and r["I"]:
            gr = MUN_H * r["mu"] / r["I"]
            d = abs(g - gr) / abs(gr)
            if d > 0.01:   hard.append("%-7s gamma %.5f vs %.5f from reference mu (%.2f%%)" % (key, g, gr, 100*d))
            elif d > 0.003: soft.append("%-7s gamma %.5f vs %.5f from reference mu (%.2f%%)" % (key, g, gr, 100*d))
            if (g < 0) != (gr < 0):
                hard.append("%-7s gamma sign %+.4f vs reference %+.4f" % (key, g, gr))
        ab = iso.get("abundance")
        if ab is not None and not r["radio"]:
            if abs(ab - r["ab"]) > max(0.02, 0.02 * max(r["ab"], 1e-9)):
                (hard if abs(ab - r["ab"]) > 0.5 else soft).append(
                    "%-7s abundance %s vs reference %s" % (key, ab, r["ab"]))
        q = iso.get("q")
        if q is not None and r["q_fm2"] is not None and abs(r["q_fm2"]) > 1e-9:
            d = abs(q - r["q_fm2"]) / abs(r["q_fm2"])
            if d > 0.05:   hard.append("%-7s Q %.4f vs %.4f fm2 (%.1f%%)" % (key, q, r["q_fm2"], 100*d))
            elif d > 0.02: soft.append("%-7s Q %.4f vs %.4f fm2 (%.1f%%)" % (key, q, r["q_fm2"], 100*d))
            if (q < 0) != (r["q_fm2"] < 0):
                hard.append("%-7s Q sign %+.3f vs reference %+.3f" % (key, q, r["q_fm2"]))
        elif q is None and r["q_fm2"] is not None and I >= 1:
            soft.append("%-7s Q is null; the reference has %.3f fm2" % (key, r["q_fm2"]))

    # isotopes the reference says carry spin that we do not list at all
    have = {"%d%s" % (i["a"], sym) for i in (e.get("isotopes") or [])}
    for k, r in ref.items():
        if r["z"] == e["z"] and r["I"] > 0 and not r["radio"] and r["ab"] > 0.05 and k not in have:
            soft.append("%-7s carries spin %g at %.2f%% abundance and is missing from %s"
                        % (k, r["I"], r["ab"], sym))

print("cross-checked %d isotopes against %d reference entries\n" % (checked, len(ref)))
hard2 = []
for r in hard:
    k = r.split()[0]
    if k in EXPLAINED: explained.append("%s  (%s)" % (r, EXPLAINED[k]))
    else: hard2.append(r)
hard = hard2

for title, rows in (("DISAGREEMENTS", hard), ("explained differences", explained),
                    ("minor differences", soft), ("not in reference", unknown)):
    if rows:
        print("%s (%d):" % (title, len(rows)))
        for r in sorted(set(rows)): print("   ", r)
        print()
if not hard: print("No hard disagreements.")


# ---------------------------------------------------------------------------
# Third pass: the molar susceptibility column against the CRC element table.
#
# The source is the CRC Handbook of Chemistry and Physics, section 4, "Magnetic
# Susceptibility of the Elements and Inorganic Compounds". It is not redistributed here.
# Save its text beside this script as .crc_magsus.txt (gitignored) and this pass runs;
# without it the pass says so and is skipped, so the rest of the check still works.
# ---------------------------------------------------------------------------
CHI_REF = os.path.join(HERE, ".crc_magsus.txt")

# Elements where this chart deliberately departs from the CRC entry, with the reason.
CHI_EXPLAINED = {
    "He": "the one cell that does not follow this table: helium's diamagnetism is calculable "
          "essentially exactly and the first-principles value is -1.89e-6 cm3/mol, while the "
          "reference prints -2.02, about 7 percent too diamagnetic",
    "F":  "not listed in the reference at all; -9.63e-6 is the isotropic susceptibility of F2 "
          "from a contested 1999 gas-phase measurement, the weakest provenance in the column",
}

CHI_TOL = 0.02          # 2 %: below this the two agree for our purposes


def chi_parse(path):
    """-> {symbol: [(label, value), ...]} for the pure-element rows of the CRC table."""
    lines = [l.rstrip() for l in open(path, encoding="utf-8").read().split("\n")]
    val = re.compile(r"^\s*([+-]\s?[\d.,]+|Ferro\.?)\s*$")
    skip = {"Name", "Formula", "χm/10-6 cm3 mol-1"}
    page = re.compile(r"^4-1\d\d$")
    syms = {e["symbol"] for e in mine}
    out = {}
    for i, l in enumerate(lines):
        s = l.strip()
        m = val.match(s)
        if not m:
            continue
        ctx, j = [], i - 1
        while j >= 0 and len(ctx) < 2:
            c = lines[j].strip()
            if c and c not in skip and not page.match(c):
                ctx.append(c)
            j -= 1
        if len(ctx) < 2:
            continue
        formula, name = ctx[0], ctx[1]
        base = formula if formula in syms else (
            formula[:-1] if formula.endswith("2") and formula[:-1] in syms else None)
        if not base:
            continue
        raw = m.group(1).replace(" ", "").replace(",", "")
        out.setdefault(base, []).append((name, None if raw.startswith("Ferro") else float(raw)))
    return out


def chi_check():
    if not os.path.exists(CHI_REF):
        print("susceptibility: skipped, no %s\n"
              "   Save the text of the CRC Handbook section 4 element table there to enable it."
              % os.path.basename(CHI_REF))
        return
    crc = chi_parse(CHI_REF)
    bad, noted, absent = [], [], []
    n = 0
    for e in mine:
        sym, chi = e["symbol"], e.get("chiMolar")
        entries = crc.get(sym)
        if entries is None:
            if chi is not None:
                msg = "%-3s carries %+g but the reference table has no entry" % (sym, chi)
                if sym in CHI_EXPLAINED:
                    noted.append("%s  (%s)" % (msg, CHI_EXPLAINED[sym]))
                else:
                    absent.append(msg)
            continue
        n += 1
        ferro = any(v is None for _, v in entries)
        if ferro:
            if chi is not None:
                bad.append("%-3s has chiMolar %s; the reference marks it ferromagnetic" % (sym, chi))
            elif e.get("magnetism") != "ferromagnetic":
                bad.append("%-3s is 'Ferro.' in the reference but magnetism is %r"
                           % (sym, e.get("magnetism")))
            continue
        vals = [(lbl, v) for lbl, v in entries if v is not None]
        if chi is None:
            noted.append("%-3s is null; the reference has %s"
                         % (sym, ", ".join("%s %+g" % (l, v) for l, v in vals)))
            continue
        near = min(vals, key=lambda lv: abs(lv[1] - chi))
        d = abs(near[1] - chi) / max(abs(near[1]), 1e-9)
        if d > CHI_TOL:
            bad.append("%-3s chiMolar %+g vs %+g (%s) %.0f%%" % (sym, chi, near[1], near[0], 100 * d))
        elif len(vals) > 1:
            noted.append("%-3s %+g follows '%s'; the reference also lists %s"
                         % (sym, chi, near[0],
                            ", ".join("%s %+g" % (l, v) for l, v in vals if l != near[0])))

    print("susceptibility: checked %d elements against the CRC element table" % n)
    keep = []
    for r in bad:
        k = r.split()[0]
        if k in CHI_EXPLAINED:
            noted.append("%s  (%s)" % (r, CHI_EXPLAINED[k]))
        else:
            keep.append(r)
    for title, rows in (("SUSCEPTIBILITY DISAGREEMENTS", keep),
                        ("susceptibility notes", noted),
                        ("carried without a reference entry", absent)):
        if rows:
            print("%s (%d):" % (title, len(rows)))
            for r in sorted(set(rows)):
                print("   ", r)
    if not keep:
        print("No susceptibility disagreements.")
    print()
    return keep

# ---------------------------------------------------------------------------
# Second pass: numbers quoted in the dossier and shift-table prose must agree
# with the table the page actually computes from.
# ---------------------------------------------------------------------------
import re as _re

def prose_check(elements):
    iso = {}
    for e in elements:
        for i in e.get("isotopes") or []:
            iso[i.get("label") or ("%d%s" % (i["a"], e["symbol"]))] = i

    def walk(o, path="", ctx=""):
        """Yield (path, text, context). Context carries a fact's label along with its
        value, so "Frequency separation from 1H" exempts the numbers under it."""
        if isinstance(o, str): yield path, o, ctx
        elif isinstance(o, list):
            for j, v in enumerate(o): yield from walk(v, "%s[%d]" % (path, j), ctx)
        elif isinstance(o, dict):
            here = ctx + " " + str(o.get("label", "")) + " " + str(o.get("note", ""))
            for k, v in o.items(): yield from walk(v, "%s.%s" % (path, k), here)

    # a claim about a separation, offset or difference is not a claim about a Larmor frequency
    SKIP = _re.compile(r"separation|differ|offset|apart|spacing|split|gap|versus|vs\.?|relative to", _re.I)
    gpat = _re.compile(r"(\d+\.\d+)\s*MHz\s*/\s*T")
    lpat = _re.compile(r"(\d+\.?\d*)\s*MHz\s+at\s+(\d+\.?\d*)\s*T", _re.I)

    # Differences that are real and understood, not errors.
    ACCEPTED = {
        # 129Xe: 11.777 MHz/T is referenced to free xenon gas, which lies about 5300 ppm
        # upfield of the IUPAC XeOF4 reference. The table carries the bare-nucleus value,
        # 11.860. Both are correct; the page explains the split in a sidenote.
        ("dossier_gas.json", ".facts[0].value"),
        ("dossier_gas.json", ".summary"),
    }
    out = []
    for path in sorted(glob.glob(os.path.join(DIR, "dossier_*.json")) +
                       glob.glob(os.path.join(DIR, "shifts_*.json"))):
        d = json.load(open(path))
        nucs = d.get("nuclei") or ([d["nucleus"]] if d.get("nucleus") else [])
        nucs = [n for n in nucs if n in iso and iso[n].get("gamma")]
        if not nucs: continue
        name = os.path.basename(path)
        for where, t, ctx in walk(d):
            if SKIP.search(t) or SKIP.search(ctx): continue
            if (name, where) in ACCEPTED: continue
            for m in gpat.finditer(t):
                v = float(m.group(1))
                best = min(nucs, key=lambda n: abs(abs(iso[n]["gamma"]) - v))
                g = abs(iso[best]["gamma"])
                if abs(v - g) / g > 0.004:
                    out.append("%s %s: gamma %s vs table %.4f for %s" % (name, where[-20:], v, g, best))
            for m in lpat.finditer(t):
                v, B = float(m.group(1)), float(m.group(2))
                if not (0.05 <= B <= 30): continue
                best = min(nucs, key=lambda n: abs(abs(iso[n]["gamma"]) * B - v))
                pred = abs(iso[best]["gamma"]) * B
                if abs(v - pred) / pred > 0.01:
                    out.append("%s %s: \"%s MHz at %s T\" vs table %.3f for %s"
                               % (name, where[-20:], v, B, pred, best))
    return sorted(set(out))

rows = prose_check(mine)
print()
print("prose vs table: %d contradiction(s)" % len(rows))
for r in rows: print("   ", r)
print()
chi_check()
