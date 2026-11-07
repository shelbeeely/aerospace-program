import type { Telemetry } from './telemetry.ts';

/**
 * Summarises the player's current flight so it can be handed to a designer model as feedback
 * ("I stalled twice and it rolled left on takeoff..."). Reset when the craft is reset.
 */
export class FlightLog {
  maxSpeed = 0;
  maxAltitude = 0;
  maxG = 1;
  minG = 1;
  stalls = 0;
  crashes = 0;
  airborneTime = 0;
  liftoffSpeed: number | null = null;
  private wasStalled = false;
  private wasAirborne = false;
  private crashedLatched = false;

  reset(): void {
    Object.assign(this, new FlightLog());
  }

  update(t: Telemetry, dt: number, airframeOnGround: boolean): void {
    this.maxSpeed = Math.max(this.maxSpeed, t.airspeed);
    this.maxAltitude = Math.max(this.maxAltitude, t.altitude);
    if (!t.onGround) {
      this.maxG = Math.max(this.maxG, t.gForce);
      this.minG = Math.min(this.minG, t.gForce);
    }
    const airborne = !t.onGround && t.altitude > 1.5;
    if (airborne) {
      this.airborneTime += dt;
      if (!this.wasAirborne && this.liftoffSpeed === null) this.liftoffSpeed = t.airspeed;
    }
    this.wasAirborne = airborne;
    const stalled = t.stall > 0.35 && !t.onGround && t.airspeed > 5;
    if (stalled && !this.wasStalled) this.stalls++;
    this.wasStalled = stalled;
    const crash = airframeOnGround && t.airspeed > 8;
    if (crash && !this.crashedLatched) this.crashes++;
    this.crashedLatched = airframeOnGround;
  }

  summary(): string {
    const kt = (ms: number) => Math.round(ms * 1.944);
    if (this.maxSpeed < 2) return 'The player has not flown this craft yet.';
    return [
      `Player test flight: top speed ${kt(this.maxSpeed)} kt, max altitude ${Math.round(this.maxAltitude)} m,`,
      this.liftoffSpeed !== null ? `lift-off at ${kt(this.liftoffSpeed)} kt,` : 'never got airborne,',
      `${Math.round(this.airborneTime)} s airborne, g range ${this.minG.toFixed(1)} to ${this.maxG.toFixed(1)},`,
      `${this.stalls} stall(s), ${this.crashes} crash(es).`,
    ].join(' ');
  }
}
