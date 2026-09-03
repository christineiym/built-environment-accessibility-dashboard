/* Loading, combining and measuring distributions.
 *
 * The file on disk holds only base runs. Every union the interface offers is
 * built here by summing them, which is exact because build_data.py stores
 * counts and sums rather than means. Nothing downstream ever sees the
 * difference between a base run and a union.
 */

export let DATA = null;

/** Load the export. Returns the payload and caches it module-wide. */
export async function load(url = 'data/distributions.json') {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  DATA = await response.json();
  return DATA;
}

export const ALL = 'all';

/** Human label for one axis value, falling back to the raw id. */
export function labelOf(kind, id) {
  if (id === ALL) return kind === 'model' ? 'all models' : 'all conditions';
  const list = DATA.meta[kind === 'model' ? 'models' : kind === 'condition' ? 'conditions' : 'useCases'];
  return (list.find((entry) => entry.id === id) || {}).label || id;
}

/** One-line name for a selection, e.g. "GATIS · GPT-5.2 · Grounded". */
export function describe(sel) {
  return [labelOf('useCase', sel.u), labelOf('model', sel.m), labelOf('condition', sel.c)].join(' · ');
}

/** Stable key for a selection, used for caching and for the URL. */
export function selKey(sel) {
  return `${sel.u}|${sel.m}|${sel.c}`;
}

/** Parse a selection key back into a selection. */
export function parseSel(key) {
  const [u, m, c] = String(key).split('|');
  return { u, m, c };
}

/** The base runs a selection expands to, in report order. */
export function runKeys(sel) {
  const models = sel.m === ALL ? DATA.meta.models.map((entry) => entry.id) : [sel.m];
  const conditions = sel.c === ALL ? DATA.meta.conditions.map((entry) => entry.id) : [sel.c];
  const keys = [];
  for (const model of models) {
    for (const condition of conditions) {
      const key = `${sel.u}|${model}|${condition}`;
      if (DATA.runs[key]) keys.push(key);
    }
  }
  return keys;
}

/** True when a selection names at least one run that exists. */
export function exists(sel) {
  return runKeys(sel).length > 0;
}

const isIndividual = (sel) => sel.m !== ALL && sel.c !== ALL;
const isTotal = (sel) => sel.m === ALL && sel.c === ALL;

/**
 * Whether two distributions may be compared, per comparison.tex.
 *
 * Within one use case every pairing in the document is allowed, so the rule
 * collapses to "same use case". Across use cases the document allows only two
 * individual runs (case 1a) or two whole-use-case unions (case 4a); anything
 * partly combined would put a union of two models against a single model over
 * a different reference, which nothing in the paper interprets.
 */
export function validPair(a, b) {
  if (selKey(a) === selKey(b)) {
    return { ok: false, why: 'A distribution cannot be compared with itself.' };
  }
  if (!exists(a) || !exists(b)) {
    return { ok: false, why: 'One of these cells was never run.' };
  }
  if (a.u === b.u) return { ok: true, why: '' };
  if (isIndividual(a) && isIndividual(b)) {
    return { ok: true, why: 'Different reference taxonomies: the two item lists do not overlap, so read the shapes, not the pairs.' };
  }
  if (isTotal(a) && isTotal(b)) {
    return { ok: true, why: 'Different reference taxonomies: the two item lists do not overlap, so read the shapes, not the pairs.' };
  }
  return {
    ok: false,
    why: 'Across use cases comparison.tex pairs only two individual runs, or two whole-use-case unions.',
  };
}

/** Every selection the pickers offer, in menu order. */
export function allSelections() {
  const out = [];
  for (const useCase of DATA.meta.useCases) {
    const models = [...DATA.meta.models.map((m) => m.id), ALL];
    const conditions = [...DATA.meta.conditions.map((c) => c.id), ALL];
    for (const m of models) {
      for (const c of conditions) {
        const sel = { u: useCase.id, m, c };
        if (exists(sel)) out.push(sel);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// combining
// ---------------------------------------------------------------------------

const cache = new Map();

function inflate(flat, length) {
  const out = new Int32Array(length);
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

function addInto(target, source) {
  for (let i = 0; i < target.length; i += 1) target[i] += source[i];
}

function mergeProfiles(target, source) {
  for (const [key, values] of Object.entries(source)) {
    const index = Number(key);
    const held = target.get(index);
    if (!held) {
      target.set(index, values.slice());
    } else {
      for (let i = 0; i < held.length; i += 1) held[i] += values[i];
    }
  }
}

/**
 * Build one distribution, summing whatever base runs the selection covers.
 *
 * Repetitions add, so prevalence stays `hits / reps` for a union exactly as it
 * is for a single run: a reference edge matched in 40 of 100 baseline
 * repetitions and 60 of 100 grounded ones is at 0.50 over the pair, which is
 * what pooling the two schemas would give.
 */
export function combine(sel) {
  const key = selKey(sel);
  if (cache.has(key)) return cache.get(key);

  const block = DATA.useCases[sel.u];
  const nNodes = block.nodes.length;
  const nEdges = block.edges.length;
  const keys = runKeys(sel);

  const dist = {
    key,
    sel,
    useCase: sel.u,
    runKeys: keys,
    reps: 0,
    excluded: 0,
    records: 0,
    unresolved: 0,
    notes: [],
    edgeHits: new Int32Array(nEdges),
    nodeHits: new Int32Array(nNodes),
    childHits: new Int32Array(nNodes),
    relations: new Map(),
    edgeOp: new Map(),
    nodeOp: new Map(),
    rep: {},
  };

  for (const runKey of keys) {
    const run = DATA.runs[runKey];
    dist.reps += run.reps;
    dist.excluded += run.excluded;
    dist.records += run.records;
    dist.unresolved += run.unresolved;
    if (run.note) dist.notes.push(`${labelOf('model', run.m)} · ${labelOf('condition', run.c)}: ${run.note}`);
    addInto(dist.edgeHits, inflate(run.eh, nEdges));
    addInto(dist.nodeHits, inflate(run.nh, nNodes));
    addInto(dist.childHits, inflate(run.nc, nNodes));
    for (const [index, counts] of Object.entries(run.er)) {
      const held = dist.relations.get(Number(index));
      if (!held) dist.relations.set(Number(index), counts.slice());
      else for (let i = 0; i < held.length; i += 1) held[i] += counts[i];
    }
    mergeProfiles(dist.edgeOp, run.eo);
    mergeProfiles(dist.nodeOp, run.no);
    for (const [metric, values] of Object.entries(run.rep)) {
      (dist.rep[metric] = dist.rep[metric] || []).push(...values);
    }
  }

  cache.set(key, dist);
  return dist;
}

// ---------------------------------------------------------------------------
// per-item metrics
// ---------------------------------------------------------------------------

/** The metrics an item can be sorted and sized by, in menu order. */
export function metricList() {
  return [
    { id: 'prevalence', label: 'Prevalence', phrase: 'prevalence', max: 1, kind: 'share' },
    { id: 'O', label: 'Operationality (O)', phrase: 'operationality (O)', max: 1, kind: 'rubricShare' },
    ...DATA.meta.dimensions.map((dim) => ({
      id: dim.key,
      label: `— ${dim.short}`,
      phrase: `the ${dim.short} score`,
      max: 5,
      kind: 'rubric',
      prose: dim.prose,
    })),
  ];
}

/** True when a metric is read off the rubric sample rather than off every match. */
export function isSampled(metric) {
  return metric !== 'prevalence';
}

export function metricSpec(id) {
  return metricList().find((metric) => metric.id === id) || metricList()[0];
}

function profileValue(profile, metric) {
  if (!profile || !profile[0]) return null;
  if (metric === 'O') return profile[1] ? profile[2] / profile[1] : null;
  const index = DATA.meta.dimensions.findIndex((dim) => dim.key === metric);
  return index < 0 ? null : profile[3 + index] / profile[0];
}

/**
 * Build the rows for one distribution in one mode.
 *
 * A node counts as reached in a repetition when it is an endpoint of a
 * reference edge that repetition matched, which is what "a node that is
 * covered" means in the graph. `childHits` keeps the stricter reading — the
 * concept was named as the child of a match — for the detail panel.
 */
export function rows(dist, kind) {
  const block = DATA.useCases[dist.useCase];
  const source = kind === 'edge' ? block.edges : block.nodes;
  const hits = kind === 'edge' ? dist.edgeHits : dist.nodeHits;
  const profiles = kind === 'edge' ? dist.edgeOp : dist.nodeOp;
  const reps = dist.reps || 1;

  return source.map((item, index) => {
    const profile = profiles.get(index) || null;
    const row = {
      kind,
      index,
      hits: hits[index],
      prevalence: hits[index] / reps,
      branch: item.b,
      subtopic: item.c || DATA.meta.noneLabel,
      meta: !!item.m,
      depth: item.d,
      profile,
      opTerms: profile ? profile[0] : 0,
      O: profileValue(profile, 'O'),
    };
    if (kind === 'edge') {
      row.source = block.nodes[item.s].n;
      row.target = block.nodes[item.t].n;
      row.name = `${row.source} → ${row.target}`;
      row.sourceIndex = item.s;
      row.targetIndex = item.t;
      row.relations = dist.relations.get(index) || null;
    } else {
      row.name = item.n;
      row.childHits = dist.childHits[index];
    }
    return row;
  });
}

/** The value one row carries for one metric, or null when unmeasured. */
export function valueOf(row, metric) {
  if (metric === 'prevalence') return row.prevalence;
  return profileValue(row.profile, metric);
}

/** Format a metric value for display. */
export function formatValue(value, metric) {
  if (value == null) return '—';
  const spec = metricSpec(metric);
  return spec.kind === 'rubric' ? value.toFixed(2) : `${Math.round(value * 100)}%`;
}

// ---------------------------------------------------------------------------
// summary statistics
// ---------------------------------------------------------------------------

/** Five-number summary plus the mean, or null for an empty sample. */
export function spread(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (q) => {
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  return {
    n: sorted.length,
    min: sorted[0],
    q1: at(0.25),
    median: at(0.5),
    q3: at(0.75),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

/** Headline counts and spreads for one distribution. */
export function stats(dist) {
  const block = DATA.useCases[dist.useCase];
  const countHit = (array) => array.reduce((total, hits) => total + (hits > 0 ? 1 : 0), 0);
  return {
    reps: dist.reps,
    excluded: dist.excluded,
    records: dist.records,
    unresolved: dist.unresolved,
    nodes: countHit(dist.nodeHits),
    nodesTotal: block.nodes.length,
    edges: countHit(dist.edgeHits),
    edgesTotal: block.edges.length,
    coverage: spread(dist.rep.coverage || []),
    coverageAccessibility: spread(dist.rep.coverageAccessibility || []),
    alignment: spread(dist.rep.alignment || []),
    redundancy: spread(dist.rep.redundancy || []),
  };
}

/**
 * Corpus-level breakdown: every value of every category, over all base runs.
 *
 * This is the default overview the brief asks for — the same five statistics,
 * once overall and once for each value a run can take on each axis.
 */
export function overview() {
  const groups = [];
  const push = (title, entries) => groups.push({ title, entries });

  const forRuns = (label, keys) => {
    const merged = {
      reps: 0, excluded: 0, records: 0, unresolved: 0,
      nodes: 0, edges: 0, nodesTotal: 0, edgesTotal: 0,
      coverage: [], alignment: [],
    };
    const nodeSeen = new Map();
    const edgeSeen = new Map();
    for (const key of keys) {
      const run = DATA.runs[key];
      merged.reps += run.reps;
      merged.excluded += run.excluded;
      merged.records += run.records;
      merged.unresolved += run.unresolved;
      const nodes = nodeSeen.get(run.u) || new Set();
      for (let i = 0; i < run.nh.length; i += 2) nodes.add(run.nh[i]);
      nodeSeen.set(run.u, nodes);
      const edges = edgeSeen.get(run.u) || new Set();
      for (let i = 0; i < run.eh.length; i += 2) edges.add(run.eh[i]);
      edgeSeen.set(run.u, edges);
      merged.coverage.push(...(run.rep.coverage || []));
      merged.alignment.push(...(run.rep.alignment || []));
    }
    for (const [useCase, set] of nodeSeen) {
      merged.nodes += set.size;
      merged.nodesTotal += DATA.useCases[useCase].nodes.length;
    }
    for (const [useCase, set] of edgeSeen) {
      merged.edges += set.size;
      merged.edgesTotal += DATA.useCases[useCase].edges.length;
    }
    merged.coverage = spread(merged.coverage);
    merged.alignment = spread(merged.alignment);
    return { label, ...merged };
  };

  const every = Object.keys(DATA.runs);
  push('All runs', [forRuns('Every run', every)]);
  push('By use case', DATA.meta.useCases.map((entry) =>
    forRuns(entry.label, every.filter((key) => DATA.runs[key].u === entry.id))));
  push('By model', DATA.meta.models.map((entry) =>
    forRuns(entry.label, every.filter((key) => DATA.runs[key].m === entry.id))));
  push('By condition', DATA.meta.conditions.map((entry) =>
    forRuns(entry.label, every.filter((key) => DATA.runs[key].c === entry.id))));
  return groups;
}
