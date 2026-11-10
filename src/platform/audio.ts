import { airDensity } from '../sim/atmosphere.ts';
import { thunderDelay } from '../sim/lightning.ts';
import type { LightningStrike } from '../sim/lightning.ts';
import type { Craft } from '../craft/Craft.ts';
import type { Telemetry } from '../sim/telemetry.ts';

/**
 * Procedural flight audio (Web Audio API). No sound files: everything is synthesised from the
 * simulation state each frame.
 * - Propellers: blade-pass buzz (sawtooth + harmonic through a lowpass) pitched by RPM.
 * - Rotors: blade slap (noise amplitude-modulated at the blade-pass frequency).
 * - Jets: filtered noise whoosh.
 * - Wind: noise rising with airspeed²; stall horn; touchdown thumps; crash/breakage crunch.
 * The AudioContext starts on the first user gesture (browser autoplay rules).
 */
export class FlightAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engine: { osc1: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private rotor: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode; lfoGain: GainNode } | null = null;
  private jet: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private horn: { osc: OscillatorNode; gain: GainNode } | null = null;
  private wasGrounded = true;
  private wasHit = false;
  private lastFailures = 0;
  private hornPhase = 0;
  private lastThunderStrike = 0;
  private readonly thunderQueue: Array<{ due: number; distance: number }> = [];
  volume = 0.7;
  muted = false;
  /** Theme music level (under the master volume and mute). */
  musicVolume = 0.45;
  private music: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private musicGain: GainNode | null = null;
  /** The theme to play once audio can start (browsers wait for a user gesture). */
  private pendingTheme: string | null = null;
  private themeUrl: string | null = null;
  private themeToken = 0;

  constructor() {
    const start = () => {
      this.ensure();
      void this.ctx?.resume();
      if (this.pendingTheme) {
        const url = this.pendingTheme;
        this.pendingTheme = null;
        void this.playTheme(url);
      }
    };
    for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, start, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  get available(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  private ensure(): void {
    if (this.ctx || !this.available) return;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    // Gentle compressor so crashes don't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    this.master.connect(comp).connect(ctx.destination);
    // 2 s of white noise, looped by every noise voice.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Prop engine voice
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.5;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    osc1.connect(filter);
    osc2.connect(g2).connect(filter);
    filter.connect(gain).connect(this.master);
    osc1.start();
    osc2.start();
    this.engine = { osc1, osc2, filter, gain };

    // Rotor voice: band-passed noise, amplitude-modulated by an LFO at blade-pass frequency.
    {
      const src = this.loopNoise();
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 180;
      f.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0;
      lfo.connect(lfoGain).connect(g.gain);
      src.connect(f).connect(g).connect(this.master);
      lfo.start();
      this.rotor = { src, filter: f, gain: g, lfo, lfoGain };
    }
    // Jet and wind voices
    this.jet = this.noiseVoice('bandpass', 900, 0.7);
    this.wind = this.noiseVoice('bandpass', 400, 0.5);
    // Stall horn
    const hornOsc = ctx.createOscillator();
    hornOsc.type = 'square';
    hornOsc.frequency.value = 520;
    const hornGain = ctx.createGain();
    hornGain.gain.value = 0;
    hornOsc.connect(hornGain).connect(this.master);
    hornOsc.start();
    this.horn = { osc: hornOsc, gain: hornGain };
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  private noiseVoice(type: BiquadFilterType, freq: number, q: number) {
    const ctx = this.ctx!;
    const src = this.loopNoise();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    return { src, filter, gain };
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.setVolume(this.volume);
    return this.muted;
  }

  /** One-shot noise burst (crash, breakage) or low thump (touchdown). */
  private burst(kind: 'crash' | 'thump', strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(this.master);
    if (kind === 'thump') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
      g.gain.setValueAtTime(0.6 * strength, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.35);
    } else {
      const src = this.loopNoise();
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(3000, t);
      f.frequency.exponentialRampToValueAtTime(200, t + 0.8);
      g.gain.setValueAtTime(0.9 * strength, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      src.connect(f).connect(g);
      src.stop(t + 1.1);
    }
  }

  /** A craft explosion `distance` m from the listener: a sharp crack, then a long low roll. */
  explosion(distance: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + distance / 343;
    const level = 1 / (1 + distance / 150);
    const src = this.loopNoise();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(5000, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 2.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.setValueAtTime(1.2 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3);
    src.connect(f).connect(g).connect(this.master);
    src.stop(t + 3.1);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(22, t + 1.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, ctx.currentTime);
    og.gain.setValueAtTime(0.9 * level, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 1.9);
  }

  /** Call every frame. */
  update(t: Telemetry, craft: Craft, failures: number, airframeHit: boolean, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const smooth = (p: AudioParam, v: number, tau = 0.08) => p.setTargetAtTime(v, now, tau);

    // Propeller / jet engines
    const props = craft.engines.filter((e) => e.isProp);
    const jets = craft.engines.filter((e) => !e.isProp);
    if (this.engine) {
      const spool = props.length ? props.reduce((s, e) => s + e.spool, 0) / props.length : 0;
      // Blade-pass frequency: 2 blades at ~600-2700 rpm.
      const f = 18 + spool * 72;
      smooth(this.engine.osc1.frequency, f);
      smooth(this.engine.osc2.frequency, f * 2.01);
      smooth(this.engine.filter.frequency, 300 + spool * 2200);
      smooth(this.engine.gain.gain, props.length ? 0.04 + spool * 0.22 : 0);
    }
    if (this.jet) {
      const spool = jets.length ? jets.reduce((s, e) => s + e.spool, 0) / jets.length : 0;
      // Rockets: a lower roar, and silence in thin air (no air to carry the sound).
      const rocket = jets.length > 0 && jets.every((e) => e.isRocket);
      const air = rocket ? Math.min(1, Math.sqrt(airDensity(t.position[1]) / 1.225)) : 1;
      smooth(this.jet.filter.frequency, rocket ? 250 + spool * 1200 : 600 + spool * 2400);
      smooth(this.jet.gain.gain, jets.length ? (0.05 + spool * 0.35) * air : 0);
    }
    // Rotors: loudest rotor sets the slap rate.
    if (this.rotor) {
      const rotors = craft.rotors;
      let bpf = 0;
      let level = 0;
      for (const r of rotors) {
        const frac = r.omega / Math.max(1, r.maxOmega);
        level = Math.max(level, frac);
        bpf = Math.max(bpf, (r.omega / (Math.PI * 2)) * r.def.blades);
      }
      const big = rotors.some((r) => r.def.radius > 1.5);
      smooth(this.rotor.lfo.frequency, Math.min(bpf, 400));
      smooth(this.rotor.filter.frequency, big ? 140 + level * 120 : 300 + level * 900);
      const base = rotors.length ? level * (big ? 0.35 : 0.18) : 0;
      smooth(this.rotor.gain.gain, base * 0.5);
      smooth(this.rotor.lfoGain.gain, base * (big ? 0.5 : 0.25));
    }
    // Wind
    if (this.wind) {
      const v = t.airspeed;
      smooth(this.wind.filter.frequency, 250 + v * 18, 0.2);
      smooth(this.wind.gain.gain, Math.min(0.5, (v * v) / 9000), 0.2);
    }
    // Stall horn: pulses while stalling in the air.
    if (this.horn) {
      const stalling = t.stall > 0.35 && !t.onGround && t.airspeed > 5;
      this.hornPhase = (this.hornPhase + dt * 4) % 1;
      smooth(this.horn.gain.gain, stalling && this.hornPhase < 0.6 ? 0.06 : 0, 0.01);
    }
    // Events
    if (t.onGround && !this.wasGrounded && t.verticalSpeed < -0.5) this.burst('thump', Math.min(1, -t.verticalSpeed / 4));
    this.wasGrounded = t.onGround;
    const hit = airframeHit && t.airspeed > 8;
    if (failures > this.lastFailures || (hit && !this.wasHit)) this.burst('crash', 1);
    this.wasHit = hit;
    this.lastFailures = failures;
  }

  /** Thunder follows light by distance / speed of sound in simulation seconds, never wall
   * time: pausing flight also pauses the delay. Only synthesize after an audio gesture. */
  updateThunder(strikes: readonly LightningStrike[], time: number, listener: { x: number; y: number; z: number }): void {
    for (const strike of strikes) {
      if (strike.id <= this.lastThunderStrike) continue;
      this.lastThunderStrike = strike.id;
      const p = strike.target.position;
      const distance = Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z);
      this.thunderQueue.push({ due: strike.time + thunderDelay(distance), distance });
    }
    for (let i = this.thunderQueue.length - 1; i >= 0; i--) {
      const event = this.thunderQueue[i];
      if (time < event.due) continue;
      this.thunderQueue.splice(i, 1);
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') continue;
      const source = ctx.createBufferSource(); source.buffer = this.noise;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 180;
      const gain = ctx.createGain();
      const peak = 0.5 / (1 + event.distance / 600);
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);
      source.connect(filter).connect(gain).connect(this.master);
      source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
      source.start(); source.stop(ctx.currentTime + 1.9);
    }
  }

  /**
   * The vehicle's theme: a generated track looped through the game's own mix (so the volume and
   * M mute apply), faded in; null fades it out. Waits for the first click if audio isn't running.
   */
  async playTheme(url: string | null): Promise<void> {
    if (url === this.themeUrl && (this.music || this.pendingTheme === url)) return;
    this.themeUrl = url;
    const token = ++this.themeToken;
    const ctx = this.ctx;
    // Fade out whatever is playing.
    if (this.music && ctx) {
      const old = this.music;
      this.music = null;
      old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.4);
      old.src.stop(ctx.currentTime + 2.5);
      old.src.onended = () => { old.src.disconnect(); old.gain.disconnect(); };
    }
    if (!url) { this.pendingTheme = null; return; }
    if (!ctx || ctx.state !== 'running') { this.pendingTheme = url; return; }
    let buffer: AudioBuffer;
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      buffer = await ctx.decodeAudioData(bytes);
    } catch {
      return; // undecodable: stay silent rather than break the game's audio
    }
    if (token !== this.themeToken) return; // another theme was asked for meanwhile
    if (!this.musicGain) {
      this.musicGain = ctx.createGain();
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(1, ctx.currentTime, 0.8);
    src.connect(gain).connect(this.musicGain);
    src.start();
    this.music = { src, gain };
  }

  /** Is a theme playing (or waiting for the first click)? */
  get themePlaying(): boolean {
    return !!this.music || !!this.pendingTheme;
  }

  setMusicVolume(v: number): void {
    this.musicVolume = v;
    if (this.ctx && this.musicGain) this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  /** Fade every continuous voice to silence (e.g. in the hangar, where nothing is running). */
  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const g of [this.engine?.gain, this.rotor?.gain, this.rotor?.lfoGain, this.jet?.gain, this.wind?.gain, this.horn?.gain]) {
      g?.gain.cancelScheduledValues(now);
      g?.gain.setTargetAtTime(0, now, 0.05);
    }
  }

  reset(): void {
    this.lastFailures = 0;
    this.thunderQueue.length = 0;
    this.wasGrounded = true;
  }
}
