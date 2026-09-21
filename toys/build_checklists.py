#!/usr/bin/env python3
"""Emit the two 'Live Like You're at ...' checklists from one template.

They were copy-paste twins that had already drifted apart; writing both from
a single template is what keeps a fix to one from missing the other.
"""
import os
ROOT = "/home/user/mbolding.github.io"

TEMPLATE = """<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Like You're at {name}</title>
    <meta name="description" content="A {lower} habits checklist that remembers where you left off.">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Cabin:wght@400;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../archive.css">
    <style>
        :root {{
            --theme: {theme};
            --theme-deep: {theme_deep};
            --accent: {accent};
            --accent-hover: {accent_hover};
            --page-bg: #f0e6d2;
            --panel: rgba(255, 255, 255, 0.92);
            --fg: {fg};
            --muted: #6b6257;
            --track: {track};
            --shadow: rgba(0, 0, 0, 0.12);
            --noise: 0.55;
        }}

        @media (prefers-color-scheme: dark) {{
            :root:not([data-theme="light"]) {{
                --theme: {theme_dark};
                --theme-deep: {theme_deep_dark};
                --accent: {accent_dark};
                --accent-hover: {accent_hover_dark};
                --page-bg: #14120e;
                --panel: rgba(30, 27, 22, 0.92);
                --fg: #ece5d8;
                --muted: #a8a094;
                --track: {track_dark};
                --shadow: rgba(0, 0, 0, 0.5);
                --noise: 0.16;
            }}
        }}

        * {{
            box-sizing: border-box;
        }}

        body {{
            min-height: 100vh;
            margin: 0;
            font-family: 'Cabin', Arial, sans-serif;
            color: var(--fg);
            background-color: var(--page-bg);
        }}

        .background {{
            position: fixed;
            inset: 0;
            background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
            background-repeat: repeat;
            background-size: 200px 200px;
            opacity: var(--noise);
            filter: blur(1px);
            pointer-events: none;
            z-index: -1;
        }}

        .content {{
            max-width: 800px;
            margin: 0 auto;
            padding: 32px 20px 64px;
        }}

        h1 {{
            margin: 0 0 8px;
            color: var(--theme);
            font-size: clamp(1.9rem, 6vw, 2.5rem);
            text-align: center;
        }}

        .lede {{
            margin: 0 0 28px;
            color: var(--muted);
            text-align: center;
        }}

        .checklist {{
            padding: 8px 20px 20px;
            border: 0;
            border-radius: 6px;
            background-color: var(--panel);
            box-shadow: 0 4px 10px var(--shadow);
        }}

        .checklist legend {{
            padding: 0 8px;
            color: var(--muted);
            font-size: 0.8rem;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
        }}

        .item {{
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 8px;
            border-radius: 4px;
        }}

        .item + .item {{
            border-top: 1px solid color-mix(in srgb, var(--fg) 10%, transparent);
        }}

        .item:hover {{
            background-color: color-mix(in srgb, var(--theme) 8%, transparent);
        }}

        .item input[type="checkbox"] {{
            flex: none;
            width: 20px;
            height: 20px;
            accent-color: var(--theme);
            cursor: pointer;
        }}

        .item label {{
            flex: 1;
            cursor: pointer;
        }}

        .item input:checked + label {{
            color: var(--theme);
            font-weight: 700;
        }}

        #progress-container {{
            position: relative;
            height: 32px;
            margin-top: 24px;
            border: 2px solid var(--theme-deep);
            border-radius: 5px;
            background-color: var(--track);
            overflow: hidden;
        }}

        #progress-bar {{
            width: 0;
            height: 100%;
            background-color: var(--theme);
            transition: width 0.4s ease-in-out;
        }}

        #progress-text {{
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--fg);
            font-weight: 700;
            font-variant-numeric: tabular-nums;
        }}

        #message {{
            min-height: 1.6em;
            margin-top: 18px;
            color: var(--theme);
            font-size: 1.1rem;
            font-weight: 700;
            text-align: center;
        }}

        #reset-button {{
            display: block;
            margin: 24px auto 0;
            padding: 12px 24px;
            color: {accent_fg};
            font-family: inherit;
            font-size: 1rem;
            background-color: var(--accent);
            border: none;
            border-radius: 5px;
            box-shadow: 0 4px 6px var(--shadow);
            cursor: pointer;
            transition: background-color 0.2s ease, transform 0.2s ease;
        }}

        #reset-button:hover {{
            background-color: var(--accent-hover);
            transform: translateY(-2px);
        }}

        .saved-note {{
            margin-top: 14px;
            color: var(--muted);
            font-size: 0.8rem;
            text-align: center;
        }}
    </style>
</head>

<body class="ar-touch ar-motion">
    <nav class="ar-bar">
        <a href="../archive.html">&larr; Archive</a>
        <span class="ar-here">{name}</span>
        <span class="ar-spacer"></span>
        <a href="../index.html">Commonplace Book</a>
    </nav>

    <div class="background"></div>
    <main class="content">
        <h1>Live Like You're at {name}</h1>
        <p class="lede">{lede}</p>

        <fieldset class="checklist" id="checklist">
            <legend>Twelve habits</legend>
{items}
        </fieldset>

        <div id="progress-container" role="img" aria-labelledby="progress-text">
            <div id="progress-bar"></div>
            <div id="progress-text">0 of {count} &middot; 0%</div>
        </div>

        <p id="message" role="status" aria-live="polite"></p>

        <button type="button" id="reset-button">Reset progress</button>
        <p class="saved-note" id="saved-note">Your ticks are saved in this browser.</p>
    </main>

    <script>
        (function () {{
            var STORAGE_KEY = '{storage}';
            var list = document.getElementById('checklist');
            var boxes = Array.prototype.slice.call(
                list.querySelectorAll('input[type="checkbox"]'));
            var bar = document.getElementById('progress-bar');
            var text = document.getElementById('progress-text');
            var message = document.getElementById('message');
            var note = document.getElementById('saved-note');
            var total = boxes.length;

            // Storage is unavailable in private windows and when site data is
            // blocked, so every read and write is guarded and the page works
            // the same either way — it just forgets between visits.
            var storageOk = true;

            function save() {{
                if (!storageOk) return;
                try {{
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(
                        boxes.filter(function (b) {{ return b.checked; }})
                            .map(function (b) {{ return b.id; }})));
                }} catch (e) {{
                    storageOk = false;
                    note.textContent = 'This browser is not saving your ticks.';
                }}
            }}

            function load() {{
                var raw = null;
                try {{
                    raw = localStorage.getItem(STORAGE_KEY);
                }} catch (e) {{
                    storageOk = false;
                    note.textContent = 'This browser is not saving your ticks.';
                    return;
                }}
                if (!raw) return;
                try {{
                    var ids = JSON.parse(raw);
                    if (!Array.isArray(ids)) return;
                    boxes.forEach(function (b) {{
                        b.checked = ids.indexOf(b.id) !== -1;
                    }});
                }} catch (e) {{ /* corrupt entry, start fresh */ }}
            }}

            function update() {{
                // Counted from the checklist only, so adding a checkbox
                // elsewhere on the page cannot skew the total.
                var done = boxes.filter(function (b) {{ return b.checked; }}).length;
                var pct = Math.round((done / total) * 100);

                bar.style.width = pct + '%';
                text.textContent = done + ' of ' + total + ' \\u00b7 ' + pct + '%';

                if (pct === 100) {{
                    message.textContent = "{msg_100}";
                }} else if (pct >= 75) {{
                    message.textContent = "{msg_75}";
                }} else if (pct >= 50) {{
                    message.textContent = 'Keep it up, you\\u2019re making good progress.';
                }} else if (done > 0) {{
                    message.textContent = "{msg_low}";
                }} else {{
                    message.textContent = 'Start small and work your way up.';
                }}
            }}

            list.addEventListener('change', function (e) {{
                if (e.target.type !== 'checkbox') return;
                save();
                update();
            }});

            document.getElementById('reset-button').addEventListener('click', function () {{
                boxes.forEach(function (b) {{ b.checked = false; }});
                try {{
                    localStorage.removeItem(STORAGE_KEY);
                }} catch (e) {{ /* nothing to clear */ }}
                update();
            }});

            load();
            update();
        }}());
    </script>
</body>

</html>
"""

ITEM = ('            <div class="item">'
        '<input type="checkbox" id="item{i}">'
        '<label for="item{i}">{label}</label></div>')


def build(path, **kw):
    items = "\n".join(ITEM.format(i=i + 1, label=l)
                      for i, l in enumerate(kw.pop("items")))
    html = TEMPLATE.format(items=items, count=len(kw["_n"]), **{
        k: v for k, v in kw.items() if not k.startswith("_")})
    open(os.path.join(ROOT, path), "w", encoding="utf-8").write(html)
    print("wrote", path, os.path.getsize(os.path.join(ROOT, path)), "bytes")


PHILMONT_ITEMS = [
    "Embrace outdoor activities",
    "Practice Leave No Trace principles",
    "Set challenging goals",
    "Develop outdoor skills",
    "Foster teamwork",
    "Simplify your lifestyle",
    "Practice conservation",
    "Embrace a service mindset",
    "Stay physically active",
    "Learn about local history and nature",
    "Practice mindfulness",
    "Cultivate self-reliance",
]

SEABASE_ITEMS = [
    "Explore marine life",
    "Practice water safety",
    "Learn to sail",
    "Engage in water sports",
    "Participate in conservation efforts",
    "Develop navigation skills",
    "Practice teamwork",
    "Stay physically active",
    "Learn about local marine ecosystems",
    "Practice mindfulness",
    "Cultivate self-reliance",
    "Embrace a service mindset",
]

build("toys/philmont.html",
      name="Philmont", lower="Philmont", storage="philmont-checklist",
      lede="Twelve habits from the New Mexico trek, for the other fifty weeks of the year.",
      theme="#2c5f2d", theme_deep="#5c4033", theme_dark="#7fb069",
      theme_deep_dark="#8a7a68",
      accent="#ce1126", accent_hover="#a60d1b",
      accent_dark="#e04a5a", accent_hover_dark="#c33947", accent_fg="#ffffff",
      track="#d9b382", track_dark="#3a3229", fg="#4a3c30",
      msg_100="You&rsquo;re living the Philmont life.",
      msg_75="You&rsquo;re well on your way to the Philmont lifestyle.",
      msg_low="A good start. Keep at it.",
      items=PHILMONT_ITEMS, _n=PHILMONT_ITEMS)

build("toys/seabase.html",
      name="Sea Base", lower="Sea Base", storage="seabase-checklist",
      lede="Twelve habits from the Florida Keys, for the other fifty weeks of the year.",
      theme="#0077be", theme_deep="#005f99", theme_dark="#4db8ff",
      theme_deep_dark="#6a94b8",
      accent="#ffcc00", accent_hover="#e6b800",
      accent_dark="#ffd43b", accent_hover_dark="#e6bc20", accent_fg="#2a2419",
      track="#bfe6ff", track_dark="#1d2b34", fg="#20404f",
      msg_100="You&rsquo;re living the Sea Base life.",
      msg_75="You&rsquo;re well on your way to the Sea Base lifestyle.",
      msg_low="A good start. Keep at it.",
      items=SEABASE_ITEMS, _n=SEABASE_ITEMS)
