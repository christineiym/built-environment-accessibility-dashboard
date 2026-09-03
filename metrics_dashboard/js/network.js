/* The reference taxonomy as a graph, weighted by how often it was matched.
 *
 * Node radius and shade both rise with prevalence, and edge thickness with the
 * prevalence of the edge — so the parts of the reference a model reaches
 * reliably are the parts that are visually heavy, and the parts it never
 * reaches are hairlines.
 *
 * The layout is run to convergence once and then drawn, rather than animated:
 * a settled picture is what gets compared, and freezing it makes the positions
 * reproducible, which is what the Align button copies from one network to the
 * other.
 *
 * Link strength follows prevalence, so two distributions over the same
 * reference settle differently — that difference is a reading of the data, and
 * Align exists for when you would rather hold position constant and read the
 * weights instead.
 */

import { fillFor, legend } from './color.js';

const WIDTH = 900;
const HEIGHT = 640;
const PAD = 34;
const TICKS = 320;
const LABEL_COUNT = 40;

export class Network {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.cursor = 0;
    this.element = document.createElement('figure');
    this.element.className = 'chart chart--network';
    this.positions = null;
  }

  /**
   * Draw one network.
   *
   * @param {object} props
   * @param {Array} props.nodes Node rows with `prevalence`.
   * @param {Array} props.edges Edge rows with `prevalence`.
   * @param {Map|null} props.pinned Positions to adopt instead of solving.
   */
  render(props) {
    this.props = props;
    this.element.replaceChildren();

    const caption = document.createElement('figcaption');
    caption.innerHTML = `<strong>${props.title}</strong> <span>${props.caption}</span>`;
    this.element.append(caption, legend(props.useCase, props.colorBy, props.metricLabel));

    // `ref` and not `index`: d3.forceSimulation overwrites `node.index` with
    // the node's position in the array, which would silently replace every
    // reference-taxonomy id with an array offset — and the Align button, which
    // matches the two networks by that id, would quietly stop matching.
    const nodes = props.nodes.map((row) => ({
      ref: row.index,
      row,
      value: props.valueOf(row),
      prevalence: row.prevalence,
    }));
    const byIndex = new Map(nodes.map((node) => [node.ref, node]));
    const links = props.edges
      .filter((row) => byIndex.has(row.sourceIndex) && byIndex.has(row.targetIndex))
      .map((row) => ({ source: byIndex.get(row.sourceIndex), target: byIndex.get(row.targetIndex), row }));

    this.layout(nodes, links, props.pinned);
    this.positions = new Map(nodes.map((node) => [node.ref, { x: node.x, y: node.y }]));

    const svg = d3.create('svg')
      .attr('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'listbox')
      .attr('tabindex', 0)
      .attr('aria-label',
        `${props.title}. ${nodes.length} concepts and ${links.length} reference edges. `
        + 'Press Enter to step through the concepts, Escape to leave.');

    const viewport = svg.append('g').attr('class', 'viewport');
    const edgeLayer = viewport.append('g').attr('class', 'edges');
    const nodeLayer = viewport.append('g').attr('class', 'nodes');

    const maxValue = Math.max(1e-9, ...nodes.map((n) => n.value ?? 0));

    edgeLayer.selectAll('line')
      .data(links)
      .join('line')
      .attr('class', (d) => (d.row.prevalence > 0 ? 'edge' : 'edge edge--unmatched'))
      .attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y)
      .attr('stroke', (d) => fillFor(d.row, {
        colorBy: props.colorBy, useCase: props.useCase, fraction: d.row.prevalence, series: props.series,
      }).color)
      .attr('stroke-opacity', (d) => (d.row.prevalence > 0 ? 0.25 + 0.6 * d.row.prevalence : 0.12))
      .attr('stroke-width', (d) => 0.6 + 5.4 * d.row.prevalence)
      .append('title')
      .text((d) => `${d.row.name} — matched in ${Math.round(d.row.prevalence * 100)}% of repetitions`);

    const ranked = [...nodes].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    this.order = ranked;
    const labelled = placeLabels(ranked, maxValue);

    const groups = nodeLayer.selectAll('g')
      .data(ranked, (d) => d.ref)
      .join('g')
      .attr('class', 'node')
      .attr('transform', (d) => `translate(${d.x},${d.y})`)
      .attr('role', 'option')
      .attr('tabindex', (d, i) => (i === this.cursor ? 0 : -1))
      .attr('aria-selected', (d) => (props.selectedId === `node:${d.ref}` ? 'true' : 'false'))
      .attr('aria-label', (d) => `${d.row.name}, ${props.metricLabel} ${props.textOf(d.row)}, ${d.row.subtopic}`)
      .attr('data-index', (d) => d.ref);

    groups.append('circle')
      .attr('r', (d) => radius(d.value, maxValue))
      .attr('fill', (d) => fillFor(d.row, {
        colorBy: props.colorBy, useCase: props.useCase, fraction: (d.value ?? 0) / maxValue, series: props.series,
      }).color)
      .attr('fill-opacity', (d) => fillFor(d.row, {
        colorBy: props.colorBy, useCase: props.useCase, fraction: (d.value ?? 0) / maxValue, series: props.series,
      }).opacity)
      .attr('class', (d) => (d.prevalence > 0 ? 'dot' : 'dot dot--unmatched'));

    groups.append('title').text((d) => `${d.row.name} — ${props.metricLabel} ${props.textOf(d.row)}`);

    groups.filter((d) => labelled.has(d.ref))
      .append('text')
      .attr('class', 'node-label')
      .attr('dy', (d) => -radius(d.value, maxValue) - 4)
      .attr('text-anchor', 'middle')
      .text((d) => d.row.name);

    svg.on('keydown', (event) => this.onKey(event, svg.node()));
    groups
      .on('mouseenter', (event, d) => this.handlers.onCursor?.(d.row, 'pointer'))
      .on('focus', (event, d) => {
        this.cursor = ranked.indexOf(d);
        this.handlers.onCursor?.(d.row, 'keyboard');
      })
      .on('click', (event, d) => this.handlers.onSelect?.(d.row));

    const zoom = d3.zoom().scaleExtent([0.4, 6])
      .on('zoom', (event) => viewport.attr('transform', event.transform));
    svg.call(zoom).on('dblclick.zoom', null);

    const stage = document.createElement('div');
    stage.className = 'net-stage';
    stage.append(svg.node());
    this.element.append(stage);
    this.svg = svg.node();

    this.element.append(nodeTable(ranked, props));
    return this.element;
  }

  /**
   * Solve, or adopt someone else's solution.
   *
   * Aligning pins every concept the other network placed and lets the
   * simulation settle the rest around them — B can reach a concept A never
   * did, and dropping those on the centre would hide exactly the difference
   * the comparison is for. Pinned coordinates are already fitted, so the
   * result is not refitted; the stragglers are clamped into the frame instead.
   */
  layout(nodes, links, pinned) {
    if (pinned) {
      for (const node of nodes) {
        const at = pinned.get(node.ref);
        if (at) {
          node.x = node.fx = at.x;
          node.y = node.fy = at.y;
        }
      }
    }
    // GATIS carries 912 edges over 142 concepts against osm_pwg's 53 over 35.
    // Held at one setting the dense case collapses into a hairball, so
    // repulsion and rest length grow with the graph, keeping the two use cases
    // legible at the same size.
    const density = Math.sqrt(links.length / Math.max(1, nodes.length));
    const spread = Math.max(1, density / 1.3);
    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links)
        .id((d) => d.ref)
        .distance((d) => (130 - 70 * d.row.prevalence) * spread)
        .strength((d) => (0.08 + 0.5 * d.row.prevalence) / spread))
      .force('charge', d3.forceManyBody().strength(-190 * spread * spread))
      .force('centre', d3.forceCenter(WIDTH / 2, HEIGHT / 2))
      .force('collide', d3.forceCollide().radius(18))
      .stop();
    simulation.tick(TICKS);
    if (pinned) clampAll(nodes);
    else fit(nodes);
  }

  onKey(event, svg) {
    const groups = [...svg.querySelectorAll('g.node')];
    if (!groups.length) return;
    const inside = event.target.closest && event.target.closest('g.node');

    if (!inside) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.focusNode(groups, Math.min(this.cursor, groups.length - 1));
      }
      return;
    }
    const at = groups.indexOf(inside);
    let target = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') target = Math.min(groups.length - 1, at + 1);
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') target = Math.max(0, at - 1);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = groups.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      svg.focus();
      return;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handlers.onSelect?.(this.order[at].row);
      return;
    }
    if (target != null) {
      event.preventDefault();
      this.focusNode(groups, target);
    }
  }

  focusNode(groups, index) {
    groups.forEach((group, i) => group.setAttribute('tabindex', i === index ? '0' : '-1'));
    this.cursor = index;
    groups[index].focus();
  }
}

/**
 * Rescale a settled layout to fill the frame.
 *
 * A force layout has no natural extent — a sparse graph drifts wide and a
 * dense one huddles — so without this the same viewBox shows one distribution
 * cropped and the next one tiny. Scaling uniformly keeps every distance in the
 * layout proportionally intact.
 */
function fit(nodes) {
  if (!nodes.length) return;
  // A robust extent, not the absolute one: a couple of weakly-connected
  // concepts fly far out, and fitting to them would shrink everything else to
  // a dot. The outliers are then clamped back to the frame rather than dropped.
  const at = (values, q) => values[Math.min(values.length - 1, Math.round((values.length - 1) * q))];
  const xs = nodes.map((node) => node.x).sort((a, b) => a - b);
  const ys = nodes.map((node) => node.y).sort((a, b) => a - b);
  const minX = at(xs, 0.02); const maxX = at(xs, 0.98);
  const minY = at(ys, 0.02); const maxY = at(ys, 0.98);
  const scale = Math.min(
    (WIDTH - 2 * PAD) / Math.max(1, maxX - minX),
    (HEIGHT - 2 * PAD) / Math.max(1, maxY - minY),
  );
  const offsetX = (WIDTH - (maxX - minX) * scale) / 2;
  const offsetY = (HEIGHT - (maxY - minY) * scale) / 2;
  for (const node of nodes) {
    node.x = clamp(offsetX + (node.x - minX) * scale, PAD, WIDTH - PAD);
    node.y = clamp(offsetY + (node.y - minY) * scale, PAD, HEIGHT - PAD);
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Keep every node inside the frame without moving any of them relative to it. */
function clampAll(nodes) {
  for (const node of nodes) {
    node.x = clamp(node.x, PAD, WIDTH - PAD);
    node.y = clamp(node.y, PAD, HEIGHT - PAD);
  }
}

/**
 * Choose which nodes get a printed label.
 *
 * Highest value first, and only where the label's box clears every box already
 * placed — so zooming out shows the headline concepts and nothing collides,
 * rather than showing all of them on top of each other.
 */
function placeLabels(ranked, maxValue) {
  // Other nodes' circles are obstacles too, not only other labels: a name
  // printed across a neighbouring dot is as unreadable as one printed across
  // another name.
  const circles = ranked.map((node) => {
    const r = radius(node.value, maxValue);
    return { ref: node.ref, x1: node.x - r, x2: node.x + r, y1: node.y - r, y2: node.y + r };
  });
  const hits = (box, other) =>
    box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1;

  const placed = [];
  const keep = new Set();
  for (const node of ranked) {
    if (keep.size >= LABEL_COUNT) break;
    const width = node.row.name.length * 5.6 + 6;
    const top = node.y - radius(node.value, maxValue) - 16;
    const box = { x1: node.x - width / 2, x2: node.x + width / 2, y1: top, y2: top + 13 };
    if (placed.some((other) => hits(box, other))) continue;
    if (circles.some((circle) => circle.ref !== node.ref && hits(box, circle))) continue;
    placed.push(box);
    keep.add(node.ref);
  }
  return keep;
}

function radius(value, maxValue) {
  const fraction = Math.min(1, Math.max(0, (value ?? 0) / (maxValue || 1)));
  return 3 + 13 * Math.sqrt(fraction);
}

/** Concepts as a table — the text equivalent of the picture. */
function nodeTable(nodes, props) {
  const details = document.createElement('details');
  details.className = 'table-fallback';
  const summary = document.createElement('summary');
  summary.textContent = `Data table (${nodes.length} concepts)`;
  details.append(summary);
  const table = document.createElement('table');
  table.innerHTML = `<caption>${props.title}. ${props.caption}</caption>`
    + `<thead><tr><th scope="col">Concept</th><th scope="col">${props.metricLabel}</th>`
    + '<th scope="col">Reached in</th><th scope="col">Category</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const node of nodes) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<th scope="row">${node.row.name}</th><td>${props.textOf(node.row)}</td>`
      + `<td>${node.row.hits} of ${props.reps} reps</td><td>${node.row.subtopic}</td>`;
    body.append(tr);
  }
  table.append(body);
  details.append(table);
  return details;
}
