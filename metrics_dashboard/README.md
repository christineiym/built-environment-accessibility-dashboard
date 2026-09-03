# Schema Match Distribution Explorer

Where the v3 metrics tables say *how much* of a reference taxonomy a generated
schema reached, this dashboard says **which parts, how reliably, and what they
have in common** — per use case, model and grounding condition.

Static site: HTML, CSS, seven ES modules, one JSON file. No build step, no
server. Drop the folder on GitHub Pages and it works. It is independent of
`../dashboard/` and shares nothing with it but the colour conventions.

## What a distribution is

`comparison.tex` calls it `p_umc`: everything the matcher asserted for one
`(use case, model, condition)` cell, over its 100 repetitions. Two axes accept
a **combined** value as well as a specific one, giving 9 distributions per use
case and 18 in all:

| Axis | Values |
|---|---|
| Use case | OSM / PWG (53 reference edges), GATIS (912) |
| Model | GPT-5.2, Gemini 3.5 Flash, *all models* |
| Condition | Baseline (`ungrounded`), Grounded, *all conditions* |

A combined distribution is the union of its cells: hit counts add and so do
repetitions, so prevalence stays `hits / reps` and a union can never disagree
with its parts. Unions are computed in the browser for that reason — the JSON
holds only the eight base runs.

The two local models in `pipeline.runs` (`gemma4-e4b`, `llama3.2`) are **out of
the grid**, but for a smaller reason than before. Their `osm_pwg` arms were
regenerated at 100 repetitions on 2026-09-03 and now match the frontier arms;
their `gatis` arms are still 8. Neither has a grounded cell — the grounding
corpus is ~275K tokens, past both models' context — so "all conditions" would
still mean something different in each half. `build_data.py --include-local`
adds them if you want a look.

### Which pairs may be compared

The Compare view enforces `comparison.tex` rather than trusting the reader.
Within one use case every pairing in the document is allowed. Across use cases
only two are: **two individual runs** (case 1a) and **two whole-use-case
unions** (case 4a). Anything partly combined — say GPT over both conditions on
OSM against Gemini over both on GATIS — is refused with the reason, because
nothing in the paper interprets it. Cross-reference pairings that *are* allowed
carry a caption saying the two item lists do not overlap, so what is being
compared is the shape and not the pairs.

## What is measured

The unit is a **reference** concept or a **reference** edge — the denominator
is the same for every distribution, which is what makes the profiles
comparable. Generated terms are not the unit; the twelve runs hold ~196,000
distinct ones, most appearing once.

| Metric | Meaning |
|---|---|
| **Prevalence** | Share of repetitions that matched this edge. For a concept: share of repetitions where it was an endpoint of some matched edge. |
| **Operationality (O)** | The reference concept's **own** rubric score — the mean of its six dimensions, 0–5, panel-averaged over three raters. An edge carries its child's. |
| **Its six parts** | `E_collectible` … `J_practitioner_use`, 0–5. Each is sortable on its own. |

**O belongs to the concept, not to the distribution.** Every distribution shows
the same O for a given node or edge, because operationality is a property of the
concept and not of who matched it. What differs between two distributions is
**prevalence** — which concepts each one reached. Sorting by O therefore ranks
the *reference* by how measurable it is, and the bars then say who got there.

It used to work the other way, and the result was wrong: a node's O was the mean
over whichever generated concepts a run happened to match to it, so
`access_aisle` read 4.235 for GPT baseline and 3.632 for GPT grounded. No
concept had scored differently — 9 concepts matched it in one run and 13 in the
other. The node moved when nothing about the node had changed. The reference
taxonomies are now scored outright by `v3/20_operationality_reference.py`, with
**no parent context**, so a concept's score is a pure function of the concept.

**O is the average of its six parts**, on their scale, so the headline number
and the rows under it are one measurement at two levels of detail — a low `O`
always has a dimension to blame, and `selftest.html` asserts the arithmetic.

Two grouping labels ride along, both from the reference rather than the model:

- **Top branch** — the root of the concept's canonical path (`barrier` /
  `roadway`; `edge` / `node` / `point` / `virtual_link` / `zone`). Both
  references are DAGs, so the branch is the one on the shortest root path,
  the same rule that fixes a concept's depth.
- **Accessibility category** — the subtopic panel's consensus for that edge,
  from `v3/data/reference_subtopics.json`. Edges the panel judged
  record-keeping (`None of these` by majority) are shown in italic, coloured
  neutral grey, and can be dropped entirely with **Restrict the reference to →
  Accessibility only** — 280 of GATIS's 912 edges. The same control restricts
  the page to a single category, and the summary rail carries **Coverage by
  accessibility category**, which is every category at once.

## Coverage by accessibility category

A collapsed block in the summary rail, one row per category, with the two
coverages the rail already reports for the whole reference: pooled — the share
of that category's items reached by at least one repetition — and per
prediction, the share a single schema reaches on average. In Compare view each
cell carries A and B. Switching between **Nodes** and **Edges** switches the
table between reference concepts and reference edges.

A category with no reference items says so rather than reading 0%: on OSM/PWG
that is Bikes and Transit, where the reference has nothing to reach and a run
cannot miss it. The same distinction the hatched cells make in
`v3/output/metrics_extra/subtopic_coverage*.png`, which this table is the
interactive form of — the numbers are computed in the browser from the same
hit counts and agree with `subtopic_coverage.csv` to four decimals.

Coverage is the only headline metric that splits this way. Alignment and
redundancy are computed per repetition over a whole schema, so there is no
per-category value to report and the page does not invent one.

## The three modes

- **Network** — the reference taxonomy as a graph. Node size and shade follow
  the chosen metric; edge thickness follows how often that edge was matched.
  Layout is solved once and frozen, so the picture is reproducible. Link
  strength follows prevalence, so two distributions settle differently; that
  difference is a reading of the data, and **Align B to A** is for when you
  would rather hold position constant and read the weights. Aligning pins every
  concept A placed and lets anything only B reached settle around them.
- **Nodes** and **Edges** — the ranked list, horizontal or vertical. In Compare
  they are either side by side or **overlaid**: one track per item, A solid and
  B hatched over it. Overlay needs both distributions over the same reference
  and is disabled otherwise.

**Row order** decides what the ranking is read off, and it is the control that
makes the separate layout comparable:

| Setting | What you see |
|---|---|
| Each by its own value | Two independent rankings. Good for "what is this model's top of the list". |
| Both by A's value | One ranking, A's, in both charts. Row *n* is the same item on both sides. |
| Both by B's value | The same, ranked on B. |

Ranking B on A's values only reads as an alignment if the two charts hold the
same items in the same rows, so a shared order draws the **union** of what
either distribution reached. An item only one of them reached still gets a line
in each — in the other it is a measured zero, which is the comparison working
rather than a gap in it. Both captions name the distribution the ranking came
from, and so does each chart's accessible name, since a ranking that is not the
chart's own is the first thing that would be misread.

This is what makes a category pattern visible: with **Colour by → accessibility
category** and a shared order, a subtopic that collapses between the two
distributions shows up as a run of same-coloured rows that are long on one side
and short on the other. The order also applies to the overlay, which otherwise
always ranks by A.

A shared order needs both distributions over the same reference taxonomy — two
references share no items, so there is no row to align to — and the control
disables itself with that reason when they don't.

## Sonification

Toggle **Play a tone per item** and a short note sounds for whatever the
pointer or the keyboard cursor is on. Pitch rises **three octaves** with the
bar's height, exponentially — pitch perception is logarithmic, and a linear map
spends its whole range on the tallest bars. Three rather than two because the
differences worth hearing are small: at two octaves a 3-point change in
prevalence was under a semitone.

The scale is **absolute and shared by both distributions**, so a pitch means
one value in either of them. That is what makes the overlay's two voices an
interval: its size is the difference, and unison means they agree.

Unison is also the case that has to be handled rather than designed around. Two
voices at the same frequency, started together, sum into one louder tone
instead of reading as two — which is what "I only hear one tone" sounds like,
and it happens exactly where the finding is *grounding changed nothing here*.
So the two are separated by everything except pitch:

- **Different instruments**, defaulting to a sustained sine against a
  percussive pluck. Each is selectable; peaks and envelope shoulders were
  measured over an offline render so all six sit within about 1.5x of each
  other in RMS, rather than the decaying ones vanishing under the sustained.
- **Panned apart** whenever two distributions are on screen — A left, B right.
  In the separate layout that doubles as a cue for which chart the cursor is in.
  A lone distribution stays centred.
- **B's onset nudged 28ms late**, under the ~50ms at which two attacks fuse, so
  each keeps its own transient. This is the one that survives mono output,
  where panning does nothing.

**Voices** mutes one side of the overlay. Two tones at once are the point, but
they are also two things to attend to, and picking one distribution apart is
easier with the other silent. It applies to the overlay only — in the separate
layout each chart already sounds nothing but its own distribution, and the
selector says so when it is disabled.

**Picking an instrument, a starting tone or a voice plays a three-note sample
of it**, so you know what to listen for before hunting for it in the data.
Three notes rather than one: a single tone says what the timbre is but not what
a *change* in it sounds like, which is the thing being listened for. These
sound whether or not per-item tones are switched on — that toggle governs
hovering and arrowing, not the controls themselves — and they never leave it
flipped on afterwards.

**Pitch steps** is the melodic control. *Continuous* is the default and the
most precise: every value gets its own frequency. It is also why a swept list
reads as a siren rather than a tune — the pitches *between* the notes are what
make it sound untuned. The other two snap the pitch onto a grid, trading
resolution for music, which works here because the list is already sorted, so
quantised steps down it come out as a melody rather than a random walk.

| Setting | Steps over three octaves | Resolution in prevalence | Character |
|---|---|---|---|
| Continuous | none | exact | precise, atonal |
| Chromatic | 37 | 2.7 points | in tune and fine; leaps can clash |
| Pentatonic | 16 | 6.7 points | coarse, but *any* sequence is consonant |

Major pentatonic is the usual choice in auditory display because it has no
semitone neighbours, so no ordering of the data can sound wrong. Chromatic is
the middle ground when 6.7 points is too blunt. In the overlay, quantising also
turns a small difference between A and B into an unmistakable interval rather
than a wobble.

Two more controls:

- **Starting tone** is the pitch of a zero-height bar, C2 to C5.
- **Pitch is measured against** resolves the remaining ambiguity: *a full bar*
  keeps one tone meaning one prevalence everywhere, while *the tallest bar on
  screen* — computed across both distributions, never one of them — spreads a
  low-coverage distribution over the whole range at the cost of that
  comparability. GATIS needs the second reading; OSM / PWG does not.

**Preview low → high** plays the ramp, and when two distributions are up it
follows with two unisons, since that is the case the instruments have to stay
separable in. The audio graph is created on the first gesture, per browser
autoplay rules.

## Keyboard and assistive technology

Each chart is **one tab stop**. **Enter** steps into it and lands on a mark,
the arrow keys walk the ranking (up/down when horizontal, left/right when
vertical), **Home**/**End**/**PageUp**/**PageDown** jump, **Enter** on a mark
selects it, and **Escape** steps back out to the chart. Same model in the
network, where the arrows walk the concepts in rank order.

There are **no live regions anywhere in the page**. Focus moves to a labelled
`role="option"`, and the option's own accessible name carries its value, its
category and — in the overlay — both values and the change. What changes
without moving focus is described in the `<figcaption>` above the chart, which
is real text in the figure rather than an announcement.

Every chart ships a `<details>` **data table** carrying the same numbers, and
under a categorical colouring every bar prints its category as text beside the
swatch, so identity never rests on hue. Colours are declared once as custom
properties at the top of `styles.css`; the nine categorical slots pass the
lightness, chroma, CVD-separation and normal-vision checks against their own
surface in both light and dark, which are separately chosen steps rather than
an automatic inversion.

Below 900px the three panes become a bottom tab bar — **Controls · Chart ·
Stats** — and picking an item jumps to Stats, since reading it is the point.

## The summary rail

The selected item first, if there is one, then a card per distribution, then
**All runs, grouped** — the same five statistics for the whole corpus and for
every value of every category (use case, model, condition), which is the
default overview.

Coverage and alignment are drawn as box plots, not means. Each repetition is
one generated schema, so a run is a sample of 100 and its coverage has a shape;
two cells with the same mean can be a tight cluster and a bimodal split.

## Rebuilding the data

```sh
python3 metrics_dashboard/build_data.py            # -> data/distributions.json (~200 KB)
python3 metrics_dashboard/build_data.py --include-local
```

It reads from `v3/` and writes nothing there:

| Source | For |
|---|---|
| `v3/data/references/<use case>.csv` | the reference taxonomy, via `schema_grader.hierarchy` |
| `v3/data/matched/<run>.csv` | one row per repetition of the matcher |
| `v3/data/reference_subtopics.json` | accessibility categories, per-rater votes |
| `v3/output/metrics_extra/reference_score_cache_t0.json` | the rubric panel's scores for the reference concepts |
| `v3/output/metrics_extra/operationality_matched.csv` | each run's O over the concepts it reached |
| `v3/output/metrics_extra/operationality_consensus.csv` | each run's O over the concepts it proposed |
| `v3/output/metrics_extra/metric_per_rep.csv` | per-repetition coverage and alignment |

Parsing and exclusion follow the pipeline exactly — `pipeline.parsing` for the
tolerant scan, `pipeline.disposition` for which repetitions count. A repetition
that could not be read at all is excluded rather than scored zero, and the
exclusion count stays on screen. Per-repetition edge hits reproduce
`metric_per_rep.csv` row for row.

## Running and testing

```sh
cd metrics_dashboard && python3 -m http.server 8899
# http://localhost:8899            the dashboard
# http://localhost:8899/selftest.html   assertions, one PASS/FAIL per line
```

`file://` will not work — `fetch` of `data/distributions.json` is blocked by
the origin rules.

`selftest.html` runs the shipped page in an iframe and asserts what a
screenshot cannot: that Enter enters a chart and Escape leaves it, that the
arrow keys follow the orientation, that an invalid pairing is refused with its
reason, that Align actually hands B the coordinates A solved, that sorting by a
rubric dimension is monotone, that a shared row order really does put the same
item in the same row of both charts, and that no `aria-live` region has crept
in. It
also renders the sonifier into an `OfflineAudioContext` and checks that a
unison schedules two voices, that they land on the same frequency, that the two
channels are genuinely different waveforms, and that neither voice is buried —
the balance assertion is what keeps a quiet instrument from silently regressing
into inaudibility.

## Layout of the folder

```
metrics_dashboard/
  index.html          markup
  styles.css          every colour role, light and dark, at the top
  js/data.js          loading, unions, per-item metrics, comparison.tex rules
  js/color.js         which slot an item gets
  js/bars.js          the ranked list and its keyboard model
  js/network.js       the force layout, Align, label placement
  js/stats.js         the summary rail
  js/sonify.js        the tones
  js/app.js           state, controls, URL
  build_data.py       v3 -> data/distributions.json
  data/distributions.json   the only thing the page loads
  selftest.html       assertions over the shipped page
```

The whole state is in the URL hash, so any view is a shareable link:
`#view=compare&mode=edges&a=gatis|gpt|ungrounded&b=gatis|gpt|grounded&sort=O&color=subtopic&order=a`.
