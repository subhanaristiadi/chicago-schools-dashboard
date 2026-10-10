# Does a Safe School Mean a Better School?

> Interactive data-analytics dashboard built from the **Chicago Public Schools Progress Report Cards (2011–2012)** — 566 schools, 79 columns, 77 community areas.

**[Live demo →](https://subhanaristiadi.github.io/chicago-schools-dashboard/)**

---

## What it does

The dashboard investigates a single, deceptively simple question: *does a safe school climate actually translate into better academic outcomes?* Rather than assuming the answer, it lets you explore the relationship interactively — filter by school level, community area, or safety quartile, and every chart, table, and insight recomputes in real time.

Nine sections walk through the story:

| # | Section | What it shows |
|---|---------|---------------|
| 1 | **KPI Cards** | Schools analyzed, avg Safety Score, avg Instruction Score, Pearson *r* (Safety vs Instruction) |
| 2 | **Global Filters** | School level (ES / MS / HS), community area (77 areas), safety quartile (Q1–Q4) |
| 3 | **The Big Picture** | Scatter of Safety vs Instruction, colored by level, with least-squares trendline and R value |
| 4 | **Climate × Outcomes Heatmap** | 8 × 9 Pearson correlation matrix, annotated with *r* and *n* per cell |
| 5 | **What Matters Most** | Random-forest feature-importance ranking of climate factors for ISAT Value Add |
| 6 | **Safe vs Less Safe** | Top-25 % vs bottom-25 % Safety Score on seven outcomes (grouped bars + means table) |
| 7 | **Beating the Odds** | Two outlier lists: safe-but-lagging and less-safe-but-strong schools |
| 8 | **Where in Chicago?** | Leaflet map colored by selectable metric + ranked community-area table |
| 9 | **Key Findings + Limitations** | Five plain-English insights generated live from the data, plus a methodology caveats box |

---

## Data

- **Source:** [City of Chicago Data Portal](https://data.cityofchicago.org) — *Chicago Public Schools – Progress Report Cards (2011–2012)*
- **Rows:** 566 schools (462 ES · 11 MS · 93 HS)
- **Columns used:** 8 climate scores, 11 outcome metrics, identifiers, latitude/longitude, community area
- **Missing values:** `"NDA"`, `"N/A"`, and blank cells are coerced to `null` at load time. No imputation. Every chart displays the *n* of complete cases it actually used.
- **Percent-text handling:** Columns like `"95.5%"` are stripped of `%` and parsed; non-numeric tokens become `null`.
- **Bundled data:** The 566-row dataset is embedded in `data.js` so the page works with a double-click — no server, no fetch. A **"Load own CSV"** button in the header lets you swap in a file with the same column layout.

### Quick data profile (unfiltered)

| Metric | Value |
|--------|-------|
| Pearson *r* Safety × Instruction | **0.35** (n = 513) |
| Mean Safety Score | 49.5 |
| Mean Instruction Score | 48.3 |
| Safety Q25 / Q75 cut points | 35 / 61 |
| Top-quartile mean Instruction | 56.7 |
| Bottom-quartile mean Instruction | 42.7 |
| ISAT Value Add complete cases | 201 |
| Most important climate factor (RF) | Environment Score (~14 %) |

---

## How to run locally

No build step, no dependencies to install.

```bash
# Option A — just open it
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux

# Option B — serve with a local server (needed for the CSV upload button)
npx http-server . -o
# or
python -m http.server 8080
```

> **Note:** The "Load own CSV" button uses the `FileReader` API, which works fine over `http(s)://` but is blocked by most browsers when the page is opened directly via `file://`. The map tiles also require a network connection; offline, the community-area table still works.

---

## File structure

```
chicago-schools-dashboard/
├── index.html      # Single-page markup, loads everything in order
├── app.js          # All dashboard logic (~900 lines, organized in 5 layers)
├── style.css       # Light-theme CSS, responsive grid, chart/table/map styles
├── data.js         # Auto-generated dataset (566 records, ~282 KB)
└── README.md       # ← you are here
```

### `app.js` architecture

The code is organized into five clearly commented layers so it's easy to walk through in a portfolio discussion:

1. **Data access** – column maps, numeric coercers, metric definitions
2. **Statistics helpers** – `mean`, `pearson`, `quantile`, `featureImportance` (random forest)
3. **State + filtering** – `applyFilters()` is the single source of truth; every renderer receives the filtered scope
4. **Renderers** – one function per dashboard section (`renderKPIs`, `renderScatter`, `renderHeatmap`, `renderPredictors`, `renderQuartiles`, `renderOutliers`, `renderMap`, `renderInsights`)
5. **Wiring** – `init()`, event listeners, CSV upload handler, tooltip system

---

## Methodology notes

### Random forest instead of OLS regression

The "What Matters Most" section ranks climate factors using a **deterministic random forest** (60 trees, max depth 8, seeded PRNG) rather than a plain OLS multiple regression. The reason: the 8 climate variables are highly collinear (e.g., student attendance ≈ teacher attendance after z-scoring), which makes the OLS normal-equations matrix near-singular. Coefficients become numerically unstable (and, in JS float64, can hit NaN). Random-forest feature importance is robust to this and is the method the project spec explicitly allowed.

### Correlation, not causation

Every insight in the dashboard is phrased in correlational language. A safe climate and strong instruction may share hidden drivers (funding, leadership, neighborhood characteristics). The Limitations box makes this explicit.

### Missing data policy

Values are **dropped per analysis**, never imputed. Each chart and table reports the *n* of complete cases it used. The "Safe vs Less Safe" table shows per-metric *n* because ISAT metrics only cover ES/MS and grad/ACT metrics only cover HS.

### Small middle-school sample

Only 11 middle schools report card data. Any MS-only statistic is fragile and should be read with caution.

---

## Key findings (auto-generated, unfiltered scope)

1. **Safety and Instruction move together** — Pearson *r* = 0.35 (n = 513), a moderate positive association. Safer schools tend to have better instruction, but the relationship is far from deterministic.
2. **Environment Score is the most important climate factor** for predicting ISAT value-add (~14 % of random-forest importance), slightly ahead of Safety itself (~12 %). Attendance and environment factors carry more of the signal.
3. **The quartile gap is real but modest** — top-quartile schools average 56.7 on Instruction vs 42.7 for bottom-quartile (≈ 14 percentile points, 135 vs 138 schools).
4. **Outliers exist in both directions** — 18 schools are safe-but-lagging, 20 are less-safe-but-strong. These are the schools worth a closer look.
5. **Community areas span a wide range** — FOREST GLEN averages ~99 on Safety (3 schools) while WASHINGTON PARK averages ~25, suggesting location explains a large share of the climate gap.

---

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Data | Vanilla JS + bundled `data.js` | Zero dependencies, works offline, double-click deploy |
| Charts | Inline SVG / HTML (no chart library) | Full control over tooltips, labels, and layout |
| Map | [Leaflet 1.9.4](https://leafletjs.com/) (CDN) | Open-source, no API key, works on GitHub Pages |
| Tiles | OpenStreetMap | Free, no attribution issues |
| Styling | Hand-written CSS, CSS Grid + Flexbox | Light theme, responsive, no framework |
| Deploy | GitHub Pages | Static site, no server, no build step |

---

## Updating with new data

To swap in a different year's CPS data:

1. Edit the column mappings at the top of `app.js` (the `CLIMATE`, `OUTCOMES`, and `METRICS` arrays).
2. Regenerate `data.js` from the new CSV (the original generator was a small Python script; the schema is one JSON object per row).
3. If the new dataset has a different level breakdown or community-area list, update the filter dropdowns (they're auto-populated from the data, so usually no changes needed).

---

## License

This project is for **educational and portfolio purposes**. The underlying data is public (City of Chicago Data Portal, CC-BY 4.0). The dashboard code is yours to use, modify, and share.
