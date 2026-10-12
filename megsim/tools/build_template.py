#!/usr/bin/env python3
"""Build the template head for the MEG simulator.

The head is the MNI ICBM152 2009c nonlinear symmetric template (Fonov et al.
2009, 2011), with the CerebrA atlas (Manera et al. 2020) in the same space,
both as distributed by TemplateFlow in tpl-MNI152NLin2009cSym at 1 mm:

    tpl-MNI152NLin2009cSym_res-1_T1w.nii.gz
    tpl-MNI152NLin2009cSym_res-1_label-GM_probseg.nii.gz
    tpl-MNI152NLin2009cSym_res-1_label-WM_probseg.nii.gz
    tpl-MNI152NLin2009cSym_res-1_label-CSF_probseg.nii.gz
    tpl-MNI152NLin2009cSym_res-1_atlas-CerebrA_dseg.nii.gz
    tpl-MNI152NLin2009cSym_atlas-CerebA_dseg.tsv   (the atlas's label table;
        TemplateFlow spells it CerebA; cerebra.tsv is accepted too)

Usage:  python3 build_template.py SOURCE_DIR MEGSIM_DIR

Needs numpy and scipy.  Writes MEGSIM_DIR/data/mni152.bin.gz (the T1, an
atlas label for every voxel and the scalp's signed distance) and
MEGSIM_DIR/js/template.js (the head frame, the landmarks, the 10-10
electrodes, the sites of the built-in generators, the scalp's distance from
the centre in every direction, and the source grid's mask).

Frames.  Template millimetres are the template's own (MNI) coordinates.  The
simulator's head is the template shrunk to fit its 9.2 cm sphere: the MRI
frame is template mm x scale / 10, in cm, and the head frame (cm) has its
origin at the centre of the sphere fitted to the scalp, x through the
preauricular points, y toward the nasion and z up.
"""
import base64
import gzip
import json
import os
import struct
import sys

import numpy as np
from scipy import ndimage
from scipy.optimize import least_squares

PREFIX = 'tpl-MNI152NLin2009cSym_res-1_'
SKIN = 20.0                 # the skin's level on the smoothed T1 (air about 2, scalp about 60)
HEAD_R = 9.2                # radius of the simulator's sphere, cm
STEP = 1.5                  # voxel of the shipped T1 and labels, template mm
STEP_SDF = 3.0              # voxel of the shipped signed distance, template mm
BOX = (np.array([-94.5, -125.0, -78.0]), np.array([94.5, 96.0, 110.0]))          # x = 0 on the grid
BOX_SDF = (np.array([-105.0, -141.0, -90.0]), np.array([105.0, 114.0, 126.0]))   # with room around the head
GRID_SPACING, GRID_LIM = 0.6, 15   # source grid, cm and half-width in steps
T1_FULL = 95.0              # T1 value shown as white

# ------------------------------------------------------------------ reading
DT = {2: np.uint8, 4: np.int16, 8: np.int32, 16: np.float32, 64: np.float64, 256: np.int8, 512: np.uint16}


def load_nii(path):
    raw = gzip.open(path, 'rb').read()
    end = '<' if struct.unpack('<i', raw[:4])[0] == 348 else '>'
    dim = struct.unpack(end + '8h', raw[40:56])
    datatype = struct.unpack(end + 'h', raw[70:72])[0]
    vox_offset = int(struct.unpack(end + 'f', raw[108:112])[0])
    slope, inter = struct.unpack(end + '2f', raw[112:120])
    srow = np.array(struct.unpack(end + '12f', raw[280:328])).reshape(3, 4)
    shape = tuple(dim[1:1 + dim[0]])
    dt = np.dtype(DT[datatype]).newbyteorder(end)
    data = np.frombuffer(raw, dtype=dt, count=int(np.prod(shape)), offset=vox_offset)
    data = data.reshape(shape, order='F').astype(np.float32)
    if slope not in (0.0, 1.0) and slope == slope:
        data = data * slope + inter
    if not np.allclose(srow[:, :3], np.eye(3)):
        raise SystemExit('expected a 1 mm, axis-aligned template: ' + path)
    return data, srow[:, 3].copy()


def load_tsv(path):
    rows = [line.rstrip('\n').split('\t') for line in open(path, encoding='utf-8')]
    head = rows[0]
    return [dict(zip(head, r)) for r in rows[1:] if r and r[0]]


# ------------------------------------------------------------------ geometry
def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v)


def ball(r):
    k = int(np.ceil(r))
    x, y, z = np.mgrid[-k:k + 1, -k:k + 1, -k:k + 1]
    return x * x + y * y + z * z <= r * r


def largest(mask):
    lab, n = ndimage.label(mask)
    if n == 0:
        return mask
    sz = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (1 + int(np.argmax(sz)))


class Head:
    """The template's volumes and masks, in template mm (1 mm voxels)."""

    def __init__(self, src):
        P = lambda n: os.path.join(src, PREFIX + n + '.nii.gz')
        self.T, self.o = load_nii(P('T1w'))
        self.hi = self.o + np.array(self.T.shape) - 1
        self.Ts = ndimage.gaussian_filter(self.T, 0.8)
        self.GM = load_nii(P('label-GM_probseg'))[0]
        self.WM = load_nii(P('label-WM_probseg'))[0]
        self.CSF = load_nii(P('label-CSF_probseg'))[0]
        self.LAB = load_nii(P('atlas-CerebrA_dseg'))[0].astype(np.int16)
        # the head: the largest piece above the skin level, every slice filled,
        # because the dark skull reaches the cut edge of the volume
        m = largest(self.Ts > SKIN)
        for k in range(m.shape[2]):
            m[:, :, k] = ndimage.binary_fill_holes(m[:, :, k])
        self.head = ndimage.binary_fill_holes(m)
        # the same head without the ears, for electrodes and sensors that sit on the scalp
        self.smooth = ndimage.gaussian_filter(ndimage.binary_opening(self.head, structure=ball(6)).astype(np.float32), 1.0)
        # inside the skull: grey matter, white matter and CSF
        tot = self.GM + self.WM + self.CSF
        self.icv = ndimage.binary_fill_holes(largest(tot > 0.5))
        self.brain = ((self.GM + self.WM) > 0.5) & ((self.GM + self.WM) > self.CSF)

    def sample(self, vol, P, order=1):
        P = np.asarray(P, float)
        idx = (P.reshape(-1, 3) - self.o).T
        return ndimage.map_coordinates(vol, idx, order=order, mode='constant', cval=0).reshape(P.shape[:-1])

    def hits(self, c, dirs, smooth=False, rmin=10.0, rmax=180.0, step=0.25):
        """The outermost skin crossing along rays from c (template mm)."""
        vol, thr = (self.smooth, 0.5) if smooth else (self.Ts, SKIN)
        dirs = np.atleast_2d(np.asarray(dirs, float))
        rs = np.arange(rmin, rmax, step)
        P = np.asarray(c, float)[None, None, :] + dirs[:, None, :] * rs[None, :, None]
        v = self.sample(vol, P)
        inside = v > thr
        n, m = inside.shape
        last = m - 1 - np.argmax(inside[:, ::-1], axis=1)
        v0 = v[np.arange(n), last]
        v1 = v[np.arange(n), np.minimum(last + 1, m - 1)]
        r = rs[last] + np.clip((v0 - thr) / np.maximum(v0 - v1, 1e-6), 0, 1) * step
        pts = np.asarray(c, float)[None, :] + dirs * r[:, None]
        edge = np.any((pts < self.o + 1.0) | (pts > self.hi - 1.0), axis=1) | ~inside.any(axis=1)
        return pts, edge

    def hit(self, c, d, smooth=False):
        return self.hits(c, unit(d)[None, :], smooth)[0][0]


def arc(head, centre, A, B, C, smooth=True, n=1600):
    """The skin curve from A through B to C in the plane of the three points.
    Rays fan out from the sphere's centre projected into the plane."""
    nrm = unit(np.cross(B - A, C - A))
    g = centre - nrm * np.dot(centre - A, nrm)
    e1 = unit(A - g)
    e2 = np.cross(nrm, e1)
    ang = lambda P: np.arctan2(np.dot(P - g, e2), np.dot(P - g, e1))
    if ang(B) < 0:
        e2 = -e2
    aC = ang(C)
    if aC < ang(B):
        aC += 2 * np.pi
    a = np.linspace(0, aC, n)
    dirs = np.cos(a)[:, None] * e1[None, :] + np.sin(a)[:, None] * e2[None, :]
    pts, _ = head.hits(g, dirs, smooth)
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    return pts, s


def along(curve, f):
    pts, s = curve
    t = f * s[-1]
    k = int(np.clip(np.searchsorted(s, t), 1, len(s) - 1))
    w = (t - s[k - 1]) / max(s[k] - s[k - 1], 1e-9)
    return pts[k - 1] * (1 - w) + pts[k] * w


def fit_sphere(pts, c0):
    def res(x):
        return np.linalg.norm(pts - x[:3], axis=1) - x[3]
    sol = least_squares(res, np.r_[c0, np.linalg.norm(pts - c0, axis=1).mean()])
    return sol.x[:3], sol.x[3], np.linalg.norm(pts - sol.x[:3], axis=1).std()


def surface(mask, o):
    return np.argwhere(mask & ~ndimage.binary_erosion(mask)) + o


# ------------------------------------------------------------------ landmarks and frame
def landmarks(h):
    # nasion: the deepest point of the midline profile between brow and nose
    zs = np.arange(-66, -24, 0.25)
    pts = np.array([h.hit([0, 0, z], [0, 1, 0]) for z in zs])
    NAS = pts[int(np.argmin(pts[:, 1]))]
    # the ear canal: the deepest point of the side of the head in front of the pinna
    best = None
    for y in np.arange(-40, -10, 1.0):
        for z in np.arange(-70, -40, 1.0):
            p = h.hit([0, y, z], [-1, 0, 0])
            if best is None or p[0] > best[0]:
                best = p
    canal = best
    # the preauricular points: on the skin 6 mm in front of the canal and 6 mm above it
    LPA = h.hit([0, canal[1] + 6, canal[2] + 6], [-1, 0, 0])
    RPA = LPA * np.array([-1, 1, 1])
    NAS[0] = 0.0
    return NAS, LPA, RPA, canal


def head_frame(h, NAS, LPA, RPA):
    ex = unit(RPA - LPA)
    O = LPA + ex * np.dot(NAS - LPA, ex)
    ey = unit(NAS - O)
    ez = np.cross(ex, ey)
    Rot = np.vstack([ex, ey, ez])               # rows: the head axes in template coordinates
    # the sphere: fitted to the scalp above the landmarks, leaving out the ears
    # and the face, as a lab fits it to the digitized head shape
    S = (surface(h.head, h.o) - O) @ Rot.T
    L, R = (LPA - O) @ Rot.T, (RPA - O) @ Rot.T
    sel = (S[:, 2] > 0) & (np.linalg.norm(S - L, axis=1) > 30) & (np.linalg.norm(S - R, axis=1) > 30)
    sel &= ~((S[:, 1] > 50) & (S[:, 2] < 40))
    c, radius, sd = fit_sphere(S[sel], np.array([0.0, 0.0, 50.0]))
    c[0] = 0.0                                  # the template is symmetric
    centre = O + Rot.T @ c                      # template mm
    scale = HEAD_R * 10 / radius
    return dict(Rot=Rot, centre=centre, scale=scale, radius=radius, sd=sd, O=O)


class Frames:
    def __init__(self, f):
        self.Rot, self.c, self.s = f['Rot'], f['centre'], f['scale']

    def head(self, P):          # template mm -> head cm
        return (np.asarray(P, float) - self.c) @ self.Rot.T * self.s / 10

    def tpl(self, Q):           # head cm -> template mm
        return np.asarray(Q, float) @ self.Rot * 10 / self.s + self.c


# ------------------------------------------------------------------ 10-10 electrodes
def electrodes(h, F, NAS, LPA, RPA, canal):
    c = F.c
    E = {'Nz': NAS.copy(), 'LPA': LPA, 'RPA': RPA}
    # the inion: the external occipital protuberance, on the midline at the back
    E['Iz'] = h.hit([0, -40, -22], [0, -1, 0], smooth=True)
    vertex = h.hit(c, F.Rot[2], smooth=True)
    mid = arc(h, c, E['Nz'], vertex, E['Iz'])
    for k, f in zip(['Fpz', 'AFz', 'Fz', 'FCz', 'Cz', 'CPz', 'Pz', 'POz', 'Oz'], np.arange(1, 10) / 10):
        E[k] = along(mid, f)
    cor = arc(h, c, LPA, E['Cz'], RPA)
    for k, f in zip(['T7', 'C5', 'C3', 'C1', 'C2', 'C4', 'C6', 'T8'], [.1, .2, .3, .4, .6, .7, .8, .9]):
        E[k] = along(cor, f)
    # the circumference, 10% above the nasion, preauricular points and inion
    ring = arc(h, c, E['Fpz'], E['T7'], E['Oz'])
    for k, f in zip(['Fp1', 'AF7', 'F7', 'FT7', 'TP7', 'P7', 'PO7', 'O1'], [.1, .2, .3, .4, .6, .7, .8, .9]):
        E[k] = along(ring, f)
    # the inferior chain through the nasion, preauricular point and inion
    low = arc(h, c, E['Nz'], LPA, E['Iz'])
    for k, f in zip(['F9', 'FT9', 'TP9', 'P9', 'PO9'], [.3, .4, .6, .7, .8]):
        E[k] = along(low, f)
    E['T9'] = LPA.copy()
    # mastoids: behind and below the ear canal
    E['M1'] = h.hit([0, canal[1] - 18, canal[2] - 10], [-1, 0, 0], smooth=True)
    # the rows between the circumference and the midline
    rows = [('AF7', 'AF5', 'AF3', 'AF1', 'AFz'), ('F7', 'F5', 'F3', 'F1', 'Fz'), ('FT7', 'FC5', 'FC3', 'FC1', 'FCz'),
            ('TP7', 'CP5', 'CP3', 'CP1', 'CPz'), ('P7', 'P5', 'P3', 'P1', 'Pz'), ('PO7', 'PO5', 'PO3', 'PO1', 'POz')]
    mirror = lambda p: np.asarray(p) * np.array([-1, 1, 1])
    for row in rows:
        a = arc(h, c, E[row[0]], E[row[4]], mirror(E[row[0]]))
        for k, name in enumerate(row[1:4]):
            E[name] = along(a, (k + 1) / 8)
    # the right side mirrors the left
    swap = {}
    for k in list(E):
        if k in ('LPA', 'RPA'):
            continue
        if k[-1] == 'z':
            E[k][0] = 0.0
            continue
        digits = ''.join(ch for ch in k if ch.isdigit())
        if digits and int(digits) % 2 == 1:
            right = k[:len(k) - len(digits)] + str(int(digits) + 1)
            swap[right] = mirror(E[k])
    E.update(swap)
    return E


# ------------------------------------------------------------------ generators
CORTICAL = ['Rostral Middle Frontal', 'Inferior temporal', 'Pericalcarine', 'Lateral Orbitofrontal', 'Rostral Anterior Cingulate',
            'Superior Parietal', 'Inferior Parietal', 'Lingual', 'Postcentral', 'Transverse Temporal', 'Medial Orbitofrontal',
            'Paracentral', 'Parahippocampal', 'Pars Triangularis', 'Insula', 'Fusiform', 'Middle Temporal',
            'Caudal Anterior Cingulate', 'Precuneus', 'Pars Opercularis', 'Isthmus Cingulate', 'Lateral Occipital', 'Precentral',
            'Entorhinal', 'Superior Frontal', 'Caudal Middle Frontal', 'Cuneus', 'Pars Orbitalis', 'Superior Temporal',
            'Posterior Cingulate', 'Supramarginal']


def code_of(atlas, name, hemi):
    for r in atlas:
        if r['name'] == name and r['hemi'] == hemi:
            return int(r['label'])
    raise KeyError(name + ' ' + hemi)


def inside_point(h, mask, target, pull=0.25):
    """A voxel of mask near target and as far inside the mask as possible."""
    d = ndimage.distance_transform_edt(mask)
    idx = np.argwhere(mask)
    P = idx + h.o
    score = d[mask] - pull * np.linalg.norm(P - target, axis=1)
    return P[int(np.argmax(score))].astype(float)


def generators(h, atlas):
    """Sites on the left; the right mirrors them (template and atlas are symmetric)."""
    grey = (h.GM > h.WM) & (h.GM > h.CSF)
    lab = lambda n, hemi='L': (h.LAB == code_of(atlas, n, hemi)) & grey
    mirror = lambda p: p * np.array([-1, 1, 1])
    out = {}
    # auditory cortex: the lateral half of Heschl's gyrus, where the M100 is fitted;
    # the right one a few millimetres further forward, as in most brains
    hg = lab('Transverse Temporal')
    P = np.argwhere(hg) + h.o
    lateral = P[np.abs(P[:, 0]) > np.median(np.abs(P[:, 0]))].mean(0)
    out['audL'] = inside_point(h, hg, lateral)
    out['audR'] = inside_point(h, lab('Transverse Temporal', 'R'), mirror(lateral) + np.array([0, 4.0, 0]))
    # hand area: the two walls of the central sulcus at the hand knob
    pre, post = lab('Precentral'), lab('Postcentral')
    zone = np.zeros_like(pre)
    x0 = int(round(-h.o[0]))
    zone[x0 - 46:x0 - 27, :, int(round(45 - h.o[2])):int(round(63 - h.o[2]))] = True
    wall3b = post & (ndimage.distance_transform_edt(~pre) < 4) & zone
    wall4 = pre & (ndimage.distance_transform_edt(~post) < 4) & zone
    out['s1L'] = inside_point(h, post, (np.argwhere(wall3b) + h.o).mean(0), pull=0.6)
    out['m1L'] = inside_point(h, pre, (np.argwhere(wall4) + h.o).mean(0), pull=0.6)
    # alpha: the cuneus where it lines the calcarine sulcus
    cun, cal = lab('Cuneus'), lab('Pericalcarine')
    wall = np.argwhere(cun & (ndimage.distance_transform_edt(~cal) < 4)) + h.o
    wall = wall[(wall[:, 0] <= -8) & (wall[:, 1] <= -76)]   # off the midline and back toward the pole
    out['alphaL'] = inside_point(h, cun, wall.mean(0), pull=0.6)
    for k in ('s1', 'm1', 'alpha'):
        out[k + 'R'] = mirror(out[k + 'L'])
    return out


# ------------------------------------------------------------------ labels
# codes above the atlas's 1..102
DEEP_WM, CSF_OUT, SKULL, SCALP, EYE, SOFT, AIR, NOSE, CSF_IN, CALLOSUM, DURA = 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113
WM_OF = 128                 # 128 + k: the white matter of cortical label k


def find_eyes(h):
    """The globes: a dark ball (the vitreous) inside a bright shell (orbital fat), left then mirrored."""
    r1, r2 = 9, 14
    k = np.arange(-r2, r2 + 1)
    X, Y, Z = np.meshgrid(k, k, k, indexing='ij')
    R = np.sqrt(X ** 2 + Y ** 2 + Z ** 2)
    inner = (R <= r1).astype(np.float32)
    shell = ((R > r1 + 1) & (R <= r2)).astype(np.float32)
    i0 = lambda v, a: int(round(v - h.o[a]))
    sub = h.T[i0(-60, 0):i0(-10, 0), i0(30, 1):i0(90, 1), i0(-65, 2):i0(-15, 2)]
    score = ndimage.convolve(sub, shell / shell.sum(), mode='nearest') - ndimage.convolve(sub, inner / inner.sum(), mode='nearest')
    j = np.unravel_index(np.argmax(score), score.shape)
    left = np.array([-60.0 + j[0], 30.0 + j[1], -65.0 + j[2]])
    return [left, left * np.array([-1, 1, 1])]


def label_volume(h, atlas, F, NAS, LPA, eyes):
    L = h.LAB.copy()
    cort_codes = [int(r['label']) for r in atlas if r['name'] in CORTICAL]
    cortex = np.isin(L, cort_codes)
    tot = h.GM + h.WM + h.CSF
    gm = (h.GM > h.WM) & (h.GM > h.CSF) & (tot > 0.3)
    wm = (h.WM >= h.GM) & (h.WM > h.CSF) & (tot > 0.3)
    csf = h.icv & ~gm & ~wm
    out = np.zeros(L.shape, np.uint8)
    # the atlas where it labels the voxel; cortical labels on white matter become that gyrus's white matter
    lab = L > 0
    out[lab] = L[lab]
    out[lab & wm & cortex] = WM_OF + L[lab & wm & cortex]
    # unlabelled white matter: named after the nearest cortex within 7 mm
    d_cx, (ix, iy, iz) = ndimage.distance_transform_edt(~cortex, return_indices=True)
    nearest = L[ix, iy, iz]
    free = ~lab & h.icv
    m = free & wm & (d_cx <= 7)
    out[m] = WM_OF + nearest[m]
    xs = np.arange(L.shape[0])[:, None, None] + h.o[0]
    ys = np.arange(L.shape[1])[None, :, None] + h.o[1]
    zs = np.arange(L.shape[2])[None, None, :] + h.o[2]
    m = free & wm & (d_cx > 7)
    out[m] = DEEP_WM
    out[m & (np.abs(xs) <= 6) & (zs > -5) & (zs < 40) & (ys > -45) & (ys < 40)] = CALLOSUM
    # unlabelled grey matter: the nearest atlas label
    d_any, (jx, jy, jz) = ndimage.distance_transform_edt(~lab, return_indices=True)
    m = free & gm
    out[m] = L[jx, jy, jz][m]
    # CSF: over the brain, or down in a sulcus or cistern
    d_out = ndimage.distance_transform_edt(h.icv)
    m = free & csf
    out[m & (d_out <= 4)] = CSF_OUT
    out[m & (d_out > 4)] = CSF_IN
    # the falx, the tentorium and the venous sinuses: in the clefts of the brain's outline
    closed = ndimage.binary_fill_holes(ndimage.binary_closing(h.icv, structure=ball(6)))
    out[closed & ~h.icv & ~lab & h.head] = DURA
    # outside the skull
    rest = h.head & ~closed & ~lab
    d_icv = ndimage.distance_transform_edt(~h.icv)
    d_skin = ndimage.distance_transform_edt(h.head)
    dark = h.Ts < 32
    above = zs > LPA[2] - 4
    frac = d_icv / np.maximum(d_icv + d_skin, 1e-6)
    out[rest & dark & (d_icv <= 13)] = SKULL
    out[rest & dark & (d_icv > 13) & (ys > 0) & (zs < -20)] = AIR
    out[rest & dark & (d_icv > 13) & ~((ys > 0) & (zs < -20))] = SKULL
    bright = rest & ~dark
    out[bright & above & (frac >= 0.4)] = SCALP
    out[bright & above & (frac < 0.4)] = SKULL           # the diploe, between the two tables
    out[bright & ~above] = SOFT
    out[bright & ~above & (d_skin <= 4)] = SCALP
    out[rest & (d_skin <= 3)] = SCALP                    # the skin itself, whatever its partial volume
    for c in eyes:
        out[rest & ((xs - c[0]) ** 2 + (ys - c[1]) ** 2 + (zs - c[2]) ** 2 <= 11.5 ** 2)] = EYE
    out[rest & (np.abs(xs) < 16) & (zs < NAS[2] + 3) & (ys > 70)] = NOSE
    out[~h.head] = 0
    return out


FRIENDLY = {
    'Transverse Temporal': "Heschl's gyrus (primary auditory cortex)",
    'Superior Temporal': 'superior temporal gyrus', 'Middle Temporal': 'middle temporal gyrus', 'Inferior temporal': 'inferior temporal gyrus',
    'Fusiform': 'fusiform gyrus', 'Parahippocampal': 'parahippocampal gyrus', 'Entorhinal': 'entorhinal cortex', 'Insula': 'insula',
    'Precentral': 'precentral gyrus (primary motor)', 'Postcentral': 'postcentral gyrus (primary somatosensory)',
    'Paracentral': 'paracentral lobule', 'Superior Frontal': 'superior frontal gyrus',
    'Caudal Middle Frontal': 'middle frontal gyrus, caudal part', 'Rostral Middle Frontal': 'middle frontal gyrus, rostral part',
    'Pars Opercularis': 'inferior frontal gyrus, pars opercularis', 'Pars Triangularis': 'inferior frontal gyrus, pars triangularis',
    'Pars Orbitalis': 'inferior frontal gyrus, pars orbitalis', 'Lateral Orbitofrontal': 'lateral orbitofrontal cortex',
    'Medial Orbitofrontal': 'medial orbitofrontal cortex', 'Rostral Anterior Cingulate': 'anterior cingulate, rostral part',
    'Caudal Anterior Cingulate': 'anterior cingulate, caudal part', 'Posterior Cingulate': 'posterior cingulate',
    'Isthmus Cingulate': 'isthmus of the cingulate gyrus', 'Precuneus': 'precuneus', 'Superior Parietal': 'superior parietal lobule',
    'Inferior Parietal': 'inferior parietal lobule', 'Supramarginal': 'supramarginal gyrus', 'Cuneus': 'cuneus',
    'Pericalcarine': 'calcarine cortex (primary visual)', 'Lingual': 'lingual gyrus', 'Lateral Occipital': 'lateral occipital cortex',
    'Thalamus': 'thalamus', 'Caudate': 'caudate nucleus', 'Putamen': 'putamen', 'Pallidum': 'globus pallidus',
    'Accumbens Area': 'nucleus accumbens', 'Hippocampus': 'hippocampus', 'Amygdala': 'amygdala',
    'Ventral Diencephalon': 'ventral diencephalon (hypothalamus)', 'Basal Forebrain': 'basal forebrain',
    'Lateral Ventricle': 'lateral ventricle', 'Inferior Lateral Ventricle': 'temporal horn of the lateral ventricle',
    'Cerebellum Gray Matter': 'cerebellar cortex', 'Cerebellum White Matter': 'cerebellar white matter',
    # midline structures, named without a side
    'Brainstem': 'brainstem', 'Third Ventricle': 'third ventricle', 'Fourth Ventricle': 'fourth ventricle',
    'Optic Chiasm': 'optic chiasm', 'Vermal lobules I-V': 'cerebellar vermis', 'Vermal lobules VI-VII': 'cerebellar vermis',
    'Vermal lobules VIII-X': 'cerebellar vermis'
}
MIDLINE = {'Brainstem', 'Third Ventricle', 'Fourth Ventricle', 'Optic Chiasm', 'Vermal lobules I-V', 'Vermal lobules VI-VII', 'Vermal lobules VIII-X'}
TISSUE = {'Lateral Ventricle': 'CSF', 'Inferior Lateral Ventricle': 'CSF', 'Third Ventricle': 'CSF', 'Fourth Ventricle': 'CSF',
          'Cerebellum White Matter': 'white matter', 'Brainstem': 'white matter', 'Optic Chiasm': 'white matter'}


def names_table(atlas):
    names = [['outside the head', '', 'air']] + [None] * 102
    for r in atlas:
        k = int(r['label'])
        side = '' if r['name'] in MIDLINE else r['hemi']
        names[k] = [FRIENDLY[r['name']], side, TISSUE.get(r['name'], 'grey matter')]
    names += [['deep white matter', 'x', 'white matter'], ['CSF, outside the brain', '', 'CSF'], ['skull', '', 'skull'],
              ['scalp', '', 'scalp'], ['eye', 'x', 'eye'], ['muscle and fat of the face and neck', '', 'muscle'],
              ['air in a sinus or the nasal cavity', '', 'air'], ['the nose', '', 'scalp'], ['CSF in a sulcus', '', 'CSF'],
              ['corpus callosum', '', 'white matter'], ['dura and venous sinus', '', 'dura']]
    return names


# ------------------------------------------------------------------ shipped volumes
def resample(vol, origin, box, step, order):
    lo, hi = box
    ax = [np.arange(lo[k], hi[k] + 1e-6, step) for k in range(3)]
    X, Y, Z = np.meshgrid(*ax, indexing='ij')
    idx = np.array([X - origin[0], Y - origin[1], Z - origin[2]]).reshape(3, -1)
    out = ndimage.map_coordinates(vol, idx, order=order, mode='nearest').reshape(X.shape)
    return out, [len(a) for a in ax]


def predict(a):
    """Plane predictor per axial slice (x fastest): residual of left + up - upleft, mod 256."""
    a = a.astype(np.int16)
    pred = np.zeros_like(a)
    pred[:, 1:, 1:] = a[:, 1:, :-1] + a[:, :-1, 1:] - a[:, :-1, :-1]
    pred[:, 0, 1:] = a[:, 0, :-1]
    pred[:, 1:, 0] = a[:, :-1, 0]
    return ((a - pred) % 256).astype(np.uint8)


def volumes(h, labels):
    near = ndimage.binary_dilation(h.head, iterations=3)
    t1, dims = resample(np.where(near, h.T, 0), h.o, BOX, STEP, 1)
    t1 = np.clip(np.round(t1 / T1_FULL * 255), 0, 255).astype(np.uint8)
    lab, _ = resample(labels.astype(np.float32), h.o, BOX, STEP, 0)
    lab = lab.astype(np.uint8)
    # the scalp's signed distance (template mm, outside positive), with the cut edges of the template as air
    P = 40
    pad = np.pad(h.head, P)
    sd = ndimage.distance_transform_edt(~pad) - ndimage.distance_transform_edt(pad)
    sd = ndimage.gaussian_filter(np.where(sd > 0, sd - 0.5, sd + 0.5), 0.7)
    sdf, dims_s = resample(sd, h.o - P, BOX_SDF, STEP_SDF, 1)
    sdf = np.clip(np.round(sdf * 2) + 128, 0, 255).astype(np.uint8)
    zyx = lambda a: np.ascontiguousarray(a.transpose(2, 1, 0))
    blocks = [predict(zyx(t1)).tobytes(), zyx(lab).tobytes(), predict(zyx(sdf)).tobytes()]
    return blocks, dims, dims_s, lab


def snap(lab, code, target, pull=0.5, min_x=0.0):
    """The centre of a shipped label voxel of `code` near target and deep inside the region,
    so that looking the site up in the shipped labels cannot land on a neighbour."""
    m = lab == code
    xs = np.arange(lab.shape[0]) * STEP + BOX[0][0]
    m &= (np.abs(xs) >= min_x)[:, None, None]
    d = ndimage.distance_transform_edt(m) * STEP
    P = np.argwhere(m) * STEP + BOX[0]
    return P[int(np.argmax(d[m] - pull * np.linalg.norm(P - target, axis=1)))]


# ------------------------------------------------------------------ scalp table, grid, rim
def scalp_table(h, F, dth=4, dph=4, thmax=136):
    ths = np.arange(0, thmax + 1e-6, dth)
    phs = np.arange(0, 360, dph)
    T, Pp = np.meshgrid(np.radians(ths), np.radians(phs), indexing='ij')
    U = np.stack([np.sin(T) * np.sin(Pp), np.sin(T) * np.cos(Pp), np.cos(T)], -1).reshape(-1, 3)
    dirs = U @ F.Rot                         # head directions in template coordinates
    pts, edge = h.hits(F.c, dirs, smooth=True)
    r = np.linalg.norm(F.head(pts), axis=1).reshape(T.shape)
    edge = edge.reshape(T.shape)
    for i in range(r.shape[0]):              # where a ray leaves through the cut edge, keep the row above
        if i and edge[i].any():
            r[i, edge[i]] = r[i - 1, edge[i]]
    return dict(dTheta=dth, dPhi=dph, nTheta=len(ths), nPhi=len(phs), r=r)


def grid_mask(h, F, shipped, names):
    """The source grid's points in the brain: grey or white matter by the probability
    maps, and by the shipped labels too, so the atlas never names a grid point CSF."""
    k = np.arange(-GRID_LIM, GRID_LIM + 1)
    I, J, K = np.meshgrid(k, k, k, indexing='ij')
    Q = np.stack([I, J, K], -1).reshape(-1, 3) * GRID_SPACING     # head cm
    P = F.tpl(Q)
    par = h.sample(h.GM + h.WM, P)
    csf = h.sample(h.CSF, P)
    r = np.linalg.norm(Q, axis=1)
    idx = np.round((P - BOX[0]) / STEP).astype(int)
    inside = np.all((idx >= 0) & (idx < np.array(shipped.shape)), axis=1)
    codes = np.zeros(len(P), int)
    codes[inside] = shipped[idx[inside, 0], idx[inside, 1], idx[inside, 2]]
    brain_code = np.zeros(256, bool)
    for c in range(256):
        e = names[c - WM_OF] if WM_OF < c <= WM_OF + 102 else (names[c] if c < len(names) else None)
        brain_code[c] = bool(e) and (c > WM_OF or e[2] in ('grey matter', 'white matter'))
    ok = (par > 0.5) & (par > csf) & (r >= 0.6) & brain_code[codes]
    # bit n is grid point (i, j, k) with n = ((k + lim) * w + (j + lim)) * w + (i + lim)
    w = 2 * GRID_LIM + 1
    bits = np.zeros(w ** 3, np.uint8)
    flat = ((K.ravel() + GRID_LIM) * w + (J.ravel() + GRID_LIM)) * w + (I.ravel() + GRID_LIM)
    bits[flat[ok]] = 1
    return np.packbits(bits, bitorder='little'), int(ok.sum()), Q[ok]


def rim(h, F, n=200):
    """Points on the brain's outer surface, along evenly spread directions."""
    i = np.arange(n) + 0.5
    z = 1 - 2 * i / n
    ph = np.pi * (1 + 5 ** 0.5) * i
    U = np.stack([np.sqrt(1 - z * z) * np.sin(ph), np.sqrt(1 - z * z) * np.cos(ph), z], -1)
    U = U[U[:, 2] > -0.45]
    dirs = U @ F.Rot
    rs = np.arange(5, 110, 0.5)
    P = F.c[None, None, :] + dirs[:, None, :] * rs[None, :, None]
    v = h.sample(h.brain.astype(np.float32), P) > 0.5
    out = []
    for k in range(len(U)):
        if v[k].any():
            last = len(rs) - 1 - int(np.argmax(v[k][::-1]))
            out.append(F.head(F.c + dirs[k] * rs[last]))
    return np.array(out)


# ------------------------------------------------------------------ writing
def r3(v, nd=3):
    return [round(float(x), nd) for x in v]


def main(src, dst):
    tables = ['tpl-MNI152NLin2009cSym_atlas-CerebA_dseg.tsv', 'tpl-MNI152NLin2009cSym_atlas-CerebrA_dseg.tsv', 'cerebra.tsv']
    table = next((os.path.join(src, t) for t in tables if os.path.exists(os.path.join(src, t))), None)
    if not table:
        raise SystemExit('the CerebrA label table is missing: ' + tables[0])
    atlas = load_tsv(table)
    h = Head(src)
    NAS, LPA, RPA, canal = landmarks(h)
    f = head_frame(h, NAS, LPA, RPA)
    F = Frames(f)
    print('nasion %s  LPA %s  ear canal %s (template mm)' % (r3(NAS, 1), r3(LPA, 1), r3(canal, 1)))
    print('sphere: centre %s template mm, radius %.1f mm (sd %.1f), scale %.4f' % (r3(f['centre'], 1), f['radius'], f['sd'], f['scale']))
    E = electrodes(h, F, NAS, LPA, RPA, canal)
    G = generators(h, atlas)
    eyes = find_eyes(h)
    labels = label_volume(h, atlas, F, NAS, LPA, eyes)
    blocks, dims, dims_s, shipped = volumes(h, labels)
    regions = {'aud': 'Transverse Temporal', 's1': 'Postcentral', 'm1': 'Precentral', 'alpha': 'Cuneus'}
    # the alpha sites stay a centimetre off the midline, so the two sides are apart
    G = {k: snap(shipped, code_of(atlas, regions[k[:-1]], k[-1]), p, min_x=9.0 if k.startswith('alpha') else 0.0) for k, p in G.items()}
    # the right sites mirror the left where the mirror voxel is in the same region (the template is symmetric)
    for k in ('s1', 'm1', 'alpha'):
        q = G[k + 'L'] * np.array([-1, 1, 1])
        i = np.round((q - BOX[0]) / STEP).astype(int)
        if shipped[tuple(i)] == code_of(atlas, regions[k], 'R'):
            G[k + 'R'] = q
    table = scalp_table(h, F)
    names = names_table(atlas)
    bits, ngrid, gpts = grid_mask(h, F, shipped, names)
    rimp = rim(h, F)
    for k, p in G.items():
        q = F.head(p)
        print('%-7s template %s  head %s cm  r %.2f  depth %.2f' % (k, r3(p, 1), r3(q, 2), np.linalg.norm(q), HEAD_R - np.linalg.norm(q)))
    print('grid points', ngrid, ' max r %.2f' % np.linalg.norm(gpts, axis=1).max())
    print('scalp r: min %.2f max %.2f (cm)' % (table['r'].min(), table['r'].max()))
    data = b''.join(blocks)
    os.makedirs(os.path.join(dst, 'data'), exist_ok=True)
    with open(os.path.join(dst, 'data', 'mni152.bin.gz'), 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as fh:
            fh.write(data)
    size = os.path.getsize(os.path.join(dst, 'data', 'mni152.bin.gz'))
    print('wrote data/mni152.bin.gz, %.0f KB (%d bytes uncompressed)' % (size / 1024, len(data)))
    toMRI = dict(R=[r3(row, 9) for row in F.Rot.T], t=r3(F.c * F.s / 10, 6))
    meta = {
        'name': 'MNI ICBM152 2009c nonlinear symmetric template',
        'scale': round(float(F.s), 5),
        'sphere': dict(centre=r3(F.c, 2), radius=round(float(f['radius']), 2), sd=round(float(f['sd']), 2)),
        'toMRI': toMRI,
        'fid': {k: r3(F.head(v)) for k, v in (('NAS', NAS), ('LPA', LPA), ('RPA', RPA))},
        'elec': {k: r3(F.head(v)) for k, v in E.items()},
        'gen': {k: r3(F.head(v)) for k, v in G.items()},
        'eyes': [r3(F.head(p), 2) for p in eyes],
        'canal': [r3(F.head(canal), 2), r3(F.head(canal * np.array([-1, 1, 1])), 2)],
        'scalp': dict(dTheta=table['dTheta'], dPhi=table['dPhi'], nTheta=table['nTheta'], nPhi=table['nPhi'],
                      r=base64.b64encode(np.round(table['r'] * 1000).astype('<u2').tobytes()).decode()),
        'grid': dict(spacing=GRID_SPACING, lim=GRID_LIM, n=ngrid, mask=base64.b64encode(bits.tobytes()).decode()),
        'rim': [r3(p, 2) for p in rimp],
        'volume': dict(file='data/mni152.bin.gz', bytes=len(data), lo=r3(BOX[0], 1),
                       t1=dict(dims=dims, step=STEP, full=T1_FULL), labels=dict(dims=dims, step=STEP),
                       sdf=dict(dims=dims_s, lo=r3(BOX_SDF[0], 1), step=STEP_SDF, unit=0.5, zero=128)),
        'names': names,
        'wmOf': WM_OF
    }
    js = ('/* MEG simulator: the template head, measured from the MNI ICBM152 2009c\n'
          '   nonlinear symmetric template and the CerebrA atlas by tools/build_template.py.\n'
          '   Generated; do not edit by hand.  Head-frame positions are in cm, with the\n'
          '   origin at the centre of the conductor sphere.  See data/README.md for the\n'
          '   sources and their licences. */\n'
          "(function (G) {\n  'use strict';\n  G.MEG = G.MEG || {};\n  G.MEG.TEMPLATE = " +
          json.dumps(meta, separators=(',', ':')) +
          ";\n})(typeof window !== 'undefined' ? window : globalThis);\n")
    with open(os.path.join(dst, 'js', 'template.js'), 'w', encoding='utf-8') as fh:
        fh.write(js)
    print('wrote js/template.js, %.0f KB' % (len(js) / 1024))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
