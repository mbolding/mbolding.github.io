#!/usr/bin/env python3
"""Regenerate nbl425/interactive.html from the curated week-page entries.

Run after adding or removing a demo on any nbl425/weekNN/index.html:

    python3 nbl425/tools/build_interactive.py

Titles, meta lines and descriptions come from the week pages, so they are
written once. This file owns two things the week pages cannot express: the
TYPE tag that drives the filter buttons, and ADJACENT, the relevant pages no
week page links yet.
"""
import io
import os, re, sys, glob, collections

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
os.chdir(ROOT)

def scan_week_pages():
    """Read the curated demo entries straight off the week pages, so the index
    inherits the descriptions already written there instead of duplicating them."""
    weeks, items = {}, collections.OrderedDict()
    pat = (r'<h3 class="demo-title"><a href="([^"]+)">(.*?)</a></h3>\s*'
           r'<span class="demo-meta">(.*?)</span>\s*'
           r'<p class="demo-desc">(.*?)</p>')
    for f in sorted(glob.glob('nbl425/week*/index.html')):
        wk = re.search(r'week(\d+)', f).group(1)
        s = io.open(f, encoding='utf-8').read()
        weeks[wk] = re.sub(r'\s+', ' ', re.search(r'<h1>(.*?)</h1>', s, re.S).group(1)).strip()
        body = s[s.index('<body>'):]
        for m in re.finditer(pat, body, re.S):
            href, title, meta, desc = [re.sub(r'\s+', ' ', x).strip() for x in m.groups()]
            target = os.path.normpath(os.path.join(os.path.dirname(f), href))
            items.setdefault(target, {'title': title, 'meta': meta, 'desc': desc, 'weeks': []})
            items[target]['weeks'].append(wk)
    return weeks, items

WEEKS, ITEMS = scan_week_pages()

# Type tag per curated item. Assigned by hand: 46 items is small enough that
# accuracy beats a heuristic, and these drive the filter buttons.
TYPE = {
 'quizzes/neuroimaging_dichotomous_key.html':'assess',
 'presentations/rad_vs_sci.html':'tool',
 'quizzes/human_neuroimaging_incoming.html':'assess',
 'diagnostic_tests.html':'tool',
 'nbl425/demos/fid_relaxation.html':'sim',
 'nbl425/demos/gradient_encoding.html':'sim',
 'nbl425/demos/pulse_sequence.html':'sim',
 'nbl425/demos/kspace_explorer.html':'sim',
 'gyroscope/index.html':'sim',
 'fourier/fft2d.html':'sim',
 'spins/spinning_vector_sum.html':'sim',
 'MRI_safety/index.html':'tool',
 'nbl425/demos/epi_distortion.html':'sim',
 'nbl425/demos/tr_te_contrast.html':'sim',
 'nbl425/demos/artifact_simulator.html':'sim',
 'spins/dephase_rephase_2.html':'sim',
 'calculators/ernst_angle.html':'tool',
 'ferroquant/index.html':'tool',
 'nbl425_games/mrigame.html':'game',
 'nbl425/demos/glm_studio.html':'sim',
 'nbl425/demos/preprocessing_pipeline.html':'sim',
 'nbl425/demos/whole_brain_inference.html':'sim',
 'nbl425/demos/group_analysis.html':'sim',
 'neuroengineering/fmri.html':'sim',
 'neuroengineering/lfp.html':'sim',
 'neural_plasticity/leaky_integrate_fire.html':'sim',
 'flash_lag/index.html':'sim',
 'fourier/waveforms.html':'sim',
 'nbl425/demos/dti_tractography.html':'sim',
 'nbl425/demos/connectome_graph.html':'sim',
 'neuroengineering/dti.html':'sim',
 'mrs/129xe_diffusion.html':'tool',
 'petdemo.html':'sim',
 'nbl425/demos/pet_compartment.html':'sim',
 'nbl425/demos/pet_reconstruction.html':'sim',
 'nbl425_games/petgame.html':'game',
 'xrayROS.html':'sim',
 'neuroengineering/eeg.html':'sim',
 'nbl425/demos/eeg_forward_model.html':'sim',
 'nbl425/demos/eeg_inverse_solution.html':'sim',
 'neuroengineering/hodgkin_huxley.html':'sim',
 'nbl425_games/eeggame.html':'game',
 'neuroengineering/meg.html':'sim',
 'nbl425/demos/eeg_vs_meg_dipoles.html':'sim',
 'curl_plot.html':'sim',
 'nbl425_games/meggame.html':'game',
 'nbl425/demos/fnirs_unmixing.html':'sim',
 'nbl425/demos/fnirs_photon_transport.html':'sim',
 'neuroengineering/fnirs.html':'sim',
 'nbl425/demos/mrs_spectral_fitting.html':'sim',
 'mrs/interactive_mrs.html':'sim',
 'mrs/index.html':'tool',
 'nbl425/demos/eeg_fmri_decontamination.html':'sim',
 'nbl425/demos/multimodal_fusion.html':'sim',
 'neuroengineering/kalman_filters.html':'sim',
 'nbl425_games/index.html':'game',
 'mrs/129xe_hyperpolarized.html':'tool',
 'nbl425/demos/opm_wearable_meg.html':'sim',
 'criticality.html':'sim',
 'neuroengineering/sua_mua.html':'sim',
 'nbl425/demos/bwas_power_replication.html':'sim',
}

# Interactive pages on the site that no week page links, but that are plainly
# relevant to this course. Listed separately so they can be promoted onto a
# week page or dropped, rather than silently mixed in with the curated set.
ADJACENT = [
 ('spins/dephase_rephase.html','sim','Spin Echo Dephasing &amp; Rephasing I (Grid)',
  'Grid Simulator &middot; Refocusing',
  'The initial grid version of the dephasing and rephasing demo without the net sum vector. Week 03 links version II.','03'),
 ('spins/magnetic_domains.html','sim','Magnetic Domain Simulator','Ferromagnetism &middot; Domain Walls',
  'Domains aligning and reorienting under an applied field, behind the shim and fringe-field behaviour of a superconducting magnet.','02'),
 ('MRI_safety/MRI_safety_quiz.html','assess','MRI Safety Certification Quiz','Assessment &middot; Zone Discipline &amp; Screening',
  'The safety quiz on its own, separate from the course module it is embedded in.','02'),
 ('neuroengineering/simulation_contrast_physics.html','sim','Biophysical Contrast Simulation Sandbox',
  'Multi-Contrast Sandbox &middot; Tissue Parameters',
  'Sweeps tissue parameters across several contrast mechanisms in one place. Built for IDNE 701, but the physics is the same as Week 03.','03'),
 ('mrs/periodic_table.html','tool','A Periodic Chart for Magnetic Resonance','Reference Chart &middot; Gyromagnetic Ratios &amp; Abundances',
  'Every NMR-active nucleus with its spin, gyromagnetic ratio, and natural abundance, which is the table you actually need when planning a multinuclear study.','11'),
 ('toys/vector_field_explorer.html','sim','Vector Field Explorer','Field Geometry &middot; Divergence &amp; Curl',
  'A second take on field visualisation alongside the curl plot used in Week 09.','09'),
 ('garrity/fourier.html','sim','Fourier Analysis by Epicycles','Mathematical Background &middot; Series Decomposition',
  'Builds an arbitrary waveform out of rotating phasors, which is the same idea as filling k-space one spatial frequency at a time. From the mathematics series under garrity/.','02'),
 ('nbl425_games/conway.html','game','Cellular Automata: Game of Life','Emergence &middot; Local Rules',
  'Local rules producing global structure. Sits with the self-organised criticality material in Week 13.','13'),
 ('toys/graph_automata.html','sim','Cellular Automata on Directed Graphs','Network Dynamics &middot; Beyond the Lattice',
  'Automata on an arbitrary graph rather than a grid, which is closer to how network models of cortex behave.','13'),
 ('flocking/index.html','sim','Flocking and Collective Dynamics','Emergent Behaviour &middot; Local Alignment Rules',
  'Three local rules producing coherent group motion, another view of the emergence theme in Week 13.','13'),
 ('neural_plasticity/index.html','sim','Hebbian Learning Demo','Synaptic Plasticity &middot; Correlation-Driven Weights',
  'Weight change driven by correlated activity, companion to the leaky integrate-and-fire neuron in Week 04.','04'),
 ('games/minesweeper.html','game','NeuroSweep: Neural Array Sweep','Puzzle &middot; Inference Under Uncertainty',
  'Minesweeper reskinned onto an electrode array. Inference from sparse local evidence, which is a fair caricature of source localisation.','09'),
]

LABEL = {'sim':'Simulator','game':'Game','assess':'Assessment','tool':'Tool &amp; Primer'}
ORDER = ['sim','tool','assess','game']

def rel(target):
    """Path from nbl425/interactive.html to a repo-root-relative target."""
    return os.path.relpath(target, 'nbl425')

def card(target, typ, title, meta, desc, weeks):
    wk = ''.join(
        f'<a class="ix-wk" href="week{w}/index.html" title="Week {w}: '
        f'{WEEKS.get(w,"").replace("Week "+w+": ","")}">wk{w}</a>'
        for w in weeks)
    return (f'      <li class="ix-item" data-type="{typ}" data-weeks="{",".join(weeks)}">\n'
            f'        <h3 class="ix-title"><a href="{rel(target)}">{title}</a></h3>\n'
            f'        <span class="ix-meta">{meta}</span>\n'
            f'        <p class="ix-desc">{desc}</p>\n'
            f'        <div class="ix-tags"><span class="ix-type ix-{typ}">{LABEL[typ]}</span>{wk}</div>\n'
            f'      </li>\n')

missing = [t for t in ITEMS if t not in TYPE]
if missing:
    sys.exit('Untagged items found on the week pages. Add each to TYPE above:\n  '
             + '\n  '.join(missing))
stale = [t for t in TYPE if t not in ITEMS]
if stale:
    print('note: TYPE has entries no week page links any more: ' + ', '.join(stale))

# ---- by week ----
byweek = collections.defaultdict(list)
for t, d in ITEMS.items():
    for w in d['weeks']:
        byweek[w].append((t, d))

week_html = ''
for w in sorted(WEEKS):
    entries = byweek.get(w, [])
    if not entries:
        continue
    heading = WEEKS[w]
    week_html += f'    <section class="ix-group" data-week="{w}">\n'
    week_html += (f'      <h2 class="ix-group-h"><a href="week{w}/index.html">{heading}</a>'
                  f'<span class="ix-count">{len(entries)}</span></h2>\n')
    week_html += '      <ul class="ix-list">\n'
    for t, d in sorted(entries, key=lambda e: ORDER.index(TYPE[e[0]])):
        week_html += card(t, TYPE[t], d['title'], d['meta'], d['desc'], d['weeks'])
    week_html += '      </ul>\n    </section>\n'

# ---- by type ----
bytype = collections.defaultdict(list)
for t, d in ITEMS.items():
    bytype[TYPE[t]].append((t, d))

type_html = ''
for typ in ORDER:
    entries = sorted(bytype[typ], key=lambda e: e[1]['title'].lower())
    type_html += f'    <section class="ix-group">\n'
    type_html += (f'      <h2 class="ix-group-h">{LABEL[typ]}s'
                  f'<span class="ix-count">{len(entries)}</span></h2>\n')
    type_html += '      <ul class="ix-list">\n'
    for t, d in entries:
        type_html += card(t, typ, d['title'], d['meta'], d['desc'], d['weeks'])
    type_html += '      </ul>\n    </section>\n'

adj_html = '      <ul class="ix-list">\n'
for target, typ, title, meta, desc, wk in ADJACENT:
    adj_html += card(target, typ, title, meta, desc, [wk])
adj_html += '      </ul>\n'

n_cur, n_adj = len(ITEMS), len(ADJACENT)
# Button counts must match what the status line reports, which includes the
# adjacent list, otherwise the two disagree the moment a filter is clicked.
adj_by_type = collections.Counter(a[1] for a in ADJACENT)
counts = {t: len(bytype[t]) + adj_by_type[t] for t in ORDER}
total = n_cur + n_adj

HTML = f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Interactive Index &mdash; NBL 425/625</title>
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <article>
        <p><a href="index.html">&larr; Back to Course Home</a></p>
        <h1>Interactive Index</h1>
        <span class="subtitle">Every simulator, game, quiz and interactive figure in the course</span>

        <p>
            {n_cur} interactive pieces are linked from the fourteen week pages, scattered across a dozen
            directories of this site. This page gathers all of them in one place, with {n_adj} more that are
            relevant but that no week page currently links.
            <span class="sidenote-number"></span>
            <span class="sidenote">
                Several appear in more than one week &mdash; the FID demo turns up in Weeks 02, 03 and 11 &mdash;
                so the per-week counts below add up to more than {n_cur}.
            </span>
            Search filters on title, description and week. Nothing here needs an install or a login;
            everything runs in the browser.
        </p>

        <div class="ix-controls">
            <input type="search" id="ixSearch" class="ix-search" placeholder="Search all {n_cur + n_adj} interactives&hellip;" autocomplete="off">
            <div class="ix-filters">
                <button class="ix-btn is-on" data-filter="all">All <span class="ix-n">{total}</span></button>
                <button class="ix-btn" data-filter="sim">Simulators <span class="ix-n">{counts['sim']}</span></button>
                <button class="ix-btn" data-filter="tool">Tools &amp; Primers <span class="ix-n">{counts['tool']}</span></button>
                <button class="ix-btn" data-filter="assess">Assessments <span class="ix-n">{counts['assess']}</span></button>
                <button class="ix-btn" data-filter="game">Games <span class="ix-n">{counts['game']}</span></button>
            </div>
            <div class="ix-filters">
                <button class="ix-btn is-on" data-view="week">Group by week</button>
                <button class="ix-btn" data-view="type">Group by kind</button>
            </div>
        </div>
        <p class="ix-status" id="ixStatus" hidden></p>

        <div id="ixByWeek">
{week_html}        </div>

        <div id="ixByType" hidden>
{type_html}        </div>

        <section class="ix-group ix-adjacent">
            <h2 class="ix-group-h">Relevant but not yet on a week page<span class="ix-count">{n_adj}</span></h2>
            <p class="ix-desc">
                These live on the site and bear on the course, but no week page links them. Worth either
                promoting onto the week they belong to or leaving here as optional depth. The week tag on
                each is my suggestion, not an existing link.
            </p>
{adj_html}        </section>

        <div class="nav-footer">
            <div><a href="index.html">&larr; Course Home</a></div>
            <div><a href="demos/index.html">Course-built demos &rarr;</a></div>
        </div>
    </article>

<script>
(function () {{
  var search  = document.getElementById('ixSearch');
  var status  = document.getElementById('ixStatus');
  var byWeek  = document.getElementById('ixByWeek');
  var byType  = document.getElementById('ixByType');
  var filter  = 'all';

  // The by-kind container holds exactly one card per item, so it is the
  // reliable place to count distinct matches. Counting the by-week container
  // would count an item once per week it appears in.
  function apply() {{
    var q = search.value.trim().toLowerCase();
    var items = document.querySelectorAll('.ix-item');
    for (var i = 0; i < items.length; i++) {{
      var el = items[i];
      var okType = (filter === 'all') || el.dataset.type === filter;
      var okText = !q || el.textContent.toLowerCase().indexOf(q) !== -1
                      || ('week ' + el.dataset.weeks).indexOf(q) !== -1;
      el.hidden = !(okType && okText);
    }}

    // Hide any group whose items are all filtered out, and keep each group's
    // count showing what is actually visible rather than the unfiltered total.
    var groups = document.querySelectorAll('.ix-group');
    for (var g = 0; g < groups.length; g++) {{
      var live = groups[g].querySelectorAll('.ix-item:not([hidden])').length;
      groups[g].hidden = live === 0;
      var badge = groups[g].querySelector('.ix-count');
      if (badge) badge.textContent = live;
    }}

    var shown = byType.querySelectorAll('.ix-item:not([hidden])').length
              + document.querySelectorAll('.ix-adjacent .ix-item:not([hidden])').length;
    if (q || filter !== 'all') {{
      status.hidden = false;
      status.textContent = shown + (shown === 1 ? ' match' : ' matches');
    }} else {{
      status.hidden = true;
    }}
  }}

  search.addEventListener('input', apply);

  var fbtns = document.querySelectorAll('[data-filter]');
  for (var i = 0; i < fbtns.length; i++) {{
    fbtns[i].addEventListener('click', function () {{
      for (var j = 0; j < fbtns.length; j++) fbtns[j].classList.remove('is-on');
      this.classList.add('is-on');
      filter = this.dataset.filter;
      apply();
    }});
  }}

  var vbtns = document.querySelectorAll('[data-view]');
  for (var k = 0; k < vbtns.length; k++) {{
    vbtns[k].addEventListener('click', function () {{
      for (var j = 0; j < vbtns.length; j++) vbtns[j].classList.remove('is-on');
      this.classList.add('is-on');
      byWeek.hidden = this.dataset.view !== 'week';
      byType.hidden = this.dataset.view !== 'type';
      apply();
    }});
  }}
}})();
</script>
</body>
</html>
'''

open('nbl425/interactive.html','w',encoding='utf-8').write(HTML)
print(f'wrote nbl425/interactive.html  ({n_cur} curated + {n_adj} adjacent)')
print('by kind:', {LABEL[t].replace('&amp;','&'): counts[t] for t in ORDER})
