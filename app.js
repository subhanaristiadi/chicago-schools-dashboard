/* ============================================================================
   "Does a Safe School Mean a Better School?" — dashboard logic
   ----------------------------------------------------------------------------
   Self-contained (vanilla JS + Leaflet for the map). Data is loaded from the
   bundled data.js (generated from chicago_public_schools.csv). Everything
   below is organized in layers so it is easy to walk through:

     1. Data access        -> SCHOOLS, column maps, numeric coercers
     2. Statistics helpers -> mean / std / pearson / quantile / random-forest importance
     3. State + filtering  -> applyFilters() drives every chart
     4. Renderers          -> one function per dashboard section
     5. Wiring            -> init(), event listeners, CSV upload
   ============================================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
     1 · DATA ACCESS
     ------------------------------------------------------------------ */

  // Bundled dataset. Each record has cleaned string fields plus numeric
  // fields that are null when the source value was blank, "NDA", or "N/A".
  let SCHOOLS = Array.isArray(window.SCHOOLS) ? window.SCHOOLS.slice() : [];

  // Column-name -> record-key maps (names are whitespace-stripped).
  const CLIMATE = [
    { key: 'safety',       label: 'Safety Score',            short: 'Safety' },
    { key: 'environment',  label: 'Environment Score',       short: 'Environment' },
    { key: 'familyInvolve',label: 'Family Involvement Score',short: 'Family Involvement' },
    { key: 'parentEngage', label: 'Parent Engagement Score', short: 'Parent Engagement' },
    { key: 'parentEnv',    label: 'Parent Environment Score',short: 'Parent Environment' },
    { key: 'studAttend',   label: 'Avg Student Attendance',  short: 'Student Att.' },
    { key: 'misconduct',   label: 'Misconducts / 100',       short: 'Misconduct' },
    { key: 'teacherAttend',label: 'Avg Teacher Attendance',  short: 'Teacher Att.' }
  ];

  // Outcome columns used in the heatmap (readable set; see note under chart).
  const OUTCOMES = [
    { key: 'instruction',  short: 'Instruction' },
    { key: 'isatVAMath',   short: 'ISAT VA Math' },
    { key: 'isatVAre',     short: 'ISAT VA Read' },
    { key: 'isatExMath',   short: 'ISAT Exc. Math' },
    { key: 'isatExRead',   short: 'ISAT Exc. Read' },
    { key: 'gr35Math',     short: 'Gr3-5 Math' },
    { key: 'gr35Read',     short: 'Gr3-5 Read' },
    { key: 'gradRate',     short: 'Grad Rate' },
    { key: 'act',          short: '11th ACT' }
  ];

  // Map / community-area metric picker.
  const METRICS = [
    { key: 'safety',     label: 'Safety Score',           short: 'Safety',  get: s => s.safety,     higherBetter: true },
    { key: 'instruction',label: 'Instruction Score',       short: 'Instr',   get: s => s.instruction,higherBetter: true },
    { key: 'isatVA',     label: 'ISAT Value Add (avg)',    short: 'ISAT VA', get: s => avgPair(s.isatVAMath, s.isatVAre), higherBetter: true },
    { key: 'isatExMath', label: 'ISAT Exceeding Math %',   short: 'Exc M',   get: s => s.isatExMath,  higherBetter: true },
    { key: 'gradRate',   label: 'Graduation Rate %',       short: 'Grad',    get: s => s.gradRate,    higherBetter: true },
    { key: 'act',        label: '11th Grade Avg ACT',      short: 'ACT',     get: s => s.act,         higherBetter: true },
    { key: 'studAttend', label: 'Avg Student Attendance %',short: 'StuAtt',  get: s => s.studAttend,  higherBetter: true },
    { key: 'misconduct', label: 'Misconducts / 100',       short: 'Miscond', get: s => s.misconduct,  higherBetter: false }
  ];

  // Metrics compared in "Safe vs Less Safe".
  const QMETRICS = [
    { key: 'instruction', label: 'Instruction Score',          get: s => s.instruction, higher: true },
    { key: 'isatVAMath',  label: 'ISAT Value Add Math',        get: s => s.isatVAMath,  higher: true },
    { key: 'isatExMath',  label: 'ISAT Exceeding Math %',       get: s => s.isatExMath,  higher: true },
    { key: 'gr35Read',    label: 'Gr3-5 Grade Level Read %',   get: s => s.gr35Read,    higher: true },
    { key: 'gradRate',    label: 'Graduation Rate %',           get: s => s.gradRate,    higher: true },
    { key: 'studAttend',  label: 'Avg Student Attendance %',   get: s => s.studAttend,  higher: true },
    { key: 'misconduct',  label: 'Misconducts / 100',           get: s => s.misconduct,  higher: false }
  ];

  const LEVEL_COLORS = { ES: '#2563eb', MS: '#16a34a', HS: '#f97316' };
  const LEVEL_NAMES  = { ES: 'Elementary', MS: 'Middle', HS: 'High' };

  function avgPair(a, b) {
    if (a != null && b != null) return (a + b) / 2;
    return a != null ? a : b; // one-sided fallback; null if both missing
  }

  /* ------------------------------------------------------------------
     2 · STATISTICS HELPERS
     ------------------------------------------------------------------ */

  function mean(vals) {
    vals = vals.filter(v => v != null);
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  }

  // Pearson correlation on pairwise-complete cases. Returns { r, n }.
  function pearson(rows, keyX, keyY, getX, getY) {
    const xs = [], ys = [];
    rows.forEach(s => {
      const x = (getX ? getX(s) : s[keyX]);
      const y = (getY ? getY(s) : s[keyY]);
      if (x != null && y != null) { xs.push(x); ys.push(y); }
    });
    const n = xs.length;
    if (n < 3) return { r: null, n };
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      cov += dx * dy; vx += dx * dx; vy += dy * dy;
    }
    if (vx === 0 || vy === 0) return { r: null, n };
    return { r: cov / Math.sqrt(vx * vy), n };
  }

  // Linear-interpolation quantile over an already-sorted numeric array.
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const idx = (sorted.length - 1) * q;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function safetyQuantiles(rows) {
    const vals = rows.filter(s => s.safety != null).map(s => s.safety).sort((a, b) => a - b);
    if (vals.length < 4) return null;
    return { p25: quantile(vals, 0.25), p50: quantile(vals, 0.5), p75: quantile(vals, 0.75) };
  }

  function quartileOf(v, b) {
    if (v == null || !b) return null;
    if (v <= b.p25) return 'Q1';
    if (v <= b.p50) return 'Q2';
    if (v <= b.p75) return 'Q3';
    return 'Q4';
  }

  /* Random-forest feature importance.
     The 8 climate variables are strongly collinear (e.g., student & teacher
     attendance track each other), so a plain OLS multiple-regression is
     numerically ill-posed. A random forest sidesteps that: it ranks each
     feature by the mean drop in prediction error when the feature is
     shuffled, averaged across all trees and all splits that used it. */
  function featureImportance(rows, targetGetter) {
    const full = rows.filter(s => {
      const t = targetGetter(s);
      return t != null && CLIMATE.every(c => s[c.key] != null);
    });
    const n = full.length;
    if (n < 30) return { imp: null, n, tooSmall: true };

    const yAll = full.map(targetGetter);
    const feat = CLIMATE.map(c => full.map(s => s[c.key]));
    const k = CLIMATE.length;

    // Deterministic PRNG so re-renders are stable (portfolio-friendly).
    let seed = 20261010;
    function rand() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }

    // --- build one regression tree ---
    function varr(vals) {
      if (vals.length < 2) return 0;
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return vals.reduce((a, v) => a + (v - m) * (v - m), 0) / vals.length;
    }

    function build(idx, depth, maxDepth) {
      const yv = idx.map(i => yAll[i]);
      const nP = idx.length;
      if (nP < 8 || depth >= maxDepth || yv.length < 2 || varr(yv) < 1e-9) {
        return { leaf: true, val: yv.reduce((a, b) => a + b, 0) / nP };
      }
      // Try each feature at a small set of candidate thresholds.
      let best = null;
      for (let f = 0; f < k; f++) {
        const order = idx.slice().sort((a, b) => feat[f][a] - feat[f][b]);
        const vals = order.map(i => feat[f][i]);
        // Candidate split points at evenly spaced quantiles of this node's values.
        const candidates = [0.25, 0.5, 0.75].map(q => vals[Math.floor(q * (nP - 1))]);
        const uniq = Array.from(new Set(candidates));
        for (const th of uniq) {
          const left = [], right = [];
          for (const i of idx) (feat[f][i] <= th ? left : right).push(i);
          if (left.length < 5 || right.length < 5) continue;
          const yl = left.map(i => yAll[i]), yr = right.map(i => yAll[i]);
          const wSum = left.length + right.length;
          const gain = varr(yv) - (left.length / wSum) * varr(yl) - (right.length / wSum) * varr(yr);
          if (gain > 1e-9 && (!best || gain > best.gain)) {
            best = { f, th, gain, left, right, imp: gain };
          }
        }
      }
      if (!best) return { leaf: true, val: yv.reduce((a, b) => a + b, 0) / nP };
      return {
        f: best.f, th: best.th, imp: best.imp,
        left: build(best.left, depth + 1, maxDepth),
        right: build(best.right, depth + 1, maxDepth)
      };
    }

    function predict(tree, row) {
      let node = tree;
      while (!node.leaf) {
        node = row[node.f] <= node.th ? node.left : node.right;
      }
      return node.val;
    }

    // Grow the forest on bootstrap samples; accumulate importance.
    const N_TREE = 60;
    const MAX_DEPTH = 8;
    const raw = new Array(k).fill(0);
    let totW = 0;
    const trees = [];
    for (let t = 0; t < N_TREE; t++) {
      const bag = new Array(n);
      for (let i = 0; i < n; i++) bag[i] = Math.floor(rand() * n);
      const tree = build(bag, 0, MAX_DEPTH);
      trees.push(tree);
      // importance by sum of gain*weight over nodes that split on feature f
      (function walk(node) {
        if (node.leaf) return;
        raw[node.f] += node.imp * 1; // relative-gain importance
        totW += node.imp;
        walk(node.left); walk(node.right);
      })(tree);
    }

    // Normalize to 0..1 share of total importance.
    const imp = raw.map(v => (totW > 0 ? v / totW : 0));
    return { imp, n, trees, tooSmall: false };
  }

  // Ordinary least squares (unstandardized) for a trendline.
  function linreg(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (den === 0) return null;
    const slope = num / den;
    return { slope, intercept: my - slope * mx };
  }

  /* ------------------------------------------------------------------
     3 · STATE + FILTERING
     ------------------------------------------------------------------ */

  const state = { level: 'ALL', ca: 'ALL', quartile: 'ALL', mapMetric: 'safety', caView: 'top' };

  function baseFiltered() {
    let s = SCHOOLS;
    if (state.level !== 'ALL') s = s.filter(x => x.level === state.level);
    if (state.ca !== 'ALL') s = s.filter(x => x.ca === state.ca);
    return s;
  }

  function applyFilters() {
    const s = baseFiltered();
    if (state.quartile === 'ALL') return s;
    const b = safetyQuantiles(s);
    if (!b) return s; // not enough data to define quartiles
    return s.filter(x => quartileOf(x.safety, b) === state.quartile);
  }

  /* ------------------------------------------------------------------
     4 · RENDERERS
     ------------------------------------------------------------------ */

  const $ = id => document.getElementById(id);
  const fmt = (v, dec = 1) => (v == null ? '—' : Number(v).toFixed(dec));
  const fmtInt = v => (v == null ? '—' : Math.round(v).toLocaleString());

  function setNote(id, html) { const el = $(id); if (el) el.innerHTML = html; }

  /* ---- SECTION 1 · KPI cards ---- */
  function renderKPIs(scope) {
    const cnt = scope.length;
    const avgSafe = mean(scope.map(s => s.safety));
    const avgInstr = mean(scope.map(s => s.instruction));
    const p = pearson(scope, 'safety', 'instruction');

    $('kpi-count').textContent = fmtInt(cnt);
    $('kpi-count-sub').textContent = scopeLevelSummary(scope);

    $('kpi-safety').textContent = fmt(avgSafe);
    $('kpi-safety-sub').textContent = 'n = ' + scope.filter(s => s.safety != null).length + ' schools reporting';

    $('kpi-instruction').textContent = fmt(avgInstr);
    $('kpi-instruction-sub').textContent = 'n = ' + scope.filter(s => s.instruction != null).length + ' schools reporting';

    $('kpi-r').textContent = p.r == null ? '—' : p.r.toFixed(2);
    $('kpi-r-sub').textContent = 'Pearson r · n = ' + p.n;
  }

  function scopeLevelSummary(scope) {
    const c = { ES: 0, MS: 0, HS: 0 };
    scope.forEach(s => { if (c[s.level] != null) c[s.level]++; });
    if (state.level !== 'ALL') return 'filtered: ' + LEVEL_NAMES[state.level];
    const parts = ['ES ' + c.ES, 'MS ' + c.MS, 'HS ' + c.HS];
    return parts.join(' · ');
  }

  /* ---- SECTION 3 · Scatter (Safety vs Instruction) ---- */
  function renderScatter(scope) {
    const host = $('scatter-chart');
    const pairs = [];
    scope.forEach(s => { if (s.safety != null && s.instruction != null) pairs.push(s); });

    if (pairs.length < 5) {
      host.innerHTML = '<div class="hint-empty">Not enough schools with both Safety and Instruction scores to plot (n=' + pairs.length + ').</div>';
      setNote('scatter-note', '');
      return;
    }

    const W = 760, H = 460, M = { t: 18, r: 20, b: 52, l: 56 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const xs = pairs.map(s => s.safety), ys = pairs.map(s => s.instruction);
    const x0 = 0, x1 = 100, y0 = Math.max(0, Math.min(...ys) - 5), y1 = 100;
    const X = v => M.l + (v - x0) / (x1 - x0) * iw;
    const Y = v => M.t + ih - (v - y0) / (y1 - y0) * ih;

    const p = pearson(scope, 'safety', 'instruction');
    const lr = linreg(pairs.map(s => s.safety), pairs.map(s => s.instruction));

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Scatter of Safety vs Instruction">'
      + svgGrid(X, Y, x0, x1, y0, y1, M, iw, ih)
      + svgTrendline(lr, X, Y, x0, x1);

    // Dots (drawn last so they sit above the grid/trendline).
    svg += '<g>';
    pairs.forEach((s, i) => {
      svg += '<circle class="dot" data-i="' + i + '" cx="' + X(s.safety).toFixed(1) + '" cy="' + Y(s.instruction).toFixed(1)
        + '" r="4" fill="' + (LEVEL_COLORS[s.level] || '#94a3b8') + '" fill-opacity="0.72"></circle>';
    });
    svg += '</g>';

    svg += svgAxisLabels(X, Y, x0, x1, y0, y1, M, iw, ih, 'Safety Score (1–99)', 'Instruction Score (1–99)');
    svg += '</svg>';
    host.innerHTML = svg;

    // Hover tooltips.
    host.querySelectorAll('.dot').forEach(dot => {
      const s = pairs[+dot.dataset.i];
      dot.addEventListener('mouseenter', e => showTooltip(e,
        '<div class="tt-title">' + esc(s.name) + '</div>'
        + '<div class="tt-mut">' + (LEVEL_NAMES[s.level] || s.level) + ' · ' + esc(s.ca) + '</div>'
        + 'Safety: <b>' + fmt(s.safety, 0) + '</b> · Instruction: <b>' + fmt(s.instruction, 0) + '</b>'
      ));
      dot.addEventListener('mousemove', moveTooltip);
      dot.addEventListener('mouseleave', hideTooltip);
    });

    // Level legend + R readout.
    let legend = '<div class="level-legend">';
    ['ES', 'MS', 'HS'].forEach(lv => {
      legend += '<span><span class="sw" style="background:' + LEVEL_COLORS[lv] + '"></span>'
        + LEVEL_NAMES[lv] + ' (' + pairs.filter(s => s.level === lv).length + ')</span>';
    });
    legend += '<span style="margin-left:auto">Trend r = <b>' + (p.r == null ? '—' : p.r.toFixed(2)) + '</b></span></div>';
    host.innerHTML = legend + svg;

    setNote('scatter-note',
      'n = ' + p.n + ' schools have both scores. The dashed line is a least-squares fit '
      + '(Instruction = ' + fmt(lr.intercept, 1) + ' + ' + fmt(lr.slope, 2) + ' · Safety). '
      + 'Pearson r = <b>' + p.r.toFixed(2) + '</b> — a ' + strengthWord(p.r) + ' positive association: safer schools '
      + 'tend to score higher on instruction, but there is wide overlap.');
  }

  function strengthWord(r) {
    const a = Math.abs(r);
    if (a < 0.2) return 'weak';
    if (a < 0.4) return 'moderate';
    if (a < 0.6) return 'strong';
    return 'very strong';
  }

  function svgGrid(X, Y, x0, x1, y0, y1, M, iw, ih) {
    let g = '<g>';
    const xt = ticks(x0, x1, 5), yt = ticks(y0, y1, 5);
    xt.forEach(t => {
      g += '<line class="grid-line" x1="' + X(t) + '" y1="' + M.t + '" x2="' + X(t) + '" y2="' + (M.t + ih) + '"/>';
      g += '<text class="axis-label" x="' + X(t) + '" y="' + (M.t + ih + 18) + '" text-anchor="middle">' + t + '</text>';
    });
    yt.forEach(t => {
      g += '<line class="grid-line" x1="' + M.l + '" y1="' + Y(t) + '" x2="' + (M.l + iw) + '" y2="' + Y(t) + '"/>';
      g += '<text class="axis-label" x="' + (M.l - 10) + '" y="' + (Y(t) + 4) + '" text-anchor="end">' + t + '</text>';
    });
    g += '<line class="axis-line" x1="' + M.l + '" y1="' + (M.t + ih) + '" x2="' + (M.l + iw) + '" y2="' + (M.t + ih) + '"/>';
    g += '<line class="axis-line" x1="' + M.l + '" y1="' + M.t + '" x2="' + M.l + '" y2="' + (M.t + ih) + '"/>';
    g += '</g>';
    return g;
  }

  function svgTrendline(lr, X, Y, x0, x1) {
    if (!lr) return '';
    const ya = lr.intercept + lr.slope * x0, yb = lr.intercept + lr.slope * x1;
    return '<line x1="' + X(x0) + '" y1="' + Y(ya) + '" x2="' + X(x1) + '" y2="' + Y(yb)
      + '" stroke="#111827" stroke-width="1.6" stroke-dasharray="6 5" opacity="0.65"/>';
  }

  function svgAxisLabels(X, Y, x0, x1, y0, y1, M, iw, ih) {
    const cx = M.l + iw / 2, cy = M.t + ih / 2;
    return '<text class="axis-title" x="' + cx + '" y="' + (M.t + ih + 40) + '" text-anchor="middle">Safety Score (1–99)</text>'
      + '<text class="axis-title" transform="translate(14,' + cy + ') rotate(-90)" text-anchor="middle">Instruction Score (1–99)</text>';
  }

  function ticks(a, b, n) {
    const step = (b - a) / n, out = [];
    for (let i = 0; i <= n; i++) out.push(Math.round(a + step * i));
    return out;
  }

  /* ---- SECTION 4 · Heatmap ----
     Cell data is kept in a local array and referenced by index (data-ci),
     which avoids HTML-escaping pitfalls of embedding JSON in attributes. */
  function renderHeatmap(scope) {
    const host = $('heatmap-chart');
    let grid = '<div class="heatmap" style="grid-template-columns: 170px repeat(' + OUTCOMES.length + ', 1fr)">'
      + '<div class="cell corner"></div>'
      + OUTCOMES.map(o => '<div class="col-label">' + o.short + '</div>').join('');

    const heatData = [];
    CLIMATE.forEach(c => {
      grid += '<div class="row-label">' + c.label + '</div>';
      OUTCOMES.forEach(o => {
        const p = pearson(scope, c.key, o.key);
        heatData.push({ r: p.r, n: p.n, cx: c.label, oc: o.short });
        grid += heatCell(p.r, p.n, heatData.length - 1);
      });
    });

    grid += '<div class="legend-bar"><span>−1 (strong negative)</span>'
      + '<span class="legend-gradient"></span><span>+1 (strong positive)</span></div>';
    host.innerHTML = grid;

    setNote('heatmap-note',
      'Values are Pearson r with pairwise-complete cases (n shown on hover). '
      + 'Climate variables are percentile-style scores; outcome columns mix ES/MS (ISAT) and HS (grad/ACT) '
      + 'metrics, so each cell reflects the current scope&rsquo;s available cases.');

    host.querySelectorAll('.cell[data-ci]').forEach(cell => {
      const d = heatData[+cell.dataset.ci];
      cell.addEventListener('mouseenter', e => showTooltip(e,
        '<div class="tt-title">' + d.cx + ' × ' + d.oc + '</div>'
        + 'r = <b>' + (d.r == null ? 'n/a' : d.r.toFixed(2)) + '</b> · n = ' + d.n
        + '<div class="tt-mut">' + (d.r == null ? 'insufficient cases'
            : strengthWord(d.r) + ' ' + (d.r >= 0 ? 'positive' : 'negative') + ' association') + '</div>'
      ));
      cell.addEventListener('mousemove', moveTooltip);
      cell.addEventListener('mouseleave', hideTooltip);
    });
  }

  function heatCell(r, n, ci) {
    if (r == null) {
      return '<div class="cell" data-ci="' + ci + '" style="background:#f3f4f6;color:#9ca3af">—</div>';
    }
    const base = r >= 0 ? [37, 99, 235] : [234, 88, 12];
    const white = [255, 255, 255];
    const t = Math.min(1, Math.abs(r)) * 0.92;
    const c = white.map((w, i) => Math.round(w + (base[i] - w) * t));
    const dark = t > 0.45;
    return '<div class="cell" data-ci="' + ci + '" style="background:rgb(' + c.join(',') + ');color:' + (dark ? '#fff' : '#1f2937') + '">'
      + (r >= 0 ? '+' : '') + r.toFixed(2) + '<span class="sub">n=' + n + '</span></div>';
  }

  /* ---- SECTION 5 · What Matters Most (standardized betas) ---- */
  function renderPredictors(scope) {
    const host = $('predictor-chart');
    // Random-forest importance for ISAT Value Add (average math + read value-add).
    const res = featureImportance(scope, s => avgPair(s.isatVAMath, s.isatVAre));

    if (res.tooSmall) {
      host.innerHTML = '<div class="hint-empty">Complete-case sample for ISAT Value Add is too small in this scope '
        + '(n=' + res.n + '; need &ge;30). Widen the level filter or clear the safety-quartile filter.</div>';
      setNote('predictor-note', '<b>Method: random-forest feature importance</b> of ISAT Value Add on 8 climate factors.');
      return;
    }

    // Rank factors by their share of total predictive importance (0..100%).
    const pairs = CLIMATE.map((c, i) => ({ label: c.label, key: c.key, imp: res.imp[i] }));
    pairs.sort((a, b) => b.imp - a.imp);
    const maxImp = Math.max(0.001, ...pairs.map(p => p.imp));

    // Single-sided horizontal bars, ranked top-down.
    let html = '<div class="bar-row" style="border:0">'
      + '<div class="bar-name"></div><div class="bar-track"></div><div class="bar-val"></div></div>';
    pairs.forEach(p => {
      const w = p.imp / maxImp * 100;
      const rpair = pearson(scope, p.key, undefined, s => s[p.key], s => avgPair(s.isatVAMath, s.isatVAre)).r;
      html += '<div class="bar-row" title="Importance ' + (p.imp * 100).toFixed(1) + '% · pairwise r with ISAT value-add = ' + (rpair == null ? '—' : rpair.toFixed(2)) + '">'
        + '<div class="bar-name">' + p.label + '</div>'
        + '<div class="bar-track"><div class="bar-fill" style="left:0%;width:' + w + '%;background:linear-gradient(90deg,#3b82f6,#2563eb)"></div></div>'
        + '<div class="bar-val">' + (p.imp * 100).toFixed(1) + '%</div>'
        + '</div>';
    });
    html += '<div style="display:grid;grid-template-columns:190px 1fr 64px;gap:10px;margin-top:4px">'
      + '<div></div>'
      + '<div style="font-size:11px;color:var(--muted);text-align:center">Share of total predictive importance</div>'
      + '<div></div></div>';
    host.innerHTML = html;

    setNote('predictor-note',
      '<b>Method: random-forest feature importance</b> (mean decrease in prediction error, '
      + '60 deterministic trees, depth &le; 8) of ISAT Value Add &mdash; the average of the math and reading '
      + 'value-add &mdash; on all 8 climate factors, using <em>n</em> = ' + res.n + ' complete cases. '
      + 'A random forest is used instead of a plain regression because the climate variables are highly '
      + 'correlated, which makes OLS coefficients unstable. The most important factor is <b>' + pairs[0].label
      + '</b> (' + (pairs[0].imp * 100).toFixed(1) + '% of total importance). Hover a bar for that factor&rsquo;s '
      + 'pairwise r with ISAT value-add.');
  }

  /* ---- SECTION 6 · Safe vs Less Safe ---- */
  function renderQuartiles(scope) {
    const chart = $('quartile-chart'), table = $('quartile-table');
    const b = safetyQuantiles(scope);
    if (!b) { chart.innerHTML = table.innerHTML = '<div class="hint-empty">Not enough schools with Safety scores to form quartiles in this scope.</div>'; setNote('quartile-note',''); return; }

    const top = scope.filter(s => s.safety != null && s.safety >= b.p75);
    const bot = scope.filter(s => s.safety != null && s.safety <= b.p25);

    // Grouped bars (one pair per metric, each metric scaled to its own max).
    let bars = '<div class="qlegend"><span><span class="sw" style="background:var(--positive)"></span>Top 25% Safety</span>'
      + '<span><span class="sw" style="background:var(--negative)"></span>Bottom 25% Safety</span></div>';
    QMETRICS.forEach(m => {
      const tm = mean(top.map(m.get)), bm = mean(bot.map(m.get));
      const maxv = Math.max(tm ?? 0, bm ?? 0) || 1;
      const tw = tm == null ? 0 : (tm / maxv) * 100;
      const bw = bm == null ? 0 : (bm / maxv) * 100;
      bars += '<div class="qbar-row"><div class="name">' + m.label + '</div>'
        + '<div class="qpair" title="Top25 mean ' + fmt(tm) + ' · Bot25 mean ' + fmt(bm) + '">'
        + '<div class="fill-top" style="width:' + tw + '%"></div>'
        + '<div class="fill-bottom" style="width:' + bw + '%"></div>'
        + '<span class="val top" style="color:var(--positive)">' + fmt(tm) + '</span>'
        + '<span class="val bottom" style="color:var(--negative)">' + fmt(bm) + '</span>'
        + '</div></div>';
    });
    chart.innerHTML = bars;

    // Means table with sample sizes.
    let thead = '<thead><tr><th>Metric</th><th class="num">Top 25% mean</th><th class="num">Bot 25% mean</th>'
      + '<th class="num">Gap</th><th class="num">n top / n bot</th></tr></thead><tbody>';
    let tbody = '';
    QMETRICS.forEach(m => {
      const tv = top.map(m.get).filter(v => v != null);
      const bv = bot.map(m.get).filter(v => v != null);
      const tm = tv.length ? tv.reduce((a, b) => a + b, 0) / tv.length : null;
      const bm = bv.length ? bv.reduce((a, b) => a + b, 0) / bv.length : null;
      const gap = (tm != null && bm != null) ? tm - bm : null;
      const good = gap != null ? (m.higher ? gap > 0 : gap < 0) : null;
      tbody += '<tr><td>' + m.label + '</td>'
        + '<td class="num">' + fmt(tm) + '</td>'
        + '<td class="num">' + fmt(bm) + '</td>'
        + '<td class="num"><span style="color:' + (good ? 'var(--positive)' : 'var(--negative)') + '">'
        + (gap == null ? '—' : (gap >= 0 ? '+' : '') + fmt(gap)) + '</span></td>'
        + '<td class="num mutedcell">' + tv.length + ' / ' + bv.length + '</td></tr>';
    });
    table.innerHTML = '<div class="table-scroll"><table class="data">' + thead + tbody + '</tbody></table></div>';

    setNote('quartile-note',
      'Quartile cut points in this scope: safety Q25 &le; <b>' + fmt(b.p25, 0) + '</b>, Q75 &ge; <b>' + fmt(b.p75, 0)
      + '</b>. Top-25 schools average <b>' + fmt(mean(top.map(s => s.instruction))) + '</b> on Instruction vs <b>'
      + fmt(mean(bot.map(s => s.instruction))) + '</b> for the bottom-25. Fewer schools report the ES/MS (ISAT) '
      + 'and HS (grad/ACT) metrics, so sample sizes differ by row &mdash; read the <em>n</em> column before comparing.');
  }

  /* ---- SECTION 7 · Beating the Odds (outliers) ---- */
  function renderOutliers(scope) {
    const b = safetyQuantiles(scope);
    const instrVals = scope.filter(s => s.instruction != null).map(s => s.instruction).sort((a, b) => a - b);
    const iB = instrVals.length >= 4 ? { p25: quantile(instrVals, 0.25), p75: quantile(instrVals, 0.75) } : null;

    const safeLag = iB ? scope.filter(s => s.safety != null && s.instruction != null
      && s.safety >= b.p75 && s.instruction <= iB.p25) : [];
    const lagSafe = iB ? scope.filter(s => s.safety != null && s.instruction != null
      && s.safety <= b.p25 && s.instruction >= iB.p75) : [];

    safeLag.sort((a, b) => a.instruction - b.instruction); // most extreme lag first
    lagSafe.sort((a, b) => b.instruction - a.instruction); // most extreme strong first

    const cols = ['<th>Lvl</th><th>School</th><th>Community area</th><th class="num">Safety</th><th class="num">Instruction</th>'];
    const cap = 10;
    $('outliers-a').innerHTML = outlierTable(safeLag.slice(0, cap), cols);
    $('outliers-b').innerHTML = outlierTable(lagSafe.slice(0, cap), cols);

    setNote('outliers-note',
      '<b>(a) ' + safeLag.length + '</b> schools are in the top-quartile for safety yet bottom-quartile for '
      + 'instruction — <b>(b) ' + lagSafe.length + '</b> are the reverse. '
      + (safeLag.length || lagSafe.length ? 'These are the outliers worth a closer look (full lists scroll).' : 'Few/no clean outliers in this scope.')
      + ' Cut points: safety Q75=' + fmt(b.p75, 0) + ' · instruction Q25=' + fmt(iB.p25, 0) + ' / Q75=' + fmt(iB.p75, 0) + '.');
  }

  function outlierTable(rows, headCols) {
    if (!rows.length) return '<table class="data"><thead><tr>' + headCols.join('') + '</tr></thead><tbody><tr><td colspan="5" class="mutedcell">No schools match in this scope.</td></tr></tbody></table>';
    const body = rows.map(s =>
      '<tr><td><span class="tag ' + s.level + '">' + s.level + '</span></td>'
      + '<td>' + esc(s.name) + '</td><td>' + esc(s.ca) + '</td>'
      + '<td class="num">' + fmt(s.safety, 0) + '</td><td class="num">' + fmt(s.instruction, 0) + '</td></tr>'
    ).join('');
    return '<table class="data"><thead><tr>' + headCols.join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  /* ---- SECTION 8 · Map + community-area table ---- */
  let map = null, markerLayer = null;

  function initMap() {
    if (typeof L === 'undefined') {
      $('map').innerHTML = '<div class="hint-empty">Map library unavailable (offline). The community-area table below still works.</div>';
      return;
    }
    map = L.map('map', { scrollWheelZoom: false, attributionControl: true }).setView([41.85, -87.68], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function metricBy(key) { return METRICS.find(m => m.key === key) || METRICS[0]; }

  function renderMap() {
    const m = metricBy(state.mapMetric);
    const scope = applyFilters();
    const values = scope.map(s => m.get(s)).filter(v => v != null);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;

    // Update the community-area panel heading with the active metric.
    $('ca-metric-name').textContent = m.label;

    // Legend.
    $('map-legend').innerHTML =
      '<div>Scale (' + (m.higherBetter ? 'higher = better' : 'higher = worse') + ')</div>'
      + '<div class="grad" style="--lo:#dbeafe;--hi:#1e3a8a"></div>'
      + '<div class="grad-labels"><span>' + fmt(min, m.key === 'act' || m.key === 'studAttend' ? 1 : 0) + '</span>'
      + '<span>' + fmt(max, m.key === 'act' || m.key === 'studAttend' ? 1 : 0) + '</span></div>'
      + '<div style="font-size:11px">n = ' + values.length + ' schools with data</div>';

    if (map && markerLayer) {
      markerLayer.clearLayers();
      scope.forEach(s => {
        const v = m.get(s);
        if (v == null || s.lat == null || s.lon == null) return;
        const t = max === min ? 0.5 : (v - min) / (max - min);
        const color = lerpColor([219, 190, 254], [30, 58, 138], t); // light -> dark blue
        L.circleMarker([s.lat, s.lon], {
          radius: 4, color: '#fff', weight: 0.6,
          fillColor: color, fillOpacity: 0.78
        }).bindTooltip('<b>' + esc(s.name) + '</b><br>' + m.label + ': ' + fmt(v, m.key === 'act' ? 1 : 0), { direction: 'top' })
        .addTo(markerLayer);
      });
    }

    renderCATable(m, scope);
  }

  function lerpColor(a, b, t) {
    return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')';
  }

  function renderCATable(m, scope) {
    const groups = {};
    scope.forEach(s => {
      const v = m.get(s);
      if (v == null) return;
      (groups[s.ca] = groups[s.ca] || { sum: 0, n: 0 });
      groups[s.ca].sum += v; groups[s.ca].n++;
    });
    const rows = Object.entries(groups)
      .map(([ca, g]) => ({ ca, avg: g.sum / g.n, n: g.n }))
      .sort((a, b) => m.higherBetter ? b.avg - a.avg : a.avg - b.avg);

    let shown;
    if (state.caView === 'top') shown = rows.slice(0, 10);
    else if (state.caView === 'bottom') shown = rows.slice(-10).reverse();
    else shown = rows;

    const thead = '<thead><tr><th>#</th><th>Community area</th><th class="num">Avg ' + m.short + '</th><th class="num">Schools</th></tr></thead>';
    const dec = m.key === 'act' || m.key === 'studAttend' ? 1 : 0;
    const tbody = '<tbody>' + (shown.length ? shown.map((r, i) =>
      '<tr><td class="mutedcell">' + (i + 1) + '</td><td>' + esc(r.ca) + '</td>'
      + '<td class="num">' + r.avg.toFixed(dec) + '</td><td class="num mutedcell">' + r.n + '</td></tr>'
    ).join('') : '<tr><td colspan="4" class="mutedcell">No areas with data in this scope.</td></tr>') + '</tbody>';

    $('ca-table').innerHTML = '<table class="data">' + thead + tbody + '</table>';
  }

  /* ---- SECTION 9 · Key findings (dynamic) ---- */
  function renderInsights(scope) {
    const p = pearson(scope, 'safety', 'instruction');
    const res = featureImportance(scope, s => avgPair(s.isatVAMath, s.isatVAre));
    const b = safetyQuantiles(scope);

    const items = [];

    // 1 · headline correlation.
    items.push(p.r == null
      ? 'Not enough paired Safety/Instruction scores in this scope to compute a correlation.'
      : 'Across this scope, Safety and Instruction scores move together with <strong>Pearson r = '
      + p.r.toFixed(2) + '</strong> (n=' + p.n + ') — a ' + strengthWord(p.r).toLowerCase()
      + ' link. Safer schools tend to have better instruction, but the relationship is far from deterministic.');

    // 2 · most important climate factor for value-add (random-forest importance).
    if (!res.tooSmall) {
      const pairs = CLIMATE.map((c, i) => ({ label: c.label, imp: res.imp[i] }))
        .sort((a, b) => b.imp - a.imp);
      const safetyRow = pairs.find(x => x.label === 'Safety Score');
      items.push('For predicting ISAT value-add, the most important climate factor is <strong>'
        + pairs[0].label + '</strong> (' + (pairs[0].imp * 100).toFixed(0) + '% of total random-forest importance), '
        + 'while Safety itself accounts for ' + ((safetyRow ? safetyRow.imp : 0) * 100).toFixed(0)
        + '%. Attendance-type and environment factors carry more of the signal than the safety score alone.');
    } else {
      items.push('ISAT value-add has too few complete cases in this scope to rank climate predictors (n=' + res.n + ').');
    }

    // 3 · quartile gap.
    if (b) {
      const top = scope.filter(s => s.safety >= b.p75);
      const bot = scope.filter(s => s.safety <= b.p25);
      const ti = mean(top.map(s => s.instruction)), bi = mean(bot.map(s => s.instruction));
      items.push('Top-quartile schools by safety average <strong>' + fmt(ti) + '</strong> on Instruction, versus <strong>'
        + fmt(bi) + '</strong> for the bottom quartile — a gap of ' + fmt(ti - bi) + ' percentile points, with '
        + top.length + ' vs ' + bot.length + ' schools in each bucket.');
    }

    // 4 · outliers.
    const instrVals = scope.filter(s => s.instruction != null).map(s => s.instruction).sort((a, b) => a - b);
    if (b && instrVals.length >= 4) {
      const iB = { p25: quantile(instrVals, 0.25), p75: quantile(instrVals, 0.75) };
      const safeLag = scope.filter(s => s.safety >= b.p75 && s.instruction <= iB.p25).length;
      const lagSafe = scope.filter(s => s.safety <= b.p25 && s.instruction >= iB.p75).length;
      items.push('<strong>' + safeLag + '</strong> schools are safe but lag on instruction, and <strong>'
        + lagSafe + '</strong> are less safe but strong — see the &ldquo;Beating the Odds&rdquo; lists for the specific schools.');
    }

    // 5 · community-area spread (highest vs lowest avg safety).
    const g = {};
    scope.forEach(s => { if (s.safety != null) (g[s.ca] = g[s.ca] || []).push(s.safety); });
    const ranked = Object.entries(g).map(([ca, v]) => ({ ca, avg: v.reduce((a, b) => a + b, 0) / v.length, n: v.length }))
      .sort((a, b) => b.avg - a.avg);
    if (ranked.length >= 2) {
      items.push('Community areas span a wide range: <strong>' + ranked[0].ca + '</strong> averages '
        + fmt(ranked[0].avg, 0) + ' on safety (' + ranked[0].n + ' schools) while <strong>'
        + ranked[ranked.length - 1].ca + '</strong> averages ' + fmt(ranked[ranked.length - 1].avg, 0) + ' — '
        + 'location alone hints at a lot of the climate gap.');
    }

    $('insights').innerHTML = items.map(t => '<li>' + t + '</li>').join('');
  }

  /* ------------------------------------------------------------------
     4b · Tooltip helpers
     ------------------------------------------------------------------ */
  function showTooltip(e, html) {
    const t = $('tooltip');
    t.innerHTML = html;
    t.classList.add('show');
    moveTooltip(e);
  }
  function moveTooltip(e) {
    const t = $('tooltip');
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = t.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTooltip() { $('tooltip').classList.remove('show'); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ------------------------------------------------------------------
     5 · WIRING
     ------------------------------------------------------------------ */
  function renderAll() {
    const scope = applyFilters();
    renderKPIs(scope);
    renderScatter(scope);
    renderHeatmap(scope);
    renderPredictors(scope);
    renderQuartiles(scope);
    renderOutliers(scope);
    renderMap();
    renderInsights(scope);
  }

  function populateFilters() {
    // Community-area dropdown (distinct, sorted, with "All").
    const cas = Array.from(new Set(SCHOOLS.map(s => s.ca))).filter(Boolean).sort();
    const sel = $('ca-select');
    sel.innerHTML = '<option value="ALL">All areas (' + cas.length + ')</option>'
      + cas.map(c => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  }

  function bindEvents() {
    // Level segmented control.
    $('level-seg').addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (!btn) return;
      state.level = btn.dataset.level;
      [...$('level-seg').children].forEach(b => b.classList.toggle('active', b === btn));
      renderAll();
    });

    $('ca-select').addEventListener('change', e => { state.ca = e.target.value; renderAll(); });
    $('quartile-select').addEventListener('change', e => { state.quartile = e.target.value; renderAll(); });

    $('reset-filters').addEventListener('click', () => {
      state.level = 'ALL'; state.ca = 'ALL'; state.quartile = 'ALL';
      [...$('level-seg').children].forEach(b => b.classList.toggle('active', b.dataset.level === 'ALL'));
      $('ca-select').value = 'ALL';
      $('quartile-select').value = 'ALL';
      renderAll();
    });

    // Map / community-area controls.
    $('map-metric').addEventListener('change', e => { state.mapMetric = e.target.value; renderMap(); });
    document.querySelectorAll('.ca-toggle button').forEach(b => b.addEventListener('click', () => {
      state.caView = b.dataset.caView;
      document.querySelectorAll('.ca-toggle button').forEach(x => x.classList.toggle('active', x === b));
      renderMap();
    }));

    // Optional: load a different CSV with the same layout.
    $('csv-file').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rec = buildRecords(String(reader.result));
        if (rec.length) {
          SCHOOLS = rec;
          populateFilters();
          if (map) initMap(); // recenter if needed
          renderAll();
        } else {
          alert('Could not parse that file — expected the same column layout as chicago_public_schools.csv.');
        }
      };
      reader.readAsText(f, 'utf-8');
    });
  }

  /* ---- Minimal CSV -> records builder (mirrors the bundled data.js schema) ---- */
  const COL = {
    id: 'School ID', name: 'Name of School', level: 'Elementary, Middle, or High School',
    ca: 'Community Area Name', lat: 'Latitude', lon: 'Longitude',
    safety: 'Safety Score', environment: 'Environment Score', familyInvolve: 'Family Involvement Score',
    parentEngage: 'Parent Engagement Score', parentEnv: 'Parent Environment Score',
    studAttend: 'Average Student Attendance', misconduct: 'Rate of Misconducts (per 100 students)',
    teacherAttend: 'Average Teacher Attendance', instruction: 'Instruction Score',
    isatVAMath: 'ISAT Value Add Math', isatVAre: 'ISAT Value Add Read',
    isatExMath: 'ISAT Exceeding Math %', isatExRead: 'ISAT Exceeding Reading %',
    gr35Math: 'Gr3-5 Grade Level Math %', gr35Read: 'Gr3-5 Grade Level Read %',
    gradRate: 'Graduation Rate %', collegeRate: 'College Enrollment Rate %',
    onTrack: 'Freshman on Track Rate %', act: '11th Grade Average ACT (2011)'
  };

  function buildRecords(text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.length);
    if (lines.length < 2) return [];
    const header = parseCSVLine(lines[0]).map(h => h.trim());
    const idx = {};
    Object.values(COL).forEach(nm => { idx[nm] = header.findIndex(h => h === nm); });
    if (idx.name < 0 || idx.level < 0) return [];
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const row = parseCSVLine(lines[i]);
      const get = nm => idx[nm] != null && idx[nm] >= 0 ? row[idx[nm]] : '';
      const rec = {
        id: clean(get(COL.id)), name: clean(get(COL.name)), level: clean(get(COL.level)),
        ca: clean(get(COL.ca))
      };
      rec.lat = toFloat(get(COL.lat));
      rec.lon = toFloat(get(COL.lon));
      Object.keys(COL).forEach(k => {
        if (['lat', 'lon', 'id', 'name', 'level', 'ca'].includes(k)) return;
        rec[k] = toNumber(get(COL[k]));
      });
      out.push(rec);
    }
    return out;
  }

  function clean(s) { return String(s == null ? '' : s).trim(); }
  function toFloat(s) { const v = clean(s); return v ? parseFloat(v) : null; }
  function toNumber(s) {
    let v = clean(s);
    if (!v || v === 'NDA' || v === 'N/A') return null;
    v = v.replace('%', '');
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  }

  // RFC-4180-ish line parser (handles quoted fields with embedded commas).
  function parseCSVLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else {
        if (ch === '"') q = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function init() {
    populateFilters();
    bindEvents();
    initMap();
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
