/* State, controls and wiring.
 *
 * One state object drives everything; every control writes to it and calls
 * `update`, which rebuilds only the parts of the page that depend on what
 * changed. The whole state lives in the URL hash, so any view is a link.
 */

import * as data from './data.js';
import { BarChart } from './bars.js';
import { Network } from './network.js';
import { registerCategories } from './color.js';
import { renderSummary } from './stats.js';
import { BASE_TONES, INSTRUMENTS, SCALES, Sonifier } from './sonify.js';

const $ = (id) => document.getElementById(id);

const state = {
  view: 'single',
  mode: 'nodes',
  a: null,
  b: null,
  sort: 'prevalence',
  colorBy: 'value',
  scope: 'all',
  orientation: 'h',
  overlay: false,
  showUnmatched: false,
  search: '',
  aligned: false,
  toneScale: 'absolute',
  voices: 'both',
  order: 'own',
  toneMax: 1,
  selection: null,
  nameA: '',
  nameB: '',
};

const sonifier = new Sonifier();
// One instance per (mode, slot). A Network and a BarChart are not
// interchangeable, so they cannot share a slot — keeping their own means
// switching modes and switching back does not rebuild from scratch either.
const charts = { bars: { a: null, b: null, overlay: null }, network: { a: null, b: null } };
const barCharts = () => [charts.bars.a, charts.bars.b, charts.bars.overlay].filter(Boolean);

// ---------------------------------------------------------------------------
// start-up
// ---------------------------------------------------------------------------

async function main() {
  try {
    await data.load();
  } catch (error) {
    $('brandSub').textContent = `Could not load data/distributions.json — ${error.message}. `
      + 'Serve the folder over HTTP rather than opening the file directly.';
    return;
  }

  for (const useCase of data.DATA.meta.useCases) registerCategories(useCase.id);

  const first = data.allSelections();
  state.a = first[0];
  state.b = first.find((sel) => data.validPair(first[0], sel).ok) || first[1];

  readHash();
  buildPickers();
  buildMenus();
  wireControls();
  applyTheme(localStorage.getItem('mdx-theme'));
  update();

  $('brandSub').textContent =
    `${data.DATA.meta.useCases.map((u) => `${u.label}: ${u.refEdges} reference edges`).join(' · ')}`
    + ` · built ${data.DATA.meta.generated}`;
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

function selectField(id, label, options, value, onChange) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  wrap.htmlFor = id;
  const text = document.createElement('span');
  text.className = 'field-label';
  text.textContent = label;
  const select = document.createElement('select');
  select.id = id;
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    if (option.disabled) element.disabled = true;
    select.append(element);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(text, select);
  return wrap;
}

function axisOptions(kind) {
  const meta = data.DATA.meta;
  const list = kind === 'useCase' ? meta.useCases : kind === 'model' ? meta.models : meta.conditions;
  const options = list.map((entry) => ({ value: entry.id, label: entry.label }));
  if (kind !== 'useCase') {
    options.push({ value: data.ALL, label: kind === 'model' ? 'All models (combined)' : 'All conditions (combined)' });
  }
  return options;
}

function buildPickers() {
  for (const side of ['a', 'b']) {
    const host = $(side === 'a' ? 'pickerA' : 'pickerB');
    host.replaceChildren(
      selectField(`${side}UseCase`, 'Use case', axisOptions('useCase'), state[side].u,
        (value) => setSelection(side, { ...state[side], u: value })),
      selectField(`${side}Model`, 'Model', axisOptions('model'), state[side].m,
        (value) => setSelection(side, { ...state[side], m: value })),
      selectField(`${side}Condition`, 'Grounding condition', axisOptions('condition'), state[side].c,
        (value) => setSelection(side, { ...state[side], c: value })),
    );
  }
  refreshPairNote();
}

function setSelection(side, sel) {
  if (!data.exists(sel)) {
    // The cell exists in the grid but was never run; fall back to a union that
    // does, rather than showing an empty chart with no explanation.
    sel = { ...sel, c: data.ALL };
  }
  state[side] = sel;
  state.selection = null;
  state.aligned = false;
  barCharts().forEach((chart) => chart.resetPaging());
  refreshPairNote();
  update();
}

function refreshPairNote() {
  const note = $('pairNote');
  if (state.view !== 'compare') { note.textContent = ''; return; }
  const verdict = data.validPair(state.a, state.b);
  note.textContent = verdict.ok
    ? (verdict.why || 'Valid pairing under comparison.tex.')
    : `Not a valid pairing: ${verdict.why}`;
  note.dataset.bad = verdict.ok ? 'no' : 'yes';
}

function buildMenus() {
  const sort = $('sortBy');
  sort.replaceChildren();
  for (const metric of data.metricList()) {
    const option = document.createElement('option');
    option.value = metric.id;
    option.textContent = metric.label;
    if (metric.prose) option.title = metric.prose;
    sort.append(option);
  }
  sort.value = state.sort;

  for (const [id, series] of [['instA', 'a'], ['instB', 'b']]) {
    const select = $(id);
    select.replaceChildren();
    for (const instrument of INSTRUMENTS) {
      const option = document.createElement('option');
      option.value = instrument.id;
      option.textContent = instrument.label;
      select.append(option);
    }
    select.value = sonifier.instruments[series];
  }

  const scales = $('pitchScale');
  scales.replaceChildren();
  for (const scale of SCALES) {
    const option = document.createElement('option');
    option.value = scale.id;
    option.textContent = scale.label;
    scales.append(option);
  }
  scales.value = sonifier.scale;

  const tones = $('baseTone');
  tones.replaceChildren();
  for (const tone of BASE_TONES) {
    const option = document.createElement('option');
    option.value = tone.id;
    option.textContent = tone.label;
    tones.append(option);
  }
  tones.value = 'G3';
}

function toggleGroup(buttons, active) {
  for (const [id, value] of buttons) {
    $(id).setAttribute('aria-pressed', value === active ? 'true' : 'false');
  }
}

function wireControls() {
  $('viewSingle').addEventListener('click', () => setView('single'));
  $('viewCompare').addEventListener('click', () => setView('compare'));
  $('modeNetwork').addEventListener('click', () => setMode('network'));
  $('modeNodes').addEventListener('click', () => setMode('nodes'));
  $('modeEdges').addEventListener('click', () => setMode('edges'));

  $('sortBy').addEventListener('change', (event) => { state.sort = event.target.value; update(); });
  $('colorBy').addEventListener('change', (event) => { state.colorBy = event.target.value; update(); });
  $('scopeSel').addEventListener('change', (event) => { state.scope = event.target.value; update(); });
  $('showUnmatched').addEventListener('change', (event) => {
    state.showUnmatched = event.target.checked;
    barCharts().forEach((chart) => chart.resetPaging());
    update();
  });
  $('search').addEventListener('input', (event) => { state.search = event.target.value.trim(); update(); });

  $('orientH').addEventListener('click', () => { state.orientation = 'h'; update(); });
  $('orientV').addEventListener('click', () => { state.orientation = 'v'; update(); });
  $('rowOrder').addEventListener('change', (event) => {
    state.order = event.target.value;
    barCharts().forEach((chart) => chart.resetPaging());
    update();
  });
  $('cmpSeparate').addEventListener('click', () => { state.overlay = false; update(); });
  $('cmpOverlay').addEventListener('click', () => { state.overlay = true; update(); });

  $('soundOn').addEventListener('change', (event) => {
    sonifier.enabled = event.target.checked;
    if (sonifier.enabled) sonifier.ensure();
  });
  // Picking an instrument plays it. This is the user asking to hear a setting,
  // so it sounds whether or not per-item tones are switched on — that toggle
  // governs hovering and arrowing, not the controls themselves.
  $('instA').addEventListener('change', (event) => {
    sonifier.instruments.a = event.target.value;
    sonifier.demo('a');
  });
  $('instB').addEventListener('change', (event) => {
    sonifier.instruments.b = event.target.value;
    sonifier.demo('b');
  });
  $('voices').addEventListener('change', (event) => {
    state.voices = event.target.value;
    sonifier.voices = state.voices;
    sonifier.demo(state.voices === 'b' ? 'b' : 'a');
  });
  $('pitchScale').addEventListener('change', (event) => {
    sonifier.scale = event.target.value;
    sonifier.preview();
  });
  $('toneScale').addEventListener('change', (event) => { state.toneScale = event.target.value; });
  $('baseTone').addEventListener('change', (event) => {
    sonifier.baseHz = (BASE_TONES.find((tone) => tone.id === event.target.value) || BASE_TONES[3]).hz;
    sonifier.demo(state.voices === 'b' ? 'b' : 'a');
  });
  $('soundTest').addEventListener('click', () => sonifier.preview());

  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('mdx-theme', next);
  });

  for (const [id, panel] of [['tabControls', 'controls'], ['tabStage', 'stage'], ['tabSummary', 'summary']]) {
    $(id).addEventListener('click', () => showPanel(panel));
  }

  window.addEventListener('hashchange', () => {
    readHash();
    // The hash can move to another use case, where the previous selection's
    // index means a different concept entirely.
    state.selection = null;
    buildPickers();
    syncControls();
    update();
  });
}

function setView(view) {
  state.view = view;
  state.selection = null;
  state.aligned = false;
  if (view === 'compare' && !data.validPair(state.a, state.b).ok) {
    const alternative = data.allSelections().find((sel) => data.validPair(state.a, sel).ok);
    if (alternative) state.b = alternative;
    buildPickers();
  }
  update();
}

function setMode(mode) {
  state.mode = mode;
  state.selection = null;
  barCharts().forEach((chart) => chart.resetPaging());
  update();
}

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function showPanel(which) {
  document.body.dataset.panel = which;
  toggleGroup([['tabControls', 'controls'], ['tabStage', 'stage'], ['tabSummary', 'summary']], which);
}

function syncControls() {
  toggleGroup([['viewSingle', 'single'], ['viewCompare', 'compare']], state.view);
  toggleGroup([['modeNetwork', 'network'], ['modeNodes', 'nodes'], ['modeEdges', 'edges']], state.mode);
  toggleGroup([['orientH', 'h'], ['orientV', 'v']], state.orientation);
  toggleGroup([['cmpSeparate', false], ['cmpOverlay', true]], state.overlay);
  $('sortBy').value = state.sort;
  $('colorBy').value = state.colorBy;
  $('scopeSel').value = state.scope;
  $('toneScale').value = state.toneScale;
  $('rowOrder').value = state.order;
  $('voices').value = state.voices;
  sonifier.voices = state.voices;
  // In the separate layout each chart already sounds only its own
  // distribution, so there is nothing for the selector to do.
  $('voices').disabled = !state.overlay;
  $('voices').title = state.overlay ? ''
    : 'Applies to the overlay. In the separate layout each chart already sounds only its own distribution.';
  $('showUnmatched').checked = state.showUnmatched;
  $('blockB').hidden = state.view !== 'compare';
  for (const element of document.querySelectorAll('.field--compare')) {
    element.hidden = state.view !== 'compare';
  }
  for (const element of document.querySelectorAll('.field--bars')) {
    element.hidden = state.mode === 'network';
  }
}

// ---------------------------------------------------------------------------
// the URL carries the state
// ---------------------------------------------------------------------------

function writeHash() {
  const parts = [
    `view=${state.view}`, `mode=${state.mode}`,
    `a=${data.selKey(state.a)}`, `b=${data.selKey(state.b)}`,
    `sort=${state.sort}`, `color=${state.colorBy}`, `scope=${state.scope}`,
  ];
  if (state.overlay) parts.push('overlay=1');
  if (state.order !== 'own') parts.push(`order=${state.order}`);
  if (state.orientation === 'v') parts.push('orient=v');
  const hash = `#${parts.join('&')}`;
  if (hash !== location.hash) history.replaceState(null, '', hash);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const pick = (key, allowed, fallback) => {
    const value = params.get(key);
    return allowed.includes(value) ? value : fallback;
  };
  state.view = pick('view', ['single', 'compare'], state.view);
  state.mode = pick('mode', ['network', 'nodes', 'edges'], state.mode);
  state.colorBy = pick('color', ['value', 'branch', 'subtopic'], state.colorBy);
  state.scope = pick('scope', ['all', 'accessibility'], state.scope);
  state.orientation = params.get('orient') === 'v' ? 'v' : 'h';
  state.overlay = params.get('overlay') === '1';
  state.order = pick('order', ['own', 'a', 'b'], 'own');
  const sortIds = data.metricList().map((metric) => metric.id);
  state.sort = sortIds.includes(params.get('sort')) ? params.get('sort') : state.sort;
  for (const side of ['a', 'b']) {
    const raw = params.get(side);
    if (!raw) continue;
    const sel = data.parseSel(raw);
    if (data.exists(sel)) state[side] = sel;
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function filtered(rows) {
  const needle = state.search.toLowerCase();
  return rows.filter((row) => {
    if (state.scope === 'accessibility' && row.meta) return false;
    if (!state.showUnmatched && row.hits === 0) return false;
    if (needle && !row.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * Ranking comparator for the metric in force: highest first, unmeasured last.
 *
 * Rubric metrics tie constantly — an edge whose single scored concept the panel
 * called operational reads 100%, the same as one with eight — so the
 * better-evidenced item wins the tie, and the count is printed beside the value
 * so it is never mistaken for strength.
 *
 * @param {(subject: any) => object|null} rowOf Pulls the row to rank on. It is
 *   a lookup rather than the subject itself so one chart can be ranked on
 *   another distribution's values.
 */
function byMetric(rowOf) {
  const sampled = data.isSampled(state.sort);
  return (x, y) => {
    const rx = rowOf(x);
    const ry = rowOf(y);
    const a = rx ? data.valueOf(rx, state.sort) : null;
    const b = ry ? data.valueOf(ry, state.sort) : null;
    const nx = rx ? rx.name : '';
    const ny = ry ? ry.name : '';
    if (a == null && b == null) return nx.localeCompare(ny);
    if (a == null) return 1;
    if (b == null) return -1;
    if (a !== b) return b - a;
    if (sampled && rx.opTerms !== ry.opTerms) return ry.opTerms - rx.opTerms;
    return ry.prevalence - rx.prevalence || nx.localeCompare(ny);
  };
}

/**
 * One row order for both charts of a separate comparison.
 *
 * Ranking B by A's values only reads as an alignment if the two charts hold the
 * same items in the same rows, so the set is the **union** of what either
 * distribution reached. An item only one of them reached still gets a line in
 * each — in the other it is a measured zero, which is the comparison working
 * rather than a gap in it.
 *
 * @returns {number[]} Item indices, in the order both charts should draw them.
 */
function sharedOrder(distA, distB, kind) {
  const allA = data.rows(distA, kind);
  const allB = data.rows(distB, kind);
  const keep = new Set([...filtered(allA), ...filtered(allB)].map((row) => row.index));
  const rank = new Map((state.order === 'b' ? allB : allA).map((row) => [row.index, row]));
  return [...keep].sort(byMetric((index) => rank.get(index)));
}

/**
 * Build one chart's items.
 *
 * @param {object} dist The distribution being drawn.
 * @param {Array|null} rowsB Rows supplying the paired value, unfiltered — a
 *   partner must always be findable, because an item this distribution never
 *   reached has prevalence zero, which is a measurement and not a blank.
 * @param {number[]|null} order Item indices to draw, in that exact order. When
 *   given it replaces both the filter and the sort, so every chart sharing the
 *   order holds the same rows.
 */
function itemsFor(dist, rowsB, order = null) {
  const spec = data.metricSpec(state.sort);
  const kind = state.mode === 'edges' ? 'edge' : 'node';
  const byIndex = rowsB ? new Map(rowsB.map((row) => [row.index, row])) : null;

  const own = data.rows(dist, kind);
  const source = order
    ? order.map((index) => own[index]).filter(Boolean)
    : filtered(own);

  const items = source.map((row) => {
    const valueA = data.valueOf(row, state.sort);
    const partner = byIndex ? byIndex.get(row.index) : null;
    const valueB = partner ? data.valueOf(partner, state.sort) : null;
    return {
      id: `${kind}:${row.index}`,
      row,
      partner,
      reps: dist.reps,
      label: row.name,
      valueA,
      valueB,
      fractionA: valueA == null ? null : valueA / spec.max,
      fractionB: valueB == null ? null : valueB / spec.max,
      textA: data.formatValue(valueA, state.sort),
      textB: data.formatValue(valueB, state.sort),
      sampleA: data.isSampled(state.sort) ? row.opTerms : null,
      sampleB: data.isSampled(state.sort) && partner ? partner.opTerms : null,
      delta: valueA == null || valueB == null ? null : valueB - valueA,
      deltaText: valueA == null || valueB == null ? null
        : formatDelta(valueB - valueA, spec),
    };
  });

  if (!order) items.sort(byMetric((item) => item.row));
  return items;
}

function formatDelta(delta, spec) {
  const sign = delta > 0 ? '+' : '';
  return spec.kind === 'share'
    ? `${sign}${(delta * 100).toFixed(1)} pp`
    : `${sign}${delta.toFixed(2)}`;
}

function captionFor(dist, count, spec) {
  const kind = state.mode === 'edges' ? 'reference edges' : 'reference concepts';
  const scope = state.scope === 'accessibility' ? ', record-keeping edges removed' : '';
  return `${count} ${kind} ranked by ${spec.phrase}, over ${dist.reps} repetitions${scope}. `
    + (state.showUnmatched ? 'Never-matched items are included at zero. ' : 'Never-matched items are hidden. ')
    + (data.isSampled(spec.id)
      ? 'The count after each value is how many matched concepts the rubric panel scored; ties break toward the better-evidenced item, and an item with none is shown as a dash.'
      : '');
}

/** Note the tallest mark drawn, which the relative pitch reference reads. */
function noteToneMax(items) {
  state.toneMax = Math.max(
    1e-6,
    ...items.map((item) => Math.max(item.fractionA ?? 0, item.fractionB ?? 0)),
  );
}

function update() {
  syncControls();
  writeHash();
  refreshPairNote();

  const distA = data.combine(state.a);
  state.nameA = data.describe(state.a);
  const pair = state.view === 'compare' ? data.validPair(state.a, state.b) : { ok: false };
  const distB = pair.ok ? data.combine(state.b) : null;
  state.nameB = distB ? data.describe(state.b) : '';

  // Two distributions on screen means the voices are panned apart — in the
  // overlay so a unison still reads as two, and in the separate layout so the
  // side tells you which chart the cursor is in.
  sonifier.stereo = !!distB;

  const sameReference = distB && distB.useCase === distA.useCase;
  $('cmpOverlay').disabled = !sameReference || state.mode === 'network';
  // Two reference taxonomies share no items, so there is no row to align to.
  $('rowOrder').disabled = !sameReference || state.mode === 'network';
  $('rowOrder').title = $('rowOrder').disabled
    ? 'Needs two distributions over the same reference taxonomy, in a bar mode.'
    : '';
  if (!sameReference && state.order !== 'own') state.order = 'own';
  if (!sameReference && state.overlay) state.overlay = false;

  const stage = $('stageScroll');
  stage.replaceChildren();

  if (state.view === 'compare' && !pair.ok) {
    stage.append(banner('This pairing is not one comparison.tex defines. '
      + data.validPair(state.a, state.b).why));
  }

  if (state.mode === 'network') renderNetworks(stage, distA, distB);
  else renderBars(stage, distA, distB);

  renderSummary($('summaryScroll'), state, distA, distB);
}

function banner(text) {
  const element = document.createElement('p');
  element.className = 'banner';
  element.textContent = text;
  return element;
}

function renderBars(stage, distA, distB) {
  const spec = data.metricSpec(state.sort);
  const kind = state.mode === 'edges' ? 'edge' : 'node';
  // Unfiltered: the partner lookup must always resolve, so that an item this
  // distribution never reached reads as the zero it measured rather than as a
  // blank.
  const rowsB = distB ? data.rows(distB, kind) : null;
  const rowsA = distB ? data.rows(distA, kind) : null;

  const shared = !!distB && state.order !== 'own' && distB.useCase === distA.useCase;
  const order = shared ? sharedOrder(distA, distB, kind) : null;
  const orderedBy = state.order === 'b' ? state.nameB : state.nameA;

  if (distB && state.overlay) {
    const items = itemsFor(distA, rowsB, order);
    noteToneMax(items);
    charts.bars.overlay = charts.bars.overlay || new BarChart(handlers('overlay'));
    stage.append(charts.bars.overlay.render({
      items,
      title: `${state.nameA} vs ${state.nameB}`,
      caption: captionFor(distA, items.length, spec)
        + ` Bars are ordered by ${shared && state.order === 'b' ? 'B' : 'A'}; `
        + 'B is drawn over each one.',
      orderText: `ordered by ${shared && state.order === 'b' ? 'B' : 'A'}`,
      orientation: state.orientation,
      overlay: true,
      metricLabel: spec.label.replace('— ', ''),
      colorBy: state.colorBy,
      useCase: distA.useCase,
      series: 'a',
      nameA: state.nameA,
      nameB: state.nameB,
      selectedId: state.selection?.id,
    }));
    return;
  }

  const grid = document.createElement('div');
  grid.className = distB ? 'grid grid--two' : 'grid';
  const itemsA = itemsFor(distA, null, order);
  const itemsB = distB ? itemsFor(distB, null, order) : [];
  // One reference across both charts, so the same pitch means the same height
  // in either of them.
  noteToneMax([...itemsA, ...itemsB]);

  // Said on both charts, not just the borrowed one: a ranking that is not the
  // chart's own is the first thing that would be misread.
  const alignedNote = shared
    ? ` Both charts hold the same items in the same rows, ranked by ${orderedBy}.`
    : '';
  const orderText = shared
    ? `in ${orderedBy}'s order`
    : `most ${spec.phrase} first`;

  charts.bars.a = charts.bars.a || new BarChart(handlers('a'));
  grid.append(charts.bars.a.render({
    items: itemsA,
    title: state.nameA,
    caption: captionFor(distA, itemsA.length, spec) + alignedNote,
    orderText,
    orientation: state.orientation,
    overlay: false,
    metricLabel: spec.label.replace('— ', ''),
    colorBy: state.colorBy,
    useCase: distA.useCase,
    series: 'a',
    nameA: state.nameA,
    selectedId: state.selection?.id,
  }));

  if (distB) {
    charts.bars.b = charts.bars.b || new BarChart(handlers('b'));
    grid.append(charts.bars.b.render({
      items: itemsB,
      title: state.nameB,
      caption: captionFor(distB, itemsB.length, spec) + alignedNote,
      orderText,
      orientation: state.orientation,
      overlay: false,
      metricLabel: spec.label.replace('— ', ''),
      colorBy: state.colorBy,
      useCase: distB.useCase,
      series: 'b',
      nameA: state.nameB,
      selectedId: state.selection?.id,
    }));
  }
  stage.append(grid);
}

function renderNetworks(stage, distA, distB) {
  const spec = data.metricSpec(state.sort);
  const dists = distB ? [distA, distB] : [distA];
  noteToneMax(dists.flatMap((dist) => filtered(data.rows(dist, 'node')).map((row) => ({
    fractionA: (data.valueOf(row, state.sort) ?? 0) / spec.max,
  }))));
  const netProps = (dist, name, series, pinned) => ({
    nodes: filtered(data.rows(dist, 'node')),
    edges: filtered(data.rows(dist, 'edge')),
    title: name,
    caption: `Node size and shade follow ${spec.label.replace('— ', '').toLowerCase()}; `
      + `edge thickness follows how often that reference edge was matched, over ${dist.reps} repetitions.`
      + (data.isSampled(spec.id)
        ? ' Concepts the rubric panel never sampled carry no value and are drawn at minimum size.' : ''),
    metricLabel: spec.label.replace('— ', ''),
    colorBy: state.colorBy,
    useCase: dist.useCase,
    series,
    reps: dist.reps,
    pinned,
    valueOf: (row) => data.valueOf(row, state.sort),
    textOf: (row) => data.formatValue(data.valueOf(row, state.sort), state.sort),
    selectedId: state.selection?.id,
  });

  if (distB) {
    const bar = document.createElement('div');
    bar.className = 'stage-bar';
    const align = document.createElement('button');
    align.type = 'button';
    align.className = 'ghost-btn';
    align.id = 'alignBtn';
    align.textContent = 'Align B to A';
    align.setAttribute('aria-pressed', state.aligned ? 'true' : 'false');
    align.disabled = distB.useCase !== distA.useCase;
    align.title = align.disabled
      ? 'The two networks are over different reference taxonomies, so there is nothing to align.'
      : 'Redraw B with A’s node positions, so only the weights differ.';
    align.addEventListener('click', () => { state.aligned = !state.aligned; update(); });
    bar.append(align);
    stage.append(bar);
  }

  const grid = document.createElement('div');
  grid.className = distB ? 'grid grid--two' : 'grid';
  charts.network.a = new Network(handlers('a'));
  grid.append(charts.network.a.render(netProps(distA, state.nameA, 'a', null)));
  if (distB) {
    charts.network.b = new Network(handlers('b'));
    const pinned = state.aligned && distB.useCase === distA.useCase
      ? charts.network.a.positions : null;
    grid.append(charts.network.b.render(netProps(distB, state.nameB, 'b', pinned)));
  }
  stage.append(grid);
}

// ---------------------------------------------------------------------------
// cursor and selection
// ---------------------------------------------------------------------------

function handlers(which) {
  // 'absolute' pitches against a full bar, so one tone means one prevalence in
  // every distribution; 'relative' pitches against the tallest bar drawn, which
  // spreads a low-coverage distribution over the whole range at the cost of
  // that comparability. GATIS needs the second reading; osm_pwg does not.
  const scaled = (fraction) => {
    const reference = state.toneScale === 'relative' ? state.toneMax : 1;
    return Math.min(1, (fraction ?? 0) / (reference || 1));
  };
  return {
    onCursor: (item) => {
      if (!item) return;
      const isBar = item.fractionA !== undefined;
      if (which === 'overlay' && isBar) {
        sonifier.playPair(scaled(item.fractionA), item.fractionB == null ? null : scaled(item.fractionB));
      } else if (isBar) {
        sonifier.play(scaled(item.fractionA), which === 'b' ? 'b' : 'a');
      } else {
        const spec = data.metricSpec(state.sort);
        sonifier.play(scaled((data.valueOf(item, state.sort) ?? 0) / spec.max), which === 'b' ? 'b' : 'a');
      }
    },
    onSelect: (item) => {
      const row = item.row || item;
      select(row, item.partner || null, which);
    },
  };
}

function select(row, partner, which) {
  const distA = data.combine(state.a);
  const kind = row.kind;
  let rowA = row;
  let rowB = partner;

  if (which === 'b') {
    rowA = data.rows(distA, kind).find((candidate) => candidate.index === row.index) || null;
    rowB = row;
  } else if (!rowB && state.view === 'compare') {
    const pair = data.validPair(state.a, state.b);
    if (pair.ok) {
      const distB = data.combine(state.b);
      if (distB.useCase === distA.useCase) {
        rowB = data.rows(distB, kind).find((candidate) => candidate.index === row.index) || null;
      }
    }
  }
  state.selection = { id: `${kind}:${row.index}`, a: rowA, b: rowB };
  renderSummary($('summaryScroll'), state, distA,
    state.view === 'compare' && data.validPair(state.a, state.b).ok ? data.combine(state.b) : null);
  if (window.matchMedia('(max-width: 900px)').matches) showPanel('summary');
}

main();
