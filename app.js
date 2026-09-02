/* Accessible Mobility Literature Explorer
 *
 * Three linked panes over one dataset (data/graph.json, built by build_data.py):
 *   left   - every term, ranked and colour-coded by the active metric
 *   centre - the taxonomy as a node-link graph
 *   right  - the detail for whatever is selected: a term (with its articles)
 *            or an article (with its terms, highlighted back in the graph)
 *
 * Encoding: one sequential blue ramp carries magnitude everywhere - sidebar bars
 * and graph nodes read off the same scale, so a dark node and a long bar mean the
 * same thing. Categorical colour is reserved for population categories, which
 * always ship with a text label.
 */
(function () {
  "use strict";

  var SEQ_STEPS = 5;
  var LIST_PAGE = 250;

  var el = {
    brandSub: document.getElementById("brandSub"),
    termList: document.getElementById("termList"),
    termCount: document.getElementById("termCount"),
    termSearch: document.getElementById("termSearch"),
    detail: document.getElementById("detail"),
    detailKind: document.getElementById("detailKind"),
    backBtn: document.getElementById("backBtn"),
    stage: document.getElementById("stage"),
    svg: d3.select("#graph"),
    legend: document.getElementById("legend"),
    tooltip: document.getElementById("tooltip"),
    banner: document.getElementById("selectionBanner"),
    bannerLabel: document.getElementById("selectionLabel"),
    clearSelection: document.getElementById("clearSelection"),
    popFilters: document.getElementById("popFilters"),
    typeFilters: document.getElementById("typeFilters"),
    yearFilters: document.getElementById("yearFilters"),
    clearFilters: document.getElementById("clearFilters"),
    filterDot: document.getElementById("filterDot"),
    metricArticles: document.getElementById("metricArticles"),
    metricN: document.getElementById("metricN"),
    layoutTree: document.getElementById("layoutTree"),
    layoutForce: document.getElementById("layoutForce"),
    expandAll: document.getElementById("expandAll"),
    fitBtn: document.getElementById("fitBtn"),
    themeBtn: document.getElementById("themeBtn"),
    topbar: document.getElementById("topbar"),
    viewControls: document.getElementById("viewControls"),
    stageBar: document.getElementById("stageBar"),
    panelTerms: document.getElementById("panelTerms"),
    panelDetail: document.getElementById("panelDetail"),
    tabbar: document.getElementById("tabbar"),
    tabTermsCount: document.getElementById("tabTermsCount"),
    tabDetailLabel: document.getElementById("tabDetailLabel"),
    tabDetailDot: document.getElementById("tabDetailDot")
  };

  var state = {
    metric: "articles",
    layout: "tree",
    search: "",
    filters: { pop: new Set(), type: new Set(), year: new Set() },
    selection: null,          // {kind:"term"|"paper", id}
    history: [],
    collapsed: new Set(),
    listLimit: LIST_PAGE,
    allExpanded: false,
    panel: "graph"            // mobile only: which sheet is open over the graph
  };

  var DATA = null;
  var nodeById = new Map();
  var paperById = new Map();
  var edgeById = new Map();
  var rootNode = null;
  var activePapers = new Set(); // papers surviving the filters
  var forceVisible = new Set(); // nodes pinned visible by an article highlight
  var maxMetric = 1;
  var sim = null;

  // ---------------------------------------------------------------- helpers

  function fmt(n) { return (n || 0).toLocaleString(); }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function seqColor(t) {
    // t in [0,1]; 0 means "no data" and gets the muted ink instead of a ramp step.
    if (t === null) return cssVar("--hair");
    var i = Math.max(0, Math.min(SEQ_STEPS - 1, Math.floor(t * SEQ_STEPS)));
    return cssVar("--seq-" + (i + 1));
  }

  function catColor(i) { return cssVar("--cat-" + ((i % 8) + 1)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------------ derived data

  /* Recompute per-node counts over the currently filtered set of articles.
     Direct = articles that cite this exact term. Subtree = the term or anything
     beneath it, which is what a collapsed branch stands for. */
  function recomputeMetrics() {
    activePapers = new Set();
    DATA.papers.forEach(function (p) {
      if (state.filters.pop.size && !p.populations.some(function (c) { return state.filters.pop.has(c); })) return;
      if (state.filters.type.size && !p.studyTypes.some(function (t) { return state.filters.type.has(t); })) return;
      if (state.filters.year.size && !state.filters.year.has(p.year)) return;
      activePapers.add(p.id);
    });

    DATA.nodes.forEach(function (n) {
      n.livePapers = n.papers.filter(function (id) { return activePapers.has(id); });
      n.vArticles = n.livePapers.length;
      n.vN = n.livePapers.reduce(function (s, id) { return s + (paperById.get(id).n || 0); }, 0);
      n._subPapers = null;
    });

    // bottom-up: children before parents
    var byDepth = DATA.nodes.slice().sort(function (a, b) { return b.depth - a.depth; });
    byDepth.forEach(function (n) {
      var acc = new Set(n.livePapers);
      n.children.forEach(function (c) {
        c._subPapers.forEach(function (id) { acc.add(id); });
      });
      n._subPapers = acc;
      n.vSubArticles = acc.size;
      n.vSubN = 0;
      acc.forEach(function (id) { n.vSubN += paperById.get(id).n || 0; });
    });

    maxMetric = 1;
    DATA.nodes.forEach(function (n) {
      if (n.id === DATA.meta.rootId) return;
      maxMetric = Math.max(maxMetric, value(n));
    });
  }

  function value(n) { return state.metric === "articles" ? n.vArticles : n.vN; }

  /* Square-rooted so the long tail of once-cited terms doesn't collapse into a
     single indistinguishable step - the distribution is heavily skewed (most
     terms appear in one article; the top term appears in 25). */
  function norm(v) {
    if (!v) return null;
    var lo = 1, hi = Math.max(maxMetric, 2);
    var t = (Math.sqrt(v) - Math.sqrt(lo)) / (Math.sqrt(hi) - Math.sqrt(lo));
    return Math.max(0, Math.min(0.999, t));
  }

  function radius(n) {
    if (n.id === DATA.meta.rootId) return 7;
    var t = norm(value(n));
    return t === null ? 2.6 : 3.2 + 9 * t;
  }

  // ------------------------------------------------------------- visibility

  function visibleNodes() {
    var out = [];
    (function walk(n) {
      out.push(n);
      var open = !state.collapsed.has(n.id);
      n.children.forEach(function (c) {
        if (open || forceVisible.has(c.id)) walk(c);
      });
    })(rootNode);
    return out;
  }

  function hasHiddenChildren(n) {
    if (!n.children.length) return false;
    return state.collapsed.has(n.id) &&
      n.children.some(function (c) { return !forceVisible.has(c.id); });
  }

  function ancestorsOf(n) {
    var chain = [], cur = n.parentNode;
    while (cur) { chain.push(cur); cur = cur.parentNode; }
    return chain;
  }

  // --------------------------------------------------------------- highlight

  /* What the graph should emphasise for the current selection:
       term    - the term itself plus its lineage back to the root
       article - every term the article reports, plus every taxonomy edge it
                 supports, plus the lineage needed to reach them */
  function highlightSets() {
    var nodes = new Set(), links = new Set(), primary = new Set(), ownLinks = new Set();
    if (!state.selection) {
      return { nodes: nodes, links: links, primary: primary, ownLinks: ownLinks, active: false };
    }

    if (state.selection.kind === "term") {
      var n = nodeById.get(state.selection.id);
      if (!n) return { nodes: nodes, links: links, primary: primary, ownLinks: ownLinks, active: false };
      primary.add(n.id);
      nodes.add(n.id);
      var prev = n;
      ancestorsOf(n).forEach(function (a) {
        nodes.add(a.id);
        links.add(a.id + ">" + prev.id);
        prev = a;
      });
      return { nodes: nodes, links: links, primary: primary, ownLinks: ownLinks, active: true };
    }

    var p = paperById.get(state.selection.id);
    if (!p) return { nodes: nodes, links: links, primary: primary, ownLinks: ownLinks, active: false };
    p.nodeIds.forEach(function (id) {
      var node = nodeById.get(id);
      if (!node) return;
      primary.add(id);
      nodes.add(id);
      var child = node;
      ancestorsOf(node).forEach(function (a) {
        nodes.add(a.id);
        links.add(a.id + ">" + child.id);
        child = a;
      });
    });
    p.edgeIds.forEach(function (eid) {
      var e = edgeById.get(eid);
      if (!e) return;
      links.add(e.s + ">" + e.t);
      ownLinks.add(e.s + ">" + e.t);
    });
    return { nodes: nodes, links: links, primary: primary, ownLinks: ownLinks, active: true };
  }

  function syncForceVisible() {
    forceVisible = new Set();
    if (!state.selection) return;
    var ids = state.selection.kind === "paper"
      ? (paperById.get(state.selection.id) || { nodeIds: [] }).nodeIds
      : [state.selection.id];
    ids.forEach(function (id) {
      var n = nodeById.get(id);
      if (!n) return;
      forceVisible.add(n.id);
      ancestorsOf(n).forEach(function (a) { forceVisible.add(a.id); });
    });
  }

  // ----------------------------------------------------------------- mobile

  var mq = window.matchMedia("(max-width: 900px)");

  function isMobile() { return mq.matches; }

  /* Below the breakpoint the graph controls belong to the stage, not the header,
     so the graph starts directly under the title. Same element either way - it
     is moved, never duplicated. */
  function placeControls() {
    var target = isMobile() ? el.stageBar : el.topbar;
    if (el.viewControls.parentNode !== target) target.appendChild(el.viewControls);
  }

  function setPanel(name) {
    state.panel = name;
    el.panelTerms.classList.toggle("is-open", name === "terms");
    el.panelDetail.classList.toggle("is-open", name === "detail");
    Array.prototype.forEach.call(el.tabbar.querySelectorAll(".tab"), function (tab) {
      tab.setAttribute("aria-selected", String(tab.dataset.panel === name));
    });
    updateTabs();
  }

  function updateTabs() {
    if (state.selection) {
      el.tabDetailLabel.textContent = state.selection.kind === "term" ? "Term" : "Article";
      el.tabDetailDot.hidden = state.panel === "detail";
    } else {
      el.tabDetailLabel.textContent = "Details";
      el.tabDetailDot.hidden = true;
    }
  }

  // -------------------------------------------------------------- selection

  var suppressHash = false;

  function writeHash() {
    var want = state.selection ? "#" + state.selection.kind + "=" + state.selection.id : "";
    if ((location.hash || "") === want) return;
    suppressHash = true;
    if (want) location.hash = want;
    else history.replaceState(null, "", location.pathname + location.search);
    setTimeout(function () { suppressHash = false; }, 0);
  }

  function readHash() {
    var m = /^#(term|paper)=(\d+)$/.exec(location.hash || "");
    if (!m) return null;
    var id = +m[2];
    if (m[1] === "term" && nodeById.has(id)) return { kind: "term", id: id };
    if (m[1] === "paper" && paperById.has(id)) return { kind: "paper", id: id };
    return null;
  }

  function applyHash() {
    if (suppressHash) return;
    var sel = readHash();
    if (!sel) return clearSelection();
    if (sel.kind === "term") revealAndSelect(sel.id);
    else select("paper", sel.id);
    if (isMobile()) setPanel("detail");
  }

  function select(kind, id, opts) {
    opts = opts || {};
    if (state.selection && !opts.replace &&
        !(state.selection.kind === kind && state.selection.id === id)) {
      state.history.push(state.selection);
      if (state.history.length > 40) state.history.shift();
    }
    state.selection = { kind: kind, id: id };
    syncForceVisible();
    writeHash();
    renderDetail();
    renderBanner();
    renderTermList();
    drawGraph({ refit: kind === "paper" });
    updateTabs();
    if (opts.center && kind === "term") centerOn(nodeById.get(id));
  }

  function clearSelection() {
    state.selection = null;
    state.history = [];
    forceVisible = new Set();
    writeHash();
    renderDetail();
    renderBanner();
    renderTermList();
    drawGraph({});
    updateTabs();
  }

  function goBack() {
    var prev = state.history.pop();
    if (!prev) return clearSelection();
    state.selection = prev;
    syncForceVisible();
    writeHash();
    renderDetail();
    renderBanner();
    renderTermList();
    drawGraph({ refit: prev.kind === "paper" });
    updateTabs();
  }

  // ------------------------------------------------------------- term panel

  function rankedTerms() {
    var q = state.search.trim().toLowerCase();
    var rows = DATA.nodes.filter(function (n) {
      if (n.id === DATA.meta.rootId) return false;
      if (!value(n)) return false;
      if (!q) return true;
      return n.word.toLowerCase().indexOf(q) !== -1 ||
        n.path.join(" ").toLowerCase().indexOf(q) !== -1;
    });
    rows.sort(function (a, b) {
      var d = value(b) - value(a);
      if (d) return d;
      d = b.vArticles - a.vArticles;
      if (d) return d;
      return a.word.localeCompare(b.word);
    });
    return rows;
  }

  function markMatch(word) {
    var q = state.search.trim();
    if (!q) return escapeHtml(word);
    var i = word.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return escapeHtml(word);
    return escapeHtml(word.slice(0, i)) + "<mark>" +
      escapeHtml(word.slice(i, i + q.length)) + "</mark>" +
      escapeHtml(word.slice(i + q.length));
  }

  function renderTermList() {
    var rows = rankedTerms();
    el.termCount.textContent = fmt(rows.length) + " of " + fmt(DATA.meta.counts.terms);
    el.tabTermsCount.textContent = fmt(rows.length);

    if (!rows.length) {
      el.termList.innerHTML = '<p class="list-empty">No terms match these filters.</p>';
      return;
    }

    var shown = rows.slice(0, state.listLimit);
    var selectedTerm = state.selection && state.selection.kind === "term" ? state.selection.id : null;
    var paperTerms = null;
    if (state.selection && state.selection.kind === "paper") {
      paperTerms = new Set(paperById.get(state.selection.id).nodeIds);
    }

    var html = shown.map(function (n, i) {
      var v = value(n);
      var t = norm(v);
      var pct = Math.max(2, Math.round((t === null ? 0 : t) * 100));
      var isCur = n.id === selectedTerm || (paperTerms && paperTerms.has(n.id));
      var context = n.path.length ? n.path.slice(-2).join(" › ") : (n.type || "top level");
      var second = state.metric === "articles"
        ? (n.vN ? fmt(n.vN) + " participants" : "n not reported")
        : n.vArticles + (n.vArticles === 1 ? " article" : " articles");
      return '<button type="button" class="term-row" data-node="' + n.id + '"' +
        (isCur ? ' aria-current="true"' : "") + '>' +
        '<span class="rank">' + (i + 1) + "</span>" +
        "<span>" +
          '<span class="word">' + markMatch(n.word) + "</span>" +
          '<span class="path">' + escapeHtml(context) + " · " + escapeHtml(second) + "</span>" +
          '<span class="bar-track"><span class="bar" style="width:' + pct +
            "%;background:" + seqColor(t) + '"></span></span>' +
        "</span>" +
        '<span class="val">' + fmt(v) + "</span>" +
        "</button>";
    }).join("");

    if (rows.length > shown.length) {
      html += '<div class="list-more"><button type="button" class="ghost-btn" id="showMore">' +
        "Show " + Math.min(LIST_PAGE, rows.length - shown.length) + " more of " +
        fmt(rows.length - shown.length) + "</button></div>";
    }

    el.termList.innerHTML = html;
  }

  // ----------------------------------------------------------- detail panel

  function popTag(catId) {
    var i = DATA.categories.findIndex(function (c) { return c.id === catId; });
    var label = i === -1 ? catId : DATA.categories[i].label;
    return '<span class="tag"><span class="swatch" style="background:' + catColor(i) +
      '"></span>' + escapeHtml(label) + "</span>";
  }

  function typeTag(typeId) {
    var t = DATA.studyTypes.find(function (s) { return s.id === typeId; });
    return '<span class="tag">' + escapeHtml(t ? t.label : typeId) + "</span>";
  }

  function sampleSizeText(p) {
    if (p.n) return fmt(p.n) + " participants";
    if (p.nUnit) return fmt(p.nUnit.n) + " " + p.nUnit.unit + " (not participants)";
    return p.nRaw ? p.nRaw : "not reported";
  }

  function articleCard(p, current) {
    var bits = [];
    if (p.authorsShort) bits.push(escapeHtml(p.authorsShort));
    if (p.year) bits.push(escapeHtml(p.year));
    bits.push(escapeHtml(sampleSizeText(p)));
    return '<button type="button" class="card" data-paper="' + p.id + '"' +
      (current ? ' aria-current="true"' : "") + ">" +
      '<span class="card-title">' + escapeHtml(p.title) + "</span>" +
      '<span class="card-meta">' + bits.join(' <span class="dot">·</span> ') + "</span>" +
      '<span class="tag-row">' +
        p.studyTypes.map(typeTag).join("") +
        p.populations.map(popTag).join("") +
      "</span></button>";
  }

  function renderDetail() {
    el.backBtn.hidden = !state.history.length;
    if (!state.selection) return renderOverview();
    if (state.selection.kind === "term") return renderTermDetail(nodeById.get(state.selection.id));
    return renderPaperDetail(paperById.get(state.selection.id));
  }

  function renderOverview() {
    el.detailKind.textContent = "Overview";
    var c = DATA.meta.counts;
    var withN = DATA.papers.filter(function (p) { return p.n && activePapers.has(p.id); });
    var totalN = withN.reduce(function (s, p) { return s + p.n; }, 0);

    var popCounts = DATA.categories.map(function (cat, i) {
      var n = DATA.papers.filter(function (p) {
        return activePapers.has(p.id) && p.populations.indexOf(cat.id) !== -1;
      }).length;
      return { label: cat.label, n: n, color: catColor(i) };
    }).sort(function (a, b) { return b.n - a.n; });
    var popMax = Math.max(1, popCounts[0].n);

    el.detail.innerHTML =
      '<div class="empty-state">' +
        "<h3>What this shows</h3>" +
        "<p>A taxonomy of built-environment attributes that affect accessible mobility, " +
        "hand-annotated from " + fmt(c.papers) + " articles. Every term traces back to the " +
        "articles that report it.</p>" +
        '<div class="overview-stats">' +
          '<div class="stat"><div class="stat-val">' + fmt(c.terms) + '</div><div class="stat-key">Terms</div></div>' +
          '<div class="stat"><div class="stat-val">' + fmt(activePapers.size) + '</div><div class="stat-key">Articles</div></div>' +
          '<div class="stat"><div class="stat-val">' + fmt(totalN) + '</div><div class="stat-key">Participants</div></div>' +
          '<div class="stat"><div class="stat-val">' + withN.length + "/" + fmt(c.papers) +
            '</div><div class="stat-key">Report an n</div></div>' +
        "</div>" +
        "<ol>" +
          "<li><strong>Click a term</strong> — in the graph or the ranked list — to see every article that reports it.</li>" +
          "<li><strong>Click an article</strong> to light up the terms and edges it contributes to the taxonomy.</li>" +
          "<li><strong>Filter</strong> by population, article type or year; the ranking and the graph both recompute.</li>" +
        "</ol>" +
      "</div>" +
      '<div class="detail" style="padding-top:0">' +
        '<div class="section-head">Articles by population <span class="count">' +
          fmt(activePapers.size) + " in view</span></div>" +
        '<div style="display:flex;flex-direction:column;gap:6px">' +
          popCounts.map(function (p) {
            return '<div style="display:grid;grid-template-columns:118px 1fr 28px;gap:8px;align-items:center">' +
              '<span style="font-size:11.5px;color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                escapeHtml(p.label) + "</span>" +
              '<span style="height:8px;background:var(--hair);border-radius:2px;overflow:hidden">' +
                '<span style="display:block;height:100%;width:' + Math.round(p.n / popMax * 100) +
                "%;background:" + p.color + ';border-radius:0 4px 4px 0"></span></span>' +
              '<span style="font-size:11.5px;color:var(--ink-2);font-variant-numeric:tabular-nums;text-align:right">' +
                p.n + "</span></div>";
          }).join("") +
        "</div>" +
        '<p class="subtle" style="font-size:11px">Articles can report more than one population, ' +
        "so these add to more than the article count.</p>" +
      "</div>";
  }

  function renderTermDetail(n) {
    if (!n) return renderOverview();
    el.detailKind.textContent = "Term";

    var papers = n.livePapers
      .map(function (id) { return paperById.get(id); })
      .sort(function (a, b) { return (b.n || 0) - (a.n || 0) || (b.year || "").localeCompare(a.year || ""); });

    var crumb = ['<button type="button" data-clear="1">All terms</button>'];
    n.path.forEach(function (word) { crumb.push("<span>›</span><span>" + escapeHtml(word) + "</span>"); });

    var kidsHtml = "";
    if (n.children.length) {
      var kids = n.children.slice().sort(function (a, b) { return value(b) - value(a); });
      kidsHtml =
        '<div><div class="section-head">Narrower terms <span class="count">' + kids.length + "</span></div>" +
        '<div class="chip-row" style="margin-top:8px">' +
          kids.map(function (k) {
            return '<button type="button" class="term-pill" data-node="' + k.id + '">' +
              '<span class="swatch" style="background:' + seqColor(norm(value(k))) + '"></span>' +
              '<span class="pill-word">' + escapeHtml(k.word) + "</span>" +
              '<span class="pill-n">' + fmt(value(k)) + "</span></button>";
          }).join("") +
        "</div></div>";
    }

    el.detail.innerHTML =
      '<div class="detail">' +
        '<div class="crumb">' + crumb.join("") + "</div>" +
        "<h3>" + escapeHtml(n.word) + "</h3>" +
        '<p class="subtle">' + escapeHtml(n.type || "term") +
          (n.descendants ? " · " + n.descendants + " narrower term" + (n.descendants === 1 ? "" : "s") : "") +
        "</p>" +
        '<div class="stat-row">' +
          '<div class="stat"><div class="stat-val">' + n.vArticles + '</div><div class="stat-key">Articles</div></div>' +
          '<div class="stat"><div class="stat-val">' + fmt(n.vN) + '</div><div class="stat-key">Total n</div></div>' +
          (n.descendants
            ? '<div class="stat"><div class="stat-val">' + n.vSubArticles +
              '</div><div class="stat-key">Incl. narrower</div></div>'
            : "") +
        "</div>" +
        (papers.length
          ? '<div><div class="section-head">Articles reporting this term <span class="count">' +
            papers.length + '</span></div><div class="card-list">' +
            papers.map(function (p) { return articleCard(p, false); }).join("") + "</div></div>"
          : '<p class="subtle">No articles under the current filters.</p>') +
        kidsHtml +
      "</div>";
  }

  function renderPaperDetail(p) {
    if (!p) return renderOverview();
    el.detailKind.textContent = "Article";

    var terms = p.nodeIds
      .map(function (id) { return nodeById.get(id); })
      .filter(Boolean)
      .sort(function (a, b) { return value(b) - value(a) || a.word.localeCompare(b.word); });

    function row(label, html, empty) {
      return "<dt>" + label + "</dt><dd" + (empty ? ' class="empty"' : "") + ">" + html + "</dd>";
    }

    var authors = p.authors.length ? escapeHtml(p.authors.join(", ")) : "not listed";
    var typeHtml = p.studyTypes.length
      ? '<span class="tag-row">' + p.studyTypes.map(typeTag).join("") + "</span>" +
        (p.studyTypeRaw ? '<div style="color:var(--ink-2);margin-top:4px">' +
          escapeHtml(p.studyTypeRaw) + "</div>" : "")
      : escapeHtml(p.studyTypeRaw || p.docType || "not recorded");
    var popHtml = p.populations.length
      ? '<span class="tag-row">' + p.populations.map(popTag).join("") + "</span>" +
        (p.populationRaw ? '<div style="color:var(--ink-2);margin-top:4px">' +
          escapeHtml(p.populationRaw) + "</div>" : "")
      : escapeHtml(p.populationRaw || "not recorded");

    el.detail.innerHTML =
      '<div class="detail">' +
        '<div class="crumb">' +
          '<button type="button" data-clear="1">All terms</button><span>›</span><span>Article</span>' +
        "</div>" +
        "<h3>" + escapeHtml(p.title) + "</h3>" +
        '<p class="subtle">' + escapeHtml(p.venue || p.docType) + (p.year ? " · " + escapeHtml(p.year) : "") + "</p>" +
        "<dl class=\"meta-grid\">" +
          row("Authors", authors, !p.authors.length) +
          row("Date", escapeHtml(p.year || "unknown"), !p.year) +
          row("DOI", p.doi
            ? '<a class="doi-link" href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' +
              escapeHtml(p.doi) + "</a>"
            : "not recorded", !p.doi) +
          row("Article type", typeHtml, false) +
          row("Population", popHtml, false) +
          row("Sample size", escapeHtml(sampleSizeText(p)) +
            (p.nRaw && p.nRaw !== String(p.n)
              ? '<div style="color:var(--ink-muted);font-size:11px;margin-top:2px">as recorded: ' +
                escapeHtml(p.nRaw) + "</div>"
              : ""), !p.n && !p.nUnit) +
          (p.location ? row("Setting", escapeHtml(p.location), false) : "") +
          (p.country ? row("Country", escapeHtml(p.country), false) : "") +
        "</dl>" +
        (p.populationNotes
          ? '<div><div class="section-head">Population notes</div>' +
            '<div class="note-block" style="margin-top:8px">' + escapeHtml(p.populationNotes) + "</div></div>"
          : "") +
        (p.notes
          ? '<div><div class="section-head">Review notes</div>' +
            '<div class="note-block" style="margin-top:8px">' + escapeHtml(p.notes) + "</div></div>"
          : "") +
        '<div><div class="section-head">Terms it reports <span class="count">' + terms.length +
          " term" + (terms.length === 1 ? "" : "s") + ", " + p.edgeIds.length + " links</span></div>" +
          '<p class="subtle" style="font-size:11px;margin-top:4px">Highlighted in the graph. ' +
          "Click one to switch to that term.</p>" +
          '<div class="chip-row" style="margin-top:8px">' +
            terms.map(function (t) {
              return '<button type="button" class="term-pill" data-node="' + t.id + '">' +
                '<span class="swatch" style="background:' + seqColor(norm(value(t))) + '"></span>' +
                '<span class="pill-word">' + escapeHtml(t.word) + "</span>" +
                '<span class="pill-n">' + fmt(value(t)) + "</span></button>";
            }).join("") +
          "</div>" +
        "</div>" +
      "</div>";
  }

  function renderBanner() {
    if (!state.selection) { el.banner.hidden = true; return; }
    el.banner.hidden = false;
    if (state.selection.kind === "term") {
      var n = nodeById.get(state.selection.id);
      el.bannerLabel.innerHTML = "Term <strong>" + escapeHtml(n.word) + "</strong> · " +
        n.vArticles + " article" + (n.vArticles === 1 ? "" : "s");
    } else {
      var p = paperById.get(state.selection.id);
      el.bannerLabel.innerHTML = "Article <strong>" + escapeHtml(p.authorsShort || p.title) +
        "</strong> · " + p.nodeIds.length + " terms, " + p.edgeIds.length + " annotated links";
    }
  }

  // ------------------------------------------------------------------ graph

  var gRoot, gLinks, gNodes, zoom, currentTransform = d3.zoomIdentity;
  var forceSignature = null;

  function initGraph() {
    gRoot = el.svg.append("g");
    gLinks = gRoot.append("g").attr("class", "links");
    gNodes = gRoot.append("g").attr("class", "nodes");

    zoom = d3.zoom()
      .scaleExtent([0.15, 8])
      .on("zoom", function (event) {
        currentTransform = event.transform;
        gRoot.attr("transform", currentTransform);
        updateLabels();
      });

    el.svg.call(zoom).on("dblclick.zoom", null);
    el.svg.on("click", function (event) {
      if (event.target === el.svg.node()) clearSelection();
    });
  }

  function layoutTree(nodes) {
    var visibleIds = new Set(nodes.map(function (n) { return n.id; }));
    var root = d3.hierarchy(rootNode, function (n) {
      return n.children.filter(function (c) { return visibleIds.has(c.id); });
    });
    var leaves = root.leaves().length;
    var R = Math.max(300, (leaves * 13) / (2 * Math.PI));

    d3.tree()
      .size([2 * Math.PI, R])
      .separation(function (a, b) { return (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth); })
      (root);

    root.each(function (h) {
      var n = h.data;
      n.a = h.x;
      n.r = h.y;
      n.x = h.y * Math.cos(h.x - Math.PI / 2);
      n.y = h.y * Math.sin(h.x - Math.PI / 2);
    });
    return R;
  }

  function layoutForce(nodes, links) {
    if (sim) sim.stop();
    nodes.forEach(function (n) {
      if (n.x == null || isNaN(n.x)) { n.x = (Math.random() - 0.5) * 600; n.y = (Math.random() - 0.5) * 600; }
      n.a = null;
    });
    sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(function (n) { return n.id; }).distance(function (l) {
        return 22 + 26 / (1 + l.source.depth);
      }).strength(0.9))
      .force("charge", d3.forceManyBody().strength(-90).distanceMax(500))
      .force("collide", d3.forceCollide().radius(function (n) { return radius(n) + 3; }))
      .force("x", d3.forceX().strength(0.02))
      .force("y", d3.forceY().strength(0.02))
      .alpha(0.9)
      .alphaDecay(0.035)
      .on("tick", positionMarks);
  }

  function linkPath(l) {
    var s = l.source, t = l.target;
    if (state.layout === "tree" && s.a != null && t.a != null) {
      return d3.linkRadial().angle(function (d) { return d.a; }).radius(function (d) { return d.r; })
        ({ source: s, target: t });
    }
    return "M" + s.x + "," + s.y + "L" + t.x + "," + t.y;
  }

  function positionMarks() {
    gLinks.selectAll("path").attr("d", linkPath);
    gNodes.selectAll("g.node").attr("transform", function (n) {
      return "translate(" + n.x + "," + n.y + ")";
    });
    gNodes.selectAll("g.node text")
      .attr("transform", labelTransform)
      .attr("x", labelX)
      .attr("dy", "0.33em")
      .attr("text-anchor", labelAnchor);
  }

  function isFlipped(n) {
    return state.layout === "tree" && n.a != null && n.a >= Math.PI;
  }

  function labelTransform(n) {
    if (state.layout !== "tree" || n.a == null) return null;
    var deg = (n.a * 180) / Math.PI - 90;
    return "rotate(" + (isFlipped(n) ? deg + 180 : deg) + ")";
  }

  function labelX(n) {
    var r = radius(n) + 5;
    return isFlipped(n) ? -r : r;
  }

  function labelAnchor(n) { return isFlipped(n) ? "end" : "start"; }

  var labelSet = new Set();

  /* Labels are placed greedily, richest term first, and only where nothing has
     already been placed within ~13 screen pixels. Zooming in shrinks that gap in
     world units, so detail appears as you get closer instead of all at once. */
  function updateLabels() {
    var k = currentTransform ? currentTransform.k : 1;
    // In the radial tree, labels rotate with the branch, so the arc gap between
    // neighbours is what matters. Laid out by force they all run left-to-right,
    // so they need far more horizontal room than vertical.
    var gapX = (state.layout === "tree" ? 13 : 46) / k;
    var gapY = (state.layout === "tree" ? 13 : 12) / k;
    var cell = Math.max(gapX, gapY);
    var vis = gNodes.selectAll("g.node").data();
    var hl = highlightSets();

    var grid = new Map();
    function key(cx, cy) { return cx + ":" + cy; }
    function free(n) {
      var cx = Math.floor(n.x / cell), cy = Math.floor(n.y / cell);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var bucket = grid.get(key(cx + dx, cy + dy));
          if (!bucket) continue;
          for (var i = 0; i < bucket.length; i++) {
            var o = bucket[i];
            var ex = (o.x - n.x) / gapX, ey = (o.y - n.y) / gapY;
            if (ex * ex + ey * ey < 1) return false;
          }
        }
      }
      return true;
    }
    function claim(n) {
      var kk = key(Math.floor(n.x / cell), Math.floor(n.y / cell));
      if (!grid.has(kk)) grid.set(kk, []);
      grid.get(kk).push(n);
      labelSet.add(n.id);
    }

    labelSet = new Set();
    var byValue = vis.slice().sort(function (a, b) { return value(b) - value(a); });

    // Highlighted terms and the top-level branches get first refusal, but they
    // still have to clear the collision test - an article citing 60+ terms would
    // otherwise stack its labels into an unreadable smear.
    var priority = byValue.filter(function (n) {
      if (n.id === DATA.meta.rootId) return false;
      if (hl.primary.has(n.id)) return true;
      return n.depth <= 1 && (!hl.active || hl.nodes.has(n.id));
    });
    priority.forEach(function (n) { if (free(n)) claim(n); });
    byValue.forEach(function (n) {
      if (n.id === DATA.meta.rootId || labelSet.has(n.id)) return;
      if (hl.active && !hl.primary.has(n.id)) return;   // don't label what's dimmed
      if (free(n)) claim(n);
    });

    gNodes.selectAll("g.node text").attr("display", function (n) {
      return labelSet.has(n.id) ? null : "none";
    });
  }

  function drawGraph(opts) {
    opts = opts || {};
    var nodes = visibleNodes();
    var visibleIds = new Set(nodes.map(function (n) { return n.id; }));
    var links = [];
    nodes.forEach(function (n) {
      if (n.parentNode && visibleIds.has(n.parentNode.id)) {
        links.push({ source: n.parentNode, target: n, key: n.parentNode.id + ">" + n.id });
      }
    });

    if (state.layout === "tree") {
      if (sim) { sim.stop(); sim = null; }
      layoutTree(nodes);
    }

    var hl = highlightSets();

    var link = gLinks.selectAll("path").data(links, function (l) { return l.key; });
    link.exit().remove();
    link = link.enter().append("path").attr("class", "link").merge(link);
    link.attr("class", function (l) {
      if (!hl.active) return "link";
      if (hl.links.has(l.key)) {
        if (state.selection.kind === "term") return "link is-path";
        return "link " + (hl.ownLinks.has(l.key) ? "is-cited" : "is-lineage");
      }
      return "link is-dim";
    });

    var node = gNodes.selectAll("g.node").data(nodes, function (n) { return n.id; });
    node.exit().remove();

    var enter = node.enter().append("g").attr("class", "node");
    enter.append("circle");
    enter.append("circle").attr("class", "collapsed-ring");
    enter.append("text");
    enter
      .on("click", function (event, n) { onNodeClick(event, n); })
      .on("mouseenter", function (event, n) { showTip(event, tipForNode(n)); })
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip);

    node = enter.merge(node);

    node.attr("class", function (n) {
      var cls = "node";
      if (n.children.length) cls += " has-children";
      if (hl.active) {
        if (hl.primary.has(n.id)) cls += " is-hit";
        else if (!hl.nodes.has(n.id)) cls += " is-dim";
      }
      if (state.selection && state.selection.kind === "term" && state.selection.id === n.id) {
        cls += " is-selected";
      }
      return cls;
    });

    node.select("circle:not(.collapsed-ring)")
      .attr("r", radius)
      .attr("fill", function (n) {
        return n.id === DATA.meta.rootId ? cssVar("--ink-muted") : seqColor(norm(value(n)));
      });

    node.select(".collapsed-ring")
      .attr("display", function (n) { return hasHiddenChildren(n) ? null : "none"; })
      .attr("r", function (n) { return radius(n) + 3; });

    node.select("text").text(function (n) {
      return n.id === DATA.meta.rootId ? "" : n.word;
    });

    if (state.layout === "force") {
      var sig = nodes.length + ":" + links.length + ":" + nodes.reduce(
        function (a, n) { return (a * 31 + n.id) % 2147483647; }, 7);
      if (sig !== forceSignature) { forceSignature = sig; layoutForce(nodes, links); }
    } else {
      forceSignature = null;
    }

    positionMarks();
    updateLabels();
    if (opts.refit || opts.fit) fit();
  }

  function tipForNode(n) {
    if (n.id === DATA.meta.rootId) return "<strong>All terms</strong>";
    var lines = ["<strong>" + escapeHtml(n.word) + "</strong>"];
    if (n.path.length) lines.push('<span style="color:var(--ink-muted)">' +
      escapeHtml(n.path.join(" › ")) + "</span>");
    lines.push(n.vArticles + " article" + (n.vArticles === 1 ? "" : "s") +
      (n.vN ? " · " + fmt(n.vN) + " participants" : ""));
    if (n.descendants) {
      lines.push('<span style="color:var(--ink-muted)">' + n.descendants +
        " narrower · " + n.vSubArticles + " articles incl. narrower</span>");
      lines.push('<span style="color:var(--ink-muted)">click to ' +
        (hasHiddenChildren(n) ? "open" : "close") + " and to see its articles</span>");
    }
    return lines.join("<br>");
  }

  function onNodeClick(event, n) {
    event.stopPropagation();
    if (n.id === DATA.meta.rootId) { clearSelection(); return; }
    if (n.children.length) {
      if (state.collapsed.has(n.id)) state.collapsed.delete(n.id);
      else state.collapsed.add(n.id);
    }
    select("term", n.id);
  }

  function centerOn(n) {
    if (!n || n.x == null) return;
    var w = el.stage.clientWidth, h = el.stage.clientHeight;
    var k = Math.max(0.55, currentTransform.k);
    el.svg.transition().duration(500).call(
      zoom.transform,
      d3.zoomIdentity.translate(w / 2 - k * n.x, h / 2 - k * n.y).scale(k)
    );
  }

  function fit() {
    var bbox;
    try { bbox = gRoot.node().getBBox(); } catch (e) { return; }
    if (!bbox || !bbox.width || !bbox.height) return;
    var w = el.stage.clientWidth, h = el.stage.clientHeight;
    var pad = Math.max(16, Math.min(48, Math.min(w, h) * 0.06));
    var k = Math.min((w - pad * 2) / bbox.width, (h - pad * 2) / bbox.height, 3);
    k = Math.max(0.15, k);
    var tx = w / 2 - k * (bbox.x + bbox.width / 2);
    var ty = h / 2 - k * (bbox.y + bbox.height / 2);
    el.svg.transition().duration(450)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  // ---------------------------------------------------------------- tooltip

  function showTip(event, html) {
    if (!window.matchMedia("(hover: hover)").matches) return;
    el.tooltip.innerHTML = html;
    el.tooltip.hidden = false;
    moveTip(event);
  }

  function moveTip(event) {
    var pad = 14;
    var w = el.tooltip.offsetWidth, h = el.tooltip.offsetHeight;
    var x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
    el.tooltip.style.left = x + "px";
    el.tooltip.style.top = y + "px";
  }

  function hideTip() { el.tooltip.hidden = true; }

  // ----------------------------------------------------------------- legend

  function renderLegend() {
    var steps = [];
    for (var i = 0; i < SEQ_STEPS; i++) {
      steps.push('<span style="background:' + cssVar("--seq-" + (i + 1)) + '"></span>');
    }
    el.legend.innerHTML =
      '<div class="legend-title">' + (state.metric === "articles" ? "Articles reporting the term" : "Total participants (n)") + "</div>" +
      '<div class="ramp">' + steps.join("") + "</div>" +
      '<div class="ramp-scale"><span>' + (state.metric === "articles" ? "1" : "low") +
        "</span><span>" + fmt(maxMetric) + "</span></div>" +
      '<div class="legend-note">Node size uses the same scale. A dashed ring means the ' +
      "branch has more terms folded inside it.</div>";
  }

  // ---------------------------------------------------------------- filters

  function renderFilters() {
    function chips(container, items, bucket) {
      container.innerHTML = items.map(function (it) {
        return '<button type="button" class="chip" data-bucket="' + bucket + '" data-val="' +
          escapeHtml(it.id) + '" aria-pressed="' + (state.filters[bucket].has(it.id)) + '">' +
          (it.color ? '<span class="swatch" style="background:' + it.color + '"></span>' : "") +
          escapeHtml(it.label) + ' <span class="n">' + it.n + "</span></button>";
      }).join("");
    }

    chips(el.popFilters, DATA.categories.map(function (c, i) {
      return {
        id: c.id, label: c.label, color: catColor(i),
        n: DATA.papers.filter(function (p) { return p.populations.indexOf(c.id) !== -1; }).length
      };
    }), "pop");

    chips(el.typeFilters, DATA.studyTypes.map(function (t) {
      return {
        id: t.id, label: t.label,
        n: DATA.papers.filter(function (p) { return p.studyTypes.indexOf(t.id) !== -1; }).length
      };
    }), "type");

    chips(el.yearFilters, DATA.meta.years.map(function (y) {
      return { id: y, label: y, n: DATA.papers.filter(function (p) { return p.year === y; }).length };
    }), "year");

    var any = state.filters.pop.size + state.filters.type.size + state.filters.year.size > 0;
    el.filterDot.hidden = !any;
    el.clearFilters.disabled = !any;
  }

  function applyFilters() {
    recomputeMetrics();
    renderFilters();
    renderLegend();
    renderTermList();
    renderDetail();
    drawGraph({});
  }

  // ------------------------------------------------------------------ wiring

  function setMetric(m) {
    state.metric = m;
    el.metricArticles.setAttribute("aria-pressed", String(m === "articles"));
    el.metricN.setAttribute("aria-pressed", String(m === "n"));
    recomputeMetrics();
    renderLegend();
    renderTermList();
    renderDetail();
    drawGraph({});
  }

  function setLayout(l) {
    state.layout = l;
    el.layoutTree.setAttribute("aria-pressed", String(l === "tree"));
    el.layoutForce.setAttribute("aria-pressed", String(l === "force"));
    drawGraph({ fit: true });
  }

  function wire() {
    el.metricArticles.onclick = function () { setMetric("articles"); };
    el.metricN.onclick = function () { setMetric("n"); };
    el.layoutTree.onclick = function () { setLayout("tree"); };
    el.layoutForce.onclick = function () { setLayout("force"); };
    el.fitBtn.onclick = fit;
    el.clearSelection.onclick = clearSelection;
    el.backBtn.onclick = goBack;

    el.expandAll.onclick = function () {
      state.allExpanded = !state.allExpanded;
      if (state.allExpanded) {
        state.collapsed = new Set();
        el.expandAll.textContent = "Collapse";
      } else {
        collapseToDepth(2);
        el.expandAll.textContent = "Expand all";
      }
      drawGraph({ fit: true });
    };

    el.themeBtn.onclick = function () {
      var root = document.documentElement;
      var now = root.getAttribute("data-theme");
      var dark = now ? now === "dark"
        : window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", dark ? "light" : "dark");
      try { localStorage.setItem("aml-theme", dark ? "light" : "dark"); } catch (e) { /* private mode */ }
      renderLegend();
      renderFilters();
      renderTermList();
      renderDetail();
      drawGraph({});
    };

    var searchTimer;
    el.termSearch.oninput = function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.search = el.termSearch.value;
        state.listLimit = LIST_PAGE;
        renderTermList();
      }, 120);
    };

    el.tabbar.onclick = function (event) {
      var tab = event.target.closest(".tab");
      if (tab) setPanel(tab.dataset.panel);
    };

    // On a phone the banner is the way back into the detail sheet.
    el.banner.onclick = function (event) {
      if (event.target.closest("#clearSelection")) return;
      if (isMobile()) setPanel("detail");
    };
    el.banner.onkeydown = function (event) {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); el.banner.onclick(event); }
    };

    el.termList.onclick = function (event) {
      var more = event.target.closest("#showMore");
      if (more) { state.listLimit += LIST_PAGE; renderTermList(); return; }
      var row = event.target.closest("[data-node]");
      if (!row) return;
      revealAndSelect(+row.dataset.node);
      // the articles are the payoff of picking a term - go straight to them
      if (isMobile()) setPanel("detail");
    };

    el.detail.onclick = function (event) {
      if (event.target.closest("[data-clear]")) { clearSelection(); return; }
      var pill = event.target.closest("[data-node]");
      if (pill) { revealAndSelect(+pill.dataset.node); return; }
      var card = event.target.closest("[data-paper]");
      if (card) select("paper", +card.dataset.paper);
    };

    [el.popFilters, el.typeFilters, el.yearFilters].forEach(function (container) {
      container.onclick = function (event) {
        var chip = event.target.closest(".chip");
        if (!chip) return;
        var bucket = chip.dataset.bucket, val = chip.dataset.val;
        if (state.filters[bucket].has(val)) state.filters[bucket].delete(val);
        else state.filters[bucket].add(val);
        applyFilters();
      };
    });

    el.clearFilters.onclick = function () {
      state.filters = { pop: new Set(), type: new Set(), year: new Set() };
      applyFilters();
    };

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (isMobile() && state.panel !== "graph") setPanel("graph");
        else clearSelection();
      }
      if (event.key === "/" && document.activeElement !== el.termSearch) {
        event.preventDefault();
        el.termSearch.focus();
      }
    });

    window.addEventListener("hashchange", applyHash);

    var onBreakpoint = function () {
      placeControls();
      setPanel("graph");
      drawGraph({ fit: true });
    };
    if (mq.addEventListener) mq.addEventListener("change", onBreakpoint);
    else mq.addListener(onBreakpoint);

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { drawGraph({}); }, 180);
    });
  }

  /* Selecting a term from the list may point at a node buried inside a collapsed
     branch - open its lineage first so the graph actually shows what got picked. */
  function revealAndSelect(id) {
    var n = nodeById.get(id);
    if (!n) return;
    ancestorsOf(n).forEach(function (a) { state.collapsed.delete(a.id); });
    select("term", id, { center: true });
  }

  function collapseToDepth(d) {
    state.collapsed = new Set();
    DATA.nodes.forEach(function (n) {
      if (n.depth >= d && n.children.length) state.collapsed.add(n.id);
    });
  }

  // -------------------------------------------------------------------- boot

  function hydrate(data) {
    DATA = data;
    DATA.nodes.forEach(function (n) {
      n.children = [];
      nodeById.set(n.id, n);
    });
    DATA.nodes.forEach(function (n) {
      n.parentNode = n.parent == null ? null : nodeById.get(n.parent) || null;
      if (n.parentNode) n.parentNode.children.push(n);
    });
    DATA.papers.forEach(function (p) { paperById.set(p.id, p); });
    DATA.edges.forEach(function (e) {
      edgeById.set(e.id, e);
    });
    rootNode = nodeById.get(DATA.meta.rootId);

    // keep the branches in a stable, meaningful order
    DATA.nodes.forEach(function (n) {
      n.children.sort(function (a, b) {
        return b.subtreeArticles - a.subtreeArticles || a.word.localeCompare(b.word);
      });
    });
  }

  function boot() {
    try {
      var saved = localStorage.getItem("aml-theme");
      if (saved) document.documentElement.setAttribute("data-theme", saved);
    } catch (e) { /* private mode - fall back to the OS setting */ }

    d3.json("data/graph.json").then(function (data) {
      hydrate(data);
      var c = DATA.meta.counts;
      el.brandSub.textContent = fmt(c.terms) + " terms · " + fmt(c.papers) +
        " articles · " + DATA.meta.years[0] + "–" + DATA.meta.years[DATA.meta.years.length - 1] +
        " seed annotations";
      document.title = "Accessible Mobility Literature Explorer";

      collapseToDepth(2);
      recomputeMetrics();
      placeControls();
      initGraph();
      wire();
      setPanel("graph");
      renderFilters();
      renderLegend();
      renderTermList();
      renderDetail();
      renderBanner();
      drawGraph({ fit: true });

      var deep = readHash();
      if (deep) {
        if (deep.kind === "term") revealAndSelect(deep.id);
        else select("paper", deep.id);
        state.history = [];
        el.backBtn.hidden = true;
        if (isMobile()) setPanel("detail");
      }
    }).catch(function (err) {
      el.brandSub.textContent = "Could not load data/graph.json";
      el.detail.innerHTML = '<div class="empty-state"><h3>Data did not load</h3><p>' +
        escapeHtml(err.message) + "</p><p>If you opened this file directly, serve the folder " +
        "instead: <code>python3 -m http.server</code> from <code>dashboard/</code>.</p></div>";
      console.error(err);
    });
  }

  boot();
})();
