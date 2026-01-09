# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static GitHub Pages portfolio site (mbolding.github.io) showcasing interactive educational tools, scientific simulations, games, and learning resources. All projects are self-contained HTML/CSS/JavaScript with no build tools or server-side logic.

## Development

**No build step required** - files are served directly as static assets on GitHub Pages.

To develop locally, serve the directory with any static file server:
```bash
python -m http.server 8000
# or
npx serve .
```

## Architecture

### Site Structure
- `index.html` - Main landing page with card-based grid showcasing all projects
- `archive.html` - Links to older/legacy projects
- Each subdirectory contains a self-contained project with its own HTML/CSS/JS

### Project Organization
Each interactive module is self-contained:
- Embedded CSS in `<style>` tags
- Embedded JavaScript in `<script>` tags
- Canvas API or DOM-based rendering
- No shared component library

### Key Directories
| Directory | Purpose |
|-----------|---------|
| `/neural_plasticity/` | Hebbian learning, LIF neuron simulations |
| `/quizzes/` | Neuroscience education quizzes |
| `/fourier/` | Fourier analysis visualization |
| `/flocking/` | Boid algorithm simulation |
| `/toys/` | Games (Minesweeper, Hex, typing test, etc.) |
| `/calculators/` | Scientific calculator with Pyodide Python REPL |
| `/notes/` | Note-taking, mind mapping, Mermaid diagrams |
| `/garrity/` | Interactive math examples |

## Technology Stack

- **Markup**: Semantic HTML5
- **Styling**: CSS3 with CSS variables for theming (dark/light mode via `.dark` class)
- **JavaScript**: Vanilla ES6+ (no frameworks)
- **Graphics**: HTML5 Canvas API
- **Persistence**: Browser localStorage
- **External CDNs**: Google Fonts, Tailwind CSS (some files), Chart.js, Pyodide, Mermaid.js

## Design Patterns

- **Dark mode**: Toggle via `.dark` class on root element; use CSS custom properties for colors
- **Responsive layouts**: CSS Grid and Flexbox; mobile-first approach
- **Typography**: Multiple font families (Inter, ET Book, Playfair Display, Source Sans Pro, Fira Code)
- **Design styles vary**: Tufte-inspired minimalist, Swiss design, modern glassmorphism depending on project

## When Adding New Projects

1. Create a new directory with a self-contained `index.html`
2. Embed CSS and JavaScript within the HTML file
3. Add a card entry to the main `index.html` in the appropriate section
4. Follow existing theming patterns (CSS variables, dark mode support)
