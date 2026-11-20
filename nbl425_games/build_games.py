#!/usr/bin/env python3
"""Emit the NBL425 card games, the rules page and the hub index from one
table.

The categories were previously written out in three places — each game's own
blurb, rules.html and index.html — and two of the three had drifted. The MRI
game deals Magnets/Organs/Processes/Applications while both listings promised
Imaging Techniques/Applications/Processes/Equipment; PET was wrong the same
way; the EEG game's blurb said "Frequency Bands" where it deals "Brain Waves".
Generating all three from this table is what stops them drifting again.

The index used to be patched in place, which only replaced the first
category block and left a stale copy of the old lists hanging under it.
It is written whole now. Run this file after editing GAMES:

    python3 nbl425_games/build_games.py
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))

GAMES = {
    "eeg": {
        "title": "EEG",
        "file": "eeggame.html",
        "blurb": "Electroencephalography: scalp potentials, sampled fast.",
        "sim": "../eegsim/index.html",
        "categories": {
            "Electrodes": ["Scalp Electrodes", "Intracranial Electrodes",
                           "Dry Electrodes", "Wet Electrodes"],
            "Brain Waves": ["Alpha", "Beta", "Theta", "Delta"],
            "Processes": ["Signal Acquisition", "Re-referencing", "Filtering",
                          "Artifact Removal"],
            "Applications": ["Epilepsy", "Sleep Studies",
                             "Brain-Computer Interface", "Cognitive Research"],
        },
    },
    "meg": {
        "title": "MEG",
        "file": "meggame.html",
        "blurb": "Magnetoencephalography: the fields those currents throw off.",
        "sim": "../megsim/index.html",
        "categories": {
            "Sensors": ["SQUID Magnetometer", "Optically Pumped Magnetometer",
                        "Planar Gradiometer"],
            "Brain Waves": ["Alpha", "Beta", "Theta", "Gamma"],
            "Processes": ["Magnetic Shielding", "Signal Space Separation",
                          "Source Localization"],
            "Applications": ["Epilepsy", "Language Mapping",
                             "Sensory Processing", "Cognitive Research"],
        },
    },
    "mri": {
        "title": "MRI",
        "file": "mrigame.html",
        "blurb": "Magnetic resonance imaging: spins, gradients and contrast.",
        "sim": "../nbl425/demos/mri_simulator/index.html",
        "categories": {
            "Magnets": ["Superconducting Magnet", "Permanent Magnet",
                        "Resistive Magnet"],
            "Organs": ["Brain", "Heart", "Spine", "Joints", "Abdomen"],
            "Processes": ["RF Excitation", "T1 and T2 Relaxation",
                          "Spatial Encoding", "Image Reconstruction"],
            "Applications": ["Neurology", "Cardiology", "Orthopedics", "Oncology"],
        },
    },
    "pet": {
        "title": "PET",
        "file": "petgame.html",
        "blurb": "Positron emission tomography: tracers, annihilation, counts.",
        "sim": "../nbl425/demos/pet_simulator/index.html",
        "categories": {
            "Radioisotopes": ["Fluorine-18", "Carbon-11", "Oxygen-15", "Nitrogen-13"],
            "Organs": ["Brain", "Heart", "Lungs", "Liver", "Kidneys"],
            "Processes": ["Positron Emission", "Annihilation",
                          "Coincidence Detection", "Reconstruction"],
            "Applications": ["Cancer Detection", "Neurology", "Cardiology",
                             "Pulmonology"],
        },
    },
    "fnirs": {
        "title": "fNIRS",
        "file": "fnirsgame.html",
        "blurb": "Functional near-infrared spectroscopy: light in, light out, haemoglobin in between.",
        "sim": "../fnirssim/index.html",
        "categories": {
            "Optodes": ["Light Source", "Detector", "Short-Separation Channel"],
            "Chromophores": ["Oxyhaemoglobin", "Deoxyhaemoglobin", "Water",
                             "Melanin"],
            "Processes": ["Modified Beer-Lambert Law", "Motion Correction",
                          "Short-Channel Regression", "Block Averaging"],
            "Applications": ["Infant Studies", "Hyperscanning",
                             "Stroke Rehabilitation", "Brain-Computer Interface"],
        },
    },
}

ORDER = ["eeg", "meg", "mri", "pet", "fnirs"]

GAME_TEMPLATE = """<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} Card Game</title>
    <meta name="description" content="Collect one card from each {title} category to make a complete set.">
    <link rel="stylesheet" href="cards.css">
    <link rel="stylesheet" href="../archive.css">
</head>

<body class="ar-touch ar-motion">
    <nav class="ar-bar">
        <a href="index.html">&larr; NBL425 Games</a>
        <span class="ar-here">{title} Card Game</span>
        <span class="ar-spacer"></span>
        <a href="../archive.html">Archive</a>
    </nav>

    <main data-ar-focus>
        <h1>{title} Card Game</h1>
        <p class="blurb">{blurb}</p>
        <p class="goal">Make a hand with one card from each category. The four categories are
            {category_prose}.</p>

        <div class="tally">
            <span>Deck <b id="deck-count">0</b></span>
            <span>Discard <b id="discard-count">0</b></span>
            <span>Draws <b id="draw-count">0</b></span>
        </div>

        <p id="message" class="message" role="status" aria-live="polite"></p>

        <section class="zone">
            <h2>Your hand <span class="hint">(up to four cards)</span></h2>
            <div id="hand" class="cards"></div>
        </section>

        <div class="buttons">
            <button type="button" id="draw">Draw a card</button>
            <button type="button" id="restart" class="secondary">Restart</button>
        </div>

        <section class="zone">
            <h2>Discard pile</h2>
            <div id="discardPile" class="cards discard-cards"></div>
        </section>

        <section class="zone">
            <h2>Categories</h2>
            <ul class="categories">
{category_list}
            </ul>
        </section>
    </main>

    <script>
        (function () {{
            var CATEGORIES = {categories_json};
            var NAMES = Object.keys(CATEGORIES);

            // Which category a card belongs to, resolved once. The original
            // walked every category for every card on every check.
            var CATEGORY_OF = {{}};
            NAMES.forEach(function (name) {{
                CATEGORIES[name].forEach(function (card) {{ CATEGORY_OF[card] = name; }});
            }});

            var HAND_LIMIT = 4;

            var deck = [], hand = [], discard = [], draws = 0, won = false;
            var notice = '';

            var handEl = document.getElementById('hand');
            var discardEl = document.getElementById('discardPile');
            var messageEl = document.getElementById('message');
            var drawBtn = document.getElementById('draw');

            function shuffle(a) {{
                for (var i = a.length - 1; i > 0; i--) {{
                    var j = Math.floor(Math.random() * (i + 1));
                    var t = a[i]; a[i] = a[j]; a[j] = t;
                }}
                return a;
            }}

            function say(text, kind) {{
                messageEl.textContent = text;
                messageEl.className = 'message' + (kind ? ' ' + kind : '');
            }}

            function isCompleteSet() {{
                if (hand.length !== NAMES.length) return false;
                var seen = {{}};
                for (var i = 0; i < hand.length; i++) {{
                    var cat = CATEGORY_OF[hand[i]];
                    if (!cat || seen[cat]) return false;
                    seen[cat] = true;
                }}
                return true;
            }}

            function draw() {{
                if (won) return;

                if (hand.length >= HAND_LIMIT) {{
                    say('Your hand is full. Discard something first.', 'warn');
                    return;
                }}

                if (deck.length === 0) {{
                    // The rules have always said the discard pile is
                    // reshuffled when the deck runs out. No game implemented
                    // it: they alerted "The deck is empty!" and stopped,
                    // which could strand you one card short of a set.
                    if (discard.length === 0) {{
                        say('No cards left anywhere. Restart to play again.', 'warn');
                        return;
                    }}
                    deck = shuffle(discard.slice());
                    discard = [];
                    // Held for the next render rather than written straight
                    // out, which render() would immediately overwrite with
                    // the running status line.
                    notice = 'The deck ran out, so the discard pile was shuffled back in. ';
                }}

                hand.push(deck.pop());
                draws += 1;
                render();
            }}

            function discardCard(index) {{
                if (won) return;
                discard.push(hand.splice(index, 1)[0]);
                render();
            }}

            function render() {{
                handEl.innerHTML = '';
                hand.forEach(function (card, index) {{
                    var el = document.createElement('div');
                    el.className = 'card';

                    var cat = document.createElement('span');
                    cat.className = 'card-cat';
                    cat.textContent = CATEGORY_OF[card] || '';

                    var name = document.createElement('span');
                    name.className = 'card-name';
                    name.textContent = card;

                    var btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'discard-btn';
                    btn.textContent = 'Discard';
                    btn.setAttribute('aria-label', 'Discard ' + card);
                    btn.addEventListener('click', function () {{ discardCard(index); }});

                    el.appendChild(cat);
                    el.appendChild(name);
                    el.appendChild(btn);
                    handEl.appendChild(el);
                }});

                discardEl.innerHTML = '';
                discard.slice(-8).forEach(function (card) {{
                    var el = document.createElement('div');
                    el.className = 'card small';
                    el.textContent = card;
                    discardEl.appendChild(el);
                }});
                if (!discard.length) {{
                    var empty = document.createElement('p');
                    empty.className = 'empty';
                    empty.textContent = 'Nothing discarded yet.';
                    discardEl.appendChild(empty);
                }}

                document.getElementById('deck-count').textContent = deck.length;
                document.getElementById('discard-count').textContent = discard.length;
                document.getElementById('draw-count').textContent = draws;

                // Checked after every change rather than only when a button
                // is pressed, so the game actually announces the win.
                if (!won && isCompleteSet()) {{
                    won = true;
                    drawBtn.disabled = true;
                    say('Complete set \\u2014 one card from each of the ' + NAMES.length +
                        ' categories, in ' + draws + ' draws.', 'win');
                }} else if (!won) {{
                    var missing = NAMES.filter(function (n) {{
                        return !hand.some(function (c) {{ return CATEGORY_OF[c] === n; }});
                    }});
                    if (hand.length === 0) {{
                        say(notice + 'Draw a card to begin.');
                    }} else if (missing.length) {{
                        say(notice + 'Still looking for: ' + missing.join(', ') + '.');
                    }} else {{
                        say(notice + 'You hold a duplicate category. Discard one to make room.');
                    }}
                    notice = '';
                }}
            }}

            function restart() {{
                deck = shuffle(Object.keys(CATEGORY_OF));
                hand = [];
                discard = [];
                draws = 0;
                won = false;
                notice = '';
                drawBtn.disabled = false;
                render();
            }}

            drawBtn.addEventListener('click', draw);
            document.getElementById('restart').addEventListener('click', restart);

            restart();
        }}());
    </script>
</body>

</html>
"""


def categories_js(cats):
    """One line per category, at the indent the surrounding script uses."""
    lines = []
    for name, cards in cats.items():
        items = ", ".join(json.dumps(c) for c in cards)
        lines.append("                %s: [%s]" % (json.dumps(name), items))
    return "{\n" + ",\n".join(lines) + "\n            }"


NUMBER = {4: "Four", 5: "Five", 6: "Six"}


def prose(names):
    return ", ".join(names[:-1]) + " and " + names[-1]


def build_games():
    for key in ORDER:
        g = GAMES[key]
        names = list(g["categories"].keys())
        items = "\n".join(
            '                <li><b>{}:</b> {}</li>'.format(n, ", ".join(g["categories"][n]))
            for n in names)
        html = GAME_TEMPLATE.format(
            title=g["title"],
            blurb=g["blurb"],
            category_prose=prose(names),
            category_list=items,
            categories_json=categories_js(g["categories"]),
        )
        path = os.path.join(OUT, g["file"])
        open(path, "w", encoding="utf-8").write(html)
        print("wrote", g["file"], os.path.getsize(path), "bytes")



RULES = """<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Card Game Rules</title>
    <meta name="description" content="Rules and category lists for the NBL425 imaging card games.">
    <link rel="stylesheet" href="cards.css">
    <link rel="stylesheet" href="../archive.css">
    <style>
        .game-links {{
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-bottom: 28px;
        }}

        .game-links a {{
            padding: 10px 18px;
            color: var(--accent);
            font-weight: 600;
            text-decoration: none;
            border: 1px solid var(--accent);
            border-radius: 6px;
        }}

        .game-links a:hover {{
            color: #fff;
            background-color: var(--accent);
        }}

        ol {{
            padding-left: 22px;
            line-height: 1.7;
        }}

        ol li {{
            margin-bottom: 8px;
        }}

        .note {{
            color: var(--muted);
            font-size: 0.85rem;
        }}
    </style>
</head>

<body class="ar-touch ar-motion">
    <nav class="ar-bar">
        <a href="index.html">&larr; NBL425 Games</a>
        <span class="ar-here">Card Game Rules</span>
        <span class="ar-spacer"></span>
        <a href="../archive.html">Archive</a>
    </nav>

    <main>
        <h1>Little Imaging Card Games</h1>
        <p class="blurb">{count} decks, one shape of game. Collect one card from each category.</p>

        <div class="game-links">
{links}
        </div>

        <section class="zone">
            <h2>General rules</h2>
            <ol>
                <li><b>Objective:</b> form a complete set, one card from each category.</li>
                <li><b>Setup:</b> the deck is shuffled face down. Draw to build a hand.</li>
                <li><b>Play:</b> hold up to four cards. Draw a card, or discard one to make room.</li>
                <li><b>Complete set:</b> four cards, one from each of the four categories, no
                    category twice.</li>
                <li><b>Winning:</b> the first complete set wins. The game calls it as soon as
                    your hand qualifies.</li>
                <li><b>Running out:</b> if the deck empties, the discard pile is shuffled and
                    becomes the new deck. Restart at any time.</li>
            </ol>
        </section>

{sections}
        <p class="note">Category lists on this page, on the games themselves and on the index are
            all generated from one table, so they cannot drift apart.</p>
    </main>
</body>

</html>
"""

RULES_SECTION = """        <section class="zone">
            <h2>{title} game categories</h2>
            <ul class="categories">
{items}
            </ul>
        </section>

"""


def build_rules():
    links = "\n".join(
        '            <a href="{}">{}</a>'.format(GAMES[k]["file"], GAMES[k]["title"])
        for k in ORDER)
    sections = "".join(
        RULES_SECTION.format(
            title=GAMES[k]["title"],
            items="\n".join(
                '                <li><b>{}:</b> {}</li>'.format(n, ", ".join(c))
                for n, c in GAMES[k]["categories"].items()))
        for k in ORDER)
    path = os.path.join(OUT, "rules.html")
    open(path, "w", encoding="utf-8").write(
        RULES.format(links=links, sections=sections, count=NUMBER[len(ORDER)]))
    print("wrote rules.html", os.path.getsize(path), "bytes")


INDEX = """<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NBL425 Games</title>
    <meta name="description" content="Imaging card games for NBL 425/625: {decks}, plus Conway's Game of Life and the course's modality simulators.">
    <link rel="stylesheet" href="cards.css">
    <link rel="stylesheet" href="../archive.css">
    <style>
        .decks {{
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
            gap: 12px;
            margin-bottom: 28px;
        }}

        .deck {{
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 16px;
            color: var(--fg);
            text-decoration: none;
            background-color: var(--panel);
            border: 1px solid var(--rule);
            border-radius: 10px;
            box-shadow: 0 2px 6px var(--shadow);
            transition: border-color 0.15s ease, transform 0.15s ease;
        }}

        .deck:hover {{
            border-color: var(--accent);
            transform: translateY(-2px);
        }}

        .deck-title {{
            color: var(--accent);
            font-size: 1.3rem;
            font-weight: 800;
        }}

        .deck-blurb {{
            font-size: 0.88rem;
            line-height: 1.45;
        }}

        .deck-cats {{
            margin-top: auto;
            color: var(--muted);
            font-size: 0.75rem;
            line-height: 1.5;
        }}

        .links {{
            margin: 0;
            padding: 16px 18px 16px 34px;
            font-size: 0.9rem;
            line-height: 1.8;
            background-color: var(--panel-2);
            border: 1px solid var(--rule);
            border-radius: 8px;
        }}

        .links a {{
            color: var(--accent);
            font-weight: 600;
        }}

        .links span {{
            color: var(--muted);
        }}

        @media (prefers-reduced-motion: reduce) {{
            .deck {{
                transition: none;
            }}

            .deck:hover {{
                transform: none;
            }}
        }}
    </style>
</head>

<body class="ar-touch ar-motion">
    <nav class="ar-bar">
        <a href="../archive.html">&larr; Archive</a>
        <span class="ar-here">NBL425 Games</span>
        <span class="ar-spacer"></span>
        <a href="../nbl425/index.html">NBL 425/625</a>
    </nav>

    <main>
        <h1>Imaging Card Games</h1>
        <p class="blurb">{count} decks, one per modality. Draw, discard, and hold one card from
            each of a deck's four categories to win.</p>

        <div class="decks">
{decks_html}
        </div>

        <section class="zone">
            <h2>Also here</h2>
            <ul class="links">
                <li><a href="rules.html">Rules</a> <span>and every deck's full category list</span></li>
                <li><a href="conway.html">Game of Life</a> <span>draw a pattern, then step it a generation at a time</span></li>
            </ul>
        </section>

        <section class="zone">
            <h2>The simulators</h2>
            <ul class="links">
{sims_html}
            </ul>
        </section>
    </main>
</body>

</html>
"""

DECK = """            <a class="deck" href="{file}">
                <span class="deck-title">{title}</span>
                <span class="deck-blurb">{blurb}</span>
                <span class="deck-cats">{cats}</span>
            </a>"""

SIM = ('                <li><a href="{sim}">{title} Simulator</a> '
       '<span>the real thing behind the {title} deck</span></li>')


def build_index():
    decks = [GAMES[k] for k in ORDER]
    html = INDEX.format(
        decks=", ".join(g["title"] for g in decks),
        count=NUMBER[len(decks)],
        decks_html="\n".join(
            DECK.format(cats=" &middot; ".join(g["categories"]), **g) for g in decks),
        sims_html="\n".join(SIM.format(**g) for g in decks),
    )
    path = os.path.join(OUT, "index.html")
    open(path, "w", encoding="utf-8").write(html)
    print("wrote index.html", os.path.getsize(path), "bytes")


if __name__ == "__main__":
    build_games()
    build_rules()
    build_index()
