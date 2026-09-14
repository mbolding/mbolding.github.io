#!/usr/bin/env python3
"""Regenerate mrs/periodic_table.html from the sources in data/, validating on the way.

Usage:  python3 build.py

Reads every data/slice_*.json, data/dossier_*.json and data/shifts_*.json, checks them
against the schema the page expects, strips em dashes from prose, and injects the three
JSON payloads into the <script type="application/json"> blocks of the page. The page's
markup and code are edited in place, by hand; only the data blocks are generated.

Exits non-zero if anything in PROBLEMS is reported.
"""
import json, glob, os, re, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
DIR  = os.path.join(HERE, "data")
PAGE = os.path.normpath(os.path.join(HERE, os.pardir, "periodic_table.html"))

GAMMA_H = 42.5774806
MUN_H   = 7.6225932
D13C    = 1.7010e-4

EL_KEYS  = {"z","symbol","name","group","period","block","category","weight",
            "magnetism","chiMolar","mrRoles","tier","blurb","mrNotes","isotopes"}
ISO_KEYS = {"a","spin","abundance","gamma","mu","q","xi","recH","recC",
            "halfLife","reference","shiftRange","invivo","notes"}
ISO_OPT  = {"label"}
ROLES = {"invivo-mrs","hyperpolarized","contrast","magnet","coil","shielding",
         "implant","tracer","optical-pumping"}
TIERS = {"workhorse","established","emerging","exotic","none"}

def spin(s):
    if s is None: return None
    s = str(s).strip()
    if "/" in s:
        a,b = s.split("/"); return float(a)/float(b)
    try: return float(s)
    except ValueError: return None

def load(pattern):
    out = []
    for p in sorted(glob.glob(os.path.join(DIR, pattern))):
        with open(p) as f:
            try: d = json.load(f)
            except Exception as e:
                print("  !! %s does not parse: %s" % (os.path.basename(p), e)); continue
        out.append((os.path.basename(p), d))
    return out

def main():
    problems, warnings = [], []
    elements = []
    for name, d in load("slice_*.json"):
        if not isinstance(d, list):
            problems.append("%s is not a JSON array" % name); continue
        elements.extend(d)

    elements.sort(key=lambda e: e.get("z", 0))
    seen = {}
    for e in elements:
        z = e.get("z")
        if z in seen: problems.append("duplicate Z=%s (%s and %s)" % (z, seen[z], e.get("symbol")))
        seen[z] = e.get("symbol")

    have = set(seen)
    missing = [z for z in range(1, 119) if z not in have]
    if missing:
        warnings.append("missing Z: %s" % (", ".join(str(z) for z in missing[:40])
                                           + (" ..." if len(missing) > 40 else "")))

    n_iso = 0
    for e in elements:
        sym = e.get("symbol", "?")
        miss = EL_KEYS - set(e)
        if miss: problems.append("%s: missing element keys %s" % (sym, sorted(miss)))
        extra = set(e) - EL_KEYS
        if extra: warnings.append("%s: unexpected element keys %s" % (sym, sorted(extra)))
        if e.get("tier") not in TIERS:
            problems.append("%s: bad tier %r" % (sym, e.get("tier")))
        for r in (e.get("mrRoles") or []):
            if r not in ROLES: problems.append("%s: bad role %r" % (sym, r))

        keys = {}
        for iso in (e.get("isotopes") or []):
            k = iso.get("label") or ("%s%s" % (iso.get("a"), sym))
            if k in keys:
                problems.append("%s: two isotopes both render as %s; one needs an explicit label "
                                "(a metastable isomer should be e.g. 99mTc)" % (sym, k))
            keys[k] = 1

        ab_sum = 0.0
        for iso in (e.get("isotopes") or []):
            n_iso += 1
            key = "%s%s" % (iso.get("a"), sym)
            m = ISO_KEYS - set(iso)
            if m: problems.append("%s: missing isotope keys %s" % (key, sorted(m)))
            I = spin(iso.get("spin"))
            if not I or I <= 0:
                problems.append("%s: spin %r is not > 0" % (key, iso.get("spin"))); continue
            ab = iso.get("abundance") or 0
            ab_sum += ab
            g, mu = iso.get("gamma"), iso.get("mu")
            if g is not None and mu is not None:
                gc = MUN_H * mu / I
                if abs(gc) > 1e-9 and abs(g - gc) / abs(gc) > 0.003:
                    problems.append("%s: gamma %.5f vs %.5f from mu=%.5f I=%s (%.2f%% off)"
                                    % (key, g, gc, mu, iso.get("spin"), 100*abs(g-gc)/abs(gc)))
                if (g < 0) != (mu < 0):
                    problems.append("%s: sign(gamma)=%s but sign(mu)=%s" % (key, g, mu))
            if g is not None:
                rec = (ab/100.0) * abs(g/GAMMA_H)**3 * (I*(I+1)/0.75)
                got = iso.get("recH")
                if got not in (None, 0) and rec > 0 and abs(got-rec)/rec > 0.05:
                    warnings.append("%s: recH %.4g vs computed %.4g (page recomputes)" % (key, got, rec))
            if I == 0.5 and iso.get("q") not in (None,):
                problems.append("%s: I=1/2 but q=%r" % (key, iso.get("q")))
            if I >= 1 and iso.get("q") is None:
                warnings.append("%s: I=%s with no quadrupole moment" % (key, iso.get("spin")))
            xi = iso.get("xi")
            if xi and g:
                # Xi is the observed frequency ratio of a SHIELDED nucleus in a reference
                # compound; gamma here is the (near) bare-nucleus value. The gap is the
                # absolute shielding, which grows steeply with Z: hundredths of a per cent
                # for light nuclei, over one per cent for thallium and bismuth. Only a
                # really large gap means someone made an error.
                pred = 100*abs(g)/GAMMA_H
                d = abs(xi-pred)/pred
                z = e.get("z") or 0
                if d > 0.03:
                    problems.append("%s: xi %.4f vs %.4f from gamma (%.1f%%, too big for shielding)"
                                    % (key, xi, pred, 100*d))
                elif d > (0.004 if z < 37 else 0.02):
                    warnings.append("%s: xi/gamma differ by %.2f%% (Z=%d shielding split)"
                                    % (key, 100*d, z))
        if ab_sum > 100.5:
            problems.append("%s: NMR-active abundances sum to %.3f%%" % (sym, ab_sum))

    # em dashes anywhere in the prose
    blob = json.dumps(elements, ensure_ascii=False)
    if "—" in blob:
        n = blob.count("—")
        warnings.append("%d em dash(es) in element prose (stripped on inject)" % n)

    dossiers = []
    for name, d in load("dossier_*.json"):
        if isinstance(d, dict): dossiers.append(d)
        else: problems.append("%s is not a JSON object" % name)

    shifts = []
    for name, d in load("shifts_*.json"):
        if not isinstance(d, dict):
            problems.append("%s is not a JSON object" % name); continue
        nuc = d.get("nucleus")
        if not nuc: problems.append("%s has no nucleus field" % name); continue
        ref_g = d.get("refMHzPerT")
        if ref_g is not None:
            hit = None
            for e in elements:
                for i in e.get("isotopes") or []:
                    if (i.get("label") or ("%d%s" % (i["a"], e["symbol"]))) == nuc: hit = i
            if hit and hit.get("gamma"):
                dd = abs(abs(ref_g) - abs(hit["gamma"])) / abs(hit["gamma"])
                if dd > 0.02:
                    problems.append("%s: refMHzPerT %s is %.1f%% from the tabulated gamma %s"
                                    % (nuc, ref_g, 100*dd, hit["gamma"]))
            if not d.get("refNote"):
                warnings.append("%s declares refMHzPerT with no refNote to explain it" % nuc)
        lo, hi = d.get("axisLo"), d.get("axisHi")
        pks = d.get("peaks") or []
        if nuc != "single-line":
            if lo is None or hi is None or lo >= hi:
                problems.append("%s: axis window %r..%r is not increasing" % (nuc, lo, hi))
            else:
                for pk in pks:
                    v = pk.get("ppm")
                    if not isinstance(v, (int, float)):
                        problems.append("%s: peak %r has no numeric ppm" % (nuc, pk.get("name")))
                    elif v < lo or v > hi:
                        problems.append("%s: peak %s at %s ppm falls outside %s..%s"
                                        % (nuc, pk.get("name"), v, lo, hi))
                    n = pk.get("name") or ""
                    if len(n) > 12:
                        warnings.append("%s: label %r is %d chars, will crowd" % (nuc, n, len(n)))
            ppms = [pk.get("ppm") for pk in pks if isinstance(pk.get("ppm"), (int, float))]
            if ppms != sorted(ppms, reverse=True):
                warnings.append("%s: peaks are not in descending ppm order (page does not care)" % nuc)
        shifts.append(d)
    sblob = json.dumps(shifts, ensure_ascii=False)
    if "\u2014" in sblob:
        warnings.append("%d em dash(es) in shift tables (stripped on inject)" % sblob.count("\u2014"))
    dblob = json.dumps(dossiers, ensure_ascii=False)
    if "—" in dblob:
        warnings.append("%d em dash(es) in dossier prose (stripped on inject)" % dblob.count("—"))

    def strip_em(o):
        if isinstance(o, str): return o.replace("—", ", ").replace("–", "-")
        if isinstance(o, list): return [strip_em(x) for x in o]
        if isinstance(o, dict): return {k: (v if k in ("shiftRange",) else strip_em(v)) for k, v in o.items()}
        return o

    elements = strip_em(elements)
    dossiers = strip_em(dossiers)
    shifts = strip_em(shifts)

    def dump(o):
        return json.dumps(o, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")

    with open(PAGE, encoding="utf-8") as f:
        page = f.read()
    for tag, payload in (("mr-elements", elements), ("mr-dossiers", dossiers), ("mr-shifts", shifts)):
        pat = re.compile(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % tag, re.S)
        if not pat.search(page):
            problems.append("cannot find the %s script block" % tag); continue
        page = pat.sub(lambda m: m.group(1) + dump(payload) + m.group(3), page, count=1)
    with open(PAGE, "w", encoding="utf-8") as f:
        f.write(page)

    print("elements: %d   isotopes: %d   dossiers: %d   shift tables: %d (%d peaks)"
          % (len(elements), n_iso, len(dossiers), len(shifts),
             sum(len(t.get("peaks") or []) for t in shifts)))
    print("page: %.0f KB" % (os.path.getsize(PAGE)/1024))
    if problems:
        print("\nPROBLEMS (%d):" % len(problems))
        for p in problems: print("  *", p)
    if warnings:
        print("\nwarnings (%d):" % len(warnings))
        for w in warnings[:60]: print("  -", w)
        if len(warnings) > 60: print("  ... and %d more" % (len(warnings)-60))
    if not problems and not warnings: print("\nclean.")
    return 1 if problems else 0

sys.exit(main())
