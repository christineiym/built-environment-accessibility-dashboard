/* The summary rail: what the distribution is made of, and what is selected.
 *
 * Coverage and alignment are drawn as spreads rather than as single numbers.
 * Each repetition is one generated schema, so a run is a sample of 100 schemas
 * and its coverage has a shape; reporting only the mean hides that two cells
 * with the same mean can be a tight cluster and a bimodal split.
 */

import { DATA, formatValue, overview, stats } from './data.js';

const PERCENT = (value) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`);
const COUNT = (value) => value.toLocaleString('en-US');

export function renderSummary(container, state, distA, distB) {
  container.replaceChildren();

  if (state.selection) {
    container.append(selectionCard(state, distA, distB));
  }

  container.append(distributionCard(distA, state.nameA, 'a'));
  if (distB) container.append(distributionCard(distB, state.nameB, 'b'));

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

  lines.push(['Operationality O',
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
  note.textContent = rowA && rowA.opTerms
    ? `Rubric scores come from the ${rowA.opTerms} generated concept${rowA.opTerms === 1 ? '' : 's'} `
      + 'the panel scored among those matched here — a sample, not every match.'
    : 'No generated concept matched here was in the operationality sample, so the rubric columns are blank rather than zero.';
  section.append(note);
  return section;
}

function dimValue(row, key) {
  if (!row || !row.profile || !row.profile[0]) return null;
  const index = DATA.meta.dimensions.findIndex((dim) => dim.key === key);
  return row.profile[3 + index] / row.profile[0];
}

function opText(row) {
  if (!row.profile || !row.profile[1]) return '—';
  return `${PERCENT(row.O)} <small>(${row.profile[2]}/${row.profile[1]} concepts)</small>`;
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
    ['Concepts reached', `${COUNT(summary.nodes)} of ${COUNT(summary.nodesTotal)}`],
    ['Edges reached', `${COUNT(summary.edges)} of ${COUNT(summary.edgesTotal)}`],
    ['Invented reference edges', COUNT(summary.unresolved)],
  ];
  counts.innerHTML = entries.map(([term, value]) =>
    `<div><dt>${term}</dt><dd>${value}</dd></div>`).join('');
  section.append(counts);

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
