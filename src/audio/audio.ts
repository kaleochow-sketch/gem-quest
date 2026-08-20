/**
 * All sound is synthesised at runtime with the Web Audio API. That keeps the
 * game a single self-contained bundle — nothing to download, nothing to
 * licence, and it still works with no connection.
 */

export type SfxName =
  | 'tap'
  | 'swap'
  | 'invalid'
  | 'match'
  | 'special'
  | 'scoot'
  | 'bomb'
  | 'rainbow'
  | 'ingredient'
  | 'crate'
  | 'jelly'
  | 'fuse'
  | 'coin'
  | 'star'
  | 'win'
  | 'lose';

/** Semitone offsets of a major pentatonic, which is hard to make sound wrong. */
const PENTATONIC = [0, 2, 4, 7, 9];
/** Chord roots, as scale degrees, for the backing progression. */
const PROGRESSION = [0, 5, 3, 4];

const BEATS_PER_BAR = 4;
const STEPS_PER_BEAT = 4;

const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private noise: AudioBuffer | null = null;

  private musicTimer = 0;
  private nextStepAt = 0;
  private step = 0;
  private playing = false;

  /** Transposition and tempo, varied per region so areas sound distinct. */
  private root = 57;
  private bpm = 88;

  sfxEnabled = true;
  musicEnabled = true;

  /** The master bus, so output can be monitored or metered. */
  get output(): GainNode | null {
    return this.master;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * Browsers only allow audio to start inside a user gesture, so this is
   * called from the first tap and is safe to call repeatedly.
   */
  unlock(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.musicEnabled && !this.playing) this.startMusic();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // A short synthetic room, which stops the blips sounding bone dry.
    this.reverb = ctx.createConvolver();
    // Mono and short: convolution cost scales with length and channels, and
    // this is a decorative tail, not a concert hall.
    const seconds = 0.7;
    const len = Math.floor(ctx.sampleRate * seconds);
    const impulse = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = impulse.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    this.reverb.connect(wet);
    wet.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.85;
    this.sfxBus.connect(this.master);
    this.sfxBus.connect(this.reverb);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.0;
    this.musicBus.connect(this.master);
    this.musicBus.connect(this.reverb);

    // One noise buffer, reused for every percussive sound.
    const nLen = Math.floor(ctx.sampleRate * 1.2);
    this.noise = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;
  }

  /* ---------------------------------------------------------------- *
   * Primitives
   * ---------------------------------------------------------------- */

  private tone(
    freq: number,
    when: number,
    dur: number,
    opts: { type?: OscillatorType; gain?: number; to?: number; bus?: GainNode | null } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, when);
    if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), when + dur);

    const peak = opts.gain ?? 0.2;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + Math.min(0.02, dur * 0.2));
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    osc.connect(env);
    env.connect(opts.bus ?? this.sfxBus!);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  private hiss(
    when: number,
    dur: number,
    opts: { freq?: number; q?: number; gain?: number; type?: BiquadFilterType; sweepTo?: number } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'bandpass';
    filter.frequency.setValueAtTime(opts.freq ?? 1200, when);
    if (opts.sweepTo) filter.frequency.exponentialRampToValueAtTime(opts.sweepTo, when + dur);
    filter.Q.value = opts.q ?? 1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(opts.gain ?? 0.15, when + 0.01);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.sfxBus!);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  /* ---------------------------------------------------------------- *
   * Effects
   * ---------------------------------------------------------------- */

  /** @param level cascade depth, which lifts the pitch of a match. */
  sfx(name: SfxName, level = 1): void {
    if (!this.sfxEnabled || !this.ctx) return;
    const t = this.ctx.currentTime + 0.001;
    const scale = (n: number) => midiToFreq(this.root + 12 + PENTATONIC[n % 5] + 12 * Math.floor(n / 5));

    switch (name) {
      case 'tap':
        this.tone(660, t, 0.07, { type: 'triangle', gain: 0.12 });
        break;
      case 'swap':
        this.tone(430, t, 0.1, { type: 'triangle', gain: 0.13, to: 560 });
        break;
      case 'invalid':
        this.tone(190, t, 0.14, { type: 'sawtooth', gain: 0.1, to: 130 });
        break;
      case 'match': {
        // Each cascade climbs the scale, which is the reward for a chain.
        const step = Math.min(11, level - 1);
        this.tone(scale(step), t, 0.22, { type: 'triangle', gain: 0.2 });
        this.tone(scale(step + 2), t + 0.045, 0.2, { type: 'sine', gain: 0.13 });
        this.hiss(t, 0.09, { freq: 2600, gain: 0.05 });
        break;
      }
      case 'special':
        this.tone(scale(4), t, 0.18, { type: 'square', gain: 0.09 });
        this.tone(scale(7), t + 0.06, 0.24, { type: 'triangle', gain: 0.14 });
        break;
      case 'scoot':
        // A short scrape: he is dragging, after all.
        this.hiss(t, 0.18, { freq: 950, sweepTo: 240, q: 1.4, gain: 0.2 });
        this.tone(150, t, 0.15, { type: 'sawtooth', gain: 0.08, to: 90 });
        break;
      case 'bomb':
        this.hiss(t, 0.5, { freq: 1400, sweepTo: 90, q: 0.8, gain: 0.28, type: 'lowpass' });
        this.tone(120, t, 0.45, { type: 'sine', gain: 0.3, to: 40 });
        break;
      case 'rainbow':
        for (let i = 0; i < 6; i++) {
          this.tone(scale(i + 2), t + i * 0.05, 0.5, { type: 'triangle', gain: 0.11 });
        }
        break;
      case 'ingredient':
        this.tone(scale(2), t, 0.16, { type: 'sine', gain: 0.18 });
        this.tone(scale(5), t + 0.08, 0.2, { type: 'sine', gain: 0.18 });
        this.tone(scale(9), t + 0.16, 0.34, { type: 'sine', gain: 0.2 });
        break;
      case 'crate':
        this.hiss(t, 0.22, { freq: 700, sweepTo: 200, q: 0.9, gain: 0.2, type: 'lowpass' });
        this.tone(210, t, 0.12, { type: 'square', gain: 0.07, to: 120 });
        break;
      case 'jelly':
        this.tone(880, t, 0.1, { type: 'sine', gain: 0.1, to: 1500 });
        break;
      case 'fuse':
        this.tone(1400, t, 0.05, { type: 'square', gain: 0.07 });
        break;
      case 'coin':
        this.tone(1180, t, 0.07, { type: 'square', gain: 0.09 });
        this.tone(1560, t + 0.05, 0.12, { type: 'square', gain: 0.08 });
        break;
      case 'star':
        this.tone(scale(level + 3), t, 0.3, { type: 'triangle', gain: 0.2 });
        this.tone(scale(level + 5), t + 0.06, 0.34, { type: 'sine', gain: 0.14 });
        break;
      case 'win':
        [0, 2, 4, 7].forEach((n, i) => {
          this.tone(scale(n), t + i * 0.11, 0.7, { type: 'triangle', gain: 0.18 });
        });
        break;
      case 'lose':
        [7, 4, 2, 0].forEach((n, i) => {
          this.tone(scale(n) / 2, t + i * 0.13, 0.5, { type: 'sine', gain: 0.16 });
        });
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Music
   * ---------------------------------------------------------------- */

  /** Each region gets its own key and tempo. */
  setRegion(index: number): void {
    const roots = [57, 55, 60, 53, 58, 50, 56, 61, 59, 52];
    this.root = roots[index % roots.length];
    this.bpm = 80 + ((index * 3) % 16);
  }

  startMusic(): void {
    if (!this.ctx || !this.musicBus || this.playing || !this.musicEnabled) return;
    this.playing = true;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, this.ctx.currentTime);
    this.musicBus.gain.linearRampToValueAtTime(0.3, this.ctx.currentTime + 1.5);
    this.nextStepAt = this.ctx.currentTime + 0.1;
    this.musicTimer = window.setInterval(() => this.schedule(), 25);
  }

  stopMusic(): void {
    if (!this.ctx || !this.musicBus) return;
    this.playing = false;
    window.clearInterval(this.musicTimer);
    this.musicTimer = 0;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setValueAtTime(this.musicBus.gain.value, this.ctx.currentTime);
    this.musicBus.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.6);
  }

  /** Schedules a little ahead of the clock, which keeps timing steady. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const stepDur = 60 / this.bpm / STEPS_PER_BEAT;
    while (this.nextStepAt < ctx.currentTime + 0.2) {
      this.emitStep(this.step, this.nextStepAt, stepDur);
      this.step++;
      this.nextStepAt += stepDur;
    }
  }

  private emitStep(step: number, when: number, stepDur: number): void {
    const stepsPerBar = BEATS_PER_BAR * STEPS_PER_BEAT;
    const bar = Math.floor(step / stepsPerBar);
    const inBar = step % stepsPerBar;
    const degree = PROGRESSION[bar % PROGRESSION.length];
    const chordRoot = this.root + PENTATONIC[degree % 5] + 12 * Math.floor(degree / 5);

    // Pad on the downbeat, held across the bar.
    if (inBar === 0) {
      for (const offset of [0, 7, 12]) {
        this.pad(midiToFreq(chordRoot + offset), when, stepDur * stepsPerBar * 0.98);
      }
    }
    // Bass on beats one and three.
    if (inBar === 0 || inBar === 8) {
      this.tone(midiToFreq(chordRoot - 12), when, 0.5, {
        type: 'sine',
        gain: 0.16,
        bus: this.musicBus,
      });
    }
    // Arpeggio on the offbeat eighths.
    if (inBar % 2 === 0) {
      const idx = (inBar / 2) % 4;
      const note = chordRoot + 12 + PENTATONIC[(idx * 2) % 5];
      this.tone(midiToFreq(note), when, 0.26, {
        type: 'triangle',
        gain: idx === 0 ? 0.075 : 0.05,
        bus: this.musicBus,
      });
    }
  }

  private pad(freq: number, when: number, dur: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 8;
    filter.type = 'lowpass';
    filter.frequency.value = 1600;

    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(0.045, when + dur * 0.35);
    env.gain.linearRampToValueAtTime(0.0001, when + dur);

    osc.connect(filter);
    filter.connect(env);
    env.connect(this.musicBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  setSfx(on: boolean): void {
    this.sfxEnabled = on;
  }

  setMusic(on: boolean): void {
    this.musicEnabled = on;
    if (on) this.startMusic();
    else this.stopMusic();
  }
}

export const audio = new AudioEngine();
