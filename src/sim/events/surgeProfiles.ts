import type { WorldEvent } from './WorldEvents.ts';

/** Compact render data for the same bounded hurricane surface used by WorldEvents. */
export interface SurgeProfile { centerZ: number; amplitude: number }
export const MAX_SURGE_PROFILES = 32;

/** Amplitude is evaluated in weather time; the shader evaluates both spatial falloffs. */
export function surgeProfiles(events: readonly WorldEvent[], time: number): SurgeProfile[] {
  const profiles: SurgeProfile[] = [];
  for (const event of events) {
    if (event.kind !== 'hurricane' || time < event.start || time >= event.start + event.duration) continue;
    profiles.push({ centerZ: event.hurricane.z,
      amplitude: 3 * event.strength * (0.5 - 0.5 * Math.cos(2 * Math.PI * (time - event.start) / event.duration)) });
    if (profiles.length >= MAX_SURGE_PROFILES) break;
  }
  return profiles;
}

/** CPU reference for tests and spatial tools; x and z are final displaced world coordinates. */
export function sampleSurgeProfiles(x: number, z: number, profiles: readonly SurgeProfile[]): number {
  const coast = Math.exp(-Math.abs(x - 2500) / 3000);
  return profiles.reduce((sum, p) => sum + p.amplitude * coast * Math.exp(-Math.abs(z - p.centerZ) / 8000), 0);
}
