/* ============================================================
   PET Simulator, protocol presets
   A library of scan protocols written in the simulator's own
   language (see dsl.js and its language reference). They are the
   starting point of every lesson, so they are commented the way a
   careful instructor would comment a handout: one short note per
   line that is not obvious.

   The ids, phantoms and phantom options are referenced by the
   lessons and the app (ARCHITECTURE.md section 7.6), so keep them
   stable. Every preset names its injected activity DOSE, and its
   uptake time UPTAKE and scan length DUR where those apply, so a
   lesson can set "UPTAKE" whichever protocol is loaded. Dynamic
   protocols start their frames at the injection and have no
   UPTAKE or DUR; their framing is the lesson.

   Dynamic presets switch TOF off only to keep twenty frames quick
   to simulate in the browser; the comment in each says so, because
   real scanners keep TOF on for dynamic studies too.

   Nothing here touches the DOM.
   ============================================================ */
(function (root) {
    'use strict';
    const PET = root.PET;

    const list = [];
    function add(id, name, group, phantom, phantomOpts, summary, source) {
        list.push({ id, name, group, summary, phantom, phantomOpts, source: source.replace(/^\n/, '') });
    }

    /* ---------- Brain, static ---------- */

    add('first', 'Your first protocol', 'brain', 'brain', { condition: 'normal' },
        'A static FDG brain scan with every line explained. Start here.', `
# Your first protocol: a static FDG brain scan.
# FDG is a glucose look-alike. Injected into a vein, it is taken up
# by cells that burn glucose and then trapped inside them, so after
# about 45 minutes the gray matter, the brain's hungriest tissue, is
# bright. The scanner then counts coincidences for a few minutes.
# Lines starting with # are comments; the simulator ignores them.
protocol "Your first protocol"   # the name the simulator shows

# Three values you can change with sliders: name = value, the slider
# range, and a description.
param DOSE   = 185 MBq  range 40 MBq .. 400 MBq  "injected activity"
param UPTAKE = 45 min   range 0 min .. 90 min    "injection to scan start"
param DUR    = 10 min   range 1 min .. 30 min    "how long the scanner counts"

tracer FDG          # the molecule injected: [18F]fluorodeoxyglucose
isotope F18         # optional: FDG already implies fluorine-18 (half-life 110 min)
weight 70 kg        # body weight, used to turn Bq/mL into SUV
inject DOSE         # the injection starts the clock: time zero
wait UPTAKE         # the patient rests while the brain takes up FDG
static DUR          # one frame: count coincidences for DUR

energy 435 keV .. 650 keV  # keep photons near 511 keV, drop most scattered ones
coincidence 4.5 ns         # two photons this close in time form one event
tof on 400 ps              # arrival-time difference places the event on its line
mode 3D                    # no septa between rings: the most sensitive mode
`);

    add('fdg_static', 'FDG brain, static', 'brain', 'brain', { condition: 'normal' },
        'The clinical standard: 185 MBq FDG, 45 min uptake, one 10 min frame with time of flight.', `
# FDG brain scan, static: the clinical standard.
# By 45 min after injection most of the FDG in gray matter has been
# phosphorylated and trapped, and the image changes slowly, so one
# 10 min frame shows glucose metabolism. Read it as SUV, or as SUVR
# against a reference region.
protocol "FDG brain, static"

param DOSE   = 185 MBq  range 40 MBq .. 400 MBq  "injected activity"
param UPTAKE = 45 min   range 0 min .. 120 min   "injection to scan start"
param DUR    = 10 min   range 1 min .. 30 min    "scan duration"

tracer FDG              # [18F]fluorodeoxyglucose
weight 70 kg            # for SUV
inject DOSE             # bolus at time 0
wait UPTAKE             # quiet, dim room: talking or reading would alter uptake
static DUR              # one frame

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    add('pib_static', 'PiB amyloid, static', 'brain', 'brain', { condition: 'ad' },
        '[11C]PiB 400 MBq, imaged 50 to 70 min after injection; an Alzheimer brain shows cortical amyloid.', `
# [11C]PiB amyloid scan, static, 50 to 70 min.
# PiB binds fibrillar amyloid plaques. By 50 min the free tracer has
# washed out of normal cortex, so the ratio of cortex to cerebellar
# gray matter (SUVR) reflects plaque load. Carbon-11 lasts only
# 20 min, so the scanner has to be next to the cyclotron.
protocol "PiB amyloid, static"

param DOSE   = 400 MBq  range 100 MBq .. 600 MBq  "injected activity"
param UPTAKE = 50 min   range 30 min .. 90 min    "injection to scan start"
param DUR    = 20 min   range 5 min .. 30 min     "scan duration"

tracer PiB              # Pittsburgh compound B, labelled with 11C
weight 70 kg
inject DOSE
wait UPTAKE             # 2.5 half-lives: less than a fifth of the activity is left
static DUR              # the usual SUVR window is 50 to 70 min

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    add('fbb_static', 'Florbetaben amyloid, static', 'brain', 'brain', { condition: 'ad' },
        '[18F]florbetaben 300 MBq, imaged 90 to 110 min after injection: amyloid with a longer-lived label.', `
# [18F]florbetaben amyloid scan, static, 90 to 110 min.
# Florbetaben binds the same plaques as PiB but carries fluorine-18,
# so it can be shipped from a cyclotron to any clinic. It clears
# from normal tissue more slowly than PiB, so imaging starts later,
# and its specific signal is smaller.
protocol "Florbetaben amyloid, static"

param DOSE   = 300 MBq  range 100 MBq .. 500 MBq  "injected activity"
param UPTAKE = 90 min   range 45 min .. 130 min   "injection to scan start"
param DUR    = 20 min   range 5 min .. 30 min     "scan duration"

tracer florbetaben
weight 70 kg
inject DOSE
wait UPTAKE             # still under one half-life of 18F: plenty of counts
static DUR              # read as SUVR against cerebellar gray matter

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    add('fepe2i_static', 'FE-PE2I dopamine transporter, static', 'brain', 'brain', { condition: 'pd' },
        '[18F]FE-PE2I 200 MBq, imaged 20 to 40 min after injection; a Parkinson brain shows putamen loss.', `
# [18F]FE-PE2I dopamine transporter scan, static, 20 to 40 min.
# FE-PE2I binds the dopamine transporter on the terminals of the
# nigrostriatal neurons, which end in the putamen and caudate. In
# Parkinson's disease the posterior putamen loses its terminals
# first, usually more on one side.
protocol "FE-PE2I dopamine transporter, static"

param DOSE   = 200 MBq  range 50 MBq .. 350 MBq  "injected activity"
param UPTAKE = 20 min   range 0 min .. 60 min    "injection to scan start"
param DUR    = 20 min   range 5 min .. 30 min    "scan duration"

tracer FE-PE2I          # the hyphen is part of the name
weight 70 kg
inject DOSE
wait UPTAKE             # FE-PE2I settles quickly, so a short uptake is enough
static DUR              # read as striatum-to-cerebellum SUVR

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    /* ---------- Dynamic ---------- */

    add('fdg_dynamic', 'FDG brain, dynamic', 'dynamic', 'brain', { condition: 'normal' },
        'FDG from injection to 60 min in 20 frames, for the input function, tissue curves and a Patlak plot.', `
# FDG brain scan, dynamic, 0 to 60 min.
# The frames start at the injection and follow the tracer from its
# arrival in the blood to its trapping in tissue. Short frames catch
# the fast early changes; longer ones keep the noise down later,
# when little changes. Fit the regional curves with the two-tissue
# irreversible model, or a Patlak plot, to measure Ki.
protocol "FDG brain, dynamic"

param DOSE = 185 MBq  range 40 MBq .. 400 MBq  "injected activity"

tracer FDG
weight 70 kg
inject DOSE             # the first frame starts with the injection
frames 6 x 10 s         # 0 to 1 min: the bolus arrives and peaks
frames 3 x 20 s         # 1 to 2 min
frames 2 x 90 s         # 2 to 5 min: the blood curve falls
frames 5 x 3 min        # 5 to 20 min: trapped FDG builds up in tissue
frames 4 x 10 min       # 20 to 60 min: the Patlak plot uses these

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof off                 # off only for simulation speed; real scans keep TOF on
mode 3D
`);

    add('pib_dynamic', 'PiB amyloid, dynamic', 'dynamic', 'brain', { condition: 'ad' },
        '[11C]PiB from injection to 70 min in 20 frames, for a Logan plot with the cerebellum as reference.', `
# [11C]PiB amyloid scan, dynamic, 0 to 70 min.
# Frames from the injection give the whole time-activity curve of
# every region. With cerebellar gray matter as the reference region,
# a Logan plot of the late frames gives the distribution volume
# ratio DVR, and BPND = DVR - 1, with no arterial blood sampling.
protocol "PiB amyloid, dynamic"

param DOSE = 400 MBq  range 100 MBq .. 600 MBq  "injected activity"

tracer PiB
weight 70 kg
inject DOSE
frames 6 x 20 s         # 0 to 2 min: delivery, which follows blood flow
frames 4 x 1 min        # 2 to 6 min
frames 2 x 2 min        # 6 to 10 min
frames 4 x 5 min        # 10 to 30 min: free tracer washes out of normal tissue
frames 4 x 10 min       # 30 to 70 min: the Logan plot uses these

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof off                 # off only for simulation speed; real scans keep TOF on
mode 3D
`);

    add('pe2i_dynamic', 'PE2I dopamine transporter, dynamic', 'dynamic', 'brain', { condition: 'pd' },
        '[11C]PE2I 350 MBq from injection to 70 min, for reference-region kinetic modelling of the striatum.', `
# [11C]PE2I dopamine transporter scan, dynamic, 0 to 70 min.
# PE2I binds the transporter tightly and the striatum approaches
# equilibrium slowly, so the striatum-to-cerebellum ratio of a single
# frame keeps changing with the time it was taken. A dynamic scan and
# a reference-region model (Logan, cerebellum as reference) measure
# the binding potential BPND instead.
protocol "PE2I dopamine transporter, dynamic"

param DOSE = 350 MBq  range 100 MBq .. 600 MBq  "injected activity"

tracer PE2I             # 11C: compare FE-PE2I, its 18F cousin
weight 70 kg
inject DOSE
frames 6 x 20 s         # 0 to 2 min: delivery
frames 4 x 1 min        # 2 to 6 min
frames 2 x 2 min        # 6 to 10 min
frames 4 x 5 min        # 10 to 30 min: the striatum is still rising
frames 4 x 10 min       # 30 to 70 min: late frames for the Logan plot

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof off                 # off only for simulation speed; real scans keep TOF on
mode 3D
`);

    add('water_dynamic', '[15O]water blood flow, dynamic', 'dynamic', 'brain', { condition: 'normal' },
        '[15O]water 700 MBq, 3 min of short frames: uptake in the first minute follows cerebral blood flow.', `
# [15O]water blood flow scan, dynamic, 0 to 3 min.
# Water crosses the blood-brain barrier freely, so how fast it
# enters the brain in the first minute is set by blood flow. With a
# 2 min half-life the study is over in minutes and can be repeated
# about 10 min later, for example at rest and then during a task.
protocol "Water blood flow, dynamic"

param DOSE = 700 MBq  range 200 MBq .. 1400 MBq  "injected activity"

tracer water            # [15O]H2O
weight 70 kg
inject DOSE             # a fast bolus: it reaches the brain about 15 s later
frames 12 x 5 s         # 0 to 1 min: arrival and first pass, where flow is measured
frames 6 x 10 s         # 1 to 2 min
frames 4 x 15 s         # 2 to 3 min: washout, as tissue and blood equilibrate

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof off                 # off only for simulation speed; real scans keep TOF on
mode 3D
`);

    /* ---------- Phantoms ----------
       A phantom is filled with a solution of the isotope rather than
       injected with a tracer: "tracer none" plus an isotope line, and
       "inject" gives the activity put in. UPTAKE here is simply a
       delay before scanning, for lessons on decay. */

    add('point_res', 'Line sources, resolution', 'phantom', 'point', { medium: 'air' },
        'Four thin 18F line sources in air, 2 min: measure the resolution (FWHM) at the centre and off centre.', `
# Line sources: spatial resolution.
# Thin capillaries filled with 18F, seen end on as points at 0, 50
# and 100 mm from the centre, and one 100 mm straight up. Their
# reconstructed width (FWHM) is the system resolution; watch it grow
# away from the centre as the depth-of-interaction blur adds in.
protocol "Line sources, resolution"

param DOSE   = 5 MBq    range 1 MBq .. 20 MBq      "activity in the line sources"
param UPTAKE = 0 min    range 0 min .. 240 min     "delay before scanning"
param DUR    = 2 min    range 0.5 min .. 10 min    "scan duration"

tracer none             # no tracer: a solution of the isotope fills the phantom
isotope F18             # so the isotope has to be named
inject DOSE             # for a phantom, the activity it was filled with
wait UPTAKE             # nothing to take up; this only lets the activity decay
static DUR

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    add('cyl_uniform', 'Uniform cylinder', 'phantom', 'cylinder', {},
        'A 20 cm water cylinder with 40 MBq of 18F, 10 min: every pixel should read the same concentration.', `
# Uniform cylinder: uniformity, noise and quantification.
# A 20 cm water cylinder with 18F mixed evenly through it: 40 MBq in
# 6.3 L, about 6.4 kBq/mL everywhere. Any pattern in the image is an
# artifact: missing attenuation or scatter correction, a
# normalisation error, or noise.
protocol "Uniform cylinder"

param DOSE   = 40 MBq   range 5 MBq .. 200 MBq   "activity in the cylinder"
param UPTAKE = 0 min    range 0 min .. 240 min   "delay before scanning"
param DUR    = 10 min   range 1 min .. 30 min    "scan duration"

tracer none
isotope F18
inject DOSE
wait UPTAKE             # one half-life (110 min) halves the counts
static DUR

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    add('spheres_iq', 'Hot and cold spheres', 'phantom', 'spheres', { ratio: 4, lung: true },
        'The NEMA image-quality phantom with 50 MBq of 18F, 10 min: contrast recovery of small hot and cold spheres.', `
# Hot and cold spheres (NEMA image-quality phantom).
# Six spheres in a warm background: the four small ones hold 4 times
# the background concentration, the two largest none. Small hot
# spheres read low (partial volume); cold ones read warm (scatter,
# and spill-in from the background).
protocol "Hot and cold spheres"

param DOSE   = 50 MBq   range 5 MBq .. 200 MBq   "activity in the phantom"
param UPTAKE = 0 min    range 0 min .. 240 min   "delay before scanning"
param DUR    = 10 min   range 1 min .. 30 min    "scan duration"

tracer none
isotope F18
inject DOSE
wait UPTAKE
static DUR

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps             # TOF lifts small-sphere contrast at equal noise
mode 3D
`);

    add('rods_f18', 'Hot rods, positron range', 'phantom', 'rods', {},
        'Six groups of hot rods, 3 to 10 mm, filled with 18F; change the isotope to O15 to see positron range.', `
# Hot rods: resolution and positron range.
# Six groups of rods from 3 to 10 mm across. With 18F (mean positron
# range 0.6 mm) the detectors decide which rods still separate.
# Change F18 to O15 below (range 3 mm, half-life 2 min) and the small
# rods blur together: that is positron range. With O15 also shorten
# DUR to 2 min or raise DOSE, or most of the scan sees only decay.
protocol "Hot rods, positron range"

param DOSE   = 40 MBq   range 5 MBq .. 200 MBq   "activity in the rods"
param UPTAKE = 0 min    range 0 min .. 240 min   "delay before scanning"
param DUR    = 10 min   range 1 min .. 30 min    "scan duration"

tracer none
isotope F18             # change to O15 (or C11) to see positron range blur the rods
inject DOSE
wait UPTAKE
static DUR

energy 435 keV .. 650 keV
coincidence 4.5 ns
tof on 400 ps
mode 3D
`);

    PET.presets = list;
    PET.presets.defaultId = 'fdg_static';
    PET.presets.get = function (id) {
        for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    };

})(typeof window !== 'undefined' ? window : globalThis);
