/* The ranked bar list, for nodes and for edges.
 *
 * Plain elements rather than SVG: every bar is a real focusable option with a
 * text label beside it, so the ranking is legible to a screen reader without a
 * parallel description, and the browser handles reflow between the horizontal
 * and vertical orientations.
 *
 * Keyboard model, as asked for: the chart is one tab stop. Enter steps *into*
 * it and lands on a bar, the arrow keys walk the ranking, Escape steps back
 * out to the chart. Nothing is announced through a live region — focus moves
 * to a labelled option, and the option's own name carries its value.
 */

import { fillFor, legend } from './color.js';

const PAGE = 12;

export class BarChart {
  /**
   * @param {object} handlers
   * @param {(item: object|null) => void} handlers.onCursor Item under the keyboard cursor or pointer.
   * @param {(item: object) => void} handlers.onSelect Item chosen with Enter or a click.
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.limit = 150;
    this.cursor = 0;
    this.element = document.createElement('figure');
    this.element.className = 'chart';
    this.items = [];
  }

  /** Discard any "show more" state, e.g. when the distribution changes. */
  resetPaging() {
    this.limit = 150;
    this.cursor = 0;
  }

  /**
   * Draw the chart.
   *
   * @param {object} props
   * @param {Array} props.items Rows to draw, already sorted.
   * @param {string} props.title Heading above the chart.
   * @param {string} props.caption Sentence describing what is drawn.
   * @param {string} props.orientation `'h'` or `'v'`.
   * @param {boolean} props.overlay Draw B on top of A rather than alone.
   * @param {string} props.metricLabel Name of the measured quantity.
   * @param {string} props.unit Suffix for values.
   * @param {string} props.colorBy Colouring in force.
   * @param {string} props.useCase Reference taxonomy, for the categorical slots.
   * @param {string} props.orderText How the rows are ranked, for the group's
   *   name — a chart ranked on the *other* distribution's values must say so.
   * @param {string} props.series `'a'` or `'b'`; which ramp a solo chart uses.
   * @param {string} props.selectedId Key of the currently selected item.
   */
  render(props) {
    this.props = props;
    this.items = props.items;
    const { items, orientation, overlay } = props;
    const shown = items.slice(0, this.limit);
    this.element.replaceChildren();

    const caption = document.createElement('figcaption');
    caption.innerHTML = `<strong>${props.title}</strong> <span>${props.caption}</span>`;
    this.element.append(caption);

    if (props.colorBy !== 'value' || !overlay) {
      this.element.append(legend(props.useCase, props.colorBy, props.metricLabel));
    }
    if (overlay) this.element.append(overlayKey(props));

    const list = document.createElement('div');
    list.className = `bars bars--${orientation}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('tabindex', '0');
    list.setAttribute('aria-label',
      `${props.title}. ${items.length} items, `
      + `${props.orderText || `most ${props.metricLabel.toLowerCase()} first`}. `
      + 'Press Enter to step through the bars, Escape to leave.');
    list.dataset.empty = items.length ? 'no' : 'yes';

    shown.forEach((item, index) => list.append(this.bar(item, index, props)));

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Nothing matches the current filters.';
      list.append(empty);
    }

    list.addEventListener('keydown', (event) => this.onKey(event, list));
    list.addEventListener('focusin', (event) => {
      const bar = event.target.closest('.bar');
      if (bar) {
        this.cursor = Number(bar.dataset.index);
        this.handlers.onCursor?.(this.items[this.cursor], 'keyboard');
      }
    });
    this.element.append(list);
    this.list = list;

    if (items.length > shown.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost-btn more-btn';
      const remaining = items.length - shown.length;
      const step = Math.min(PAGE * 25, remaining);
      more.textContent = step === remaining
        ? `Show the remaining ${remaining}`
        : `Show ${step} more of ${remaining}`;
      more.addEventListener('click', () => {
        this.limit += PAGE * 25;
        this.render(this.props);
        this.list.focus();
      });
      this.element.append(more);
    }

    this.element.append(dataTable(shown, props));
    return this.element;
  }

  /** One bar. */
  bar(item, index, props) {
    const row = document.createElement('div');
    row.className = 'bar';
    row.dataset.index = String(index);
    row.setAttribute('role', 'option');
    row.setAttribute('tabindex', index === this.cursor ? '0' : '-1');
    const selected = props.selectedId && item.id === props.selectedId;
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.setAttribute('aria-label', ariaLabel(item, props));
    if (item.row.meta) row.dataset.meta = 'yes';

    const name = document.createElement('span');
    name.className = 'bar-name';
    name.title = item.label;
    const text = document.createElement('span');
    text.className = 'bar-word';
    text.textContent = item.label;
    name.append(text);
    if (props.colorBy !== 'value') {
      // Under a categorical colouring the hue is the only thing saying which
      // group a bar belongs to, and two categories can end up adjacent at any
      // point in the ranking. The name beside the swatch is the direct label
      // that keeps identity off colour alone.
      const category = document.createElement('span');
      category.className = 'bar-cat';
      category.textContent = props.colorBy === 'branch' ? item.row.branch : item.row.subtopic;
      name.append(category);
    }

    const track = document.createElement('span');
    track.className = 'bar-track';
    // A missing value is not a zero and certainly not a full bar: with nothing
    // to draw, the track itself is hatched so "never scored" cannot be read off
    // the same length scale as a measurement.
    if (item.fractionA == null) track.dataset.missing = 'yes';
    const fillA = fill(item, props, 'a');
    if (fillA) track.append(fillA);
    if (props.overlay) {
      const fillB = fill(item, props, 'b');
      if (fillB) track.append(fillB);
    }

    const value = document.createElement('span');
    value.className = 'bar-val';
    value.textContent = props.overlay ? `${item.textA} → ${item.textB}` : item.textA;
    if (item.sampleA != null) {
      // The rubric sample size, beside the score it was computed from: 100%
      // off one scored concept and 100% off eight are not the same claim.
      const size = document.createElement('small');
      size.textContent = props.overlay ? ` n ${item.sampleA}/${item.sampleB ?? 0}` : ` n ${item.sampleA}`;
      value.append(size);
    }

    row.append(name, track, value);
    row.addEventListener('mouseenter', () => this.handlers.onCursor?.(item, 'pointer'));
    row.addEventListener('click', () => this.handlers.onSelect?.(item));
    return row;
  }

  /** Arrow keys inside the list; Enter in, Escape out. */
  onKey(event, list) {
    const bars = [...list.querySelectorAll('.bar')];
    if (!bars.length) return;
    const inside = event.target.classList.contains('bar');
    const vertical = this.props.orientation === 'v';
    const next = vertical ? 'ArrowRight' : 'ArrowDown';
    const previous = vertical ? 'ArrowLeft' : 'ArrowUp';

    if (!inside) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === next) {
        event.preventDefault();
        this.focusBar(bars, Math.min(this.cursor, bars.length - 1));
      }
      return;
    }

    const at = Number(event.target.dataset.index);
    let target = null;
    if (event.key === next) target = Math.min(bars.length - 1, at + 1);
    else if (event.key === previous) target = Math.max(0, at - 1);
    else if (event.key === 'PageDown') target = Math.min(bars.length - 1, at + PAGE);
    else if (event.key === 'PageUp') target = Math.max(0, at - PAGE);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = bars.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      list.focus();
      return;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handlers.onSelect?.(this.items[at]);
      return;
    }
    if (target != null) {
      event.preventDefault();
      this.focusBar(bars, target);
    }
  }

  focusBar(bars, index) {
    bars.forEach((bar, i) => bar.setAttribute('tabindex', i === index ? '0' : '-1'));
    this.cursor = index;
    bars[index].focus();
    bars[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/** One fill, or null when this series has no value to draw here. */
function fill(item, props, series) {
  const fraction = series === 'a' ? item.fractionA : item.fractionB;
  if (fraction == null) return null;
  const span = document.createElement('span');
  span.className = `bar-fill bar-fill--${series}`;
  const paint = fillFor(item.row, {
    colorBy: props.overlay && series === 'b' ? 'value' : props.colorBy,
    useCase: props.useCase,
    fraction,
    series: props.overlay ? series : props.series,
  });
  span.style.setProperty('--v', String(fraction));
  span.style.setProperty('--fill', paint.color);
  span.style.setProperty('--fill-opacity', String(paint.opacity));
  return span;
}

function ariaLabel(item, props) {
  const parts = [item.label];
  if (props.overlay) {
    parts.push(`A ${item.textA}, B ${item.textB}`);
    if (item.delta != null) {
      const sign = item.delta > 0 ? 'up' : item.delta < 0 ? 'down' : 'no change';
      parts.push(item.delta === 0 ? sign : `${sign} ${item.deltaText}`);
    }
  } else {
    parts.push(`${props.metricLabel} ${item.textA}`);
  }
  if (item.fractionA == null) parts.push('not measured');
  if (props.overlay && item.fractionB == null) parts.push('not measured in B');
  if (item.sampleA != null) {
    parts.push(item.sampleA
      ? `from ${item.sampleA} scored concept${item.sampleA === 1 ? '' : 's'}`
      : 'no scored concepts');
  }
  if (item.row.meta) parts.push('record-keeping');
  parts.push(item.row.subtopic);
  return parts.join(', ');
}

function overlayKey(props) {
  const wrap = document.createElement('p');
  wrap.className = 'overlay-key';
  wrap.innerHTML =
    `<span><span class="chip chip--a"></span>${props.nameA}</span>`
    + `<span><span class="chip chip--b"></span>${props.nameB}</span>`;
  return wrap;
}

/** The same numbers as a table — the accessible equivalent of the chart. */
function dataTable(items, props) {
  const details = document.createElement('details');
  details.className = 'table-fallback';
  const summary = document.createElement('summary');
  summary.textContent = `Data table (${items.length} rows)`;
  details.append(summary);

  const table = document.createElement('table');
  const head = props.overlay
    ? ['Item', props.nameA, props.nameB, 'Change', 'Category']
    : ['Item', props.metricLabel, 'Reached in', 'Category'];
  table.innerHTML =
    `<caption>${props.title}. ${props.caption}</caption><thead><tr>${
      head.map((cell) => `<th scope="col">${cell}</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');
  for (const item of items) {
    const cells = props.overlay
      ? [item.textA, item.textB, item.deltaText ?? '—', item.row.subtopic]
      : [item.sampleA == null ? item.textA : `${item.textA} (n ${item.sampleA})`,
         `${item.row.hits} of ${item.reps} reps`, item.row.subtopic];
    const tr = document.createElement('tr');
    tr.innerHTML = `<th scope="row">${escapeHtml(item.label)}</th>${
      cells.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}`;
    body.append(tr);
  }
  table.append(body);
  details.append(table);
  return details;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
