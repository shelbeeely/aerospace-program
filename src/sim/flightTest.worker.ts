/// <reference lib="webworker" />
/**
 * Runs automated flight tests off the main thread: ~150 simulated seconds of Rapier physics per
 * test would otherwise compete with rendering while the Studio designs craft.
 */
import type { CraftDef } from '../craft/types.ts';
import type { WeatherSettings } from './atmosphere.ts';
import { flightTest } from './flightTest.ts';
import { initPhysics } from './Simulation.ts';

interface Request {
  id: number;
  craft: CraftDef;
  /** Weather for this flight (default calm); the client sends the gusty flight as its own request. */
  weather?: WeatherSettings;
}

const ready = initPhysics();

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, craft, weather } = e.data;
  try {
    await ready;
    const report = await flightTest(craft, { weather });
    self.postMessage({ id, report });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
