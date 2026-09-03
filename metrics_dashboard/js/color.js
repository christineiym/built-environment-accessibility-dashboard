/* Colour roles.
 *
 * Two jobs, kept apart. Magnitude is a single-hue sequential ramp, five steps,
 * shared by bars and by node fill, so a long bar and a dark node mean the same
 * thing. Identity — a top branch, an accessibility category — is a fixed
 * categorical order that never cycles and never depends on rank, so filtering
 * the list cannot repaint the survivors.
 *
 * The hexes live in styles.css as custom properties; this module only decides
 * which slot an item gets.
 */

import { DATA } from './data.js';

/** Sequential steps, low to high. */
export const SEQ_STEPS = 5;

/** Categorical slots available for identity. Slot 0 is reserved for "none". */
const CAT_SLOTS = 9;

/** Which sequential step a value in [0, 1] lands on. */
export function seqStep(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(SEQ_STEPS, Math.max(1, Math.ceil(fraction * SEQ_STEPS)));
}

/** CSS colour for a magnitude, as a var() reference. */
export function seqColor(fraction, series = 'a') {
  const step = seqStep(fraction);
  return step === 0 ? 'var(--empty)' : `var(--seq-${series}-${step})`;
}

const categoryIndex = new Map();

/**
 * Freeze the categorical slot order.
 *
 * Called once per use case. Accessibility categories take the order the
 * pipeline declares in `pipeline.config.SUBTOPICS`, so the same category is the
 * same hue in this dashboard and in the paper's figures; branches take their
 * order from the reference file. Anything past the ninth slot, and the
 * record-keeping bucket, fall to a neutral grey — which is the honest reading
 * of "no accessibility category applies" rather than a tenth invented hue.
 */
export function registerCategories(useCase) {
  const key = `subtopic:${useCase}`;
  if (!categoryIndex.has(key)) {
    const map = new Map();
    DATA.meta.subtopics.forEach((label) => {
      if (label !== DATA.meta.noneLabel && map.size < CAT_SLOTS) map.set(label, map.size + 1);
    });
    categoryIndex.set(key, map);
  }
  const branchKey = `branch:${useCase}`;
  if (!categoryIndex.has(branchKey)) {
    const map = new Map();
    DATA.useCases[useCase].branches.forEach((label) => {
      if (map.size < CAT_SLOTS) map.set(label, map.size + 1);
    });
    categoryIndex.set(branchKey, map);
  }
}

/** The category value a row carries under one colouring. */
export function categoryOf(row, colorBy) {
  return colorBy === 'branch' ? row.branch : row.subtopic;
}

/** CSS colour for one category value. */
export function categoryColor(useCase, colorBy, value) {
  const map = categoryIndex.get(`${colorBy}:${useCase}`);
  const slot = map ? map.get(value) : undefined;
  return slot ? `var(--cat-${slot})` : 'var(--cat-none)';
}

/** Every category in slot order, for the legend. */
export function categories(useCase, colorBy) {
  const map = categoryIndex.get(`${colorBy}:${useCase}`) || new Map();
  const listed = [...map.keys()];
  if (colorBy === 'subtopic') listed.push(DATA.meta.noneLabel);
  return listed.map((value) => ({ value, color: categoryColor(useCase, colorBy, value) }));
}

/**
 * Fill for one item.
 *
 * Under a categorical colouring the hue carries identity and the magnitude
 * moves to opacity, so size and shade still read as prevalence rather than the
 * category swallowing the measurement.
 */
export function fillFor(row, { colorBy, useCase, fraction, series = 'a' }) {
  if (colorBy === 'value') return { color: seqColor(fraction, series), opacity: 1 };
  return {
    color: categoryColor(useCase, colorBy, categoryOf(row, colorBy)),
    opacity: 0.4 + 0.6 * Math.min(1, Math.max(0, fraction)),
  };
}

/** Build a legend list element for the current colouring. */
export function legend(useCase, colorBy, metricLabel) {
  const wrap = document.createElement('div');
  wrap.className = 'legend';
  if (colorBy === 'value') {
    const scale = document.createElement('ul');
    scale.className = 'legend-scale';
    scale.setAttribute('aria-label', `${metricLabel} scale, low to high`);
    for (let step = 1; step <= SEQ_STEPS; step += 1) {
      const item = document.createElement('li');
      item.innerHTML = `<span class="chip" style="background:var(--seq-a-${step})"></span>`;
      if (step === 1) item.append('low');
      if (step === SEQ_STEPS) item.append('high');
      scale.append(item);
    }
    wrap.append(scale);
    return wrap;
  }
  const list = document.createElement('ul');
  list.className = 'legend-cats';
  list.setAttribute('aria-label', colorBy === 'branch' ? 'Top branches' : 'Accessibility categories');
  for (const entry of categories(useCase, colorBy)) {
    const item = document.createElement('li');
    item.innerHTML = `<span class="chip" style="background:${entry.color}"></span>`;
    item.append(entry.value);
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}
