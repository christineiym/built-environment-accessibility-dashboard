/* Tones for bar heights.
 *
 * One short note per item, pitched by the bar's height. The scale is
 * **absolute and shared**: a pitch means one value, in either distribution, so
 * the overlay's two voices form an interval whose size *is* the difference
 * between them, and unison means they agree.
 *
 * The mapping is exponential in frequency, because pitch perception is
 * logarithmic: a linear map spends most of its range on the tallest bars and
 * squashes the tail into a few hertz.
 *
 * Keeping the scale shared has one consequence that has to be handled rather
 * than designed around: when A and B carry the same value their voices land on
 * the *same frequency*, and two same-pitch tones started together sum into one
 * louder tone rather than reading as two. Unison is exactly the case the
 * comparison most needs to be legible — it means "grounding changed nothing
 * here" — so the two voices are separated by everything except pitch:
 *
 *   - each series has its own instrument, so their timbres differ;
 *   - each is panned to its own side, so they arrive as two sources;
 *   - B's onset is nudged a few tens of milliseconds late, well under the
 *     ~50ms at which two attacks fuse into one event, which keeps them
 *     simultaneous to the ear while still giving each its own transient. That
 *     one survives mono output, where panning does nothing.
 */

const NOTE_MS = 260;

/** Octaves spanned from an empty bar to a full one. */
const OCTAVES = 3;

/** How far apart the two series sit in the stereo field. */
const PAN = 0.62;

/** How late B's attack is, in seconds. Below the ~50ms fusion threshold. */
const STAGGER = 0.028;

/**
 * Pitch grids.
 *
 * A continuous mapping gives every value its own frequency, which is precise
 * and sounds like a theremin — the pitches between the notes are what make a
 * swept list read as a siren rather than a tune. Snapping to a scale trades
 * resolution for that: the ranking is already sorted, so quantised steps down
 * it come out as an actual melody.
 *
 * Major pentatonic is the usual choice in auditory display because it has no
 * semitone neighbours — *any* sequence of its degrees is consonant, so no
 * ordering of the data can sound wrong. It costs the most resolution, at 5
 * steps per octave. Chromatic keeps twelve, which is still in tune and much
 * finer, at the price of leaps that can clash.
 */
export const SCALES = [
  { id: 'continuous', label: 'Continuous (most precise)', steps: null },
  { id: 'chromatic', label: 'Chromatic — 37 steps', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'pentatonic', label: 'Pentatonic — 16 steps, melodic', steps: [0, 2, 4, 7, 9] },
];

/** Snap a position in semitones onto a scale, or leave it alone. */
function snap(semitones, scale) {
  const grid = (SCALES.find((entry) => entry.id === scale) || SCALES[0]).steps;
  if (!grid) return semitones;
  const octave = Math.floor(semitones / 12);
  let best = semitones;
  let closest = Infinity;
  for (const oct of [octave - 1, octave, octave + 1]) {
    for (const degree of grid) {
      const candidate = oct * 12 + degree;
      const distance = Math.abs(candidate - semitones);
      if (distance < closest) { closest = distance; best = candidate; }
    }
  }
  return Math.min(OCTAVES * 12, Math.max(0, best));
}

/** Instruments, in menu order. */
export const INSTRUMENTS = [
  { id: 'sine', label: 'Sine (pure)' },
  { id: 'triangle', label: 'Triangle (flute-like)' },
  { id: 'sawtooth', label: 'Sawtooth (reedy)' },
  { id: 'square', label: 'Square (clarinet-like)' },
  { id: 'bell', label: 'Bell (FM)' },
  { id: 'pluck', label: 'Pluck (marimba-like)' },
];

/** Starting tones — the pitch a zero-height bar sounds at. */
export const BASE_TONES = [
  { id: 'C2', label: 'C2 — very low', hz: 65.41 },
  { id: 'G2', label: 'G2 — low', hz: 98.0 },
  { id: 'C3', label: 'C3 — low-mid', hz: 130.81 },
  { id: 'G3', label: 'G3 — mid', hz: 196.0 },
  { id: 'C4', label: 'C4 — middle C', hz: 261.63 },
  { id: 'E4', label: 'E4 — upper-mid', hz: 329.63 },
  { id: 'C5', label: 'C5 — high', hz: 523.25 },
];

/**
 * Per-instrument peak, chosen so the six land within about 1.5x of each other
 * in RMS over one note — measured, not guessed. Peak alone does not predict
 * loudness here: the two decaying instruments spend most of a note near
 * silence, so they need a higher peak and a shoulder in their envelope to sit
 * beside a sustained sine rather than under it. The harsh waveforms stay a
 * little under, since their harmonics make them read louder than they measure.
 */
const GAIN = { sine: 0.22, triangle: 0.25, sawtooth: 0.18, square: 0.15, bell: 0.42, pluck: 0.46 };

/** Where each decaying instrument's envelope pauses, as a share of its peak. */
const SHOULDER = { bell: 0.46, pluck: 0.52 };

export class Sonifier {
  constructor() {
    this.enabled = false;
    this.baseHz = 196.0;
    // Defaults chosen to be separable at unison: a steady tone against a
    // percussive one, so the pair reads as two even when the pitches match.
    this.instruments = { a: 'sine', b: 'pluck' };
    /** True while two distributions are being sounded together. */
    this.stereo = false;
    /** Which of a pair to sound: `'both'`, `'a'` or `'b'`. */
    this.voices = 'both';
    /** Pitch grid; see {@link SCALES}. */
    this.scale = 'continuous';
    this.context = null;
    this.master = null;
    this.buses = new Map();
  }

  /** Create the audio graph. Must be reached from a user gesture. */
  ensure() {
    if (!this.context) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume();
    return this.context;
  }

  /**
   * Return the output node for one series.
   *
   * Panned only while a pair is sounding: a single distribution belongs in the
   * middle, and hearing one lone voice off to the left reads as a fault.
   *
   * @param {string} series `'a'` or `'b'`.
   * @param {boolean} spread Whether to pan this series to its own side.
   */
  bus(series, spread) {
    const key = `${series}:${spread ? 1 : 0}`;
    if (!this.buses.has(key)) {
      const gain = this.context.createGain();
      if (spread && this.context.createStereoPanner) {
        const panner = this.context.createStereoPanner();
        panner.pan.value = series === 'b' ? PAN : -PAN;
        gain.connect(panner).connect(this.master);
      } else {
        // No StereoPanner (older Safari): the stagger and the timbres still
        // separate the two voices, so this degrades rather than breaks.
        gain.connect(this.master);
      }
      this.buses.set(key, gain);
    }
    return this.buses.get(key);
  }

  /** Frequency for a height in [0, 1], on the current pitch grid. */
  frequency(fraction) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    return this.baseHz * Math.pow(2, snap(OCTAVES * 12 * clamped, this.scale) / 12);
  }

  /**
   * Sound one item.
   *
   * @param {number} fraction Bar height on the shared absolute scale, in [0, 1].
   * @param {string} series `'a'` or `'b'`; picks the instrument and the side.
   * @param {object} [options]
   * @param {number|null} [options.at] Context time to start at; both voices of
   *   a pair share one, so they are sample-aligned rather than a callback apart.
   * @param {boolean} [options.force] Sound even while per-item tones are off.
   *   Demos and the preview use it: those are the user asking to hear a
   *   setting, which the per-item toggle does not govern. It is a parameter
   *   rather than a temporary flip of `enabled`, so two demos in quick
   *   succession cannot leave the toggle stuck on.
   * @returns {object|null} What was scheduled, or null when nothing was.
   */
  play(fraction, series = 'a', { at = null, force = false } = {}) {
    if (!this.enabled && !force) return null;
    const context = this.ensure();
    if (!context) return null;

    const instrument = this.instruments[series] || 'sine';
    const hz = this.frequency(fraction);
    const peak = GAIN[instrument] ?? 0.2;
    const now = (at ?? context.currentTime) + (series === 'b' ? STAGGER : 0);
    const stop = now + NOTE_MS / 1000;

    const envelope = context.createGain();
    envelope.connect(this.bus(series, this.stereo));
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(peak, now + 0.012);

    const voices = [];
    if (instrument === 'bell') {
      const carrier = context.createOscillator();
      const modulator = context.createOscillator();
      const depth = context.createGain();
      carrier.type = 'sine';
      modulator.type = 'sine';
      carrier.frequency.value = hz;
      // A harmonic ratio and a modest index: the point is a bell-like attack
      // with a pitch you can still name, not an inharmonic clang.
      modulator.frequency.value = hz * 2;
      depth.gain.setValueAtTime(hz * 1.4, now);
      depth.gain.exponentialRampToValueAtTime(hz * 0.05, stop);
      modulator.connect(depth).connect(carrier.frequency);
      carrier.connect(envelope);
      envelope.gain.exponentialRampToValueAtTime(peak * SHOULDER.bell, now + 0.09);
      envelope.gain.exponentialRampToValueAtTime(0.0001, stop);
      voices.push(carrier, modulator);
    } else if (instrument === 'pluck') {
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      oscillator.type = 'triangle';
      oscillator.frequency.value = hz;
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(hz * 8, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(200, hz * 1.5), stop);
      oscillator.connect(filter).connect(envelope);
      envelope.gain.exponentialRampToValueAtTime(peak * SHOULDER.pluck, now + 0.07);
      envelope.gain.exponentialRampToValueAtTime(0.0001, stop);
      voices.push(oscillator);
    } else {
      const oscillator = context.createOscillator();
      oscillator.type = instrument;
      oscillator.frequency.value = hz;
      oscillator.connect(envelope);
      envelope.gain.setValueAtTime(peak, stop - 0.06);
      envelope.gain.exponentialRampToValueAtTime(0.0001, stop);
      voices.push(oscillator);
    }

    for (const voice of voices) {
      voice.start(now);
      voice.stop(stop + 0.02);
    }
    return { series, instrument, hz, start: now, panned: this.stereo };
  }

  /**
   * Sound both series as one event.
   *
   * @param {number} fractionA A's height on the shared scale.
   * @param {number|null} fractionB B's height, or null when B never reached
   *   this item — in which case A sounds alone, and the silence on B's side is
   *   the finding.
   * @returns {Array<object>} What was scheduled, one entry per voice.
   *
   * Honours {@link Sonifier#voices}: two tones at once are the point, but they
   * are also two things to attend to, and picking one distribution apart is
   * easier with the other muted than with both playing.
   */
  playPair(fractionA, fractionB) {
    const context = this.ensure();
    if (!context) return [];
    const at = context.currentTime;
    const wantA = this.voices !== 'b';
    const wantB = this.voices !== 'a' && fractionB != null;
    return [
      wantA ? this.play(fractionA, 'a', { at }) : null,
      wantB ? this.play(fractionB, 'b', { at }) : null,
    ].filter(Boolean);
  }

  /**
   * Play a short figure in one series' voice, so a pick can be judged.
   *
   * Three rising notes rather than one: a single tone says what the timbre is,
   * but not what a *change* in it sounds like, which is the thing being
   * listened for.
   *
   * @param {string} series `'a'` or `'b'`.
   * @returns {Array<object>} What was scheduled.
   */
  demo(series = 'a') {
    const context = this.ensure();
    if (!context) return [];
    const at = context.currentTime;
    return [0.3, 0.55, 0.8]
      .map((fraction, i) => this.play(fraction, series, { at: at + i * 0.19, force: true }))
      .filter(Boolean);
  }

  /**
   * Run a short scale, so a setting can be judged before it is used.
   *
   * Ends on two unisons when a pair is being sounded, since that is the case
   * the instruments have to stay separable in.
   */
  preview() {
    const context = this.ensure();
    if (!context) return;
    const steps = [0, 0.25, 0.5, 0.75, 1];
    const lead = this.voices === 'b' ? 'b' : 'a';
    steps.forEach((fraction, i) => {
      window.setTimeout(() => this.play(fraction, lead, { force: true }), i * 260);
    });
    if (this.stereo && this.voices === 'both') {
      [0.45, 0.8].forEach((fraction, i) => {
        window.setTimeout(() => {
          const at = this.context.currentTime;
          this.play(fraction, 'a', { at, force: true });
          this.play(fraction, 'b', { at, force: true });
        }, (steps.length + i) * 260 + 160);
      });
    }
  }
}
