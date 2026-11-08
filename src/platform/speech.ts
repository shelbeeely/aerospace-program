import type { Telemetry } from '../sim/telemetry.ts';

/**
 * Spoken callouts (Web Speech API: speechSynthesis). Rate-limited, never stacked, and only
 * for things that matter: stall, terrain, structure, fuel, landing altitude calls.
 */
export class Callouts {
  enabled = true;
  private last = new Map<string, number>();
  private wasStalling = false;
  private failuresSeen = 0;
  private fuelWarned = false;
  private altCalls = new Set<number>();
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (!this.available) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => /en-(US|GB)/i.test(v.lang) && /female|samantha|google/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  get available(): boolean {
    return typeof speechSynthesis !== 'undefined';
  }

  say(text: string, key = text, cooldownMs = 4000, urgent = false): void {
    if (!this.enabled || !this.available) return;
    const now = performance.now();
    if ((this.last.get(key) ?? -Infinity) > now - cooldownMs) return;
    this.last.set(key, now);
    if (urgent) speechSynthesis.cancel();
    else if (speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    u.pitch = 0.95;
    if (this.voice) u.voice = this.voice;
    speechSynthesis.speak(u);
  }

  reset(): void {
    this.wasStalling = false;
    this.failuresSeen = 0;
    this.fuelWarned = false;
    this.altCalls.clear();
  }

  update(t: Telemetry, failures: Array<{ partId: string }>): void {
    if (!this.enabled) return;
    const stalling = t.stall > 0.35 && !t.onGround && t.airspeed > 5;
    if (stalling && !this.wasStalling) this.say('Stall. Stall.', 'stall', 3000, true);
    this.wasStalling = stalling;

    if (!t.onGround && t.altitude < 60 && t.verticalSpeed < -9) this.say('Pull up!', 'pullup', 2500, true);

    for (const f of failures.slice(this.failuresSeen)) this.say(`Structural failure. ${f.partId.replace(/[._]/g, ' ')}.`, `fail:${f.partId}`, 0, true);
    this.failuresSeen = failures.length;

    if (t.fuel !== null && t.fuel < 0.1 && t.fuel > 0 && !this.fuelWarned) {
      this.fuelWarned = true;
      this.say('Low fuel.', 'fuel');
    }
    if (t.fuel === 0) this.say('Fuel exhausted.', 'fuel0', 60000);

    // Landing calls on descent below 50 m (re-armed when climbing back above 70 m).
    if (t.altitude > 70) this.altCalls.clear();
    if (!t.onGround && t.verticalSpeed < -0.5) {
      for (const h of [50, 30, 10]) {
        if (t.altitude < h && t.altitude > h - 6 && !this.altCalls.has(h)) {
          this.altCalls.add(h);
          this.say(String(h), `alt${h}`, 1000);
        }
      }
    }
  }
}
