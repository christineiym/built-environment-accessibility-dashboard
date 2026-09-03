/* The summary rail: what the distribution is made of, and what is selected.
 *
 * Coverage and alignment are drawn as spreads rather than as single numbers.
 * Each repetition is one generated schema, so a run is a sample of 100 schemas
 * and its coverage has a shape; reporting only the mean hides that two cells
 * with the same mean can be a tight cluster and a bimodal split.
 */

import { DATA, formatValue, overview, stats, subtopicBreakdown } from './data.js';

const PERCENT = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const COUNT = (value) => value.toLocaleString('en-US');

export function renderSummary(container, state, distA, distB) {
  container.replaceChildren();

  if (state.selection) {
    container.append(selectionCard(state, distA, distB));
  }

  container.append(distributionCard(distA, state.nameA, 'a'));
  if (distB) container.append(distributionCard(distB, state.nameB, 'b'));

  container.append(subtopicBlock(state, distA, distB));
  container.append(overviewBlock());
}

// ---------------------------------------------------------------------------
// the selected node or edge
// ---------------------------------------------------------------------------

function selectionCard(state, distA, distB) {
  const section = document.createElement('section');
  section.className = 'card card--selection';
  const rowA = state.selection.a;
  const rowB = state.selection.b;

  section.innerHTML = `<h2>${rowA ? escapeHtml(rowA.name) : 'Selection'}</h2>`;
  const meta = document.createElement('p');
  meta.className = 'card-sub';
  const parts = [];
  if (rowA) {
    parts.push(rowA.kind === 'edge' ? 'reference edge' : 'reference concept');
    parts.push(`depth ${rowA.depth}`);
    parts.push(`branch ${rowA.branch}`);
    parts.push(rowA.subtopic);
    if (rowA.meta) parts.push('record-keeping');
  }
  meta.textContent = parts.join(' · ');
  section.append(meta);

  const table = document.createElement('table');
  table.className = 'kv';
  const head = distB
    ? `<thead><tr><th scope="col"></th><th scope="col">${escapeHtml(state.nameA)}</th><th scope="col">${escapeHtml(state.nameB)}</th></tr></thead>`
    : '';
  const lines = [];
  const cell = (row, dist, render) => (row && dist ? render(row, dist) : '—');

  lines.push(['Prevalence',
    cell(rowA, distA, (row, dist) => `${PERCENT(row.prevalence)} <small>(${row.hits}/${dist.reps})</small>`),
    cell(rowB, distB, (row, dist) => `${PERCENT(row.prevalence)} <small>(${row.hits}/${dist.reps})</small>`)]);

  lines.push(['Operationality O <small>mean of the six</small>',
    cell(rowA, distA, (row) => opText(row)),
    cell(rowB, distB, (row) => opText(row))]);

  for (const dimension of DATA.meta.dimensions) {
    lines.push([`— ${dimension.short}`,
      cell(rowA, distA, (row) => formatValue(dimValue(row, dimension.key), dimension.key)),
      cell(rowB, distB, (row) => formatValue(dimValue(row, dimension.key), dimension.key))]);
  }

  if (rowA && rowA.kind === 'edge') {
    lines.push(['Relation mix',
      relationText(rowA),
      rowB ? relationText(rowB) : '—']);
  }
  if (rowA && rowA.kind === 'node') {
    lines.push(['Named as a match target',
      cell(rowA, distA, (row, dist) => `${row.childHits} of ${dist.reps} reps`),
      cell(rowB, distB, (row, dist) => `${row.childHits} of ${dist.reps} reps`)]);
  }

  table.innerHTML = head + '<tbody>' + lines.map(([label, a, b]) =>
    `<tr><th scope="row">${label}</th><td>${a}</td>${distB ? `<td>${b}</td>` : ''}</tr>`).join('') + '</tbody>';
  section.append(table);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = rowA && rowA.profile
    ? 'Rubric scores are this reference concept\u2019s own, panel-averaged over three '
      + 'raters — the same number under every distribution. What differs between '
      + 'them is prevalence: which repetitions reached it.'
    : 'The panel did not score this concept, so the rubric columns are blank rather than zero.';
  section.append(note);
  return section;
}

function dimValue(row, key) {
  if (!row || !row.profile) return null;
  const index = DATA.meta.dimensions.findIndex((dim) => dim.key === key);
  return index < 0 ? null : row.profile[index];
}

function opText(row) {
  if (!row.profile) return '—';
  return `${row.O.toFixed(2)} <small>/ 5</small>`;
}

function relationText(row) {
  if (!row.relations) return '—';
  const total = row.relations.reduce((a, b) => a + b, 0);
  if (!total) return '—';
  return DATA.meta.relations
    .map((name, i) => ({ name, share: row.relations[i] / total }))
    .filter((entry) => entry.share > 0)
    .sort((a, b) => b.share - a.share)
    .map((entry) => `${entry.name} ${Math.round(entry.share * 100)}%`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// one distribution
// ---------------------------------------------------------------------------

function distributionCard(dist, name, series) {
  const summary = stats(dist);
  const section = document.createElement('section');
  section.className = 'card';
  section.innerHTML = `<h2><span class="swatch swatch--${series}"></span>${escapeHtml(name)}</h2>`;

  const counts = document.createElement('dl');
  counts.className = 'counts';
  const entries = [
    ['Repetitions', COUNT(summary.reps) + (summary.excluded ? ` (+${summary.excluded} excluded)` : '')],
    ['Predictions', COUNT(summary.records)],
    ['Invented reference edges', COUNT(summary.unresolved)],
  ];
  counts.innerHTML = entries.map(([term, value]) =>
    `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('');
  section.append(counts);

  section.append(coveragePair(summary));
  section.append(operationalityPair(dist));

  const spreads = document.createElement('div');
  spreads.className = 'spreads';
  spreads.append(
    spreadRow('Coverage per repetition', summary.coverage, 'share'),
    spreadRow('Coverage, accessibility only', summary.coverageAccessibility, 'share'),
    spreadRow('Alignment per repetition', summary.alignment, 'share'),
    spreadRow('Redundancy per repetition', summary.redundancy, 'share'),
  );
  section.append(spreads);

  if (dist.notes.length) {
    const note = document.createElement('p');
    note.className = 'note note--warn';
    note.textContent = dist.notes.join(' ');
    section.append(note);
  }
  return section;
}

/**
 * Coverage two ways, because one number has been doing both jobs.
 *
 * **Per prediction** is what a single repetition reached — one generated
 * schema against the reference. It has a sampling distribution, drawn as a box
 * below, and it is comparable between runs with different repetition counts.
 *
 * **Pooled** treats every repetition's matches as one bag and asks what share
 * of the reference the bag covers. It is the ceiling a single prediction
 * samples from, and it rises with the number of repetitions by construction —
 * so it is *not* comparable between a 100-repetition run and an 8-repetition
 * one, and it does not exist for a single prediction at all, where the bag is
 * the prediction.
 *
 * Their ratio is the third row: 1.00 means every repetition reached the same
 * items, and a low value means the run's breadth comes from saying different
 * things each time rather than from any one schema being broad.
 */
function coveragePair(summary) {
  const wrap = document.createElement('div');
  wrap.className = 'spreads';
  const pct = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
  const ratio = (per, pooled) => (per == null || !pooled ? '—' : (per / pooled).toFixed(2));
  const pooledNode = summary.nodesTotal ? summary.nodes / summary.nodesTotal : null;
  const pooledEdge = summary.edgesTotal ? summary.edges / summary.edgesTotal : null;
  wrap.innerHTML = `<table class="kv">
    <thead><tr><th scope="col"></th><th scope="col">concepts</th><th scope="col">edges</th></tr></thead>
    <tbody>
      <tr><th scope="row">Coverage per prediction</th>
          <td>${pct(summary.perPredNode)}</td><td>${pct(summary.perPredEdge)}</td></tr>
      <tr><th scope="row">Coverage pooled</th>
          <td>${pct(pooledNode)} <small>(${COUNT(summary.nodes)} of ${COUNT(summary.nodesTotal)})</small></td>
          <td>${pct(pooledEdge)} <small>(${COUNT(summary.edges)} of ${COUNT(summary.edgesTotal)})</small></td></tr>
      <tr><th scope="row">Ratio</th>
          <td>${ratio(summary.perPredNode, pooledNode)}</td>
          <td>${ratio(summary.perPredEdge, pooledEdge)}</td></tr>
    </tbody></table>
    <p class="note">Pooled treats all ${COUNT(summary.reps)} repetitions as one bag,
    so it climbs with the repetition count and does not compare across runs of
    different length. A single prediction has no pooled coverage — the bag would
    be the prediction.</p>`;
  return wrap;
}

/**
 * The two operationality numbers, side by side, with the gap between them.
 *
 * They count different populations and answer different questions, so neither
 * stands alone:
 *
 * - **reached** — the mean rubric score of the *reference* concepts this
 *   distribution's repetitions landed on. It is what the node and edge rows on
 *   this page decompose into, and it moves only when a run reaches a different
 *   set of concepts.
 * - **proposed** — the mean rubric score of concepts sampled from what the run
 *   *wrote*, matched or not.
 *
 * The gap is the interesting part. Positive means the concepts a run landed on
 * the reference are more measurable than the ones it proposed at large; the
 * reference is pulling it up. Negative means the run proposed better concepts
 * than the reference has room for.
 */
function operationalityPair(dist) {
  const wrap = document.createElement('div');
  wrap.className = 'spreads';
  const fmt = (value) => (value == null ? '—' : `${value.toFixed(2)} <small>/ 5</small>`);
  const gap = (dist.oMatched != null && dist.oGenerated != null)
    ? dist.oMatched - dist.oGenerated : null;
  wrap.innerHTML = `<table class="kv"><tbody>
    <tr><th scope="row">Operationality of what it <b>reached</b></th>
        <td>${fmt(dist.oMatched)}</td></tr>
    <tr><th scope="row">Operationality of what it <b>proposed</b></th>
        <td>${fmt(dist.oGenerated)}</td></tr>
    <tr><th scope="row">Gap</th><td>${
      gap == null ? '—' : `${gap >= 0 ? '+' : ''}${gap.toFixed(2)}`}</td></tr>
  </tbody></table>
  <p class="note">Reached: the reference concepts this distribution landed on,
  each scored once. Proposed: a seeded sample of what it wrote, matched or not.</p>`;
  return wrap;
}

/** A labelled box-and-whisker over [0, 1], with the numbers beside it. */
function spreadRow(label, values, kind) {
  const wrap = document.createElement('div');
  wrap.className = 'spread';
  if (!values) {
    wrap.innerHTML = `<span class="spread-label">${label}</span><span class="spread-text">not measured</span>`;
    return wrap;
  }
  const x = (value) => `${(value * 100).toFixed(2)}%`;
  wrap.innerHTML = `
    <span class="spread-label">${label}</span>
    <svg class="boxplot" viewBox="0 0 100 12" preserveAspectRatio="none" role="img"
         aria-label="${label}: median ${PERCENT(values.median)}, quartiles ${PERCENT(values.q1)} to ${PERCENT(values.q3)}, range ${PERCENT(values.min)} to ${PERCENT(values.max)} over ${values.n} repetitions">
      <line class="whisker" x1="${values.min * 100}" x2="${values.max * 100}" y1="6" y2="6"></line>
      <rect class="box" x="${values.q1 * 100}" width="${Math.max(0.4, (values.q3 - values.q1) * 100)}" y="2" height="8"></rect>
      <line class="median" x1="${values.median * 100}" x2="${values.median * 100}" y1="1" y2="11"></line>
    </svg>
    <span class="spread-text">median ${PERCENT(values.median)}
      <small>IQR ${x(values.q1)}–${x(values.q3)} · n=${values.n}</small></span>`;
  return wrap;
}

// ---------------------------------------------------------------------------
// coverage, split by accessibility category
// ---------------------------------------------------------------------------

/**
 * Per-category coverage for the distributions on screen.
 *
 * Collapsed by default: it is a drill-down, not a headline, and the headline
 * numbers above it are over the whole reference. Both coverages are shown
 * because they disagree in the way that matters — pooled says what the run
 * reached across all its repetitions, per prediction says what one schema
 * reached, and a category where the first is high and the second low is one
 * the run only covers by saying different things each time.
 */
function subtopicBlock(state, distA, distB) {
  const details = document.createElement('details');
  details.className = 'card card--overview';
  details.innerHTML = '<summary><h2>Coverage by accessibility category</h2></summary>';

  const mode = state.mode === 'nodes' ? 'nodes' : 'edges';
  const noun = mode === 'nodes' ? 'concepts' : 'edges';
  const rowsA = subtopicBreakdown(distA);
  const rowsB = distB ? subtopicBreakdown(distB) : null;
  const lookupB = new Map((rowsB || []).map((row) => [row.subtopic, row]));

  const table = document.createElement('table');
  table.className = 'grouped';
  // Compare view puts A and B in one cell rather than in four columns: this
  // table lives in the summary rail, and six columns there either clip the
  // last one or push the reader into a horizontal scroll to see the number
  // they are comparing against.
  const pooledTitle = `Share of this category's ${noun} reached by at least one repetition`;
  const perPredTitle = `Share of this category's ${noun} a single repetition reaches on average`;
  const heads = distB
    ? `<th scope="col"><abbr title="${pooledTitle}">Pooled <small>A / B</small></abbr></th>
       <th scope="col"><abbr title="${perPredTitle}">Per pred. <small>A / B</small></abbr></th>`
    : `<th scope="col"><abbr title="${pooledTitle}">Pooled</abbr></th>
       <th scope="col"><abbr title="${perPredTitle}">Per prediction</abbr></th>`;
  table.innerHTML = `<caption>${noun[0].toUpperCase()}${noun.slice(1)} in the reference, by category</caption>
    <thead><tr>
      <th scope="col">Category</th>
      <th scope="col"><abbr title="Reference ${noun} carrying this label">In ref.</abbr></th>
      ${heads}
    </tr></thead>`;

  const body = document.createElement('tbody');
  for (const row of rowsA) {
    const slot = row[mode];
    const other = lookupB.get(row.subtopic);
    const tr = document.createElement('tr');
    // No reference items in this category is not a coverage of zero: the run
    // cannot reach what the reference does not contain. Same distinction the
    // hatched cells make in the subtopic figure.
    const pair = (pick) => `${PERCENT(pick(slot))} <small>/ ${
      other ? PERCENT(pick(other[mode])) : '—'}</small>`;
    const cells = slot.total === 0
      ? `<td colspan="2" class="muted">no ${noun} in the reference</td>`
      : distB
        ? `<td>${pair((s) => s.pooled)}</td><td>${pair((s) => s.perPrediction)}</td>`
        : `<td>${PERCENT(slot.pooled)} <small>(${COUNT(slot.hit)}/${COUNT(slot.total)})</small></td>
           <td>${PERCENT(slot.perPrediction)}</td>`;
    tr.innerHTML = `<th scope="row">${escapeHtml(row.subtopic)}</th>
      <td>${COUNT(slot.total)}</td>${cells}`;
    body.append(tr);
  }
  table.append(body);
  // In compare view this is six columns inside the narrow summary rail, so it
  // scrolls in its own box rather than pushing the rail wider or clipping the
  // last column off the edge.
  const scroll = document.createElement('div');
  scroll.className = 'table-scroll';
  scroll.append(table);
  details.append(scroll);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Categories are the subtopic panel\u2019s labels on the '
    + 'reference itself, so they are the same for every distribution and only '
    + 'the coverage differs. Coverage is the only headline metric that splits '
    + 'this way \u2014 alignment and redundancy are computed per repetition '
    + 'over a whole schema and have no per-category value. Switch between '
    + 'concepts and edges with the Nodes / Edges control.';
  details.append(note);
  return details;
}

// ---------------------------------------------------------------------------
// the corpus, grouped by every value of every category
// ---------------------------------------------------------------------------

function overviewBlock() {
  const details = document.createElement('details');
  details.className = 'card card--overview';
  details.open = true;
  details.innerHTML = '<summary><h2>All runs, grouped</h2></summary>';

  for (const group of overview()) {
    const table = document.createElement('table');
    table.className = 'grouped';
    table.innerHTML = `<caption>${group.title}</caption>
      <thead><tr>
        <th scope="col">Group</th>
        <th scope="col"><abbr title="Reference concepts reached">Concepts</abbr></th>
        <th scope="col"><abbr title="Reference edges reached">Edges</abbr></th>
        <th scope="col"><abbr title="Match records">Preds</abbr></th>
        <th scope="col"><abbr title="Median coverage per repetition">Cov</abbr></th>
        <th scope="col"><abbr title="Median alignment per repetition">Align</abbr></th>
      </tr></thead>`;
    const body = document.createElement('tbody');
    for (const entry of group.entries) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th scope="row">${escapeHtml(entry.label)}</th>`
        + `<td>${COUNT(entry.nodes)}<small>/${COUNT(entry.nodesTotal)}</small></td>`
        + `<td>${COUNT(entry.edges)}<small>/${COUNT(entry.edgesTotal)}</small></td>`
        + `<td>${COUNT(entry.records)}</td>`
        + `<td>${entry.coverage ? PERCENT(entry.coverage.median) : '—'}</td>`
        + `<td>${entry.alignment ? PERCENT(entry.alignment.median) : '—'}</td>`;
      body.append(tr);
    }
    table.append(body);
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.append(table);
    details.append(scroll);
  }
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Coverage and alignment are medians over repetitions. Concept and edge '
    + 'counts are the union reached across the runs in the group, against the reference '
    + 'sizes of the use cases those runs cover.';
  details.append(note);
  return details;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
