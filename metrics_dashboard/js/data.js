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
    rep: {},
  };

  for (const runKey of keys) {
    const run = DATA.runs[runKey];
    dist.reps += run.reps;
    dist.excluded += run.excluded;
    dist.records += run.records;
    dist.unresolved += run.unresolved;
    // A union's O is the mean over the runs it covers. Unlike prevalence,
    // these do not add: each is already a mean, over repetitions that the
    // union does not renormalise. Averaging equally weights a run by its
    // existence rather than its repetition count, which is what "all models"
    // means here -- the runs are the population.
    if (run.om != null) (dist.omParts = dist.omParts || []).push(run.om);
    if (run.og != null) (dist.ogParts = dist.ogParts || []).push(run.og);
    if (run.note) dist.notes.push(`${labelOf('model', run.m)} · ${labelOf('condition', run.c)}: ${run.note}`);
    addInto(dist.edgeHits, inflate(run.eh, nEdges));
    addInto(dist.nodeHits, inflate(run.nh, nNodes));
    addInto(dist.childHits, inflate(run.nc, nNodes));
    for (const [index, counts] of Object.entries(run.er)) {
      const held = dist.relations.get(Number(index));
      if (!held) dist.relations.set(Number(index), counts.slice());
      else for (let i = 0; i < held.length; i += 1) held[i] += counts[i];
    }
    for (const [metric, values] of Object.entries(run.rep)) {
      (dist.rep[metric] = dist.rep[metric] || []).push(...values);
    }
  }

  const mean = (values) => (values && values.length
    ? values.reduce((a, b) => a + b, 0) / values.length : null);
  dist.oMatched = mean(dist.omParts);
  dist.oGenerated = mean(dist.ogParts);

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
    { id: 'O', label: 'Operationality (O)', phrase: 'operationality (O)', max: 5, kind: 'rubric',
      prose: 'the mean of the six dimensions below, 0-5' },
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

/**
 * True when a metric comes from the rubric panel rather than from the matches.
 *
 * Rubric metrics carry a concept the panel may never have scored, so they have
 * a "—" state that prevalence does not. They are no longer a *sample* in the
 * old sense: the panel scored the reference taxonomies outright, so a blank
 * means the concept was rejected on quality, not that the draw missed it.
 */
export function isSampled(metric) {
  return metric !== 'prevalence';
}

export function metricSpec(id) {
  return metricList().find((metric) => metric.id === id) || metricList()[0];
}

/**
 * Read one metric off a rubric profile.
 *
 * A profile is the concept's six dimension means, panel-averaged — it belongs
 * to the reference concept, not to a run, so every distribution reads the same
 * number here. O is the mean of the six, so the headline and the six rows under
 * it cannot disagree.
 */
function profileValue(profile, metric) {
  if (!profile) return null;
  if (metric === 'O') {
    return profile.reduce((a, b) => a + b, 0) / profile.length;
  }
  const index = DATA.meta.dimensions.findIndex((dim) => dim.key === metric);
  return index < 0 ? null : profile[index];
}

/**
 * Build the rows for one distribution in one mode.
 *
 * A node counts as reached in a repetition when it is an endpoint of a
 * reference edge that repetition matched, which is what "a node that is
 * covered" means in the graph. `childHits` keeps the stricter reading — the
 * concept was named as the child of a match — for the detail panel.
 *
 * Only `hits` varies between distributions. The rubric profile is the
 * reference concept's own, so two distributions over one reference hold
 * identical O columns and differ in prevalence alone — which is the point:
 * a concept is as measurable as it is, and a run is judged on which concepts
 * it reached.
 */
export function rows(dist, kind) {
  const block = DATA.useCases[dist.useCase];
  const source = kind === 'edge' ? block.edges : block.nodes;
  const hits = kind === 'edge' ? dist.edgeHits : dist.nodeHits;
  const reps = dist.reps || 1;

  return source.map((item, index) => {
    // An edge inherits its child's profile: the edge asserts the child as an
    // attribute of the parent, and it is the child a surveyor would record.
    const profile = (kind === 'edge' ? block.nodes[item.t].o : item.o) || null;
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
/**
 * Mean per-prediction coverage, derived from the hit counts.
 *
 * Each entry of `hits` is how many repetitions reached that reference item, so
 * `hits[i] / reps` is its prevalence and the mean of those is the share of the
 * reference a typical single repetition reached. Same quantity as averaging
 * each repetition's own coverage — the double sum is identical — which is why
 * this needs no per-repetition table and works for nodes as well as edges.
 */
function meanPrevalence(hits, reps) {
  if (!reps || !hits.length) return null;
  let total = 0;
  for (let i = 0; i < hits.length; i += 1) total += hits[i];
  return total / (reps * hits.length);
}

export function stats(dist) {
  const block = DATA.useCases[dist.useCase];
  // Pooled coverage: pour every repetition's matches into one bag and ask what
  // share of the reference the bag covers. An item counts once however often it
  // was reached, which is what makes this coverage rather than prevalence —
  // the counts are still there in `hits`, and prevalence reads them.
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
    // Mean prevalence is mean per-prediction coverage: averaging "share of
    // repetitions that reached item i" over items is the same sum as averaging
    // "share of items reached" over repetitions. It is derived here rather than
    // read from `rep` so it exists for node coverage too, which the
    // per-repetition table does not carry.
    perPredNode: meanPrevalence(dist.nodeHits, dist.reps),
    perPredEdge: meanPrevalence(dist.edgeHits, dist.reps),
    coverage: spread(dist.rep.coverage || []),
    coverageAccessibility: spread(dist.rep.coverageAccessibility || []),
    alignment: spread(dist.rep.alignment || []),
    redundancy: spread(dist.rep.redundancy || []),
  };
}

/**
 * Coverage broken down by accessibility category, for one distribution.
 *
 * Both numbers are the same ones `stats` reports for the whole reference, over
 * the subset of items carrying one subtopic label — pooled coverage counts an
 * item once however often it was reached, and per-prediction coverage is the
 * mean prevalence, which equals the mean over repetitions of the share of that
 * category a single schema reached.
 *
 * Only coverage decomposes. Alignment and redundancy are computed per
 * repetition over a whole schema and have no per-category value to report; the
 * page says so rather than splitting them on some invented rule. A category
 * with no reference edges is returned with `edgesTotal: 0` and null coverages,
 * because "the reference has nothing here" and "the run reached nothing here"
 * are different facts and the second one is not true.
 *
 * @param {object} dist A combined distribution from `combine`.
 * @returns {Array<object>} One entry per category, in `DATA.meta.subtopics`
 *   order, plus a record-keeping row when the reference has such edges.
 */
export function subtopicBreakdown(dist) {
  const block = DATA.useCases[dist.useCase];
  const reps = dist.reps || 1;
  const blank = () => ({ total: 0, hit: 0, prevalence: 0 });
  const buckets = new Map();
  const bucket = (label) => {
    if (!buckets.has(label)) {
      buckets.set(label, { label, edges: blank(), nodes: blank(), metaEdges: 0 });
    }
    return buckets.get(label);
  };

  // Seed every declared category, so one with no reference items still gets a
  // row. Dropping it would let "the reference has nothing here" disappear
  // silently, and a reader would take the shorter table for a shorter
  // reference rather than for an empty category — the same mistake the
  // subtopic figure guards against by hatching those cells instead of
  // printing 0%.
  for (const label of DATA.meta.subtopics) bucket(label);

  const walk = (items, hits, key) => {
    items.forEach((item, index) => {
      const entry = bucket(item.c || DATA.meta.noneLabel);
      const slot = entry[key];
      slot.total += 1;
      if (hits[index] > 0) slot.hit += 1;
      slot.prevalence += hits[index] / reps;
      if (key === 'edges' && item.m) entry.metaEdges += 1;
    });
  };
  walk(block.edges, dist.edgeHits, 'edges');
  walk(block.nodes, dist.nodeHits, 'nodes');

  const order = [...DATA.meta.subtopics];
  for (const label of buckets.keys()) if (!order.includes(label)) order.push(label);

  return order.map((label) => {
    const entry = buckets.get(label);
    const shape = (slot) => ({
      total: slot.total,
      hit: slot.hit,
      pooled: slot.total ? slot.hit / slot.total : null,
      perPrediction: slot.total ? slot.prevalence / slot.total : null,
    });
    return {
      subtopic: label,
      metaEdges: entry.metaEdges,
      edges: shape(entry.edges),
      nodes: shape(entry.nodes),
    };
  });
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
